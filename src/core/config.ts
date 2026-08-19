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
  /**
   * 本次装载有没有降级（存储的 config 键读不出来 / 某些字段回落了默认值）。
   * **写这句时还没有消费者**：将来 `GET /admin/api/overview`（P3b 的概览板块）
   * 会直接把它交给面板，顶部渲染红色横幅——「保存了却没生效」是这个项目最高频
   * 的用户困惑，不让它可见就等于让面板撒谎。在那条路径接上之前，这里只是把
   * 信号立起来，全仓还没有任何代码读它（见 tests/unit/source-guards.test.ts
   * 之类的门禁不会因为这一点变红，这只是老实交代当前状态，不是缺陷）。
   */
  degraded: boolean;
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
  /**
   * 字段级降级要能被上层观测到（`GatewayConfig.degraded`）。**用传入的标记打点，
   * 不要改成让调用方去解析日志**——那是把可观测性建在文案上，日志措辞一改就断。
   * 可选：`configFromEnv` 从不传，因为它没有「存储」这个降级来源，恒为 false。
   */
  flags?: { degraded: boolean },
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
      if (flags) flags.degraded = true;
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
    // 恒为 false：这条路径没有「存储」这个降级来源，纯 env + 内置默认值不存在
    // 「保存了却没生效」这种可能，没有什么好提示的。
    degraded: false,
  };
}

export async function loadConfig(
  env: Env,
  storage: Storage,
  logger: Logger = NULL_LOGGER,
  opts: {
    /**
     * 存储读不出来时要不要降级到 env + 默认值。**默认 false（严格：如实抛）。**
     *
     * `loadConfig` 有**两个**调用身份，而它们要的是相反的行为：
     * ① `ConfigHolder` 的 `Refreshable.load`——热实例每 `CONFIG_TTL_MS` 就会
     *    调一次。这条路径上 `Refreshable.reload()` 本来就有**严格更好**的兜底：
     *    抛错时原样保留上一份合法快照（见 refreshable.ts）。若这里自己把
     *    「读不出来」吞成「降级」，热路径上一次瞬时读抖动就会把面板保存的配置
     *    **静默**换成内置默认值——而且免费档读桶按 UTC 天重置，这不是几十秒
     *    的抖动，是剩下的一整天（评审实测复现：`maxStrikes` 9→3、
     *    `cooldownStrikeMs` 7,777,000→1,800,000、`registrar.enabled` true→false，
     *    补池被静默关掉）。**这条路径必须传 false（或不传），让异常原样冒给
     *    `Refreshable.reload()` 处理**，不许在这里截胡。
     * ② `createConfigHolder` 的 `prime()`（冷启动）与两个入口各自的
     *    `buildTendDeps`——这里没有「上一份合法快照」可退，抛出去的后果是
     *    Worker 冷 isolate 全部 500 / Node 重启循环，而 GATEWAY_TOKEN 通常就在
     *    环境变量里，存储那份只是覆盖层，读不出来不该让整个网关起不来。
     *    **只有这条路径才该传 true。**
     */
    degradeOnUnreadable?: boolean;
  } = {},
): Promise<GatewayConfig> {
  const degradeOnUnreadable = opts.degradeOnUnreadable ?? false;
  // 逃生口：存储里的 config 键被写坏到连降级都救不回来时，RESET_CONFIG=1 完全忽略它。
  // **只忽略不删**——删了用户就再也拿不回原值了。
  let stored: Partial<GatewayConfig> = {};
  let storageUnreadable = false;
  if (env.RESET_CONFIG !== "1") {
    try {
      stored = (await storage.get<Partial<GatewayConfig>>("config")) ?? {};
    } catch (err) {
      // 热路径（degradeOnUnreadable=false）：如实抛，交给 Refreshable.reload()
      // 的既有兜底（保留上一份合法快照）——见上面 degradeOnUnreadable 的说明。
      if (!degradeOnUnreadable) throw err;
      // 只有冷启动这条路径才走到这里：**读不出来 ⇒ 降级到 env + 默认值，
      // 不是让网关起不来。** 与 §5.4「存储非法值字段级降级」同一条原则：
      // 存储**读不出来**比存储值非法更轻，不该得到更重的处置。
      // 唯一保留 fatal 的仍然是「两边都没有 gatewayToken」，见下。
      storageUnreadable = true;
      logger.log({
        level: "error", event: "config.storage_unreadable",
        msg: "读取存储中的 config 键失败，本次装载只用环境变量与内置默认值（面板里保存的配置本次不生效）",
        fields: { err: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const gatewayToken = env.GATEWAY_TOKEN ?? stored.gatewayToken;
  // 唯一保留 fatal 的一条：没有口令就无法鉴权，继续跑比停下来更危险。
  if (!gatewayToken) throw new Error("缺少 GATEWAY_TOKEN，网关无法启动");

  // 字段级降级也要计入 degraded：`num()` 走 config.invalid 分支时会往这里打标记。
  const flags = { degraded: storageUnreadable };

  return {
    gatewayToken,
    agnesBaseUrl: env.AGNES_BASE_URL ?? stored.agnesBaseUrl ?? DEFAULTS.agnesBaseUrl,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", "upstreamTimeoutMs", stored.upstreamTimeoutMs, DEFAULTS.upstreamTimeoutMs, logger, 1, flags),
    upstreamSyncTimeoutMs: num(env, "UPSTREAM_SYNC_TIMEOUT_MS", "upstreamSyncTimeoutMs", stored.upstreamSyncTimeoutMs, DEFAULTS.upstreamSyncTimeoutMs, logger, 1, flags),
    maxStrikes: num(env, "MAX_STRIKES", "maxStrikes", stored.maxStrikes, DEFAULTS.maxStrikes, logger, 1, flags),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", "cooldownRateLimitMs", stored.cooldownRateLimitMs, DEFAULTS.cooldownRateLimitMs, logger, 1, flags),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", "cooldownPaymentMs", stored.cooldownPaymentMs, DEFAULTS.cooldownPaymentMs, logger, 1, flags),
    cooldownStrikeMs: num(env, "COOLDOWN_STRIKE_MS", "cooldownStrikeMs", stored.cooldownStrikeMs, DEFAULTS.cooldownStrikeMs, logger, 1, flags),
    poolCacheTtlMs: num(env, "POOL_CACHE_TTL_MS", "poolCacheTtlMs", stored.poolCacheTtlMs, DEFAULTS.poolCacheTtlMs, logger, 0, flags),
    poolTouchIntervalMs: num(env, "POOL_TOUCH_INTERVAL_MS", "poolTouchIntervalMs", stored.poolTouchIntervalMs, DEFAULTS.poolTouchIntervalMs, logger, 0, flags),
    registrar: registrarFromEnv(env, stored.registrar ?? {}, logger),
    degraded: flags.degraded,
  };
}

/**
 * 环境变量 → 面板字段路径。**这张表就是「哪些字段面板改了也不生效」的唯一依据。**
 *
 * `loadConfig` 的优先级是 env > 存储 > 默认值，而 env 在运行中不会变，
 * 所以「被锁定」这件事在装配时算一次就够，不必每请求重算。
 *
 * ⚠️ 注册机那一族（`REGISTRAR_*`）**不在这里**：它们由 `registrarFromEnv` 处理，
 * 面板要编辑它们是 P3c 的设置页。加进来会得到一份现在没人消费、将来没人记得更新的清单。
 */
const ENV_LOCK_MAP: Readonly<Record<string, string>> = {
  GATEWAY_TOKEN: "gatewayToken",
  AGNES_BASE_URL: "agnesBaseUrl",
  UPSTREAM_TIMEOUT_MS: "upstreamTimeoutMs",
  UPSTREAM_SYNC_TIMEOUT_MS: "upstreamSyncTimeoutMs",
  MAX_STRIKES: "maxStrikes",
  COOLDOWN_RATE_LIMIT_MS: "cooldownRateLimitMs",
  COOLDOWN_PAYMENT_MS: "cooldownPaymentMs",
  COOLDOWN_STRIKE_MS: "cooldownStrikeMs",
  POOL_CACHE_TTL_MS: "poolCacheTtlMs",
  POOL_TOUCH_INTERVAL_MS: "poolTouchIntervalMs",
};

/**
 * 哪些字段被环境变量锁住了。
 * **判据是「这个键在 env 里存在」，不是「值合法」**：`MAX_STRIKES=` 这种空串同样会走进
 * `num()` 的 env 分支（然后抛错），面板必须显示它是锁定的，否则用户会一直改存储、一直没效果。
 */
export function envLockedFields(env: Record<string, string | undefined>): string[] {
  return Object.entries(ENV_LOCK_MAP)
    .filter(([k]) => env[k] !== undefined)
    .map(([, field]) => field);
}
