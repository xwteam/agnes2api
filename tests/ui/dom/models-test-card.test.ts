import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { bootPanel, settle, type Harness } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { catalogPayload } from "../../../src/core/admin/protocol-catalog.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **「模型测试」那张卡的渲染行为。**
 *
 * `tests/ui/model-test.test.ts` 把取值判定与状态机测得很细，但那些判定**画没画出来、
 * 请求是怎么发出去的**，它一格都答不了——而这张卡最要紧的三条性质恰恰全在那一半：
 * · **串行发**（并发会当场撞上游的边缘限流，把整轮变成一片红）；
 * · **两条之间隔满最小间隔**（后端那把护栏的 kind 是常量，零间隔时整轮里除了第一条
 *   全被我们**自己**的护栏 429 挡成「节流」——v0.3.0 的真实形态，见下面那一组）；
 * · **逐行更新**（一轮二十几秒，中途不重画的话与一个挂死的面板长得一模一样）。
 * 本仓在模型板块上已经吃过一次同型的亏（那一次是「错误分支改成渲染一张空表，
 * 纯函数用例一条都不红」）。
 *
 * ── ⚠️⚠️ **这份文件原来有一格断言的是生产的反面，本轮改写了它，写清为什么** ──────
 * 原来的假 fetch 对**每一次** test 调用都无条件回 200，于是「整轮跑完之后每一行都
 * 说『通了』」那一格是绿的——而同一份代码在线上跑出来的是 1 行「通了」+ 5 行
 *「被节流挡下了」。**那一格不是测得不够，是建在了一个替身才成立的世界上**：
 * 替身没有后端那把护栏，而护栏恰恰是这张卡的主要对手。
 * ⇒ 本轮**不删它**（「整轮跑得完」仍然是要守的话），而是给它换一个前提：
 * 整轮必须**推过那几段最小间隔**才跑得完（`runWholeRound()`），
 * 于是「零间隔」那一版**跑不到**这一格的终点。另外单独补一组直接把间隔本身断言出来。
 *
 * ── **替身能力核对（第 9 种假阳性）** ────────────────────────────────────────
 * `tests/ui/dom/fake-dom-parity.test.ts` 是权威表。这张卡用到的 DOM 成员是
 * `createElement` / `setAttribute` / `textContent` / `appendChild` /
 * `addEventListener` / `click()` / `.disabled`。
 * ⚠️⚠️ **`.disabled` 在 `KNOWN_BLIND_SPOTS` 里挂着（「`.disabled` 挂错宿主」）
 * ⇒ 本文件一格都不拿它当判据。** 「在飞时不许再起一轮」那一格的观测点落在
 * **出站条数**上，而那条不变量的实现也确实不是 `disabled`（是 `runTests()`
 * 开头那条早退）——两边对齐，别把按钮属性读成护栏。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;
/** EM DASH（U+2014）：`fmtDash(null)` 交出来的那一根。 */
const EM = "—";

/** 逐模型测试那条端点的前缀。**必须比目录那条更早匹配**，见 `openModels` 里那一句。 */
const TEST_PREFIX = "/admin/api/models/";
const TEST_SUFFIX = "/test";
const CATALOG = "/admin/api/models";

const isTestCall = (url: string) => url.startsWith(TEST_PREFIX) && url.split("?")[0]!.endsWith(TEST_SUFFIX);

/**
 * ⚠️ **假定时器必须在整轮开始**之前**装好，所以装在 `beforeEach` 里**（`bootPanel()`
 * 也在它之后）：`runTests()` 里那次 `setTimeout` 是在点下按钮之后排下的，装晚了就排在
 * 真实定时器上，`advanceTimersByTimeAsync()` 推的是另一条队列，整组会红成
 *「第二条没发出去」，而真正的原因是装置本身（`tests/ui/dom/keys-verify.test.ts` 的
 *「可用 / 在飞 / 刚探过：三种状态的 title 是三句不同的话，冷却到点后按钮自己恢复」
 * 那一格实测踩过一次，这里照它的做法）。
 * 只 fake `setTimeout` / `clearTimeout`：`Date.now()` 由 `bootPanel({ now })` 单独钉死，
 * 两者混在一起会让「本地时钟走到哪」这件事说不清楚。
 *
 * ⚠️ **`useRealTimers()` 同时是收尾**：一轮跑不完就结束的那几格会留下一颗还没到点的
 * 定时器，它一落地就会在夹具已经拆掉的世界里再发一次请求。切回真定时器把它丢掉。
 */
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Resp = { status: number; body: unknown };

/**
 * 打开模型板块。`/admin/api/models`（目录）交出**真源那一份**，
 * 逐模型测试那条由每一格自己给。
 *
 * ⚠️ **两条路径的判序不能反**：目录那条是 `/admin/api/models`，而测试那条是
 * `/admin/api/models/<id>/test` —— 后者**以前者为前缀**。先判目录的话，
 * 整轮测试的每一次都会拿到那份目录 JSON，而这一组会对着一堆 `mismatch` 报绿。
 */
async function openModels(onTest: (url: string) => Resp | Promise<Resp>): Promise<Harness> {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "models" },
    respond: (url: string) => {
      if (isTestCall(url)) return onTest(url);
      if (url.startsWith(CATALOG)) return { status: 200, body: catalogPayload() };
      return { status: 200, body: {} };
    },
  });
  await settle(12);
  return h;
}

/** 那颗「全部测一遍」按钮。 */
function runBtn(h: Harness): FakeElement {
  const out: FakeElement[] = [];
  for (const b of h.section("models").querySelectorAll(".models-test-btn")) out.push(b);
  expect(out, "那颗按钮不在屏幕上").toHaveLength(1);
  return out[0]!;
}

/** 测试表里每一行的 `data-model`，按 DOM 顺序。 */
function rowModels(h: Harness): string[] {
  const out: string[] = [];
  for (const r of h.section("models").querySelectorAll(".models-test-row")) {
    out.push(r.getAttribute("data-model") ?? "");
  }
  return out;
}

/** 测试表里每一行的 `data-state`，按 DOM 顺序。 */
function rowStates(h: Harness): string[] {
  const out: string[] = [];
  for (const r of h.section("models").querySelectorAll(".models-test-row")) {
    out.push(r.getAttribute("data-state") ?? "");
  }
  return out;
}

/** 这一轮往逐模型测试那条端点发过的 URL，按发送顺序。 */
function testCalls(h: Harness): string[] {
  return h.calls.filter((c) => isTestCall(c.url)).map((c) => c.url);
}

/** 一份「通了」的应答。 */
const okBody = { ok: true, status: 200, latencyMs: 42, reason: null };

/**
 * 把一轮**推到底**：每一条落地之后还要推过那一段最小间隔，下一条才发得出去。
 *
 * ⚠️ **`3_000` 手写字面量，不从被测常量算**（第 6 种假阳性：拿被测对象去算期望值，
 * 两边一起错时一声不吭）。它与后端 `PROBE_MIN_INTERVAL_MS` 的相等由
 * `tests/ui/model-test.test.ts` 的
 * 「整轮的最小间隔与后端 PROBE_MIN_INTERVAL_MS、与 Key 池验活那一份是同一个数」那一格钉着。
 *
 * ⚠️ **它本身不是判据，是前提**：判据是下面那一组直接钉「隔没隔满」的用例。
 * 这里多推几轮无害（推到没有定时器时 `advanceTimersByTimeAsync` 就是空转），
 * 但**少推一轮整轮就跑不完** —— 那正是零间隔那一版跑不到终点的原因。
 */
async function runWholeRound(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await settle(12);
    await vi.advanceTimersByTimeAsync(3_000);
  }
  await settle(12);
}

describe("还没测过那一档", () => {
  /**
   * ⚠️ **「还没测过」与「测过了、一行都没通」是两句话。**
   * 画一张空表 / 画一排失败都会让运维去查一条根本没发生过的故障。
   * 这一档画的是一根破折号加**一句看得见的话**（不是 hover 才出来的 `title`）。
   */
  it("一进板块就有那张卡：一颗按钮 + 一根 EM DASH + 一句「还没测过」，一次出站都没有", async () => {
    const h = await openModels(() => ({ status: 200, body: okBody }));

    expect(testCalls(h), "还没点就打了上游 —— 这张卡不许挂在 onShow 上").toEqual([]);
    expect(rowModels(h), "还没测过却画出了表").toEqual([]);
    const text = h.section("models").textContent;
    expect(text).toContain(EM);
    expect(text).toContain("还没测过");
    // 反向自检：那颗按钮真的在（否则上面两条在「整张卡都没画」时同样成立）。
    expect(runBtn(h).textContent).toContain("全部测一遍");
  });
});

describe("哪些模型进这一轮", () => {
  /**
   * 🔴 **这一格守的是那颗按钮不会变成自毁按钮。**
   * 测一次图片模型 = 真生成一张图，测一次视频模型 = 建任务 + 反复轮询。
   * 判据落在**真的发出去的 URL 上**，不落在表里画了几行：先发后筛照样烧额度。
   */
  it("只测目录里的六个对话模型：三个图片、三个视频模型一次都没被打", async () => {
    const h = await openModels(() => ({ status: 200, body: okBody }));

    runBtn(h).click();
    await runWholeRound();

    // 手写期望值：真源的对话模型逐条列出来，**不是从 catalogPayload() 推导的**。
    expect(rowModels(h)).toEqual([
      "agnes-2.0-flash", "agnes-2.5-flash", "agnes-2.5-pro",
      "agnes-2.5-pro-alpha", "agnes-2.5-pro-beta", "agnes-3.0-flash",
    ]);
    expect(testCalls(h)).toEqual([
      "/admin/api/models/agnes-2.0-flash/test",
      "/admin/api/models/agnes-2.5-flash/test",
      "/admin/api/models/agnes-2.5-pro/test",
      "/admin/api/models/agnes-2.5-pro-alpha/test",
      "/admin/api/models/agnes-2.5-pro-beta/test",
      "/admin/api/models/agnes-3.0-flash/test",
    ]);
    expect(testCalls(h).filter((u) => u.includes("image") || u.includes("video")),
      "媒体模型被真的打了 —— 那一次是真金白银").toEqual([]);
    expect(rowStates(h)).toEqual(["done", "done", "done", "done", "done", "done"]);
  });

  /**
   * ⚠️⚠️ **这一格的前提本轮换过，见文件头那一段**：原来是「点一下、抽几轮微任务、
   * 整轮就跑完了」，那个前提只在**没有护栏的替身世界**里成立，线上是 5 行节流。
   * 现在整轮必须**推过那几段最小间隔**才跑得完 ⇒ 零间隔那一版跑不到这一格的终点。
   * 断言本身没有放宽（仍然是「六行全 done 且都说通了」）。
   */
  it("整轮跑完之后每一行都说「通了」—— 否则上一格只证明了它发得出去", async () => {
    const h = await openModels(() => ({ status: 200, body: okBody }));

    runBtn(h).click();
    await runWholeRound();

    expect(rowStates(h), "整轮没跑到底 —— 前置条件没成立，下面那条 toContain 说明不了什么")
      .toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(h.section("models").textContent).toContain("通了：上游用这个模型正常回了一次");
  });
});

describe("🔴 串行发，不并发", () => {
  /**
   * 🔴 **这是这张卡最要紧的一条不变量。**
   * 并发会当场撞上游的边缘限流（约 2 次快请求就被挡），把整轮变成一片红，
   * 而那片红说的是「被限流了」不是「模型不通」——运维读到的每一格都是假的。
   *
   * ⚠️ **判据是「上一条没回来之前，第二条根本没发出去」**，不是「最后一共发了 6 条」：
   * 后者对并发实现同样成立（`Promise.all` 也会发满 6 条）。
   */
  it("上一条没回来之前，第二条不许发出去", async () => {
    const pending: Array<(r: Resp) => void> = [];
    const h = await openModels(() => new Promise<Resp>((resolve) => { pending.push(resolve); }));

    runBtn(h).click();
    await settle(8);

    expect(testCalls(h).length, "并发发出去了 —— 一轮下来会当场撞上游的限流").toBe(1);
    expect(testCalls(h)[0]).toBe("/admin/api/models/agnes-2.0-flash/test");

    // 放第一条落地。⚠️ **它落地并不等于第二条马上就发**：中间还隔着一段最小间隔
    //（见下一组）。这一格只要「回来之前不发」，所以这里连着把间隔也推过去，
    // 免得把两条不同的不变量混在一格里。
    pending[0]!({ status: 200, body: okBody });
    await settle(8);
    await vi.advanceTimersByTimeAsync(3_000);
    await settle(8);

    expect(testCalls(h).length, "上一条回来了、间隔也隔满了，下一条却没跟上").toBe(2);
    expect(testCalls(h)[1]).toBe("/admin/api/models/agnes-2.5-flash/test");
  });

  /**
   * 🔴 **逐行更新：不许等整轮跑完再一次性渲染。**
   * 一轮几十秒，中途不重画的话运维在那几十秒里看不到任何进展，
   * 与一个挂死的面板长得一模一样。
   *
   * ⚠️ **三种状态必须在同一次观测里同时出现**：只看「第一行 done」的话，
   * 一个「先把全部标成 done 再逐个发」的坏实现照样绿（第 5 种假阳性）。
   */
  it("跑到一半时三种状态同屏：第一行已回来、第二行正在测、其余还在待测", async () => {
    const pending: Array<(r: Resp) => void> = [];
    const h = await openModels(() => new Promise<Resp>((resolve) => { pending.push(resolve); }));

    runBtn(h).click();
    await settle(8);
    pending[0]!({ status: 200, body: okBody });
    await settle(8);
    // ⚠️ **这一句不是凑数**：第一行落定之后整轮先卡在那段最小间隔上，那几秒里
    //    **一行 active 都没有**（下一组专门钉那几秒屏幕上说了什么）。推过去才回到
    //    这一格要看的那一刻。
    await vi.advanceTimersByTimeAsync(3_000);
    await settle(8);

    expect(rowStates(h)).toEqual(["done", "active", "pending", "pending", "pending", "pending"]);
    const text = h.section("models").textContent;
    expect(text, "跑到一半时屏幕上没有「正在测」").toContain("正在测");
    expect(text, "跑到一半时屏幕上没有「待测」").toContain("待测");
  });

  /**
   * **在飞时不许再起一轮。**
   *
   * ⚠️ 观测点落在**出站条数**上，不落在按钮的 `.disabled` 上：那个属性在替身上是
   * 登记在案的盲点（见文件头）。这条不变量的实现也确实是 `runTests()` 开头那条早退
   * ——**变红条件**就是删掉它。
   */
  it("一轮还在跑的时候再点一下，不会另起一轮", async () => {
    const pending: Array<(r: Resp) => void> = [];
    const h = await openModels(() => new Promise<Resp>((resolve) => { pending.push(resolve); }));

    runBtn(h).click();
    await settle(8);
    runBtn(h).click();
    await settle(8);

    expect(testCalls(h).length, "在飞的时候又起了一轮 —— 两轮交错着打同一个上游账号").toBe(1);
    // 让它落地，别把状态卡死在「正在测」。
    pending[0]!({ status: 200, body: okBody });
    await settle(8);
  });
});

/**
 * 🔴🔴 **v0.3.0 的缺陷本身：整轮实际只测得到第一个模型。**
 *
 * 板块循环里**一个间隔都没有**，而后端那把护栏最小间隔 3 秒、kind 是常量（整轮互相挡）
 * ⇒ 线上实测整轮 **824ms** 跑完，6 行里 **5 行 `probe_cooldown`**：
 * 1 行「通了」+ 5 行「被节流挡下了，请稍后再测」。「稍后再测」还是死路：再点一次
 * 连第一行都在冷却窗口里。**那 5 行盖住的可能是真的不通的模型。**
 *
 * ⚠️ **判据只能落在「什么时候发出去的」上，落不到「回来的是什么」上**：
 * 这份替身里没有那把护栏（`tests/ui/dom/harness.ts` 的假 fetch 只按 url 回应答），
 * 所以「隔没隔满」在响应侧**完全不可观测**——那正是原来那一格能一路绿着的原因。
 */
describe("🔴 两条之间隔满最小间隔（不隔的话整轮只测得到第一个模型）", () => {
  /**
   * **变红条件（本任务变异实测）**：把 `runTests()` 里那三行
   *（`nextTestDelayMs` + `waiting` + `await sleep(delay)`）删回去 ⇒
   * 第二格「还没隔满就发了第二条」当场红成 `expected 6 to be 1`
   *（六条在同一轮微任务里全发完了，正是线上那个形态）。
   *
   * ⚠️ **两侧都要断，只断一侧不行**：只断「2999 毫秒时还没发」的话，一个「干脆不发了」
   * 的实现照样绿；只断「3000 毫秒时发了」的话，零间隔那一版**也**是绿的
   *（它早就发过了）。
   */
  it("两条请求之间真的隔满了最小间隔 —— 零间隔时后面每一条都被我们自己的护栏挡成节流", async () => {
    const h = await openModels(() => ({ status: 200, body: okBody }));

    runBtn(h).click();
    await settle(12);
    expect(testCalls(h).length, "第一条都没发出去 —— 前置条件没成立").toBe(1);

    // 边界值**手写字面量**（第 6 种假阳性），不写成 `TEST_MIN_INTERVAL_MS - 1`。
    await vi.advanceTimersByTimeAsync(2_999);
    await settle(12);
    expect(testCalls(h).length,
      "还没隔满最小间隔就发了下一条 —— 线上它会被我们自己的护栏 429 挡成一句「节流」").toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await settle(12);
    expect(testCalls(h).length, "隔满了却没发下一条 —— 整轮停在这里，后面五个模型永远没有答案").toBe(2);
    expect(testCalls(h)[1], "发的不是清单里的下一个模型").toBe("/admin/api/models/agnes-2.5-flash/test");
  });

  /**
   * 🔴 **加了间隔就必须把「为什么慢」说出来。**
   * 那几秒里**一条请求都没在飞、一行状态都不会变**（第二格直接钉这件事），
   * 屏幕上唯一能动的就是这颗按钮上的字。还写着「正在逐个测：1/6」的话，那句话
   * 在那几秒里是**假的**，而运维看到的是一个停在 1/6 不动的进度——与挂死不可区分。
   *
   * **变红条件（本任务变异实测）**：把 `testCard()` 里那一支
   *（`test.waiting ? "models.test.progressWaiting" : …`）改回只用 `models.test.progress`
   * ⇒ 第一条断言红成「按钮上没说在等什么」。
   *
   * ⚠️ **夹具用一个永不落地的应答**：只有这样「在飞」与「在等间隔」这两刻才分得开
   *（同步应答下两者会在同一轮里连着发生，那一格就成了抛硬币）。
   */
  it("等间隔的那几秒里按钮说的是「在等节流」，不是一句停住不动的「正在逐个测」", async () => {
    const pending: Array<(r: Resp) => void> = [];
    const h = await openModels(() => new Promise<Resp>((resolve) => { pending.push(resolve); }));

    runBtn(h).click();
    await settle(12);
    // 反向自检：**真的在打**的那一刻写的是「正在逐个测」——否则下面那条 not.toContain 恒真。
    expect(runBtn(h).textContent, "在飞的那一刻按钮上就没说「正在逐个测」").toContain("正在逐个测");

    pending[0]!({ status: 200, body: okBody });
    await settle(12);

    const waiting = runBtn(h).textContent;
    expect(waiting, "在等间隔的那几秒里按钮上没说在等什么").toContain("在等节流");
    expect(waiting, "还写着「正在逐个测」—— 那几秒里一条请求都没在飞，那句话是假的")
      .not.toContain("正在逐个测");
    expect(waiting, "进度数没了 —— 运维看不出这一轮走到哪了").toContain("1/6");
    // 那几秒里确实一行 active 都没有：这正是「不说话就与挂死不可区分」的由来。
    expect(rowStates(h), "在等间隔时不该有任何一行是「正在测」")
      .toEqual(["done", "pending", "pending", "pending", "pending", "pending"]);
  });

  /**
   * **整轮要多久，事先就说出来。** 运维在第一段间隔里判断「它是不是卡住了」，
   * 靠的就是这句话；而这句话里的秒数不许在板块文件里另算一遍（硬规则 1）。
   *
   * **变红条件**：把 `testCard()` 里那段 `models.test.eta` 删掉，或者把
   * `testRoundMinSec()` 的 `n−1` 写成 `n`（那样这里会读到 18 秒）。
   */
  it("卡上事先说清整轮至少要多少秒 —— 六个模型五段间隔 = 至少 15 秒", async () => {
    const h = await openModels(() => ({ status: 200, body: okBody }));

    const text = h.section("models").textContent;
    expect(text, "卡上没有那句「整轮至少要多久」").toContain("至少要 15 秒");
    // 反向自检：这句话在**点之前**就在屏幕上（事后才说等于没说）。
    expect(testCalls(h), "前置条件：这一格一次出站都不该有").toEqual([]);
  });
});

describe("失败那几档画出来的是哪一句", () => {
  /**
   * ⚠️ **护栏的 429 与「上游出错了」是两件事**：被护栏挡下的那一次
   * **一个出站请求都没有发生过**，说成上游故障会让运维去查一条不存在的故障。
   * ⚠️ 判据是顶层 `reason` 而不是状态码：同一个 429 下护栏有两种拒绝。
   */
  it("护栏回 429 + probe_cooldown：那一行说的是节流，不是「上游出错了」", async () => {
    const h = await openModels(() => ({
      status: 429,
      body: { error: { type: "rate_limit_error", message: "稍后再试" }, reason: "probe_cooldown" },
    }));

    runBtn(h).click();
    await runWholeRound();

    const text = h.section("models").textContent;
    expect(text).toContain("被节流挡下了");
    expect(text, "把一次节流说成了上游故障").not.toContain("上游没有正常返回这个模型");
  });

  /**
   * ⚠️ **上游的错误正文一个字节都不会到面板**（后端只回状态码），
   * 所以这一档屏幕上该有的是那句话 + 「上游这次回的 HTTP 状态码」，
   * 而**不是**上游的错误体。
   */
  it("上游非 2xx：那一行说「上游没有正常返回」，并另起一句给出状态码", async () => {
    const h = await openModels(() => ({
      status: 200,
      body: { ok: false, status: 502, latencyMs: 88, reason: "upstream_error" },
    }));

    runBtn(h).click();
    await runWholeRound();

    const text = h.section("models").textContent;
    expect(text).toContain("上游没有正常返回这个模型");
    expect(text).toContain("502");
  });

  /**
   * ⚠️ **`latencyMs` 读不出来时画的是破折号，不是 0。**
   * 0 毫秒是一句关于链路的话，「后端没给这个数」是一句关于我们自己的话。
   */
  it("后端没给 latencyMs 时那一格是破折号，不是 0", async () => {
    const h = await openModels(() => ({
      status: 200,
      body: { ok: false, status: null, reason: "network_error" },
    }));

    runBtn(h).click();
    await runWholeRound();

    const cells: string[] = [];
    for (const r of h.section("models").querySelectorAll(".models-test-row")) {
      const tds: string[] = [];
      for (const td of r.querySelectorAll("td")) tds.push(td.textContent);
      cells.push(tds[tds.length - 1] ?? "");
    }
    expect(cells.length, "前置条件：表得真的画出来了").toBe(6);
    expect(new Set(cells), "没有值被伪造成了 0").toEqual(new Set([EM]));
  });
});
