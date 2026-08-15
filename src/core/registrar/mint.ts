import type { MailProvider } from "../../ports/mailbox.js";
import type { Mailbox } from "./types.js";
import { sendCode, register, login, createKey, randomPassword, type AgnesDeps } from "./agnes.js";

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
        | "provider_error";
    };

export interface MintDeps {
  provider: MailProvider;
  agnes: AgnesDeps;
  tokenName: string;
  codeTimeoutMs: number;
  maxDomainAttempts: number;
  /** 随机源，可选，默认 `Math.random`。注入后域名洗牌与密码生成都可确定性断言。 */
  rand?: () => number;
}

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
    console.warn("[agnes2api] 列域名失败", err);
    return { ok: false, reason: "provider_error" };
  }
  if (domains.length === 0) return { ok: false, reason: "provider_error" };

  const candidates = shuffle(domains, rand).slice(0, deps.maxDomainAttempts);
  // 400 是"域名被 Agnes 屏蔽"的真实信号；其他非 2xx（例如上游整体宕机返回 500）
  // 混进来的话，轮完所有域名后如果一律归因于 domain_blocked_all，会让调用方把
  // "上游故障"误判成"换个域名就好"，据此做的退避决策会决策错。用这个标记把两者
  // 分开，只要出现过一次非 400 的非 2xx，就不能再声称"域名全被屏蔽"。
  let sawUpstreamError = false;

  for (const domain of candidates) {
    let mailbox: Mailbox;
    try {
      mailbox = await deps.provider.createMailbox(domain);
    } catch (err) {
      console.warn(`[agnes2api] 建临时邮箱失败，换下一个域名：${domain}`, err);
      continue; // 这个域名建不出邮箱，换下一个
    }

    try {
      const status = await sendCode(deps.agnes, mailbox.address);
      // 400 = Agnes 屏蔽了该域名。这是域名轮换赖以工作的信号，不是错误。
      if (status === 400) continue;
      if (status < 200 || status >= 300) {
        sawUpstreamError = true;
        console.warn(`[agnes2api] 发验证码遇到非 2xx 非域名屏蔽的状态码，换下一个域名：${domain} status=${status}`);
        continue;
      }

      const code = await deps.provider.pollCode(mailbox, deps.codeTimeoutMs);
      if (!code) return { ok: false, reason: "code_timeout" };

      const password = randomPassword(rand);
      if (!(await register(deps.agnes, mailbox.address, password, code))) {
        return { ok: false, reason: "register_failed" };
      }
      const token = await login(deps.agnes, mailbox.address, password);
      if (!token) return { ok: false, reason: "login_failed" };

      const key = await createKey(deps.agnes, token, deps.tokenName);
      if (!key) return { ok: false, reason: "key_failed" };

      // 账号密码到此为止，不返回也不持久化（设计文档 §4.3）。
      return { ok: true, key };
    } finally {
      // 用完即删：YYDS 免费档最多同时存在 15 个邮箱，中途任何一步失败都必须把
      // 临时邮箱删掉，否则很快就申请不到新邮箱。deleteMailbox 按端口契约本就
      // 不应抛错（两家适配器内部已各自吞掉删除失败并只记日志），这里仍防御一
      // 层：cleanup 本身出错不该掩盖 try 块已经产出的返回值或异常。
      try {
        await deps.provider.deleteMailbox(mailbox);
      } catch (err) {
        console.warn(`[agnes2api] 删临时邮箱失败（残留不影响已拿到的结果）：${mailbox.address}`, err);
      }
    }
  }

  return sawUpstreamError
    ? { ok: false, reason: "upstream_error" }
    : { ok: false, reason: "domain_blocked_all" };
}
