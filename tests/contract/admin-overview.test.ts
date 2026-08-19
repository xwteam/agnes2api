import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { workerRuntime } from "../../src/adapters/runtime-worker.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import type { Storage } from "../../src/ports/storage.js";

/**
 * **contract ⇒ node 与 workerd 各跑一遍**（两份 vitest 配置的 include 都收 tests/contract）。
 */
const AUTH = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

interface OverviewBody {
  version: string;
  serverTime: number;
  runtime: { name: "node" | "worker" };
  process: { pid: number; rssBytes: number; uptimeMs: number } | null;
  storage: { backend: "file" | "kv"; writable: boolean; checkedAt: number | null };
  pool: { total: number; fresh: number; cooling: number; evicted: number } | null;
  poolStats: {
    requests: number; success: number; failed: number; clientErrors: number;
    lastErrorAt: number | null; lastErrorKind: string | null; approximate: boolean;
  } | null;
  freshness: {
    poolCacheTtlMs: number | null; poolVisibilityUpperBoundMs: number | null;
    poolTouchIntervalMs: number | null; configTtlMs: number; configVisibilityUpperBoundMs: number;
    kvEdgeCacheMs: number;
  };
  config: {
    registrarEnabled: boolean; primary: string | null; fallback: string | null;
    targetKeys: number; envLocked: string[]; degraded: boolean;
  } | null;
}

async function getOverview(app: Awaited<ReturnType<typeof makeApp>>["app"]): Promise<OverviewBody> {
  const res = await app.request("/admin/api/overview", AUTH);
  expect(res.status, "GET /admin/api/overview").toBe(200);
  return await res.json() as OverviewBody;
}

/** 存储的每一个方法都真的抛错——用来验证 overview 的逐块降级不依赖某一种特定的失败姿势。 */
class BrokenStorage implements Storage {
  async get<T>(): Promise<T | null> { throw new Error("storage get failed"); }
  async put<T>(): Promise<void> { throw new Error("storage put failed"); }
  async delete(): Promise<void> { throw new Error("storage delete failed"); }
  async list(): Promise<string[]> { throw new Error("storage list failed"); }
}

describe("GET /admin/api/overview", () => {
  it("未鉴权 401（矩阵已覆盖，这里只留一条冒烟）", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/overview")).status).toBe(401);
  });

  /**
   * **诚实性第 6 条**：Worker 形态下 `process` 必须是 `null`，前端据此渲染
   * 「Serverless · 无常驻进程」——不是 0、不是空、不隐藏格子。
   *
   * **两格都要**：只测 null 那一格的话，「process 永远返回 null」的实现也能过
   * （只有 workerRuntime 那一格会绿）。加反向那一格（nodeRuntime 时是对象且 pid > 0），
   * 才能证明 `deps.runtime.process()` 真的被读了、而不是硬编码。
   */
  it("worker 形态：process 必须严格是 null", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { runtime: workerRuntime() });
    const body = await getOverview(app);
    expect(body.process).toBeNull();
  });

  it("反向那一格：node 形态时 process 是对象且 pid > 0", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { runtime: nodeRuntime() });
    const body = await getOverview(app);
    expect(body.process).not.toBeNull();
    expect(body.process!.pid).toBeGreaterThan(0);
  });

  /**
   * **产品不变式 9（逐块降级 + 绝不伪造 0）**：让 `repo.all()` 会经过的每一次存储
   * 读取都真的抛错，断言 `overview` 仍 200、`pool`/`poolStats` **严格 `=== null`**
   * ——不是 0、不是 `{ total: 0, fresh: 0, … }`、不是缺字段。
   *
   * ⚠️ 关键是**同时**断言「该块 null」与「别的块没跟着塌」（`version`/`runtime` 仍有值）
   * ——只断言前者的话，「整个 handler 返回一堆 null」这种实现也能过（第 4 种假阳性）。
   */
  it("存储读取全部抛错时：res 仍 200，pool/poolStats 严格 null，version/runtime 不受影响", async () => {
    const { app } = await makeApp([], [], {}, () => 1000, { storage: new BrokenStorage() });
    const body = await getOverview(app);
    expect(body.pool).toBeNull();
    expect(body.poolStats).toBeNull();
    // 绝不伪造 0：显式确认不是全零对象混进来。
    expect(body.pool).not.toEqual({ total: 0, fresh: 0, cooling: 0, evicted: 0 });
    // 别的块没跟着塌。
    expect(body.version).toBe("0.1.0");
    expect(body.runtime).toEqual({ name: "node" });
  });

  /**
   * 两个 TTL **都在**，且两条上界都比各自的 TTL 大一个 KV 边缘缓存的量。
   *
   * ⚠️ 前两条是「关系」断言，后两条是「字面量」断言，**两种都要**，且**关系断言
   * 必须从响应自己的 `kvEdgeCacheMs` 字段推导，不能手写字面量 `60_000`**——
   * 手写字面量的话，`KV_EDGE_CACHE_MS` 这个常数本身被改错（例如改成 30_000，
   * 但两处相加的逻辑都还在）时，关系式两边会**一起**偏移同样的量、关系照样成立，
   * 相加逻辑本身被删掉（Step 9 变异表另一行）才会被关系断言抓住；
   * 只有字面量断言能单独逮住「常数本身被改错」这一种（已实测确认，见变异验证表）。
   */
  it("两个 TTL 都在，且两条上界都把 KV 边缘缓存算进去", async () => {
    const { app } = await makeApp(
      [], ["k1"], { poolCacheTtlMs: 60_000, poolTouchIntervalMs: 21_600_000 }, () => 1000,
    );
    const body = await getOverview(app);
    const f = body.freshness;
    expect(f.poolCacheTtlMs).toBe(60_000);
    expect(f.poolTouchIntervalMs).toBe(21_600_000);
    expect(f.poolVisibilityUpperBoundMs).toBe(f.poolCacheTtlMs! + f.kvEdgeCacheMs);
    expect(f.configVisibilityUpperBoundMs).toBe(f.configTtlMs + f.kvEdgeCacheMs);
    expect(f.configTtlMs).toBe(30_000);       // 手写字面量
    expect(f.kvEdgeCacheMs).toBe(60_000);     // 手写字面量
  });

  /**
   * `envLocked` 真的跟着环境变量走：`makeApp` 传 `envLocked: ["maxStrikes"]`，
   * 断言 `body.config.envLocked` 恰好等于 `["maxStrikes"]`。
   */
  it("envLocked 原样透传，不多不少", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { envLocked: ["maxStrikes"] });
    const body = await getOverview(app);
    expect(body.config!.envLocked).toEqual(["maxStrikes"]);
  });

  /** `poolStats.approximate === true`：字面量断言。 */
  it("poolStats.approximate 字面量为 true", async () => {
    const { app } = await makeApp([], ["k1"]);
    const body = await getOverview(app);
    expect(body.poolStats!.approximate).toBe(true);
  });

  /**
   * **`/health` 的键集合未扩大**（设计文档 §12 L10 的禁令）：`overview` 里有池子
   * 健康度，而做概览时最省事的做法就是把 `poolHealth()` 挂到免鉴权的 `/health` 上。
   */
  it("/health 仍然不含任何池子信息——池子规模只走鉴权后的 overview", async () => {
    const { app } = await makeApp();
    const body = await (await app.request("/health")).json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["status", "storage", "version"]);
    expect(JSON.stringify(body)).not.toContain("fresh");
  });

  it("**/admin/api/overview 不被静态兜底吃掉**——注册顺序错了它会变成 404", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/overview", AUTH)).status).toBe(200);
  });
});
