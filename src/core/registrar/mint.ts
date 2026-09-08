import type { MailProvider } from "../../ports/mailbox.js";
import type { Mailbox } from "./types.js";
import { sendCode, register, login, createKey, randomPassword, type AgnesDeps } from "./agnes.js";
import type { Logger } from "../../ports/logger.js";
import type { BackoffKind } from "./backoff.js";
import {
  classifySendCode, edgeMarker, upstreamMessage, isKnownGood, recordVerdict,
  type DomainJournal, type DomainLedger,
} from "./domain-ledger.js";

export type MintOutcome =
  | { ok: true; key: string }
  /**
   * **撞上了限流。** `limitKind` 说的是撞的是哪一层（边缘 / 应用），
   * **两层的处置在 `./tender.ts` 里是同一个**（立刻结束整轮 + 记退避），
   * 它只用来选面板文案与事件字段——所以 `TendFailureReason` 里没有为它们各加一个成员。
   */
  | { ok: false; reason: "rate_limited"; limitKind: BackoffKind; marker: string | null }
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
        | "network_error";
    };

export interface MintDeps {
  provider: MailProvider;
  agnes: AgnesDeps;
  tokenName: string;
  codeTimeoutMs: number;
  /**
   * 这一次尝试要按顺序试的域名。
   *
   * ⚠️⚠️ **域名不再由本函数去列、也不再由本函数洗牌。** 从前每个名额都
   * `provider.listDomains()` 一次（一轮 5 次白花）再 `shuffle().slice()`，于是
   * **「这个域名上一轮刚被拒过」这条干净可靠的信号一次都没被记住**：下一轮重新洗牌，
   * 可能再撞同一批已知不行的域名，而每撞一次都要真建一个临时邮箱、真打一次发码请求。
   * 现在由 `./tender.ts` 在**轮开头**列一次域名、按 `./domain-ledger.ts` 的
   * `selectDomains` 排好序传进来。
   */
  candidates: readonly string[];
  /**
   * 这一轮的域名观测本子。**本函数只往里追加，一次存储都不碰**——落盘统一由
   * `tendOnce` 的收尾做（一轮最多 1 次 put）。
   */
  journal: DomainJournal;
  /** 当前台账。**只读**，本函数拿它做「已知 ok 的域名回 400」那道保险。 */
  ledger: DomainLedger;
  /** 这一轮开始的时刻。判 `ok` 结论过没过期要它。 */
  now: number;
  /** 换域名之间的随机间隔下界 / 上界。**与两次铸 key 之间复用同一对旋钮，不新增第三个。** */
  mintDelayMinMs: number;
  mintDelayMaxMs: number;
  /** 由调用方注入——core 不自己起定时器。 */
  sleep: (ms: number) => Promise<void>;
  /** 随机源，可选，默认 `Math.random`。注入后域内间隔与密码生成都可确定性断言。 */
  rand?: () => number;
  /** 事件日志 sink，由调用方注入——core 不直接碰 console。 */
  logger: Logger;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function mintOne(deps: MintDeps): Promise<MintOutcome> {
  const rand = deps.rand ?? Math.random;

  const candidates = deps.candidates;
  if (candidates.length === 0) return { ok: false, reason: "provider_error" };

  // ⚠️⚠️ **`400` 有两种含义**（域名被屏蔽 / 出口被限流），由
  // `./domain-ledger.ts` 的 `classifySendCode` 分辨，**而那是启发式的负向匹配**
  //（「正文不像限流就算屏蔽」）——上游改一次文案它就会漏。这句话不是修辞，
  // 它决定了下面「已知 ok 的域名回 400 就不判死」那道保险为什么必须在。
  //
  // 其他非 2xx（例如上游整体宕机返回 500）混进来的话，轮完所有域名后如果一律
  // 归因于 domain_blocked_all，会让调用方把"上游故障"误判成"换个域名就好"，
  // 据此做的退避决策会决策错。用这个标记把两者分开。
  let sawUpstreamError = false;
  // 「所有候选域名上都建不出邮箱」是**通道级**失败（凭据失效、活跃邮箱配额耗尽、
  // 邮箱服务本身挂了），不是域名问题：它与「列域名失败」「凭据无效」是同一类
  // ——**这条通道现在产不出邮箱**。此前这条路径一律 continue、轮完后返回
  // domain_blocked_all，于是日志把排障引向域名方向，而域名一个都没问题。
  // 用这个标记把两者分开。
  //
  // ⚠️⚠️ **别再照着上一版读成「该降级到备通道」。** 两条邮箱通道今天是**二选一**，
  // 一条通道失败**绝不会**去碰另一条（`./tender.ts` 那个 switch 上方逐字写着这条，
  // 连它的固有代价也一起登记在那里）。这里区分通道级失败与域名级失败，剩下的价值
  // 只有一条：**把排障方向说对**（去看通道的凭据/配额/服务，而不是去看域名）。
  //
  // 复用 provider_error 而不是新增 reason：tender 对这几种 reason 的处置完全一致
  //（本次名额作废、本轮下一个名额照常开始），且它们的语义本来就是同一句话。
  // 多一个 reason 只会让 tender 的 switch 多一支相同的分支。
  let createdAny = false;

  for (let i = 0; i < candidates.length; i++) {
    const domain = candidates[i]!;

    // ⚠️ **换域名之前必须真的等一下。** 从前这里是裸 `continue`（零间隔连打），
    // 而实测的边缘限流正是被「无间隔连发」触发的：一个全新出口连发到第 3 次就开始
    // 429。默认配置下 `maxDomainAttempts = 1`，这一段一次都走不到；只有运维把它
    // 调大时才生效——那时它是唯一挡着「一个名额里连打好几次」的东西。
    if (i > 0) {
      const span = Math.max(0, deps.mintDelayMaxMs - deps.mintDelayMinMs);
      await deps.sleep(deps.mintDelayMinMs + Math.floor(rand() * span));
    }

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
      const r = await sendCode(deps.agnes, mailbox.address);
      const verdict = classifySendCode(r.status, r.body);

      if (verdict === "rate_limited_edge" || verdict === "rate_limited_app") {
        // 🔴 **当场结束这一次尝试，不换域名、不 sleep、不记任何域名结论。**
        // 从前这里是「等 5 秒换下一个域名接着打」，而两层限流的惩罚窗口都远比
        // 5 秒长，且**窗口里每打一次就把窗口续一次** —— 那 5 秒之后的每一次请求
        // 都只是在把恢复时刻往后推。整轮怎么停、退避怎么记，见 `./tender.ts`。
        return {
          ok: false, reason: "rate_limited",
          limitKind: verdict === "rate_limited_edge" ? "edge" : "app",
          marker: verdict === "rate_limited_edge" ? edgeMarker(r.body) : null,
        };
      }

      if (verdict === "domain_blocked") {
        // 🔴 **第二道保险：上周还能过的域名今天回 400，更可能是撞了出口限流。**
        // 两边的代价严重不对称——误判成限流只是这一轮少铸几把（下一轮就回来），
        // 误判成域名屏蔽会把一个真好用的域名从候选前排踢下去。
        if (isKnownGood(deps.ledger, domain, deps.now)) {
          deps.logger.log({
            level: "warn", event: "registrar.known_good_domain_rejected",
            msg: "一个已知能用的域名这次被拒了，按出口限流处理而不是把它判成被屏蔽"
              + "（两边代价不对称：判错限流只慢一轮，判错域名会把好域名踢下去）",
            fields: { domain, message: upstreamMessage(r.body, mailbox.address) },
          });
          return { ok: false, reason: "rate_limited", limitKind: "app", marker: null };
        }
        // 上游那句话跟着这条判定进本子：**只有第二跳判死那条事件会把它说出来**，
        // 而它是「上游改了限流文案」这个核心风险唯一的现场证据。
        recordVerdict(deps.journal, domain, "blocked", upstreamMessage(r.body, mailbox.address));
        continue;
      }

      if (verdict === "unreadable") {
        // 正文里没有任何可判据的东西 ⇒ **不产生任何域名判定**，当次只换下一个域名。
        // 与台账出现之前的行为逐字一致。
        deps.logger.log({
          level: "warn", event: "registrar.send_code_unclassified",
          msg: "发验证码回了 400 但正文是空的，分不出是域名被屏蔽还是出口被限流，本次不记任何域名结论",
          fields: { domain },
        });
        continue;
      }

      if (verdict === "upstream_error") {
        sawUpstreamError = true;
        deps.logger.log({
          level: "warn", event: "registrar.send_code_bad_status",
          msg: "发验证码遇到非 2xx 非域名屏蔽的状态码，换下一个域名",
          fields: { domain, status: r.status },
        });
        continue;
      }

      // 2xx —— **这是一条干净可靠的证据**，无条件覆盖回 `ok`。
      recordVerdict(deps.journal, domain, "ok");

      // 下面四条 warn 是同一条发现的另一半：这四种 reason 此前是**完全静默**返回的，
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
      // `TendResult` 也拿不到（面板要展示的就是它）。而单次铸 key 光轮询验证码
      // 就要打约 40 次请求，120 秒窗口内撞一次瞬时网络错误是常态，不该是"整轮报废"
      // 级别的事件。收敛成一个 reason 交回给 tender，由它决定怎么退避。
      //
      // ⚠️ **网络层错误一条域名结论都不记**：它说明的是「这次请求没走通」，
      // 不是「上游怎么看这个域名」。把它接进台账等于用噪声污染证据。
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
    //
    // ⚠️ **msg 里不许出现「可降级到备通道」那半句。** 它是 `EVENT_RING_SIZE` 那个
    // 事件环里的一条 warn ⇒ 会渲染进面板的事件板块、进容器 stdout、进
    // `GET /admin/api/events/download`。两条通道改成二选一之后，这一轮乃至这一天
    // 都不会自动换通道（`./tender.ts`），面板照着旧文案说一遍，运维就会「等它自己
    // 切过去」而实际上永远不会切 —— 那是把一个要人管的故障说成了自愈的故障。
    deps.logger.log({
      level: "warn", event: "registrar.no_mailbox_on_any_domain",
      msg: "候选域名上都建不出临时邮箱，按通道级失败处理：本次名额作废，"
        + "不会自动改用另一条通道；请去查这条通道的凭据、活跃邮箱配额与服务状态",
      fields: { candidates: candidates.length },
    });
    return { ok: false, reason: "provider_error" };
  }

  // 归因优先级：宕机 > 域名屏蔽。限流不在这里——它当场 return，根本走不到这一行。
  if (sawUpstreamError) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "domain_blocked_all" };
}
