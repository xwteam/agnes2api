import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle, PANEL_ORIGIN, type Harness } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { catalogPayload } from "../../../src/core/admin/protocol-catalog.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **设置页第 4 张卡（集成示例）的渲染与接线（P3d Task 7 Step 4）。**
 *
 * `tests/ui/examples.test.ts`「URL 由 origin 加真源的 pathTemplate 拼出来 —— 换一条路径，示例里那条必须跟着换」
 * 把拼代码那一步测得很细，**但没有任何东西验证板块文件真的把 `origin` 读进来、
 * 真的把那段代码画了出来**。把 `exOrigin` 写成一条字面量地址，纯函数用例一条都不红
 * ——而面板会教出一条指向别人服务器的 URL。这一组补的就是那一半。
 *
 * ── **替身能力核对（第 9 种假阳性，逐条写出来）** ─────────────────────────────
 * `tests/ui/dom/fake-dom-parity.test.ts`「admin-ui/js/ 下的发货代码不许出现 fake-dom.ts 独有的成员名」
 * 是权威表：`FAKE_ONLY_MEMBERS` **8 条**
 *（`.walk()` / `.parent` / `.input()` / `.attrs` / `.listeners` / `classList.reset()` /
 * `querySelectorAll()` 后紧跟数组方法 / `.children` 后紧跟数组方法），
 * `KNOWN_BLIND_SPOTS` **3 条**（返回值先存进变量再调数组方法 / `submit()` 语义相反 /
 * `.disabled` 挂错宿主）。
 * 本任务给 `admin-ui/js/sec-settings.js` 新增的那段（`renderExamples()` / `loadCatalog()`）
 * 用到的 DOM 成员逐个对过：`createElement` / `setAttribute` / `textContent` /
 * `appendChild` / `addEventListener` / `classList.toggle(name, force)`
 * ——**8 条一条都没用到，3 条盲点也一条都没踩**（这段不遍历子树、不碰表单、没有禁用态，
 * 一次都不调 `querySelectorAll`）。
 * ⚠️ **另有一个不在那张表里的替身：`location`**（本任务给 `harness.ts` 加的）。
 * 它只有 `origin` 一格，**比真实的 Location 弱**，所以它不会让缺陷变得不可观测；
 * 反过来，发货代码哪天用到 `location` 的别的字段，这里会当场抛错而不是静默给 `undefined`。
 *
 * ⚠️ **`innerHTML` 在 `FakeElement` 上根本不存在**：板块若把代码块改成 `innerHTML`，
 * 下面那几格读 `textContent` 的断言会读到空串而变红。**这是一条间接判据，别把它读成
 * 「有一道扫描在守 innerHTML」**——真正逐字守 `textContent` 的是这几格自己。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/**
 * 缺省应答：协议目录交出**真源那一份**（`catalogPayload()`），**不手抄一份**
 *（第 7 种假阳性：测的是抄件不是原件）；配置那条给一份空对象——这张卡不看配置。
 */
function respondWith(catalog: unknown = catalogPayload(), status = 200) {
  return (url: string) => {
    if (url.startsWith("/admin/api/models")) return { status, body: catalog };
    return { status: 200, body: {} };
  };
}

/** 打开设置板块（登录态 + 上次停在 settings）。 */
async function openSettings(
  respond: (url: string, method: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): Promise<Harness> {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "settings" },
    respond,
  });
  await settle(12);
  return h;
}

function section(h: Harness): FakeElement {
  return h.section("settings");
}

/** 代码块里那段字。**读的是渲染后的 `textContent`，不是源码文本。** */
function codeText(h: Harness): string {
  const pre = section(h).querySelector(".examples-code");
  return pre === null ? "" : pre.textContent;
}

function tabs(h: Harness, attr: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const b of section(h).querySelectorAll(`[${attr}]`)) out.push(b);
  return out;
}

function clickTab(h: Harness, attr: string, value: string): void {
  const btn = tabs(h, attr).find((b) => b.getAttribute(attr) === value);
  if (!btn) throw new Error(`找不到标签页 ${attr}=${value}`);
  btn.click();
}

/** 侧栏那颗导航按钮。 */
function navOf(h: Harness, name: string): FakeElement {
  const btn = h.dom.document.querySelectorAll(".nav-item")
    .find((b) => b.getAttribute("data-section") === name);
  if (!btn) throw new Error(`找不到导航按钮 ${name}`);
  return btn;
}

function modelCalls(h: Harness): number {
  return h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length;
}

describe("设置页第 4 张卡：集成示例", () => {
  /**
   * **本任务最要紧的一格。** 被守护的性质：示例里那条 base URL 是**运行期**从面板
   * 自己所在的地址取的，不是任何一条写死的字面量。
   *
   * 变红条件（实测写在 progress note 里）：把 `sec-settings.js` 里
   * `exOrigin = location.origin;` 换成任何一条字面量地址。
   */
  it("示例里那条地址逐字是当前面板的 origin —— 写死任何一个 base URL 都是错的", async () => {
    const h = await openSettings(respondWith());
    const code = codeText(h);
    // 前置条件：代码块得真的画出来了，否则下面两条在空串上都成立。
    expect(code.length, "前置条件：代码块是空的").toBeGreaterThan(40);
    expect(code, "示例里的地址不是当前面板的 origin").toContain(`${PANEL_ORIGIN}/v1/chat/completions`);
  });

  it("四个协议标签页 + 三个语言标签页，点一下代码块跟着换", async () => {
    const h = await openSettings(respondWith());
    // 标签页的档位来自响应，**这里手写它们的 id**（不从 `catalogPayload()` 推导）。
    expect(tabs(h, "data-ex-protocol").map((b) => b.getAttribute("data-ex-protocol")))
      .toEqual(["openai", "anthropic", "responses", "gemini"]);
    expect(tabs(h, "data-ex-lang").map((b) => b.getAttribute("data-ex-lang")))
      .toEqual(["curl", "python", "node"]);

    // 默认那一档：第一条协议 + curl。
    expect(codeText(h)).toContain("curl -X POST");

    // 换协议：Gemini 是四条里唯一把模型拼进路径的，换过去地址必须整条变。
    clickTab(h, "data-ex-protocol", "gemini");
    expect(codeText(h)).toContain(`${PANEL_ORIGIN}/v1beta/models/agnes-2.0-flash:generateContent`);
    expect(codeText(h), "换了协议，地址还停在上一条").not.toContain("/v1/chat/completions");

    // 换语言：同一条协议、不同语言，代码骨架必须不同。
    const beforeLang = codeText(h);
    clickTab(h, "data-ex-lang", "python");
    const afterLang = codeText(h);
    expect(afterLang).toContain("import requests");
    expect(afterLang, "换了语言，代码块纹丝不动").not.toBe(beforeLang);
    // 换语言不许把协议选择丢掉（两个选择器各自独立）。
    expect(afterLang).toContain(":generateContent");
  });

  /**
   * 被守护的性质：**面板拿不到明文网关口令，示例里只能是占位符**
   *（全局约束 11(b) / 设计 §8.6）。
   *
   * ⚠️ 观测点刻意落在**渲染出来的那段字**上，而不是纯函数的返回值：
   * 「有人在板块文件里把配置响应里的东西拼进示例」这条路径只有在这里才看得见。
   */
  it("示例里的口令是占位符 —— 配置响应里那点凭据线索一个字节都不许进代码块", async () => {
    const h = await openSettings((url) => {
      if (url.startsWith("/admin/api/models")) return { status: 200, body: catalogPayload() };
      // `GET /admin/api/config` 对网关口令只回 configured 与 hint 两格（设计 §8.6）。
      // hint 取一个显眼的探针值：它一旦出现在代码块里，就是有人开了回显口子。
      return {
        status: 200,
        body: { credentials: { gatewayToken: { configured: true, hint: "H1NT-PROBE" } } },
      };
    });
    const code = codeText(h);
    expect(code.length, "前置条件：代码块是空的").toBeGreaterThan(40);
    expect(code).toContain("YOUR_GATEWAY_TOKEN");
    expect(code, "配置响应里的凭据线索被拼进了示例").not.toContain("H1NT-PROBE");
    // 管理口令（localStorage 里那把）同样不许出现。
    expect(code, "管理口令被拼进了示例").not.toContain(TOKEN);
  });

  /**
   * 被守护的性质：**目录读不出来时不画一段假示例。**
   * 一段照着抄却打不通的代码比一句「读不出来」糟得多——后者运维知道要重试，
   * 前者他会去查自己的客户端。
   */
  it("协议目录读不出来时，卡上是一句「读不出来」，不是一段猜出来的示例", async () => {
    const h = await openSettings(respondWith(null, 404));
    expect(section(h).querySelector(".examples-code"), "读不出来却画了代码块").toBe(null);
    const note = section(h).querySelectorAll('[data-i18n="set.examples.unavailable"]');
    expect(note.length, "「读不出来」那句话没画出来").toBe(1);
  });

  it("响应读得回来但形状不对，同样落到「读不出来」，不画半段示例", async () => {
    // 一条协议缺了 `sampleBody` ⇒ 整份判成读不出来（不是把坏的那条跳过）。
    const bad = catalogPayload();
    const mangled = { ...bad, protocols: bad.protocols.map(({ sampleBody, ...rest }) => rest) };
    const h = await openSettings(respondWith(mangled));
    expect(section(h).querySelector(".examples-code"), "形状不对却画了代码块").toBe(null);
    expect(section(h).querySelectorAll('[data-i18n="set.examples.unavailable"]').length).toBe(1);
  });

  /**
   * 被守护的性质：**复制按钮交出去的是那一段代码本身**，不是屏幕上截断过的东西、
   * 也不是上一次选中的那一段。
   *
   * ⚠️ 这颗按钮是 `admin-ui/js/ui.js` 里 `copy()` 的**第一个消费者**——在本任务之前
   * 它是一段没人调用的导出。「留着的死代码迟早被人当成已经接好了」，这一格是那句话
   * 在本仓的兑现处。
   */
  it("复制按钮交给剪贴板的，逐字就是当前那一段代码", async () => {
    const h = await openSettings(respondWith());
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (s: string) => { written.push(s); } } });

    clickTab(h, "data-ex-protocol", "anthropic");
    const shown = codeText(h);
    const btn = section(h).querySelector(".examples-copy");
    expect(btn, "复制按钮没画出来").not.toBe(null);
    btn!.click();
    await settle(6);

    expect(written, "剪贴板一次都没被写").toHaveLength(1);
    expect(written[0], "交给剪贴板的不是屏幕上那一段").toBe(shown);
    // 前置条件：那一段确实是 Anthropic 那条，否则上面两条在任何一段上都成立。
    expect(shown).toContain(`${PANEL_ORIGIN}/v1/messages`);
  });

  /**
   * 被守护的性质：**这份目录是静态的，成功读过一次就不再读**，而且
   * **在飞时不许发出第二条链**——两条链并存正是 `admin-ui/js/sec-models.js` 文件头
   * 记着的那个缺陷的来源（一条晚到的失败会把已经画好的东西抹掉）。
   */
  it("切进设置页只打一次 GET /admin/api/models，切走再切回来不再打", async () => {
    const h = await openSettings(respondWith());
    expect(modelCalls(h), "前置条件：第一次进来得真的读过一次").toBe(1);

    navOf(h, "overview").click();
    await settle(12);
    navOf(h, "settings").click();
    await settle(12);

    expect(modelCalls(h), "切回来又读了一遍静态目录").toBe(1);
    // 而且切回来之后卡还在（不是空白）：早退那条路必须顺手重画。
    expect(codeText(h)).toContain(PANEL_ORIGIN);
  });

  /**
   * 被守护的性质：**目录读还在飞的时候，隐式入口（`onShow()`）不许发出第二条链。**
   *
   * ⚠️ **这一格与上面那格不是同一件事，分开写是因为它们守的是两条不同的守卫**：
   * 上面那格走的是 `exCatalog !== null` 那条早退（**读已经成功过**），
   * 这一格走的是 `exInFlight` 那条（**读还没回来**）。上面那格在 `exInFlight` 被删掉
   * 之后照样全绿——实测：删掉 `if (exInFlight) return;`，
   * 「切进设置页只打一次…」仍然绿，只有这一格红。
   *
   * **为什么两条链并存是个缺陷、而不只是多打一次请求**：先发的那条成功、
   * 后发的那条失败时，后者的 `catch` 会把 `exCatalog` 清成 `null`，
   * **把已经画好的示例卡整块抹掉**。`admin-ui/js/sec-models.js` 的文件头记着这个形态
   * 在模型板块上的实测过程（那里的量是 `rowsAfterLateFailure=0`）。
   *
   * ⚠️ **替身必须真的挂住**（第 8 种假阳性：瞬时替身让时序性质不可观测）：
   * 应答返回一个**永不落定**的 Promise，「读还在飞」这件事才有可以插进去断言的缝。
   * 零延迟的应答下，切走再切回来时读早就回来了，这一格什么都证不了。
   */
  it("目录读还在飞时切走再切回来：不许发出第二条读 —— 两条链并存正是那条晚到失败的来源", async () => {
    const gates: Array<(r: { status: number; body: unknown }) => void> = [];
    const h = await openSettings((url) => {
      if (url.startsWith("/admin/api/models")) {
        return new Promise<{ status: number; body: unknown }>((resolve) => { gates.push(resolve); });
      }
      return { status: 200, body: {} };
    });
    // 前置条件：第一条读得真的还挂着，否则下面测的就不是「在飞」那条路。
    expect(modelCalls(h), "前置条件：第一条读没发出去").toBe(1);
    expect(codeText(h), "前置条件：读还挂着，代码块不该已经画出来了").toBe("");

    navOf(h, "overview").click();
    await settle(12);
    navOf(h, "settings").click();
    await settle(12);
    expect(modelCalls(h), "读还在飞就发出了第二条链").toBe(1);

    // 挂着的那条终于回来了：卡该画出来（早退不许把这条路一起堵死）。
    gates[0]!({ status: 200, body: catalogPayload() });
    await settle(20);
    expect(codeText(h)).toContain(PANEL_ORIGIN);
  });
});
