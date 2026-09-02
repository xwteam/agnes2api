import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **顶栏与登录闸上那几颗图标按钮的行为覆盖。**
 *
 * 这一组瞄的是一个真的上线过的缺陷：`#theme-btn` 与 `#logout-btn` 在
 * `admin-ui/index.html` 里**字面上是空的**（只有 `data-i18n-title`，悬停才有提示），
 * 屏幕上是两个 32×32 的空方块。当时字典里 `shell.theme` / `shell.logout` 五种语言
 * 的文案齐全 —— **齐全的文案与被渲染出来的文案是两件事**，而当时没有任何一格看着后者。
 *
 * ⚠️ **`index.html` 里那几颗按钮今天仍然是空标签，这是有意的**：图标由
 * `admin-ui/js/app.js` 用 `js/ui.js` 的 `svgIcon()` 插进来（全站唯一那份
 * `createElementNS` 实现）。所以这一组必须**跑一遍 app.js** 才测得到，
 * 光扫 HTML 源码只会看见空标签而误判成"缺陷还在"。
 */
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 一颗按钮里第一个 `<svg>` 子元素；没有就返回 null。 */
function iconOf(btn: FakeElement): FakeElement | null {
  return btn.children.find((c) => c.tagName.toLowerCase() === "svg") ?? null;
}

const ICON_BUTTONS = ["theme-btn", "logout-btn", "gate-theme-btn"] as const;

describe("顶栏 / 登录闸的图标按钮", () => {
  it("三颗图标按钮各自真的有一个 <svg> 图标 —— 空方块那个缺陷不许回来", async () => {
    const h = await bootPanel();
    for (const id of ICON_BUTTONS) {
      const icon = iconOf(h.dom.byId(id));
      expect(icon, `#${id} 里没有 <svg> —— 它又变回一个空方块了`).not.toBeNull();
      // **不只是"有个 svg"**：空的 `<svg>` 与没有 svg 在屏幕上长得一模一样。
      const path = icon!.children.find((c) => c.tagName.toLowerCase() === "path");
      expect(path, `#${id} 的 <svg> 里没有 <path>`).not.toBeUndefined();
      expect((path!.getAttribute("d") ?? "").length, `#${id} 的图标 path 是空的`).toBeGreaterThan(0);
    }
  });

  it("三颗按钮的 title 与 aria-label 都被 apply() 填过 —— 读屏器读得出它们是什么", async () => {
    const h = await bootPanel();
    for (const id of ICON_BUTTONS) {
      const btn = h.dom.byId(id);
      const title = btn.getAttribute("title") ?? "";
      expect(title, `#${id} 没有 title`).not.toBe("");
      // 裸 key 不算文案：`t()` 找不到 key 时原样返回 key 本身。
      expect(title, `#${id} 的 title 是裸的 i18n key`).not.toMatch(/^shell\./);
      expect(btn.getAttribute("aria-label"), `#${id} 的 aria-label 与 title 不一致`).toBe(title);
    }
  });

  /**
   * **登录闸上那颗主题按钮真的切得动主题。**
   * 变异：把 `app.js` 里 `gate-theme-btn` 那条 `addEventListener` 删掉 ⇒ 这一格变红。
   */
  it("登录之前就切得动主题：点一下 #gate-theme-btn，<html> 上的 data-theme 跟着变", async () => {
    const h = await bootPanel();
    const html = h.dom.document.documentElement;
    expect(html.getAttribute("data-theme"), "前置条件：默认是亮色（属性被移除）").toBeNull();

    h.dom.byId("gate-theme-btn").click();
    await settle(1);
    expect(html.getAttribute("data-theme"), "点了登录闸上的主题按钮，主题没变").toBe("dark");

    h.dom.byId("gate-theme-btn").click();
    await settle(1);
    expect(html.getAttribute("data-theme"), "再点一下没切回亮色").toBeNull();
  });

  /** 顶栏那颗与登录闸那颗是**同一个开关的两个入口**，切出来的必须是同一档。 */
  it("顶栏那颗与登录闸那颗切的是同一个开关", async () => {
    const h = await bootPanel();
    const html = h.dom.document.documentElement;
    h.dom.byId("gate-theme-btn").click();
    await settle(1);
    expect(html.getAttribute("data-theme")).toBe("dark");
    h.dom.byId("theme-btn").click();
    await settle(1);
    expect(html.getAttribute("data-theme"), "两颗按钮各切各的 —— 那是两个开关，不是一个").toBeNull();
  });
});

describe("侧栏导航：图标与文字是两个 span", () => {
  /**
   * **`apply()` 对 [data-i18n] 写的是 `textContent`。** 把 `data-i18n` 标在导航按钮
   * 自己身上，切一次语言就会把按钮里那颗图标一起抹掉 —— 所以文字必须自己占一个 span。
   * 这一格直接切一次语言再看图标还在不在，不是去比 HTML 的写法。
   */
  it("切语言之后导航项的图标还在（data-i18n 标错地方会把图标抹掉）", async () => {
    const h = await bootPanel();
    const btn = h.dom.document.querySelector(".nav-item")!;
    const ico = btn.children[0]!;
    ico.textContent = "📊";
    expect(btn.children.length, "前置条件：导航按钮里是图标 + 文字两个 span").toBe(2);

    const sel = h.dom.byId("lang-select");
    sel.value = "en";
    sel.change();
    await settle();

    expect(btn.children.length, "切语言把导航按钮的子节点数改了 —— 图标多半被 textContent 抹了").toBe(2);
    expect(btn.children[0]!.textContent, "切语言之后图标没了").toBe("📊");
    expect(btn.children[1]!.textContent, "切语言之后文字没跟着换").toBe("Overview");
  });
});
