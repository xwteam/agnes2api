import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

/**
 * 网关自己产生的错误一律走这个信封：`{ error: { type, message } }`，
 * 与四种协议的错误体形状一致，客户端 SDK 解析得动。
 */
export function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 抛出后由 app.onError 转成上面的信封，供路由里做提前返回。 */
export function httpError(status: number, type: string, message: string): HTTPException {
  return new HTTPException(status as never, { res: errorResponse(status, type, message) });
}

/**
 * 解析客户端请求体。
 *
 * 直接用 `c.req.json()` 时，畸形 JSON 抛出的 SyntaxError 会一路冒泡成 500 纯文本
 * ——把客户端错误报成服务端错误，且响应不是 JSON，SDK 无法解析。这里统一转成 400。
 */
export async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw httpError(400, "invalid_request_error", "请求体不是合法的 JSON");
  }
}
