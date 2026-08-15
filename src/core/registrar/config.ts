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
   * 非空——消费方在读它之前必须先看 `enabled`，这与 P1 `GatewayConfig` 的
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
 * 与 P1 `config.ts` 里的 `num()` 同一套语义：只校验 `Number.isFinite` 不够，
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
 * `strict=false`（注册机未启用）时格式非法只 `console.warn` 并当作未设置（`null`），
 * 不抛错：一个被显式关闭的子系统的脏配置不该让整个网关起不来。`strict=true`
 * （已启用）时维持原有的抛错行为，因为这时通道值真的要被使用。
 */
function channel(raw: string | undefined, envName: string, strict: boolean): Channel | null {
  if (raw === undefined || raw === "") return null;
  if (raw !== "yyds" && raw !== "moemail") {
    const msg = `${envName} 只能是 yyds 或 moemail: ${raw}`;
    if (strict) throw new Error(msg);
    console.warn(`[agnes2api] 注册机未启用，忽略格式非法的 ${envName}: ${raw}`);
    return null;
  }
  return raw;
}

/**
 * 校验存储里的通道值。P1 遗留：数值型校验（`posInt`）本就同时覆盖 env 与存储两条
 * 路径，但通道这种枚举值如果只在 env 侧校验、存储侧直接透传，垃圾数据会绕过校验
 * 静默流入一个类型上声明为 `"yyds" | "moemail"` 的字段，后续按通道分支的代码
 * （例如"选哪个 MailProvider 适配器"）就会拿到既不匹配 yyds 也不匹配 moemail 的值。
 *
 * 同 `channel()`：`strict=false`（未启用）时只 warn 不抛错，见上面注释。
 */
function storedChannel(raw: unknown, field: string, strict: boolean): Channel | null {
  if (raw === undefined || raw === null) return null;
  if (raw !== "yyds" && raw !== "moemail") {
    const msg = `存储中的 ${field} 只能是 yyds 或 moemail: ${String(raw)}`;
    if (strict) throw new Error(msg);
    console.warn(`[agnes2api] 注册机未启用，忽略存储中格式非法的 ${field}: ${String(raw)}`);
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

export function registrarFromEnv(env: Env, stored: Partial<RegistrarConfig>): RegistrarConfig {
  const enabled = (env.REGISTRAR_ENABLED ?? String(stored.enabled ?? false)) === "true";
  // 通道格式校验受 enabled 门控：未启用时脏数据只 warn，见 channel()/storedChannel() 注释。
  const primary = channel(env.REGISTRAR_PRIMARY, "REGISTRAR_PRIMARY", enabled)
    ?? storedChannel(stored.primary, "primary", enabled);
  const fallback = channel(env.REGISTRAR_FALLBACK, "REGISTRAR_FALLBACK", enabled)
    ?? storedChannel(stored.fallback, "fallback", enabled);

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
    tokenName: env.TOKEN_NAME ?? stored.tokenName ?? DEFAULTS.tokenName,
    agnesPlatformUrl: env.AGNES_PLATFORM_URL ?? stored.agnesPlatformUrl ?? DEFAULTS.agnesPlatformUrl,
    yyds: null,
    moemail: null,
  };

  if (cfg.mintDelayMinMs > cfg.mintDelayMaxMs) {
    throw new Error(
      `MINT_DELAY_MIN_MS 不能大于 MINT_DELAY_MAX_MS: ${cfg.mintDelayMinMs} > ${cfg.mintDelayMaxMs}`,
    );
  }

  // 单轮最坏耗时 ≈ mintBatch × codeTimeoutMs（每次铸 key 最长要等满验证码超时）。
  // 它超过补池间隔时，轮次会重叠着跑——两个入口各有兜底（Node 的在途守卫、Worker
  // 的 KV 短锁）会把重叠的那次跳过，但被跳过的名额就白白浪费了，该调的是配置本身。
  // 与上面 MINT_DELAY_MIN/MAX 的交叉校验同一性质，区别是这里只 warn 不抛错：数值
  // 各自都合法，只是搭配不划算，没到该拒绝启动的程度。
  if (enabled && cfg.tendIntervalMs < cfg.mintBatch * cfg.codeTimeoutMs) {
    console.warn(
      `[agnes2api] TEND_INTERVAL_MS(${cfg.tendIntervalMs}) 小于单轮最坏耗时 ` +
        `MINT_BATCH×CODE_TIMEOUT_MS(${cfg.mintBatch * cfg.codeTimeoutMs})，补池轮次可能重叠并被跳过`,
    );
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
