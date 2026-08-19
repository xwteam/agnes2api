import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  KeyPoolRepo, FIELD_ROLE,
  DEFAULT_POOL_CACHE_TTL_MS, DEFAULT_POOL_TOUCH_INTERVAL_MS,
} from "../../src/core/keypool-repo.js";
import { KEY_PREFIX } from "../../src/core/pool-index.js";
import { selectKey, isAvailable, poolHealth, applySuccess, applyStrike } from "../../src/core/keypool.js";
import { withOutcome } from "../../src/core/admin/stats.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import type { Storage } from "../../src/ports/storage.js";
import type { KeyRecord } from "../../src/core/types.js";
/**
 * ⚠️ **改名导入。** 本文件顶部另有一个同名的本地 `CountingStorage`（只数四种操作、
 * 内部是一个裸 Map），而 Tier-1 那组用例要的是 `tests/helpers/counting-storage.ts`
 * 那一份：它带 `inner`（能绕过 repo 直接读写存储，模拟运维的裸存储删除）与
 * `putFails`（能让一次落盘真的抛错）。两份都留着，只是这里换个名字避免遮蔽。
 */
import { CountingStorage as SharedCountingStorage } from "../helpers/counting-storage.js";

/** 四种操作全数上——只数其中几种的计数桩，关于漏掉那几种的断言就是假的。 */
class CountingStorage implements Storage {
  lists = 0; gets = 0; puts = 0; deletes = 0;
  readonly m = new Map<string, string>();
  async get<T>(k: string): Promise<T | null> { this.gets++; const r = this.m.get(k); return r === undefined ? null : (JSON.parse(r) as T); }
  async put<T>(k: string, v: T): Promise<void> { this.puts++; this.m.set(k, JSON.stringify(v)); }
  async delete(k: string): Promise<void> { this.deletes++; this.m.delete(k); }
  async list(p: string): Promise<string[]> { this.lists++; return [...this.m.keys()].filter((k) => k.startsWith(p)); }
  reset() { this.lists = 0; this.gets = 0; this.puts = 0; this.deletes = 0; }
}

/** 递进假时钟。**绝不用冻结时钟**——TTL 类测试在冻结时钟下变异后是挂起而不是失败。 */
function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance(ms: number) { t += ms; } };
}

const TTL = 60_000;
const TOUCH = 21_600_000;

async function setup(n: number, opts: { cacheTtlMs?: number; touchIntervalMs?: number } = {}) {
  const c = clock();
  const s = new CountingStorage();
  const repo = new KeyPoolRepo(s, {
    now: c.now, logger: NULL_LOGGER,
    cacheTtlMs: opts.cacheTtlMs ?? TTL,
    touchIntervalMs: opts.touchIntervalMs ?? TOUCH,
  });
  for (let i = 0; i < n; i++) await repo.add(`sk-pool-key-${i}-aaaaaaaaaa`);
  s.reset();
  return { c, s, repo };
}

/**
 * 造一条**已经用过**的 key：`lastUsedAt` 已经作为具体数字落了盘。
 *
 * 这一步绝不能省。`lastUsedAt` 还是 `null` 时 `shouldElide` 里的差值是
 * `Infinity`（首次使用）或 `NaN`（两边都是 null），两种情况**都返回 false**，
 * 于是「写消除的判据里那几个字段」根本没机会被求值——把 `schedulingEqual`
 * 整个删掉，下面那几条「变化必须落盘」的用例照样全绿。
 *
 * 这正是 Task 3 记下的第五类假阳性：**测试覆盖的状态让被测的那个选择变得不可观测。**
 * 先落一次盘把 `lastUsedAt` 变成真数字，之后 `schedulingEqual` 才是唯一的决定者。
 */
async function used(repo: KeyPoolRepo, s: CountingStorage, at = 1_000_000): Promise<KeyRecord> {
  const r0 = (await repo.all())[0]!;
  await repo.save({ ...r0, lastUsedAt: at }, r0);
  const r = (await repo.all()).find((x) => x.id === r0.id)!;
  // 断言前置条件真的成立——不成立的话下面所有断言都在测一个空判据。
  expect(r.lastUsedAt, "前置条件：lastUsedAt 必须已经是具体数字").toBe(at);
  s.reset();
  return r;
}

describe("isolate 级快照缓存", () => {
  it("TTL 内的第二次 all() 零存储访问——「读取次数与请求数解耦」这条结论的全部依据", async () => {
    const { s, repo, c } = await setup(20);
    await repo.all();
    expect(s.gets).toBe(21);
    s.reset();

    c.advance(TTL - 1);
    await repo.all();
    await repo.all();
    await repo.all();
    expect(s.gets, "TTL 内一次都不该读").toBe(0);
    expect(s.lists).toBe(0);
  });

  it("TTL 到期后重新读一遍", async () => {
    const { s, repo, c } = await setup(20);
    await repo.all();
    s.reset();
    c.advance(TTL);
    await repo.all();
    expect(s.gets).toBe(21);
  });

  /**
   * **命中与未命中必须返回可区分的值。**
   *
   * 上面两条只数存储访问次数。缓存类测试最典型的假阳性是：底层数据自始至终没变过，
   * 于是「读缓存」与「真读存储」返回的东西一模一样，谁赢都通过。这条把底层改掉，
   * 让两条路径的**返回值**真的分得开。
   */
  it("命中缓存读到旧值、过期后读到新值——这两个值必须不一样", async () => {
    const { s, repo, c } = await setup(1);
    const r = (await repo.all())[0]!;
    expect(r.cooldownReason).toBeNull();

    // 绕过 repo 直接改存储，模拟「另一个 isolate 判定了冷却」。
    s.m.set(KEY_PREFIX + r.id, JSON.stringify({ ...r, cooldownReason: "rate limited" }));

    c.advance(TTL - 1);
    expect((await repo.all())[0]!.cooldownReason, "TTL 内：仍是旧值").toBeNull();
    c.advance(1);
    expect((await repo.all())[0]!.cooldownReason, "TTL 到期：读到新值").toBe("rate limited");
  });

  it("all() 返回浅拷贝——dispatch 会就地改 records[at]，交出缓存数组等于让请求中间状态污染缓存", async () => {
    const { repo } = await setup(3);
    const a = await repo.all();
    const poisoned = { ...a[0]!, strikes: 999 };
    a[0] = poisoned;
    const b = await repo.all();
    expect(b[0]!.strikes, "第二次读到的不该被上一次的就地赋值污染").toBe(0);
  });

  it("save() 写穿透：同一 isolate 内下一次 all() 立刻看到 strike，不必等 TTL", async () => {
    const { repo } = await setup(3);
    const before = await repo.all();
    const target = before[0]!;
    await repo.save({ ...target, strikes: 2 }, target);
    const after = await repo.all();
    expect(after.find((r) => r.id === target.id)!.strikes).toBe(2);
  });

  /**
   * ⚠️ **这条守的是「同一个实例」的语义，不是「补池铸出来的 key 下一个请求就能用」。**
   *
   * 后者在生产接线上不成立：补池用的是 `buildTendDeps` 另建的 repo（`wire.ts:143`），
   * 与 app 的那个（`wire.ts:91`）是两个实例，而 `Refreshable` 是实例私有状态。
   * 这条用例在同一个实例上 add 再 all，因此对「生产是两个实例」这件事**完全不可观测**
   * ——正是第 5 类假阳性。它今天真实的用途是钉住 P3c 的前提：面板跟转发路径共用
   * `BuiltApp.repo`，写完 key 不失效就等于「加了 key，一分钟内没反应」。
   * 补池那条路径的真实上界（≤ 一个 POOL_CACHE_TTL_MS）写在 wire.ts 与 REGISTRAR.md。
   */
  it("add() / delete() 立刻失效**本实例**的缓存——同一个 repo 上下一次 all() 就看得到", async () => {
    const { repo } = await setup(2);
    expect(await repo.all()).toHaveLength(2);
    const added = await repo.add("sk-brand-new-key-aaaaaaaa");
    expect((await repo.all()).map((r) => r.id)).toContain(added.id);
    await repo.delete(added.id);
    expect((await repo.all()).map((r) => r.id)).not.toContain(added.id);
  });

  it("cacheTtlMs=0 完全关掉缓存——这是用户的逃生口，必须真的每次都读", async () => {
    const { s, repo } = await setup(5, { cacheTtlMs: 0 });
    await repo.all();
    await repo.all();
    expect(s.gets).toBe(12); // (1 索引 + 5 记录) × 2
  });

  it("存储读失败时抛出真实异常，保持 P1「存储读失败 → JSON 500」的既有行为", async () => {
    const c = clock();
    const broken: Storage = {
      async get(): Promise<never> { throw new Error("磁盘挂了：/app/data/store.json"); },
      async put(): Promise<never> { throw new Error("磁盘挂了"); },
      async delete(): Promise<never> { throw new Error("磁盘挂了"); },
      async list(): Promise<never> { throw new Error("磁盘挂了：/app/data/store.json"); },
    };
    const repo = new KeyPoolRepo(broken, { now: c.now, logger: NULL_LOGGER, cacheTtlMs: TTL });
    await expect(repo.all()).rejects.toThrow(/磁盘挂了/);
  });

  it("读失败但已有旧快照时，沿用旧快照而不是把请求打挂", async () => {
    const { repo, c, s } = await setup(3);
    await repo.all();
    const realGet = s.get.bind(s);
    // stub 必须真的 throw，不是返回 null——返回 null 测的是「读到空」，是另一回事。
    (s as unknown as { get: Storage["get"] }).get = async () => { throw new Error("KV 挂了"); };
    c.advance(TTL);
    expect(await repo.all(), "沿用上一份快照").toHaveLength(3);
    (s as unknown as { get: Storage["get"] }).get = realGet;
  });

  /**
   * 空结果兜底（Task 3 的「权威空索引 + 手工导入」那条防线）必须活在缓存背后。
   * 缓存把 all() 的实现从「原样调用旧逻辑」改成了「装载器」，最容易在这一步
   * 被换成计划里那段只有索引 + 记录读的精简版 loadAll()，而那等于把整条防线删掉。
   */
  it("缓存不吃掉「权威空索引 + 手工导入」那条兜底——它照样能看见手工写进去的 key", async () => {
    const { repo, s } = await setup(0);
    await repo.reconcileIndex();          // 空池写下权威空索引
    const manual: KeyRecord = {
      id: "0123456789abcdef", key: "sk-manual-import-aaaa", addedAt: 1, lastUsedAt: null,
      cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
    };
    s.m.set(KEY_PREFIX + manual.id, JSON.stringify(manual));
    s.reset();
    expect((await repo.all()).map((r) => r.id)).toEqual([manual.id]);
    expect(s.lists, "空结果时回落一次 list").toBe(1);
  });
});

describe("写消除：只有 lastUsedAt 变化时不落盘", () => {
  it("成功转发只改 lastUsedAt ⇒ 不写存储", async () => {
    const { repo, s } = await setup(3);
    const r = await used(repo, s);
    // applySuccess 在 strikes 已经是 0、cooldownReason 已经是 null 时，唯一的差异就是 lastUsedAt。
    await repo.save({ ...r, strikes: 0, cooldownReason: null, lastUsedAt: r.lastUsedAt! + 1000 }, r);
    expect(s.puts, "纯遥测字段的变化不值一次 KV 写").toBe(0);
  });

  it("strikes 变化 ⇒ 一定落盘（调度语义变了，丢了就等于坏 key 被无限重试）", async () => {
    const { repo, s } = await setup(3);
    const r = await used(repo, s);
    await repo.save({ ...r, strikes: 1 }, r);
    expect(s.puts).toBe(1);
  });

  /**
   * 每个字段的变异值。`Record<keyof KeyRecord, …>` ⇒ 新增字段时 tsc 逼着这里也表态。
   */
  const MUTATION: Record<keyof KeyRecord, Partial<KeyRecord>> = {
    id: { id: "fedcba9876543210" },
    key: { key: "sk-a-completely-different-key" },
    cooldownUntil: { cooldownUntil: 9999 },
    strikes: { strikes: 7 },
    evicted: { evicted: true },
    cooldownReason: { cooldownReason: "rate limited" },
    evictedReason: { evictedReason: "401" },
    addedAt: { addedAt: 424_242 },
    lastUsedAt: { lastUsedAt: 1_000_001 },
    stats: { stats: { requests: 1, success: 1, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null } },
  };

  /**
   * ── 两张**写死**的清单 ──────────────────────────────────────────────────
   *
   * **绝不从 `FIELD_ROLE` 推导。** 上一版这条用例写的是
   *     `expect(s.puts).toBe(role === "scheduling" ? 1 : 0)`
   * ——期望值来自被测的那张表本身，改表则期望跟着改，**同义反复**。评审实测：把
   * `evicted` / `evictedReason` / `cooldownUntil` / `cooldownReason` 任一标成
   * `"telemetry"`，618 条全绿、零变红。而那正是本任务定义的头号失败形态：
   * 401 剔除、429 冷却既不落盘也不进缓存 ⇒ 坏 key 被无限重试，测试却什么都不说。
   *
   * 「加字段时 tsc 报错」那个类型钉子只逼人**表态**，不保证**表对**。表对与否
   * 只能由这两张与实现无关的清单来断言。
   */
  const MUST_PERSIST: Array<keyof KeyRecord> = [
    "id", "key", "cooldownUntil", "cooldownReason", "strikes", "evicted", "evictedReason",
  ];
  /**
   * ⚠️ `stats` 在这张表里的含义与另外两个**不同**：它的那次写同样被消除（下面那条
   * 数 put 次数的断言仍然成立），但**计数不会跟着丢**——它被攒进 `pendingStats`，
   * 在下一次本来就要发生的写上一起带下去。「攒起来」这半由
   * 「Tier-1 计数不许被写消除吃掉」那一组守着，这里只守「不为它单独付一次 KV 写」。
   */
  const MAY_ELIDE: Array<keyof KeyRecord> = ["addedAt", "lastUsedAt", "stats"];

  it("穷尽性：KeyRecord 的每个字段都被上面两张写死的清单认领了", () => {
    // 新增字段时：tsc 先在 FIELD_ROLE 与 MUTATION 报错，这条再逼着把它放进某张清单，
    // 放进去之后下面两条立刻开始断言它的**真实行为**。三步缺一不可。
    expect([...MUST_PERSIST, ...MAY_ELIDE].sort()).toEqual(Object.keys(FIELD_ROLE).sort());
  });

  it("MUST_PERSIST 的每个字段变化都落盘——丢一个就是坏 key 被无限重试", async () => {
    for (const field of MUST_PERSIST) {
      const { repo, s } = await setup(1);
      const r = await used(repo, s);
      await repo.save({ ...r, ...MUTATION[field] }, r);
      expect(s.puts, `${field} 变了却没落盘`).toBe(1);
    }
  });

  it("MAY_ELIDE 的每个字段变化都被消除——这才是写消除的全部收益", async () => {
    for (const field of MAY_ELIDE) {
      const { repo, s } = await setup(1);
      const r = await used(repo, s);
      await repo.save({ ...r, ...MUTATION[field] }, r);
      expect(s.puts, `${field} 是纯遥测，不值一次 KV 写`).toBe(0);
    }
  });

  /**
   * `id` 变了就一定落盘。
   *
   * 变异实测的教训：拿「另一把真 key」当 prev 是**测不出这条**的——id 是 key 的
   * 哈希，两条真记录的 `key` 必然也不同，而 `key` 本身就是 scheduling 字段，
   * 于是把 `id` 判成 telemetry 也照样落盘，断言变成同义反复。只有让两份**除了
   * `id` 之外完全一样**，`FIELD_ROLE.id` 才是唯一的决定者。
   *
   * 守的是什么：`save()` 写的是 `key:<next.id>`。这一次被消除掉，调用方以为
   * 写成功了，而那个键从头到尾没被创建过。
   */
  it("只有 id 不同的两份之间不许消除——写的是一个全新的键，丢了就是凭空消失", async () => {
    const { repo, s } = await setup(1);
    const r = await used(repo, s, 5000);
    await repo.save({ ...r, id: "fedcba9876543210", lastUsedAt: 5001 }, r);
    expect(s.puts).toBe(1);
  });

  it("距上次落盘超过 touchInterval 时，lastUsedAt 也要落盘一次（面板的「最后使用」不能永远不动）", async () => {
    const { repo, s } = await setup(1);
    const r1 = await used(repo, s, 1000);

    await repo.save({ ...r1, lastUsedAt: 1000 + TOUCH - 1 }, r1);
    expect(s.puts, "未到间隔：不写").toBe(0);
    await repo.save({ ...r1, lastUsedAt: 1000 + TOUCH }, r1);
    expect(s.puts, "到了间隔：写一次").toBe(1);
  });

  it("首次使用（lastUsedAt 从 null 变成数字）一定落盘——否则面板永远显示「从未使用」", async () => {
    const { repo, s } = await setup(1);
    const r = (await repo.all())[0]!;
    expect(r.lastUsedAt).toBeNull();
    s.reset();
    await repo.save({ ...r, lastUsedAt: 5000 }, r);
    expect(s.puts).toBe(1);
  });

  it("被消除的那次更新**缓存也不动**——缓存里那份必须始终等于存储里那份", async () => {
    const { repo, s } = await setup(1);
    const r1 = await used(repo, s, 1000);
    await repo.save({ ...r1, lastUsedAt: 1001 }, r1);        // 被消除
    const r2 = (await repo.all())[0]!;
    // 缓存若跟着更新成 1001，「距上次落盘多久」的判据就会以内存值为准，
    // lastUsedAt 从此**再也不会落盘**——一个永远追不上间隔的滑动窗口。
    expect(r2.lastUsedAt).toBe(1000);
  });

  it("时钟回拨（lastUsedAt 变小）时老实落盘，不当成「没变化」", async () => {
    const { repo, s } = await setup(1);
    const r1 = await used(repo, s, 100_000);
    await repo.save({ ...r1, lastUsedAt: 50_000 }, r1);
    expect(s.puts).toBe(1);
  });

  it("不传 prev 时一定落盘——写消除是可选优化，缺少对照就必须保守", async () => {
    const { repo, s } = await setup(1);
    const r = await used(repo, s, 1000);
    await repo.save({ ...r, lastUsedAt: 1001 });
    expect(s.puts).toBe(1);
  });

  it("touchIntervalMs=0 完全关掉写消除", async () => {
    const { repo, s } = await setup(1, { touchIntervalMs: 0 });
    const r = await used(repo, s, 1000);
    await repo.save({ ...r, lastUsedAt: 1001 }, r);
    expect(s.puts).toBe(1);
  });
});

/**
 * **写消除的全部合法性只建立在一条前提上：`lastUsedAt` 不参与调度。**
 *
 * 这条前提一旦不成立（最现实的走向：将来有人拿 `lastUsedAt` 做 LRU 选 key），
 * 写消除会**静默失效**——被吃掉的不再只是遥测，而是选 key 的依据，而所有既有
 * 测试照样全绿。这个项目已经四次栽在「注释里说处理过了」上，所以这里不靠注释：
 * 一条行为断言（调度函数对 lastUsedAt 完全不敏感）加一条源码扫描（热路径里
 * 没有任何地方**读**它），两条独立的钉子。
 */
describe("前提：lastUsedAt 不参与调度（写消除的合法性全靠它）", () => {
  const NOW = 10_000;
  function rec(id: string, lastUsedAt: number | null): KeyRecord {
    return {
      id, key: `sk-${id}`, addedAt: 0, lastUsedAt,
      cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
    };
  }

  it("selectKey / isAvailable / poolHealth 对 lastUsedAt 完全不敏感", () => {
    const base = [rec("a", null), rec("b", null), rec("c", null)];
    // 刻意让「最久未使用」的顺序与轮询顺序**不一致**：b 最旧、c 次之、a 最新。
    // 一致的话 LRU 与轮询会选出同一把 key，这条断言就变成了不可观测的同义反复
    //（Task 3 记下的第五类假阳性）。
    const withLru = [rec("a", 9_000), rec("b", 1), rec("c", 500)];

    for (let cursor = 0; cursor < base.length * 2; cursor++) {
      expect(
        selectKey(withLru, cursor, NOW)?.record.id,
        `cursor=${cursor}：选 key 若开始读 lastUsedAt（例如改成 LRU），写消除必须同时废掉`,
      ).toBe(selectKey(base, cursor, NOW)?.record.id);
    }
    expect(poolHealth(withLru, NOW)).toEqual(poolHealth(base, NOW));
    base.forEach((r, i) => expect(isAvailable(withLru[i]!, NOW)).toBe(isAvailable(r, NOW)));
  });

  /**
   * 行为断言只覆盖 `keypool.ts` 里那三个函数；`dispatcher.ts` 完全可以自己就地
   * 挑一把「最久没用的」而不经过 `selectKey`。源码扫描补的正是这个缺口。
   *
   * **判据是「写」而不是「不读」**：把 `lastUsedAt` 当成标识符找出来，凡是没有紧跟
   * `:`（对象字面量的键 / 类型声明）的一律算读。上一版扫的是 `/\.lastUsedAt\b/`，
   * 评审实测能绕过——`r["lastUsedAt"]` 与解构 `const { lastUsedAt } = r` 都不带点，
   * 于是「dispatcher 自己按 LRU 排序」这个**唯一让这条扫描存在的场景**用中括号写
   * 就完整逃逸。列举读法永远列不全，只能反过来列举唯一合法的写法。
   *
   * 先去掉注释再扫：不去的话注释里提一句 `lastUsedAt` 就误报（Task 1 数错 console
   * 数量正是这个原因）。行注释的正则要求 `//` 前面不是冒号，免得把 `https://…`
   * 之后的半行代码一起吃掉。
   */
  /**
   * **手写的读点豁免清单。** 每一条都要能一句话说清「它读了，但调度仍然不依赖它」：
   *
   * - `keypool-repo.ts`：写消除自己的判据（`shouldElide`）。
   * - `admin/key-view.ts`：面板投影，把它原样搬进 `KeyView.lastUsedAt` 供展示。
   *   它**只被管理读路径调用**（`src/http/admin/handlers/keys.ts`），返回值进的是
   *   HTTP 响应体，不回流到 `selectKey` / `apply*`；下面那条依赖关系断言钉着这一点。
   *
   * 清单变长 = 有人在 core 里多了一处读 `lastUsedAt` 的地方，**必须在评审里表态**。
   */
  const LAST_USED_AT_READERS = [
    join("src/core", "keypool-repo.ts"),
    join("src/core", "admin", "key-view.ts"),
  ];

  it("src/core 里除手写清单上那几个文件外，`lastUsedAt` 只许被写、不许被读", () => {
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });

    const offenders: string[] = [];
    for (const p of walk("src/core")) {
      if (LAST_USED_AT_READERS.includes(p)) continue;
      const src = stripComments(readFileSync(p, "utf8"));
      // 允许 `lastUsedAt:` 与 `lastUsedAt?:`（写入 / 类型声明），其余一律算读。
      for (const m of src.matchAll(/\blastUsedAt\b(.?.?)/g)) {
        if (!/^\s*\??:/.test(m[1] ?? "")) offenders.push(`${p} → …${m[0]}`);
      }
    }
    expect(
      offenders,
      "有人开始读 lastUsedAt 了。它一旦参与调度，KeyPoolRepo 的写消除就会静默吃掉调度状态，"
      + "必须同时把 FIELD_ROLE 里的 lastUsedAt 改成 scheduling（或整个废掉写消除）",
    ).toEqual([]);
  });

  /**
   * 上面给 `admin/key-view.ts` 开的那条豁免，理由是「它只服务管理读路径」。
   * **这句话必须是一条会变红的断言，不是一句注释**——哪天有人从 `dispatcher.ts` /
   * `keypool.ts` 里 import 它（比如顺手拿 `KeyView.lastUsedAt` 排个序），
   * 那条豁免的前提就没了，这里立刻变红。
   */
  it("key-view.ts 只服务管理读路径：src/core 里 admin/ 之外没有任何模块 import 它", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    const importers = walk("src/core")
      .filter((p) => !p.startsWith(join("src/core", "admin")))
      .filter((p) => /from\s+"[^"]*key-view\.js"/.test(readFileSync(p, "utf8")));
    expect(importers, "调度侧开始依赖面板投影模块了，lastUsedAt 的读点豁免不再成立").toEqual([]);
  });
});

describe("两个旋钮的默认值", () => {
  // 这两个数字直接印在 .env.example 与五语言 DEPLOY.md 的环境变量表里，
  // 也是「免费档能撑多少请求/天」那笔账的输入。改了默认值而文档不改就是在骗人。
  it("默认 TTL 60 秒、默认触达间隔 6 小时", () => {
    expect(DEFAULT_POOL_CACHE_TTL_MS).toBe(60_000);
    expect(DEFAULT_POOL_TOUCH_INTERVAL_MS).toBe(21_600_000);
  });

  it("不传两个旋钮时，行为真的落在这两个默认值上（而不只是常量长这样）", async () => {
    const c = clock();
    const s = new CountingStorage();
    const repo = new KeyPoolRepo(s, { now: c.now, logger: NULL_LOGGER });
    await repo.add("sk-default-knobs-aaaaaa");

    await repo.all();
    s.reset();
    c.advance(DEFAULT_POOL_CACHE_TTL_MS - 1);
    await repo.all();
    expect(s.gets, "默认 TTL 内不读").toBe(0);
    c.advance(1);
    await repo.all();
    expect(s.gets, "默认 TTL 到期就读").toBe(2);

    const r = await used(repo, s, 1000);
    await repo.save({ ...r, lastUsedAt: 1000 + DEFAULT_POOL_TOUCH_INTERVAL_MS - 1 }, r);
    expect(s.puts, "默认间隔内不写").toBe(0);
    await repo.save({ ...r, lastUsedAt: 1000 + DEFAULT_POOL_TOUCH_INTERVAL_MS }, r);
    expect(s.puts, "到了默认间隔写一次").toBe(1);
  });
});

/**
 * **写消除会把 Tier-1 的计数整个吃掉——这是实测出来的，不是推理。**
 *
 * 默认 POOL_TOUCH_INTERVAL_MS=21600000（6 小时）+ POOL_CACHE_TTL_MS=60000 下，
 * 50 次成功转发**只落盘 1 次**（第 1 次因为 prev.lastUsedAt === null、差值是
 * Infinity 而必定落盘），此后每一次都读到快照里的 1、算出 2、然后被消除，
 * 快照也不推进（save 提前 return，不走 replaceInSnapshot）。
 * ⇒ 不做增量累加的话 `stats.requests` **永远停在 1**，那不是「少计」，
 * 是这个功能读出来的数字基本上永远是 1。设计文档 §6.1「几乎是免费的」那段推论
 * 写在写消除落地之前，已被本计划订正（F1）。
 */
describe("Tier-1 计数不许被写消除吃掉", () => {
  /**
   * 造一条 `lastUsedAt` 已经是具体数字、且已经落过盘的记录。
   *
   * ⚠️ **这一步不能省，省了整组用例就是假阳性。** `lastUsedAt` 两边都是 `null` 时
   * `shouldElide` 里的差值是 `NaN`，判据恒为 false ⇒ **每一次 save 都会落盘**，
   * 于是「攒起来」「攒太久强制落盘」这些被测的选择在那个状态下**根本不可观测**
   * （本项目登记的第 5 种假阳性）。与本文件上面那个 `used()` 是同一条纪律。
   */
  /**
   * 重新导入同一把 key，再触发一次**真落盘**，返回落盘后的 `stats`。
   *
   * ⚠️ **观测点必须在这次真落盘之后，不能只看 `add()` 刚写下的那份。**
   * 变异实测（M24）：`add()` 走的是 `prev === undefined` 那条路径，它原样写 `next`、
   * 压根不合并增量，所以「删完直接重新导入」这一步**看不出**旧账有没有被清。
   * 真正的还魂发生在**下一次真落盘**——那时 `trackBaseline` 会拿旧 `base` 与新记录的
   * 零计数取大，把旧计数重新写回去。三条删除路径的用例因此都收在这里。
   */
  async function reimportAndFlush(
    repo: KeyPoolRepo, st: SharedCountingStorage, key: string, at: number,
  ) {
    const again = await repo.add(key);
    const fresh = (await repo.all()).find((x) => x.id === again.id)!;
    const next = withOutcome(
      applyStrike(fresh, at, { maxStrikes: 99, cooldownStrikeMs: 1 }, "probe"), "failed", at, "probe",
    );
    await repo.save(next, fresh);
    return (await st.inner.get<KeyRecord>(KEY_PREFIX + again.id))?.stats;
  }

  /** 重新导入之后**唯一**该看到的东西：只有那次探针失败，一条旧账都没有。手写字面量。 */
  const CLEAN_AFTER_REIMPORT = (at: number) => ({
    requests: 1, success: 0, failed: 1, clientErrors: 0, lastErrorAt: at, lastErrorKind: "probe",
  });

  /**
   * **别的实例**把这条记录重建了——直接写存储，**绕过本实例的 `add()`**——
   * 本实例随后读到它并落一次盘，返回落盘后的 `stats`。
   *
   * 这个形态是 `stillExists` / `delete()` 两条清账路径**唯一**的可观测通道：
   * 经过本实例 `add()` 的那条已经被 `prev === undefined` 那一行无条件兜住了
   * （变异实测：只去掉 `stillExists` 或 `delete()` 里的清账，走 add() 的用例照样绿）。
   * 而这条路在生产里是实打实的：Worker 上补池与转发是两个 repo 实例，
   * 一个实例删掉/另一个重建，本实例只是过一个 TTL 之后重新读到它。
   */
  async function outOfBandRebuildAndFlush(
    repo: KeyPoolRepo, st: SharedCountingStorage, rec: KeyRecord, at: number,
  ) {
    await st.inner.put(KEY_PREFIX + rec.id, rec);   // rec 是 add() 刚返回的那份：零计数
    const seen = (await repo.all()).find((x) => x.id === rec.id)!;
    expect(seen.stats, "前置条件：重建出来的那份必须是干净的").toBeUndefined();
    const next = withOutcome(
      applyStrike(seen, at, { maxStrikes: 99, cooldownStrikeMs: 1 }, "probe"), "failed", at, "probe",
    );
    await repo.save(next, seen);
    return (await st.inner.get<KeyRecord>(KEY_PREFIX + rec.id))?.stats;
  }

  async function primed(repo: KeyPoolRepo, st: SharedCountingStorage, id: string, at: number) {
    const r0 = (await repo.all()).find((x) => x.id === id)!;
    await repo.save({ ...r0, lastUsedAt: at }, r0);
    const r = (await repo.all()).find((x) => x.id === id)!;
    expect(r.lastUsedAt, "前置条件：写消除的判据必须真的生效").toBe(at);
    return { rec: r, putsBefore: st.puts };
  }

  it("50 次成功之后落盘的 requests 是 50，而不是 1", async () => {
    const st = new SharedCountingStorage();
    let t = 1000;
    const repo = new KeyPoolRepo(st, {
      now: () => t, logger: NULL_LOGGER,
      cacheTtlMs: 60_000, touchIntervalMs: 21_600_000,
    });
    const rec = await repo.add("sk-tier1-elision-aaaaaaaa");
    const putsAfterAdd = st.puts;

    let cur = (await repo.all())[0]!;
    for (let i = 0; i < 50; i++) {
      t += 100;
      const next = withOutcome(applySuccess(cur, t), "success", t, null);
      await repo.save(next, cur);
      cur = (await repo.all()).find((x) => x.id === rec.id)!;
    }
    // 触发一次真落盘（调度字段变化），把攒着的增量带下去。
    t += 100;
    const strick = withOutcome(applyStrike(cur, t, { maxStrikes: 99, cooldownStrikeMs: 1 }, "x"), "failed", t, "x");
    await repo.save(strick, cur);

    const stored = await st.inner.get<KeyRecord>("key:" + rec.id);
    // 51 = 50 次成功 + 1 次失败。手写字面量。
    expect(stored?.stats?.requests, "写消除把计数吃掉了").toBe(51);
    expect(stored?.stats?.success).toBe(50);
    expect(stored?.stats?.failed).toBe(1);
    // **写配额一次不增**：50 次成功只应产生 1 次落盘（第一次），加上最后那次状态变更。
    expect(st.puts - putsAfterAdd, "增量累加器把写放大重新引入了").toBe(2);
  });

  it("只有 4xx 直通（不改调度字段、不动 lastUsedAt）时，攒够一个触达间隔也会落盘", async () => {
    // 防的是累加器自己的一个死角：4xx 直通既不改调度字段也不改 lastUsedAt，
    // `n - p === 0 < touchIntervalMs` 恒成立 ⇒ 不加「攒太久就强制落盘」这条，
    // 一个只被打 4xx 的 key 的计数**永远不会落盘**。
    const st = new SharedCountingStorage();
    let t = 1000;
    // 触达间隔取 20 秒、每次 4xx 间隔 5 秒：10 次跨 50 秒 ⇒ 第 5 次与第 10 次各
    // 强制落盘一次。（计划给的 100_000 在 10 次里一次都攒不满，那条断言测不到东西。）
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 20_000 });
    const rec = await repo.add("sk-tier1-passthrough-bbbb");
    let { rec: cur, putsBefore } = await primed(repo, st, rec.id, t);

    for (let i = 0; i < 10; i++) {
      t += 5_000;
      const next = withOutcome(cur, "clientError", t, null);
      await repo.save(next, cur);
      cur = (await repo.all()).find((x) => x.id === rec.id)!;
    }
    const stored = await st.inner.get<KeyRecord>("key:" + rec.id);
    expect(stored?.stats?.clientErrors, "只被打 4xx 的 key 计数永远落不了盘").toBe(10);
    // 手写字面量：兜底把「永远不落盘」改成「每个触达间隔一次」，**不是每次都写**。
    expect(st.puts - putsBefore, "强制落盘退化成了每次都写，写消除的收益没了").toBe(2);
  });

  it("记录被删掉时攒着的增量一并丢弃，不许把删掉的 key 用增量复活", async () => {
    const st = new SharedCountingStorage();
    let t = 1000;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 21_600_000 });
    const KEY = "sk-tier1-deleted-cccccccc";
    const rec = await repo.add(KEY);
    const { rec: cur, putsBefore } = await primed(repo, st, rec.id, t);

    t += 100;
    await repo.save(withOutcome(applySuccess(cur, t), "success", t, null), cur);   // 被消除，攒起来
    expect(st.puts - putsBefore, "前置条件：这一次必须真的被消除").toBe(0);

    // 运维吊销一把泄漏的 key 的姿势就是裸存储删除（`wrangler kv key delete` /
    // 直接改 store.json），它绕过 `delete()`，所以清增量不能只挂在 delete() 上。
    await st.inner.delete(KEY_PREFIX + rec.id);

    // 一次调度字段变化本该落盘 ⇒ 走到 stillExists 那道闸上被拦下。
    t += 100;
    const strick = withOutcome(applyStrike(cur, t, { maxStrikes: 99, cooldownStrikeMs: 1 }, "x"), "failed", t, "x");
    await repo.save(strick, cur);
    expect(await st.inner.get(KEY_PREFIX + rec.id), "删掉的记录被增量写回复活了").toBe(null);

    // 攒着的那笔增量必须**一并丢掉**：重新导入同一把 key 之后计数得是干净的，
    // 否则一把被吊销的 key 的用量会跟着新记录一起还魂。
    t += 100;
    expect(
      await reimportAndFlush(repo, st, KEY, t),
      "删除时没清掉的增量，被合并进了重新导入的那条记录",
    ).toEqual(CLEAN_AFTER_REIMPORT(t));
  });

  /**
   * **已经落盘的累计计数，绝不许被同一次请求里的第二次提交往回退。**（评审 C2）
   *
   * 要害在 `prev` 的来源：`dispatch` 的 `commit()` 落盘之后写回 `records[at] = updated`
   * ——那是**未合并的 next**，比存储里刚写下的那份**旧**。所以这条用例刻意
   * **不重读 `repo.all()`**，而是把上一次交给 `save()` 的那份原样当成下一次的 `prev`，
   * 复刻 dispatcher 的视图推进方式。
   *
   * 本文件其它用例每次 save 之后都重读快照，于是「基线取调用方视图」与「基线自己记账」
   * 两种实现在那些状态下**数学上等价**（第 5 种假阳性）——它们结构上不可能抓到这条。
   *
   * 可达性不是假想：池里 ≥2 把 key 而只剩 1 把可用时，`selectKey` 会在同一次 dispatch
   * 内反复选中它（`attempts = records.length`，cursor 绕回同一槽），而「只剩一把可用」
   * 恰恰是剔除/冷却之后的常态；`applyStrike` 每次都改调度字段 ⇒ 每次都真落盘。
   */
  it("同一次请求里同一把 key 连提交两次时，先前攒着的计数不许被第二次写抹掉", async () => {
    const st = new SharedCountingStorage();
    let t = 1000;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 21_600_000 });
    const cfg = { maxStrikes: 99, cooldownStrikeMs: 1 };
    const rec = await repo.add("sk-tier1-twocommits-ffffff");
    const { rec: cur, putsBefore } = await primed(repo, st, rec.id, t);

    // 20 次成功被消除，攒在 pending 里（第 21 次成功是 primed 之外的那一次，见下）。
    for (let i = 0; i < 20; i++) {
      t += 100;
      await repo.save(withOutcome(applySuccess(cur, t), "success", t, null), cur);
    }
    expect(st.puts - putsBefore, "前置条件：这 20 次必须真的被消除").toBe(0);

    // 同一次请求内：第一次 500 ⇒ 真落盘，把 20 次成功一起带下去。
    let inReq = (await repo.all()).find((x) => x.id === rec.id)!;
    t += 100;
    const s1 = withOutcome(applyStrike(inReq, t, cfg, "upstream 500"), "failed", t, "upstream 500");
    await repo.save(s1, inReq);
    const afterFirst = await st.inner.get<KeyRecord>(KEY_PREFIX + rec.id);
    expect(afterFirst?.stats?.success, "前置条件：第一次落盘要把攒着的 20 次带下去").toBe(20);

    // **不重读**：dispatcher 就是这么推进 records[at] 的。
    inReq = s1;
    t += 100;
    const s2 = withOutcome(applyStrike(inReq, t, cfg, "upstream 500"), "failed", t, "upstream 500");
    await repo.save(s2, inReq);

    const stored = await st.inner.get<KeyRecord>(KEY_PREFIX + rec.id);
    // 手写字面量：20 次成功一次都不许少，两次失败都要在，requests = 22。
    expect(stored?.stats?.success, "第二次写把已经落盘的 20 次成功抹掉了").toBe(20);
    expect(stored?.stats?.failed).toBe(2);
    expect(stored?.stats?.requests).toBe(22);
  });

  it("裸存储删除之后**没有任何后续 save**、直接重新导入，旧计数也不许还魂", async () => {
    // 与下面那条「走 delete()」、以及上面那条「被 stillExists 拦下」是**三条不同的路径**：
    // 这一条既不经过 delete()、也不经过 stillExists（压根没有下一次 save），
    // 唯一的闸是 `save()` 里 `prev === undefined` 那半。
    const st = new SharedCountingStorage();
    let t = 1000;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 21_600_000 });
    const KEY = "sk-tier1-rawdelete-gggggg";
    const rec = await repo.add(KEY);
    const { rec: cur, putsBefore } = await primed(repo, st, rec.id, t);

    t += 100;
    await repo.save(withOutcome(applySuccess(cur, t), "success", t, null), cur);   // 被消除，攒起来
    expect(st.puts - putsBefore, "前置条件：这一次必须真的被消除").toBe(0);

    await st.inner.delete(KEY_PREFIX + rec.id);   // 裸存储删除，之后一次 save 都没有

    t += 100;
    expect(
      await reimportAndFlush(repo, st, KEY, t),
      "被吊销那把 key 的用量跟着重新导入的记录还魂了",
    ).toEqual(CLEAN_AFTER_REIMPORT(t));
  });

  it("走 delete() 删除时同样丢弃攒着的增量（两条删除路径都要清）", async () => {
    // 上一条走的是**裸存储删除**（被 stillExists 拦下）。`delete()` 这条路径压根
    // 不经过 stillExists，各清各的；变异实测：只去掉 delete() 里那一行，
    // 上一条照样绿——所以这一条不能省。
    const st = new SharedCountingStorage();
    let t = 1000;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 21_600_000 });
    const KEY = "sk-tier1-repodelete-eeeeee";
    const rec = await repo.add(KEY);
    const { rec: cur, putsBefore } = await primed(repo, st, rec.id, t);

    t += 100;
    await repo.save(withOutcome(applySuccess(cur, t), "success", t, null), cur);   // 被消除，攒起来
    expect(st.puts - putsBefore, "前置条件：这一次必须真的被消除").toBe(0);

    await repo.delete(rec.id);

    t += 100;
    expect(
      await reimportAndFlush(repo, st, KEY, t),
      "delete() 没清掉增量，它跟着重新导入的那条记录还魂了",
    ).toEqual(CLEAN_AFTER_REIMPORT(t));
  });

  it("被 stillExists 拦下时清掉的旧账，在记录被别的实例重建之后也不许回来", async () => {
    const st = new SharedCountingStorage();
    let t = 1000;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 21_600_000 });
    const rec = await repo.add("sk-tier1-stillexists-hhhhh");
    const { rec: cur } = await primed(repo, st, rec.id, t);

    t += 100;
    await repo.save(withOutcome(applySuccess(cur, t), "success", t, null), cur);   // 被消除，攒起来
    await st.inner.delete(KEY_PREFIX + rec.id);                                     // 裸存储删除
    t += 100;
    const strick = withOutcome(applyStrike(cur, t, { maxStrikes: 99, cooldownStrikeMs: 1 }, "x"), "failed", t, "x");
    await repo.save(strick, cur);   // ⇒ stillExists 为假，这一步必须把旧账丢掉

    t += 100;
    expect(
      await outOfBandRebuildAndFlush(repo, st, rec, t),
      "stillExists 那道闸没清旧账，记录被重建之后它从基线里回来了",
    ).toEqual(CLEAN_AFTER_REIMPORT(t));
  });

  it("走 delete() 清掉的旧账，在记录被别的实例重建之后也不许回来", async () => {
    const st = new SharedCountingStorage();
    let t = 1000;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 21_600_000 });
    const rec = await repo.add("sk-tier1-repodelete2-iiiii");
    const { rec: cur } = await primed(repo, st, rec.id, t);

    t += 100;
    await repo.save(withOutcome(applySuccess(cur, t), "success", t, null), cur);   // 被消除，攒起来
    await repo.delete(rec.id);

    t += 100;
    expect(
      await outOfBandRebuildAndFlush(repo, st, rec, t),
      "delete() 没清旧账，记录被重建之后它从基线里回来了",
    ).toEqual(CLEAN_AFTER_REIMPORT(t));
  });

  it("落盘抛错时攒着的增量必须留着，下一次成功的写要把它一起带下去", async () => {
    // 变异表里「把 pendingStats.delete 挪到 put 之前」原本没有任何用例守着，这条补上。
    const st = new SharedCountingStorage();
    let t = 1000;
    const repo = new KeyPoolRepo(st, { now: () => t, logger: NULL_LOGGER, cacheTtlMs: 60_000, touchIntervalMs: 21_600_000 });
    const rec = await repo.add("sk-tier1-putfails-dddddddd");
    const { rec: cur, putsBefore } = await primed(repo, st, rec.id, t);

    for (let i = 0; i < 3; i++) {
      t += 100;
      await repo.save(withOutcome(applySuccess(cur, t), "success", t, null), cur);
    }
    expect(st.puts - putsBefore, "前置条件：这三次必须真的被消除").toBe(0);

    // 一次调度字段变化本该落盘，但存储把写打回来了（写配额耗尽 / KV 抖动）。
    st.putFails = true;
    t += 100;
    const strike1 = withOutcome(applyStrike(cur, t, { maxStrikes: 99, cooldownStrikeMs: 1 }, "x"), "failed", t, "x");
    await expect(repo.save(strike1, cur)).rejects.toThrow(/write quota/);

    // 再来一次，这次写得进去。
    st.putFails = false;
    t += 100;
    const strike2 = withOutcome(applyStrike(cur, t, { maxStrikes: 99, cooldownStrikeMs: 1 }, "y"), "failed", t, "y");
    await repo.save(strike2, cur);

    const stored = await st.inner.get<KeyRecord>(KEY_PREFIX + rec.id);
    // 手写字面量：3 次被消除的成功 + 这一次失败。第一次抛错的那次失败确实丢了
    //（整条记录都没写进去），这与 dispatcher 对「记账失败」的既有处置一致。
    expect(stored?.stats?.success, "put 抛错时把增量清掉了，那三次成功再也回不来").toBe(3);
    expect(stored?.stats?.requests).toBe(4);
    expect(stored?.stats?.failed).toBe(1);
  });
});

describe("reconcileIndex() 修完索引之后自己失效快照", () => {
  it("刚被对账捡回来的孤儿记录，下一次 all() 就看得见，不必等一个 TTL", async () => {
    const { repo, s } = await setup(1);
    await repo.all();                       // 装载快照
    const orphan: KeyRecord = {
      id: "0123456789abcdef", key: "sk-orphan-orphan-orph", addedAt: 1, lastUsedAt: null,
      cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
    };
    s.m.set(KEY_PREFIX + orphan.id, JSON.stringify(orphan));   // 绕过 repo，制造孤儿
    expect((await repo.all()).map((r) => r.id), "对账之前看不见（fail-safe）")
      .not.toContain(orphan.id);

    expect((await repo.reconcileIndex()).added).toEqual([orphan.id]);
    // 时钟一动不动：看得见就只能是因为对账失效了快照。
    expect((await repo.all()).map((r) => r.id)).toContain(orphan.id);
  });
});
