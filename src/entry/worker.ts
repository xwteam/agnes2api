import { createApp } from "../http/app.js";
import { VERSION } from "../version.js";

export default {
  async fetch(req: Request, env: Record<string, string | undefined>): Promise<Response> {
    const gatewayToken = env.GATEWAY_TOKEN;
    if (!gatewayToken) {
      return new Response("缺少 GATEWAY_TOKEN，网关无法启动", { status: 500 });
    }

    const app = createApp({
      version: VERSION,
      config: {
        gatewayToken,
        agnesBaseUrl: env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1",
        upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS ? Number(env.UPSTREAM_TIMEOUT_MS) : 8000,
        maxStrikes: env.MAX_STRIKES ? Number(env.MAX_STRIKES) : 3,
        cooldownRateLimitMs: env.COOLDOWN_RATE_LIMIT_MS ? Number(env.COOLDOWN_RATE_LIMIT_MS) : 60_000,
        cooldownPaymentMs: env.COOLDOWN_PAYMENT_MS ? Number(env.COOLDOWN_PAYMENT_MS) : 3_600_000,
        logLevel: env.LOG_LEVEL ?? "info",
      },
    });

    return app.fetch(req);
  },
};
