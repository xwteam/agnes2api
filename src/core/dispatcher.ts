import type { Storage } from "../ports/storage.js";
import type { KeyRecord } from "./types.js";
import { selectKey, applySuccess, applyCooldown, applyStrike, applyEvict, poolHealth } from "./keypool.js";
import { classifyStatus, classifyThrown } from "./errors.js";
import type { Fetcher } from "../ports/fetcher.js";
import type { GatewayConfig } from "./config.js";

const KEY_PREFIX = "key:";

async function keyId(key: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class KeyPoolRepo {
  constructor(private readonly storage: Storage) {}

  async all(): Promise<KeyRecord[]> {
    const names = await this.storage.list(KEY_PREFIX);
    const rs = await Promise.all(names.map((n) => this.storage.get<KeyRecord>(n)));
    return rs.filter((r): r is KeyRecord => r !== null);
  }

  async save(r: KeyRecord): Promise<void> {
    await this.storage.put(KEY_PREFIX + r.id, r);
  }

  async add(key: string): Promise<KeyRecord> {
    const r: KeyRecord = {
      id: await keyId(key), key, addedAt: Date.now(), lastUsedAt: null,
      cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
    };
    await this.save(r);
    return r;
  }
}

export interface DispatchDeps {
  repo: KeyPoolRepo;
  fetcher: Fetcher;
  config: GatewayConfig;
  now: () => number;
}

let cursor = 0;

/**
 * 出站响应头白名单。上游响应头一律**不**原样转发，只保留客户端解析响应必需的几个。
 *
 * 理由有三：①`set-cookie` / `www-authenticate` / `authorization` 这类头带的是上游的
 * 凭据语义，透传等于把它们落到网关自己的域上；②上游的 `x-*` 内部头是不受控的泄漏面
 * （实测 `x-upstream-internal` 会原封不动到达客户端）；③池子每次请求都可能换一把 key，
 * 逐 key 的限流/配额头对客户端只是误导。
 *
 * 不含 `content-length` / `content-encoding`：响应体在这里被重新包装（fetch 已解压），
 * 沿用上游的这两个头会与实际字节不符。
 *
 * 含 `content-disposition`：媒体路由（图片/视频）承诺「上游返回什么就原样转发响应体」，
 * 剥掉它会导致浏览器端下载丢失文件名。它不带凭据语义，也不像 `content-length` 那样
 * 可能与重新包装后的实际字节不一致，放行是安全的。
 *
 * 不含 `accept-ranges` / `content-range`：两者都是 range 请求的语义，网关目前不支持
 * range（不解析、不转发 `Range` 请求头），放行只会让客户端以为支持而发起注定失败的
 * range 请求，属于误导而非帮助。
 */
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after", "content-disposition"];

function safeHeaders(res: Response): Headers {
  const headers = new Headers();
  for (const name of SAFE_RESPONSE_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  return headers;
}

/** 按白名单重建一个出站响应，响应体（含流式）原样搬运。 */
function sanitize(res: Response): Response {
  return new Response(res.body, { status: res.status, headers: safeHeaders(res) });
}

/**
 * 丢弃一个不再需要的上游响应。
 *
 * 换 key 重试时被覆盖的那个 Response 如果不取消，它的响应体就一直挂在连接上没人消费；
 * 上游 5xx 风暴时每个请求会泄漏「池大小 - 1」个响应体——恰恰是资源压力最大的时候。
 */
async function discard(res: Response | null): Promise<void> {
  if (!res || !res.body || res.bodyUsed) return;
  try {
    await res.body.cancel();
  } catch {
    // 已被关闭或已被取消，忽略即可。
  }
}

type FailReason = "pool_empty" | "all_cooling" | "all_evicted" | "upstream_error";

function fail(reason: FailReason, message: string, retryAfterSec?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfterSec !== undefined) headers["retry-after"] = String(retryAfterSec);
  return new Response(JSON.stringify({ error: { reason, message } }), { status: 503, headers });
}

/**
 * 池子整体不可用时的 503。
 *
 * `reason` 必须让客户端能区分「会自愈」与「不会自愈」（设计 §7.2.1）：原实现把网络
 * 全失败也报成 `all_cooling`，而 message 却写「全部 key 均已尝试且失败」，自相矛盾，
 * 且暗示会自愈——在 strike 即永久剔除的旧语义下它永远不会自愈。
 */
function unavailable(records: KeyRecord[], now: number): Response {
  const h = poolHealth(records, now);
  if (h.total === 0) return fail("pool_empty", "key 池为空，请先导入 key");

  if (h.evicted === h.total) {
    return fail(
      "all_evicted",
      `全部 ${h.total} 把 key 均因凭据失效被永久剔除，不会自动恢复，请更换 key`,
    );
  }

  if (h.fresh === 0) {
    // 冷却是有期限的，把最早恢复的时刻折成 Retry-After，客户端就不必盲目轮询。
    const earliest = Math.min(
      ...records.filter((r) => !r.evicted).map((r) => r.cooldownUntil),
    );
    const retryAfterSec = Math.max(1, Math.ceil((earliest - now) / 1000));
    return fail(
      "all_cooling",
      `全部 key 暂不可用：${h.cooling} 把冷却中（到期自动恢复）、${h.evicted} 把已永久剔除`,
      retryAfterSec,
    );
  }

  return fail("upstream_error", "已尝试池中每一把 key，上游均返回失败；key 本身仍可用");
}

/**
 * 端点的**上游延迟语义**，决定用哪个超时预算、以及超时后如何处置这把 key。
 *
 * 它与 `stream` 参数是两件事：`stream` 说的是「返回给客户端的响应形态」，这里说的是
 * 「上游首字节什么时候才可能到达」。视频建任务（`POST /videos`）不是流式却很慢，视频
 * 轮询（`GET /videos/{id}`）同样不是流式却很快——两者用同一个 `stream: false`，但超时
 * 语义完全相反，所以必须独立表达。
 *
 * - `firstByte`（默认）：上游一开始说话就算首字节，用 `UPSTREAM_TIMEOUT_MS`（8 秒）。
 *   适用于流式/非流式对话与视频轮询这类快接口。慢 key 在这里应当被快速甩掉（设计 §7.3）。
 * - `sync`：首字节要等上游把整个结果算完才到达（图片生成、视频建任务），用
 *   `UPSTREAM_SYNC_TIMEOUT_MS`（默认 2 分钟）。
 */
export type TimeoutProfile = "firstByte" | "sync";

/**
 * 同步端点超时：504，且**不惩罚这把 key、也不再换下一把**。
 *
 * ① 为什么不记 strike：这里的超时衡量的是「上游把整张图渲染完需要多久」与「网关给了
 * 多少预算」之间的关系，而不是这把 key 是否健康。预算配小了就把池中每把 key 都判为
 * 不健康，是把配置问题记到 key 头上——实测正是这条路径：一次图片请求让池中每把 key
 * 各吃一次 strike，三次请求即可把任意规模的整池打进 30 分钟长冷却，连对话一起拖死。
 * 真正坏掉的 key 走的是「网络错误」分支（连不上会立刻抛错，不需要等满超时），那条
 * 分支仍然记 strike；对话端点也仍然按 8 秒首字节把慢 key 甩掉。惩罚通路并没有消失。
 *
 * ② 为什么不再换下一把：换 key 重试的前提是「换一把可能更快」，但同步端点的耗时由
 * 上游的渲染工作量决定，不由 key 决定，重试没有理由得到不同结果；代价却是客户端要为
 * 每把 key 再等一个完整预算——20 把 key 的池子就是 20 × 2 分钟。让客户端的最坏等待
 * 停在一个预算内，并把「是预算问题、不是 key 问题」直接写进错误体。
 */
function syncTimedOut(timeoutMs: number): Response {
  return jsonBody(504, {
    error: {
      reason: "upstream_timeout",
      message: `同步端点在 ${timeoutMs} 毫秒内未收到上游响应。这是超时预算问题而非 key 故障，未惩罚任何 key；如确需更长时间，调大 UPSTREAM_SYNC_TIMEOUT_MS 后重试`,
    },
  });
}

export async function dispatch(args: {
  path: string;
  body: unknown;
  stream: boolean;
  method?: "GET" | "POST";
  /** 见 TimeoutProfile。缺省为 `firstByte`，即保持原有的 8 秒首字节语义。 */
  timeout?: TimeoutProfile;
  /**
   * 调用方随后会把响应体解析成 JSON 做协议转换时置为 true。
   *
   * 「上游 200 但响应体不是 JSON」是上游异常，不是客户端错误：若放任它冒泡到路由里
   * 的 `res.json()`，结果是一个纯文本 500，而且这把持续吐 HTML 错误页的 key 不会被
   * 记账，会被无限轮到。故在这里就地校验：解析失败即记 strike 并换下一把 key，
   * 全部失败时返回 502。响应体本来就要被完整读取，因此不产生额外开销。
   */
  expectJson?: boolean;
  deps: DispatchDeps;
}): Promise<Response> {
  const { repo, fetcher, config, now } = args.deps;
  const profile: TimeoutProfile = args.timeout ?? "firstByte";
  const timeoutMs = profile === "sync" ? config.upstreamSyncTimeoutMs : config.upstreamTimeoutMs;
  const records = await repo.all();
  if (records.length === 0) return fail("pool_empty", "key 池为空，请先导入 key");

  let lastError: Response | null = null;
  const attempts = records.length;

  const commit = async (at: number, updated: KeyRecord) => {
    await repo.save(updated);
    records[at] = updated;
  };

  // 任何一条 return 路径都要先把攒着的上一个上游错误响应体取消掉，否则它的
  // 响应体永远没人消费（见 discard 的说明）。
  const done = async (out: Response): Promise<Response> => {
    await discard(lastError);
    return out;
  };

  for (let i = 0; i < attempts; i++) {
    const picked = selectKey(records, cursor, now());
    if (!picked) {
      return lastError ?? unavailable(records, now());
    }
    cursor = picked.nextCursor;
    const record = picked.record;
    const slot = records.indexOf(record);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const method = args.method ?? "POST";
    const init: RequestInit & { signal: AbortSignal } = {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${record.key}`,
      },
      signal: controller.signal,
    };
    if (method === "POST") init.body = JSON.stringify(args.body);

    let res: Response;
    try {
      res = await fetcher.fetch(`${config.agnesBaseUrl}${args.path}`, init);
    } catch (err) {
      clearTimeout(timer);
      const action = classifyThrown(err);
      const reason = action.kind === "strike" ? action.reason : "unknown";

      // 同步端点超时既不记 strike 也不换 key，见 syncTimedOut 的说明。
      if (profile === "sync" && reason === "timeout") return done(syncTimedOut(timeoutMs));

      await commit(slot, applyStrike(record, now(), config, reason));
      continue;
    }
    // 首字节已到，解除超时，让响应体自由流动。
    clearTimeout(timer);

    const action = classifyStatus(res.status, config);

    if (action.kind === "success") {
      if (args.expectJson) {
        const text = await res.text().catch(() => null);
        if (text === null || !isJson(text)) {
          await commit(slot, applyStrike(record, now(), config, "upstream non-JSON body"));
          await discard(lastError);
          lastError = jsonBody(502, {
            error: { reason: "upstream_bad_body", message: "上游返回了非 JSON 的成功响应" },
          });
          continue;
        }
        await commit(slot, applySuccess(record, now()));
        return done(new Response(text, { status: res.status, headers: safeHeaders(res) }));
      }
      await commit(slot, applySuccess(record, now()));
      return done(sanitize(res));
    }
    if (action.kind === "passthrough") {
      return done(sanitize(res));
    }

    if (action.kind === "evict") {
      // 上游 401/403 说的是「池里这把 key 失效了」，与客户端无关，绝不能把上游的
      // 错误体透传出去：凭据无效的错误体恰恰是各家 API 最爱回显 key 片段的地方，
      // 这是本项目唯一一条上游 key 可能触达客户端的通路。改为合成网关自己的错误体。
      // 注意只丢弃这次的 401 响应，不动 lastError：先前某把 key 的真实上游错误
      // （例如 500）仍然是更有信息量的回复，不该被一次凭据失效抹掉。
      await discard(res);
      await commit(slot, applyEvict(record, action.reason));
      continue;
    }

    await discard(lastError);
    lastError = sanitize(res);

    if (action.kind === "cooldown") await commit(slot, applyCooldown(record, now(), action.ms, action.reason));
    else await commit(slot, applyStrike(record, now(), config, action.reason));
  }

  return lastError ?? unavailable(records, now());
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function jsonBody(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
