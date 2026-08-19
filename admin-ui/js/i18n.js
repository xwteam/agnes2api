/**
 * i18n。三个标记钩子 + 一个兜底机制。
 *
 * `t()` 找不到 key 时**返回 key 本身**（生产不该因为缺一句翻译就白屏），
 * 但 localStorage["agnes2api_debug"] 为真时在控制台告警——开发期看得见，生产期不打扰。
 *
 * **兜底机制（照抄 kiro2api，理由相同）**：切语言时框架层做两件事——
 * `apply(document)` **加上**重新调用当前板块的 `onShow()` 整页重绘。
 * 有些标签是渲染时用 `t()` 拼进 textContent 的、没有 data-i18n 属性，`apply()` 抓不到。
 * 框架层强制重跑保证**不管板块自己写得对不对，切语言都一定生效**。
 * ⇒ **板块内不许再各自监听 langchange**（kiro2api 有 4 处冗余监听，是历史遗留）。
 */
import { I18N } from "./i18n-dict.js";

export const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"];
const STORE = "agnes2api_lang";
const FALLBACK = "zh-CN";

function readLang() {
  try {
    const v = localStorage.getItem(STORE);
    if (v && LANGS.includes(v)) return v;
  } catch (e) { /* 隐私模式：走默认 */ }
  return FALLBACK;
}

let lang = readLang();

export function currentLang() { return lang; }

export function t(key, params) {
  const row = I18N[key];
  let s = row ? (row[lang] ?? row[FALLBACK]) : undefined;
  if (s === undefined) {
    try {
      if (localStorage.getItem("agnes2api_debug")) console.warn("[i18n] 缺 key:", key);
    } catch (e) { /* ignore */ }
    return key;
  }
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** 三个标记钩子。全部走 textContent / setAttribute，**永不 innerHTML**。 */
export function apply(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
  for (const el of scope.querySelectorAll("[data-i18n-ph]")) el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
  for (const el of scope.querySelectorAll("[data-i18n-title]")) {
    const s = t(el.getAttribute("data-i18n-title"));
    el.setAttribute("title", s);
    // 无 aria-label 时一并写：图标按钮只有 title 的话读屏器读不出来。
    if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", s);
  }
}

export function setLang(next) {
  if (!LANGS.includes(next)) return;
  lang = next;
  try { localStorage.setItem(STORE, next); } catch (e) { /* ignore */ }
  document.documentElement.setAttribute("data-lang", next);
  document.documentElement.lang = next;
  apply(document);
  document.dispatchEvent(new CustomEvent("langchange", { detail: { lang: next } }));
}
