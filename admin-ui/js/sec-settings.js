/**
 * 设置页（设计 §10.4 的前三张卡）：认证密钥 / 上游与冷却 / 注册机。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * ── 四条纪律 ────────────────────────────────────────────────────────────────
 *
 * ① **一切来自接口的内容一律 textContent**（四元组里的 `stored` 可能是任何东西，
 *    包括被外部写坏的字符串）。
 * ② **取值决策一律不写在这里**，全在 `js/pure/settings.mjs` 里
 *    （admin-ui/README.md 硬规则 1）。
 * ③ ⚠️⚠️ **成功提示不得早于回读**（设计 §5.3：「本设计唯一一条不可妥协的产品原则」）。
 *    这条在本文件的落点是 `save()` 里那一行 `const res = await api.put(...)`——
 *    **任何「已保存」的迹象都必须排在它之后**。把提示挪到 `await` 之前，
 *    `tests/ui/dom/settings-save.test.ts` 的
 *    「回读还没落定之前，界面上不许出现任何成功迹象」会变红。
 *    **并且不弹「已保存并生效」**（设计 §5.3 明令），而是回读 `effective`
 *    并把变化的字段高亮。
 * ④ **没有自动刷新。** 这个板块每刷新一次要付 1 次存储读，而配额账把面板的读
 *    算成「人点一下才发生」。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n, toast, openModal } from "./ui.js";
import { fmtDuration } from "./pure/format.mjs";
// **顺序的唯一真源在 `registrar.mjs`**，本文件把它传给 `channelFields()`，
// `settings.mjs` 里不重新声明一份（见那里的说明）。
import { CHANNELS, channelLabelKey, channelAddressFactKey } from "./pure/registrar.mjs";
import {
  CARD_AUTH, CARD_UPSTREAM, CARD_REGISTRAR, ADVANCED_FIELDS,
  channelFields, fieldLabelKey, fieldView, credentialView,
  buildPatch, localErrors, changedFields, changedSecrets, propagationView,
  errorRows, clearResultView, displayValue, clearWarning,
} from "./pure/settings.mjs";

let nodes = null;
let abort = null;
/** 最近一次成功的 `GET /admin/api/config` 响应；`null` = 还没有过一次成功。 */
let data = null;

/**
 * 一格字段。**公开字段与凭据长得不一样，但都由这一个函数建出来**——
 * 两条代码路径迟早会分叉（一边有锁徽标、一边忘了加），而分叉的那一边正好是
 * 凭据这一边时，后果是运维在一个被 env 锁死的口令框里改了半天。
 */
function buildField(path, secret) {
  const wrap = el("div", { class: "cfg-field", "data-field": path });
  const label = elI18n("label", fieldLabelKey(path), { class: "cfg-label" });
  wrap.appendChild(label);

  const input = secret
    ? el("input", { type: "password", autocomplete: "new-password", "data-i18n-ph": "set.secretPlaceholder" })
    : el("input", { type: "text" });
  if (secret) input.setAttribute("placeholder", t("set.secretPlaceholder"));
  wrap.appendChild(input);

  // 四元组那三格（`stored` / `env` / `effective`）与锁定说明各自一行。
  const meta = el("p", { class: "muted note cfg-meta" });
  wrap.appendChild(meta);
  const lock = el("p", { class: "muted note cfg-lock" });
  lock.style.display = "none";
  wrap.appendChild(lock);

  let clear = null;
  if (secret) {
    clear = elI18n("button", "set.clearSecret", { type: "button", class: "cfg-clear danger" });
    clear.addEventListener("click", () => { confirmClear(path); });
    wrap.appendChild(clear);
  }
  return { wrap, input, meta, lock, clear, path, secret };
}

/** 主/备通道的下拉。**初始是占位符，两条通道都不预选**（设计 §10.3 第 1 条）。 */
function buildChannelSelect(path) {
  const wrap = el("div", { class: "cfg-field", "data-field": path });
  wrap.appendChild(elI18n("label", fieldLabelKey(path), { class: "cfg-label" }));
  const select = el("select");
  // 占位符本身是一个**有意义的选项**（「未选择」），不是空白项。
  select.appendChild(el("option", { value: "" }, t("reg.none")));
  for (const c of CHANNELS) {
    select.appendChild(el("option", { value: c }, t(channelLabelKey(c))));
  }
  // **显式写死初始值**，不靠「第一个 option 恰好是占位符」这个巧合。
  select.value = "";
  wrap.appendChild(select);
  const meta = el("p", { class: "muted note cfg-meta" });
  wrap.appendChild(meta);
  const lock = el("p", { class: "muted note cfg-lock" });
  lock.style.display = "none";
  wrap.appendChild(lock);
  return { wrap, input: select, meta, lock, clear: null, path, secret: false };
}

/** 注册机开关。布尔字段用 checkbox，别的都是文本框。 */
function buildToggle(path) {
  const wrap = el("div", { class: "cfg-field", "data-field": path });
  wrap.appendChild(elI18n("label", fieldLabelKey(path), { class: "cfg-label" }));
  const input = el("input", { type: "checkbox" });
  wrap.appendChild(input);
  const meta = el("p", { class: "muted note cfg-meta" });
  wrap.appendChild(meta);
  const lock = el("p", { class: "muted note cfg-lock" });
  lock.style.display = "none";
  wrap.appendChild(lock);
  return { wrap, input, meta, lock, clear: null, path, secret: false };
}

function card(titleKey) {
  const wrap = el("div", { class: "card block" });
  wrap.appendChild(elI18n("h3", titleKey));
  const body = el("div");
  wrap.appendChild(body);
  return { wrap, body };
}

/** 建一格并登记进 `nodes.fields`，两处都不许漏——漏了那一格永远不会被渲染。 */
function addField(container, path, kind) {
  const built = kind === "select"
    ? buildChannelSelect(path)
    : (kind === "toggle" ? buildToggle(path) : buildField(path, kind === "secret"));
  container.appendChild(built.wrap);
  nodes.fields[path] = built;
  return built;
}

// ───────────────────────────────────────────────────────────────────────────
// 渲染
// ───────────────────────────────────────────────────────────────────────────

function renderOne(built) {
  const path = built.path;
  if (built.secret) {
    const v = credentialView(data, path);
    built.meta.textContent = v.present === false
      ? t("set.meta.unreadable")
      : t("set.meta.secret", {
        state: t(v.configured === true ? "set.secretSet" : "set.secretUnset"),
        hint: v.hint === null ? "—" : v.hint,
      });
    setLock(built, v.locked, v.lockedBy);
    // **凭据框永远是空的**：它没有明文可回填（设计 §8.6），占位符说「留空则不修改」。
    built.input.value = "";
    // ⚠️ **清空按钮不跟着 `locked` 一起禁用，这一行是订正。**
    // 它清的是**存储里那一份**，而 env 锁定恰恰是「清掉存储那份最安全」的状态
    //（生效值回落到环境变量，纹丝不动）。第一版跟着 `locked` 禁用，
    // 与 `src/core/admin/config-validate.ts` 的 `clearSecret` 里写着的理由
    //（「环境变量提供口令的部署想清掉存储里那份多余的旧口令时无路可走」）自相矛盾——
    // 后端从来没拦过它，`configClearSecretHandler` 里那个 `stillConfigured` 分支
    // 就是专门为这个状态写的，只有前端把它挡死了。
    // 判据改成「有东西可清才让点」：`configured` 为假时清空是纯粹的空操作。
    if (built.clear !== null) built.clear.disabled = v.configured !== true;
    return;
  }

  const v = fieldView(data, path);
  if (v.present === false) {
    built.meta.textContent = t("set.meta.unreadable");
    built.input.disabled = true;
    setLock(built, false, null);
    return;
  }
  built.meta.textContent = t("set.meta.quad", {
    stored: displayValue(v.stored),
    env: displayValue(v.env),
    effective: displayValue(v.effective),
  });
  // 输入框里回填**存储层**那个值（面板真正在改的就是那一层）；存储里没有就留空，
  // 生效值另在上面那一行里写着。
  if (built.input.getAttribute("type") === "checkbox") {
    built.input.checked = v.stored === true || (v.stored === null && v.effective === true);
  } else {
    built.input.value = v.stored === null || v.stored === undefined ? "" : String(v.stored);
    // **框里空着的时候，占位符显示当前生效值**：框里回填的是存储层那个值，而全新
    // 部署下存储层是空的 ⇒ 一整页空框。占位符把「现在实际在用的是什么」放回框里，
    // 而它**不是**一个会被提交的值（留空 = 这次不改这一格，见 `buildPatch`）。
    built.input.setAttribute("placeholder", displayValue(v.effective));
  }
  setLock(built, v.locked, v.lockedBy);
}

/**
 * 锁定字段：**输入框置灰 + 一句怎么轮换的说明**（设计 §5.3 UI 规则 / §10.4 卡 1）。
 *
 * ⚠️ **说明必须说清「怎么改」，不是只说「被锁了」**：环境变量锁定时，面板上改
 * 一百遍都不会生效，运维要知道去改的是部署那一侧。
 */
function setLock(built, locked, lockedBy) {
  built.input.disabled = locked === true;
  built.lock.style.display = locked === true ? "" : "none";
  built.lock.textContent = locked === true
    ? t("set.lockedBy", { env: String(lockedBy || "").replace(/^env:/, "") })
    : "";
  built.wrap.classList.toggle("locked", locked === true);
}

function render() {
  for (const path of Object.keys(nodes.fields)) renderOne(nodes.fields[path]);

  const p = propagationView(data);
  nodes.propagation.textContent = p.visibilityUpperBoundMs === null
    ? ""
    : t("set.propagation", { bound: fmtDuration(p.visibilityUpperBoundMs) });
  nodes.propagation.style.display = p.visibilityUpperBoundMs === null ? "none" : "";

  const degraded = data !== null && data.configDegraded === true;
  nodes.degraded.style.display = degraded ? "" : "none";
}

/** 把上一次保存留下的高亮与错误全部清掉。**每次保存前都要清**，否则会越积越多。 */
function clearMarks() {
  for (const path of Object.keys(nodes.fields)) {
    nodes.fields[path].wrap.classList.remove("changed");
    nodes.fields[path].wrap.classList.remove("invalid");
  }
  nodes.errors.textContent = "";
  nodes.errors.style.display = "none";
  nodes.readback.textContent = "";
  nodes.readback.style.display = "none";
}

function showErrors(rows) {
  nodes.errors.textContent = "";
  for (const r of rows) {
    const line = el("p");
    const label = nodes.fields[r.field] === undefined ? r.field : t(fieldLabelKey(r.field));
    // 表外的码**原样显示出来**，不冒充任何一档已知原因。
    const text = r.key === null ? t("set.err.unknown", { code: r.code }) : t(r.key, r.params);
    line.textContent = `${label}: ${text}`;
    nodes.errors.appendChild(line);
    if (nodes.fields[r.field] !== undefined) nodes.fields[r.field].wrap.classList.add("invalid");
  }
  nodes.errors.style.display = rows.length === 0 ? "none" : "";
}

// ───────────────────────────────────────────────────────────────────────────
// 保存
// ───────────────────────────────────────────────────────────────────────────

/** 把当前表单读成 `{ 路径: 值 }`。下拉与开关也在这里归一。 */
function readForm() {
  const raw = {};
  for (const path of Object.keys(nodes.fields)) {
    const f = nodes.fields[path];
    if (f.input.disabled) continue;
    raw[path] = f.input.getAttribute("type") === "checkbox" ? f.input.checked === true : f.input.value;
  }
  return raw;
}

/**
 * 保存。**这个函数的顺序就是设计 §5.3 那条产品不变式本身。**
 *
 * ⚠️⚠️ **`await api.put(...)` 之前不许出现任何成功迹象。**
 * 后端那一半是「响应体里没有任何一个『成功了』字段，只有回读出来的 `fields`」，
 * 前端这一半就是这个 `await` 的位置。挪到它前面 ⇒
 * `tests/ui/dom/settings-save.test.ts` 的
 * 「回读还没落定之前，界面上不许出现任何成功迹象」变红。
 */
async function save() {
  clearMarks();
  const raw = readForm();

  // 前端只做四条最轻量的即时提示（设计 §10.4），其余全靠渲染后端错误码。
  const local = localErrors(raw, data);
  if (local.length > 0) {
    showErrors(local.map((e) => ({ field: e.field, code: e.code, key: `set.err.${e.code}`, params: {} })));
    return;
  }

  const patch = buildPatch(raw, data);
  if (Object.keys(patch).length === 0) {
    // **不是成功，也不是失败**：一次「什么都没改」的保存要如实说出来，
    // 弹一句「已保存」是这个面板最不该说的那句话。
    toast(t("set.nothingToSave"), "warn");
    return;
  }

  nodes.save.disabled = true;
  try {
    // ★★ 这一行之前，界面上不许有任何「保存成功」的迹象。
    const res = await api.put("/config", { patch });
    // ★★ 回读落定了，从这里开始才允许说话——而且**说的是回读结果本身**：
    // 设计 §5.3 明令不弹「已保存并生效」，改成把变化的字段高亮 + 显示生效值。
    data = res;
    render();
    const changed = changedFields(res);
    const secrets = changedSecrets(res);
    for (const path of changed) {
      if (nodes.fields[path] !== undefined) nodes.fields[path].wrap.classList.add("changed");
    }
    for (const path of secrets) {
      if (nodes.fields[path] !== undefined) nodes.fields[path].wrap.classList.add("changed");
    }
    nodes.readback.textContent = changed.length === 0 && secrets.length === 0
      ? t("set.readback.none")
      : t("set.readback", { count: String(changed.length + secrets.length) });
    nodes.readback.style.display = "";
  } catch (e) {
    const rows = errorRows(e && e.body);
    if (rows.length > 0) showErrors(rows);
    else toast(t("set.saveFailed"), "warn", { sticky: true });
  } finally {
    nodes.save.disabled = false;
  }
}

/**
 * `agnesPlatformUrl` 的二次确认（设计 §8.6 第二行）。
 *
 * **它是注册凭据的去向**：改成自己的服务器就能收走每次注册的邮箱 + 密码 + 验证码。
 * 所以它折在「高级」折叠区里，改动它要单独确认一次——与主表单那颗保存按钮分开，
 * 免得一次普通的「调个超时」顺手把它一起改了。
 */
function confirmAdvanced() {
  const body = el("div");
  body.appendChild(elI18n("p", "set.advanced.warn", { class: "danger-text" }));
  openModal("set.advanced.confirmTitle", body, [
    { labelKey: "common.cancel" },
    { labelKey: "common.confirm", danger: true, onClick: () => { save(); } },
  ]);
}

/** 清空一把凭据的二次确认（设计 §8.6：清空只能走显式动作）。 */
function confirmClear(path) {
  const body = el("div");
  body.appendChild(el("p", null, t("set.clear.warn", { field: t(fieldLabelKey(path)) })));
  // **按状态分岔的那一句**，取值决策全在 `clearWarning()` 里（含红不红）。
  // 同一句通用红字在这几种状态下有的是救命、有的是吓人，而面板手上有分辨它们的数据。
  const effect = clearWarning(data, path);
  body.appendChild(elI18n("p", effect.key, { class: effect.kind === "danger" ? "danger-text" : "muted note" }));
  openModal("set.clear.title", body, [
    { labelKey: "common.cancel" },
    { labelKey: "common.confirm", danger: true, onClick: () => { doClear(path); } },
  ]);
}

async function doClear(path) {
  try {
    const res = await api.post("/config/secrets/clear", { path });
    const view = clearResultView(res);
    // **回读之后**才刷界面（与 `save()` 同一条纪律）。
    if (view.gatewayTokenMissing === true) {
      // 这一支后端**没有回读**（那一刻装载一定抛），所以只报警、不拿它盖掉当前视图。
      toast(t("set.clear.gatewayMissing"), "warn", { sticky: true });
      load();
      return;
    }
    data = res;
    render();
    toast(t("set.clear.done", { field: t(fieldLabelKey(path)) }), "ok");
  } catch (e) {
    toast(t("set.saveFailed"), "warn", { sticky: true });
  }
}

async function load() {
  if (abort) abort.abort();
  abort = new AbortController();
  try {
    data = await api.get("/config", { signal: abort.signal });
  } catch (e) {
    if (e && e.name === "AbortError") return;
    // **不伪造上一次的数据**：读失败就清空，不留着旧值假装它是新的。
    data = null;
  }
  if (nodes !== null) render();
}

export const settingsSection = {
  init(section) {
    section.textContent = "";
    section.appendChild(elI18n("h2", "set.title"));
    nodes = { fields: {} };

    const bar = el("div", { class: "toolbar" });
    const refresh = elI18n("button", "common.refresh", { type: "button" });
    refresh.addEventListener("click", () => { load(); });
    bar.appendChild(refresh);
    const save0 = elI18n("button", "set.save", { type: "button", class: "cfg-save" });
    save0.addEventListener("click", () => { save(); });
    bar.appendChild(save0);
    nodes.save = save0;
    section.appendChild(bar);

    const degraded = elI18n("p", "set.degraded", { class: "danger-text" });
    degraded.style.display = "none";
    section.appendChild(degraded);
    nodes.degraded = degraded;

    // ── 卡 1：认证密钥 ──────────────────────────────────────────────────────
    const auth = card("set.card.auth");
    for (const path of CARD_AUTH) addField(auth.body, path, "secret");
    // 管理员口令**只读展示**（设计 §8.1 规则 2 / §10.4 卡 1）：它只从环境变量来，
    // 面板不该能改自己的钥匙，所以这里连输入框都不给。
    auth.body.appendChild(elI18n("p", "set.adminTokenNote", { class: "muted note" }));
    section.appendChild(auth.wrap);

    // ── 卡 2：上游与冷却 ────────────────────────────────────────────────────
    const upstream = card("set.card.upstream");
    for (const path of CARD_UPSTREAM) addField(upstream.body, path, "text");
    section.appendChild(upstream.wrap);

    // ── 卡 3：注册机（两张平级子卡 + 高级折叠区）──────────────────────────────
    const reg = card("set.card.registrar");
    for (const path of CARD_REGISTRAR) {
      const kind = path === "registrar.enabled"
        ? "toggle"
        : ((path === "registrar.primary" || path === "registrar.fallback") ? "select" : "text");
      addField(reg.body, path, kind);
    }

    reg.body.appendChild(elI18n("p", "reg.emptyPrimary", { class: "muted note" }));
    const channelRow = el("div", { class: "card-row" });
    // **顺序取自 `CHANNELS`**（字母序），两张子卡由同一段代码建出来 ⇒
    // 「完全对称」在结构上就是不可表达的例外（设计 §10.3 第 2 条）。
    for (const channel of CHANNELS) {
      const sub = el("div", { class: "card channel-card", "data-channel": channel });
      sub.appendChild(elI18n("div", channelLabelKey(channel), { class: "label channel-name" }));
      for (const path of channelFields(channel)) {
        addField(sub, path, isSecretPath(path) ? "secret" : "text");
      }
      // 两条通道之间**唯一**的不对称，且它是同一个字段位置上的两句事实。
      sub.appendChild(elI18n("p", channelAddressFactKey(channel), { class: "muted note" }));
      channelRow.appendChild(sub);
    }
    reg.body.appendChild(channelRow);

    // 高级折叠区：`agnesPlatformUrl` 单独放这里 + 红色警告 + 自己的二次确认按钮。
    const advanced = el("details", { class: "cfg-advanced" });
    advanced.appendChild(elI18n("summary", "set.advanced.title"));
    advanced.appendChild(elI18n("p", "set.advanced.warn", { class: "danger-text" }));
    for (const path of ADVANCED_FIELDS) addField(advanced, path, "text");
    const advSave = elI18n("button", "set.advanced.save", { type: "button", class: "cfg-advanced-save danger" });
    advSave.addEventListener("click", () => { confirmAdvanced(); });
    advanced.appendChild(advSave);
    reg.body.appendChild(advanced);
    section.appendChild(reg.wrap);

    const errors = el("div", { class: "cfg-errors danger-text" });
    errors.style.display = "none";
    section.appendChild(errors);
    nodes.errors = errors;

    const readback = el("p", { class: "muted note cfg-readback" });
    readback.style.display = "none";
    section.appendChild(readback);
    nodes.readback = readback;

    const propagation = el("p", { class: "muted note" });
    section.appendChild(propagation);
    nodes.propagation = propagation;
  },

  onShow() {
    load();
  },

  onHide() {
    // **作废在飞请求**：不作废的话切回来时旧响应可能盖掉新数据（板块契约 §9.3）。
    if (abort) { abort.abort(); abort = null; }
  },
};

/**
 * 这条路径是不是凭据。
 *
 * ⚠️ **`init()` 跑在第一次 `load()` 之前，那时 `data` 还是 `null`**，
 * `isSecret(data, path)` 一律回 `false` ⇒ 两条通道的 `apiKey` 会被建成明文文本框。
 * 所以建控件这一步用路径形状判，**而运行期的那份判据仍然走后端给的 `secrets` 清单**
 *（`buildPatch` / `renderOne` 都走 `isSecret`）。两处判据不一致时以后端那份为准，
 * 这里只影响「这个框是不是 password 类型」。
 */
function isSecretPath(path) {
  return path.endsWith(".apiKey") || path === "gatewayToken";
}
