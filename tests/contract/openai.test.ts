import { describe, it, expect } from "vitest";
import { makeApp } from "../helpers/make-app.js";

describe("GET /v1/models", () => {
  it("返回 OpenAI 格式的模型清单", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1/models", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; data: { id: string }[] };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toContain("agnes-2.0-flash");
  });
});

describe("POST /v1/chat/completions", () => {
  it("非流式请求把上游响应原样返回", async () => {
    const upstream = { id: "c1", choices: [{ message: { role: "assistant", content: "hi" } }] };
    const { app } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream);
  });

  it("缺少凭据时 401", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("流式请求返回 SSE 内容类型", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n';
    const { app } = await makeApp([{ status: 200, body: sse }]);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", stream: true, messages: [] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain('"content":"a"');
  });

  it("流式请求补 Content-Type 时保留上游其余响应头", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n';
    const { app } = await makeApp([
      { status: 200, body: sse, headers: { "x-request-id": "req-123" } },
    ]);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", stream: true, messages: [] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-request-id")).toBe("req-123");
  });
});
