import type { CredentialProof, MailProvider } from "../../src/ports/mailbox.js";
import type { Mailbox } from "../../src/core/registrar/types.js";

export interface FakeMailOptions {
  domains?: string[];
  code?: string | null;
  failCreateOn?: string[];
  /** `deleteMailbox` 报「没删掉」。缺省是删得掉。 */
  deleteFails?: boolean;
  /** `verifyCredentials` 抛这个错。缺省是凭据可用。 */
  verifyThrows?: unknown;
}

export class FakeMailProvider implements MailProvider {
  readonly name = "yyds" as const;
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  constructor(private readonly opts: FakeMailOptions = {}) {}

  async listDomains(): Promise<string[]> {
    return this.opts.domains ?? ["a.test", "b.test", "c.test"];
  }

  async createMailbox(domain: string): Promise<Mailbox> {
    if (this.opts.failCreateOn?.includes(domain)) throw new Error(`建邮箱失败: ${domain}`);
    const address = `u${this.created.length}@${domain}`;
    this.created.push(address);
    return { address, handle: address };
  }

  async pollCode(): Promise<string | null> {
    return this.opts.code === undefined ? "123456" : this.opts.code;
  }

  /**
   * ⚠️ **返回的是「确认删掉了没有」**（端口契约）。缺省 `true`；
   * `deleteFails` 打开时**照样记进 `deleted`**——「调过了」与「删掉了」是两件事，
   * 合成一个信号的话「调了但没删掉」这一档就不可观测了。
   */
  async deleteMailbox(m: Mailbox): Promise<boolean> {
    this.deleted.push(m.address);
    return this.opts.deleteFails !== true;
  }

  /**
   * **形态照抄 YYDS 那条实现：建一个再删掉。** 走真的 `createMailbox` /
   * `deleteMailbox` 而不是直接 `return { cleaned: true }`，这样「名额消耗」与
   * 「残留清理」在 `created` / `deleted` 上都是可观测的。
   */
  async verifyCredentials(domain: string): Promise<CredentialProof> {
    if (this.opts.verifyThrows !== undefined) throw this.opts.verifyThrows;
    const mailbox = await this.createMailbox(domain);
    return { cleaned: await this.deleteMailbox(mailbox) };
  }
}
