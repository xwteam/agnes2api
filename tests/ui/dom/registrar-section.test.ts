import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { I18N } from "../../../admin-ui/js/i18n-dict.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * 注册机板块的**行为**覆盖（P3c Task 6）。纯函数那一半在 `tests/ui/registrar.test.ts` 的
 * 「第 3 条：通道顺序恒为 moemail, yyds（字母序，唯一可辩护的中立规则）」那一族；
 * 这里验的是「板块文件真的把那些判据接上了 DOM」——那一半没有任何纯函数测试
 * 能替代（Task 4 的 `errorMessage()` 就是这么逃逸的：退回不调用判据的老实现，
 * 566/566 仍然全绿）。
 *
 * **设计 §10.3 八条平级规则里，本文件正面钉住的是第 2 / 3 / 6 / 8 条**，
 * 外加「第 1 条那条纪律」在本任务唯一拥有的那个下拉上的落点。
 * 第 4 条是 CI 门禁（`scripts/check-i18n.mjs` 第 ⑥ 条）；第 5 条**没有任何变异
 * 抓得住**，如实登记为人工勾选项，它的下界在 `tests/ui/registrar.test.ts` 的
 * 「第 5 条的下界：地址事实那两句里不出现「开箱即用」这类偏好措辞……」那一格。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function statusBody(over: Record<string, unknown> = {}) {
  return {
    serverTime: NOW,
    enabled: true,
    primary: "yyds",
    fallback: "moemail",
    channels: {
      moemail: { configured: true, role: "fallback" },
      yyds: { configured: true, role: "primary" },
    },
    pool: { target: 20, counted: 18, gap: 2, fresh: 15, mintBatch: 5 },
    lockedUntil: null,
    manual: { used: 5, remaining: 19, perDay: 24, resetAt: NOW + 3_600_000, cooldownUntil: null, retryAfterMs: null },
    history: { entries: [], malformed: 0 },
    ...over,
  };
}

function round(over: Record<string, unknown> = {}) {
  return {
    skipped: false, available: 3, attempted: 2, minted: 2, mintedByChannel: { yyds: 2 },
    failures: [], at: NOW - 60_000, primaryChannel: "yyds", durationMs: 1200, trigger: "cron",
    ...over,
  };
}

/** 进壳层、切到注册机板块。`respond` 要自己处理 `/admin/api/registrar/status`。 */
async function openRegistrar(respond: (url: string) => { status: number; body: unknown }) {
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
  return h;
}

const ok = (body: unknown) => ({ status: 200, body });

/** 默认应答：status 给一份正常数据，其余一律空对象。 */
function defaultRespond(over: Record<string, unknown> = {}) {
  return (url: string) => (url.startsWith("/admin/api/registrar/status")
    ? ok(statusBody(over))
    : ok({}));
}

function byI18n(root: FakeElement, key: string): FakeElement | undefined {
  return root.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === key);
}

/** 空状态那一行。**它的可见性靠 `style.display`，`textContent` 问不出来。** */
function emptyPrimaryNode(section: FakeElement): FakeElement {
  const node = section.querySelectorAll("p").find((p) => p.getAttribute("data-i18n") === "reg.emptyPrimary");
  if (!node) throw new Error("找不到空状态那一行");
  return node;
}

function channelCard(section: FakeElement, channel: string): FakeElement {
  const card = section.querySelectorAll(`[data-channel="${channel}"]`)[0];
  if (!card) throw new Error(`找不到 ${channel} 那张通道卡`);
  return card;
}

/** 一棵子树里按标签名统计出现次数（第 2 条「同字段数、同控件类型」的量具）。 */
function tagShape(root: FakeElement): string[] {
  const out: string[] = [];
  const visit = (node: FakeElement) => {
    for (const child of node.children) {
      out.push(String(child.tagName).toLowerCase());
      visit(child);
    }
  };
  visit(root);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 设计 §10.3 第 2 / 3 条：两张通道卡完全对称、顺序恒为字母序
// ───────────────────────────────────────────────────────────────────────────

describe("设计 §10.3 第 2、3 条：两张通道卡", () => {
  /**
   * **第 2 条：同字段数、同控件类型。**
   *
   * 判据是**整棵子树的标签序列逐项相等**，不是「都有一颗按钮」——后者拦不住
   * 「一边多一行说明文字」，而那正是最容易发生的那种不对称（改文案的人只改了
   * 自己关心的那一条通道）。
   */
  it("两张通道卡同字段数、同控件类型、同顺序 —— 加一行说明就变红", async () => {
    const h = await openRegistrar(defaultRespond());
    const section = h.section("registrar");
    const moe = tagShape(channelCard(section, "moemail"));
    const yyds = tagShape(channelCard(section, "yyds"));
    expect(moe.length, "反向自检：卡里得真有点东西，否则下面那条恒绿").toBeGreaterThan(5);
    expect(moe, "两张通道卡的结构不一样了 —— 任何结构差异都会被读成排名").toEqual(yyds);
  });

  it("每张卡恰好一颗「测试连接」按钮 —— 一边两颗或一边零颗同样是不对称", async () => {
    const h = await openRegistrar(defaultRespond());
    const section = h.section("registrar");
    for (const channel of ["moemail", "yyds"]) {
      const buttons = channelCard(section, channel).querySelectorAll("button");
      expect(buttons.length, `${channel} 那张卡上的按钮数不对`).toBe(1);
      expect(buttons[0]!.getAttribute("data-i18n")).toBe("reg.channel.test");
    }
  });

  /**
   * **第 3 条：顺序固定为字母序（moemail, yyds）。**
   * 期望值手写，不从 `CHANNELS` 推导——从被测对象自己推导出来的期望值恒等于实际值。
   */
  it("两张卡在 DOM 里的先后恒为 moemail、yyds（字母序）", async () => {
    const h = await openRegistrar(defaultRespond());
    const section = h.section("registrar");
    const order = section.querySelectorAll("[data-channel]").map((c) => c.getAttribute("data-channel"));
    expect(order).toEqual(["moemail", "yyds"]);
  });

  it("后端把 channels 的键序换过来也不影响面板上的先后", async () => {
    const h = await openRegistrar(() => ok(statusBody({
      channels: {
        yyds: { configured: true, role: "primary" },
        moemail: { configured: true, role: "fallback" },
      },
    })));
    const section = h.section("registrar");
    expect(section.querySelectorAll("[data-channel]").map((c) => c.getAttribute("data-channel")))
      .toEqual(["moemail", "yyds"]);
  });

  it("两条通道的角色与凭据状态各归各的 —— 备通道不许被显示成主通道", async () => {
    const h = await openRegistrar(() => ok(statusBody({
      primary: "yyds", fallback: null,
      channels: { moemail: { configured: false, role: null }, yyds: { configured: true, role: "primary" } },
    })));
    const section = h.section("registrar");
    expect(channelCard(section, "yyds").textContent).toContain(I18N["reg.role.primary"]!["zh-CN"]!);
    expect(channelCard(section, "moemail").textContent).toContain(I18N["reg.role.unused"]!["zh-CN"]!);
    expect(channelCard(section, "moemail").textContent).toContain(I18N["reg.channel.credsNo"]!["zh-CN"]!);
    expect(channelCard(section, "yyds").textContent).toContain(I18N["reg.channel.credsYes"]!["zh-CN"]!);
  });

  /**
   * **第 5 条的结构性那一半**：两句地址事实**各出现在自己那张卡上**。
   * 「这句话是事实不是偏好」仍然只能靠人工勾选（见文件头）。
   */
  it("第 5 条：两句地址事实各在各的卡上，不许一张卡上有说明、另一张没有", async () => {
    const h = await openRegistrar(defaultRespond());
    const section = h.section("registrar");
    expect(channelCard(section, "moemail").textContent)
      .toContain(I18N["reg.channel.addressFact.moemail"]!["zh-CN"]!);
    expect(channelCard(section, "yyds").textContent)
      .toContain(I18N["reg.channel.addressFact.yyds"]!["zh-CN"]!);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 通道连通性测试（第 6 条：用数据代替推荐）
// ───────────────────────────────────────────────────────────────────────────

describe("通道连通性测试：两个等权的按钮，返回可用域名数 + 耗时", () => {
  it("点哪张卡就打哪条通道的端点，且显示的是那条通道的数据", async () => {
    const h = await openRegistrar((url) => {
      if (url.startsWith("/admin/api/registrar/channels/moemail/test")) {
        return ok({ ok: true, channel: "moemail", domains: 3, latencyMs: 42 });
      }
      if (url.startsWith("/admin/api/registrar/channels/yyds/test")) {
        return ok({ ok: true, channel: "yyds", domains: 7, latencyMs: 91 });
      }
      return ok(statusBody());
    });
    const section = h.section("registrar");

    byI18n(channelCard(section, "moemail"), "reg.channel.test")!.click();
    await settle();
    byI18n(channelCard(section, "yyds"), "reg.channel.test")!.click();
    await settle();

    const urls = h.calls.filter((c) => c.url.includes("/channels/")).map((c) => c.url);
    expect(urls).toEqual([
      "/admin/api/registrar/channels/moemail/test",
      "/admin/api/registrar/channels/yyds/test",
    ]);
    // **两张卡各自显示自己那条的数字**：把结果写到同一个节点上，或者把 moemail
    // 的结果显示到 yyds 卡上，只看「有没有发请求」是抓不住的。
    expect(channelCard(section, "moemail").textContent).toContain("3");
    expect(channelCard(section, "moemail").textContent).toContain("42");
    expect(channelCard(section, "yyds").textContent).toContain("7");
    expect(channelCard(section, "yyds").textContent).toContain("91");
  });

  it("在飞期间禁用自己那颗按钮，另一张卡的按钮不受影响", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
      respond: () => ok(statusBody()),
    });
    await settle();
    // 把通道测试那条应答挂起来，好让「在飞」这个状态在断言那一刻真的成立。
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/channels/")) {
        await gate;
        return new Response(JSON.stringify({ ok: true, channel: "moemail", domains: 1, latencyMs: 1 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(statusBody()), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "registrar")!.click();
    await settle();
    const section = h.section("registrar");

    const moeBtn = byI18n(channelCard(section, "moemail"), "reg.channel.test")!;
    const yydsBtn = byI18n(channelCard(section, "yyds"), "reg.channel.test")!;
    moeBtn.click();
    await settle();
    expect(moeBtn.disabled, "在飞期间没有禁用自己那颗按钮").toBe(true);
    expect(yydsBtn.disabled, "另一条通道的按钮被连带禁用了 —— 那也是一种不对称").toBe(false);

    release();
    await settle();
    expect(moeBtn.disabled, "跑完之后没有把按钮放回来").toBe(false);
  });

  it("后端拒绝（这条通道没配）时显示那条 reason 对应的话，不是一句通用失败", async () => {
    const h = await openRegistrar((url) => (url.includes("/channels/")
      ? { status: 409, body: { error: { type: "conflict", message: "x" }, reason: "channel_not_configured", channel: "moemail" } }
      : ok(statusBody())));
    const section = h.section("registrar");
    byI18n(channelCard(section, "moemail"), "reg.channel.test")!.click();
    await settle();
    expect(channelCard(section, "moemail").textContent)
      .toContain(I18N["reg.refuse.channel_not_configured"]!["zh-CN"]!);
    expect(
      channelCard(section, "moemail").textContent,
      "退回到通用文案了 —— 那等于把「这条通道没配」和「网络抽了」说成同一句话",
    ).not.toContain(I18N["reg.channel.testError"]!["zh-CN"]!);
  });

  it("上游不通（200 + ok:false）不走异常分支，显示的是「没有连上」而不是「请求失败」", async () => {
    const h = await openRegistrar((url) => (url.includes("/channels/")
      ? ok({ ok: false, channel: "yyds", reason: "upstream_error", latencyMs: 3000 })
      : ok(statusBody())));
    const section = h.section("registrar");
    byI18n(channelCard(section, "yyds"), "reg.channel.test")!.click();
    await settle();
    expect(channelCard(section, "yyds").textContent).toContain("3000");
    expect(channelCard(section, "yyds").textContent)
      .not.toContain(I18N["reg.channel.testError"]!["zh-CN"]!);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 「立即补池」：确认弹窗明示消耗 + 通道下拉不预选
// ───────────────────────────────────────────────────────────────────────────

describe("立即补池：设计 §10.2 第 3 条护栏（确认弹窗必须明示消耗）", () => {
  it("点按钮先弹确认，弹窗里带着「本次最多铸几把、消耗几个临时邮箱」，且没点确认前不发请求", async () => {
    const h = await openRegistrar(defaultRespond());
    const section = h.section("registrar");
    byI18n(section, "reg.tend.button")!.click();
    await settle();

    const text = h.dom.document.body.textContent;
    expect(text, "确认弹窗压根没出现").toContain(I18N["reg.tend.confirmTitle"]!["zh-CN"]!);
    // gap=2、mintBatch=5 ⇒ min(2,5)=2。**手写的 2**，不从响应体推导。
    expect(text, "弹窗没有明示本次的消耗").toContain("本次最多铸 2 把 key，将消耗最多 2 个临时邮箱");
    expect(
      h.calls.find((c) => c.url === "/admin/api/registrar/tend"),
      "没点确认就已经发起了补池",
    ).toBeUndefined();
  });

  it("读不到缺口时弹窗如实说「说不准」，不伪造一个 0", async () => {
    const h = await openRegistrar(() => ok(statusBody({ pool: null })));
    const section = h.section("registrar");
    byI18n(section, "reg.tend.button")!.click();
    await settle();
    expect(h.dom.document.body.textContent).toContain(I18N["reg.tend.confirmUnknown"]!["zh-CN"]!);
  });

  /**
   * ⚠️⚠️ **本任务唯一拥有的那个通道下拉上的「无默认选中」纪律。**
   *
   * 设计 §10.3 第 1 条说的是**设置页**的「主通道」下拉，而那条属于 config 写路径
   *（Task 7）。这一格钉的是同一条纪律在本任务这个下拉上的落点：
   * **初始选中的是占位符，两条通道都不预选。**
   */
  it("通道下拉初始是占位符，两条通道一条都不预选", async () => {
    const h = await openRegistrar(defaultRespond());
    const section = h.section("registrar");
    byI18n(section, "reg.tend.button")!.click();
    await settle();

    const select = h.dom.document.body.querySelectorAll("select")
      .find((s) => String(s.getAttribute("class") ?? "").includes("tend-channel"))!;
    expect(select, "确认弹窗里没有通道下拉").toBeDefined();
    expect(select.value, "有一条通道被预选了 —— 预选任何一条都会被读成排名").toBe("");

    const values = select.querySelectorAll("option").map((o) => o.getAttribute("value"));
    expect(values, "占位符在最前，两条通道按字母序跟在后面").toEqual(["", "moemail", "yyds"]);
  });

  it("确认之后按选中的通道发起：不选 ⇒ 不带 channel；选了 ⇒ 请求体里就是那一条", async () => {
    const h = await openRegistrar(defaultRespond());
    const section = h.section("registrar");

    byI18n(section, "reg.tend.button")!.click();
    await settle();
    byI18n(h.dom.document.body, "common.confirm")!.click();
    await settle();
    const first = h.calls.filter((c) => c.url === "/admin/api/registrar/tend");
    expect(first).toHaveLength(1);
    expect(first[0]!.body, "没选通道时不该往请求体里塞一条").toEqual({});

    byI18n(section, "reg.tend.button")!.click();
    await settle();
    const select = h.dom.document.body.querySelectorAll("select")
      .find((s) => String(s.getAttribute("class") ?? "").includes("tend-channel"))!;
    select.value = "moemail";
    byI18n(h.dom.document.body, "common.confirm")!.click();
    await settle();
    const all = h.calls.filter((c) => c.url === "/admin/api/registrar/tend");
    expect(all).toHaveLength(2);
    expect(all[1]!.body, "选了 MoeMail 却按主通道跑了 —— 只看状态码抓不住这一条").toEqual({ channel: "moemail" });
  });

  it("被拒时把那条 reason 的文案留在屏幕上（sticky），不是四秒一闪而过", async () => {
    const h = await openRegistrar((url) => (url === "/admin/api/registrar/tend"
      ? { status: 429, body: { error: { type: "rate_limit_error", message: "x" }, reason: "write_budget_exhausted", remaining: 0 } }
      : ok(statusBody())));
    const section = h.section("registrar");
    byI18n(section, "reg.tend.button")!.click();
    await settle();
    byI18n(h.dom.document.body, "common.confirm")!.click();
    await settle();

    const host = h.dom.byId("toast-host");
    expect(host.textContent).toContain(I18N["reg.refuse.write_budget_exhausted"]!["zh-CN"]!);
    expect(
      host.querySelectorAll(".toast-close").length,
      "「今天的额度用完了」这种四秒读不完的信息没有挂手动关闭按钮",
    ).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 名额 / 冷却 / 锁：绝对时刻与相对时长成对显示
// ───────────────────────────────────────────────────────────────────────────

describe("名额与冷却", () => {
  /**
   * ⚠️ **`remaining` 必须在点之前就显示出来。** 只在耗尽那一支说，等于让运维
   * 毫不知情地撞上一堵墙（后端 202 那一支也给 `remaining` 正是为了这个）。
   * 这里的 19/24 是手写字面量，与 `admin-registrar.test.ts` 那一格同源。
   */
  it("今天还剩几次在点之前就显示，且带着每天的上限", async () => {
    const h = await openRegistrar(defaultRespond());
    const text = h.section("registrar").textContent;
    expect(text, "只显示剩余次数、不显示上限，运维不知道 19 是多还是少").toContain("今天还可以点 19 次（每天上限 24 次）");
  });

  it("冷却中：绝对时刻与相对时长同时显示 —— 面板不拿本地时钟去减服务端时刻", async () => {
    const h = await openRegistrar(() => ok(statusBody({
      manual: {
        used: 6, remaining: 18, perDay: 24, resetAt: NOW + 3_600_000,
        cooldownUntil: NOW + 300_000, retryAfterMs: 300_000,
      },
    })));
    const text = h.section("registrar").textContent;
    expect(text, "缺相对时长 —— 那样面板只能自己拿本地时钟去减").toContain("还有 5分0秒");
    expect(text, "缺绝对时刻 —— 运维看不出「几点恢复」").toContain("之后可以再点");
  });

  it("不在冷却中时那一行整个不出现，不显示一个恒为 0 的倒计时", async () => {
    const h = await openRegistrar(defaultRespond());
    expect(h.section("registrar").textContent).not.toContain("冷却中");
  });

  it("有别的副本持着锁时如实说出来", async () => {
    const h = await openRegistrar(() => ok(statusBody({ lockedUntil: NOW + 120_000 })));
    expect(h.section("registrar").textContent).toContain("有一轮补池正在跑");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 设计 §10.3 第 8 条：空状态
// ───────────────────────────────────────────────────────────────────────────

describe("设计 §10.3 第 8 条：空状态文案", () => {
  it("注册机开着却没有主通道：说「两条通道平级，请选择一条」，不是「未选择时使用 X」", async () => {
    const h = await openRegistrar(() => ok(statusBody({
      primary: null, fallback: null,
      channels: { moemail: { configured: false, role: null }, yyds: { configured: false, role: null } },
    })));
    const section = h.section("registrar");
    expect(section.textContent).toContain(I18N["reg.emptyPrimary"]!["zh-CN"]!);
    expect(emptyPrimaryNode(section).style.display, "那句话在 DOM 里但被藏起来了").not.toBe("none");
  });

  /**
   * ⚠️ **判据是 `style.display`，不是 `textContent`。**
   * `tests/helpers/fake-dom.ts` 的 `textContent` 不理会 `display: none`
   *（真实浏览器的 `textContent` 同样不理会），拿它去问「这句话显示了没有」
   * 是量具用错了地方——第一版就是这么写的，那一格在两种取值下都红。
   */
  it("注册机整个关着时**不**显示那句空状态 —— 那时该说的是「已关闭」", async () => {
    const h = await openRegistrar(() => ok(statusBody({ enabled: false, primary: null, fallback: null })));
    const section = h.section("registrar");
    expect(section.textContent).toContain(I18N["reg.state.off"]!["zh-CN"]!);
    expect(
      emptyPrimaryNode(section).style.display,
      "关着的注册机不该催人去选主通道",
    ).toBe("none");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 补池历史
// ───────────────────────────────────────────────────────────────────────────

describe("补池历史", () => {
  it("空历史时说「还没有补池记录」，不渲染一张空表", async () => {
    const h = await openRegistrar(defaultRespond());
    expect(h.section("registrar").textContent).toContain(I18N["reg.history.empty"]!["zh-CN"]!);
    expect(h.section("registrar").querySelectorAll("table").length).toBe(0);
  });

  it("最新的一轮排在最前面", async () => {
    const h = await openRegistrar(() => ok(statusBody({
      history: {
        // 用 `minted` 区分两轮，**不用 `durationMs`**：`fmtDuration` 只到秒，
        // 111ms 与 222ms 都渲染成「0秒」——那样这一格永远绿。
        entries: [
          round({ at: NOW - 3000, attempted: 3, minted: 3, mintedByChannel: { yyds: 3 } }),
          round({ at: NOW - 1000, attempted: 7, minted: 7, mintedByChannel: { yyds: 7 } }),
        ],
        malformed: 0,
      },
    })));
    const rows = h.section("registrar").querySelectorAll("tr");
    // 第 0 行是表头。
    expect(rows[1]!.textContent, "最新的那一轮没有排在最前面").toContain("铸出 7 / 尝试 7");
    expect(rows[2]!.textContent).toContain("铸出 3 / 尝试 3");
  });

  it("整轮抛错的那一行说「一次尝试都没开始」并带上归因徽章，不与健康轮撞成同一句话", async () => {
    const h = await openRegistrar(() => ok(statusBody({
      history: {
        entries: [round({
          attempted: 0, minted: 0, mintedByChannel: {},
          failures: [{ reason: "round_crashed", channel: "yyds" }],
        })],
        malformed: 0,
      },
    })));
    const text = h.section("registrar").textContent;
    expect(text).toContain(I18N["reg.row.noAttempt"]!["zh-CN"]!);
    expect(text).toContain(I18N["reg.fail.round_crashed"]!["zh-CN"]!);
    expect(text, "崩掉的那一轮被渲染成了「池子已经够用」").not.toContain(I18N["reg.row.healthy"]!["zh-CN"]!);
  });

  /**
   * ⚠️⚠️ **这一格是「两条通道完全平级」在补池历史上的落点。**
   * 一轮**全靠备通道**铸出来时，功劳必须记在备通道名下——没有这一格，
   * 面板只能拿 `primaryChannel` 去顶，备通道的战绩会被持续记到主通道头上。
   */
  it("全靠备通道铸出来的那一轮，逐通道那一格记的是备通道", async () => {
    const h = await openRegistrar(() => ok(statusBody({
      history: { entries: [round({ primaryChannel: "yyds", minted: 2, mintedByChannel: { moemail: 2 } })], malformed: 0 },
    })));
    const text = h.section("registrar").textContent;
    expect(text, "逐通道那一格没渲染出来").toContain("moemail 2");
  });

  it("这个版本不认识的 reason 原样显示出来，不吞掉也不冒充已知归因", async () => {
    const h = await openRegistrar(() => ok(statusBody({
      history: {
        entries: [round({ attempted: 1, minted: 0, failures: [{ reason: "from_the_future", channel: "yyds" }] })],
        malformed: 0,
      },
    })));
    expect(h.section("registrar").textContent, "运维连这个 reason 叫什么都看不到").toContain("from_the_future");
  });

  it("后端报了 malformed 就如实显示出来，为 0 时不显示", async () => {
    const bad = await openRegistrar(() => ok(statusBody({ history: { entries: [], malformed: 3 } })));
    expect(bad.section("registrar").textContent).toContain("存储里有 3 条读不得的补池记录");

    const clean = await openRegistrar(defaultRespond());
    expect(clean.section("registrar").textContent).not.toContain("读不得的补池记录");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 接线：板块契约与配额纪律
// ───────────────────────────────────────────────────────────────────────────

describe("接线", () => {
  it("onShow 只打一次 /registrar/status，且**没有**自动刷新定时器", async () => {
    const timers: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setInterval", (...args: unknown[]) => {
      timers.push(Number(args[1]));
      return 0 as unknown as ReturnType<typeof setInterval>;
    });
    const h = await openRegistrar(defaultRespond());
    void realSetTimeout;
    const calls = h.calls.filter((c) => c.url.startsWith("/admin/api/registrar/status"));
    expect(calls, "切进板块时应当恰好拉一次状态").toHaveLength(1);
    expect(
      timers,
      "注册机板块起了轮询定时器 —— 它每刷新一次要付 3 次存储读，配额账把面板的读算成「人点一下才发生」",
    ).toEqual([]);
  });

  it("「刷新」按钮真的再拉一次", async () => {
    const h = await openRegistrar(defaultRespond());
    byI18n(h.section("registrar"), "common.refresh")!.click();
    await settle();
    expect(h.calls.filter((c) => c.url.startsWith("/admin/api/registrar/status"))).toHaveLength(2);
  });

  it("状态读失败时逐格显示 — ，不留着上一次的数据假装它是新的", async () => {
    const h = await openRegistrar(defaultRespond());
    expect(h.section("registrar").textContent).toContain("18");
    h.respond(() => ({ status: 500, body: { error: { type: "internal_error", message: "x" } } }));
    byI18n(h.section("registrar"), "common.refresh")!.click();
    await settle();
    const text = h.section("registrar").textContent;
    expect(text, "读失败了却还显示着上一次的数字").not.toContain("18");
    expect(text).toContain("—");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Key 池板块「添加 Key」菜单里的【自动注册】两项（P3c Task 6 接线）
// ───────────────────────────────────────────────────────────────────────────

describe("Key 池「添加 Key」菜单：【自动注册】两项接上了注册机端点", () => {
  async function openKeysMenu() {
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
      respond: (url) => (url.startsWith("/admin/api/registrar/status")
        ? ok(statusBody())
        : ok({ items: [], total: 0, page: 1, pages: 1, size: 20, counts: {}, approximate: true, generatedAt: NOW })),
    });
    await settle();
    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "keys")!.click();
    await settle();
    const section = h.section("keys");
    byI18n(section, "keys.addMenu.open")!.click();
    await settle();
    return { h, section };
  }

  it("两项都可点（不再是禁用占位符），且顺序恒为 MoeMail、YYDS", async () => {
    const { section } = await openKeysMenu();
    const items = section.querySelectorAll("[data-channel]");
    expect(items.map((b) => b.getAttribute("data-channel"))).toEqual(["moemail", "yyds"]);
    expect(items.every((b) => b.disabled === false), "两项还是禁用的占位符").toBe(true);
  });

  /**
   * ⚠️ **两项一律可点，不按「这条通道配没配」去禁用其中一条。**
   * 一条灰掉、一条能点在视觉上就是一次排名，而它依赖的是一份可能已经过期的
   * 配置快照。没配好的那条由后端当场回 `409 channel_not_configured`。
   */
  it("即使某条通道没配凭据，两项在结构上仍然完全平级（差别只在点下去之后）", async () => {
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
      respond: (url) => (url.startsWith("/admin/api/registrar/status")
        ? ok(statusBody({ channels: { moemail: { configured: false, role: null }, yyds: { configured: true, role: "primary" } } }))
        : ok({ items: [], total: 0, page: 1, pages: 1, size: 20, counts: {}, approximate: true, generatedAt: NOW })),
    });
    await settle();
    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "keys")!.click();
    await settle();
    byI18n(h.section("keys"), "keys.addMenu.open")!.click();
    await settle();
    const items = h.section("keys").querySelectorAll("[data-channel]");
    expect(items.every((b) => b.disabled === false), "按配置灰掉了其中一条 —— 那是一次排名").toBe(true);
  });

  it("点【自动注册】里的一项：先弹同一个确认弹窗（明示消耗），确认后按那条通道发起", async () => {
    const { h, section } = await openKeysMenu();
    section.querySelectorAll("[data-channel]").find((b) => b.getAttribute("data-channel") === "yyds")!.click();
    await settle();

    const text = h.dom.document.body.textContent;
    expect(text, "菜单里那条入口绕过了「明示消耗」这条护栏").toContain(I18N["reg.tend.confirmTitle"]!["zh-CN"]!);
    expect(text).toContain("本次最多铸 2 把 key");
    expect(h.calls.find((c) => c.url === "/admin/api/registrar/tend"), "没点确认就发起了").toBeUndefined();

    byI18n(h.dom.document.body, "common.confirm")!.click();
    await settle();
    const tend = h.calls.filter((c) => c.url === "/admin/api/registrar/tend");
    expect(tend).toHaveLength(1);
    expect(tend[0]!.body, "菜单上选的是 YYDS，发出去的却不是它").toEqual({ channel: "yyds" });
  });

  it("菜单那条入口的确认弹窗里**没有**通道下拉 —— 通道已经在菜单上选定了", async () => {
    const { h, section } = await openKeysMenu();
    section.querySelectorAll("[data-channel]").find((b) => b.getAttribute("data-channel") === "moemail")!.click();
    await settle();
    const selects = h.dom.document.body.querySelectorAll("select")
      .filter((s) => String(s.getAttribute("class") ?? "").includes("tend-channel"));
    expect(selects, "选定通道之后还给一个下拉，等于让人有机会选到另一条").toHaveLength(0);
    expect(h.dom.document.body.textContent).toContain(I18N["reg.channel.moemail"]!["zh-CN"]!);
  });

  /**
   * ⚠️ **「点菜单外面收起它」本任务没有做，如实登记而不是假装它已经有了。**
   * 它要求点击从被点元素冒泡到 `document`，而 `tests/helpers/fake-dom.ts` 的
   * `dispatchEvent` **刻意不冒泡**，任何写法在这套 DOM 用例里都跑不到。
   * 这里保留一格反向自检：**今天 Escape 那条路是真的在工作**，
   * 别让「另一条路没做」被误读成「这个菜单关不掉」。
   */
  it("Escape 关菜单这条路是通的（「点外面关掉」本任务没做，见 sec-keys.js 里的登记）", async () => {
    const { section } = await openKeysMenu();
    const menu = section.querySelectorAll(".dropdown-menu")[0]!;
    expect(menu.style.display, "前置条件：菜单此刻是展开的").not.toBe("none");

    section.querySelectorAll(".dropdown")[0]!.keydown("Escape");
    expect(menu.style.display, "Escape 也关不掉这个菜单").toBe("none");
  });

  it("点菜单**里面**的项不会在 onClick 之前先把菜单关掉导致这一下丢掉", async () => {
    const { h, section } = await openKeysMenu();
    section.querySelectorAll("[data-channel]").find((b) => b.getAttribute("data-channel") === "yyds")!.click();
    await settle();
    // 点中的那一项必须真的把弹窗打开了——判据建在「这一下有没有生效」上，
    // 而不是「菜单关没关」（菜单关掉是这一项自己做的，是对的）。
    expect(h.dom.document.body.textContent).toContain(I18N["reg.tend.confirmTitle"]!["zh-CN"]!);
  });
});
