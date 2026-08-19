import type { MiddlewareHandler } from "hono";
import type { Logger } from "../../ports/logger.js";
import { clientIp } from "../client-ip.js";

/**
 * 常数时间比较：先比长度，再逐字节异或累加，**中途不提前 return**。
 *
 * 长度本身会泄漏（长度不同时立刻 false），这是标准取舍：口令是 ≥24 位的随机串，
 * 泄漏长度不构成可利用的信息，而为了藏长度去做定长填充只会让实现更容易写错。
 *
 * ⚠️ **常数时间这个性质无法用单元测试证明**：把整个函数换成 `a === b`、或者把
 * 循环体改成 `if (a[i] !== b[i]) return false`，行为完全等价，全套测试照样绿
 *（已实测，见 Task 5 报告的变异表）。它只能靠**评审逐字核对**——循环体里出现
 * 任何提前 return / break / 短路运算，就是回归。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const ADMIN_TOKEN_MIN_LENGTH = 24;

export interface AdminTokenCheck {
  ok: boolean;
  reason?: "too_short" | "same_as_gateway_token";
}

/**
 * 管理口令的两条硬规则。
 *
 * ① 长度下限 24：Worker 形态**没有分布式限速**（做它要拿 KV 当窗口，等于给攻击者
 *    一根消耗写配额的杠杆，能把 DoS 面从「猜口令」扩大到「打死 key 池的状态回写」）。
 *    因此口令熵就是唯一的防线，下限不是建议值。
 * ② 不得等于 GATEWAY_TOKEN：后者是发给**每一个下游用户**的中转口令，复用它当面板
 *    口令 = 任何拿到中转口令的人都能读整池 key、关掉注册机、把 agnesPlatformUrl 改成
 *    自己的服务器从而收走每一次注册的邮箱 + 密码 + 验证码。
 *
 * 顺序有意义：先查长度。反过来的话，两条都不满足时报的是「与网关口令相同」，
 * 而运维改完口令还是进不去。
 */
export function checkAdminToken(token: string, gatewayToken: string): AdminTokenCheck {
  if (token.length < ADMIN_TOKEN_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (token === gatewayToken) return { ok: false, reason: "same_as_gateway_token" };
  return { ok: true };
}

export function adminAuth(token: string, logger: Logger, trustProxy: boolean): MiddlewareHandler {
  return async (c, next) => {
    // **只认请求头**。刻意不接受 `?key=`（`/v1` 接受它是为了 Gemini 协议兼容，
    // 管理端点不继承这个），也不接受 `Authorization: Bearer`（两把钥匙严格隔离）。
    // 口令进 URL 会落进浏览器历史、Referer、CF 访问日志、反代日志——
    // 这条禁令同时否掉了 EventSource（它设不了请求头），见设计文档 §7.2。
    const provided = c.req.header("x-admin-key") ?? "";
    if (!constantTimeEqual(provided, token)) {
      // **不记 provided 本身**：日志会被转发到第三方，猜错的口令里常常只差一位，
      // 而记下来的那一串就是攻击者字典的一部分——更别说运维自己打错时会把真口令
      // 记进日志。只记「带没带这个头」，够面板区分「扫描」与「猜口令」了。
      logger.log({
        level: "warn", event: "admin.login_failed", msg: "管理接口凭据无效",
        fields: { ip: clientIp(c, trustProxy), path: c.req.path, hasHeader: provided.length > 0 },
      });
      return c.json({ error: { type: "unauthorized", message: "未授权" } }, 401);
    }
    await next();
  };
}
