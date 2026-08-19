import { describe, it, expect } from "vitest";
import { dispatch } from "../../src/core/dispatcher.js";
import { KeyPoolRepo, EMPTY_POOL_RESCAN_MS } from "../../src/core/keypool-repo.js";
import { KEY_PREFIX, POOL_INDEX_KEY } from "../../src/core/pool-index.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { TEST_CONFIG } from "../helpers/make-app.js";
import type { Storage } from "../../src/ports/storage.js";
import type { Fetcher } from "../../src/ports/fetcher.js";
import type { KeyRecord } from "../../src/core/types.js";

/**
 * 这个文件是 §配额账那张表的**可执行版本**。它存在的理由：那张表是本期最大的一条
 * 对外承诺（「Worker + 免费 KV 不再卡在约 1,000 次转发/天」），而承诺如果只写在
 * 文档里，第一次重构就会悄悄失效。
 */
const N = 20;
const TTL = 60_000;
const TOUCH = 21_600_000;

/** 四种操作全数上——只数其中几种的计数桩，关于漏掉那几种的断言就是假的。 */
class CountingStorage implements Storage {
  lists = 0; gets = 0; puts = 0; deletes = 0;
  private m = new Map<string, string>();
  async get<T>(k: string): Promise<T | null> { this.gets++; const r = this.m.get(k); return r === undefined ? null : (JSON.parse(r) as T); }
  async put<T>(k: string, v: T): Promise<void> { this.puts++; this.m.set(k, JSON.stringify(v)); }
  async delete(k: string): Promise<void> { this.deletes++; this.m.delete(k); }
  async list(p: string): Promise<string[]> { this.lists++; return [...this.m.keys()].filter((k) => k.startsWith(p)); }
  reset() { this.lists = 0; this.gets = 0; this.puts = 0; this.deletes = 0; }
  counts() { return { list: this.lists, get: this.gets, put: this.puts, delete: this.deletes }; }
}

const okFetcher: Fetcher = {
  async fetch() {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  },
};

/**
 * **配额账必须按生产默认值算**，所以这里显式打开缓存与写消除——而不是沿用
 * `TEST_CONFIG`（那份夹具刻意把两者都关了，见 make-app.ts 的说明）。
 * 用夹具的 0 来算这张表，量出来的就是另一个产品的账。
 */
async function poolOf(n: number, now: () => number) {
  const s = new CountingStorage();
  const repo = new KeyPoolRepo(s, {
    now, logger: NULL_LOGGER, cacheTtlMs: TTL, touchIntervalMs: TOUCH,
  });
  for (let i = 0; i < n; i++) await repo.add(`sk-pool-key-${i}-aaaaaaaaaa`);
  s.reset();
  return { s, repo };
}

/**
 * 把池子搬到**稳态**：每把 key 的 `lastUsedAt` 都已经是具体数字。
 *
 * 这一步不是为了让数字好看，是因为稳态和冷启动是**两笔不同的账**，混在一起算
 * 哪一笔都不对：`lastUsedAt` 从 null 变成数字那一次是必须落盘的（否则面板永远
 * 显示「从未使用」），所以一个刚建好的池子头 N 个请求每个都要写一次。那笔一次性
 * 成本由下面「冷池」那条用例单独量，这里量的是它之后的长期形态——决定「每天能打
 * 多少请求」的是后者。
 */
async function warm(repo: KeyPoolRepo, at: number): Promise<void> {
  for (const r of await repo.all()) await repo.save({ ...r, lastUsedAt: at }, r);
}

describe("配额账（改造后：list 与 put 都归零，get 与请求数解耦）", () => {
  it("冷池的头 N 个请求各写一次——这是「首次使用必须落盘」的一次性成本，量出来而不是藏起来", async () => {
    let t = 1000;
    const { s, repo } = await poolOf(3, () => t);
    for (let i = 0; i < 3; i++) {
      t += 100;
      await dispatch({
        path: "/chat/completions", body: { model: "m" }, stream: false,
        deps: { repo, fetcher: okFetcher, config: TEST_CONFIG, now: () => t },
      });
    }
    // 轮询保证三个请求打在三把不同的 key 上，每把各写一次 lastUsedAt。
    expect(s.puts, "每把 key 一生只付一次这个成本（之后每 6 小时一次）").toBe(3);
  });

  it(`稳态下一次成功转发：list 0、get ${N + 1}（本 isolate 的首次刷新）、put 0`, async () => {
    let t = 1000;
    const { s, repo } = await poolOf(N, () => t);
    await warm(repo, t);
    t += TTL;              // 快照过期，模拟一个刚冷启动的 isolate
    s.reset();

    const res = await dispatch({
      path: "/chat/completions", body: { model: "m" }, stream: false,
      deps: { repo, fetcher: okFetcher, config: TEST_CONFIG, now: () => t },
    });
    expect(res.status).toBe(200);

    // 四个数字一起断言：
    //   list 0  —— Task 3 用 pool:index 索引键归的零（改造前实测为 1）。
    //   get  21 —— 1 次索引 + N 次记录。**只有每个 TTL 的第一次**是这个数，
    //              TTL 内的后续请求是 0（下一条用例），所以它与请求数无关。
    //   put  0  —— 从 1 变成 0。这一次只改了 lastUsedAt，是纯遥测字段，
    //              不值一次 KV 写。天花板正是在这里从写配额（1,000/天）
    //              挪到读配额（100,000/天）的。
    //   delete 0 —— 转发路径不该删任何东西。
    expect(s.counts()).toEqual({ list: 0, get: N + 1, put: 0, delete: 0 });
  });

  it("TTL 内连打 50 个请求：总共只读一遍池子、一次都不写", async () => {
    let t = 1000;
    const { s, repo } = await poolOf(N, () => t);
    await warm(repo, t);
    t += TTL;
    s.reset();

    for (let i = 0; i < 50; i++) {
      t += 100;   // 时间在走，但 50×100ms 远没跨过 TTL
      await dispatch({
        path: "/chat/completions", body: { model: "m" }, stream: false,
        deps: { repo, fetcher: okFetcher, config: TEST_CONFIG, now: () => t },
      });
    }
    // 这一行就是「读写次数与请求数解耦」这句对外承诺的全部证据。
    expect(s.counts()).toEqual({ list: 0, get: N + 1, put: 0, delete: 0 });
  });

  it("跨过 TTL 才会再读一遍——读取次数由 TTL 决定，不由请求数决定", async () => {
    let t = 1000;
    const { s, repo } = await poolOf(N, () => t);
    await warm(repo, t);
    t += TTL;
    s.reset();

    const send = () => dispatch({
      path: "/chat/completions", body: { model: "m" }, stream: false,
      deps: { repo, fetcher: okFetcher, config: TEST_CONFIG, now: () => t },
    });
    await send();
    t += TTL;
    await send();
    await send();
    expect(s.counts(), "两轮刷新 = 2×(1+N) 次读，与打了三个请求无关")
      .toEqual({ list: 0, get: 2 * (N + 1), put: 0, delete: 0 });
  });

  /**
   * ── 端到端探针：调度状态真的到了存储里 ────────────────────────────────────
   *
   * 前面那些用例数的是 `put` **次数**，它们答不了「写进去的是不是对的东西」。
   * 这两条改为在 `dispatch` 跑完之后**直接从存储里把记录读回来**，断言冷却/剔除
   * 那几个字段确实落了盘。
   *
   * 存在的理由很具体：把 `FIELD_ROLE` 里 `cooldownUntil` / `cooldownReason` /
   * `evicted` / `evictedReason` 任一改成 `"telemetry"`，写消除就会把它整个吃掉
   * ——存储不写、缓存也不动 ⇒ 坏 key 被无限重试，而这是**静默**的。这两条探针
   * 与 pool-cache 的 MUST_PERSIST 清单是两条独立的钉子：那条量单次 save 的行为，
   * 这条量整条转发链路的终态。
   */
  it("429 冷却真的落到存储里（端到端探针，生产默认值）", async () => {
    let t = 1000;
    const { s, repo } = await poolOf(1, () => t);
    await warm(repo, t);
    t += TTL;
    const id = (await repo.all())[0]!.id;
    s.reset();

    const rateLimited: Fetcher = { async fetch() { return new Response("{}", { status: 429 }); } };
    await dispatch({
      path: "/chat/completions", body: { model: "m" }, stream: false,
      deps: { repo, fetcher: rateLimited, config: TEST_CONFIG, now: () => t },
    });

    const persisted = await s.get<KeyRecord>(`${KEY_PREFIX}${id}`);
    expect(persisted, "记录必须还在").not.toBeNull();
    expect(persisted!.cooldownUntil, "冷却截止时刻没落盘 ⇒ 限流中的 key 会被立刻重选")
      .toBeGreaterThan(t);
    expect(persisted!.cooldownReason).not.toBeNull();
  });

  it("401 剔除真的落到存储里（端到端探针，生产默认值）", async () => {
    let t = 1000;
    const { s, repo } = await poolOf(1, () => t);
    await warm(repo, t);
    t += TTL;
    const id = (await repo.all())[0]!.id;
    s.reset();

    const unauthorized: Fetcher = { async fetch() { return new Response("{}", { status: 401 }); } };
    await dispatch({
      path: "/chat/completions", body: { model: "m" }, stream: false,
      deps: { repo, fetcher: unauthorized, config: TEST_CONFIG, now: () => t },
    });

    const persisted = await s.get<KeyRecord>(`${KEY_PREFIX}${id}`);
    expect(persisted!.evicted, "剔除标记没落盘 ⇒ 凭据已失效的 key 会被无限重试")
      .toBe(true);
    expect(persisted!.evictedReason).not.toBeNull();
  });

  it("上游 5xx 时仍然会写——写消除只吃遥测，绝不吃调度状态", async () => {
    let t = 1000;
    const { s, repo } = await poolOf(3, () => t);
    await warm(repo, t);
    t += TTL;
    s.reset();

    const failing: Fetcher = { async fetch() { return new Response("boom", { status: 500 }); } };
    await dispatch({
      path: "/chat/completions", body: { model: "m" }, stream: false,
      deps: { repo, fetcher: failing, config: TEST_CONFIG, now: () => t },
    });
    // 三把 key 各记一次 strike，三次都必须落盘——丢了就等于坏 key 被无限重试。
    expect(s.puts).toBe(3);
  });

  it("池子越大，每次刷新的 get 越多——这是索引方案换来的成本，必须量出来而不是假装没有", async () => {
    for (const n of [1, 5, 20]) {
      let t = 1000;
      const { s, repo } = await poolOf(n, () => t);
      await warm(repo, t);
      t += TTL;
      s.reset();

      await dispatch({
        path: "/chat/completions", body: { model: "m" }, stream: false,
        deps: { repo, fetcher: okFetcher, config: TEST_CONFIG, now: () => t },
      });
      expect(s.counts(), `池大小 ${n}`).toEqual({ list: 0, get: n + 1, put: 0, delete: 0 });
    }
  });
});

/**
 * **空池态的 list 账。这是配额账里唯一一个会真的把桶烧穿的桶。**
 *
 * `list` 不吃读配额那 100,000，它是**独立的第四个桶**，免费档 1,000 次/天。
 * 池子为空（索引合法但一条活记录都没有）时 `loadAll()` 每次都会走 `rescanEmptyResult`
 * 的 list 兜底，快照缓存只把它压到「每个 TTL 一次」——默认 60 秒 TTL 下就是
 * 1,440 次/天/isolate，**本身就超配额**。而桶穿之后：list 抛错 ⇒ `Refreshable`
 * 吞掉只记一条 `pool.load_failed` ⇒ 沿用上一份 `[]` ⇒ 网关照报 503 `pool_empty`；
 * 与此同时被文档指定为唯一修复者的 `reconcileIndex()` 读同一个桶同样抛。
 * 于是「用户这才导入 key」的那一刻，两条自愈路径已经一起死了。
 *
 * 下面这组用例把这笔账钉成可执行的：**次数**由 EMPTY_POOL_RESCAN_MS 决定，
 * **失败**必须如实抛而不是退化成空池。
 */
describe("空池态的 list 配额", () => {
  const DAY = 86_400_000;

  /** 权威的空索引 + 零条 key 记录 = 全新部署 / 池子被清空之后的形态。 */
  async function emptyPool(now: () => number) {
    const s = new CountingStorage();
    await s.put(POOL_INDEX_KEY, { v: 1, ids: [] });
    const repo = new KeyPoolRepo(s, {
      now, logger: NULL_LOGGER, cacheTtlMs: TTL, touchIntervalMs: TOUCH,
    });
    s.reset();
    return { s, repo };
  }

  it(`空池连打一整天：list 次数由 ${EMPTY_POOL_RESCAN_MS / 60_000} 分钟的退避决定，不由 TTL 决定`, async () => {
    let t = 1000;
    const { s, repo } = await emptyPool(() => t);

    // 每个 TTL 打一次（快照缓存下这已经是最坏情况：更密的流量一次都不会多读）。
    for (let elapsed = 0; elapsed < DAY; elapsed += TTL) {
      expect(await repo.all()).toEqual([]);
      t += TTL;
    }

    // 退避前是 86400/60 = 1,440 次/天/isolate，远超免费档的 1,000。
    // 现在是 86400/600 = 144 次（窗口整除 TTL，所以每个窗口正好落一次）。
    expect(s.lists, "空池态的 list 次数").toBe(DAY / EMPTY_POOL_RESCAN_MS);
    expect(s.lists, "必须留在免费档 1,000 次/天的 list 配额之内").toBeLessThan(1000);
  });

  it("退避窗口内一次 list 都不许有——快照过期只是「该重新装载了」，不是「该重新 list」", async () => {
    let t = 1000;
    const { s, repo } = await emptyPool(() => t);

    await repo.all();
    expect(s.lists).toBe(1);

    // 中间跨过了 9 个快照 TTL：每一个都触发了一次真装载（readIndex 那次 get 照付），
    // 但一次 list 都不许有——这正是退避与快照 TTL 是**两条独立**闸门的证据。
    t += EMPTY_POOL_RESCAN_MS - TTL;
    await repo.all();
    expect(s.lists, "窗口内不许再 list").toBe(1);
    expect(s.gets, "窗口内该有的索引读一次都没少").toBeGreaterThan(0);

    t += TTL;
    await repo.all();
    expect(s.lists, "窗口过了的第一次装载才允许再 list 一次").toBe(2);
  });

  it("list 失败时 all() 抛真实异常，绝不退化成「池子是空的」——两条自愈路径都死了的时候必须看得见", async () => {
    let t = 1000;
    const { s, repo } = await emptyPool(() => t);
    const boom = new Error("KV list quota exceeded");
    s.list = async () => { throw boom; };

    // 冷启动就撞上（快照从未成功装载过）：异常必须一路浮到调用方 ⇒ 500 + 真实原因。
    await expect(repo.all()).rejects.toThrow("KV list quota exceeded");

    // 退避窗口内的后续请求同样抛，而不是拿一个静默的 [] 换成 503 pool_empty。
    t += TTL;
    await expect(repo.all()).rejects.toThrow("KV list quota exceeded");
  });

  it("配额恢复之后自愈：下一个退避窗口的 list 成功，手工导入的 key 就看得见了", async () => {
    let t = 1000;
    const { s, repo } = await emptyPool(() => t);
    const real = s.list.bind(s);
    s.list = async () => { throw new Error("KV list quota exceeded"); };
    await expect(repo.all()).rejects.toThrow();

    // 用户这时才按 DEPLOY.md 手工导入一把 key（不动 pool:index）。
    await s.put(KEY_PREFIX + "deadbeefdeadbeef", {
      id: "deadbeefdeadbeef", key: "sk-manual", addedAt: 1, lastUsedAt: null,
      cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
    } satisfies KeyRecord);

    s.list = real;
    t += EMPTY_POOL_RESCAN_MS;
    expect((await repo.all()).map((r) => r.id)).toEqual(["deadbeefdeadbeef"]);
  });

  it("空池 + 手工导入的可见延迟就是退避窗口——这是换来的代价，写进 DEPLOY.md 的就是这个数", async () => {
    let t = 1000;
    const { repo, s } = await emptyPool(() => t);
    await repo.all();   // 打上退避窗口

    await s.put(KEY_PREFIX + "abcdef0123456789", {
      id: "abcdef0123456789", key: "sk-manual-2", addedAt: 1, lastUsedAt: null,
      cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
    } satisfies KeyRecord);

    t += EMPTY_POOL_RESCAN_MS - TTL;
    expect(await repo.all(), "窗口内还看不见").toEqual([]);

    t += TTL;
    expect((await repo.all()).map((r) => r.id), "窗口一过就看得见").toEqual(["abcdef0123456789"]);
  });
});
