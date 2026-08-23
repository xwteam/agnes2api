import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bootPanel, settle, PANEL_ORIGIN, type Harness } from "./harness.js";
import { stripComments } from "../../helpers/strip-comments.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE, GW_KEY_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { catalogPayload } from "../../../src/core/admin/protocol-catalog.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **Playground 板块的渲染与在途护栏（P3d Task 10 Step 4 / Step 6）。**
 *
 * `tests/ui/playground.test.ts` 的
 * 「四条协议各构造一次请求，URL 全部由 origin + 真源路径拼出 —— 一个硬编码路径都没有」
 * 把请求构造测得很细，**但没有任何东西验证板块文件真的把那份请求发了出去、
 * 也没有东西验证那颗按钮的护栏真的在**。
 * 全局约束 14 逐字要求「按一下就烧配额 / 打上游的按钮，必须在同一个任务里连同它的
 * 护栏一起交付」——这一组就是那句话的执行机构。
 *
 * ── **替身能力核对（第 9 种假阳性，检查单要求逐条写出来）** ────────────────────
 * `tests/ui/dom/fake-dom-parity.test.ts` 的
 * 「盲区清单不是空的——如实登记按名字扫描拦不住的那几类，别让人以为门禁绿了就等于处处一致」
 * 那一格是权威表：`FAKE_ONLY_MEMBERS` **8 条**
 * （`.walk()` / `.parent` / `.input()` / `.attrs` / `.listeners` / `classList.reset()` /
 * `querySelectorAll()` 后紧跟数组方法 / `.children` 后紧跟数组方法），
 * `KNOWN_BLIND_SPOTS` **3 条**（返回值先存进变量再调数组方法 / `submit()` 语义相反 /
 * `.disabled` 挂错宿主）。
 * `admin-ui/js/sec-playground.js` 用到的 DOM 成员逐个对过：
 * `createElement` / `setAttribute` / `textContent` / `appendChild` / `addEventListener` /
 * `classList.toggle(name, force)` / `.value`（`input` `select` `textarea`）/
 * `.disabled`（`button` `input` `select`）
 * ——**8 条一条都没用到**。
 * ⚠️ **3 条盲点里踩了一条，明写**：`.disabled`。夹具把它挂在**每一个**元素上，
 * 而且**夹具里点一颗 disabled 的按钮照样会触发监听器**（真实浏览器不会）。
 * ⇒ **「按钮变灰」这件事在这里只能验到属性，验不到「点不动」。**
 * ⚠️⚠️ **上一版这里写的是「护栏在发货代码里是两道：`btn.disabled` 加 `sendOnce()` 开头那句
 * `if (inFlight) return;`」——而那一行在同一个提交里已经被删掉了**（变异实测证明它是冗余，
 * 详见下面「在飞时再点一次发送」那一格的说明）。**同一个文件里两段互相矛盾，
 * 而文件头是先被读到的那一段。** 这正是那一格里我自己写下的那条 ⭐ 记形要防的事，
 * 而我当时只改了两处、漏了这一处。
 * ⇒ 说准：**在飞去重的判据只有一份，就是 `sendBlockedKey()` 的第一档**
 * （`pg.send.blockedInFlight`）；`btn.disabled` 与 `sendOnce()` 的早退**读的都是它**。
 * 下面「在飞时再点一次发送：不许发出第二条」那一格钉的是那个判据本身，
 * 它在夹具里是可观测的（行为那条断言单独就会红），而「灰按钮点不动」那一层不是。
 *
 * ⚠️ 本文件的**测试代码**里遍历子树用的是 `for…of` + `.children` 递归，不调 `.walk()`
 * ——真实 DOM 上 `.children` 是可迭代的 `HTMLCollection`，`.walk()` 根本不存在。
 * 测试不在那道扫描范围内，但照真实语义写才不会把一个错的写法教给下一个人。
 */
const TOKEN = "admin-token-0123456789-ok!";
const GW_TOKEN = "gateway-token-0123456789-wxyz";
const NOW = 1_700_000_000_000;

// `useRealTimers()` 是 P3d Task 12 加的：视频轮询那几格装假定时器，忘了收就会把
// 后面每一格的 `setTimeout` 一起冻住（而症状是「某一格莫名超时」，不指向这里）。
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// **与 `harness.ts` 的那一份保持同形**：`raw` 是 P3d Task 11 为流式加的
// （原样送字节，不走 JSON.stringify），理由全文在那个文件里。
type Resp = { status: number; body: unknown; raw?: string | ReadableStream<Uint8Array>; contentType?: string };
type Responder = (url: string, method: string) => Resp | Promise<Resp>;

/** 设置页那把网关口令的公开视图：**只有 `configured` 与末几位**（设计 §8.6）。 */
function configBody(hint: string | null): unknown {
  return { credentials: { gatewayToken: { configured: hint !== null, hint, lockedBy: null } } };
}

/**
 * 缺省应答：目录交出**真源那一份**（`catalogPayload()`），**不手抄一份**
 * （第 7 种假阳性：测的是抄件不是原件）。对外那条请求默认回一段可辨认的 JSON。
 */
function respondWith(opts: {
  catalog?: Resp;
  config?: Resp;
  /**
   * 对外那条请求怎么应答。**返回 `{ raw }` 就是一段原样的 SSE 字节**（流式那一档用）。
   *
   * ⚠️ **它收得到 `url`（P3d Task 12 加的）**：视频是两段式，建任务与轮询打的是
   * **两条不同的对外路径**，而上一版这个回调一个参数都没有 ⇒ 两段只能回同一份东西
   * ⇒ 「轮询真的打的是带任务标识的那条路径」这件事在 DOM 层根本不可观测。
   * 老写法（`() => …`）多收一个参数不影响，既有用例逐字不变。
   */
  gateway?: (url: string, method: string) => Resp | Promise<Resp>;
} = {}): Responder {
  return (url: string, method: string) => {
    if (url.startsWith("/admin/api/models")) return opts.catalog ?? { status: 200, body: catalogPayload() };
    if (url.startsWith("/admin/api/config")) return opts.config ?? { status: 200, body: configBody("wxyz") };
    if (url.startsWith(PANEL_ORIGIN)) {
      return (opts.gateway ?? (() => ({ status: 200, body: { reply: "PONG-FROM-UPSTREAM" } })))(url, method);
    }
    return { status: 200, body: {} };
  };
}

/** 打开 Playground 板块（登录态 + 上次停在 playground）。 */
async function openPg(respond: Responder, store: Record<string, string> = {}): Promise<Harness> {
  const h = await bootPanel({
    now: NOW,
    store: {
      [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "playground", ...store,
    },
    respond,
  });
  await settle(20);
  return h;
}

/** 点侧栏上那颗**真的**导航按钮（走整条 `showSection` 接线）。 */
function navTo(h: Harness, name: string): void {
  for (const btn of h.dom.document.querySelectorAll(".nav-item")) {
    if (btn.getAttribute("data-section") === name) btn.click();
  }
}

function pick(section: FakeElement, sel: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const n of section.querySelectorAll(sel)) out.push(n);
  return out;
}
function one(section: FakeElement, sel: string): FakeElement {
  const list = pick(section, sel);
  expect(list.length, `选择器 ${sel} 应当恰好命中一个，实际 ${list.length}`).toBe(1);
  return list[0]!;
}

/** 整棵子树（含自己）。**只用 `.children` 的 for…of 递归**，真实 DOM 上同样成立。 */
function everyNode(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [root];
  for (const c of root.children) out.push(...everyNode(c));
  return out;
}

/**
 * ── **H1：「口令一处都不出现」的扫描面与调用点** ────────────────────────────────
 *
 * ⚠️⚠️ **上一版这道扫描只扫 `h.section("playground")` 那棵子树，而它的用例名是一句
 * 全称句（「面板上任何一处」）。评审逐条实测出两条逃逸：**
 * · **逃逸 A（板块之外）**：把口令拼进 `toast()`（「排查方便点」最自然的写法）⇒ **23/23 全绿**
 *   ——`#toast-host` 是 `<body>` 的最后一个元素，**根本不在板块子树里**。
 * · **逃逸 B（没被渲染过的那一档）**：上一版只造了传输失败那一档，而 `buildTurn()` 在
 *   `turn.errorKey !== null` 时**提前 return** ⇒ **响应体那一档在扫描下一次都没渲染过**，
 *   注释里那条「在右栏那一轮里把请求头一起渲染出来」的变红条件**放在成功分支上就是假的**。
 * ⇒ **两处都修**：扫描面提到 `h.dom.document.body`（整页，含 `#toast-host` 与登录闸），
 * 并把扫描抽成本函数，在**成功 / 传输失败 / 构造失败**三档各调一次。
 * ⭐ 记一条形状（与本文件那条同族）：**写下一条全称句时，把「它不覆盖哪些」也逐条种一次**
 * ——H1 与 H3 是同一个毛病的两次发作：**写下的覆盖面小于宣称的范围。**
 */
function expectNoTokenAnywhere(h: Harness, where: string): void {
  // **整页**，不是板块子树：`#toast-host` / 登录闸 / 侧栏都在这棵树上。
  const root = h.dom.document.body;
  // ① 整页渲染文本里没有它。
  expect(root.textContent, `${where}：网关口令被渲染到了屏幕上`).not.toContain(GW_TOKEN);
  // ② 逐个节点、逐个属性值里都没有它（`title` / `data-*` / `placeholder` / `aria-*` …）。
  //    **只放过输入框自己的 `.value`**：真实 DOM 里它是 IDL 属性，不进 `attributes`、
  //    也不进 `textContent`。
  for (const node of everyNode(root)) {
    for (const [name, value] of node.attrs) {
      expect(value, `${where}：<${node.tagName}> 的 ${name} 属性里带上了网关口令`).not.toContain(GW_TOKEN);
    }
  }
  // ③ 连口令的一段（末 8 位）都不许出现 —— 一条末位旁路同样是旁路。
  expect(root.textContent, `${where}：网关口令的末段被渲染了出来`).not.toContain(GW_TOKEN.slice(-8));
}

/** 把网关口令粘进那个输入框（走真的 `input` 事件，不是直接改状态）。 */
function pasteToken(section: FakeElement, value: string): void {
  one(section, ".pg-token").input(value);
}

/** 写一句提示词。 */
function typePrompt(section: FakeElement, value: string): void {
  one(section, ".pg-prompt").input(value);
}

/** 切到某个模式档（走真的按钮点击，不是直接改状态）。 */
function toMode(section: FakeElement, name: string): void {
  pick(section, "[data-mode]").find((b) => b.getAttribute("data-mode") === name)!.click();
}

/**
 * 打开流式开关。
 *
 * ⚠️ **必须自己先写 `.checked = true` 再触发 `change`**：`tests/helpers/fake-dom.ts`
 * 的 `.change()` 只派发事件，**不替你翻那个字段**（真实浏览器是先翻再派发）。
 * 这是替身**弱于**真实的一处，不是强于——所以这么写就是在照真实语义模拟。
 */
function turnOnStream(section: FakeElement): void {
  const box = one(section, ".pg-stream");
  box.checked = true;
  box.change();
}

/**
 * 三块正文 + `[DONE]` 的一段真实 SSE 字节，**openai 那条协议的形状**
 *（默认选中的就是它，真源里的第一条）。
 *
 * ⚠️ **逐字照着网关真吐出去的样子写**（`src/http/routes/openai.ts` 原样透传上游的
 * chat 增量块），不是自己编一个形状——编的那份与真字节可能不一样，
 * 而那正是第 7 种假阳性。这四行由 `tests/contract/stream-parity.test.ts` 的
 * 「一条真的流式请求，按 streamTextPath 逐块取出来的正是上游那三个字」跑真 app 交叉钉着。
 */
const SSE_THREE_CHUNKS = [
  'data: {"id":"c1","choices":[{"delta":{"content":"甲"}}]}',
  'data: {"id":"c1","choices":[{"delta":{"content":"乙"}}]}',
  'data: {"id":"c1","choices":[{"delta":{"content":"丙"}}]}',
  "data: [DONE]",
].map((l) => `${l}\n\n`).join("");

/**
 * 一条**先真的吐几块、然后断掉**的流（P3d Task 11 评审 F1/F4）。
 *
 * ⚠️ **必须用 `pull` 分两阶段，不能在同一个 `start` 里先 enqueue 再 error**：
 * 实测 `controller.error()` 会**清空队列**（Streams 规范如此），于是那几块在流那一层
 * 就没了、根本到不了被测代码 —— 那样这一格红的原因是**夹具**不对，不是实现不对。
 */
function brokenStream(texts: readonly string[]): ReadableStream<Uint8Array> {
  let i = 0;
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < texts.length) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: texts[i++] } }] })}\n\n`));
        return;
      }
      c.error(new Error("upstream went away"));
    },
  });
}

/**
 * ── **F2 的装置：流式那一轮渲染出来的节点形状是一个闭集** ──────────────────────
 *
 * ⚠️⚠️ **这个函数存在的理由是评审实测出来的，不是设计出来的。**
 * 原来守「流式不显示 token」的只有两条：一条**按字段名**的子串断言
 *（`.not.toContain("output_tokens")`）与一条 `.pg-no-tokens` 的**计数**断言。
 * 评审在 `onPayload` 里解析 `usage.output_tokens` 存进 turn、在 stream 分支多画一行
 * `` `Tokens: ${turn.tokens}` `` ⇒ **103/103 全绿**，屏幕上同时出现
 *「流式响应不带 token 用量…」与「**Tokens: 0**」。
 * 成因：子串断言只认得那一个字段名（换个标签就绕过），计数断言只挡**替换**、不挡**新增**。
 * ⇒ 判据改成**闭集**：这一轮里每一个元素的「标签 + class」必须逐条等于手写的那张表。
 * **新增任何一行**（不管它叫什么名字）都会让这一格红。
 */
function turnShape(sec: FakeElement): string[] {
  const turns = pick(sec, ".pg-turn");
  expect(turns.length, "这一格假定右栏恰好只有一轮").toBe(1);
  const out: string[] = [];
  for (const n of everyNode(turns[0]!)) {
    out.push(`${n.tagName}.${n.getAttribute("class") ?? ""}`);
  }
  return out;
}

/** 这一轮往对外那棵树发了几条。 */
function gatewayCalls(h: Harness) {
  return h.calls.filter((c) => c.url.startsWith(PANEL_ORIGIN));
}

/**
 * ── **「就地更新与整版重建输出逐字相同」的公用装置** ───────────────────────────
 *
 * ⚠️ **它在模块顶层，不在某一个 describe 里面**：本文件有**两处**就地更新
 *（轮询那一拍重填媒体盒子 + 状态码那一格；流式那一轮就地改 `<pre>` + 「掉了几块」那一行），
 * 两处栽的是**同一个**结构性 bug —— **就地更新的那个节点之外，还有一份会变的状态
 * 被渲染在别处**（复评 H2 与 G2 逐字同型）。抄第二份判据出来的话，
 * 两份一漂只有真机上看得见，而这个文件通篇在讲这件事。
 *
 * **方法**：把 Playground 板块整棵子树逐节点逐属性序列化
 *（tag / 全部属性 / `value` / `checked` / `disabled` / 自有文本 / 子树形状），
 * 再从**同一份模块状态**强制整版重建一次，序列化第二遍，两份逐字比对。
 *
 * ⚠️ **强制重建走的是真接线，不是去调一个内部函数**：`js/app.js:65` 写着
 * `current === name` 时只跑 `onShow()`、**不跑 `onHide()`**，
 * 而 `playgroundSection.onShow()` 在目录已经读到时就是一次 `render()`
 * ⇒ **再点一次当前那颗导航按钮** = 一次纯粹的整版重建，且在飞的那条不会被掐。
 *
 * ⚠️ **前置条件必须自己断言**：这一格全靠「重建那一下真的发生了」，
 * 而那件事在序列化结果里是不可见的（重建出来的字长得一样才是要证的东西）。
 * ⇒ 用**节点身份**当前置条件：重建之后那棵子树必须换成新对象。
 * 少了它，`navTo` 哪天不再触发 `onShow()`，这一格会静静退化成「自己跟自己比」。
 * **实测（复评 R-2/R-4）**：把 `js/app.js:65` 改成「不重建」⇒ 六格全红报「前置条件塌了」；
 * 改成「重建但顺带跑 `onHide()`」⇒ 六格全红在输出 diff 上。两种退化各有一条红线接着。
 */
function domShot(root: FakeElement): string {
  const lines: string[] = [];
  const walk = (n: FakeElement, path: string): void => {
    const attrs = [...n.attrs.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    // **只取自有文本**：子树文本由下面各行自己覆盖，一起取会把每个差异重复计一遍。
    const own = n.children.length === 0 ? n.textContent : "";
    lines.push([
      path, `<${n.tagName}>`, attrs,
      `value=${JSON.stringify(n.value)}`,
      `checked=${n.checked}`, `disabled=${n.disabled}`,
      `text=${JSON.stringify(own)}`,
    ].join(" | "));
    n.children.forEach((c, i) => { walk(c, `${path}/${i}:${c.tagName}`); });
  };
  walk(root, `0:${root.tagName}`);
  return lines.join("\n");
}

/**
 * 就地更新之后的屏幕 vs 从同一份状态整版重建之后的屏幕。
 *
 * ⚠️ **测试代码读 `.attrs` 是允许的**（它是 `fake-dom-parity.test.ts` 登记的 8 条
 * `FAKE_ONLY_MEMBERS` 之一，那张表管的是 `admin-ui/` 下的**发货代码**，不管测试）。
 * 排序属性名是为了让 diff 只反映真实差异，不反映插入顺序。
 */
function expectSameAsRebuild(h: Harness, sec: FakeElement, where: string): void {
  const inPlace = domShot(sec);
  const beforeNodes = pick(sec, ".pg-turn");
  navTo(h, "playground");   // `showSection` 在 current === name 时只跑 onShow() ⇒ 整版 render()
  const afterNodes = pick(sec, ".pg-turn");
  expect(afterNodes.length, `${where}：重建之后右栏一轮都不剩 —— 前置条件塌了`).toBe(beforeNodes.length);
  expect(beforeNodes.length, `${where}：右栏一轮都没有 —— 这一格什么都没比`).toBeGreaterThan(0);
  expect(
    afterNodes[0],
    `${where}：**前置条件塌了** —— 再点一次当前导航按钮没有触发整版重建，`
    + "这一格已经退化成自己跟自己比。去看 js/app.js 的 showSection()",
  ).not.toBe(beforeNodes[0]);
  expect(
    domShot(sec),
    `${where}：**就地更新与整版重建的输出不等价**。`
    + "轮询那一次正是在这里编出了一个状态码（`.pg-status` 画在 `.pg-media` 盒子外面，"
    + "就地重填够不着它）；流式那一次是漏说了「掉了几块」（`.pg-malformed` 画在 `<pre>` 外面）。"
    + "差异那一行的路径直接指出是哪一格 —— "
    + "要么把那一格也就地更新，要么这一拍别改它对应的那份状态",
  ).toBe(inPlace);
}

describe("左栏：档位与模型全部来自协议目录", () => {
  it("四条协议的分段按钮由响应生成，展示名是 label 不是裸 id —— 面板上写 id 等于让运维自己去猜", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    const bar = pick(sec, "[data-protocol]");
    // 期望值手写字面量（第 6 种假阳性：不从 `catalogPayload()` 推导）。
    expect(bar.map((b) => b.getAttribute("data-protocol")))
      .toEqual(["openai", "anthropic", "responses", "gemini"]);
    expect(bar.map((b) => b.textContent)).toEqual([
      "OpenAI Chat Completions", "Anthropic Messages", "OpenAI Responses", "Google Gemini generateContent",
    ]);
    // 默认停在第一档，且**整排**的选中态一起断言（只看被选中那一颗的话，
    // 「每一颗都 active」这种实现同样能通过 —— 第 5 种假阳性）。
    expect(bar.map((b) => b.classList.contains("active"))).toEqual([true, false, false, false]);
  });

  /**
   * **模型下拉只列这条协议上真的可用的。**
   * 变红条件：把 `buildModelSelect()` 里的 `modelIdsForProtocol(...)` 换成
   * `catalog.models.map((m) => m.id)` ⇒ 两个图片模型与一个视频模型会混进来，
   * 而选中它们只会换来一次注定失败的请求。
   */
  it("模型下拉里只有这条协议上可用的模型 —— 媒体模型一个都不许混进来", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    const opts = pick(one(sec, ".pg-model"), "option");
    expect(opts.map((o) => o.getAttribute("value"))).toEqual(["agnes-2.0-flash"]);
    expect(one(sec, ".pg-model").value).toBe("agnes-2.0-flash");
  });

  /**
   * ── **P3d Task 12：另两档不再是摆设** ────────────────────────────────────────
   *
   * Task 10 时图片 / 视频两档是 `disabled` 的（媒体那一半还没写），那一格断言的是
   * 「按不动」并逐字比对那句「暂时按不动」的 tooltip。**现在三档都是真的。**
   *
   * ⚠️ **只断言「能按」不算数**（第 4 种假阳性：形状断言冒充行为断言）：
   * 三个 `disabled` 都是 false 这件事，把 `MODES` 那张表里的 `mode` 全写成同一个词
   * 也照样成立。⇒ 这一格同时断言**换档之后左栏真的换了那条端点**——观测点落在
   * `.pg-media-endpoint` 那一行的文字上（它是 `buildRequest()` 现拼出来的那条地址，
   * 不是另拼的一份）。
   *
   * **变红条件（三条，逐条实测，见 progress note 的 M8/M9/M10）**：
   * ① 把 `MODES` 里 `video` 那行的 `mode` 改成 `image` ⇒ 视频档拼出来的是图片那条地址 ⇒ 红；
   * ② 把 `currentMediaEndpoint()` 里的 `m.op === "generate"` 改成 `m.op === "poll"`
   *    ⇒ 图片档挑不到端点（图片没有 poll 那一条）、视频档拼出来的是轮询那条 ⇒ 红；
   * ③ 把 `buildModeBar()` 里那句 `if (mode === m.mode) return;` 之后的 `render()` 删掉
   *    ⇒ 点了不重画 ⇒ 红。
   *
   * ⚠️ 地址期望值**手写整条字面量**（`PANEL_ORIGIN` 是夹具导出的探针值，
   * 路径那一半是手写的）——从 `catalogPayload()` 里取出来再回填就是第 6 种假阳性。
   */
  it("三个模式档都能选中，图片与视频各自真的挑到了自己那条端点 —— 形态名一漂就是一个永远空的档位", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    const modes = pick(sec, "[data-mode]");
    expect(modes.map((b) => b.getAttribute("data-mode"))).toEqual(["chat", "image", "video"]);
    expect(modes.map((b) => b.disabled), "三档里还有按不动的").toEqual([false, false, false]);
    // 对话档下**不该**出现媒体那一行说明（它是另一档的东西）。
    expect(pick(sec, ".pg-media-endpoint").length, "对话档下画出了媒体端点那一行").toBe(0);

    for (const [name, wanted] of [
      ["image", `POST ${PANEL_ORIGIN}/v1/images/generations`],
      ["video", `POST ${PANEL_ORIGIN}/v1/videos`],
    ] as const) {
      pick(sec, "[data-mode]").find((b) => b.getAttribute("data-mode") === name)!.click();
      await settle();
      expect(one(sec, ".pg-media-endpoint").textContent, `${name} 档挑到的端点不对`).toBe(wanted);
      // 换档之后协议分段与流式开关都不该还在：媒体那两条端点不属于任何一条对话协议、
      // 也没有流式形态，留着它们就是两个按了没用的控件。
      expect(pick(sec, "[data-protocol]").length, `${name} 档下还画着协议分段`).toBe(0);
      expect(pick(sec, ".pg-stream").length, `${name} 档下还画着流式开关`).toBe(0);
      expect(
        pick(sec, "[data-mode]").find((b) => b.getAttribute("data-mode") === name)!.getAttribute("aria-pressed"),
        `${name} 档按下去了但 aria-pressed 没跟着走 —— 读屏用户看不出当前在哪一档`,
      ).toBe("true");
    }
  });

  /**
   * **P3d Task 11：这个开关不再是摆设。**
   *
   * Task 10 时它是 `disabled` 的（读流那一半还没写），那一格断言的是「按不动」。
   * **现在它是真的能按的**，而「按下去之后真的发的是流式请求」由下面
   * 「打开流式开关之后，发出去的请求体里真的带着流式那一格」那一格钉着
   * ——**只断言这里能按不算数**（第 4 种假阳性：形状断言冒充行为断言）。
   */
  it("流式开关能按，且 tooltip 说清它做什么 —— Task 10 时它是摆设，现在不是了", async () => {
    const h = await openPg(respondWith());
    const box = one(h.section("playground"), ".pg-stream");
    expect(box.disabled, "开关还是按不动的").toBe(false);
    // 期望值手写整句：`toContain` 在别的文案里也可能是子串。
    expect(box.getAttribute("title"))
      .toBe("打开后回答会一块一块地到，右栏边收边显示；这一档不统计 token。");
  });

  /**
   * **换协议要重挑模型。**
   * 变红条件：把 `buildProtoBar()` 里换协议时那句 `modelId = "";` 删掉 ⇒
   * 上一条协议上选中的模型会跟着进到新协议里，而它未必在那条协议上可用。
   */
  it("换一条协议之后模型下拉跟着重挑 —— 上一条协议上可用的模型未必在这一条上也可用", async () => {
    const h = await openPg(respondWith({
      catalog: {
        status: 200,
        body: {
          protocols: [
            {
              id: "alpha", label: "Alpha", method: "POST", pathTemplate: "/probe/alpha",
              authHeader: "authorization", streamMode: "body", streamKey: "stream",
              streamTextPath: ["delta"],
              sampleBody: { model: "m0", input: "ping" },
            },
            {
              id: "delta", label: "Delta", method: "POST", pathTemplate: "/probe/delta",
              authHeader: "x-api-key", streamMode: "body", streamKey: "stream",
              streamTextPath: ["delta"],
              sampleBody: { model: "m0", input: "ping" },
            },
          ],
          models: [
            { id: "only-alpha", modality: "chat", protocols: ["alpha"], endpoints: [] },
            { id: "only-delta", modality: "chat", protocols: ["delta"], endpoints: [] },
          ],
          // 这一格是 P3d Task 12 加的。**空数组不是「省事」**：这份合成目录里一条媒体
          // 模型都没有，给它编两条媒体端点会让这一格顺带断言起媒体那一档，
          // 而它问的是「换协议之后模型下拉跟不跟着重挑」。**缺了这一格整份判成读不出来**
          // （`mediaEndpoints()` 的约定），所以它必须在，只是内容为空。
          media: [],
          samplePrompt: "ping",
        },
      },
    }));
    const sec = h.section("playground");
    expect(one(sec, ".pg-model").value, "前置条件：默认档下选中的是 alpha 那个模型").toBe("only-alpha");

    pick(sec, "[data-protocol]").find((b) => b.getAttribute("data-protocol") === "delta")!.click();
    await settle();

    expect(pick(one(sec, ".pg-model"), "option").map((o) => o.getAttribute("value")))
      .toEqual(["only-delta"]);
    expect(one(sec, ".pg-model").value, "换协议之后还停在上一条协议的模型上").toBe("only-delta");
  });

  /**
   * **读不出来 ≠ 一条协议都没有。**
   * 变红条件：把 `loadCatalog()` 的 `catch` 分支改成
   * `catalog = { protocols: [], models: [] };` ⇒ 一排空档位会被读成
   * 「这个网关一条协议都没有」，而事实是我们**不知道**（全局约束 9 的同型）。
   */
  it("协议目录读不出来时不画一个空的协议选择器，而是红条 + 再读一次 + 一句说清是哪一档", async () => {
    const h = await openPg(respondWith({ catalog: { status: 500, body: {} } }));
    const sec = h.section("playground");
    expect(pick(sec, "[data-protocol]").length, "读不出来却画了一排空档位").toBe(0);
    expect(pick(sec, ".pg-send").length, "读不出来却画了一颗能按的发送按钮").toBe(0);
    const banner = pick(sec, ".banner-danger");
    expect(banner.length).toBe(1);
    expect(banner[0]!.getAttribute("role"), "读屏用户收不到「读取失败」这条信号").toBe("status");
    expect(pick(sec, ".pg-retry").length, "没有再读一次的入口").toBe(1);
    // 期望值手写整句。
    expect(one(sec, ".pg-unknown").textContent)
      .toBe("协议目录读不出来，所以这里什么都配不了——不是这个网关一条协议都没有。");
  });

  /**
   * ── **响应回得来、但形状不对，与 HTTP 失败落在同一档** ────────────────────────
   *
   * ⚠️⚠️ **这一格是变异实测补出来的，不是想出来的。**
   * 上一版只有上面那个 HTTP 500 的用例，而 500 走的是 `load()` 的 **catch** 分支
   * ——`try` 里那句「窄化交出 `null` 就整份判成读不出来」的三元**一次都没被跑到**。
   * 实测：把它改成 `catalog = { protocols: protocols || [], models: models || [] };`
   * ⇒ **22/22 全绿**。⭐ 记一条形状：**两个不同的失败落在同一档时，
   * 用例必须两条路径各走一遍**——只走一条的话，另一条上的判据是零覆盖的。
   *
   * 少了这一半的后果：一份被中间件改过形状的响应会画出一个**结构自洽而内容缺斤少两**
   * 的左栏（一排空档位 + 一个空模型下拉），运维读到的是「这个网关一条协议都没有」。
   *
   * **变红条件**：把 `loadCatalog()` 里那句三元改成
   * `catalog = { protocols: protocols || [], models: models || [] };`。
   */
  it("响应读得回来但形状不对时同样是「读不出来」 —— 不是画一排空的协议档位", async () => {
    const h = await openPg(respondWith({
      catalog: { status: 200, body: { protocols: "not an array", models: [] } },
    }));
    const sec = h.section("playground");
    expect(pick(sec, ".pg-unknown").length, "形状不对却没有走「读不出来」那一档").toBe(1);
    expect(pick(sec, ".banner-danger").length, "形状不对却没有任何红色信号").toBe(1);
    expect(pick(sec, "[data-protocol]").length, "形状不对却画了一排空档位").toBe(0);
    expect(pick(sec, ".pg-model").length, "形状不对却画了一个空的模型下拉").toBe(0);
  });

  it("错误横幅上那颗「再读一次」真的重发请求，成功之后左栏就出来了", async () => {
    const h = await openPg(respondWith({ catalog: { status: 500, body: {} } }));
    const sec = h.section("playground");
    const before = h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length;

    h.respond(respondWith());
    one(sec, ".pg-retry").click();
    await settle(20);

    expect(h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length).toBe(before + 1);
    expect(pick(sec, "[data-protocol]").length).toBe(4);
  });
});

describe("网关口令：粘贴、就地校验、绝不外泄", () => {
  /**
   * ── **全局约束 11(b) 在面板这一侧的执行机构** ──────────────────────────────
   *
   * **这是面板上第一个会带着网关口令去打对外那棵树的东西**，而那把口令是发给
   * **每一个下游用户**的中转口令。它只许出现在两个地方：那个 `<input>` 的 `.value`，
   * 和 `js/gw-api.js` 拼请求头的那一行。
   *
   * ⚠️ 扫的是**整页**（`h.dom.document.body`）的全部属性值与渲染文本，只放过那个输入框
   * 自己的 `.value`。**扫描面与三个调用点的理由见 `expectNoTokenAnywhere()` 上方那段。**
   *
   * **变红条件（逐条都是最自然的写法，且都实测过落在哪一档）**：
   * · 把 `syncSendButton()` 的 tooltip 写成 `t(key) + token` ⇒ **三档全红**（属性那条）；
   * · 给口令输入框加一个 `data-value` / `title` 之类的调试属性 ⇒ 三档全红；
   * · 把 `sendOnce()` 的 `catch` 分支改成把 `e.message` 或整份请求头画出来
   *   ⇒ **只红「传输失败」那一档**；
   * · 把请求头渲染进右栏那一轮 ⇒ **只红「成功」那一档**
   *   （`buildTurn()` 在 `errorKey !== null` 时提前 return，失败那两档根本走不到响应体那一段）；
   * · 把口令拼进 `toast()` ⇒ 三档全红，**而上一版只扫板块子树时它 23/23 全绿**。
   */
  it("面板上任何一处都不出现网关口令 —— 输入框的值不许漏进标题、属性或任何一句错误文案", async () => {
    // ── 档 ①：**成功**。响应体那一段只有走到这里才被渲染过。 ──
    const ok = await openPg(respondWith());
    const okSec = ok.section("playground");
    pasteToken(okSec, GW_TOKEN);
    typePrompt(okSec, "你好");
    one(okSec, ".pg-send").click();
    await settle(20);
    expect(pick(okSec, ".pg-body").length, "前置条件：成功那一档得真的把响应体画出来").toBe(1);
    expect(one(okSec, ".pg-token").value, "前置条件：口令确实在输入框里").toBe(GW_TOKEN);
    expectNoTokenAnywhere(ok, "成功档");

    // ── 档 ②：**传输失败**。错误文案是口令最自然的泄漏口。 ──
    vi.unstubAllGlobals();
    const bad = await openPg(respondWith({ gateway: () => { throw new Error("boom"); } }));
    const badSec = bad.section("playground");
    pasteToken(badSec, GW_TOKEN);
    typePrompt(badSec, "你好");
    one(badSec, ".pg-send").click();
    await settle(20);
    expect(pick(badSec, ".pg-error").length, "前置条件：这一次得真的失败").toBe(1);
    expectNoTokenAnywhere(bad, "传输失败档");

    // ── 档 ③：**构造失败**（目录的样例形状与面板对不上）。它连请求都没发出去，
    //    而那一档的文案同样是本地拼的 —— 同样是一条泄漏口。 ──
    vi.unstubAllGlobals();
    const drift = await openPg(respondWith({
      catalog: {
        status: 200,
        body: {
          protocols: [{
            id: "alpha", label: "Alpha", method: "POST", pathTemplate: "/probe/alpha",
            authHeader: "authorization", streamMode: "body", streamKey: "stream",
            streamTextPath: ["delta"],
            // 占位文本漂了 ⇒ `withPrompt()` 交出 `null` ⇒ `pg.err.buildFailed`。
            sampleBody: { model: "m0", input: "drifted-sample" },
          }],
          models: [{ id: "m-alpha", modality: "chat", protocols: ["alpha"], endpoints: [] }],
          media: [],
          samplePrompt: "ping",
        },
      },
    }));
    const driftSec = drift.section("playground");
    pasteToken(driftSec, GW_TOKEN);
    typePrompt(driftSec, "你好");
    one(driftSec, ".pg-send").click();
    await settle(20);
    expect(pick(driftSec, ".pg-error").length, "前置条件：构造失败那一档得真的走到").toBe(1);
    expect(
      drift.calls.filter((c) => c.url.startsWith(PANEL_ORIGIN)),
      "构造失败那一档不该发出任何请求",
    ).toEqual([]);
    expectNoTokenAnywhere(drift, "构造失败档");

    // ── 档 ④：**流式**（P3d Task 11 加的第四档）。Task 10 交接明写「流式那条路是新的
    //    一档 —— 自己加进去」。它是**另一条渲染路径**（不走 `prettyJson`，走增量拼接
    //    + malformed 计数 + 那句「不统计 token」），三档全绿不代表这一档也绿。 ──
    vi.unstubAllGlobals();
    const st = await openPg(respondWith({
      gateway: () => ({ status: 200, body: null, raw: SSE_THREE_CHUNKS }),
    }));
    const stSec = st.section("playground");
    pasteToken(stSec, GW_TOKEN);
    typePrompt(stSec, "你好");
    turnOnStream(stSec);
    one(stSec, ".pg-send").click();
    await settle(40);
    // 前置条件两条：这一次**真的走了流式那条路**，而且口令确实在输入框里。
    expect(one(stSec, ".pg-stream-text").textContent, "前置条件：流式那一档得真的拼出正文").toBe("甲乙丙");
    expect(one(stSec, ".pg-token").value, "前置条件：口令确实在输入框里").toBe(GW_TOKEN);
    expectNoTokenAnywhere(st, "流式档");

    // ── 档 ⑤：**流式中途断掉 + 带畸形块**（评审 F4）。档④只走了流式的**成功**那条路
    //    ⇒ 流式的**失败**渲染（`pg-error` / `pg-malformed`）从头到尾没被这道扫描跑过。
    //    评审在那一段上种 `title="stream aborted; auth=${token}"` ⇒ 103/103 全绿。 ──
    vi.unstubAllGlobals();
    const brk = await openPg(respondWith({
      gateway: () => ({
        status: 200,
        body: null,
        raw: (() => {
          // 一块正文 → 一块读不出来的 → 断掉。三条失败相关的渲染路径一次全走到。
          const lines = [
            'data: {"id":"c1","choices":[{"delta":{"content":"甲"}}]}\n\n',
            "data: {这一块不是合法 JSON\n\n",
          ];
          let i = 0;
          return new ReadableStream<Uint8Array>({
            pull(c) {
              if (i < lines.length) { c.enqueue(new TextEncoder().encode(lines[i++]!)); return; }
              c.error(new Error("upstream went away"));
            },
          });
        })(),
      }),
    }));
    const brkSec = brk.section("playground");
    pasteToken(brkSec, GW_TOKEN);
    typePrompt(brkSec, "你好");
    turnOnStream(brkSec);
    one(brkSec, ".pg-send").click();
    await settle(60);
    // 三条前置条件：**三种**失败相关的渲染都真的走到了，这一档才不是空转。
    expect(one(brkSec, ".pg-stream-text").textContent, "前置条件：断掉之前那一块得留着").toBe("甲");
    expect(pick(brkSec, ".pg-malformed").length, "前置条件：畸形那一行得真的画出来").toBe(1);
    expect(pick(brkSec, ".pg-error").length, "前置条件：断流那一行得真的画出来").toBe(1);
    expect(one(brkSec, ".pg-token").value, "前置条件：口令确实在输入框里").toBe(GW_TOKEN);
    expectNoTokenAnywhere(brk, "流式中途断掉档");

    // ── 档 ⑥：**流式撞上 401 降级**（`streamed:false`）。它走的是**非流式那条渲染路径**，
    //    但进来的是一轮流式 —— 又是一条档④覆盖不到的组合。 ──
    vi.unstubAllGlobals();
    const dg = await openPg(respondWith({
      gateway: () => ({ status: 401, body: { error: { message: "PROBE-UNAUTHORIZED" } } }),
    }));
    const dgSec = dg.section("playground");
    pasteToken(dgSec, GW_TOKEN);
    typePrompt(dgSec, "你好");
    turnOnStream(dgSec);
    one(dgSec, ".pg-send").click();
    await settle(40);
    expect(one(dgSec, ".pg-status").textContent, "前置条件：这一轮得真的降级到 401").toBe("401");
    expect(pick(dgSec, ".pg-stream-text").length, "前置条件：降级那一档不该走 stream 渲染").toBe(0);
    expect(one(dgSec, ".pg-token").value, "前置条件：口令确实在输入框里").toBe(GW_TOKEN);
    expectNoTokenAnywhere(dg, "流式降级 401 档");

    // ── 档 ⑦：**媒体** —— **不在这一格里**，在下面那一格
    //    「媒体那几个渲染函数里这道判据认得出的每一个出口，都被口令扫描跑过 —— 覆盖面按出口数算，不按用例数算；认不出的那几条射程写在 mediaOutputsInSource() 上方（评审 H1）」。
    //    ⚠️⚠️ **它为什么被搬出去，是评审 H1 的落点，写清楚**：媒体那条渲染路径
    //    （`buildMediaResult()` / `fillMediaResult()`）有 **17 个出口**，而本格这种「一档一段直写」的写法
    //    第一版只走到其中 **2** 个（结果行与错误行）——评审往任务标识那一行与轮询进度那一行
    //    各种一次口令，**905 passed，两次都 ESCAPED**。
    //    ⚠️ 而 `.pg-poll` 是真实视频任务里**在屏幕上停留最久的那一行（最长 5 分钟）**，
    //    `.pg-task-id` 是**唯一会被运维复制粘贴出去的那一行** —— 两处正是
    //    「排查方便点」最容易把口令拼进去的位置。
    //    ⇒ 搬出去之后那一格按**出口清单**逐个走，而**出口清单本身是从代码里扫出来的**，
    //    加了新出口却没覆盖会当场红。它还要装假定时器（轮询那几个出口只有推时钟才到得了），
    //    塞进本格会把本格已有的六档一起拖进假定时器语义里。
  });

  /**
   * **口令存的是与管理口令分开的那个键。**
   * 变红条件：把 `writeGatewayToken()` 里的 `GW_KEY_STORE` 换成 `KEY_STORE`
   * ⇒ 粘一次网关口令就把管理会话顶掉，面板下一个请求 401、当场登出。
   */
  it("粘进去的口令存在自己那个键上，管理口令那格一个字都不动", async () => {
    const h = await openPg(respondWith());
    pasteToken(h.section("playground"), GW_TOKEN);
    await settle();
    expect(h.store[GW_KEY_STORE]).toBe(GW_TOKEN);
    expect(h.store[KEY_STORE], "粘网关口令把管理口令覆盖掉了").toBe(TOKEN);
  });

  /**
   * ── **M2：登出必须把网关口令一起清掉（控制端裁定）** ────────────────────────
   *
   * `js/pure/session.mjs` 的文件头把「localStorage 里放的是原始 `ADMIN_TOKEN`，
   * 无过期、无登出、产品内无撤销路径」当成设 `SESSION_MAX_AGE_MS` 的**理由**
   * ——也就是说，这个项目已经把「一把这样存着的口令」判定成需要缓解的问题。
   * 而网关口令**比它还弱**（没有年龄上限、后端也没有撤销路径）。
   * **再往同一块存储里加一把更弱的、还不跟着登出清掉的，是严格变差。**
   *
   * 具体后果很朴素：共享 / 投屏的机器上，登出之后下一个人登录进来，
   * Playground 的口令框是**预填好的**。
   *
   * ⚠️ **两处缺一不可，这一格同时钉着两处**：
   * ① `js/app.js` 的 `store("del")` 要清存储；
   * ② `js/sec-playground.js` 的 `onShow()` 要**每次重新从存储读**
   *    ——登出不 reload、板块也不会重新 `init()`，模块变量里那把口令会活过一次登出。
   *
   * **变红条件（各打掉一处，各自都会红）**：
   * · 删掉 `app.js` 里那行 `localStorage.removeItem(GW_KEY_STORE);` ⇒ 第一条断言红；
   * · 把 `sec-playground.js` 的 `onShow()` 里那句 `token = readGatewayToken();` 删掉
   *   ⇒ 存储清了、而输入框里那把还在 ⇒ 最后一条断言红。
   */
  it("退出登录会一并清掉网关口令，重新登录之后那个框是空的 —— 共享机器上它本来是预填好的", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    await settle();
    // 前置条件：先得真的存进去、也真的显示出来。
    expect(h.store[GW_KEY_STORE], "前置条件：口令得先真的存进去").toBe(GW_TOKEN);
    expect(one(sec, ".pg-token").value).toBe(GW_TOKEN);

    h.dom.byId("logout-btn").click();
    await settle(20);

    // ① 存储里那一把没了（与管理口令那两个键一起）。
    expect(h.store[GW_KEY_STORE], "登出之后网关口令还留在浏览器里").toBeUndefined();
    expect(h.store[KEY_STORE], "前置条件：管理口令那两个键本来就该被清").toBeUndefined();
    expect(h.store[SAVED_AT_STORE]).toBeUndefined();

    // ② 下一个人登录进来：口令框必须是空的。
    //    **走完整的重新登录，不是直接调板块方法**——模块变量活过登出正是这一格要抓的东西。
    h.input.value = TOKEN;
    h.form.submit();
    await settle(20);
    expect(h.shell.classList.contains("on"), "前置条件：得真的重新登录成功").toBe(true);
    expect(
      one(h.section("playground"), ".pg-token").value,
      "登出之后上一个人的网关口令还留在输入框里",
    ).toBe("");
  });

  it("刷新之后口令从浏览器里回填 —— 存了却不读等于每次都要重粘", async () => {
    const h = await openPg(respondWith(), { [GW_KEY_STORE]: GW_TOKEN });
    expect(one(h.section("playground"), ".pg-token").value).toBe(GW_TOKEN);
  });

  /**
   * **hint 校验三档各自成立，且「比不了」与「对不上」画的是两句不同的话。**
   * 变红条件：把 `hintNoteKey()` 里 `unknown` 与 `mismatch` 两支取同一个 key
   * ⇒ 读不到配置时运维会以为自己粘错了，去改一把其实没错的口令
   * （第 1 种假阳性的反面：两支必须给出**不同**的值才验得到）。
   */
  it("口令末位与设置页对得上时说「一致」，对不上说「对不上」，读不到 hint 说「比不了」", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    // 还没粘。
    expect(one(sec, ".pg-hint").textContent).toBe("还没粘口令");
    // 末四位与 hint（wxyz）一致。
    pasteToken(sec, GW_TOKEN);
    expect(one(sec, ".pg-hint").textContent).toBe("末位与设置页里配的那把一致");
    expect(one(sec, ".pg-hint").classList.contains("pg-hint-ok")).toBe(true);
    // 换一把末位不同的。
    pasteToken(sec, "gateway-token-0123456789-0000");
    expect(one(sec, ".pg-hint").textContent).toBe("末位与设置页里配的那把对不上");
    expect(one(sec, ".pg-hint").classList.contains("pg-hint-bad")).toBe(true);
  });

  /**
   * ── **L3：`/config` 失败一次之后，hint 校验不许在整个会话里永远停在「比不了」** ──
   *
   * `hintAsked` 是个一次性闸（目录与 hint 都是这次会话里不会变的东西，不该每次切回来重问）。
   * 但它一旦在**失败**那一次被置真，`loadHint()` 就再也不会跑
   * ⇒ **按了「再读一次」也不恢复**，而那颗按钮的语义正是「把这个板块读不到的东西再读一次」。
   *
   * **变红条件**：把 `buildUnavailable()` 里 `retry` 那个 handler 里的
   * `hintAsked = false; loadHint();` 两行删掉。
   */
  it("目录与 hint 一起失败时，按「再读一次」两样都重读 —— 否则 hint 校验会在整个会话里停在「比不了」", async () => {
    const h = await openPg(respondWith({
      catalog: { status: 500, body: {} },
      config: { status: 500, body: {} },
    }));
    const sec = h.section("playground");
    const configCalls = () => h.calls.filter((c) => c.url.startsWith("/admin/api/config")).length;
    expect(configCalls(), "前置条件：第一次显示时问过一次").toBe(1);

    h.respond(respondWith());
    one(sec, ".pg-retry").click();
    await settle(20);

    expect(configCalls(), "「再读一次」只重读了目录，hint 那一次没有跟着重问").toBe(2);
    // 而且它真的恢复了：粘一把末位对得上的口令，说的是「一致」而不是「比不了」。
    pasteToken(sec, GW_TOKEN);
    expect(one(sec, ".pg-hint").textContent).toBe("末位与设置页里配的那把一致");
  });

  it("读不到设置页的 hint 时说的是「比不了」，不是「对不上」 —— 后者会让人去改一把其实没错的口令", async () => {
    const h = await openPg(respondWith({ config: { status: 500, body: {} } }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    expect(one(sec, ".pg-hint").textContent)
      .toBe("读不到设置页里的末位提示，这次比不了");
    expect(one(sec, ".pg-hint").classList.contains("pg-hint-bad"), "把「比不了」画成了「对不上」").toBe(false);
  });
});

describe("发送：真的打出去那一条，以及它的在途护栏", () => {
  /**
   * **一次成功的往返：地址来自目录，凭据是网关口令，管理口令一个字节都没跟着走。**
   *
   * 观测点全部落在**被桩掉的 `fetch` 收到了什么**上（第 5 条方法论）。
   */
  it("按一下发送：打的是目录给的那条地址，带的是网关口令，且没有 x-admin-key", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    one(sec, ".pg-send").click();
    await settle(20);

    const calls = gatewayCalls(h);
    expect(calls.length, "按了发送却没有真的发出去").toBe(1);
    // 期望值手写字面量：这一条就是 OpenAI 那条对外地址。
    expect(calls[0]!.url).toBe(`${PANEL_ORIGIN}/v1/chat/completions`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${GW_TOKEN}`);
    expect(Object.keys(calls[0]!.headers).sort(), "对外请求的请求头里多了一个")
      .toEqual(["authorization", "content-type"]);
    // 用户那句话真的进了请求体（期望值手写整份）。
    expect(calls[0]!.body).toEqual({
      model: "agnes-2.0-flash",
      messages: [{ role: "user", content: "你好" }],
    });
    // 右栏画出了响应原文。
    expect(one(sec, ".pg-body").textContent).toContain("PONG-FROM-UPSTREAM");
    expect(one(sec, ".pg-status").textContent).toBe("200");
  });

  /**
   * ── **在飞去重（全局约束 14 的护栏之一）** ──────────────────────────────────
   *
   * ⚠️ **这一格钉的是 `sendBlockedKey()` 的第一档（`inFlight`），不是 `disabled`。**
   * 夹具里点一颗 disabled 的按钮**照样会触发监听器**（真实浏览器不会），
   * 所以「按钮变灰」在这里只验得到属性、验不到「点不动」——
   * 见文件头那段替身能力核对。**两件事各有各的观测点，别把它们混成一条。**
   *
   * ⚠️⚠️ **上一版这段话指错了地方，是变异实测纠正的**：当时 `sendOnce()` 开头另有一句
   * `if (inFlight) return;`，这段话声称本格钉的是它——而**把那句删掉，22/22 全绿**
   * （`sendBlockedKey()` 的第一档已经把同一件事挡住了）。那句冗余已删，这段话已改真。
   * ⭐ 记一条形状：**「哪一格钉着哪一行」这种话，写下之前先把那一行删一次试试。**
   *
   * 变红条件：把 `sendBlockedKey()` 里那句 `if (inFlight) return "pg.send.blockedInFlight";` 删掉
   * ⇒ 连点三下就是三次真打上游。
   */
  it("在飞时再点一次发送：不许发出第二条 —— 这一格钉的是代码里那句早退，不是按钮的灰", async () => {
    let release: ((r: Resp) => void) | null = null;
    const h = await openPg(respondWith({
      // **替身带一个真实的挂起点**（第 8 种假阳性：零延迟的替身让时序性质整个不可观测）。
      gateway: () => new Promise<Resp>((resolve) => { release = resolve; }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    one(sec, ".pg-send").click();
    await settle(20);
    expect(gatewayCalls(h).length, "前置条件：第一条得真的飞出去了").toBe(1);

    // 按钮确实变灰了（给人看的那一道）。
    expect(one(sec, ".pg-send").disabled, "在飞时发送按钮没有变灰").toBe(true);
    // 再点两下：**一条都不许多**（真正起作用的那一道）。
    one(sec, ".pg-send").click();
    one(sec, ".pg-send").click();
    await settle(20);
    expect(gatewayCalls(h).length, "在飞时又打了上游 —— 那句早退没了").toBe(1);

    // 在飞时必须有取消入口，否则一条挂住的请求会把这个板块钉死。
    expect(pick(sec, ".pg-cancel").length, "在飞时没有取消入口").toBe(1);

    release!({ status: 200, body: { reply: "PONG-FROM-UPSTREAM" } });
    await settle(20);
    expect(one(sec, ".pg-send").disabled, "回来之后按钮没有解灰").toBe(false);
    expect(pick(sec, ".pg-cancel").length, "回来之后取消按钮还留着").toBe(0);
  });

  /**
   * ── **取消令牌：被取消的那一次，晚到的结果不许落进对话** ──────────────────────
   *
   * ⚠️⚠️ **abort 那一半在这里天然不可观测，如实写明**：`tests/ui/dom/harness.ts` 的
   * `fetch` 替身**零处**看 `signal` ⇒ 被 abort 的那条链照样会 resolve。
   * **所以这一格钉的不是 `ctl.abort()`，是「这一次还是不是当前那一次」那个身份比较**
   * （`sendOnce()` 里三处 `if (current !== ctl) return;`）。
   * 真实浏览器里 abort 让那条链以 `AbortError` 拒绝，同一条判据同样把它挡在外面
   * ——两种环境走的是同一条判据，只是触发路径不同。
   *
   * 变红条件：删掉 `sendOnce()` 里那三处身份比较中的任意一处。
   */
  it("点取消之后，那一次晚到的成功不许落进对话 —— abort 不可观测，钉的是「还是不是当前那一次」", async () => {
    let release: ((r: Resp) => void) | null = null;
    const h = await openPg(respondWith({
      gateway: () => new Promise<Resp>((resolve) => { release = resolve; }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    one(sec, ".pg-send").click();
    await settle(20);
    expect(pick(sec, ".pg-cancel").length, "前置条件：得先有那颗取消按钮").toBe(1);

    one(sec, ".pg-cancel").click();
    await settle(20);
    expect(one(sec, ".pg-send").disabled, "取消之后按钮没有解灰").toBe(false);

    // 被取消的那一次**在这之后**才落地。
    release!({ status: 200, body: { reply: "LATE-AND-CANCELLED" } });
    await settle(20);

    expect(sec.textContent, "被取消的那一次晚到的结果落进了对话").not.toContain("LATE-AND-CANCELLED");
    expect(pick(sec, ".pg-turn").length, "被取消的那一次凭空长出了一轮对话").toBe(0);
  });

  /**
   * **切走板块 = 作废在飞的那一次**（护栏的第二个入口）。
   * 变红条件：把 `onHide()` 里的 `cancelInFlight()` 删掉 ⇒ 一条切走之后才回来的响应
   * 会在一个用户已经离开的板块上留下一轮对话，并把按钮解灰。
   */
  it("切走板块之后，在飞那一次晚到的结果同样不许落进对话", async () => {
    let release: ((r: Resp) => void) | null = null;
    const h = await openPg(respondWith({
      gateway: () => new Promise<Resp>((resolve) => { release = resolve; }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    one(sec, ".pg-send").click();
    await settle(20);
    expect(gatewayCalls(h).length, "前置条件：得真的飞出去一条").toBe(1);

    navTo(h, "overview");
    await settle(20);
    release!({ status: 200, body: { reply: "LATE-AFTER-LEAVE" } });
    await settle(20);
    navTo(h, "playground");
    await settle(20);

    expect(sec.textContent, "切走之后晚到的结果还是落进了对话").not.toContain("LATE-AFTER-LEAVE");
    expect(pick(sec, ".pg-turn").length).toBe(0);
  });

  /**
   * ── **刻意没有最小间隔闸，这条差别本身要被钉住** ───────────────────────────
   *
   * Key 池的验活有一道 3 秒闸（`VERIFY_MIN_INTERVAL_MS`）。**Playground 不加**：
   * 它是交互式调试工具，运维改一句提示词连发几次是正常用法，而每一次都是他自己
   * 坐在那儿等结果（有在飞去重兜着）。
   *
   * ⚠️ **`Date.now()` 在这一组里被钉死在 `NOW`**（`bootPanel({ now })`）⇒
   * 任何基于时间差的闸在这一格里都会把第二次挡下来。
   * **这一格因此是「下一个人照着 `probe-guard` 补一道 3 秒闸」的绊线。**
   */
  it("一次回来之后立刻再发一次照样发得出去 —— Playground 刻意没有最小间隔闸", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "第一句");
    one(sec, ".pg-send").click();
    await settle(20);
    expect(gatewayCalls(h).length, "前置条件：第一次得真的发出去").toBe(1);

    typePrompt(sec, "第二句");
    one(sec, ".pg-send").click();
    await settle(20);

    expect(gatewayCalls(h).length, "第二次被一道最小间隔闸挡下了 —— 那是照抄验活的护栏").toBe(2);
    // 两轮都在，且第二轮送的是第二句（不是把第一句重发一遍）。
    expect(pick(sec, ".pg-turn").length).toBe(2);
    expect(gatewayCalls(h)[1]!.body).toEqual({
      model: "agnes-2.0-flash",
      messages: [{ role: "user", content: "第二句" }],
    });
  });

  /**
   * **没粘口令时根本不发，而且理由与「口令错」不是同一句。**
   * 变红条件：把 `sendBlockedKey()` 里 `token === ""` 那一支删掉
   * ⇒ 一次注定 401 的请求会被真的发出去，运维读到的是「上游拒绝了」。
   */
  it("没粘口令时按发送：一个字节都不发，且给的理由是「先粘贴口令」而不是一次 401", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    typePrompt(sec, "你好");
    one(sec, ".pg-send").click();
    await settle(20);

    expect(gatewayCalls(h), "没粘口令还是把请求发出去了").toEqual([]);
    expect(one(sec, ".pg-send").disabled).toBe(true);
    // 期望值手写整句。
    expect(one(sec, ".pg-send").getAttribute("title")).toBe("先粘贴网关口令。");
  });

  it("没写提示词时同样不发，且理由与「没粘口令」是两句不同的话", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    one(sec, ".pg-send").click();
    await settle(20);
    expect(gatewayCalls(h)).toEqual([]);
    expect(one(sec, ".pg-send").getAttribute("title")).toBe("先写一句提示词。");
  });

  /**
   * **上游 4xx 是一条真信号，照常画出来。**
   * 少了这一格的话，把 `sendToGateway()` 的非 2xx 也改成抛错，运维会看到
   * 「这次请求没有拿到任何响应」——一句把「上游明确拒绝了你」说成「网络坏了」的假话。
   */
  it("上游回 401 时画的是那次响应本身，不是「没有拿到任何响应」 —— 两者是完全不同的诊断", async () => {
    const h = await openPg(respondWith({
      gateway: () => ({ status: 401, body: { error: { message: "invalid gateway token" } } }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    one(sec, ".pg-send").click();
    await settle(20);

    expect(one(sec, ".pg-status").textContent).toBe("401");
    expect(one(sec, ".pg-body").textContent).toContain("invalid gateway token");
    expect(pick(sec, ".pg-error").length, "一次明确的 401 被画成了传输失败").toBe(0);
  });
});

describe("网络面：这个板块到底打了哪几条端点", () => {
  /**
   * **两条 admin 端点，一条不多。**
   * 少了这一格的话，哪天有人顺手在这里加一条「顺便拉一下 capabilities」，
   * 一个每次进来只读两次的板块就悄悄变成了三次网络往返。
   */
  it("整个板块只打 /admin/api/models 与 /admin/api/config —— 别在这里顺手多拉一份别的", async () => {
    const h = await openPg(respondWith());
    const urls = new Set<string>();
    for (const c of h.calls) urls.add(c.url);
    urls.delete("/admin/api/session");
    expect([...urls].sort()).toEqual(["/admin/api/config", "/admin/api/models"]);
  });

  /**
   * **目录是静态的，成功读过一次就不再读。**
   * 变红条件：把 `onShow()` 里 `if (catalog !== null) { render(); return; }` 删掉
   * ⇒ 每切回来一次就多两次网络往返。
   */
  it("切走再切回来不会重读目录、也不会重问 hint —— 两份都是这次会话里不会变的东西", async () => {
    const h = await openPg(respondWith());
    const count = () => ({
      models: h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length,
      config: h.calls.filter((c) => c.url.startsWith("/admin/api/config")).length,
    });
    expect(count(), "前置条件：第一次显示时各读一次").toEqual({ models: 1, config: 1 });

    navTo(h, "overview");
    await settle(20);
    navTo(h, "playground");
    await settle(20);

    expect(count(), "切回来又重读了一遍").toEqual({ models: 1, config: 1 });
    expect(pick(h.section("playground"), "[data-protocol]").length, "切回来之后左栏没了").toBe(4);
  });

  /**
   * ── **P3d 全分支评审 F-4：目录那条读也要能被作废** ─────────────────────────────
   *
   * **出处**：`loadCatalog()` 的 `api.get("/models")` 上一版**不传 `signal`**，
   * 而全面板另外六个板块级读（keys / events / overview / models / registrar / usage）
   * **全部**带 `AbortController` + `{ signal }`；`api.js` 的 `raw()` 本来就把
   * `init.signal` 透给 `fetch` ⇒ **不是能力缺失，是这一处少写了一半**。
   * 更要紧的是 `onHide()` 的注释写着「切走板块 = 作废**在飞的那一次**」——一句全称句，
   * 而 `cancelInFlight()` 只动 `current`，`current` **只在 `sendOnce()` 里赋值**
   * ⇒ 目录那一次不在「在飞的那一次」里。
   *
   * ⚠️⚠️ **`signal` 那一半在机器上不可观测，如实说明**：`harness.ts` 的 fetch 替身
   * **不看 `signal`**（账本已登记）⇒ 「abort 了」与「没 abort」在这里长得一模一样。
   * 这一格能观测的是**另一半**：世代号作废 + 在飞标记归零之后，那条挂住的读不再把
   * 这个板块永久钉在「读不出来」上。`signal` 那一半由下面
   * 「`loadCatalog()` 那条读真的把 signal 传下去了」那一格从源码上钉。
   *
   * **变红条件（都实测过）**：把 `onHide()` 里那句 `cancelCatalogLoad()` 删掉
   * ⇒ `loadInFlight` 一直是 `true` ⇒ 切回来只 render 不发请求 ⇒ 第二条断言从 2 变 1。
   */
  it("目录那条读挂住时切走再切回来：旧那条被作废、新的一条真的发得出去", async () => {
    const pending: Array<(r: Resp) => void> = [];
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "playground" },
      respond: (url: string) => {
        if (url.startsWith("/admin/api/config")) return { status: 200, body: configBody("wxyz") };
        if (!url.startsWith("/admin/api/models")) return { status: 200, body: {} };
        // **替身带一个真实的挂起点**（第 8 种假阳性：零延迟替身让时序性质不可观测）。
        return new Promise<Resp>((resolve) => { pending.push(resolve); });
      },
    });
    await settle(20);
    const modelCalls = (): number => h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length;
    expect(pending.length, "前置条件：第一条读得真的还在飞着").toBe(1);
    expect(modelCalls(), "前置条件：第一次显示时读了一次").toBe(1);

    navTo(h, "overview");
    await settle(20);
    navTo(h, "playground");
    await settle(20);

    expect(modelCalls(), "切回来之后一条都没再发 —— 那条挂住的读把板块永久钉在「读不出来」上了").toBe(2);

    // **后果那一半**：被作废的那条晚到时（成功也好失败也罢）不许影响现在的画面。
    pending[1]!({ status: 200, body: catalogPayload() });
    await settle(20);
    expect(pick(h.section("playground"), "[data-protocol]").length, "新的那条回来了却没画出来").toBe(4);
    pending[0]!({ status: 500, body: {} });
    await settle(20);
    expect(
      pick(h.section("playground"), "[data-protocol]").length,
      "被作废的那条晚到之后把已经画好的左栏抹掉了 —— 世代号没拦住它",
    ).toBe(4);
  });

  /**
   * **`signal` 那一半只能从源码上钉**（理由见上一格那段 ⚠️⚠️：替身不看 `signal`）。
   *
   * ⚠️ **这一格是源码文本断言，弱于行为断言，如实说明**：它拦不住「传了一个永远不 abort
   * 的 signal」，拦得住的是「又有人把这条读写回不带 init 的形态」——而后者正是这次
   * 评审实际抓到的那一种。
   * ⚠️ 判据锚在 `api.get("/models"` 这个调用点上，**不数全文件的 `signal` 出现次数**：
   * 那种数法会被同文件里 `sendOnce()` 那几处 `ctl.signal` 顶成绿的。
   */
  it("loadCatalog() 那条读真的把 signal 传下去了 —— 全面板七个板块级读只有它曾经没传", () => {
    const src = stripComments(readFileSync("admin-ui/js/sec-playground.js", "utf8"));
    const sites = [...src.matchAll(/api\.get\(\s*"\/models"\s*(,[^)]*)?\)/g)];
    expect(sites.length, "这个板块读目录的调用点不是恰好一处了").toBe(1);
    expect(sites[0]![1] ?? "", "api.get(\"/models\") 又变回不带 init 的形态了").toContain("signal");
  });
});

/**
 * ── **P3d Task 11：流式那条路**（本板块的第二条渲染路径）──────────────────────
 *
 * ⚠️ **替身能力核对（第 9 种假阳性，本任务的检查单）**：本组用到的 DOM 成员是
 * `.checked`（真实 checkbox 有）、`.value`、`.textContent`、`.disabled`、
 * `querySelectorAll`（只当迭代器用，**不调 `.map/.filter`**）、`.children`（for…of 递归）。
 * `tests/ui/dom/fake-dom-parity.test.ts` 的 `FAKE_ONLY_MEMBERS` 那 8 条**一条都没用到**。
 * ⚠️ 踩到的那条盲点写明：`.change()` 在夹具里**不翻 `.checked`**，所以
 * `turnOnStream()` 自己先写那一格——真实浏览器是先翻再派发，这么写才是照真实语义模拟。
 */
describe("Playground 板块：流式", () => {
  /**
   * **防住的真实故障**：开关翻了，但请求体里没带流式那一格 ⇒ **静默降级成非流式**。
   * 请求照样 200、内容照样对，只是一次性全回来，而面板正声称自己在流式渲染。
   *
   * ⚠️ **观测点在「发出去的请求体长什么样」上**（第 5 条方法论：不许落在自报的字段上）。
   *
   * **变红条件**：把 `sendOnce()` 里那个 `stream` 写死成 `false`。
   */
  it("打开流式开关之后，发出去的请求体里真的带着流式那一格 —— 不带就是静默降级成非流式", async () => {
    const h = await openPg(respondWith({
      gateway: () => ({ status: 200, body: null, raw: SSE_THREE_CHUNKS }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(40);

    const sent = gatewayCalls(h);
    expect(sent.length, "这一次没发出去").toBe(1);
    // 期望值手写字面量：真源里 openai 那条的 `streamKey` 就是这个词。
    expect((sent[0]!.body as Record<string, unknown>).stream, "请求体里没有流式那一格").toBe(true);
  });

  /**
   * **防住的真实故障**：关着开关却发了流式请求（或反过来）。
   * 上一格只证明「开着的时候带」，**证明不了「关着的时候不带」**——
   * 一个恒为 true 的实现在上一格上是全绿的（第 5 种假阳性：覆盖的状态让选择不可观测）。
   */
  it("开关关着时请求体里没有那一格 —— 只验「开着会带」的话，恒为 true 的实现也全绿", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    // **刻意不碰那个开关。**
    one(sec, ".pg-send").click();
    await settle(40);

    const sent = gatewayCalls(h);
    expect(sent.length).toBe(1);
    expect((sent[0]!.body as Record<string, unknown>).stream, "没开流式却带上了那一格").toBe(undefined);
  });

  /**
   * **防住的真实故障**：正文取不出来 ⇒ 对话框永远是空的（请求 200、字节也到了）。
   * 这一格走的是**整条真链路**：真目录 → 真 `buildRequest` → 真 `gw-api` 读流 →
   * 真 `deltaText` 按目录里的 `streamTextPath` 取值 → 渲染。
   *
   * **变红条件**：把真源里 openai 那条的 `streamTextPath` 改一格。
   */
  it("三块增量被按顺序拼成一段正文画在右栏 —— 顺序错或漏一块，运维读到的就是另一句话", async () => {
    const h = await openPg(respondWith({
      gateway: () => ({ status: 200, body: null, raw: SSE_THREE_CHUNKS }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(40);

    // 期望值手写字面量（拼接顺序是这一格的全部内容）。
    expect(one(sec, ".pg-stream-text").textContent).toBe("甲乙丙");
    // **流式那一轮不画响应原文**：它没有「原文」可画。
    expect(pick(sec, ".pg-body").filter((n) => !n.classList.contains("pg-stream-text")).length,
      "流式那一轮同时画了一份响应原文").toBe(0);
  });

  /**
   * ⚠️⚠️ **这一格是文件头「流式那一轮为什么不显示 token 用量」那段话的装置。**
   *
   * **防住的真实故障**：谁顺手把「响应里的 usage」画出来。
   * `src/core/protocol/anthropic.ts` 的 `message_delta` 事件**写死 `output_tokens: 0`**
   * ⇒ 那一刻面板会显示 **0 个 token**，而那是全局约束 9 明令禁止的伪造 0。
   *
   * **夹具用的是真的带着那个 0 的字节**——不是编一段「假装有 usage」的数据：
   * 用例必须在**缺陷真的会发作**的输入上跑，否则它什么都没守。
   */
  it("流式那一轮不显示任何 token 数字 —— Anthropic 的流里带着一个恒为 0 的 usage", async () => {
    // 逐字照抄 `toAnthropicStream()` 真吐出去的那两行（含那个 0）。
    const anthropicWire = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"甲"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].map((l) => `${l}\n\n`).join("");
    // 前置条件：夹具里**真的**有那个 0，否则这一格是在一个不会发作的输入上空转。
    expect(anthropicWire, "夹具里没有那个恒为 0 的 usage，这一格什么都没守").toContain('"output_tokens":0');

    const h = await openPg(respondWith({ gateway: () => ({ status: 200, body: null, raw: anthropicWire }) }));
    const sec = h.section("playground");
    // 换到 anthropic 那一档（**按 label 找，不认 id**——本用例同样不该硬编码协议 id）。
    pick(sec, "[data-protocol]")[1]!.click();
    await settle();
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(40);

    expect(one(sec, ".pg-stream-text").textContent, "前置条件：这一轮得真的走了流式并拼出正文").toBe("甲");
    // 必须**明说**为什么没有数字 —— 静默地不画等于让人以为是 0。
    expect(one(sec, ".pg-no-tokens").textContent)
      .toBe("流式响应不带 token 用量，所以这里不显示数字——显示 0 会是假的。");

    /**
     * ⚠️⚠️ **闭集断言（评审 F2）。** 上面两条**挡不住「多画一行」**：
     * 一条按字段名的子串断言换个标签就绕过，一条 `.pg-no-tokens` 计数只挡替换不挡新增。
     * 评审实测：多画一行 `` `Tokens: ${turn.tokens}` `` ⇒ 103/103 全绿。
     * ⇒ 这一轮的节点形状必须**逐条**等于下面这张手写的表，**多一行就红**。
     */
    expect(turnShape(sec), "流式那一轮多画了一行 —— 它是从哪儿来的？").toEqual([
      "div.pg-turn",
      "div.pg-turn-head",
      "span.muted",
      "span.mono pg-endpoint",
      "p.pg-turn-prompt",
      "div.pg-turn-head",
      "span.muted",
      "span.mono pg-status",
      "pre.mono pg-body pg-stream-text",
      "p.muted note pg-no-tokens",
    ]);
  });

  /**
   * **防住的真实故障**：一块读不出来的数据被静默丢弃 ⇒ 面板把一段**缺字**的回答
   * 当成完整的回答画出去，运维完全看不出来。
   *
   * **变红条件**：把 `sendOnce()` 里 `piece === null` 那一档的 `turn.malformed++` 删掉
   *（只 `return`）——正文照样是「甲丙」，但屏幕上不再有任何东西提到中间掉了一块。
   */
  it("中间夹一块读不出来的数据：其余正文照常拼出来，且缺了几块要说出来 —— 静默丢弃就是撒谎", async () => {
    const wire = [
      'data: {"id":"c1","choices":[{"delta":{"content":"甲"}}]}',
      "data: {这一块不是合法 JSON",
      'data: {"id":"c1","choices":[{"delta":{"content":"丙"}}]}',
      "data: [DONE]",
    ].map((l) => `${l}\n\n`).join("");

    const h = await openPg(respondWith({ gateway: () => ({ status: 200, body: null, raw: wire }) }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(40);

    // ① 一块坏数据**不许**让整轮对话中断。
    expect(one(sec, ".pg-stream-text").textContent, "一块坏数据把整轮都吃掉了").toBe("甲丙");
    // ② 但它必须被数出来并说出来。期望值手写整句。
    expect(pick(sec, ".pg-malformed").length, "掉了一块却什么都没说").toBe(1);
    expect(one(sec, ".pg-malformed").textContent)
      .toBe("这条流里有 1 块数据读不出来，已跳过——上面这段回答可能是缺字的。");
  });

  /**
   * **「这条流一个字都没有」与「还在收」是两件事**（全局约束 9 的同型）。
   * 变红条件：把 `buildTurn()` 里那句 `turn.pending !== true` 去掉 ⇒ 还在收的时候
   * 就会画出「一个字都没有」，而那时候它只是还没到。
   */
  it("一条只有 [DONE] 的流：明说「一个字正文都没有」，而不是画一个空白框", async () => {
    const h = await openPg(respondWith({
      gateway: () => ({ status: 200, body: null, raw: "data: [DONE]\n\n" }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(40);

    expect(one(sec, ".pg-stream-text").textContent).toBe("");
    expect(pick(sec, ".pg-stream-empty").length, "空流没被说出来").toBe(1);
  });

  /**
   * ⚠️⚠️ **评审 F1：这一档原来同时说了两句互相矛盾的话，而其中一句是编的。**
   *
   * 流式在**传输层**失败时（断网 / CORS / 被拒），`turn.text` 是空串、`streamed` 仍是 true
   * ⇒ 走 stream 分支。原来的空流判据少了 `turn.errorKey === null` 这一条，于是屏幕上
   * **同时**出现：
   *   「这条流读完了，但里面一个字的正文都没有。」  ← **假的，那条流根本没开起来**
   *   「这次请求没有拿到任何响应：…」
   *
   * ⚠️ **原来那 9 格流式用例没有一格能让 `errorKey !== null` 落进 stream 分支**
   *（成功 / 401 降级 / 取消 三条路都绕开了它）——**覆盖面小于宣称的范围**，又一次。
   *
   * **变红条件**：把 `buildTurn()` 里那句 `&& turn.errorKey === null` 删掉。
   */
  it("流式在传输层失败：只说「没拿到任何响应」，不许同时说「这条流读完了」—— 那两句话互相矛盾", async () => {
    const h = await openPg(respondWith({ gateway: () => { throw new Error("boom"); } }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(40);

    // 前置条件：这一次**真的**落进了失败档，而且**真的**走的是 stream 分支。
    expect(pick(sec, ".pg-error").length, "前置条件：这一次得真的失败").toBe(1);
    expect(pick(sec, ".pg-stream-text").length, "前置条件：得真的走 stream 分支").toBe(1);
    expect(one(sec, ".pg-stream-text").textContent).toBe("");

    expect(pick(sec, ".pg-stream-empty").length, "那条流根本没开起来，却说它「读完了」").toBe(0);
    expect(one(sec, ".pg-error").textContent)
      .toBe("这次请求没有拿到任何响应：可能是断网、被取消，或者请求本身失败了。这与上游的状态无关。");
  });

  /**
   * **读到一半断了**：已经到的那半句话留着，并**明说这条流没读完**。
   *
   * ⚠️ `pg.err.stream` 这个 key 在评审之前**没有任何 DOM 用例渲染过**
   *（`gw-api` 那一层只验它抛的 `code`，验不到面板画成了什么）。
   */
  it("读到一半断了：已经收到的那半句话留着，并明说这条流没读完 —— 抹掉它比留着更不诚实", async () => {
    const h = await openPg(respondWith({ gateway: () => ({ status: 200, body: null, raw: brokenStream(["甲", "乙"]) }) }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(60);

    expect(one(sec, ".pg-stream-text").textContent, "断掉之前收到的那两块被抹掉了").toBe("甲乙");
    expect(one(sec, ".pg-error").textContent)
      .toBe("这条流没读完就断了。上面那段正文是真的收到过的，后面还有多少不知道。");
    // 断掉 ≠ 读完，同样不许说「一个字都没有」（何况这里明明有两个字）。
    expect(pick(sec, ".pg-stream-empty").length).toBe(0);
  });

  /**
   * ⚠️⚠️ **评审 F3：取消之后 `turn.pending` 永不回落。**
   *
   * `cancelInFlight()` 把 `current` 置空，而 `.finally()` 第一句就是
   * `if (current !== ctl) return;` ⇒ **`turn.pending = false` 那条路走不到**。
   * 后果：取消一条一个字都没到的流之后，右栏留下**一个空白框 + 一句「流式不统计 token」**，
   * 既不说「一个字都没有」、也不说任何错误 —— 屏幕上完全看不出发生过什么。
   *
   * ⚠️ 这正是兄弟用例「一条只有 [DONE] 的流：明说『一个字正文都没有』」要防的那件事，
   * 只是**没覆盖取消这一档**。
   *
   * **变红条件**：把 `cancelInFlight()` 里那三行 `streamingTurn` 的收尾删掉。
   */
  it("取消一条一个字都没到的流：明说是被取消的 —— 既不许留白，也不许谎称「读完了但没有正文」", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const h = await openPg(respondWith({
      gateway: async () => { await gate; return { status: 200, body: null, raw: SSE_THREE_CHUNKS }; },
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(10);
    expect(pick(sec, ".pg-cancel").length, "前置条件：这一刻应当有一次在飞").toBe(1);

    one(sec, ".pg-cancel").click();
    await settle(10);
    release();
    await settle(40);

    // ① 说出来了：这一次是**被取消**的。
    expect(pick(sec, ".pg-cancelled").length, "取消之后屏幕上什么都没说").toBe(1);
    expect(one(sec, ".pg-cancelled").textContent)
      .toBe("这一次被你取消了，上面那段是取消之前真的收到的内容。");
    // ② **不许**同时谎称「这条流读完了」。
    expect(pick(sec, ".pg-stream-empty").length, "取消的流被说成「读完了但一个字都没有」").toBe(0);
    // ③ 形状闭集：取消那一轮同样不许多画任何一行（F2 同一条纪律）。
    expect(turnShape(sec)).toEqual([
      "div.pg-turn",
      "div.pg-turn-head",
      "span.muted",
      "span.mono pg-endpoint",
      "p.pg-turn-prompt",
      "div.pg-turn-head",
      "span.muted",
      "pre.mono pg-body pg-stream-text",
      "p.muted note pg-cancelled",
      "p.muted note pg-no-tokens",
    ]);
  });

  /**
   * **上游没 ok 时不许走读流那条路。** 网关的错误响应是 JSON、不是 SSE，
   * 拿 SSE 解析器去读它会得到零条负载 ⇒ 面板显示一次「什么都没发生」的成功流式，
   * 而那次其实是 401 / 429。
   *
   * **变红条件**：把 `streamFromGateway()` 里那句 `if (!res.ok || !res.body)` 删掉。
   */
  it("流式请求撞上 401：画的是那份错误响应体与状态码，不是一条空流", async () => {
    const h = await openPg(respondWith({
      gateway: () => ({ status: 401, body: { error: { message: "PROBE-UNAUTHORIZED" } } }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(40);

    expect(one(sec, ".pg-status").textContent).toBe("401");
    // 走的是非流式那条渲染路径（响应原文），**不是**流式那条。
    expect(pick(sec, ".pg-stream-text").length, "把一次 401 画成了一条空流").toBe(0);
    expect(one(sec, ".pg-body").textContent).toContain("PROBE-UNAUTHORIZED");
  });

  /**
   * **整块重画之后开关还得是开着的。**
   *
   * ⚠️ **这一格是「先把那一行删一次试试」立出来的**（Task 10 交接的那条纪律）：
   * 我原本在 `buildStreamToggle()` 的注释里声称 `box.checked = streamOn;` 是必需的，
   * 而当时**没有任何用例守着它**——删掉它全绿。现在有了。
   *
   * **失效形态**：每次 `render()` 都重建整个左栏，不回写的话开关在**屏幕上**掉回关闭，
   * 而模块变量 `streamOn` 仍是 true ⇒ **运维看到的档位与下一次真发出去的请求不一致**。
   * 那比两边都关掉更糟：他会以为自己在发非流式。
   *
   * **变红条件**：删掉 `buildStreamToggle()` 里那句 `box.checked = streamOn;`。
   */
  it("发完一轮整块重画之后，流式开关在屏幕上还是开着的 —— 掉回关闭会让屏幕与真发出去的请求不一致", async () => {
    const h = await openPg(respondWith({
      gateway: () => ({ status: 200, body: null, raw: SSE_THREE_CHUNKS }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(40);

    // 前置条件：这一轮确实走完了（右栏有正文），也就是说 `render()` 真的重跑过。
    expect(one(sec, ".pg-stream-text").textContent, "前置条件：这一轮得真的走完").toBe("甲乙丙");
    expect(one(sec, ".pg-stream").checked, "重画之后开关在屏幕上掉回了关闭").toBe(true);

    // 而且**下一次仍然发流式**（屏幕与行为一致，不是只有屏幕对）。
    typePrompt(sec, "再来一句");
    one(sec, ".pg-send").click();
    await settle(40);
    const sent = gatewayCalls(h);
    expect(sent.length).toBe(2);
    expect((sent[1]!.body as Record<string, unknown>).stream, "第二次掉回了非流式").toBe(true);
  });

  /**
   * **取消之后不许再往右栏里写字。**
   *
   * ⚠️ **如实登记它钉的是什么**：`tests/ui/dom/harness.ts` 的 `fetch` 替身**零处**看
   * `signal`（Task 9 交接第 3 条 / Task 10 登记的边界一），所以 `abort()` 本身在这里
   * **天然不可观测**。这一格钉的是 `onPayload` 里那句 `current !== ctl` 的身份比较
   * ——真实浏览器里 abort 让那条链以 `AbortError` 拒绝，同一条判据同样把它挡在外面。
   *
   * **变红条件**：把 `sendOnce()` 的 `onPayload` 里那句 `if (current !== ctl) return;` 删掉。
   */
  it("点了取消之后，后到的那几块不许再落进右栏 —— 钉的是身份比较，不是 abort 本身", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const h = await openPg(respondWith({
      // 应答挂在闸上：点取消的那一刻，这条流一个字节都还没被读到。
      gateway: async () => { await gate; return { status: 200, body: null, raw: SSE_THREE_CHUNKS }; },
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(10);

    // 前置条件：这一刻确实在飞（取消按钮在），而且一个字都还没到。
    expect(pick(sec, ".pg-cancel").length, "前置条件：这一刻应当有一次在飞").toBe(1);
    one(sec, ".pg-cancel").click();
    await settle(10);

    release();
    await settle(40);

    // 取消之后那三块**一个字都不许**出现在屏幕上。
    expect(sec.textContent, "取消之后后到的那几块还是落进了右栏").not.toContain("甲乙丙");
    expect(sec.textContent).not.toContain("甲");
  });
});

/**
 * ── **P3d 第二轮修复定向复评 G2：流式在途那一拍** ─────────────────────────────
 *
 * **它防住的真实故障（复评 S-1 实测，不是设想）**：`onPayload` 每来一块读不出来的
 * 数据就 `turn.malformed++`，而那句话画出来的 `.pg-malformed` 在那个 `<pre>` **外面**
 * ⇒ 只就地改 `<pre>` 的 `textContent` **够不着它**。上一版在途期间
 * `.pg-malformed` **就地 0 / 强制重建 1**，也就是说：**面板把一段缺字的回答
 * 当成完整的回答画着，一个字都不提**，直到流结束那一次整版 `render()` 才补上。
 * 长生成是分钟级，流被挂住时无限期。而 `buildTurn()` 里那句
 * 「**静默丢弃就是撒谎**」正是这个文件自己写的。
 *
 * ⚠️ **它与轮询那次（复评 H2，`.pg-status` 编了一个状态码）是同一个结构性 bug**：
 * **就地更新的那个节点之外，还有一份会变的状态被渲染在别处。**
 * 所以下面第二格用的是本文件顶层那份**同一个** `expectSameAsRebuild()`，不是抄一份。
 *
 * ⚠️ **既有那格「中间夹一块读不出来的数据」看不到这件事**：它 `await settle(40)`
 * 等到**流结束之后**才断言，而流结束会走 `.finally()` → `render()` 把话补上
 * ⇒ 那一格看到的是补正之后的屏幕，**在途那一段从来没有被任何一格看过**。
 * 这一组的夹具因此必须是一条**挂住不结束**的流。
 */
describe("流式在途：那一拍的屏幕不许比整版重建少说一句话", () => {
  /**
   * 一条**先真的吐几块、然后挂住不结束**的流。
   *
   * ⚠️ **分阶段必须靠 `pull`**（与上面 `brokenStream()` 同一条理由：在同一个 `start`
   * 里先 enqueue 再收尾，那几块在流那一层就没了）。
   * ⚠️ **挂住那一下是一个永不落定的 Promise，不是 `close()`**：`close()` 会让
   * `streamFromGateway()` 落地 ⇒ `.finally()` 里那次整版 `render()` 把话补上
   * ⇒ 要观测的那一拍当场消失。**夹具本身就是这一组的判据的一半。**
   */
  function hangingStream(lines: readonly string[]): ReadableStream<Uint8Array> {
    let i = 0;
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < lines.length) { c.enqueue(enc.encode(lines[i++]!)); return undefined; }
        return new Promise<void>(() => {});   // 挂住：既不再吐，也不结束
      },
    });
  }

  /** 一块正文 → 两块读不出来的 → 挂住。**两块**是刻意的，理由见下面第二格。 */
  const WIRE = [
    'data: {"id":"c1","choices":[{"delta":{"content":"甲"}}]}\n\n',
    "data: {这一块不是合法 JSON\n\n",
    "data: {这一块也不是合法 JSON\n\n",
  ];

  async function startHanging(): Promise<{ h: Harness; sec: FakeElement }> {
    const h = await openPg(respondWith({
      gateway: () => ({ status: 200, body: null, raw: hangingStream(WIRE) }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(80);
    // ── 前置条件三条：这一拍真的是「在途」，不是收尾之后 ────────────────────────
    expect(one(sec, ".pg-stream-text").textContent, "前置条件：正文那一块得真的到了").toBe("甲");
    expect(pick(sec, ".pg-cancel").length, "前置条件：这条流得还挂着（在飞），否则测的是收尾那一拍").toBe(1);
    expect(pick(sec, ".pg-error").length, "前置条件：这条流不许已经出错").toBe(0);
    return { h, sec };
  }

  /**
   * **变红条件（实测）**：把 `onPayload` 里 `turn.malformed++` 之后那一段
   *（就地改 `.pg-malformed` / `0 → 1` 时 `render()` 一次）删掉 ⇒ 这一格红成
   * 「掉了 2 块却什么都没说 —— 期望 1，实际 0」。
   */
  it("在途就把「掉了几块」说出来 —— 不是等流结束那一次整版重画才补上", async () => {
    const { sec } = await startHanging();
    expect(
      pick(sec, ".pg-malformed").length,
      "在途期间一个字都不提「掉了几块」——面板正把一段缺字的回答当成完整的画着，"
      + "而 buildTurn() 里那句「静默丢弃就是撒谎」是这个文件自己写的",
    ).toBe(1);
    // 期望值手写整句（与既有那格同一条纪律：不许从 i18n 词典推导）。
    expect(one(sec, ".pg-malformed").textContent)
      .toBe("这条流里有 2 块数据读不出来，已跳过——上面这段回答可能是缺字的。");
  });

  /**
   * **场景⑦：与轮询那六格共用同一份装置。**
   *
   * ⚠️ **夹具里那两块坏数据缺一不可，它们各钉一条路**：
   * · 第一块（`0 → 1`）钉的是「那一行**长出来**」——它当时还不存在，
   *   位置由 `buildTurn()` 定，所以那一档走的是整版重建；
   * · 第二块（`1 → 2`）钉的是「那一行**跟着改**」——它已经在屏幕上，走就地改
   *   `textContent`，而那句串必须与 `buildTurn()` 里那句 `t("pg.turn.malformed", …)`
   *   逐字同源。只留一块的话，把就地那一档写坏（比如忘了改数字）这一格照样绿。
   */
  it("场景⑦流式在途：就地写字与整版重建输出逐字相同（逐节点逐属性）", async () => {
    const { h, sec } = await startHanging();
    expectSameAsRebuild(h, sec, "流式在途");
  });

  /**
   * ── **`render()` 里那句 `nodes.streamMalformed = null` 的那条祸事** ────────────
   *
   * ⚠️⚠️ **这一格是变异实测倒逼出来的，不是设计出来的。** 上面两格建起来之后我把
   * `render()` 里那句作废删掉重跑 ⇒ **60 全绿（ESCAPED）**。顺着追一遍才发现那句话
   * 描述的祸事**今天完全可达**，只是没有任何一格走过「连着两轮流式」：
   * · 第一轮收到坏块 ⇒ 那一行长出来、被记进 `nodes`；
   * · 第一轮结束 ⇒ `.finally()` 整版 `render()`，那一轮 `pending` 已经是 false
   *   ⇒ `buildTurn()` **不再重新挂**，而旧那个节点已经从文档里摘掉了；
   * · **少了那句作废**，`nodes.streamMalformed` 就一直指着那个摘掉的节点
   *   ⇒ 第二轮的坏块全部写进一个没人看得见的对象里，
   *   **第二轮屏幕上那句「掉了几块」根本不长出来**。
   *
   * ⇒ 与轮询那一档的 `nodes.pollStatus` 不同（那一句实测是防御性的、今天走不到），
   * **这一句是有牙的**，牙在这一格。**变红条件**：删掉 `render()` 里那句
   * `nodes.streamMalformed = null;` ⇒ 这一格红成「第二轮一个字都没说」。
   */
  it("连着两轮流式各有坏块：第二轮说的是自己那一句，不是往上一轮那个摘掉的节点上写字", async () => {
    // 第一轮：一块正文 + 一块坏的，**正常收尾**（走完 `.finally()` 的整版 render()）。
    const first = [
      'data: {"id":"c1","choices":[{"delta":{"content":"甲"}}]}',
      "data: {第一轮这一块不是合法 JSON",
      "data: [DONE]",
    ].map((l) => `${l}\n\n`).join("");
    let call = 0;
    const h = await openPg(respondWith({
      gateway: () => (call++ === 0
        ? { status: 200, body: null, raw: first }
        : { status: 200, body: null, raw: hangingStream(WIRE) }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    turnOnStream(sec);

    typePrompt(sec, "第一句");
    one(sec, ".pg-send").click();
    await settle(80);
    // 前置条件：第一轮真的走完了，而且真的说出了自己那一句。
    expect(pick(sec, ".pg-cancel").length, "前置条件：第一轮得真的收尾了").toBe(0);
    expect(pick(sec, ".pg-malformed").length, "前置条件：第一轮那一句得真的画出来").toBe(1);

    typePrompt(sec, "第二句");
    one(sec, ".pg-send").click();
    await settle(80);
    // 前置条件：第二轮真的还挂着（这一格测的就是在途那一拍）。
    expect(pick(sec, ".pg-cancel").length, "前置条件：第二轮得还挂着").toBe(1);

    const notes = pick(sec, ".pg-malformed");
    expect(
      notes.length,
      "第二轮在途期间没有长出自己那句「掉了几块」——"
      + "坏块很可能被写进了上一轮那个已经从文档里摘掉的节点（去看 render() 里那句作废）",
    ).toBe(2);
    // 两句各说各的：第一轮 1 块、第二轮 2 块。**期望值手写整句。**
    expect(notes[0]!.textContent, "第一轮那一句被下一轮改写了")
      .toBe("这条流里有 1 块数据读不出来，已跳过——上面这段回答可能是缺字的。");
    expect(notes[1]!.textContent)
      .toBe("这条流里有 2 块数据读不出来，已跳过——上面这段回答可能是缺字的。");
  });
});

/**
 * ── **媒体模式（P3d Task 12）：只展示地址，不内嵌远端任何东西** ─────────────────
 *
 * ── 替身能力核对（第 9 种假阳性，检查单要求逐条写出来）────────────────────────
 * 这一组新用到的 DOM 成员逐个对过 `tests/helpers/fake-dom.ts`：
 * `createElement("a")` / `createElement("img")` / `setAttribute` / `getAttribute` /
 * `textContent` / `tagName` / `.children` 的 `for…of` 递归
 * ——**8 条替身独有能力一条都没用到**。
 * ⚠️ **踩到的盲点仍然只有 `.disabled` 那一条**（夹具把它挂在每个元素上、且点一颗
 * disabled 的按钮照样会触发监听器），本组只用它读属性、不靠它拦点击，
 * 与文件头那段同一处置。
 * ⚠️ **另有一条本组特有的能力缺口，如实登记**：夹具的 a 元素**不会真的导航**，
 * img 元素**不会真的去取那个地址**。⇒「点开之后发生了什么」「远端图片有没有被真的
 * 请求」这两件事在这里按定义不可观测；本组能验的只有**画出来的是什么元素、
 * 带了哪些属性**。「远端地址不可内嵌」那条性质的**判据**由
 * `tests/ui/playground-media.test.ts` 的
 * 「面板 CSP 的 img-src 里没有任何远端主机、也没有 media-src」
 * 在纯函数层钉着，这一组钉的是**渲染真的照着那条判据走**。
 */
describe("媒体模式：地址、链接与不内嵌", () => {
  /** 一份带三种地址的媒体响应：远端可链接、data 图片、以及一条协议不在白名单里的。 */
  const MIXED = {
    created: 1,
    data: [
      { url: "https://cdn.invalid/a.png" },
      { url: "data:image/png;base64,iVBORw0KGgo=" },
      { url: "javascript:alert(1)" },
    ],
  };

  /**
   * 会去取远端字节的那几种元素。
   *
   * ⚠️⚠️ **它不是「所有取字节方式」的闭集，措辞已按评审 L2 改真。**
   * 上一版这里写的是「**闭集**，不是『有没有 img 这个词』」——**后半句成立、前半句不成立**：
   * 评审逐条实测出**三条绕得过这张表**的写法：`link[rel=preload]`、
   * `<svg><image href>`、以及**根本不是元素**的 CSSOM `style.backgroundImage`。
   * ⇒ 前两条已补进表里；**CSSOM 那条按定义补不进一张元素名单**，登记成本组的已知盲点。
   * **今天三条都零风险**——评审用真 Chrome 对着 `src/ui/serve.ts` 那条逐字 CSP 量过，
   * 12 条向量（含这三条）**全部被 img-src / default-src 拦下**。
   * ⇒ **这张表守的是「渲染代码没打算去取远端字节」，CSP 守的是「就算打算了也取不到」。**
   * 两道各守一层，别把这一格的绿读成后者。
   */
  const EMBEDDERS = ["IMG", "VIDEO", "AUDIO", "SOURCE", "IFRAME", "EMBED", "OBJECT", "LINK", "IMAGE"];

  async function sendImage(respond: Responder): Promise<{ h: Harness; sec: FakeElement }> {
    const h = await openPg(respond);
    const sec = h.section("playground");
    toMode(sec, "image");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "一只猫");
    one(sec, ".pg-send").click();
    await settle(20);
    return { h, sec };
  }

  /**
   * ── **全局约束 17 在渲染这一侧的执行机构** ──────────────────────────────────
   *
   * **被守护的性质**：右栏对一条**远端**媒体地址，画出来的只能是「文字 + 复制 + 链接」，
   * **不许有任何一个会让浏览器去那个远端取字节的元素**。
   * 那条 CSP 里 img-src 没有任何远端主机、而且**根本没有 media-src** ⇒ 真画出来的话，
   * 屏幕上是一张永远加载失败的破图 / 一个放不了的播放器，**而运维会以为是结果坏了**。
   * 更要紧的是：谁看到破图之后最自然的修法就是去 CSP 里加一行——而那条 CSP 是
   * `ADMIN_TOKEN` 存在这个 origin 的浏览器本地存储里的唯一结构性防线。
   *
   * ⚠️ **判据是「元素清单」而不是「没有 img 这个词」**：后者一次
   * `createElement("video")` 就绕过去了。这里逐个节点看 `tagName`，**闭集**比对。
   *
   * **变红条件（三条，逐条实测，见 progress note 的 M4/M5/M11）**：
   * ① 在 `buildMediaRow()` 里把那句 `if (mediaEmbeddable(url))` 去掉、无条件画 img
   *    ⇒ 远端那条被内嵌 ⇒ 红；
   * ② 把内嵌那一行改成 `el("video", …)` ⇒ 闭集里冒出 VIDEO ⇒ 红；
   * ③ 把 `mediaResultUrls()` 里的白名单去掉 ⇒ `javascript:` 那条会长出一个 a 元素 ⇒
   *    下面那条「链接的 href 只可能是 http(s)」红。
   */
  it("媒体结果只出现地址与链接，一个内嵌远端资源的元素都没有 —— "
     + "CSP 没有 media-src，img-src 里也没有远端主机", async () => {
    const { sec } = await sendImage(respondWith({ gateway: () => ({ status: 200, body: MIXED }) }));

    // 前置条件：这一轮真的画出了媒体结果（否则下面全是在一棵空树上断言）。
    expect(pick(sec, ".pg-media-url").map((n) => n.textContent), "前置条件：两条合法地址都得画出来")
      .toEqual(["https://cdn.invalid/a.png", "data:image/png;base64,iVBORw0KGgo="]);

    // ① 整棵板块子树里出现过的、会去取字节的元素只有一个，
    //    它是 img、而且拿的是那条 data 地址（CSP 的 img-src 本来就放行它）。
    //    ⚠️ 「只有一个」这句话的范围是上面 `EMBEDDERS` 那张表，**不是「所有取字节的方式」**
    //    ——那张表上方那段写着它绕得过哪几条、以及是谁在守剩下的那些。
    // ⚠️⚠️ **标签名必须一起断言，这是实测补上的**（变异 M5）：上一版只比对 `src` 列表，
    //    于是把那一行内嵌从 img 改成 `el("video", { src: url })` ⇒ **46/46 全绿**
    //    ——`src` 一模一样，闭集看不出元素换了种。而 CSP 里**根本没有 media-src**，
    //    一个 video 元素连那条 data 地址都加载不了，屏幕上是个放不了的播放器。
    //    **写下的覆盖面小于宣称的范围**，这一格自己就犯了一次。
    const embedders = everyNode(sec).filter((n) => EMBEDDERS.includes(n.tagName.toUpperCase()));
    expect(
      embedders.map((n) => [n.tagName.toUpperCase(), n.getAttribute("src")]),
      "画出了一个会去远端取字节的元素，或者内嵌元素换了种（CSP 里没有 media-src）",
    ).toEqual([["IMG", "data:image/png;base64,iVBORw0KGgo="]]);

    // ② 那条远端地址**只以文字与链接的形态**出现过，没有任何元素拿它当 src。
    for (const n of everyNode(sec)) {
      if (n.getAttribute("src") === null) continue;
      expect(n.getAttribute("src"), `<${n.tagName}> 拿远端地址当了 src`)
        .not.toBe("https://cdn.invalid/a.png");
    }

    // ③ `javascript:` 那条既没有结果行、也没有链接 —— 它在收集那一层就被拦下了。
    // ⚠️ **这里刻意不断言「整棵子树的文字里没有 javascript:」**：右栏照旧摆着响应原文
    //    （`.pg-body`），那条字符串**当然**在里面，而且它在那里是安全的
    //    （`el()` 走的是 textContent，全站三条纪律的第 ①）。要断言的是
    //    **它没有变成一个可以点的东西、也没有变成任何元素的 src**。
    expect(pick(sec, ".pg-media-url").map((n) => n.textContent), "javascript: 那条被当成结果地址列出来了")
      .not.toContain("javascript:alert(1)");
    expect(pick(sec, ".pg-media-open").map((a) => a.getAttribute("href")), "链接的 href 只可能是 http(s)")
      .toEqual(["https://cdn.invalid/a.png"]);
    // 整棵子树里**任何**元素的 href / src 都不许是它 —— 上一条只看了那个 class。
    for (const n of everyNode(sec)) {
      for (const name of ["href", "src"]) {
        const v = n.getAttribute(name);
        if (v === null) continue;
        expect(v.toLowerCase().startsWith("javascript:"), `<${n.tagName}> 的 ${name} 是一条 javascript 地址`)
          .toBe(false);
      }
    }
  });

  /**
   * ⚠️⚠️ **`rel` 必须是显式写下来的那一份**（评审 I9）。
   * `target="_blank"` 的 a 元素现代浏览器确实会隐式补 `noopener`，**但那是浏览器的
   * 默认值、不是这段代码的性质**：一台老浏览器、一次 `rel` 被改写、或者哪天有人把它
   * 换成 `window.open()`（**它从来不补**），三条路径都会让被打开的那一页拿到 `opener`
   * 引用，而**这一页的 origin 上存着 `ADMIN_TOKEN`**。
   * `noreferrer` 是另一件事：不把面板自己的地址（含路径）泄给上游给的那个主机。
   *
   * **变红条件（实测，见 progress note 的 M12）**：把 `buildMediaRow()` 里那句
   * `rel: "noopener noreferrer"` 改成 `rel: "noopener"`、或整个删掉 ⇒ 这一格红。
   * ⚠️ **期望值写成整条字符串**：`toContain("noopener")` 在漏了 `noreferrer` 的那一版下
   * 照样通过。
   */
  it("结果链接带 rel 的 noopener noreferrer 两条 —— "
     + "隐式补那一份是浏览器的默认值，不是这段代码的性质（评审 I9）", async () => {
    const { sec } = await sendImage(respondWith({ gateway: () => ({ status: 200, body: MIXED }) }));
    const link = one(sec, ".pg-media-open");
    expect(link.tagName.toUpperCase(), "结果链接不是一个 a 元素").toBe("A");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toBe("https://cdn.invalid/a.png");
  });

  /**
   * ── **评审 M2：按下之前那句话必须说真话** ────────────────────────────────────
   *
   * `pg.send.ready` 五语言逐字都写着「**一次**请求」（en `one request` / ja `1 回` /
   * ko `한 번`）。**而视频档一次点击 = 1 次建任务 + 最多 60 次轮询。**
   * 这是全局约束 14「按钮与护栏一起交付」的**披露那一半**——护栏我都做了，
   * 而**运维在按下之前唯一看得到代价的地方**是这颗按钮的 tooltip。
   *
   * ⚠️ **期望值手写整句**：`toContain("60")` 在「已经查过 60 次」之类的别的文案里也成立。
   * ⚠️ **三档各断言一次**：只断言视频档的话，「把三档都换成这句话」也能过——
   * 而那会让对话档与图片档说一句同样不真的话（它们确实只发一次）。
   *
   * **变红条件（实测，见 progress note 的 M34）**：把 `syncSendButton()` 里那个
   * `mode === "video"` 分支删掉、三档共用 `pg.send.ready` ⇒ 这一格红。
   */
  it("视频档按下之前那句话说的是 1 + 60 次，不是「一次」 —— 它是运维唯一看得到代价的地方（评审 M2）", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "一只猫");
    await settle(6);
    // 前置条件：按钮得是能按的，否则 tooltip 说的是「为什么按不了」那一档。
    expect(one(sec, ".pg-send").disabled, "前置条件：这一刻按钮应当能按").toBe(false);

    const ready = "按一下会真的向上游发一次请求。";
    expect(one(sec, ".pg-send").getAttribute("title"), "对话档").toBe(ready);

    toMode(sec, "image");
    await settle(6);
    expect(one(sec, ".pg-send").getAttribute("title"), "图片档确实只发一次，不该改口").toBe(ready);

    toMode(sec, "video");
    await settle(6);
    expect(one(sec, ".pg-send").getAttribute("title"), "视频档还在说「一次」")
      .toBe("按一下会真的向上游发请求：一次视频任务是 1 次建任务 + 最多 60 次轮询查询。");
  });

  /**
   * **「上游回的是一段字节流」与「这次没有结果」是两句话**（全局约束 9 的同型）。
   * `src/http/routes/media.ts` 的文件头写着「上游返回什么（地址或字节流）就原样转发」
   * ——**两种都可能，而且都不是异常**。折叠成一句的话，字节流那一档会被读成
   * 「这次生成失败了」，而它其实成功了、只是结果是一段字节而面板按 CSP 不内嵌它。
   *
   * **变红条件**：把 `fillMediaResult()` 里那句 content-type 判定去掉、
   * 让两档都落到 `pg.media.none` ⇒ 这一格红。
   */
  it("上游直接回字节流时说的是「这次回的是一段字节」，不是「没有结果」 —— 两句话不许折叠", async () => {
    const { sec } = await sendImage(respondWith({
      // `raw` + 非 JSON 的 content-type = 一段真的不是 JSON 的响应体。
      gateway: () => ({ status: 200, body: null, raw: "PNG-NOT-JSON", contentType: "image/png" }),
    }));
    expect(pick(sec, ".pg-media-bytes").length, "字节流那一档没被说出来").toBe(1);
    expect(one(sec, ".pg-media-bytes").textContent, "那句话里得点出它是什么类型").toContain("image/png");
    expect(pick(sec, ".pg-media-none").length, "字节流被说成了「没有结果」").toBe(0);

    // 反向：JSON 但里面确实没有地址 ⇒ 说的是另一句。
    vi.unstubAllGlobals();
    const other = await sendImage(respondWith({ gateway: () => ({ status: 200, body: { created: 1 } }) }));
    expect(pick(other.sec, ".pg-media-none").length, "「响应里没有地址」那一档没被说出来").toBe(1);
    expect(pick(other.sec, ".pg-media-bytes").length, "一份 JSON 被说成了字节流").toBe(0);
  });
});

/**
 * ── **视频两段式与轮询的三条护栏（P3d Task 12）** ────────────────────────────
 *
 * ⚠️ **假定时器必须在发起那一次**之前**装好**（`tests/ui/dom/keys-verify.test.ts` 的
 * 「可用 / 在飞 / 刚探过：三种状态的 title 是三句不同的话，冷却到点后按钮自己恢复」
 * 那一格实测踩过：装晚了定时器排在真实队列上，`advanceTimersByTimeAsync()` 推的是
 * 另一条队列，用例会红成「轮询没跑」而真正的原因是装置本身）。
 * **只 fake `setTimeout` / `clearTimeout`**：`Date.now()` 由 `bootPanel` 的 spy 钉死，
 * 两者混在一起会让「时长上限」与「次数上限」哪一条先到说不清楚。
 * ⇒ **本组里那个 `elapsedMs` 恒为 0，所以这里量到的一律是次数那条上限**；
 * 时长那条由 `tests/ui/playground-media.test.ts` 的
 * 「轮询到达时长上限后停下 —— 只判次数的话把间隔改大就能挂上几个小时」在纯函数层钉着。
 */
/**
 * ── **评审 H1：媒体那条渲染路径的口令扫描，按出口数算覆盖面** ──────────────────
 *
 * **被守护的性质**：`buildMediaResult()` / `fillMediaResult()` / `buildMediaRow()` 这三个函数体里
 * **这道判据认得出**的每一个出口，都被那道「整页任何一处都不出现网关口令」的扫描真的跑过一次。
 * ⚠️ **「认得出」这三个字是射程，不是修辞**——射程那五条（四条够不着、一条会多认）
 * 逐条登记在 `mediaOutputsInSource()` 上方，**别把这句读成全称句**。
 *
 * ⚠️⚠️ **这一格存在的理由，是我在同一个毛病上栽的第三次。**
 * 上一版的 ⑦档写了「成功 + 失败」两个子档，并在报告里写成「成功与失败两条都覆盖」
 * ——**那句话按用例数算是对的，按出口数算是错的**：两个子档合起来只渲染了
 * `.pg-media-row` 与 `.pg-error` 两条出口，而这条路径有 17 个。
 * 评审在 `.pg-task-id` 那一行与 `.pg-poll` 那一行各种一次口令 ⇒ **905 passed，两次全绿。**
 * ⇒ **纪律落地成这一格**：出口清单**从发货代码里扫出来**（不是我手抄的），
 * 子档跑完之后**逐条比对「扫描真的跑过的出口」与「代码里真的存在的出口」**。
 *
 * ⚠️⚠️ **「加一个新出口而不给它一个子档就当场红」这句话，上一版是假的。**
 * 上一版的判据只认 `class: "字面量"` 一种写法，评审拿**仓里真实存在**的另外三种写法
 * （模板串 / 三元 / `classList.add`）各种一个带口令的新出口**在一个八个子档都到不了的
 * 分支上** ⇒ **48/48 全绿**。
 * 逃的不是口令检测（那道扫描走整棵子树，比出口清单宽），**逃的是这条闭集纪律本身**：
 * 判据认不出那个出口 ⇒ 它不进清单 ⇒ 没人要求它配一个子档。
 * ⇒ 现在这句话成立的**准确形态**（两条腿都实测过，见下面那格的变红条件）：
 * 在这两个函数体里新增一个出口，**只要 `class` 这个属性名是以字面形式写在那里的**
 * （裸 `class:` / `"class":` / `'class':` / `["class"]:` 四种，判据都认），
 * 判据要么**解得出**它的 class 名（清单变长 ⇒ 与手写表对不上 ⇒ 红），
 * 要么**解不出**（当场吵「我看见一个我读不懂的 class 表达式」⇒ 红）——这两条之外没有第三条。
 * ⚠️⚠️ **那个前提不成立时它就够不着**：属性名写成计算键 / 属性对象提到函数外 / 出口本身
 * 新增在这两个函数之外，三条都是**静默逃逸**（三条都实测过：48/48 全绿）。
 * 连同「函数体切不切得出边界」与一条会多认的，五条逐条登记在 `mediaOutputsInSource()` 上方。
 * **别把上面那句读成全称句。**
 *
 * ⚠️ **为什么不是「手写一张出口表」**：手写表与代码之间没有任何东西绑着，
 * 它会和「我以为覆盖了」一起漂——那正是本格要防的东西。
 * 手写的那一半在别处：下面 `EXPECTED_MEDIA_OUTPUTS` 是**期望的条数与名字**，
 * 它与扫出来的那份互为对照。**扫描器瞎了不需要另加一条非空锚**：这张表是手写的
 * 17 项字面量、不从扫描结果推，`expect([]).toEqual(17 项)` 自己就会响亮地红
 * （上一版在它上面还压着一条 `expect(inSource.length).toBe(17)`，注释写着
 * 「两边都空 ⇒ 下面那句会空洞地通过」——**那个理由实测为假**，删掉那条之后
 * 同一个变异照红；留着它只会在别人眼里变成「这里已经接好了」）。
 */
const EXPECTED_MEDIA_OUTPUTS = [
  "pg-body", "pg-cancelled", "pg-error", "pg-media", "pg-media-bytes", "pg-media-copy",
  "pg-media-img", "pg-media-none", "pg-media-open", "pg-media-row", "pg-media-url",
  "pg-no-task", "pg-poll", "pg-poll-gaveup", "pg-task", "pg-task-copy", "pg-task-id",
];

/**
 * 从 `i` 那个引号 / 反引号起，它收尾之后的那一格；没闭合就是 `s.length`。
 *
 * ⚠️ **模板串里的 `${…}` 整段跳过**：那里面还能再嵌字符串与模板串
 * （`` `a${b ? `c` : "d"}e` ``），所以它与 `matchBrace()` 互相递归——
 * 「读到下一个反引号就算收尾」在嵌套模板串上会提前收尾。
 */
function afterQuoted(s: string, i: number): number {
  const quote = s[i]!;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (quote === "`" && s[j] === "$" && s[j + 1] === "{") {
      const close = matchBrace(s, j + 1);
      if (close === -1) return s.length;
      j = close;
      continue;
    }
    if (s[j] === quote) return j + 1;
  }
  return s.length;
}

/**
 * 从 `i` 那个 `{` 起配平出来的那个 `}` 的下标；配不平就是 `-1`。
 * **字符串 / 模板串里的花括号不算**——这正是 `classExprAt()` 用的同一套字符扫描。
 */
function matchBrace(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (c === '"' || c === "'" || c === "`") { j = afterQuoted(s, j) - 1; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/**
 * 一个顶层 `function 名(…) { … }` 的**函数体原文**（从 `function` 那个词起，到配平出来的
 * 收尾 `}` 之前）。求不出可靠边界时返回 `{ reason }` ——调用处**当场红并打印原因**。
 *
 * ⚠️⚠️ **上一版这里是 `src.indexOf("\n}", start)`：用「第 0 列的 `}`」当函数收尾。**
 * 那是**猜**，而且是会静默破的猜——实测：往 `buildMediaRow()` 的 `return row;` 之前插一段
 * 跨行模板串，其中一行以第 0 列的 `}` 开头（`` const brk = `line1\n} line2`; ``）⇒ 函数体
 * 被截断，**再在切点之后放一个带网关口令的新出口 ⇒ 48/48 全绿**（同样的变异把 `}` 缩进两格
 * 就正常红）。整套闭集纪律架在「函数体切得完整」这个前提上，而那个前提自己会静默地破。
 * ⇒ 现在边界由**括号配平 + 字符串 / 模板串（含 `${}` 嵌套）识别**求，与读 `class:` 值表达式
 * 那一步是同一套逻辑，不再看列位置。
 *
 * ⚠️ **列位置没有被丢掉，它降级成了旁证**：配平求出来的那个 `}` 如果**不在第 0 列**，
 * 说明这次扫描被什么东西带偏了（下面那条盲点就是一种）⇒ 当场吵，**不静默截断**。
 * 两条判据同时说得通才算数（实测：把 `buildMediaRow()` 的收尾 `}` 缩进两格 ⇒ 红在这条旁证上）。
 * ⚠️⚠️ **这条旁证的前提只对被扫的这两个函数成立，别写成全称句**：它们是多行写法、
 * 收尾 `}` 在第 0 列。`admin-ui/js/theme.js` 就有一个**单行写法**的顶层函数
 * （`export function toggleTheme() { … }`），它的收尾根本不在第 0 列——
 * 哪天这两个函数改成单行写法，这条旁证要跟着改，否则它会误吵。
 */
function functionBodyOf(src: string, fn: string): { body: string } | { reason: string } {
  const head = `function ${fn}(`;
  const start = src.indexOf(head);
  if (start === -1) return { reason: `发货代码里找不到 ${head}…) —— 它被改名了，这一格的判据要跟着改` };
  if (src.indexOf(head, start + 1) !== -1) {
    return { reason: `${head}…) 在这个文件里出现了不止一次 —— 判据不知道该切哪一个` };
  }
  let depth = 0;
  let i = start + head.length - 1;                      // 就停在那个 `(` 上
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") { i = afterQuoted(src, i) - 1; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return { reason: `${fn}() 的参数表到文件结束都没有配平` };
  const open = src.indexOf("{", i);
  if (open === -1 || src.slice(i + 1, open).trim() !== "") {
    return { reason: `${fn}() 的参数表与函数体之间不是空白 —— 这不是本判据认得的函数形状` };
  }
  const close = matchBrace(src, open);
  if (close === -1) return { reason: `${fn}() 的函数体到文件结束都没有配平` };
  if (close !== 0 && src[close - 1] !== "\n") {
    return {
      reason: `${fn}() 配平求出来的收尾 } 落在行中间`
        + `（去掉注释之后的第 ${src.slice(0, close).split("\n").length} 行，不是原文件行号）、`
        + "不在第 0 列 —— 被扫的这两个函数一律顶格收尾，两条判据对不上说明这次扫描被带偏了"
        + "（例如 stripComments() 不认得的正则字面量把引号配对搞歪），判据不敢当它是函数收尾",
    };
  }
  return { body: src.slice(start, close) };
}

/**
 * `class` 那个属性名的冒号之后的表达式原文（属性名的四种写法见 `classKeySites()`）：
 * 读到**同层**的 `,` / `}` / `)` / `;` 为止。
 * 括号深度与字符串都要认——`class: f(a, b)` 里那个逗号不是分隔符。
 */
function classExprAt(body: string, from: number): string {
  let depth = 0;
  let i = from;
  for (; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"' || c === "'" || c === "`") { i = afterQuoted(body, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; continue; }
    if (depth === 0 && (c === "," || c === ";")) break;
  }
  return body.slice(from, i);
}

/** 三元的两条臂；不是三元就 `null`。**条件那一半整段丢掉**（见 `classNamesOf()`）。 */
function ternaryArms(s: string): [string, string] | null {
  let depth = 0;
  let hook = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === "`") { i = afterQuoted(s, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; continue; }
    if (depth !== 0 || c !== "?") continue;
    if (s[i + 1] === "?" || s[i + 1] === ".") { i++; continue; }   // `??` / `?.` 不是三元
    hook = i;
    break;
  }
  if (hook === -1) return null;
  let nest = 0;
  for (let i = hook + 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === "`") { i = afterQuoted(s, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; continue; }
    if (depth !== 0) continue;
    if (c === "?") { if (s[i + 1] === "?" || s[i + 1] === ".") i++; else nest++; continue; }
    if (c === ":") { if (nest === 0) return [s.slice(hook + 1, i), s.slice(i + 1)]; nest--; }
  }
  return null;
}

/**
 * 一段 class 表达式解出来的那些确定的 class 名；**解不出就是 `null`，绝不猜**。
 *
 * 解得出的三种：
 * · 字符串字面量 —— `class: "muted note pg-poll"`，**仓里到处都是**；
 * · **没有插值**的模板串 —— 与字面量等价。⚠️ **它今天在 `admin-ui/` 下 0 个调用点**
 *   （那里唯一一处 `` class: ` `` 是 `admin-ui/js/ui.js` 的 `` `toast toast-${kind || "ok"}…` ``，
 *   带插值 ⇒ 落在下面「解不出」那一档）。收它不是因为有人在写它，是因为它与字面量等价、
 *   多认一种不多一条会解错的路；
 * · 两条臂都解得出的三元 —— `admin-ui/js/sec-models.js` 的 `b.available ? … : …` 那种，**真实在用**。
 *   ⚠️ **条件那一半整段丢掉**：它里面的字符串是判据、不是 class 名。
 *   `admin-ui/js/sec-settings.js` 有一行 `effect.kind === "danger" ? "danger-text" : "muted note"`
 *   ——把 `danger` 也收进来就是「假装解得出」，而那正是本轮要改掉的毛病。
 *
 * 其余一律 `null`：**模板插值**（`admin-ui/js/ui.js` 的 `` `toast toast-${kind…}` ``）、
 * **函数调用返回**（`admin-ui/js/sec-playground.js` 的 `class: hintNoteClass()`，
 * **就在被扫的这个文件里**，返回 `pg-hint pg-hint-ok` 这一族）、字符串拼接、
 * 带转义的字面量。`null` 在调用处是**红**，不是静静跳过。
 *
 * ⚠️ **这四种「解不出」不是同一个理由，别写成一句**：
 * · **只有函数调用返回是真的解不出**——它要跨函数求值，而这个判据只看一段文本；
 * · **模板插值 / 字符串拼接 / 带转义字面量在原理上都是编译期可定的常量**
 *   （`` `pg-esc-${"t"}` `` 折出来就是 `pg-esc-t`）。不折它们是**保守取舍**：
 *   多一种解法就多一条会解错的路，而这一格要治的病正是「假装解得出」。
 *   代价明写：写成这三种的人会被逼着回来把它改成字面量，或者回来教会这道判据。
 */
function classNamesOf(raw: string): string[] | null {
  const expr = raw.trim();
  if (expr === "") return null;
  const quote = expr[0]!;
  if (quote === '"' || quote === "'" || quote === "`") {
    if (afterQuoted(expr, 0) !== expr.length) return null;          // 后面还挂着别的（拼接之类）
    const inner = expr.slice(1, -1);
    if (inner.includes("${") || inner.includes("\\")) return null;   // 插值 / 转义 ⇒ 解不出
    return inner.split(/\s+/).filter((c) => c !== "");
  }
  const arms = ternaryArms(expr);
  if (arms === null) return null;
  const a = classNamesOf(arms[0]);
  const b = classNamesOf(arms[1]);
  return a === null || b === null ? null : [...a, ...b];
}

/**
 * **`class` 这个属性名的四种字面写法。** 上一版只认裸 `class:`，于是
 * `el("p", { "class": "pg-esc-quoted" }, …)` 这种带引号的属性名整条逃掉（实测 48/48 全绿）。
 * 四种今天在 `admin-ui/` 下都只出现裸 `class:` 这一种，收另外三种是因为它们
 * **一个字符都不用改语义**就能绕过去，而绕过去是静默的。
 *
 * ⚠️⚠️ **每次现 new 一个，不许提到模块级共用。** `/g` 正则带着可变的 `lastIndex`：
 * `matchAll()` 按规范会克隆、不动原对象，所以今天两处共用是安全的——**但只要将来有人
 * 对同一个对象来一次 `.test()` / `.exec()`，`lastIndex` 就跨调用串味**。
 * 本仓已经因为这条吃过一次亏，形态记在 `tests/ui/no-hardcoded-endpoints.test.ts` 的
 * 「scan() 不受任何遗留 lastIndex 影响 —— 这条通道一旦打开，唯一的护栏会静默恒绿」那一格：
 * 一次 `.test()` 留下的非零 `lastIndex` 被 `matchAll()` 复制进克隆，扫描从中间起步、
 * **漏掉开头那一段而照常报绿**。
 * 现 new 之后这条路根本不存在，代价是每次调用多造一个正则对象。
 */
function classKeySites(): RegExp {
  return /(?:\bclass\b|"class"|'class'|\[\s*(?:"class"|'class')\s*\])\s*:/g;
}

/**
 * **不经属性名就把 class 挂上去的那些写法。** 它们在这两个函数体里出现即红——
 * 判据读不出它们挂的是什么名字，而 `admin-ui/js/app.js` 与 `admin-ui/js/sec-settings.js`
 * 里各有几处真实调用点，**不是假想写法**。
 * 同样每次现 new（理由见 `classKeySites()`）。
 */
function classMutators(): RegExp {
  return /\bclassList\b|\bclassName\b|setAttribute\(\s*["']class["']/g;
}

/**
 * 从**发货代码**里扫出媒体那三个渲染函数真的画出来的 `pg-*` class。
 *
 * ⚠️ `stripComments()` 用 `tests/helpers/strip-comments.ts` 那一份（本仓裁定：不许抄第六份）
 * ——不去注释的话，那几个函数上方的说明文字里也有 `class:` 这样的字样。
 * ⚠️ **函数体边界由 `functionBodyOf()` 求**（括号配平 + 字符串 / 模板串识别），
 * 不再用「下一个顶格 `}`」猜——那个前提会静默地破，机理与实测写在那个函数上方。
 * 求不出边界时它给一条 `reason`，下面第一条断言当场把原因打出来，**不静默截断**。
 *
 * ── 射程五条（明写，别把上面那句读成全称句；①–④ 够不着，⑤ 会多认）─────────────
 * ① **出口新增在这两个函数之外**：`buildTurn()` 的 `turn.mode !== "chat"` 分支、
 *    或将来第三个媒体 helper ⇒ **不进清单、这道判据看不见它，也不会吵**。今天那条分支里
 *    只有一句 `appendChild(buildMediaResult(turn))`，射程内为空——**这是「今天为空」，
 *    不是「结构上不可能」**，加第三个媒体 helper 的人必须把它加进 `EXPECTED_MEDIA_OUTPUTS`。
 *    实测（往那条分支里加一个带口令的出口）：**48/48 全绿**。
 *    （出口**搬出**这几个函数是另一回事：扫到的少了 ⇒ 与手写表对不上 ⇒ 红。）
 *    ⚠️⚠️ **`fillMediaResult` 这个名字就是这么来的，如实记一笔**：P3d 全分支评审 F-2
 *    的处置把 `buildMediaResult()` 的函数体拆出来给「轮询那一拍就地重填」复用，
 *    **17 个出口于是整体搬进了新函数**——这一格当场红成「扫到 1 项 vs 手写 17 项」，
 *    ①那条射程说的正是它。**红了才把名字补进下面那张表，不是先补名字再改代码**：
 *    先补的话，这道判据在这次搬迁上一次都没有响过，而它存在的全部理由就是响这一次。
 * ② **属性名不是字面量**：`el("p", { [K]: "…" }, …)`（`K` 是变量）、`{ ...ATTRS }` 展开
 *    ⇒ `classKeySites()` 是词法钩子，它只认写死在那里的名字。实测（计算键 + 带口令）：**48/48 全绿**。
 * ③ **属性对象整个提到这两个函数之外**：`const ESC = { class: "…" };` 写在模块级、
 *    调用处只写 `el("p", ESC, …)` ⇒ `class:` 那个站点不在被切的函数体里。实测 48/48 全绿。
 * ④ **含引号的正则字面量**：`stripComments()` 自己登记着「不认得正则字面量」，
 *    `/["']/` 这种会把引号配对搞歪。**实测这一形态是红的**：往 `buildMediaRow()` 里插一句
 *    `const q = /["']/.test(url);` 再在它后面加一个带口令的新出口 ⇒ 引号配对一路歪到文件末尾
 *    ⇒ 「函数体到文件结束都没有配平」⇒ 红。**但这不是全称保证**：若配歪之后恰好仍在某个
 *    顶格 `}` 上收平，被跳过那段里的出口会静默丢掉——**这一条今天没有构造出来，登记为盲点。**
 *    被扫的这三个函数里今天唯一的正则字面量是 `fillMediaResult()` 的
 *    `/^application\/json/i`，**不含引号也不含花括号** ⇒ 射程内为空。
 *    （`admin-ui/js/` 别处还有一处：`admin-ui/js/sec-settings.js` 的 `/^env:/`，同样不含引号，
 *    而且本来就不在这道判据的射程里——**这句话原先写成「`admin-ui/js/` 下唯一」，是假的，
 *    实地数过之后改真**。）
 * ⑤（反方向的一条，一并登记）**字符串里出现 `class:` 字样**会被当成一个站点。
 *    方向是保守的：它多半解不出 ⇒ 吵，而不是静默少给。
 *
 * ②③④ 今天在**被扫的这两个函数体里**都没有真实写法（逐条 grep 过：admin-ui 下 0 处计算键、
 * 0 处把 attrs 当变量传的 `el()` 调用、0 处含引号的正则字面量）。
 * ⚠️ **但别把这句读成「仓里没人这么写」**：`{ ...attrs }` 展开在 `admin-ui/js/ui.js` 的
 * `elI18n()` 里就是**真实写法**（`el(tag, { ...(attrs || {}), "data-i18n": key })`），
 * 它只是不在这两个函数体里。带引号的属性名（`"class":` / `'class':` / `["class"]:`）
 * 上一版也逃得掉，这一版由 `classKeySites()` 收进来了。
 */
function mediaOutputsInSource(): string[] {
  const src = stripComments(readFileSync("admin-ui/js/sec-playground.js", "utf8"));
  const out = new Set<string>();
  const unreadable: string[] = [];
  const unsliceable: string[] = [];
  for (const fn of ["buildMediaRow", "buildMediaResult", "fillMediaResult"]) {
    const sliced = functionBodyOf(src, fn);
    if ("reason" in sliced) { unsliceable.push(sliced.reason); continue; }
    const body = sliced.body;
    for (const m of body.matchAll(classKeySites())) {
      const expr = classExprAt(body, m.index! + m[0].length).trim();
      const names = classNamesOf(expr);
      if (names === null) unreadable.push(`${fn}(): ${m[0]} ${expr}`);
      else for (const cls of names) if (cls.startsWith("pg-")) out.add(cls);
    }
    for (const m of body.matchAll(classMutators())) unreadable.push(`${fn}(): ${m[0]}`);
  }
  // **认不出边界要吵，不能静默截断。** 切短了的那一截尾巴是判据看不见也不吵的地方，
  // 新出口藏进去能带着网关口令一起绿——上一版实测过这条，机理见 `functionBodyOf()`。
  // ⚠️ **这条闸买的是「病因说得对」，不是「红不红」**（控制实测，别把它写成唯一护栏）：
  // 把这条 `expect` 临时拿掉、再把 `buildMediaRow()` 的收尾 `}` 缩进两格 ⇒ 那个函数被整个
  // 跳过 ⇒ **仍然红**，但红在下面「与手写清单对不上」（13 项 vs 17 项），报的是错的病因。
  expect(unsliceable, "媒体那几个渲染函数的函数体切不出可靠边界 —— "
    + "在边界求得回来之前，这道闭集纪律对被切掉的那一段整个失效，所以这里宁可红也不猜")
    .toEqual([]);
  // **认不出要吵，不能装没看见。** 这一条就是上一版缺的那道闸：判据读不懂的写法
  // 会让新出口悄悄不进清单，于是「每个出口都配了子档」这条纪律对它整个失效。
  expect(unreadable, "媒体那几个渲染函数里有这道判据读不懂的 class 写法 —— "
    + "它画出来的出口不会进清单、也就没人要求它配一个子档。"
    + "要么把它写成字面量 / 无插值模板串 / 两臂都是字面量的三元，要么把这道判据教会")
    .toEqual([]);
  return [...out].sort();
}

describe("媒体渲染路径的口令扫描：按出口数算覆盖面（评审 H1）", () => {
  /** 把这一轮真的渲染出来的媒体出口收上来。 */
  function outputsRendered(sec: FakeElement): string[] {
    const out = new Set<string>();
    for (const n of everyNode(sec)) {
      for (const cls of (n.getAttribute("class") || "").split(/\s+/)) {
        if (cls.startsWith("pg-") && EXPECTED_MEDIA_OUTPUTS.includes(cls)) out.add(cls);
      }
    }
    return [...out];
  }

  const CREATE_URL = `${PANEL_ORIGIN}/v1/videos`;

  /** 起一轮媒体请求：切档、粘口令、写提示词、按发送。 */
  async function send(respond: Responder, modeName: string): Promise<{ h: Harness; sec: FakeElement }> {
    const h = await openPg(respond);
    const sec = h.section("playground");
    toMode(sec, modeName);
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "口令扫描探针");
    one(sec, ".pg-send").click();
    await settle(20);
    return { h, sec };
  }

  /** 建任务成功、之后一直「进行中」的假上游（轮询那几个出口都要靠它）。 */
  const videoPending: Responder = respondWith({
    gateway: (url) => (url === CREATE_URL
      ? { status: 200, body: { id: "task-1", status: "queued" } }
      : { status: 200, body: { id: "task-1", status: "processing" } }),
  });

  /**
   * 八个子档，**每一个都带前置条件**（断言它真的渲染出了它负责的那几个出口），
   * 然后各跑一次整页口令扫描。
   *
   * **变红条件（两处，都是评审当场种过、当时 ESCAPED 的那两处，见 progress note M31/M32）**：
   * · 往 `.pg-task-id` 那一行加 `` title: `task ${turn.taskId} auth=${token}` `` ⇒ 红；
   * · 往 `.pg-poll` 那一行加 `` title: `auth=${token}` `` ⇒ 红。
   *
   * **闭集纪律那一半的变红条件（六条，逐条实测，见 progress note 的 M35–M40）**：
   * 统一落点是往 `fillMediaResult()` 里加一个八个子档都到不了的新出口
   * （条件 `turn.status !== null && turn.status >= 400`），只换它 class 的写法 ——
   * · 字面量 `class: "pg-esc-lit"` ⇒ 解得出 ⇒ 清单多一项 ⇒ 与手写表对不上 ⇒ 红；
   * · 两臂都是字面量的三元 ⇒ 解得出（两项都进）⇒ 红；
   * · 无插值模板串 ⇒ 解得出 ⇒ 红；
   * · 模板插值 `` class: `pg-esc-${"t"}` `` ⇒ **解不出** ⇒ 判据吵「读不懂」⇒ 红；
   * · 函数调用返回 —— **逐字抄仓里真实那一行**：`class: hintNoteClass()` ⇒ 解不出 ⇒ 红，
   *   失败信息打的就是 `fillMediaResult(): class: hintNoteClass()`；
   * · `errNode.classList.add("pg-esc-cl")` ⇒ 撞上 `classMutators()` ⇒ 红。
   * ⚠️⚠️ **这六条落的都是「八个子档一档都到不了」的分支，口令扫描根本看不见它们**
   * ——控制实测：把上面那条「读不懂」的断言临时拿掉，模板插值那条**带着口令**照样
   * **48/48 全绿**。⇒ 兜住「两层同时瞎」的只有闭集纪律这一条，不是口令扫描。
   *
   * **第四轮补的两条变红条件（两条都是上一版当场 48/48 全绿的活逃逸）**：
   * · **带引号的属性名** `el("p", { "class": "pg-esc-quoted" }, …)`（还是那个不可达分支、
   *   还是带着口令）⇒ 上一版 `\bclass\s*:` 不匹配 ⇒ **48/48 全绿**；这一版由
   *   `classKeySites()` 收进来 ⇒ **红**；
   * · **函数体尾巴**：往 `buildMediaRow()` 的 `return row;` 之前插一段跨行模板串、
   *   其中一行以第 0 列的 `}` 开头，再在切点之后加一个带口令的新出口 ⇒ 上一版函数体被
   *   截断、**48/48 全绿**；这一版边界由 `functionBodyOf()` 配平求出 ⇒ **红**。
   * ⚠️ **反向控制四条**（证明判据不是「见什么都红」）：把已有的
   * `class: "muted note pg-poll"` 换成同名的三元 / 无插值模板串 ⇒ **48/48 仍绿**；
   * 把已有的 `class: "pg-media-row"` 换成 `"class": "pg-media-row"` / `["class"]: …`
   * ⇒ **48/48 仍绿**（新收的三种属性名写法是「认得出」，不是「一见就红」）。
   */
  it("媒体那几个渲染函数里这道判据认得出的每一个出口，都被口令扫描跑过 —— 覆盖面按出口数算，不按用例数算；认不出的那几条射程写在 mediaOutputsInSource() 上方（评审 H1）", async () => {
    const seen = new Set<string>();
    const record = (h: Harness, sec: FakeElement, where: string): void => {
      expect(one(sec, ".pg-token").value, `${where}：前置条件，口令确实在输入框里`).toBe(GW_TOKEN);
      for (const c of outputsRendered(sec)) seen.add(c);
      expectNoTokenAnywhere(h, where);
    };

    // ── ⑦a 图片成功：远端地址 + data 图片 + 一条不在白名单里的
    //    ⇒ pg-media / pg-media-row / pg-media-url / pg-media-copy / pg-media-open / pg-media-img / pg-body
    {
      const { h, sec } = await send(respondWith({
        gateway: () => ({ status: 200, body: { created: 1, data: [
          { url: "https://cdn.invalid/a.png" },
          { url: "data:image/png;base64,iVBORw0KGgo=" },
          { url: "javascript:alert(1)" },
        ] } }),
      }), "image");
      expect(pick(sec, ".pg-media-open").length, "前置条件：链接那条出口得真的画出来").toBe(1);
      expect(pick(sec, ".pg-media-img").length, "前置条件：内嵌那条出口得真的画出来").toBe(1);
      expect(pick(sec, ".pg-body").length, "前置条件：响应原文那条出口得真的画出来").toBe(1);
      record(h, sec, "媒体·图片成功档");
    }

    // ── ⑦b 传输失败 ⇒ pg-error
    vi.unstubAllGlobals();
    {
      const { h, sec } = await send(respondWith({ gateway: () => { throw new Error("boom"); } }), "image");
      expect(pick(sec, ".pg-error").length, "前置条件：错误那条出口得真的画出来").toBe(1);
      record(h, sec, "媒体·传输失败档");
    }

    // ── ⑦c 上游直接回字节流 ⇒ pg-media-bytes
    vi.unstubAllGlobals();
    {
      const { h, sec } = await send(respondWith({
        gateway: () => ({ status: 200, body: null, raw: "PNG-NOT-JSON", contentType: "image/png" }),
      }), "image");
      expect(pick(sec, ".pg-media-bytes").length, "前置条件：字节流那条出口得真的画出来").toBe(1);
      record(h, sec, "媒体·字节流档");
    }

    // ── ⑦d 一份 JSON 但里面没有地址 ⇒ pg-media-none
    vi.unstubAllGlobals();
    {
      const { h, sec } = await send(respondWith({
        gateway: () => ({ status: 200, body: { created: 1 } }),
      }), "image");
      expect(pick(sec, ".pg-media-none").length, "前置条件：没有地址那条出口得真的画出来").toBe(1);
      record(h, sec, "媒体·响应里没有地址档");
    }

    // ── ⑦e 视频建任务但拿不到标识 ⇒ pg-no-task
    vi.unstubAllGlobals();
    {
      const { h, sec } = await send(respondWith({
        gateway: () => ({ status: 200, body: { status: "queued", note: "no id here" } }),
      }), "video");
      expect(pick(sec, ".pg-no-task").length, "前置条件：没有任务标识那条出口得真的画出来").toBe(1);
      record(h, sec, "媒体·没有任务标识档");
    }

    // ── ⑦f 视频**正在轮询** ⇒ pg-task / pg-task-id / pg-task-copy / pg-poll
    //    ⚠️ **这一档是评审两次种植里的第二处，也是屏幕上停留最久的那一档。**
    vi.unstubAllGlobals();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    {
      const { h, sec } = await send(videoPending, "video");
      expect(pick(sec, ".pg-poll").length, "前置条件：轮询进度那条出口得真的画出来").toBe(1);
      expect(one(sec, ".pg-task-id").textContent, "前置条件：任务标识那条出口得真的画出来").toBe("task-1");
      expect(pick(sec, ".pg-task-copy").length, "前置条件：任务标识的复制按钮得真的画出来").toBe(1);
      record(h, sec, "媒体·视频轮询中档");
    }
    vi.useRealTimers();

    // ── ⑦g 视频**轮询到点放弃** ⇒ pg-poll-gaveup
    //    ⚠️ **靠推时钟越过时长上限到达，不是轮 60 次**：既省 60 拍，又顺带让
    //    「时长那条上限」在 DOM 层第一次变成可观测的（上一版报告把它登记成不可观测）。
    vi.unstubAllGlobals();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    {
      const { h, sec } = await send(videoPending, "video");
      expect(pick(sec, ".pg-poll").length, "前置条件：得先真的轮起来").toBe(1);
      vi.spyOn(Date, "now").mockReturnValue(NOW + 400_000);   // 越过 300000 那条时长上限
      await vi.advanceTimersByTimeAsync(5_000);
      await settle(20);
      expect(pick(sec, ".pg-poll-gaveup").length, "前置条件：放弃那条出口得真的画出来").toBe(1);
      expect(pick(sec, ".pg-poll").length, "放弃了却还在说「正在轮询」").toBe(0);
      record(h, sec, "媒体·视频轮询放弃档");
    }
    vi.useRealTimers();

    // ── ⑦h 视频轮询**被取消** ⇒ pg-cancelled
    vi.unstubAllGlobals();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    {
      const { h, sec } = await send(videoPending, "video");
      expect(pick(sec, ".pg-cancel").length, "前置条件：轮询期间得有取消按钮").toBe(1);
      one(sec, ".pg-cancel").click();
      await settle(20);
      expect(pick(sec, ".pg-cancelled").length, "前置条件：取消那条出口得真的画出来").toBe(1);
      record(h, sec, "媒体·视频取消档");
    }
    vi.useRealTimers();

    // ── **收口：扫描真的跑过的出口 === 代码里真的存在的出口。** ────────────────
    const inSource = mediaOutputsInSource();
    // 反向自检：手写的那份与扫出来的那份对得上（两边独立，互为对照）。
    // ⚠️ 上一版这里还压着一条 `expect(inSource.length).toBe(17)`，理由写的是
    // 「扫描器瞎了 ⇒ 两边都空 ⇒ 下面那句会空洞地通过」——**实测为假**：手写表是
    // 17 项字面量、不从扫描结果推，`expect([]).toEqual(17 项)` 自己就会红，
    // 而且它只会抢在前面报一个错的病因（「一个都没扫到」在扫到 18 / 13 时照样打印）。
    expect(inSource, "发货代码里的媒体出口与手写清单对不上 —— 加了新出口就把它加进来，并给它一个子档")
      .toEqual(EXPECTED_MEDIA_OUTPUTS);
    // 真正的断言：**每一个出口都被上面某个子档渲染过、因而被口令扫描跑过。**
    expect([...seen].sort(), "有媒体出口从来没被口令扫描跑过 —— 覆盖面按出口数算，不按用例数算")
      .toEqual(EXPECTED_MEDIA_OUTPUTS);
  });
});

describe("视频两段式：建任务 + 轮询，以及那三条护栏", () => {
  const CREATE = `${PANEL_ORIGIN}/v1/videos`;
  const POLL = `${PANEL_ORIGIN}/v1/videos/task-1`;

  /** 建任务回一个任务标识；轮询第 `until` 次才给成片，在那之前一直是「进行中」。 */
  function videoResponder(until: number): Responder {
    let polls = 0;
    return respondWith({
      gateway: (url) => {
        if (url === CREATE) return { status: 200, body: { id: "task-1", status: "queued" } };
        polls++;
        return polls >= until
          ? { status: 200, body: { id: "task-1", status: "completed", url: "https://cdn.invalid/v.mp4" } }
          : { status: 200, body: { id: "task-1", status: "processing" } };
      },
    });
  }

  /** 永远给「进行中」：只有上限才停得住它。 */
  function neverDone(): Responder {
    return respondWith({
      gateway: (url) => (url === CREATE
        ? { status: 200, body: { id: "task-1", status: "queued" } }
        : { status: 200, body: { id: "task-1", status: "processing" } }),
    });
  }

  async function startVideo(respond: Responder): Promise<{ h: Harness; sec: FakeElement }> {
    const h = await openPg(respond);
    const sec = h.section("playground");
    toMode(sec, "video");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "一只猫在跑");
    one(sec, ".pg-send").click();
    await settle(20);
    return { h, sec };
  }

  /** 推一拍：让排着的那次打点跑完。 */
  async function tick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(20);
  }

  const pollCount = (h: Harness): number => h.calls.filter((c) => c.url === POLL).length;

  /**
   * **两段式真的是两段，而且第二段打的是带任务标识的那条路径。**
   *
   * ⚠️ **观测点落在 `h.calls` 上（真的发出去的那几条 URL），不落在屏幕文字上**：
   * 屏幕上那条地址是被测代码自己渲染的，它只能证明面板说了什么。
   *
   * **变红条件（三条，逐条实测，见 progress note 的 M16/M17/M18）**：
   * ① 把 `startPolling()` 的返回值改成恒 `false` ⇒ 一次轮询都不发 ⇒ 红；
   * ② 把 `buildPollRequest()` 里的占位符替换去掉 ⇒ 打的是带字面量占位符的那条 ⇒ 红；
   * ③ 把 `pollOnce()` 里「收到地址就停」那句删掉 ⇒ 会一直轮到上限 ⇒ 调用条数那条红。
   */
  it("建任务之后自己去轮询，轮到成片就停 —— 打的是带任务标识的那条路径，不是建任务那条", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { h, sec } = await startVideo(videoResponder(3));

    // 第一段：建任务。**这一刻还一次轮询都没发**。
    expect(h.calls.filter((c) => c.url.startsWith(PANEL_ORIGIN)).map((c) => c.url)).toEqual([CREATE]);
    expect(one(sec, ".pg-task-id").textContent, "任务标识没被摆出来 —— 到点之后运维拿什么再查").toBe("task-1");
    expect(pick(sec, ".pg-poll").length, "没有任何一句在说它正在轮询").toBe(1);
    // 护栏：轮询期间在飞标记不松开（全局约束 14），取消按钮一直在。
    expect(one(sec, ".pg-send").disabled, "轮询期间发送按钮还能按 —— 第二条任务会叠着烧配额").toBe(true);
    expect(pick(sec, ".pg-cancel").length, "轮询期间没有取消按钮 —— 运维停不下来").toBe(1);

    await tick();
    await tick();
    await tick();
    vi.useRealTimers();

    expect(h.calls.filter((c) => c.url.startsWith(PANEL_ORIGIN)).map((c) => c.url))
      .toEqual([CREATE, POLL, POLL, POLL]);
    expect(h.calls.filter((c) => c.url === POLL).every((c) => c.method === "GET"), "轮询没走 GET").toBe(true);
    // 成片到了：地址画出来、轮询那句话没了、在飞标记松开。
    expect(one(sec, ".pg-media-url").textContent).toBe("https://cdn.invalid/v.mp4");
    expect(pick(sec, ".pg-poll").length, "已经拿到成片了还在说「正在轮询」").toBe(0);
    expect(one(sec, ".pg-send").disabled, "轮询结束了发送按钮还灰着").toBe(false);
  });

  /**
   * **护栏 ①：有上限。** 一个忘了关的标签页就是一台永动打点机，
   * 而每一次打点都是一次**真的**上游请求，烧的是运维自己的配额。
   *
   * ⚠️ 期望值 `60` **手写字面量**（第 6 种假阳性：不写 `VIDEO_POLL_MAX_ATTEMPTS`）。
   * **变红条件**：把 `videoPollNext()` 里那句次数判定删掉 ⇒ 打点条数会一直涨 ⇒ 红。
   */
  it("轮询到达上限后停下并把任务标识留在屏幕上 —— 无限轮就是一台永动打点机", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { h, sec } = await startVideo(neverDone());
    for (let i = 0; i < 70; i++) await tick();
    // **计时器条数要在收假定时器**之前**读**：`useRealTimers()` 之后 `getTimerCount()`
    // 直接抛「timers APIs are not mocked」，那会红成一个与被测性质无关的病因。
    const timersLeft = vi.getTimerCount();
    vi.useRealTimers();

    expect(pollCount(h), "打点次数不等于手写的那个上限").toBe(60);
    expect(pick(sec, ".pg-poll-gaveup").length, "到点了却什么都不说 —— 屏幕上留下一个永远「进行中」的框").toBe(1);
    expect(one(sec, ".pg-task-id").textContent, "停下来了却把任务标识收走了 —— 运维拿什么再查").toBe("task-1");
    expect(one(sec, ".pg-send").disabled, "轮询停了发送按钮还灰着").toBe(false);
    expect(timersLeft, "停下来了还留着一个定时器").toBe(0);
  });

  /**
   * **护栏 ②：页面藏起来时暂停，变回可见时接回去。**
   *
   * ⚠️ **边界明写：这道护栏拦的是「排下一拍」，不是「已经排好的那一拍」**
   * （`js/sec-events.js` 的 `scheduleNext()` 是同一个形态与同一条边界）。
   * ⇒ 藏起来之后**已经上膛的那一次照样会响**，然后才停。
   * 这一格因此断言的是 `1 → 2 → 2 → 2`，不是 `1 → 1`。
   * **把它写成 `1 → 1` 的话，红的原因会是这条边界而不是护栏失效**——
   * 那正是「ESCAPED 有两种成因」里的第二种（观测点不对）。
   *
   * 变红条件（两条，逐条实测，见 progress note 的 M19/M20）：
   * ① 把 `schedulePoll()` 里那句判页面藏没藏起来的早退删掉 ⇒ 后面两拍照样打点
   *    ⇒ 「藏起来之后不再排下一拍」那条断言从 2 变成 4 ⇒ 红；
   * ② 把那个 `visibilitychange` 监听删掉 ⇒ 变回可见之后再也不轮 ⇒ 最后一条红。
   */
  it("页面藏起来时不再排下一拍，变回可见时接回去 —— 一个切到后台的标签页不该继续烧配额", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { h } = await startVideo(neverDone());
    await tick();
    expect(pollCount(h), "前置条件：可见时它本来是会打点的").toBe(1);

    h.dom.document.hidden = true;
    await tick();
    // 已经上膛的那一拍响了（护栏拦不住它，见上面那段边界），**但它没有再排下一拍**。
    expect(pollCount(h), "上膛的那一拍没响 —— 观测点不对，见上面那段边界").toBe(2);
    const timersWhileHidden = vi.getTimerCount();
    await tick();
    await tick();
    expect(pollCount(h), "页面藏起来了还在排下一拍").toBe(2);
    expect(timersWhileHidden, "藏起来之后还留着一个上了膛的定时器").toBe(0);

    h.dom.document.hidden = false;
    h.dom.document.dispatchEvent(new h.dom.CustomEvent("visibilitychange"));
    await settle(20);
    await tick();
    vi.useRealTimers();
    expect(pollCount(h), "变回可见之后再也没接回去 —— 那一轮永远停在「进行中」").toBe(3);
  });

  /**
   * ── **P3d 全分支评审 F-2：轮询那一拍不许整版重画** ────────────────────────────
   *
   * **被守护的性质**：视频轮询最多 60 拍，**每一拍在屏幕上唯一会变的只有正在轮的
   * 那一个盒子**。上一版每一拍都跑一次 `render()`，而 `render()` 把**全部历史轮次**
   * 从头重建——每一轮都要走一次 `mediaResultUrls()`（整棵 JSON 树）加一次
   * `prettyJson()`（无长度上限）。与 Task 12 的「`turn.body` 可能是一张 MB 级 base64 图」
   * 相乘之后，一次视频任务的重建量实测 ≈ 1.8 GB 临时字符串（`turns=10`）。
   *
   * ⚠️⚠️ **观测点是节点对象的身份，不是屏幕上的文字**：整版重画之后文字长得一模一样，
   * **只有「还是不是同一个对象」分得开这两种实现**。少了这一条，
   * 把 `pollOnce()` 改回 `render()` 这一格照样全绿。
   * ⚠️⚠️ **反过来说，这一格证明不了「两条路径输出等价」，别把它读大了**（复评 H2）：
   * 上一轮就是靠这一格全绿声称「输出逐字不变」的，而那句话**当时是假的**
   *（`.pg-status` 画在盒子外面，非 2xx 轮询期间屏幕上是上一拍那个数字）。
   * 等价性由下面那一组「就地重填与整版重建输出逐字相同（六场景逐节点逐属性）」守，
   * 那是一次输出比对，不是身份比对。**两组缺一不可，方向相反。**
   *
   * ⚠️ **必须先有一轮历史**：只有一轮时「整版重建」与「重填这一个盒子」的代价同阶，
   * 这一格也就没有鉴别力——真正被放大的是**前面那些轮次**。所以这里先发一轮图片、
   * 再发那一轮视频，断言落在**第一轮**那个节点上。
   *
   * ⚠️ **配一条反向控制**：进度那句话必须真的往前走。少了它，
   * 把整个就地重填删掉（一拍什么都不更新）同样能让身份那两条全绿
   * ——那会让屏幕停在「已经查过 1 次」直到五分钟后收尾，而它「看起来」没坏。
   *
   * **变红条件（都实测过）**：把 `pollOnce()` 里那段就地重填换回 `render()`
   * ⇒ 前两条身份断言当场红（右栏整棵被换掉）。
   */
  it("轮询那一拍不整版重画 —— 右栏别的轮次必须还是原来那几个节点对象", async () => {
    const IMAGE_URL = `${PANEL_ORIGIN}/v1/images/generations`;
    const respond = respondWith({
      gateway: (url) => {
        if (url === IMAGE_URL) return { status: 200, body: { data: [{ url: "https://cdn.invalid/a.png" }] } };
        if (url === CREATE) return { status: 200, body: { id: "task-1", status: "queued" } };
        return { status: 200, body: { id: "task-1", status: "processing" } };
      },
    });
    const h = await openPg(respond);
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    // 第一轮：图片。**它就是「历史轮次」**，此后每一次整版重画都要把它重建一遍。
    toMode(sec, "image");
    typePrompt(sec, "一只猫");
    one(sec, ".pg-send").click();
    await settle(20);
    // 第二轮：视频，它会起轮询。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    toMode(sec, "video");
    typePrompt(sec, "一只猫在跑");
    one(sec, ".pg-send").click();
    await settle(20);

    const turnsBefore = pick(sec, ".pg-turn");
    expect(turnsBefore.length, "前置条件：右栏得真的有两轮，否则这一格没有鉴别力").toBe(2);
    const boxesBefore = pick(sec, ".pg-media");
    expect(pick(sec, ".pg-poll").length, "前置条件：得真的轮起来").toBe(1);
    const pollTextBefore = one(sec, ".pg-poll").textContent;

    await tick();
    await tick();
    vi.useRealTimers();

    const turnsAfter = pick(sec, ".pg-turn");
    expect(turnsAfter.length).toBe(2);
    // **身份比较**：整版重画会把这两个节点全换成新对象。
    expect(turnsAfter[0], "第一轮那个节点被换掉了 —— 轮询那一拍又整版重画了").toBe(turnsBefore[0]);
    expect(turnsAfter[1], "正在轮的那一轮外壳也被换掉了 —— 重填的应当只有里面那个盒子").toBe(turnsBefore[1]);
    expect(pick(sec, ".pg-media")[0], "第一轮那个媒体盒子被重建了").toBe(boxesBefore[0]);
    // 反向控制：进度那句话真的往前走了（否则「一拍什么都不做」也能让上面几条全绿）。
    expect(one(sec, ".pg-poll").textContent, "轮了两拍，进度那句话一个字都没变").not.toBe(pollTextBefore);
    expect(pollCount(h), "前置条件：这两拍是真的打出去了").toBe(2);
  });

  /**
   * **护栏 ③：切走板块停轮询**（板块契约，设计 §9.3）。
   * 变红条件：把 `cancelInFlight()` 里那段清定时器 / 清那一轮的代码删掉
   * ⇒ 切走之后那台打点机还在跑，而屏幕上已经没有任何东西提到这一轮了。
   */
  it("切走板块之后一次都不再打点 —— 屏幕上已经没有这一轮了，它却还在烧配额", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { h } = await startVideo(neverDone());
    await tick();
    expect(pollCount(h), "前置条件：切走之前它本来是在打点的").toBe(1);

    navTo(h, "overview");
    await settle(20);
    // **切走那一刻定时器就该没了**（`onHide()` → `cancelInFlight()`），
    // 与上面那道「藏起来」的护栏不同：那一道只拦「排下一拍」，这一道连膛里那发一起卸。
    const timersAfterHide = vi.getTimerCount();
    await tick();
    await tick();
    vi.useRealTimers();
    expect(pollCount(h), "切走板块之后还在打点").toBe(1);
    expect(timersAfterHide, "切走板块之后还留着一个上了膛的定时器").toBe(0);
  });

  /**
   * **取不到任务标识时不猜、也不轮。**
   * 变红条件：把 `videoTaskIdOf()` 改成「随便找一个过得了形状判据的字符串」
   * ⇒ `"queued"` 会被当成任务标识 ⇒ 面板会去轮一个不存在的任务，直到轮满上限。
   */
  it("建任务的响应里没有任务标识时一次都不轮，并且明说是哪一档 —— 猜一个出来只会轮空 60 次", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { h, sec } = await startVideo(respondWith({
      gateway: () => ({ status: 200, body: { status: "queued", note: "no id here" } }),
    }));
    await tick();
    await tick();
    vi.useRealTimers();

    expect(
      h.calls.filter((c) => c.url.startsWith(`${PANEL_ORIGIN}/v1/videos/`)).length,
      "没有标识却发了轮询",
    ).toBe(0);
    expect(pick(sec, ".pg-no-task").length, "没有标识这件事一个字都没说").toBe(1);
    expect(pick(sec, ".pg-task-id").length, "没有标识却画出了一行任务标识").toBe(0);
    expect(one(sec, ".pg-send").disabled, "没轮起来却把发送按钮一直灰着").toBe(false);
  });

  /**
   * **上游一次就把成片给了的话，一次都不该轮。**
   * 少了这一格，「收到地址就停」那条判据只在「轮了几次之后」被验过，
   * 而「第一段就给了」是它的另一条分支。
   */
  it("建任务那一次就带回成片时一次都不轮 —— 白轮一次是白烧一次配额", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { h, sec } = await startVideo(respondWith({
      gateway: () => ({
        status: 200, body: { id: "task-1", status: "completed", url: "https://cdn.invalid/v.mp4" },
      }),
    }));
    const timersLeft = vi.getTimerCount();
    await tick();
    vi.useRealTimers();
    expect(
      h.calls.filter((c) => c.url.startsWith(`${PANEL_ORIGIN}/v1/videos/`)).length,
      "成片已经到了还去轮了一次",
    ).toBe(0);
    expect(one(sec, ".pg-media-url").textContent).toBe("https://cdn.invalid/v.mp4");
    expect(timersLeft, "不该轮却排了一个定时器").toBe(0);
  });

  /**
   * ── **P3d 修复定向复评 H2：轮询那一拍显示的状态码必须是这一拍的** ──────────────
   *
   * **这一格断的是屏幕上的字，不是节点身份。** 上面那格
   * 「右栏别的轮次必须还是原来那几个节点对象」只比对象身份，
   * 而这条回归恰恰是**节点还是那一个、上面写的数字是编的**：
   * `pollOnce()` 每一拍都写 `turn.status = r.status`，而 `.pg-status` 由 `buildTurn()`
   * 画在 `foot` 上、**不在那个被就地重填的 `.pg-media` 盒子里** ⇒
   * 只重填盒子的话它会一直停在建任务那一拍的 `200`，
   * 而同一屏上贴着的响应原文已经是上游那句 `upstream boom` 了。
   *
   * **可达性不是假想**：轮询期间上游回 429 / 500 / 404（限流、任务过期、被回收）
   * 都走到这里，而**面板不会因为非 2xx 就停**（停下来的判据是「拿到地址」或「传输失败」），
   * 所以那个编出来的数字最长挂到轮询结束（上限 60 拍）。
   *
   * **变红条件（实测）**：把 `pollOnce()` 里那句
   * `if (nodes.pollStatus !== null) nodes.pollStatus.textContent = String(turn.status);` 删掉
   * ⇒ 这一格红成 `200 !== 500`。
   */
  it("轮询回非 2xx 时状态码那一格显示的是这一拍的数字 —— 屏幕不许贴着错误正文说 200", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { h, sec } = await startVideo(respondWith({
      gateway: (url) => (url === CREATE
        ? { status: 200, body: { id: "task-1", status: "queued" } }
        : { status: 500, body: { error: { message: "upstream boom" } } }),
    }));
    expect(one(sec, ".pg-status").textContent, "前置条件：建任务那一次本来就是 200").toBe("200");

    await tick();
    expect(pollCount(h), "前置条件：这一拍真的打出去了").toBe(1);
    expect(
      one(sec, ".pg-status").textContent,
      "轮询回的是 500，屏幕上却还挂着上一拍的 200 —— 旁边就贴着上游的错误正文，"
      + "**两句话互相矛盾，而前一句是编的**",
    ).toBe("500");
    expect(
      one(sec, ".pg-body").textContent,
      "前置条件：那句矛盾的另一半（上游的错误正文）真的在同一屏上，否则这一格没有鉴别力",
    ).toContain("upstream boom");

    // 反向控制：它不是被写死成 500 的 —— 下一拍回 404 时它得跟着变。
    h.respond(respondWith({
      gateway: (url) => (url === CREATE
        ? { status: 200, body: { id: "task-1", status: "queued" } }
        : { status: 404, body: { error: { message: "task expired" } } }),
    }));
    await tick();
    vi.useRealTimers();
    expect(pollCount(h), "非 2xx 之后它本来该接着轮（停的判据是拿到地址 / 传输失败）").toBe(2);
    expect(one(sec, ".pg-status").textContent, "状态码那一格不跟这一拍走 —— 它被钉死在某个数字上了").toBe("404");
  });

  /**
   * ── **P3d 修复定向复评 H2：把「输出逐字相同」这句话变成机器可核的** ─────────────
   *
   * 上一轮把轮询那一拍从整版 `render()` 改成就地重填时，注释里写下了三处
   * 「输出逐字不变 / 逐字相同」，而**没有任何一条断言比对过两条路径的输出**
   * ——上面那格只比节点身份。复评是靠人工「六场景逐节点逐属性 diff」才抓出
   * `.pg-status` 那一格不等价的。**这一格就是那次人工 diff 的常驻化**：
   * 下一次有人再声称「输出不变」，机器替他核。
   *
   * **方法**：跑到某一拍之后，先把 Playground 板块整棵子树逐节点逐属性序列化
   *（tag / 全部属性 / `value` / `checked` / `disabled` / 自有文本 / 子树形状），
   * 再从**同一份模块状态**强制整版重建一次，序列化第二遍，两份逐字比对。
   *
   * ⚠️ **装置（`domShot()` / `expectSameAsRebuild()`）在本文件顶层，不在这里**：
   * 流式那一档栽的是**同一个** bug（复评 G2），它也要用同一份装置
   * ——抄第二份出来的话两份一漂只有真机上看得见。方法与前置条件的说明写在那里。
   *
   * **变红条件（实测）**：把 `pollOnce()` 里那句更新 `.pg-status` 的删掉
   * ⇒ 「轮询回非 2xx」那个场景当场红，diff 直指
   * `span.mono pg-status` 就地那份是 `200`、重建那份是 `500`。
   */
  describe("就地重填与整版重建输出逐字相同（六场景逐节点逐属性）", () => {
    it("场景①成功档：轮到第 3 拍给成片", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { h, sec } = await startVideo(videoResponder(3));
      await tick();
      expectSameAsRebuild(h, sec, "成功档 @1");
      await tick();
      expectSameAsRebuild(h, sec, "成功档 @2");
      await tick();
      vi.useRealTimers();
      expect(one(sec, ".pg-media-url").textContent, "前置条件：第 3 拍该给成片了").toBe("https://cdn.invalid/v.mp4");
      expectSameAsRebuild(h, sec, "成功档 终局");
    });

    it("场景②轮询回非 2xx 且接着轮（就是复评抓到那一档）", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { h, sec } = await startVideo(respondWith({
        gateway: (url) => (url === CREATE
          ? { status: 200, body: { id: "task-1", status: "queued" } }
          : { status: 500, body: { error: { message: "upstream boom" } } }),
      }));
      for (const n of [1, 2, 3]) {
        await tick();
        expect(pollCount(h), `前置条件：第 ${n} 拍真的打出去了`).toBe(n);
        expectSameAsRebuild(h, sec, `非 2xx 档 @${n}`);
      }
      vi.useRealTimers();
    });

    it("场景③放弃档：轮到上限停下来", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { h, sec } = await startVideo(neverDone());
      await tick();
      expectSameAsRebuild(h, sec, "放弃档 @1");
      for (let i = 0; i < 70; i++) await tick();
      vi.useRealTimers();
      expect(pick(sec, ".pg-poll-gaveup").length, "前置条件：真的走到放弃那一档了").toBe(1);
      expectSameAsRebuild(h, sec, "放弃档 终局");
    });

    it("场景④出错档：某一拍传输失败", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let polls = 0;
      const { h, sec } = await startVideo(respondWith({
        gateway: (url) => {
          if (url === CREATE) return { status: 200, body: { id: "task-1", status: "queued" } };
          polls++;
          if (polls >= 2) throw new Error("boom");
          return { status: 200, body: { id: "task-1", status: "processing" } };
        },
      }));
      await tick();
      expectSameAsRebuild(h, sec, "出错档 @1");
      await tick();
      vi.useRealTimers();
      expect(pick(sec, ".pg-error").length, "前置条件：真的走到出错那一档了").toBe(1);
      expectSameAsRebuild(h, sec, "出错档 终局");
    });

    it("场景⑤取消档：轮到第 2 拍按取消", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { h, sec } = await startVideo(neverDone());
      await tick();
      expectSameAsRebuild(h, sec, "取消档 @1");
      one(sec, ".pg-cancel").click();
      await settle(20);
      vi.useRealTimers();
      expect(pick(sec, ".pg-cancelled").length, "前置条件：真的取消掉了").toBe(1);
      expectSameAsRebuild(h, sec, "取消档 终局");
    });

    it("场景⑥隐藏页 → 变回可见接回去", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { h, sec } = await startVideo(neverDone());
      await tick();
      h.dom.document.hidden = true;
      await tick();
      await tick();
      expectSameAsRebuild(h, sec, "隐藏页");
      h.dom.document.hidden = false;
      h.dom.document.dispatchEvent(new h.dom.CustomEvent("visibilitychange"));
      await settle(20);
      await tick();
      vi.useRealTimers();
      expect(pollCount(h), "前置条件：真的接回去了").toBe(3);
      expectSameAsRebuild(h, sec, "接回去之后");
    });
  });
});
