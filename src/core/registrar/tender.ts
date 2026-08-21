import type { KeyPoolRepo } from "../keypool-repo.js";
import type { MailProvider } from "../../ports/mailbox.js";
import type { AgnesDeps } from "./agnes.js";
import type { RegistrarConfig, Channel } from "./config.js";
import { requirePrimary } from "./config.js";
import { countsTowardTarget } from "../keypool.js";
import { isImportableKey } from "../keypool-repo.js";
import { mintOne, type MintOutcome } from "./mint.js";
import type { Logger } from "../../ports/logger.js";

/**
 * 一次铸 key 失败的归因：`mintOne` 给出的所有 reason，外加 `provider_missing`
 *（它不是 mintOne 的产物——表示 chain 里的通道压根没构造出 provider，是接线错误）。
 *
 * 用联合类型而不是裸 `string`：下面的 switch 特意用 `never` 做了穷尽检查，好让
 * `MintOutcome` 新增 reason 时编译期就提醒这里表态；如果对外的 `TendResult` 把
 * 类型信息退化成 string，P3 消费这份结构时就拿不到同样的穷尽保障了。
 */
export type TendFailureReason =
  | Extract<MintOutcome, { ok: false }>["reason"]
  | "provider_missing"
  /**
   * **整轮抛出了异常**（评审 C1）。与上面那些一样不是 `mintOne` 的产物：
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
   * **铸出来了，但那串 key 材料本身可疑**（P3c Task 5，Task 3 的 m5 裁定）。
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
  | "key_suspicious";

/**
 * `TendFailureReason` 的运行期表。类型是编译期的，枚举不出来，而 P3 的面板要按它
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
   * ⚠️ **不要读成「能打上游的 key 数」，两者从 P3c Task 2 起就不是一回事了，
   * 而 Task 5 又把差距拉大了一档**：**被管理员停用的、以及正在冷却的 key 都计入
   * 这个数**（它们都占名额，见 `keypool.ts` 的 `countsTowardTarget`），而这两种
   * 恰恰都是不能打上游的。整池 3 把全在冷却时这个数仍然说 3，实际能服务的是 0。
   * 判据现在就是 `!evicted` —— **这一栏等于「池子里没被剔除的把数」**。
   * 名字没改是因为它已经落进 `tend:history` 持久化、也进了运维日志
   * （`[registrar] 补池完成 available=N`），改名会让存量历史条目对不上。
   *
   * ⚠️ **给 Task 4/5 建补池历史板块的人**：这一栏**不许按「可用」渲染**——那会撞上
   * 「诚实标记由后端字段驱动」。要么如实标成「占名额数」，要么另外给一个真正的
   * 可用数字段（那需要 `tendOnce` 多数一遍，本任务没有加）。
   */
  available: number;
  attempted: number;
  minted: number;
  /**
   * **逐通道的铸出数**（评审 I8）。`minted` 只有总数，而 `minted++` 发生在
   * `for (const ch of chain)` 里——**一轮全靠备通道铸出来时，总数记在哪条通道
   * 名下是看不出来的**。没有这个字段，面板就只能拿 `primaryChannel` 去顶，
   * 于是备通道的战绩会被持续记到主通道头上，**与「两条邮箱通道完全平级」
   * 那条硬约束正面冲突**。`failures` 早就是逐条带 `channel` 的，这里补齐产出侧。
   *
   * 没铸出来的通道**不出现在表里**（不是记 0）。
   *
   * ⚠️ **`{}` 有四个产出者，消费方必须靠别的字段把它们分开——单看这个字段分不出来。**
   * Task 6 要渲染「哪条通道真的铸出来了」，这张表就是判据，所以语义写全：
   *
   * | `{}` 的来源 | 怎么认出来 |
   * |---|---|
   * | 注册机关着 | `skipped === true`（**它有且只有这一个含义**） |
   * | 健康轮，缺口 `need <= 0` | `skipped === false && attempted === 0 && failures 为空` |
   * | 整轮抛错 | `attempted === 0 && failures` 里是 `round_crashed` |
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
   * 这一轮走的**主**通道。`skipped`（注册机关着）时 `primary` 运行期是 `null`，记空串。
   *
   * ⚠️ **名字里的 `primary` 不能省**（评审 I8）：它原来叫 `channel`，而那个名字
   * 会被下游读成「这一轮是谁干的」——**实际铸出来的可能是备通道**。
   * 要回答「谁真的铸出来了」请读 `mintedByChannel`。
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
 * Docker 与 Worker 的排障方式就得写两套，而这条日志是 P2 阶段唯一的归因出口
 *（P3 面板才会消费结构化的 `failures` 本身）。没有它，运维只能看到一行
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
      at: startedAt, primaryChannel: requirePrimary(deps.config), durationMs: deps.now() - startedAt,
    };
  }

  // 用 requirePrimary() 而不是裸读 deps.config.primary：后者的类型虽然声明为非空
  // Channel，但 enabled=false 时运行时其实是 null，裸读拿到的要么是运行时 null、
  // 要么是往下传导致的无上下文异常。此处 enabled 已在上面判过为 true，primary
  // 理应有值，但仍统一走这条安全访问器，不给「以后这段代码被挪到别处、判断被
  // 不小心删掉」留退路。
  const primary = requirePrimary(deps.config);
  const chain: Channel[] = deps.config.fallback ? [primary, deps.config.fallback] : [primary];

  const rounds = Math.min(need, deps.config.mintBatch);
  const roundStartedAt = startedAt;
  const failures: TendResult["failures"] = [];
  const mintedByChannel: Record<string, number> = {};
  let attempted = 0;
  let minted = 0;

  // 单次铸 key 的最坏墙钟：等满验证码超时，且 `code_timeout` 属于通道级失败会降级，
  // 所以同一个补池名额最坏要在 chain 上的每条通道各等满一次。这是墙钟里**占绝对
  // 大头**的一项（默认 120 秒/通道），也正是 M1 之后新出现的那个撞墙钟场景：两条
  // 通道同时收不到信时，5 个名额 ×2 通道 ×120 秒 = 1200 秒 > Cron 的 900 秒。
  const worstAttemptMs = deps.config.codeTimeoutMs * chain.length;

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
            + "——这是配置问题不是瞬时状况，请调小 CODE_TIMEOUT_MS 或去掉备通道",
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

    for (const ch of chain) {
      const provider = deps.providers[ch];
      if (!provider) {
        // 通道在 chain 里却没构造出对应 provider——这是接线错误（例如漏配置
        // 某个通道），不是"这条通道本来就没配"的正常状态。静默 continue 会让
        // attempted 正常自增、minted=0、failures=[]，观测层面查不出原因；这里
        // 留一条记录，让接线错误在 TendResult 里可见。
        failures.push({ reason: "provider_missing", channel: ch });
        continue;
      }

      const out = await mintOne({
        provider,
        agnes: deps.agnes,
        tokenName: deps.config.tokenName,
        codeTimeoutMs: deps.config.codeTimeoutMs,
        maxDomainAttempts: deps.config.maxDomainAttempts,
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
        // **记在真正铸出来的那条通道名下**（评审 I8），不是主通道。
        mintedByChannel[ch] = (mintedByChannel[ch] ?? 0) + 1;
        // **如实报可疑**（Task 3 的 m5 裁定，Task 5 落地）。`isImportableKey` 此前
        // 只挂在面板导入这条「人点一下」的路径上，而**稳态下 key 进池子的主路径是
        // 这一行**——不对称是登记过的，处置不同是刻意的，但"不报"从来不是选项。
        if (!isImportableKey(out.key)) {
          failures.push({ reason: "key_suspicious", channel: ch });
          deps.logger.log({
            level: "error", event: "registrar.minted_key_suspicious",
            msg: "上游发回来的 key 含有不可打印字符或空白，已照常存进池子，但它多半每次被选中都会让转发失败"
              + "（拼进 authorization 头时会抛 TypeError）；请在面板上停用或删除它",
            // **不带明文**（约束 11(a)）：只报长度与通道，够运维定位、不够泄漏。
            fields: { channel: ch, keyLength: out.key.length },
          });
        }
        break;
      }

      failures.push({ reason: out.reason, channel: ch });

      // 只有通道本身坏了（建不出邮箱、列不出域名、收不到验证码）才值得降级到备
      // 通道；其余原因换通道也没用——域名被拒/账号链路失败打的都是同一个 Agnes
      // 后端，留给下一轮重试更省配额。upstream_error 需要单独处理：见下面那支。
      // 用 switch 而不是 `!== "provider_error"` 的一刀切，是为了让联合类型的
      // 穷尽检查（default 分支的 never）在 MintOutcome 新增 reason 时提醒这里
      // 也要决定怎么退避，而不是被默认行为悄悄吞掉。
      let tryFallback = false;
      switch (out.reason) {
        case "provider_error":
          // 通道级失败：列域名失败、凭据无效，以及「所有候选域名上都建不出邮箱」
          //（mintOne 把这三种都归到 provider_error）。设计 §4.5 承诺的正是这三种
          // 情况降级到备通道。
          tryFallback = true;
          break;
        case "rate_limited":
          // 撞上 Agnes 的注册限流（403）。mintOne 内部已经按 5 秒退避过并换了域名，
          // 这里不再加码：换通道打的还是同一个后端（没意义），整轮中止又会把恢复
          // 拖到下一个调度周期（默认 30 分钟）——而限流恰恰是"等一下就好"的那类
          // 故障。下一次尝试前本就有 mintDelay 的随机间隔。
          break;
        case "network_error":
          // 瞬时网络错误（DNS / TCP reset / TLS）：既不能断定这条通道坏了——它可能
          // 出在 Agnes 那五个请求里的任何一个，换通道打的还是同一个后端——也不足以
          // 判定上游整体故障而中止整轮。按设计 §7「一轮内单次失败不中断整轮」处理：
          // 本次作废，下一次尝试前本就有 mintDelay 的随机间隔。真正的通道级归因
          // 已经由 listDomains / createMailbox 那两条路径（provider_error）覆盖。
          break;
        case "code_timeout":
          // 验证码正是**经由这条邮箱通道**投递的，所以「收不到信」就是「这条通道
          // 现在产不出 key」——MX 记录失效、Cloudflare Email Routing 的 catch-all
          // 规则被删、上游把 Agnes 的发件方判成垃圾邮件，都是这个形态：API 全 2xx，
          // 建邮箱/删邮箱/列域名一切正常，只是信永远不到。此前它被归进「换通道也
          // 没用」那一组，于是备通道配好了却一次都不会被启用，key 池耗尽后网关整体
          // 不可用——与 C1 修复前的终态完全一致，只是起点从「建不出邮箱」换成了
          // 「收不到验证码」。
          //
          // 只做通道级降级，**不**在 mintOne 内部逐个域名重试（既有生产实现是后者）：
          // 换域名重试每次要额外花满 codeTimeoutMs（默认 120 秒），单次铸 key 最坏
          // 到 8×120 秒，远超 Worker Cron 的 900 秒墙钟；而 mintOne 每次进来都会重新
          // 洗牌域名，「个别域名 MX 坏了」这种情况靠下一次尝试重抽即可恢复，代价只
          // 有一个补池名额。真正换不回来的是**通道级**收信故障，那正是降级要解决的。
          tryFallback = true;
          break;
        case "domain_blocked_all":
        case "register_failed":
        case "login_failed":
        case "key_failed":
          break;
        case "upstream_error":
          // Agnes 后端整体故障（发验证码遇到非 400 的非 2xx），换通道打的还是
          // 同一个后端，没有意义；继续本轮只会在故障期间制造更多注定失败的
          // 请求。这里的退避是整轮级别的：立即结束这一轮 tend，把剩余名额
          // 留给下次调度（Task 7 的定时器），而不是硬着头皮把 mintBatch 耗完。
          abortRound = true;
          break;
        default: {
          const exhaustive: never = out.reason;
          throw new Error(`未处理的 MintOutcome.reason: ${String(exhaustive)}`);
        }
      }
      if (!tryFallback) break;
    }

    if (abortRound) break;
  }

  if (minted > 0) await reconcileAfterMint(deps);

  return {
    skipped: false, available, attempted, minted, mintedByChannel, failures,
    at: startedAt, primaryChannel: primary, durationMs: deps.now() - startedAt,
  };
}

/**
 * 本轮真的铸出 key 之后，**再对一次账**。成本是一次 `list`（外加一次 `get`），
 * 只在有产出的那些轮次付。
 *
 * 为什么非做不可：`KeyPoolRepo.indexAdd` 是**没有 CAS 的读-改-写**，而 KV 的边缘
 * 读缓存可能让它读到「对账刚修好之前」的那份索引，于是它把修复结果整个覆盖回去——
 * 同一轮里刚被捡回来的孤儿转眼又成了孤儿。
 *
 * 连带后果比「索引脏了」严重得多：孤儿不被 `all()` 看到 ⇒ 上面第 86 行算出的可用数
 * 偏小 ⇒ 缺口被高估 ⇒ **超额补铸**，而每铸一把都是一次真实的 Agnes 建号，同时撞
 * 注册风控与邮箱建号限流（YYDS 15 个 / MoeMail 30 个上限）。补铸出来的 key 还会
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
