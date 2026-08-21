import type { MailProvider } from "../../ports/mailbox.js";
import type { Mailbox } from "./types.js";
import { sendCode, register, login, createKey, randomPassword, type AgnesDeps } from "./agnes.js";
import type { Logger } from "../../ports/logger.js";

export type MintOutcome =
  | { ok: true; key: string }
  | {
      ok: false;
      reason:
        | "domain_blocked_all"
        | "upstream_error"
        | "code_timeout"
        | "register_failed"
        | "login_failed"
        | "key_failed"
        | "provider_error"
        | "network_error"
        | "rate_limited";
    };

export interface MintDeps {
  provider: MailProvider;
  agnes: AgnesDeps;
  tokenName: string;
  codeTimeoutMs: number;
  maxDomainAttempts: number;
  /** 撞上限流（403）后的等待，由调用方注入——core 不自己起定时器。 */
  sleep: (ms: number) => Promise<void>;
  /** 随机源，可选，默认 `Math.random`。注入后域名洗牌与密码生成都可确定性断言。 */
  rand?: () => number;
  /** 事件日志 sink，由调用方注入——core 不直接碰 console。 */
  logger: Logger;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 撞上限流后的等待时长。取自既有生产实现（跑了一个多月）里 `403 → sleep(5000)`
 * 的同款处置：限流与宕机的正确退避不一样——前者等一下再换个域名试就能过去，
 * 后者继续尝试只是在故障期间制造更多注定失败的请求。
 */
const RATE_LIMIT_BACKOFF_MS = 5_000;

/** Fisher-Yates 洗牌，随机源注入以便测试可复现。 */
function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export async function mintOne(deps: MintDeps): Promise<MintOutcome> {
  const rand = deps.rand ?? Math.random;

  let domains: string[];
  try {
    domains = await deps.provider.listDomains();
  } catch (err) {
    deps.logger.log({
      level: "warn", event: "registrar.list_domains_failed",
      msg: "列域名失败", fields: { err: errMsg(err) },
    });
    return { ok: false, reason: "provider_error" };
  }
  if (domains.length === 0) return { ok: false, reason: "provider_error" };

  const candidates = shuffle(domains, rand).slice(0, deps.maxDomainAttempts);
  // 400 是"域名被 Agnes 屏蔽"的真实信号；其他非 2xx（例如上游整体宕机返回 500）
  // 混进来的话，轮完所有域名后如果一律归因于 domain_blocked_all，会让调用方把
  // "上游故障"误判成"换个域名就好"，据此做的退避决策会决策错。用这个标记把两者
  // 分开，只要出现过一次非 400 的非 2xx，就不能再声称"域名全被屏蔽"。
  let sawUpstreamError = false;
  // 「所有候选域名上都建不出邮箱」是**通道级**失败（凭据失效、活跃邮箱配额耗尽、
  // 邮箱服务本身挂了），不是域名问题：设计 §4.5 与五语言用户文档都把「连续建邮箱
  // 失败」与「列域名失败、凭据无效」并列为该降级到备通道的三种通道级失败。此前这条
  // 路径一律 continue、轮完后返回 domain_blocked_all，而 tender 把 domain_blocked_all
  // 归入「换通道也没用」，于是备通道明明配好了却永远不会被启用，日志还把排障引向
  // 域名方向。用这个标记把两者分开。
  //
  // 复用 provider_error 而不是新增 reason：tender 对它的处置（降级到备通道）与这里
  // 需要的完全一致，且 listDomains 失败、凭据无效走的也是同一个语义——「这条通道
  // 现在产不出邮箱」。多一个 reason 只会让 tender 的 switch 多一支相同的分支。
  let createdAny = false;
  let sawRateLimited = false;

  for (const domain of candidates) {
    let mailbox: Mailbox;
    try {
      mailbox = await deps.provider.createMailbox(domain);
    } catch (err) {
      deps.logger.log({
        level: "warn", event: "registrar.create_mailbox_failed",
        msg: "建临时邮箱失败，换下一个域名", fields: { domain, err: errMsg(err) },
      });
      continue; // 这个域名建不出邮箱，换下一个
    }
    createdAny = true;

    try {
      const status = await sendCode(deps.agnes, mailbox.address);
      // 400 = Agnes 屏蔽了该域名。这是域名轮换赖以工作的信号，不是错误。
      if (status === 400) continue;
      if (status === 403) {
        // 限流。移植时它被并进了"非 2xx 一律当上游错误"，可两者的正确退避不同：
        // 上游宕机要整轮中止（见下面那支），限流只要等一下再换个域名。
        sawRateLimited = true;
        await deps.sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      if (status < 200 || status >= 300) {
        sawUpstreamError = true;
        deps.logger.log({
          level: "warn", event: "registrar.send_code_bad_status",
          msg: "发验证码遇到非 2xx 非域名屏蔽的状态码，换下一个域名", fields: { domain, status },
        });
        continue;
      }

      // 下面四条 warn 是 M2 的另一半：这四种 reason 此前是**完全静默**返回的，
      // 运维在日志里只能看到收尾那行 minted=0。四条各自指向完全不同的处置——
      // 邮件没到（通道/MX）、Agnes 加了人机校验、Agnes 改了登录响应、建 key 接口
      // 变了——不留痕就只能靠猜。
      const code = await deps.provider.pollCode(mailbox, deps.codeTimeoutMs);
      if (!code) {
        deps.logger.log({
          level: "warn", event: "registrar.code_timeout",
          msg: "等待验证码超时，这条邮箱通道收不到 Agnes 的信",
          fields: { address: mailbox.address, codeTimeoutMs: deps.codeTimeoutMs },
        });
        return { ok: false, reason: "code_timeout" };
      }

      const password = randomPassword(rand);
      if (!(await register(deps.agnes, mailbox.address, password, code))) {
        deps.logger.log({
          level: "warn", event: "registrar.register_rejected",
          msg: "Agnes 注册被拒（验证码已正常收到）", fields: { address: mailbox.address },
        });
        return { ok: false, reason: "register_failed" };
      }
      const token = await login(deps.agnes, mailbox.address, password);
      if (!token) {
        deps.logger.log({
          level: "warn", event: "registrar.login_no_token",
          msg: "Agnes 登录未返回令牌（账号已注册成功）", fields: { address: mailbox.address },
        });
        return { ok: false, reason: "login_failed" };
      }

      const key = await createKey(deps.agnes, token, deps.tokenName);
      if (!key) {
        deps.logger.log({
          level: "warn", event: "registrar.key_not_returned",
          msg: "Agnes 建 key 未返回 key（注册与登录都成功）",
          fields: { address: mailbox.address, tokenName: deps.tokenName },
        });
        return { ok: false, reason: "key_failed" };
      }

      // 账号密码到此为止，不返回也不持久化（设计文档 §4.3）。
      return { ok: true, key };
    } catch (err) {
      // 上面五处 `fetcher.fetch`（发码、轮询、注册、登录、建 key）任何一处 reject
      // ——`NativeFetcher` 就是裸 `fetch`，DNS 失败 / TCP reset / TLS 错误都 reject
      // ——此前会直接穿透 mintOne，让 tendOnce 整轮 reject：剩余名额全部作废，
      // `TendResult` 也拿不到（P3 面板要展示的就是它）。而单次铸 key 光轮询验证码
      // 就要打约 40 次请求，120 秒窗口内撞一次瞬时网络错误是常态，不该是"整轮报废"
      // 级别的事件。收敛成一个 reason 交回给 tender，由它决定怎么退避。
      deps.logger.log({
        level: "warn", event: "registrar.network_error",
        msg: "铸 key 过程中出现网络层错误，本次作废", fields: { domain, err: errMsg(err) },
      });
      return { ok: false, reason: "network_error" };
    } finally {
      // 用完即删：两条通道**各自**都有活跃邮箱上限（各自的数字、出处与"它们都不是
      // 常数"这件事，见 `src/adapters/mailbox-yyds.ts` 与
      // `src/adapters/mailbox-moemail.ts` 的文件头，本文件不复述数字），中途任何
      // 一步失败都必须把临时邮箱删掉，否则很快就申请不到新邮箱。
      // deleteMailbox 按端口契约本就
      // 不应抛错（两家适配器内部已各自吞掉删除失败并只记日志），这里仍防御一
      // 层：cleanup 本身出错不该掩盖 try 块已经产出的返回值或异常。
      try {
        await deps.provider.deleteMailbox(mailbox);
      } catch (err) {
        deps.logger.log({
          level: "warn", event: "registrar.delete_mailbox_failed",
          msg: "删临时邮箱失败（残留不影响已拿到的结果）",
          fields: { address: mailbox.address, err: errMsg(err) },
        });
      }
    }
  }

  if (!createdAny) {
    // 一个邮箱都没建出来，说明连「让 Agnes 看一眼这个域名」的机会都没有过，
    // 谈不上域名被屏蔽。这条日志要能把运维引向邮箱通道（凭据/配额/服务），
    // 而不是域名。
    deps.logger.log({
      level: "warn", event: "registrar.no_mailbox_on_any_domain",
      msg: "候选域名上都建不出临时邮箱，按通道级失败处理（可降级到备通道）",
      fields: { candidates: candidates.length },
    });
    return { ok: false, reason: "provider_error" };
  }

  // 归因优先级：宕机 > 限流 > 域名屏蔽。出现过一次非 400/403 的非 2xx 就说明后端
  // 真的有问题，那时"再等一会儿"的判断不成立，应该让 tender 中止整轮。
  if (sawUpstreamError) return { ok: false, reason: "upstream_error" };
  if (sawRateLimited) return { ok: false, reason: "rate_limited" };
  return { ok: false, reason: "domain_blocked_all" };
}
