import type { Context } from "hono";

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/**
 * IPv6 的**形态**校验，刻意不做完整语法检查（`::` 只许出现一次、段数上限这些一概不管）。
 * 目的说清楚：这条校验要保证的不是「它是一个合法 IPv6」，而是**这个字段不可能承载
 * 攻击者的任意文本**——只有十六进制、冒号与点（`::ffff:192.0.2.1` 这种映射形态）能进来，
 * 空格、`=`、引号、HTML、控制字符统统被挡在外面。做全套 RFC 4291 解析换不到额外的安全性，
 * 却会引入一堆自己写错的机会。
 */
const IPV6ISH = /^[0-9a-f:.]{2,45}$/i;

/**
 * 取一个**形态合法**的 IP，否则 `null`。
 *
 * 为什么必须有它：这个值原样进 `admin.login_failed` 的 `ip=` 字段，而那条日志是设计
 * 文档承诺的唯一爆破痕迹。零校验时实测记下来的是 `ip="not-an-ip-at-all <img src=x>"`
 * ——面板的事件板块要按这个字段做筛选、聚合、展示，一个能装任意文本的字段
 * 在那里就是注入源。**记 `null` 比记一个假 IP 诚实**，与「拿不到就记 null，绝不伪造
 * 一个 "unknown"」是同一条规矩。
 */
function ipOrNull(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  if (IPV4.test(s)) return s;
  // 必须含冒号：否则 `1.2.3.4.5`、`abc` 这类会被 IPV6ISH 放行。
  if (s.includes(":") && IPV6ISH.test(s)) return s;
  return null;
}

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
 * ③ **两个头都过一遍形态校验**（见 ipOrNull）。门控之内并不等于「值一定干净」：
 *    `TRUST_PROXY=1` 的另一种常见形态是网关挂在自建 nginx / Caddy 后面，那时
 *    `CF-Connecting-IP` **没有任何人会覆盖**，攻击者自己带一个就会**优先于**反代
 *    写的 `X-Forwarded-For` 胜出。这条不是鉴权/限速绕过（全仓只有这一个消费点），
 *    但它决定了写进审计行的那个值，所以宁可记 `null` 也不记一段任意文本。
 *    **通用反代形态请在反代上把 `CF-Connecting-IP` 剥掉**，五语言 DEPLOY.md 有命令。
 *
 * 拿不到时如实返回 `null`，**绝不伪造一个 "unknown" 字符串冒充 IP**：
 * 面板显示「—」是诚实的，显示 "unknown" 会被当成一个真实来源。
 */
export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (!trustProxy) return null;

  const cf = ipOrNull(c.req.header("cf-connecting-ip"));
  if (cf) return cf;

  return ipOrNull(c.req.header("x-forwarded-for")?.split(",")[0]);
}
