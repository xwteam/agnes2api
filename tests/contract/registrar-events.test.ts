import { describe, it, expect, vi } from "vitest";
import workerEntry from "../../src/entry/worker.js";
import type { Env } from "../../src/entry/worker.js";
import { TEND_HISTORY_KEY, type TendRecord } from "../../src/core/admin/tend-history.js";
import { WORKER_ROUND_BUDGET_MS } from "../../src/core/registrar/types.js";
import { KvStorage } from "../../src/adapters/storage-kv.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

/**
 * 防住的真实故障：`registrar.*` 事件产出了、却没落库，于是事件板块里一条补池事件
 * 都没有 —— 这正是阶段验收「看到最近的补池发生了什么」实测为零的成因
 * （账本 progress.md:1041-1046）。
 *
 * 观测形态照抄 `tests/unit/registrar/scheduling-wiring.test.ts` 的「function fakeCtx()」：
 * ⚠️ 这里**刻意用名字锚而不是行号**——第一版写的是 `:171`（计划里给的那个数），
 * 而本任务给 `TendResult` 加三个字段时那份夹具长了 3 行，行号当场就腐烂了，
 * `scripts/check-comment-refs.mjs` 这道门禁直接把它拦下。行号会漂，名字不会。
 * 把 `waitUntil` 收到的 promise 收进数组、用例自己 await 完再断言存储。
 * **不依赖 pool-workers 会不会替我们等**，两种运行时同一份判据。
 *
 * ⚠️ 存储替身必须带延迟——零延迟下「有没有等写完」整个不可观测（第 8 种候选形态，
 * 本仓在 storage 轴上栽过一次，见 `tests/helpers/fake-storage.ts` 的说明）。
 *
 * ⚠️ **这里不 mock `tendOnce`，跑的是真的那一个**（第 7 种假阳性：测的是抄件不是
 * 原件）。夹具挑的是 `registrar.round_budget_impossible` 这条路径：
 * `CODE_TIMEOUT_MS` 调到比 `WORKER_ROUND_BUDGET_MS` 还大 ⇒ `tendOnce` 判定
 * 「单次最坏耗时装不下本轮预算」，**一次尝试都不开始**就打一条 error 事件并返回。
 * 于是这一轮**零网络、毫秒级返回**——而"毫秒级返回的那一轮"恰恰是本任务实测出
 * 会被最小间隔闸整轮吃掉的那一种，用它当夹具是有意的。
 */

interface KvCounts { get: number; put: number; delete: number; list: number }

/**
 * KV 形状的替身，**每次访问都真的经过一次 `setTimeout`**。
 * 不带延迟的话，`await flush()` 与 fire-and-forget 的 `flush()` 在纯内存实现上
 * 找不出行为差异——两条路径都在同一个微任务 tick 内追上调用方。
 */
function delayedKv(
  store: Map<string, string>,
  counts: KvCounts = { get: 0, put: 0, delete: 0, list: 0 },
  delayMs = 5,
): Env["POOL"] {
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    async get(key: string) {
      counts.get++; await wait();
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    async put(key: string, value: string) {
      counts.put++; await wait();
      store.set(key, value);
    },
    async delete(key: string) {
      counts.delete++; await wait();
      store.delete(key);
    },
    async list({ prefix }: { prefix?: string } = {}) {
      counts.list++; await wait();
      const keys = [...store.keys()]
        .filter((k) => prefix === undefined || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as Env["POOL"];
}

function env(store: Map<string, string>, counts?: KvCounts, extra: Record<string, unknown> = {}): Env {
  return {
    GATEWAY_TOKEN: "t",
    POOL: delayedKv(store, counts),
    REGISTRAR_ENABLED: "true",
    REGISTRAR_PRIMARY: "yyds",
    YYDS_API_KEY: "k",
    TARGET_KEYS: "1",
    // 比 WORKER_ROUND_BUDGET_MS（780_000）大 ⇒ 一次尝试都开不了，零网络。
    CODE_TIMEOUT_MS: String(WORKER_ROUND_BUDGET_MS + 1),
    ...extra,
  } as unknown as Env;
}

function controller(): ScheduledController {
  return { scheduledTime: Date.now(), cron: "*/30 * * * *" } as ScheduledController;
}

/** 照抄 `tests/unit/registrar/scheduling-wiring.test.ts` 的「function fakeCtx()」的形态。 */
function fakeCtx(): { ctx: ExecutionContext; waited: Array<Promise<unknown>> } {
  const waited: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { waited.push(p); },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, waited };
}

/**
 * 跑一轮 Cron，并把 `ctx.waitUntil` 收到的 promise 全部 await 完。
 * `hooks` 用来在替身存储的某个操作上注入故障（`tendOnce` 抛错、`delete` 抛错）。
 */
async function runRound(
  store: Map<string, string>,
  counts?: KvCounts,
  extra: Record<string, unknown> = {},
  hooks: { failDelete?: boolean } = {},
) {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const { ctx, waited } = fakeCtx();
    const e = env(store, counts, extra);
    if (hooks.failDelete) {
      const kv = e.POOL as unknown as { delete: (k: string) => Promise<void> };
      kv.delete = async () => { throw new Error("delete 配额用光了"); };
    }
    await workerEntry.scheduled!(controller(), e, ctx);
    await Promise.all(waited);
    return { waited };
  } finally {
    errSpy.mockRestore(); warnSpy.mockRestore(); logSpy.mockRestore();
  }
}

/** 存储里所有 `event:` 分片里的全部条目。 */
function storedEvents(store: Map<string, string>): Array<{ ts: number; level: string; event: string }> {
  return [...store.entries()]
    .filter(([k]) => k.startsWith("event:"))
    .map(([, v]) => JSON.parse(v) as unknown)
    // 有的用例会**预置一个非数组的畸形分片值**，那一把如果没被这一轮写过就原样
    // 留着；这里只统计真正被落盘写成数组的那些。
    .filter((v): v is Array<{ ts: number; level: string; event: string }> => Array.isArray(v))
    .flat();
}

function storedHistory(store: Map<string, string>): TendRecord[] {
  const raw = store.get(TEND_HISTORY_KEY);
  return raw === undefined ? [] : (JSON.parse(raw) as TendRecord[]);
}

describe("注册机事件落库（两种运行时各跑一遍）", () => {
  /**
   * **本任务的核心断言。**
   * 变红条件（M6）：`buildTendDeps` 的 logger 退回裸 `ConsoleLogger`。
   * 变红条件（M7）：入口层 `finally` 里删掉 `await deps.flush()`。
   */
  it("一轮补池之后，event: 键空间里确实有 registrar.* 事件", async () => {
    const store = new Map<string, string>();
    await runRound(store);
    const events = storedEvents(store);
    expect(events.length, "一条补池事件都没有落库").toBeGreaterThan(0);
    expect(
      events.map((e) => e.event),
      "落库的必须是补池那条路产出的事件本身，不是别的什么",
    ).toContain("registrar.round_budget_impossible");
  });

  /**
   * **`waitUntil` 的 promise 落定的那一刻，落盘必须已经完成**（不是"最终会完成"）。
   * 替身带 5ms 真实延迟，所以 `await flush()` 与 fire-and-forget 在**这一刻**
   * 才有可观测的差异——不带延迟的替身两种写法都会绿（第 8 种候选形态）。
   */
  it("waitUntil 的 promise 落定时事件已经落盘，不是之后某个时刻（真实异步延迟下可观测）", async () => {
    const store = new Map<string, string>();
    const { waited } = await runRound(store);
    expect(waited.length, "补池确实经由 ctx.waitUntil 跑").toBe(1);
    // runRound 已经 await 完 waited，**不额外等待**：紧接着就查。
    expect(storedEvents(store).length).toBeGreaterThan(0);
  });

  /**
   * **`registrar.enabled=false` 时一次都不写。** 这是配额账里那根轴
   * （「一切都以 `registrar.enabled` 为轴分两栏」）在代码里的对应物：
   * 默认部署下本任务新增的写是 **0**，不是"少几次"。
   */
  it("注册机关着时：一条事件、一条历史都不写（默认部署的新增写是 0）", async () => {
    const store = new Map<string, string>();
    const counts: KvCounts = { get: 0, put: 0, delete: 0, list: 0 };
    await runRound(store, counts, { REGISTRAR_ENABLED: undefined, REGISTRAR_PRIMARY: undefined });
    expect(storedEvents(store), "注册机关着却写了事件").toEqual([]);
    expect(store.has(TEND_HISTORY_KEY), "注册机关着却写了补池历史").toBe(false);
  });

  /**
   * **`tend:history`：每轮汇总。**
   * 「只看到一串流水」不等于「看到最近的补池发生了什么」——运维真正要问的是
   * 每轮的 available / attempted / minted 各是多少，那正是这份历史存在的理由
   * （设计 §7.3，兑现 design §11 的承诺）。
   */
  it("一轮补池之后，tend:history 里多了一条带 trigger=cron 的记录", async () => {
    const store = new Map<string, string>();
    await runRound(store);
    const history = storedHistory(store);
    expect(history.length).toBe(1);
    expect(history[0]!.trigger).toBe("cron");
    expect(history[0]!.skipped).toBe(false);
    expect(history[0]!.primaryChannel).toBe("yyds");
    // 预算连一次尝试都装不下 ⇒ 一次都没开始 ⇒ 三个数都是 0，failures 也是空的。
    // **这正是那条 error 事件存在的全部理由**：光看这份历史看不出哪里不对。
    expect(history[0]!.attempted).toBe(0);
    expect(history[0]!.minted).toBe(0);
    expect(history[0]!.failures).toEqual([]);
    expect(Number.isFinite(history[0]!.at), "at 必须是可排序的有限数").toBe(true);
    expect(Number.isFinite(history[0]!.durationMs)).toBe(true);
  });

  it("连跑三轮：tend:history 是追加的，不是每轮覆盖成一条", async () => {
    const store = new Map<string, string>();
    await runRound(store);
    await runRound(store);
    await runRound(store);
    expect(storedHistory(store).length).toBe(3);
  });

  /**
   * **存储里混进一条 `null`，下一轮照样能写进去，且那条坏的被清掉。**
   * `tend:history` 是本期新增的第二个「从存储读回来直接喂给面板」的结构；
   * 不做窄化就是在同一天里再制造一次那条畸形条目缺陷。
   * 变红条件（M9 的可测等价形态）：`narrowTendHistory` 整个去掉 ⇒ 这一轮的
   * `appendTendHistory` 会把那条 `null` 原样留在数组里。
   *
   * ⚠️ **诚实登记**：计划 M9 写的变红条件是「`/admin/api/registrar/status` 不许
   * 500」，而那个端点是事件板块的产物、**今天还不存在**（`adminRouter` 今天只有
   * 6 条路由，全是 GET）。这一格是它在本任务里能落地的最强形态：同一条不变量，
   * 观测点从"读端点"换成"下一轮的写"。
   */
  it("tend:history 里混进一条 null：下一轮照常追加，那条 null 不会被原样留下", async () => {
    const store = new Map<string, string>();
    store.set(TEND_HISTORY_KEY, JSON.stringify([null]));
    await runRound(store);
    const history = storedHistory(store);
    expect(history.length).toBe(1);
    expect(history[0], "那条 null 必须已经被丢掉").not.toBeNull();
    expect(history[0]!.trigger).toBe("cron");
  });

  /**
   * **事件分片里混进一条畸形值，补池那一轮的写不受影响。**
   * 这是写侧窄化（Step 3）在真实入口上的对照：修复前分片里是字符串时
   * `appendRing` 的 `[...cur]` 会把它**逐字符展开**成 N 条畸形条目原样写回，
   * `errs=0`、`dropped=0`、不抛不报。
   * 变红条件（M2 的一半）：写侧 `narrowShard` 退回 `?? []`。
   */
  it("事件分片里预置一个字符串：落回存储的数组里不许出现非对象元素", async () => {
    const store = new Map<string, string>();
    // 覆盖所有候选分片键里的一把——补池那个 isolate 的槽位是随机的，
    // 两个槽位都摆上，保证它一定撞上。
    const w = Math.floor(Date.now() / 3_600_000);
    store.set(`event:${w}:0`, JSON.stringify("abc"));
    store.set(`event:${w}:1`, JSON.stringify("abc"));
    await runRound(store);

    // 补池那个 isolate 的槽位是随机的，只会写两把里的一把；**另一把原样留着
    // 我们预置的字符串**（它没被落盘碰过），所以判据只看"被写过的那一把"。
    // 变异实测：写侧退回 `?? []` 时，被写的那把会变成 `["a","b","c",{…}]`
    // ——仍然是数组，于是照样进到下面的逐元素断言里被抓住。
    const written = [...store.entries()]
      .filter(([k]) => k.startsWith("event:"))
      .map(([k, v]) => [k, JSON.parse(v) as unknown] as const)
      .filter(([, v]) => Array.isArray(v));
    expect(written.length, "补池那一轮一把分片都没写").toBeGreaterThan(0);
    for (const [k, arr] of written) {
      for (const e of arr as unknown[]) {
        expect(typeof e, `${k} 里出现了非对象元素（字符串被逐字符展开了？）`).toBe("object");
        expect(e).not.toBeNull();
      }
    }
    expect(storedEvents(store).map((e) => e.event)).toContain("registrar.round_budget_impossible");
  });

  /**
   * **`status().dropped` 恒为有限数。** 修复前分片里是**字符串以外的标量或对象**
   * 时 `[...cur]` 抛 `TypeError`，而 `truncatedCount(cur.length, …)` 在抛错之前
   * 就跑了、`cur.length` 是 `undefined` ⇒ `persistedDropped` 变成 `NaN` 并对
   * 那个 isolate **终生粘住** ⇒ `NaN > 0` 是 false ⇒ 黄条永远不亮；
   * `c.json` 又把 `NaN` 序列化成 `null` ⇒ 面板读到"没有数据"。
   * 变红条件（M2 的另一半）：写侧 `narrowShard` 退回 `?? []`。
   *
   * 这里的观测点是**落盘本身有没有成功**：`NaN` 那条链的上游就是那次 `TypeError`，
   * 而 `TypeError` 发生在 `this.buffer = []` 之后 ⇒ 那一批事件永久丢失。
   */
  it("事件分片里预置一个数字：这一轮的事件照样落得进去（不是缓冲先清、异常后发）", async () => {
    const store = new Map<string, string>();
    const w = Math.floor(Date.now() / 3_600_000);
    store.set(`event:${w}:0`, JSON.stringify(12345));
    store.set(`event:${w}:1`, JSON.stringify(12345));
    await runRound(store);
    expect(
      storedEvents(store).map((e) => e.event),
      "这一批事件被静默吞掉了 —— 缓冲先清空、异常才发生",
    ).toContain("registrar.round_budget_impossible");
  });

  /**
   * **整轮抛错的那一轮，事件与历史都必须有。**
   *
   * 防住的真实故障（评审实测）：`tendOnce` 一抛，`recordRound` 整个被跳过
   *（它排在 `try` 里、在 `tendOnce` 之后），而 `catch` 里原来是**裸
   * `console.error`**、进不了事件缓冲 ⇒ `flush()` 首行就 return。实测结果是
   * `{"events": [], "history": null, "allKeys": ["pool:index"]}`——
   * **面板上这一轮什么都没有，与「注册机根本没跑」逐字节不可区分**，
   * 正是本文件开篇引的那条「实测为零」的同一形态。
   *
   * 变红条件：`catch` 里退回裸 `console.error`（两件事任删其一都红）。
   *
   * 造抛错的办法：把 `pool:index` 写成一个会让 `repo.all()` 炸掉的值——
   * 走的是**真**入口、**真** `tendOnce`，不 mock。
   */
  it("整轮抛错时：event: 里有 registrar.round_failed，tend:history 里有一条 round_crashed", async () => {
    const store = new Map<string, string>();
    // `reconcileIndex` 那一步会先把索引修好，所以要在它之后才生效的地方下手：
    // 让 KV 的 get 对 `key:` 前缀抛错 —— `tendOnce` 第一件事就是 `repo.all()`。
    const counts: KvCounts = { get: 0, put: 0, delete: 0, list: 0 };
    const e = env(store, counts);
    // `tendOnce` 第一件事是 `repo.all()`。`buildTendDeps` 建 repo 时
    // `cacheTtlMs: 0` ⇒ 直接走 `loadAll()`：读 `pool:index`，读不出来时**回落到
    // `list("key:")`**。两条路都堵上，`all()` 才会真的把异常抛出来。
    const kv = e.POOL as unknown as {
      get: (k: string) => Promise<unknown>; list: (o: unknown) => Promise<unknown>;
    };
    const origGet = kv.get.bind(kv);
    kv.get = async (k: string) => {
      if (k === "pool:index") throw new Error("存储在补池中途炸了");
      return origGet(k);
    };
    kv.list = async () => { throw new Error("list 配额也用光了"); };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { ctx, waited } = fakeCtx();
      await workerEntry.scheduled!(controller(), e, ctx);
      await Promise.all(waited);
    } finally {
      errSpy.mockRestore(); warnSpy.mockRestore(); logSpy.mockRestore();
    }

    expect(
      storedEvents(store).map((ev) => ev.event),
      "抛错那一轮一条事件都没落库 —— 与「注册机根本没跑」不可区分",
    ).toContain("registrar.round_failed");

    const history = storedHistory(store);
    expect(history.length, "抛错那一轮在补池历史上没有占一格").toBe(1);
    expect(history[0]!.failures.map((f) => f.reason)).toEqual(["round_crashed"]);
    expect(history[0]!.minted).toBe(0);
    expect(history[0]!.attempted).toBe(0);
    expect(
      history[0]!.skipped,
      "`skipped` 有且只有一个含义（注册机关着），拿它表示「崩了」就是伪造",
    ).toBe(false);
  });

  /**
   * **释放补池锁失败这件事，必须进事件板块。**
   *
   * 它意味着下一次 Cron 要空等到锁自然过期（最长 15 分钟）才肯干活——正是运维
   * 要在事件板块里看到的那类事。原来它走裸 `console.warn`，根本进不了缓冲。
   *
   * **这一格同时是 `finally` 里 flush 排在最后的唯一守卫**：这条事件在释放锁
   * **之后**才产生，flush 排在前面就永远赶不上它。
   * 变红条件：① `lock_release_failed` 退回裸 `console.warn`；② 把 `await deps.flush()`
   * 挪到释放锁之前。
   */
  it("释放补池锁失败时，那条事件仍然落得了盘（flush 排在释放锁之后）", async () => {
    const store = new Map<string, string>();
    await runRound(store, undefined, {}, { failDelete: true });
    expect(
      storedEvents(store).map((ev) => ev.event),
      "释放锁失败只打了 console.warn，或者 flush 排在了释放锁之前",
    ).toContain("registrar.lock_release_failed");
  });

  /**
   * **`tend:history` 里被丢掉的畸形行必须留痕。**
   *
   * 这里是 `tend:history` **唯一的窄化点**——事件那一侧读路径每次都会独立报出
   * `malformed`，而这份历史今天只有写侧一个人看得见它。丢掉它意味着**被外部
   * 写坏的那几行在下一次补池时被永久抹掉，无事件、无 warn、无计数**，
   * 等读端点建好时证据早就没了。
   * 变红条件：`appendHistory` 里那段 `narrowed.malformed > 0` 的上报被删掉。
   */
  it("tend:history 里有畸形行：丢掉它们的同时留下一条带计数的 warn 事件", async () => {
    const store = new Map<string, string>();
    store.set(TEND_HISTORY_KEY, JSON.stringify([null, { at: "坏的" }, { at: 1, trigger: "cron" }]));
    await runRound(store);
    const ev = storedEvents(store).find((x) => x.event === "registrar.history_malformed");
    expect(ev, "三条读不得的记录被静默销毁了，一点痕迹都没有").toBeDefined();
    expect((ev as unknown as { fields: { malformed: number } }).fields.malformed).toBe(3);
    expect(storedHistory(store).length, "这一轮自己那条照常写进去").toBe(1);
  });
});

/**
 * **「每轮都健康时事件 sink 是 0」——五语言 DEPLOY.md 配额账里那一栏，做成用例。**
 *
 * ⚠️ **评审发现：第一版把这句话写成无条件的，而它是有前提的。**
 * 真正决定要不要 put 的是**这一轮的事件缓冲空不空**，不是「事件是不是
 * `registrar.` 前缀」。而 `loadConfig` 有一条**逐轮都会打**的 warn：
 * `TEND_INTERVAL_MS < MINT_BATCH × CODE_TIMEOUT_MS × 通道数`
 *（`src/core/registrar/config.ts` 的 `interval_shorter_than_worst_round`，
 * 默认 `5 × 120000 × 1 = 600000` ⇒ **任何低于 10 分钟的 `TEND_INTERVAL_MS` 都让
 * 健康的一轮也写一次**）。这不是等量放大而是跳档：`TEND_INTERVAL_MS=300000`
 * 全天 `80+96+288+288+288 = 1040`，**打穿 1,000**。
 *
 * 两格并排放，因为**单独看任何一格都会把那句话读成无条件的**。
 */
describe("健康的一轮写几次（配额账那一栏的前提）", () => {
  /** 先往池子里塞一把 key，让 `need = targetKeys - available <= 0`（真·健康轮）。 */
  async function seedHealthyPool(store: Map<string, string>) {
    const repo = new KeyPoolRepo(new KvStorage(delayedKv(store, undefined, 0)), {
      now: () => Date.now(), logger: NULL_LOGGER,
    });
    await repo.add("sk-seeded-key-for-healthy-round");
  }

  function eventPutCount(store: Map<string, string>) {
    return [...store.keys()].filter((k) => k.startsWith("event:")).length;
  }

  it("默认配置下：健康的一轮一次事件都不写（配额账那一栏成立）", async () => {
    const store = new Map<string, string>();
    await seedHealthyPool(store);
    // CODE_TIMEOUT_MS 用默认值 ⇒ 不触发 round_budget_impossible；
    // TEND_INTERVAL_MS 用默认 1800000 ⇒ 不触发 interval_shorter_than_worst_round。
    await runRound(store, undefined, { TARGET_KEYS: "1", CODE_TIMEOUT_MS: undefined });
    expect(storedEvents(store), "健康的一轮不该产出任何事件").toEqual([]);
    expect(eventPutCount(store), "健康的一轮不该写事件分片").toBe(0);
    expect(storedHistory(store).length, "但补池历史照写 —— 它是无条件的那一项").toBe(1);
    expect(storedHistory(store)[0]!.minted).toBe(0);
  });

  it("TEND_INTERVAL_MS 低于单轮最坏耗时：健康的一轮**也会**写一次（那句话的前提）", async () => {
    const store = new Map<string, string>();
    await seedHealthyPool(store);
    await runRound(store, undefined, {
      TARGET_KEYS: "1", CODE_TIMEOUT_MS: undefined, TEND_INTERVAL_MS: "300000",
    });
    expect(
      storedEvents(store).map((e) => e.event),
      "配置警告是逐轮打的，它一样会把缓冲填非空 ⇒ 一次 put",
    ).toContain("registrar.interval_shorter_than_worst_round");
    expect(eventPutCount(store), "「健康时是 0」在这个配置下不成立").toBeGreaterThan(0);
  });
});
