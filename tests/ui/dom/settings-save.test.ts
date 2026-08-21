import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import type { FakeElement } from "../../helpers/fake-dom.js";
import { EDITABLE_FIELDS, SECRET_FIELDS } from "../../../src/core/admin/config-validate.js";

/**
 * 设置页的**行为**覆盖（P3c Task 7）。纯函数那一半在 `tests/ui/settings.test.ts` 的
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
    propagation: { configTtlMs: 30000, kvEdgeCacheMs: 60000, visibilityUpperBoundMs: 90000 },
    ...over,
  };
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

// ───────────────────────────────────────────────────────────────────────────
// 设计 §5.3：写操作的成功提示不得早于回读
// ───────────────────────────────────────────────────────────────────────────

describe("产品不变式：成功提示不得早于回读（设计 §5.3）", () => {
  /**
   * ⚠️⚠️ **变异 M4 的靶子：把成功提示挪到 `await 回读` 之前。**
   *
   * 判别力全部来自那把手动闸：`PUT` 的应答挂着不返回，于是「回读还没落定」这个
   * 状态在断言的那一刻**真的成立**。零延迟的替身下这一格对 M4 完全无感。
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
   * ⚠️ **变异 M11 的靶子：把 env 锁定的字段做成可编辑。**
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
    const h = await openSettings(() => ok(configBody()));
    const clear = fieldNode(h.section("settings"), "registrar.yyds.apiKey")
      .children.find((c) => c.classList.contains("cfg-clear"))!;
    expect(clear.disabled).toBe(true);
  });
});

describe("agnesPlatformUrl 折在高级区，且有自己的二次确认（设计 §8.6 第二行）", () => {
  /** **变异 M10 的靶子**（DOM 侧那一半）：把它挪回主表单。 */
  it("它在 details 折叠区里，不在三张卡的主表单里", async () => {
    const h = await openSettings(() => ok(configBody()));
    const section = h.section("settings");
    const node = fieldNode(section, "registrar.agnesPlatformUrl");
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
    const h = await openSettings(() => ok(configBody()));
    const section = h.section("settings");
    const advSave = section.querySelectorAll("button")
      .find((b) => b.getAttribute("data-i18n") === "set.advanced.save")!;
    inputOf(section, "registrar.agnesPlatformUrl").value = "https://evil.example.com";
    advSave.click();
    await settle();
    expect(h.dom.document.querySelectorAll(".modal").length, "改注册去向没有二次确认").toBe(1);
    expect(h.calls.some((c) => c.method === "PUT"), "还没确认就发出去了").toBe(false);
  });
});

describe("两条通道在设置页上完全对称（设计 §10.3 第 1/2/3 条）", () => {
  /**
   * ⚠️⚠️ **第一版这一格实测抓不住「把两张卡的字段整个对调」**（评审 I1，我复现属实：
   * MoeMail 卡里装 `registrar.yyds.*`、标签仍写 MoeMail ⇒ **557 条 UI 用例全绿**）。
   * 两个成因叠在一起：
   * ① 判据只比 `data-field` 的**最后一段**（`split(".").pop()`）⇒ **把通道那一段丢了**；
   * ② 夹具里两条通道的值**恰好全相等** ⇒ 渲染出来的内容也分不出彼此。
   *
   * **这是本任务第二个「夹具里两个本该不同的值恰好相等」的实例**（第一个是 M3 那格），
   * 而它偏偏是硬约束「两条通道完全平级」的名义守护者——我在报告里还替它背了书。
   *
   * ⇒ 判据改成**保留完整路径**，并给两条通道种**互不相同**的夹具值，
   * 连渲染出来的那一行也一起断言。
   */
  it("两张子卡的 DOM 顺序恒为 moemail、yyds（字母序），且每张卡装的是自己那条通道的字段", async () => {
    const h = await openSettings(() => ok(configBody({
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
    const cards = h.section("settings").querySelectorAll(".channel-card");
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
    const h = await openSettings(() => ok(configBody()));
    const select = inputOf(h.section("settings"), "registrar.primary");
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
// 评审 C2 的前端那一半：诊断态下表单必须还能用
// ───────────────────────────────────────────────────────────────────────────

/**
 * **诊断态下表单必须仍然可编辑——那是运维唯一的出路。**
 *
 * 装载不起来时后端把 `fields`/`credentials` 给 `null`（不编一份空配置），
 * 于是 `fieldView()` 对每一格都回 `present: false`。板块文件**不许**据此把输入框
 * 一律置灰：那会把「关掉注册机 / 把那把 key 填回去」这两条自救路径在 UI 上堵死，
 * 而后端明明放行。
 *
 * ⚠️⚠️ **这段说明订正过一次，订正的是史实而不是判据（复评 F5）。**
 * 原文写的是「第一版的 `renderOne` 据此**把所有输入框一律置灰**……前端跟不上
 * 等于白修」——**那是假史实**。按 `4048920` 原样核实：`renderOne` 那一支确实写着
 * `built.input.disabled = true`，但**紧接着**的 `setLock(built, false, null)` 里
 * 第一行是 `built.input.disabled = locked === true` ⇒ 把它抹回 `false`。
 * **诊断态下的表单从来没有被置灰过**，这一格当时就是绿的。
 *
 * **真正存在的缺陷是反过来那条**：`present === false` 那支的置灰**从落地那天起就
 * 没生效过**，于是「这一格单独没读到」也从来没灰过（下面那格「对照」正钉着它）。
 * 修法与这两格用例都是对的，错的只是动机叙述——而叙述会被下一个人当史实读。
 */
describe("装载不起来时的诊断视图（评审 C2 的前端那一半）", () => {
  /**
   * ⚠️ **`editable` / `secrets` 必须照给，那不是可有可无的装饰**：后端在诊断态下
   * **一定两份都给**（`configGetHandler` 里它们在 `snap` 之外、不受装载成败影响），
   * 而第一版夹具写的是两个空数组。**这是本任务第三个「夹具与真实契约偏离」的实例**
   *（前两个是 M3 的无冲突数据、I1 的两条通道取值全等），而这一族偏离的后果一律是
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
    // 下一次入口**（本任务已经栽过三次：M3 的无冲突数据、I1 的两条通道取值全等、
    // 以及这份夹具第一版的 `editable: []` / `secrets: []`）。
    secrets: [...SECRET_FIELDS],
    propagation: { configTtlMs: 30000, kvEdgeCacheMs: 60000, visibilityUpperBoundMs: 90000 },
  };

  /**
   * ⚠️⚠️ **F1：诊断态下保存，不许凭空替运维送一个他没动过的字段。**
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
    const h = await openSettings(() => ok(BLOCKED));
    const section = h.section("settings");
    // 只动那把 key（真的派发 input 事件，与运维敲键盘同一条路径）。
    inputOf(section, "registrar.yyds.apiKey").input("refilled-key-8888");
    saveButton(section).click();
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
    const h = await openSettings(() => ok(BLOCKED));
    const section = h.section("settings");
    const toggle = inputOf(section, "registrar.enabled");
    toggle.checked = true;
    toggle.change();
    const primary = inputOf(section, "registrar.primary");
    primary.value = "moemail";
    primary.change();
    inputOf(section, "registrar.moemail.apiKey").input("mk-1234");
    saveButton(section).click();
    await settle(10);

    const put = h.calls.find((c) => c.method === "PUT");
    const patch = (put!.body as { patch: Record<string, unknown> }).patch;
    expect(Object.keys(patch).sort()).toEqual([
      "registrar.enabled", "registrar.moemail.apiKey", "registrar.primary",
    ]);
    expect(patch["registrar.enabled"], "诊断态下把注册机打开这条路被堵死了").toBe(true);
  });

  it("横幅 + 逐条列出缺什么，并把那一格标红", async () => {
    const h = await openSettings(() => ok(BLOCKED));
    const section = h.section("settings");
    const banner = section.querySelectorAll(".cfg-blocked")[0]!;
    expect(banner.style.display, "装载不起来，面板却什么都没说").not.toBe("none");
    expect(banner.textContent).toContain("下一次重启");
    // 逐条那一行要说清是哪一格、缺什么。
    expect(banner.textContent).toContain("API Key");
    expect(banner.textContent).toContain("凭据");
    expect(fieldNode(section, "registrar.yyds.apiKey").classList.contains("invalid")).toBe(true);
  });

  /**
   * **变红条件**：把 `renderOne` 里那句 `built.input.disabled = !isDiagnostic(data);`
   * 改回无条件 `true`。
   */
  it("诊断态下表单仍然可编辑 —— 那是运维唯一的出路", async () => {
    const h = await openSettings(() => ok(BLOCKED));
    const section = h.section("settings");
    for (const path of ["registrar.enabled", "registrar.primary", "registrar.yyds.apiKey", "maxStrikes"]) {
      expect(
        inputOf(section, path).disabled,
        `${path} 在诊断态下被置灰了 —— 自救路径在 UI 上被堵死，而后端明明放行`,
      ).toBe(false);
    }
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
