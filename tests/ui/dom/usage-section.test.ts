import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **用量板块的渲染行为（P3d Task 5 Step 4）。**
 *
 * `tests/ui/usage.test.ts` 把取值判定测得很细，**但没有任何东西验证板块文件
 * 真的把那些判定渲染成了不同的字**。把 `fillCell` 里 `"none"` 那一支改成走
 * `"unknown"` 那一支，纯函数用例一条都不红，而面板会把「这段时间没有请求」
 * 说成「读取失败」——三态白分。这一组补的就是那一半。
 *
 * ── **替身能力核对（第 9 种假阳性，Step 4 要求写进检查单）** ─────────────────
 * `tests/ui/dom/fake-dom-parity.test.ts` 是权威表：`FAKE_ONLY_MEMBERS` **8 条**
 *（`.walk()` / `.parent` / `.input()` / `.attrs` / `.listeners` /
 * `classList.reset()` / `querySelectorAll()` 后紧跟数组方法 / `.children` 后紧跟数组方法），
 * `KNOWN_BLIND_SPOTS` **3 条**（返回值先存进变量再调数组方法 / `submit()` 语义相反 /
 * `.disabled` 挂错宿主）。
 * `admin-ui/js/sec-usage.js` 用到的 DOM 成员逐个对过：
 * `createElement` / `setAttribute` / `getAttribute` / `textContent` / `appendChild` /
 * `addEventListener` / `classList.add` / `classList.toggle(name, force)` —— **8 条一条都没用到，
 * 3 条盲点也一条都没踩**（本板块没有禁用态、没有表单、没有子树遍历，
 * 也不调 `querySelectorAll`）。`.disabled` 那条盲点对本任务不适用。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;
/** EM DASH（U+2014）：`fmtDash(null)` 交出来的那一根，意思是「我们不知道」。 */
const EM = "—";
/** EN DASH（U+2013）：`sec-usage.js` 的 `EN_DASH`，意思是「读成功了，只是没有样本」。 */
const EN = "–";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 板块里全部 `.card` 的「标签 key → 值文本」。 */
function cards(section: FakeElement): Record<string, string> {
  const out: Record<string, string> = {};
  // ⚠️ 刻意用 `for…of` 而不是 `.map` / `.find`：`querySelectorAll` 在真实 DOM 上
  //    回的是 `NodeList`，没有数组方法（fake-dom-parity 那张表的第 7 条）。
  //    测试代码不在那道扫描范围内，但照真实语义写才不会把一个错的写法教给下一个人。
  for (const card of section.querySelectorAll(".card")) {
    let labelKey: string | null = null;
    let value: string | null = null;
    for (const div of card.querySelectorAll("div")) {
      if (div.classList.contains("label")) labelKey = div.getAttribute("data-i18n");
      if (div.classList.contains("value")) value = div.textContent;
    }
    if (labelKey !== null && value !== null) out[labelKey] = value;
  }
  return out;
}

/** 板块里全部横幅的 class（顺序即 DOM 顺序）。 */
function banners(section: FakeElement): string[] {
  const out: string[] = [];
  for (const cls of ["banner-danger", "banner-warn", "banner-info"]) {
    for (const node of section.querySelectorAll(`.${cls}`)) out.push(`${cls}:${node.textContent}`);
  }
  return out;
}

/** 一份 `GET /admin/api/usage` 的正常响应。 */
function usageBody(over: Record<string, unknown> = {}) {
  return {
    tier: "tier2", timezone: "UTC", approximate: true, generatedAt: NOW,
    range: { from: NOW - 86_399_999, to: NOW, clamped: false },
    days: [{
      date: "2026-08-21",
      total: {
        requests: 100, success: 90, errors: 10, tokensIn: 4000, tokensOut: 2500,
        streamingRequests: 30, latencySum: 24_000, latencyCount: 80,
      },
    }],
    total: {
      requests: 100, success: 90, errors: 10, tokensIn: 4000, tokensOut: 2500,
      streamingRequests: 30, latencySum: 24_000, latencyCount: 80,
    },
    shards: 3, malformed: 0,
    pending: { count: 0, ms: 0, budgetExhausted: false },
    note: null,
    ...over,
  };
}

const CAPS = {
  version: "0.1.0",
  runtime: { name: "node", colo: null },
  stats: { tier2Enabled: true, flushIntervalMs: 60_000, tokensCoverage: ["anthropic", "responses"] },
};

const MODELS = {
  protocols: [
    { id: "openai", label: "OpenAI Chat Completions" },
    { id: "anthropic", label: "Anthropic Messages" },
    { id: "responses", label: "OpenAI Responses" },
    { id: "gemini", label: "Google Gemini" },
  ],
  models: [],
};

/** 打开用量板块（登录态 + 上次停在 usage）。 */
async function openUsage(
  respond: (url: string, method: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "usage" },
    respond,
  });
  await settle(12);
  return h;
}

/** 缺省应答：capabilities / models 给全，usage 按传进来的那一份。 */
function respondWith(usage: unknown, status = 200) {
  return (url: string) => {
    if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
    if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
    if (url.startsWith("/admin/api/usage")) return { status, body: usage };
    return { status: 200, body: {} };
  };
}

describe("Tier-2 关闭：说明卡，不是空图表", () => {
  /**
   * **变红条件**：把 `render()` 里 `if (state === "off") { …; return; }` 的
   * `return` 删掉 ⇒ 六张卡照样渲染出来（全是 EM DASH）
   * ⇒ 「一个数字格都没有」那句断言当场红。
   *
   * 空图表比不画更糟：一张全是 0（或全是破折号）的表会被读成
   *「这段时间没人用」，而事实是这个部署根本没在记账。
   */
  it("Tier-2 关着时渲染说明卡，且页面上一个数字格都没有 —— 空图表比不画更糟", async () => {
    const h = await openUsage(respondWith({
      tier: "off", timezone: "UTC", approximate: true, generatedAt: NOW,
      range: { from: NOW - 86_399_999, to: NOW, clamped: false },
      days: null, total: null, shards: null, malformed: null, pending: null, note: "tier2_off",
    }));
    const sec = h.section("usage");
    expect(sec.querySelectorAll(".value").length, "关着还渲染了数字格").toBe(0);
    expect(sec.textContent).toContain("时间序列统计没有开启");
    // ⚠️ **怎么开这件事必须说准**：`usageStatsEnabled` 今天不在 `EDITABLE` 里，
    //    设置页上没有它的入口 ⇒ 不许给一颗「跳设置页」的按钮。
    expect(sec.textContent, "没写清真正能开它的那条路径").toContain("USAGE_STATS_ENABLED");
    // KV 写开销那个数从 capabilities 取，**不在前端算死**：60000ms ⇒ 「1分0秒」。
    expect(sec.textContent, "落盘间隔没有来自 capabilities").toContain("1分0秒");
    // 时间范围按钮组也不该出现：一段没有数据的区间选它做什么。
    expect(sec.querySelectorAll("[data-range]").length).toBe(0);
  });
});

describe("三态在六张卡上必须长得不一样", () => {
  /**
   * **变红条件**：把 `fillCell` 的 `"unknown"` 那一支改成
   * `node.appendChild(el("span", null, "0"))` ⇒ 面板对读取失败报 0
   * ⇒ 下面每一句都红。这正是全局约束 9 的原话。
   */
  it("接口返回 days: null 时六张卡全是 EM DASH，且顶部是错误横幅 —— 不许伪造 0", async () => {
    const h = await openUsage(respondWith(usageBody({
      days: null, total: null, shards: null, malformed: null, note: "read_failed",
    })));
    const c = cards(h.section("usage"));
    // 六张卡，逐张列全 —— **数全集，不是数上一轮被点名的那几条**。
    expect(Object.keys(c).sort()).toEqual([
      "usage.card.errorRate", "usage.card.latency", "usage.card.requests",
      "usage.card.streaming", "usage.card.successRate", "usage.card.tokens",
    ]);
    expect(c["usage.card.requests"]).toBe(EM);
    expect(c["usage.card.successRate"]).toBe(EM);
    expect(c["usage.card.latency"]).toBe(EM);
    expect(c["usage.card.errorRate"]).toBe(EM);
    // Token 卡在这一档下是**一根**破折号，不是「— / —」：读不出来这件事只有一次，
    // 把它写成两次会让人以为「入」与「出」是各自独立地失败的。
    expect(c["usage.card.tokens"]).toBe(EM);
    expect(c["usage.card.streaming"]).toBe(EM);
    // 一个 `0` 都不许出现在这六张卡上。
    for (const [k, v] of Object.entries(c)) expect(v, `${k} 伪造了 0`).not.toContain("0");
    expect(banners(h.section("usage")).join("|")).toContain("banner-danger");
  });

  /**
   * **变红条件**：把 `empty` 态的比率卡也改成走 `"unknown"`
   *（`fillCell(successRate.value, cellKind(state, c.requests), …)`，
   * 也就是拿计数那一档的判据去填比率格）⇒ 比率卡变成 EM DASH
   * ⇒ 与上面那一格的 `unavailable` 渲染**完全相同** ⇒ 最后那句对照断言红。
   */
  it("接口返回真实的零请求时：计数卡是 0、比率卡是 EN DASH、顶部是「没有请求」横幅 —— empty 与 unavailable 必须长得不一样", async () => {
    const zero = {
      requests: 0, success: 0, errors: 0, tokensIn: 0, tokensOut: 0,
      streamingRequests: 0, latencySum: 0, latencyCount: 0,
    };
    const h = await openUsage(respondWith(usageBody({
      days: [{ date: "2026-08-21", total: zero }], total: zero,
      shards: 3, malformed: 0, note: null,
    })));
    const c = cards(h.section("usage"));
    // 计数类：**这一次读成功了，我们确实知道答案是零** ⇒ 写 `0`。
    expect(c["usage.card.requests"]).toBe("≈ 0");
    expect(c["usage.card.streaming"]).toBe("≈ 0");
    expect(c["usage.card.tokens"]).toBe("≈ 0 / 0");
    // 比率类与平均延迟：没有分母 / 没有样本 ⇒ EN DASH，**不是** EM DASH。
    expect(c["usage.card.successRate"]).toBe(EN);
    expect(c["usage.card.errorRate"]).toBe(EN);
    expect(c["usage.card.latency"]).toBe(EN);
    // ⚠️ **这一句才是这一格的全部理由**：两个态渲染成同一个字就是把两件事说成一件。
    expect(c["usage.card.successRate"], "empty 与 unavailable 在比率卡上长得一样了").not.toBe(EM);
    expect(banners(h.section("usage")).join("|"), "没有说清『这段时间真的一次请求都没有』")
      .toContain("这段区间里一次请求都没有");
  });

  /**
   * **`all_malformed`：读到了分片，但每一个都坏。**
   * 后端在这一档下发的 `days` / `total` 全是 0 桶 —— 照着渲染就会在六张卡上写 `0`，
   * 而我们对这段时间的用量一无所知。
   *
   * **变红条件**：把 `usageState` 里 `if (malformedKind(r) === "all") return "unavailable";`
   * 删掉 ⇒ 状态变成 `empty` ⇒ 计数卡写 `0` ⇒ 第一句断言红。
   */
  it("分片全坏时六张卡是 EM DASH 而不是 0 —— 那些 0 不是知识", async () => {
    const zero = {
      requests: 0, success: 0, errors: 0, tokensIn: 0, tokensOut: 0,
      streamingRequests: 0, latencySum: 0, latencyCount: 0,
    };
    const h = await openUsage(respondWith(usageBody({
      days: [{ date: "2026-08-21", total: zero }], total: zero,
      shards: 0, malformed: 5, note: "all_malformed",
    })));
    const c = cards(h.section("usage"));
    expect(c["usage.card.requests"]).toBe(EM);
    expect(banners(h.section("usage")).join("|")).toContain("每一个都是畸形的");
  });

  /**
   * **`partial_malformed`：数字是真的，只是不全。**
   * 全局约束 9 禁的伪造**不只是伪造 `0`，还有伪造「这份数据是全的」这个印象**。
   *
   * **变红条件**：把 `buildCards` 里 `const incompleteOf = c.complete ? null : c.malformed;`
   * 改成 `const incompleteOf = null;` ⇒ 缺了两个分片的数字被渲染成完整的
   * ⇒ 第一句断言红。
   */
  it("一部分分片畸形时每一张卡都带「不完整」标记 —— 不许把缺了几块的数字渲染成完整的", async () => {
    const h = await openUsage(respondWith(usageBody({ shards: 3, malformed: 2, note: "partial_malformed" })));
    const c = cards(h.section("usage"));
    expect(c["usage.card.requests"], "缺了两个分片却渲染成了完整数据").toContain("不完整");
    expect(c["usage.card.requests"]).toContain("100");
    // 反向锚：没有畸形分片时**不许**出现这个标记，否则「恒带标记」也全绿。
    const ok = await openUsage(respondWith(usageBody()));
    expect(cards(ok.section("usage"))["usage.card.requests"]).not.toContain("不完整");
  });

  /**
   * **变红条件**：把 `buildCards` 里
   * `const approx = … data.approximate === true;` 改成 `const approx = true;`
   * ⇒ 后端说这份数字不是近似值时面板照样打 `≈` ⇒ 第二句断言红。
   * 这是全局约束 10（诚实标记由后端字段驱动）在本板块的落点。
   */
  it("`≈` 由响应里的 approximate 驱动，不是前端硬编码的 true", async () => {
    const on = await openUsage(respondWith(usageBody({ approximate: true })));
    expect(cards(on.section("usage"))["usage.card.requests"]).toContain("≈");
    const off = await openUsage(respondWith(usageBody({ approximate: false })));
    expect(cards(off.section("usage"))["usage.card.requests"], "前端把 ≈ 写死了").not.toContain("≈");
  });
});

describe("横幅：判据全部来自响应字段", () => {
  /**
   * **变红条件**：把 `buildRangeBar` 里那条 `usage.covered` 改成用
   * `rangeToQuery(range, Date.now())` 自己算出来的一对 ⇒ 面板显示的区间
   * 与服务端真正查过的那一段脱钩 ⇒ 第二句断言红。
   */
  it("range.clamped 为真时顶部说明「只显示了能拿到的部分」，且覆盖区间是服务端回读的那一对", async () => {
    const h = await openUsage(respondWith(usageBody({
      range: { from: 1_697_500_800_000, to: 1_700_006_399_999, clamped: true },
      note: "range_clamped",
    })));
    const sec = h.section("usage");
    expect(banners(sec).join("|")).toContain("banner-warn");
    expect(sec.textContent).toContain("只显示了能拿到的那一段");
    // 服务端回读的 `range.from`（1697500800000 = 2023-10-17 00:00:00 UTC）
    // 必须原样出现在覆盖区间里；前端自己按 `now − 29 天` 算的话是别的数。
    expect(sec.textContent, "覆盖区间没有渲染服务端回读的 range").toContain("2023-10-17 00:00:00");
  });

  /**
   * ⚠️⚠️ **这一格钉的是「前端不许假设 note 只可能是那八个值之一」。**
   * `tests/contract/admin-usage.test.ts` 的
   * 「八种状态两两不同 —— 面板不用猜，也不该猜（但这一格证明不了没有第九种）」
   * 证明的是「已列出的那八种互不相同」，**不是「没有第九种」**。
   *
   * **变红条件**：把 `buildNoteBanner` 里 `key === null` 那一支改成
   * `elI18n("span", "common.loadFailed")` ⇒ 一条读得懂的新 code 被抹成
   *「读取失败，显示为 —」⇒ 第二句断言红。
   */
  it("面板不认识的 note code 原样显示出来 —— 抹成一句「加载失败」会把一条说得清的信号变成废话", async () => {
    const h = await openUsage(respondWith(usageBody({ note: "some_future_code_from_a_later_release" })));
    const sec = h.section("usage");
    expect(sec.textContent, "新 code 没被显示出来").toContain("some_future_code_from_a_later_release");
    expect(sec.textContent, "被抹成了一句通用失败提示").not.toContain("读取失败，显示为");
    // 读不懂的 code 归 warn：不当成常态，也不把面板染成一片红。
    expect(banners(sec).join("|")).toContain("banner-warn");
  });

  /**
   * ⚠️ **`count > 0 && ms === 0` 要读作「刚试过、没写成」，不是「没有尾巴」**
   *（`src/http/usage-sink.ts` 的 `status()` 上方写着全文）。
   *
   * **变红条件**：把 `pendingTail` 的判据从 `count` 换成 `ms` ⇒ 这一格
   * 什么都不渲染 ⇒ 第一句断言红。
   */
  it("落盘失败时（count 大于 0 而 ms 是 0）面板把预算耗尽说出来 —— 两种失败态在 count + ms 上长得一样", async () => {
    const h = await openUsage(respondWith(usageBody({
      pending: { count: 7, ms: 0, budgetExhausted: true },
    })));
    const sec = h.section("usage");
    expect(sec.textContent).toContain("写配额已经耗尽");
    expect(sec.textContent).toContain("7");
    // 反向锚：没有耗尽时说的是另一句话 —— 两种失败态不许互相冒充。
    const other = await openUsage(respondWith(usageBody({
      pending: { count: 7, ms: 0, budgetExhausted: false },
    })));
    expect(other.section("usage").textContent).not.toContain("写配额已经耗尽");
    expect(other.section("usage").textContent).toContain("还有 7 条计数没有落盘");
  });
});

describe("时间范围：档位差一天会让那句警告永久常驻", () => {
  /**
   * ⚠️ **观测点在真实请求 URL 上**，不是在 `rangeToQuery` 的返回值上
   *（那一层已经由 `tests/ui/usage.test.ts` 的
   * 「30d 的区间正好是 29 × 86400000，且只发 from / to 两个参数 —— 参数名发错在真实请求 URL 上才看得见」
   * 钉着）。这一格证明的是**板块真的把它拼进了 URL**。
   *
   * **变红条件**：把 `load()` 里的查询串改成 `?days=30` 或者把
   * `rangeToQuery` 换回 `nowMs - days * 86400000` ⇒ 最后那句断言红。
   */
  it("点 30d 之后请求 URL 里的 from / to 相差 29 天 —— 发成 30 天会让 clamped 恒为真", async () => {
    const h = await openUsage(respondWith(usageBody()));
    // 缺省档是 24h（**不是 30d**：那一档一次要读满 30 天的分片）。
    expect(h.calls.some((c) => c.url === "/admin/api/usage?from=1700000000000&to=1700000000000"),
      "缺省档不是 24h").toBe(true);

    const sec = h.section("usage");
    const btn = sec.querySelector("[data-range=\"30d\"]");
    expect(btn, "30d 按钮不在页面上").not.toBe(null);
    btn!.click();
    await settle(12);

    // 手写字面量：1700000000000 − 29 × 86400000 = 1697494400000。
    expect(h.calls.some((c) => c.url === "/admin/api/usage?from=1697494400000&to=1700000000000"),
      "30d 那一档没有按 from = to − (N−1) 天 发").toBe(true);
    // 发成 30 天回退的那个数**不许**出现（1700000000000 − 30 × 86400000）。
    expect(h.calls.some((c) => c.url.includes("from=1697408000000")),
      "发成了 now − 30 天 ⇒ 每一次点 30d 都会被夹").toBe(false);
    // 30d 那一档要说清保留期，且**不许**声称那些子请求是安全的。
    expect(sec.textContent).toContain("最多保留 30 天");
    expect(sec.textContent).toContain("尚未在真机上验证过");
  });

  /** **本板块不轮询**（配额账三条红线第 1 条）：刷新只在人点一下与切档位时发生。 */
  it("停在板块上不动时一个额外请求都不发 —— 这个板块每刷新一次要付一次存储读", async () => {
    const h = await openUsage(respondWith(usageBody()));
    const before = h.calls.filter((c) => c.url.startsWith("/admin/api/usage")).length;
    for (let i = 0; i < 8; i++) await settle(12);
    const after = h.calls.filter((c) => c.url.startsWith("/admin/api/usage")).length;
    expect(after, "板块在自己轮询").toBe(before);
    expect(before, "反向自检：它至少发过一次，否则上面那个相等恒成立").toBeGreaterThan(0);
  });
});

describe("切走板块", () => {
  /**
   * ⚠️⚠️ **这一格瞄的是一个真实的、只在慢网络下出现的缺陷**：
   * 切走用量板块、换个档位再切回来时，**上一次那个还在飞的响应**回来把新数据覆盖掉。
   *
   * 装置写清（否则复现不出来）：让 `/admin/api/usage` 的第一次应答**挂住**
   *（`respond` 返回一个由本用例手动 resolve 的 Promise），在它挂着的时候
   * 点侧栏切到别的板块（触发 `onHide()`），然后才把它 resolve。
   *
   * ⚠️ **`AbortController` 一个人守不住这件事**：`tests/helpers/fake-dom.ts`
   * 那套替身里的 `fetch` **压根不看 signal**，abort 之后那个 Promise 照样 resolve
   *（真实浏览器里 abort 也是异步的，同一个竞态存在）。守住它的是
   * `sec-usage.js` 的世代号 `seq`。
   *
   * **变红条件**：把 `load()` 里 `if (mine !== seq) return;` 两处删掉
   * ⇒ 挂住的那份响应回来之后照样 `data = body` + `render()`
   * ⇒ 最后那句断言红（板块里出现了那份本该被作废的数据）。
   */
  it("切走板块时在飞请求被作废 —— 回来时不会被上一次的响应覆盖", async () => {
    let release: ((v: { status: number; body: unknown }) => void) | null = null;
    const hung = new Promise<{ status: number; body: unknown }>((res) => { release = res; });
    let usageCalls = 0;

    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "usage" },
      respond: (url) => {
        if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
        if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
        if (url.startsWith("/admin/api/usage")) {
          usageCalls++;
          return usageCalls === 1 ? hung : { status: 200, body: usageBody() };
        }
        return { status: 200, body: {} };
      },
    });
    await settle(12);
    expect(usageCalls, "第一次请求没发出去，装置本身坏了").toBe(1);

    // 切走：`showSection` 会调用户量板块的 `onHide()`。
    const navOverview = h.dom.document.querySelector("[data-section=\"overview\"]");
    expect(navOverview, "侧栏里没有概览按钮").not.toBe(null);
    navOverview!.click();
    await settle(12);

    // 现在才让那份在飞的响应回来 —— 它必须被整份丢掉。
    release!({
      status: 200,
      body: usageBody({ total: { ...usageBody().total, requests: 999_999 } }),
    });
    await settle(12);

    expect(h.section("usage").textContent, "被作废的那份响应还是渲染进去了")
      .not.toContain("999,999");
  });
});

describe("单日下钻", () => {
  const DETAIL_HOURS: Record<string, unknown> = Object.create(null);
  DETAIL_HOURS["2"] = {
    requests: 2, success: 2, errors: 0, tokensIn: 10, tokensOut: 5,
    streamingRequests: 0, latencySum: 200, latencyCount: 2,
  };
  DETAIL_HOURS["10"] = {
    requests: 5, success: 5, errors: 0, tokensIn: 20, tokensOut: 10,
    streamingRequests: 1, latencySum: 500, latencyCount: 5,
  };

  function detailBody(over: Record<string, unknown> = {}) {
    const byModel: Record<string, unknown> = Object.create(null);
    byModel["gpt-4o"] = { ...(DETAIL_HOURS["2"] as object) };
    const byProtocol: Record<string, unknown> = Object.create(null);
    byProtocol["openai"] = { ...(DETAIL_HOURS["2"] as object) };
    return {
      tier: "tier2", timezone: "UTC", date: "2026-08-21", approximate: true, generatedAt: NOW,
      hours: DETAIL_HOURS, byModel, byProtocol, shards: 2, malformed: 0,
      note: "no_request_detail",
      ...over,
    };
  }

  async function drill(detail: unknown) {
    const h = await openUsage((url) => {
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
      if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
      if (url.startsWith("/admin/api/usage/")) return { status: 200, body: detail };
      if (url.startsWith("/admin/api/usage")) return { status: 200, body: usageBody() };
      return { status: 200, body: {} };
    });
    const btn = h.section("usage").querySelector(".usage-drill");
    expect(btn, "日汇总表里没有下钻按钮").not.toBe(null);
    btn!.click();
    await settle(12);
    return h;
  }

  /**
   * **小时表按数值序**：字典序会把 `"10"` 排在 `"2"` 前面 ⇒ 一张按小时排的表
   * 上午跳到晚上再跳回来。
   *
   * **变红条件**：把 `buildDetail` 里 `breakdownTable("usage.detail.hours", …, true)`
   * 的 `true` 改成 `false` ⇒ 行序变成 `10, 2` ⇒ 第一句断言红。
   */
  it("下钻拉的是那一天的端点，小时表按数值序、并把「这里没有逐请求流水」说出来", async () => {
    const h = await drill(detailBody());
    expect(h.calls.some((c) => c.url === "/admin/api/usage/2026-08-21"), "没有打单日下钻端点").toBe(true);
    const sec = h.section("usage");
    const hourCells: string[] = [];
    for (const tr of sec.querySelectorAll("tr")) {
      for (const td of tr.querySelectorAll("td")) { hourCells.push(td.textContent); break; }
    }
    // 小时表在三张分解表里排第一，它那两行的首列必须是 2、10（数值序）。
    expect(hourCells.includes("2") && hourCells.includes("10")).toBe(true);
    expect(hourCells.indexOf("2"), "小时表按字典序排了 —— 10 会跑到 2 前面")
      .toBeLessThan(hourCells.indexOf("10"));
    expect(sec.textContent).toContain("没有逐请求流水");
  });

  /**
   * ⚠️⚠️ **下钻有自己的世代号，不共用汇总那一个。**
   *
   * 第一版共用 `seq`，而那会在一个很常见的操作序列上把下钻卡成空的：
   * 点开某一天之后**再点一次「刷新」**，`load()` 把 `seq` 顶上去，
   * 回来的那份分解就被当成过期的丢掉了 —— 而那一天明明还开着，
   * 面板上只剩一个空壳，再点一次「下钻」才会有内容。
   *
   * 装置写清：让 `/admin/api/usage/:date` 的应答**挂住**，在它挂着的时候点「刷新」
   *（那一下只会重发汇总、只顶 `seq`），然后才把下钻那份 resolve。
   *
   * **变红条件**：把 `openDay()` 里的 `detailSeq` 换回 `seq`
   *（`const mine = seq;` + `if (mine !== seq) return;`）⇒ 那份分解被丢掉
   * ⇒ 最后一句断言红。
   */
  it("下钻在飞时点刷新：那份分解照样落地 —— 重拉汇总不该作废一次仍然有效的下钻", async () => {
    let release: ((v: { status: number; body: unknown }) => void) | null = null;
    const hung = new Promise<{ status: number; body: unknown }>((res) => { release = res; });
    let detailCalls = 0;
    const h = await openUsage((url) => {
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
      if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
      if (url.startsWith("/admin/api/usage/")) { detailCalls++; return hung; }
      if (url.startsWith("/admin/api/usage")) return { status: 200, body: usageBody() };
      return { status: 200, body: {} };
    });
    h.section("usage").querySelector(".usage-drill")!.click();
    await settle(12);
    expect(detailCalls, "下钻请求没发出去，装置本身坏了").toBe(1);

    // 点「刷新」：只重发汇总。板块顶部那颗按钮是 init() 建的，在 body 之外。
    let refresh: FakeElement | null = null;
    for (const b of h.section("usage").querySelectorAll("button")) {
      if (b.getAttribute("data-i18n") === "common.refresh") { refresh = b; break; }
    }
    expect(refresh, "找不到刷新按钮").not.toBe(null);
    refresh!.click();
    await settle(12);

    release!({ status: 200, body: detailBody() });
    await settle(12);
    expect(h.section("usage").textContent, "刷新一下就把还有效的下钻丢掉了")
      .toContain("没有逐请求流水");
  });

  /**
   * ⚠️⚠️ **这一条端点根本不发 `all_malformed` / `partial_malformed`**
   *（它的 `note` 常态恒是 `no_request_detail`）⇒ 「缺了几块」只能靠
   * `shards` / `malformed` 两个字段。**同一件事，两套判据。**
   *
   * **变红条件**：把 `buildDetail` 里那段 `malformedKind(detailData)` 判断
   * 改成照 `note` 判（`detailData.note === "partial_malformed"`）⇒ 恒不成立
   * ⇒ 这一格红，而汇总卡那一格照绿。
   */
  it("下钻的「缺了几块」只能靠 shards / malformed 字段 —— 这条端点不发畸形 code", async () => {
    const h = await drill(detailBody({ shards: 2, malformed: 3 }));
    const sec = h.section("usage");
    expect(sec.textContent, "note 仍然是 no_request_detail，畸形只能从字段读出来").toContain("3 个分片是畸形的");
    // 反向锚：没有畸形分片时不许出现这句话。
    const clean = await drill(detailBody());
    expect(clean.section("usage").textContent).not.toContain("个分片是畸形的");
  });
});

describe("Token 卡的覆盖范围", () => {
  /**
   * **变红条件**：把 `buildCards` 里那条 tooltip 改成直接渲染
   * `coverage.join(" · ")`（裸 id）⇒ tooltip 里出现 `responses` 而不是
   *「OpenAI Responses」⇒ 第二句断言红。运维看不懂 `responses` 是哪个协议。
   */
  it("协议 id 换成 /admin/api/models 的 label —— 不许渲染裸 id，也不许在前端再写一张映射", async () => {
    const h = await openUsage(respondWith(usageBody()));
    let tip: string | null = null;
    for (const div of h.section("usage").querySelectorAll("div")) {
      if (div.getAttribute("data-i18n") === "usage.card.tokens") tip = div.getAttribute("title");
    }
    expect(tip, "Token 卡没有 tooltip").not.toBe(null);
    expect(tip).toContain("Anthropic Messages");
    expect(tip).toContain("OpenAI Responses");
    // 裸 id 不许出现（`responses` 是 id，`OpenAI Responses` 是 label —— 判据取
    // 那个只在 id 里出现的小写串）。
    expect(tip, "渲染了裸 id").not.toContain("anthropic");
  });

  /**
   * ⚠️⚠️ **这一格是变异 M-O 逼出来的，登记成因**：上一格用的 `tokensCoverage`
   * 夹具是 `["anthropic", "responses"]`，而把 `sec-usage.js` 里那一行
   * `const coverage = caps && caps.stats ? caps.stats.tokensCoverage : null;`
   * 换成写死的 `["anthropic", "responses"]` 之后，**42 条全绿、完整逃逸**
   * ——**第 1 种假阳性（夹具 A/B 同值）**：谁赢都通过。
   *
   * ⇒ 这一格让 capabilities 报一份**与任何「合理的写死值」都不一样**的覆盖范围
   *（只有 `gemini` 一条），于是「前端到底读没读那个字段」变得可观测。
   * 这是全局约束 15（同一份知识只许有一份）在本板块的机器信号。
   *
   * **变红条件**：把上面那一行换成任何一个写死的数组 ⇒ tooltip 里出现
   * 那份写死的名单而不是 `Google Gemini` ⇒ 下面两句同时红。
   */
  it("Token 卡的覆盖范围跟着 capabilities 走 —— 在前端写死一份就是第二份知识", async () => {
    const h = await openUsage((url) => {
      if (url.startsWith("/admin/api/capabilities")) {
        return {
          status: 200,
          body: { ...CAPS, stats: { ...CAPS.stats, tokensCoverage: ["gemini"] } },
        };
      }
      if (url.startsWith("/admin/api/models")) return { status: 200, body: MODELS };
      if (url.startsWith("/admin/api/usage")) return { status: 200, body: usageBody() };
      return { status: 200, body: {} };
    });
    let tip: string | null = null;
    for (const div of h.section("usage").querySelectorAll("div")) {
      if (div.getAttribute("data-i18n") === "usage.card.tokens") tip = div.getAttribute("title");
    }
    expect(tip, "没有跟着 capabilities 的 tokensCoverage 走").toContain("Google Gemini");
    expect(tip, "前端把覆盖范围写死了").not.toContain("Anthropic Messages");
    expect(tip, "前端把覆盖范围写死了").not.toContain("OpenAI Responses");
  });

  /**
   * **变红条件**：把 `tokensCoverageLabels` 的「一条解析不出来就整条退回 null」
   * 改成 `continue` ⇒ tooltip 变成半张名单 ⇒ 第二句断言红。
   */
  it("models 拉不到时 tooltip 换成「覆盖范围读不出来」，不给半张名单也不编一个缺省列表", async () => {
    const h = await openUsage((url) => {
      if (url.startsWith("/admin/api/capabilities")) return { status: 200, body: CAPS };
      if (url.startsWith("/admin/api/models")) return { status: 500, body: {} };
      if (url.startsWith("/admin/api/usage")) return { status: 200, body: usageBody() };
      return { status: 200, body: {} };
    });
    let tip: string | null = null;
    for (const div of h.section("usage").querySelectorAll("div")) {
      if (div.getAttribute("data-i18n") === "usage.card.tokens") tip = div.getAttribute("title");
    }
    expect(tip).toContain("覆盖了哪几条协议这一次没读出来");
    expect(tip, "拉不到 models 却还是列出了协议名").not.toContain("Anthropic Messages");
  });
});
