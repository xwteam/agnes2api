import { describe, it, expect } from "vitest";
import { makeApp, TEST_CONFIG } from "../helpers/make-app.js";
import {
  PROTOCOLS, MODEL_CATALOG, endpointFor, SAMPLE_PROMPT, MEDIA_ENDPOINTS, withTaskId,
} from "../../src/core/admin/protocol-catalog.js";

/**
 * ⚠️ **必须过滤掉 `method === "ALL"` 的条目。** 设计 §13.2 已实测：Hono 4.13.2 的
 * `app.routes` 会把用 `use()` 注册的中间件也列成条目，朴素循环会把中间件当路由，
 * 造出一条「覆盖了但什么都没证明」的断言。
 */
// ⚠️ **`makeApp` 是 `async`**（`tests/helpers/make-app.ts:121`），所以要 `Awaited<>`。
// 不加的话 `ReturnType` 拿到的是 Promise，`["app"]` 直接是类型错误。
function realRoutes(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  return app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
}

/**
 * 媒体三条端点**真正应该打到上游哪条地址**——**逐条手写整串，一个字符都不从
 * `MEDIA_ENDPOINTS` 推**（第 6 种假阳性，实测见变异 M14）。
 * 主机那一半是 `tests/helpers/make-app.ts` 里 `TEST_CONFIG.agnesBaseUrl` 的值，
 * 同样手写——从那个常量拼出来的话，改掉它这几格会跟着变而不红。
 */
const MEDIA_UPSTREAM: Readonly<Record<string, string>> = {
  "image.generate": "https://upstream.test/v1/images/generations",
  "video.create": "https://upstream.test/v1/videos",
  "video.poll": "https://upstream.test/v1/videos/task_1-ABC",
};

describe("协议目录与真实路由表对账", () => {
  /**
   * ⚠️ **变红条件对四条协议不是同一句话**（评审 MEDIUM，实测订正；这条是存量假话，
   * 而上一轮我在单测里引用它时把它读反了，于是同一个错被抄成了两处）：
   * · **openai / anthropic / responses**：把 `pathTemplate` 改一个字符 ⇒ **红**（逐字比对）；
   * · **gemini**：把 `pathTemplate` 改一个字符 ⇒ **不红**。它走下面那条 `streamMode === "path"`
   *   分支，断的是常量 `"POST /v1beta/models/:rest{.+}"`，**从不读 `p.pathTemplate`**
   *   （实测：`models`→`modelZ`，这一格照绿）。
   *   gemini 的 `pathTemplate` 由单测「Gemini 的流式换的是路径不是请求体字段」的手写字面量
   *   与本文件「gemini 的 sample() 经真 app 发出去拿到 200」那格钉着。
   */
  it("每条协议端点都在 app 上真的注册着 —— 改一个字符就是面板给出一条 404 的示例", async () => {
    // 变红条件：把 PROTOCOLS 里**那三条静态协议**的 pathTemplate 改一个字符（见上，gemini 除外）
    const { app } = await makeApp([], []);
    const routes = realRoutes(app);
    for (const p of PROTOCOLS) {
      // Gemini 的注册路径是通配段 `/v1beta/models/:rest{.+}`，模板替换后不能直接比对，
      // 所以按前缀判定；另外三条是静态路径，逐字比对。
      if (p.streamMode === "path") {
        expect(routes).toContain("POST /v1beta/models/:rest{.+}");
      } else {
        expect(routes).toContain(`${p.method} ${p.pathTemplate}`);
      }
    }
  });

  /**
   * ⚠️ **这一格能证明什么、不能证明什么，逐条写清楚（评审 Important 1，实测订正）**：
   *
   * 它证明的是「目录里列出的每一条非通配端点，在 app 上确实注册着」——
   * **变红条件是把某条**非通配**`path` 改一个字符，或加一条 app 上没有的**非通配**端点。**
   * ⚠️ **「加一条 app 上没有的端点」这句要带上「非通配」三个字**（评审 LOW，实测）：
   * 新增条目若含 `generateContent` 或 `{model}`，会被下面那行 `continue` 跳过，**这一格加了也不红**
   *（实测：给某个图片模型加一条 `POST /v1beta/models/nonexistent:generateContent`
   * ⇒ 本文件 `8 passed`，一格没红）。
   * **接住它的是单测**「媒体模型的 endpoints 逐条手写字面量」（同一条变异 ⇒ 那格红）。
   *
   * 它**不**证明「目录没漏端点」，两条成因都实测过：
   * ① `toContain` 只抓**新增**、抓不到**删除**：少一条只是少循环一次，照绿；
   * ② 下面那行 `continue` 把 Gemini 那条整条跳过（它的注册路径是通配段，模板替换后
   *    没法直接比对）。
   * ⇒ 我原来在这里写的「变红条件：把 agnes-video-v2.0 的 GET /v1/videos/:id 删掉」
   *    **实测为假**（删掉之后 2130 全绿）。**已改成真话。**
   *
   * 「目录没漏端点、模型名没写错」现在由单测那两格钉着：
   * `tests/unit/admin/protocol-catalog.test.ts`
   * 「对话模型的 endpoints 与 PROTOCOLS 逐条一致」与「媒体模型的 endpoints 逐条手写字面量」。
   */
  it("模型目录里的媒体端点同样是真路由 —— 列出来的每一条都得真的在 app 上", async () => {
    // 变红条件：把 /v1/videos 改成 /v1/video（**不是**「删掉一条」，见上面那段）
    const { app } = await makeApp([], []);
    const routes = realRoutes(app);
    for (const m of MODEL_CATALOG) {
      for (const e of m.endpoints) {
        if (e.path.includes("{model}") || e.path.includes("generateContent")) continue;
        expect(routes).toContain(`${e.method} ${e.path}`);
      }
    }
  });
});

/**
 * ⚠️ **上面那两格只证明「路由存在」，不证明那个请求体调得通**——那是下面这一组的事。
 * 而下面这一组证明的也只是「**目录里的端点在这份 app 上存在且接受这个请求体**」，
 * **不**证明「上游 Agnes 真的接受这个请求体」：上游是 `FakeFetcher` 桩掉的。
 * 后者只有真机能验，属于 P3e 的双形态真机验收。
 */
describe("协议目录的示例请求真的调得通", () => {
  it.each(PROTOCOLS.map((p) => [p.id, p] as const))(
    "%s 的 sample() 经真 app 发出去拿到 200，且出站 URL 逐字等于 agnesBaseUrl + upstreamPath，"
    + "上游收到的 body 里带着那个 model —— "
    + "这一格是 D1『漂了没人会发现』的唯一护栏，也是 upstreamPath 的唯一护栏（评审 C3）",
    async (_id, p) => {
      const model = MODEL_CATALOG[0]!.id;
      // makeApp 的第 5 参是选项对象。⚠️ 位置参数别传错：签名是
      // (outcomes, keys, configOverride, now, options)，把选项当第 1 参传会静默用另一份默认
      // 存储（P3c 计划在这上面栽过一次，结论从「无缺陷」翻成 Critical）。
      // ⚠️ **`makeApp` 是 async，解构返回值就必须 `await`。**
      // 实测（评审 Minor 2 订正）：仓里 222 处调用点，**220 处带 `await`**；
      // 另外 2 处是 `return makeApp(...)` / `return makeApp(...).then(...)`
      //（在 `tests/contract/admin-events.test.ts` 与 `tests/contract/admin-registrar.test.ts`
      // 各自的夹具函数里，**不是用例体**，所以这里刻意不给行号），
      // 把 Promise 直接交出去，等价、不是缺陷。
      // ⇒ 我原来写的「全部带 await，0 处不带」是从简报承接下来的一句**数据性假话**。
      const { app, fetcher } = await makeApp(
        [{ status: 200, body: JSON.stringify({ id: "x", object: "chat.completion", model,
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) }],
        ["sk-catalog-probe-key-0001"],
        {}, () => 1_000,
      );
      const res = await app.request(endpointFor(p, model, false), {
        method: p.method,
        // ⚠️ 网关口令取 `TEST_CONFIG.gatewayToken`（夹具值 `"t"`），**不是随手写一个字符串**：
        // 写错的话四条全部 401，而 `expect(res.status).toBe(200)` 会红成「示例调不通」，
        // 把一个夹具问题误报成目录缺陷。
        headers: {
          authorization: `Bearer ${TEST_CONFIG.gatewayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(p.sample(model)),
      });
      expect(res.status).toBe(200);
      // `FakeFetcher` 自己就记着出站的 body 与 URL（`sentBodies` / `sentUrls`，
      // `tests/helpers/fake-fetcher.ts:13-18`），**用它现成的，别新造一个钩子。**
      expect(fetcher.sentBodies.join("")).toContain(model);
      // 样例里那句用户输入必须活着穿过协议转换。四条协议里有三条要被转成内部格式
      // （Gemini 的 `contents[].parts[].text`、Responses 的 `input` 都在转换里换了形状），
      // 转丢了的话示例发出去是一条空请求，而面板照样把它印出来教用户怎么调。
      expect(fetcher.sentBodies.join(""), `${p.id} 的样例文本没活着到上游`)
        .toContain(SAMPLE_PROMPT);
      // ★ 评审 C3 的落点：观测点在**真实出站 URL**上，不是比对目录自己的两个字段。
      expect(fetcher.sentUrls.at(-1)).toBe(`${TEST_CONFIG.agnesBaseUrl}${p.upstreamPath}`);
    },
  );

  /**
   * ── 变异 M2 的落点（**本任务实测之后补的一格，计划里没有**）────────────────
   *
   * 变异表里 M2 是「把 anthropic 的 `sample()` 去掉 `max_tokens`，期望
   * 『anthropic 的 sample() 经真 app 发出去拿到 200』那一格变红」。**实测 ESCAPED**：
   * 上游是 `FakeFetcher`，它无条件回 200；而网关自己**不校验** `max_tokens`
   *（`src/core/protocol/anthropic.ts:46` 只是原样透传，缺了就是 `undefined`，
   * `JSON.stringify` 把这个键整个丢掉）⇒ 只有真实的上游才会 400。
   *
   * 「示例请求真的能被上游接受」在假上游下按定义就不可观测（见上面那段边界，
   * 它归 P3e 的真机验收）。**但它可观测的那一半在这里**：目录声称必填的那个字段，
   * 有没有活着穿过网关的协议转换、真的到达上游。掉了它，示例在生产上就是一条 400，
   * 而面板照样把它印出来教用户怎么调——这正是 D1「漂了没人会发现」的形态。
   *
   * 期望值 `64` 手写字面量，不从 `PROTOCOLS` 推（第 6 种假阳性）。
   * **两个方向都能分辨**：目录去掉 `max_tokens` 会红；网关的协议转换不再透传它同样会红。
   */
  it("anthropic 声称必填的 max_tokens 真的到得了上游 —— 假上游看不出 400，但看得出这个键没了", async () => {
    const p = PROTOCOLS.find((x) => x.id === "anthropic")!;
    const model = MODEL_CATALOG[0]!.id;
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: JSON.stringify({ id: "x", object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] }) }],
      ["sk-catalog-probe-key-0003"],
      {}, () => 1_000,
    );
    const res = await app.request(endpointFor(p, model, false), {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_CONFIG.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(p.sample(model)),
    });
    expect(res.status).toBe(200);
    // 先钉住「真的发出去了一次」——否则下面那条断言在零次出站时会红成另一种病因。
    expect(fetcher.sentBodies.length, "上游应当恰好被打了一次").toBe(1);
    expect(JSON.parse(fetcher.sentBodies[0]!)).toMatchObject({ max_tokens: 64 });
  });

  /**
   * 反向自检：上面那格断言的 `sentUrls.at(-1)` 若是因为**根本没发出去任何一次出站请求**
   * 而恰好为 `undefined`，`toBe()` 会红——所以那一格不会静默通过。
   * 但反过来「出站 URL 与对外路径长得不一样」这件事本身也要被看见一次，
   * 否则读的人分不清这一组到底证没证明「两条路径是两个东西」。
   */
  /**
   * ── **媒体三条搬进真源之后的护栏（P3d Task 12）** ────────────────────────────
   *
   * 搬之前那三条路径只住在 `src/http/routes/media.ts` 里，**对外那半与上游那半各写一遍
   * 字面量**；搬之后它们是 `MEDIA_ENDPOINTS` 的两个字段，而这一格是它们唯一的护栏。
   *
   * ⚠️ **观测点在两端各自的真实字节上，不是比对目录自己的两个字段**（与
   * `upstreamPath` 那一条守的是同一条纪律，评审 C3）：
   * · 对外那半 —— 用 `app.request(pathTemplate)` **真的打一次**，判 `status !== 404`；
   * · 上游那半 —— 判 `fetcher.sentUrls.at(-1)`（`FakeFetcher` 自己记的真实出站 URL）。
   *
   * ⚠️⚠️ **出站 URL 的期望值必须手写，这一条是实测补上的**（变异 M14）：
   * 上一版写的是 ``expect(sentUrls.at(-1)).toBe(`${agnesBaseUrl}${m.upstreamPath}`)`` ——
   * 而 `src/http/routes/media.ts` **自己也是从这张表读 `upstreamPath` 的**
   * ⇒ 改一个字符两侧一起变，**11/11 全绿**。那正是本文件反复登记的那条：
   * **期望值从被测对象自己推导 = 同义反复**（第 6 种假阳性）。
   * 四条对话协议那一格没这个毛病，因为它们的路由文件传的是各自的字面量、
   * 不读这张表——**同一个写法在两张表上一个成立一个不成立**，这就是「先找反例」。
   * ⇒ 现在两侧独立：期望值是下面那张手写表，实际值是 `FakeFetcher` 记的真出站 URL。
   *
   * **变红条件（三条，逐条实测，见 progress note 的 M13/M14/M15）**：
   * ① 把某条的 `pathTemplate` 改一个字符 ⇒ 那一行 404 ⇒ 红（路由是按它注册的，
   *    所以真正被证明的是「注册与浏览器拿到的是同一个字符串」）；
   * ② 把某条的 `upstreamPath` 改一个字符 ⇒ 出站 URL 与手写表对不上 ⇒ 红；
   * ③ 把 `media.ts` 里 `dispatch({ path: … })` 换回一个字面量 ⇒ 同上 ⇒ 红。
   *
   * ⚠️ **`GET` 那条不能与两条 `POST` 走同一个循环体**：它没有请求体、要拿一个真的任务
   * 标识去展开 `taskSlot`，而**把它塞进同一个循环并给它一个空 body**，得到的是一次 400
   * （`VIDEO_TASK_ID_RE` 拦下空标识）——那一格会「因为另一个原因绿」：`status !== 404`
   * 成立、而上游一次都没被打，`sentUrls.at(-1)` 是 `undefined`，
   * `toBe()` 会红成一个看不懂的病因。所以这里分成两格，各自带前置条件。
   */
  it.each(MEDIA_ENDPOINTS.filter((m) => m.op === "generate").map((m) => [m.id, m] as const))(
    "媒体端点 %s：对外那条真的注册着、上游那条逐字等于 agnesBaseUrl + upstreamPath —— "
    + "观测点在真实出站 URL 上，不是比对目录自己的两个字段",
    async (_id, m) => {
      const model = MODEL_CATALOG.find((x) => x.modality === m.modality)!.id;
      const { app, fetcher } = await makeApp(
        [{ status: 200, body: JSON.stringify({ created: 1, data: [{ url: "https://cdn.invalid/a" }] }) }],
        ["sk-media-catalog-probe-0001"],
        {}, () => 1_000,
      );
      const res = await app.request(m.pathTemplate, {
        method: m.method,
        headers: {
          authorization: `Bearer ${TEST_CONFIG.gatewayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(m.sample(model)),
      });
      // 前置条件：这条对外路径真的注册着。**判 404 而不是判 200**——上游是桩，
      // 200 只说明桩回了 200；404 才是「这条路由压根不存在」那个失效形态。
      expect(res.status, `${m.id} 的对外路径没注册`).not.toBe(404);
      // 前置条件：真的向上游发出去过一次，否则下面那条断言是在跟 `undefined` 比。
      expect(fetcher.sentUrls.length, `${m.id} 一次上游都没打`).toBe(1);
      // **期望值来自手写表**（见上面那段 ⚠️⚠️），不是 `agnesBaseUrl + m.upstreamPath`。
      expect(MEDIA_UPSTREAM[m.id], `手写表里没有 ${m.id} —— 新增端点要在那张表里表态`).toBeDefined();
      expect(fetcher.sentUrls.at(-1)).toBe(MEDIA_UPSTREAM[m.id]);
    },
  );

  it("媒体轮询那条：对外带任务标识、上游那条同样带着它 —— "
     + "占位符没被展开的话，网关收到的是一条字面量 :id", async () => {
    const m = MEDIA_ENDPOINTS.find((x) => x.op === "poll")!;
    // 手写字面量的任务标识，**不从任何常量推**（第 6 种假阳性）。
    const taskId = "task_1-ABC";
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: JSON.stringify({ status: "processing" }) }],
      ["sk-media-catalog-probe-0002"],
      {}, () => 1_000,
    );
    const outward = withTaskId(m.pathTemplate, String(m.taskSlot), taskId);
    expect(outward).toBe("/v1/videos/task_1-ABC");            // 手写字面量锚
    const res = await app.request(outward, {
      method: m.method,
      headers: { authorization: `Bearer ${TEST_CONFIG.gatewayToken}` },
    });
    expect(res.status, "轮询那条对外路径没注册（或标识被拦了）").toBe(200);
    expect(fetcher.sentUrls.length, "轮询一次上游都没打").toBe(1);
    // **手写整串**（与上面那一格同一条理由：路由自己也读这张表，推出来的期望值是同义反复）。
    expect(fetcher.sentUrls.at(-1)).toBe(MEDIA_UPSTREAM["video.poll"]);
    // 反向自检：**出站 URL 里不许还留着那个占位符**。它与上面那句不重复——
    // 上面那句钉的是「等于哪一条」，这一句钉的是「占位符这件事本身被处理过」，
    // 而 `taskSlot` 改名（变异 M29）时前者的失败信息看不出是这个原因。
    expect(fetcher.sentUrls.at(-1), "出站 URL 里还留着未展开的任务标识占位符")
      .not.toContain(String(m.taskSlot));
  });

  it("同一次真请求里，出站 URL 与客户端打的对外路径确实不是同一个 —— 两端各自可分辨", async () => {
    const p = PROTOCOLS.find((x) => x.id === "anthropic")!;
    const model = MODEL_CATALOG[0]!.id;
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: JSON.stringify({ id: "x", object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] }) }],
      ["sk-catalog-probe-key-0002"],
      {}, () => 1_000,
    );
    const outward = endpointFor(p, model, false);
    expect(outward).toBe("/v1/messages");                    // 手写字面量锚
    const res = await app.request(outward, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_CONFIG.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(p.sample(model)),
    });
    expect(res.status).toBe(200);
    expect(fetcher.sentUrls.at(-1)).toBe("https://upstream.test/v1/chat/completions");  // 手写字面量锚
    expect(fetcher.sentUrls.at(-1)).not.toContain(outward);
  });
});
