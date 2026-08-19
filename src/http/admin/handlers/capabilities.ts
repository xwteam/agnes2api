import type { Context } from "hono";
import type { RuntimeInfo } from "../../../ports/runtime.js";
import type { StorageHealth } from "../../../core/storage-health.js";

/**
 * **双运行时差异的唯一出口**（设计文档 §11）。面板启动时调一次，
 * 所有形态分支读它——不许 `runtime === "worker"` 散落进 8 个板块。
 *
 * **零存储读**：全部来自内存（注入的 RuntimeInfo + StorageHealth 的内存状态 +
 * 装配时算好的 envLocked）。它是面板启动必调的第一个接口，
 * 让它去读一次存储就等于给每次刷新加一次 KV 读。
 */
export function capabilitiesHandler(deps: {
  runtime: RuntimeInfo;
  storageHealth: StorageHealth;
  version: string;
}) {
  return (c: Context) => {
    // `cf` 只在 Cloudflare 边缘存在。**取不到就如实 null**，不伪造一个 "unknown"。
    const cf = (c.req.raw as { cf?: { colo?: unknown } }).cf;
    const colo = typeof cf?.colo === "string" && cf.colo !== "" ? cf.colo : null;
    return c.json({
      version: deps.version,
      runtime: { name: deps.runtime.name, colo },
      storage: { backend: deps.runtime.storageBackend, writable: deps.storageHealth.status().writable },
      quota: { model: deps.runtime.quotaModel },
      process: { metrics: deps.runtime.process() !== null },
      logs: {
        /**
         * 进程内日志区。**两种运行时都是 false，这是本期的刻意选择。**
         * 设计文档 §7.2 想在 Node 侧多一个「进程日志」区（MemoryLogger），
         * 但那会让 P3b 的双运行时冒烟多出一整套只在一侧存在的分支。
         * 本期先把两种形态的事件板块做成完全一样的，登记 P3c。
         * 事件板块顶部**两种形态都写**同一句：逐请求日志请看容器 stdout /
         * Cloudflare 控制台的 Workers Logs。
         */
        processLog: false,
      },
      stats: {
        /** Tier-2 时间序列是 P3d。**这里如实报 false**，面板据此渲染说明卡而不是空图表。 */
        tier2Enabled: false,
      },
    });
  };
}
