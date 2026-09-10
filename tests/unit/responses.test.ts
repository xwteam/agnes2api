import { describe, it, expect } from "vitest";
import { toInternalRequest, toResponsesResponse, toResponsesStream } from "../../src/core/protocol/responses.js";
import { UnsupportedContentError, UnsupportedParamError } from "../../src/core/protocol/request-shape.js";

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

  /**
   * **防住的真实故障**：客户端发了一张图，网关回 200、回一段读起来很正常的答案，
   * 而那段答案是模型在**完全没看到图**的前提下编出来的 —— 从前 `flat()` 是
   * `c.map((p) => p.text ?? "").join("")`，`input_image` / `input_file` 直接蒸发，
   * 没有错误码、没有告警、没有事件。这正是本仓在 `anthropic.ts` 那条上判定为
   * 「不可接受、宁可 400」的失败形态，当时那句承诺只覆盖了三条协议里的一条。
   *
   * ⚠️ **`output_text` 必须放行**：把上一轮回答原样喂回去时用的就是它，
   * 拿它当「非文本块」拒掉会把一条最常见的多轮用法判成 400
   * （本文件「数组形态的 input 逐条转换并压平 content」那一格正用着它）。
   *
   * **变红条件（实测）**：把 `src/core/protocol/responses.ts` 的 `flat()` 改回
   * `c.map((p) => p.text ?? "").join("")` ⇒ 三格全部不抛，本格红。
   */
  it("遇到无法映射的内容块时抛错，而不是静默丢掉一张图再照常回 200", () => {
    for (const type of ["input_image", "input_file", "refusal"]) {
      expect(() => toInternalRequest({
        model: "m",
        input: [{ role: "user", content: [{ type: "input_text", text: "这图什么颜色?" }, { type }] }],
      }), `${type} 被静默吃掉了`).toThrow(UnsupportedContentError);
    }
  });

  /**
   * 采样参数两格透传、工具两格 400。三档裁定在
   * `src/core/protocol/request-shape.ts` 的 `UnsupportedParamError` 上方。
   *
   * **变红条件（实测）**：把返回值里的 `temperature: req.temperature, top_p: req.top_p`
   * 删掉 ⇒ 前两条断言红；把那两行 `throw` 删掉 ⇒ 后面那圈红。
   */
  it("temperature / top_p 透传，tools / tool_choice 一律 400 点名", () => {
    const r = toInternalRequest({ model: "m", input: "x", temperature: 0, top_p: 0.1 });
    expect(r.temperature, "temperature 没带上 —— 客户端设了 0 却拿到随机输出").toBe(0);
    expect(r.top_p).toBe(0.1);

    for (const [field, extra] of [
      ["tools", { tools: [{ type: "function", name: "f" }] }],
      ["tool_choice", { tool_choice: "required" }],
    ] as const) {
      let err: unknown = null;
      try { toInternalRequest({ model: "m", input: "x", ...extra }); } catch (e) { err = e; }
      expect(err, `${field} 被静默吃掉了`).toBeInstanceOf(UnsupportedParamError);
      expect(String((err as Error).message)).toContain(field);
    }
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
  /**
   * ⚠️⚠️ **这一格的期望值 2026-09-10 整个改写了，因为它钉的是一个已被推翻的形态。**
   *
   * 上一版写死的是「`created` + 若干 `delta` + `completed`」三类事件 —— 那**正是**
   * 让官方 SDK 崩掉的那个形态，而它被写成了本仓的正确性判据。**绿得最危险的一种**：
   * 判据钉住了缺陷本身，任何人把它修好都会先看到这一格变红。
   *
   * 定案证据（本地回放，零上游请求）：把网关真吐出去的字节喂给官方 `openai` 3.11.0，
   * `client.responses.stream(...)` 在 `openai/lib/streaming/responses/_responses.py` 的
   * `output = snapshot.output[event.output_index]` 抛 **IndexError: list index out of range**，
   * 栈里全是 openai 包的文件；同一份字节走裸 `create(stream=True)` 逐事件迭代却是通的。
   * ⇒ 缺的是 SDK 累积器用来建出 `snapshot.output[0]` / `output.content[0]` 的那两条
   * `*.added` 事件，以及收尾那三条 `*.done`。修好之后同一份回放：
   * `get_final_response()` 通过，16 个事件，`output_text` 完整、`output[0].status == "completed"`。
   *
   * 期望值逐条手写、**顺序即契约**：`*.added` 排在任何一条 delta 之前是 SDK 累积器的
   * 硬前提，把顺序打乱这一格照样红。
   */
  it("产出官方最小事件序列：两条 added 打头、三条 done 收尾 —— 少任何一条官方 SDK 的 stream() 都崩在自己内部", async () => {
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
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  /**
   * **官方 SDK 累积器的三条前置条件，逐条钉住。**
   *
   * ⚠️ **它是那条 IndexError 的可执行复述，不是它的替身**：真证据是本地回放
   *（见上一格那段），而回放要 python + `openai` 包，进不了本仓的 CI。这一格把
   * `openai/lib/streaming/responses/_responses.py` 的 `accumulate_event()` /
   * `handle_event()` **真的会读的那几格**写成断言，让 CI 里也有一张网：
   * · 每条 `output_text.delta` 之前必须已经出现过同 `output_index` 的
   *   `output_item.added`（SDK 靠它 append 出 `snapshot.output[i]`）与同
   *   `content_index` 的 `content_part.added`（靠它 append 出 `output.content[j]`）；
   * · delta 与 done 两档必须带 `item_id` / `sequence_number` / `logprobs`
   *   —— SDK 的 `handle_event()` 直接读这三个属性去重建它自己的事件对象，
   *   缺一个就是一次 AttributeError。
   *
   * **变红条件（实测）**：把 `src/core/protocol/responses.ts` 里那两条 `*.added`
   * 中的任意一条删掉；或者把 delta 事件上的 `item_id` / `sequence_number` /
   * `logprobs` 任意一格删掉。
   */
  it("每条 output_text.delta 之前都已建出它要落进去的那一格，且带齐 SDK 会读的三个字段", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { content: "甲" } }] },
      { id: "c1", choices: [{ delta: { content: "乙" } }] },
    ]);
    const text = await new Response(toResponsesStream(upstream, "m")).text();
    const payloads = [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));

    // SDK 那两份表：出现过的 output_index / content_index。
    const items = new Set<number>();
    const parts = new Set<number>();
    let seen = 0;
    for (const p of payloads) {
      if (p.type === "response.output_item.added") items.add(p.output_index);
      if (p.type === "response.content_part.added") parts.add(p.content_index);
      if (p.type !== "response.output_text.delta" && p.type !== "response.output_text.done") continue;
      seen++;
      expect(items.has(p.output_index), `${p.type} 落在一个还没被 output_item.added 建出来的 output_index 上`).toBe(true);
      expect(parts.has(p.content_index), `${p.type} 落在一个还没被 content_part.added 建出来的 content_index 上`).toBe(true);
      expect(typeof p.item_id, `${p.type} 少了 item_id`).toBe("string");
      expect(typeof p.sequence_number, `${p.type} 少了 sequence_number`).toBe("number");
      expect(Array.isArray(p.logprobs), `${p.type} 少了 logprobs`).toBe(true);
    }
    // 前置条件：真的检查过东西（两条 delta + 一条 done）。
    expect(seen, "一条 delta/done 都没检查到 —— 上面那圈断言是空转的").toBe(3);
  });

  /**
   * **防住的真实故障**：即便有人绕开 `stream()` helper 用裸迭代，
   * `response.completed.response` 里没有 `output` 就意味着「最终对象」拿不到
   * ——`get_final_response()` 返回的正是它，下游读到的是空。
   *
   * **变红条件（实测）**：把 `src/core/protocol/responses.ts` 的 `response.completed`
   * 那个负载里的 `output: [...]` 删掉。
   */
  it("response.completed 里带着完整的 output —— 那就是 get_final_response() 返回的那个对象", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { content: "甲" } }] },
      { id: "c1", choices: [{ delta: { content: "乙" } }] },
    ]);
    const text = await new Response(toResponsesStream(upstream, "m")).text();
    const last = JSON.parse([...text.matchAll(/^data: (.+)$/gm)].map((m) => m[1]!).at(-1)!);
    expect(last.type).toBe("response.completed");
    expect(last.response.output, "completed 里一个 output 都没有").toHaveLength(1);
    expect(last.response.output[0].content[0], "最终对象里的正文与流里的增量对不上").toMatchObject({
      type: "output_text", text: "甲乙",
    });
  });

  /**
   * **防住的真实故障**：响应头一旦发出，上游中途断流时生成器静默退出、照常补一个
   * `response.completed` 并声称 `status: "completed"` ⇒ **客户端把「被截断」当成
   * 「正常说完」**。`anthropic.ts` 在 v0.3.0 已经为这一条补了 `error` 事件，
   * 而同一类缺陷当时在 responses / gemini 两条上原样留着。
   *
   * ⚠️ **两条断言缺一不可**：只断言「发了 failed」的话，一个既发 failed 又照发
   * completed 的实现照样绿 —— 而官方 SDK 见到 completed 就认为这一轮成功了。
   *
   * **变红条件（实测）**：把那圈 `try/catch` 去掉（让异常一路冒出去）⇒ 流里
   * 既没有 `response.failed`、`completed` 也不会出现，第一条断言红。
   */
  it("上游中途断流：发 response.failed 且绝不再发 completed —— 别让断流退化成一次静默的正常收尾", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "半" } }] })}\n\n`));
        c.error(new Error("上游炸了"));
      },
    });
    const text = await new Response(toResponsesStream(upstream, "m")).text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events, "上游断了，网关一句都没说").toContain("response.failed");
    expect(events, "断流之后还照发 completed —— 客户端会把残缺当完整收下").not.toContain("response.completed");
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
    // 只数 delta：整串事件的构成由上面那一格钉着，这一格只管「空增量不产事件」。
    const deltas = [...text.matchAll(/^event: (.+)$/gm)]
      .map((m) => m[1]).filter((e) => e === "response.output_text.delta");
    expect(deltas).toHaveLength(1);
  });

  /**
   * 上游一个增量都没有时事件序列**照样发全**：官方 SDK 的累积器不认「空流」这一档，
   * 少发 `*.added` 一样会崩（同一条 IndexError），少发 `*.done` 则
   * `get_final_response()` 拿不到最终对象。
   */
  it("上游一个增量都没有时仍产出完整序列，正文是空串", async () => {
    const text = await new Response(toResponsesStream(upstreamSse([]), "m")).text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const last = JSON.parse([...text.matchAll(/^data: (.+)$/gm)].map((m) => m[1]!).at(-1)!);
    expect(last.response.output[0].content[0].text).toBe("");
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

  /**
   * ── **这一格是 Playground 那句文案的红线之一（回填时补的）** ─────────────────────
   *
   * `admin-ui/js/sec-playground.js` 文件头「流式那一轮为什么不显示 token 用量」那段里
   * 写着一句**全称句**：「responses 与 gemini 那两条**一个 usage 字段都不发**」。
   * 写下的时候它是真的，而**当时仓里没有任何东西会为它变红**——复评把
   * `usage: {…}` 加进 `src/core/protocol/responses.ts` 的 `response.completed` 那个事件
   * ⇒ **`pnpm test` 3176/3176 全绿、i18n 与注释指向两道门禁 EXIT=0**。
   * 同一句话里 anthropic 那半用的是名字锚（`src/core/protocol/anthropic.ts` 里那两处
   * 恒为 0 的 usage），改一个字段名当场 EXIT=1 ——**一半有牙一半没有**。
   *
   * ⚠️ **判据是「吐出去的字节里一个 `usage` 都搜不到」，不是按 key 递归找**：
   * 面板那句话防的是「屏幕上冒出一个 token 数字」，而**一个写进字符串值里的 usage
   * 照样会被顺手渲染出来**。子串比按 key 找**更宽**，宽的那一侧正是这里要的。
   *
   * ⚠️ **反向控制用的是仓里真实存在的东西**：非流式那条（`toResponsesResponse()`）
   * **真的**带 usage —— 同一份判据必须在它身上认得出来。认不出来就说明上面那条
   * `.not.toContain()` 是在一个永远搜不到东西的判据上空转。
   */
  it("toResponsesStream() 吐出去的字节里一个 usage 字段都没有", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { content: "甲" } }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
    ]);
    const wire = await new Response(toResponsesStream(upstream, "m")).text();

    // 前置条件：这一条流**真的**跑起来了（不然下面那句「搜不到」是在空串上成立的）。
    expect(wire, "这一格没跑出流来，「搜不到 usage」是在空串上成立的").toContain("response.completed");

    expect(wire.toLowerCase(),
      "responses 那条流吐出了 usage —— Playground 文件头那句「一个 usage 字段都不发」"
      + "已经变成假话，而面板上那句「本面板不读 token 用量」正靠它撑着射程")
      .not.toContain("usage");

    // **反向控制（同判据，用仓里真实存在的东西）**。
    const nonStream = JSON.stringify(toResponsesResponse({
      id: "c1", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      choices: [{ finish_reason: "stop", message: { content: "甲" } }],
    }, "m"));
    expect(nonStream.toLowerCase(),
      "判据在一个真的带着 usage 的负载上都搜不到它 —— 上面那条 not.toContain 是空转的")
      .toContain("usage");
  });
});
