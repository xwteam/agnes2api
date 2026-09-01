import { describe, it, expect } from "vitest";
import {
  KeyPoolRepo, keyId, INDEX_WRITE_RETRY_MS, READ_PATH_LIST_BACKOFF_MS,
  LIST_FAIL_FAST_RETRY_MS, LIST_FAIL_ESCALATE_AFTER, DEFAULT_POOL_CACHE_TTL_MS,
} from "../../src/core/keypool-repo.js";
import { KEY_PREFIX, POOL_INDEX_KEY } from "../../src/core/pool-index.js";
import { recordingLogger } from "../helpers/recording-logger.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
// 别名：本文件已有一个同名的本地 `CountingStorage`（下方，prefix 级 failPutOn），
// 两者形状不同（这个是全局 putFails/listFails 布尔开关 + 暴露 inner），不能合并，
// 用别名避免与本地类撞名。
import { CountingStorage as QuotaStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import type { KeyRecord } from "../../src/core/types.js";

/**
 * **四种操作全数上**：早先的教训是既有的 CountingStorage 只数 `put`/`delete`
 * 不数 `get`，于是一条关于 `get` 的变异完全测不出来。计数桩漏掉哪一种，
 * 关于那一种的断言就是假的。
 */
class CountingStorage implements Storage {
  lists = 0; gets = 0; puts = 0; deletes = 0;
  readonly m = new Map<string, string>();
  /** 命中这个前缀集合里的键时，put 真的抛错（模拟只读存储 / 配额耗尽）。 */
  failPutOn: string[] = [];
  async get<T>(k: string): Promise<T | null> {
    this.gets++;
    const r = this.m.get(k);
    return r === undefined ? null : (JSON.parse(r) as T);
  }
  async put<T>(k: string, v: T): Promise<void> {
    this.puts++;
    if (this.failPutOn.some((p) => k.startsWith(p))) throw new Error(`EACCES: 写不进去 ${k}`);
    this.m.set(k, JSON.stringify(v));
  }
  async delete(k: string): Promise<void> { this.deletes++; this.m.delete(k); }
  async list(p: string): Promise<string[]> {
    this.lists++;
    return [...this.m.keys()].filter((k) => k.startsWith(p));
  }
  reset() { this.lists = 0; this.gets = 0; this.puts = 0; this.deletes = 0; }
  counts() { return { list: this.lists, get: this.gets, put: this.puts, delete: this.deletes }; }
}

/**
 * **本文件一律关掉快照缓存**（`cacheTtlMs: 0`）。
 *
 * 这里量的是「一次 all() 到底碰了存储几次、碰了哪些键」——索引回落、空结果兜底、
 * 写失败退避，全都是**存储层**的语义。开着缓存的话第二次 all() 根本不碰存储，
 * 这些断言就变成在测缓存而不是在测它们各自要守的那条防线（实测：开着缓存时
 * 「回落照常 list」那两条会绿得莫名其妙，因为它压根没去读）。
 *
 * 缓存本身由 `tests/unit/pool-cache.test.ts` 的「isolate 级快照缓存」专门覆盖，
 * 两边不互相冒充。
 * 默认值（不传 cacheTtlMs 时是 60 秒）由下面「默认值」那条用例单独钉住。
 */
function makeRepo(s: Storage = new CountingStorage(), now = () => 1000) {
  const logger = recordingLogger();
  return { repo: new KeyPoolRepo(s, { now, logger, cacheTtlMs: 0 }), logger };
}

function orphanRecord(): KeyRecord {
  return {
    id: "0123456789abcdef", key: "sk-orphan-orphan-orph", addedAt: 1, lastUsedAt: null,
    cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
  };
}

describe("add / get / save", () => {
  it("add 用注入的 now 填 addedAt——原来是裸 Date.now()，硬约束 2 的破口之一", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s, () => 424242);
    const r = await repo.add("sk-test-a");
    expect(r.addedAt).toBe(424242);
    // 断言具体值而不是「是个数」：回落到 Date.now() 也会是个数。
    expect(r.lastUsedAt).toBeNull();
    expect(r.strikes).toBe(0);
    expect(r.evicted).toBe(false);
  });

  it("add 之后 id 进了索引，记录也在", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const r = await repo.add("sk-test-a");
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!)).toEqual({ v: 1, ids: [r.id] });
    expect(s.m.has(KEY_PREFIX + r.id)).toBe(true);
  });

  /**
   * 计划把这条写序登记为「评审保证而非测试保证」（说 KV 的中途失败造不出来）。
   * 其实能造：让索引那次 `put` 真的抛错，两种写序都会让 `add()` reject，
   * **唯一的差别正是记录有没有落盘**——而这个差别是致命的，见下面的注释。
   */
  it("**先写记录**：索引写失败时 key 材料仍然落了盘，对账捡得回来", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const b = await repo.add("sk-test-b");      // 先让索引存在，避开 readIndexIds 的重建分支
    s.failPutOn = [POOL_INDEX_KEY];

    await expect(repo.add("sk-test-a")).rejects.toThrow(/写不进去/);

    // 写序若反过来（先进索引再写记录），indexAdd 先抛，记录一个字都写不进去。
    // 而 add() 的调用方（注册机 tender）此刻已经在 Agnes 侧真实建号并领到了 token：
    // key 材料丢了就再也找不回来，且没有任何对账能修——对账只认存储里已有的记录。
    const aId = await keyId("sk-test-a");
    expect(s.m.has(KEY_PREFIX + aId), "key 材料必须已经落盘").toBe(true);

    // 留下的是孤儿记录：暂时不被 all() 看到（fail-safe），由对账加回索引。
    expect((await repo.all()).map((x) => x.id)).toEqual([b.id]);
    s.failPutOn = [];
    expect((await repo.reconcileIndex()).added).toEqual([aId]);
    expect((await repo.all()).map((x) => x.id).sort()).toEqual([aId, b.id].sort());
  });

  it("get 按 id 取回记录，不存在返回 null", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const r = await repo.add("sk-test-a");
    expect((await repo.get(r.id))?.key).toBe("sk-test-a");
    expect(await repo.get("deadbeefdeadbeef")).toBeNull();
  });

  it("同一把 key 重复 add 不会让索引里出现两个相同 id", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    await repo.add("sk-test-a");
    s.reset();
    await repo.add("sk-test-a");
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!).ids).toHaveLength(1);
    // 第二次只写记录、不重写索引：id 已在索引里就该省下那次 put。
    expect(s.counts()).toEqual({ list: 0, get: 1, put: 1, delete: 0 });
  });

  /**
   * `list()` 在 KV 上是最终一致的——这个文件自己在 `loadRecords` 的注释里就写着
   * 「`add` 的写序天然存在『索引已更新、记录尚未可见』的窗口」。`indexAdd` 索引
   * 整个缺失那条分支不能想当然地信「`save()` 刚写完，`list()` 必然读得到它」，
   * 必须显式把这次的 `id` 并进去，而不是原样写 `list()` 看到的结果。
   *
   * 用一个「`list()` 滞后一拍」的存储桩复现：紧跟在 `put` 后面的那次 `list`
   * 看不到刚写的键，要再等下一次 `list` 才揭晓——这正是评审实测复现的形态。
   */
  class LaggingListStorage implements Storage {
    private readonly inner = new MemoryStorage();
    private visible = new Set<string>();
    private pending: string[] = [];
    async get<T>(k: string): Promise<T | null> { return this.inner.get<T>(k); }
    async put<T>(k: string, v: T): Promise<void> {
      await this.inner.put(k, v);
      this.pending.push(k);
    }
    async delete(k: string): Promise<void> { return this.inner.delete(k); }
    async list(prefix: string): Promise<string[]> {
      const result = [...this.visible].filter((k) => k.startsWith(prefix));
      // 这次 list 揭晓的是**上一批**已经落地的写，这次调用之前刚 put 的还要再等
      // 下一次 list 才看得见——与真实 KV「最终一致」的滞后同形。
      this.visible = new Set([...this.visible, ...this.pending]);
      this.pending = [];
      return result;
    }
  }

  it("索引整个缺失时首次 add()，即使 list() 滞后看不到刚写的记录，索引也不许漏掉这把 key", async () => {
    const s = new LaggingListStorage();
    const repo = new KeyPoolRepo(s, { now: () => 1000, logger: NULL_LOGGER, cacheTtlMs: 0, touchIntervalMs: 0 });
    const r = await repo.add("sk-lagging-list-aaaaaaaaaa");
    const idx = await s.get<{ v: number; ids: string[] }>(POOL_INDEX_KEY);
    // 行为断言：索引里必须包含这把刚建的 key，不是「写了点什么」这种形状断言。
    expect(idx?.ids, "list() 滞后不许把刚建的 key 漏出索引，它会变成孤儿").toContain(r.id);
  });
});

describe("all()：热路径零 list", () => {
  it("索引存在时 all() 消耗 1 次 get(索引) + N 次 get(记录)，list 为 0", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    for (let i = 0; i < 20; i++) await repo.add(`sk-key-number-${i}-aaaaaaaa`);
    s.reset();
    const rs = await repo.all();
    expect(rs).toHaveLength(20);
    // 这四个数字就是 §配额账「改造后」那一行的证据，改坏任何一条都会变红。
    expect(s.counts(), "热路径不许出现 list，也不许有写").toEqual({
      list: 0, get: 21, put: 0, delete: 0,
    });
  });

  it("索引缺失时回落 list 并重建，**之后不再 list**", async () => {
    const s = new CountingStorage();
    const { repo, logger } = makeRepo(s);
    for (let i = 0; i < 3; i++) await repo.add(`sk-key-number-${i}-aaaaaaaa`);
    s.m.delete(POOL_INDEX_KEY);            // 模拟索引被误删
    s.reset();
    // 建池那几次 add 自己就会打 index_bootstrapped（首次 add 时索引还不存在）。
    // 不清空的话下面那条 has() 断言即使回落路径一声不吭也照样绿——这正是本项目
    // 反复栽进去的那类假阳性（fixture 里已经躺着答案）。
    logger.clear();

    expect(await repo.all()).toHaveLength(3);
    expect(s.lists, "缺失时回落一次 list").toBe(1);
    expect(logger.has("pool.index_bootstrapped")).toBe(true);

    s.reset();
    expect(await repo.all()).toHaveLength(3);
    expect(s.counts(), "重建之后不该再 list，也不该再写").toEqual({
      list: 0, get: 4, put: 0, delete: 0,
    });
  });

  it("索引结构脏（版本不认识）时同样回落重建", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    // 脏索引里放**真实存在**的 id：否则活记录数为 0，会被「空结果兜底」那条路径
    // 顺带救回来，于是「版本判断被删掉」这个变异照样绿——断言就成了同义反复。
    // 放真 id 之后，版本判断没生效的话 alive 非空、根本不会回落，lists 与 v 两条
    // 断言同时变红。
    s.m.set(POOL_INDEX_KEY, JSON.stringify({ v: 99, ids: [a.id] }));
    s.reset();
    expect(await repo.all()).toHaveLength(1);
    expect(s.lists, "版本不认识 ⇒ 当作缺失 ⇒ 回落 list 重建").toBe(1);
    // 脏索引被就地覆盖成认识的版本，而不是与它共存。
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!).v).toBe(1);
  });

  it("重建索引时写失败不让读路径跟着挂——只读存储下 all() 必须照常工作", async () => {
    const s = new CountingStorage();
    const { repo, logger } = makeRepo(s);
    await repo.add("sk-test-a");
    s.m.delete(POOL_INDEX_KEY);
    s.failPutOn = [POOL_INDEX_KEY];        // put 真的 throw，不是返回失败对象
    logger.clear();
    expect(await repo.all(), "读路径不受影响").toHaveLength(1);
    expect(logger.has("pool.index_write_failed")).toBe(true);
  });

  it("幽灵索引项（索引有 id、记录没了）被 filter 掉，且**不在读路径上剪枝**", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    const b = await repo.add("sk-test-b");
    s.m.delete(KEY_PREFIX + b.id);          // 只删记录，索引里留着
    expect((await repo.all()).map((r) => r.id)).toEqual([a.id]);
    // 读路径剪枝会在 KV 最终一致的窗口里把刚铸出来的新 key 悄悄抹掉，所以刻意不剪。
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!).ids).toEqual([a.id, b.id]);
  });

  it("孤儿记录（记录在、索引没有）在对账前不被 all() 看到——fail-safe：不用，而不是误用", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    const orphan = orphanRecord();
    s.m.set(KEY_PREFIX + orphan.id, JSON.stringify(orphan));
    expect((await repo.all()).map((r) => r.id)).toEqual([a.id]);
  });
});

describe("空结果兜底：权威的空索引不许让手工导入的 key 隐身", () => {
  /**
   * 评审用真 KV 复现的回退场景，逐步跑一遍。
   * 那时还没有面板、注册机默认关闭 ⇒ 手工导入就是 Worker 用户装 key 的**唯一**路径，
   * 而改造前 `all()` 直接 list("key:")，导入即刻生效。
   */
  it("对账在空池写下权威空索引之后，手工导入的 key 仍然看得见", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);

    // ① 全新部署：cron 在空 KV 上跑一次对账，写下**合法的**空索引。
    await repo.reconcileIndex();
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!), "索引是合法的，永远不会走缺失回落")
      .toEqual({ v: 1, ids: [] });

    // ② 用户按 DEPLOY.md 直接写一条 key: 记录（不经过 add()，因此不进索引）。
    const manual = orphanRecord();
    s.m.set(KEY_PREFIX + manual.id, JSON.stringify(manual));
    s.reset();

    // ③ 立刻转发：必须看得到这把 key，而不是 503 pool_empty。
    expect((await repo.all()).map((r) => r.id)).toEqual([manual.id]);
    expect(s.lists, "空结果时回落一次 list").toBe(1);

    // ④ 索引被补上，之后回到零 list 的热路径。
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!).ids).toEqual([manual.id]);
    s.reset();
    expect(await repo.all()).toHaveLength(1);
    expect(s.counts(), "补完之后不该再 list、也不该再写").toEqual({
      list: 0, get: 2, put: 0, delete: 0,
    });
  });

  it("池子真空时回落 list 但**不写**索引——空池每个请求本来就在返 503，不能顺带吃写配额", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    await repo.reconcileIndex();
    s.reset();
    expect(await repo.all()).toEqual([]);
    expect(s.counts()).toEqual({ list: 1, get: 1, put: 0, delete: 0 });
  });

  /**
   * **混合场景：索引里同时有幽灵 id 和一条索引不知道的新记录。**
   *
   * 这条是「只增不减」唯一真正的守门人，别删。上下两条各自只覆盖单一状态，
   * 而在单一状态下「写 merged」与「写 actual」根本产生不了可观测差异：
   *   - 纯幽灵：actual=[]，merged=indexed ⇒ sameIdSet 为真 ⇒ **一个字都不写**，两者同效
   *   - 纯手工导入：indexed=[]，merged=actual ⇒ 两个参数**数学上就是同一个值**
   * 于是「把 writeIndexBestEffort 的实参从 merged 换成 actual」——正是「读路径剪枝」
   * 这件被反复强调绝不能做的事——在只有那两条用例时能完整逃逸（实测 568/568 全绿）。
   * 只有幽灵与新记录**同时存在**，merged=[幽灵,新] 与 actual=[新] 才分得开。
   */
  it("混合场景：既有幽灵 id 又有索引不知道的新记录——补新的，但**不剪**旧的", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);

    // ① 造一个幽灵索引项：add 之后只删记录，索引里把 id 留着。
    const ghost = await repo.add("sk-ghost-key-aaaaaaaa");
    s.m.delete(KEY_PREFIX + ghost.id);
    // ② 再塞一条索引不知道的记录（手工导入，或将来面板新增）。
    const manual = orphanRecord();
    s.m.set(KEY_PREFIX + manual.id, JSON.stringify(manual));
    s.reset();

    // 索引里只有幽灵 ⇒ 活记录数为 0 ⇒ 触发空结果兜底。
    expect((await repo.all()).map((r) => r.id)).toEqual([manual.id]);

    const ids: string[] = JSON.parse(s.m.get(POOL_INDEX_KEY)!).ids;
    // **两条必须同时断言**：只断言前者，写 actual（剪枝）照样绿；
    // 只断言后者，什么都不写也照样绿。
    expect(ids, "索引不知道的新记录要被补进去").toContain(manual.id);
    expect(ids, "幽灵 id 不许在读路径上被剪掉——剪枝只由对账做").toContain(ghost.id);
    expect([...ids].sort(), "而且只有这两个").toEqual([ghost.id, manual.id].sort());

    // 代价钉死：1 次 list + 3 次 get（索引 + 幽灵 + 新记录）+ 1 次补写。
    expect(s.counts()).toEqual({ list: 1, get: 3, put: 1, delete: 0 });
  });

  it("空结果的回落**只增不减**：整池都成了幽灵索引项时也不在读路径上剪枝", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    s.m.delete(KEY_PREFIX + a.id);   // 记录没了，索引里还留着 ⇒ 活记录数为 0
    s.reset();

    expect(await repo.all()).toEqual([]);
    expect(s.lists, "空结果照样回落一次").toBe(1);
    // 剪枝会在热路径上加一次 put，那正是本模块要消灭的东西；一律交给对账。
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!).ids, "读路径绝不从索引里删").toEqual([a.id]);
    expect(s.puts).toBe(0);
  });
});

describe("pool:index 存了非 JSON 字节", () => {
  /**
   * `KvStorage.get(k, "json")` 对坏字节是**先抛**的，`parsePoolIndex` 的
   * 「结构脏 ⇒ 当作缺失 ⇒ 重建」那条防线根本没机会执行。下面这个计数桩的 `get`
   * 就是 `JSON.parse(raw)`，与 KvStorage 同形；真 KV 上的等价验证在
   * tests/contract/pool-index-corrupt.test.ts。
   */
  const BAD = '{"v":1,"ids":["a",';

  it("all() 不许抛，且顺手把坏值覆盖掉", async () => {
    const s = new CountingStorage();
    const { repo, logger } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    s.m.set(POOL_INDEX_KEY, BAD);
    logger.clear();

    expect((await repo.all()).map((r) => r.id), "读路径照常工作").toEqual([a.id]);
    expect(logger.has("pool.index_unreadable")).toBe(true);
    // 自愈：坏值已被合法索引覆盖，下一次不再需要 list。
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!)).toEqual({ v: 1, ids: [a.id] });
    s.reset();
    expect(await repo.all()).toHaveLength(1);
    expect(s.lists).toBe(0);
  });

  it("reconcileIndex() 也不许抛——它被指定为修复者，被同一份输入打死就永远修不好", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    s.m.set(POOL_INDEX_KEY, BAD);

    const r = await repo.reconcileIndex();
    expect(r.repaired).toBe(true);
    expect(r.added).toEqual([a.id]);
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!)).toEqual({ v: 1, ids: [a.id] });
  });

  it("delete() 也不许被坏索引打死", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    s.m.set(POOL_INDEX_KEY, BAD);
    await expect(repo.delete(a.id)).resolves.toBeUndefined();
    expect(s.m.has(KEY_PREFIX + a.id)).toBe(false);
  });

  it("存储是真挂了（不止索引这一个键坏）时，错误照旧浮出来——不许被这层 try/catch 吞掉", async () => {
    class BrokenStorage implements Storage {
      async get<T>(): Promise<T | null> { throw new Error("磁盘挂了"); }
      async put(): Promise<void> { throw new Error("磁盘挂了"); }
      async delete(): Promise<void> { throw new Error("磁盘挂了"); }
      async list(): Promise<string[]> { throw new Error("磁盘挂了"); }
    }
    const { repo } = makeRepo(new BrokenStorage());
    await expect(repo.all()).rejects.toThrow(/磁盘挂了/);
  });
});

describe("索引写连续失败时的退避", () => {
  /**
   * ⚠️ **本用例在 Step 2 之后被改写过，别用旧版本的数字类比新版本。**
   *
   * 旧版本假设「索引缺失那扇门的 list 完全不节流，只有 put 节流」，于是能单独
   * 观测 `INDEX_WRITE_RETRY_MS` 的退避。Step 2 之后 list 本身也走 `listOnReadPath`
   * 的退避闸（`READ_PATH_LIST_BACKOFF_MS = 600_000`），而它比 `INDEX_WRITE_RETRY_MS`
   * (300_000) 更长——`writeIndexBestEffort` 只会在 list 真的重新发起时才被调用，
   * 而那一刻距上次写尝试必然已经过了至少 600_000ms，早就超过它自己的 300_000ms
   * 窗口。也就是说对这两个调用点（`bootstrapFromListThrottled` /
   * `rescanEmptyResult`）而言，`INDEX_WRITE_RETRY_MS` 自己的退避判据永远不会
   * 成为限制因素——外层的 list 退避已经更严格。这不是本次改动引入的死代码
   * （`writeIndexBestEffort` 仍然正确、仍然被 `reconcileIndex()` 之外的路径共用，
   * 只是在这两个调用点上从「主要防线」退化成「用不上但无害的第二道保险」），
   * 所以本用例改为验证**实际会发生什么**：list 与 put 都被外层的 list 退避闸罩住。
   */
  it("list 退避窗口内，索引重建连 list 都不再发起，遑论 put", async () => {
    const s = new CountingStorage();
    let t = 1000;
    const { repo, logger } = makeRepo(s, () => t);   // 递进假时钟，不用真实时间
    await repo.add("sk-test-a");
    s.m.delete(POOL_INDEX_KEY);
    s.failPutOn = [POOL_INDEX_KEY];
    s.reset();
    logger.clear();

    expect(await repo.all(), "读路径始终照常工作").toHaveLength(1);
    expect(s.puts, "第一次照常尝试").toBe(1);
    expect(logger.has("pool.index_write_failed")).toBe(true);

    s.reset();
    logger.clear();
    expect(await repo.all()).toHaveLength(1);
    // list 本身现在也在退避窗口内（READ_PATH_LIST_BACKOFF_MS，比 put 自己的
    // INDEX_WRITE_RETRY_MS 更长）：窗口内连 list 都不会重新发起，写更不会尝试。
    expect(s.puts, "list 退避窗口内不会重试，写更不会尝试").toBe(0);
    expect(s.lists, "list 也在退避窗口内，一次都不该有").toBe(0);
    expect(logger.events(), "也不再刷 warn").toEqual([]);

    t += READ_PATH_LIST_BACKOFF_MS;   // 跨过 list 的退避窗口（比 put 的更长，以它为准）
    s.reset();
    logger.clear();
    expect(await repo.all()).toHaveLength(1);
    expect(s.lists, "list 窗口过后重新尝试一次").toBe(1);
    // put 自己的退避窗口（300_000）远小于这次跨越的 600_000，
    // 所以这次 list 之后写照常尝试（且仍失败）。
    expect(s.puts, "put 自己的退避窗口早就过了，这次照常尝试").toBe(1);
    expect(logger.has("pool.index_write_failed")).toBe(true);

    // 存储恢复可写之后要真的写进去：再跨一个 list 窗口。
    t += READ_PATH_LIST_BACKOFF_MS;
    s.failPutOn = [];
    s.reset();
    logger.clear();
    expect(await repo.all()).toHaveLength(1);
    expect(logger.has("pool.index_bootstrapped")).toBe(true);
    s.reset();
    expect(await repo.all()).toHaveLength(1);
    expect(s.lists, "索引终于写进去了，回到零 list").toBe(0);
  });

  it("时钟被回拨时立刻恢复尝试，而不是被抑制到回拨量走完", async () => {
    // 退避窗口是拿「当前时刻 - 上次失败时刻」算的，NTP 回拨会让这个差变成负数。
    // 不显式挡住的话，回拨 1 小时就等于停写索引 1 小时——每个请求多一次 list。
    const s = new CountingStorage();
    let t = 1_000_000;
    const { repo } = makeRepo(s, () => t);
    await repo.add("sk-test-a");
    s.m.delete(POOL_INDEX_KEY);
    s.failPutOn = [POOL_INDEX_KEY];
    s.reset();

    await repo.all();
    expect(s.puts, "先失败一次，进入退避").toBe(1);

    t -= 3_600_000;                 // 时钟回拨一小时
    s.failPutOn = [];
    s.reset();
    await repo.all();
    expect(s.puts, "回拨之后必须重新尝试").toBe(1);
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!).ids).toHaveLength(1);
  });
});

describe("delete()：先删记录、再出索引", () => {
  it("删完之后记录与索引项都没了", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    const b = await repo.add("sk-test-b");
    await repo.delete(a.id);
    expect(s.m.has(KEY_PREFIX + a.id)).toBe(false);
    expect(JSON.parse(s.m.get(POOL_INDEX_KEY)!).ids).toEqual([b.id]);
    expect((await repo.all()).map((r) => r.id)).toEqual([b.id]);
  });

  it("**先删记录**：写索引失败时留下的是幽灵索引项而不是孤儿记录，删除结果保得住", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    s.failPutOn = [POOL_INDEX_KEY];
    await expect(repo.delete(a.id)).rejects.toThrow(/写不进去/);
    // 记录已经没了 ⇒ 对账以 list 为准，会把幽灵项剪掉，删除不会被撤销。
    expect(s.m.has(KEY_PREFIX + a.id)).toBe(false);
    s.failPutOn = [];
    const r = await repo.reconcileIndex();
    expect(r.removed).toEqual([a.id]);
    expect(await repo.all()).toEqual([]);
  });

  it("删不存在的 id 不抛错也不写索引", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    await repo.add("sk-test-a");
    s.reset();
    await repo.delete("deadbeefdeadbeef");
    expect(s.counts(), "索引不该被无谓地重写一次——写配额是最紧的桶").toEqual({
      list: 0, get: 1, put: 0, delete: 1,
    });
  });
});

describe("reconcileIndex()", () => {
  it("把孤儿记录加回索引", async () => {
    const s = new CountingStorage();
    const { repo, logger } = makeRepo(s);
    await repo.add("sk-test-a");
    const orphan = orphanRecord();
    s.m.set(KEY_PREFIX + orphan.id, JSON.stringify(orphan));
    logger.clear();

    const r = await repo.reconcileIndex();
    expect(r.repaired).toBe(true);
    expect(r.added).toEqual([orphan.id]);
    expect(r.removed).toEqual([]);
    expect((await repo.all()).map((x) => x.id).sort()).toContain(orphan.id);
    expect(logger.has("pool.index_repaired")).toBe(true);
  });

  it("一致时不写、不记事件——48 次/天的对账不该白白吃写配额", async () => {
    const s = new CountingStorage();
    const { repo, logger } = makeRepo(s);
    await repo.add("sk-test-a");
    await repo.reconcileIndex();
    s.reset();
    logger.clear();
    const r = await repo.reconcileIndex();
    expect(r.repaired).toBe(false);
    expect(logger.events()).toEqual([]);
    expect(s.counts(), "对账的全部成本就是一次 list 加一次 get").toEqual({
      list: 1, get: 1, put: 0, delete: 0,
    });
  });

  it("顺序不同不算不一致", async () => {
    const s = new CountingStorage();
    const { repo } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    const b = await repo.add("sk-test-b");
    s.m.set(POOL_INDEX_KEY, JSON.stringify({ v: 1, ids: [b.id, a.id] }));
    s.reset();
    expect((await repo.reconcileIndex()).repaired).toBe(false);
    expect(s.puts).toBe(0);
  });

  it("索引整个缺失时对账把它建起来，并记 bootstrapped 而不是 repaired", async () => {
    const s = new CountingStorage();
    const { repo, logger } = makeRepo(s);
    const a = await repo.add("sk-test-a");
    s.m.delete(POOL_INDEX_KEY);
    logger.clear();
    const r = await repo.reconcileIndex();
    expect(r.repaired).toBe(true);
    expect(r.added).toEqual([a.id]);
    expect(logger.has("pool.index_bootstrapped")).toBe(true);
    expect(logger.has("pool.index_repaired")).toBe(false);
  });
});

describe("keyId", () => {
  it("确定性：同一把 key 恒得同一个 id（重复导入靠它识别）", async () => {
    expect(await keyId("sk-x")).toBe(await keyId("sk-x"));
    expect(await keyId("sk-x")).not.toBe(await keyId("sk-y"));
    expect(await keyId("sk-x")).toHaveLength(16);
  });
});

describe("索引缺失那扇门不许每个 TTL 烧一次 list", () => {
  /**
   * 防住的真实故障：全新 Worker 上索引被删/写不进去（写桶打穿是最常见的复合故障），
   * 读路径每个快照 TTL 回落一次 list ⇒ 默认 60 秒 TTL 下 **1440 次/天/isolate**，
   * 而免费档 list 桶只有 1,000 次/天、且与网关转发共用。
   * 桶穿之后 all() 抛、reconcileIndex() 读同一个桶同样抛，两条自愈路径一起死。
   *
   * 期望值 **2** 是手写字面量，不是从 86400/BACKOFF 算出来的：第 0 秒一次，
   * 跨过 600 秒退避窗口之后（第 600 秒那一批请求）再一次。
   *
   * ⚠️ **循环要跑 11 轮，不是 10 轮**：`t` 在每轮末尾才 `+= 60_000`，所以 10 轮
   * 循环里 `repo.all()` 实际只在 `t = 0, 60000, …, 540000` 这 10 个点上被调用，
   * 从未真正到达 `t = 600000`——那样只会观测到 1 次 list（本计划初稿在这里算错了，
   * 自查时实测才发现：10 轮时是 1 次，不是 2 次）。跑满 11 轮才会让最后一批请求
   * 落在 `t = 600000`，退避窗口在那一刻恰好走完，第 2 次 list 才会真的发生。
   */
  it("索引缺失 + 索引写不进去时，跨过 600 秒退避窗口只回落 2 次 list（不是每 TTL 一次）", async () => {
    const st = new QuotaStorage();
    const seed = new KeyPoolRepo(st, { now: () => 0, logger: NULL_LOGGER, cacheTtlMs: 0, touchIntervalMs: 0 });
    await seed.add("sk-index-door-aaaaaaaaaaaa");
    await st.inner.delete("pool:index");        // 索引缺失
    st.putFails = true;                          // 写桶打穿：索引重建不进去

    let t = 0;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 0 });
    const before = st.lists;
    for (let i = 0; i <= 10; i++) {
      for (let r = 0; r < 20; r++) await repo.all();   // 一个 TTL 内 20 个请求
      t += 60_000;
    }
    // 11 轮请求横跨 t = 0..600000；退避窗口 600 秒 ⇒ t=0 与 t=600000 各一次。
    expect(st.lists - before, "索引缺失那扇门又开始每个 TTL 烧一次 list 了").toBe(2);
  });

  it("池子始终能读出来——退避省的是 list，不是正确性", async () => {
    const st = new QuotaStorage();
    const seed = new KeyPoolRepo(st, { now: () => 0, logger: NULL_LOGGER, cacheTtlMs: 0, touchIntervalMs: 0 });
    await seed.add("sk-index-door-bbbbbbbbbbbb");
    await st.inner.delete("pool:index");
    st.putFails = true;
    let t = 0;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 0 });
    for (let i = 0; i < 10; i++) {
      expect((await repo.all()).length, `第 ${i} 个 TTL`).toBe(1);
      t += 60_000;
    }
  });
});

describe("一次瞬时 list 失败不许粘住十分钟", () => {
  /**
   * 防住的真实故障：池子**真的是空的** + 一次瞬时 list 抖动 ⇒ 退避窗口被武装，
   * 此后十分钟内每个请求都拿着那份**陈旧的**异常报 500 `list quota exhausted`，
   * 而真相是「你还没导 key」。运维被指向完全相反的方向。
   *
   * 修法：失败按**连续次数**分档——第 1 次尝试不受阻拦，第 2、3 次尝试各被一个 60 秒
   * 的快窗口挡住（累计 2 分钟），第 3 次失败后（达到 `LIST_FAIL_ESCALATE_AFTER = 3`）
   * 才升到完整的 600 秒长退避。一次抖动最多误导 60 秒；持续故障仍然只有 ≤147 次 list/天
   *（≤144 次的长退避节奏，另加最初这 2 个快窗口带来的 2 次额外尝试）。
   */
  it("一次失败之后，过了快重试窗口就重新尝试，不必等满长退避", async () => {
    const st = new QuotaStorage();
    let t = 0;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 0, touchIntervalMs: 0 });
    await st.inner.put("pool:index", { v: 1, ids: [] });   // 权威空索引 ⇒ 走空池兜底

    st.listFails = true;
    await expect(repo.all()).rejects.toThrow("list quota exhausted");
    const afterFirst = st.lists;

    st.listFails = false;
    t += LIST_FAIL_FAST_RETRY_MS;                          // 只等快重试窗口
    // 不再抛，且真的重新 list 了一次——两条都要断言：只断言「不抛」的话，
    // 「退避窗口内返回空数组」这种实现也能过（那正是当初要修掉的伪装）。
    expect(await repo.all()).toEqual([]);
    expect(st.lists, "快重试窗口过后必须真的重试 list").toBe(afterFirst + 1);
  });

  it("连续失败三次之后升到长退避——持续故障不许每分钟烧一次 list", async () => {
    const st = new QuotaStorage();
    let t = 0;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 0, touchIntervalMs: 0 });
    await st.inner.put("pool:index", { v: 1, ids: [] });
    st.listFails = true;

    const before = st.lists;
    for (let i = 0; i < 3; i++) {
      await expect(repo.all(), `第 ${i + 1} 次`).rejects.toThrow();
      t += LIST_FAIL_FAST_RETRY_MS;
    }
    const afterThree = st.lists;
    /**
     * ⚠️ **「恰好三次」这一条以前没有被断言过**（评审查实）：这一格原来只
     * 检查第 4 次之后 `st.lists` 不再增长，而 `keypool-repo.ts` 的注释却写着
     * 「按这个时序实测钉住：三次真实尝试恰好落在 t0 / t0+60s / t0+120s」。
     * 把 `LIST_FAIL_ESCALATE_AFTER` 从 3 改成 2 或 5，那句话就不成立了，
     * 而这一格照样全绿。期望值 **3 手写**，不是 `LIST_FAIL_ESCALATE_AFTER`
     * 现算的——从被测常数自己推导出期望值是本仓登记的第 6 种假阳性。
     */
    expect(afterThree - before, "快窗口里的真实尝试次数不是三次").toBe(3);
    // 第 4 次：只过了快重试窗口，此时应当已经升到长退避 ⇒ 不再真 list，但仍如实抛。
    await expect(repo.all()).rejects.toThrow("list quota exhausted");
    expect(st.lists, "连续失败之后仍在每分钟烧一次 list").toBe(afterThree);
  });
});

describe("索引写失败的退避常数不许是死条件", () => {
  /**
   * 实测过的真实缺陷：INDEX_WRITE_RETRY_MS 与 DEFAULT_POOL_CACHE_TTL_MS **都是 60_000**，
   * 而判据是 `since < RETRY`——两次尝试恰好间隔一个 TTL 时 `since === 60_000`，
   * 不小于，于是**一次都不被抑制**。跨 10 个 TTL 实测 puts=10。
   *
   * 这条是**行为**断言（数 put 次数），下面那条常数关系只是给读代码的人一个绊线。
   */
  it("索引写一直失败时，跨 10 个 TTL 的 put 尝试次数远少于 10", async () => {
    const st = new QuotaStorage();
    const seed = new KeyPoolRepo(st, { now: () => 0, logger: NULL_LOGGER, cacheTtlMs: 0, touchIntervalMs: 0 });
    await seed.add("sk-dead-backoff-cccccccccccc");
    await st.inner.delete("pool:index");
    st.putFails = true;
    let t = 0;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 0 });
    const before = st.puts;
    for (let i = 0; i < 10; i++) { await repo.all(); t += 60_000; }
    expect(st.puts - before, "索引写退避是死条件").toBeLessThanOrEqual(2);
  });

  it("常数关系：索引写退避必须显著大于快照 TTL，否则那条判据永远不成立", () => {
    // 字面量与关系**都**断言：字面量防「悄悄改小」，关系解释「为什么是这个数」。
    expect(INDEX_WRITE_RETRY_MS).toBe(300_000);
    expect(DEFAULT_POOL_CACHE_TTL_MS).toBe(60_000);
    expect(INDEX_WRITE_RETRY_MS).toBeGreaterThanOrEqual(5 * DEFAULT_POOL_CACHE_TTL_MS);
    expect(READ_PATH_LIST_BACKOFF_MS).toBe(600_000);
    expect(LIST_FAIL_FAST_RETRY_MS).toBe(60_000);
    // ⚠️ **LIST_FAIL_ESCALATE_AFTER 以前不在这张表里**（评审查实）——它是
    // keypool-repo.ts 里**唯一一个缺席常数表的导出常数**，而 keypool-repo.ts 的
    // 注释恰恰拿"三次"当它整段时序论证的支点。
    expect(LIST_FAIL_ESCALATE_AFTER).toBe(3);
    // 关系：门槛必须 ≥ 2，否则一次瞬时抖动就直接升到 10 分钟长退避，
    // "快窗口滤抖动"这条设计意图整个失效（那正是 LIST_FAIL_FAST_RETRY_MS 存在的理由）。
    expect(LIST_FAIL_ESCALATE_AFTER).toBeGreaterThanOrEqual(2);
  });
});

describe("listOnReadPath 的退避窗口也要挡住时钟回拨", () => {
  /**
   * 同一个模块家族里 `writeIndexBestEffort` 早就显式挡了 `since < 0`
   *（NTP 回拨），`listOnReadPath` 的判据是同一个形状，必须挡同一件事，
   * 否则 NTP 把时钟往回拨 T 毫秒之后，`since` 变成一个很大的负数，恒小于
   * 退避窗口，这扇闸会在「回拨量 + 一个退避窗口」那么久里一直判定「还在
   * 窗口内」，把索引缺失回落的 list 冻结住——比 K9 冻结 Refreshable 更隐蔽，
   * 因为退避窗口内沿用 `lastKnownIds` 仍然给得出一份看起来正确的结果，
   * 唯一能观测到的只有「list 该发生却没发生」这件事本身。
   */
  it("索引缺失回落 list 之后，时钟回拨不许把重试冻结住", async () => {
    const st = new QuotaStorage();
    const seed = new KeyPoolRepo(st, { now: () => 0, logger: NULL_LOGGER, cacheTtlMs: 0, touchIntervalMs: 0 });
    await seed.add("sk-clock-rollback-aaaaaaaaaa");
    await st.inner.delete("pool:index");
    st.putFails = true;   // 索引重建写不进去，逼后续每次都还得走 bootstrapFromListThrottled

    let t = 1_000_000;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 0, touchIntervalMs: 0 });
    expect((await repo.all()).length, "第一次照常回落 list").toBe(1);
    const afterFirst = st.lists;

    t -= 3_600_000;   // NTP 往回拨一小时
    expect((await repo.all()).length, "回拨之后仍要能读出正确的池子").toBe(1);
    // 期望值是行为断言：真的又发起了一次 list，不是「结果还对」这种形状断言
    //（沿用 lastKnownIds 也能凑出正确的返回值，掩盖了「list 被冻结」这件事）。
    expect(st.lists, "回拨之后必须立刻恢复尝试，不能被负的 since 卡死").toBe(afterFirst + 1);
  });
});
