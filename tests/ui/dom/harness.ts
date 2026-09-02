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
  "gate", "gate-form", "gate-key", "gate-err", "gate-theme-btn",
  "shell", "lang-select", "theme-btn", "logout-btn", "health-badge",
  "sec-overview", "sec-keys", "sec-registrar", "sec-events", "sec-usage", "sec-models",
  "sec-playground", "sec-settings",
  "toast-host",
] as const;

/**
 * 侧栏导航的顺序，**与真 `index.html` 里 `.nav-item` 的出现顺序逐字一致**。
 *
 * ⚠️ **它与 `SKELETON_IDS` 是两份清单，不是一份**：后者含 `gate` / `shell` /
 * `toast-host` 这些不是板块的 id，而这一份决定 `buildDom()` 造几颗导航按钮、
 * 以及 `Harness.section()` 认哪几个名字。两者的漂移由
 * `tests/ui/dom/app-gate.test.ts` 的
 * 「八个板块按钮的 data-section 与真 index.html 一致（顺序也是导航顺序）」
 * 那一格扫真 `index.html` 兜着。
 */
export const NAV_SECTIONS = [
  "overview", "keys", "registrar", "events", "usage", "models", "playground", "settings",
] as const;

type SectionName = (typeof NAV_SECTIONS)[number];

/**
 * 假 DOM 里这个面板「部署」在哪个域名下。**导出给用例做逐字断言用。**
 * 值本身刻意长得像一条探针，理由见下面 `stubGlobal("location", …)` 那段。
 */
export const PANEL_ORIGIN = "https://panel-probe.invalid";

/**
 * `raw`：**不走 `JSON.stringify`，原样当响应体**（后来加的）。
 *
 * 存在的理由：流式那条路读的是 `text/event-stream`，而 `JSON.stringify` 出来的
 * 永远是一段 JSON —— 没有它，**Playground 的流式那一档在 DOM 层一格都测不到**。
 *
 * ⚠️ **这不是「替身比真实更强」**（第 9 种假阳性）：底下返回的仍然是**真的**
 * `Response` 对象，`.body` 是**真的** `ReadableStream`。这一格只决定塞进去的字节
 * 是什么，不新增任何真实 `fetch` 没有的能力。
 * ⚠️ **但它有一条真实差异，如实登记**：`new Response(string)` 会把整段字节
 * **一次性**交给读者，所以「一条 data 行被拆在两个 chunk 里」这件事**在这里不可观测**。
 * 那条性质由 `tests/ui/playground.test.ts` 的
 * 「一条 data 行被拆在两个 chunk 里仍被正确重组」在纯函数层钉着。
 */
type Resp = {
  status: number;
  body: unknown;
  /**
   * `string` = 一段固定字节；`ReadableStream` = **由用例自己控制吐法的流**
   *（评审发现：中途 `controller.error()` 才走得到「读到一半断了」那条路，
   * 而那条路上的渲染与口令扫描原来一格都没覆盖）。
   */
  raw?: string | ReadableStream<Uint8Array>;
  contentType?: string;
};

export interface Harness {
  dom: FakeDom;
  /** localStorage 的后备表，测试直接读写它做断言。 */
  store: Record<string, string>;
  /**
   * 每次 `fetch` 的记录（url + 方法 + 头 + 请求体）。
   *
   * `body` 是**解析过的 JSON**，不是原始字符串——有断言需要直接核对
   * 请求体的形状（导入框「原样按行发」那条判据只有从这里才验得到：响应体和
   * 网络调用记录都不会告诉你请求当初长什么样）。解析失败（非 JSON body，例如
   * `undefined`）时是 `undefined`，不是抛异常。
   */
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>;
  /**
   * 下一次（及之后）`fetch` 的应答，按 url 前缀匹配；缺省 200 + `{}`。
   *
   * ⚠️ **应答可以返回一个 Promise**（后来加的）。加它是因为
   * 「成功提示不得早于回读」这条产品不变式**在零延迟下整个不可观测**：
   * 请求与响应落在同一条微任务链里，「早于」这件事没有可以插进去断言的缝。
   * 本仓在 storage 轴上为同一形态栽过一次（第 8 种候选假阳性）。
   * 返回非 Promise 的老写法**行为逐字不变**（`await` 一个非 Promise 只多一个微任务，
   * 而这里本来就在 async 函数里）。
   */
  respond(fn: (url: string, method: string) => Resp | Promise<Resp>): void;
  gate: FakeElement;
  shell: FakeElement;
  form: FakeElement;
  input: FakeElement;
  err: FakeElement;
  section(name: SectionName): FakeElement;
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

  // 三颗图标按钮的 `data-i18n-title`：真 `index.html` 上写着，`apply()` 靠它写
  // title / aria-label。夹具漏了它的话，「图标按钮读屏器读得出来」那一格测的是空气。
  // ⚠️ 这三条与真 HTML 的对齐由 `tests/ui/shell-chrome.test.ts` 的
  // 「三颗图标按钮在 index.html 里都带着 data-i18n-title」那一格扫真文件兜着。
  for (const [id, key] of [
    ["theme-btn", "shell.theme"], ["gate-theme-btn", "shell.theme"], ["logout-btn", "shell.logout"],
    ["health-badge", "shell.status.hint"],
  ] as const) {
    dom.byId(id).setAttribute("data-i18n-title", key);
  }
  // 状态徽章的**初始档就是「状态未知」**（还没探过），与真 `index.html` 一致。
  dom.byId("health-badge").setAttribute("data-i18n", "shell.status.unknown");
  dom.byId("health-badge").classList.add("badge", "health-badge");

  const nav: FakeElement[] = [];
  for (const name of NAV_SECTIONS) {
    const btn = dom.document.createElement("button");
    btn.classList.add("nav-item");
    btn.setAttribute("data-section", name);
    // **`data-i18n` 挂在里面那个 span 上，不是挂在按钮上**——真 `index.html` 就是这么写的，
    // 而它不是随便挑的：`apply()` 对 [data-i18n] 写的是 `textContent`，标在按钮上会
    // 把同在按钮里的那颗图标一起抹掉。夹具照抄这个结构，不然这里测不到那件事。
    const ico = dom.document.createElement("span");
    ico.classList.add("nav-ico");
    btn.appendChild(ico);
    const label = dom.document.createElement("span");
    label.setAttribute("data-i18n", `nav.${name}`);
    btn.appendChild(label);
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
  respond?: (url: string, method: string) => Resp | Promise<Resp>;
} = {}): Promise<Harness> {
  const { dom } = buildDom();
  const store: Record<string, string> = { ...(opts.store ?? {}) };
  const calls: Harness["calls"] = [];
  let responder: (url: string, method: string) => Resp | Promise<Resp> =
    opts.respond ?? (() => ({ status: 200, body: {} }));

  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    let body: unknown;
    if (init?.body !== undefined) {
      try { body = JSON.parse(String(init.body)); } catch (e) { body = undefined; }
    }
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    // ⚠️ **同步应答不许多走一个微任务。** 第一版无条件 `await responder(...)`，
    // 而 `await` 一个非 Promise 同样要排一个微任务 ⇒ 既有用例里那些 `settle(6)`
    // 的深度当场不够用，**3 格实测变红**（`keys-actions.test.ts` 里 toast 与
    // 确认弹窗那几格：断言跑在渲染之前，读到的是空字符串）。
    // 只有真的返回了 thenable 才 await，同步那条路径逐字保持原来的时序。
    const pending = responder(String(url), String(init?.method ?? "GET"));
    const r = pending !== null && typeof pending === "object" && typeof (pending as Promise<Resp>).then === "function"
      ? await pending
      : pending as Resp;
    // `raw` 那一档原样送字节（流式用），其余仍然走 JSON —— 既有用例逐字不受影响。
    return new Response(r.raw !== undefined ? r.raw : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": r.contentType ?? (r.raw !== undefined ? "text/event-stream" : "application/json") },
    });
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: async () => {} } });
  /**
   * 面板部署在哪个域名下。
   *
   * ⚠️ **它必须是一个替身，而且必须与本仓任何真实部署都不像**：设置页第 4 张卡
   *（集成示例）里那条 base URL 是**运行期**从这里取的，
   * 用例正是靠「渲染出来的地址逐字等于这里这个值」证明它没被写死。
   * 取一个显然是探针的值，写死的那一版就绝不可能碰巧通过。
   *
   * ⚠️ **只给 `origin` 一格，不给整个 Location**（第 9 种假阳性：替身比真实更强）：
   * 发货代码今天只用得上这一格，多给的每一格都是一条「测试里有、真机上未必一样」的路。
   */
  vi.stubGlobal("location", { origin: PANEL_ORIGIN });
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

/**
 * 让面板发出去的那几层异步**跑到落定**（`fetch` 的两层 await + `Response.json()`）。
 *
 * ── 为什么这里不是 `await Promise.resolve()` 数 tick ─────────────────────────
 * 原实现是 `for (i<times) await Promise.resolve()`，即「排 `times` 个微任务」。
 * 那等于**手写一个「这条链有多少层」的常量**，而层数不由本仓决定 ——
 * `Response.json()` 落在 undici 里，它读流要走几层随 Node 版本变：
 *   · Node 24（本机开发用的版本）：6 层就够，全绿；
 *   · Node 22（`Dockerfile` 里 `node:22-alpine`、CI 里 `node-version: 22`，
 *     **也就是真正出货的那个版本**）：**至少要 10 层**，实测 6 层时
 *     `tests/ui/dom/**` 有 7 份文件、119 格红。
 * ⇒ 公开仓的 CI 一路红着，而本机 `scripts/prepush.sh` 一路绿 —— 两边跑的
 *   Node 大版本不是同一个，这一格就卡在中间。
 *
 * 现在一轮 = **一个宏任务回合**（`setImmediate`）。回合与回合之间整条微任务队列
 * 会被**抽干**（含微任务自己再排出来的那些），所以这不再是「猜要几个 tick」，
 * 而是结构上跑完。`times` 的含义从「几个微任务」变成「几个回合」，
 * 181 处显式传 `6` / `12` 的调用点一个都不用改（回合比 tick 强得多）。
 *
 * ⚠️ **不许改回数 tick**：`tests/ui/dom/fake-dom-parity.test.ts` 里
 * 「settle 抽干的是整条微任务队列，不是数着固定几个 tick」那一组用一条 200 层深的链钉着这件事。
 * ⚠️ **中间态判据不受影响**：那几格（比如「回读还没落定之前不许出现成功迹象」）
 * 靠的是一个**始终没解决**的 promise，抽多久都抽不出结果 —— 同一组里有一格钉着。
 * ⚠️ `setImmediate` 今天没有被任何一份用例假造：两处 `vi.useFakeTimers()` 都显式
 * 只 fake `setTimeout` / `clearTimeout`，`events-poll.test.ts` 只 stub 了 `setTimeout`。
 */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => { setImmediate(r); });
}
