/**
 * key 的分档。**顺序即优先级。**
 *
 * 只有三档。设计文档 §10.2 写的是四档（多一个「人工停用」），但那一档要求
 * `KeyRecord.disabled` 与 `isAvailable` / `poolHealth` 一起改，而后两者是热路径
 *（poolHealth 正被 503 的三条 reason 用着），设计文档 §12 已把它排在写操作那一期。
 * **加档必须与调度改动捆绑**：分档与调度分叉的后果是「面板说停用了，网关照样在用」。
 * 这条由 tests/ui/bucket.test.ts 的等价关系用例钉着——只改这里会让它变红。
 *
 * 这个目录下的文件受三条硬规则约束，规则全文见 admin-ui/README.md。
 */
export const BUCKETS = ["evicted", "cooling", "fresh"];

export function keyBucket(rec, now) {
  if (!rec || typeof rec !== "object") return "evicted";
  // 剔除优先于冷却：两者同时成立时（一把先冷却后被判 401 的 key）报「已剔除」，
  // 因为「到期自动恢复」对它是假的——那正是 503 三条 reason 要区分的东西。
  if (rec.evicted === true) return "evicted";
  if (typeof rec.cooldownUntil === "number" && rec.cooldownUntil > now) return "cooling";
  return "fresh";
}
