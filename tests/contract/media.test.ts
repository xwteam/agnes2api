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

// I1：{id} 原样拼进上游路径 = 已鉴权客户端可以拿池中的真实上游 key 打上游任意路径。
// 这些用例除了断言 400，还必须断言**一次上游请求都没发出**——只要发出去了，
// 携带的就是池里的真实 key。
describe("GET /v1/videos/{id} 的路径穿越防护", () => {
  const evil = [
    ["路径穿越（编码斜杠）", "/v1/videos/..%2F..%2Fadmin"],
    ["查询参数注入", "/v1/videos/x%3Fsecret%3D1"],
    ["整段 URL 覆盖", "/v1/videos/https%3A%2F%2Fevil.invalid%2Fx"],
    ["空白与换行", "/v1/videos/a%20b"],
  ] as const;

  for (const [name, path] of evil) {
    it(`${name} 返回 400 且不向上游发出任何请求`, async () => {
      const { app, fetcher } = await makeApp([{ status: 200, body: "{}" }]);
      const res = await app.request(path, { headers: { authorization: "Bearer t" } });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(fetcher.usedKeys).toEqual([]);
    });
  }

  // 裸的 `..` 在 URL 层就被规范化掉了（`/v1/videos/..` → `/v1/`），压根到不了这条
  // 路由，因此这里断言的是「无论落到哪个状态码，都没有携带池中 key 发出上游请求」。
  it("未编码的 .. 被 URL 规范化吃掉，同样不会向上游发出请求", async () => {
    const { app, fetcher } = await makeApp([{ status: 200, body: "{}" }]);
    const res = await app.request("/v1/videos/..", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fetcher.usedKeys).toEqual([]);
  });

  it("合法标识仍然放行，且拼出的上游 URL 不越出 /v1/videos/ 之下", async () => {
    const { app, fetcher } = await makeApp([{ status: 200, body: "{}" }]);
    const res = await app.request("/v1/videos/task_1-ABC", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    expect(fetcher.sentUrls).toEqual(["https://upstream.test/v1/videos/task_1-ABC"]);
  });
});
