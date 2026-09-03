import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import type { FakeElement } from "../../helpers/fake-dom.js";
import { EDITABLE_FIELDS, SECRET_FIELDS } from "../../../src/core/admin/config-validate.js";
// 复评回填：危险区那两颗按钮的 id 序列**从真源现算**，不再手抄字面量
//（手抄的那一份红起来会说「按钮与 DANGER_ACTIONS 对不上」，而真正对不上的是它自己）。
import { DANGER_ACTIONS } from "../../../admin-ui/js/pure/settings.mjs";
// 危险区那几句回执与警告要逐字核对，文案取字典真源，不在用例里抄中文。
import { I18N } from "../../../admin-ui/js/i18n-dict.js";

/**
 * 设置页的**行为**覆盖。纯函数那一半在 `tests/ui/settings.test.ts` 的
 * 「后端 EDITABLE_FIELDS 的每条路径都在面板的某张卡里」那一族；
 * 这里验的是「板块文件真的把那些判据接上了 DOM」。
 *
 * ⚠️⚠️ **本文件的第一格是设计 §5.3 那条「唯一不可妥协的产品原则」：
 * 写操作的成功提示不得早于回读。**
 *
 * 它**必须用带延迟的替身**：零延迟下请求与响应落在同一条微任务链里，
 * 「早于」这件事整个不可观测（第 8 种候选假阳性，本仓在 storage 轴上栽过一次）。
 * 这里用的是**手动闸**（一个由用例自己 resolve 的 Promise）——它是 `delayMs` 的
 * 上界形态：延迟无穷大，于是「回读之前」这个窗口在断言的那一刻真的成立。
 */

const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Resp = { status: number; body: unknown };

function configBody(over: Record<string, unknown> = {}) {
  return {
    fields: {
      agnesBaseUrl: { stored: "https://a.example.com/v1", env: null, effective: "https://a.example.com/v1", lockedBy: null },
      upstreamTimeoutMs: { stored: 8000, env: null, effective: 8000, lockedBy: null },
      upstreamSyncTimeoutMs: { stored: 120000, env: null, effective: 120000, lockedBy: null },
      maxStrikes: { stored: 3, env: null, effective: 3, lockedBy: null },
      cooldownRateLimitMs: { stored: 60000, env: null, effective: 60000, lockedBy: null },
      cooldownPaymentMs: { stored: 3600000, env: null, effective: 3600000, lockedBy: null },
      cooldownStrikeMs: { stored: 1800000, env: null, effective: 1800000, lockedBy: null },
      poolCacheTtlMs: { stored: 0, env: null, effective: 0, lockedBy: null },
      poolTouchIntervalMs: { stored: 0, env: null, effective: 0, lockedBy: null },
      "registrar.enabled": { stored: false, env: null, effective: false, lockedBy: null },
      "registrar.primary": { stored: null, env: null, effective: null, lockedBy: null },
      "registrar.fallback": { stored: null, env: null, effective: null, lockedBy: null },
      "registrar.targetKeys": { stored: 20, env: null, effective: 20, lockedBy: null },
      "registrar.mintBatch": { stored: 5, env: null, effective: 5, lockedBy: null },
      "registrar.tendIntervalMs": { stored: 1800000, env: null, effective: 1800000, lockedBy: null },
      "registrar.codeTimeoutMs": { stored: 120000, env: null, effective: 120000, lockedBy: null },
      "registrar.mintDelayMinMs": { stored: 2000, env: null, effective: 2000, lockedBy: null },
      "registrar.mintDelayMaxMs": { stored: 5000, env: null, effective: 5000, lockedBy: null },
      "registrar.maxDomainAttempts": { stored: 8, env: null, effective: 8, lockedBy: null },
      "registrar.tokenName": { stored: "auto", env: null, effective: "auto", lockedBy: null },
      "registrar.agnesPlatformUrl": { stored: "https://p.example.com", env: null, effective: "https://p.example.com", lockedBy: null },
      "registrar.yyds.baseUrl": { stored: null, env: null, effective: null, lockedBy: null },
      "registrar.moemail.baseUrl": { stored: null, env: null, effective: null, lockedBy: null },
      degraded: { stored: null, env: null, effective: false, lockedBy: null },
    },
    credentials: {
      gatewayToken: { configured: true, hint: "wxyz", lockedBy: null },
      "registrar.yyds.apiKey": { configured: false, hint: null, lockedBy: null },
      "registrar.moemail.apiKey": { configured: false, hint: null, lockedBy: null },
    },
    configDegraded: false,
    editable: [],
    secrets: ["gatewayToken", "registrar.yyds.apiKey", "registrar.moemail.apiKey"],
    // ⚠️ **真的 `GET /admin/api/config` 恒有这一格**（`configGetHandler` 的 `c.json(...)`），
    // 夹具里原来漏了它 —— 而「读得到配置却读不到 `resetBlocked`」在真机上不存在。
    // 补上它之后「读不到」那一档只由真正读不到的用例（`GET` 500）触发，不再被夹具白占。
    resetBlocked: [],
    propagation: { configTtlMs: 30000, kvEdgeCacheMs: 60000, visibilityUpperBoundMs: 90000 },
    ...over,
  };
}

/**
 * 字典里这一条在**面板当前语言**下的原文。
 * **不在用例里抄中文**：抄一份就会与字典漂，而这一族断言比的正好是「屏幕上说的是哪一句」。
 * 当前语言取 `lang-select` 的值（`app.js` 启动时把它设成 `currentLang()`）。
 */
function say(h: Awaited<ReturnType<typeof openSettings>>, key: string): string {
  const lang = h.dom.byId("lang-select").value;
  const row = (I18N as unknown as Record<string, Record<string, string>>)[key];
  if (row === undefined) throw new Error(`字典里没有 ${key} —— 这一格比的是空串`);
  const text = row[lang];
  if (typeof text !== "string" || text === "") throw new Error(`${key} 在 ${lang} 下是空的`);
  return text;
}

const ok = (body: unknown): Resp => ({ status: 200, body });

/** 进壳层、切到设置板块。 */
async function openSettings(respond: (url: string, method: string) => Resp | Promise<Resp>) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    respond,
  });
  await settle();
  h.dom.document.querySelectorAll(".nav-item")
    .find((b) => b.getAttribute("data-section") === "settings")!
    .click();
  await settle();
  return h;
}

/**
 * 进壳层、切到**注册机板块的「设置」分页**。
 *
 * ⚠️ **注册机那张配置卡搬家之后，凡是碰 `registrar.*` 字段的用例都走这个入口。**
 * 它与 `openSettings()` 拿到的是**同一份表单**（`admin-ui/js/sec-settings.js` 的
 * 「**一份 `fields` + 一张 `hosts` 名单。**」），只是宿主换了一个 —— 所以保存、错误行、回读那一套
 * 断言在这边逐条照旧成立，这也正是这些用例该验的东西。
 * 返回值里 `panel` 就是那一页的根节点，**别再拿 `h.section("registrar")` 去找字段**：
 * 「运行状态」那一页里也有 `[data-channel]`。
 */
async function openRegistrarSettings(respond: (url: string, method: string) => Resp | Promise<Resp>) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    respond,
  });
  await settle();
  h.dom.document.querySelectorAll(".nav-item")
    .find((b) => b.getAttribute("data-section") === "registrar")!
    .click();
  await settle();
  const section = h.section("registrar");
  section.querySelectorAll('[role="tab"]')
    .find((b) => b.getAttribute("data-i18n") === "reg.tab.settings")!
    .click();
  await settle();
  const panel = section.querySelectorAll('[id="reg-panel-settings"]')[0];
  if (!panel) throw new Error("找不到注册机板块的「设置」分页");
  return { h, panel };
}

function fieldNode(section: FakeElement, path: string): FakeElement {
  const node = section.walk().find((n) => n.getAttribute("data-field") === path);
  if (!node) throw new Error(`找不到字段 ${path}`);
  return node;
}

function inputOf(section: FakeElement, path: string): FakeElement {
  const wrap = fieldNode(section, path);
  const node = wrap.children.find((c) => c.tagName === "input" || c.tagName === "select");
  if (!node) throw new Error(`字段 ${path} 没有输入控件`);
  return node;
}

function saveButton(section: FakeElement): FakeElement {
  const b = section.querySelectorAll("button").find((x) => x.getAttribute("data-i18n") === "set.save");
  if (!b) throw new Error("找不到保存按钮");
  return b;
}

/** 屏幕上此刻能读到的全部文本（含 toast 宿主）。 */
function screenText(h: Awaited<ReturnType<typeof openSettings>>): string {
  return h.dom.document.body.textContent;
}

/**
 * 按标题 key 找到那张卡。`admin-ui/js/sec-settings.js` 的 `card()` 建出来的形状是
 * `div.card.block` > `h3[data-i18n=<titleKey>]` + `div`（body），所以标题的父节点就是整张卡。
 */
function cardByTitleKey(section: FakeElement, titleKey: string): FakeElement {
  const title = section.walk()
    .find((n) => n.tagName === "h3" && n.getAttribute("data-i18n") === titleKey);
  if (!title?.parent) throw new Error(`找不到标题是 ${titleKey} 的卡`);
  return title.parent;
}

/**
 * 这棵子树里**运维真的看得到**的那些字。`display:none` 的分支整段跳过：
 * 「渲染了但藏起来了」与「印在屏幕上」是两回事，而本文件断言的一律是后者
 *（设置页里 `cfg-lock` 那一行默认就是 `display:none`）。
 */
function visibleText(node: FakeElement): string {
  if (node.style.display === "none") return "";
  if (node.children.length === 0) return node.textContent;
  return node.children.map(visibleText).join(" ");
}

// ───────────────────────────────────────────────────────────────────────────
// 设计 §5.3：写操作的成功提示不得早于回读
// ───────────────────────────────────────────────────────────────────────────

describe("产品不变式：成功提示不得早于回读（设计 §5.3）", () => {
  /**
   * ⚠️⚠️ **变异的靶子：把成功提示挪到 `await 回读` 之前。**
   *
   * 判别力全部来自那把手动闸：`PUT` 的应答挂着不返回，于是「回读还没落定」这个
   * 状态在断言的那一刻**真的成立**。零延迟的替身下这一格对那条变异完全无感。
   *
   * **两半都要断言**：只断言「闸没开时看不到提示」的话，一个**永远不提示**的
   * 实现照样绿——那不是修好了，那是把反馈整个删掉了。
   */
  it("回读还没落定之前，界面上不许出现任何成功迹象", async () => {
    let release!: (r: Resp) => void;
    const gate = new Promise<Resp>((res) => { release = res; });
    let putSeen = 0;

    const h = await openSettings((url) => {
      if (url.startsWith("/admin/api/config") && putSeen > 0) return gate;
      return ok(configBody());
    });
    const section = h.section("settings");

    // 改一格，点保存。
    inputOf(section, "maxStrikes").value = "9";
    putSeen = 1;
    saveButton(section).click();
    await settle();

    // ── 闸还关着：回读没落定 ────────────────────────────────────────────────
    expect(h.calls.some((c) => c.method === "PUT"), "前置条件：PUT 得真的发出去了").toBe(true);
    const before = screenText(h);
    // 「回读汇总」那一行是本页面唯一的成功迹象（设计 §5.3 明令不弹「已保存并生效」）。
    expect(
      section.querySelectorAll("p").filter((p) => p.classList.contains("cfg-readback"))
        .every((p) => p.style.display === "none"),
      "回读还没落定，界面上已经出现了「已回读」那一行",
    ).toBe(true);
    // 高亮同样不许提前出现。
    expect(
      section.walk().some((n) => n.classList.contains("changed")),
      "回读还没落定，界面上已经把字段高亮成「变了」",
    ).toBe(false);
    // toast 宿主里也不许有任何东西（挪到 await 之前最省事的写法就是弹一句 toast）。
    expect(h.dom.byId("toast-host").children.length, "回读还没落定就弹了 toast").toBe(0);

    // ── 闸开了：这时候才允许说话，而且说的是回读结果本身 ──────────────────────
    release(ok(configBody({
      fields: { ...configBody().fields, maxStrikes: { stored: 9, env: null, effective: 9, lockedBy: null } },
      changed: ["maxStrikes"],
      credentialsChanged: [],
    })));
    await settle(10);

    const readback = section.querySelectorAll("p").find((p) => p.classList.contains("cfg-readback"))!;
    expect(readback.style.display, "回读落定了，却没有任何反馈 —— 那不是修好了，是把反馈删了")
      .not.toBe("none");
    expect(fieldNode(section, "maxStrikes").classList.contains("changed"), "变化的字段没有被高亮").toBe(true);
    expect(screenText(h), "反馈文案压根没变").not.toBe(before);
  });

  /**
   * **设计 §5.3 明令：保存后不弹「已保存并生效」。**
   *
   * 这一格钉的是**文案本身**：回读汇总那一行说的是「回读到了什么」，
   * 不是「保存成功了」。措辞一改成承诺式，这一格红。
   */
  it("不弹「已保存并生效」——那句话是这个面板最不该说的", async () => {
    const h = await openSettings((url) => ok(url.startsWith("/admin/api/config")
      ? configBody({ changed: ["maxStrikes"], credentialsChanged: [] })
      : {}));
    const section = h.section("settings");
    inputOf(section, "maxStrikes").value = "9";
    saveButton(section).click();
    await settle(10);

    for (const banned of ["已保存并生效", "保存成功"]) {
      expect(screenText(h), `面板对运维承诺了「${banned}」`).not.toContain(banned);
    }
    // 反向自检：它确实说了点什么（不是因为整页空白才没命中）。
    expect(screenText(h)).toContain("回读");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 锁定字段、凭据、高级区
// ───────────────────────────────────────────────────────────────────────────

describe("被 env 锁定的字段（设计 §5.3 UI 规则 / §10.4 卡 1）", () => {
  /**
   * ⚠️ **变异的靶子：把 env 锁定的字段做成可编辑。**
   *
   * 说明必须说清**怎么改**，不是只说「被锁了」：面板上改一百遍都不会生效，
   * 运维要知道去改的是部署那一侧。
   */
  it("被 env 锁定的字段：输入框 disabled，且旁边有一句怎么轮换的说明", async () => {
    const h = await openSettings(() => ok(configBody({
      fields: {
        ...configBody().fields,
        maxStrikes: { stored: 3, env: "9", effective: 9, lockedBy: "env:MAX_STRIKES" },
      },
    })));
    const section = h.section("settings");

    expect(inputOf(section, "maxStrikes").disabled, "锁定的字段还能编辑").toBe(true);
    const lock = fieldNode(section, "maxStrikes").children.find((c) => c.classList.contains("cfg-lock"))!;
    expect(lock.style.display).not.toBe("none");
    expect(lock.textContent, "说明里没点名是哪个环境变量").toContain("MAX_STRIKES");
    // 反向：没锁的那一格照常可编辑，且没有那一行说明。
    expect(inputOf(section, "cooldownStrikeMs").disabled).toBe(false);
    const free = fieldNode(section, "cooldownStrikeMs").children.find((c) => c.classList.contains("cfg-lock"))!;
    expect(free.style.display).toBe("none");
  });

  /** 四元组三格都要显示出来——只显示生效值的话，「保存了却没生效」就看不出原因。 */
  it("四元组把「存储里是什么 / 环境变量是什么 / 生效的是什么」三格都写出来", async () => {
    const h = await openSettings(() => ok(configBody({
      fields: {
        ...configBody().fields,
        maxStrikes: { stored: 3, env: "9", effective: 9, lockedBy: "env:MAX_STRIKES" },
      },
    })));
    const meta = fieldNode(h.section("settings"), "maxStrikes")
      .children.find((c) => c.classList.contains("cfg-meta"))!;
    for (const piece of ["3", "9"]) expect(meta.textContent).toContain(piece);
  });
});

/**
 * **卡 2 底下那句「改了要重启」。**
 *
 * `set.card.upstreamNote` 在字典里躺了整整一期没上屏，而
 * `admin-ui/js/pure/settings.mjs` 的 `CARD_UPSTREAM` 注释一直声称它「就在卡 2 底下」——
 * 那句注释在本任务之前是假的。它不是一条可有可无的润色：`poolCacheTtlMs` /
 * `poolTouchIntervalMs` 与卡 2 里别的字段有一条真实差异（建实例时读一次，改了要
 * 重启容器 / 等 isolate 回收才生效），面板不说这句话，运维改完刷新一看没变化，
 * 只会得出「这个面板的保存是假的」这个结论。
 *
 * ⚠️ 这一格同时是 `scripts/check-i18n.mjs` 这道门禁那条「未被引用的 key ⇒ 硬错」的**另一半**：
 * 那道门禁只能逼人「删掉或者接上」，**它分不出这两条哪条才对**。真正把
 * `set.card.upstreamNote` 钉在「接上」那一边的是这一格。
 */
describe("卡 2 的诚实提示", () => {
  it("卡 2 底下真的印着那句「改了要重启」——它不是只写在字典和注释里", async () => {
    const h = await openSettings(() => ok(configBody()));
    const card = cardByTitleKey(h.section("settings"), "set.card.upstream");
    // 用**文本内容**断言，不用类名：类名是样式，改样式不该让这格红。
    expect(
      visibleText(card),
      "卡 2 底下那句 `set.card.upstreamNote` 没上屏 —— 面板对「这两个旋钮要重启才生效」保持了沉默",
    ).toContain("改了要重启容器 / 等 isolate 回收才生效");
  });

  /**
   * **反向控制：那句话得在卡 2，不是随便印在页面某处。**
   * 少了这一格，把 note 挂到卡 1 或者页脚也能让上面那格全绿，而运维改的是卡 2 的旋钮。
   */
  it("反向控制：卡 1 底下不许出现那句话（它说的是卡 2 那两个旋钮）", async () => {
    const h = await openSettings(() => ok(configBody()));
    const auth = cardByTitleKey(h.section("settings"), "set.card.auth");
    expect(visibleText(auth)).not.toContain("改了要重启容器");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 保存回执不许对「建实例时读一次」的旋钮谎称本实例已生效
// ───────────────────────────────────────────────────────────────────────────

/**
 * **`set.propagation` 那句话对这两个旋钮是假的。**
 *
 * 它逐字说的是「本实例已经生效；别的副本 / isolate 最长 {bound} 之后才看得到这次改动」，
 * 而 `poolCacheTtlMs` / `poolTouchIntervalMs` 是**建 app 时读一次**的
 *（`src/http/wire.ts` 里 `const cfg = configHolder.current()` 之后那两行）：
 * **本实例根本没生效**，而且等多久都没用——要重启容器 / 等 isolate 回收。
 * 改动前保存完一律渲染那一句 ⇒ 运维等满一个上界回来一看没变化，
 * 得出的结论与卡 2 那句沉默时一样：「这个面板的保存是假的」。
 * **说了但说错，比不说更坏**：不说至少不会有人去等那 90 秒。
 *
 * ⚠️ **这一族与卡 2 底下那句 `set.card.upstreamNote` 是同一件事的两半**：
 * 那一句是**常驻**的静态提示（改之前就该看见），这一族是**保存回执**里对
 * 「这一次到底动了哪一类字段」的表态。只补前者的话，回执照旧当面说反话。
 *
 * ⚠️ **判据必须从 `BUILD_TIME_FIELDS` 派生**，`sec-settings.js` 里不许写
 * `if (path === "poolCacheTtlMs" || …)`——那是又一份会漂的手写清单。
 * 那张表自己不是靠手写守住的：`tests/ui/settings.test.ts` 的
 * 「BUILD_TIME_FIELDS 就是 wire.ts 建 app 时读的那份快照里、面板又能改的那几格」
 * 直接从 `src/http/wire.ts` 反查它。
 *
 * ⚠️ **下面两个字段名是手写的，这条边界如实写下来**：它们让「删掉表里一项」当场变红
 *（本族第一格），但**新增**一个建实例时读一次的字段时本族不会自己长出一格——
 * 那一半由上面点名的那条派生守卫负责（它会红，逼人回来补）。
 */
describe("建实例时读一次的旋钮：保存回执分岔", () => {
  /** `set.propagation` 里独有的那半句。 */
  const LIVE_LINE = "本实例已经生效";
  /** `set.propagation.buildTime` 里独有的那半句——**它必须与上面那句分得开**。 */
  const BUILD_TIME_LINE = "本实例也还没生效";

  /**
   * 改这几格 → 点保存 → 回执按后端回读的 `changed` 说话，返回**屏幕上看得到**的字。
   *
   * ⚠️ **GET 与 PUT 给的响应形状不同，这不是偷懒**：真后端的 `GET /admin/api/config`
   * 里**没有** `changed` 这一格（`src/http/admin/handlers/config.ts` 两个 handler 逐字如此），
   * 而面板正是靠这一格分辨「这份数据是一次保存的回执」还是「只是读了一次」。
   * 两边都给 `changed` 的话，第 ④ 格（还没保存过）就测不出来了。
   */
  async function saveChanging(entries: ReadonlyArray<readonly [string, string]>): Promise<string> {
    const h = await openSettings((url, method) => {
      if (!url.startsWith("/admin/api/config")) return ok({});
      return ok(method === "PUT"
        ? configBody({ changed: entries.map(([p]) => p), credentialsChanged: [] })
        : configBody());
    });
    const section = h.section("settings");
    for (const [path, value] of entries) inputOf(section, path).value = value;
    saveButton(section).click();
    await settle(10);
    return visibleText(section);
  }

  for (const path of ["poolCacheTtlMs", "poolTouchIntervalMs"]) {
    it(`① 只改 ${path} 时：不许说本实例已经生效，必须说本实例也还没生效`, async () => {
      const text = await saveChanging([[path, "120000"]]);
      expect(
        text,
        `只改了 ${path} 这个建实例时读一次的旋钮，回执却说「${LIVE_LINE}」——运维会等满一个传播上界，然后发现什么都没变`,
      ).not.toContain(LIVE_LINE);
      // **不是只把假话删掉就完了**：删掉之后面板对这次保存整个沉默，
      // 而沉默正是那一轮判定为「运维会以为保存是假的」的那一档。
      expect(
        text,
        `回执对 ${path} 什么都没说 —— 删掉一句假话不等于说了真话`,
      ).toContain(BUILD_TIME_LINE);
      expect(text).toContain("要重启容器 / 等 isolate 回收才看得到");
    });
  }

  /**
   * **反向控制：逐次生效的字段照旧走原来那句。**
   * 少了这一格，一个「一律只说重启那句」的实现也能让上面两格全绿——
   * 而 `set.propagation` 那句话是当初花整轮论证出来的（五语言 DEPLOY.md 写着
   * 面板文案不许写「立即生效」），本任务是**给它加例外分支，不是把它换掉**。
   */
  it("② 反向控制：只改 maxStrikes 这类逐次生效的字段时，传播上界照常出现、重启那句不出现", async () => {
    const text = await saveChanging([["maxStrikes", "9"]]);
    expect(text, "逐次生效的字段也被说成了「要重启」—— 例外分支扩得太宽").not.toContain(BUILD_TIME_LINE);
    expect(text, "传播上界那句被一起删掉了 —— 那是当初论证出来的必须显示项").toContain(LIVE_LINE);
    // 90_000 ms 经 `fmtDuration` 是「1分30秒」。
    expect(text).toContain("1分30秒");
  });

  /**
   * ⚠️⚠️ **这一格是最容易被漏掉的形状，而它恰恰是真实运维最常见的那一次保存。**
   * 只写 ①② 的话，把实现写成 `if (碰了旋钮) 说重启 else 说传播上界` 也能全绿——
   * 而那种实现在「顺手一起改了」的那一次保存里，会把逐次生效那半边的话吞掉。
   * 两句话说的是**两组不同的字段**，不是同一件事的两种档位，所以它们必须能同时出现。
   */
  it("③ 混合保存：同时改一个逐次生效的字段和一个旋钮 ⇒ 两句都出现", async () => {
    const text = await saveChanging([["maxStrikes", "9"], ["poolCacheTtlMs", "120000"]]);
    expect(text, "混合保存里传播上界那句被吞了 —— 实现多半写成了互斥的 if/else").toContain(LIVE_LINE);
    expect(text, "混合保存里重启那句被吞了 —— 实现多半写成了互斥的 if/else").toContain(BUILD_TIME_LINE);
  });

  /**
   * **还没保存过时不许提前说这次改动的事。**
   * 这一格钉的是「新加的那句话是**保存回执**，不是又一条常驻说明」：
   * 常驻的那一句在卡 2 底下，这一句只在真的动过旋钮之后才该出现。
   *
   * ⚠️ **它只覆盖「从没保存过」那一帧，别把它读成「读取态都对」**：保存完再回读一次
   * 也是读取态，而那一帧上还挂着上一次保存的回读行与高亮——那一档在下面 ⑤ 里
   *（复评发现，改动前它是屏幕上一句用户看得见的假话）。
   */
  it("④ 只是读了一次配置（还没保存过）：重启那句不出现，传播上界照常在", async () => {
    const h = await openSettings(() => ok(configBody()));
    const text = visibleText(h.section("settings"));
    expect(text, "还没保存过就先说上了「这次改动」—— 那是一句无中生有的回执").not.toContain(BUILD_TIME_LINE);
    expect(text, "传播上界那句在读取态下也不见了").toContain(LIVE_LINE);
  });

  /**
   * ⚠️⚠️ **④ 只钉住了「从没保存过」那一帧，而运维真正会走的下一步是「保存完再回读一次」。**
   *
   * 这一格来自复评发现：保存了一个旋钮之后（屏幕上正确地说「本实例也还没生效」），
   * 点一下面板自己的「刷新」⇒ `load()` 拿回一份 GET（没有 `changed`）⇒ 回到读取态 ⇒
   * `set.propagation` 回来。**问题不在这一句本身**（读取态下它必须在，那是 ④ 与当初钉的），
   * 而在于它**不是一个人站在那里**：改动前 `nodes.readback` 还挂着「已回读生效值，
   * 1 个字段发生了变化（已高亮）」、那一格还带着 `.changed` 高亮——三个信号一起指向
   * 刚才那次保存，屏幕上于是编出了一句「你刚改的那格本实例已经生效」，而它是假的。
   *
   * ⚠️ **两条路径都要走**：「刷新」按钮与「切板块回来」都落在同一个 `load()` 上，
   * 但它们是**两个不同的入口**（后者还多走一遍 `onShow()`）。第三条同形态入口是
   * `admin-ui/js/app.js` 的 `langchange` 兜底（同样 `onShow()` ⇒ `load()`），
   * 它没有单独一格，如实登记在这里。
   *
   * ⚠️ **每条路径先验「保存那一帧确实出现过这两个信号」再验它们消失**——
   * 少了前半句，判据串哪天与文案对不上时这一格会因为「本来就没匹配上」而全绿。
   */
  it("⑤ 保存旋钮之后回到读取态：回读行与高亮一并作废，屏幕上不会同时说「变了 1 格」和「本实例已经生效」", async () => {
    /** `set.readback` / `set.readback.none` 共有的那半句。 */
    const READBACK_LINE = "已回读生效值";

    const paths: ReadonlyArray<readonly [string, (h: Awaited<ReturnType<typeof openSettings>>) => void]> = [
      ["点面板自己的「刷新」按钮", (h) => {
        const btn = h.section("settings").querySelectorAll("button")
          .find((b) => b.getAttribute("data-i18n") === "common.refresh");
        if (!btn) throw new Error("设置页工具条上找不到刷新按钮 —— 这一格的入口变了");
        btn.click();
      }],
      ["切到别的板块再切回来", (h) => {
        const nav = (name: string) => {
          const b = h.dom.document.querySelectorAll(".nav-item")
            .find((x) => x.getAttribute("data-section") === name);
          if (!b) throw new Error(`导航上找不到 ${name} —— 这一格的入口变了`);
          b.click();
        };
        nav("overview");
        nav("settings");
      }],
    ];

    for (const [label, backToRead] of paths) {
      const h = await openSettings((url, method) => {
        if (!url.startsWith("/admin/api/config")) return ok({});
        return ok(method === "PUT"
          ? configBody({ changed: ["poolCacheTtlMs"], credentialsChanged: [] })
          : configBody());
      });
      const section = h.section("settings");
      inputOf(section, "poolCacheTtlMs").value = "120000";
      saveButton(section).click();
      await settle(10);

      // ── 前半句：保存那一帧，三个信号确实都在（判据认得出它们）──────────────
      const saved = visibleText(section);
      expect(saved, `[${label}] 保存那一帧就没出现回读行 —— 下面那句「它消失了」测的是一个没发生过的状态`)
        .toContain(READBACK_LINE);
      expect(saved, `[${label}] 保存那一帧就没说「本实例也还没生效」 —— 这一格测的前提没成立`)
        .toContain(BUILD_TIME_LINE);
      expect(section.querySelectorAll(".changed").length, `[${label}] 保存那一帧一格高亮都没有 —— 前提没成立`)
        .toBeGreaterThan(0);

      // ── 后半句：回到读取态之后，指向那次保存的两个信号必须一起没了 ──────────
      backToRead(h);
      await settle(10);
      const after = visibleText(section);
      expect(after, `[${label}] 回到读取态之后「${LIVE_LINE}」与回读行同屏 —— 屏幕上编出了「你刚改的那格已经生效」`)
        .not.toContain(READBACK_LINE);
      expect(section.querySelectorAll(".changed").length, `[${label}] 回到读取态之后那一格还留着高亮 —— 它会被读成「刚才那次保存」`)
        .toBe(0);
      // 反向控制：传播上界那句在读取态下**照旧必须在**（当初论证出来的必须显示项，同 ④）。
      // 少了它，一个「读取态干脆什么都不显示」的实现也能让上面两条全绿。
      expect(after, `[${label}] 连传播上界那句也一起删掉了 —— 那是当初论证出来的必须显示项`)
        .toContain(LIVE_LINE);
    }
  });
});

describe("凭据只写不读（设计 §8.6）", () => {
  it("凭据框是 password、永远是空的，占位符说「留空则不修改」", async () => {
    const h = await openSettings(() => ok(configBody()));
    const input = inputOf(h.section("settings"), "gatewayToken");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.value, "凭据框被回填了 —— 那意味着明文来过前端").toBe("");
    expect(String(input.getAttribute("placeholder"))).toContain("留空");
  });

  it("凭据那一行显示「已配置 + 末 4 位」，没有明文", async () => {
    const h = await openSettings(() => ok(configBody()));
    const meta = fieldNode(h.section("settings"), "gatewayToken")
      .children.find((c) => c.classList.contains("cfg-meta"))!;
    expect(meta.textContent).toContain("wxyz");
  });

  /**
   * **清空是一条显式动作，且带二次确认**（设计 §8.6）。
   */
  it("清空凭据要二次确认，且确认之前一次网络调用都不发", async () => {
    const h = await openSettings(() => ok(configBody()));
    const section = h.section("settings");
    const clear = fieldNode(section, "gatewayToken").children.find((c) => c.classList.contains("cfg-clear"))!;
    clear.click();
    await settle();

    const modal = h.dom.document.querySelectorAll(".modal")[0];
    expect(modal, "清空没有二次确认 —— 一次误点就抹掉网关口令").toBeDefined();
    expect(modal!.textContent).toContain("起不来");
    // **确认之前一次网络调用都不许发出去。**
    expect(h.calls.some((c) => c.url.includes("secrets/clear")), "还没确认就发出去了").toBe(false);
  });

  /** 弹窗里那句按状态分岔的警告，取出它的文本。 */
  async function warningTextFor(
    over: Record<string, unknown>, path: string,
  ): Promise<{ text: string; danger: boolean; disabled: boolean }> {
    const h = await openSettings(() => ok(configBody(over)));
    const section = h.section("settings");
    const clear = fieldNode(section, path).children.find((c) => c.classList.contains("cfg-clear"))!;
    const disabled = clear.disabled;
    clear.click();
    await settle();
    const modal = h.dom.document.querySelectorAll(".modal")[0]!;
    const lines = modal.querySelectorAll("p");
    const last = lines[lines.length - 1]!;
    return { text: last.textContent, danger: last.classList.contains("danger-text"), disabled };
  }

  /**
   * ⚠️⚠️ **判据是「两种状态给出的文案不同」，不是「有警告」。**
   *
   * 只断「弹窗里有一句红字」的话，退回那句带「如果环境变量里也没有……」的通用条件句
   * 照样全绿——而那正是要修的东西：**同一句通用红字，在这两种状态下一句是救命、
   * 一句是吓人**，而面板手上有分辨它们的数据。
   * 分岔判据本身在 `tests/ui/settings.test.ts` 的
   * 「四种状态给出四条互不相同的 key，且轻重分成两档」，这里验的是它真的接上了 DOM。
   */
  it("env 里有 / 没有这一项，弹窗里那句话必须不同（不是两处都弹同一句红字）", async () => {
    const noEnv = await warningTextFor({}, "gatewayToken");
    const withEnv = await warningTextFor({
      credentials: {
        ...configBody().credentials,
        gatewayToken: { configured: true, hint: "wxyz", lockedBy: "env:GATEWAY_TOKEN" },
      },
    }, "gatewayToken");

    expect(
      withEnv.text,
      "env 里有没有这一项，面板说的是同一句话 —— 那等于让运维自己猜",
    ).not.toBe(noEnv.text);
    // 各自说的是那件确定的事，而不是一句「如果……」。
    expect(noEnv.text, "env 里没有时没说清后果是冷启动失败").toContain("起不来");
    expect(withEnv.text, "env 里有时没说清生效值不变").toContain("生效值不变");
    // 轻重也要分开：救命的那句红，回落那句不红。
    expect(noEnv.danger).toBe(true);
    expect(withEnv.danger).toBe(false);
  });

  /**
   * ⚠️ **env 锁定时那颗清空按钮不许被禁用**，否则上面那格里「env 里有」的分支
   * 在真实面板上**根本够不着**——而后端从来没拦过它
   * （`configClearSecretHandler` 里 `stillConfigured` 那一支就是专门为这个状态写的），
   * `src/core/admin/config-validate.ts` 的 `clearSecret` 上写的理由也正是
   * 「环境变量提供口令的部署想清掉存储里那份多余的旧口令时无路可走」。
   * **变红条件**：把清空按钮改回跟着 `locked` 一起禁用。
   */
  it("env 锁定时清空按钮仍然可点 —— 清的是存储那一份，那恰恰是最安全的状态", async () => {
    const withEnv = await warningTextFor({
      credentials: {
        ...configBody().credentials,
        gatewayToken: { configured: true, hint: "wxyz", lockedBy: "env:GATEWAY_TOKEN" },
      },
    }, "gatewayToken");
    expect(withEnv.disabled, "env 锁定把清空按钮禁用了 —— 存储里那份旧口令从此没有入口能删").toBe(false);
  });

  /** 没配过的凭据没有东西可清 ⇒ 按钮禁用（点它是纯粹的空操作）。 */
  it("没配过的凭据：清空按钮禁用", async () => {
    const { panel } = await openRegistrarSettings(() => ok(configBody()));
    const clear = fieldNode(panel, "registrar.yyds.apiKey")
      .children.find((c) => c.classList.contains("cfg-clear"))!;
    expect(clear.disabled).toBe(true);
  });
});

describe("agnesPlatformUrl 折在高级区，且有自己的二次确认（设计 §8.6 第二行）", () => {
  /** **变异的靶子**（DOM 侧那一半）：把它挪回主表单。 */
  it("它在 details 折叠区里，不在注册机那张卡的主表单里", async () => {
    const { h, panel } = await openRegistrarSettings(() => ok(configBody()));
    const node = fieldNode(panel, "registrar.agnesPlatformUrl");
    // 顺着 parent 往上走，必须撞到一个 `details`。
    let cur: FakeElement | null = node;
    let inDetails = false;
    while (cur !== null) {
      if (cur.tagName === "details") { inDetails = true; break; }
      cur = cur.parent;
    }
    expect(inDetails, "注册去向被挪出了高级折叠区").toBe(true);
    // 红色警告必须在同一个折叠区里。
    const details = h.dom.document.querySelectorAll("details")[0]!;
    expect(details.textContent, "高级区里没有那句警告").toContain("验证码");
  });

  it("高级区那颗保存按钮先弹二次确认，确认之前不发请求", async () => {
    const { h, panel } = await openRegistrarSettings(() => ok(configBody()));
    const advSave = panel.querySelectorAll("button")
      .find((b) => b.getAttribute("data-i18n") === "set.advanced.save")!;
    inputOf(panel, "registrar.agnesPlatformUrl").value = "https://evil.example.com";
    advSave.click();
    await settle();
    expect(h.dom.document.querySelectorAll(".modal").length, "改注册去向没有二次确认").toBe(1);
    expect(h.calls.some((c) => c.method === "PUT"), "还没确认就发出去了").toBe(false);
  });
});

describe("两条通道在设置页上完全对称（设计 §10.3 第 1/2/3 条）", () => {
  /**
   * ⚠️⚠️ **第一版这一格实测抓不住「把两张卡的字段整个对调」**（评审发现，我复现属实：
   * MoeMail 卡里装 `registrar.yyds.*`、标签仍写 MoeMail ⇒ **557 条 UI 用例全绿**）。
   * 两个成因叠在一起：
   * ① 判据只比 `data-field` 的**最后一段**（`split(".").pop()`）⇒ **把通道那一段丢了**；
   * ② 夹具里两条通道的值**恰好全相等** ⇒ 渲染出来的内容也分不出彼此。
   *
   * **这是本任务第二个「夹具里两个本该不同的值恰好相等」的实例**（第一个是无冲突数据那格），
   * 而它偏偏是硬约束「两条通道完全平级」的名义守护者——我在报告里还替它背了书。
   *
   * ⇒ 判据改成**保留完整路径**，并给两条通道种**互不相同**的夹具值，
   * 连渲染出来的那一行也一起断言。
   */
  it("两张子卡的 DOM 顺序恒为 moemail、yyds（字母序），且每张卡装的是自己那条通道的字段", async () => {
    const { panel } = await openRegistrarSettings(() => ok(configBody({
      fields: {
        ...configBody().fields,
        "registrar.moemail.baseUrl": { stored: "https://moemail-only.example.com", env: null, effective: "https://moemail-only.example.com", lockedBy: null },
        "registrar.yyds.baseUrl": { stored: "https://yyds-only.example.com", env: null, effective: "https://yyds-only.example.com", lockedBy: null },
      },
      credentials: {
        ...configBody().credentials,
        "registrar.moemail.apiKey": { configured: true, hint: "MMMM", lockedBy: null },
        "registrar.yyds.apiKey": { configured: true, hint: "YYYY", lockedBy: null },
      },
    })));
    const cards = panel.querySelectorAll(".channel-card");
    expect(cards.map((c) => c.getAttribute("data-channel"))).toEqual(["moemail", "yyds"]);

    // ① **完整路径**：每张卡装的必须是自己那条通道的字段。
    const paths = cards.map((c) => c.walk()
      .filter((n) => n.getAttribute("data-field") !== null)
      .map((n) => String(n.getAttribute("data-field"))));
    expect(paths[0], "MoeMail 卡里装的不是 moemail 的字段").toEqual([
      "registrar.moemail.baseUrl", "registrar.moemail.apiKey",
    ]);
    expect(paths[1], "YYDS 卡里装的不是 yyds 的字段").toEqual([
      "registrar.yyds.baseUrl", "registrar.yyds.apiKey",
    ]);

    // ② **同构**：把通道那一段抠掉之后两边必须逐字相等（这才是「完全对称」那一半）。
    const shapes = paths.map((ps, i) => ps.map((x) => x.replace(`registrar.${["moemail", "yyds"][i]}.`, "")));
    expect(shapes[0], "两张子卡的字段不一样了 —— 「完全对称」当场破").toEqual(shapes[1]);
    expect(shapes[0]).toEqual(["baseUrl", "apiKey"]);

    // ③ **渲染出来的值也不许串**：夹具里两条通道的值刻意互不相同。
    const moemailText = cards[0]!.textContent;
    const yydsText = cards[1]!.textContent;
    expect(moemailText).toContain("moemail-only.example.com");
    expect(moemailText).toContain("MMMM");
    expect(moemailText, "MoeMail 卡上渲染出了 yyds 的数据").not.toContain("yyds-only.example.com");
    expect(yydsText).toContain("yyds-only.example.com");
    expect(yydsText).toContain("YYYY");
    expect(yydsText, "YYDS 卡上渲染出了 moemail 的数据").not.toContain("moemail-only.example.com");
  });

  /** **设计 §10.3 第 1 条：主通道下拉无预选值，初始是占位符。** */
  it("主通道下拉初始不预选任何一条通道", async () => {
    const { panel } = await openRegistrarSettings(() => ok(configBody()));
    const select = inputOf(panel, "registrar.primary");
    expect(select.value, "预选了一条通道 —— 任何预选都会被读成排名").toBe("");
    expect(select.children.map((o) => o.getAttribute("value"))).toEqual(["", "moemail", "yyds"]);
  });
});

describe("错误渲染：逐字段错误码 → 五语言文案", () => {
  /**
   * ⚠️⚠️ **这两格的应答闭包原来引用外层的 `const h`，而它在 `openSettings` 返回
   * 之前就被调用 ⇒ TDZ 抛错 ⇒ `GET /config` 整个失败 ⇒ `data = null`。**
   * 两格于是一直是「因为错误的原因」在绿：`data` 为 `null` 时 `buildPatch` 恰好
   * 仍然产出一个非空 patch（每一格的 `stored` 都是 `null`，输入的 "9" 与它不等），
   * PUT 照样发出去、400 照样渲染——**而那条路径与它声称要测的那条毫无关系**。
   * 补「诊断态下表单仍可编辑」的对照用例时才暴露出来（那一格让空字段真的被置灰）。
   * ⇒ 改成一个不依赖 `h` 的标志位。
   */
  it("后端返回的逐字段错误逐条渲染，并把那一格标红", async () => {
    let sawPut = false;
    const h = await openSettings((url, method) => {
      if (url.startsWith("/admin/api/config") && method === "PUT") { sawPut = true; }
      if (url.startsWith("/admin/api/config") && sawPut) {
        return {
          status: 400,
          body: { error: { type: "invalid_request_error", message: "x" }, errors: [{ field: "maxStrikes", code: "below_min", params: { min: 1 } }] },
        };
      }
      return ok(configBody());
    });
    const section = h.section("settings");
    inputOf(section, "maxStrikes").value = "9";
    saveButton(section).click();
    await settle(10);

    const errors = section.querySelectorAll(".cfg-errors")[0]!;
    expect(errors.style.display).not.toBe("none");
    expect(errors.textContent).toContain("1");
    expect(fieldNode(section, "maxStrikes").classList.contains("invalid")).toBe(true);
  });

  /**
   * **表外的码原样显示出来**，不冒充任何一档已知原因——那条线索是运维唯一能
   * grep 的东西。
   */
  it("这个面板版本不认识的错误码，原样把码显示出来", async () => {
    let sawPut = false;
    const h = await openSettings((url, method) => {
      if (url.startsWith("/admin/api/config") && method === "PUT") { sawPut = true; }
      if (url.startsWith("/admin/api/config") && sawPut) {
        return { status: 400, body: { errors: [{ field: "maxStrikes", code: "brand_new_code_2099" }] } };
      }
      return ok(configBody());
    });
    const section = h.section("settings");
    inputOf(section, "maxStrikes").value = "9";
    saveButton(section).click();
    await settle(10);
    expect(section.querySelectorAll(".cfg-errors")[0]!.textContent).toContain("brand_new_code_2099");
  });
});

describe("接线：不轮询、传播上界要显示出来", () => {
  /**
   * **这个板块没有自动刷新**（每刷一次付一次存储读，而配额账把面板的读算成
   * 「人点一下才发生」）。判据是「切进来之后只打了一次 `GET /config`」。
   */
  it("切进设置页只打一次 GET /config，没有轮询", async () => {
    const h = await openSettings(() => ok(configBody()));
    await settle(10);
    const gets = h.calls.filter((c) => c.method === "GET" && c.url.startsWith("/admin/api/config"));
    expect(gets.length).toBe(1);
  });

  /** **不许写「立即生效」**（设计 §5.2）：那句上界必须显示出来。 */
  it("传播上界（90 秒）显示在页面上，而不是一句「立即生效」", async () => {
    const h = await openSettings(() => ok(configBody()));
    expect(screenText(h)).not.toContain("立即生效");
    // 90_000 ms 经 `fmtDuration` 是「1分30秒」。
    expect(screenText(h)).toContain("1分30秒");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 评审那条的前端那一半：诊断态下表单必须还能用
// ───────────────────────────────────────────────────────────────────────────

/**
 * **诊断态下表单必须仍然可编辑——那是运维唯一的出路。**
 *
 * 装载不起来时后端把 `fields`/`credentials` 给 `null`（不编一份空配置），
 * 于是 `fieldView()` 对每一格都回 `present: false`。板块文件**不许**据此把输入框
 * 一律置灰：那会把「关掉注册机 / 把那把 key 填回去」这两条自救路径在 UI 上堵死，
 * 而后端明明放行。
 *
 * ⚠️⚠️ **这段说明订正过一次，订正的是史实而不是判据（复评发现）。**
 * 原文写的是「第一版的 `renderOne` 据此**把所有输入框一律置灰**……前端跟不上
 * 等于白修」——**那是假史实**。按 `3bf7394` 原样核实：`renderOne` 那一支确实写着
 * `built.input.disabled = true`，但**紧接着**的 `setLock(built, false, null)` 里
 * 第一行是 `built.input.disabled = locked === true` ⇒ 把它抹回 `false`。
 * **诊断态下的表单从来没有被置灰过**，这一格当时就是绿的。
 *
 * **真正存在的缺陷是反过来那条**：`present === false` 那支的置灰**从落地那天起就
 * 没生效过**，于是「这一格单独没读到」也从来没灰过（下面那格「对照」正钉着它）。
 * 修法与这两格用例都是对的，错的只是动机叙述——而叙述会被下一个人当史实读。
 */
describe("装载不起来时的诊断视图（评审那条的前端那一半）", () => {
  /**
   * ⚠️ **`editable` / `secrets` 必须照给，那不是可有可无的装饰**：后端在诊断态下
   * **一定两份都给**（`configGetHandler` 里它们在 `snap` 之外、不受装载成败影响），
   * 而第一版夹具写的是两个空数组。**这是本任务第三个「夹具与真实契约偏离」的实例**
   *（前两个是那一格的无冲突数据、另一条的两条通道取值全等），而这一族偏离的后果一律是
   * 「用例在一份生产上不存在的形态上通过」。
   */
  const BLOCKED = {
    fields: null,
    credentials: null,
    configDegraded: true,
    loadBlocked: [{ field: "registrar.yyds.apiKey", code: "channel_credentials_missing", params: { channel: "yyds" } }],
    editable: [...EDITABLE_FIELDS],
    // ⚠️ **`secrets` 同样接真源。** 这里原来是手写数组，而 `editable` 已经接了
    // `EDITABLE_FIELDS` —— **同一个字面量里一半接真源、一半手写，正是这一族偏离的
    // 下一次入口**（本任务已经栽过三次：无冲突数据、两条通道取值全等、
    // 以及这份夹具第一版的 `editable: []` / `secrets: []`）。
    secrets: [...SECRET_FIELDS],
    propagation: { configTtlMs: 30000, kvEdgeCacheMs: 60000, visibilityUpperBoundMs: 90000 },
  };

  /**
   * ⚠️⚠️ **诊断态下保存，不许凭空替运维送一个他没动过的字段。**
   *
   * 复现（改动前，假 DOM + 真 `buildPatch`）：诊断态下**新开**设置页、只填那把 key、
   * 点保存，实际发出的是
   * `{"registrar.enabled": false, "registrar.yyds.apiKey": "…"}`
   * ——`fields: null` ⇒ checkbox 没有基线 ⇒ `sameScalar(null, false)` 为假 ⇒
   * **凭空替运维把注册机关掉**。而 `changed` 在 `before.prov === null` 时被强制成
   * `[]` ⇒ **回执结构性地说不出这件事**；横幅随后消失（恰恰是因为注册机被关掉了
   * 配置才装得起来），运维读成「恢复了」——而五语言正写着「改完保存即可恢复」。
   *
   * **这不是「面板说了一件没发生的事」，是「面板做了运维没要求的事，然后显示成功」。**
   *
   * ⚠️ 我自己的冒烟看不见它，因为我是**清完立刻重填**，checkbox 还留着
   * `checked = true`，那次送的是 `true`（无害）——报告 §6.8 记的「1 个字段发生了
   * 变化」与这条完全吻合。
   *
   * **变红条件**：把 `buildPatch` 里那句「没有基线的格只送动过的」去掉。
   */
  it("诊断态下只填一格：发出的 patch 里不许有 registrar.enabled", async () => {
    const { h, panel } = await openRegistrarSettings(() => ok(BLOCKED));
    // 只动那把 key（真的派发 input 事件，与运维敲键盘同一条路径）。
    inputOf(panel, "registrar.yyds.apiKey").input("refilled-key-8888");
    saveButton(panel).click();
    await settle(10);

    const put = h.calls.find((c) => c.method === "PUT");
    expect(put, "保存没发出去").toBeDefined();
    const patch = (put!.body as { patch: Record<string, unknown> }).patch;
    expect(
      Object.keys(patch).sort(),
      "面板替运维送了他没动过的字段 —— 诊断态下这会把注册机悄悄关掉，而回执说不出来",
    ).toEqual(["registrar.yyds.apiKey"]);
  });

  /**
   * **反向：动过的那些照旧送得出去。**
   * 只断上一格的话，一个「诊断态下什么都不送」的实现同样绿——而那会让运维再也
   * 没法从诊断态里把注册机**打开**（那同样是一条正当的自救路径）。
   */
  it("诊断态下真的动过的格照旧送得出去（含 checkbox 与下拉）", async () => {
    const { h, panel } = await openRegistrarSettings(() => ok(BLOCKED));
    const toggle = inputOf(panel, "registrar.enabled");
    toggle.checked = true;
    toggle.change();
    const primary = inputOf(panel, "registrar.primary");
    primary.value = "moemail";
    primary.change();
    inputOf(panel, "registrar.moemail.apiKey").input("mk-1234");
    saveButton(panel).click();
    await settle(10);

    const put = h.calls.find((c) => c.method === "PUT");
    const patch = (put!.body as { patch: Record<string, unknown> }).patch;
    expect(Object.keys(patch).sort()).toEqual([
      "registrar.enabled", "registrar.moemail.apiKey", "registrar.primary",
    ]);
    expect(patch["registrar.enabled"], "诊断态下把注册机打开这条路被堵死了").toBe(true);
  });

  /**
   * ⚠️ **这一格顺带钉住「一份表单、两个宿主」那条设计的要害**：装载失败清单画的是
   * **同一份**内容，而它必须在**运维正站着的那一页**上出现。这里站的是注册机的
   * 「设置」分页 —— 画到设置页那份节点上的话，这一格拿到的是 `display: none`。
   */
  it("横幅 + 逐条列出缺什么，并把那一格标红（站在注册机的「设置」分页上）", async () => {
    const { panel } = await openRegistrarSettings(() => ok(BLOCKED));
    const banner = panel.querySelectorAll(".cfg-blocked")[0]!;
    expect(banner.style.display, "装载不起来，面板却什么都没说").not.toBe("none");
    expect(banner.textContent).toContain("下一次重启");
    // 逐条那一行要说清是哪一格、缺什么。
    expect(banner.textContent).toContain("API Key");
    expect(banner.textContent).toContain("凭据");
    expect(fieldNode(panel, "registrar.yyds.apiKey").classList.contains("invalid")).toBe(true);
  });

  /**
   * **变红条件**：把 `renderOne` 里那句 `built.input.disabled = !isDiagnostic(data);`
   * 改回无条件 `true`。
   */
  /**
   * ⚠️ **这一格横跨两个宿主，是有意的**：注册机那三格在注册机板块的「设置」分页上，
   * `maxStrikes` 在设置页上，而它们是**同一份表单**的字段。分成两格写的话，
   * 「两个宿主各自把 `disabled` 算错一半」这种坏法就分不出来了。
   */
  it("诊断态下表单仍然可编辑 —— 那是运维唯一的出路（两个宿主各查一遍）", async () => {
    const { h, panel } = await openRegistrarSettings(() => ok(BLOCKED));
    for (const path of ["registrar.enabled", "registrar.primary", "registrar.yyds.apiKey"]) {
      expect(
        inputOf(panel, path).disabled,
        `${path} 在诊断态下被置灰了 —— 自救路径在 UI 上被堵死，而后端明明放行`,
      ).toBe(false);
    }
    // 切到设置页那个宿主，同一份表单的另一格照旧可编辑。
    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "settings")!
      .click();
    await settle();
    expect(
      inputOf(h.section("settings"), "maxStrikes").disabled,
      "maxStrikes 在诊断态下被置灰了 —— 自救路径在 UI 上被堵死，而后端明明放行",
    ).toBe(false);
  });

  /**
   * **对照：单独某一格没读到（而不是整份装载不起来）时，那一格照旧置灰**——
   * 那时改它没有意义。两种状态必须分得开，否则上一格等于把置灰整个删掉。
   */
  it("对照：只是某一格没读到（不是诊断态）时，那一格照旧置灰", async () => {
    const partial = configBody();
    delete (partial.fields as Record<string, unknown>).maxStrikes;
    const h = await openSettings(() => ok(partial));
    const section = h.section("settings");
    expect(inputOf(section, "maxStrikes").disabled, "「这一格没读到」与「整份装不起来」被混成了一种").toBe(true);
    expect(inputOf(section, "cooldownStrikeMs").disabled).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 危险区（设计里不带编号的那一节「重置到底重置了什么」）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 危险区那张卡的**行为**覆盖。取值决策那一半在 `tests/ui/settings.test.ts` 的
 * 「危险区的取值决策」那一组；这里验的是「板块文件真的把那些判据接上了 DOM」。
 *
 * ⚠️⚠️ **本组最要紧的一格是「打错数字不许发请求」。** 这两颗按钮的后果不可撤销，
 * 而「再点一次确认」对着一个手滑的人拦不住任何东西——把当前池大小手打一遍才是
 * 那道闸。只断言「有个输入框」是不够的：一个**收下输入却不看它**的实现照样绿。
 */
describe("危险区（设计小节「重置到底重置了什么」）", () => {
  /** 危险区那张卡，按标题 key 找。 */
  const dangerCard = (h: Awaited<ReturnType<typeof openSettings>>) =>
    cardByTitleKey(h.section("settings"), "set.card.danger");

  const dangerButton = (h: Awaited<ReturnType<typeof openSettings>>, id: string): FakeElement => {
    const row = dangerCard(h).walk().find((n) => n.getAttribute("data-danger") === id);
    if (!row) throw new Error(`找不到危险区里的 ${id}`);
    const btn = row.children.find((c) => c.tagName === "button");
    if (!btn) throw new Error(`${id} 这一行上没有按钮`);
    return btn;
  };

  /** 默认应答：配置读得到、Key 池有 3 把、两条危险动作都成功。 */
  function danger(over: Record<string, unknown> = {}, poolTotal = 3) {
    return (url: string): Resp => {
      if (url.includes("/config/reset")) {
        return ok({ ...configBody(over), changed: ["maxStrikes"], credentialsChanged: [], resetBlocked: [] });
      }
      if (url.includes("/keys/purge")) return ok({ deleted: poolTotal, remaining: 0, expected: poolTotal });
      if (url.includes("/keys")) return ok({ items: [], total: poolTotal, page: 1, size: 1, pages: 1 });
      if (url.includes("/config")) return ok(configBody(over));
      return ok({ protocols: [], models: [] });
    };
  }

  /**
   * ⚠️ **期望值从 `DANGER_ACTIONS` 现算，不手抄字面量**（复评回填）。
   *
   * 上一版这里写死的是 `["resetConfig","purgeKeys"]`，而报文说的是
   * 「危险区的按钮与 `DANGER_ACTIONS` 对不上」。复评把那张表的两条记录**整体对调**之后，
   * 唯一变红的就是这一格 —— 可那一刻 DOM 与那张表**完全一致**，对不上的是这句手抄的
   * 字面量和五份 ADMIN.md 的行序，照着报文去查会查错地方。
   * ⇒ 这一格今天只守「板块文件真的按那张表派生」；**「那张表的顺序 = 五份文档的行序」
   * 由 `tests/unit/docs-parity.test.ts` 的
   * 「五份 ADMIN.md 危险区那张表的按钮列，逐行等于 DANGER_ACTIONS 的 titleKey 译文」守**。
   */
  it("危险区那张卡真的建出来了，两颗按钮各在自己那一行上", async () => {
    const h = await openSettings(danger());
    const rows = dangerCard(h).walk().filter((n) => n.getAttribute("data-danger") !== null);
    expect(rows.length, "危险区一行都没建出来——这一格比的是两个空数组").toBe(DANGER_ACTIONS.length);
    expect(rows.map((r) => r.getAttribute("data-danger")),
      "屏幕上的危险区按钮没有按 DANGER_ACTIONS 派生 —— 板块文件里多半又写了一份清单")
      .toEqual(DANGER_ACTIONS.map((a) => a.id));
  });

  it("清空 Key 池：点开先取一次当前池大小，确认之前一次写请求都不发", async () => {
    const h = await openSettings(danger({}, 7));
    dangerButton(h, "purgeKeys").click();
    await settle();

    const modal = h.dom.document.querySelectorAll(".modal")[0];
    expect(modal, "清空 Key 池没有二次确认 —— 一次误点就抹掉整池").toBeDefined();
    // 弹窗里印着**现取的**那个数，而不是一个写死的占位。
    expect(modal!.textContent).toContain("7");
    expect(h.calls.some((c) => c.url.includes("/keys/purge")), "还没确认就发出去了").toBe(false);
    // 取数走的是只读那条（GET），不是别的。
    const sizeCall = h.calls.find((c) => c.url.includes("/keys") && !c.url.includes("purge"));
    expect(sizeCall?.method, "取池大小用的不是 GET").toBe("GET");
  });

  it("打错数字：弹窗留着、一次请求都不发，并把「对不上」那句话显示出来", async () => {
    const h = await openSettings(danger({}, 7));
    dangerButton(h, "purgeKeys").click();
    await settle();
    const modal = h.dom.document.querySelectorAll(".modal")[0]!;
    const input = modal.querySelectorAll("input")[0]!;
    input.value = "8";
    modal.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    expect(h.calls.some((c) => c.url.includes("/keys/purge")), "数字打错了却把请求发了出去").toBe(false);
    expect(h.dom.document.querySelectorAll(".modal").length,
      "打错了却把弹窗关掉了 —— 运维得重新点开、重新读那个数").toBe(1);
    const mismatch = modal.walk().find((n) => n.getAttribute("data-i18n") === "set.danger.purge.mismatch");
    expect(mismatch?.style.display, "「对不上」那句话没显示出来").toBe("");
  });

  it("打对数字：把 expect 带上发出去，回执里的 remaining 决定屏幕上说哪句话", async () => {
    const h = await openSettings(danger({}, 7));
    dangerButton(h, "purgeKeys").click();
    await settle();
    const modal = h.dom.document.querySelectorAll(".modal")[0]!;
    modal.querySelectorAll("input")[0]!.value = "7";
    modal.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const call = h.calls.find((c) => c.url.includes("/keys/purge"));
    expect(call, "数字打对了却没发请求").toBeDefined();
    expect(call!.method).toBe("POST");
    expect(call!.body, "expect 没带上 —— 后端那道「池子在你确认之前变了」的闸就成了摆设")
      .toEqual({ expect: 7 });
    const line = dangerCard(h).walk().find((n) => n.classList.contains("cfg-danger-result"))!;
    expect(line.style.display, "回执行没显示出来").toBe("");
    expect(line.textContent, "回执里 remaining=0，回执行却没说删了几把").toContain("7");
  });

  /**
   * ⚠️ **`remaining` 非零那一档必须说实话。** 后端那一格是**回读**出来的
   *（索引写空了、而存储里还躺着记录），面板把它说成「已清空」就是又一次
   * 「屏幕上编一个状态」——那次编状态码是同一个形状。
   */
  it("回执里 remaining 非零：屏幕上说的是「还剩几把」，不是「已清空」", async () => {
    const h = await openSettings((url: string) => {
      if (url.includes("/keys/purge")) return ok({ deleted: 7, remaining: 2, expected: 7 });
      if (url.includes("/keys")) return ok({ items: [], total: 7, page: 1, size: 1, pages: 1 });
      if (url.includes("/config")) return ok(configBody());
      return ok({ protocols: [], models: [] });
    });
    dangerButton(h, "purgeKeys").click();
    await settle();
    const modal = h.dom.document.querySelectorAll(".modal")[0]!;
    modal.querySelectorAll("input")[0]!.value = "7";
    modal.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const line = dangerCard(h).walk().find((n) => n.classList.contains("cfg-danger-result"))!;
    expect(line.style.display, "回执行没显示出来").toBe("");
    expect(line.textContent, "屏幕上没说还剩几把").toContain("2");
  });

  it("池大小读不出来：不开确认框，也不发任何写请求", async () => {
    const h = await openSettings((url: string) => {
      if (url.includes("/keys")) return { status: 500, body: { error: { message: "boom" } } };
      if (url.includes("/config")) return ok(configBody());
      return ok({ protocols: [], models: [] });
    });
    dangerButton(h, "purgeKeys").click();
    await settle();
    expect(h.dom.document.querySelectorAll(".modal").length,
      "读不到池大小却把确认框开了 —— 那个数要么是编的、要么是 0，而 0 会让人在一池 key 上确认一个「空池」")
      .toBe(0);
    expect(h.calls.some((c) => c.url.includes("purge"))).toBe(false);
  });

  it("重置配置：二次确认里那句话按后端的 resetBlocked 分岔，且确认之前不发请求", async () => {
    const missing = await openSettings(danger({ resetBlocked: [{ field: "gatewayToken", code: "gateway_token_required" }] }));
    dangerButton(missing, "resetConfig").click();
    await settle();
    const m1 = missing.dom.document.querySelectorAll(".modal")[0];
    expect(m1, "重置配置没有二次确认").toBeDefined();
    expect(m1!.textContent, "缺网关口令那一态没有复用已上线的那句话").toContain("起不来");
    expect(missing.calls.some((c) => c.url.includes("/config/reset")), "还没确认就发出去了").toBe(false);

    const fine = await openSettings(danger({ resetBlocked: [] }));
    dangerButton(fine, "resetConfig").click();
    await settle();
    const m2 = fine.dom.document.querySelectorAll(".modal")[0]!;
    expect(m2.textContent, "两态给出的是同一句话 —— 那就等于没有分岔").not.toContain("起不来");
  });

  it("重置确认之后：请求带 confirm: true，回执按回读结果把变了的那格高亮出来", async () => {
    const h = await openSettings(danger({ resetBlocked: [] }));
    dangerButton(h, "resetConfig").click();
    await settle();
    h.dom.document.querySelectorAll(".modal")[0]!
      .querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const call = h.calls.find((c) => c.url.includes("/config/reset"));
    expect(call, "确认了却没发请求").toBeDefined();
    expect(call!.body, "confirm 没带上 —— 后端那道「必须显式确认」的闸就成了摆设").toEqual({ confirm: true });
    // 回执里 `changed: ["maxStrikes"]` ⇒ 那一格要被高亮（判据与保存那条同源）。
    expect(fieldNode(h.section("settings"), "maxStrikes").classList.contains("changed"),
      "回读说这一格变了，屏幕上却没高亮").toBe(true);
    // ⚠️ **回执那句话里的数字就是被高亮的格数**（复评回填）：说「高亮出来了」而屏幕上
    // 一格都没亮，与说「亮了 3 格」而只亮 1 格，是同一种「屏幕上编一个状态」。
    const line = dangerCard(h).walk().find((n) => n.classList.contains("cfg-danger-result"))!;
    const lit = h.section("settings").walk().filter((n) => n.classList.contains("changed")).length;
    expect(lit, "前置条件：这一档本该真的高亮一格").toBe(1);
    expect(line.textContent, "回执那句话里的数字与真的高亮出来的格数对不上")
      .toBe(say(h, "set.danger.reset.done").replace("{count}", String(lit)));
  });

  // ── 复评回填：三条「屏幕上讲一个假故事」的用户可见缺陷 ─────────────────────────
  //
  // ⚠️⚠️ **这三格测的是同一个形状：一句话在它描述的那件事已经过去之后还留在屏幕上。**
  // 那次「屏幕上编出一个状态码」、复评那次「三个信号一起指向一次没有发生的
  // 变化」都是它。**复评实测到的三条全部落在这张卡上**，而当天没有任何一格看得见它们
  //（原来那几格只在动作发生的那一拍断言 `display === ""`，一拍之后再没人看过）。

  it("清空成功之后：点刷新 / 切板块回来 / 切语言，危险区那一行回执都必须作废", async () => {
    const h = await openSettings(danger({}, 7));
    dangerButton(h, "purgeKeys").click();
    await settle();
    const modal = h.dom.document.querySelectorAll(".modal")[0]!;
    modal.querySelectorAll("input")[0]!.value = "7";
    modal.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const line = dangerCard(h).walk().find((n) => n.classList.contains("cfg-danger-result"))!;
    expect(line.style.display, "前置条件：回执行得先显示出来").toBe("");
    expect(line.textContent, "前置条件：回执行得先说出删了几把").toContain("7");

    // ① 面板自己的「刷新」。
    h.section("settings").querySelectorAll("button")
      .find((b) => b.getAttribute("data-i18n") === "common.refresh")!.click();
    await settle();
    expect(line.style.display,
      "刷新之后那句「已删掉 7 把」还挂在屏幕上 —— 它描述的是一次早已过去的操作").toBe("none");
    expect(line.textContent, "藏起来了但文本还在，下一次显示会把旧话再放出来").toBe("");

    // ② 切走再切回来。
    const nav = (name: string) => h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === name)!;
    nav("keys").click();
    await settle();
    nav("settings").click();
    await settle();
    expect(line.style.display, "切板块回来之后那句回执又冒出来了").toBe("none");

    // ③ 切语言。**这一档是它最难看的形态**：`t()` 出来的文本框架层 `apply(document)`
    //    刷不动，于是屏幕上会同时有两种语言。
    const sel = h.dom.byId("lang-select");
    const before = sel.value;
    sel.value = before === "en" ? "ja" : "en";
    sel.change();
    await settle();
    expect(line.style.display, "切语言之后那句回执还在，而且停在旧语言上").toBe("none");
    expect(line.textContent).toBe("");
  });

  /**
   * ⚠️⚠️ **重置回执里也有 `changed`** ⇒ `isSaveReceipt()` 认它是一次写回执 ⇒
   * `render()` 里那段「回到读取态就把回读行与高亮一并作废」**恒不跑**。
   * 复评实测：保存一格之后重置（回执 `changed: []`），屏幕上同时挂着
   * 「已回读生效值，**1** 个字段发生了变化（已高亮）」+ maxStrikes 仍带 `.changed`
   * ——那个 `1` 来自上一次保存，三个信号一起指向一次**没有发生**的变化。
   */
  it("保存一格之后重置：上一次保存留下的回读行与高亮一并作废，回执说的是「一格都没变」", async () => {
    const h = await openSettings((url: string) => {
      if (url.includes("/config/reset")) {
        return ok({ ...configBody(), changed: [], credentialsChanged: [], resetBlocked: [] });
      }
      if (url.includes("/keys")) return ok({ items: [], total: 0, page: 1, size: 1, pages: 1 });
      if (url.includes("/config")) return ok({ ...configBody(), changed: ["maxStrikes"], credentialsChanged: [] });
      return ok({ protocols: [], models: [] });
    });
    const section = h.section("settings");
    inputOf(section, "maxStrikes").input("5");
    saveButton(section).click();
    await settle();
    expect(h.section("settings").walk().find((n) => n.classList.contains("cfg-readback"))!.style.display,
      "前置条件：保存之后回读行得先显示出来").toBe("");
    expect(fieldNode(section, "maxStrikes").classList.contains("changed"),
      "前置条件：保存之后那一格得先高亮").toBe(true);

    dangerButton(h, "resetConfig").click();
    await settle();
    h.dom.document.querySelectorAll(".modal")[0]!
      .querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const readback = h.section("settings").walk().find((n) => n.classList.contains("cfg-readback"))!;
    expect(readback.style.display,
      "重置之后回读行还挂着 —— 那句「1 个字段发生了变化」说的是上一次保存").toBe("none");
    expect(readback.textContent).toBe("");
    expect(fieldNode(h.section("settings"), "maxStrikes").classList.contains("changed"),
      "重置回执说一格都没变，屏幕上却还留着上一次保存的高亮").toBe(false);
    // 而危险区那句话必须走「一格都没变」那一档，不许照说「已经高亮出来」。
    const line = dangerCard(h).walk().find((n) => n.classList.contains("cfg-danger-result"))!;
    expect(line.textContent, "重置对这些字段什么都没做，屏幕上却说「真的变了的那几格已经高亮出来」")
      .toBe(say(h, "set.danger.reset.doneNone"));
  });

  /**
   * ⚠️⚠️ **「读不到当前配置」与「重置之后什么都不缺」是两件事。**
   * 复评实测：`GET /admin/api/config` 返回 500（⇒ `data = null`）之后点「重置配置」，
   * 弹窗逐字说「按逐字段判据看，重置之后这份配置仍然装载得起来」——**那句安心话背后
   * 一条数据都没有**；同一份弹窗里那句传播说明因为 `propagationView(null)` 直接消失。
   * 同一个作者在 `poolSizeOf()` 上对同一件事的裁定是「读不出来就 null，绝不伪造 0」。
   */
  it("读不到配置时点重置：弹窗说的是「判断不了」，传播那句话照旧在，而且不假装安全", async () => {
    const h = await openSettings((url: string) => {
      if (url.includes("/keys")) return ok({ items: [], total: 0, page: 1, size: 1, pages: 1 });
      if (url.includes("/config")) return { status: 500, body: { error: { message: "boom" } } };
      return ok({ protocols: [], models: [] });
    });
    dangerButton(h, "resetConfig").click();
    await settle();
    const modal = h.dom.document.querySelectorAll(".modal")[0];
    expect(modal, "重置配置没有二次确认").toBeDefined();
    expect(modal!.textContent, "读不到配置却照说「仍然装载得起来」—— 那句安心话背后一条数据都没有")
      .not.toContain(say(h, "set.danger.reset.effect.ok"));
    expect(modal!.textContent, "读不到配置时没有把「判断不了」说出来").toContain(say(h, "set.danger.reset.effect.unknown"));
    // 传播那句话**不许整条消失**：读不到的只是那个数（设计 §5.2 要的是「必须显示」）。
    expect(modal!.walk().some((n) => n.getAttribute("data-i18n") === "set.danger.reset.propagation.unknown"),
      "上界读不到时传播那句话整条消失了 —— 「不显示」不是设计 §5.2 的一档").toBe(true);

    // ⚠️ **按钮照旧能按下去，这是明写的取舍**：读不到的只是后果预览，而「配置装不起来」
    // 恰恰是运维最可能来按这颗按钮的时候。与「读不到池大小就不开确认框」不同——
    // 那边读不到的是确认动作**本身要用的基线**。
    modal!.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();
    expect(h.calls.some((c) => c.url.includes("/config/reset")),
      "读不到配置时把这条自救路径整个堵死了 —— 那时运维再没有别的出路").toBe(true);
  });
});
