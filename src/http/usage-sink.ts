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

/**
 * ⚠️ **三个 map 都必须是无原型的（`Object.create(null)`）**（收口复评）。
 *
 * `byModel` 的键**完全由客户端控制**（模型名来自请求体），而普通 `{}` 上有两条
 * 会静默坏掉的路径，实测都不是理论：
 * · `acc.byModel["__proto__"] = 桶` **不是加一个键，是去改原型** ⇒ 那一条计数
 *   **彻底消失**（自有键里没有它、`JSON.stringify` 也看不见），同时整个 map 的原型
 *   被换成一个桶；
 * · `acc.byModel["toString"] ?? emptyBucket()` 会摸到 **`Function.prototype.toString`**
 *   ⇒ 拿函数去做加法，那一格序列化成 `{"requests":null,…}`
 *   （`constructor` / `hasOwnProperty` 同理）。
 * **两种都让落盘的分片自己和自己对不上（`total` ≠ Σ`byModel`）——正是并发那半
 * 刚消灭掉的失效形态，从另一个入口原样回来。**
 *
 * `boundUsageKey()` 用 `Object.prototype.hasOwnProperty.call` 守住了「存在性判断」，
 * **但取值那一步 `?? emptyBucket()` 防不住原型** ⇒ 一处改 map 的造法，整类关掉。
 * `JSON.stringify` 与 `{ ...map }`（并发那半的快照）对无原型对象都照常工作，已实测。
 *
 * `hours` / `byProtocol` 的键今天是闭集（`"00"`…`"23"` 与四条协议的字面量），
 * **一起改是因为「三个 map 造法一致」比「记住只有一个需要」可靠**。
 */
function emptyDay(): DayAcc {
  return {
    total: emptyBucket(),
    hours: Object.create(null),
    byModel: Object.create(null),
    byProtocol: Object.create(null),
  };
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
 * `GET /admin/api/capabilities` 的 `stats.tokensCoverage` 发出去，
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

/** sink 自己出故障的两个阶段。见 `USAGE_ERROR_REPORT`。 */
export type UsagePhase = "record" | "flush";

/**
 * 两个阶段各自该对运维说什么。**写成查表而不是三元**，与
 * `src/http/admin/router.ts` 的 `REJECT_MESSAGE` 同一条理由：
 * 类型是 `Readonly<Record<UsagePhase, …>>`，所以给 `UsagePhase` 加一个新阶段时
 * **`tsc` 会先在这里报错**；写成三元的话 else 分支会把新阶段**误报成**旧的那条，
 * 而运维照着一句错的诊断去处置是查不出问题的。
 *
 * ⚠️⚠️ **两句话的意思是相反的，这正是它们必须分家的全部理由**（认账修正）：
 * · `flush` ⇒ **累加器保留，下一次落盘会把这一段带上** ——数据没丢；
 * · `record` ⇒ **这一条计数已经永久丢失** ——`record()` 里可能抛的那些步骤全都排在
 *   任何一次写入累加器**之前**（见 `record()` 上方那段对 `try` 边界的说明），
 *   所以抛出去之后累加器一个字节都没变、`dirty` 也没被置上，
 *   **下一次落盘不会、也没法把它补回来**。
 *
 * 在这张表出现之前，两者共用 `storage.usage_flush_failed` 与 flush 那句文案
 * ——**对 record 期那一类，那句承诺是假的**。
 *
 * ⚠️ **如实登记它今天的可达性，别把它读成「修了一个正在咬人的缺陷」**：
 * `record()` 里唯一还够得着的抛点是**注入的时钟**。模型名那一档已经被
 * `src/core/admin/usage-stats.ts` 里的 `safeString()` 堵死了——本任务实测：
 * 拿 `JSON.parse('{"toString":1,"valueOf":1}')` 当 `model` 走真装配打一次
 * `/v1/chat/completions`（空池 ⇒ 503 `pool_empty`，Tier-2 开着），
 * **`onError` 一次都没被调到**，那一条计数照常记进了累加器。
 * ⇒ 这条 catch 今天是**一个还没被走到的陷阱**，不是一条活着的缺陷；
 * 分家是为了让它被走到的那天说的是真话（`safeString` 一旦被谁删掉，
 * 那一天就是当天——`boundUsageKey` 上方逐字记着删掉它之后的实测结果）。
 *
 * 由 `tests/contract/admin-usage.test.ts` 的
 * 「record 期出错与 flush 期出错走两条不同的事件，文案不许互相冒充」穷尽两个阶段。
 */
export const USAGE_ERROR_REPORT: Readonly<Record<UsagePhase, { event: string; msg: string }>> = {
  record: {
    event: "usage.record_failed",
    msg: "记一次用量时出错，**这一条计数已经永久丢失**：累加器没有被改动，下一次落盘也不会把它补上",
  },
  flush: {
    event: "storage.usage_flush_failed",
    msg: "用量分片落盘失败，这一天的累加器**保留**，下一次落盘会把这一段带上",
  },
};

/**
 * 落盘间隔的生效值 + 每天写预算，由 `USAGE_FLUSH_INTERVAL_MS` 与**存储有没有写配额**共同决定。
 *
 * ── 为什么判据是「存储能力」而不是「在哪个运行时上跑」 ──────────────────────
 * ⚠️ **这不是运行时嗅探。** 入参 `hasWriteQuota` 的唯一来源是
 * `RuntimeInfo.quotaModel`（`src/ports/runtime.ts` 明写「KV 有四个每天的配额桶；
 * 文件存储没有配额」）。`RuntimeInfo` 是本仓**双运行时差异的唯一注入点**，
 * `quotaModel` 是它里面的一格——**不是说这个接口里只有这一格**（同一个接口里还有
 * `name` 与 `storageBackend`；上一版把「唯一注入点」写到了 `quotaModel` 头上，
 * 而下半句又拿 `runtime.name` 当被否掉的替代方案点名，两句话互相矛盾，定向复评发现）。
 * 面板那一侧读的同样是 `GET /admin/api/capabilities` 的 `quota.model`，**不是 `runtime.name`**。
 *
 * ⚠️ **与 `POOL_CACHE_TTL_MS` 只在一点上同构，别读成「完全同构」**（定向复评）：
 * 同构的那一点是「这个值只在 KV 形态下要紧，而它不按运行时分叉」。
 * **在配置面上两者完全不同**：那个值走 `num()`、进 `DEFAULTS`、进 `ENV_LOCK_MAP`、
 * 进 `config-validate`，因此出现在 `GET /admin/api/config` 的四元组里；
 * 而 `USAGE_FLUSH_INTERVAL_MS` **一个都没进**，全仓只在 `src/http/wire.ts` 裸读一次。
 * 那个取舍与它的代价记在下面「为什么它不走 config-provenance」那一段。
 *
 * ⚠️ **「默认值相同」说的就只是默认值，不是「两边行为一个字节都不差」**
 *（定向复评，上一版那句是假的，而且**被同一个提交里自己写的用例正面证伪**——
 * 「budgetPerDay 真的接到了 sink 上」那一格断言的正是 20 vs 13）：
 * 没设这个环境变量时，两种形态的**落盘间隔**逐字相同（`USAGE_FLUSH_MIN_INTERVAL_MS`），
 * 但**预算那道闸本来就只有「有写配额」的一侧才有** —— 同样 20 个待落盘的日、
 * 同样一次 flush，文件存储写 20 个键、KV 写 13 个。
 * **那不是分叉，那就是这个设计本身**：闸是为写配额存在的，没有配额的一侧没有它可守。
 * 分叉的判据是**存储能力**（`quotaModel`），不是运行时；而「不做运行时嗅探」这条
 * 由此被遵守——`.env.example` 里那句只说「默认值相同」，照它的口径来。
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
 *
 * ── 为什么它不走 config-provenance（定向复评要求把这个决定和代价写下来）──────────
 * `USAGE_FLUSH_INTERVAL_MS` **只从环境变量读，一个字都不从存储读**，因此它
 * 不进 `GatewayConfig`、不进 `FIELD_EXPOSURE`、不进 `ENV_LOCK_MAP`、不进 `EDITABLE`，
 * 也就不出现在 `GET /admin/api/config` 的四元组里。**判据沿用上一轮 U-C 那一整节，
 * 结论相反，因为前提不同**：
 * · `usageStatsEnabled` 进 `ENV_LOCK_MAP` 的理由是**它存储里就能改** ⇒ 不进表的话
 *   四元组会自相矛盾（`stored: true` / `env: null` / `effective: false`），那是撒谎；
 * · 这一个**存储里根本改不了** ⇒ **没有 `stored` 这一格可以撒谎**，
 *   四元组不存在，也就不存在「面板改了不生效」这个形态。
 *   与 `ADMIN_TOKEN` / `TRUST_PROXY` / `RESET_CONFIG` 同一类：env-only，不进配置面。
 *
 * **代价，明写两条**：
 * ① 运维在面板上**看不到**这个旋钮当前是多少——缓解是 `GET /admin/api/capabilities`
 *    的 `stats.flushIntervalMs` 报的就是**生效值**（面板据它算「尾巴最长多久」），
 *    所以「现在生效的是几」在面板上答得出来，只是不在设置页那张表里；
 * ② 哪天有人想让它可存储 / 可编辑，**必须同时补齐 `ENV_LOCK_MAP` 那一行**，
 *    否则立刻掉进上面第一条描述的那个四元组撒谎形态。这句话没有机器守着，
 *    只能靠评审——**所以它写在这里，不写在报告里**。
 */
export function resolveUsageFlushInterval(
  raw: string | undefined,
  hasWriteQuota: boolean,
): { flushIntervalMs: number; budgetPerDay: number | null } {
  const budgetPerDay = hasWriteQuota ? USAGE_WRITES_PER_DAY : null;
  // ⚠️ **空串与「没设」同等对待**（定向复评）。理由**不是**「迁就一个坏值」，
  // 而是与 `.env.example` 其余 9 个留空项的既有约定一致：那份文件是给
  // `cp .env.example .env` + `env_file:` 直接用的，一个留空的键会以**空字符串**
  // （不是 unset）进到环境里，而本仓其余每一个留空项都容忍它。
  // 少了这一行，`USAGE_FLUSH_INTERVAL_MS=` 会走进下面的 `Number("") = 0` 而抛，
  // **全新的 Docker 部署直接起不来**——那是本仓唯一一个被喂给严格整数校验器的空值项。
  if (raw === undefined || raw === "") {
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
 *（那条「关必须是零成本」的全局约束）。它与「sink 存在但没到落盘间隔」是**两件事**：
 * 后者仍然在内存里累加，只是不写盘。
 */
export function recordUsage(deps: UsageRecording, u: UsageOutcome): void {
  if (deps.usageSink === undefined) return;
  deps.usageSink.record(u);
}

/**
 * Tier-2 的内存累加器 + 落盘。
 *
 * ⚠️ **落盘由中间件在请求收尾 `await`，不是 `ctx.waitUntil`、不是定时器**（订正）。
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
 * ⚠️ **预算 `consume()` 每写一个键调一次，不是每次 flush 调一次**（评审发现）。
 * 一次 flush 通常只写 1 个键（间隔 2 小时 < 一天），跨 UTC 零点那一次写 2 个。
 * 数 flush 的话那一次会少扣一格，而配额账是按 put 算的。
 *
 * ⚠️ **`canWrite` 的第三个参数必须显式传。**
 * 它的默认值是事件板块的 `EVENT_WRITES_PER_DAY`（12），漏传**不会有类型错误、
 * 不会有任何编译期信号**，预算却静默按 12 计——而 12 恰好是评审判定为
 * 「每 24 小时恰好有一次 put 被预算拒绝」的那个值
 *（`src/core/admin/usage-stats.ts` 的 `USAGE_WRITES_PER_DAY` 说明写着这条缝的全文）。
 *
 * 本文件有**两处**调用点，**各自被一格钉着**（评审发现：上一版只钉住了 `maybeFlush`
 * 那一处，`status()` 那一处改成漏传之后 `tsc` 通过、全量 2172 格全绿完全逃逸，
 * 而它的后果是面板上的「预算耗尽」提前一格变成一句假话——那条全局约束的原话正是
 * 「诚实标记由后端字段驱动」）：
 * · `maybeFlush()` ⇒ 「预算按 13 计而不是事件板块的 12 —— 一次 flush 面对 20 个待落盘的日时……」；
 * · `status()`     ⇒ 「status() 的三个字段：budgetExhausted 在第 13 次 put 之后才翻真……」。
 *   **后者的判别状态是「已用 12 格」**：那一刻两种实现分叉（13 说还能写、12 说已耗尽），
 *   而在「已用 13 格」上两者都说耗尽 ⇒ 只测 13 是测不出来的（第 5 种假阳性）。
 *
 * ⚠️ **构造时 `lastFlushAt = now()` 而不是 null**，照抄 `StoreLogger` 那条评审结论：
 * 判到 `null` 就跳过间隔检查 ⇒ 每次 isolate 冷启动送一次零门槛写。
 * 代价（未落盘的尾巴最长一个间隔）已经算进配额账，
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
  /**
   * UTC 日序号 → 这一天被 `record()` 改过多少次。**只用来判「我发起写的那一刻之后，
   * 有没有新的增量进来」**（定向复评），不参与任何计数。
   *
   * ⚠️ **为什么非有它不可**：`maybeFlush()` 在 `await put` 上挂起期间，`record()`
   * 照样在跑（同一个 isolate 里的另一个并发请求）。挂起之前那道间隔闸只挡得住
   * **flush 与 flush** 的重叠，**挡不住 record 与 flush 的重叠** —— 而后者会让
   * `await` 之后那句 `dirty.delete(day)` 把**这期间新到的增量**的脏标记一起清掉：
   * 那条计数从此既不在已落盘的分片里、也不会被下一轮补上，**永久消失**，
   * 而 `status()` 会报 `pending: 0`（「没有未落盘的尾巴」）。
   * 由 `tests/contract/usage-tier2.test.ts` 的
   * 「落盘挂起期间到达的那一条计数不许丢……」钉着。
   *
   * ⚠️ **上界与 `days` 完全相同，一并写在这里免得两种待遇**（收口复评 LOW-1）：
   * 它与 `days` 同一个键空间、同样从不清理 ⇒ **上界是这个 isolate 的存活天数**
   *（Worker 上分钟级、至多一两个键；Node 上跑满一年 365 个数）。
   * 每格只是一个数字，比 `days` 那边的一份累加器还便宜得多。
   */
  private readonly version = new Map<number, number>();
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

  /**
   * 读侧（`GET /admin/api/usage`）要用的那个存储。**交出去的就是自己落盘用的那一个实例。**
   *
   * ⚠️ **它存在的理由是让「读的和写的是同一份存储」变成结构性的**，而不是靠装配
   * 时记得传对；外加 `createApp` 手上根本没有 `Storage` 可传。
   * ⚠️⚠️ **不是「否则会读到空」** —— 上一版这么写过，而那句话被实测证伪（评审发现）：
   * `WatchedStorage` 的 `get`/`list` 是直通的。**订正全文只在一处**，在
   * `src/http/admin/handlers/usage.ts` 的 `UsageWiring` 上方，
   * 这里不复述——同一段推理抄三份，改的时候必然只改一份，本条正是那么坏掉的。
   * 消费者同样见那里。
   *
   * **只读、不代理**：这里刻意不包一层「只允许读 `usage:` 前缀」的门面。那层门面
   * 挡不住任何真实的误用（读侧本来就只按 `usageDayKey()` 算出来的键读），
   * 却会让「读的和写的是同一个实例」这条性质多一层需要自己被验证的中间物。
   */
  get storage(): Storage {
    return this.o.storage;
  }

  constructor(private readonly o: {
    storage: Storage;
    now: () => number;
    shardId: string;
    /**
     * sink 自身故障绝不许拖垮响应；出错走这里（通常是 ConsoleLogger）。
     *
     * ⚠️⚠️ **第二个参数 `phase` 不是装饰，它决定这条错误该对运维说什么，
     * 而两句话的意思是相反的**（认账修正）。两句原文、它们为什么必须
     * 分家、以及**这条 record 通道今天到底可不可达**，全文在 `USAGE_ERROR_REPORT`
     * 上方——**别在这里复述，同一段推理抄两份改的时候必然只改一份。**
     */
    onError: (err: unknown, phase: UsagePhase) => void;
    /** 见 `intervalMs`。缺省 = 后端常量。 */
    flushIntervalMs?: number;
    /** 见 `budgetPerDay`。**缺省 = `USAGE_WRITES_PER_DAY`，即「有写配额」那一侧的行为**。 */
    budgetPerDay?: number | null;
  }) {
    this.slot = usageSlotOf(o.shardId);
    this.lastFlushAt = o.now();
    this.intervalMs = o.flushIntervalMs ?? USAGE_FLUSH_MIN_INTERVAL_MS;
    // ⚠️ **判据必须是 `=== undefined`，不能写成 `??`**（定向复评：上一版这句注释
    // 写的是「`??` 而不是 `||`」，而代码用的正是 `=== undefined`——**照那句注释的字面
    // 去改就会踩雷**：`null` 在 `??` 下会被下坠成默认值，而 `null` 恰恰是一个有意义的
    // 取值（「没有闸」，给没有写配额的存储）。三者要分清：`||` 连 `0` 都吃掉，
    // `??` 吃掉 `null`，只有 `=== undefined` 恰好只认「没传」。）
    this.budgetPerDay = o.budgetPerDay === undefined ? USAGE_WRITES_PER_DAY : o.budgetPerDay;
  }

  /**
   * 记一次终态。**永不抛**（收口复评）。
   *
   * ⚠️ **兜底放在这里，而不是放在四条路由上**：路由那一侧的表达式在
   * `recordUsage()` 的「sink 缺席就 return」**之前**求值 ⇒ 放在那里的任何一行
   * 都会在**Tier-2 关着**时照样跑，一次抛就把「关是零成本」（全局约束 16）打破。
   * 本方法只有开着才被调到。
   *
   * ⚠️ **`try` 的边界是有讲究的，不是把整个方法包起来了事**：
   * **可能抛的每一步都排在任何一次写入 `acc` 之前**。反过来的话，一次抛会留下
   * 「`total` 加了而 `byModel` 没加」的半截状态 ⇒ 落盘的分片自己和自己对不上，
   * 正是并发那半刚消灭掉的失效形态。**这条顺序约束今天仍然照办，往后加任何一步
   * 都要先问它会不会抛。**
   *
   * ⚠️⚠️ **上一版这里写的是「唯一可能抛的一步是 `boundUsageKey`」，那句话今天已经是假的
   * ——订正如下（评审发现）**：`boundUsageKey` 现在走
   * `src/core/admin/usage-stats.ts` 里的 `safeString()`，**它自己不抛**
   *（实测：拿 `JSON.parse('{"toString":1,"valueOf":1}')` 当 `model` 走真装配打一次
   * `/v1/chat/completions`，`onError` 一次都没被调到）。
   * **今天这个 `try` 里唯一还够得着的抛点是 `this.o.now()`（注入的时钟）**，
   * 而它同样排在所有写入之前，所以上面那条顺序约束的结论不变。
   * 完整的可达性论证与它对 `onError` 两条通道的意义，见 `USAGE_ERROR_REPORT` 上方。
   * ⭐ **这条订正本身就是 `usage-stats.ts` 的 `boundUsageKey` 上方那句教训的复发**
   *（「加一处 try/catch 会改变别处注释的真假 —— 加完要回头查谁在依赖那个前提」）：
   * 同一期、同一个文件里又犯了一次，而且是**新写的块推翻了它自己指过去的那一段**。
   */
  record(u: UsageOutcome): void {
    try {
      const at = this.o.now();
      const day = usageDayIndex(at);
      const hour = usageHourOf(at);
      const acc = this.days.get(day) ?? emptyDay();
      // ★ **模型名是客户端随便填的**，收进上界再当键用（评审发现）。
      // **这一步排在所有写入之前**，理由见上面那段。
      // `byProtocol` 刻意不收：它的值是四条路由里的字面量，外部碰不到。
      const modelKey = boundUsageKey(acc.byModel, u.model);
      const arg = {
        ok: u.ok, stream: u.stream, latencyMs: u.latencyMs,
        tokensIn: u.tokensIn, tokensOut: u.tokensOut,
      };
      acc.total = addToBucket(acc.total, arg);
      acc.hours[hour] = addToBucket(acc.hours[hour] ?? emptyBucket(), arg);
      acc.byModel[modelKey] = addToBucket(acc.byModel[modelKey] ?? emptyBucket(), arg);
      acc.byProtocol[u.protocol] = addToBucket(acc.byProtocol[u.protocol] ?? emptyBucket(), arg);
      this.days.set(day, acc);
      this.dirty.add(day);
      this.version.set(day, (this.version.get(day) ?? 0) + 1);
      this.pending++;
    } catch (err) {
      // 统计是旁路，绝不影响响应。**说一声，不静默吞掉。**
      // ★ `"record"`：这一条计数**永久丢了**，不会被下一次落盘补上（见 `onError`
      //   的说明）。共用 flush 那条事件等于对运维说一句假的承诺。
      this.o.onError(err, "record");
    }
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
   *（本任务变异实测，**入参一并记下，否则复现不出来**：在**补上下面那格「空转」用例
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
   * ── 可重入（评审发现）───────────────────────────────────────────────
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
    // ★ **在任何 `await` 之前就把闸关上**（评审发现）。到这一行为止全都是同步代码，
    // 所以后来的并发 **flush** 一定会在上面那道间隔闸前掉头，不会与本次重叠。
    // ⚠️ **它只挡 flush 与 flush，挡不住 `record()` 与 flush 的重叠**（定向复评）——
    // 那一半由循环体里的「快照 + 版本比对」负责，两者合起来才是完整的。
    this.lastFlushAt = at;

    // 从最早的那天开始写：预算不够时先落旧的，新的那天下一轮还有机会。
    for (const day of [...this.dirty].sort((a, b) => a - b)) {
      // ★ 每写一个键之前各查一次预算，**每写成功一个各扣一格**（评审发现）。
      if (this.budgetPerDay !== null && !canWrite(this.budget, at, this.budgetPerDay)) break;
      const acc = this.days.get(day);
      if (!acc) { this.dirty.delete(day); continue; }
      // ★ **发起写之前先取一份快照**（定向复评）。
      // 三个 record 都要浅拷：`record()` 往它们里面**赋新键**（`acc.hours[h] = …`），
      // 而 `acc.total` 是整体重新赋值的。不拷的话，`await` 期间到达的那一条会
      // **只蹭进 `hours`/`byModel`/`byProtocol` 而不进 `total`**
      //（KV 那边 `JSON.stringify` 在 await 前同步求值，则是干脆整条丢掉）
      // ⇒ 落下去的分片**自己和自己对不上**：`total.requests = 1` 而
      // `byProtocol.openai.requests = 2`。
      // **浅拷就够**：桶对象本身从不被原地改（`addToBucket` 是纯函数，每次返回新对象），
      // 变的只是这三个 map 里的引用。
      const version = this.version.get(day) ?? 0;
      const shard: UsageDayShard = {
        shardId: this.o.shardId, day, updatedAt: at,
        total: acc.total,
        hours: { ...acc.hours }, byModel: { ...acc.byModel }, byProtocol: { ...acc.byProtocol },
      };
      // ★ 预算同样**在发起写之前**扣，理由同上（失败不回滚）。
      this.budget = consume(this.budget, at);
      try {
        await this.o.storage.put(usageDayKey(day, this.slot), shard, usageExpiresAt(day));
      } catch (err) {
        // **不清这一天的累加器、也不从 dirty 里移除**：写失败时清掉等于把这一段计数
        // 永久丢了，而下一次落盘本来能带上它。**后面那些天也不再试**——同一个存储
        // 大概率一起失败，继续试只是白烧预算。
        this.o.onError(err, "flush");
        break;
      }
      // ★ **只清「我发起写的那一刻的那个版本」**（定向复评）：`await` 期间若有
      // 新的 `record()` 落在同一天，版本号已经变了 ⇒ 这一天**继续留在 `dirty` 里**，
      // 下一轮把它整份重写一遍（那个键是覆写的，所以补一遍就是对的）。
      if ((this.version.get(day) ?? 0) === version) this.dirty.delete(day);
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
