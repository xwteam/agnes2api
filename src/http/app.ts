import { Hono } from "hono";
import { healthRoutes } from "./routes/health.js";

export interface AppDeps {
  version: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route("/", healthRoutes(deps.version));
  return app;
}
