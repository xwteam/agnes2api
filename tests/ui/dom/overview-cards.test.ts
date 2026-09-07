import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **面板行为覆盖目标 ⑥：四张池子卡 / 四张汇总卡不许伪造 `0`。**
 *
 * 这是本项目**产品不变式**里最要紧的一条——「面板绝不撒谎」。读不出来时显示 `0`
 * 与显示 `—` 在屏幕上只差一个字符，对运维却是两件完全相反的事：
 * 前者是「池子空了 / 一次请求都没有」，后者是「这块没读到」。
 * 一个正在排障的人照着假 `0` 会去重新导 key，而真相可能是接口 500。
 *
 * `pure/overview.mjs` 的 `poolCounts` / `usageStats` / `fmtCount` 各自都被测得很细，
 * **但没有任何东西验证板块文件真的把它们的 `null` 渲染成了 `—`**。
 * 把 `renderPoolCards()` 里的 `fmtCount(c[card])` 换成 `c[card] ?? 0`，
 * 在这一组出现之前全套用例一条都不红。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;
const DASH = "—";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 概览板块里全部 `.card` 的「标签 → 值」。 */
function cards(section: FakeElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const card of section.querySelectorAll(".card")) {
    const label = card.querySelectorAll("div").find((d) => d.classList.contains("label"));
    const value = card.querySelectorAll("div").find((d) => d.classList.contains("value"));
    if (label && value) out[label.getAttribute("data-i18n") ?? label.textContent] = value.textContent;
  }
  return out;
}

/**
 * 打开概览板块。
 *
 * `caps` 是 `GET /admin/api/capabilities` 的响应体，**默认那一份刻意不带 `stats`**
 *（= 「我们不知道统计开没开」），保持这个文件里既有那些格的行为不变。
 */
async function openOverview(
  overview: { status: number; body: unknown },
  caps: unknown = { runtime: { name: "node", colo: null } },
) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    respond: (url) => (url.startsWith("/admin/api/overview")
      ? overview
      : { status: 200, body: caps }),
  });
  await settle();
  return h;
}

/**
 * 累计用量卡底下那句尾巴：现在挂的是哪个 key、屏幕上是哪句话。
 *
 * ⚠️ **`data-i18n` 也要读**：那一句的 key 是会变的，而切语言时框架层的
 * `apply(document)` 照着 `data-i18n` 重译 —— 只把文字写对、key 留在旧的那一个，
 * 切一次语言就会翻回上一版那句话，而**只看 textContent 的判据对这件事是瞎的**。
 */
function usageTip(section: FakeElement): { key: string | null; text: string } {
  for (const p of section.querySelectorAll("p")) {
    const key = p.getAttribute("data-i18n");
    if (key === "ov.usage.tip" || key === "ov.usage.tipTier2Off") return { key, text: p.textContent };
  }
  return { key: null, text: "" };
}

const FULL = {
  status: 200,
  body: {
    version: "0.1.0",
    serverTime: NOW,
    runtime: { name: "node" },
    process: { rssBytes: 42_000_000, uptimeMs: 3_600_000, pid: 7 },
    pool: { total: 5, fresh: 2, cooling: 1, evicted: 1, disabled: 1 },
    poolStats: { requests: 100, success: 90, failed: 7, clientErrors: 3, approximate: true },
    storage: { backend: "file", writable: true, checkedAt: NOW },
    freshness: {
      poolCacheTtlMs: 60_000, poolVisibilityUpperBoundMs: 120_000,
      poolTouchIntervalMs: 21_600_000, configTtlMs: 30_000,
      configVisibilityUpperBoundMs: 90_000, kvEdgeCacheMs: 60_000,
    },
    config: {
      registrarEnabled: true, primary: "a.example.com", fallback: "b.example.com",
      targetKeys: 20, envLocked: [], degraded: false,
    },
  },
};

const POOL_LABELS = [
  "ov.pool.total", "ov.pool.fresh", "ov.pool.cooling", "ov.pool.evicted", "ov.pool.disabled",
];
const USAGE_LABELS = ["ov.usage.requests", "ov.usage.success", "ov.usage.failed", "ov.usage.clientErrors"];

describe("概览板块：读不出来时显示破折号，绝不伪造 0", () => {
  /**
   * **反向自检必须在最前**：有数据时那四张卡显示的必须是真实的数字。
   * 少了它，「一律显示 —」也能让下面每一格全绿，而那样面板就永远不报数了。
   */
  it("有数据时五张池子卡显示真实数字（不是一律破折号）", async () => {
    const h = await openOverview(FULL);
    const c = cards(h.section("overview"));
    expect(POOL_LABELS.map((l) => c[l])).toEqual(["5", "2", "1", "1", "1"]);
    // 五格里的后四格之和必须等于总数——少渲染一格的话，屏幕上那几把 key 就凭空消失了。
    expect(["2", "1", "1", "1"].reduce((a, b) => a + Number(b), 0)).toBe(Number(c["ov.pool.total"]));
  });

  it("有数据时四张汇总卡也显示真实数字", async () => {
    const h = await openOverview(FULL);
    const c = cards(h.section("overview"));
    for (const [label, want] of [
      ["ov.usage.requests", "100"], ["ov.usage.success", "90"],
      ["ov.usage.failed", "7"], ["ov.usage.clientErrors", "3"],
    ] as const) {
      // `≈` 前缀由后端的 `approximate` 驱动，值本身跟在它后面。
      expect(c[label], label).toContain(want);
    }
  });

  /**
   * **整段读失败（500）：八张卡全部破折号，一个 `0` 都不许出现。**
   * 变异：`renderPoolCards()` 里把 `fmtCount(c[card])` 换成 `c[card] ?? 0`
   *（或 `fmtCount` 对 `null` 返回 `"0"`）⇒ 这一格变红。
   */
  it("接口 500：五张池子卡 + 四张汇总卡全是破折号", async () => {
    const h = await openOverview({ status: 500, body: { error: { message: "boom" } } });
    const c = cards(h.section("overview"));
    for (const label of [...POOL_LABELS, ...USAGE_LABELS]) {
      expect(c[label], `${label} 在读失败时伪造了一个数字`).toContain(DASH);
      expect(c[label], `${label} 在读失败时显示了 0`).not.toMatch(/\b0\b/);
    }
  });

  /**
   * **逐块降级：只有 `pool` 这一块缺失时，池子卡破折号、汇总卡照常报数。**
   *
   * 这一格挡的是「读失败 ⇒ 整页一律破折号」这种**过度**的实现：那同样是撒谎
   *（后端明明把 usage 那一块给出来了）。两个方向合起来才把语义钉死。
   */
  it("只缺 pool 这一块：池子卡破折号，而汇总卡仍然报真实数字", async () => {
    const body = { ...(FULL.body as Record<string, unknown>) };
    delete body.pool;
    const h = await openOverview({ status: 200, body });
    const c = cards(h.section("overview"));
    for (const label of POOL_LABELS) expect(c[label], label).toContain(DASH);
    expect(c["ov.usage.requests"], "usage 这一块明明是好的，却被一起抹成了破折号").toContain("100");
  });

  /**
   * **`≈` 标记必须由后端的 `approximate` 字段驱动**，不许在前端硬编码。
   *
   * 它是产品不变式的一部分（近似值必须打标）：Tier-1 的计数会因为写消除而
   * 少计、且最多晚一个 `POOL_TOUCH_INTERVAL_MS` 才落盘，不打标就是把一个近似值
   * 当精确值报给运维。两个方向都断言：只测「true 时有标记」的话，
   * 「一律加标记」也全绿——那会让一份精确数据被无端标成近似的。
   */
  it("approximate=true 时汇总卡带 ≈ 标记，false 时不带", async () => {
    for (const approximate of [true, false]) {
      const body = JSON.parse(JSON.stringify(FULL.body)) as Record<string, Record<string, unknown>>;
      body.poolStats!.approximate = approximate;
      const h = await openOverview({ status: 200, body });
      const c = cards(h.section("overview"));
      expect(
        c["ov.usage.requests"]!.includes("≈"),
        `approximate=${approximate} 时 ≈ 标记不对`,
      ).toBe(approximate);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  /**
   * **降级横幅由 `config.degraded` 驱动**（`src/core/config.ts` 那条三级消费链的
   * 最后一级）。链一断，面板会**安静地**不再报「保存了却没生效」——
   * 这个项目最高频的用户困惑就此变成不可见。
   */
  it("config.degraded 为 true 时红色横幅出现，false 时藏起来", async () => {
    for (const degraded of [true, false]) {
      const body = JSON.parse(JSON.stringify(FULL.body)) as Record<string, Record<string, unknown>>;
      body.config!.degraded = degraded;
      const h = await openOverview({ status: 200, body });
      const banner = h.section("overview").querySelectorAll("div")
        .find((d) => d.getAttribute("data-i18n") === "ov.config.degradedBanner")!;
      expect(banner, "降级横幅那个节点整个不见了").toBeTruthy();
      expect(banner.style.display === "none", `degraded=${degraded} 时横幅可见性不对`).toBe(!degraded);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

describe("累计用量卡底下那句尾巴：不许把一个已经开着统计的部署从「用量」板块支开", () => {
  /**
   * ⚠️⚠️ **这一句上一版是无条件渲染的，而它对一半的部署是误导。**
   *
   * `sec-overview.js` 的 `buildUsageCard()` 里原本是
   * `body.appendChild(elI18n("p", "ov.usage.tip", …))` —— 一个不看任何字段的
   * `appendChild`，说的是「按天/按小时的分解要等启用时间序列统计之后才有」。
   * 对一个**已经打开** `USAGE_STATS_ENABLED` 的运维，这句话把他从「用量」板块支开，
   * 而那个板块此刻正挂着「还有 N 条计数没有落盘」的横幅 —— 正是他该去看的东西。
   *
   * ⚠️ **没有为它新增任何后端字段**：`stats.tier2Enabled` 是
   * `src/http/admin/handlers/capabilities.ts` 早就在发的，概览板块也早就把
   * `/capabilities` 拉进来了（`loadCapabilities()`）。这一格顺带钉住
   * **capabilities 回来之后真的重渲了一次**（`onShow()` 里那条 `.then(() => render())`）。
   *
   * **变红条件**（真跑过）：把 `usageTipKey` 改成恒返回 `"ov.usage.tipTier2Off"`
   * ⇒ 这一格红（`expected 'ov.usage.tipTier2Off' to be 'ov.usage.tip'`），连同下面
   * 「capabilities 读不出来时不许默认当成「关着」」那一格，以及 `tests/ui/overview.test.ts`
   * 的「统计开着的时候不用那句「要等启用之后才有」」与
   * 「拉不到 capabilities / 字段缺席 / 字段不是布尔 ⇒ 用那句无论开没开都成立的话」两格，共 4 格。
   *
   * ⚠️ **它单独一格拦不住「退回无条件渲染」**：实测把 `renderUsage()` 末尾那三行
   * 删掉之后这一格**照绿**（默认 key 本来就是 `ov.usage.tip`）—— 拦住那一种回退的是
   * 下面「确知统计关着时……」那一格，两格缺一不可。
   */
  it("统计开着时那句尾巴指向「用量」板块，不再说「要等启用之后才有」", async () => {
    const h = await openOverview(FULL, {
      runtime: { name: "node", colo: null },
      stats: { tier2Enabled: true, flushIntervalMs: 60_000, tokensCoverage: [] },
    });
    const tip = usageTip(h.section("overview"));
    expect(tip.key, "那句尾巴整个不见了 ⇒ 这一格测的是空气").toBe("ov.usage.tip");
    expect(tip.text, "开着统计的部署还在被那句话支开").not.toContain("要等启用");
    expect(tip.text, "没告诉他分解在哪个板块").toContain("「用量」板块");
    // 装置自检：这一句仍然守着它原本那半件事（「累计」不是「今日」）。
    expect(tip.text, "「不是今日」那半句被顺手删了").toContain("不是「今日」");
  });

  /**
   * **反向锚：确知关着时那句「怎么开」必须还在。**
   *
   * 少了这一格，把 `usageTipKey` 改成恒返回 `"ov.usage.tip"` 也能让上一格全绿
   * —— 而那样一个**没开**统计的部署就再也没人告诉他「分解要先开统计」了。
   *
   * **变红条件**（两条都真跑过）：把 `usageTipKey` 改成恒返回 `"ov.usage.tip"`
   * ⇒ 这一格 + `tests/ui/overview.test.ts` 的「确知关着的时候才多说一句「怎么开」」共 2 格；
   * 把 `renderUsage()` 末尾那三行删掉（退回无条件渲染）⇒ **只红这一格**
   * ——那一种回退在全仓只有它拦得住。
   */
  it("确知统计关着时，那句尾巴仍然说清「要先开」以及开法在哪", async () => {
    const h = await openOverview(FULL, {
      runtime: { name: "node", colo: null },
      stats: { tier2Enabled: false, flushIntervalMs: 60_000, tokensCoverage: [] },
    });
    const tip = usageTip(h.section("overview"));
    expect(tip.key, "关着的那一版没挂上").toBe("ov.usage.tipTier2Off");
    expect(tip.text, "没开统计的部署被告知分解「在用量板块」，去了却只有一张说明卡")
      .toContain("要等开启之后才有");
  });

  /**
   * **拉不到 `/capabilities` 时用那句「无论开没开都成立」的话，不是默认当成关着。**
   *
   * 这一格钉的是 `loadCapabilities()` **吞掉异常之后不许把 `caps` 兜底成「关着」**：
   * 异常被吞掉之后 `caps` 必须原样停在 `null`，那一档走的是 `usageTipKey` 里
   * `c && typeof c === "object" && …` 的短路支 ⇒ 默认那句无论开没开都成立的话。
   *
   * ⚠️⚠️ **它钉不到白名单方向**（**复评实测订正**：上一版这里写「钉的是 `usageTipKey`
   * 的白名单方向在真实那条链上也成立」，那句是假的）：`caps === null` 时 `c` 就是 `null`，
   * `=== false` 与 `!(… === true)` 在这一档上**根本走不到**，两种写法这一格都绿。
   * 白名单方向由 `tests/ui/overview.test.ts` 的「拉不到 capabilities / 字段缺席 /
   * 字段不是布尔 ⇒ 用那句无论开没开都成立的话」那个循环里 `{stats:{}}` 起的后三条
   * 独家钉着 —— 别把它们当成重复项删掉，理由与实测写在那一格自己的注释里。
   *
   * **变红条件**（复评实测，跑那四份共 131 格）：把 `admin-ui/js/sec-overview.js` 的
   * `loadCapabilities()` 那个 `catch` 改成 `caps = { stats: { tier2Enabled: false } };`
   *（读不到就默认当成关着）⇒ **只红这一格**（`Tests 1 failed | 130 passed`，
   * 报文 `expected 'ov.usage.tipTier2Off' to be 'ov.usage.tip'`）。
   */
  it("capabilities 读不出来时不许默认当成「关着」", async () => {
    // ⚠️ **只让 `/capabilities` 这一条 500**：整份 responder 一起 500 的话，
    //    面板开机那次「已存过口令就直接验一次」也会失败 ⇒ 停在口令门上、
    //    板块压根没建出来 —— 这一格会变成一句恒真的空转（实测过，`tip.key` 是 null）。
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
      respond: (url) => {
        if (url.startsWith("/admin/api/overview")) return FULL;
        if (url.includes("/capabilities")) return { status: 500, body: { error: { message: "boom" } } };
        return { status: 200, body: {} };
      },
    });
    await settle();
    const tip = usageTip(h.section("overview"));
    expect(tip.key, "读不出来被当成了「确知关着」").toBe("ov.usage.tip");
    expect(tip.text.length, "那句尾巴是空的").toBeGreaterThan(0);
  });
});
