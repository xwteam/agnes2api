/**
 * Key 池板块。P3b 只做了只读部分（状态筛选 → 4 张汇总卡 → 分页列表 → 新鲜度提示）；
 * **P3c Task 4 在此之上加写操作**：行内动作（停用/启用/清冷却/清连续失败/解除剔除/
 * 删除）、批量条（选中才出现）、导入弹窗。
 *
 * ⚠️ **「清连续失败」是控制端追加裁定补的**：设计 §10.2 的行内动作清单本来就有
 * 「清 strikes」，后端 `PATCH` 的 `clearStrikes` 字段 Task 3 也已经实现全，
 * 是本任务简报第一版的动作清单漏列了它。
 *
 * ⚠️ **P3d Task 9 又加了一颗「验活」**，它与上面那六颗**不是同一类东西**：
 * 那六颗都写存储，它一个字段都不写（`src/http/admin/handlers/verify.ts` 的
 * 约束 1）。它是这一行里唯一一个**按下去会真的打一次上游**的按钮，
 * 护栏在后端（`src/http/admin/probe-guard.ts`，与注册机的通道连通性测试共用
 * 同一份），前端这一侧只负责「一次一发」「结果就地显示」「切走时作废」。
 * **绝不做批量验活**——按 key 数量真打上游，与「立即补池」是同型的自毁按钮
 *（设计 §10.2），反向断言在
 * `tests/ui/dom/keys-verify.test.ts`「批量条里没有验活按钮 —— 批量验活按 key 数量真打上游，是自毁按钮（设计 §10.2）」。
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
 * 这一类事件处理器常规写法，不是一条业务判据。
 *
 * ⚠️⚠️ **这条"DOM 测试直接覆盖它"的说法被复评证伪过一次，订正如下**：原来那格
 * 用的是「批量删除」触发这个守卫，但 `bulkNeedsConfirm("delete")` 恒真，点击
 * 「批量删除」只会打开一个确认弹窗，那格测试从没点确认按钮，"没有发出请求"
 * 实际是**确认弹窗没被确认**挡住的，跟这条早退守卫毫无关系——把守卫整个删掉，
 * 只要点的是「批量删除」，那格照样绿。现在换成「批量清冷却」（`bulkNeedsConfirm`
 * 对它恒假，点击后没有中间弹窗）触发，唯一能拦住请求的就是这条早退，这才是真的
 * 在测它（`tests/ui/dom/keys-actions.test.ts` 的「批量条一把都没选中时点击批量
 * 清冷却：不发任何请求（真正覆盖 ids.length===0 早退）」，测试自身还带一条反向
 * 自检：确认弹窗确实没有被打开过）。
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
// 【自动注册】两项与注册机板块共用同一个确认弹窗与同一条发起路径，见下面
// buildAddKeyMenu() 里那段说明。**不是循环依赖**：sec-registrar.js 不 import 本文件。
import { confirmAndTend } from "./sec-registrar.js";
// 通道顺序的单一真源（字母序），与注册机板块两张卡用的是同一个常量。
import { CHANNELS } from "./pure/registrar.mjs";
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
  verifyDisabledReason, verifyDisabledTitleKey, verifyResultCode, verifyTransportCode,
  verifyResultLabelKey, VERIFY_MIN_INTERVAL_MS,
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

/**
 * 验活的行内状态，**按 key id 索引**（P3d Task 9）。
 * 每一项：`{ inFlight, lastAt, code, ctl, timer }`。
 *
 * ⚠️⚠️ **它必须活在 `render()` 之外，这不是风格问题。** `render()` 的第一句
 * 有效动作是 `host.textContent = ""` —— **每次都重建整张表**，而 `load()` → `render()`
 * 由自动刷新定时器、搜索防抖、每一次行内/批量操作触发。状态若挂在按钮上，
 * 「这一行在飞时按钮变灰」与「结果就地显示」**都会被任何一次并发 `load()` 抹掉**。
 * ⇒ `actionsCell()` 每次重建时都从这张表**重放**一遍。
 * 由 `tests/ui/dom/keys-verify.test.ts` 的
 * 「验活在飞时打断一次 load()：这一行的按钮仍然禁用、行内结果仍然在」那一格钉着。
 *
 * ⚠️ **不清理**：键只可能来自当前页真实存在过的 key id，条目数与运维手点过的
 * 行数同量级；逐条清理反而要另一个时间轮（与 `src/http/admin/probe-guard.ts`
 * 那张 Map 的理由同源）。
 */
const verifyState = new Map();

/** 取（必要时新建）某一把 key 的验活状态。 */
function verifyStateFor(id) {
  let s = verifyState.get(id);
  if (s === undefined) {
    s = { inFlight: false, lastAt: null, code: null, ctl: null, timer: null };
    verifyState.set(id, s);
  }
  return s;
}

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
 * 「验活」那一颗按钮 + 它的行内结果（P3d Task 9）。**整段每次 `render()` 重建，
 * 状态从 `verifyState` 重放**（见那张 Map 的说明）。
 *
 * ⚠️ **`disabled` 落在真的 `<button>` 上，不是落在包裹的 `<span>` / `<td>` 上。**
 * `tests/helpers/fake-dom.ts` 把 `.disabled` 挂在**每一个**元素实例上
 *（那份夹具的 `KNOWN_BLIND_SPOTS` 第三条如实登记了这一点），所以把它设在
 * 一个 `<span>` 上在全套 DOM 用例里照样绿、**在浏览器里毫无作用**。
 *
 * ⚠️ **时间取 `Date.now()`，不是 `actionsCell` 那个 `now` 参数。** 那个 `now` 是
 * `shown.generatedAt` —— **服务端**在上一次列表响应里给的时刻，它不随本地时间
 * 走动（自动刷新关着时能停在原地好几分钟）。冷却是一段**本地**流逝的时间，
 * 拿一个不动的时刻去减，按钮要么永远灰、要么永远亮。
 *
 * ⚠️ **结果元素只承载一个 i18n key，永远不承载响应体里的任何值**（全局约束 11(a)
 * 的前端半身）：`elI18n(tag, key)` 之后这段文本的全部来源就是五语言字典。
 * 想把 `latencyMs` / `status` 显示出来的话，得先想清楚它会不会顺带把别的东西
 * 也带出来——**别把请求或响应整份塞进 `title` 或任何调试出口**。
 * 由 `tests/ui/dom/keys-verify.test.ts` 的
 * 「验活之后这一行的文本与 title 里不出现响应体里的任何值」那一格钉着。
 */
function verifyControl(v) {
  const wrap = el("span", { class: "verify-wrap" });
  const s = verifyState.get(v && v.id);
  const reason = verifyDisabledReason(v, s, Date.now());

  const btn = elI18n("button", "keys.action.verify", { type: "button", class: "verify-btn" });
  btn.disabled = reason !== null;
  btn.setAttribute("title", t(verifyDisabledTitleKey(reason)));
  btn.addEventListener("click", () => { verifyOne(v); });
  wrap.appendChild(btn);

  if (s !== undefined && s.inFlight === true) {
    wrap.appendChild(elI18n("span", "keys.verify.running", { class: "muted verify-result" }));
  } else if (s !== undefined && typeof s.code === "string") {
    wrap.appendChild(elI18n("span", verifyResultLabelKey(s.code), { class: "verify-result" }));
    // 只读探针那句话与结果**一起**出现：运维恰恰是在看到「验活通过」的那一刻
    // 以为 strikes 已经被清掉了（订正 F8）。
    wrap.appendChild(elI18n("span", "keys.verify.readOnlyNote", { class: "muted note verify-note" }));
  }
  return wrap;
}

/**
 * 跑一次验活。**一次一发是按行算的，不是按板块算的**——后端护栏的粒度就是
 * `verify:<id>`（`src/http/admin/probe-guard.ts` 里写着为什么不用全局粒度：
 * 全局粒度下验 A 会把验 B 一起挡掉）。
 *
 * ⚠️⚠️ **验活用自己的 `AbortController`，绝不复用模块级那个 `abort`。**
 * 那一个是列表加载的取消闸，`load()` 每次都会先 `abort.abort()` 再重新赋值。
 * 复用它的话：发起一次验活会取消在飞的列表加载，而任何一次 `load()`
 *（自动刷新 / 搜索防抖 / 任何一次行内动作的收尾）都会把在飞的验活作废掉——
 * 后者尤其阴：结果永远回不来，按钮却已经从「在飞」变回可点。
 * 由 `tests/ui/dom/keys-verify.test.ts` 的
 * 「验活在飞时跑一次 load()：验活的结果照样落地 —— 两者各用各的取消闸」那一格钉着。
 *
 * ⚠️ **`signal.aborted` 那一判是唯一在测试里可观测的那道闸**：`tests/ui/dom/harness.ts`
 * 的 `fetch` 替身与 `tests/helpers/fake-dom.ts` **零处**看 `signal`，被 abort 的那条链
 * 在测试里照样会 resolve（真实浏览器里 abort 也是异步的，同一个竞态存在）。
 * 这与 `js/sec-usage.js` / `js/sec-models.js` 用世代号守同一件事是同一条判据，
 * 只是这里的「世代」就是这一次自己的那把 controller。
 *
 * ⚠️ **不调 `load()`**（订正 F8）。它是**只读探针**：后端写零个存储字段，
 * 前端这一侧也不许借着「顺手刷新一下」把这一行的 `strikes` / 分档徽章换掉——
 * 那会让运维以为是验活改的。由 `tests/ui/dom/keys-verify.test.ts` 的
 * 「验活成功后这一行的 strikes 与分档徽章一个字都没变」那一格钉着
 *（那一格让第二次列表响应给出不同的 strikes，所以补一句 `load()` 当场变红）。
 */
function verifyOne(view) {
  const id = view && typeof view.id === "string" ? view.id : "";
  // 点击时复查一次可用性：`render()` 之后到这一次点击之间状态可能已经变了
  //（同一条判据、同一个函数，不在这里另写一份比较）。
  // **拿现有状态查，查完再建**——否则一行点不动的 key（`no_key`）也会在那张表里
  // 凭空落一项，而那张表的有界性全靠「键只可能来自真实存在过的 key id」。
  if (verifyDisabledReason(view, verifyState.get(id), Date.now()) !== null) return;
  const s = verifyStateFor(id);

  const ctl = new AbortController();
  s.inFlight = true;
  s.ctl = ctl;
  s.lastAt = Date.now();
  s.code = null;
  render();

  api.post(`/keys/${id}/verify`, undefined, { signal: ctl.signal })
    .then((body) => { if (!ctl.signal.aborted) s.code = verifyResultCode(body); })
    .catch((e) => {
      if (ctl.signal.aborted) return;
      // 传输层与 200 响应体**严格分开**：护栏占用返回的 429 说的是「这次探测
      // 根本没发出去」，与上游在不在限流毫无关系（见 pure/keys-write.mjs）。
      s.code = verifyTransportCode(e);
    })
    .finally(() => {
      if (s.ctl === ctl) { s.ctl = null; s.inFlight = false; }
      // 冷却到点之后要有一次重渲，否则那颗按钮会一直显示成「刚探过」——
      // 自动刷新默认是关着的，没有别的东西会把它重画。
      if (s.timer !== null) clearTimeout(s.timer);
      s.timer = setTimeout(() => { s.timer = null; render(); }, VERIFY_MIN_INTERVAL_MS);
      render();
    });
}

/**
 * 行内动作列：验活、停用/启用、清冷却、清连续失败、解除剔除、备注、删除。
 *
 * ⚠️ **「验活」刻意排在最前面，不在设计 §10.2 那张清单的顺序里**：那张清单列的
 * 是六个**写**动作，而验活是这一行里唯一一个只读的探针（后端写零个存储字段）。
 * 把它混进写动作中间，运维会按位置把它当成又一个会改状态的按钮。
 *
 * **按钮可用性判据全部来自 `pure/keys-write.mjs`**，这里只把返回值接到
 * `.disabled` 上——`isDeletable` 尤其要紧：判据错一个字符，运维就会看到一颗
 * 永远点不动、或者永远点得动却总是 409 的删除按钮。
 */
function actionsCell(v, now) {
  const cell = el("td", { class: "row-actions" });

  cell.appendChild(verifyControl(v));

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
  // 验活冷却到点后的那一次重渲。切走板块之后没人要看这张表，留着只会在
  // 一个已经不可见的板块上多跑一次 render()。
  for (const s of verifyState.values()) {
    if (s.timer !== null) { clearTimeout(s.timer); s.timer = null; }
  }
}

/**
 * 作废所有在飞的验活。**与 `abort`（列表加载）是两条独立的闸**，`onHide()` 里
 * 两条都要放——少放哪一条，切回来时都会被上一次留下的东西盖住。
 *
 * `inFlight` 在这里一并归零：不归零的话那颗按钮会永远停在「上一次探测还在飞」，
 * 而那一次已经被作废、永远不会回来把它放开（`.finally()` 里的
 * `if (s.ctl === ctl)` 此时已经不成立）。
 */
function abortVerifies() {
  for (const s of verifyState.values()) {
    if (s.ctl !== null) { s.ctl.abort(); s.ctl = null; }
    s.inFlight = false;
  }
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
 *
 * ── P3c Task 6：【自动注册】那两项接上了 ────────────────────────────────────
 *
 * 两项各自触发一次**只用这条通道**的手动补池（`POST /admin/api/registrar/tend`
 * 的 `channel` 参数）。**共用注册机板块那一个确认弹窗**（`confirmAndTend()`），
 * 不在这里抄第二份——设计 §10.2 第 3 条护栏（确认弹窗必须明示消耗）抄两份的话，
 * 迟早只剩一份，而少的那一份正好是点击频率更高的这个入口。
 *
 * ⚠️ **两项一律可点，不按「这条通道配没配」去禁用其中一条。** 判「配没配」要先
 * 拉一次 `/registrar/status`，而那意味着每次打开 Key 池板块都多一次请求；更要紧的是
 * **一条灰掉、一条能点**在视觉上就是一次排名**，而它依赖的是一份可能已经过期的
 * 配置快照。没配好的那条由后端当场回 `409 channel_not_configured`，面板把那句话
 * 原样显示出来——**结构上完全平级，差别只出现在真的点下去之后，且那时说的是事实。**
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
  // ⚠️ **「点菜单外面收起它」这条本任务没有做，理由如实登记在这里。**
  // 它要求点击事件从被点的元素冒泡到 document，而 `tests/helpers/fake-dom.ts` 的
  // `dispatchEvent` **刻意不冒泡**（那份夹具的注释逐字写着「板块代码没有依赖冒泡
  // 的地方，实现它只会多一处猜测」）⇒ 任何写法在那套 DOM 用例里都**跑不到**，
  // 交付的就会是一段没有任何自动化覆盖的发货代码，而它的失效形态正是
  // `ui.js` 的 `focusableIn()` 那次真机事故的同一族（在夹具里看着对、真机上不对）。
  // 要做的话先让夹具支持冒泡，那与 Task 4 记下的「替身方案 B」是同一个量级的改动。
  // 今天关菜单有两条路：Escape，或者再点一次触发按钮。

  const autoGroup = el("div", { class: "dropdown-group" });
  autoGroup.appendChild(elI18n("div", "keys.addMenu.autoGroup", { class: "dropdown-group-label" }));
  // **两项完全平级**：同一个循环、同一套属性、同一条发起路径，唯一的差别是那个
  // 通道名字符串。顺序取自 `pure/registrar.mjs` 的 `CHANNELS`（字母序），
  // 与注册机板块两张通道卡的顺序是同一个真源——两处各写一份的话，同一个面板上
  // 会出现两种通道顺序，而任何顺序都会被读成排名。
  for (const channel of CHANNELS) {
    const key = channel === "yyds" ? "keys.addMenu.autoYyds" : "keys.addMenu.autoMoemail";
    const btn = elI18n("button", key, { type: "button" });
    btn.setAttribute("data-channel", channel);
    btn.addEventListener("click", () => { closeMenu(); confirmAndTend(channel); });
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
    // 验活那一族有自己的取消闸，见 `abortVerifies()`。
    abortVerifies();
  },
};
