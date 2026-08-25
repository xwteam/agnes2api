import { describe, it, expect } from "vitest";
import { makeApp, TEST_CONFIG } from "../helpers/make-app.js";
import {
  VIDEO_TASK_ID_RE, VIDEO_TASK_ID_SHAPE, videoTaskIdShape,
} from "../../src/core/admin/protocol-catalog.js";

describe("POST /v1/images/generations", () => {
  it("把上游图片响应原样返回", async () => {
    const upstream = { created: 1, data: [{ url: "https://example.invalid/a.png" }] };
    const { app } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-image-2.1-flash", prompt: "一只猫" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream);
  });

  it("无凭据返回 401", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1/images/generations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("视频两段式", () => {
  it("POST /v1/videos 建任务后返回任务标识", async () => {
    const { app } = await makeApp([{ status: 200, body: '{"id":"task-1","status":"queued"}' }]);
    const res = await app.request("/v1/videos", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-video-v2.0", prompt: "一只猫在跑" }),
    });
    expect(await res.json()).toMatchObject({ id: "task-1" });
  });

  it("GET /v1/videos/{id} 轮询取结果", async () => {
    const { app, fetcher } = await makeApp([
      { status: 200, body: '{"id":"task-1","status":"completed","url":"https://example.invalid/a.mp4"}' },
    ]);
    const res = await app.request("/v1/videos/task-1", { headers: { authorization: "Bearer t" } });
    expect(await res.json()).toMatchObject({ status: "completed" });
    expect(fetcher.usedKeys).toHaveLength(1);
  });
});

/**
 * ── K5：这个 origin 上不许出现一个下游用户影响得了的**同源文档** ──────────────
 *
 * `GET /v1/videos/:id` 是一条 GET 路由，而 `/v1` 的鉴权**接受 `?key=` 查询参数**
 *（Gemini 协议兼容）⇒ 拿着网关口令的下游用户能构造一条**可以直接导航过去**的同源
 * URL。上游的 `content-type` 又在 `SAFE_RESPONSE_HEADERS` 里被逐字透传，于是那条
 * URL 能返回 `text/html` / `image/svg+xml` —— 直接导航过去就是一个同源文档，
 * 里面的 `<script>` / `on*` / `javascript:` 都会执行，而面板把 `ADMIN_TOKEN` 原样
 * 放在**这个 origin** 的 localStorage 里（作用域是 origin 而不是 path）。
 * 全局 `nosniff` 只否掉「按内容嗅探」，挡不住「显式声明成 text/html」。
 *
 * ⚠️ **为什么这一条在契约层再测一遍**（dispatcher 的单测已经覆盖夹紧本身）：
 * 单测证明的是 `sanitize()` 会夹紧，证明不了**这条真实路由的响应真的经过它**，
 * 也证明不了后面没有别的中间件把 content-type 改回去。Task 6 刚栽过一次
 * 「测的是抄件不是原件」，这一格走的是真 `createApp` + 真路由 + 真 `?key=`。
 */
describe("GET /v1/videos/{id}：上游 content-type 不许把本源变成同源文档", () => {
  it("上游 text/html 经这条真实路由出来时是 application/octet-stream，且 nosniff 还在", async () => {
    const { app } = await makeApp([{
      status: 200, body: "<html><script>alert(1)</script></html>",
      headers: { "content-type": "text/html; charset=utf-8" },
    }]);
    // **用 `?key=` 发**：这正是「能直接导航过去」的那条形态，请求头是带不上的。
    const res = await app.request("/v1/videos/task-1?key=t");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("image/svg+xml 同样被夹紧——独立 SVG 也是能执行脚本的同源文档", async () => {
    const { app } = await makeApp([{
      status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      headers: { "content-type": "image/svg+xml" },
    }]);
    const res = await app.request("/v1/videos/task-1?key=t");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  /** 反向：真正的媒体类型必须原样透传，否则媒体路由整个坏掉（比不修更糟）。 */
  it("video/mp4 原样透传，content-disposition 也还在", async () => {
    const { app } = await makeApp([{
      status: 200, body: "not-really-a-video",
      headers: { "content-type": "video/mp4", "content-disposition": 'attachment; filename="a.mp4"' },
    }]);
    const res = await app.request("/v1/videos/task-1?key=t");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="a.mp4"');
  });
});

// I1：{id} 原样拼进上游路径 = 已鉴权客户端可以拿池中的真实上游 key 打上游任意路径。
// 这些用例除了断言 400，还必须断言**一次上游请求都没发出**——只要发出去了，
// 携带的就是池里的真实 key。
describe("GET /v1/videos/{id} 的路径穿越防护", () => {
  const evil = [
    ["路径穿越（编码斜杠）", "/v1/videos/..%2F..%2Fadmin"],
    ["查询参数注入", "/v1/videos/x%3Fsecret%3D1"],
    ["整段 URL 覆盖", "/v1/videos/https%3A%2F%2Fevil.invalid%2Fx"],
    ["空白与换行", "/v1/videos/a%20b"],
  ] as const;

  for (const [name, path] of evil) {
    it(`${name} 返回 400 且不向上游发出任何请求`, async () => {
      const { app, fetcher } = await makeApp([{ status: 200, body: "{}" }]);
      const res = await app.request(path, { headers: { authorization: "Bearer t" } });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(fetcher.usedKeys).toEqual([]);
    });
  }

  // 裸的 `..` 在 URL 层就被规范化掉了（`/v1/videos/..` → `/v1/`），压根到不了这条
  // 路由，因此这里断言的是「无论落到哪个状态码，都没有携带池中 key 发出上游请求」。
  it("未编码的 .. 被 URL 规范化吃掉，同样不会向上游发出请求", async () => {
    const { app, fetcher } = await makeApp([{ status: 200, body: "{}" }]);
    const res = await app.request("/v1/videos/..", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fetcher.usedKeys).toEqual([]);
  });

  it("合法标识仍然放行，且拼出的上游 URL 不越出 /v1/videos/ 之下", async () => {
    const { app, fetcher } = await makeApp([{ status: 200, body: "{}" }]);
    const res = await app.request("/v1/videos/task_1-ABC", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    expect(fetcher.sentUrls).toEqual(["https://upstream.test/v1/videos/task_1-ABC"]);
  });
});

/**
 * ── 字符集硬闸：400 得让人知道**该怎么改**，不只是「不合法」 ────────────────────
 *
 * 上面那组只断言「拦下了」。**拦下之后运维手里只有一个 400**，而这条路是两段式的：
 * 标识是上游在 `POST /v1/videos` 那一步签发的，不是客户端自己起的名字。报文不说
 * 「接受什么形状」，读者除了逐个字符试没有别的办法；报文只说「改成这个形状」而不说
 * 「这个标识不是你起的」，读者会去改自己的请求参数，**而那一定改不出结果**
 *（阶段 D 的教训：报文可以亲手把人引进坑）。两句话在这一组里各有一条断言。
 */
describe("GET /v1/videos/{id} 的字符集硬闸：400 说得清", () => {
  const AUTH = { authorization: `Bearer ${TEST_CONFIG.gatewayToken}` };

  it("非法形状的任务标识 ⇒ 400，且报文逐字说明接受什么形状", async () => {
    const { app, fetcher } = await makeApp([], ["sk-x"], {}, () => 1_000);
    // `.` 是这条假设最可能被真上游踩中的那个字符（`upstream-facts.ts` 的
    // `video.taskIdCharset` 逐字点了 `.` `:` `+` `/` `=` 五个）。
    const res = await app.request("/v1/videos/job.2026.001", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message, "报文里没有那个形状 —— 读者只知道「不合法」，不知道该改成什么")
      .toContain(VIDEO_TASK_ID_SHAPE);
    expect(
      body.error.message,
      "报文没说这个标识是上游在建任务那一步签发的 —— 那会把人指去改自己的请求参数，而那一定改不出结果",
    ).toContain("POST /v1/videos");
    expect(fetcher.usedKeys, "已经 400 了却还拿池里的 key 向上游发过请求").toEqual([]);
  });

  it("反向控制（同格）：合法 id 仍然 200，且出站 URL 逐字对 —— 防「收紧到谁都进不来」空洞满足", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: '{"id":"x","status":"completed"}' }], ["sk-x"], {}, () => 1_000,
    );
    const res = await app.request(`/v1/videos/${id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(fetcher.sentUrls.at(-1)).toBe(`${TEST_CONFIG.agnesBaseUrl}/videos/${id}`);
  });
});

/**
 * ── `VIDEO_TASK_ID_SHAPE` 说的是不是**真话** ────────────────────────────────
 *
 * 「从正则派生」只保证形状串**跟着正则一起变**，不保证它**说得对**：取法写错
 *（漏掉长度那一段、把上下界读反、字符类多抠掉一个字符）照样派生得出一个自洽却不
 * 成立的串，而它会被逐字印进 400 的报文与五份 API.md —— 那时守卫本身成了假话的
 * 搬运工。这一组把形状串**读回来**，逐条去问真正的 `VIDEO_TASK_ID_RE`：
 * 它点名的每个字符真的收、它没点名的那几个真的不收、它给的两个界真的就是分界。
 *
 * ⚠️ **它验的是「形状串描述得对不对」，不是「这个字符集本身对不对」**——后者是一条
 * 未核实的上游假设，登记在 `src/core/admin/upstream-facts.ts` 的 `video.taskIdCharset`，
 * 只有一次真上游能定案。
 */
describe("VIDEO_TASK_ID_SHAPE 说的是真话", () => {
  /** 形状串读回来：`字符类 (下界-上界)`。 */
  const PARTS = /^(\S+) \((\d+)-(\d+)\)$/.exec(VIDEO_TASK_ID_SHAPE);

  it("形状串读得回来 —— 读不回来的话下面几格全是空转", () => {
    expect(PARTS, `VIDEO_TASK_ID_SHAPE 现在是「${VIDEO_TASK_ID_SHAPE}」，不是「字符类 (下界-上界)」这个形态`)
      .not.toBeNull();
  });

  /**
   * 把 `A-Za-z0-9_-` 这种字符类展开成逐个字符。
   * **结尾那个 `-` 是字面量不是范围**（`X-` 后面没有右端点），这一条由下面
   * 「不乱红」那格反过来钉着：把它误当成范围会吞掉后面的字符，展开集合就变了。
   */
  const expandClass = (cls: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < cls.length; i++) {
      if (cls[i + 1] === "-" && i + 2 < cls.length) {
        const from = cls.charCodeAt(i);
        const to = cls.charCodeAt(i + 2);
        // **倒着的范围要吵，不许静静展开成空集。** 真正的正则引擎对 `_-.` 直接
        // SyntaxError；这里若跟着静默，形状串里多写的那几个字符会被这个展开器
        // 自己吞掉，于是「形状点名的每个字符正则真的收」那一格漏检 —— 变异实测
        // 踩到过一次（`A-Za-z0-9_-.:` 里的 `.` 被 `_-.` 这段吞了）。
        if (from > to) {
          throw new Error(`字符类里「${cls[i]}-${cls[i + 2]}」是一个倒着的范围，真正的正则会当场 SyntaxError`);
        }
        for (let c = from; c <= to; c++) out.push(String.fromCharCode(c));
        i += 2;
      } else out.push(cls[i]!);
    }
    return out;
  };

  it("形状点名的每一个字符，VIDEO_TASK_ID_RE 真的收", () => {
    const chars = expandClass(PARTS![1]!);
    expect(chars.length, "字符类展开成空的 —— 下面那条 filter 什么都没检查").toBeGreaterThan(0);
    const rejected = chars.filter((c) => !VIDEO_TASK_ID_RE.test(c));
    expect(rejected, `形状说收这些字符，正则却不收：${rejected.join("")}`).toEqual([]);
  });

  it("不乱红：形状没点名的那几个字符，正则一个都不收", () => {
    const chars = expandClass(PARTS![1]!);
    // 取的是**真上游最可能签发**的那几个（`video.taskIdCharset` 逐字点的五个）加上空白与百分号。
    const outside = [".", ":", "+", "/", "=", " ", "%"];
    expect(
      outside.filter((c) => chars.includes(c)),
      "反向控制取的字符其实在形状点名的集合里 —— 这一格测的是一个不存在的世界",
    ).toEqual([]);
    const accepted = outside.filter((c) => VIDEO_TASK_ID_RE.test(c));
    expect(accepted, `形状没点名这些字符，正则却收：${accepted.join("")}`).toEqual([]);
  });

  it("形状给的两个界就是正则收与不收的那条分界（界内收、界外一个都不收）", () => {
    const lo = Number(PARTS![2]);
    const hi = Number(PARTS![3]);
    // 填充字符**从形状自己点名的字符集里取**，不写死一个 `a`：写死的话，字符集哪天
    // 不再含 `a`，这一格会红在「长度界不对」上，而真因是字符 —— 报文把人指错地方。
    // （M2 变异实测过这条：正则收紧成只收 `Z` 之后，写死 `a` 的版本红的是长度那句话。）
    const fill = expandClass(PARTS![1]!)[0]!;
    const s = (n: number) => fill.repeat(n);
    expect(VIDEO_TASK_ID_RE.test(s(lo)), `长度 ${lo}（形状说的下界）被拒了`).toBe(true);
    expect(VIDEO_TASK_ID_RE.test(s(hi)), `长度 ${hi}（形状说的上界）被拒了`).toBe(true);
    expect(VIDEO_TASK_ID_RE.test(s(lo - 1)), `长度 ${lo - 1} 被收了 —— 形状说的下界不是真的下界`).toBe(false);
    expect(VIDEO_TASK_ID_RE.test(s(hi + 1)), `长度 ${hi + 1} 被收了 —— 形状说的上界不是真的上界`).toBe(false);
  });

  it("认不出 `VIDEO_TASK_ID_RE` 的写法时当场抛，不返回一个「大概对」的形状", () => {
    // 两种真实的改法：换成简写字符类、以及把定量符换成 `+`（长度上界从此不存在）。
    expect(() => videoTaskIdShape("^\\w{1,128}$")).toThrow("派生不出人读形状");
    expect(() => videoTaskIdShape("^[A-Za-z0-9_-]+$")).toThrow("只认");
  });

  it("三样都真的从源码里读出来：换一条形状良好的正则，字符类与上下界一起跟着变", () => {
    expect(videoTaskIdShape("^[a-f0-9]{8,64}$")).toBe("a-f0-9 (8-64)");
  });

  it("不乱红：真源那条原样喂进去不抛，交出来的就是全仓在用的那一份", () => {
    expect(() => videoTaskIdShape(VIDEO_TASK_ID_RE.source)).not.toThrow();
    // 这半句是同义反复（`VIDEO_TASK_ID_SHAPE` 就是这么算出来的），判别力在上面那一句
    // 「不抛」和这一组前四格「说的是真话」上。留着它是为了钉住导出的那份没被谁改写过。
    expect(videoTaskIdShape(VIDEO_TASK_ID_RE.source)).toBe(VIDEO_TASK_ID_SHAPE);
  });
});

// ── C-RM2：路由必须按端点的**延迟语义**挑超时档 ──────────────────────────────
//
// 这组用例走真实时钟，把两档超时按同一比例缩到毫秒级：`SLOW_UPSTREAM` 落在快档之外、
// 慢档之内。删掉 media.ts 里的 `timeout: "sync"` 会让图片/建任务两条用例变红；给轮询
// 也挂上 `sync` 会让轮询那条变红。
//
// 对话四条路由的判据是 `stream ? "firstByte" : "sync"`：非流式请求要等上游把整段回答
// 生成完才发响应头，与图片生成完全同一种延迟语义。把任意一条路由的 `timeout` 删掉
// （退回默认的 8 秒首字节档）都会让下面「非流式」那几条变红；反过来把它写死成 `sync`
// 则会让「流式」那条变红。
describe("端点的超时档位", () => {
  const SCALED = { upstreamTimeoutMs: 50, upstreamSyncTimeoutMs: 5000 };
  const SLOW_UPSTREAM = 300;
  const AUTH = { authorization: "Bearer t", "content-type": "application/json" };

  it("图片生成用同步档：上游远超快档预算才返回首字节，仍然成功", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: '{"created":1}', delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
    );
    const res = await app.request("/v1/images/generations", {
      method: "POST", headers: AUTH, body: JSON.stringify({ prompt: "一只猫" }),
    });
    expect(res.status).toBe(200);
  });

  it("视频建任务用同步档", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: '{"id":"task-1"}', delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
    );
    const res = await app.request("/v1/videos", {
      method: "POST", headers: AUTH, body: JSON.stringify({ prompt: "一只猫在跑" }),
    });
    expect(res.status).toBe(200);
  });

  it("视频轮询是快接口，仍用首字节档（上游拖过预算即失败，不给它两分钟）", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: "{}", delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
    );
    const res = await app.request("/v1/videos/task-1", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(503);
  });

  // 四种协议的非流式对话都必须走同步档：上游拖到快档预算之外照样成功，且 key 池毫发无损。
  // 原实现四条路由全用默认的 8 秒首字节档，一次这样的请求就把整池每把 key 各记一次
  // strike，三次即可全部打进 30 分钟长冷却。
  const nonStreaming = [
    ["OpenAI /v1/chat/completions", "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] }],
    ["Anthropic /v1/messages", "/v1/messages", { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }],
    ["Responses /v1/responses", "/v1/responses", { model: "m", input: "hi" }],
    ["Gemini generateContent", "/v1beta/models/m:generateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }] }],
  ] as const;

  for (const [name, path, body] of nonStreaming) {
    it(`${name} 非流式用同步档：慢上游照样成功，池毫发无损`, async () => {
      const upstream = JSON.stringify({
        id: "c1", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      const { app, repo } = await makeApp(
        [{ status: 200, body: upstream, delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
      );
      const res = await app.request(path, { method: "POST", headers: AUTH, body: JSON.stringify(body) });

      expect(res.status).toBe(200);
      const k1 = (await repo.all())[0]!;
      expect(k1.strikes).toBe(0);
      expect(k1.cooldownUntil).toBe(0);
    });
  }

  it("流式对话仍用首字节档：同一个慢上游被甩掉并记 strike（§7.3 语义不变）", async () => {
    const { app, repo } = await makeApp(
      [{ status: 200, body: "{}", delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
    );
    const res = await app.request("/v1/chat/completions", {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ model: "m", messages: [], stream: true }),
    });
    expect(res.status).toBe(503);
    expect((await repo.all())[0]!.strikes).toBe(1);
  });

  it("图片生成把整体预算耗尽才返回 504，且期间真的换过 key、没惩罚任何 key", async () => {
    // 这条要的是「超时之后怎么办」，把同步档也压到毫秒级，免得真等满 5 秒。
    // `now` 用真实时钟：同步档的整体 deadline 就是靠它推进的。
    const { app, repo, fetcher } = await makeApp(
      [
        { status: 200, body: "{}", delayMs: 60_000 },
        { status: 200, body: "{}", delayMs: 60_000 },
      ],
      ["k1", "k2"],
      { upstreamTimeoutMs: 50, upstreamSyncTimeoutMs: 120 },
      () => Date.now(),
    );
    const res = await app.request("/v1/images/generations", {
      method: "POST", headers: AUTH, body: JSON.stringify({ prompt: "x" }),
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { reason: "upstream_timeout" } });
    // 单把 key 超时不再吃掉整个请求：两把 key 都真的被试过了。
    // （轮询游标是模块级的，同一个测试文件里起始位置不定，故只断言集合。）
    expect([...fetcher.usedKeys].sort()).toEqual(["k1", "k2"]);
    expect((await repo.all()).every((r) => r.strikes === 0 && r.cooldownUntil === 0)).toBe(true);
  });
});
