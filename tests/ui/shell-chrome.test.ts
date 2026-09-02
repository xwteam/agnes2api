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
const BASE_CSS = readFileSync("admin-ui/css/base.css", "utf8");

/** 亮色 `:root` 块里某个 token 的取值。取不到就抛——静默返回 undefined 会让下面那格空转。 */
function lightToken(css: string, name: string): string {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css);
  if (!root) throw new Error("base.css 里找不到 :root 块——这一格测的是空气");
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(root[1]!);
  if (!m) throw new Error(`base.css 的 :root 里找不到 ${name}`);
  return m[1]!.trim();
}

/** 一份 HTML 里 `<link rel="icon" href="…">` 的 href。没有就返回 null。 */
function faviconHref(html: string): string | null {
  const m = /<link\s+rel="icon"\s+href="([^"]*)"/.exec(html);
  return m ? m[1]! : null;
}

/** favicon 的 data URI 里出现过的十六进制色值（`%23` 是被百分号编码的 `#`）。 */
function faviconColors(href: string): string[] {
  return [...href.matchAll(/%23([0-9a-fA-F]{6})/g)].map((m) => `#${m[1]!.toLowerCase()}`);
}

describe("面板的站点图标", () => {
  it("有 favicon，而且它是内联 data URI 的 SVG —— 不是独立文件、不是二进制", () => {
    const href = faviconHref(HTML);
    expect(href, "index.html 里没有 <link rel=\"icon\">：浏览器会去要 /favicon.ico 然后拿到 404").not.toBeNull();
    // 独立的 `.svg` 会以 image/svg+xml 挂在 /admin/ 下成为同源文档；
    // `.png` / `.ico` 连 `scripts/build-ui.mjs` 的扩展名白名单都过不去。
    // 两条都写在 admin-ui/README.md 的硬规则 2 里，这一格是它在 HTML 这一侧的落点。
    expect(href!.startsWith("data:image/svg+xml,"), `favicon 不是内联 SVG：${href}`).toBe(true);
  });

  /**
   * **硬编码色值的那一处不许自己漂。** 面板其余地方一律 `var(--…)`，而 data URI 里
   * 引用不到 CSS 变量 ⇒ favicon 的颜色只能写死。写死的代价就是这一格：
   * 改了 `base.css` 的主色而没改 `index.html`，站点图标会留在旧配色上。
   */
  it("favicon 里那个色值就是 base.css 的 --primary —— 硬编码的那一处不许自己漂", () => {
    const primary = lightToken(BASE_CSS, "--primary");
    const colors = faviconColors(faviconHref(HTML)!);
    expect(colors.length, "favicon 的 data URI 里一个色值都抠不出来——这一格测的是空气").toBeGreaterThan(0);
    for (const c of colors) {
      expect(c, `favicon 用了 ${c}，而 base.css 的 --primary 是 ${primary}`).toBe(primary.toLowerCase());
    }
  });

  it("该红时红：把 favicon 的色值改掉一位，上面那格必须点名两个颜色", () => {
    const drifted = HTML.replace(/%234f46e5/g, "%234f46e6");
    const colors = faviconColors(faviconHref(drifted)!);
    expect(colors.length, "探针没造出色值——夹具与真文件的写法漂了").toBeGreaterThan(0);
    expect(colors.every((c) => c === lightToken(BASE_CSS, "--primary").toLowerCase()))
      .toBe(false);
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
