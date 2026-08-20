/**
 * Key 池板块。P3b 只做了只读部分（状态筛选 → 4 张汇总卡 → 分页列表 → 新鲜度提示）；
 * **P3c Task 4 在此之上加写操作**：行内动作（停用/启用/清冷却/清连续失败/解除剔除/
 * 删除）、批量条（选中才出现）、导入弹窗。
 *
 * ⚠️ **「清连续失败」是控制端追加裁定补的**：设计 §10.2 的行内动作清单本来就有
 * 「清 strikes」，后端 `PATCH` 的 `clearStrikes` 字段 Task 3 也已经实现全，
 * 是本任务简报第一版的动作清单漏列了它。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * 三条纪律：①一切来自接口的内容一律 textContent；②**取值决策原则上不写在这里**，
 * 绝大多数在 `js/pure/keys.mjs`（只读部分）与 `js/pure/keys-write.mjs`（写操作）里，
 * 分别由 `tests/ui/keys.test.ts` 与 `tests/ui/keys-write.test.ts` 跑着
 * （admin-ui/README.md 硬规则 1）。
 *
 * ⚠️⚠️ **「一律不写在这里」这句话被评审证伪过两轮，别再说"一律"**：早先的版本
 * 与本文件的一个更早草稿都这么写，而下面这些判据当时确实住在这个文件里，
 * 逐条搬进了 `pure/keys-write.mjs`（本文件现在只调用）：
 *   · `headerSelectAllChecked` / `bulkBarVisible` / `isMustDisableFirstConflict` /
 *     `isOpaqueErrorMessage` / `NOTE_MAX_LENGTH`（第一轮）；
 *   · `toggleSelection`（单行勾选的去重加入/过滤移除）/ `applySelectAll`
 *     （全选/取消全选的并集/差集）/ `hasNote`（备注格显示内容还是显示 —）/
 *     `knobsLoaded`（三个旋钮"只拉一次"的判据）/ `bulkResultPresentation`
 *     （批量结果 toast 拼哪些 key、`kind`、`sticky`）/ `importResultPresentation`
 *     （导入结果 toast 的插值参数、要不要拼"不合法的行"、`kind`）（第二轮）。
 *
 * **仍然留在这里、且被判定为可接受的唯一一处**（同类先例：`state.page > 1`
 * 这条翻页守卫从 P3b 起一直就在板块文件里，从未被要求搬走）：
 * `runBulkWithConfirm` 的 `ids.length === 0` 早退——这是"点击时校验参数非空"
 * 这一类事件处理器常规写法，不是一条业务判据，DOM 测试直接覆盖它
 * （`tests/ui/dom/keys-actions.test.ts` 的「批量条一把都没选中时点击批量按钮：
 * 不发任何请求」）。
 *
 * 这条纪律的诚实版本是**"取值决策原则上不写在这里，例外必须在这里说清楚是哪些、
 * 为什么留下"**，不是一句无条件的"一律"。
 *
 * ③ **`note` 是第一个「运维自由输入、又会被投影进面板」的字段**（见
 * `src/core/admin/key-view.ts` 的 `KeyView.note` 说明）——后端不转义，
 * 这里必须用 `textContent` 渲染，绝不能拼进 `innerHTML`。本文件全程只用
 * `el()` / `elI18n()`（两者内部都是 `textContent`），没有任何 `innerHTML`。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n, toast, openModal, confirmModal } from "./ui.js";
import { fmtCount, fmtDash, fmtDuration, fmtInstant, fmtPercent } from "./pure/format.mjs";
import {
  CARDS, AUTO_SECONDS, cardCounts, badgeClass, bucketLabelKey, autoLabelKey,
  keysQuery, cooldownRemaining, lastErrorParts, usageParts, lastUsedParts,
  pagerState, listMessageKey, itemsOf,
} from "./pure/keys.mjs";
// `poolKnobs()` / `offsetMs()` 两个板块共用，见 pure/overview.mjs 各自的说明
// （硬规则 1：两个板块的取值决策不许各写一份）。
import { poolKnobs, offsetMs } from "./pure/overview.mjs";
import {
  isDeletable, isMustDisableFirstConflict, canClearCooldown, canUnevict, canClearStrikes,
  toggleDisableLabelKey, rowActionNeedsConfirm, bulkNeedsConfirm,
  selectAllIds, pruneSelection, headerSelectAllChecked, bulkBarVisible,
  toggleSelection, applySelectAll, knobsLoaded, hasNote,
  bulkResultSummary, bulkResultPresentation, importLines, hasImportableContent,
  importResultCounts, importResultPresentation, noteToPatch, NOTE_MAX_LENGTH, isOpaqueErrorMessage,
} from "./pure/keys-write.mjs";

const PAGE_SIZE = 20;
/** 搜索防抖。每敲一个字符打一次接口的话，大池子下每次都要重投影 + 序列化整池。 */
const SEARCH_DEBOUNCE_MS = 250;

const state = { bucket: "all", q: "", page: 1, size: PAGE_SIZE, autoSec: 0 };
/** 批量条：当前页里被勾选的 id。换页 / 换筛选 / 重新拉取之后由 `pruneSelection()`
 *  收窄——不在当前页 `items` 里的 id 一律丢弃，理由见 pure/keys-write.mjs。 */
let selected = [];

let nodes = null;
let timer = null;
let searchTimer = null;
/** 在飞请求的取消闸。离开板块 / 发起下一次请求时作废上一次，避免旧响应盖掉新数据。 */
let abort = null;
let data = null;
let loadError = false;
/**
 * `POOL_CACHE_TTL_MS` / `POOL_TOUCH_INTERVAL_MS` / `kvEdgeCacheMs` 的当前生效值。
 * **只拉一次**——前两个是建 app 时读一次的部署期常量（见 wire.ts），不随
 * `ConfigHolder` 刷新，没必要跟着每次 `load()` / 自动刷新重新去问；`kvEdgeCacheMs`
 * 同样是常量。默认 null（渲染成 —），拿到之前不假装知道旧的硬编码默认值。
 */
let knobs = { ttl: null, touch: null, edge: null };

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
  return el("span", { class: "approx", title: t("keys.approxTip", { touch: fmtDuration(knobs.touch) }) }, "≈");
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
    cell.appendChild(el("span", {
      class: "approx", title: t("keys.approxLastUsedTip", { touch: fmtDuration(knobs.touch) }),
    }, "≈"));
    cell.appendChild(el("span", null, ` ${fmtInstant(l.at, offset)}`));
  } else {
    cell.appendChild(el("span", null, l.at === null ? fmtDash(null) : fmtInstant(l.at, offset)));
  }
  return cell;
}

/** 选择框列。每次 render() 整表重建，`.checked` 直接从 `selected` 现算，
 *  不需要另外维护一份 DOM 引用表。 */
function selectCell(v) {
  const cell = el("td");
  const box = el("input", { type: "checkbox" });
  box.checked = selected.includes(v.id);
  box.setAttribute("aria-label", t("keys.selectRow"));
  box.addEventListener("change", () => {
    selected = toggleSelection(selected, v.id, box.checked);
    // 单行勾选只影响批量条的可见性与计数、以及表头全选框要不要跟着打勾，
    // 不需要整表重渲（那会打断用户正在连续勾选的动作、也会丢掉刚点开的下拉/焦点）。
    syncBulkBar();
    syncHeaderCheckbox();
  });
  cell.appendChild(box);
  return cell;
}

/** 备注列。**恒 textContent**——note 是整份响应里唯一"运维自由输入、又被投影
 *  回面板"的字段，后端不转义，这一行就是那句话被执行的地方。 */
function noteCell(v) {
  const cell = el("td");
  cell.appendChild(el("span", null, hasNote(v) ? v.note : fmtDash(null)));
  return cell;
}

/**
 * 行内动作列：停用/启用、清冷却、清连续失败、解除剔除、备注、删除
 * （顺序与设计文档 §10.2 的行内动作清单一致）。
 *
 * **按钮可用性判据全部来自 `pure/keys-write.mjs`**，这里只把返回值接到
 * `.disabled` 上——`isDeletable` 尤其要紧：判据错一个字符，运维就会看到一颗
 * 永远点不动、或者永远点得动却总是 409 的删除按钮。
 */
function actionsCell(v, now) {
  const cell = el("td", { class: "row-actions" });

  const toggle = elI18n("button", toggleDisableLabelKey(v), { type: "button" });
  toggle.addEventListener("click", () => patchAction(v.id, { disabled: !v.disabled }));
  cell.appendChild(toggle);

  const clearCooldown = elI18n("button", "keys.action.clearCooldown", { type: "button" });
  clearCooldown.disabled = !canClearCooldown(v, now);
  clearCooldown.addEventListener("click", () => patchAction(v.id, { clearCooldown: true }));
  cell.appendChild(clearCooldown);

  const clearStrikes = elI18n("button", "keys.action.clearStrikes", { type: "button" });
  clearStrikes.disabled = !canClearStrikes(v);
  clearStrikes.addEventListener("click", () => clearStrikesAction(v));
  cell.appendChild(clearStrikes);

  const unevict = elI18n("button", "keys.action.unevict", { type: "button" });
  unevict.disabled = !canUnevict(v);
  unevict.addEventListener("click", () => patchAction(v.id, { unevict: true }));
  cell.appendChild(unevict);

  const noteBtn = elI18n("button", "keys.action.note", { type: "button" });
  noteBtn.addEventListener("click", () => editNote(v));
  cell.appendChild(noteBtn);

  const del = elI18n("button", "keys.action.delete", { type: "button", class: "danger" });
  del.disabled = !isDeletable(v);
  del.addEventListener("click", () => deleteOne(v));
  cell.appendChild(del);

  return cell;
}

function row(v, now, offset, approximate) {
  // `data-key-id` 不是渲染需要的东西——它只给测试当挂钩用，好在整表重建之后仍能
  // 按 id 而不是按行序号找到某一行（`tests/ui/dom/keys-actions.test.ts` 用它)。
  const tr = el("tr", { "data-key-id": v.id });
  tr.appendChild(selectCell(v));
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
  tr.appendChild(noteCell(v));
  tr.appendChild(actionsCell(v, now));
  return tr;
}

/** 当前页的 id 列表。`render()` 每次重算，`selectCell` 的单行勾选处理器靠它
 *  同步表头全选框（那时手上只有一个 `v`，够不到 `items`）。 */
let currentPageIds = [];

/** 表头的全选复选框。**只对当前页 `items` 生效**（`selectAllIds`），
 *  勾选/取消都要整表重渲——每一行的 `.checked` 得跟着 `selected` 重算一遍。
 *  同时把这颗复选框记进 `nodes.selectAllBox`，好让单行勾选也能同步它
 *  （见 `syncHeaderCheckbox`）。 */
function headerSelectCell(items) {
  const th = el("th");
  const box = el("input", { type: "checkbox" });
  const pageIds = selectAllIds(items);
  box.checked = headerSelectAllChecked(pageIds, selected);
  box.setAttribute("aria-label", t("keys.selectAll"));
  box.addEventListener("change", () => {
    selected = applySelectAll(selected, pageIds, box.checked);
    render();
  });
  th.appendChild(box);
  if (nodes) nodes.selectAllBox = box;
  return th;
}

/** 批量条的可见性与「已选中 N 把」文案。挂在每次 render() 与每次单行勾选之后。 */
function syncBulkBar() {
  const n = selected.length;
  nodes.bulkBar.style.display = bulkBarVisible(n) ? "" : "none";
  nodes.bulkCount.textContent = t("keys.bulk.selectedCount", { count: n });
}

/**
 * 表头「全选本页」复选框要不要跟着打勾。**单行勾选之后必须同步它**——不然
 * 运维手动把当前页的每一行都勾完，表头那颗复选框还显示着"未全选"，看起来
 * 像是漏了一行没勾上（评审可改项）。
 */
function syncHeaderCheckbox() {
  if (nodes && nodes.selectAllBox) {
    nodes.selectAllBox.checked = headerSelectAllChecked(currentPageIds, selected);
  }
}

function render() {
  // **读失败一律当「没有数据」，且只判这一次**：三处各写一份 `loadError ? ... : data`
  // 的话，下一次改动很容易只改其中两处（评审 N4）。
  const shown = loadError ? null : data;
  syncCounts(shown);
  syncBulkBar();
  // 先归零，读失败 / 空列表时表头全选框不该记着上一次页面的 id 集合。
  currentPageIds = [];

  // 两个旋钮的当前生效值可能比首次 render() 晚到（异步拉 /overview），
  // 每次 render() 都用 `knobs` 现有的值重写这两句——拿到之后立刻生效，没拿到时
  // fmtDuration(null) 给出 —，不假装知道旧的硬编码默认值。
  nodes.autoNote.textContent = t("keys.autoNote", { ttl: fmtDuration(knobs.ttl) });
  nodes.freshnessNote.textContent = t("keys.freshness", {
    poolTtl: fmtDuration(knobs.ttl), edge: fmtDuration(knobs.edge),
  });

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
  currentPageIds = selectAllIds(items);

  const table = el("table");
  const head = el("tr");
  head.appendChild(headerSelectCell(items));
  for (const key of [
    "keys.col.seq", "keys.col.key", "keys.col.bucket", "keys.col.addedAt", "keys.col.lastUsedAt",
    "keys.col.cooldown", "keys.col.strikes", "keys.col.usage", "keys.col.lastError",
  ]) head.appendChild(elI18n("th", key));
  head.appendChild(elI18n("th", "keys.col.note"));
  head.appendChild(elI18n("th", "keys.col.actions"));
  table.appendChild(head);
  // 时区必须从参数进 fmtInstant，不许它去读运行环境的本地时区（见 pure/format.mjs）。
  const offset = offsetMs();
  for (const v of items) table.appendChild(row(v, shown.generatedAt, offset, shown.approximate));
  host.appendChild(table);
}

/**
 * 拉一次 `/overview` 取三个旋钮的当前生效值。**只拉一次**（见 `knobs` 的说明），
 * 拿到之后重渲一次让文案立刻换上真实值；拿不到就保持 —，不重试到下一次 onShow。
 */
async function loadKnobs() {
  if (knobsLoaded(knobs)) return;
  try {
    const body = await api.get("/overview");
    knobs = poolKnobs(body);
  } catch (e) {
    // 读失败：knobs 保持默认的三个 null，文案渲染成 —。
  }
  render();
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
  // 换页 / 换筛选 / 写操作之后重新拉取，都可能让已选中的某些 id 从当前页消失
  // ——批量条上的「已选 N 把」不许继续数着几把已经看不见的行。
  selected = pruneSelection(selected, loadError ? null : itemsOf(data));
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

/**
 * 写操作失败时给用户看的话。优先用后端 `error.message`（人话），拿不到、
 * 或者它是 `isOpaqueErrorMessage()` 判出来的内部码时退回一句通用文案。
 *
 * ⚠️ 这句原来写着"绝不把裸的 http_500 这类内部码丢给运维"，而当时的判据只看
 * "是不是非空字符串"——那句话是假的（评审探针实测：500 无 message、401、
 * 备注超长的中文 message 三种都会原样进 toast）。现在判据搬进了
 * `pure/keys-write.mjs` 的 `isOpaqueErrorMessage()`，这里只调用它；那个函数的
 * 说明里也如实登记了"后端中文校验 message 直投非中文面板"这个仍未关掉的破口。
 */
function errorMessage(e) {
  const raw = e && typeof e.message === "string" ? e.message : "";
  return isOpaqueErrorMessage(raw) ? t("keys.writeFailed") : raw;
}

/** 单条 PATCH（停用/启用/清冷却/解除剔除/备注）的统一收尾：成功/失败都提示一次，
 *  并且不管成败都重新拉一次列表——写操作没有把最新视图带回来，只有 `{ok:true}`。 */
function patchAction(id, body) {
  api.patch(`/keys/${id}`, body)
    .then(() => toast(t("keys.actionOk"), "ok"))
    .catch((e) => toast(errorMessage(e), "err"))
    .finally(() => { load(); });
}

/**
 * 备注编辑。**`keepOpen: true`**——保存失败（网络 / 后端校验，例如超长）时
 * 不关弹窗，运维刚打的字还在文本框里，不用重新点开再打一遍。只有真的存成功
 * 才调用 `close()`。
 */
function editNote(view) {
  const textarea = el("textarea", { rows: "3", maxlength: String(NOTE_MAX_LENGTH) });
  textarea.value = view.note ?? "";
  const body = el("div");
  body.appendChild(textarea);
  openModal("keys.note.title", body, [
    { labelKey: "common.cancel" },
    {
      labelKey: "keys.note.save",
      keepOpen: true,
      onClick: (close) => {
        api.patch(`/keys/${view.id}`, { note: noteToPatch(textarea.value) })
          .then(() => { toast(t("keys.actionOk"), "ok"); close(); load(); })
          .catch((e) => toast(errorMessage(e), "err"));
      },
    },
  ]);
}

/**
 * 单条删除。**不可撤销**，所以先弹一次确认（`rowActionNeedsConfirm` 判据）。
 *
 * ⚠️⚠️ **409 `must_disable_first` 与批量路径的 200 + 逐项 `reason` 是两种不同的
 * 形状**（见 `src/http/admin/handlers/keys-write.ts` 的 `keyDeleteHandler` 文件头）
 * ——这里从 `ApiError.status` 与 `ApiError.body.reason` 两处取信息，交给
 * `isMustDisableFirstConflict()` 判，给出一句比通用错误文案更准的提示；
 * 批量路径的对应处理在 `runBulk()`。
 */
function deleteOne(view) {
  if (!isDeletable(view)) return;
  const run = () => {
    api.del(`/keys/${view.id}`)
      .then(() => toast(t("keys.actionOk"), "ok"))
      .catch((e) => {
        if (e && isMustDisableFirstConflict(e.status, e.body && e.body.reason)) {
          toast(t("keys.mustDisableFirst"), "warn");
        } else {
          toast(errorMessage(e), "err");
        }
      })
      .finally(() => { load(); });
  };
  if (rowActionNeedsConfirm("delete")) confirmModal("keys.deleteConfirmTitle", "keys.deleteConfirmMsg", run);
  else run();
}

/**
 * 「清连续失败」。**先弹一次确认**，但理由与删除那颗不一样——不是「不可撤销」
 * （strikes 后续失败还会重新累积），是「容易与『清冷却』混淆」（`rowActionNeedsConfirm`
 * 的说明）：清冷却只让这把 key 现在能用，离下一次被剔除仍只差一次失败；这颗才
 * 是真的清账。确认文案（`keys.clearStrikesConfirmMsg`）必须把这句话点名说出来。
 */
function clearStrikesAction(view) {
  if (!canClearStrikes(view)) return;
  const run = () => patchAction(view.id, { clearStrikes: true });
  if (rowActionNeedsConfirm("clearStrikes")) {
    confirmModal("keys.clearStrikesConfirmTitle", "keys.clearStrikesConfirmMsg", run);
  } else {
    run();
  }
}

/**
 * 批量操作的落地。
 *
 * ⚠️⚠️ **这是 2(a) 那条交接落地的地方**：`bulk` 端点永远 200，「必须先停用才能删」
 * 只活在 `results[i].reason` 里。`bulkResultSummary()` 把它算成 `failed` 这个数，
 * `bulkResultPresentation()` 把它再投影成"拼哪些 key、`kind`、`sticky`"——
 * 只要 `failed` 大于 0，headline 就必须选中 `keys.bulk.partial` 而不是
 * `keys.bulk.allOk`，且 `mustDisableFirst` 的具体数字要被拼进提示文案——
 * 拿 `res.status` 当唯一判据的写法在这条路径上永远走不到这一段。
 *
 * ⚠️⚠️ **`summary.failed > 0` 时这条 toast 是 `sticky`（控制端追加裁定）**：
 * 它藏在 HTTP 200 的响应体里，本来就是最容易被忽略的那类信息，4 秒自动消失
 * 等于把一条诚实信号做成了几乎看不见的信号。全部成功时仍是普通的 4 秒 toast
 * ——不需要留痕的信息没必要多一次点击。
 *
 * ⚠️ **`catch` 分支（整批请求都没打成，例如网络中断 / 500）同样 `sticky`**
 * ——它与"200 但一部分被拒"是同一类"不看见就会误判"的信息，评审指出第一版
 * 漏了这一半：只有响应体里带 `results` 的那种失败被认真对待，请求本身失败
 * 时反而退回普通的 4 秒 toast，两种"失败"里更严重的那种被更轻地对待了。
 */
async function runBulk(op, ids) {
  try {
    const body = await api.post("/keys/bulk", { op, ids });
    const summary = bulkResultSummary(body && body.results);
    const presentation = bulkResultPresentation(summary);
    const text = presentation.messageKeys.map((key) => t(key, summary)).join("");
    toast(text, presentation.kind, presentation.sticky ? { sticky: true } : undefined);
  } catch (e) {
    toast(errorMessage(e), "err", { sticky: true });
  } finally {
    selected = [];
    load();
  }
}

function runBulkWithConfirm(op) {
  const ids = [...selected];
  if (ids.length === 0) return;
  if (!bulkNeedsConfirm(op)) { runBulk(op, ids); return; }
  const msg = el("p", null, t("keys.bulk.confirmDelete", { count: ids.length }));
  openModal("keys.bulk.confirmTitle", msg, [
    { labelKey: "common.cancel" },
    { labelKey: "common.confirm", danger: true, onClick: () => runBulk(op, ids) },
  ]);
}

function buildBulkBar() {
  const bar = el("div", { class: "toolbar bulk-bar" });
  const count = el("span", { class: "muted" });
  bar.appendChild(count);

  const disableBtn = elI18n("button", "keys.bulk.disable", { type: "button" });
  disableBtn.addEventListener("click", () => runBulkWithConfirm("disable"));
  bar.appendChild(disableBtn);

  const clearCooldownBtn = elI18n("button", "keys.bulk.clearCooldown", { type: "button" });
  clearCooldownBtn.addEventListener("click", () => runBulkWithConfirm("clearCooldown"));
  bar.appendChild(clearCooldownBtn);

  const deleteBtn = elI18n("button", "keys.bulk.delete", { type: "button", class: "danger" });
  deleteBtn.addEventListener("click", () => runBulkWithConfirm("delete"));
  bar.appendChild(deleteBtn);

  // 默认藏起来：批量条「选中才出现」（设计文档 §10.2），`syncBulkBar()` 之后接管。
  bar.style.display = "none";
  return { bar, count };
}

/**
 * 导入弹窗。**textarea 的内容原样按行发给后端**（`importLines()`），不在这里
 * trim 整段、也不过滤空行——过滤空行会让后端报回来的行号（1 基、按原始下标算）
 * 与运维在文本框里数到的行号错位，见 `src/core/keypool-repo.ts` 的 `addMany()`。
 *
 * ⚠️⚠️ **`keepOpen: true`，评审抓到的一个真缺陷**：`openModal` 原来的 `onClick`
 * 无条件先关弹窗再跑回调，于是校验失败（空提交）或网络/后端失败时，弹窗已经
 * 关掉、粘进去的最多 200 行原文全部丢失，运维只看到一句 toast、没有机会照着
 * 报错改正再重试。现在只有**真的拿到成功响应**才调用 `close()`；校验失败与
 * 请求失败都让弹窗留在原地，文本框里的内容原封不动。
 */
function openImport() {
  const textarea = el("textarea", { rows: "8", "data-i18n-ph": "keys.import.placeholder" });
  textarea.setAttribute("placeholder", t("keys.import.placeholder"));

  const resetLabel = el("label", { class: "auto" });
  const resetBox = el("input", { type: "checkbox" });
  resetLabel.appendChild(resetBox);
  resetLabel.appendChild(elI18n("span", "keys.import.resetExisting"));

  const body = el("div");
  body.appendChild(textarea);
  body.appendChild(resetLabel);
  body.appendChild(elI18n("p", "keys.import.resetExistingWarn", { class: "muted note" }));

  openModal("keys.import.title", body, [
    { labelKey: "common.cancel" },
    {
      labelKey: "keys.import.submit",
      keepOpen: true,
      onClick: (close) => {
        const lines = importLines(textarea.value);
        if (!hasImportableContent(lines)) { toast(t("keys.import.emptyErr"), "warn"); return; }
        api.post("/keys", { keys: lines, resetExisting: resetBox.checked })
          .then((res) => {
            const c = importResultCounts(res);
            const presentation = importResultPresentation(c);
            let text = t("keys.import.result", presentation.resultParams);
            if (presentation.showInvalidSuffix) {
              text += t("keys.import.invalidLines", { lines: c.invalidLines.join(", ") });
            }
            toast(text, presentation.kind);
            close();
            load();
          })
          .catch((e) => toast(errorMessage(e), "err"));
      },
    },
  ]);
}

/**
 * 「添加 Key」分组下拉。**设计文档 §10.2 定死的结构，控制端裁定现在就建**：
 * 【自动注册】（MoeMail / YYDS 两条通道，§10.3 要求"完全平级"）与【手动】
 * （粘贴单个 / 批量导入）。**本任务只填【手动】那两项的内容**——它们复用同一个
 * `openImport()`（后端只有一个 `POST /admin/api/keys`，接受 1..200 把，"单个"
 * 与"批量"在这条端点上没有分叉，硬造两个入口只会多一份要维护的弹窗）；
 * 【自动注册】那两项**先占位、禁用、挂一句说明性 tooltip**，留给 Task 6 接线
 * 到注册机端点。**容器与两组平级的结构现在定死，Task 6 只需要把这两颗按钮的
 * `disabled` 摘掉、接上真实的 onClick**，不必回头重构这个工具栏——那正是
 * 「现在不建容器，Task 5/6 就要拿掉一颗按钮重新长出一个菜单」这条风险的解法。
 *
 * ⚠️ **"批量导入（多行 / JSON 数组）"这句设计原文没有照抄**：本仓的导入框
 * 只按行拆（`importLines()`），不解析 JSON 数组——照抄那句话等于承诺一个
 * 没有实现的能力，一个把 `["sk-a","sk-b"]` 粘进去的运维会得到一条"不合法的
 * key"而不是两把导入成功的 key。菜单文案改成如实描述现在的行为
 * （`keys.addMenu.bulkImport`：「批量导入（每行一把）」）。
 */
function buildAddKeyMenu() {
  const wrap = el("div", { class: "dropdown" });
  const trigger = elI18n("button", "keys.addMenu.open", {
    type: "button", "aria-haspopup": "true", "aria-expanded": "false",
  });
  const menu = el("div", { class: "dropdown-menu" });
  menu.style.display = "none";

  const closeMenu = () => { menu.style.display = "none"; trigger.setAttribute("aria-expanded", "false"); };
  const openMenu = () => { menu.style.display = ""; trigger.setAttribute("aria-expanded", "true"); };
  trigger.addEventListener("click", () => {
    if (menu.style.display === "none") openMenu(); else closeMenu();
  });
  // Escape 关菜单，不吞给页面上别的 Escape 监听器（比如同时开着的弹窗——
  // 两者不会同时存在，菜单打开时不会有弹窗，弹窗打开时菜单早就该被这次点击关掉了）。
  wrap.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeMenu(); });

  const autoGroup = el("div", { class: "dropdown-group" });
  autoGroup.appendChild(elI18n("div", "keys.addMenu.autoGroup", { class: "dropdown-group-label" }));
  for (const key of ["keys.addMenu.autoMoemail", "keys.addMenu.autoYyds"]) {
    const btn = elI18n("button", key, { type: "button" });
    // `.disabled` 是属性赋值，不是 el() 的 attrs——与本文件其余按钮
    // （`clearCooldown.disabled = ...` 那些）同一个写法，别改成 `disabled: true`
    // 塞进 attrs：那只会落成 HTML 属性 `disabled=""`，不会同步 `.disabled` 属性。
    btn.disabled = true;
    btn.title = t("keys.addMenu.autoPlaceholder");
    btn.setAttribute("aria-label", `${t(key)}：${t("keys.addMenu.autoPlaceholder")}`);
    autoGroup.appendChild(btn);
  }
  menu.appendChild(autoGroup);

  const manualGroup = el("div", { class: "dropdown-group" });
  manualGroup.appendChild(elI18n("div", "keys.addMenu.manualGroup", { class: "dropdown-group-label" }));
  for (const key of ["keys.addMenu.pasteSingle", "keys.addMenu.bulkImport"]) {
    const btn = elI18n("button", key, { type: "button" });
    btn.addEventListener("click", () => { closeMenu(); openImport(); });
    manualGroup.appendChild(btn);
  }
  menu.appendChild(manualGroup);

  wrap.appendChild(trigger);
  wrap.appendChild(menu);
  return wrap;
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

  bar.appendChild(buildAddKeyMenu());

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
    // 文案含 `{ttl}` 占位符，不用 elI18n（那是给静态、无插值文案用的）——
    // 由 render() 每次用当前的 `knobs.ttl` 重写 textContent。
    const autoNote = el("p", { class: "muted note" });
    section.appendChild(autoNote);

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

    // 批量条：设计文档 §10.2 排在「4 张汇总卡」与「分页列表」之间，「选中才出现」。
    const bulk = buildBulkBar();
    section.appendChild(bulk.bar);

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
    // 同样含插值占位符，理由同上面的 autoNote。
    const freshnessNote = el("p", { class: "muted note" });
    section.appendChild(freshnessNote);

    nodes = {
      body, pageInfo, prev, next,
      options: tb.options, autoOptions: tb.autoOptions,
      cardValues, cardLabels, autoNote, freshnessNote,
      bulkBar: bulk.bar, bulkCount: bulk.count,
    };
  },

  onShow() {
    load();
    loadKnobs();
    restartTimer();
  },

  onHide() {
    stopTimers();
    // **作废在飞请求**：不作废的话切回来时旧响应可能盖掉新数据（板块契约 §9.3）。
    if (abort) { abort.abort(); abort = null; }
  },
};
