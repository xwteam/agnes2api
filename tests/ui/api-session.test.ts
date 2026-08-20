import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { raw, api, ApiError, onUnauthorized } from "../../admin-ui/js/api.js";
import { SESSION_MAX_AGE_MS } from "../../admin-ui/js/pure/session.mjs";

/** `admin-ui/js` 下的全部 JS（含 `pure/`），路径一律用 `/` 分隔好写断言。 */
function walkJs(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n).split("\\").join("/");
    return statSync(p).isDirectory() ? walkJs(p) : /\.(js|mjs)$/.test(p) ? [p] : [];
  });
}

/**
 * 会话绝对上限在**网络层**的接线（K6 / 第二次评审必修 ②）。
 *
 * ⚠️ **我上一轮把这条登记成了「只能人工冒烟」，那半是错的。**
 * `admin-ui/js/api.js` 只碰 `localStorage` 与 `fetch` 两个全局，**不碰 DOM**，
 * 而且两者都在函数体里用、不在模块顶层——所以它能被直接 import 进 node 跑，
 * 两个全局 stub 掉就行。登记一条「补不了的缺口」之前应该先试一次，这次没试。
 *
 * 被守护的性质：**面板是常驻的**（事件在轮询、Key 池有自动刷新），运维把标签页开
 * 一整天是常态。只在 `app.js` 模块加载那一次判过期的话，12 小时到点后那个标签页
 * 照常拿着口令继续打接口，而五语言 DEPLOY.md 逐字承诺「12 小时后要求重新输入」
 * ——一句**被测试保护起来、却在最常见路径上不成立**的承诺。
 *
 * 断言的是**行为**：请求到底发没发出去（`fetch` 调用记录）、会话有没有被清、
 * 抛的是不是同一个 `ApiError`。不是「有没有调 sessionExpired」那种形状断言。
 */
const KEY_STORE = "agnes2api_admin_key";
const SAVED_AT_STORE = "agnes2api_admin_key_at";
const NOW = 1_700_000_000_000;

let store: Record<string, string>;
let fetchCalls: Array<{ url: string; headers: Record<string, string> }>;
let unauthorizedCalls: number;

beforeEach(() => {
  store = {};
  fetchCalls = [];
  unauthorizedCalls = 0;

  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.spyOn(Date, "now").mockReturnValue(NOW);

  // 模块级的 handler 是单例，每格都重新注册一次，免得跨用例串味。
  onUnauthorized(() => { unauthorizedCalls++; });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 登录成功之后 `app.js` 写下的那两个键。 */
function signedInAt(savedAt: number): void {
  store[KEY_STORE] = "admin-token-0123456789-ok!";
  store[SAVED_AT_STORE] = String(savedAt);
}

describe("api.raw()：会话绝对上限每请求复查", () => {
  /**
   * **反向那格，必须先有。** 少了它，「一律当成过期」也能让下面几格全绿——
   * 而那会让面板一个请求都发不出去。
   */
  it("会话新鲜时请求照发，且带着口令头", async () => {
    signedInAt(NOW - 1000);
    const res = await raw("GET", "/session", undefined, undefined);
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("/admin/api/session");
    expect(fetchCalls[0]!.headers["x-admin-key"]).toBe("admin-token-0123456789-ok!");
    expect(unauthorizedCalls).toBe(0);
  });

  it("差一毫秒到上限：仍然照发（边界不许提前一格生效）", async () => {
    signedInAt(NOW - (SESSION_MAX_AGE_MS - 1));
    await raw("GET", "/session", undefined, undefined);
    expect(fetchCalls).toHaveLength(1);
    expect(unauthorizedCalls).toBe(0);
  });

  /**
   * 到点之后：**请求根本不发出去**（送出去也没用，还会在服务端留下一条无意义的
   * `admin.login_failed`），清会话，并抛与 401 完全相同的那个 `ApiError`。
   */
  it("到达上限：不发请求、清会话、抛 401 —— 这才是文档承诺的那件事", async () => {
    signedInAt(NOW - SESSION_MAX_AGE_MS);
    await expect(raw("GET", "/session", undefined, undefined)).rejects.toBeInstanceOf(ApiError);
    expect(fetchCalls, "过期了还把口令发出去了").toEqual([]);
    expect(unauthorizedCalls, "没有清会话").toBe(1);
  });

  it("13 小时前（冒烟第 16/19 条手工改的那个量）同样不发请求", async () => {
    signedInAt(NOW - 13 * 3600_000);
    await expect(raw("GET", "/session", undefined, undefined)).rejects.toThrow(ApiError);
    expect(fetchCalls).toEqual([]);
    expect(unauthorizedCalls).toBe(1);
  });

  it("抛出来的 ApiError 就是 401 那一个，调用方不必认新错误", async () => {
    signedInAt(NOW - SESSION_MAX_AGE_MS);
    const err = await raw("GET", "/session", undefined, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  /**
   * 旧版本存下的会话（只有口令、没有时刻键）同样按过期处理。
   * `Number(null) === 0` ⇒ 走 `sessionExpired` 的 `savedAt <= 0` 那条。
   */
  it("旧版本存的会话（没有时刻键）也不发请求", async () => {
    store[KEY_STORE] = "admin-token-0123456789-ok!";
    await expect(raw("GET", "/session", undefined, undefined)).rejects.toThrow(ApiError);
    expect(fetchCalls).toEqual([]);
    expect(unauthorizedCalls).toBe(1);
  });

  /**
   * **隐私模式：`localStorage` 抛错时 fail closed。**
   *
   * 这一格是我自己的变异跑抓出来的：把 `expired()` 的 `catch` 改成 `return false`
   * 时，上面所有用例**照样全绿**（`11 passed`）——因为我的 stub 从来不抛，
   * 那条 catch 分支根本不可观测（本项目登记的第 5 种假阳性形态）。
   * 读不到时刻就当过期，方向必须与 `sessionExpired` 一致。
   */
  it("localStorage 抛错（隐私模式）时按过期处理，不发请求", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    });
    await expect(raw("GET", "/session", undefined, undefined)).rejects.toThrow(ApiError);
    expect(fetchCalls, "读不到会话时刻却把口令发出去了").toEqual([]);
  });

  /** 时钟回拨按过期处理（与后端三处方向相反是刻意的，理由见 session.mjs）。 */
  it("时钟回拨也不发请求（fail closed）", async () => {
    signedInAt(NOW + 60_000);
    await expect(raw("GET", "/session", undefined, undefined)).rejects.toThrow(ApiError);
    expect(fetchCalls).toEqual([]);
  });

  /**
   * **`raw()` 是唯一的网络出口**：`api.get/post/put/del` 全部经 `json()` → `raw()`。
   * 逐个跑一遍，免得将来有人给某个动词开一条绕过 `raw()` 的近路。
   */
  it.each([
    ["get", () => api.get("/x", undefined)],
    ["post", () => api.post("/x", { a: 1 }, undefined)],
    ["put", () => api.put("/x", { a: 1 }, undefined)],
    ["del", () => api.del("/x", undefined)],
  ])("四个动词都过同一道闸：%s", async (_name, call) => {
    signedInAt(NOW - SESSION_MAX_AGE_MS);
    await expect(call()).rejects.toThrow(ApiError);
    expect(fetchCalls, "这个动词绕过了会话闸").toEqual([]);
  });
});

/** 让下面几格自己决定服务端回什么状态码。 */
function respondWith(status: number, body = "{}"): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
}

/**
 * **401 与 403 的对称一对**（全分支评审 C3）。
 *
 * ⚠️ **`api.js` 的文件头一直在宣称「两条对称用例进单测，防『修过头』」，而在这一组
 * 出现之前是零条。** 评审实测：把 `raw()` 里的 `if (res.status === 401)` 改成
 * `if (res.status === 401 || res.status === 403)`，**1357 条全绿**。
 *
 * 这条护栏护的是 kiro2api 真实发生过的回归：它老写法把业务 403 当掉线，管理员
 * 拒绝一次授权就被踢出后台，并被告知「密钥无效」——一个既丢上下文、又指错方向的
 * 双重失效。**"修过头"和"没修"一样是缺陷**，所以必须是对称的两格：只有正向那格
 * （401 清会话）时，"一律清会话"也能全绿。
 */
describe("api.raw()：401 清会话，403 明确不清（对称的一对，任一侧缺失都不算数）", () => {
  it("401：清会话（走 onUnauthorized）并抛 ApiError(401)", async () => {
    signedInAt(NOW - 1000);
    respondWith(401);
    const err = await raw("GET", "/session", undefined, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(fetchCalls, "401 是服务端给的，请求本身必须真的发出去过").toHaveLength(1);
    expect(unauthorizedCalls, "401 没有清会话").toBe(1);
  });

  it("403：**不**清会话、**不**抛，原样把响应交给调用方", async () => {
    signedInAt(NOW - 1000);
    respondWith(403, '{"error":{"message":"forbidden"}}');
    const res = await raw("GET", "/keys", undefined, undefined);
    expect(res.status, "raw() 不该把 403 变成别的东西").toBe(403);
    expect(
      unauthorizedCalls,
      "403 被当成了会话失效——管理员拒绝一次授权就会被踢出后台（kiro2api 踩过的坑）",
    ).toBe(0);
  });

  it("403 经 api.get() 抛出来的是 403 那个 ApiError，且仍然没清会话", async () => {
    signedInAt(NOW - 1000);
    respondWith(403, '{"error":{"message":"forbidden"}}');
    const err = await api.get("/keys", undefined).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status, "状态码被 401 顶掉了").toBe(403);
    expect((err as ApiError).message).toBe("forbidden");
    expect(unauthorizedCalls).toBe(0);
  });
});

/**
 * **两把钥匙严格隔离**（设计文档 §10.5，全分支评审 C3）。
 *
 * ⚠️ `api.js` 文件头原来写着这两条禁令「各有一条单测钉着」——实际上 `/v1` 那条
 * 只有一句附带的 URL 断言（在上面"会话新鲜时请求照发"那格里，顺带断言了一个
 * 具体路径），网关口令那条**一条都没有**。这一组把两条都变成正面的行为断言。
 */
describe("api.raw()：两把钥匙隔离（凭据头 / URL 前缀两条禁令）", () => {
  it("凭据头只有 x-admin-key —— 没有任何网关口令头", async () => {
    signedInAt(NOW - 1000);
    await raw("POST", "/keys", { k: 1 }, undefined);
    const headers = fetchCalls[0]!.headers;
    // 正面：口令确实带上了（少了这一条，"没有别的头"在一个空对象上也成立）。
    expect(headers["x-admin-key"]).toBe("admin-token-0123456789-ok!");
    // 反面：整份头里除了 x-admin-key 与 content-type 不许再有第三个。
    // 逐个列名字而不是只查 authorization：`Bearer` 只是网关口令最常见的那种载体，
    // 换成 `x-api-key`/`x-goog-api-key` 同样是把中转口令带进管理请求。
    expect(Object.keys(headers).sort()).toEqual(["content-type", "x-admin-key"]);
  });

  it.each([
    ["/session", "/admin/api/session"],
    ["/keys?bucket=fresh", "/admin/api/keys"],
    ["/events/download", "/admin/api/events/download"],
    // `..` 是这条禁令唯一可能被绕出去的形态（调用方今天全是字面量，但判据不该
    // 建在"调用方都很老实"上）。浏览器会把它规范化，所以这里也按规范化之后判。
    ["/../../v1/chat/completions", "/v1/chat/completions"],
  ])("出口 URL：%s", async (path, expectedPathname) => {
    signedInAt(NOW - 1000);
    await raw("GET", path, undefined, undefined);
    const pathname = new URL(fetchCalls[0]!.url, "https://gateway.example.com").pathname;
    expect(pathname).toBe(expectedPathname);
  });

  /**
   * 上一格最后那行**如实登记了一条边界**：`raw("GET", "/../../v1/...")` 规范化之后
   * 真的会打到 `/v1`。今天没有任何调用方这么写，判据因此建在这里——**调用方一律是
   * 字面量、且一律不含 `..`**。这一格扫的是源码，弱于行为断言，但它拦得住的正是
   * 「有人给某个板块加了一个由用户输入拼出来的 path」这种引入方式。
   */
  it("没有任何调用方给 api.* 传含 `..` 或以 http 开头的 path", () => {
    const bad: string[] = [];
    for (const f of walkJs("admin-ui/js")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bapi\.(?:get|post|put|del|raw)\(\s*(["'`])([^"'`]*)\1/g)) {
        const p = m[2]!;
        if (p.includes("..") || /^https?:/i.test(p)) bad.push(`${f}: ${p}`);
      }
    }
    expect(bad, "调用方把 api.* 的 path 写成了能翻出 /admin/api 的形态").toEqual([]);
  });
});

/**
 * **全站到底有几个网络出口。**
 *
 * `api.js` 的文件头原来写着「全站唯一网络出口」，并把这句话当成
 * 「口令只走请求头、不进 URL」那段安全论证的前提——而实际上有**两个**：
 * `js/app.js` 的登录探针完全绕开本模块（没有 `expired()` 前置、没有
 * `onUnauthorized`、没有 `ApiError`）。
 *
 * 这一格是**源码文本断言**，弱于行为断言，如实说明：它数的是 `fetch(` /
 * `XMLHttpRequest` / `EventSource` / `sendBeacon` 这几种写法的出现处。
 * 它拦不住一种没被列举的新写法，但拦得住"顺手在某个板块里再开一个 fetch"
 * ——而后者正是这条论证前提唯一现实的失效方式。
 */
describe("面板的网络出口清单", () => {
  it("恰好两处：api.js 的 raw() 与 app.js 的登录探针", () => {
    // **按文件计数，不按行号**：行号断言会被任何一次无关的注释改动打红，那种
    // 断言过不了三轮就会被人"顺手放宽"，而放宽之后它就什么都不守了。
    const counts: Record<string, number> = {};
    for (const f of walkJs("admin-ui/js")) {
      const src = readFileSync(f, "utf8")
        // 注释里提到这些名字不算出口（本仓注释极爱复述代码）。
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const n = [...src.matchAll(/\b(?:fetch|XMLHttpRequest|EventSource|sendBeacon)\s*\(/g)].length;
      if (n > 0) counts[f] = n;
    }
    expect(counts, "网络出口的数量或位置变了——api.js 文件头那段安全论证要跟着重写").toEqual({
      "admin-ui/js/api.js": 1,
      "admin-ui/js/app.js": 1,
    });
  });
});
