import type { Mailbox } from "../core/registrar/types.js";

/**
 * 临时邮箱服务。两家实现的差异（列表接口带不带正文、用地址还是 id 定位）全部封在
 * 适配器内部，`mintOne` 对它们一视同仁。
 */
export interface MailProvider {
  readonly name: "yyds" | "moemail";
  /** 可用域名。Agnes 会按域名屏蔽一次性邮箱，调用方需要多个域名可轮换。 */
  listDomains(): Promise<string[]>;
  createMailbox(domain: string): Promise<Mailbox>;
  /** 轮询验证码。超时返回 null 而不抛错。 */
  pollCode(mailbox: Mailbox, timeoutMs: number): Promise<string | null>;
  /** 用完即删。失败只应记日志，不影响已拿到的结果。 */
  deleteMailbox(mailbox: Mailbox): Promise<void>;
}
