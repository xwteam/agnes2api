import type { MiddlewareHandler } from "hono";

/**
 * 请求收尾把事件缓冲落盘。
 *
 * **必须写在 `await next()` 之后**（与全局 nosniff 同一条理由的另一面）：
 * 写在前面的话，本次请求自己产生的事件根本还没进缓冲。
 *
 * **必须 `await`**：fire-and-forget 在 Worker 上会被响应返回后的 isolate 停摆截断，
 * 而那正是「事件板块看不到刚发生的事」这类最难查的失效。
 * 代价：触发落盘的那一个请求会多等一次存储写（约每分钟一次，且有每天预算封顶）。
 * 这个代价是显式的、可测的，比一个偶尔丢事件的旁路诚实。
 *
 * `maybeFlush` 自身**永不抛**（内部全量 try/catch），所以这里不必再包一层——
 * 但仍然包了：多一层的成本是零，而「日志把请求搞挂」的代价是全部流量。
 *
 * ⚠️ **`/health` 免检，与 `configRefresh` 同一条既有契约**（全分支评审 I1）。
 * 在这条豁免出现之前，`/health` 是**唯一一条会违反那条契约的路径**：缓冲里只要
 * 攒着事件，一次健康检查就会连带一次 `get` + 一次 `put`。而
 * `src/http/routes/health.ts:17` 与 `src/http/config-refresh.ts:17` 两处都白纸黑字
 * 写着「`/health` 不触发任何存储 I/O」——那句话当时对读成立、对写不成立。
 *
 * 修的是这一侧而不是那两句话，理由是**存活探针不该依赖存储**：
 * ① 镜像内置的 HEALTHCHECK 每 30 秒来一次、永远不停，把落盘节奏挂在一条与业务
 *    无关的心跳上，等于让写配额被一个不产生任何价值的调用方驱动；
 * ② 这里是 `await` 的，存储一慢，慢的就是健康检查本身 ⇒ 容器被判 unhealthy 而
 *    重启，**而它要报告的恰恰就是「存储有问题」**——把诊断信号变成了故障放大器。
 *
 * **代价，明写**：缓冲里的事件要等下一个**非 `/health`** 的请求才落盘。面板自己的
 * 事件轮询就是这样的请求（15~60 秒一次），所以「开着面板时看不到刚发生的事」这件
 * 事不会因此变糟；真正零流量的部署里，事件本来也要等 `EVENT_FLUSH_MIN_INTERVAL_MS`
 * 才落，且 isolate 被回收时那批缓冲本来就会丢（响应里的 `buffered` 字段就是为这件
 * 事存在的）。这三段行为由 `tests/contract/wiring.test.ts:260` 那一格逐段钉住。
 */
const NO_FLUSH_PATH = "/health";

export function logFlush(flush: () => Promise<void>): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.path === NO_FLUSH_PATH) return;
    try { await flush(); } catch { /* 日志是旁路，绝不影响响应 */ }
  };
}
