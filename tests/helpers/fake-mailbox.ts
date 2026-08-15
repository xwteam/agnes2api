import type { MailProvider } from "../../src/ports/mailbox.js";
import type { Mailbox } from "../../src/core/registrar/types.js";

export interface FakeMailOptions {
  domains?: string[];
  code?: string | null;
  failCreateOn?: string[];
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

  async deleteMailbox(m: Mailbox): Promise<void> {
    this.deleted.push(m.address);
  }
}
