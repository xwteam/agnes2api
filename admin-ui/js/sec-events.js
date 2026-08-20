/**
 * 事件板块（设计文档 §10.7，本期形状见 P3b 计划 Task 6 Step 7）：
 * 搜索框 + 级别按钮组 + 暂停 + 清空（仅清前端视图）+ 下载 + 自动滚动 + 轮询状态指示灯。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * 两条纪律：①一切来自接口的内容一律 textContent；②**取值决策一律不写在这里**，
 * 全在 `js/pure/events.mjs` 里由 `tests/ui/events.test.ts` 跑着（admin-ui/README.md
 * 硬规则 1）。这个文件只剩 DOM 拼装、事件绑定与网络调用。
 *
 * **事件字段视为完全不可信**（里面会出现上游返回的内容与未鉴权请求的路径）：
 * 所有字段一律 `textContent`，绝不 `innerHTML`。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n } from "./ui.js";
import { fmtInstant } from "./pure/format.mjs";
import {
  LEVELS, levelLabelKey, levelBadgeClass, eventsQuery, itemsOf,
  bufferStatus, shouldWarn, nextAfter, nextPollDelayMs, pollIndicatorState, pollIndicatorLabelKey,
  matchesSearch, formatFields, groupEvents, orderForDisplay, mergeIntoView,
} from "./pure/events.mjs";

const LIMIT = 200;

/** 板块内部状态。`level` 是 "all" 或 LEVELS 里的一个。 */
const state = { q: "", level: "all", paused: false, autoScroll: true, after: null };

let nodes = null;
let timer = null;
let abort = null;
/** 客户端已攒下的视图（ts 降序，与后端契约一致；渲染前用 orderForDisplay 反转）。 */
let view = [];
let lastStatus = { dropped: null, budgetExhausted: null };
let pollDelayMs = 15_000; // 与 pure/events.mjs 的 EVENTS_POLL_MIN_MS 保持一致的初值
let lastError = false;
/** 读失败一次都没成功过时 view 保持空，渲染成 loadFailed 而不是 empty。 */
let everLoaded = false;
let loadError = false;
/** 本板块当前是不是"正在显示"这一个（`onShow`/`onHide` 之间）。visibilitychange
 * 处理器据此判断"该不该在页面重新可见时把轮询接回去"——不加这一层的话，
 * 离开本板块时 `onHide` 已经把 timer 清成了 null，页面从别的 tab 切回来会
 * 误判成"因为隐藏而停了"，把本该保持停着的轮询重新点起来。 */
let sectionActive = false;

function offsetMs() { return -new Date().getTimezoneOffset() * 60000; }

function renderWarnings() {
  const banner = nodes.warnBanner;
  const show = shouldWarn(lastStatus);
  banner.style.display = show ? "" : "none";
  nodes.warnDropped.style.display = lastStatus.dropped !== null && lastStatus.dropped > 0 ? "" : "none";
  if (lastStatus.dropped !== null && lastStatus.dropped > 0) {
    nodes.warnDropped.textContent = t("ev.warnDropped", { count: lastStatus.dropped });
  }
  nodes.warnBudget.style.display = lastStatus.budgetExhausted === true ? "" : "none";
  if (lastStatus.budgetExhausted === true) nodes.warnBudget.textContent = t("ev.warnBudget");
}

function renderPollIndicator() {
  const kind = pollIndicatorState({ paused: state.paused, lastError });
  nodes.pollDot.className = `poll-dot poll-dot-${kind}`;
  const label = t(pollIndicatorLabelKey(kind));
  nodes.pollDot.title = label;
  nodes.pollDot.setAttribute("aria-label", label);
}

function buildDetailText(item) {
  const msg = item && typeof item.msg === "string" ? item.msg : "";
  const fields = item && typeof item.fields === "object" ? formatFields(item.fields) : "";
  return [msg, fields].filter((s) => s !== "").join(" · ");
}

function eventRow(item, grouped) {
  const tr = el("tr", { class: grouped ? "ev-row ev-row-grouped" : "ev-row" });
  tr.appendChild(el("td", { class: "mono" }, fmtInstant(item && item.ts, offsetMs())));
  const levelCell = el("td");
  const level = item && typeof item.level === "string" ? item.level : "info";
  levelCell.appendChild(el("span", { class: levelBadgeClass(level) }, t(levelLabelKey(level))));
  tr.appendChild(levelCell);
  tr.appendChild(el("td", { class: "mono" }, item && typeof item.event === "string" ? item.event : ""));
  tr.appendChild(el("td", null, buildDetailText(item)));
  return tr;
}

function groupHeaderRow(group) {
  const tr = el("tr", { class: "ev-group-header" });
  const td = el("td", { colspan: "4", class: "muted" },
    t("ev.timeline", { count: group.items.length, corr: group.corr }));
  tr.appendChild(td);
  return tr;
}

function render() {
  renderWarnings();
  renderPollIndicator();

  const host = nodes.body;
  host.textContent = "";

  if (loadError && !everLoaded) {
    host.appendChild(elI18n("p", "common.loadFailed", { class: "muted" }));
    return;
  }

  const filtered = view.filter((item) => matchesSearch(item, state.q));
  if (filtered.length === 0) {
    host.appendChild(elI18n("p", view.length === 0 ? "ev.empty" : "ev.noMatch", { class: "muted" }));
    return;
  }

  const table = el("table");
  const head = el("tr");
  for (const key of ["ev.col.time", "ev.col.level", "ev.col.event", "ev.col.detail"]) {
    head.appendChild(elI18n("th", key));
  }
  table.appendChild(head);

  const groups = groupEvents(orderForDisplay(filtered));
  for (const group of groups) {
    if (group.items.length > 1) table.appendChild(groupHeaderRow(group));
    for (const item of group.items) table.appendChild(eventRow(item, group.items.length > 1));
  }
  host.appendChild(table);

  if (state.autoScroll) host.scrollTop = host.scrollHeight;
}

async function poll() {
  if (abort) abort.abort();
  abort = new AbortController();
  const beforeAfter = state.after;
  try {
    const body = await api.get(`/events?${eventsQuery({ ...state, limit: LIMIT })}`, { signal: abort.signal });
    const items = itemsOf(body) ?? [];
    lastStatus = bufferStatus(body);
    everLoaded = true;
    loadError = false;
    lastError = false;
    view = mergeIntoView(view, items);
    state.after = nextAfter(state.after, body && body.cursor);
    pollDelayMs = nextPollDelayMs(pollDelayMs, state.after !== beforeAfter);
  } catch (e) {
    if (e && e.name === "AbortError") return;
    lastError = true;
    loadError = true;
    // **不清空 view**：一次轮询失败不该把已经看到的历史事件抹掉，那比「暂时看不到
    // 最新的」更像撒谎——运维正在盯着的是一条正在增长的时间线，不是一个可替换的快照。
  }
  render();
  scheduleNext();
}

function scheduleNext() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (state.paused || document.hidden) return;
  timer = setTimeout(() => { poll(); }, pollDelayMs);
}

function stopPolling() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (abort) { abort.abort(); abort = null; }
}

/**
 * 页面从隐藏变回可见时，把因为 `document.hidden` 而停掉的轮询接回去。
 *
 * **只在本板块当前处于"正在显示"时才生效**（`sectionActive`）：不加这一层，
 * 从别的 tab 切回来时会把任何板块（哪怕当前显示的是概览页、本板块早被
 * `onHide` 正常停掉）误判成"因为隐藏而停了"，重新点起一轮不该发生的请求。
 * 只注册一次（模块级监听，不随 init/onShow 重复挂）。
 */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && sectionActive && !state.paused && timer === null) poll();
});

async function download() {
  try {
    const res = await api.raw("GET", "/events/download");
    const text = await res.text();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: "agnes2api-events.txt" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    // 下载失败就是失败，不装作成功——按钮本身不需要额外反馈，浏览器不会触发下载。
  }
}

function buildToolbar() {
  const bar = el("div", { class: "toolbar" });

  const search = el("input", { type: "search", "data-i18n-ph": "ev.search" });
  search.setAttribute("placeholder", t("ev.search"));
  search.addEventListener("input", () => { state.q = search.value; render(); });
  bar.appendChild(search);

  const levelGroup = el("div", { class: "btn-group" });
  const levelButtons = {};
  const allBtn = elI18n("button", "ev.level.all", { type: "button", class: "btn-toggle active" });
  allBtn.addEventListener("click", () => { setLevel("all"); });
  levelGroup.appendChild(allBtn);
  levelButtons.all = allBtn;
  for (const lvl of LEVELS) {
    const b = elI18n("button", levelLabelKey(lvl), { type: "button", class: "btn-toggle" });
    b.addEventListener("click", () => { setLevel(lvl); });
    levelGroup.appendChild(b);
    levelButtons[lvl] = b;
  }
  bar.appendChild(levelGroup);

  const pauseBtn = elI18n("button", "ev.pause", { type: "button" });
  pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    pauseBtn.textContent = t(state.paused ? "ev.resume" : "ev.pause");
    pauseBtn.setAttribute("data-i18n", state.paused ? "ev.resume" : "ev.pause");
    renderPollIndicator();
    if (state.paused) stopPolling(); else scheduleNext();
  });
  bar.appendChild(pauseBtn);

  const clearBtn = elI18n("button", "ev.clear", { type: "button", "data-i18n-title": "ev.clearTip" });
  clearBtn.title = t("ev.clearTip");
  clearBtn.addEventListener("click", () => { view = []; render(); });
  bar.appendChild(clearBtn);

  const downloadBtn = elI18n("button", "ev.download", { type: "button" });
  downloadBtn.addEventListener("click", () => { download(); });
  bar.appendChild(downloadBtn);

  const autoScrollWrap = el("label", { class: "auto" });
  const autoScrollBox = el("input", { type: "checkbox" });
  autoScrollBox.checked = state.autoScroll;
  autoScrollBox.addEventListener("change", () => { state.autoScroll = autoScrollBox.checked; });
  autoScrollWrap.appendChild(autoScrollBox);
  autoScrollWrap.appendChild(elI18n("span", "ev.autoScroll"));
  bar.appendChild(autoScrollWrap);

  const pollDot = el("span", { class: "poll-dot poll-dot-active" });
  bar.appendChild(pollDot);

  function setLevel(lvl) {
    state.level = lvl;
    for (const [k, b] of Object.entries(levelButtons)) b.classList.toggle("active", k === lvl);
    // 切换级别相当于换了一条筛选后的流：已攒的视图是按旧筛选拉来的，继续拼接会让
    // 「全部/error」两种视图的历史深度不一致。重置游标与视图，从当前时刻重新拉。
    view = [];
    state.after = null;
    poll();
  }

  return { bar, pollDot };
}

export const eventsSection = {
  init(section) {
    section.textContent = "";
    section.appendChild(elI18n("h2", "ev.title"));
    section.appendChild(elI18n("p", "ev.notice", { class: "muted note" }));

    const warnBanner = el("div", { class: "banner-danger" });
    warnBanner.style.display = "none";
    const warnDropped = el("p");
    const warnBudget = el("p");
    warnBanner.appendChild(warnDropped);
    warnBanner.appendChild(warnBudget);
    section.appendChild(warnBanner);

    const tb = buildToolbar();
    section.appendChild(tb.bar);

    const body = el("div", { class: "events-body" });
    section.appendChild(body);

    nodes = { body, warnBanner, warnDropped, warnBudget, pollDot: tb.pollDot };
  },

  onShow() {
    sectionActive = true;
    everLoaded = false;
    loadError = false;
    lastError = false;
    pollDelayMs = 15_000;
    poll();
  },

  onHide() {
    sectionActive = false;
    stopPolling();
  },
};
