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
 * 「口令只走请求头、不进 URL」那段安全论证的前提——而实际上有**三个**：
 * `js/app.js` 的登录探针完全绕开本模块（没有 `expired()` 前置、没有
 * `onUnauthorized`、没有 `ApiError`），P3d Task 10 又加了 `js/gw-api.js`
 * （Playground 打对外那棵树，**拿的是另一把钥匙**）。
 *
 * 这一格是**源码文本断言**，弱于行为断言，如实说明：它数的是下面 `EGRESS_FORMS`
 * 那张手写枚举表里的几种写法的出现处。
 * 它拦不住一种没被列举的新写法，但拦得住"顺手在某个板块里再开一个 fetch"
 * ——而后者正是这条论证前提唯一现实的失效方式。
 */
/**
 * 单行模板串里的**字面文本**抠掉，`${…}` 里那一截原样留下。
 *
 * ⚠️ **为什么必须抠**：P3d Task 7 的 `admin-ui/js/pure/examples.mjs` 要生成一段 Node
 * 客户端示例，那段示例的**文本**里天然有 `fetch(` 两个字——它是给运维照抄去别处跑的
 * 代码，不是这个面板的网络出口。上一版这里只抠注释、不抠字符串，于是它会被算成第三处。
 *
 * ⚠️⚠️ **不是「把整条模板串删掉」**：`${…}` 里那一截是**真的会执行**的代码，
 * 整条删掉就等于开一条「把 fetch 写进插值里」的免检通道。所以这里把插值的内容
 * 原样接回去，只丢掉字面文本。这条方向由下面「反向自检」那一格逐条钉着。
 *
 * ⚠️ **三条如实登记的边界。上一版写了两条，而其中一条是假的，另一条整个漏了。**
 *
 * · **只认单行的模板串**（`[^`\n]*`）——本仓 `admin-ui/js` 下的模板串今天全是单行的；
 *   跨行模板串里的字面文本仍会被算进去（**保守方向：宁可多算，不可少算**）。
 *
 * · **插值里带花括号时，那条模板串会被整条丢掉，连里面真会执行的代码一起。**
 *   ⚠️⚠️ **上一版这里写的是「今天 `admin-ui/js` 下零处这样写」，那句是假的，而且它
 *   宣布休眠的洞当时就开着**（P3d Task 7 评审 F-1，实测）：
 *   今天**有 1 处**——`admin-ui/js/sec-overview.js`「ov.runtime.checkedAt」那一行，
 *   它的插值是 `t(…, { at: fmtInstant(…, offsetMs()) })`，带花括号。
 *   拿本文件这两个函数实跑：那一行 strip 之后剩 `x + (si.checkedAt === null ? "" : );`
 *   ——**整条模板串连同里面的 `t(...)` / `fmtInstant(...)` / `offsetMs()` 一起没了**；
 *   往那个**已经存在**的插值里塞一个出口（`offsetMs()` → `offsetMs(fetch(x))`），
 *   `egressSites()` 数出来是 **0**。
 *   ⇒ 这条不是「哪天有人这么写」，是**已经有人这么写了**。处数由下面
 *   「花括号插值今天恰好一处，就是它 —— 这道扫描在那一行上是瞎的」那一格钉死，
 *   **没有那一格的话，下一个人再写一处，这段话又会静静变假**。
 *
 * · **同一行里反引号「数目是偶数、配对却是错的」时，两个反引号之间的真代码被整段删掉。**
 *   ⚠️ **这一条是本次改动新造出来的**（旧判据根本不碰反引号），上一版一个字都没登记。
 *   实测：`const a = "\`"; fetch(u); const b = "\`";` ⇒ 旧判据 1、**新判据 0**。
 *   现实性低（本仓今天零处），**但「低」不是「没有」**，登记在下面那格 `BLIND_SPOTS` 里。
 *
 * **三条都不是「护栏没有」，是「护栏到这里为止」。**
 */
function stripTemplateText(src: string): string {
  return src.replace(/`[^`\n]*`/g, (lit) =>
    [...lit.matchAll(/\$\{([^{}]*)\}/g)].map((m) => ` ${m[1]} `).join(""));
}

/**
 * **出网写法的枚举表。P3d Task 10 从四种补到七种。**
 *
 * ⚠️⚠️ **补进来的后三种是 P3d Task 7 评审 F-11 实测出来的活口子，Task 9 把它们
 * 原样交接给了 Task 10**（理由：Playground 是本期唯一新写前端出网代码的任务，
 * 而那三种正是它可能会用到的形态）。当时的实测：三种**各得 0**，
 * 而 `sendBeacon` / `XMLHttpRequest` 各得 1。
 *
 * 三种各自的形状，以及为什么按名字扫得住它们：
 * · **`new WebSocket(u)`** —— 名字根本不在旧表里。加一条 `WebSocket\s*\(` 即可。
 * · **`await import(u)`** —— 动态 `import()` 会真的去网上取一段代码。判据要求紧跟 `(`，
 *   所以静态的 `import { x } from "y"` 不会被误算（它没有括号）。
 * · **`const f = globalThis.fetch; f(u)`** —— 这一种与前两种**形状不同**：
 *   它不是「另一个名字」，而是**把 `fetch` 当成值取用**。按名字扫的话，
 *   看得见的只有那一次取值 ⇒ 判据数的是**别名被造出来的那一刻**
 *   （`.fetch` 或 `= fetch`，且后面不跟 `(`），不是别名被调用的那一刻——
 *   后者按定义扫不到（`f(u)` 里没有任何一个表里的名字）。
 *
 * ⚠️ **两条 `fetch` 规则互斥，不会重复计数**：调用那条要求紧跟 `(`，
 * 别名那条要求**不**紧跟 `(`。由下面「反向自检：补进表里的那三种写法，
 * 每一种都真的被数出来」那一格里的 `fetch(u)` 一条钉着（它必须恰好是 1，不是 2）。
 *
 * ── ⚠️⚠️ **两条新规则改过两版，两版都是被实测打回来的。逐版留在这里。** ────────
 *
 * **第一版**：`\bimport\s*\(`（允许空格）与 `\bfetch\b(?!\s*\()`（不限定前一个字符）。
 * 拿全仓真实文件喂进去 ⇒ **`admin-ui/js/i18n-dict.js` 当场多出 3 处**，
 * 而那个文件里一行代码都没有，命中的全是**英文文案**：
 * · `"Bulk import (one per line)"` —— `import` 后面跟空格再跟括号；
 * · `"the per-fetch limit was exceeded"` 与 `"reload the page to fetch them again"`
 *   —— 散文里的 `fetch` 这个词。
 * ⭐ **写完一条形状判据，先拿仓里真实那一行去喂它** —— 这三处没有一条是想出来的。
 *
 * **第二版**（收窄成 `(?:\.|=\s*)fetch\b`，要求前面是成员访问点或赋值号）：
 * ⚠️⚠️ **它把「唯一一族真会被写出来的别名形态」漏掉了，而当时的登记表宣称已穷尽。**
 * 评审把两版并排跑，**五条**旧版抓得住、收窄后掉到 0 的写法一条都不在登记表里：
 * `makeClient(fetch);` / `function getF(){ return fetch; }` / `const [f] = [fetch];` /
 * `send(u, { fetcher: fetch });` / `export default fetch;`
 * ——**第一条最要命：把 `fetch` 当参数传进去正是本仓自己的主流写法**
 * （`src/core/` 零 IO、fetcher 一律依赖注入）。
 * ⚠️ **这与 `1e3e808`「收窄那句全称句时把两条轴都列全」是同一族的第二次发生。**
 *
 * **第三版（今天这一版）**：判据从「前面是什么」改成
 * **「前面不是标识符字符（含 `-`）、而后面紧跟一个结束符」**。
 * 逐条实测（旧版 → 第二版 → 今天）：
 * · 上面那五条：`1 → 0 → 1`（**五条全回来了**）；
 * · `const f = globalThis.fetch; f(u);` 与 `const f = fetch; f(u);`：`1 → 1 → 1`；
 * · `const f = globalThis . fetch; f(u);`（第二版登记过的一条盲点）：`1 → 0 → **1**`
 *   ——**顺带被补上了**，那一条已从 `BLIND_SPOTS` 里删掉；
 * · `fetch(u);` 与 `client.fetch(u);`：恒为 `1`（两条 `fetch` 规则互斥，不重复计数）；
 * · `const prefetch = 1;`：恒为 `0`；
 * · **三句真实英文文案**（`Bulk import (one per line)` / `the per-fetch limit was exceeded` /
 *   `reload the page to fetch them again`）：**今天各得 0**，与第二版一样干净；
 * · **全仓 `admin-ui/js` 真实文件上，本条规则今天零命中**（真的没有任何别名写法）。
 * ⇒ **今天仍然漏的写法逐条登记在下面的 `BLIND_SPOTS` 里，一条都不许只写在这段散文里。**
 */
const EGRESS_FORMS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "fetch(", re: /\bfetch\s*\(/g },
  { label: "XMLHttpRequest(", re: /\bXMLHttpRequest\s*\(/g },
  { label: "EventSource(", re: /\bEventSource\s*\(/g },
  { label: "sendBeacon(", re: /\bsendBeacon\s*\(/g },
  // ── P3d Task 10 补进来的三种 ──
  { label: "WebSocket(", re: /\bWebSocket\s*\(/g },
  // **不许 `import` 与括号之间有空格**，理由见上面那段实测（英文文案误报）。
  { label: "动态 import(", re: /\bimport\(/g },
  // **判据：`fetch` 这个名字出现在一个「值的位置」上** —— 前一个字符不是标识符字符
  //（`\b` 挡不住 `per-fetch` 里那个连字符，所以 `-` 也要排除），
  //  而后面紧跟的是一个**结束符**（`;` `,` `)` `]` `}` 或串尾）。理由与实测见上面那段。
  { label: "fetch 别名（当值取用）", re: /(?<![A-Za-z0-9_$-])fetch\s*(?=[;,)\]}]|$)/g },
];

/** 一段源码里的网络出口处数。**注释与模板串字面文本都不算。** */
function egressSites(src: string): number {
  const code = stripTemplateText(
    // 注释里提到这些名字不算出口（本仓注释极爱复述代码）。
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"),
  );
  let n = 0;
  for (const { re } of EGRESS_FORMS) {
    // ⚠️ **每次都归零。** `String.matchAll()` 会把当时的 `lastIndex` 复制进它的克隆
    // ⇒ 不归零的话，每个文件开头若干字符被整段跳过。
    // `tests/ui/no-hardcoded-endpoints.test.ts` 的
    // 「scan() 不受任何遗留 lastIndex 影响 —— 这条通道一旦打开，唯一的护栏会静默恒绿」
    // 那一格记着这条致盲通道当初有多近。
    re.lastIndex = 0;
    n += [...code.matchAll(re)].length;
    re.lastIndex = 0;
  }
  return n;
}

/**
 * `admin-ui/js` 下 **`${` 的个数多于 `/\$\{[^{}]*\}/g` 能匹配上的个数**的那些行。
 *
 * 判据建在**失效机制**上，不另起一套启发式：`stripTemplateText()` 就是用
 * `/\$\{([^{}]*)\}/g` 把插值内容捞回来的，捞不齐就说明这一行至少有一个插值的内容
 * 会被连同整条模板串一起丢掉。
 *
 * ⚠️⚠️ **它不等于「所有会被整条吃掉的行」，用例名与报错文案都不许这么说**
 *（P3d Task 7 定向复评 M-1，实测）：**插值体里出现字符串或正则字面量里的 `}` 时，
 * `/\$\{[^{}]*\}/g` 会匹配到那个错的 `}` ⇒ `opens === simple` ⇒ 这里不报，
 * 而 `stripTemplateText()` 照样把整条模板串吃掉。** 三条实测样本（旧判据 1 / 新判据 0 /
 * 本函数不报）：`` `${ m["}"] || fetch(u) }` ``、`` `${ map["}"] ? 1 : sendBeacon(u) }` ``、
 * `` `${ v.replace(/}/g, fetch(u)) }` ``。落盘验过：把第一种插进 `admin-ui/js/sec-overview.js`
 * 尾部（内含真 `fetch`）⇒ **27 passed 全绿，主扫描与本函数一起没看见**。
 * ⇒ 本函数担保的是「**`${` 数不齐的那些行**恰好一处」，**不是**「没有别的行会被吃掉」。
 * 那一族由下面 `BLIND_SPOTS` 第二条兜着（它是断言，不是散文）。
 *
 * ⚠️ **返回的是「文件 + 那一行的原文」，不是「文件加行号」**（定向复评 M-2）：
 * 上一版返回行号，于是**在 `admin-ui/js/sec-overview.js` 靠前的位置插一个空行**
 * ——纯排版改动、处数根本没变——那一格就红了，而报错文案说的是
 * 「带花括号的插值多了/少了一处」。那正是本文件上面「按文件计数，不按行号」
 * 那段告诫的原话，我在同一个文件里犯了它。
 *
 * ⚠️ **不先抠注释，代价明写**：抠注释要么按整文件做、要么另写一套逐行启发式
 *（那本身又是一个可错判断）。所以这里连注释一起数 ⇒ **注释里引一段带花括号的插值同样会红**，
 * 而报错让人「先确认那个插值里没有出口」——**可注释在 `egressSites()` 里是先被抠掉的、
 * 根本藏不住出口**，于是唯一能变绿的做法是把那行注释也塞进下面那格的清单，
 * **清单当场变成假的**。今天全仓已有 2 行注释含反引号 + `${`
 *（`admin-ui/js/i18n-dict.js` 与 `admin-ui/js/pure/keys-write.mjs`），
 * **只因它们的插值里没花括号才侥幸不红**。⇒ **登记 P3e**（修法是先抠注释行再逐行数）。
 * ⚠️⚠️ **这条不是纸面风险，本轮就地撞过一次**：H-1 那段注释在 `admin-ui/js/api.js` 里
 * 按名字锚引用下面那一格时，用例名一旦带上反引号包着的插值起始符，这一格当场变红
 *（`expected [ 'admin-ui/js/api.js', …(1) ] to deeply equal [ 'admin-ui/js/sec-overview.js' ]`）。
 * 唯一不把清单写成假的出路是**改用例名**——所以下面那格叫「插值捞不齐的那些行」，
 * 名字里不带那个 token。**一道会因为「有人写了准确的注释」而变红的护栏，
 * 是在给「把注释写得含糊些」发奖**，这正是 P3e 要修它的理由。
 *
 * ⚠️ **这里手抄了第二份 `/\$\{[^{}]*\}/`，与 `stripTemplateText()` 不共享同一个常量**
 * ⇒ 改了那边不改这边，本函数会静默地量错。缓解是 `BLIND_SPOTS` 第二条那时会红，
 * **但那是缓解，不是保护**。登记 P3e。
 */
function braceInterpLines(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const f of walkJs("admin-ui/js")) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.includes("`") || !line.includes("${")) continue;
      const opens = (line.match(/\$\{/g) ?? []).length;
      const simple = (line.match(/\$\{[^{}]*\}/g) ?? []).length;
      if (opens > simple) out.push({ file: f, text: line.trim() });
    }
  }
  return out;
}

/**
 * **已知抓不住的写法，连同为什么接受一起登记。**
 * 形态照抄 `tests/ui/no-hardcoded-endpoints.test.ts`
 * 「已知抓不住的写法确实抓不住（边界是断言，不是散文）」——**边界是断言，不是散文**。
 *
 * ⚠️ 前两条**都是本次改动（抠模板串字面文本）新造出来的**，
 * 旧判据（只抠注释）不碰反引号，一条都没有。**新造的盲点必须自己登记，
 * 不能只登记「顺手修好的那些」。** 第三条是**既有**的，与本次改动无关，一并登记。
 */
const BLIND_SPOTS: ReadonlyArray<{ probe: string; why: string }> = [
  {
    probe: 'const a = "`"; fetch(u); const b = "`";',
    why: "同一行里反引号数目是偶数、配对却是错的 —— `/`[^`\\n]*`/` 会把两个反引号之间的"
      + "真代码整段当成模板串文本删掉。**触发它的不只是普通字符串里的散反引号**："
      + "正则字面量里的反引号（`/`/`）同样算，判据只看字符不看它住在哪种字面量里。"
      + "实测旧判据 1、新判据 0。"
      + "⚠️ 「本仓 admin-ui/js 今天零处这样写」实测为真，**但它没有机器钉子**"
      + "——正是 F-1 栽过的那个形状（一句只靠人记得去数的全称句）。登记 P3e。",
  },
  {
    // ⚠️ 出口必须写在**花括号插值内部**——写在同一行的模板串**外面**是数得出来的
    //（那是上面反向自检第四条），拿那种样本当盲点探针会直接红，第一版就红了一次。
    probe: 'const s = `${t("k", { at: f(fetch(u)) })}`;',
    why: "插值里带花括号 —— 整条模板串连同里面真会执行的代码一起被丢掉。"
      + "**这一条今天在本仓是活的**（sec-overview.js 那一行），"
      + "所以它另有一格把「`${` 数不齐的行」的处数锚住，不是只写在这张表里。"
      + "⚠️ 但那一格**只认 `${` 数不齐的那一族**：插值体里含字符串/正则里的 `}` 时"
      + "（`` `${ m[\"}\"] || fetch(u) }` `` 这种）它不报，而整条照样被吃掉，"
      + "**那一族只有本表这一条兜着**。",
  },
  {
    // **P3d Task 10 收窄造出来的一条**：`import` 与括号之间允许空格是合法 JS。
    probe: 'const m = await import ("./x.js");',
    why: "**`import` 与括号之间带空格的动态 import 扫不到**。它是合法 JS，"
      + "但本仓与主流写法都不带空格。**允许空格的代价实测过**："
      + "`admin-ui/js/i18n-dict.js` 的英文文案 `Bulk import (one per line)` 会被数成一个出口 "
      + "⇒ 一道会因为「有人写了一句英文说明」而变红的护栏，过不了三轮就会被人放宽。"
      + "**宁可漏一种没人写的形态，不要一道被噪音逼退的护栏。**",
  },
  {
    // **今天仍然漏的一条**：解构取值。判据要求名字后面紧跟一个结束符，而这里跟的是 `:`。
    probe: "const { fetch: f } = globalThis;",
    why: "**解构取值扫不到**：判据要求 `fetch` 后面紧跟 `;` `,` `)` `]` `}` 之一，"
      + "而解构里它后面是 `:`。**不把 `:` 收进结束符集合是实测决定的**："
      + "收进去之后英文文案里任何一句 `… fetch: …`（以及 JSON 风格的示例文本）都会被数成出口，"
      + "而本仓字典里已经有含 `fetch` 这个词的句子。**宁可漏一种没人写的形态，"
      + "不要一道被噪音逼退的护栏。**",
  },
  {
    // **今天仍然漏的一条**：字符串下标。
    probe: 'const f = globalThis["fetch"];',
    why: "**字符串下标扫不到**（`globalThis[\"fetch\"]`）：名字住在一对引号里，"
      + "后面紧跟的是 `\"` 不是结束符。按名字扫的判据看不见「这个字符串是一个属性名」。"
      + "同一族还有 `globalThis[\"fet\" + \"ch\"]` 这种拼出来的下标 —— **那一族属于刻意绕开，"
      + "本来就不在一道文本扫描的射程里。**",
  },
  {
    // **今天仍然漏的一条**：`fetch` 落在**运算符**位置上（`||` / 三元 / 成员访问）。
    probe: "const f = fetch || xhr;",
    why: "**运算符位置扫不到**：判据要求名字后面紧跟一个结束符，而这里跟的是 `|`。"
      + "同一族实测各得 0 的还有 `const f = cond ? fetch : xhr;`（三元的中间那支，后面是 `:`）"
      + "与 `const f = fetch.bind(globalThis);`（后面是 `.`）。"
      + "⚠️ **不把这些字符收进结束符集合是实测决定的**：越收越接近「任何位置的 `fetch` 都算」，"
      + "而那正是第一版被 `admin-ui/js/i18n-dict.js` 的英文文案打红的那一版。"
      + "⚠️ **`fetch.bind(...)` 这一条值得单独看一眼**：它是这三条里唯一一个"
      + "**今天真有人可能顺手写出来**的（给 `fetch` 绑 this 是浏览器里常见的写法）。登记 P3e。",
  },
  {
    // **P3d Task 10 新造的一条**：别名那条规则只写了 `fetch` 一个名字。
    probe: "const X = XMLHttpRequest; new X();",
    why: "**别名那条规则只覆盖 `fetch`**，`XMLHttpRequest` / `WebSocket` / `EventSource` "
      + "的同类写法（把构造器当值取用）一个都不覆盖。"
      + "⚠️ **为什么不顺手都加上**：那三个名字在真实代码里几乎只会以 `new X(` 出现，"
      + "而 `fetch` 恰恰相反（它本来就是一个可以直接传来传去的函数）——"
      + "把三条否定先行断言一并加上，收益是三种没人这么写的形态，"
      + "代价是三条各自可能写反的正则（本表上一条就记着写反的后果）。"
      + "**今天登记，不今天补。**",
  },
  {
    // **P3d Task 10 新造的一条**：别名**被调用**那一刻按定义扫不到。
    probe: "sendIt(u);",
    why: "**别名被调用那一刻扫不到**：`f(u)` 里没有任何一个表里的名字。"
      + "按名字扫的判据只看得见**别名被造出来**那一刻（`const f = globalThis.fetch;`），"
      + "而那一刻与调用可以隔着一个文件、一个参数、一个对象字段。"
      + "⚠️ 这不是「补一条正则就能修」的那一类——修它要的是数据流分析，"
      + "那已经不是一道文本扫描的射程了。**这条边界是这整道护栏的天花板。**",
  },
  {
    // **既有盲点，非本次改动新造**：`egressSites()` 抠注释用的
    // `/(^|[^:])\/\/.*$/gm` 不认得「这个 `//` 住在模板串里」。
    probe: "const s = `a // b`; fetch(u);",
    why: "单行模板串里出现未被保护的 `//` —— 抠注释那一步会把本行其后的代码整段当成"
      + "行注释删掉，连真调用一起。**新旧判据都得 0**（所以它不是本次改动造成的），"
      + "本仓 admin-ui/js 今天零处这样写。登记 P3e。",
  },
];

describe("面板的网络出口清单", () => {
  it("恰好三处：api.js 的 raw()、app.js 的登录探针、gw-api.js 的网关出口", () => {
    // **按文件计数，不按行号**：行号断言会被任何一次无关的注释改动打红，那种
    // 断言过不了三轮就会被人"顺手放宽"，而放宽之后它就什么都不守了。
    // 第三处是 P3d Task 10 的 Playground 出口：它**拿的是另一把钥匙**（网关口令），
    // 所以它绕开 `api.js` 是刻意的，不是疏漏。两把钥匙各自的禁令见本文件
    // 「凭据头只有 x-admin-key —— 没有任何网关口令头」与
    // `tests/ui/gw-api.test.ts` 的
    // 「凭据头里没有 x-admin-key —— 管理口令绝不许走上对外那条路」。
    const counts: Record<string, number> = {};
    for (const f of walkJs("admin-ui/js")) {
      const n = egressSites(readFileSync(f, "utf8"));
      if (n > 0) counts[f] = n;
    }
    expect(counts, "网络出口的数量或位置变了——api.js 文件头那段安全论证要跟着重写").toEqual({
      "admin-ui/js/api.js": 1,
      "admin-ui/js/app.js": 1,
      "admin-ui/js/gw-api.js": 1,
    });
  });

  /**
   * ── **P3d Task 10：补进枚举表的那三种写法，每一种都真的被数出来** ──────────────
   *
   * **这一格是「补了一格」与「补了一格会红的」之间那个装置。**
   * 只把三条正则加进 `EGRESS_FORMS` 的话，写错任何一条（比如 `\bimport\b` 少了括号、
   * 或者别名那条的否定先行断言方向写反）都不会有任何东西变红——上面那条按文件计数的
   * 断言在「新规则一条都匹配不上」时**照样是绿的**（真实文件里今天本来就没有这三种写法）。
   *
   * ⚠️ **`fetch(u)` 那一条恰好是 1、不是 2**：它同时钉住「两条 `fetch` 规则互斥」。
   * 少了这一条，把别名那条的先行断言写成肯定式（`(?=\s*\()`）会让每一处真调用被数两遍
   * ⇒ 上面那条计数断言当场红成 2，而**红的原因会被读成「又多了一个出口」**。
   *
   * ⚠️ **静态 `import` 必须是 0**：动态那条要求名字后面跟 `(`，写成 `\bimport\b` 的话
   * `admin-ui/js` 下每一行 import 语句都会被数成一个出口（实测那是几十处），
   * 整道护栏当场变成噪音、然后被人放宽。
   */
  it.each([
    ["new WebSocket(u);", 1, "WebSocket：名字根本不在旧表里"],
    ['const m = await import("./x.js");', 1, "动态 import()：会真的去网上取一段代码"],
    ["const f = globalThis.fetch; f(u);", 1, "把 fetch 当值取用 —— 按名字扫只看得见造别名那一刻"],
    ["const f = fetch; f(u);", 1, "别名的另一种写法：直接把裸 fetch 赋给一个变量"],
    // ⚠️ **下面五条是评审在第二版判据上实测出来的逃逸（旧版 1 / 第二版 0）**，
    //    第三版把它们全数补回。**第一条最要命：把 `fetch` 当参数传进去正是本仓自己的
    //    主流写法**（`src/core/` 零 IO、fetcher 一律依赖注入）。
    ["makeClient(fetch);", 1, "当参数传进去 —— 本仓自己的主流写法，第二版判据漏的就是它"],
    ["function getF(){ return fetch; }", 1, "当返回值交出去"],
    ["const [f] = [fetch];", 1, "放进数组再解构"],
    ["send(u, { fetcher: fetch });", 1, "当对象字段传进去（`fetcher` 那个词本身不许被误算）"],
    ["export default fetch;", 1, "整个模块把它 re-export 出去"],
    // 第二版登记过的一条盲点，第三版顺带补上了 ⇒ 它已从 BLIND_SPOTS 里删掉。
    ["const f = globalThis . fetch; f(u);", 1, "成员访问点与名字之间带空格"],
    ["fetch(u);", 1, "真调用仍然恰好数一次 —— 两条 fetch 规则互斥，不许重复计数"],
    ["client.fetch(u);", 1, "成员形态的真调用也恰好一次，不因为前面有个点被数两遍"],
    ['import { t } from "./i18n.js";', 0, "静态 import 不是出口 —— 数进去会把整道护栏变成噪音"],
    ["const importantThing = 1;", 0, "`import` 只是另一个标识符的前缀，`\\b` 得挡住它"],
    ["const prefetch = 1;", 0, "`fetch` 是另一个标识符的后缀，`\\b` 得挡住它"],
    // ⚠️ **下面两条是实测出来的真实误报样本，逐字取自 `admin-ui/js/i18n-dict.js` 的英文文案。**
    //    它们不是想象出来的边界：第一版判据在真实文件上就是被这两句打红的。
    //    ⚠️ 探针刻意写成**裸散文**而不是带引号的字符串字面量——`egressSites()`
    //    今天**不抠**普通字符串的内容（它只抠注释与模板串字面文本），
    //    所以「住在字符串里」并不构成豁免，这两句必须靠判据本身的形状挡住。
    ["Bulk import (one per line)", 0, "英文文案里的 import 加空格加括号 —— 第一版在真实字典上被它打红"],
    ["the per-fetch limit was exceeded", 0, "英文文案里的 fetch 这个词 —— 第一版在真实字典上被它打红"],
    ["reload the page to fetch them again", 0, "同上，第二句"],
  ])("反向自检：补进表里的那三种写法，每一种都真的被数出来：%s", (probe, expected) => {
    // 期望值手写字面量（第 6 种假阳性：不许从 `EGRESS_FORMS` 推导）。
    expect(egressSites(probe as string)).toBe(expected as number);
  });

  /**
   * **反向自检：那条「抠掉模板串字面文本」的处置没有把护栏抠出一个洞。**
   *
   * 没有这一格的话，上面那个两条目的 map 有两种成因分不开：「真的只有两处出口」与
   * 「`stripTemplateText()` 抠得太狠，把真的调用一起抠掉了」。
   * 四条样本分别钉住四件事，**期望值全部手写**。
   *
   * ⚠️ **第四条是评审 F-3 补的，它才是这次改动真正的风险方向**：前三条里的真调用
   * 要么在模板串**另一行**、要么在简单插值里，**一条都不是「模板串与真调用同一行」**
   * ——而那恰恰是「抠过头会吃掉代码」的那个形状（见上面 `BLIND_SPOTS` 第一条）。
   * 一组只覆盖安全形状的自检，证明不了这次改动是安全的。
   */
  it("反向自检：模板串里的字面文本不算出口，而插值里那一截、以及同一行上的真调用仍然算", () => {
    expect(egressSites("const u = `x`;\nfetch(u);"), "模板串外的真调用必须还在").toBe(1);
    expect(egressSites("const s = `await fetch(x)`;"), "模板串里的示例文本不该算出口").toBe(0);
    expect(egressSites("const s = `${fetch(x)}`;"), "插值里是真会跑的代码，抠掉它就是开洞").toBe(1);
    // **夹心**：真调用被两条模板串夹在中间。**这一条才是这次改动真正的风险方向。**
    // ⚠️ 上一版这里写的是 `const a = \`x\`; fetch(u);`（真调用在末尾），**零鉴别力**
    //（定向复评 M-3，实测）：现判据 1、贪婪版（`/\`.*\`/`）1、整条删模板串版 1
    //    ——三种实现全给 1，它证明不了「没抠过头」，而那正是它自称要解决的事。
    //    夹心形态实测：**现判据 1、贪婪版 0**，两种实现在这里才分叉。
    expect(
      egressSites("const a = `x`; fetch(u); const b = `y`;"),
      "被两条模板串夹住的真调用被抠掉了 —— 反引号配对一旦贪婪，中间那截代码就没了",
    ).toBe(1);
  });

  /**
   * **已知抓不住的写法确实抓不住 —— 边界是断言，不是散文。**
   *
   * 形态照抄 `tests/ui/no-hardcoded-endpoints.test.ts`
   * 「已知抓不住的写法确实抓不住（边界是断言，不是散文）」。
   * **这一格变红意味着有人把某个盲点补上了——那是好事**，把对应的 `BLIND_SPOTS` 行删掉即可。
   * 它存在的理由是：一条只写在注释里的边界，改判据的人不会读到。
   */
  it.each(BLIND_SPOTS)("已知抓不住的写法确实抓不住（边界是断言，不是散文）：$why", ({ probe }) => {
    expect(egressSites(probe), `这条写法现在被数出来了，请把它从 BLIND_SPOTS 里删掉`).toBe(0);
  });

  /**
   * **F-1：那条「插值里带花括号就整条丢掉」的盲点，今天在本仓是活的。**
   *
   * ⚠️⚠️ 上一版的注释写着「今天 `admin-ui/js` 下零处这样写」——**那是一句全称假话，
   * 而它宣布休眠的洞当时就开着**。这一格把它变成可观测的。
   *
   * ⚠️ **用例名只说判据本身（`${` 数不齐的那些行），不说「处数不许无声长大」**
   *（定向复评 M-1）：判据自己有一族漏法（插值体里含字符串/正则里的 `}`），
   * 实测能让一个**真的 `fetch`** 同时躲过主扫描和这一格。担保不了的事不许写进用例名。
   *
   * ⚠️ **锚在内容上，不是行号上**（定向复评 M-2）：上一版把**文件路径加行号**
   * 直接写进 `toEqual`，于是在那个文件靠前的位置插一个空行（纯排版、处数根本没变）
   * 那一格就红，而报错文案说的是「处数多了/少了一处」。
   * 那正是本文件上面「按文件计数，不按行号」那段告诫的原话。
   *
   * **期望值手写**，不是把扫描结果粘回来的（第 6 种假阳性）。那一行是
   * `admin-ui/js/sec-overview.js`「ov.runtime.checkedAt」——渲染「上次检查时间」的
   * 三元表达式，插值 `t(…, { at: fmtInstant(…, offsetMs()) })` 带花括号。
   *
   * **变红条件（都实测过）**：在 `admin-ui/js` 下任何地方再写一个 `${` 数不齐的行；
   * 或者把 `sec-overview.js` 那一行的内容改掉。**纯排版改动不再让它红。**
   */
  it("插值捞不齐的那些行今天恰好一处 —— 这道扫描在那一行上是瞎的", () => {
    const found = braceInterpLines();
    expect(
      found.map((x) => x.file),
      "`${` 数不齐的行多了/少了一处。`stripTemplateText()` 会把这些行整条丢掉，"
      + "连里面真会执行的代码一起 ⇒ 藏在那里的网络出口数不出来。"
      + "新增一处之前，先确认那个插值里没有出口；顺手把上面那段边界说明改准",
    ).toEqual(["admin-ui/js/sec-overview.js"]);
    // 内容锚：认那一行**是哪一行**，而不是它在第几行。
    expect(found[0]!.text, "还是那一行吗？内容变了就回来重新判一次").toContain("ov.runtime.checkedAt");
  });

  /**
   * **`admin-ui/js/pure/examples.mjs` 那一处 `fetch(` 到底是不是示例文本。**
   *
   * 上面那道扫描现在按形态把它排除在外，而「按形态排除」与「这个文件真的没有出口」
   * 是两句话。
   * ⚠️ **这一格并不把后者变成可观测的——上一版这句话是这么写的，它与下面那段 ⚠️⚠️
   * 自相矛盾，属于改名时没清干净的残留**（定向复评顺手改）。
   * 这一格担保的只有：那个文件里 `fetch(` 恰好出现一次，且它落在一条
   * `return \`` 开头的模板串里。
   *
   * ⚠️⚠️ **用例名不许写成「换成真的调用当场红」，那句比这一格担保的多**
   *（P3d Task 7 评审 F-6，实测）：把那一行改成
   * `` return `${fetch(url)}const r = await XHR(…` `` —— 真的打了一次网，
   * 而这一格**照样绿**（处数仍是 1、那一行仍以 `` return ` `` 起头），
   * 红的是上面那格主扫描（`Tests 1 failed | 23 passed (24)`）。
   * ⇒ **这一格担保的是「处数 + 书写形态」，真调用那一半是主扫描在守。**
   * 另一种改法（真调用另起一行）两格会一起红，但「一起红」不是这一格的功劳。
   * ⚠️ **而「主扫描在守」这句同样有边界**：主扫描自己沿两条轴各漏一族
   *（见上面 `BLIND_SPOTS` 三条）。这里说的是「这一半不归本格管」，
   * **不是「这一半已经被守住了」**——两句话差得很远。
   *
   * ⚠️ 判据锚在源码的书写形态上，**重排那一行的格式也会红**——那是刻意选的方向：
   * 这个文件里出现 `fetch(` 这件事本身就该有人回来看一眼。
   */
  it("examples.mjs 里 fetch( 恰好一处、且落在模板串里 —— 处数或书写形态一变就该有人回来看", () => {
    const src = readFileSync("admin-ui/js/pure/examples.mjs", "utf8");
    const lines = src.split("\n").filter((l) => /\bfetch\s*\(/.test(l));
    expect(lines, "这个文件里 fetch( 的处数变了").toHaveLength(1);
    expect(lines[0]!.trimStart().startsWith("return `"), `不是模板串里的示例文本：${lines[0]}`).toBe(true);
  });
});
