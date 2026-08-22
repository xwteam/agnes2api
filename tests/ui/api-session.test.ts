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

/** 一段源码里的网络出口处数。**注释与模板串字面文本都不算。** */
function egressSites(src: string): number {
  const code = stripTemplateText(
    // 注释里提到这些名字不算出口（本仓注释极爱复述代码）。
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"),
  );
  return [...code.matchAll(/\b(?:fetch|XMLHttpRequest|EventSource|sendBeacon)\s*\(/g)].length;
}

/**
 * `admin-ui/js` 下**插值里带花括号**的那些行——`stripTemplateText()` 会把它们整条丢掉，
 * 连插值里真会执行的代码一起。
 *
 * 判据直接建在**失效机制**上，不是另起一套启发式：`stripTemplateText()` 用
 * `/\$\{([^{}]*)\}/g` 捞插值，所以**一行里 `${` 的个数多于那条正则能匹配上的个数**，
 * 就说明这一行至少有一个插值的内容捞不回来。
 *
 * ⚠️ **不先抠注释**：抠注释要么按整文件做（那样就没有行号了）、要么另写一套逐行的
 * 启发式（那本身又是一个可错判断）。所以这里连注释一起数——**代价是可能多报**，
 * 而多报只会逼人回来看一眼，少报才会让这段话静静变假。
 */
function braceInterpLines(): string[] {
  const out: string[] = [];
  for (const f of walkJs("admin-ui/js")) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (!line.includes("`") || !line.includes("${")) return;
      const opens = (line.match(/\$\{/g) ?? []).length;
      const simple = (line.match(/\$\{[^{}]*\}/g) ?? []).length;
      if (opens > simple) out.push(`${f}:${i + 1}`);
    });
  }
  return out;
}

/**
 * **已知抓不住的写法，连同为什么接受一起登记。**
 * 形态照抄 `tests/ui/no-hardcoded-endpoints.test.ts`
 * 「已知抓不住的写法确实抓不住（边界是断言，不是散文）」——**边界是断言，不是散文**。
 *
 * ⚠️ 这张表里的两条**都是本次改动（抠模板串字面文本）新造出来的**，
 * 旧判据（只抠注释）不碰反引号，一条都没有。**新造的盲点必须自己登记，
 * 不能只登记「顺手修好的那些」。**
 */
const BLIND_SPOTS: ReadonlyArray<{ probe: string; why: string }> = [
  {
    probe: 'const a = "`"; fetch(u); const b = "`";',
    why: "同一行里反引号数目是偶数、配对却是错的（普通字符串里的散反引号）"
      + " —— `/`[^`\\n]*`/` 会把两个反引号之间的真代码整段当成模板串文本删掉。"
      + "实测旧判据 1、新判据 0。本仓 admin-ui/js 今天零处这样写，登记成盲点。",
  },
  {
    // ⚠️ 出口必须写在**花括号插值内部**——写在同一行的模板串**外面**是数得出来的
    //（那是上面反向自检第四条），拿那种样本当盲点探针会直接红，第一版就红了一次。
    probe: 'const s = `${t("k", { at: f(fetch(u)) })}`;',
    why: "插值里带花括号 —— 整条模板串连同里面真会执行的代码一起被丢掉。"
      + "**这一条今天在本仓是活的**（sec-overview.js 那一行），"
      + "所以它另有一格把处数钉死，不是只写在这张表里。",
  },
];

describe("面板的网络出口清单", () => {
  it("恰好两处：api.js 的 raw() 与 app.js 的登录探针", () => {
    // **按文件计数，不按行号**：行号断言会被任何一次无关的注释改动打红，那种
    // 断言过不了三轮就会被人"顺手放宽"，而放宽之后它就什么都不守了。
    const counts: Record<string, number> = {};
    for (const f of walkJs("admin-ui/js")) {
      const n = egressSites(readFileSync(f, "utf8"));
      if (n > 0) counts[f] = n;
    }
    expect(counts, "网络出口的数量或位置变了——api.js 文件头那段安全论证要跟着重写").toEqual({
      "admin-ui/js/api.js": 1,
      "admin-ui/js/app.js": 1,
    });
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
    // **同一行**：模板串收在真调用**之前**就该收住，别把后面那截代码一起吃掉。
    expect(egressSites("const a = `x`; fetch(u);"), "同一行上模板串之后的真调用被抠掉了").toBe(1);
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
   * **F-1：那条「插值里带花括号就整条丢掉」的盲点，今天在本仓是活的，处数必须被钉死。**
   *
   * ⚠️⚠️ 上一版的注释写着「今天 `admin-ui/js` 下零处这样写」——**那是一句全称假话，
   * 而它宣布休眠的洞当时就开着**。这一格把处数变成可观测的：多一处就红，
   * 逼下一个人回来表态「你新写的那个花括号插值里没有藏出口」。
   *
   * **清单手写**，不是把扫描结果粘回来的（第 6 种假阳性：期望值从被测对象自己推导）。
   * 那一行是 `admin-ui/js/sec-overview.js` 里渲染「上次检查时间」的三元表达式，
   * 插值 `t(…, { at: fmtInstant(…, offsetMs()) })` 带花括号。
   *
   * **变红条件（都实测过）**：在 `admin-ui/js` 下任何地方再写一个带花括号的插值；
   * 或者把 `sec-overview.js` 那一行改掉。
   */
  it("花括号插值今天恰好一处，就是它 —— 这道扫描在那一行上是瞎的，处数不许无声长大", () => {
    expect(
      braceInterpLines(),
      "带花括号的插值多了/少了一处。`stripTemplateText()` 会把这些行整条丢掉，"
      + "连里面真会执行的代码一起 ⇒ 藏在那里的网络出口数不出来。"
      + "新增一处之前，先确认那个插值里没有出口；顺手把上面那段边界说明改准",
    ).toEqual(["admin-ui/js/sec-overview.js:107"]);
  });

  /**
   * **`admin-ui/js/pure/examples.mjs` 那一处 `fetch(` 到底是不是示例文本。**
   *
   * 上面那道扫描现在按形态把它排除在外，而「按形态排除」与「这个文件真的没有出口」
   * 是两句话。这一格把后者变成可观测的：那个文件里 `fetch(` 恰好出现一次，
   * 且它落在一条 `return \`` 开头的模板串里。
   *
   * ⚠️⚠️ **用例名不许写成「换成真的调用当场红」，那句比这一格担保的多**
   *（P3d Task 7 评审 F-6，实测）：把那一行改成
   * `` return `${fetch(url)}const r = await XHR(…` `` —— 真的打了一次网，
   * 而这一格**照样绿**（处数仍是 1、那一行仍以 `` return ` `` 起头），
   * 红的是上面那格主扫描（`Tests 1 failed | 23 passed (24)`）。
   * ⇒ **这一格担保的是「处数 + 书写形态」，真调用那一半是主扫描在守。**
   * 另一种改法（真调用另起一行）两格会一起红，但「一起红」不是这一格的功劳。
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
