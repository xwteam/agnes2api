import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN, TEST_CONFIG } from "../helpers/make-app.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import type { Storage } from "../../src/ports/storage.js";
import type { RuntimeInfo } from "../../src/ports/runtime.js";

const AUTH = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

interface OverviewBody {
  version: string;
  serverTime: number;
  runtime: { name: "node" };
  process: { pid: number; rssBytes: number; uptimeMs: number } | null;
  storage: { backend: "file"; writable: boolean; checkedAt: number | null };
  pool: { total: number; fresh: number; cooling: number; evicted: number; disabled: number } | null;
  /**
   * **不含 `lastErrorAt`/`lastErrorKind`**（评审裁定，见 overview.ts 的说明）：
   * 概览面板不消费这两个字段，错误面正经的归宿是事件板块。
   */
  poolStats: {
    requests: number; success: number; failed: number; clientErrors: number; approximate: boolean;
  } | null;
  /** `cfg` 恒有值（见下面那条「`config` 块四个透传字段」的说明），两个 TTL 因此恒是数字，不再是 `number | null`。 */
  freshness: {
    poolCacheTtlMs: number; poolVisibilityUpperBoundMs: number;
    poolTouchIntervalMs: number; configTtlMs: number; configVisibilityUpperBoundMs: number;
  };
  /** `ConfigHolder.current()` 永不抛，`config` 恒有值，不再是 `... | null`。 */
  config: {
    registrarEnabled: boolean; channel: string | null;
    targetKeys: number; envLocked: string[]; degraded: boolean;
  };
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
   * `process` 这一块的两格。**两格都要，缺一格就有一种实现能蒙混过去。**
   *
   * ⚠️ **这两格的第一格换过一次，前提没了、判据换了、结论留下**（v0.4.0）：
   * 原来的第一格是「**Worker 形态**下 `process` 必须严格是 `null`」——诚实性第 6 条，
   * 前端据它渲染「Serverless · 无常驻进程」。**Worker 形态整体摘掉之后，
   * 「本来就没有常驻进程」这种成因不存在了**，`nodeRuntime().process()` 恒返回对象。
   *
   * **但 `process: null` 这条响应形态本身没有消失**，它今天有另一个真实成因：
   * `overviewHandler` 把 `runtime.process()` 包在 `block()` 里（那里逐字写着理由：
   * `process.memoryUsage()` 理论上可抛，一次抖动不该让整个 overview 500）。
   * ⇒ 第一格改成注入一个 `process()` 会抛的 `RuntimeInfo`，断言这一块降级成 `null`
   * 而**别的块没跟着塌**。它同时替下面那条「逐块降级」把 `process` 这一块也覆盖上了。
   *
   * 第二格（`nodeRuntime()` 时是对象且 pid > 0）原样保留：**两格合起来才能证明
   * `deps.runtime.process()` 真的被读了、而不是硬编码**——只有第二格的话，
   * 「handler 自己去调 `process.memoryUsage()`、根本不看注入的那份」也能绿。
   */
  it("process() 抛错时这一块降级成 null，其余块不受连累（不是 0、不是缺字段）", async () => {
    const throwing: RuntimeInfo = {
      ...nodeRuntime(),
      process() { throw new Error("memoryUsage exploded"); },
    };
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { runtime: throwing });
    const body = await getOverview(app);
    expect(body.process, "逐块降级：这一块 null").toBeNull();
    expect(body.runtime.name, "别的块不许跟着塌").toBe("node");
    expect(body.pool, "别的块不许跟着塌").not.toBeNull();
  });

  it("反向那一格：注入真实的 nodeRuntime() 时 process 是对象且 pid > 0", async () => {
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
   * ⚠️ 关键是**同时**断言「该块 null」与「别的块没跟着塌」（`version`/`runtime`/
   * `config` 仍有值）——只断言前者的话，「整个 handler 返回一堆 null」这种实现也能过
   * （第 4 种假阳性）。**`config` 现在恒有值**（`ConfigHolder.current()` 不碰存储，
   * 见 overview.ts 那句「`cfg` 恒有值」），这里显式断言它也没被存储故障连累。
   */
  /**
   * `pool` 块的**字段集合**是契约：概览的五张卡直接按这几个键取数
   * （`admin-ui/js/pure/overview.mjs` 的 `POOL_CARDS`），少一个键就是一张永远显示
   * `—` 的卡。断言的是 `Object.keys(...)`，不是逐个字段有值——后者对
   * 「少给一个键」这种实现无感。
   */
  it("pool 块给全五个键，且四格之和恒等于 total", async () => {
    const { app, repo } = await makeApp([], ["k1", "k2", "k3"], {}, () => 1000);
    const all = await repo.all();
    await repo.save({ ...all[0]!, disabled: true }, all[0]!);
    await repo.save({ ...all[1]!, evicted: true, evictedReason: "upstream 401" }, all[1]!);

    const body = await getOverview(app);
    expect(Object.keys(body.pool!).sort()).toEqual(["cooling", "disabled", "evicted", "fresh", "total"]);
    // 手写字面量，不从 repo 反推。
    expect(body.pool).toEqual({ total: 3, fresh: 1, cooling: 0, evicted: 1, disabled: 1 });
    const p = body.pool!;
    expect(p.fresh + p.cooling + p.evicted + p.disabled).toBe(p.total);
  });

  it("存储读取全部抛错时：res 仍 200，pool/poolStats 严格 null，version/runtime/config 不受影响", async () => {
    const { app } = await makeApp([], [], {}, () => 1000, { storage: new BrokenStorage() });
    const body = await getOverview(app);
    expect(body.pool).toBeNull();
    expect(body.poolStats).toBeNull();
    // 别的块没跟着塌。
    expect(body.version).toBe("0.1.0");
    expect(body.runtime).toEqual({ name: "node" });
    expect(body.config.registrarEnabled).toBe(TEST_CONFIG.registrar.enabled);
  });

  /**
   * **评审必修**：`config` 块的四个透传字段与 `degraded` 真的从
   * `ConfigHolder.current()` 读出来，不是恰好蒙对了夹具默认值。
   *
   * 这条防住的真实回归：评审实测原实现在 `BrokenStorage` 下把这几个字段全部硬编码
   * 断言成夹具常量（`registrarEnabled: false, channel: null, ..., degraded: false`），
   * 1022 条全绿——第 5 种假阳性，`TEST_CONFIG` 的默认值恰好与「实现有没有真的读
   * `cfg`」这个选择无法区分。这里显式把 `degraded`/`registrar` 都改成与默认值
   * **不同**的值，任何一处偷懒改成硬编码字面量都会在这条上现形。
   */
  it("config 块的字段真的从 configHolder 读出来，不是碰巧对上夹具默认值", async () => {
    const { app } = await makeApp([], ["k1"], {
      degraded: true,
      registrar: {
        ...TEST_CONFIG.registrar, enabled: true, channel: "yyds", targetKeys: 7,
        // **与夹具默认值不同**，理由同上：`blocked` 默认 false，不改的话
        // 「概览有没有真的读 cfg.registrar.blocked」这个选择在这一格上不可观测。
        blocked: true,
      },
    }, () => 1000);
    const body = await getOverview(app);
    expect(body.config).toEqual({
      registrarEnabled: true, channel: "yyds", targetKeys: 7,
      envLocked: [], degraded: true,
      // 不给这一格的话，概览卡片会照旧声称有一个在工作的注册机 —— 而补池一轮都没跑。
      registrarBlocked: true,
    });
  });

  /**
   * 两个 TTL **都在**，且两条上界**就等于各自的 TTL**，中间不许再夹任何一层。
   *
   * ⚠️ **上一版这一格钉的是「两条上界各比 TTL 大一个 KV 边缘缓存的量」**，分工是
   * 两条关系断言（从响应自身的那个字段推导，专职看守「相加逻辑还在不在」）+ 两条
   * 字面量断言（专职逮「常数被改错」）。v0.4.0 把 KV 边缘缓存整层删了（KV 随
   * Worker 形态一起没了，`FileStorage.get` 是直接 `readFile`）⇒ **那个常数与那个
   * 字段都不存在了，「常数被改错」这一档没有了主语**，字面量那一条随之退场。
   *
   * **关系断言这一半不但留着，判别力还更强了**：上界与 TTL 现在是恒等关系，
   * 任何人往回加一项（哪怕加回同一个 60 秒）当场红——而这正是这一整轮删除要防的
   * 那个回归：那两个数是**面板直接显示给运维**的传播上界，多加一项就是多报 60 秒。
   * `freshness` 的 `toEqual` 形状断言另有其格（`propagation` 那边同理），
   * 一个悄悄长回来的多余字段不会从这里溜过去。
   */
  it("两个 TTL 都在，且两条上界就等于各自的 TTL —— 中间没有任何一层缓存", async () => {
    const { app } = await makeApp(
      [], ["k1"], { poolCacheTtlMs: 60_000, poolTouchIntervalMs: 21_600_000 }, () => 1000,
    );
    const body = await getOverview(app);
    const f = body.freshness;
    expect(f.poolCacheTtlMs).toBe(60_000);
    expect(f.poolTouchIntervalMs).toBe(21_600_000);
    expect(f.poolVisibilityUpperBoundMs).toBe(f.poolCacheTtlMs);
    expect(f.configVisibilityUpperBoundMs).toBe(f.configTtlMs);
    expect(f.configTtlMs).toBe(30_000);       // 手写字面量
    // **形状也钉住**：上一版那个边缘缓存字段之类的多余项再长回来，这里当场红。
    expect(Object.keys(f).sort()).toEqual([
      "configTtlMs", "configVisibilityUpperBoundMs",
      "poolCacheTtlMs", "poolTouchIntervalMs", "poolVisibilityUpperBoundMs",
    ]);
  });

  /**
   * `envLocked` 真的跟着环境变量走：`makeApp` 传 `envLocked: ["maxStrikes"]`，
   * 断言 `body.config.envLocked` 恰好等于 `["maxStrikes"]`。
   */
  it("envLocked 原样透传，不多不少", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { envLocked: ["maxStrikes"] });
    const body = await getOverview(app);
    expect(body.config.envLocked).toEqual(["maxStrikes"]);
  });

  /** `poolStats.approximate === true`：字面量断言。 */
  it("poolStats.approximate 字面量为 true", async () => {
    const { app } = await makeApp([], ["k1"]);
    const body = await getOverview(app);
    expect(body.poolStats!.approximate).toBe(true);
  });

  /**
   * **评审裁定**：`poolStats` 不再携带 `lastErrorAt`/`lastErrorKind`——概览面板
   * 没有任何消费者读它们（`grep -rn lastError admin-ui/js/sec-overview.js` 零命中），
   * 没有消费者的响应字段迟早会漂（评审发现）。断言的是**整段响应文本**不含这两个
   * 键名，不是「字段值为 undefined」——后者对「顺手把字段塞回去，只是恰好没赋值」
   * 这种实现完全无感。
   */
  it("poolStats 不再携带 lastErrorAt/lastErrorKind", async () => {
    const { app } = await makeApp([], ["k1"]);
    const body = await getOverview(app);
    expect(Object.keys(body.poolStats!).sort()).toEqual(["approximate", "clientErrors", "failed", "requests", "success"]);
    expect(JSON.stringify(body.poolStats)).not.toContain("lastError");
  });

  /**
   * **`/health` 的键集合未扩大**（设计文档 §12 的禁令）：`overview` 里有池子
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
