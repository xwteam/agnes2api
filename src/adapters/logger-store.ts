import type { Logger, LogEntry } from "../ports/logger.js";
import type { Storage } from "../ports/storage.js";
import {
  EVENT_RING_SIZE, EVENT_FLUSH_MIN_INTERVAL_MS, EVENT_WRITES_PER_DAY,
  appendRing, truncatedCount, mergeShards, candidateKeys, windowIndex, slotOf, shardKey,
  FRESH_BUDGET, canWrite, consume, type WriteBudget,
} from "../core/admin/event-ring.js";

/** `readEvents()` 的返回形状：归并结果，供 events handler 过滤/截断/序列化。 */
export interface ReadEventsResult {
  items: LogEntry[];
}

/**
 * 事件落库 sink。
 *
 * ⚠️ **存储形态是评审 3 条 Critical 之后的重写版**：不再有 `event:index`。
 * `event:<窗口>:<槽位>`（`src/core/admin/event-ring.ts` 的 `shardKey`/`candidateKeys`）
 * 是一个**有界、可从时钟直接算出来**的键空间——**面板轮询路径 = K 次 get（K 是
 * `candidateKeys()` 算出来的候选键数，稳态下是个小常数），零 `list()`、零 `delete()`、
 * 零索引读改写**。
 *
 * `log()` 是同步的（端口如此），所以这里**只缓冲，不落盘**。
 * 落盘由 `src/http/log-flush.ts` 的中间件在**请求收尾时 await**——
 * 两种运行时同一条代码路径，且写一定在响应返回前完成。
 * 用 fire-and-forget 的话 Worker 上响应返回后 isolate 可能立刻停摆，写会被截断。
 */
export class StoreLogger implements Logger {
  private buffer: LogEntry[] = [];
  private lastFlushAt: number;
  private budget: WriteBudget = FRESH_BUDGET;
  /** 内存缓冲溢出丢的条数（`log()` 那一侧）。 */
  private bufferDropped = 0;
  /** 落盘时分片环形截断丢的条数（`maybeFlush()` 那一侧，见 I1）。 */
  private persistedDropped = 0;
  /** 这个 isolate 稳定落在哪个槽位，构造时算一次，终生不变（见 `slotOf` 的说明）。 */
  private readonly slot: number;

  constructor(private readonly o: {
    storage: Storage;
    now: () => number;
    shardId: string;
    /** sink 自身故障绝不许拖垮主流程；出错走这里（通常是 ConsoleLogger）。 */
    onError: (err: unknown) => void;
  }) {
    this.slot = slotOf(o.shardId);
    // **评审 C1 的另一半：冷启动首刷必须受最小间隔节流。**
    // 原来这里是 `null`，`maybeFlush()` 判到 `lastFlushAt === null` 就跳过间隔检查，
    // 等于每次 isolate 冷启动送一次零门槛写（评审实测「每次冷启动 = 2 次 KV 写」）。
    // 初值给 `now()`：冷启动那一刻的时间戳，之后的第一次 `maybeFlush()` 与它做差，
    // 和任何一次后续的 flush 走同一套间隔判断，不再有特殊豁免。
    this.lastFlushAt = o.now();
  }

  log(e: Omit<LogEntry, "ts">): void {
    this.buffer.push({ ...e, ts: this.o.now() });
    if (this.buffer.length > EVENT_RING_SIZE) {
      // 丢**最旧**的。丢掉的条数要能被面板看见——静默丢弃就是撒谎。
      this.buffer.shift();
      this.bufferDropped++;
    }
  }

  /** 面板要看的自述状态。`dropped` 是缓冲侧与落盘侧两类丢弃的**总数**（评审 I1）。 */
  status(): { shardId: string; buffered: number; dropped: number; budgetExhausted: boolean } {
    return {
      shardId: this.o.shardId, buffered: this.buffer.length,
      dropped: this.bufferDropped + this.persistedDropped,
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
    const since = at - this.lastFlushAt;
    // `since < 0` = 时钟回拨：立刻恢复，与本仓其余三处同一套语义。
    if (since >= 0 && since < EVENT_FLUSH_MIN_INTERVAL_MS) return;
    if (!canWrite(this.budget, at, EVENT_WRITES_PER_DAY)) return;

    const batch = this.buffer;
    this.buffer = [];
    // 窗口与预算**在发起写之前**就推进：写失败时不重试同一批（下一轮再攒），
    // 否则存储持续故障会让每个请求都白付一次 put。
    this.lastFlushAt = at;
    this.budget = consume(this.budget, at);
    try {
      const key = shardKey(windowIndex(at), this.slot);
      const cur = (await this.o.storage.get<LogEntry[]>(key)) ?? [];
      this.persistedDropped += truncatedCount(cur.length, batch.length, EVENT_RING_SIZE);
      await this.o.storage.put(key, appendRing(cur, batch, EVENT_RING_SIZE));
    } catch (err) {
      this.o.onError(err);
    }
  }

  /**
   * 面板读路径。**候选键由 `candidateKeys()` 从时钟直接算出来，零 `list()`、零索引读**
   * ——这是本任务的第一条硬要求，也是评审 C2/C3 的根治方式（详见
   * `src/core/admin/event-ring.ts` 文件头）。
   *
   * `after`：`null` 时是"冷读"（回看 `EVENT_WINDOW_RETAIN` 个窗口），有值时是"暖读"
   * （只看 `after` 所在窗口到当前窗口，通常 1~2 个）——见 `candidateKeys` 的说明。
   *
   * **不做任何过滤/截断，只做归并**：`after` 的过滤、`level` 的过滤、`limit` 的截断
   * 由 `src/http/admin/handlers/events.ts` 在归并结果之上处理——"归并 → 过滤 → 截到
   * limit"的顺序不能倒过来，否则先截断再按 level 过滤会把本该出现的旧事件漏掉。
   *
   * 缺失/畸形的分片数据（`get` 返回 `null` 或不是数组）当空分片处理，不让一个坏分片
   * 拖垮整个归并。
   */
  async readEvents(after: number | null): Promise<ReadEventsResult> {
    const keys = candidateKeys(this.o.now(), after);
    const rawShards = await Promise.all(keys.map((k) => this.o.storage.get<LogEntry[]>(k)));
    const shards = rawShards.map((s) => (Array.isArray(s) ? s : []));
    const items = mergeShards(shards, keys.length * EVENT_RING_SIZE);
    return { items };
  }
}
