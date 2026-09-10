import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";

const AUTH = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

interface CapabilitiesBody {
  version: string;
  runtime: { name: "node" };
  storage: { backend: "file"; writable: boolean };
  quota: { model: "file" };
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
   * 每次刷新加一次存储读——预热之后连打 20 次，gets/lists 增量必须都是 0。
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
   * `runtime.name` / `storage.backend` / `quota.model` 三者**一致**地报 node/file/file。
   *
   * ⚠️ **这一格原来是两格**：另一格显式注入 `workerRuntime()`、断言 worker/kv/kv，
   * 上方还写着「只测 node 那一侧的话，『两个适配器返回同一份东西』这种实现完全无感」。
   * **v0.4.0 摘掉 Worker 形态之后只剩一个适配器，那条判别力的对象不存在了**
   * ——那一格连同它的立论一起删。
   * **剩下的这一格钉的仍然是一条真行为**：这四个字段真的从注入的 `RuntimeInfo` 来
   *（`{ runtime: nodeRuntime() }` 是显式注入的，不是默认值兜底），而不是 handler
   * 里四个硬编码字面量。它挡不住「把 `nodeRuntime()` 的字段也写死」——那一层由
   * `tests/unit/registrar/...` 之外的类型系统兜着（三格都是字面量类型，只有一个合法值）。
   */
  it("runtime/storage/quota 三者一致地报 node/file/file，process.metrics 为 true", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { runtime: nodeRuntime() });
    const body = await getCapabilities(app);
    expect(body.runtime.name).toBe("node");
    expect(body.storage.backend).toBe("file");
    expect(body.quota.model).toBe("file");
    expect(body.process.metrics).toBe(true);
  });

  /**
   * `logs.processLog` 是「本期如实报没有」的承诺。
   * **断言字面量 `false`**，不是 `toBeFalsy()`：将来打开时这条会红，
   * 逼人来确认面板那边也跟着改了。
   *
   * ⚠️ **`stats.tier2Enabled` 后来不再是那一类了，这段说明跟着改**：
   * 它现在是**真值**，来源是「这个 app 建没建用量 sink」。这里之所以还是 `false`，
   * 是因为 `makeApp` 默认不传 `usageSink`（= Tier-2 关着，与生产默认值一致）
   * ——**不是因为它被写死了**。写死那一条由 `tests/contract/usage-tier2.test.ts` 的
   * 「capabilities.stats.tier2Enabled 两个方向都跟着 USAGE_STATS_ENABLED 走……」
   * 双向钉着（本任务变异实测：改回写死 `false` ⇒ 那一格红，这一格照绿）。
   */
  it("logs.processLog 字面量是 false；tier2Enabled 在默认夹具（没接 sink）下如实报 false", async () => {
    const { app } = await makeApp();
    const body = await getCapabilities(app);
    expect(body.logs.processLog).toBe(false);
    expect(body.stats.tier2Enabled).toBe(false);
  });

  /**
   * ⚠️⚠️ **这里原来有两格 `colo` 用例，v0.4.0 整格删掉了。**
   * 它们钉的是 `capabilities.runtime.colo`——`c.req.raw.cf.colo`，
   * 也就是「这次请求打在哪个 Cloudflare 边缘机房」。那两格一格断言
   * 「两种运行时下不显式传 cf 时都是 null」，另一格断言「workerd 侧显式塞
   * `cf.colo` 能原样读出 SIN、node 侧 undici 的 Request 不支持这个扩展仍是 null」。
   * **后一格的全部判别力来自 workerd 那一侧**（只有它能证明 handler 读对了），
   * 而那一侧没了之后剩下的只是「一个恒为 null 的字段确实是 null」——
   * 那是同义反复，不是行为断言。`colo` 这个字段本身也一并从响应里删掉了，
   * 理由写在 `src/http/admin/handlers/capabilities.ts`。
   */

  /**
   * ⚠️ **下面这一格就是补上那条防线的那一格——别把这段读成"现在还缺"**
   *（评审发现：原文用现在时写着"今天没有用例守…"，而它描述的是**它自己
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
