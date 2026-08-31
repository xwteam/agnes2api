import type { MiddlewareHandler } from "hono";
import type { ConfigHolder } from "./config-holder.js";

/**
 * 每请求把配置刷到不早于一个 TTL。**必须是 createApp 里的第一个 use**——
 * 已实测：把 route 写在 use 之前，中间件会静默失效且不报错。
 *
 * **不是缺陷（写清楚，别以为是遗漏）：这个中间件跑在鉴权之前，匿名流量也会
 * 触发它。** 但刷新是 **TTL 界定**的：每个 isolate 每天最多 `86400 / CONFIG_TTL_MS`
 * 次（默认 30 秒 TTL ⇒ 2,880 次/天），**与请求数、与是否鉴权全都无关**——
 * 一个没有鉴权信息的攻击者狂发未授权请求，不会让这个数变大一分。
 * 要挡匿名刷新就得把鉴权提到刷新之前，而 `/v1` 的鉴权口令**就在配置里**
 *（`ensureFresh()` 之后才能读到最新的 `gatewayToken`），顺序反不过来。
 */
export function configRefresh(holder: ConfigHolder): MiddlewareHandler {
  return async (c, next) => {
    // /health 刻意不触发任何存储 IO。这是一开始就定下来的既有契约
    //（src/http/routes/health.ts 的注释 + tests/contract/wiring.test.ts 的断言）：
    // 镜像内置的 HEALTHCHECK 每 30 秒来一次，不该在 KV 上换成每 30 秒一次读。
    if (c.req.path !== "/health") await holder.ensureFresh();
    await next();
  };
}
