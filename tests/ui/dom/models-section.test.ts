import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stripCssComments } from "../../helpers/strip-comments.js";
import { visibleNonColorDecls } from "../../helpers/css-decls.js";
import { bootPanel, settle, type Harness } from "./harness.js";
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

/**
 * 某一行上的四个徽章。
 *
 * ⚠️ **`title` 必须一起收**（P3d Task 6 评审 Important 3，实测）：上一版只收
 * `textContent` / `data-available` / `data-protocol` ⇒ **删掉徽章上的 `title` 全绿**，
 * 而「可用 / 不可用」这件事**不只靠颜色**这条承诺全靠那句 tooltip 兑现，
 * `models.badge.yes` / `models.badge.no` 两个 key 的渲染当时零覆盖。
 * `tests/ui/dom/usage-section.test.ts` 早就断言了 title，这里是往回补一课。
 */
function badgesOf(row: FakeElement): Array<{
  label: string; available: string | null; protocol: string | null; title: string | null;
  classes: string[];
}> {
  const out: Array<{
    label: string; available: string | null; protocol: string | null; title: string | null;
    classes: string[];
  }> = [];
  for (const span of row.querySelectorAll(".badge")) {
    out.push({
      label: span.textContent,
      available: span.getAttribute("data-available"),
      protocol: span.getAttribute("data-protocol"),
      title: span.getAttribute("title"),
      // ⚠️ **class 一起收**（P3e Task 20）：`title` 是 hover-only，`data-available` 读不出来
      // ⇒ 两态徽章可见文字逐字相同时，class 是唯一还能挂非颜色线索的地方。
      classes: String(span.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).sort(),
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

/**
 * 一条**永不落地**的读的 resolver 表。`hungRead()` 每次重置它，
 * 用例自己决定哪一条什么时候落地、按什么顺序落地
 *（**顺序是那几格的全部内容**，见「晚到的失败不许盖掉新的成功」那一格里的告诫）。
 *
 * ⚠️ 替身带真实挂起点是刻意的（第 8 种假阳性：零延迟的替身让时序性质整个不可观测）。
 */
let hung: Array<(r: { status: number; body: unknown }) => void> = [];

/**
 * 启动板块，让 `/admin/api/models` 那条读**挂住不落地**，然后切走再切回来
 * ——切回来这一步是为了触发一次 `render()`，让「读不出来」那张卡（连同那颗
 * 「再读一次」）出现在屏幕上。
 */
async function hungRead(): Promise<Harness> {
  hung = [];
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "models" },
    respond: (url: string) => {
      if (!url.startsWith("/admin/api/models")) return { status: 200, body: {} };
      return new Promise<{ status: number; body: unknown }>((resolve) => { hung.push(resolve); });
    },
  });
  await settle(12);
  navTo(h, "overview");
  await settle(12);
  navTo(h, "models");
  await settle(12);
  return h;
}

/** 这一轮一共往 `/admin/api/models` 发了几条。 */
function modelCalls(h: Harness): number {
  return h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length;
}

/**
 * 一份**只有一个模型**的合成目录。用途只有一个：让「被抢占的那条晚到的成功」
 * 与真源那一份**内容不同** —— 两份都成功时，只有内容不同才分得开谁生效了
 *（第 1 种假阳性：夹具 A/B 同值时谁赢都通过）。
 */
const ONE_MODEL_CATALOG = {
  protocols: [{ id: "alpha", label: "Alpha Protocol" }],
  models: [{
    id: "probe-stale",
    modality: "chat",
    protocols: ["alpha"],
    endpoints: [{ method: "POST", path: "/probe/stale" }],
  }],
};

/** 点侧栏上那颗**真的**导航按钮（走整条 `showSection` 接线，不直接调板块方法）。 */
function navTo(h: Harness, name: string): void {
  for (const btn of h.dom.document.querySelectorAll(".nav-item")) {
    if (btn.getAttribute("data-section") === name) btn.click();
  }
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
    // ③ 必须有一条红色横幅说清是读取失败，**且它对读屏是一条状态播报**
    //    （评审 m2：`role="status"` 原来零覆盖 —— 删掉它对视觉用户没有任何变化，
    //    而读屏用户会完全收不到「读取失败」这条信号）。
    const banners = sec.querySelectorAll(".banner-danger");
    expect(banners.length, "读取失败却没有任何红色信号").toBe(1);
    expect(banners[0]!.getAttribute("role"), "红条没有 role=status，读屏用户收不到这条信号").toBe("status");
    // ④ **那一根 EM DASH**：它就是「我们不知道」这句话本身。
    const unknown = sec.querySelectorAll(".models-unknown");
    expect(unknown.length, "没有那一根表示「我们不知道」的破折号").toBe(1);
    expect(unknown[0]!.textContent).toBe(EM);
    // ④b **那根破折号上的 `title` 是它的全部解释**（评审 Important 3：删掉它全绿）。
    //     CSS 还给它配了 `cursor: help` ⇒ 没有 title 就是一个指向空处的 affordance。
    expect(
      unknown[0]!.getAttribute("title"),
      "破折号上没有解释它是「读不出来」而不是「一个模型都没有」的那句话",
    ).toBe("模型目录读不出来，所以这里是一根破折号——不是这个网关一个模型都没有。");
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
    // **状态不只靠颜色**：灰徽章那句 tooltip 必须把「不可用」写成字（评审 Important 3）。
    // 期望值手写整句，不是 `toContain("不可用")` —— 后者在「可用」那句里也是子串。
    expect(badges.map((b) => b.title)).toEqual([
      "OpenAI Chat Completions — 这个模型在这条协议上不可用",
      "Anthropic Messages — 这个模型在这条协议上不可用",
      "OpenAI Responses — 这个模型在这条协议上不可用",
      "Google Gemini generateContent — 这个模型在这条协议上不可用",
    ]);
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
    // 与上一格的 tooltip 成对：两句必须是**不同**的话，否则 `models.badge.yes` /
    // `models.badge.no` 写成同一句也没人红（第 1 种假阳性：夹具 A/B 同值）。
    expect(badgesOf(row!).map((b) => b.title)).toEqual([
      "OpenAI Chat Completions — 这个模型在这条协议上可用",
      "Anthropic Messages — 这个模型在这条协议上可用",
      "OpenAI Responses — 这个模型在这条协议上可用",
      "Google Gemini generateContent — 这个模型在这条协议上可用",
    ]);
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

    // ⚠️ **选中态也要画出来**（评审 m1：删掉两行 `classList.toggle("active", …)` 原来全绿）
    //    ——表筛过了，而没有任何东西保证用户看得出**当前停在哪一档**。
    //    期望值是**整排**档位的选中态，不是只看被点的那一颗：只看那一颗的话，
    //    「每一颗都 active」这种实现同样能通过（第 5 种假阳性）。
    expect(
      filterButtons(sec).map((b) => b.classList.contains("active")),
      "分段选择器上看不出当前停在哪一档",
    ).toEqual([false, false, true, false, false]);
  });

  /**
   * ── **P3d Task 6 评审 Important 2：`filterEmpty` 那一支原来零覆盖** ────────────
   *
   * 实测：把 `buildTable()` 里那个三元的两支都改成 `"models.empty"` ⇒ **全绿**，
   * 而 `grep -rn 'filterEmpty' tests/` 当时命中 **0**。
   *
   * ⚠️⚠️ **这一支今天用真源根本走不到**：`agnes-2.0-flash` 四条协议全占 ⇒ **每一条协议
   * 那一档**都恰好筛出 1 行，永远不为空（复评 F6：上一版写的是「每一档」，
   * 而按本板块自己的词汇「全部」也是一档、它筛出 4 行 —— 结论成立，措辞不成立）。
   * **所以这一支的可达性只能靠合成夹具证明**——
   * `bootPanel` 的 `respond` 收任意 body，这里喂一份「协议里有 delta、
   * 而没有任何模型占它」的合成目录。
   * ⚠️ **不许因为「今天走不到」就把那一支删掉、或者把话说软成一句通用文案**：
   * 那一支在代码里存在，而且**下一个只占部分协议的模型进来它当天就可达**。
   *
   * **变红条件**：`buildTable()` 里 `filter === "" ? "models.empty" : "models.filterEmpty"`
   * 的两支取同一个 key。
   */
  it("某条协议上一个模型都没有时说的是「这条协议上没有」，不是「这份目录里一个模型都没有」", async () => {
    // 合成目录：两条协议，而唯一那个模型只占其中一条。
    // **`delta` 这个 id 是编的**，不是真源里的协议——本板块不认识任何真实协议 id，
    // 它只渲染响应给了什么，所以编一个反而更能说明这一点。
    const synthetic = {
      protocols: [
        { id: "alpha", label: "Alpha Protocol" },
        { id: "delta", label: "Delta Protocol" },
      ],
      models: [{
        id: "probe-chat",
        modality: "chat",
        protocols: ["alpha"],
        endpoints: [{ method: "POST", path: "/probe/chat" }],
      }],
    };
    const h = await openModels(respondWithCatalog(200, synthetic));
    const sec = h.section("models");
    expect(dataRows(sec).length, "前置条件：默认档下那一行得在").toBe(1);

    filterButtons(sec).find((b) => b.getAttribute("data-protocol") === "delta")!.click();
    await settle();

    expect(dataRows(sec).length, "前置条件：这一档得真的筛成空的，否则这一支不可观测").toBe(0);
    expect(sec.textContent).toContain("这条协议上没有可用的模型");
    // ⚠️ **这一句才是这一格的全部理由**：两句话说的是两件事
    //（「这条协议上没有」vs「这份目录里一个模型都没有」），
    // 合成一句就是把一次筛选的结果说成了整个网关的状态。
    expect(sec.textContent, "把「这条协议上没有」说成了「这份目录里一个模型都没有」")
      .not.toContain("这份目录里一个模型都没有");
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
    // 选中态跟着回到「全部」那一档（同 m1：整排一起断言）。
    expect(
      filterButtons(sec).map((b) => b.classList.contains("active")),
      "点回「全部」之后分段选择器还停在上一档上",
    ).toEqual([true, false, false, false, false]);
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
    navTo(h, "overview");
    await settle(12);
    navTo(h, "models");
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
    navTo(h, "overview");
    await settle(12);
    navTo(h, "models");
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
   * ── **P3d Task 6 评审 Important 1：两条读并存，而晚到的失败会抹掉已经画好的表** ──
   *
   * `load()` 有**两个**入口：`onShow()`（`catalog === null` 时）与错误横幅上那颗
   * 「再读一次」。第一条读**还在飞着**的时候切走再切回来，`catalog` 仍然是 `null`
   * ⇒ 第二条链就发出去了。评审探针实测（修复前）：
   * `calls=2 rowsAfterSuccess=4 rowsAfterLateFailure=0`
   * ——**表已经正确画出 4 行，晚到的那条失败链走 catch 把它抹成了「读不出来」。**
   *
   * 治的是根因：**在飞时不许再发出第二条链**（`inFlight` 早退）。
   * **变红条件**：删掉 `load()` 开头那两行 `if (inFlight) return; inFlight = true;`。
   */
  it("在飞的读还没回来就切走再切回来：不许发出第二条读 —— 两条链并存正是那条晚到失败的来源", async () => {
    const pending: Array<(r: { status: number; body: unknown }) => void> = [];
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "models" },
      respond: (url: string) => {
        if (!url.startsWith("/admin/api/models")) return { status: 200, body: {} };
        // **替身带一个真实的挂起点**（第 8 种假阳性：零延迟的替身让时序性质
        // 整个不可观测）——这条读要一直飞着，直到用例自己把它放回来。
        return new Promise<{ status: number; body: unknown }>((resolve) => { pending.push(resolve); });
      },
    });
    await settle(12);
    expect(pending.length, "前置条件：第一条读得真的还在飞着").toBe(1);

    navTo(h, "overview");
    await settle(12);
    navTo(h, "models");
    await settle(12);

    expect(
      h.calls.filter((c) => c.url.startsWith("/admin/api/models")).length,
      "在飞时又发出了第二条读 —— 两条链并存",
    ).toBe(1);
  });

  /**
   * 上一格的**后果那一半**：把「晚到的失败」直接喂进去，已经画好的表必须原样留着。
   *
   * ⚠️ **这一格刻意不断言 `pending.length`**：它要在修复前后**两种实现下都跑得动**
   * ——修复前第二条链存在、它的失败会把表抹掉（红）；修复后第二条链根本不存在，
   * `pending.slice(1)` 是空的、表原样留着（绿）。
   *
   * ⚠️⚠️ **「回来晚了的那份不会是过期数据」这句只对成功响应成立**：`catch` 分支把
   * `catalog` 清成 `null`，那一步在原推理里整个缺失。这一格钉的就是它。
   */
  it("晚到的失败不许把已经画好的表抹掉 —— 表已经画好了，那次失败什么新东西都没说", async () => {
    const pending: Array<(r: { status: number; body: unknown }) => void> = [];
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "models" },
      respond: (url: string) => {
        if (!url.startsWith("/admin/api/models")) return { status: 200, body: {} };
        return new Promise<{ status: number; body: unknown }>((resolve) => { pending.push(resolve); });
      },
    });
    await settle(12);
    navTo(h, "overview");
    await settle(12);
    navTo(h, "models");
    await settle(12);

    // 先发的那一条**成功**回来：表画出来。
    pending[0]!({ status: 200, body: catalogPayload() });
    await settle(12);
    expect(dataRows(h.section("models")).length, "前置条件：成功的那一条得先把表画出来").toBe(4);

    // 再把所有**晚到的**那些喂成失败。修复后这里一条都没有。
    for (const resolve of pending.slice(1)) resolve({ status: 500, body: {} });
    await settle(12);

    expect(dataRows(h.section("models")).length, "晚到的失败把已经画好的表抹掉了").toBe(4);
    expect(
      h.section("models").querySelectorAll(".models-unknown").length,
      "晚到的失败把一张正确的表换成了「读不出来」",
    ).toBe(0);
  });

  /**
   * ── **P3d Task 6 定向复评 F1：一条永不落地的读，把板块变成一片空白** ─────────
   *
   * `admin-ui/js/api.js` 这条链**没有超时**（`raw()` 的 `signal` 只透传调用方给的），
   * 所以一条读可以永远飞着（连接卡死 / 黑洞代理 / 睡眠唤醒）。
   * 上一轮我加的 `if (inFlight) return;` 是**裸早退、不调 `render()`**
   * ⇒ 此后每一次 `onShow()` 都什么都不画。复评实测（e9f808a）：
   * `calls=1 rows=0 banner=0 retry=0 unknown=0`
   * ——**只剩标题和副标题的空板块：没有表、没有红条、没有「再读一次」、连那根破折号都没有**，
   * 而我在文件头承诺的恢复动作（「切走再切回来」）此时已经失效。
   *
   * **变红条件**：把 `load()` 里 `if (inFlight) { render(); return; }` 改回裸 `return`。
   */
  it("读挂住之后切回来不是一片空白 —— 至少要看得见「读不出来」和那颗「再读一次」", async () => {
    const h = await hungRead();
    const sec = h.section("models");
    // ① 「只许一条在飞」这条不变量**不许为了自救被放弃**。
    expect(modelCalls(h), "为了自救又把两条链放回来了").toBe(1);
    // ② 但必须有东西可看、有路可走 —— 否则用户对着一片空白，无从下手。
    expect(sec.querySelectorAll(".models-unknown").length, "挂住之后连那根破折号都没有").toBe(1);
    expect(sec.querySelectorAll(".models-retry").length, "挂住之后没有任何自救入口").toBe(1);
    expect(sec.querySelectorAll(".banner-danger").length, "挂住之后没有任何信号").toBe(1);
  });

  /**
   * ── **F1 的另一半：那颗「再读一次」必须真的能抢占一条挂住的读** ───────────────
   *
   * 裁定：**显式的用户动作有权抢占**（`inFlight` 时 abort 掉旧的再发）。
   * 这样「只许一条在飞」与「挂死可自救」两条都保住。
   *
   * ⚠️⚠️ **abort 那一半在测试里天然不可观测，如实写明**（复评提醒）：
   * 全仓只有 `admin-ui/js/api.js` 一处把 `signal` 交给 `fetch`，
   * 而 `tests/ui/dom/harness.ts` 的 `fetch` 替身与 `tests/helpers/fake-dom.ts` **零处**看 `signal`
   * ⇒ 被 abort 的那条链在测试里**照样会落地**。
   * **所以这一格钉的不是 `abort()`，是「被抢占的那条链的结果不许生效」那个世代号。**
   * 真实浏览器里 abort 会让它以 `AbortError` 拒绝，世代号同样把它挡在外面——
   * 两种环境走的是同一条判据，只是触发路径不同。
   *
   * **变红条件**：把 `retry` 的 `load(true)` 改回 `load()`（抢不动，按了没反应）；
   * 或者删掉 `load()` 里两处 `if (mine !== seq) return;`（被抢占的那条会生效）。
   */
  it("读挂住时点「再读一次」：旧的那条被抢占，它晚到的失败不许盖掉新的成功", async () => {
    const h = await hungRead();
    const sec = h.section("models");
    expect(sec.querySelectorAll(".models-retry").length, "前置条件：得先有那颗按钮可按").toBe(1);

    sec.querySelectorAll(".models-retry")[0]!.click();
    await settle(12);
    expect(modelCalls(h), "「再读一次」抢不动那条挂住的读 —— 按了没有任何事发生").toBe(2);

    // 新发的那一条**先**成功回来：表画出来。
    hung[1]!({ status: 200, body: catalogPayload() });
    await settle(12);
    expect(dataRows(sec).length, "前置条件：新发的那一条得先把表画出来").toBe(4);

    // ⚠️⚠️ **被抢占的那条要在这之后才落地 —— 顺序就是这一格的全部内容。**
    //    上一版把它放在前面 resolve，于是新那条的成功紧随其后把一切覆盖掉
    //    ⇒ 删掉 catch 里的世代号守卫**照样全绿**（第 5 种假阳性：
    //    覆盖的状态让被测的选择不可观测），而用例名里写着「晚到」。
    //    **名字说「晚到」，body 就必须真的让它晚到。**
    hung[0]!({ status: 500, body: {} });
    await settle(12);

    expect(dataRows(sec).length, "被抢占的那条晚到的失败把表抹掉了 —— catch 里的世代号没挡住它").toBe(4);
    expect(sec.querySelectorAll(".models-unknown").length, "表被换成了「读不出来」").toBe(0);
  });

  /**
   * 同一条判据的**成功那一侧**：被抢占的那条**晚到的成功**同样不许生效。
   * 少了这一格，`try` 里那句 `if (mine !== seq) return;` 零覆盖（实测：删掉它全绿）。
   *
   * **变红条件**：删掉 `load()` 的 `try` 里那句 `if (mine !== seq) return;`。
   */
  it("被抢占的那条晚到的**成功**同样不许生效 —— 否则面板会退回一份更旧的目录", async () => {
    const h = await hungRead();
    const sec = h.section("models");
    sec.querySelectorAll(".models-retry")[0]!.click();
    await settle(12);

    // 新发的那条交出**真源**那一份（四个模型）。
    hung[1]!({ status: 200, body: catalogPayload() });
    await settle(12);
    expect(dataRows(sec).length, "前置条件：新发的那一条得先把表画出来").toBe(4);

    // 被抢占的那条晚到，**而且它交出的是一份内容不同的目录**（只有一个模型）。
    // 两份都「成功」⇒ 只有世代号分得开它们（夹具 A/B 必须不同值，第 1 种假阳性）。
    hung[0]!({ status: 200, body: ONE_MODEL_CATALOG });
    await settle(12);

    expect(
      dataRows(sec).map((tr) => tr.getAttribute("data-model")),
      "被抢占的那条晚到的成功生效了 —— 面板退回了一份更旧的目录",
    ).toEqual(["agnes-2.0-flash", "agnes-image-2.1-flash", "agnes-image-2.0-flash", "agnes-video-v2.0"]);
  });

  /**
   * 被抢占的那条落地时**不许替还在飞的那条把在飞标记清掉**。
   * 清掉之后，下一次隐式的 `onShow()` 会发出**第三条**链——
   * 「只许一条在飞」那条不变量从抢占这条路上漏掉。
   *
   * **变红条件**：把 `finally` 里的 `if (mine === seq) { … }` 改成无条件执行。
   */
  it("被抢占的那条落地不会替还在飞的那条清掉在飞标记 —— 否则下一次切回来会发出第三条链", async () => {
    const h = await hungRead();
    const sec = h.section("models");
    sec.querySelectorAll(".models-retry")[0]!.click();
    await settle(12);
    expect(modelCalls(h), "前置条件：抢占那一下得真的发出去了").toBe(2);

    // 被抢占的那条先落地（新发的那条**仍然挂着**）。
    hung[0]!({ status: 500, body: {} });
    await settle(12);

    // 此刻仍有一条在飞 ⇒ 隐式入口不许再发。
    navTo(h, "overview");
    await settle(12);
    navTo(h, "models");
    await settle(12);
    expect(modelCalls(h), "在飞标记被那条被抢占的链清掉了 —— 又多发了一条").toBe(2);
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

/**
 * ── WCAG 1.4.1：状态不许只由颜色表达（P3e Task 20）──────────────────────────────
 *
 * 协议矩阵里可用 / 不可用两个徽章的**可见文字逐字相同**（都是协议专名），
 * 原来的差别只有三样：颜色、hover 才出得来的 `title`、读不出来的 `data-available`。
 * 真浏览器实测（触屏模拟 `(hover: none)` + `(pointer: coarse)`，长按 1.2s）：
 * `::before` / `::after` 皆无、`text-decoration` 两边都是 none、`font-weight` 两边都是 400，
 * 长按之后 DOM 无任何变化、也没有任何 `[role="tooltip"]` 节点
 * ⇒ **触屏用户拿得到的只有颜色**。
 *
 * ⚠️ **解法必须走 class + CSS，`textContent` 一个字不许动**：上面那张手写的
 * `badges.map(b => b.label)` 期望表钉着徽章上写的是协议专名，动文案会当场打红它
 * ——而那也该打红，徽章上写状态名是另一回事。
 */
describe("徽章的状态不只靠颜色", () => {
  it("同一张表里，不可用那一档的徽章带一个可用那一档没有的类", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    const off = badgesOf(dataRows(sec).find((tr) => tr.getAttribute("data-model") === "agnes-image-2.1-flash")!);
    const on = badgesOf(dataRows(sec).find((tr) => tr.getAttribute("data-model") === "agnes-2.0-flash")!);
    expect(off.length, "前置条件：不可用那一行得有徽章").toBe(4);
    expect(on.length, "前置条件：可用那一行得有徽章").toBe(4);
    // 期望值手写字面量（不是从被测对象读出来再回填）。
    for (const b of off) expect(b.classes, "不可用的徽章没带 .badge-off").toEqual(["badge", "badge-off"]);
    for (const b of on) expect(b.classes, ".badge-off 跑到可用那一侧去了").toEqual(["badge", "badge-ok"]);
    // 两侧的类集合必须真的不同 —— 相同的话上面两条会一起变成同一句话。
    expect(off[0]!.classes, "两态徽章的类集合一模一样 —— 状态又只剩颜色了").not.toEqual(on[0]!.classes);
  });

  /**
   * **CSS 源码断言：`.badge-off` 必须声明一条非颜色属性。**
   * 上面那格只管"两侧的类不一样"，一个**取值与 `.badge` 逐字相同的同义类**照样能让它绿
   * ——而 `sections.css` 里 `.badge-danger` 下面那段注释正为此裁过 `.badge-muted` 一次。
   *
   * **它接不住什么，明写**：纯文本扫描，不渲染。`text-decoration: none` 它照样绿。
   * 那一族只能靠真机截图，而截图不是会自己红的守卫。
   *
   * ⚠️⚠️ **判据是逐条声明的属性名，不是 `toContain("text-decoration")`**
   *（P3e Task 20 复评实测打穿过：`text-decoration-color: red` 逐字包含那个串，
   * 却**本身就是颜色属性** ⇒ 这一格照样绿，而真机 computed 退回 `text-decoration-line: none`）。
   * 判据住在 `tests/helpers/css-decls.ts` 的 `visibleNonColorDecls()`，与
   * `tests/unit/source-guards.test.ts「.btn-toggle.active 至少有一条非颜色声明 —— 只改颜色的话触屏与色觉障碍用户拿不到选中态」`
   * **共用同一份**——别在这里再手写一份。
   */
  it(".badge-off 在 CSS 里声明了一条看得见的 text-decoration —— 删掉或换成 -color 就红", () => {
    // 抠 CSS 一律走**只认块注释**的那一档：CSS 没有 `//` 行注释，拿 JS 语义去抠
    // 会把 `background: url(//cdn…)` 之后的样式整段吃掉。
    const css = stripCssComments(readFileSync("admin-ui/css/sections.css", "utf8"));
    const block = /\.badge-off\s*\{([^}]*)\}/.exec(css);
    expect(block, "sections.css 里找不到 .badge-off 这条规则").not.toBeNull();
    expect(block![1]!, "抠出来的是空块 —— 抠错了").not.toBe("");
    expect(
      visibleNonColorDecls(block![1]!, ["text-decoration"]).map((d) => d.prop),
      ".badge-off 只剩颜色声明了 —— 它存在的全部理由就是那条非颜色线索。"
      + "⚠️ `text-decoration-color` 不算数，它本身就是颜色属性",
    ).not.toEqual([]);
  });

  /**
   * **反向控制：同一个量具对着仓里真实存在的另一条规则不许乱报有。**
   * `.badge-ok` 今天只有颜色三件套（`color` / `background` / `border-color`），
   * 一条 `text-decoration` 都没有。量具若退化成"在整份 CSS 里找子串"，这一格会红。
   */
  it("反向控制：同一个量具在 .badge-ok 上报「没有 text-decoration」", () => {
    const css = stripCssComments(readFileSync("admin-ui/css/sections.css", "utf8"));
    const block = /\.badge-ok\s*\{([^}]*)\}/.exec(css);
    expect(block, "sections.css 里找不到 .badge-ok 这条规则").not.toBeNull();
    expect(block![1]!, "抠到的不是 .badge-ok（它该有 background）").toContain("background");
    expect(
      visibleNonColorDecls(block![1]!, ["text-decoration"]).map((d) => d.prop),
      "量具在 .badge-ok 上报出了 text-decoration —— 它多半在整份 CSS 里瞎找，上面那格的绿不算数",
    ).toEqual([]);
  });
});

/**
 * ── `aria-pressed`：分段选择器的选中态得读得出来（P3e Task 20）──────────────────
 *
 * `.active` 只改颜色（外加一条加粗），读屏用户拿不到。
 * **"每个创建点都带 `aria-pressed`"由
 * `tests/unit/source-guards.test.ts「sec-*.js 里每一个 btn-toggle 创建点都带 aria-pressed」`
 * 守着；这一格守的是另一半：值真的跟着点击走。** 两格分工不同：那一格拦"漏写"，
 * 这一格拦"写死成 false"。
 */
describe("协议筛选的 aria-pressed 跟着点击走", () => {
  it("点第二颗：第一颗转 false、第二颗转 true", async () => {
    const h = await openModels(respondWithCatalog());
    const sec = h.section("models");
    const btns = filterButtons(sec);
    expect(btns.length, "前置条件：分段按钮得真的画出来了").toBe(5);
    // 首帧：默认停在「全部」（`data-protocol` 是空串那一颗）。
    expect(btns.map((b) => b.getAttribute("aria-pressed")))
      .toEqual(["true", "false", "false", "false", "false"]);

    btns.find((b) => b.getAttribute("data-protocol") === "anthropic")!.click();
    await settle(12);
    // ⚠️ **重新取一次节点**：这一组每次 `render()` 都重建按钮，握着旧引用会读到已被
    //    丢弃的那一批（屏幕上换了、断言读的是上一帧）。
    expect(filterButtons(h.section("models")).map((b) => b.getAttribute("aria-pressed")))
      .toEqual(["false", "false", "true", "false", "false"]);
  });
});
