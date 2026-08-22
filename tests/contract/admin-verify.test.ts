import { describe, it, expect, vi, afterEach } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN, TEST_CONFIG } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { KEY_PREFIX } from "../../src/core/pool-index.js";
import { registrarFromEnv } from "../../src/core/registrar/config.js";
import type { RegistrarWiring } from "../../src/http/admin/handlers/registrar.js";
import { PROBE_MIN_INTERVAL_MS } from "../../src/http/admin/probe-guard.js";
import { SAMPLE_PROMPT, MODEL_CATALOG } from "../../src/core/admin/protocol-catalog.js";
import type { KeyRecord } from "../../src/core/types.js";

/**
 * `POST /admin/api/keys/:id/verify` —— 单把 key 的验活，以及与通道连通性测试
 * **共用的**出站探测护栏（P3d Task 8，设计 §10.2 / §11 + 订正 D1 / F8）。
 *
 * **contract ⇒ node 与 workerd 各跑一遍**（`tests/global-setup.ts` 的 `POLICY` 强制）。
 *
 * ── 这一组的头等纪律：观测点一律不落在响应体上 ──────────────────────────────
 *
 * P3c 收口给出的判别法：**「凡是观测点落在响应体的某个字段上，先问这个字段是谁写的」**
 * ——这条端点回的 `{ ok, status, latencyMs }` **三个全是 handler 自报**，
 * 拿它们做判据只能证明 handler 说了什么。所以下面每一格的观测点都落在：
 * · **被桩掉的 fetcher 收到了什么**（URL、`authorization` 里是哪一把 key、请求体）；
 * · **存储被动了几次**（`CountingStorage` 的 put / delete）与**记录本身有没有变**；
 * · **有没有真的发生一次出站**（`sentUrls.length`）。
 *
 * ⚠️ **唯一一格刻意反过来看响应体的，是「一个字节都不许回来」那一格**——
 * 它要证的恰恰是「响应体里**没有**某段文本」，判据只能是整段响应体文本本身。
 */

const NOW = 20_000 * 86_400_000;
const withKey = { "x-admin-key": TEST_ADMIN_TOKEN };
const jsonHeaders = { ...withKey, "content-type": "application/json" };

/** 出站的上游 URL。**手写字面量**，不是 `agnesBaseUrl + upstreamPath` 拼出来的。 */
const UPSTREAM_URL = "https://upstream.test/v1/chat/completions";

/** 注册机开着、两条通道都配齐——共用护栏那一格要拿通道测试当对照。 */
const BOTH_CHANNELS = registrarFromEnv({
  REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", REGISTRAR_FALLBACK: "moemail",
  YYDS_API_KEY: "yk", MOEMAIL_BASE_URL: "https://moe.invalid", MOEMAIL_API_KEY: "mk",
}, {});

const verify = (
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  id: string,
  body?: unknown,
) => app.request(`/admin/api/keys/${id}/verify`, {
  method: "POST",
  headers: body === undefined ? withKey : jsonHeaders,
  body: body === undefined ? undefined : JSON.stringify(body),
});

const testChannel = (
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  channel: string,
) => app.request(`/admin/api/registrar/channels/${channel}/test`, { method: "POST", headers: withKey });

/** 池子里某一把 key（按明文找，**不按下标**：`repo.all()` 不承诺顺序）。 */
async function idOf(repo: Awaited<ReturnType<typeof makeApp>>["repo"], key: string): Promise<string> {
  const rec = (await repo.all()).find((r) => r.key === key);
  if (rec === undefined) throw new Error(`夹具里没有这把 key：${key}`);
  return rec.id;
}

afterEach(() => { vi.useRealTimers(); });

describe("POST /admin/api/keys/:id/verify —— 验的是哪一把、打的是哪一条", () => {
  it("验活打的是这把 key 而不是别的 —— 观测点在桩 fetcher 收到的 authorization 头，不在响应体", async () => {
    // ⚠️ **两把 key 的内容必须不同**（本仓登记的第 1 种假阳性：夹具 A/B 同值 ⇒
    // 谁赢都过）。这一格若只放一把，「handler 拿 `repo.all()[0]` 而不是 `:id` 指的那把」
    // 这种实现照样全绿。
    const { app, repo, fetcher } = await makeApp(
      [], ["sk-verify-first-0001", "sk-verify-second-0002"], {}, () => NOW,
    );
    const second = await idOf(repo, "sk-verify-second-0002");

    const res = await verify(app, second);

    expect(res.status).toBe(200);
    // `FakeFetcher.usedKeys` 记的就是出站 `authorization` 去掉 `Bearer ` 之后的值
    // （`tests/helpers/fake-fetcher.ts` 的 `usedKeys`）。
    expect(fetcher.usedKeys, "出站带的不是 :id 指的那一把 key").toEqual(["sk-verify-second-0002"]);
  });

  it("出站 URL 是 agnesBaseUrl + 协议目录的 upstreamPath，不是对外的 pathTemplate（评审 C3）", async () => {
    const { app, repo, fetcher } = await makeApp([], ["sk-verify-url-0001"], {}, () => NOW);
    await verify(app, await idOf(repo, "sk-verify-url-0001"));

    // 手写字面量。误用 `proto.pathTemplate` 会得到 `.../v1/v1/chat/completions`，当场红。
    // ⚠️ **这一格抓不住「handler 里硬编码一份 `/chat/completions`」**——那两种写法
    // 今天产出逐字节相同的 URL。补那个方向的是
    // `tests/unit/admin/probe-guard.test.ts`「verify.ts 里没有任何写死的上游/对外路径字面量 —— 路径只许来自协议目录（全局约束 15）」。
    expect(fetcher.sentUrls).toEqual([UPSTREAM_URL]);
    // 反向自检：这条 URL 真的是「配置里的 base + 目录里的上游路径」，不是我抄错的一个串。
    expect(UPSTREAM_URL.startsWith(TEST_CONFIG.agnesBaseUrl), "夹具的 agnesBaseUrl 变了").toBe(true);
  });

  it("出站请求体就是协议目录那份 sample()，模型取目录第一条 —— 验活不另写一份请求体（全局约束 15）", async () => {
    const { app, repo, fetcher } = await makeApp([], ["sk-verify-body-0001"], {}, () => NOW);
    await verify(app, await idOf(repo, "sk-verify-body-0001"));

    const sent = JSON.parse(fetcher.sentBodies[0]!) as Record<string, unknown>;
    // `SAMPLE_PROMPT` 与目录第一条模型都从真源取——**这里取的是"目录说了什么"，
    // 而被测的是"handler 有没有照目录发"**，两者不是同一个对象，不构成同义反复。
    expect(sent).toEqual({
      model: MODEL_CATALOG[0]!.id,
      messages: [{ role: "user", content: SAMPLE_PROMPT }],
    });
    // 手写字面量的锚：目录第一条今天就是这个模型 id。
    expect(MODEL_CATALOG[0]!.id).toBe("agnes-2.0-flash");
  });

  it("repo.get 直读存储，不读 isolate 快照 —— 快照里那把是旧值，验它等于在验一把已经不存在的 key", async () => {
    // ⚠️ **必须把快照缓存打开**（夹具默认 `poolCacheTtlMs: 0` ⇒ `all()` 每次真读，
    // 那种夹具下 `repo.get()` 与 `repo.all()` **数学上等价**，这一格分辨不出任何东西
    // ——本仓登记的第 5 种假阳性）。
    const storage = new MemoryStorage(undefined, () => NOW);
    const { app, repo, fetcher } = await makeApp(
      [], ["sk-verify-stale-old"], { poolCacheTtlMs: 60_000 }, () => NOW, { storage },
    );
    const id = await idOf(repo, "sk-verify-stale-old");
    // 上一行的 `repo.all()` 已经把快照焐热了。现在**绕过 repo 直接改存储**——
    // 走 `repo.save()` 会顺手更新快照，那样这一格又什么都测不出来。
    const raw = await storage.get<KeyRecord>(KEY_PREFIX + id);
    await storage.put(KEY_PREFIX + id, { ...raw!, key: "sk-verify-stale-new" });

    await verify(app, id);

    expect(fetcher.usedKeys, "验的是快照里那个旧值").toEqual(["sk-verify-stale-new"]);
    // 反向自检：快照**确实**还是旧的，否则上面那条断言在任何实现下都成立。
    expect((await repo.all()).find((r) => r.id === id)!.key, "快照居然已经跟着更新了 —— 这一格失去判别力").toBe("sk-verify-stale-old");
  });

  it("id 不存在：404，且一次出站都不发", async () => {
    const { app, fetcher } = await makeApp([], ["sk-verify-404-0001"], {}, () => NOW);
    const res = await verify(app, "deadbeefdeadbeef");
    expect(res.status).toBe(404);
    expect(fetcher.sentUrls, "对一个不存在的 id 也真的打了一次上游").toEqual([]);
  });
});

describe("验活是只读探针：写零个存储字段（订正 F8）", () => {
  it("验活之后 storage 的 put / delete 计数都是 0 —— 失败记 strike 与成功清 strike 各自是一颗自毁按钮", async () => {
    const st = new CountingStorage(new MemoryStorage(undefined, () => NOW));
    // **上游回 401**：这是最想记 strike 的那一支，判别力全在这里。
    const { app, repo, fetcher } = await makeApp(
      [{ status: 401, body: '{"error":{"message":"invalid api key"}}' }],
      ["sk-verify-readonly-0001"], {}, () => NOW, { storage: st },
    );
    const id = await idOf(repo, "sk-verify-readonly-0001");
    const before = { puts: st.puts, deletes: st.deletes };
    const recBefore = await st.get<KeyRecord>(KEY_PREFIX + id);

    const res = await verify(app, id);

    // 前置条件：这一次真的走完了整条路径（否则下面那两个 0 是空的）。
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: 401 });
    expect(fetcher.sentUrls.length, "根本没打上游 —— 这一格量的是别的东西").toBe(1);

    expect(
      { puts: st.puts - before.puts, deletes: st.deletes - before.deletes },
      "验活写了存储 —— 它必须是只读探针（订正 F8）",
    ).toEqual({ puts: 0, deletes: 0 });
    // **逐字段比一遍**：put 计数为 0 已经很强，但记录本身没变是它想守的那件事，
    // 直说比推导好（将来若出现一条不经 `storage.put` 的写路径，计数那条会漏）。
    expect(await st.get<KeyRecord>(KEY_PREFIX + id), "这把 key 的记录被验活改过").toEqual(recBefore);
  });

  it("上游 2xx 也一样不写 —— 「成功清 strike」是 L4『重新导入即解封』后门换个入口复发", async () => {
    const st = new CountingStorage(new MemoryStorage(undefined, () => NOW));
    const { app, repo } = await makeApp(
      [{ status: 200, body: "{}" }], ["sk-verify-readonly-0002"], {}, () => NOW, { storage: st },
    );
    const id = await idOf(repo, "sk-verify-readonly-0002");
    // 先把它做成「有伤在身」的样子：这样「成功清 strike」那种实现才有东西可清。
    const rec = (await st.get<KeyRecord>(KEY_PREFIX + id))!;
    await st.put(KEY_PREFIX + id, { ...rec, strikes: 2, evicted: true, evictedReason: "invalid_key" });
    const before = { puts: st.puts, deletes: st.deletes };
    const recBefore = await st.get<KeyRecord>(KEY_PREFIX + id);

    expect((await verify(app, id)).status).toBe(200);

    expect(
      { puts: st.puts - before.puts, deletes: st.deletes - before.deletes },
      "验活成功之后写了存储 —— 那就是一个「点一下就解封」的后门",
    ).toEqual({ puts: 0, deletes: 0 });
    expect(await st.get<KeyRecord>(KEY_PREFIX + id)).toEqual(recBefore);
    // 反向自检：夹具里那把 key **真的**是带伤的，否则「没被清掉」什么都没证明。
    expect(recBefore).toMatchObject({ strikes: 2, evicted: true });
  });
});

describe("明文 key 一个字节都不许回到面板（全局约束 11a）", () => {
  it("上游 401 的响应正文一个字节都不回给面板 —— 凭据无效的错误体正是各家 API 最爱回显 key 片段的地方", async () => {
    const KEY = "sk-verify-leak-canary-9f2a7c31";
    // 各家 API 401 错误体的真实形态：把 key 的前缀原样印回来。
    const upstreamBody = JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${KEY.slice(0, 14)}****31. `
          + "You can find your API key at https://platform.example/account/api-keys.",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    const { app, repo } = await makeApp(
      [{ status: 401, body: upstreamBody }], [KEY], {}, () => NOW,
    );

    const res = await verify(app, await idOf(repo, KEY));
    const text = await res.text();

    // 前置条件：拿到的确实是那一次 401 的结果（否则下面那些 `not.toContain` 是空的）。
    expect(JSON.parse(text)).toMatchObject({ ok: false, status: 401 });
    // ⚠️⚠️ **判据是整段响应体文本，不是逐字段查。**
    // 逐字段查在 handler 将来多回一个字段时会静默漏掉，而这条通路漏一次就是
    // 「上游 key 触达客户端」——`src/core/dispatcher.ts` 的 evict 分支管着第一条，
    // 这里是第二条。
    expect(text, "整把 key 出现在了响应体里").not.toContain(KEY);
    expect(text, "key 的前缀片段出现在了响应体里").not.toContain(KEY.slice(0, 14));
    // 连上游那段正文本身都不许出现：它同时还带着上游的账号页 URL。
    expect(text, "上游的错误正文被原样回显了").not.toContain("Incorrect API key provided");
    expect(text, "上游正文里那条 URL 被回显了").not.toContain("platform.example");
    // 反向自检①：这一格的三条 `not.toContain` 不是因为夹具本身就没那段文本。
    expect(upstreamBody, "夹具的上游正文里压根没有 key 片段 —— 这一格失去判别力")
      .toContain(KEY.slice(0, 14));
  });

  it("出站抛错时 reason 是机器可读的 code，不是异常消息 —— 异常消息里同样可能带着这把 key", async () => {
    const KEY = "sk-verify-throw-canary-77e10b";
    const { app, repo } = await makeApp(
      // **让桩真的 `throw`**（第 2 种假阳性：错误 stub 从不真 throw）。
      // 消息里刻意塞进那把 key：真实的连接错误常把整条请求信息带出来。
      [{ throws: new Error(`connect ECONNREFUSED while sending Bearer ${KEY} to upstream`) }],
      [KEY], {}, () => NOW,
    );

    const res = await verify(app, await idOf(repo, KEY));
    const text = await res.text();

    expect(JSON.parse(text)).toMatchObject({ ok: false, status: null, reason: "network_error" });
    expect(text, "异常消息被原样塞进了 reason").not.toContain(KEY);
    expect(text, "异常消息被原样塞进了 reason").not.toContain("ECONNREFUSED");
  });
});

describe("超时：它不经 dispatch，dispatch 那套超时一样都没有", () => {
  it("上游挂起时在 upstreamTimeoutMs（首字节档）处中止并回 timeout，不是同步档的两分钟", async () => {
    // ⚠️ **必须用真定时器语义（`vi.useFakeTimers()` + `advanceTimersByTimeAsync`）**：
    // handler 用的是**真** `setTimeout`，而**推进注入的 `deps.now()` 不会触发它**
    // ——拿递进假时钟去推，这一格会挂死到测试超时，而不是变红。
    // 本仓既有做法见 `tests/unit/dispatcher.test.ts`
    // 「同步端点：上游 12 秒才吐首字节（实测值），用内置默认配置照样成功」。
    // `now` 注入只管 `latencyMs` 那条断言，两件事别混。
    const { app, repo } = await makeApp(
      // 60 秒远大于首字节档的 8 秒、又远小于同步档的 120 秒：
      // 取错档位（`upstreamSyncTimeoutMs`）时下面推到 8 秒**不会**中止 ⇒ 这一格红。
      [{ status: 200, body: "{}", delayMs: 60_000 }],
      ["sk-verify-timeout-0001"], { upstreamTimeoutMs: 8_000, upstreamSyncTimeoutMs: 120_000 },
      () => NOW,
    );
    const id = await idOf(repo, "sk-verify-timeout-0001");

    vi.useFakeTimers();
    const pending = verify(app, id);
    await vi.advanceTimersByTimeAsync(8_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: null, reason: "timeout" });
  });

  it("8 秒之前不中止 —— 否则上一格的 timeout 可能只是「它对任何延迟都超时」", async () => {
    const { app, repo, fetcher } = await makeApp(
      // 7999 < 8000：这一次必须**成功**。
      [{ status: 200, body: "{}", delayMs: 7_999 }],
      ["sk-verify-timeout-0002"], { upstreamTimeoutMs: 8_000, upstreamSyncTimeoutMs: 120_000 },
      () => NOW,
    );
    const id = await idOf(repo, "sk-verify-timeout-0002");

    vi.useFakeTimers();
    const pending = verify(app, id);
    await vi.advanceTimersByTimeAsync(7_999);
    const res = await pending;

    expect(await res.json()).toMatchObject({ ok: true, status: 200, reason: null });
    expect(fetcher.sentUrls).toEqual([UPSTREAM_URL]);
  });
});

describe("latencyMs 来自注入的时钟，且只包住那一次出站", () => {
  it("latencyMs 恰好是一次注入时钟的步长 —— 用真 Date.now 的话它会是 0，把计时挪到护栏之前会是两步", async () => {
    // 每读一次前进 250 毫秒。250 是个与本仓任何常量都不相等的数。
    let t = NOW;
    const now = () => (t += 250);
    const { app, repo } = await makeApp([], ["sk-verify-latency-0001"], {}, now);
    const id = await idOf(repo, "sk-verify-latency-0001");

    const body = await (await verify(app, id)).json() as { latencyMs: number };

    // handler 在 `startedAt` 与收尾之间**恰好再读一次**注入时钟 ⇒ 差值恰好一步。
    // ⚠️ 这个 250 同时钉住**计时窗口的两端**：把 `startedAt` 挪到 `guard.tryAcquire`
    // 之前会得到 500（护栏那次读也被算进"上游有多慢"里），改了读取次数也会红——
    // **那是想要的**，"这个数到底在量什么"正是这一格要说清的事。
    expect(body.latencyMs, "latencyMs 不是从注入时钟算出来的（真 Date.now 下它会是 0）").toBe(250);
  });
});

describe("验活不收任何参数（全局约束 8：解析点一律 unknown + 窄化）", () => {
  it("带一个不认识的字段：400，且一次出站都不发、一格护栏都不消费", async () => {
    const { app, repo, fetcher } = await makeApp([], ["sk-verify-body-reject"], {}, () => NOW);
    const id = await idOf(repo, "sk-verify-body-reject");

    // `{"model":"..."}`：**「我以为能指定模型」**——宽松实现下这是一次
    // 「点了、但完全没按你想的那样发生」的静默误操作，而面板会如实显示成功。
    const bad = await verify(app, id, { model: "agnes-image-2.1-flash" });
    expect(bad.status).toBe(400);
    expect(fetcher.sentUrls, "被 400 拒掉的请求还是打了一次上游").toEqual([]);

    // **护栏没被消费**：紧接着（同一个冻结时刻）的一次合法调用必须成功，
    // 而不是撞上最小间隔。否则「拼错一个字段名」会把这颗按钮锁住 3 秒。
    expect((await verify(app, id)).status, "一次 400 白白吃掉了一格护栏").toBe(200);
  });

  it("空体与 `{}` 都放行 —— 面板与鉴权矩阵都是不带体调这条 POST 的", async () => {
    const { app, repo } = await makeApp([], ["sk-verify-body-ok"], {}, () => NOW);
    const id = await idOf(repo, "sk-verify-body-ok");
    expect((await verify(app, id)).status, "不带体被拒了").toBe(200);
    // 换一把 key，免得撞上最小间隔（那样这一格量的就是护栏而不是请求体解析）。
    const { app: app2, repo: repo2 } = await makeApp([], ["sk-verify-body-ok2"], {}, () => NOW);
    expect((await verify(app2, await idOf(repo2, "sk-verify-body-ok2"), {})).status, "空对象被拒了").toBe(200);
  });

  it("坏 JSON / 数组 / 标量一律 400，不静默当成「没带体」", async () => {
    const { app, repo } = await makeApp([], ["sk-verify-body-bad"], {}, () => NOW);
    const id = await idOf(repo, "sk-verify-body-bad");
    for (const raw of ["{not json", "[]", '"x"', "3"]) {
      const res = await app.request(`/admin/api/keys/${id}/verify`, {
        method: "POST", headers: jsonHeaders, body: raw,
      });
      expect(res.status, `请求体 ${raw} 被静默放行了`).toBe(400);
    }
  });
});

describe("出站探测护栏：与通道测试共用的那一套（全局约束 14）", () => {
  it("同一把 key 连点两次：第二次 429，且第二次没有真的去打上游 —— 只断言 429 抓不住『先打了上游再返回 429』", async () => {
    const { app, repo, fetcher } = await makeApp([], ["sk-verify-guard-0001"], {}, () => NOW);
    const id = await idOf(repo, "sk-verify-guard-0001");

    expect((await verify(app, id)).status).toBe(200);
    const afterFirst = fetcher.sentUrls.length;
    const second = await verify(app, id);

    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ reason: "probe_cooldown" });
    // ★ 判据在出站计数上：`tryAcquire` 挪到 `fetcher.fetch` 之后时，
    //   状态码照样是 429，而上游已经被打了第二次。
    expect(fetcher.sentUrls.length, "被 429 的那一次还是打了上游").toBe(afterFirst);
  });

  it("两把**不同**的 key 连着验，第二把不该被挡 —— 闸的粒度是 verify:<id>（评审 I11）", async () => {
    // ⚠️ 没有这一格的话，「同一把 key 连点两次」在**全局粒度**与 **per-id 粒度**
    // 两种实现下都绿——而全局粒度意味着 20 把 key 逐个验要串行等 60 秒。
    const { app, repo, fetcher } = await makeApp(
      [], ["sk-verify-gran-aaaa", "sk-verify-gran-bbbb"], {}, () => NOW,
    );
    const a = await idOf(repo, "sk-verify-gran-aaaa");
    const b = await idOf(repo, "sk-verify-gran-bbbb");

    expect((await verify(app, a)).status).toBe(200);
    expect((await verify(app, b)).status, "验另一把 key 被同一道闸挡住了").toBe(200);
    expect(fetcher.usedKeys).toEqual(["sk-verify-gran-aaaa", "sk-verify-gran-bbbb"]);
  });

  it("验一把不存在的 key：连着两次都是 404 而不是第二次 429 —— 护栏在 404 之后才占，Map 的键因此被真实 key id 限界", async () => {
    // 顺序反了的话第二次会拿到 429，而那正好说明那个随机 id 已经在护栏的 Map 里
    // 落了脚 ⇒ 任何拿到管理口令的人都能往那张表里无限灌键。
    const { app } = await makeApp([], ["sk-verify-bounded-0001"], {}, () => NOW);
    expect((await verify(app, "deadbeefdeadbeef")).status).toBe(404);
    expect((await verify(app, "deadbeefdeadbeef")).status, "不存在的 id 也在护栏里占了一格").toBe(404);
  });

  it("通道测试与验活共用同一套护栏 —— 两条端点在同一个最小间隔边界上各跑一遍，各写一套就是两套判据", async () => {
    let t = NOW;
    const now = () => t;
    const storage = new MemoryStorage(undefined, now);
    const wiring: RegistrarWiring = {
      storage,
      tend: async () => {},
      probeChannel: async () => ({ ok: true, domains: 3 }),
    };
    const { app, repo } = await makeApp(
      [], ["sk-verify-shared-0001"], { registrar: BOTH_CHANNELS }, now,
      { storage, registrar: wiring },
    );
    const id = await idOf(repo, "sk-verify-shared-0001");

    // ① 两条端点的 kind 互不相干：验活占住之后，通道测试**不**该被挡。
    expect((await verify(app, id)).status).toBe(200);
    expect((await testChannel(app, "yyds")).status, "通道测试被验活的闸挡住了").toBe(200);

    // ② 各自连点，各自 429。**通道测试此前没有任何护栏，这是一次行为变更。**
    expect((await verify(app, id)).status).toBe(429);
    expect((await testChannel(app, "yyds")).status).toBe(429);
    // 另一条通道不受影响（粒度是 `channel:<name>`，与 `verify:<id>` 同一口径）。
    expect((await testChannel(app, "moemail")).status, "另一条通道被同一道闸挡住了").toBe(200);

    // ③ **同一个边界，两条端点各跑一遍**：2999 仍挡、3000 放行。
    //    两处各拿一个自己的间隔常数时，这一格会在其中一条上变红。
    t = NOW + 2_999;
    expect((await verify(app, id)).status, "验活的最小间隔比 3000 短").toBe(429);
    expect((await testChannel(app, "yyds")).status, "通道测试的最小间隔比 3000 短").toBe(429);

    t = NOW + 3_000;
    expect((await verify(app, id)).status, "验活的最小间隔比 3000 长").toBe(200);
    expect((await testChannel(app, "yyds")).status, "通道测试的最小间隔比 3000 长").toBe(200);

    // 上面四个 2999/3000 建立在这条常量上（手写字面量，两边都改也拦得住）。
    expect(PROBE_MIN_INTERVAL_MS).toBe(3_000);
  });

  /**
   * ⚠️ **这两格是本任务变异实测补出来的，计划的变异表里没有**（M14a / M14b）。
   *
   * 把 `guard.release(kind)` 从 `finally` 挪到成功支的末尾——**上面所有格子照样全绿**。
   * 而那条改动的真实后果是：**一次探测失败之后，这颗按钮从此再也点不动**
   *（最小间隔那道闸会自愈，在途那道不会），而「上游连不上」恰恰是运维最想连点重试的
   * 那一刻。判据因此必须是「失败之后**隔过最小间隔**还能不能再来一次」，
   * 只测一次失败是看不出来的。
   */
  it("上游抛错之后，同一把 key 隔过最小间隔还能再验 —— release 不在 finally 里的话这颗按钮从此再也点不动", async () => {
    let t = NOW;
    const { app, repo } = await makeApp(
      // 第一次真的 `throw`（第 2 种假阳性：错误 stub 从不真 throw），第二次成功。
      [{ throws: new Error("connect ECONNREFUSED") }, { status: 200, body: "{}" }],
      ["sk-verify-release-0001"], {}, () => t,
    );
    const id = await idOf(repo, "sk-verify-release-0001");

    expect(await (await verify(app, id)).json()).toMatchObject({ ok: false, reason: "network_error" });

    t = NOW + 3_000;
    const again = await verify(app, id);
    // 429 而不是 200 ⇒ 这个 kind 还卡在「在飞」，也就是上一次的 release 没跑。
    expect(again.status, "上一次抛错把这个 kind 永久卡在了「在飞」").toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, status: 200 });
  });

  it("上游抛错之后，同一条通道隔过最小间隔还能再测 —— 通道测试那一半的同一条 release 纪律", async () => {
    let t = NOW;
    const storage = new MemoryStorage(undefined, () => t);
    let fail = true;
    const wiring: RegistrarWiring = {
      storage,
      tend: async () => {},
      probeChannel: async () => {
        if (fail) throw new Error("上游不可达");
        return { ok: true, domains: 2 };
      },
    };
    const { app } = await makeApp(
      [], [], { registrar: BOTH_CHANNELS }, () => t, { storage, registrar: wiring },
    );

    expect(await (await testChannel(app, "yyds")).json()).toMatchObject({ ok: false, reason: "upstream_error" });

    fail = false;
    t = NOW + 3_000;
    const again = await testChannel(app, "yyds");
    expect(again.status, "上一次抛错把这条通道永久卡在了「在飞」").toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, domains: 2 });
  });

  it("被 429 挡住的通道测试一次上游探测都不发 —— 判据是执行体被调了几次，不是状态码", async () => {
    let t = NOW;
    const storage = new MemoryStorage(undefined, () => t);
    const probes: string[] = [];
    const wiring: RegistrarWiring = {
      storage,
      tend: async () => {},
      probeChannel: async (channel) => { probes.push(channel); return { ok: true, domains: 1 }; },
    };
    const { app } = await makeApp(
      [], [], { registrar: BOTH_CHANNELS }, () => t, { storage, registrar: wiring },
    );

    expect((await testChannel(app, "yyds")).status).toBe(200);
    expect((await testChannel(app, "yyds")).status).toBe(429);
    expect(probes, "被 429 的那一次还是真的去探了一遍上游").toEqual(["yyds"]);
  });
});
