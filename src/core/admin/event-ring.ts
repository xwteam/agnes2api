import type { LogEntry } from "../../ports/logger.js";

/**
 * 事件持久化的分片键空间、环形缓冲与写预算。**零 IO 纯函数**（硬约束 2）：
 * 时间从参数进，状态进、状态出，不碰 `Date.now()` / `crypto` / 任何计时器。
 *
 * ⚠️ **本文件是评审 3 条 Critical（C1 写预算全局失守 / C2 索引无上限增长 /
 * C3 索引读改写丢更新）之后的重写版**，取代了 Task 6 首轮"每 isolate 一个随机
 * shardId + `event:index` 索引"的形态。裁定：**去掉索引，改用「时间窗 + 槽位」的
 * 分片键空间**——读路径不再需要 `list()` 也不需要索引，候选键由 `candidateKeys()`
 * 纯计算得出。C3（索引读改写丢更新）因此**根除**：没有索引就没有那个唯一需要
 * 读改写的键，代价改成了"同槽位真并发覆盖"（见下）。
 *
 * ⚠️ **C2（无上限增长）第一版只做对了一半，被下一轮评审（C4/C4b/C5）逮住**：
 * - `candidateKeys()` 最初没有钳位 `after`，一个陈旧游标能让候选键数随"游标陈旧度"
 *   线性增长、无上界（C4/C4b）——**这是 C2 换了一根轴复发**：旧设计的增长轴是
 *   "部署年龄"，新设计换成了"游标陈旧度"，而"游标冻结、系统长期安静"恰恰是本项目
 *   最常见的稳态（全仓事件白名单清一色是错误诊断事件）。现在 `candidateKeys()`
 *   把 `fromWindow` 钳位在 `nowWindow - EVENT_WINDOW_RETAIN + 1`，读路径的候选键数
 *   对任何 `after` 值都有硬上界。
 * - `window` 索引本身是绝对纪元小时数，不取模、单调递增，读路径钳位不等于"存储里
 *   实际驻留的键数有界"（C5）——`StoreLogger.maybeFlush()` 现在会在每次成功落盘后
 *   顺手删除滚出保留期的那个窗口键，存储侧的键数因此也有上限。
 *
 * 代价：两个 isolate 在同一个「时间窗 + 槽位」组合上落盘时会互相覆盖对方那一批
 * （最后写的赢），不是"永久不可达"（C3 的失效形态），而是"丢一次交错，下一轮各自
 * 继续写自己的"——见 `tests/unit/admin/event-ring.test.ts` 里专门钉住这条代价的用例。
 */

/** 单个分片键最多留多少条。超了丢**最旧**的。 */
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
 *
 * ⚠️ **评审 C1 的另一半**：只有这条闸不够——`StoreLogger` 原来在冷启动那一刻
 * `lastFlushAt === null`，第一次 `maybeFlush()` 跳过这条闸直接写，等于每次 isolate
 * 冷启动送一次零门槛写。修法在 `logger-store.ts` 的构造函数里：`lastFlushAt` 初值
 * 给 `now()` 而不是 `null`，让冷启动首刷也受这条闸约束。
 */
export const EVENT_FLUSH_MIN_INTERVAL_MS = 60_000;

/**
 * 每个 isolate **每天**最多落盘几次。
 *
 * ⚠️ **改成按天算，不再按小时**：写预算是 `WriteBudget` 一个实例字段，只在**单个
 * isolate 内部**生效——评审实测默认配置下 4 个 isolate 各自独立按小时计数，
 * 汇总到共享的 KV 写桶（每天 1,000 次）就变成 `4 × 12 × 24 = 1,152`，**已超配额**。
 * KV 写配额本身是**按 UTC 天**重置的（见本仓其余处对这一点的核实），把闸也定义成
 * 按天算更贴近这个真实的重置节奏，也让下面的「M 个并发 isolate」算式不必再乘一次
 * 「一天有几个这样的窗口」。
 *
 * **这不是本地能解决的问题**——单个 isolate 无法知道其他 isolate 用了多少预算
 * （没有 CAS、没有跨 isolate 协调机制），所以这条闸只能保证「单个 isolate 不超发」，
 * 全局配额是否安全取决于**这个值本身选得够保守**，乘以「现实的并发 isolate 数」之后
 * 仍在预算内。取值与算式见 DEPLOY.md「配额账」小节以及 P3b progress.md 的裁定记录：
 * `12/isolate/天 × 8 个并发 isolate = 96/天`（9.6% 的写配额），与 key 池写侧的
 * `key 数 × 4`（20 把 key 时 80/天，8%）相加约 17.6%，留有余量。
 * 预算用完时**不写**，缓冲区继续接（满了丢最旧的并计数），
 * 并让 `/admin/api/events` 如实报 `budgetExhausted`。
 * **`ConsoleLogger` 那一路一条都不丢**，排障能力不受影响。
 */
export const EVENT_WRITES_PER_DAY = 12;

const DAY_MS = 86_400_000;

/**
 * 时间窗长度。分片键的第一维（`event:<窗口>:<槽位>`）。1 小时是权衡：太短则冷启动
 * 回看整个保留期要扫的窗口数（下面的 `EVENT_WINDOW_RETAIN`）会涨，太长则「稳态轮询
 * 跨过窗口边界」的那一刻要多扫一个窗口的频率会跌不下去。
 */
export const EVENT_WINDOW_MS = 3_600_000;

/**
 * 每个时间窗内的槽位数。分片键的第二维。多个 isolate 落进同一个「窗口+槽位」组合时
 * 会互相覆盖对方那一批（见文件头的说明），槽位数越大越能分散并发 isolate、代价越小，
 * 但读路径的候选键数 = 窗口数 × 槽位数，涨槽位数就是涨每次轮询的 get 次数。
 * 取 2：在「读预算」与「碰撞代价」之间选了一个都不极端的点，见 DEPLOY.md 的配额账。
 */
export const EVENT_SLOTS = 2;

/**
 * 冷启动/首次加载最多回看多少个时间窗（= 面板上能看到的最老历史深度）。
 * 24 个窗口 × `EVENT_WINDOW_MS`（1 小时）= 24 小时可见历史。
 * 这个值只影响"冷"读（`after === null`）的开销，稳态轮询走增量范围（见 `candidateKeys`），
 * 不随这个值增长。
 */
export const EVENT_WINDOW_RETAIN = 24;

/** `at`（毫秒时间戳）落在第几个时间窗。 */
export function windowIndex(at: number): number {
  return Math.floor(at / EVENT_WINDOW_MS);
}

/**
 * 稳定的字符串 → 槽位映射。**纯函数、确定性**：同一个 `shardId` 任何时候算出来的
 * 槽位都一样，这样同一个 isolate 的连续多次落盘会稳定落在同一把 key 上（`appendRing`
 * 的环形语义才有意义——落在不同 key 上就退化成每次只有一条，起不到环形累积的作用）。
 */
export function slotOf(shardId: string): number {
  let h = 0;
  for (let i = 0; i < shardId.length; i++) h = (h * 31 + shardId.charCodeAt(i)) | 0;
  return ((h % EVENT_SLOTS) + EVENT_SLOTS) % EVENT_SLOTS;
}

/**
 * 分片键。`event:<窗口>:<槽位>`。
 *
 * ⚠️ **评审 C5 订正**：这里原来写着"两维都是有界整数，键空间因此整体有界"——
 * **不成立，是本项目第十一次「注释里的假断言」**。槽位维确实有界（`EVENT_SLOTS`
 * 固定为 2），但 `window` 是绝对纪元小时数（`windowIndex` 不取模），**单调递增、
 * 本身无界**。读路径的候选键数有界（`candidateKeys` 钳位到 `EVENT_WINDOW_RETAIN`）
 * 不等于"存储里实际驻留的键数有界"——全仓没有任何 delete 路径、`KvStorage.put`
 * 也不设 `expirationTtl` 之前，滚出保留期的旧窗口键会**永久堆积**（评审实测：
 * 运行 365 天后 distinct event 键数 4,380，且 100 小时前写的键"仍在存储里但
 * `readEvents` 已经看不到它"——占空间却读不到，是最坏的一种"有界"）。
 * 真正让存储里的键数有上界的是 `StoreLogger.maybeFlush()` 里那次顺手删除
 * （见该文件），不是这个函数本身——这个函数只负责拼出一个字符串。
 */
export function shardKey(window: number, slot: number): string {
  return `event:${window}:${slot}`;
}

/**
 * 读路径要扫的候选键——**这就是「零索引」的全部依据**：不查任何存储就能算出
 * 这次要 get 哪些键。
 *
 * - `after === null`（面板首次加载 / 清空视图后重新拉 / 直接调 API 不带 `after`）：
 *   回看 `EVENT_WINDOW_RETAIN` 个窗口（冷读）。
 * - `after` 有值（增量轮询）：只看 `after` 所在窗口到当前窗口——通常是同一个窗口
 *   （1 个），跨窗口边界的那一刻是 2 个。
 *
 * ⚠️ **评审 C4/C4b：`fromWindow` 必须钳位在 `floor`（= `nowWindow - EVENT_WINDOW_RETAIN
 * + 1`）之下不能再往前**。没有这条钳位时，一个陈旧或被构造成极端值的 `after`
 * （`after=0`、`after=-1e11`，或者单纯是「系统很安静、很久没有新事件、`state.after`
 * 冻结在很早以前」这种完全合法的稳态）会让 `fromWindow` 远早于 `floor`，候选键数量
 * 随 `nowWindow - fromWindow` 线性增长、**没有上界**——评审实测 `after=0` 时单次
 * 请求打出约 **99 万次 get**。**这正是 C2（索引无上限增长）换了一根轴复发**：
 * 旧设计的增长轴是"部署年龄"（isolate 冷启动次数），新设计换成了"游标陈旧度"，
 * 而"游标冻结在早期、系统长期安静"恰恰是这个项目里**最常见**的稳态——全仓的事件
 * 白名单清一色是错误诊断事件，健康的网关产出事件数是 0。
 *
 * 钳位之后，`candidateKeys()` 的返回长度**对任何 `after` 值（含负数、含极端未来值）
 * 都不超过 `EVENT_WINDOW_RETAIN × EVENT_SLOTS`**——这个函数自身现在是这条不变量
 * 唯一需要守住的地方，`afterParam()`（HTTP 层）额外拒绝负数只是让语义更干净
 * （负的时间戳不是一个有意义的输入），不是这条安全性质的必要条件。
 *
 * 返回顺序：窗口升序、同窗口内槽位升序（顺序本身没有语义，只是让候选键列表本身
 * 也是确定性的，便于测试断言）。
 */
export function candidateKeys(now: number, after: number | null): string[] {
  const nowWindow = windowIndex(now);
  const floor = nowWindow - EVENT_WINDOW_RETAIN + 1;
  const fromWindow = after === null ? floor : Math.max(floor, windowIndex(after));
  const keys: string[] = [];
  for (let w = fromWindow; w <= nowWindow; w++) {
    for (let s = 0; s < EVENT_SLOTS; s++) keys.push(shardKey(w, s));
  }
  return keys;
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
 * 这一次 `appendRing` 会截掉多少条**已经在存储里**的旧事件。
 *
 * **评审 I1**：`appendRing` 本身会静默丢弃超限的最旧条目，而 `StoreLogger.dropped`
 * 原来只在**内存缓冲**溢出时计数——分片键攒满 100 条之后，**每一次落盘都在这里
 * 静默丢弃**，是任何有持续流量部署的稳态，而面板此时显示 `dropped: 0`。
 * 这个函数让调用方（`StoreLogger.maybeFlush`）能把这类丢弃也计入同一个 `dropped`
 * 总数——它是纯粹的算术，不重新实现 `appendRing` 的逻辑，只是把"截了多少"算出来。
 */
export function truncatedCount(curLen: number, addLen: number, size: number = EVENT_RING_SIZE): number {
  return Math.max(0, curLen + addLen - size);
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
  dayStart: number;
  used: number;
}

/**
 * 全新的预算。`dayStart: 0` 只是一个哨兵起点——真实的 `at`（无论是测试里从 0 起步
 * 的假时钟，还是生产的 `Date.now()`）第一次调用 `consume` 时都会把 `dayStart` 换成
 * 那次调用的真实 `at`，所以这个初值本身不承载语义，只是「还没有任何窗口」的记号。
 */
export const FRESH_BUDGET: WriteBudget = { dayStart: 0, used: 0 };

/**
 * `at` 是否仍落在 `b` 记录的那一天窗口内。
 *
 * `at < b.dayStart`（时钟回拨）与 `at - b.dayStart >= DAY_MS`（正常跨过一天）
 * **都**判定为「不在窗口内」——两者都按「新的一天」处理，与本仓其余三处
 * （`Refreshable` / `listOnReadPath` / `KeyPoolRepo` 的 `age < 0` 判据）同一套语义：
 * 回拨立刻恢复可写，不会把预算冻结到「回拨量走完」才解封，也不会缓存出负的 `used`。
 */
function inWindow(b: WriteBudget, at: number): boolean {
  return at >= b.dayStart && at - b.dayStart < DAY_MS;
}

export function canWrite(b: WriteBudget, at: number, perDay: number = EVENT_WRITES_PER_DAY): boolean {
  const used = inWindow(b, at) ? b.used : 0;
  return used < perDay;
}

export function consume(b: WriteBudget, at: number): WriteBudget {
  return inWindow(b, at) ? { dayStart: b.dayStart, used: b.used + 1 } : { dayStart: at, used: 1 };
}
