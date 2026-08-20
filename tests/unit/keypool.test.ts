import { describe, it, expect } from "vitest";
import {
  isAvailable, isDisabled, selectKey, applySuccess, applyCooldown, applyStrike, applyEvict, poolHealth,
} from "../../src/core/keypool.js";
import type { KeyRecord } from "../../src/core/types.js";

const NOW = 1_000_000;
const STRIKE_CFG = { maxStrikes: 3, cooldownStrikeMs: 1_800_000 };

function rec(over: Partial<KeyRecord> = {}): KeyRecord {
  return {
    id: "id1", key: "sk-x", addedAt: 0, lastUsedAt: null,
    cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null, ...over,
  };
}

describe("isAvailable", () => {
  it("正常记录可用", () => expect(isAvailable(rec(), NOW)).toBe(true));
  it("已剔除的不可用", () => expect(isAvailable(rec({ evicted: true }), NOW)).toBe(false));
  it("冷却未到期的不可用", () => expect(isAvailable(rec({ cooldownUntil: NOW + 1 }), NOW)).toBe(false));
  it("冷却刚好到期的可用", () => expect(isAvailable(rec({ cooldownUntil: NOW }), NOW)).toBe(true));
  /**
   * 这一条是本字段存在的全部理由：停用了却还在被调度，等于面板上那个开关是假的。
   * **变红条件**：把 `isAvailable` 里的 `!isDisabled(r)` 去掉。
   */
  it("被管理员停用的不可用——哪怕它既没剔除也不在冷却", () => {
    expect(isAvailable(rec({ disabled: true }), NOW)).toBe(false);
  });
  /**
   * **存量记录**：`add()` 从来不写 `disabled`，所以线上绝大多数记录里压根没有这个
   * 字段。夹具刻意用 `rec()`（对象里**真的没有这个键**），而不是
   * `rec({ disabled: undefined })`——后者在 TS 里能过，但 JSON 往返之后与前者
   * 不等价，**测的就成了抄件不是原件**。
   */
  it("存量记录（压根没有 disabled 这个字段）照常可用——加字段不许把整池停掉", () => {
    const legacy = rec();
    expect("disabled" in legacy, "前置条件：夹具必须是一条真的不带该字段的旧记录").toBe(false);
    expect(isAvailable(legacy, NOW)).toBe(true);
  });
});

/**
 * `isDisabled` 是**全仓唯一一份**「这把 key 停用了吗」的判据，`isAvailable` /
 * `keyBucket` / `toKeyViews` 三处都问它。记录来自 `storage.get<KeyRecord>()` 的裸
 * `JSON.parse`（没有任何窄化），所以这里连非布尔值一起钉。
 */
describe("isDisabled 的取值边界", () => {
  it("缺字段 / undefined / null / false 一律不算停用", () => {
    expect(isDisabled(rec())).toBe(false);
    expect(isDisabled(rec({ disabled: undefined }))).toBe(false);
    expect(isDisabled(rec({ disabled: null as unknown as boolean }))).toBe(false);
    expect(isDisabled(rec({ disabled: false }))).toBe(false);
  });
  /**
   * 存储被手工写坏时**倒向「停用」**：那一侧是安全的——key 停了、面板也如实显示
   * 成已停用，运维看得见、点一下就能改回来；反过来（判成没停用）则是运维明明关了
   * 它、网关继续拿它发请求，而面板还说它可用。
   * **变红条件**：把 `!!r.disabled` 改成 `r.disabled === true`。
   */
  it("存储被写坏成非布尔真值时倒向「停用」，且返回的仍是真布尔", () => {
    const broken = rec({ disabled: "true" as unknown as boolean });
    expect(isDisabled(broken)).toBe(true);
    expect(isAvailable(broken, NOW)).toBe(false);
  });
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
  /**
   * **行为断言**：不是问 `isAvailable` 怎么说，而是问轮询真的会不会把它发出去。
   * 夹具里被停用的那把**既没剔除也不在冷却**，所以它是不是被跳过，唯一的决定者
   * 就是 `disabled`。**变红条件**：`isAvailable` 去掉 `!isDisabled(r)`。
   */
  it("被管理员停用的 key 不会被 selectKey 选中——面板上的那个开关必须是真的", () => {
    const rs = [rec({ id: "a", disabled: true }), rec({ id: "b" })];
    expect(selectKey(rs, 0, NOW)!.record.id).toBe("b");
    expect(selectKey([rec({ id: "a", disabled: true })], 0, NOW), "整池都停用时无人可选").toBeNull();
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
  it("冷却设置到期时刻并记录原因", () => {
    const r = applyCooldown(rec(), NOW, 60_000, "rate limited");
    expect(r.cooldownUntil).toBe(NOW + 60_000);
    expect(r.cooldownReason).toBe("rate limited");
  });
  it("strike 未达上限只累加，不冷却也不剔除", () => {
    const r = applyStrike(rec({ strikes: 1 }), NOW, STRIKE_CFG, "timeout");
    expect(r.strikes).toBe(2);
    expect(r.evicted).toBe(false);
    expect(r.cooldownUntil).toBe(0);
  });

  // 设计 §7.2.1：瞬时故障累计到上限时是**长冷却**，不是永久剔除。
  // 原实现在这里置 evicted，导致上游一次抖动就能永久摧毁整个池子。
  it("strike 达到上限时进入长冷却而不是永久剔除", () => {
    const r = applyStrike(rec({ strikes: 2 }), NOW, STRIKE_CFG, "upstream 503");
    expect(r.evicted).toBe(false);
    expect(r.evictedReason).toBeNull();
    expect(r.cooldownUntil).toBe(NOW + STRIKE_CFG.cooldownStrikeMs);
    expect(r.cooldownReason).toBe("upstream 503");
  });
  it("进入长冷却时 strikes 清零，冷却到期后该 key 重新可用", () => {
    const r = applyStrike(rec({ strikes: 2 }), NOW, STRIKE_CFG, "upstream 503");
    expect(r.strikes).toBe(0);
    expect(isAvailable(r, NOW)).toBe(false);
    expect(isAvailable(r, NOW + STRIKE_CFG.cooldownStrikeMs)).toBe(true);
  });
  it("剔除记录原因", () => {
    expect(applyEvict(rec(), "upstream 401").evictedReason).toBe("upstream 401");
  });
  it("成功会清掉冷却原因", () => {
    expect(applySuccess(rec({ cooldownReason: "rate limited" }), NOW).cooldownReason).toBeNull();
  });
  it("状态迁移不修改入参", () => {
    const original = rec({ strikes: 0 });
    applyStrike(original, NOW, STRIKE_CFG, "x");
    expect(original.strikes).toBe(0);
  });
});

describe("poolHealth", () => {
  it("分别统计可用、冷却中、已剔除与已停用", () => {
    const rs = [
      rec({ id: "a" }),
      rec({ id: "b", cooldownUntil: NOW + 1000 }),
      rec({ id: "c", evicted: true }),
      rec({ id: "d", disabled: true }),
    ];
    // 手写字面量，不从被测对象反推（第 6 种假阳性）。
    expect(poolHealth(rs, NOW)).toEqual({ total: 4, fresh: 1, cooling: 1, evicted: 1, disabled: 1 });
  });
  /**
   * 设计 §6.2 逐字：**被停用的 key 既不算 `fresh` 也不算 `evicted`**。
   * 两格都要单独钉：算进 `fresh` ⇒ `unavailable()` 以为池子还有得用、退回
   * `upstream_error`；算进 `evicted` ⇒ 503 让运维「去换 key」，而其实是他自己关的。
   * **变红条件**：把 `poolHealth` 里的 `disabled++` 换成 `fresh++` 或 `evicted++`。
   */
  it("停用的 key 既不算 fresh 也不算 evicted，且四格之和恒等于 total", () => {
    const h = poolHealth([rec({ id: "a", disabled: true }), rec({ id: "b" })], NOW);
    // 算进 fresh 的话 fresh 会是 2；算进 evicted 的话 evicted 会是 1。两格各钉一次。
    expect(h).toEqual({ total: 2, fresh: 1, cooling: 0, evicted: 0, disabled: 1 });
    expect(h.fresh + h.cooling + h.evicted + h.disabled).toBe(h.total);
  });
  /**
   * 优先级必须与 `keyBucket` 同序（`disabled > evicted > cooling > fresh`）：
   * 两处不同序就会出现「概览卡说 1 把冷却中、Key 池列表一把冷却中的都没有」。
   * 三格给的是**不同的**字段组合（第 1 种假阳性防护：不能都设成 true 就完事）。
   */
  it("同时命中多档时按优先级只计一次：disabled > evicted > cooling", () => {
    const rs = [
      rec({ id: "a", disabled: true, evicted: true, cooldownUntil: NOW + 1000 }),
      rec({ id: "b", disabled: true, evicted: false, cooldownUntil: NOW + 1000 }),
      rec({ id: "c", disabled: false, evicted: true, cooldownUntil: NOW + 1000 }),
    ];
    expect(poolHealth(rs, NOW)).toEqual({ total: 3, fresh: 0, cooling: 0, evicted: 1, disabled: 2 });
  });
  it("存量记录（没有 disabled 字段）一条都不进 disabled 格", () => {
    expect(poolHealth([rec({ id: "a" }), rec({ id: "b" })], NOW))
      .toEqual({ total: 2, fresh: 2, cooling: 0, evicted: 0, disabled: 0 });
  });
});
