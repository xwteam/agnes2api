import { describe, it, expect } from "vitest";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { KEY_PREFIX, POOL_INDEX_KEY } from "../../src/core/pool-index.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import type { KeyRecord } from "../../src/core/types.js";

/**
 * `pool:index` 存了非 JSON 字节时的契约，**在真 KV 上跑一遍**。
 *
 * 单元测试里的计数桩用 `JSON.parse(raw)` 模拟 `KvStorage.get(k, "json")`，形状是对的，
 * 但这条防线的成因恰恰是「适配器在 parse 之前就抛」这个真实行为——用假实现验证一条
 * 关于真实现的断言，正是本项目反复栽进去的那类假阳性。这个文件在 workers 池里拿到的
 * 是 miniflare 的真 KV（见 vitest.workers.config.ts 与 storage.test.ts 的同款分流）。
 *
 * 为什么必须不抛：`all()` 抛 ⇒ 每个转发请求 500；而被指定为修复者的
 * `reconcileIndex()` 读同一个键**同样抛** ⇒ 两个入口的 try/catch 只吞掉记一条日志，
 * 它每 30 分钟徒劳地挂一次，永远修不好，只能人工删键。
 */

/** 坏字节：合法 JSON 的前缀，截断在数组中间。 */
const CORRUPT = '{"v":1,"ids":["a",';

function record(id: string, key: string): KeyRecord {
  return {
    id, key, addedAt: 1, lastUsedAt: null, cooldownUntil: 0,
    cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
  };
}

function runCorruptIndexContract(
  name: string,
  make: () => { storage: Storage; putRaw: (key: string, raw: string) => Promise<void> },
) {
  describe(`pool:index 坏字节契约: ${name}`, () => {
    it("all() 不抛、看得到 key，并把坏值覆盖成合法索引（自愈）", async () => {
      const { storage, putRaw } = make();
      const repo = new KeyPoolRepo(storage, { now: () => 1000, logger: NULL_LOGGER });
      const r = await repo.add("sk-corrupt-case-a");
      await putRaw(POOL_INDEX_KEY, CORRUPT);

      expect((await repo.all()).map((x) => x.id)).toEqual([r.id]);
      // 覆盖成功 ⇒ 下一次读得回合法结构（真 KV 上这一步同时验证了写确实落了盘）。
      expect(await storage.get(POOL_INDEX_KEY)).toEqual({ v: 1, ids: [r.id] });
    });

    it("reconcileIndex() 不抛，且把坏值修回来", async () => {
      const { storage, putRaw } = make();
      const repo = new KeyPoolRepo(storage, { now: () => 1000, logger: NULL_LOGGER });
      const r = await repo.add("sk-corrupt-case-b");
      await putRaw(POOL_INDEX_KEY, CORRUPT);

      const res = await repo.reconcileIndex();
      expect(res.repaired).toBe(true);
      expect(res.added).toContain(r.id);
      expect(await storage.get(POOL_INDEX_KEY)).toEqual({ v: 1, ids: res.added });
    });

    it("delete() 不被坏索引打死，记录照样删得掉", async () => {
      const { storage, putRaw } = make();
      const repo = new KeyPoolRepo(storage, { now: () => 1000, logger: NULL_LOGGER });
      const r = await repo.add("sk-corrupt-case-c");
      await putRaw(POOL_INDEX_KEY, CORRUPT);

      await expect(repo.delete(r.id)).resolves.toBeUndefined();
      expect(await storage.get(KEY_PREFIX + r.id)).toBeNull();
    });
  });
}

runCorruptIndexContract("MemoryStorage", () => {
  const storage = new MemoryStorage();
  const map = (storage as unknown as { map: Map<string, string> }).map;
  return { storage, putRaw: async (key, raw) => { map.set(key, raw); } };
});

// workerd 下追加一遍真 KV（与 storage.test.ts 同款的运行时分流）。
//
// **刻意不跑 FileStorage**：它把整个 `store.json` 当一份 JSON 读，「只有 pool:index
// 这一个值坏了」在文件形态下压根不是一个能存在的状态——真把那一段写坏，坏掉的是
// 整份存储，`get`/`list`/`put` 全都抛，那是另一个（P1 遗留的）问题，不是这条契约。
// 硬把它塞进来只会得到一条断言了假命题的用例。
if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
  const { env } = await import("cloudflare:test");
  const { KvStorage } = await import("../../src/adapters/storage-kv.js");
  runCorruptIndexContract("KvStorage（miniflare 真 KV）", () => {
    const kv = (env as { POOL: KVNamespace }).POOL;
    return { storage: new KvStorage(kv), putRaw: async (key, raw) => { await kv.put(key, raw); } };
  });
}
