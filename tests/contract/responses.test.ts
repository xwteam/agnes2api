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
    // ⚠️ **这串期望值 2026-09-10 改写了**：上一版只有 created + 两条 delta + completed
    // —— 那正是让官方 `openai` SDK 的 `responses.stream()` 崩在自己内部的形态
    //（IndexError，本地回放定案）。全文与证据在 `tests/unit/responses.test.ts`
    // 「产出官方最小事件序列：两条 added 打头、三条 done 收尾 —— 少任何一条官方 SDK 的 stream() 都崩在自己内部」。
    // 这一格观测的是**真路由真吐出去的字节**，与那一格互不替代。
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
   * **防住的真实故障**：客户端发了一张图，网关回 200、回一段模型完全没看到图编出来的
   * 答案。`docs/zh-CN/API.md` 里那条「非 text 块一律 400」的承诺从前只覆盖 Anthropic。
   *
   * ⚠️ **`sentBodies` 那条断言是重点**：本地判得出来的畸形请求不许送上游 ——
   * 送出去就是白烧一把 key + 一次全网关共享的限流额度。
   *
   * **变红条件（实测）**：把 `src/core/protocol/responses.ts` 的 `flat()` 改回
   * `c.map((p) => p.text ?? "").join("")`。
   */
  it("带图片的请求一律 400，不许静默丢掉图再回一段 200 的答案", async () => {
    const upstream = { id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }] };
    const { app, fetcher } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        model: "agnes-2.0-flash",
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: "这图什么颜色?" },
            { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
          ],
        }],
      }),
    });
    expect(res.status, "带图的请求拿到了 200 —— 那段答案是模型没看到图编的").toBe(400);
    expect(fetcher.sentBodies, "本地判得出来的请求还是送去了上游").toHaveLength(0);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("input_image");
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
