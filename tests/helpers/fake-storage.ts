import type { Storage } from "../../src/ports/storage.js";

export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}
