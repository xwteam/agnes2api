import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { modelListResponse } from "../../core/protocol/openai.js";
import { readJson } from "../errors.js";

export function openaiRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();

  app.get("/v1/models", (c) => c.json(modelListResponse(Math.floor(deps.now() / 1000))));

  app.post("/v1/chat/completions", async (c) => {
    const body = await readJson<{ stream?: boolean }>(c);
    const stream = body.stream === true;
    // 超时档由 stream 决定：流式请求的首字节只代表「上游开始说话」，8 秒足够；
    // 非流式请求要等上游把整段回答生成完才发响应头，与图片生成是同一种延迟语义，
    // 用 8 秒去卡它会把「上游天生延迟不稳」（设计 §13：实测 0.5~18.5 秒）的 key
    // 一路记成 strike，几个请求就能把整池打进长冷却。
    const res = await dispatch({
      path: "/chat/completions", body, stream,
      timeout: stream ? "firstByte" : "sync", deps,
    });
    // OpenAI 即内部规范格式，事件负载原样透传，不做任何转换；
    // 仅在确认是成功的流式响应时补齐 SSE 的 Content-Type
    // ——上游（或测试替身）不一定会设置该头，但客户端要靠它识别流式响应。
    // 用 Headers 在 dispatch 已按白名单裁剪过的响应头基础上追加，而不是整体替换，
    // 否则会把 cache-control 一并丢掉。
    if (stream && res.ok) {
      const headers = new Headers(res.headers);
      headers.set("content-type", "text/event-stream; charset=utf-8");
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  });

  return app;
}
