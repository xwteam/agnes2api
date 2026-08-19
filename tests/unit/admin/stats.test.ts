import { describe, it, expect } from "vitest";
import {
  EMPTY_STATS, ZERO_DELTA, normalizeStats, withOutcome,
  statsDelta, addDelta, applyDelta, sumStats,
} from "../../../src/core/admin/stats.js";
import type { KeyRecord, KeyStats } from "../../../src/core/types.js";

const rec: KeyRecord = {
  id: "aa", key: "sk-xxxxxxxxxxxxxxxx", addedAt: 0, lastUsedAt: null,
  cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
};

describe("normalizeStats", () => {
  it("存量记录没有 stats 时补零，而不是 undefined 冒泡到面板", () => {
    expect(normalizeStats(undefined)).toEqual(EMPTY_STATS);
  });
  it("字段缺一半时逐字段补零，**不整块丢弃已有的计数**", () => {
    const partial = { requests: 5, success: 5 } as unknown as KeyStats;
    expect(normalizeStats(partial)).toEqual({
      requests: 5, success: 5, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null,
    });
  });
  it("非数字（存储被写坏）当成 0，不让 NaN 进面板", () => {
    const bad = { requests: "5", success: null, failed: Number.NaN, clientErrors: 1 } as unknown as KeyStats;
    expect(normalizeStats(bad)).toEqual({
      requests: 0, success: 0, failed: 0, clientErrors: 1, lastErrorAt: null, lastErrorKind: null,
    });
  });
});

describe("withOutcome：三条终态各自记到该记的那一栏", () => {
  it("成功", () => {
    const r = withOutcome(rec, "success", 100, null);
    expect(r.stats).toEqual({ requests: 1, success: 1, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null });
  });
  it("归因到这把 key 的失败：记 failed 并留下最近一次错误", () => {
    const r = withOutcome(rec, "failed", 100, "timeout");
    expect(r.stats).toEqual({ requests: 1, success: 0, failed: 1, clientErrors: 0, lastErrorAt: 100, lastErrorKind: "timeout" });
  });
  it("上游 4xx 直通记 clientErrors，**不记 failed、不写 lastError**——那是客户端的错，不该栽给这把 key", () => {
    const r = withOutcome(rec, "clientError", 100, null);
    expect(r.stats).toEqual({ requests: 1, success: 0, failed: 0, clientErrors: 1, lastErrorAt: null, lastErrorKind: null });
  });
  it("不变式：requests === success + failed + clientErrors（连续 3 次不同终态之后仍成立）", () => {
    let r = withOutcome(rec, "success", 1, null);
    r = withOutcome(r, "failed", 2, "5xx");
    r = withOutcome(r, "clientError", 3, null);
    const s = r.stats!;
    expect(s.requests).toBe(s.success + s.failed + s.clientErrors);
    expect(s.requests).toBe(3);
  });
  it("除 stats 之外一个字段都不动——它绝不能顺手改调度状态", () => {
    const r = withOutcome({ ...rec, strikes: 2, cooldownUntil: 999 }, "failed", 100, "x");
    expect({ ...r, stats: undefined }).toEqual({ ...rec, strikes: 2, cooldownUntil: 999, stats: undefined });
  });
});

describe("增量：写被消除时把计数攒起来", () => {
  it("statsDelta 只取非负差——快照比存储旧时不许算出负增量", () => {
    const prev: KeyStats = { requests: 10, success: 9, failed: 1, clientErrors: 0, lastErrorAt: 5, lastErrorKind: "a" };
    const next: KeyStats = { requests: 7, success: 7, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null };
    expect(statsDelta(prev, next)).toEqual(ZERO_DELTA);
  });
  it("statsDelta 带上更新的那条最近错误（按时刻取新的，不是按顺序取后面的）", () => {
    const prev: KeyStats = { ...EMPTY_STATS, lastErrorAt: 100, lastErrorKind: "old" };
    const next: KeyStats = { ...EMPTY_STATS, requests: 1, failed: 1, lastErrorAt: 200, lastErrorKind: "new" };
    expect(statsDelta(prev, next)).toEqual({ requests: 1, success: 0, failed: 1, clientErrors: 0, lastErrorAt: 200, lastErrorKind: "new" });
  });
  it("prev 的最近错误更新时不携带（不把旧值当增量往回写）", () => {
    const prev: KeyStats = { ...EMPTY_STATS, lastErrorAt: 300, lastErrorKind: "newer" };
    const next: KeyStats = { ...EMPTY_STATS, lastErrorAt: 100, lastErrorKind: "older" };
    expect(statsDelta(prev, next).lastErrorAt).toBe(null);
  });
  it("addDelta 累加计数并按时刻取新的那条错误", () => {
    const a = { requests: 3, success: 3, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null };
    const b = { requests: 2, success: 1, failed: 1, clientErrors: 0, lastErrorAt: 50, lastErrorKind: "x" };
    expect(addDelta(a, b)).toEqual({ requests: 5, success: 4, failed: 1, clientErrors: 0, lastErrorAt: 50, lastErrorKind: "x" });
  });
  it("applyDelta 把攒的增量合并回记录", () => {
    const base: KeyStats = { requests: 1, success: 1, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null };
    const d = { requests: 49, success: 48, failed: 1, clientErrors: 0, lastErrorAt: 70, lastErrorKind: "t" };
    expect(applyDelta(base, d)).toEqual({ requests: 50, success: 49, failed: 1, clientErrors: 0, lastErrorAt: 70, lastErrorKind: "t" });
  });
  it("applyDelta(base, undefined) 原样返回归一化后的 base", () => {
    expect(applyDelta(undefined, undefined)).toEqual(EMPTY_STATS);
  });
});

describe("sumStats：池级聚合", () => {
  it("跳过没有 stats 的记录，最近错误取时刻最大的那条", () => {
    const a: KeyStats = { requests: 3, success: 3, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null };
    const b: KeyStats = { requests: 2, success: 0, failed: 2, clientErrors: 0, lastErrorAt: 9, lastErrorKind: "b" };
    const c: KeyStats = { requests: 1, success: 0, failed: 1, clientErrors: 0, lastErrorAt: 4, lastErrorKind: "c" };
    expect(sumStats([a, undefined, b, c])).toEqual({
      requests: 6, success: 3, failed: 3, clientErrors: 0, lastErrorAt: 9, lastErrorKind: "b",
    });
  });
  it("空列表是全零，不是 undefined——概览页拿到 undefined 会渲染成空白而不是 0", () => {
    expect(sumStats([])).toEqual(EMPTY_STATS);
  });
});
