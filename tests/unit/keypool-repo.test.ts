import { describe, it, expect } from "vitest";
import { KeyPoolRepo, keyId, INDEX_WRITE_RETRY_MS } from "../../src/core/keypool-repo.js";
import { KEY_PREFIX, POOL_INDEX_KEY } from "../../src/core/pool-index.js";
import { recordingLogger } from "../helpers/recording-logger.js";
import type { Storage } from "../../src/ports/storage.js";
import type { KeyRecord } from "../../src/core/types.js";

/**
 * **四种操作全数上**：Task 2 的教训是既有的 CountingStorage 只数 `put`/`delete`
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

function makeRepo(s: Storage = new CountingStorage(), now = () => 1000) {
  const logger = recordingLogger();
  return { repo: new KeyPoolRepo(s, { now, logger }), logger };
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
   * P3a 还没有面板、注册机默认关闭 ⇒ 手工导入就是 Worker 用户装 key 的**唯一**路径，
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
    // ② 再塞一条索引不知道的记录（手工导入，或将来 P3c 面板新增）。
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
  it("只读存储下不该每个请求都白扔一次 put 加一条 warn", async () => {
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
    expect(s.puts, "窗口内不再重试——put 失败也照样计入写配额").toBe(0);
    expect(s.lists, "但 list 回落照常，读路径行为一个字都不变").toBe(1);
    expect(logger.events(), "也不再刷 warn").toEqual([]);

    t += INDEX_WRITE_RETRY_MS;
    s.reset();
    logger.clear();
    expect(await repo.all()).toHaveLength(1);
    expect(s.puts, "窗口过后重新尝试一次").toBe(1);

    // 存储恢复可写之后要真的写进去。
    t += INDEX_WRITE_RETRY_MS;
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
