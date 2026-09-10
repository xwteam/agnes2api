import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle, type Harness } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { APIKEY_MAX } from "../../../src/core/admin/api-keys.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **「掩码 / 显示明文 / 复制」那一组控件的 DOM 行为**
 *（`admin-ui/js/ui.js` 的 `revealControls()`，状态机在 `admin-ui/js/pure/reveal.mjs`）。
 *
 * 🔴🔴 **这份文件是补一个整整缺席的一半。** `tests/ui/reveal.test.ts` 把状态机测得很细，
 * 但**它一格都答不了「屏幕上到底变没变」**——而这一族交付时的实际形态是：
 * 任何 HTTP 错误下**两颗按钮静默无反应**（`load()` 里那句 `await o.fetchSecret(o.id)`
 * 没有 `try/catch`，`js/api.js` 的 `json()` 对任何非 2xx 一律抛，异常穿过 `load()`
 * 落在两个 `async` 点击监听器上无人接，全站零处 `unhandledrejection`）。
 * 于是 `pure/reveal.mjs` 里那句「`failed` 那一档治的是网络断了 / 401 / 500」
 * **在真实错误路径上到不了**：只有「200 但响应体畸形」走得进 `revealOutcome()`。
 * **本仓的纪律是「点了什么都不会发生的按钮比没有更糟」**，同一族的其它行内动作
 * 全都写着 `.catch(e => toast(...))`。
 *
 * ⚠️ **错误路径是常态，不是边界**：这两张表都是轮询刷新的，一条记录在另一个标签页被删、
 * 被别的副本剔除之后，屏幕上那一行还在，点下去必然是 404（线上实打过：
 * `GET /admin/api/keys/<不存在>/reveal` 与 `/admin/api/apikeys/<不存在>/reveal` 都回 404）。
 *
 * ── **两族各跑一遍，不许只跑一族** ────────────────────────────────────────────
 * Key 池与 API 密钥共用同一个 `revealControls()`，但它们**注入的取数函数不同**
 *（各自的端点、各自的字段名），而「注入的东西对不对」正是只有在各自的板块里才看得见。
 *
 * ── **替身能力核对（第 9 种假阳性）** ────────────────────────────────────────
 * `tests/ui/dom/fake-dom-parity.test.ts` 是权威表。这组控件用到的是
 * `createElement` / `setAttribute` / `removeAttribute` / `textContent` /
 * `appendChild` / `addEventListener` / `click()`。
 * `navigator.clipboard` 不是 DOM 成员：`tests/ui/dom/harness.ts` 装了一个空实现，
 * 本文件在开局之后**换成一个会记账的**，好断言「取不到明文时剪贴板里什么都没写」。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ───────────────────────────────────────────────────────────────────────────
// 夹具
// ───────────────────────────────────────────────────────────────────────────

const POOL_ID = "id-reveal-me";

/** 一份"正常"的 KeyView（形状照 `tests/ui/dom/keys-actions.test.ts` 那份）。 */
function keyView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: POOL_ID, masked: "sk-de…fault", seq: 1, bucket: "fresh",
    addedAt: NOW - 10_000, lastUsedAt: null, cooldownUntil: 0,
    cooldownReason: null, evictedReason: null, strikes: 0,
    disabled: false, evicted: false, note: null,
    stats: { requests: 0, success: 0, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null },
    ...overrides,
  };
}

const poolListBody = (items: Array<Record<string, unknown>>) => ({
  items, total: items.length, page: 1, pages: 1, size: 20,
  counts: { all: items.length, fresh: 0, cooling: 0, evicted: 0, disabled: 0 },
  approximate: true, generatedAt: NOW,
});

const AK_ID = "aaaabbbbcccc";

const akListBody = () => ({
  unreadable: false, version: 7,
  keys: [{
    id: AK_ID, name: "mobile-app", seq: 1, masked: "sk-••••••••3d41", hint: "3d41",
    bucket: "active", disabled: false, createdAt: NOW, expiresAt: null,
  }],
  counts: { all: 1, active: 1, disabled: 0, expired: 0 },
  max: APIKEY_MAX, cacheTtlMs: 300_000,
});

/**
 * ⚠️ **`plaintextRetrievable: true` 是这一族按钮出现的前提**：它由后端算
 *（`/admin/api/capabilities`），面板据它决定这两颗按钮画不画。夹具里给 `false`
 * 的话下面每一格都会红在「找不到那颗按钮」，而那与本组要测的事没有关系。
 */
const akCapBody = () => ({
  apiKeys: {
    wired: true, max: APIKEY_MAX, nameMax: 64, plaintextRetrievable: true,
    cacheTtlMs: 300_000, defaultCacheTtlMs: 300_000,
  },
});

const OVERVIEW_BODY = {
  freshness: {
    poolCacheTtlMs: 60_000, poolVisibilityUpperBoundMs: 60_000, poolTouchIntervalMs: 21_600_000,
    configTtlMs: 30_000, configVisibilityUpperBoundMs: 30_000,
  },
  config: {
    registrarEnabled: false, primary: null, fallback: null,
    targetKeys: 0, envLocked: [], degraded: false,
  },
};

/** 这一组里被写进剪贴板的东西，按顺序。**开局之后才换**，见文件头。 */
function trackClipboard(): string[] {
  const written: string[] = [];
  vi.stubGlobal("navigator", { clipboard: { writeText: async (s: string) => { written.push(String(s)); } } });
  return written;
}

async function openKeysSection(respond: (url: string) => { status: number; body: unknown }): Promise<Harness> {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "keys" },
    respond,
  });
  await settle(12);
  return h;
}

async function openApiKeysSection(respond: (url: string) => { status: number; body: unknown }): Promise<Harness> {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "apikeys" },
    respond,
  });
  await settle(12);
  return h;
}

/**
 * 那一组控件里的两颗按钮。
 *
 * ⚠️ **「显示」那颗没有 `data-i18n`**（它的字随明文态在「显示 / 隐藏」之间换，
 * 由 `render()` 直接写 `textContent`），所以这里按**位置**找：`.reveal` 里的两颗
 * `button` 恒是「显示」「复制」，顺序由 `revealControls()` 定。
 */
function revealButtons(root: FakeElement): { eye: FakeElement; copy: FakeElement } {
  const wrap = root.querySelectorAll(".reveal")[0];
  if (!wrap) throw new Error("屏幕上没有那一组「掩码 / 显示明文 / 复制」控件");
  const btns = wrap.querySelectorAll("button");
  expect(btns.length, "那一组控件里不是两颗按钮").toBe(2);
  return { eye: btns[0]!, copy: btns[1]! };
}

/** toast-host 里当前的全部提示文本，按出现顺序。 */
function toasts(h: Harness): string[] {
  return h.dom.byId("toast-host").querySelectorAll("div").map((d) => d.textContent);
}

// ───────────────────────────────────────────────────────────────────────────
// Key 池那一族
// ───────────────────────────────────────────────────────────────────────────

describe("Key 池：取明文失败时屏幕上必须有反应", () => {
  /**
   * 🔴 **本组的立身之本。**
   *
   * **变红条件（本任务变异实测）**：把 `admin-ui/js/ui.js` 的 `load()` 里那圈
   * `try/catch` 去掉、改回一句裸的 `await o.fetchSecret(o.id)` ⇒ 这一格红成
   * 「点了「显示明文」之后屏幕上一个字都没变：expected [] to have a length of 1」，
   * 而控制台里只有一条无人接的 promise 拒绝——那正是交付时的真实形态。
   *
   * ⚠️ **404 那句话必须与「这一次没成」那句分得开**：前者的处置是「刷新列表」
   *（这条记录已经不在了），后者是「等一会儿再点」。并成一句会让运维对着一条
   * 已经不存在的记录反复点。
   */
  it("reveal 回 404：屏幕上必须出现一句话 —— 静默是本仓明令禁止的那一种坏法", async () => {
    const h = await openKeysSection((url) => {
      if (url.startsWith(`/admin/api/keys/${POOL_ID}/reveal`)) {
        return { status: 404, body: { error: { type: "not_found", message: "没有这把 key", code: "key_not_found" } } };
      }
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: poolListBody([keyView()]) };
      return { status: 200, body: {} };
    });

    revealButtons(h.section("keys")).eye.click();
    await settle(12);

    const texts = toasts(h);
    expect(texts, "点了「显示明文」之后屏幕上一个字都没变").toHaveLength(1);
    expect(texts[0], "404 被说成了「这一次没取到，稍后再试」—— 那把 key 已经不在了，等多久都一样")
      .toContain("这一条已经不在了");
    // 反向自检：那次请求真的发出去了（否则这一格测的是「按钮压根没接上」）。
    expect(h.calls.some((c) => c.url === `/admin/api/keys/${POOL_ID}/reveal`), "那次取明文的请求根本没发出去").toBe(true);
    // 明文没拿到 ⇒ 那一格仍然是掩码，不许变成空字符串。
    expect(h.section("keys").querySelectorAll(".reveal-text")[0]!.textContent).toBe("sk-de…fault");
  });

  /**
   * **500 与 404 是两句话。** 500 那一档重试可能就好了，而 404 等多久都一样。
   *
   * **变红条件**：让 `revealErrorOutcome()` 对所有状态码都回 `gone`（或都回 `failed`）
   * ⇒ 这一格与上一格里必有一格红在「说的是另一句话」。
   */
  it("reveal 回 500：说的是「这一次没取到，稍后再试」，不是「这一条已经不在了」", async () => {
    const h = await openKeysSection((url) => {
      if (url.startsWith(`/admin/api/keys/${POOL_ID}/reveal`)) {
        return { status: 500, body: { error: { type: "internal", message: "存储读失败" } } };
      }
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: poolListBody([keyView()]) };
      return { status: 200, body: {} };
    });

    revealButtons(h.section("keys")).eye.click();
    await settle(12);

    const texts = toasts(h);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("这一次没取到明文");
    expect(texts[0], "一次存储读失败被说成「这一条已经不在了」—— 那会让运维去重发一把还在的 key")
      .not.toContain("这一条已经不在了");
  });

  /**
   * 🔴 **「复制」那颗按钮同样不许静默，而且失败时剪贴板里绝不能有东西。**
   * 它在未显示明文时也能用（先取一次再写剪贴板），所以它走的是同一条 `load()`。
   *
   * ⚠️ **两条断言缺一不可**：只断 toast 的话，一个「先弹提示、再把 `null` 写进
   * 剪贴板」的实现照样绿——而那会让运维粘出一个空串还以为自己复制到了。
   */
  it("复制那颗按钮取不到明文时：同样有提示，而且剪贴板里什么都没写", async () => {
    const h = await openKeysSection((url) => {
      if (url.startsWith(`/admin/api/keys/${POOL_ID}/reveal`)) {
        return { status: 404, body: { error: { type: "not_found", message: "没有这把 key" } } };
      }
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: poolListBody([keyView()]) };
      return { status: 200, body: {} };
    });
    const written = trackClipboard();

    revealButtons(h.section("keys")).copy.click();
    await settle(12);

    expect(toasts(h), "点了「复制」之后屏幕上一个字都没变").toHaveLength(1);
    expect(toasts(h)[0]).toContain("这一条已经不在了");
    expect(written, "取不到明文却往剪贴板里写了东西").toEqual([]);
  });

  /**
   * **反向自检：成功那条路一句多余的话都没有。**
   * 少了这一格，上面几格在「无论如何都弹一句」的实现下同样是绿的。
   */
  it("取得到明文时不弹任何提示，明文直接上屏", async () => {
    const h = await openKeysSection((url) => {
      if (url.startsWith(`/admin/api/keys/${POOL_ID}/reveal`)) {
        return { status: 200, body: { key: "sk-pool-plaintext-value" } };
      }
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: poolListBody([keyView()]) };
      return { status: 200, body: {} };
    });

    revealButtons(h.section("keys")).eye.click();
    await settle(12);

    expect(toasts(h), "成功那条路上多弹了一句话").toEqual([]);
    expect(h.section("keys").querySelectorAll(".reveal-text")[0]!.textContent).toBe("sk-pool-plaintext-value");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// API 密钥那一族（注入的取数函数不同，各跑一遍）
// ───────────────────────────────────────────────────────────────────────────

describe("API 密钥：取明文失败时屏幕上必须有反应", () => {
  /**
   * ⚠️ **这一族不是上一族的重复**：两边注入给 `revealControls()` 的取数函数不同
   *（端点不同、明文字段名也不同：`key` 与 `secret`），而注入接错了只有在各自的
   * 板块里才看得见。线上这条端点同样实打过 404。
   */
  it("reveal 回 404：屏幕上必须出现一句话，而不是只在控制台里留一条拒绝", async () => {
    const h = await openApiKeysSection((url) => {
      if (url.startsWith(`/admin/api/apikeys/${AK_ID}/reveal`)) {
        return { status: 404, body: { error: { type: "not_found", message: "没有这条", code: "apikey_not_found" } } };
      }
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: akCapBody() };
      if (url.startsWith("/admin/api/overview")) return { status: 200, body: OVERVIEW_BODY };
      if (url.startsWith("/admin/api/apikeys")) return { status: 200, body: akListBody() };
      return { status: 200, body: {} };
    });

    revealButtons(h.section("apikeys")).eye.click();
    await settle(12);

    expect(toasts(h), "点了「显示明文」之后屏幕上一个字都没变").toHaveLength(1);
    expect(toasts(h)[0]).toContain("这一条已经不在了");
    expect(h.calls.some((c) => c.url === `/admin/api/apikeys/${AK_ID}/reveal`), "那次取明文的请求根本没发出去").toBe(true);
  });

  /**
   * **⚠️ 这一格钉的是那条「被驳回的同族发现」的反面，别把它读成缺陷。**
   * 升级前签发的那些密钥（服务端从来就没有过它们的明文）**照样画出这两颗按钮**，
   * 而它们点下去会**如实弹出**「签发在明文落盘之前」——那是一个永远不会变的事实，
   * 处置是重发一把。它与上面那句 404 **不是同一句话**，也不是静默失败。
   */
  it("签发于明文落盘之前：点下去说的是「重发一把」，不是「稍后再试」也不是「已经不在了」", async () => {
    const h = await openApiKeysSection((url) => {
      if (url.startsWith(`/admin/api/apikeys/${AK_ID}/reveal`)) {
        return { status: 200, body: { secret: null, reason: "issued_before_plaintext" } };
      }
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: akCapBody() };
      if (url.startsWith("/admin/api/overview")) return { status: 200, body: OVERVIEW_BODY };
      if (url.startsWith("/admin/api/apikeys")) return { status: 200, body: akListBody() };
      return { status: 200, body: {} };
    });

    revealButtons(h.section("apikeys")).eye.click();
    await settle(12);

    expect(toasts(h)).toHaveLength(1);
    expect(toasts(h)[0]).toContain("只能重发一把");
    expect(toasts(h)[0], "一个永远不会变的事实被说成了「稍后再试」").not.toContain("请稍后再试");
    expect(toasts(h)[0]).not.toContain("这一条已经不在了");
  });
});
