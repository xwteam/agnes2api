import type { Storage } from "../ports/storage.js";

export interface GatewayConfig {
  gatewayToken: string;
  agnesBaseUrl: string;
  upstreamTimeoutMs: number;
  maxStrikes: number;
  cooldownRateLimitMs: number;
  cooldownPaymentMs: number;
  logLevel: string;
}

const DEFAULTS = {
  agnesBaseUrl: "https://apihub.agnes-ai.com/v1",
  upstreamTimeoutMs: 8000,
  maxStrikes: 3,
  cooldownRateLimitMs: 60_000,
  cooldownPaymentMs: 3_600_000,
  logLevel: "info",
} as const;

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, stored: number | undefined, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return stored ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${name} 不是合法数值: ${raw}`);
  return n;
}

export async function loadConfig(env: Env, storage: Storage): Promise<GatewayConfig> {
  const stored = (await storage.get<Partial<GatewayConfig>>("config")) ?? {};

  const gatewayToken = env.GATEWAY_TOKEN ?? stored.gatewayToken;
  if (!gatewayToken) throw new Error("缺少 GATEWAY_TOKEN，网关无法启动");

  return {
    gatewayToken,
    agnesBaseUrl: env.AGNES_BASE_URL ?? stored.agnesBaseUrl ?? DEFAULTS.agnesBaseUrl,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", stored.upstreamTimeoutMs, DEFAULTS.upstreamTimeoutMs),
    maxStrikes: num(env, "MAX_STRIKES", stored.maxStrikes, DEFAULTS.maxStrikes),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", stored.cooldownRateLimitMs, DEFAULTS.cooldownRateLimitMs),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", stored.cooldownPaymentMs, DEFAULTS.cooldownPaymentMs),
    logLevel: env.LOG_LEVEL ?? stored.logLevel ?? DEFAULTS.logLevel,
  };
}
