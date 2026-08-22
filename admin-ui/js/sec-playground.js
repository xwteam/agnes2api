/**
 * Playground 板块（设计 §10.5）：左栏配请求、右栏看对话。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * ── **本板块是「消费协议目录」这条路径的第三个前端消费者** ────────────────────
 * P3d 核心设计决定（全局约束 15）：四个消费者只许有一份「怎么调这个网关」的知识。
 * ⇒ **本文件的可执行代码里没有任何一条对外端点路径、没有任何一个协议 id、
 *    也没有任何一份请求体形状**（两条 admin 路径 `api.get("/models")` 与
 *    `api.get("/config")` 为什么不算，见下面「两条 admin 路径为什么不算第二份端点知识」）。
 * 协议档位与展示名来自响应的 `protocols[]`，模型下拉来自 `models[]`，
 * URL 与请求体由 `js/pure/playground.mjs` 拿那份响应现拼。
 *
 * ── **这是面板上第二颗「按一下就真打上游」的按钮**（全局约束 14）────────────────
 * 第一颗是 Key 池的验活（P3d Task 9）。护栏在同一个任务里一起交付：
 * · **在飞去重**：同一时刻只许一次在飞，按钮 disabled，旁边出现「取消」。
 *   ⚠️ **判据只有一份，就是 `sendBlockedKey()` 的第一档**（`pg.send.blockedInFlight`）：
 *   按钮的 `disabled` 与 `sendOnce()` 的早退**读的都是它**。
 *   ⚠️⚠️ 这一版曾经在 `sendOnce()` 开头另写过一句 `if (inFlight) return;`，
 *   **变异实测删掉它 22/22 全绿**——那是一句没有任何用例守着的冗余，
 *   而当时这一段正声称它是护栏本体。**已删，这段话已改真。**
 * · **取消令牌**：`AbortController`，点取消 / 切走板块都作废这一次。
 *
 * ⚠️⚠️ **刻意不加最小间隔闸，这条差别必须写下来**：Key 池的验活有一道 3 秒闸
 * （`js/pure/keys-write.mjs` 的 `VERIFY_MIN_INTERVAL_MS`，后端 `probe-guard.ts` 还有
 * 对称的一道）。**Playground 不加**——它是**交互式调试工具**，运维改一句提示词连发
 * 几次是正常用法，而每一次都是他自己坐在那儿等结果（有在飞去重兜着，同一时刻最多
 * 一条在飞）。照抄那道闸只会得到一个让人恼火的 3 秒禁用态。
 * **下一个人别照着 `probe-guard` 把它补上。**
 *
 * ⚠️ **「重新发送时 abort 上一次」今天没有触发路径，如实写明**：在飞去重 + 按钮
 * disabled 之后，一次在飞期间根本发不出第二条。所以作废只有**两个**入口
 * （取消按钮、`onHide()`）。写一条今天走不到的抢占分支等于摆一段死代码，
 * 而本仓在 `js/sec-models.js` 的文件头上记过「一句『今天用不上它』的话会被后来的
 * 改动推翻」——所以这里记的是相反的方向：**哪天允许在飞时再发，抢占分支要连同它的
 * 世代号一起补上**，别只把 disabled 去掉。
 *
 * ⚠️⚠️ **abort 那一半在测试里天然不可观测，写清楚**：`tests/ui/dom/harness.ts` 的
 * `fetch` 替身**零处**看 `signal` ⇒ 被 abort 的那条链在测试里照样会落地。
 * **别把那几格绿了读成「abort 被钉住了」**——它们钉的是下面那个「这一次还是不是当前
 * 那一次」的判据（`current !== ctl`），与 `js/sec-keys.js` 的验活、`js/sec-models.js`
 * 的世代号是同一条判据。真实浏览器里 abort 让那条链以 `AbortError` 拒绝，
 * 同一条判据同样把它挡在外面。
 *
 * ── **网关口令：面板永远只是它的搬运工**（全局约束 11(b)）─────────────────────
 * 口令由用户手动粘贴、存在浏览器里（`js/pure/storage-keys.mjs` 的 `GW_KEY_STORE`），
 * **后端不开任何回显口子**。本文件因此有一条硬纪律：
 * **口令的值只许出现在两个地方——那个 `<input>` 的 `.value`，和 `js/gw-api.js`
 * 拼请求头的那一行。** 不许进 `title`、不许进 `data-*`、不许进任何一句错误文案的插值、
 * 更不许进右栏的任何一格。由 `tests/ui/dom/playground-section.test.ts` 的
 * 「面板上任何一处都不出现网关口令 —— 输入框的值不许漏进标题、属性或任何一句错误文案」
 * 那一格逐个属性扫着钉住。
 * ⚠️ 口令输入框旁边那句「与设置页那把对不对得上」只画**档位名**，判定在
 * `js/pure/playground.mjs` 的 `tokenHintState()`，它按定义不返回口令的任何一个字节。
 *
 * ── 本任务只做「对话」，媒体那两档是 Task 12 ─────────────────────────────────
 * 模式分段控件**本任务就要出现**（否则 Task 12 要重排整个左栏布局），
 * 图片 / 视频两档 disabled + tooltip 说明。
 * ⚠️ **面板样式与 `src/ui/serve.ts` 的 CSP 一个字都没放宽**（全局约束 17）：
 * 那条 CSP 是 `img-src 'self' data:`、**没有 media-src**。媒体那两档将来只展示 URL +
 * 复制按钮 + 在新标签页打开，**不内嵌**；本任务连一个字节的媒体渲染代码都不写，
 * 也**不为将来「顺手」放宽任何东西**。
 *
 * ── 流式开关为什么摆在那儿却按不动 ──────────────────────────────────────────
 * 与媒体那两档同一条理由：控件本任务就位，功能排在后面的任务。
 * `buildRequest()` 的流式两条路（Gemini 换路径、其余三条换请求体字段）**已经写好并被
 * 单测钉着**，缺的只是读流那一半。**摆一个能按但什么都不会变的开关**比按不动更糟——
 * 那是面板对运维说的一句假话。
 *
 * ── 右栏为什么展示响应原文，而不是把回答抽成对话气泡 ─────────────────────────
 * 「这条协议的回答那句话在哪一格」是第四份「四条协议长什么样」的知识，而协议目录
 * 今天没有这一格（它只有 `usagePath`，那是给 Tier-2 用的）。硬写一张对照表进来，
 * 正是全局约束 15 要求先问一遍的那种事，而这里的答案是**「它可以来自目录，只是今天
 * 还没有」**。⇒ **登记 P3e**，理由全文在 `js/pure/playground.mjs` 的 `prettyJson()` 上方。
 *
 * ── 两条 admin 路径为什么不算「第二份端点知识」 ──────────────────────────────
 * 全局约束 15 管的是「怎么调**这个网关**」那张对外面（对外路径、请求体形状、鉴权头），
 * 不是「怎么够得着那份真源」。`js/sec-models.js` 与 `js/sec-usage.js` 已经写着同样的
 * `api.get("/models")`，本文件与它们同一条边界。
 * ⚠️ **但要写清代价：这两条 admin 路径今天没有任何机器在守**
 * （`tests/ui/no-hardcoded-endpoints.test.ts` 的
 * 「前端没有任何文件硬编码网关端点路径 —— 端点只许来自 /admin/api/models」
 * 那一格的正则只认对外那棵树的路径）。
 *
 * ── 三条纪律（与其余七个板块相同）────────────────────────────────────────────
 * ① 一切来自接口的内容一律 textContent（`el()` 走的就是它）：右栏画的是**上游原样
 *    回来的响应体**，那是全站最该守这条的一处；
 * ② **取值决策一律不写在这里**，全在 `js/pure/playground.mjs` 里（admin-ui/README.md 硬规则 1）；
 * ③ **一切形态分支只读接口返回的字段**，不许自己嗅探运行时（全局约束 1）。
 *
 * ⚠️ **双运行时：非流式长请求在两种形态下可能表现不同，面板不许承诺它们一样**（U-B）。
 * 已核实的官方口径：HTTP 触发的 Worker **没有**墙钟上限、单条子请求也**没有**时间上限
 * （只要客户端还连着）；而 `wrangler.toml` 里那个 15 分钟是 `scheduled()` 的数，
 * **不是 `fetch()` 的**。官方文档**没有**说 CDN 那条 125 秒回源读超时（524）适不适用于
 * Worker 自己发出的子请求 ⇒ 按「没有平台承诺」处理。五语言 DEPLOY.md 里那一段写的是
 * 同一件事，本板块的文案因此只说「这一次等了多久」，不说「多久之内一定不会被砍断」。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n } from "./ui.js";
import { readGatewayToken, writeGatewayToken, sendToGateway } from "./gw-api.js";
import { catalogModels } from "./pure/models.mjs";
import { credentialView } from "./pure/settings.mjs";
import {
  playgroundProtocols, modelIdsForProtocol, buildRequest, tokenHintState, prettyJson,
} from "./pure/playground.mjs";

let nodes = null;
/**
 * 窄化之后的目录。`null` = **还没读到 / 读不出来**，两者在渲染上是同一档
 * （都还不知道这个网关认得哪些协议），区别只在「有没有人已经发过那次请求」。
 */
let catalog = null;
/** 设置页那把网关口令的末几位。`null` = 读不到，比不了（**不等于「对不上」**）。 */
let hint = null;
/** 已经问过一次 `GET /admin/api/config` 了吗。读不到 hint 不是错误，但也别每次切回来重问。 */
let hintAsked = false;
/** 当前选中的协议 id 与模型 id。**取值来自响应，不是本地枚举。** */
let protoId = "";
let modelId = "";
/** 输入框里的两样东西。**re-render 之后从这里回填**，所以整块重建不会丢用户输入。 */
let promptText = "";
let token = "";
/**
 * 右栏那几轮对话。**只进不出**，切走板块也留着（同一次会话里回头对比很常见）。
 *
 * ⚠️ **没有上限，如实登记**（评审 L5）：每一轮存着一份响应体，一个开一整天、
 * 反复发几百次的标签页会把它们全留在内存里。**今天不加上限**——它要么是一个
 * 需要新 UI 状态的「清空」按钮、要么是一条静默丢弃用户看得见的内容的规则，
 * 两条都比这个问题本身大；而每一轮都是运维自己按出来的，量级与他的手速同阶。
 * **登记 P3e**：真要加，做成显式的「清空对话」而不是静默截断。
 */
let turns = [];
/** 这一刻有没有一次对外请求在飞。它就是那道「在飞去重」。 */
let inFlight = false;
/**
 * 在飞那一次的取消器，**同时是「这一次还是不是当前那一次」的判据**。
 * 见文件头那段 ⚠️⚠️：abort 本身在测试里不可观测，被钉住的是这个身份比较。
 */
let current = null;
/** 目录那条读的在飞标记与世代号（与 `js/sec-models.js` 同一套，理由见那里）。 */
let loadInFlight = false;
let loadSeq = 0;
/** 面板自己所在的那个源。`init()` 时读一次——**判定在纯函数里，那里拿不到浏览器全局**。 */
let origin = "";

/** 一个内容块：标题 + 空的 body 容器。 */
function block(titleKey) {
  const wrap = el("div", { class: "card block" });
  wrap.appendChild(elI18n("h3", titleKey));
  const body = el("div");
  wrap.appendChild(body);
  return { wrap, body };
}

/** 一行「标签 + 控件」。 */
function field(labelKey, control) {
  const wrap = el("div", { class: "pg-field" });
  wrap.appendChild(elI18n("span", labelKey, { class: "muted" }));
  wrap.appendChild(control);
  return wrap;
}

/**
 * 模式分段：对话 / 图片 / 视频。**本任务只做对话**，另两档 disabled + tooltip。
 * ⚠️ 三个 key 写成三个字面量，**不许把档位名拼进 key**（全局约束 12）。
 */
function buildModeBar() {
  const bar = el("div", { class: "btn-group" });
  bar.appendChild(elI18n("span", "pg.mode.label", { class: "muted" }));

  const chat = elI18n("button", "pg.mode.chat", {
    type: "button", class: "btn-toggle active", "data-mode": "chat", "aria-pressed": "true",
  });
  bar.appendChild(chat);

  for (const [key, mode] of [["pg.mode.image", "image"], ["pg.mode.video", "video"]]) {
    const btn = elI18n("button", key, {
      type: "button", class: "btn-toggle", "data-mode": mode, "aria-pressed": "false",
    });
    btn.disabled = true;
    btn.setAttribute("title", t("pg.mode.laterTip"));
    bar.appendChild(btn);
  }
  return bar;
}

/**
 * 协议分段。**档位由响应里的 `protocols[]` 生成，本文件不认识任何一个协议 id。**
 * 展示名走响应里的 `label`（协议的专名，**刻意不进 i18n**，理由见
 * `src/core/admin/protocol-catalog.ts` 里 label 字段上方那一行）。
 */
function buildProtoBar() {
  const bar = el("div", { class: "btn-group" });
  bar.appendChild(elI18n("span", "pg.proto.label", { class: "muted" }));
  for (const p of catalog.protocols) {
    const btn = el("button", {
      type: "button", class: "btn-toggle", "data-protocol": p.id,
      "aria-pressed": p.id === protoId ? "true" : "false",
    }, p.label);
    btn.classList.toggle("active", p.id === protoId);
    btn.addEventListener("click", () => {
      if (protoId === p.id) return;
      protoId = p.id;
      // 换协议要重挑模型：上一条协议上可用的模型未必在这一条上也可用。
      modelId = "";
      render();
    });
    bar.appendChild(btn);
  }
  return bar;
}

/** 当前选中的那条协议，没有就是 `null`。 */
function currentProto() {
  if (catalog === null) return null;
  for (const p of catalog.protocols) if (p.id === protoId) return p;
  return null;
}

/**
 * 模型下拉。**只列这条协议上真的可用的模型**（判定在 `js/pure/playground.mjs`）。
 * 一个都没有时下拉是空的，而下面那句提示会说清是哪一档。
 */
function buildModelSelect(proto) {
  const sel = el("select", { class: "pg-model" });
  const ids = modelIdsForProtocol(proto, catalog.models);
  if (modelId === "" && ids.length > 0) modelId = ids[0];
  for (const id of ids) {
    const opt = el("option", { value: id }, id);
    sel.appendChild(opt);
  }
  // **显式回写 `.value`**：整块每次重建，不写的话选中项会掉回第一项。
  sel.value = modelId;
  sel.disabled = ids.length === 0;
  sel.addEventListener("change", () => { modelId = sel.value; });
  return sel;
}

/** 流式开关。**本任务按不动**，理由见文件头那段。 */
function buildStreamToggle() {
  const box = el("input", { type: "checkbox", class: "pg-stream" });
  box.disabled = true;
  box.setAttribute("title", t("pg.stream.laterTip"));
  return box;
}

/** 口令与 hint 对不对得上那一句。**只画档位名，不含口令的任何一个字节。** */
function hintNoteKey() {
  const state = tokenHintState(token, hint);
  if (state === "empty") return "pg.token.stateEmpty";
  if (state === "unknown") return "pg.token.stateUnknown";
  if (state === "match") return "pg.token.stateMatch";
  return "pg.token.stateMismatch";
}

/** 那一句的样式档。三档颜色不同，**同时靠文字表达**（不只靠颜色）。 */
function hintNoteClass() {
  const state = tokenHintState(token, hint);
  if (state === "match") return "pg-hint pg-hint-ok";
  if (state === "mismatch") return "pg-hint pg-hint-bad";
  return "pg-hint muted";
}

/** 把那一句就地刷一遍。**不整块重画**——重画会让口令输入框丢焦点。 */
function syncHintNote() {
  if (nodes === null || nodes.hintNote === null) return;
  nodes.hintNote.textContent = t(hintNoteKey());
  nodes.hintNote.setAttribute("class", hintNoteClass());
}

/**
 * 网关口令输入框。
 *
 * ⚠️ **`type="password"`**：这把口令是发给每一个下游用户的那把中转口令，
 * 让它明晃晃地留在一块可能被投屏 / 被同事看一眼的屏幕上没有任何好处。
 * ⚠️ **`autocomplete="off"`**：别让浏览器把它和管理口令混进同一个密码条目。
 */
function buildTokenInput() {
  const input = el("input", {
    type: "password", class: "pg-token", autocomplete: "off",
    "data-i18n-ph": "pg.token.placeholder",
  });
  input.setAttribute("placeholder", t("pg.token.placeholder"));
  input.value = token;
  input.addEventListener("input", () => {
    token = input.value;
    // 存 localStorage（全局约束 11(b)：手动粘贴 + 本地保存，后端不回显）。
    writeGatewayToken(token);
    syncHintNote();
    syncSendButton();
  });
  return input;
}

/** 提示词输入框。 */
function buildPromptInput() {
  const area = el("textarea", { class: "pg-prompt", rows: "4", "data-i18n-ph": "pg.prompt.placeholder" });
  area.setAttribute("placeholder", t("pg.prompt.placeholder"));
  area.value = promptText;
  area.addEventListener("input", () => { promptText = area.value; syncSendButton(); });
  return area;
}

/** 这一刻能不能按发送；不能的话是哪一档（`null` = 能按）。 */
function sendBlockedKey() {
  if (inFlight) return "pg.send.blockedInFlight";
  if (currentProto() === null) return "pg.send.blockedNoProto";
  if (modelId === "") return "pg.send.blockedNoModel";
  if (token === "") return "pg.send.blockedNoToken";
  if (promptText.trim() === "") return "pg.send.blockedNoPrompt";
  return null;
}

/** 发送按钮的可用性与 tooltip 就地刷一遍（同 `syncHintNote`，不整块重画）。 */
function syncSendButton() {
  if (nodes === null || nodes.send === null) return;
  const blocked = sendBlockedKey();
  nodes.send.disabled = blocked !== null;
  nodes.send.setAttribute("title", t(blocked === null ? "pg.send.ready" : blocked));
}

/**
 * 左栏。
 *
 * ⚠️ **协议用分段按钮而不是 `<input type="radio">`**：其余三个板块的同类控件
 * （事件级别、用量口径、模型筛选）都是这一套 `.btn-group` / `.btn-toggle`，
 * 各写一套迟早长得不一样。另有一条实测理由：`tests/helpers/fake-dom.ts` 没有
 * 单选组语义（`.checked` 只是元素上的一个普通字段），用 radio 的话「四选一」这件事
 * 会变成**只有真实浏览器才验得到**的行为（第 9 种假阳性）。
 */
function buildLeft() {
  const { wrap, body } = block("pg.req.title");
  body.appendChild(buildModeBar());
  body.appendChild(buildProtoBar());

  const proto = currentProto();
  body.appendChild(field("pg.model.label", buildModelSelect(proto)));
  if (proto !== null && modelIdsForProtocol(proto, catalog.models).length === 0) {
    body.appendChild(elI18n("p", "pg.model.none", { class: "muted note" }));
  }
  body.appendChild(field("pg.stream.label", buildStreamToggle()));

  const tokenInput = buildTokenInput();
  body.appendChild(field("pg.token.label", tokenInput));
  const note = el("span", { class: hintNoteClass() }, t(hintNoteKey()));
  nodes.hintNote = note;
  body.appendChild(note);
  body.appendChild(elI18n("p", "pg.token.note", { class: "muted note" }));

  body.appendChild(field("pg.prompt.label", buildPromptInput()));

  const bar = el("div", { class: "toolbar" });
  const send = elI18n("button", "pg.send", { type: "button", class: "pg-send" });
  send.addEventListener("click", () => { sendOnce(); });
  nodes.send = send;
  bar.appendChild(send);
  if (inFlight) {
    const cancel = elI18n("button", "pg.cancel", { type: "button", class: "pg-cancel" });
    cancel.addEventListener("click", () => { cancelInFlight(); render(); });
    bar.appendChild(cancel);
    bar.appendChild(elI18n("span", "pg.sending", { class: "muted pg-sending" }));
  }
  body.appendChild(bar);
  syncSendButton();
  return wrap;
}

/**
 * 一轮对话。**上行只画运维自己输入的那句话与这次打的地址，绝不画请求头**
 * ——请求头里正是那把网关口令（全局约束 11(b)）。
 */
function buildTurn(turn) {
  const wrap = el("div", { class: "pg-turn" });
  const head = el("div", { class: "pg-turn-head" });
  head.appendChild(elI18n("span", "pg.turn.you", { class: "muted" }));
  // 地址那一格只在**这次真的构造出了一条请求**时才画：构造失败那一档 `url` 是空串，
  // 画出来会是一条看着像地址的空壳，而那次请求根本没有地址可言。
  if (turn.url !== "") {
    head.appendChild(el("span", { class: "mono pg-endpoint" }, `${turn.method} ${turn.url}`));
  }
  wrap.appendChild(head);
  wrap.appendChild(el("p", { class: "pg-turn-prompt" }, turn.promptText));

  const foot = el("div", { class: "pg-turn-head" });
  foot.appendChild(elI18n("span", "pg.turn.gateway", { class: "muted" }));
  if (turn.status !== null) {
    foot.appendChild(el("span", { class: "mono pg-status" }, String(turn.status)));
  }
  wrap.appendChild(foot);

  if (turn.errorKey !== null) {
    wrap.appendChild(elI18n("p", turn.errorKey, { class: "danger-text pg-error" }));
    return wrap;
  }
  const text = prettyJson(turn.body);
  if (text === null) {
    // 读不出来 ≠ 空响应（全局约束 9 的同型）。
    wrap.appendChild(elI18n("p", "pg.turn.unreadable", { class: "muted note pg-unreadable" }));
    return wrap;
  }
  wrap.appendChild(el("pre", { class: "mono pg-body" }, text));
  return wrap;
}

/** 右栏。 */
function buildRight() {
  const { wrap, body } = block("pg.conv.title");
  if (turns.length === 0) {
    body.appendChild(elI18n("p", "pg.conv.empty", { class: "muted note" }));
    return wrap;
  }
  for (const turn of turns) body.appendChild(buildTurn(turn));
  return wrap;
}

/**
 * 读不出来那一档。**绝不能退化成「画一个空的协议选择器」**：一排空档位会被读成
 * 「这个网关一条协议都没有」，而事实是我们**不知道**它认得哪些协议（全局约束 9 的同型）。
 */
function buildUnavailable() {
  const wrap = el("div");
  const banner = el("div", { class: "banner-danger", role: "status" });
  banner.appendChild(elI18n("span", "common.loadFailed"));
  const retry = elI18n("button", "common.refresh", { type: "button", class: "pg-retry" });
  retry.addEventListener("click", () => {
    // ⚠️ **hint 那一次也要重问**（评审 L3）：`hintAsked` 是个一次性闸，
    //    `/config` 失败一次之后它永远为真 ⇒ **整个会话的 hint 校验停在「比不了」，
    //    按了这颗按钮也不恢复**。这颗按钮的语义是「把这个板块读不到的东西再读一次」，
    //    而 hint 正是其中之一。
    hintAsked = false;
    loadHint();
    loadCatalog(true);
  });
  banner.appendChild(retry);
  wrap.appendChild(banner);
  const { wrap: card, body } = block("pg.req.title");
  body.appendChild(elI18n("p", "pg.unavailable", { class: "muted note pg-unknown" }));
  wrap.appendChild(card);
  return wrap;
}

/**
 * 整个板块重画一遍。**每次都把 body 清空重建**：藏起来的旧内容仍然在无障碍树里、
 * 仍然会被复制粘贴带走。
 */
function render() {
  const host = nodes.body;
  host.textContent = "";
  nodes.hintNote = null;
  nodes.send = null;
  if (catalog === null) {
    host.appendChild(buildUnavailable());
    return;
  }
  const cols = el("div", { class: "pg-cols" });
  cols.appendChild(buildLeft());
  cols.appendChild(buildRight());
  host.appendChild(cols);
}

/**
 * 拉一次协议目录。**成功读过一次就不再读**——目录是静态的，重读一遍只会换来一次
 * 「这次可能失败」的机会（与 `js/sec-models.js` 同一条裁定，理由见那里）。
 *
 * `preempt` 只由错误横幅上那颗「再读一次」传 `true`：显式的用户动作有权抢占一条挂住
 * 的读，隐式的板块切换没有。隐式入口在飞时**只 render() 不发请求**，否则一条永不落地
 * 的读会让此后每一次 `onShow()` 都什么都不画。
 */
async function loadCatalog(preempt) {
  if (loadInFlight && !preempt) { render(); return; }
  const mine = ++loadSeq;
  loadInFlight = true;
  try {
    const body = await api.get("/models");
    if (mine !== loadSeq) return;
    const protocols = playgroundProtocols(body);
    // **模型清单直接复用模型板块那份窄化**，不在这里再写一遍（`js/sec-settings.js` 同做法）。
    const models = catalogModels(body);
    catalog = protocols === null || models === null ? null : { protocols, models };
    if (catalog !== null && protoId === "") protoId = catalog.protocols.length > 0 ? catalog.protocols[0].id : "";
  } catch (e) {
    if (mine !== loadSeq) return;
    catalog = null;
  } finally {
    if (mine === loadSeq) loadInFlight = false;
  }
  render();
}

/**
 * 问一次设置页那把口令的末几位。
 *
 * ⚠️ **它失败不是错误，只是「比不了」**：`hint` 停在 `null`，那一句显示成
 * 「读不到配置，比不了」而不是「对不上」。把两者折叠成一档会让运维去改一把其实
 * 没错的口令（判定在 `js/pure/playground.mjs` 的 `tokenHintState()`）。
 * ⚠️ **它拿不到、也不该拿到明文口令**：`GET /admin/api/config` 对凭据只回
 * `{ configured, hint }`（设计 §8.6）。
 */
async function loadHint() {
  if (hintAsked) return;
  hintAsked = true;
  try {
    const body = await api.get("/config");
    hint = credentialView(body, "gatewayToken").hint;
  } catch (e) {
    hint = null;
  }
  if (nodes !== null) syncHintNote();
}

/** 作废在飞的那一次。**abort 只是省一次真实往返，作废判据是 `current` 的身份比较。** */
function cancelInFlight() {
  if (current !== null) current.abort();
  current = null;
  inFlight = false;
}

/**
 * 按一下发送。**这是全站第二颗会真打上游的按钮**，护栏见文件头。
 *
 * ⚠️ **拦截分档在这里、不在 `buildRequest()` 里**：把「没填口令」塞进纯函数的话，
 * 它会和「构造不出请求」一起变成同一个 `null`，而这两件事在 UI 上必须分得开。
 */
function sendOnce() {
  // ⚠️⚠️ **在飞去重那一道住在 `sendBlockedKey()` 的第一档里，不在这里。**
  //    这一版曾经在这行上面多写过一句 `if (inFlight) return;`，而**变异实测把它删掉
  //    ⇒ 22/22 全绿**——它是一句没有任何用例守着的冗余，因为 `sendBlockedKey()`
  //    的第一句判的就是 `inFlight`。当时文件头正声称那句话是护栏本体，
  //    **那是一句假断言**，连同这段一起改真了。
  //    ⇒ **判据只许有一份**：要改在飞去重，改 `sendBlockedKey()` 那一档。
  if (sendBlockedKey() !== null) return;
  const proto = currentProto();
  const req = buildRequest(proto, { model: modelId, prompt: promptText, stream: false, origin });
  if (req === null) {
    turns.push({ promptText, url: "", method: "", status: null, body: null, errorKey: "pg.err.buildFailed" });
    render();
    return;
  }
  const ctl = new AbortController();
  current = ctl;
  inFlight = true;
  const sent = promptText;
  render();

  sendToGateway(req, token, { origin, signal: ctl.signal })
    .then((r) => {
      if (current !== ctl) return;
      turns.push({ promptText: sent, url: req.url, method: req.method, status: r.status, body: r.body, errorKey: null });
    })
    .catch((e) => {
      if (current !== ctl) return;
      // **只认档位名，不把 `e.message` 画出去**：那条串是本地拼的，别给它机会带上
      // 任何一段请求内容（全局约束 11(b)）。
      turns.push({
        promptText: sent, url: req.url, method: req.method, status: null, body: null,
        errorKey: e && e.code === "cross_origin" ? "pg.err.crossOrigin" : "pg.err.transport",
      });
    })
    .finally(() => {
      if (current !== ctl) return;
      current = null;
      inFlight = false;
      render();
    });
}

export const playgroundSection = {
  init(section) {
    section.textContent = "";
    section.appendChild(elI18n("h2", "pg.title"));
    section.appendChild(elI18n("p", "pg.desc", { class: "muted note" }));
    section.appendChild(elI18n("p", "pg.runtimeNote", { class: "muted note" }));
    const body = el("div");
    section.appendChild(body);
    nodes = { body, hintNote: null, send: null };
    // 判定在纯函数里，而那个目录下拿不到浏览器的顶层全局，所以在这里读一次传进去。
    origin = location.origin;
    token = readGatewayToken();
  },

  onShow() {
    // ⚠️⚠️ **每次显示都重新从存储读一遍口令，不能只在 `init()` 里读一次**
    //（评审 M2）：登出**不会** reload 页面、板块也不会重新 `init()`，
    //    于是模块变量里那把口令会活过一次登出 ⇒ 下一个人登录进来时口令框是预填好的。
    //    `js/app.js` 的 `leave()` 清存储、这里重新读存储，**两处缺一不可**。
    // ⚠️ **代价明写**：隐私模式下 `writeGatewayToken()` 写不进去，于是切走再切回来
    //    会丢掉刚粘的那把——与那条「刷新后要重新粘」是同一档代价，不是新增的。
    token = readGatewayToken();
    loadHint();
    if (catalog !== null) { render(); return; }
    loadCatalog(false);
  },

  onHide() {
    // 切走板块 = 作废在飞的那一次（全局约束 14 的护栏之一）。
    cancelInFlight();
  },
};
