import { Hono } from "hono";
import { healthRoutes } from "./routes/health.js";
import { openaiRoutes } from "./routes/openai.js";
import { anthropicRoutes } from "./routes/anthropic.js";
import { auth } from "./middleware/auth.js";
import type { GatewayConfig } from "../core/config.js";
import type { DispatchDeps } from "../core/dispatcher.js";

export interface AppDeps extends DispatchDeps {
  version: string;
  config: GatewayConfig;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route("/", healthRoutes(deps.version));
  app.use("/v1/*", auth(deps.config.gatewayToken));
  app.use("/v1beta/*", auth(deps.config.gatewayToken));
  app.route("/", openaiRoutes(deps));
  app.route("/", anthropicRoutes(deps));
  return app;
}
