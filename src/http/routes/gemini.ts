import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { toInternalRequest, toGeminiResponse, toGeminiStream, geminiModelList, type GeminiRequest } from "../../core/protocol/gemini.js";
import { readJson } from "../errors.js";
import { recordUsage, upstreamTokens, type UsageRecording } from "../usage-sink.js";

export function geminiRoutes(deps: DispatchDeps & UsageRecording): Hono {
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
    const startedAt = deps.now();
    const res = await dispatch({
      path: "/chat/completions", body: internal, stream,
      timeout: stream ? "firstByte" : "sync", expectJson: !stream, deps,
    });
    // Tier-2 记账。三条返回路径各记一次，完整理由见 `routes/anthropic.ts`
    // 里同位置那段。
    // ⚠️ **模型名取的是路径里切出来的那个 `model`**，不是请求体——Gemini 协议把模型名
    // 放在路径上（`/v1beta/models/{model}:generateContent`），请求体里根本没有这一格。
    const latencyMs = deps.now() - startedAt;
    const record = (tokensIn: number, tokensOut: number) => recordUsage(deps, {
      protocol: "gemini", model,
      ok: res.ok, stream, latencyMs, tokensIn, tokensOut,
    });

    if (!res.ok) { record(0, 0); return res; }    // 错误一律原样透传

    if (stream && res.body) {
      record(0, 0);
      return new Response(toGeminiStream(res.body, model), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    const upstream = await res.json();
    const t = upstreamTokens(upstream);
    record(t.tokensIn, t.tokensOut);
    return c.json(toGeminiResponse(upstream, model));
  });

  return app;
}
