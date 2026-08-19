import { Hono } from "hono";
import type { Logger } from "../../ports/logger.js";
import { adminAuth, checkAdminToken, checkAdminTokenShape, ADMIN_TOKEN_MIN_LENGTH } from "./auth.js";
import type { AdminTokenCheck } from "./auth.js";
import { sessionHandler } from "./handlers/session.js";
import { uiRoutes } from "../../ui/serve.js";

export interface AdminRouterDeps {
  /** **只从环境变量读，不从存储读**：不该让面板能改自己的钥匙。 */
  adminToken: string | undefined;
  /**
   * **getter，不是值**：`adminAuth` 每个请求都要现读一次。拷成值就等于把「两把钥匙
   * 不得相同」这条规则冻结在启动时刻，而 gatewayToken 是能在运行中被改的。
   * 装配期也读一次，但**只用来打一条启动日志，不用来决定要不要注册这棵树**——
   * 理由见下面 adminRouter 里那段长注释。
   */
  currentGatewayToken: () => string;
  version: string;
  logger: Logger;
  trustProxy: boolean;
}

/**
 * 每条拒绝原因对应的运维可读说明。**三条都要能被区分开**——只说「管理面板未启用」
 * 而不说是哪一条，运维只能靠猜。
 */
const REJECT_MESSAGE: Readonly<Record<NonNullable<AdminTokenCheck["reason"]>, string>> = {
  whitespace_padded:
    "ADMIN_TOKEN 首尾有空白字符，管理面板未启用（网关转发不受影响）。"
    + "HTTP 请求头的值在传输层会被去掉首尾空白，而环境变量不会，"
    + "带空白的口令客户端永远送不出来，留着它只会得到一棵永远进不去的面板",
  too_short:
    `ADMIN_TOKEN 长度不足 ${ADMIN_TOKEN_MIN_LENGTH} 位，管理面板未启用（网关转发不受影响）`,
  // 这一条的措辞与另外两条**刻意不同**：它不导致「面板未启用（404）」，而是让管理
  // 接口在每个请求上返回 503，改掉任一把口令即可恢复、不需要重启（见 adminRouter）。
  same_as_gateway_token:
    "ADMIN_TOKEN 与当前生效的 GATEWAY_TOKEN 相同，管理接口已停用并将持续返回 503"
    + "（网关转发不受影响）。中转口令是发给每一个下游用户的，复用它当面板口令等于把"
    + "整池 key 交出去；改掉其中任一把口令即可恢复，不需要重启",
};

/**
 * `/admin` 子 app。**返回 null 表示整棵 /admin 树都不注册** ⇒ 访问它得到 404 而不是
 * 401，不泄漏「这里有个后台」。与 P1 的显式开关哲学一致。
 *
 * 返回 null 的条件**只有两类，且都只取决于 `ADMIN_TOKEN` 这一个环境变量**：没配
 * （含空串），或者它自己不合规（首尾空白 / 长度不足）。这不是随手划的线，见下面
 * 那段注释——装配期的结论会被永久冻结，所以它只能建立在运行中不会变的输入上。
 *
 * 不合规时**只拒绝注册面板、不让网关停摆**：转发能力与管理能力相互独立。
 * 这里绝不能 throw——抛出去 Node 侧是重启循环、Worker 侧是全部转发流量挂掉，
 * 而起因只是一个配错的管理口令。
 */
export function adminRouter(deps: AdminRouterDeps): Hono | null {
  const token = deps.adminToken;
  // 空字符串一并落进这里：**「配了个空口令」绝不能变成「空 x-admin-key 就能进」**。
  // P1 出过一次实际的鉴权绕过，成因就是空串在 `??` 下不下坠。
  if (!token) return null;

  // ── 装配期只查「只看 ADMIN_TOKEN 自己」的那两条 ──────────────────────────
  //
  // **判据：装配期的结论会被永久冻结**（不注册就是永久 404，运行中没法反注册回来），
  // 所以它只能建立在运行中不会变的输入上。`ADMIN_TOKEN` 只从环境变量读，符合。
  //
  // ⚠️ **「两把钥匙不得相同」这条刻意不在这里拦，尽管它是三条里最要紧的那条。**
  // 它的另一个输入 `gatewayToken` 是 `env.GATEWAY_TOKEN ?? stored.gatewayToken`，
  // 运行中能被 `wrangler kv key put` / 手工编辑 `store.json` / 将来的面板改掉。
  // 在装配期拦它会造成**分裂脑**（评审实测）：冲突期间冷启动的 isolate 整棵 /admin
  // 树 404，而**把配置改回去之后仍然 404、必须重启**——装配期检查没有第二次求值的
  // 机会；与此同时冲突之前建好的那批 isolate 只是 503，改回去立刻恢复。同一份配置、
  // 同一时刻，取决于 isolate 是在冲突前还是冲突中冷启动的，管理端返回 200/404 两种
  // 结果，而 DEPLOY.md 无条件承诺的「改回去不需要重启」对其中一半是假话。
  // 所以这条整个交给 `adminAuth` 的每请求复查（503 + `admin.token_conflict`）——
  // 那里每次都重新求值，不存在冻结问题。
  const shape = checkAdminTokenShape(token);
  if (!shape.ok) {
    // 静默地不启用面板，运维只会看到 404 并以为「后台坏了」，查不到原因。
    // **事件里不带口令本身**：容器日志常被转发到第三方。
    deps.logger.log({
      level: "error", event: "admin.token_rejected",
      // 查表而不是三元：多一条 reason 时三元的 else 分支会把新原因**误报成**旧的那条，
      // 而运维照着错的原因改是查不出问题的。
      msg: REJECT_MESSAGE[shape.reason ?? "too_short"],
      fields: { reason: shape.reason ?? null },
    });
    return null;
  }

  // 冲突这条**只报不拦**：拦是 adminAuth 的事（见上），但启动时就撞上冲突的部署者
  // 应当在启动日志里直接看到原因，而不是等到第一个管理请求拿到一个不说原因的 503。
  if (!checkAdminToken(token, deps.currentGatewayToken()).ok) {
    deps.logger.log({
      level: "error", event: "admin.token_conflict",
      msg: REJECT_MESSAGE.same_as_gateway_token,
      fields: { reason: "same_as_gateway_token", path: null },
    });
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

  // ★ 必须在**全部** /admin/api/* 路由之后注册：Hono 把匹配上的 handler 按注册顺序
  // 串起来跑，`/admin/*` 这条兜底若排在前面会先返回 404，**整套管理 API 直接消失**
  // ——拿着正确口令也是 404，没有任何报错。（已实测；tests/contract/ui-serve.test.ts
  // 有一条用例专门守这件事。）**新增任何 /admin/api/* 端点都必须加在这一行之前。**
  //
  // 静态资源**免鉴权**（登录闸得先能打开），但它整棵树跟着 /admin 一起存在或消失：
  // 没配 ADMIN_TOKEN 时上面已经 return null，连这几行都不会执行。
  admin.route("/", uiRoutes());
  return admin;
}
