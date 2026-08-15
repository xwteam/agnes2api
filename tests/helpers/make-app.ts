import { createApp } from "../../src/http/app.js";
import { KeyPoolRepo } from "../../src/core/dispatcher.js";
import { MemoryStorage } from "./fake-storage.js";
import { FakeFetcher } from "./fake-fetcher.js";
import type { GatewayConfig } from "../../src/core/config.js";

export const TEST_CONFIG: GatewayConfig = {
  gatewayToken: "t", agnesBaseUrl: "https://upstream.test/v1",
  upstreamTimeoutMs: 8000, maxStrikes: 3,
  cooldownRateLimitMs: 60_000, cooldownPaymentMs: 3_600_000, cooldownStrikeMs: 1_800_000,
};

export async function makeApp(outcomes: ConstructorParameters<typeof FakeFetcher>[0] = [], keys = ["k1"]) {
  const repo = new KeyPoolRepo(new MemoryStorage());
  for (const k of keys) await repo.add(k);
  const fetcher = new FakeFetcher(outcomes);
  const app = createApp({ version: "0.1.0", config: TEST_CONFIG, repo, fetcher, now: () => 1000 });
  return { app, fetcher, repo };
}
