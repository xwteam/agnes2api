import { Hono } from "hono";
import { healthRoutes } from "./routes/health.js";
import { auth } from "./middleware/auth.js";
import type { GatewayConfig } from "../core/config.js";

export interface AppDeps {
  version: string;
  config: GatewayConfig;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route("/", healthRoutes(deps.version));
  app.use("/v1/*", auth(deps.config.gatewayToken));
  app.use("/v1beta/*", auth(deps.config.gatewayToken));
  return app;
}
