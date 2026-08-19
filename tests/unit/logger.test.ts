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
    // 压平之后值里有空格 ⇒ 必须加引号，否则一个值会占掉三个字段的位置（见下一组）。
    expect(String(spy.mock.calls[0]?.[0])).toBe('[registrar] registrar.x err="line1 line2 line3"');
  });

  /**
   * ── 一个值只能占一个字段：未鉴权即可伪造审计行 ──────────────────────────
   *
   * `admin.login_failed` 的 `path` 装的是**任意未鉴权请求**的路径（Hono 的
   * `c.req.path` 还是百分号解码后的值），而这条日志是设计文档承诺的**唯一爆破痕迹**，
   * P3b 的事件板块要按它做面板筛选。原实现把值原样拼进空格分隔的 logfmt，于是
   * `curl 'http://gw/admin/api/x%20ip=8.8.8.8%20evil=1'` 就能写进一个伪造的 `ip=`。
   *
   * 这里断言的是**渲染出来的那一行**，不是「实现里有没有调 quote()」——后者是拿
   * 被测对象自己当期望值（本项目的第 6 种假阳性）。
   */
  describe("logfmt 引用：调用方的数据撕不开字段结构", () => {
    function render(fields: Record<string, string | number | boolean | null>): string {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      new ConsoleLogger().log({ level: "warn", event: "admin.login_failed", fields });
      return String(spy.mock.calls[0]?.[0]);
    }

    /**
     * 按 logfmt 的规矩把一行拆成**顶层记号**，再取出字段名。引号内的空格不分割。
     *
     * 判据必须是「有几个字段」而不是「整行长什么样」：攻击者注入的 `ip=8.8.8.8`
     * 确实还在那一行里（作为被引用值的一部分），关键是它**不再是一个字段**。
     * 拿整行 substring 去断言只能得到一条说不清自己在证明什么的用例。
     */
    function fieldNames(line: string): string[] {
      const tokens: string[] = [];
      let cur = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quoted) {
          if (ch === "\\") { cur += ch + (line[++i] ?? ""); continue; }
          if (ch === '"') quoted = false;
          cur += ch;
          continue;
        }
        if (ch === '"') { quoted = true; cur += ch; continue; }
        if (ch === " ") { if (cur) tokens.push(cur); cur = ""; continue; }
        cur += ch;
      }
      if (cur) tokens.push(cur);
      return tokens.filter((t) => t.includes("=")).map((t) => t.slice(0, t.indexOf("=")));
    }

    it("值里的空格与 = 不许伪造出新字段", () => {
      const line = render({ path: "/admin/api/x ip=8.8.8.8 evil=1", hasHeader: false });
      expect(line).toBe('[agnes2api] admin.login_failed path="/admin/api/x ip=8.8.8.8 evil=1" hasHeader=false');
      // 伪造的 `ip=` / `evil=` 只能待在被引用的值里面，顶层字段仍然只有这两个。
      expect(fieldNames(line)).toEqual(["path", "hasHeader"]);
    });

    it("值里的引号被转义，撕不开引用本身", () => {
      expect(render({ path: '/a" ip=1.2.3.4 x="' }))
        .toBe('[agnes2api] admin.login_failed path="/a\\" ip=1.2.3.4 x=\\""');
    });

    it("全部 C0/C1 控制字符被清掉——裸 ANSI 转义能直接操纵 docker logs / tail", () => {
      const esc = String.fromCharCode(0x1b);
      const nul = String.fromCharCode(0x00);
      const c1 = String.fromCharCode(0x9b);
      const line = render({ path: `/admin/api/z${esc}[2J${esc}[31mFAKE${nul}${c1}x` });
      expect(line).not.toContain(esc);
      expect(line).not.toContain(nul);
      expect(line).not.toContain(c1);
      expect(line).toContain("FAKE");
    });

    it("空串加引号——`k=` 与「这个字段不存在」在 logfmt 里长得一样", () => {
      expect(render({ path: "" })).toBe('[agnes2api] admin.login_failed path=""');
    });

    it("干净的值不加引号——审计行还是给人读的", () => {
      expect(render({ ip: "203.0.113.7", path: "/admin/api/session", hasHeader: true }))
        .toBe("[agnes2api] admin.login_failed ip=203.0.113.7 path=/admin/api/session hasHeader=true");
    });
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
