import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { modelListResponse } from "../../core/protocol/openai.js";

export function openaiRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();

  app.get("/v1/models", (c) => c.json(modelListResponse(Math.floor(deps.now() / 1000))));

  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json<{ stream?: boolean }>();
    const stream = body.stream === true;
    const res = await dispatch({ path: "/chat/completions", body, stream, deps });
    // OpenAI 即内部规范格式，事件负载原样透传，不做任何转换；
    // 仅在确认是成功的流式响应时补齐 SSE 的 Content-Type
    // ——上游（或测试替身）不一定会设置该头，但客户端要靠它识别流式响应。
    if (stream && res.ok) {
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    return res;
  });

  return app;
}
