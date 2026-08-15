import { parseSseStream, sseEvent, toSseStream } from "./sse.js";

interface InputPart { type: string; text?: string }
export interface ResponsesRequest {
  model: string;
  input: string | { role: string; content: string | InputPart[] }[];
  instructions?: string;
  max_output_tokens?: number;
  stream?: boolean;
}

const flat = (c: string | InputPart[]) =>
  typeof c === "string" ? c : c.map((p) => p.text ?? "").join("");

export function toInternalRequest(req: ResponsesRequest) {
  const messages: { role: string; content: string }[] = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else {
    for (const m of req.input) messages.push({ role: m.role, content: flat(m.content) });
  }
  return { model: req.model, messages, max_tokens: req.max_output_tokens, stream: req.stream === true };
}

export function toResponsesResponse(openai: any, model: string) {
  const choice = openai.choices?.[0];
  const input = openai.usage?.prompt_tokens ?? 0;
  const output = openai.usage?.completion_tokens ?? 0;
  return {
    id: `resp_${openai.id ?? "unknown"}`,
    object: "response",
    model,
    status: choice?.finish_reason === "length" ? "incomplete" : "completed",
    output: [{
      type: "message",
      id: `msg_${openai.id ?? "unknown"}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: choice?.message?.content ?? "", annotations: [] }],
    }],
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
  };
}

export function toResponsesStream(upstream: ReadableStream<Uint8Array>, model: string) {
  // 本地合成一个 id，在读上游之前就能产出，且每个流式响应互不相同——
  // 理由与 anthropic.ts 的 messageId 一致：不依赖上游 chunk 里的 id，
  // 对首字节延迟零代价，也避免下游按 response id 做的日志/追踪/去重撞车。
  const responseId = `resp_${crypto.randomUUID()}`;
  // 客户端断连时用来带外中断一次正阻塞在 reader.read() 上的读取，见
  // parseSseStream 与 toSseStream 对 signal/onCancel 的说明——不能只靠
  // 生成器的 return()，那会排在已在飞行中的 next() 后面永远等不到执行。
  const controller = new AbortController();

  async function* gen(): AsyncGenerator<string> {
    // response.created 必须在读取上游之前产出，否则客户端要等到上游有
    // 数据才能看到第一个字节，这条流就退化成了「攒完再吐」。
    yield sseEvent("response.created", {
      type: "response.created",
      response: { id: responseId, object: "response", model, status: "in_progress", output: [] },
    });

    for await (const raw of parseSseStream(upstream, controller.signal)) {
      let chunk: any;
      try { chunk = JSON.parse(raw); } catch { continue; }
      const text = chunk.choices?.[0]?.delta?.content;
      if (typeof text !== "string" || text.length === 0) continue;
      yield sseEvent("response.output_text.delta", {
        type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text,
      });
    }

    yield sseEvent("response.completed", {
      type: "response.completed",
      response: { id: responseId, object: "response", model, status: "completed" },
    });
  }

  return toSseStream(gen(), () => controller.abort());
}
