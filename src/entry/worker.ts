import { createApp } from "../http/app.js";
import { configFromEnv } from "../core/config.js";
import { VERSION } from "../version.js";

let cachedApp: ReturnType<typeof createApp> | null = null;
let cachedToken: string | undefined;

export default {
  async fetch(req: Request, env: Record<string, string | undefined>): Promise<Response> {
    const token = env.GATEWAY_TOKEN;
    let app = cachedApp;

    // 如果 token 变化或还未初始化，重新构造 app
    if (!app || cachedToken !== token) {
      try {
        const config = configFromEnv(env);
        app = createApp({
          version: VERSION,
          config,
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
