import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { toInternalRequest, toAnthropicResponse, toAnthropicStream, UnsupportedContentError, type AnthropicRequest } from "../../core/protocol/anthropic.js";
import { httpError, readJson } from "../errors.js";
import { InvalidRequestError } from "../../core/protocol/request-shape.js";
import { recordUsage, upstreamTokens, type UsageRecording } from "../usage-sink.js";

export function anthropicRoutes(deps: DispatchDeps & UsageRecording): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    const req = await readJson<AnthropicRequest>(c);

    let internal: ReturnType<typeof toInternalRequest>;
    try {
      internal = toInternalRequest(req);
    } catch (e) {
      // 🔴 **catch 的是基类 `InvalidRequestError`，不是 `UnsupportedContentError`。**
      // 上一版只 catch 了内容块那一种，于是同一条路由上「漏写 messages」抛的是裸
      // TypeError ⇒ 被 onError 兜成 500「网关内部错误」。实测：`{"model":"…"}`
      // （模型名合法、只是少传 messages）在这条路由上就是 500——不是构造出来的畸形
      // 输入，是真实客户端很容易犯的错，而用户会以为网关挂了来报障。
      // 无法无损转换的内容块仍走这里（它现在是基类的子类）。
      if (e instanceof InvalidRequestError) {
        throw httpError(400, "invalid_request_error", e.message);
      }
      throw e;
    }

    // 超时档由 stream 决定：非流式要等上游把整段回答生成完才发响应头，与图片生成
    // 同一种延迟语义，必须用同步档（见 TimeoutProfile）。
    const startedAt = deps.now();
    const res = await dispatch({
      path: "/chat/completions", body: internal, stream: internal.stream,
      timeout: internal.stream ? "firstByte" : "sync",
      expectJson: !internal.stream, deps,
    });
    /**
     * Tier-2 记账。**三条返回路径各记一次，一条都不许漏**：
     * 少记失败那一条 ⇒ 面板上的错误率恒为 0；少记流式那一条 ⇒ `streamingRequests`
     * 恒为 0，而那一栏存在的唯一理由就是让「这些请求没有 token」这个缺口可见。
     *
     * `latencyMs` 在 dispatch 一返回就定死，**不含本地那次 `res.json()` 与协议转换**
     * ——它要度量的是上游那一趟往返，把本地解析算进去会让「上游慢」与「网关慢」
     * 混成一个数（而桶里只有 `ok` 的请求进 `latencySum`，见 `UsageBucket`）。
     */
    const latencyMs = deps.now() - startedAt;
    const record = (tokensIn: number, tokensOut: number) => recordUsage(deps, {
      // ⚠️ **这里刻意不做 `String(...)` 强转**（收口复评）：这一段在
      // `record` 闭包体里，**而它在「Tier-2 关着就 return」之前求值** ⇒ 一个
      // `{"model":{"toString":1,"valueOf":1}}` 的请求体会让 `String()` 自己抛，
      // 把**关着统计的部署**也打成 500（全局约束 16：关必须是零成本）。
      // 归一化只在 `boundUsageKey()` 里做一次，那一侧只有开着才跑。
      protocol: "anthropic", model: (req.model ?? "") as string,
      // ⚠️ **归属原样取，不在这里兜底**：这一行在「Tier-2 关着就 return」之前求值，
      // 兜底放在 `UsageSink.record()`（只有开着才跑的那一侧），
      // 理由见 `UsageOutcome.apiKeyId` 上方那段。
      apiKeyId: c.get("apiKeyId"),
      ok: res.ok, stream: internal.stream, latencyMs, tokensIn, tokensOut,
    });

    if (!res.ok) { record(0, 0); return res; }    // 错误一律原样透传

    if (internal.stream && res.body) {
      // 流式没有 token：响应体是一条流，网关不聚合它（聚合就等于把整段回答缓存在
      // 内存里，Worker 上直接顶到内存上限）。`streamingRequests` 单列一栏正是为此。
      record(0, 0);
      return new Response(toAnthropicStream(res.body, req.model), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    // **只解析一遍**：这一份既喂给协议转换，也喂给记账。
    const upstream = await res.json();
    const t = upstreamTokens(upstream);
    record(t.tokensIn, t.tokensOut);
    return c.json(toAnthropicResponse(upstream, req.model));
  });

  return app;
}
