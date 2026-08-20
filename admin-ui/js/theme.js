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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#14161a" : "#f7f8fa");
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: dark ? "dark" : "light" } }));
}

export function toggleTheme() { setTheme(getTheme() === "dark" ? "light" : "dark"); }
