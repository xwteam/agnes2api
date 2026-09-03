/**
 * 主题。`boot.js` 已经在 body 绘制之前把 data-theme 落到 html 上了（防闪白），
 * 这里只负责运行期的读写与广播。
 *
 * light 时**移除属性**而不是设成 "light"：CSS 里 :root 是亮色全量 token，
 * [data-theme="dark"] 整体覆盖，多一个 light 值只会多一条永远匹配不上的规则。
 */
import { THEME_STORE as STORE } from "./pure/storage-keys.mjs";

export function getTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function setTheme(next) {
  const dark = next === "dark";
  if (dark) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem(STORE, dark ? "dark" : "light"); } catch (e) { /* 隐私模式 */ }
  // ⚠️ **这两个色值是 `admin-ui/css/base.css` 里 `--bg` 的第二份拷贝，而且没人对账。**
  // 不能写成 `var(--bg)`：`<meta name="theme-color">` 的 content 是给浏览器 chrome
  // （移动端地址栏 / 标题栏）读的字符串，不走 CSS 变量解析。
  // 也不能在这里 `getComputedStyle` 去读：那一步要等样式表加载完，而这段代码在切主题
  // 的同一帧里跑，读到的可能是上一套值。
  // ⇒ **换 `--bg` 的那天必须同时改这一行**（`admin-ui/index.html` 里那条初始
  // `<meta name="theme-color">` 是第三份，同理）。本轮换 emerald 配色时三处一起改过。
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0f172a" : "#f8fafc");
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: dark ? "dark" : "light" } }));
}

export function toggleTheme() { setTheme(getTheme() === "dark" ? "light" : "dark"); }
