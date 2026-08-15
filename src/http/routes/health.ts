import { Hono } from "hono";

export function healthRoutes(version: string): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", version }));
  return app;
}
