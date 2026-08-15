import type { MailProvider } from "../ports/mailbox.js";
import { REGISTRAR_REQUEST_TIMEOUT_MS, type Mailbox } from "../core/registrar/types.js";
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

  /**
   * 单请求超时。注意 `pollCode` 的截止判断只在每轮循环开头做一次，请求本身挂起
   * 是不计入的——没有这个超时，一个挂死的连接就能让单轮无限拖长，把整轮补池推过
   * Worker Cron 的墙钟上限，届时 mintOne 的 finally 不会执行，邮箱就漏了。
   */
  private signal(): AbortSignal {
    return AbortSignal.timeout(REGISTRAR_REQUEST_TIMEOUT_MS);
  }

  async listDomains(): Promise<string[]> {
    const r = await this.deps.fetcher.fetch(`${this.deps.baseUrl}/v1/domains`, {
      method: "GET", headers: this.headers(), signal: this.signal(),
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
      signal: this.signal(),
    });
    if (!r.ok) throw new Error(`YYDS 建邮箱失败: HTTP ${r.status}`);
    // 2xx 之后的任何解析失败都意味着同一件事：邮箱**可能已经在上游建出来了**，
    // 而我们手上没有 handle，于是它永远删不掉。YYDS 侧没有 TTL，这种泄漏会永久
    // 占用活跃邮箱配额；`mintOne` 又会接着试下一个域名，单次铸 key 最多漏 8 个、
    // 单轮最多 40 个，远超 15 个的配额上限。所以抛错之前，用请求时就已知的
    // `localPart@domain` 兜底删一次——YYDS 正是用地址定位邮箱，这个信息此刻是齐的。
    let address: unknown;
    try {
      address = ((await r.json()) as Record<string, any>)?.data?.address;
    } catch {
      address = undefined;
    }
    if (typeof address !== "string" || address.length === 0) {
      const guessed = `${lp}@${domain}`;
      await this.deleteMailbox({ address: guessed, handle: guessed });
      throw new Error(`YYDS 建邮箱响应无法解析或缺少 data.address（已按 ${guessed} 兜底删除）`);
    }
    // YYDS 用地址本身定位邮箱，故 handle 与 address 相同。
    return { address, handle: address };
  }

  async pollCode(mailbox: Mailbox, timeoutMs: number): Promise<string | null> {
    const start = this.deps.now();
    const seen = new Set<string>();
    while (this.deps.now() - start < timeoutMs) {
      const listUrl = `${this.deps.baseUrl}/v1/messages?address=${encodeURIComponent(mailbox.handle)}`;
      const lr = await this.deps.fetcher.fetch(listUrl, {
        method: "GET", headers: this.headers(), signal: this.signal(),
      });
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
          const dr = await this.deps.fetcher.fetch(dUrl, {
            method: "GET", headers: this.headers(), signal: this.signal(),
          });
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
      const r = await this.deps.fetcher.fetch(
        `${this.deps.baseUrl}/v1/accounts/${encodeURIComponent(mailbox.handle)}`,
        { method: "DELETE", headers: this.headers(), signal: this.signal() },
      );
      // 非 2xx 才是最常见的删除失败路径：404/403/500 都会让 fetch 正常 resolve，
      // 根本走不到下面的 catch。不在这里留痕的话，「邮箱正在堆积、配额（免费档
      // 同时 15 个）即将耗尽」这件事一条信号都没有——而用完即删是功能能否持续
      // 工作的前提（设计 §4.1），不是卫生习惯。带上状态码，便于区分「邮箱早就
      // 不在了」（404）与「凭据/配额出问题」（403/500）。
      if (!r.ok) {
        console.warn(
          `[agnes2api] YYDS 删邮箱失败（残留不影响已拿到的结果）：${mailbox.address} HTTP ${r.status}`,
        );
      }
    } catch (err) {
      // 用完即删是尽力而为：key 已经拿到了，邮箱残留是次要问题，不该让整次铸 key
      // 失败，但要留痕方便观测残留是否在堆积。沿用 P1 既有先例（无日志端口，直接
      // console，参见 src/core/storage-health.ts）。
      console.warn(`[agnes2api] YYDS 删邮箱失败（残留不影响已拿到的结果）：${mailbox.address}`, err);
    }
  }
}
