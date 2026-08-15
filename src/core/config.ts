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

function num(
  env: Env,
  envName: string,
  fieldName: string,
  stored: number | undefined,
  fallback: number,
): number {
  const raw = env[envName];
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`环境变量 ${envName} 不是合法数值: ${raw}`);
    return n;
  }

  if (stored !== undefined) {
    if (!Number.isFinite(stored)) {
      throw new Error(`存储中的 ${fieldName} 不是合法数值: ${stored}`);
    }
    return stored;
  }

  return fallback;
}

export function configFromEnv(env: Env): GatewayConfig {
  const gatewayToken = env.GATEWAY_TOKEN;
  if (!gatewayToken) throw new Error("缺少 GATEWAY_TOKEN，网关无法启动");

  return {
    gatewayToken,
    agnesBaseUrl: env.AGNES_BASE_URL ?? DEFAULTS.agnesBaseUrl,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", "upstreamTimeoutMs", undefined, DEFAULTS.upstreamTimeoutMs),
    maxStrikes: num(env, "MAX_STRIKES", "maxStrikes", undefined, DEFAULTS.maxStrikes),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", "cooldownRateLimitMs", undefined, DEFAULTS.cooldownRateLimitMs),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", "cooldownPaymentMs", undefined, DEFAULTS.cooldownPaymentMs),
    logLevel: env.LOG_LEVEL ?? DEFAULTS.logLevel,
  };
}

export async function loadConfig(env: Env, storage: Storage): Promise<GatewayConfig> {
  const stored = (await storage.get<Partial<GatewayConfig>>("config")) ?? {};

  const gatewayToken = env.GATEWAY_TOKEN ?? stored.gatewayToken;
  if (!gatewayToken) throw new Error("缺少 GATEWAY_TOKEN，网关无法启动");

  return {
    gatewayToken,
    agnesBaseUrl: env.AGNES_BASE_URL ?? stored.agnesBaseUrl ?? DEFAULTS.agnesBaseUrl,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", "upstreamTimeoutMs", stored.upstreamTimeoutMs, DEFAULTS.upstreamTimeoutMs),
    maxStrikes: num(env, "MAX_STRIKES", "maxStrikes", stored.maxStrikes, DEFAULTS.maxStrikes),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", "cooldownRateLimitMs", stored.cooldownRateLimitMs, DEFAULTS.cooldownRateLimitMs),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", "cooldownPaymentMs", stored.cooldownPaymentMs, DEFAULTS.cooldownPaymentMs),
    logLevel: env.LOG_LEVEL ?? stored.logLevel ?? DEFAULTS.logLevel,
  };
}
