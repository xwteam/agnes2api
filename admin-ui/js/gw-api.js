/**
 * **Playground 专用**的对外网关出口。与 `js/api.js` 严格隔离（设计 §10.5）。
 *
 * ⚠️ **两把钥匙的隔离是双向的，两边各有一条断言**：
 * · `js/api.js` 只发 `x-admin-key`、只打管理那棵树
 *   （`tests/ui/api-session.test.ts` 的「凭据头只有 x-admin-key —— 没有任何网关口令头」
 *    与「没有任何调用方给 api.* 传含 `..` 或以 http 开头的 path」两格钉着）；
 * · 本模块只发网关口令、只打对外那棵树，**一个 `x-admin-key` 都不许出现**
 *   （`tests/ui/gw-api.test.ts` 的
 *    「凭据头里没有 x-admin-key —— 管理口令绝不许走上对外那条路」钉着）。
 *
 * ⚠️ **网关口令由用户手动粘贴，存在与管理口令分开的另一个存储键**
 * （`js/pure/storage-keys.mjs` 的 `GW_KEY_STORE`，理由全文在那里）。
 * 面板拿不到明文网关口令——`GET /admin/api/config` 对 `gatewayToken` 只回
 * `{ configured, hint }`（设计 §8.6「凭据只写不读」）。
 * **别想着做「一键填入我的口令」，那需要在后端开一个明文回显口子。**
 *
 * ⚠️ **口令只走请求头，禁止查询参数。** 对外那棵树的鉴权确实收查询参数
 * （`src/http/middleware/auth.ts`，为 Gemini 协议兼容），**但面板不继承它**：
 * 口令进 URL 会落进浏览器历史、Referer、CF 访问日志、反代日志。
 * 这与设计 §8.3 对管理端点的禁令是同一条理由，只是这次进 URL 的是网关口令。
 * 由 `tests/ui/gw-api.test.ts` 的
 * 「口令只在请求头里，URL 上一个字节都没有 —— 进 URL 就会落进历史与各级访问日志」钉着。
 *
 * ⚠️⚠️ **这是全站第三个网络出口。** 另两个是 `js/api.js` 的 `raw()` 与 `js/app.js` 的
 * 登录探针。三个出口这件事由 `tests/ui/api-session.test.ts` 的
 * 「恰好三处：api.js 的 raw()、app.js 的登录探针、gw-api.js 的网关出口」那格数着钉住。
 * ⚠️ 那张枚举表**曾经漏掉三种写法**（`new WebSocket(` / 动态 `import(` /
 * 把 fetch 先存进变量再调），本模块落地时把三种一并补进去并各种了一次探针。
 * 它仍然沿另一条轴漏一族：**带花括号的插值会被整条抠掉**——本模块因此**不许**把
 * 这里唯一那次真调用写进任何模板串的插值里。
 *
 * ⚠️ **本模块不拼任何端点路径。** URL 整条由 `js/pure/playground.mjs` 的
 * `buildRequest()` 用「运行期的 origin + 目录给的路径模板」拼出来，本文件只负责把它
 * 送出去。全局约束 15：四个消费者只许有一份「怎么调这个网关」的知识。
 */
import { GW_KEY_STORE } from "./pure/storage-keys.mjs";
import { authHeaderValue, sseFrames } from "./pure/playground.mjs";

/** 这次请求为什么没发出去 / 没读回来。**只有档位名，永不含口令或响应体。** */
export class GatewayError extends Error {
  constructor(code) {
    super(code);
    this.name = "GatewayError";
    this.code = code;
  }
}

/** 浏览器里存着的那把网关口令。隐私模式下读不到就是空串（与 `js/api.js` 同一个方向）。 */
export function readGatewayToken() {
  try {
    return localStorage.getItem(GW_KEY_STORE) || "";
  } catch (e) {
    return "";
  }
}

/**
 * 存下这把口令。**空串 = 清掉**，不是存一个空值：留着一个空串会让下次进来时
 * 「粘过但清空了」与「从来没粘过」分不开。
 */
export function writeGatewayToken(value) {
  try {
    if (value === "") localStorage.removeItem(GW_KEY_STORE);
    else localStorage.setItem(GW_KEY_STORE, value);
  } catch (e) { /* 隐私模式：本次会话照常可用，刷新后要重新粘 */ }
}

/**
 * 发一次对外请求。
 *
 * @param req    `buildRequest()` 交出来的那份（`url` / `method` / `headerName` / `body`）。
 * @param token  网关口令。**调用方负责拦「还没粘口令」那一档**，见 `buildRequest` 的说明。
 * @param opts   `{ origin, signal }`。
 *
 * ⚠️⚠️ **同源自查：口令只许送去面板自己所在的那个源。** URL 是拿运行期的 origin 拼的，
 * 正常情况下它恒同源；这一判把「同源」从一条**推导出来的**性质变成一条**被检查的**性质
 * ——一份被改过的协议目录（管理接口被穿透、或反代插了一手）足以把路径模板换成一条指向
 * 别处的地址，而那一刻这里送出去的是**发给每一个下游用户的那把中转口令**。
 * 判失败时**一个字节都不发**。由 `tests/ui/gw-api.test.ts` 的
 * 「目录把路径换成了别的源：一个字节都不发 —— 送出去的是发给每个下游用户的那把口令」钉着。
 *
 * ⚠️ **同源自查只管「第一条 URL」，跨源重定向必须另外堵**（评审发现）。
 * `fetch` 的 `redirect` 默认是 `follow` ⇒ 同源那条路径回一个 302 指向别处时，
 * 浏览器会**跟过去**，而这一判早在发请求之前就做完了、对它完全不设防。
 * ⚠️⚠️ **不能指望浏览器替我们剥掉那个头**：Fetch 规范里
 * **CORS non-wildcard request-header name 只有 `authorization` 一个**，
 * 跨源重定向时只删它。而四条协议里 **Anthropic 用 `x-api-key`、Gemini 用 `x-goog-api-key`，
 * 这两个不会被删**，会原样跟着 302 送到新源——**那一刻送出去的仍是发给每一个下游用户的
 * 那把中转口令**。而且在本模块自己声明的那个威胁模型里
 * （「管理接口被穿透、或反代插了一手」），**让同源某条路径 302 比篡改协议目录更容易**。
 * ⇒ **`redirect: "error"`**：本项目对外五条端点没有任何合法重定向，
 * 一次重定向在这里只可能是异常。由 `tests/ui/gw-api.test.ts` 的
 * 「重定向一律当错误处理 —— 跟过去的话 x-api-key / x-goog-api-key 会被原样带到新源」钉着。
 *
 * ⚠️ **`credentials: "omit"`**：本项目没有 Cookie 会话，带上只会扩大攻击面
 * （与 `js/api.js` 同一条）。
 *
 * ⚠️ **失败一律抛 `GatewayError`，错误里只带档位名。** 别把 `err.message` 拼成
 * 「请求 X 失败，头是 Y」那种诊断串——那正是口令漏进错误文案的路径（全局约束 11(b)）。
 */
async function openGateway(req, token, opts) {
  const origin = opts && typeof opts.origin === "string" ? opts.origin : "";
  let target = null;
  try {
    target = new URL(String(req.url));
  } catch (e) {
    throw new GatewayError("bad_url");
  }
  if (origin === "" || target.origin !== origin) throw new GatewayError("cross_origin");

  const headers = {};
  headers[String(req.headerName)] = authHeaderValue(req.headerName, token);
  headers["content-type"] = "application/json";

  try {
    return await fetch(target.href, {
      method: String(req.method),
      headers,
      body: JSON.stringify(req.body),
      credentials: "omit",
      // **同源自查只管第一条 URL**，跟过去的重定向它管不着 —— 见上面那段 ⚠️。
      redirect: "error",
      signal: opts && opts.signal,
    });
  } catch (e) {
    // 断网 / 被取消 / CORS 挡下：**这次请求没有拿到任何响应**，与上游的状态无关。
    throw new GatewayError("transport_error");
  }
}

/** 响应体当 JSON 读一遍。**读不出来是 `null`，不是空对象**（后者与「上游回了个空对象」同形）。 */
async function readJson(res) {
  try {
    return await res.json();
  } catch (e) {
    // 非 JSON 响应（网关自己的 502 页、反代的错误页）。
    return null;
  }
}

/**
 * 发一次**非流式**请求，把整份响应体读回来。
 *
 * @param req    `buildRequest()` 交出来的那份（`url` / `method` / `headerName` / `body`）。
 * @param token  网关口令。**调用方负责拦「还没粘口令」那一档**，见 `buildRequest` 的说明。
 * @param opts   `{ origin, signal }`。**`origin` 不传就是一个字节都不发**（见 `openGateway`）。
 *
 * ⚠️ **`contentType` 是媒体模式落地时补的一格，它把一个二义性拆开了。**
 * 在它之前，`body === null` 同时表示两件事：「响应是 JSON 但解析不了」与
 * 「响应根本不是 JSON」。对话四条协议下后者不会发生，**媒体那两档下它是常态**
 * ——`src/http/routes/media.ts` 的文件头写着「上游返回什么（地址或字节流）就原样转发」，
 * 而字节流那一档在面板上必须说成「这次回的是一段字节，不是一份可展示的结果」，
 * 不能说成「读不出来」。判据因此建在响应头上，**不是靠猜**。
 * ⚠️ **读法不变**：仍然无条件走一次 `readJson()`，对话四条协议逐字保持原行为。
 */
export async function sendToGateway(req, token, opts) {
  const res = await openGateway(req, token, opts);
  // 头缺失时是空串而不是 `null`：下游只拿它做前缀判定，两种「没有」没必要分开。
  const contentType = res.headers.get("content-type") || "";
  return { status: res.status, ok: res.ok, contentType, body: await readJson(res) };
}

/**
 * 发一次**流式**请求，一块一块地把 SSE 的 `data:` 负载交给 `opts.onPayload`。
 *
 * ⚠️⚠️ **它与 `sendToGateway()` 共用同一个 `openGateway()`，这不是省代码、是安全要求。**
 * 同源自查、`redirect: "error"`、`credentials: "omit"`、「口令只走请求头」这四条
 * 全部长在那个函数里。**流式如果自己另写一次 `fetch`，这四条就各有了第二份**，
 * 而它们里面每一条漏掉的后果都是「把发给每一个下游用户的那把中转口令送去别处」。
 * 由 `tests/ui/gw-api.test.ts` 的
 * 「流式与非流式走同一道同源自查 —— 两条路各写一份的话，漏掉的那份会把口令送去别处」
 * 逐条对着钉（同一组判据在两条路上各断言一遍）。
 * ⚠️ 顺带：本文件因此仍然**只有一处** `fetch(`，`tests/ui/api-session.test.ts` 的
 * 「恰好三处：api.js 的 raw()、app.js 的登录探针、gw-api.js 的网关出口」那张表
 * 不必跟着放宽——**那张表一旦开始跟着代码放宽就不再守任何东西**。
 *
 * ⚠️ **不用 `EventSource`**：它设不了请求头（设计 §7.2 因此否掉了它），
 * 而网关口令必须走头、不许进 URL（见文件头那段）。⇒ 手工 `fetch` + `ReadableStream`。
 *
 * ⚠️ **跨块切分由 `js/pure/playground.mjs` 的 `sseFrames()` 处理**，本函数只负责
 * 「攒—切—把尾巴留着」这个循环。判据与理由全文在那个函数上方。
 *
 * ⚠️ **上游不 ok 时不进读流那条路**：网关的错误响应是 JSON（不是 SSE），
 * 拿 SSE 解析器去读它会得到零条负载 ⇒ 面板显示一次「什么都没发生」的成功流式。
 * 那一档改走 `readJson()`，与非流式同一条渲染路径。
 *
 * @param opts `{ origin, signal, onPayload }`。`onPayload` 收到的是**原始负载字符串**，
 *   **本模块不解析它、也不知道哪条协议的正文在哪一格**——那是协议目录的知识，
 *   由调用方拿 `deltaText()` 就着 `proto` 取（全局约束 15）。
 * @returns 与 `sendToGateway()` 同形，外加 `streamed`：
 *   `true` = 真的走了读流那条路；`false` = 上游没 ok，`body` 里是那份错误响应。
 */
export async function streamFromGateway(req, token, opts) {
  const res = await openGateway(req, token, opts);
  if (!res.ok || !res.body) {
    return { status: res.status, ok: res.ok, body: await readJson(res), streamed: false };
  }
  const onPayload = opts && typeof opts.onPayload === "function" ? opts.onPayload : () => {};
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      // **`{ stream: true }`**：一个多字节字符同样可能被拆在两个 chunk 之间。
      // 不带这个标志的话，中文/emoji 会在切点上变成替换符（U+FFFD），
      // 而那在本机的 ASCII 假上游下**一个字都看不出来**。
      buf += decoder.decode(step.value, { stream: true });
      const found = sseFrames(buf);
      buf = found.rest;
      for (const p of found.payloads) onPayload(p);
      if (found.done) break;
    }
    // 流可能不以完整的空行结尾（连接中断、反代截断）。**把解码器里滞留的字节 flush 出来，
    // 再把剩下的当成最后一帧处理**，否则最后一个事件会被静默丢弃
    //（网关读上游那一侧 `src/core/protocol/sse.ts` 做的是同一件事，同一条理由）。
    //
    // ⚠️ **补一个 `\n\n` 对 CRLF 尾巴同样成立**：尾巴是 `…\r\n` 时接上这两个 `\n`
    // 就凑出了一个 `\n\n` 边界，`\r` 由 `sseFrames()` 里那句 `.trim()` 吃掉。
    // ⚠️⚠️ **但这一句只在正常读完时才跑**：下面 `catch` 那条路上它根本不跑
    //（`throw` 从循环里直接跳出去）。早先 `sseFrames()` 不认 `\r\n\r\n`，
    // 于是 CRLF 上游的全部负载都攒在 `buf` 里等着这一句来捞
    // ⇒ **中途断流时一条都交不出去（实测 LF 2 条 / CRLF 0 条）**。
    // ⇒ **这一句是兜底，不是分帧**；真正的分帧必须发生在上面那个循环里。
    buf += decoder.decode();
    for (const p of sseFrames(`${buf}\n\n`).payloads) onPayload(p);
  } catch (e) {
    // 读到一半断了。**已经交出去的那几块留着**——运维看到的半句话是真的发生过的，
    // 抹掉它比留着更不诚实；调用方据这个错误在那一轮后面补一句「这条流没读完」。
    throw new GatewayError("stream_error");
  } finally {
    // 释放上游连接。已经读完时它是个空操作。
    reader.cancel().catch(() => {});
  }
  return { status: res.status, ok: true, body: null, streamed: true };
}
