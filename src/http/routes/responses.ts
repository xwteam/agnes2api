import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { toInternalRequest, toResponsesResponse, toResponsesStream, type ResponsesRequest } from "../../core/protocol/responses.js";

export function responsesRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();

  app.post("/v1/responses", async (c) => {
    const req = await c.req.json<ResponsesRequest>();
    const internal = toInternalRequest(req);
    const res = await dispatch({
      path: "/chat/completions", body: internal, stream: internal.stream, deps,
    });

    if (!res.ok) return res;                      // 错误一律原样透传

    if (internal.stream && res.body) {
      return new Response(toResponsesStream(res.body, req.model), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return c.json(toResponsesResponse(await res.json(), req.model));
  });

  return app;
}
