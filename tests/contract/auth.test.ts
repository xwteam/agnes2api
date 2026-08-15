import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { auth } from "../../src/http/middleware/auth.js";

function appWith(token: string) {
  const app = new Hono();
  app.use("/v1/*", auth(token));
  app.all("/v1/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("鉴权中间件", () => {
  const app = appWith("secret");

  it("接受 Authorization Bearer", async () => {
    const res = await app.request("/v1/ping", { headers: { authorization: "Bearer secret" } });
    expect(res.status).toBe(200);
  });

  it("接受 x-api-key", async () => {
    const res = await app.request("/v1/ping", { headers: { "x-api-key": "secret" } });
    expect(res.status).toBe(200);
  });

  it("接受 x-goog-api-key", async () => {
    const res = await app.request("/v1/ping", { headers: { "x-goog-api-key": "secret" } });
    expect(res.status).toBe(200);
  });

  it("接受查询参数 key", async () => {
    const res = await app.request("/v1/ping?key=secret");
    expect(res.status).toBe(200);
  });

  it("无凭据返回 401", async () => {
    expect((await app.request("/v1/ping")).status).toBe(401);
  });

  it("凭据错误返回 401", async () => {
    const res = await app.request("/v1/ping", { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  it("Bearer 前缀大小写不敏感", async () => {
    const res = await app.request("/v1/ping", { headers: { authorization: "bearer secret" } });
    expect(res.status).toBe(200);
  });
});

describe("鉴权中间件 - 空凭据防御（auth('')）", () => {
  const app = appWith("");

  it("空 x-api-key 返回 401", async () => {
    const res = await app.request("/v1/ping", { headers: { "x-api-key": "" } });
    expect(res.status).toBe(401);
  });

  it("纯空白 x-api-key 返回 401", async () => {
    const res = await app.request("/v1/ping", { headers: { "x-api-key": "   " } });
    expect(res.status).toBe(401);
  });

  it("空查询参数 key 返回 401", async () => {
    const res = await app.request("/v1/ping?key=");
    expect(res.status).toBe(401);
  });

  it("纯空白查询参数 key 返回 401", async () => {
    const res = await app.request("/v1/ping?key=%20%20%20");
    expect(res.status).toBe(401);
  });

  it("空 x-goog-api-key 返回 401", async () => {
    const res = await app.request("/v1/ping", { headers: { "x-goog-api-key": "" } });
    expect(res.status).toBe(401);
  });
});
