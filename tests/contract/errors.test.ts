import { describe, it, expect } from "vitest";
import { makeApp, TEST_CONFIG, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { createApp } from "../../src/http/app.js";
import { fixedConfigHolder } from "../../src/http/config-holder.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { FakeFetcher } from "../helpers/fake-fetcher.js";
import type { Storage } from "../../src/ports/storage.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

// app.ts 原本没有 onError，`c.req.json()` 与 `res.json()` 的异常直接冒泡，
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

/**
 * ⚠️⚠️ **合法 JSON、但结构不对 —— 这一档从前是 500，而且没有任何判据钉着。**
 *
 * 2026-09-10 新加坡 Docker 验收实测出来的：`readJson()` 只管 JSON**语法**，
 * 语法过关之后请求体被无条件当成目标协议的类型送进 `toInternalRequest()`
 *（`readJson<T>` 只是**编译期**断言，运行期零校验），于是 `for (const m of req.messages)`
 * 在漏写时抛裸 TypeError ⇒ 被 `app.onError` 兜成 **500「网关内部错误」**。
 *
 * 🔴 **触发条件很现实，不是构造出来的畸形输入**：`{"model":"…"}`（模型名完全合法、
 * 只是漏写 `messages`）就够了。用户看到「网关内部错误」会以为网关挂了来报障。
 * 而且 OpenAI 官方 SDK 对 **5xx 默认重试 2 次** ⇒ 一个永远修不好的客户端错误被放大成
 * 3 倍请求，而上游那层 CF 的限流额度是**整个网关共享**的。
 *
 * **变红条件**：把任一条路由的形状校验删掉，或把 `catch` 从基类
 * `InvalidRequestError` 收窄回某一种具体子类（上一版 Anthropic 就是这么漏的）。
 */
describe("合法 JSON 但结构不对：必须 400，且一次上游都不许打", () => {
  const CASES: ReadonlyArray<readonly [string, string, unknown]> = [
    ["OpenAI 漏 messages", "/v1/chat/completions", { model: "m" }],
    ["OpenAI 漏 model", "/v1/chat/completions", { messages: [{ role: "user", content: "x" }] }],
    ["OpenAI messages 空数组", "/v1/chat/completions", { model: "m", messages: [] }],
    ["Anthropic 漏 messages", "/v1/messages", { model: "m", max_tokens: 8 }],
    ["Responses 漏 input", "/v1/responses", { model: "m" }],
    // 合法 JSON 但压根不是对象：`typeof null === "object"`、`[]` 也是 object，
    // 两者都能通过朴素的「是 object 吗」判断，然后在下一行属性访问上抛。
    ["OpenAI 请求体是数组", "/v1/chat/completions", []],
    ["Anthropic 请求体是 null", "/v1/messages", null],
    ["Responses 请求体是字符串", "/v1/responses", "hello"],
  ];

  for (const [name, path, body] of CASES) {
    it(`${name} ⇒ 400 且零上游调用`, async () => {
      const { app, fetcher } = await makeApp([{ status: 200, body: "{}" }]);
      const res = await app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, `${name}：客户端写错了请求体，必须是 4xx 不是 5xx`).toBe(400);
      expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
      // 🔴 **这一条比状态码更要紧**：从前 OpenAI 那条路由一次本地校验都没有，
      // 畸形请求被原样转发上游 ⇒ 每个都白烧一次整个网关共享的限流额度。
      expect(fetcher.usedKeys, `${name}：畸形请求被转发到上游了`).toEqual([]);
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
      // ⚠️ **`messages` 必须非空**：本格测的是「预料之外的异常落进 JSON 500 信封」，
      // 而空数组现在会被**本地形状校验**当场判 400（见
      // `src/core/protocol/request-shape.ts`：空数组送上游只会被上游以另一种措辞拒掉，
      // 白烧一次整个网关共享的限流额度）。夹具用空数组的话，请求根本走不到存储那一步，
      // 这一格就变成在测形状校验、而不是在测它自己声称测的东西。
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { type: "internal_error", message: "网关内部错误" } });
    // 异常信息里可能带上游 URL、路径、栈帧，一律不外泄。
    expect(text).not.toContain("store.json");
    expect(text).not.toContain("磁盘");
  });

/**
 * **兜成 500 的那一刻必须留下线索。**
 *
 * 实测缺陷：`app.onError` 从前只把异常吞掉换成一句固定文案，`/admin/api/events`
 * 与容器日志里**一条记录都没有** —— 线上真出 500 时运维无从知道是哪个端点、
 * 哪种请求体触发的，只能靠复现（实测 14 次 500 之后事件流零记录）。
 *
 * **变红条件**：把 `onError` 里那条 `deps.logger?.log(...)` 删掉。
 */
it("未预期异常会打一条带 method 与 path 的事件，但响应体一个字都不多给", async () => {
    const seen: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const app = createApp({
      version: "0.1.0", configHolder: fixedConfigHolder(TEST_CONFIG),
      repo: new KeyPoolRepo(new BrokenStorage(), { now: () => 1000, logger: NULL_LOGGER }),
      fetcher: new FakeFetcher([]), now: () => 1000,
      storageHealth: createStorageHealth(),
      logger: { log: (e) => { seen.push(e as typeof seen[number]); } },
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(500);

    const e = seen.find((x) => x.event === "http.unhandled_error");
    expect(e, "兜成 500 却没留下任何线索 —— 运维只能靠复现").toBeDefined();
    expect(e?.fields?.method).toBe("POST");
    expect(e?.fields?.path).toBe("/v1/chat/completions");
    expect(String(e?.fields?.error), "线索里要认得出是什么异常").toContain("磁盘");

    // ⚠️ **响应体仍然一个字都不多给**：异常信息里可能带上游 URL、路径、栈帧。
    // 线索走事件那一侧（只有运维看得到），不走响应体。
    const text = await res.text();
    expect(text).not.toContain("磁盘");
    expect(text).not.toContain("store.json");
  });
});

/**
 * ⚠️⚠️ **兜底 404 / 405 —— 2026-09-10 验收实测发现的两处一致性问题。**
 *
 * ① **404 从前是 Hono 默认的 `text/plain`「404 Not Found」**，而同一个网关的
 *    400 / 401 / 500 全是 JSON 信封。OpenAI 兼容客户端遇到 4xx 会先 `response.json()`
 *    去取错误体 ⇒ 拿到纯文本时抛的是**解析异常**而不是干净的 `NotFoundError`，
 *    用户看到的报错与「路径写错了」毫无关系。
 * ② **方法不对也回 404**（`GET /v1/chat/completions` 是最容易撞上的那一条），
 *    排障被带偏成「路由不存在 / 版本不对」，而真相只是方法写错了。
 *
 * **405 这一档是先实测了 Hono 能不能区分才写的**（Hono 4.13.2，最小复现跑过）：
 * `app.router.match(m, path)` 每一项是 `[[handler, RouterRoute], params]`，
 * `RouterRoute.method` 对 `app.use()` 挂的中间件是 `"ALL"`、对具体路由是大写方法名，
 * 因此「这条路径上除了中间件之外还有没有别的方法命中」是**算得出来**的
 * ——不是靠 Hono 自带的语义（它把两者一律落进 `notFound`）。
 */
describe("没有路由命中：404 是 JSON 信封，方法不对是 405 + Allow", () => {
  /**
   * **变红条件**：把 `src/http/app.ts` 的 `app.notFound(...)` 整段删掉
   *（回到 Hono 默认的纯文本 404）⇒ content-type 那条当场红。
   */
  it("压根没注册的路径：404 + JSON，信封与 400/401/500 同族", async () => {
    const { app } = await makeApp();
    const res = await app.request("/definitely-not-a-route");
    expect(res.status).toBe(404);
    // 🔴 **这一条是本组的核心**：`text/plain` 会让 openai-python 这类客户端在
    // 解析错误体那一步抛异常，而不是抛一个干净的 NotFoundError。
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: { type: "not_found", message: "没有这条路由" } });
    // 路径不存在 ≠ 方法不对：这一档不许带 Allow，带了就是在暗示「换个方法就有了」。
    expect(res.headers.get("allow"), "路径压根不存在，却给出了一份可用方法清单").toBeNull();
  });

  it("信封的形状与同一个 app 上的 401 逐字同族（只有 type/message 两格）", async () => {
    const { app } = await makeApp();
    const notFound = await (await app.request("/definitely-not-a-route")).json() as
      { error: Record<string, unknown> };
    // 401 走的是鉴权中间件那条独立路径，两边同族才说明「网关自己产生的错误一个形状」。
    const unauthorized = await (await app.request("/v1/models")).json() as
      { error: Record<string, unknown> };
    expect(Object.keys(notFound.error).sort()).toEqual(["message", "type"]);
    expect(Object.keys(unauthorized.error).sort()).toEqual(Object.keys(notFound.error).sort());
  });

  /**
   * 🔴 **405 那一档**。`Allow` 是 RFC 9110 §15.5.6 对 405 的 MUST，
   * 而且它就是排障要的那句答案本身。
   *
   * **变红条件**：把 `otherMethodsFor()` 里那句 `handler[1].method === candidate`
   * 换成 `true`（即把中间件也当成证据）⇒ 上面那条「没注册的路径」会变成 405 而红；
   * 把它整段去掉、恒返回 `[]` ⇒ 这一组全红。
   */
  const METHOD_MISMATCH: ReadonlyArray<readonly [string, string, string, string]> = [
    ["OpenAI 对话（最容易撞上的一条）", "GET", "/v1/chat/completions", "POST"],
    ["Anthropic", "DELETE", "/v1/messages", "POST"],
    ["OpenAI-Responses", "PUT", "/v1/responses", "POST"],
    ["模型列表反过来打", "POST", "/v1/models", "GET"],
    ["健康检查反过来打", "POST", "/health", "GET"],
    // 参数化路径也要算得出来：`/v1/videos/:id` 只注册了 GET。
    ["视频轮询（参数化路径）", "POST", "/v1/videos/vid_abc123", "GET"],
  ];

  for (const [name, method, path, allow] of METHOD_MISMATCH) {
    it(`${name}：${method} ${path} ⇒ 405 + Allow: ${allow}`, async () => {
      const { app } = await makeApp();
      const res = await app.request(path, {
        method,
        // **带上合法口令**：401 与 405 是两条不同的路径，不带口令的话
        // `/v1/*` 那条鉴权中间件会先把请求拦下，这一格就测不到它自己声称测的东西。
        headers: { authorization: "Bearer t" },
      });
      expect(res.status, `${name}：方法不对却回了 ${res.status}，排障会被带偏成「路由不存在」`)
        .toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ error: { type: "method_not_allowed" } });
    });
  }

  it("同一条路径注册了多个方法时，Allow 把它们全列出来", async () => {
    const { app } = await makeApp();
    // `/admin/api/apikeys` 上 GET 与 POST 各一条。**必须带管理口令**：
    // 不带的话 adminAuth 先回 401，走不到兜底。
    const res = await app.request("/admin/api/apikeys", {
      method: "DELETE",
      headers: { "x-admin-key": TEST_ADMIN_TOKEN },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });

  /**
   * ⚠️ **`notFound` 是兜底，不是「所有 404 的出口」。** `/admin` 那棵树里静态资源
   * 查表落空时是 `uiRoutes()` 自己返回的纯文本 404（带全套面板安全头）——它服务的是
   * 浏览器而不是 SDK，那一条**故意**不走这里，见 `src/ui/serve.ts` 里那段说明。
   * 这一格把边界钉住：改动兜底时别顺手把面板那条也一起改了。
   */
  it("面板静态树自己那条 404 不受影响，仍是纯文本 + 全套安全头", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/no-such-asset.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
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
