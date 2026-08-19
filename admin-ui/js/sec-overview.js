/**
 * 概览板块（设计文档 §10.1，本期形状见 P3b 计划 Task 5 Step 7）：
 * 4 张池子卡 → 运行时信息面板 → 新鲜度卡 → 累计用量卡 → 配置摘要 → 存储卡。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * 两条纪律：①一切来自接口的内容一律 textContent；②**取值决策一律不写在这里**，
 * 全在 `js/pure/overview.mjs` 里由 `tests/ui/overview.test.ts` 跑着（admin-ui/README.md
 * 硬规则 1）。这个文件只剩 DOM 拼装、事件绑定与网络调用。
 *
 * **一切形态分支只读接口返回的数据**（`process === null` / `storage.backend` /
 * `runtime.name` 这些来自响应体的字段），不许自己嗅探运行时（硬约束 1）。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n } from "./ui.js";
import { fmtCount, fmtDash, fmtDuration, fmtInstant, fmtPercent, fmtBytesMb } from "./pure/format.mjs";
import {
  POOL_CARDS, poolCardLabelKey, runtimeNameLabelKey, storageBackendLabelKey,
  poolCounts, processCells, usageStats, configSummary, storageInfo,
  freshnessValues, kvReadEstimatePerIsolatePerDay,
} from "./pure/overview.mjs";

let nodes = null;
let abort = null;
/** 最近一次成功的 `/overview` 响应；null 表示「还没有过一次成功」。 */
let data = null;
let loadError = false;
/**
 * `/capabilities` 只拉一次（静态数据：版本号、colo、quota model 这些在一个
 * isolate/进程的生命周期里不会变），不跟着每次刷新重新拉——它的**零存储读**特性
 * 值得在前端也体现成「零额外网络往返」，而不是每次点刷新都再打一次。
 */
let caps = null;

function offsetMs() { return -new Date().getTimezoneOffset() * 60000; }

/** 建一张 `.card`（4 张池子卡 / 运行时信息面板复用同一个原语）。 */
function tile(labelKey) {
  const card = el("div", { class: "card" });
  card.appendChild(elI18n("div", labelKey, { class: "label" }));
  const value = el("div", { class: "value" });
  card.appendChild(value);
  return { card, value };
}

/** 建一个内容块：标题 + 空的 body 容器，供各卡片各自往里塞段落。 */
function block(titleKey) {
  const wrap = el("div", { class: "card block" });
  wrap.appendChild(elI18n("h3", titleKey));
  const body = el("div");
  wrap.appendChild(body);
  return { wrap, body };
}

/** 「标签: 值」一行。`labelKey` 走 i18n，值由调用方之后自己 textContent。 */
function row(labelKey) {
  const p = el("p");
  p.appendChild(el("span", { class: "muted" }, `${t(labelKey)}: `));
  const value = el("span");
  p.appendChild(value);
  return { p, value };
}

function renderPoolCards() {
  const c = poolCounts(data);
  for (const card of POOL_CARDS) nodes.pool[card].textContent = fmtCount(c[card]);
}

/**
 * 运行时信息面板的 8 格。**判据一律来自 `processCells()` 的 `kind`**
 * （产品不变式 11：不是 0、不是空、不隐藏格子）。`colo` 只在 `/capabilities`
 * 加载成功后才有；没拿到时格子仍在，显示 `—`。
 */
function renderRuntimeTiles() {
  const n = nodes.runtime;
  n.version.textContent = data && typeof data.version === "string" ? data.version : fmtDash(null);

  const runtimeName = data && data.runtime && typeof data.runtime.name === "string" ? data.runtime.name : null;
  if (runtimeName === null) {
    n.runtimeLabel.textContent = fmtDash(null);
  } else {
    const runtimeLabel = t(runtimeNameLabelKey(runtimeName));
    const colo = caps && caps.runtime && typeof caps.runtime.colo === "string" ? caps.runtime.colo : null;
    n.runtimeLabel.textContent = colo === null ? runtimeLabel : `${runtimeLabel} (${colo})`;
  }

  n.serverTime.textContent = data && typeof data.serverTime === "number"
    ? fmtInstant(data.serverTime, offsetMs()) : fmtDash(null);

  const si = storageInfo(data);
  n.storageBackend.textContent = si.backend === null ? fmtDash(null) : t(storageBackendLabelKey(si.backend));

  const p = processCells(data);
  const serverless = t("ov.runtime.serverless");
  n.memory.textContent = p.kind === "serverless" ? serverless : fmtBytesMb(p.kind === "metrics" ? p.rssBytes : null);
  n.uptime.textContent = p.kind === "serverless" ? serverless : fmtDuration(p.kind === "metrics" ? p.uptimeMs : null);
  n.pid.textContent = p.kind === "serverless" ? serverless : fmtCount(p.kind === "metrics" ? p.pid : null);

  n.writable.textContent = si.writable === null
    ? fmtDash(null)
    : t(si.writable ? "ov.runtime.writableYes" : "ov.runtime.writableNo")
      + (si.checkedAt === null ? "" : ` (${t("ov.runtime.checkedAt", { at: fmtInstant(si.checkedAt, offsetMs()) })})`);
}

function renderFreshness() {
  const f = freshnessValues(data);
  nodes.freshness.pool.textContent = f.poolCacheTtlMs === null
    ? fmtDash(null)
    : t("ov.freshness.pool", {
      upper: fmtDuration(f.poolVisibilityUpperBoundMs),
      ttl: fmtDuration(f.poolCacheTtlMs),
      edge: fmtDuration(f.kvEdgeCacheMs),
    });
  nodes.freshness.config.textContent = f.configTtlMs === null
    ? fmtDash(null)
    : t("ov.freshness.config", {
      upper: fmtDuration(f.configVisibilityUpperBoundMs),
      ttl: fmtDuration(f.configTtlMs),
      edge: fmtDuration(f.kvEdgeCacheMs),
    });
}

function renderUsage() {
  const u = usageStats(data);
  nodes.usage.requests.textContent = fmtCount(u.requests);
  nodes.usage.success.textContent = fmtCount(u.success);
  nodes.usage.failed.textContent = fmtCount(u.failed);
  nodes.usage.clientErrors.textContent = fmtCount(u.clientErrors);
  nodes.usage.successRate.textContent = fmtPercent(u.success, u.requests);
}

function renderConfig() {
  const c = configSummary(data);
  // **`c === null` = 整块读失败，逐格显示 —**；`c` 存在时 `primary`/`fallback`
  // 仍可能合法为 null（注册机未启用），那种情形显示「无」而不是 ———两种 null
  // 的来源不同，见 configSummary 的说明，调用方必须先判这一层再往下取字段。
  nodes.config.banner.style.display = c !== null && c.degraded === true ? "" : "none";
  nodes.config.registrar.textContent = c === null || c.registrarEnabled === null
    ? fmtDash(null) : t(c.registrarEnabled ? "ov.config.on" : "ov.config.off");
  nodes.config.primary.textContent = c === null ? fmtDash(null) : (c.primary === null ? t("ov.config.none") : c.primary);
  nodes.config.fallback.textContent = c === null ? fmtDash(null) : (c.fallback === null ? t("ov.config.none") : c.fallback);
  nodes.config.targetKeys.textContent = c === null ? fmtDash(null) : fmtCount(c.targetKeys);
  if (c === null) {
    nodes.config.envLocked.textContent = fmtDash(null);
    nodes.config.envLocked.removeAttribute("title");
  } else {
    nodes.config.envLocked.textContent = t("ov.config.envLocked", { count: fmtCount(c.envLocked.length) });
    nodes.config.envLocked.title = c.envLocked.length === 0
      ? "" : t("ov.config.envLockedTip", { fields: c.envLocked.join(", ") });
  }
}

function renderStorageCard() {
  const si = storageInfo(data);
  nodes.storageCard.backend.textContent = si.backend === null
    ? fmtDash(null) : t(storageBackendLabelKey(si.backend));
  nodes.storageCard.writable.textContent = si.writable === null
    ? fmtDash(null) : t(si.writable ? "ov.runtime.writableYes" : "ov.runtime.writableNo");

  if (si.backend === null) {
    nodes.storageCard.note.textContent = fmtDash(null);
  } else if (si.backend === "kv") {
    const estimate = kvReadEstimatePerIsolatePerDay(data);
    nodes.storageCard.note.textContent = estimate === null
      ? t("ov.storageCard.workerNoteUnknown")
      : t("ov.storageCard.workerNote", { estimate: fmtCount(estimate) });
  } else {
    nodes.storageCard.note.textContent = t("ov.storageCard.nodeNote");
  }
}

function render() {
  // 读失败一律当「没有数据」：所有子渲染函数都要能安全处理 data === null
  // （逐块降级来自后端，这里再叠一层「整段响应都没读到」的兜底）。
  if (loadError) data = null;
  renderPoolCards();
  renderRuntimeTiles();
  renderFreshness();
  renderUsage();
  renderConfig();
  renderStorageCard();
}

async function loadCapabilities() {
  if (caps !== null) return;
  try {
    caps = await api.get("/capabilities");
  } catch (e) {
    // 拿不到就是拿不到，colo 那一格保持 —；不重试到下一次 onShow。
  }
}

async function load() {
  if (abort) abort.abort();
  abort = new AbortController();
  try {
    const body = await api.get("/overview", { signal: abort.signal });
    data = body;
    loadError = false;
  } catch (e) {
    if (e && e.name === "AbortError") return;
    loadError = true;
  }
  render();
}

function buildPoolCards(section) {
  const cardRow = el("div", { class: "card-row" });
  const values = {};
  for (const card of POOL_CARDS) {
    const { card: node, value } = tile(poolCardLabelKey(card));
    values[card] = value;
    cardRow.appendChild(node);
  }
  section.appendChild(cardRow);
  return values;
}

function buildRuntimeTiles(section) {
  section.appendChild(elI18n("h3", "ov.runtime.title"));
  const row1 = el("div", { class: "card-row" });
  const row2 = el("div", { class: "card-row" });
  const specs = [
    ["ov.runtime.version", row1], ["ov.runtime.runtimeLabel", row1],
    ["ov.runtime.serverTime", row1], ["ov.runtime.storageBackend", row1],
    ["ov.runtime.memory", row2], ["ov.runtime.uptime", row2],
    ["ov.runtime.pid", row2], ["ov.runtime.writable", row2],
  ];
  const values = {};
  const keyOf = {
    "ov.runtime.version": "version", "ov.runtime.runtimeLabel": "runtimeLabel",
    "ov.runtime.serverTime": "serverTime", "ov.runtime.storageBackend": "storageBackend",
    "ov.runtime.memory": "memory", "ov.runtime.uptime": "uptime",
    "ov.runtime.pid": "pid", "ov.runtime.writable": "writable",
  };
  for (const [labelKey, host] of specs) {
    const { card, value } = tile(labelKey);
    values[keyOf[labelKey]] = value;
    host.appendChild(card);
  }
  section.appendChild(row1);
  section.appendChild(row2);
  return values;
}

function buildFreshnessCard(section) {
  const { wrap, body } = block("ov.freshness.title");
  const pool = el("p");
  const config = el("p");
  body.appendChild(pool);
  body.appendChild(config);
  section.appendChild(wrap);
  return { pool, config };
}

function buildUsageCard(section) {
  const { wrap, body } = block("ov.usage.title");
  const cardRow = el("div", { class: "card-row" });
  const specs = [
    ["ov.usage.requests", "requests"], ["ov.usage.success", "success"],
    ["ov.usage.failed", "failed"], ["ov.usage.clientErrors", "clientErrors"],
    ["ov.usage.successRate", "successRate"],
  ];
  const values = {};
  for (const [labelKey, k] of specs) {
    const { card, value } = tile(labelKey);
    values[k] = value;
    cardRow.appendChild(card);
  }
  body.appendChild(cardRow);
  body.appendChild(elI18n("p", "ov.usage.tip", { class: "muted note" }));
  section.appendChild(wrap);
  return values;
}

function buildConfigCard(section) {
  const banner = elI18n("div", "ov.config.degradedBanner", { class: "banner-danger" });
  banner.style.display = "none";
  section.appendChild(banner);

  const { wrap, body } = block("ov.config.title");
  const registrar = row("ov.config.registrar");
  const primary = row("ov.config.primary");
  const fallback = row("ov.config.fallback");
  const targetKeys = row("ov.config.targetKeys");
  const envLocked = row("ov.config.envLocked");
  for (const r of [registrar, primary, fallback, targetKeys, envLocked]) body.appendChild(r.p);
  section.appendChild(wrap);
  return {
    banner,
    registrar: registrar.value, primary: primary.value, fallback: fallback.value,
    targetKeys: targetKeys.value, envLocked: envLocked.value,
  };
}

function buildStorageCard(section) {
  const { wrap, body } = block("ov.storageCard.title");
  const backend = row("ov.storageCard.backend");
  const writable = row("ov.storageCard.writable");
  body.appendChild(backend.p);
  body.appendChild(writable.p);
  const note = el("p", { class: "muted note" });
  body.appendChild(note);
  section.appendChild(wrap);
  return { backend: backend.value, writable: writable.value, note };
}

export const overviewSection = {
  init(section) {
    section.textContent = "";
    section.appendChild(elI18n("h2", "ov.title"));
    const refresh = elI18n("button", "common.refresh", { type: "button" });
    refresh.addEventListener("click", () => { load(); });
    section.appendChild(refresh);

    const pool = buildPoolCards(section);
    const runtime = buildRuntimeTiles(section);
    const freshness = buildFreshnessCard(section);
    const usage = buildUsageCard(section);
    const config = buildConfigCard(section);
    const storageCard = buildStorageCard(section);

    nodes = { pool, runtime, freshness, usage, config, storageCard };
  },

  onShow() {
    loadCapabilities().then(() => render());
    load();
  },

  onHide() {
    if (abort) { abort.abort(); abort = null; }
  },
};
