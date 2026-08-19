import type { RuntimeInfo, ProcessMetrics } from "../ports/runtime.js";

/**
 * Node/Docker 侧。`process.*` 在这里是**职责**——适配器就是隔离运行时能力的那一层，
 * `src/core/` 的零 IO 门禁扫不到这里，也不该扫。
 */
export function nodeRuntime(): RuntimeInfo {
  return {
    name: "node",
    storageBackend: "file",
    quotaModel: "file",
    process(): ProcessMetrics {
      const mem = process.memoryUsage();
      return {
        pid: process.pid,
        rssBytes: mem.rss,
        // 秒 → 毫秒。面板统一用毫秒，免得每个板块各自换算一遍。
        uptimeMs: Math.trunc(process.uptime() * 1000),
      };
    },
  };
}
