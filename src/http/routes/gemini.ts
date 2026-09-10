import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { toInternalRequest, toGeminiResponse, toGeminiStream, geminiModelList, type GeminiRequest } from "../../core/protocol/gemini.js";
import { httpError, readJson } from "../errors.js";
import { InvalidRequestError } from "../../core/protocol/request-shape.js";
import { recordUsage, upstreamTokens, type UsageRecording } from "../usage-sink.js";

/**
 * 把 `InvalidRequestError` 转成 400。
 *
 * 🔴 **catch 的是基类，不是某一种具体错误。** 上一版 Anthropic 那条只 catch 了
 * `UnsupportedContentError`，于是同一条路由上「漏写 messages」照样抛裸 TypeError
 * ⇒ 被 onError 兜成 **500「网关内部错误」**，把客户端的错报成服务端的错。
 * 客户端错误必须是 4xx：OpenAI 官方 SDK 对 5xx 默认重试 2 次，一个永远修不好的
 * 请求会被放大成 3 倍，而上游那层 CF 的限流额度是整个网关共享的。
 */
function shapeGuard<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof InvalidRequestError) {
      throw httpError(400, "invalid_request_error", e.message);
    }
    throw e;
  }
}

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

    /**
     * 🔴 **方法名白名单**（2026-09-10 实测缺陷）。从前这里一个字都不校验，
     * 于是 `:countTokens` / `:embedContent` / 拼错的 `:generatecontent`
     * **统统落进 generateContent 这个 handler，真打一次上游对话**。
     * 实测：带合法 `contents` 打 `:countTokens` 返回 **200**，正文是一段真回答、
     * `candidatesTokenCount: 43` —— 一次「数一下 token」被当成完整对话烧掉了。
     *
     * 代价链：① 白烧池中一把 key 的一次上游调用；② 吃掉 Agnes 前面那层 CF 的
     * **全网关共享**限流额度（本仓自己记着「约 2 次快请求就回 1015」）；
     * ③ 客户端拿回的是 `candidates` 结构，解析 `totalTokens` 拿到 undefined
     * ——「计数功能坏了」与「所有人的通道莫名被限流」在面板上看不出因果。
     * 而 `google-genai` 的 `client.models.count_tokens()`、以及一切在发正式请求前
     * 先探一次 token 数的框架，走的正是这条路。
     *
     * 纯本地判断、零上游成本，与 `routes/openai.ts` 那段「本地校验，别把畸形请求
     * 转发上游」是同一条道理，只是当时没覆盖到方法名这一维。
     *
     * ⚠️ **404 而不是 400**：请求体没有错，是这条端点本网关没实现——真 Gemini 对
     * 不认识的方法给的也是 NOT_FOUND。（上面「路径缺少方法名」那条仍是 400：
     * 那是路径本身写坏了。）
     */
    if (method !== "generateContent" && method !== "streamGenerateContent") {
      throw httpError(404, "not_found_error",
        `本网关只实现 generateContent 与 streamGenerateContent 两个方法，不认识 ${method}`);
    }
    const stream = method === "streamGenerateContent";

    const req = await readJson<GeminiRequest>(c);
    const internal = { ...shapeGuard(() => toInternalRequest(req, model)), stream };
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
      // ⚠️ **归属原样取，不在这里兜底**：这一行在「Tier-2 关着就 return」之前求值，
      // 兜底放在 `UsageSink.record()`（只有开着才跑的那一侧），
      // 理由见 `UsageOutcome.apiKeyId` 上方那段。
      apiKeyId: c.get("apiKeyId"),
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
