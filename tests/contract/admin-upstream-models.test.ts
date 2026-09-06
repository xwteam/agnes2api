import { describe, it, expect, vi, afterEach } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { PROBE_MIN_INTERVAL_MS } from "../../src/http/admin/probe-guard.js";
import { MODEL_CATALOG } from "../../src/core/admin/protocol-catalog.js";
import { UPSTREAM_MODELS_MAX } from "../../src/core/admin/upstream-models.js";

/**
 * `GET /admin/api/upstream/models` —— 拿池里的一把 key 去问上游「你现在有哪些模型」。
 *
 * **contract ⇒ node 与 workerd 各跑一遍**（`tests/global-setup.ts` 的 `POLICY` 强制）。
 *
 * ── 观测点的纪律，与 `admin-verify.test.ts` 同一条 ──────────────────────────
 * 响应里的 `ok` / `status` / `reason` **全是 handler 自报**，拿它们做判据只能证明
 * handler 说了什么。所以下面每一格的观测点尽量落在：
 * · **桩 fetcher 收到了什么**（URL、`authorization`、发了几次）；
 * · **存储被动了几次**（`CountingStorage` 的 put / delete）。
 * 只有两类例外，且都是刻意的：①「上游正文不许回给面板」那一格必须看整段响应体文本；
 * ② 差集那两格测的就是响应体里那份窄化结果本身（它是这条端点的产物，不是自报的状态）。
 */

const NOW = 20_000 * 86_400_000;
const withKey = { "x-admin-key": TEST_ADMIN_TOKEN };

// 假定时器只在传输失败那几格里开，收尾必须还原：漏了它会污染同文件后面的用例。
afterEach(() => { vi.useRealTimers(); });

/** 出站的上游 URL。**手写字面量**，不是 `agnesBaseUrl + UPSTREAM_MODELS_PATH` 拼出来的。 */
const UPSTREAM_URL = "https://upstream.test/v1/models";

const PATH = "/admin/api/upstream/models";
const call = (app: Awaited<ReturnType<typeof makeApp>>["app"]) =>
  app.request(PATH, { headers: withKey });

/** 上游那份 OpenAI 形状的清单。`ids` 里的每一条包一层 `{ id }`。 */
const listBody = (ids: readonly string[]) =>
  JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

describe("GET /admin/api/upstream/models —— 打的是哪一条、拿的是哪一把", () => {
  it("出站 URL 是 agnesBaseUrl 加上「列模型」那条上游路径，带的是池里那把 key", async () => {
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: listBody(["m-1"]) }], ["sk-upstream-models-0001"], {}, () => NOW,
    );

    await call(app);

    expect(fetcher.sentUrls, "出站打的不是「列模型」那条上游路径").toEqual([UPSTREAM_URL]);
    expect(fetcher.usedKeys, "出站带的不是池里那把 key").toEqual(["sk-upstream-models-0001"]);
  });

  /**
   * 被守护的性质：**池里一把可用的 key 都没有时，一次出站都不许发生。**
   *
   * ⚠️ 判据是「**能不能选出一把**」而不是「池子长不长」：一池全被停用 / 全在冷却时
   * 长度不为 0 而一把都用不了，这两种状态在这条端点上是同一件事。
   * 第二个 case 就是那一半——把 handler 里的 `selectKey()` 换成
   * `records.length === 0 ? null : records[0]`，它当场红（本任务变异实测）。
   */
  it.each([
    ["池子是空的", [] as string[], (_r: unknown) => {}],
    ["池里那把被停用了", ["sk-upstream-disabled-0001"], (r: { disabled: boolean }) => { r.disabled = true; }],
  ])("%s：一次出站都不发，回的是 no_key 而不是 500", async (_name, keys, mutate) => {
    const { app, repo, fetcher } = await makeApp([], keys, {}, () => NOW);
    for (const rec of await repo.all()) {
      const next = { ...rec };
      mutate(next as { disabled: boolean });
      await repo.save(next, rec);
    }

    const res = await call(app);

    expect(fetcher.sentUrls, "一把都用不了却还是打了上游").toEqual([]);
    expect(res.status, "空池被当成故障回了 5xx").toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: "no_key" });
  });

  /**
   * 被守护的性质：**上游 401 的响应正文一个字节都不回给面板。**
   *
   * 各家 API 的 401/403 错误体恰恰最爱回显 key 片段（`src/core/dispatcher.ts` 的
   * evict 分支为这件事专门丢弃过一个响应体）。断言的是**整段响应体文本**的
   * `not.toContain`，不是逐字段查——handler 将来多回一个字段时，逐字段查会静默漏掉。
   */
  it("上游 401 的正文一个字节都不回给面板 —— 那正是各家 API 最爱回显 key 片段的地方", async () => {
    const leak = "sk-leaked-fragment-in-upstream-error-body";
    const { app } = await makeApp(
      [{ status: 401, body: JSON.stringify({ error: { message: `无效的令牌 ${leak}` } }) }],
      ["sk-upstream-401-0001"], {}, () => NOW,
    );

    const res = await call(app);
    const text = await res.text();

    expect(text, "上游错误体被原样转给了面板").not.toContain(leak);
    expect(text, "上游错误体的任何一段都不许出现").not.toContain("无效的令牌");
    // 反向自检：它确实说了点什么（不是因为整段响应为空才没命中）。
    expect(JSON.parse(text)).toMatchObject({ ok: false, status: 401, reason: "upstream_error" });
  });

  it("上游回的不是那个形状时是 bad_payload，不是把它当成「上游一个模型都没有」", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: JSON.stringify({ models: ["m-1"] }) }], ["sk-up-shape-0001"], {}, () => NOW,
    );

    expect(await (await call(app)).json()).toMatchObject({ ok: false, reason: "bad_payload" });
  });

  /**
   * 被守护的性质：**两个方向的差集都要给，而且都是从真源现算的。**
   *
   * 夹具刻意让上游回「目录里的第一条 + 一条目录里没有的」：
   * · 只回目录里全部四条 ⇒ `onlyUpstream` 恒空，那一半不可观测；
   * · 只回目录外的 ⇒ `onlyCatalog` 恒等于整份目录，与「差集算错了」长得一样。
   */
  it("差集两个方向都给：上游多出来的、目录里有而这次上游没回的", async () => {
    const first = MODEL_CATALOG[0]!.id;
    const { app } = await makeApp(
      [{ status: 200, body: listBody([first, "brand-new-upstream-model"]) }],
      ["sk-up-diff-0001"], {}, () => NOW,
    );

    const body = await (await call(app)).json() as {
      ok: boolean; models: { ids: string[]; onlyUpstream: string[]; onlyCatalog: string[] };
    };

    expect(body.ok).toBe(true);
    expect(body.models.ids).toEqual([first, "brand-new-upstream-model"]);
    expect(body.models.onlyUpstream).toEqual(["brand-new-upstream-model"]);
    expect(body.models.onlyCatalog, "「目录有而上游没回」是从 MODEL_CATALOG 现算的")
      .toEqual(MODEL_CATALOG.map((m) => m.id).filter((id) => id !== first));
  });

  /**
   * 被守护的性质：**上限之外的那些被如实交代，不是静默丢掉。**
   * 静默丢的后果是运维以为上游就这些模型——那是一句面板凭空说出来的话。
   */
  it("上游回的条数超过上限时截断，并把 truncated 交出来", async () => {
    const many = Array.from({ length: UPSTREAM_MODELS_MAX + 3 }, (_v, i) => `m-${i}`);
    const { app } = await makeApp(
      [{ status: 200, body: listBody(many) }], ["sk-up-many-0001"], {}, () => NOW,
    );

    const body = await (await call(app)).json() as { models: { ids: string[]; truncated: boolean } };

    expect(body.models.ids).toHaveLength(UPSTREAM_MODELS_MAX);
    expect(body.models.truncated, "截断了却没说").toBe(true);
  });

  /**
   * 被守护的性质：**这条端点一个存储字段都不写。**
   *
   * 失败记 strike / 成功清 strike 各自是一颗自毁按钮（理由逐字见
   * `src/http/admin/handlers/verify.ts` 的约束 1）；连 Tier-1 的 `stats` 也不写——
   * `stats` 是真实流量的证据，掺进人造探测就不再是证据。
   */
  it.each([
    ["成功", { status: 200, body: listBody(["m-1"]) }],
    ["上游 401", { status: 401, body: "{}" }],
  ])("%s 之后 storage 的 put / delete 计数都是 0", async (_name, outcome) => {
    const storage = new CountingStorage(new MemoryStorage(undefined, () => NOW));
    const { app } = await makeApp([outcome], ["sk-up-nowrite-0001"], {}, () => NOW, { storage });
    // 建 app 与灌夹具那几次写不算在这一格头上：观测窗口从这里开始。
    const before = { put: storage.puts, del: storage.deletes };

    await call(app);

    expect({ put: storage.puts - before.put, del: storage.deletes - before.del })
      .toEqual({ put: 0, del: 0 });
  });

  /**
   * 被守护的性质：**它与验活共用同一把护栏，但用的是自己的 kind。**
   *
   * 共用一把是全局约束 14 的落点；kind 不同则保证「刚验过一把 key」不会把这颗按钮
   * 一起挡掉。两句话各由一格看着：这一格看「连打两次被挡」，下一格看「验活不挡它」。
   */
  it("最小间隔之内连打两次，第二次被挡且一次出站都不发", async () => {
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: listBody(["m-1"]) }, { status: 200, body: listBody(["m-1"]) }],
      ["sk-up-guard-0001"], {}, () => NOW,
    );

    expect((await call(app)).status).toBe(200);
    const second = await call(app);

    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ reason: "probe_cooldown" });
    expect(fetcher.sentUrls, "被挡住的那一次还是打了上游").toHaveLength(1);
  });

  it("刚验过一把 key 不会把这颗按钮一起挡掉 —— 两条端点的 kind 不相交", async () => {
    let t = NOW;
    const { app, repo, fetcher } = await makeApp(
      [{ status: 200, body: "{}" }, { status: 200, body: listBody(["m-1"]) }],
      ["sk-up-kind-0001"], {}, () => t,
    );
    const id = (await repo.all())[0]!.id;

    expect((await app.request(`/admin/api/keys/${id}/verify`, { method: "POST", headers: withKey })).status)
      .toBe(200);
    // **不推进时钟**：推进了就分不清「kind 不相交」与「间隔已经过去」。
    expect((await call(app)).status, "验活把列模型那颗按钮一起挡掉了").toBe(200);
    expect(fetcher.sentUrls, "两次出站应当都真的发生了").toHaveLength(2);

    // 反向自检：同一个 kind 上的第二次确实会被挡，过了最小间隔又放行。
    expect((await call(app)).status).toBe(429);
    t = NOW + PROBE_MIN_INTERVAL_MS + 1;
    expect((await call(app)).status).toBe(200);
  });
});

/**
 * 🔴 **回填两条评审发现（本轮）。**
 *
 * 发现 A：`timeout` / `network_error` 两条分支在这条端点上**一格判据都没有**
 *（同族的 `admin-verify.test.ts:322` / `:347` 早有现成先例）。面板那一侧为它们各发了
 * 一档卡面文案，却没有任何东西证明后端真的产得出它们 —— DOM 那一格喂的是手写夹具。
 *
 * 发现 B：**读正文期间断流 / 超时被说成了 `bad_payload`**。原来那一句是
 * `parseUpstreamModels(await res.json().catch(() => null))`：`res.json()` reject 被
 * `.catch` 吞成 `null` ⇒ 与「上游回的形状不对」走同一个出口。可这两件事一件关于
 * **那份内容**、一件关于**我们压根没拿到那份内容**，运维的处置也因此完全不同
 *（核对两边版本 / 抬超时档 · 查链路）。
 *
 * ⚠️⚠️ **但它也不能改回 `timeout` / `network_error`**（评审建议的修法，实测为假）：
 * 那两句文案逐字是**响应头阶段**的话 —— `models.up.timeout` 说「在超时档内没有拿到
 * 响应头」、`models.up.networkError` 说「这次请求没有拿到任何响应」。响应头明明
 * 已经带着 200 落地了，把它说成这两句，是拿一句假话换掉另一句假话。
 * ⇒ 正文阶段是**第三档**，它有自己的 `body_incomplete` 与自己那一句。
 */
describe("传输失败分三档：响应头没来 / 正文没来 / 根本连不上 —— 三句话不许混成一句", () => {
  it("上游挂起时在 upstreamTimeoutMs（响应头档）处中止并回 timeout，不是同步档的两分钟", async () => {
    // ⚠️ **必须用真定时器语义**：handler 用的是**真** `setTimeout`，推进注入的
    // `deps.now()` 不会触发它 —— 拿递进假时钟去推，这一格会挂死到测试超时而不是变红。
    // 理由逐字见 `tests/contract/admin-verify.test.ts`「上游挂起时在 upstreamTimeoutMs（首字节档）处中止并回 timeout，不是同步档的两分钟」。
    const { app, fetcher } = await makeApp(
      // 60 秒远大于响应头档的 8 秒、又远小于同步档的 120 秒：
      // 取错档位（`upstreamSyncTimeoutMs`）时下面推到 8 秒**不会**中止 ⇒ 这一格红。
      [{ status: 200, body: listBody(["m-1"]), delayMs: 60_000 }],
      ["sk-up-timeout-0001"], { upstreamTimeoutMs: 8_000, upstreamSyncTimeoutMs: 120_000 },
      () => NOW,
    );

    vi.useFakeTimers();
    const pending = call(app);
    await vi.advanceTimersByTimeAsync(8_000);
    const res = await pending;

    expect(res.status).toBe(200);
    // `status: null` 是这一档的一半：一个响应头都没到手，没有状态码可说。
    expect(await res.json()).toMatchObject({ ok: false, status: null, reason: "timeout" });
    expect(fetcher.sentUrls, "反向自检：出站确实发生过一次").toEqual([UPSTREAM_URL]);
  });

  it("8 秒之前不中止 —— 否则上一格的 timeout 可能只是「它对任何延迟都超时」", async () => {
    const { app } = await makeApp(
      // 7999 < 8000：这一次必须**成功**。
      [{ status: 200, body: listBody(["m-1"]), delayMs: 7_999 }],
      ["sk-up-timeout-0002"], { upstreamTimeoutMs: 8_000, upstreamSyncTimeoutMs: 120_000 },
      () => NOW,
    );

    vi.useFakeTimers();
    const pending = call(app);
    await vi.advanceTimersByTimeAsync(7_999);
    const res = await pending;

    expect(await res.json()).toMatchObject({ ok: true, status: 200, reason: null });
  });

  it("出站抛错时 reason 是机器可读的 code，不是异常消息 —— 异常消息里同样可能带着这把 key", async () => {
    const KEY = "sk-up-throw-canary-4f10c2";
    const { app } = await makeApp(
      // **让桩真的 `throw`**：错误 stub 从不真 throw 是本仓登记过的一种假阳性。
      // 消息里刻意塞进那把 key：真实的连接错误常把整条请求信息带出来。
      [{ throws: new Error(`connect ECONNREFUSED while sending Bearer ${KEY} to upstream`) }],
      [KEY], {}, () => NOW,
    );

    const text = await (await call(app)).text();

    expect(JSON.parse(text)).toMatchObject({ ok: false, status: null, reason: "network_error" });
    expect(text, "异常消息被原样塞进了响应").not.toContain(KEY);
    expect(text, "异常消息被原样塞进了响应").not.toContain("ECONNREFUSED");
  });

  /**
   * 被守护的性质：**响应头到手之后正文才断的那一档，说的是「我们没拿到那份内容」，
   * 不是「那份内容我们看不懂」。**
   *
   * ⚠️ 这一格与上面那格 `timeout` 的差别全在 `status`：这里响应头带着 **200** 落过地，
   * 所以 `status` 是 200 而不是 `null`。改成 `reason: "timeout"` 的话面板会说
   *「在超时档内没有拿到响应头」—— 而它明明拿到了，那是评审建议的修法里的一处硬伤。
   */
  it("响应头 200 已经落地、正文却永不落地 ⇒ body_incomplete，不是 bad_payload", async () => {
    const { app } = await makeApp(
      [{ status: 200, bodyNeverLands: true, delayMs: 0 }],
      ["sk-up-body-hang-0001"], { upstreamTimeoutMs: 8_000, upstreamSyncTimeoutMs: 120_000 },
      () => NOW,
    );

    vi.useFakeTimers();
    const pending = call(app);
    await vi.advanceTimersByTimeAsync(8_000);
    const body = await (await pending).json();

    expect(body).toMatchObject({ ok: false, status: 200, reason: "body_incomplete" });
  });

  it("正文中途断流 ⇒ 同样是 body_incomplete —— 没超时也不该被说成「内容看不懂」", async () => {
    const { app } = await makeApp(
      [{
        status: 200,
        // 一块都没吐就 error：真实的「连接在正文中途断了」。
        body: new ReadableStream<Uint8Array>({
          start(c) { c.error(new Error("connection reset while reading body")); },
        }),
      }],
      ["sk-up-body-reset-0001"], {}, () => NOW,
    );

    const text = await (await call(app)).text();

    expect(JSON.parse(text)).toMatchObject({ ok: false, status: 200, reason: "body_incomplete" });
    expect(text, "断流的异常消息被原样塞进了响应").not.toContain("connection reset");
  });

  /**
   * 反向自检：上面两格把 `bad_payload` 整个吞掉的话它们全都还是绿的。
   * 这一格钉住「正文**完整到手**、只是形状不对」那一档仍旧是 `bad_payload`。
   */
  it("正文完整到手、只是形状不对时仍然是 bad_payload —— 上面两格没有把这一档一起吞掉", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: JSON.stringify({ data: [{ name: "没有 id 这个字段" }] }) }],
      ["sk-up-still-bad-0001"], {}, () => NOW,
    );

    expect(await (await call(app)).json())
      .toMatchObject({ ok: false, status: 200, reason: "bad_payload" });
  });

  /**
   * 🔴 **回填一条评审发现：上一格的反向自检只覆盖了「JSON 解得开、形状不对」，
   * 漏掉了「JSON 压根解不开」。**
   *
   * `res.json()` 是 `text()` 之后 `JSON.parse()`，**两个阶段的失败落在同一个
   * `catch` 里**。于是「正文完整落地、但它不是 JSON」被说成了 `body_incomplete`，
   * 而那句文案逐字是「正文却没有完整落地（**超时或中途断流**）」
   *（`admin-ui/js/i18n-dict.js` 的 `models.up.bodyIncomplete`）——
   * 这一档正文一个字节都没少，超时没发生、断流也没发生。
   *
   * ⇒ 上一轮修的是「拿一件**传输失败**去冒充一句关于**那份内容**的话」，
   * 这一格钉住反方向：**不许拿一句传输失败去冒充一件关于那份内容的事**。
   * 中间代理回 HTML 错误页 / 网关登录页这一类，在真实链路上比「正文读到一半 reset」
   * 常见得多，而 `bad_payload` 那句「上游回了，但那份内容本网关看不懂」对它逐字成立
   * ⇒ **不需要第四档，也不需要新增五语言 key**。
   *
   * 变异实测：把 handler 里 `text()` / `JSON.parse()` 那两个 try 并回一个
   *（即改回 `await res.json()`）⇒ 这一格当场红（收到 `body_incomplete`）。
   */
  it("正文完整落地、但它压根不是 JSON ⇒ bad_payload —— 传输没失败，不许说成正文没落地", async () => {
    const { app } = await makeApp(
      // 中间代理 / 网关最常见的那一种：200 带着一整页 HTML 错误页。
      [{ status: 200, body: "<html>upstream proxy error page</html>" }],
      ["sk-up-not-json-0001"], {}, () => NOW,
    );

    // `status: 200` 一并钉住：这一档响应头带着 200 落过地，不是 `timeout` 那个 `null`。
    expect(await (await call(app)).json())
      .toMatchObject({ ok: false, status: 200, reason: "bad_payload" });
  });
});
