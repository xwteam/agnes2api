import { describe, it, expect } from "vitest";
import { StoreLogger, EVENT_INDEX_KEY, EVENT_SHARD_PREFIX } from "../../src/adapters/logger-store.js";
import { EVENT_FLUSH_MIN_INTERVAL_MS, EVENT_RING_SIZE } from "../../src/core/admin/event-ring.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import type { LogEntry } from "../../src/ports/logger.js";

/** 逐 put 调用记一份 key 日志，好断言「分片写了几次」「索引写了几次」这类精确次数。 */
class RecordingStorage implements Storage {
  putLog: string[] = [];
  constructor(private readonly inner: Storage = new MemoryStorage()) {}
  async get<T>(k: string): Promise<T | null> { return this.inner.get<T>(k); }
  async put<T>(k: string, v: T): Promise<void> { this.putLog.push(k); return this.inner.put(k, v); }
  async delete(k: string): Promise<void> { return this.inner.delete(k); }
  async list(p: string): Promise<string[]> { return this.inner.list(p); }
  putsTo(key: string): number { return this.putLog.filter((k) => k === key).length; }
}

describe("StoreLogger", () => {
  it("缓冲不落盘：log() 十次，storage.puts 恒为 0", () => {
    const st = new CountingStorage();
    const logger = new StoreLogger({ storage: st, now: () => 0, shardId: "s1", onError: () => {} });
    for (let i = 0; i < 10; i++) logger.log({ level: "info", event: `e${i}` });
    expect(st.puts).toBe(0);
    expect(logger.status().buffered).toBe(10);
  });

  it("到点落盘：推进假时钟过 EVENT_FLUSH_MIN_INTERVAL_MS，写了一次分片 + 一次索引", async () => {
    const st = new RecordingStorage();
    let t = 0;
    const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
    logger.log({ level: "info", event: "e1" });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();
    expect(st.putsTo(EVENT_SHARD_PREFIX + "s1")).toBe(1);
    expect(st.putsTo(EVENT_INDEX_KEY)).toBe(1);
  });

  it("最小间隔生效：连续两次 maybeFlush() 之间不推进时钟，只写了一次", async () => {
    const st = new RecordingStorage();
    let t = 0;
    const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
    logger.log({ level: "info", event: "e1" });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();
    logger.log({ level: "info", event: "e2" });
    // 不推进时钟：距上次 flush 的间隔仍是 0，未达最小间隔。
    await logger.maybeFlush();
    expect(st.putsTo(EVENT_SHARD_PREFIX + "s1")).toBe(1);
    // 未落盘的那条还在缓冲里，没有被静默丢弃。
    expect(logger.status().buffered).toBe(1);
  });

  /**
   * ⚠️ **递进假时钟，不是 `now: () => 0` 配 noSleep**——那是本项目登记的第 3 种
   * 假阳性（微任务饥饿式挂起）。这里 `t` 每次调用 `maybeFlush` 前都真的往前走。
   */
  it("每小时预算：13 次 maybeFlush()（每次推进 61 秒），分片写了 12 次，第 13 次不写且 budgetExhausted", async () => {
    const st = new RecordingStorage();
    let t = 0;
    const now = () => t;
    const logger = new StoreLogger({ storage: st, now, shardId: "s1", onError: () => {} });
    for (let i = 0; i < 13; i++) {
      t += 61_000;
      logger.log({ level: "info", event: `e${i}` });
      await logger.maybeFlush();
    }
    expect(st.putsTo(EVENT_SHARD_PREFIX + "s1")).toBe(12);
    expect(logger.status().budgetExhausted).toBe(true);
    // 第 13 次没写掉的那条还留在缓冲里，不是被吞掉了。
    expect(logger.status().buffered).toBe(1);
  });

  it("缓冲区上限：log() 150 次，buffered=100 且 dropped=50，落盘后首尾两条是第 51 与第 150 条", async () => {
    const st = new RecordingStorage();
    let t = 0;
    const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
    for (let i = 1; i <= 150; i++) logger.log({ level: "info", event: `e${i}` });
    expect(logger.status().buffered).toBe(EVENT_RING_SIZE);
    expect(logger.status().buffered).toBe(100);
    expect(logger.status().dropped).toBe(50);

    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();
    const shard = await st.get<LogEntry[]>(EVENT_SHARD_PREFIX + "s1");
    expect(shard?.length).toBe(100);
    expect(shard?.[0]?.event).toBe("e51");
    expect(shard?.[shard.length - 1]?.event).toBe("e150");
  });

  it("索引一生只写一次：连续三轮落盘，event:index 只被 put 过 1 次", async () => {
    const st = new RecordingStorage();
    let t = 0;
    const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
    for (let i = 0; i < 3; i++) {
      t += EVENT_FLUSH_MIN_INTERVAL_MS;
      logger.log({ level: "info", event: `round${i}` });
      await logger.maybeFlush();
    }
    expect(st.putsTo(EVENT_INDEX_KEY)).toBe(1);
    expect(st.putsTo(EVENT_SHARD_PREFIX + "s1")).toBe(3);
  });

  it("写失败不吞不重试同一批：onError 被调用，下一轮落盘写的是新攒的那批而不是重发旧批", async () => {
    const st = new CountingStorage();
    let t = 0;
    const errors: unknown[] = [];
    const logger = new StoreLogger({
      storage: st, now: () => t, shardId: "s1", onError: (e) => errors.push(e),
    });

    logger.log({ level: "info", event: "batch-one" });
    st.putFails = true;
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();
    expect(errors.length, "onError 应当被调用一次").toBe(1);
    // 失败之后缓冲已经清空（不是仍攒着 batch-one 等重试）。
    expect(logger.status().buffered).toBe(0);

    st.putFails = false;
    logger.log({ level: "info", event: "batch-two" });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();
    const shard = await st.inner.get<LogEntry[]>(EVENT_SHARD_PREFIX + "s1");
    expect(shard?.map((e) => e.event), "只应含新攒的那批，不含丢失的 batch-one").toEqual(["batch-two"]);
  });

  it("readEvents：零 list、按分片归并（供 events handler 复用，见契约测试的另一份验证）", async () => {
    const st = new MemoryStorage();
    let t = 0;
    const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
    logger.log({ level: "info", event: "e1" });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();

    const { items, shardCount } = await logger.readEvents();
    expect(shardCount).toBe(1);
    expect(items.map((e) => e.event)).toEqual(["e1"]);
  });

  it("status() 在没有任何事件时如实报空：buffered=0、dropped=0、budgetExhausted=false", () => {
    const logger = new StoreLogger({
      storage: new MemoryStorage(), now: () => 0, shardId: "s1", onError: () => {},
    });
    expect(logger.status()).toEqual({ shardId: "s1", buffered: 0, dropped: 0, budgetExhausted: false });
  });
});
