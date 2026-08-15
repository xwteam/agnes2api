import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { toInternalRequest, toResponsesResponse, toResponsesStream, type ResponsesRequest } from "../../core/protocol/responses.js";
import { readJson } from "../errors.js";

export function responsesRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();

  app.post("/v1/responses", async (c) => {
    const req = await readJson<ResponsesRequest>(c);
    const internal = toInternalRequest(req);
    // 超时档由 stream 决定：非流式要等上游把整段回答生成完才发响应头，与图片生成
    // 同一种延迟语义，必须用同步档（见 TimeoutProfile）。
    const res = await dispatch({
      path: "/chat/completions", body: internal, stream: internal.stream,
      timeout: internal.stream ? "firstByte" : "sync",
      expectJson: !internal.stream, deps,
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
