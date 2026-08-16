import type { Logger, LogEntry } from "../../src/ports/logger.js";

export interface RecordingLogger extends Logger {
  readonly entries: Array<Omit<LogEntry, "ts">>;
  /** 断言用：只取事件名，避免测试被文案改动误伤。 */
  events(): string[];
  has(event: string): boolean;
  clear(): void;
}

/**
 * 断言**事件名**而不是断言「console 被调用了」。
 *
 * 后者是形状断言：把 `console.warn` 换成 `console.log` 它照样绿，而运维的日志级别
 * 过滤就已经失效了。事件名是这套日志唯一对外稳定的契约，断言它才是行为断言。
 */
export function recordingLogger(): RecordingLogger {
  const entries: Array<Omit<LogEntry, "ts">> = [];
  return {
    entries,
    log(e) { entries.push(e); },
    events() { return entries.map((e) => e.event); },
    has(event) { return entries.some((e) => e.event === event); },
    clear() { entries.length = 0; },
  };
}
