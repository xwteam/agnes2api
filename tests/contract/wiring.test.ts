import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../../src/http/wire.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import type { Storage } from "../../src/ports/storage.js";

describe("buildApp", () => {
  it("从环境变量与存储装配出可用的 app", async () => {
    const app = await buildApp({ GATEWAY_TOKEN: "t" }, new MemoryStorage());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("缺少 GATEWAY_TOKEN 时装配失败并给出明确错误", async () => {
    await expect(buildApp({}, new MemoryStorage())).rejects.toThrow(/GATEWAY_TOKEN/);
  });
});

/** 记账用的存储：统计写次数，并可切换成「写不进去」。 */
class CountingStorage implements Storage {
  puts = 0;
  deletes = 0;
  writable = true;
  private readonly map = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.puts++;
    if (!this.writable) throw new Error("EACCES: permission denied, open '/app/data/store.json'");
    this.map.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.deletes++;
    if (!this.writable) throw new Error("EACCES: permission denied, unlink '/app/data/store.json'");
    this.map.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

// ── C-RM1：健康检查要反映「存储可写」，但不许每次都写盘 ─────────────────────
describe("buildApp 的存储可写性探测", () => {
  it("开启探测时只写一次探针键并删掉，之后 /health 不再产生任何写入", async () => {
    const s = new CountingStorage();
    const app = await buildApp({ GATEWAY_TOKEN: "t" }, s, { probeStorage: true });

    expect(s.puts).toBe(1);
    expect(s.deletes).toBe(1);
    expect(s.keys()).toEqual([]); // 探针不在存储里留痕迹

    for (let i = 0; i < 5; i++) {
      expect((await app.request("/health")).status).toBe(200);
    }
    expect(s.puts).toBe(1);
    expect(s.deletes).toBe(1);
  });

  it("不开启探测时装配完全不写存储（Worker/KV 形态不消耗写配额）", async () => {
    const s = new CountingStorage();
    const app = await buildApp({ GATEWAY_TOKEN: "t" }, s);

    expect(s.puts).toBe(0);
    expect(s.deletes).toBe(0);
    expect((await app.request("/health")).status).toBe(200);
    expect(s.puts).toBe(0);
  });

  it("探测失败时 /health 报 503 degraded，而不是继续报 healthy", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const s = new CountingStorage();
      s.writable = false;
      const app = await buildApp({ GATEWAY_TOKEN: "t" }, s, { probeStorage: true });

      const res = await app.request("/health");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "degraded", storage: { writable: false } });
      expect(warn).toHaveBeenCalled(); // 原始异常写进容器日志，而不是响应体
    } finally {
      warn.mockRestore();
    }
  });

});
