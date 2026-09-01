/**
 * 面板入口：登录闸 + 板块注册表 + `showSection`。
 *
 * 板块契约（设计文档 §9.3）：`A.sections.<name> = { init?, onShow?, onHide? }`。
 * `showSection` 负责：切 .active、首次 init()、每次 onShow()、
 * 离开时上一个板块 onHide()（**停轮询、作废在飞请求**）、把板块名写 localStorage。
 * **没有 URL 路由、没有 hash**（放弃深链接，换与 kiro2api 一致的刷新复原行为）。
 *
 * ⚠️ **板块内不许各自监听 langchange**：框架层在这里统一 apply(document) +
 * 重跑当前板块的 onShow()。板块自己再监听一次就是 kiro2api 那 4 处冗余监听。
 */
import { t, apply, setLang, currentLang, LANGS } from "./i18n.js";
import { getTheme, toggleTheme, setTheme } from "./theme.js";
import { onUnauthorized } from "./api.js";
import { overviewSection } from "./sec-overview.js";
import { keysSection } from "./sec-keys.js";
import { registrarSection } from "./sec-registrar.js";
import { eventsSection } from "./sec-events.js";
import { usageSection } from "./sec-usage.js";
import { modelsSection } from "./sec-models.js";
import { playgroundSection } from "./sec-playground.js";
import { settingsSection } from "./sec-settings.js";
import { sessionExpired } from "./pure/session.mjs";
import { sendable } from "./pure/sendable.mjs";
// **键名不在这里声明**（评审裁定）：写入方在这个文件、读取方在 `api.js`，
// 各写一份的后果实测过——只改这边一处 ⇒ 登录成功进壳层、随后每请求送空口令头
// ⇒ 401 ⇒ 登出循环，面板彻底不可用而全套用例照绿。理由全文见那个模块的文件头。
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE, GW_KEY_STORE } from "./pure/storage-keys.mjs";

const SECTIONS = {
  overview: overviewSection, keys: keysSection, registrar: registrarSection, events: eventsSection,
  usage: usageSection, models: modelsSection, playground: playgroundSection, settings: settingsSection,
};

const gate = document.getElementById("gate");
const shell = document.getElementById("shell");
const form = document.getElementById("gate-form");
const input = document.getElementById("gate-key");
const err = document.getElementById("gate-err");

function store(op, value) {
  try {
    if (op === "get") return localStorage.getItem(KEY_STORE);
    if (op === "getAt") return localStorage.getItem(SAVED_AT_STORE);
    if (op === "set") {
      localStorage.setItem(KEY_STORE, value);
      localStorage.setItem(SAVED_AT_STORE, String(Date.now()));
    }
    if (op === "del") {
      localStorage.removeItem(KEY_STORE);
      localStorage.removeItem(SAVED_AT_STORE);
      // ⚠️ **网关口令一并清**（评审发现）：它是这块存储里的第二把凭据，
      //    而它比管理口令还弱（没有年龄上限、后端没有撤销路径）。理由全文与那两处
      //    缺一不可的接线见 `js/pure/storage-keys.mjs` 的 `GW_KEY_STORE`。
      localStorage.removeItem(GW_KEY_STORE);
    }
  } catch (e) { /* 隐私模式：本次会话照常可用，刷新后要重新输入 */ }
  return null;
}

let current = null;

function showSection(name) {
  if (!SECTIONS[name]) name = "overview";
  if (current === name) { SECTIONS[name].onShow && SECTIONS[name].onShow(); return; }
  if (current && SECTIONS[current] && SECTIONS[current].onHide) SECTIONS[current].onHide();
  for (const btn of document.querySelectorAll(".nav-item")) {
    btn.classList.toggle("active", btn.getAttribute("data-section") === name);
  }
  for (const sec of document.querySelectorAll(".section")) {
    sec.classList.toggle("active", sec.id === `sec-${name}`);
  }
  const s = SECTIONS[name];
  if (!s.__inited) { s.init && s.init(document.getElementById(`sec-${name}`)); s.__inited = true; }
  s.onShow && s.onShow();
  current = name;
  try { localStorage.setItem(SECTION_STORE, name); } catch (e) { /* ignore */ }
}

function enter() {
  gate.classList.add("off");
  shell.classList.add("on");
  let saved = "overview";
  try { saved = localStorage.getItem(SECTION_STORE) || "overview"; } catch (e) { /* ignore */ }
  showSection(saved);
}

function leave(reason) {
  if (current && SECTIONS[current] && SECTIONS[current].onHide) SECTIONS[current].onHide();
  current = null;
  store("del");
  shell.classList.remove("on");
  gate.classList.remove("off");
  input.value = "";
  err.textContent = reason ? t(reason) : "";
}

/**
 * 登录探针。**这是全站第二个网络出口**（另两个是 `js/api.js` 的 `raw()` 与
 * Playground 的 `js/gw-api.js`）——`api.js` 的文件头一度把「全站唯一网络出口」
 * 当成它那段安全论证的前提，那句是假的（评审当场推翻），两边现在都说准了。
 * ⚠️ **「也是最后一个」这半句同样活不过一期**：它被后来落地的 Playground
 * 对外出口推翻了。⭐ 记一条形状：**一句「到此为止」的话，写下时是真的，
 * 而推翻它的往往就是同一份计划里排在后面的那个任务。**
 *
 * **刻意不走 `api.js`**，三条理由缺一不可：
 * ① 这一刻还没有会话——时刻键要到 `store("set")` 才写下，`api.js` 的 `expired()`
 *    前置会把每一次登录都判成过期（`Number(null) === 0` ⇒ `savedAt <= 0`）；
 * ② 这里的 401 意思是「口令不对」，不是「你掉线了」，走 `onUnauthorized()` 会
 *    在登录闸上再弹一次登录闸；
 * ③ 口令还没进 `localStorage`，`api.js` 的 `readKey()` 读不到它。
 * 出口数量由 `tests/ui/api-session.test.ts` 的
 * 「恰好三处：api.js 的 raw()、app.js 的登录探针、gw-api.js 的网关出口」
 * 数着钉住：**照它那张手写枚举表里的七种写法写、并且不在带花括号的插值里**，
 * 加第四个会变红。
 * ⚠️ **那张表原来只有四种写法，后来把漏掉的三种补齐了**
 * （`new WebSocket(` / 动态 `import(` / 把 fetch 先存进变量再调；那一轮评审实测各得 0）。
 * 补齐之后它仍然沿另一条轴漏一族：抠模板串字面文本那一步会把**带花括号的插值**
 * 整条吃掉——`admin-ui/js/sec-overview.js` 那条渲染「上次检查时间」的模板串就是这个形状，
 * 往它里面塞一个真 `fetch` 实测全绿（定向复评当场跑过）。
 * 边界全文见 `admin-ui/js/api.js` 文件头。
 */
async function probe(key) {
  const res = await fetch("/admin/api/session", { headers: { "x-admin-key": key }, credentials: "omit" });
  if (res.status === 401) return { ok: false, reason: "gate.invalid" };
  // 403 **不当会话失效**：将来某个操作被拒绝时把人踢出后台并告知「密钥无效」，
  // 是 kiro2api 踩过的坑。这里只有 401 才算登录失败。
  if (!res.ok) return { ok: false, reason: "gate.httpError", status: res.status };
  return { ok: true, body: await res.json() };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = input.value.trim();
  err.textContent = "";
  if (!key) { err.textContent = t("gate.empty"); return; }
  // 字符集判定在 `js/pure/sendable.mjs`，**与后端 `SENDABLE` 逐码位等价**
  //（`tests/ui/sendable-parity.test.ts` 的「逐码位……行为等价」断言钉着，不是源码文本比对）。
  // 前端这一半必须有：后端只在启动时看得到自己的口令，看不到用户粘了什么。
  // 判定本身不许在这个文件里再写一遍（admin-ui/README.md 硬规则 1）。
  if (!sendable(key)) { err.textContent = t("gate.badShape"); return; }
  const submit = form.querySelector("button");
  submit.disabled = true;
  try {
    const r = await probe(key);
    if (!r.ok) {
      // 失败**绝不**写入 localStorage，也不显示「已登录」。
      err.textContent = r.reason === "gate.invalid" ? t("gate.invalid") : t("gate.httpError", { status: r.status });
      return;
    }
    store("set", key);
    enter();
  } catch (e2) {
    err.textContent = t("gate.network");
  } finally {
    submit.disabled = false;
  }
});

// 会话失效由 api.js 统一上报：任何一个 401 都把人送回登录闸，并说清原因。
onUnauthorized(() => leave("common.sessionExpired"));

document.getElementById("logout-btn").addEventListener("click", () => leave(null));
document.getElementById("theme-btn").addEventListener("click", () => toggleTheme());

const langSel = document.getElementById("lang-select");
for (const l of LANGS) {
  const o = document.createElement("option");
  o.value = l; o.textContent = l;
  langSel.appendChild(o);
}
langSel.value = currentLang();
langSel.addEventListener("change", () => setLang(langSel.value));

// **框架层的兜底：切语言时整页重绘。** 板块自己不许再监听这个事件。
document.addEventListener("langchange", () => {
  apply(document);
  if (current && SECTIONS[current] && SECTIONS[current].onShow) SECTIONS[current].onShow();
});

for (const btn of document.querySelectorAll(".nav-item")) {
  btn.addEventListener("click", () => showSection(btn.getAttribute("data-section")));
}

apply(document);
setTheme(getTheme());

// 已经存过口令就直接验一次；**验不过要清掉**，否则用户会卡在一个永远进不去的页面。
// 只有 401 才清：接口 500 或断网时清掉等于让一次运维事故顺手把人锁在外面。
//
// 但在验之前先过一道**会话绝对上限**：存下来超过 12 小时（或者压根没存时刻——
// 旧版本存的）就当场清掉、回登录闸，连这一次 probe 都不发。判定在
// `js/pure/session.mjs`，这里只负责把浏览器存储与时钟喂给它。
const saved = store("get");
if (saved) {
  if (sessionExpired(Number(store("getAt")), Date.now())) {
    store("del");
    err.textContent = t("common.sessionExpired");
  } else {
    probe(saved).then((r) => {
      if (r.ok) enter();
      else if (r.reason === "gate.invalid") store("del");
    }).catch(() => {});
  }
}
