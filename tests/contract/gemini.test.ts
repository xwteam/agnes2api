import { describe, it, expect } from "vitest";
import { makeApp } from "../helpers/make-app.js";

describe("GET /v1beta/models", () => {
  it("返回 models 数组", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1beta/models", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { models: { name: string }[] };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.map((m) => m.name)).toContain("models/agnes-2.0-flash");
    // ⚠️ 与 `tests/contract/openai.test.ts`「返回 OpenAI 格式的模型清单」同一条理由：
    // 两条列模型端点交出的是同一份 `MODELS`，做模型发现的客户端只认它们其中一条
    // ⇒ 少列一个模型，对那个客户端就是这个模型不存在。数字与 id 都是手写字面量。
    expect(body.models.map((m) => m.name)).toContain("models/agnes-2.5-flash");
    expect(body.models.length, "这条端点交出去的模型数变了").toBe(12);
  });

  /**
   * **防住的真实故障**：`supportedGenerationMethods` 是 Gemini 协议里机器可读的
   * 「这个模型能干什么」，而从前这条端点对**视频模型**也声明支持 `generateContent`
   * ⇒ 照它渲染下拉框的客户端把 `agnes-video-2.5` 列成可对话模型，选中发一次对话
   * 就白烧一把 key + 一次全网关共享的限流额度。
   *
   * ⚠️ 这一格观测的是**端点真吐出去的 JSON**；「按形态分档」那条判据本身由
   * `tests/unit/gemini.test.ts`
   * 「只有对话模型声明支持那两个方法 —— 图片/视频模型给空数组，别把它们列成可对话模型」
   * 钉着。两条模型名是手写字面量。
   *
   * **变红条件（实测）**：把 `geminiModelList()` 里那个按 `modality` 分档的三元
   * 改回无条件给两条方法。
   */
  it("视频模型不声明支持 generateContent —— 那是一句会让客户端白烧一把 key 的假话", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1beta/models", { headers: { authorization: "Bearer t" } });
    const body = await res.json() as { models: { name: string; supportedGenerationMethods: string[] }[] };
    const of = (n: string) => body.models.find((m) => m.name === n)!.supportedGenerationMethods;
    expect(of("models/agnes-video-2.5"), "视频模型被声明成可对话").toEqual([]);
    // 反向控制（同格）：对话那一档没有被一起打掉。
    expect(of("models/agnes-2.0-flash")).toEqual(["generateContent", "streamGenerateContent"]);
  });

  it("缺少凭据时 401", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1beta/models");
    expect(res.status).toBe(401);
  });
});

describe("POST /v1beta/models/{model}:generateContent", () => {
  it("非流式请求把上游 OpenAI 响应转换为 candidates 结构", async () => {
    const upstream = {
      id: "c1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "你好" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    };
    const { app } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    const res = await app.request("/v1beta/models/agnes-2.0-flash:generateContent", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "你是助手" }] },
        contents: [{ role: "user", parts: [{ text: "你好" }] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      candidates: { content: { role: string; parts: { text: string }[] }; finishReason: string }[];
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
    };
    expect(body.candidates[0]!.content).toEqual({ role: "model", parts: [{ text: "你好" }] });
    expect(body.candidates[0]!.finishReason).toBe("STOP");
    expect(body.usageMetadata).toEqual({ promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 });
  });

  it("请求体在转发给上游前被压平为 messages，systemInstruction 提到首位", async () => {
    const upstream = { id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
    const { app, fetcher } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    await app.request("/v1beta/models/agnes-2.0-flash:generateContent", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "你是助手" }] },
        contents: [
          { role: "user", parts: [{ text: "甲" }, { text: "乙" }] },
          { role: "model", parts: [{ text: "丙" }] },
        ],
      }),
    });
    expect(fetcher.sentBodies).toHaveLength(1);
    const sent = JSON.parse(fetcher.sentBodies[0]!) as { model: string; messages: { role: string; content: string }[] };
    expect(sent.model).toBe("agnes-2.0-flash");
    expect(sent.messages).toEqual([
      { role: "system", content: "你是助手" },
      { role: "user", content: "甲乙" },
      { role: "assistant", content: "丙" },
    ]);
  });

  it("按最后一个冒号切分路径，模型名本身含冒号也不会切错", async () => {
    const upstream = { id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
    const { app, fetcher } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    const res = await app.request("/v1beta/models/vendor:agnes-2.0-flash:generateContent", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    expect(res.status).toBe(200);
    const sent = JSON.parse(fetcher.sentBodies[0]!) as { model: string };
    expect(sent.model).toBe("vendor:agnes-2.0-flash");
  });

  it("上游错误一律原样透传，不做 Gemini 格式转换", async () => {
    const upstreamError = { error: { message: "bad request" } };
    const { app } = await makeApp([{ status: 400, body: JSON.stringify(upstreamError) }]);
    const res = await app.request("/v1beta/models/agnes-2.0-flash:generateContent", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "x" }] }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(upstreamError);
  });

  it("缺少凭据时 401", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1beta/models/agnes-2.0-flash:generateContent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    });
    expect(res.status).toBe(401);
  });

  /**
   * 🔴 **方法名白名单：`:countTokens` 这类请求一次上游都不许发。**
   *
   * **防住的真实故障（线上真打复现过）**：从前方法名一个字都不校验，
   * `:countTokens` / `:embedContent` / 拼错的 `:generatecontent` 统统落进
   * generateContent 那个 handler。实测带合法 `contents` 打 `:countTokens` 返回
   * **200**，正文是一段真回答、`candidatesTokenCount: 43` —— 一次「数一下 token」
   * 被当成完整对话烧掉了：白烧池中一把 key + 一次**全网关共享**的 CF 限流额度，
   * 而客户端解析 `totalTokens` 拿到的是 undefined。`google-genai` 的
   * `client.models.count_tokens()` 走的正是这条路。
   *
   * ⚠️⚠️ **`fetcher.sentBodies` 那条断言才是这一格的重点**：只断言状态码的话，
   * 一个「先转发上游、再把响应丢掉返回 404」的实现照样绿，而账单和限流照收。
   *
   * **变红条件（实测）**：把 `src/http/routes/gemini.ts` 里那道白名单去掉。
   */
  it.each(["countTokens", "embedContent", "generatecontent"])(
    ":%s 一律 404，且一次上游请求都不发 —— 白烧的是全网关共享的限流额度",
    async (method) => {
      const upstream = { id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }] };
      const { app, fetcher } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
      const res = await app.request(`/v1beta/models/agnes-2.0-flash:${method}`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      });
      expect(res.status, `:${method} 没有被挡住`).toBe(404);
      expect(fetcher.sentBodies, `:${method} 真的打了一次上游`).toHaveLength(0);
      // 报文要点名本网关只实现哪两个方法，客户端才知道该怎么改。
      const body = await res.json() as { error: { message: string } };
      expect(body.error.message).toContain("generateContent");
    },
  );

  /**
   * **防住的真实故障（线上真打复现过）**：带一张 8×8 红色 PNG 的 `inline_data`
   * 打 `:generateContent` 回 **HTTP 200**，正文逐字是 `NO_IMAGE_RECEIVED` ——
   * 模型在完全没看到图的前提下编出来的答案，没有错误码、没有告警、没有事件。
   * `docs/zh-CN/API.md` 里那条「非 text 块一律 400」的承诺从前只覆盖 Anthropic。
   *
   * ⚠️ **`sentBodies` 那条断言同样是重点**：本地判得出来的畸形请求不许送上游。
   *
   * **变红条件（实测）**：把 `src/core/protocol/gemini.ts` 的 `partsText` 改回
   * `parts.map((p) => p.text ?? "").join("")`。
   */
  it("带图片的请求一律 400，不许静默丢掉图再回一段 200 的答案", async () => {
    const upstream = { id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }] };
    const { app, fetcher } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    const res = await app.request("/v1beta/models/agnes-2.0-flash:generateContent", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: "这图什么颜色?" },
            { inline_data: { mime_type: "image/png", data: "iVBORw0KGgo=" } },
          ],
        }],
      }),
    });
    expect(res.status, "带图的请求拿到了 200 —— 那段答案是模型没看到图编的").toBe(400);
    expect(fetcher.sentBodies, "本地判得出来的请求还是送去了上游").toHaveLength(0);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("inline_data");
  });
});

describe("POST /v1beta/models/{model}:streamGenerateContent", () => {
  it("流式请求返回 SSE 内容类型与转换后的 candidates 事件", async () => {
    const sse = [
      `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "你" } }] })}`,
      `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "好" }, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const { app } = await makeApp([{ status: 200, body: sse }]);
    const res = await app.request("/v1beta/models/agnes-2.0-flash:streamGenerateContent", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "你好" }] }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const payloads = [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));
    // 2 条正文 + 1 条终帧（`finishReason` + `usageMetadata`，形状由
    // `tests/unit/gemini.test.ts`
    // 「终帧带 finishReason 与 usageMetadata —— 少了它们，被截断的半截回答与完整回答逐字节不可区分」
    // 钉着；这里只确认这条真路由上它也在）。
    expect(payloads).toHaveLength(3);
    expect(payloads[0].candidates[0].content).toEqual({ role: "model", parts: [{ text: "你" }] });
    expect(payloads[1].candidates[0].content).toEqual({ role: "model", parts: [{ text: "好" }] });
    expect(payloads[2].candidates[0].finishReason).toBe("STOP");
  });

  it("请求体里 stream 标志按 :streamGenerateContent 方法名推导，不依赖客户端传入字段", async () => {
    const sse = `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "a" } }] })}\n\ndata: [DONE]\n\n`;
    const { app, fetcher } = await makeApp([{ status: 200, body: sse }]);
    await app.request("/v1beta/models/agnes-2.0-flash:streamGenerateContent", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    const sent = JSON.parse(fetcher.sentBodies[0]!) as { stream: boolean };
    expect(sent.stream).toBe(true);
  });
});
