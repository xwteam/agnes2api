/**
 * 顶栏那颗服务状态徽章：打一次 `/health`，把结果写进徽章。
 *
 * **取值决策一个字都不在这里**，全在 `js/pure/health.mjs`（三档怎么分、认不出来算哪一档），
 * 由 `tests/ui/health.test.ts` 的
 * 「反向自检：这几格不是恒等于 unknown —— 上面那两格真的分得出来」等几格跑着。
 * 这个文件只剩一次网络调用与几行 DOM。
 *
 * ── 这是全站第四个网络出口，那件事本身有一格数着 ────────────────────────────
 * 另三个是 `js/api.js` 的 `raw()`、`js/app.js` 的登录探针、`js/gw-api.js` 的网关出口。
 * 数量由 `tests/ui/api-session.test.ts` 的
 * 「恰好四处：api.js 的 raw()、app.js 的登录探针、gw-api.js 的网关出口、health.js 的健康探针」
 * 数着钉住，加第五个会变红。
 *
 * **这一处刻意不走 `api.js`**，两条理由：
 * ① `api.js` 只打 `/admin/api/*` 且**每次都送 `x-admin-key`**，而 `/health` 是不鉴权端点
 *    ——把管理口令送去一个不需要它的端点，等于凭空多一条口令离开页面的路径；
 * ② `api.js` 的 401 会走 `onUnauthorized()` 把人踢回登录闸，而 `/health` 的任何失败
 *    都不该动会话。
 * ⇒ **这个出口一条凭据头都不带。** 由 `tests/ui/api-session.test.ts` 的
 * 「健康探针一条凭据头都不带 —— 它打的是不鉴权端点」钉着。
 *
 * ── 什么时候探 ──────────────────────────────────────────────────────────────
 * 进壳层时探一次，之后**只在用户点这颗徽章时**再探。**刻意没有定时轮询**：
 * 一颗每 30 秒自己刷新的徽章要在整个会话期间挂一个定时器，而它回答的那个问题
 * （「网关还在不在」）在面板真的用不了的时候，各个板块自己的请求会先一步报错。
 * 徽章上写的是「最近一次探测」，不是「此刻」——两者的差别写进了它的悬停提示里。
 */
import { t } from "./i18n.js";
import { healthState, healthBadge } from "./pure/health.mjs";

const BADGE_ID = "health-badge";

/** 打一次 `/health`。**任何失败都收敛成 `unknown`**，不往外抛。 */
async function probeHealth() {
  try {
    const res = await fetch("/health", { credentials: "omit" });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return healthState({ status: res.status, body });
  } catch (e) {
    return healthState(null);
  }
}

/** 把一档状态写进徽章：文案走 i18n，配色走 `.badge-*`。 */
function paint(el, kind) {
  const { textKey, cls } = healthBadge(kind);
  // **`data-i18n` 是动态换上去的**：切语言时框架层的 `apply(document)` 会照着它重刷，
  // 这个文件因此不必自己监听 langchange（板块内不许各自监听，见 `js/app.js` 文件头）。
  el.setAttribute("data-i18n", textKey);
  el.textContent = t(textKey);
  el.className = cls ? `badge health-badge ${cls}` : "badge health-badge";
}

/** 探一次并刷新徽章。徽章不在页面上（例如还在登录闸）时什么都不做。 */
export async function refreshHealth() {
  const el = document.getElementById(BADGE_ID);
  if (!el) return;
  const { kind } = await probeHealth();
  paint(el, kind);
}

/** 接线：点徽章重新探一次。**只接一次**，由调用方保证（`js/app.js` 的模块顶层）。 */
export function wireHealth() {
  const el = document.getElementById(BADGE_ID);
  if (!el) return;
  el.addEventListener("click", () => { refreshHealth(); });
}
