import { vi } from "vitest";
import { createFakeDom, installFakeDom, type FakeDom, type FakeElement } from "../../helpers/fake-dom.js";

/**
 * 把 `admin-ui/index.html` 的骨架搭进假 DOM，然后 import `admin-ui/js/app.js`
 *（它有大量**模块顶层**副作用：查 id、挂监听、`apply(document)`、`setTheme(...)`、
 * 以及"已存过口令就直接验一次"那一段）。
 *
 * ⚠️ **骨架是照着 `admin-ui/index.html` 手抄的，两者会漂。** 这一层刻意不做成
 * "解析真 index.html"：那需要一个 HTML 解析器（= 新依赖）。代价由
 * `tests/ui/dom/app-gate.test.ts` 的「index.html 里的每个 id 都在骨架清单里，反之亦然」
 * 那一格兜住——它直接扫真 `index.html`，漂了就红。
 */
export const SKELETON_IDS = [
  "gate", "gate-form", "gate-key", "gate-err",
  "shell", "lang-select", "theme-btn", "logout-btn",
  "sec-overview", "sec-keys", "sec-events", "toast-host",
] as const;

export interface Harness {
  dom: FakeDom;
  /** localStorage 的后备表，测试直接读写它做断言。 */
  store: Record<string, string>;
  /** 每次 `fetch` 的记录（url + 方法 + 头）。 */
  calls: Array<{ url: string; method: string; headers: Record<string, string> }>;
  /** 下一次（及之后）`fetch` 的应答，按 url 前缀匹配；缺省 200 + `{}`。 */
  respond(fn: (url: string) => { status: number; body: unknown }): void;
  gate: FakeElement;
  shell: FakeElement;
  form: FakeElement;
  input: FakeElement;
  err: FakeElement;
  section(name: "overview" | "keys" | "events"): FakeElement;
}

export function buildDom(): { dom: FakeDom; nav: FakeElement[] } {
  const dom = createFakeDom();
  for (const id of SKELETON_IDS) dom.mount(id, id === "gate-form" ? "form" : "div");
  // `gate-key` 是 input、`gate-form` 里要有一个 submit 按钮（`app.js` 会 disable 它）。
  dom.byId("gate-form").appendChild(dom.byId("gate-key"));
  const submit = dom.document.createElement("button");
  submit.setAttribute("type", "submit");
  dom.byId("gate-form").appendChild(submit);
  dom.byId("gate-form").appendChild(dom.byId("gate-err"));

  const nav: FakeElement[] = [];
  for (const name of ["overview", "keys", "events"]) {
    const btn = dom.document.createElement("button");
    btn.classList.add("nav-item");
    btn.setAttribute("data-section", name);
    btn.setAttribute("data-i18n", `nav.${name}`);
    dom.document.body.appendChild(btn);
    nav.push(btn);
    dom.byId(`sec-${name}`).classList.add("section");
  }
  return { dom, nav };
}

/**
 * 装好全局并 import `app.js`。**每次都 `vi.resetModules()`**：`app.js` 与 `api.js`
 * 都是有模块级状态的 ESM，不重置的话第二个用例拿到的是第一个用例跑完的那份。
 */
export async function bootPanel(opts: {
  /** 预置的 localStorage 内容（模拟"上次登录留下的会话"）。 */
  store?: Record<string, string>;
  now?: number;
  respond?: (url: string) => { status: number; body: unknown };
} = {}): Promise<Harness> {
  const { dom } = buildDom();
  const store: Record<string, string> = { ...(opts.store ?? {}) };
  const calls: Harness["calls"] = [];
  let responder = opts.respond ?? (() => ({ status: 200, body: {} }));

  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const r = responder(String(url));
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: async () => {} } });
  if (opts.now !== undefined) vi.spyOn(Date, "now").mockReturnValue(opts.now);
  installFakeDom((n, v) => vi.stubGlobal(n, v), dom);

  vi.resetModules();
  await import("../../../admin-ui/js/app.js");

  return {
    dom,
    store,
    calls,
    respond(fn) { responder = fn; },
    gate: dom.byId("gate"),
    shell: dom.byId("shell"),
    form: dom.byId("gate-form"),
    input: dom.byId("gate-key"),
    err: dom.byId("gate-err"),
    section: (name) => dom.byId(`sec-${name}`),
  };
}

/** 让所有已经排队的 microtask 跑完（`fetch` 的两层 await）。 */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
