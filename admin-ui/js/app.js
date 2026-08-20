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
import { eventsSection } from "./sec-events.js";
import { sessionExpired } from "./pure/session.mjs";
import { sendable } from "./pure/sendable.mjs";

const KEY_STORE = "agnes2api_admin_key";
/**
 * 「口令是什么时候存下来的」。会话绝对上限靠它算年龄，判定本身在
 * `js/pure/session.mjs`（`sessionExpired`），这里只负责读写浏览器存储。
 *
 * **两个键必须一起写、一起清**：只清口令不清时刻，下次登录前那个时刻还是旧的；
 * 只写口令不写时刻，`sessionExpired()` 拿不到时刻会把刚登录的会话判成过期
 *（方向是 fail closed，但用户会永远进不去）。
 */
const SAVED_AT_STORE = "agnes2api_admin_key_at";
const SECTION_STORE = "agnes2api_section";
const SECTIONS = { overview: overviewSection, keys: keysSection, events: eventsSection };

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
  //（`tests/ui/sendable-parity.test.ts` 的行为断言钉着，不是源码文本比对）。
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
