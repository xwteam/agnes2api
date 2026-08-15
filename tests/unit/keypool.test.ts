import { describe, it, expect } from "vitest";
import {
  isAvailable, selectKey, applySuccess, applyCooldown, applyStrike, applyEvict, poolHealth,
} from "../../src/core/keypool.js";
import type { KeyRecord } from "../../src/core/types.js";

const NOW = 1_000_000;

function rec(over: Partial<KeyRecord> = {}): KeyRecord {
  return {
    id: "id1", key: "sk-x", addedAt: 0, lastUsedAt: null,
    cooldownUntil: 0, strikes: 0, evicted: false, evictedReason: null, ...over,
  };
}

describe("isAvailable", () => {
  it("正常记录可用", () => expect(isAvailable(rec(), NOW)).toBe(true));
  it("已剔除的不可用", () => expect(isAvailable(rec({ evicted: true }), NOW)).toBe(false));
  it("冷却未到期的不可用", () => expect(isAvailable(rec({ cooldownUntil: NOW + 1 }), NOW)).toBe(false));
  it("冷却刚好到期的可用", () => expect(isAvailable(rec({ cooldownUntil: NOW }), NOW)).toBe(true));
});

describe("selectKey", () => {
  it("空池返回 null", () => {
    expect(selectKey([], 0, NOW)).toBeNull();
  });
  it("全部不可用时返回 null", () => {
    const rs = [rec({ id: "a", evicted: true }), rec({ id: "b", cooldownUntil: NOW + 1 })];
    expect(selectKey(rs, 0, NOW)).toBeNull();
  });
  it("按游标轮询，每次推进一位", () => {
    const rs = [rec({ id: "a" }), rec({ id: "b" }), rec({ id: "c" })];
    expect(selectKey(rs, 0, NOW)!.record.id).toBe("a");
    expect(selectKey(rs, 1, NOW)!.record.id).toBe("b");
    expect(selectKey(rs, 2, NOW)!.record.id).toBe("c");
  });
  it("游标超出长度时回绕", () => {
    const rs = [rec({ id: "a" }), rec({ id: "b" })];
    expect(selectKey(rs, 5, NOW)!.record.id).toBe("b");
  });
  it("跳过不可用的记录", () => {
    const rs = [rec({ id: "a", evicted: true }), rec({ id: "b" })];
    expect(selectKey(rs, 0, NOW)!.record.id).toBe("b");
  });
  it("返回的 nextCursor 指向被选中项的下一位", () => {
    const rs = [rec({ id: "a" }), rec({ id: "b" })];
    expect(selectKey(rs, 0, NOW)!.nextCursor).toBe(1);
  });
});

describe("状态迁移", () => {
  it("成功清零 strikes 并更新 lastUsedAt", () => {
    const r = applySuccess(rec({ strikes: 2 }), NOW);
    expect(r.strikes).toBe(0);
    expect(r.lastUsedAt).toBe(NOW);
  });
  it("冷却设置到期时刻", () => {
    expect(applyCooldown(rec(), NOW, 60_000).cooldownUntil).toBe(NOW + 60_000);
  });
  it("strike 未达上限只累加不剔除", () => {
    const r = applyStrike(rec({ strikes: 1 }), 3, "timeout");
    expect(r.strikes).toBe(2);
    expect(r.evicted).toBe(false);
  });
  it("strike 达到上限即永久剔除并记原因", () => {
    const r = applyStrike(rec({ strikes: 2 }), 3, "timeout");
    expect(r.strikes).toBe(3);
    expect(r.evicted).toBe(true);
    expect(r.evictedReason).toBe("timeout");
  });
  it("剔除记录原因", () => {
    expect(applyEvict(rec(), "upstream 401").evictedReason).toBe("upstream 401");
  });
  it("状态迁移不修改入参", () => {
    const original = rec({ strikes: 0 });
    applyStrike(original, 3, "x");
    expect(original.strikes).toBe(0);
  });
});

describe("poolHealth", () => {
  it("分别统计可用、冷却中与已剔除", () => {
    const rs = [
      rec({ id: "a" }),
      rec({ id: "b", cooldownUntil: NOW + 1000 }),
      rec({ id: "c", evicted: true }),
    ];
    expect(poolHealth(rs, NOW)).toEqual({ total: 3, fresh: 1, cooling: 1, evicted: 1 });
  });
});
