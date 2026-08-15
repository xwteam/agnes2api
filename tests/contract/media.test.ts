import { describe, it, expect } from "vitest";
import { makeApp } from "../helpers/make-app.js";

describe("POST /v1/images/generations", () => {
  it("把上游图片响应原样返回", async () => {
    const upstream = { created: 1, data: [{ url: "https://example.invalid/a.png" }] };
    const { app } = await makeApp([{ status: 200, body: JSON.stringify(upstream) }]);
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-image-2.1-flash", prompt: "一只猫" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream);
  });

  it("无凭据返回 401", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/v1/images/generations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("视频两段式", () => {
  it("POST /v1/videos 建任务后返回任务标识", async () => {
    const { app } = await makeApp([{ status: 200, body: '{"id":"task-1","status":"queued"}' }]);
    const res = await app.request("/v1/videos", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-video-v2.0", prompt: "一只猫在跑" }),
    });
    expect(await res.json()).toMatchObject({ id: "task-1" });
  });

  it("GET /v1/videos/{id} 轮询取结果", async () => {
    const { app, fetcher } = await makeApp([
      { status: 200, body: '{"id":"task-1","status":"completed","url":"https://example.invalid/a.mp4"}' },
    ]);
    const res = await app.request("/v1/videos/task-1", { headers: { authorization: "Bearer t" } });
    expect(await res.json()).toMatchObject({ status: "completed" });
    expect(fetcher.usedKeys).toHaveLength(1);
  });
});
