import { describe, it, expect } from "vitest";
import { createApp } from "../../src/http/app.js";
import type { GatewayConfig } from "../../src/core/config.js";

const CONFIG: GatewayConfig = {
  gatewayToken: "test-token",
  agnesBaseUrl: "https://apihub.agnes-ai.com/v1",
  upstreamTimeoutMs: 8000,
  maxStrikes: 3,
  cooldownRateLimitMs: 60_000,
  cooldownPaymentMs: 3_600_000,
  logLevel: "info",
};

describe("GET /health", () => {
  it("返回 200 与版本号，且不需要鉴权", async () => {
    const app = createApp({ version: "0.1.0", config: CONFIG });
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "0.1.0" });
  });

  it("/health 不受鉴权影响", async () => {
    const app = createApp({ version: "0.1.0", config: { ...CONFIG, gatewayToken: "secret" } });
    expect((await app.request("/health")).status).toBe(200);
  });
});
