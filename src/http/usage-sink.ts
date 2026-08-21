import type { Storage } from "../ports/storage.js";
import {
  type UsageBucket, type UsageDayShard, type WriteBudget,
  FRESH_BUDGET, canWrite, consume,
  USAGE_FLUSH_MIN_INTERVAL_MS, USAGE_WRITES_PER_DAY,
  emptyBucket, addToBucket, usageDayIndex, usageHourOf, usageSlotOf, usageDayKey, usageExpiresAt,
} from "../core/admin/usage-stats.js";

/** 一次转发的终态。四条协议路由各自填一份，**协议名由路由传，不靠 dispatch 猜**。 */
export interface UsageOutcome {
  protocol: string;
  model: string;
  ok: boolean;
  stream: boolean;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

/** 一个 UTC 日的在内存累加器。落盘时整份覆写进 `usage:<day>:<slot>`。 */
interface DayAcc {
  total: UsageBucket;
  hours: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  byProtocol: Record<string, UsageBucket>;
}

function emptyDay(): DayAcc {
  return { total: emptyBucket(), hours: {}, byModel: {}, byProtocol: {} };
}

/**
 * 上游那份响应体里的 token 数。
 *
 * ⚠️ **入参是上游的 OpenAI 形状（`usage.prompt_tokens` / `usage.completion_tokens`），
 * 不是客户端最终收到的那一份**，这两者在本仓是两个不同的对象，别拿协议目录的
 * `usagePath` 往这里套：`ProtocolEntry.usagePath` 描述的是**客户端收到的**响应里
 * usage 在哪（Gemini 那条是 `usageMetadata`、Anthropic 那条里面是 `input_tokens`），
 * 而三条协议路由拿到的 `await res.json()` **全部**是上游那份 OpenAI 格式
 *（`src/core/protocol/gemini.ts` 的 `toGeminiResponse` 就是从 `openai.usage.prompt_tokens`
 * 换算成 `usageMetadata` 的）。拿 `["usageMetadata"]` 去取上游对象只会取到 `undefined`
 * ⇒ **Gemini 那条协议的 token 恒 0，而面板上它长得和「这段时间没人用 Gemini」一模一样。**
 *
 * 协议目录在这条路径上仍然是唯一真源，只是它回答的是**另一个问题**：
 * 「哪几条协议的 token 是网关看得到的」=`usagePath !== null`，那一份由
 * `GET /admin/api/capabilities` 的 `stats.tokensCoverage` 发出去（P3d Task 3 Step 5），
 * **前端不许自己再写一份**。
 *
 * ⚠️ **一律 `unknown` + 窄化**（硬约束 8）：上游返回什么形状都可能，
 * `usage: null` / `prompt_tokens: "12"` / 负数都要落到 0，而不是把 `NaN` 累进桶里
 * ——一个 `NaN` 进了 `total.tokensIn` 之后，那一天整份分片的 token 数就再也回不来了。
 */
export function upstreamTokens(body: unknown): { tokensIn: number; tokensOut: number } {
  const usage = (body as { usage?: unknown } | null | undefined)?.usage;
  if (usage === null || usage === undefined || typeof usage !== "object") {
    return { tokensIn: 0, tokensOut: 0 };
  }
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
  return { tokensIn: n(u.prompt_tokens), tokensOut: n(u.completion_tokens) };
}

/** 四条协议路由消费的那一小块 deps。**可选**，缺席 = Tier-2 关着。 */
export interface UsageRecording {
  usageSink?: UsageSink;
}

/**
 * 记一次转发。**四条路由无条件调它**——「开关为假时零成本」这条性质由**这里第一行**
 * 承担，不是由四条路由各写一次 `if`（写四遍就迟早有一条漏掉，而漏掉的那一条
 * 在面板上完全看不出来）。
 *
 * ⚠️ **`usageSink` 缺席时这个函数体第一行就 return**：不建累加器、不碰存储
 *（P3d 计划全局约束 16）。它与「sink 存在但没到落盘间隔」是**两件事**：
 * 后者仍然在内存里累加，只是不写盘。
 */
export function recordUsage(deps: UsageRecording, u: UsageOutcome): void {
  if (deps.usageSink === undefined) return;
  deps.usageSink.record(u);
}

/**
 * Tier-2 的内存累加器 + 落盘。
 *
 * ⚠️ **落盘由中间件在请求收尾 `await`，不是 `ctx.waitUntil`、不是定时器**（订正 F3）。
 * 设计 §7.1 写的是 `ctx.waitUntil(maybeFlush())`，而仓里既定的做法是
 * `src/http/log-flush.ts` 的 `await flush()`，那个文件头逐字写着：
 * 「fire-and-forget 在 Worker 上会被响应返回后的 isolate 停摆截断」。
 * 两种运行时同一条代码路径，这是硬约束 1。
 *
 * ⚠️ **累加器按 UTC 日分桶（`Map<day, DayAcc>`），不是一份全局累计。**
 * 一份全局累计 + 按天分的键 = **重复计数**：第 N 天的键里装着从 isolate 启动到现在的
 * 全部量，跨天读回来求和就多算了。**而重复计数在面板上长得完全正常**——
 * 没有任何断言会因为数字偏大而红，除非专门写一条（`tests/contract/usage-tier2.test.ts`
 * 的「跨两个 UTC 日各落一次盘，合并读回来不许重复计数……」那一格就是那一条）。
 * 分桶之后每个键装的就只是那一天的量，落盘时**每个有未落盘增量的日各写一个键**，
 * 写成功的那个日才从待落盘集合里移除。
 *
 * ⚠️ **预算 `consume()` 每写一个键调一次，不是每次 flush 调一次**（评审 C1）。
 * 一次 flush 通常只写 1 个键（间隔 2 小时 < 一天），跨 UTC 零点那一次写 2 个。
 * 数 flush 的话那一次会少扣一格，而配额账是按 put 算的。
 *
 * ⚠️ **`canWrite` 的第三个参数必须显式传 `USAGE_WRITES_PER_DAY`。**
 * 它的默认值是事件板块的 `EVENT_WRITES_PER_DAY`（12），漏传**不会有类型错误、
 * 不会有任何编译期信号**，预算却静默按 12 计——而 12 恰好是评审 R3-I1 判定为
 * 「每 24 小时恰好有一次 put 被预算拒绝」的那个值
 *（`src/core/admin/usage-stats.ts` 的 `USAGE_WRITES_PER_DAY` 说明写着这条缝的全文）。
 * 本文件两处调用点都显式传，由 `tests/contract/usage-tier2.test.ts` 的
 * 「预算按 13 计而不是事件板块的 12 —— 一次 flush 面对 20 个待落盘的日时……」正面钉着。
 *
 * ⚠️ **构造时 `lastFlushAt = now()` 而不是 null**，照抄 `StoreLogger` 的评审 C1 结论：
 * 判到 `null` 就跳过间隔检查 ⇒ 每次 isolate 冷启动送一次零门槛写。
 * 代价（未落盘的尾巴最长一个间隔）见 P3d 计划 §配额账，
 * **那是一条代价，不是「默认关」的理由**。
 */
export class UsageSink {
  /**
   * UTC 日序号 → 那一天的**累计**值。
   *
   * ⚠️ **落盘成功之后这里不清零**（同一天的下一次落盘要把整份再覆写一遍），
   * 跨天之后旧日的累加器也仍然留着。**上界是这个 isolate 的存活天数**：
   * Worker 上是分钟级、至多一两个键；Node 上跑满一年也就 365 个小对象。
   * 为它加一条清理路径要在热路径上多一次判断，换不回任何可观测的东西
   * ——**明写在这里，免得下一个人以为它「只保留有未落盘增量的那些日」**。
   */
  private readonly days = new Map<number, DayAcc>();
  /** 有未落盘增量的日序号。落盘成功一个就删一个。 */
  private readonly dirty = new Set<number>();
  private pending = 0;
  private lastFlushAt: number;
  private budget: WriteBudget = FRESH_BUDGET;
  /**
   * 这个 isolate 稳定落在哪个槽位。**构造时算一次、终生不变。**
   *
   * 这不是省一次取模的微优化，是一条会被观测到的性质：`usageSlotOf` 是纯函数，
   * 每次现算给出的结果**也**一样——真正的区别在于 `shardId` 是构造参数，
   * 把取模挪进 `maybeFlush()` 就等于允许「同一个 sink 中途换槽位」这种形态存在，
   * 而那会让同一天的两次落盘写进两个键、读回来重复计数。
   * `src/core/admin/usage-stats.ts` 的 `usageSlotOf` 上方逐字写着
   * 「『构造时算一次、终生不变』是对 `UsageSink` 的要求，不是本函数的性质」
   * ——这一行就是那句话的落点，由 `tests/contract/usage-tier2.test.ts` 的
   * 「槽位是构造时算一次、终生不变：同一个 sink 跨两天落盘只写同一个槽位……」钉着。
   */
  private readonly slot: number;

  constructor(private readonly o: {
    storage: Storage;
    now: () => number;
    shardId: string;
    /** sink 自身故障绝不许拖垮响应；出错走这里（通常是 ConsoleLogger）。 */
    onError: (err: unknown) => void;
  }) {
    this.slot = usageSlotOf(o.shardId);
    this.lastFlushAt = o.now();
  }

  record(u: UsageOutcome): void {
    const at = this.o.now();
    const day = usageDayIndex(at);
    const hour = usageHourOf(at);
    const acc = this.days.get(day) ?? emptyDay();
    const arg = {
      ok: u.ok, stream: u.stream, latencyMs: u.latencyMs,
      tokensIn: u.tokensIn, tokensOut: u.tokensOut,
    };
    acc.total = addToBucket(acc.total, arg);
    acc.hours[hour] = addToBucket(acc.hours[hour] ?? emptyBucket(), arg);
    acc.byModel[u.model] = addToBucket(acc.byModel[u.model] ?? emptyBucket(), arg);
    acc.byProtocol[u.protocol] = addToBucket(acc.byProtocol[u.protocol] ?? emptyBucket(), arg);
    this.days.set(day, acc);
    this.dirty.add(day);
    this.pending++;
  }

  /**
   * 面板要看的自述状态。`pendingMs` 让「未落盘的尾巴有多长」可见，而不是只说一句「≈」。
   *
   * ⚠️ **`pendingMs` 数的是「距上一次落盘**尝试**多久」，不是「距上一次写成功多久」。**
   * 两者在稳态下相同，在两种失败态下不同：预算耗尽或存储抛错的那一次
   * `maybeFlush()` 照样把 `lastFlushAt` 推到当下（那是**节流**要的语义——
   * 不推的话存储一直失败时每个请求都会重试一次，白烧配额与延迟）。
   * ⇒ **那两种态由另外两个字段说话**：`pending > 0` 与 `budgetExhausted`。
   * `pending > 0 && pendingMs ≈ 0` 读作「刚试过、没写成」，不是「刚写完」。
   */
  status(): { shardId: string; pending: number; pendingMs: number; budgetExhausted: boolean } {
    const at = this.o.now();
    return {
      shardId: this.o.shardId,
      pending: this.pending,
      pendingMs: Math.max(0, at - this.lastFlushAt),
      // ★ 第三参显式传，理由见类说明里那段 ⚠️。
      budgetExhausted: !canWrite(this.budget, at, USAGE_WRITES_PER_DAY),
    };
  }

  /**
   * 到点就落盘。**永不抛**（存储那一步全量 try/catch）：统计是旁路，绝不影响响应。
   *
   * ⚠️ **「没有未落盘增量时一次写都不产生」这条性质，不是下面那个提前 return 给的**
   *（本任务变异实测 M1：把 `if (this.dirty.size === 0) return` **删掉之后 11 格全绿**）。
   * 给它的是**循环本身**——`for (const day of [...this.dirty])` 在空集合上一次都不进
   * 循环体。这一句与 `StoreLogger.maybeFlush()` 的第一行**形态相同而作用不同**：
   * 那边删掉之后 `writeBatch()` 会照写一个空缓冲，这边不会。
   * **别照着那边的说法把这里也写成「零写由它保证」——那句话在这个文件里是假的。**
   *
   * 它真正保证的是另一件事：**空转的 flush 不许把 `lastFlushAt` 往前推。**
   * 没有它的话，面板轮询（每 15~60 秒一次，`/admin/api/*` 也走这条中间件）会在
   * 零流量期间不停地把落盘时钟刷到当下 ⇒ **真的来了第一条计数时，它要再等满一个
   * 落盘间隔（2 小时）才落得下去**，而运维看到的是「打了请求，面板上半天没数」。
   * 由 `tests/contract/usage-tier2.test.ts` 的
   * 「空转的 flush 不许把落盘时钟往前推……」钉着（那一格红，上面那条不红）。
   */
  async maybeFlush(): Promise<void> {
    const at = this.o.now();
    if (this.dirty.size === 0) return;
    const since = at - this.lastFlushAt;
    // `since < 0` = 时钟回拨：立刻恢复，与本仓其余四处同一套语义。
    if (since >= 0 && since < USAGE_FLUSH_MIN_INTERVAL_MS) return;

    // 从最早的那天开始写：预算不够时先落旧的，新的那天下一轮还有机会。
    for (const day of [...this.dirty].sort((a, b) => a - b)) {
      // ★ 每写一个键之前各查一次预算，**每写成功一个各扣一格**（评审 C1）。
      if (!canWrite(this.budget, at, USAGE_WRITES_PER_DAY)) break;
      const acc = this.days.get(day);
      if (!acc) { this.dirty.delete(day); continue; }
      const shard: UsageDayShard = {
        shardId: this.o.shardId, day, updatedAt: at,
        total: acc.total, hours: acc.hours, byModel: acc.byModel, byProtocol: acc.byProtocol,
      };
      try {
        await this.o.storage.put(usageDayKey(day, this.slot), shard, usageExpiresAt(day));
      } catch (err) {
        // **不清这一天的累加器、也不从 dirty 里移除**：写失败时清掉等于把这一段计数
        // 永久丢了，而下一次落盘本来能带上它。**后面那些天也不再试**——同一个存储
        // 大概率一起失败，继续试只是白烧预算。
        this.o.onError(err);
        break;
      }
      this.budget = consume(this.budget, at);
      this.dirty.delete(day);
      // ⚠️ **`days` 里那一天的累加器不清零**：它是「这一天的累计值」，
      // 同一天的下一次落盘要把它整份再写一遍（覆写同一个键）。
      // **只有 `dirty` 被清**，它表示的是「有没有新增量要落」。
    }
    this.lastFlushAt = at;
    // ⚠️ **只有「该落的都落下去了」才清 `pending`。**
    // 预算耗尽（`break`）或存储抛错（`break`）时 `dirty` 仍然非空，那些计数是真的
    // 还没落盘 —— 这时候把 `pending` 归零就是对面板说「没有未落盘的尾巴」，
    // 而那正是全局约束 9 点名的「三件事在面板上长得一模一样」。
    // **偏保守的方向是安全的**：写成功了一天、另一天被预算挡住时，这里会把已落盘
    // 那一天的条数继续算进 `pending`（尾巴报得比实际长），而反过来永远不会发生。
    if (this.dirty.size === 0) this.pending = 0;
  }
}
