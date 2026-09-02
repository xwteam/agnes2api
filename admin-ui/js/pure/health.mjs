/**
 * 顶栏那颗服务状态徽章的**取值决策**（纯逻辑，无 DOM、无网络）。
 * 打 `/health` 与写徽章在 `admin-ui/js/health.js`，那边只剩一次网络调用与几行 DOM。
 *
 * ── 为什么数据源是 `/health` ────────────────────────────────────────────────
 * 它是网关**唯一不鉴权**的状态端点，且刻意不触发任何存储 IO（见
 * `src/http/routes/health.ts`）。可写时 200 `{status:"ok"}`，数据目录不可写时
 * **503** `{status:"degraded"}` —— 后者是真话，镜像内置的 HEALTHCHECK 也认这一条。
 *
 * ⚠️ **不许放一个恒为「运行中」的徽章。** 一颗永远绿的灯与一颗没有灯，在运维那里
 * 是同一个信息量；而它比没有灯更糟，因为它会被当成一次真的探测。所以这里有三档，
 * **第三档是「不知道」而不是「运行中」**：
 *   · `ok`        —— 应答体里 `status === "ok"`（**不看 HTTP 状态码**，理由见下面那条 ⚠️）；
 *   · `degraded`  —— 拿到了应答且 `status === "degraded"`（今天只有存储不可写这一种）；
 *   · `unknown`   —— **其余全部**：网络失败、应答不是 JSON、`status` 是个没见过的值。
 *     它是 fail-closed 的那一档：判不出来就说判不出来，不许滑进 `ok`。
 *
 * ⚠️ **`unknown` 不叫「离线」也不叫「不可达」**，那两个说法都比这里知道的多：
 * 面板自己的页面是从同一个源发过来的，能看到这颗徽章就说明网关刚才还在；探测失败
 * 可能只是这一次请求被中断。**判据能证明的只有「最近这一次没拿到可识别的应答」。**
 */

/** 三档状态各自的 i18n key。徽章的文案由这张表决定，`health.js` 不另写一份。 */
export const HEALTH_TEXT_KEY = {
  ok: "shell.status.ok",
  degraded: "shell.status.degraded",
  unknown: "shell.status.unknown",
};

/** 三档状态各自的徽章配色类。`unknown` 刻意不给颜色——`.badge` 的底样式本身是中性灰。 */
export const HEALTH_BADGE_CLASS = {
  ok: "badge-ok",
  degraded: "badge-warn",
  unknown: "",
};

/**
 * 一次 `/health` 探测的结果 → 徽章要显示的那一档。
 *
 * `probe` 是 `{ status, body }`（`status` 是 HTTP 状态码，`body` 是解析出来的 JSON，
 * 解析不了就是 `null`）；网络层自己失败时传 `null`。
 *
 * ⚠️ **不看 HTTP 状态码，只看应答体里的 `status`。** 降级那一档回的是 503，
 * 按「`res.ok` 才算数」写的话它会掉进 `unknown`，而那恰恰是最该被看清的一档。
 * 反过来也不许只信状态码：200 配一个认不出来的应答体同样是「不知道」。
 */
export function healthState(probe) {
  if (!probe || probe.body === null || typeof probe.body !== "object") return { kind: "unknown" };
  const s = probe.body.status;
  if (s === "ok") return { kind: "ok" };
  if (s === "degraded") return { kind: "degraded" };
  return { kind: "unknown" };
}

/** 一档状态的文案 key 与配色类。认不出来的档一律按 `unknown` 走（同样是 fail-closed）。 */
export function healthBadge(kind) {
  const k = HEALTH_TEXT_KEY[kind] ? kind : "unknown";
  return { textKey: HEALTH_TEXT_KEY[k], cls: HEALTH_BADGE_CLASS[k] };
}
