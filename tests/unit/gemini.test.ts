import { describe, it, expect } from "vitest";
import { toInternalRequest, toGeminiResponse, toGeminiStream, geminiModelList } from "../../src/core/protocol/gemini.js";

describe("toInternalRequest", () => {
  it("把 contents 的 parts 压平为 messages", () => {
    const r = toInternalRequest({
      contents: [
        { role: "user", parts: [{ text: "你" }, { text: "好" }] },
        { role: "model", parts: [{ text: "在" }] },
      ],
    }, "agnes-2.0-flash");
    expect(r.messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "在" },
    ]);
  });

  it("把 model 角色映射为 assistant", () => {
    const r = toInternalRequest({ contents: [{ role: "model", parts: [{ text: "x" }] }] }, "m");
    expect(r.messages[0]!.role).toBe("assistant");
  });

  it("systemInstruction 转成首条 system 消息", () => {
    const r = toInternalRequest({
      systemInstruction: { parts: [{ text: "你是助手" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }, "m");
    expect(r.messages[0]).toEqual({ role: "system", content: "你是助手" });
  });

  it("generationConfig.maxOutputTokens 映射为 max_tokens", () => {
    const r = toInternalRequest({
      contents: [{ role: "user", parts: [{ text: "x" }] }],
      generationConfig: { maxOutputTokens: 256, temperature: 0.5 },
    }, "m");
    expect(r.max_tokens).toBe(256);
    expect(r.temperature).toBe(0.5);
  });
});

describe("toGeminiResponse", () => {
  it("重组为 candidates 结构", () => {
    const g = toGeminiResponse({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "你好" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }, "agnes-2.0-flash");

    expect(g.candidates[0]!.content).toEqual({ role: "model", parts: [{ text: "你好" }] });
    expect(g.candidates[0]!.finishReason).toBe("STOP");
    expect(g.usageMetadata).toEqual({
      promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5,
    });
  });

  it("finish_reason 为 length 时映射为 MAX_TOKENS", () => {
    const g = toGeminiResponse({
      choices: [{ finish_reason: "length", message: { content: "x" } }],
    }, "m");
    expect(g.candidates[0]!.finishReason).toBe("MAX_TOKENS");
  });
});

describe("geminiModelList", () => {
  it("返回 models 数组，name 带 models/ 前缀", () => {
    const list = geminiModelList() as { models: { name: string; displayName: string }[] };
    expect(list.models.length).toBeGreaterThan(0);
    expect(list.models[0]!.name).toMatch(/^models\//);
    expect(list.models.map((m) => m.name)).toContain("models/agnes-2.0-flash");
  });
});

function upstreamSse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
}

describe("toGeminiStream", () => {
  it("把每个增量转成携带 candidates 结构的 SSE 事件", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { content: "甲" } }] },
      { id: "c1", choices: [{ delta: { content: "乙" } }] },
    ]);
    const text = await new Response(toGeminiStream(upstream, "agnes-2.0-flash")).text();
    const payloads = [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));
    expect(payloads).toHaveLength(2);
    expect(payloads[0].candidates[0].content).toEqual({ role: "model", parts: [{ text: "甲" }] });
    expect(payloads[0].modelVersion).toBe("agnes-2.0-flash");
    expect(payloads[1].candidates[0].content).toEqual({ role: "model", parts: [{ text: "乙" }] });
  });

  it("跳过没有文本增量的 chunk（例如只带 role 或 finish_reason 的）", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { role: "assistant" } }] },
      { id: "c1", choices: [{ delta: { content: "只有这条" } }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const text = await new Response(toGeminiStream(upstream, "m")).text();
    const payloads = [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].candidates[0].content.parts[0].text).toBe("只有这条");
  });

  it("upstream 正阻塞在 read() 上等下一个 token 时取消：cancel() 必须及时 resolve 且真的释放 upstream（真实断连场景）", async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        const e = new TextEncoder();
        c.enqueue(e.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "甲" } }] })}\n\n`));
        // 之后既不再 enqueue，也不 close——模拟上游仍在生成，下一个 token 还没到。
      },
      cancel() { upstreamCancelled = true; },
    });

    const reader = toGeminiStream(upstream, "m").getReader();
    await reader.read(); // "甲" 那条事件
    // 故意不 await：这次 read 会一路下钻到 parseSseStream 内部对 upstream 的
    // 第二次 reader.read()，upstream 不会再发数据也不会关闭，真实地悬空在飞行中。
    const pendingRead = reader.read();
    await new Promise((r) => setTimeout(r, 20)); // 留出时间真正落到那次挂起的 read() 上

    await Promise.race([
      reader.cancel(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("cancel() 超过 500ms 未 resolve：取消被卡在了排队的 next() 后面")), 500);
      }),
    ]);
    await pendingRead.catch(() => {});

    expect(upstreamCancelled).toBe(true);
  });
});
