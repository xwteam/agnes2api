import type { MiddlewareHandler } from "hono";

/**
 * 请求收尾把 Tier-2 用量累加器落盘。
 *
 * **逐条与 `src/http/log-flush.ts` 同形，理由同源**，这里只写与那份不同的部分，
 * 相同的三条（写在 `await next()` 之后 / 必须 `await` / `/health` 免检）
 * 的完整论证在那个文件的文件头，不在这里复述第二遍。
 *
 * ⚠️ **这个中间件只在 Tier-2 开着时被挂上**（`src/http/app.ts` 里 `usageSink`
 * 缺席就整条不挂）。**这不是优化，是全局约束 16 的一半**：关闭时不许有累加器、
 * 也不许有一条「反正没写盘」的路径挂在中间件链上——那条路径迟早会被某次改动接上写。
 * 另一半在 `recordUsage()`（`src/http/usage-sink.ts`）的第一行。
 *
 * ⚠️ **`/health` 免检这一条对用量比对事件更要紧一点**：镜像内置的 HEALTHCHECK
 * 每 30 秒来一次、永远不停，而 Tier-2 的落盘间隔是 2 小时——把落盘节奏挂在心跳上
 * 等于让一个**从不产生任何用量**的调用方去消费用量统计的写预算
 *（每天 13 次 put 的硬闸，见 `USAGE_WRITES_PER_DAY`）。
 *
 * **代价，明写**：攒着的计数要等下一个**非 `/health`** 的请求才落盘。
 * 而 Tier-2 的计数**只可能由 `/v1` / `/v1beta` 的转发请求产生**，那些请求自己
 * 就会触发这条中间件 ⇒ 「只有健康检查在跑」的部署里本来也没有任何计数要落。
 */
const NO_FLUSH_PATH = "/health";

export function usageFlush(flush: () => Promise<void>): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.path === NO_FLUSH_PATH) return;
    try { await flush(); } catch { /* 统计是旁路，绝不影响响应 */ }
  };
}
