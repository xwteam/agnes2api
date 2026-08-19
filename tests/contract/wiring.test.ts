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

describe("buildApp", () => {
  it("从环境变量与存储装配出可用的 app", async () => {
    const { app } = await buildApp({ GATEWAY_TOKEN: "t" }, new MemoryStorage());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("缺少 GATEWAY_TOKEN 时装配失败并给出明确错误", async () => {
    await expect(buildApp({}, new MemoryStorage())).rejects.toThrow(/GATEWAY_TOKEN/);
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
  const { repo } = await buildApp({ GATEWAY_TOKEN: "t", ...env }, s);
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
    const { app } = await buildApp({ GATEWAY_TOKEN: "t" }, s, { probeStorage: true });

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
    const { app } = await buildApp({ GATEWAY_TOKEN: "t" }, s);

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
      const { app } = await buildApp({ GATEWAY_TOKEN: "t" }, s, { probeStorage: true });

      const res = await app.request("/health");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "degraded", storage: { writable: false } });
      expect(warn).toHaveBeenCalled(); // 原始异常写进容器日志，而不是响应体
    } finally {
      warn.mockRestore();
    }
  });

});

/** 记账用的存储：只统计 get 次数，用来证明 /health 不触发任何存储读取。 */
class GetCountingStorage implements Storage {
  gets = 0;
  private readonly inner = new MemoryStorage();
  async get<T>(key: string): Promise<T | null> {
    this.gets++;
    return this.inner.get<T>(key);
  }
  async put<T>(key: string, value: T): Promise<void> { return this.inner.put(key, value); }
  async delete(key: string): Promise<void> { return this.inner.delete(key); }
  async list(prefix: string): Promise<string[]> { return this.inner.list(prefix); }
}

// configRefresh 对 /health 的例外：既有的 CountingStorage 用例只统计 put/delete，
// 观测不到 ensureFresh() 内部的 storage.get；而 TTL=30s 的真实 Date.now() 在单测
// 的执行窗口里根本不会过期，即使统计了 get 也测不出差别。这里用注入的假时钟把
// TTL 直接拨到过期，才能真正区分「/health 被免检」与「TTL 恰好没到」。
describe("configRefresh 对 /health 的例外", () => {
  it("TTL 早已过期时，/health 仍不触发存储读取；其它路由会", async () => {
    let t = 0;
    const now = () => t;
    const s = new GetCountingStorage();
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
    await buildApp({ GATEWAY_TOKEN: "t" }, s);
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[registrar] registrar.config_ignored"))).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
