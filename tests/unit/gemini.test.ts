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

  /**
   * 与 `tests/unit/anthropic.test.ts「首个事件在上游尚未结束时就已产出（真流式）」`
   * **同形的一格**。P3e Task 12 补。
   *
   * **在这一格之前 gemini 是四条协议里唯一没有 unit 级逐块性观测的**：把
   * `src/core/protocol/sse.ts` 的 `toSseStream` 从逐块 `pull` 改成整段缓冲，
   * 本文件当时只有下面「取消」那一格会红——而那一格红的理由是**上游没被释放**，
   * 不是「第一块出来得晚」。逐块性只靠取消那一格侧面兜着。
   *
   * ⚠️ **夹具不许照抄成别的协议的形状**：gemini 一条自己合成的事件行都不夹
   * （`tests/contract/stream-parity.test.ts「带正文的行恰好三条……不带正文」`
   * 那一格里 gemini 的非正文行数钉死为 0，说的就是这件事），所以第一块交出来的
   * 就是第一条**带正文**的 `candidates` 负载——断言只能落在「甲」上，
   * 落在 `message_start` 之类事件名上的话这一格恒绿。
   *
   * **变红条件（实测，报告变异表 M1）**：`toSseStream` 改成 `start` 里整段
   * 缓冲后一次 enqueue。缓冲式实现要等生成器跑完，而上游卡在 `gate` 上永不
   * 结束 ⇒ 下面第一次 `read()` 永久挂起，这一格以超时红。
   */
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

    const reader = toGeminiStream(upstream, "m").getReader();
    const first = await reader.read();  // 缓冲式实现会在此永久挂起
    const wire = new TextDecoder().decode(first.value);
    const payload = JSON.parse(wire.replace(/^data: /, ""));
    expect(payload.candidates[0].content, "第一块交出来的必须已经是带正文的 candidates 负载").toEqual({
      role: "model", parts: [{ text: "甲" }],
    });
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

  /**
   * ── **这一格是 Playground 那句文案的红线之一（P3e Task 22 回填 F1）** ────────────
   *
   * 与 `tests/unit/responses.test.ts` 的
   * 「toResponsesStream() 吐出去的字节里一个 usage 字段都没有」是**同一句全称句的另一半**：
   * `admin-ui/js/sec-playground.js` 文件头写着「responses 与 gemini 那两条
   * **一个 usage 字段都不发**」，而写下的时候两条**都**没有任何东西会为它变红
   *（复评实测：把 usage 加进 responses 那条流 ⇒ 全仓 3176/3176 全绿）。
   *
   * ⚠️ **判据是子串搜 `usage`（转小写之后）**：gemini 那条协议里 token 用量叫
   * `usageMetadata`，按 key 精确找 `usage` 会**恰好漏掉它自己那个名字**。
   * 转小写之后的子串既盖得住 `usageMetadata`，也盖得住有人顺手塞进来的 `usage`。
   *
   * ⚠️ **反向控制用的是仓里真实存在的东西**：非流式那条（`toGeminiResponse()`）
   * **真的**带 `usageMetadata` —— 同一份判据必须在它身上认得出来。
   */
  it("toGeminiStream() 吐出去的字节里一个 usage 字段都没有", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { content: "甲" } }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
    ]);
    const wire = await new Response(toGeminiStream(upstream, "m")).text();

    // 前置条件：这一条流**真的**跑出了内容（不然下面那句「搜不到」是在空串上成立的）。
    expect(wire, "这一格没跑出流来，「搜不到 usage」是在空串上成立的").toContain("candidates");

    expect(wire.toLowerCase(),
      "gemini 那条流吐出了 usage —— Playground 文件头那句「一个 usage 字段都不发」"
      + "已经变成假话，而面板上那句「本面板不读 token 用量」正靠它撑着射程")
      .not.toContain("usage");

    // **反向控制（同判据，用仓里真实存在的东西）**：非流式那条真的带 usageMetadata。
    const nonStream = JSON.stringify(toGeminiResponse({
      usage: { prompt_tokens: 1, completion_tokens: 2 },
      choices: [{ finish_reason: "stop", message: { content: "甲" } }],
    }, "m"));
    expect(nonStream.toLowerCase(),
      "判据在一个真的带着 usageMetadata 的负载上都搜不到它 —— 上面那条 not.toContain 是空转的")
      .toContain("usage");
  });
});
