import { describe, it, expect } from "vitest";
import { toInternalRequest, toAnthropicResponse, toAnthropicStream } from "../../src/core/protocol/anthropic.js";

describe("toInternalRequest", () => {
  it("把 system 提到 messages 首位", () => {
    const r = toInternalRequest({
      model: "agnes-2.0-flash", max_tokens: 100,
      system: "你是助手",
      messages: [{ role: "user", content: "你好" }],
    });
    expect(r.messages[0]).toEqual({ role: "system", content: "你是助手" });
    expect(r.messages[1]).toEqual({ role: "user", content: "你好" });
  });

  it("没有 system 时不插入空消息", () => {
    const r = toInternalRequest({
      model: "agnes-2.0-flash", max_tokens: 100,
      messages: [{ role: "user", content: "你好" }],
    });
    expect(r.messages).toHaveLength(1);
  });

  it("把 max_tokens 映射为 OpenAI 的同名字段", () => {
    const r = toInternalRequest({
      model: "agnes-2.0-flash", max_tokens: 512, messages: [{ role: "user", content: "x" }],
    });
    expect(r.max_tokens).toBe(512);
  });

  it("把数组形态的 content 压平为纯文本", () => {
    const r = toInternalRequest({
      model: "agnes-2.0-flash", max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] }],
    });
    expect(r.messages[0]!.content).toBe("甲乙");
  });

  it("透传 stream 标志", () => {
    const r = toInternalRequest({
      model: "agnes-2.0-flash", max_tokens: 1, stream: true, messages: [{ role: "user", content: "x" }],
    });
    expect(r.stream).toBe(true);
  });
});

describe("toAnthropicResponse", () => {
  it("把 OpenAI 响应重组为 content blocks", () => {
    const a = toAnthropicResponse({
      id: "c1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "你好" } }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    }, "agnes-2.0-flash");

    expect(a.type).toBe("message");
    expect(a.role).toBe("assistant");
    expect(a.content).toEqual([{ type: "text", text: "你好" }]);
    expect(a.model).toBe("agnes-2.0-flash");
    expect(a.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
  });

  it("finish_reason 为 stop 时映射为 end_turn", () => {
    const a = toAnthropicResponse({
      id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "x" } }],
    }, "m");
    expect(a.stop_reason).toBe("end_turn");
  });

  it("finish_reason 为 length 时映射为 max_tokens", () => {
    const a = toAnthropicResponse({
      id: "c1", choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "x" } }],
    }, "m");
    expect(a.stop_reason).toBe("max_tokens");
  });

  it("上游没有 usage 时给出零值而不是 undefined", () => {
    const a = toAnthropicResponse({
      id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "x" } }],
    }, "m");
    expect(a.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

function upstreamSse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
}

describe("toAnthropicStream", () => {
  it("产出完整且顺序正确的事件序列", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { role: "assistant" } }] },
      { id: "c1", choices: [{ delta: { content: "你" } }] },
      { id: "c1", choices: [{ delta: { content: "好" } }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const text = await new Response(toAnthropicStream(upstream, "agnes-2.0-flash")).text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);

    expect(events).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("文本增量按顺序出现在 content_block_delta 里", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { content: "甲" } }] },
      { id: "c1", choices: [{ delta: { content: "乙" } }] },
    ]);
    const text = await new Response(toAnthropicStream(upstream, "m")).text();
    const deltas = [...text.matchAll(/"text_delta","text":"(.+?)"/g)].map((m) => m[1]);
    expect(deltas).toEqual(["甲", "乙"]);
  });

  it("上游一个增量都没有时仍产出结构完整的事件序列", async () => {
    const text = await new Response(toAnthropicStream(upstreamSse([]), "m")).text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      "message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop",
    ]);
  });

  it("首个事件在上游尚未结束时就已产出（真流式）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const upstream = new ReadableStream<Uint8Array>({
      async start(c) {
        const e = new TextEncoder();
        c.enqueue(e.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "甲" } }] })}\n\n`));
        await gate;                     // 上游卡住不结束
        c.enqueue(e.encode("data: [DONE]\n\n"));
        c.close();
      },
    });

    const reader = toAnthropicStream(upstream, "m").getReader();
    const first = await reader.read();  // 缓冲式实现会在此永久挂起
    expect(new TextDecoder().decode(first.value)).toContain("message_start");
    release();
    await reader.cancel();
  });
});
