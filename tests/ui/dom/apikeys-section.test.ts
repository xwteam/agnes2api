import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle, type Harness } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { APIKEY_MAX } from "../../../src/core/admin/api-keys.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **「API 密钥」板块的渲染行为（DOM 那一半）。**
 *
 * `tests/ui/apikeys.test.ts` 把取值判定测得很细，**但没有任何东西验证板块文件真的
 * 把那些判定画了出来**。把「表读不出来」那一支改成渲染一张空列表，纯函数用例一条
 * 都不红，而面板会把「全部下游正在 401」说成「你还没签发过密钥」——两件完全不同的事。
 * 这一组补的就是那一半。
 *
 * ── **替身能力核对**（`tests/ui/dom/fake-dom-parity.test.ts` 是权威表）──────────
 * `admin-ui/js/sec-apikeys.js` 用到的 DOM 成员逐个对过：`createElement` /
 * `setAttribute` / `textContent` / `appendChild` / `addEventListener` /
 * `classList.toggle(name, force)` / `style.display` / `.value` / `.disabled`。
 * ⚠️ `.disabled` 落在 `FakeElement` 的**已知盲点**清单里（「`.disabled` 挂错宿主」）：
 * 本文件因此**不拿 `.disabled` 当唯一观测点**——「写操作禁掉了没有」那一格看的是
 * 「点下去有没有真的发出请求」，那是行为，不是属性。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;
const EM = "—";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const view = (over = {}) => ({
  id: "aaaabbbbcccc", name: "mobile-app", seq: 1, masked: "sk-••••••••3d41", hint: "3d41",
  bucket: "active", disabled: false, createdAt: NOW, expiresAt: null, ...over,
});

const listBody = (over = {}) => ({
  unreadable: false, version: 7, keys: [view()],
  counts: { all: 1, active: 1, disabled: 0, expired: 0 },
  max: APIKEY_MAX, cacheTtlMs: 300_000, ...over,
});

const capBody = (over = {}) => ({
  apiKeys: {
    wired: true, max: APIKEY_MAX, nameMax: 64, plaintextRetrievable: false,
    cacheTtlMs: 300_000, defaultCacheTtlMs: 300_000, ...over,
  },
});

/**
 * 打开这个板块（登录态 + 上次停在 apikeys）。
 *
 * ⚠️ **请求体从 `h.calls` 读，不自己再记一份**：夹具的 `respond` 只拿得到
 * `(url, method)`，`body` 是它在 `fetch` 替身里解出来放进 `calls` 的。
 * 自己再拼一份等于把「板块到底送了什么」建在一个抄件上。
 */
async function openSection(respond: (url: string, method: string) => { status: number; body: unknown }) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "apikeys" },
    respond,
  });
  await settle(12);
  return { h, calls: h.calls };
}

/** 缺省应答：capabilities / overview / apikeys 三条，其余一律空对象。 */
function respondOk(list: unknown = listBody(), cap: unknown = capBody()) {
  return (url: string) => {
    if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: cap };
    if (url.startsWith("/admin/api/overview")) return { status: 200, body: { config: { kvEdgeCacheMs: 60_000 } } };
    if (url.startsWith("/admin/api/apikeys")) return { status: 200, body: list };
    return { status: 200, body: {} };
  };
}

const sectionOf = (h: Harness): FakeElement => h.section("apikeys");

/**
 * 板块里那几颗**看得见的**按钮，按可见文字找。
 *
 * ⚠️ **`display: none` 的那些不算**：本板块的「清理失效」按钮是靠这一条隐藏的，
 * 只看 `textContent` 的话它会被当成「画出来了」——那正是这一族用例要区分的东西。
 * **不按 class 找**：class 是样式，文字才是契约。
 */
function buttonByText(root: FakeElement, text: string): FakeElement | null {
  for (const b of root.querySelectorAll("button")) {
    if (b.textContent === text && b.style.display !== "none") return b;
  }
  return null;
}

describe("API 密钥板块：列表的三种状态各画各的", () => {
  it("有数据时逐条画出名称、掩码与档位徽章", async () => {
    const { h } = await openSection(respondOk());
    const sec = sectionOf(h);
    expect(sec.textContent).toContain("mobile-app");
    expect(sec.textContent).toContain("sk-••••••••3d41");
    expect(sec.textContent).toContain("启用中");
  });

  it("**表读不出来时画的不是「一把都没有」**", async () => {
    const { h } = await openSection(respondOk(
      { unreadable: true, version: null, keys: [], counts: { all: 0, active: 0, disabled: 0, expired: 0 }, max: APIKEY_MAX, cacheTtlMs: 0 },
    ));
    const sec = sectionOf(h);
    // 这一格是本文件存在的主要理由：两支的响应体里 `keys` 都是空数组。
    expect(sec.textContent).toContain("读不懂");
    expect(sec.textContent, "把「表坏了」画成了「你还没签发过密钥」").not.toContain("还没有签发过");
  });

  it("一把都没有时画的是「还没有签发过」，而不是一句错误", async () => {
    const { h } = await openSection(respondOk(
      { unreadable: false, version: 0, keys: [], counts: { all: 0, active: 0, disabled: 0, expired: 0 }, max: APIKEY_MAX, cacheTtlMs: 0 },
    ));
    expect(sectionOf(h).textContent).toContain("还没有签发过");
  });

  it("这次读失败时**不把统计卡画成 0**，而是画成 —", async () => {
    const { h } = await openSection((url) => {
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: capBody() };
      if (url.startsWith("/admin/api/apikeys")) return { status: 500, body: {} };
      return { status: 200, body: {} };
    });
    const sec = sectionOf(h);
    expect(sec.textContent).toContain(EM);
    expect(sec.textContent).toContain("这次没读到");
  });

  it("这个部署没接存储时如实说出来，不画一张空列表", async () => {
    const { h } = await openSection(respondOk(listBody(), capBody({ wired: false })));
    expect(sectionOf(h).textContent).toContain("没有接上");
  });
});

describe("API 密钥板块：清理失效那颗按钮", () => {
  it("一把失效的都没有时整颗不画", async () => {
    const { h } = await openSection(respondOk());
    expect(buttonByText(sectionOf(h), "清理失效（0）"), "N = 0 时不该出现这颗按钮").toBeNull();
  });

  it("有失效的时候画出来，而且数字与「已停用 + 已过期」之和相同", async () => {
    const { h } = await openSection(respondOk(listBody({
      keys: [view(), view({ id: "b", seq: 2, bucket: "disabled", disabled: true }), view({ id: "c", seq: 3, bucket: "expired" })],
      counts: { all: 3, active: 1, disabled: 1, expired: 1 },
    })));
    expect(buttonByText(sectionOf(h), "清理失效（2）")).not.toBeNull();
  });
});

describe("API 密钥板块：写操作把版本号带回去", () => {
  it("停用那颗按钮送的是 `{ version, disabled: true }`，版本号来自刚读到的那份列表", async () => {
    const { h, calls } = await openSection(respondOk());
    const toggle = buttonByText(sectionOf(h), "停用");
    expect(toggle, "认不出停用按钮 —— 文案变了就回来改这条判据").not.toBeNull();
    toggle!.click();
    await settle(12);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch, "点了停用却一条 PATCH 都没发出去").toBeDefined();
    expect(patch!.url).toContain("/admin/api/apikeys/aaaabbbbcccc");
    expect(patch!.body).toEqual({ version: 7, disabled: true });
  });

  it("**版本号读不出来时一条写请求都不发** —— 不带版本号的写会被后端 400", async () => {
    const { h, calls } = await openSection(respondOk(listBody({ version: null })));
    const toggle = buttonByText(sectionOf(h), "停用");
    expect(toggle).not.toBeNull();
    calls.length = 0;
    toggle!.click();
    await settle(12);
    expect(calls.filter((c) => c.method !== "GET"), "版本号还不知道，却把写请求发出去了").toEqual([]);
  });
});

describe("API 密钥板块：明文只在签发那一次露面", () => {
  it("列表里一个字节的明文都没有 —— 后端不给，面板也不留", async () => {
    const { h } = await openSection(respondOk());
    // 响应体里本来就没有明文；这一格钉的是「面板没有从别处凑一个出来」。
    expect(sectionOf(h).textContent).not.toContain("sk-4f1c");
  });
});
