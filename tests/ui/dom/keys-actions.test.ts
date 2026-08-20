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

  it("备注为 null 时显示 —，不是空字符串或字面 null", async () => {
    const items = [keyView({ id: "blank", note: null })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const row = h.section("keys").querySelectorAll('[data-key-id="blank"]')[0]!;
    expect(row.textContent).toContain("—");
    expect(row.textContent).not.toContain("null");
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

    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.import.open")!.click();
    await settle();

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
    section.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "keys.import.open")!.click();
    await settle();
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

  it("三个板块文件都从 pure/overview.mjs import offsetMs（反向自检：单一真源真的被用到了）", () => {
    for (const f of ["admin-ui/js/sec-keys.js", "admin-ui/js/sec-overview.js", "admin-ui/js/sec-events.js"]) {
      const src = readFileSync(f, "utf8");
      const m = /import\s*\{([^}]*)\}\s*from\s*"\.\/pure\/overview\.mjs"/.exec(src);
      expect(m, `${f} 没有从 pure/overview.mjs import`).not.toBeNull();
      const named = m![1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim());
      expect(named, `${f} 没有拿 offsetMs`).toContain("offsetMs");
    }
  });
});
