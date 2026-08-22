/**
 * 注册机板块（设计 §10.3）：状态 → 池子四格 → **两张完全平级的通道卡** → 补池历史。
 * 「立即补池」那颗按钮的四条护栏在后端（`src/http/admin/handlers/registrar.ts`），
 * 第 3 条（确认弹窗明示消耗）在这里。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * 三条纪律：
 * ① 一切来自接口的内容一律 textContent（补池历史里的 `channel` 是配置来的字符串、
 *    `reason` 可能是这个面板版本不认识的值，两者都会被原样显示）；
 * ② **取值决策一律不写在这里**，全在 `js/pure/registrar.mjs` 里，由
 *    `tests/ui/registrar.test.ts` 的
 *    「第 3 条：通道顺序恒为 moemail, yyds（字母序，唯一可辩护的中立规则）」
 *    那一族跑着（admin-ui/README.md 硬规则 1）；
 * ③ **没有自动刷新。** 这个板块每刷新一次要付 3 次存储读（补池历史 + 补池锁 +
 *    护栏键），而配额账把面板的读算成「人点一下才发生」。要加轮询之前先去看
 *    计划「配额账」一节的红线。
 *
 * ⚠️ **两张通道卡由同一个 `buildChannelCard()` 建出来，这不是省代码。**
 * 设计 §10.3 第 2 条要求「两张卡片布局完全对称：同字段数、同控件类型」，
 * 而两段各写各的代码迟早会分叉（一边多一行说明、一边少一颗按钮）。
 * 从同一个函数建出来时，**不对称在结构上就是不可表达的**——除非有人专门给它
 * 加一个 `if (channel === …)`，而那一行在评审里看得见。
 * `tests/ui/dom/registrar-section.test.ts` 的
 * 「两张通道卡同字段数、同控件类型、同顺序 —— 加一行说明就变红」正面钉着它。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n, toast, openModal } from "./ui.js";
import { fmtCount, fmtDash, fmtDuration, fmtInstant } from "./pure/format.mjs";
import { offsetMs } from "./pure/overview.mjs";
import {
  CHANNELS, channelLabelKey, channelAddressFactKey, channelRoleKey,
  statusView, channelCards, poolView, tendCost, manualQuotaView,
  historyRows, historyMalformed, roundOutcome, roundFailures, mintedByChannelText,
  channelTestResult, refuseKeyOf,
} from "./pure/registrar.mjs";

let nodes = null;
let abort = null;
/** 最近一次成功的 `/registrar/status` 响应；`null` = 还没有过一次成功。 */
let data = null;

/** 「标签: 值」一行。与概览板块同一个原语，值由调用方之后自己 textContent。 */
function row(labelKey) {
  const p = el("p");
  p.appendChild(el("span", { class: "muted" }, `${t(labelKey)}: `));
  const value = el("span");
  p.appendChild(value);
  return { p, value };
}

function block(titleKey) {
  const wrap = el("div", { class: "card block" });
  wrap.appendChild(elI18n("h3", titleKey));
  const body = el("div");
  wrap.appendChild(body);
  return { wrap, body };
}

function tile(labelKey, tipKey) {
  const card = el("div", { class: "card" });
  const label = elI18n("div", labelKey, { class: "label" });
  // tooltip 只挂在需要解释口径的那一格上（「占名额」）。**不是每格都挂**——
  // 一个到处都是问号的面板等于没有问号。
  if (tipKey) label.setAttribute("title", t(tipKey));
  card.appendChild(label);
  const value = el("div", { class: "value" });
  card.appendChild(value);
  return { card, value };
}

/**
 * 一张通道卡。**两条通道走同一条代码路径**，见文件头那段。
 *
 * 卡里恰好五行 + 一颗按钮：名称、角色、凭据、地址事实、测试结果行 + 「测试连接」。
 * **地址事实那一行是两条通道之间唯一的不对称**（设计 §10.3 第 5 条），
 * 而它是**同一个字段位置上的两句不同事实**，不是「一边有一边没有」——
 * 后者才会被读成排名。
 */
function buildChannelCard(channel) {
  const card = el("div", { class: "card channel-card", "data-channel": channel });
  card.appendChild(elI18n("div", channelLabelKey(channel), { class: "label channel-name" }));

  const role = row("reg.channel.role");
  const creds = row("reg.channel.creds");
  card.appendChild(role.p);
  card.appendChild(creds.p);

  // 地址事实：常驻文案，不随响应变化（它讲的是这两家服务本身的性质）。
  card.appendChild(elI18n("p", channelAddressFactKey(channel), { class: "muted note" }));

  const test = elI18n("button", "reg.channel.test", { type: "button", class: "channel-test" });
  card.appendChild(test);

  const result = el("p", { class: "muted note channel-result" });
  card.appendChild(result);

  test.addEventListener("click", () => { runChannelTest(channel, test, result); });
  return { card, role: role.value, creds: creds.value, test, result };
}

/**
 * 跑一次通道连通性测试。
 *
 * **在飞期间禁用这颗按钮**：它每点一次就向邮箱服务发一次真实请求。
 *
 * ⚠️ **这段话订正过（P3d Task 8）**：上一版写着「这条端点**后端没有冷却也没有预算闸**」
 * ——**那句话已经不成立了**。后端现在有一套出站探测护栏（在途去重 + 最小间隔，
 * 与单把 key 验活共用同一份，见 `src/http/admin/probe-guard.ts`），
 * 同一条通道在最小间隔内的第二次点击会拿到 **429**，顶层 `reason` 是
 * `probe_in_flight` / `probe_cooldown`，两条都在 `refuseReasonKey()` 的表里。
 *
 * **前端这一行仍然要留着，但理由不是「两者不重叠」——那句话是假的**（定向复评 NEW-9）：
 * 手滑连点时**护栏同样挡得住**（后端回 429，第二次不会真打上游），
 * 两者在「第二次不会真打上游」这个**结果**上完全重叠，差别只在 **UX**：
 * 有这一行，运维看到的是一颗变灰的按钮；没有这一行，他手一抖就会拿到一句
 * 「请稍后再试」，而他什么错都没犯。
 *
 * ⇒ 准确的说法是**各自还挡住了对方挡不住的那一半**：
 * 护栏挡得住脚本（前端禁用挡不住），前端禁用挡得住那句无谓的 429 文案（护栏挡不住）。
 * **两者都不是「连点已经解决了」**——护栏是进程/isolate 内的，跨副本无效。
 */
async function runChannelTest(channel, button, resultNode) {
  button.disabled = true;
  resultNode.textContent = t("reg.channel.testing");
  try {
    const res = await api.post(`/registrar/channels/${channel}/test`);
    const view = channelTestResult(res);
    resultNode.textContent = t(view.key, view.params);
  } catch (e) {
    // 后端明确拒绝（注册机没开 / 这条通道没配 / 没接线）时有顶层 `reason`，
    // 拿它选一句确切的话；拿不到就退回一句通用的，**不猜**。
    const key = refuseKeyOf(e && e.body);
    resultNode.textContent = key === null ? t("reg.channel.testError") : t(key);
  } finally {
    button.disabled = false;
  }
}

/**
 * 算「本次最多铸几把」要的那份状态。
 *
 * 本板块已经拉过就直接用（切板块回来时那份数据就是刚拉的）；**Key 池板块那条
 * 入口进来时它是 `null`**，此时现拉一次——一次点击付一次读，比让确认弹窗
 * 显示一个 `—` 好，而「明示消耗」是设计 §10.2 写死的第 3 条护栏。
 * 拉失败就回 `null`，弹窗会如实说「说不准」而不是编一个数字。
 */
async function statusForCost() {
  if (data !== null) return data;
  try {
    return await api.get("/registrar/status");
  } catch (e) {
    return null;
  }
}

/**
 * 「立即补池」的确认弹窗（设计 §10.2 第 3 条护栏：必须明示消耗）。
 *
 * **两个入口共用这一个函数**：本板块工具条上那颗按钮（`channel === null`，
 * 弹窗里带通道下拉），与 Key 池板块「添加 Key」菜单里【自动注册】那两项
 *（`channel` 已经定死，弹窗里显示的是「用哪条通道」的**结果**而不是一个下拉）。
 * 抄成两份的话，「明示消耗」这条护栏迟早只剩一半——而少的那一半正好是
 * 点击频率更高的那个入口。
 *
 * ⚠️ **通道下拉初始是占位符，两条通道都不预选**——与设计 §10.3 第 1 条
 *（主通道下拉无默认选中值）是同一条纪律：预选任何一条都会被读成排名。
 * 占位符本身是一个**有意义的选项**（「按当前配置的主/备通道」），不是空白项。
 *
 * ⚠️⚠️ **这不是设计 §10.4 设置页里那个「主通道」下拉。** 那一条（连同第 7 条
 * `fallback !== primary` 的即时拦截）属于 config 写路径，而本任务没有那条端点
 * ——**别把这里这一格当成第 1 条与第 7 条已经落地了**。
 */
export async function confirmAndTend(channel) {
  const body = el("div");
  const cost = tendCost(await statusForCost());
  body.appendChild(el(
    "p", null,
    cost === null
      ? t("reg.tend.confirmUnknown")
      : t("reg.tend.confirmMsg", { keys: fmtCount(cost.keys), mailboxes: fmtCount(cost.mailboxes) }),
  ));

  const label = el("label");
  label.appendChild(elI18n("span", "reg.tend.channelLabel"));
  let read = () => channel;
  if (channel === null) {
    const select = el("select", { class: "tend-channel" });
    select.appendChild(el("option", { value: "" }, t("reg.tend.channelAny")));
    for (const c of CHANNELS) {
      select.appendChild(el("option", { value: c }, t(channelLabelKey(c))));
    }
    // **显式写死初始值**，不靠「第一个 option 恰好是占位符」这个巧合：
    // 有人往前面插一条通道时，那个巧合会静默地把它变成预选项。
    select.value = "";
    label.appendChild(select);
    read = () => (select.value === "" ? null : select.value);
  } else {
    label.appendChild(el("span", null, t(channelLabelKey(channel))));
  }
  body.appendChild(label);

  openModal("reg.tend.confirmTitle", body, [
    { labelKey: "common.cancel" },
    { labelKey: "common.confirm", onClick: () => { startTend(read()); } },
  ]);
}

async function startTend(channel) {
  try {
    await api.post("/registrar/tend", channel === null ? {} : { channel });
    toast(t("reg.tend.started"), "ok");
  } catch (e) {
    const key = refuseKeyOf(e && e.body);
    // 拒绝的原因**必须留在屏幕上**（sticky）：它们里面有「今天的额度用完了」
    // 这种四秒钟根本读不完、而且读漏了会让人反复点的信息。
    toast(key === null ? t("reg.tend.failed") : t(key), "warn", { sticky: true });
  }
  // 无论成败都重新拉一次：成功那一支的 `remaining` 与冷却时刻都变了，
  // 失败那一支也可能是因为别的副本刚抢走了锁。
  // **Key 池板块那条入口进来时本板块可能还没 init 过**（`nodes === null`），
  // `load()` 自己会跳过渲染，见那里。
  load();
}

function renderStatus() {
  const s = statusView(data);
  nodes.state.textContent = s.enabled === null ? fmtDash(null) : t(s.enabled ? "reg.state.on" : "reg.state.off");
  nodes.primary.textContent = s.primary === null ? t("reg.none") : s.primary;
  nodes.fallback.textContent = s.fallback === null ? t("reg.none") : s.fallback;

  // 设计 §10.3 第 8 条的空状态：**只在注册机开着却没有主通道时出现**。
  // 注册机整个关着时不显示它——那时该说的是「已关闭」，而不是催人去选通道。
  nodes.emptyPrimary.style.display = s.enabled === true && s.primary === null ? "" : "none";

  nodes.locked.textContent = s.lockedUntil === null
    ? "" : t("reg.locked", { at: fmtInstant(s.lockedUntil, offsetMs()) });
  nodes.locked.style.display = s.lockedUntil === null ? "none" : "";
}

function renderPool() {
  const p = poolView(data);
  nodes.pool.target.textContent = fmtCount(p.target);
  nodes.pool.counted.textContent = fmtCount(p.counted);
  nodes.pool.gap.textContent = fmtCount(p.gap);
  nodes.pool.fresh.textContent = fmtCount(p.fresh);
}

/**
 * 「今天还剩几次 / 什么时候能再点」。
 *
 * ⚠️ **`remaining` 在点之前就显示**，不是等到点不动了才说——只在耗尽那一支说，
 * 等于让运维毫不知情地撞上一堵墙（后端 202 那一支也给 `remaining` 正是为了这个）。
 * ⚠️ **倒计时用相对量 `retryAfterMs`、几点恢复用绝对量 `cooldownUntil`**，
 * 两个都由服务端给，绝不拿本地时钟去减服务端时刻。
 */
function renderQuota() {
  const q = manualQuotaView(data);
  if (q.remaining === null || q.perDay === null) {
    nodes.quota.textContent = fmtDash(null);
  } else {
    nodes.quota.textContent = t("reg.tend.quota", { remaining: fmtCount(q.remaining), perDay: fmtCount(q.perDay) })
      + (q.resetAt === null ? "" : t("reg.tend.quotaReset", { at: fmtInstant(q.resetAt, offsetMs()) }));
  }
  const cooling = q.cooldownUntil !== null && q.retryAfterMs !== null;
  nodes.cooldown.textContent = cooling
    ? t("reg.tend.cooldown", {
      at: fmtInstant(q.cooldownUntil, offsetMs()),
      left: fmtDuration(q.retryAfterMs),
    })
    : "";
  nodes.cooldown.style.display = cooling ? "" : "none";
}

function renderChannels() {
  for (const card of channelCards(data)) {
    const n = nodes.channels[card.channel];
    n.role.textContent = card.role === null && card.configured === null
      ? fmtDash(null) : t(channelRoleKey(card.role));
    n.creds.textContent = card.configured === null
      ? fmtDash(null) : t(card.configured ? "reg.channel.credsYes" : "reg.channel.credsNo");
  }
}

/** 一条失败归因的徽章。**表外的 reason 原样显示出来**，不冒充任何一档已知归因。 */
function failureBadge(f) {
  const text = f.key === null ? t("reg.fail.unknownReason", { reason: f.reason }) : t(f.key);
  return el("span", { class: "badge badge-warn" }, f.channel === "" ? text : `${f.channel} · ${text}`);
}

function renderHistory() {
  const rows = historyRows(data);
  const malformed = historyMalformed(data);
  nodes.malformed.textContent = malformed === null || malformed === 0
    ? "" : t("reg.history.malformed", { count: fmtCount(malformed) });
  nodes.malformed.style.display = malformed === null || malformed === 0 ? "none" : "";

  nodes.historyBody.textContent = "";
  if (rows.length === 0) {
    nodes.historyBody.appendChild(elI18n("p", "reg.history.empty", { class: "muted" }));
    return;
  }

  const table = el("table");
  const head = el("tr");
  for (const k of ["reg.col.at", "reg.col.trigger", "reg.col.channel", "reg.col.result", "reg.col.duration", "reg.col.failures"]) {
    head.appendChild(elI18n("th", k));
  }
  table.appendChild(head);

  for (const r of rows) {
    const tr = el("tr");
    tr.appendChild(el("td", null, typeof r.at === "number" ? fmtInstant(r.at, offsetMs()) : fmtDash(null)));
    tr.appendChild(el(
      "td", null,
      r.trigger === "manual" ? t("reg.trigger.manual") : (r.trigger === "cron" ? t("reg.trigger.cron") : fmtDash(null)),
    ));
    // `primaryChannel` 是**这一轮实际用的那条**（手动补池可以指定单条通道），
    // 不是配置里的主通道。空串 = 注册机当时关着。
    tr.appendChild(el("td", null, typeof r.primaryChannel === "string" && r.primaryChannel !== ""
      ? r.primaryChannel : fmtDash(null)));

    const outcome = roundOutcome(r);
    const resultCell = el("td");
    resultCell.appendChild(el("div", null, t(outcome.key, outcome.params)));
    const byChannel = mintedByChannelText(r);
    if (byChannel !== null) {
      resultCell.appendChild(el("div", { class: "muted" }, t("reg.row.byChannel", { detail: byChannel })));
    }
    tr.appendChild(resultCell);

    tr.appendChild(el("td", null, typeof r.durationMs === "number" ? fmtDuration(r.durationMs) : fmtDash(null)));

    const failCell = el("td");
    const failures = roundFailures(r);
    if (failures.length === 0) failCell.textContent = fmtDash(null);
    else for (const f of failures) failCell.appendChild(failureBadge(f));
    tr.appendChild(failCell);

    table.appendChild(tr);
  }
  nodes.historyBody.appendChild(table);
}

function render() {
  renderStatus();
  renderPool();
  renderQuota();
  renderChannels();
  renderHistory();
}

async function load() {
  if (abort) abort.abort();
  abort = new AbortController();
  try {
    data = await api.get("/registrar/status", { signal: abort.signal });
  } catch (e) {
    if (e && e.name === "AbortError") return;
    // **不伪造上一次的数据**：读失败就清空，不留着旧值假装它是新的。
    data = null;
  }
  // ⚠️ **`nodes === null` 说明本板块还没被打开过**（Key 池板块的【自动注册】
  // 那两项会在没打开过注册机板块的情况下走到这条路上）。此时**只更新 `data`、
  // 不渲染**——渲染一棵还不存在的子树只会抛 TypeError，而那次抛错发生在
  // `startTend` 的 `await` 之后，连 toast 都已经弹过了，运维只会在控制台看到它。
  if (nodes !== null) render();
}

export const registrarSection = {
  init(section) {
    section.textContent = "";
    section.appendChild(elI18n("h2", "reg.title"));

    const bar = el("div", { class: "toolbar" });
    const refresh = elI18n("button", "common.refresh", { type: "button" });
    refresh.addEventListener("click", () => { load(); });
    bar.appendChild(refresh);
    const tend = elI18n("button", "reg.tend.button", { type: "button", class: "tend-now" });
    tend.addEventListener("click", () => { confirmAndTend(null); });
    bar.appendChild(tend);
    section.appendChild(bar);

    const status = block("reg.state");
    const state = row("reg.state");
    const primary = row("reg.primary");
    const fallback = row("reg.fallback");
    for (const r of [state, primary, fallback]) status.body.appendChild(r.p);
    const emptyPrimary = elI18n("p", "reg.emptyPrimary", { class: "muted note" });
    emptyPrimary.style.display = "none";
    status.body.appendChild(emptyPrimary);
    const quota = el("p", { class: "muted note" });
    const cooldown = el("p", { class: "muted note" });
    cooldown.style.display = "none";
    const locked = el("p", { class: "muted note" });
    locked.style.display = "none";
    status.body.appendChild(quota);
    status.body.appendChild(cooldown);
    status.body.appendChild(locked);
    section.appendChild(status.wrap);

    const poolRow = el("div", { class: "card-row" });
    const target = tile("reg.pool.target");
    const counted = tile("reg.pool.counted", "reg.pool.countedTip");
    const gap = tile("reg.pool.gap");
    const fresh = tile("reg.pool.fresh");
    for (const c of [target, counted, gap, fresh]) poolRow.appendChild(c.card);
    section.appendChild(poolRow);

    const channelsBlock = block("reg.channels.title");
    channelsBlock.body.appendChild(elI18n("p", "reg.channel.testHint", { class: "muted note" }));
    const channelRow = el("div", { class: "card-row" });
    const channels = {};
    // **顺序取自 `CHANNELS`**（字母序），不取响应里对象键的顺序——后者改后端一行
    // 就能悄悄改变面板上谁排在前面，而任何顺序都会被读成排名。
    for (const channel of CHANNELS) {
      const built = buildChannelCard(channel);
      channels[channel] = built;
      channelRow.appendChild(built.card);
    }
    channelsBlock.body.appendChild(channelRow);
    section.appendChild(channelsBlock.wrap);

    const historyBlock = block("reg.history.title");
    const malformed = el("p", { class: "muted note" });
    malformed.style.display = "none";
    historyBlock.body.appendChild(malformed);
    const historyBody = el("div");
    historyBlock.body.appendChild(historyBody);
    section.appendChild(historyBlock.wrap);

    nodes = {
      state: state.value, primary: primary.value, fallback: fallback.value,
      emptyPrimary, quota, cooldown, locked,
      pool: { target: target.value, counted: counted.value, gap: gap.value, fresh: fresh.value },
      channels, malformed, historyBody,
    };
  },

  onShow() {
    load();
  },

  onHide() {
    // **作废在飞请求**：不作废的话切回来时旧响应可能盖掉新数据（板块契约 §9.3）。
    if (abort) { abort.abort(); abort = null; }
  },
};
