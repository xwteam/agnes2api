import type { MailProvider } from "../ports/mailbox.js";
import { REGISTRAR_REQUEST_TIMEOUT_MS, type Mailbox } from "../core/registrar/types.js";
import type { Fetcher } from "../ports/fetcher.js";
import { extractCode, normalizeBody } from "../core/registrar/code.js";

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
    // 而我们手上没有它的 id，于是它删不掉——处置见下面那段注释。
    let data: Record<string, any> | null = null;
    try {
      data = ((await r.json()) as Record<string, any>)?.data ?? null;
    } catch {
      data = null;
    }
    const address = data?.address;
    const id = data?.id;
    // id 与 address 都要校验：**两个接口用的键不一样**（见下面 return 处的注释），
    // 少任何一个都会让后续调用 100% 打空。
    if (typeof address !== "string" || address.length === 0
      || typeof id !== "string" || id.length === 0) {
      // **不做兜底删除。** 此前这里用 `localPart@domain` 兜底调了一次 deleteMailbox，
      // 但删除需要 id，而 id 恰恰就是这条路径丢掉的那个东西——真机实测用 address
      // 删一定 404，而且 `GET /v1/accounts` 也是 404（没有按 address 反查 id 的列表
      // 端点）。发一次注定失败的 DELETE 只会往「删邮箱失败」那条 warn 里灌稳定的
      // 假 404，稀释「邮箱正在堆积、配额即将耗尽」这个真信号，运维看多了就会开始
      // 忽略这类日志。改成诚实告警：说清楚这个邮箱可能已经建出来了、我们删不掉、
      // 以及它什么时候自己消失（真机实测 `expiresAt` = 建号时刻 + 约 24 小时）。
      const guessed = `${lp}@${domain}`;
      console.warn(
        `[registrar] YYDS 建邮箱响应无法解析或缺少 data.address / data.id：邮箱可能已在上游` +
          `创建但拿不到 id，无法主动删除，约 24 小时后随 expiresAt 自动过期；` +
          `活跃邮箱配额会被它占住，可按 ${guessed} 人工核对（domain=${domain}）`,
      );
      throw new Error("YYDS 建邮箱响应无法解析或缺少 data.address / data.id");
    }
    // **收信按 address 定位、删除按 id 定位**——真机实测的契约：
    //   GET    /v1/messages?address={address} → 200，换成 id → 404 inbox_not_found
    //   DELETE /v1/accounts/{id}              → 204，换成 address → 404 account_not_found
    // 所以 handle（= 删除用的定位符）必须存 id，收信那两处则显式用 mailbox.address。
    // 此前 handle 存的是 address，删邮箱因此每次都 404，用完即删从未真正生效。
    return { address, handle: id };
  }

  async pollCode(mailbox: Mailbox, timeoutMs: number): Promise<string | null> {
    const start = this.deps.now();
    const seen = new Set<string>();
    while (this.deps.now() - start < timeoutMs) {
      const listUrl = `${this.deps.baseUrl}/v1/messages?address=${encodeURIComponent(mailbox.address)}`;
      // `fetch` 本身 reject（DNS 失败 / TCP reset / TLS 错误，以及单请求超时到点抛出的
      // TimeoutError）与下面已经容忍的「HTTP 非 2xx」「响应体非 JSON」是同一类瞬时故障，
      // 处置必须一致：本轮跳过、继续轮询，只有 timeoutMs 耗尽才收工。此前这里没有
      // try/catch，一次网络抖动就会穿出 pollCode，被 mint.ts 收成 network_error 作废
      // 整次铸 key——而那一刻验证码往往已经在邮箱里、窗口还剩 100 多秒。单次铸 key 光
      // 轮询就要打约 40 次请求，抖动是常态而非异常；同一个故障返回 HTTP 500 反而能成功
      // 是说不通的。
      let lr: Response | null;
      try {
        lr = await this.deps.fetcher.fetch(listUrl, {
          method: "GET", headers: this.headers(), signal: this.signal(),
        });
      } catch {
        lr = null;
      }
      if (lr?.ok) {
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
          const dUrl = `${this.deps.baseUrl}/v1/messages/${encodeURIComponent(id)}?address=${encodeURIComponent(mailbox.address)}`;
          let dr: Response | null;
          try {
            dr = await this.deps.fetcher.fetch(dUrl, {
              method: "GET", headers: this.headers(), signal: this.signal(),
            });
          } catch {
            // 与非 2xx 同处置，理由见上面列表请求处的注释。
            dr = null;
          }
          // 拉详情失败（fetch reject、HTTP 非 2xx 或响应体非 JSON）不标记 seen：这封
          // 邮件可能已经到达，只是这次请求恰好撞上第三方 API 的瞬时错误，下一轮还要
          // 能重试，否则验证码邮件会被永久跳过、一路空转到超时。
          if (!dr?.ok) continue;
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
          // text 与 html 都要喂进去：真实模板里码在 html 的 class="…verification…"
          // 元素中，纯文本兜底则来自 text。html 在真机上是数组，交给 normalizeBody。
          const code = extractCode(
            normalizeBody(detail.subject),
            `${normalizeBody(detail.text)}\n${normalizeBody(detail.html)}`,
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
          `[registrar] YYDS 删邮箱失败（残留不影响已拿到的结果）：${mailbox.address} HTTP ${r.status}`,
        );
      }
    } catch (err) {
      // 用完即删是尽力而为：key 已经拿到了，邮箱残留是次要问题，不该让整次铸 key
      // 失败，但要留痕方便观测残留是否在堆积。沿用 P1 既有先例（无日志端口，直接
      // console，参见 src/core/storage-health.ts）。
      console.warn(`[registrar] YYDS 删邮箱失败（残留不影响已拿到的结果）：${mailbox.address}`, err);
    }
  }
}
