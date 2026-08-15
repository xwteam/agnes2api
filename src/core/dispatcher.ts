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
 */
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after"];

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

export async function dispatch(args: {
  path: string;
  body: unknown;
  stream: boolean;
  method?: "GET" | "POST";
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
    const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

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
      await commit(slot, applyStrike(record, now(), config, action.kind === "strike" ? action.reason : "unknown"));
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
