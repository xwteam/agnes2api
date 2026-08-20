import type { Logger, LogEntry } from "../ports/logger.js";

/**
 * 把多个 sink 串起来。**任何一个 sink 抛错都不许影响别的 sink，更不许影响调用方**——
 * 日志是旁路，把主流程搞挂是本末倒置。
 */
export function multiLogger(...sinks: readonly Logger[]): Logger {
  return {
    log(e: Omit<LogEntry, "ts">) {
      for (const s of sinks) {
        try { s.log(e); } catch { /* sink 故障不许扩散 */ }
      }
    },
  };
}
