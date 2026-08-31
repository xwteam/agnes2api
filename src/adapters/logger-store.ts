import type { Logger, LogEntry } from "../ports/logger.js";
import type { Storage } from "../ports/storage.js";
import {
  EVENT_RING_SIZE, EVENT_FLUSH_MIN_INTERVAL_MS, EVENT_WRITES_PER_DAY,
  appendRing, truncatedCount, mergeShards, candidateKeys, windowIndex, slotOf, shardKey, eventExpiresAt,
  FRESH_BUDGET, canWrite, consume, type WriteBudget,
} from "../core/admin/event-ring.js";
import { narrowShard, type EventEntry } from "../core/admin/event-entry.js";

/** `readEvents()` 的返回形状：归并结果，供 events handler 过滤/截断/序列化。 */
export interface ReadEventsResult {
  items: EventEntry[];
  /**
   * 这一次读里，**分片是数组但里面不是对象/没有可用 `ts`** 的条目有几条。
   *
   * **随每次读返回，不做成实例字段**——这是刻意的，与下面 `persistedDropped` 那条
   * `NaN` 教训是同一件事的两面：实例字段会跨请求粘住，两个并发请求各读一次之后，
   * 谁的 handler 先读到那个字段就说了算，面板会看到另一个请求的数。
   */
  malformed: number;
}

/**
 * 事件落库 sink。
 *
 * ⚠️ **存储形态是评审 3 条 Critical 之后的重写版**：不再有 `event:index`。
 * `event:<窗口>:<槽位>`（`src/core/admin/event-ring.ts` 的 `shardKey`/`candidateKeys`）
 * 是一个键空间——**面板读路径 = K 次 get（K 是 `candidateKeys()` 算出来的候选键数，
 * 对任何 `after` 都有硬上界，见 `candidateKeys()` 的钳位），零 `list()`、零索引读改写**。
 *
 * ⚠️ **存储侧的有界性走 TTL，不是 `delete()`**（有界性那条的第二次修复）：第一版对策
 * 是每次成功落盘顺手 delete 一个按固定偏移算出来的旧窗口键，被下一轮评审逐场景
 * 实测推翻——那个方案的有界性绑在"落盘节奏恰好规律"这个前提上，稀疏落盘（gap
 * 超过保留期）或生产 Workers 下随机 `shardId` 各写各的槽位时，前提不成立，清理率
 * 能跌到 0（详见 `src/core/admin/event-ring.ts` 文件头与 `shardKey()` 的说明）。
 * 现在改用 `Storage.put()` 的 `expiresAt` 参数（`eventExpiresAt()` 算出来的绝对
 * 过期时刻）：有界性变成存储自己的性质，与这里的落盘节奏、槽位选择、isolate 是否
 * 被回收全部无关——KV 侧零操作开销（原生 `expiration`，不占任何配额桶），
 * FileStorage 侧**读时跳过、写时顺手清掉**（评审订正：这里原来写的"读/写时
 * 惰性清理"不准确——`get`/`list` 只是逻辑上把过期键当不存在，从不物理删除；
 * 真正的物理清理只发生在 `put`/`delete` 里，措辞已与 `src/ports/storage.ts` 的
 * 端口文档对齐，见该适配器）。
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
  /** 落盘时分片环形截断丢的条数（`maybeFlush()` 那一侧，见 `status()`）。 */
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
    // **评审那条「写预算全局失守」的另一半：冷启动首刷必须受最小间隔节流。**
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

  /** 面板要看的自述状态。`dropped` 是缓冲侧与落盘侧两类丢弃的**总数**（评审发现）。 */
  status(): { shardId: string; buffered: number; dropped: number; budgetExhausted: boolean } {
    return {
      shardId: this.o.shardId, buffered: this.buffer.length,
      dropped: this.bufferDropped + this.persistedDropped,
      budgetExhausted: !canWrite(this.budget, this.o.now()),
    };
  }

  /**
   * 到点就落盘。**由中间件在请求收尾 await**（`src/http/log-flush.ts`），不是定时器——
   * 定时器是 IO 能力，Worker 上也没有常驻进程可挂。
   *
   * **`fetch` 路径只许走这一条，不许改成下面的 `flush()`**：这条最小间隔闸是
   * §8.5 点名的那根杠杆的唯一约束——白名单里的 `admin.login_failed` 是**任何
   * 未鉴权请求都能触发**的，去掉闸门就等于让攻击者按批驱动 KV 写。
   * 「两个挨得很近的请求只落盘一次」由 `tests/contract/admin-events.test.ts`
   * 的「fetch 路径仍然受最小间隔节流」直接钉住。
   */
  async maybeFlush(): Promise<void> {
    const at = this.o.now();
    if (this.buffer.length === 0) return;
    const since = at - this.lastFlushAt;
    // `since < 0` = 时钟回拨：立刻恢复，与本仓其余三处同一套语义。
    if (since >= 0 && since < EVENT_FLUSH_MIN_INTERVAL_MS) return;
    await this.writeBatch(at);
  }

  /**
   * **无条件落盘，绕过最小间隔闸。**
   *
   * ⚠️ **它名义上仍然受每天写预算约束，但在今天唯一的两个调用点上那条约束
   * 从不生效**（评审 m1）：两个入口**每一轮都新建一个 sink 实例**，实例一诞生
   * 就带着一份全新的 `FRESH_BUDGET` ⇒ `canWrite` 恒为真。实测 60 轮全部写出。
   * 所以**别把「还有预算兜着」当成这条路径的护栏**——它没有护栏，
   * 上界只有一个：**调用方自己的频率**（见下）。预算那行判断留着是因为
   * 它对未来可能出现的长寿调用方仍然有意义，不是因为它现在拦得住什么。
   *
   * ⚠️ **只给「调用频率本身已经有上界」的调用方用**，今天只有一处：两个入口的
   * 补池收尾（`src/entry/worker.ts` / `src/entry/node.ts`）。
   *
   * **为什么非有它不可**（本任务实测，Step 6b 的量测顺带打出来的）：Cron 触发的
   * `scheduled()` 每次**很可能是一个全新 isolate**，它构造 `StoreLogger` 的那一刻
   * `lastFlushAt = now()`，紧接着这一轮补池如果跑得快（`need <= 0` 的健康稳态、
   * `provider_missing` 接线错误、`registrar.round_budget_impossible` 这三种都是
   * **毫秒级返回**），收尾 `maybeFlush()` 时 `since` 远小于
   * `EVENT_FLUSH_MIN_INTERVAL_MS` ⇒ **一条都写不出去，而且 `errs=0`、`dropped=0`、
   * 不抛不报**。实测：24 个模拟窗口 × 48 次 Cron，`registrar.*` 写入 432 条、
   * 可见 **0** 条，丢失率 **100%**；把落盘时刻推到构造时刻之后 60 秒，丢失率降到 0%。
   * 换句话说，不给这条路径一个绕过闸门的出口，「`registrar.*` 事件落库」这件事
   * 在最常见的形态下等于什么都没做。
   *
   * **它的上界不在这里，在调用方**：补池频率（Worker 的 Cron / Node 的
   * `TEND_INTERVAL_MS`）。**不许说「与事件 sink 同一套预算所以同样安全」**——
   * `EVENT_WRITES_PER_DAY` 是每实例的，而这条路径上每一轮都可能是一个新实例，
   * 那套预算在这根轴上既拦不住什么也不构成上界（订正）。
   */
  async flush(): Promise<void> {
    await this.writeBatch(this.o.now());
  }

  private async writeBatch(at: number): Promise<void> {
    if (this.buffer.length === 0) return;
    if (!canWrite(this.budget, at, EVENT_WRITES_PER_DAY)) return;

    const batch = this.buffer;
    this.buffer = [];
    // 窗口与预算**在发起写之前**就推进：写失败时不重试同一批（下一轮再攒），
    // 否则存储持续故障会让每个请求都白付一次 put。
    this.lastFlushAt = at;
    this.budget = consume(this.budget, at);
    try {
      const key = shardKey(windowIndex(at), this.slot);
      // **写侧也要逐条窄化**，这里今天连 `Array.isArray` 都没有（读侧至少有）。
      // 两条真实后果，都由本任务实测：
      // ① `cur` 是**字符串**时 `appendRing` 的 `[...cur]` 把它**逐字符展开**，
      //    `"abc"` 变成三条单字符条目原样写回存储 —— `errs=0`、`dropped=0`、
      //    **不抛不报不留痕**；而 `"a".ts` 是 `undefined`，**正是让读侧游标冻住
      //    的那一种条目**。一个标量进来，出去的是三份燃料：上游与下游不是并列的
      //    两个缺陷，是同一条链。
      // ② `cur` 是**字符串以外的标量或对象**时 `[...cur]` 抛 `TypeError`，而上面
      //    `this.buffer = []` 已经先执行过 —— **缓冲区先清空、异常才发生 ⇒ 这一批
      //    永久丢失**；更糟的是下面那行 `truncatedCount(cur.length, …)` 在抛错之前
      //    跑，`cur.length` 是 `undefined` ⇒ `persistedDropped` 变成 **`NaN` 并对
      //    这个 isolate 终生粘住** ⇒ `NaN > 0` 是 `false` ⇒ 面板黄条永远不亮，
      //    `c.json` 又把 `NaN` 序列化成 `null` ⇒ 面板读到"没有数据"。
      // **精度**：`undefined` / `null` **不在抛错集合里**（原来的 `?? []` 把两者
      // 都接住了，实测 `errs=0`）；事件缺口限定在**当前时间窗内**（键每小时换一把，
      // 实测窗口一翻就恢复落盘），而 `NaN` 是实例字段、**终生粘住**。
      // ⇒ **事件缺口是一小时的，「面板说不出自己缺了东西」是终生的。**
      const cur = narrowShard(await this.o.storage.get(key)).entries;
      this.persistedDropped += truncatedCount(cur.length, batch.length, EVENT_RING_SIZE);
      // **评审（有界性那条的第二次修复）**：第三个参数是这把键的过期时刻——存储实现自己
      // 保证过期之后 get/list 都不再能看到它，有界性不再依赖"下一次成功的 flush
      // 恰好落在正确的偏移上"这件事（见文件头与 `eventExpiresAt()` 的说明）。
      await this.o.storage.put(
        key,
        appendRing<EventEntry>(cur, batch, EVENT_RING_SIZE),
        eventExpiresAt(at),
      );
    } catch (err) {
      this.o.onError(err);
    }
  }

  /**
   * 面板读路径。**候选键由 `candidateKeys()` 从时钟直接算出来，零 `list()`、零索引读**
   * ——这是这一层的第一条硬要求，也是「索引无上限增长 / 索引读改写丢更新」的根治方式（详见
   * `src/core/admin/event-ring.ts` 文件头）。
   *
   * `after`：`null` 时是"冷读"（回看 `EVENT_WINDOW_RETAIN` 个窗口），有值时是"暖读"
   * （只看 `after` 所在窗口到当前窗口，通常 1~2 个）——见 `candidateKeys` 的说明。
   *
   * **不做任何过滤/截断，只做归并**：`after` 的过滤、`level` 的过滤、`limit` 的截断
   * 由 `src/http/admin/handlers/events.ts` 在归并结果之上处理——"归并 → 过滤 → 截到
   * limit"的顺序不能倒过来，否则先截断再按 level 过滤会把本该出现的旧事件漏掉。
   *
   * ⚠️ **措辞订正（本任务）**：这里原来写的是「缺失/畸形的分片数据（`get` 返回
   * `null` 或不是数组）当空分片处理」。**那句话没有说错，它做到了它说的那个范围**
   * ——问题是那个「畸形」的定义太窄，**把最常见的一种漏在外面：分片本身是数组、
   * 里面的某一条不是**。一条 `null` 让整个端点 500；更糟的是一条字符串或一条缺
   * `ts` 的对象**根本不 500**，原样进 `items`、把 `cursor` 变成 `undefined`
   * 被 `c.json` 整个丢掉，前端读到"字段不存在"⇒ 游标永远推不动。
   * 现在**逐条**走 `narrowShard`，判据与丢弃计数都在 `src/core/admin/event-entry.ts`。
   */
  async readEvents(after: number | null): Promise<ReadEventsResult> {
    const keys = candidateKeys(this.o.now(), after);
    const rawShards = await Promise.all(keys.map((k) => this.o.storage.get(k)));
    const shards = rawShards.map((s) => narrowShard(s));
    const items = mergeShards(shards.map((s) => s.entries), keys.length * EVENT_RING_SIZE);
    return { items, malformed: shards.reduce((n, s) => n + s.malformed, 0) };
  }
}
