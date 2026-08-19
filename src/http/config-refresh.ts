import type { MiddlewareHandler } from "hono";
import type { ConfigHolder } from "./config-holder.js";

/**
 * 每请求把配置刷到不早于一个 TTL。**必须是 createApp 里的第一个 use**——
 * 已实测：把 route 写在 use 之前，中间件会静默失效且不报错。
 */
export function configRefresh(holder: ConfigHolder): MiddlewareHandler {
  return async (c, next) => {
    // /health 刻意不触发任何存储 IO。这是 P1 定下来的既有契约
    //（src/http/routes/health.ts 的注释 + tests/contract/wiring.test.ts 的断言）：
    // 镜像内置的 HEALTHCHECK 每 30 秒来一次，不该在 KV 上换成每 30 秒一次读。
    if (c.req.path !== "/health") await holder.ensureFresh();
    await next();
  };
}
