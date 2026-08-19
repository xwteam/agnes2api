import { describe, it, expect } from "vitest";
import { envLockedFields } from "../../src/core/config.js";

/**
 * 防住的真实故障（设计文档 §5.3 的最高频形态）：docker-compose 里写了
 * `TARGET_KEYS=30`，用户在面板里改成 20 → 写进存储了，**但生效值永远是 30，
 * 重启也不会好**。概览页要显示「被环境变量锁定的字段数」，点进去看是哪几个。
 *
 * 期望值全部手写字面量：从 `DEFAULTS` 或 `loadConfig` 反推出来的清单
 * 恒等于实现本身，那条断言永远绿（第 6 种假阳性）。
 */
describe("envLockedFields", () => {
  it("环境变量设了哪些字段就锁哪些，字段名用面板路径而不是环境变量名", () => {
    expect(envLockedFields({ MAX_STRIKES: "3", AGNES_BASE_URL: "https://x.example.com" }).sort())
      .toEqual(["agnesBaseUrl", "maxStrikes"]);
  });
  it("空串也算设了——`MAX_STRIKES=` 在 loadConfig 里会走进 env 分支并抛错，面板必须显示它是锁定的", () => {
    expect(envLockedFields({ MAX_STRIKES: "" })).toEqual(["maxStrikes"]);
  });
  it("没设任何环境变量时是空数组，不是 undefined", () => {
    expect(envLockedFields({})).toEqual([]);
  });
  it("不认识的环境变量不算——面板只显示自己管得着的字段", () => {
    expect(envLockedFields({ PATH: "/usr/bin", HOME: "/root" })).toEqual([]);
  });
  it("清单是手写的十条，加字段必须在评审里被看见", () => {
    const all = envLockedFields({
      GATEWAY_TOKEN: "x", AGNES_BASE_URL: "x", UPSTREAM_TIMEOUT_MS: "1", UPSTREAM_SYNC_TIMEOUT_MS: "1",
      MAX_STRIKES: "1", COOLDOWN_RATE_LIMIT_MS: "1", COOLDOWN_PAYMENT_MS: "1", COOLDOWN_STRIKE_MS: "1",
      POOL_CACHE_TTL_MS: "1", POOL_TOUCH_INTERVAL_MS: "1",
    }).sort();
    expect(all).toEqual([
      "agnesBaseUrl", "cooldownPaymentMs", "cooldownRateLimitMs", "cooldownStrikeMs",
      "gatewayToken", "maxStrikes", "poolCacheTtlMs", "poolTouchIntervalMs",
      "upstreamSyncTimeoutMs", "upstreamTimeoutMs",
    ]);
  });
});
