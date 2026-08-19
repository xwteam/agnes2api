/*
 * 登录闸。P3a 只有它——面板本体在 P3b。
 *
 * 两条约束在这里就定死，后面所有板块沿用：
 * ① 口令走 localStorage + `x-admin-key` **请求头**，禁止 Cookie 会话、禁止 `?key=`。
 *    现有鉴权无 Cookie 无 Session ⇒ CSRF 天然不成立；引入 Cookie 就必须同时
 *    加 SameSite=Strict 与 CSRF token，不能只加一半。口令进 URL 会落进浏览器历史、
 *    Referer 与各级访问日志，所以查询参数也一并禁掉。
 * ② 一切来自接口的内容一律 textContent，不用 innerHTML。
 */
import { maskKey } from "./pure/mask.mjs";

const KEY_STORE = "agnes2api_admin_key";
const gate = document.getElementById("gate");
const shell = document.getElementById("shell");
const form = document.getElementById("gate-form");
const input = document.getElementById("gate-key");
const err = document.getElementById("gate-err");
const who = document.getElementById("shell-key");
const ver = document.getElementById("shell-version");

/** localStorage 在隐私模式下会抛，读写一律包起来——它不该能挡住登录。 */
function store(op, value) {
  try {
    if (op === "get") return localStorage.getItem(KEY_STORE);
    if (op === "set") localStorage.setItem(KEY_STORE, value);
    if (op === "del") localStorage.removeItem(KEY_STORE);
  } catch (e) {
    // 存不下就存不下：本次会话照常可用，只是刷新后要重新输入。
  }
  return null;
}

async function probe(key) {
  const res = await fetch("/admin/api/session", { headers: { "x-admin-key": key } });
  if (res.status === 401) return { ok: false, reason: "unauthorized" };
  // 403 **不当会话失效**：将来某个操作被拒绝时把人踢出后台并告知「密钥无效」，
  // 是 kiro2api 踩过的坑。这里只有 401 才算登录失败。
  if (!res.ok) return { ok: false, reason: "http_" + res.status };
  return { ok: true, body: await res.json() };
}

function enter(key, body) {
  gate.classList.add("off");
  shell.classList.add("on");
  // 掩码后再显示：明文口令留在页面上，一次截图就泄漏了。
  who.textContent = maskKey(key);
  ver.textContent = String(body && body.version ? body.version : "—");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = input.value.trim();
  err.textContent = "";
  if (!key) { err.textContent = "请输入管理口令"; return; }
  const submit = form.querySelector("button");
  submit.disabled = true;
  try {
    const r = await probe(key);
    if (!r.ok) {
      // 失败**绝不**写入 localStorage，也不显示「已登录」。
      err.textContent = r.reason === "unauthorized" ? "口令无效" : "接口异常：" + r.reason;
      return;
    }
    store("set", key);
    enter(key, r.body);
  } catch (e2) {
    err.textContent = "网络错误，请稍后重试";
  } finally {
    submit.disabled = false;
  }
});

// 已经存过口令就直接验一次；**验不过要清掉**，否则用户会卡在一个永远进不去的页面。
// 只有 401 才清：接口 500 或断网时清掉等于让一次运维事故顺手把人锁在外面。
const saved = store("get");
if (saved) {
  probe(saved).then((r) => {
    if (r.ok) enter(saved, r.body);
    else if (r.reason === "unauthorized") store("del");
  }).catch(() => {});
}
