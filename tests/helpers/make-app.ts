import { createApp } from "../../src/http/app.js";
import { fixedConfigHolder } from "../../src/http/config-holder.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { MemoryStorage } from "./fake-storage.js";
import { FakeFetcher } from "./fake-fetcher.js";
import type { GatewayConfig } from "../../src/core/config.js";
import { registrarFromEnv } from "../../src/core/registrar/config.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

export const TEST_CONFIG: GatewayConfig = {
  gatewayToken: "t", agnesBaseUrl: "https://upstream.test/v1",
  upstreamTimeoutMs: 8000, upstreamSyncTimeoutMs: 120_000, maxStrikes: 3,
  cooldownRateLimitMs: 60_000, cooldownPaymentMs: 3_600_000, cooldownStrikeMs: 1_800_000,
  // **夹具默认关掉快照缓存与写消除**：既有的几百条用例没有一条是为「有缓存」写的
  // （它们直接改存储再断言 all()、或者数 put 次数），开着缓存会把其中一批变成
  // 「测的是缓存而不是它自己那条不变量」的假阳性。两者本身由
  // tests/unit/pool-cache.test.ts 与 tests/contract/freshness.test.ts 专门覆盖。
  poolCacheTtlMs: 0, poolTouchIntervalMs: 0,
  // 注册机默认关闭，测试夹具无需凭据。
  registrar: registrarFromEnv({}, {}),
};

/**
 * `now` 默认是固定的 1000，好让断言能写死 `cooldownUntil` 这类绝对时刻。
 * 需要「时间真的在走」的用例（同步档的跨 key 整体 deadline）传 `() => Date.now()`。
 */
export async function makeApp(
  outcomes: ConstructorParameters<typeof FakeFetcher>[0] = [],
  keys = ["k1"],
  configOverride: Partial<GatewayConfig> = {},
  now: () => number = () => 1000,
) {
  const config = { ...TEST_CONFIG, ...configOverride };
  // 与 wire.ts 同一条接线：两个旋钮从配置来，而不是各写各的默认值。
  // 不这么接的话 TEST_CONFIG 里那两个 0 是**死字段**，夹具以为关了缓存其实开着。
  const repo = new KeyPoolRepo(new MemoryStorage(), {
    now, logger: NULL_LOGGER,
    cacheTtlMs: config.poolCacheTtlMs,
    touchIntervalMs: config.poolTouchIntervalMs,
  });
  for (const k of keys) await repo.add(k);
  const fetcher = new FakeFetcher(outcomes);
  const storageHealth = createStorageHealth();
  const app = createApp({
    version: "0.1.0",
    configHolder: fixedConfigHolder(config),
    repo, fetcher, now, storageHealth,
    logger: NULL_LOGGER,
  });
  return { app, fetcher, repo, storageHealth };
}
