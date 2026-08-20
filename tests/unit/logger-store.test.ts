import { describe, it, expect } from "vitest";
import { StoreLogger } from "../../src/adapters/logger-store.js";
import { EVENT_FLUSH_MIN_INTERVAL_MS, EVENT_RING_SIZE, windowIndex, slotOf, shardKey, appendRing } from "../../src/core/admin/event-ring.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import type { LogEntry } from "../../src/ports/logger.js";

/** 逐 put 调用记一份 key 日志，好断言"分片写了几次"这类精确次数。 */
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

  /**
   * **评审 C1 的另一半：冷启动首刷必须受最小间隔节流。**
   * 原来 `lastFlushAt` 初值是 `null`，第一次 `maybeFlush()` 会跳过间隔检查直接写——
   * 等于每次 isolate 冷启动送一次零门槛写。现在 `lastFlushAt` 在构造时就取 `now()`，
   * 构造之后**不推进时钟**就立刻 `log()` + `maybeFlush()`，应当被同一套间隔规则拦住。
   */
  it("冷启动首刷受节流：构造之后不推进时钟就 log()+maybeFlush()，不写", async () => {
    const st = new CountingStorage();
    const logger = new StoreLogger({ storage: st, now: () => 1000, shardId: "s1", onError: () => {} });
    logger.log({ level: "warn", event: "cold.start" });
    await logger.maybeFlush();
    expect(st.puts, "冷启动首刷不该零门槛写入").toBe(0);
    expect(logger.status().buffered, "没写掉的事件还在缓冲里").toBe(1);
  });

  it("冷启动之后推进过最小间隔，首刷才会真的写", async () => {
    const st = new CountingStorage();
    let t = 1000;
    const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
    logger.log({ level: "warn", event: "cold.start" });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();
    expect(st.puts).toBe(1);
    expect(logger.status().buffered).toBe(0);
  });

  it("到点落盘：推进假时钟过 EVENT_FLUSH_MIN_INTERVAL_MS，写了一次分片", async () => {
    const st = new RecordingStorage();
    let t = 0;
    const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
    logger.log({ level: "info", event: "e1" });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();
    const key = shardKey(windowIndex(t), slotOf("s1"));
    expect(st.putsTo(key)).toBe(1);
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
    const key = shardKey(windowIndex(t), slotOf("s1"));
    expect(st.putsTo(key)).toBe(1);
    // 未落盘的那条还在缓冲里，没有被静默丢弃。
    expect(logger.status().buffered).toBe(1);
  });

  /**
   * ⚠️ **递进假时钟，不是 `now: () => 0` 配 noSleep**——那是本项目登记的第 3 种
   * 假阳性（微任务饥饿式挂起）。这里 `t` 每次调用 `maybeFlush` 前都真的往前走。
   */
  it("每天预算：13 次 maybeFlush()（每次推进 61 秒），分片写了 12 次，第 13 次不写且 budgetExhausted", async () => {
    const st = new RecordingStorage();
    let t = 1000;
    const now = () => t;
    const logger = new StoreLogger({ storage: st, now, shardId: "s1", onError: () => {} });
    for (let i = 0; i < 13; i++) {
      t += 61_000;
      logger.log({ level: "info", event: `e${i}` });
      await logger.maybeFlush();
    }
    // 每次推进 61 秒偶尔会跨过窗口（EVENT_WINDOW_MS=1 小时），落进不同的分片键，
    // 但**写预算是每个 isolate 一份、与落进哪个分片键无关**——put 总数就是预算次数。
    expect(st.putLog.length).toBe(12);
    expect(logger.status().budgetExhausted).toBe(true);
    // 第 13 次没写掉的那条还留在缓冲里，不是被吞掉了。
    expect(logger.status().buffered).toBe(1);
  });

  it("缓冲区上限：log() 150 次，buffered=100 且 dropped=50", () => {
    const logger = new StoreLogger({
      storage: new MemoryStorage(), now: () => 1000, shardId: "s1", onError: () => {},
    });
    for (let i = 1; i <= 150; i++) logger.log({ level: "info", event: `e${i}` });
    expect(logger.status().buffered).toBe(EVENT_RING_SIZE);
    expect(logger.status().buffered).toBe(100);
    expect(logger.status().dropped).toBe(50);
  });

  it("缓冲区上限落盘后，分片里首尾两条是第 51 与第 150 条", async () => {
    let t = 1000;
    const logger = new StoreLogger({
      storage: new MemoryStorage(), now: () => t, shardId: "s1", onError: () => {},
    });
    for (let i = 1; i <= 150; i++) logger.log({ level: "info", event: `e${i}` });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();
    const { items } = await logger.readEvents(null);
    expect(items.length).toBe(100);
    // 全部 150 条都是同一个固定时钟 ts，mergeShards 在同 ts 时按写入序号稳定破平，
    // 因此顺序等同于分片数组本身的顺序：appendRing 保留的是最后写入的 100 条
    // （e51..e150），数组里 e51 排在前面（先写入）、e150 排在后面（后写入）。
    expect(items[0]!.event).toBe("e51");
    expect(items[items.length - 1]!.event).toBe("e150");
  });

  /**
   * **评审 I1**：`appendRing` 会在分片攒满之后静默截掉最旧的几条，这类"落盘侧"
   * 丢弃原来完全不计数——`dropped` 只在内存缓冲溢出时 `++`。这里让分片已经攒了
   * 80 条，再落盘 40 条新的（总共 120 条，超限 20 条），断言 `dropped` 精确反映这
   * 20 条落盘侧丢弃，而不是仍然是 0。
   */
  it("分片落盘时环形截断也计入 dropped（不只是内存缓冲溢出才计数）", async () => {
    let t = 1000;
    const storage = new MemoryStorage();
    const key = shardKey(windowIndex(t + 3 * EVENT_FLUSH_MIN_INTERVAL_MS), slotOf("s1"));
    const preExisting: LogEntry[] = Array.from({ length: 80 }, (_, i) => ({ ts: i, level: "info", event: `pre${i}` }));
    await storage.put(key, preExisting);

    const logger = new StoreLogger({ storage, now: () => t, shardId: "s1", onError: () => {} });
    t += 3 * EVENT_FLUSH_MIN_INTERVAL_MS; // 让落盘的窗口与预置数据同一个窗口
    for (let i = 0; i < 40; i++) logger.log({ level: "info", event: `new${i}` });
    await logger.maybeFlush();

    expect(logger.status().dropped, "80+40=120 条，超限 20 条").toBe(20);
    expect(logger.status().buffered).toBe(0);
  });

  it("写失败不吞不重试同一批：onError 被调用，下一轮落盘写的是新攒的那批而不是重发旧批", async () => {
    const st = new CountingStorage();
    let t = 1000;
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
    const { items } = await logger.readEvents(null);
    expect(items.map((e) => e.event), "只应含新攒的那批，不含丢失的 batch-one").toEqual(["batch-two"]);
  });

  it("readEvents：零 list、按候选键归并（供 events handler 复用，见契约测试的另一份验证）", async () => {
    const st = new MemoryStorage();
    let t = 1000;
    const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
    logger.log({ level: "info", event: "e1" });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();

    const { items } = await logger.readEvents(null);
    expect(items.map((e) => e.event)).toEqual(["e1"]);
  });

  /**
   * **架构裁定 ①的代价，明写成用例（不是只留在注释/报告里）。**
   *
   * 去掉索引之后，两个 isolate 落在同一个"时间窗 + 槽位"组合时会互相覆盖对方那
   * 一批——这是裁定 ① 主动接受的代价，换来的是 C2（索引无上限增长）与 C3（索引
   * 读改写丢更新）被根除。这条用例证明代价确实是"丢一次交错，下一轮各自继续写"
   * （最后写的赢，覆盖是干净的一次性事件，不是永久不可达），而不是 C3 原来那种
   * "数据写进去了但索引再也看不见它、且标记为已处理导致永不重试"的更坏局面。
   */
  /**
   * **注**：`StoreLogger.maybeFlush()` 内部是 `get(cur) → appendRing(cur, batch) →
   * put()`（读改写），**顺序执行的两次 flush 不会丢数据**（第二次的 `get()` 会读到
   * 第一次已经写下的内容，`appendRing` 把两批都保留）——已实测：先让 loggerA 完整
   * flush 完（`await` 到底）、loggerB 再 flush，`readEvents()` 里两条事件都在。
   * 真正会丢数据的是**两次 flush 的 `get()` 都发生在对方的 `put()` 之前**这种
   * 真并发场景，下面直接用 `event-ring.ts` 的原语复现这个时序，不依赖对
   * `StoreLogger`/JS 微任务调度顺序的假设。
   */
  it("架构裁定①的代价：同一时间窗+槽位下真并发落盘会互相覆盖（最后写的赢，不是永久不可达）", async () => {
    const shared = new MemoryStorage();
    const key = shardKey(windowIndex(1000), 0);

    // 模拟真并发：两次 flush 的 get() 都发生在任一次 put() 之前——都读到"空"。
    const curForA = (await shared.get<LogEntry[]>(key)) ?? [];
    const curForB = (await shared.get<LogEntry[]>(key)) ?? [];
    // A 先 put（基于它读到的空快照）。
    await shared.put(key, appendRing(curForA, [{ ts: 1000, level: "info", event: "from-a" }], 100));
    // B 后 put，但它是基于**更早读到的同一份空快照**算出来的——覆盖掉 A 刚写的内容，
    // 不是"读改写"意义上的合并（B 的快照里根本没有 A 的那一条）。
    await shared.put(key, appendRing(curForB, [{ ts: 1001, level: "info", event: "from-b" }], 100));

    // **代价的精确内容**：B 覆盖了 A（最后写的赢），不是"两份数据都在"（那需要
    // get() 发生在对方 put() 之后，属于 C3 已经根除的读改写窗口），也不是
    // "A 的数据从此不可达但没人知道"（B 的写本身成功了，是一次干净的覆盖，
    // 不是像原来 C3 那样"数据写进去了、索引却漏标、永久不可达"）。
    const cur = (await shared.get<LogEntry[]>(key)) ?? [];
    expect(cur.map((e) => e.event)).toEqual(["from-b"]);

    // 反向印证：先后顺序执行（不是真并发）时不丢数据——两次 flush 之间没有 get()
    // 抢跑的窗口，appendRing 老老实实把两批都保留。区分"顺序执行"与"真并发"
    // 正是这条代价"看起来吓人、实际有界"的关键：只有真并发窗口内才会丢。
    // 换一个槽位（不是换窗口——EVENT_WINDOW_MS 很大，1000 与 2000 仍是同一个窗口，
    // 用同一个 key 会被上面那段的 "from-b" 污染），确保这段用的是一把干净的 key。
    const key2 = shardKey(windowIndex(1000), 1);
    const c1 = (await shared.get<LogEntry[]>(key2)) ?? [];
    await shared.put(key2, appendRing(c1, [{ ts: 2000, level: "info", event: "seq-a" }], 100));
    const c2 = (await shared.get<LogEntry[]>(key2)) ?? []; // 这次的 get() 在上面的 put() 之后，读到了 seq-a
    await shared.put(key2, appendRing(c2, [{ ts: 2001, level: "info", event: "seq-b" }], 100));
    const seqResult = (await shared.get<LogEntry[]>(key2)) ?? [];
    expect(seqResult.map((e) => e.event), "顺序执行（get() 不抢跑）时两批都保留，不丢数据").toEqual(["seq-a", "seq-b"]);
  });

  it("status() 在没有任何事件时如实报空：buffered=0、dropped=0、budgetExhausted=false", () => {
    const logger = new StoreLogger({
      storage: new MemoryStorage(), now: () => 0, shardId: "s1", onError: () => {},
    });
    expect(logger.status()).toEqual({ shardId: "s1", buffered: 0, dropped: 0, budgetExhausted: false });
  });

  it("status() 带着 shardId（评审 M2：面板据此说清『本 isolate』说的是哪一个）", () => {
    const logger = new StoreLogger({
      storage: new MemoryStorage(), now: () => 0, shardId: "distinctive-shard-id", onError: () => {},
    });
    expect(logger.status().shardId).toBe("distinctive-shard-id");
  });
});
