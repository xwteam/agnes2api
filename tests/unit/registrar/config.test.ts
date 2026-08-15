import { describe, it, expect } from "vitest";
import { registrarFromEnv } from "../../../src/core/registrar/config.js";

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
  it("存储中的 primary 非法值时抛错，不能绕过校验静默流入", () => {
    expect(() => registrarFromEnv({}, { primary: "garbage" as never })).toThrow(/primary/);
  });

  it("存储中的 fallback 非法值时抛错，不能绕过校验静默流入", () => {
    expect(() => registrarFromEnv({}, { fallback: "garbage" as never })).toThrow(/fallback/);
  });

  it("主备通道相同时抛错（降级到自己没有意义）", () => {
    expect(() => registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k", REGISTRAR_FALLBACK: "yyds" }, {},
    )).toThrow(/相同/);
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
});
