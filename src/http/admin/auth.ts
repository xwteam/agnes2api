import type { MiddlewareHandler } from "hono";
import type { Logger } from "../../ports/logger.js";
import { clientIp } from "../client-ip.js";

/**
 * 常数时间比较：先比长度，再逐字节异或累加，**中途不提前 return**。
 *
 * 长度本身会泄漏（长度不同时立刻 false），这是标准取舍：口令是 ≥24 位的随机串，
 * 泄漏长度不构成可利用的信息，而为了藏长度去做定长填充只会让实现更容易写错。
 *
 * ⚠️ **常数时间这个性质无法用单元测试证明，原因是它根本不在返回值里**：
 * 被测的性质是「**耗时**不随输入而变」，而测试只能断言返回值。把整个函数换成
 * `a === b`、或把循环体改成 `if (a[i] !== b[i]) return false`，**返回值逐点相同**，
 * 变的只是耗时——所以任何基于返回值的断言都区分不了它们（已实测：两条变异全套测试
 * 照样绿，见 Task 5 报告的变异表 M5/M6）。
 *
 * 那为什么不写计时断言？因为在 CI 上测不准：几十个字节的逐字节差异是纳秒量级，
 * 而 JIT 预热、GC、共享 runner 的调度噪声是毫秒量级，信噪比根本不够，写出来的
 * 只会是一条随机红绿的用例——那比没有更糟。
 *
 * 所以这一条**明确不由测试保证，而由评审保证**：评审时逐字核对下面的循环体里
 * 没有任何提前 return / break / 短路运算（`&&` `||` `?:`），出现就是回归。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const ADMIN_TOKEN_MIN_LENGTH = 24;

/**
 * 审计行里的 `path` 最多留这么长。
 *
 * `admin.use("/admin/api/*", adminAuth)` 对**任意** `/admin/api/` 子路径生效，全程
 * 零凭据、零限速，而 Node 的请求行上限约 8 KB ⇒ **每个未鉴权请求都能往日志里塞
 * 约 8 KB 攻击者文本**。`ConsoleLogger` 的 logfmt 引用已经保证这段文本撕不开字段，
 * 但撕不开不等于该让它无限长：日志按体积计费、按行读，而这个字段的用途只是
 * 「运维/面板看得出被扫的是哪条路径」，200 字符绰绰有余。
 */
export const AUDIT_PATH_MAX = 200;

export interface AdminTokenCheck {
  ok: boolean;
  reason?: "whitespace_padded" | "too_short" | "same_as_gateway_token";
}

/**
 * 管理口令的三条硬规则。
 *
 * ⓪ 首尾不得有空白。**这条纯粹为了可诊断性，方向仍是 fail closed。** HTTP 请求头的值
 *    在传输层就被去掉首尾空白，而环境变量不会——于是 `.env` 里口令末尾多敲了一个空格
 *    时，客户端**永远送不出**那个值，结果是「口令明明是对的却一直 401」，日志里只有
 *    `login_failed`，运维查不到原因。极端情形是 24 个空格：长度够、也不等于
 *    GATEWAY_TOKEN，于是装出一棵**永远进不去**的树。在装配期就说清楚，比让人对着
 *    一串看不见的空格排查便宜得多。
 *
 * ① 长度下限 24：Worker 形态**没有分布式限速**（做它要拿 KV 当窗口，等于给攻击者
 *    一根消耗写配额的杠杆，能把 DoS 面从「猜口令」扩大到「打死 key 池的状态回写」）。
 *    因此口令熵就是唯一的防线，下限不是建议值。
 * ② 不得等于 GATEWAY_TOKEN：后者是发给**每一个下游用户**的中转口令，复用它当面板
 *    口令 = 任何拿到中转口令的人都能读整池 key、关掉注册机、把 agnesPlatformUrl 改成
 *    自己的服务器从而收走每一次注册的邮箱 + 密码 + 验证码。
 *
 * 顺序有意义：空白最先，长度其次。空白是三条里**唯一在配置文件里看不见**的那条
 * （长度和「是否与网关口令相同」运维自己一眼能核），先报它最省事；反过来把相同性
 * 放在长度前面则更糟——两条都不满足时报的是「与网关口令相同」，运维改完口令还是进不去。
 */
export function checkAdminToken(token: string, gatewayToken: string): AdminTokenCheck {
  // 空串不走这里（`"".trim() === ""`），它归 too_short，与 adminRouter 的 `!token` 一致。
  if (token.trim() !== token) return { ok: false, reason: "whitespace_padded" };
  if (token.length < ADMIN_TOKEN_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (token === gatewayToken) return { ok: false, reason: "same_as_gateway_token" };
  return { ok: true };
}

/** 审计字段不该原样承载请求数据，见 AUDIT_PATH_MAX。 */
function auditPath(path: string): string {
  return path.length > AUDIT_PATH_MAX ? path.slice(0, AUDIT_PATH_MAX) : path;
}

/**
 * `currentGatewayToken` 是个 **getter，每请求现读**（与 `middleware/auth.ts` 的
 * `getToken: () => string` 同一套做法），不是装配时拷下来的值。理由见下面的运行期复查。
 */
export function adminAuth(
  token: string,
  currentGatewayToken: () => string,
  logger: Logger,
  trustProxy: boolean,
): MiddlewareHandler {
  return async (c, next) => {
    // ── 运行期复查，**每请求一次** ────────────────────────────────────────
    // 装配期那次 checkAdminToken 只挡得住「启动时就配错」。它挡不住**配置在运行中
    // 变成不安全状态**：`loadConfig` 是 `env.GATEWAY_TOKEN ?? stored.gatewayToken`，
    // 部署者没设环境变量、改由存储提供时，一次 `wrangler kv key put`、一次手工编辑
    // store.json（这两条恰恰是 DEPLOY.md 里教的操作），或将来 P3c 的面板，都能把
    // gatewayToken 改成等于 ADMIN_TOKEN——而中转口令是发给**每一个下游用户**的，
    // 届时任何下游用户都能开后台，直到重启 / isolate 回收为止。这是权限提升，
    // 不是配置洁癖；把它交给「写入路径上拒绝」不够，手工改存储绕得过写入路径。
    //
    // **fail closed**：管理端整个停用，而**网关转发不受影响**（与 ADMIN_TOKEN 没配
    // 时的语义一致）。复查刻意跑在验证凭据**之前**：没有任何一条路径能走到 next()。
    const state = checkAdminToken(token, currentGatewayToken());
    if (!state.ok) {
      logger.log({
        level: "error", event: "admin.token_conflict",
        msg: state.reason === "same_as_gateway_token"
          ? "ADMIN_TOKEN 与当前生效的 GATEWAY_TOKEN 相同，管理接口已停用（网关转发不受影响）。"
            + "中转口令是发给每一个下游用户的，复用它当面板口令等于把整池 key 交出去；"
            + "改掉其中一把即可恢复"
          : "ADMIN_TOKEN 不再满足管理口令的硬规则，管理接口已停用（网关转发不受影响）",
        fields: { reason: state.reason ?? null, path: auditPath(c.req.path) },
      });
      // **响应体不说原因**。这个分支跑在验证凭据之前，任何未鉴权的调用方都拿得到
      // 它；说出「两把口令相同」，等于告诉一个手里已经有中转口令的人「管理口令就是
      // 你手上那把」。原因只进日志，那是运维才看得到的地方。
      return c.json({ error: { type: "service_unavailable", message: "管理接口不可用" } }, 503);
    }

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
        fields: { ip: clientIp(c, trustProxy), path: auditPath(c.req.path), hasHeader: provided.length > 0 },
      });
      return c.json({ error: { type: "unauthorized", message: "未授权" } }, 401);
    }
    await next();
  };
}
