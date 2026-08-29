/**
 * Tier-2 时间序列统计（设计 §7.1，**默认关**）的纯数据层。
 *
 * ── 存储形态：保留设计的「日键 + 值里装 24 个小时槽」，只换掉有界性机制 ─────────
 *
 * 设计 §7.1 写的是 `stat:<YYYY-MM-DD>:<shardId>` + Cron 压实成 `stat:<date>` + **删掉分片**。
 * **压实那一半必须换掉**：它正是事件分片第一版被评审 C5 推翻的形态
 * （`src/ports/storage.ts:7-10` 与 `src/adapters/logger-store.ts:31-35` 记着推翻的理由：
 * ⚠️ 后者**不是文件头**——`logger-store.ts` 的**首行就是 `import`**，那段话在 `StoreLogger`
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
 * **那个文件今天还不存在，所以这里刻意不写它的路径**——`scripts/check-comment-refs.mjs` 这道门禁校验的是
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
   * 而 `scripts/check-comment-refs.mjs` 这道门禁看不见这类矛盾（V24：规则 B 查的是指向存不存在，不是那句话真不真）。
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
 * ⇒ 按 KV 那一页的数 60 次占 6%；按 50 那一行读，**60 就是超的**。
 * **两页对不上 ⇒ 按本仓对 U-B / 设计 §17 U4 同一套纪律处置：当作「没有平台承诺」，不臆测。**
 *
 * ⚠️⚠️ **控制端已就此裁定（计划 §配额账「U-H 的裁定」）：这个 30 保留，
 * 而「60 次是安全的」这句话在任何注释或文档里都不许出现。**
 * 上面那句「占 6%」只是两种读法之一，**不是结论**。
 *
 * ⚠️ **真机实测（2026-08-29 北京时间，Node v24.15.0 + wrangler 4.123.0 起的本地 workerd）：
 * `30d` 那一档打过去，本次实测跑得完** —— 响应回的是 `tier: "tier2"`、`days` 恰好 30 段、
 * `range.clamped` 为 false、`note` 不是 `read_failed`（⇒ 那 60 次 get 真的发生过并且全部
 * 读回来了，不是在扇出之前就 return 了）。仪器与判据在 `scripts/smoke-dual-runtime.sh` 的
 * ④ 那一格，跑法是推送前复跑清单的第七格。
 * ⚠️⚠️ **「本次实测跑得完」不等于「安全」，这两句话的射程差着一整个平台**：
 * · 实测跑的是 `wrangler dev` 起的**本地** workerd，**它不是线上边缘**——本机没有任何
 *   观测面能证明本地 dev 会按线上那档配额去数子请求；
 * · 官方那两页文档的口径**今天仍然对不上**（50 那一行与 1,000 那一行，见上）。
 * ⇒ **U-H 只被了结了一半**：「代码路径跑不跑得完」有实测了，「线上免费档会不会超」
 * 仍然没有平台承诺，照旧按「没有承诺」处置，仍然不许把 60 写成安全的。
 *
 * 实际影响：`30d` 那一档在 Worker 上可能与 Node 表现不同 ⇒ **Task 4 让它失败得诚实**
 * ——读不出来按全局约束 9 显示 `—`，**不许 500、更不许把半份数据当成全份**。
 * 那一格是 `tests/contract/admin-usage.test.ts` 的
 * 「读 30 天时第 47 次 get 抛错：整条仍然是 200，days 是 null，绝不把读到的那 46 个当成全份」
 * ——**它验的是「失败得诚实」，一个字都没验「60 次会不会超」**，那仍然是线上才答得了的事。
 *
 * ⚠️ **不许拿事件板块的 48 次冷读当佐证**（那个 48 在
 * `docs/zh-CN/DEPLOY.md`「单次请求最多回看 24 个时间窗 × 2 个槽位 = **48** 次 get」，
 * 而「每点一次「级别」筛选按钮就是一次满额冷读」在同一份文档的
 * 「⚠️ **这个数是「稳态空闲界」，不是上界。**」那一段——**两处合起来才是那句话**，
 * 单独任何一处都不承载它；今天在生产上跑着）：
 * ⚠️ **指向订正**：上一版写的是 `:159` 与 `:172` 两个行号，**在 `451bb73` 上就已经
 * 指错了**（真实位置是 220 与 233 一带）——**不是本任务引入的，是既有欠账**，
 * 顺手改成名字锚，那种指向不会随文档增删行漂走。
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
 * **接线在 `src/http/usage-sink.ts` 的 `resolveUsageFlushInterval()`**，判据与代价
 * 全文在那里，这里只说结论：
 * · **没有写配额的存储**（FileStorage / Docker）：任意正整数放行，
 *   **并且不再设每天的写预算**——`USAGE_WRITES_PER_DAY` 那道闸是为写配额存在的，
 *   留着它的话调到 300s 的结果是「头 65 分钟写满 13 次、之后整天不写」，
 *   正是本注释上一段刚论证过的那个更糟的形态；
 * · **有写配额的存储**（KV / Worker）：预算恒为 `USAGE_WRITES_PER_DAY`，
 *   而间隔必须满足下面那条乘法关系，破了就**启动即抛**并给出最小可用值。
 *
 * ⚠️ **这不是运行时嗅探**：判据是**存储有没有写配额**（`RuntimeInfo` 的 `quotaModel`
 * 那一格——`RuntimeInfo` 是本仓双运行时差异的唯一注入点，`quotaModel` 是它里面的一格，
 * 不是说这个接口只有这一格），不是 `runtime.name`。
 *
 * ⚠️ **「相同」只到默认值为止，别写成「两边行为一个字节都不差」**（定向复评 F1，
 * 上一版这里就是那么写的，而它是假的）：没设这个环境变量时两边的**落盘间隔**逐字相同，
 * 但**预算那道闸本来就只有「有写配额」的一侧才有** —— 同样 20 个待落盘的日，
 * 文件存储一次写 20 个键、KV 写 13 个。**那不是分叉，那就是这个设计本身**：
 * 闸是为写配额存在的，没有配额的一侧没有它可守。
 *
 * 与 `POOL_CACHE_TTL_MS` **只在一点上同构**（定向复评 F7，上一版写的是「完全同构」）：
 * 「这个值只在 KV 形态下要紧、而它不按运行时分叉」这一点相同；
 * **配置面上完全不同** —— 那个走 `num()` / `DEFAULTS` / `ENV_LOCK_MAP` / `config-validate`
 * 并出现在 `GET /admin/api/config` 的四元组里，而这一个全仓只在 `src/http/wire.ts`
 * 裸读一次。（`.env.example:30` 那一行的小节标题逐字写着
 * 「Cloudflare Worker + KV 免费档才需要关心」。）
 * 设计 §7.1「默认在两种运行时相同……不做运行时嗅探」这一句因此**被遵守，不是被绕过**。
 *
 * ⚠️ **这一段有过一次「从假前提推出的论证」，如实记着**（P3d Task 3 评审 I1）：
 * 上一版在**旋钮还没接线**的时候就写着「运维可经 `USAGE_FLUSH_INTERVAL_MS` 覆盖它…
 * Docker 部署者调回 300s 是合理的」，而当时设了它不起任何作用，
 * 后面那整段「这不是运行时嗅探」的论证因此**建立在一个不成立的前提上**。
 * 裁定不是「把话改软」，是**把代码补成配得上这句话**——现在它真的接上了。
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

/**
 * Tier-2 用量键的前缀。**提成常量是为了让它可被扫到**：设计文档
 * `docs/design/2026-08-15-agnes2api-p3-admin-panel-design.md` 的
 * 「重置到底重置了什么」那张表逐存储键表态，而钉住那张表的两格里有一格是
 * **按名字扫源码**（`export const …_KEY / …_KEY_PREFIX = "字面量"`）。
 * 键名藏在模板串里的时候那一格扫不到它，于是「新增一个存储键而不进表」就没人拦。
 */
export const USAGE_KEY_PREFIX = "usage:";

export function usageDayKey(day: number, slot: number): string {
  return `${USAGE_KEY_PREFIX}${day}:${slot}`;
}

/**
 * `byModel` 的键最长多少个字符。**模型名由客户端在请求体里随便填**，不截断就是把
 * 一个无上界的字符串原样搬进要落盘的值里。
 *
 * ⚠️ **佐证要点名真正没有强转的那两条路由**（定向复评 N1：上一版这里举的是
 * `src/http/routes/openai.ts`，而**那恰好是唯一一条做了 `String(...)` 强转的**，
 * 等于把危害所在的另外两条挡在了视线外）。真正裸传的是
 * `src/http/routes/anthropic.ts` 与 `src/http/routes/responses.ts` 的 `req.model`：
 * 那个 `req` 来自 `src/http/errors.ts` 的 `c.req.json<T>()`，**泛型是纯编译期的，
 * 运行时零校验** ⇒ `{"model": 123}` 这种请求体在那两条路上会把一个 `number` 交到这里。
 *
 * ⚠️⚠️ **护栏只有这一道，就在本文件里；四条协议路由上都不许再加第二道**
 *（收口复评 H1 + M1，这是本任务最贵的一次教训）：
 * 上一版为了「冗余」在那两条路由的 `record` 闭包里各加了一个 `String(...)`，
 * 并在这里写下「少任何一道就等于多一条 500」。**那句话两个方向都被实测证伪**：
 * `{"model":123}` 打 `/v1/messages`，三种组合（都在 / 只去路由那道 / 只去这一道）
 * **全都是 503**，去掉路由那道再跑全量还是 111/2188 全绿。
 * 而它的**代价是实打实的**：那两行在 `record` 闭包体里，
 * 而 `recordUsage()` 的「sink 缺席就 return」**在它之后**
 * ⇒ `{"model":{"toString":1,"valueOf":1}}` 让 `String()` 自己抛，
 * **连 Tier-2 关着的部署也被打成 500** —— 一次为修 A 加的防御，
 * 把影响面从「开了统计的人」扩大成了「所有部署」，正面违反全局约束 16「关是零成本」。
 * ⇒ **判据记下来：防御要加在「只有开着才跑」的那一侧。** 本文件就是那一侧。
 *
 * ⚠️ **上一版这里写的是「两条路由」，而那是假的**（末轮复评 F1/F3）：
 * `src/http/routes/openai.ts` 上那一道**一直都在**，还比另外两条更早
 *（在 handler 顶层无条件求值，连闭包都不是）⇒ **同一个「关着也 500」的缺陷
 * 原样活着，只是换了条路由**。成因是注意力停在了上一轮的问题清单上：
 * 那份清单写的是「anthropic / responses 两条缺 `String()`」，
 * 裁定「删掉那两道」之后就没有人回头看第三条。
 * **所以措辞是「四条协议路由」——数的是全集，不是上一轮被点名的那几条。**
 */
export const USAGE_MODEL_KEY_MAX_LEN = 64;

/**
 * `byModel` 最多留几个具名键，**超出的一律并进 `USAGE_OTHER_BUCKET`**。
 *
 * ⚠️ **这条上界不是防御性代码，是有界性本身**（评审 I4）：`byModel` 的键**完全由
 * 客户端控制**（模型名来自请求体），每个不同的串就是一个新 `UsageBucket`，
 * 而那份 map **永不清理、每次落盘整份覆写进一个键**。没有上界的三个后果，
 * 一个比一个糟：
 * ① Node 长驻进程的内存无上界；
 * ② **KV 单值 25MB 上限撞上之后 `put` 抛错 ⇒ 那天永远 dirty ⇒ 每个落盘间隔重试一次、
 *    白烧预算**，而这一天的数据再也写不出去；
 * ③ 读路径（Task 4）要把最多 60 个这样的分片合并。
 * 事件侧一直是有界的（`event-ring.ts` 的环形截断），Tier-2 不该打破这个先例。
 *
 * **`byProtocol` 刻意不设上界**：那一维的值来自四条路由里的字面量
 *（`"openai"` / `"anthropic"` / `"responses"` / `"gemini"`），客户端碰不到它。
 * `hours` 同理（恒 24 格）。**只有 `byModel` 这一维是外部可控的。**
 */
export const USAGE_MODEL_MAX_KEYS = 32;

/**
 * 超出 `USAGE_MODEL_MAX_KEYS` 之后的模型都并进这一格。
 * **渲染成「其它」是面板的事（P3d Task 5），不是端点的事**——Task 4 的
 * `GET /admin/api/usage/:date` 把 `byModel` 原样交出去，这个键在里面就是一个普通的键
 *（上一版这里写的是「Task 4 要把它渲染成『其它』」，那句话点错了任务）。
 */
/*
 * ⚠️ **P3e Task 30 把它的名字从「以 _KEY 结尾」改成了 `USAGE_OTHER_BUCKET`，为的是让一条
 * 命名约定变成无例外的**：`docs-parity` 那一组新增的
 * 「源码里每一个存储键常量都被那张 import 清单收着」是**按名字扫**的
 *（`export const …_KEY / …_KEY_PREFIX = "字面量"`）。它撞上这个名字时会得到一个假阳性——
 * 这**不是**存储键，是 `byModel` 里那个兜底桶的**桶名**，一次存储访问都不产生。
 * 当时有两条路：给扫描开一张豁免名册，或者把这个名字改对。选了后者，理由是本仓已经登记过
 * 「扩太宽就要开豁免名册，而豁免名册会变成永久的洞」——一张只有一个条目的名册，
 * 下一个人往里加第二条时不会有任何东西红。
 * ⇒ **约定现在是硬的：`src/` 下叫 `*_KEY` / `*_KEY_PREFIX` 的导出常量一律是存储键。**
 * 谁再拿这个后缀命名一个非存储键，那一格会红——**红就是对的**，它逼人要么改名要么表态。
 */
export const USAGE_OTHER_BUCKET = "__other__";

/**
 * 把一个外部可控的桶键收进上界内。
 *
 * ⚠️ **首行的 `safeString(raw)` 今天确实是防御性代码，代价是「静默丢一条计数」而不是 500**
 *（末轮复评 F4，按事实改写）：入参一路来自请求体，运行时**什么类型都可能**
 *（`c.req.json<T>()` 的泛型是纯编译期的），`123` / `{}` / `true` 都没有 `.slice`。
 * 上一版这里写的是「删掉会让网关 500」——**那句话在写下的那一刻是真的，
 * 却被同一个提交里给 `record()` 加的 try/catch 变成了假的，而这段注释没跟着改。**
 * 实测（删掉 `safeString` 之后打 `{"model":123}`）：开着关着**都是 503**，
 * 抛出去的那一下被 `record()` 的 catch 接住 ⇒ **那一条计数永久消失**，
 * 面板上只少一个数，没有任何别的信号。
 * ⇒ **两句话都要留着**：它不再是「防 500」的最后一道，但它是「别丢计数」的唯一一道。
 * ⭐ 记一条形状：**加一处 try/catch 会改变别处注释的真假 —— 加完要回头查谁在依赖那个前提。**
 * ⚠️ **样本必须跨过「`String()` 自己也会抛」那一档**（收口复评 H2）：
 * `123` / `{a:1}` / `true` / `[1,2]` 这四个只覆盖了「没有 `.slice`」这一层
 *（其中 `[1,2]` 还侥幸有 `.slice`），**把 `String()` 一换上去它们就全过了** ——
 * 样本停在缺陷够不到的地方，等于没验。真正还能打穿的是
 * `{"toString":1,"valueOf":1}`（`JSON.parse` 造得出）：两个转换方法都不是函数，
 * `String()` 自己抛。现在那一步走 `safeString()`。
 * 由 `tests/contract/usage-tier2.test.ts` 的
 * 「model 不是字符串时不许把网关打成 500……」钉着。
 *
 * 先截长度、再判格数：**已经存在的键永远认得出来**（否则同一个模型会因为
 * map 满了而在两次请求之间被分到两个不同的格子，计数直接错位）。
 * ⚠️ 这一条也有一格钉着（定向复评 N4：上一版删掉那句早返回**全量 2182 全绿**，
 * 因为那格用例里 200 个模型名各只出现一次，满桶之后从不复用旧键）——
 * 见「满桶之后再打一次早期的模型名，它仍然进自己那一格……」。
 *
 * ⚠️ **上界是 `USAGE_MODEL_MAX_KEYS + 1`，那多出来的一格是 `USAGE_OTHER_BUCKET` 自己。**
 * 明写出来，免得下一个人按 32 去断言然后发现是 33。
 *
 * ⚠️ **已知边界，如实登记（定向复评 N10 + 收口复评 H3）**：
 * · 客户端可以把 `model` 直接填成 `__other__` 去抢占那个溢出格。后果**只是「其它」
 *   那一格里混进了一个真实模型**——总数一条不丢、上界照旧成立、别的格子不受影响。
 *   不为它换一个「客户端猜不到的」键名：那是把正确性建在一个秘密上，
 *   而这里根本没有正确性依赖它。
 * · **`"[unstringifiable]"` 这个兜底键同样可以被客户端直接填**（末轮复评 F10），
 *   于是它那一格可能混着「真的转不出来的对象」与「照着这个名字填的字符串」。
 *   与上面 `__other__` 那条**同类同处置**：总数不丢、上界照旧，不换成一个
 *   「客户端猜不到的」名字——那是把正确性建在秘密上，而这里没有正确性依赖它。
 * · **`__proto__` / `toString` 这一类原型链上的名字已经不再是边界，是被修掉的缺陷**：
 *   装它们的三个 map 现在是 `Object.create(null)`（写侧见 `emptyDay()`，
 *   读侧见 `mergeDayShards` 与 `narrowRecord`）。在那之前，`__proto__` 会让那一条
 *   **彻底消失**、`toString` 会让那一格序列化成 `null`，**两种都让落盘分片的
 *   `total` 与 Σ`byModel` 对不上**。
 */
/**
 * 把一个**运行时什么都可能是**的值变成字符串，**并且保证自己不抛**。
 *
 * ⚠️ **`String(x)` 自己就会抛，这不是理论**（收口复评 H2）：
 * `JSON.parse('{"toString":1,"valueOf":1}')` 造得出一个两个转换方法都不是函数的对象，
 * 对它取原始值会 `TypeError: Cannot convert object to primitive value`。
 *
 * ⚠️ **`Symbol` 那一档够不到，理由要写下来而不是省略**（收口复评 LOW-2）：
 * `String(Symbol())` 同样抛（`TypeError: Cannot convert a Symbol value to a string`），
 * 但本函数的入参一路来自 `JSON.parse`，**而 JSON 里造不出 Symbol** ⇒ 不可达。
 * 结论是「不可达」，不是「不会抛」——所以兜底照样包着它，不为这一档单开分支。
 *
 * 兜不住时回一个**固定的、看得出是兜底的**字符串，而不是空串：空串会和
 * 「客户端没填 model」混成同一格，那是把两件事画成一件。
 */
function safeString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try {
    return String(raw);
  } catch {
    return "[unstringifiable]";
  }
}

export function boundUsageKey(existing: Readonly<Record<string, unknown>>, raw: string): string {
  const k = safeString(raw).slice(0, USAGE_MODEL_KEY_MAX_LEN);
  if (Object.prototype.hasOwnProperty.call(existing, k)) return k;
  if (Object.keys(existing).length >= USAGE_MODEL_MAX_KEYS) return USAGE_OTHER_BUCKET;
  return k;
}

/** TTL 留一个整天的余量盖掉时钟偏差，与 `EVENT_TTL_MARGIN_MS` 同一条理由。 */
export const USAGE_TTL_MARGIN_MS = USAGE_DAY_MS;

export function usageExpiresAt(day: number): number {
  return (day + USAGE_DAY_RETAIN) * USAGE_DAY_MS + USAGE_TTL_MARGIN_MS;
}

/**
 * 读某个时间区间要取哪些键。
 *
 * **上界是这个函数自身的不变量，不是一句注释**：返回的键数**对任意入参**都
 * `<= USAGE_DAY_RETAIN × USAGE_SLOTS`（= 30 × 2 = 60）。**这句话是全称的，所以下面
 * 那两道护栏是它的一部分，不是可有可无的防御性代码**（评审 A#1 / B#2）：
 *
 * 1. `!Number.isFinite(nowMs)` ⇒ 返回空。`nowMs = ±Infinity` 时 `oldest`/`newest`
 *    都是 `±Infinity`，而 **`d++` 对 `±Infinity` 是恒等操作**，循环不终止。
 * 2. 循环额外带一个 `n < USAGE_DAY_RETAIN` 的计数闸。**只有第 1 道不够**——
 *    `Number.isFinite(1e300)` 是 **`true`**，而 `usageDayIndex(1e300)` 已远超 `2**53`，
 *    那里 `d++` 失去精度、原地打转。
 *
 *    ⚠️ **这一条要连着入参一起说，否则复现不出来**（评审第三轮：上一版写「`1e24` 与
 *    `1e300` 两组都在第 0 步就 `d + 1 === d`」，**没写用的是哪组 `from`/`to`，
 *    而换一组它就是假的**）。逐项实测如下，两组只差一个 `fromMs`：
 *
 *    | 入参 | `oldest` | 第 0 步 `d+1===d` | 去掉计数闸 |
 *    |---|---|---|---|
 *    | `(1e24, 0, 1e24)` | `11574074074074044` | **true** | **不停** |
 *    | `(1e24, 1e24, 1e24)` | `11574074074074074` | false | 停（1 步） |
 *    | `(1e300, 0, 1e300)` | `1.157…e292` | **true** | **不停** |
 *    | `(1e300, 1e300, 1e300)` | `1.157…e292` | **true** | **不停** |
 *
 *    成因：该量级上相邻可表示浮点数的间距是 2，`d + 1` 落在两者正中间，
 *    **靠「就近舍入、平局取偶」决定往哪边倒**——`…044` 倒回自己（恒等），
 *    `…074` 倒到 `…076`（能前进）。**倒哪边取决于 `oldest` 落在哪个浮点数上，
 *    而那由 `fromMs` 决定。** `1e300` 则是间距早已远大于 1，两组都恒等。
 *    ⇒ **「会不会卡住」是入参相关的、肉眼推不出来的**，这正是护栏要做成
 *    **结构性计数闸**而不是「判一下够不够大」的理由：它与入参多大、精度还剩几位无关。
 *
 * ⚠️ **失效形态是「不返回」，不是「数字变大」** —— 第一版这段注释宣告了「恒 ≤ 60」
 * 却没有这两道护栏，评审的第一次探针直接把 v8 跑成 OOM。
 * **宣告一条不变量的时候，语气越强越该先去找反例。**
 *
 * ⚠️ **夹逼的理由就是上面那条上界，不是「反正已经过期」**（评审 I-1，这里原来
 * 正是那么写的，而它被本文件的 `USAGE_TTL_MARGIN_MS` 直接证伪）：
 * TTL 刻意多留了一整天余量（`USAGE_TTL_MARGIN_MS = USAGE_DAY_MS`），
 * `usageExpiresAt(d)` 保留到第 `d + 31` 天零点，而 `oldestAllowed = 今天 − 30 + 1`
 * ⇒ **`今天 − 30` 那一天的键在任何时刻都还活着，却永远不会被这个函数取到。**
 * 那份余量随一天的推移线性缩小：**落在 `(0, 86_400_000]` 区间内，日初满格、
 * 日末趋近 0（最坏只剩 1 ms），但恒 `> 0`** —— 只有「恒 > 0」这一半是结论，
 * 「一整天」只在日初那一瞬成立（评价 A#9：原文写「还剩整整 86_400_000 ms」，
 * 而该值在一天里 86_399_999/86_400_000 的时刻都不是它）。
 * **别照「反正过期了」去把那天加回来——那会直接打破 60 这条上界。**
 *
 * ⚠️ **指向订正**：上一版这里指的是本文件加一个绝对行号，
 * **在 `451bb73` 上就已经指错了**——**不是本任务引入的，是既有欠账**；
 * 改成「本文件的 `USAGE_TTL_MARGIN_MS`」这个名字锚之后不会再随增删行漂走。
 * ⭐ **而这条订正自己先踩了一次同样的坑（定向复评 N4）**：订正文里曾写
 * 「（那个常量今天在 XXX 行）」，**而同一个提交在它上方插了几行，那个数出生即过期**
 * ——量的是改动前的自己。**绝对行号一个都不留**，这条现在由 `scripts/check-comment-refs.mjs` 这道门禁的
 * 「散文里不带路径的绝对行号一律拒收」那条规则守着。
 * 由 `tests/unit/admin/usage-stats.test.ts` 的
 * 「区间给一年也不会超过保留期 × 槽位数」与
 * 「被夹逼排除掉的那一天其实还没过期」两格钉着。
 */
export function usageCandidateKeys(nowMs: number, fromMs: number, toMs: number): string[] {
  if (!Number.isFinite(nowMs)) return [];
  const newest = usageDayIndex(Math.min(toMs, nowMs));
  const oldestAllowed = usageDayIndex(nowMs) - USAGE_DAY_RETAIN + 1;
  const oldest = Math.max(usageDayIndex(fromMs), oldestAllowed);
  const keys: string[] = [];
  for (let d = oldest, n = 0; d <= newest && n < USAGE_DAY_RETAIN; d++, n++) {
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
 * `docs/design/2026-08-20-agnes2api-p3c-write-ops-plan.md「W2 详表（穷举，不是抽样」`
 * 那张表五行），其中三行让端点 **500**、两行**原样进了响应体并让游标永远推不动**。
 * ⚠️ 这里原来写的是 `:238`，P3e Task 29A 在那份计划顶部插了四行溯源限定之后，
 * 那个行号落到了另一张表的 W5 行上——**门禁不会为此变红**（规则 A 对非测试文件只查
 * 行号在不在范围内），改成名字锚就没有这个漂法了。
 * 写成 `UsageDayShard[]` 就是在签名上撒谎。
 * **返回值里的 `malformed` 是给面板看的**：静默丢弃就是撒谎。
 *
 * ⚠️⚠️ **返回值里那四个 map 是无原型对象（`Object.create(null)`），这是一条给调用方的
 * 硬契约**（末轮复评 F12）：**不许在它们身上调任何 `Object.prototype` 的方法** ——
 * `merged.byModel.hasOwnProperty(k)` / `.toString()` / `.constructor` 这类**会直接抛
 * `TypeError`**（那条原型链上什么都没有）。改用 `Object.prototype.hasOwnProperty.call(m, k)`、
 * `k in m` 或 `Object.keys(m)`。
 * 它们之所以必须无原型，见 `mergeDayShards` 函数体里那段（键来自客户端填的模型名，
 * 普通 `{}` 上 `__proto__` / `toString` 会静默坏掉）。
 * ⚠️ **这条契约现在有一格守着了，但护栏只盖住其中一半，两半要分开记**
 * （P3d Task 4 落地时实测；在那之前这里写的是「今天没有任何机器守着」，
 * 因为消费者还不存在）。类型上仍然没有区分（`Record<string, UsageBucket>`
 * 对有原型和无原型一视同仁），护栏是行为上的那一条：
 * `tests/contract/admin-usage.test.ts` 的
 * 「模型名叫 __proto__ / toString / hasOwnProperty / constructor 时，四条都原样出现在响应里」。
 * · **调 `Object.prototype` 的方法** ⇒ `TypeError` ⇒ 端点 500 ⇒ 那一格红（实测）；
 * · **逐键赋值搬进普通 `{}`**（`out[k] = m[k]`）⇒ `__proto__` 那条消失 ⇒ 那一格红（实测）；
 * · **用展开搬（`{ ...m }`）** ⇒ **不会坏，那一格也不会红**——展开走
 *   `CreateDataPropertyOrThrow`，绕过 `Object.prototype.__proto__` 那个访问器
 *   （实测：三处全改成展开之后，那个文件**整份全绿**）。**那不是漏网，是那个写法
 *   本来就不是缺陷**；写在这里免得下一个人拿它当反例去证明那一格没用。
 * ⇒ **别把这段读成「无原型这件事已经被类型系统或某道门禁保证了」**，它没有。
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
  // ⚠️ **四个都必须是无原型的**（收口复评 H3 的读侧一半）：`byModel` 的键来自
  // 客户端填的模型名，落盘之后会**原样从存储里回来**。普通 `{}` 上
  // `into["__proto__"] = 桶` 会去改原型而不是加一个键（那一条就此消失），
  // `into["toString"] ?? emptyBucket()` 又会摸到 `Function.prototype.toString`
  // 而把桶算成一堆 `NaN`。**写侧堵住了而读侧没堵，等于把同一个洞挪到下一个任务。**
  const byDay: Record<string, UsageBucket> = Object.create(null);
  const hours: Record<string, UsageBucket> = Object.create(null);
  const byModel: Record<string, UsageBucket> = Object.create(null);
  const byProtocol: Record<string, UsageBucket> = Object.create(null);
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
 *
 * ⚠️ **它有一处连带变化，明写出来免得下一个人以为只影响 `total`**（评审 L-1）：
 * `narrowRecord` 也走这个函数，所以 `hours: { "13": [] }` 这种值**从「记成一个全 0 桶」
 * 变成「`"13"` 这个键静默消失」**（分片本身仍算合法，`malformed` 不加）。
 * 方向是无害的（少一个假的 0 好过多一个假的 0），**但它确实是一次静默丢弃**，
 * 与上面那句口径轻微相左：`malformed` today 只数**分片级**的畸形，**不数桶级的**。
 * 要把桶级也数进去得改返回形状，那属于 Task 4 的显示口径，不在本任务范围内。
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
  // 无原型，理由同 `mergeDayShards` 里那四个（收口复评 H3 的读侧一半）。
  const out: Record<string, UsageBucket> = Object.create(null);
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
