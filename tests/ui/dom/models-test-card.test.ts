import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle, type Harness } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { catalogPayload } from "../../../src/core/admin/protocol-catalog.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **「模型测试」那张卡的渲染行为。**
 *
 * `tests/ui/model-test.test.ts` 把取值判定与状态机测得很细，但那些判定**画没画出来、
 * 请求是怎么发出去的**，它一格都答不了——而这张卡最要紧的两条性质恰恰全在那一半：
 * · **串行发**（并发会当场撞上游的边缘限流，把整轮变成一片红）；
 * · **逐行更新**（一轮几十秒，中途不重画的话与一个挂死的面板长得一模一样）。
 * 本仓在模型板块上已经吃过一次同型的亏（那一次是「错误分支改成渲染一张空表，
 * 纯函数用例一条都不红」）。
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    await settle(40);

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

  it("整轮跑完之后每一行都说「通了」—— 否则上一格只证明了它发得出去", async () => {
    const h = await openModels(() => ({ status: 200, body: okBody }));

    runBtn(h).click();
    await settle(40);

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

    // 放第一条落地：第二条这才该出发。
    pending[0]!({ status: 200, body: okBody });
    await settle(8);

    expect(testCalls(h).length, "上一条回来了，下一条却没跟上").toBe(2);
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
    await settle(40);

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
    await settle(40);

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
    await settle(40);

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
