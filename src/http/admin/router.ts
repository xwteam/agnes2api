import { Hono } from "hono";
import type { Logger } from "../../ports/logger.js";
import type { KeyPoolRepo } from "../../core/keypool-repo.js";
import type { ConfigHolder } from "../config-holder.js";
import type { StorageHealth } from "../../core/storage-health.js";
import type { RuntimeInfo } from "../../ports/runtime.js";
import type { StoreLogger } from "../../adapters/logger-store.js";
import { adminAuth, checkAdminToken, checkAdminTokenShape, ADMIN_TOKEN_MIN_LENGTH } from "./auth.js";
import type { AdminTokenCheck } from "./auth.js";
import { sessionHandler } from "./handlers/session.js";
import { keysHandler } from "./handlers/keys.js";
import { capabilitiesHandler } from "./handlers/capabilities.js";
import { overviewHandler } from "./handlers/overview.js";
import { eventsHandler, eventsDownloadHandler } from "./handlers/events.js";
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
  /**
   * **与转发路径同一个实例**（`wire.ts` 把 `BuiltApp.repo` 交出来正是为了这个）。
   * 面板另建一个的话就是另一份 isolate 快照：面板每刷新一次都要真读一遍存储，
   * 而设计文档 §2.4 第 1、2 条那笔「面板轮询不额外烧配额」的账全靠共用这一份。
   * `tests/contract/quota-panel.test.ts` 的
   * 「转发先预热之后，面板请求零存储访问——两边不是各自一份快照」
   * 数着 get/list 次数钉这件事。
   */
  repo: KeyPoolRepo;
  now: () => number;
  /** 见 `overviewHandler`：`config` 块需要现读一次当前生效配置。 */
  configHolder: ConfigHolder;
  /** 见 `capabilitiesHandler` / `overviewHandler`：存储可写性的内存状态，零额外 I/O。 */
  storageHealth: StorageHealth;
  /** 双运行时差异的唯一注入点，见 `src/ports/runtime.ts`。 */
  runtime: RuntimeInfo;
  /** 被环境变量锁定的字段清单（`envLockedFields` 的结果），装配时算好，不逐请求重算。 */
  envLocked: readonly string[];
  /**
   * 事件落库 sink（Task 6）。`createApp` 已经决定好用调用方传的那个还是默认的
   * no-op 兜底，这里只管接线，不再做一次「有没有配」的判断。
   */
  storeLogger: StoreLogger;
}

/**
 * 每条拒绝原因对应的运维可读说明。**四条都要能被区分开**——只说「管理面板未启用」
 * 而不说是哪一条，运维只能靠猜。
 *
 * 类型是 `Record<NonNullable<AdminTokenCheck["reason"]>, string>`，所以给
 * `AdminTokenCheck["reason"]` 加一条新原因时 **`tsc` 会先在这里报错**（已实测：
 * Task 7 加 `not_sendable` 时 `pnpm typecheck` 报 TS2741）——这正是它当初写成
 * 查表而不是三元的理由：三元的 else 分支会把新原因**误报成**旧的那条。
 */
const REJECT_MESSAGE: Readonly<Record<NonNullable<AdminTokenCheck["reason"]>, string>> = {
  whitespace_padded:
    "ADMIN_TOKEN 首尾有空白字符，管理面板未启用（网关转发不受影响）。"
    + "HTTP 请求头的值在传输层会被去掉首尾空白，而环境变量不会，"
    + "带空白的口令客户端永远送不出来，留着它只会得到一棵永远进不去的面板",
  // ⚠️ **文案必须把三段分开讲，不许压成一句「浏览器发不出去」**——那句话对
  // 0x80–0xFF 那一段是**假的**（实测：`é` 送得出去、Node 解析器收下、与环境变量
  // 逐码点相等，端到端能用）。对运维说一句他一试就能证伪的话，代价是他不再信这条
  // 诊断。三段的完整实测与理由见 src/http/admin/auth.ts 的 SENDABLE。
  not_sendable:
    "ADMIN_TOKEN 含有不被接受的字符，管理面板未启用（网关转发不受影响）。"
    + "只允许可打印 ASCII（0x20–0x7E），三种情况分别是："
    + "① 汉字 / emoji / 零宽空格等码点大于 U+00FF 的字符，以及换行与 NUL，"
    + "浏览器在设置请求头时直接抛 TypeError —— 请求压根发不出去，"
    + "结果是一棵 200 但永远进不去的面板，服务端连一条 login_failed 都不会有；"
    + "② 除 TAB 外的其余控制字符（0x01–0x08、0x0B、0x0C、0x0E–0x1F、0x7F）"
    + "浏览器送得出去，但会被 HTTP 解析器判成 400 Bad Request；"
    + "③ TAB 与 é / £ / 不间断空格这类 0x80–0xFF 的字符**其实送得出去也能用**，"
    + "拦它们是本网关的稳健性取舍、不是物理限制，而且两者的理由不同："
    + "TAB 是不可见字符，粘进配置里没人看得见；"
    + "0x80–0xFF 则是编码口径问题（环境变量按 UTF-8 解、HTTP 头值按 Latin-1 解，"
    + "两边在这一段并不由规范保证一致；RFC 9110 也已把这段标为弃用）。"
    + "请改用纯 ASCII 口令。"
    + "中间带空格是允许的（passphrase 式口令送得出去，也送得到），"
    + "首尾空白另有 whitespace_padded 那条管着",
  too_short:
    `ADMIN_TOKEN 长度不足 ${ADMIN_TOKEN_MIN_LENGTH} 位，管理面板未启用（网关转发不受影响）`,
  // 这一条的措辞与另外两条**刻意不同**：它不导致「面板未启用（404）」，而是让管理
  // 接口在每个请求上返回 503（见 adminRouter）。
  //
  // ⚠️ **不许写成「改掉任一把口令即可恢复」。** 改 `gatewayToken` 确实能让管理接口
  // 立刻回到 200，但那救的是可用性、不是安全性：冲突期间这把管理口令与中转口令是
  // **同一个值**，而中转口令是发给每一个下游用户的。运维照着「改任一把」处置，
  // 结果是一把所有下游用户都知道的管理口令继续生效。措辞必须把轮换 ADMIN_TOKEN
  // 说成**必做的那一步**，五语言 DEPLOY.md 同一段也是这么写的。
  same_as_gateway_token:
    "ADMIN_TOKEN 与当前生效的 GATEWAY_TOKEN 相同，管理接口已停用并将持续返回 503"
    + "（网关转发不受影响）。中转口令是发给每一个下游用户的，复用它当面板口令等于把"
    + "整池 key 交出去；请把 ADMIN_TOKEN 按已泄漏处置，轮换成一把全新的口令。"
    + "只把存储里的 gatewayToken 改回去能让接口立刻恢复，但那把管理口令仍然是"
    + "下游用户手里那个值",
};

/**
 * `/admin` 子 app。**返回 null 表示整棵 /admin 树都不注册** ⇒ 访问它得到 404 而不是
 * 401，不泄漏「这里有个后台」。与 P1 的显式开关哲学一致。
 *
 * 返回 null 的条件**只有两类，且都只取决于 `ADMIN_TOKEN` 这一个环境变量**：没配
 * （含空串），或者它自己不合规（首尾空白 / 含送不出去的字符 / 长度不足）。这不是
 * 随手划的线，见下面那段注释——装配期的结论会被永久冻结，所以它只能建立在运行中
 * 不会变的输入上。
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
  admin.get("/admin/api/keys", keysHandler(deps.repo, deps.now));
  admin.get("/admin/api/capabilities", capabilitiesHandler({
    runtime: deps.runtime, storageHealth: deps.storageHealth, version: deps.version,
  }));
  admin.get("/admin/api/overview", overviewHandler({
    repo: deps.repo, configHolder: deps.configHolder, storageHealth: deps.storageHealth,
    runtime: deps.runtime, envLocked: deps.envLocked, version: deps.version, now: deps.now,
  }));
  admin.get("/admin/api/events", eventsHandler({ storeLogger: deps.storeLogger, now: deps.now }));
  admin.get("/admin/api/events/download", eventsDownloadHandler({ storeLogger: deps.storeLogger }));

  // ★ 必须在**全部** /admin/api/* 路由之后注册：Hono 把匹配上的 handler 按注册顺序
  // 串起来跑，`/admin/*` 这条兜底若排在前面会先返回 404，**整套管理 API 直接消失**
  // ——拿着正确口令也是 404，没有任何报错。（已实测；由 `tests/contract/ui-serve.test.ts`
  // 的「**/admin/api/* 不会被静态兜底吃掉**——注册顺序错了会让整套管理 API 变成 404」
  // 那一格守着。）**新增任何 /admin/api/* 端点都必须加在这一行之前。**
  //
  // ⚠️ **这段注释在 P3c Task 1 之前是第 12 道门禁看不见的**：它上面那行里的
  // `/admin/api/*` 含有 `/*`，而当时的 `commentBlocks()` 不解析字符串字面量、
  // 也不解析注释里的通配符，把它当成块注释开头一路吞到文件尾 ⇒ **从那里往下
  // 25 行（整张 /admin/api/* 路由表）全部脱离校验，而门禁照常报绿**。
  // 上面这条裸文件名断言就是这么藏了一整期的。扫描器已改成逐字符扫。
  //
  // 静态资源**免鉴权**（登录闸得先能打开），但它整棵树跟着 /admin 一起存在或消失：
  // 没配 ADMIN_TOKEN 时上面已经 return null，连这几行都不会执行。
  admin.route("/", uiRoutes());
  return admin;
}
