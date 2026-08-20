/**
 * **手写的最小 DOM 夹具。零新依赖。**
 *
 * ── 它为什么存在（全分支评审 B1）─────────────────────────────────────────────
 * P3b 期间 `admin-ui/js/*.js`（框架层 + 三个板块，约 1,300 行发货代码）**零行为
 * 覆盖**：12 条针对这些文件的变异，**11 条完整逃逸**。逃逸的东西不是边角——
 * 里面有一条已经上线的、面板对运维说假话的缺陷（清空按钮），有一个改一处就能让
 * 面板彻底进不去的键名分叉，还有一个把生产读配额变成 4 倍的轮询间隔。
 * 同一轮的方法论对照（删掉 `i18n.js` 的 `?? row[FALLBACK]`）**精确变红 1 条**
 * ——所以那 11 条存活是**覆盖缺失**，不是量具坏了。
 *
 * **它是夹具，不是框架。** 28 个 DOM API（P3c Task 4 新增 `focus()` / `blur()` /
 * `keydown()` / `document.activeElement` 四个，原来是 24 个）、一份手写文件、
 * 不需要任何构建步骤，与仓里已有的 `tests/helpers/fake-storage.ts` 是同一档东西。
 * 硬约束 4（不引入需要构建步骤的前端框架）与「不新增依赖」两条都没有被碰。
 *
 * ── 关键论据：它是**输出层预言机** ─────────────────────────────────────────
 * 它断言的是**运维实际读到的那些字**（渲染后的 `textContent`）。源码文本门禁必须
 * 猜缺陷会长成什么语法形态——`scripts/check-i18n.mjs` 的第 ⑧ 条就是这么栽的
 *（第一版只认双引号，把它要防的那个缺陷换成单引号原样重放就 exit 0），**栽完之后
 * 同一个形态在别处又犯了一遍**。渲染文本断言不用猜：不管缺陷用什么语法写出来，
 * 只要屏幕上那个字变了，断言就红。
 *
 * ── 它**不**覆盖什么（明写，别读成「前端有自动化保障了」）─────────────────────
 * ① **admin-ui/README.md 硬规则 1 的「放置」问题**：一段判据是写在 `js/pure/` 里
 *    还是内联在板块文件里，行为测试**两种都绿**。它消除的是**错放的后果**
 *   （判据没有覆盖），不是错放本身。那一半仍然由 `scripts/build-ui.mjs` 的静态
 *    校验 + 代码评审管。
 * ② **真实浏览器/HTTP 的一切**：CSS 布局、真实 `fetch` 的 CORS 与请求头限制、
 *    浏览器对非 Latin-1 头值抛 `TypeError`、`file://` 的模块加载。那些只能靠
 *    `wrangler dev` + 真浏览器的人工冒烟。
 * ③ **事件循环的真实时序**：这里的 `setTimeout` 是 vitest 的假定时器或直接手调，
 *    不是浏览器的渲染帧。
 *
 * ⚠️ **不实现 CSS 选择器引擎。** `querySelectorAll` 只认三种形态：`.class`、
 * `#id`、`tag`（以及 `[attr]`）。板块代码今天只用这三种；写第四种时这里会抛错
 * 而不是静默返回空数组——静默返回空数组会让一整段渲染断言凭空全绿。
 */

type Listener = (ev: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  detail?: unknown;
  preventDefault(): void;
  defaultPrevented: boolean;
  target: FakeElement | null;
  /** 只有键盘事件（`keydown`）会带这两个字段，P3c Task 4 的焦点管理测试要用。 */
  key?: string;
  shiftKey?: boolean;
}

function makeEvent(type: string, detail?: unknown, extra?: { key?: string; shiftKey?: boolean }): FakeEvent {
  const ev: FakeEvent = {
    type,
    detail,
    defaultPrevented: false,
    target: null,
    preventDefault() { ev.defaultPrevented = true; },
    ...(extra || {}),
  };
  return ev;
}

/**
 * **模块级的"当前聚焦元素"。**不挂在某一棵 FakeDom 树上——`createFakeDom()`
 * 每次调用都建一棵新树，但测试里同一时刻只会有一棵树被 `installFakeDom`
 * 装成全局 `document`，所以模块级状态足够，不需要每个 FakeElement 都持一份
 * 指回自己所属文档的引用（那会让构造函数签名到处改）。
 */
let activeElement: FakeElement | null = null;

export class FakeClassList {
  private readonly set = new Set<string>();
  constructor(private readonly owner: FakeElement) {}
  add(...names: string[]): void { for (const n of names) this.set.add(n); this.sync(); }
  remove(...names: string[]): void { for (const n of names) this.set.delete(n); this.sync(); }
  contains(name: string): boolean { return this.set.has(name); }
  toggle(name: string, force?: boolean): boolean {
    const want = force === undefined ? !this.set.has(name) : force;
    if (want) this.set.add(name); else this.set.delete(name);
    this.sync();
    return want;
  }
  /** `class` 属性与 classList 是同一份状态的两个视图，必须同步——板块两种写法都用。 */
  private sync(): void { this.owner.attrs.set("class", [...this.set].join(" ")); }
  reset(value: string): void {
    this.set.clear();
    for (const n of value.split(/\s+/).filter(Boolean)) this.set.add(n);
  }
  toString(): string { return [...this.set].join(" "); }
}

export class FakeElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly attrs = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  readonly classList: FakeClassList;
  /** 表单/滚动这类不走属性的活字段，板块直接读写它们。 */
  value = "";
  checked = false;
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  lang = "";
  private ownText = "";

  constructor(readonly tagName: string, readonly namespace: string | null = null) {
    this.classList = new FakeClassList(this);
  }

  /** DOM 语义：读 = 整棵子树的文本；写 = 清空子树并只留这一段文本。 */
  get textContent(): string {
    if (this.children.length === 0) return this.ownText;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parent = null;
    this.children.length = 0;
    this.ownText = v === null || v === undefined ? "" : String(v);
  }

  /** `title` 在真实 DOM 上既是属性又是 IDL 属性，两边同一份状态。 */
  get title(): string { return this.attrs.get("title") ?? ""; }
  set title(v: string) { this.attrs.set("title", String(v)); }

  get id(): string { return this.attrs.get("id") ?? ""; }

  /** `className` 与 `class` 属性、`classList` 是同一份状态的三个视图。 */
  get className(): string { return this.attrs.get("class") ?? ""; }
  set className(v: string) { this.setAttribute("class", String(v)); }

  appendChild<T extends FakeElement>(child: T): T {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): void {
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); child.parent = null; }
  }

  remove(): void { this.parent?.removeChild(this); }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    if (name === "class") this.classList.reset(String(value));
  }
  getAttribute(name: string): string | null { return this.attrs.has(name) ? this.attrs.get(name)! : null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === "class") this.classList.reset("");
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** 触发一次事件。**不冒泡**：板块代码没有依赖冒泡的地方，实现它只会多一处猜测。 */
  dispatchEvent(ev: FakeEvent): boolean {
    ev.target = this;
    for (const fn of this.listeners.get(ev.type) ?? []) fn(ev);
    return !ev.defaultPrevented;
  }

  /** 测试用：把一次用户点击/输入喂进去。 */
  click(): void { this.dispatchEvent(makeEvent("click")); }
  input(v: string): void { this.value = v; this.dispatchEvent(makeEvent("input")); }
  change(): void { this.dispatchEvent(makeEvent("change")); }
  submit(): FakeEvent {
    const ev = makeEvent("submit");
    this.dispatchEvent(ev);
    return ev;
  }

  /**
   * **P3c Task 4 新增**：真实 DOM 的 `focus()`/`blur()` 会移动
   * `document.activeElement`，本仓的焦点管理（modal 焦点陷阱、toast 关闭按钮
   * 拿到初始焦点）第一次需要用得到这件事——之前 24 个 API 里没有它。
   * 不派发 `focus`/`blur` 事件：目前没有任何板块代码监听这两个事件，加了
   * 也验证不到什么，只会多一处要维护的假设。
   */
  focus(): void { activeElement = this; }
  blur(): void { if (activeElement === this) activeElement = null; }

  /** 键盘事件。`key` 是 `"Tab"` / `"Escape"` 这类值，`opts.shiftKey` 给 Shift+Tab 用。 */
  keydown(key: string, opts?: { shiftKey?: boolean }): FakeEvent {
    const ev = makeEvent("keydown", undefined, { key, shiftKey: !!(opts && opts.shiftKey) });
    this.dispatchEvent(ev);
    return ev;
  }

  /** 深度优先的全部后代（含自己）。 */
  walk(): FakeElement[] {
    return [this, ...this.children.flatMap((c) => c.walk())];
  }

  querySelectorAll(sel: string): FakeElement[] {
    const match = compile(sel);
    return this.walk().slice(1).filter(match);
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

/**
 * 只认 `.class` / `#id` / `tag` / `[attr]` 与它们的简单组合（如 `meta[name="x"]`）。
 * **别的形态直接抛错**：静默返回空数组会让一整段渲染断言凭空全绿。
 */
function compile(sel: string): (el: FakeElement) => boolean {
  const s = sel.trim();
  // ⚠️ 属性名里**必须收数字**：面板的钩子是 `data-i18n` / `data-i18n-ph` /
  // `data-i18n-title`，第一版把 `[A-Za-z_-]+` 写死，于是 `apply()` 里那三次
  // `querySelectorAll` 全部抛错——好在是抛错不是静默返回空数组。
  const attr = /^([A-Za-z]*)\[([A-Za-z0-9_-]+)(?:=["']([^"']*)["'])?\]$/.exec(s);
  if (attr) {
    const [, tag, name, value] = attr;
    return (el) => (!tag || el.tagName === tag)
      && el.attrs.has(name!)
      && (value === undefined || el.attrs.get(name!) === value);
  }
  if (s.startsWith(".")) {
    const cls = s.slice(1);
    if (/[^A-Za-z0-9_-]/.test(cls)) throw new Error(`fake-dom：不支持的选择器 ${sel}`);
    return (el) => el.classList.contains(cls);
  }
  if (s.startsWith("#")) {
    const id = s.slice(1);
    return (el) => el.id === id;
  }
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(s)) return (el) => el.tagName === s;
  throw new Error(`fake-dom：不支持的选择器 ${sel}（这个夹具刻意不实现选择器引擎）`);
}

export interface FakeDom {
  document: {
    documentElement: FakeElement;
    body: FakeElement;
    hidden: boolean;
    /** 当前聚焦的元素（`FakeElement.focus()`/`blur()` 挪动它），无聚焦时 `null`。 */
    readonly activeElement: FakeElement | null;
    createElement(tag: string): FakeElement;
    createElementNS(ns: string, tag: string): FakeElement;
    getElementById(id: string): FakeElement | null;
    querySelector(sel: string): FakeElement | null;
    querySelectorAll(sel: string): FakeElement[];
    addEventListener(type: string, fn: Listener): void;
    dispatchEvent(ev: FakeEvent): boolean;
  };
  /** 面板 `index.html` 里那几个 `id` 的替身，测试直接拿它们驱动。 */
  byId(id: string): FakeElement;
  /** 建一个带 id 的空元素挂到 body 上（模拟 index.html 的骨架）。 */
  mount(id: string, tag?: string): FakeElement;
  CustomEvent: new (type: string, init?: { detail?: unknown }) => FakeEvent;
}

/**
 * 建一棵空的假 DOM。**调用方负责 `mount()` 出面板需要的那些 id**——刻意不预置，
 * 免得夹具与 `admin-ui/index.html` 悄悄分叉时测试仍然全绿（那正是第 1 种假阳性）。
 */
export function createFakeDom(): FakeDom {
  // 每次"新开一个页面"都重置聚焦——不重置的话，上一个用例留下的 FakeElement
  // 会作为"当前聚焦元素"泄漏进下一个用例，而两者的 DOM 树毫无关系。
  activeElement = null;
  const html = new FakeElement("html");
  const body = html.appendChild(new FakeElement("body"));
  const ids = new Map<string, FakeElement>();
  const docListeners = new Map<string, Listener[]>();

  const document: FakeDom["document"] = {
    documentElement: html,
    body,
    hidden: false,
    get activeElement() { return activeElement; },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag, ns),
    getElementById: (id) => ids.get(id) ?? null,
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    addEventListener(type, fn) {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    dispatchEvent(ev) {
      for (const fn of docListeners.get(ev.type) ?? []) fn(ev);
      return !ev.defaultPrevented;
    },
  };

  class FakeCustomEvent implements FakeEvent {
    readonly type: string;
    readonly detail: unknown;
    defaultPrevented = false;
    target: FakeElement | null = null;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
    preventDefault(): void { this.defaultPrevented = true; }
  }

  return {
    document,
    byId(id) {
      const el = ids.get(id);
      if (!el) throw new Error(`fake-dom：没有 mount 过 id=${id}`);
      return el;
    },
    mount(id, tag = "div") {
      const el = new FakeElement(tag);
      el.setAttribute("id", id);
      ids.set(id, el);
      body.appendChild(el);
      return el;
    },
    CustomEvent: FakeCustomEvent as unknown as FakeDom["CustomEvent"],
  };
}

/**
 * 把一棵假 DOM 装进全局，好让 `admin-ui/js/*.js` 里那些**模块顶层**就跑的语句
 *（`document.getElementById("gate")` 这类）能找到它。
 *
 * 调用方负责在 `afterEach` 里 `vi.unstubAllGlobals()`。
 */
export function installFakeDom(
  stub: (name: string, value: unknown) => void,
  dom: FakeDom,
): void {
  stub("document", dom.document);
  stub("CustomEvent", dom.CustomEvent);
}
