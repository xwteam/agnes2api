import type { Storage } from "../ports/storage.js";
import type { KeyRecord } from "./types.js";
import { selectKey, applySuccess, applyCooldown, applyStrike, applyEvict } from "./keypool.js";
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
      cooldownUntil: 0, strikes: 0, evicted: false, evictedReason: null,
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

function fail(reason: "pool_empty" | "all_cooling", message: string): Response {
  return new Response(JSON.stringify({ error: { reason, message } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

export async function dispatch(args: {
  path: string;
  body: unknown;
  stream: boolean;
  method?: "GET" | "POST";
  deps: DispatchDeps;
}): Promise<Response> {
  const { repo, fetcher, config, now } = args.deps;
  const records = await repo.all();
  if (records.length === 0) return fail("pool_empty", "key 池为空，请先导入 key");

  let lastError: Response | null = null;
  const attempts = records.length;

  for (let i = 0; i < attempts; i++) {
    const picked = selectKey(records, cursor, now());
    if (!picked) {
      return lastError ?? fail("all_cooling", "全部 key 处于冷却或已剔除状态");
    }
    cursor = picked.nextCursor;
    const record = picked.record;

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
      const updated = applyStrike(record, config.maxStrikes, action.kind === "strike" ? action.reason : "unknown");
      await repo.save(updated);
      records[records.indexOf(record)] = updated;
      continue;
    }
    // 首字节已到，解除超时，让响应体自由流动。
    clearTimeout(timer);

    const action = classifyStatus(res.status, config);

    if (action.kind === "success") {
      await repo.save(applySuccess(record, now()));
      return res;
    }
    if (action.kind === "passthrough") {
      return res;
    }

    lastError = res;
    let updated: KeyRecord;
    if (action.kind === "cooldown") updated = applyCooldown(record, now(), action.ms);
    else if (action.kind === "evict") updated = applyEvict(record, action.reason);
    else updated = applyStrike(record, config.maxStrikes, action.reason);

    await repo.save(updated);
    records[records.indexOf(record)] = updated;
  }

  return lastError ?? fail("all_cooling", "全部 key 均已尝试且失败");
}
