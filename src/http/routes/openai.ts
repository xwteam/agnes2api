import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { modelListResponse } from "../../core/protocol/openai.js";
import { httpError, readJson } from "../errors.js";
import {
  InvalidRequestError, requireArray, requireObject, requireString,
} from "../../core/protocol/request-shape.js";
import { recordUsage, type UsageRecording } from "../usage-sink.js";

/**
 * 把 `InvalidRequestError` 转成 400。与另三条路由同构，理由见 `request-shape.ts`。
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

export function openaiRoutes(deps: DispatchDeps & UsageRecording): Hono {
  const app = new Hono();

  app.get("/v1/models", (c) => c.json(modelListResponse(Math.floor(deps.now() / 1000))));

  app.post("/v1/chat/completions", async (c) => {
    const body = await readJson<{ stream?: boolean; model?: unknown }>(c);
    // 🔴 **本地校验，别把畸形请求转发上游**（2026-09-10 实测缺陷）。
    //
    // 这条路由是原样透传（不做结构转换），于是从前**一次本地校验都没有**：
    // `{"foo":1}` 会被原封不动送去上游，由上游回 400。证据是那次响应体里带着上游的
    // `"type":"AgnesAI_error"` 与上游 request id，延迟也对得上（本地拦截稳定 1.5~2ms，
    // 走上游是 25ms 量级）。
    //
    // **代价不是「多一次往返」那么轻**：上游那层 CF 约 2 次快请求就回 1015，
    // 而限流额度是**整个网关共享**的 ⇒ 一个客户端 bug 循环重试畸形请求，几秒内就能
    // 把所有人的上游通道打死。而且这条转发路径**不受注册机退避状态保护**
    //（实测容器正处在 `registrar.rate_limited` 窗口里，转发照走不误）。
    //
    // ⚠️ **只校验这条端点没它就跑不起来的三样**，不做更严的形状检查：
    // 上游接受的字段集合（tools / response_format / …）是它的事，本仓不复刻，
    // 校严了就会把上游本来接受的请求挡在门外。
    const shaped = shapeGuard(() => {
      const o = requireObject(body, "请求体");
      requireString(o.model, "model");
      requireArray(o.messages, "messages");
    });
    void shaped;
    const stream = body.stream === true;
    const startedAt = deps.now();
    // 超时档由 stream 决定：流式请求的首字节只代表「上游开始说话」，8 秒足够；
    // 非流式请求要等上游把整段回答生成完才发响应头，与图片生成是同一种延迟语义，
    // 用 8 秒去卡它会把「上游天生延迟不稳」（设计 §13：实测 0.5~18.5 秒）的 key
    // 一路记成 strike，几个请求就能把整池打进长冷却。
    const res = await dispatch({
      path: "/chat/completions", body, stream,
      timeout: stream ? "firstByte" : "sync", deps,
    });
    // Tier-2 记账。**放在 dispatch 之后、返回之前**，且**恒调用**——
    // sink 缺席时（`USAGE_STATS_ENABLED` 不为 true）`recordUsage` 第一行就 return，
    // 不建累加器、不碰存储（那条「关必须是零成本」的全局约束）。
    recordUsage(deps, {
      // ⚠️ **这里刻意不做 `String(...)` 强转**（末轮复评）：这一段在 handler 顶层，
      // **无条件求值**，比 anthropic/responses 那两条（在 `record` 闭包体里）还早
      // ——而 `recordUsage()` 的「sink 缺席就 return」在它之后 ⇒ 一个
      // `{"model":{"toString":1,"valueOf":1}}` 的请求体会让 `String()` 自己抛，
      // 把**关着统计的部署**也打成 500（全局约束 16：关必须是零成本）。
      // 归一化只在 `boundUsageKey()` 里做一次，那一侧只有开着才跑。
      protocol: "openai", model: (body.model ?? "") as string,
      // ⚠️ **归属原样取，不在这里兜底**：这一段在 handler 顶层、无条件求值
      //（比另外三条更早），兜底放在 `UsageSink.record()`——只有 Tier-2 开着才跑的
      // 那一侧，理由与上面那条 `String(...)` 完全相同。
      apiKeyId: c.get("apiKeyId"),
      ok: res.ok, stream, latencyMs: deps.now() - startedAt,
      // ⚠️ **OpenAI 这一条的 token 恒 0，而且这不是「忘了取」**（订正）：
      // 本文件是四条协议路由里唯一**不传 `expectJson`** 的一条，`dispatch()` 因此走
      // `sanitize(res)` 原样搬运，网关从头到尾没有 `JSON.parse` 过响应体。
      // usage 确实在响应里、也确实到得了客户端，只是网关没读它。
      // **这个缺口由 `GET /admin/api/capabilities` 的 `stats.tokensCoverage` 如实告诉面板**
      //（那份清单从协议目录的 `usagePath !== null` 走出来，前端不许自己再写一份），
      // 别在这里补一次 `res.clone().json()` —— 那是热路径上给每个请求加一次全量解析。
      tokensIn: 0, tokensOut: 0,
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
