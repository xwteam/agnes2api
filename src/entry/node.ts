import { serve } from "@hono/node-server";
import { createApp } from "../http/app.js";
import { VERSION } from "../version.js";

const gatewayToken = process.env.GATEWAY_TOKEN;
if (!gatewayToken) {
  console.error("缺少 GATEWAY_TOKEN，网关无法启动");
  process.exit(1);
}

const app = createApp({
  version: VERSION,
  config: {
    gatewayToken,
    agnesBaseUrl: process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1",
    upstreamTimeoutMs: process.env.UPSTREAM_TIMEOUT_MS ? Number(process.env.UPSTREAM_TIMEOUT_MS) : 8000,
    maxStrikes: process.env.MAX_STRIKES ? Number(process.env.MAX_STRIKES) : 3,
    cooldownRateLimitMs: process.env.COOLDOWN_RATE_LIMIT_MS ? Number(process.env.COOLDOWN_RATE_LIMIT_MS) : 60_000,
    cooldownPaymentMs: process.env.COOLDOWN_PAYMENT_MS ? Number(process.env.COOLDOWN_PAYMENT_MS) : 3_600_000,
    logLevel: process.env.LOG_LEVEL ?? "info",
  },
});
const port = Number(process.env.PORT ?? 8080);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`agnes2api listening on :${info.port}`);
});
