import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as DispatcherModule from "../../src/core/dispatcher.js";
import { configFromEnv } from "../../src/core/config.js";
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
  upstreamSyncTimeoutMs: 120_000,
  maxStrikes: 3,
  cooldownRateLimitMs: 60_000,
  cooldownPaymentMs: 3_600_000,
  cooldownStrikeMs: 1_800_000,
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
    expect(k1.cooldownReason).toBe("rate limited");
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
    expect(k1.evicted).toBe(false);
    expect(k1.cooldownUntil).toBe(1000 + CONFIG.cooldownStrikeMs);
    expect(k1.cooldownReason).toBe("network error");
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
    expect(k1.evicted).toBe(false);
    expect(k1.cooldownUntil).toBe(1000 + CONFIG.cooldownStrikeMs);
    expect(k1.cooldownReason).toBe("timeout");
  });

  // M3：网络全失败时 key 本身还没冷却也没被剔除，报 all_cooling 是自相矛盾的
  // （message 写「全部 key 均已尝试且失败」，reason 却暗示「在冷却，会自愈」）。
  it("所有 key 都抛网络错误时报 upstream_error，而不是 all_cooling", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ throws: new Error("e1") }, { throws: new Error("e2") }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "upstream_error" } });
  });

  // ── C2：上游一次抖动不得永久摧毁整个 key 池 ──────────────────────────────
  // 复现评审实测：3 把 key、上游持续 503，原实现只需 5 个请求就把整池打成永久剔除，
  // 上游恢复后网关永久返回 503。现在改为长冷却，到期自动恢复。

  it("上游持续 5xx 打满 strike 后，整池进入冷却而非永久剔除", async () => {
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const at = 1000;
    // 3 把 key × maxStrikes 3 = 9 次失败才可能打满，给足 30 次 503。
    const f = new FakeFetcher(Array.from({ length: 30 }, () => ({ status: 503 })));
    for (let i = 0; i < 10; i++) {
      await dispatch({
        path: "/chat/completions", body: {}, stream: false,
        deps: { repo, fetcher: f, config: CONFIG, now: () => at },
      });
    }
    const all = await repo.all();
    expect(all.map((r) => r.evicted)).toEqual([false, false, false]);
    expect(all.every((r) => r.cooldownUntil === at + CONFIG.cooldownStrikeMs)).toBe(true);
  });

  it("冷却到期后上游恢复，网关自动恢复服务（不需要任何人工干预）", async () => {
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const at = 1000;
    // 上游故障是可恢复的：down 为 true 时一律 503，翻回 false 即代表上游恢复。
    let down = true;
    const f = {
      async fetch() {
        return down ? new Response("{}", { status: 503 }) : new Response('{"ok":true}', { status: 200 });
      },
    };
    for (let i = 0; i < 10; i++) {
      await dispatch({
        path: "/chat/completions", body: {}, stream: false,
        deps: { repo, fetcher: f as never, config: CONFIG, now: () => at },
      });
    }
    // 冷却期内确实不可用
    const during = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f as never, config: CONFIG, now: () => at + 1 },
    });
    expect(during.status).toBe(503);

    // 上游恢复 + 冷却到期 → 无需任何人工干预即恢复服务
    down = false;
    const after = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f as never, config: CONFIG, now: () => at + CONFIG.cooldownStrikeMs },
    });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ ok: true });
  });

  // ── M3：reason 必须区分「会自愈」与「不会自愈」 ─────────────────────────

  it("全池因 strike 冷却时报 all_cooling 并给出 Retry-After", async () => {
    const repo = await makeRepo(["k1"]);
    const at = 1000;
    const f = new FakeFetcher(Array.from({ length: 10 }, () => ({ status: 503 })));
    for (let i = 0; i < 3; i++) {
      await dispatch({
        path: "/chat/completions", body: {}, stream: false,
        deps: { repo, fetcher: f, config: CONFIG, now: () => at },
      });
    }
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => at + 1 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "all_cooling" } });
    expect(Number(res.headers.get("retry-after"))).toBe(CONFIG.cooldownStrikeMs / 1000);
  });

  it("全池因凭据失效被剔除时报 all_evicted（明示不会自愈），且不带 Retry-After", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 401 }, { status: 401 }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "all_evicted" } });
    expect(res.headers.get("retry-after")).toBeNull();
    expect((await repo.all()).every((r) => r.evicted)).toBe(true);
  });

  // ── I2：上游响应头与 401 错误体绝不外泄 ─────────────────────────────────

  it("上游响应头不原样转发（set-cookie / x-* 一律剥掉）", async () => {
    const repo = await makeRepo(["k1"]);
    const f = new FakeFetcher([{
      status: 200, body: "{}",
      headers: {
        "set-cookie": "sess=upstream", "x-upstream-internal": "leak",
        "www-authenticate": "Bearer realm=upstream", "content-type": "application/json",
      },
    }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-upstream-internal")).toBeNull();
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("content-disposition 会被透传（媒体路由下载文件名依赖它），set-cookie 等仍被剥掉", async () => {
    const repo = await makeRepo(["k1"]);
    const f = new FakeFetcher([{
      status: 200, body: "binary-ish",
      headers: {
        "content-disposition": 'attachment; filename="video.mp4"',
        "set-cookie": "sess=upstream", "content-type": "video/mp4",
      },
    }]);
    const res = await dispatch({
      path: "/videos", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="video.mp4"');
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-type")).toBe("video/mp4");
  });

  it("上游 401 的错误体绝不透传给客户端（那是最可能回显 key 片段的地方）", async () => {
    const repo = await makeRepo(["k1"]);
    const leak = '{"error":"invalid api key: sk-live-ABCDEF0123456789"}';
    const f = new FakeFetcher([{ status: 401, body: leak }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    const text = await res.text();
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("invalid api key");
    expect(JSON.parse(text)).toMatchObject({ error: { reason: "all_evicted" } });
  });

  it("先 5xx 后 401 时仍回第一把 key 的真实上游错误，而不是被 401 抹掉", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 500, body: '{"e":"upstream boom"}' }, { status: 401, body: "secret" }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret");
  });

  // ── I6：换 key 重试时被丢弃的上游响应体必须被取消 ───────────────────────

  it("换 key 重试时取消掉被丢弃的上游响应体", async () => {
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const cancelled: string[] = [];
    const bodyOf = (tag: string) =>
      new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode(tag)); },
        cancel() { cancelled.push(tag); },
      });
    let n = 0;
    const fetcher = {
      async fetch() {
        n++;
        if (n < 3) return new Response(bodyOf(`err${n}`), { status: 500 });
        return new Response('{"ok":true}', { status: 200 });
      },
    };
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: fetcher as never, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    // err1 在被 err2 覆盖时取消，err2 在成功返回时取消。
    expect(cancelled.sort()).toEqual(["err1", "err2"]);
  });

  // ── I3：上游 200 但不是 JSON ────────────────────────────────────────────

  it("expectJson 时上游返回非 JSON 的 200 会记 strike 并换下一把 key", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([
      { status: 200, body: "<html>502 Bad Gateway</html>" },
      { status: 200, body: '{"ok":true}' },
    ]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false, expectJson: true,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await repo.all()).find((r) => r.key === "k1")!.strikes).toBe(1);
  });

  it("expectJson 时全池都返回非 JSON 的 200 则回 502，而不是 500 纯文本", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([
      { status: 200, body: "<html>oops</html>" },
      { status: 200, body: "not json either" },
    ]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false, expectJson: true,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ error: { reason: "upstream_bad_body" } });
  });

  it("GET 请求不携带 body", async () => {
    const repo = await makeRepo(["k1"]);
    let seen: RequestInit | null = null;
    const fetcher = { async fetch(_u: string, init: RequestInit) { seen = init; return new Response("{}"); } };
    await dispatch({ path: "/videos/x", body: undefined, stream: false, method: "GET",
      deps: { repo, fetcher: fetcher as any, config: CONFIG, now: () => 1 } });
    expect(seen!.body).toBeUndefined();
    expect(seen!.method).toBe("GET");
  });
});

// ── C-RM2：8 秒是「流式首字节」的调优值，不能统一套到同步端点 ────────────────
//
// 真机实测：直连上游 /images/generations 首字节耗时 11.99 秒（HTTP 200，同步接口，
// 首字节 = 整张图渲染完）。经网关（8 秒超时）则每把 key 各记一次 strike 后返回失败，
// 三次图片请求即可把整池打进 30 分钟长冷却。
//
// 本组用例刻意使用 configFromEnv 产出的**内置默认配置**而不是文件顶部的 CONFIG 字面量：
// 只有这样，把 DEFAULTS.upstreamSyncTimeoutMs 改回 8000 才会让它们变红。
describe("按端点语义区分超时", () => {
  const DEFAULTS = configFromEnv({ GATEWAY_TOKEN: "t", AGNES_BASE_URL: "https://upstream.test/v1" });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("内置默认值：同步端点的预算远大于流式首字节的 8 秒", () => {
    expect(DEFAULTS.upstreamTimeoutMs).toBe(8000);
    expect(DEFAULTS.upstreamSyncTimeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("同步端点：上游 12 秒才吐首字节（实测值），用内置默认配置照样成功", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1"]);
    const f = new FakeFetcher([
      { status: 200, body: '{"data":[{"url":"https://example.invalid/a.png"}]}', delayMs: 11_990 },
    ]);
    const pending = dispatch({
      path: "/images/generations", body: {}, stream: false, timeout: "sync",
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => 1000 },
    });
    await vi.advanceTimersByTimeAsync(11_990);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ url: "https://example.invalid/a.png" }] });
    expect((await repo.all())[0]!.strikes).toBe(0);
  });

  it("流式/对话端点：同一个 12 秒的上游，仍然在 8 秒被甩掉并记 strike（§7.3 语义不变）", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1"]);
    const f = new FakeFetcher([{ status: 200, body: "{}", delayMs: 11_990 }]);
    const pending = dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => 1000 },
    });
    await vi.advanceTimersByTimeAsync(11_990);
    const res = await pending;

    expect(res.status).toBe(503);
    const k1 = (await repo.all())[0]!;
    expect(k1.strikes).toBe(1);
    expect(k1.cooldownUntil).toBe(0);
  });

  // 判断：同步端点超时**不**记 strike，也不再换下一把 key。理由见 dispatcher.ts 的
  // syncTimedOut 注释。这条用例钉住的正是「三次图片请求打垮整池」那个连带后果。
  it("同步端点超时：504、不记 strike、不再尝试池中其他 key", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const f = new FakeFetcher(
      Array.from({ length: 3 }, () => ({ status: 200, body: "{}", delayMs: 300_000 })),
    );
    const pending = dispatch({
      path: "/images/generations", body: {}, stream: false, timeout: "sync",
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => 1000 },
    });
    await vi.advanceTimersByTimeAsync(DEFAULTS.upstreamSyncTimeoutMs);
    const res = await pending;

    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { reason: "upstream_timeout" } });
    expect(f.usedKeys).toEqual(["k1"]);
    const all = await repo.all();
    expect(all.map((r) => r.strikes)).toEqual([0, 0, 0]);
    expect(all.map((r) => r.cooldownUntil)).toEqual([0, 0, 0]);
    expect(all.map((r) => r.evicted)).toEqual([false, false, false]);
  });

  it("三次图片超时之后，整池依然全部可用（连带摧毁 key 池的路径已断开）", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const f = new FakeFetcher(
      Array.from({ length: 9 }, () => ({ status: 200, body: "{}", delayMs: 300_000 })),
    );
    for (let i = 0; i < 3; i++) {
      const pending = dispatch({
        path: "/images/generations", body: {}, stream: false, timeout: "sync",
        deps: { repo, fetcher: f, config: DEFAULTS, now: () => 1000 },
      });
      await vi.advanceTimersByTimeAsync(DEFAULTS.upstreamSyncTimeoutMs);
      expect((await pending).status).toBe(504);
    }
    const all = await repo.all();
    expect(all.every((r) => !r.evicted && r.cooldownUntil === 0 && r.strikes === 0)).toBe(true);
  });

  // 只豁免「超时」，不豁免「连不上」：真正坏掉的 key 会立刻抛网络错误，那条通路仍然
  // 记 strike 并换下一把，否则同步端点就永远没有淘汰坏 key 的能力了。
  it("同步端点的网络错误仍然记 strike 并换下一把 key", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ throws: new Error("ECONNREFUSED") }, { status: 200, body: "{}" }]);
    const res = await dispatch({
      path: "/images/generations", body: {}, stream: false, timeout: "sync",
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => 1000 },
    });

    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    expect((await repo.all()).find((r) => r.key === "k1")!.strikes).toBe(1);
  });
});
