import { describe, it, expect, vi, afterEach } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { PROBE_MIN_INTERVAL_MS } from "../../src/http/admin/probe-guard.js";
import { KIND } from "../../src/http/admin/handlers/model-test.js";
import { MODEL_CATALOG } from "../../src/core/admin/protocol-catalog.js";

/**
 * `POST /admin/api/models/:id/test` —— 逐模型连通性矩阵里的一格。
 *
 * ⚠️ 这份文件头原来写着「contract ⇒ node 与 workerd 各跑一遍」，v0.4.0 之后只剩一份配置。
 *
 * ── 观测点的纪律，与 `admin-verify.test.ts` / `admin-upstream-models.test.ts` 同一条 ──
 * 响应里的 `ok` / `status` / `reason` **全是 handler 自报**，拿它们做判据只能证明
 * handler 说了什么。所以下面每一格的观测点尽量落在：
 * · **桩 fetcher 收到了什么**（URL、`authorization`、请求体里的 `model`、发了几次）；
 * · **存储被动了几次**（`CountingStorage` 的 put / delete）。
 * 唯一的例外是「上游正文不许回给面板」那一格——它必须看整段响应体文本。
 */

const NOW = 20_000 * 86_400_000;
const withKey = { "x-admin-key": TEST_ADMIN_TOKEN };

afterEach(() => { vi.useRealTimers(); });

/** 出站的上游 URL。**手写字面量**，不是 `agnesBaseUrl + upstreamPath` 拼出来的。 */
const UPSTREAM_URL = "https://upstream.test/v1/chat/completions";

/** 目录里第一条与第二条**对话**模型。两条不同的 id 是护栏那一格的支点。 */
const CHAT_A = "agnes-2.0-flash";
const CHAT_B = "agnes-2.5-flash";
/** 目录里的图片 / 视频模型各一条。 */
const IMAGE = "agnes-image-2.1-flash";
const VIDEO = "agnes-video-v2.0";

const call = (app: Awaited<ReturnType<typeof makeApp>>["app"], id: string) =>
  app.request(`/admin/api/models/${id}/test`, { method: "POST", headers: withKey });

describe("打的是哪一条、拿的是哪一把、带的是哪个模型", () => {
  /**
   * 被守护的性质：**这条端点是「逐模型」的——变的只有请求体里那格 `model`。**
   *
   * ⚠️ 判据落在**桩收到的请求体**上，不是响应里的自报字段：handler 说自己测了
   * 哪个模型，与它真的把哪个模型名发出去，是两件事。
   */
  it.each([[CHAT_A], [CHAT_B]])(
    "测 %s：出站打的是上游对话路径，带的是池里那把 key，请求体里的 model 就是它",
    async (id) => {
      const { app, fetcher } = await makeApp(
        [{ status: 200, body: "{}" }], ["sk-model-test-0001"], {}, () => NOW,
      );

      await call(app, id);

      expect(fetcher.sentUrls, "出站打的不是上游那条对话路径").toEqual([UPSTREAM_URL]);
      expect(fetcher.usedKeys, "出站带的不是池里那把 key").toEqual(["sk-model-test-0001"]);
      expect(JSON.parse(fetcher.sentBodies[0] ?? "{}"), "请求体里的 model 不是被测的那一个")
        .toMatchObject({ model: id });
    },
  );

  /**
   * 被守护的性质：**池里一把可用的 key 都没有时，一次出站都不许发生。**
   *
   * ⚠️ 判据是「**能不能选出一把**」而不是「池子长不长」：一池全被停用 / 全在冷却时
   * 长度不为 0 而一把都用不了，这两种状态在这条端点上是同一件事。
   * 第二个 case 就是那一半（把 `selectKey()` 换成「长度为 0 就 null」时它当场红）。
   */
  it.each([
    ["池子是空的", [] as string[], (_r: unknown) => {}],
    ["池里那把被停用了", ["sk-model-test-disabled-1"], (r: { disabled: boolean }) => { r.disabled = true; }],
  ])("%s：一次出站都不发，回的是 no_key 而不是 500", async (_name, keys, mutate) => {
    const { app, repo, fetcher } = await makeApp([], keys, {}, () => NOW);
    for (const rec of await repo.all()) {
      const next = { ...rec };
      mutate(next as { disabled: boolean });
      await repo.save(next, rec);
    }

    const res = await call(app, CHAT_A);

    expect(fetcher.sentUrls, "一把都用不了却还是打了上游").toEqual([]);
    expect(res.status, "空池被当成故障回了 5xx").toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: null, reason: "no_key" });
  });
});

describe("硬边界：只测对话模型", () => {
  /**
   * 🔴 **这一组守的是那颗按钮不会变成自毁按钮。**
   *
   * 测一次图片模型 = **真生成一张图**；测一次视频模型 = **建一个任务 + 反复轮询**。
   * 两者都会真的花掉这个账号的生成额度，而**花出去就收不回来**。
   *
   * ⚠️ **判据的重心是「一次出站都没发生」**，不是那个 400：只断言状态码的话，
   * 一个「先打上游、再回 400」的坏实现照样绿，而额度已经烧掉了。
   */
  it.each([[IMAGE], [VIDEO]])(
    "%s ⇒ 400 modality_not_testable，而且一次出站都没发生（额度花出去就收不回来）",
    async (id) => {
      const { app, fetcher } = await makeApp(
        [{ status: 200, body: "{}" }], ["sk-model-test-media-1"], {}, () => NOW,
      );

      const res = await call(app, id);

      expect(fetcher.sentUrls, "媒体模型被真的打了一次上游 —— 那一次是真金白银").toEqual([]);
      expect(res.status).toBe(400);
      // 顶层 `reason`：调用方据它选文案，不解析中文 `message`。
      expect(await res.json()).toMatchObject({ reason: "modality_not_testable" });
    },
  );

  /**
   * **反向控制**：同一套夹具下对话模型是打得出去的。
   * 少了它，上面那两格在「这条端点对谁都不打上游」时同样是绿的。
   */
  it("反向控制：同一套夹具下对话模型确实打得出去 —— 否则上面那两格什么都没证明", async () => {
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: "{}" }], ["sk-model-test-control-1"], {}, () => NOW,
    );

    expect((await call(app, CHAT_A)).status).toBe(200);
    expect(fetcher.sentUrls).toEqual([UPSTREAM_URL]);
  });

  it("目录里没有的模型 ⇒ 404，而且一次出站都没发生", async () => {
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: "{}" }], ["sk-model-test-404-1"], {}, () => NOW,
    );

    const res = await call(app, "no-such-model");

    expect(fetcher.sentUrls).toEqual([]);
    expect(res.status).toBe(404);
  });

  /**
   * ⚠️ **护栏排在「这个模型真的能测」之后。**
   *
   * 一次注定 404 的调用不该消费一次最小间隔——那等于「点了一下、什么都没打，
   * 但接下来几秒不许再点」。顺序反了的话第二次会拿到 429 而不是 404。
   * ⚠️ **本条与 `admin-verify.test.ts` 那一格的理由只有一半相同**：那边的 kind 带
   * key id，顺序反了还会让任何人往护栏的 Map 里无限灌键；这边的 kind 是常量，
   * 灌不进第二个键，剩下的那一半（别白白烧掉一次间隔）仍然成立。
   */
  it("测一个不存在的模型：连着两次都是 404 而不是第二次 429", async () => {
    const { app } = await makeApp([], ["sk-model-test-404-2"], {}, () => NOW);

    expect((await call(app, "no-such-model")).status).toBe(404);
    expect((await call(app, "no-such-model")).status, "第二次成了 429 —— 护栏排到校验前面去了").toBe(404);
  });
});

/**
 * 🔴 **护栏的 kind 是常量，这一组就是那条决定的判据。**
 *
 * `admin-verify.test.ts` 那边守的是相反的一条（`verify:<id>`：验 A 把不许挡住验 B 把），
 * 因为那 20 把 key 是 20 个互不相干的对象。而这里恰恰**要**它们互相挡：
 * 逐模型测试串起来的每一次打的都是**同一个上游账号**，共用一个 kind 才等于
 * 「整轮测试有节流」，那就是扛上游边缘限流的那道闸。
 */
describe("护栏：整轮测试共用一个 kind，所以它们互相挡", () => {
  it("kind 是不带模型 id 的常量 —— 带 id 的话整道闸就不存在了", () => {
    expect(KIND).toBe("model-test");
    // 反向自检：它真的不含任何一个模型 id（这是「常量」这件事的可观测形态）。
    expect(MODEL_CATALOG.filter((m) => KIND.includes(m.id)), "kind 里混进了模型 id").toEqual([]);
  });

  /**
   * **两个不同的模型，第二次在最小间隔内被挡下。**
   *
   * ⚠️⚠️ **夹具必须用两个不同的模型 id**：同一个 id 连打两次在带 id 的 kind 下
   * **也**会被挡，那种夹具下「常量 kind」与「带 id 的 kind」完全不可观测
   *（本仓登记的第 5 种假阳性）。改成 `model-test:<id>` 时这一格当场变绿失守，
   * 正是它要拦的那个改动。
   */
  it("换一个模型立刻再测，仍然在最小间隔内被挡下 —— 每一次打的都是同一个上游账号", async () => {
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: "{}" }, { status: 200, body: "{}" }],
      ["sk-model-test-guard-1"], {}, () => NOW,
    );

    expect((await call(app, CHAT_A)).status).toBe(200);
    const second = await call(app, CHAT_B);

    expect(second.status, "换个模型就绕过了护栏 —— kind 多半带上了模型 id").toBe(429);
    expect(await second.json()).toMatchObject({ reason: "probe_cooldown" });
    // 真正要紧的那一半：被挡下的那一次**一个出站请求都没发生**。
    expect(fetcher.sentUrls, "被 429 挡下的那一次还是打了上游").toEqual([UPSTREAM_URL]);
  });

  /**
   * **隔过最小间隔之后能再测。** 它守的是 `release` 在 `finally` 里
   *（放在成功支末尾时，一次抛错的探测会让这个 kind 永久卡在「在飞」——
   * 而这条端点的 kind 是常量，卡住的是**整颗按钮**，不是某一行）。
   */
  it("上游抛错之后，隔过最小间隔还能再测 —— release 不在 finally 里的话整颗按钮从此点不动", async () => {
    let t = NOW;
    const { app, fetcher } = await makeApp(
      [{ throws: new Error("boom") }, { status: 200, body: "{}" }],
      ["sk-model-test-guard-2"], {}, () => t,
    );

    expect(await (await call(app, CHAT_A)).json()).toMatchObject({ reason: "network_error" });
    t += PROBE_MIN_INTERVAL_MS;
    const again = await call(app, CHAT_A);

    expect(again.status, "整颗按钮卡在「上一次还在飞」了").toBe(200);
    expect(fetcher.sentUrls.length, "第二次根本没打出去").toBe(2);
  });
});

describe("响应体：与验活同族，且一个字节的上游正文都不回", () => {
  /**
   * 被守护的性质：**上游 401 的响应正文一个字节都不回给面板。**
   *
   * 各家 API 的 401/403 错误体恰恰最爱回显 key 片段。断言的是**整段响应体文本**的
   * `not.toContain`，不是逐字段查——handler 将来多回一个字段时，逐字段查会静默漏掉。
   */
  it("上游 401 的正文一个字节都不回给面板 —— 那正是各家 API 最爱回显 key 片段的地方", async () => {
    const leak = "sk-leaked-fragment-in-model-test-body";
    const { app } = await makeApp(
      [{ status: 401, body: JSON.stringify({ error: { message: `无效的令牌 ${leak}` } }) }],
      ["sk-model-test-401-1"], {}, () => NOW,
    );

    const res = await call(app, CHAT_A);
    const text = await res.text();

    expect(text, "上游错误体被原样转给了面板").not.toContain(leak);
    expect(text, "上游错误体的任何一段都不许出现").not.toContain("无效的令牌");
    // 反向自检：它确实说了点什么（不是因为整段响应为空才没命中）。
    expect(JSON.parse(text)).toMatchObject({ ok: false, status: 401, reason: "upstream_error" });
  });

  /**
   * ⚠️ **`ok: true` 那一档的 `reason` 必须是 `null`**：面板先判 `reason` 再判 `ok`，
   * 成功时留一个非空 reason 会让那一行被读成失败。
   */
  it("上游 2xx ⇒ ok:true、status 是真状态码、reason 是 null", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: "{}" }], ["sk-model-test-ok-1"], {}, () => NOW,
    );

    expect(await (await call(app, CHAT_A)).json())
      .toMatchObject({ ok: true, status: 200, reason: null });
  });

  /**
   * 被守护的性质：**这条端点一个存储字段都不写。**
   *
   * 失败记 strike ⇒ 面板上把整份模型清单测一遍就能把一把好 key 打进长冷却；
   * 成功清 strike ⇒ 「重新导入即解封」那个后门换了个入口复发。
   * 理由全文在 `src/http/admin/handlers/verify.ts` 的约束 1，这里只钉住行为。
   */
  it("测完之后 storage 的 put / delete 计数都是 0 —— 失败记 strike 与成功清 strike 各自是一颗自毁按钮", async () => {
    const counting = new CountingStorage(new MemoryStorage(undefined, () => NOW));
    const { app } = await makeApp(
      [{ status: 401, body: "{}" }], ["sk-model-test-nowrite-1"], {}, () => NOW,
      { storage: counting },
    );
    counting.puts = 0;
    counting.deletes = 0;

    await call(app, CHAT_A);

    expect(counting.puts, "这条端点写了存储").toBe(0);
    expect(counting.deletes, "这条端点删了存储").toBe(0);
  });
});

describe("传输失败两档：响应头没来 / 根本连不上", () => {
  it("上游挂起时在 upstreamTimeoutMs（首字节档）处中止并回 timeout，不是同步档的两分钟", async () => {
    // ⚠️ **必须用真定时器语义**：handler 用的是**真** `setTimeout`，推进注入的
    // `deps.now()` 不会触发它 —— 拿递进假时钟去推，这一格会挂死到测试超时而不是变红。
    const { app } = await makeApp(
      // 60 秒远大于首字节档的 8 秒、又远小于同步档的 120 秒：
      // 取错档位时下面推到 8 秒**不会**中止 ⇒ 这一格红。
      [{ status: 200, body: "{}", delayMs: 60_000 }],
      ["sk-model-test-timeout-1"], { upstreamTimeoutMs: 8_000, upstreamSyncTimeoutMs: 120_000 },
      () => NOW,
    );

    vi.useFakeTimers();
    const pending = call(app, CHAT_A);
    await vi.advanceTimersByTimeAsync(8_000);
    const res = await pending;

    expect(res.status).toBe(200);
    // `status: null` 是这一档的一半：一个响应头都没到手，没有状态码可说。
    expect(await res.json()).toMatchObject({ ok: false, status: null, reason: "timeout" });
  });

  it("8 秒之前不中止 —— 否则上一格的 timeout 可能只是「它对任何延迟都超时」", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: "{}", delayMs: 7_999 }],
      ["sk-model-test-timeout-2"], { upstreamTimeoutMs: 8_000, upstreamSyncTimeoutMs: 120_000 },
      () => NOW,
    );

    vi.useFakeTimers();
    const pending = call(app, CHAT_A);
    await vi.advanceTimersByTimeAsync(7_999);
    const res = await pending;

    expect(await res.json()).toMatchObject({ ok: true, status: 200, reason: null });
  });

  it("连不上上游 ⇒ network_error，而且异常消息一个字都不进响应（里面可能带上游 URL 与栈帧）", async () => {
    const { app } = await makeApp(
      [{ throws: new Error("connect ECONNREFUSED upstream.test:443") }],
      ["sk-model-test-net-1"], {}, () => NOW,
    );

    const res = await call(app, CHAT_A);
    const text = await res.text();

    expect(text, "异常消息被原样搬进了响应").not.toContain("ECONNREFUSED");
    expect(JSON.parse(text)).toMatchObject({ ok: false, status: null, reason: "network_error" });
  });
});

describe("请求体：这条端点不收任何选项", () => {
  it("不带请求体放行 —— 面板与鉴权矩阵都是这么调它的", async () => {
    const { app } = await makeApp([{ status: 200, body: "{}" }], ["sk-model-test-body-1"], {}, () => NOW);
    expect((await call(app, CHAT_A)).status).toBe(200);
  });

  /**
   * ⚠️ **不静默忽略**：`{"model":"…"}` 这种「我以为能指定模型」的写法在宽松实现下是
   * 一次「点了、但完全没按你想的那样发生」的静默误操作，而面板会如实显示成功。
   */
  it("带了不认识的字段 ⇒ 400，而且一次出站都没发生", async () => {
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: "{}" }], ["sk-model-test-body-2"], {}, () => NOW,
    );

    const res = await app.request(`/admin/api/models/${CHAT_A}/test`, {
      method: "POST",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ model: "something-else" }),
    });

    expect(res.status).toBe(400);
    expect(fetcher.sentUrls).toEqual([]);
  });
});
