import type { KeyRecord, KeyStats } from "../types.js";
import { isDisabled } from "../keypool.js";
import { normalizeStats } from "./stats.js";

/**
 * 上游 key 的掩码。**全仓唯一的一份实现。**
 *
 * @refs-ignore（本段要点名那个**已经被删掉**的前端副本，路径按定义解析不开）
 * ⚠️ 这里原来写着「与 `admin-ui/js/pure/mask.mjs` 是两份实现……由共享夹具一致性
 * 断言钉住（设计文档 §16.1 U4）」。那个前端副本在通读评审里被删掉了：
 * 它在 `admin-ui/js/` 里**零导入者**——面板显示的 `masked` 就是下面 `toKeyViews()`
 * 算好放进 `GET /admin/api/keys` 响应里的那个值。§16.1 U4 处置的是"两边都要"的
 * 情形，而这里并不需要两边。真要在浏览器侧再算一次，把那个模块与那条一致性断言
 * 一起加回来。
 *
 * **绝不返回原值**：返回原值的「掩码」比没有掩码更糟，调用方会以为它安全了。
 * 边界由 `tests/unit/admin/key-view.test.ts` 的「maskKey 的边界」钉着。
 *
 * ⚠️ **这里原来写的是 `:40`，而 `:40` 是一行注释——真正的 `it(` 在 `:42`，已腐烂 2 行。**
 * 改成**名字锚**而不是改成 `:42`，理由是行号会再腐烂一次；而且这条指向原来整个
 * 落在上面那段豁免标记的**块级**范围里，门禁根本没看过它。本任务把豁免收窄到
 * 段级（见 `scripts/check-comment-refs.mjs` 的 `IGNORE_MARKER`），这条才第一次
 * 进入校验范围。**两件事必须都做，只做一件都不够**：只收窄豁免的话，门禁的
 * `WINDOW = 6` 本来也抓不住这次 2 行的漂移。
 *
 * ⚠️ 上一段刻意**不写**那个标记的字面名字——写了这一段自己就会被豁免掉，
 * 而被豁免掉的正是上面那条刚修好的名字锚。（门禁脚本自己为同一件事把
 * `IGNORE_FILE_RE` 的标记名拆成两段拼，理由完全一样。）
 */
export function maskKey(key: string): string {
  if (typeof key !== "string" || key.length <= 10) return "…";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export const BUCKETS = ["disabled", "evicted", "cooling", "fresh"] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * 分档。**顺序即优先级**（`disabled > evicted > cooling > fresh`，设计文档 §10.2）。
 *
 * 第四档（人工停用）与 `isAvailable` / `poolHealth` 是一起落地的——
 * 那两者是热路径（`poolHealth` 正被 `unavailable()` 用来决定 503 的四条 reason），
 * 所以每一处的 `disabled` 判据都是**同一个函数** `isDisabled`。
 * **完整的调用处清单只在 `src/core/keypool.ts` 的 `isDisabled` 文件头维护一份**，
 * 这里刻意不复述条数：本任务已经因为「在两个地方各写一个数」而写错两次
 * （一次写成「三个读取处」、一次写成「`isAvailable` 有四个调用处」），
 * 而没有任何门禁校验得了注释里的数字。
 * `keyBucket(...) === "fresh"` 与 `isAvailable(...)` 的等价关系由
 * `tests/unit/admin/key-view.test.ts「keyBucket === "fresh" 当且仅当 isAvailable」`
 * 那一组用例钉着：**加档而不改调度会让它变红**（更早预埋的 `disabled: true` 夹具
 * 实测能抓住，开工前又复跑了一次：2 条红）。
 */
export function keyBucket(r: KeyRecord, now: number): Bucket {
  if (isDisabled(r)) return "disabled";
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
  /**
   * 管理员手工停用。**恒是布尔、恒存在**，即使记录里压根没有 `disabled` 字段。
   *
   * `KeyRecord.disabled` 是可选的（存量记录没有它），而 `c.json` 会把值为
   * `undefined` 的字段**整个丢掉** ⇒ 前端拿到的是「字段不存在」而不是 `false`，
   * 分不清「没停用」和「读不出来」，违反约束 10（诚实标记由后端字段驱动）。
   * 所以这里过一道 `isDisabled()` 落成布尔，**不许直接写 `disabled: r.disabled`**。
   */
  disabled: boolean;
  /**
   * 运维备注。**恒存在、恒是 `string | null`**，理由与上面的 `disabled` 逐字相同：
   * `KeyRecord.note` 是可选的，`c.json` 会把值为 `undefined` 的字段整个丢掉。
   *
   * ⚠️ **它是后来才进这个结构的，而在那之前不进是对的**：更早那一轮建了
   * `KeyRecord.note` 的槽位但**没有生产者**，一个恒为 `null` 的响应字段正是本仓
   * 已经裁掉过四次的形态。`PATCH /admin/api/keys/:id` 是它的第一个
   * 生产者，**也是它必须同时进这里的原因**：`note` 是 telemetry
   * （`src/core/keypool-repo.ts` 的 `FIELD_ROLE`），一次只改备注的写会被写消除
   * 整个吃掉，而**没有任何自动化会在那时变红**——唯一能把它钉住的护栏就是
   * 「改完之后从 `GET /admin/api/keys` 真的读得回来」，那条路必须经过这个字段。
   * 由 `tests/contract/admin-keys-write.test.ts` 的
   * 「只改备注的 PATCH：改完之后 GET 真的读得回来」守着。
   *
   * ⚠️⚠️ **给渲染这一列的人一条硬要求：它是本结构里第一个「运维自由输入、又会被投影到面板上」
   * 的字段，渲染必须走 `textContent`，绝不许拼进 innerHTML。**
   * 其余字段要么是后端算出来的枚举（`bucket`）、要么是数字、要么是掩码，
   * **只有它整串来自请求体**。后端刻意不做转义（与事件板块同一条裁定：JSON 响应体的
   * 字段边界由 JSON 语法本身保证，转义是渲染层的事）——所以这句话必须在渲染那一侧
   * 被执行，**别以为后端已经洗过了**。
   */
  note: string | null;
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
      disabled: isDisabled(r),
      // `?? null`：`undefined` 会被 `c.json` 整个丢掉，见 `KeyView.note`。
      note: r.note ?? null,
      stats: normalizeStats(r.stats),
    }));
}

/**
 * 汇总卡的条数。**判据只看 `v.bucket`**，不再各自重算一遍 `disabled` / `evicted`——
 * 重算就是同一条优先级规则的第二份实现，两份迟早会漂。
 */
export function bucketCounts(views: readonly KeyView[]) {
  let fresh = 0, cooling = 0, evicted = 0, disabled = 0;
  for (const v of views) {
    if (v.bucket === "disabled") disabled++;
    else if (v.bucket === "evicted") evicted++;
    else if (v.bucket === "cooling") cooling++;
    else fresh++;
  }
  return { all: views.length, fresh, cooling, evicted, disabled };
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
