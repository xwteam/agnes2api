import { describe, it, expect, beforeEach } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { IS_WORKERD } from "../helpers/is-workerd.js";

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

    // 以下并发用例针对全分支评审的 C1：原有 6 条全是单线程顺序操作，
    // 这正是 FileStorage 的并发缺陷（固定 .tmp 互抢 + 读改写竞态）能逃过
    // 15 轮评审的原因。dispatch 在返回成功响应前就要写回 key 状态，
    // 所以「两个并发请求」在生产里是常态而非边角场景。

    // 用独立前缀（而不是 key:）：workerd 下跑的是真 KV，命名空间在同一个测试文件
    // 的用例之间是持久的，共用 key: 前缀会与上面那条 list 用例互相污染。
    it("并发写入不同键时每个键都留存", async () => {
      const n = 20;
      const keys = Array.from({ length: n }, (_, i) => `conc:a${i}`);
      await Promise.all(keys.map((k, i) => s.put(k, { v: i })));

      const got = await Promise.all(keys.map((k) => s.get<{ v: number }>(k)));
      expect(got).toEqual(keys.map((_, i) => ({ v: i })));
      expect((await s.list("conc:a")).sort()).toEqual([...keys].sort());
    });

    it("并发写入同一个键不抛错，最终值是写入过的某一个", async () => {
      const n = 20;
      const results = await Promise.allSettled(
        Array.from({ length: n }, (_, i) => s.put("conc:same", { v: i })),
      );
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

      const final = await s.get<{ v: number }>("conc:same");
      expect(final).not.toBeNull();
      expect(final!.v).toBeGreaterThanOrEqual(0);
      expect(final!.v).toBeLessThan(n);
    });

    it("并发的写与删混合执行时，未被删的键不受影响", async () => {
      await s.put("conc:keep", { v: "keep" });
      const ops: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        ops.push(s.put(`conc:tmp${i}`, { v: i }));
        ops.push(s.delete(`conc:gone${i}`));
      }
      const results = await Promise.allSettled(ops);
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);

      expect(await s.get("conc:keep")).toEqual({ v: "keep" });
      const survivors = (await s.list("conc:tmp")).sort();
      expect(survivors).toHaveLength(10);
    });
  });
}

runStorageContract("MemoryStorage", () => new MemoryStorage());

// 仅在 workerd 下运行：真实 KV。判据见 tests/helpers/is-workerd.ts（唯一实现，
// 反向防线在 tests/workers-setup.ts）。
if (IS_WORKERD) {
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
