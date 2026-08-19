import { describe, it, expect } from "vitest";
import { dispatch } from "../../src/core/dispatcher.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { TEST_CONFIG } from "../helpers/make-app.js";
import type { Storage } from "../../src/ports/storage.js";
import type { Fetcher } from "../../src/ports/fetcher.js";

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
