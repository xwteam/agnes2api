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
  /** 随机源，可选，默认 `Math.random`。注入后 `createMailbox` 的 localPart 可确定性断言。 */
  rand?: () => number;
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
    const rand = this.deps.rand ?? Math.random;
    let lp = "u";
    for (let i = 0; i < 10; i++) {
      lp += LOCAL_PART_ALPHABET[Math.floor(rand() * LOCAL_PART_ALPHABET.length)]!;
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
        // 列表响应偶发 200 但 body 非 JSON（网关超时页等），解析失败按未取到消息处理，
        // 不中断整条轮询——与 `!lr.ok` 时"本轮跳过、继续轮询"的设计意图保持一致。
        let listJson: Record<string, any> | null = null;
        try {
          listJson = (await lr.json()) as Record<string, any>;
        } catch {
          listJson = null;
        }
        const raw = listJson?.data;
        const msgs = Array.isArray(raw) ? raw : raw?.messages;
        for (const m of (msgs ?? []) as Array<{ id?: string }>) {
          const id = m?.id;
          if (!id || seen.has(id)) continue;
          const dUrl = `${this.deps.baseUrl}/v1/messages/${encodeURIComponent(id)}?address=${encodeURIComponent(mailbox.handle)}`;
          const dr = await this.deps.fetcher.fetch(dUrl, { method: "GET", headers: this.headers() });
          // 拉详情失败（HTTP 非 2xx 或响应体非 JSON）不标记 seen：这封邮件可能已经
          // 到达，只是这次请求恰好撞上第三方 API 的瞬时错误，下一轮还要能重试，
          // 否则验证码邮件会被永久跳过、一路空转到超时。
          if (!dr.ok) continue;
          let detail: Record<string, any>;
          try {
            detail = ((await dr.json()) as Record<string, any>)?.data ?? {};
          } catch {
            continue;
          }
          // 详情已成功拿到并解析，这封邮件的处理结果（无论有没有码）不会再变，
          // 才标记 seen 避免重复请求。
          seen.add(id);
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
    } catch (err) {
      // 用完即删是尽力而为：key 已经拿到了，邮箱残留是次要问题，不该让整次铸 key
      // 失败，但要留痕方便观测残留是否在堆积。沿用 P1 既有先例（无日志端口，直接
      // console，参见 src/core/storage-health.ts）。
      console.warn(`[agnes2api] YYDS 删邮箱失败（残留不影响已拿到的结果）：${mailbox.address}`, err);
    }
  }
}
