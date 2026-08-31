import { WORKER_ROUND_BUDGET_MS } from "./types.js";
import { NULL_LOGGER, type Logger } from "../../ports/logger.js";

export type Channel = "yyds" | "moemail";

export interface ChannelCreds {
  baseUrl: string;
  apiKey: string;
}

export interface RegistrarConfig {
  enabled: boolean;
  /**
   * 两条邮箱通道完全平级，没有内置默认值：`enabled=false` 时它可能没有真实取值
   * （下面的 `channel()` 解析结果为 `null`），但接口按启用状态下的合法形状声明为
   * 非空——消费方在读它之前必须先看 `enabled`，这与网关 `GatewayConfig` 的
   * `gatewayToken` 必填不是同一种情况：那里没有"关闭"这个中间态。
   */
  primary: Channel;
  fallback: Channel | null;
  targetKeys: number;
  mintBatch: number;
  tendIntervalMs: number;
  codeTimeoutMs: number;
  mintDelayMinMs: number;
  mintDelayMaxMs: number;
  maxDomainAttempts: number;
  tokenName: string;
  agnesPlatformUrl: string;
  yyds: ChannelCreds | null;
  moemail: ChannelCreds | null;
}

const DEFAULTS = {
  // primary 刻意没有默认值：两条通道平级，由使用者显式选择。给默认值等于替所有
  // 部署者做一个只在特定环境下成立的判断。
  targetKeys: 20,
  mintBatch: 5,
  tendIntervalMs: 1_800_000,
  codeTimeoutMs: 120_000,
  mintDelayMinMs: 2_000,
  mintDelayMaxMs: 5_000,
  maxDomainAttempts: 8,
  tokenName: "auto",
  agnesPlatformUrl: "https://platform-backend.agnes-ai.com",
  yydsBaseUrl: "https://maliapi.215.im",
} as const;

type Env = Record<string, string | undefined>;

/**
 * 读取一个正整数配置项，优先级：环境变量 > 存储 > 内置默认值。
 * 与 `src/core/config.ts` 里的 `num()` 同一套语义：只校验 `Number.isFinite` 不够，
 * 0 或负数会让下游的间隔/次数类字段失去意义（例如 `mintBatch=0` 会让补池永远
 * 补不出 key）。
 */
function posInt(env: Env, envName: string, field: string, stored: unknown, fallback: number): number {
  const raw = env[envName];
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`环境变量 ${envName} 必须是正整数: ${raw}`);
    return n;
  }
  if (stored === undefined) return fallback;
  if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 1) {
    throw new Error(`存储中的 ${field} 必须是正整数: ${String(stored)}`);
  }
  return stored;
}

/**
 * `strict=false`（注册机未启用）时格式非法只记一条 `registrar.config_ignored` 事件并
 * 当作未设置（`null`），不抛错：一个被显式关闭的子系统的脏配置不该让整个网关起不来。
 * `strict=true`（已启用）时维持原有的抛错行为，因为这时通道值真的要被使用。
 */
function channel(raw: string | undefined, envName: string, strict: boolean, logger: Logger): Channel | null {
  if (raw === undefined || raw === "") return null;
  if (raw !== "yyds" && raw !== "moemail") {
    const msg = `${envName} 只能是 yyds 或 moemail: ${raw}`;
    if (strict) throw new Error(msg);
    logger.log({
      level: "warn", event: "registrar.config_ignored",
      msg: "注册机未启用，忽略格式非法的通道值", fields: { source: "env", name: envName, raw },
    });
    return null;
  }
  return raw;
}

/**
 * 校验存储里的通道值。这是网关那一层留下的口径：数值型校验（`posInt`）本就同时覆盖 env 与存储两条
 * 路径，但通道这种枚举值如果只在 env 侧校验、存储侧直接透传，垃圾数据会绕过校验
 * 静默流入一个类型上声明为 `"yyds" | "moemail"` 的字段，后续按通道分支的代码
 * （例如"选哪个 MailProvider 适配器"）就会拿到既不匹配 yyds 也不匹配 moemail 的值。
 *
 * 同 `channel()`：`strict=false`（未启用）时只记事件不抛错，见上面注释。
 */
function storedChannel(raw: unknown, field: string, strict: boolean, logger: Logger): Channel | null {
  if (raw === undefined || raw === null) return null;
  if (raw !== "yyds" && raw !== "moemail") {
    const msg = `存储中的 ${field} 只能是 yyds 或 moemail: ${String(raw)}`;
    if (strict) throw new Error(msg);
    logger.log({
      level: "warn", event: "registrar.config_ignored",
      msg: "注册机未启用，忽略存储中格式非法的通道值", fields: { source: "stored", name: field, raw: String(raw) },
    });
    return null;
  }
  return raw;
}

/** 启用时才校验凭据：关着的注册机不该因为没配 key 而让整个网关起不来。 */
function creds(env: Env, stored: Partial<RegistrarConfig>, ch: Channel): ChannelCreds {
  if (ch === "yyds") {
    const apiKey = env.YYDS_API_KEY ?? stored.yyds?.apiKey ?? "";
    if (!apiKey) throw new Error("注册机已启用但缺少 YYDS_API_KEY");
    return { baseUrl: env.YYDS_BASE_URL ?? stored.yyds?.baseUrl ?? DEFAULTS.yydsBaseUrl, apiKey };
  }
  const baseUrl = env.MOEMAIL_BASE_URL ?? stored.moemail?.baseUrl ?? "";
  const apiKey = env.MOEMAIL_API_KEY ?? stored.moemail?.apiKey ?? "";
  // MoeMail 是自建服务，没有公共默认地址，两项都必须显式提供。
  if (!baseUrl) throw new Error("注册机已启用但缺少 MOEMAIL_BASE_URL");
  if (!apiKey) throw new Error("注册机已启用但缺少 MOEMAIL_API_KEY");
  return { baseUrl, apiKey };
}

export function registrarFromEnv(
  env: Env,
  stored: Partial<RegistrarConfig>,
  logger: Logger = NULL_LOGGER,
): RegistrarConfig {
  const enabled = (env.REGISTRAR_ENABLED ?? String(stored.enabled ?? false)) === "true";
  // 通道格式校验受 enabled 门控：未启用时脏数据只记事件，见 channel()/storedChannel() 注释。
  const primary = channel(env.REGISTRAR_PRIMARY, "REGISTRAR_PRIMARY", enabled, logger)
    ?? storedChannel(stored.primary, "primary", enabled, logger);
  const fallback = channel(env.REGISTRAR_FALLBACK, "REGISTRAR_FALLBACK", enabled, logger)
    ?? storedChannel(stored.fallback, "fallback", enabled, logger);

  if (enabled && !primary) {
    throw new Error("注册机已启用但未指定 REGISTRAR_PRIMARY（yyds 或 moemail，两者平级需显式选择）");
  }
  if (enabled && fallback && fallback === primary) {
    throw new Error("REGISTRAR_FALLBACK 与 REGISTRAR_PRIMARY 相同，降级到自己没有意义");
  }

  const cfg: RegistrarConfig = {
    enabled,
    // 未启用时 primary 可能仍是 null（尚未选择）；类型按"启用后的合法形状"声明为
    // 非空，消费方读取前必须先判断 enabled，见上面接口定义处的注释。
    primary: primary as Channel,
    fallback,
    targetKeys: posInt(env, "TARGET_KEYS", "targetKeys", stored.targetKeys, DEFAULTS.targetKeys),
    mintBatch: posInt(env, "MINT_BATCH", "mintBatch", stored.mintBatch, DEFAULTS.mintBatch),
    tendIntervalMs: posInt(env, "TEND_INTERVAL_MS", "tendIntervalMs", stored.tendIntervalMs, DEFAULTS.tendIntervalMs),
    codeTimeoutMs: posInt(env, "CODE_TIMEOUT_MS", "codeTimeoutMs", stored.codeTimeoutMs, DEFAULTS.codeTimeoutMs),
    mintDelayMinMs: posInt(env, "MINT_DELAY_MIN_MS", "mintDelayMinMs", stored.mintDelayMinMs, DEFAULTS.mintDelayMinMs),
    mintDelayMaxMs: posInt(env, "MINT_DELAY_MAX_MS", "mintDelayMaxMs", stored.mintDelayMaxMs, DEFAULTS.mintDelayMaxMs),
    maxDomainAttempts: posInt(env, "MAX_DOMAIN_ATTEMPTS", "maxDomainAttempts", stored.maxDomainAttempts, DEFAULTS.maxDomainAttempts),
    // 前缀不能省：容器编排层（compose/K8s）里 TOKEN_NAME 这种通用名字太容易与
    // 别的组件撞车，而撞上的后果是静默改掉铸出的 key 在 Agnes 后台的显示名。
    tokenName: env.REGISTRAR_TOKEN_NAME ?? stored.tokenName ?? DEFAULTS.tokenName,
    agnesPlatformUrl: env.AGNES_PLATFORM_URL ?? stored.agnesPlatformUrl ?? DEFAULTS.agnesPlatformUrl,
    yyds: null,
    moemail: null,
  };

  if (cfg.mintDelayMinMs > cfg.mintDelayMaxMs) {
    throw new Error(
      `MINT_DELAY_MIN_MS 不能大于 MINT_DELAY_MAX_MS: ${cfg.mintDelayMinMs} > ${cfg.mintDelayMaxMs}`,
    );
  }

  // 单轮最坏耗时 ≈ mintBatch × codeTimeoutMs × 通道数（每次铸 key 最长要等满验证码
  // 超时；配了备通道时，「验证码超时」属于通道级失败会降级重试一次，于是同一个名额
  // 最坏要等两次超时——见 tender.ts 的 case "code_timeout"）。
  //
  // 它超过补池间隔时，轮次会重叠着跑——两个入口各有兜底（Node 的在途守卫、Worker
  // 的 KV 短锁）会把重叠的那次跳过，但被跳过的名额就白白浪费了，该调的是配置本身。
  // 与上面 MINT_DELAY_MIN/MAX 的交叉校验同一性质，区别是这里只 warn 不抛错：数值
  // 各自都合法，只是搭配不划算，没到该拒绝启动的程度。这条 warn 受 enabled 门控，
  // 关着的注册机不会打。
  const chainLength = cfg.fallback ? 2 : 1;
  const worstRoundMs = cfg.mintBatch * cfg.codeTimeoutMs * chainLength;
  if (enabled && cfg.tendIntervalMs < worstRoundMs) {
    logger.log({
      level: "warn", event: "registrar.interval_shorter_than_worst_round",
      msg: "TEND_INTERVAL_MS 小于单轮最坏耗时 MINT_BATCH×CODE_TIMEOUT_MS×通道数，补池轮次可能重叠并被跳过",
      fields: { tendIntervalMs: cfg.tendIntervalMs, mintBatch: cfg.mintBatch, codeTimeoutMs: cfg.codeTimeoutMs, chainLength, worstRoundMs },
    });
  }

  // CODE_TIMEOUT_MS 没有上界（posInt 只管正整数），而 Worker 形态的轮级预算是个
  // 固定值。`codeTimeoutMs × 通道数` 一旦超过它，tendOnce 连**第一次**尝试都不敢
  // 开始：attempted=0、minted=0、failures 为空——两个入口的归因日志走的是
  // `minted < attempted`（0 < 0 为假）所以一条都不打，用户只看到「本轮墙钟预算
  // 不足」，读起来像瞬时状况，实际是永久停摆。启动期把它说破。
  //
  // 只 warn 不抛错：Node/Docker 上**定时轮**没有平台墙钟上限，同一份配置在那边的
  // 定时轮上完全合法，抛错会让一个正当的 Node 部署起不来。文案里点明形态差异。
  //
  // ⚠️ **末句的措辞是订正过的，别改回去。** 上一版写的是
  // 「Node/Docker 没有平台墙钟上限，不受此限制」——**面板那颗「立即补池」上线之后那句就不再准确**：
  // 面板的「立即补池」在**两种运行时上都**传同一份 `WORKER_ROUND_BUDGET_MS`
  //（见 `src/http/wire.ts` 的 `runManualTendRound`，那里写着理由：一次点击最多跑多久
  // 是这颗按钮自己的性质，不是运行时的性质）。于是同一份把 `CODE_TIMEOUT_MS` 调过头的
  // 配置，在 Node 上**定时轮照常铸、手动补池一把都铸不出来**，而运维照着旧措辞会以为
  // 自己这边完全不受影响。五语言 REGISTRAR.md 同一段也已一并订正。
  const worstAttemptMs = cfg.codeTimeoutMs * chainLength;
  if (enabled && worstAttemptMs > WORKER_ROUND_BUDGET_MS) {
    logger.log({
      level: "warn", event: "registrar.attempt_exceeds_worker_budget",
      msg: "CODE_TIMEOUT_MS×通道数超过 Worker 单轮墙钟预算：Cloudflare Worker 形态下补池会一把 key 都铸不出来"
        + "（每轮 attempted=0），请调小 CODE_TIMEOUT_MS 或去掉备通道。"
        + "Node/Docker 的定时轮没有平台墙钟上限、不受此限制，"
        + "但面板的「立即补池」在两种运行时上都带同一份轮级预算，Node/Docker 上同样铸不出来。",
      fields: {
        codeTimeoutMs: cfg.codeTimeoutMs, chainLength, worstAttemptMs,
        workerRoundBudgetMs: WORKER_ROUND_BUDGET_MS,
      },
    });
  }

  if (!enabled) return cfg;

  for (const ch of [primary, fallback].filter((c): c is Channel => c !== null)) {
    if (ch === "yyds") cfg.yyds = creds(env, stored, "yyds");
    else cfg.moemail = creds(env, stored, "moemail");
  }
  return cfg;
}

/**
 * `RegistrarConfig.primary` 的类型是非空 `Channel`，但 `enabled=false` 时运行时值
 * 其实是 `null`（靠构造处的 `as Channel` 断言压住，类型系统不会强制消费方先判断
 * `enabled`）。下游一旦裸读 `cfg.primary` 却忘了先判空，拿到的要么是 `undefined`
 * 引发的无上下文异常，要么是运行时 `null`。这个访问器把判断收敛到一处：调用方
 * 不必再自己记得先查 `enabled`。
 */
export function requirePrimary(cfg: RegistrarConfig): Channel {
  if (!cfg.enabled || !cfg.primary) {
    throw new Error("注册机未启用或未配置邮箱通道");
  }
  return cfg.primary;
}
