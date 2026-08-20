import type { LogEntry } from "../../ports/logger.js";

/**
 * 事件持久化的环形缓冲与写预算。**零 IO 纯函数**（硬约束 2）：时间从参数进，
 * 状态进、状态出，不碰 `Date.now()` / `crypto` / 任何计时器。
 *
 * 设计文档 §7.2 的存储形态：`event:index` 单键索引 + 每个 isolate 一个
 * `event:<shardId>` 分片，分片内是最多 `EVENT_RING_SIZE` 条的环形数组。
 * 落盘节流（`EVENT_FLUSH_MIN_INTERVAL_MS` + `EVENT_WRITES_PER_HOUR`）与实际的
 * 存储读写在 `src/adapters/logger-store.ts` 的 `StoreLogger` 里，那里才有 IO。
 */

/** 单个分片最多留多少条。超了丢**最旧**的。 */
export const EVENT_RING_SIZE = 100;

/**
 * 两次落盘之间的最小间隔。
 *
 * ⚠️ **设计文档 §7.2 的「满 20 条或距上次 flush > 60s」这条 size 规则被本计划去掉了**，
 * 因为它把写入速率的控制权交给了调用方：白名单里的 `admin.login_failed` 是
 * **任何未鉴权请求都能触发**的（`admin.use("/admin/api/*", adminAuth)` 对任意
 * `/admin/api/` 子路径生效，零凭据零限速），于是攻击者可以按 20 条一批地驱动 KV 写
 * —— **这正是 §8.5 拒绝做分布式登录限速时点名不肯给出去的那根杠杆**
 *（「反复发失败登录就能消耗写配额，把 DoS 面从『猜口令』扩大到『打死 key 池的状态回写』」）。
 */
export const EVENT_FLUSH_MIN_INTERVAL_MS = 60_000;

/**
 * 每个 isolate **每小时**最多落盘几次。
 *
 * 只有最小间隔的话上界是 1,440 次/天/isolate，而写桶只有 1,000 且与 key 状态回写共用。
 * 12 次/小时 ⇒ **≤288 次/天/isolate**，与设计文档给 Tier-2 定的
 * `USAGE_FLUSH_INTERVAL_MS=300s`（同样是 288/天）是同一个数量级和同一套心智。
 * 预算用完时**不写**，缓冲区继续接（满了丢最旧的并计数），
 * 并让 `/admin/api/events` 如实报 `budgetExhausted`。
 * **`ConsoleLogger` 那一路一条都不丢**，排障能力不受影响。
 */
export const EVENT_WRITES_PER_HOUR = 12;

const HOUR_MS = 3_600_000;

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

export interface EventShardIndex {
  readonly v: 1;
  readonly shards: readonly string[];
}

export function makeShardIndex(shards: readonly string[]): EventShardIndex {
  return { v: 1, shards: dedupe(shards) };
}

/**
 * 从存储读回来的东西一律当 `unknown` 窄化（硬要求 D：新代码禁止 `Record<string, any>`）。
 * 与 `src/core/pool-index.ts` 的 `parsePoolIndex` 同一套判据：结构级错误（不是对象 /
 * 版本不对 / shards 不是数组）返回 `null`，让调用方走「索引缺失」那条重建路径；
 * 元素级脏数据（非字符串、空串）就地剔掉，不让一条脏数据把整个索引作废。
 */
export function parseShardIndex(raw: unknown): EventShardIndex | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as { v?: unknown; shards?: unknown };
  if (o.v !== 1) return null;
  if (!Array.isArray(o.shards)) return null;
  return makeShardIndex(o.shards.filter((x): x is string => typeof x === "string" && x.length > 0));
}

/**
 * 环形追加：超出上限丢**最旧**的。返回新数组，不就地改——`cur`/`add` 都不会被写。
 */
export function appendRing(
  cur: readonly LogEntry[],
  add: readonly LogEntry[],
  size: number = EVENT_RING_SIZE,
): LogEntry[] {
  const merged = [...cur, ...add];
  return merged.length > size ? merged.slice(merged.length - size) : merged;
}

/**
 * 多分片归并：按 `ts` 降序（最新在前），同 `ts` 用 `(shard, 序号)` 稳定破平，截到 `limit`。
 *
 * **不依赖 `Array.prototype.sort` 天然稳定**（虽然现代引擎确实稳定）：显式的
 * `(shard, seq)` 二级键让排序结果与「哪个引擎在跑」无关，两种运行时（Node / workerd）
 * 给出的顺序保证逐字节一致。不这样做的话面板每次轮询顺序都可能在跳
 * ——那正是设计文档要求的「同 ts 稳定破平」的全部理由。
 */
export function mergeShards(shards: readonly (readonly LogEntry[])[], limit: number): LogEntry[] {
  const tagged: Array<{ e: LogEntry; shard: number; seq: number }> = [];
  shards.forEach((shard, si) => {
    shard.forEach((e, seq) => tagged.push({ e, shard: si, seq }));
  });
  tagged.sort((a, b) => {
    if (a.e.ts !== b.e.ts) return b.e.ts - a.e.ts;
    if (a.shard !== b.shard) return a.shard - b.shard;
    return a.seq - b.seq;
  });
  return tagged.slice(0, Math.max(0, limit)).map((t) => t.e);
}

/** 写预算。纯函数：状态进、状态出，时间从参数进。 */
export interface WriteBudget {
  hourStart: number;
  used: number;
}

/**
 * 全新的预算。`hourStart: 0` 只是一个哨兵起点——真实的 `at`（无论是测试里从 0 起步
 * 的假时钟，还是生产的 `Date.now()`）第一次调用 `consume` 时都会把 `hourStart` 换成
 * 那次调用的真实 `at`，所以这个初值本身不承载语义，只是「还没有任何窗口」的记号。
 */
export const FRESH_BUDGET: WriteBudget = { hourStart: 0, used: 0 };

/**
 * `at` 是否仍落在 `b` 记录的那个小时窗口内。
 *
 * `at < b.hourStart`（时钟回拨）与 `at - b.hourStart >= HOUR_MS`（正常跨过整点）
 * **都**判定为「不在窗口内」——两者都按「新的一小时」处理，与本仓其余三处
 * （`Refreshable` / `listOnReadPath` / `KeyPoolRepo` 的 `age < 0` 判据）同一套语义：
 * 回拨立刻恢复可写，不会把预算冻结到「回拨量走完」才解封，也不会缓存出负的 `used`。
 */
function inWindow(b: WriteBudget, at: number): boolean {
  return at >= b.hourStart && at - b.hourStart < HOUR_MS;
}

export function canWrite(b: WriteBudget, at: number, perHour: number = EVENT_WRITES_PER_HOUR): boolean {
  const used = inWindow(b, at) ? b.used : 0;
  return used < perHour;
}

export function consume(b: WriteBudget, at: number): WriteBudget {
  return inWindow(b, at) ? { hourStart: b.hourStart, used: b.used + 1 } : { hourStart: at, used: 1 };
}
