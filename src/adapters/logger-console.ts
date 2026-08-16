import type { Logger, LogEntry, LogLevel } from "../ports/logger.js";

/**
 * 前缀标签。五语言 REGISTRAR.md 的排障小节对外承诺「补池过程中的日志统一带
 * `[registrar]` 前缀，可据此过滤」（P2 的 M4）。事件名的命名空间就是这个前缀的
 * 唯一依据——不再靠每个调用点自己手写字符串，那正是 M4 当初漏掉 14 条的成因。
 */
function prefixOf(event: string): string {
  return event.startsWith("registrar.") ? "[registrar]" : "[agnes2api]";
}

const METHOD: Readonly<Record<LogLevel, "debug" | "info" | "warn" | "error">> = {
  debug: "debug", info: "info", warn: "warn", error: "error",
};

/**
 * 把字段值压成单行。多行内容（异常栈、上游返回的 HTML）会把一条日志撕成多条，
 * 而运维的排障姿势是按行 grep `[registrar]`——被撕开的后续行拿不到前缀，等于丢失。
 */
function flatten(v: string | number | boolean | null): string {
  return String(v).replace(/[\r\n]+/g, " ");
}

export class ConsoleLogger implements Logger {
  log(e: Omit<LogEntry, "ts">): void {
    let line = `${prefixOf(e.event)} ${e.event}`;
    if (e.msg) line += ` ${flatten(e.msg)}`;
    if (e.fields) {
      for (const [k, v] of Object.entries(e.fields)) line += ` ${k}=${flatten(v)}`;
    }
    console[METHOD[e.level]](line);
  }
}
