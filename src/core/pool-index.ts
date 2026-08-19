/**
 * key 池索引。**存在的唯一理由是把 `list()` 从转发热路径上摘掉。**
 *
 * 改造前每个转发请求消耗 1 次 `list`（KeyPoolRepo.all → storage.list），
 * 而 Cloudflare KV 免费档的 list 配额是 1,000 次/天，与转发请求数 1:1 挂钩
 * ⇒ Worker + 免费 KV 被卡在约 1,000 次转发/天。索引把它降到 0。
 *
 * **不退回「整池存成单条 JSON」**：那样确实只要 1 次 get，但 P1 拆键存储正是为了
 * 避免整池的 last-write-wins（两个并发请求各改一把 key，后写的覆盖先写的整份池子）。
 * 索引只存 id 列表，键本身仍然一 key 一记录，两者兼得。
 *
 * 本文件全部是纯函数，零 IO——存储访问在 KeyPoolRepo 里完成。
 */
export const KEY_PREFIX = "key:";
export const POOL_INDEX_KEY = "pool:index";

/**
 * 结构版本。将来若要改索引形态（例如加上 gen 计数器），把它 +1 即可——
 * `parsePoolIndex` 对不认识的版本返回 null，`all()` 会当作「索引缺失」回落到
 * `list()` 并重建，是一条自动的、不需要迁移脚本的升级路径。
 */
export const POOL_INDEX_VERSION = 1;

export interface PoolIndex {
  v: number;
  ids: string[];
}

export function makePoolIndex(ids: readonly string[]): PoolIndex {
  return { v: POOL_INDEX_VERSION, ids: dedupe(ids) };
}

/**
 * 从存储读回来的东西一律当 `unknown` 窄化（D3 约束：新代码禁止 `Record<string, any>`）。
 *
 * **结构级错误（不是对象 / 版本不对 / ids 不是数组）返回 null**，让调用方走「索引缺失」
 * 那条重建路径；**元素级脏数据（非字符串、空串、重复）就地剔掉**，不让一条脏数据
 * 把整个索引作废——那会退化成每次 all() 都 list 一遍。
 */
export function parsePoolIndex(raw: unknown): PoolIndex | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as { v?: unknown; ids?: unknown };
  if (o.v !== POOL_INDEX_VERSION) return null;
  if (!Array.isArray(o.ids)) return null;
  return makePoolIndex(o.ids.filter((x): x is string => typeof x === "string" && x.length > 0));
}

/** `storage.list(KEY_PREFIX)` 的结果 → id 列表。 */
export function idsFromKeyNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (!n.startsWith(KEY_PREFIX)) continue;
    const id = n.slice(KEY_PREFIX.length);
    if (id.length > 0) out.push(id);
  }
  return dedupe(out);
}

/**
 * 集合相等。**顺序无语义**——按顺序比会让对账在「顺序碰巧不同」时产生一次无谓的
 * KV 写，而写配额恰恰是最紧的那个桶。
 *
 * **两边各自先 dedupe 再比**，不图省事先比长度：原实现（比长度 + 单向包含）对含
 * 重复元素的入参不对称，`sameIdSet(["x","y"], ["x","x"])` 会返回 true。当前两个
 * 调用点的入参都已经过 dedupe，触发不到，但把这个陷阱留给未来的调用方不值当——
 * 它的表现形式会是「对账认为一致因而不修」，正好是最难查的那种沉默。
 */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sb) if (!sa.has(x)) return false;
  return true;
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
