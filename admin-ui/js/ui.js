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
 *
 * ⚠️⚠️ **评审指出的可及性缺口，已修**：`#toast-host` 是 `<body>` 最后一个元素，
 * 一次 20 行批量删除之后表格里可能有上百颗按钮，键盘用户要把它们全部 Tab 过去
 * 才够得到那颗"必须被看见、必须被点掉"的关闭按钮——把最要紧的信号放在整页
 * 最后一个 Tab 停靠点，等于对键盘用户取消了 sticky 这个决定本身带来的收益。
 * 现在 sticky 出现时**关闭按钮直接拿到焦点**（不必再 Tab 过去），且它自己身上
 * 挂了 Escape 键——两条路径都能关掉它，不用二选一。
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
    const dismiss = () => node.remove();
    close.addEventListener("click", dismiss);
    close.addEventListener("keydown", (ev) => { if (ev.key === "Escape") dismiss(); });
    node.appendChild(close);
    host.appendChild(node);
    close.focus();
  } else {
    setTimeout(() => node.remove(), 4000);
    host.appendChild(node);
  }
}

/** 弹窗容器 `aria-labelledby` 用的 id 前缀，逐个自增，不许两个同时打开的弹窗撞号。 */
let modalSeq = 0;

/** 一棵子树里"可以拿到键盘焦点"的元素，按 DOM 顺序。焦点陷阱与初始焦点都靠它。 */
function focusableIn(root) {
  const FOCUSABLE_TAGS = new Set(["button", "input", "textarea", "select", "a"]);
  return root.walk().filter((node) => FOCUSABLE_TAGS.has(node.tagName) && !node.disabled);
}

/**
 * 通用弹窗。**它现在守着删除 / 批量操作这类破坏性动作**，焦点管理不是可选项
 * ——评审指出第一版完全没有：无初始焦点、无焦点陷阱、无 Escape、`<h2>` 没有
 * `aria-labelledby`，键盘 / 读屏用户可以在「确认删除 20 把」弹窗还开着的时候
 * Tab 出去操作背后被弹窗盖住的表格。现在四条都补上：
 *   ① 打开时焦点落在弹窗容器本身（`tabindex="-1"` + `.focus()`）——不猜"第一个
 *      输入框"，因为确认类弹窗里可能只有两颗按钮；
 *   ② Tab / Shift+Tab 只在弹窗内部的可聚焦元素之间循环；
 *   ③ Escape 直接关闭（等同取消，不跑任何 `onClick`）；
 *   ④ `<h2>` 与 `role="dialog"` 的容器之间用 `aria-labelledby` 关联。
 *
 * **`actions[i].keepOpen: true`**：点击后不自动关闭，`onClick` 拿到 `close`
 * 自己决定什么时候关（P3c Task 4 追加裁定修的一个真缺陷——`onClick` 原来无条件
 * 先 `back.remove()` 再跑，导入弹窗校验失败/网络失败时弹窗已经关了，粘进去的
 * 200 行只剩一句 toast，其余全丢）。不设 `keepOpen` 时行为与此前完全一致：
 * 点击后立即关闭，除非 `onClick` **同步**返回 `false`。
 */
export function openModal(titleKey, bodyNode, actions) {
  const back = el("div", { class: "modal-back" });
  const box = el("div", { class: "modal", role: "dialog", "aria-modal": "true", tabindex: "-1" });
  const titleId = `modal-title-${++modalSeq}`;
  box.setAttribute("aria-labelledby", titleId);
  box.appendChild(elI18n("h2", titleKey, { id: titleId }));
  box.appendChild(bodyNode);
  const bar = el("div", { class: "modal-actions" });
  const close = () => back.remove();
  for (const a of actions) {
    const b = elI18n("button", a.labelKey, { class: a.danger ? "danger" : "" });
    b.addEventListener("click", () => {
      const result = a.onClick && a.onClick(close);
      if (!a.keepOpen && result !== false) close();
    });
    bar.appendChild(b);
  }
  box.appendChild(bar);

  box.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { close(); return; }
    if (ev.key !== "Tab") return;
    const items = focusableIn(box);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (ev.shiftKey) {
      if (current === first || !items.includes(current)) { ev.preventDefault(); last.focus(); }
    } else if (current === last || !items.includes(current)) {
      ev.preventDefault();
      first.focus();
    }
  });

  back.appendChild(box);
  document.body.appendChild(back);
  box.focus();
  return close;
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
