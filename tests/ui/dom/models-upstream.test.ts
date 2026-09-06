import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle, type Harness } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { catalogPayload } from "../../../src/core/admin/protocol-catalog.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **「上游模型」那张卡的渲染行为。**
 *
 * `tests/ui/models.test.ts` 把取值判定测得很细，但那些判定**画没画出来**没有任何
 * 东西验证——本仓在模型板块上已经吃过一次同型的亏（那一次是「错误分支改成渲染
 * 一张空表，纯函数用例一条都不红」）。这一组补的就是那一半，覆盖六种表现：
 * 正常 / 空池 / 形状不对 / 上游 401 / 超时 / 截断，外加护栏那一档与两条结构性不变量。
 *
 * ── **替身能力核对（第 9 种假阳性）** ────────────────────────────────────────
 * `tests/ui/dom/fake-dom-parity.test.ts` 是权威表。本文件的**发货代码**（那张卡）
 * 用到的 DOM 成员是 `createElement` / `setAttribute` / `textContent` /
 * `appendChild` / `addEventListener` / `click()` / `.disabled`。
 * ⚠️⚠️ **`.disabled` 在 `KNOWN_BLIND_SPOTS` 里挂着（「`.disabled` 挂错宿主」）
 * ⇒ 本文件一格都不拿它当判据。** 「在飞时不许再发一条」那一格的观测点落在
 * **出站条数**上，而那条不变量的实现也确实不是 `disabled`（是 `loadUpstream()`
 * 开头那条早退）——两边对齐，别把按钮属性读成护栏。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;
/** EM DASH（U+2014）：`fmtDash(null)` 交出来的那一根。 */
const EM = "—";

const UP = "/admin/api/upstream/models";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 一份成功的上游应答。`models` 那四个字段一个不缺。 */
function okBody(models: {
  ids: string[]; truncated?: boolean; onlyUpstream?: string[]; onlyCatalog?: string[];
}) {
  return {
    ok: true, status: 200, latencyMs: 12, reason: null,
    models: {
      ids: models.ids, truncated: models.truncated ?? false,
      onlyUpstream: models.onlyUpstream ?? [], onlyCatalog: models.onlyCatalog ?? [],
    },
  };
}

/**
 * 打开模型板块。`/admin/api/models`（目录）默认交出**真源那一份**，
 * 上游那条由每一格自己给。
 */
async function openModels(
  upstream: (url: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
  catalog: { status: number; body: unknown } = { status: 200, body: catalogPayload() },
): Promise<Harness> {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "models" },
    respond: (url: string) => {
      if (url.startsWith(UP)) return upstream(url);
      if (url.startsWith("/admin/api/models")) return catalog;
      return { status: 200, body: {} };
    },
  });
  await settle(12);
  return h;
}

/** 那颗「向上游查一次」按钮。 */
function loadBtn(h: Harness): FakeElement {
  const found = h.section("models").querySelectorAll(".models-up-btn");
  const out: FakeElement[] = [];
  for (const b of found) out.push(b);
  expect(out, "那颗按钮不在屏幕上").toHaveLength(1);
  return out[0]!;
}

/** 某一组里的模型 id，按 DOM 顺序。`group` 是 `ids` / `onlyUpstream` / `onlyCatalog`。 */
function groupIds(h: Harness, group: string): string[] {
  const out: string[] = [];
  for (const g of h.section("models").querySelectorAll(`[data-group="${group}"]`)) {
    for (const s of g.querySelectorAll("[data-up-id]")) out.push(s.textContent);
  }
  return out;
}

/** 这一轮往上游那条端点发了几条。 */
function upCalls(h: Harness): number {
  return h.calls.filter((c) => c.url.startsWith(UP)).length;
}

/** 点一次那颗按钮并让异步落定。 */
async function clickLoad(h: Harness): Promise<void> {
  loadBtn(h).click();
  await settle(12);
}

/** 卡上那句结果文案（成功那一句 / 失败横幅那一句）。 */
function msg(h: Harness): string {
  const out: string[] = [];
  for (const s of h.section("models").querySelectorAll("[data-up=\"msg\"]")) out.push(s.textContent);
  return out.join(" | ");
}

describe("上游模型：还没查过 ≠ 上游一个模型都没有", () => {
  /**
   * **变红条件**：把 `upstreamCard()` 的 `idle` 那一支删掉、直接画一张空清单
   * ——那张空清单在屏幕上说的是「上游这次一个模型都没回」，而我们**根本没问过**。
   * 全局约束 9 禁的伪造不只是伪造 `0`，把「还没问」画成「问过了、是空的」是同一件事。
   *
   * 同一格顺带钉住**没有自动加载**：这条读会真打一次上游，挂在板块切换上等于
   * 每切一次就打一次，而运维根本没要求过。
   */
  it("刚打开时是一根 EM DASH 加一句「还没问过上游」，而且一次出站都没发生", async () => {
    const h = await openModels(() => ({ status: 200, body: okBody({ ids: ["never-asked"] }) }));

    expect(upCalls(h), "板块一打开就自己打了一次上游").toBe(0);
    const text = h.section("models").textContent;
    expect(text, "那根破折号不在屏幕上").toContain(EM);
    expect(text, "上游那份清单在没问过的时候就画出来了").not.toContain("never-asked");
  });

  /**
   * **变红条件**：把 `render()` 里那句 `host.appendChild(upstreamCard())` 挪进
   * `catalog !== null` 那一支。目录那条读与上游这条读没有任何依赖关系，
   * 绑在一起的后果是一次目录读失败连带把一个完全能用的功能藏起来，
   * 而屏幕上不会有任何东西说它去哪了。
   */
  it("目录读不出来时这张卡照在 —— 两条读没有依赖关系", async () => {
    const h = await openModels(
      () => ({ status: 200, body: okBody({ ids: ["m-1"] }) }),
      { status: 404, body: { error: { message: "not found" } } },
    );

    expect(h.section("models").textContent, "目录挂了就把上游那张卡一起藏了").toContain(EM);
    await clickLoad(h);
    expect(groupIds(h, "ids")).toEqual(["m-1"]);
  });
});

describe("上游模型：六种表现", () => {
  /**
   * **正常那一档：清单 + 两个方向的差集。**
   *
   * ⚠️ 夹具刻意让两个差集**都非空且互不相同**：任何一边为空时，
   * 「差集画错了位置」与「差集算对了」在屏幕上长得一样。
   */
  it("正常：列出上游回的 id，并把两个方向的差集各自成组画出来", async () => {
    const h = await openModels(() => ({
      status: 200,
      body: okBody({ ids: ["up-a", "up-b"], onlyUpstream: ["up-b"], onlyCatalog: ["cat-only"] }),
    }));

    await clickLoad(h);

    expect(upCalls(h)).toBe(1);
    expect(groupIds(h, "ids")).toEqual(["up-a", "up-b"]);
    expect(groupIds(h, "onlyUpstream"), "「上游多出来的」那一组画错了").toEqual(["up-b"]);
    expect(groupIds(h, "onlyCatalog"), "「目录有而上游没回」那一组画错了").toEqual(["cat-only"]);
  });

  /**
   * ⚠️⚠️ **这一格是本张卡存在的前提：它不许取代上面那份目录。**
   * 目录讲「本网关支持什么、拿哪条端点去调」，上游讲「上游此刻有什么」。
   * **变红条件**：让成功之后的 `render()` 不再画目录那张表（或者拿上游那份 id
   * 去喂 `buildTable()`）——那样整张矩阵与端点列会一起消失，
   * 而面板从此教不出任何一条能照抄的调用。
   */
  it("查完之后目录那张表原封不动 —— 上游清单不取代目录", async () => {
    const h = await openModels(() => ({ status: 200, body: okBody({ ids: ["up-a"] }) }));
    const before: string[] = [];
    for (const tr of h.section("models").querySelectorAll("[data-model]")) before.push(tr.getAttribute("data-model")!);
    expect(before.length, "前置条件：目录表得先画出来").toBeGreaterThan(0);

    await clickLoad(h);

    const after: string[] = [];
    for (const tr of h.section("models").querySelectorAll("[data-model]")) after.push(tr.getAttribute("data-model")!);
    expect(after, "上游那份清单把目录表挤掉了").toEqual(before);
    // 端点那一列同样还在（矩阵与端点是目录独有的两样东西，上游那份一个都没有）。
    const eps: string[] = [];
    for (const d of h.section("models").querySelectorAll(".models-endpoint")) eps.push(d.textContent);
    expect(eps.length, "端点那一列被抹掉了").toBeGreaterThan(0);
  });

  /**
   * **空池那一档：`ok:false` + `no_key`，不是 5xx、不是空清单。**
   * 画成空清单的话，面板会对运维说「上游一个模型都没有」——而这次**一个出站请求
   * 都没发出去**，那句话没有任何依据。
   */
  it("空池：说清是「池里没有能用的 key」，不画一张空清单", async () => {
    const h = await openModels(() => ({
      status: 200, body: { ok: false, status: null, latencyMs: 0, reason: "no_key", models: null },
    }));

    await clickLoad(h);

    expect(groupIds(h, "ids"), "没有清单可画，却画了一张").toEqual([]);
    expect(msg(h)).toBe(
      "Key 池里没有一把现在能用的 key，这次一个上游请求都没发出去。先去 Key 池加一把，或等冷却过去。",
    );
  });

  /**
   * **形状不对那一档。** 它说的是「我们看不懂上游这次回的东西」，
   * **不是**「上游没有模型」——两句话的处置完全不同。
   */
  it("bad_payload：说的是「我们看不懂」，不是「上游没有模型」", async () => {
    const h = await openModels(() => ({
      status: 200, body: { ok: false, status: 200, latencyMs: 8, reason: "bad_payload", models: null },
    }));

    await clickLoad(h);

    expect(msg(h)).toContain("本网关看不懂");
    expect(msg(h), "把「我们看不懂」说成了一句关于上游的事实").not.toContain("上游没有模型。");
    expect(groupIds(h, "ids")).toEqual([]);
  });

  /**
   * ⚠️⚠️ **上游 401：整块屏幕上不许出现上游错误体里的任何一段。**
   * 各家 API 的 401/403 错误体恰恰最爱回显 key 片段。后端那一侧由
   * `tests/contract/admin-upstream-models.test.ts`
   *「上游 401 的正文一个字节都不回给面板 —— 那正是各家 API 最爱回显 key 片段的地方」那一格钉着；
   * 这一格钉的是**面板这一侧**：即便有一天后端多回了点什么，这张卡也不去画它。
   * 断言落在整个板块的 `textContent` 上（逐字段查会在多一个字段时静默漏掉）。
   */
  it("上游 401：画出状态码那一行，而上游错误正文一个字都不上屏", async () => {
    const leak = "sk-leaked-fragment-in-upstream-error-body";
    const h = await openModels(() => ({
      status: 200,
      body: {
        ok: false, status: 401, latencyMs: 30, reason: "upstream_error", models: null,
        // 后端今天不会回这一段（契约那一格钉着）；**这里刻意多喂一段**，
        // 证明面板即便拿到它也不会画出来。
        upstreamBody: `无效的令牌 ${leak}`,
      },
    }));

    await clickLoad(h);

    const screen = h.section("models").textContent;
    expect(screen, "上游错误体被画到屏幕上了").not.toContain(leak);
    expect(screen, "上游错误体的任何一段都不许上屏").not.toContain("无效的令牌");
    // 反向自检：这一格确实说了点什么，不是因为整块为空才没命中。
    expect(msg(h)).toContain("上游没有正常返回");
    expect(screen, "「上游回了几」这一行没画出来").toContain("401");
  });

  it("超时：说的是「没拿到响应头」，与「上游没有模型」分得开", async () => {
    const h = await openModels(() => ({
      status: 200, body: { ok: false, status: null, latencyMs: 5000, reason: "timeout", models: null },
    }));

    await clickLoad(h);

    expect(msg(h)).toBe("问上游超时了：在超时档内没有拿到响应头。");
    // `status` 是 null ⇒ 状态码那一行不该出现（那一行只在上游真回了什么时才有意义）。
    expect(h.section("models").textContent, "上游根本没回，却画了一个状态码").not.toContain("HTTP 状态码");
  });

  /**
   * **截断那一档：如实交代，不静默丢。**
   * 静默丢的后果是运维以为上游就这些模型——那是一句面板凭空说出来的话。
   *
   * ⚠️ **条数取的是「这次拿到手的那份」的长度，不是前端写死的一个上限常量**：
   * 上限住在后端，抄一份到前端就会漂。
   */
  it("截断：那条提示出现，条数取的是这次拿到手的长度", async () => {
    const h = await openModels(() => ({
      status: 200, body: okBody({ ids: ["a", "b", "c"], truncated: true }),
    }));

    await clickLoad(h);

    const warn: string[] = [];
    for (const w of h.section("models").querySelectorAll("[data-up=\"truncated\"]")) warn.push(w.textContent);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain("前 3 条");
    // 清单本身照画：截断不是失败。
    expect(groupIds(h, "ids")).toEqual(["a", "b", "c"]);
  });
});

describe("上游模型：护栏与并发", () => {
  /**
   * ⚠️ **429 不许被说成「上游出错了」——那一次一个出站请求都没发出去。**
   * 护栏的两种拒绝（还在飞 / 间隔没过）在同一个 429 下，处置完全不同，
   * 所以判据是响应体里的 `reason` 而不是状态码。
   */
  it("护栏挡下的 429 说的是「隔一小段再试」，不是「上游出错了」", async () => {
    const h = await openModels(() => ({
      status: 429,
      body: { error: { type: "rate_limit_error", message: "两次探测之间要隔一小段" }, reason: "probe_cooldown" },
    }));

    await clickLoad(h);

    expect(msg(h)).toBe("两次上游探测之间至少要隔一小段时间，请稍后再试。这不是上游的故障。");
    expect(msg(h), "把一次没发出去的请求说成了上游的故障").not.toContain("上游没有正常返回");
    // 后端那句中文 message **不许**被搬到屏幕上：面板是五语言的，那一句只有中文。
    expect(h.section("models").textContent).not.toContain("两次探测之间要隔一小段");
  });

  /**
   * **在飞时不许再发一条。**
   *
   * ⚠️ 观测点落在**出站条数**上，不落在按钮的 `.disabled` 上：
   * 那个属性在替身上是登记在案的盲点（见文件头）。这条不变量的实现也确实是
   * `loadUpstream()` 开头那条早退——**变红条件**就是删掉它。
   */
  it("上一条还在飞的时候连点两下，只发得出去一条", async () => {
    const pending: Array<(r: { status: number; body: unknown }) => void> = [];
    const h = await openModels(() => new Promise((resolve) => { pending.push(resolve); }));

    loadBtn(h).click();
    await settle(4);
    loadBtn(h).click();
    await settle(4);

    expect(upCalls(h), "在飞的时候又发了一条").toBe(1);
    // 让它落地，卡照常画出来（早退不许把状态卡死在「查询中」）。
    pending[0]!({ status: 200, body: okBody({ ids: ["m-1"] }) });
    await settle(12);
    expect(groupIds(h, "ids")).toEqual(["m-1"]);
  });
});
