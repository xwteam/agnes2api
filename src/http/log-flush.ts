import type { MiddlewareHandler } from "hono";

/**
 * 请求收尾把事件缓冲落盘。
 *
 * **必须写在 `await next()` 之后**（与全局 nosniff 同一条理由的另一面）：
 * 写在前面的话，本次请求自己产生的事件根本还没进缓冲。
 *
 * **必须 `await`**：fire-and-forget 在 Worker 上会被响应返回后的 isolate 停摆截断，
 * 而那正是「事件板块看不到刚发生的事」这类最难查的失效。
 * 代价：触发落盘的那一个请求会多等一次存储写（约每分钟一次，且有每小时预算封顶）。
 * 这个代价是显式的、可测的，比一个偶尔丢事件的旁路诚实。
 *
 * `maybeFlush` 自身**永不抛**（内部全量 try/catch），所以这里不必再包一层——
 * 但仍然包了：多一层的成本是零，而「日志把请求搞挂」的代价是全部流量。
 */
export function logFlush(flush: () => Promise<void>): MiddlewareHandler {
  return async (c, next) => {
    await next();
    try { await flush(); } catch { /* 日志是旁路，绝不影响响应 */ }
  };
}
