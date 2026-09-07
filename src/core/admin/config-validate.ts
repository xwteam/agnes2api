import { FIELD_EXPOSURE, type Env, type Exposure } from "../config-provenance.js";
/**
 * **原样再导出，不是第二份定义**：词表与类型今天住在 `src/core/config-errors.ts`
 *（那次搬家的理由——避开 `provenance → validate → provenance` 的运行期值循环——
 * 全文在那个文件顶上）。这里再导出一次是为了让既有调用方
 *（`src/http/admin/handlers/config.ts` 与两处测试）一个 import 都不用改，
 * 先例是 `src/core/config.ts:13` 再导出 `envLockedFields`。
 */
export { CONFIG_ERROR_CODES, type ConfigError, type ConfigErrorCode } from "../config-errors.js";
import type { ConfigError } from "../config-errors.js";
// 只借常量，不借规则：两份实现是刻意的，见 `crossFieldErrors` 上面那段。
import { DEFAULTS as REGISTRAR_DEFAULTS } from "../registrar/config.js";

/**
 * 写入前校验（设计 §5.4 第 1 条）。**纯函数，在写存储之前跑，失败一个字节都不写。**
 *
 * ── 它挡的是什么（**这一整段被本轮改动订正过，别照旧读**）────────────────────
 *
 * ⚠️⚠️ **原文写的是**：`registrarFromEnv` 的 `posInt()` 对存储里的非数字「是抛错，
 * 不是降级」，注册机那三条跨字段规则「同样是抛」，⇒「面板必须在写下去之前拦住它，
 * 这就是本模块」。**那段话今天逐句作废**：注册机装载器已经全函数化
 *（`src/core/registrar/config.ts` 模块级零 `throw`，由
 * `tests/unit/source-guards.test.ts` 的「`src/core/registrar/` 下的 throw 恰好等于
 * 手写豁免清单」钉着），非法数值退成字段级降级、其余四类退成 `blockers`
 *（注册机本次不启动，转发、`/health`、面板一律不受影响）。
 *
 * ⇒ **本模块的身份跟着退了一档**：它不再是「防止面板把网关砖掉」的唯一防线，
 * 而是 ① **写入侧预判**（别让人保存一份注册机跑不起来的配置）＋
 * ② **面板文案的码源**（`CONFIG_ERROR_CODES` 那张表）。
 *
 * ⚠️ 整条装载路径今天只剩**一个**抛点：两边都没有 `gatewayToken`
 *（`config-provenance.ts` 那句 `throw new ConfigRefusal`）。它仍然是砖机档——
 * 没有口令就无法鉴权，继续跑比停下来更危险——而 `ConfigHolder` 的兜底只在
 * **热实例**上成立，冷启动没有「上一份快照」可退。**那一条本模块照旧拦。**
 *
 * ── 为什么规则不与 `loadConfig` 共用一份代码 ────────────────────────────────
 *
 * 试过的形态是「干跑一次 `loadConfigWithProvenance`，抛了就是非法」。它更省代码，
 * 但**给不出逐字段错误码**（今天更甚：装载器压根不抛了，干跑什么都测不出来）。
 * 设计 §10.4 要的是 `400 { errors: [{ field, code, params }] }`
 * ——**逐字段、机器可读、能映射五语言**。
 *
 * ⇒ 取舍明写：规则在这里**是第二份实现**，代价是它可能与装载器漂移。
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
 *    ⚠️ 那一格今天是**单向**的（放行 ⇒ 装得起来）。反向那半边由同一份文件里的
 *    「双向等价：configLoadBlockers 的 field:code 集合恒等于装载器的 blockers」
 *    补上——两份实现从此在同一张对抗性输入网格上逐组对账。
 *
 * ── 零 IO ──────────────────────────────────────────────────────────────────
 * 本文件在 `src/core/` 下：没有时间、没有随机、没有网络。`env` 是一份**数据**，
 * 由调用方从各自运行时取好再传进来。
 */

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
      // ⚠️⚠️ **判据是 `trim() === ""` 而不是 `=== ""`**（评审发现）：一次「粘了几个空格」
      // 的误操作在 `=== ""` 下会被**收下并落盘**，而 `loadConfigWithProvenance` 里那句
      // `if (!gatewayToken)` 对 `"   "` 为**真**（非空字符串）⇒ 一次都不 fail-fast，
      // 面板还显示 `configured: true`。实测：`PUT {"gatewayToken":"   "} → 200`、
      // 落盘 `"   "`、原口令被抹掉、**所有下游用户从此 401**。
      const token = value.trim();
      if (token === "") continue;

      // ── 下面三条与 `ADMIN_TOKEN` 的四条硬规则同源，顺序也一样：
      //    空白 → 字符集 → 长度 → 相同性（见 `src/http/admin/auth.ts` 的 checkAdminToken）。
      //
      // ⚠️⚠️ **这一整段是评审补的。** `gatewayToken` 是在那一轮**第一次变成面板可写**的，
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
   * ⚠️⚠️ **这个差是那条评审发现的收口点，它把「只修一半」还给了最需要它的那个状态。**
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
 * ⚠️⚠️ **这个函数是两条评审发现的收口点，它把三处原本各行其是的判断收成一份。**
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
 * **判据对应的东西在本轮改动里换了一次，这一段是订正**：
 * · 两边都没有 `gatewayToken` ⇒ `loadConfigWithProvenance` 里那句
 *   `throw new ConfigRefusal`。**这一条仍然是「网关起不来」。**
 * · 其余各条 ⇒ **不再对应任何 `throw`**（`registrarFromEnv` 已全函数化），
 *   而是对应**装载器产出的 `blockers`**：注册机本次不启动，转发照常。
 *   两边由 `tests/unit/admin/config-validate.test.ts` 的
 *   「双向等价：configLoadBlockers ⟺ 装载器 blockers」在一张对抗性输入网格上
 *   逐组对账（比 `field:code` 集合）。
 *
 * ⚠️⚠️ **「它不完备」那一段的射程跟着收窄了。** 原来举的反例是存储里
 * `registrar.targetKeys: "abc"`：那时 `posInt()` 对非数字**抛错**、而本函数返回 `[]`。
 * 今天那条输入退成了**字段级降级**（回落默认值 + `config.invalid` 事件），
 * 它既不让网关起不来、也不让注册机停跑 ⇒ **本函数对它返回 `[]` 是对的，不是漏报。**
 * 剩下的不完备是网格式等价固有的：那格用例是**网格**不是穷举，未预见的输入形状
 * 仍可能漏过——但漏一格的后果已经从「注册机该跑不跑」退回「面板漏报一格」。
 *
 * ⇒ **仍然不许拿「blockers 为空」当「装得起来」的判据**（`readAll` 曾经这么用，
 * 后果是那一整类缺陷连诊断视图都拿不到、`GET`/`PUT` 双双 500、面板没有出路）。
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
 * 跨字段规则。**每一条都对应装载器（`registrarFromEnv`）产出的一条 blocker**——
 * 这份清单存在的全部理由是「别让面板写出一份注册机跑不起来的配置」。
 *
 * ⚠️⚠️ **它与装载器是两份实现，这是刻意的**（评审定稿：不许把本函数升格成运行时
 * 承重判据——那等于把一份登记在案的不完备实现放到热路径上）。代价由
 * `tests/unit/admin/config-validate.test.ts` 的「双向等价」那一格压住：同一张
 * 对抗性输入网格上，本函数的 `field:code` 集合恒等于装载器 `blockers` 的。
 * ⇒ **改这里必须同时对着 `src/core/registrar/config.ts` 读一遍**，反之亦然。
 *
 * ⚠️ **通道那几条受 `enabled` 门控，`delay_min_gt_max` 不受**——两条都与装载器逐字
 * 同源。前端无条件拦截的后果是「关着注册机时连下拉框都改不了」，而后端明明会收下。
 */
function crossFieldErrors(next: Obj, env: Env): ConfigError[] {
  const out: ConfigError[] = [];
  const reg = asObject(next.registrar) ?? {};

  // **比的是生效值，不是存储原件。**
  // ⚠️ 原来这里写的是「两边都是 `number` 且 min > max」——那份判据漏掉了两整类：
  // ① env 里的 `MINT_DELAY_MIN_MS=9000` 配上存储缺席（生效 max = 默认 5000）；
  // ② 存储里写了非法值（生效值是**默认值**，不是那个非法值）。
  // 装载器比的一直是生效值，于是两边在这两类上给出不同答案。现在同源。
  const min = effectiveNum(env, "MINT_DELAY_MIN_MS", reg.mintDelayMinMs, REGISTRAR_DEFAULTS.mintDelayMinMs);
  const max = effectiveNum(env, "MINT_DELAY_MAX_MS", reg.mintDelayMaxMs, REGISTRAR_DEFAULTS.mintDelayMaxMs);
  if (min > max) {
    // 这一条**不受 `enabled` 门控**：装载器里那次比较也在 `if (enabled)` 那一段之外，
    // 关着的注册机同样会因为它产出 blocker。
    out.push({ field: "registrar.mintDelayMinMs", code: "delay_min_gt_max", params: { min, max } });
  }

  const enabled = env.REGISTRAR_ENABLED === undefined
    ? reg.enabled === true
    : env.REGISTRAR_ENABLED === "true";
  if (!enabled) return out;

  const primary = pickChannel(env.REGISTRAR_PRIMARY, reg.primary);
  const fallback = pickChannel(env.REGISTRAR_FALLBACK, reg.fallback);

  if (primary.invalid) {
    // **值写错了与压根没选是两句不同的话**，`else if` 与装载器同形。
    out.push({ field: "registrar.primary", code: "not_a_channel", params: { raw: String(primary.raw) } });
  } else if (primary.value === null) {
    out.push({ field: "registrar.primary", code: "primary_required" });
  }
  if (fallback.invalid) {
    out.push({ field: "registrar.fallback", code: "not_a_channel", params: { raw: String(fallback.raw) } });
  } else if (fallback.value !== null && fallback.value === primary.value) {
    out.push({
      field: "registrar.fallback", code: "fallback_equals_primary",
      params: { channel: String(primary.value) },
    });
  }

  for (const ch of [...new Set([primary.value, fallback.value])]) {
    if (ch === null) continue;
    const creds = asObject(reg[ch]) ?? {};
    // YYDS 的 `baseUrl` 有内置取值、MoeMail 没有——这是两条通道之间**唯一**的不对称，
    // 而它是一句事实（一条是地址固定的公共服务，一条是自建服务），不是排名。
    if (ch === "moemail" && pick(env.MOEMAIL_BASE_URL, creds.baseUrl) === undefined) {
      out.push({ field: "registrar.moemail.baseUrl", code: "channel_credentials_missing", params: { channel: ch } });
    }
    const keyEnv = ch === "yyds" ? env.YYDS_API_KEY : env.MOEMAIL_API_KEY;
    if (pick(keyEnv, creds.apiKey) === undefined) {
      out.push({ field: `registrar.${ch}.apiKey`, code: "channel_credentials_missing", params: { channel: ch } });
    }
  }
  return out;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" && v !== "";
}

/**
 * 「env 优先、空串算没写」这条取值规则，**与装载器的 `asNonEmpty(env) ?? asNonEmpty(stored)`
 * 逐字同形**。空串必须算「没写」：`MOEMAIL_API_KEY=` 这种写法在 compose 里极常见，
 * 把它当成「配了一把空 key」会让两边给出不同答案。
 */
function pick(envRaw: string | undefined, storedRaw: unknown): string | undefined {
  return nonEmpty(envRaw) ? envRaw : (nonEmpty(storedRaw) ? storedRaw as string : undefined);
}

/**
 * 一个通道字段的取值 + 「写了个不认识的值」这件事。判据与装载器的 `resolveChannel`
 * 同形：`undefined` / `null` / 空串都算没写，**env 侧写了非法值就不再看存储**
 *（否则一个拼错的 `REGISTRAR_PRIMARY=yydss` 会静默穿透成存储里那条通道）。
 */
function pickChannel(
  envRaw: string | undefined,
  storedRaw: unknown,
): { value: "yyds" | "moemail" | null; invalid: boolean; raw: unknown } {
  if (envRaw !== undefined && envRaw !== "") {
    if (envRaw === "yyds" || envRaw === "moemail") return { value: envRaw, invalid: false, raw: envRaw };
    return { value: null, invalid: true, raw: envRaw };
  }
  // ⚠️ **不能借道 `pick()`**：那个函数把「非字符串」也归成「没写」，而存储里的
  // `primary: 123` 是**写了个不认识的值**（装载器对它报 `not_a_channel`），
  // 两者的文案与处置都不同。
  if (storedRaw === undefined || storedRaw === null || storedRaw === "") {
    return { value: null, invalid: false, raw: null };
  }
  if (storedRaw === "yyds" || storedRaw === "moemail") return { value: storedRaw, invalid: false, raw: storedRaw };
  return { value: null, invalid: true, raw: storedRaw };
}

/**
 * 一个注册机数值项的**生效值**，与装载器的 `posInt()` 逐字同形：
 * env > 存储 > 内置默认值，**非法一律回落默认值**（不再是抛错）。
 */
function effectiveNum(env: Env, envName: string, stored: unknown, fallback: number): number {
  const raw = env[envName];
  if (raw !== undefined) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : fallback;
  }
  if (stored === undefined || stored === null) return fallback;
  return typeof stored === "number" && Number.isInteger(stored) && stored >= 1 ? stored : fallback;
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
