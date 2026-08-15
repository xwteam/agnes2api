import { describe, it, expect, beforeEach } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";

export function runStorageContract(name: string, make: () => Storage) {
  describe(`Storage 契约: ${name}`, () => {
    let s: Storage;
    beforeEach(() => { s = make(); });

    it("读不存在的键返回 null", async () => {
      expect(await s.get("missing")).toBeNull();
    });

    it("写入后能读回同样的对象", async () => {
      await s.put("k", { a: 1, b: "x" });
      expect(await s.get("k")).toEqual({ a: 1, b: "x" });
    });

    it("覆盖写入后读到新值", async () => {
      await s.put("k", { v: 1 });
      await s.put("k", { v: 2 });
      expect(await s.get("k")).toEqual({ v: 2 });
    });

    it("删除后读不到", async () => {
      await s.put("k", { v: 1 });
      await s.delete("k");
      expect(await s.get("k")).toBeNull();
    });

    it("list 只返回匹配前缀的键", async () => {
      await s.put("key:a", { v: 1 });
      await s.put("key:b", { v: 2 });
      await s.put("config", { v: 3 });
      const keys = (await s.list("key:")).sort();
      expect(keys).toEqual(["key:a", "key:b"]);
    });

    it("list 在无匹配时返回空数组", async () => {
      expect(await s.list("nothing:")).toEqual([]);
    });
  });
}

runStorageContract("MemoryStorage", () => new MemoryStorage());

// 仅在 workerd 下运行：真实 KV。navigator.userAgent === "Cloudflare-Workers"
// 是 workerd 官方约定的运行时标识（Hono 自身的 getRuntimeKey() 也用同一探测方式），
// 在 Node 下 navigator 要么不存在要么 userAgent 不是这个值，因此该分支互斥可靠。
if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
  const { env } = await import("cloudflare:test");
  const { KvStorage } = await import("../../src/adapters/storage-kv.js");
  runStorageContract("KvStorage", () => new KvStorage((env as { POOL: KVNamespace }).POOL));
} else {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FileStorage } = await import("../../src/adapters/storage-file.js");
  runStorageContract("FileStorage", () => new FileStorage(mkdtempSync(join(tmpdir(), "a2a-"))));
}
