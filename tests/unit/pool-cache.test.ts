import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  KeyPoolRepo, FIELD_ROLE,
  DEFAULT_POOL_CACHE_TTL_MS, DEFAULT_POOL_TOUCH_INTERVAL_MS,
} from "../../src/core/keypool-repo.js";
import { KEY_PREFIX } from "../../src/core/pool-index.js";
import { selectKey, isAvailable, poolHealth } from "../../src/core/keypool.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import type { Storage } from "../../src/ports/storage.js";
import type { KeyRecord } from "../../src/core/types.js";

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
  const MAY_ELIDE: Array<keyof KeyRecord> = ["addedAt", "lastUsedAt"];

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
  it("src/core 里除 keypool-repo.ts 外，`lastUsedAt` 只许被写、不许被读", () => {
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });

    const offenders: string[] = [];
    for (const p of walk("src/core")) {
      // 唯一的合法读点：写消除自己的判据（shouldElide）。
      if (p === join("src/core", "keypool-repo.ts")) continue;
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
