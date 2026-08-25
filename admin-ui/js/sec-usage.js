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
  usageState, detailState, rowState, readSucceeded, summaryCards, bucketCells,
  malformedKind, usageNoteKey, noteSeverity,
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
 * `fetch` 的 abort 在真实浏览器里是异步的，而 DOM 用例里那个 `fetch` 替身
 *（`tests/ui/dom/harness.ts` 的 `bootPanel()` 用 `vi.stubGlobal("fetch", …)` 装的那一个）
 * **压根不看 signal** ⇒ 只靠 `e.name === "AbortError"` 分支的话，
 * 「切走再回来，上一次的响应把新数据覆盖掉」这件事**在两种环境里都可能发生，
 * 而在测试里恒不可观测**（第 8 / 第 9 两种假阳性合起来的形态）。
 * 世代号是同步的、两种环境里行为逐字相同，由
 * `tests/ui/dom/usage-section.test.ts` 的
 * 「切走板块时在飞请求被作废 —— 回来时不会被上一次的响应覆盖」那一格钉着。
 */
let seq = 0;
/** 下钻的世代号。**与 `seq` 分开**，理由见 `openDay()` 上方那段。 */
let detailSeq = 0;
/**
 * 板块现在是不是显示着。**`loadStatic()` 那条链唯一的作废判据**（评审 M5）：
 * 它不经 `load()`，所以拿不到世代号；切走之后它回来重绘一个不可见的板块，
 * 今天没有用户可见的后果，但那是「一条没有作废条件的异步链」——
 * 本板块另外两条都有，这一条没有理由是例外。
 */
let shown = false;
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
  // **标题节点要交出去**：`≈` 得真的挂在标题上，而不是挂在整张表下面
  //（P3d Task 5 收口复评 G2：上一版 append 到 `wrap` ⇒ 子节点序是
  // `h3, div, span.approx`，`≈` 落在表格**下面**，与注释和用例名都对不上，
  // 而用例只数个数 ⇒ 改 append 目标那一行**不会红**）。
  const head = elI18n("h3", titleKey);
  wrap.appendChild(head);
  const body = el("div");
  wrap.appendChild(body);
  return { wrap, body, head };
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
    // ⚠️ **`aria-pressed` 两支都要写**：这是一个三元，两支各自是一个创建点。
    //    只补有 i18n key 的那一支的话，表外档位那颗按钮会成为唯一读不出选中态的按钮
    //    ——而那正是最需要被读清楚的一颗（它显示的是原值，本来就已经不好理解）。
    const pressed = r === range ? "true" : "false";
    const btn = key === null
      ? el("button", { type: "button", class: "btn-toggle", "data-range": r, "aria-pressed": pressed }, r)
      : elI18n("button", key, { type: "button", class: "btn-toggle", "data-range": r, "aria-pressed": pressed });
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
function buildNoteBanner(note, onRetry) {
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
  if (severity === "error") banner.appendChild(retryButton(onRetry));
  return banner;
}

/**
 * 重试按钮。**`onRetry` 是必填的**：上一版无参数、一律调 `load()`，
 * 于是单日下钻那条错误横幅上的「刷新」重拉的是**汇总**而不是那一天
 * ——一颗按了不解决问题的按钮（P3d Task 5 评审 M1）。
 */
function retryButton(onRetry) {
  const btn = elI18n("button", "common.refresh", { type: "button", class: "usage-retry" });
  btn.addEventListener("click", () => { onRetry(); });
  return btn;
}

/**
 * 这一份响应上的两个诚实标记。两个都由后端字段驱动（全局约束 10）：
 * `≈` 看 `approximate`，「不完整」看 `malformedKind`。**一个都不许在前端硬编码。**
 *
 * ⚠️⚠️ **`incompleteOf` 判据直接走 `malformedKind()`，刻意不经 `summaryCards().complete`**
 *（P3d Task 5 定向复评 N2）：`complete` 是拿 `total` 算的
 *（`total === null ? true : …`），而 **`GET /admin/api/usage/:date` 的响应里
 * 根本没有 `total` 字段**（`src/http/admin/handlers/usage.ts` 的 `usageDateHandler`
 * 返回的是 `hours` / `byModel` / `byProtocol` / `shards` / `malformed`）
 * ⇒ 在那条端点上 `complete` **恒为 true**、标记**结构性地永不渲染**。
 * 实证（node，入参 `{ shards: 4, malformed: 2, hours: {} }`）：
 * `malformedKind` 是 `"partial"` 而 `complete` 是 `true`。
 * ⭐ 记一条形状：**一个「只在另一条端点上成立」的判据，在这条端点上不会报错，
 * 它只是安静地永远为假**——那种失效没有任何一格用例会红，除非有人正面钉住它。
 * 由 `tests/ui/usage.test.ts` 的
 * 「summaryCards().complete 在单日下钻那份响应上恒为 true —— 它读的是 total，
 * 而那条端点没有 total，拿它当「缺没缺块」的判据是结构性错误」正面钉着。
 *
 * ⚠️ **这两个标记只给「整块」用**：六张卡是整段区间的合计，说它不完整是准确的；
 * **表格的每一行不许各自挂标记**，理由见 `buildDayTable` 上方（定向复评 N4）。
 */
function honestyMarks(resp) {
  return {
    approx: resp !== null && typeof resp === "object" && resp.approximate === true,
    // `partial` 那一档的数字是真的、只是不全 —— 渲染成完整的就是伪造
    // 「这份数据是全的」这个印象，而全局约束 9 禁的伪造不只是伪造 `0`。
    // `all` 那一档**不走这里**：那时一个数字都没有（整块是 `unavailable`），
    // 说「下面这些数字缺了几块」是在描述一堆不存在的数字（定向复评 N7）。
    // `malformedKind` 判成 `"partial"` 时 `malformed` 已经被 `finite()` 验过是数字，
    // 所以这里不再叠一层 `typeof` 兜底（收口复评 G6：那是一条走不到的支）。
    incompleteOf: malformedKind(resp) === "partial" ? resp.malformed : null,
  };
}

/**
 * 表格标题旁边那一个 `≈`。
 *
 * ⚠️ **表格里的数字与卡片上的一样是近似值，但 `≈` 只在这里出一次，不逐格出**
 *（定向复评 N5：上一版 `numberCells` 的 `marks` 形参恒为 `null` ⇒
 * 六张卡写 `≈ 100`、紧挨着的日表写 `100`，**同一个数字两种说法**，
 * 而那个不一致是沉默的——没有任何注释说过表里为什么不出）。
 * 逐格出的话 30 天档是 7 列 × 30 行 = 210 个 `≈`，那时它是装饰不是信号。
 * ⇒ **一张表出一个，挂在标题节点上**，tooltip 与卡片上那个逐字相同（同一个 `approxTitle()`）。
 *
 * ⚠️⚠️ **调用点必须先确认这一块真的出了数字**（收口复评 F1）：上一版在
 * 「这张表是空的」那条早退**之前**就无条件挂了它，实测（`days: null` /
 * `note: "read_failed"` / `approximate: true`）得到一张写着「这段区间的按天数据
 * 读不出来」的表、**下面挂着一个 `≈`**；而那一档下六张卡的 `≈` 反而都不出
 *（`fillCell` 的 `"unknown"` 支提前 return）⇒ **全页唯一一个 `≈` 就挂在
 * 那张说「读不出来」的表上**。
 * ⭐⭐ 记一条形状，它是本任务最贵的一条：**我在同一个提交里立了 N7 的裁定
 *（「下面一个数字都没有，就不许说『下面这些数字…』」），然后在另一处违反了它。**
 * ⇒ **立完一条裁定，回头 grep 一遍自己这一轮碰过的所有同型位置。**
 */
function approxTitleMark(marks) {
  if (marks === null || !marks.approx) return null;
  return el("span", { class: "approx", title: approxTitle() }, " ≈");
}

/** 六张汇总卡（设计 §10.6）。 */
function buildCards(state, marks) {
  const c = summaryCards(data);

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

/**
 * 往一行里塞那六个数字格。**日汇总表与三张分解表共用它。**
 *
 * ⚠️⚠️ **`state` 是整块的状态，不是这一行自己看出来的** —— 这是 P3d Task 5
 * 评审 C1 的根因那一句话在代码里的样子。上一版两张表各自写
 * `row.total === null ? "unavailable" : "data"`（**完全不看整块状态**），
 * 于是 `usageState` 判出来的 `unavailable` 一步都没往下传：
 * `all_malformed` 时六张卡正确地全是 EM DASH，**而紧挨着的日表把同一段区间
 * 写成「请求 0 次」**、延迟格还写着 EN DASH（= 「读成功了只是没样本」）。
 * 判据现在收在 `pure/usage.mjs` 的 `rowState()` 里，两张表都必须过它。
 *
 * ⚠️ **它不收 `marks`，这是刻意的**（定向复评 N5）：上一版留了一个第四形参
 * 而两个调用点都传 `null` ⇒ **一个恒为死的形参**，看起来像「表里也会出标记」
 * 而实际上永远不出。`≈` 改成一张表出一个、挂在标题上（见 `approxTitleMark`），
 * 「不完整」改成整块出一处（见 `buildDayTable` 上方）。**死形参一律删掉，
 * 不留着当占位**——留着的那个迟早会被人当成「已经接好了」。
 */
function numberCells(tr, state, bucket) {
  const st = rowState(state, bucket);
  const b = bucketCells(bucket);
  const cells = [
    [cellKind(st, b.requests), fmtCount(b.requests)],
    [cellKind(st, b.success), fmtCount(b.success)],
    [cellKind(st, b.errors), fmtCount(b.errors)],
    [cellKind(st, b.tokensIn), `${fmtCount(b.tokensIn)} / ${fmtCount(b.tokensOut)}`],
    [cellKind(st, b.streamingRequests), fmtCount(b.streamingRequests)],
    [cellKind(st, b.latencyMs), fmtCount(b.latencyMs)],
  ];
  for (const [kind, text] of cells) {
    const td = el("td", { class: "mono" });
    fillCell(td, kind, text, null);
    tr.appendChild(td);
  }
}

/** 表格里那个「键」格（日期 / 小时 / 模型名）。 */
function keyCell(text) {
  return el("td", { class: "mono" }, text);
}

/**
 * 日汇总表。点「下钻」展开那一天的分解。
 *
 * ⚠️⚠️ **表格的每一行不挂「不完整」标记，这一条是订正过的**（定向复评 N4）：
 * 上一版给**每一行**的日期格挂了一个，而 `malformed` 数的是**整段区间**的畸形分片
 * ⇒ 30 天档下 30 行全写「不完整」，其中绝大多数天其实是完整的
 * ——**对那些天它是一句假话**。上一版自己的注释还承认「我们并不知道具体哪一格短了」，
 * 却对每一格都下了断言。⭐ 记一条形状：**「我们不知道是哪一个」推不出
 * 「所以每一个都标上」，它只推得出「只能对整体说」。**
 * ⇒ 「缺了几块」**不在表格里逐行说**。它在哪里说，逐处列全（收口复评 G3：
 * 上一版这里写「只由整块那一处说」而**漏掉了六张卡**，同一提交的用例
 * 第 ② 句正面断言「六张卡带标记」、`fillCell()` 也确实挂）：
 * · 汇总侧 = **1 条红条**（`usage.note.partialMalformed`，`render()` 里由 `note` 驱动）
 *   **+ 六张汇总卡各一个「不完整」标记**（它们是整段区间的合计，说它不完整是准确的）；
 * · 下钻侧 = `buildDetail()` 里那一句单日口径的话。
 * **两张表格的行：一个都不挂。**
 *
 * ⚠️ `≈` 也只出一个，挂在表标题上（`approxTitleMark`，定向复评 N5）。
 */
function buildDayTable(state, marks) {
  const { wrap, body, head } = block("usage.table.title");
  const rows = dayRows(data);
  if (rows.length === 0) {
    // ⚠️ **「读不出来」与「这段区间里没有可以列出的日子」是两句话。**
    //    `read_failed` 那一档 `days` 是 null ⇒ 行数也是 0，照后一句渲染
    //    等于把一次读取失败说成「这段时间本来就没有日子」。
    // ⚠️⚠️ **判据是白名单，收在 `pure/usage.mjs` 的 `readSucceeded()` 里**
    //    （定向复评 N6）：上一版这里写的是黑名单
    //    `state === "unavailable" ? 不可用 : 空`，方向反的；而分解表那一边是白名单。
    //    同一件事两张表两个方向，本身就是下一次分叉的入口。
    body.appendChild(elI18n(
      "p", readSucceeded(state) ? "usage.table.empty" : "usage.table.unavailable",
      { class: "muted note" },
    ));
    return wrap;
  }
  // ⚠️ **`≈` 挂在早退之后**（收口复评 F1）：上面那条早退意味着这张表一个数字都没有，
  //    而 `≈` 是一句关于「下面那些数字」的话。挂在**标题节点**上（G2）。
  const mark = approxTitleMark(marks);
  if (mark !== null) head.appendChild(mark);
  const table = el("table");
  table.appendChild(headRow([
    "usage.table.date", "usage.table.requests", "usage.table.success", "usage.table.errors",
    "usage.table.tokens", "usage.table.streaming", "usage.table.latency", "usage.table.drill",
  ]));
  for (const row of rows) {
    const tr = el("tr");
    tr.appendChild(keyCell(row.date));
    numberCells(tr, state, row.total);
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

/**
 * 分解表的一张（小时 / 模型 / 协议共用）。
 *
 * ⚠️ **同样不收 `marks`**：与日表同一条理由（定向复评 N2 + N4）——
 * 我们不知道是哪一个小时 / 哪一个模型短了，就只能对整块说。
 * 上一版这里有一个 `marks` 形参，而它在这条端点上**结构性地永远是 `null`**
 *（`honestyMarks` 当时经 `summaryCards().complete`，而那条端点没有 `total`），
 * 于是它既是死参、又给人一种「已经接好了」的错觉。
 */
function breakdownTable(titleKey, keyLabelKey, map, numeric, state) {
  const wrap = el("div", { class: "usage-breakdown" });
  wrap.appendChild(elI18n("h4", titleKey));
  const rows = breakdownRows(map, numeric);
  if (rows.length === 0) {
    // 同上：**这一天读不出来**与**这一天没有记录**是两句话。C1 点名的「第三屏」。
    // 判据与日表共用同一个 `readSucceeded()`（定向复评 N6）。
    wrap.appendChild(elI18n(
      "p", readSucceeded(state) ? "usage.detail.empty" : "usage.detail.unavailable",
      { class: "muted note" },
    ));
    return wrap;
  }
  const table = el("table");
  table.appendChild(headRow([
    keyLabelKey, "usage.table.requests", "usage.table.success", "usage.table.errors",
    "usage.table.tokens", "usage.table.streaming", "usage.table.latency",
  ]));
  for (const row of rows) {
    const tr = el("tr");
    // ⚠️ **键来自客户端填的模型名，一律 textContent**（`el()` 走的就是它）。
    tr.appendChild(keyCell(row.key));
    numberCells(tr, state, row.total);
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

  // ⚠️ 这颗重试按钮重拉的是**这一天**，不是汇总（评审 M1）。
  const retryDay = () => { openDay(detailDate); };

  if (detailFailed) {
    const banner = el("div", { class: "banner-danger", role: "status" });
    banner.appendChild(elI18n("span", "common.loadFailed"));
    banner.appendChild(retryButton(retryDay));
    wrap.appendChild(banner);
    return wrap;
  }
  if (detailData === null) return wrap;

  const state = detailState(detailData);
  const note = typeof detailData.note === "string" ? detailData.note : null;
  const banner = buildNoteBanner(note, retryDay);
  if (banner !== null) wrap.appendChild(banner);
  // ⚠️ **这里刻意没有 `render()` 那一支的红色兜底横幅，理由不是「忘了对称」。**
  //    ① 三张分解表在 `unavailable` 下已经各自说了「这一天的分解读不出来」，
  //       兜底那句会是第四遍；
  //    ② 更要紧的是它会**说错话**：`date_out_of_retention` 那一档
  //       `hours` 是 null（⇒ `unavailable`）而 note 是 info 档，
  //       套上「读取失败，显示为 —」就是把「那天的记录已经过期了」
  //       说成「这次读挂了」——那是一次 retry 永远解决不了的事，
  //       而横幅上还挂着一颗重试按钮。**两句都不真，比只说一句更糟。**
  //    ⇒ 兜底放在表那一层（每张表自己说自己空的原因），不放在这一层。

  // 缺了几块这件事在这条端点上只有字段说得出来（它不发畸形 code）。
  const marks = honestyMarks(detailData);
  // ⚠️ **同 F1：这一天读不出来时三张表一个数字都没有，那时不许挂 `≈`。**
  //    `readSucceeded(state)` 与两张表决定「空表说哪一句」用的是同一个判据。
  const mark = readSucceeded(state) ? approxTitleMark(marks) : null;
  if (mark !== null) head.appendChild(mark);
  // ⚠️⚠️ **只在 `partial` 那一档说，`all` 不说**（定向复评 N7）：
  //    `all` 时整块是 `unavailable`、下面三张表**一个数字都没有**，
  //    而这句话的主语是「下面这些数字」——那是在描述一堆不存在的数字。
  //    `all` 那一档由 `note` 那条红条（「每一个都是畸形的……去查存储」）
  //    与三张表各自的「读不出来」承担。
  // ⚠️ **文案是单日口径的 `usage.detail.incomplete`，不是区间口径的
  //    `usage.incompleteTip`**：后者逐字写着「这段区间里」，而这里是一天。
  if (marks.incompleteOf !== null) {
    const warn = el("p", { class: "muted note usage-incomplete" });
    warn.textContent = t("usage.detail.incomplete", { malformed: fmtCount(marks.incompleteOf) });
    wrap.appendChild(warn);
  }

  wrap.appendChild(breakdownTable("usage.detail.hours", "usage.detail.hour", detailData.hours, true, state));
  wrap.appendChild(breakdownTable("usage.detail.models", "usage.detail.model", detailData.byModel, false, state));
  wrap.appendChild(breakdownTable("usage.detail.protocols", "usage.detail.protocol", detailData.byProtocol, false, state));
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
  const banner = buildNoteBanner(note, load);
  if (banner !== null) host.appendChild(banner);
  // ⚠️⚠️ **判据是「有没有人用 error 档说过『读不出来』」，不是「有没有横幅」**
  //（评审 M2）。上一版写的是 `banner === null`，于是 `range_clamped`（warn 档）
  // 配上 `days: null` 时：六张卡全是 EM DASH，而页面上只有一条温和的黄条
  // ——**没有任何一句说「读不出来」**。
  // ⚠️ 今天后端发不出这个组合，但本文件 `buildNoteBanner` 上方刚论证过
  //「不许假设 `note` 只可能是表内的值」；**同一条纪律在「字段组合」这一维上
  // 一样要落实**：面板不该假设后端只会发出今天见过的那些组合。
  if (state === "unavailable" && noteSeverity(note) !== "error") {
    const fail = el("div", { class: "banner-danger", role: "status" });
    fail.appendChild(elI18n("span", "common.loadFailed"));
    fail.appendChild(retryButton(load));
    host.appendChild(fail);
  }
  // 「这段时间真的是 0」要有自己的一句话。`note` 已经用 info 档说过同一件事时
  // 不再重复（③ `no_shards`），而第 ④ 种状态的 `note` 是 `null`、没人替它说。
  if (state === "empty" && (usageNoteKey(note) === null || noteSeverity(note) !== "info")) {
    const empty = el("div", { class: "banner-info", role: "status" });
    empty.appendChild(elI18n("span", "usage.empty"));
    host.appendChild(empty);
  }

  // ⚠️ **两个诚实标记算一次，卡片与日表共用同一份**（评审 C1 / I1）：
  //    各算各的迟早分叉，而分叉的那一边正好是「表」时，后果就是
  //    卡片说「不完整」而紧挨着的表把同一份数字写成完整的。
  const marks = honestyMarks(data);
  host.appendChild(buildCards(state, marks));

  // 未落盘的尾巴。判据是 `count`，**不是 `ms`**（见 `pendingTail` 的说明）。
  const tail = pendingTail(data);
  if (tail !== null) {
    const p = el("p", { class: tail.budgetExhausted ? "banner-warn" : "muted note" });
    p.textContent = tail.budgetExhausted
      ? t("usage.pendingExhausted", { count: fmtCount(tail.count) })
      : t("usage.pending", { count: fmtCount(tail.count) });
    host.appendChild(p);
  }

  host.appendChild(buildDayTable(state, marks));
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
    shown = true;
    loadStatic().then(() => { if (shown && nodes !== null) render(); });
    load();
  },

  onHide() {
    // **三件事都要做**：abort 省掉真实网络往返，两个世代号保证汇总与下钻
    // 回来的那份都被丢掉，`shown` 作废 `loadStatic()` 那条链（评审 M5）。
    if (abort) { abort.abort(); abort = null; }
    seq++;
    detailSeq++;
    shown = false;
  },
};
