import type { Storage } from "../ports/storage.js";
import { registrarFromEnv, type RegistrarConfig } from "./registrar/config.js";
import { NULL_LOGGER, type Logger } from "../ports/logger.js";
// 从 KeyPoolRepo 借默认值而不是在这里再抄一遍两个魔数：抄一遍就有两个真源，
// 而「面板上写的生效时间」与「实际行为」对不上正是本期最不能出的那类问题。
import {
  DEFAULT_POOL_CACHE_TTL_MS, DEFAULT_POOL_TOUCH_INTERVAL_MS,
} from "./keypool-repo.js";

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
  /**
   * 见 `KeyPoolRepoOptions.cacheTtlMs`。**0 = 关闭缓存。**
   *
   * **建 app 时读一次**，不是逐次生效：它绑定的是部署形态（活跃 isolate 数 ×
   * 池大小），不是逐次可调的策略。改它要重启容器 / 等 isolate 回收，
   * `.env.example` 与五语言 DEPLOY.md 都写明了这一点，面板文案不许写「立即生效」。
   */
  poolCacheTtlMs: number;
  /** 见 `KeyPoolRepoOptions.touchIntervalMs`。0 = 关闭写消除。生效时机同上。 */
  poolTouchIntervalMs: number;
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
  poolCacheTtlMs: DEFAULT_POOL_CACHE_TTL_MS,
  poolTouchIntervalMs: DEFAULT_POOL_TOUCH_INTERVAL_MS,
} as const;

type Env = Record<string, string | undefined>;

/**
 * 读取一个数值配置项，优先级：环境变量 > 存储 > 内置默认值。
 *
 * 这里的每一项都是「时长（毫秒）」或「次数」，取值必须是不小于 `min`（默认 1）
 * 的整数：`UPSTREAM_TIMEOUT_MS=-1` 会让 setTimeout 立刻触发，一个请求就能把整池
 * 打成 strike；`MAX_STRIKES=0` 更糟——`strikes >= maxStrikes` 在第一次失败时即成立
 * （`1 >= 0`），等于跳过了整个容错机制。故只校验 Number.isFinite 是不够的。
 *
 * 两个池子旋钮显式传 `min = 0`：对它们来说 0 不是越界值而是「关闭」，见 min 的说明。
 */
function num(
  env: Env,
  envName: string,
  fieldName: string,
  stored: unknown,
  fallback: number,
  logger: Logger,
  /**
   * 允许的最小值。**默认 1**——`UPSTREAM_TIMEOUT_MS=-1` 会让 setTimeout 立刻触发，
   * `MAX_STRIKES=0` 更糟（`1 >= 0` 在第一次失败时即成立，等于跳过整个容错机制）。
   * 只有 `poolCacheTtlMs` / `poolTouchIntervalMs` 传 0：对它们来说 0 是「关闭」
   * 这个有意义的取值，是用户的逃生口。
   */
  min = 1,
): number {
  const raw = env[envName];
  if (raw !== undefined) {
    const n = Number(raw);
    // **环境变量的非法值继续 fail-fast**：那是部署时错误，运维必须立刻看得见，
    // 而且它不可能是面板写坏的——面板永远碰不到环境变量。
    if (!isIntAtLeast(n, min)) {
      throw new Error(`环境变量 ${envName} 必须是不小于 ${min} 的整数: ${raw}`);
    }
    return n;
  }

  if (stored !== undefined && stored !== null) {
    if (!isIntAtLeast(stored, min)) {
      // **存储的非法值改为字段级降级**（设计文档 §5.4 第 2 条）。
      // 抛错的后果是 Node 侧 process.exit(1) 进入重启循环，而且**没有面板可以进去改回来**；
      // Worker 侧则是全部转发流量挂掉。一次误操作把网关砖掉是不可接受的。
      logger.log({
        level: "warn", event: "config.invalid",
        msg: "存储中的配置值非法，本字段回落到默认值",
        fields: { field: fieldName, source: "stored", raw: String(stored), fallback },
      });
      return fallback;
    }
    return stored;
  }

  return fallback;
}

function isIntAtLeast(n: unknown, min: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= min;
}

export function configFromEnv(env: Env, logger: Logger = NULL_LOGGER): GatewayConfig {
  const gatewayToken = env.GATEWAY_TOKEN;
  if (!gatewayToken) throw new Error("缺少 GATEWAY_TOKEN，网关无法启动");

  return {
    gatewayToken,
    agnesBaseUrl: env.AGNES_BASE_URL ?? DEFAULTS.agnesBaseUrl,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", "upstreamTimeoutMs", undefined, DEFAULTS.upstreamTimeoutMs, logger),
    upstreamSyncTimeoutMs: num(env, "UPSTREAM_SYNC_TIMEOUT_MS", "upstreamSyncTimeoutMs", undefined, DEFAULTS.upstreamSyncTimeoutMs, logger),
    maxStrikes: num(env, "MAX_STRIKES", "maxStrikes", undefined, DEFAULTS.maxStrikes, logger),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", "cooldownRateLimitMs", undefined, DEFAULTS.cooldownRateLimitMs, logger),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", "cooldownPaymentMs", undefined, DEFAULTS.cooldownPaymentMs, logger),
    cooldownStrikeMs: num(env, "COOLDOWN_STRIKE_MS", "cooldownStrikeMs", undefined, DEFAULTS.cooldownStrikeMs, logger),
    poolCacheTtlMs: num(env, "POOL_CACHE_TTL_MS", "poolCacheTtlMs", undefined, DEFAULTS.poolCacheTtlMs, logger, 0),
    poolTouchIntervalMs: num(env, "POOL_TOUCH_INTERVAL_MS", "poolTouchIntervalMs", undefined, DEFAULTS.poolTouchIntervalMs, logger, 0),
    registrar: registrarFromEnv(env, {}, logger),
  };
}

export async function loadConfig(env: Env, storage: Storage, logger: Logger = NULL_LOGGER): Promise<GatewayConfig> {
  // 逃生口：存储里的 config 键被写坏到连降级都救不回来时（例如 registrar 那侧仍会抛错），
  // 用 RESET_CONFIG=1 启动即可完全忽略它。**只忽略不删**——删了用户就再也拿不回原值了。
  const stored = env.RESET_CONFIG === "1"
    ? {}
    : ((await storage.get<Partial<GatewayConfig>>("config")) ?? {});

  const gatewayToken = env.GATEWAY_TOKEN ?? stored.gatewayToken;
  // 唯一保留 fatal 的一条：没有口令就无法鉴权，继续跑比停下来更危险。
  if (!gatewayToken) throw new Error("缺少 GATEWAY_TOKEN，网关无法启动");

  return {
    gatewayToken,
    agnesBaseUrl: env.AGNES_BASE_URL ?? stored.agnesBaseUrl ?? DEFAULTS.agnesBaseUrl,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", "upstreamTimeoutMs", stored.upstreamTimeoutMs, DEFAULTS.upstreamTimeoutMs, logger),
    upstreamSyncTimeoutMs: num(env, "UPSTREAM_SYNC_TIMEOUT_MS", "upstreamSyncTimeoutMs", stored.upstreamSyncTimeoutMs, DEFAULTS.upstreamSyncTimeoutMs, logger),
    maxStrikes: num(env, "MAX_STRIKES", "maxStrikes", stored.maxStrikes, DEFAULTS.maxStrikes, logger),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", "cooldownRateLimitMs", stored.cooldownRateLimitMs, DEFAULTS.cooldownRateLimitMs, logger),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", "cooldownPaymentMs", stored.cooldownPaymentMs, DEFAULTS.cooldownPaymentMs, logger),
    cooldownStrikeMs: num(env, "COOLDOWN_STRIKE_MS", "cooldownStrikeMs", stored.cooldownStrikeMs, DEFAULTS.cooldownStrikeMs, logger),
    poolCacheTtlMs: num(env, "POOL_CACHE_TTL_MS", "poolCacheTtlMs", stored.poolCacheTtlMs, DEFAULTS.poolCacheTtlMs, logger, 0),
    poolTouchIntervalMs: num(env, "POOL_TOUCH_INTERVAL_MS", "poolTouchIntervalMs", stored.poolTouchIntervalMs, DEFAULTS.poolTouchIntervalMs, logger, 0),
    registrar: registrarFromEnv(env, stored.registrar ?? {}, logger),
  };
}
