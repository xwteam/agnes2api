import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, LANG_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { I18N } from "../../../admin-ui/js/i18n-dict.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **B1 目标 ⑤：五种语言 × 三个板块，渲染出来的字里零裸 key、零未替换的 `{}`。**
 *
 * ⚠️ **这一组正是"输出层预言机"那条论据的落点。** 本仓已经栽过两次同型：
 * · 已上线的 `{count}` 泄漏：面板上出现「被环境变量锁定的字段数：{count}: …：1」。
 *   `scripts/check-i18n.mjs` 为它补了第 ⑧ 条**源码文本**判据，而那条判据第一版
 *   只认双引号——把同一个缺陷换成单引号原样重放，门禁 exit 0、零报错。
 * · `elI18n("h2", "ov.title")` 打成 `"ov.titel"`：**三道 i18n 门禁全部沉默**，
 *   概览页主标题在五种语言下原样显示 `ov.titel`。
 *
 * **源码文本门禁必须猜缺陷长成什么语法；渲染文本断言不用猜。** 不管 key 是拼错的、
 * 是动态拼出来的、还是参数忘了传，只要屏幕上出现了运维读不懂的字，这里就红。
 *
 * 边界（明写）：它证明的是"没有明显是给机器看的记号漏到屏幕上"，
 * **不证明译文准确、也不证明句子通顺**——那两层留给评审。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;
const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 一份"什么都齐全"的后端响应：让每个板块都走到有数据的分支。 */
function respond(url: string): { status: number; body: unknown } {
  if (url.startsWith("/admin/api/overview")) {
    return {
      status: 200,
      body: {
        version: "0.1.0",
        serverTime: NOW,
        runtime: { name: "node" },
        process: { rssBytes: 42_000_000, uptimeMs: 3_600_000, pid: 7 },
        pool: { total: 4, fresh: 2, cooling: 1, evicted: 1 },
        poolStats: { requests: 100, success: 90, failed: 7, clientErrors: 3, approximate: true },
        storage: { backend: "file", writable: true, checkedAt: NOW },
        freshness: {
          poolCacheTtlMs: 60_000, poolVisibilityUpperBoundMs: 120_000,
          poolTouchIntervalMs: 21_600_000, configTtlMs: 30_000,
          configVisibilityUpperBoundMs: 90_000, kvEdgeCacheMs: 60_000,
        },
        config: {
          registrarEnabled: true, primary: "a.example.com", fallback: "b.example.com",
          targetKeys: 20, envLocked: ["maxStrikes"], degraded: true,
        },
      },
    };
  }
  if (url.startsWith("/admin/api/capabilities")) {
    return { status: 200, body: { runtime: { name: "node", colo: null }, storage: { writable: true } } };
  }
  if (url.startsWith("/admin/api/keys")) {
    return {
      status: 200,
      body: {
        items: [{
          id: "abc12345", masked: "sk-ab…mnop", seq: 1, bucket: "cooling",
          addedAt: NOW - 86_400_000, lastUsedAt: NOW - 3_600_000,
          cooldownUntil: NOW + 60_000, cooldownReason: "429", evictedReason: null, strikes: 2,
          stats: { requests: 10, success: 8, failed: 1, clientErrors: 1, lastErrorAt: NOW, lastErrorKind: "429" },
        }],
        counts: { all: 1, fresh: 0, cooling: 1, evicted: 0 },
        page: 1, pages: 1, size: 20, total: 1, generatedAt: NOW, approximate: true,
      },
    };
  }
  if (url.startsWith("/admin/api/events")) {
    return {
      status: 200,
      body: {
        items: [
          { ts: NOW, level: "warn", event: "pool.cooldown", msg: "一把 key 进冷却", fields: { id: "abc" }, corr: null },
          { ts: NOW - 1, level: "bogus", event: "x.y", msg: "", fields: null, corr: null },
        ],
        cursor: NOW, cursorAhead: true, dropped: 3, budgetExhausted: true,
        truncated: true, buffered: 2, shardId: "shard-1", generatedAt: NOW,
      },
    };
  }
  return { status: 200, body: {} };
}

/** 一棵子树里所有**真正显示给人看**的文本片段。 */
function visibleTexts(root: FakeElement): Array<{ text: string; where: string }> {
  const out: Array<{ text: string; where: string }> = [];
  for (const el of root.walk()) {
    // 只取叶子节点自己的那段文本（父节点的 textContent 是子节点拼起来的，重复计）。
    if (el.children.length === 0 && el.textContent.trim() !== "") {
      out.push({ text: el.textContent, where: `<${el.tagName}>` });
    }
    // tooltip / aria-label 同样是给人读的字。
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const v = el.getAttribute(attr);
      if (v !== null && v.trim() !== "") out.push({ text: v, where: `<${el.tagName} ${attr}>` });
    }
  }
  return out;
}

/** 一段文本看起来像不像"没被翻译的 i18n key"。 */
const BARE_KEY = /(?:^|\s)(gate|nav|shell|common|reg|keys|ov|ev)\.[A-Za-z][A-Za-z0-9.]*(?:\s|$)/;
/** 没被替换掉的插值记号。 */
const LEFTOVER_PLACEHOLDER = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

describe("五语言 × 三板块：渲染出来的字里没有给机器看的记号", () => {
  for (const lang of LANGS) {
    it(`${lang}：三个板块渲染出的每一段文字都不是裸 key、也没有未替换的 {占位符}`, async () => {
      const h = await bootPanel({
        now: NOW,
        store: {
          [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [LANG_STORE]: lang,
        },
        respond,
      });
      await settle();

      // 逐个板块点进去，让三棵子树都真的被渲染过一遍。
      for (const name of ["overview", "keys", "events"] as const) {
        h.dom.document.querySelectorAll(".nav-item")
          .find((b) => b.getAttribute("data-section") === name)!
          .click();
        await settle();
      }

      const offenders: string[] = [];
      for (const name of ["overview", "keys", "events"] as const) {
        const texts = visibleTexts(h.section(name));
        // 反向自检：某个板块一个字都没渲染出来时，下面的循环恒绿。
        expect(texts.length, `${name} 板块一个字都没渲染出来，这一格什么都没验到`).toBeGreaterThan(5);
        for (const { text, where } of texts) {
          if (BARE_KEY.test(text)) offenders.push(`${name} ${where} 裸 key: ${text}`);
          if (LEFTOVER_PLACEHOLDER.test(text)) offenders.push(`${name} ${where} 未替换的占位符: ${text}`);
        }
      }
      expect(offenders, `${lang} 下面板上出现了给机器看的记号`).toEqual([]);
    });
  }

  /**
   * **量具自检**：把一个真实的 key 打错一个字，上面那组必须变红。
   *
   * 没有这一格的话，`BARE_KEY` 正则写错（比如漏了一个命名空间）会让整组恒绿，
   * 而它恰恰是本仓「判据建在缺陷没采取的那个形态上」踩过两次的地方。
   * 这里直接对判据本身取样，不去改被测源码。
   */
  it("量具自检：判据认得出裸 key 与未替换的占位符", () => {
    expect(BARE_KEY.test("ov.titel")).toBe(true);
    expect(BARE_KEY.test("ev.level.debug")).toBe(true);
    expect(BARE_KEY.test("被环境变量锁定的字段数：{count}")).toBe(false);
    expect(LEFTOVER_PLACEHOLDER.test("被环境变量锁定的字段数：{count}")).toBe(true);
    // 反向：正常译文不许被误判。
    for (const key of ["ov.title", "ev.title", "keys.title"]) {
      for (const lang of LANGS) {
        const s = (I18N as Record<string, Record<string, string>>)[key]![lang]!;
        expect(BARE_KEY.test(s), `${key}/${lang} 被误判成裸 key`).toBe(false);
        expect(LEFTOVER_PLACEHOLDER.test(s), `${key}/${lang} 被误判成占位符残留`).toBe(false);
      }
    }
  });

  /**
   * **切语言之后整页真的重绘。**
   *
   * `app.js` 的 `langchange` 处理器是「`apply(document)` + 重跑当前板块的
   * `onShow()`」。删掉其中任何一半，面板都会有一半文字停在旧语言上——
   * 而在这一格出现之前**没有任何东西会红**。
   */
  it("切语言之后当前板块的文字真的跟着换（两半接线都在）", async () => {
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [LANG_STORE]: "zh-CN" },
      respond,
    });
    await settle();
    const before = h.section("overview").textContent;
    expect(before, "前置条件：概览板块得先渲染出内容").not.toBe("");

    const sel = h.dom.byId("lang-select");
    sel.value = "en";
    sel.change();
    await settle();

    const after = h.section("overview").textContent;
    expect(after, "切语言之后概览板块的文字一点都没变").not.toBe(before);
    // 具体锚一句：英文标题必须真的出现。
    expect(after).toContain((I18N as Record<string, Record<string, string>>)["ov.title"]!.en!);
  });
});
