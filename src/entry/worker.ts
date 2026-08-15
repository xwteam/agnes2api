import { buildApp } from "../http/wire.js";
import { KvStorage } from "../adapters/storage-kv.js";
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
};
