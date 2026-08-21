import { FIELD_EXPOSURE, type Env, type Exposure } from "../config-provenance.js";

/**
 * 写入前校验（设计 §5.4 第 1 条）。**纯函数，在写存储之前跑，失败一个字节都不写。**
 *
 * ── 它挡的是什么 ────────────────────────────────────────────────────────────
 *
 * 设计 §5.4 逐字：存储里的非法值会让 `loadConfig` **抛错**，后果是
 * · **Node**：`buildApp` 抛 → `process.exit(1)` → **容器重启循环，而且没有面板
 *   可以进去改回来**；
 * · **Worker**：冷 isolate 全部 500，转发流量整个挂掉。
 *
 * §5.4 的四重防护里，字段级降级（第 2 条）与热路径保留上一份快照（第 3 条）都已在
 * P1/P3a 落地，但它们**都救不了这一类**：
 * · `registrarFromEnv` 的 `posInt()` 对存储里的非数字**是抛错，不是降级**；
 * · `enabled=true` + 没选主通道、`fallback === primary`、缺凭据，三条同样是抛；
 * · 而 `ConfigHolder` 的兜底只在**热实例**上成立——冷启动没有「上一份快照」可退。
 * ⇒ **面板必须在写下去之前拦住它。** 这就是本模块。
 *
 * ── 为什么规则不与 `loadConfig` 共用一份代码 ────────────────────────────────
 *
 * 试过的形态是「干跑一次 `loadConfigWithProvenance`，抛了就是非法」。它更省代码，
 * 但**给不出逐字段错误码**：`registrarFromEnv` 抛的是一条中文 `Error`，面板要么
 * 原样显示（那就把后端的中文 message 变成了对外契约，本仓已裁定这条归 P3e），
 * 要么去解析它（比中文 message 更脆）。设计 §10.4 要的是
 * `400 { errors: [{ field, code, params }] }`——**逐字段、机器可读、能映射五语言**。
 *
 * ⇒ 取舍明写：规则在这里**是第二份实现**，代价是它可能与 `loadConfig` 漂移。
 * 用两件事把代价压住：
 * ① **可编辑字段清单从 `FIELD_EXPOSURE` 派生**（见 `EDITABLE` 上面那段），
 *    `GatewayConfig` 加字段时那张表编译不过 ⇒ 这里也跑不掉；
 * ② `tests/unit/admin/config-validate.test.ts` 的
 *    「防漂：validateConfigPatch 放行的，loadConfigWithProvenance 必须装载得起来」
 *    **拿真的装载函数**去跑每一个「校验说合法」的样本——漂移会在那里变红，
 *    而不是等到某个运维保存一次设置页把网关砖掉。
 *
 * ── 零 IO ──────────────────────────────────────────────────────────────────
 * 本文件在 `src/core/` 下：没有时间、没有随机、没有网络。`env` 是一份**数据**，
 * 由调用方从各自运行时取好再传进来。
 */

/** 一条逐字段错误。`code` 是机器可读判别串，**面板靠它选五语言文案，不解析 message**。 */
export interface ConfigError {
  /** 面板路径，例如 `maxStrikes` / `registrar.yyds.baseUrl`。 */
  field: string;
  code: ConfigErrorCode;
  /** 渲染文案要的参数（下界、两个冲突值……）。**只放标量**，与 `LogEntry.fields` 同一条纪律。 */
  params?: Record<string, string | number>;
}

/**
 * 全部错误码。**穷尽联合，不是 `string`。**
 *
 * `admin-ui/js/pure/settings.mjs` 里那张 `errorMessageKey()` 表逐条对应它，
 * 而 `tests/ui/settings.test.ts` 的
 * 「后端产出的每一个错误码都有对应的 i18n 键 —— 加一个码不补文案就变红」
 * 拿这张表去比对字典：**加一个码而不补五语言，那一格当场红**（设计 §10.4 要求的
 * 那条 CI 断言）。
 */
export type ConfigErrorCode =
  /** 请求体里有本表不认识的字段（拼错的字段名在宽松实现下是一次「保存成功、什么都没发生」）。 */
  | "unknown_field"
  /** 这个字段被环境变量锁定，写它不会生效——**拒绝而不是静默接受**，见下面 `lockedBy` 那段。 */
  | "locked_by_env"
  | "not_an_integer"
  | "below_min"
  | "not_a_string"
  | "not_a_boolean"
  | "empty"
  | "too_long"
  | "not_a_url"
  | "not_a_channel"
  /** 注册机开着却没选主通道（后端 `registrarFromEnv` 在这一条上是抛错）。 */
  | "primary_required"
  /** 备通道等于主通道。**只在 `enabled` 为真时成立**（V21），前端拦截必须同源。 */
  | "fallback_equals_primary"
  | "delay_min_gt_max"
  /** 注册机开着、这条通道在链上，却没有凭据（`creds()` 在这一条上是抛错）。 */
  | "channel_credentials_missing";

/** 备注类文本的长度上限。与 `MAX_NOTE_LENGTH` 同一条理由：没有上限的自由文本会挂在热路径上。 */
export const MAX_TEXT_LENGTH = 200;

type Spec =
  | { kind: "int"; min: number }
  | { kind: "url" }
  | { kind: "text" }
  | { kind: "bool" }
  | { kind: "channelOrNull" }
  /** 凭据：**缺席或空串 = 不改**（设计 §8.6），清空只能走 `secrets/clear`。 */
  | { kind: "secret" };

/**
 * 面板能改的字段，以及每格的校验规则。
 *
 * ⚠️ **`degraded` 不在这里，这是有意的**：它是**装载的产物**（本次有没有降级），
 * 不是一个可以被设置的旋钮。把它做成可写会让面板能「把红色横幅关掉」，
 * 而横幅要报告的那件事一点没变。
 *
 * `FIELD_EXPOSURE` 与这张表的关系由
 * `tests/unit/admin/config-validate.test.ts` 的
 * 「EDITABLE 的每条路径都在 FIELD_EXPOSURE 里，且 secret 那几格两边口径一致」
 * 双向钉住：新增一个凭据字段时，只要它进了 `FIELD_EXPOSURE`（否则编译不过）
 * 却在这里被标成非 `secret`，那一格立刻红。
 */
const EDITABLE: Readonly<Record<string, Spec>> = {
  gatewayToken: { kind: "secret" },
  agnesBaseUrl: { kind: "url" },
  upstreamTimeoutMs: { kind: "int", min: 1 },
  upstreamSyncTimeoutMs: { kind: "int", min: 1 },
  maxStrikes: { kind: "int", min: 1 },
  cooldownRateLimitMs: { kind: "int", min: 1 },
  cooldownPaymentMs: { kind: "int", min: 1 },
  cooldownStrikeMs: { kind: "int", min: 1 },
  // **0 = 关闭**，是用户的逃生口，不是越界值（与 `num()` 那两处 `min = 0` 同源）。
  poolCacheTtlMs: { kind: "int", min: 0 },
  poolTouchIntervalMs: { kind: "int", min: 0 },
  "registrar.enabled": { kind: "bool" },
  "registrar.primary": { kind: "channelOrNull" },
  "registrar.fallback": { kind: "channelOrNull" },
  "registrar.targetKeys": { kind: "int", min: 1 },
  "registrar.mintBatch": { kind: "int", min: 1 },
  "registrar.tendIntervalMs": { kind: "int", min: 1 },
  "registrar.codeTimeoutMs": { kind: "int", min: 1 },
  "registrar.mintDelayMinMs": { kind: "int", min: 1 },
  "registrar.mintDelayMaxMs": { kind: "int", min: 1 },
  "registrar.maxDomainAttempts": { kind: "int", min: 1 },
  "registrar.tokenName": { kind: "text" },
  "registrar.agnesPlatformUrl": { kind: "url" },
  "registrar.yyds.baseUrl": { kind: "url" },
  "registrar.yyds.apiKey": { kind: "secret" },
  "registrar.moemail.baseUrl": { kind: "url" },
  "registrar.moemail.apiKey": { kind: "secret" },
};

/** 可编辑路径清单，**排好序**，面板与测试都从这里取。 */
export const EDITABLE_FIELDS: readonly string[] = Object.keys(EDITABLE).sort();

/** 三把凭据的路径。**从 `EDITABLE` 派生**，不另写一份清单。 */
export const SECRET_FIELDS: readonly string[] =
  Object.keys(EDITABLE).filter((p) => EDITABLE[p]!.kind === "secret").sort();

/** `EDITABLE` 每格声称的曝光度，用来与 `FIELD_EXPOSURE` 对账（见那张表上面的说明）。 */
export function declaredExposure(field: string): Exposure | null {
  const spec = EDITABLE[field];
  if (spec === undefined) return null;
  return spec.kind === "secret" ? "secret" : "public";
}

type Obj = Record<string, unknown>;

function asObject(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function getAt(root: Obj, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    const o = asObject(cur);
    if (o === null) return undefined;
    cur = o[seg];
  }
  return cur;
}

/** 深拷一层一层地写进去，**不改入参**（调用方手上那份存储原件必须原样保留）。 */
function setAt(root: Obj, path: readonly string[], value: unknown): Obj {
  if (path.length === 0) return root;
  const [head, ...rest] = path as [string, ...string[]];
  const next: Obj = { ...root };
  if (rest.length === 0) {
    next[head] = value;
    return next;
  }
  next[head] = setAt(asObject(next[head]) ?? {}, rest, value);
  return next;
}

function deleteAt(root: Obj, path: readonly string[]): Obj {
  if (path.length === 0) return root;
  const [head, ...rest] = path as [string, ...string[]];
  const next: Obj = { ...root };
  if (rest.length === 0) {
    delete next[head];
    return next;
  }
  const child = asObject(next[head]);
  if (child === null) return next;
  next[head] = deleteAt(child, rest);
  return next;
}

/**
 * `patch` 里的路径写法：**扁平点分路径**（`"registrar.targetKeys"`），
 * 不是嵌套对象。
 *
 * 理由是「缺席 = 不改」这条语义**只有扁平形态表达得清楚**：嵌套形态下
 * `{ registrar: { targetKeys: 5 } }` 到底是「只改 targetKeys」还是「把整个
 * registrar 换成只有一个字段的对象」，取决于合并规则写在哪一层，而两种读法
 * 都有人会按——一次读错就是把用户的两条通道凭据整段抹掉。
 */
export type ConfigPatch = Record<string, unknown>;

export type ValidateResult =
  | {
    ok: true;
    /** 合并之后**应当整体写回存储的那份 `config`**。调用方照写，不再自己合并。 */
    next: Obj;
    /** 这次真的改了哪些路径（值与合并前不同）。凭据只报路径，不报值。 */
    changed: readonly string[];
  }
  | { ok: false; errors: readonly ConfigError[] };

function isChannel(v: unknown): boolean {
  return v === "yyds" || v === "moemail";
}

/**
 * `http(s)://` 且解析得开。
 *
 * **不用 `new URL()` 的宽松性直接放行**：`URL` 认 `javascript:` 与 `file:`，
 * 而这几个字段全都会被拿去发请求（`agnesBaseUrl` 是转发目标、`agnesPlatformUrl`
 * 是注册凭据的去向、两条 `baseUrl` 是邮箱服务）。
 */
function isHttpUrl(v: unknown): boolean {
  if (typeof v !== "string" || v === "") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 校验一份 patch，并给出合并后应当写回的整份 `config`。
 *
 * @param patch  扁平点分路径 → 新值。**缺席 = 不改。**
 * @param ctx.stored 存储里 `config` 键的**原始值**（`unknown`，形状不受信任）。
 * @param ctx.env 环境变量。两处要用它：判 `locked_by_env`，以及判「凭据是不是已经
 *   由环境变量提供」——后者不看的话，一个 `MOEMAIL_API_KEY` 走 env 的部署会被
 *   本模块误判成「缺凭据」而拒绝保存。
 */
export function validateConfigPatch(
  patch: unknown,
  ctx: { stored: unknown; env: Env },
): ValidateResult {
  const errors: ConfigError[] = [];
  const body = asObject(patch);
  if (body === null) {
    return { ok: false, errors: [{ field: "", code: "unknown_field" }] };
  }

  const stored = asObject(ctx.stored) ?? {};
  let next: Obj = stored;
  const changed: string[] = [];

  for (const field of Object.keys(body)) {
    const spec = EDITABLE[field];
    if (spec === undefined) {
      // **拼错的字段名一律 400**，不静默丢弃：`{ maxStrikess: 9 }` 在宽松实现下是一次
      // 「保存成功、什么都没发生」，而面板会如实显示保存成功。
      errors.push({ field, code: "unknown_field" });
      continue;
    }
    const path = field.split(".");
    const value = body[field];

    // ⚠️ **被 env 锁定的字段一律拒绝，不是「写下去但不生效」。**
    // 写下去的后果是：面板显示保存成功、四元组里 `stored` 真的变了、而 `effective`
    // 纹丝不动——运维会以为是缓存没刷，去等那 90 秒，然后再等一次。
    // 拒绝 + 一条能照着改的错误码，是唯一不会骗人的处置。
    const envName = envNameOf(field);
    if (envName !== null && ctx.env[envName] !== undefined) {
      errors.push({ field, code: "locked_by_env", params: { env: envName } });
      continue;
    }

    if (spec.kind === "secret") {
      // 设计 §8.6：**缺席或空串 = 不改**（不是清空）。清空走
      // `POST /admin/api/config/secrets/clear`。
      // ⚠️ 空串走清空分支的后果：运维保存一次设置页就抹掉 `gatewayToken`，
      // 网关整个停摆（§5.4 的 fail-closed 反噬）。
      if (value === undefined || value === "") continue;
      if (typeof value !== "string") { errors.push({ field, code: "not_a_string" }); continue; }
      next = setAt(next, path, value);
      changed.push(field);
      continue;
    }

    const err = checkLeaf(field, spec, value);
    if (err !== null) { errors.push(err); continue; }
    if (!sameValue(getAt(next, path), value)) changed.push(field);
    next = setAt(next, path, value);
  }

  // 逐字段校验没过时**不跑跨字段规则**：一个 `targetKeys: "abc"` 会让
  // 「min 不大于 max」这类比较拿到无意义的操作数，报出来的第二条错误只会误导。
  if (errors.length > 0) return { ok: false, errors };

  errors.push(...crossFieldErrors(next, ctx.env));
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, next, changed: changed.sort() };
}

/** `NaN` 与 `-0` 这类边角一并按「不等」处理；两边都是标量时才谈得上相等。 */
function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

function checkLeaf(field: string, spec: Exclude<Spec, { kind: "secret" }>, value: unknown): ConfigError | null {
  switch (spec.kind) {
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { field, code: "not_an_integer" };
      }
      if (value < spec.min) return { field, code: "below_min", params: { min: spec.min } };
      return null;
    case "url":
      if (typeof value !== "string") return { field, code: "not_a_string" };
      if (value === "") return { field, code: "empty" };
      if (!isHttpUrl(value)) return { field, code: "not_a_url" };
      return null;
    case "text":
      if (typeof value !== "string") return { field, code: "not_a_string" };
      if (value === "") return { field, code: "empty" };
      if (value.length > MAX_TEXT_LENGTH) {
        return { field, code: "too_long", params: { max: MAX_TEXT_LENGTH } };
      }
      return null;
    case "bool":
      return typeof value === "boolean" ? null : { field, code: "not_a_boolean" };
    case "channelOrNull":
      // `null` = 「不选」，对 `fallback` 是正当取值；对 `primary` 由跨字段规则接手
      // （注册机关着时不选主通道完全合法，那是 `registrarFromEnv` 的既有语义）。
      if (value === null) return null;
      return isChannel(value) ? null : { field, code: "not_a_channel" };
    default:
      return null;
  }
}

/**
 * 跨字段规则。**每一条都对应 `registrarFromEnv` 里一处会 `throw` 的地方**——
 * 这份清单存在的全部理由就是「别让面板写出一份让网关起不来的配置」。
 *
 * ⚠️ **三条都受 `enabled` 门控**（V21）：注册机关着时 `registrarFromEnv` 一条都不抛
 * （`if (enabled && …)`），面板也就一条都不许拦。**两边判据必须同源**——
 * 前端无条件拦截的后果是「关着注册机时连下拉框都改不了」，而后端明明会收下。
 */
function crossFieldErrors(next: Obj, env: Env): ConfigError[] {
  const out: ConfigError[] = [];
  const reg = asObject(next.registrar) ?? {};

  const min = reg.mintDelayMinMs;
  const max = reg.mintDelayMaxMs;
  if (typeof min === "number" && typeof max === "number" && min > max) {
    // 这一条**不受 `enabled` 门控**：`registrarFromEnv` 里那次比较也在
    // `if (!enabled) return cfg;` 之前，关着的注册机同样会因为它抛错。
    out.push({ field: "registrar.mintDelayMinMs", code: "delay_min_gt_max", params: { min, max } });
  }

  const enabled = env.REGISTRAR_ENABLED === undefined
    ? reg.enabled === true
    : env.REGISTRAR_ENABLED === "true";
  if (!enabled) return out;

  const primary = env.REGISTRAR_PRIMARY ?? reg.primary ?? null;
  const fallback = env.REGISTRAR_FALLBACK ?? reg.fallback ?? null;

  if (primary === null || primary === "") {
    out.push({ field: "registrar.primary", code: "primary_required" });
  }
  if (fallback !== null && fallback !== "" && fallback === primary) {
    out.push({
      field: "registrar.fallback", code: "fallback_equals_primary",
      params: { channel: String(primary) },
    });
  }

  for (const ch of [primary, fallback]) {
    if (ch !== "yyds" && ch !== "moemail") continue;
    const creds = asObject(reg[ch]) ?? {};
    // YYDS 的 `baseUrl` 有内置取值、MoeMail 没有——这是两条通道之间**唯一**的不对称，
    // 而它是一句事实（一条是地址固定的公共服务，一条是自建服务），不是排名。
    // 判据逐条对应 `creds()` 里那三个 `if (!x) throw`。
    if (ch === "moemail" && !nonEmpty(env.MOEMAIL_BASE_URL ?? creds.baseUrl)) {
      out.push({ field: "registrar.moemail.baseUrl", code: "channel_credentials_missing", params: { channel: ch } });
    }
    const keyEnv = ch === "yyds" ? env.YYDS_API_KEY : env.MOEMAIL_API_KEY;
    if (!nonEmpty(keyEnv ?? creds.apiKey)) {
      out.push({ field: `registrar.${ch}.apiKey`, code: "channel_credentials_missing", params: { channel: ch } });
    }
  }
  return out;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" && v !== "";
}

/**
 * 字段路径 → 环境变量名。
 *
 * **它不是 `ENV_LOCK_MAP` 的第二份**：那张表在 `config-provenance.ts`，是私有的，
 * 而本模块只需要「这个字段有没有被 env 锁住」这一个问题的答案。
 * 两者一致由 `tests/unit/admin/config-validate.test.ts` 的
 * 「locked_by_env 的判据与 envLockedFields 是同一张表 —— 逐字段对账」钉住：
 * 它拿 `envLockedFields` 的输出与本函数逐字段比对，任何一边漏一格都会红。
 */
export function envNameOf(field: string): string | null {
  return FIELD_ENV[field] ?? null;
}

const FIELD_ENV: Readonly<Record<string, string>> = {
  gatewayToken: "GATEWAY_TOKEN",
  agnesBaseUrl: "AGNES_BASE_URL",
  upstreamTimeoutMs: "UPSTREAM_TIMEOUT_MS",
  upstreamSyncTimeoutMs: "UPSTREAM_SYNC_TIMEOUT_MS",
  maxStrikes: "MAX_STRIKES",
  cooldownRateLimitMs: "COOLDOWN_RATE_LIMIT_MS",
  cooldownPaymentMs: "COOLDOWN_PAYMENT_MS",
  cooldownStrikeMs: "COOLDOWN_STRIKE_MS",
  poolCacheTtlMs: "POOL_CACHE_TTL_MS",
  poolTouchIntervalMs: "POOL_TOUCH_INTERVAL_MS",
  "registrar.enabled": "REGISTRAR_ENABLED",
  "registrar.primary": "REGISTRAR_PRIMARY",
  "registrar.fallback": "REGISTRAR_FALLBACK",
  "registrar.targetKeys": "TARGET_KEYS",
  "registrar.mintBatch": "MINT_BATCH",
  "registrar.tendIntervalMs": "TEND_INTERVAL_MS",
  "registrar.codeTimeoutMs": "CODE_TIMEOUT_MS",
  "registrar.mintDelayMinMs": "MINT_DELAY_MIN_MS",
  "registrar.mintDelayMaxMs": "MINT_DELAY_MAX_MS",
  "registrar.maxDomainAttempts": "MAX_DOMAIN_ATTEMPTS",
  "registrar.tokenName": "REGISTRAR_TOKEN_NAME",
  "registrar.agnesPlatformUrl": "AGNES_PLATFORM_URL",
  "registrar.yyds.baseUrl": "YYDS_BASE_URL",
  "registrar.yyds.apiKey": "YYDS_API_KEY",
  "registrar.moemail.baseUrl": "MOEMAIL_BASE_URL",
  "registrar.moemail.apiKey": "MOEMAIL_API_KEY",
};

/**
 * 显式清空一把凭据（`POST /admin/api/config/secrets/clear` 的执行体）。
 *
 * ⚠️⚠️ **清掉 `gatewayToken` 而环境变量里也没有时，下一次冷启动会 fail-closed**
 *（`loadConfigWithProvenance` 抛「缺少 GATEWAY_TOKEN」⇒ Node 侧 `process.exit(1)`、
 * Worker 侧冷 isolate 500）。热实例因为 `Refreshable` 保留上一份合法快照**不会
 * 当场停摆**，所以这件事在面板上是**看不见**的，直到下一次重启/回收。
 *
 * **本模块不拦它**：这是一条显式动作（专门的端点 + 面板上的二次确认 + 红色警告），
 * 而「把存储里那把泄漏的口令删掉」是一个正当且必须存在的能力。
 * 拦住它的代价是：环境变量提供口令的部署（最常见的形态）想清掉存储里那份多余的
 * 旧口令时无路可走。**代价与后果都写进了五语言 DEPLOY.md 与面板的二次确认文案。**
 * 端点侧会为这一支打一条 `error` 级事件。
 */
export function clearSecret(stored: unknown, field: string): { ok: true; next: Obj } | { ok: false } {
  if (!SECRET_FIELDS.includes(field)) return { ok: false };
  return { ok: true, next: deleteAt(asObject(stored) ?? {}, field.split(".")) };
}

/** `FIELD_EXPOSURE` 里的全部叶子路径。测试拿它与 `EDITABLE` 对账，见那张表的说明。 */
export function exposureFields(): Array<{ field: string; exposure: Exposure }> {
  const out: Array<{ field: string; exposure: Exposure }> = [];
  const walk = (node: unknown, path: readonly string[]): void => {
    if (typeof node === "string") { out.push({ field: path.join("."), exposure: node as Exposure }); return; }
    const o = asObject(node);
    if (o === null) return;
    for (const k of Object.keys(o)) walk(o[k], [...path, k]);
  };
  walk(FIELD_EXPOSURE, []);
  return out;
}
