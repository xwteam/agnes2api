import type { Storage } from "../ports/storage.js";
import {
  type UsageBucket, type UsageDayShard, type WriteBudget,
  FRESH_BUDGET, canWrite, consume,
  USAGE_FLUSH_MIN_INTERVAL_MS, USAGE_WRITES_PER_DAY,
  emptyBucket, addToBucket, usageDayIndex, usageHourOf, usageSlotOf, usageDayKey, usageExpiresAt,
  boundUsageKey, USAGE_DAY_MS,
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
 * 落盘间隔的生效值 + 每天写预算，由 `USAGE_FLUSH_INTERVAL_MS` 与**存储有没有写配额**共同决定。
 *
 * ── 为什么判据是「存储能力」而不是「在哪个运行时上跑」 ──────────────────────
 * ⚠️ **这不是运行时嗅探。** 入参 `hasWriteQuota` 的唯一来源是
 * `RuntimeInfo.quotaModel`（`src/ports/runtime.ts` 明写「KV 有四个每天的配额桶；
 * 文件存储没有配额」），也就是本仓**双运行时差异的唯一注入点**；面板那一侧读的同样是
 * `GET /admin/api/capabilities` 的 `quota.model`，**不是 `runtime.name`**。
 * 与 `POOL_CACHE_TTL_MS` 完全同构：那个值也只在 KV 形态下要紧，
 * 而它同样不按运行时分叉。
 *
 * **默认值两种形态逐字相同**（`USAGE_FLUSH_MIN_INTERVAL_MS`，且都带 `USAGE_WRITES_PER_DAY`
 * 那道闸）⇒ 没设这个环境变量的部署，两边行为一个字节都不差。分叉只发生在
 * **运维显式设了它**的时候，那是一次知情选择。
 *
 * ── 两侧各自的规则 ───────────────────────────────────────────────────────
 * · **没有写配额**（FileStorage / Docker）：任意正整数放行，**并且不设每天的写预算**
 *   （`budgetPerDay: null`）。留着那道闸的话，把间隔调到 300 秒的结果是
 *   「头 65 分钟写满 13 次、之后整天不写」——比默认值更糟，那正是
 *   `USAGE_FLUSH_MIN_INTERVAL_MS` 上方已经论证过的形态。此时的上界是间隔本身。
 * · **有写配额**（KV / Worker）：预算恒为 `USAGE_WRITES_PER_DAY`，而间隔必须满足
 *   `间隔 × (预算 − 1) >= 一天`，否则 **fail-closed 直接抛**，并把最小可用值写进错误消息。
 *   不许默默接受一个会让半天没有数据的值：**写量合格而数据从中午起就是假的，
 *   比起不来更难发现。**
 *
 * ⚠️ **非法值一律抛，不降级**：这是部署时错误，运维必须立刻看得见，
 * 而且它不可能是面板写坏的（面板永远碰不到环境变量）——与 `num()` 对
 * 环境变量那一支的处置逐字相同。
 */
export function resolveUsageFlushInterval(
  raw: string | undefined,
  hasWriteQuota: boolean,
): { flushIntervalMs: number; budgetPerDay: number | null } {
  const budgetPerDay = hasWriteQuota ? USAGE_WRITES_PER_DAY : null;
  if (raw === undefined) {
    return { flushIntervalMs: USAGE_FLUSH_MIN_INTERVAL_MS, budgetPerDay };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`环境变量 USAGE_FLUSH_INTERVAL_MS 必须是不小于 1 的整数: ${raw}`);
  }
  if (hasWriteQuota && n * (USAGE_WRITES_PER_DAY - 1) < USAGE_DAY_MS) {
    const min = Math.ceil(USAGE_DAY_MS / (USAGE_WRITES_PER_DAY - 1));
    throw new Error(
      `环境变量 USAGE_FLUSH_INTERVAL_MS=${raw} 在这种存储形态下会让一天中的大部分时间没有用量数据：`
      + `每个实例每天只有 ${USAGE_WRITES_PER_DAY} 次写配额，间隔 × (${USAGE_WRITES_PER_DAY} − 1) 必须 >= 一天。`
      + `最小可用值是 ${min}。`
      + `（文件存储没有写配额，那种部署可以随意调小。）`,
    );
  }
  return { flushIntervalMs: n, budgetPerDay };
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
 * ⚠️ **`canWrite` 的第三个参数必须显式传。**
 * 它的默认值是事件板块的 `EVENT_WRITES_PER_DAY`（12），漏传**不会有类型错误、
 * 不会有任何编译期信号**，预算却静默按 12 计——而 12 恰好是评审 R3-I1 判定为
 * 「每 24 小时恰好有一次 put 被预算拒绝」的那个值
 *（`src/core/admin/usage-stats.ts` 的 `USAGE_WRITES_PER_DAY` 说明写着这条缝的全文）。
 *
 * 本文件有**两处**调用点，**各自被一格钉着**（评审 I2：上一版只钉住了 `maybeFlush`
 * 那一处，`status()` 那一处改成漏传之后 `tsc` 通过、全量 2172 格全绿完全逃逸，
 * 而它的后果是面板上的「预算耗尽」提前一格变成一句假话——全局约束 10 的原话正是
 * 「诚实标记由后端字段驱动」）：
 * · `maybeFlush()` ⇒ 「预算按 13 计而不是事件板块的 12 —— 一次 flush 面对 20 个待落盘的日时……」；
 * · `status()`     ⇒ 「status() 的三个字段：budgetExhausted 在第 13 次 put 之后才翻真……」。
 *   **后者的判别状态是「已用 12 格」**：那一刻两种实现分叉（13 说还能写、12 说已耗尽），
 *   而在「已用 13 格」上两者都说耗尽 ⇒ 只测 13 是测不出来的（第 5 种假阳性）。
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
  /**
   * 两次落盘之间至少隔多久。**默认 `USAGE_FLUSH_MIN_INTERVAL_MS`（2 小时），
   * 两种运行时的默认值逐字相同**——运维可经 `USAGE_FLUSH_INTERVAL_MS` 覆盖，
   * 合法性由 `resolveUsageFlushInterval()` 在装配时判，不在这里。
   */
  private readonly intervalMs: number;
  /**
   * 每个 UTC 日最多写几个键。**`null` = 没有这道闸**。
   *
   * ⚠️ **`null` 只给「存储本身没有写配额」的形态**（FileStorage / Docker），
   * 判据是**存储能力**而不是 `runtime.name`——见 `resolveUsageFlushInterval()`
   * 上方那段。KV 那一侧恒是 `USAGE_WRITES_PER_DAY`，那道闸是配额账里
   * **唯一一项真正被代码保证的数**，不许被参数化掉。
   */
  private readonly budgetPerDay: number | null;

  constructor(private readonly o: {
    storage: Storage;
    now: () => number;
    shardId: string;
    /** sink 自身故障绝不许拖垮响应；出错走这里（通常是 ConsoleLogger）。 */
    onError: (err: unknown) => void;
    /** 见 `intervalMs`。缺省 = 后端常量。 */
    flushIntervalMs?: number;
    /** 见 `budgetPerDay`。**缺省 = `USAGE_WRITES_PER_DAY`，即「有写配额」那一侧的行为**。 */
    budgetPerDay?: number | null;
  }) {
    this.slot = usageSlotOf(o.shardId);
    this.lastFlushAt = o.now();
    this.intervalMs = o.flushIntervalMs ?? USAGE_FLUSH_MIN_INTERVAL_MS;
    // `?? ` 而不是 `||`：`null` 是一个有意义的取值（没有闸），不能被下坠成默认值。
    this.budgetPerDay = o.budgetPerDay === undefined ? USAGE_WRITES_PER_DAY : o.budgetPerDay;
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
    // ★ **模型名是客户端随便填的**，收进上界再当键用（评审 I4）。
    // `byProtocol` 那一行刻意不收：它的值是四条路由里的字面量，外部碰不到。
    const modelKey = boundUsageKey(acc.byModel, u.model);
    acc.byModel[modelKey] = addToBucket(acc.byModel[modelKey] ?? emptyBucket(), arg);
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
      budgetExhausted: this.budgetPerDay !== null && !canWrite(this.budget, at, this.budgetPerDay),
    };
  }

  /**
   * 到点就落盘。**永不抛**（存储那一步全量 try/catch）：统计是旁路，绝不影响响应。
   *
   * ⚠️ **「没有未落盘增量时一次写都不产生」这条性质，不是下面那个提前 return 给的**
   *（本任务变异实测 M1，**入参一并记下，否则复现不出来**：在**补上下面那格「空转」用例
   * 之前**，把 `if (this.dirty.size === 0) return` 删掉 ⇒ 当时的 11 格全绿；
   * 补上那一格之后同一条变异 ⇒ 1 红 12 绿。**同一条变异在两个时点结论相反，
   * 差别只在「那时还没有那一格」** —— 省掉这半句话，这条实测记录就是假的。）
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
   *
   * ── 可重入（评审 C1）────────────────────────────────────────────────
   * ⚠️ **`lastFlushAt` 与 `budget` 都必须在发起 `await` 之前推进。**
   * 这个方法由**每一个请求的收尾**调用，而请求是并发的：两个请求的 flush 若双双
   * 停在 `await put` 上，就会**各写一遍同一个键、各扣一格预算**。
   * 那不是「多写一次」这种量级的问题——本仓的
   * `落盘间隔 × (预算 − 1) = 一天` **两边恰好相等、没有余量，是刻意的**
   *（见 `USAGE_FLUSH_MIN_INTERVAL_MS`）⇒ **任何一次重复写都直接击穿当天的覆盖**：
   * 13 个并发请求撞上同一个 2 小时边界（繁忙网关的常态）⇒ 预算在第一次落盘就耗尽，
   * 此后到下一个 UTC 日一个字不写 ⇒ 五语言 DEPLOY.md 那句「最多旧 2 小时」
   * 变成最多旧 24 小时，而 Worker 上 isolate 活不到第二天，那些计数直接消失。
   *
   * `src/adapters/logger-store.ts` 的 `writeBatch()` 做的**恰好相反且写明了理由**
   *（「窗口与预算**在发起写之前**就推进：写失败时不重试同一批」），本方法照抄那个形态。
   * **失败不回滚**：与事件侧同源——回滚等于让一个正在故障的存储无限重试，
   * 而每一次重试都是一次真实的写尝试。代价是失败会白扣一格预算，
   * 上界很小（失败即 `break`，每个间隔至多一格）。
   * 由 `tests/contract/usage-tier2.test.ts` 的
   * 「10 个并发请求的收尾 flush 同时撞上落盘间隔：只落 1 次盘……」钉着。
   */
  async maybeFlush(): Promise<void> {
    const at = this.o.now();
    if (this.dirty.size === 0) return;
    const since = at - this.lastFlushAt;
    // `since < 0` = 时钟回拨：立刻恢复，与本仓其余四处同一套语义。
    if (since >= 0 && since < this.intervalMs) return;
    // ★ **在任何 `await` 之前就把闸关上**（评审 C1）。到这一行为止全都是同步代码，
    // 所以后来的并发调用一定会在上面那道间隔闸前掉头，不会与本次重叠。
    this.lastFlushAt = at;

    // 从最早的那天开始写：预算不够时先落旧的，新的那天下一轮还有机会。
    for (const day of [...this.dirty].sort((a, b) => a - b)) {
      // ★ 每写一个键之前各查一次预算，**每写成功一个各扣一格**（评审 C1）。
      if (this.budgetPerDay !== null && !canWrite(this.budget, at, this.budgetPerDay)) break;
      const acc = this.days.get(day);
      if (!acc) { this.dirty.delete(day); continue; }
      const shard: UsageDayShard = {
        shardId: this.o.shardId, day, updatedAt: at,
        total: acc.total, hours: acc.hours, byModel: acc.byModel, byProtocol: acc.byProtocol,
      };
      // ★ 预算同样**在发起写之前**扣，理由同上（失败不回滚）。
      this.budget = consume(this.budget, at);
      try {
        await this.o.storage.put(usageDayKey(day, this.slot), shard, usageExpiresAt(day));
      } catch (err) {
        // **不清这一天的累加器、也不从 dirty 里移除**：写失败时清掉等于把这一段计数
        // 永久丢了，而下一次落盘本来能带上它。**后面那些天也不再试**——同一个存储
        // 大概率一起失败，继续试只是白烧预算。
        this.o.onError(err);
        break;
      }
      this.dirty.delete(day);
      // ⚠️ **`days` 里那一天的累加器不清零**：它是「这一天的累计值」，
      // 同一天的下一次落盘要把它整份再写一遍（覆写同一个键）。
      // **只有 `dirty` 被清**，它表示的是「有没有新增量要落」。
    }
    // ⚠️ **只有「该落的都落下去了」才清 `pending`。**
    // 预算耗尽（`break`）或存储抛错（`break`）时 `dirty` 仍然非空，那些计数是真的
    // 还没落盘 —— 这时候把 `pending` 归零就是对面板说「没有未落盘的尾巴」，
    // 而那正是全局约束 9 点名的「三件事在面板上长得一模一样」。
    // **偏保守的方向是安全的**：写成功了一天、另一天被预算挡住时，这里会把已落盘
    // 那一天的条数继续算进 `pending`（尾巴报得比实际长），而反过来永远不会发生。
    if (this.dirty.size === 0) this.pending = 0;
  }
}
