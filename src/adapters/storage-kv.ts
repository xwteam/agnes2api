import type { Storage } from "../ports/storage.js";

export class KvStorage implements Storage {
  constructor(private readonly kv: KVNamespace) {}

  async get<T>(key: string): Promise<T | null> {
    return await this.kv.get<T>(key, "json");
  }

  async put<T>(key: string, value: T, expiresAt?: number): Promise<void> {
    // KV 原生 `expiration`：绝对 UNIX 秒（不是 ms）。**零操作开销、不占任何配额桶**
    // ——过期由 Cloudflare 边缘自己物理清除，不需要我们另外发一次 delete（评审裁定）。
    const options = expiresAt !== undefined ? { expiration: Math.floor(expiresAt / 1000) } : undefined;
    await this.kv.put(key, JSON.stringify(value), options);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    // KV 单次 list 上限 1000，用游标取完，避免池子变大后静默截断。
    for (;;) {
      const page = await this.kv.list({ prefix, cursor });
      out.push(...page.keys.map((k) => k.name));
      if (page.list_complete) break;
      cursor = page.cursor;
    }
    return out;
  }
}
