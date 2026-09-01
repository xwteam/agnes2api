import { describe, it, expect } from "vitest";
import {
  RANGES, DEFAULT_RANGE, rangeLabelKey, rangeToQuery,
  usageState, detailState, rowState, readSucceeded, avgLatency, cellKind, ratioKind,
  summaryCards, bucketCells,
  malformedKind, usageNoteKey, noteSeverity, dayRows, breakdownRows,
  tokensCoverageLabels, pendingTail,
} from "../../admin-ui/js/pure/usage.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { USAGE_NOTES } from "../../src/http/admin/handlers/usage.js";

/**
 * 用量板块的取值判定。
 *
 * **每一格的标题写清它防住了什么真实故障**，因为这个板块的全部难点是
 * 「今天真的是 0 次请求」「Tier-2 没开」「读不出来」「读到的全是坏分片」
 * 在面板上长得一模一样，而它们是四件事。
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

describe("四态判定：三件事不许揉成一件", () => {
  /**
   * **变红条件（实测记在当时的变异表里）**：把 `usageState` 里
   * `if (r.tier === "off") return "off";` 那一支删掉 ⇒ Tier-2 关着的那一档
   * 落进 `days` 不是数组那一支、被判成 `unavailable`
   * ⇒ 面板对「统计没开」显示一条「读取失败」的红色横幅 + 重试按钮，
   * 而重试一万次也不会有数据。下面第一句断言当场红。
   */
  it("四种状态互不重叠 —— 『没开』『读不出来』『真的是 0』『有数据』揉在一起就是撒谎", () => {
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

    // ③ 读成功了，这段时间真的一次请求都没有。
    expect(usageState(okBody({
      days: [{ date: "2026-08-21", total: ZERO }], total: ZERO, shards: 0, malformed: 0, note: "no_shards",
    }))).toBe("empty");

    // ④ 有数据。
    expect(usageState(okBody())).toBe("data");

    // ⑤ 整条响应都没拿到（网络断了 / JSON 解析失败）——同样是「我们不知道」。
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
   * 删掉 ⇒ 这一格返回 `"empty"` ⇒ 断言红。
   */
  it("分片全坏时是 unavailable 而不是 empty —— 那些 0 不是知识，写成 0 就是伪造", () => {
    const body = okBody({
      days: [{ date: "2026-08-21", total: ZERO }], total: ZERO,
      shards: 0, malformed: 5, note: "all_malformed",
    });
    expect(malformedKind(body)).toBe("all");
    expect(usageState(body)).toBe("unavailable");
    // 反向锚：**同一份响应只把 malformed 改成 0** ⇒ 它就真的是 empty。
    // 少了这一句，一个「恒返回 unavailable」的实现也会绿（第 5 种假阳性）。
    expect(usageState({ ...body, malformed: 0, note: "no_shards" })).toBe("empty");
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
    // 今天的四档，逐个手写锚死。
    expect(readSucceeded("data")).toBe(true);
    expect(readSucceeded("empty")).toBe(true);
    expect(readSucceeded("unavailable")).toBe(false);
    expect(readSucceeded("off")).toBe(false);
    // ⚠️⚠️ **这一句才是它存在的理由**：拿一个今天不存在的状态当探针。
    //    黑名单实现（`state !== "unavailable"`）在上面四句上**逐句等价**，
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

  it("30d 不是默认档 —— 那一档一次要发 30 天的子请求，而它在 Worker 上的上限还没在真机上了结", () => {
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
