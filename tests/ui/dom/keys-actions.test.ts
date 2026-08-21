import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { I18N } from "../../../admin-ui/js/i18n-dict.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **DOM 垫片扩到 Key 池板块（P3b 待办第 9 条的 sec-keys 那一半）+ P3c Task 4
 * 写操作的行为覆盖。**
 *
 * Key 池板块在这一组出现之前是 `admin-ui/js/*.js` 里唯一还没有 DOM 行为覆盖的
 * 板块——sec-overview 与 sec-events 两个板块都已经有各自的 DOM 用例组
 * （分别是 overview-cards.test.ts 与 events-poll.test.ts），唯独 `sec-keys.js`
 * 此前只有纯函数层面的覆盖（`tests/ui/keys.test.ts`），没有任何东西验证板块
 * 文件真的把那些判据接上了 DOM。本文件把简报点名的四条交接（must_disable_first
 * 两种形状 / note 走 textContent / 导入原样按行发 / reset 不是
 * duplicated.length）与两条强制变异（M1 删除按钮判据、M2 全选边界）落到行为
 * 断言上。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 一份"正常"的 KeyView，各条用例在它上面改一处。 */
function keyView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "id-default", masked: "sk-de…fault", seq: 1, bucket: "fresh",
    addedAt: NOW - 10_000, lastUsedAt: null, cooldownUntil: 0,
    cooldownReason: null, evictedReason: null, strikes: 0,
    disabled: false, evicted: false, note: null,
    stats: { requests: 0, success: 0, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null },
    ...overrides,
  };
}

function listBody(items: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    items, total: items.length, page: 1, pages: 1, size: 20,
    counts: { all: items.length, fresh: 0, cooling: 0, evicted: 0, disabled: 0 },
    approximate: true, generatedAt: NOW,
    ...overrides,
  };
}

/** 进壳层、切到 Key 池板块。`respond` 必须自己处理 `/admin/api/keys`（含 query）
 *  与 `/admin/api/overview` 两条路径——`onShow()` 会把两个都打一遍。 */
async function openKeys(respond: (url: string) => { status: number; body: unknown }) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    respond,
  });
  await settle();
  h.dom.document.querySelectorAll(".nav-item")
    .find((b) => b.getAttribute("data-section") === "keys")!
    .click();
  await settle();
  return h;
}

/** 在 Key 池板块里按 `data-key-id` 找到那一行的某个按钮（按 data-i18n 找）。 */
function rowButton(section: FakeElement, id: string, i18nKey: string): FakeElement {
  const row = section.querySelectorAll(`[data-key-id="${id}"]`)[0];
  if (!row) throw new Error(`找不到 id=${id} 的行`);
  const btn = row.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === i18nKey);
  if (!btn) throw new Error(`id=${id} 那一行找不到按钮 ${i18nKey}`);
  return btn;
}

/** toast-host 里当前的全部提示文本，按出现顺序。 */
function toastTexts(h: Awaited<ReturnType<typeof openKeys>>): string[] {
  return h.dom.byId("toast-host").querySelectorAll("div").map((d) => d.textContent);
}

/**
 * 打开导入弹窗：先点「添加 Key」触发下拉，再点【手动】组里的「批量导入」项——
 * 两个手动入口（粘贴单个 / 批量导入）复用同一个弹窗，见 `sec-keys.js` 的
 * `buildAddKeyMenu()` 说明。
 */
async function openImportModal(section: FakeElement): Promise<void> {
  section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.addMenu.open")!.click();
  await settle();
  section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.addMenu.bulkImport")!.click();
  await settle();
}

// ───────────────────────────────────────────────────────────────────────────
// M1：删除按钮的可用性 —— 判据必须同时看 disabled 与 evicted
// ───────────────────────────────────────────────────────────────────────────

describe("M1：删除按钮只看 evicted 是一个会咬人的错误判据", () => {
  /**
   * ⚠️ **两格缺一都测不出「只看 evicted」这个变异**：只给两条都 true 或两条都
   * false 的夹具，谁赢都能通过（本仓第 1 种假阳性）。`disabled=true,evicted=false`
   * 与 `disabled=false,evicted=true` 各占一格，外加两条都 false（应当禁用）
   * 与两条都 true（应当可用）两格反向自检。
   */
  it("四种 disabled/evicted 组合下删除按钮的可用性", async () => {
    const items = [
      keyView({ id: "both-false", disabled: false, evicted: false, bucket: "fresh" }),
      keyView({ id: "disabled-only", disabled: true, evicted: false, bucket: "disabled" }),
      keyView({ id: "evicted-only", disabled: false, evicted: true, bucket: "evicted" }),
      keyView({ id: "both-true", disabled: true, evicted: true, bucket: "disabled" }),
    ];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const section = h.section("keys");

    expect(rowButton(section, "both-false", "keys.action.delete").disabled, "两条都不成立却能删").toBe(true);
    expect(
      rowButton(section, "disabled-only", "keys.action.delete").disabled,
      "只看 evicted 的判据会在这一格判错：只停用没被剔除的 key 必须能删",
    ).toBe(false);
    expect(
      rowButton(section, "evicted-only", "keys.action.delete").disabled,
      "只被剔除没手动停用的 key 必须能删",
    ).toBe(false);
    expect(rowButton(section, "both-true", "keys.action.delete").disabled, "两条都成立却删不掉").toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// M2：全选只选当前页
// ───────────────────────────────────────────────────────────────────────────

describe("M2：全选只能选中当前页，不是全部筛选结果", () => {
  it("一页 20 条、总数 300：点全选之后已选数是 20，不是 300", async () => {
    const items = Array.from({ length: 20 }, (_, i) => keyView({ id: `k${i}`, seq: i + 1 }));
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items, { total: 300, pages: 15 }) }
      : { status: 200, body: {} }));
    const section = h.section("keys");

    const headerBox = section.querySelectorAll('input[type="checkbox"]')[0]!;
    headerBox.checked = true;
    headerBox.change();
    await settle();

    const bar = section.querySelectorAll(".bulk-bar")[0]!;
    const countText = bar.querySelectorAll("span")[0]!.textContent;
    expect(countText, "全选之后已选数不是 20（很可能选进了看不见的行）").toBe(
      I18N["keys.bulk.selectedCount"]!["zh-CN"]!.replace("{count}", "20"),
    );
    expect(countText).not.toContain("300");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 评审必改①：简报点名的四个行内/批量动作，原来全部"可以被改坏而不变红"。
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ **这一组是评审探针实测出来的一等公民缺口**：本文件此前对这四个动作
 * 只测了"按钮存不存在、可用性对不对"，从没断言过**点击之后到底发了什么**。
 * 评审实测四种变异全部逃逸：
 *   · 停用/启用发 `{ disabled: v.disabled }`（开关变成空操作）；
 *   · 清冷却/解除剔除两颗按钮的可用性判据对调；
 *   · 「批量停用」按钮实际发 `op: "clearCooldown"`；
 *   · 备注保存发裸 `textarea.value`，绕过 `noteToPatch` 的"清空⇒null"。
 * 唯一有请求体断言的是后来单独追加的 `clearStrikes`——原因很直接：追加它时
 * 专门为它写了一格测试，而原本就在清单里的这四个只做了 UI、没做请求体断言。
 * 下面逐条补齐，全部照抄 `clearStrikes` 那格的做法：`h.calls.find(c => c.method
 * === "PATCH" / "POST")` 断言真正发出去的请求体。
 */
describe("评审必改①：四个行内/批量动作都必须有请求体断言，不能只测按钮渲染", () => {
  it("停用/启用：请求体必须是当前状态取反，不许原样发一遍（开关变成空操作的变异）", async () => {
    const items = [keyView({ id: "toggle-me", disabled: false })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/toggle-me")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");

    rowButton(section, "toggle-me", "keys.action.disable").click();
    await settle();

    const call = h.calls.find((c) => c.method === "PATCH" && c.url === "/admin/api/keys/toggle-me");
    expect(call, "停用按钮没有真的发出 PATCH").toBeDefined();
    expect(
      (call?.body as { disabled: boolean })?.disabled,
      "请求体里的 disabled 应该是 true（当前状态取反），原样发 false 就是把开关点成了空操作",
    ).toBe(true);
  });

  /**
   * ⚠️⚠️ **复评点名的镜像缺口**：上一格只测了"未停用 → 点击 → 发 true"这一个方向，
   * `patchAction(v.id, { disabled: true })`（把取反写死成常量 `true`，不管当前状态）
   * 这种变异在只有上一格的情况下是绿的——夹具恰好停在 `disabled: false`，写死 `true`
   * 与真的取反在这一格看起来一样。这里补对称的另一半：已停用的 key 点同一颗按钮
   * （这时按钮文案是「启用」），请求体必须是 `disabled: false`，写死 `true` 在这一格
   * 会红。两格合起来才拦得住"取反"被换成"写死常量"。
   */
  it("启用：请求体必须是当前状态取反（false），不许写死成 true", async () => {
    const items = [keyView({ id: "toggle-me-2", disabled: true, bucket: "disabled" })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/toggle-me-2")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");

    rowButton(section, "toggle-me-2", "keys.action.enable").click();
    await settle();

    const call = h.calls.find((c) => c.method === "PATCH" && c.url === "/admin/api/keys/toggle-me-2");
    expect(call, "启用按钮没有真的发出 PATCH").toBeDefined();
    expect(
      (call?.body as { disabled: boolean })?.disabled,
      "请求体里的 disabled 应该是 false（当前状态取反），写死发 true 就不是真的取反",
    ).toBe(false);
  });

  /**
   * **同一个夹具里放两把 key，两颗按钮的可用性与点击后的请求体都断到**——
   * 只测一颗按钮"可用/禁用对不对"抓不住"两颗按钮的判据被整体对调"这种变异
   * （两颗都测、都测反了，形状断言照样全绿；这里额外验证点击后确实发对了
   * 字段名，把"判据对调"与"点击发错请求体"两种变异都堵上）。
   */
  it("清冷却 / 解除剔除：两颗按钮的可用性判据不能对调，点击后请求体字段名要对上", async () => {
    const items = [
      keyView({ id: "cooling-only", bucket: "cooling", cooldownUntil: NOW + 60_000, evicted: false }),
      keyView({ id: "evicted-only", bucket: "evicted", cooldownUntil: 0, evicted: true }),
    ];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/cooling-only")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/admin/api/keys/evicted-only")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");

    expect(rowButton(section, "cooling-only", "keys.action.clearCooldown").disabled, "冷却中的 key，清冷却按钮应该可用").toBe(false);
    expect(rowButton(section, "cooling-only", "keys.action.unevict").disabled, "没被剔除的 key，解除剔除按钮应该禁用——判据对调会让这里可用").toBe(true);
    expect(rowButton(section, "evicted-only", "keys.action.clearCooldown").disabled, "没在冷却的 key，清冷却按钮应该禁用——判据对调会让这里可用").toBe(true);
    expect(rowButton(section, "evicted-only", "keys.action.unevict").disabled, "被剔除的 key，解除剔除按钮应该可用").toBe(false);

    rowButton(section, "cooling-only", "keys.action.clearCooldown").click();
    await settle();
    const clearCall = h.calls.find((c) => c.method === "PATCH" && c.url === "/admin/api/keys/cooling-only");
    expect((clearCall?.body as { clearCooldown?: boolean })?.clearCooldown, "点了清冷却，请求体却不是 clearCooldown:true").toBe(true);

    rowButton(section, "evicted-only", "keys.action.unevict").click();
    await settle();
    const unevictCall = h.calls.find((c) => c.method === "PATCH" && c.url === "/admin/api/keys/evicted-only");
    expect((unevictCall?.body as { unevict?: boolean })?.unevict, "点了解除剔除，请求体却不是 unevict:true").toBe(true);
  });

  /**
   * ⚠️⚠️ **复评点名的数据丢失级缺口**：这一格原来只勾一行、一共也只有一行
   * （`items` 只放了一把 key），`ids` 是不是"只发被勾中的那些"与"发了当前页
   * 全部 id"在这种夹具下**看起来一样**——两种取法算出来的都是长度为 1 的数组。
   * 现在改成 3 行只勾 1 行：`runBulkWithConfirm` 里 `const ids = [...selected]`
   * 若被换成 `[...currentPageIds]`（当前页全部 id），这里会送出 3 个 id 而不是
   * 1 个，断言会红。原来"只测 op 字段"的写法对这条变异完全没有判别力——
   * op 字段两种取法都不影响，只有 ids 数组的内容能拦住它。
   */
  it("批量停用：op 必须是 disable，ids 必须只含被勾中的那一行，不是当前页全部", async () => {
    const items = [
      keyView({ id: "bulk-op-a" }),
      keyView({ id: "bulk-op-a-sibling-1", seq: 2 }),
      keyView({ id: "bulk-op-a-sibling-2", seq: 3 }),
    ];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/bulk")) {
        return { status: 200, body: { results: [{ id: "bulk-op-a", ok: true, reason: null }] } };
      }
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    // ⚠️ **只勾第一行的行内选择框，不是表头「全选本页」那颗**——`querySelectorAll`
    // 按 DOM 先后顺序返回，表头的全选框排在最前面（index 0），行选择框从 index 1
    // 起。这里特意按 `data-key-id` 定位到具体那一行，避免像上面注释里描述的
    // 那样，误点成表头全选、把 3 行全选中却只看起来像 1 行。
    const box = section.querySelectorAll('[data-key-id="bulk-op-a"]')[0]!.querySelectorAll('input[type="checkbox"]')[0]!;
    box.checked = true;
    box.change();
    await settle();

    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.bulk.disable")!.click();
    await settle();
    const call = h.calls.find((c) => c.url.startsWith("/admin/api/keys/bulk"));
    expect((call?.body as { op?: string })?.op, "点的是「批量停用」，op 却不是 disable").toBe("disable");
    expect(
      (call?.body as { ids?: string[] })?.ids,
      "只勾了 1 行却送出了不止 1 个 id——很可能把当前页全部 id 都发了出去，这是数据丢失级的缺陷",
    ).toEqual(["bulk-op-a"]);
  });

  it("批量清冷却：op 必须是 clearCooldown，ids 必须只含被勾中的那一行，不是当前页全部", async () => {
    const items = [
      keyView({ id: "bulk-op-b" }),
      keyView({ id: "bulk-op-b-sibling-1", seq: 2 }),
      keyView({ id: "bulk-op-b-sibling-2", seq: 3 }),
    ];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/bulk")) {
        return { status: 200, body: { results: [{ id: "bulk-op-b", ok: true, reason: null }] } };
      }
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    // 同上一格：定位到具体行的选择框，不是表头全选框。
    const box = section.querySelectorAll('[data-key-id="bulk-op-b"]')[0]!.querySelectorAll('input[type="checkbox"]')[0]!;
    box.checked = true;
    box.change();
    await settle();

    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.bulk.clearCooldown")!.click();
    await settle();
    const call = h.calls.find((c) => c.url.startsWith("/admin/api/keys/bulk"));
    expect((call?.body as { op?: string })?.op, "点的是「批量清冷却」，op 却不是 clearCooldown").toBe("clearCooldown");
    expect(
      (call?.body as { ids?: string[] })?.ids,
      "只勾了 1 行却送出了不止 1 个 id——很可能把当前页全部 id 都发了出去，这是数据丢失级的缺陷",
    ).toEqual(["bulk-op-b"]);
  });

  /**
   * 「批量删除」需要确认弹窗，`ids` 是在**打开确认弹窗时**就已经从 `selected`
   * 复制定死的（`runBulkWithConfirm` 里 `const ids = [...selected]` 在弹窗打开
   * 之前就跑了），点确定之后送出的必须仍然是那份定死的 1 个 id，不是确认框
   * 弹出期间又被重新算了一遍、混进别的行。
   */
  it("批量删除：确认之后 ids 仍然只含点击时被勾中的那一行", async () => {
    const items = [
      keyView({ id: "bulk-op-c", disabled: true, bucket: "disabled" }),
      keyView({ id: "bulk-op-c-sibling-1", seq: 2, disabled: true, bucket: "disabled" }),
      keyView({ id: "bulk-op-c-sibling-2", seq: 3, disabled: true, bucket: "disabled" }),
    ];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/bulk")) {
        return { status: 200, body: { results: [{ id: "bulk-op-c", ok: true, reason: null }] } };
      }
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    // 同上：定位到具体行的选择框，不是表头全选框。
    const box = section.querySelectorAll('[data-key-id="bulk-op-c"]')[0]!.querySelectorAll('input[type="checkbox"]')[0]!;
    box.checked = true;
    box.change();
    await settle();

    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.bulk.delete")!.click();
    await settle();
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const call = h.calls.find((c) => c.url.startsWith("/admin/api/keys/bulk"));
    expect((call?.body as { op?: string })?.op).toBe("delete");
    expect(
      (call?.body as { ids?: string[] })?.ids,
      "只勾了 1 行、走完确认弹窗之后，送出的 ids 却不止 1 个",
    ).toEqual(["bulk-op-c"]);
  });

  it("备注保存：清空文本框必须发 note: null，不许绕过 noteToPatch 发裸的空字符串", async () => {
    const items = [keyView({ id: "note-target", note: "旧备注" })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/note-target")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    rowButton(section, "note-target", "keys.action.note").click();
    await settle();

    const textarea = h.dom.document.querySelectorAll("textarea")[0]!;
    textarea.value = "";
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.note.save")!.click();
    await settle();

    const call = h.calls.find((c) => c.method === "PATCH" && c.url === "/admin/api/keys/note-target");
    expect(
      call?.body,
      "清空文本框却发了裸的空字符串——绕过了 noteToPatch 的「清空⇒null」规则",
    ).toEqual({ note: null });
  });

  /**
   * ⚠️⚠️ **复评点名的镜像缺口**：上一格只测了"清空文本框 ⇒ 发 null"这个罕见方向
   * （`noteToPatch("")` 恒返回 `null` 这条变异，只有上一格的话，把 `noteToPatch`
   * 整个换成"恒返回 null，不管传进来什么"照样是绿的——上一格的输入本来就是空
   * 字符串，看不出这条变异）。这里补常见方向：文本框里是**真实内容**时，请求体
   * 必须原样带着那段文字，不是被"恒 null"的变异吃掉。
   */
  it("备注保存：有实际内容时必须原样发那段文字，不许被「恒发 null」的变异吃掉", async () => {
    const items = [keyView({ id: "note-target-2", note: "旧备注" })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/note-target-2")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    rowButton(section, "note-target-2", "keys.action.note").click();
    await settle();

    const textarea = h.dom.document.querySelectorAll("textarea")[0]!;
    textarea.value = "换了下游客户，价格更新";
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.note.save")!.click();
    await settle();

    const call = h.calls.find((c) => c.method === "PATCH" && c.url === "/admin/api/keys/note-target-2");
    expect(
      call?.body,
      "文本框里明明有实际内容，请求体却不是那段文字——很可能被「清空⇒null」的判据误吞了",
    ).toEqual({ note: "换了下游客户，价格更新" });
  });

  /**
   * ⚠️⚠️ **复评点名的错误归因，这里订正**：这一格原来用的是「批量删除」——但
   * `bulkNeedsConfirm("delete")` 恒真，点击「批量删除」只会打开一个确认弹窗，
   * 这一格从没点确认按钮，所以"没有发出请求"这件事实际上是**确认弹窗没被确认**
   * 挡住的，跟 `runBulkWithConfirm` 里 `ids.length === 0` 那条早退守卫毫无关系——
   * 把守卫整个删掉（甚至让它在 `ids` 非空时也照样直接 `return`），只要点的是
   * 「批量删除」，这一格照样绿，因为确认弹窗根本没打开过、`common.confirm`
   * 从来没被点过。换成「批量清冷却」——`bulkNeedsConfirm("clearCooldown")` 恒假，
   * 点击后**没有中间弹窗**，唯一能拦住请求的就是那条 `ids.length === 0` 早退，
   * 这样才是真的在测这条守卫本身。
   */
  it("批量条一把都没选中时点击批量清冷却：不发任何请求（真正覆盖 ids.length===0 早退）", async () => {
    const items = [keyView({ id: "unselected" })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const before = h.calls.length;
    // 批量条本来就因为没有选中项而隐藏，但按钮仍然存在于 DOM 里——
    // 直接找到它触发点击，验证守卫本身，不依赖 CSS 可见性。
    const bar = h.section("keys").querySelectorAll(".bulk-bar")[0]!;
    bar.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.bulk.clearCooldown")!.click();
    await settle();
    expect(h.calls.length, "空选择时点击批量清冷却仍然发出了请求").toBe(before);
    // 反向自检：确认弹窗确实没有被打开过——排除"守卫其实没生效、只是被
    // 一个意外弹出的确认框挡住了"这种可能。
    expect(
      h.dom.document.body.querySelectorAll('[role="dialog"]').length,
      "批量清冷却不该需要确认弹窗——如果这里非零，说明测的其实是弹窗而不是守卫本身",
    ).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2(a)：must_disable_first 的两种形状 —— 批量路径 200 + 逐项 reason
// ───────────────────────────────────────────────────────────────────────────

describe("2(a)：批量删除 20 把、3 把被拒 —— 前端必须显示出来，不能只说「全部成功」", () => {
  it("HTTP 200 但 3 把因 must_disable_first 被拒：提示文案必须带出这个数字", async () => {
    const items = Array.from({ length: 20 }, (_, i) => keyView({
      id: `bk${i}`, seq: i + 1, disabled: true, bucket: "disabled",
    }));
    const results = [
      ...Array.from({ length: 17 }, (_, i) => ({ id: `bk${i}`, ok: true, reason: null })),
      { id: "bk17", ok: false, reason: "must_disable_first" },
      { id: "bk18", ok: false, reason: "must_disable_first" },
      { id: "bk19", ok: false, reason: "must_disable_first" },
    ];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/bulk")) return { status: 200, body: { results } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");

    section.querySelectorAll('input[type="checkbox"]')[0]!.checked = true;
    section.querySelectorAll('input[type="checkbox"]')[0]!.change();
    await settle();

    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.bulk.delete")!.click();
    await settle();
    // 批量删除需要确认——弹窗按钮挂在 document.body 上，不在 section 子树里。
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const bulkCall = h.calls.find((c) => c.url.startsWith("/admin/api/keys/bulk"));
    expect(bulkCall?.method, "批量删除没有真的发出 POST /keys/bulk").toBe("POST");
    expect((bulkCall?.body as { op: string })?.op).toBe("delete");

    const texts = toastTexts(h);
    expect(texts.length, "批量操作完成之后没有任何提示，运维会以为什么都没发生").toBeGreaterThan(0);
    const combined = texts.join(" | ");
    expect(
      combined,
      "20 把里有 3 把被拒，但提示文案里完全看不到这个数字（拿状态码当唯一判据的典型后果）",
    ).toContain(I18N["keys.bulk.mustDisableFirstSuffix"]!["zh-CN"]!.replace("{mustDisableFirst}", "3"));
    // 反向：不许显示成"全部成功"。
    expect(combined, "3 把被拒，却显示成了全部成功").not.toContain(I18N["keys.bulk.allOk"]!["zh-CN"]);
    expect(combined).toContain(I18N["keys.bulk.partial"]!["zh-CN"]);
  });
});

/**
 * **顾虑 4 的裁定落地**：批量部分失败这条信息必须手动关闭，不许 4 秒自动消失。
 * `js/ui.js` 的 `toast()` 现在支持 `opts.sticky`——sticky 时不排 `setTimeout`、
 * 改挂一颗 `.toast-close` 按钮；这一组直接断言 DOM 结构上的这个差异，
 * 不去跟真实的 4 秒计时器打交道（那是"要不要等"的问题，不是"对不对"的问题）。
 */
describe("顾虑 4：批量部分失败的提示必须手动关闭，全部成功的提示仍然自动消失", () => {
  async function openWithBulkResults(results: Array<{ id: string; ok: boolean; reason: string | null }>) {
    const items = results.map((r, i) => keyView({ id: r.id, seq: i + 1, disabled: true, bucket: "disabled" }));
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/bulk")) return { status: 200, body: { results } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    section.querySelectorAll('input[type="checkbox"]')[0]!.checked = true;
    section.querySelectorAll('input[type="checkbox"]')[0]!.change();
    await settle();
    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.bulk.delete")!.click();
    await settle();
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();
    return h;
  }

  it("2 把里 1 把被拒：提示带一颗手动关闭按钮，且不会被 setTimeout 自动清掉", async () => {
    const setTimeoutCalls: number[] = [];
    const realSetTimeout = setTimeout;
    vi.stubGlobal("setTimeout", (fn: () => void, ms: number) => {
      setTimeoutCalls.push(ms);
      return realSetTimeout(fn, ms);
    });

    const h = await openWithBulkResults([
      { id: "a", ok: true, reason: null },
      { id: "b", ok: false, reason: "must_disable_first" },
    ]);

    const closeButtons = h.dom.byId("toast-host").querySelectorAll(".toast-close");
    expect(closeButtons.length, "部分失败的提示没有挂手动关闭按钮，会在 4 秒后自动消失").toBe(1);
    expect(
      setTimeoutCalls,
      "sticky 的 toast 不该排一个 4000ms 的自动移除计时器",
    ).not.toContain(4000);

    // 点一下关闭按钮，提示真的会消失（不是挂了个装饰性的按钮）。
    closeButtons[0]!.click();
    expect(h.dom.byId("toast-host").querySelectorAll(".toast-close").length).toBe(0);
  });

  it("全部成功：提示仍然是普通的、会自动消失的那种，没有手动关闭按钮", async () => {
    const setTimeoutCalls: number[] = [];
    const realSetTimeout = setTimeout;
    vi.stubGlobal("setTimeout", (fn: () => void, ms: number) => {
      setTimeoutCalls.push(ms);
      return realSetTimeout(fn, ms);
    });

    const h = await openWithBulkResults([
      { id: "a", ok: true, reason: null },
      { id: "b", ok: true, reason: null },
    ]);

    expect(
      h.dom.byId("toast-host").querySelectorAll(".toast-close").length,
      "全部成功不该出现手动关闭按钮——不需要留痕的信息没必要多一次点击",
    ).toBe(0);
    expect(setTimeoutCalls, "全部成功的提示必须照常排 4 秒自动移除").toContain(4000);
  });
});

describe("2(a) 的另一半：单条 DELETE 是 409 + 顶层 reason", () => {
  it("单条删除撞上 must_disable_first：提示的是那句专门文案，不是通用错误", async () => {
    const items = [keyView({ id: "solo", disabled: true, bucket: "disabled" })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/solo")) {
        return { status: 409, body: { error: { type: "conflict", message: "x" }, reason: "must_disable_first" } };
      }
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");

    rowButton(section, "solo", "keys.action.delete").click();
    await settle();
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const del = h.calls.find((c) => c.url === "/admin/api/keys/solo" && c.method === "DELETE");
    expect(del, "删除请求没有真的发出去").toBeDefined();

    const combined = toastTexts(h).join(" | ");
    expect(combined, "409 must_disable_first 没有被识别成那句专门文案").toContain(
      I18N["keys.mustDisableFirst"]!["zh-CN"]!,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2(b)：note 走 textContent，不走 innerHTML
// ───────────────────────────────────────────────────────────────────────────

describe("2(b)：备注是第一个「运维自由输入又投影回面板」的字段，必须走 textContent", () => {
  /**
   * FakeElement **压根没有实现 `innerHTML`**——`cell.innerHTML = x` 只是给对象挂了
   * 一个不影响 `.textContent` / `.children` 的普通属性，不会让内容出现在
   * `.textContent` 里。所以这一格的判别力恰好反过来：**真走 textContent 的实现
   * 会让含 `<img ...>` 的原始字符串原样出现在 `.textContent` 里；换成 innerHTML
   * 的实现在这个夹具下 `.textContent` 会是空的**——两种实现在这里的行为截然不同，
   * 不需要一个真的 HTML 解析器就能分辨。
   */
  it("备注含 <img onerror=…> 时原样以纯文本出现，不会被当成标记解析", async () => {
    const payload = '<img src=x onerror="window.__pwned=1">';
    const items = [keyView({ id: "noted", note: payload })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const section = h.section("keys");

    const row = section.querySelectorAll('[data-key-id="noted"]')[0]!;
    expect(row.textContent, "备注没有以纯文本原样出现——很可能被当成 innerHTML 处理了、内容整个消失").toContain(payload);
  });

  /**
   * ⚠️⚠️ **评审抓到的假阳性，已订正**：第一版断的是 `row.textContent`——但同一行
   * 的冷却列 / 最后使用列在这份夹具下**同样**渲染 `—`，把备注格清空成空字符串
   * 照样绿（判据看的是「这一行里有没有 —」，不是「备注格是不是 —」）。现在直接
   * 取备注那一个 `<td>`（第 11 列，索引 10——按渲染顺序依次是 select / # / key /
   * 状态 / 加入时间 / 最后使用 / 冷却剩余 / 连续失败 / 请求数 / 最近错误 / 备注 /
   * 操作），断言精确到那一格。
   */
  it("备注为 null 时那一格显示 —，不是空字符串或字面 null", async () => {
    const items = [keyView({ id: "blank", note: null })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const row = h.section("keys").querySelectorAll('[data-key-id="blank"]')[0]!;
    const cells = row.querySelectorAll("td");
    const noteCell = cells[10]!;
    expect(noteCell.textContent, "备注格没有渲染出 —").toBe("—");
    expect(noteCell.textContent).not.toContain("null");
  });

  /**
   * 反向自检（与上面那格互相印证）：**有真实备注时那一格必须是那段文字，
   * 不是恒为 —**。少了这一格，"备注格恒显示 —" 这种实现也会让上面那格通过。
   */
  it("反向自检：备注有内容时那一格显示的是内容，不是恒为 —", async () => {
    const items = [keyView({ id: "has-note", note: "换了下游客户" })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const row = h.section("keys").querySelectorAll('[data-key-id="has-note"]')[0]!;
    const noteCell = row.querySelectorAll("td")[10]!;
    expect(noteCell.textContent).toBe("换了下游客户");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2(c)：导入框原样按行发，空行也发
// ───────────────────────────────────────────────────────────────────────────

describe("2(c)：导入框必须原样按行发给后端 —— 位置=行号的口径由前端负责不破坏", () => {
  it("文本框内容按行拆开、含空行，原样进请求体的 keys 数组", async () => {
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody([]) }
      : { status: 200, body: {} }));
    const section = h.section("keys");

    await openImportModal(section);

    const textarea = h.dom.document.querySelectorAll("textarea")[0]!;
    // 第 1 行好 key、第 2 行空行、第 3 行好 key、第 4 行是末尾换行留下的空元素。
    textarea.value = "sk-line-one-good-key\n\nsk-line-three-good\n";

    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.import.submit")!.click();
    await settle();

    const call = h.calls.find((c) => c.method === "POST" && c.url === "/admin/api/keys");
    expect(call, "导入请求没有真的发出去").toBeDefined();
    expect(
      (call?.body as { keys: string[] })?.keys,
      "空行被过滤掉了，或者整段被 trim 了 —— 后端报回来的行号会因此错位",
    ).toEqual(["sk-line-one-good-key", "", "sk-line-three-good", ""]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2(d)：reset 不是 duplicated.length
// ───────────────────────────────────────────────────────────────────────────

describe("2(d)：导入结果里「重置了几把」显示的是 reset，不是 duplicated.length", () => {
  it("duplicated=4、reset=1：提示文案里出现的必须是 1", async () => {
    const h = await openKeys((url) => {
      if (url === "/admin/api/keys") return { status: 200, body: {} };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody([]) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    await openImportModal(section);
    const textarea = h.dom.document.querySelectorAll("textarea")[0]!;
    textarea.value = "sk-whatever-the-user-typed";

    h.respond((url) => (url === "/admin/api/keys" && !url.includes("?")
      ? { status: 200, body: { added: ["x"], duplicated: ["a", "b", "c", "d"], invalid: [], reset: 1 } }
      : url.startsWith("/admin/api/keys?")
        ? { status: 200, body: listBody([]) }
        : { status: 200, body: {} }));
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.import.submit")!.click();
    await settle();

    const combined = toastTexts(h).join(" | ");
    expect(combined, "reset 被算成了 duplicated.length（4），这正是简报点名的撒谎方式").toContain("其中 1 把已重置状态");
    expect(combined, "reset 与 duplicated.length 不该混同：这一格必须能证明取到的是 1 不是 4").not.toContain("其中 4 把已重置状态");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// M4：keys.freshness 由 kvEdgeCacheMs 驱动，不是硬编码 60 秒
// ───────────────────────────────────────────────────────────────────────────

describe("M4：keys.freshness 的 KV 边缘缓存耗时由响应驱动", () => {
  it("kvEdgeCacheMs=45000 时新鲜度提示显示 45秒，不是硬编码的 60秒", async () => {
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/overview")) {
        return {
          status: 200,
          body: {
            freshness: {
              poolCacheTtlMs: 60_000, poolVisibilityUpperBoundMs: 120_000,
              poolTouchIntervalMs: 21_600_000, configTtlMs: 30_000,
              configVisibilityUpperBoundMs: 90_000, kvEdgeCacheMs: 45_000,
            },
          },
        };
      }
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody([]) };
      return { status: 200, body: {} };
    });
    await settle();

    const notes = h.section("keys").querySelectorAll(".note");
    const freshnessText = notes[notes.length - 1]!.textContent;
    expect(freshnessText, "边缘缓存耗时没有显示出 45秒 —— 很可能仍然是硬编码的默认值").toContain("45秒");
    expect(freshnessText, "仍然硬编码着旧的默认值 60秒").not.toContain("60秒");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// M6：offsetMs 三份合一之后，改一份的变异应当"改不动"（单一真源）
// ───────────────────────────────────────────────────────────────────────────

describe("M6：本地时区偏移只有一份实现（admin-ui/js/pure/overview.mjs）", () => {
  const SOURCE_OF_TRUTH = "admin-ui/js/pure/overview.mjs";

  function walk(dir: string): string[] {
    return readdirSync(dir).sort().flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(js|mjs)$/.test(p) ? [p] : [];
    });
  }

  it("getTimezoneOffset 只在 pure/overview.mjs 里出现一次，别处一律 import offsetMs", () => {
    const offenders: string[] = [];
    for (const p of walk("admin-ui")) {
      const rel = p.split("\\").join("/");
      if (rel === SOURCE_OF_TRUTH) continue;
      if (readFileSync(p, "utf8").includes("getTimezoneOffset")) offenders.push(rel);
    }
    expect(
      offenders,
      "offsetMs 被重新实现了第二份——待办第 8 条要求三个板块共用同一份，改其中一份不该再是可能的",
    ).toEqual([]);
  });

  it("五个板块文件都从 pure/overview.mjs import offsetMs（反向自检：单一真源真的被用到了）", () => {
    // P3c Task 6 加了第四个板块（注册机），它同样要渲染服务端时刻（补池历史的
    // 时间列、冷却到期、名额重置）。**清单手写**：新板块忘了列进来时这一格不会红，
    // 但上面那条「getTimezoneOffset 只在 pure/overview.mjs 里出现一次」会——
    // 两条合起来才既挡住"另写一份"、又挡住"这份没被用到"。
    // P3d Task 5 加了第五个（用量）：它渲染服务端回读的覆盖区间，同一份偏移。
    // ⚠️ `sec-settings.js` **不在这张清单里，而那是对的**：它一个服务端时刻都不渲染
    //（`fmtDuration` 渲染的是时长，不是时刻），所以它压根不 import 这个模块。
    // 这张清单数的是「真的要渲染时刻的板块」，不是「板块文件总数」。
    for (const f of ["admin-ui/js/sec-keys.js", "admin-ui/js/sec-overview.js",
      "admin-ui/js/sec-events.js", "admin-ui/js/sec-registrar.js",
      "admin-ui/js/sec-usage.js"]) {
      const src = readFileSync(f, "utf8");
      const m = /import\s*\{([^}]*)\}\s*from\s*"\.\/pure\/overview\.mjs"/.exec(src);
      expect(m, `${f} 没有从 pure/overview.mjs import`).not.toBeNull();
      const named = m![1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim());
      expect(named, `${f} 没有拿 offsetMs`).toContain("offsetMs");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 顾虑 1 的裁定落地：「清连续失败」——设计 §10.2 有、后端已支持，简报动作
// 清单第一版漏列，控制端追加要求补上。
// ───────────────────────────────────────────────────────────────────────────

describe("清连续失败：按钮可用性 + 确认文案必须把它与「清冷却」的区别说清楚", () => {
  it("strikes > 0 时按钮可用，strikes === 0 时禁用", async () => {
    const items = [
      keyView({ id: "has-strikes", strikes: 3 }),
      keyView({ id: "no-strikes", strikes: 0 }),
    ];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const section = h.section("keys");

    expect(rowButton(section, "has-strikes", "keys.action.clearStrikes").disabled).toBe(false);
    expect(rowButton(section, "no-strikes", "keys.action.clearStrikes").disabled, "strikes 是 0，点了什么都不会变，按钮不该可用").toBe(true);
  });

  it("点击之后先弹确认，文案必须点名「清冷却」与它的区别，不是一句空泛的「确定吗」", async () => {
    const items = [keyView({ id: "strikey", strikes: 5 })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/strikey")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");

    rowButton(section, "strikey", "keys.action.clearStrikes").click();
    await settle();

    const dialogText = h.dom.document.body.textContent;
    expect(dialogText, "确认弹窗压根没有出现——点一下就直接发请求，等于没有确认").toContain(
      I18N["keys.clearStrikesConfirmTitle"]!["zh-CN"]!,
    );
    expect(
      dialogText,
      "确认文案没有点名「清冷却」——运维会分不清点的是这两个动作里的哪一个",
    ).toContain("清冷却");
    expect(dialogText).toContain(I18N["keys.clearStrikesConfirmMsg"]!["zh-CN"]!);

    // 点确定之前不该发任何写请求。
    expect(h.calls.find((c) => c.method === "PATCH"), "没点确认就已经发出了 PATCH").toBeUndefined();

    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const patchCall = h.calls.find((c) => c.method === "PATCH" && c.url === "/admin/api/keys/strikey");
    expect(patchCall, "确认之后没有真的发出 PATCH").toBeDefined();
    expect((patchCall?.body as { clearStrikes: boolean })?.clearStrikes).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 裁定：「添加 Key」分组下拉容器现在就建，先填【手动】两项，【自动注册】占位禁用
// ───────────────────────────────────────────────────────────────────────────

describe("裁定：添加 Key 分组下拉——容器与两组平级结构现在定死", () => {
  it("菜单默认收起，点触发按钮才展开；两组各自的项都在", async () => {
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody([]) }
      : { status: 200, body: {} }));
    const section = h.section("keys");
    const trigger = section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.addMenu.open")!;
    const menu = section.querySelectorAll(".dropdown-menu")[0]!;

    expect(menu.style.display, "菜单默认应该是收起的").toBe("none");
    trigger.click();
    expect(menu.style.display, "点了触发按钮，菜单应该展开").not.toBe("none");

    const itemKeys = menu.querySelectorAll("button").map((b) => b.getAttribute("data-i18n"));
    expect(itemKeys, "自动注册组的两项不见了").toEqual(expect.arrayContaining([
      "keys.addMenu.autoMoemail", "keys.addMenu.autoYyds",
    ]));
    expect(itemKeys, "手动组的两项不见了").toEqual(expect.arrayContaining([
      "keys.addMenu.pasteSingle", "keys.addMenu.bulkImport",
    ]));
  });

  /**
   * ⚠️⚠️ **这一格在 P3c Task 6 换了守的东西，如实登记换的是什么。**
   *
   * Task 4 时它守的是「两项是**禁用的占位符**，点了不会发请求」——那是当时的
   * 正确形态（后端那条端点还没有 `channel` 参数）。Task 6 把两项真的接上了，
   * 那条断言随之失效。**换掉它的时候不许让它退化成一格什么都不验的形状**，
   * 所以现在守的是接上之后仍然必须成立的那两件事：
   * ① **两项在结构上完全平级**——除了通道名与那一条 i18n 键，属性形状逐字相同
   *   （设计 §10.3「两条邮箱通道完全平级」的结构性表达）；
   * ② **点下去不会直接发起补池**——它必须先弹确认弹窗（设计 §10.2 第 3 条护栏：
   *   确认弹窗必须明示消耗）。这一条与 Task 4 那条断言的观测点其实是同一个
   *   （「点完之后有没有发出请求」），只是理由从"还没接线"换成了"要先确认"。
   *
   * 「确认之后真的按那条通道发起」由 `tests/ui/dom/registrar-section.test.ts` 的
   * 「点【自动注册】里的一项：先弹同一个确认弹窗（明示消耗），确认后按那条通道发起」
   * 守着——那一格才是接线的正面证明，这一格是它的补集（点了但没确认时的行为）。
   */
  it("自动注册两项结构上完全平级，且点下去先弹确认、不直接发起补池", async () => {
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody([]) }
      : { status: 200, body: {} }));
    const section = h.section("keys");
    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.addMenu.open")!.click();

    const moemail = section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.addMenu.autoMoemail")!;
    const yyds = section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.addMenu.autoYyds")!;

    // ① 平级：**属性名集合逐字相同**，两者都不许被禁用。只断言「都没被禁用」
    // 拦不住「一边多挂了个 title 说它更省事」这类不对称。
    const attrsOf = (b: FakeElement) => [...b.attrs.keys()].sort();
    expect(attrsOf(moemail), "两项的属性形状不一样了 —— 任何结构差异都会被读成排名")
      .toEqual(attrsOf(yyds));
    expect([moemail.disabled, yyds.disabled], "两项里有一项被禁用了").toEqual([false, false]);
    expect(moemail.getAttribute("data-channel")).toBe("moemail");
    expect(yyds.getAttribute("data-channel")).toBe("yyds");

    // ② 点下去先弹确认，**没确认之前一次补池请求都不许发出去**。
    const tendCallsBefore = h.calls.filter((c) => c.url === "/admin/api/registrar/tend").length;
    yyds.click();
    await settle();
    expect(
      h.dom.document.body.textContent,
      "点了却没有弹确认 —— 那绕过了「确认弹窗必须明示消耗」这条护栏",
    ).toContain(I18N["reg.tend.confirmTitle"]!["zh-CN"]!);
    expect(
      h.calls.filter((c) => c.url === "/admin/api/registrar/tend").length,
      "没点确认就已经发起了一轮真实补池",
    ).toBe(tendCallsBefore);
  });

  it("手动组「粘贴单个 Key」与「批量导入」都能打开同一个导入弹窗", async () => {
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody([]) }
      : { status: 200, body: {} }));
    const section = h.section("keys");
    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.addMenu.open")!.click();
    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.addMenu.pasteSingle")!.click();
    await settle();

    const dialogTitle = h.dom.document.body.textContent;
    expect(dialogTitle, "「粘贴单个 Key」没有打开导入弹窗").toContain(I18N["keys.import.title"]!["zh-CN"]!);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 评审应改⑤：openModal 焦点管理
// ───────────────────────────────────────────────────────────────────────────

describe("评审应改⑤：openModal 补齐焦点管理——初始焦点、Tab 陷阱、Escape、aria-labelledby", () => {
  it("弹窗打开时焦点落在弹窗容器本身，不是停在触发它的那颗按钮上", async () => {
    const items = [keyView({ id: "solo-focus", disabled: true, bucket: "disabled" })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const section = h.section("keys");

    rowButton(section, "solo-focus", "keys.action.delete").click();
    await settle();

    const dialog = h.dom.document.body.querySelectorAll('[role="dialog"]')[0]!;
    expect(
      h.dom.document.activeElement,
      "打开弹窗之后焦点没有落在弹窗容器上——键盘用户下一次 Tab 仍然停在背后的页面里",
    ).toBe(dialog);
  });

  it("<h2> 与 role=dialog 容器之间有 aria-labelledby 关联，读屏器能报出弹窗标题", async () => {
    const items = [keyView({ id: "solo-aria", disabled: true, bucket: "disabled" })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const section = h.section("keys");
    rowButton(section, "solo-aria", "keys.action.delete").click();
    await settle();

    const dialog = h.dom.document.body.querySelectorAll('[role="dialog"]')[0]!;
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy, "role=dialog 的容器没有 aria-labelledby").not.toBeNull();
    const heading = dialog.querySelectorAll("h2")[0]!;
    expect(heading.getAttribute("id"), "<h2> 的 id 与 aria-labelledby 对不上").toBe(labelledBy);
  });

  it("Escape 直接关闭弹窗，不跑任何 onClick（等同取消）", async () => {
    const items = [keyView({ id: "solo-esc", disabled: true, bucket: "disabled" })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const section = h.section("keys");
    rowButton(section, "solo-esc", "keys.action.delete").click();
    await settle();
    expect(h.dom.document.body.querySelectorAll('[role="dialog"]').length, "前置条件：弹窗真的开着").toBe(1);

    const dialog = h.dom.document.body.querySelectorAll('[role="dialog"]')[0]!;
    dialog.keydown("Escape");
    await settle();

    expect(h.dom.document.body.querySelectorAll('[role="dialog"]').length, "Escape 没有关掉弹窗").toBe(0);
    expect(h.calls.find((c) => c.method === "DELETE"), "Escape 不该等同确认——不许真的发出删除请求").toBeUndefined();
  });

  /**
   * **焦点陷阱**：Tab 到弹窗内最后一个可聚焦元素之后再按 Tab，焦点必须回到
   * 第一个，不许跳出弹窗去够背后的表格。这里用「确认删除」弹窗（固定两颗按钮：
   * 取消 / 确定）验证，边界最简单、不依赖弹窗内容有几个输入框。
   */
  it("Tab 焦点陷阱：从最后一个可聚焦元素再 Tab，回到第一个，不跳出弹窗", async () => {
    const items = [keyView({ id: "solo-trap", disabled: true, bucket: "disabled" })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const section = h.section("keys");
    rowButton(section, "solo-trap", "keys.action.delete").click();
    await settle();

    const dialog = h.dom.document.body.querySelectorAll('[role="dialog"]')[0]!;
    const buttons = dialog.querySelectorAll("button"); // [取消, 确定]
    const last = buttons[buttons.length - 1]!;
    last.focus();
    dialog.keydown("Tab");
    expect(
      h.dom.document.activeElement,
      "在最后一个可聚焦元素上按 Tab，焦点应该回到第一个，而不是跳出弹窗",
    ).toBe(buttons[0]);

    // 反向：在第一个元素上 Shift+Tab，应该绕到最后一个。
    buttons[0]!.focus();
    dialog.keydown("Tab", { shiftKey: true });
    expect(h.dom.document.activeElement, "Shift+Tab 在第一个元素上应该绕到最后一个").toBe(last);
  });
});

/**
 * **评审应改⑤连带的真缺陷**：`openModal` 原来无条件先关弹窗再跑 `onClick`，
 * 导入弹窗校验失败/网络失败时粘进去的最多 200 行原文全部丢失。`keepOpen`
 * 修完之后，这一组验证两种失败路径都不再丢内容。
 */
describe("评审应改⑤连带的真缺陷：导入弹窗失败时不许把粘进去的内容丢掉", () => {
  it("空提交（校验失败）：弹窗留在原地，不是悄悄关掉", async () => {
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody([]) }
      : { status: 200, body: {} }));
    const section = h.section("keys");
    await openImportModal(section);
    expect(h.dom.document.body.querySelectorAll('[role="dialog"]').length, "前置条件：弹窗已经打开").toBe(1);

    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.import.submit")!.click();
    await settle();

    expect(
      h.dom.document.body.querySelectorAll('[role="dialog"]').length,
      "空提交校验失败，弹窗却被关掉了——粘进去的内容会丢",
    ).toBe(1);
  });

  it("网络/后端失败：弹窗留在原地，文本框内容原样还在", async () => {
    const h = await openKeys((url) => {
      if (url === "/admin/api/keys") return { status: 500, body: { error: { message: "boom" } } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody([]) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    await openImportModal(section);

    const textarea = h.dom.document.querySelectorAll("textarea")[0]!;
    const PASTED = "sk-two-hundred-lines-worth-of-effort";
    textarea.value = PASTED;
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.import.submit")!.click();
    await settle();

    expect(
      h.dom.document.body.querySelectorAll('[role="dialog"]').length,
      "请求失败，弹窗却被关掉了——粘进去的内容会丢，运维只剩一句 toast",
    ).toBe(1);
    expect(
      h.dom.document.querySelectorAll("textarea")[0]!.value,
      "弹窗虽然没关，但文本框内容不是原来那份了",
    ).toBe(PASTED);
  });

  it("反向自检：真正成功之后弹窗确实会关掉，不是从此再也关不掉", async () => {
    const h = await openKeys((url) => {
      if (url === "/admin/api/keys") return { status: 200, body: { added: ["x"], duplicated: [], invalid: [], reset: 0 } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody([]) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    await openImportModal(section);
    const textarea = h.dom.document.querySelectorAll("textarea")[0]!;
    textarea.value = "sk-this-one-should-succeed";
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.import.submit")!.click();
    await settle();

    expect(
      h.dom.document.body.querySelectorAll('[role="dialog"]').length,
      "真正成功之后弹窗应该关掉",
    ).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 评审应改④：sticky toast 的关闭按钮拿到初始焦点，不是整页最后一个 Tab 停靠点
// ───────────────────────────────────────────────────────────────────────────

describe("评审应改④：sticky toast 出现时关闭按钮直接拿到焦点", () => {
  it("批量部分失败的 sticky toast 出现后，关闭按钮就是当前焦点", async () => {
    const items = Array.from({ length: 2 }, (_, i) => keyView({ id: `focus-bulk-${i}`, seq: i + 1 }));
    const results = [
      { id: "focus-bulk-0", ok: true, reason: null },
      { id: "focus-bulk-1", ok: false, reason: "must_disable_first" },
    ];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/bulk")) return { status: 200, body: { results } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    const box = section.querySelectorAll('input[type="checkbox"]')[0]!;
    box.checked = true;
    box.change();
    await settle();
    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.bulk.delete")!.click();
    await settle();
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    const closeBtn = h.dom.byId("toast-host").querySelectorAll(".toast-close")[0]!;
    expect(
      h.dom.document.activeElement,
      "sticky toast 出现之后关闭按钮没有拿到焦点——键盘用户还是要 Tab 过一整页才够得到它",
    ).toBe(closeBtn);
  });

  it("关闭按钮上按 Escape 也能关掉 sticky toast，不必只靠鼠标点 ×", async () => {
    const items = Array.from({ length: 2 }, (_, i) => keyView({ id: `esc-toast-${i}`, seq: i + 1 }));
    const results = [
      { id: "esc-toast-0", ok: true, reason: null },
      { id: "esc-toast-1", ok: false, reason: "must_disable_first" },
    ];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/bulk")) return { status: 200, body: { results } };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    const box = section.querySelectorAll('input[type="checkbox"]')[0]!;
    box.checked = true;
    box.change();
    await settle();
    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.bulk.delete")!.click();
    await settle();
    h.dom.document.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.confirm")!.click();
    await settle();

    expect(h.dom.byId("toast-host").querySelectorAll(".toast-close").length, "前置条件：sticky toast 真的出现了").toBe(1);
    const closeBtn = h.dom.byId("toast-host").querySelectorAll(".toast-close")[0]!;
    closeBtn.keydown("Escape");

    expect(
      h.dom.byId("toast-host").querySelectorAll(".toast-close").length,
      "在关闭按钮上按 Escape 没有关掉 sticky toast",
    ).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 复评必改②：errorMessage() 真的调用了 isOpaqueErrorMessage()，不是只有纯函数
// 自己的 8 格单测在守着一个从未被板块文件接线的判据
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ **复评实测：`sec-keys.js` 的 `errorMessage()` 退回成评审①订正之前的
 * 老实现（`raw === "" ? t(...) : raw`，不调用 `isOpaqueErrorMessage()`）之后，
 * 566/566 全绿**——`isOpaqueErrorMessage()` 自己在 `tests/ui/keys-write.test.ts`
 * 里的 8 格单测测的是那个纯函数本身对不对，从没有任何一格 DOM 用例真的走一遍
 * "板块文件确实调用了它"这条接线。这里补一格：让某个写操作拿到一个
 * `error.message` 缺失的 500（`js/api.js` 会把它落成 `"http_500"` 这个内部码），
 * 断言面板上出现的是通用文案 `keys.writeFailed`，屏幕上**绝不能**出现裸的
 * `http_500`——这格红的时候，红的必须是接线本身，不是纯函数的判据。
 */
describe("复评必改②：写操作失败时 errorMessage() 必须真的调用 isOpaqueErrorMessage()", () => {
  it("PATCH 500 且响应体没有 error.message：toast 显示通用文案，绝不出现裸的 http_500", async () => {
    const items = [keyView({ id: "opaque-500" })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/opaque-500")) return { status: 500, body: {} };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    rowButton(section, "opaque-500", "keys.action.disable").click();
    await settle();

    const combined = toastTexts(h).join(" | ");
    expect(
      combined,
      "500 且没有 error.message 时，屏幕上出现了裸的内部码 http_500——errorMessage() 没有真的调用 isOpaqueErrorMessage()",
    ).not.toContain("http_500");
    expect(
      combined,
      "500 且没有 error.message 时，应该显示 keys.writeFailed 这句通用文案",
    ).toContain(I18N["keys.writeFailed"]!["zh-CN"]!);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 复评强烈建议⑤：runBulk() 的 catch 分支（整批请求本身失败）同样必须 sticky
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ **复评实测：`runBulk()` 的 `catch` 分支 `toast(errorMessage(e), "err",
 * { sticky: true })` 里的 `{ sticky: true }` 删掉、退回普通 4 秒 toast，
 * 全部测试仍然绿**——「顾虑 4」那一组只测了"200 但响应体里 `results` 部分失败"
 * 这一条路径的 sticky，没有任何一格测过"请求本身就没打成"（网络中断 / 500）
 * 这条路径。这两条路径在 `sec-keys.js` 的文件头被明确点名为"同一类不看见就会
 * 误判的信息"，只测了其中一条。这里补另一条：让 `/keys/bulk` 直接 500，
 * 断言 toast 同样带 `.toast-close` 按钮、同样不排 4000ms 的自动移除计时器。
 */
describe("复评强烈建议⑤：批量请求本身失败（catch 分支）同样是 sticky，不是普通 4 秒 toast", () => {
  it("POST /keys/bulk 直接 500：提示带手动关闭按钮，且不排 4000ms 自动移除", async () => {
    const setTimeoutCalls: number[] = [];
    const realSetTimeout = setTimeout;
    vi.stubGlobal("setTimeout", (fn: () => void, ms: number) => {
      setTimeoutCalls.push(ms);
      return realSetTimeout(fn, ms);
    });

    const items = [keyView({ id: "bulk-catch-fail" })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys/bulk")) return { status: 500, body: {} };
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      return { status: 200, body: {} };
    });
    const section = h.section("keys");
    const box = section.querySelectorAll('input[type="checkbox"]')[0]!;
    box.checked = true;
    box.change();
    await settle();
    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.bulk.clearCooldown")!.click();
    await settle();

    const closeButtons = h.dom.byId("toast-host").querySelectorAll(".toast-close");
    expect(
      closeButtons.length,
      "整批请求本身失败（catch 分支）没有挂手动关闭按钮——会在 4 秒后自动消失，运维很可能没看见这次失败",
    ).toBe(1);
    expect(
      setTimeoutCalls,
      "catch 分支的 sticky toast 不该排一个 4000ms 的自动移除计时器",
    ).not.toContain(4000);
  });
});
