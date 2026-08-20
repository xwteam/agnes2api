import { describe, it, expect } from "vitest";
import {
  TEND_HISTORY_SIZE, TEND_HISTORY_KEY,
  appendTendHistory, narrowTendHistory, toTendRecord, type TendRecord,
} from "../../../src/core/admin/tend-history.js";

/** 一条完好的记录。九个字段全部手写字面量，不从被测对象推。 */
function rec(over: Partial<TendRecord> = {}): TendRecord {
  return {
    at: 1000, trigger: "cron", primaryChannel: "yyds", skipped: false,
    available: 3, attempted: 2, minted: 1, mintedByChannel: { yyds: 1 }, durationMs: 4500,
    failures: [{ reason: "code_timeout", channel: "yyds" }],
    ...over,
  };
}

describe("TEND_HISTORY_SIZE / TEND_HISTORY_KEY：常量本身是策略，独立钉死", () => {
  it("环形上限是 50（设计 §7.3 的取值）", () => {
    expect(TEND_HISTORY_SIZE).toBe(50);
  });
  it("存储键是固定字面量 tend:history —— 单键、无扇出、数量恒为 1", () => {
    expect(TEND_HISTORY_KEY).toBe("tend:history");
  });
});

describe("appendTendHistory：环形追加", () => {
  it("没满时原样追加在末尾（最新在后）", () => {
    expect(appendTendHistory([rec({ at: 1 })], rec({ at: 2 })).map((r) => r.at)).toEqual([1, 2]);
  });

  /**
   * **第 51 轮把最旧那轮挤掉。** 这是行为断言，不是常量断言：把上限从 50 改成
   * 500 时，上面那条常量用例与这一条会**一起**变红——两条都在，是因为只留常量
   * 那条的话，一个"常量对了但环形逻辑写反（丢最新）"的实现照样全绿。
   */
  it("第 51 轮把最旧那轮挤掉，留下的是第 2..51 轮", () => {
    let cur: TendRecord[] = [];
    for (let i = 1; i <= 51; i++) cur = appendTendHistory(cur, rec({ at: i }));
    expect(cur.length).toBe(50);
    expect(cur[0]!.at, "丢掉的必须是最旧的那一轮").toBe(2);
    expect(cur[cur.length - 1]!.at, "最新的那一轮必须还在").toBe(51);
  });

  it("size 可以显式传（测试专用），上限逻辑跟着走", () => {
    let cur: TendRecord[] = [];
    for (let i = 1; i <= 5; i++) cur = appendTendHistory(cur, rec({ at: i }), 3);
    expect(cur.map((r) => r.at)).toEqual([3, 4, 5]);
  });

  it("不就地改入参", () => {
    const cur = [rec({ at: 1 })];
    const snapshot = JSON.stringify(cur);
    appendTendHistory(cur, rec({ at: 2 }));
    expect(JSON.stringify(cur)).toBe(snapshot);
  });
});

describe("toTendRecord：一轮的结果 + 谁触发的", () => {
  it("TendResult 的字段原样透传，只多一个 trigger", () => {
    const result = {
      skipped: false, available: 3, attempted: 2, minted: 1, mintedByChannel: { yyds: 1 },
      failures: [{ reason: "code_timeout" as const, channel: "yyds" }],
      at: 1000, primaryChannel: "yyds", durationMs: 4500,
    };
    expect(toTendRecord(result, "manual")).toEqual({ ...result, trigger: "manual" });
    expect(toTendRecord(result, "cron").trigger).toBe("cron");
  });
});

/**
 * 防住的真实故障：`tend:history` 是本期新增的**第二个**「从存储读回来直接喂给
 * 面板」的结构。不做窄化，就是在同一天里制造第二个 W2——存储里混进一条 `null`，
 * 注册机板块直接 500，而运维看到的只是「读取失败」。
 */
describe("narrowTendHistory：存储里的东西一律不可信", () => {
  it("混进一条 null：那一条被丢掉并计数，其余照常返回", () => {
    // 变红条件：整个 narrowTendHistory 被去掉（读路径直接吃存储里的原值）
    const good = rec();
    expect(narrowTendHistory([null, good])).toEqual({ entries: [good], malformed: 1 });
  });

  it("整条不是数组时回空历史且计 0（null / undefined / 字符串 / 数字 / 对象）", () => {
    for (const bad of [null, undefined, "nope", 7, { a: 1 }]) {
      expect(narrowTendHistory(bad), JSON.stringify(bad) ?? "undefined")
        .toEqual({ entries: [], malformed: 0 });
    }
  });

  it("全是好记录时 malformed 恒为 0", () => {
    expect(narrowTendHistory([rec({ at: 1 }), rec({ at: 2 })]).malformed).toBe(0);
  });

  /**
   * ⚠️ **判据比 `narrowEntries` 严，这一格就是那条差异本身。**
   * 事件条目只丢「结构性不可用」的（`ts` 非有限数），`level` 畸形照样留着——
   * 因为那是上游来的证据。`TendRecord` 是一张**定长表的一行**，九个字段全部由
   * 本仓自己的代码一次性写出，一行里 `minted` 坏掉不是「不完整的证据」，
   * 是**一行读不得的数**。逐字段校验，任一字段不合就整条丢。
   */
  it("逐字段校验：九个字段各自坏掉一个，整条都被丢掉", () => {
    const cases: Array<[string, Partial<Record<keyof TendRecord, unknown>>]> = [
      ["at 不是数字", { at: "1000" }],
      ["at 是 NaN", { at: Number.NaN }],
      ["trigger 不在两个取值里", { trigger: "timer" }],
      ["primaryChannel 不是字符串", { primaryChannel: 1 }],
      ["mintedByChannel 不是对象", { mintedByChannel: "yyds" }],
      ["mintedByChannel 是数组", { mintedByChannel: [1] }],
      ["mintedByChannel 的值不是数字", { mintedByChannel: { yyds: "1" } }],
      ["skipped 不是布尔", { skipped: "false" }],
      ["available 不是数字", { available: null }],
      ["attempted 不是数字", { attempted: "2" }],
      ["minted 不是数字", { minted: undefined }],
      ["durationMs 不是数字", { durationMs: "4500" }],
      ["failures 不是数组", { failures: "none" }],
    ];
    for (const [why, over] of cases) {
      const bad = { ...rec(), ...over };
      expect(narrowTendHistory([bad, rec({ at: 9 })]), why)
        .toEqual({ entries: [rec({ at: 9 })], malformed: 1 });
    }
  });

  /**
   * **`failures` 里的 `reason` 必须是联合成员，不只是字符串。**
   * 面板的失败归因渲染是 `switch` + `never` 穷尽检查（设计 §7.3），表外的 reason
   * 会掉进 `default`；而 `reg.fail.<reason>` 的五语言键也只对那十个成员齐全。
   */
  it("failures 里 reason 不在 TEND_FAILURE_REASONS 表里：整条被丢掉", () => {
    const bad = rec({ failures: [{ reason: "not_a_reason" as never, channel: "yyds" }] });
    expect(narrowTendHistory([bad]).malformed).toBe(1);
  });

  it("failures 里的元素不是对象、或缺 channel：整条被丢掉", () => {
    expect(narrowTendHistory([rec({ failures: [null as never] })]).malformed).toBe(1);
    expect(narrowTendHistory([rec({ failures: [{ reason: "code_timeout" } as never] })]).malformed).toBe(1);
  });

  it("failures 是空数组是完全正常的（一轮全成功）", () => {
    const ok = rec({ failures: [] });
    expect(narrowTendHistory([ok])).toEqual({ entries: [ok], malformed: 0 });
  });

  it("多出来的未知字段不构成畸形 —— 只校验今天这九个，不拒绝将来的", () => {
    const withExtra = { ...rec(), someFutureField: 1 };
    expect(narrowTendHistory([withExtra]).malformed).toBe(0);
  });

  it("不就地改入参", () => {
    const raw: unknown[] = [null, rec()];
    const snapshot = JSON.stringify(raw);
    narrowTendHistory(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
