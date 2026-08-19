import type { Context } from "hono";

/**
 * 客户端 IP。这个值会被写进 `admin.login_failed` 事件，**因此伪造它就等于把爆破
 * 痕迹嫁祸给任意 IP**——所以默认**不信** `X-Forwarded-For`，只有部署者显式声明
 * `TRUST_PROXY=1`（自己在反代后面）时才取它的首段。
 *
 * 拿不到时如实返回 `null`，**绝不伪造一个 "unknown" 字符串冒充 IP**：
 * 面板显示「—」是诚实的，显示 "unknown" 会被当成一个真实来源。
 */
export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    const first = xff?.split(",")[0]?.trim();
    if (first) return first;
  }
  // Worker 形态由平台注入，客户端改不了。Node 形态下 @hono/node-server 不把直连
  // 地址放进请求头，所以没有反代时这里就是 null——这是事实，不是缺陷。
  return c.req.header("cf-connecting-ip") ?? null;
}
