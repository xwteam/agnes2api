import { parseSseStream, sseEvent, toSseStream } from "./sse.js";
import { MODELS } from "./openai.js";

interface Part { text?: string }
export interface GeminiRequest {
  contents: { role?: string; parts: Part[] }[];
  systemInstruction?: { parts: Part[] };
  generationConfig?: { maxOutputTokens?: number; temperature?: number };
}

const partsText = (parts: Part[]) => parts.map((p) => p.text ?? "").join("");
const FINISH: Record<string, string> = { stop: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" };

export function toInternalRequest(req: GeminiRequest, model: string) {
  const messages: { role: string; content: string }[] = [];
  if (req.systemInstruction) {
    messages.push({ role: "system", content: partsText(req.systemInstruction.parts) });
  }
  for (const c of req.contents) {
    messages.push({
      role: c.role === "model" ? "assistant" : (c.role ?? "user"),
      content: partsText(c.parts),
    });
  }
  return {
    model,
    messages,
    max_tokens: req.generationConfig?.maxOutputTokens,
    temperature: req.generationConfig?.temperature,
  };
}

export function toGeminiResponse(openai: any, model: string) {
  const choice = openai.choices?.[0];
  const prompt = openai.usage?.prompt_tokens ?? 0;
  const completion = openai.usage?.completion_tokens ?? 0;
  return {
    candidates: [{
      content: { role: "model", parts: [{ text: choice?.message?.content ?? "" }] },
      finishReason: FINISH[choice?.finish_reason ?? "stop"] ?? "STOP",
      index: 0,
    }],
    modelVersion: model,
    usageMetadata: {
      promptTokenCount: prompt,
      candidatesTokenCount: completion,
      totalTokenCount: prompt + completion,
    },
  };
}

export function toGeminiStream(upstream: ReadableStream<Uint8Array>, model: string) {
  // 客户端断连时用来带外中断一次正阻塞在 reader.read() 上的读取，见
  // parseSseStream 与 toSseStream 对 signal/onCancel 的说明——不能只靠
  // 生成器的 return()，那会排在已在飞行中的 next() 后面永远等不到执行。
  const controller = new AbortController();

  async function* gen(): AsyncGenerator<string> {
    for await (const raw of parseSseStream(upstream, controller.signal)) {
      let chunk: any;
      try { chunk = JSON.parse(raw); } catch { continue; }
      const text = chunk.choices?.[0]?.delta?.content;
      if (typeof text !== "string" || text.length === 0) continue;
      yield sseEvent(null, {
        candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0 }],
        modelVersion: model,
      });
    }
  }
  return toSseStream(gen(), () => controller.abort());
}

export function geminiModelList() {
  return {
    models: MODELS.map((m) => ({
      name: `models/${m}`,
      displayName: m,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    })),
  };
}
