import { describe, it, expect } from "vitest";
import { makeApp } from "../helpers/make-app.js";

describe("POST /v1/messages", () => {
  it("缺少凭据时 401", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", max_tokens: 100, messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("非流式请求把上游 OpenAI 响应转换为 Anthropic content blocks 格式", async () => {
    const upstream = {
      id: "c1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "你好" } }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    };
    const { app } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        model: "agnes-2.0-flash", max_tokens: 100,
        system: "你是助手",
        messages: [{ role: "user", content: "你好" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      type: string; role: string; model: string;
      content: { type: string; text: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("agnes-2.0-flash");
    expect(body.content).toEqual([{ type: "text", text: "你好" }]);
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
  });

  it("请求体里的 system 与数组形态 content 在转发给上游前被压平", async () => {
    const upstream = { id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
    const { app, fetcher } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        model: "agnes-2.0-flash", max_tokens: 100,
        system: "你是助手",
        messages: [{ role: "user", content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] }],
      }),
    });
    expect(fetcher.sentBodies).toHaveLength(1);
    const sent = JSON.parse(fetcher.sentBodies[0]!) as { messages: { role: string; content: string }[] };
    expect(sent.messages).toEqual([
      { role: "system", content: "你是助手" },
      { role: "user", content: "甲乙" },
    ]);
  });

  it("流式请求返回 SSE 内容类型与完整的事件序列", async () => {
    const sse = [
      `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "你" } }] })}`,
      `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "好" }, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const { app } = await makeApp([{ status: 200, body: sse }]);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        model: "agnes-2.0-flash", max_tokens: 100, stream: true,
        messages: [{ role: "user", content: "你好" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_delta",
      "content_block_stop", "message_delta", "message_stop",
    ]);
  });

  it("上游错误一律原样透传，不做 Anthropic 格式转换", async () => {
    const upstreamError = { error: { message: "bad request" } };
    const { app } = await makeApp([{ status: 400, body: JSON.stringify(upstreamError) }]);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", max_tokens: 100, messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(upstreamError);
  });

  it("key 池为空时透传 503", async () => {
    const { app } = await makeApp([], []);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", max_tokens: 100, messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(503);
  });
});
