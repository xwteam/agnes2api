import type { MailProvider } from "../ports/mailbox.js";
import { REGISTRAR_REQUEST_TIMEOUT_MS, type Mailbox } from "../core/registrar/types.js";
import type { Fetcher } from "../ports/fetcher.js";
import { extractCode, normalizeBody } from "../core/registrar/code.js";
import type { Logger } from "../ports/logger.js";

/**
 * **MoeMail 侧「活跃邮箱上限」这件事的唯一出处，全仓只此一处复述数字。**
 *
 * · 值：**上游默认 30**，超限时建邮箱返回 **403**。
 * · 出处：注册机设计阶段的一份内部文档（**未随公开仓发布**），那一段追溯的是
 *   上游 `app/config/email.ts` 的 `MAX_ACTIVE_EMAILS` 默认 30，
 *   **实例可用 `SITE_CONFIG.MAX_EMAILS` 覆盖**，仅 EMPEROR 角色豁免。
 * · 复核日期：**2026-08-21（北京时间）**，本次复核只到"设计文档追溯到了上游那个
 *   常量名"为止，**没有**去 MoeMail 上游仓库二次核对那个默认值今天还是不是 30。
 *
 * ⚠️ **它不是常数，是一个可被站点配置覆盖的上游默认值。** MoeMail 是**自建**服务，
 * 每个部署者的实例都可能改过它。因此：
 * · 源码注释里要它，是因为「用完即删」这条功能性前提需要一个量级才说得通；
 * · **面板文案里一律不许出现这个数字**（这是个取舍，理由与另一半在
 *   `src/http/admin/handlers/registrar.ts` 的文件头）——运维会把面板上的数字
 *   当成自己这套部署的事实，而这个数字对一个自建实例来说尤其可能是错的。
 * 别处（`mint.ts` / `tender.ts` / `wire.ts` / 各测试）只引用本段，不再各写一遍数字。
 *
 * **刻意不做成一个导出的常量**，理由与 `mailbox-yyds.ts` 那段同源：零消费者的导出
 * 迟早会漂，而它本来就不是本网关的配置。
 */

export interface MoeMailDeps {
  fetcher: Fetcher;
  baseUrl: string;
  apiKey: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** 随机源，可选，默认 `Math.random`。注入后 `createMailbox` 的 localPart 可确定性断言。 */
  rand?: () => number;
  /** 事件日志 sink，由调用方注入——适配器层不直接碰 console。 */
  logger: Logger;
}

const LOCAL_PART_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const POLL_INTERVAL_MS = 3000;
/** 邮箱只用来收一次验证码，一小时足够，也便于服务端自行回收。 */
const MAILBOX_TTL_MS = 3_600_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MoeMailProvider implements MailProvider {
  readonly name = "moemail" as const;
  constructor(private readonly deps: MoeMailDeps) {}

  private headers(): Record<string, string> {
    return { "X-API-Key": this.deps.apiKey, "content-type": "application/json" };
  }

  /** 单请求超时，理由同 YYDS 适配器：轮询的截止判断拦不住挂起的请求。 */
  private signal(): AbortSignal {
    return AbortSignal.timeout(REGISTRAR_REQUEST_TIMEOUT_MS);
  }

  async listDomains(): Promise<string[]> {
    const r = await this.deps.fetcher.fetch(`${this.deps.baseUrl}/api/config`, {
      method: "GET", headers: this.headers(), signal: this.signal(),
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
      signal: this.signal(),
    });
    if (!r.ok) throw new Error(`MoeMail 建邮箱失败: HTTP ${r.status}`);
    let data: Record<string, any> | null = null;
    try {
      data = (await r.json()) as Record<string, any>;
    } catch {
      data = null;
    }
    if (typeof data?.id !== "string" || typeof data?.email !== "string") {
      // 两家在这条路径上是同一个形态：删除都要**服务端生成的 id**，而 id 恰恰是
      // 解析失败时丢掉的东西，请求侧无从推断，所以谁都做不了兜底删除（YYDS 侧同款
      // 处置见 mailbox-yyds.ts 的对应分支）。这封邮箱若真的建出来了，只能等建邮箱
      // 时传的 TTL 到期自愈。至少要留痕——活跃邮箱有上限（数字、出处与"它可被实例
      // 覆盖"这件事见本文件头那段），配额被这种泄漏吃掉时不能毫无信号。
      this.deps.logger.log({
        level: "warn", event: "registrar.mailbox_create_unparseable",
        msg: "MoeMail 建邮箱响应无法解析或缺少 id/email：邮箱可能已在上游创建但 handle 丢失，"
          + "无法主动删除，只能等 TTL 到期自愈",
        fields: { provider: "moemail", domain, ttlMinutes: MAILBOX_TTL_MS / 60_000 },
      });
      throw new Error("MoeMail 建邮箱响应无法解析或缺少 id 或 email");
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
      // `fetch` 本身 reject（DNS 失败 / TCP reset / TLS 错误，以及单请求超时到点抛出的
      // TimeoutError）与下面已经容忍的「HTTP 非 2xx」「响应体非 JSON」是同一类瞬时故障，
      // 处置必须一致：本轮跳过、继续轮询，只有 timeoutMs 耗尽才收工。理由同 YYDS 适配器
      // 里同位置的注释——此前一次网络抖动就会作废整次铸 key，而验证码往往已经到了。
      let r: Response | null;
      try {
        r = await this.deps.fetcher.fetch(
          `${this.deps.baseUrl}/api/emails/${encodeURIComponent(mailbox.handle)}`,
          { method: "GET", headers: this.headers(), signal: this.signal() },
        );
      } catch {
        r = null;
      }
      if (r?.ok) {
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
            normalizeBody(m?.subject),
            `${normalizeBody(m?.content)}\n${normalizeBody(m?.html)}`,
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
        `${this.deps.baseUrl}/api/emails/${encodeURIComponent(mailbox.handle)}`,
        { method: "DELETE", headers: this.headers(), signal: this.signal() },
      );
      // 理由同 YYDS 适配器：非 2xx 会正常 resolve、进不了 catch，是最常见的失败
      // 路径。MoeMail 侧同样有活跃邮箱上限（数字与出处见本文件头那段），
      // 删不掉一样会把配额吃光，必须留痕。
      if (!r.ok) {
        this.deps.logger.log({
          level: "warn", event: "registrar.delete_mailbox_failed",
          msg: "MoeMail 删邮箱失败（残留不影响已拿到的结果）",
          fields: { provider: "moemail", address: mailbox.address, status: r.status },
        });
      }
    } catch (err) {
      // 用完即删是尽力而为，理由同 YYDS 适配器：key 已经拿到了，邮箱残留是次要
      // 问题，不该让整次铸 key 失败，但要留痕方便观测残留是否在堆积。
      this.deps.logger.log({
        level: "warn", event: "registrar.delete_mailbox_failed",
        msg: "MoeMail 删邮箱失败（残留不影响已拿到的结果）",
        fields: { provider: "moemail", address: mailbox.address, err: errMsg(err) },
      });
    }
  }
}
