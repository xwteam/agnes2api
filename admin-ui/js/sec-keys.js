/**
 * Key 池板块。**本期只做只读部分**（设计文档 §10.2 的骨架）：
 * 状态筛选 → 4 张汇总卡 → 分页列表 → 新鲜度提示。
 * 批量条、添加 Key、以及任何动作按钮都是 P3c 的，这里一个都没有。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * 两条纪律：①一切来自接口的内容一律 textContent；②所有需要测试的纯逻辑都在
 * `js/pure/*.mjs` 里，这个文件只做 DOM 拼装与网络调用（见 admin-ui/README.md）。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n } from "./ui.js";
import { fmtCount, fmtDash, fmtDuration, fmtInstant, fmtPercent } from "./pure/format.mjs";

const BUCKETS = ["all", "fresh", "cooling", "evicted"];
/** 自动刷新档位（秒）。**默认是 0 = 关**：面板不替用户决定去轮询。 */
const AUTO_SECONDS = [0, 30, 60];
const PAGE_SIZE = 20;

const state = { bucket: "all", q: "", page: 1, autoSec: 0 };

let nodes = null;
let timer = null;
/** 在飞请求的取消闸。离开板块 / 发起下一次请求时作废上一次，避免旧响应盖掉新数据。 */
let abort = null;
let data = null;
let loadError = false;

/**
 * 分档名。**四条各写一次、参数是字面量**，不拼 `"keys.bucket." + b`：
 * i18n 门禁（scripts/check-i18n.mjs 与 tests/unit/i18n-dict.test.ts）扫的是字面量，
 * 拼出来的键它看不见，缺一种语言不会有任何信号。
 */
function bucketLabel(b) {
  if (b === "fresh") return t("keys.bucket.fresh");
  if (b === "cooling") return t("keys.bucket.cooling");
  if (b === "evicted") return t("keys.bucket.evicted");
  return t("keys.bucket.all");
}

function autoLabel(sec) {
  if (sec === 30) return t("keys.auto.30");
  if (sec === 60) return t("keys.auto.60");
  return t("keys.auto.off");
}

function badgeClass(bucket) {
  if (bucket === "evicted") return "badge badge-danger";
  if (bucket === "cooling") return "badge badge-warn";
  return "badge badge-ok";
}

/** 浏览器时区相对 UTC 的偏移。**时区必须从参数进 fmtInstant**，见 pure/format.mjs。 */
function tzOffsetMs() {
  return -new Date().getTimezoneOffset() * 60000;
}

function counts() {
  return (data && data.counts) || { all: 0, fresh: 0, cooling: 0, evicted: 0 };
}

/** 汇总卡 + 筛选下拉里的实时条数。 */
function syncCounts() {
  const c = counts();
  for (const b of BUCKETS) {
    nodes.cardValues[b].textContent = fmtCount(c[b]);
    nodes.cardLabels[b].textContent = bucketLabel(b);
    nodes.options[b].textContent = `${bucketLabel(b)}（${fmtCount(c[b])}）`;
  }
  for (const sec of AUTO_SECONDS) nodes.autoOptions[sec].textContent = autoLabel(sec);
}

function usageCell(stats) {
  const cell = el("td");
  // `≈` 不是装饰：计数在并发下少计、且最多晚一个触达间隔才落盘，见 tooltip。
  const mark = el("span", { class: "approx", title: t("keys.approxTip") }, "≈");
  cell.appendChild(mark);
  cell.appendChild(el("span", null, ` ${fmtCount(stats.requests)}`));
  // 分母为 0 时 fmtPercent 返回 —，不是 0.0%：「一次都没跑过」与「成功率 0%」是两回事。
  cell.appendChild(el("span", { class: "muted" }, ` · ${fmtPercent(stats.success, stats.requests)}`));
  return cell;
}

function row(v, now, offset) {
  const tr = el("tr");
  tr.appendChild(el("td", null, `#${v.seq}`));
  tr.appendChild(el("td", { class: "mono" }, v.masked));
  const bucketCell = el("td");
  bucketCell.appendChild(el("span", { class: badgeClass(v.bucket) }, bucketLabel(v.bucket)));
  tr.appendChild(bucketCell);
  tr.appendChild(el("td", null, fmtInstant(v.addedAt, offset)));
  tr.appendChild(el("td", null, v.lastUsedAt === null ? fmtDash(null) : fmtInstant(v.lastUsedAt, offset)));
  // 冷却剩余按**服务端那一刻**（generatedAt）算，不按浏览器时钟：两者不同源，
  // 用浏览器的 now 去减服务端的 cooldownUntil 会在时钟有偏差时算出负数或虚高。
  tr.appendChild(el("td", null, v.bucket === "cooling" ? fmtDuration(v.cooldownUntil - now) : fmtDash(null)));
  tr.appendChild(el("td", null, fmtCount(v.strikes)));
  tr.appendChild(usageCell(v.stats));
  const err = v.stats.lastErrorKind === null
    ? fmtDash(null)
    : `${v.stats.lastErrorKind}（${fmtInstant(v.stats.lastErrorAt, offset)}）`;
  tr.appendChild(el("td", null, err));
  return tr;
}

function render() {
  syncCounts();
  const host = nodes.body;
  host.textContent = "";

  if (loadError) {
    host.appendChild(elI18n("p", "common.loadFailed", { class: "muted" }));
    return;
  }
  if (!data) return;

  if (data.items.length === 0) {
    host.appendChild(elI18n("p", counts().all === 0 ? "keys.empty" : "keys.noMatch", { class: "muted" }));
    nodes.pageInfo.textContent = "";
    return;
  }

  const table = el("table");
  const head = el("tr");
  for (const key of [
    "keys.col.seq", "keys.col.key", "keys.col.bucket", "keys.col.addedAt", "keys.col.lastUsedAt",
    "keys.col.cooldown", "keys.col.strikes", "keys.col.usage", "keys.col.lastError",
  ]) head.appendChild(elI18n("th", key));
  table.appendChild(head);
  const offset = tzOffsetMs();
  for (const v of data.items) table.appendChild(row(v, data.generatedAt, offset));
  host.appendChild(table);

  nodes.pageInfo.textContent = t("keys.pageInfo", { page: data.page, pages: data.pages, total: data.total });
  nodes.prev.disabled = data.page <= 1;
  nodes.next.disabled = data.page >= data.pages;
}

async function load() {
  if (abort) abort.abort();
  abort = new AbortController();
  const params = [
    `page=${state.page}`,
    `size=${PAGE_SIZE}`,
    state.bucket === "all" ? "" : `bucket=${state.bucket}`,
    state.q === "" ? "" : `q=${encodeURIComponent(state.q)}`,
  ].filter((s) => s !== "").join("&");
  try {
    const body = await api.get(`/keys?${params}`, { signal: abort.signal });
    data = body;
    loadError = false;
    // 服务端把越界页号回落到第 1 页，本地状态跟上，否则翻页按钮会与实际显示的页对不上。
    state.page = body.page;
  } catch (e) {
    // **不伪造 0**：读失败就说读失败，显示上一次的数据会让运维以为它是新的。
    if (e && e.name === "AbortError") return;
    loadError = true;
    data = null;
  }
  render();
}

function stopTimer() {
  if (timer !== null) { clearInterval(timer); timer = null; }
}

function restartTimer() {
  stopTimer();
  if (state.autoSec > 0) timer = setInterval(() => { load(); }, state.autoSec * 1000);
}

function buildToolbar() {
  const bar = el("div", { class: "toolbar" });

  const search = el("input", { type: "search", "data-i18n-ph": "keys.search" });
  search.setAttribute("placeholder", t("keys.search"));
  search.addEventListener("input", () => { state.q = search.value; state.page = 1; load(); });
  bar.appendChild(search);

  const select = el("select", { "data-i18n-title": "keys.filter" });
  const options = {};
  for (const b of BUCKETS) {
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
    for (const b of BUCKETS) {
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

    // 新鲜度提示：与概览页共用同一份文案（progress.md:232 登记的那条）。
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
    stopTimer();
    // **作废在飞请求**：不作废的话切回来时旧响应可能盖掉新数据（板块契约 §9.3）。
    if (abort) { abort.abort(); abort = null; }
  },
};
