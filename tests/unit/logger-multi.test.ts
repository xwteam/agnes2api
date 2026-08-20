import { describe, it, expect } from "vitest";
import { multiLogger } from "../../src/adapters/logger-multi.js";
import type { Logger, LogEntry } from "../../src/ports/logger.js";

/**
 * **今天没有用例**（简报 Step 9 点名的缺口）：`multiLogger` 去掉 `try/catch` 之后，
 * 一个 sink 抛错会不会连累其余 sink、会不会让调用方（`logger.log(...)`）自己也抛出去。
 * 这条钉住「日志是旁路，绝不许把主流程搞挂」。
 */
describe("multiLogger：一个 sink 抛错不许影响别的 sink，更不许影响调用方", () => {
  function throwingSink(): Logger {
    return { log() { throw new Error("sink 自己坏了"); } };
  }
  function recordingSink(): Logger & { entries: Array<Omit<LogEntry, "ts">> } {
    const entries: Array<Omit<LogEntry, "ts">> = [];
    return { entries, log(e) { entries.push(e); } };
  }

  it("坏 sink 排在前面：好 sink 仍然收到事件，log() 本身不抛", () => {
    const good = recordingSink();
    const combined = multiLogger(throwingSink(), good);
    expect(() => combined.log({ level: "info", event: "e1" })).not.toThrow();
    expect(good.entries).toEqual([{ level: "info", event: "e1" }]);
  });

  it("坏 sink 排在后面：好 sink 仍然收到事件（不是靠抛错提前中止循环才侥幸成功）", () => {
    const good = recordingSink();
    const combined = multiLogger(good, throwingSink());
    expect(() => combined.log({ level: "warn", event: "e2" })).not.toThrow();
    expect(good.entries).toEqual([{ level: "warn", event: "e2" }]);
  });

  it("两个坏 sink 夹一个好 sink：好 sink 两侧都坏也照样收到", () => {
    const good = recordingSink();
    const combined = multiLogger(throwingSink(), good, throwingSink());
    expect(() => combined.log({ level: "error", event: "e3" })).not.toThrow();
    expect(good.entries).toEqual([{ level: "error", event: "e3" }]);
  });

  it("没有任何好 sink：全坏也不许抛出去", () => {
    const combined = multiLogger(throwingSink(), throwingSink());
    expect(() => combined.log({ level: "debug", event: "e4" })).not.toThrow();
  });

  it("零 sink：log() 是安全的空操作", () => {
    const combined = multiLogger();
    expect(() => combined.log({ level: "info", event: "e5" })).not.toThrow();
  });
});
