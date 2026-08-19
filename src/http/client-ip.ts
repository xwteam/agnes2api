import type { Context } from "hono";

/**
 * 客户端 IP。这个值会被写进 `admin.login_failed` 事件，**因此伪造它就等于把爆破
 * 痕迹嫁祸给任意 IP**——所以两个转发头都**不是无条件可信**的。
 *
 * ① **门控**：`TRUST_PROXY` 之外一律返回 `null`，`CF-Connecting-IP` 也不例外。
 *    它常被说成「平台注入、不可伪造」，但那个性质只在**请求真的经过 Cloudflare**
 *    时成立；Node/Docker 直连暴露时没有任何东西会覆盖这个头，客户端自己发一个
 *    `CF-Connecting-IP: 1.2.3.4` 就算数。而直连正是 Docker 部署的默认形态。
 *
 * ② **门控之内，`CF-Connecting-IP` 优先，`X-Forwarded-For` 只作兜底**。两个头的
 *    可伪造性根本不同：
 *    · `CF-Connecting-IP` 由 Cloudflare 边缘写入，且会**覆盖**客户端传来的同名头，
 *      所以请求真的经过 CF 时伪造不了。**Worker 形态下 CF 定义上就在前面**，它是
 *      那里的权威值。
 *    · `X-Forwarded-For` 是任何中间件都能追加的链，客户端可以自己发一个假的，
 *      可信与否完全取决于你的代理链长什么样。
 *    因此在 Worker 上优先 XFF 是错的——那里 XFF 里可能装着客户端塞的垃圾，而权威
 *    值就在旁边。
 *
 * 拿不到时如实返回 `null`，**绝不伪造一个 "unknown" 字符串冒充 IP**：
 * 面板显示「—」是诚实的，显示 "unknown" 会被当成一个真实来源。
 */
export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (!trustProxy) return null;

  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf;

  const xff = c.req.header("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || null;
}
