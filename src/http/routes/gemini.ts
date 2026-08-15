import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { toInternalRequest, toGeminiResponse, toGeminiStream, geminiModelList, type GeminiRequest } from "../../core/protocol/gemini.js";
import { readJson } from "../errors.js";

export function geminiRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();

  app.get("/v1beta/models", (c) => c.json(geminiModelList()));

  // Gemini 把方法名以冒号后缀附在模型名之后（如 "agnes-2.0-flash:generateContent"），
  // Hono 的静态路由段无法表达这种结构，所以用通配段接收整段原始路径，
  // 自己按最后一个冒号切分——不能按第一个冒号切，模型名本身可能含冒号。
  app.post("/v1beta/models/:rest{.+}", async (c) => {
    const rest = c.req.param("rest");
    const idx = rest.lastIndexOf(":");
    if (idx === -1) return c.json({ error: { message: "路径缺少方法名" } }, 400);
    const model = rest.slice(0, idx);
    const method = rest.slice(idx + 1);
    const stream = method === "streamGenerateContent";

    const req = await readJson<GeminiRequest>(c);
    const internal = { ...toInternalRequest(req, model), stream };
    // 超时档由 stream 决定：非流式要等上游把整段回答生成完才发响应头，与图片生成
    // 同一种延迟语义，必须用同步档（见 TimeoutProfile）。
    const res = await dispatch({
      path: "/chat/completions", body: internal, stream,
      timeout: stream ? "firstByte" : "sync", expectJson: !stream, deps,
    });
    if (!res.ok) return res;                      // 错误一律原样透传

    if (stream && res.body) {
      return new Response(toGeminiStream(res.body, model), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return c.json(toGeminiResponse(await res.json(), model));
  });

  return app;
}
