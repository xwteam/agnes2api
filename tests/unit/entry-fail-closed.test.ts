import { describe, it, expect } from "vitest";
import { configFromEnv } from "../../src/core/config.js";
import { registrarFromEnv } from "../../src/core/registrar/config.js";

const DEFAULT_REGISTRAR = registrarFromEnv({}, {});

describe("Entry fail-closed 行为", () => {
  describe("configFromEnv 缺少 GATEWAY_TOKEN", () => {
    it("抛出错误而不是使用空值", () => {
      const env = {};
      expect(() => configFromEnv(env)).toThrow("缺少 GATEWAY_TOKEN");
    });

    it("抛出错误而不是使用 undefined", () => {
      const env = { GATEWAY_TOKEN: undefined };
      expect(() => configFromEnv(env)).toThrow("缺少 GATEWAY_TOKEN");
    });
  });

  describe("configFromEnv 数值验证", () => {
    it("非法的 UPSTREAM_TIMEOUT_MS 抛错而不是 NaN", () => {
      const env = { GATEWAY_TOKEN: "test", UPSTREAM_TIMEOUT_MS: "abc" };
      expect(() => configFromEnv(env)).toThrow("UPSTREAM_TIMEOUT_MS");
    });

    it("非法的 UPSTREAM_SYNC_TIMEOUT_MS 抛错而不是 NaN", () => {
      const env = { GATEWAY_TOKEN: "test", UPSTREAM_SYNC_TIMEOUT_MS: "abc" };
      expect(() => configFromEnv(env)).toThrow("UPSTREAM_SYNC_TIMEOUT_MS");
    });

    it("非法的 MAX_STRIKES 抛错而不是 NaN", () => {
      const env = { GATEWAY_TOKEN: "test", MAX_STRIKES: "not_a_number" };
      expect(() => configFromEnv(env)).toThrow("MAX_STRIKES");
    });

    it("非法的 COOLDOWN_RATE_LIMIT_MS 抛错", () => {
      const env = { GATEWAY_TOKEN: "test", COOLDOWN_RATE_LIMIT_MS: "xyz" };
      expect(() => configFromEnv(env)).toThrow("COOLDOWN_RATE_LIMIT_MS");
    });

    it("非法的 COOLDOWN_PAYMENT_MS 抛错", () => {
      const env = { GATEWAY_TOKEN: "test", COOLDOWN_PAYMENT_MS: "xyz" };
      expect(() => configFromEnv(env)).toThrow("COOLDOWN_PAYMENT_MS");
    });
  });

  describe("configFromEnv 成功路径", () => {
    it("最小配置（仅 GATEWAY_TOKEN）使用默认值", () => {
      const env = { GATEWAY_TOKEN: "secret" };
      const config = configFromEnv(env);
      expect(config).toEqual({
        gatewayToken: "secret",
        agnesBaseUrl: "https://apihub.agnes-ai.com/v1",
        upstreamTimeoutMs: 8000,
        upstreamSyncTimeoutMs: 120_000,
        maxStrikes: 3,
        cooldownRateLimitMs: 60_000,
        cooldownPaymentMs: 3_600_000,
        cooldownStrikeMs: 1_800_000,
        // Tier-2 **默认关**（这是一条全局约束）。这一格与下面那条
        // 「覆盖所有默认值」里的 `usageStatsEnabled: true` 是一对：
        // 两条给的值必须不同，否则「configFromEnv 到底读没读 USAGE_STATS_ENABLED」
        // 在这两条上是不可观测的（第 1 种假阳性：夹具 A/B 同值）。
        usageStatsEnabled: false,
        poolCacheTtlMs: 60_000,
        poolTouchIntervalMs: 21_600_000,
        registrar: DEFAULT_REGISTRAR,
        degraded: false,
      });
    });

    it("覆盖所有默认值", () => {
      const env = {
        GATEWAY_TOKEN: "secret",
        AGNES_BASE_URL: "http://custom.example.com",
        UPSTREAM_TIMEOUT_MS: "5000",
        UPSTREAM_SYNC_TIMEOUT_MS: "45000",
        MAX_STRIKES: "5",
        COOLDOWN_RATE_LIMIT_MS: "30000",
        COOLDOWN_PAYMENT_MS: "7200000",
        COOLDOWN_STRIKE_MS: "900000",
        // 两个池子旋钮**取 0**：0 对它们是「关闭」这个合法取值，顺带证明
        // configFromEnv 这条路径也把 min 传成了 0（传 1 的话这里直接抛）。
        POOL_CACHE_TTL_MS: "0",
        POOL_TOUCH_INTERVAL_MS: "0",
        // **判据是逐字 `=== "true"`**，与 `registrar.enabled` 同一套，不是「非空即真」：
        // `USAGE_STATS_ENABLED=0` / `=false` 必须仍然是关，那是运维写下「我不要它」
        // 时最自然的两种写法（另有一格专门钉这三种写法）。
        USAGE_STATS_ENABLED: "true",
      };
      const config = configFromEnv(env);
      expect(config).toEqual({
        gatewayToken: "secret",
        agnesBaseUrl: "http://custom.example.com",
        upstreamTimeoutMs: 5000,
        upstreamSyncTimeoutMs: 45000,
        maxStrikes: 5,
        cooldownRateLimitMs: 30000,
        cooldownPaymentMs: 7200000,
        cooldownStrikeMs: 900000,
        poolCacheTtlMs: 0,
        poolTouchIntervalMs: 0,
        usageStatsEnabled: true,
        registrar: DEFAULT_REGISTRAR,
        degraded: false,
      });
    });

    /**
     * **`USAGE_STATS_ENABLED` 的判据是逐字 `=== "true"`，不是「非空即真」。**
     *
     * 它防的是一个很具体的误配：运维照着 `TRUST_PROXY=1` 的写法写
     * `USAGE_STATS_ENABLED=1`，以为开了，而实际上没开——**面板会如实说没开**
     *（`capabilities.stats.tier2Enabled` 走的是「建没建 sink」这一个来源），
     * 所以这不是静默失败；但反过来若判据松成 `!!raw`，
     * **`USAGE_STATS_ENABLED=false` 就会把它打开**，那才是真正的静默事故：
     * 一个写着 `false` 的部署每天多 13 次/isolate 的 put，抢的是 key 池状态回写的桶。
     *
     * 三种写法一格里跑完（第 5 种假阳性：分散到三格的话，
     * 「`=== "true"`」与「`!== "false"`」这两种实现在其中任何一格上都数学等价）。
     */
    it("USAGE_STATS_ENABLED 只认逐字的 \"true\"：\"1\" 与 \"false\" 都是关", () => {
      const on = configFromEnv({ GATEWAY_TOKEN: "secret", USAGE_STATS_ENABLED: "true" });
      const one = configFromEnv({ GATEWAY_TOKEN: "secret", USAGE_STATS_ENABLED: "1" });
      const off = configFromEnv({ GATEWAY_TOKEN: "secret", USAGE_STATS_ENABLED: "false" });
      // 期望值三个手写字面量，不从被测对象反推。
      expect(
        { on: on.usageStatsEnabled, one: one.usageStatsEnabled, off: off.usageStatsEnabled },
        "\"1\" 被当成开 ⇒ 判据松了；\"true\" 被当成关 ⇒ 这个开关根本打不开",
      ).toEqual({ on: true, one: false, off: false });
    });
  });
});
