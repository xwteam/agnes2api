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
  async function* gen(): AsyncGenerator<string> {
    let finish = "stop";

    // message_start 与 content_block_start 必须在读取上游之前产出，
    // 否则客户端要等到上游有数据（甚至上游结束）才能看到第一个字节，
    // 这条流就退化成了「攒完再吐」——与本函数存在的意义相悖。
    yield sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_unknown", type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    yield sseEvent("content_block_start", {
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
    });

    // 客户端断开时 toSseStream.cancel() 会对这个生成器调用 return()，
    // for-await-of 按 IteratorClose 语义自动把 return() 转发给
    // parseSseStream(upstream) 这个内层异步生成器，无需在此手写清理代码。
    for await (const raw of parseSseStream(upstream)) {
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

  return toSseStream(gen());
}
