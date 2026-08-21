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
    /**
     * **fire-and-forget，并且刻意一眼都不看 `ctx`。**
     *
     * Node 是长寿进程：响应返回之后这个 promise 照样跑得完，不需要任何载体。
     * `ctx` 参数在这里恒为 `null`（Hono 的 `c.executionCtx` 在 node-server 上没有值），
     * 但**即使调用方传了一个进来也不许用它**——那会让 Node 侧的行为取决于一个只有
     * Worker 才有的东西，双运行时差异就从"被断言的"退回"被容忍的"。
     *
     * `void` 不吞异常：任务自己的 `catch` 是唯一的兜底（见手动补池那个 handler）。
     * 这里不加 `.catch()` 是刻意的——加了就等于**在适配器里静默吃掉调用方的错误**，
     * 而 Worker 那一侧的 `waitUntil` 同样不会替谁吞异常，两侧必须同形。
     */
    background(task: Promise<unknown>): void {
      void task;
    },
  };
}
