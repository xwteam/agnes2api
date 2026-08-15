import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as DispatcherModule from "../../src/core/dispatcher.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { FakeFetcher } from "../helpers/fake-fetcher.js";

// dispatcher.ts 按简报把游标设计为模块级变量，用于在不同请求之间维持轮询位置——
// 这在生产环境下是正确的（否则每次请求都会从第一把 key 开始，起不到轮询作用）。
// 但同一个测试文件里的多个 it() 共享同一份模块实例，会导致游标在用例之间串位。
// 因此这里改为每个用例前 vi.resetModules() 后动态重新 import，
// 让每个用例都拿到一份全新的模块（游标重新从 0 开始），
// 不改动 dispatcher.ts 本身的设计，只做测试隔离。
let dispatch: typeof DispatcherModule.dispatch;
let KeyPoolRepo: typeof DispatcherModule.KeyPoolRepo;

beforeEach(async () => {
  vi.resetModules();
  ({ dispatch, KeyPoolRepo } = await import("../../src/core/dispatcher.js"));
});

const CONFIG = {
  gatewayToken: "t",
  agnesBaseUrl: "https://upstream.test/v1",
  upstreamTimeoutMs: 8000,
  maxStrikes: 3,
  cooldownRateLimitMs: 60_000,
  cooldownPaymentMs: 3_600_000,
  logLevel: "info",
};

async function makeRepo(keys: string[]) {
  const s = new MemoryStorage();
  const repo = new KeyPoolRepo(s);
  for (const k of keys) await repo.add(k);
  return repo;
}

describe("dispatch", () => {
  it("首把 key 成功即返回，不再尝试其他 key", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 200, body: '{"ok":true}' }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1"]);
  });

  it("429 后换下一把 key，并把前一把置为冷却", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 429 }, { status: 200, body: "{}" }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    const k1 = (await repo.all()).find((r) => r.key === "k1")!;
    expect(k1.cooldownUntil).toBe(1000 + 60_000);
  });

  it("401 把该 key 永久剔除后换下一把", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 401 }, { status: 200, body: "{}" }]);
    await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    const k1 = (await repo.all()).find((r) => r.key === "k1")!;
    expect(k1.evicted).toBe(true);
  });

  it("非 401/403/429/402/5xx 的 4xx 直接透传，不换 key", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 400, body: '{"error":"bad request"}' }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(400);
    expect(f.usedKeys).toEqual(["k1"]);
  });

  it("池中无 key 时返回 503 且错误体说明是空池", async () => {
    const repo = await makeRepo([]);
    const f = new FakeFetcher([]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "pool_empty" } });
  });

  it("全部 key 冷却中时返回 503 且原因为 all_cooling", async () => {
    const repo = await makeRepo(["k1"]);
    const only = (await repo.all())[0]!;
    await repo.save({ ...only, cooldownUntil: 999_999 });
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: new FakeFetcher([]), config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "all_cooling" } });
  });

  it("所有 key 都失败时返回最后一次上游错误", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 500 }, { status: 502 }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(502);
  });

  it("成功后清零该 key 的 strikes", async () => {
    const repo = await makeRepo(["k1"]);
    const only = (await repo.all())[0]!;
    await repo.save({ ...only, strikes: 2 });
    await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: new FakeFetcher([{ status: 200, body: "{}" }]), config: CONFIG, now: () => 1000 },
    });
    expect((await repo.all())[0]!.strikes).toBe(0);
  });

  it("fetch 抛普通异常时记 strike 并换下一把 key 重试成功", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ throws: new Error("boom") }, { status: 200, body: "{}" }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: { ...CONFIG, maxStrikes: 1 }, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    const k1 = (await repo.all()).find((r) => r.key === "k1")!;
    expect(k1.strikes).toBe(1);
    expect(k1.evicted).toBe(true);
    expect(k1.evictedReason).toBe("network error");
  });

  it("fetch 抛 AbortError（超时）时同样记 strike 并换下一把", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const f = new FakeFetcher([{ throws: abortErr }, { status: 200, body: "{}" }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: { ...CONFIG, maxStrikes: 1 }, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    const k1 = (await repo.all()).find((r) => r.key === "k1")!;
    expect(k1.strikes).toBe(1);
    expect(k1.evicted).toBe(true);
    expect(k1.evictedReason).toBe("timeout");
  });

  it("所有 key 都抛错时返回 503（当前实现落到 all_cooling，因为 catch 分支不写 lastError）", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ throws: new Error("e1") }, { throws: new Error("e2") }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "all_cooling" } });
  });
});
