import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import type { FakeElement } from "../../helpers/fake-dom.js";

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
async function openSettings(respond: (url: string) => Resp | Promise<Resp>) {
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
   * `gatewayToken` 那一支还要多一句「清完可能起不来」的红色警告。
   */
  it("清空凭据要二次确认，gatewayToken 那一支另有一句 fail-closed 警告", async () => {
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
  it("两张子卡的 DOM 顺序恒为 moemail、yyds（字母序），且字段完全同构", async () => {
    const h = await openSettings(() => ok(configBody()));
    const cards = h.section("settings").querySelectorAll(".channel-card");
    expect(cards.map((c) => c.getAttribute("data-channel"))).toEqual(["moemail", "yyds"]);
    const shapes = cards.map((c) => c.walk()
      .filter((n) => n.getAttribute("data-field") !== null)
      .map((n) => String(n.getAttribute("data-field")).split(".").pop()));
    expect(shapes[0], "两张子卡的字段不一样了 —— 「完全对称」当场破").toEqual(shapes[1]);
    expect(shapes[0]).toEqual(["baseUrl", "apiKey"]);
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
  it("后端返回的逐字段错误逐条渲染，并把那一格标红", async () => {
    const h = await openSettings((url) => {
      if (url.startsWith("/admin/api/config") && h.calls.some((c) => c.method === "PUT")) {
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
    const h = await openSettings((url) => {
      if (url.startsWith("/admin/api/config") && h.calls.some((c) => c.method === "PUT")) {
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
