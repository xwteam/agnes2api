import { Hono } from "hono";
import type { Logger } from "../../ports/logger.js";
import { adminAuth, checkAdminToken, ADMIN_TOKEN_MIN_LENGTH } from "./auth.js";
import { sessionHandler } from "./handlers/session.js";

export interface AdminRouterDeps {
  /** **只从环境变量读，不从存储读**：不该让面板能改自己的钥匙。 */
  adminToken: string | undefined;
  /**
   * **getter，不是值**：装配期用它查一次（决定要不要注册这棵树），运行期每个请求
   * 再查一次（`adminAuth` 里的复查）。拷成值就等于把「两把钥匙不得相同」这条规则
   * 冻结在启动时刻，而 gatewayToken 是能在运行中被改的（见 adminAuth 的说明）。
   */
  currentGatewayToken: () => string;
  version: string;
  logger: Logger;
  trustProxy: boolean;
}

/**
 * `/admin` 子 app。**返回 null 表示整棵 /admin 树都不注册** ⇒ 访问它得到 404 而不是
 * 401，不泄漏「这里有个后台」。与 P1 的显式开关哲学一致。
 *
 * 口令不合规时也返回 null，但**只拒绝注册面板、不让网关停摆**：
 * 转发能力与管理能力相互独立。这里绝不能 throw——抛出去 Node 侧是重启循环、
 * Worker 侧是全部转发流量挂掉，而起因只是一个配错的管理口令。
 */
export function adminRouter(deps: AdminRouterDeps): Hono | null {
  const token = deps.adminToken;
  // 空字符串一并落进这里：**「配了个空口令」绝不能变成「空 x-admin-key 就能进」**。
  // P1 出过一次实际的鉴权绕过，成因就是空串在 `??` 下不下坠。
  if (!token) return null;

  // 装配期这次负责「启动时就配错」⇒ 整棵树不注册（404，不泄漏这里有个后台）。
  // 「运行中才变得不安全」由 adminAuth 的每请求复查负责（那时已经没法反注册了，
  // 故改为 503 fail closed）。两道是不同的失效时机，都要有。
  const check = checkAdminToken(token, deps.currentGatewayToken());
  if (!check.ok) {
    // 静默地不启用面板，运维只会看到 404 并以为「后台坏了」，查不到原因。
    // **事件里不带口令本身**：容器日志常被转发到第三方。
    deps.logger.log({
      level: "error", event: "admin.token_rejected",
      msg: check.reason === "too_short"
        ? `ADMIN_TOKEN 长度不足 ${ADMIN_TOKEN_MIN_LENGTH} 位，管理面板未启用（网关转发不受影响）`
        : "ADMIN_TOKEN 不得与 GATEWAY_TOKEN 相同，管理面板未启用（网关转发不受影响）",
      fields: { reason: check.reason ?? null },
    });
    return null;
  }

  const admin = new Hono();
  // ★ 顺序敏感（已实测 Hono 4.13.2）：
  //   app.route("/", sub); app.use(path, mw)  →  200，鉴权**静默失效且不报错**
  //   app.use(path, mw); app.route("/", sub)  →  401
  //   子 app 内部先 use 再挂 handler          →  401，**且外层 route 的位置无关紧要**
  // 因此把 use 收进子 app 内部的第一行，顺序问题就局部化、可评审了。
  // **新增任何 /admin/api/* 端点都必须挂在这一行之后。**
  admin.use("/admin/api/*", adminAuth(token, deps.currentGatewayToken, deps.logger, deps.trustProxy));
  admin.get("/admin/api/session", sessionHandler(deps.version));
  // Task 6 在这里追加静态资源路由（**必须在上面这些 api 路由之后注册**，
  // 否则 /admin/* 的兜底会先匹配上并把 API 变成 404）。
  return admin;
}
