import { describe, it, expect, vi } from "vitest";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStorageHealth,
  probeWritable,
  watchStorage,
} from "../../src/core/storage-health.js";
import { FileStorage } from "../../src/adapters/storage-file.js";
import { buildApp } from "../../src/http/wire.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import { recordingLogger } from "../helpers/recording-logger.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "a2a-storage-health-"));
}

/** 只读存储：读得到、写不进——真机上属主不匹配时正是这个形态。 */
class ReadOnlyStorage implements Storage {
  readonly reads: string[] = [];
  async get<T>(_key: string): Promise<T | null> {
    this.reads.push(_key);
    return null;
  }
  async put(): Promise<void> {
    throw new Error("EACCES: permission denied");
  }
  async delete(): Promise<void> {
    throw new Error("EACCES: permission denied");
  }
  async list(): Promise<string[]> {
    return [];
  }
}

/** 写得进、删不掉：数据目录挂了 sticky 位、或探针写完后被只读重挂时就是这个形态。 */
class UndeletableStorage extends MemoryStorage {
  override async delete(): Promise<void> {
    throw new Error("EPERM: operation not permitted");
  }
}

describe("watchStorage", () => {
  it("写成功时记为可写", async () => {
    const health = createStorageHealth();
    const s = watchStorage(new MemoryStorage(), health, () => 42);
    await s.put("key:a", { x: 1 });

    expect(health.status()).toEqual({ writable: true, checkedAt: 42 });
  });

  it("写失败时记为不可写，且异常原样抛出（调用方的错误处理不变）", async () => {
    const health = createStorageHealth();
    const s = watchStorage(new ReadOnlyStorage(), health, () => 7);

    await expect(s.put("key:a", {})).rejects.toThrow(/EACCES/);
    expect(health.status()).toEqual({ writable: false, checkedAt: 7 });
  });

  it("delete 失败同样计入", async () => {
    const health = createStorageHealth();
    const s = watchStorage(new ReadOnlyStorage(), health, () => 7);

    await expect(s.delete("key:a")).rejects.toThrow(/EACCES/);
    expect(health.status().writable).toBe(false);
  });

  // 只读的数据目录 get/list 照样成功，用读操作判断可写性会得出「健康」的错误结论。
  it("读操作不改变状态（读得到不等于写得进）", async () => {
    const health = createStorageHealth();
    const inner = new ReadOnlyStorage();
    const s = watchStorage(inner, health, () => 7);

    await s.get("config");
    await s.list("key:");
    expect(health.status()).toEqual({ writable: true, checkedAt: null }); // 仍是「未观测到写失败」
    expect(inner.reads).toEqual(["config"]);
  });

  it("写恢复成功后状态自动转回可写", async () => {
    const health = createStorageHealth();
    health.record(false, 1);
    const s = watchStorage(new MemoryStorage(), health, () => 2);

    await s.put("key:a", {});
    expect(health.status().writable).toBe(true);
  });
});

describe("probeWritable", () => {
  it("可写时返回 null 且不留下探针键", async () => {
    const inner = new MemoryStorage();
    expect(await probeWritable(inner)).toBeNull();
    expect(await inner.list("")).toEqual([]);
  });

  it("不可写时返回失败原因", async () => {
    const err = await probeWritable(new ReadOnlyStorage());
    expect(err?.message).toMatch(/EACCES/);
  });

  // M-RM9：可写性的结论只看 put。原实现把 put+delete 一起 try，于是「写得进、删不掉」
  // 既误报 degraded、又把探针键留在存储里，两个后果同时发生。
  it("put 成功而 delete 失败时仍判为可写，只记日志，不误报 degraded", async () => {
    // console.* 已经被换成注入的 Logger（probeWritable 第 4 个可选参数）：spy console
    // 只会看到空 mock，必须改成 recordingLogger 断言事件名。
    const logger = recordingLogger();
    const health = createStorageHealth();
    const inner = new UndeletableStorage();
    const watched = watchStorage(inner, health, () => 5);

    expect(await probeWritable(watched, health, () => 5, logger)).toBeNull();
    expect(health.status().writable).toBe(true);
    expect(logger.has("storage.probe_cleanup_failed")).toBe(true);
    // 探针键删不掉只能留着，但它不以 `key:` 开头，不会被当成一把 key。
    expect(await inner.list("key:")).toEqual([]);
  });
});

// ── C-RM1 的真实文件系统复现：宿主目录属主不匹配 ≈ 数据目录对当前用户不可写 ──
// 容器内的表现是 uid 100 写 uid 1000 的目录；在单测里用「去掉写权限的目录」等价复现。
// root 无视权限位，因此以 root 跑测试时跳过（真机验证由容器那一侧覆盖）。
const notRoot = typeof process.getuid !== "function" || process.getuid() !== 0;

describe.skipIf(!notRoot)("真实文件系统上的可写性", () => {
  it("数据目录可写时 /health 报 ok", async () => {
    const dir = tmpDir();
    const app = await buildApp({ GATEWAY_TOKEN: "t" }, new FileStorage(dir), { probeStorage: true });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", storage: { writable: true } });
  });

  it("数据目录不可写时 /health 报 503 degraded，而不是继续报 healthy", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const dir = tmpDir();
      chmodSync(dir, 0o500); // r-x：读得到、写不进
      const app = await buildApp({ GATEWAY_TOKEN: "t" }, new FileStorage(dir), {
        probeStorage: true,
      });

      const res = await app.request("/health");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "degraded", storage: { writable: false } });
    } finally {
      warn.mockRestore();
    }
  });
});
