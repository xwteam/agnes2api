import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../../src/http/wire.js";
import { createApp } from "../../src/http/app.js";
import { createConfigHolder, CONFIG_TTL_MS } from "../../src/http/config-holder.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { FakeFetcher } from "../helpers/fake-fetcher.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import type { Storage } from "../../src/ports/storage.js";
import { makeApp, TEST_CONFIG } from "../helpers/make-app.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { StoreLogger } from "../../src/adapters/logger-store.js";
import { EVENT_FLUSH_MIN_INTERVAL_MS } from "../../src/core/admin/event-ring.js";

describe("buildApp", () => {
  it("从环境变量与存储装配出可用的 app", async () => {
    const { app } = await buildApp({ GATEWAY_TOKEN: "t" }, new MemoryStorage(), nodeRuntime());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("缺少 GATEWAY_TOKEN 时装配失败并给出明确错误", async () => {
    await expect(buildApp({}, new MemoryStorage(), nodeRuntime())).rejects.toThrow(/GATEWAY_TOKEN/);
  });

  /**
   * `POOL_CACHE_TTL_MS` 必须真的接到 app 那个 repo 上。
   *
   * 不钉这一条的话，把 wire.ts 里那两行 `cacheTtlMs: cfg.poolCacheTtlMs` 删掉，
   * 全套测试照样全绿（变异实测逃逸），而后果是 `.env.example` 与五语言 DEPLOY.md
   * 里白纸黑字写着的两个环境变量**根本不起作用**——文档在骗人，用户按文档关掉
   * 缓存来救 KV 配额，实际一点效果都没有。
   *
   * 两个方向都断言：只断言「设成 0 会每次都读」的话，把 repo 硬编码成
   * `cacheTtlMs: 0`（等于所有人都拿不到缓存）也照样绿。
   */
  it("POOL_CACHE_TTL_MS 真的接到了 app 那个 repo 上（两个方向都断言）", async () => {
    for (const [label, env, expectSecondRead] of [
      ["关缓存：每次 all() 都真读一次池子", { POOL_CACHE_TTL_MS: "0" }, true],
      ["默认 60 秒：第二次 all() 零读", {}, false],
    ] as Array<[string, Record<string, string>, boolean]>) {
      const { repo, s } = await appWithPool(env);
      await repo.all();
      expect(s.poolReads, `${label}：第一次总要读`).toBeGreaterThan(0);
      s.poolReads = 0;
      await repo.all();
      expect(s.poolReads > 0, label).toBe(expectSecondRead);
    }
  });

  /**
   * `POOL_TOUCH_INTERVAL_MS` 同理——而且它比 TTL 更容易被悄悄写死成 0：那样写消除
   * 永远关着，每个成功请求照旧写一次 KV，免费档的 1,000 次/天写配额原封不动地
   * 卡在那儿，本任务的收益整个消失，**而所有单测照样全绿**（变异实测逃逸过一次）。
   */
  it("POOL_TOUCH_INTERVAL_MS 真的接到了 app 那个 repo 上（两个方向都断言）", async () => {
    for (const [label, env, expectSecondWrite] of [
      ["关写消除：每次都落盘", { POOL_TOUCH_INTERVAL_MS: "0" }, true],
      ["默认 6 小时：只改 lastUsedAt 的那次零写", {}, false],
    ] as Array<[string, Record<string, string>, boolean]>) {
      const { repo, s } = await appWithPool(env);
      // 第一次一定会写（lastUsedAt 从 null 变成数字），第二次才是被测的那次。
      const r0 = (await repo.all())[0]!;
      await repo.save({ ...r0, lastUsedAt: 1_000_000 }, r0);
      expect(s.poolWrites, `${label}：首次使用必须落盘`).toBeGreaterThan(0);

      const r1 = (await repo.all()).find((x) => x.id === r0.id)!;
      expect(r1.lastUsedAt, "前置条件：第一次真的落盘了").toBe(1_000_000);
      s.poolWrites = 0;
      await repo.save({ ...r1, lastUsedAt: 1_000_001 }, r1);
      expect(s.poolWrites > 0, label).toBe(expectSecondWrite);
    }
  });
});

/** 只数 key 池相关的读写（`key:` 与 `pool:index`），把配置读写排除在外。 */
class PoolIoCountingStorage extends MemoryStorage {
  poolReads = 0;
  poolWrites = 0;
  private static pool(key: string): boolean {
    return key.startsWith("key:") || key === "pool:index";
  }
  override async get<T>(key: string): Promise<T | null> {
    if (PoolIoCountingStorage.pool(key)) this.poolReads++;
    return super.get<T>(key);
  }
  override async put<T>(key: string, value: T): Promise<void> {
    if (PoolIoCountingStorage.pool(key)) this.poolWrites++;
    return super.put(key, value);
  }
}

/**
 * 装一个装了一把 key 的真 app，并交出**它自己那个** repo。
 *
 * 关键是不能在测试里照抄一遍 wire.ts 的装配去验证 wire.ts——照抄的那份永远验证
 * 不了原件。key 用一个独立的、关掉缓存的 repo 预先装进去，不碰被测那份快照。
 */
async function appWithPool(env: Record<string, string>) {
  const s = new PoolIoCountingStorage();
  await new KeyPoolRepo(s, { now: () => Date.now(), logger: NULL_LOGGER, cacheTtlMs: 0 }).add("k1");
  const { repo } = await buildApp({ GATEWAY_TOKEN: "t", ...env }, s, nodeRuntime());
  s.poolReads = 0;
  s.poolWrites = 0;
  return { repo, s };
}

/** 记账用的存储：统计写次数，并可切换成「写不进去」。 */
class CountingStorage implements Storage {
  puts = 0;
  deletes = 0;
  writable = true;
  private readonly map = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.puts++;
    if (!this.writable) throw new Error("EACCES: permission denied, open '/app/data/store.json'");
    this.map.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.deletes++;
    if (!this.writable) throw new Error("EACCES: permission denied, unlink '/app/data/store.json'");
    this.map.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

// ── C-RM1：健康检查要反映「存储可写」，但不许每次都写盘 ─────────────────────
describe("buildApp 的存储可写性探测", () => {
  it("开启探测时只写一次探针键并删掉，之后 /health 不再产生任何写入", async () => {
    const s = new CountingStorage();
    const { app } = await buildApp({ GATEWAY_TOKEN: "t" }, s, nodeRuntime(), { probeStorage: true });

    expect(s.puts).toBe(1);
    expect(s.deletes).toBe(1);
    expect(s.keys()).toEqual([]); // 探针不在存储里留痕迹

    for (let i = 0; i < 5; i++) {
      expect((await app.request("/health")).status).toBe(200);
    }
    expect(s.puts).toBe(1);
    expect(s.deletes).toBe(1);
  });

  it("不开启探测时装配完全不写存储（Worker/KV 形态不消耗写配额）", async () => {
    const s = new CountingStorage();
    const { app } = await buildApp({ GATEWAY_TOKEN: "t" }, s, nodeRuntime());

    expect(s.puts).toBe(0);
    expect(s.deletes).toBe(0);
    expect((await app.request("/health")).status).toBe(200);
    expect(s.puts).toBe(0);
  });

  it("探测失败时 /health 报 503 degraded，而不是继续报 healthy", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const s = new CountingStorage();
      s.writable = false;
      const { app } = await buildApp({ GATEWAY_TOKEN: "t" }, s, nodeRuntime(), { probeStorage: true });

      const res = await app.request("/health");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "degraded", storage: { writable: false } });
      expect(warn).toHaveBeenCalled(); // 原始异常写进容器日志，而不是响应体
    } finally {
      warn.mockRestore();
    }
  });

});

/**
 * 记账用的存储：统计 get / put / delete，用来证明 `/health` 不触发任何存储 I/O。
 *
 * ⚠️ **它原来只统计 `get`，名字也叫 `GetCountingStorage`**（全分支评审 I1）。
 * 注释写的是「不触发任何存储读取」，而 `src/http/routes/health.ts:17` 与
 * `src/http/config-refresh.ts:17` 两处的措辞都是**「不触发任何存储 I/O」**——
 * 写那一侧当时根本不可观测，而那一侧恰恰是真的被违反着的：`logFlush` 也挂在 `*`
 * 上，缓冲里只要攒着事件，一次健康检查就连带一次 `get` + 一次 `put`。
 * **判据只覆盖了半边，而被覆盖的那半边让被违反的那半边不可观测**
 *（本仓登记的第 5 种假阳性）。
 */
class IoCountingStorage implements Storage {
  gets = 0;
  puts = 0;
  deletes = 0;
  private readonly inner = new MemoryStorage();
  async get<T>(key: string): Promise<T | null> {
    this.gets++;
    return this.inner.get<T>(key);
  }
  async put<T>(key: string, value: T, expiresAt?: number): Promise<void> {
    this.puts++;
    return this.inner.put(key, value, expiresAt);
  }
  async delete(key: string): Promise<void> { this.deletes++; return this.inner.delete(key); }
  async list(prefix: string): Promise<string[]> { return this.inner.list(prefix); }
  io(): number { return this.gets + this.puts + this.deletes; }
}

// configRefresh / logFlush 对 /health 的例外：既有的 CountingStorage 用例只统计
// put/delete，观测不到 ensureFresh() 内部的 storage.get；而 TTL=30s 的真实 Date.now()
// 在单测的执行窗口里根本不会过期，即使统计了 get 也测不出差别。这里用注入的假时钟把
// TTL 直接拨到过期，才能真正区分「/health 被免检」与「TTL 恰好没到」。
describe("/health 的零存储 I/O 契约（configRefresh 与 logFlush 两处例外）", () => {
  it("TTL 早已过期时，/health 仍不触发存储读取；其它路由会", async () => {
    let t = 0;
    const now = () => t;
    const s = new IoCountingStorage();
    await s.put("config", { gatewayToken: "t" });
    const configHolder = await createConfigHolder({ env: {}, storage: s, logger: NULL_LOGGER, now });
    const repo = new KeyPoolRepo(s, { now, logger: NULL_LOGGER });
    const app = createApp({
      version: "0.1.0", configHolder, repo,
      fetcher: new FakeFetcher([]), now, storageHealth: createStorageHealth(), logger: NULL_LOGGER,
    });

    const getsAfterPrime = s.gets; // createConfigHolder 的 prime() 已经读过一次
    t += CONFIG_TTL_MS * 10; // TTL 早已过期

    await app.request("/health");
    await app.request("/health");
    expect(s.gets, "/health 不该触发任何存储读取").toBe(getsAfterPrime);

    await app.request("/v1/models", { headers: { authorization: "Bearer t" } });
    expect(s.gets, "非 /health 路由要在 TTL 过期后触发重载").toBeGreaterThan(getsAfterPrime);
  });

  /**
   * **写那一侧**（全分支评审 I1）。
   *
   * 关键在于**先把事件缓冲喂满**：`maybeFlush()` 第一行就是 `buffer.length === 0`
   * 时直接返回，缓冲空着的话 `/health` 走不走 `logFlush` 完全一样，这条豁免又变成
   * 不可观测（第 5 种假阳性，与上面那个只数 `get` 的夹具同型）。时钟也要真的推过
   * `EVENT_FLUSH_MIN_INTERVAL_MS`：不推的话最小间隔闸会先拦住，同样测不出
   * 「豁免」与「间隔没到」的差别——这两点都实测过（见本轮报告 M-A5b）。
   *
   * 三段结构，**反向格必须在最前**：
   * ① 反向：同样的状态下，一个**非 `/health`** 的请求会真的落盘 ⇒ 证明这一批缓冲
   *    确实到了"该落盘"的状态；
   * ② 正向：把状态重置回"该落盘"，连打 `/health`，三个计数一个都不许增加；
   * ③ 收尾：`/health` 之后再来一个普通请求，那批事件照样落得下去——豁免只是
   *    "推迟"，不是"丢掉"。
   */
  it("缓冲里攒着事件、且最小间隔已过时，/health 仍然一次存储 I/O 都不产生", async () => {
    let t = 1000 * 3_600_000;
    const now = () => t;
    const s = new IoCountingStorage();
    await s.put("config", { gatewayToken: "t" });
    const configHolder = await createConfigHolder({ env: {}, storage: s, logger: NULL_LOGGER, now });
    const repo = new KeyPoolRepo(s, { now, logger: NULL_LOGGER });
    const storeLogger = new StoreLogger({ storage: s, now, shardId: "wire", onError: () => {} });
    const app = createApp({
      version: "0.1.0", configHolder, repo,
      fetcher: new FakeFetcher([]), now, storageHealth: createStorageHealth(),
      logger: NULL_LOGGER, storeLogger,
    });

    /** 把状态摆回「缓冲非空 + 最小间隔已过」。 */
    const arm = () => {
      storeLogger.log({ level: "warn", event: "probe.armed" });
      t += EVENT_FLUSH_MIN_INTERVAL_MS + 1;
    };

    // ① 反向自检：这批缓冲确实到了该落盘的状态——非 /health 的请求会真的写一次。
    arm();
    let before = s.io();
    await app.request("/v1/models", { headers: { authorization: "Bearer t" } });
    expect(
      s.io() - before,
      "前置条件不成立：普通请求都没能触发落盘，下面那条 0 就什么都不证明",
    ).toBeGreaterThan(0);

    // ② 正向：同样的状态，连打 /health，三个计数一个都不许增加。
    //    期望值是**手写的三个 0**，不是从 `s` 自己反算出来的（第 6 种假阳性）。
    arm();
    const base = { gets: s.gets, puts: s.puts, deletes: s.deletes };
    for (let i = 0; i < 3; i++) expect((await app.request("/health")).status).toBe(200);
    expect(
      { gets: s.gets - base.gets, puts: s.puts - base.puts, deletes: s.deletes - base.deletes },
      "/health 触发了存储 I/O —— 镜像内置的 HEALTHCHECK 每 30 秒来一次，永不停",
    ).toEqual({ gets: 0, puts: 0, deletes: 0 });

    // ③ 豁免只是推迟，不是丢掉：下一个普通请求照样把那批事件落下去。
    before = s.io();
    await app.request("/v1/models", { headers: { authorization: "Bearer t" } });
    expect(s.io() - before, "被 /health 跳过的那批事件再也落不了盘了").toBeGreaterThan(0);
  });
});

// wire.ts 忘了把 logger 传给 loadConfig 时，注册机的配置告警会静默消失——
// 而这些告警正是「用户填了脏配置，注册机悄悄关着」的唯一线索。可选参数抓不到，
// 只能靠行为断言。这里不用 recordingLogger（buildApp 内部自建 ConsoleLogger），
// 改为侦听 console.warn 并断言前缀，等价地证明了那条链路是通的。
it("buildApp 会把 logger 接到配置层：脏的存储 registrar 配置产生一条 [registrar] 告警", async () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const s = new MemoryStorage();
    await s.put("config", { registrar: { primary: "garbage" } });
    await buildApp({ GATEWAY_TOKEN: "t" }, s, nodeRuntime());
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[registrar] registrar.config_ignored"))).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

// ── ADMIN_TOKEN / TRUST_PROXY 的接线 ────────────────────────────────────────
//
// 这两行只存在于 wire.ts，而 /admin 的全部行为测试都走 makeApp（直接调 createApp）。
// 不钉这两条的话，把 wire.ts 里的 `adminToken: env.ADMIN_TOKEN` 删掉，全套测试照样
// 全绿——后果是 `.env.example` 里白纸黑字写着的 ADMIN_TOKEN **根本不起作用**，
// 面板永远打不开而且没有任何日志提示。POOL_CACHE_TTL_MS 已经在同一个坑里栽过一次。

/** 与 GATEWAY_TOKEN 不同、且够长；刻意不复用夹具常量，才能证明值是从 env 流过来的。 */
const WIRE_ADMIN_TOKEN = "wire-admin-token-0123456789ab";

describe("buildApp 对管理端的接线", () => {
  it("ADMIN_TOKEN 真的接到了 /admin 上（两个方向都断言）", async () => {
    const { app } = await buildApp(
      { GATEWAY_TOKEN: "t", ADMIN_TOKEN: WIRE_ADMIN_TOKEN }, new MemoryStorage(), nodeRuntime(),
    );
    // 正向：env 里的那把口令确实能开门（硬编码成别的常量会在这里红）。
    const ok = await app.request("/admin/api/session", { headers: { "x-admin-key": WIRE_ADMIN_TOKEN } });
    expect(ok.status, "配了 ADMIN_TOKEN 就该能进").toBe(200);
    expect((await app.request("/admin/api/session")).status, "配了口令时缺凭据是 401").toBe(401);

    // 反向：没配就整棵树不注册（接线被删时，上面那条会掉进这个 404）。
    const { app: bare } = await buildApp({ GATEWAY_TOKEN: "t" }, new MemoryStorage(), nodeRuntime());
    expect((await bare.request("/admin/api/session")).status, "没配 ADMIN_TOKEN 就该 404").toBe(404);
  });

  it("TRUST_PROXY 真的接到了客户端 IP 上（两个方向都断言）", async () => {
    for (const [label, env, expected] of [
      ["未设 TRUST_PROXY：不信 XFF，如实记 null", {}, "ip=null"],
      ["TRUST_PROXY=1：取 XFF 首段", { TRUST_PROXY: "1" }, "ip=203.0.113.7"],
    ] as Array<[string, Record<string, string>, string]>) {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { app } = await buildApp(
          { GATEWAY_TOKEN: "t", ADMIN_TOKEN: WIRE_ADMIN_TOKEN, ...env }, new MemoryStorage(), nodeRuntime(),
        );
        await app.request("/admin/api/session", {
          headers: { "x-admin-key": "wrong", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
        });
        const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("admin.login_failed"));
        expect(line, `${label}：应当有一条 admin.login_failed`).toBeDefined();
        expect(line, label).toContain(expected);
      } finally {
        spy.mockRestore();
      }
    }
  });
});

/**
 * 「记账失败」与「请求失败」是两回事。
 *
 * M1（写回前确认记录还在）给 save() 加了一次 storage.get，写路径的失败面因此从
 * 「1 次 put」变成「1 次 get + 1 次 put」。而 dispatch 的成功分支是
 * `await commit(...)` 紧接着 `return done(...)`——commit 抛错会一路冒到
 * app.onError，**把一次已经成功的上游转发变成 500**，客户端拿不到那份它本该
 * 拿到的响应体。（已实测：让确认读抛 "KV read quota exhausted"，dispatch() 抛错、
 * 不返回任何 Response。）
 *
 * 正确后果是「这次调度状态没记住」，下一次请求会重新观测到同样的上游行为并重试记账。
 */
class GetThrowsAfterWarmup implements Storage {
  private armed = false;
  constructor(private readonly inner: Storage = new MemoryStorage()) {}
  arm(): void { this.armed = true; }
  async get<T>(k: string): Promise<T | null> {
    if (this.armed) throw new Error("KV read quota exhausted");
    return this.inner.get<T>(k);
  }
  put<T>(k: string, v: T) { return this.inner.put(k, v); }
  delete(k: string) { return this.inner.delete(k); }
  list(p: string) { return this.inner.list(p); }
}

describe("记账失败不许把成功的转发变成 500", () => {
  it("上游 200 而 key 状态回写抛错时，客户端仍拿到那份 200 与原样的响应体", async () => {
    const storage = new GetThrowsAfterWarmup();
    const { app, repo, logger } = await makeApp(
      [{ status: 200, body: '{"ok":1}' }],
      ["k1"],
      // 打开快照缓存：这样第一次 all() 之后的读全命中缓存，
      // 唯一还会真去读存储的就是 save() 里那次「确认记录还在」——变异点与不变量精确对齐。
      { poolCacheTtlMs: 60_000, poolTouchIntervalMs: 0 },
      () => 1000,
      { storage },
    );
    // 预热快照（这一次允许真读），然后武装存储：此后任何 get 都抛。
    //
    // ⚠️ 用 `repo.all()` 预热，不要拿 `GET /v1/models` 当预热请求——
    // 已核实 `src/http/routes/openai.ts:9`：那条路由只返回一张编译期的静态模型表
    //（`modelListResponse`），根本不碰 repo，拿它预热等于没预热，
    // 于是真正那次请求会在 `all()` 里就抛，测到的是另一条链。
    await repo.all();
    storage.arm();

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_CONFIG.gatewayToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", messages: [{ role: "user", content: "hi" }] }),
    });

    // 行为断言，不是形状断言：状态码 **和** 响应体都要对。
    expect(res.status, "记账失败被当成了请求失败").toBe(200);
    expect(await res.text()).toContain('"ok"');
    // 而且这件事必须留下痕迹——P3b 的事件板块要按事件名筛选。
    expect(logger.events(), "记账失败必须落一条可筛选的事件").toContain("pool.commit_failed");
  });
});
