import { serve } from "@hono/node-server";
import { createApp } from "../http/app.js";
import { VERSION } from "../version.js";

const app = createApp({ version: VERSION });
const port = Number(process.env.PORT ?? 8080);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`agnes2api listening on :${info.port}`);
});
