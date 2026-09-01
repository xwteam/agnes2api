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

async function openOverview(overview: { status: number; body: unknown }) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    respond: (url) => (url.startsWith("/admin/api/overview")
      ? overview
      : { status: 200, body: { runtime: { name: "node", colo: null } } }),
  });
  await settle();
  return h;
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
