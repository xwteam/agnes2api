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
        registrar: DEFAULT_REGISTRAR,
        degraded: false,
      });
    });
  });
});
