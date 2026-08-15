import { createApp } from "../../src/http/app.js";
import { KeyPoolRepo } from "../../src/core/dispatcher.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { MemoryStorage } from "./fake-storage.js";
import { FakeFetcher } from "./fake-fetcher.js";
import type { GatewayConfig } from "../../src/core/config.js";

export const TEST_CONFIG: GatewayConfig = {
  gatewayToken: "t", agnesBaseUrl: "https://upstream.test/v1",
  upstreamTimeoutMs: 8000, upstreamSyncTimeoutMs: 120_000, maxStrikes: 3,
  cooldownRateLimitMs: 60_000, cooldownPaymentMs: 3_600_000, cooldownStrikeMs: 1_800_000,
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
  const repo = new KeyPoolRepo(new MemoryStorage());
  for (const k of keys) await repo.add(k);
  const fetcher = new FakeFetcher(outcomes);
  const storageHealth = createStorageHealth();
  const config = { ...TEST_CONFIG, ...configOverride };
  const app = createApp({ version: "0.1.0", config, repo, fetcher, now, storageHealth });
  return { app, fetcher, repo, storageHealth };
}
