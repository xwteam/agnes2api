import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { adminRouter } from "../../src/http/admin/router.js";
import { recordingLogger } from "../helpers/recording-logger.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { fixedConfigHolder } from "../../src/http/config-holder.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { TEST_CONFIG } from "../helpers/make-app.js";
import { StoreLogger } from "../../src/adapters/logger-store.js";
import { createTendGate } from "../../src/http/admin/tend-lock.js";
import { USAGE_FLUSH_MIN_INTERVAL_MS } from "../../src/core/admin/usage-stats.js";

const TOKEN = "session-probe-admin-token-01234";

/**
 * 直接装一个只有 /admin 的 app。
 *
 * 不走 `makeApp` 是因为那里的 `version` 写死成 "0.1.0"，而本文件要证明的恰恰是
 * 「version 是注进来的、不是 handler 里抄的常数」——用一个和任何默认值都不像的
 * 版本号，把「返回硬编码字符串」这种实现直接判死。
 */
function adminApp(version: string) {
  const logger = recordingLogger();
  const admin = adminRouter({
    adminToken: TOKEN, currentGatewayToken: () => "gateway-token-not-the-admin-one",
    version, logger, trustProxy: false,
    // /admin/api/keys 要的两样。本文件只测 session，给一个空池子就够——
    // 但**必须真给**：`adminRouter` 现在会用它注册 keys 端点。
    repo: new KeyPoolRepo(new MemoryStorage(undefined, () => 1000), { now: () => 1000, logger: NULL_LOGGER, cacheTtlMs: 0 }),
    // 单把 key 验活要的出站端口。本文件只测 session，**给一个会抛错的
    // 桩**：这个 app 上没有任何 key，那条端点在 `repo.get()` 那一步就 404 了，
    // 走不到出站。给 `globalThis.fetch` 反而会让「哪天它真的被打到」变成一次真外网请求。
    fetcher: { fetch: () => { throw new Error("本文件只测 session，不该有任何出站请求"); } },
    now: () => 1000,
    // capabilities/overview 要的三样。本文件只测 session，给最小可用的夹具即可。
    configHolder: fixedConfigHolder(TEST_CONFIG),
    storageHealth: createStorageHealth(),
    runtime: nodeRuntime(),
    envLocked: [],
    // events 端点要的一样。本文件只测 session，给一个未接入任何日志链路
    // 的独立实例即可——不需要真的落过事件。
    storeLogger: new StoreLogger({
      storage: new MemoryStorage(undefined, () => 1000), now: () => 1000, shardId: "session-test-shard",
      onError: () => {},
    }),
    // 注册机那三条端点要的接线。本文件只测 session，**刻意传 `null`**：
    // 那正是「这个 app 没接注册机执行体」的形态，三条端点会如实回 503 而不是假装。
    registrar: null,
    tendGate: createTendGate(),
    // 配置那四条端点要的接线。同上，**刻意传 `null`**：
    // 那是「这个 app 没接配置读写」的形态，四条端点会如实回 503。
    config: null,
    // capabilities 的 `stats.tier2Enabled`。本文件只测 session，
    // 给**默认那一侧**（Tier-2 关着）即可。生产上这一格由 `createApp` 按
    // 「建没建 sink」填，不是从配置现读。
    usageStatsEnabled: false,
    // 用量那两条端点要的读侧接线。**刻意传 `null`**，与上面那一格
    // 同真同假：那是 Tier-2 关着的形态，两条端点如实回 `tier: "off"`（不是 503）。
    usage: null,
    // 同上：本文件只测 session，给后端常量那个默认值即可。
    usageFlushIntervalMs: USAGE_FLUSH_MIN_INTERVAL_MS,
  });
  if (!admin) throw new Error("前置条件不成立：合规的 ADMIN_TOKEN 应当装出 /admin 子 app");
  const app = new Hono();
  app.route("/", admin);
  return { app, logger };
}

describe("GET /admin/api/session", () => {
  it("鉴权通过时返回 { ok: true, version }，version 来自注入而非硬编码", async () => {
    const { app } = adminApp("9.9.9-probe");
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "9.9.9-probe" });
  });

  /**
   * 它是登录闸背后的第一个端点，越薄越好：**不返回任何配置或池子信息**。
   * 断言「只有这两个键」而不是「包含这两个键」——后者对「顺手把 gatewayToken
   * 也塞进去」这种实现完全无感。
   */
  it("响应体只有 ok 与 version 两个键，不泄漏任何配置或池子信息", async () => {
    const { app } = adminApp("9.9.9-probe");
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": TOKEN } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "version"]);
  });

  it("鉴权不通过时不返回任何响应体信息，也不泄漏版本号", async () => {
    const { app } = adminApp("9.9.9-probe");
    const res = await app.request("/admin/api/session");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("9.9.9-probe");
  });
});
