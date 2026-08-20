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
 * 三条纪律：①一切来自接口的内容一律 textContent；②**取值决策一律不写在这里**，
 * 全在 `js/pure/keys.mjs`（只读部分）与 `js/pure/keys-write.mjs`（写操作）里，
 * 分别由 `tests/ui/keys.test.ts` 与 `tests/ui/keys-write.test.ts` 跑着
 * （admin-ui/README.md 硬规则 1）。这个文件只剩 DOM 拼装、事件绑定与网络调用；
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
  isDeletable, canClearCooldown, canUnevict, canClearStrikes, toggleDisableLabelKey,
  rowActionNeedsConfirm, bulkNeedsConfirm, selectAllIds, pruneSelection,
  bulkResultSummary, bulkResultKey, importLines, hasImportableContent,
  importResultCounts, noteToPatch,
} from "./pure/keys-write.mjs";

const PAGE_SIZE = 20;
/** 搜索防抖。每敲一个字符打一次接口的话，大池子下每次都要重投影 + 序列化整池。 */
const SEARCH_DEBOUNCE_MS = 250;
/** 备注框的字符上限，与 `src/http/admin/handlers/keys-write.ts` 的
 *  `MAX_NOTE_LENGTH` 保持一致——这里只是给 `<textarea>` 一个 `maxlength` 提示，
 *  真正的边界仍然由后端强制（超长会 400，前端不重复实现那条校验）。 */
const NOTE_MAX_LENGTH = 200;

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
    if (box.checked) { if (!selected.includes(v.id)) selected.push(v.id); } else {
      selected = selected.filter((id) => id !== v.id);
    }
    // 单行勾选只影响批量条的可见性与计数，不需要整表重渲（那会打断用户正在
    // 连续勾选的动作、也会丢掉刚点开的下拉/焦点）。
    syncBulkBar();
  });
  cell.appendChild(box);
  return cell;
}

/** 备注列。**恒 textContent**——note 是整份响应里唯一"运维自由输入、又被投影
 *  回面板"的字段，后端不转义，这一行就是那句话被执行的地方。 */
function noteCell(v) {
  const cell = el("td");
  const hasNote = typeof v.note === "string" && v.note.length > 0;
  cell.appendChild(el("span", null, hasNote ? v.note : fmtDash(null)));
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
function actionsCell(v) {
  const cell = el("td", { class: "row-actions" });

  const toggle = elI18n("button", toggleDisableLabelKey(v), { type: "button" });
  toggle.addEventListener("click", () => patchAction(v.id, { disabled: !v.disabled }));
  cell.appendChild(toggle);

  const clearCooldown = elI18n("button", "keys.action.clearCooldown", { type: "button" });
  clearCooldown.disabled = !canClearCooldown(v);
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
  tr.appendChild(actionsCell(v));
  return tr;
}

/** 表头的全选复选框。**只对当前页 `items` 生效**（`selectAllIds`），
 *  勾选/取消都要整表重渲——每一行的 `.checked` 得跟着 `selected` 重算一遍。 */
function headerSelectCell(items) {
  const th = el("th");
  const box = el("input", { type: "checkbox" });
  const pageIds = selectAllIds(items);
  box.checked = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  box.setAttribute("aria-label", t("keys.selectAll"));
  box.addEventListener("change", () => {
    if (box.checked) {
      const merged = new Set(selected);
      for (const id of pageIds) merged.add(id);
      selected = [...merged];
    } else {
      const drop = new Set(pageIds);
      selected = selected.filter((id) => !drop.has(id));
    }
    render();
  });
  th.appendChild(box);
  return th;
}

/** 批量条的可见性与「已选中 N 把」文案。挂在每次 render() 与每次单行勾选之后。 */
function syncBulkBar() {
  const n = selected.length;
  nodes.bulkBar.style.display = n > 0 ? "" : "none";
  nodes.bulkCount.textContent = t("keys.bulk.selectedCount", { count: n });
}

function render() {
  // **读失败一律当「没有数据」，且只判这一次**：三处各写一份 `loadError ? ... : data`
  // 的话，下一次改动很容易只改其中两处（评审 N4）。
  const shown = loadError ? null : data;
  syncCounts(shown);
  syncBulkBar();

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
  if (knobs.ttl !== null || knobs.touch !== null || knobs.edge !== null) return;
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

/** 写操作失败时给用户看的话。优先用后端 `error.message`（人话），
 *  拿不到就退回一句通用文案，绝不把裸的 `http_500` 这类内部码丢给运维。 */
function errorMessage(e) {
  return e && typeof e.message === "string" && e.message !== "" ? e.message : t("keys.writeFailed");
}

/** 单条 PATCH（停用/启用/清冷却/解除剔除/备注）的统一收尾：成功/失败都提示一次，
 *  并且不管成败都重新拉一次列表——写操作没有把最新视图带回来，只有 `{ok:true}`。 */
function patchAction(id, body) {
  api.patch(`/keys/${id}`, body)
    .then(() => toast(t("keys.actionOk"), "ok"))
    .catch((e) => toast(errorMessage(e), "err"))
    .finally(() => { load(); });
}

function editNote(view) {
  const textarea = el("textarea", { rows: "3", maxlength: String(NOTE_MAX_LENGTH) });
  textarea.value = view.note ?? "";
  const body = el("div");
  body.appendChild(textarea);
  openModal("keys.note.title", body, [
    { labelKey: "common.cancel" },
    {
      labelKey: "keys.note.save",
      onClick: () => {
        api.patch(`/keys/${view.id}`, { note: noteToPatch(textarea.value) })
          .then(() => toast(t("keys.actionOk"), "ok"))
          .catch((e) => toast(errorMessage(e), "err"))
          .finally(() => { load(); });
      },
    },
  ]);
}

/**
 * 单条删除。**不可撤销**，所以先弹一次确认（`rowActionNeedsConfirm` 判据）。
 *
 * ⚠️⚠️ **409 `must_disable_first` 与批量路径的 200 + 逐项 `reason` 是两种不同的
 * 形状**（见 `src/http/admin/handlers/keys-write.ts` 的 `keyDeleteHandler` 文件头）
 * ——这里从 `ApiError.status === 409` 与 `ApiError.body.reason` 两处取信息，
 * 给出一句比通用错误文案更准的提示；批量路径的对应处理在 `runBulk()`。
 */
function deleteOne(view) {
  if (!isDeletable(view)) return;
  const run = () => {
    api.del(`/keys/${view.id}`)
      .then(() => toast(t("keys.actionOk"), "ok"))
      .catch((e) => {
        if (e && e.status === 409 && e.body && e.body.reason === "must_disable_first") {
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
 * 只要它大于 0，`bulkResultKey()` 就必须选中 `keys.bulk.partial` 而不是
 * `keys.bulk.allOk`，且 `mustDisableFirst` 的具体数字要被拼进提示文案——
 * 拿 `res.status` 当唯一判据的写法在这条路径上永远走不到这一段。
 *
 * ⚠️⚠️ **`summary.failed > 0` 时这条 toast 是 `sticky`（控制端追加裁定）**：
 * 它藏在 HTTP 200 的响应体里，本来就是最容易被忽略的那类信息，4 秒自动消失
 * 等于把一条诚实信号做成了几乎看不见的信号。全部成功时仍是普通的 4 秒 toast
 * ——不需要留痕的信息没必要多一次点击。
 */
async function runBulk(op, ids) {
  try {
    const body = await api.post("/keys/bulk", { op, ids });
    const summary = bulkResultSummary(body && body.results);
    let text = t(bulkResultKey(summary)) + t("keys.bulk.countsSuffix", summary);
    if (summary.mustDisableFirst > 0) text += t("keys.bulk.mustDisableFirstSuffix", summary);
    if (summary.notFound > 0) text += t("keys.bulk.notFoundSuffix", summary);
    toast(text, summary.failed > 0 ? "warn" : "ok", summary.failed > 0 ? { sticky: true } : undefined);
  } catch (e) {
    toast(errorMessage(e), "err");
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
      onClick: () => {
        const lines = importLines(textarea.value);
        if (!hasImportableContent(lines)) { toast(t("keys.import.emptyErr"), "warn"); return; }
        api.post("/keys", { keys: lines, resetExisting: resetBox.checked })
          .then((res) => {
            const c = importResultCounts(res);
            let text = t("keys.import.result", {
              added: c.added, duplicated: c.duplicated, reset: c.reset, invalid: c.invalidLines.length,
            });
            if (c.invalidLines.length > 0) {
              text += t("keys.import.invalidLines", { lines: c.invalidLines.join(", ") });
            }
            toast(text, c.invalidLines.length > 0 ? "warn" : "ok");
          })
          .catch((e) => toast(errorMessage(e), "err"))
          .finally(() => { load(); });
      },
    },
  ]);
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

  const importBtn = elI18n("button", "keys.import.open", { type: "button" });
  importBtn.addEventListener("click", () => openImport());
  bar.appendChild(importBtn);

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
