import { describe, it, expect } from "vitest";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { KEY_PREFIX } from "../../src/core/pool-index.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import { IS_WORKERD } from "../helpers/is-workerd.js";

/**
 * **删除不许被陈旧快照的写回撤销。**
 *
 * 这个文件存在的唯一理由是它**跨实例**。同一个 `KeyPoolRepo` 实例上 delete 再 save
 * 是观测不到这条不变量的：`delete()` 自己调了 `invalidate()`，本实例的快照里那条
 * 记录已经没了，于是「拿着陈旧记录写回」这个**被测的动作根本发生不了**——正是台账里
 * 第 5 类假阳性（测试覆盖的状态让被测的选择不可观测）。生产上的两个实例是：
 * Worker 的两个 isolate、Docker 的两个副本，以及**单副本 Docker 里 `buildApp` 持着
 * 60 秒快照、运维在容器运行中改 `store.json`** 这一种。
 *
 * 两条删除路径都要覆盖，且第二条才是今天真正会发生的那条：
 * ① `repo.delete()`（P3c 面板的删除按钮将来走它）；
 * ② **裸存储删除**——`wrangler kv key delete "key:<id>"` / 手工编辑 `store.json`。
 *    P3a 没有面板，这是**今天唯一存在的吊销姿势**，而它不动 `pool:index`：
 *    一次陈旧写回就能让记录复活并**立刻**重新可用，连对账都不用等。
 */

interface Case {
  name: string;
  make: () => Storage;
}

function makeRepo(storage: Storage, now: () => number) {
  // 60 秒快照 = 生产默认值。写消除关掉：本文件测的是「记录还在不在」，
  // 不该让 lastUsedAt 的触达间隔顺带把写吃掉，那会让断言变得说不清是谁挡下的。
  return new KeyPoolRepo(storage, {
    now, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 0,
  });
}

function runDeleteDurabilityContract({ name, make }: Case) {
  describe(`删除对陈旧写回免疫: ${name}`, () => {
    it("repo.delete() 之后，别的实例拿陈旧记录写回，记录不许复活，对账也不许把它捡回索引", async () => {
      const storage = make();
      const t = { v: 1000 };
      const repoA = makeRepo(storage, () => t.v);
      const repoB = makeRepo(storage, () => t.v);

      const r = await repoB.add("sk-durability-delete-path-aaaa");
      // A 预热快照：这一步之后 A 手上就有一份「记录还在」的陈旧视图。
      const stale = (await repoA.all()).find((x) => x.id === r.id);
      expect(stale, "前置条件：A 的快照里必须真的有这条记录").toBeTruthy();

      await repoB.delete(r.id);
      expect(await storage.get(KEY_PREFIX + r.id)).toBeNull();

      // A 的 TTL 还没到，它眼里这把 key 还在，上游一报错就会写回整条记录。
      await repoA.save({ ...stale!, strikes: 3, evicted: true, evictedReason: "strikes" }, stale!);

      expect(await storage.get(KEY_PREFIX + r.id), "记录被陈旧写回复活了").toBeNull();
      const rec = await repoA.reconcileIndex();
      expect(rec.added, "复活出来的孤儿被对账捡回了索引").not.toContain(r.id);
    });

    it("裸存储删除（wrangler kv key delete / 手工改 store.json）之后同样不许复活——索引还留着 id，复活即刻可用", async () => {
      const storage = make();
      const t = { v: 1000 };
      const repoA = makeRepo(storage, () => t.v);

      const r = await repoA.add("sk-durability-raw-delete-bbbb");
      const stale = (await repoA.all()).find((x) => x.id === r.id)!;

      // 运维吊销：只删记录，**不动 pool:index**（那正是文档里唯一给出的姿势）。
      await storage.delete(KEY_PREFIX + r.id);

      await repoA.save({ ...stale, strikes: 1 }, stale);

      expect(await storage.get(KEY_PREFIX + r.id), "记录被陈旧写回复活了").toBeNull();
      // 丢弃这次写的同时必须失效快照，否则这把已吊销的 key 还会继续被选中整整一个 TTL。
      expect((await repoA.all()).map((x) => x.id), "A 的快照里还留着已删的 key").not.toContain(r.id);
      // 全新实例（= 冷启动的另一个 isolate）也看不到它。
      expect((await makeRepo(storage, () => t.v).all()).map((x) => x.id)).not.toContain(r.id);
    });

    it("不许误伤 add()：新建记录本来就不存在，必须照常落盘", async () => {
      const storage = make();
      const repo = makeRepo(storage, () => 1000);
      const r = await repo.add("sk-durability-add-must-work-cc");
      expect(await storage.get(KEY_PREFIX + r.id)).toMatchObject({ id: r.id });
    });

    it("不许误伤正常更新：记录还在时，调度字段的变化必须落盘", async () => {
      const storage = make();
      const repo = makeRepo(storage, () => 1000);
      const r = await repo.add("sk-durability-update-must-work-d");
      await repo.save({ ...r, strikes: 2, cooldownUntil: 9999 }, r);
      expect(await storage.get(KEY_PREFIX + r.id)).toMatchObject({ strikes: 2, cooldownUntil: 9999 });
    });
  });
}

runDeleteDurabilityContract({ name: "MemoryStorage", make: () => new MemoryStorage() });

// workerd 下再跑一遍真 KV（与 pool-index-corrupt.test.ts 同款的运行时分流）。
// 真 KV 上这条契约多验一件事：`storage.get` 走的是适配器里那次真实的 KV 读，
// 而不是 Map 查表。
if (IS_WORKERD) {
  const { env } = await import("cloudflare:test");
  const { KvStorage } = await import("../../src/adapters/storage-kv.js");
  runDeleteDurabilityContract({
    name: "KvStorage（miniflare 真 KV）",
    make: () => new KvStorage((env as { POOL: KVNamespace }).POOL),
  });
}
