import type { Logger, LogEntry } from "../ports/logger.js";
import type { Storage } from "../ports/storage.js";
import {
  EVENT_RING_SIZE, EVENT_FLUSH_MIN_INTERVAL_MS, EVENT_WRITES_PER_HOUR,
  appendRing, mergeShards, parseShardIndex, makeShardIndex,
  FRESH_BUDGET, canWrite, consume, type WriteBudget,
} from "../core/admin/event-ring.js";

export const EVENT_INDEX_KEY = "event:index";
export const EVENT_SHARD_PREFIX = "event:";

/** `readEvents()` 的返回形状：归并结果 + 参与归并的分片数（面板据此算配额账）。 */
export interface ReadEventsResult {
  items: LogEntry[];
  shardCount: number;
}

/**
 * 事件落库 sink。
 *
 * 存储形态（设计文档 §7.2，避开 §2.4 第 1 条）：
 *   `event:index`      单键：`{ v:1, shards: string[] }` —— 只在出现新分片时写（每 isolate 一生一次）
 *   `event:<shardId>`  单键：`LogEntry[]`（环形，最多 EVENT_RING_SIZE 条）
 * **面板轮询路径 = 1 次 get + K 次 get，零 `list()`、零 `delete()`。**
 *
 * `log()` 是同步的（端口如此），所以这里**只缓冲，不落盘**。
 * 落盘由 `src/http/log-flush.ts` 的中间件在**请求收尾时 await**——
 * 两种运行时同一条代码路径，且写一定在响应返回前完成。
 * 用 fire-and-forget 的话 Worker 上响应返回后 isolate 可能立刻停摆，写会被截断。
 */
export class StoreLogger implements Logger {
  private buffer: LogEntry[] = [];
  private lastFlushAt: number | null = null;
  private budget: WriteBudget = FRESH_BUDGET;
  private indexWritten = false;
  private dropped = 0;

  constructor(private readonly o: {
    storage: Storage;
    now: () => number;
    shardId: string;
    /** sink 自身故障绝不许拖垮主流程；出错走这里（通常是 ConsoleLogger）。 */
    onError: (err: unknown) => void;
  }) {}

  log(e: Omit<LogEntry, "ts">): void {
    this.buffer.push({ ...e, ts: this.o.now() });
    if (this.buffer.length > EVENT_RING_SIZE) {
      // 丢**最旧**的。丢掉的条数要能被面板看见——静默丢弃就是撒谎。
      this.buffer.shift();
      this.dropped++;
    }
  }

  /** 面板要看的自述状态。 */
  status(): { shardId: string; buffered: number; dropped: number; budgetExhausted: boolean } {
    return {
      shardId: this.o.shardId, buffered: this.buffer.length, dropped: this.dropped,
      budgetExhausted: !canWrite(this.budget, this.o.now()),
    };
  }

  /**
   * 到点就落盘。**由中间件在请求收尾 await**，不是定时器——
   * 定时器是 IO 能力，Worker 上也没有常驻进程可挂。
   */
  async maybeFlush(): Promise<void> {
    const at = this.o.now();
    if (this.buffer.length === 0) return;
    if (this.lastFlushAt !== null) {
      const since = at - this.lastFlushAt;
      // `since < 0` = 时钟回拨：立刻恢复，与本仓其余三处同一套语义。
      if (since >= 0 && since < EVENT_FLUSH_MIN_INTERVAL_MS) return;
    }
    if (!canWrite(this.budget, at, EVENT_WRITES_PER_HOUR)) return;

    const batch = this.buffer;
    this.buffer = [];
    // 窗口与预算**在发起写之前**就推进：写失败时不重试同一批（下一轮再攒），
    // 否则存储持续故障会让每个请求都白付一次 put。
    this.lastFlushAt = at;
    this.budget = consume(this.budget, at);
    try {
      const key = EVENT_SHARD_PREFIX + this.o.shardId;
      const cur = (await this.o.storage.get<LogEntry[]>(key)) ?? [];
      await this.o.storage.put(key, appendRing(cur, batch, EVENT_RING_SIZE));
      if (!this.indexWritten) {
        const idx = parseShardIndex(await this.o.storage.get<unknown>(EVENT_INDEX_KEY));
        const shards = idx ? idx.shards : [];
        if (!shards.includes(this.o.shardId)) {
          await this.o.storage.put(EVENT_INDEX_KEY, makeShardIndex([...shards, this.o.shardId]));
        }
        // 索引一生只写一次：**写成功之后才置位**，失败时下一轮还会再试。
        this.indexWritten = true;
      }
    } catch (err) {
      this.o.onError(err);
    }
  }

  /**
   * 面板读路径。**1 次 `event:index` get + K 次分片 get，零 `list()`、零 `delete()`**
   * ——这是本任务的第一条硬要求（KV 免费档 list 桶与写桶同样只有 1,000 次/天，
   * 面板 15 秒轮询一次若走 list 就是 5,760 次/天，5 倍超配额）。
   *
   * **不做任何过滤/截断，只做归并**：`after` / `level` / `limit` 由
   * `src/http/admin/handlers/events.ts` 在归并结果之上过滤——「归并 → 过滤 → 截到
   * limit」的顺序不能倒过来，否则先截断再按 level 过滤会把本该出现的旧事件漏掉。
   * `mergeShards` 的 `limit` 这里给「理论最大条数」（分片数 × 环形上限），
   * 相当于「不截断」，真正的截断交给调用方。
   *
   * 缺失/畸形的分片数据（`get` 返回 `null` 或不是数组）当空分片处理，不让一个坏分片
   * 拖垮整个归并——这与 `parseShardIndex` 对脏索引的「结构错就整体重建」不同：索引
   * 脏了没有别的数据源可用，分片脏了别的分片仍然有效数据，值得保留。
   */
  async readEvents(): Promise<ReadEventsResult> {
    const idx = parseShardIndex(await this.o.storage.get<unknown>(EVENT_INDEX_KEY));
    const shardIds = idx ? idx.shards : [];
    const rawShards = await Promise.all(
      shardIds.map((id) => this.o.storage.get<LogEntry[]>(EVENT_SHARD_PREFIX + id)),
    );
    const shards = rawShards.map((s) => (Array.isArray(s) ? s : []));
    const items = mergeShards(shards, shardIds.length * EVENT_RING_SIZE);
    return { items, shardCount: shardIds.length };
  }
}
