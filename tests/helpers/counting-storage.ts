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
  async put<T>(k: string, v: T, expiresAt?: number): Promise<void> {
    this.puts++;
    if (this.putFails) throw new Error("write quota exhausted");
    return this.inner.put(k, v, expiresAt);
  }
  async delete(k: string): Promise<void> { this.deletes++; return this.inner.delete(k); }
  async list(p: string): Promise<string[]> {
    this.lists++;
    if (this.listFails) throw new Error("list quota exhausted");
    return this.inner.list(p);
  }
}

/**
 * **按键**数写次数。`CountingStorage` 数的是全局总数，回答不了「`registrar:domains`
 * 这一把键这一轮被写了几次」——而写配额账里每一行算的正是某一把键的次数。
 *
 * 单独一个类而不是给 `CountingStorage` 加字段：那个类已经有一批用例在数它的全局
 * 计数，往里面塞一张表会让「这一格到底在数什么」变得要看两个地方。
 */
export class KeyedCountingStorage implements Storage {
  readonly puts = new Map<string, number>();
  readonly gets = new Map<string, number>();
  readonly deletes = new Map<string, number>();
  lists = 0;
  constructor(readonly inner: Storage = new MemoryStorage()) {}
  private bump(m: Map<string, number>, k: string): void { m.set(k, (m.get(k) ?? 0) + 1); }
  async get<T>(k: string): Promise<T | null> { this.bump(this.gets, k); return this.inner.get<T>(k); }
  async put<T>(k: string, v: T, expiresAt?: number): Promise<void> {
    this.bump(this.puts, k);
    return this.inner.put(k, v, expiresAt);
  }
  async delete(k: string): Promise<void> { this.bump(this.deletes, k); return this.inner.delete(k); }
  async list(p: string): Promise<string[]> { this.lists++; return this.inner.list(p); }
}
