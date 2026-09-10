import { describe, it, expect } from "vitest";
import { UnsupportedParamError } from "../../src/core/protocol/request-shape.js";
import { toInternalRequest, toAnthropicResponse, toAnthropicStream, UnsupportedContentError } from "../../src/core/protocol/anthropic.js";

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

  // Anthropic 官方允许 system 是内容块数组，所有开启 prompt caching 的 SDK
  // 都这么发。原实现把裸数组直接塞进 messages，上游收到的 content 不是字符串。
  it("system 为内容块数组时压平成字符串，而不是把裸数组发给上游", () => {
    const r = toInternalRequest({
      model: "agnes-2.0-flash", max_tokens: 100,
      system: [{ type: "text", text: "你是" }, { type: "text", text: "助手" }],
      messages: [{ role: "user", content: "你好" }],
    });
    expect(r.messages[0]).toEqual({ role: "system", content: "你是助手" });
    expect(typeof r.messages[0]!.content).toBe("string");
  });

  it("system 为空数组时不插入空消息", () => {
    const r = toInternalRequest({
      model: "agnes-2.0-flash", max_tokens: 100, system: [],
      messages: [{ role: "user", content: "你好" }],
    });
    expect(r.messages).toHaveLength(1);
  });

  it("遇到无法映射的内容块时抛错，而不是静默丢弃", () => {
    for (const type of ["image", "tool_use", "tool_result"]) {
      expect(() => toInternalRequest({
        model: "agnes-2.0-flash", max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type }] }],
      })).toThrow(UnsupportedContentError);
    }
  });

  it("system 里出现无法映射的内容块时同样抛错", () => {
    expect(() => toInternalRequest({
      model: "agnes-2.0-flash", max_tokens: 100,
      system: [{ type: "image" }],
      messages: [{ role: "user", content: "x" }],
    })).toThrow(UnsupportedContentError);
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

  /**
   * **防住的真实故障**：用户为了拿可复现的输出把 `temperature` 设成 0 发过来，
   * 网关回 200、结果照旧是随机的 —— 因为这一格从前压根不往上游带
   * （`return { model, messages, max_tokens, stream }`，一个采样参数都没有）。
   * 他会怀疑模型、怀疑上游、怀疑自己，唯独不会怀疑网关把字段扔了，因为一句提示都没有。
   *
   * **变红条件（实测）**：把 `src/core/protocol/anthropic.ts` 的返回值改回
   * `{ model, messages, max_tokens, stream }`（去掉那三格）⇒ 本格三条断言全红
   * （`undefined` ≠ 0 / 0.1 / `["END"]`）。
   *
   * ⚠️ **期望值是手写字面量，不从入参推导**：`r.temperature` 与入参同一个变量时，
   * 两边一起改错照样绿。
   */
  it("temperature / top_p / stop_sequences 三格真的带到了上游请求体上", () => {
    const r = toInternalRequest({
      model: "agnes-2.0-flash", max_tokens: 100,
      messages: [{ role: "user", content: "x" }],
      temperature: 0, top_p: 0.1, stop_sequences: ["END"],
    });
    expect(r.temperature, "temperature 没带上 —— 客户端设了 0 却拿到随机输出").toBe(0);
    expect(r.top_p).toBe(0.1);
    // Anthropic 的 `stop_sequences` 在上游 OpenAI 兼容体上叫 `stop`。
    expect(r.stop).toEqual(["END"]);
  });

  /**
   * **防住的真实故障（实测复现过）**：带 `tools` + `tool_choice:"required"` 的同一份
   * 请求，走 `/v1/chat/completions` 上游返回**真的工具调用**，走 `/v1/messages`
   * 返回 **200**、正文是模型自己吐的 `<tool_call><tool_call>…` 乱码、`stop_reason`
   * 还写着正常结束。静默丢弃比报错坏得多：客户端完全无从察觉。
   * 三档裁定（哪些透传、哪些 400）写在 `src/core/protocol/request-shape.ts` 的
   * `UnsupportedParamError` 上方。
   *
   * **变红条件（实测）**：把那三行 `throw` 删掉 ⇒ 三格全部不抛，本格红。
   */
  it("转达不了的生成参数一律 400 点名，不静默丢弃", () => {
    const base = { model: "agnes-2.0-flash", max_tokens: 100, messages: [{ role: "user", content: "x" }] };
    for (const [field, extra] of [
      ["tools", { tools: [{ name: "get_weather" }] }],
      ["tool_choice", { tool_choice: { type: "any" } }],
      ["top_k", { top_k: 5 }],
    ] as const) {
      let err: unknown = null;
      try { toInternalRequest({ ...base, ...extra }); } catch (e) { err = e; }
      expect(err, `${field} 被静默吃掉了`).toBeInstanceOf(UnsupportedParamError);
      // 报文必须点名是哪一格 —— 客户端拿到 400 要知道删哪个字段。
      expect(String((err as Error).message)).toContain(field);
    }
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

  /**
   * **防住的真实故障**：上游做了内容过滤/拒答，而 Anthropic 客户端读到的是
   * `stop_reason: "stop_sequence"` —— 那个取值的语义是「命中了客户端给的某个停止词」，
   * 配套的 `stop_sequence` 必须是命中的那一条，而本文件两条出口都把它写死成 `null`。
   * **一个说命中、一个说 null，自相矛盾**；客户端不会触发任何重试/告警/降级分支，
   * 做审计的下游把「被过滤」记成「正常结束」。
   * 而经本网关「真的命中停止词」这件事在 `stop_sequences` 开始转发之前根本发生不了。
   *
   * ⚠️ **两条断言缺一不可**：只断言「是 refusal」的话，谁把整张表改成恒返回
   * `"refusal"` 照样绿；下面那条 `stop` → `end_turn` 是同格的反向控制。
   *
   * **变红条件（实测）**：把 `src/core/protocol/anthropic.ts` 的 `STOP_REASON` 里
   * `content_filter` 改回 `"stop_sequence"` ⇒ 第一条断言红。
   */
  it("content_filter 映射为 refusal —— 映成 stop_sequence 会和恒为 null 的 stop_sequence 字段自相矛盾", () => {
    const a = toAnthropicResponse({
      id: "c1", choices: [{ index: 0, finish_reason: "content_filter", message: { content: "x" } }],
    }, "m");
    expect(a.stop_reason, "被内容过滤拦下的回答被报成了「正常因停止词结束」").toBe("refusal");
    expect(a.stop_sequence, "这一格恒为 null 正是上面那条断言存在的理由").toBe(null);

    // 反向控制（同格）：正常收尾那一档没有跟着漂。
    const ok = toAnthropicResponse({
      id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { content: "x" } }],
    }, "m");
    expect(ok.stop_reason, "整张表被改成恒返回同一个值了 —— 上面那条断言是空转的").toBe("end_turn");
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

  it("upstream 正阻塞在 read() 上等下一个 token 时取消：cancel() 必须及时 resolve 且真的释放 upstream（真实断连场景）", async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        const e = new TextEncoder();
        c.enqueue(e.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "甲" } }] })}\n\n`));
        // 之后既不再 enqueue，也不 close——模拟上游仍在生成，下一个 token 还没到。
        // 这是会真正发生的场景：客户端在模型还在吐字时断开连接。
      },
      cancel() { upstreamCancelled = true; },
    });

    const reader = toAnthropicStream(upstream, "m").getReader();
    await reader.read(); // message_start
    await reader.read(); // content_block_start
    await reader.read(); // content_block_delta("甲")
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

  it("每次流式响应的 message_start.id 都各自生成，不共享同一个占位符", async () => {
    const upstream1 = upstreamSse([{ id: "c1", choices: [{ delta: { content: "a" } }] }]);
    const upstream2 = upstreamSse([{ id: "c2", choices: [{ delta: { content: "b" } }] }]);
    const text1 = await new Response(toAnthropicStream(upstream1, "m")).text();
    const text2 = await new Response(toAnthropicStream(upstream2, "m")).text();
    const id1 = /"message":\{"id":"(.+?)"/.exec(text1)?.[1];
    const id2 = /"message":\{"id":"(.+?)"/.exec(text2)?.[1];
    expect(id1).toBeDefined();
    expect(id1).not.toBe("msg_unknown");
    expect(id1).not.toBe(id2);
  });
});
