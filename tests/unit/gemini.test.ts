import { describe, it, expect } from "vitest";
import { toInternalRequest, toGeminiResponse, toGeminiStream, geminiModelList } from "../../src/core/protocol/gemini.js";
import { UnsupportedContentError, UnsupportedParamError } from "../../src/core/protocol/request-shape.js";
import { MODEL_CATALOG } from "../../src/core/admin/protocol-catalog.js";

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

  /**
   * **防住的真实故障**：客户端设了 `stopSequences`，模型不在该停的地方停；
   * 设了 `topP`，输出照旧 —— 从前这两格一个都不往上游带，而网关回 200、
   * 一句提示都没有。三档裁定在 `src/core/protocol/request-shape.ts` 的
   * `UnsupportedParamError` 上方。
   *
   * **变红条件（实测）**：把 `src/core/protocol/gemini.ts` 返回值里的
   * `top_p: cfg?.topP, stop: cfg?.stopSequences` 删掉。
   */
  it("generationConfig.topP / stopSequences 映射成上游同名同义的那两格", () => {
    const r = toInternalRequest({
      contents: [{ role: "user", parts: [{ text: "x" }] }],
      generationConfig: { topP: 0.1, stopSequences: ["END"] },
    }, "m");
    expect(r.top_p, "topP 没带上").toBe(0.1);
    expect(r.stop, "stopSequences 没带上 —— 模型不会在该停的地方停").toEqual(["END"]);
  });

  /**
   * 转达不了的那几格一律 400 点名。`candidateCount: 1` 与不传逐字等价 ⇒ 放行，
   * 为它报 400 只是在骂人；`> 1` 才是转换不了的那一档（`toGeminiResponse` 只转
   * 第一条 candidate，客户端付了 n 份的钱只拿得到一份）。
   *
   * **变红条件（实测）**：把那几行 `throw` 删掉 ⇒ 前面那圈红；
   * 把 `!== 1` 那个条件改成「只要有 candidateCount 就抛」⇒ 最后那条反向控制红。
   */
  it("tools / toolConfig / topK / candidateCount>1 一律 400 点名，candidateCount:1 放行", () => {
    const base = { contents: [{ role: "user", parts: [{ text: "x" }] }] };
    for (const [field, extra] of [
      ["tools", { tools: [{ functionDeclarations: [] }] }],
      ["toolConfig", { toolConfig: {} }],
      ["topK", { generationConfig: { topK: 40 } }],
      ["candidateCount", { generationConfig: { candidateCount: 2 } }],
    ] as const) {
      let err: unknown = null;
      try { toInternalRequest({ ...base, ...extra } as never, "m"); } catch (e) { err = e; }
      expect(err, `${field} 被静默吃掉了`).toBeInstanceOf(UnsupportedParamError);
      expect(String((err as Error).message)).toContain(field);
    }

    // 反向控制（同格）：不许把「等价于不传」的那一档也拒掉。
    expect(() => toInternalRequest({ ...base, generationConfig: { candidateCount: 1 } }, "m"))
      .not.toThrow();
  });

  /**
   * **防住的真实故障（线上真打复现过）**：带一张 8×8 红色 PNG 的 `inline_data`
   * 打 `:generateContent` 回 **HTTP 200**，正文逐字是 `NO_IMAGE_RECEIVED`
   *（提示词里让模型在没收到图时这么回）—— 用户拿到的是一段模型在**完全没看到图**
   * 的前提下编出来的答案，没有错误码、没有告警、没有事件。这正是本仓在
   * `anthropic.ts` 那条上判定为「不可接受、宁可 400」的失败形态。
   *
   * ⚠️ **报文必须点名是哪一种块**：Gemini 的 part 没有 `type` 格，只能报键名。
   *
   * **变红条件（实测）**：把 `partsText` 改回 `parts.map((p) => p.text ?? "").join("")`。
   */
  it("遇到无法映射的 part 时抛错，而不是静默丢掉一张图再照常回 200", () => {
    for (const key of ["inlineData", "fileData", "functionCall"]) {
      let err: unknown = null;
      try {
        toInternalRequest({
          contents: [{ role: "user", parts: [{ text: "这图什么颜色?" }, { [key]: {} }] }],
        }, "m");
      } catch (e) { err = e; }
      expect(err, `${key} 被静默吃掉了`).toBeInstanceOf(UnsupportedContentError);
      expect(String((err as Error).message)).toContain(key);
    }
  });

  it("systemInstruction 里出现无法映射的 part 时同样抛错", () => {
    expect(() => toInternalRequest({
      systemInstruction: { parts: [{ inlineData: {} }] },
      contents: [{ role: "user", parts: [{ text: "x" }] }],
    }, "m")).toThrow(UnsupportedContentError);
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

  /**
   * **防住的真实故障**：`supportedGenerationMethods` 是 Gemini 协议里**机器可读**的
   * 「这个模型能干什么」。从前对全部 12 条一律声明支持
   * `generateContent` / `streamGenerateContent`，**包括三个图片模型与三个视频模型**
   * —— 照着这条端点渲染模型下拉框的客户端会把 `agnes-video-2.5` 列成可对话模型，
   * 运维选中发一次对话，网关照常转发 ⇒ 白烧一把 key + 一次全网关共享的限流额度，
   * 最后拿回一个上游错误。而真源就在隔壁：`MODEL_CATALOG` 每条都带 `modality`。
   *
   * ⚠️ **期望值从 `MODEL_CATALOG` 现算，不在这里手抄第二份模型名单**：手抄的那份
   * 与真源一起改错时照样绿；而「本清单与 `MODELS` 逐条同序一致」由
   * `tests/unit/admin/protocol-catalog.test.ts`「模型 id 与 /v1/models 的来源逐条一致」
   * 另外钉着，两格合起来才封死。
   *
   * ⚠️ **两侧都断言**：只断言「视频模型是空的」的话，一个恒返回空数组的实现照样绿。
   *
   * **变红条件（实测）**：把 `geminiModelList()` 里那个三元表达式改回无条件
   * 给两条方法。
   */
  it("只有对话模型声明支持那两个方法 —— 图片/视频模型给空数组，别把它们列成可对话模型", () => {
    const got = new Map((geminiModelList() as { models: { name: string; supportedGenerationMethods: string[] }[] })
      .models.map((m) => [m.name, m.supportedGenerationMethods]));
    let chat = 0;
    let media = 0;
    for (const m of MODEL_CATALOG) {
      const methods = got.get(`models/${m.id}`);
      if (m.modality === "chat") {
        chat++;
        expect(methods, `${m.id} 是对话模型，却没声明那两个方法`)
          .toEqual(["generateContent", "streamGenerateContent"]);
      } else {
        media++;
        expect(methods, `${m.id} 是 ${m.modality} 模型，却被声明成支持 generateContent`).toEqual([]);
      }
    }
    // 前置条件：两侧都真的量到了（一侧为 0 时上面那圈是半边空转）。
    expect(chat, "目录里一条对话模型都没有？").toBeGreaterThan(0);
    expect(media, "目录里一条媒体模型都没有 —— 这一格的另一半是空转的").toBeGreaterThan(0);
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
    // 2 条正文 + 1 条终帧（终帧本身由下面「终帧」那一格钉着）。
    expect(payloads).toHaveLength(3);
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
    // 带正文的只有一条；末尾那条是终帧（`parts` 为空）。
    const withText = payloads.filter((p) => (p.candidates[0].content.parts as unknown[]).length > 0);
    expect(withText).toHaveLength(1);
    expect(withText[0].candidates[0].content.parts[0].text).toBe("只有这条");
  });

  /**
   * 与 `tests/unit/anthropic.test.ts「首个事件在上游尚未结束时就已产出（真流式）」`
   * **同形的一格**，后来补的。
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
   * **变红条件（实测，当时的变异表）**：`toSseStream` 改成 `start` 里整段
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
   * ── **这一格 2026-09-10 整个改写了：它上一版钉的是一条已被推翻的行为** ──────────
   *
   * 上一版叫「toGeminiStream() 吐出去的字节里一个 usage 字段都没有」，断言是
   * 「整条流里搜不到 `usage`」。那句话来自 `admin-ui/js/sec-playground.js` 文件头
   * 把**当时的现状**如实登记的一句全称句（「responses 与 gemini 那两条一个 usage
   * 字段都不发」），**是登记缺口，不是裁定这样才对** —— 而它被当成了正确性判据。
   * responses 那半另有裁定（`response.completed` 不带 usage，理由在
   * `src/core/protocol/responses.ts` 的 `toResponsesStream` 上方），**gemini 这半没有**：
   * 缺 `usageMetadata` 让所有走 Gemini SDK 的下游一个 token 数都拿不到，
   * 缺 `finishReason` 更糟 —— 那是客户端判断「说完了 / 撞了 MAX_TOKENS / 被 SAFETY 拦了」
   * 的**唯一信号**，少了它，一个被截断的半截回答和一个完整回答**逐字节不可区分**。
   *
   * 定案证据（本地回放，零上游请求）：官方 `google-genai` 2.22.0 吃网关真吐的字节，
   * 修之前 `last.candidates[0].finish_reason` 与 `last.usage_metadata` **都是 None**；
   * 修之后分别是 `FinishReason.STOP` 与 `prompt_token_count=291 / candidates_token_count=16`。
   * 「上游没给」这条辩护也堵死了：同一网关 `/v1/chat/completions` 原样透传的流式末尾
   * 真实字节里含 `"finish_reason":"length"` 与 `"usage":{...}`。
   *
   * ⚠️ **改写而不是删除**：断言换成「终帧必须带这两样」，射程与上一版正好相反，
   * 但守的是同一处字节。**不许退化成「怎样都绿」**——下面第一条断言先钉住
   * 「最后一帧就是终帧」，缺帧时它先红。
   *
   * **变红条件（实测，见下方三条变异）**：删掉终帧那条 yield / 把 `finishReason`
   * 去掉 / 把 `usageMetadata` 去掉，三种各红一条断言。
   */
  it("终帧带 finishReason 与 usageMetadata —— 少了它们，被截断的半截回答与完整回答逐字节不可区分", async () => {
    const upstream = upstreamSse([
      { id: "c1", choices: [{ delta: { content: "甲" } }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
    ]);
    const wire = await new Response(toGeminiStream(upstream, "m")).text();
    const payloads = [...wire.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));

    // 前置条件：这一条流**真的**跑出了正文（不然下面几句是在一条空流上成立的）。
    expect(payloads[0]?.candidates[0].content.parts[0].text,
      "这一格没跑出正文来，下面几条断言是在一条空流上成立的").toBe("甲");

    const last = payloads.at(-1);
    // 期望值手写字面量：上游给的是 `length`，Gemini 那一档就该是 MAX_TOKENS
    //（映成 STOP 的话客户端会把一个被 max_tokens 截断的回答当成正常说完）。
    expect(last.candidates[0].finishReason, "终帧没有 finishReason —— 截断与说完在客户端看来一模一样")
      .toBe("MAX_TOKENS");
    expect(last.usageMetadata, "终帧没有 usageMetadata —— 下游一个 token 数都拿不到").toEqual({
      promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3,
    });
    // 终帧不许夹带正文：夹了的话面板与 SDK 会把它当成又一块回答接在后面。
    expect(last.candidates[0].content.parts, "终帧夹了正文").toEqual([]);
  });

  /**
   * **防住的真实故障**：上游中途断流时生成器静默退出、流直接关闭，客户端看到的
   * 与「正常说完」**逐字节相同**（gemini 这条流本来就没有 `[DONE]` 终止标记）。
   * `anthropic.ts` 在 v0.3.0 已经为这一条补了 `error` 事件，当时只修了三分之一。
   *
   * ⚠️ **第二条断言不许省**：断流那一帧要是也带上 `usageMetadata`，
   * 下游会把一次半截的回答按一个看起来正常的 token 数记进账。
   *
   * **变红条件（实测）**：把 `toGeminiStream` 里那圈 `try/catch` 去掉。
   */
  it("上游中途断流：终帧的 finishReason 是 OTHER，且不报 token 数", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "半" } }] })}\n\n`));
        c.error(new Error("上游炸了"));
      },
    });
    const wire = await new Response(toGeminiStream(upstream, "m")).text();
    const last = [...wire.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!)).at(-1);
    expect(last?.candidates[0].finishReason, "上游断了，这条流却收得和正常说完一模一样").toBe("OTHER");
    expect(last.usageMetadata, "断流那一帧不该报 token 数").toBeUndefined();
  });
});
