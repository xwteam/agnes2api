import { createApp } from "../http/app.js";
import { configFromEnv } from "../core/config.js";
import { KeyPoolRepo } from "../core/dispatcher.js";
import { NativeFetcher } from "../adapters/fetcher-native.js";
import { KvStorage } from "../adapters/storage-kv.js";
import { VERSION } from "../version.js";

interface Env {
  GATEWAY_TOKEN?: string;
  POOL: KVNamespace;
  [k: string]: unknown;
}

let cachedApp: ReturnType<typeof createApp> | null = null;
let cachedToken: string | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const token = env.GATEWAY_TOKEN;
    let app = cachedApp;

    // 如果 token 变化或还未初始化，重新构造 app
    if (!app || cachedToken !== token) {
      try {
        const config = configFromEnv(env as unknown as Record<string, string | undefined>);
        app = createApp({
          version: VERSION,
          config,
          repo: new KeyPoolRepo(new KvStorage(env.POOL)),
          fetcher: new NativeFetcher(),
          now: () => Date.now(),
        });
        cachedApp = app;
        cachedToken = token;
      } catch (err) {
        return new Response((err as Error).message, { status: 500 });
      }
    }

    return app.fetch(req);
  },
};
