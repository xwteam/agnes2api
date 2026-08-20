import type { KeyRecord, KeyStats } from "../types.js";
import { normalizeStats } from "./stats.js";

/**
 * 上游 key 的掩码。**全仓唯一的一份实现。**
 *
 * ⚠️ 这里原来写着「与 `admin-ui/js/pure/mask.mjs` 是两份实现……由共享夹具一致性
 * 断言钉住（设计文档 §16.1 U4）」。那个前端副本在全分支评审 B3 被删掉了：
 * 它在 `admin-ui/js/` 里**零导入者**——面板显示的 `masked` 就是下面 `toKeyViews()`
 * 算好放进 `GET /admin/api/keys` 响应里的那个值。§16.1 U4 处置的是"两边都要"的
 * 情形，而这里并不需要两边。真要在浏览器侧再算一次，把那个模块与那条一致性断言
 * 一起加回来。
 *
 * **绝不返回原值**：返回原值的「掩码」比没有掩码更糟，调用方会以为它安全了。
 * 边界由 `tests/unit/admin/key-view.test.ts:40` 钉着。
 */
export function maskKey(key: string): string {
  if (typeof key !== "string" || key.length <= 10) return "…";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export const BUCKETS = ["evicted", "cooling", "fresh"] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * 分档。**顺序即优先级。** 只有三档——第四档（人工停用）要求 `KeyRecord.disabled`
 * 与 `isAvailable` / `poolHealth` 一起改，而后两者是热路径（`poolHealth` 正被
 * `unavailable()` 用来决定 503 的三条 reason），设计文档 §12 已排在写操作那一期。
 * `keyBucket(...) === "fresh"` 与 `isAvailable(...)` 的等价关系由用例钉着：
 * **加档而不改调度会让它变红。**
 */
export function keyBucket(r: KeyRecord, now: number): Bucket {
  if (r.evicted) return "evicted";
  if (r.cooldownUntil > now) return "cooling";
  return "fresh";
}

export interface KeyView {
  id: string;
  /** 掩码。**这个结构永不含明文 key，也没有任何 reveal 端点。** */
  masked: string;
  /** 面板上的行号。按 `addedAt` 升序、`id` 破平——否则同一批导入的 key 每次刷新都在跳。 */
  seq: number;
  bucket: Bucket;
  addedAt: number;
  lastUsedAt: number | null;
  cooldownUntil: number;
  cooldownReason: string | null;
  evictedReason: string | null;
  strikes: number;
  /** Tier-1。**近似值**：并发下少计，且最多晚一个 `POOL_TOUCH_INTERVAL_MS` 落盘。 */
  stats: KeyStats;
}

/**
 * 投影成面板要的形状，**并按 `seq` 的顺序返回**。
 *
 * ⚠️ **返回顺序不是「顺手排一下好看」，分页的正确性建立在它上面。**
 * 传入顺序来自 `pool:index`，而 `pool-index.ts` 明写「顺序无语义」——`reconcileIndex()`
 * 会拿 `list()` 的结果整体重排它。只算 `seq` 却按传入顺序返回，后果有三层：
 * ①面板上出现 `#7 / #2 / #19`；②一次索引对账之后整个列表重排，而什么都没增删；
 * ③**分页在两次请求之间不稳定**，翻页会重复或漏掉条目。
 */
export function toKeyViews(records: readonly KeyRecord[], now: number): KeyView[] {
  return [...records]
    .sort((a, b) => (a.addedAt - b.addedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r, i) => ({
      id: r.id,
      masked: maskKey(r.key),
      seq: i + 1,
      bucket: keyBucket(r, now),
      addedAt: r.addedAt,
      lastUsedAt: r.lastUsedAt,
      cooldownUntil: r.cooldownUntil,
      cooldownReason: r.cooldownReason,
      evictedReason: r.evictedReason,
      strikes: r.strikes,
      stats: normalizeStats(r.stats),
    }));
}

export function bucketCounts(views: readonly KeyView[]) {
  let fresh = 0, cooling = 0, evicted = 0;
  for (const v of views) {
    if (v.bucket === "evicted") evicted++;
    else if (v.bucket === "cooling") cooling++;
    else fresh++;
  }
  return { all: views.length, fresh, cooling, evicted };
}

/**
 * 搜索。**只匹配 id 与掩码后的可见部分，绝不匹配明文 key。**
 * 匹配明文等于把「没有 reveal 端点」这条保证降级成一个慢速预言机：
 * 提交一段猜测、看返回条数，就能逐字猜出整把 key。
 */
export function matchesQuery(v: KeyView, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (s === "") return true;
  return v.id.toLowerCase().includes(s) || v.masked.toLowerCase().includes(s);
}
