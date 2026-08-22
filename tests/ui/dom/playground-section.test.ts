import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle, PANEL_ORIGIN, type Harness } from "./harness.js";
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  /** 对外那条请求怎么应答。**返回 `{ raw }` 就是一段原样的 SSE 字节**（流式那一档用）。 */
  gateway?: () => Resp | Promise<Resp>;
} = {}): Responder {
  return (url: string) => {
    if (url.startsWith("/admin/api/models")) return opts.catalog ?? { status: 200, body: catalogPayload() };
    if (url.startsWith("/admin/api/config")) return opts.config ?? { status: 200, body: configBody("wxyz") };
    if (url.startsWith(PANEL_ORIGIN)) return (opts.gateway ?? (() => ({ status: 200, body: { reply: "PONG-FROM-UPSTREAM" } })))();
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
   * **模式分段本任务就要出现，另两档按不动。**
   * 变红条件：把那两档的 `btn.disabled = true` 删掉 ⇒ 面板承诺了一个还不存在的功能。
   * ⚠️ 这一格验的是**属性**，不是「点不动」——见文件头那段 ⚠️（夹具的 `.disabled` 不拦点击）。
   */
  it("模式分段三档就位，图片与视频按不动且各带一句说明 —— 只留一个灰按钮等于让人对着它猜", async () => {
    const h = await openPg(respondWith());
    const sec = h.section("playground");
    const modes = pick(sec, "[data-mode]");
    expect(modes.map((b) => b.getAttribute("data-mode"))).toEqual(["chat", "image", "video"]);
    expect(modes.map((b) => b.disabled)).toEqual([false, true, true]);
    // 期望值手写整句：`toContain("按不动")` 在别的文案里也是子串。
    expect(modes[1]!.getAttribute("title")).toBe("这一档还没有接线，暂时按不动。");
    expect(modes[2]!.getAttribute("title")).toBe("这一档还没有接线，暂时按不动。");
    // 对话那一档**没有** title：它是唯一能用的一档，给它挂一句「按不动」是假话。
    expect(modes[0]!.getAttribute("title")).toBe(null);
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
