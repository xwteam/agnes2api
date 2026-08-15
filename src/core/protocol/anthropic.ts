import { parseSseStream, sseEvent, toSseStream } from "./sse.js";

interface AnthropicContentPart { type: string; text?: string }
export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  stream?: boolean;
  messages: { role: string; content: string | AnthropicContentPart[] }[];
}

function flatten(content: string | AnthropicContentPart[]): string {
  return typeof content === "string"
    ? content
    : content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}

export function toInternalRequest(req: AnthropicRequest) {
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) messages.push({ role: m.role, content: flatten(m.content) });
  return { model: req.model, messages, max_tokens: req.max_tokens, stream: req.stream === true };
}

const STOP_REASON: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  content_filter: "stop_sequence",
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

    // message_start 与 content_block_start 必须在读取上游之前产出，
    // 否则客户端要等到上游有数据（甚至上游结束）才能看到第一个字节，
    // 这条流就退化成了「攒完再吐」——与本函数存在的意义相悖。
    yield sseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    yield sseEvent("content_block_start", {
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
    });

    for await (const raw of parseSseStream(upstream, controller.signal)) {
      let chunk: any;
      try { chunk = JSON.parse(raw); } catch { continue; }
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      const text = choice?.delta?.content;
      if (typeof text === "string" && text.length > 0) {
        yield sseEvent("content_block_delta", {
          type: "content_block_delta", index: 0, delta: { type: "text_delta", text },
        });
      }
    }

    yield sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
    yield sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: STOP_REASON[finish] ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    yield sseEvent("message_stop", { type: "message_stop" });
  }

  return toSseStream(gen(), () => controller.abort());
}
