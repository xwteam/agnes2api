import type { KeyPoolRepo } from "../dispatcher.js";
import type { MailProvider } from "../../ports/mailbox.js";
import type { AgnesDeps } from "./agnes.js";
import type { RegistrarConfig, Channel } from "./config.js";
import { requirePrimary } from "./config.js";
import { isAvailable } from "../keypool.js";
import { mintOne, type MintOutcome } from "./mint.js";

/**
 * 一次铸 key 失败的归因：`mintOne` 给出的所有 reason，外加 `provider_missing`
 *（它不是 mintOne 的产物——表示 chain 里的通道压根没构造出 provider，是接线错误）。
 *
 * 用联合类型而不是裸 `string`：下面的 switch 特意用 `never` 做了穷尽检查，好让
 * `MintOutcome` 新增 reason 时编译期就提醒这里表态；如果对外的 `TendResult` 把
 * 类型信息退化成 string，P3 消费这份结构时就拿不到同样的穷尽保障了。
 */
export type TendFailureReason = Extract<MintOutcome, { ok: false }>["reason"] | "provider_missing";

export interface TendResult {
  skipped: boolean;
  available: number;
  attempted: number;
  minted: number;
  failures: Array<{ reason: TendFailureReason; channel: string }>;
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
  if (!deps.config.enabled) {
    return { skipped: true, available: 0, attempted: 0, minted: 0, failures: [] };
  }

  const now = deps.now();
  const available = (await deps.repo.all()).filter((r) => isAvailable(r, now)).length;
  const need = deps.config.targetKeys - available;
  if (need <= 0) {
    return { skipped: false, available, attempted: 0, minted: 0, failures: [] };
  }

  // 用 requirePrimary() 而不是裸读 deps.config.primary：后者的类型虽然声明为非空
  // Channel，但 enabled=false 时运行时其实是 null，裸读拿到的要么是运行时 null、
  // 要么是往下传导致的无上下文异常。此处 enabled 已在上面判过为 true，primary
  // 理应有值，但仍统一走这条安全访问器，不给「以后这段代码被挪到别处、判断被
  // 不小心删掉」留退路。
  const primary = requirePrimary(deps.config);
  const chain: Channel[] = deps.config.fallback ? [primary, deps.config.fallback] : [primary];

  const rounds = Math.min(need, deps.config.mintBatch);
  const failures: TendResult["failures"] = [];
  let attempted = 0;
  let minted = 0;

  for (let i = 0; i < rounds; i++) {
    if (i > 0) {
      // 顺序铸并插入随机间隔：并发会同时撞邮箱服务的建号限流与上游的注册风控。
      const span = Math.max(0, deps.config.mintDelayMaxMs - deps.config.mintDelayMinMs);
      await deps.sleep(deps.config.mintDelayMinMs + Math.floor(deps.rand() * span));
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
      });

      if (out.ok) {
        await deps.repo.add(out.key);
        minted++;
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

  return { skipped: false, available, attempted, minted, failures };
}
