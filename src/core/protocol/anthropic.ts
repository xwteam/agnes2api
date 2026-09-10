import {
  requireArray, requireObject, requireString,
  UnsupportedContentError, UnsupportedParamError,
} from "./request-shape.js";
import { parseSseStream, sseEvent, toSseStream } from "./sse.js";

/**
 * ⚠️ **`UnsupportedContentError` 的定义 2026-09-10 挪去了 `./request-shape.js`**
 * （gemini / responses 两条协议现在也用它，理由写在那边它自己上方）。
 * 这里原样再导出一次，让 `src/http/routes/anthropic.ts` 与
 * `tests/unit/anthropic.test.ts` 的既有 import 路径继续成立 —— 类的身份只有一个，
 * `instanceof` 在两条 import 路径上是同一个答案。
 */
export { UnsupportedContentError };

export interface AnthropicContentPart { type: string; text?: string }
export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  /**
   * Anthropic 官方允许 `system` 是字符串**或**内容块数组——所有开启 prompt caching
   * 的 SDK 都是用数组形式发的。原实现把它标成 string 并直接塞进 messages，
   * 数组就会以裸数组的形式发给上游（content 不是字符串），上游只能报错。
   */
  system?: string | AnthropicContentPart[];
  stream?: boolean;
  messages: { role: string; content: string | AnthropicContentPart[] }[];
  /** 见 `UnsupportedParamError` 上方那张三档表：①透传。 */
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  /** ②上游没有这一格。 */
  top_k?: number;
  /** ③传得过去但响应转换不了。 */
  tools?: unknown;
  tool_choice?: unknown;
}

function flatten(content: string | AnthropicContentPart[]): string {
  if (typeof content === "string") return content;
  let out = "";
  for (const p of content) {
    if (p.type !== "text") throw new UnsupportedContentError(p.type);
    out += p.text ?? "";
  }
  return out;
}

export function toInternalRequest(req: AnthropicRequest) {
  // 形状校验放在最前面：下面 `req.messages` 的 for-of 与 `req.system` 的属性访问，
  // 在请求体不是对象 / 漏写 messages 时会抛裸 TypeError ⇒ 被 onError 兜成 500。
  const o = requireObject(req, "请求体");
  requireString(o.model, "model");
  requireArray(o.messages, "messages");
  // 生成参数三档，表与理由在 `UnsupportedParamError` 上方（三条协议共用那一张）。
  // **判在压平之前**：这一档是纯字段判断，比逐块压平便宜，也让报文只说一件事。
  if (o.tools !== undefined) throw new UnsupportedParamError("tools", "本网关不转换工具调用");
  if (o.tool_choice !== undefined) throw new UnsupportedParamError("tool_choice", "本网关不转换工具调用");
  if (o.top_k !== undefined) throw new UnsupportedParamError("top_k", "上游的 OpenAI 兼容请求体里没有这一格");
  const messages: { role: string; content: string }[] = [];
  const system = req.system === undefined ? "" : flatten(req.system);
  if (system) messages.push({ role: "system", content: system });
  for (const m of req.messages) messages.push({ role: m.role, content: flatten(m.content) });
  return {
    model: req.model, messages, max_tokens: req.max_tokens, stream: req.stream === true,
    temperature: req.temperature, top_p: req.top_p, stop: req.stop_sequences,
  };
}

/**
 * 上游 `finish_reason` → Anthropic `stop_reason`。
 *
 * ⚠️ **`content_filter` 映到 `refusal`，不是 `stop_sequence`**（2026-09-10 实测缺陷）：
 * 从前这张表把它映成 `stop_sequence`，而本文件两条出口（非流式那条与流式
 * `message_delta` 那条）都把配套的 `stop_sequence` 字段写死成 `null`
 * ——**一个说「命中了停止词」、一个说「没有停止词」，自相矛盾**。
 * 后果是上游内容过滤/拒答被下游读成「正常因停止词结束」：不触发重试、不触发告警，
 * 做审计的下游把「被过滤」记成「正常结束」。
 * ⚠️ 而且经本网关「真的命中停止词」这件事**从来就发生不了**——`stop_sequences`
 * 直到本轮才开始往上游转（见上面那三档），在那之前一格都不转。
 * `refusal` 是 Anthropic 现行取值里语义对得上的那一档，不带任何配套字段，
 * 不存在「没有合适值只好凑一个」的辩护。同批适配器 `gemini.ts` 的 `FINISH`
 * 早就把同一个上游值正确映成了 `SAFETY`，可作参照。
 */
const STOP_REASON: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  content_filter: "refusal",
};

export function toAnthropicResponse(openai: any, model: string) {
  const choice = openai.choices?.[0];
  return {
    id: `msg_${openai.id ?? "unknown"}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: choice?.message?.content ?? "" }],
    stop_reason: STOP_REASON[choice?.finish_reason ?? "stop"] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens ?? 0,
      output_tokens: openai.usage?.completion_tokens ?? 0,
    },
  };
}

export function toAnthropicStream(upstream: ReadableStream<Uint8Array>, model: string) {
  // 本地合成一个 id，在读上游之前就能产出——不依赖上游 chunk 里的 id，
  // 对首字节延迟零代价，同时保证每个流式响应都有互不相同的 message id
  // （不然下游按 message id 做的日志/追踪/去重/缓存会互相撞车）。
  const messageId = `msg_${crypto.randomUUID()}`;
  // 客户端断连时用来带外中断一次正阻塞在 reader.read() 上的读取，见
  // parseSseStream 与 toSseStream 对 signal/onCancel 的说明——不能只靠
  // 生成器的 return()，那会排在已在飞行中的 next() 后面永远等不到执行。
  const controller = new AbortController();

  async function* gen(): AsyncGenerator<string> {
    let finish = "stop";
    // 上游把 usage 放在**末块**（实测：`{"choices":[{"delta":{}}],"usage":{...}}`，
    // 不传 `stream_options.include_usage` 也照给）。攒在这里，收尾时如实报出去。
    let inTok = 0;
    let outTok = 0;

    // message_start 与 content_block_start 必须在读取上游之前产出，
    // 否则客户端要等到上游有数据（甚至上游结束）才能看到第一个字节，
    // 这条流就退化成了「攒完再吐」——与本函数存在的意义相悖。
    yield sseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        // ⚠️ **这里的 0 是「此刻还不知道」，不是「永远是 0」。**
        // `message_start` 必须在读上游之前就发出（否则这条流退化成「攒完再吐」，
        // 见上面那段），而 usage 要等上游末块才到 —— 那时这个事件早发出去了。
        // 真实值在收尾的 `message_delta.usage` 里给（真 Anthropic 也是在那里给
        // 累计 output_tokens 的）。
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    yield sseEvent("content_block_start", {
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
    });

    try {
      for await (const raw of parseSseStream(upstream, controller.signal)) {
        let chunk: any;
        try { chunk = JSON.parse(raw); } catch { continue; }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finish = choice.finish_reason;
        // usage 在末块，与 choices 同级。取到就记下，取不到保持 0。
        const u = chunk.usage;
        if (u && typeof u === "object") {
          if (typeof u.prompt_tokens === "number") inTok = u.prompt_tokens;
          if (typeof u.completion_tokens === "number") outTok = u.completion_tokens;
        }
        const text = choice?.delta?.content;
        if (typeof text === "string" && text.length > 0) {
          yield sseEvent("content_block_delta", {
            type: "content_block_delta", index: 0, delta: { type: "text_delta", text },
          });
        }
      }
    } catch (err) {
      // 🔴 **上游中途断掉必须说出来**（2026-09-10 实测缺陷）。
      //
      // 从前这里没有 try：响应头一旦发出（`res.ok` 已为 true），上游中途报错/断流时
      // 生成器**静默退出**，照常补一个 `message_stop` 并声称 `stop_reason: "end_turn"`
      // ⇒ **客户端把「被截断」当成「正常说完」**。对做内容完整性校验的下游，
      // 这是一种会悄悄产出错误结果的失败。真 Anthropic 在这一档有 `error` 事件。
      //
      // ⚠️ 只报「上游流中断」这一句，**不回显 `err.message`**：它可能带上游 URL 与栈帧。
      yield sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: "上游流式响应中断，本次回答不完整" },
      });
      return;
    }

    yield sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
    yield sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: STOP_REASON[finish] ?? "end_turn", stop_sequence: null },
      // 🔴 **真实值，不是硬编码 0**（2026-09-10 实测缺陷）：从前这里写死 0，
      // 而非流式路径证明这两个数网关明明拿得到 ⇒ 任何靠流式 usage 做计费/配额/统计的
      // 下游读到的永远是 0。**0 比缺字段更坏 —— 它长得像一个真值。**
      // 上游没给 usage 时仍是 0，那一档是「上游真没给」，与从前「拿得到也不给」不同。
      usage: { input_tokens: inTok, output_tokens: outTok },
    });
    yield sseEvent("message_stop", { type: "message_stop" });
  }

  return toSseStream(gen(), () => controller.abort());
}
