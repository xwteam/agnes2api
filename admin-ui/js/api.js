/**
 * 面板**登录之后**的唯一网络出口。
 *
 * ⚠️ **这句原来写的是「全站唯一网络出口」，那是假的**（全分支评审 C3）：
 * 全站一共**两个** `fetch` 调用点，另一个是 `js/app.js` 的登录探针
 *（`probe()`，`js/app.js:87`）。它**刻意**绕开本模块——那一刻还没有会话可言：
 * 没有 `expired()` 前置（时刻键还没写）、不该走 `onUnauthorized`（401 在那里
 * 的意思是「口令不对」，不是「你掉线了」）、也不必包成 `ApiError`。
 * 说准这件事很要紧：**本模块正是那个把「唯一出口」当成安全论证前提的地方**
 *（下面「口令只走请求头」那段），顺着假的那句走，审计者会漏掉口令实际离开
 * 页面的第二条路径。两个出口这件事由
 * `tests/ui/api-session.test.ts`「恰好两处：api.js 的 raw() 与 app.js 的登录探针」
 * 那格数着调用点钉住。
 * ⚠️⚠️ **它数的是一张手写的枚举表，不是「所有出网方式」，别把它读成后者**
 *（P3d Task 7 评审 F-11，逐条实测）：表里是 `fetch` / `XMLHttpRequest` /
 * `EventSource` / `sendBeacon` 四个名字，**`new WebSocket(`、`await import(`、
 * 以及把 fetch 先存进变量再调（`const f = globalThis.fetch; f(u)`）三种，
 * 它一个都数不出来**（实测这三种各得 0，而 `sendBeacon` / `XMLHttpRequest` 各得 1）。
 * ⇒ 准确的说法是「**照这四种写法**加第三个出口会让它变红」。
 * 枚举表本身登记给 P3d Task 10（Playground 是第一个可能要流式的消费者，
 * `WebSocket` 值得那时补）。
 * ⚠️ **这里原来写的是行号，P3d Task 7 往那个文件里插了几格用例之后它就漂了**
 *（第 8 道门禁当场抓住）。名字锚没有这个毛病，改用名字锚。
 *
 * **两把钥匙严格隔离**（设计文档 §10.5）：
 * 本模块只发 `x-admin-key`、只打 `/admin/api/*`。网关口令与 `/v1` 是 P3d 的
 * Playground 的事，**不许在这里出现**。
 * 两条禁令各有一条行为用例钉着：`tests/ui/api-session.test.ts:227`（凭据头只有
 * `x-admin-key`，没有任何 `authorization` / 网关口令头）与 `:239`（出口 URL
 * 规范化之后落在哪里，含 `..` 那一档的如实登记）。
 * ⚠️ 这两条原来写的是「各有一条单测钉着」，而当时 `/v1` 那条只有一句附带的 URL
 * 断言、网关口令那条**一条都没有**（全分支评审 C3）。
 *
 * **401 = 会话失效；403 明确不当会话失效。**
 * 后者是照抄 kiro2api 用中文注释警告过的那个坑：它老写法把业务 403 当掉线，
 * 管理员拒绝一次授权就被踢出后台并被告知「密钥无效」。
 * 两条对称用例钉着这一对：`tests/ui/api-session.test.ts:187` 与 `:197`。
 * ⚠️ 这句原来也在宣称「两条对称用例进单测」，而当时是**零条**：把下面
 * `res.status === 401` 改成 `|| res.status === 403` 之后 1357 条全绿
 *（全分支评审 C3 实测）。
 */
import { sessionExpired } from "./pure/session.mjs";
// 键名的单一真源，见该模块文件头（全分支评审 C4）。**别在这里再声明一遍**：
// 写入方是 `app.js`，两处分叉会让面板登录成功之后每个请求都送空口令头。
import { KEY_STORE, SAVED_AT_STORE } from "./pure/storage-keys.mjs";

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

/**
 * 会话是不是已经到达绝对上限。判定在 `js/pure/session.mjs`，这里只喂参数。
 *
 * ⚠️ **为什么这一判必须在每个请求上做，而不是只在 `app.js` 启动那一次做。**
 * 面板是**常驻**的：事件在轮询、Key 池有自动刷新，运维把标签页开一整天是常态。
 * 只在模块加载那一次判的话，12 小时到点后这个标签页照样拿着那把口令继续打接口
 * ——而五语言 DEPLOY.md 逐字承诺「面板会在 12 小时后要求重新输入口令」，
 * 那就成了**一句被测试保护起来、却在最常见的路径上不成立的承诺**。
 * `js/pure/session.mjs` 开头那句「可用期从永远压到最多 12 小时」也要有这一判才成立。
 *
 * 放在**发请求之前**：过期就不发，与前端字符集拦截同一个道理——送出去也没用，
 * 而且会在服务端留下一条无意义的 `admin.login_failed`。
 */
function expired() {
  try {
    return sessionExpired(Number(localStorage.getItem(SAVED_AT_STORE)), Date.now());
  } catch (e) {
    // 隐私模式下 localStorage 抛错：读不到时刻 ⇒ 与 sessionExpired 同一个方向，fail closed。
    return true;
  }
}

export async function raw(method, path, body, init) {
  // **会话绝对上限，每请求复查一次**（见 expired 的说明）。走的是与 401 完全相同的
  // 那条通路：`unauthorizedHandler()` 清会话 + 回登录闸，再抛同一个 ApiError ——
  // 调用方（各板块的轮询/刷新）已经会处理 401，不需要为过期再认一种新错误。
  if (expired()) {
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(401, "session_expired", null);
  }
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
  get:   (p, init) => json("GET", p, undefined, init),
  post:  (p, b, init) => json("POST", p, b, init),
  put:   (p, b, init) => json("PUT", p, b, init),
  // P3c Task 4：Key 池的行内动作（停用/启用/清冷却/解除剔除/备注）都是
  // `PATCH /admin/api/keys/:id`，此前没有任何调用方需要这个动词。
  patch: (p, b, init) => json("PATCH", p, b, init),
  del:   (p, init) => json("DELETE", p, undefined, init),
  raw,
};
