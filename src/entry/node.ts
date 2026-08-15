import { serve } from "@hono/node-server";
import { createApp } from "../http/app.js";
import { configFromEnv } from "../core/config.js";
import { KeyPoolRepo } from "../core/dispatcher.js";
import { NativeFetcher } from "../adapters/fetcher-native.js";
import { FileStorage } from "../adapters/storage-file.js";
import { VERSION } from "../version.js";

let config: ReturnType<typeof configFromEnv>;
try {
  config = configFromEnv(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const storage = new FileStorage(process.env.DATA_DIR ?? "/app/data");

const app = createApp({
  version: VERSION,
  config: config!,
  repo: new KeyPoolRepo(storage),
  fetcher: new NativeFetcher(),
  now: () => Date.now(),
});
const port = Number(process.env.PORT ?? 8080);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`agnes2api listening on :${info.port}`);
});
