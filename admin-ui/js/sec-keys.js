/**
 * Key 池板块。**本期只做只读部分**（设计文档 §10.2 的骨架）：
 * 状态筛选 → 4 张汇总卡 → 分页列表 → 新鲜度提示。
 * 批量条、添加 Key、以及任何动作按钮都是 P3c 的，这里一个都没有。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * 两条纪律：①一切来自接口的内容一律 textContent；②**取值决策一律不写在这里**，
 * 全在 `js/pure/keys.mjs` 里由 `tests/ui/keys.test.ts` 跑着（admin-ui/README.md
 * 硬规则 1）。这个文件只剩 DOM 拼装、事件绑定与网络调用。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n } from "./ui.js";
import { fmtCount, fmtDash, fmtDuration, fmtInstant, fmtPercent } from "./pure/format.mjs";
import {
  CARDS, AUTO_SECONDS, cardCounts, badgeClass, bucketLabelKey, autoLabelKey,
  keysQuery, cooldownRemaining, lastErrorParts, usageParts, lastUsedParts,
  pagerState, listMessageKey, itemsOf,
} from "./pure/keys.mjs";

const PAGE_SIZE = 20;
/** 搜索防抖。每敲一个字符打一次接口的话，大池子下每次都要重投影 + 序列化整池。 */
const SEARCH_DEBOUNCE_MS = 250;

const state = { bucket: "all", q: "", page: 1, size: PAGE_SIZE, autoSec: 0 };

let nodes = null;
let timer = null;
let searchTimer = null;
/** 在飞请求的取消闸。离开板块 / 发起下一次请求时作废上一次，避免旧响应盖掉新数据。 */
let abort = null;
let data = null;
let loadError = false;

/** 汇总卡与筛选下拉里的条数。**没有数据时 fmtCount(null) 给出 `—`，不是 0。** */
function syncCounts(shown) {
  const c = cardCounts(shown);
  for (const b of CARDS) {
    nodes.cardValues[b].textContent = fmtCount(c[b]);
    nodes.cardLabels[b].textContent = t(bucketLabelKey(b));
    nodes.options[b].textContent = `${t(bucketLabelKey(b))}（${fmtCount(c[b])}）`;
  }
  for (const sec of AUTO_SECONDS) nodes.autoOptions[sec].textContent = t(autoLabelKey(sec));
}

/** `≈` 标记。它是产品不变式的一部分（近似值必须打标），由后端的 `approximate` 驱动。 */
function approxMark() {
  return el("span", { class: "approx", title: t("keys.approxTip") }, "≈");
}

function usageCell(v, approximate) {
  const cell = el("td");
  const u = usageParts(v, approximate);
  if (u.approx) cell.appendChild(approxMark());
  cell.appendChild(el("span", null, `${u.approx ? " " : ""}${fmtCount(u.requests)}`));
  // 分母为 0 时 fmtPercent 返回 —，不是 0.0%：「一次都没跑过」与「成功率 0%」是两回事。
  cell.appendChild(el("span", { class: "muted" }, ` · ${fmtPercent(u.success, u.requests)}`));
  return cell;
}

function lastUsedCell(v, approximate, offset) {
  const cell = el("td");
  const l = lastUsedParts(v, approximate);
  if (l.approx) {
    // 「最后使用」与计数是同一份 staleness（同一次落盘一起带下去），tooltip 单独一条：
    // 它说的是「时刻粗到一个触达间隔」，与计数那条「少计 + 晚落盘」不是同一句话。
    cell.appendChild(el("span", { class: "approx", title: t("keys.approxLastUsedTip") }, "≈"));
    cell.appendChild(el("span", null, ` ${fmtInstant(l.at, offset)}`));
  } else {
    cell.appendChild(el("span", null, l.at === null ? fmtDash(null) : fmtInstant(l.at, offset)));
  }
  return cell;
}

function row(v, now, offset, approximate) {
  const tr = el("tr");
  tr.appendChild(el("td", null, `#${v.seq}`));
  tr.appendChild(el("td", { class: "mono" }, v.masked));
  const bucketCell = el("td");
  bucketCell.appendChild(el("span", { class: badgeClass(v.bucket) }, t(bucketLabelKey(v.bucket))));
  tr.appendChild(bucketCell);
  tr.appendChild(el("td", null, fmtInstant(v.addedAt, offset)));
  tr.appendChild(lastUsedCell(v, approximate, offset));
  const left = cooldownRemaining(v, now);
  tr.appendChild(el("td", null, left === null ? fmtDash(null) : fmtDuration(left)));
  tr.appendChild(el("td", null, fmtCount(v.strikes)));
  tr.appendChild(usageCell(v, approximate));
  const err = lastErrorParts(v);
  tr.appendChild(el("td", null, err === null ? fmtDash(null) : `${err.kind}（${fmtInstant(err.at, offset)}）`));
  return tr;
}

function render() {
  // **读失败一律当「没有数据」，且只判这一次**：三处各写一份 `loadError ? ... : data`
  // 的话，下一次改动很容易只改其中两处（评审 N4）。
  const shown = loadError ? null : data;
  syncCounts(shown);

  // 分页控件先复位：读失败 / 空列表时留着上一次的「第 1/2 页 · 共 3 条」，
  // 等于在展示一份已经不存在的数据。
  const pager = pagerState(shown);
  nodes.prev.disabled = pager.prevDisabled;
  nodes.next.disabled = pager.nextDisabled;
  nodes.pageInfo.textContent = pager.info === null
    ? ""
    : t("keys.pageInfo", { page: pager.info.page, pages: pager.info.pages, total: pager.info.total });

  const host = nodes.body;
  host.textContent = "";
  const messageKey = listMessageKey(shown, loadError);
  if (messageKey !== null) {
    host.appendChild(elI18n("p", messageKey, { class: "muted" }));
    return;
  }
  // 没有可渲染的条目就到此为止——判据与上面两处**共用同一个 itemsOf**，
  // 畸形响应（items 不是数组）不会走到下面那个 for 里去抛异常。
  const items = itemsOf(shown);
  if (items === null) return;

  const table = el("table");
  const head = el("tr");
  for (const key of [
    "keys.col.seq", "keys.col.key", "keys.col.bucket", "keys.col.addedAt", "keys.col.lastUsedAt",
    "keys.col.cooldown", "keys.col.strikes", "keys.col.usage", "keys.col.lastError",
  ]) head.appendChild(elI18n("th", key));
  table.appendChild(head);
  // 时区必须从参数进 fmtInstant，不许它去读运行环境的本地时区（见 pure/format.mjs）。
  const offset = -new Date().getTimezoneOffset() * 60000;
  for (const v of items) table.appendChild(row(v, shown.generatedAt, offset, shown.approximate));
  host.appendChild(table);
}

async function load() {
  if (abort) abort.abort();
  abort = new AbortController();
  try {
    const body = await api.get(`/keys?${keysQuery(state)}`, { signal: abort.signal });
    data = body;
    loadError = false;
    // 服务端把越界页号回落到第 1 页，本地状态跟上，否则翻页按钮会与实际显示的页对不上。
    state.page = body.page;
  } catch (e) {
    if (e && e.name === "AbortError") return;
    // **不伪造 0，也不留着上一次的数据**：读失败就说读失败，
    // 显示上一次的数字会让运维以为它是新的。
    loadError = true;
    data = null;
  }
  render();
}

function stopTimers() {
  if (timer !== null) { clearInterval(timer); timer = null; }
  if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
}

function restartTimer() {
  if (timer !== null) { clearInterval(timer); timer = null; }
  if (state.autoSec > 0) timer = setInterval(() => { load(); }, state.autoSec * 1000);
}

function buildToolbar() {
  const bar = el("div", { class: "toolbar" });

  const search = el("input", { type: "search", "data-i18n-ph": "keys.search" });
  search.setAttribute("placeholder", t("keys.search"));
  search.addEventListener("input", () => {
    state.q = search.value;
    state.page = 1;
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; load(); }, SEARCH_DEBOUNCE_MS);
  });
  bar.appendChild(search);

  const select = el("select", { "data-i18n-title": "keys.filter" });
  // 初始 title / aria-label 必须在这里写死一次：`apply(document)` 在 boot 时就跑完了，
  // 而这棵子树是之后才建的，只挂 data-i18n-title 的话要等一次切语言才有无障碍标签。
  select.setAttribute("title", t("keys.filter"));
  select.setAttribute("aria-label", t("keys.filter"));
  const options = {};
  for (const b of CARDS) {
    const o = el("option", { value: b });
    select.appendChild(o);
    options[b] = o;
  }
  select.value = state.bucket;
  select.addEventListener("change", () => { state.bucket = select.value; state.page = 1; load(); });
  bar.appendChild(select);

  const refresh = elI18n("button", "common.refresh", { type: "button" });
  refresh.addEventListener("click", () => { load(); });
  bar.appendChild(refresh);

  const autoWrap = el("label", { class: "auto" });
  autoWrap.appendChild(elI18n("span", "keys.auto"));
  const auto = el("select");
  const autoOptions = {};
  for (const sec of AUTO_SECONDS) {
    const o = el("option", { value: String(sec) });
    auto.appendChild(o);
    autoOptions[sec] = o;
  }
  auto.value = String(state.autoSec);
  auto.addEventListener("change", () => { state.autoSec = Number(auto.value); restartTimer(); });
  autoWrap.appendChild(auto);
  bar.appendChild(autoWrap);

  return { bar, options, autoOptions };
}

export const keysSection = {
  init(section) {
    section.textContent = "";
    section.appendChild(elI18n("h2", "keys.title"));

    const tb = buildToolbar();
    section.appendChild(tb.bar);
    // 自动刷新的开销**如实写**：这个板块与转发共用同一份 isolate 快照，确实不额外
    // 烧存储配额。这里不抄一个吓人的估算数字——那同样是撒谎。
    section.appendChild(elI18n("p", "keys.autoNote", { class: "muted note" }));

    const cardRow = el("div", { class: "card-row" });
    const cardValues = {};
    const cardLabels = {};
    for (const b of CARDS) {
      const card = el("div", { class: "card" });
      cardLabels[b] = el("div", { class: "label" });
      cardValues[b] = el("div", { class: "value" });
      card.appendChild(cardLabels[b]);
      card.appendChild(cardValues[b]);
      cardRow.appendChild(card);
    }
    section.appendChild(cardRow);

    const body = el("div", { class: "keys-body" });
    section.appendChild(body);

    const pager = el("div", { class: "pager" });
    const prev = elI18n("button", "keys.prev", { type: "button" });
    const next = elI18n("button", "keys.next", { type: "button" });
    const pageInfo = el("span", { class: "muted" });
    prev.addEventListener("click", () => { if (state.page > 1) { state.page--; load(); } });
    next.addEventListener("click", () => { state.page++; load(); });
    pager.appendChild(prev);
    pager.appendChild(pageInfo);
    pager.appendChild(next);
    section.appendChild(pager);

    // 新鲜度提示：与概览页共用同一份文案（设计文档 §10.1 / §10.2 的「新鲜度提示条」）。
    section.appendChild(elI18n("p", "keys.freshness", { class: "muted note" }));

    nodes = {
      body, pageInfo, prev, next,
      options: tb.options, autoOptions: tb.autoOptions,
      cardValues, cardLabels,
    };
  },

  onShow() {
    load();
    restartTimer();
  },

  onHide() {
    stopTimers();
    // **作废在飞请求**：不作废的话切回来时旧响应可能盖掉新数据（板块契约 §9.3）。
    if (abort) { abort.abort(); abort = null; }
  },
};
