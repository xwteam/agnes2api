import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readGatewayToken, writeGatewayToken, sendToGateway, streamFromGateway, GatewayError,
} from "../../admin-ui/js/gw-api.js";
import { KEY_STORE, GW_KEY_STORE } from "../../admin-ui/js/pure/storage-keys.mjs";
import { playgroundProtocols, buildRequest } from "../../admin-ui/js/pure/playground.mjs";
import { catalogPayload } from "../../src/core/admin/protocol-catalog.js";

/**
 * **Playground 的对外出口。**
 *
 * 被守护的是设计 §10.5 那条「两把钥匙严格隔离」的**另一半**。
 * `tests/ui/api-session.test.ts` 的「凭据头只有 x-admin-key —— 没有任何网关口令头」
 * 守的是管理那一侧（管理接口不许带网关口令）；这一组守对外这一侧
 * （对外请求不许带管理口令）。**两个方向缺一不可**：只守一侧的话，
 * 把管理口令顺手加进对外请求的请求头里不会有任何东西变红，
 * 而那把口令会被送去一条**不需要它、也不校验它**的路径上——它会出现在
 * CF 访问日志、反代日志与上游网关的入站日志里。
 *
 * ⚠️ 这一组的观测点全部落在**被桩掉的 `fetch` 收到了什么**上
 * （URL、请求头、请求体），不落在 `sendToGateway()` 自己的返回值上
 * （第 5 条方法论：handler 自报的字段只能证明它说了什么）。
 */
const GW_TOKEN = "gateway-token-0123456789-abcd";
const ADMIN_TOKEN = "admin-token-0123456789-ok!";
const ORIGIN = "https://gw-probe.invalid";

let store: Record<string, string>;
let fetchCalls: Array<{ url: string; init: RequestInit }>;

/** 下一次 `fetch` 怎么应答；默认 200 + 一段 JSON。 */
let responder: () => Response | Promise<Response>;

beforeEach(() => {
  store = {};
  fetchCalls = [];
  responder = () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return responder();
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 真实目录窄化之后那四条协议。**不手抄一份**（第 7 种假阳性）。 */
function realProtocols() {
  const list = playgroundProtocols(catalogPayload());
  expect(list, "前置条件：真实目录必须窄化得出来").not.toBe(null);
  return list!;
}

/** 拿真实目录的第 `i` 条协议构造一次请求。 */
function reqFor(i: number) {
  const req = buildRequest(realProtocols()[i]!, {
    model: "agnes-2.0-flash", prompt: "你好", stream: false, origin: ORIGIN,
  });
  expect(req, "前置条件：请求必须构造得出来").not.toBe(null);
  return req;
}

/** 这一次真正送出去的请求头（小写键名，浏览器的行为）。 */
function headersOf(i = 0): Record<string, string> {
  return (fetchCalls[i]!.init.headers ?? {}) as Record<string, string>;
}

describe("两把钥匙隔离：对外这一侧", () => {
  /**
   * **管理口令绝不许走上对外那条路。**
   *
   * 变红条件：往 `sendToGateway()` 的 `headers` 里加一行 `x-admin-key`
   * （无论值从哪来）——那把口令会被送去一条不需要它、也不校验它的路径上，
   * 并留在沿途每一级的访问日志里。
   *
   * ⚠️ **逐个列名字，不只查 `x-admin-key` 一个**：整份头里除了这条协议惯用的那一个
   * 鉴权头与 `content-type` **不许再有第三个**。只查一个名字的话，
   * 换成 `x-admin-token` / `authorization` 之类同样是把管理口令带出去。
   */
  it("凭据头里没有 x-admin-key —— 管理口令绝不许走上对外那条路", async () => {
    // 浏览器里两把口令是同时存在的：管理口令刚登录完就在那儿。
    store[KEY_STORE] = ADMIN_TOKEN;
    store[GW_KEY_STORE] = GW_TOKEN;

    await sendToGateway(reqFor(0), GW_TOKEN, { origin: ORIGIN });

    const headers = headersOf();
    // 正面：网关口令确实带上了（少了这一条，「没有别的头」在一个空对象上也成立）。
    expect(headers["authorization"]).toBe(`Bearer ${GW_TOKEN}`);
    // 反面：整份头的名字集合手写钉死。
    expect(Object.keys(headers).sort(), "对外请求的请求头里多了一个").toEqual(
      ["authorization", "content-type"],
    );
    // 逐字段扫一遍：管理口令的任何一个字节都不许出现在这次请求的任何一处。
    const wire = JSON.stringify({ url: fetchCalls[0]!.url, headers, body: fetchCalls[0]!.init.body });
    expect(wire, "管理口令漏进了对外请求").not.toContain(ADMIN_TOKEN);
  });

  /**
   * **口令只走请求头，禁止查询参数。**
   *
   * 对外那棵树的鉴权确实收查询参数（`src/http/middleware/auth.ts`，为 Gemini 协议兼容），
   * **但面板不继承它**：口令进 URL 会落进浏览器历史、Referer、CF 访问日志、反代日志。
   *
   * 变红条件：把 `sendToGateway()` 改成往 `target.searchParams` 里塞一份口令。
   */
  it("口令只在请求头里，URL 上一个字节都没有 —— 进 URL 就会落进历史与各级访问日志", async () => {
    await sendToGateway(reqFor(3), GW_TOKEN, { origin: ORIGIN });
    const url = fetchCalls[0]!.url;
    // 期望值手写字面量：这一条就是 Gemini 那条对外地址，一个查询参数都没有。
    expect(url).toBe("https://gw-probe.invalid/v1beta/models/agnes-2.0-flash:generateContent");
    expect(url, "口令进了 URL").not.toContain(GW_TOKEN);
    expect(url, "URL 上出现了查询串").not.toContain("?");
    // 头里必须真的有它，否则上面那两条在「口令根本没带」时也成立。
    expect(headersOf()["x-goog-api-key"]).toBe(GW_TOKEN);
  });

  /**
   * **四条协议各带各的头，值的形状也各不相同。**
   * 写死任何一个的后果是：那条协议要么根本认不出这把口令（401），要么把口令送进了
   * 一个网关不查的头里——而后者更阴，它看起来像「口令错了」。
   *
   * ⚠️ 期望值逐条手写，**不从目录推导**（第 6 种假阳性）。
   */
  it("四条协议的鉴权头与值逐条手写钉死 —— Bearer 前缀只加在 authorization 上", async () => {
    const seen: Array<Record<string, string>> = [];
    for (let i = 0; i < 4; i++) {
      fetchCalls = [];
      await sendToGateway(reqFor(i), GW_TOKEN, { origin: ORIGIN });
      seen.push(headersOf());
    }
    expect(seen.map((h) => Object.keys(h).sort().join(","))).toEqual([
      "authorization,content-type",
      "content-type,x-api-key",
      "authorization,content-type",
      "content-type,x-goog-api-key",
    ]);
    expect(seen[0]!["authorization"]).toBe(`Bearer ${GW_TOKEN}`);
    expect(seen[1]!["x-api-key"]).toBe(GW_TOKEN);
    expect(seen[2]!["authorization"]).toBe(`Bearer ${GW_TOKEN}`);
    expect(seen[3]!["x-goog-api-key"]).toBe(GW_TOKEN);
  });

  /**
   * **同源自查：口令只许送去面板自己所在的那个源。**
   *
   * URL 是拿运行期的 origin 拼的，正常情况下它恒同源；这一格把「同源」从一条
   * **推导出来的**性质变成一条**被检查的**性质。一份被改过的协议目录
   * （管理接口被穿透、或反代插了一手）足以把路径模板换成一条指向别处的地址，
   * 而那一刻送出去的是**发给每一个下游用户的那把中转口令**。
   *
   * 变红条件：删掉 `sendToGateway()` 里那条 `target.origin !== origin` 的早退。
   */
  it("目录把路径换成了别的源：一个字节都不发 —— 送出去的是发给每个下游用户的那把口令", async () => {
    const hostile = {
      id: "x", label: "X", method: "POST",
      // ⚠️⚠️ **这条探针的形状很要紧，它是实测挑出来的，不是想出来的。**
      // 第一版写的是一条绝对地址（`https://exfil.invalid/collect`），
      // 而 `buildRequest()` 拼的是 `origin + path` ⇒ 拼出来的是
      // `https://gw-probe.invalidhttps://exfil.invalid/collect`，**仍然同源**，
      // 这一格的前置条件当场就没通过。
      // 真正能从 `origin + path` 里翻出一个**别的源**的形态是**用户信息段**：
      // 前面那一整段 origin 会被 URL 解析器当成 `userinfo`，`@` 后面的才是主机。
      // ⇒ 这道同源自查因此是**真的在守一件做得到的事**，不是装饰。
      pathTemplate: "@exfil.invalid/collect",
      authHeader: "authorization", streamMode: "body", streamKey: "stream",
      streamTextPath: ["delta"],
      sampleBody: { model: "m0", input: "ping" },
    };
    const list = playgroundProtocols({ protocols: [hostile], samplePrompt: "ping" })!;
    const req = buildRequest(list[0], { model: "m9", prompt: "你好", stream: false, origin: ORIGIN });
    // 前置条件：拼出来的地址确实落在另一个源上，否则这一格什么都没验到。
    expect(new URL(req!.url).origin, "前置条件：探针必须真的指向别处").toBe("https://exfil.invalid");

    const err = await sendToGateway(req, GW_TOKEN, { origin: ORIGIN }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("cross_origin");
    // **观测点在「有没有发出去」上**，不在返回值上。
    expect(fetchCalls, "拼出来的地址指向别处，却还是把口令发出去了").toEqual([]);
  });

  it("origin 传空时同样一个字节都不发 —— fail closed，别把「不知道自己在哪」当成同源", async () => {
    const err = await sendToGateway(reqFor(0), GW_TOKEN, { origin: "" }).catch((e) => e);
    expect((err as GatewayError).code).toBe("cross_origin");
    expect(fetchCalls).toEqual([]);
  });
});

describe("请求本体", () => {
  it("方法、请求体与 credentials 逐条钉死 —— 本项目没有 Cookie 会话，带上只会扩大攻击面", async () => {
    const req = reqFor(0);
    await sendToGateway(req, GW_TOKEN, { origin: ORIGIN });
    const init = fetchCalls[0]!.init;
    expect(init.method).toBe("POST");
    // `credentials` 在 workerd 的 `RequestInit` 类型里没有这一格，而浏览器有；
    // 这里只是把替身记下来的那份原样读出来，不是给发货代码加类型。
    expect((init as unknown as { credentials?: string }).credentials).toBe("omit");
    // 请求体逐字：期望值手写，用户那句话必须真的在里面。
    expect(JSON.parse(String(init.body))).toEqual({
      model: "agnes-2.0-flash",
      messages: [{ role: "user", content: "你好" }],
    });
  });

  /**
   * ── **跨源重定向（同源自查只管第一条 URL）** ─────────────────────────────────
   *
   * `fetch` 的 `redirect` 默认是 `follow`，而同源自查在**发请求之前**就做完了
   * ⇒ 同源某条路径回一个 302 指向别处时，浏览器会跟过去。
   * ⚠️⚠️ **不能指望浏览器替我们剥掉那个头**：Fetch 规范里 CORS non-wildcard
   * request-header name **只有 `authorization` 一个**，跨源重定向时只删它；
   * 而四条协议里 Anthropic 用 `x-api-key`、Gemini 用 `x-goog-api-key`，
   * **这两个不会被删**，会原样跟到新源——那一刻送出去的仍是发给每个下游用户的那把口令。
   *
   * ⚠️ **这一格是形状断言，弱于行为断言，如实说明**：本文件的
   * `fetch` 替身不实现重定向语义，所以这里验的是**「那一格确实交给了 fetch」**，
   * 真正拒绝重定向的是浏览器。它拦得住的是「有人顺手把这一格删掉/改成 follow」
   * ——而那正是这条防线唯一现实的失效方式。
   *
   * **变红条件**：把 `sendToGateway()` 里那行 `redirect: "error"` 删掉，
   * 或改成 `"follow"` / `"manual"`。
   */
  it("重定向一律当错误处理 —— 跟过去的话 x-api-key / x-goog-api-key 会被原样带到新源", async () => {
    await sendToGateway(reqFor(1), GW_TOKEN, { origin: ORIGIN });
    // 期望值手写字面量。`"follow"`（默认）与 `"manual"` 都不行：前者会跟过去，
    // 后者交出一个 opaqueredirect 响应，而面板会把它当成一次「读不出来」的正常应答。
    expect(
      (fetchCalls[0]!.init as unknown as { redirect?: string }).redirect,
      "重定向没有被拒绝 —— 这一次带的是 x-api-key，跨源重定向时浏览器不会替我们删它",
    ).toBe("error");
    // 前置条件：这一次带的确实是那个**不会被浏览器剥掉**的头，否则这一格证不了什么。
    expect(headersOf()["x-api-key"], "前置条件：这一次得真的带着 x-api-key").toBe(GW_TOKEN);
  });

  it("调用方给的 signal 原样透传 —— 不透传的话取消按钮会变成一颗按了没反应的按钮", async () => {
    const ctl = new AbortController();
    await sendToGateway(reqFor(0), GW_TOKEN, { origin: ORIGIN, signal: ctl.signal });
    expect(fetchCalls[0]!.init.signal, "signal 没有交给 fetch").toBe(ctl.signal);
  });

  it("非 JSON 响应：body 是 null 而不是空对象 —— 空对象会与「上游回了一个空对象」长得一样", async () => {
    responder = () => new Response("<html>502 bad gateway</html>", { status: 502 });
    const r = await sendToGateway(reqFor(0), GW_TOKEN, { origin: ORIGIN });
    expect(r.status, "状态码必须原样交出来").toBe(502);
    expect(r.ok).toBe(false);
    expect(r.body).toBe(null);
  });

  it("上游 4xx 不抛错，原样交给调用方 —— 401 是一条真信号，不是一次传输失败", async () => {
    responder = () => new Response('{"error":{"message":"invalid token"}}', {
      status: 401, headers: { "content-type": "application/json" },
    });
    const r = await sendToGateway(reqFor(0), GW_TOKEN, { origin: ORIGIN });
    expect(r.status).toBe(401);
    expect(r.ok).toBe(false);
    expect(r.body).toEqual({ error: { message: "invalid token" } });
  });

  /**
   * **传输层失败抛的是档位名，错误里一个口令字节都没有。**
   *
   * 变红条件：把 `catch` 里那句改成
   * `throw new GatewayError(\`transport_error: ${JSON.stringify(headers)}\`)` 之类
   * ——那是口令漏进错误文案最自然的一条路径（全局约束 11(b)）。
   */
  it("断网时抛 GatewayError，且 message 与 code 里都不含口令 —— 错误文案是口令最自然的泄漏口", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    const err = await sendToGateway(reqFor(0), GW_TOKEN, { origin: ORIGIN }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("transport_error");
    expect((err as GatewayError).message, "错误文案里带上了口令").not.toContain(GW_TOKEN);
    // 逐段扫：口令里任何一段长度 >= 4 的子串都不许出现在错误里。
    const text = `${(err as GatewayError).message}|${(err as GatewayError).code}`;
    for (let i = 0; i + 4 <= GW_TOKEN.length; i++) {
      expect(text, `错误里带上了口令的片段：${GW_TOKEN.slice(i, i + 4)}`)
        .not.toContain(GW_TOKEN.slice(i, i + 4));
    }
  });
});

describe("网关口令的存取", () => {
  /**
   * **网关口令与管理口令用的是两个不同的存储键。**
   * 共用一个的后果是：面板登录一次就把 Playground 那格里的中转口令覆盖掉
   * （或者反过来），而两条路径都不会报任何错。
   *
   * 变红条件：把 `readGatewayToken()` / `writeGatewayToken()` 里的 `GW_KEY_STORE`
   * 换成 `KEY_STORE`。
   */
  it("写网关口令只碰它自己那个键，管理口令那格一个字都不动", () => {
    store[KEY_STORE] = ADMIN_TOKEN;
    writeGatewayToken(GW_TOKEN);
    expect(store[GW_KEY_STORE]).toBe(GW_TOKEN);
    expect(store[KEY_STORE], "写网关口令把管理口令覆盖掉了").toBe(ADMIN_TOKEN);
    expect(readGatewayToken()).toBe(GW_TOKEN);
  });

  it("存空串等于清掉，而不是留一个空值 —— 留着会让「粘过又清空」与「从来没粘过」分不开", () => {
    writeGatewayToken(GW_TOKEN);
    expect(GW_KEY_STORE in store, "前置条件：先得真的存进去过").toBe(true);
    writeGatewayToken("");
    expect(GW_KEY_STORE in store, "空串被当成一个值存了下来").toBe(false);
    expect(readGatewayToken()).toBe("");
  });

  it("隐私模式（localStorage 抛错）时读到空串、写不抛 —— 本次会话照常可用", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    });
    expect(readGatewayToken()).toBe("");
    expect(() => writeGatewayToken(GW_TOKEN)).not.toThrow();
  });
});

/**
 * ── **流式那条路** ─────────────────────────────────────────────────────────────
 *
 * ⚠️⚠️ **本组存在的全部理由**：上一期把四条安全性质（同源自查、`redirect: "error"`、
 * `credentials: "omit"`、口令只走请求头）**逐条钉在了非流式那条路上**。
 * 流式是一条**新的**代码路径 —— 上面那四格**一格都不覆盖它**。
 * 「两条路共用同一个 `openGateway()`」是实现上的选择，而**选择是会被改掉的**：
 * 下一个人完全可能为了「流式要特殊处理」把它拆成两份，而拆的那一刻上面四格照样全绿。
 * ⇒ **同一组判据在两条路上各断言一遍**，别指望共用那件事自己守着自己。
 */
describe("流式那条路：与非流式同一组安全判据，逐条各断言一遍", () => {
  /** 一段最小的 SSE 响应（openai 形状，真源里的第一条协议）。 */
  const WIRE = 'data: {"id":"c1","choices":[{"delta":{"content":"甲"}}]}\n\ndata: [DONE]\n\n';

  /** 收集这一次流式请求交出来的负载。 */
  async function streamOnce(req: unknown, opts: Record<string, unknown> = {}) {
    const seen: string[] = [];
    const r = await streamFromGateway(req, GW_TOKEN, {
      origin: ORIGIN, onPayload: (p: string) => seen.push(p), ...opts,
    });
    return { seen, r };
  }

  it("凭据头里没有 x-admin-key —— 管理口令绝不许走上对外那条路（流式这一侧）", async () => {
    store[KEY_STORE] = ADMIN_TOKEN;
    responder = () => new Response(WIRE, { status: 200, headers: { "content-type": "text/event-stream" } });
    await streamOnce(reqFor(0));
    const headers = headersOf(0);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("x-admin-key");
    // 反向：整份请求头里一个字节的管理口令都不许有。
    expect(JSON.stringify(headers), "管理口令走上了对外那条路").not.toContain(ADMIN_TOKEN);
  });

  it("口令只在请求头里，URL 上一个字节都没有（流式这一侧）—— 进 URL 就会落进历史与各级访问日志", async () => {
    responder = () => new Response(WIRE, { status: 200 });
    await streamOnce(reqFor(0));
    expect(fetchCalls[0]!.url, "网关口令进了 URL").not.toContain(GW_TOKEN);
    // 末 8 位同样不许 —— 一条末位旁路同样是旁路。
    expect(fetchCalls[0]!.url).not.toContain(GW_TOKEN.slice(-8));
    expect(headersOf(0)["authorization"], "口令没走请求头").toBe(`Bearer ${GW_TOKEN}`);
  });

  /**
   * **同源自查在流式这一侧同样有效。**
   *
   * **变红条件**：给 `streamFromGateway()` 单独写一次 `fetch`（不走 `openGateway()`）
   * ——那一刻这一格立刻红，而非流式那四格照样全绿。
   */
  it("流式与非流式走同一道同源自查 —— 两条路各写一份的话，漏掉的那份会把口令送去别处", async () => {
    const hostile = {
      id: "x", label: "X", method: "POST",
      // 与非流式那一格同一条探针：`origin + path` 经 `userinfo` 段翻出另一个源。
      pathTemplate: "@exfil.invalid/collect",
      authHeader: "authorization", streamMode: "body", streamKey: "stream",
      streamTextPath: ["delta"],
      sampleBody: { model: "m0", input: "ping" },
    };
    const list = playgroundProtocols({ protocols: [hostile], samplePrompt: "ping" })!;
    const req = buildRequest(list[0], { model: "m9", prompt: "你好", stream: true, origin: ORIGIN });
    expect(new URL(req!.url).origin, "前置条件：探针必须真的指向别处").toBe("https://exfil.invalid");

    const err = await streamFromGateway(req, GW_TOKEN, { origin: ORIGIN, onPayload: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("cross_origin");
    // **观测点在「有没有发出去」上**，不在返回值上。
    expect(fetchCalls, "流式那条路把口令发去了别处").toEqual([]);

    // `origin` 传空同样 fail closed（交接第 1 条：`origin` 是硬前提）。
    const err2 = await streamFromGateway(req, GW_TOKEN, { origin: "", onPayload: () => {} }).catch((e) => e);
    expect((err2 as GatewayError).code).toBe("cross_origin");
    expect(fetchCalls).toEqual([]);
  });

  it("流式同样 redirect: error 且 credentials: omit —— 跨源 302 会把 x-api-key 原样带走", async () => {
    responder = () => new Response(WIRE, { status: 200 });
    await streamOnce(reqFor(0));
    const init = fetchCalls[0]!.init as RequestInit & { credentials?: string };
    expect(init.redirect, "流式那条路会跟着重定向走").toBe("error");
    expect(init.credentials).toBe("omit");
  });

  it("调用方给的 signal 原样透传（流式这一侧）—— 不透传的话取消按钮会变成一颗按了没反应的按钮", async () => {
    responder = () => new Response(WIRE, { status: 200 });
    const ctl = new AbortController();
    await streamOnce(reqFor(0), { signal: ctl.signal });
    expect(fetchCalls[0]!.init.signal, "signal 没被透传").toBe(ctl.signal);
  });

  /**
   * **跨 chunk 的那条 data 行**：这一格是 `sseFrames()` 在**真读流循环里**的接线证明。
   *
   * ⚠️ 纯函数那一层由 `tests/ui/playground.test.ts` 的
   * 「一条 data 行被拆在两个 chunk 里仍被正确重组」钉着；**这一格钉的是
   * `streamFromGateway()` 有没有把 `rest` 真的接回下一轮**——把那句
   * `buf = found.rest;` 改成 `buf = "";` 的话，纯函数那一格照样全绿。
   */
  it("一条 data 行被真的拆在两个 chunk 里送达时仍被正确重组 —— 读流循环得把尾巴接回去", async () => {
    const whole = 'data: {"id":"c1","choices":[{"delta":{"content":"跨块的一句话"}}]}\n\n';
    const cut = 20;
    expect(whole.slice(0, cut), "前置条件：前半段不许自己就构成一帧").not.toContain("\n\n");
    responder = () => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        // **两次 enqueue**：读者会拿到两个独立的 chunk，切点落在 JSON 中间。
        c.enqueue(enc.encode(whole.slice(0, cut)));
        c.enqueue(enc.encode(whole.slice(cut)));
        c.close();
      },
    }), { status: 200 });

    const { seen, r } = await streamOnce(reqFor(0));
    expect(seen, "跨块那条 data 行没被重组回来").toEqual(['{"id":"c1","choices":[{"delta":{"content":"跨块的一句话"}}]}']);
    expect(r.streamed).toBe(true);
  });

  it("最后一帧没有以空行收尾时也不许丢 —— 连接被反代截断时最后一个事件会静默消失", async () => {
    // **刻意不以 `\n\n` 结尾。**
    responder = () => new Response('data: {"id":"c1","choices":[{"delta":{"content":"最后一块"}}]}', { status: 200 });
    const { seen } = await streamOnce(reqFor(0));
    expect(seen).toEqual(['{"id":"c1","choices":[{"delta":{"content":"最后一块"}}]}']);
  });

  /**
   * **上游没 ok 时不走读流那条路。** 网关的错误响应是 JSON、不是 SSE，
   * 拿 SSE 解析器去读它会得到零条负载 ⇒ 调用方会看到一次「什么都没发生」的成功流式。
   */
  it("上游 401 时交出那份错误响应体并标明没走流 —— 拿 SSE 解析器去读 JSON 会得到一次假的空流", async () => {
    responder = () => new Response('{"error":{"message":"PROBE-401"}}', {
      status: 401, headers: { "content-type": "application/json" },
    });
    const { seen, r } = await streamOnce(reqFor(0));
    expect(seen, "把一份 JSON 错误体当成 SSE 读了").toEqual([]);
    expect(r.streamed, "没 ok 却报告说走了流").toBe(false);
    expect(r.status).toBe(401);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.body)).toContain("PROBE-401");
  });

  it("读到一半断掉时抛 GatewayError，且 message 与 code 里都不含口令 —— 错误文案是口令最自然的泄漏口", async () => {
    // ⚠️ **必须用 `pull` 分两次，不能在同一个 `start` 里先 enqueue 再 error。**
    //    实测：`controller.error()` 会**清空队列**（Streams 规范如此），
    //    于是那一块在流那一层就没了、根本到不了被测代码 ⇒ 这一格会以
    //    「断掉之前那一块被抹掉了」的形式红，而红的原因是**夹具**不对，不是实现不对。
    //    分两次 pull 才让「先真的交出一块，再断掉」这个时序真的成立。
    let pulls = 0;
    responder = () => new Response(new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls++ === 0) {
          c.enqueue(new TextEncoder().encode('data: {"id":"c1","choices":[{"delta":{"content":"半句"}}]}\n\n'));
          return;
        }
        // **真的 error 掉**（第 2 种假阳性：错误 stub 不许只 resolve 一个失败状态）。
        c.error(new Error("upstream went away"));
      },
    }), { status: 200 });

    const seen: string[] = [];
    const err = await streamFromGateway(reqFor(0), GW_TOKEN, {
      origin: ORIGIN, onPayload: (p: string) => seen.push(p),
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("stream_error");
    // **断掉之前已经交出去的那一块留着**：运维看到的半句话是真的发生过的。
    expect(seen.length, "断掉之前那一块被抹掉了").toBe(1);
    // 逐段扫（长度 ≥4）：错误对象里一个口令片段都不许有。
    const text = `${(err as Error).message} ${(err as GatewayError).code}`;
    for (let i = 0; i + 4 <= GW_TOKEN.length; i++) {
      expect(text, "错误里带上了口令的一段").not.toContain(GW_TOKEN.slice(i, i + 4));
    }
  });
});
