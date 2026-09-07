import { WORKER_ROUND_BUDGET_MS } from "./types.js";
import { NULL_LOGGER, type Logger } from "../../ports/logger.js";
import type { ConfigError } from "../config-errors.js";

export type Channel = "yyds" | "moemail";

export interface ChannelCreds {
  baseUrl: string;
  apiKey: string;
}

export interface RegistrarConfig {
  enabled: boolean;
  /**
   * 两条邮箱通道完全平级，没有内置默认值：`enabled=false` 时它可能没有真实取值
   * （下面的 `resolveChannel()` 解析结果为 `null`），但接口按启用状态下的合法形状声明为
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
  /**
   * **本次装载判定这份注册机配置跑不起来** ⇒ 补池与两条注册机端点一律早退。
   *
   * 它是**装载的产物**，不是旋钮（与 `GatewayConfig.degraded` 同一性质，因此同样
   * 不进 `EDITABLE`、进 `tests/unit/admin/config-validate.test.ts` 里那份手写的
   * 「刻意只读」清单）。逐条理由**不在这里**——数组字段会撞上 `FIELD_EXPOSURE`
   * 那个已登记的盲点（`config-provenance.ts` 的 `ExposureMap` 说明里那条
   * 「数组也满足 extends object，会被当成对象递归」），理由住在
   * `ConfigProvenance.registrarBlocked`。
   *
   * ⚠️ **`blocked` 为真时 `enabled` 一个字都不改。** 「运维明明打开了，面板却说
   * 未启用」是另一种撒谎，本仓刚为同形态连修过两轮。真话是「已启用 · 本次没跑起来」。
   *
   * ⚠️ **它可以在 `enabled=false` 时为真**：`delay_min_gt_max` 那一条不受 `enabled`
   * 门控（与 `crossFieldErrors` 逐字一致）。消费方一律**先判 `enabled` 再判 `blocked`**，
   * 面板文案同理——关着的注册机该说「未启用」，不是「没跑起来」。
   */
  blocked: boolean;
}

/**
 * 一次装载的产物：**生效配置 + 这份注册机为什么没跑起来**。
 *
 * ⚠️ **本模块从此模块级零 `throw`**（唯一豁免是消费方护栏 `requirePrimary`，
 * 见它自己的说明），由 `tests/unit/source-guards.test.ts` 的
 * 「`src/core/registrar/` 下的 throw 恰好等于手写豁免清单」钉着。
 * 理由：注册机是**可选子系统**，它缺凭据不该让转发、`/health`、面板一起死。
 * 这条在 Worker 形态上尤其要命——那里没有「启动」这回事，`buildApp` 每个 isolate
 * 懒执行，抛错的结果是「部署成功、每个请求 500、真原因只在 `wrangler tail`」。
 */
export interface RegistrarLoad {
  config: RegistrarConfig;
  /** 空数组 = 这份注册机配置跑得起来。非空 = 注册机本次不启动，逐条说明为什么。 */
  blockers: readonly ConfigError[];
}

/**
 * 注册机的内置默认值。
 *
 * **导出是因为 `src/core/admin/config-validate.ts` 的 `crossFieldErrors` 也要用**
 *（它比的是 `mintDelayMin/Max` 的**生效值**，而生效值的第三级就是这里）。
 * 抄第二份的后果是「面板拦不拦得住」与「装载器产不产 blocker」在默认值那一档
 * 可以给出不同答案——而那两边本来就是刻意保留的两份实现，共用常量是把可漂的面
 * 缩到最小，不是把两份实现合成一份。
 */
export const DEFAULTS = {
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
 *
 * 取值必须是不小于 1 的整数：0 或负数会让下游的间隔/次数类字段失去意义
 *（例如 `mintBatch=0` 会让补池永远补不出 key），所以只校验 `Number.isFinite` 不够。
 *
 * ⚠️⚠️ **非法值两侧都降级，不抛错——这是本轮改动里唯一一处主动放弃的 fail-fast。**
 * 从前 env 侧与存储侧都是抛：`TARGET_KEYS=abc` 在 Node 上让容器起不来（运维立刻
 * 看得见），在 Worker 上则是**部署成功、每个请求 500、原因只在 `wrangler tail`**。
 * 现在两侧一律回落默认值 + 一条 `config.invalid` + `flags.degraded = true`。
 * **它与 `config-provenance.ts` 的 `num()` 对 env 的策略故意不一致**，理由与「别来
 * 抹平」的告诫写在 `num()` 那段注释旁边（有没有安全的降能模式）。
 *
 * ⚠️ **不产出 blocker**：字段回落之后注册机照样跑得起来，这与 `num()` 的既有策略一致。
 * 代价明写：Node 运维**不能再靠「容器崩了」发现部署笔误**，只能靠面板红横幅与事件。
 *
 * ⚠️ 事件名取 `config.invalid` 而不是 `registrar.*`，与 `num()` 同一个名字——面板与
 * 五语言文档里「字段级降级」这件事只有一条事件名。代价是它拿不到 `ConsoleLogger`
 * 的 `[registrar]` 前缀（前缀按事件名命名空间派生），`fields.field` 里的
 * `registrar.` 路径前缀是这条日志里唯一的归属线索。
 */
function posInt(
  env: Env,
  envName: string,
  field: string,
  stored: unknown,
  fallback: number,
  logger: Logger,
  flags?: { degraded: boolean },
): number {
  const raw = env[envName];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
    degrade(logger, flags, field, "env", raw, fallback);
    return fallback;
  }
  if (stored === undefined || stored === null) return fallback;
  if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 1) {
    degrade(logger, flags, field, "stored", String(stored), fallback);
    return fallback;
  }
  return stored;
}

function degrade(
  logger: Logger,
  flags: { degraded: boolean } | undefined,
  field: string,
  source: "env" | "stored",
  raw: string,
  fallback: number,
): void {
  logger.log({
    level: "warn", event: "config.invalid",
    msg: "注册机的配置值非法，本字段回落到默认值（注册机照常运行）",
    fields: { field, source, raw, fallback },
  });
  if (flags) flags.degraded = true;
}

/**
 * 一个通道值的解析结果。
 *
 * `invalid` 说的是「有人写了一个值，而它既不是 `yyds` 也不是 `moemail`」——
 * 它与 `value === null` **不是同一件事**：后者还包括「压根没选」。
 * 两者的处置不同（`not_a_channel` vs `primary_required`），文案也不同。
 */
interface ChannelPick {
  value: Channel | null;
  invalid: "env" | "stored" | null;
}

/**
 * 解析一个通道字段，优先级：环境变量 > 存储 > 不选。
 *
 * ⚠️⚠️ **env 键存在但值非法时，不再回落到存储值。**
 * 从前这里是两个函数（`channel()` / `storedChannel()`）各带一个 `strict` 参数，
 * 由调用点写成 `channel(...) ?? storedChannel(...)`；`strict` 随着装载器全函数化
 * 一起消失之后，那个 `??` 会让 `REGISTRAR_PRIMARY=yydss` **静默穿透**成存储里
 * 那条通道——运维写错一个字母，网关拿另一条通道去跑，一句话都不说。
 * **这是本轮改动会引入的新缺陷，在这里堵死**：env 侧非法 ⇒ 直接判 `invalid: "env"`，
 * 不看存储。
 *
 * **「缺席」的判据两侧同源**：`undefined` / `null` / 空串都算没写。env 侧的空串
 *（`REGISTRAR_PRIMARY=`）因此会继续往存储看，与 `config-validate.ts` 的
 * `crossFieldErrors` 逐字同一条规则——两边由那格双向等价用例钉着。
 */
function resolveChannel(
  envRaw: string | undefined,
  storedRaw: unknown,
  envName: string,
  field: string,
  logger: Logger,
): ChannelPick {
  if (envRaw !== undefined && envRaw !== "") {
    if (envRaw === "yyds" || envRaw === "moemail") return { value: envRaw, invalid: null };
    logger.log({
      level: "warn", event: "registrar.config_ignored",
      msg: "忽略格式非法的通道值（只能是 yyds 或 moemail）",
      fields: { source: "env", name: envName, raw: envRaw },
    });
    return { value: null, invalid: "env" };
  }
  if (storedRaw === undefined || storedRaw === null || storedRaw === "") {
    return { value: null, invalid: null };
  }
  if (storedRaw === "yyds" || storedRaw === "moemail") return { value: storedRaw, invalid: null };
  logger.log({
    level: "warn", event: "registrar.config_ignored",
    msg: "忽略存储中格式非法的通道值（只能是 yyds 或 moemail）",
    fields: { source: "stored", name: field, raw: String(storedRaw) },
  });
  return { value: null, invalid: "stored" };
}

/** 只收非空字符串，别的（含数字 / 对象 / 空串）一律 `undefined`——存储里什么形状都可能来。 */
function asNonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * 一条通道的凭据。**缺什么就产出哪一条 blocker，不抛、也不发明取值。**
 *
 * ⚠️⚠️ **这里原来写着「启用时才校验凭据：关着的注册机不该因为没配 key 而让整个网关
 * 起不来」。那句话只落实了一半**——「关着」那一半是真的，而「开着但缺凭据」照样
 * 让整个网关起不来（三处 `throw`）。本轮把另一半补齐：**装载器不再有校验决定权，
 * 它只产出 blocker，启不启动由消费方 gate**（`buildTendDeps` 与两条注册机端点）。
 *
 * `field` 与 `code` 与 `config-validate.ts` 的 `crossFieldErrors` 逐字对齐
 *（`registrar.moemail.baseUrl` / `registrar.<ch>.apiKey` + `channel_credentials_missing`），
 * 两边由那格双向等价用例钉着。
 */
function creds(
  env: Env,
  stored: Partial<RegistrarConfig>,
  ch: Channel,
  out: ConfigError[],
): ChannelCreds | null {
  if (ch === "yyds") {
    const apiKey = asNonEmpty(env.YYDS_API_KEY) ?? asNonEmpty(stored.yyds?.apiKey);
    if (apiKey === undefined) {
      out.push({ field: "registrar.yyds.apiKey", code: "channel_credentials_missing", params: { channel: ch } });
      return null;
    }
    // YYDS 的 baseUrl 有内置取值、MoeMail 没有——这是两条通道之间**唯一**的不对称，
    // 而它是一句事实（一条是地址固定的公共服务，一条是自建服务），不是排名。
    return {
      baseUrl: asNonEmpty(env.YYDS_BASE_URL) ?? asNonEmpty(stored.yyds?.baseUrl) ?? DEFAULTS.yydsBaseUrl,
      apiKey,
    };
  }
  const baseUrl = asNonEmpty(env.MOEMAIL_BASE_URL) ?? asNonEmpty(stored.moemail?.baseUrl);
  const apiKey = asNonEmpty(env.MOEMAIL_API_KEY) ?? asNonEmpty(stored.moemail?.apiKey);
  // MoeMail 是自建服务，没有公共默认地址，两项都必须显式提供。
  if (baseUrl === undefined) {
    out.push({ field: "registrar.moemail.baseUrl", code: "channel_credentials_missing", params: { channel: ch } });
  }
  if (apiKey === undefined) {
    out.push({ field: "registrar.moemail.apiKey", code: "channel_credentials_missing", params: { channel: ch } });
  }
  return baseUrl === undefined || apiKey === undefined ? null : { baseUrl, apiKey };
}

export function registrarFromEnv(
  env: Env,
  stored: Partial<RegistrarConfig>,
  logger: Logger = NULL_LOGGER,
  /**
   * 字段级降级要能被上层观测到（`GatewayConfig.degraded`）。与 `num()` 的 `flags`
   * 同一套语义：**用传入的标记打点，不要改成让调用方去解析日志**。
   * 可选：`configFromEnv` 从不传（它没有「存储」这个降级来源）。
   */
  flags?: { degraded: boolean },
): RegistrarLoad {
  const blockers: ConfigError[] = [];
  const enabled = (env.REGISTRAR_ENABLED ?? String(stored.enabled ?? false)) === "true";

  const primaryPick = resolveChannel(env.REGISTRAR_PRIMARY, stored.primary, "REGISTRAR_PRIMARY", "primary", logger);
  const fallbackPick = resolveChannel(env.REGISTRAR_FALLBACK, stored.fallback, "REGISTRAR_FALLBACK", "fallback", logger);
  const primary = primaryPick.value;
  const fallback = fallbackPick.value;

  // 通道相关的四条 blocker 全部受 `enabled` 门控：关着的注册机的脏配置一条都不该
  // 拦着谁——判据与 `crossFieldErrors` 同源（那边 `if (!enabled) return out;`）。
  if (enabled) {
    if (primaryPick.invalid !== null) {
      blockers.push({
        field: "registrar.primary", code: "not_a_channel",
        params: { raw: String(primaryPick.invalid === "env" ? env.REGISTRAR_PRIMARY : stored.primary) },
      });
    } else if (primary === null) {
      // **写成 `else if` 是有意的**：值写错了（`not_a_channel`）与压根没选
      // （`primary_required`）是两句不同的话，同时说出来只会让运维以为有两处要改。
      // `crossFieldErrors` 那边同一形状（`primary` 非空串就不报 `primary_required`）。
      blockers.push({ field: "registrar.primary", code: "primary_required" });
    }
    if (fallbackPick.invalid !== null) {
      blockers.push({
        field: "registrar.fallback", code: "not_a_channel",
        params: { raw: String(fallbackPick.invalid === "env" ? env.REGISTRAR_FALLBACK : stored.fallback) },
      });
    } else if (fallback !== null && fallback === primary) {
      blockers.push({
        field: "registrar.fallback", code: "fallback_equals_primary",
        params: { channel: fallback },
      });
    }
  }

  const cfg: RegistrarConfig = {
    enabled,
    // 未启用时 primary 可能仍是 null（尚未选择）；类型按"启用后的合法形状"声明为
    // 非空，消费方读取前必须先判断 enabled，见上面接口定义处的注释。
    primary: primary as Channel,
    fallback,
    targetKeys: posInt(env, "TARGET_KEYS", "registrar.targetKeys", stored.targetKeys, DEFAULTS.targetKeys, logger, flags),
    mintBatch: posInt(env, "MINT_BATCH", "registrar.mintBatch", stored.mintBatch, DEFAULTS.mintBatch, logger, flags),
    tendIntervalMs: posInt(env, "TEND_INTERVAL_MS", "registrar.tendIntervalMs", stored.tendIntervalMs, DEFAULTS.tendIntervalMs, logger, flags),
    codeTimeoutMs: posInt(env, "CODE_TIMEOUT_MS", "registrar.codeTimeoutMs", stored.codeTimeoutMs, DEFAULTS.codeTimeoutMs, logger, flags),
    mintDelayMinMs: posInt(env, "MINT_DELAY_MIN_MS", "registrar.mintDelayMinMs", stored.mintDelayMinMs, DEFAULTS.mintDelayMinMs, logger, flags),
    mintDelayMaxMs: posInt(env, "MINT_DELAY_MAX_MS", "registrar.mintDelayMaxMs", stored.mintDelayMaxMs, DEFAULTS.mintDelayMaxMs, logger, flags),
    maxDomainAttempts: posInt(env, "MAX_DOMAIN_ATTEMPTS", "registrar.maxDomainAttempts", stored.maxDomainAttempts, DEFAULTS.maxDomainAttempts, logger, flags),
    // 前缀不能省：容器编排层（compose/K8s）里 TOKEN_NAME 这种通用名字太容易与
    // 别的组件撞车，而撞上的后果是静默改掉铸出的 key 在 Agnes 后台的显示名。
    tokenName: env.REGISTRAR_TOKEN_NAME ?? stored.tokenName ?? DEFAULTS.tokenName,
    agnesPlatformUrl: env.AGNES_PLATFORM_URL ?? stored.agnesPlatformUrl ?? DEFAULTS.agnesPlatformUrl,
    yyds: null,
    moemail: null,
    blocked: false,
  };

  // **这一条刻意不受 `enabled` 门控**，与 `crossFieldErrors` 里那条逐字一致
  //（那边的注释已经登记了「不门控是有意的」）。它比较的是**生效值**，
  // 所以两个数各自都合法、只是搭配不成立时照样报得出来。
  if (cfg.mintDelayMinMs > cfg.mintDelayMaxMs) {
    blockers.push({
      field: "registrar.mintDelayMinMs", code: "delay_min_gt_max",
      params: { min: cfg.mintDelayMinMs, max: cfg.mintDelayMaxMs },
    });
  }

  // 单轮最坏耗时 ≈ mintBatch × codeTimeoutMs × 通道数（每次铸 key 最长要等满验证码
  // 超时；配了备通道时，「验证码超时」属于通道级失败会降级重试一次，于是同一个名额
  // 最坏要等两次超时——见 tender.ts 的 case "code_timeout"）。
  //
  // 它超过补池间隔时，轮次会重叠着跑——两个入口各有兜底（Node 的在途守卫、Worker
  // 的 KV 短锁）会把重叠的那次跳过，但被跳过的名额就白白浪费了，该调的是配置本身。
  // 与上面 MINT_DELAY_MIN/MAX 的交叉校验同一性质，区别是这里只 warn、连 blocker 都不产：
  // 数值各自都合法，只是搭配不划算，没到该让注册机停跑的程度。这条 warn 受 enabled 门控，
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
  // 只 warn 不产 blocker：Node/Docker 上**定时轮**没有平台墙钟上限，同一份配置在那边的
  // 定时轮上完全合法，让注册机停跑会打掉一个正当的 Node 部署。文案里点明形态差异。
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

  if (enabled) {
    // **去重**：`primary === fallback` 时（那本身已经产出 `fallback_equals_primary`）
    // 不该把同一条通道的缺凭据再报一遍。
    const chain = [...new Set([primary, fallback].filter((c): c is Channel => c !== null))];
    for (const ch of chain) {
      const got = creds(env, stored, ch, blockers);
      if (ch === "yyds") cfg.yyds = got;
      else cfg.moemail = got;
    }
  }

  // 一次收齐全部 blocker（不首条即停）：运维要的是「还差哪几格」，不是「先改这一格
  // 再来问下一格」——那正是本仓在 `validateConfigPatch` 的跨字段阶段裁过的形态。
  cfg.blocked = blockers.length > 0;
  return { config: cfg, blockers };
}

/**
 * `RegistrarConfig.primary` 的类型是非空 `Channel`，但 `enabled=false` 时运行时值
 * 其实是 `null`（靠构造处的 `as Channel` 断言压住，类型系统不会强制消费方先判断
 * `enabled`）。下游一旦裸读 `cfg.primary` 却忘了先判空，拿到的要么是 `undefined`
 * 引发的无上下文异常，要么是运行时 `null`。这个访问器把判断收敛到一处：调用方
 * 不必再自己记得先查 `enabled`。
 *
 * ⚠️⚠️ **它是本模块唯一的 `throw` 豁免项**（`tests/unit/source-guards.test.ts` 里那份
 * 手写豁免清单逐字写着 `requirePrimary`）。它不在装载路径上——装载器全函数化说的是
 * 「一份坏配置不该让网关起不来」，而这里是**消费方护栏**：走到这里还没有主通道，
 * 说明某个消费者跳过了 `enabled` / `blocked` 两道 gate，那是代码 bug，必须响。
 */
export function requirePrimary(cfg: RegistrarConfig): Channel {
  if (!cfg.enabled || !cfg.primary) {
    throw new Error("注册机未启用或未配置邮箱通道");
  }
  return cfg.primary;
}
