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

// ── C-RM2：路由必须按端点的**延迟语义**挑超时档 ──────────────────────────────
//
// 这组用例走真实时钟，把两档超时按同一比例缩到毫秒级：`SLOW_UPSTREAM` 落在快档之外、
// 慢档之内。删掉 media.ts 里的 `timeout: "sync"` 会让图片/建任务两条用例变红；给轮询
// 也挂上 `sync` 会让轮询那条变红。
//
// 对话四条路由的判据是 `stream ? "firstByte" : "sync"`：非流式请求要等上游把整段回答
// 生成完才发响应头，与图片生成完全同一种延迟语义。把任意一条路由的 `timeout` 删掉
// （退回默认的 8 秒首字节档）都会让下面「非流式」那几条变红；反过来把它写死成 `sync`
// 则会让「流式」那条变红。
describe("端点的超时档位", () => {
  const SCALED = { upstreamTimeoutMs: 50, upstreamSyncTimeoutMs: 5000 };
  const SLOW_UPSTREAM = 300;
  const AUTH = { authorization: "Bearer t", "content-type": "application/json" };

  it("图片生成用同步档：上游远超快档预算才返回首字节，仍然成功", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: '{"created":1}', delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
    );
    const res = await app.request("/v1/images/generations", {
      method: "POST", headers: AUTH, body: JSON.stringify({ prompt: "一只猫" }),
    });
    expect(res.status).toBe(200);
  });

  it("视频建任务用同步档", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: '{"id":"task-1"}', delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
    );
    const res = await app.request("/v1/videos", {
      method: "POST", headers: AUTH, body: JSON.stringify({ prompt: "一只猫在跑" }),
    });
    expect(res.status).toBe(200);
  });

  it("视频轮询是快接口，仍用首字节档（上游拖过预算即失败，不给它两分钟）", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: "{}", delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
    );
    const res = await app.request("/v1/videos/task-1", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(503);
  });

  // 四种协议的非流式对话都必须走同步档：上游拖到快档预算之外照样成功，且 key 池毫发无损。
  // 原实现四条路由全用默认的 8 秒首字节档，一次这样的请求就把整池每把 key 各记一次
  // strike，三次即可全部打进 30 分钟长冷却。
  const nonStreaming = [
    ["OpenAI /v1/chat/completions", "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] }],
    ["Anthropic /v1/messages", "/v1/messages", { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }],
    ["Responses /v1/responses", "/v1/responses", { model: "m", input: "hi" }],
    ["Gemini generateContent", "/v1beta/models/m:generateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }] }],
  ] as const;

  for (const [name, path, body] of nonStreaming) {
    it(`${name} 非流式用同步档：慢上游照样成功，池毫发无损`, async () => {
      const upstream = JSON.stringify({
        id: "c1", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      const { app, repo } = await makeApp(
        [{ status: 200, body: upstream, delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
      );
      const res = await app.request(path, { method: "POST", headers: AUTH, body: JSON.stringify(body) });

      expect(res.status).toBe(200);
      const k1 = (await repo.all())[0]!;
      expect(k1.strikes).toBe(0);
      expect(k1.cooldownUntil).toBe(0);
    });
  }

  it("流式对话仍用首字节档：同一个慢上游被甩掉并记 strike（§7.3 语义不变）", async () => {
    const { app, repo } = await makeApp(
      [{ status: 200, body: "{}", delayMs: SLOW_UPSTREAM }], ["k1"], SCALED,
    );
    const res = await app.request("/v1/chat/completions", {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ model: "m", messages: [], stream: true }),
    });
    expect(res.status).toBe(503);
    expect((await repo.all())[0]!.strikes).toBe(1);
  });

  it("图片生成把整体预算耗尽才返回 504，且期间真的换过 key、没惩罚任何 key", async () => {
    // 这条要的是「超时之后怎么办」，把同步档也压到毫秒级，免得真等满 5 秒。
    // `now` 用真实时钟：同步档的整体 deadline 就是靠它推进的。
    const { app, repo, fetcher } = await makeApp(
      [
        { status: 200, body: "{}", delayMs: 60_000 },
        { status: 200, body: "{}", delayMs: 60_000 },
      ],
      ["k1", "k2"],
      { upstreamTimeoutMs: 50, upstreamSyncTimeoutMs: 120 },
      () => Date.now(),
    );
    const res = await app.request("/v1/images/generations", {
      method: "POST", headers: AUTH, body: JSON.stringify({ prompt: "x" }),
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { reason: "upstream_timeout" } });
    // 单把 key 超时不再吃掉整个请求：两把 key 都真的被试过了。
    // （轮询游标是模块级的，同一个测试文件里起始位置不定，故只断言集合。）
    expect([...fetcher.usedKeys].sort()).toEqual(["k1", "k2"]);
    expect((await repo.all()).every((r) => r.strikes === 0 && r.cooldownUntil === 0)).toBe(true);
  });
});
