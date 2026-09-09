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
   * **注册机用的那一条邮箱通道。两条通道是二选一，没有主备、没有自动降级。**
   *
   * 两条通道完全平级，没有内置默认值：`enabled=false` 时它可能没有真实取值
   * （下面的通道解析结果为 `null`），但接口按启用状态下的合法形状声明为
   * 非空——消费方在读它之前必须先看 `enabled`，这与网关 `GatewayConfig` 的
   * `gatewayToken` 必填不是同一种情况：那里没有"关闭"这个中间态。
   *
   * ⚠️ **它此前叫 `primary`，旁边还有一个 `fallback`。** 改名不是换措辞：只要类型、
   * 存储键、补丁路径、错误码里还留着「主」这个字，内部就还是主备，界面上把第二个
   * 下拉藏起来只是又一个谎。存量存储里那两个旧键由 `migrateStoredRegistrar()`
   * 读一次、说一次、然后在下一次保存时清掉。
   */
  channel: Channel;
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
 * ⚠️ **本模块从此模块级零 `throw`**（唯一豁免是消费方护栏 `requireChannel`，
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
  /**
   * **不拦人，但必须说出来的那几句话。** 今天只有一族：存量存储/环境变量里那两个
   * 旧的主备键还在，本次是怎么读它们的、丢掉了什么。
   *
   * ⚠️ **它与 `blockers` 是两个集合，不许合并**：blocker 的意思是「注册机本次不启动」，
   * 而这几条恰恰配着「注册机照常跑」。混进 blockers 会让一台跑得好好的部署因为
   * 一个已经没意义的旧键被拦停——那是拿正确性换洁癖。
   *
   * ⚠️ **它是状态，不是事件。** 走 `GET /admin/api/config`（零写）带出去、面板渲染成
   * 常驻横幅。做成事件的两条硬理由各自单独成立：① 装载器每 30 秒刷一次 ⇒ 每 isolate
   * 每天约 2880 次装载，而事件环只有 100 格，它会在运维升级完来查问题的那一刻把
   * 诊断挤出去；② 补池每轮都重新装载一次，装载期的无条件 warn 会把「健康的一轮零事件
   * 零写」变成「每轮至少一条事件 ⇒ 跨过刷新窗后每轮一次 put」，五语言 DEPLOY.md 的
   * 写配额账要跟着改。走 GET 是零写，那本账一个字都不用动。
   */
  notices: readonly ConfigError[];
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
  // channel 刻意没有默认值：两条通道平级，由使用者二选一。给默认值等于替所有
  // 部署者做一个只在特定环境下成立的判断。
  targetKeys: 20,
  mintBatch: 5,
  tendIntervalMs: 1_800_000,
  codeTimeoutMs: 120_000,
  /**
   * 🟢 **实测下界**：≥60 秒间隔时同一出口连续四次发码全部成功，第七次才撞上应用层
   * 限流；无间隔连发时第三次就被上游前置的边缘限流挡下。60 秒是量出来的那个下界。
   *
   * ⚠️ **这个数是观测不是承诺**：它来自单一出口、单日样本，换出口或换时段可能完全
   * 不同。所以它留在可配那一侧（`MINT_DELAY_MIN_MS`）。
   */
  mintDelayMinMs: 60_000,
  /**
   * 🟡 **不是实测，是抖动上界。** 依据是本仓自己的部署形态：Worker 多 isolate、
   * 多副本 Docker 共卷都可能同时起轮，固定 60 秒会把它们锁成同一个节拍。
   */
  mintDelayMaxMs: 90_000,
  /**
   * 🟢 **实测 + 推导**：有了域名台账之后，一个名额里的**第二个**域名期望收益为负
   *（多烧一格限流预算，而暖机后成功率提升趋近 0）；而「一个名额里连打好几次」正是
   * 实测中触发边缘限流的那个形态。
   *
   * ⚠️ **域名轮换没有消失，只是搬了地方**：从「一个名额之内连打」搬到「两个名额之间」，
   * 而那里本来就有 `mintDelayMinMs`~`mintDelayMaxMs` 的间隔。
   */
  maxDomainAttempts: 1,
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
 * 两者的处置不同（`not_a_channel` vs `channel_required`），文案也不同。
 *
 * `raw` 是**判死那一层**的原值，`not_a_channel` 的 `params.raw` 直接用它——
 * 候选来源有四级之后，调用点没法再自己猜是哪一级写错了。
 */
interface ChannelPick {
  value: Channel | null;
  invalid: "env" | "stored" | null;
  raw: unknown;
  /** 这一层是不是旧键/旧变量名。`null` = 走的是正式名字，没有什么要说的。 */
  legacy: "env" | "stored" | null;
}

/** 一个候选来源。**顺序即优先级**，本层判死就不往下穿透。 */
interface ChannelCandidate {
  raw: unknown;
  source: "env" | "stored";
  /** 报错时点名的那个名字：env 侧是变量名，存储侧是字段路径。 */
  name: string;
  legacy: boolean;
}

function isChannelValue(v: unknown): v is Channel {
  return v === "yyds" || v === "moemail";
}

/**
 * 解析通道字段，候选四级：
 * `REGISTRAR_CHANNEL` > `REGISTRAR_PRIMARY`（兼容别名） >
 * `registrar.channel` > `registrar.primary`（兼容读） > 不选。
 *
 * ⚠️⚠️ **某一级存在但值非法时，不再往下穿透。**
 * 从前这里是两个函数（`channel()` / `storedChannel()`）各带一个 `strict` 参数，
 * 由调用点写成 `channel(...) ?? storedChannel(...)`；`strict` 随着装载器全函数化
 * 一起消失之后，那个 `??` 会让 `REGISTRAR_CHANNEL=yydss` **静默穿透**成别名或存储里
 * 那条通道——运维写错一个字母，网关拿另一条通道去跑，一句话都不说。
 * **候选从 2 个变成 4 个之后这条纪律一个字都不能松**：四级之间同样是「本级判死就
 * 到此为止」，否则新名字写错会静默落到旧名字上，正是这段注释当初要堵的洞。
 *
 * **「缺席」的判据四级同源**：`undefined` / `null` / 空串都算没写。env 侧的空串
 *（`REGISTRAR_CHANNEL=`，compose 里极常见）因此会继续往下看，与
 * `config-validate.ts` 的 `crossFieldErrors` 逐字同一条规则——两边由那格双向等价
 * 用例钉着。
 */
function resolveChannel(env: Env, stored: Partial<RegistrarConfig>, logger: Logger): ChannelPick {
  const legacyStored = (stored as Record<string, unknown>).primary;
  const candidates: ChannelCandidate[] = [
    { raw: env.REGISTRAR_CHANNEL, source: "env", name: "REGISTRAR_CHANNEL", legacy: false },
    { raw: env.REGISTRAR_PRIMARY, source: "env", name: "REGISTRAR_PRIMARY", legacy: true },
    { raw: stored.channel, source: "stored", name: "channel", legacy: false },
    { raw: legacyStored, source: "stored", name: "primary", legacy: true },
  ];
  for (const c of candidates) {
    if (c.raw === undefined || c.raw === null || c.raw === "") continue;
    if (isChannelValue(c.raw)) {
      return { value: c.raw, invalid: null, raw: c.raw, legacy: c.legacy ? c.source : null };
    }
    logger.log({
      level: "warn", event: "registrar.config_ignored",
      msg: c.source === "env"
        ? "忽略格式非法的通道值（只能是 yyds 或 moemail）"
        : "忽略存储中格式非法的通道值（只能是 yyds 或 moemail）",
      fields: { source: c.source, name: c.name, raw: String(c.raw) },
    });
    return { value: null, invalid: c.source, raw: c.raw, legacy: null };
  }
  return { value: null, invalid: null, raw: null, legacy: null };
}

/** 存储里那份注册机配置的原始形状。旧键照旧可能在，一律 `unknown` + 逐字段窄化。 */
type StoredRegistrar = Record<string, unknown>;

/**
 * **存量存储里那两个旧的主备键：怎么读、怎么说、怎么消失。唯一真源。**
 *
 * 读路径（`registrarFromEnv`）拿 `notices`，写路径（`validateConfigPatch` 保存前
 * 规整那份 `next`）拿 `next`。**两处共用这一份，不许各写一份**——「同一条规则两份
 * 实现」是本仓反复裁过的形态，而这一条一旦分叉，面板上的横幅会与存储里的实际键
 * 说两句不同的话。
 *
 * 规整动作只有两步：`channel` 缺席时把 `primary` 的值抬上来；然后把 `primary` 与
 * `fallback` 两个键删掉。⇒ 运维在面板上保存任意一次设置，旧键消失、横幅随之消失。
 *
 * ⚠️ **它产出的 notice 只有「被丢掉的那条通道」这一条。** 「本次用的是旧键的值」
 * 那一条**不在这里**：本函数只看得见存储，而环境变量可能在更高一级把通道定死了，
 * 那时说「用的是旧键」就是假话。那一条由 `registrarFromEnv` 按**真正胜出的那一级**
 * 产出。
 *
 * ⚠️ **`fallback === 本次生效的那条通道` 时一条 notice 都不产。** 那份配置从前就被
 * 「备通道等于主通道」那条 blocker 拦着、**从来没有生效过**，说「丢弃了一条降级路径」
 * 是假话。
 *
 * ⚠️ **登记一处边界**：`fallback` 写的是一个既不是 `yyds` 也不是 `moemail` 的值时，
 * 本函数**只删键、不产 notice**。理由：那份配置从前会因为 `not_a_channel` 整个跑不
 * 起来，那条通道一把 key 都没铸过，点名说「它被丢掉了」同样是假话。**代价**是这一
 * 种旧键的消失确实是静默的；它不咬人（没有产出会归零），所以这一格没有再补判据。
 */
export function migrateStoredRegistrar(
  stored: unknown,
): { next: StoredRegistrar; notices: ConfigError[] } {
  const src: StoredRegistrar = typeof stored === "object" && stored !== null && !Array.isArray(stored)
    ? { ...(stored as StoredRegistrar) }
    : {};
  const notices: ConfigError[] = [];
  const hasChannel = src.channel !== undefined && src.channel !== null && src.channel !== "";
  const legacyPrimary = src.primary;
  const hasPrimary = legacyPrimary !== undefined && legacyPrimary !== null && legacyPrimary !== "";
  if (!hasChannel && hasPrimary) src.channel = legacyPrimary;
  const fallback = src.fallback;
  if (isChannelValue(fallback) && fallback !== src.channel) {
    notices.push({
      field: "registrar.channel", code: "legacy_fallback_ignored",
      params: { dropped: fallback, source: "stored" },
    });
  }
  delete src.primary;
  delete src.fallback;
  return { next: src, notices };
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
 *
 * ⚠️ **`out` 收不收得到，由调用方决定，不由本函数决定。** 两条通道现在都会走一遍
 * 本函数（这样未选中那条的 `configured` 才是真话），但只有选中那条的 `out` 是真正的
 * blocker 数组，另一条拿到的是一个用完即弃的数组——理由见调用点那段。
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
  const notices: ConfigError[] = [];
  const enabled = (env.REGISTRAR_ENABLED ?? String(stored.enabled ?? false)) === "true";

  // 存量存储里那两个旧键：读一次、说一次。**规整（删键）由写路径做**，读路径只借
  // 它的「怎么读」与「丢掉了什么」，两边共用同一份实现。
  const migrated = migrateStoredRegistrar(stored);
  notices.push(...migrated.notices);

  // ⚠️ **喂给它的是存储原件，不是 `migrated.next`。** 规整过的那份已经把 `primary`
  // 的值抬进了 `channel`，那时第 3 级会赢、`legacy` 恒为 `null` ⇒ 面板永远不会告诉
  // 运维「你用的是旧键」，而旧键其实还躺在存储里。
  const pick = resolveChannel(env, stored, logger);
  const channel = pick.value;

  // **旧名字仍然能用，但每次都要说一声。** 直接把旧名字删掉的后果是：一台跑得好好的
  // 部署升级后静默变成「没选通道」⇒ 注册机停跑、转发照常 ⇒ 池子慢慢耗干、最后以
  // `pool_empty` 503 炸出来，而面板说的是「没选通道」——运维明明选了。那是说了假原因。
  // 这两条 notice 会一直在，直到运维改掉 compose / 在面板上保存一次 —— 那正是一条
  // 弃用提示该有的样子（本仓没有 deprecation 流程，凭空立一个没人执行的期限是假承诺）。
  if (pick.legacy === "env") notices.push({ field: "registrar.channel", code: "legacy_channel_env" });
  else if (pick.legacy === "stored") notices.push({ field: "registrar.channel", code: "legacy_channel_key" });

  // `REGISTRAR_FALLBACK` **只被读这一次，读它的唯一目的就是把它说出来**：它不再参与
  // 选路，也**不产 blocker**（为一个已失去意义的变量把一台正常运行的注册机拦停，
  // 是拿正确性换洁癖）。完全不读它 ＝ 静默无视 ＝ 撒谎，那条路明确否掉了。
  const envFallback = env.REGISTRAR_FALLBACK;
  if (isChannelValue(envFallback) && envFallback !== channel) {
    notices.push({
      field: "registrar.channel", code: "legacy_fallback_ignored",
      params: { dropped: envFallback, source: "env" },
    });
  }

  // 通道相关的两条 blocker 受 `enabled` 门控：关着的注册机的脏配置一条都不该
  // 拦着谁——判据与 `crossFieldErrors` 同源（那边 `if (!enabled) return out;`）。
  if (enabled) {
    if (pick.invalid !== null) {
      blockers.push({
        field: "registrar.channel", code: "not_a_channel",
        params: { raw: String(pick.raw) },
      });
    } else if (channel === null) {
      // **写成 `else if` 是有意的**：值写错了（`not_a_channel`）与压根没选
      // （`channel_required`）是两句不同的话，同时说出来只会让运维以为有两处要改。
      // `crossFieldErrors` 那边同一形状。
      blockers.push({ field: "registrar.channel", code: "channel_required" });
    }
  }

  const cfg: RegistrarConfig = {
    enabled,
    // 未启用时 channel 可能仍是 null（尚未选择）；类型按"启用后的合法形状"声明为
    // 非空，消费方读取前必须先判断 enabled，见上面接口定义处的注释。
    channel: channel as Channel,
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

  // 单轮最坏耗时 = `mintBatch × codeTimeoutMs`（每次铸 key 最长要等满一次验证码
  // 超时）**加上名额之间的那 `mintBatch − 1` 段随机间隔**。
  //
  // ⚠️ **间隔那一项是本轮补上的**：默认间隔从几秒改成几十秒之后，它不再是可以忽略
  // 的尾巴——默认配置下它占 360 秒，而整轮最坏是 960 秒。漏掉它，这条 warn 就会在
  // 一份**真的会重叠**的配置上保持沉默。
  //
  // ⚠️ **这里从前还乘着一个「通道数」**：配了备通道时「验证码超时」属于通道级失败、
  // 会降级重试一次，同一个名额最坏要等两次超时。两条通道改成二选一之后没有第二次
  // 了，这个因子整个消失。同一份口径散在**五处**，改一处就得五处一起改：`src/core/registrar/types.ts` 的
  // `WORKER_ROUND_BUDGET_MS`、`src/core/registrar/config.ts` 的最坏耗时告警、
  // `src/core/registrar/tender.ts` 的 `worstAttemptMs`、`src/http/wire.ts` 传给
  // 「立即补池」的那个预算、`wrangler.toml` 的 Cron 估算段（外加五语言 REGISTRAR.md
  // 的散文）。⚠️ 上一版这张表被写了四份、四份点名的集合互相不一致 —— 照任一份走
  // 都会漏掉一个文件。
  //
  // 它超过补池间隔时，轮次会重叠着跑——两个入口各有兜底（Node 的在途守卫、Worker
  // 的 KV 短锁）会把重叠的那次跳过，但被跳过的名额就白白浪费了，该调的是配置本身。
  // 与上面 MINT_DELAY_MIN/MAX 的交叉校验同一性质，区别是这里只 warn、连 blocker 都不产：
  // 数值各自都合法，只是搭配不划算，没到该让注册机停跑的程度。这条 warn 受 enabled 门控，
  // 关着的注册机不会打。
  const worstRoundMs = cfg.mintBatch * cfg.codeTimeoutMs
    + Math.max(0, cfg.mintBatch - 1) * cfg.mintDelayMaxMs;
  if (enabled && cfg.tendIntervalMs < worstRoundMs) {
    logger.log({
      level: "warn", event: "registrar.interval_shorter_than_worst_round",
      msg: "TEND_INTERVAL_MS 小于单轮最坏耗时（MINT_BATCH×CODE_TIMEOUT_MS 加上名额之间的 MINT_DELAY_MAX_MS 间隔），"
        + "补池轮次可能重叠并被跳过",
      fields: {
        tendIntervalMs: cfg.tendIntervalMs, mintBatch: cfg.mintBatch,
        codeTimeoutMs: cfg.codeTimeoutMs, mintDelayMaxMs: cfg.mintDelayMaxMs, worstRoundMs,
      },
    });
  }

  // 每多试一个域名，就是**多一次真实的发码请求**，而实测的限流预算约 4~6 次/窗口。
  // 这条 warn 是「调大它的代价」唯一说得出口的地方——面板上它只是一个数字输入框。
  if (enabled && cfg.maxDomainAttempts > 2) {
    logger.log({
      level: "warn", event: "registrar.domain_attempts_costly",
      msg: "MAX_DOMAIN_ATTEMPTS 调得偏大：每多试一个域名就多打一次发验证码请求，"
        + "而实测上游的限流预算大约是每个窗口 4~6 次（这个数是观测不是承诺，换出口可能不同）。"
        + "有了域名台账之后，稳态下一次成功铸号只需要 1 次，把它留在 1~2 更划算。",
      fields: { maxDomainAttempts: cfg.maxDomainAttempts },
    });
  }

  // CODE_TIMEOUT_MS 没有上界（posInt 只管正整数），而 Worker 形态的轮级预算是个
  // 固定值。`codeTimeoutMs` 一旦超过它，tendOnce 连**第一次**尝试都不敢
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
  // **与 `./tender.ts` 的 `worstAttemptMs` 同一个公式**（那里是判据、这里是启动期
  // 交叉校验，各写一个字面量迟早漂移）：一次尝试 = 等满一次验证码超时，外加这次
  // 尝试里换域名要付的 `maxDomainAttempts − 1` 段间隔。
  const worstAttemptMs = cfg.codeTimeoutMs
    + Math.max(0, cfg.maxDomainAttempts - 1) * cfg.mintDelayMaxMs;
  if (enabled && worstAttemptMs > WORKER_ROUND_BUDGET_MS) {
    logger.log({
      level: "warn", event: "registrar.attempt_exceeds_worker_budget",
      msg: "CODE_TIMEOUT_MS 超过 Worker 单轮墙钟预算：Cloudflare Worker 形态下补池会一把 key 都铸不出来"
        + "（每轮 attempted=0），请调小 CODE_TIMEOUT_MS。"
        + "Node/Docker 的定时轮没有平台墙钟上限、不受此限制，"
        + "但面板的「立即补池」在两种运行时上都带同一份轮级预算，Node/Docker 上同样铸不出来。",
      fields: {
        codeTimeoutMs: cfg.codeTimeoutMs, worstAttemptMs,
        workerRoundBudgetMs: WORKER_ROUND_BUDGET_MS,
      },
    });
  }

  if (enabled) {
    /**
     * **两条通道都解析凭据，但只有选中那条的缺凭据产 blocker。**
     *
     * ⚠️ 这不是顺手扩大射程，是删掉备通道直接砸出来的洞：只给「选中那条」解析的话，
     * 未选中通道的 `cfg.yyds` / `cfg.moemail` 恒为 `null`，而
     * `src/http/admin/handlers/registrar.ts` 的 `channelConfigured()` 判据正是
     * 「这一格非 null」。它的三个消费者会连锁失真：`/status` 的 `configured` 变成假话、
     * 「测试通道」对未选中那条恒 409、面板「添加 Key ▸ 自动注册」指定它也恒 409。
     * 于是「想在切换前先测一下另一条」必须先切过去保存 —— 鸡生蛋，而那恰恰是
     * 「二选一」模型下最核心的工作流。今天它靠「把另一条挂在备通道上」勉强活着。
     *
     * 顺带修掉一处既有的自相矛盾：凭据四元组读的是**存储原件**
     *（`src/core/config-provenance.ts` 里 secret 那一支），设置页早就说「已配置」，
     * 而注册机页读生效模型说「未配置」——同一件事两页两个答案。
     *
     * ⚠️ **`if (enabled)` 这道门保留**：关着的注册机不解析任何凭据，与今天一致。
     * 代价（关着时两张卡都显示「未配置」）是**今天就有的**，本次不修，如实登记为
     * 已知缺口——「测试通道」在 `enabled=false` 时本来就 409，那条工作流不受影响。
     */
    const discarded: ConfigError[] = [];
    for (const ch of ["yyds", "moemail"] as const) {
      const got = creds(env, stored, ch, ch === channel ? blockers : discarded);
      if (ch === "yyds") cfg.yyds = got;
      else cfg.moemail = got;
    }
  }

  // 一次收齐全部 blocker（不首条即停）：运维要的是「还差哪几格」，不是「先改这一格
  // 再来问下一格」——那正是本仓在 `validateConfigPatch` 的跨字段阶段裁过的形态。
  cfg.blocked = blockers.length > 0;
  return { config: cfg, blockers, notices };
}

/**
 * `RegistrarConfig.channel` 的类型是非空 `Channel`，但 `enabled=false` 时运行时值
 * 其实是 `null`（靠构造处的 `as Channel` 断言压住，类型系统不会强制消费方先判断
 * `enabled`）。下游一旦裸读 `cfg.channel` 却忘了先判空，拿到的要么是 `undefined`
 * 引发的无上下文异常，要么是运行时 `null`。这个访问器把判断收敛到一处：调用方
 * 不必再自己记得先查 `enabled`。
 *
 * ⚠️⚠️ **它是本模块唯一的 `throw` 豁免项**（`tests/unit/source-guards.test.ts` 里那份
 * 手写豁免清单逐字写着 `requireChannel`）。它不在装载路径上——装载器全函数化说的是
 * 「一份坏配置不该让网关起不来」，而这里是**消费方护栏**：走到这里还没有通道，
 * 说明某个消费者跳过了 `enabled` / `blocked` 两道 gate，那是代码 bug，必须响。
 */
export function requireChannel(cfg: RegistrarConfig): Channel {
  if (!cfg.enabled || !cfg.channel) {
    throw new Error("注册机未启用或未配置邮箱通道");
  }
  return cfg.channel;
}
