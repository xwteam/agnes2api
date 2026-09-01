/**
 * 设置页：认证密钥 / 上游与冷却 / 注册机（设计 §10.4 的前三张卡）
 * + 集成示例 + 危险区（设计里不带编号的那一节
 * 「重置到底重置了什么」）。**卡数是五份 ADMIN.md 设置卡那张表的行数真源**，
 * 由 `tests/unit/docs-parity.test.ts` 的
 * 「五份 ADMIN.md 里五张表的行数，逐张等于屏幕那边对应的那个计数」钉着。
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
import { el, elI18n, toast, openModal, copy } from "./ui.js";
import { fmtDuration } from "./pure/format.mjs";
// 第 4 张卡（集成示例）。**模型清单直接复用模型板块那份窄化**，不在 examples.mjs 里
// 再写一遍——同一份响应的同一个字段，两份窄化就是两份会分叉的判据。
import { catalogModels } from "./pure/models.mjs";
import {
  EXAMPLE_LANGS, KEY_PLACEHOLDER, exampleProtocols, allExamples, langLabel,
} from "./pure/examples.mjs";
// **顺序的唯一真源在 `registrar.mjs`**，本文件把它传给 `channelFields()`，
// `settings.mjs` 里不重新声明一份（见那里的说明）。
import { CHANNELS, channelLabelKey, channelAddressFactKey } from "./pure/registrar.mjs";
import {
  CARD_AUTH, CARD_UPSTREAM, CARD_REGISTRAR, ADVANCED_FIELDS,
  channelFields, fieldLabelKey, fieldView, credentialView,
  buildPatch, localErrors, changedFields, changedSecrets, propagationView,
  errorRows, clearResultView, displayValue, clearWarning, isDiagnostic, loadBlockedRows,
  isSaveReceipt, touchesLiveField, touchesBuildTimeField,
  // 第 5 张卡（危险区）。**取值决策一律在纯函数里**，见本文件纪律 ②。
  DANGER_ACTIONS, resetWarnings, poolSizeOf, purgeConfirmed, purgeResultView, isPoolSizeChanged,
} from "./pure/settings.mjs";

let nodes = null;
let abort = null;
/**
 * 运维**真的动过**的那些字段路径。
 *
 * ⚠️ **它只在「这一格没有基线可比」时才起作用**（诊断态下后端把 `fields` 整个给
 * `null`）。没有基线时「变没变」这个问题没有答案，而凭空替运维送一个值的后果
 * 是「面板做了他没要求的事，然后显示成功」——见 `buildPatch` 里那段 ⚠️⚠️。
 * 每次重新渲染都清空：渲染之后表单里的值就是服务端的当前状态，谈不上「动过」。
 */
let touched = new Set();
/** 最近一次成功的 `GET /admin/api/config` 响应；`null` = 还没有过一次成功。 */
let data = null;

// ───────────────────────────────────────────────────────────────────────────
// 第 4 张卡：集成示例（设计 §10.4）的那几格状态
// ───────────────────────────────────────────────────────────────────────────

/**
 * 窄化之后的协议目录（`{ protocols, models }`）。`null` = 还没读到 / 读不出来。
 * **成功读到一次就不再读**：这份目录是静态的（`src/core/admin/protocol-catalog.ts`
 * 全部是模块级常量），重读一遍只会换来一次「这次可能失败」的机会。
 */
let exCatalog = null;
/**
 * 这一刻有没有一条目录读在飞。
 *
 * ⚠️ **它不是可有可无的**：`onShow()` 是隐式入口，读还没回来时切走再切回来，
 * `exCatalog` 仍是 `null` ⇒ 没有这条早退就会发出第二条链，而**一条晚到的失败会把
 * 已经画好的示例卡抹掉**（`admin-ui/js/sec-models.js` 的文件头记着这个缺陷的实测过程，
 * 那里两条链并存的后果是 `rowsAfterLateFailure=0`）。
 */
let exInFlight = false;
/** 当前选中的协议 id；空串 = 还没选过，渲染时落到真源给的第一条。 */
let exProto = "";
/** 当前选中的语言。**默认取 `EXAMPLE_LANGS` 的第一档，不写第二份字面量。** */
let exLang = EXAMPLE_LANGS[0];
/**
 * 示例里的 base URL。
 *
 * ⚠️⚠️ **它是运行期读来的，一个字面量都不许写死**（全局约束 4 / 11）：面板部署在哪个
 * 域名下，示例里的地址就该是哪个。**这一行必须留在板块文件里**——`js/pure/` 下禁止
 * 出现浏览器那两个顶层全局（`scripts/build-ui.mjs` 的三条静态校验，含注释里的字样），
 * 所以纯函数只收一个 `origin` 参数，读它是板块文件的活。
 */
let exOrigin = "";

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
  // **两种事件都收**：文本框走 `input`，下拉与开关走 `change`。
  // 漏掉任一种，那一类控件在诊断态下就再也提交不上去（那条发现的反面）。
  for (const type of ["input", "change"]) {
    built.input.addEventListener(type, () => { touched.add(path); });
  }
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
    // 锁定的凭据框不许可编辑（评审发现）。**由这里显式决定**，见 `setLock` 上面那段。
    built.input.disabled = v.locked === true;
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
    // ⚠️⚠️ **诊断态下**（存储里那份配置装载不起来）**不许把输入框置灰**：
    // 那会把「关掉注册机 / 把那把 key 填回去」这两条自救路径在 UI 上堵死，
    // 而后端明明放行。只有「这一格单独没读到」才置灰——那时改它也没有意义。
    //
    // ⚠️ **史实订正（复评发现）**：改动前这一行写的是 `disabled = true`，
    // 但下面那句 `setLock(built, false, null)` 会把它抹回 `false`（那行已删，
    // 见 `setLock` 上面那段）⇒ **诊断态从来没被置灰过**，真正没生效的是
    // 「单独一格没读到」那一半。这一行是让两种状态**第一次分得开**，
    // 不是在修一个「被置灰」的缺陷。
    built.input.disabled = !isDiagnostic(data);
    setLock(built, false, null);
    return;
  }
  built.meta.textContent = t("set.meta.quad", {
    stored: displayValue(v.stored),
    env: displayValue(v.env),
    effective: displayValue(v.effective),
  });
  // 被 env 锁定的字段置灰（评审发现）。**由这里显式决定**，见 `setLock` 上面那段。
  built.input.disabled = v.locked === true;
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
  // ⚠️⚠️ **这个函数不再碰 `disabled`，那一行是死代码，而且它杀过别人。**
  //
  // 原来这里写着 `built.input.disabled = locked === true;`，而它**紧跟在调用方
  // 刚设好的 `disabled` 之后执行** ⇒ 把调用方的决定整个覆盖掉。后果具体：
  // 「这一格没读到」那一支里的 `built.input.disabled = true` **从落地那天起就没
  // 生效过**（`setLock(built, false, null)` 立刻把它抹回 `false`）。
  // 这条是本任务补「诊断态下表单必须还能用」的对照用例时挖出来的——
  // 一个**看起来在生效、实际从来没生效**的赋值。
  // ⇒ `disabled` 由**调用方**显式决定（三处各有各的判据），这里只管锁的视觉与说明。
  built.lock.style.display = locked === true ? "" : "none";
  built.lock.textContent = locked === true
    ? t("set.lockedBy", { env: String(lockedBy || "").replace(/^env:/, "") })
    : "";
  built.wrap.classList.toggle("locked", locked === true);
}

function render() {
  // 渲染之后表单里的值就是服务端的当前状态，之前那些「动过」的痕迹全部作废。
  touched = new Set();
  for (const path of Object.keys(nodes.fields)) renderOne(nodes.fields[path]);

  const p = propagationView(data);
  // ── 传播说明：两句话，各自有各自的前提───────────────────────────────────────
  //
  // `set.propagation` 逐字说的是「**本实例已经生效**；别的副本最长 {bound} 之后才看得到」，
  // 而 `BUILD_TIME_FIELDS` 那两格是建实例时读一次的（`src/http/wire.ts`）⇒
  // 只改那两格时这句话是**当面说反话**：本实例没生效，而且等多久都没用。
  // ⚠️ **判据从 `BUILD_TIME_FIELDS` 派生**，这里不许写 `if (path === "poolCacheTtlMs" || …)`。
  // ⚠️ **两句不是互斥的**：混合保存时两句都要出现，见 `touchesLiveField()` 上面那段。
  //
  // `saved === null` = 这份数据不是保存回执（只是读了一次 / 清空凭据回来的）⇒
  // 那时 `set.propagation` 讲的是**这个部署的传播上界**这件事实本身，照旧渲染；
  // 而「这次改动」那句回执**一个字都不说**（无中生有的回执与假回执一样坏）。
  const saved = isSaveReceipt(data) ? changedFields(data).concat(changedSecrets(data)) : null;

  // ⚠️⚠️ **回到读取态时，上一次保存的回读行与各格高亮必须一起作废**（复评发现）。
  //
  // 复评实测出来的形状：保存了一个旋钮（屏幕上正确地说「本实例也还没生效」）之后，
  // 运维**点一下这个面板自己的「刷新」**去看生效没有 ⇒ `load()` 拿回一份 GET（没有
  // `changed`）⇒ `saved === null` ⇒ 上面那句 buildTime 藏起来、`set.propagation` 回来。
  // 光是这一句本身讲的是这个部署的传播上界（读取态照旧要显示，见下），**但它不是一个人
  // 站在那里**：`nodes.readback` 还挂着「已回读生效值，1 个字段发生了变化（已高亮）」、
  // 那一格还带着 `.changed` —— 三个信号一起指向刚才那次保存，运维读到的就是
  // 「你刚改的那格本实例已经生效」，而那是假的。早先那次「屏幕上编出一个状态码」是同一个形状。
  // 切板块回来、切语言（`admin-ui/js/app.js` 的 `langchange` 兜底）走的都是同一个 `load()`。
  //
  // ⚠️ **修的是放大器，不是那句话本身**：`set.propagation` 的措辞是早先论证出来的、
  // 五语言 DEPLOY.md 对用户的承诺，本任务不许改（读取态下它必须在，由
  // `tests/ui/dom/settings-save.test.ts`
  // 「④ 只是读了一次配置（还没保存过）：重启那句不出现，传播上界照常在」钉着；
  // 本段这条清理由同文件「⑤ 保存旋钮之后回到读取态：回读行与高亮一并作废」钉着）。
  //
  // ⚠️ **边界：这里只清这两样。** 错误行（`nodes.errors`）与 `.invalid` 归 `clearMarks()`
  // 管（每次保存前清），读取态不动它们——那是**上一次保存失败**留下的东西，与这句
  // 传播说明不发生任何组合，扩到这里就是一次没被评审过的行为改动。这条边界如实登记在
  // 遗留待办里，别把它读成「读取态会把屏幕清干净」。
  if (saved === null) clearReadback();

  // ⚠️⚠️ **危险区那一行回执同样必须在这里作废**（复评回填）。
  //
  // 它与上面那段是**同一个形状的第二例**，而它逃过了上面那段：上面清的是
  // `nodes.readback`，判据是「这份数据是不是保存回执」；危险区那一行由 `doReset()` /
  // `doPurge()` 直接写 `textContent`，`render()` 与 `load()` 从前一个字都不碰它。
  // 复评实测：清空 7 把 key 成功之后，点面板自己的「刷新」、切板块再切回来、
  // 甚至**把语言切成 en**，屏幕上一直挂着那句中文「已删掉 7 把 key；回读之后池子是空的。」
  // ——它描述的是一次早已过去的操作，而且 `t()` 出来的文本框架层
  // `apply(document)` 刷不动（本文件末尾 `set.propagation.buildTime` 那段注释写着这条陷阱）。
  //
  // ⚠️ **`doReset()` 在 `render()` 之后才写这一行**，所以这里无条件清不会把它自己刚说的话清掉；
  // `doPurge()` 根本不调 `render()`，它那一行由下一次 `render()` / `clearMarks()` 清。
  clearDangerResult();

  const showLive = p.visibilityUpperBoundMs !== null && (saved === null || touchesLiveField(saved));
  nodes.propagation.textContent = showLive
    ? t("set.propagation", { bound: fmtDuration(p.visibilityUpperBoundMs) })
    : "";
  nodes.propagation.style.display = showLive ? "" : "none";
  nodes.propagationBuildTime.style.display = saved !== null && touchesBuildTimeField(saved) ? "" : "none";

  const degraded = data !== null && data.configDegraded === true;
  nodes.degraded.style.display = degraded ? "" : "none";

  // 装载不起来时：一条横幅 + 逐条列出缺什么。**表单仍然可编辑**（见 renderOne）。
  const blocked = loadBlockedRows(data);
  nodes.blocked.textContent = "";
  nodes.blocked.style.display = blocked.length === 0 ? "none" : "";
  if (blocked.length > 0) {
    nodes.blocked.appendChild(elI18n("p", "set.loadBlocked"));
    for (const r of blocked) {
      const label = nodes.fields[r.field] === undefined ? r.field : t(fieldLabelKey(r.field));
      // 表外的码**原样显示出来**，不冒充任何一档已知原因。
      const text = r.key === null ? t("set.err.unknown", { code: r.code }) : t(r.key, r.params);
      nodes.blocked.appendChild(el("p", null, `${label}: ${text}`));
      if (nodes.fields[r.field] !== undefined) nodes.fields[r.field].wrap.classList.add("invalid");
    }
  }
}

/**
 * 第 4 张卡的卡内内容，整块重画。
 *
 * ── **本函数里没有任何一条端点路径、请求体形状或协议名** ──────────────────────
 * 核心设计决定（全局约束 15）：四个消费者只许有一份「怎么调这个网关」的知识。
 * 协议 id 与展示名、方法、路径模板、鉴权头、最小请求体全部来自
 * `GET /admin/api/models` 的响应，拼代码那一步在 `admin-ui/js/pure/examples.mjs` 里；
 * 这里只负责选哪一档、把它画出来。
 * ⚠️ `api.get("/models")` 这条 **admin** 路径不算第二份端点知识，边界与
 * `admin-ui/js/sec-models.js` 文件头「`api.get("/models")` 这条 admin 路径为什么不算
 * 第二份端点知识」那一段逐字相同。
 *
 * ⚠️ **代码块一律 `textContent`**：示例里全是引号与花括号，而 CSP 的 `script-src 'self'`
 * 要求零内联脚本（`src/ui/serve.ts`）。`el()` 走的就是 `textContent`。
 *
 * ⚠️ **「一条协议都没有」在这张卡上折进「读不出来」那一档，这是明写的取舍**：
 * 真源里那份协议清单是模块级常量、今天恒有四条，响应里它变成空数组只可能意味着
 * 这份响应被改过——那正是「读不出来」本身。别把这条推广到别的板块（模型板块的
 * 「一个模型都没有」是真会发生的一档，它在那里单独有话说）。
 */
function renderExamples() {
  const host = nodes.examples;
  host.textContent = "";
  if (exCatalog === null || exCatalog.protocols.length === 0) {
    host.appendChild(elI18n("p", "set.examples.unavailable", { class: "danger-text" }));
    return;
  }
  // 占位口令的取值来自纯函数模块，**不在文案里再抄一份**。
  host.appendChild(el("p", { class: "muted note" }, t("set.examples.desc", { key: KEY_PLACEHOLDER })));

  const rows = allExamples(exCatalog.protocols, exCatalog.models, exOrigin);
  // 选中的协议不在这份目录里（第一次渲染，或目录变了）⇒ 落到真源给的第一条。
  // **顺序照响应给的顺序，不在这里重排**——重排就是又一份知识。
  if (!rows.some((r) => r.protocol === exProto)) exProto = exCatalog.protocols[0].id;

  const protoBar = el("div", { class: "btn-group examples-bar" });
  protoBar.appendChild(elI18n("span", "set.examples.proto", { class: "muted" }));
  for (const p of exCatalog.protocols) {
    // 展示名走响应里的 `label`（协议的专名，刻意不进 i18n）。三条都不许走：
    // 本地再写一张映射、把 id 拼进一个 i18n key、直接渲染裸 id。
    // `aria-pressed` 与 `.active` 同生同死（`.active` 只改颜色 + 一条加粗，读屏拿不到）。
    const btn = el("button", {
      type: "button", class: "btn-toggle", "data-ex-protocol": p.id,
      "aria-pressed": exProto === p.id ? "true" : "false",
    }, p.label);
    btn.classList.toggle("active", exProto === p.id);
    btn.addEventListener("click", () => { if (exProto !== p.id) { exProto = p.id; renderExamples(); } });
    protoBar.appendChild(btn);
  }
  host.appendChild(protoBar);

  const langBar = el("div", { class: "btn-group examples-bar" });
  langBar.appendChild(elI18n("span", "set.examples.lang", { class: "muted" }));
  for (const lang of EXAMPLE_LANGS) {
    // 表外的语言**照实显示原值**，不冒充任何一档已知语言（`langLabel()` fail-open）。
    const label = langLabel(lang);
    const btn = el("button", {
      type: "button", class: "btn-toggle", "data-ex-lang": lang,
      "aria-pressed": exLang === lang ? "true" : "false",
    }, label === null ? lang : label);
    btn.classList.toggle("active", exLang === lang);
    btn.addEventListener("click", () => { if (exLang !== lang) { exLang = lang; renderExamples(); } });
    langBar.appendChild(btn);
  }
  host.appendChild(langBar);

  const row = rows.find((r) => r.protocol === exProto && r.lang === exLang);
  // ⚠️ **`code === null` 绝不能退化成「照拼一段」**：那一档的意思是「这条协议的路径要一个
  //    模型，而目录里没有任何模型支持它」，硬拼出来的是一条长得像真的、按着抄一定打不通的
  //    地址。如实说这里没有示例。
  if (row === undefined || row.code === null) {
    host.appendChild(elI18n("p", "set.examples.noModel", { class: "muted note" }));
    return;
  }
  host.appendChild(el("pre", { class: "mono examples-code" }, row.code));
  const copyBtn = elI18n("button", "common.copy", { type: "button", class: "examples-copy" });
  copyBtn.addEventListener("click", () => { copy(row.code); });
  host.appendChild(copyBtn);
}

/**
 * 拉一次协议目录。**零存储读**（`src/http/admin/handlers/models.ts` 全部来自模块级常量），
 * 所以它不进配额账，也不违反本板块「没有自动刷新」那条纪律。
 *
 * ⚠️ **两个不同的失败落到同一档**：HTTP 失败（`api.get` 抛）与「读得回来但形状不对」
 * （窄化交出 `null`）在卡上都是「读不出来」。少了后一半的话，一份被中间件改过形状的响应
 * 会让这张卡画出一段**结构自洽而内容缺斤少两**的示例——而运维会照着它抄。
 *
 * ⚠️ **没有「再读一次」按钮，这是刻意的**：`exCatalog` 为 `null` 时每一次 `onShow()`
 * 都会重来一遍，切走再切回来就是重试入口。代价如实写：**停在设置页不动的话，这张卡
 * 不会自己好起来**。
 */
async function loadCatalog() {
  if (exCatalog !== null) { renderExamples(); return; }
  if (exInFlight) return;
  exInFlight = true;
  try {
    const body = await api.get("/models");
    const protocols = exampleProtocols(body);
    const models = catalogModels(body);
    exCatalog = protocols === null || models === null ? null : { protocols, models };
  } catch (e) {
    exCatalog = null;
  } finally {
    exInFlight = false;
  }
  // ⚠️ **这里不判 `nodes !== null`，上面那条早退也不判——两条路径对同一个不变量
  //    必须给出同一个表态**（评审 F-10：上一版一条判一条不判，
  //    而「一处判空」会被下一个人读成「这里真的可能是 null」）。
  //    不变量与它的出处：`loadCatalog()` 只有 `onShow()` 一个调用方，而
  //    `admin-ui/js/app.js` 的 `showSection` 是**先 init 再 onShow**
  //    （`if (!s.__inited) { s.init(...); s.__inited = true; } s.onShow && s.onShow();`），
  //    而 `nodes = { fields: {} }` 是本板块 `init()` 里**紧跟在标题那两行之后**就执行的，
  //    此后再没有任何地方把它写回 null。
  //    ⚠️ 上一版这里写的是「`init()` 第一行」——不确切（前面还有清空 section 与加标题两行）。
  //    一句不确切的位置描述会让下一个人去那一行找、找不到、然后不再信这一整段。
  renderExamples();
}

/**
 * 上一次保存留下的**回读行与各格高亮**一并作废。
 *
 * ⚠️ **抽成函数是因为它有三个调用点**（`render()` 的读取态那一支、`clearMarks()`、
 * `doReset()`），而抄三份的话迟早有一份忘了清其中一样——复评那次
 * 「三个信号一起指向一次没有发生的变化」就是漏清其中一样的后果。
 */
function clearReadback() {
  nodes.readback.textContent = "";
  nodes.readback.style.display = "none";
  for (const path of Object.keys(nodes.fields)) nodes.fields[path].wrap.classList.remove("changed");
}

/**
 * 危险区那一行回执作废。**一次早已过去的操作不许挂在屏幕上**，理由见 `render()` 里那段。
 */
function clearDangerResult() {
  nodes.dangerResult.textContent = "";
  nodes.dangerResult.style.display = "none";
}

/** 把上一次保存留下的高亮与错误全部清掉。**每次保存前都要清**，否则会越积越多。 */
function clearMarks() {
  for (const path of Object.keys(nodes.fields)) {
    nodes.fields[path].wrap.classList.remove("invalid");
  }
  nodes.errors.textContent = "";
  nodes.errors.style.display = "none";
  // ⚠️ **不清 `nodes.blocked`**：它讲的是「存储里那份配置现在装不装得起来」这个
  // **当前状态**，不是上一次保存留下的痕迹；由 `render()` 按最新响应重算。
  clearReadback();
  // ⚠️ **保存失败那一支不走 `render()`**（`save()` 的 `catch` 里只画错误行），
  // 所以危险区那一行必须在这里也清一次，否则一次失败的保存之后它还挂着。
  clearDangerResult();
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

  const patch = buildPatch(raw, data, touched);
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
      toast(t("set.clear.gatewayMissing"), "warn", { sticky: true });
      load();
      return;
    }
    if (isDiagnostic(res)) {
      // 清完之后这份配置装载不起来了：**如实显示诊断视图**（横幅 + 逐条缺什么），
      // 表单仍然可编辑，运维就地改完保存即可恢复。
      data = res;
      render();
      return;
    }
    data = res;
    render();
    toast(t("set.clear.done", { field: t(fieldLabelKey(path)) }), "ok");
  } catch (e) {
    toast(t("set.saveFailed"), "warn", { sticky: true });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 卡 5：危险区
// ───────────────────────────────────────────────────────────────────────────

/**
 * 「重置配置」的二次确认。
 *
 * ⚠️ **弹窗里那几句「重置之后会缺什么」全部来自后端的 `resetBlocked`**
 *（`configLoadBlockers({}, env)`），面板一个优先级判断都不做——设计小节明令
 * 复用「清空凭据」已经在用的那两条文案，不许另写第三句。取值决策在
 * `resetWarnings()` 里，含红不红。
 */
function confirmReset() {
  const body = el("div");
  body.appendChild(elI18n("p", "set.danger.reset.warn", { class: "danger-text" }));
  body.appendChild(elI18n("p", "set.danger.reset.scope", { class: "muted note" }));
  for (const w of resetWarnings(data)) {
    // 表外的码**原样显示出来**，不冒充任何一档已知原因（与 `showErrors()` 同源）。
    const text = w.key === null ? t("set.err.unknown", { code: w.code }) : t(w.key, w.params);
    body.appendChild(el("p", { class: w.kind === "danger" ? "danger-text" : "muted note" }, text));
  }
  const p = propagationView(data);
  if (p.visibilityUpperBoundMs !== null) {
    // **必须显示，不许写「立即生效」**（设计 §5.2）：本进程确实立刻生效，
    // 别的副本要等 `CONFIG_TTL_MS` + KV 边缘缓存。
    body.appendChild(el("p", { class: "muted note" },
      t("set.danger.reset.propagation", { bound: fmtDuration(p.visibilityUpperBoundMs) })));
  } else {
    // ⚠️ **上界读不出来时这句话不许整条消失**（复评回填）：上一版这里没有 else，
    // 于是 `GET /admin/api/config` 失败之后弹窗里**一个字都不提传播**——
    // 而设计 §5.2 要求的是「必须显示，不许写立即生效」，「不显示」不是它的一档。
    // 读不到的只是那个数，「别的副本不会在这一刻看到」这件事照旧成立。
    body.appendChild(elI18n("p", "set.danger.reset.propagation.unknown", { class: "muted note" }));
  }
  openModal("set.danger.reset.confirmTitle", body, [
    { labelKey: "common.cancel" },
    { labelKey: "common.confirm", danger: true, onClick: () => { doReset(); } },
  ]);
}

async function doReset() {
  try {
    const res = await api.post("/config/reset", { confirm: true });
    // **回读之后**才刷界面（与 `save()` / `doClear()` 同一条纪律）：`res` 就是
    // 后端回读出来的新状态本身。
    data = res;
    // ⚠️⚠️ **上一次保存留下的回读行与高亮必须在这里显式作废**（复评回填）。
    //
    // `render()` 里那段清理的判据是 `isSaveReceipt()`，而它认的是「`changed` 这一格在不在」
    // ——**重置回执里也有 `changed`**（`src/http/admin/handlers/config.ts` 的
    // `configResetHandler` 逐字如此）⇒ `saved !== null` ⇒ 那段清理**恒不跑**。
    // 复评实测：先改一格保存（回读行说「1 个字段发生了变化（已高亮）」、maxStrikes 带
    // `.changed`），再点重置、回执 `changed: []` ⇒ 回读行与高亮**原样留着**，
    // 而那个 `1` 来自上一次保存 —— 与上面那条复评发现逐字同形。
    // ⚠️ **不改 `isSaveReceipt()` 去把重置排除掉**：那条判据「跟着数据走、不跟着时间走」
    // 是它存在的全部理由，而重置回执确实是一次写回执（`changed` 那一格的语义与 `PUT` 同源）。
    // 该作废的是**上一次那件事**留下的痕迹，落点就在这里。
    clearReadback();
    render();
    const changed = changedFields(res).concat(changedSecrets(res));
    for (const path of changed) {
      if (nodes.fields[path] !== undefined) nodes.fields[path].wrap.classList.add("changed");
    }
    // ⚠️ **按 `changed` 分岔**（复评回填）：重置对一部分字段**什么都没做**
    //（存储里本来就没有值、或者被环境变量锁着，而那正是五份 ADMIN.md 反复强调的那一句），
    // 那一档一格都没高亮，说「已经高亮出来」就是当面说反话。
    // 两档的形状照 `save()` 里 `set.readback` / `set.readback.none` 那一对。
    nodes.dangerResult.textContent = changed.length === 0
      ? t("set.danger.reset.doneNone")
      : t("set.danger.reset.done", { count: String(changed.length) });
    nodes.dangerResult.style.display = "";
  } catch (e) {
    toast(t("set.danger.failed"), "warn", { sticky: true });
  }
}

/**
 * 「清空 Key 池」的二次确认。
 *
 * ⚠️⚠️ **确认框要求把当前池大小那个数字亲手打一遍**，判据在 `purgeConfirmed()` 里。
 * 这不是仪式感：这颗按钮是本系统最不可撤销的动作（key 明文只在存储里有一份，
 * 每把 key 的用量历史住在记录的值里面），而「再点一次确认」对着一个手滑的人
 * 拦不住任何东西。
 *
 * ⚠️ **池大小是点开这一刻现取的**（`GET /admin/api/keys`，走 isolate 快照：
 * **命中快照那一次零存储读**），不是常驻轮询——本板块那条「没有自动刷新」的纪律照旧。
 * ⚠️ **上一版这里写的是无条件的「零存储读」，那是假的**（复评回填）：
 * `src/core/keypool-repo.ts` 的 `all()` 第一行是
 * `if (this.cacheTtlMs <= 0) return await this.loadAll();`——而 `POOL_CACHE_TTL_MS=0`
 * 是五份 DEPLOY.md 明写的逃生口；快照过期时 `ensureFresh()` 同样真读。
 * 这条端点自己的说法（`src/http/admin/handlers/keys.ts` 文件头）是
 * 「零 `list()`、零**额外**读，与转发路径共用同一个 isolate 快照」，那句是对的。
 * **读不到就不给开确认框**：没有基线时那个数字要么是编的、要么是 0，
 * 而 0 会让人在一池 key 上确认一个「空池」。
 */
async function confirmPurge() {
  let size = null;
  try {
    size = poolSizeOf(await api.get("/keys?size=1&page=1"));
  } catch (e) {
    size = null;
  }
  if (size === null) {
    toast(t("set.danger.purge.sizeUnknown"), "warn", { sticky: true });
    return;
  }

  const body = el("div");
  body.appendChild(el("p", { class: "danger-text" }, t("set.danger.purge.warn", { count: String(size) })));
  body.appendChild(elI18n("p", "set.danger.purge.stats", { class: "danger-text" }));
  body.appendChild(elI18n("p", "set.danger.purge.propagation", { class: "muted note" }));
  body.appendChild(el("p", null, t("set.danger.purge.typeTo", { count: String(size) })));
  const input = el("input", { type: "text", inputmode: "numeric", class: "danger-confirm" });
  body.appendChild(input);
  const mismatch = elI18n("p", "set.danger.purge.mismatch", { class: "danger-text" });
  mismatch.style.display = "none";
  body.appendChild(mismatch);

  openModal("set.danger.purge.confirmTitle", body, [
    { labelKey: "common.cancel" },
    {
      labelKey: "common.confirm",
      danger: true,
      // **打错了就把弹窗留着**（`openModal` 的契约：`onClick` 返回 `false` 不关闭），
      // 而不是关掉再弹一句 toast——那样运维得重新点开、重新读那个数。
      onClick: () => {
        if (!purgeConfirmed(input.value, size)) {
          mismatch.style.display = "";
          return false;
        }
        doPurge(size);
        return true;
      },
    },
  ]);
}

async function doPurge(size) {
  try {
    const res = await api.post("/keys/purge", { expect: size });
    const view = purgeResultView(res);
    // **回执里的 `remaining` 是后端回读出来的**：非零就是「索引写空了、存储里还躺着
    // 记录」，那件事必须如实说出来，不许说成「已清空」。
    nodes.dangerResult.textContent = view.remaining !== null && view.remaining > 0
      ? t("set.danger.purge.leftover", { deleted: String(view.deleted), remaining: String(view.remaining) })
      : t("set.danger.purge.done", { deleted: String(view.deleted) });
    nodes.dangerResult.style.display = "";
  } catch (e) {
    // 「池子在你确认之前变了」是一条**运维看得懂、也做得了**的失败（去刷新一下再来），
    // 与一句笼统的「失败了」不是一回事——判据是顶层 `reason`，不解析 message 的中文。
    if (isPoolSizeChanged(e && e.body)) {
      toast(t("set.danger.purge.changed"), "warn", { sticky: true });
      return;
    }
    toast(t("set.danger.failed"), "warn", { sticky: true });
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
  // 与 `loadCatalog()` 结尾同一条裁定：**不判 `nodes !== null`。**
  // ⚠️ 上一版这里判、那边不判，而两个函数是同一个 `onShow()` 里的兄弟调用、
  //    读的是同一个变量（定向复评点出来的：上一轮只修了一半，
  //    新写的那句「一处判空会被下一个人读成这里真的可能是 null」在自己上方十行处被反证）。
  //    不变量与出处见 `loadCatalog()` 结尾那一段。
  render();
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
    // 这一句在字典里躺了整整一期没上屏，而 `pure/settings.mjs` 的注释一直声称它「就在卡 2 底下」。
    // 说的是 `poolCacheTtlMs` / `poolTouchIntervalMs` 与卡 2 里别的字段的那条真实差异：
    // 建实例时读一次，改了要重启容器 / 等 isolate 回收才生效。面板不说这句话，
    // 运维改完刷新一看没变化，得出的结论是「这个面板的保存是假的」。**写法与卡 1 对齐。**
    // 由 tests/ui/dom/settings-save.test.ts 的「卡 2 底下真的印着那句「改了要重启」」钉着。
    upstream.body.appendChild(elI18n("p", "set.card.upstreamNote", { class: "muted note" }));
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

    // ── 卡 4：集成示例（设计 §10.4 第 4 张卡）──────────────────────────────────
    // 板块文件允许碰浏览器全局，**base URL 在这里读一次再传给纯函数**——
    // `js/pure/` 下禁止出现浏览器那两个顶层全局（`scripts/build-ui.mjs` 的静态校验，
    // 含注释里的字样），所以纯函数只收一个 `origin` 参数。
    const examples = card("set.card.examples");
    exOrigin = location.origin;
    nodes.examples = examples.body;
    section.appendChild(examples.wrap);

    // ── 卡 5：危险区（设计小节「重置到底重置了什么」）────────────────────────────
    //
    // ⚠️ **这张卡一度刻意不存在**：设计里那条订正把它往后推过一期，逐字理由是
    // 「『重置』到底重置了什么本身就需要一节设计，而本文档没有这一节」——
    // **让一颗后果不可挽回的按钮先于它的语义上线，正是会变成 Critical 的形状。**
    // 那一节现在写好了，这张卡才落地。
    //
    // ⚠️ **两颗按钮从 `DANGER_ACTIONS` 派生**，不在这里写第二份清单：那张表的**条数**
    // 同时是五份 ADMIN.md 危险区那张表的行数真源，各写一份就会漂。
    const danger = card("set.card.danger");
    danger.wrap.classList.add("danger-zone");
    danger.body.appendChild(elI18n("p", "set.danger.intro", { class: "danger-text" }));
    const dangerRun = { resetConfig: confirmReset, purgeKeys: confirmPurge };
    for (const a of DANGER_ACTIONS) {
      const row = el("div", { class: "cfg-field", "data-danger": a.id });
      row.appendChild(elI18n("div", a.titleKey, { class: "label" }));
      row.appendChild(elI18n("p", a.descKey, { class: "muted note" }));
      const btn = elI18n("button", a.buttonKey, { type: "button", class: "danger" });
      btn.addEventListener("click", () => { dangerRun[a.id](); });
      row.appendChild(btn);
      danger.body.appendChild(row);
    }
    const dangerResult = el("p", { class: "muted note cfg-danger-result" });
    dangerResult.style.display = "none";
    danger.body.appendChild(dangerResult);
    nodes.dangerResult = dangerResult;
    section.appendChild(danger.wrap);

    const blocked = el("div", { class: "cfg-blocked danger-text" });
    blocked.style.display = "none";
    section.appendChild(blocked);
    nodes.blocked = blocked;

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

    // 上面那句的**例外分支**：这次保存碰到了建实例时读一次的字段。
    // ⚠️ **它是保存回执，不是又一条常驻说明**——常驻的那句在卡 2 底下
    //（`set.card.upstreamNote`，改之前就该看见）。默认藏着，由 `render()` 按
    // `touchesBuildTimeField()` 打开，见那里那一段。
    // 走 `elI18n` 而不是 `t()`：它不带占位符 ⇒ 切语言时框架层的 `apply(document)`
    // 刷得动它（`set.propagation` 带 `{bound}`，刷不动，只能等 `onShow()` 重画）。
    const propagationBuildTime = elI18n("p", "set.propagation.buildTime", { class: "muted note" });
    propagationBuildTime.style.display = "none";
    section.appendChild(propagationBuildTime);
    nodes.propagationBuildTime = propagationBuildTime;
  },

  onShow() {
    load();
    // 目录是静态的：成功读过一次之后这一步只重画（切语言时框架层会重跑 onShow，
    // 而集成示例卡那段说明带插值参数，`apply(document)` 刷不动它，必须重画）。
    loadCatalog();
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
