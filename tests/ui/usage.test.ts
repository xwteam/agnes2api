import { describe, it, expect } from "vitest";
import {
  RANGES, DEFAULT_RANGE, rangeLabelKey, rangeToQuery,
  usageState, detailState, rowState, readSucceeded, avgLatency, cellKind, ratioKind,
  summaryCards, bucketCells,
  malformedKind, usageNoteKey, noteSeverity, dayRows, breakdownRows,
  tokensCoverageLabels, pendingTail,
  RESERVED_API_KEY_IDS, apiKeyRowLabelKey, apiKeyUsage,
} from "../../admin-ui/js/pure/usage.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { USAGE_NOTES } from "../../src/http/admin/handlers/usage.js";
import {
  USAGE_MASTER_BUCKET, USAGE_UNATTRIBUTED_BUCKET, USAGE_OTHER_BUCKET,
} from "../../src/core/admin/usage-stats.js";

/**
 * 用量板块的取值判定。
 *
 * **每一格的标题写清它防住了什么真实故障**，因为这个板块的全部难点是
 * 「今天真的是 0 次请求」「Tier-2 没开」「读不出来」「读到的全是坏分片」
 * 「开着、但这段区间一条分片都还没落盘」在面板上长得一模一样，而它们是五件事。
 */

/** 一个非零的桶。各条用例在它上面改一处。 */
const BUCKET = {
  requests: 100, success: 90, errors: 10,
  tokensIn: 4000, tokensOut: 2500,
  streamingRequests: 30, latencySum: 24_000, latencyCount: 80,
};

/** 零桶 —— 后端 `EMPTY_DAY` 的形状（`src/http/admin/handlers/usage.ts`）。 */
const ZERO = {
  requests: 0, success: 0, errors: 0, tokensIn: 0, tokensOut: 0,
  streamingRequests: 0, latencySum: 0, latencyCount: 0,
};

/** 一份「有数据」的 `GET /admin/api/usage` 响应。 */
function okBody(over: Record<string, unknown> = {}) {
  return {
    tier: "tier2", timezone: "UTC", approximate: true, generatedAt: 1_700_000_000_000,
    range: { from: 0, to: 86_399_999, clamped: false },
    days: [{ date: "2026-08-21", total: BUCKET }],
    total: BUCKET, shards: 3, malformed: 0,
    pending: { count: 0, ms: 0, budgetExhausted: false },
    note: null,
    ...over,
  };
}

describe("五态判定：四件事不许揉成一件", () => {
  /**
   * **变红条件（实测记在当时的变异表里）**：把 `usageState` 里
   * `if (r.tier === "off") return "off";` 那一支删掉 ⇒ Tier-2 关着的那一档
   * 落进 `days` 不是数组那一支、被判成 `unavailable`
   * ⇒ 面板对「统计没开」显示一条「读取失败」的红色横幅 + 重试按钮，
   * 而重试一万次也不会有数据。下面第一句断言当场红。
   */
  it("五种状态互不重叠 —— 『没开』『读不出来』『还没落盘』『真的是 0』『有数据』揉在一起就是撒谎", () => {
    // ① Tier-2 没开：后端把 days / total / shards / malformed 一起给 null。
    expect(usageState({
      tier: "off", range: { from: 0, to: 1, clamped: false },
      days: null, total: null, shards: null, malformed: null, pending: null, note: "tier2_off",
    })).toBe("off");

    // ② 读不出来：tier 仍然是 tier2，四个字段一起是 null。
    expect(usageState({
      tier: "tier2", range: { from: 0, to: 1, clamped: false },
      days: null, total: null, shards: null, malformed: null,
      pending: { count: 0, ms: 0, budgetExhausted: false }, note: "read_failed",
    })).toBe("unavailable");

    // ③ 读成功了，但这段区间一条分片都还没落盘（后端状态表第 ③ 行）。
    //    **这不是「真的没人用」**：Tier-2 攒够间隔才写一次，请求可能还在内存里。
    expect(usageState(okBody({
      days: [{ date: "2026-08-21", total: ZERO }], total: ZERO, shards: 0, malformed: 0, note: "no_shards",
    }))).toBe("no-shards");

    // ④ 有分片落过盘，盘里的请求数就是 0 —— 这一档才是「真的没人用」（后端状态表第 ④ 行）。
    expect(usageState(okBody({
      days: [{ date: "2026-08-21", total: ZERO }], total: ZERO, shards: 3, malformed: 0, note: null,
    }))).toBe("empty");

    // ⑤ 有数据。
    expect(usageState(okBody())).toBe("data");

    // ⑥ 整条响应都没拿到（网络断了 / JSON 解析失败）——同样是「我们不知道」。
    expect(usageState(null)).toBe("unavailable");
    expect(usageState(undefined)).toBe("unavailable");
    expect(usageState("nope")).toBe("unavailable");
  });

  /**
   * **`all_malformed` 那一档：读到了分片，但每一个都坏。**
   *
   * 后端在这一档下发的 `days` 是「每天一格全 0 桶」、`total` 也是零桶
   *（`src/http/admin/handlers/usage.ts` 的状态表第 ⑦ 行）。
   * **照 `total.requests === 0` 直接判 `empty` 的话，面板会在六张卡上写 `0`**
   * ——而我们对这段时间的用量一无所知。那是伪造 0，方向与「接口失败报 0」相同。
   *
   * **变红条件**：把 `usageState` 里 `if (malformedKind(r) === "all") return "unavailable";`
   * 删掉 ⇒ 这一格返回 `"no-shards"`（⑦ 的 `shards` 同样是 0）⇒ 断言红。
   * ⚠️ **那句早退排在 `no-shards` 那一支之前，也是这一格在钉**：顺序反过来的话，
   * 「读到的全是垃圾」会被说成「还没写进去」——同一份 0 换了一句假话而已。
   */
  it("分片全坏时是 unavailable 而不是 empty —— 那些 0 不是知识，写成 0 就是伪造", () => {
    const body = okBody({
      days: [{ date: "2026-08-21", total: ZERO }], total: ZERO,
      shards: 0, malformed: 5, note: "all_malformed",
    });
    expect(malformedKind(body)).toBe("all");
    expect(usageState(body)).toBe("unavailable");
    // 反向锚：**同一份响应只把 malformed 改成 0** ⇒ 它就落回「还没落盘」那一档。
    // 少了这一句，一个「恒返回 unavailable」的实现也会绿（第 5 种假阳性）。
    expect(usageState({ ...body, malformed: 0, note: "no_shards" })).toBe("no-shards");
  });

  /**
   * **`partial_malformed` 不归 `unavailable`**：读到的好分片是真的，只是不全。
   * 它由 `summaryCards().complete` 承担，见下面那一组。
   */
  it("分片部分坏时状态不变，只是数据被标成不完整 —— 全砍成 — 会让真实的那半凭空消失", () => {
    const body = okBody({ shards: 3, malformed: 2, note: "partial_malformed" });
    expect(malformedKind(body)).toBe("partial");
    expect(usageState(body)).toBe("data");
    expect(summaryCards(body).complete).toBe(false);
    // 反向锚：好分片一个都没坏时 complete 必须是 true，否则「恒 false」也全绿。
    expect(summaryCards(okBody()).complete).toBe(true);
  });

  /**
   * **状态判据必须与卡片除以的那个数同源。**
   *
   * `src/http/admin/handlers/usage.ts` 的 `total` 字段上方逐字写着
   * 「别把它写成恒等于 Σ`days`」——一个自报 `day` 与所在键对不上的分片
   * 会进 `total` 而进不了任何一格 `days`，方向是「`total` 只多不少」。
   * ⇒ 照 `days` 判状态、照 `total` 渲染卡片，就会得到
   * 「横幅说『这段时间没有请求』，而总请求数那张卡写着 100」。
   *
   * **变红条件**：把 `usageState` 改成
   * `r.days.some((d) => d && d.total && d.total.requests > 0) ? "data" : "empty"`
   * ⇒ 这一格返回 `"empty"` ⇒ 第二句断言红。
   */
  it("days 全是 0 而 total 不是 0 时判成 data —— total 只多不少，照 days 判会让横幅与卡片打架", () => {
    const body = okBody({ days: [{ date: "2026-08-21", total: ZERO }], total: BUCKET });
    expect(summaryCards(body).requests, "卡片读的是顶层 total").toBe(100);
    expect(usageState(body), "状态也必须读同一个 total").toBe("data");
  });
});

describe("「开着，但一条分片都还没落盘」是自己一档", () => {
  /** ③ 那一档的响应体：读成功了、每天一格全 0 桶、`shards` 是 0。 */
  function noShardsBody(over: Record<string, unknown> = {}) {
    return okBody({
      days: [{ date: "2026-08-21", total: ZERO }], total: ZERO,
      shards: 0, malformed: 0, note: "no_shards",
      pending: { count: 4, ms: 184_532, budgetExhausted: false },
      ...over,
    });
  }

  /**
   * **线上实测出来的自相矛盾：同一屏上两句话互相打脸。**
   *
   * 统计开着、打了几次请求（池空、全 503）之后打开这一页，后端回的是
   * `tier:"tier2"` / `shards:0` / `note:"no_shards"` / `pending.count > 0`，
   * 而这一档当时掉进 `empty` ⇒ 横幅说「这个部署确实没有记下任何用量」，
   * 紧挨着的尾巴说「还有 4 条计数没有落盘」。**前一句是假的。**
   *
   * **变红条件**：把 `usageState` 最后那一支换回 `return "empty";`
   *（也就是不分这一档）⇒ 第一句断言当场红。
   */
  it("开着但一条分片都没落盘不是 empty —— 尾巴刚说还有几条没落盘，横幅却说一条都没记下", () => {
    const body = noShardsBody();
    expect(usageState(body)).toBe("no-shards");
    // 装置自检：这一格的前提（那条尾巴真的会渲染）必须成立，否则「自相矛盾」是空的。
    expect(pendingTail(body), "pending 尾巴取不出来 ⇒ 这一格描述的那个矛盾根本不会出现")
      .toEqual({ count: 4, ms: 184_532, budgetExhausted: false });
    // 反向锚：**有分片落过盘、盘里就是 0** 才是「真的没人用」那一档。
    // 少了这一句，一个「requests 是 0 就恒返回 no-shards」的实现也会绿。
    expect(usageState(okBody({
      days: [{ date: "2026-08-21", total: ZERO }], total: ZERO, shards: 3, malformed: 0, note: null,
    })), "有分片落过盘的那一档被并进来了 —— 那一档确实是「答案就是零」").toBe("empty");
  });

  /**
   * ⚠️⚠️ **`pending.count === 0` 照样归这一档，这是本轮的一条硬裁定。**
   *
   * `pending` 是那个 sink 的**内存**状态，只反映**服务这一次请求的那个 isolate**：
   * · 别的 isolate 里可能正攒着；
   * · 一个在落盘之前就被回收的 isolate 把它那份直接带走了。
   * 两种情形下 `pending.count` 都是 0，而请求**真的发生过**。
   * ⇒ 拿 `pending` 当分档判据 = 在最查不出来的那一档上把假话说得更像真的。
   *
   * **变红条件**：在 `usageState` 那一支的判据上再 `&&` 一个「`pending.count` 是正数」
   *（= 「有尾巴才算还没落盘」）⇒ 第二句断言拿到 `"empty"` ⇒ 当场红。
   */
  it("pending.count 是 0 照样是这一档 —— pending 只是这一个 isolate 的内存，证明不了没人用过", () => {
    expect(usageState(noShardsBody()), "有尾巴时是这一档").toBe("no-shards");
    expect(
      usageState(noShardsBody({ pending: { count: 0, ms: 0, budgetExhausted: false } })),
      "尾巴是 0 就被判成「真的没人用」—— 被回收的 isolate 正是这个形状",
    ).toBe("no-shards");
    // 连 `pending` 整块都没有（后端那一档发 null）时同样不许改判。
    expect(usageState(noShardsBody({ pending: null }))).toBe("no-shards");
  });

  /**
   * ⚠️⚠️ **判据不许只认 `note`：`range_clamped` 压过 `no_shards`。**
   *
   * 优先级写在 `src/http/admin/handlers/usage.ts` 的 `usageHandler` 上方
   *（「`range_clamped` 仍然压过 `no_shards`」）⇒ 区间被夹过时，同一个部署拿到的
   * `note` 是 `range_clamped`，而 `shards` 仍然是 0。
   * **这条路正是老 bug 更难看的那一半**：它连横幅都会换成 `usage.empty`
   * 那句「答案就是零」（`no_shards` 至少还是 info 档、会把 `usage.empty` 压掉）。
   *
   * **变红条件**：把判据里的 `finite(r.shards) === 0 ||` 删掉（只认 `note`）
   * ⇒ 第一句断言返回 `"empty"` ⇒ 当场红。
   */
  it("区间被夹过时仍然是这一档 —— note 那一格被 range_clamped 占掉，只认 note 会让这一档整个消失", () => {
    expect(usageState(noShardsBody({
      range: { from: 0, to: 86_399_999, clamped: true }, note: "range_clamped",
    })), "只认 note ⇒ 被夹过的那条路上它又变回「真的没人用」").toBe("no-shards");
    // 反向锚：`shards` 那一半也不许被删。只认 `shards` 会漏掉后端哪天换 code 的那一天。
    expect(usageState(noShardsBody({ shards: null })), "note 那一半被删了").toBe("no-shards");
  });

  /**
   * ⚠️⚠️ **`tier === "tier2"` 这一半也是判据的一部分，不是随手写的防御**（评审第 2 轮）。
   *
   * 评审实测：把这一半删掉，用量那两份用例（本文件与它的 DOM 侧）当时共 76 格**全绿**
   * —— 也就是没有任何东西在盯它。补上这一格。
   *
   * **它为什么必须留着**：这一档换上去的那句话（`usage.note.noShards`）
   * **逐字点名了 Tier-2 的落盘机制**（「Tier-2 是攒够一个落盘间隔才写一次的」）。
   * `tier` 是别的值时我们并不知道那个部署按什么节奏落盘，照样说这句话就是拿一条
   * **我们没有的知识**去解释屏幕上的 0 —— 与这一档立案要挡的是同一种毛病，
   * 只是这一次编的是「为什么还没落盘」而不是「有没有人用」。
   * ⇒ 认不出来的 `tier` 退回 `empty`（`tier: "off"` 那一支在更上面早退，不走这里）。
   *
   * ⚠️ 今天后端只发得出 `"off"` / `"tier2"` 两个值
   *（`src/http/admin/handlers/usage.ts` 的 `usageHandler`：`const tier = wiring === null ? "off" : "tier2";`），
   * 所以这一格钉的是**面板对没见过的 tier 的态度**，不是今天走得到的一条路。
   *
   * **变红条件**（真跑过）：把 `usageState` 那一支的 `r.tier === "tier2" &&` 删掉
   * ⇒ 这一格当场红，报文逐字是 `expected 'no-shards' to be 'empty'`；
   * 同一次变异下另外 101 格全绿 —— 在这一格之前，那一半确实一个人都没盯。
   */
  it("认不出来的 tier 不归这一档 —— 那句话点名了 Tier-2 的落盘机制，别的 tier 上我们没有这条知识", () => {
    expect(
      usageState(noShardsBody({ tier: "tier3" })),
      "面板拿一条没有的知识去解释屏幕上的 0",
    ).toBe("empty");
    // `tier` 整个不是字符串时同样退回 —— 「读不懂」不等于「就是 tier2」。
    expect(usageState(noShardsBody({ tier: null })), "tier 读不懂时被当成了 tier2").toBe("empty");
  });

  /**
   * **这一档下六张卡仍然写 `0`，不是 EM DASH。**
   *
   * `0` 在这里是真的 —— **已经落盘的就是 0 条**，而横幅负责说清「可能只是还没落下来」。
   * 换成 EM DASH 就是把「真的没人用」说成「数据丢了」，方向相反的同一种谎。
   * ⇒ `cellKind` 的黑名单**刻意**不收这一档；
   * `readSucceeded` 那个白名单则**必须**收（表里那句话该是「没有可以列出的日子」）。
   *
   * ⚠️ **`rowState` 原样往下传这一档（终检回填），而日表那一行照旧写 `0`**：
   * 有数字那几格走的是 `cellKind(…, 0)` ⇒ `"value"`，与压成 `"data"` 时逐格相同；
   * 差别只在**没有数字可写**的那一列（平均延迟）的 tooltip 上，理由见
   * `rowState` 上方那段。这里连着 `cellKind` 一起断言，钉的是「仍然写 0」这件事本身。
   *
   * **变红条件**：把 `cellKind` 的第一行改成
   * `if (state === "off" || state === "unavailable" || state === "no-shards") return "unknown";`
   * ⇒ 第一句与那条串起来的断言红；把 `readSucceeded` 里 `|| state === "no-shards"`
   * 删掉 ⇒ 「读成功了」那句红；把 `rowState` 改回
   * `return obj(bucket) === null ? "unavailable" : "data";`（真跑过）
   * ⇒ 这一格 + `tests/ui/dom/usage-section.test.ts` 的
   * 「这一档下 EN DASH 那几格的 tooltip 不许说「没有可用的样本」—— 横幅刚说完还有 4 条没落盘」共 2 格红。
   */
  it("这一档的数字格仍然是 0、表里那句话仍然是「没有可以列出的日子」—— 画成 EM DASH 是反方向的同一种谎", () => {
    expect(cellKind("no-shards", 0), "「已经落盘的就是 0 条」是真的，别画成「我们不知道」").toBe("value");
    expect(rowState("no-shards", { ...ZERO }), "这一档没往行状态里传，日表那一列的 tooltip 会退回上一句").toBe("no-shards");
    expect(
      cellKind(rowState("no-shards", { ...ZERO }), 0),
      "日表那一行不再写 0 了 —— 传下去的档位把「已经落盘的就是 0 条」擦掉了",
    ).toBe("value");
    expect(readSucceeded("no-shards"), "读成功了 —— 表里那句话不该是「读不出来」").toBe(true);
    // 反向锚：真「读不出来」的那两档不许跟着一起被放行。
    expect(cellKind("unavailable", 0)).toBe("unknown");
    expect(readSucceeded("unavailable")).toBe(false);
  });

  /**
   * ⚠️⚠️ **同一个谎的第三处：没有数字可写的那几格，tooltip 里说的是「没有样本」。**
   *
   * 上一版 `cellKind` 只把 `off` / `unavailable` 判成 `"unknown"`，
   * `no-shards` 于是掉进 `"none"` ⇒ 成功率 / 错误率 / 平均延迟三张卡（与日表
   * 对应列）挂的是 `usage.cell.noneTip`：「这一次读成功了，只是这段时间没有
   * 可用的样本。」**而同一屏的横幅刚说完「还有 N 条计数没有落盘」** ——
   * 样本是有的，只是没落盘；这一档下「有没有样本」正是分不出来的那件事。
   *
   * ⚠️ **它换的是 tooltip，不是字形**：第四档照旧渲染 EN DASH，
   * 上面那一格（「六张卡仍然写 0」）与 `tests/ui/dom/usage-section.test.ts`
   * 同名那一格钉的都是字形，两边在这一改动下都不动。
   *
   * **变红条件**（两条都真跑过，跑的是那四份共 131 格，每条只红 2 格）：
   * · 把 `cellKind` 末行改回 `return finite(value) === null ? "none" : "value";`
   *   ⇒ 这一格 + `tests/ui/dom/usage-section.test.ts` 的
   *   「这一档下 EN DASH 那几格的 tooltip 不许说「没有可用的样本」—— 横幅刚说完还有 4 条没落盘」；
   * · 把 `ratioKind` 里传给 `cellKind` 的 state 换成
   *   `state === "no-shards" ? "empty" : state` ⇒ **同样这两格**
   *   ——比率那两张卡与延迟那张卡走的是两条路，缺一条这一格就漏掉两张卡。
   */
  it("no-shards 下没有数字可写的那几格换一档 —— 上一版的 tooltip 在说「没有可用的样本」", () => {
    // 平均延迟：这一档下 `avgLatency` 交出来的是 null（没有落盘的样本可算）。
    expect(
      cellKind("no-shards", avgLatency({ ...ZERO })),
      "延迟那一格还在说「这段时间没有可用的样本」",
    ).toBe("none-no-shards");
    // 比率格转调 `cellKind`，第四档必须跟着走（成功率 / 错误率两张卡）。
    expect(ratioKind("no-shards", 0), "比率那两格没跟着换档").toBe("none-no-shards");
    // ⚠️ **两档必须真的不一样**：同一个 null 在 `empty` 与 `no-shards` 下
    //    分别是「确知没有样本」与「不知道有没有」，挂同一句话就是把两件事说成一件。
    expect(cellKind("no-shards", null)).not.toBe(cellKind("empty", null));
    // 反向锚三条：别为了分出第四档把另外三档一起改坏。
    expect(cellKind("empty", null), "「确知没有样本」那一档被顺手改掉了").toBe("none");
    expect(cellKind("data", avgLatency({ ...ZERO })), "有数据时零样本那一格被改掉了").toBe("none");
    expect(cellKind("no-shards", 0), "有数字可写时不许换档").toBe("value");
    expect(ratioKind("unavailable", null), "读不出来那一档被顺手改掉了").toBe("unknown");
  });

  /**
   * ⚠️⚠️ **文案判据：第四档那句 tooltip 里，五种语言都不许说「这段时间没有样本」。**
   *
   * 它要表达的是**分不出来**：读成功了，但这段区间一条分片都还没落盘，
   * 「真的没人用」与「刚发生的还没写进去」在今天的数据上无法区分。
   * ⇒ 两个方向都不许说死 —— 不许说「没有样本」，也不许反过来断言「数据丢了」。
   * 这一格只守前一个方向（后一个方向没有可枚举的禁词，留给评审，
   * 与 `usage.note.noShards` 那张矩阵同一条边界）。
   *
   * ⚠️ **禁词表按语言排成矩阵**，与本仓别处那几张同形：拉平之后
   *「某个概念在某种语言下一个说法都没有」在表面上看不出来。
   *
   * ⚠️⚠️ **反向控制拿的是活的 `usage.cell.noneTip`，不是抄一份死字符串**：
   * 那一句正是这个新 key 存在的理由（它就该说「没有样本」），
   * 用它当反例同时钉住了「两个 key 不许说同一句话」。它哪天被改到不含任何禁词，
   * 这张表也就该重新审一遍 —— 那时候这一格红是对的。
   *
   * **变红条件**（真跑过）：把 `usage.cell.noneNoShardsTip` 的中文那一版改回
   * `usage.cell.noneTip` 的原文 ⇒ 红 2（这一格 + `tests/ui/dom/usage-section.test.ts`
   * 的「这一档下 EN DASH 那几格的 tooltip 不许说「没有可用的样本」—— 横幅刚说完还有 4 条没落盘」
   * 那一格），这一格的报文逐字
   * `expected [ 'zh-CN：「没有可用的样本」' ] to deeply equal []` —— **点名到语言**。
   */
  it("no-shards 那一格的 tooltip 里，五种语言都不许说这段时间没有样本", () => {
    const BANNED: Record<string, string[]> = {
      "zh-CN": ["没有可用的样本", "没有样本"],
      "zh-TW": ["沒有可用的樣本", "沒有樣本"],
      en: ["no samples", "without samples"],
      ja: ["サンプルがありません", "サンプルがない"],
      ko: ["샘플이 없습니다", "사용할 샘플"],
    };
    const dict = I18N as Record<string, Record<string, string>>;
    const value = dict["usage.cell.noneNoShardsTip"];
    expect(value, "`usage.cell.noneNoShardsTip` 没了 —— 下面整格会空转").toBeTruthy();
    const hits: string[] = [];
    for (const [lang, words] of Object.entries(BANNED)) {
      const text = value![lang] ?? "";
      // 非空锚：每一种语言都得真有一句话，否则「不含禁词」是恒真的。
      expect(text.length, `${lang} 那一格是空的`).toBeGreaterThan(0);
      for (const w of words) if (text.includes(w)) hits.push(`${lang}：「${w}」`);
    }
    expect(hits, `这一句又在说「没有样本」了：\n${hits.join("\n")}`).toEqual([]);
    // ⚠️ **反向控制**：禁词表本身不许是死的。`usage.cell.noneTip` 说的正是这件事，
    //    它喂进同一条判据必须**每一种语言都被点名**。
    const none = dict["usage.cell.noneTip"];
    expect(none, "`usage.cell.noneTip` 没了 —— 反向控制会空转").toBeTruthy();
    for (const [lang, words] of Object.entries(BANNED)) {
      expect(
        words.some((w) => (none![lang] ?? "").includes(w)),
        `${lang} 的禁词一条都对不上 usage.cell.noneTip —— 这一格在空转`,
      ).toBe(true);
    }
  });

  /**
   * ⚠️⚠️ **文案判据：这一句里不许再出现「没有记下任何用量」那一族断言。**
   *
   * 它上一版五种语言逐句都在宣称这件事（中文「确实没有记下任何用量」、
   * 英文 `genuinely recorded no usage`），而那是假的。
   * **禁词表按语言排成矩阵**，与本仓别处那几张同形：拉平之后
   *「某个概念在某种语言下一个说法都没有」在表面上看不出来，
   * 而那正是这条红线最容易失守的方式（简体那一格红、繁体那一格绿）。
   *
   * ⚠️ **它守的是「不许说这一句」，不守「译文准不准」**：换个同义说法它抓不住，
   * 那一档留给评审 —— 与 `scripts/lib/unverified-claims.mjs` 文件头那条边界同源。
   *
   * **变红条件**：把 `usage.note.noShards` 改回那句宣称 ⇒ 当场红。实测跑了三轮
   *（中文那一版单独一次、英文那一版单独一次、繁中 + 日 + 韩三种一起一次），
   * 五种语言在报文里逐条都被点名。
   */
  it("no-shards 那句文案里，五种语言都不许宣称这个部署没有记下任何用量", () => {
    const BANNED: Record<string, string[]> = {
      "zh-CN": ["没有记下任何用量", "确实没有记下"],
      "zh-TW": ["沒有記下任何用量", "確實沒有記下"],
      en: ["recorded no usage", "genuinely recorded"],
      ja: ["使用量を記録していません", "実際に使用量を"],
      ko: ["사용량을 기록하지 않았습니다", "실제로 사용량을"],
    };
    const value = (I18N as Record<string, Record<string, string>>)["usage.note.noShards"];
    expect(value, "`usage.note.noShards` 没了 —— 下面整格会空转").toBeTruthy();
    // 非空锚：每一种语言都得真有一句话，否则「不含禁词」是恒真的。
    for (const lang of Object.keys(BANNED)) {
      expect((value![lang] ?? "").length, `${lang} 那一格是空的`).toBeGreaterThan(0);
    }
    const hits: string[] = [];
    for (const [lang, words] of Object.entries(BANNED)) {
      for (const w of words) if ((value![lang] ?? "").includes(w)) hits.push(`${lang}：「${w}」`);
    }
    expect(hits, `这一句又在宣称「没有记下任何用量」了：\n${hits.join("\n")}`).toEqual([]);
    // ⚠️ **反向控制**：禁词表本身不许是死的。上一版那句原文喂进同一条判据必须被点名，
    //    否则「一个都没命中」证明不了任何事（第 5 种假阳性）。
    const OLD = {
      "zh-CN": "读成功了，这段区间里一个分片都没有——这个部署确实没有记下任何用量。",
      "zh-TW": "讀成功了，這段區間裡一個分片都沒有——這個部署確實沒有記下任何用量。",
      en: "The read succeeded and there were no shards at all in this range — this deployment genuinely recorded no usage.",
      ja: "読み取りには成功しましたが、この期間にシャードが 1 件もありません。このデプロイは実際に使用量を記録していません。",
      ko: "읽기는 성공했지만 이 구간에 샤드가 하나도 없습니다. 이 배포는 실제로 사용량을 기록하지 않았습니다.",
    } as const;
    for (const [lang, words] of Object.entries(BANNED)) {
      expect(
        words.some((w) => OLD[lang as keyof typeof OLD].includes(w)),
        `${lang} 的禁词一条都对不上上一版那句原文 —— 这一格在空转`,
      ).toBe(true);
    }
  });

  /**
   * **Tier-2 那条 `≈` tooltip 要有 Tier-1 的诚实度。**
   *
   * Tier-1 那一侧（`keys.approxTip`）一直明写着「isolate 在此之前被回收时这一段会丢」，
   * 而 Tier-2 这一侧上一版只说「还有一段未落盘窗口」——读起来像「等一会儿就补上」，
   * 而它可能永远补不上。同一页上两种诚实度，低的那一种就是这一页的实际诚实度。
   *
   * ⚠️ **判据是「两条都说了『会丢』这件事」，不是「两条文案相同」**：它们的主语
   *（池计数 / 用量分片）与那个时间常量都不是一回事，写成逐字比对会红在一件正确的改动上。
   *
   * ⚠️⚠️ **名单不许写死**（评审第 2 轮）：上一版这里写死了三条
   *（`usage.approxTip` / `usage.approxTipUnknown` / `keys.approxTip`），而
   * `ov.usage.approxTip` 与 `ak.usage.tip` 说的是**同一个**未落盘窗口、当时都还没说
   * 「会丢」—— 名单是这条红线**唯一**的守卫，写死就等于把名单外的入口放生。
   * ⇒ 带 `approxTip` 的 key **从字典里现扫**（将来任何一条 `*.approxTip` 出生即入网），
   * 名字对不上这条规律的入口（`ak.usage.tip`）另列，并由下面那条自检钉住扫出来的
   * 那一组真的含着今天已知的四条 —— 否则正则哪天扫不着东西，这一格会静悄悄空转。
   *
   * **变红条件**（都真跑过）：删 `usage.approxTip` 中文那一版的后半句 ⇒ 红，报文点名
   * `usage.approxTip` 的 `zh-CN`；删 `ak.usage.tip` 中文那半句 ⇒ 红且点名 `ak.usage.tip`；
   * 删 `ov.usage.approxTip` 中文那半句 ⇒ 红且点名 `ov.usage.approxTip`。
   */
  it("Tier-2 的 ≈ tooltip 与 Tier-1 一样明写「这一段会丢」—— 只说「还没落盘」会被读成「等一会儿就补上」", () => {
    const LOSS: Record<string, string[]> = {
      "zh-CN": ["会丢"],
      "zh-TW": ["會遺失", "會丟"],
      en: ["is lost", "are lost"],
      ja: ["失われます"],
      ko: ["사라집니다", "손실"],
    };
    const dict = I18N as Record<string, Record<string, string>>;
    // 现扫：名字里带 `approxTip` 的都算这一族。
    const scanned = Object.keys(dict).filter((k) => k.includes("approxTip")).sort();
    // 自检：正则哪天扫不着东西（改名 / 重构）时这一格必须红，而不是空转过去。
    for (const known of ["usage.approxTip", "usage.approxTipUnknown", "keys.approxTip", "ov.usage.approxTip"]) {
      expect(scanned, `${known} 没被扫进来 —— 这一格在空转`).toContain(known);
    }
    // 名字对不上那条规律、但说的是同一个未落盘窗口的入口，另列。
    for (const key of [...scanned, "ak.usage.tip"]) {
      expect(dict[key], `${key} 没了 —— 这一格会空转`).toBeTruthy();
      for (const [lang, words] of Object.entries(LOSS)) {
        const text = dict[key]![lang] ?? "";
        expect(text.length, `${key} 的 ${lang} 那一格是空的`).toBeGreaterThan(0);
        expect(
          words.some((w) => text.includes(w)),
          `${key} 的 ${lang} 没说「isolate 被回收时这一段会丢」`,
        ).toBe(true);
      }
    }
  });
});

describe("整块的结论必须往下传到每一张表（评审那条的根因）", () => {
  /**
   * ⚠️⚠️⚠️ **两张表原来各自写 `row.total === null ? "unavailable" : "data"`
   * ——完全不看整块状态**，于是 `usageState` 判出来的 `unavailable`
   * 一步都没往下传：`all_malformed` 时六张卡全是 EM DASH，
   * 而紧挨着的日表把同一段区间写成「请求 0 次」。
   *
   * ⭐ **根因是上一处修复本身**：为了让卡片别写 `0` 而加的早退，
   * 把那份 `0` 留给了下一个消费者。判据收进 `rowState()` 之后，
   * 再加第三张表时它是必经之路。
   *
   * **变红条件**：把 `rowState` 的第一行
   * `if (state === "off" || state === "unavailable") return "unavailable";` 删掉
   * ⇒ 整块读不出来时每一行又变回 `"data"` ⇒ 第一句断言红。
   */
  it("整块读不出来时每一行都读不出来 —— 结论不往下传，同一份 0 只是挪到了下一屏", () => {
    const zeroBucket = { ...ZERO };
    // ⚠️ **同一个桶、两种整块状态，必须给出不同的行状态**：`all_malformed`
    //    那一档的桶就是一个货真价实的 0 桶，光看桶分不出来。
    expect(rowState("unavailable", zeroBucket)).toBe("unavailable");
    expect(rowState("empty", zeroBucket)).toBe("data");
    expect(rowState("unavailable", zeroBucket)).not.toBe(rowState("empty", zeroBucket));
    expect(rowState("off", zeroBucket)).toBe("unavailable");
    // 整块读成功了、而这一行的桶读不回来：那也是「这一行我们不知道」，不是 0。
    expect(rowState("data", null)).toBe("unavailable");
    expect(rowState("data", zeroBucket)).toBe("data");

    // 串起来：同一个 0 桶在两种整块状态下渲染成两种结局。
    expect(cellKind(rowState("unavailable", zeroBucket), 0)).toBe("unknown");
    expect(cellKind(rowState("empty", zeroBucket), 0)).toBe("value");
  });

  /**
   * **单日下钻那一份的整块状态（评审点名的「第三屏」）。**
   *
   * 分片全坏时 `mergeDayShards` 什么都合不出来 ⇒ 三个 map 都是空的
   * ⇒ 三张分解表都会说「这一天没有可以分解的记录」，而事实是我们什么都不知道。
   *
   * **变红条件**：把 `detailState` 里的
   * `if (malformedKind(r) === "all") return "unavailable";` 删掉。
   */
  it("单日下钻：分片全坏 / 读不出来 / 落在保留期外都是 unavailable —— 空 map 不许被说成「这一天没有记录」", () => {
    const emptyMaps = { hours: {}, byModel: {}, byProtocol: {} };
    const base = { tier: "tier2", date: "2026-08-21", shards: 2, malformed: 0, ...emptyMaps };
    // 读成功了、这一天真的没有流量：空 map **不是**读不出来。
    expect(detailState(base)).toBe("data");
    // 分片全坏：map 同样是空的，但我们一无所知。
    expect(detailState({ ...base, shards: 0, malformed: 4, note: "all_malformed" })).toBe("unavailable");
    // 读不出来 / 落在保留期外：三个 map 整块是 null。
    expect(detailState({
      ...base, hours: null, byModel: null, byProtocol: null,
      shards: null, malformed: null, note: "read_failed",
    })).toBe("unavailable");
    expect(detailState({
      ...base, hours: null, byModel: null, byProtocol: null,
      shards: null, malformed: null, note: "date_out_of_retention",
    })).toBe("unavailable");
    expect(detailState({ ...base, tier: "off", hours: null, note: "tier2_off" })).toBe("off");
    expect(detailState(null)).toBe("unavailable");
    // ⚠️ **空 map 与 null map 必须分得开**，否则上面第一句与第三句会撞在一起。
    expect(detailState(base)).not.toBe(detailState({ ...base, hours: null }));
  });

  /**
   * ⚠️⚠️ **定向复评：两张表「空」的判据必须都写成保守的那一侧。**
   *
   * 上一版日表写的是 `state === "unavailable" ? 不可用 : 空`（方向反的），
   * 分解表写的是 `state === "data" ? 空 : 不可用`（方向对的）。
   * ⇒ `usageState` 哪天多一档，日表那一档会**默认落到「没有可以列出的日子」**
   * ——也就是**默认说假话**，而分解表默认说「读不出来」——保守。
   *
   * 这一格拿一个**今天不存在的状态**当探针，把「默认往哪边倒」变成可观测的。
   * ⚠️ 它断言的不是 `usageState` 会产出这个值（它不会），而是
   * **两张表面对一个不认识的状态时都必须往「我们不知道」那边倒**。
   */
  it("readSucceeded 是白名单：不认识的状态一律判成「没读成功」—— 黑名单会让明天新加的那一档默认说假话", () => {
    // 今天在用的每一档，逐个手写锚死。
    expect(readSucceeded("data")).toBe(true);
    expect(readSucceeded("empty")).toBe(true);
    // ⚠️ 「那条『明天多一档』真的发生了」的那一档：它读成功了，只是一条分片都没落盘。
    expect(readSucceeded("no-shards")).toBe(true);
    expect(readSucceeded("unavailable")).toBe(false);
    expect(readSucceeded("off")).toBe(false);
    // ⚠️⚠️ **这一句才是它存在的理由**：拿一个今天不存在的状态当探针。
    //    黑名单实现（`state !== "unavailable"`）在上面几句上**逐句等价**，
    //    只在这一句上分叉 —— 它会返回 true ⇒ 表会说「没有可以列出的日子」，
    //    也就是对一个自己都不认识的状态断言「我们知道答案是没有」。
    expect(readSucceeded("some_state_added_later"), "不认识的状态被当成了「读成功了」").toBe(false);
    expect(readSucceeded(undefined)).toBe(false);
    expect(readSucceeded(null)).toBe(false);
  });

  /**
   * **`bucketCells` 是从 `summaryCards` 里拆出来的，拆它的理由是一个真缺陷。**
   *
   * 两张表原来这样取数：`summaryCards({ total: row.total, shards: 0, malformed: 0 })`
   * ——**那两个 `0` 是前端凭空写死的诚实信号**（全局约束 10）。
   * 拆开之后「取哪六个数」对着一个桶问、「完不完整」只能对着整份响应问，
   * 谁都不必再捏一个假响应。
   */
  /**
   * ⚠️⚠️⚠️ **定向复评：一个「只在另一条端点上成立」的判据，
   * 在另一条端点上不会报错，它只是安静地永远为假。**
   *
   * `summaryCards().complete` 是拿 `total` 算的（`total === null ? true : …`），
   * 而 **`GET /admin/api/usage/:date` 的响应里根本没有 `total` 字段**
   *（`src/http/admin/handlers/usage.ts` 的 `usageDateHandler` 返回的是
   * `hours` / `byModel` / `byProtocol` / `shards` / `malformed`）
   * ⇒ 在那条端点上 `complete` **恒为 true**，拿它当「缺没缺块」的判据
   * 会让下钻的「不完整」标记**结构性地永不渲染**。
   * 上一轮就是这么写的，而那次变异（把 `keyCell(row.key, marks)` 改成 `null`）
   * **624 全绿完整逃逸**——因为那个 `marks` 本来就是死的。
   *
   * ⇒ 这一格**正面把那个陷阱钉下来**：不是「别这么写」的一句注释，
   * 而是一条「这么写就是错的」的可执行断言。
   *
   * **变红条件**：给 `summaryCards` 加一条「`total` 缺席时退回读 `malformedKind`」
   * 的兜底 ⇒ 第二句断言红。**那正是不该做的修法**——`complete` 的语义就是
   * 「顶层合计那份数据完不完整」，让它去回答一条没有顶层合计的端点是越界。
   */
  it("summaryCards().complete 在单日下钻那份响应上恒为 true —— 它读的是 total，而那条端点没有 total，拿它当「缺没缺块」的判据是结构性错误", () => {
    // 一份 `:date` 形状的响应：**没有 total**，而分片确实一部分坏了。
    const detail = {
      tier: "tier2", date: "2026-08-21", note: "no_request_detail",
      hours: {}, byModel: {}, byProtocol: {}, shards: 4, malformed: 2,
    };
    expect(malformedKind(detail), "字段说得清清楚楚：一部分分片坏了").toBe("partial");
    expect(summaryCards(detail).complete, "而 complete 说「完整」—— 它读的是不存在的 total").toBe(true);
    // ⚠️ **两者在这条端点上恒相反**，所以判据只能取前者。
    expect(summaryCards(detail).complete).not.toBe(malformedKind(detail) === "none");

    // 对照：汇总端点**有** total，那里两者是一致的 —— 说明分歧来自端点形状，
    // 不是来自 `summaryCards` 写错了。
    const summary = { ...okBody(), shards: 4, malformed: 2 };
    expect(malformedKind(summary)).toBe("partial");
    expect(summaryCards(summary).complete).toBe(false);
  });

  it("bucketCells 只回答「取哪六个数」，一个诚实信号都不产出 —— 捏一份假响应去骗过入参形状就是写死诚实信号", () => {
    const b = bucketCells(BUCKET);
    expect(Object.keys(b).sort()).toEqual([
      "errors", "latencyMs", "requests", "streamingRequests", "success", "tokensIn", "tokensOut",
    ]);
    // 期望值手写字面量。
    expect(b.requests).toBe(100);
    expect(b.latencyMs).toBe(300);
    expect(bucketCells(null).requests).toBe(null);
    // `summaryCards` 在同一个桶上给出逐格相同的六个数（它就是拿 bucketCells 算的）。
    const c = summaryCards(okBody());
    for (const k of ["requests", "success", "errors", "tokensIn", "tokensOut", "streamingRequests", "latencyMs"]) {
      expect((c as Record<string, unknown>)[k], `${k} 两处对不上`).toBe((b as Record<string, unknown>)[k]);
    }
  });
});

describe("empty 与 unavailable 在单元格上必须长得不一样", () => {
  /**
   * **前者是『我们知道答案是零』，后者是『我们不知道』，画成同一个 `—` 就是把
   * 两件事说成一件。**
   *
   * 判据全在 `cellKind` / `ratioKind` 里（板块只做 `kind === "none" ? EN : …`），
   * 不许让板块文件自己目测。
   *
   * **变红条件**：把 `cellKind` 的第一行
   * `if (state === "off" || state === "unavailable") return "unknown";` 删掉
   * ⇒ `unavailable` 态下 `value` 是 `null` ⇒ 返回 `"none"` ⇒ 与 `empty` 态
   * **完全相同** ⇒ 下面那两句对照断言红。
   */
  it("empty 与 unavailable 的渲染判据必须可区分 —— 前者知道答案是零，后者不知道", () => {
    // 计数类：empty 态下值是真实的 0 ⇒ "value" ⇒ 板块写 `0`。
    expect(cellKind("empty", 0)).toBe("value");
    // 计数类：unavailable 态下整块是 null ⇒ "unknown" ⇒ 板块写 EM DASH。
    expect(cellKind("unavailable", null)).toBe("unknown");
    // ⚠️ **同一个 0 在两个状态下必须给出不同的结局**：整块读不出来时哪怕
    //    某个字段碰巧是 0，也不许当成「我们知道是零」。
    expect(cellKind("unavailable", 0)).toBe("unknown");
    expect(cellKind("empty", 0)).not.toBe(cellKind("unavailable", 0));

    // 比率类：empty 态分母是 0 ⇒ "none"（EN DASH），unavailable ⇒ "unknown"（EM DASH）。
    expect(ratioKind("empty", 0)).toBe("none");
    expect(ratioKind("unavailable", null)).toBe("unknown");
    expect(ratioKind("empty", 0)).not.toBe(ratioKind("unavailable", null));
    // 有分母时才是 value。
    expect(ratioKind("data", 100)).toBe("value");
    // 负分母与 0 同档：`fmtPercent` 那条「分母 <= 0 返回 —」的另一面。
    expect(ratioKind("data", -1)).toBe("none");

    // Tier-2 没开时六张卡与 unavailable 同档（都是「我们不知道」）——
    // 「没开」这件事由顶部那张说明卡说，不由单元格说。
    expect(cellKind("off", null)).toBe("unknown");
  });

  /**
   * **变红条件**：把 `avgLatency` 的 `c <= 0` 改成 `c < 0`
   * ⇒ 零样本时走 `Math.round(0 / 0)` = `NaN` ⇒ 第一句断言红。
   */
  it("零样本的平均延迟返回 null —— 没有样本不等于零延迟", () => {
    expect(avgLatency({ ...ZERO })).toBe(null);
    expect(avgLatency({ latencySum: 24_000, latencyCount: 80 })).toBe(300);
    expect(avgLatency(null)).toBe(null);
    expect(avgLatency({ latencySum: 1, latencyCount: Number.NaN })).toBe(null);
    // `latencySum` 缺席同样是「算不出来」，不是 0。
    expect(avgLatency({ latencyCount: 5 })).toBe(null);

    // **在 data 态下零样本走的是 "none"（EN DASH）而不是 "unknown"（EM DASH）**：
    // 这一次读成功了，我们确实知道「没有延迟样本」，那不是读取失败。
    expect(cellKind("data", avgLatency({ ...ZERO }))).toBe("none");
  });
});

describe("档位 → (from, to)：差一天会让那句警告永久常驻", () => {
  /**
   * **契约是 `from = to − (N − 1) × 86400000`**，由
   * `tests/contract/admin-usage.test.ts` 的
   * 「四个档位按 from = to − (N−1) 天 发：clamped 全是 false；按 N 天发：30d 那一档恒为 true」
   * 那一格双向钉着。
   *
   * ⚠️ **当时简报给的示例代码写的是 `nowMs - days * 86400000`**
   * ——那会让 `30d` 每一次都 `range_clamped`。**下面那句 `not.toBe(2_592_000_000)`
   * 就是钉住这一条的**：期望值全部手写字面量，不从 `DAY_MS` 推导（第 6 种假阳性）。
   *
   * **变红条件**：把 `(days - 1)` 改回 `days` ⇒ 30d 那一档的跨度变成
   * `2592000000` ⇒ 第二句与第三句同时红。
   */
  it("30d 的区间正好是 29 × 86400000，且只发 from / to 两个参数 —— 参数名发错在真实请求 URL 上才看得见", () => {
    const now = 1_700_000_000_000;
    const q = rangeToQuery("30d", now) as { from: number; to: number };
    expect(Object.keys(q), "多发一个 days= 服务端一个字都不认").toEqual(["from", "to"]);
    expect(q.to).toBe(1_700_000_000_000);
    // 手写字面量：29 × 86400000。
    expect(q.to - q.from).toBe(2_505_600_000);
    // 手写字面量：30 × 86400000 —— **发成这个数，30d 那一档每一次都被夹。**
    expect(q.to - q.from).not.toBe(2_592_000_000);
  });

  it("四个档位的跨度逐个手写锚死 —— 每一个输入都单独钉住，才不是同义反复", () => {
    const now = 1_700_000_000_000;
    // 手写字面量，逐档：`now − (N−1) × 86400000`。**四个数各自单独锚死**，
    // 不从 `now` 与 `DAY_MS` 推导 —— 无锚的推导是同义反复（第 6 种假阳性）。
    expect((rangeToQuery("24h", now) as { from: number }).from).toBe(1_700_000_000_000);
    expect((rangeToQuery("3d", now) as { from: number }).from).toBe(1_699_827_200_000);
    expect((rangeToQuery("7d", now) as { from: number }).from).toBe(1_699_481_600_000);
    expect((rangeToQuery("30d", now) as { from: number }).from).toBe(1_697_494_400_000);
  });

  it("认不出来的档位与坏时钟一律返回 null —— 拿 NaN 拼查询串会换来一条 400", () => {
    expect(rangeToQuery("90d", 1)).toBe(null);
    expect(rangeToQuery("", 1)).toBe(null);
    expect(rangeToQuery("24h", Number.NaN)).toBe(null);
    expect(rangeToQuery("24h", Number.POSITIVE_INFINITY)).toBe(null);
  });

  it("30d 不是默认档 —— 那一档一次要发 30 天的读扇出，一次点击就是 60 遍整份 store.json 的反序列化", () => {
    expect(DEFAULT_RANGE).toBe("24h");
    expect(RANGES).toEqual(["24h", "3d", "7d", "30d"]);
    expect(RANGES.includes(DEFAULT_RANGE)).toBe(true);
  });

  it("档位文案 key 表外返回 null —— 调用方把原值照实显示，不冒充任何一档", () => {
    expect(rangeLabelKey("24h")).toBe("usage.range.24h");
    expect(rangeLabelKey("90d")).toBe(null);
  });
});

describe("note 是摘要，字段才是判据", () => {
  /**
   * ⚠️⚠️ **这一格钉的是「前端不许假设 note 只可能是那八个值之一」。**
   *
   * `tests/contract/admin-usage.test.ts` 的
   * 「八种状态两两不同 —— 面板不用猜，也不该猜（但这一格证明不了没有第九种）」
   * 的名字自己就写着它的边界。后端 `USAGE_NOTES` 今天有九条 code，
   * 而它加第十条时前端**不会有任何东西红** ⇒ 兜底必须在这里。
   *
   * **变红条件**：把 `usageNoteKey` 的 `default: return null;` 改成
   * `default: return "usage.note.readFailed";` ⇒ 第三句断言红
   *（一条读不懂的 code 会被冒充成「读取失败」）。
   */
  it("表外的 note code 返回 null，调用方原样显示 —— 后端加第十条时面板不许说成『加载失败』", () => {
    expect(usageNoteKey("read_failed")).toBe("usage.note.readFailed");
    expect(usageNoteKey(null)).toBe(null);
    expect(usageNoteKey("some_future_code_from_a_later_release")).toBe(null);
    expect(noteSeverity("some_future_code_from_a_later_release")).toBe("warn");
    // 读不懂的 code 不许被当成常态（info），也不许把面板染成一片红（error）。
    expect(noteSeverity("some_future_code_from_a_later_release")).not.toBe("info");
    expect(noteSeverity("some_future_code_from_a_later_release")).not.toBe("error");
  });

  /**
   * **后端今天产得出来的每一条 code，面板都要有一条查得到的文案。**
   * 这一格走的是后端那张运行期表 `USAGE_NOTES`（不是手抄一份），
   * 所以后端加一条 code 而忘了在这里补映射时它会红。
   */
  it("USAGE_NOTES 里每一条 code 都映射得到一个真实存在的字典 key —— 少一条面板会显示裸 key", () => {
    const dict = I18N as Record<string, unknown>;
    const missing: string[] = [];
    for (const code of USAGE_NOTES) {
      const key = usageNoteKey(code);
      if (key === null || !(key in dict)) missing.push(code);
    }
    expect(missing, "这些 code 在面板上查不到文案").toEqual([]);
    // 反向自检：表本身不是空的（否则上面那个循环恒绿）。手写下界。
    expect(USAGE_NOTES.length).toBeGreaterThanOrEqual(9);
  });

  it("横幅分档按『谁需要人去查』—— 畸形要查存储，被夹只是一句提示", () => {
    expect(noteSeverity("read_failed")).toBe("error");
    expect(noteSeverity("all_malformed")).toBe("error");
    expect(noteSeverity("partial_malformed")).toBe("error");
    expect(noteSeverity("clock_unavailable")).toBe("error");
    expect(noteSeverity("range_clamped")).toBe("warn");
    expect(noteSeverity("no_shards")).toBe("info");
    expect(noteSeverity("no_request_detail")).toBe("info");
    expect(noteSeverity("date_out_of_retention")).toBe("info");
    expect(noteSeverity("tier2_off")).toBe("info");
    expect(noteSeverity(null)).toBe(null);
    expect(noteSeverity(undefined)).toBe(null);
    // ⚠️ **被夹与畸形不许同档**：后端的优先级把畸形排在 range_clamped 前面，
    //    理由是「畸形要人去查存储」。两者同档等于把那个排序白排了。
    expect(noteSeverity("partial_malformed")).not.toBe(noteSeverity("range_clamped"));
  });

  /**
   * ⚠️ **同一件事，两条端点两套判据**：`GET /admin/api/usage/:date`
   * **根本不发** `all_malformed` / `partial_malformed`
   *（`src/http/admin/handlers/usage.ts` 的 `usageDateHandler` 常态恒是
   * `no_request_detail`），单日下钻只能靠 `shards` / `malformed` 两个字段。
   * `malformedKind` 因此必须在「没有 note 可读」的响应上照样工作。
   */
  it("单日下钻没有畸形 code 可读，判据只能是 shards / malformed 两个字段", () => {
    const dateBody = {
      tier: "tier2", date: "2026-08-21", note: "no_request_detail",
      hours: {}, byModel: {}, byProtocol: {}, shards: 2, malformed: 1,
    };
    expect(usageNoteKey(dateBody.note), "note 只说『这里本来就没有流水』")
      .toBe("usage.note.noRequestDetail");
    expect(malformedKind(dateBody), "缺了几块这件事只有字段说得出来").toBe("partial");
    expect(malformedKind({ ...dateBody, malformed: 0 })).toBe("none");
    expect(malformedKind({ ...dateBody, shards: 0, malformed: 3 })).toBe("all");
    // 整块读不出来时 shards / malformed 一起是 null ⇒ 判不出来，如实说 unknown。
    expect(malformedKind({ ...dateBody, hours: null, shards: null, malformed: null, note: "read_failed" }))
      .toBe("unknown");
  });
});

describe("表格的行", () => {
  it("日汇总表每天一格，形状不对的行跳过而不是补一行 0 —— 补零是伪造一天的记录", () => {
    const body = okBody({
      days: [
        { date: "2026-08-19", total: ZERO },
        { date: "2026-08-20", total: BUCKET },
        { date: "", total: BUCKET },
        { total: BUCKET },
        null,
      ],
    });
    expect(dayRows(body).map((r) => r.date)).toEqual(["2026-08-19", "2026-08-20"]);
    expect(dayRows({ ...body, days: null })).toEqual([]);
    expect(dayRows(null)).toEqual([]);
  });

  /**
   * ⚠️ **小时表必须走数值序**：`hours` 的键是 `"0"`…`"23"`，字典序会把
   * `"10"` 排在 `"2"` 前面 ⇒ 一张按小时排的表上午跳到晚上再跳回来。
   *
   * **变红条件**：把 `breakdownRows` 的 `numeric === true` 改成 `numeric === false`
   * ⇒ 小时那一格拿到字典序 ⇒ 第一句断言红。
   */
  it("小时表按数值序、模型表按字典序 —— 字典序会把 10 点排在 2 点前面", () => {
    const hours = Object.create(null) as Record<string, unknown>;
    for (const h of ["2", "10", "0", "23"]) hours[h] = { ...ZERO };
    expect(breakdownRows(hours, true).map((r) => r.key)).toEqual(["0", "2", "10", "23"]);
    expect(breakdownRows(hours, false).map((r) => r.key)).toEqual(["0", "10", "2", "23"]);
  });

  /**
   * ⚠️⚠️ **键来自客户端填的模型名**，`__proto__` / `toString` / `constructor`
   * 都造得出来（`src/http/admin/handlers/usage.ts` 的 `usageDateHandler` 上方
   * 逐条写着，后端那边由「模型名叫 __proto__ / toString / hasOwnProperty /
   * constructor 时，四条都原样出现在响应里」那一格钉着）。
   * 前端这一半要保证它们**同样一条不少地出现在表上**。
   */
  it("模型名叫 __proto__ / toString / constructor 时四条都出现在表上 —— 静默丢一行就是丢一段真实用量", () => {
    const byModel = Object.create(null) as Record<string, unknown>;
    for (const k of ["__proto__", "toString", "hasOwnProperty", "constructor"]) {
      byModel[k] = { ...ZERO, requests: 1 };
    }
    expect(breakdownRows(byModel, false).map((r) => r.key))
      .toEqual(["__proto__", "constructor", "hasOwnProperty", "toString"]);
    expect(breakdownRows(null, false)).toEqual([]);
  });
});

describe("Token 卡的覆盖范围：id → 展示名只许有一份知识", () => {
  const protocols = [
    { id: "openai", label: "OpenAI Chat Completions" },
    { id: "anthropic", label: "Anthropic Messages" },
    { id: "responses", label: "OpenAI Responses" },
    { id: "gemini", label: "Google Gemini" },
  ];

  it("裸 id 一律换成 protocols[].label —— 运维看不懂 responses 是哪个协议", () => {
    expect(tokensCoverageLabels(["anthropic", "responses"], protocols))
      .toEqual(["Anthropic Messages", "OpenAI Responses"]);
  });

  /**
   * **变红条件**：把 `if (label === null) return null;` 改成 `continue`
   * ⇒ 解析不出来的那条被静默丢掉、返回半张名单 ⇒ 这一格红。
   * 半张名单会让运维**少估**覆盖范围，而这个 tooltip 的全部用途就是回答
   * 「Token 这张卡到底盖住了哪几条协议」。
   */
  it("有一条 id 解析不出来就整条退回 null —— 半张名单会让运维少估覆盖范围", () => {
    expect(tokensCoverageLabels(["anthropic", "a_protocol_added_later"], protocols)).toBe(null);
    expect(tokensCoverageLabels(["anthropic"], null)).toBe(null);
    expect(tokensCoverageLabels([], protocols)).toBe(null);
    expect(tokensCoverageLabels(null, protocols)).toBe(null);
    // label 是空串同样算解析不出来（渲染成空 tooltip 与没有 tooltip 一样糟）。
    expect(tokensCoverageLabels(["x"], [{ id: "x", label: "" }])).toBe(null);
  });
});

describe("未落盘的尾巴", () => {
  /**
   * ⚠️⚠️ **`ms` 数的是「距上一次落盘*尝试*多久」，不是「距上一次写成功多久」**
   *（`src/http/usage-sink.ts` 的 `status()` 上方写着全文）。
   * ⇒ **`count > 0 && ms === 0` 要读作「刚试过、没写成」，不是「没有尾巴」**。
   *
   * **变红条件**：把 `pendingTail` 的判据从 `count` 换成 `ms`
   *（`if (ms === null || ms <= 0) return null;`）⇒ 这一格返回 `null`
   * ⇒ 面板把「刚试过没写成」显示成「一切都已落盘」⇒ 第一句断言红。
   */
  it("count 大于 0 而 ms 是 0 时仍然算有尾巴 —— 那是『刚试过没写成』，不是『没有尾巴』", () => {
    const tail = pendingTail(okBody({ pending: { count: 7, ms: 0, budgetExhausted: true } }));
    expect(tail).toEqual({ count: 7, ms: 0, budgetExhausted: true });
  });

  it("没有尾巴与拿不到这条信息都返回 null —— 但前者已经由 count 是 0 说清了", () => {
    expect(pendingTail(okBody())).toBe(null);
    expect(pendingTail(okBody({ pending: null }))).toBe(null);
    expect(pendingTail(null)).toBe(null);
  });

  it("budgetExhausted 原样带出来 —— 少了它，预算耗尽与存储抛错在面板上没法区分", () => {
    const a = pendingTail(okBody({ pending: { count: 3, ms: 5000, budgetExhausted: false } }));
    const b = pendingTail(okBody({ pending: { count: 3, ms: 5000, budgetExhausted: true } }));
    expect(a?.budgetExhausted).toBe(false);
    expect(b?.budgetExhausted).toBe(true);
    // 两种失败态在 count + ms 上逐字相同 —— 分得开的只有这一格。
    expect(a?.count).toBe(b?.count);
    expect(a?.ms).toBe(b?.ms);
  });
});

describe("六张汇总卡", () => {
  it("六格全部取自顶层 total —— 自己把 days 加一遍会少报一段真实发生过的流量", () => {
    const c = summaryCards(okBody({
      days: [{ date: "2026-08-21", total: ZERO }, { date: "2026-08-20", total: ZERO }],
      total: BUCKET,
    }));
    // 期望值全部手写字面量。
    expect(c.requests).toBe(100);
    expect(c.success).toBe(90);
    expect(c.errors).toBe(10);
    expect(c.tokensIn).toBe(4000);
    expect(c.tokensOut).toBe(2500);
    expect(c.streamingRequests).toBe(30);
    expect(c.latencyMs).toBe(300);
  });

  it("整块读不出来时六格全是 null 而 complete 仍是 true —— 没有数据就谈不上残缺", () => {
    const c = summaryCards({
      tier: "tier2", days: null, total: null, shards: null, malformed: null, note: "read_failed",
    });
    expect(c.requests).toBe(null);
    expect(c.latencyMs).toBe(null);
    expect(c.streamingRequests).toBe(null);
    // ⚠️ 这一档已经整个是 EM DASH，再叠一个「不完整」标记只会让运维
    //    以为「有一部分是好的」。
    expect(c.complete).toBe(true);
  });

  it("畸形分片条数原样带出来 —— 面板要说清『缺了几块』，不是只说『缺了』", () => {
    expect(summaryCards(okBody({ shards: 3, malformed: 2 })).malformed).toBe(2);
    expect(summaryCards(okBody()).malformed).toBe(0);
  });
});

describe("按密钥那一维：保留伪 id 与每张卡上的那个数", () => {
  /**
   * ⚠️⚠️ **这一格是那份抄件唯一的活路。** 面板 import 不到 `src/`，
   * 那三个字面量因此在仓里存在两份；两份字面量的默认结局是**悄悄分叉**
   * ——后端把桶名改一个字母，面板那一列会安静地退回画裸串，
   * 而**没有任何一格会红**（`apiKeyRowLabelKey` 照样「认不出来就原样画」）。
   * 这一格直接把两边摆在一起比。
   */
  it("面板那三个保留 id 与后端常量逐字相同 —— 这是一份抄件，它只能靠对表活着", () => {
    expect(RESERVED_API_KEY_IDS.master).toBe(USAGE_MASTER_BUCKET);
    expect(RESERVED_API_KEY_IDS.unattributed).toBe(USAGE_UNATTRIBUTED_BUCKET);
    expect(RESERVED_API_KEY_IDS.other).toBe(USAGE_OTHER_BUCKET);
  });

  it("三个保留 id 各有一条展示名，而真实密钥 id 一律返回 null（原样画）", () => {
    expect(apiKeyRowLabelKey(USAGE_MASTER_BUCKET)).toBe("usage.key.master");
    expect(apiKeyRowLabelKey(USAGE_UNATTRIBUTED_BUCKET)).toBe("usage.key.unattributed");
    expect(apiKeyRowLabelKey(USAGE_OTHER_BUCKET)).toBe("usage.key.other");
    // ★ 12 位十六进制的真 id：**不猜、不标「已删除」**，交回 null 让调用方画原值。
    expect(apiKeyRowLabelKey("aabbccddeeff")).toBe(null);
    expect(apiKeyRowLabelKey("")).toBe(null);
    // 三条展示名都真的在字典里（少一条，面板上会显示裸 key 串）。
    for (const k of ["usage.key.master", "usage.key.unattributed", "usage.key.other"]) {
      expect(Object.prototype.hasOwnProperty.call(I18N, k), `${k} 不在字典里`).toBe(true);
    }
  });

  /**
   * ⚠️⚠️ **`off` 与「真的是 0」必须是两档，这一格是本轮那条硬裁定的纯函数一侧。**
   * 合成一档的实现（`requests: byApiKey?.[id]?.requests ?? 0`）在**四条断言里的
   * 三条上都是绿的**，只有第一条会红 —— 所以这一格的第一条不能省。
   *
   * ⚠️⚠️ **`no-shards` 那一条是评审第 2 轮补的**：这个函数当时是黑名单
   *（只挡 `off` / `unavailable`），`usageState` 新分出来的那一档**默认落进
   * 「就是 0」**，而这一格上一版的标题只写了四档、五条断言里没有一条喂它
   * —— 于是它被第 ④ 条（「读成功了、这把一次都没被用过 ⇒ 就是 0」）整个吞了进去。
   * ⇒ 这一格的射程从此是**穷举**：`usageState` 的每一档在这里都得有一条。
   */
  it("五档互不重叠：没开 / 读不出来 / 开着但一条分片都还没落盘 / 读到了但这把是 0 / 有数字", () => {
    const withKey = (over: Record<string, unknown> = {}) => okBody({
      byApiKey: { aabbccddeeff: { ...BUCKET, requests: 7 } }, ...over,
    });

    // ① Tier-2 没开 ⇒ **不是 0**。
    expect(apiKeyUsage({ tier: "off", days: null, total: null, byApiKey: null }, false, "aabbccddeeff"))
      .toEqual({ kind: "off", requests: 0 });
    // ② 这一次读失败 / 还没读到 ⇒ 「我们不知道」。
    expect(apiKeyUsage(withKey(), true, "aabbccddeeff").kind).toBe("unknown");
    expect(apiKeyUsage(null, false, "aabbccddeeff").kind).toBe("unknown");
    // ③ 整块读不出来（`days` 是 null）⇒ 同样是「我们不知道」，不是 0。
    expect(apiKeyUsage(okBody({ days: null, total: null, byApiKey: null, note: "read_failed" }), false, "aabbccddeeff").kind)
      .toBe("unknown");
    // ④ 开着，但这段区间一条分片都还没落盘 ⇒ **不是 0**：落盘之前它与「真的没人用」
    //    在这份响应上完全同形，而这一屏没有横幅替它说话（线上实测那份形状：
    //    `tier2` / `shards:0` / `no_shards` / `byApiKey:{}`，`pending.count` 是 4）。
    expect(apiKeyUsage(okBody({
      days: [{ date: "2026-08-21", total: ZERO }], total: ZERO,
      shards: 0, malformed: 0, note: "no_shards", byApiKey: {},
      pending: { count: 4, ms: 184_532, budgetExhausted: false },
    }), false, "aabbccddeeff")).toEqual({ kind: "no-shards", requests: 0 });
    // ⑤ 读成功了、**区间里有分片**、这把密钥一次都没被用过 ⇒ **就是 0**，
    //    把它画成破折号是反向的撒谎。「有分片」这半句是这一条与 ④ 的分界。
    expect(apiKeyUsage(withKey(), false, "112233445566")).toEqual({ kind: "value", requests: 0 });
    // ⑥ 有数字。
    expect(apiKeyUsage(withKey(), false, "aabbccddeeff")).toEqual({ kind: "value", requests: 7 });
  });

  it("byApiKey 那一格形状不对时是「我们不知道」，不是 0", () => {
    // 整块不是对象（后端不会发，但面板不该假设后端只会发它今天见过的形状）。
    expect(apiKeyUsage(okBody({ byApiKey: "nope" }), false, "aabbccddeeff").kind).toBe("unknown");
    // 这一格在，但 `requests` 不是有限数字。
    expect(apiKeyUsage(okBody({ byApiKey: { aabbccddeeff: { requests: "7" } } }), false, "aabbccddeeff").kind)
      .toBe("unknown");
  });
});
