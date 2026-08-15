import { describe, it, expect, vi } from "vitest";
import { registrarFromEnv, requirePrimary } from "../../../src/core/registrar/config.js";

describe("registrarFromEnv", () => {
  it("默认不启用", () => {
    expect(registrarFromEnv({}, {}).enabled).toBe(false);
  });

  it("默认值与设计文档一致", () => {
    const c = registrarFromEnv({}, {});
    expect(c.fallback).toBeNull();
    expect(c.targetKeys).toBe(20);
    expect(c.mintBatch).toBe(5);
    expect(c.tendIntervalMs).toBe(1_800_000);
    expect(c.codeTimeoutMs).toBe(120_000);
    expect(c.maxDomainAttempts).toBe(8);
  });

  it("启用但没指定主通道时抛错（两条通道平级，不预设默认）", () => {
    expect(() => registrarFromEnv({ REGISTRAR_ENABLED: "true" }, {}))
      .toThrow(/REGISTRAR_PRIMARY/);
  });

  it("启用但主通道凭据缺失时抛错并指明缺项", () => {
    expect(() => registrarFromEnv({ REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds" }, {}))
      .toThrow(/YYDS_API_KEY/);
  });

  it("启用且凭据齐备时通过", () => {
    const c = registrarFromEnv({ REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" }, {});
    expect(c.enabled).toBe(true);
    expect(c.yyds).toEqual({ baseUrl: "https://maliapi.215.im", apiKey: "k" });
  });

  it("配了备通道则备通道凭据也必须齐备", () => {
    expect(() => registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k", REGISTRAR_FALLBACK: "moemail" }, {},
    )).toThrow(/MOEMAIL/);
  });

  it("MoeMail 作主通道时同时要 base url 与 key（自建服务无默认地址）", () => {
    expect(() => registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "moemail", MOEMAIL_API_KEY: "k" }, {},
    )).toThrow(/MOEMAIL_BASE_URL/);
  });

  it("环境变量优先于存储", () => {
    const c = registrarFromEnv({ TARGET_KEYS: "7" }, { targetKeys: 30 });
    expect(c.targetKeys).toBe(7);
  });

  it("存储值在环境变量缺失时生效", () => {
    expect(registrarFromEnv({}, { targetKeys: 30 }).targetKeys).toBe(30);
  });

  it("数值非法时抛错而不是静默取 NaN", () => {
    expect(() => registrarFromEnv({ TARGET_KEYS: "abc" }, {})).toThrow(/TARGET_KEYS/);
    expect(() => registrarFromEnv({ MINT_BATCH: "0" }, {})).toThrow(/MINT_BATCH/);
    expect(() => registrarFromEnv({}, { targetKeys: -1 })).toThrow(/targetKeys/);
  });

  // P1 遗留：配置校验此前只覆盖环境变量层，没覆盖存储层。primary/fallback 是决定
  // 走哪条代码分支的枚举值，若存储里的垃圾值能绕过校验静默流入，下游按通道分支的
  // 代码（例如选哪个 MailProvider 适配器）会拿到既不是 yyds 也不是 moemail 的值。
  // 通道格式校验现在受 enabled 门控（见下面"未启用时…只 warn"的用例），故这里要
  // 显式启用注册机，才能真正打在"启用时格式非法必须抛错"这条分支上。
  it("启用时存储中的 primary 非法值抛错，不能绕过校验静默流入", () => {
    expect(() => registrarFromEnv({ REGISTRAR_ENABLED: "true" }, { primary: "garbage" as never }))
      .toThrow(/primary/);
  });

  it("启用时存储中的 fallback 非法值抛错，不能绕过校验静默流入", () => {
    expect(() => registrarFromEnv({ REGISTRAR_ENABLED: "true" }, { fallback: "garbage" as never }))
      .toThrow(/fallback/);
  });

  // 注册机关闭时，一个用不到的字段不该让整个网关起不来（例如 P3 面板写入 bug、
  // 手工改存储、跨版本迁移遗留）。只留痕，不阻断启动。
  it("未启用时存储中通道格式脏数据只 warn 不抛错，网关仍能正常启动", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let cfg: ReturnType<typeof registrarFromEnv> | undefined;
    expect(() => {
      cfg = registrarFromEnv({}, { primary: "garbage" as never, fallback: "trash" as never });
    }).not.toThrow();
    expect(cfg!.enabled).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("主备通道相同时抛错（降级到自己没有意义）", () => {
    expect(() => registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k", REGISTRAR_FALLBACK: "yyds" }, {},
    )).toThrow(/相同/);
  });

  // 回归用例：主备相同的校验此前没有像"启用但未指定主通道"那条一样受 enabled
  // 门控，导致运维在真正打开注册机之前先把两个通道变量摆成同一个值（例如照抄
  // 文档示例、提前布置环境变量）就会让 registrarFromEnv 抛错——而这个函数是
  // loadConfig()/buildApp() 内部调用链的一环，两个入口都会经过它，于是关闭状态
  // 下的一条注册机专属校验会把整个网关的启动都拖垮。
  it("未启用时主备通道相同不抛错，网关能正常构建（关闭状态不该受注册机专属校验拖累）", () => {
    expect(() => registrarFromEnv(
      { REGISTRAR_PRIMARY: "yyds", REGISTRAR_FALLBACK: "yyds" }, {},
    )).not.toThrow();
    const c = registrarFromEnv({ REGISTRAR_PRIMARY: "yyds", REGISTRAR_FALLBACK: "yyds" }, {});
    expect(c.enabled).toBe(false);
  });

  it("未启用时不校验凭据（关着就不该因为没配 key 而启动失败）", () => {
    // 关键：REGISTRAR_PRIMARY 已指定但对应凭据缺失——原始测试只传了
    // { REGISTRAR_ENABLED: "false" }，此时 primary 本来就是 null，凭据校验循环
    // 天然不会跑到，删掉"未启用时跳过校验"的分支这条测试也照样通过（验证过：
    // 真的删掉代码里的 `if (!enabled) return cfg;` 后 12 个测试仍全绿）。
    // 必须让 primary 有值、凭据没给，才能真正打在"关闭时跳过凭据校验"这条分支上。
    expect(() => registrarFromEnv(
      { REGISTRAR_ENABLED: "false", REGISTRAR_PRIMARY: "yyds" }, {},
    )).not.toThrow();
  });

  it("mintDelayMinMs 大于 mintDelayMaxMs 时抛错并点名两个环境变量", () => {
    expect(() => registrarFromEnv({ MINT_DELAY_MIN_MS: "9000", MINT_DELAY_MAX_MS: "3000" }, {}))
      .toThrow(/MINT_DELAY_MIN_MS/);
    expect(() => registrarFromEnv({ MINT_DELAY_MIN_MS: "9000", MINT_DELAY_MAX_MS: "3000" }, {}))
      .toThrow(/MINT_DELAY_MAX_MS/);
  });

  it("mintDelayMinMs 等于 mintDelayMaxMs 时不抛错（固定延迟是合法配置）", () => {
    const c = registrarFromEnv({ MINT_DELAY_MIN_MS: "3000", MINT_DELAY_MAX_MS: "3000" }, {});
    expect(c.mintDelayMinMs).toBe(3000);
    expect(c.mintDelayMaxMs).toBe(3000);
  });

  // === C4：补池间隔与单轮最坏耗时的交叉校验（只 warn，不抛错） ===

  const ENABLED = { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" };

  it("TEND_INTERVAL_MS 小于 MINT_BATCH×CODE_TIMEOUT_MS 时启动期 warn（轮次会重叠）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = registrarFromEnv(
      { ...ENABLED, TEND_INTERVAL_MS: "60000", MINT_BATCH: "5", CODE_TIMEOUT_MS: "120000" }, {},
    );
    expect(c.enabled).toBe(true); // 只是警告，配置照常生效
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("TEND_INTERVAL_MS");
    expect(msg).toContain("600000"); // 算出来的单轮最坏耗时
    warnSpy.mockRestore();
  });

  it("TEND_INTERVAL_MS 足够大时不 warn（成对用例，防止无条件告警）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registrarFromEnv({ ...ENABLED, TEND_INTERVAL_MS: "1800000", MINT_BATCH: "5", CODE_TIMEOUT_MS: "120000" }, {});
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("注册机未启用时不做这项告警（关着的子系统不该刷屏）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registrarFromEnv({ TEND_INTERVAL_MS: "1000", MINT_BATCH: "5", CODE_TIMEOUT_MS: "120000" }, {});
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("requirePrimary", () => {
  it("enabled 且 primary 合法时返回该通道", () => {
    const cfg = registrarFromEnv({ REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" }, {});
    expect(requirePrimary(cfg)).toBe("yyds");
  });

  it("enabled=false 时抛错（即便 primary 字段因类型断言而非空）", () => {
    const cfg = registrarFromEnv({}, {});
    expect(() => requirePrimary(cfg)).toThrow();
  });

  it("enabled=true 但 primary 为 null 时抛错", () => {
    // registrarFromEnv 本身在 enabled 且 primary 为空时已经抛错，这里直接构造
    // 一个"绕过 registrarFromEnv"的畸形 cfg 来验证 requirePrimary 自身的判空逻辑，
    // 不依赖上游是否也会拦截。
    const cfg = { enabled: true, primary: null } as unknown as Parameters<typeof requirePrimary>[0];
    expect(() => requirePrimary(cfg)).toThrow();
  });
});
