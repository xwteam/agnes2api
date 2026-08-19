import { describe, it, expect } from "vitest";
import { makeApp, TEST_CONFIG } from "../helpers/make-app.js";
import { createApp } from "../../src/http/app.js";
import { fixedConfigHolder } from "../../src/http/config-holder.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { FakeFetcher } from "../helpers/fake-fetcher.js";
import type { Storage } from "../../src/ports/storage.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

// I3：app.ts 原本没有 onError，`c.req.json()` 与 `res.json()` 的异常直接冒泡，
// 五条路由实测全部返回 `500 Internal Server Error`（text/plain）：
// 既把客户端错误报成了服务端错误，响应也不是 JSON，四种协议的 SDK 都解析不了。

const POST_ROUTES = [
  ["OpenAI", "/v1/chat/completions"],
  ["Anthropic", "/v1/messages"],
  ["Gemini", "/v1beta/models/agnes-2.0-flash:generateContent"],
  ["OpenAI-Responses", "/v1/responses"],
  ["图片", "/v1/images/generations"],
  ["视频", "/v1/videos"],
] as const;

describe("客户端畸形 JSON 一律 400 JSON，而不是 500 纯文本", () => {
  for (const [name, path] of POST_ROUTES) {
    it(`${name} 路由 ${path}`, async () => {
      const { app, fetcher } = await makeApp([{ status: 200, body: "{}" }]);
      const res = await app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: "{ 这不是合法 JSON",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
      // 请求根本没成形，不该白白消耗一次上游调用。
      expect(fetcher.usedKeys).toEqual([]);
    });
  }
});

// 上面那批走的是路由主动抛的 HTTPException（Hono 自带处理）。真正需要 app.onError
// 兜底的是**预料之外**的异常，例如存储读失败——没有兜底时它会变成 Hono 默认的
// `500 Internal Server Error` 纯文本，客户端 SDK 解析 JSON 时二次报错，拿不到任何线索。
describe("预料之外的异常也落到 JSON 错误信封里", () => {
  class BrokenStorage implements Storage {
    async get<T>(): Promise<T | null> { throw new Error("磁盘挂了：/app/data/store.json"); }
    async put(): Promise<void> { throw new Error("磁盘挂了"); }
    async delete(): Promise<void> { throw new Error("磁盘挂了"); }
    async list(): Promise<string[]> { throw new Error("磁盘挂了：/app/data/store.json"); }
  }

  it("存储读失败时返回 JSON 500，且不回显内部异常细节", async () => {
    const app = createApp({
      version: "0.1.0", configHolder: fixedConfigHolder(TEST_CONFIG),
      repo: new KeyPoolRepo(new BrokenStorage(), { now: () => 1000, logger: NULL_LOGGER }),
      fetcher: new FakeFetcher([]), now: () => 1000,
      storageHealth: createStorageHealth(),
      logger: NULL_LOGGER,
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { type: "internal_error", message: "网关内部错误" } });
    // 异常信息里可能带上游 URL、路径、栈帧，一律不外泄。
    expect(text).not.toContain("store.json");
    expect(text).not.toContain("磁盘");
  });
});

describe("上游返回非 JSON 的 200", () => {
  const CONVERTING_ROUTES = [
    ["Anthropic", "/v1/messages", { model: "agnes-2.0-flash", max_tokens: 16, messages: [{ role: "user", content: "x" }] }],
    ["Gemini", "/v1beta/models/agnes-2.0-flash:generateContent", { contents: [{ role: "user", parts: [{ text: "x" }] }] }],
    ["OpenAI-Responses", "/v1/responses", { model: "agnes-2.0-flash", input: "x" }],
  ] as const;

  for (const [name, path, body] of CONVERTING_ROUTES) {
    it(`${name} 路由返回 502 JSON 而不是 500 纯文本`, async () => {
      const { app } = await makeApp([
        { status: 200, body: "<html>Bad Gateway</html>" },
      ], ["k1"]);
      const res = await app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  }

  it("非 JSON 的 200 会记在该 key 头上（strike），而不是无人负责", async () => {
    const { app, repo } = await makeApp([{ status: 200, body: "nope" }], ["k1"]);
    await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 16, messages: [{ role: "user", content: "x" }] }),
    });
    expect((await repo.all())[0]!.strikes).toBe(1);
  });
});

describe("Anthropic 无法映射的内容块", () => {
  it("返回 400 明确报错，而不是静默丢弃后照常请求上游", async () => {
    const { app, fetcher } = await makeApp([{ status: 200, body: "{}" }]);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        model: "agnes-2.0-flash", max_tokens: 16,
        messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message).toContain("image");
    expect(fetcher.usedKeys).toEqual([]);
  });

  it("system 为内容块数组时正常放行，且发给上游的 content 是字符串", async () => {
    const { app, fetcher } = await makeApp([{
      status: 200,
      body: JSON.stringify({ id: "c1", choices: [{ finish_reason: "stop", message: { content: "好" } }] }),
    }]);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        model: "agnes-2.0-flash", max_tokens: 16,
        system: [{ type: "text", text: "你是助手" }],
        messages: [{ role: "user", content: "你好" }],
      }),
    });
    expect(res.status).toBe(200);
    const sent = JSON.parse(fetcher.sentBodies[0]!) as { messages: { role: string; content: unknown }[] };
    expect(sent.messages[0]).toEqual({ role: "system", content: "你是助手" });
  });
});
