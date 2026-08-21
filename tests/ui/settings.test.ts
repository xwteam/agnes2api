import { describe, it, expect } from "vitest";
import {
  CARD_AUTH, CARD_UPSTREAM, CARD_REGISTRAR, ADVANCED_FIELDS,
  channelFields, fieldLabelKey, errorMessageKey, fieldView, credentialView,
  buildPatch, localErrors, changedFields, propagationView, errorRows, displayValue,
} from "../../admin-ui/js/pure/settings.mjs";
import { CHANNELS } from "../../admin-ui/js/pure/registrar.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { EDITABLE_FIELDS, type ConfigErrorCode } from "../../src/core/admin/config-validate.js";

/**
 * 设置页的纯函数（`admin-ui/js/pure/settings.mjs`）。
 *
 * ⚠️ **本文件补的是三道 i18n 门禁看不见的那一族。**
 * `fieldLabelKey()` 返回的是**模板字面量**（`` `set.field.${path}` ``），
 * 而 `scripts/check-i18n.mjs` 与 `tests/unit/i18n-dict.test.ts` 都只认
 * data-i18n 属性与字面的翻译调用两种形态 ⇒ 那 24 个 key 今天全部被报成
 * ⚠️「未被引用」的**警告**（而那道门禁在警告上从不 exit 1）。
 * 下面「后端 EDITABLE_FIELDS 的每条路径都有一条 set.field.* 文案」就是补这一半的。
 */

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
const dict = I18N as Record<string, Record<string, string>>;

describe("字段清单：设计 §10.4 的三张卡 + 高级折叠区", () => {
  /**
   * ⚠️⚠️ **设计 §8.6 第二行：`agnesPlatformUrl` 是注册凭据的去向**
   *（改成自己的服务器就能收走每次注册的邮箱 + 密码 + 验证码）
   * ⇒ 折进「高级」折叠区 + 红色警告 + 二次确认，**不放主表单**。
   *
   * **变异 M10 的靶子**：把它挪回主表单。
   */
  it("agnesPlatformUrl 只在高级区，主表单三张卡一格都不许有它", () => {
    const main = [...CARD_AUTH, ...CARD_UPSTREAM, ...CARD_REGISTRAR];
    expect(main, "注册去向被挪回主表单了 —— 它会跟着一次普通的「调个超时」被顺手改掉")
      .not.toContain("registrar.agnesPlatformUrl");
    expect([...ADVANCED_FIELDS]).toEqual(["registrar.agnesPlatformUrl"]);
  });

  /**
   * **两条通道的字段清单逐字同构**（设计 §10.3 第 2 条：两张卡片布局完全对称，
   * 同字段数、同控件类型）。
   *
   * 判据是「把通道名换掉之后两份清单完全相等」——加一行给某一条通道就当场红。
   */
  it("两条通道的字段清单同构：同字段数、同顺序、同后缀", () => {
    const shapes = CHANNELS.map((c: string) =>
      channelFields(c).map((f: string) => f.replace(`registrar.${c}.`, "")));
    expect(shapes[0]).toEqual(shapes[1]);
    // 手写字面量：清单本身也钉住，免得两边一起被改成空数组也算「同构」。
    expect(shapes[0]).toEqual(["baseUrl", "apiKey"]);
  });

  /**
   * **两条通道的标签共用同一对 key。**
   *
   * 这是「完全对称」在文案层面的落点，而且它比禁用词表**更强**：想给某一条通道
   * 多写半句话，得先造出第二个 key，而那一步在评审里看得见。
   * （`set.*` 命名空间不在 `check-i18n` 第 ⑥ 条的禁用词作用域里，这一格与
   * `reg.channel.*` 那几条一起构成本任务在这条硬约束上的全部护栏。）
   */
  it("两条通道的字段标签是同一对 i18n key —— 不许各写一套", () => {
    const keys = CHANNELS.map((c: string) => channelFields(c).map(fieldLabelKey));
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[0]).toEqual(["set.field.channel.baseUrl", "set.field.channel.apiKey"]);
  });

  /**
   * **后端说能改的每一格，面板上都得有一个入口。**
   *
   * `EDITABLE_FIELDS` 是后端那份（它与 `FIELD_EXPOSURE` 有编译期强制的对账）。
   * 不写这一格的话，加一个配置字段之后 `GET /admin/api/config` 会返回一份
   * 「说能改、却没有任何地方能改」的清单——那正是本仓反复裁过的
   * 「面板说一件事、实际是另一件事」。
   */
  it("后端 EDITABLE_FIELDS 的每条路径都在面板的某张卡里", () => {
    const shown = new Set<string>([
      ...CARD_AUTH, ...CARD_UPSTREAM, ...CARD_REGISTRAR, ...ADVANCED_FIELDS,
      ...CHANNELS.flatMap((c: string) => channelFields(c)),
    ]);
    expect([...EDITABLE_FIELDS].filter((f) => !shown.has(f)).sort()).toEqual([]);
    // 反向：面板上不许有后端不认识的格子（那一格保存时会吃 `unknown_field`）。
    expect([...shown].filter((f) => !EDITABLE_FIELDS.includes(f)).sort()).toEqual([]);
  });
});

describe("i18n：门禁看不见的那两族，在这里补上", () => {
  /**
   * **`set.field.*` 这一族对三道 i18n 门禁是隐身的**（见文件头）。
   * 判据从**后端那份编译期强制的清单**出发反查字典 ⇒ 加字段不补文案当场红。
   */
  it("后端 EDITABLE_FIELDS 的每条路径都有一条 set.field.* 文案，且五语言齐备", () => {
    const missing: string[] = [];
    for (const field of EDITABLE_FIELDS) {
      const key = fieldLabelKey(field);
      const row = dict[key];
      if (row === undefined) { missing.push(`${field} → ${key}（字典里没有）`); continue; }
      for (const lang of LANGS) {
        if (typeof row[lang] !== "string" || row[lang]!.trim() === "") missing.push(`${key}/${lang}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * **设计 §10.4 点名要求的那条 CI 断言：后端产出的每一个错误码都有对应的 i18n 键。**
   *
   * ⚠️ **这张清单是 `ConfigErrorCode` 的手写镜像**，`satisfies` 那一行让它与联合
   * 类型逐个成员对上：**后端加一个错误码而这里不补，`tsc` 先报错**；
   * 补了这里而不补字典，下面那条断言红。两道一起才是完整的。
   */
  it("后端产出的每一个错误码都有对应的 i18n 键 —— 加一个码不补文案就变红", () => {
    const ALL_CODES = [
      "unknown_field", "locked_by_env", "not_an_integer", "below_min", "not_a_string",
      "not_a_boolean", "empty", "too_long", "not_a_url", "not_a_channel",
      "primary_required", "fallback_equals_primary", "delay_min_gt_max",
      "channel_credentials_missing",
    ] as const satisfies readonly ConfigErrorCode[];

    const missing: string[] = [];
    for (const code of ALL_CODES) {
      const key = errorMessageKey(code);
      if (key === null) { missing.push(`${code}（errorMessageKey 表里没有）`); continue; }
      const row = dict[key];
      if (row === undefined) { missing.push(`${code} → ${key}（字典里没有）`); continue; }
      for (const lang of LANGS) {
        if (typeof row[lang] !== "string" || row[lang]!.trim() === "") missing.push(`${key}/${lang}`);
      }
    }
    expect(missing).toEqual([]);
    // 反向自检：表本身不是空的。
    expect(ALL_CODES.length).toBe(14);
  });

  /**
   * **表外的码返回 `null`，不冒充任何一档已知原因。**
   * `null` 让调用方把那个码原样显示出来（`set.err.unknown`），而一句写死的
   * 「保存失败」会把一条本来能被运维 grep 到的线索抹掉。
   */
  it("表外的错误码返回 null —— 让调用方把它原样显示出来", () => {
    expect(errorMessageKey("brand_new_code_from_the_future")).toBeNull();
    expect(errorMessageKey(undefined)).toBeNull();
    expect(dict["set.err.unknown"], "兜底那句文案得存在").toBeDefined();
  });
});

describe("四元组与凭据的读法", () => {
  const body = {
    fields: {
      maxStrikes: { stored: 4, env: "9", effective: 9, lockedBy: "env:MAX_STRIKES" },
      "registrar.targetKeys": { stored: 20, env: null, effective: 20, lockedBy: null },
    },
    credentials: {
      gatewayToken: { configured: true, hint: "wxyz", lockedBy: null },
    },
    secrets: ["gatewayToken"],
    changed: ["maxStrikes"],
    propagation: { configTtlMs: 30_000, kvEdgeCacheMs: 60_000, visibilityUpperBoundMs: 90_000 },
  };

  it("锁定字段：locked 为真，且带着是哪个环境变量", () => {
    expect(fieldView(body, "maxStrikes")).toEqual({
      present: true, stored: 4, env: "9", effective: 9, lockedBy: "env:MAX_STRIKES", locked: true,
    });
    expect(fieldView(body, "registrar.targetKeys").locked).toBe(false);
  });

  /** 「这一格是空的」与「没读到」必须分得开。 */
  it("读不到的字段 present 为 false，而不是伪造一格空值", () => {
    expect(fieldView(body, "nope").present).toBe(false);
    expect(fieldView(null, "maxStrikes").present).toBe(false);
  });

  it("凭据视图永远没有明文，只有配没配与末 4 位", () => {
    expect(credentialView(body, "gatewayToken")).toEqual({
      present: true, configured: true, hint: "wxyz", lockedBy: null, locked: false,
    });
  });

  it("changed 从响应里取，不是前端自己 diff 出来的", () => {
    expect(changedFields(body)).toEqual(["maxStrikes"]);
    expect(changedFields({}), "没有这一格时是空数组，不是 null").toEqual([]);
  });

  /** **不许写「立即生效」**（设计 §5.2）：读不到就不渲染那一行，不伪造 0。 */
  it("传播上界读不到时逐格 null，不伪造 0", () => {
    expect(propagationView(body).visibilityUpperBoundMs).toBe(90_000);
    expect(propagationView({}).visibilityUpperBoundMs).toBeNull();
  });

  it("displayValue：null 显示成 —，布尔显示成 true/false，不留空白", () => {
    expect(displayValue(null)).toBe("—");
    expect(displayValue(false)).toBe("false");
    expect(displayValue(0)).toBe("0");
  });
});

describe("buildPatch：三条规则", () => {
  const body = {
    fields: {
      maxStrikes: { stored: 4, env: "9", effective: 9, lockedBy: "env:MAX_STRIKES" },
      "registrar.targetKeys": { stored: 20, env: null, effective: 20, lockedBy: null },
      "registrar.enabled": { stored: false, env: null, effective: false, lockedBy: null },
      agnesBaseUrl: { stored: "https://a.example.com", env: null, effective: "https://a.example.com", lockedBy: null },
    },
    credentials: {
      gatewayToken: { configured: true, hint: "wxyz", lockedBy: null },
      "registrar.yyds.apiKey": { configured: false, hint: null, lockedBy: "env:YYDS_API_KEY" },
    },
    secrets: ["gatewayToken", "registrar.yyds.apiKey"],
  };

  it("锁定的字段一律不送 —— 送了会把整份 patch 一起打回来", () => {
    expect(buildPatch({ maxStrikes: "5", "registrar.targetKeys": "25" }, body))
      .toEqual({ "registrar.targetKeys": 25 });
  });

  it("凭据留空 = 不送（设计 §8.6：缺席或空串 = 不改）", () => {
    expect(buildPatch({ gatewayToken: "" }, body)).toEqual({});
    expect(buildPatch({ gatewayToken: "new-one" }, body)).toEqual({ gatewayToken: "new-one" });
    // 锁定的凭据同样不送。
    expect(buildPatch({ "registrar.yyds.apiKey": "k" }, body)).toEqual({});
  });

  it("值没变的字段不送", () => {
    expect(buildPatch({ "registrar.targetKeys": "20", agnesBaseUrl: "https://a.example.com" }, body))
      .toEqual({});
  });

  it("数值按当前那一格的类型归一，布尔按开关归一", () => {
    expect(buildPatch({ "registrar.targetKeys": "25", "registrar.enabled": true }, body))
      .toEqual({ "registrar.targetKeys": 25, "registrar.enabled": true });
    // `NaN` 不送：前端本来就有「是数字」那条即时提示，送过去只会多一条后端错误。
    expect(buildPatch({ "registrar.targetKeys": "abc" }, body)).toEqual({});
  });
});

describe("前端只做四条最轻量的即时提示（设计 §10.4）", () => {
  const body = {
    fields: {
      maxStrikes: { stored: 3, env: null, effective: 3, lockedBy: null },
      "registrar.enabled": { stored: true, env: null, effective: true, lockedBy: null },
      "registrar.primary": { stored: "yyds", env: null, effective: "yyds", lockedBy: null },
      "registrar.fallback": { stored: null, env: null, effective: null, lockedBy: null },
    },
    credentials: {}, secrets: [],
  };

  it("必填 / 是数字 / 非负，三条各一格", () => {
    expect(localErrors({ maxStrikes: "" }, body)).toEqual([{ field: "maxStrikes", code: "empty" }]);
    expect(localErrors({ maxStrikes: "abc" }, body)).toEqual([{ field: "maxStrikes", code: "not_an_integer" }]);
    expect(localErrors({ maxStrikes: "-1" }, body)).toEqual([{ field: "maxStrikes", code: "below_min" }]);
    expect(localErrors({ maxStrikes: "9" }, body)).toEqual([]);
  });

  /**
   * ⚠️ **只到「非负」为止。** 具体下界（1 还是 0）是后端的事；在这里复刻一份会与
   * 后端的 `EDITABLE` 漂移，而那正是设计 §10.4 那个取舍要避免的东西。
   * `poolCacheTtlMs` 的 0 是合法的「关闭」，`maxStrikes` 的 0 不是——
   * **前端两者都放行**，后端各自判。
   */
  it("下界不在前端判：maxStrikes 填 0 前端放行，交给后端的 below_min", () => {
    expect(localErrors({ maxStrikes: "0" }, body)).toEqual([]);
  });

  it("注册机开着时，fallback === primary 前端就拦（设计 §10.3 第 7 条）", () => {
    expect(localErrors({ "registrar.fallback": "yyds" }, body))
      .toEqual([{ field: "registrar.fallback", code: "fallback_equals_primary" }]);
  });

  /**
   * ⚠️⚠️ **变异 M9 的靶子：把第四条改成无条件拦截。**
   *
   * 后端 `registrarFromEnv` 里那条抛错写在 `if (enabled && …)` 里（V21），
   * 关着的注册机它一条都不抛 ⇒ 前端无条件拦的后果是**「关着注册机时连下拉框都
   * 改不了」**，而后端明明会收下。**两边判据必须同源。**
   * 后端那一半在 `tests/unit/admin/config-validate.test.ts` 的
   * 「注册机关着时，fallback === primary 完全合法 —— 后端不抛，前端也不许拦」。
   */
  it("注册机关着时前端不拦 fallback === primary —— 与后端同源", () => {
    const off = {
      ...body,
      fields: { ...body.fields, "registrar.enabled": { stored: false, env: null, effective: false, lockedBy: null } },
    };
    expect(
      localErrors({ "registrar.fallback": "yyds" }, off),
      "前端无条件拦截了 —— 关着注册机时运维连下拉框都改不了，而后端会收下",
    ).toEqual([]);
    // 表单里现改的 `enabled` 同样算数（还没保存就该按新状态判）。
    expect(localErrors({ "registrar.enabled": false, "registrar.fallback": "yyds" }, body)).toEqual([]);
  });

  it("凭据不进即时提示 —— 它们留空是正当的（「留空则不修改」）", () => {
    const withSecret = { ...body, credentials: { gatewayToken: { configured: true, hint: "x", lockedBy: null } }, secrets: ["gatewayToken"] };
    expect(localErrors({ gatewayToken: "" }, withSecret)).toEqual([]);
  });
});

describe("errorRows：表外的码原样带出来", () => {
  it("认识的码给 key，不认识的给 null 并保留原码", () => {
    const rows = errorRows({
      errors: [
        { field: "maxStrikes", code: "below_min", params: { min: 1 } },
        { field: "x", code: "brand_new" },
      ],
    });
    expect(rows).toEqual([
      { field: "maxStrikes", code: "below_min", key: "set.err.below_min", params: { min: 1 } },
      { field: "x", code: "brand_new", key: null, params: {} },
    ]);
  });

  it("响应体不是那个形状时返回空数组，不抛", () => {
    expect(errorRows(null)).toEqual([]);
    expect(errorRows({ errors: "nope" })).toEqual([]);
  });
});
