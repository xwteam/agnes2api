/**
 * 全站唯一网络出口。
 *
 * **两把钥匙严格隔离**（设计文档 §10.5）：
 * 本模块只发 `x-admin-key`、只打 `/admin/api/*`。网关口令与 `/v1` 是 P3d 的
 * Playground 的事，**不许在这里出现**——两条禁令各有一条单测钉着。
 *
 * **401 = 会话失效；403 明确不当会话失效。**
 * 后者是照抄 kiro2api 用中文注释警告过的那个坑：它老写法把业务 403 当掉线，
 * 管理员拒绝一次授权就被踢出后台并被告知「密钥无效」。
 * 两条对称用例进单测，防「修过头」。
 */
const KEY_STORE = "agnes2api_admin_key";
const BASE = "/admin/api";

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

let unauthorizedHandler = null;
/** 会话失效时的回调（清 key + 弹登录浮层）。只由 app.js 注册一次。 */
export function onUnauthorized(cb) { unauthorizedHandler = cb; }

function readKey() {
  try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
}

export async function raw(method, path, body, init) {
  // 口令只走请求头。**禁止 Cookie 会话、禁止 ?key=**：口令进 URL 会落进浏览器历史、
  // Referer、CF 访问日志、反代日志。这条禁令同时否掉了 EventSource（它设不了请求头）。
  const headers = { "x-admin-key": readKey() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(headers, (init && init.headers) || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
    // 同源，且刻意不带凭据：本项目没有 Cookie 会话，带上只会扩大攻击面。
    credentials: "omit",
    signal: init && init.signal,
  });
  if (res.status === 401) {
    // **只有 401 清会话。** 403 是「这个操作被拒绝」，不是「你没登录」。
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(401, "unauthorized", null);
  }
  return res;
}

async function json(method, path, body, init) {
  const res = await raw(method, path, body, init);
  let parsed = null;
  try { parsed = await res.json(); } catch (e) { parsed = null; }
  if (!res.ok) {
    const msg = parsed && parsed.error && parsed.error.message ? parsed.error.message : `http_${res.status}`;
    throw new ApiError(res.status, msg, parsed);
  }
  return parsed;
}

export const api = {
  get:  (p, init) => json("GET", p, undefined, init),
  post: (p, b, init) => json("POST", p, b, init),
  put:  (p, b, init) => json("PUT", p, b, init),
  del:  (p, init) => json("DELETE", p, undefined, init),
  raw,
};
