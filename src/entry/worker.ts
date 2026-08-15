import { buildApp, buildTendDeps } from "../http/wire.js";
import { KvStorage } from "../adapters/storage-kv.js";
import { tendOnce } from "../core/registrar/tender.js";
import type { Hono } from "hono";

export interface Env {
  GATEWAY_TOKEN?: string;
  POOL: KVNamespace;
  [k: string]: unknown;
}

let cachedApp: Hono | null = null;
let cachedToken: string | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let app = cachedApp;

    // token 变化或还未初始化时才重新装配；装配失败绝不复用旧缓存
    // （旧 token 对应的旧 app 可能已经不该再服务当前请求）。
    if (!app || cachedToken !== env.GATEWAY_TOKEN) {
      try {
        app = await buildApp(env as Record<string, string | undefined>, new KvStorage(env.POOL));
      } catch (err) {
        return new Response((err as Error).message, { status: 500 });
      }
      cachedApp = app;
      cachedToken = env.GATEWAY_TOKEN;
    }

    return app.fetch(req);
  },

  /**
   * Cron 触发的补池入口。`wrangler.toml` 里的 `[triggers]` 配了触发频率，平台按
   * 该频率调用这个导出——与 Node 侧命令式的 `setInterval` 不同，这里是声明式的，
   * 触发本身不需要我们自己起定时器。
   *
   * 装配依赖失败或补池失败都只记日志、不重新抛出：一次 Cron 调用失败不该影响
   * 下一次调度，也不该影响 fetch() 处理的正常转发请求。
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    let deps;
    try {
      deps = await buildTendDeps(env as Record<string, string | undefined>, new KvStorage(env.POOL));
    } catch (err) {
      console.error("[registrar] 装配补池依赖失败", err);
      return;
    }
    if (!deps) return; // 注册机未启用：零副作用

    ctx.waitUntil(
      tendOnce(deps)
        .then((r) => {
          if (!r.skipped) {
            console.log(
              `[registrar] 补池完成 available=${r.available} attempted=${r.attempted} minted=${r.minted}`,
            );
          }
        })
        .catch((err) => {
          console.error("[registrar] 补池失败", err);
        }),
    );
  },
};
