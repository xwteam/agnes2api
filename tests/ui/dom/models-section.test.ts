import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { catalogPayload } from "../../../src/core/admin/protocol-catalog.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **模型板块的渲染行为（P3d Task 6 Step 2 的 DOM 那一半，评审 I22 ①）。**
 *
 * `tests/ui/models.test.ts` 把取值判定测得很细，**但没有任何东西验证板块文件真的
 * 把那些判定画了出来**。把错误分支改成「渲染一张空表」，纯函数用例一条都不红，
 * 而面板会把「模型目录读不出来」说成「这个网关一个模型都没有」——两件完全不同的事。
 * 这一组补的就是那一半。
 *
 * ── **替身能力核对（第 9 种假阳性，Step 4 检查单要求逐条写出来）** ─────────────
 * `tests/ui/dom/fake-dom-parity.test.ts` 是权威表：`FAKE_ONLY_MEMBERS` **8 条**
 *（`.walk()` / `.parent` / `.input()` / `.attrs` / `.listeners` / `classList.reset()` /
 * `querySelectorAll()` 后紧跟数组方法 / `.children` 后紧跟数组方法），
 * `KNOWN_BLIND_SPOTS` **3 条**（返回值先存进变量再调数组方法 / `submit()` 语义相反 /
 * `.disabled` 挂错宿主）。
 * `admin-ui/js/sec-models.js` 用到的 DOM 成员逐个对过：
 * `createElement` / `setAttribute` / `textContent` / `appendChild` /
 * `addEventListener` / `classList.toggle(name, force)`
 * ——**8 条一条都没用到，3 条盲点也一条都没踩**（本板块不遍历子树、没有表单、
 * 没有禁用态，也一次都不调 `querySelectorAll`）。
 *
 * ⚠️ 本文件的**测试代码**里用 `for…of` 遍历 `querySelectorAll` 的结果、不调 `.map`
 * ——真实 DOM 上它回的是 `NodeList`，没有数组方法。测试不在那道扫描范围内，
 * 但照真实语义写才不会把一个错的写法教给下一个人。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;
/** EM DASH（U+2014）：`fmtDash(null)` 交出来的那一根，意思是「我们不知道」。 */
const EM = "—";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 打开模型板块（登录态 + 上次停在 models）。 */
async function openModels(
  respond: (url: string, method: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "models" },
    respond,
  });
  await settle(12);
  return h;
}

/**
 * 缺省应答：`/admin/api/models` 交出**真源那一份**（`catalogPayload()`），
 * **不手抄一份**（第 7 种假阳性：测的是抄件不是原件）。
 */
function respondWithCatalog(status = 200, body: unknown = catalogPayload()) {
  return (url: string) => {
    if (url.startsWith("/admin/api/models")) return { status, body };
    return { status: 200, body: {} };
  };
}

/** 表里的数据行（`<tr data-model="…">`），按 DOM 顺序。 */
function dataRows(section: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const tr of section.querySelectorAll("[data-model]")) out.push(tr);
  return out;
}

/** 某一行上的四个徽章：`「展示名 → 可用与否」`。 */
function badgesOf(row: FakeElement): Array<{ label: string; available: string | null; protocol: string | null }> {
  const out: Array<{ label: string; available: string | null; protocol: string | null }> = [];
  for (const span of row.querySelectorAll(".badge")) {
    out.push({
      label: span.textContent,
      available: span.getAttribute("data-available"),
      protocol: span.getAttribute("data-protocol"),
    });
  }
  return out;
}

/**
 * 某一行的**类型格**（第二个 `<td>`，字段名 `modality`、列的显示名叫「类型」）。
 *
 * ⚠️ **观测点必须落在这一格上，不能落在整个板块的 `textContent` 上**：
 * 这一格第一版写的是 `expect(sec.textContent).not.toContain("chat")`，
 * 而端点那一列里就有一条对话协议的路径、它自己带着小写 `chat` ⇒ 当场红。
 * ⭐ 记一条形状：**一句只对某一列成立的话，被写成了对整块成立。**
 */
function modalityOf(row: FakeElement): string {
  const cells: FakeElement[] = [];
  for (const td of row.querySelectorAll("td")) cells.push(td);
  return cells[1]!.textContent;
}

/** 某一行上的端点，按 DOM 顺序。 */
function endpointsOf(row: FakeElement): string[] {
  const out: string[] = [];
  for (const div of row.querySelectorAll(".models-endpoint")) out.push(div.textContent);
  return out;
}

/** 工具栏上那一排分段按钮的 `data-protocol`（空串 = 「全部」那一档）。 */
function filterButtons(section: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const btn of section.querySelectorAll(".btn-toggle")) out.push(btn);
  return out;
}

describe("读不出来 ≠ 一个模型都没有", () => {
  /**
   * **变红条件（M3，本任务新建的这一格）**：把 `load()` 的 `catch` 分支从
   * `catalog = null;` 改成 `catalog = { protocols: [], models: [] };`
   * ——也就是「错误分支改成空清单之后照常渲染」。
   *
   * 一张空表会被读成「这个网关一个模型都没有」，而事实是我们**不知道**它认得
   * 哪些模型。全局约束 9 禁的伪造不只是伪造 `0`：把「不知道」画成「空」是同一件事。
   */
  it("GET /admin/api/models 返回 404 时不渲染空表，而是错误提示加一根 EM DASH", async () => {
    const h = await openModels(respondWithCatalog(404, { error: { message: "not found" } }));
    const sec = h.section("models");

    // ① 一行数据都不许有 —— 空表就是那句假话本身。
    expect(dataRows(sec).length, "读不出来却渲染了一张（空）表").toBe(0);
    // ② 工具栏也不许出现：一份读不出来的目录没有什么可筛的，
    //    而一排能点的按钮会让人以为「筛完就没了」。
    expect(filterButtons(sec).length, "读不出来却画了一排筛选按钮").toBe(0);
    // ③ 必须有一条红色横幅说清是读取失败。
    expect(sec.querySelectorAll(".banner-danger").length, "读取失败却没有任何红色信号").toBe(1);
    // ④ **那一根 EM DASH**：它就是「我们不知道」这句话本身。
    const unknown = sec.querySelectorAll(".models-unknown");
    expect(unknown.length, "没有那一根表示「我们不知道」的破折号").toBe(1);
    expect(unknown[0]!.textContent).toBe(EM);
    // ⑤ 横幅里那颗按钮是「再读一次」——少了它，一次网络抖动会把这个板块
    //    在本次会话里钉死在错误页上（用户得先猜到「切走再切回来」这个动作）。
    expect(sec.querySelectorAll(".models-retry").length, "错误横幅上没有再读一次的入口").toBe(1);
    // ⑥ 反向对照：那句「这份目录里一个模型都没有」**绝不许**出现在这一档下。
    expect(sec.textContent, "把「读不出来」说成了「一个模型都没有」")
      .not.toContain("这份目录里一个模型都没有");
  });

  /**
   * **响应回得来、但形状不对**，与 HTTP 失败落在同一档。
   * **变红条件**：把 `load()` 里那一行三元
   * `protocols === null || models === null ? null : { protocols, models }`
   * 改成 `{ protocols: protocols ?? [], models: models ?? [] }`
   * ⇒ 一份被中间件改过形状的响应会画出一张**结构自洽而内容缺斤少两**的表。
   */
  it("响应读得回来但形状不对时同样是「读不出来」 —— 不是画一张结构自洽的空表", async () => {
    const h = await openModels(respondWithCatalog(200, { protocols: "not an array", models: [] }));
    const sec = h.section("models");
    expect(sec.querySelectorAll(".models-unknown").length, "形状不对却没有走「读不出来」那一档").toBe(1);
    expect(dataRows(sec).length).toBe(0);
  });

  /**
   * **读成功了、真的是空的** —— 与上面两格必须长得**不一样**。
   * 少了这一格的话，把「读不出来」那一档的渲染直接搬来当空态也不会有人红。
   */
  it("目录真的是空的时候说的是「一个模型都没有」，且没有红色横幅 —— 空与读不出来必须分得开", async () => {
    const h = await openModels(respondWithCatalog(200, { protocols: [], models: [] }));
    const sec = h.section("models");
    expect(sec.textContent).toContain("这份目录里一个模型都没有");
    expect(sec.querySelectorAll(".banner-danger").length, "读成功了却报了错").toBe(0);
    expect(sec.querySelectorAll(".models-unknown").length, "读成功了却画了「我们不知道」").toBe(0);
  });
});

describe("四模型 × 四协议矩阵", () => {
  /**
   * **变红条件（M1 在 DOM 这一侧的落点）**：把 `protocolBadges` 改成
   * `protocols.filter(...).map(...)` ⇒ 图片模型那一行的徽章数从 4 掉到 0。
   *
   * 灰徽章不许被过滤掉：过滤之后那一格是空白，**与「读不出来」长得一模一样**。
   */
  it("图片模型那一行上四个协议徽章一个都不少，且全部标着不可用 —— 空白的一格与「读不出来」长得一样", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    // 模型 id 手写字面量（真源改了名这一格该红：面板承诺的就是那个 id）。
    const row = dataRows(sec).find((tr) => tr.getAttribute("data-model") === "agnes-image-2.1-flash");
    expect(row, "前置条件：表里得有那个图片模型").not.toBe(undefined);
    const badges = badgesOf(row!);
    expect(badges.length, "不可用的徽章被过滤掉了").toBe(4);
    expect(badges.map((b) => b.available)).toEqual(["no", "no", "no", "no"]);
    // 展示名走响应里的 `label`，**不是裸 id**：面板上写 id 等于让运维自己去猜。
    expect(badges.map((b) => b.label)).toEqual([
      "OpenAI Chat Completions", "Anthropic Messages", "OpenAI Responses", "Google Gemini generateContent",
    ]);
    expect(badges.map((b) => b.protocol)).toEqual(["openai", "anthropic", "responses", "gemini"]);
  });

  /**
   * 与上一格**合起来**才说明徽章真的在看模型：单看上一格的话，
   * 一个恒画四个灰徽章的实现同样能通过它。
   */
  it("对话模型那一行四个徽章全部标着可用 —— 与上一格合起来才说明徽章真的在看模型", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    const row = dataRows(sec).find((tr) => tr.getAttribute("data-model") === "agnes-2.0-flash");
    expect(badgesOf(row!).map((b) => b.available)).toEqual(["yes", "yes", "yes", "yes"]);
  });

  it("四个模型各一行，类型那一列画的是译名不是裸英文词", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    const rows = dataRows(sec);
    // 期望值手写字面量：真源今天就是这四个 id，多一个少一个都该在这里被看见。
    expect(rows.map((tr) => tr.getAttribute("data-model"))).toEqual([
      "agnes-2.0-flash", "agnes-image-2.1-flash", "agnes-image-2.0-flash", "agnes-video-v2.0",
    ]);
    // 期望值手写字面量：四行的类型格逐个列全，**不是只挑一个来看**。
    // 裸英文形态名（`chat` / `image` / `video`）一个都不许出现在这一列上
    // ——`modalityLabelKey()` 返回 `null` 时才照实显示原值，而这四个它都认识。
    expect(rows.map((tr) => modalityOf(tr)), "类型那一列画出了裸的英文形态名")
      .toEqual(["对话", "图片", "图片", "视频"]);
  });
});

describe("端点那一列", () => {
  /**
   * **变红条件（M4）**：把 `endpointCell` 的 `for (const e of model.endpoints)`
   * 改成 `for (const e of model.endpoints.slice(0, 1))`。
   *
   * 视频是**两段式**（一次创建 + 一次查询）。只显示一条就是把两段式教成一段式，
   * 而运维照着面板写出来的客户端会永远拿不到结果。
   */
  it("视频模型那一行同时列出两条端点 —— 只显示一条就是把两段式教成一段式", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    const row = dataRows(sec).find((tr) => tr.getAttribute("data-model") === "agnes-video-v2.0");
    expect(row, "前置条件：表里得有那个视频模型").not.toBe(undefined);
    // **期望值手写字面量，不从 `catalogPayload()` 推导**：从夹具推导出来的期望值
    // 与被渲染的东西同源，那是同义反复（第 6 种假阳性）。
    expect(endpointsOf(row!), "两段式被画成了一段式").toEqual([
      "POST /v1/videos",
      "GET /v1/videos/:id",
    ]);
  });

  it("对话模型那一行四条协议的端点各一条，一条都不许少", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    const row = dataRows(sec).find((tr) => tr.getAttribute("data-model") === "agnes-2.0-flash");
    expect(endpointsOf(row!)).toEqual([
      "POST /v1/chat/completions",
      "POST /v1/messages",
      "POST /v1/responses",
      "POST /v1beta/models/agnes-2.0-flash:generateContent",
    ]);
  });
});

describe("按协议筛选（工具栏）", () => {
  /**
   * **变红条件**：把 `filterByProtocol` 里 `m.protocols.includes(protocolId)`
   * 改成 `true` ⇒ 媒体模型也会留在筛选结果里。
   */
  it("点某一条协议之后只剩对话模型 —— 图片与视频模型一行都不出现", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    expect(dataRows(sec).length, "前置条件：默认档下四行都在").toBe(4);

    const btn = filterButtons(sec).find((b) => b.getAttribute("data-protocol") === "anthropic");
    expect(btn, "前置条件：工具栏上得有那条协议的分段按钮").not.toBe(undefined);
    btn!.click();
    await settle();

    expect(dataRows(sec).map((tr) => tr.getAttribute("data-model")), "媒体模型混进了对话协议的筛选结果")
      .toEqual(["agnes-2.0-flash"]);
  });

  /**
   * ⚠️ **工具栏上没有刷新按钮**（设计 §10.7：agnes 的模型是硬编码的，
   * 没有「跨账号刷新」这个动作）。**变红条件**：往 `init()` 里加一颗刷新按钮。
   * 那颗按钮会承诺一个不存在的语义——点它什么都不会变，而运维会以为自己拿到了新数据。
   */
  it("工具栏上只有筛选档位，没有刷新按钮 —— 那颗按钮会承诺一个不存在的语义", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    // 「全部」+ 四条协议 = 五个档位，**手写**。
    expect(filterButtons(sec).length).toBe(5);
    expect(filterButtons(sec).map((b) => b.getAttribute("data-protocol")))
      .toEqual(["", "openai", "anthropic", "responses", "gemini"]);
    // 板块里全部按钮 = 五个档位，一个不多（错误横幅那颗只在读不出来时出现）。
    let buttons = 0;
    for (const b of sec.querySelectorAll("button")) buttons++;
    expect(buttons, "板块里多了一颗按钮 —— 是不是加了刷新？").toBe(5);
  });

  /**
   * 「全部」那一档**原样返回**，不是「用一个恒真的判据筛一遍」。
   * **变红条件**：把 `filterByProtocol` 的 `if (!protocolId) return models;` 删掉
   * ⇒ 空串走进 `includes("")` ⇒ 切回「全部」之后一行都不剩。
   */
  it("筛完再点回「全部」，四行都回来 —— 空串不是一个协议 id", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    filterButtons(sec).find((b) => b.getAttribute("data-protocol") === "gemini")!.click();
    await settle();
    expect(dataRows(sec).length, "前置条件：筛过一次之后行数得真的变了").toBe(1);

    filterButtons(sec).find((b) => b.getAttribute("data-protocol") === "")!.click();
    await settle();
    expect(dataRows(sec).length).toBe(4);
  });
});

describe("网络行为", () => {
  /**
   * **目录是静态的，成功读过一次就不再读**（`src/http/admin/handlers/models.ts`
   * 是零存储读，但它仍然是一次网络往返）。
   * **变红条件**：把 `onShow()` 里 `if (catalog !== null) { render(); return; }` 删掉
   * ⇒ 每切回来一次就多发一次请求。
   */
  it("切走再切回来不会重发请求 —— 目录是静态的，重读一遍只换来一次「这次可能失败」的机会", async () => {
    const h = await openModels(respondWithCatalog());
    const before = h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length;
    expect(before, "前置条件：第一次显示时得真的发过一次").toBe(1);

    // 切到概览再切回来（走的是真 `.nav-item` 按钮，不是直接调板块方法）。
    for (const btn of h.dom.document.querySelectorAll(".nav-item")) {
      if (btn.getAttribute("data-section") === "overview") btn.click();
    }
    await settle(12);
    for (const btn of h.dom.document.querySelectorAll(".nav-item")) {
      if (btn.getAttribute("data-section") === "models") btn.click();
    }
    await settle(12);

    expect(h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length, "重复读了一份静态目录")
      .toBe(before);
    expect(dataRows(h.section("models")).length, "切回来之后表没了").toBe(4);
  });

  /**
   * 读失败之后**下一次显示要重试** —— 与上一格是同一条判据的两面
   *（`catalog` 停在 `null` 上，所以 `onShow()` 会再发一次）。
   * 少了这一格的话，把上一格那条早退改成「读过一次就永不再读」也不会有人红，
   * 而那意味着一次网络抖动把这个板块钉死在错误页上直到刷新整页。
   */
  it("读失败之后切回来会重试，且这一次成功就画出表 —— 一次网络抖动不该钉死整个板块", async () => {
    const h = await openModels(respondWithCatalog(500, {}));
    expect(h.section("models").querySelectorAll(".models-unknown").length, "前置条件：先得真的失败一次").toBe(1);

    h.respond(respondWithCatalog());
    for (const btn of h.dom.document.querySelectorAll(".nav-item")) {
      if (btn.getAttribute("data-section") === "overview") btn.click();
    }
    await settle(12);
    for (const btn of h.dom.document.querySelectorAll(".nav-item")) {
      if (btn.getAttribute("data-section") === "models") btn.click();
    }
    await settle(12);

    expect(dataRows(h.section("models")).length, "失败之后再也没有重试过").toBe(4);
  });

  /**
   * 错误横幅上那颗「再读一次」真的重发请求。
   * **变红条件**：把 `retry.addEventListener("click", …)` 那一行删掉
   * ⇒ 一颗按了不解决问题的按钮（P3d Task 5 评审 M1 记过同一个形态）。
   */
  it("错误横幅上那颗「再读一次」真的重发请求，成功之后表就出来了", async () => {
    const h = await openModels(respondWithCatalog(500, {}));
    const sec = h.section("models");
    const before = h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length;

    h.respond(respondWithCatalog());
    sec.querySelectorAll(".models-retry")[0]!.click();
    await settle(12);

    expect(h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length, "按了却没有再读一次")
      .toBe(before + 1);
    expect(dataRows(sec).length).toBe(4);
  });

  /**
   * **这个板块只打 `/admin/api/models` 一条端点。**
   * 少了这一格的话，哪天有人顺手在这里加一条「顺便拉一下 capabilities」，
   * 一个「零存储读」的板块就悄悄变成了两次网络往返。
   */
  it("整个板块只打一条端点 —— 别在这里顺手多拉一份别的", async () => {
    const h = await openModels(respondWithCatalog());
    const urls = new Set<string>();
    for (const c of h.calls) urls.add(c.url);
    urls.delete("/admin/api/session");
    expect([...urls]).toEqual(["/admin/api/models"]);
  });
});
