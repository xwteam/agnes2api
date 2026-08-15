import { serve } from "@hono/node-server";
import { createApp } from "../http/app.js";
import { configFromEnv } from "../core/config.js";
import { VERSION } from "../version.js";

let config: ReturnType<typeof configFromEnv>;
try {
  config = configFromEnv(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = createApp({
  version: VERSION,
  config: config!,
});
const port = Number(process.env.PORT ?? 8080);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`agnes2api listening on :${info.port}`);
});
