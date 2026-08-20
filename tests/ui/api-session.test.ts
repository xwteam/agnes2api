import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { raw, api, ApiError, onUnauthorized } from "../../admin-ui/js/api.js";
import { SESSION_MAX_AGE_MS } from "../../admin-ui/js/pure/session.mjs";

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
