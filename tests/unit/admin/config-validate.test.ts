import { describe, it, expect } from "vitest";
import {
  validateConfigPatch, clearSecret, exposureFields, declaredExposure, envNameOf,
  EDITABLE_FIELDS, SECRET_FIELDS, MAX_TEXT_LENGTH, type ConfigErrorCode,
} from "../../../src/core/admin/config-validate.js";
import { envLockedFields, loadConfigWithProvenance } from "../../../src/core/config-provenance.js";
import { MemoryStorage } from "../../helpers/fake-storage.js";
import { NULL_LOGGER } from "../../../src/ports/logger.js";

/**
 * `validateConfigPatch` —— 设计 §5.4 第 1 条的那道「写入前校验」。
 *
 * 它挡的是**一次面板保存把网关砖掉**：`registrarFromEnv` 对存储里的非法值是**抛错**
 * 不是降级，而 `ConfigHolder` 的「保留上一份合法快照」只在热实例上成立——
 * 冷启动没有上一份可退（Node `process.exit(1)`、Worker 冷 isolate 全部 500）。
 */

const GW = { GATEWAY_TOKEN: "gateway-token-for-validate-tests" };

function ok(r: ReturnType<typeof validateConfigPatch>) {
  if (!r.ok) throw new Error(`期望校验通过，实际报了：${JSON.stringify(r.errors)}`);
  return r;
}

function codes(r: ReturnType<typeof validateConfigPatch>): string[] {
  if (r.ok) return [];
  return r.errors.map((e) => `${e.field}:${e.code}`).sort();
}

describe("逐字段校验", () => {
  it("整数字段：非整数 / 小于下界各报一条能照着改的码", () => {
    expect(codes(validateConfigPatch({ maxStrikes: 2.5 }, { stored: {}, env: GW })))
      .toEqual(["maxStrikes:not_an_integer"]);
    expect(codes(validateConfigPatch({ maxStrikes: "3" }, { stored: {}, env: GW })))
      .toEqual(["maxStrikes:not_an_integer"]);
    expect(codes(validateConfigPatch({ maxStrikes: 0 }, { stored: {}, env: GW })))
      .toEqual(["maxStrikes:below_min"]);
  });

  /**
   * **两个池子旋钮的 0 是「关闭」，不是越界值**——它是用户的逃生口，与 `num()`
   * 那两处 `min = 0` 同源。把它们的下界写成 1 会让「关掉快照缓存」这条路整个消失。
   */
  it("poolCacheTtlMs / poolTouchIntervalMs 的 0 是合法取值（关闭），不是 below_min", () => {
    expect(ok(validateConfigPatch({ poolCacheTtlMs: 0, poolTouchIntervalMs: 0 }, { stored: {}, env: GW })).next)
      .toEqual({ poolCacheTtlMs: 0, poolTouchIntervalMs: 0 });
    expect(codes(validateConfigPatch({ poolCacheTtlMs: -1 }, { stored: {}, env: GW })))
      .toEqual(["poolCacheTtlMs:below_min"]);
  });

  /**
   * **URL 字段只收 http(s)。** `new URL()` 认 `javascript:` 与 `file:`，而这四个字段
   * 全都会被拿去发请求（`agnesBaseUrl` 是转发目标、`agnesPlatformUrl` 是注册凭据
   * 的去向、两条 `baseUrl` 是邮箱服务）。
   */
  it.each([
    ["空串", "", "empty"],
    ["不是 URL", "not a url", "not_a_url"],
    ["javascript:", "javascript:alert(1)", "not_a_url"],
    ["file:", "file:///etc/passwd", "not_a_url"],
  ])("agnesBaseUrl 拒绝 %s", (_n, value, code) => {
    expect(codes(validateConfigPatch({ agnesBaseUrl: value }, { stored: {}, env: GW })))
      .toEqual([`agnesBaseUrl:${code}`]);
  });

  it("agnesBaseUrl 收下 http 与 https", () => {
    for (const u of ["https://x.example.com/v1", "http://localhost:8080/v1"]) {
      expect(ok(validateConfigPatch({ agnesBaseUrl: u }, { stored: {}, env: GW })).next.agnesBaseUrl).toBe(u);
    }
  });

  it("文本字段有长度上限 —— 没有上限的自由文本会挂在池子热路径上", () => {
    const long = "x".repeat(MAX_TEXT_LENGTH + 1);
    expect(codes(validateConfigPatch({ "registrar.tokenName": long }, { stored: {}, env: GW })))
      .toEqual(["registrar.tokenName:too_long"]);
    expect(ok(validateConfigPatch({ "registrar.tokenName": "x".repeat(MAX_TEXT_LENGTH) }, { stored: {}, env: GW })).ok)
      .toBe(true);
  });

  it("通道字段只收 yyds / moemail / null", () => {
    expect(codes(validateConfigPatch({ "registrar.primary": "gmail" }, { stored: {}, env: GW })))
      .toEqual(["registrar.primary:not_a_channel"]);
    // `null` = 「不选」。注册机关着时不选主通道完全合法（`registrarFromEnv` 的既有语义）。
    expect(ok(validateConfigPatch({ "registrar.fallback": null }, { stored: {}, env: GW })).ok).toBe(true);
  });

  /**
   * **拼错的字段名一律 400，不静默丢弃。**
   * `{ maxStrikess: 9 }` 在宽松实现下是一次「保存成功、什么都没发生」，
   * 而面板会如实显示保存成功——本仓已经反复裁过同一形状。
   */
  it("不认识的字段一律 unknown_field", () => {
    expect(codes(validateConfigPatch({ maxStrikess: 9 }, { stored: {}, env: GW })))
      .toEqual(["maxStrikess:unknown_field"]);
    // `degraded` 是**装载的产物**，不是旋钮：能写它就等于允许面板把红色横幅关掉，
    // 而横幅要报告的那件事一点没变。
    expect(codes(validateConfigPatch({ degraded: false }, { stored: {}, env: GW })))
      .toEqual(["degraded:unknown_field"]);
  });

  /**
   * ⚠️ **被 env 锁定的字段是拒绝，不是「写下去但不生效」。**
   *
   * 写下去的后果：面板显示保存成功、四元组里 `stored` 真的变了、而 `effective`
   * 纹丝不动——运维会以为是缓存没刷，去等那 90 秒，然后再等一次。
   */
  it("被环境变量锁定的字段报 locked_by_env，并带上是哪个环境变量", () => {
    const r = validateConfigPatch({ maxStrikes: 9 }, { stored: {}, env: { ...GW, MAX_STRIKES: "3" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ field: "maxStrikes", code: "locked_by_env", params: { env: "MAX_STRIKES" } }]);
  });
});

describe("凭据：缺席或空串 = 不改（设计 §8.6）", () => {
  const stored = { gatewayToken: "old-secret-value", registrar: { yyds: { apiKey: "old-yyds-key" } } };
  /**
   * ⚠️ **本组的 `env` 里刻意**没有** `GATEWAY_TOKEN`。**
   *
   * 那是「口令只从存储来」的部署形态（`tests/contract/admin-auth.test.ts` 的
   * 「运行期复查：gatewayToken 在运行中变成 ADMIN_TOKEN 时管理端 fail closed」
   * 那一组用的也是它）。设了环境变量的话这一格测的会是 `locked_by_env`
   * ——**两条规则就分不开了**（本项目第 1 种假阳性：夹具无冲突数据）。
   * 「设了环境变量就改不动」由下面那一格单独钉住。
   */
  const NO_GW: Record<string, string | undefined> = {};

  /**
   * ⚠️⚠️ **两格必须分开写（缺席 / 空串）。**
   * 合成一格的话，其中一支的缺失会被另一支掩盖（第 5 种假阳性）。
   */
  it("缺席 = 不改", () => {
    const r = ok(validateConfigPatch({ maxStrikes: 9 }, { stored, env: NO_GW }));
    expect(r.next.gatewayToken).toBe("old-secret-value");
    expect(r.changed).toEqual(["maxStrikes"]);
  });

  it("空串 = 不改（**不是清空**）", () => {
    const r = ok(validateConfigPatch({ gatewayToken: "" }, { stored, env: NO_GW }));
    expect(r.next.gatewayToken, "空串走了清空分支 —— 保存一次设置页就抹掉网关口令").toBe("old-secret-value");
    expect(r.changed, "空串不该算作一次改动").toEqual([]);
  });

  it("非空串 = 真的改", () => {
    const r = ok(validateConfigPatch({ gatewayToken: "brand-new-secret" }, { stored, env: NO_GW }));
    expect(r.next.gatewayToken).toBe("brand-new-secret");
    expect(r.changed).toEqual(["gatewayToken"]);
  });

  it("凭据只收字符串", () => {
    expect(codes(validateConfigPatch({ gatewayToken: 12345 }, { stored, env: NO_GW })))
      .toEqual(["gatewayToken:not_a_string"]);
  });

  /**
   * **设计 §10.4 卡 1：「网关口令（可改，env 锁定时按钮禁用 + 说明轮换方式）」。**
   *
   * 后端这一半就是这条：`GATEWAY_TOKEN` 在环境变量里时，`PUT` 一律拒。
   * 面板那一半（输入框 `disabled` + 轮换说明）在
   * `tests/ui/dom/settings-save.test.ts` 的
   * 「被 env 锁定的字段：输入框 disabled，且旁边有一句怎么轮换的说明」。
   */
  it("GATEWAY_TOKEN 在环境变量里时，面板改不动它 —— 凭据也吃 locked_by_env 这一条", () => {
    expect(codes(validateConfigPatch({ gatewayToken: "x" }, { stored, env: GW })))
      .toEqual(["gatewayToken:locked_by_env"]);
  });

  /** 清空只能走 `clearSecret`（`POST /admin/api/config/secrets/clear` 的执行体）。 */
  it("clearSecret 真的把那一格从存储里删掉，且只认三条凭据路径", () => {
    const r = clearSecret(stored, "registrar.yyds.apiKey");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.next.registrar as Record<string, unknown>).yyds).toEqual({});
    // 别的字段不许被顺手动过。
    expect(r.next.gatewayToken).toBe("old-secret-value");
    expect(clearSecret(stored, "maxStrikes").ok, "非凭据路径不许走这条端点").toBe(false);
  });
});

describe("跨字段规则：每一条都对应 registrarFromEnv 里一处 throw", () => {
  const ON = { "registrar.enabled": true, "registrar.primary": "yyds", "registrar.yyds.apiKey": "k" };

  it("开着却没选主通道 ⇒ primary_required", () => {
    expect(codes(validateConfigPatch({ "registrar.enabled": true }, { stored: {}, env: GW })))
      .toContain("registrar.primary:primary_required");
  });

  it("备通道等于主通道 ⇒ fallback_equals_primary", () => {
    expect(codes(validateConfigPatch({ ...ON, "registrar.fallback": "yyds" }, { stored: {}, env: GW })))
      .toContain("registrar.fallback:fallback_equals_primary");
  });

  /**
   * ⚠️⚠️ **V21：`fallback === primary` 后端只在 `enabled` 为真时抛。**
   *
   * 这一格钉住的是「关着的时候后端不拦」——**前端那一半必须同源**，
   * 否则「关着注册机时改不了下拉框」。前端那一格在 `tests/ui/settings.test.ts` 的
   * 「注册机关着时前端不拦 fallback === primary —— 与后端同源」。
   * **变红条件**：把 `crossFieldErrors` 里那句 `if (!enabled) return out;` 删掉。
   */
  it("注册机关着时，fallback === primary 完全合法 —— 后端不抛，前端也不许拦", () => {
    const r = validateConfigPatch(
      { "registrar.enabled": false, "registrar.primary": "yyds", "registrar.fallback": "yyds" },
      { stored: {}, env: GW },
    );
    expect(r.ok, `关着的注册机被拦下了：${JSON.stringify(codes(r))}`).toBe(true);
  });

  it("开着却缺凭据 ⇒ channel_credentials_missing（这正是 creds() 会抛的那一支）", () => {
    expect(codes(validateConfigPatch(
      { "registrar.enabled": true, "registrar.primary": "moemail" },
      { stored: {}, env: GW },
    ))).toEqual([
      "registrar.moemail.apiKey:channel_credentials_missing",
      "registrar.moemail.baseUrl:channel_credentials_missing",
    ]);
  });

  /**
   * **环境变量提供的凭据同样算数。** 不看 env 的话，一个 `MOEMAIL_API_KEY` 走环境
   * 变量的部署会被本模块误判成「缺凭据」而拒绝保存——而它明明跑得好好的。
   */
  it("凭据由环境变量提供时不算缺 —— 判据是 env ?? 存储，不是只看存储", () => {
    const r = validateConfigPatch(
      { "registrar.enabled": true, "registrar.primary": "moemail" },
      { stored: {}, env: { ...GW, MOEMAIL_BASE_URL: "https://m.example.com", MOEMAIL_API_KEY: "k" } },
    );
    expect(r.ok, JSON.stringify(codes(r))).toBe(true);
  });

  /**
   * **这一条不受 `enabled` 门控**：`registrarFromEnv` 里那次 min/max 比较也在
   * `if (!enabled) return cfg;` 之前，关着的注册机同样会因为它抛错。
   */
  it("mintDelayMin > mintDelayMax ⇒ delay_min_gt_max，且关着的注册机同样拦", () => {
    for (const enabled of [true, false]) {
      const codesOf = codes(validateConfigPatch(
        { ...ON, "registrar.enabled": enabled, "registrar.mintDelayMinMs": 9_000, "registrar.mintDelayMaxMs": 5_000 },
        { stored: {}, env: GW },
      ));
      expect(codesOf, `enabled=${enabled}`).toContain("registrar.mintDelayMinMs:delay_min_gt_max");
    }
  });

  /**
   * **合并语义**：patch 只带 min 时，比较的另一半必须从**存储**里来。
   * 只比 patch 里那两格的话，「把 min 调大到超过已存的 max」会静默通过。
   */
  it("patch 只带一半时，另一半从存储取 —— 只比 patch 内部会漏掉这一类", () => {
    expect(codes(validateConfigPatch(
      { "registrar.mintDelayMinMs": 9_000 },
      { stored: { registrar: { mintDelayMaxMs: 5_000 } }, env: GW },
    ))).toContain("registrar.mintDelayMinMs:delay_min_gt_max");
  });

  /**
   * **逐字段没过时不跑跨字段规则。** 一个 `targetKeys: "abc"` 会让「min 不大于 max」
   * 这类比较拿到无意义的操作数，报出来的第二条错误只会把人引偏。
   */
  it("逐字段先错时，跨字段规则一条都不报", () => {
    const c = codes(validateConfigPatch(
      { "registrar.targetKeys": "abc", "registrar.enabled": true },
      { stored: {}, env: GW },
    ));
    expect(c).toEqual(["registrar.targetKeys:not_an_integer"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 两张表的对账：这里是「第二份实现」的代价被压住的地方
// ───────────────────────────────────────────────────────────────────────────

describe("EDITABLE 与 FIELD_EXPOSURE / envLockedFields 逐条对账", () => {
  /**
   * **`EDITABLE` 的每条路径都得在 `FIELD_EXPOSURE` 里**，而且 `secret` 那几格
   * 两边口径必须一致。
   *
   * 这条对账是 `FIELD_EXPOSURE` 那个编译期强制的**延伸**：加一把新密钥时，
   * `FIELD_EXPOSURE` 不补一格就编译不过（那是 `tsc` 管的），而**补成 `"public"`
   * 却在这里标成可编辑的普通字段**，编译期看不出来——这一格看得出来。
   */
  it("EDITABLE 的每条路径都在 FIELD_EXPOSURE 里，且 secret 那几格两边口径一致", () => {
    const exposure = new Map(exposureFields().map((f) => [f.field, f.exposure]));
    const mismatched: string[] = [];
    for (const field of EDITABLE_FIELDS) {
      const real = exposure.get(field);
      if (real === undefined) { mismatched.push(`${field}: 不在 FIELD_EXPOSURE 里`); continue; }
      const declared = declaredExposure(field);
      if (declared !== real) mismatched.push(`${field}: EDITABLE 说 ${declared}，FIELD_EXPOSURE 说 ${real}`);
    }
    expect(mismatched, "两张表对同一个字段说了不同的话 —— 其中一处标错就是明文出网").toEqual([]);
  });

  /**
   * **反向：`FIELD_EXPOSURE` 里的每一格都要被表过态**——要么可编辑，要么在这份
   * 手写的「刻意不可编辑」清单里。
   *
   * 不写这一条的话，加一个字段进 `FIELD_EXPOSURE`（编译期逼着做）之后，
   * 它会**静默地**既不可编辑、也没有任何人注意到——而设置页正是它该出现的地方。
   */
  it("FIELD_EXPOSURE 里每一格要么可编辑，要么在手写的「刻意只读」清单里", () => {
    // **手写清单。** `degraded` 是装载的产物（本次有没有降级），不是旋钮。
    const READ_ONLY = ["degraded"];
    const unaccounted = exposureFields()
      .map((f) => f.field)
      .filter((f) => !EDITABLE_FIELDS.includes(f) && !READ_ONLY.includes(f))
      .sort();
    expect(unaccounted, "这些字段既不可编辑也没被登记为只读 —— 请在这里表一次态").toEqual([]);
  });

  /**
   * **`locked_by_env` 的判据与 `envLockedFields` 是同一张表。**
   *
   * 两边各写一份的后果很具体：面板上那一格显示「已被 `TARGET_KEYS` 锁定 + 置灰」
   *（走 `envLockedFields`），而 `PUT` 那边不认得它、照单全收
   *（走本模块的 `FIELD_ENV`）⇒ 存储里那个值真的变了、生效值纹丝不动。
   */
  it("locked_by_env 的判据与 envLockedFields 是同一张表 —— 逐字段对账", () => {
    const mismatched: string[] = [];
    for (const field of EDITABLE_FIELDS) {
      const envName = envNameOf(field);
      if (envName === null) { mismatched.push(`${field}: 本模块没登记环境变量名`); continue; }
      const locked = envLockedFields({ [envName]: "x" });
      if (!locked.includes(field)) mismatched.push(`${field}: envLockedFields 认不得 ${envName}`);
    }
    expect(mismatched).toEqual([]);
  });

  it("凭据恰好三条（手写字面量）", () => {
    expect([...SECRET_FIELDS]).toEqual([
      "gatewayToken", "registrar.moemail.apiKey", "registrar.yyds.apiKey",
    ]);
  });

  /**
   * **每一个错误码都得有一个能触发它的样本。**
   *
   * 这一格挡的是「加了一个码却没有任何路径产出它」——那种码在
   * `tests/ui/settings.test.ts` 那条「每个码都有五语言文案」里照样会被要求配文案，
   * 于是字典里长出一条永远不会被显示的死文案。
   */
  it("每个错误码都至少有一个样本能真的触发它（联合类型不许有死成员）", () => {
    const produced = new Set<ConfigErrorCode>();
    const SAMPLES: ReadonlyArray<{ patch: Record<string, unknown>; stored: unknown; env: Record<string, string | undefined> }> = [
      { patch: { nope: 1 }, stored: {}, env: GW },
      { patch: { maxStrikes: 9 }, stored: {}, env: { ...GW, MAX_STRIKES: "3" } },
      { patch: { maxStrikes: 1.5 }, stored: {}, env: GW },
      { patch: { maxStrikes: 0 }, stored: {}, env: GW },
      { patch: { agnesBaseUrl: 1 }, stored: {}, env: GW },
      { patch: { agnesBaseUrl: "" }, stored: {}, env: GW },
      { patch: { agnesBaseUrl: "nope" }, stored: {}, env: GW },
      { patch: { "registrar.enabled": 1 }, stored: {}, env: GW },
      { patch: { "registrar.tokenName": "x".repeat(MAX_TEXT_LENGTH + 1) }, stored: {}, env: GW },
      { patch: { "registrar.primary": "gmail" }, stored: {}, env: GW },
      { patch: { "registrar.enabled": true }, stored: {}, env: GW },
      {
        patch: { "registrar.enabled": true, "registrar.primary": "yyds", "registrar.fallback": "yyds", "registrar.yyds.apiKey": "k" },
        stored: {}, env: GW,
      },
      { patch: { "registrar.mintDelayMinMs": 9_000, "registrar.mintDelayMaxMs": 5_000 }, stored: {}, env: GW },
      { patch: { "registrar.enabled": true, "registrar.primary": "yyds" }, stored: {}, env: GW },
    ];
    for (const s of SAMPLES) {
      const r = validateConfigPatch(s.patch, { stored: s.stored, env: s.env });
      if (!r.ok) for (const e of r.errors) produced.add(e.code);
    }
    // **期望值手写字面量**，不从 `produced` 反推（第 6 种假阳性）。
    expect([...produced].sort()).toEqual([
      "below_min", "channel_credentials_missing", "delay_min_gt_max", "empty",
      "fallback_equals_primary", "locked_by_env", "not_a_boolean", "not_a_channel",
      "not_a_string", "not_a_url", "not_an_integer", "primary_required",
      "too_long", "unknown_field",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 防漂：校验说合法的，装载必须真的装得起来
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ **这一组是「规则在这里是第二份实现」这个取舍的**代价押金**。**
 *
 * 校验规则与 `loadConfigWithProvenance` 各写一份，代价是它们可能漂。
 * 这里拿**真的装载函数**去跑每一个「校验说合法」的样本：漂了会在这里变红，
 * 而不是等到某个运维保存一次设置页、下一次冷启动网关起不来。
 *
 * **变红条件**：把 `crossFieldErrors` 里任意一条删掉（那条对应的 `registrarFromEnv`
 * 的 `throw` 就会真的被触发）。
 */
describe("防漂：validateConfigPatch 放行的，loadConfigWithProvenance 必须装载得起来", () => {
  const CASES: ReadonlyArray<{ name: string; patch: Record<string, unknown>; env?: Record<string, string | undefined> }> = [
    { name: "只改数值", patch: { maxStrikes: 9, cooldownStrikeMs: 7_777_000 } },
    { name: "两个池子旋钮关掉", patch: { poolCacheTtlMs: 0, poolTouchIntervalMs: 0 } },
    { name: "改上游地址", patch: { agnesBaseUrl: "https://mirror.example.com/v1" } },
    {
      name: "打开注册机 + yyds 单通道",
      patch: { "registrar.enabled": true, "registrar.primary": "yyds", "registrar.yyds.apiKey": "yk" },
    },
    {
      name: "打开注册机 + 双通道",
      patch: {
        "registrar.enabled": true, "registrar.primary": "moemail", "registrar.fallback": "yyds",
        "registrar.moemail.baseUrl": "https://m.example.com", "registrar.moemail.apiKey": "mk",
        "registrar.yyds.apiKey": "yk",
      },
    },
    {
      name: "关着的注册机 + 一堆没选完的通道值",
      patch: { "registrar.enabled": false, "registrar.primary": "yyds", "registrar.fallback": "yyds" },
    },
    {
      name: "凭据由环境变量提供",
      patch: { "registrar.enabled": true, "registrar.primary": "moemail" },
      env: { MOEMAIL_BASE_URL: "https://m.example.com", MOEMAIL_API_KEY: "mk" },
    },
  ];

  for (const c of CASES) {
    it(`${c.name}：校验放行 ⇒ 真的装载得起来`, async () => {
      const env = { ...GW, ...(c.env ?? {}) };
      const r = validateConfigPatch(c.patch, { stored: {}, env });
      expect(r.ok, `校验先拦下了：${JSON.stringify(codes(r))}`).toBe(true);
      if (!r.ok) return;
      const storage = new MemoryStorage();
      await storage.put("config", r.next);
      // **不 catch**：抛出来就是这一格该报的红。
      const { config } = await loadConfigWithProvenance(env, storage, NULL_LOGGER);
      expect(config.gatewayToken).toBe(GW.GATEWAY_TOKEN);
    });
  }

  /**
   * **反向自检：这组用例真的有判别力。**
   *
   * 不写它的话，上面七格在「校验永远说合法、装载永远不抛」和「校验规则真的与装载
   * 同源」这两种世界里都是绿的。这里手工绕过校验，直接把一份**校验会拒**的配置
   * 写进存储，确认装载确实会抛——那正是这道校验存在的全部理由。
   */
  it("反向自检：绕过校验直接写一份非法配置，装载真的会抛（这就是要挡的那件事）", async () => {
    const bad = { registrar: { enabled: true, primary: "yyds", fallback: "yyds", yyds: { apiKey: "k" } } };
    expect(
      codes(validateConfigPatch(
        { "registrar.enabled": true, "registrar.primary": "yyds", "registrar.fallback": "yyds", "registrar.yyds.apiKey": "k" },
        { stored: {}, env: GW },
      )),
      "前置条件：校验本来就该拒它",
    ).toContain("registrar.fallback:fallback_equals_primary");

    const storage = new MemoryStorage();
    await storage.put("config", bad);
    await expect(loadConfigWithProvenance(GW, storage, NULL_LOGGER)).rejects.toThrow();
  });
});
