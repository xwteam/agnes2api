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
 * 所以在飞去重那条护栏在发货代码里是**两道**：`btn.disabled = …`（给人看的）
 * **加** `sendOnce()` 开头那句 `if (inFlight) return;`（真正起作用的那一道）。
 * 下面「在飞时再点一次发送：不许发出第二条」那一格钉的是**后者**——
 * 它在夹具里是可观测的，而前者不是。
 *
 * ⚠️ 本文件的**测试代码**里遍历子树用的是 `for…of` + `.children` 递归，不调 `.walk()`
 * ——真实 DOM 上 `.children` 是可迭代的 `HTMLCollection`，`.walk()` 根本不存在。
 * 测试不在那道扫描范围内，但照真实语义写才不会把一个错的写法教给下一个人。
 */
const TOKEN = "admin-token-0123456789-ok!";
const GW_TOKEN = "gateway-token-0123456789-wxyz";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Resp = { status: number; body: unknown };
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

/** 把网关口令粘进那个输入框（走真的 `input` 事件，不是直接改状态）。 */
function pasteToken(section: FakeElement, value: string): void {
  one(section, ".pg-token").input(value);
}

/** 写一句提示词。 */
function typePrompt(section: FakeElement, value: string): void {
  one(section, ".pg-prompt").input(value);
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

  it("流式开关就位但按不动，且说清「这里发的是非流式」 —— 能按却什么都不变的开关是一句假话", async () => {
    const h = await openPg(respondWith());
    const box = one(h.section("playground"), ".pg-stream");
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("title")).toBe("流式还没有接线，暂时按不动；这里发的是非流式请求。");
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
              sampleBody: { model: "m0", input: "ping" },
            },
            {
              id: "delta", label: "Delta", method: "POST", pathTemplate: "/probe/delta",
              authHeader: "x-api-key", streamMode: "body", streamKey: "stream",
              sampleBody: { model: "m0", input: "ping" },
            },
          ],
          models: [
            { id: "only-alpha", modality: "chat", protocols: ["alpha"], endpoints: [] },
            { id: "only-delta", modality: "chat", protocols: ["delta"], endpoints: [] },
          ],
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
   * ⚠️ 这一格逐个节点扫**全部属性值**（`title` / `data-*` / `placeholder` / `aria-*` …）
   * 与**整块渲染文本**，只放过那个输入框自己的 `.value`
   * （真实 DOM 里 `.value` 是 IDL 属性，不进 `attributes`，也不进 `textContent`）。
   *
   * **变红条件（逐条都是最自然的写法）**：
   * · 把 `syncSendButton()` 的 tooltip 写成 `t(key) + token`；
   * · 给口令输入框加一个 `data-value` / `title` 之类的调试属性；
   * · 把 `sendOnce()` 的 `catch` 分支改成把 `e.message` 或整份请求头画出来；
   * · 在右栏那一轮里把请求头一起渲染出来。
   */
  it("面板上任何一处都不出现网关口令 —— 输入框的值不许漏进标题、属性或任何一句错误文案", async () => {
    const h = await openPg(respondWith({
      // 让这一次**失败**：错误路径是口令最自然的泄漏口。
      gateway: () => { throw new Error("boom"); },
    }));
    const sec = h.section("playground");
    pasteToken(sec, GW_TOKEN);
    typePrompt(sec, "你好");
    one(sec, ".pg-send").click();
    await settle(20);

    // 前置条件①：这一轮必须真的走到了错误那一档，否则这一格扫的是一块空白。
    expect(pick(sec, ".pg-error").length, "前置条件：这一次得真的失败").toBe(1);
    // 前置条件②：口令确实在输入框里（少了它，下面的「哪儿都没有」在一个空面板上也成立）。
    expect(one(sec, ".pg-token").value).toBe(GW_TOKEN);

    // ① 整块渲染文本里没有它。
    expect(sec.textContent, "网关口令被渲染到了屏幕上").not.toContain(GW_TOKEN);
    // ② 逐个节点、逐个属性值里都没有它。
    for (const node of everyNode(sec)) {
      for (const [name, value] of node.attrs) {
        expect(value, `<${node.tagName}> 的 ${name} 属性里带上了网关口令`).not.toContain(GW_TOKEN);
      }
    }
    // ③ 连口令的一段（末 8 位）都不许出现——一条末位旁路同样是旁路。
    const tail = GW_TOKEN.slice(-8);
    expect(sec.textContent, "网关口令的末段被渲染了出来").not.toContain(tail);
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
