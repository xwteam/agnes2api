import type { KeyPoolRepo } from "../keypool-repo.js";
import type { MailProvider } from "../../ports/mailbox.js";
import type { AgnesDeps } from "./agnes.js";
import type { RegistrarConfig, Channel } from "./config.js";
import { requireChannel } from "./config.js";
import { countsTowardTarget } from "../keypool.js";
import { isImportableKey } from "../keypool-repo.js";
import { mintOne, type MintOutcome } from "./mint.js";
import type { Logger } from "../../ports/logger.js";
import {
  commitJournal, ledgerReadFailed, newJournal, selectDomains, emptyDomainLedger,
  type DomainLedger,
} from "./domain-ledger.js";
import { inBackoff, nextBackoff, retryAfterMs, type BackoffState } from "./backoff.js";

/**
 * 一次铸 key 失败的归因：`mintOne` 给出的所有 reason，外加 `provider_missing`
 *（它不是 mintOne 的产物——表示选中的通道压根没构造出 provider，是接线错误）。
 *
 * 用联合类型而不是裸 `string`：下面的 switch 特意用 `never` 做了穷尽检查，好让
 * `MintOutcome` 新增 reason 时编译期就提醒这里表态；如果对外的 `TendResult` 把
 * 类型信息退化成 string，面板消费这份结构时就拿不到同样的穷尽保障了。
 */
export type TendFailureReason =
  | Extract<MintOutcome, { ok: false }>["reason"]
  | "provider_missing"
  /**
   * **整轮抛出了异常**（评审发现）。与上面那些一样不是 `mintOne` 的产物：
   * 它表示这一轮**根本没跑完**——`tendOnce` 在某处抛了，两个入口的 `catch` 接住。
   *
   * 加它的理由是一条实测出来的缺陷：抛错那一轮原来**什么记录都不产生**
   *（`recordRound` 在 `try` 里、排在 `tendOnce` 之后，一抛就整个跳过；而 `catch`
   * 里是裸 `console.error`，进不了事件缓冲 ⇒ `flush()` 首行就 return）。
   * 于是面板上这一轮**与「注册机根本没跑」逐字节不可区分**——正是本任务开篇要
   * 兑现的那半句验收在最该看见的那一轮上是零，也直接违反「绝不伪造」。
   */
  | "round_crashed"
  /**
   * **铸出来了，但那串 key 材料本身可疑**（裁定 m5：可疑必须如实报出来）。
   *
   * ⚠️ **这一条是本表唯一「不是失败」的成员，措辞与消费方都要小心**：这一轮的
   * `minted` 照常 +1、`mintedByChannel` 照常记账，因为**上游那边账号是真的建出来了、
   * 一个临时邮箱是真的花掉了**，说 0 是伪造。它出现在 `failures` 里是因为
   * `failures` 是这份结果里**唯一**能逐条带 `channel` 说明「这一轮有什么不对劲」
   * 的通道，而运维必须在补池历史那一行上看得见它。
   *
   * 判据是 `isImportableKey`（`src/core/keypool-repo.ts`）：可打印 ASCII 且不含空白。
   * 不满足时把它拼进 `authorization: Bearer <key>` 会在构造请求头时抛 TypeError
   * ——一把**每次被选中都让转发炸掉、而看起来完全正常**的 key。
   *
   * **处置是「照存不误 + 如实报可疑」，不是拒收**（同一个判据在两条路上不能有
   * 同一种处置）：面板导入那条路上拒绝是免费的（东西还在剪贴板里），
   * 而铸号这条路上拒绝是**销毁凭据**——Agnes 侧账号已经真实建出来了，key 材料只有
   * 手上这一份，扔掉就再也找不回来，连对账都修不了。
   */
  | "key_suspicious"
  /**
   * **这一轮还在退避窗口里，一次都没开始。**
   *
   * 与 `round_crashed` 同一形态、同一条理由（那一段逐字写着）：**「这一轮根本没跑」
   * 不该靠合读 `attempted === 0 && failures[0]` 去推**——面板的补池历史上这一行
   * 必须能自己说清发生了什么。
   *
   * 🔴 **绝不许改用 `skipped: true` 表示它**：`skipped` 有且只有一个含义
   *（`config.enabled === false`），拿它表示别的就是伪造。
   *
   * ⚠️ **它不区分撞的是哪一层限流**（边缘 / 应用）：两档都归到既有的 `rate_limited`，
   * 层级由 `registrar:backoff` 的 `kind` 与 `registrar.rate_limited` 事件带出去。
   * **代价如实登记**：只看补池历史那一行，分不出上一次撞的是哪一层，得去看事件板块
   * 或面板的退避横幅。省掉的是一整圈 i18n 穷尽连锁。
   */
  | "upstream_backoff";

/**
 * `TendFailureReason` 的运行期表。类型是编译期的，枚举不出来，而面板要按它
 * ① 渲染失败归因、② 校验 i18n 键齐全，两件事都发生在运行期。
 *
 * 双向穷尽：`satisfies` 保证每个元素都是合法成员，下面那个类型体操保证**没有遗漏**。
 * 于是 `MintOutcome` 新增 reason 时 `tsc` 会在这里报错，逼加 reason 的人表态——
 * 与 `FIELD_ROLE` 用 `Record<keyof KeyRecord, …>` 逼人表态是同一招。
 */
export const TEND_FAILURE_REASONS = [
  "domain_blocked_all", "upstream_error", "code_timeout", "register_failed",
  "login_failed", "key_failed", "provider_error", "network_error",
  "rate_limited", "provider_missing", "round_crashed", "key_suspicious",
  "upstream_backoff",
] as const satisfies readonly TendFailureReason[];

type _NoMissingReason =
  Exclude<TendFailureReason, (typeof TEND_FAILURE_REASONS)[number]> extends never ? true : never;
/** 少列一个成员时这一行会 `tsc` 报错。它不是死代码，是编译期断言。 */
const _reasonsExhaustive: _NoMissingReason = true;
void _reasonsExhaustive;

export interface TendResult {
  skipped: boolean;
  /**
   * 本轮开始时**占着 `targetKeys` 名额**的 key 数（判据是 `countsTowardTarget`）。
   *
   * ⚠️ **不要读成「能打上游的 key 数」，自从有了「停用」这个开关两者就不是一回事了，
   * 后来判据翻转又把差距拉大了一档**：**被管理员停用的、以及正在冷却的 key 都计入
   * 这个数**（它们都占名额，见 `keypool.ts` 的 `countsTowardTarget`），而这两种
   * 恰恰都是不能打上游的。整池 3 把全在冷却时这个数仍然说 3，实际能服务的是 0。
   * 判据现在就是 `!evicted` —— **这一栏等于「池子里没被剔除的把数」**。
   * 名字没改是因为它已经落进 `tend:history` 持久化、也进了运维日志
   * （`[registrar] 补池完成 available=N`），改名会让存量历史条目对不上。
   *
   * ⚠️ **给建补池历史板块的人**：这一栏**不许按「可用」渲染**——那会撞上
   * 「诚实标记由后端字段驱动」。要么如实标成「占名额数」，要么另外给一个真正的
   * 可用数字段（那需要 `tendOnce` 多数一遍，今天没有加）。
   */
  available: number;
  attempted: number;
  minted: number;
  /**
   * **逐通道的铸出数。**
   *
   * ⚠️ **它今天与 `minted` + `primaryChannel` 等价——旧理由已经不成立，别照旧读。**
   * 旧理由是「一轮可能一半靠主通道一半靠备通道铸出来，总数记在哪条通道名下看不出来」；
   * 两条通道改成二选一、自动降级整个拆掉之后，一轮里**只可能有一条通道**产出。
   * **保留它的唯一理由是存量历史条目的形状**：它已经逐字落进 `tend:history`
   *（`TendRecord extends TendResult`），删掉会让升级前的历史条目被整条判成 malformed
   * 丢掉，换不到任何东西。同源先例见下面 `available` 与 `primaryChannel` 两段。
   *
   * 没铸出来的通道**不出现在表里**（不是记 0）。
   *
   * ⚠️ **`{}` 有五个产出者，消费方必须靠别的字段把它们分开——单看这个字段分不出来。**
   * 面板要渲染「哪条通道真的铸出来了」，这张表就是判据，所以语义写全：
   *
   * | `{}` 的来源 | 怎么认出来 |
   * |---|---|
   * | 注册机关着 | `skipped === true`（**它有且只有这一个含义**） |
   * | 健康轮，缺口 `need <= 0` | `skipped === false && attempted === 0 && failures 为空` |
   * | 整轮抛错 | `attempted === 0 && failures` 里是 `round_crashed` |
   * | 退避窗口内整轮跳过 | `attempted === 0 && failures` 里是 `upstream_backoff` |
   * | 尝试了但全失败 | `attempted > 0 && failures` 非空 |
   *
   * 也就是：**`skipped` + `attempted` + `failures` 三个字段合读**才分得清。
   * 别拿 `mintedByChannel` 的空表去推断「这一轮发生了什么」。
   */
  mintedByChannel: Record<string, number>;
  failures: Array<{ reason: TendFailureReason; channel: string }>;
  /**
   * 这一轮**开始**的时刻（`deps.now()`，不是结束时刻）。
   *
   * 下面三个字段是本任务（`tend:history`）加的。**由 `tendOnce` 而不是两个入口
   * 各自填**：入口有两个（`src/entry/node.ts` / `src/entry/worker.ts`），让它们
   * 各算一遍就是同一个判据的第二份实现——而"两个入口各写一份口径"正是
   * `summarizeFailures()` 当初被提到这里来的全部理由，见那个函数的说明。
   */
  at: number;
  /**
   * 这一轮用的那条通道。`skipped`（注册机关着）时运行期没有取值，记空串。
   *
   * ⚠️ **名字里的 `primary` 是历史格式留下的，今天系统里已经没有主备了。**
   * 它当初叫这个名字，是因为一轮里实际铸出来的可能是备通道、而这一栏记的是主通道；
   * 两条通道改成二选一之后没有这个区别了——**这一栏的语义就是「这一轮用的那条通道」**。
   *
   * **名字不改**，与本接口 `available` 那一段同源：它已经逐字持久化进 `tend:history`
   *（`src/core/admin/tend-history.ts` 的 `FIELD_CHECKS` 是
   * `Record<keyof TendRecord, …>`，改名会让升级前的历史条目被整条判成 malformed 丢掉），
   * 而且它写在五语言 API.md 的响应示例里——那是已发过 tag 的公开仓的响应体契约。
   */
  primaryChannel: string;
  /** 这一轮的墙钟耗时。**面板拿它区分「补池很快就返回了」与「跑满了预算」**。 */
  durationMs: number;
}

/**
 * 把 `TendResult.failures` 聚合成一行可 grep 的归因，例如
 * `yyds:register_failed×3 moemail:code_timeout×1`。
 *
 * 放在这里而不是各自的入口里：两个入口的收尾日志必须给出**同一份口径**，否则
 * Docker 与 Worker 的排障方式就得写两套，而在面板出现之前这条日志是唯一的归因出口
 *（面板才会消费结构化的 `failures` 本身）。没有它，运维只能看到一行
 * `minted=0`，无法区分是 Agnes 挂了、邮箱通道挂了、还是自己配错了通道。
 */
export function summarizeFailures(failures: TendResult["failures"]): string {
  const by = new Map<string, number>();
  for (const f of failures) {
    const k = `${f.channel}:${f.reason}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by].map(([k, n]) => `${k}×${n}`).join(" ");
}

export interface TendDeps {
  repo: KeyPoolRepo;
  config: RegistrarConfig;
  providers: Partial<Record<Channel, MailProvider>>;
  agnes: AgnesDeps;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  /**
   * 本轮可用的墙钟预算（毫秒）。**可选**——不传就没有预算约束。
   *
   * 只有存在平台墙钟上限的运行时才需要它：Cloudflare 的 Cron Trigger 单次调用最多
   * 15 分钟，超时**被平台直接中止**，此刻正在 `mintOne` 的 try 块里的那个临时邮箱，
   * 它的 finally（`deleteMailbox`）不会执行 —— 邮箱泄漏，且没有任何日志。攒够几个
   * 就把活跃邮箱配额吃光，建邮箱一律失败。这正是前两轮花了很大力气才杀掉的那条
   * 死亡链，不能靠「文档告诉用户把 MINT_BATCH 调小」来兜。
   *
   * Node/Docker 侧没有这种上限，因此 `src/entry/node.ts` **不传**这个字段，行为与
   * 引入它之前完全一致；给 Node 硬编码一个预算反而是错的。
   */
  roundBudgetMs?: number;
  /** 事件日志 sink，由调用方注入——core 不直接碰 console。 */
  logger: Logger;
  /**
   * 域名台账与退避状态的读写。**四个都必填、都不给默认值**，与 `buildApp` 的
   * `runtime` 同一条纪律：给默认值就等于某个入口忘接线时静默退化成
   * 「每轮重新洗牌 + 撞了限流照打」——也就是本次要修的那个缺陷原封不动地回来。
   *
   * 落点在 `src/http/wire.ts` 的 `buildTendDeps`（**只有它手上有存储**）。
   * `src/core/registrar/` 一个文件都不许 import `ports/storage`，
   * `tests/unit/source-guards.test.ts` 有一格数着。
   */
  loadDomainLedger: () => Promise<DomainLedger>;
  saveDomainLedger: (ledger: DomainLedger) => Promise<void>;
  loadBackoff: () => Promise<BackoffState | null>;
  /** `null` = 清掉退避（一次成功铸号）。 */
  saveBackoff: (state: BackoffState | null) => Promise<void>;
}

/**
 * 补池一轮：算出「目标数 - 可用数」的缺口，按 `mintBatch` 封顶，顺序铸 key 补进池子。
 *
 * **顺序执行，不并发**（设计 §4.2）。并发会同时撞 YYDS 的建号限流（短时超过约 10 次
 * 返回 403）与 Agnes 自身的注册风控，因此每次尝试之间要插入
 * `mintDelayMinMs`~`mintDelayMaxMs` 的随机间隔，而不是把一批 `mintOne` 一股脑
 * `Promise.all` 出去。`mintBatch` 存在的理由类似：Worker Cron 有墙钟时长限制，
 * 而单次注册光轮询验证码最长就要 `codeTimeoutMs`（默认 120 秒），一轮铸太多会撞墙钟。
 */
export async function tendOnce(deps: TendDeps): Promise<TendResult> {
  const startedAt = deps.now();
  // `skipped` 这一支也要给齐 at/channel/durationMs：面板的补池历史里"这一轮被跳过了"
  // 与"这一轮没发生"是两件事，前者必须能在时间线上占一格。
  if (!deps.config.enabled) {
    return {
      skipped: true, available: 0, attempted: 0, minted: 0, mintedByChannel: {}, failures: [],
      at: startedAt, primaryChannel: "", durationMs: deps.now() - startedAt,
    };
  }

  // **判据是 `countsTowardTarget` 不是 `isAvailable`**，两者在**被停用**与**冷却中**
  // 的 key 上分歧，而那两种都占名额：用后者的话「在面板上停用一把 key」就等于
  // 「自动注册一个新 Agnes 账号」，而「整池被限流冷却一次」就等于「池子永久变大一倍」。
  // 理由全文与两次实测见 `src/core/keypool.ts` 的 `countsTowardTarget`。
  const available = (await deps.repo.all()).filter((r) => countsTowardTarget(r)).length;
  const need = deps.config.targetKeys - available;
  if (need <= 0) {
    return {
      skipped: false, available, attempted: 0, minted: 0, mintedByChannel: {}, failures: [],
      at: startedAt, primaryChannel: requireChannel(deps.config), durationMs: deps.now() - startedAt,
    };
  }

  // 用 requireChannel() 而不是裸读 deps.config.channel：后者的类型虽然声明为非空
  // Channel，但 enabled=false 时运行时其实是 null，裸读拿到的要么是运行时 null、
  // 要么是往下传导致的无上下文异常。此处 enabled 已在上面判过为 true，channel
  // 理应有值，但仍统一走这条安全访问器，不给「以后这段代码被挪到别处、判断被
  // 不小心删掉」留退路。
  const channel = requireChannel(deps.config);

  // ── 退避闸：**在开跑第一个名额之前**，一次上游请求都不发 ────────────────────
  //
  // 🔴 这道闸是整套改动的承重点。上游那两层限流的惩罚窗口都比一轮补池长得多，
  // 而**窗口里每打一次请求就把窗口续一次**——没有它，Cron 每轮都会去续一次窗口，
  // 正是本次要修的那个缺陷换个尺度重演。
  //
  // 🔴 **返回的是 `skipped: false`。** `skipped` 有且只有一个含义
  //（`config.enabled === false`），拿它表示「这一轮在退避里」就是伪造
  //（`./types.ts` 与 `src/core/admin/tend-history.ts` 两处逐字钉着这句话）。
  // 这一行在补池历史上靠 `attempted === 0 && failures` 里的 `upstream_backoff`
  // 自己说清发生了什么。
  let backoff: BackoffState | null = null;
  try {
    backoff = await deps.loadBackoff();
  } catch (err) {
    // **读不出来按放行处理**（fail-open），方向与台账刻意相反：读坏的退避键当成
    // 「还在退避」会让注册机静默停摆，而放行的代价只是多打一轮——那一轮撞上限流
    // 会立刻把退避重新写上。代价明写，不是「已经防住了」。
    deps.logger.log({
      level: "warn", event: "registrar.backoff_read_failed",
      msg: "退避状态读不出来，本轮照常跑（撞上限流会立刻重新记一次退避）",
      fields: { err: err instanceof Error ? err.message : String(err) },
    });
  }
  if (inBackoff(backoff, startedAt)) {
    deps.logger.log({
      level: "warn", event: "registrar.backoff_skipped",
      msg: "上一轮撞上了上游限流，本轮还在退避窗口里，一次上游请求都不发、一个临时邮箱都不建",
      fields: { kind: backoff!.kind, retryAfterMs: retryAfterMs(backoff, startedAt), hits: backoff!.hits },
    });
    return {
      skipped: false, available, attempted: 0, minted: 0, mintedByChannel: {},
      failures: [{ reason: "upstream_backoff", channel }],
      at: startedAt, primaryChannel: channel, durationMs: deps.now() - startedAt,
    };
  }

  const rounds = Math.min(need, deps.config.mintBatch);
  const roundStartedAt = startedAt;
  const failures: TendResult["failures"] = [];
  const mintedByChannel: Record<string, number> = {};
  let attempted = 0;
  let minted = 0;

  // 单次尝试的最坏墙钟：等满一次验证码超时，**外加这次尝试里换域名要付的间隔**。
  //
  // 🔴 **域内间隔那一项不是锦上添花，漏掉它的后果不是变慢是漏邮箱**：低估 ⇒ 开始
  // 一次跑不完的尝试 ⇒ 平台从中间把调用砍断 ⇒ `mintOne` 的 `finally` 不执行 ⇒
  // 临时邮箱漏删且没有任何日志，正是 `./types.ts` 与下面预算那段花大力气杀掉的
  // 那条死亡链。默认 `maxDomainAttempts = 1` 时这一项是 0，与从前逐字相同；
  // 只有运维把它调大时才涨。
  //
  // ⚠️ **这里从前还乘着 `chain.length`**：`code_timeout` 属于通道级失败会降级，
  // 同一个补池名额最坏要在两条通道上各等满一次（5 个名额 ×2 通道 ×120 秒 = 1200 秒
  // > Cron 的 900 秒，那正是当时那个撞墙钟场景）。两条通道改成二选一之后没有第二次
  // 等待了，这个因子整个消失 —— 顺带把「配了备通道才会撞上的那个墙钟死局」也消掉了。
  //
  // 同一份口径在 `./config.ts` 的 `worstAttemptMs`、`./types.ts` 的
  // `WORKER_ROUND_BUDGET_MS`、`wrangler.toml` 的 Cron 估算段各有一份，四处一起改。
  const worstAttemptMs = deps.config.codeTimeoutMs
    + Math.max(0, deps.config.maxDomainAttempts - 1) * deps.config.mintDelayMaxMs;

  // ── 域名台账：**轮开头读一次、列一次域名，收尾最多写一次** ──────────────────
  //
  // 从前 `listDomains()` 是**每个名额一次**（一轮 5 次白花），而域名结论一次都没被
  // 记住。现在两件事都提到轮级：台账供 `selectDomains` 排序，观测攒进 `journal`，
  // 收尾一次性 `commitJournal` 并只在内容真变了时才落盘。
  const provider = deps.providers[channel];
  const journal = newJournal();
  /**
   * **这一轮已经派出去过的域名。** 传给 `selectDomains` 做**档内**轮换。
   *
   * 🔴 为什么非有它不可：台账**轮内不更新**（落盘统一在收尾），而 `selectDomains` 对
   * 「已知 ok」那一档是按 `at` 的全序排序 —— `at` 轮内不变 ⇒ 默认
   * `MAX_DOMAIN_ATTEMPTS = 1` 时**一轮 5 个名额确定性地全落在同一个域名上**
   *（6 分钟内 5 个账号挂在同一个域名下），而那一档的 JSDoc 逐字写着「LRU 轮换，别把一个
   * 好域名打成上游风控的焦点」。轮换从前只发生在**轮与轮之间**，而「打成焦点」这件事
   * 发生的正是轮内那几次连续注册。
   *
   * ⚠️ **它装的是「派出去的候选」而不是「真的打过的域名」，是刻意的取舍**：`mintOne`
   * 拿到候选之后可能只用了第一个（后面的用不用取决于它自己怎么失败），而要精确知道
   * 「真的打过哪几个」就得改 `MintOutcome` 的形状 —— 那是两个 case 都要动的公开结构。
   * 多标几个的代价只有一条：**档内**多转几格（`maxDomainAttempts > 1` 时才可能发生），
   * 而档与档的优先级一格都不动。
   */
  const usedThisRound = new Map<string, number>();
  let ledger: DomainLedger = emptyDomainLedger();
  let allDomains: string[] = [];
  if (provider !== undefined) {
    try {
      ledger = await deps.loadDomainLedger();
    } catch (err) {
      ledger = ledgerReadFailed(deps.logger, err);
    }
    try {
      allDomains = await provider.listDomains();
    } catch (err) {
      deps.logger.log({
        level: "warn", event: "registrar.list_domains_failed",
        msg: "列域名失败", fields: { err: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** 撞上限流时要写回去的退避状态；`null` = 清掉；`undefined` = 这一轮不动它。 */
  let backoffToSave: BackoffState | null | undefined = undefined;

  try {
  for (let i = 0; i < rounds; i++) {
    // 间隔先算出来：它也要计入预算，且必须在「要不要开始这次尝试」之前就知道。
    const delayMs = i === 0
      ? 0
      : deps.config.mintDelayMinMs
        + Math.floor(deps.rand() * Math.max(0, deps.config.mintDelayMaxMs - deps.config.mintDelayMinMs));

    // 轮级墙钟预算：**永远不启动一次明知跑不完的尝试**。
    //
    // 关键在于「不开始」而不是「跑到一半停下」——被平台从中间砍断时 mintOne 的
    // finally 不会执行，邮箱就漏了；主动提前收尾则每一次尝试都完整走完，邮箱一定
    // 被删掉。代价只是这一轮少铸几把，下个调度周期会接着补，使用者不需要调任何参数。
    const elapsedMs = deps.now() - roundStartedAt;
    if (deps.roundBudgetMs !== undefined && elapsedMs + delayMs + worstAttemptMs > deps.roundBudgetMs) {
      if (attempted === 0) {
        // 一次都没开始过，说明预算连**单次**最坏耗时都装不下——这不是「这轮差一点」
        // 而是「这个配置在本运行时下永远铸不出 key」，每一轮都会原地打转。走 error
        // 且措辞必须与下面那条区分开：failures 是空的（没尝试过就没有失败），
        // `minted < attempted` 是 `0 < 0` 为假，两个入口的归因日志一条都不会打，
        // 这里是唯一能说破它的地方。
        deps.logger.log({
          level: "error", event: "registrar.round_budget_impossible",
          msg: "单次铸 key 的最坏耗时已超过本轮墙钟预算，一次尝试都无法开始，补池将持续零产出"
            + "——这是配置问题不是瞬时状况，请调小 CODE_TIMEOUT_MS",
          fields: { worstAttemptMs, roundBudgetMs: deps.roundBudgetMs },
        });
      } else {
        deps.logger.log({
          level: "warn", event: "registrar.round_budget_exhausted",
          msg: "本轮墙钟预算不足以再完整跑完一次铸 key，提前收尾（剩余名额留给下次调度）",
          fields: { elapsedMs, budgetMs: deps.roundBudgetMs, worstAttemptMs, attempted, minted, rounds },
        });
      }
      break;
    }

    if (delayMs > 0) {
      // 顺序铸并插入随机间隔：并发会同时撞邮箱服务的建号限流与上游的注册风控。
      await deps.sleep(delayMs);
    }
    attempted++;

    // 上游整体故障（upstream_error）时，这一轮到此为止：见下方 switch 分支注释。
    let abortRound = false;

    if (!provider) {
      // 选中的通道没构造出对应 provider——这是接线错误，不是"这条通道本来就没配"的
      // 正常状态。静默跳过会让 attempted 正常自增、minted=0、failures=[]，观测层面
      // 查不出原因；这里留一条记录，让接线错误在 TendResult 里可见。
      failures.push({ reason: "provider_missing", channel });
    } else {
      // **候选域名按台账排序，不再是「全量洗牌取前 N」。** 每个名额都重排一次：
      // 上一个名额刚学到的结论还在 `journal` 里没落盘，但同一轮里再撞同一个坏域名
      // 是划不来的——所以这里用 `ledger` 的排序 + `mintOne` 自己按顺序试。
      // 第六个实参是本轮已派出去过的那些（见 `usedThisRound` 那一段）：它只在**档内**
      // 把它们挪到后面，档与档的优先级一格都不动。
      // 第七个是本轮**已经被上游当面拒过**的那些（见 `rejectedThisRound`）：它**跨档**，
      // 因为救的正是「第一档里的域名全坏了，档内怎么转都轮不到第二档」那个归零场景。
      const candidates = selectDomains(
        ledger, allDomains, deps.now(), deps.config.maxDomainAttempts, deps.rand, usedThisRound,
        rejectedThisRound(journal),
      );
      for (const d of candidates) usedThisRound.set(d, (usedThisRound.get(d) ?? 0) + 1);
      const out = await mintOne({
        provider,
        agnes: deps.agnes,
        tokenName: deps.config.tokenName,
        codeTimeoutMs: deps.config.codeTimeoutMs,
        candidates,
        journal,
        ledger,
        now: deps.now(),
        mintDelayMinMs: deps.config.mintDelayMinMs,
        mintDelayMaxMs: deps.config.mintDelayMaxMs,
        sleep: deps.sleep,
        rand: deps.rand,
        logger: deps.logger,
      });

      if (out.ok) {
        // **照存不误。** 这一行**刻意不加校验、也不 `trim()`**：到这一步 Agnes 侧的
        // 账号已经真实建出来、一个临时邮箱已经真实花掉，而 key 材料只有手上这一份。
        // 在这里拒收 = 销毁凭据 = `keypool-repo.ts` 开头定性的那一类**数据丢失**。
        await deps.repo.add(out.key);
        minted++;
        mintedByChannel[channel] = (mintedByChannel[channel] ?? 0) + 1;
        // **如实报可疑**（裁定 m5）。`isImportableKey` 此前
        // 只挂在面板导入这条「人点一下」的路径上，而**稳态下 key 进池子的主路径是
        // 这一行**——不对称是登记过的，处置不同是刻意的，但"不报"从来不是选项。
        if (!isImportableKey(out.key)) {
          failures.push({ reason: "key_suspicious", channel });
          deps.logger.log({
            level: "error", event: "registrar.minted_key_suspicious",
            msg: "上游发回来的 key 含有不可打印字符或空白，已照常存进池子，但它多半每次被选中都会让转发失败"
              + "（拼进 authorization 头时会抛 TypeError）；请在面板上停用或删除它",
            // **不带明文**（约束 11(a)）：只报长度与通道，够运维定位、不够泄漏。
            fields: { channel, keyLength: out.key.length },
          });
        }
      } else {
        failures.push({ reason: out.reason, channel });

        /**
         * **这个 switch 只决定「要不要中止整轮」，不再决定「换不换通道」。**
         *
         * ⚠️⚠️ **两条通道是二选一，一条通道失败绝不会去碰另一条**（本轮的行为变更）。
         * 从前 `provider_error` 与 `code_timeout` 会把 `tryFallback` 置真、降级到备
         * 通道；现在这两支与其余几支的处置完全一样：**本次名额作废，本轮的下一个名额
         * 照常开始**（先睡 mintDelayMin~Max）。没有跨轮退避、也不新增：失败不改变下一轮
         * 的时间（Node 是固定 TEND_INTERVAL_MS 定时器、Worker 是 Cron），轮内节流已有
         * 两层（尝试间的随机间隔 + 轮级墙钟预算）。加自动退避等于偷偷把「二选一」变成
         * 「二选一 + 自适应调度」，运维在面板上看到的补池节奏会与配置对不上。
         *
         * ⚠️ **变坏的地方点名写出来**：从前「这条通道收不到验证码」还有一次换通道的
         * 机会；现在同一条通道收不到验证码 = 这一轮乃至这一天一把都铸不出来，直到运维
         * 自己去面板换通道。故障形态从「补池变慢但还在出 key」变成「补池零产出、池子
         * 慢慢耗干、几小时到几天后以 pool_empty 503 炸出来」——**把一个自愈的故障换成
         * 了一个要人管的故障**。这是「二选一」的固有代价，不是实现缺陷。
         *
         * ⚠️ **switch 本身必须留着**：它还担着 `upstream_error ⇒ abortRound` 与
         * `default` 分支那句穷尽性断言（`MintOutcome` 新增 reason 时逼人表态的编译期
         * 护栏）。它只是从「决定换不换通道」退化成「决定中不中止整轮」。
         */
        switch (out.reason) {
          case "provider_error":
          case "network_error":
          case "code_timeout":
          case "domain_blocked_all":
          case "register_failed":
          case "login_failed":
          case "key_failed":
            // 本次名额作废，本轮的下一个名额照常开始。
            break;
          case "rate_limited": {
            // 🔴 **这一支从「继续下一个名额」挪到「立刻中止整轮」，是本次的承重改动。**
            // 从前它落在上面那一支：撞上限流之后接着把 `mintBatch` 打完，而两层限流的
            // 惩罚窗口都远比一轮长，**窗口里每打一次就把窗口续一次** ⇒ 打得越多恢复
            // 得越晚，而且那些请求一次都不可能成功。
            abortRound = true;
            // 🔴 **这一轮铸出过 key 就重新起一串**（`hits` 回到 1，不接着翻倍）。
            //
            // 从前这里无条件传 `backoff`，于是「前 4 把成功、第 5 把撞限流」这种**默认参数
            // 下最常见的一轮**照样把 `hits` 一路推上去：连着几轮都长这样 ⇒ 15min → 30min →
            // 1h → 2h → 4h(封顶)，而每一轮其实都在正常出 key。指数退避要治的是「越打越死」，
            // 不是「出着 key 顺带撞了一次上限」。收尾那一支（`finishRound`）要的是
            // **铸出过 key 且整轮一次限流都没撞到**，走到这里就说明撞过了、那一支进不来
            // —— 两支合起来才是五语言 REGISTRAR.md 与 CHANGELOG 写的那件事：
            // 一轮里只要铸出过 key，指数就从头数起。
            //
            // ⚠️ **`minted` 在这一行已经是这一轮的终值**：本支紧跟着 `abortRound = true`，
            // 后面一个名额都不会再开始。
            const next = nextBackoff(minted > 0 ? null : backoff, out.limitKind, deps.now());
            backoffToSave = next;
            deps.logger.log({
              level: "warn", event: "registrar.rate_limited",
              msg: "撞上上游限流，本轮到此为止，并记一个退避窗口（窗口内下一轮一次上游请求都不发）",
              fields: {
                kind: out.limitKind, until: next.until, hits: next.hits,
                // `marker` 只是边缘限流正文里那个可 grep 的记号，**不参与任何判定**。
                marker: out.marker,
              },
            });
            break;
          }
          case "upstream_error":
            // Agnes 后端整体故障（发验证码遇到非 400 的非 2xx）。继续本轮只会在故障
            // 期间制造更多注定失败的请求。这里的退避是整轮级别的：立即结束这一轮
            // tend，把剩余名额留给下次调度，而不是硬着头皮把 mintBatch 耗完。
            abortRound = true;
            break;
          default: {
            // ⚠️ 断言的是 **`out` 整个**而不是 `out.reason`：`rate_limited` 那一支
            // 多带了 `limitKind` / `marker` 之后 `MintOutcome` 成了两个对象类型的联合，
            // 全部 case 走完时 `out` 本身才是 `never`（`out.reason` 在那时已经取不到了）。
            const exhaustive: never = out;
            throw new Error(`未处理的 MintOutcome: ${JSON.stringify(exhaustive)}`);
          }
        }
      }
    }

    if (abortRound) break;
  }
  } finally {
    // ── 收尾：把这一轮学到的东西落盘 ────────────────────────────────────────
    //
    // **放在 `finally` 里是刻意的**：整轮抛错时（`round_crashed` 那一档）退避截止
    // 时刻同样必须落盘，否则一次崩轮就把「别再打了」这条结论丢掉，下一轮接着打、
    // 接着续窗口。整段自己包一层 try/catch —— 收尾出错不该掩盖 try 块里正在飞的
    // 那个异常（与 `mintOne` 的 `finally` 同一条纪律）。
    try {
      await finishRound({
        deps, provider, ledger, journal, allDomains, minted, backoff, backoffToSave,
      });
    } catch (err) {
      deps.logger.log({
        level: "warn", event: "registrar.ledger_write_failed",
        msg: "本轮的域名台账 / 退避状态没写进去；台账丢了只是下一轮重学，"
          + "退避丢了会让下一轮照打（可能把上游的惩罚窗口续上）",
        fields: { err: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  if (minted > 0) await reconcileAfterMint(deps);

  return {
    skipped: false, available, attempted, minted, mintedByChannel, failures,
    at: startedAt, primaryChannel: channel, durationMs: deps.now() - startedAt,
  };
}

/**
 * 本轮**已经被上游当面拒过**的域名，现从这一轮的观测本子算出来。
 *
 * 🔴 **它治的是一个实测出来的归零场景，不是锦上添花**：`commitJournal` 的
 *「一轮最多学 1 条」钳位在**同一轮里两个已知 ok 的域名同时被上游拉黑**时会把两条结论
 * 整体作废 ⇒ 台账一个字都不变 ⇒ 下一轮的排序与这一轮逐字节相同 ⇒ 每一轮都把全部名额
 * 喂给那两个坏域名，补池归零直到那两条 `ok` 过 `OK_TTL_MS`（7 天）。
 * `selectDomains` 拿它把这些域名排到**全表最后**（跨档），于是同一轮的下一个名额就能
 * 落到第二档的域名上，**本轮就能出 key**。钳位本身一格都没动 —— 它挡的是「学不学」，
 * 这里管的是「这一轮接下来打谁」，两件事。
 *
 * ⚠️ **同一个域名以最后一条观测为准**：先被拒、后来又成功过的，这一轮不该再被让到后面
 *（口径与 `commitJournal` 的折叠逐字相同 —— 两处对「这一轮这个域名到底怎么样」
 * 必须给同一个答案）。
 *
 * ⚠️ **不落盘、不跨轮**：`journal` 每轮新建一本，所以它下一轮从空集重新开始 ——
 * 一个好域名不可能被它永久降权。
 */
function rejectedThisRound(journal: ReturnType<typeof newJournal>): ReadonlySet<string> {
  const last = new Map<string, string>();
  for (const o of journal.observations) last.set(o.domain, o.verdict);
  const out = new Set<string>();
  for (const [d, v] of last) if (v === "blocked") out.add(d);
  return out;
}

/**
 * 一轮收尾：域名台账最多写 1 次、退避键按需写 1 次。
 *
 * ⚠️ **「结论没变就一次 put 都不发」是写配额账的一根轴**，不是省事：Cron 每 30 分钟
 * 一轮，稳态下台账的结论不再变动 ⇒ 这把键的写次数是 0 而不是 48 次/天。
 * `tests/unit/registrar/domain-ledger-io.test.ts`「一轮铸 5 把，registrar:domains 只被 put 一次；退避键一次都不写」按键数着 put 计数钉这条。
 *
 * ⚠️ **退避键在这里有两个来源，`p.backoffToSave` 只是其中一个**：限流那一支（`tendOnce`
 * 的 switch）与下面那一档（这一轮成片判出「域名被屏蔽」+ 这一轮零产出）。两者**不叠加**
 * ——前者已经定好时后者一个字都不改，理由写在那一段里。
 */
async function finishRound(p: {
  deps: TendDeps;
  provider: MailProvider | undefined;
  ledger: DomainLedger;
  journal: ReturnType<typeof newJournal>;
  allDomains: string[];
  minted: number;
  backoff: BackoffState | null;
  backoffToSave: BackoffState | null | undefined;
}): Promise<void> {
  const { deps } = p;
  // 限流那一支已经定好的退避（`undefined` = 那一支没走到）。下面那一档可能往里填。
  let toSave = p.backoffToSave;

  if (p.provider !== undefined) {
    const committed = commitJournal(
      p.ledger, p.journal, deps.now(),
      // 域名一个都没列出来时不动 `total`：那是「这一轮没问到」，不是「上游只有 0 个」。
      p.allDomains.length > 0 ? p.allDomains.length : null,
    );
    /**
     * 🔴 **这一档的形状证据，两条，取并集**。它是分类器读错文案那一档（真限流被逐条读成
     * 域名屏蔽）能产生的**唯一**信号 —— `mintOne` 那两条限流支一次都进不去，
     * `edge` / `app` 两档退避一个都不会写。
     *
     * ① `committed.discarded > 0` = 钳位生效 = **同一轮里 ≥2 个域名被判成「域名被屏蔽」**；
     * ② `roundAllRejected` = **上游列出来的域名这一轮一个不落全试过了，而且全被判成
     *    「域名被屏蔽」**。
     *
     * 🔴🔴 **② 是补上来的，它治的是一条实测出来的、对整类部署完全失效的漏洞**：
     * 只配了一个邮箱域名的部署**永远凑不满 ① 要的那 2 个**，于是上游一改限流文案，
     * 那种部署每一轮都打满 `mintBatch` 次注定失败的发码请求、**一个退避键都不写**。
     * 实测（测试替身、内置值、20 轮）：逐轮请求数恒为 5、`minted` 恒为 0、退避 20 轮全是
     * `null` ⇒ 稳态 **240 次/天**；接上 ② 之后同一份夹具是
     * `[5,5,0,5,0,0,0,5,0,0,0,0,0,0,0,5,0,0,0,0]` ⇒ 稳态 **30 次/天**
     *（封顶那一档每 8 轮打一次 × 5 次/轮，48 轮/天）。
     * 判据是 `tests/unit/registrar/domain-ledger-io.test.ts` 的
     * 「只配了一个邮箱域名 + 上游换了限流措辞：退避照样记得下来，请求量被按住」。
     *
     * ⚠️ **② 真正多接住的只有「上游只给出一个域名」那一种，这一点如实写出来**：上游给出
     * ≥2 个域名时，「全试过且全被拒」意味着被拒的域名 ≥2 个 ⇒ 钳位必然生效 ⇒ ① 早就成立。
     * 写成上面那个更一般的形状，只是因为**这一档的语义本来就该是「这一轮的候选全军覆没」**，
     * 而不是「凑够两个」——「凑够两个」是钳位的口径，被顺手借用成了退避的口径，那次借用
     * 就是这条漏洞的来源。
     *
     * ⚠️ **「一个不落全试过」这半句是承重的，不许省**：`journal` 里只有拿到过可分类回话的
     * 域名（建不出邮箱、正文空到读不出、非域名屏蔽的非 2xx 都不进本子）。省掉它的话，
     * 「池子快满、这一轮只开了 1 个名额、而它恰好撞上一个真被拉黑的域名」也会记退避 ——
     * 实测：`tests/unit/registrar/domain-ledger-io.test.ts` 的
     * 「连着 6 轮：坏域名被降下去，另外三个候选派得出去，key 照样铸得出来」那一格里，
     * 第 0 轮就会白记一个 `cluster` 窗口（那一格逐字断言全程一个退避键都不写）。
     *
     * ⚠️ **不并进钳位本身**：钳位管的是「学不学这条域名结论」，改它会让单域名部署再也学不到
     * `blocked`、`registrar.domain_blocked` 那条带着上游原话的事件再也发不出来 —— 而横幅
     * 恰恰要运维去翻那条原话。⇒ 钳位一格都没动，只有退避的触发条件取了并集。
     *
     * ⚠️ **`p.minted === 0` 这个前提是承重的，不是保险起见**：这两条证据在
     *「上游真的成批拉黑了好几个域名」时同样会成立，而那一档**这一轮照样铸得出 key**
     *（`rejectedThisRound` 把被拒过的跨档排到最后）。那时上游明明还在给我们发号，
     * 记退避等于自己把补池按停 —— 与限流那一支「铸出过 key 就重新起一串」同一条纪律。
     * 反向控制在 `tests/unit/registrar/domain-ledger-io.test.ts` 的
     * 「同一轮里两个已知能用的域名同时被拉黑：结论照旧被钳位作废，但这一轮仍然铸得出 key」
     *（那一格逐字断言一个退避键都不写）。
     *
     * ⚠️ **它按的是「这一轮的形状」，不是「这一个域名以前是 ok」** —— 后者正是被拆掉的那道
     * 保险的判据，也是那把 `at` 冻住的死锁的来源（全文见 `./mint.ts` 的 `domain_blocked`
     * 那一支）。两者不是同一件事：这里**不中止本轮**（`mintBatch` 个名额照常轮着试不同
     * 域名，本轮该出的 key 照出）、**不吞任何域名结论**，且一轮真铸出 key 就把整把键清掉。
     */
    const rejected = rejectedThisRound(p.journal);
    const probed = new Set(p.journal.observations.map((o) => o.domain));
    const listed = new Set(p.allDomains);
    const roundAllRejected =
      rejected.size > 0 && rejected.size === probed.size && probed.size === listed.size;
    const clusterShape = committed.discarded > 0 || roundAllRejected;
    if (toSave === undefined && p.minted === 0 && clusterShape) {
      toSave = nextBackoff(p.backoff, "cluster", deps.now());
    }
    /**
     * 🔴 **代价登记（评审回填，可证不是推断）：钳位生效的那一支拿不到全部上游原话。**
     *
     * `commitJournal` 里 `applied` 在钳位生效时把**全部** `blocked` 判定滤光，
     * 剩下的只可能是 `ok`，而 `newlyBlocked` 只从 `s === "blocked"` 那一支产生
     * ⇒ **`committed.newlyBlocked` 在这一支上可证恒为空 ⇒ 下面那条
     * `registrar.domain_blocked` 一条都发不出来**。而这条 `domain_verdicts_discarded`
     * 的 `fields` 只有条数、本轮产出与退避截止时刻，**一个字的上游原话都不带**。
     *
     * ⚠️ **这一支上唯一带得出上游原话的是 `./mint.ts` 的
     * `registrar.known_good_domain_rejected`，而它只覆盖台账里已知能用的那些域名** ——
     * 冷启动、或者上游这一轮新列出来的域名，一句原话都没有。⇒ 面板横幅与五语言文档
     * 都按支分开写，不许说成「去翻 domain_blocked 就能分辨」。
     *
     * ⚠️ **刻意不往这条事件里塞 message**：那要改 `CommitResult` 的形状（把被作废的
     * 那几条判定各自的上游原话带出来），属于改行为；这一轮的处置是**说真话 + 把代价
     * 登记下来**，行为一个字都没动。判据是
     * `tests/unit/registrar/domain-ledger-io.test.ts` 的
     * 「钳位生效那一轮：registrar.domain_blocked 一条都发不出来，上游原话只在
     *   known_good_domain_rejected 里」。
     */
    if (committed.discarded > 0) {
      deps.logger.log({
        level: "warn", event: "registrar.domain_verdicts_discarded",
        msg: "同一轮里冒出好几个疑似「域名被屏蔽」，这更像是出口被限流而不是域名真的成批失效，"
          + "本轮的域名判定整体作废（好域名不会因为一次限流被判死）；"
          + "这一轮如果一把 key 都没铸出来，还会按这个形状记一个退避窗口",
        fields: {
          count: committed.discarded, minted: p.minted,
          // 这一轮到底记没记退避窗口。**记的是结果不是意图**：限流那一支已经写过时
          // 这里不覆盖，字段里出现的就是那一支的截止时刻。
          backoffUntil: toSave?.until ?? null,
        },
      });
    } else if (roundAllRejected && p.minted === 0) {
      // 上面那条事件说的是「钳位作废了几条结论」，而单域名部署下钳位压根没生效
      //（它要 ≥2 个域名）—— 照那条事件的名字发出去就是假话。这一条说的是另一件事：
      // **这一轮试过的候选全被拒、一把 key 都没出**，退避是按这个形状记的。
      deps.logger.log({
        level: "warn", event: "registrar.round_all_domains_rejected",
        msg: "上游列出来的邮箱域名这一轮一个不落全试过了，而且全被判成「域名被屏蔽」，"
          + "这一轮一把 key 都没铸出来；按这个形状记了一个退避窗口。两种可能都还开着："
          + "上游换了限流的措辞、我们的词表没认出来，或者上游真的把这些域名拉黑了 "
          + "—— 去看 registrar.domain_blocked 带的上游原话",
        fields: {
          listed: listed.size, probed: probed.size, rejected: rejected.size, minted: p.minted,
          backoffUntil: toSave?.until ?? null,
        },
      });
    }
    for (const b of committed.newlyBlocked) {
      // 只有**第二跳判死**才记事件（第一跳只进台账），理由见 `CommitResult.newlyBlocked`。
      deps.logger.log({
        level: "warn", event: "registrar.domain_blocked",
        msg: "这个邮箱域名连着两次被上游拒了，之后排到候选末尾（判定走的是启发式词表，"
          + "上游换文案会误判；下面这句 message 就是用来看它换没换的）",
        fields: { domain: b.domain, n: b.n, message: b.message },
      });
    }
    if (committed.dirty) await deps.saveDomainLedger(committed.next);
  }

  if (toSave !== undefined) {
    await deps.saveBackoff(toSave);
  } else if (p.minted > 0 && p.backoff !== null) {
    // 铸出来了 ⇒ 上游现在认我们 ⇒ 把那把陈旧的退避键清掉，指数从头数。
    // **只有键真的存在时才写**：否则每一轮成功补池都要白付一次 put。
    await deps.saveBackoff(null);
  }
}

/**
 * 本轮真的铸出 key 之后，**再对一次账**。成本是一次 `list`（外加一次 `get`），
 * 只在有产出的那些轮次付。
 *
 * 为什么非做不可：`KeyPoolRepo.indexAdd` 是**没有 CAS 的读-改-写**，而 KV 的边缘
 * 读缓存可能让它读到「对账刚修好之前」的那份索引，于是它把修复结果整个覆盖回去——
 * 同一轮里刚被捡回来的孤儿转眼又成了孤儿。
 *
 * 连带后果比「索引脏了」严重得多：孤儿不被 `all()` 看到 ⇒ 上面 `available` 那一栏算出的可用数
 * 偏小 ⇒ 缺口被高估 ⇒ **超额补铸**，而每铸一把都是一次真实的 Agnes 建号，同时撞
 * 注册风控与两条通道各自的活跃邮箱上限（数字与出处见两个适配器的文件头，
 * 本文件不复述——那两个上限都不是常数）。补铸出来的 key 还会
 * 再次触发同一条覆盖，一轮一轮地滚。
 *
 * 这一步不消灭那个窗口（没有 CAS 就消灭不了），只把它从「一整轮」压到「一轮之内」：
 * 两个入口的下一次对账要等 30 分钟，而这里是立刻。
 *
 * 失败只记一条 warn 就算了：索引残留是 fail-safe 的（key 不被用，而不是坏 key 被用），
 * 让它把一轮**已经成功铸出了 key** 的 tend 变成异常，只会让两个入口打出误导性的
 * 「补池失败」，而实际上 key 已经落盘了。
 */
async function reconcileAfterMint(deps: TendDeps): Promise<void> {
  try {
    await deps.repo.reconcileIndex();
  } catch (err) {
    deps.logger.log({
      level: "warn", event: "registrar.post_mint_reconcile_failed",
      msg: "本轮铸出了 key，但收尾对账失败；索引可能仍缺项，下一轮调度开头的对账会再修一次",
      fields: { err: err instanceof Error ? err.message : String(err) },
    });
  }
}
