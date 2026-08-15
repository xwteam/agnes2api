import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorResponse } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { openaiRoutes } from "./routes/openai.js";
import { anthropicRoutes } from "./routes/anthropic.js";
import { geminiRoutes } from "./routes/gemini.js";
import { responsesRoutes } from "./routes/responses.js";
import { mediaRoutes } from "./routes/media.js";
import { auth } from "./middleware/auth.js";
import type { GatewayConfig } from "../core/config.js";
import type { DispatchDeps } from "../core/dispatcher.js";
import type { StorageHealth } from "../core/storage-health.js";

export interface AppDeps extends DispatchDeps {
  version: string;
  config: GatewayConfig;
  storageHealth: StorageHealth;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // 没有这个兜底时，任何未捕获异常都会变成 Hono 默认的 `500 Internal Server Error`
  // 纯文本响应——四种协议的客户端 SDK 都会在解析 JSON 时二次报错，拿不到任何线索。
  // 只输出固定文案，不回显 err.message：异常信息里可能含上游 URL、栈帧等内部细节。
  app.onError((err) => {
    if (err instanceof HTTPException) return err.getResponse();
    return errorResponse(500, "internal_error", "网关内部错误");
  });

  app.route("/", healthRoutes(deps.version, deps.storageHealth));
  app.use("/v1/*", auth(deps.config.gatewayToken));
  app.use("/v1beta/*", auth(deps.config.gatewayToken));
  app.route("/", openaiRoutes(deps));
  app.route("/", anthropicRoutes(deps));
  app.route("/", geminiRoutes(deps));
  app.route("/", responsesRoutes(deps));
  app.route("/", mediaRoutes(deps));
  return app;
}
