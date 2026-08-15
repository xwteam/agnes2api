import { describe, it, expect } from "vitest";
import { toInternalRequest, toResponsesResponse, toResponsesStream } from "../../src/core/protocol/responses.js";

describe("toInternalRequest", () => {
  it("字符串形态的 input 转成单条 user 消息", () => {
    const r = toInternalRequest({ model: "agnes-2.0-flash", input: "你好" });
    expect(r.messages).toEqual([{ role: "user", content: "你好" }]);
  });

  it("数组形态的 input 逐条转换并压平 content", () => {
    const r = toInternalRequest({
      model: "m",
      input: [
        { role: "user", content: [{ type: "input_text", text: "甲" }, { type: "input_text", text: "乙" }] },
        { role: "assistant", content: [{ type: "output_text", text: "丙" }] },
      ],
    });
    expect(r.messages).toEqual([
      { role: "user", content: "甲乙" },
      { role: "assistant", content: "丙" },
    ]);
  });

  it("instructions 转为首条 system 消息", () => {
    const r = toInternalRequest({ model: "m", instructions: "你是助手", input: "hi" });
    expect(r.messages[0]).toEqual({ role: "system", content: "你是助手" });
  });

  it("没有 instructions 时不插入空的 system 消息", () => {
    const r = toInternalRequest({ model: "m", input: "hi" });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.role).toBe("user");
  });

  it("max_output_tokens 映射为 max_tokens", () => {
    const r = toInternalRequest({ model: "m", input: "x", max_output_tokens: 128 });
    expect(r.max_tokens).toBe(128);
  });

  it("透传 stream 标志", () => {
    const r = toInternalRequest({ model: "m", input: "x", stream: true });
    expect(r.stream).toBe(true);
  });
});

describe("toResponsesResponse", () => {
  it("重组为 output 数组结构", () => {
    const r = toResponsesResponse({
      id: "c1",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "你好" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    }, "agnes-2.0-flash");

    expect(r.object).toBe("response");
    expect(r.status).toBe("completed");
    expect(r.output[0]).toMatchObject({
      type: "message", role: "assistant",
      content: [{ type: "output_text", text: "你好" }],
    });
    expect(r.usage).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  });

  it("finish_reason 为 length 时状态为 incomplete", () => {
    const r = toResponsesResponse({
      id: "c1", choices: [{ finish_reason: "length", message: { content: "x" } }],
    }, "m");
    expect(r.status).toBe("incomplete");
  });

  it("上游没有 usage 时给出零值而不是 undefined", () => {
    const r = toResponsesResponse({
      id: "c1", choices: [{ finish_reason: "stop", message: { content: "x" } }],
    }, "m");
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });
});

function upstreamSse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
}

describe("toResponsesStream", () => {
  it("产出完整且顺序正确的事件序列", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { role: "assistant" } }] },
      { id: "c1", choices: [{ delta: { content: "你" } }] },
      { id: "c1", choices: [{ delta: { content: "好" } }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const text = await new Response(toResponsesStream(upstream, "agnes-2.0-flash")).text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);

    expect(events).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.completed",
    ]);
  });

  it("文本增量按顺序出现在 response.output_text.delta 里", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { content: "甲" } }] },
      { id: "c1", choices: [{ delta: { content: "乙" } }] },
    ]);
    const text = await new Response(toResponsesStream(upstream, "m")).text();
    const deltas = [...text.matchAll(/"type":"response\.output_text\.delta"[^}]*"delta":"(.+?)"/g)].map((m) => m[1]);
    expect(deltas).toEqual(["甲", "乙"]);
  });

  it("跳过没有文本增量的 chunk（例如只带 role 或 finish_reason 的）", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { role: "assistant" } }] },
      { id: "c1", choices: [{ delta: { content: "只有这条" } }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const text = await new Response(toResponsesStream(upstream, "m")).text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual(["response.created", "response.output_text.delta", "response.completed"]);
  });

  it("上游一个增量都没有时仍产出 created 与 completed", async () => {
    const text = await new Response(toResponsesStream(upstreamSse([]), "m")).text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual(["response.created", "response.completed"]);
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

    const reader = toResponsesStream(upstream, "m").getReader();
    const first = await reader.read();  // 缓冲式实现会在此永久挂起
    expect(new TextDecoder().decode(first.value)).toContain("response.created");
    release();
    await reader.cancel();
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

    const reader = toResponsesStream(upstream, "m").getReader();
    await reader.read(); // response.created
    await reader.read(); // response.output_text.delta("甲")
    // 故意不 await 这次 read：它会一路下钻到 parseSseStream 内部对 upstream 的
    // 第二次 reader.read()，而 upstream 不会再发数据也不会关闭，这次 read 真
    // 实地悬空在飞行中——不是「生成器刚 yield 完、没有 pending next()」那种
    // 协作式假象。
    const pendingRead = reader.read();
    await new Promise((r) => setTimeout(r, 20)); // 给上面这条调用链留出时间真正落到那次挂起的 read() 上

    await Promise.race([
      reader.cancel(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("cancel() 超过 500ms 未 resolve：取消被卡在了排队的 next() 后面")), 500);
      }),
    ]);
    await pendingRead.catch(() => {});

    expect(upstreamCancelled).toBe(true);
  });

  it("每次流式响应的 response.created.response.id 都各自生成，不共享同一个占位符", async () => {
    const upstream1 = upstreamSse([{ id: "c1", choices: [{ delta: { content: "a" } }] }]);
    const upstream2 = upstreamSse([{ id: "c2", choices: [{ delta: { content: "b" } }] }]);
    const text1 = await new Response(toResponsesStream(upstream1, "m")).text();
    const text2 = await new Response(toResponsesStream(upstream2, "m")).text();
    const id1 = /"response":\{"id":"(.+?)"/.exec(text1)?.[1];
    const id2 = /"response":\{"id":"(.+?)"/.exec(text2)?.[1];
    expect(id1).toBeDefined();
    expect(id1).not.toBe("resp_stream");
    expect(id1).not.toBe(id2);
  });
});
