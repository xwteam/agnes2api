import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { workerRuntime } from "../../src/adapters/runtime-worker.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { IS_WORKERD } from "../helpers/is-workerd.js";

/**
 * **contract ⇒ node 与 workerd 各跑一遍**（两份 vitest 配置的 include 都收 tests/contract）。
 */
const AUTH = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

interface CapabilitiesBody {
  version: string;
  runtime: { name: "node" | "worker"; colo: string | null };
  storage: { backend: "file" | "kv"; writable: boolean };
  quota: { model: "file" | "kv" };
  process: { metrics: boolean };
  logs: { processLog: boolean };
  stats: { tier2Enabled: boolean };
}

async function getCapabilities(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
): Promise<CapabilitiesBody> {
  const res = await app.request("/admin/api/capabilities", AUTH);
  expect(res.status, "GET /admin/api/capabilities").toBe(200);
  return await res.json() as CapabilitiesBody;
}

describe("GET /admin/api/capabilities", () => {
  it("未鉴权 401（矩阵已覆盖，这里只留一条冒烟）", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/capabilities")).status).toBe(401);
  });

  /**
   * **零存储读**：`capabilities` 是面板启动必调的第一个接口，全部数据来自内存
   *（注入的 RuntimeInfo + StorageHealth 的内存状态）。让它去读一次存储就等于给
   * 每次刷新加一次 KV 读——预热之后连打 20 次，gets/lists 增量必须都是 0。
   */
  it("零存储读：预热之后连打 20 次，gets/lists 增量都是 0", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { storage: st });
    await app.request("/admin/api/capabilities", AUTH); // 预热
    const base = { gets: st.gets, lists: st.lists };
    for (let i = 0; i < 20; i++) {
      expect((await app.request("/admin/api/capabilities", AUTH)).status).toBe(200);
    }
    expect(st.gets - base.gets, "capabilities 路径出现了额外的 get").toBe(0);
    expect(st.lists - base.lists, "capabilities 路径出现了 list()").toBe(0);
  });

  /**
   * `runtime.name` / `storage.backend` / `quota.model` 三者**一致**：
   * `node ⇒ file/file`，`worker ⇒ kv/kv`。
   *
   * ⚠️ **两种运行时下断言不同的值**——`makeApp` 默认注入 `nodeRuntime()`，
   * 所以再加一格显式注入 `workerRuntime()` 的。**只测 node 那一侧的话，
   * 「两个适配器返回同一份东西」这种实现完全无感（第 1 种假阳性）。**
   */
  it("node 形态：runtime/storage/quota 三者一致地报 node/file/file", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { runtime: nodeRuntime() });
    const body = await getCapabilities(app);
    expect(body.runtime.name).toBe("node");
    expect(body.storage.backend).toBe("file");
    expect(body.quota.model).toBe("file");
    expect(body.process.metrics).toBe(true);
  });

  it("worker 形态：runtime/storage/quota 三者一致地报 worker/kv/kv，process.metrics 为 false", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { runtime: workerRuntime() });
    const body = await getCapabilities(app);
    expect(body.runtime.name).toBe("worker");
    expect(body.storage.backend).toBe("kv");
    expect(body.quota.model).toBe("kv");
    expect(body.process.metrics).toBe(false);
  });

  /**
   * `logs.processLog` 与 `stats.tier2Enabled` 是「本期如实报没有」的承诺。
   * **断言字面量 `false`**，不是 `toBeFalsy()`：将来打开时这两条会红，
   * 逼人来确认面板那边也跟着改了。
   */
  it("logs.processLog 与 stats.tier2Enabled 字面量都是 false", async () => {
    const { app } = await makeApp();
    const body = await getCapabilities(app);
    expect(body.logs.processLog).toBe(false);
    expect(body.stats.tier2Enabled).toBe(false);
  });

  /**
   * ⚠️ 这条用例的作用是**把一个未验证的外部行为钉成已知事实**，不是验证我们自己的逻辑。
   *
   * **实测结果（2026-08-19，`@cloudflare/vitest-pool-workers` 0.21.3，本条用例本身
   * 就是复现步骤——`pnpm test:workers tests/contract/admin-capabilities.test.ts` 可
   * 重新验证）**：Hono 的 `app.request(path, init)` 在 workerd 侧同样是**进程内直接
   * 构造一个 `Request` 对象**去调用 `app.fetch`，并不经过 miniflare 对「真实边缘
   * 请求」才会附加的 `cf` 属性合成逻辑——两种运行时下、不显式传 `cf` 时，
   * `c.req.raw.cf` 都是 `undefined`，`colo` 因此都是 `null`。
   */
  it("colo 字段的真实行为（node 与 workerd 侧，未显式提供 cf 时均为 null）", async () => {
    const { app } = await makeApp();
    const body = await getCapabilities(app);
    if (IS_WORKERD) {
      expect(body.runtime.colo, "workerd 侧：miniflare 不为 app.request() 合成 cf").toBeNull();
    } else {
      expect(body.runtime.colo, "node 侧：cf 这个属性根本不存在").toBeNull();
    }
  });

  /**
   * 反向自检，**证明上一条的 null 是环境事实、不是 handler 读漏了**：显式在
   * `app.request()` 的 `init` 里塞一个 `cf.colo`。
   *
   * **实测（本条用例即复现步骤）：两种运行时下的表现不同，且都是环境本身的差异**——
   * workerd 的 `Request` 原生支持 `cf` 这个 Cloudflare 扩展属性，原样读出 `"SIN"`；
   * Node 侧的 `fetch`（undici 的 `Request` 实现）**不支持**这个非标准扩展属性，
   * 传了也读不到，因此仍是 `null`。**这一条不能不写**：没有它，「两边都是 null」
   * 既可能是「miniflare 真不给」，也可能是 handler 的读取逻辑本身坏了——
   * 两种成因区分不开，只有 workerd 那一侧的 `"SIN"` 才能证明 handler 读对了。
   */
  it("显式在请求上带 cf.colo 时：workerd 侧原样读出来；node 侧 fetch 不支持该扩展，仍是 null", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/api/capabilities", {
      ...AUTH,
      ...({ cf: { colo: "SIN" } } as Record<string, unknown>),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as CapabilitiesBody;
    if (IS_WORKERD) {
      expect(body.runtime.colo, "workerd 的 Request 支持 cf 扩展，证明 handler 的读取逻辑是对的").toBe("SIN");
    } else {
      expect(body.runtime.colo, "node 侧 fetch/undici 的 Request 不支持 cf 这个扩展属性").toBeNull();
    }
  });

  /**
   * ⚠️ **下面这一格就是补上那条防线的那一格——别把这段读成"现在还缺"**
   *（全分支评审 A9：原文用现在时写着"今天没有用例守…"，而它描述的是**它自己
   * 已经修好**的那个旧状态）。
   *
   * 补之前的实测（Step 9 变异表点名）：把 `capabilitiesHandler` 里的
   * `deps.storageHealth.status().writable` 改成硬编码 `true`，没有任何既有用例
   * 会变红。现在让 `storageHealth` 报告不可写、断言
   * `capabilities.storage.writable === false`，那个变异会被这一格抓住。
   */
  it("storageHealth 报告不可写时，capabilities.storage.writable 跟着变 false", async () => {
    const { app, storageHealth } = await makeApp();
    storageHealth.record(false, 1000);
    const body = await getCapabilities(app);
    expect(body.storage.writable).toBe(false);
  });

  it("**/admin/api/capabilities 不被静态兜底吃掉**——注册顺序错了它会变成 404", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/capabilities", AUTH)).status).toBe(200);
  });
});
