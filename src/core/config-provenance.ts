import type { Storage } from "../ports/storage.js";
import { NULL_LOGGER, type Logger } from "../ports/logger.js";
import type { GatewayConfig } from "./config.js";
import { registrarFromEnv, type RegistrarConfig } from "./registrar/config.js";
// 从 KeyPoolRepo 借默认值而不是在这里再抄一遍两个魔数：抄一遍就有两个真源，
// 而「面板上写的生效时间」与「实际行为」对不上正是本期最不能出的那类问题。
import {
  DEFAULT_POOL_CACHE_TTL_MS, DEFAULT_POOL_TOUCH_INTERVAL_MS,
} from "./keypool-repo.js";

/**
 * 配置的**来源推导**：一次装载同时给出「生效值」与「每个字段的值是从哪来的」。
 *
 * ── 为什么这份逻辑必须住在这里，而不是 handler 里（设计 §5.3 逐字）─────────────
 *
 * 设计文档写的是「数据源是新增的 `loadConfigWithProvenance(env, storage)`，
 * `loadConfig` **退化成它的薄封装**」，并且**不允许在面板层另写一套来源推导
 * ——那必然与 `loadConfig` 漂移**。
 *
 * 漂移的形态很具体：优先级是 `env > 存储 > 内置默认值`，而 `num()` 里还有一条
 * 「存储值非法 ⇒ 字段级降级回默认值」的分支。面板层照着「有 env 就显示 env，
 * 否则显示存储」推一遍，在那条降级分支上就会说假话——面板显示存储里那个非法值
 * 是「生效值」，而网关实际在用默认值。**两份实现之间的差恰好落在最需要面板说实话
 * 的那一格上。**
 *
 * ⇒ 本文件是**唯一**一处「谁压过谁」的实现。`src/core/config.ts` 的 `loadConfig`
 * 只是丢掉 `source` 的一层薄封装，`src/http/admin/handlers/config.ts` 直接消费
 * `source`，一个字的优先级判断都不再写第二遍。
 *
 * ── 零 IO ──────────────────────────────────────────────────────────────────
 *
 * 本文件在 `src/core/` 下，受 `tests/unit/source-guards.test.ts` 的
 * 「扫描到的使用点恰好等于手写的豁免清单」管着：时间 / 随机 / 定时 / 网络 / 环境
 * 一律不许直接用。`storage` 与 `logger` 都是注入的端口，`env` 是一份**数据**
 * （调用方从各自运行时取好再传进来），三者都不违反那条约束。
 */

/**
 * 面板可改的那份配置在存储里的键。**整个仓库只有这一把配置键，值是一个对象。**
 *
 * ⚠️ **提成常量是 P3e Task 30 做的，之前它在两个文件里是裸字面量 `"config"`**
 * （本文件的 `loadConfigWithProvenance`，以及 `src/http/admin/handlers/config.ts` 的
 * 读 / 写 / 回读几处）。提它的直接理由是：设计文档
 * `docs/design/2026-08-15-agnes2api-p3-admin-panel-design.md` 的
 * 「重置到底重置了什么」那张表由**按名字扫源码**的一格钉着，
 * 而裸字面量在那一格里是**扫不到**的——「差一个」这种状态最容易被人改数字糊过去。
 *
 * ⚠️ **别把「唯一一把配置键」读成「重置它就等于恢复出厂」**：本文件的优先级是
 * `env > 存储 > 内置默认`，env 锁定的字段**根本不来自这把键**，删掉它对那些字段的
 * 生效值一个比特都不动。逐字段的后果写在那一节的那张表里。
 */
export const CONFIG_KEY = "config";

/** 一个叶子字段是「可以四元组明示」还是「只能报 `{ configured, hint }`」。 */
export type Exposure = "public" | "secret";

/**
 * 每个字段的曝光度。**叶子标 `Exposure`、对象字段递归给一张子表**，
 * 每一层都是 `Record<keyof …, …>`
 * ⇒ **`GatewayConfig` / `RegistrarConfig` / `ChannelCreds` 任何一层加字段，
 * `FIELD_EXPOSURE` 不补一格就编译不过。**
 *
 * `Required<T>` 是必需的：可选字段（如 `degraded?`）同样要表态——一个可选的密钥
 * 仍然是密钥。`NonNullable<T[K]>` 处理 `yyds: ChannelCreds | null` 这类联合。
 *
 * ⚠️ **一条已知边界**：数组类型也满足 `extends object`，会被当成「对象字段」递归。
 * `GatewayConfig` 今天没有数组字段；**将来加了要在这里补一条分支**——这句话本身
 * 没有护栏，登记为已知盲点（`tests/unit/config-provenance.test.ts` 的
 * 「已知盲点：数组字段会被当成对象递归 —— 边界是断言不是散文」把它写成了一格
 * 会变红的断言）。
 */
type ExposureMap<T> = {
  [K in keyof Required<T>]:
    NonNullable<Required<T>[K]> extends object
      ? ExposureMap<NonNullable<Required<T>[K]>>
      : Exposure;
};

/**
 * **哪些字段是凭据，这张表说了算。标错一格 = 明文出网。**
 *
 * 它和 `loadConfigWithProvenance` 放在同一个文件里，就是为了让这个决定发生在
 * 最该集中注意力的那一刻：`loadConfigWithProvenance` 本身是**泛型**的，对每个
 * 叶子一视同仁地产出四元组；没有这张表，「哪些字段是凭据」就只是一份隐式的
 * 手写名单，而唯一的护栏会是一条**夹具驱动**的用例——明天有人加
 * `moemail.adminToken` / S3 备份凭据，它会**自动**流进 `effective`，
 * 而那条用例的夹具里没有它，**一条都不会红**。
 *
 * ⚠️ **这一招的边界，明写，不许被读成过头**：
 * **它保证「有人做了一个决定」，不保证「那个决定是对的」。**
 * 把一把新密钥标成 `"public"` 照样编译通过、照样泄漏。这与
 * `src/core/keypool-repo.ts` 的 `FIELD_ROLE` 的边界完全一样（逼人表态，不替人判断），
 * 本仓已经接受过这个取舍。能再往上抬的只有评审 ⇒ **「新增配置字段时确认
 * `FIELD_EXPOSURE` 那一格」是一条点名勾选的评审项。**
 * ⚠️ **不要用关键词启发式（`/token|key|secret/i`）去兜底**——那是一张手写词表，
 * 正是本仓已经登记为脆弱的那种判据。
 */
export const FIELD_EXPOSURE: ExposureMap<GatewayConfig> = {
  gatewayToken: "secret",
  agnesBaseUrl: "public",
  upstreamTimeoutMs: "public",
  upstreamSyncTimeoutMs: "public",
  maxStrikes: "public",
  cooldownRateLimitMs: "public",
  cooldownPaymentMs: "public",
  cooldownStrikeMs: "public",
  poolCacheTtlMs: "public",
  poolTouchIntervalMs: "public",
  degraded: "public",
  usageStatsEnabled: "public",
  registrar: {
    enabled: "public",
    primary: "public",
    fallback: "public",
    targetKeys: "public",
    mintBatch: "public",
    tendIntervalMs: "public",
    codeTimeoutMs: "public",
    mintDelayMinMs: "public",
    mintDelayMaxMs: "public",
    maxDomainAttempts: "public",
    tokenName: "public",
    // 见设计 §8.6：**不是凭据**（它是一个 URL），但它是**注册凭据的去向**——
    // 改成自己的服务器就能收走每次注册的邮箱 + 密码 + 验证码。所以它照常走四元组，
    // 但在面板上必须折进「高级」折叠区 + 红色警告 + 二次确认，不放主表单。
    // 那一半的落点在 `admin-ui/js/pure/settings.mjs` 的 `ADVANCED_FIELDS`。
    agnesPlatformUrl: "public",
    yyds: { baseUrl: "public", apiKey: "secret" },
    moemail: { baseUrl: "public", apiKey: "secret" },
  },
};

/**
 * 环境变量 → 面板字段路径。**这张表就是「哪些字段面板改了也不生效」的唯一依据。**
 *
 * `loadConfigWithProvenance` 的优先级是 env > 存储 > 默认值，而 env 在运行中不会变，
 * 所以「被锁定」这件事在装配时算一次就够，不必每请求重算。
 *
 * ⚠️ **注册机那 16 个名字是 P3c Task 7 补进来的。** 它们此前不在表里，注释写的理由是
 * 「面板要编辑它们是 P3c 的设置页，加进来会得到一份现在没人消费的清单」——
 * 那个前提在本任务失效了：设置页就是这一期做的，清单现在有消费者。
 * 少了它们的后果很具体：`docker-compose` 里写了 `TARGET_KEYS=30`，面板上那一格
 * 既不置灰也不说明，运维改成 20、保存成功、**生效值永远是 30，重启也不会好**
 * ——那正是设计 §5.3 开头点名的最高频形态。
 *
 * **这 16 个名字不是手抄的**：`tests/unit/config-provenance.test.ts` 的
 * 「四种配置的并集恰好是手写的这 16 个名字」用 Proxy 在
 * **四种配置**（关 / 开×yyds 主 / 开×moemail 主 / 开×双通道）下各追踪一次
 * 并取并集——单跑一种配置只摸得到 12 个，`creds()` 那 4 个会静默逃逸。
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
  // ⚠️ **这一条今天在 `EDITABLE` 里没有对应项，是本仓第一条这样的锁定项。**
  // 上面那段说的判据是「有没有消费者」，而它进表的理由**不是**那一条，别混着读：
  // 这个字段**存储里就能改**（优先级 env > 存储 > 默认值），不进表的话
  // `GET /admin/api/config` 会对它返回一份自相矛盾的四元组
  //（`stored: true` / `env: null` / `effective: false`）——**面板对这个字段撒谎，
  // 与今天有没有人读那一格无关**。判据见 `GatewayConfig.usageStatsEnabled` 的说明。
  USAGE_STATS_ENABLED: "usageStatsEnabled",
  // ── 注册机（`registrarFromEnv` 直接读的 12 个）────────────────────────────
  REGISTRAR_ENABLED: "registrar.enabled",
  REGISTRAR_PRIMARY: "registrar.primary",
  REGISTRAR_FALLBACK: "registrar.fallback",
  TARGET_KEYS: "registrar.targetKeys",
  MINT_BATCH: "registrar.mintBatch",
  TEND_INTERVAL_MS: "registrar.tendIntervalMs",
  CODE_TIMEOUT_MS: "registrar.codeTimeoutMs",
  MINT_DELAY_MIN_MS: "registrar.mintDelayMinMs",
  MINT_DELAY_MAX_MS: "registrar.mintDelayMaxMs",
  MAX_DOMAIN_ATTEMPTS: "registrar.maxDomainAttempts",
  REGISTRAR_TOKEN_NAME: "registrar.tokenName",
  AGNES_PLATFORM_URL: "registrar.agnesPlatformUrl",
  // ── 注册机（`creds()` 读的 4 个，**只在 enabled 且该通道在链上时才被调**）──
  YYDS_BASE_URL: "registrar.yyds.baseUrl",
  YYDS_API_KEY: "registrar.yyds.apiKey",
  MOEMAIL_BASE_URL: "registrar.moemail.baseUrl",
  MOEMAIL_API_KEY: "registrar.moemail.apiKey",
};

/** 字段路径 → 环境变量名。`ENV_LOCK_MAP` 的逆表，**由它派生，不另写一份**。 */
const ENV_OF_FIELD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ENV_LOCK_MAP).map(([envName, field]) => [field, envName]),
);

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

/**
 * 内置默认值。**导出是因为 `configFromEnv`（`src/core/config.ts`）也用它**——
 * 抄第二份的后果是「面板显示的默认值」与「网关实际回落到的默认值」可以不一样。
 */
export const DEFAULTS = {
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

export type Env = Record<string, string | undefined>;

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
export function num(
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

/**
 * 一个叶子字段的来源。
 *
 * **两个分支不是同一个东西的两种写法，是两种不同的产品决定**：
 * · `public` ⇒ 四元组 `{ stored, env, effective, lockedBy }`（设计 §5.3）；
 * · `secret` ⇒ **只**报 `{ configured, hint }`（设计 §8.6：凭据只写不读，永不返回明文）。
 *
 * ⚠️ **§10.4「每个字段四元组」与 §11 的 `fields: Record<path, {stored, env, effective,
 * lockedBy}>` 照字面实现，就是把 `gatewayToken` 的明文放进 `stored` 与 `effective`
 * 两个字段。** 设计 §8.1 花整节论证 `ADMIN_TOKEN` 绝不能等于 `GATEWAY_TOKEN`，
 * 全部理由是「不让管理面变成网关口令的 reveal 端点」——四元组照抄就是把那个端点
 * 自己造出来。凭据字段因此走这一支。
 */
export type FieldSource =
  | {
    exposure: "public";
    /** 存储里那个 `config` 键在这条路径上的**原始值**，没有窄化、没有默认值兜底。 */
    stored: unknown;
    /** 环境变量的**原始字符串**（`undefined` ⇒ `null`）。 */
    env: string | null;
    /** 本次装载真正在用的值。`null` 有两种来源，见 `loadConfigWithProvenance`。 */
    effective: unknown;
    /** `"env:<NAME>"` 或 `null`。非空 ⇒ 面板改了也不生效。 */
    lockedBy: string | null;
  }
  | {
    exposure: "secret";
    /** env 或存储里有没有一个非空值。**注意它读的是「存储原件」，不是生效模型**，见 §5.5。 */
    configured: boolean;
    /** 末 4 位。**短于 5 位时是 `null`**——给了就是给全，那就不叫 hint 了。 */
    hint: string | null;
    lockedBy: string | null;
  };

export interface ConfigProvenance {
  /** 生效配置，与 `loadConfig` 返回的**是同一个对象**（后者只是丢掉 `source`）。 */
  config: GatewayConfig;
  /**
   * 逐字段来源，键是面板路径（`maxStrikes` / `registrar.yyds.apiKey`）。
   *
   * **路径清单从 `FIELD_EXPOSURE` 走出来，不另写一份**：那张表加一格
   * （加不了字段就编译不过），这里就自动多一条，不存在「加了字段忘了加进四元组」。
   */
  source: Record<string, FieldSource>;
}

/** 存储里 `config` 键的原始形状。**一律 `unknown` + 逐字段窄化**（硬约束 8）。 */
type StoredShape = Record<string, unknown>;

function asObject(v: unknown): StoredShape | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as StoredShape) : null;
}

/** 按路径从存储原件里取值。取不到（含中途不是对象）一律 `undefined`。 */
function storedAt(root: StoredShape, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    const o = asObject(cur);
    if (o === null) return undefined;
    cur = o[seg];
  }
  return cur;
}

/** 按路径从生效配置里取值。中途遇到 `null`（例如注册机关着时的 `yyds`）就返回 `null`。 */
function effectiveAt(config: GatewayConfig, path: readonly string[]): unknown {
  let cur: unknown = config;
  for (const seg of path) {
    if (cur === null || cur === undefined) return null;
    const o = asObject(cur);
    if (o === null) return null;
    cur = o[seg];
  }
  return cur === undefined ? null : cur;
}

/**
 * 一把凭据的末 4 位。
 *
 * **短于 5 位一律 `null`**：`hint` 存在的意义是让运维认出「我配的是哪一把」，
 * 而对一把 4 位的口令，末 4 位就是全部——那不叫提示，那叫 reveal。
 */
function hintOf(secret: string): string | null {
  return secret.length > 4 ? secret.slice(-4) : null;
}

/**
 * 走一遍 `FIELD_EXPOSURE`，对每个叶子调一次 `visit`。
 *
 * 判「是不是叶子」的依据是**值是不是字符串**（`"public"` / `"secret"`），
 * 不是「路径深度」——后者要么写死层数、要么再手写一份清单，两条都会漂。
 */
function walkExposure(
  node: unknown,
  path: readonly string[],
  visit: (path: readonly string[], exposure: Exposure) => void,
): void {
  if (typeof node === "string") {
    visit(path, node as Exposure);
    return;
  }
  const o = asObject(node);
  if (o === null) return;
  for (const key of Object.keys(o)) walkExposure(o[key], [...path, key], visit);
}

/**
 * 装载配置，**并且把每个字段的来源一起交出来**。
 *
 * `loadConfig`（`src/core/config.ts`）是它的薄封装——**优先级判断只有这一份**。
 *
 * `opts.degradeOnUnreadable` 的语义与 `loadConfig` 上那段长注释逐字相同，
 * 不在这里复述：那段话讲的是**两个调用身份要相反的行为**，它的家在
 * `loadConfig` 的参数上，因为那才是两个调用方看得见的地方。
 */
export async function loadConfigWithProvenance(
  env: Env,
  storage: Storage,
  logger: Logger = NULL_LOGGER,
  opts: { degradeOnUnreadable?: boolean } = {},
): Promise<ConfigProvenance> {
  const degradeOnUnreadable = opts.degradeOnUnreadable ?? false;
  // 逃生口：存储里的 config 键被写坏到连降级都救不回来时，RESET_CONFIG=1 完全忽略它。
  // **只忽略不删**——删了用户就再也拿不回原值了。
  let storedRaw: unknown = {};
  let storageUnreadable = false;
  if (env.RESET_CONFIG !== "1") {
    try {
      storedRaw = (await storage.get<unknown>(CONFIG_KEY)) ?? {};
    } catch (err) {
      // 热路径（degradeOnUnreadable=false）：如实抛，交给 Refreshable.reload()
      // 的既有兜底（保留上一份合法快照）——见 loadConfig 里 degradeOnUnreadable 的说明。
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

  const stored = asObject(storedRaw) ?? {};
  const storedRegistrar = asObject(stored.registrar) ?? {};

  const gatewayToken = env.GATEWAY_TOKEN ?? asString(stored.gatewayToken);
  // 唯一保留 fatal 的一条：没有口令就无法鉴权，继续跑比停下来更危险。
  if (!gatewayToken) throw new Error("缺少 GATEWAY_TOKEN，网关无法启动");

  // 字段级降级也要计入 degraded：`num()` 走 config.invalid 分支时会往这里打标记。
  const flags = { degraded: storageUnreadable };

  const config: GatewayConfig = {
    gatewayToken,
    agnesBaseUrl: env.AGNES_BASE_URL ?? asString(stored.agnesBaseUrl) ?? DEFAULTS.agnesBaseUrl,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", "upstreamTimeoutMs", stored.upstreamTimeoutMs, DEFAULTS.upstreamTimeoutMs, logger, 1, flags),
    upstreamSyncTimeoutMs: num(env, "UPSTREAM_SYNC_TIMEOUT_MS", "upstreamSyncTimeoutMs", stored.upstreamSyncTimeoutMs, DEFAULTS.upstreamSyncTimeoutMs, logger, 1, flags),
    maxStrikes: num(env, "MAX_STRIKES", "maxStrikes", stored.maxStrikes, DEFAULTS.maxStrikes, logger, 1, flags),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", "cooldownRateLimitMs", stored.cooldownRateLimitMs, DEFAULTS.cooldownRateLimitMs, logger, 1, flags),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", "cooldownPaymentMs", stored.cooldownPaymentMs, DEFAULTS.cooldownPaymentMs, logger, 1, flags),
    cooldownStrikeMs: num(env, "COOLDOWN_STRIKE_MS", "cooldownStrikeMs", stored.cooldownStrikeMs, DEFAULTS.cooldownStrikeMs, logger, 1, flags),
    poolCacheTtlMs: num(env, "POOL_CACHE_TTL_MS", "poolCacheTtlMs", stored.poolCacheTtlMs, DEFAULTS.poolCacheTtlMs, logger, 0, flags),
    poolTouchIntervalMs: num(env, "POOL_TOUCH_INTERVAL_MS", "poolTouchIntervalMs", stored.poolTouchIntervalMs, DEFAULTS.poolTouchIntervalMs, logger, 0, flags),
    registrar: registrarFromEnv(env, storedRegistrar as Partial<RegistrarConfig>, logger),
    degraded: flags.degraded,
    // **优先级与判据都照抄 `registrarFromEnv` 里 `enabled` 那一行**
    //（`src/core/registrar/config.ts` 的 `const enabled = …=== "true"`）：
    // env 缺席才看存储，存储缺席才是 false。
    // ⚠️ **不走 `num()`，所以没有「存储值非法 ⇒ 字段级降级」这一支**：布尔没有非法值，
    // `String(非布尔) !== "true"` 一律落到 false，那正是「默认关」该有的失败方向
    //（全局约束 16：关是零成本，开才要花钱 ⇒ 读不懂的时候必须往关的方向倒）。
    usageStatsEnabled: (env.USAGE_STATS_ENABLED ?? String(stored.usageStatsEnabled ?? false)) === "true",
  };

  const source: Record<string, FieldSource> = {};
  walkExposure(FIELD_EXPOSURE, [], (path, exposure) => {
    const key = path.join(".");
    const envName = ENV_OF_FIELD[key];
    const envValue = envName === undefined ? undefined : env[envName];
    const lockedBy = envValue === undefined ? null : `env:${envName}`;
    if (exposure === "secret") {
      // ⚠️ **`configured` 读的是「存储原件 + env」，不是生效模型**（设计 §5.5）：
      // `registrarFromEnv` 的结尾是 `if (!enabled) return cfg;`，注册机关着时
      // `cfg.yyds` / `cfg.moemail` 恒为 `null`——照生效模型报的话，用户「先填凭据、
      // 后开开关」这个最自然的顺序下，面板会说「未配置」，逼他再填一遍。
      const raw = envValue ?? asString(storedAt(stored, path));
      source[key] = {
        exposure: "secret",
        configured: typeof raw === "string" && raw !== "",
        hint: typeof raw === "string" && raw !== "" ? hintOf(raw) : null,
        lockedBy,
      };
      return;
    }
    source[key] = {
      exposure: "public",
      stored: storedAt(stored, path),
      env: envValue ?? null,
      effective: effectiveAt(config, path),
      lockedBy,
    };
  });

  return { config, source };
}

/** 只收字符串，别的（含数字 / 对象）一律 `undefined`——存储里什么形状都可能来。 */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
