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
 * 🔴 **`unavailable` 与 `failed` 必须分开，不许并成「取不到」。**
 * 前者是「这把密钥签发在明文落盘之前，服务端从来就没有过它的明文」——
 * 一个**永远不会变**的事实，运维该做的是重发一把；
 * 后者是「这一次没拿到」（网络断了、401、500），**重试可能就好了**。
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

/** 三态各自的五语言文案键。表外不兜底 —— 与本仓其余「表外返回 null」同一条纪律。 */
export function revealMessageKey(outcome) {
  if (outcome.state === "unavailable") return "reveal.unavailable";
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
