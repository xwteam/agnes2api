import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bootPanel, settle, PANEL_ORIGIN, type Harness } from "./harness.js";
import { stripComments } from "../../helpers/strip-comments.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE, GW_KEY_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { catalogPayload } from "../../../src/core/admin/protocol-catalog.js";
import { I18N } from "../../../admin-ui/js/i18n-dict.js";
import { PLAYGROUND_TURNS_MAX } from "../../../admin-ui/js/pure/playground.mjs";
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
 * ── **「写在屏幕上」这句话的可观测形态（P3e Task 19）** ────────────────────────
 *
 * 只取**叶子节点的自有文本**，属性一概不算。
 * ⚠️ **这条区分不是讲究，是本文件通篇在防的那件事**：一句话进了 `title` / `data-*`
 * 之后 `root.textContent` 一个字都读不到它，而**反过来不成立**——
 * 只断言 `textContent` 的话，「渲染在别处」与「渲染在这一格」分不出来。
 * ⚠️ **它证明不了「肉眼看得见」**：`tests/helpers/fake-dom.ts` 没有布局、没有样式，
 * `display:none` 的节点在这里与可见节点长得一模一样（登记在案的边界，
 * 与文件头那段替身能力核对同一条纪律）。**它证明的是「这段文字进了文档树的文本里」。**
 */
function visibleTexts(root: FakeElement): string[] {
  return everyNode(root)
    .filter((n) => n.children.length === 0)
    .map((n) => n.textContent)
    .filter((s) => s !== "");
}

/**
 * 连发 n 轮**非流式**请求，每一轮换一句可辨认的提示词。
 *
 * ⚠️ **提示词每轮都换是这一族用例的核心装置，不是装饰**：只数 `.pg-turn` 的话，
 * 「删最旧的那几轮」与「删最新的那几轮」两种实现**计数完全一样**，
 * 而后者在屏幕上与「后面这几次根本没发出去」长得一模一样。
 * 换了词之后，留下哪几轮、按什么顺序留，逐条都是可断言的。
 *
 * ⚠️ 口令只粘一次：`render()` 会把它从模块状态回填进新的输入框（左栏那两格同理）。
 */
async function sendTurns(sec: FakeElement, n: number, from = 0): Promise<void> {
  for (let i = 0; i < n; i++) {
    typePrompt(sec, `轮次-${from + i}`);
    one(sec, ".pg-send").click();
    await settle(20);
  }
}

/** 右栏那几轮**按屏幕顺序**的提示词。 */
function turnPrompts(sec: FakeElement): string[] {
  return pick(sec, ".pg-turn-prompt").map((n) => n.textContent);
}

/** 字典里那句话按给定参数插值之后的样子（**期望值从字典派生，不手抄一份**）。 */
function say(key: string, params: Record<string, string> = {}): string {
  let s = String((I18N as Record<string, Record<string, string>>)[key]!["zh-CN"]);
  for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(v);
  return s;
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
 * **实测（复评 R-2/R-4）**：把 `js/app.js` 那句「当前板块只跑 `onShow()`」改成「不重建」
 * ⇒ **用到这份装置的每一格**都红在「前置条件塌了」上；
 * 改成「重建但顺带跑 `onHide()`」⇒ 同样每一格都红，红在输出 diff 上。
 * 两种退化各有一条红线接着。
 * ⚠️ **这里刻意不写总格数**（与 `strip-comments.ts`、Task 5 I3 同一条）：
 * 上一版写着「六格全红」，而复评当天重跑同一条变异已经是**七格**——
 * 一个写死在共用装置文档里的计数，改的人不会想起来回来改它。
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
 *
 * ⚠️ **极性是刻意的：`Expected` = 整版重建那一屏，`Received` = 就地那一屏。**
 * 重建那一份是拿同一份状态走整版渲染那条唯一判据画出来的 ⇒ 它是**参照系**，
 * 而被质疑的一直是就地那条快路。反过来写的话（复评 F5 抓到的上一版）：把 `onPayload`
 * 末尾那句就地写字删掉再跑，diff 读成 `- 甲 / + 甲乙` ——「屏幕本该是缺字的那份」，
 * 与真实故障的方向正好相反，而**报文是这条护栏唯一会被看见的部分**。
 */
function expectSameAsRebuild(h: Harness, sec: FakeElement, where: string): void {
  const inPlace = domShot(sec);
  const beforeNodes = pick(sec, ".pg-turn");
  navTo(h, "playground");   // `showSection` 在 current === name 时只跑 onShow() ⇒ 整版 render()
  const rebuilt = domShot(sec);
  const afterNodes = pick(sec, ".pg-turn");
  expect(afterNodes.length, `${where}：重建之后右栏一轮都不剩 —— 前置条件塌了`).toBe(beforeNodes.length);
  expect(beforeNodes.length, `${where}：右栏一轮都没有 —— 这一格什么都没比`).toBeGreaterThan(0);
  expect(
    afterNodes[0],
    `${where}：**前置条件塌了** —— 再点一次当前导航按钮没有触发整版重建，`
    + "这一格已经退化成自己跟自己比。去看 js/app.js 的 showSection()",
  ).not.toBe(beforeNodes[0]);
  expect(
    inPlace,
    `${where}：**就地更新与整版重建的输出不等价**（Expected = 整版重建那一屏，`
    + "Received = 就地那一屏）。"
    + "轮询那一次正是在这里编出了一个状态码（`.pg-status` 画在 `.pg-media` 盒子外面，"
    + "就地重填够不着它）；流式那一次是漏说了「掉了几块」（`.pg-malformed` 画在 `<pre>` 外面）。"
    + "差异那一行的路径直接指出是哪一格 —— "
    + "要么把那一格也就地更新，要么这一拍别改它对应的那份状态",
  ).toBe(rebuilt);
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
   * **变红条件（逐条实测；①②③ 见 progress note 的 M8/M9/M10，④ 是 P3e Task 18 回填时补的）**：
   * ① 把 `MODES` 里 `video` 那行的 `mode` 改成 `image` ⇒ 视频档拼出来的是图片那条地址 ⇒ 红；
   * ② 把 `currentMediaEndpoint()` 里的 `m.op === "generate"` 改成 `m.op === "poll"`
   *    ⇒ 图片档挑不到端点（图片没有 poll 那一条）、视频档拼出来的是轮询那条 ⇒ 红；
   * ③ 把 `buildModeBar()` 里那句 `if (mode === m.mode) return;` 之后的 `render()` 删掉
   *    ⇒ 点了不重画 ⇒ 红；
   * ④ 往 `MODEL_CATALOG` 里再加一条 `modality: "video"` 的模型
   *    ⇒ **只红视频那一条**（实测 `video 档下拉里的模型条数不对: expected 2 to be 1`），图片档照旧绿。
   *
   * ⚠️ **④ 有两种看着对、其实打不中 video 那一半的改法，都实测过，别拿它们当红法**：
   * · 把 `agnes-video-v2.0` 那行的 `modality` 改成 `"image"` ⇒ **先红在 image 那一条**
   *   （`expected 3 to be 2`），循环里 video 那一趟根本轮不到执行
   *   ——「第二层替第一层挡住变异」的又一例；
   * · 直接删掉 `MODEL_CATALOG` 里那一行 ⇒ 实测整份目录**窄化不过**，面板落进「读不出来」
   *   那一档，本文件大面积红（连模式条都不画了），那不是这一条断言的射程。
   *
   * ⚠️ **每档的模型条数（image 2 / video 1）为什么在这一格**：`sec-playground.js` 的 `MODES`
   * 上方那段拿「`MODEL_CATALOG` 钉着 2 个 image + 1 个 video 模型」当**前提**，据此裁定
   * `pg.model.noneMedia` 在形态名不漂时取不到。这个前提原来只有 image 那一半有机器
   *（漂移那组的反向控制断言 image 档 2 项），**video 那一半一条断言都没有** ⇒ 真源哪天
   * **多**一个视频模型，那段裁定里的「1 个 video」就静默变假（**少**一个不会静默——
   * 见上一条：目录当场窄化不过）。这一格本来就把两档都点了一遍，顺手把条数一起钉住，
   * 是最便宜的补法。
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

    for (const [name, wanted, models] of [
      ["image", `POST ${PANEL_ORIGIN}/v1/images/generations`, 2],
      ["video", `POST ${PANEL_ORIGIN}/v1/videos`, 1],
    ] as const) {
      pick(sec, "[data-mode]").find((b) => b.getAttribute("data-mode") === name)!.click();
      await settle();
      // 真源里这一档有几个模型 —— 见上方那条 ④：这是 `sec-playground.js` 判「兜底文案取不到」
      // 所依赖的前提，两档都得钉住，不能只钉 image 那一半。
      // ⚠️ **这一条必须排在端点行前面**：模型没了的时候端点行**也**画不出来（`buildRequest()`
      // 两者任一为空都交 `null`，同一处过定性），排在后面的话 `one(sec, ".pg-media-endpoint")`
      // 会先抛「应当恰好命中一个，实际 0」，把人引去查端点那一路，而真因在模型这一路。
      expect(pick(sec, "option").length, `${name} 档下拉里的模型条数不对`).toBe(models);
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
   * **`aria-pressed` 的值真的跟着点击走 —— 协议那一排**（P3e Task 20 复评 F6 补的那一组）。
   *
   * `tests/unit/source-guards.test.ts「sec-*.js 里每一个 btn-toggle 创建点都带 aria-pressed」`
   * 只拦「漏写」：八处**全写死成 `"false"`** 它照样绿。拦「写死」的是每个板块自己的这一格，
   * 而本文件上一版只覆盖了 `[data-mode]` 那一排 —— 同一个文件里的
   * `buildProtoBar()` 那一排协议按钮**零覆盖**。
   *
   * ⚠️ **每次 `render()` 都重建按钮**（不是就地改），所以断言前后各查一次 DOM，
   * 不许把首帧那批节点存起来复用 —— 存起来的话点完看的是一批已经从树上摘下来的旧节点，
   * 那正是 P3d 「就地更新够不着盒子外的节点」的镜像形态。
   */
  it("点第二条协议：第一条转 false、第二条转 true", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    // 期望值手写字面量：真源目录里的四条对话协议，顺序就是 catalogPayload 里的顺序。
    const ids = ["openai", "anthropic", "responses", "gemini"];
    expect(pick(sec, "[data-protocol]").map((b) => b.getAttribute("data-protocol")), "协议分段画出来的档位不对")
      .toEqual(ids);
    expect(
      pick(sec, "[data-protocol]").map((b) => b.getAttribute("aria-pressed")),
      "首帧默认选中的该是第一条协议",
    ).toEqual(["true", "false", "false", "false"]);

    pick(sec, "[data-protocol]").find((b) => b.getAttribute("data-protocol") === "responses")!.click();
    await settle();

    expect(
      pick(sec, "[data-protocol]").map((b) => b.getAttribute("aria-pressed")),
      "屏幕上换了协议，aria-pressed 还停在首帧那一档 —— 读屏用户读到的是假的",
    ).toEqual(["false", "false", "true", "false"]);
    // `.active` 与 `aria-pressed` 必须同生同死：只对上一半的话，看得见的那条路与
    // 读得出来的那条路会互相说谎。
    expect(
      pick(sec, "[data-protocol]").filter((b) => b.classList.contains("active"))
        .map((b) => b.getAttribute("data-protocol")),
      ".active 与 aria-pressed 对不上了",
    ).toEqual(["responses"]);
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

/**
 * ── **C4 结案：把「形态名漂移」那个前提立成守卫（P3e Task 18）** ────────────────
 *
 * `admin-ui/js/sec-playground.js` 的 `MODES` 上方那段注释用「不是读代码推的，是在 DOM
 * 夹具里量出来的」这个口吻写下了三条具体行为，并据此裁定 `pg.model.noneMedia` 与
 * `pg.send.blockedNoEndpoint` **不是死代码**。而在这一格写出来之前，
 * `grep -rn "noneMedia\|blockedNoEndpoint" tests/` **零命中** ——
 * 按本仓自己的规矩，那是一份**不会自己红的清单**，也就是待办不是守卫。
 * ⚠️ 更要命的是**那段话本身就是订正上一版一句假描述的产物**
 *（上一版写的是「只显示一句『这个形态没有可用的端点』」，实测没有这样一句话），
 * **第二次变假的代价会更高**：读到它的人会以为这三条已经被量过了。
 *
 * ⚠️ **「结构性不可达」这个判断依赖一个没人守的前提。** 这两个 key 在**形态名不漂**
 * 的前提下确实取不到（`MODEL_CATALOG` 钉着 2 个 image + 1 个 video 模型、
 * `MEDIA_ENDPOINTS` 两档各有一条 `op === "generate"`，两者恒非空）——而那个前提
 * 正是 `MODES` 上方那段注释自己登记着**会漂**的东西。这一格守的就是那个前提。
 *
 * ── **夹具是派生的，本组里没有一个手写的 media / model 字面量对象** ─────────────
 * 派生**只把 `media[].modality` 与 `models[].modality` 里的 `image` / `video` 改名**，
 * `pathTemplate` / `sampleBody` / `authHeader` / `taskSlot` 那些真正会漂的知识
 * **一个字节都没抄** ⇒ 第 7 种假阳性（测的是抄件不是原件）在这一格上没有立足点。
 * ⚠️ 走手写目录的代价同仓刚付过一次：那等于把 Task 17 刚从设置页拆掉的抄件风险
 * 原样搬到 Playground 来。
 *
 * ── **为什么改名之后这份目录还读得进来** ───────────────────────────────────────
 * `mediaEndpoints()` 对 `op` / `modality` **刻意不做白名单**（那个函数上方逐字写着
 * 理由：限定成今天这两个值等于「真源多一个形态 ⇒ 整个媒体模式读不出来」）
 * ⇒ 改名后的两条媒体端点照旧窄化得开，只是**不匹配任何一个模式档**。
 * ⇒ 这一格落在的是「目录读得回来但这一档没有端点」，**不是**「读不出来」那一档
 *（后者由上面「响应读得回来但形状不对时同样是「读不出来」」那一格守着，两者别混）。
 */
describe("形态名一漂，媒体那一档的三处兜底文案逐条上屏", () => {
  /**
   * 由真源现派生的一份「形态名漂了」的目录。**零手写目录**：只改两处 `modality` 的取值。
   * `picture` / `clip` 这两个词是任意选的**表外**形态名，选它们只是为了「真源改了名而
   * 面板那张 `MODES` 表没跟着改」这件事在夹具里可观测。
   */
  const drift = (): unknown => {
    const real = catalogPayload();
    const ren = (m: string): string => (m === "image" ? "picture" : m === "video" ? "clip" : m);
    return {
      ...real,
      media: real.media.map((x) => ({ ...x, modality: ren(x.modality) })),
      models: real.models.map((x) => ({ ...x, modality: ren(x.modality) })),
    };
  };

  /**
   * ⚠️ **断言点必须落在一次稳定 render 之后**：`.pg-send` 的 `title` 与 `disabled`
   * 由 `syncSendButton()` **就地**刷新（不整块重画），而模式切换走的是整版 `render()`。
   * 少一次 `await settle()` 这一格就退化成一条**对时序敏感**的断言——本仓刚在 P3d 因
   *「靠相邻中间件时序侥幸通过」栽过（第 9 种假阳性的近亲）。
   *
   * ⚠️ **两句文案手写整句字面量，不从 `I18N` 字典推导**（第 6 种假阳性）：
   * 从字典取的话，「谁把字典里那句话改坏了」这件事在这一格上恒绿。
   * 这两句是**逐字**从 `zh-CN` 那一栏量出来的。
   *
   * ── **这一格「能」与「不能」，逐条量过（变异实测，不是推的）** ──────────────────
   * **这一格里每一条断言都有一条只改一行、且红在它自己身上的变异**（落点 → 红在哪一条）：
   * · 前置条件①：`mediaEndpoints()` 里给 `modality` 加白名单 → 「落进『读不出来』那一档」；
   * · 前置条件②：`MODES` 删掉 `video` 那行 → 「模式条没画出来」；
   * · 端点行 0：见下面那条过定性说明（**要两处一起改**）；
   * · 下拉 0 项：`currentModelIds()` 媒体那一路换成 `catalog.models.map(...)`；
   * · 发送停用：`syncSendButton()` 里 `nodes.send.disabled` 赋成恒 `false`；
   * · ① 字典交叉核对（`pg.send.blockedNoEndpoint`）：改字典里那句的 `zh-CN`（去掉句号即可）；
   * · ② tooltip：`sendBlockedKey()` 那一路返回 `pg.send.blockedNoProto`；
   * · ③ `data-i18n`：把媒体档那个 key 折成恒 `pg.model.none`；
   * · ④ 字典交叉核对（`pg.model.noneMedia`）：改字典里那句的 `zh-CN`（去掉句号即可）；
   * · ⑤ 文案内容：把 `buildLeft()` 里那句 `elI18n("p", …)` 换成只带 `data-i18n` 属性、
   *   **不写 `textContent`** 的 `el("p", …)`（③④ 照旧绿，⑤ 单独红 —— 这正是 ⑤ 存在的理由）。
   * · ⚠️ **「端点行 0」那一条是过定的（over-determined），明写**：形态名一漂之后
   *   端点与模型**同时**没了，而 `buildMediaNote()` 里 `buildRequest()` 在**两者任一为空**时
   *   都交出 `null` ⇒ **只改 `currentMediaEndpoint()` 那一处打不红它**
   *  （实测：改成兜底返回 `catalog.media[0]` 之后这一条**照旧是 0**，红的是 tooltip 那条）。
   *   要打红它得**同时**把模型那一路也放开（两处一起改，实测红成 `expected 1 to be +0`）。
   *   ⇒ **别把这一条读成「它单独守着端点那一行」**——单独守着端点那一行的是
   *   同格反向控制里的「端点行 1」那条（只改 `m.op === "generate"` 一处就红）。
   */
  it("端点行 0（真源为 1）、模型下拉 0 项（真源为 2）、发送按钮停用且两句文案逐字上屏", async () => {
    const h = await openPg(respondWith({ catalog: { status: 200, body: drift() } }));
    const sec = h.section("playground");
    // 前置条件：目录**读得回来**。落进「读不出来」那一档的话，下面那些「没画出来」类的断言
    // 全都恒成立，而测的完全是另一件事（那一档连模式条都不画）。
    expect(pick(sec, ".pg-unknown").length,
      "落进了「读不出来」那一档 —— 派生把目录改到窄化不过了，下面测的就不是形态名漂移")
      .toBe(0);
    // ⚠️ 报文说的是「不是三档」而不是「没画出来」：已量到的那条红法（`MODES` 删掉 `video` 那行）
    // 下模式条**是画出来的**，只是少一档（实测 `expected 2 to be 3`）。真的一档都不画那种情形
    // 由上一条 `.pg-unknown` 管，两句不是一件事。
    expect(pick(sec, "[data-mode]").length,
      "模式条不是三档 —— 下面的切档与各项计数都不作数").toBe(3);

    toMode(sec, "image");
    await settle();

    expect(pick(sec, ".pg-media-endpoint").length,
      "形态名漂了却还画着一条端点地址 —— 那条地址指向一个目录里不存在的形态").toBe(0);
    expect(pick(sec, "option").length,
      "形态名漂了却还有可选模型 —— 选中它只会换来一次注定失败的请求").toBe(0);
    const send = one(sec, ".pg-send");
    expect(send.disabled, "这一档发不出请求，发送按钮却还是能按的").toBe(true);

    // ── **两个 key 的名字必须落在断言上，不能只落在散文里** ───────────────────────
    // ⚠️ 只断言渲染结果的话，两个 key 名一次都不出现在 `expect(` 上 ⇒
    // `grep -rn "noneMedia\|blockedNoEndpoint" tests/` 只会命中注释，
    // 而**一份只在注释里被提到的 key，与本任务开头要修的那个毛病是同一个形态**。
    // 下面把「屏幕上那一句」与「注释里点名的那个 key」绑住，**两个 key 各一组、口径相同**：
    // 先「字典里那一栏 = 这一句」，再「屏幕 = 这一句」。
    //
    // ⚠️⚠️ **组内顺序不能对调，这是量出来的**：写成「先文案后字典」的话，
    // 改字典时**先红的永远是文案那条**，字典那条一次都轮不到执行 ⇒ 它变成一条
    // 被上一层挡住、自己永远量不到自己的死断言（阶段 E 那条「第二层可能替第一层
    // 挡住变异」的镜像）。现在的顺序下每条各有**只红自己**的变异，见上方清单。
    //
    // ⚠️ **两组必须对称**：`noneMedia` 那一组原来缺 ④ 这条字典交叉核对，于是改字典时
    // 红出来的是 ⑤ 那句「屏幕上却没有任何一句话解释为什么」——**而那句话在屏幕上，
    // 只是少了个句号**，且 vitest 会把实得的 `textContent` 截成 `…`，读的人看不见差异，
    // 报文直接把人引去查 `buildLeft()` 里那个 `if (ids.length === 0)` 分支，真因却在字典里。
    // （P3e Task 18 回填补上；紧邻的上一个提交 `730559f` 修的是同一个形态的毛病。）

    // ① tooltip 是 `t(blocked)` 直接写进 `title` 的，DOM 上不留 key 的痕迹 ⇒
    //    只能先钉「这一句 = 这个 key 的 zh-CN 那一栏」。
    expect(I18N["pg.send.blockedNoEndpoint"]!["zh-CN"],
      "字典里 pg.send.blockedNoEndpoint 的 zh-CN 改了，而下面那条手写期望没跟着改")
      .toBe("协议目录里没有这个形态的端点，这一档发不出请求。");
    // ② 再钉「屏幕 = 这一句」。①+② 合起来才是「屏幕 ← pg.send.blockedNoEndpoint」。
    expect(send.getAttribute("title"),
      "发送按钮停用了，但 tooltip 没说清为什么 —— 去看 sec-playground.js 的 sendBlockedKey()")
      .toBe("协议目录里没有这个形态的端点，这一档发不出请求。");

    // ③ 那一段是 `elI18n()` 画的 ⇒ 它带着 `data-i18n`，这一条直接钉住「屏幕 ← key」。
    expect(pick(sec, '[data-i18n="pg.model.noneMedia"]').length,
      "那句话上屏了，但画它的不是 pg.model.noneMedia —— 注释里点名的那个 key 仍然没人用")
      .toBe(1);
    // ④ 与 ① 同一个口径：先钉「这一句 = 这个 key 的 zh-CN 那一栏」，
    //    这样改字典时红在这里、报文点名字典，而不是让 ⑤ 去替它红。
    expect(I18N["pg.model.noneMedia"]!["zh-CN"],
      "字典里 pg.model.noneMedia 的 zh-CN 改了，而下面那条手写期望没跟着改")
      .toBe("这个形态下没有可用的模型。");
    // ⑤ 再钉那一段的**内容**：③ 只证明「这个 key 被用来画了一段」，
    //    一段空白的 `<p data-i18n=…>` 照样能过 ③。
    expect(sec.textContent, "模型下拉空了，屏幕上那一段是空的 —— 去看 ui.js 的 elI18n() 有没有写 textContent")
      .toContain("这个形态下没有可用的模型。");
  });

  /**
   * **反向控制（刻意与上一格同一个 describe、同一个模式档、同一组观测点）**：
   * 上一格证明的是「形态名一漂我认得出来」，这一格证明的是「真源原样时我不乱红」。
   *
   * ⚠️ 反向控制**用仓里真实存在的那份目录**（`catalogPayload()` 原样，一个字都没改）
   * ——改一个字就把它降级成「另一份抄件」，那样它证不了任何关于真源的事。
   *
   * ⚠️ **这里不断言 `send.disabled === false`，因为那句话在这一格上是假的**：
   * 没粘网关口令、没写提示词，`sendBlockedKey()` 会走到 `pg.send.blockedNoToken`
   * ⇒ 真源原样时这颗按钮**照样是灰的**，只是灰的**理由**不同。
   * 观测点因此落在「那两句兜底文案一句都没上屏」上，而不是按钮的可用性上。
   *
   * ── **这一格每条断言各自的红法（同样是量出来的）** ────────────────────────────
   * · 端点行 1：`currentMediaEndpoint()` 里 `m.op === "generate"` 改成 `"poll"`
   *  （这也是**唯一单点就能打红端点那一行**的地方，上一格那条端点断言做不到）；
   * · 下拉 2 项：`currentModelIds()` 媒体那一路换成 `catalog.models.map(...)`（红成 4）；
   * · tooltip 不该是那一句：`sendBlockedKey()` 里 `pg.send.blockedNoToken` 那一路
   *   改成返回 `pg.send.blockedNoEndpoint`（**上一格照旧绿**——这正是这一格独有的射程）；
   * · `data-i18n` 不该出现：那句 `if (ids.length === 0)` 改成 `if (true)`；
   * · 那句话不该上屏：`if (true)` **并且**把那段中文硬编码进 `el()`（绕开 key）
   *   ⇒ **只有这一条红**，`data-i18n` 那条照旧绿——两条不是重复。
   */
  it("反向控制（同格 describe）：真源原样时端点行 1、模型下拉 2 项", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    toMode(sec, "image");
    await settle();

    expect(pick(sec, ".pg-media-endpoint").length,
      "真源原样，图片档却挑不到那条生成端点").toBe(1);
    expect(pick(sec, "option").length,
      "真源原样，图片档却列不出那两个图片模型").toBe(2);
    expect(one(sec, ".pg-send").getAttribute("title"),
      "真源原样，却说「目录里没有这个形态的端点」")
      .not.toBe("协议目录里没有这个形态的端点，这一档发不出请求。");
    // 与上一格 ③⑤ 同序、同理由：先「这个 key 没被用来画东西」，再「那句话没上屏」。
    // 后一条不是前一条的重复——**把那句中文硬编码进来、绕开 key** 时只有它会红。
    // ⚠️ 这一格**不需要**再抄一遍上一格 ①④ 那两条字典交叉核对：这里两条都是 `not.*`，
    // 字典改一个字它们照样绿，抄过来也只是同一条断言的第二份副本。这两句手写字面量
    // 与上一格 ①④ 钉的是**同两句、同一个 `zh-CN` 栏位** ⇒ 字典一改上一格当场红，
    // 改的人必然回到这两句上；时效靠的是那道红，不是这一格自己。
    expect(pick(sec, '[data-i18n="pg.model.noneMedia"]').length,
      "真源原样，却画出了 pg.model.noneMedia 那一段").toBe(0);
    expect(sec.textContent, "真源原样，却说「这个形态下没有可用的模型」")
      .not.toContain("这个形态下没有可用的模型。");
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
 * ⇒ 那一格看到的是补正之后的屏幕，**在途那一段它按定义看不见**。
 * ⇒ **要看在途那一拍，喂进去的那条流就得挂住不结束**（`hangingStream()` 与
 * `steppedStream()` 末尾那个永不落定的 Promise）。⚠️ 本组有一条**刻意的例外**：
 * 「连着两轮流式各有坏块…」那一格的**第一轮**以 `data: [DONE]` 正常收尾
 * ——它要的正是收尾那一次整版 `render()`，在途那一拍在它的**第二轮**。
 *
 * ── **射程：这一组只走「这条流里有坏块」那一支** ──────────────────────────────
 * 组名上一版是一句**全称句**（「流式在途：那一拍的屏幕不许比整版重建少说一句话」），
 * 而这一组每一份夹具都至少含一块读不出来的数据 ⇒ 它实际只走了坏块那一支。
 * **名字已经收窄**，另外把不覆盖的逐条写在这里（射程边界写出来，不靠读的人猜）。
 * ⚠️⚠️ **这份清单上一版三条错了两条**（复评 F1/F3）：「非流式那一轮一格都没走过」
 * 被 `startSteppedAfterImage()` 第一轮那一轮图片当场推翻；「夹具刻意全都挂住不结束」
 * 被下面那份 `data: [DONE]` 收尾的夹具当场推翻。**全称句写得越顺越没人回来核**
 * ⇒ 现在每一条都改成**机器替你核**的形态，各自点名钉着它的那条断言：
 * · **从头到尾一块坏数据都没有的纯正文流**：等价性只补到了「最后一拍是就地写字」
 *   那一拍（下面那个子组），**中段每一拍仍未逐拍断言**。
 *   钉它的是那个子组里的**夹具自证①②**（`<pre>` 在那一拍真的被换过 /
 *   中间那一块真的被当成了坏块）——哪天有人把坏块从那份线材里拿掉，
 *   **那一格当场红**（实测：中间那一块换成正文 ⇒ 红在自证①「没有换掉那个 `<pre>`」上），
 *   而不是悄悄把射程扩到「纯正文流」上去。
 * · **非流式那一轮自己在飞的那一拍**：本组喂给 `expectSameAsRebuild()` 的屏幕来自
 *   `startHanging()` 与 `startSteppedTextLast()` 这两个入口，**两个入口各钉了一条
 *   「这一屏只有这一轮」**，而那一轮是流式的（`.pg-stream-text` 那几条断言）。
 *   非流式在途那一支由「视频两段式」里的
 *   「就地重填与整版重建输出逐字相同（六场景逐节点逐属性）」钉着。
 *   ⚠️ **这一条钉不住的是「有没有第三个入口」**——再开一个入口的人得回来改这一句。
 *   ⚠️ **不许再写成「这一组没走过非流式轮次」**——那是假话：`startSteppedAfterImage()`
 *   第一轮发的就是图片（`sendOnce()` 里 `stream` 只在 `mode === "chat"` 且开关打开时
 *   才为真），「坏块那一拍不整版重画…」那一格拿来做身份断言的「第一轮那个节点」就是它。
 * · **流正常收尾之后那一拍的等价性**：上面那两个入口在把屏幕交出去之前都钉着
 *   「这条流还挂着」（`.pg-cancel` 还在）⇒ 收尾之后那一屏**没有比过等价性**。
 *   ⚠️ 但收尾之后的**屏幕本身**这一组是看过的：「连着两轮流式各有坏块…」那一格
 *   在第一轮收尾之后断言了「掉了几块」那一行（复评实测：把 `fillTurn()` 里那一档改成
 *   `turn.malformed > 0 && turn.pending === true`，红的三格里就有它）。
 *   ⚠️ 而收尾那一拍走的是 `.finally()` 里的整版 `render()` ⇒ 就地与重建在那里是
 *   **平凡相等**（重建跟重建比），那一拍要量的本来就不是等价性。
 */
describe("流式在途（有坏块那一支）：那一拍的屏幕不许比整版重建少说一句话", () => {
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
    // ── 射程锚：这一屏**只有这一轮**，而它是流式那一轮（上面 `.pg-stream-text` 那条
    // 已经断了它存在）⇒ 组头射程清单里「非流式那一轮自己在飞的那一拍这一组没走过」
    // 那一条才成立。哪天有人往这个入口里加一轮非流式的历史轮次，这一条当场红，
    // 清单跟着回来改 —— 这就是那份清单上一版说假话时缺的东西。
    expect(pick(sec, ".pg-turn").length,
      "射程锚塌了：这一屏不止这一轮 —— 组头那份射程清单里"
      + "「两个入口各钉了一条『这一屏只有这一轮』」已经不成立了，那一条射程边界跟着失效",
    ).toBe(1);
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
   * · 第一块（`0 → 1`）钉的是「那一行**长出来**」——它当时还不存在，位置由
   *   `fillTurn()` 定，所以那一档走的是**重填这一轮那个框**（同一份 `fillTurn()`）；
   *   ⚠️ 上一版这一档走的是整版 `render()`，第四轮已改掉，理由见 `onPayload` 那段 ⚠️⚠️；
   * · 第二块（`1 → 2`）钉的是「那一行**跟着改**」——它已经在屏幕上，走就地改
   *   `textContent`，而那句串必须与 `fillTurn()` 里那句 `t("pg.turn.malformed", …)`
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

  /**
   * 一条**每一块都由测试手动放行**的流。上面那份 `hangingStream()` 一口气把几块全吐完，
   * 于是「坏块**那一拍**」与「正文那一拍」在屏幕上分不开——而这两拍正是下面用它那几格
   * 要比的东西。（**刻意不写用它的格数**：写死一个数，加格的人不会想起来回来改它。）
   *
   * ⚠️ **`step()` 没上膛就当场抛，不许静默返回**：装置本身是判据的一半。
   * 少了这一条，一次「前面那一拍还没走完」会让后面的断言在一个**什么都没变过**的
   * 屏幕上全绿——身份断言尤其如此（没发生的事当然不换节点）。
   */
  function steppedStream(lines: readonly string[]): { stream: ReadableStream<Uint8Array>; step: (what: string) => void } {
    let i = 0;
    const enc = new TextEncoder();
    let arm: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= lines.length) return new Promise<void>(() => {});   // 挂住：既不再吐，也不结束
        return new Promise<void>((resolve) => {
          arm = () => { c.enqueue(enc.encode(lines[i++]!)); arm = null; resolve(); };
        });
      },
    });
    return {
      stream,
      step: (what: string) => {
        if (arm === null) throw new Error(`放行「${what}」时这条流还没上膛 —— 上一拍没走完（settle 不够）`);
        arm();
      },
    };
  }

  /** 正文一块 → 坏一块（`0 → 1` 就在这一拍） → 正文一块 → 挂住。 */
  const STEPPED_WIRE = [
    'data: {"id":"c1","choices":[{"delta":{"content":"甲"}}]}\n\n',
    "data: {这一块不是合法 JSON\n\n",
    'data: {"id":"c1","choices":[{"delta":{"content":"乙"}}]}\n\n',
  ];

  /** 先发一轮图片当**历史轮次**，再发一轮流式对话，逐块放行。 */
  async function startSteppedAfterImage(): Promise<{
    h: Harness; sec: FakeElement; step: (what: string) => void;
  }> {
    const IMAGE_URL = `${PANEL_ORIGIN}/v1/images/generations`;
    const { stream, step } = steppedStream(STEPPED_WIRE);
    const h = await openPg(respondWith({
      gateway: (url) => (url === IMAGE_URL
        ? { status: 200, body: { data: [{ url: "https://cdn.invalid/a.png" }] } }
        : { status: 200, body: null, raw: stream }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    // 第一轮：图片。**它就是「历史轮次」**，每一次整版重画都要把它从头重建一遍。
    toMode(sec, "image");
    typePrompt(sec, "一只猫");
    one(sec, ".pg-send").click();
    await settle(20);
    // 第二轮：流式对话。
    toMode(sec, "chat");
    turnOnStream(sec);
    typePrompt(sec, "你好");
    one(sec, ".pg-send").click();
    await settle(20);
    return { h, sec, step };
  }

  /**
   * ── **第三轮修复定向复评 F-1：坏块那一拍同样不许整版重画** ──────────────────────
   *
   * **它防住的真实故障（复评 C-1 实测，不是设想）**：`0 → 1` 那一档上一版走的是
   * `render()`，于是**一块读不出来的 SSE 数据 = 一次把「全部历史轮次 + 整个左栏」
   * 从头重建**。实测那一拍：历史轮次被换掉 = true、左栏输入框被换掉 = true。
   *
   * ⚠️⚠️ **它与轮询那一格是同一条性质的两个方向，而这一侧原来一格都没有**：
   * 同一个文件两个提交之前刚把整版重画从轮询那条路上删掉、并配了那一格身份断言
   *（见上面「轮询那一拍不整版重画 —— 右栏别的轮次与左栏输入框必须还是原来那几个节点对象」），
   * 流式这条路随后**在修另一件事时把它原样引了回来**。**修一处把别处刚解决的问题搬过来**
   * ——这份账本上连着几轮栽的都是这一条，所以这一格是常驻的，不是一次性验尸。
   *
   * **两个方向，各自对应一件不同的祸事**：
   * · **右栏**：`render()` 每一轮都要走一次 `mediaResultUrls()`（整棵 JSON 树）加一次
   *   `prettyJson()`（无长度上限），而 `turn.body` 可能是一张 MB 级 base64 图
   *   ——同一个文件实测过：**单次**整版重建随历史轮数成正比（1 / 5 / 10 轮 ≈
   *   3.0 / 15.0 / 30.0 MB 临时字符串）。「一轮最多发生一次」只回答了频率那一轴。
   * · **左栏**：重画把那两个输入框换成新节点 ⇒ **正在打的那句话与光标当场没了**。
   *   `sec-playground.js` 三处逐字写着这件事，而**假 DOM 没有焦点语义**
   *   ⇒ 它只能靠节点身份看见（与轮询那一格同一条理由）。
   *
   * ⚠️ **必须先有一轮历史**：只有一轮时「整版重建」与「重填这一个框」同阶，
   * 这一格也就没有鉴别力 —— 真正被放大的是**前面那些轮次**。
   *
   * ⚠️ **配一条反向控制**：那一行必须真的长出来、并且说的是这一拍的数字。
   * 少了它，把整个 `0 → 1` 那一档删掉（这一拍什么都不做）同样能让身份那几条全绿
   * ——而那正是「面板把一段缺字的回答当成完整的画着」那条祸事本身。
   *
   * **变红条件（都实测过）**：把 `onPayload` 里那一档换回 `render()` ⇒ 这一格红在
   *「第一轮那个节点被换掉了」上；**把右栏那两条静音再跑一次，左栏那两条同样红**
   *（一次运行只停在第一条断言上，所以两个方向要各验一次，不能只看一次红就说「四条都有牙」）。
   * 反向控制那一侧：把 `0 → 1` 那一档整个去掉（这一拍什么都不做）
   * ⇒ 红的是「那一行根本没长出来」，而身份那几条**照样全绿**——两个方向缺一不可。
   */
  it("坏块那一拍不整版重画 —— 右栏别的轮次与左栏输入框必须还是原来那几个节点对象", async () => {
    const { sec, step } = await startSteppedAfterImage();

    const turnsBefore = pick(sec, ".pg-turn");
    expect(turnsBefore.length, "前置条件：右栏得真的有两轮，否则这一格没有鉴别力").toBe(2);
    const tokenBefore = one(sec, ".pg-token");
    const promptBefore = one(sec, ".pg-prompt");

    // ── 正文那一拍：本来就走就地改 `textContent`，当**对照**用 ──────────────────
    step("正文那一块");
    await settle(20);
    expect(one(sec, ".pg-stream-text").textContent, "前置条件：正文那一块得真的到了").toBe("甲");
    expect(pick(sec, ".pg-turn")[0], "对照：正文那一拍就把历史轮次换掉了 —— 那是另一个更早的病")
      .toBe(turnsBefore[0]);

    // ── 坏块那一拍：`0 → 1`，那一行在这一拍**长出来** ─────────────────────────
    step("那一块坏数据");
    await settle(20);
    expect(pick(sec, ".pg-cancel").length, "前置条件：这条流得还挂着，否则测的是收尾那一拍").toBe(1);
    // 反向控制：这一拍真的发生了，而且说的是这一拍的数字（期望值手写整句）。
    expect(pick(sec, ".pg-malformed").length, "反向控制：那一行根本没长出来，这一拍什么都没做").toBe(1);
    expect(one(sec, ".pg-malformed").textContent)
      .toBe("这条流里有 1 块数据读不出来，已跳过——上面这段回答可能是缺字的。");

    const turnsAfter = pick(sec, ".pg-turn");
    expect(turnsAfter.length).toBe(2);
    // **身份比较**：整版重画会把这两个节点全换成新对象。
    expect(turnsAfter[0], "第一轮那个节点被换掉了 —— 坏块那一拍又整版重画了（去看 onPayload 里那段 ⚠️⚠️）")
      .toBe(turnsBefore[0]);
    expect(turnsAfter[1], "正在收的那一轮外壳也被换掉了 —— 重填的应当是这个框本身").toBe(turnsBefore[1]);
    // **左栏两条**：真机上这一下丢的是焦点，而这个替身只看得见「还是不是同一个对象」。
    expect(one(sec, ".pg-token"), "左栏口令输入框被换掉了 —— 真机上这一下会让正在粘的那把口令丢焦点")
      .toBe(tokenBefore);
    expect(one(sec, ".pg-prompt"), "左栏提示词框被换掉了 —— 真机上一块坏数据就打断了正在打的那句话")
      .toBe(promptBefore);
  });

  /**
   * ── **重填之后，`nodes.streamText` 必须重新挂上** ──────────────────────────────
   *
   * 坏块那一拍会把这一轮那个框整个重填，**屏幕上那个 `<pre>` 因此是一个新节点**。
   * 少了 `fillTurn()` 里那句重新挂（或者哪天有人把它挪走），后半段回答会被写进
   * 一个**已经从文档里摘掉**的 `<pre>` ——与 `render()` 里那几句作废是同一条祸事
   *（指针指着一个没人看得见的节点）。
   *
   * ⚠️ **既有那格「中间夹一块读不出来的数据」看不到这件事**：它等到流**结束之后**
   * 才断言，而收尾那一次整版 `render()` 会拿 `turn.text` 从头画一遍
   * ⇒ 屏幕上照样是完整的「甲乙」，**在途那一段丢没丢字从来没有被任何一格看过**。
   * 所以这一格必须在流还挂着的时候断言。
   *
   * **变红条件（实测）**：把 `fillTurn()` 里那句 `nodes.streamText = body;` 删掉
   * ⇒ 这一格红成「在途那一段只剩『甲』」。
   */
  it("坏块那一拍重填之后，后到的正文还是落在屏幕上那个节点里", async () => {
    const { sec, step } = await startSteppedAfterImage();
    step("正文那一块");
    await settle(20);
    step("那一块坏数据");
    await settle(20);
    const preAfterRefill = one(sec, ".pg-stream-text");
    expect(preAfterRefill.textContent, "前置条件：重填之后正文一个字都不许丢").toBe("甲");

    step("坏块之后的那一块正文");
    await settle(20);
    expect(pick(sec, ".pg-cancel").length, "前置条件：这条流得还挂着").toBe(1);
    expect(one(sec, ".pg-stream-text").textContent,
      "在途那一段丢字了 —— 后半段回答很可能写进了重填之前那个已经摘掉的 <pre>").toBe("甲乙");
    expect(one(sec, ".pg-stream-text"), "屏幕上那个 <pre> 又被换了一次 —— 这一拍本该只改文字")
      .toBe(preAfterRefill);
  });

  /**
   * ── **G4 收口：等价性装置对 `nodes.streamText` 那条路一格都没量到** ─────────────
   *
   * 上面那几格**全都以「这条流里有坏块」为前提**，最后一次在途操作因此一律落在
   * 「掉了几块」那一行上（就地改它，或者 `0 → 1` 那一下重填这一个框）
   * ⇒ 等价性装置量的一直是那条路。**实测（本任务，不是设想）**：把 `onPayload` 末尾
   * 那句 `nodes.streamText.textContent = turn.text` **整句删掉**，上面那格
   * 「场景⑦流式在途：就地写字与整版重建输出逐字相同（逐节点逐属性）」**照样全绿**
   * ——它那份夹具最后一拍是坏块（`1 → 2`），而那个 `<pre>` 在 `0 → 1` 那一拍刚被
   * `fillTurn()` 按 `turn.text` 重画对过 ⇒ 屏幕与整版重建当然一致。
   *
   * ⚠️ **线材复用上面那份 `STEPPED_WIRE`，不另抄一份**（复评 F4）：它的字节序
   * 正是这一格要的（甲 → 坏块 → 乙 → 挂住，理由见下），而**抄一份形状逐块相同的出来，
   * 两份一漂只有真机上看得见** —— 这正是下面拒绝复制 `steppedStream()` 的同一条理由，
   * 对线材同样成立。⚠️ 复用的代价是**耦合**：`STEPPED_WIRE` 一改这一格跟着变，
   * 所以下面那三条**夹具自证**（换过节点 / 中间那一块是坏块 / 最后那一拍是正文）
   * 是这次复用的对价 —— 实测把它最后一块换成又一块坏数据 ⇒ **夹具自证③当场红**。
   *
   * ⚠️ **但不许往 `hangingStream()` 那份 `WIRE` 里加正文**（那是另一份线材）：
   * 它被上面好几格共用，其中一格手写整句期望值「这条流里有 2 块数据读不出来」，
   * 而它上方那段逐字论证了**「两块坏数据缺一不可」**
   *（一块钉「那一行长出来」、一块钉「那一行跟着改」）。
   * 往里加一块正文 = 把那条刚钉死的论证搬松。
   *
   * **这份线材的字节序对这一格是刚好的：甲 → 坏块 → 乙 → 挂住。**
   * · 中间那一块坏数据把那个 `<pre>` **换成一个新节点**（`0 → 1` 重填这一个框）；
   * · 最后那一块正文因此必须落在**换过之后**那个 `<pre>` 上，
   *   而且它是**最后一次在途操作**。
   * ⇒ 同一格罩住这一族的**两个方向**：
   *   **够不着**（就地写字这一拍压根没发生 ⇒ 屏幕比重建少了后半句）与
   *   **指着死节点**（`nodes.streamText` 还攥着重填之前那个已经摘掉的 `<pre>`
   *   ⇒ 后半句写进了没人看得见的对象里）。
   *
   * ⚠️⚠️ **前置条件刻意不写成「屏幕上是『甲乙』」**：那句话本身就是等价性要证的东西，
   * 写在前面只会让这一格红在前置条件上，而「等价性装置到底量没量到这条路」仍然没有答案
   * ——这一格存在的理由就是那个答案。前置条件因此只钉**与正文内容无关**的那几件事：
   * 流还挂着、`<pre>` 在坏块那一拍真的换过、最后那一拍**没有**换节点、
   * 最后那一拍**也没有**让「掉了几块」那一行跟着变（它还停在 1 块上）、
   * 以及那条射程锚（这一屏只有这一轮）。
   * · 「没换节点」是**防退化线**：哪天有人把最后这一档改回整版重画，
   *   屏幕与重建会平凡地相等（重建跟重建比），这一格会静静地什么都不再量
   *   ——那时红的是它，不是等价性那一条。
   * · 「那一行没跟着变」是**夹具自证③**，与上一条**不重叠**（复评 F1 抓到的洞）：
   *   最后那一拍要是又一块坏数据，走的是「就地改那一行的文字」，`<pre>` **同样不换节点**
   *   ⇒ 防退化线照样绿，而这一格要量的那条路（最后一次在途操作是 `nodes.streamText`
   *   就地写字）已经没人走了。**上一版少了这一条，实测：夹具改成「最后一拍是坏块」，
   *   这一格 1 passed 全绿；再叠上「就地写字整句删掉」那一刀，仍然全绿。**
   *
   * ⚠️ **它放在这一组里面而不是另起一个顶层组**：`steppedStream()` 是这一组的私有装置，
   * 而它那句「没上膛就当场抛」是判据的一半；抄第二份出来两份一漂只有真机上看得见。
   * 这一组收窄之后的名字（「有坏块那一支」）对这份线材**是真话**——它中间确实有一块。
   */
  describe("流式在途（零坏块尾巴：最后一拍是就地写字）：就地写字与整版重建输出逐字相同", () => {
    /**
     * 逐块放行到**最后一块正文落地为止**，中途把「线材还是不是我说的那个形状」
     * 逐条断言掉。⚠️ 这三条全是**夹具自证**，不是被测性质本身，
     * 但它们是「复用 `STEPPED_WIRE` 而不另抄一份」的对价：那一份被这一组好几格共用，
     * 谁改它这里都得当场知道。**每一条的变红条件都实测过**：
     * ① 把 `onPayload` 里「重填这一个框」那一档关掉（`else if` 改成 `false`）
     *   ⇒ 红在「中间那一块坏数据没有换掉那个 `<pre>`」；
     * ② 把 `fillTurn()` 里 `String(turn.malformed)` 写成 `String(turn.malformed + 1)`
     *   ⇒ 红在那句手写整句上；
     * ③ 把这份线材最后一块换成又一块坏数据 ⇒ 红在「最后那一拍不是正文」。
     * ⚠️ **上一版少了③**：同一刀下去这一格 `1 passed` **照样全绿**；
     * 再叠上「就地写字那一句整句删掉」那一刀（这一格存在的全部理由），**仍然全绿**
     * ——两侧都是本轮回填实跑出来的（复评 F1）。
     */
    async function startSteppedTextLast(
      lines: readonly string[],
    ): Promise<{ h: Harness; sec: FakeElement }> {
      const { stream, step } = steppedStream(lines);
      const h = await openPg(respondWith({
        gateway: () => ({ status: 200, body: null, raw: stream }),
      }));
      const sec = h.section("playground");
      pasteToken(sec, GW_TOKEN);
      typePrompt(sec, "你好");
      turnOnStream(sec);
      one(sec, ".pg-send").click();
      await settle(20);

      step("头一块正文");
      await settle(20);
      const preBefore = one(sec, ".pg-stream-text");

      step("中间那一块坏数据");
      await settle(20);
      const preAfterRefill = one(sec, ".pg-stream-text");
      // 夹具自证①：那一拍真的重填了这一个框 ⇒ `<pre>` 换成了新对象。
      // 少了它，「指着死节点」那个方向在这一份夹具里已经走不到，而这一格不会吭一声。
      expect(preAfterRefill, "夹具塌了：中间那一块坏数据没有换掉那个 <pre> —— "
        + "「指着死节点」那个方向在这一份夹具里已经走不到了").not.toBe(preBefore);
      // 夹具自证②：中间那一块真的被当成了坏块（期望值手写整句，不从 i18n 词典推导）。
      expect(pick(sec, ".pg-malformed").length, "夹具塌了：中间那一块没有被当成坏块").toBe(1);
      expect(one(sec, ".pg-malformed").textContent)
        .toBe("这条流里有 1 块数据读不出来，已跳过——上面这段回答可能是缺字的。");

      step("最后那一块正文");
      await settle(20);
      // 前置条件：这条流还挂着，测的不是收尾那一拍（收尾会走 `.finally()` 的整版重画）。
      expect(pick(sec, ".pg-cancel").length, "前置条件：这条流得还挂着，否则测的是收尾那一拍").toBe(1);
      // 夹具自证③：最后那一拍放行的是**正文**，不是又一块坏数据 ——「掉了几块」那一行
      // 必须还停在中间那一块上（还是 1）。⚠️ 这一条与下面那条防退化线**不重叠**：
      // 又一块坏数据走的是「就地改那一行的文字」，`<pre>` 同样不换节点 ⇒ 防退化线照样绿，
      // 而这一格量的那条路（最后一次在途操作是 `nodes.streamText` 就地写字）已经没人走了。
      // ⚠️ 写成 `pick(".pg-malformed").length` **没有牙**：那一行始终只有一个节点，
      // 变的是里面的数字 —— 所以这里比的是整句文字（期望值手写，不从 i18n 词典推导）。
      expect(one(sec, ".pg-malformed").textContent,
        "夹具塌了：最后那一拍不是正文而是又一块坏数据 —— 最后一次在途操作因此又落回"
        + "「掉了几块」那一行，这一格量不到 `nodes.streamText` 那条路")
        .toBe("这条流里有 1 块数据读不出来，已跳过——上面这段回答可能是缺字的。");
      // 防退化线：最后这一拍走的是**就地写字**，不是重画 —— 换了节点这一格就白量了。
      expect(one(sec, ".pg-stream-text"),
        "最后那一拍把那个 <pre> 换掉了 —— 它走的不是就地写字，"
        + "这一格已经退化成「整版重建跟整版重建比」，等价性那一条恒绿")
        .toBe(preAfterRefill);
      // ── 射程锚：与 `startHanging()` 那一条同一条理由 —— 这一屏只有这一轮，
      // 而它是流式那一轮（上面 `.pg-stream-text` 那几条已经断了它存在）。
      expect(pick(sec, ".pg-turn").length,
        "射程锚塌了：这一屏不止这一轮 —— 组头那份射程清单里"
        + "「两个入口各钉了一条『这一屏只有这一轮』」已经不成立了，那一条射程边界跟着失效",
      ).toBe(1);
      return { h, sec };
    }

    it("最后一拍是就地写字时，屏幕与整版重建仍然逐字相同", async () => {
      const { h, sec } = await startSteppedTextLast(STEPPED_WIRE);
      expectSameAsRebuild(h, sec, "零坏块尾巴：就地写字那一拍");
    });
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
 * 在这三个函数体里新增一个出口，**只要 `class` 这个属性名是以字面形式写在那里的**
 * （裸 `class:` / `"class":` / `'class':` / `["class"]:` 四种，判据都认），
 * 判据要么**解得出**它的 class 名（清单变长 ⇒ 与手写表对不上 ⇒ 红），
 * 要么**解不出**（当场吵「我看见一个我读不懂的 class 表达式」⇒ 红）——这两条之外没有第三条。
 * ⚠️⚠️ **那个前提不成立时它就够不着**：属性名写成计算键 / 属性对象提到函数外 / 出口本身
 * 新增在这三个函数之外，三条都是**静默逃逸**（三条都实测过：48/48 全绿）。
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
 * ⚠️⚠️ **这条旁证的前提只对本文件今天扫的那几个函数成立，别写成全称句**：它们都是多行写法、
 * 收尾 `}` 在第 0 列。`admin-ui/js/theme.js` 就有一个**单行写法**的顶层函数
 * （`export function toggleTheme() { … }`），它的收尾根本不在第 0 列——
 * 哪天它们里有谁改成单行写法，这条旁证要跟着改，否则它会误吵。
 * ⚠️ **这里刻意不写「哪几个」的那个数**（复评 F-3）：上一版写死成「这两个函数」，
 * 而调用点在 P3d 就已经是三个（`buildMediaRow` / `buildMediaResult` / `fillMediaResult`）、
 * P3e Task 19 又加到五个（`pushTurn` / `clearTurns`）——**那个数每加一格就旧一次**。
 * 要知道今天有几个，`grep -n "functionBodyOf(" ` 这个文件即可；
 * 而「它们是不是都顶格收尾」不靠这句话保证，靠的就是下面这条旁证自己会当场吵。
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
        + "不在第 0 列 —— 本判据只认顶格收尾的多行写法（它今天扫的那几个函数都是），"
        + "两条判据对不上说明这次扫描被带偏了"
        + "（例如 stripComments() 不认得的正则字面量把引号配对搞歪），判据不敢当它是函数收尾",
    };
  }
  return { body: src.slice(start, close) };
}

/**
 * **一段（去掉注释之后的）源码里对模块变量 `turns` 的每一次「写」。**
 * 返回的是逐处的写形态原文，给报文用——只返回个数的话，红了之后还得再读一遍代码才知道是哪一处。
 *
 * ⚠️⚠️ **上一版的判据只有 `turns.push(`，而它守的那句话是全称句**（复评 F-1 / M-E）：
 * `turns = turns.concat([turn])` 从它底下**整条走过去**，屏幕上分辨不出来。
 * ⇒ 现在四种写形态一起认：
 * · 赋值与 `+=` 一族（`=` 但不是 `==` / `===` / `=>`）；
 * · 会改数组自身的方法调用（下面那张表，**读那一族一个都不许进来**：
 *   `slice` / `filter` / `map` / `concat` 都是返回新数组，它们不是写）；
 * · `turns[i] = …`（下标里**不许再出现 `]`**，嵌套下标认不出来，已在调用点登记）；
 * · `turns.length = …`（把数组截短的那种写法）。
 *
 * ⚠️ **名字必须逐字是 `turns`**：`\b` 两侧一夹，`trimTurns` / `clearTurns` / `trimmedTurns`
 * 里的那个 `Turns` 是大写 T，一个都不会被误抓——这也是别名那条逃逸认不出来的同一个原因。
 */
const TURNS_MUTATORS = ["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"];
function turnsWrites(src: string): string[] {
  const out: string[] = [];
  const re = /\bturns\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const rest = src.slice(m.index + "turns".length);
    // ① 赋值 / `+=` 一族。`=(?![=>])` 把 `==` `===` 与箭头函数的 `=>` 都挡在外面。
    const assign = /^\s*(?:\*\*|<<|>>>?|\|\||&&|\?\?|[+\-*/%&|^])?=(?![=>])/.exec(rest);
    if (assign !== null) { out.push(`turns${assign[0]}`); continue; }
    // ② 会改数组自身的方法调用。
    const call = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
    if (call !== null && TURNS_MUTATORS.includes(call[1]!)) { out.push(`turns.${call[1]!}(`); continue; }
    // ③ `turns.length = …`（同样要挡掉 `turns.length === 0` 这种读）。
    if (/^\s*\.\s*length\s*=(?![=>])/.test(rest)) { out.push("turns.length="); continue; }
    // ④ `turns[i] = …`。下标里再出现一个 `]` 就切不出来 —— 那条已在调用点逐字登记。
    if (/^\s*\[[^\]]*\]\s*=(?![=>])/.test(rest)) { out.push("turns[…]="); }
  }
  return out;
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
 * **不经属性名就把 class 挂上去的那些写法。** 它们在这三个函数体里出现即红——
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
 * ① **出口新增在这三个函数之外**：`buildTurn()` 的 `turn.mode !== "chat"` 分支、
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
 * ③ **属性对象整个提到这三个函数之外**：`const ESC = { class: "…" };` 写在模块级、
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
 * ②③④ 今天在**被扫的这三个函数体里**都没有真实写法（逐条 grep 过：admin-ui 下 0 处计算键、
 * 0 处把 attrs 当变量传的 `el()` 调用、0 处含引号的正则字面量）。
 * ⚠️ **但别把这句读成「仓里没人这么写」**：`{ ...attrs }` 展开在 `admin-ui/js/ui.js` 的
 * `elI18n()` 里就是**真实写法**（`el(tag, { ...(attrs || {}), "data-i18n": key })`），
 * 它只是不在这三个函数体里。带引号的属性名（`"class":` / `'class':` / `["class"]:`）
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
   * ⚠️⚠️ **左栏那两个输入框是第二个方向，它对应的祸事是焦点**（第四轮修复补的）：
   * `sec-playground.js` 有三处逐字写着「重画会让左栏输入框丢焦点」，
   * 而**假 DOM 没有焦点语义**（`fake-dom.ts` 的 `focus()` 只挪一个模块变量，
   * 节点被换掉时它不会告诉你任何事）⇒ **那件祸事在这个替身上只能靠节点身份看见**。
   * 少了这两条，一次「只重建右栏、顺手把左栏也重画了」的实现照样全绿。
   *
   * **变红条件（都实测过）**：把 `pollOnce()` 里那段就地重填换回 `render()`
   * ⇒ 这一格红在右栏那几条上（整棵被换掉）；**把右栏那三条静音再跑一次，
   * 左栏那两条同样红**——一次运行只停在第一条断言上，所以两个方向各验了一次。
   */
  it("轮询那一拍不整版重画 —— 右栏别的轮次与左栏输入框必须还是原来那几个节点对象", async () => {
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
    // 左栏那两个输入框：焦点那一轴的观测点（见上面那段 ⚠️⚠️）。
    const tokenBefore = one(sec, ".pg-token");
    const promptBefore = one(sec, ".pg-prompt");

    await tick();
    await tick();
    vi.useRealTimers();

    const turnsAfter = pick(sec, ".pg-turn");
    expect(turnsAfter.length).toBe(2);
    // **身份比较**：整版重画会把这两个节点全换成新对象。
    expect(turnsAfter[0], "第一轮那个节点被换掉了 —— 轮询那一拍又整版重画了").toBe(turnsBefore[0]);
    expect(turnsAfter[1], "正在轮的那一轮外壳也被换掉了 —— 重填的应当只有里面那个盒子").toBe(turnsBefore[1]);
    expect(pick(sec, ".pg-media")[0], "第一轮那个媒体盒子被重建了").toBe(boxesBefore[0]);
    // **左栏两条**：真机上这一下丢的是焦点，而这个替身只看得见「还是不是同一个对象」。
    expect(one(sec, ".pg-token"), "左栏口令输入框被换掉了 —— 真机上这一下会让正在粘的那把口令丢焦点")
      .toBe(tokenBefore);
    expect(one(sec, ".pg-prompt"), "左栏提示词框被换掉了 —— 真机上这一下会打断正在打的那句话")
      .toBe(promptBefore);
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

    // ── **屏幕上那句话必须是限定句，而且槽表要真的插进去（P3e Task 21）** ────────
    // 上一版这句话是**关于响应的全称断言**（「响应里没有一格能当任务标识用的 id」），
    // 而真正成立的只是「我们只看明写的那几格」。**那两句话在这一档上分得开**：
    // 响应里可以有一个我们不认得的槽，而全称句会把它说成不存在。
    //
    // ⚠️ 期望值走 `say()`（从字典派生那句话的骨架），**而插值那一串是手写字面量**：
    // 拿 `videoTaskIdSlotsText()` 回填的话，槽表改了两边一起动，屏幕上少列一格也不会红。
    const noTask = one(sec, ".pg-no-task").textContent;
    expect(noTask, "那句话没按槽表插值 —— 屏幕上会出现裸的占位符")
      .toBe(say("pg.media.noTaskId", { slots: "id / task_id / taskId / data.id / data.task_id" }));
    expect(noTask.includes("{slots}"), "占位符原样漏到了屏幕上").toBe(false);
    // ⚠️ **非空锚，别删**：只有上面那条 `say()` 比对的话，字典里那句话哪天被改回
    // 不带 `{slots}` 的全称句，两边会**一起**变回旧句子而这一格照样全绿
    //（`say()` 从同一份字典派生）。下面这个手写字面量是唯一不跟着动的那一端。
    expect(noTask, "屏幕上那句话没有列出面板认得的那几格 —— 它又变回全称句了")
      .toContain("data.task_id");
  });

  /**
   * **`task_id` 这一格也算数 —— 具名候选槽表的行为面（P3e Task 21）。**
   *
   * 上一版 `videoTaskIdOf()` 只认顶层 `id`，于是这个响应在屏幕上走的是「没有任务标识」
   * 那一档：**面板一次都不轮，运维手上什么都没有**，而响应里明明有一个能用的标识。
   *
   * ⚠️ **观测点是 `h.calls`（真发出去的那几条 URL），不是屏幕文字**：
   * 只断言 `.pg-task-id` 的话，「认出来了但没接着轮」这条半截实现照样全绿
   *（`startPolling()` 里任何一句早退都能造出它），而那正是运维会盯着一个
   * 永远不动的框等下去的形态。
   *
   * **变红条件（实测，逐字记报文）**：把 `VIDEO_TASK_ID_SLOTS` 缩回只剩 `["id"]`
   * ⇒ 这一格红在**第一条 `expect`** 上，报文是
   * `选择器 .pg-task-id 应当恰好命中一个，实际 0`。
   * ⚠️ **只红这一处**：`h.calls` 那条排在它后面，而 vitest 在第一条 `expect` 就停
   *（上一版这段写着「红在『打点次数 0』与『画的是没有标识那一档』两处」——**那是假话**：
   *  「打点次数」那句报文全文件只有一处，而且在**别的格**里（那个 60 拍上限格），
   *  照着它去复核变异的人在这一格里一处都找不到）。
   * ⇒ **`h.calls` 那条守的是另一个方向**：`startPolling()` 里任何一句早退
   *（认出来了、屏幕上也画了，就是不轮）——那条变异动不了 `.pg-task-id`，
   * 只有它会红。两条断言各守一个方向，不是同一条变异的两处。
   */
  it("标识放在 task_id 那一格时照样接着轮 —— 认得出却不轮的话，运维盯着一个永远不动的框", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let polls = 0;
    const { h, sec } = await startVideo(respondWith({
      gateway: (url) => {
        if (url === CREATE) return { status: 200, body: { task_id: "task-1", status: "queued" } };
        polls++;
        return polls >= 2
          ? { status: 200, body: { task_id: "task-1", status: "completed", url: "https://cdn.invalid/v.mp4" } }
          : { status: 200, body: { task_id: "task-1", status: "processing" } };
      },
    }));

    expect(one(sec, ".pg-task-id").textContent, "task_id 那一格没被认出来").toBe("task-1");
    expect(pick(sec, ".pg-no-task").length, "认得出的一格却走了「没有任务标识」那一档").toBe(0);

    await tick();
    await tick();
    vi.useRealTimers();

    // 打的是带任务标识的那条路径，**不是**建任务那条。
    expect(h.calls.filter((c) => c.url.startsWith(PANEL_ORIGIN)).map((c) => c.url))
      .toEqual([CREATE, POLL, POLL]);
    expect(one(sec, ".pg-media-url").textContent).toBe("https://cdn.invalid/v.mp4");
  });

  /**
   * ── **`name` 那一格移出槽表之后的行为面（P3e Task 21 回填）** ────────────────
   *
   * 上一版 `["name"]` 在槽表上，理由写的是「长跑作业的资源名」。**那个理由是死的**：
   * 真实的 `operations/xxx` 过不了形状判据（纯函数那侧
   * `tests/ui/playground-media.test.ts` 的「真实的长跑作业名过不了形状判据 —— name 那一格对它被加进来的那个理由是死的」逐条量过）。
   * 而**能**过判据的 `name` 是另一族：**运维自己在建任务时传的显示名被上游原样回显**，
   * 这一档在屏幕上实测长这样——**一边贴着 404 与 `task not found`、一边说
   * 「正在轮询这个任务的结果，已经查过 N 次」**，并一路轮到 `VIDEO_POLL_MAX_ATTEMPTS`
   *（60 拍 / 5 分钟，**每一拍都烧一次配额**，全局约束 14）。
   *
   * ⚠️ **观测点是真发出去的那几条请求，不是屏幕文字**：
   * 只断言 `.pg-no-task` 画出来了的话，「屏幕上说没有标识、后台照旧在轮」这条形态全绿——
   * 而那正是最费配额的一种。
   * ⚠️ **夹具里那条 404 在绿路径上一次都走不到**（这一格断言的就是「零次轮询」）。
   * 它不是前置条件，是**给变异路径备着的**：把 `["name"]` 加回槽表之后打出去的那几拍
   * 拿回来的正是它，那时报文里那句「一边贴着 404 一边说正在轮询」才是可核的实况。
   *
   * **变红条件**：把 `["name"]` 加回 `VIDEO_TASK_ID_SLOTS`
   * ⇒ 这一格红在第一条 `expect`，报文是「拿显示名当任务标识去轮了…」。
   */
  it("上游把运维传的显示名回显在 name 里时一次都不轮 —— 拿显示名去轮只会一边 404 一边说「正在轮询」", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { h, sec } = await startVideo(respondWith({
      gateway: (url) => (url === CREATE
        ? { status: 200, body: { name: "my_video", status: "queued" } }
        : { status: 404, body: { error: { message: "task not found" } } }),
    }));
    await tick();
    await tick();
    vi.useRealTimers();

    expect(
      h.calls.filter((c) => c.url.startsWith(`${PANEL_ORIGIN}/v1/videos/`)).length,
      "拿显示名当任务标识去轮了 —— 屏幕会一边贴着 404 一边说「正在轮询…已经查过 N 次」，一路轮到上限",
    ).toBe(0);
    expect(pick(sec, ".pg-task-id").length, "把一个显示名画成了任务标识").toBe(0);
    expect(pick(sec, ".pg-no-task").length, "既没轮也没说是哪一档 —— 运维手上什么都没有").toBe(1);
  });

  /**
   * **搬运风险 ③ 的复核（P3e Task 21）**：`pg.media.noTaskId` 住在 `fillMediaResult()` 里，
   * 而那个函数同时被「整版重建」和「轮询那一拍就地重填」两条路径调用。
   * 这一档**不轮**（所以就地那条路径这一档走不到），
   * 但把这句话改成带插值之后，它仍然必须在两条路径下画出一模一样的一屏
   * ——哪天有人给「没有任务标识」这一档接上一条就地更新的快路，这一格是接住它的那张网。
   *
   * ⚠️ **装置是本文件顶层那份 `expectSameAsRebuild()`，不抄第二份**（理由写在它上方）。
   */
  it("没有任务标识那一档：屏幕与整版重建逐字相同 —— 这句话现在带插值，两条路径不许各插各的", async () => {
    const { h, sec } = await startVideo(respondWith({
      gateway: () => ({ status: 200, body: { status: "queued", note: "no id here" } }),
    }));
    expect(pick(sec, ".pg-no-task").length, "前置条件：没有任务标识那条出口得真的画出来").toBe(1);
    expectSameAsRebuild(h, sec, "没有任务标识档");
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

/**
 * ── **对话轮数上限（P3e Task 19）** ──────────────────────────────────────────
 *
 * **这一族守的是一条会被运维直接看见的性质**，与本文件上面几族（判据瞎了 / 注释说假话）
 * 不是同一类失败方式。被守的两句话各有一半：
 * ① **有上限**——`turns` 在 P3e 之前只进不出，而单次整版重建的临时串量与轮数成正比
 *    （同一个板块文件里实测记着 1 / 5 / 10 轮 = 3.0 / 15.0 / 30.0 MB）；
 * ② **截断必须说出来**——静默丢弃用户看得见的内容就是撒谎，那句话是
 *    `admin-ui/js/sec-playground.js` 的 `buildTurn()` 自己写下的。
 *
 * ⚠️⚠️ **只做 ① 不做 ② 比不做更糟**：一个开了一天的标签页会安静地少掉最旧的几十轮，
 * 而屏幕上没有任何一处提到这件事——运维回头找那一轮时会以为是自己记错了。
 * 所以下面「披露那一句」的**正反两格是一组**，缺任何一格都不算守住：
 * 只有正格 ⇒ 无条件渲染那句话也全绿（它变成一句恒真的话）；
 * 只有反格 ⇒ 压根不渲染也全绿。
 *
 * ⚠️ **`.pg-clear` 的「灰」在这里只验得到属性，验不到「点不动」**（文件头那段替身能力
 * 核对里登记的 3 条盲点之一：`tests/helpers/fake-dom.ts` 里点一颗 disabled 的按钮
 * 照样会触发监听器）。⇒ 真正起作用的那一道是 `clearTurns()` 开头那句早退，
 * 下面「在飞时按清空对话」那一格钉的是它，**不是那个灰**。
 */
describe("对话轮数上限：截断要可见，清空要显式，还在收的那一轮不许被切掉", () => {
  /**
   * ① **有上限，而且丢掉的是最旧的那几轮。**
   *
   * **变红条件**：把 `PLAYGROUND_TURNS_MAX` 调大到装不下（例如 999）⇒ 屏幕上剩全部；
   * 把 `pushTurn()` 里那两句截断删掉 ⇒ 同上。
   */
  it("① 连发「上限 + 3」轮：屏幕上恰好剩上限那么多轮，而且留下的是最新的那几轮", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    await sendTurns(sec, PLAYGROUND_TURNS_MAX + 3);

    expect(gatewayCalls(h).length, "前置条件：每一下都真的飞出去了")
      .toBe(PLAYGROUND_TURNS_MAX + 3);
    expect(pick(sec, ".pg-turn").length, "屏幕上留下的轮数不等于上限").toBe(PLAYGROUND_TURNS_MAX);
    // **逐条写出留下的是哪几轮**：只数个数的话，「删最新的」那种实现照样全绿。
    expect(turnPrompts(sec), "被删掉的不是最旧的那三轮")
      .toEqual(Array.from({ length: PLAYGROUND_TURNS_MAX }, (_, i) => `轮次-${i + 3}`));
  });

  /**
   * ② **被移除了几轮必须写在屏幕上，次数与上限都从常量插值进去。**
   *
   * ⚠️ **两个数都不许写死在字典里**：写死之后改常量就会让那句话变成假话，
   * 而字典没有任何机器在守（同 `pg.send.readyVideo` 那条处置）。
   *
   * **变红条件**：把 `trimTurns()` 的 `removed` 恒返回 0；
   * 或者把那句披露从 `buildRight()` 里删掉。
   */
  it("② 被移除了几轮写在屏幕上，次数与上限都从常量插值进去 —— 静默丢弃就是撒谎", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    await sendTurns(sec, PLAYGROUND_TURNS_MAX + 3);

    const expected = say("pg.conv.trimmed", { count: "3", max: String(PLAYGROUND_TURNS_MAX) });
    expect(one(sec, ".pg-trimmed").textContent, "那句披露不是插值出来的").toBe(expected);
    // **写在屏幕上**，不是塞进某个属性里（`visibleTexts` 的边界见它上面那段）。
    expect(visibleTexts(sec).join(" "), "那句披露没有进文档树的文本里").toContain(expected);
    expect(visibleTexts(sec).join(" "), "被移除的轮数没有上屏").toContain("3");
    // 字典侧：这两个数是占位符，不是写死的字面量。
    expect(String(I18N["pg.conv.trimmed"]!["zh-CN"]), "次数被写死进字典了").toContain("{count}");
    expect(String(I18N["pg.conv.trimmed"]!["zh-CN"]), "上限被写死进字典了").toContain("{max}");
    // 可达性：它是一条**活区域**，不是一段谁都不会回头再读一遍的静态文字。
    // ⚠️ **这里验得到的只有这个属性**：读屏器到底念没念，替身答不了（登记在案）。
    expect(one(sec, ".pg-trimmed").getAttribute("role"), "披露不是活区域，读屏器不会念它")
      .toBe("status");
  });

  /**
   * ③ **反向控制（与 ② 同组）：没删过东西的时候，那句话一个字都不许出现。**
   *
   * ⚠️ **反向控制用仓里真实存在的串**：拿字典里那句话去掉占位符之后的**前半段**去扫，
   * 不是自造一个「大概长这样」的样本。
   *
   * ⚠️ **边界走两格（上限 - 1 与恰好上限）**：只走前者的话，
   * 一个 `>=` 写成 `>` 的差一错误在这一格上是绿的。
   *
   * **变红条件**：把 ② 那句披露改成无条件渲染 ⇒ 这一格红（证明它不是恒真的）。
   */
  it("③ 反向控制（同组）：不到上限时那句披露一个都不出现 —— 否则它是恒真的", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    const zh = String(I18N["pg.conv.trimmed"]!["zh-CN"]);
    const head = zh.slice(0, zh.indexOf("{"));
    expect(head.length, "前置条件：那句话得有一段不含占位符的前缀可以拿来扫").toBeGreaterThan(3);

    await sendTurns(sec, PLAYGROUND_TURNS_MAX - 1);
    expect(pick(sec, ".pg-turn").length).toBe(PLAYGROUND_TURNS_MAX - 1);
    expect(pick(sec, ".pg-trimmed").length, "上限 - 1 轮：一轮都没删，却说删了").toBe(0);
    expect(visibleTexts(sec).join(" "), "上限 - 1 轮：那句披露的措辞出现在了屏幕上")
      .not.toContain(head);

    await sendTurns(sec, 1, PLAYGROUND_TURNS_MAX - 1);
    expect(pick(sec, ".pg-turn").length).toBe(PLAYGROUND_TURNS_MAX);
    expect(pick(sec, ".pg-trimmed").length, "恰好上限：一轮都没删，却说删了").toBe(0);
    expect(visibleTexts(sec).join(" "), "恰好上限：那句披露的措辞出现在了屏幕上")
      .not.toContain(head);
  });

  /**
   * ③b **边界的另一侧：多出第一轮的那一下，说的必须是「1」。**
   *
   * 上面那一格证明「不该说的时候不说」，这一格证明**第一次该说的时候就说，而且数得对**。
   * 少了它，一个「删两轮才开始报」的实现在 ① ② ③ 三格上全绿。
   */
  it("③b 越过上限的第一轮：那句披露当场出现，而且报的是 1 轮", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    await sendTurns(sec, PLAYGROUND_TURNS_MAX + 1);

    expect(pick(sec, ".pg-turn").length).toBe(PLAYGROUND_TURNS_MAX);
    expect(one(sec, ".pg-trimmed").textContent)
      .toBe(say("pg.conv.trimmed", { count: "1", max: String(PLAYGROUND_TURNS_MAX) }));
    expect(turnPrompts(sec)[0], "删掉的不是第 0 轮").toBe("轮次-1");
  });

  /**
   * ④ **「清空对话」是一颗显式按钮，按完之后右栏回到「还没有发过请求」那一档。**
   *
   * ⚠️ **累计被移除的轮数要跟着归零**：一个 0 轮对话的右栏还挂着「已经移除了 3 轮」，
   * 是本仓全局约束 9 那一族的同型假话（那 3 轮不是从这个空对话里移除的）。
   *
   * ⚠️⚠️ **「清空之后再发一轮」这一段是变异实测逼出来的，别当成凑数的收尾。**
   * 不走那一步的话，「`trimmedTurns` 归没归零」在屏幕上**完全不可观测**——
   * 0 轮时 `buildRight()` 在披露那一句之前就早退了。
   * **实测：把 `clearTurns()` 里那句 `trimmedTurns = 0;` 改成 `trimmedTurns += 0;`
   * ⇒ 本文件 73/73 全绿**，而那一版会在**下一轮**对话里说「最旧的 3 轮已经从这里移除」，
   * 那 3 轮并不是从这个新对话里移除的。补上那一段之后它才变红。
   *
   * ⚠️ **清空是纯本地动作**：这一格顺带钉住「它一条上游请求都不打」——
   * 一颗按下去会烧配额的按钮属于全局约束 14，那是另一套护栏。
   */
  it("④ 点一下「清空对话」：右栏一轮不剩，那句「还没有发过请求」回来，披露也跟着走", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    await sendTurns(sec, PLAYGROUND_TURNS_MAX + 3);
    expect(pick(sec, ".pg-trimmed").length, "前置条件：得先真的截断过一次").toBe(1);
    const before = gatewayCalls(h).length;

    one(sec, ".pg-clear").click();
    await settle(20);

    expect(pick(sec, ".pg-turn").length, "按了清空却还留着轮次").toBe(0);
    expect(pick(sec, ".pg-trimmed").length, "0 轮对话里还说着「已经移除了几轮」").toBe(0);
    expect(visibleTexts(sec).join(" "), "空对话那句话没有回来").toContain(say("pg.conv.empty"));
    expect(pick(sec, ".pg-clear").length, "一轮都没有了还摆着「清空对话」").toBe(0);
    expect(gatewayCalls(h).length, "清空对话打了一条上游请求").toBe(before);

    // **清空之后再发一轮**：累计计数归没归零，只有在这一步才看得见（理由见上面那段 ⚠️⚠️）。
    await sendTurns(sec, 1, 100);
    expect(pick(sec, ".pg-turn").length, "前置条件：新的这一轮得真的进右栏").toBe(1);
    expect(pick(sec, ".pg-trimmed").length,
      "清空之后累计计数没归零：新对话里说着上一段对话移除了几轮").toBe(0);
  });

  /**
   * ⑤ **截断安全网：还在收的那一轮永远不许被切掉。**
   *
   * ⚠️⚠️ **这一格是为搬运风险设的，不是为完备性设的。** 切掉正在收的那一轮 =
   * 把「后半段回答写进一个没人看得见的节点」这条 P3d 刚修好的祸事原样搬回来：
   * 那一轮的 `turn` 对象仍被流那条回调握着，写进去的字节全落在一个已经不在
   * `turns` 里的对象上，而屏幕上什么都不会提。
   *
   * ⚠️ **观测点有两个，缺一不可**：① 那一轮还在屏幕上；
   * ② `.pg-stream-text` **仍然收得到后续正文**。只验 ① 的话，
   * 一个「留着框但把节点换掉」的实现照样绿，而那正是 P3d 那次祸事的形态本身。
   *
   * ⚠️⚠️ **它钉住的是「结果」，不是 `trimTurns()` 里那条 `live` 过滤器，别写反了。**
   * 变异实测两条，结论相反：
   * · **把 `live` 那一段删掉 ⇒ 这一格是绿的。**
   *   ⚠️ **「删掉」指的是 `live` 与 `done` 一起改成等价形态**（`live = []` **并且**
   *   `done = turns`，也就是「留最后 max 个」那种写法）：板块今天永远把 `pending`
   *   那一轮最后 push 进去，两种实现在这条形态上输出逐字相同
   *   —— **第二层替第一层挡住了变异。**
   *   **只改一半不算**（复评 F-5 实测）：只把 `live` 改成 `[]`、不动 `done`
   *   ⇒ **这一格当场红**，因为那是不等价改写，pending 那一轮会被整条丢掉。
   *   那条过滤器的红线在 `tests/ui/playground.test.ts` 的
   *   「还在收的那一轮一律留下，即使它排在中间、或者条数本身就顶过上限」上。
   * · **把 `keepDone` 那一句从「留最新的几轮」改成「留最旧的几轮」⇒ 这一格当场红**，
   *   而且是照祸事本身的形态红的：那一轮从屏幕上消失、`.pg-stream-text` 一个都不剩。
   * ⇒ 这一格守的是**运维看得见的那一半**（还在收的那一轮不许从屏幕上消失，
   * 而且它的正文还得写得进去），过滤器那一半归纯函数那一族。
   */
  it("⑤ 截断安全网：还在收的那一轮永远不许被切掉 —— 切了它就是把后半段写进没人看得见的节点", async () => {
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const enc = new TextEncoder();
    const held = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    let streaming = false;
    const h = await openPg(respondWith({
      gateway: () => (streaming
        ? { status: 200, body: null, raw: held }
        : { status: 200, body: { reply: "PONG-FROM-UPSTREAM" } }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    await sendTurns(sec, PLAYGROUND_TURNS_MAX);
    expect(pick(sec, ".pg-turn").length).toBe(PLAYGROUND_TURNS_MAX);
    expect(pick(sec, ".pg-trimmed").length, "前置条件：到这里还没有任何一轮被移除").toBe(0);

    // 第「上限 + 1」轮是一条**还在收**的流式轮：它在请求发出去之前就进了 turns。
    streaming = true;
    turnOnStream(sec);
    typePrompt(sec, "流式那一轮");
    one(sec, ".pg-send").click();
    await settle(40);

    expect(pick(sec, ".pg-turn").length, "截断没发生或者多切了一轮").toBe(PLAYGROUND_TURNS_MAX);
    expect(one(sec, ".pg-trimmed").textContent, "被移除的应当恰好是最旧的那一轮")
      .toBe(say("pg.conv.trimmed", { count: "1", max: String(PLAYGROUND_TURNS_MAX) }));
    // ① 还在收的那一轮还在屏幕上，而且在最后。
    expect(turnPrompts(sec).at(-1), "还在收的那一轮被切掉了").toBe("流式那一轮");
    expect(turnPrompts(sec)[0], "被切掉的不是最旧的那一轮").toBe("轮次-1");

    // ② 后续正文仍然写得进屏幕上那个节点。
    ctl!.enqueue(enc.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "甲" } }] })}\n\n`));
    await settle(40);
    expect(one(sec, ".pg-stream-text").textContent, "第一块正文没进屏幕").toBe("甲");
    ctl!.enqueue(enc.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "乙" } }] })}\n\n`));
    await settle(40);
    expect(one(sec, ".pg-stream-text").textContent, "截断之后那个节点就收不到后续正文了").toBe("甲乙");
    ctl!.close();
    await settle(40);
    expect(pick(sec, ".pg-turn").length, "流结束之后轮数不该再变").toBe(PLAYGROUND_TURNS_MAX);
  });

  /**
   * ⑥ **在飞时「清空对话」整个早退。**
   *
   * ⚠️⚠️ **这一格钉的是 `clearTurns()` 开头那句 `if (inFlight) return;`，不是按钮的灰。**
   * 替身里点一颗 disabled 的按钮**照样会触发监听器**（文件头那段替身能力核对里
   * 登记的 3 条盲点之一），所以下面那句 `.disabled` 断言只是给人看的那一半，
   * **真正起作用的是「点完之后那一轮还在，而且正文还在往里写」**。
   *
   * ⚠️ 灰按钮要说明理由：`title` 上那句话与发送按钮在飞那一档**同一个 key**，
   * 抄第二句话出来只会得到两句会漂的话。
   */
  it("⑥ 在飞时按「清空对话」：一轮都不许清掉 —— 清掉正在收的那一轮就是把后半段写进没人看得见的对象", async () => {
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const enc = new TextEncoder();
    const held = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    const h = await openPg(respondWith({
      gateway: () => ({ status: 200, body: null, raw: held }),
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "还在收的这一轮");
    turnOnStream(sec);
    one(sec, ".pg-send").click();
    await settle(40);
    expect(pick(sec, ".pg-turn").length, "前置条件：那一轮得先进右栏").toBe(1);

    // 给人看的那一半。
    expect(one(sec, ".pg-clear").disabled, "在飞时「清空对话」没有变灰").toBe(true);
    expect(one(sec, ".pg-clear").getAttribute("title"), "灰按钮没说为什么按不动")
      .toBe(say("pg.send.blockedInFlight"));

    // 真正起作用的那一半。
    one(sec, ".pg-clear").click();
    await settle(20);
    expect(pick(sec, ".pg-turn").length, "在飞时把还在收的那一轮清掉了").toBe(1);

    ctl!.enqueue(enc.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "丙" } }] })}\n\n`));
    await settle(40);
    expect(one(sec, ".pg-stream-text").textContent, "清空之后那一轮的正文写进了没人看得见的对象").toBe("丙");

    ctl!.close();
    await settle(40);
    // 落地之后按钮解灰，清空这条路重新走得通。
    expect(one(sec, ".pg-clear").disabled, "回来之后「清空对话」没有解灰").toBe(false);
    one(sec, ".pg-clear").click();
    await settle(20);
    expect(pick(sec, ".pg-turn").length, "落地之后清空仍然清不掉").toBe(0);
  });

  /**
   * ⑦ **`turns` 的写只许出现在那两个函数与那句声明里。**
   *
   * ⚠️⚠️ **这一格是上面那六格覆盖不到的那一半，别把它当成锦上添花。**
   * 发货代码里有**四条** push 路径（构造失败 / 流式那一轮 / 非流式成功 / 非流式失败），
   * 而上面那几格只走得到其中两条（变异实测：把流式那条与非流式成功那条各自换回
   * `turns.push(...)` ⇒ ⑤ 与 ①②③b④ 分别变红；**另外两条换回去则一格都不红**）。
   * 漏掉的那条路径会**只在它自己那一档**上绕过截断与那句披露，
   * 而屏幕上分辨不出来——少掉的正是最旧的那几轮。
   * ⇒ 判据因此建在**源码形态**上，一次盖住四条、以及将来任何一条第五条。
   *
   * ⚠️⚠️ **上一版这里写的是一句全称句（「全文件只有 `pushTurn()` 一个写入口」），
   * 而判据只扫 `turns.push(`——赋值形态是一个无人守的真洞。** 复评 M-E 逐字实测：
   * 把 `failed()` 那条 `pushTurn(turn)` 换成 `turns = turns.concat([turn])`
   * ⇒ **那一轮 74/74 全绿**，而屏幕上那句披露从此永远说 0 轮。
   * **这不是一条想象出来的写法**：这个文件自己就在用赋值形态
   * （`pushTurn()` 里的 `turns = kept;`、`clearTurns()` 里的 `turns = [];`），
   * `turns = [...turns, turn]` 是这里最自然的下一种写法。
   * ⇒ 判据改成**把每一次「写」都认出来**（赋值 / `+=` 一族 / 会改数组自身的方法调用 /
   * `turns[i] =` / `turns.length =`），允许出现的位置只有三处：
   * 模块顶上那句声明、`pushTurn()` 体内、`clearTurns()` 体内。
   * ⭐ 这是本文件 H1/H3 那条形状的**第三次发作**（「写下的覆盖面小于宣称的范围」）
   * ——所以下面把**它今天认不出哪些**也逐条种了一次。
   *
   * ⚠️ **用例名里那句「判据认得的四种写形态」是刻意加上去的限定**：上一版栽在
   * 「写下的覆盖面小于宣称的范围」上，这一版不把话说满——下面这两种写法它就认不出来，
   * **今天两条都没有红线**，形态上也都不像有人会顺手写出来，但它们不是「不存在」：
   * · **别名**：`const t = turns; t.push(turn);` —— 判据只认名字叫 `turns` 的那一个。
   * · **嵌套下标**：`turns[arr[0]] = turn;` —— 下标里再出现一个 `]` 就切不出来了
   *   （`turns[turns.length - 1] = turn` 这种**不含嵌套方括号**的形态是认得出来的，
   *   下面那组逃逸样本里有它）。
   *
   * ⚠️⚠️ **上一版那条 `inside.length === 1` 已经去掉，这是有意的**（复评 F-2 / M-G）：
   * 在 `pushTurn()` 体内再加一条**合法**的 `turns.push(` ⇒ 上一版当场红，
   * 而它印出来的话是「一处都没扫到 —— 它多半是瞎的」，diff 却是 `expected 2 to be 1`
   * ⇒ 照那句话去处置的人会去查一条根本没瞎的正则。**而那条变异本来就不是缺陷**：
   * 同一个函数里 push 几次都行，紧跟着的 `trimTurns()` 照样跑、那句披露照样算。
   * ⇒ 真正的不变式是「写只许出现在那两个函数与那句声明里」，等值断言因此建在**总数**上；
   * 防瞎扫那一半降成 `toBeGreaterThan(0)`，不再兼职一句它守不住的话。
   *
   * ⚠️ **反向控制有三层，缺一不可**：
   * ① 判据在 `pushTurn()` / `clearTurns()` 里**真的**各扫到写（恒空的扫描永远是绿的）；
   * ② 把发货代码里那一行 `turns.push(turn);` 逐字改写成各种逃逸形态，判据必须照样算它一次写
   *   ——**M-E 那条洞的直接回归**；
   * ③ 拿**发货代码里真实存在的三行读**去打它，判据不许把读吵成写（否则这一格会恒红，
   *   而恒红的下一步就是有人把它删掉）。
   */
  it("⑦ `turns` 的写只许出现在 pushTurn() / clearTurns() 与那句声明里（判据认得的四种写形态）—— 绕过它们的那条路径截断与披露都不会发生", () => {
    const src = stripComments(readFileSync("admin-ui/js/sec-playground.js", "utf8"));
    const slice = (fn: string): string => {
      const sliced = functionBodyOf(src, fn);
      expect("reason" in sliced ? sliced.reason : null,
        `${fn}() 的函数体切不出可靠边界 —— 在边界求得回来之前这条纪律整个失效，宁可红也不猜`)
        .toBe(null);
      return (sliced as { body: string }).body;
    };
    const push = slice("pushTurn");
    const clear = slice("clearTurns");

    // 模块顶上那句声明本身也是一次写。**它必须恰好一句**，否则下面那道减法就不成立。
    const decl = src.match(/\b(?:let|const|var)\s+turns\s*=/g) ?? [];
    expect(decl.length,
      "模块顶上那句 `let turns = [];` 找不到了（或者变成了不止一句）—— 这一格的判据要跟着改")
      .toBe(1);

    // **反向控制①**：判据认得出仓里真的存在的那几处写。
    expect(turnsWrites(push).length,
      "判据在 pushTurn() 里一处写都没扫到 —— 它多半是瞎的，而瞎了的扫描是绿的")
      .toBeGreaterThan(0);
    expect(turnsWrites(clear).length,
      "判据在 clearTurns() 里一处写都没扫到 —— 它多半是瞎的，而瞎了的扫描是绿的")
      .toBeGreaterThan(0);

    // **反向控制②**：M-E 那条洞的回归。逃逸样本是把发货代码那一行逐字改写出来的。
    for (const escape of [
      "turns = turns.concat([turn]);",
      "turns = [...turns, turn];",
      "turns.unshift(turn);",
      "turns.splice(0, 0, turn);",
      "turns[turns.length] = turn;",
      "turns[turns.length - 1] = turn;",
      "turns.length = 0;",
    ]) {
      expect(turnsWrites(escape).length, `判据认不出这种写法，它会静静地放行：${escape}`).toBe(1);
    }
    // **反向控制③**：这三行**逐字抄自发货代码**，它们是读，一次都不许算成写。
    for (const read of [
      "const { kept, removed } = trimTurns(turns);",
      "if (turns.length === 0) {",
      "for (const turn of turns) body.appendChild(buildTurn(turn));",
    ]) {
      expect(turnsWrites(read).length, `判据把一次读吵成了写，这一格会恒红：${read}`).toBe(0);
    }

    const all = turnsWrites(src);
    const allowed = turnsWrites(push).length + turnsWrites(clear).length + decl.length;
    expect(all.length,
      `全文件扫到 ${all.length} 次对 turns 的写，而 pushTurn() + clearTurns() + 那句声明只占 ${allowed} 次：`
      + `要么有人绕开这两个函数直接写 turns（那条路径上截断与「已移除几轮」都不会发生），`
      + `要么这两个函数自己多/少了一次写。扫到的全部：${JSON.stringify(all)}`)
      .toBe(allowed);
  });

  /**
   * ⑧ **登出不清 `turns` / `trimmedTurns` —— 如实钉住今天这条形态。**
   *
   * ⚠️⚠️ **这一格不是在说这样是对的。** 它钉的是「`turns` 上方那段登记不许变成假话」：
   * 下一个登录的人今天**看得见上一个人的整段对话**（每一轮的提示词、状态码、响应体正文），
   * 外加那句「最旧的 N 轮已经从这里移除」。哪天有人把它清干净了，**这一格会红**
   * ——那时该做的是回去把那段登记改真，并**确认同族那七个板块一起清了**，
   * 而不是把这一格删掉。
   *
   * ⚠️ **为什么本轮不修**（理由全文在 `admin-ui/js/sec-playground.js` 的 `turns` 上方）：
   * 板块自己**分辨不出登出与切板块**——两者走的是同一个 `onHide()`，
   * 而切走再切回来把对话清掉是运维每天都会踩到的倒退。
   *
   * ⚠️ **替身差异明写**：这里的重新登录走 `h.form.submit()`，
   * 而**真实 DOM 上 `.submit()` 不触发 submit 监听器**（文件头那段替身能力核对里
   * 登记的 3 条盲点之一）。⇒ 这一格验的是「重新进入壳层之后右栏画成什么样」，
   * 验不到「运维按回车这件事本身」——后者由 `tests/ui/dom/app-gate.test.ts` 的
   * 「退出登录之后 #gate-key 是空的（不清空的话上一个人的口令原样留在输入框里）」守着，
   * 那一格正是同一族缺陷（登出之后下一个人不许看见上一个人的东西）**已经修掉的**那一半。
   */
  it("⑧ 登出再登录：上一个人的那几轮原样还在右栏 —— 今天的形态，清干净的那天这一格会红", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    await sendTurns(sec, PLAYGROUND_TURNS_MAX + 3);
    expect(pick(sec, ".pg-trimmed").length, "前置条件：得先真的截断过一次").toBe(1);
    // ⚠️ 用 `pick(...)[0]` 不用 `one(...)`：右栏此刻有上限那么多个 `.pg-body`，
    //    `one()` 会先在「恰好一个」那句上红掉，而红因与这一格要说的事无关。
    expect(pick(sec, ".pg-body")[0]!.textContent, "前置条件：响应体正文得真的在屏幕上")
      .toContain("PONG-FROM-UPSTREAM");

    h.dom.byId("logout-btn").click();
    await settle(20);
    expect(h.shell.classList.contains("on"), "前置条件：得真的退出去了").toBe(false);

    h.input.value = TOKEN;
    h.form.submit();
    await settle(20);
    expect(h.shell.classList.contains("on"), "前置条件：得真的重新登录进来了").toBe(true);

    const back = h.section("playground");
    expect(pick(back, ".pg-turn").length,
      "登出再登录之后右栏那几轮不见了 —— 有人清了 turns：回去把 `turns` 上方那段登记改真，"
      + "并确认 sec-keys / sec-usage / sec-events / sec-registrar / sec-settings / sec-models / "
      + "sec-overview 那七个板块的内存态也一起清了")
      .toBe(PLAYGROUND_TURNS_MAX);
    expect(turnPrompts(back)[0], "留下的不再是上一个人最旧的那一轮 —— 形态变了，回去改那段登记")
      .toBe("轮次-3");
    expect(pick(back, ".pg-body").map((n) => n.textContent).join(" "),
      "上一个人的响应体正文不见了 —— 有人清了 turns：回去把那段登记改真")
      .toContain("PONG-FROM-UPSTREAM");
    expect(pick(back, ".pg-trimmed").length,
      "那句「最旧的 N 轮已经从这里移除」不见了 —— 有人清了 trimmedTurns：回去把那段登记改真")
      .toBe(1);
  });
});
