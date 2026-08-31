import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **用量板块的渲染行为。**
 *
 * `tests/ui/usage.test.ts` 把取值判定测得很细，**但没有任何东西验证板块文件
 * 真的把那些判定渲染成了不同的字**。把 `fillCell` 里 `"none"` 那一支改成走
 * `"unknown"` 那一支，纯函数用例一条都不红，而面板会把「这段时间没有请求」
 * 说成「读取失败」——三态白分。这一组补的就是那一半。
 *
 * ── **替身能力核对（第 9 种假阳性，Step 4 要求写进检查单）** ─────────────────
 * `tests/ui/dom/fake-dom-parity.test.ts` 是权威表：`FAKE_ONLY_MEMBERS` **8 条**
 *（`.walk()` / `.parent` / `.input()` / `.attrs` / `.listeners` /
 * `classList.reset()` / `querySelectorAll()` 后紧跟数组方法 / `.children` 后紧跟数组方法），
 * `KNOWN_BLIND_SPOTS` **3 条**（返回值先存进变量再调数组方法 / `submit()` 语义相反 /
 * `.disabled` 挂错宿主）。
 * `admin-ui/js/sec-usage.js` 用到的 DOM 成员逐个对过：
 * `createElement` / `setAttribute` / `getAttribute` / `textContent` / `appendChild` /
 * `addEventListener` / `classList.add` / `classList.toggle(name, force)` —— **8 条一条都没用到，
 * 3 条盲点也一条都没踩**（本板块没有禁用态、没有表单、没有子树遍历，
 * 也不调 `querySelectorAll`）。`.disabled` 那条盲点对本任务不适用。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;
/** EM DASH（U+2014）：`fmtDash(null)` 交出来的那一根，意思是「我们不知道」。 */
const EM = "—";
/** EN DASH（U+2013）：`sec-usage.js` 的 `EN_DASH`，意思是「读成功了，只是没有样本」。 */
const EN = "–";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 板块里全部 `.card` 的「标签 key → 值文本」。 */
function cards(section: FakeElement): Record<string, string> {
  const out: Record<string, string> = {};
  // ⚠️ 刻意用 `for…of` 而不是 `.map` / `.find`：`querySelectorAll` 在真实 DOM 上
  //    回的是 `NodeList`，没有数组方法（fake-dom-parity 那张表的第 7 条）。
  //    测试代码不在那道扫描范围内，但照真实语义写才不会把一个错的写法教给下一个人。
  for (const card of section.querySelectorAll(".card")) {
    let labelKey: string | null = null;
    let value: string | null = null;
    for (const div of card.querySelectorAll("div")) {
      if (div.classList.contains("label")) labelKey = div.getAttribute("data-i18n");
      if (div.classList.contains("value")) value = div.textContent;
    }
    if (labelKey !== null && value !== null) out[labelKey] = value;
  }
  return out;
}

/**
 * **日汇总表里每一行的 `<td>` 文本**，用 `|` 拼起来。
 *
 * ⚠️⚠️ **这个 helper 是评审那条逼出来的，成因记下**：上面那个 `cards()` **只收集
 * 带 `.label` + `.value` 子节点的 `.card`**，而日表活在 `.card.block` 里、
 * 两个子节点都没有 ⇒ **日表对它完全不可见**。于是「六张卡对了」与「日表也对」
 * 被当成了同一件事，而它们不是（第 5 种假阳性：覆盖的状态让被测的选择不可观测）。
 * 凡是断言表格内容的用例，观测点必须落在 `<td>` 上。
 *
 * 只取**带下钻按钮**的那些行（= 日汇总表的数据行），把表头与分解表排除掉。
 */
function dayRowCells(section: FakeElement): string[] {
  const out: string[] = [];
  for (const tr of section.querySelectorAll("tr")) {
    let hasDrill = false;
    for (const b of tr.querySelectorAll("button")) {
      if (b.classList.contains("usage-drill")) { hasDrill = true; break; }
    }
    if (!hasDrill) continue;
    const cells: string[] = [];
    for (const td of tr.querySelectorAll("td")) cells.push(td.textContent);
    out.push(cells.join("|"));
  }
  return out;
}

/** 板块里 `.approx`（`≈`）节点的个数。**位置断言另写**，见下面「位置也要断言」那一段。 */
function approxCount(section: FakeElement): number {
  let n = 0;
  for (const sp of section.querySelectorAll("span")) {
    if (sp.classList.contains("approx")) n++;
  }
  return n;
}

/** 板块里全部横幅的 class（顺序即 DOM 顺序）。 */
function banners(section: FakeElement): string[] {
  const out: string[] = [];
  for (const cls of ["banner-danger", "banner-warn", "banner-info"]) {
    for (const node of section.querySelectorAll(`.${cls}`)) out.push(`${cls}:${node.textContent}`);
  }
  return out;
}

/** 一份 `GET /admin/api/usage` 的正常响应。 */
function usageBody(over: Record<string, unknown> = {}) {
  return {
    tier: "tier2", timezone: "UTC", approximate: true, generatedAt: NOW,
    range: { from: NOW - 86_399_999, to: NOW, clamped: false },
    days: [{
      date: "2026-08-21",
      total: {
        requests: 100, success: 90, errors: 10, tokensIn: 4000, tokensOut: 2500,
        streamingRequests: 30, latencySum: 24_000, latencyCount: 80,
      },
    }],
    total: {
      requests: 100, success: 90, errors: 10, tokensIn: 4000, tokensOut: 2500,
      streamingRequests: 30, latencySum: 24_000, latencyCount: 80,
    },
    shards: 3, malformed: 0,
    pending: { count: 0, ms: 0, budgetExhausted: false },
    note: null,
    ...over,
  };
}

const CAPS = {
  version: "0.1.0",
  runtime: { name: "node", colo: null },
  stats: { tier2Enabled: true, flushIntervalMs: 60_000, tokensCoverage: ["anthropic", "responses"] },
};

const MODELS = {
  protocols: [
    { id: "openai", label: "OpenAI Chat Completions" },
    { id: "anthropic", label: "Anthropic Messages" },
    { id: "responses", label: "OpenAI Responses" },
    { id: "gemini", label: "Google Gemini" },
  ],
  models: [],
};

/** 打开用量板块（登录态 + 上次停在 usage）。 */
async function openUsage(
  respond: (url: string, method: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "usage" },
    respond,
  });
  await settle(12);
  return h;
}

/** 缺省应答：capabilities / models 给全，usage 按传进来的那一份。 */
function respondWith(usage: unknown, status = 200) {
  return (url: string) => {
    if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
    if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
    if (url.startsWith("/admin/api/usage")) return { status, body: usage };
    return { status: 200, body: {} };
  };
}

describe("Tier-2 关闭：说明卡，不是空图表", () => {
  /**
   * **变红条件**：把 `render()` 里 `if (state === "off") { …; return; }` 的
   * `return` 删掉 ⇒ 六张卡照样渲染出来（全是 EM DASH）
   * ⇒ 「一个数字格都没有」那句断言当场红。
   *
   * 空图表比不画更糟：一张全是 0（或全是破折号）的表会被读成
   *「这段时间没人用」，而事实是这个部署根本没在记账。
   */
  it("Tier-2 关着时渲染说明卡，且页面上一个数字格都没有 —— 空图表比不画更糟", async () => {
    const h = await openUsage(respondWith({
      tier: "off", timezone: "UTC", approximate: true, generatedAt: NOW,
      range: { from: NOW - 86_399_999, to: NOW, clamped: false },
      days: null, total: null, shards: null, malformed: null, pending: null, note: "tier2_off",
    }));
    const sec = h.section("usage");
    expect(sec.querySelectorAll(".value").length, "关着还渲染了数字格").toBe(0);
    expect(sec.textContent).toContain("时间序列统计没有开启");
    // ⚠️ **怎么开这件事必须说准**：`usageStatsEnabled` 今天不在 `EDITABLE` 里，
    //    设置页上没有它的入口 ⇒ 不许给一颗「跳设置页」的按钮。
    expect(sec.textContent, "没写清真正能开它的那条路径").toContain("USAGE_STATS_ENABLED");
    // KV 写开销那个数从 capabilities 取，**不在前端算死**：60000ms ⇒ 「1分0秒」。
    expect(sec.textContent, "落盘间隔没有来自 capabilities").toContain("1分0秒");
    // 时间范围按钮组也不该出现：一段没有数据的区间选它做什么。
    expect(sec.querySelectorAll("[data-range]").length).toBe(0);
  });
});

describe("三态在六张卡上必须长得不一样", () => {
  /**
   * **变红条件**：把 `fillCell` 的 `"unknown"` 那一支改成
   * `node.appendChild(el("span", null, "0"))` ⇒ 面板对读取失败报 0
   * ⇒ 下面每一句都红。这正是全局约束 9 的原话。
   */
  it("接口返回 days: null 时六张卡全是 EM DASH，且顶部是错误横幅 —— 不许伪造 0", async () => {
    const h = await openUsage(respondWith(usageBody({
      days: null, total: null, shards: null, malformed: null, note: "read_failed",
    })));
    const c = cards(h.section("usage"));
    // 六张卡，逐张列全 —— **数全集，不是数上一轮被点名的那几条**。
    expect(Object.keys(c).sort()).toEqual([
      "usage.card.errorRate", "usage.card.latency", "usage.card.requests",
      "usage.card.streaming", "usage.card.successRate", "usage.card.tokens",
    ]);
    expect(c["usage.card.requests"]).toBe(EM);
    expect(c["usage.card.successRate"]).toBe(EM);
    expect(c["usage.card.latency"]).toBe(EM);
    expect(c["usage.card.errorRate"]).toBe(EM);
    // Token 卡在这一档下是**一根**破折号，不是「— / —」：读不出来这件事只有一次，
    // 把它写成两次会让人以为「入」与「出」是各自独立地失败的。
    expect(c["usage.card.tokens"]).toBe(EM);
    expect(c["usage.card.streaming"]).toBe(EM);
    // 一个 `0` 都不许出现在这六张卡上。
    for (const [k, v] of Object.entries(c)) expect(v, `${k} 伪造了 0`).not.toContain("0");
    expect(banners(h.section("usage")).join("|")).toContain("banner-danger");
  });

  /**
   * **变红条件**：把 `empty` 态的比率卡也改成走 `"unknown"`
   *（`fillCell(successRate.value, cellKind(state, c.requests), …)`，
   * 也就是拿计数那一档的判据去填比率格）⇒ 比率卡变成 EM DASH
   * ⇒ 与上面那一格的 `unavailable` 渲染**完全相同** ⇒ 最后那句对照断言红。
   */
  it("接口返回真实的零请求时：计数卡是 0、比率卡是 EN DASH、顶部是「没有请求」横幅 —— empty 与 unavailable 必须长得不一样", async () => {
    const zero = {
      requests: 0, success: 0, errors: 0, tokensIn: 0, tokensOut: 0,
      streamingRequests: 0, latencySum: 0, latencyCount: 0,
    };
    const h = await openUsage(respondWith(usageBody({
      days: [{ date: "2026-08-21", total: zero }], total: zero,
      shards: 3, malformed: 0, note: null,
    })));
    const c = cards(h.section("usage"));
    // 计数类：**这一次读成功了，我们确实知道答案是零** ⇒ 写 `0`。
    expect(c["usage.card.requests"]).toBe("≈ 0");
    expect(c["usage.card.streaming"]).toBe("≈ 0");
    expect(c["usage.card.tokens"]).toBe("≈ 0 / 0");
    // 比率类与平均延迟：没有分母 / 没有样本 ⇒ EN DASH，**不是** EM DASH。
    expect(c["usage.card.successRate"]).toBe(EN);
    expect(c["usage.card.errorRate"]).toBe(EN);
    expect(c["usage.card.latency"]).toBe(EN);
    // ⚠️ **这一句才是这一格的全部理由**：两个态渲染成同一个字就是把两件事说成一件。
    expect(c["usage.card.successRate"], "empty 与 unavailable 在比率卡上长得一样了").not.toBe(EM);
    expect(banners(h.section("usage")).join("|"), "没有说清『这段时间真的一次请求都没有』")
      .toContain("这段区间里一次请求都没有");
  });

  /**
   * **`all_malformed`：读到了分片，但每一个都坏。**
   * 后端在这一档下发的 `days` / `total` 全是 0 桶 —— 照着渲染就会在六张卡上写 `0`，
   * 而我们对这段时间的用量一无所知。
   *
   * **变红条件**：把 `usageState` 里 `if (malformedKind(r) === "all") return "unavailable";`
   * 删掉 ⇒ 状态变成 `empty` ⇒ 计数卡写 `0` ⇒ 第一句断言红。
   */
  it("分片全坏时六张卡是 EM DASH 而不是 0 —— 那些 0 不是知识", async () => {
    const zero = {
      requests: 0, success: 0, errors: 0, tokensIn: 0, tokensOut: 0,
      streamingRequests: 0, latencySum: 0, latencyCount: 0,
    };
    const h = await openUsage(respondWith(usageBody({
      days: [{ date: "2026-08-21", total: zero }], total: zero,
      shards: 0, malformed: 5, note: "all_malformed",
    })));
    const c = cards(h.section("usage"));
    expect(c["usage.card.requests"]).toBe(EM);
    expect(banners(h.section("usage")).join("|")).toContain("每一个都是畸形的");
  });

  /**
   * ⚠️⚠️⚠️ **评审发现：结论没往下传，同一份 `0` 挪到了下一屏。**
   *
   * `usageState` 为了让 ⑦ 别在卡片上写 `0` 而加了一句早退，**但那个结论只走到
   * `buildCards()`**：`days` 数组（每天一格全 0 桶）被原样交给日汇总表，
   * 于是评审实跑出来的两份 `<td>` 文本**逐字节相同**：
   * ```
   * ③ no_shards     : 2026-08-21|0|0|0|0 / 0|0|–|下钻
   * ⑦ all_malformed : 2026-08-21|0|0|0|0 / 0|0|–|下钻
   * ```
   * 顶部六张卡在 ⑦ 下正确地全是 EM DASH，**而紧挨着的表把同一段区间写成
   * 「请求 0 次」**；延迟格还是 EN DASH（=「读成功了只是没样本」）——同一行里第二句假话。
   * 这正是后端评审判过的那件事（⑦ 报成 ③「是一句假话」）在前端下一屏又造了一遍。
   *
   * **观测点必须在 `<td>` 上**：既有那 18 格全查 `cards()`，而那个 helper 看不见日表。
   *
   * **变红条件**：把 `numberCells()` 里的 `rowState(state, bucket)` 换回
   * `bucket === null ? "unavailable" : "data"`（= 不看整块状态）⇒ 两份行文本
   * 又变成逐字节相同 ⇒ 最后那句对照断言红。
   */
  it("日汇总表：no_shards 那一行写 0、all_malformed 那一行写 EM DASH —— 两行逐字节相同就是把「读到的全是坏分片」说成「一次都没跑过」", async () => {
    const zero = {
      requests: 0, success: 0, errors: 0, tokensIn: 0, tokensOut: 0,
      streamingRequests: 0, latencySum: 0, latencyCount: 0,
    };
    const days = [{ date: "2026-08-21", total: zero }];

    // ③ 区间里一个分片都没有：读成功了，答案真的是零。
    const noShards = await openUsage(respondWith(usageBody({
      days, total: zero, shards: 0, malformed: 0, note: "no_shards",
    })));
    const rowsNoShards = dayRowCells(noShards.section("usage"));

    // ⑦ 分片都在、但每一个都是畸形的：我们对这段时间一无所知。
    const allMalformed = await openUsage(respondWith(usageBody({
      days, total: zero, shards: 0, malformed: 5, note: "all_malformed",
    })));
    const rowsAllMalformed = dayRowCells(allMalformed.section("usage"));

    // 装置自检：两边都真的渲染出了那一行，否则下面的 not.toEqual 恒成立。
    expect(rowsNoShards.length, "③ 没渲染出日表行，装置本身坏了").toBe(1);
    expect(rowsAllMalformed.length, "⑦ 没渲染出日表行，装置本身坏了").toBe(1);

    // ③：期望值手写字面量，逐格列全（日期 | 请求 | 成功 | 错误 | Token | 流式 | 延迟 | 下钻）。
    expect(rowsNoShards[0], "③ 读成功了、答案就是零 ⇒ 计数格写 0、延迟格写 EN DASH")
      .toBe(`2026-08-21|0|0|0|0 / 0|0|${EN}|下钻`);
    // ⑦：六个数字格**全部**是 EM DASH。一个 `0` 都不许出现。
    expect(rowsAllMalformed[0], "⑦ 的日表行把「读到的全是坏分片」写成了「请求 0 次」")
      .toBe(`2026-08-21|${EM}|${EM}|${EM}|${EM}|${EM}|${EM}|下钻`);
    // ⚠️ **这一句才是这一格的全部理由。**
    expect(rowsAllMalformed[0], "③ 与 ⑦ 的日表行逐字节相同 —— 卡片改对了，假话只是挪到了下一屏")
      .not.toBe(rowsNoShards[0]);
  });

  /**
   * **`read_failed`：`days` 是 null ⇒ 一行都没有。**
   * 那时表里那句话不许是「这段区间里没有可以列出的日子」——那是把一次读取失败
   * 说成「这段时间本来就没有日子」，与那条同一族。
   *
   * **变红条件**：把 `buildDayTable()` 里那个三元换回无条件的 `"usage.table.empty"`。
   */
  it("read_failed 时日表那句话是「读不出来」而不是「没有可以列出的日子」—— 后者是把读取失败说成本来就没有", async () => {
    const h = await openUsage(respondWith(usageBody({
      days: null, total: null, shards: null, malformed: null, note: "read_failed",
    })));
    const sec = h.section("usage");
    expect(dayRowCells(sec), "days 是 null 却渲染出了行").toEqual([]);
    expect(sec.textContent).toContain("按天数据读不出来");
    expect(sec.textContent, "把一次读取失败说成「这段时间本来就没有日子」")
      .not.toContain("没有可以列出的日子");
  });

  /**
   * **`partial_malformed`：数字是真的，只是不全。**
   * 全局约束 9 禁的伪造**不只是伪造 `0`，还有伪造「这份数据是全的」这个印象**。
   *
   * **变红条件**：把 `honestyMarks()` 的 `incompleteOf` 判据换成常量 `null`
   * ⇒ 缺了两个分片的数字被渲染成完整的 ⇒ 第一句断言红。
   * ⚠️ **这条指向订正过一次**（收口复评）：上一版写的是
   * 「把 `buildCards` 里 `const incompleteOf = c.complete ? null : c.malformed;` 改成…」
   * ——那个串 `grep -F` 在 `admin-ui/` 下**零命中**，`buildCards` 里也压根没有
   * `incompleteOf`。它**一开始就没对过**（真身在另一个函数里、而且是对象属性），
   * 后来那一行又被整体换掉。⭐ **一条从没对过的「变红条件」比没有更糟：
   * 它让人以为这一格被验证过。**
   */
  it("一部分分片畸形时每一张卡都带「不完整」标记 —— 不许把缺了几块的数字渲染成完整的", async () => {
    const h = await openUsage(respondWith(usageBody({ shards: 3, malformed: 2, note: "partial_malformed" })));
    const c = cards(h.section("usage"));
    expect(c["usage.card.requests"], "缺了两个分片却渲染成了完整数据").toContain("不完整");
    expect(c["usage.card.requests"]).toContain("100");
    // 反向锚：没有畸形分片时**不许**出现这个标记，否则「恒带标记」也全绿。
    const ok = await openUsage(respondWith(usageBody()));
    expect(cards(ok.section("usage"))["usage.card.requests"]).not.toContain("不完整");
  });

  /**
   * ⚠️⚠️ **定向复评把评审那条的落地方式推翻了，这一格是订正后的版本。**
   *
   * 那一轮我给日表的**每一行**挂了一个「不完整」标记。定向复评实测指出：
   * `malformed` 数的是**整段区间**的畸形分片 ⇒ 30 天档下 **30 行全写「不完整」**，
   * 而其中绝大多数天其实是完整的 —— **对那些天它是一句假话**；
   * 更难堪的是那一版自己的注释还承认「我们并不知道具体哪一格短了」，
   * 却对每一格都下了断言。而当时的用例只用 `toContain`，**挂几遍都绿**。
   *
   * ⭐ **「我们不知道是哪一个」推不出「所以每一个都标上」，它只推得出「只能对整体说」。**
   *
   * ⇒ 现在：**整块说一次**（`partial_malformed` 那条红条），**逐行一个都不挂**。
   * 下面用 `toContain` + 逐行计数**双向**钉住，不给「挂了 N 遍」留空子。
   *
   * **变红条件**：把逐行标记加回去（`keyCell(row.date, marks)` 那种）
   * ⇒ 第三句（逐行零命中）红。
   */
  it("partial_malformed：「不完整」整块只说一次，日表逐行一个都不挂 —— 我们不知道哪一天短，就不许对每一天单独断言", async () => {
    const days = [
      { date: "2026-08-19", total: usageBody().total },
      { date: "2026-08-20", total: usageBody().total },
      { date: "2026-08-21", total: usageBody().total },
    ];
    const h = await openUsage(respondWith(usageBody({
      days, shards: 3, malformed: 2, note: "partial_malformed",
    })));
    const sec = h.section("usage");
    // ① 整块那一处必须说（红条，由后端 note 驱动）。
    expect(banners(sec).join("|"), "整块没说「一部分分片是畸形的」").toContain("一部分分片是畸形的");
    // ② 六张卡带标记（它们是整段区间的合计，说它不完整是准确的）。
    expect(cards(sec)["usage.card.requests"]).toContain("不完整");
    // ③ ⚠️ **日表逐行一个都不许挂** —— 装置里刻意放了三天。
    const rows = dayRowCells(sec);
    expect(rows.length, "没渲染出三行，装置本身坏了").toBe(3);
    const marked = rows.filter((r) => r.includes("不完整"));
    expect(marked, "日表对每一天单独断言了「不完整」，而我们并不知道是哪一天短").toEqual([]);
    // ④ 数字本身还得在（它们是真的，只是不全）。
    expect(rows[0]).toContain("100");
  });

  /**
   * **变红条件**：把 `buildCards` 里
   * `const approx = … data.approximate === true;` 改成 `const approx = true;`
   * ⇒ 后端说这份数字不是近似值时面板照样打 `≈` ⇒ 第二句断言红。
   * 这是全局约束 10（诚实标记由后端字段驱动）在本板块的落点。
   */
  it("`≈` 由响应里的 approximate 驱动，不是前端硬编码的 true", async () => {
    const on = await openUsage(respondWith(usageBody({ approximate: true })));
    expect(cards(on.section("usage"))["usage.card.requests"]).toContain("≈");
    const off = await openUsage(respondWith(usageBody({ approximate: false })));
    expect(cards(off.section("usage"))["usage.card.requests"], "前端把 ≈ 写死了").not.toContain("≈");
  });
});

describe("横幅：判据全部来自响应字段", () => {
  /**
   * **变红条件**：把 `buildRangeBar` 里那条 `usage.covered` 改成用
   * `rangeToQuery(range, Date.now())` 自己算出来的一对 ⇒ 面板显示的区间
   * 与服务端真正查过的那一段脱钩 ⇒ 第二句断言红。
   */
  it("range.clamped 为真时顶部说明「只显示了能拿到的部分」，且覆盖区间是服务端回读的那一对", async () => {
    const h = await openUsage(respondWith(usageBody({
      range: { from: 1_697_500_800_000, to: 1_700_006_399_999, clamped: true },
      note: "range_clamped",
    })));
    const sec = h.section("usage");
    expect(banners(sec).join("|")).toContain("banner-warn");
    expect(sec.textContent).toContain("只显示了能拿到的那一段");
    // 服务端回读的 `range.from`（1697500800000 = 2023-10-17 00:00:00 UTC）
    // 必须原样出现在覆盖区间里；前端自己按 `now − 29 天` 算的话是别的数。
    expect(sec.textContent, "覆盖区间没有渲染服务端回读的 range").toContain("2023-10-17 00:00:00");
  });

  /**
   * ⚠️⚠️ **这一格钉的是「前端不许假设 note 只可能是那八个值之一」。**
   * `tests/contract/admin-usage.test.ts` 的
   * 「八种状态两两不同 —— 面板不用猜，也不该猜（但这一格证明不了没有第九种）」
   * 证明的是「已列出的那八种互不相同」，**不是「没有第九种」**。
   *
   * **变红条件**：把 `buildNoteBanner` 里 `key === null` 那一支改成
   * `elI18n("span", "common.loadFailed")` ⇒ 一条读得懂的新 code 被抹成
   *「读取失败，显示为 —」⇒ 第二句断言红。
   */
  it("面板不认识的 note code 原样显示出来 —— 抹成一句「加载失败」会把一条说得清的信号变成废话", async () => {
    const h = await openUsage(respondWith(usageBody({ note: "some_future_code_from_a_later_release" })));
    const sec = h.section("usage");
    expect(sec.textContent, "新 code 没被显示出来").toContain("some_future_code_from_a_later_release");
    expect(sec.textContent, "被抹成了一句通用失败提示").not.toContain("读取失败，显示为");
    // 读不懂的 code 归 warn：不当成常态，也不把面板染成一片红。
    expect(banners(sec).join("|")).toContain("banner-warn");
  });

  /**
   * **评审发现：判据是「有没有人用 error 档说过『读不出来』」，不是「有没有横幅」。**
   *
   * 上一版写的是 `banner === null`，于是 `range_clamped`（warn 档）配上 `days: null` 时：
   * 六张卡全是 EM DASH，而页面上**只有一条温和的黄条，没有任何一句说「读不出来」**。
   * 今天后端发不出这个组合，**但本板块自己刚论证过「不许假设 note 只可能是表内的值」
   * ——同一条纪律在「字段组合」这一维上一样要落实。**
   *
   * **变红条件**：把 `render()` 里的 `noteSeverity(note) !== "error"` 换回
   * `banner === null` ⇒ 黄条把红条挤掉 ⇒ 第二句断言红。
   */
  it("温和的 note 配上读不出来的 days：黄条之外必须另有一句「读取失败」—— 六卡全是破折号而页面上没人解释就是沉默", async () => {
    const h = await openUsage(respondWith(usageBody({
      days: null, total: null, shards: null, malformed: null,
      range: { from: 1_697_500_800_000, to: 1_700_006_399_999, clamped: true },
      note: "range_clamped",
    })));
    const sec = h.section("usage");
    expect(cards(sec)["usage.card.requests"], "前置条件：六卡确实是 EM DASH").toBe(EM);
    const b = banners(sec).join("|");
    expect(b, "只有一条温和黄条，没有任何一句说读不出来").toContain("banner-danger");
    expect(b, "那条 range_clamped 的黄条也还得在（两件事都要说）").toContain("banner-warn");
  });

  /**
   * ⚠️ **`count > 0 && ms === 0` 要读作「刚试过、没写成」，不是「没有尾巴」**
   *（`src/http/usage-sink.ts` 的 `status()` 上方写着全文）。
   *
   * **变红条件**：把 `pendingTail` 的判据从 `count` 换成 `ms` ⇒ 这一格
   * 什么都不渲染 ⇒ 第一句断言红。
   */
  it("落盘失败时（count 大于 0 而 ms 是 0）面板把预算耗尽说出来 —— 两种失败态在 count + ms 上长得一样", async () => {
    const h = await openUsage(respondWith(usageBody({
      pending: { count: 7, ms: 0, budgetExhausted: true },
    })));
    const sec = h.section("usage");
    expect(sec.textContent).toContain("写配额已经耗尽");
    expect(sec.textContent).toContain("7");
    // 反向锚：没有耗尽时说的是另一句话 —— 两种失败态不许互相冒充。
    const other = await openUsage(respondWith(usageBody({
      pending: { count: 7, ms: 0, budgetExhausted: false },
    })));
    expect(other.section("usage").textContent).not.toContain("写配额已经耗尽");
    expect(other.section("usage").textContent).toContain("还有 7 条计数没有落盘");
  });
});

describe("时间范围：档位差一天会让那句警告永久常驻", () => {
  /**
   * ⚠️ **观测点在真实请求 URL 上**，不是在 `rangeToQuery` 的返回值上
   *（那一层已经由 `tests/ui/usage.test.ts` 的
   * 「30d 的区间正好是 29 × 86400000，且只发 from / to 两个参数 —— 参数名发错在真实请求 URL 上才看得见」
   * 钉着）。这一格证明的是**板块真的把它拼进了 URL**。
   *
   * **变红条件**：把 `load()` 里的查询串改成 `?days=30` 或者把
   * `rangeToQuery` 换回 `nowMs - days * 86400000` ⇒ 最后那句断言红。
   */
  it("点 30d 之后请求 URL 里的 from / to 相差 29 天 —— 发成 30 天会让 clamped 恒为真", async () => {
    const h = await openUsage(respondWith(usageBody()));
    // 缺省档是 24h（**不是 30d**：那一档一次要读满 30 天的分片）。
    expect(h.calls.some((c) => c.url === "/admin/api/usage?from=1700000000000&to=1700000000000"),
      "缺省档不是 24h").toBe(true);

    const sec = h.section("usage");
    const btn = sec.querySelector("[data-range=\"30d\"]");
    expect(btn, "30d 按钮不在页面上").not.toBe(null);
    btn!.click();
    await settle(12);

    // 手写字面量：1700000000000 − 29 × 86400000 = 1697494400000。
    expect(h.calls.some((c) => c.url === "/admin/api/usage?from=1697494400000&to=1700000000000"),
      "30d 那一档没有按 from = to − (N−1) 天 发").toBe(true);
    // 发成 30 天回退的那个数**不许**出现（1700000000000 − 30 × 86400000）。
    expect(h.calls.some((c) => c.url.includes("from=1697408000000")),
      "发成了 now − 30 天 ⇒ 每一次点 30d 都会被夹").toBe(false);
    // 30d 那一档要说清保留期，且**不许**声称那些子请求是安全的。
    expect(sec.textContent).toContain("最多保留 30 天");
    expect(sec.textContent).toContain("尚未在真机上验证过");
  });

  /** **本板块不轮询**（配额账三条红线第 1 条）：刷新只在人点一下与切档位时发生。 */
  it("停在板块上不动时一个额外请求都不发 —— 这个板块每刷新一次要付一次存储读", async () => {
    const h = await openUsage(respondWith(usageBody()));
    const before = h.calls.filter((c) => c.url.startsWith("/admin/api/usage")).length;
    for (let i = 0; i < 8; i++) await settle(12);
    const after = h.calls.filter((c) => c.url.startsWith("/admin/api/usage")).length;
    expect(after, "板块在自己轮询").toBe(before);
    expect(before, "反向自检：它至少发过一次，否则上面那个相等恒成立").toBeGreaterThan(0);
  });
});

describe("切走板块", () => {
  /**
   * ⚠️⚠️ **这一格瞄的是一个真实的、只在慢网络下出现的缺陷**：
   * 切走用量板块、换个档位再切回来时，**上一次那个还在飞的响应**回来把新数据覆盖掉。
   *
   * 装置写清（否则复现不出来）：让 `/admin/api/usage` 的第一次应答**挂住**
   *（`respond` 返回一个由本用例手动 resolve 的 Promise），在它挂着的时候
   * 点侧栏切到别的板块（触发 `onHide()`），然后才把它 resolve。
   *
   * ⚠️ **`AbortController` 一个人守不住这件事**：`tests/helpers/fake-dom.ts`
   * 那套替身里的 `fetch` **压根不看 signal**，abort 之后那个 Promise 照样 resolve
   *（真实浏览器里 abort 也是异步的，同一个竞态存在）。守住它的是
   * `sec-usage.js` 的世代号 `seq`。
   *
   * **变红条件**：把 `load()` 里 `if (mine !== seq) return;` 两处删掉
   * ⇒ 挂住的那份响应回来之后照样 `data = body` + `render()`
   * ⇒ 最后那句断言红（板块里出现了那份本该被作废的数据）。
   */
  it("切走板块时在飞请求被作废 —— 回来时不会被上一次的响应覆盖", async () => {
    let release: ((v: { status: number; body: unknown }) => void) | null = null;
    const hung = new Promise<{ status: number; body: unknown }>((res) => { release = res; });
    let usageCalls = 0;

    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "usage" },
      respond: (url) => {
        if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
        if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
        if (url.startsWith("/admin/api/usage")) {
          usageCalls++;
          return usageCalls === 1 ? hung : { status: 200, body: usageBody() };
        }
        return { status: 200, body: {} };
      },
    });
    await settle(12);
    expect(usageCalls, "第一次请求没发出去，装置本身坏了").toBe(1);

    // 切走：`showSection` 会调用户量板块的 `onHide()`。
    const navOverview = h.dom.document.querySelector("[data-section=\"overview\"]");
    expect(navOverview, "侧栏里没有概览按钮").not.toBe(null);
    navOverview!.click();
    await settle(12);

    // 现在才让那份在飞的响应回来 —— 它必须被整份丢掉。
    release!({
      status: 200,
      body: usageBody({ total: { ...usageBody().total, requests: 999_999 } }),
    });
    await settle(12);

    expect(h.section("usage").textContent, "被作废的那份响应还是渲染进去了")
      .not.toContain("999,999");
  });
});

describe("单日下钻", () => {
  const DETAIL_HOURS: Record<string, unknown> = Object.create(null);
  DETAIL_HOURS["2"] = {
    requests: 2, success: 2, errors: 0, tokensIn: 10, tokensOut: 5,
    streamingRequests: 0, latencySum: 200, latencyCount: 2,
  };
  DETAIL_HOURS["10"] = {
    requests: 5, success: 5, errors: 0, tokensIn: 20, tokensOut: 10,
    streamingRequests: 1, latencySum: 500, latencyCount: 5,
  };

  function detailBody(over: Record<string, unknown> = {}) {
    const byModel: Record<string, unknown> = Object.create(null);
    byModel["gpt-4o"] = { ...(DETAIL_HOURS["2"] as object) };
    const byProtocol: Record<string, unknown> = Object.create(null);
    byProtocol["openai"] = { ...(DETAIL_HOURS["2"] as object) };
    return {
      tier: "tier2", timezone: "UTC", date: "2026-08-21", approximate: true, generatedAt: NOW,
      hours: DETAIL_HOURS, byModel, byProtocol, shards: 2, malformed: 0,
      note: "no_request_detail",
      ...over,
    };
  }

  async function drill(detail: unknown) {
    const h = await openUsage((url) => {
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
      if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
      if (url.startsWith("/admin/api/usage/")) return { status: 200, body: detail };
      if (url.startsWith("/admin/api/usage")) return { status: 200, body: usageBody() };
      return { status: 200, body: {} };
    });
    const btn = h.section("usage").querySelector(".usage-drill");
    expect(btn, "日汇总表里没有下钻按钮").not.toBe(null);
    btn!.click();
    await settle(12);
    return h;
  }

  /**
   * **小时表按数值序**：字典序会把 `"10"` 排在 `"2"` 前面 ⇒ 一张按小时排的表
   * 上午跳到晚上再跳回来。
   *
   * **变红条件**：把 `buildDetail` 里 `breakdownTable("usage.detail.hours", …, true)`
   * 的 `true` 改成 `false` ⇒ 行序变成 `10, 2` ⇒ 第一句断言红。
   */
  it("下钻拉的是那一天的端点，小时表按数值序、并把「这里没有逐请求流水」说出来", async () => {
    const h = await drill(detailBody());
    expect(h.calls.some((c) => c.url === "/admin/api/usage/2026-08-21"), "没有打单日下钻端点").toBe(true);
    const sec = h.section("usage");
    const hourCells: string[] = [];
    for (const tr of sec.querySelectorAll("tr")) {
      for (const td of tr.querySelectorAll("td")) { hourCells.push(td.textContent); break; }
    }
    // 小时表在三张分解表里排第一，它那两行的首列必须是 2、10（数值序）。
    expect(hourCells.includes("2") && hourCells.includes("10")).toBe(true);
    expect(hourCells.indexOf("2"), "小时表按字典序排了 —— 10 会跑到 2 前面")
      .toBeLessThan(hourCells.indexOf("10"));
    expect(sec.textContent).toContain("没有逐请求流水");
  });

  /**
   * **评审发现：下钻那条错误横幅上的「刷新」要重拉那一天，不是重拉汇总。**
   * 上一版 `retryButton()` 无参数、一律调 `load()` ⇒ 一颗按了不解决问题的按钮。
   *
   * **变红条件**：把 `buildDetail()` 里的 `retryButton(retryDay)` 换回
   * `retryButton(load)` ⇒ 点下去发的是 `/admin/api/usage?...` 而不是
   * `/admin/api/usage/2026-08-21` ⇒ 最后那句断言红。
   */
  it("下钻失败时那颗「刷新」重拉的是那一天，不是汇总 —— 按了不解决问题的按钮比没有按钮更糟", async () => {
    let fail = true;
    const h = await openUsage((url) => {
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
      if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
      if (url.startsWith("/admin/api/usage/")) {
        return fail ? { status: 500, body: {} } : { status: 200, body: detailBody() };
      }
      if (url.startsWith("/admin/api/usage")) return { status: 200, body: usageBody() };
      return { status: 200, body: {} };
    });
    h.section("usage").querySelector(".usage-drill")!.click();
    await settle(12);
    const before = h.calls.filter((c) => c.url.startsWith("/admin/api/usage/")).length;
    expect(before, "下钻没失败，装置本身坏了").toBe(1);

    fail = false;
    const retry = h.section("usage").querySelector(".usage-retry");
    expect(retry, "下钻失败了却没有重试按钮").not.toBe(null);
    retry!.click();
    await settle(12);

    const after = h.calls.filter((c) => c.url.startsWith("/admin/api/usage/")).length;
    expect(after, "那颗「刷新」重拉的是汇总，不是这一天").toBe(2);
    expect(h.section("usage").textContent, "重试成功了却没渲染出来").toContain("没有逐请求流水");
  });

  /**
   * ⚠️⚠️ **下钻有自己的世代号，不共用汇总那一个。**
   *
   * 第一版共用 `seq`，而那会在一个很常见的操作序列上把下钻卡成空的：
   * 点开某一天之后**再点一次「刷新」**，`load()` 把 `seq` 顶上去，
   * 回来的那份分解就被当成过期的丢掉了 —— 而那一天明明还开着，
   * 面板上只剩一个空壳，再点一次「下钻」才会有内容。
   *
   * 装置写清：让 `/admin/api/usage/:date` 的应答**挂住**，在它挂着的时候点「刷新」
   *（那一下只会重发汇总、只顶 `seq`），然后才把下钻那份 resolve。
   *
   * **变红条件**：把 `openDay()` 里的 `detailSeq` 换回 `seq`
   *（`const mine = seq;` + `if (mine !== seq) return;`）⇒ 那份分解被丢掉
   * ⇒ 最后一句断言红。
   */
  it("下钻在飞时点刷新：那份分解照样落地 —— 重拉汇总不该作废一次仍然有效的下钻", async () => {
    let release: ((v: { status: number; body: unknown }) => void) | null = null;
    const hung = new Promise<{ status: number; body: unknown }>((res) => { release = res; });
    let detailCalls = 0;
    const h = await openUsage((url) => {
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
      if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
      if (url.startsWith("/admin/api/usage/")) { detailCalls++; return hung; }
      if (url.startsWith("/admin/api/usage")) return { status: 200, body: usageBody() };
      return { status: 200, body: {} };
    });
    h.section("usage").querySelector(".usage-drill")!.click();
    await settle(12);
    expect(detailCalls, "下钻请求没发出去，装置本身坏了").toBe(1);

    // 点「刷新」：只重发汇总。板块顶部那颗按钮是 init() 建的，在 body 之外。
    let refresh: FakeElement | null = null;
    for (const b of h.section("usage").querySelectorAll("button")) {
      if (b.getAttribute("data-i18n") === "common.refresh") { refresh = b; break; }
    }
    expect(refresh, "找不到刷新按钮").not.toBe(null);
    refresh!.click();
    await settle(12);

    release!({ status: 200, body: detailBody() });
    await settle(12);
    expect(h.section("usage").textContent, "刷新一下就把还有效的下钻丢掉了")
      .toContain("没有逐请求流水");
  });

  /**
   * ⚠️⚠️⚠️ **评审点名的「第三屏」：分解表也不许把「读不出来」说成「没有记录」。**
   *
   * 那一天的分片全坏时 `mergeDayShards` 什么都合不出来 ⇒ 三个 map 都是空的
   * ⇒ 三张分解表都会说「这一天没有可以分解的记录」——**而事实是那一天的分片
   * 全坏了，我们什么都不知道**。与 ③/⑦ 在日表上撞车是同一个形状，只是换了一屏。
   *
   * **变红条件**：把 `breakdownTable()` 里那个三元换回无条件的 `"usage.detail.empty"`，
   * 或者把 `buildDetail()` 里的 `detailState(detailData)` 换成常量 `"data"`。
   */
  it("那一天的分片全坏时三张分解表说的是「读不出来」而不是「这一天没有记录」—— 第三屏不许再造一次同一句假话", async () => {
    const empty: Record<string, unknown> = Object.create(null);
    const h = await drill(detailBody({
      hours: empty, byModel: empty, byProtocol: empty, shards: 0, malformed: 4,
    }));
    const sec = h.section("usage");
    expect(sec.textContent).toContain("这一天的分解读不出来");
    expect(sec.textContent, "把「分片全坏了」说成「这一天没有记录」")
      .not.toContain("这一天没有可以分解的记录");
    // 反向锚：读成功了、这一天真的没有流量时，说的**必须**是另一句。
    const clean = await drill(detailBody({
      hours: empty, byModel: empty, byProtocol: empty, shards: 0, malformed: 0,
    }));
    expect(clean.section("usage").textContent).toContain("这一天没有可以分解的记录");
    expect(clean.section("usage").textContent).not.toContain("这一天的分解读不出来");
  });

  /**
   * **`date_out_of_retention`：三张表是空的，但那不是「读取失败」。**
   *
   * 这一格钉的是一个**刻意的不对称**：`render()` 在 `unavailable` 且 note 不是
   * error 档时会补一条红色的「读取失败」兜底横幅（评审发现），
   * 而 `buildDetail()` **刻意没有那一支** —— 套在这一档上它会把
   *「那天的记录已经过期了」说成「这次读挂了」，而横幅上还挂着一颗
   * 永远解决不了问题的重试按钮。**两句都不真，比只说一句更糟。**
   *
   * **变红条件**：在 `buildDetail()` 里照 `render()` 抄一份那条兜底横幅
   * ⇒ 第三句断言红。
   */
  it("落在保留期外的那一天：说的是「记录已经不在了」而不是「读取失败」—— 一次 retry 永远解决不了的事不许配一颗重试按钮", async () => {
    const h = await drill(detailBody({
      hours: null, byModel: null, byProtocol: null,
      shards: null, malformed: null, note: "date_out_of_retention",
    }));
    const sec = h.section("usage");
    expect(sec.textContent).toContain("那天的记录已经不在了");
    // 三张表照样要说清自己为什么是空的。
    expect(sec.textContent).toContain("这一天的分解读不出来");
    expect(sec.textContent, "把「记录已经过期」说成了「读取失败」").not.toContain("读取失败，显示为");
  });

  /**
   * ⚠️⚠️ **这一条端点根本不发 `all_malformed` / `partial_malformed`**
   *（它的 `note` 常态恒是 `no_request_detail`）⇒ 「缺了几块」只能靠
   * `shards` / `malformed` 两个字段。**同一件事，两套判据。**
   *
   * **变红条件**：把 `buildDetail` 里那段 `malformedKind(detailData)` 判断
   * 改成照 `note` 判（`detailData.note === "partial_malformed"`）⇒ 恒不成立
   * ⇒ 这一格红，而汇总卡那一格照绿。
   */
  it("下钻的「缺了几块」只能靠 shards / malformed 字段 —— 这条端点不发畸形 code", async () => {
    const h = await drill(detailBody({ shards: 2, malformed: 3 }));
    const sec = h.section("usage");
    expect(sec.textContent, "note 仍然是 no_request_detail，畸形只能从字段读出来").toContain("3 个分片是畸形的");
    // 反向锚：没有畸形分片时不许出现这句话。
    const clean = await drill(detailBody());
    expect(clean.section("usage").textContent).not.toContain("个分片是畸形的");
  });

  /**
   * ⚠️⚠️⚠️ **定向复评：那句话必须真的出得来，而且必须是单日口径。**
   *
   * 上一轮它经 `summaryCards().complete` 判——而 `:date` 响应没有 `total`
   * ⇒ `complete` 恒 true ⇒ **标记结构性地永不渲染**，`marks` 是死参
   *（MUT-B 把它改成 `null`，**624 全绿完整逃逸**）。
   * 判据现在直接走 `malformedKind()`。
   *
   * ⚠️ **顺带钉住那条裁定的两条**：
   * ① 文案是**单日口径**（「这一天有 N 个分片是畸形的」），
   *    不是区间口径的「这段区间里…」——下钻说的是一天；
   * ② `all` 那一档**不说这句**：那时下面三张表一个数字都没有，
   *    而这句话的主语是「下面这些数字」。
   *
   * **变红条件**：把 `honestyMarks` 的 `incompleteOf` 判据换回
   * `summaryCards(resp).complete ? null : …` ⇒ 第二句红。
   */
  it("下钻的「不完整」真的渲染得出来，且是单日口径 —— 上一轮它经 summaryCards().complete，而那条端点没有 total ⇒ 永不渲染", async () => {
    const h = await drill(detailBody({ shards: 2, malformed: 3 }));
    const sec = h.section("usage");
    expect(sec.textContent, "单日口径那句话没出来").toContain("这一天有 3 个分片是畸形的");
    // ⚠️ 不许拿区间口径那句顶替：它逐字写着「这段区间里」，而这里是一天。
    expect(sec.textContent, "把单日说成了「这段区间」").not.toContain("这段区间里有 3 个分片");
    // ② `all` 那一档不说这句（下面一个数字都没有）。
    const empty: Record<string, unknown> = Object.create(null);
    const all = await drill(detailBody({
      hours: empty, byModel: empty, byProtocol: empty, shards: 0, malformed: 4,
    }));
    expect(all.section("usage").textContent, "一个数字都没有，却说「下面这些数字缺了那几块」")
      .not.toContain("个分片是畸形的");
    // ⚠️ 但那一档照样得有人说话。**说话的不是 note** —— 契约 6：这条端点
    //    根本不发 `all_malformed`，它的 `note` 在这一档下仍然是 `no_request_detail`
    //    （我第一版在这里断言了「每一个都是畸形的」，**那是我自己编的**，
    //    被这一格当场证伪）。真正说话的是三张表各自那句「读不出来」。
    expect(all.section("usage").textContent, "全坏那一档没有任何一句解释为什么表是空的")
      .toContain("这一天的分解读不出来");
  });

  /**
   * **定向复评：`≈` 不许只在卡片上出、在紧挨着的表里沉默。**
   *
   * 上一版 `numberCells` 的第四形参恒为 `null` ⇒ 六张卡写 `≈ 100`、
   * 日表写 `100`，**同一个数字两种说法**，而那个不一致没有任何注释解释过。
   * 现在改成**一张表出一个、挂在标题上**（逐格出的话 30 天档是 210 个 `≈`，
   * 那时它是装饰不是信号）。
   *
   * **变红条件**：把 `buildDayTable()` 里那两行 `approxTitleMark` 删掉。
   */
  it("`≈` 在表上出一次、且真的挂在标题节点里 —— 卡片带而表里沉默，是同一个数字两种说法", async () => {
    const h = await openUsage(respondWith(usageBody({ approximate: true })));
    const sec = h.section("usage");
    expect(approxCount(sec), "`≈` 的个数变了 —— 表上应当只出一个，卡片各一个").toBe(7);
    // ⚠️ **位置也要断言，不能只数个数**（收口复评）：上一版 append 到块容器
    //    ⇒ 子节点序是 `h3, div, span.approx`，`≈` 落在表格**下面**，
    //    而注释与用例名都写着「挂在标题上」——**改 append 目标那一行不会红**。
    let inHead = 0;
    for (const h3 of sec.querySelectorAll("h3")) {
      for (const sp of h3.querySelectorAll("span")) if (sp.classList.contains("approx")) inHead++;
    }
    expect(inHead, "`≈` 没挂在标题节点里 —— 注释和用例名说的是「挂在标题上」").toBe(1);
    // 反向锚：后端说这份数字不是近似值时，一个都不许出。
    const off = await openUsage(respondWith(usageBody({ approximate: false })));
    expect(approxCount(off.section("usage")), "approximate 为假时还在打 ≈").toBe(0);
  });

  /**
   * ⚠️⚠️⚠️ **收口复评：`≈` 挂到了一张「一个数字都没有」的表上，
   * 而这正是同一个提交里那条裁定禁止的事。**
   *
   * 上一版 `buildDayTable()` 在「这张表是空的」那条早退**之前**就无条件挂了 `≈`。
   * 实测（`days: null` / `note: "read_failed"` / `approximate: true`）：一张写着
   * 「这段区间的按天数据读不出来」的表，**下面挂着一个 `≈`**；
   * 而那一档下六张卡的 `≈` 反而都不出（`fillCell` 的 `"unknown"` 支提前 return）
   * ⇒ **全页唯一一个 `≈` 就挂在那张说「读不出来」的表上**（实测个数 = 1）。
   *
   * ⭐⭐ **立完一条裁定，回头 grep 一遍自己这一轮碰过的所有同型位置。**
   *
   * **变红条件**：把 `buildDayTable()` 里那两行 `approxTitleMark` 挪回早退之前。
   */

  it("读不出来的那一档：全页一个 `≈` 都没有 —— `≈` 是一句关于「下面那些数字」的话，而下面一个数字都没有", async () => {
    const h = await openUsage(respondWith(usageBody({
      days: null, total: null, shards: null, malformed: null,
      note: "read_failed", approximate: true,
    })));
    const sec = h.section("usage");
    // 前置条件：这一档确实是「读不出来」那一档。
    expect(sec.textContent).toContain("按天数据读不出来");
    expect(cards(sec)["usage.card.requests"], "前置条件：六张卡是 EM DASH").toBe(EM);
    expect(approxCount(sec), "全页唯一的 `≈` 挂在了一张说「读不出来」的表上").toBe(0);
  });

  /**
   * ⚠️⚠️ **收口复评：下钻那处 `≈` 上一轮零用例。**
   * 变异删掉 `buildDetail()` 里那两行 ⇒ **58/58 全绿**——那条定向复评的变红条件只写了
   * `buildDayTable` 那两行，`.approx` 计数用例又只开汇总页。
   * ⇒ 那条收口复评修完如果不补这一格，改完仍然无人守。
   *
   * **变红条件**：把 `buildDetail()` 里的 `approxTitleMark(marks)` 那两行删掉
   * ⇒ 第二句断言红。
   */
  it("下钻页也出一个 `≈`，而「这一天读不出来」时一个都不出 —— 上一轮这处零用例，删掉两行 58/58 全绿", async () => {
    const ok = await drill(detailBody());
    const secOk = ok.section("usage");
    // 汇总页 7 个（六卡 + 日表标题）+ 下钻标题 1 个 = 8。**手写字面量。**
    expect(approxCount(secOk), "下钻页的 `≈` 没出来（或多出来了）").toBe(8);

    // 那一天读不出来时：下钻那一个不许出，汇总那 7 个照旧。
    const gone = await drill(detailBody({
      hours: null, byModel: null, byProtocol: null,
      shards: null, malformed: null, note: "date_out_of_retention",
    }));
    const secGone = gone.section("usage");
    expect(secGone.textContent, "前置条件：三张表确实说了读不出来").toContain("这一天的分解读不出来");
    expect(approxCount(secGone), "这一天一个数字都没有，却还挂着 `≈`").toBe(7);
  });
});

describe("Token 卡的覆盖范围", () => {
  /**
   * **变红条件**：把 `buildCards` 里那条 tooltip 改成直接渲染
   * `coverage.join(" · ")`（裸 id）⇒ tooltip 里出现 `responses` 而不是
   *「OpenAI Responses」⇒ 第二句断言红。运维看不懂 `responses` 是哪个协议。
   */
  it("协议 id 换成 /admin/api/models 的 label —— 不许渲染裸 id，也不许在前端再写一张映射", async () => {
    const h = await openUsage(respondWith(usageBody()));
    let tip: string | null = null;
    for (const div of h.section("usage").querySelectorAll("div")) {
      if (div.getAttribute("data-i18n") === "usage.card.tokens") tip = div.getAttribute("title");
    }
    expect(tip, "Token 卡没有 tooltip").not.toBe(null);
    expect(tip).toContain("Anthropic Messages");
    expect(tip).toContain("OpenAI Responses");
    // 裸 id 不许出现（`responses` 是 id，`OpenAI Responses` 是 label —— 判据取
    // 那个只在 id 里出现的小写串）。
    expect(tip, "渲染了裸 id").not.toContain("anthropic");
  });

  /**
   * ⚠️⚠️ **这一格是变异 M-O 逼出来的，登记成因**：上一格用的 `tokensCoverage`
   * 夹具是 `["anthropic", "responses"]`，而把 `sec-usage.js` 里那一行
   * `const coverage = caps && caps.stats ? caps.stats.tokensCoverage : null;`
   * 换成写死的 `["anthropic", "responses"]` 之后，**42 条全绿、完整逃逸**
   * ——**第 1 种假阳性（夹具 A/B 同值）**：谁赢都通过。
   *
   * ⇒ 这一格让 capabilities 报一份**与任何「合理的写死值」都不一样**的覆盖范围
   *（只有 `gemini` 一条），于是「前端到底读没读那个字段」变得可观测。
   * 这是全局约束 15（同一份知识只许有一份）在本板块的机器信号。
   *
   * **变红条件**：把上面那一行换成任何一个写死的数组 ⇒ tooltip 里出现
   * 那份写死的名单而不是 `Google Gemini` ⇒ 下面两句同时红。
   */
  it("Token 卡的覆盖范围跟着 capabilities 走 —— 在前端写死一份就是第二份知识", async () => {
    const h = await openUsage((url) => {
      if (url.startsWith("/admin/api/capabilities")) {
        return {
          status: 200,
          body: { ...CAPS, stats: { ...CAPS.stats, tokensCoverage: ["gemini"] } },
        };
      }
      if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
      if (url.startsWith("/admin/api/usage")) return { status: 200, body: usageBody() };
      return { status: 200, body: {} };
    });
    let tip: string | null = null;
    for (const div of h.section("usage").querySelectorAll("div")) {
      if (div.getAttribute("data-i18n") === "usage.card.tokens") tip = div.getAttribute("title");
    }
    expect(tip, "没有跟着 capabilities 的 tokensCoverage 走").toContain("Google Gemini");
    expect(tip, "前端把覆盖范围写死了").not.toContain("Anthropic Messages");
    expect(tip, "前端把覆盖范围写死了").not.toContain("OpenAI Responses");
  });

  /**
   * **变红条件**：把 `tokensCoverageLabels` 的「一条解析不出来就整条退回 null」
   * 改成 `continue` ⇒ tooltip 变成半张名单 ⇒ 第二句断言红。
   */
  it("models 拉不到时 tooltip 换成「覆盖范围读不出来」，不给半张名单也不编一个缺省列表", async () => {
    const h = await openUsage((url) => {
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
      if (url.startsWith("/admin/api/models")) return { status: 500, body: {} };
      if (url.startsWith("/admin/api/usage")) return { status: 200, body: usageBody() };
      return { status: 200, body: {} };
    });
    let tip: string | null = null;
    for (const div of h.section("usage").querySelectorAll("div")) {
      if (div.getAttribute("data-i18n") === "usage.card.tokens") tip = div.getAttribute("title");
    }
    expect(tip).toContain("覆盖了哪几条协议这一次没读出来");
    expect(tip, "拉不到 models 却还是列出了协议名").not.toContain("Anthropic Messages");
  });
});

/**
 * ── `aria-pressed`：口径分段的选中态得读得出来 ───────────────────────────────────
 *
 * `.active` 只改颜色（外加一条加粗），读屏用户拿不到。
 * ⚠️ **这一组的创建点是一个三元的两支**（有 i18n key 的那支走 `elI18n`、
 * 表外档位那支走 `el` 并照实显示原值）——`aria-pressed` **两支都得有**。
 * 只补有 key 的那一支的话，最需要被读清楚的那颗（显示原值的那颗）反而成了唯一读不出来的。
 * 那一族由 `tests/unit/source-guards.test.ts` 的源码扫描拦；这一格拦「值不跟着走」。
 */
describe("时间范围分段的 aria-pressed 跟着点击走", () => {
  it("点 7d 那一颗：默认那一颗转 false、7d 转 true", async () => {
    const h = await openUsage(respondWith(usageBody()));
    const pick = (): FakeElement[] => {
      const out: FakeElement[] = [];
      for (const b of h.section("usage").querySelectorAll(".btn-toggle")) out.push(b);
      return out;
    };
    const btns = pick();
    // 期望值手写字面量：四档、顺序照 `RANGES`，默认停在第一档。
    expect(btns.map((b) => b.getAttribute("data-range")), "档位或顺序变了")
      .toEqual(["24h", "3d", "7d", "30d"]);
    expect(btns.map((b) => b.getAttribute("aria-pressed")), "首帧默认停在 24h")
      .toEqual(["true", "false", "false", "false"]);

    btns.find((b) => b.getAttribute("data-range") === "7d")!.click();
    await settle(12);
    // ⚠️ **重新取一次节点**：这一组每次 `render()` 重建按钮，握着旧引用读到的是上一帧。
    expect(
      pick().map((b) => b.getAttribute("aria-pressed")),
      "屏幕上换了档，aria-pressed 没跟着走 —— 读屏用户读到的是假的",
    ).toEqual(["false", "false", "true", "false"]);
  });
});
