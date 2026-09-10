import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

/**
 * 网关自己产生的错误一律走这个信封：`{ error: { type, message } }`，
 * 与四种协议的错误体形状一致，客户端 SDK 解析得动。
 *
 * `extraHeaders` 是给**协议要求响应头**的那几档留的口子，今天只有一个用户：
 * 405 必须带 `Allow`（RFC 9110 §15.5.6 是 MUST）。刻意做成可选形参而不是让调用方
 * 自己 `new Response`——信封只能有一个出口，否则「哪天要给 `error` 加一个字段」
 * 会漏掉绕过去的那几处（`src/http/admin/handlers/usage.ts` 那条同样措辞的告诫）。
 * ⚠️ 它**在 `content-type` 之后展开**，也就是理论上能覆盖掉 `application/json`；
 * 别拿它干这件事，信封的类型就是信封的一部分。
 */
export function errorResponse(
  status: number,
  type: string,
  message: string,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
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
