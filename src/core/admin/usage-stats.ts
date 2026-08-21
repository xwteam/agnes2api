/**
 * Tier-2 时间序列统计（设计 §7.1，**默认关**）的纯数据层。
 *
 * ── 存储形态：保留设计的「日键 + 值里装 24 个小时槽」，只换掉有界性机制 ─────────
 *
 * 设计 §7.1 写的是 `stat:<YYYY-MM-DD>:<shardId>` + Cron 压实成 `stat:<date>` + **删掉分片**。
 * **压实那一半必须换掉**：它正是事件分片第一版被评审 C5 推翻的形态
 * （`src/ports/storage.ts:7-10` 与 `src/adapters/logger-store.ts:31-35` 记着推翻的理由：
 * ⚠️ 后者**不是文件头**——`logger-store.ts` 第 1 行就是 `import`，那段话在 `StoreLogger`
 * 的类说明块里；本仓自己区分这两者，`logger-store.ts:35` 的原话就是「详见
 * `src/core/admin/event-ring.ts` 文件头」。
 * 有界性依赖「落盘节奏恰好规律」这个前提，稀疏落盘或多 isolate 各写各的随机分片时
 * **清理率能跌到 0**）；而 Cron 压实还额外依赖「Cron 按表达式可靠触发」，
 * 设计 §17 U4 自己已经核实过**官方没有文档化任何触发保证**。两个前提叠在一起，没有一端立得住。
 * ⇒ 有界性改用 `Storage.put` 的 `expiresAt`（TTL）：它是**存储自己的性质**，
 * 与落盘节奏、槽位选择、isolate 会不会被回收全部无关。**不做压实、不 delete。**
 *
 * **但「日键 + 值里装小时槽」这一半必须保留，第一版把它一起换掉是过度类比**（评审 C1）：
 * 事件与用量有一处决定性差异 ——
 * **事件分片的值是「这一小时里发生的那些条目」，日历上互不重叠，所以必须按小时分键；
 * 而用量的值是「累计计数」，一次写就能把当天全部 24 个小时槽一起覆盖掉。**
 * 按小时分键的代价算过：2 小时落盘间隔下每次 flush 恒写 2–3 个键（而预算只扣 1 格），
 * 真实写量 192–288/天、最坏一行 944–1040，而 `docs/zh-CN/DEPLOY.md:155` 自己管 1,040 叫
 * 「已经打穿写配额」；读 30 天要 `720 × 2 = 1440` 次 get。
 * **换回日键之后这两条同时消失：一次落盘恒 1 个 put（跨 UTC 零点那次 2 个），
 * 读 30 天 `30 × 2 = 60` 次 get。**
 *
 * ⇒ **一句话记住这个形状为什么长这样：写路径按「天」分键所以便宜，
 * 读路径按「天」取键所以扇出小，而「小时」这一维住在值里面、不额外花键。**
 *
 * ── 零 IO ──────────────────────────────────────────────────────────────
 * 纯数据 + 纯函数，时间一律从参数进。落盘由 Task 3 的 `UsageSink` 负责，
 * **那个文件今天还不存在，所以这里刻意不写它的路径**——第 12 道门禁校验的是
 * 「注释里的仓内路径必须解析得开」，一条指向未来文件的引用会让它红（本任务实测过一次）。
 *
 * ⚠️ **本文件不接线，也不许预先埋任何会被接上写的累加路径**（全局约束 16：
 * Tier-2 的默认值是关，且「关」必须是零成本——关闭时一次存储访问都不许有、
 * 一个内存累加器都不许建）。这里全部是「状态进、状态出」的纯函数，
 * **一个模块级可变状态都没有**。
 */
import { type WriteBudget, FRESH_BUDGET, canWrite, consume } from "./event-ring.js";

/**
 * 预算实现从事件板块**复用**，不再写一份（两份预算实现迟早会分叉）。
 *
 * ⚠️ **`canWrite` 的第三个参数 `perDay` 有默认值，而那个默认值是
 * `EVENT_WRITES_PER_DAY`（12）、不是 `USAGE_WRITES_PER_DAY`（13）**
 * （`src/core/admin/event-ring.ts:294`）。Task 3 调它的时候**必须把
 * `USAGE_WRITES_PER_DAY` 显式传进去**：漏传**不会有类型错误、不会有任何编译期信号**，
 * 它会静默按 12 计——而 12 恰好就是评审 R3-I1 判定为「每 24 小时恰好有一次 put
 * 被预算拒绝」的那个值。**缺陷会从一个默认参数悄悄回来，而两边的常量各自都还是对的。**
 * 由 `tests/unit/admin/usage-stats.test.ts` 的
 * 「canWrite 的默认 perDay 是事件板块的 12，不是用量的 13」那一格钉着。
 */
export { type WriteBudget, FRESH_BUDGET, canWrite, consume };

/** 一个桶。**没有原始延迟数组**：只存和与次数，均值现算（设计 §7.1「明确放弃」P95）。 */
export interface UsageBucket {
  requests: number; success: number; errors: number;
  /** **只有非流式、且协议路由传了 `expectJson` 的那三条**才有 token（订正 F1）。 */
  tokensIn: number; tokensOut: number;
  /** 流式请求单列一栏，让 token 的缺口可见（设计 §7.1「`streamingRequests` 单列一栏」）。 */
  streamingRequests: number;
  /**
   * ⚠️ **只累计成功请求的延迟**（评审 I12）。
   * 第一版的注释写「延迟只统计有意义的那些：请求真的完成了才有延迟可言」，
   * **而代码对失败请求同样 `+1`** —— 注释与代码互相矛盾，两边都没有用例，
   * 而第 12 道门禁看不见这类矛盾（V24：规则 B 查的是指向存不存在，不是那句话真不真）。
   * 后果不是措辞问题：一个 8 秒超时和一个 30 毫秒的 401 都会进平均延迟，
   * 面板上那个「平均延迟」就不是任何真实的东西。
   * ⇒ **裁定：只有 `ok` 的请求进 `latencySum` / `latencyCount`。**
   * 失败请求的耗时由「错误率」那张卡负责，不掺进延迟。
   */
  latencySum: number; latencyCount: number;
}

export function emptyBucket(): UsageBucket {
  return {
    requests: 0, success: 0, errors: 0, tokensIn: 0, tokensOut: 0,
    streamingRequests: 0, latencySum: 0, latencyCount: 0,
  };
}

/**
 * 一个 isolate 在某一个 UTC 日里攒下的全部计数。**一次落盘就是把这整份覆写进一个键。**
 *
 * `hours` 的键是 `"00"`…`"23"`（UTC 小时，两位补零，与设计 §7.1 的
 * `hours: { "00": Bucket, … "23": Bucket }` 逐字相同），
 * 让面板的单日下钻（设计 §10.6「这一天按小时 / 按模型 / 按协议的分解」）不必额外读键。
 */
export interface UsageDayShard {
  /** 写它的那个 isolate/进程。面板用它显示「这一天有几个分片贡献了数据」。 */
  shardId: string;
  /**
   * UTC 日序号（`floor(at / 86400000)`），**不是设计 §7.1 里那个日期字符串**：
   * 整数比对不会有时区歧义，也不必在读路径上反复解析 `YYYY-MM-DD`。
   */
  day: number;
  updatedAt: number;
  total: UsageBucket;
  hours: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  byProtocol: Record<string, UsageBucket>;
}

export const USAGE_DAY_MS = 86_400_000;

/**
 * 槽位数。**取 2，与 `EVENT_SLOTS` 相同**：它是「同一天里最多几个 isolate 能各写各的
 * 而不互相覆盖」。取大了读扇出线性变大，取小了并发 isolate 会互相覆盖。
 * ⚠️ **这不是「不会丢计数」的保证**：超过 2 个 isolate 时同槽位仍是 last-write-wins。
 * 这正是 Tier-2 全程要打 `≈` 的原因之一（设计 §14 第 2 条：
 * 「Tier-1 并发下少计、Tier-2 丢最后一个未落盘窗口……全部带 `≈` 标注」）。
 */
export const USAGE_SLOTS = 2;

/**
 * 保留 30 天，正好覆盖设计 §10.6 时间范围按钮组（`24h / 3d / 7d / 30d`）的最长一档
 * （订正 F12）。
 *
 * ⚠️ **它同时决定读扇出的硬上界 `USAGE_DAY_RETAIN × USAGE_SLOTS` = 60 次 get**
 * （见 `usageCandidateKeys`）。U-H 查过 Cloudflare 官方 limits 页，**结论不是一个干净
 * 的数，照实记在这里**：Workers 的 limits 页把子请求分成两行——
 * 「Subrequests per invocation」免费档 50、「Subrequests to internal services」免费档 1,000
 * ——**而那一页从头到尾没有定义什么叫「internal services」，也没有说 KV 绑定调用算哪一行**；
 * KV 自己的 limits 页则单独写着「Operations/Worker invocation: 1,000」（免费档与付费档相同）。
 * ⇒ 按 KV 那一页的数，60 次 get 占 6%，宽裕得很；按 50 那一行读，60 就是超的。
 * **两页对不上 ⇒ 按本仓对 U-B / 设计 §17 U4 同一套纪律处置：当作「没有平台承诺」，不臆测。**
 * 实际影响只有一条：`30d` 那一档在 Worker 上可能与 Node 表现不同 ⇒ 由 Task 4 的逐块
 * try/catch 接住，面板显示 `—` 而不是半份数据。
 *
 * ⚠️ **不许拿事件板块的 48 次冷读当佐证**（那个 48 在 `docs/zh-CN/DEPLOY.md:159`，
 * 「每点一次筛选就是一次满额冷读」在 `docs/zh-CN/DEPLOY.md:172`——**两行合起来才是那句话**，
 * 单独任何一行都不承载它；今天在生产上跑着）：
 * **48 在上面两种读法下都合规**，所以它对「60 行不行」这个问题一个字都没有说。
 */
export const USAGE_DAY_RETAIN = 30;

/**
 * 每个 isolate 每天最多写几次。**这个数数的是 `put` 次数，不是 flush 次数**（评审 C1）。
 *
 * 第一版的不变量数的是 flush 次数，而当时的键形状让一次 flush 写 2–3 个键
 * ⇒ 真实写量是它算出来的 2–3 倍，而不变量照样绿。
 * 换成日键之后一次 flush 恒 1 个 put（跨 UTC 零点那一次 2 个），
 * **但预算仍然按 put 计（`consume()` 每写一个键调一次）**——
 * 键的形状将来可能再变，而「预算数的是真正落下去的写」这条不该跟着变。
 *
 * ⚠️ **13 = 12 次落盘 + 1**。那个 `+1` 不是余量，是**跨 UTC 零点的那一次落盘要写两个键**
 * （前一天一个、当天一个）。第一版取 12，于是每 24 小时恰好有一次 put 被预算拒绝
 * ——**数据不丢**（那天的 `dirty` 不清，下一轮补上），**但「尾巴 ≤2 小时」这句对外承诺变假**
 * （那一次的尾巴是 ≤4 小时）。评审 R3-I1 用 3 天仿真确认它是确定性发生的，不是边角。
 *
 * 取 13 的判据、与设计原值 300s 的正面权衡、以及重算后的配额账，全文在计划的
 * 「§配额账 → 落盘间隔取值」一节。**别在这里重复那段推理，也别只改这一个数**：
 * 它与 `USAGE_FLUSH_MIN_INTERVAL_MS` 由下面那组不变量绑着。
 */
export const USAGE_WRITES_PER_DAY = 13;

/**
 * 落盘最小间隔 = 2 小时。
 *
 * ⚠️ **它不是「越小越好」，它与 `USAGE_WRITES_PER_DAY` 是一条乘法关系**：
 * 要让一整天都被覆盖，必须 **`间隔 × (预算 − 1) >= 一天`** ——
 * 那个 `−1` 是跨 UTC 零点那次落盘要写两个键（见 `USAGE_WRITES_PER_DAY`）。
 * 预算由写配额定死（13），于是间隔没有自由度：`86_400_000 / 12 = 7_200_000`，
 * **两边恰好相等，没有余量，这是刻意的**：再省一格就要付出「尾巴变长」的代价。
 * **设计原值 300s 对应的预算是 288，`× M=8` = 2,304 次/天 = 免费档的 230%**，
 * 不可行；而保留 300s 却把预算压到 12 的话，**每天只有头 60 分钟被覆盖，之后整天不写**
 * ——写量合格而数据从中午起就是假的，比第一种更糟。三种取值的对照表在计划的 §配额账。
 *
 * **代价（一条，不是两条）**：未落盘的尾巴最长等于这个间隔。它的两种表现是
 * 同一个事实：① 面板上「今天」的数字最多旧 2 小时；
 * ② 存活不足一个间隔的实例（Worker 短命 isolate、Docker 快速重启）攒的计数随实例消失。
 * ⚠️ **②不是「默认关」的独立理由**——第一版这么写过，那是循环论证：
 * 「活不满一个落盘间隔的实例存不下」在 `lastFlushAt = now()` 下恒真，
 * 而让它变严重的正是这个间隔取值本身，那是本计划自己选的。
 * 默认关的理由只有设计写的那一条（§7.1）：
 * 「统计吃掉写配额会连带打死 key 池的状态回写」。
 *
 * 运维可经 `USAGE_FLUSH_INTERVAL_MS` 覆盖它（设计 §7.1 自己就给了这个环境变量名）。
 * **FileStorage 没有写配额**（设计 §2.5：「Node 侧没有配额，但有**吞吐**问题」），
 * 所以 Docker 部署者调回 300s 是合理的。
 * ⚠️ **这不是运行时嗅探**：默认值两种运行时相同，改不改由运维按自己的存储后端定，
 * 与 `POOL_CACHE_TTL_MS` 完全同构（那个值同样只在 KV 形态下要紧，`.env.example:30`
 * 那一行的小节标题逐字写着「Cloudflare Worker + KV 免费档才需要关心」，
 * 而它也不按运行时分叉）。
 * 设计 §7.1「默认在两种运行时相同……不做运行时嗅探」这一句因此**被遵守，不是被绕过**。
 */
export const USAGE_FLUSH_MIN_INTERVAL_MS = 7_200_000;

export function usageDayIndex(at: number): number {
  return Math.floor(at / USAGE_DAY_MS);
}

/** UTC 小时，两位补零。日键用 UTC 是设计 §7.1 末条：agnes 的 Worker 是多 colo 的。 */
export function usageHourOf(at: number): string {
  const h = Math.floor((at - usageDayIndex(at) * USAGE_DAY_MS) / 3_600_000);
  return String(h).padStart(2, "0");
}

/**
 * 与 `slotOf` 同一套（算法逐字相同，只把 `EVENT_SLOTS` 换成 `USAGE_SLOTS`）：
 * 由 shardId 稳定地散到一个槽位。
 *
 * ⚠️ **「构造时算一次、终生不变」是对 Task 3 的 `UsageSink` 的要求，不是本函数的性质**
 * ——本函数是纯函数，谁调都一样；**今天没有任何东西能证实或证伪那句话**（评审登记）。
 * Task 3 必须自己有一格钉住它。
 *
 * 散布性本身由 `tests/unit/admin/usage-stats.test.ts` 的
 * 「usageSlotOf 真的把不同 shardId 散到不同槽位」钉着——**这一格不许只用 `"s1"` 当样本**，
 * `usageSlotOf("s1")` 恰好是 0，写死成 `return 0` 时它不可观测（评审 I-2 实测 ESCAPED）。
 */
export function usageSlotOf(shardId: string): number {
  let h = 0;
  for (let i = 0; i < shardId.length; i++) h = (h * 31 + shardId.charCodeAt(i)) | 0;
  return ((h % USAGE_SLOTS) + USAGE_SLOTS) % USAGE_SLOTS;
}

export function usageDayKey(day: number, slot: number): string {
  return `usage:${day}:${slot}`;
}

/** TTL 留一个整天的余量盖掉时钟偏差，与 `EVENT_TTL_MARGIN_MS` 同一条理由。 */
export const USAGE_TTL_MARGIN_MS = USAGE_DAY_MS;

export function usageExpiresAt(day: number): number {
  return (day + USAGE_DAY_RETAIN) * USAGE_DAY_MS + USAGE_TTL_MARGIN_MS;
}

/**
 * 读某个时间区间要取哪些键。
 *
 * **上界是这个函数自身的不变量，不是一句注释**：返回的键数恒
 * `<= USAGE_DAY_RETAIN × USAGE_SLOTS`（= 30 × 2 = 60），因为起点被
 * `USAGE_DAY_RETAIN` 夹住了——**比这更早的键即使还没过期也不读：上界优先于多读一天。**
 *
 * ⚠️ **夹逼的理由就是上面那条上界，不是「反正已经过期」**（评审 I-1，这里原来
 * 正是那么写的，而它被本文件上方 11 行的 `USAGE_TTL_MARGIN_MS` 直接证伪）：
 * TTL 刻意多留了一整天余量（`USAGE_TTL_MARGIN_MS = USAGE_DAY_MS`），
 * `usageExpiresAt(d)` 保留到第 `d + 31` 天零点，而 `oldestAllowed = 今天 − 30 + 1`
 * ⇒ **`今天 − 30` 那一天的键在任何时刻都还活着，却永远不会被这个函数取到。**
 * 三组 now 实测过，无一例外（`now` 落在第 100 天时它还剩整整 86_400_000 ms 才过期）。
 * **别照「反正过期了」去把那天加回来——那会直接打破 60 这条上界。**
 * 由 `tests/unit/admin/usage-stats.test.ts` 的
 * 「区间给一年也不会超过保留期 × 槽位数」钉着。
 */
export function usageCandidateKeys(nowMs: number, fromMs: number, toMs: number): string[] {
  const newest = usageDayIndex(Math.min(toMs, nowMs));
  const oldestAllowed = usageDayIndex(nowMs) - USAGE_DAY_RETAIN + 1;
  const oldest = Math.max(usageDayIndex(fromMs), oldestAllowed);
  const keys: string[] = [];
  for (let d = oldest; d <= newest; d++) {
    for (let s = 0; s < USAGE_SLOTS; s++) keys.push(usageDayKey(d, s));
  }
  return keys;
}

/**
 * 一次终态往桶里加。**纯函数、不改入参**，与 `withOutcome` 同一套语义。
 *
 * ⚠️ **延迟只在 `ok` 时累计**（评审 I12）：见 `UsageBucket.latencySum` 的说明。
 */
export function addToBucket(b: UsageBucket, o: {
  ok: boolean; stream: boolean; latencyMs: number;
  tokensIn: number; tokensOut: number;
}): UsageBucket {
  return {
    requests: b.requests + 1,
    success: b.success + (o.ok ? 1 : 0),
    errors: b.errors + (o.ok ? 0 : 1),
    tokensIn: b.tokensIn + o.tokensIn,
    tokensOut: b.tokensOut + o.tokensOut,
    streamingRequests: b.streamingRequests + (o.stream ? 1 : 0),
    latencySum: b.latencySum + (o.ok ? o.latencyMs : 0),
    latencyCount: b.latencyCount + (o.ok ? 1 : 0),
  };
}

function addBuckets(a: UsageBucket, b: UsageBucket): UsageBucket {
  return {
    requests: a.requests + b.requests, success: a.success + b.success, errors: a.errors + b.errors,
    tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut,
    streamingRequests: a.streamingRequests + b.streamingRequests,
    latencySum: a.latencySum + b.latencySum, latencyCount: a.latencyCount + b.latencyCount,
  };
}

/**
 * 把读回来的若干个日分片合并成一份。
 *
 * ⚠️ **入参是 `unknown[]` 不是 `UsageDayShard[]`，且逐条窄化。**
 * 真实输入来自 `storage.get`（`JSON.parse` 的结果），运行期什么形状都可能是——
 * P3c Task 1 的 W2 穷举过畸形事件条目（
 * `docs/design/2026-08-20-agnes2api-p3c-write-ops-plan.md:238`
 * 那张表五行），其中三行让端点 **500**、两行**原样进了响应体并让游标永远推不动**。
 * 写成 `UsageDayShard[]` 就是在签名上撒谎。
 * **返回值里的 `malformed` 是给面板看的**：静默丢弃就是撒谎。
 *
 * ⚠️ **`hours` 是跨天求和的，调用方必须传单日区间**（评审 M-5，这是一条契约不是实现细节）：
 * 这个函数把每一个分片的 `hours` 无差别地加在一起，所以多日区间下 `hours["13"]`
 * 是**「区间里所有天的 13 点之和」**（一条 hour-of-day 剖面），**不是某一天的 13 点**。
 * 而设计 §10.6 要的是「**这一天**按小时 / 按模型 / 按协议的分解」。
 * ⇒ **单日下钻必须只把那一天的分片喂进来**；拿多日区间的返回值去画单日小时图是错的。
 * （`byDay` 不受影响，它按 `sh.day` 分了键。）
 */
export function mergeDayShards(raw: readonly unknown[]): {
  byDay: Record<string, UsageBucket>;
  hours: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  byProtocol: Record<string, UsageBucket>;
  total: UsageBucket;
  shards: number; malformed: number;
} {
  let total = emptyBucket();
  const byDay: Record<string, UsageBucket> = {};
  const hours: Record<string, UsageBucket> = {};
  const byModel: Record<string, UsageBucket> = {};
  const byProtocol: Record<string, UsageBucket> = {};
  let shards = 0; let malformed = 0;
  const merge = (into: Record<string, UsageBucket>, from: Record<string, UsageBucket>) => {
    for (const [k, v] of Object.entries(from)) into[k] = addBuckets(into[k] ?? emptyBucket(), v);
  };
  for (const item of raw) {
    const sh = narrowShard(item);
    if (sh === null) { if (item !== null && item !== undefined) malformed++; continue; }
    shards++;
    total = addBuckets(total, sh.total);
    byDay[String(sh.day)] = addBuckets(byDay[String(sh.day)] ?? emptyBucket(), sh.total);
    merge(hours, sh.hours); merge(byModel, sh.byModel); merge(byProtocol, sh.byProtocol);
  }
  return { byDay, hours, byModel, byProtocol, total, shards, malformed };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

/**
 * ⚠️ **数组要单独拒掉**（评审 M-4）：`typeof [] === "object"` 且 `[]` 是 truthy，
 * 只判 `typeof` 的话 `{ day: 5, total: [] }` 会拿到一个**全 0 的桶**、被 `narrowShard`
 * 判成**合法分片**记进 `shards`，而不是记进 `malformed`。
 * 那正好违反本文件 `mergeDayShards` 上方自己写的口径「静默丢弃就是撒谎」——
 * 一个畸形分片伪装成合法的，比被丢掉更糟：它还会把 `shards` 那个数一起变假。
 */
function narrowBucket(v: unknown): UsageBucket | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  return {
    requests: num(r.requests), success: num(r.success), errors: num(r.errors),
    tokensIn: num(r.tokensIn), tokensOut: num(r.tokensOut),
    streamingRequests: num(r.streamingRequests),
    latencySum: num(r.latencySum), latencyCount: num(r.latencyCount),
  };
}

function narrowRecord(v: unknown): Record<string, UsageBucket> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, UsageBucket> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const b = narrowBucket(val);
    if (b !== null) out[k] = b;
  }
  return out;
}

function narrowShard(v: unknown): UsageDayShard | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const total = narrowBucket(r.total);
  if (total === null) return null;
  if (typeof r.day !== "number" || !Number.isFinite(r.day)) return null;
  return {
    shardId: typeof r.shardId === "string" ? r.shardId : "",
    day: Math.trunc(r.day),
    updatedAt: num(r.updatedAt),
    total,
    hours: narrowRecord(r.hours),
    byModel: narrowRecord(r.byModel),
    byProtocol: narrowRecord(r.byProtocol),
  };
}
