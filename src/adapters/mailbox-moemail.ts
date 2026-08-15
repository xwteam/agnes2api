import type { MailProvider } from "../ports/mailbox.js";
import type { Mailbox } from "../core/registrar/types.js";
import type { Fetcher } from "../ports/fetcher.js";
import { extractCode } from "../core/registrar/code.js";

export interface MoeMailDeps {
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
/** 邮箱只用来收一次验证码，一小时足够，也便于服务端自行回收。 */
const MAILBOX_TTL_MS = 3_600_000;

export class MoeMailProvider implements MailProvider {
  readonly name = "moemail" as const;
  constructor(private readonly deps: MoeMailDeps) {}

  private headers(): Record<string, string> {
    return { "X-API-Key": this.deps.apiKey, "content-type": "application/json" };
  }

  async listDomains(): Promise<string[]> {
    const r = await this.deps.fetcher.fetch(`${this.deps.baseUrl}/api/config`, {
      method: "GET", headers: this.headers(),
    });
    if (!r.ok) throw new Error(`MoeMail 列域名失败: HTTP ${r.status}`);
    const data = (await r.json()) as Record<string, any>;
    // MoeMail 用逗号分隔的字符串返回域名，与 YYDS 的数组形态不同。
    return String(data?.emailDomains ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
  }

  async createMailbox(domain: string): Promise<Mailbox> {
    const rand = this.deps.rand ?? Math.random;
    let name = "u";
    for (let i = 0; i < 10; i++) {
      name += LOCAL_PART_ALPHABET[Math.floor(rand() * LOCAL_PART_ALPHABET.length)]!;
    }
    const r = await this.deps.fetcher.fetch(`${this.deps.baseUrl}/api/emails/generate`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ name, expiryTime: MAILBOX_TTL_MS, domain }),
    });
    if (!r.ok) throw new Error(`MoeMail 建邮箱失败: HTTP ${r.status}`);
    const data = (await r.json()) as Record<string, any>;
    if (typeof data?.id !== "string" || typeof data?.email !== "string") {
      throw new Error("MoeMail 建邮箱响应缺少 id 或 email");
    }
    // MoeMail 用 id 定位邮箱，与 YYDS 用地址不同。
    return { address: data.email, handle: data.id };
  }

  async pollCode(mailbox: Mailbox, timeoutMs: number): Promise<string | null> {
    const start = this.deps.now();
    // 注：这里不需要 YYDS 那种 seen 去重。YYDS 要二次拉详情，"标记已处理"与"真正
    // 解析成功"是两步，中间可能被瞬时错误打断，才需要靠 seen 的写入时机来保证
    // 不永久跳过。MoeMail 的列表接口自带正文，每轮都是一次性、无状态地重新扫描
    // 整份列表，没有"标记后failed"的中间态，天然没有这个坑，不必为了对齐硬加。
    while (this.deps.now() - start < timeoutMs) {
      const r = await this.deps.fetcher.fetch(
        `${this.deps.baseUrl}/api/emails/${encodeURIComponent(mailbox.handle)}`,
        { method: "GET", headers: this.headers() },
      );
      if (r.ok) {
        // 列表响应偶发 200 但 body 非 JSON（网关异常页等），解析失败按本轮未取到
        // 消息处理，不中断整条轮询。这里只有一次请求（列表自带正文，无需二次拉
        // 详情），因此解析失败等价于 YYDS 里"列表侧解析失败＝跳过整轮"的语义。
        let data: Record<string, any> | null = null;
        try {
          data = (await r.json()) as Record<string, any>;
        } catch {
          data = null;
        }
        for (const m of (data?.messages ?? []) as Array<Record<string, any>>) {
          const code = extractCode(
            String(m?.subject ?? ""),
            `${m?.content ?? ""} ${m?.html ?? ""}`,
          );
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
        `${this.deps.baseUrl}/api/emails/${encodeURIComponent(mailbox.handle)}`,
        { method: "DELETE", headers: this.headers() },
      );
    } catch (err) {
      // 用完即删是尽力而为，理由同 YYDS 适配器：key 已经拿到了，邮箱残留是次要
      // 问题，不该让整次铸 key 失败，但要留痕方便观测残留是否在堆积。沿用 P1
      // 既有先例（无日志端口，直接 console，参见 src/core/storage-health.ts）。
      console.warn(`[agnes2api] MoeMail 删邮箱失败（残留不影响已拿到的结果）：${mailbox.address}`, err);
    }
  }
}
