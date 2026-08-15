import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { toInternalRequest, toAnthropicResponse, toAnthropicStream, type AnthropicRequest } from "../../core/protocol/anthropic.js";

export function anthropicRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    const req = await c.req.json<AnthropicRequest>();
    const internal = toInternalRequest(req);
    const res = await dispatch({
      path: "/chat/completions", body: internal, stream: internal.stream, deps,
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
