import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { toInternalRequest, toResponsesResponse, toResponsesStream, type ResponsesRequest } from "../../core/protocol/responses.js";
import { readJson } from "../errors.js";
import { recordUsage, upstreamTokens, type UsageRecording } from "../usage-sink.js";

export function responsesRoutes(deps: DispatchDeps & UsageRecording): Hono {
  const app = new Hono();

  app.post("/v1/responses", async (c) => {
    const req = await readJson<ResponsesRequest>(c);
    const internal = toInternalRequest(req);
    // 超时档由 stream 决定：非流式要等上游把整段回答生成完才发响应头，与图片生成
    // 同一种延迟语义，必须用同步档（见 TimeoutProfile）。
    const startedAt = deps.now();
    const res = await dispatch({
      path: "/chat/completions", body: internal, stream: internal.stream,
      timeout: internal.stream ? "firstByte" : "sync",
      expectJson: !internal.stream, deps,
    });
    // Tier-2 记账（P3d Task 3）。三条返回路径各记一次，完整理由见 `routes/anthropic.ts`
    // 里同位置那段（三条协议这一段是逐字同构的，那里写一遍就够）。
    const latencyMs = deps.now() - startedAt;
    const record = (tokensIn: number, tokensOut: number) => recordUsage(deps, {
      // 同 `routes/anthropic.ts`：**刻意不强转**，归一化只在 `boundUsageKey()` 里
      // 做一次（收口复评 H1）。
      protocol: "responses", model: (req.model ?? "") as string,
      ok: res.ok, stream: internal.stream, latencyMs, tokensIn, tokensOut,
    });

    if (!res.ok) { record(0, 0); return res; }    // 错误一律原样透传

    if (internal.stream && res.body) {
      record(0, 0);
      return new Response(toResponsesStream(res.body, req.model), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    const upstream = await res.json();
    const t = upstreamTokens(upstream);
    record(t.tokensIn, t.tokensOut);
    return c.json(toResponsesResponse(upstream, req.model));
  });

  return app;
}
