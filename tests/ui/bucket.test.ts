import { describe, it, expect } from "vitest";
import { keyBucket, BUCKETS } from "../../admin-ui/js/pure/bucket.mjs";
import { isAvailable } from "../../src/core/keypool.js";
import type { KeyRecord } from "../../src/core/types.js";

const base: KeyRecord = {
  id: "aa", key: "sk-xxxxxxxxxxxxxxxx", addedAt: 0, lastUsedAt: null,
  cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
};

/**
 * **分档必须与真实调度语义一致。**
 *
 * 面板说「这把 key 可用」而网关根本不选它（或反过来）是「面板撒谎」的最坏形态：
 * 运维会照着面板做出完全错误的处置。所以这里不是分别测两个函数，而是把
 * `keyBucket(...) === "fresh"` 与 `isAvailable(...)` 的**等价关系**钉死。
 *
 * ⚠️ **P3c 给 keyBucket 加 `disabled` 档时，如果忘了同时改 isAvailable，这条会变红。**
 * 那正是它存在的理由（设计文档 §12 把 `KeyRecord.disabled` + poolHealth 计数排在 P3c，
 * 因为 poolHealth 正被 unavailable() 用来决定 503 的三条 reason，是热路径改动）。
 *
 * ⚠️ **已实测过这条警告本身**：如果 CASES 里没有一格真的把 `disabled` 设成 `true`，
 * 「给 keyBucket 加一档 disabled 但不改 isAvailable」这个变异**不会被下面的等价关系
 * 循环抓住**——`base` 及其派生 fixture 里 `disabled` 全是 `undefined`，变异后的
 * `keyBucket` 对它们仍然走到 `return "fresh"` 分支，与 `isAvailable` 继续一致，
 * 循环全绿。这个变异当时只被后面「档位集合是手写字面量」那条顺带抓到——那条挡的
 * 是「多了一个档」，不是「多出的档与调度语义脱节」，两者不是一回事：把新档命名成
 * 已有的三个名字之一（不可能，但假设 BUCKETS 断言也被绕过）循环依旧不会红。
 * 所以专门加一格 `disabled: true` 的 fixture，把这个盲区堵上。
 */
describe("keyBucket 与 isAvailable 等价（面板与调度不许分叉）", () => {
  const NOW = 1_000_000;
  const CASES: ReadonlyArray<{ name: string; rec: KeyRecord }> = [
    { name: "全新", rec: base },
    { name: "冷却中", rec: { ...base, cooldownUntil: NOW + 1 } },
    { name: "冷却刚好到期（边界：<= now 即可用）", rec: { ...base, cooldownUntil: NOW } },
    { name: "已剔除", rec: { ...base, evicted: true, evictedReason: "401" } },
    { name: "已剔除且冷却中（两者同时成立——单状态用例区分不了优先级，第 5 种假阳性）", rec: { ...base, evicted: true, cooldownUntil: NOW + 1 } },
    { name: "有 strikes 但未冷却（strikes 不参与可用性判定）", rec: { ...base, strikes: 2 } },
    {
      name: "带着 P3c 才会生效的 disabled=true（KeyRecord 今天还没有这个字段，"
        + "未来加了却忘改 isAvailable 时，这一格必须能把它抓出来）",
      rec: { ...base, disabled: true } as KeyRecord,
    },
  ];
  for (const { name, rec } of CASES) {
    it(`${name}：keyBucket === "fresh" 当且仅当 isAvailable`, () => {
      expect(keyBucket(rec, NOW) === "fresh").toBe(isAvailable(rec, NOW));
    });
  }
  it("优先级：已剔除且冷却中时报 evicted，不报 cooling", () => {
    expect(keyBucket({ ...base, evicted: true, cooldownUntil: NOW + 1 }, NOW)).toBe("evicted");
  });
  it("档位集合是手写字面量，加档必须在评审里被看见", () => {
    expect([...BUCKETS]).toEqual(["evicted", "cooling", "fresh"]);
  });
});
