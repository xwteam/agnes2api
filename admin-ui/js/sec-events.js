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
import { el, elI18n, toast } from "./ui.js";
import { fmtInstant } from "./pure/format.mjs";
import {
  LEVELS, levelLabelKey, effectiveLevel, eventLevelLabelKey, levelBadgeClass,
  eventsQuery, itemsOf, eventsListMessageKey, shardIdOf, generatedAtOf, bufferStatus, shouldWarn,
  initialPollState, resumePollState, pollOutcome, pollIndicatorState, pollIndicatorLabelKey,
  matchesSearch, buildDetailText, groupEvents, orderForDisplay, mergeIntoView,
} from "./pure/events.mjs";

const LIMIT = 200;

/** 板块内部状态。`level` 是 "all" 或 LEVELS 里的一个。 */
const state = { q: "", level: "all", paused: false, autoScroll: true };

let nodes = null;
let timer = null;
let abort = null;
/** 客户端已攒下的视图（ts 降序，与后端契约一致；渲染前用 orderForDisplay 反转）。 */
let view = [];
/**
 * 「视图是被『清空』按钮清掉的，不是本来就没有事件」（全分支评审 I5）。
 *
 * 只影响列表区那句话该怎么写（判据在 `pure/events.mjs` 的 `eventsListMessageKey`），
 * 不影响游标——被清掉的事件**刻意**不会自动回来，理由见那个函数的说明。
 * 换筛选级别时归零：那时视图是被整段重拉的，不是被清掉的。
 */
let cleared = false;
let lastStatus = { dropped: null, budgetExhausted: null, truncated: null, buffered: null, cursorAhead: null };
/** 最近一次成功响应里的本 isolate 分片 id（评审 M2），驱动轮询指示灯的提示文案。 */
let lastShardId = null;
/** 最近一次成功响应的生成时刻（评审 N1 [LOW]），同样只驱动轮询指示灯的提示文案。 */
let lastGeneratedAt = null;
/**
 * 轮询的全部跨轮状态（游标 / 自愈中 / 退避间隔）。**整体来自 `pollOutcome()` 的
 * `next`，这个文件不再自己算它的任何一个字段**——评审四审 B1：上一版把"上一轮的
 * 自愈不算这一轮的新内容"这条跨轮规则的一半写在这里（`justHealed = outcome.resetView`），
 * 而这个文件没有任何自动化覆盖，把那一行改成恒 false 全套用例一条都不红。
 * 判据全部搬回 pure/events.mjs（admin-ui/README.md 硬规则 1）。
 */
let pollState = initialPollState();
let lastError = false;
let loadError = false;
/** 本板块当前是不是"正在显示"这一个（`onShow`/`onHide` 之间）。visibilitychange
 * 处理器据此判断"该不该在页面重新可见时把轮询接回去"——不加这一层的话，
 * 离开本板块时 `onHide` 已经把 timer 清成了 null，页面从别的 tab 切回来会
 * 误判成"因为隐藏而停了"，把本该保持停着的轮询重新点起来。 */
let sectionActive = false;

function offsetMs() { return -new Date().getTimezoneOffset() * 60000; }

function renderWarnings() {
  const banner = nodes.warnBanner;
  banner.style.display = shouldWarn(lastStatus) ? "" : "none";

  nodes.warnDropped.style.display = lastStatus.dropped !== null && lastStatus.dropped > 0 ? "" : "none";
  if (lastStatus.dropped !== null && lastStatus.dropped > 0) {
    nodes.warnDropped.textContent = t("ev.warnDropped", { count: lastStatus.dropped });
  }

  nodes.warnBudget.style.display = lastStatus.budgetExhausted === true ? "" : "none";
  if (lastStatus.budgetExhausted === true) nodes.warnBudget.textContent = t("ev.warnBudget");

  nodes.warnTruncated.style.display = lastStatus.truncated === true ? "" : "none";
  if (lastStatus.truncated === true) nodes.warnTruncated.textContent = t("ev.warnTruncated");

  // 评审 C6：`cursorAhead` 为 true 时 `poll()` 已经把 `pollState.after` 自愈成
  // null（见下方 poll()），下一轮就会带着新游标重新冷读——这条提示只是让运维知道
  // "刚刚发生过一次自动恢复"，不是要人手动做什么。
  // ⚠️ 评审四审：这条黄条**逐轮覆盖、没有粘性**——`cursorAhead=false` 的那一轮
  // 它就灭了。持续的跨 isolate 时钟偏移下它会跟着视图一起闪（亮一轮灭一轮），
  // 不是"持续亮着的告警"。**这一行本身没有任何自动化守护**（本仓无 DOM 测试通道，
  // 实测把它改成粘性全套用例照样全绿）；tests/contract/events-cursor-heal.test.ts
  // 钉住的是它的**输入**——后端 cursorAhead 字段逐轮交替这个根因。
  nodes.warnCursorAhead.style.display = lastStatus.cursorAhead === true ? "" : "none";
  if (lastStatus.cursorAhead === true) nodes.warnCursorAhead.textContent = t("ev.warnCursorAhead");
}

function renderPollIndicator() {
  const kind = pollIndicatorState({ paused: state.paused, lastError });
  nodes.pollDot.className = `poll-dot poll-dot-${kind}`;
  let label = t(pollIndicatorLabelKey(kind));
  if (lastShardId !== null) label += t("ev.pollStatus.shardSuffix", { shardId: lastShardId });
  // 评审 N1：`buffered` 是"本 isolate 还没落盘的事件数"——单纯有数字不算异常
  // （见 pure/events.mjs 的 shouldWarn 注释），但 isolate 随时可能被回收，
  // 这里没有黄条那么显眼，但至少让愿意看 tooltip 的人看得到这个风险。
  if (lastStatus.buffered !== null && lastStatus.buffered > 0) {
    label += t("ev.pollStatus.bufferedSuffix", { count: lastStatus.buffered });
  }
  // 评审 N1 [LOW]：`generatedAt` 是响应生成时刻，最小、低风险的消费方式——
  // 让 tooltip 报一句"数据截至几点"，运维不用另外去猜面板有没有卡住。
  if (lastGeneratedAt !== null) {
    label += t("ev.pollStatus.generatedAtSuffix", { time: fmtInstant(lastGeneratedAt, offsetMs()) });
  }
  nodes.pollDot.title = label;
  nodes.pollDot.setAttribute("aria-label", label);
}

function eventRow(item, grouped) {
  const tr = el("tr", { class: grouped ? "ev-row ev-row-grouped" : "ev-row" });
  tr.appendChild(el("td", { class: "mono" }, fmtInstant(item && item.ts, offsetMs())));
  const levelCell = el("td");
  const level = effectiveLevel(item);
  levelCell.appendChild(el("span", { class: levelBadgeClass(level) }, t(eventLevelLabelKey(level))));
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

  const filtered = view.filter((item) => matchesSearch(item, state.q));
  const messageKey = eventsListMessageKey(loadError, view.length, filtered.length, cleared);
  if (messageKey !== null) {
    host.appendChild(elI18n("p", messageKey, { class: "muted" }));
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
  try {
    const query = eventsQuery({ ...state, after: pollState.after, limit: LIMIT });
    const body = await api.get(`/events?${query}`, { signal: abort.signal });
    const items = itemsOf(body) ?? [];
    lastStatus = bufferStatus(body);
    lastShardId = shardIdOf(body);
    lastGeneratedAt = generatedAtOf(body);
    loadError = false;
    lastError = false;
    // 评审 C6 二审 / 四审 B1：游标自愈、视图要不要跟着清空、退避间隔看不看到
    // "新内容"、自愈状态什么时候清位——同一个纯状态转换的四个面，**全部**在
    // pollOutcome() 里（admin-ui/README.md 硬规则 1）。这里只剩两件拼装：视图
    // 要不要清、把返回的下一轮状态整体收下。一个判据都不许再回到这个文件。
    const outcome = pollOutcome(pollState, items, body && body.cursor, lastStatus.cursorAhead);
    if (outcome.resetView) view = [];
    view = mergeIntoView(view, items);
    // 视图里重新有内容了，「已清空」那句话就不再成立（它只描述"空是怎么来的"）。
    if (view.length > 0) cleared = false;
    pollState = outcome.next;
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
  timer = setTimeout(() => { poll(); }, pollState.delayMs);
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
    // 下载失败要让用户看得见——按钮点了没反应、又没有任何提示，是本仓已经踩过的
    // 那类"看起来什么都没发生"的坑，本仓已经有 toast 这个组件，直接用。
    toast(t("ev.downloadFailed"), "err");
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
  // **清空之后必须置位 `cleared`**（全分支评审 I5）：不置位的话列表区会显示
  // 「还没有事件。」，与这个按钮自己的 tooltip 当场矛盾，而且那是假话——服务端
  // 明明有事件。游标刻意不回退（理由见 pure/events.mjs 的 eventsListMessageKey）。
  clearBtn.addEventListener("click", () => { view = []; cleared = true; render(); });
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
    // 「全部/error」两种视图的历史深度不一致。重置视图与整份轮询状态（游标、
    // 自愈中、退避一起归零），从当前时刻重新拉。
    view = [];
    cleared = false;
    pollState = initialPollState();
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
    const warnTruncated = el("p");
    const warnCursorAhead = el("p");
    warnBanner.appendChild(warnDropped);
    warnBanner.appendChild(warnBudget);
    warnBanner.appendChild(warnTruncated);
    warnBanner.appendChild(warnCursorAhead);
    section.appendChild(warnBanner);

    const tb = buildToolbar();
    section.appendChild(tb.bar);

    const body = el("div", { class: "events-body" });
    section.appendChild(body);

    nodes = { body, warnBanner, warnDropped, warnBudget, warnTruncated, warnCursorAhead, pollDot: tb.pollDot };
  },

  onShow() {
    sectionActive = true;
    loadError = false;
    lastError = false;
    // 保留游标（已经看过的事件不该因为切走又切回来再拉一遍），退避与自愈状态归零。
    // 这条同样是判据，写在 pure/events.mjs 里，不在这里手写三行赋值。
    pollState = resumePollState(pollState);
    poll();
  },

  onHide() {
    sectionActive = false;
    stopPolling();
  },
};
