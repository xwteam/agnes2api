import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  healthState, healthBadge, HEALTH_TEXT_KEY, HEALTH_BADGE_CLASS,
} from "../../admin-ui/js/pure/health.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";

/**
 * **顶栏状态徽章的取值决策。**
 *
 * 这一组瞄的是一条产品红线：**不许放一个恒为「运行中」的徽章**。所以下面每一格
 * 都在问同一个问题的不同侧面 —— 判不出来的时候它说的是「不知道」还是「运行中」。
 */
describe("/health 应答 → 徽章档位", () => {
  it("200 + status:ok ⇒ 运行中", () => {
    expect(healthState({ status: 200, body: { status: "ok", version: "0.0.0" } })).toEqual({ kind: "ok" });
  });

  /**
   * **降级那一档回的是 503。** 按「`res.ok` 才算数」写的话它会掉进 `unknown`，
   * 而这一档恰恰是最该被看清的：数据目录不可写、key 池落不了盘。
   * 变异：把 `healthState` 改成先看状态码 ⇒ 这一格变红。
   */
  it("503 + status:degraded ⇒ 已降级（状态码不是 2xx 也照样认）", () => {
    expect(healthState({ status: 503, body: { status: "degraded", storage: { writable: false } } }))
      .toEqual({ kind: "degraded" });
  });

  it.each([
    ["网络失败（探测函数拿不到任何应答）", null],
    ["应答不是 JSON", { status: 200, body: null }],
    ["应答是 JSON，但 status 是个没见过的值", { status: 200, body: { status: "starting" } }],
    ["应答是 JSON，但压根没有 status 这一格", { status: 200, body: {} }],
    ["body 是个字符串，不是对象", { status: 200, body: "ok" }],
  ])("%s ⇒ 状态未知（fail closed，不许滑进「运行中」）", (_why, probe) => {
    expect(healthState(probe as never)).toEqual({ kind: "unknown" });
  });

  it("反向自检：这几格不是恒等于 unknown —— 上面那两格真的分得出来", () => {
    const kinds = new Set([
      healthState({ status: 200, body: { status: "ok" } }).kind,
      healthState({ status: 503, body: { status: "degraded" } }).kind,
      healthState(null as never).kind,
    ]);
    expect(kinds, "三种输入被判成了同一档 —— 那这一组的其余几格都是空转").toEqual(
      new Set(["ok", "degraded", "unknown"]),
    );
  });
});

describe("档位 → 文案与配色", () => {
  it("三档各有自己的文案 key，且都真的在字典里（五种语言由 i18n 那一组保证）", () => {
    const dict = I18N as Record<string, Record<string, string>>;
    for (const [kind, key] of Object.entries(HEALTH_TEXT_KEY)) {
      expect(dict[key], `${kind} 用的 ${key} 不在字典里 —— 徽章上会显示裸 key`).toBeDefined();
    }
  });

  it("认不出来的档一律按 unknown 走 —— 不许返回一个 undefined 的文案 key", () => {
    expect(healthBadge("nonsense-kind")).toEqual(healthBadge("unknown"));
    expect(healthBadge("").textKey).toBe(HEALTH_TEXT_KEY.unknown);
  });

  /**
   * **`unknown` 刻意没有颜色类**：`.badge` 的底样式本身是中性灰。给它套一个报警色
   * 会把「我不知道」说成「出事了」；套绿色则是把它说成「没事」。
   */
  it("unknown 不带颜色类，ok / degraded 各带一个真的在 CSS 里声明过的类", () => {
    expect(HEALTH_BADGE_CLASS.unknown).toBe("");
    const css = readFileSync("admin-ui/css/sections.css", "utf8");
    for (const kind of ["ok", "degraded"] as const) {
      const cls = HEALTH_BADGE_CLASS[kind];
      expect(cls, `${kind} 没有配色类`).not.toBe("");
      expect(css, `CSS 里没有 .${cls} 这条规则 —— 徽章会是一个没有颜色的类名`).toContain(`.${cls} {`);
    }
  });

  it("ok 与 degraded 的配色类不是同一个 —— 两档在屏幕上必须长得不一样", () => {
    expect(HEALTH_BADGE_CLASS.ok).not.toBe(HEALTH_BADGE_CLASS.degraded);
  });
});
