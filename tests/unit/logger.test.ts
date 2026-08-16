import { describe, it, expect, vi, afterEach } from "vitest";
import { NULL_LOGGER, type Logger } from "../../src/ports/logger.js";
import { ConsoleLogger } from "../../src/adapters/logger-console.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("ConsoleLogger", () => {
  it("registrar.* 事件渲染成 [registrar] 前缀——五语言 REGISTRAR.md 承诺运维可以按它 grep", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new ConsoleLogger().log({ level: "warn", event: "registrar.code_timeout", msg: "收不到信" });
    expect(String(spy.mock.calls[0]?.[0])).toBe("[registrar] registrar.code_timeout 收不到信");
  });

  it("非 registrar 事件渲染成 [agnes2api] 前缀", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    new ConsoleLogger().log({ level: "error", event: "storage.unwritable", msg: "写不进去" });
    expect(String(spy.mock.calls[0]?.[0])).toBe("[agnes2api] storage.unwritable 写不进去");
  });

  it("四个级别各自落到对应的 console 方法上——warn 打成 log 会让运维的日志级别过滤失效", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const l = new ConsoleLogger();
    l.log({ level: "debug", event: "a.b" });
    l.log({ level: "info", event: "a.b" });
    l.log({ level: "warn", event: "a.b" });
    l.log({ level: "error", event: "a.b" });
    expect([debug.mock.calls.length, info.mock.calls.length, warn.mock.calls.length, error.mock.calls.length])
      .toEqual([1, 1, 1, 1]);
  });

  it("fields 以 k=v 追加，顺序稳定，null 渲染成 null 而不是空", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new ConsoleLogger().log({
      level: "warn", event: "registrar.create_mailbox_failed", msg: "建不出来",
      fields: { domain: "a.test", attempt: 2, ok: false, err: null },
    });
    expect(String(spy.mock.calls[0]?.[0]))
      .toBe("[registrar] registrar.create_mailbox_failed 建不出来 domain=a.test attempt=2 ok=false err=null");
  });

  it("msg 缺席时不留多余空格", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new ConsoleLogger().log({ level: "warn", event: "registrar.x", fields: { a: 1 } });
    expect(String(spy.mock.calls[0]?.[0])).toBe("[registrar] registrar.x a=1");
  });

  it("fields 里的换行被压平——多行内容会把一条日志撕成多条，破坏按行 grep", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new ConsoleLogger().log({ level: "warn", event: "registrar.x", fields: { err: "line1\nline2\r\nline3" } });
    expect(String(spy.mock.calls[0]?.[0])).toBe("[registrar] registrar.x err=line1 line2 line3");
  });
});

describe("NULL_LOGGER", () => {
  it("什么都不打——它是「测试里没注入」的安全默认值，绕过 sink 打到 console 才是危险的", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const l: Logger = NULL_LOGGER;
    l.log({ level: "warn", event: "x.y", msg: "z" });
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
