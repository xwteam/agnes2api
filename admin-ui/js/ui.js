/**
 * 公共 UI 原语。kiro2api 没有这一层，后果是 openModal 有 3 份、confirmModal 3 份、
 * svgIcon 3 份**不同的**实现——那是全局命名空间下没有强制约束的必然结果。
 *
 * 两条纪律贯穿本文件：
 * ① **一切来自接口的内容一律 textContent，永不 innerHTML。** 事件字段里会出现上游返回的内容。
 * ② **SVG 用 createElementNS 构造，不用 innerHTML**（CSP 的 script-src 'self' 要求零内联脚本，
 *    而 innerHTML 拼 SVG 是这条约束最容易被顺手破坏的地方）。
 */
import { t } from "./i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** 建元素。`text` 走 textContent；`attrs` 里 `class`/`data-*` 直接 setAttribute。 */
export function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, v === true ? "" : String(v));
  }
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 建一个带 data-i18n 的元素：文案由 apply() 统一刷，切语言时不必板块自己管。 */
export function elI18n(tag, key, attrs) {
  const node = el(tag, { ...(attrs || {}), "data-i18n": key });
  node.textContent = t(key);
  return node;
}

/** 内联 SVG 图标。`d` 是 path 的 d 属性。**零二进制资源**是硬规则（build-ui.mjs 会拦）。 */
export function svgIcon(d, size) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size || 16));
  svg.setAttribute("height", String(size || 16));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

export function iconBtn(d, i18nTitleKey, onClick) {
  const b = el("button", { class: "icon-btn", type: "button", "data-i18n-title": i18nTitleKey });
  b.setAttribute("title", t(i18nTitleKey));
  b.setAttribute("aria-label", t(i18nTitleKey));
  b.appendChild(svgIcon(d));
  b.addEventListener("click", onClick);
  return b;
}

/**
 * toast。`kind` ∈ {"ok","warn","err"}。**文案一律 textContent**。
 *
 * `opts.sticky: true` 时**不自动消失**，改成挂一颗「×」按钮手动关闭。
 * **只给"运维必须看见、看漏了会造成误判"的那类信息用**——例如批量操作里有一部分
 * 被后端拒绝（P3c Task 4 追加裁定）：那类信息藏在 HTTP 200 的响应体里，4 秒一闪
 * 而过等于把一条诚实信号做成了几乎看不见的信号。**其余提示保持 4 秒自动消失**，
 * 不然每一次「已复制」都要用户自己去点掉，那是给不需要留痕的操作加了摩擦。
 * 默认（不传 `opts` 或 `sticky` 为假）与此前完全一致，所有既有调用点不受影响。
 */
export function toast(message, kind, opts) {
  const host = document.getElementById("toast-host");
  if (!host) return;
  const sticky = !!(opts && opts.sticky);
  const node = el("div", { class: `toast toast-${kind || "ok"}${sticky ? " toast-sticky" : ""}`, role: "status" });
  node.appendChild(el("span", null, message));
  if (sticky) {
    const close = el("button", { type: "button", class: "toast-close", "aria-label": t("common.dismiss") });
    close.textContent = "×";
    close.addEventListener("click", () => node.remove());
    node.appendChild(close);
  } else {
    setTimeout(() => node.remove(), 4000);
  }
  host.appendChild(node);
}

export function openModal(titleKey, bodyNode, actions) {
  const back = el("div", { class: "modal-back" });
  const box = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });
  box.appendChild(elI18n("h2", titleKey));
  box.appendChild(bodyNode);
  const bar = el("div", { class: "modal-actions" });
  for (const a of actions) {
    const b = elI18n("button", a.labelKey, { class: a.danger ? "danger" : "" });
    b.addEventListener("click", () => { back.remove(); a.onClick && a.onClick(); });
    bar.appendChild(b);
  }
  box.appendChild(bar);
  back.appendChild(box);
  document.body.appendChild(back);
  return () => back.remove();
}

export function confirmModal(titleKey, messageKey, onConfirm) {
  return openModal(titleKey, elI18n("p", messageKey), [
    { labelKey: "common.cancel" },
    { labelKey: "common.confirm", danger: true, onClick: onConfirm },
  ]);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("common.copied"), "ok");
  } catch (e) {
    // 剪贴板在非 TLS 下不可用是常态，**不要**假装成功。
    toast(t("common.copyFailed"), "warn");
  }
}
