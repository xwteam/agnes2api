import { describe, it, expect } from "vitest";
import { maskKey, keyBucket, toKeyViews, bucketCounts, matchesQuery } from "../../../src/core/admin/key-view.js";
import { isAvailable } from "../../../src/core/keypool.js";
import type { KeyRecord } from "../../../src/core/types.js";

const mk = (over: Partial<KeyRecord>): KeyRecord => ({
  id: "id0", key: "sk-abcdefghijklmnop", addedAt: 0, lastUsedAt: null,
  cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null, ...over,
});

/**
 * 掩码是硬规则，不是显示偏好：`KeyPoolRepo.all()` 返回的记录含完整明文 key，
 * 直接 JSON 吐给面板等于把整池上游 key 交出去。**且没有任何 reveal 端点**——
 * 有了它，面板口令泄漏就等于整池泄漏。
 */
describe("KeyView 永不含明文", () => {
  it("投影出来的对象里没有 key 字段，也没有任何值等于原串", () => {
    const rec = mk({ key: "sk-THE-WHOLE-SECRET-VALUE" });
    const [v] = toKeyViews([rec], 0);
    expect(Object.keys(v!)).not.toContain("key");
    // 逐个值扫一遍：只断言「没有 key 这个字段名」拦不住「顺手塞进 note 字段」。
    for (const val of Object.values(v!)) {
      expect(JSON.stringify(val)).not.toContain("WHOLE-SECRET");
    }
  });
  it("maskKey 与前端那份 pure/mask.mjs 在同一组夹具上结果一致", async () => {
    // 两边各有一份实现（后端 TS / 前端 .mjs），**共享夹具的一致性断言**是设计文档
    // §16.1 U4 指定的处置：两边都要时，用同一组输入断言结果相等。
    const { maskKey: front } = await import("../../../admin-ui/js/pure/mask.mjs");
    for (const s of ["", "sk", "0123456789", "0123456789a", "sk-abcdefghijklmnop"]) {
      expect(maskKey(s), s).toBe(front(s));
    }
  });
});

describe("keyBucket 与 isAvailable 等价（后端这一份同样要钉）", () => {
  const NOW = 1000;
  for (const [name, rec] of [
    ["全新", mk({})],
    ["冷却中", mk({ cooldownUntil: NOW + 1 })],
    ["冷却刚好到期", mk({ cooldownUntil: NOW })],
    ["已剔除", mk({ evicted: true })],
    ["已剔除且冷却中", mk({ evicted: true, cooldownUntil: NOW + 1 })],
  ] as const) {
    it(`${name}`, () => {
      expect(keyBucket(rec, NOW) === "fresh").toBe(isAvailable(rec, NOW));
    });
  }
});

describe("序号派生", () => {
  it("按 addedAt 升序，从 1 开始；**与传入顺序无关**", () => {
    const views = toKeyViews([mk({ id: "c", addedAt: 30 }), mk({ id: "a", addedAt: 10 }), mk({ id: "b", addedAt: 20 })], 0);
    expect(views.map((v) => [v.id, v.seq])).toEqual([["c", 3], ["a", 1], ["b", 2]]);
  });
  it("addedAt 相同时用 id 破平——否则同一批导入的 key 序号每次刷新都在跳", () => {
    const views = toKeyViews([mk({ id: "b", addedAt: 5 }), mk({ id: "a", addedAt: 5 })], 0);
    expect(views.find((v) => v.id === "a")!.seq).toBe(1);
    expect(views.find((v) => v.id === "b")!.seq).toBe(2);
  });
});

describe("搜索绝不能变成明文预言机", () => {
  /**
   * `?q` 若匹配完整明文 key，管理员（或任何拿到面板口令的人）就能**逐字猜**：
   * 提交一段猜测、看返回条数，把「没有 reveal 端点」这条保证降级成一个慢速预言机。
   * ⇒ 只匹配 id 与掩码后的可见部分。
   */
  it("拿明文 key 的中间片段搜，一条都搜不到", () => {
    const [v] = toKeyViews([mk({ id: "abc123", key: "sk-headMIDDLEtail" })], 0);
    expect(matchesQuery(v!, "MIDDLE")).toBe(false);
    expect(matchesQuery(v!, "headMIDDLEtail")).toBe(false);
  });
  it("按 id 前缀、以及掩码里**看得见**的那两段能搜到（否则搜索框没用）", () => {
    const [v] = toKeyViews([mk({ id: "abc123", key: "sk-headMIDDLEtail" })], 0);
    expect(matchesQuery(v!, "abc")).toBe(true);
    expect(matchesQuery(v!, "sk-he")).toBe(true);   // maskKey 保留前 5 位
    expect(matchesQuery(v!, "tail")).toBe(true);    // maskKey 保留后 4 位
  });
  it("空查询匹配一切（筛选器不该在没输入时把列表清空）", () => {
    const [v] = toKeyViews([mk({})], 0);
    expect(matchesQuery(v!, "")).toBe(true);
  });
});

describe("bucketCounts", () => {
  it("四个数各自独立，且 all === fresh + cooling + evicted", () => {
    const views = toKeyViews([
      mk({ id: "a" }), mk({ id: "b", cooldownUntil: 5000 }),
      mk({ id: "c", evicted: true }), mk({ id: "d", evicted: true, cooldownUntil: 5000 }),
    ], 1000);
    const c = bucketCounts(views);
    // 手写字面量，不从 views 反推。
    expect(c).toEqual({ all: 4, fresh: 1, cooling: 1, evicted: 2 });
    expect(c.all).toBe(c.fresh + c.cooling + c.evicted);
  });
});
