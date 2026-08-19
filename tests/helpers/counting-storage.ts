import type { Storage } from "../../src/ports/storage.js";
import { MemoryStorage } from "./fake-storage.js";

/**
 * 数三个桶。**分开数**：Cloudflare KV 的 `read` / `write` / `list` 是三个**独立**的
 * 每日配额桶（`delete` 是第四个），把它们混成一个「操作次数」会让配额账的断言
 * 恰好丢掉这个项目最要紧的那条信息——`list` 与 `put` 都卡在每天 1,000 次。
 */
export class CountingStorage implements Storage {
  lists = 0; puts = 0; gets = 0; deletes = 0;
  putFails = false;
  listFails = false;
  constructor(readonly inner: Storage = new MemoryStorage()) {}
  async get<T>(k: string): Promise<T | null> { this.gets++; return this.inner.get<T>(k); }
  async put<T>(k: string, v: T): Promise<void> {
    this.puts++;
    if (this.putFails) throw new Error("write quota exhausted");
    return this.inner.put(k, v);
  }
  async delete(k: string): Promise<void> { this.deletes++; return this.inner.delete(k); }
  async list(p: string): Promise<string[]> {
    this.lists++;
    if (this.listFails) throw new Error("list quota exhausted");
    return this.inner.list(p);
  }
}
