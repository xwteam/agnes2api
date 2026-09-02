import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * **面板外壳的源码级判据**：站点图标、顶栏那条仓库链接、侧栏导航项的结构。
 *
 * 这一份与 `tests/ui/dom/shell-chrome.test.ts` 的
 * 「三颗图标按钮各自真的有一个 <svg> 图标 —— 空方块那个缺陷不许回来」是两件事：
 * 那边跑 `app.js` 看**渲染出来的东西**，这一份看**写在 HTML / CSS 里的那几条约束**
 * （它们在浏览器里生效，但一格 DOM 测试都跑不到——`<link rel="icon">` 与
 * `rel="noopener"` 都不产生任何可断言的 DOM 行为）。
 */
const HTML = readFileSync("admin-ui/index.html", "utf8");
const SHELL_CSS = readFileSync("admin-ui/css/shell.css", "utf8");

/** 一份 HTML 里 `<link rel="icon" href="…">` 的 href。没有就返回 null。 */
function faviconHref(html: string): string | null {
  const m = /<link\s+rel="icon"\s+href="([^"]*)"/.exec(html);
  return m ? m[1]! : null;
}

/** 一段文本里所有内联 PNG 的 base64 净荷（按出现顺序）。 */
function inlinePngs(text: string): string[] {
  return [...text.matchAll(/data:image\/png;base64,([A-Za-z0-9+/]+={0,2})/g)].map((m) => m[1]!);
}

/**
 * **站点图标与品牌标记 = 项目门面那张图（`docs/logo.png`）。**
 *
 * 这一组只判**摆放**：谁在用它、写在哪儿、有没有多存一份。
 * 「那几串字节是不是那张图」由 `scripts/check-png.mjs` 的 `auditUiLogos()` 逐像素对账
 * （判据在 `tests/unit/check-png.test.ts` 的「面板里内联的 PNG」那一组）。
 * ⚠️ 这里曾经有一格「favicon 里那个色值就是 base.css 的 --primary」：那时站点图标是
 * 一枚**自绘的** SVG，颜色是全站唯一一处硬编码，那一格守的就是它不许漂。
 * 现在图标不再是自绘的，那处硬编码随之消失，**取代它的是同一种守法**：
 * 硬编码的东西换成了那两串 base64，看着它们不漂的人换成了上面那道门禁。
 */
describe("面板的站点图标与品牌标记", () => {
  it("有 favicon，而且它是内联 data URI 的 PNG —— 不是独立文件、不是 /favicon.ico 那个 404", () => {
    const href = faviconHref(HTML);
    expect(href, "index.html 里没有 <link rel=\"icon\">：浏览器会去要 /favicon.ico 然后拿到 404").not.toBeNull();
    // 独立的 `.svg` 会以 image/svg+xml 挂在 /admin/ 下成为同源文档；
    // `.png` / `.ico` 连 `scripts/build-ui.mjs` 的扩展名白名单都过不去。
    // 两条都写在 admin-ui/README.md 的硬规则 2 里，这一格是它在 HTML 这一侧的落点。
    expect(href!.startsWith("data:image/png;base64,"), `favicon 不是内联 PNG：${href!.slice(0, 40)}…`).toBe(true);
  });

  it("品牌标记画在 shell.css 的 .brand-mark 背景上，用的也是内联 PNG", () => {
    const rule = /\.brand-mark\s*\{([\s\S]*?)\}/.exec(SHELL_CSS)?.[1] ?? "";
    expect(rule, "shell.css 里找不到 .brand-mark 规则").not.toBe("");
    expect(rule, ".brand-mark 的背景不是内联 PNG —— 品牌标记又回到自绘图形了？")
      .toContain('url("data:image/png;base64,');
  });

  /**
   * **同一串字节在面板里只许存一份。** 顶栏与登录闸两处标记共用 CSS 那一份背景，
   * 写成两个 `<img src="data:…">` 会让同样的字节在 HTML 里再各存一遍：
   * 体积预算多吃一份，而且多出来的每一份都是一处会漂的真源。
   * ⇒ HTML 里的内联 PNG 恰好一处（站点图标），CSS 里恰好一处（品牌标记）。
   */
  it("HTML 里恰一处内联 PNG（站点图标），shell.css 里恰一处（品牌标记）", () => {
    expect(inlinePngs(HTML).length, "index.html 里的内联 PNG 不止一处 —— 品牌标记被抄进 HTML 了？").toBe(1);
    expect(inlinePngs(HTML)[0], "那一处内联 PNG 不是 <link rel=\"icon\"> 用的那串")
      .toBe(faviconHref(HTML)!.slice("data:image/png;base64,".length));
    expect(inlinePngs(SHELL_CSS).length, "shell.css 里的内联 PNG 不止一处").toBe(1);
  });

  it("两处 .brand-mark（顶栏 + 登录闸）都是空元素，且对读屏器隐藏", () => {
    const marks = [...HTML.matchAll(/<span class="brand-mark"([^>]*)><\/span>/g)];
    expect(marks.length, "认不出 .brand-mark 了 —— 写法变了就回来改这条判据，别把它放宽成恒真").toBe(2);
    for (const m of marks) {
      // 图形是 CSS 背景，元素本身没有内容；品牌名由旁边的 .brand-name 读出来。
      expect(m[1], "品牌标记没有 aria-hidden —— 读屏器会把它读成一个空元素").toContain('aria-hidden="true"');
    }
  });

  it("该红时红：把内联 PNG 换回一枚自绘 SVG，上面三格里有两格必须红", () => {
    const drifted = HTML.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/, "data:image/svg+xml,%3Csvg%3E%3C/svg%3E");
    expect(drifted, "探针没改动任何东西 —— 夹具与真文件的写法漂了").not.toBe(HTML);
    expect(faviconHref(drifted)!.startsWith("data:image/png;base64,")).toBe(false);
    expect(inlinePngs(drifted).length).toBe(0);
  });
});

describe("顶栏的仓库链接", () => {
  const anchor = /<a class="topbar-link"([\s\S]*?)>/.exec(HTML)?.[1] ?? "";

  it("指向公开仓，且新标签页打开时带 noopener", () => {
    expect(anchor, "顶栏里找不到那条 .topbar-link").not.toBe("");
    expect(anchor).toContain('href="https://github.com/xwteam/agnes2api"');
    // `target="_blank"` 不带 `rel="noopener"` 时，被打开的页面拿得到 `window.opener`。
    expect(anchor).toContain('target="_blank"');
    expect(anchor, "target=\"_blank\" 却没有 noopener").toContain("noopener");
  });

  it("链接的悬停提示走 i18n，不是写死的一句中文", () => {
    expect(anchor).toContain('data-i18n-title="shell.repo"');
  });
});

describe("图标按钮的可及性属性", () => {
  /**
   * 图标按钮里只有一个 `<svg aria-hidden>`，**读屏器能读到的只剩 title / aria-label**，
   * 而那两样由 `apply()` 按 `data-i18n-title` 写。这一格看真 HTML 上有没有这个钩子；
   * 「写进去之后真的被渲染出来」在 `tests/ui/dom/shell-chrome.test.ts` 的
   * 「三颗按钮的 title 与 aria-label 都被 apply() 填过 —— 读屏器读得出它们是什么」那一格。
   */
  it("三颗图标按钮在 index.html 里都带着 data-i18n-title", () => {
    for (const [id, key] of [
      ["theme-btn", "shell.theme"], ["gate-theme-btn", "shell.theme"], ["logout-btn", "shell.logout"],
    ]) {
      const tag = new RegExp(`<button id="${id}"[^>]*>`).exec(HTML)?.[0] ?? "";
      expect(tag, `index.html 里找不到 #${id}`).not.toBe("");
      expect(tag, `#${id} 没有 data-i18n-title`).toContain(`data-i18n-title="${key}"`);
    }
  });
});

describe("侧栏导航项的结构", () => {
  const items = [...HTML.matchAll(/<button class="nav-item" data-section="([^"]+)">([\s\S]*?)<\/button>/g)];

  it("八项导航一项不少，每一项都是「一颗图标 + 一个带 data-i18n 的文字 span」", () => {
    expect(items.length, "认不出导航项——写法变了就回来改这条判据，别把它放宽成恒真").toBe(8);
    for (const m of items) {
      const [, section, inner] = m;
      expect(inner, `${section} 这一项没有图标 span`).toMatch(/<span class="nav-ico" aria-hidden="true">.+<\/span>/);
      expect(inner, `${section} 的文字没有单独占一个 span —— apply() 会把图标一起抹掉`)
        .toContain(`<span data-i18n="nav.${section}">`);
    }
  });

  it("图标是装饰性的：每一颗都带 aria-hidden，读屏器读到的只有文字", () => {
    const icons = [...HTML.matchAll(/<span class="nav-ico"([^>]*)>/g)].map((m) => m[1]!);
    expect(icons.length).toBe(8);
    for (const attrs of icons) expect(attrs).toContain('aria-hidden="true"');
  });
});
