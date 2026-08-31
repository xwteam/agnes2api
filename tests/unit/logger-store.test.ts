import { describe, it, expect } from "vitest";
import { StoreLogger } from "../../src/adapters/logger-store.js";
import {
  EVENT_FLUSH_MIN_INTERVAL_MS, EVENT_RING_SIZE,
  windowIndex, slotOf, shardKey, appendRing,
} from "../../src/core/admin/event-ring.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import type { LogEntry } from "../../src/ports/logger.js";

/** 逐 put 调用记一份 key 日志（+ 每个 key 最后一次收到的 expiresAt），
 * 好断言"分片写了几次""带的过期时刻是多少"这类精确次数/值。 */
class RecordingStorage implements Storage {
  putLog: string[] = [];
  private readonly expiryLog = new Map<string, number | undefined>();
  constructor(private readonly inner: Storage = new MemoryStorage()) {}
  async get<T>(k: string): Promise<T | null> { return this.inner.get<T>(k); }
  async put<T>(k: string, v: T, expiresAt?: number): Promise<void> {
    this.putLog.push(k);
    this.expiryLog.set(k, expiresAt);
    return this.inner.put(k, v, expiresAt);
  }
  async delete(k: string): Promise<void> { return this.inner.delete(k); }
  async list(p: string): Promise<string[]> { return this.inner.list(p); }
  putsTo(key: string): number { return this.putLog.filter((k) => k === key).length; }
  expiryOf(key: string): number | undefined { return this.expiryLog.get(key); }
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
   * **评审那条「写预算全局失守」的另一半：冷启动首刷必须受最小间隔节流。**
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
    // storage 与 now 必须共用同一个假时钟（评审发现，理由见 tests/helpers/make-app.ts
    // 的同一条说明：不对齐会让刚落盘的事件相对 MemoryStorage 默认的真实 Date.now()
    // "生下来就已经过期"，下面的 readEvents(null) 会读到空）。
    const logger = new StoreLogger({
      storage: new MemoryStorage(undefined, () => t), now: () => t, shardId: "s1", onError: () => {},
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
   * **评审发现**：`appendRing` 会在分片攒满之后静默截掉最旧的几条，这类"落盘侧"
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
    let t = 1000;
    // 见上一条用例的同一条说明：storage 与 now 必须共用同一个假时钟。
    const st = new CountingStorage(new MemoryStorage(undefined, () => t));
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
    let t = 1000;
    const st = new MemoryStorage(undefined, () => t); // 同一条说明，见上面几条用例
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
   * 一批——这是裁定 ① 主动接受的代价，换来的是「索引无上限增长」与「索引
   * 读改写丢更新）被根除。这条用例证明代价确实是"丢一次交错，下一轮各自继续写"
   * （最后写的赢，覆盖是干净的一次性事件，不是永久不可达），而不是「索引读改写丢更新」原来那种
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
    // get() 发生在对方 put() 之后，属于已经根除的读改写窗口），也不是
    // "A 的数据从此不可达但没人知道"（B 的写本身成功了，是一次干净的覆盖，
    // 不是像原来那样"数据写进去了、索引却漏标、永久不可达"）。
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

  /**
   * **评审发现（第二次修复）**：第一版对策是每次成功落盘顺手 delete 一个按固定
   * 偏移算出来的旧窗口键，被下一轮评审逐场景实测推翻——稀疏落盘（gap 超过保留
   * 期）或多 isolate 各写各的随机分片时，那个"按偏移算出来"的键很可能压根不是
   * "真正该清掉的那个"，清理率能跌到 0。现在改用 `Storage.put()` 的 `expiresAt`
   * 参数（`eventExpiresAt()`），有界性变成存储自己的性质，`StoreLogger` 只负责
   * "算对过期时刻、原样传下去"，不再自己动手删任何东西。
   *
   * **评审 T1（同一条教训的推广）**：这里不用 `shardId = "s1"`——`slotOf("s1")`
   * 恰好是 `0`，如果 `this.slot` 的计算被破坏成硬编码 `0`，用 `slotOf(shardId)`
   * 反推出来的期望键会与被破坏的 SUT"巧合地"指向同一个键，变异因此不可观测
   * （复评已实测过一次）。改用 `shardId = "s2"`（`slotOf("s2") === 1`，用
   * `node -e` 手算/实测过）+ **手写字面量** `"event:0:1"`/`"event:25:1"`，
   * 不在断言里调用 `slotOf()`/`shardKey()`/`eventExpiresAt()` 反推期望值。
   */
  it("maybeFlush() 传给 storage.put() 的过期时刻精确等于手算的字面量（评审发现）", async () => {
    const st = new RecordingStorage();
    const shardId = "s2"; // slotOf("s2") === 1，手算/实测过，不是巧合的 0
    let t = 1000; // windowIndex(1000) = 0
    const logger = new StoreLogger({ storage: st, now: () => t, shardId, onError: () => {} });

    logger.log({ level: "info", event: "e1" });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();

    // 手算：windowIndex(1000)=0；(0 + 24) * 3_600_000 + 3_600_000 = 90_000_000
    // （EVENT_WINDOW_RETAIN=24、EVENT_WINDOW_MS=3_600_000、EVENT_TTL_MARGIN_MS
    // = EVENT_WINDOW_MS，三个都是本文件之外独立核验过的字面量，这里不再 import
    // 常量反算，直接手写最终结果，避免"期望值从被测代码自己推导"）。
    expect(st.expiryOf("event:0:1")).toBe(90_000_000);
  });

  it("过期之后旧键真的读不到了，新键不受影响——有界性是存储自己的性质（评审发现）", async () => {
    let t = 1000; // windowIndex(1000) = 0
    // storage 与 now 必须共用同一个假时钟——这条用例本身就是在测"时间流逝之后
    // 过期"，如果 MemoryStorage 走自己默认的真实 Date.now()，`t` 推进到
    // 90_000_001（约 1970 年 1 月 2 日附近）永远追不上真实的现在，这个断言会
    // 从"验证 TTL 生效"退化成"验证真实时钟已经过了 1970 年"这种恒真命题。
    const st = new MemoryStorage(undefined, () => t);
    const shardId = "s2"; // 见上条说明：slotOf("s2") === 1，不是巧合的 0
    const logger = new StoreLogger({ storage: st, now: () => t, shardId, onError: () => {} });

    logger.log({ level: "info", event: "old-event" });
    t += EVENT_FLUSH_MIN_INTERVAL_MS;
    await logger.maybeFlush();
    const oldKey = "event:0:1"; // 手写字面量，理由同上一条用例
    expect(await st.get(oldKey), "前置条件：第一次落盘确实写进去了").not.toBeNull();

    // 推进到明确超过手算的过期时刻（90_000_000ms，见上一条用例）之后。
    t = 90_000_001;
    logger.log({ level: "info", event: "new-event" });
    await logger.maybeFlush(); // 距上次落盘远超过最小间隔，正常触发

    expect(await st.get(oldKey), "过期之后旧键应该读不到了").toBeNull();
    // windowIndex(90_000_001) = 25（90_000_000 / 3_600_000 = 25 整），手写字面量。
    const newKey = "event:25:1";
    expect((await st.get<LogEntry[]>(newKey))?.map((e) => e.event)).toEqual(["new-event"]);
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

  /**
   * **写侧逐条窄化。分片值的五种形态穷举，实测结果逐条记在用例名里。**
   *
   * 触发条件如实写：`src/` 里没有产出这些值的代码路径；已知的现实来源是**存储外部**
   *（运维手改 KV / `store.json`、KV 值损坏、Node 侧进程被杀时 `store.json` 写到一半）。
   * **这不是"不可达"，是"不经我们的代码可达"。**
   */
  describe("写侧：存储里的分片值畸形时（narrowShard 之前的两条真实缺陷）", () => {
    /** 让 `logger` 在同一个窗口里对着预置值落一次盘，返回落回去的东西。 */
    async function flushOnto(seed: unknown) {
      let t = 1000;
      const st = new MemoryStorage(undefined, () => t);
      const key = shardKey(windowIndex(t + EVENT_FLUSH_MIN_INTERVAL_MS), slotOf("s1"));
      await st.put(key, seed);
      const errs: unknown[] = [];
      const logger = new StoreLogger({
        storage: st, now: () => t, shardId: "s1", onError: (e) => errs.push(e),
      });
      logger.log({ level: "info", event: "e1" });
      t += EVENT_FLUSH_MIN_INTERVAL_MS;
      await logger.maybeFlush();
      return { stored: await st.get<unknown[]>(key), errs, logger };
    }

    /**
     * **上游：字符串被 `[...cur]` 逐字符展开。**
     * 修复前实测：`stored=["a","b","c",{…}] | errs=0 | dropped=0` ——**不抛、不报、
     * 不留痕**，而 `"a".ts` 是 `undefined`，**正是让读侧游标冻住的那一种条目**。
     * 一个标量进来，出去的是三份 Critical 的燃料。
     * 变红条件（M2 的一半）：写侧 `narrowShard` 退回 `?? []`。
     */
    it("分片值是字符串：落回存储的数组里不许出现非对象元素", async () => {
      const { stored, errs } = await flushOnto("abc");
      expect(Array.isArray(stored)).toBe(true);
      for (const e of stored!) {
        expect(typeof e, "字符串被逐字符展开成单字符条目了").toBe("object");
        expect(e).not.toBeNull();
      }
      expect(stored!.length, "只该有这一轮 log 的那一条").toBe(1);
      expect(errs.length, "这条路径本来就不抛错，不许靠 onError 兜").toBe(0);
    });

    /**
     * **下游：非字符串标量与对象让 `[...cur]` 抛 `TypeError`。**
     * 修复前实测：`errs=1`、这一批事件**永久丢失**（`this.buffer = []` 在 `try`
     * 之前），且 `truncatedCount(cur.length, …)` 在抛错前跑、`cur.length` 是
     * `undefined` ⇒ **`persistedDropped` 变成 `NaN` 并对这个 isolate 终生粘住**
     * ⇒ `NaN > 0` 是 `false` ⇒ 面板黄条永远不亮；`c.json` 又把 `NaN` 序列化成
     * `null` ⇒ 面板读到"没有数据"。
     * **⇒ 事件缺口是一小时的（键每小时换一把），而"面板说不出自己缺了东西"是终生的。**
     * 变红条件（M2 的另一半）：写侧 `narrowShard` 退回 `?? []`。
     */
    it.each([["数字", 12345], ["对象", { a: 1 }], ["布尔", true]] as const)(
      "分片值是%s：这一批事件照样落得进去，且 status().dropped 恒为有限数（不是 NaN）",
      async (_why, seed) => {
        const { stored, errs, logger } = await flushOnto(seed);
        expect(errs.length, "不该再抛 TypeError").toBe(0);
        expect(stored, "缓冲先清空、异常才发生 ⇒ 这一批被静默吞掉了")
          .toEqual([{ ts: 1000, level: "info", event: "e1" }]);
        const dropped = logger.status().dropped;
        expect(Number.isFinite(dropped), `dropped 是 ${String(dropped)}，报警器被毒死了`).toBe(true);
        expect(dropped).toBe(0);
        // NaN 那条链的终点：面板判据 `dropped > 0` 与 JSON 序列化。
        expect(JSON.parse(JSON.stringify({ dropped })).dropped, "NaN 会被序列化成 null").toBe(0);
      },
    );

    /**
     * **`undefined` / `null` 不在抛错集合里**，它们是完全正常的路径
     *（原来那行 `(await get()) ?? []` 就把两者都接住了，实测 `errs=0`）。
     * ⚠️ 这一格是对**计划自己那条订正**的复核：起草方最初写「`undefined` 会抛」，
     * 结论来自**直接调 `appendRing(undefined)`——绕过了 `?? []`**（第 7 种假阳性，
     * 测的是抄件不是原件）。本格打的是真入口。
     */
    it("分片值是 null / 键根本不存在：正常路径，不抛错也不计 dropped", async () => {
      for (const seed of [null, undefined]) {
        const { stored, errs, logger } = await flushOnto(seed);
        expect(errs.length, String(seed)).toBe(0);
        expect(stored).toEqual([{ ts: 1000, level: "info", event: "e1" }]);
        expect(logger.status().dropped).toBe(0);
      }
    });

    it("分片数组里混进坏条目：坏的被丢掉，好的原样留在存储里", async () => {
      const { stored } = await flushOnto([null, "x", { ts: 1, level: "info", event: "old" }]);
      expect(stored).toEqual([
        { ts: 1, level: "info", event: "old" },
        { ts: 1000, level: "info", event: "e1" },
      ]);
    });
  });

  describe("读侧：畸形条目被逐条丢掉，并且丢了几条要能被数出来", () => {
    it("readEvents 交出 malformed 计数，且畸形条目不进 items", async () => {
      const t = 1000;
      const st = new MemoryStorage(undefined, () => t);
      await st.put(shardKey(windowIndex(t), 0), [null, "x", { ts: 5, level: "info", event: "good" }]);
      const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
      const { items, malformed } = await logger.readEvents(null);
      expect(items.map((e) => e.event)).toEqual(["good"]);
      expect(malformed).toBe(2);
    });

    /**
     * **`malformed` 随每次读返回，不是实例字段。** 这条与上面 `persistedDropped`
     * 那条 `NaN` 教训是同一件事的两面：实例字段会跨请求粘住，两个并发请求各读一次
     * 之后，谁的 handler 先读到那个字段就说了算。
     */
    it("上一次读到的 malformed 不会粘到下一次读上", async () => {
      const t = 1000;
      const st = new MemoryStorage(undefined, () => t);
      await st.put(shardKey(windowIndex(t), 0), [null, { ts: 5, level: "info", event: "good" }]);
      const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
      expect((await logger.readEvents(null)).malformed).toBe(1);
      await st.put(shardKey(windowIndex(t), 0), [{ ts: 5, level: "info", event: "good" }]);
      expect((await logger.readEvents(null)).malformed, "上一次的 1 粘住了").toBe(0);
    });
  });

  /**
   * **`flush()` 与 `maybeFlush()` 的区别，单独钉一次。**
   *
   * 这不是一个可有可无的便利方法：Cron 触发的 `scheduled()` 每次很可能是一个**全新
   * isolate**，构造那一刻 `lastFlushAt = now()`，而跑得快的那一轮（`need <= 0` 的
   * 健康稳态、`provider_missing`、`registrar.round_budget_impossible` 都是毫秒级
   * 返回）收尾时 `since` 远小于最小间隔 ⇒ `maybeFlush()` **一条都不写，而且
   * `errs=0`、`dropped=0`、不抛不报**。本任务实测：24 个模拟窗口 × 48 次 Cron，
   * `registrar.*` 写入 432 条、可见 **0** 条，丢失率 **100%**。
   */
  describe("flush()：绕过最小间隔闸，给「调用频率本身已有上界」的调用方用", () => {
    it("构造之后不推进时钟：maybeFlush() 一条不写，flush() 照写", async () => {
      const stA = new CountingStorage();
      const a = new StoreLogger({ storage: stA, now: () => 1000, shardId: "s1", onError: () => {} });
      a.log({ level: "warn", event: "registrar.x" });
      await a.maybeFlush();
      expect(stA.puts, "前置条件：最小间隔闸确实拦住了 maybeFlush()").toBe(0);

      const stB = new CountingStorage();
      const b = new StoreLogger({ storage: stB, now: () => 1000, shardId: "s1", onError: () => {} });
      b.log({ level: "warn", event: "registrar.x" });
      await b.flush();
      expect(stB.puts, "flush() 必须绕过那道闸").toBe(1);
      expect(b.status().buffered).toBe(0);
    });

    it("flush() 仍然受每天写预算约束（绕过的只是间隔闸，不是预算）", async () => {
      const st = new CountingStorage();
      let t = 1000;
      const logger = new StoreLogger({ storage: st, now: () => t, shardId: "s1", onError: () => {} });
      for (let i = 0; i < 13; i++) {
        t += 1; // 刻意**不**推进过最小间隔：验的就是 flush() 不看它
        logger.log({ level: "info", event: `e${i}` });
        await logger.flush();
      }
      expect(st.puts, "预算是 12/天，第 13 次不该写").toBe(12);
      expect(logger.status().budgetExhausted).toBe(true);
    });

    it("缓冲是空的时候 flush() 不写 —— 健康的那一轮产出 0 条事件，就该是 0 次 put", async () => {
      const st = new CountingStorage();
      const logger = new StoreLogger({ storage: st, now: () => 1000, shardId: "s1", onError: () => {} });
      await logger.flush();
      expect(st.puts, "空缓冲还去写一次，配额账里「健康时为 0」那一栏就是假的").toBe(0);
    });
  });
});
