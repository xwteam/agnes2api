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
    expect(payloads).toHaveLength(2);
    expect(payloads[0].candidates[0].content).toEqual({ role: "model", parts: [{ text: "你" }] });
    expect(payloads[1].candidates[0].content).toEqual({ role: "model", parts: [{ text: "好" }] });
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
