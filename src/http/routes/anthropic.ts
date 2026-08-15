import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { toInternalRequest, toAnthropicResponse, toAnthropicStream, UnsupportedContentError, type AnthropicRequest } from "../../core/protocol/anthropic.js";
import { httpError, readJson } from "../errors.js";

export function anthropicRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    const req = await readJson<AnthropicRequest>(c);

    let internal: ReturnType<typeof toInternalRequest>;
    try {
      internal = toInternalRequest(req);
    } catch (e) {
      // 无法无损转换的内容块是客户端请求的问题，明确告知而不是悄悄丢掉。
      if (e instanceof UnsupportedContentError) {
        throw httpError(400, "invalid_request_error", e.message);
      }
      throw e;
    }

    const res = await dispatch({
      path: "/chat/completions", body: internal, stream: internal.stream,
      expectJson: !internal.stream, deps,
    });

    if (!res.ok) return res;                      // 错误一律原样透传

    if (internal.stream && res.body) {
      return new Response(toAnthropicStream(res.body, req.model), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return c.json(toAnthropicResponse(await res.json(), req.model));
  });

  return app;
}
