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

/**
 * `/admin/api/overview` 的应答，**形状与真后端逐格对齐**。
 *
 * ⚠️⚠️ **`kvEdgeCacheMs` 住在 `freshness` 里，不在 `config` 里。** 这一条不是随手写的：
 * 本文件第一版的这份替身把它放进了 `config`，**而板块当时也正好从 `config` 取**
 * ——替身跟着实现一起错，于是「停用后那句提示里的具体时长」整格测的是空气。
 * 真形状的权威是 `tests/contract/admin-overview.test.ts` 的 `OverviewBody`
 *（`config` 那一格只有 registrar/envLocked/degraded 六项，没有任何 TTL）。
 * **改这份替身之前先去那边核对，别照着 `sec-apikeys.js` 反推。**
 */
const OVERVIEW_BODY = {
  freshness: {
    poolCacheTtlMs: 60_000, poolVisibilityUpperBoundMs: 120_000, poolTouchIntervalMs: 21_600_000,
    configTtlMs: 30_000, configVisibilityUpperBoundMs: 90_000, kvEdgeCacheMs: 60_000,
  },
  config: {
    registrarEnabled: false, primary: null, fallback: null,
    targetKeys: 0, envLocked: [], degraded: false,
  },
};

/** 缺省应答：capabilities / overview / apikeys 三条，其余一律空对象。 */
function respondOk(list: unknown = listBody(), cap: unknown = capBody(), ov: unknown = OVERVIEW_BODY) {
  return (url: string) => {
    if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: cap };
    if (url.startsWith("/admin/api/overview")) return { status: 200, body: ov };
    if (url.startsWith("/admin/api/apikeys")) return { status: 200, body: list };
    return { status: 200, body: {} };
  };
}

/** toast-host 里当前的全部提示文本，按出现顺序。 */
function toasts(h: Harness): string[] {
  return h.dom.byId("toast-host").querySelectorAll("div").map((d) => d.textContent);
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

/**
 * **「停用之后最多还要多久才在别处失效」那句话里的数，得真的是个数。**
 *
 * `tests/ui/apikeys.test.ts` 已经把 `akRevokeDelayMs()` 本身测到了
 *（`(300_000, 60_000) → 360_000`、任一为空回 `null`），**但没有一格验证板块把
 * 那两个入参从哪里取**——而实际漏的正是取数那一步：边缘缓存那个数被按
 * `overview.config.kvEdgeCacheMs` 取，真后端把它放在 `freshness` 里，于是恒为
 * `undefined` ⇒ 纯函数如约回 `null` ⇒ 提示画成「最多还要 — 才看得见」。
 * 纯函数对、接线错，是本仓已经登记过的同一族假阴性。
 *
 * ⇒ 这一组的观测点**必须是渲染出来的那句话**，不是 `akRevokeDelayMs` 的返回值。
 */
describe("API 密钥板块：吊销延迟提示里的时长是具体的数字，不是破折号", () => {
  it("停用成功后那条 sticky 提示写的是「6分0秒」（= 缓存 TTL 300s + 边缘缓存 60s）", async () => {
    const { h } = await openSection(respondOk());
    buttonByText(sectionOf(h), "停用")!.click();
    await settle(12);
    const line = toasts(h).find((s) => s.includes("别的实例最多还要"));
    expect(line, "停用成功却没弹出「多久才在别处失效」那条提示").toBeDefined();
    // 字段名一改回 `config.` 这一格立刻红：edgeMs 变 null ⇒ 这里就是 EM。
    expect(line, "时长画成了破折号 —— 边缘缓存那个数没取到（它在 freshness 里）").not.toContain(EM);
    expect(line).toContain("6分0秒");
  });

  it("删除成功后同样给具体时长", async () => {
    const { h } = await openSection(respondOk());
    buttonByText(sectionOf(h), "删除")!.click();
    await settle(4);
    // 确认弹窗挂在 body 上（`ui.js` 的 `openModal`），两颗按钮固定是 [取消, 确定]。
    const dialog = h.dom.document.body.querySelectorAll('[role="dialog"]')[0];
    expect(dialog, "点了删除却没弹出确认框").toBeDefined();
    const buttons = dialog!.querySelectorAll("button");
    buttons[buttons.length - 1]!.click();
    await settle(12);
    const line = toasts(h).find((s) => s.includes("别的实例最多还要"));
    expect(line, "删除成功却没弹出「多久才在别处失效」那条提示").toBeDefined();
    expect(line).toContain("6分0秒");
  });

  /**
   * **反面那一格照样要有**：后端真的没给这个数时，画 `—` 是对的行为
   *（`akRevokeDelayMs` 那条「不编一个数出来」的安全约定）。
   * 少了这一格，「把 edgeMs 硬编码成 60_000」也能让上面两格绿。
   */
  it("后端没给边缘缓存那个数时画 —，**不编一个数出来**", async () => {
    const { h } = await openSection(respondOk(listBody(), capBody(), { freshness: {} }));
    buttonByText(sectionOf(h), "停用")!.click();
    await settle(12);
    const line = toasts(h).find((s) => s.includes("别的实例最多还要"));
    expect(line, "读不到就该画破折号，而不是凑一个数出来").toContain(EM);
  });
});

describe("API 密钥板块：明文只在签发那一次露面", () => {
  it("列表里一个字节的明文都没有 —— 后端不给，面板也不留", async () => {
    const { h } = await openSection(respondOk());
    // 响应体里本来就没有明文；这一格钉的是「面板没有从别处凑一个出来」。
    expect(sectionOf(h).textContent).not.toContain("sk-4f1c");
  });
});

/**
 * **每张卡上的用量那一行（Tier-2）。**
 *
 * ⚠️⚠️ 这一组的头等目标只有一条：**Tier-2 关着时那一格不许出现任何一个数字**。
 * 那是本轮那条硬裁定（「关着时显示『未开启』，不是恒为 0 的数字」）的判据本身，
 * 而它只有在**真的渲染出来的那段文本**上才验得到 —— 纯函数那一侧回
 * `{ kind: "off" }`，画的时候照样可以被写成 `fmtCount(0)`。
 */
describe("API 密钥板块：每张卡上的用量那一行", () => {
  /** 这一张卡上那一格的文本。**按 class 找**：它是这一格唯一的身份。 */
  function usageCells(h: Harness): string[] {
    return sectionOf(h).querySelectorAll(".ak-usage").map((n) => n.textContent);
  }

  /** 缺省三条 + 一条 `/admin/api/usage`。 */
  function respondWithUsage(usage: { status: number; body: unknown }) {
    return (url: string) => {
      if (url.startsWith("/admin/api/usage")) return usage;
      return respondOk()(url);
    };
  }

  const usageBody = (over: Record<string, unknown> = {}) => ({
    tier: "tier2", timezone: "UTC", approximate: true, generatedAt: NOW,
    range: { from: NOW - 86_400_000, to: NOW, clamped: false },
    days: [], shards: 2, malformed: 0,
    total: {
      requests: 9, success: 9, errors: 0, tokensIn: 0, tokensOut: 0,
      streamingRequests: 0, latencySum: 0, latencyCount: 0,
    },
    byApiKey: {
      aaaabbbbcccc: {
        requests: 7, success: 7, errors: 0, tokensIn: 0, tokensOut: 0,
        streamingRequests: 0, latencySum: 0, latencyCount: 0,
      },
    },
    pending: { count: 0, ms: 0, budgetExhausted: false },
    note: null, ...over,
  });

  it("Tier-2 关着时那一格写「未开启」，而且一个数字都不许出现 —— 画 0 就是把「没开」说成「没人用」", async () => {
    const { h } = await openSection(respondWithUsage({
      status: 200,
      body: {
        tier: "off", timezone: "UTC", approximate: true, generatedAt: NOW,
        range: { from: NOW - 86_400_000, to: NOW, clamped: false },
        days: null, total: null, byApiKey: null, shards: null, malformed: null,
        pending: null, note: "tier2_off",
      },
    }));
    const cells = usageCells(h);
    expect(cells.length, "卡片上压根没有这一格的话，下面那条正则是空的").toBe(1);
    expect(cells[0]).toBe("用量：未开启");
    // ★ **这一句就是那条裁定的判据**：任何一个数字都算违反。
    expect(cells[0], "Tier-2 关着时画出了数字").not.toMatch(/\d/);
  });

  it("开着且读到了：画这把密钥自己的请求数（带 ≈），不是整段区间的合计", async () => {
    const { h } = await openSection(respondWithUsage({ status: 200, body: usageBody() }));
    const cells = usageCells(h);
    expect(cells[0]).toContain("7");
    // 反向自检：`total.requests` 是 9 —— 拿合计去填每一张卡是另一种撒谎。
    expect(cells[0], "画的是整段区间的合计，不是这一把的").not.toContain("9");
    expect(cells[0]).toContain("≈");
  });

  it("开着、读到了、而这把密钥这段时间一次都没被用过：画 0 —— 那不是伪造，是真的 0", async () => {
    const { h } = await openSection(respondWithUsage({
      status: 200, body: usageBody({ byApiKey: {} }),
    }));
    expect(usageCells(h)[0]).toContain("0");
    expect(usageCells(h)[0], "把真零画成破折号是反向的撒谎").not.toContain(EM);
  });

  it("用量这一次读失败时画 —，而且不牵连列表本身（卡片照常在）", async () => {
    const { h } = await openSection(respondWithUsage({ status: 500, body: {} }));
    expect(usageCells(h)[0]).toBe(`用量：${EM}`);
    expect(sectionOf(h).textContent, "用量拉不出来不该让整张列表消失").toContain("mobile-app");
  });

  /** 这一次会话里 `GET /admin/api/…` 各打了几次。**按前缀数，不看方法之外的东西。** */
  function getCount(h: Harness, prefix: string): number {
    return h.calls.filter((c) => c.url.startsWith(prefix) && c.method === "GET").length;
  }

  /**
   * **用量读失败之后出得来出不来。**
   *
   * 评审发现（第 1 轮）：`loadUsage()` 原来**只有 `onShow` 一个调用点**，
   * 而它失败之后每张卡恒画「用量：—」——板块里没有任何一颗按钮会再拉一次用量
   *（上面那颗「刷新」只画在「列表也读不出来」那一支里，且只重拉列表）。
   * 也就是说 `usageFailed` 是个**进得去出不来**的状态，唯一的出路是切走板块再切回来。
   * 当时那段注释还反过来宣称「写操作收尾会跟着重来」——**一个调用点都没有**。
   *
   * 下面四格钉的就是修完之后的形状；`loadUsage` 的调用点数目本身由那段注释里
   * 写明的现算命令（`grep -n "loadUsage" admin-ui/js/sec-apikeys.js` 恰好三处）兜着。
   */
  describe("用量读失败之后，板块内自己给得出重试的路", () => {
    /** 第一次用量读 500、之后改成 200。**用它验「点一下真的能回到数字」。** */
    function flakyUsage() {
      let failed = false;
      return (url: string) => {
        if (url.startsWith("/admin/api/usage")) {
          if (failed) return { status: 200, body: usageBody() };
          failed = true;
          return { status: 500, body: {} };
        }
        return respondOk()(url);
      };
    }

    it("失败时画出一条黄条 + 一颗「刷新」，点它之后那一格从 — 变回真数字", async () => {
      const { h } = await openSection(flakyUsage());
      expect(usageCells(h)[0], "前置条件没成立").toBe(`用量：${EM}`);
      const again = buttonByText(sectionOf(h), "刷新");
      expect(again, "用量读失败后板块里一个重试入口都没有 —— 只能切走再切回来").not.toBeNull();
      again!.click();
      await settle(12);
      expect(usageCells(h)[0], "点了「刷新」用量还是 —").toContain("7");
      expect(sectionOf(h).textContent, "读回来了就该把那条黄条收掉").not.toContain("列表本身没问题");
    });

    it("那颗「刷新」**只重拉用量**，不顺手把列表也拉一遍（一次点击不许付没要的存储读）", async () => {
      const { h } = await openSection(flakyUsage());
      const before = getCount(h, "/admin/api/apikeys");
      const usageBefore = getCount(h, "/admin/api/usage");
      buttonByText(sectionOf(h), "刷新")!.click();
      await settle(12);
      expect(getCount(h, "/admin/api/usage"), "点了却没重拉用量").toBe(usageBefore + 1);
      expect(getCount(h, "/admin/api/apikeys"), "顺手把列表也拉了一遍").toBe(before);
    });

    it("用量好好的时候不画这条黄条 —— 常驻的话它就成了噪音", async () => {
      const { h } = await openSection(respondWithUsage({ status: 200, body: usageBody() }));
      expect(sectionOf(h).textContent).not.toContain("列表本身没问题");
      expect(buttonByText(sectionOf(h), "刷新"), "一切正常时这个板块里不该有「刷新」").toBeNull();
    });

    /**
     * **写操作收尾刻意不重拉用量**，这一格钉的是那条裁定（不是漏了）。
     * 理由写在 `loadUsage()` 上方：签发 / 改名 / 停用 / 删除都不改变「已经发生过的
     * 请求数」，跟着重拉只会给每次写平白加 4 次 get。哪天真要改成「写完也重拉」，
     * 得先来改这一格 —— 顺带把 DEPLOY.md 那笔账一起改了。
     */
    it("一次写操作收尾**不**重拉用量（列表倒是要重拉：版本号必须刷新）", async () => {
      const { h } = await openSection(respondWithUsage({ status: 200, body: usageBody() }));
      const usageBefore = getCount(h, "/admin/api/usage");
      const listBefore = getCount(h, "/admin/api/apikeys");
      buttonByText(sectionOf(h), "停用")!.click();
      await settle(12);
      expect(getCount(h, "/admin/api/apikeys"), "写完没重新读一遍列表，版本号就陈旧了").toBe(listBefore + 1);
      expect(getCount(h, "/admin/api/usage"), "写操作收尾顺手重拉了用量 —— 那是每次写多付 4 次 get")
        .toBe(usageBefore);
    });
  });
});
