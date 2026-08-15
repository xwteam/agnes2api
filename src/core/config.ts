import type { Storage } from "../ports/storage.js";
import { registrarFromEnv, type RegistrarConfig } from "./registrar/config.js";

export interface GatewayConfig {
  gatewayToken: string;
  agnesBaseUrl: string;
  upstreamTimeoutMs: number;
  /**
   * 同步端点（图片生成、视频建任务）的上游超时。
   *
   * 与 `upstreamTimeoutMs` 分开是因为两者度量的**根本不是同一件事**：流式对话的首字节
   * 只代表「上游开始说话」，8 秒足够；而同步端点的首字节要等整张图渲染完才到达——实测
   * 直连上游 `/images/generations` 首字节耗时 11.99 秒（HTTP 200）。用 8 秒去卡它的结果
   * 是图片生成 100% 失败，且每次请求会把池中每把 key 各记一次 strike，三次请求就能把
   * 整个池子打进 30 分钟长冷却，连对话一起拖死。
   */
  upstreamSyncTimeoutMs: number;
  maxStrikes: number;
  cooldownRateLimitMs: number;
  cooldownPaymentMs: number;
  cooldownStrikeMs: number;
  registrar: RegistrarConfig;
}

const DEFAULTS = {
  agnesBaseUrl: "https://apihub.agnes-ai.com/v1",
  upstreamTimeoutMs: 8000,
  // 实测图片生成约 12 秒；留出「慢 key 比快 key 慢 3~4 倍」（§7.3 同一批实测）的余量，
  // 取 2 分钟。它只在同步端点上生效，不影响对话的快速甩慢 key。
  upstreamSyncTimeoutMs: 120_000,
  maxStrikes: 3,
  cooldownRateLimitMs: 60_000,
  cooldownPaymentMs: 3_600_000,
  cooldownStrikeMs: 1_800_000,
} as const;

type Env = Record<string, string | undefined>;

/**
 * 读取一个数值配置项，优先级：环境变量 > 存储 > 内置默认值。
 *
 * 这里的每一项都是「时长（毫秒）」或「次数」，取值必须是正整数：
 * `UPSTREAM_TIMEOUT_MS=-1` 会让 setTimeout 立刻触发，一个请求就能把整池打成
 * strike；`MAX_STRIKES=0` 更糟——`strikes >= maxStrikes` 在第一次失败时即成立
 * （`1 >= 0`），等于跳过了整个容错机制。故只校验 Number.isFinite 是不够的。
 */
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
    if (!isPositiveInt(n)) throw new Error(`环境变量 ${envName} 必须是正整数: ${raw}`);
    return n;
  }

  if (stored !== undefined) {
    if (!isPositiveInt(stored)) {
      throw new Error(`存储中的 ${fieldName} 必须是正整数: ${stored}`);
    }
    return stored;
  }

  return fallback;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

export function configFromEnv(env: Env): GatewayConfig {
  const gatewayToken = env.GATEWAY_TOKEN;
  if (!gatewayToken) throw new Error("缺少 GATEWAY_TOKEN，网关无法启动");

  return {
    gatewayToken,
    agnesBaseUrl: env.AGNES_BASE_URL ?? DEFAULTS.agnesBaseUrl,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", "upstreamTimeoutMs", undefined, DEFAULTS.upstreamTimeoutMs),
    upstreamSyncTimeoutMs: num(env, "UPSTREAM_SYNC_TIMEOUT_MS", "upstreamSyncTimeoutMs", undefined, DEFAULTS.upstreamSyncTimeoutMs),
    maxStrikes: num(env, "MAX_STRIKES", "maxStrikes", undefined, DEFAULTS.maxStrikes),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", "cooldownRateLimitMs", undefined, DEFAULTS.cooldownRateLimitMs),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", "cooldownPaymentMs", undefined, DEFAULTS.cooldownPaymentMs),
    cooldownStrikeMs: num(env, "COOLDOWN_STRIKE_MS", "cooldownStrikeMs", undefined, DEFAULTS.cooldownStrikeMs),
    registrar: registrarFromEnv(env, {}),
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
    upstreamSyncTimeoutMs: num(env, "UPSTREAM_SYNC_TIMEOUT_MS", "upstreamSyncTimeoutMs", stored.upstreamSyncTimeoutMs, DEFAULTS.upstreamSyncTimeoutMs),
    maxStrikes: num(env, "MAX_STRIKES", "maxStrikes", stored.maxStrikes, DEFAULTS.maxStrikes),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", "cooldownRateLimitMs", stored.cooldownRateLimitMs, DEFAULTS.cooldownRateLimitMs),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", "cooldownPaymentMs", stored.cooldownPaymentMs, DEFAULTS.cooldownPaymentMs),
    cooldownStrikeMs: num(env, "COOLDOWN_STRIKE_MS", "cooldownStrikeMs", stored.cooldownStrikeMs, DEFAULTS.cooldownStrikeMs),
    registrar: registrarFromEnv(env, stored.registrar ?? {}),
  };
}
