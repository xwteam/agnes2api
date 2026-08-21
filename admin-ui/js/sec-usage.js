/**
 * 用量板块（设计文档 §10.6）：
 * 6 张汇总卡 + 时间范围按钮组 + 日汇总表 + 点某天下钻到「小时 / 模型 / 协议」三张表。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * 三条纪律：①一切来自接口的内容一律 textContent（`byModel` 的键来自客户端填的
 * 模型名，完全不可信）；②**取值决策一律不写在这里**，全在 `js/pure/usage.mjs` 里
 * （admin-ui/README.md 硬规则 1），四态判定由 `tests/ui/usage.test.ts` 的
 * 「四种状态互不重叠 —— 『没开』『读不出来』『真的是 0』『有数据』揉在一起就是撒谎」
 * 那一格钉着；③**一切形态分支只读接口返回的字段**，不许自己嗅探运行时（全局约束 1）。
 *
 * ── **本板块不轮询** ────────────────────────────────────────────────────────
 * 每刷新一次要付「天数 × 分片槽位」次存储读，而配额账把面板的读算成
 *「人点一下才发生」。刷新是手动的 + 切时间范围时。`onHide()` 停掉在飞请求。
 *
 * ── 「统计开没开」只读一个出口 ─────────────────────────────────────────────
 * `GET /admin/api/capabilities` 的 `stats.tier2Enabled` 与 `GET /admin/api/usage`
 * 的 `tier` 说的是同一件事，由 `tests/contract/admin-usage.test.ts` 的
 * 「capabilities 的 tier2Enabled 与 usage 的 tier 说的是同一件事 —— 两边不许分叉」
 * 那一格钉着。**本板块只读后者**（经 `usageState()`）：两个出口都读的话，
 * 面板就要面对「它们不一致时听谁的」这个不该存在的问题，而那正是本期核心
 * 设计决定（同一份知识只许有一份）在这个板块的落点。
 * `capabilities` 在这里只提供两个**数字**：落盘间隔与 token 覆盖到的协议 id。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n } from "./ui.js";
import { fmtCount, fmtDash, fmtDuration, fmtInstant, fmtPercent } from "./pure/format.mjs";
import { offsetMs } from "./pure/overview.mjs";
import {
  RANGES, DEFAULT_RANGE, rangeLabelKey, rangeToQuery,
  usageState, summaryCards, malformedKind, usageNoteKey, noteSeverity,
  dayRows, breakdownRows, tokensCoverageLabels, pendingTail, cellKind, ratioKind,
} from "./pure/usage.mjs";

/**
 * EN DASH（U+2013）。**与 `fmtDash(null)` 交出来的 EM DASH（U+2014）是两个记号，
 * 说的是两件事**：这一根是「读成功了，只是没有样本」，那一根是「我们不知道」。
 * **哪一格用哪一根由 `pure/usage.mjs` 的 `cellKind` / `ratioKind` 决定**，
 * 这里只负责把它画出来——让板块文件自己目测就等于把三态判定抄回了 DOM 代码。
 */
const EN_DASH = "–";

let nodes = null;
let abort = null;
/**
 * 在飞请求的世代号。**`AbortController` 一个人守不住这件事**：
 * `fetch` 的 abort 在真实浏览器里是异步的，而在 `tests/helpers/fake-dom.ts`
 * 那套替身下 `fetch` 压根不看 signal ⇒ 只靠 `e.name === "AbortError"` 分支的话，
 * 「切走再回来，上一次的响应把新数据覆盖掉」这件事**在两种环境里都可能发生，
 * 而在测试里恒不可观测**（第 8 / 第 9 两种假阳性合起来的形态）。
 * 世代号是同步的、两种环境里行为逐字相同，由
 * `tests/ui/dom/usage-section.test.ts` 的
 * 「切走板块时在飞请求被作废 —— 回来时不会被上一次的响应覆盖」那一格钉着。
 */
let seq = 0;
/** 下钻的世代号。**与 `seq` 分开**，理由见 `openDay()` 上方那段。 */
let detailSeq = 0;
/** 最近一次成功的 `/usage` 响应；`null` = 还没有过一次成功（或上一次失败了）。 */
let data = null;
/** `/capabilities` 与 `/models` 各拉一次（都是零存储读的静态数据）。 */
let caps = null;
let catalog = null;
let range = DEFAULT_RANGE;
/** 当前展开的那一天（`YYYY-MM-DD`）与它的响应。`null` = 没有展开任何一天。 */
let detailDate = null;
let detailData = null;
let detailFailed = false;

/** 建一张 `.card`：标签 + 值。值那一格由调用方之后自己填。 */
function tile(labelKey, tipKey, tipParams) {
  const card = el("div", { class: "card" });
  const label = elI18n("div", labelKey, { class: "label" });
  if (tipKey !== undefined && tipKey !== null) {
    label.setAttribute("title", tipParams === undefined ? t(tipKey) : t(tipKey, tipParams));
  }
  card.appendChild(label);
  const value = el("div", { class: "value" });
  card.appendChild(value);
  return { card, value };
}

/** 一个内容块：标题 + 空的 body 容器。 */
function block(titleKey) {
  const wrap = el("div", { class: "card block" });
  wrap.appendChild(elI18n("h3", titleKey));
  const body = el("div");
  wrap.appendChild(body);
  return { wrap, body };
}

/**
 * `≈` 标记的 tooltip。**落盘间隔这个数从 `capabilities` 取，不在前端算死**
 *（全局约束 10：诚实标记由后端字段驱动；写死会在改后端常量的那天变成一句假话）。
 * 拿不到 capabilities 时换一句**不带那个数**的话，而不是编一个缺省值。
 */
function approxTitle() {
  const ms = caps && caps.stats && typeof caps.stats.flushIntervalMs === "number"
    && Number.isFinite(caps.stats.flushIntervalMs) ? caps.stats.flushIntervalMs : null;
  return ms === null ? t("usage.approxTipUnknown") : t("usage.approxTip", { flush: fmtDuration(ms) });
}

/**
 * 把一个数字格填成三态里的一种。
 *
 * `kind` 来自 `cellKind` / `ratioKind`，**不是这里判的**：
 * · `"value"` —— 那个数字（可能带 `≈` 与「不完整」两个前缀标记）；
 * · `"none"`  —— EN DASH，「读成功了，这段时间没有样本」；
 * · `"unknown"` —— `fmtDash(null)` 的 EM DASH，「我们不知道」。
 *
 * ⚠️ **计数类在 `empty` 态拿到的 `kind` 是 `"value"`、值是 `0`** ——那一格就该写 `0`。
 * 把真零画成破折号是**反向的撒谎**，与「接口失败伪造 0」同样严重、方向相反。
 */
function fillCell(node, kind, text, marks) {
  node.textContent = "";
  if (kind === "unknown") {
    node.appendChild(el("span", { class: "usage-unknown", title: t("usage.cell.unknownTip") }, fmtDash(null)));
    return;
  }
  if (kind === "none") {
    node.appendChild(el("span", { class: "usage-none", title: t("usage.cell.noneTip") }, EN_DASH));
    return;
  }
  if (marks && marks.approx) {
    node.appendChild(el("span", { class: "approx", title: approxTitle() }, "≈ "));
  }
  if (marks && marks.incompleteOf !== null && marks.incompleteOf !== undefined) {
    const warn = el("span", { class: "usage-incomplete" }, `${t("usage.incomplete")} `);
    warn.setAttribute("title", t("usage.incompleteTip", { malformed: fmtCount(marks.incompleteOf) }));
    node.appendChild(warn);
  }
  node.appendChild(el("span", null, text));
}

/**
 * Tier-2 关闭时的说明卡。**一个数字格都不渲染**（设计 §10.6：不画空图表）——
 * 一张全是 0 的表会被读成「这段时间没人用」，而事实是这个部署根本没在记账。
 *
 * ⚠️⚠️ **设计 §10.6 的原话是「一张说明卡 +『开启时间序列统计』按钮（跳设置页）」，
 * 而这里刻意没有那颗按钮，理由是它会把运维送到一个没有这个开关的页面上**：
 * `usageStatsEnabled` **今天不在 `EDITABLE` 里**，`src/core/config.ts` 的
 * `usageStatsEnabled` 字段上方逐字写着「不进 `EDITABLE`，是因为设置页本期没有
 * 它的入口——进了就会得到一份『说能改、却没有任何地方能改』的字段清单」，
 * 而 `admin-ui/js/pure/settings.mjs` 的三张卡（`CARD_AUTH` / `CARD_UPSTREAM` /
 * `CARD_REGISTRAR`）里确实一格都没有它。
 * ⇒ 那颗按钮会是本仓反复裁过的同一个形态：**面板说一件事、实际是另一件事**。
 * 换成写清「怎么开」——环境变量 + 重启，那是今天唯一真的能开它的路径。
 * **这条偏离是刻意的，登记在 P3d Task 5 的报告里。**
 */
function buildOffCard() {
  const { wrap, body } = block("usage.off.title");
  body.appendChild(elI18n("p", "usage.off.body"));
  body.appendChild(elI18n("p", "usage.off.howto"));
  const cost = el("p", { class: "muted note" });
  const ms = caps && caps.stats && typeof caps.stats.flushIntervalMs === "number"
    && Number.isFinite(caps.stats.flushIntervalMs) ? caps.stats.flushIntervalMs : null;
  // ⚠️ 那个开销数字**来自 capabilities**，不在前端算死（设计 §10.6 + 全局约束 10）。
  cost.textContent = ms === null ? t("usage.off.costUnknown") : t("usage.off.cost", { flush: fmtDuration(ms) });
  body.appendChild(cost);
  body.appendChild(elI18n("p", "usage.off.tier1", { class: "muted note" }));
  return wrap;
}

/**
 * 时间范围按钮组 + 覆盖区间 + 30 天那一档的保留期说明。
 *
 * 按钮组**复用事件板块那套 `.btn-group` / `.btn-toggle`**，不新起一套 class：
 * 两个板块的这个控件在交互与外观上是同一件东西，各写一份迟早长得不一样。
 */
function buildRangeBar() {
  const wrap = el("div");
  const bar = el("div", { class: "btn-group" });
  bar.appendChild(elI18n("span", "usage.rangeLabel", { class: "muted" }));
  for (const r of RANGES) {
    const key = rangeLabelKey(r);
    // 表外的档位不该存在（`RANGES` 与 `rangeLabelKey` 同一个文件），
    // 但真出现时**把原值照实显示出来**，不冒充任何一档已知档位。
    const btn = key === null
      ? el("button", { type: "button", class: "btn-toggle", "data-range": r }, r)
      : elI18n("button", key, { type: "button", class: "btn-toggle", "data-range": r });
    btn.classList.toggle("active", r === range);
    btn.addEventListener("click", () => {
      if (range === r) return;
      range = r;
      // 换档位就换了一段区间，上一天的下钻不再属于这一段 —— 连同它在飞的那份一起作废。
      detailDate = null;
      detailData = null;
      detailFailed = false;
      detailSeq++;
      load();
    });
    bar.appendChild(btn);
  }
  wrap.appendChild(bar);

  // **渲染服务端回读的 `range`**，不自己算显示区间：滚动 30 天会横跨 31 个 UTC 日，
  // 而服务端按整天取整之后回读的才是它真正查过的那一段。
  const covered = el("p", { class: "muted note" });
  const r = data && typeof data === "object" ? data.range : null;
  if (r !== null && r !== undefined && typeof r === "object"
    && typeof r.from === "number" && typeof r.to === "number") {
    covered.textContent = t("usage.covered", {
      from: fmtInstant(r.from, offsetMs()),
      to: fmtInstant(r.to, offsetMs()),
    });
  } else {
    covered.textContent = t("usage.covered", { from: fmtDash(null), to: fmtDash(null) });
  }
  wrap.appendChild(covered);

  if (range === "30d") wrap.appendChild(elI18n("p", "usage.range.retention", { class: "muted note" }));
  return wrap;
}

/**
 * 顶部横幅。**判据全部来自响应字段**（全局约束 10），一条都不在这里硬编码。
 *
 * ⚠️⚠️ **`note` 可能是这个面板还不认识的 code。**
 * `tests/contract/admin-usage.test.ts` 的
 * 「八种状态两两不同 —— 面板不用猜，也不该猜（但这一格证明不了没有第九种）」
 * 那一格的名字自己就把边界说清了。表外的 code 走 `usage.note.unknown`
 * **把原码照实显示出来**，绝不退回一句「加载失败」。
 */
function buildNoteBanner(note) {
  const key = usageNoteKey(note);
  const severity = noteSeverity(note);
  if (severity === null) return null;
  const cls = severity === "error" ? "banner-danger" : severity === "warn" ? "banner-warn" : "banner-info";
  const banner = el("div", { class: cls, role: "status" });
  if (key === null) {
    banner.appendChild(el("span", null, t("usage.note.unknown", { code: String(note) })));
  } else {
    banner.appendChild(elI18n("span", key));
  }
  if (severity === "error") banner.appendChild(retryButton());
  return banner;
}

function retryButton() {
  const btn = elI18n("button", "common.refresh", { type: "button", class: "usage-retry" });
  btn.addEventListener("click", () => { load(); });
  return btn;
}

/** 六张汇总卡（设计 §10.6）。 */
function buildCards(state) {
  const c = summaryCards(data);
  // `≈` 由后端的 `approximate` 驱动，**不在前端硬编码 true**（全局约束 10）。
  const approx = data !== null && typeof data === "object" && data.approximate === true;
  // 「不完整」由 `malformedKind` 驱动 —— `partial` 那一档的数字是真的，只是不全，
  // 渲染成完整的就是伪造「这份数据是全的」这个印象。
  const incompleteOf = c.complete ? null : c.malformed;
  const marks = { approx, incompleteOf };

  const row = el("div", { class: "card-row" });
  const specs = [];

  const requests = tile("usage.card.requests");
  fillCell(requests.value, cellKind(state, c.requests), fmtCount(c.requests), marks);
  specs.push(requests.card);

  const successRate = tile("usage.card.successRate");
  fillCell(successRate.value, ratioKind(state, c.requests), fmtPercent(c.success, c.requests), marks);
  specs.push(successRate.card);

  const latency = tile("usage.card.latency");
  fillCell(latency.value, cellKind(state, c.latencyMs), fmtCount(c.latencyMs), marks);
  specs.push(latency.card);

  const errorRate = tile("usage.card.errorRate");
  fillCell(errorRate.value, ratioKind(state, c.requests), fmtPercent(c.errors, c.requests), marks);
  specs.push(errorRate.card);

  // ⚠️ **协议 id → 展示名走 `GET /admin/api/models` 的 `protocols[].label`**，
  //    id 本身来自 `capabilities.stats.tokensCoverage`（评审 I20）。
  //    三条都不许走：本地再写一张映射、把 id 拼进一个 i18n key、直接渲染裸 id。
  const coverage = caps && caps.stats ? caps.stats.tokensCoverage : null;
  const labels = tokensCoverageLabels(coverage, catalog === null ? null : catalog.protocols);
  const tokens = labels === null
    ? tile("usage.card.tokens", "usage.card.tokensTipUnknown")
    : tile("usage.card.tokens", "usage.card.tokensTip", { protocols: labels.join(" · ") });
  fillCell(
    tokens.value, cellKind(state, c.tokensIn),
    `${fmtCount(c.tokensIn)} / ${fmtCount(c.tokensOut)}`, marks,
  );
  specs.push(tokens.card);

  const streaming = tile("usage.card.streaming", "usage.card.streamingTip");
  fillCell(streaming.value, cellKind(state, c.streamingRequests), fmtCount(c.streamingRequests), marks);
  specs.push(streaming.card);

  for (const card of specs) row.appendChild(card);
  return row;
}

/** 一行「表头」。 */
function headRow(keys) {
  const tr = el("tr");
  for (const k of keys) tr.appendChild(elI18n("th", k));
  return tr;
}

/** 日汇总表。点「下钻」展开那一天的分解。 */
function buildDayTable() {
  const { wrap, body } = block("usage.table.title");
  const rows = dayRows(data);
  if (rows.length === 0) {
    body.appendChild(elI18n("p", "usage.table.empty", { class: "muted note" }));
    return wrap;
  }
  const table = el("table");
  table.appendChild(headRow([
    "usage.table.date", "usage.table.requests", "usage.table.success", "usage.table.errors",
    "usage.table.tokens", "usage.table.streaming", "usage.table.latency", "usage.table.drill",
  ]));
  for (const row of rows) {
    // 这一行的桶读不出来时整行按 `unavailable` 渲染（EM DASH），**不补一行 0**。
    const rowState = row.total === null ? "unavailable" : "data";
    const b = summaryCards({ total: row.total, shards: 0, malformed: 0 });
    const tr = el("tr");
    tr.appendChild(el("td", { class: "mono" }, row.date));
    const cells = [
      [cellKind(rowState, b.requests), fmtCount(b.requests)],
      [cellKind(rowState, b.success), fmtCount(b.success)],
      [cellKind(rowState, b.errors), fmtCount(b.errors)],
      [cellKind(rowState, b.tokensIn), `${fmtCount(b.tokensIn)} / ${fmtCount(b.tokensOut)}`],
      [cellKind(rowState, b.streamingRequests), fmtCount(b.streamingRequests)],
      [cellKind(rowState, b.latencyMs), fmtCount(b.latencyMs)],
    ];
    for (const [kind, text] of cells) {
      const td = el("td", { class: "mono" });
      fillCell(td, kind, text, null);
      tr.appendChild(td);
    }
    const actions = el("td");
    const drill = elI18n("button", "usage.table.drill", { type: "button", class: "usage-drill" });
    drill.addEventListener("click", () => { openDay(row.date); });
    actions.appendChild(drill);
    tr.appendChild(actions);
    table.appendChild(tr);
  }
  body.appendChild(table);
  return wrap;
}

/** 分解表的一张（小时 / 模型 / 协议共用）。 */
function breakdownTable(titleKey, keyLabelKey, map, numeric) {
  const wrap = el("div", { class: "usage-breakdown" });
  wrap.appendChild(elI18n("h4", titleKey));
  const rows = breakdownRows(map, numeric);
  if (rows.length === 0) {
    wrap.appendChild(elI18n("p", "usage.detail.empty", { class: "muted note" }));
    return wrap;
  }
  const table = el("table");
  table.appendChild(headRow([
    keyLabelKey, "usage.table.requests", "usage.table.success", "usage.table.errors",
    "usage.table.tokens", "usage.table.streaming", "usage.table.latency",
  ]));
  for (const row of rows) {
    const rowState = row.total === null ? "unavailable" : "data";
    const b = summaryCards({ total: row.total, shards: 0, malformed: 0 });
    const tr = el("tr");
    // ⚠️ **键来自客户端填的模型名，一律 textContent**（`el()` 走的就是它）。
    tr.appendChild(el("td", { class: "mono" }, row.key));
    const cells = [
      [cellKind(rowState, b.requests), fmtCount(b.requests)],
      [cellKind(rowState, b.success), fmtCount(b.success)],
      [cellKind(rowState, b.errors), fmtCount(b.errors)],
      [cellKind(rowState, b.tokensIn), `${fmtCount(b.tokensIn)} / ${fmtCount(b.tokensOut)}`],
      [cellKind(rowState, b.streamingRequests), fmtCount(b.streamingRequests)],
      [cellKind(rowState, b.latencyMs), fmtCount(b.latencyMs)],
    ];
    for (const [kind, text] of cells) {
      const td = el("td", { class: "mono" });
      fillCell(td, kind, text, null);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

/**
 * 单日下钻。
 *
 * ⚠️⚠️ **这一条端点根本不发 `all_malformed` / `partial_malformed`**
 *（`src/http/admin/handlers/usage.ts` 的 `usageDateHandler` 常态恒是
 * `no_request_detail`）⇒ 「这一天的分解缺没缺几块」**只能靠 `shards` / `malformed`
 * 两个字段**，走的是与汇总卡同一个 `malformedKind`。
 * 同一件事在两条端点上有两套判据，这是后端契约本身的形状，不是这里多写了一层。
 */
function buildDetail() {
  const wrap = el("div", { class: "card block" });
  const head = el("div", { class: "usage-detail-head" });
  head.appendChild(el("h3", null, t("usage.detail.title", { date: detailDate })));
  const close = elI18n("button", "usage.detail.close", { type: "button" });
  close.addEventListener("click", () => {
    detailDate = null;
    detailData = null;
    detailFailed = false;
    // 收起时同样把在飞的那份作废：不然它回来会把一个已经关掉的块又填上内容。
    detailSeq++;
    render();
  });
  head.appendChild(close);
  wrap.appendChild(head);

  if (detailFailed) {
    const banner = el("div", { class: "banner-danger", role: "status" });
    banner.appendChild(elI18n("span", "common.loadFailed"));
    wrap.appendChild(banner);
    return wrap;
  }
  if (detailData === null) return wrap;

  const note = typeof detailData.note === "string" ? detailData.note : null;
  const banner = buildNoteBanner(note);
  if (banner !== null) wrap.appendChild(banner);

  // 缺了几块这件事在这条端点上只有字段说得出来。
  const kind = malformedKind(detailData);
  if (kind === "partial" || kind === "all") {
    const warn = el("p", { class: "muted note usage-incomplete" });
    warn.textContent = t("usage.incompleteTip", { malformed: fmtCount(detailData.malformed) });
    wrap.appendChild(warn);
  }

  wrap.appendChild(breakdownTable("usage.detail.hours", "usage.detail.hour", detailData.hours, true));
  wrap.appendChild(breakdownTable("usage.detail.models", "usage.detail.model", detailData.byModel, false));
  wrap.appendChild(breakdownTable("usage.detail.protocols", "usage.detail.protocol", detailData.byProtocol, false));
  return wrap;
}

/**
 * 整个板块重画一遍。
 *
 * **每次都把 body 清空重建**，理由是「Tier-2 关着时页面上一个数字格都没有」
 * 这条性质要**在 DOM 里成立**，不是靠 `display: none` 藏起来：藏起来的格子
 * 仍然在无障碍树里、仍然会被复制粘贴带走，而它们显示的是一份不存在的数据。
 */
function render() {
  const host = nodes.body;
  host.textContent = "";
  const state = usageState(data);

  if (state === "off") {
    host.appendChild(buildOffCard());
    return;
  }

  host.appendChild(buildRangeBar());

  const note = data !== null && typeof data === "object" && typeof data.note === "string" ? data.note : null;
  const banner = buildNoteBanner(note);
  if (banner !== null) host.appendChild(banner);
  if (banner === null && state === "unavailable") {
    // 整条响应都没拿到（网络断了 / 解析失败）：后端没有 note 可读，
    // 但**六张卡已经全是 EM DASH**，顶部必须把「这是读取失败」说出来。
    const fail = el("div", { class: "banner-danger", role: "status" });
    fail.appendChild(elI18n("span", "common.loadFailed"));
    fail.appendChild(retryButton());
    host.appendChild(fail);
  }
  // 「这段时间真的是 0」要有自己的一句话。`note` 已经用 info 档说过同一件事时
  // 不再重复（③ `no_shards`），而第 ④ 种状态的 `note` 是 `null`、没人替它说。
  if (state === "empty" && (usageNoteKey(note) === null || noteSeverity(note) !== "info")) {
    const empty = el("div", { class: "banner-info", role: "status" });
    empty.appendChild(elI18n("span", "usage.empty"));
    host.appendChild(empty);
  }

  host.appendChild(buildCards(state));

  // 未落盘的尾巴。判据是 `count`，**不是 `ms`**（见 `pendingTail` 的说明）。
  const tail = pendingTail(data);
  if (tail !== null) {
    const p = el("p", { class: tail.budgetExhausted ? "banner-warn" : "muted note" });
    p.textContent = tail.budgetExhausted
      ? t("usage.pendingExhausted", { count: fmtCount(tail.count) })
      : t("usage.pending", { count: fmtCount(tail.count) });
    host.appendChild(p);
  }

  host.appendChild(buildDayTable());
  if (detailDate !== null) host.appendChild(buildDetail());
}

/**
 * 拉汇总。**世代号在发请求之前就 +1**，回来时对不上就整份丢掉
 *（见 `seq` 上方那段：`AbortController` 一个人守不住这件事）。
 */
async function load() {
  if (abort) abort.abort();
  abort = new AbortController();
  const mine = ++seq;
  const signal = abort.signal;
  const q = rangeToQuery(range, Date.now());
  try {
    // `q` 为 null 只在本机时钟坏掉时发生；那时不发请求，让上一次的数据留着，
    // 而**上一次的数据本来就带着它自己的 `generatedAt`**，不会被说成是新的。
    if (q === null) return;
    const body = await api.get(`/usage?from=${q.from}&to=${q.to}`, { signal });
    if (mine !== seq) return;
    data = body;
  } catch (e) {
    if (mine !== seq) return;
    if (e && e.name === "AbortError") return;
    // **不伪造上一次的数据**：读失败就把 data 清空，不留着旧值以为它是新的。
    data = null;
  }
  render();
}

/**
 * 拉某一天的分解。
 *
 * ⚠️ **它有自己的世代号，不共用 `seq`**：一开始写的是共用，而那会在一个很常见的
 * 操作序列上把下钻卡成空的 —— 点开某一天之后**再点一次「刷新」**，`load()` 把 `seq`
 * 顶上去，回来的那份分解就被当成过期的丢掉了，而那一天明明还开着。
 * 两件事的作废条件本来就不同：切走板块要把两者一起作废（`onHide()` 两个都 +1），
 * 但重拉汇总**不该**作废一次仍然有效的下钻。
 */
async function openDay(date) {
  detailDate = date;
  detailData = null;
  detailFailed = false;
  const mine = ++detailSeq;
  render();
  try {
    const body = await api.get(`/usage/${encodeURIComponent(date)}`);
    if (mine !== detailSeq) return;
    detailData = body;
  } catch (e) {
    if (mine !== detailSeq) return;
    detailFailed = true;
  }
  render();
}

/**
 * `capabilities` 与 `models` 各拉一次，**同一个 `Promise.all` 发**（都是零存储读）。
 * 拿不到就是拿不到：落盘间隔那句话换成不带数字的一版、Token 卡的 tooltip 换成
 * 「覆盖范围读不出来」，**不编缺省值**。
 */
async function loadStatic() {
  if (caps !== null && catalog !== null) return;
  const [c, m] = await Promise.all([
    caps === null ? api.get("/capabilities").catch(() => null) : Promise.resolve(caps),
    catalog === null ? api.get("/models").catch(() => null) : Promise.resolve(catalog),
  ]);
  if (c !== null) caps = c;
  if (m !== null) catalog = m;
}

export const usageSection = {
  init(section) {
    section.textContent = "";
    section.appendChild(elI18n("h2", "usage.title"));
    const refresh = elI18n("button", "common.refresh", { type: "button" });
    refresh.addEventListener("click", () => { load(); });
    section.appendChild(refresh);
    const body = el("div");
    section.appendChild(body);
    nodes = { body };
  },

  onShow() {
    loadStatic().then(() => { if (nodes !== null) render(); });
    load();
  },

  onHide() {
    // **两件事都要做**：abort 省掉真实网络往返，世代号保证回来的那份被丢掉。
    // **两个世代号都要 +1**：切走板块时汇总与下钻都不该再落地。
    if (abort) { abort.abort(); abort = null; }
    seq++;
    detailSeq++;
  },
};
