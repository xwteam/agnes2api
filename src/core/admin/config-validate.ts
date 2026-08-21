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
 * ① **可编辑字段清单与 `FIELD_EXPOSURE` 逐条对账**（见 `EDITABLE` 上面那段）。
 *    ⚠️ **这里原来写的是「从 `FIELD_EXPOSURE` 派生 ⇒ `tsc` 报错」，那是错的**
 *    （评审 Minor，我复现属实）：往 `FIELD_EXPOSURE` 加一格而**不**进 `EDITABLE`，
 *    `tsc` 照常通过——`EDITABLE` 是一张独立的手写表，编译期管不着它。
 *    真正抓住这件事的是**两条运行期用例**（`tests/unit/admin/config-validate.test.ts`
 *    的「EDITABLE 的每条路径都在 FIELD_EXPOSURE 里，且 secret 那几格两边口径一致」
 *    与「FIELD_EXPOSURE 里每一格要么可编辑，要么在手写的「刻意只读」清单里」）。
 *    **结论成立，机制说错了一层**——编译期强制只管 `FIELD_EXPOSURE` 自己那一层；
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
 * 全部错误码。**单一真源是下面这个数组，类型从它派生。**
 *
 * ⚠️⚠️ **第一版是手写联合 + 测试里一份 `as const satisfies readonly ConfigErrorCode[]`
 * 的镜像，那条护栏实测是假的**（评审 C4，我自己复现过）：`satisfies` 只做**单向
 * 可赋值检查**——它保证镜像里每一项都是合法的码，**不保证每一个码都在镜像里**。
 * 给联合加一个新码而不补 `ERROR_KEYS`、不补五语言 ⇒
 * `tsc exit=0`、`settings.test.ts` 34 passed、`check-i18n exit=0`，**零信号**；
 * 而反向（从联合里删一个）确实 `TS2322 ×2`。**删得住、加不住。**
 * 后果是：后端加错误码 ⇒ 面板 `errorMessageKey()` 返回 `null` ⇒ 走 `set.err.unknown`
 * **把裸码显示给运维**，没有任何东西会红。
 *
 * ⇒ 改成**数组是真源、类型是派生**：测试直接遍历 `CONFIG_ERROR_CODES`，
 * 加一个码而不补文案，`tests/ui/settings.test.ts` 的
 * 「后端产出的每一个错误码都有对应的 i18n 键 —— 加一个码不补文案就变红」当场红。
 */
export const CONFIG_ERROR_CODES = [
  /** 请求体里有本表不认识的字段（拼错的字段名在宽松实现下是一次「保存成功、什么都没发生」）。 */
  "unknown_field",
  /** 这个字段被环境变量锁定，写它不会生效——**拒绝而不是静默接受**，见下面 `lockedBy` 那段。 */
  "locked_by_env",
  "not_an_integer",
  "below_min",
  "not_a_string",
  "not_a_boolean",
  "empty",
  "too_long",
  "not_a_url",
  "not_a_channel",
  /** 注册机开着却没选主通道（后端 `registrarFromEnv` 在这一条上是抛错）。 */
  "primary_required",
  /** 备通道等于主通道。**只在 `enabled` 为真时成立**（V21），前端拦截必须同源。 */
  "fallback_equals_primary",
  "delay_min_gt_max",
  /** 注册机开着、这条通道在链上，却没有凭据（`creds()` 在这一条上是抛错）。 */
  "channel_credentials_missing",
  /** 两边都没有网关口令 ⇒ 冷启动会 fail-closed（`loadConfigWithProvenance` 抛）。 */
  "gateway_token_required",
  /** 凭据首尾带空白：HTTP 头值在传输层被 trim，客户端**永远送不出**这个值。 */
  "whitespace_padded",
  /** 凭据含送不出去的字符（非可打印 ASCII）。判据与 `ADMIN_TOKEN` 那条同源。 */
  "not_sendable",
  "too_short",
  /** 网关口令不得等于 `ADMIN_TOKEN`：中转口令是发给每一个下游用户的。 */
  "same_as_admin_token",
  /**
   * **这份配置构造不出来，但说不出是哪一格。**
   *
   * ⚠️ 它存在的理由是 `configLoadBlockers` **不完备**（见那个函数上面的说明）：
   * `posInt()` 对存储里的非数字是**抛错**而不是降级，而那条路径不在逐字段表里。
   * 这个码是那一类的如实兜底——**不编一个具体字段出来**，具体原因走事件板块。
   */
  "config_unloadable",
] as const;

export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number];

/** 备注类文本的长度上限。与 `MAX_NOTE_LENGTH` 同一条理由：没有上限的自由文本会挂在热路径上。 */
export const MAX_TEXT_LENGTH = 200;

/**
 * 网关口令的长度下限。**与 `ADMIN_TOKEN_MIN_LENGTH` 是同一个数，理由逐字相同。**
 *
 * `src/http/admin/auth.ts` 那段写着：「Worker 形态**没有分布式限速**（做它要拿 KV 当
 * 窗口，等于给攻击者一根消耗写配额的杠杆），因此口令熵就是唯一的防线，下限不是建议值」
 * ——**那段理由对 `gatewayToken` 逐字成立**：`/v1/*` 同样没有分布式限速，而
 * `gatewayToken` 是它唯一的凭据。
 *
 * ⚠️ **只对 `gatewayToken` 生效，不对两条通道的 `apiKey`**：那两把是**上游签发**的，
 * 长度不由本网关决定，套一个下限只会把一把合法的 key 拒掉。
 */
export const MIN_GATEWAY_TOKEN_LENGTH = 24;

/**
 * 可打印 ASCII（0x20–0x7E）。**与 `src/http/admin/auth.ts` 的 `SENDABLE` 是同一条判据。**
 *
 * 不 import 那一份：本文件在 `src/core/` 下，core 不许依赖 `src/http/`。
 * 两份一致由 `tests/unit/admin/config-validate.test.ts` 的
 * 「凭据的形状规则与 ADMIN_TOKEN 那四条逐码位同源」用**全部 256 个码位**跑等价断言钉住
 * ——做法抄 `tests/ui/sendable-parity.test.ts` 的
 * 「0x00–0xFF 全 256 个码位，两边给出同一个答案」。
 *
 * ⚠️ 量词是 `*` 而不是 `+`：这条规则说的是「不含送不出去的字符」，**非空不是它的职责**
 *（空串在更早一步就被当成「缺席」了）。与那边保持逐字相同，等价关系才对全部输入成立。
 */
const SENDABLE = /^[\x20-\x7e]*$/;

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
  ctx: {
    stored: unknown;
    env: Env;
    /**
     * 当前的 `ADMIN_TOKEN`（只从环境变量来）。**给了才查「网关口令不得等于它」**——
     * 不给时那一条静默跳过，而不是假装查过。直接调 `createApp` 的装配拿不到它。
     */
    adminToken?: string;
  },
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
      if (value === undefined) continue;
      if (typeof value !== "string") { errors.push({ field, code: "not_a_string" }); continue; }
      // 设计 §8.6：**缺席或空串 = 不改**（不是清空）。清空走
      // `POST /admin/api/config/secrets/clear`。
      // ⚠️ 空串走清空分支的后果：运维保存一次设置页就抹掉 `gatewayToken`，
      // 网关整个停摆（§5.4 的 fail-closed 反噬）。
      //
      // ⚠️⚠️ **判据是 `trim() === ""` 而不是 `=== ""`**（评审 C3）：一次「粘了几个空格」
      // 的误操作在 `=== ""` 下会被**收下并落盘**，而 `loadConfigWithProvenance` 里那句
      // `if (!gatewayToken)` 对 `"   "` 为**真**（非空字符串）⇒ 一次都不 fail-fast，
      // 面板还显示 `configured: true`。实测：`PUT {"gatewayToken":"   "} → 200`、
      // 落盘 `"   "`、原口令被抹掉、**所有下游用户从此 401**。
      const token = value.trim();
      if (token === "") continue;

      // ── 下面三条与 `ADMIN_TOKEN` 的四条硬规则同源，顺序也一样：
      //    空白 → 字符集 → 长度 → 相同性（见 `src/http/admin/auth.ts` 的 checkAdminToken）。
      //
      // ⚠️⚠️ **这一整段是评审 C3 补的。** `gatewayToken` 在本任务里**第一次变成面板可写**，
      // 而 `auth.ts` 早就为 `ADMIN_TOKEN` 立了这四条、每条都带着「为什么」——
      // **那些理由逐字对 `gatewayToken` 同样成立**（`/v1/*` 同样没有分布式限速，
      // 而 `gatewayToken` 是它唯一的凭据）。第一版一条都没跟过来。
      if (value !== token) {
        // HTTP 头值在传输层被 trim，而存储里不会 ⇒ 带空白的口令客户端**永远送不出来**，
        // 症状是「口令明明是对的却一直 401」。而首尾空格在面板上**根本渲染不出来**。
        errors.push({ field, code: "whitespace_padded" });
        continue;
      }
      if (!SENDABLE.test(value)) { errors.push({ field, code: "not_sendable" }); continue; }
      if (field === "gatewayToken") {
        if (value.length < MIN_GATEWAY_TOKEN_LENGTH) {
          errors.push({ field, code: "too_short", params: { min: MIN_GATEWAY_TOKEN_LENGTH } });
          continue;
        }
        // ③ 不得等于 `ADMIN_TOKEN`。把它写成相等 ⇒ `adminAuth` 的每请求复查立刻
        // 把整个管理面判成 503，**而改回去的那条 `PUT` 也是 503** ⇒ 面板把自己锁死。
        // 实测：设成 ADMIN_TOKEN → 200，之后 `GET /config` 503、想改回去的 `PUT` 也 503。
        if (ctx.adminToken !== undefined && value === ctx.adminToken) {
          errors.push({ field, code: "same_as_admin_token" });
          continue;
        }
      }
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

  /**
   * **跨字段阶段：只拒**这次补丁**新引入**的 blocker。
   *
   * 判据是「补丁前后两份 blocker 清单的差」，而不是「补丁之后还有没有 blocker」。
   *
   * ⚠️⚠️ **这个差是评审 F6 的收口点，它把「只修一半」还给了最需要它的那个状态。**
   * 第一版拿的是「补丁之后还有没有」⇒ 那份配置**本来就**坏掉时，运维想改一个
   * 无关字段（`PUT {maxStrikes: 7}`）会被 400 拒——而他手上正拿着一份装不起来的
   * 配置，最需要的恰恰是一步一步修回来。
   *
   * ⚠️ **它不会把砖机场景放回来**：本来就存在的 blocker 维持原样（没有新增伤害），
   * 而**任何一条新引入的**——把注册机打开却不填凭据、把备通道设成主通道、
   * 把最后一把网关口令清掉——照旧当场 400。
   * 判据按 `field:code` 比，两份数据 `validateConfigPatch` 手上都有。
   *
   * ⚠️ **诚实限定**：`configLoadBlockers` 本身不完备（见它上面那段），所以这道闸
   * 也随之不完备——它拦得住的是那份清单里说得出的那几类。逐字段校验（`checkLeaf`）
   * 覆盖了 `posInt` 那一类，两者合起来才是这条路径的全部防线。
   */
  const before = new Set(
    configLoadBlockers(stored, ctx.env).map((b) => `${b.field}:${b.code}`),
  );
  errors.push(
    ...configLoadBlockers(next, ctx.env).filter((b) => !before.has(`${b.field}:${b.code}`)),
  );
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
 * **这份 `config` 装载得起来吗？** 装载不起来的每一条原因，逐字段列出来。
 *
 * ⚠️⚠️ **这个函数是评审 C1/C2 的收口点，它把三处原本各行其是的判断收成一份。**
 *
 * 在它之前：`configClearSecretHandler` 里只有一条 `nowMissing`，而且**只判
 * `gatewayToken`**；同构的「清掉一条在链上的通道凭据」一个字都没写 ⇒ 那条路径上
 * `put` 先发生、随后 `readAll` 抛、被 `app.onError` 吞成 **500**：
 * **面板说「保存失败」，而那把凭据已经被删掉了。** 而同一个文件里我自己写下的禁令
 * 逐字是「回读抛出去会变成一个 500，而清空**已经发生了**——『面板说失败、实际做了』
 * 正是本仓反复裁过的那类谎」。
 *
 * 更坏的是**没有出路**（实测）：清完之后 `PUT` 关掉注册机 / 重新填这把 key /
 * 换主通道**全是 500**，`GET /admin/api/config` 也是 500，而**干跑 `validate` 回 200**
 * ——干跑说「你这个补丁合法」，真跑 500。冷启动则连 `/admin` 一起消失。
 *
 * **判据对应 `loadConfigWithProvenance` 会抛的那些地方**：
 * · 两边都没有 `gatewayToken` ⇒ 那里 `if (!gatewayToken) throw`；
 * · 其余五条 ⇒ `registrarFromEnv` / `creds()` 里的 `throw`（`crossFieldErrors`）。
 *
 * ⚠️⚠️ **它不完备，这一段是订正——原来这里写着「没有第二份推理」，那是假的。**
 * 评审当场跑出反例：存储里 `registrar.targetKeys: "abc"` ⇒ 本函数返回 `[]`，
 * 而 `posInt()` 对存储里的非数字**是抛错不是降级**（本文件开篇正把这件事列为
 * 本模块存在的理由之一），于是那份配置真的装不起来。
 * **它就是一份第二实现，只是覆盖面比 `loadConfigWithProvenance` 窄。**
 *
 * ⇒ **不许再拿「blockers 为空」当「装得起来」的判据**（`readAll` 曾经这么用，
 * 后果是这一整类缺陷连诊断视图都拿不到、`GET`/`PUT` 双双 500、面板没有出路）。
 * 正确的判据是「**存储读得出来吗**」——读得出来而构造失败，那就是配置问题；
 * 本函数只负责把**说得出是哪一格**的那些列出来，说不出的走 `config_unloadable`。
 *
 * 它有三个消费者，这正是它存在的意义：`validateConfigPatch` 的跨字段阶段、
 * `secrets/clear` 的**写前**预判、以及 `GET`/`PUT` 装载失败时的诊断视图。
 */
export function configLoadBlockers(stored: unknown, env: Env): ConfigError[] {
  const next = asObject(stored) ?? {};
  const out: ConfigError[] = [];
  // `loadConfigWithProvenance` 唯一保留 fatal 的那一条。
  if (!nonEmpty(env.GATEWAY_TOKEN ?? next.gatewayToken)) {
    out.push({ field: "gatewayToken", code: "gateway_token_required" });
  }
  out.push(...crossFieldErrors(next, env));
  return out;
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
