import { describe, it, expect } from "vitest";
import { makeApp } from "../helpers/make-app.js";

describe("POST /v1/responses", () => {
  it("缺少凭据时 401", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", input: "你好" }),
    });
    expect(res.status).toBe(401);
  });

  it("非流式请求把上游 OpenAI 响应转换为 output 数组结构", async () => {
    const upstream = {
      id: "c1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "你好" } }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    };
    const { app } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", instructions: "你是助手", input: "你好" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      object: string; status: string; model: string;
      output: { type: string; role: string; content: { type: string; text: string }[] }[];
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("agnes-2.0-flash");
    expect(body.output[0]!.content).toMatchObject([{ type: "output_text", text: "你好" }]);
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 5, total_tokens: 8 });
  });

  it("请求体里的 instructions 与数组形态 input 在转发给上游前被转换为 messages", async () => {
    const upstream = { id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
    const { app, fetcher } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    await app.request("/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        model: "agnes-2.0-flash",
        instructions: "你是助手",
        input: [{ role: "user", content: [{ type: "input_text", text: "甲" }, { type: "input_text", text: "乙" }] }],
      }),
    });
    expect(fetcher.sentBodies).toHaveLength(1);
    const sent = JSON.parse(fetcher.sentBodies[0]!) as { messages: { role: string; content: string }[] };
    expect(sent.messages).toEqual([
      { role: "system", content: "你是助手" },
      { role: "user", content: "甲乙" },
    ]);
  });

  it("流式请求返回 SSE 内容类型且含 response.output_text.delta 事件", async () => {
    const sse = [
      `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "你" } }] })}`,
      `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "好" }, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const { app } = await makeApp([{ status: 200, body: sse }]);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", input: "你好", stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      "response.created", "response.output_text.delta", "response.output_text.delta", "response.completed",
    ]);
  });

  it("上游错误一律原样透传，不做 Responses 格式转换", async () => {
    const upstreamError = { error: { message: "bad request" } };
    const { app } = await makeApp([{ status: 400, body: JSON.stringify(upstreamError) }]);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", input: "x" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(upstreamError);
  });

  it("key 池为空时透传 503", async () => {
    const { app } = await makeApp([], []);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", input: "x" }),
    });
    expect(res.status).toBe(503);
  });
});
