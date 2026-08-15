import type { MailProvider } from "../ports/mailbox.js";
import type { Mailbox } from "../core/registrar/types.js";
import type { Fetcher } from "../ports/fetcher.js";
import { extractCode } from "../core/registrar/code.js";

export interface YydsDeps {
  fetcher: Fetcher;
  baseUrl: string;
  apiKey: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const LOCAL_PART_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const POLL_INTERVAL_MS = 3000;

export class YydsProvider implements MailProvider {
  readonly name = "yyds" as const;
  constructor(private readonly deps: YydsDeps) {}

  private headers(): Record<string, string> {
    return { "X-API-Key": this.deps.apiKey, "content-type": "application/json" };
  }

  async listDomains(): Promise<string[]> {
    const r = await this.deps.fetcher.fetch(`${this.deps.baseUrl}/v1/domains`, {
      method: "GET", headers: this.headers(),
    });
    if (!r.ok) throw new Error(`YYDS 列域名失败: HTTP ${r.status}`);
    const data = (await r.json()) as Record<string, any>;
    return ((data?.data ?? []) as Array<{ domain?: string }>)
      .map((d) => d?.domain)
      .filter((d): d is string => typeof d === "string" && d.length > 0);
  }

  async createMailbox(domain: string): Promise<Mailbox> {
    let lp = "u";
    for (let i = 0; i < 10; i++) {
      lp += LOCAL_PART_ALPHABET[Math.floor(Math.random() * LOCAL_PART_ALPHABET.length)]!;
    }
    const r = await this.deps.fetcher.fetch(`${this.deps.baseUrl}/v1/accounts`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ localPart: lp, domain }),
    });
    if (!r.ok) throw new Error(`YYDS 建邮箱失败: HTTP ${r.status}`);
    const data = (await r.json()) as Record<string, any>;
    const address = data?.data?.address;
    if (typeof address !== "string") throw new Error("YYDS 建邮箱响应缺少 data.address");
    // YYDS 用地址本身定位邮箱，故 handle 与 address 相同。
    return { address, handle: address };
  }

  async pollCode(mailbox: Mailbox, timeoutMs: number): Promise<string | null> {
    const start = this.deps.now();
    const seen = new Set<string>();
    while (this.deps.now() - start < timeoutMs) {
      const listUrl = `${this.deps.baseUrl}/v1/messages?address=${encodeURIComponent(mailbox.handle)}`;
      const lr = await this.deps.fetcher.fetch(listUrl, { method: "GET", headers: this.headers() });
      if (lr.ok) {
        const listJson = (await lr.json()) as Record<string, any>;
        const raw = listJson?.data;
        const msgs = Array.isArray(raw) ? raw : raw?.messages;
        for (const m of (msgs ?? []) as Array<{ id?: string }>) {
          const id = m?.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const dUrl = `${this.deps.baseUrl}/v1/messages/${encodeURIComponent(id)}?address=${encodeURIComponent(mailbox.handle)}`;
          const dr = await this.deps.fetcher.fetch(dUrl, { method: "GET", headers: this.headers() });
          if (!dr.ok) continue;
          const detail = ((await dr.json()) as Record<string, any>)?.data ?? {};
          if (detail.verificationCode) return String(detail.verificationCode);
          const code = extractCode(detail.subject ?? "", `${detail.text ?? ""} ${detail.html ?? ""}`);
          if (code) return code;
        }
      }
      await this.deps.sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  async deleteMailbox(mailbox: Mailbox): Promise<void> {
    try {
      await this.deps.fetcher.fetch(
        `${this.deps.baseUrl}/v1/accounts/${encodeURIComponent(mailbox.handle)}`,
        { method: "DELETE", headers: this.headers() },
      );
    } catch {
      // 用完即删是尽力而为：key 已经拿到了，邮箱残留是次要问题。
    }
  }
}
