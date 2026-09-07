/**
 * 「API 密钥」板块：**我们签发给下游的那一族凭据**的签发 / 命名 / 到期 / 停用 / 吊销。
 *
 * ⚠️⚠️ **它与「Key 池」板块方向相反，别读混。** 那一族是**我们持有的**上游凭据
 *（拿去向 Agnes 证明身份，端点 `/admin/api/keys`）；这一族是**别人拿来向我们证明
 * 身份**的（端点 `/admin/api/apikeys`）。两个名字很像是已知代价，缓解手段是文案
 *（每张卡头一句）与文档，不是去改已经发布过的那条路径。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 `js/app.js` 的
 * `showSection`。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * ── 三条纪律（与其余八个板块相同）────────────────────────────────────────────
 * ① 一切来自接口的内容一律 `textContent`（`el()` 走的就是它）。**本板块尤其要紧**：
 *    密钥的名称是运维自由输入、又会被投影到屏幕上的字段，与 `KeyView.note` 同一类；
 * ② **取值决策一律不写在这里**，全在 `js/pure/apikeys.mjs`（admin-ui/README.md 硬规则 1）；
 * ③ **一切形态分支只读接口返回的字段**（`capabilities` 的 `apiKeys` 那一格），
 *    不许自己嗅探运行时、更不许把上限 / TTL / 「明文能不能再取回」写死在前端。
 *
 * ── 服务连接卡里**刻意没有主口令的掩码**（与设计稿的一处偏离，写清理由）──────────
 * 设计稿要在这张卡上复用 `masterKeyView()` 显示主口令掩码。**没有做，两条理由**：
 * ① 那份数据只有 `GET /admin/api/config` 给得出来 ⇒ 每打开一次这个板块就多**一次
 *    存储读**，而五份 DEPLOY.md 的配额账里这个板块的单价写的是「列一次表 = 1 次 get」；
 * ② 主口令的那张卡**已经在设置页上**（`sec-settings.js` 的 `buildMasterRow`），
 *    同一把凭据在面板上有两个展示入口，迟早会分叉——本仓为这个形态付过多次代价。
 * ⇒ 这里只写清「主口令永远有效、要轮换请去设置页」这句话，并把「设置」做成跳转。
 * **不画一个假的掩码，也不画一串圆点占位**。
 */
import { api, ApiError } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n, toast, openModal, confirmModal, copy } from "./ui.js";
import { fmtCount, fmtDash, fmtDuration, fmtInstant } from "./pure/format.mjs";
import { offsetMs, freshnessValues } from "./pure/overview.mjs";
// 错误码 → 文案。**全仓唯一那份「码 → i18n key」的翻译**，两族管理端点共用它
// （那张表的名字里没有 keys 字样，射程本来就是整棵管理树）。
import { adminErrorFields, adminErrorText } from "./pure/keys-write.mjs";
import {
  AK_CARDS, AK_SORTS, AK_EXPIRY_DAYS,
  akCounts, akListState, akItems, akVersion, akBadgeClass, akBucketLabelKey,
  akCardLabelKey, akSortLabelKey, akExpiryLabelKey, akVisible, akPurgeCount,
  akPurgeVisible, akEmptyKey, akToggleLabelKey, akNameProblem, akExpiresAt,
  akRevokeDelayMs, akCapability,
} from "./pure/apikeys.mjs";

const state = { q: "", sort: "new" };

let nodes = null;
/** 最近一次列表响应。`null` = 还没读到 / 读不出来。 */
let data = null;
/** 这一次读失败了没有。与 `data === null` **不是**一回事（后者还包含「没读过」）。 */
let loadError = false;
/** 在飞请求的取消闸。离开板块 / 发起下一次请求时作废上一次。 */
let abort = null;
/** `capabilities` 里那一块。**只拉一次**：三格都是建 app 时定死的部署期常量。 */
let cap = { wired: null, max: null, nameMax: null, plaintextRetrievable: false, cacheTtlMs: null };
/** KV 边缘缓存那个数，同样来自后端（概览页那条链）。 */
let edgeMs = null;

/** 把一次管理接口错误翻成一句话。**两族端点共用同一份翻译**，见上面的 import。 */
function errorMessage(e, genericKey) {
  return adminErrorText(adminErrorFields(e), t, genericKey);
}

/**
 * 把表单校验给出的那个「码 + params」翻成一句话。
 *
 * **走的是同一份翻译**（`adminErrorText`），所以同一条码在「前端拦下来」与
 * 「后端拒了」两条路径上给出的是**同一句话**——各写一份的话，运维会看到
 * 同一个错误有两种说法，而其中一种迟早过期。
 */
function problemText(problem) {
  return adminErrorText(
    { code: problem.code, params: problem.params ?? {}, message: "" }, t, "ak.writeFailed",
  );
}

/** 一张卡：标题 + 内容。**类名沿用全站那一套**（`card block`），不新造容器。 */
function block(titleKey) {
  const wrap = el("div", { class: "card block" });
  wrap.appendChild(elI18n("h3", titleKey));
  const body = el("div");
  wrap.appendChild(body);
  return { wrap, body };
}

/** 服务连接卡：Base URL + 一句「主口令在设置页」。见文件头那段偏离说明。 */
function buildServiceCard() {
  const { wrap, body } = block("ak.svc.title");
  // ⚠️ **不复用设置页的 `.cfg-field`**：那是一张 auto-fit 网格（一格一行地铺），
  // 而这里要的是「标签 + 值 + 一颗按钮」挤在同一行 —— 套上去之后那颗「复制」
  // 会被拉成整行宽的一条绿带（真浏览器上量到的）。
  const row = el("div", { class: "ak-svc-row" });
  row.appendChild(elI18n("div", "ak.svc.baseUrl", { class: "cfg-label" }));
  const url = el("div", { class: "mono", id: "ak-base-url" }, fmtDash(null));
  row.appendChild(url);
  const btn = elI18n("button", "common.copy", { type: "button" });
  btn.addEventListener("click", () => { copy(url.textContent); });
  row.appendChild(btn);
  body.appendChild(row);
  body.appendChild(elI18n("p", "ak.svc.master", { class: "muted note" }));
  return { wrap, url };
}

/** 四张统计卡。**沿用全站那一套 `.card-row > .card` + `.label` / `.value`。** */
function buildCards() {
  const grid = el("div", { class: "card-row" });
  const values = {};
  const labels = {};
  for (const c of AK_CARDS) {
    const card = el("div", { class: "card" });
    labels[c] = el("div", { class: "label" }, t(akCardLabelKey(c)));
    values[c] = el("div", { class: "value" }, fmtDash(null));
    card.appendChild(labels[c]);
    card.appendChild(values[c]);
    grid.appendChild(card);
  }
  return { grid, values, labels };
}

function buildToolbar() {
  const bar = el("div", { class: "toolbar" });
  const search = el("input", { type: "search" });
  search.setAttribute("placeholder", t("ak.searchPh"));
  search.setAttribute("data-i18n-ph", "ak.searchPh");
  search.addEventListener("input", () => { state.q = search.value; render(); });
  bar.appendChild(search);

  const sort = el("select");
  const sortOptions = {};
  for (const s of AK_SORTS) {
    sortOptions[s] = el("option", { value: s }, t(akSortLabelKey(s)));
    sort.appendChild(sortOptions[s]);
  }
  sort.value = state.sort;
  sort.addEventListener("change", () => { state.sort = sort.value; render(); });
  bar.appendChild(sort);

  // 右侧那一组：`.ak-bar-right` 只有一条 `margin-left:auto`，把两颗按钮推到行尾。
  const purge = el("button", { type: "button", class: "danger ak-bar-right" });
  purge.addEventListener("click", () => confirmPurge());
  bar.appendChild(purge);

  const issue = elI18n("button", "ak.issue", { type: "button", class: "primary" });
  issue.addEventListener("click", () => openIssueDialog());
  bar.appendChild(issue);

  return { bar, search, sort, sortOptions, purge, issue };
}

/** 一条密钥的卡片。**每一格都走 `el()`（textContent），名称尤其不许拼进 HTML。** */
function itemCard(v) {
  const card = el("div", { class: "ak-item" });

  const head = el("div", { class: "ak-item-head" });
  head.appendChild(el("span", { class: "seq" }, `#${fmtCount(v.seq)}`));
  head.appendChild(el("span", { class: "ak-name" }, String(v.name ?? "")));
  const badge = el("span", { class: akBadgeClass(v.bucket) }, t(akBucketLabelKey(v.bucket)));
  head.appendChild(badge);
  card.appendChild(head);

  const meta = el("div", { class: "ak-item-meta" });
  meta.appendChild(el("span", { class: "mono" }, String(v.masked ?? fmtDash(null))));
  const off = offsetMs();
  meta.appendChild(el("span", { class: "muted" },
    `${t("ak.createdAt")} ${fmtInstant(v.createdAt, off)}`));
  meta.appendChild(el("span", { class: "muted" }, v.expiresAt === null
    ? t("ak.expiresNever")
    : `${t("ak.expiresAt")} ${fmtInstant(v.expiresAt, off)}`));
  card.appendChild(meta);

  const actions = el("div", { class: "ak-item-actions" });
  const rename = elI18n("button", "ak.action.rename", { type: "button" });
  rename.addEventListener("click", () => openRenameDialog(v));
  actions.appendChild(rename);

  const toggle = elI18n("button", akToggleLabelKey(v), { type: "button" });
  toggle.addEventListener("click", () => toggleDisabled(v));
  actions.appendChild(toggle);

  const del = elI18n("button", "ak.action.delete", { type: "button", class: "danger" });
  del.addEventListener("click", () => confirmDelete(v));
  actions.appendChild(del);
  card.appendChild(actions);
  return card;
}

function render() {
  if (nodes === null) return;
  nodes.url.textContent = nodes.origin;

  const items = akItems(data);
  const counts = akCounts(loadError ? null : data);
  for (const c of AK_CARDS) {
    nodes.cards.values[c].textContent = fmtCount(counts[c]);
    nodes.cards.labels[c].textContent = t(akCardLabelKey(c));
  }
  for (const s of AK_SORTS) nodes.toolbar.sortOptions[s].textContent = t(akSortLabelKey(s));

  const st = akListState(data, loadError);
  const visible = akVisible(items, state.q, state.sort);

  // 「清理失效（N）」：N = 0 时整颗按钮不画（一颗点了什么都不会发生的按钮比没有更糟）。
  const purgeable = akPurgeVisible(items) && st === "ok" && akVersion(data) !== null;
  nodes.toolbar.purge.style.display = purgeable ? "" : "none";
  nodes.toolbar.purge.textContent = t("ak.purge", { count: akPurgeCount(items) });
  // 版本号还不知道时写操作整个禁掉：不带版本号的写会被后端 400，
  // 而那时面板给出的错误对运维毫无意义。
  nodes.toolbar.issue.disabled = st !== "ok" || cap.wired === false;

  const host = nodes.list;
  host.textContent = "";
  if (cap.wired === false) {
    host.appendChild(elI18n("p", "ak.notWired", { class: "muted note" }));
    return;
  }
  if (st === "error") {
    const banner = el("div", { class: "banner-danger" });
    banner.appendChild(elI18n("span", "ak.loadFailed"));
    const retry = elI18n("button", "common.refresh", { type: "button" });
    retry.addEventListener("click", () => { load(); });
    banner.appendChild(retry);
    host.appendChild(banner);
    return;
  }
  if (st === "unreadable") {
    // ⚠️ **这一支绝不能与「一把都没有」合并**：表坏掉时全部下游客户端正在 401，
    // 而画一句「你还没签发过密钥」会让运维往完全相反的方向查。
    const banner = el("div", { class: "banner-danger" });
    banner.appendChild(elI18n("span", "ak.unreadable"));
    host.appendChild(banner);
    host.appendChild(elI18n("p", "ak.unreadableHelp", { class: "muted note" }));
    return;
  }
  const emptyKey = akEmptyKey(items, visible);
  if (emptyKey !== null) {
    host.appendChild(elI18n("p", emptyKey, { class: "muted note" }));
    return;
  }
  for (const v of visible) host.appendChild(itemCard(v));
}

/** 「停用之后最多还能再用多久」那句话。**两个数都从后端来，一个都不写死。** */
function revokeDelayText() {
  const ms = akRevokeDelayMs(cap.cacheTtlMs, edgeMs);
  return t("ak.revokeDelay", { delay: fmtDuration(ms) });
}

// ── 网络 ────────────────────────────────────────────────────────────────────

async function loadCapabilities() {
  try {
    const body = await api.get("/capabilities");
    cap = akCapability(body);
    const kv = body && typeof body === "object" ? body.storage : null;
    void kv;
  } catch (e) {
    // 读不出来时保持 `wired: null`（「还不知道」），不假装它没接。
  }
  try {
    const ov = await api.get("/overview");
    // ⚠️ **这个数在 `freshness` 那一格，不在 `config`**（`handlers/overview.ts` 的
    // 响应形状：`config` 只装注册机与降级那几项）。第一版按 `ov.config.kvEdgeCacheMs`
    // 取，恒是 `undefined` ⇒ `edgeMs` 恒为 null ⇒ 停用/删除后那条 sticky 提示里的
    // 时长恒画成 `—`，也就是把「安全相关、必须给具体数字」那条要求整条落空。
    // ⇒ **走 `freshnessValues()`，与 `sec-overview.js` 同一个投影函数**：自己在这里
    // 再手写一遍取字段，就是给同一处漂移留第二个入口。
    edgeMs = freshnessValues(ov).kvEdgeCacheMs;
  } catch (e) {
    edgeMs = null;
  }
}

async function load() {
  if (abort !== null) abort.abort();
  abort = new AbortController();
  const ctl = abort;
  try {
    const body = await api.get("/apikeys", { signal: ctl.signal });
    if (ctl !== abort) return;
    data = body;
    loadError = false;
  } catch (e) {
    if (ctl !== abort) return;
    // **不把已经画好的列表抹掉**：一次读失败对「表里有什么」什么新东西都没说。
    loadError = true;
  }
  render();
}

/** 一次写操作的收尾：成功就重新拉一次（版本号必须刷新），失败就把码翻成一句话。 */
async function afterWrite(promise, okKey) {
  try {
    const out = await promise;
    toast(t(okKey), "ok");
    await load();
    return out;
  } catch (e) {
    toast(errorMessage(e, "ak.writeFailed"), "err", { sticky: true });
    // 409 stale_write / 表坏掉这两档都要求运维重新看一眼当前真值。
    if (e instanceof ApiError && e.status === 409) await load();
    return null;
  }
}

// ── 对话框 ──────────────────────────────────────────────────────────────────

/**
 * 签发对话框：名称 + 到期（不过期 / 7·30·90 天 / 自定义日期）。
 *
 * ⚠️ 快捷 chip 的文案是「**自签发时刻起** N 天」，不是「有效期 N 天」——
 * 理由（惰性激活这个概念在本网关里不存在）写在 `pure/apikeys.mjs` 的 `AK_EXPIRY_DAYS` 上方。
 */
function openIssueDialog() {
  const body = el("div");
  const nameRow = el("div", { class: "cfg-field" });
  nameRow.appendChild(elI18n("label", "ak.form.name", { class: "cfg-label" }));
  const name = el("input", { type: "text" });
  if (cap.nameMax !== null) name.setAttribute("maxlength", String(cap.nameMax));
  name.setAttribute("placeholder", t("ak.form.namePh"));
  name.setAttribute("data-i18n-ph", "ak.form.namePh");
  nameRow.appendChild(name);
  body.appendChild(nameRow);

  body.appendChild(elI18n("div", "ak.form.expiry", { class: "cfg-label" }));
  const chips = el("div", { class: "chips" });
  let chosenDays = 0;
  const chipNodes = {};
  const paint = () => {
    for (const d of AK_EXPIRY_DAYS) chipNodes[d].classList.toggle("active", chosenDays === d);
    chipNodes.custom.classList.toggle("active", chosenDays === null);
    custom.style.display = chosenDays === null ? "" : "none";
  };
  for (const d of AK_EXPIRY_DAYS) {
    const chip = elI18n("button", akExpiryLabelKey(d), { type: "button", class: "chip" });
    chip.addEventListener("click", () => { chosenDays = d; paint(); });
    chipNodes[d] = chip;
    chips.appendChild(chip);
  }
  const customChip = elI18n("button", "ak.expiry.custom", { type: "button", class: "chip" });
  customChip.addEventListener("click", () => { chosenDays = null; paint(); });
  chipNodes.custom = customChip;
  chips.appendChild(customChip);
  body.appendChild(chips);

  const custom = el("input", { type: "date" });
  custom.style.display = "none";
  body.appendChild(custom);

  const err = el("div", { class: "err" });
  body.appendChild(err);
  body.appendChild(elI18n("p", "ak.form.onceOnly", { class: "muted note" }));
  paint();

  openModal("ak.issueTitle", body, [
    { labelKey: "common.cancel" },
    {
      labelKey: "ak.issueSubmit",
      keepOpen: true,
      onClick: (close) => {
        err.textContent = "";
        const nameProblem = akNameProblem(name.value, cap.nameMax);
        if (nameProblem !== null) { err.textContent = problemText(nameProblem); return; }
        const exp = akExpiresAt(chosenDays, custom.value, Date.now());
        if (exp.key !== undefined) { err.textContent = t(exp.key); return; }
        if (exp.code !== undefined) { err.textContent = problemText(exp); return; }
        const payload = { name: name.value.trim(), expiresAt: exp.value };
        void afterWrite(api.post("/apikeys", payload), "ak.issued").then((out) => {
          if (out === null) return;
          close();
          showSecret(out);
        });
      },
    },
  ]);
}

/**
 * 一次性明文对话框。**这是明文唯一一次出现在屏幕上的地方。**
 *
 * ⚠️ 关闭那颗按钮的文案逐字写着「关掉就再也看不到了」——面板不许让人以为
 * 「回头再来复制」这个动作存在。`capabilities.apiKeys.plaintextRetrievable`
 * 恒 false 就是这条契约的机器可读形态，这里据它决定要不要画这段警告，
 * **不在前端写死**。
 */
function showSecret(out) {
  const secret = out && typeof out === "object" ? out.secret : null;
  const body = el("div");
  body.appendChild(elI18n("p", "ak.secret.intro"));
  const value = el("div", { class: "mono ak-secret" }, typeof secret === "string" ? secret : fmtDash(null));
  body.appendChild(value);
  const btn = elI18n("button", "common.copy", { type: "button" });
  btn.addEventListener("click", () => { copy(typeof secret === "string" ? secret : ""); });
  body.appendChild(btn);
  if (!cap.plaintextRetrievable) body.appendChild(elI18n("p", "ak.secret.onceOnly", { class: "banner-warn" }));
  openModal("ak.secret.title", body, [{ labelKey: "ak.secret.close" }]);
}

function openRenameDialog(v) {
  const body = el("div");
  body.appendChild(elI18n("label", "ak.form.name", { class: "cfg-label" }));
  const name = el("input", { type: "text" });
  if (cap.nameMax !== null) name.setAttribute("maxlength", String(cap.nameMax));
  name.value = String(v.name ?? "");
  body.appendChild(name);
  const err = el("div", { class: "err" });
  body.appendChild(err);
  openModal("ak.renameTitle", body, [
    { labelKey: "common.cancel" },
    {
      labelKey: "common.confirm",
      keepOpen: true,
      onClick: (close) => {
        err.textContent = "";
        const problem = akNameProblem(name.value, cap.nameMax);
        if (problem !== null) { err.textContent = problemText(problem); return; }
        const version = akVersion(data);
        if (version === null) { err.textContent = t("ak.staleView"); return; }
        void afterWrite(
          api.patch(`/apikeys/${encodeURIComponent(v.id)}`, { version, name: name.value.trim() }),
          "ak.renamed",
        ).then((out) => { if (out !== null) close(); });
      },
    },
  ]);
}

function toggleDisabled(v) {
  const version = akVersion(data);
  if (version === null) { toast(t("ak.staleView"), "warn"); return; }
  const next = !(v.disabled === true);
  void afterWrite(
    api.patch(`/apikeys/${encodeURIComponent(v.id)}`, { version, disabled: next }),
    next ? "ak.disabled" : "ak.enabled",
  ).then((out) => {
    // **停用成功要把「多久才在别处失效」说出来**，而且要给具体的数字。
    // 这是安全相关的：运维会以为停用是即时的。
    if (out !== null && next) toast(revokeDelayText(), "warn", { sticky: true });
  });
}

function confirmDelete(v) {
  confirmModal("ak.deleteTitle", "ak.deleteConfirm", () => {
    const version = akVersion(data);
    if (version === null) { toast(t("ak.staleView"), "warn"); return; }
    void afterWrite(
      api.del(`/apikeys/${encodeURIComponent(v.id)}?version=${version}`),
      "ak.deleted",
    ).then((out) => { if (out !== null) toast(revokeDelayText(), "warn", { sticky: true }); });
  });
}

function confirmPurge() {
  confirmModal("ak.purgeTitle", "ak.purgeConfirm", () => {
    const version = akVersion(data);
    if (version === null) { toast(t("ak.staleView"), "warn"); return; }
    void afterWrite(api.post("/apikeys/purge", { version }), "ak.purged");
  });
}

// ── 板块契约 ────────────────────────────────────────────────────────────────

export const apikeysSection = {
  init(host) {
    // **板块主标题走本板块自己的 `ak.title`，不复用侧栏那条 `nav.apikeys`**：
    // 与其余八个板块逐字同源（它们各有 `keys.title` / `ov.title` / …）。
    // `nav.*` 那一族是**壳层导航**的文案，全部写在 `index.html` 的 `data-i18n` 属性里
    // ——`tests/unit/i18n-dict.test.ts` 有一格正面登记着「`nav` 在 JS 侧一个引用都没有」，
    // 在这里引用它会让那一格红，而那一格红说的是「壳层与板块的文案边界被跨了」。
    host.appendChild(elI18n("h2", "ak.title"));
    host.appendChild(elI18n("p", "ak.sub", { class: "sub" }));
    const svc = buildServiceCard();
    host.appendChild(svc.wrap);
    const cards = buildCards();
    host.appendChild(cards.grid);
    const toolbar = buildToolbar();
    host.appendChild(toolbar.bar);
    const list = el("div", { class: "ak-list" });
    host.appendChild(list);
    // `location.origin` 只读一次：它在一次会话里不会变，而这个板块的每一次
    // render 都要写它。**读它的是板块文件，不是 `js/pure/` 那一层**（那里禁浏览器全局）。
    nodes = { url: svc.url, cards, toolbar, list, origin: location.origin };
  },
  onShow() {
    render();
    void (async () => {
      if (cap.wired === null) await loadCapabilities();
      await load();
    })();
  },
  onHide() {
    if (abort !== null) { abort.abort(); abort = null; }
  },
};
