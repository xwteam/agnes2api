/**
 * 「掩码 / 点击显示明文 / 复制」这一族的**纯函数**部分。
 *
 * 两个板块共用：**Key 池**（上游 Agnes key）与 **API 密钥**（网关签发的 sk-）。
 * 两者的端点、字段名、"取不到"的成因各不相同，但交互与状态机逐字相同 ——
 * 把状态机放在这里，DOM 那半各自写各自的。
 *
 * ⚠️ **这个模块不碰 DOM、不发请求**（与 `admin-ui/js/pure/` 下其余模块同一条纪律：
 * 纯函数才好在 `tests/ui/` 里不起浏览器地验）。取数由调用方注入。
 */

/**
 * 两族的差异**只在这张表里**，别在调用点写 if。
 *
 * · `path` —— 取明文的端点；
 * · `field` —— 响应体里装明文的字段名（两族刻意不同名，见各自 handler 的说明）。
 */
export const REVEAL_KINDS = {
  /** 上游 Agnes key。这一族**本来就以明文存**（要拿去打上游），reveal 没有引入新的存储风险。 */
  pool: { path: (id) => `/keys/${encodeURIComponent(id)}/reveal`, field: "key" },
  /** 网关签发给客户端的 sk-。2026-09-10 起明文一并落盘，代价见 `ApiKeyRecord.secret`。 */
  apikey: { path: (id) => `/apikeys/${encodeURIComponent(id)}/reveal`, field: "secret" },
};

/**
 * 把一次 reveal 的响应**归一化成三态**，供 UI 直接选文案。
 *
 * ⚠️⚠️ **它只吃 2xx 的响应体，别把「三态」读成「三条路都走得到」**（本轮评审实测订正）：
 * `admin-ui/js/api.js` 的 `json()` 对任何非 2xx 都抛 `ApiError` ⇒ 那一族**根本进不了
 * 这个函数**，得由下面的 `revealErrorOutcome()` 接。上一版这里（以及下面 `failed`
 * 那一档的说明）逐字写着 `failed` 治的是「网络断了、401、500」，而当时
 * `revealControls()` 的 `load()` 没有 `try/catch` ⇒ 那三个成因里有两个到不了这一档，
 * 它们落成一条无人接的 promise 拒绝，屏幕上一个字都不变。
 * **举的例子到不了自己写的那一档，是这条缺陷唯一的书面痕迹**，别把它删了了事。
 *
 * 🔴 **`unavailable` 与 `failed` 必须分开，不许并成「取不到」。**
 * 前者是「这把密钥签发在明文落盘之前，服务端从来就没有过它的明文」——
 * 一个**永远不会变**的事实，运维该做的是重发一把；
 * 后者是「这一次没拿到」，**重试可能就好了**。
 * 把两者混成一句话，会让人对着一把永远取不回的密钥反复点。
 *
 * ⚠️ **`ok` 那一档要求明文是非空字符串**：后端约定 `secret: null` 表示前一档，
 * 而空串既不是 null 也不是可用明文 —— 真出现只可能是坏数据，按失败处置，
 * **绝不把空串当明文塞进剪贴板**。
 */
export function revealOutcome(body) {
  if (body === null || typeof body !== "object") return { state: "failed" };
  const kinds = Object.values(REVEAL_KINDS);
  for (const k of kinds) {
    if (k.field in body) {
      const v = body[k.field];
      if (typeof v === "string" && v !== "") return { state: "ok", secret: v };
      // 后端明说了「签发于明文落盘之前」这一档。
      if (v === null && body.reason === "issued_before_plaintext") {
        return { state: "unavailable", reason: "issued_before_plaintext" };
      }
      return { state: "failed" };
    }
  }
  return { state: "failed" };
}

/**
 * **抛出来的那一族**（`admin-ui/js/api.js` 的 `ApiError`，以及 `fetch` 自己抛的
 * `TypeError`）→ 与上面同一套形状的 outcome。
 *
 * 🔴 **它存在的全部理由：那两颗按钮在任何 HTTP 错误下曾经是「点了什么都不会发生」。**
 * `load()` 里那一句 `await o.fetchSecret(o.id)` 从前没有 `try/catch`，而 `json()` 对
 * 任何非 2xx 一律抛 ⇒ 异常穿过 `load()` 落在两个 `async` 点击监听器上无人接，
 * 全站也没有 `unhandledrejection` 兜底 ⇒ 屏幕上一个字不变、剪贴板里什么都没有，
 * 只有开发者工具的控制台里一条拒绝。**本仓的纪律是「点了什么都不会发生的按钮比没有更糟」**
 *（同一族的其它行内动作全都写着 `.catch(e => toast(...))`）。
 *
 * ⚠️ **404 单独一档（`gone`），不许并进 `failed`。** Key 池那张表是轮询刷新的：
 * 一把 key 在另一个标签页被删、被别的副本剔除之后，这一行还在屏幕上，而它的 reveal
 * 一定是 404。那一档的处置是「刷新一下列表」，`failed` 那一档的处置是「等一会儿再点」
 * ——把它们并成一句话，运维会对着一条已经不存在的记录反复点
 *（与上面 `unavailable` / `failed` 不许并档是同一条纪律）。
 *
 * ⚠️ **401 刻意落在 `failed`，不另起一档，明写理由**：`api.js` 对 401 已经先
 * `unauthorizedHandler()` 清凭据 + 弹登录闸了，那一屏本身就是最强的反馈；而
 * 「这一次没取到明文，稍后再试」对它**也是真话**（重新登录之后再点就是了）。
 * 为它单开一句话只会在登录闸上叠一句更长的解释。
 *
 * ⚠️ **判据是 `status`，不是 `err.body.error.code`**：那个码由后端定义
 *（`key_not_found` / `apikey_not_found` 两族各一个），照它分档就等于在前端抄一份
 * 后端的错误码表，而这一族只需要分「没有这条记录」与「这一次没成」两种处置。
 *
 * @returns {{state:"gone"}|{state:"failed"}}
 */
export function revealErrorOutcome(err) {
  const status = err !== null && typeof err === "object" && typeof err.status === "number" ? err.status : 0;
  if (status === 404) return { state: "gone" };
  return { state: "failed" };
}

/** 四态各自的五语言文案键。表外不兜底 —— 与本仓其余「表外返回 null」同一条纪律。 */
export function revealMessageKey(outcome) {
  if (outcome.state === "unavailable") return "reveal.unavailable";
  if (outcome.state === "gone") return "reveal.gone";
  if (outcome.state === "failed") return "reveal.failed";
  return null;
}

/**
 * 一行/一张卡的显示状态机。
 *
 * **明文只活在这个对象里，不写回列表数据**：列表随轮询整份重建，把明文塞进去
 * 会让它跟着进下一次渲染、进任何对列表做的序列化。切板块、刷新 ⇒ 自动回到掩码。
 */
export function createRevealState() {
  const shown = new Map();
  return {
    /** 这一条现在是不是明文态。 */
    isShown: (id) => shown.has(id),
    /** 取已经拿到的明文；没取过就是 `null`。 */
    secretOf: (id) => shown.get(id) ?? null,
    remember: (id, secret) => { shown.set(id, secret); },
    hide: (id) => { shown.delete(id); },
    /** 切板块 / 整表重建时调用：**明文不跨渲染存活**。 */
    clear: () => { shown.clear(); },
  };
}
