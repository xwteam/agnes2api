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

async function poolOf(n: number, now: () => number) {
  const s = new CountingStorage();
  const repo = new KeyPoolRepo(s, { now, logger: NULL_LOGGER });
  for (let i = 0; i < n; i++) await repo.add(`sk-pool-key-${i}-aaaaaaaaaa`);
  s.reset();
  return { s, repo };
}

describe("配额账（Task 3 结束时的中间态）", () => {
  it(`一次成功转发：list 0（原来 1）、get ${N + 1}、put 1`, async () => {
    const t = 1000;
    const { s, repo } = await poolOf(N, () => t);
    const res = await dispatch({
      path: "/chat/completions", body: { model: "m" }, stream: false,
      deps: { repo, fetcher: okFetcher, config: TEST_CONFIG, now: () => t },
    });
    expect(res.status).toBe(200);

    // 四个数字一起断言：
    //   list 0  —— 归零，这是本任务的全部收益（改造前实测为 1）。
    //   get  21 —— 1 次索引 + N 次记录。这是索引方案换来的成本，摆在明面上。
    //   put  1  —— **仍然是 1。** 免费档写配额也是 1,000/天，所以到这一步天花板
    //              一步都没抬——这正是订正 F6 说的那件事，也是 Task 4 存在的理由。
    //              这条断言故意留在这里，Task 4 会把它改成 0，届时改动本身就是收益的证据。
    //   delete 0 —— 转发路径不该删任何东西。
    expect(s.counts()).toEqual({ list: 0, get: N + 1, put: 1, delete: 0 });
  });

  it("池子越大，每请求的 get 越多——这是索引方案换来的成本，必须量出来而不是假装没有", async () => {
    const t = 1000;
    for (const n of [1, 5, 20]) {
      const { s, repo } = await poolOf(n, () => t);
      await dispatch({
        path: "/chat/completions", body: { model: "m" }, stream: false,
        deps: { repo, fetcher: okFetcher, config: TEST_CONFIG, now: () => t },
      });
      expect(s.counts(), `池大小 ${n}`).toEqual({ list: 0, get: n + 1, put: 1, delete: 0 });
    }
  });
});
