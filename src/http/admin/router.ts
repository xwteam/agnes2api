import { Hono } from "hono";
import type { Logger } from "../../ports/logger.js";
import type { Fetcher } from "../../ports/fetcher.js";
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
import { modelsHandler } from "./handlers/models.js";
import { overviewHandler } from "./handlers/overview.js";
import { eventsHandler, eventsDownloadHandler } from "./handlers/events.js";
import {
  keysImportHandler, keysBulkHandler, keyDeleteHandler, keyPatchHandler,
  keysPurgeHandler, KEYS_PURGE_PATH,
} from "./handlers/keys-write.js";
import {
  manualTendHandler, registrarStatusHandler, channelTestHandler, type RegistrarWiring,
} from "./handlers/registrar.js";
import {
  configGetHandler, configPutHandler, configValidateHandler, configClearSecretHandler,
  configResetHandler, CONFIG_RESET_PATH,
  type ConfigWiring,
} from "./handlers/config.js";
import {
  keyUsageHandler, usageHandler, usageDateHandler, type UsageWiring,
} from "./handlers/usage.js";
import { verifyHandler } from "./handlers/verify.js";
import type { TendGate } from "./tend-lock.js";
import { createProbeGuard } from "./probe-guard.js";
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
  /**
   * **与转发路径同一个 `Fetcher` 实例**（`createApp` 把 `deps.fetcher` 原样交下来）。
   * 唯一的消费者是单把 key 验活（P3d Task 8）——它不经 `dispatch()`（那个函数会自己
   * 选 key，而验活要指定某一把），所以出站能力得在这里单独接一条。
   *
   * **不许在 handler 里裸 `fetch`**：没有这个端口，那条端点在测试里桩不掉、
   * 每跑一次就真打一次外网。见 `handlers/verify.ts` 的约束 3（连同它接不住的那半）。
   */
  fetcher: Fetcher;
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
  /**
   * 注册机的执行体与存储（P3c Task 5 建，Task 6 扩到三样成套）。**`null` = 这个
   * app 没接**，三条端点仍然注册、仍然鉴权，但会如实回 `503 not_wired`。
   * 见 `RegistrarWiring`。
   */
  registrar: RegistrarWiring | null;
  /** 补池在途守卫（进程/isolate 内）。见 `./tend-lock.ts` 里两把锁的对照表。 */
  tendGate: TendGate;
  /**
   * 配置读写的接线（P3c Task 7）。**`null` = 这个 app 没接**，四条端点仍然注册、
   * 仍然鉴权，但会如实回 `503 not_wired`。见 `ConfigWiring`。
   */
  config: ConfigWiring | null;
  /**
   * Tier-2 到底有没有在记账（P3d Task 3）。**`createApp` 传的是
   * `deps.usageSink !== undefined`，不是配置里那个开关现读的值**——完整理由见
   * `capabilitiesHandler` 的同名参数。
   *
   * ⚠️ **它与下面的 `usage` 必须同真同假，而这件事今天靠的是「`createApp` 里
   * 两行都从同一个 `usageSink` 变量算出来」，不是一条约束**（P3d Task 4 登记）。
   * 分叉的后果是三态混一里最难查的一种：`capabilities` 说 Tier-2 开着、面板于是
   * 画图表，而 `GET /admin/api/usage` 回 `tier: "off"`。
   * 由 `tests/contract/admin-usage.test.ts` 的
   * 「capabilities 的 tier2Enabled 与 usage 的 tier 说的是同一件事 —— 两边不许分叉」
   * 钉着。**那是一格用例，它在自己体内用一个 `for` 把开着与关着两侧各跑一遍**
   *（上一版这里写「两侧各钉一格」，读起来像两格，实为一格）。
   */
  usageStatsEnabled: boolean;
  /**
   * Tier-2 读侧的接线（P3d Task 4）。**`null` = 这个 app 没建 sink，也就是关着。**
   *
   * 与 `registrar` / `config` 那两处「`null` = 没接，端点仍然注册但回 503」刻意**不同**：
   * 这一条的 `null` 不是「装配不全」，而是**一个正常且默认的部署形态**（Tier-2 默认关），
   * 所以三条端点在 `null` 时照常回 200，只是如实说 `tier: "off"`。
   * 回 503 会让面板把「运维没打开统计」渲染成「后端坏了」。
   */
  usage: UsageWiring | null;
  /**
   * 生效的落盘间隔（P3d Task 3）。**由 `wire.ts` 从 `USAGE_FLUSH_INTERVAL_MS` 与
   * `runtime.quotaModel` 算出来**，`capabilities` 原样发给面板——面板据它算
   * 「未落盘的尾巴最长多久」，**不许在前端写死**（全局约束 10）。
   */
  usageFlushIntervalMs: number;
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
  //
  // ── P3c 交下来的待办第 5 条的处置：**这条 503 不该收敛成 401，建议关掉这条待办** ──
  //
  // P3c 计划登记过「把 `admin.token_conflict` 的 503 改成 401」并延后到 P3d。
  // P3d 的裁定是**不做，而且不再往后传**——它不是「暂时没空」，是这个改动方向本身错了：
  //
  // 面板那一侧有一条**刻意写下的**规则（见 `admin-ui/js/api.js` 文件头）：
  // **401 = 会话失效（清凭据、踢回登录闸）；403 明确不当会话失效。**
  // 后者是照抄 kiro2api 用中文注释警告过的那个坑：老写法把业务 403 当掉线，
  // 管理员拒绝一次授权就被踢出后台并被告知「密钥无效」。
  //
  // ⇒ 把口令冲突改成 401 的直接后果是：**运维被踢回登录闸，并被告知「口令无效」**
  // ——而他手里那把管理口令是对的，真正的问题是两把钥匙撞了。他会一遍遍重输同一把
  // 正确的口令，而面板每次都告诉他这把口令错了。**这正是那条注释在警告的形态。**
  // 503 + `admin.token_conflict` 事件才是说得清的那一种：面板不清凭据、不踢人，
  // 而运维在启动日志与事件板块里都能读到下面这段文字。
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
    usageStatsEnabled: deps.usageStatsEnabled,
    usageFlushIntervalMs: deps.usageFlushIntervalMs,
  }));
  admin.get("/admin/api/overview", overviewHandler({
    repo: deps.repo, configHolder: deps.configHolder, storageHealth: deps.storageHealth,
    runtime: deps.runtime, envLocked: deps.envLocked, version: deps.version, now: deps.now,
  }));
  admin.get("/admin/api/events", eventsHandler({ storeLogger: deps.storeLogger, now: deps.now }));
  admin.get("/admin/api/events/download", eventsDownloadHandler({ storeLogger: deps.storeLogger }));

  // ── Key 池的写端点（P3c Task 3）─────────────────────────────────────────
  //
  // **这是这棵树上第一批非 GET 路由。** 在此之前 `/admin/api/*` 六条全是
  // `admin.get()`，于是上面那条 `admin.use` 写对写错的可观测差异只有「读得到 / 401」；
  // 现在它变成了「**删得掉** / 401」。枚举式鉴权矩阵因此多了一维：
  // `tests/contract/admin-auth.test.ts` 的
  // 「鉴权失败的非幂等请求必须零副作用 —— 只断言 401 抓不住『先删了再返回 401』」
  // 数着 put / delete 计数钉住它，而那一格的夹具刻意用**真的会成功**的请求
  // （已停用的 key + 合法的导入体），否则鉴权失效时它照样是 0 次写。
  const keysWrite = { repo: deps.repo, logger: deps.logger };
  admin.post("/admin/api/keys", keysImportHandler(keysWrite));
  // **`bulk` 必须写在 `:id` 之前**：Hono 按注册顺序匹配，`/admin/api/keys/bulk`
  // 同样能匹配 `/admin/api/keys/:id`。今天两者方法不同（POST / DELETE、PATCH）
  // 所以碰不上，但顺序反了之后加一条 `POST /admin/api/keys/:id` 就会静默地
  // 把 bulk 吃掉——与本文件末尾那条静态兜底是同一个坑。
  admin.post("/admin/api/keys/bulk", keysBulkHandler(keysWrite));
  // ── 危险区第二颗按钮：清空整个 Key 池（P3e Task 31）────────────────────────
  //
  // **路径从 `KEYS_PURGE_PATH` 取，不写第二遍字面量**：五语言 DEPLOY.md 的配额账
  // 里逐份写着这条路径，而 `tests/unit/docs-parity.test.ts` 的
  // 「危险区那两条端点的路径在五份 DEPLOY.md 的配额账里逐份写着 —— 路径从真源常量现算」
  // 从那个常量现算 ⇒ 改路径而文档没跟上，那一格当场红。
  //
  // ⚠️ **它排在 `bulk` 之后、两条 `:id` 之前，与 `bulk` 是同一条规矩**：Hono 按注册
  // 顺序匹配，`/admin/api/keys/purge` 同样能匹配 `/admin/api/keys/:id`。今天两者方法
  // 不同（POST / DELETE、PATCH）所以碰不上，但顺序反了之后加一条
  // `POST /admin/api/keys/:id` 就会静默地把它吃掉——**而这一条被吃掉的后果不是少一个
  // 功能，是一颗清空整池的按钮落在别的 handler 上**。本文件里这是同一个坑的第五处，
  // 措辞刻意与 `bulk` 那段一致。窗口内部的这条规矩由
  // `tests/contract/admin-auth.test.ts` 的
  // 「窗口内更宽的模式不许排在更窄的之前 —— 被吃掉的那一条恒不可达，而它只会回一个看起来合理的 400」
  // 从 `app.routes` 现算钉着，不用回来改任何清单。
  admin.post(KEYS_PURGE_PATH, keysPurgeHandler(keysWrite));
  admin.delete("/admin/api/keys/:id", keyDeleteHandler(keysWrite));
  admin.patch("/admin/api/keys/:id", keyPatchHandler(keysWrite));
  // **单把 key 的 Tier-1 计数（P3d Task 4）。挂在上面那两条 `:id` 之后。**
  // 今天它们碰不上：这一条是**四段**（`keys/:id/usage`）而上面两条是三段
  // （`keys/:id`），形状上不可能重叠，而且方法也各不相同。
  // ⚠️ **会出事的是将来有人加一条 `GET /admin/api/keys/:id` 或
  // `/admin/api/keys/:id/:something` 这种更宽的模式**——Hono 按注册顺序匹配，
  // 那时它必须排在本条之后，否则本条会被静默吃掉。这与上面 `bulk` vs `:id`、
  // 以及注册机那段 `channels/:c/test` vs `tend` 是同一个坑的第三次出现。
  //
  // **它与 Tier-2 完全无关**：走 `deps.repo`，Tier-2 关着时照样可用（设计 §10.6）。
  admin.get("/admin/api/keys/:id/usage", keyUsageHandler(deps.repo, deps.now));

  // ── 出站探测的护栏（P3d Task 8）─────────────────────────────────────────────
  //
  // **建在这里，一把，交给两处**：单把 key 验活与通道连通性测试。
  // 全局约束 14 的落点——「按一下就打上游的按钮，必须在同一个任务里连同护栏一起交付」。
  //
  // ⚠️ **刻意不做成 `AdminRouterDeps` 的一格可注入依赖**（`tendGate` 是那样的）。
  // 两者的差别是真的：`tendGate` 要在 Node 侧被**定时轮与面板按钮共用**，所以必须
  // 由外层装配交进来；探测护栏没有第二个持有者，做成可注入只会多出一种
  // 「两条端点各拿到一把」的半装配形态——而那种形态在外部**完全不可观测**
  //（两条端点的 kind 命名空间不相交，见 `./probe-guard.ts` 里那段登记）。
  // ⇒ 在这里 new 一把，「同一个实例」就是结构性的，装配上造不出走样的形态。
  const probeGuard = createProbeGuard();

  // **单把 key 的验活（P3d Task 8）。挂在上面那三条 `keys/...` 之后。**
  // 今天它们碰不上：这一条是**四段**（`keys/:id/verify`）而 `DELETE`/`PATCH` 那两条是
  // 三段，`keys/:id/usage` 虽然同为四段但方法不同（GET vs POST）。
  // ⚠️ **会出事的还是那个老坑**：将来有人加一条比它更宽的
  // `/admin/api/keys/:id/:something`（Hono 按注册顺序匹配），那时它必须排在本条之后。
  // 这是本文件里同一个坑的第五处（`bulk` vs `:id`、`channels/:c/test` vs `tend`、
  // `keys/:id/usage`、`usage` vs `usage/:date`），措辞刻意一致。
  //
  // **它一次存储写都不产生**（订正 F8：验活是只读探针），所以配额账不用改。
  admin.post("/admin/api/keys/:id/verify", verifyHandler({
    repo: deps.repo, fetcher: deps.fetcher, now: deps.now,
    // **getter 而不是值**：超时档与 `agnesBaseUrl` 都能在运行中被面板改掉，
    // 与 `app.ts` 的 `dispatchDeps` 里那个 `get config()` 是同一条理由。
    config: () => deps.configHolder.current(),
    guard: probeGuard,
  }));

  // ── 注册机（P3c Task 5 的「立即补池」+ Task 6 的板块取数与通道测试，风险 L6）──
  //
  // **本仓第一批会触发真实上游副作用的端点**：Key 池那四条只动本地存储，`tend` 会
  // 去建临时邮箱、注册 Agnes 账号、领 key，`channels/:channel/test` 会向邮箱服务
  // 发一次只读 GET。所以 `tend` 的护栏比那四条多两层（存储锁 + 每日写预算闸），
  // 全部在 `handlers/registrar.ts` 里，**三条注册在这里都没有任何条件**
  // ——路由表不许随运行时配置变化，否则 `tests/contract/admin-auth.test.ts` 的
  // 枚举式鉴权矩阵会因为夹具恰好关着注册机而漏掉这几条端点。
  // 「注册机没开」是 handler 里的一条 409，不是"这条路由不存在"。
  const registrar = {
    wiring: deps.registrar,
    now: deps.now,
    logger: deps.logger,
    runtime: deps.runtime,
    configHolder: deps.configHolder,
    gate: deps.tendGate,
    // **与验活同一个引用**（见上面那段）：P3c 账本登记的「通道测试无护栏」缺口，
    // 补法是共用一套，不是各造一套。
    probeGuard,
    repo: deps.repo,
  };
  admin.post("/admin/api/registrar/tend", manualTendHandler(registrar));
  admin.get("/admin/api/registrar/status", registrarStatusHandler(registrar));
  // **`channels/:channel/test` 与 `tend` 不会互相吃掉**：Hono 按注册顺序匹配，而
  // `/admin/api/registrar/tend` 是两段、这条是四段，形状上不可能重叠。同一段
  // `:id` vs `bulk` 的坑（见上面 Key 写端点那段）在这里不成立，但**新增
  // `/admin/api/registrar/:something` 这种单段通配时会立刻成立**——真要加，
  // 请把它排在这两条之后。
  admin.post("/admin/api/registrar/channels/:channel/test", channelTestHandler(registrar));

  // ── 配置读写（P3c Task 7 的设置页前三张卡，设计 §5.3 / §5.4 / §8.6 / §10.4）──
  //
  // **这四条是这棵树上唯一会改「网关自己怎么跑」的端点。** Key 池那四条动的是
  // 池子内容，注册机那三条动的是补池行为，而这四条能把 `gatewayToken` 换掉、
  // 把注册机打开、把超时调成 1 毫秒。一个鉴权失效的 `PUT /admin/api/config`
  // 等于把整台网关交出去——它照样只能待在 `adminAuth` 那一行之后。
  //
  // ⚠️ **`config/validate` 与 `config/secrets/clear` 都排在 `PUT /admin/api/config`
  // 之后，但这与 Hono 的匹配顺序无关**：三条路径段数不同（两段 / 三段 / 四段），
  // 形状上不可能重叠，而且方法也不同。真正会出事的是将来有人加一条
  // `POST /admin/api/config/:something` 单段通配——那时它必须排在这两条之后。
  //
  // `config/reset` 按范围裁定 ② 移到了 P3e，**P3e Task 31 已经把它落地**（上一版这里
  // 写的是「本期没有这条端点」——那句话从本任务起就是假的）。它是危险区第一颗按钮，
  // 路径同样从真源常量 `CONFIG_RESET_PATH` 取，理由与 `KEYS_PURGE_PATH` 那段逐字相同。
  const config = {
    wiring: deps.config,
    configHolder: deps.configHolder,
    logger: deps.logger,
    now: deps.now,
  };
  admin.get("/admin/api/config", configGetHandler(config));
  admin.put("/admin/api/config", configPutHandler(config));
  admin.post("/admin/api/config/validate", configValidateHandler(config));
  admin.post("/admin/api/config/secrets/clear", configClearSecretHandler(config));
  // 危险区第一颗按钮：`config` 整把写回 `{}`（P3e Task 31）。四段，与上面那条
  // `config/validate` 同形，今天与谁都不重叠；将来那条单段通配真出现时，
  // 它与 `validate` 一起必须排在通配之前（上面那段 ⚠️ 说的就是这件事）。
  admin.post(CONFIG_RESET_PATH, configResetHandler(config));

  // ── 协议与模型目录（P3d Task 1）────────────────────────────────────────
  // 「怎么调这个网关」的单一真源经这条端点交给面板。**零存储读、只读、无副作用**。
  // 集成示例卡、Playground、模型表三处都从这里取数，一个端点路径都不在前端硬编码。
  //
  // 它同样用 `admin.get()` 注册（不是 `use()`）⇒ 不产生 ALL 条目。位置上**必须夹在
  // 上面那行 `admin.use("/admin/api/*", adminAuth(...))` 与下面那行静态兜底之间**：
  // 挪到前者之前是一条免鉴权的管理端点，挪到后者之后会被静态兜底吃成 404。
  //
  // **两个方向各由哪一格接住，是实测出来的，不是推出来的**（P3d Task 1 Step 7）：
  // · 挪到 `adminAuth` **之前** ⇒ `tests/contract/admin-auth.test.ts`
  //   「每一条路由 × 每一种凭据状态，逐格断言」与 `tests/contract/admin-models.test.ts`
  //   「没带管理口令是 401」两格同时变红。
  // · 挪到静态兜底**之后** ⇒ **两处**同时变红：
  //   ① `tests/contract/admin-models.test.ts`「把协议目录整份交出去」一带的三格；
  //   ② `tests/contract/admin-auth.test.ts`
  //   「每一条 /admin/api/* 都注册在 adminAuth 之后、静态兜底之前 —— 位置写错了它会恒 404 而没人拦」
  //   ——它按 `app.routes` 的下标算，红了会**逐条点名**（实测报文里就是
  //   `expected [ 'GET /admin/api/models' ] to deeply equal []`）。
  //   ⚠️ **鉴权矩阵接不住这个方向**：`adminAuth` 仍然先跑，无凭据照样 401，
  //   而带对口令时拿到的是静态兜底的 404——矩阵那一格只断言「不该被判 401」，404 照过。
  //   `tests/contract/ui-serve.test.ts`「/admin/api/* 不会被静态兜底吃掉」也接不住：
  //   它探的是 `/admin/api/session` 那一条，与本端点的注册位置无关。
  //   ⚠️ **上一版这里写的是「今天唯一的护栏是 `admin-models` 那三格」，P3e Task 10
  //   自己把它变成了假话**（那一期新加的就是上面 ② 那一格），阶段 D 回填时实测订正。
  //   **「唯一」这种词只要有人补一格网就过期一次**——写「哪几格会红、红了说什么」，
  //   别写「只有谁会红」。
  admin.get("/admin/api/models", modelsHandler());

  // ── Tier-2 用量（P3d Task 4）────────────────────────────────────────────
  //
  // 两条都是只读的。**唯一会烧配额的是读扇出**：`30d` 那一档一次请求发
  // `30 × USAGE_SLOTS = 60` 次 get（计划 §配额账「读侧」那张表），
  // 而 `src/core/admin/usage-stats.ts` 的 `USAGE_DAY_RETAIN` 上方记着 U-H 的裁定
  // ——**Cloudflare 的两页官方文档在这个数上互相对不上，在 P3e 真机了结之前
  // 不许把 60 写成「安全的」**。所以那一档必须失败得诚实，见 `usageHandler`。
  //
  // ⚠️ **`/admin/api/usage` 与 `/admin/api/usage/:date` 不会互相吃掉**：
  // Hono 按注册顺序匹配，而两者段数不同（三段 vs 四段），形状上不可能重叠。
  // **但再往这一节里加任何一条同为四段的路径，`:date` 就会把它吃掉**——
  // ⚠️⚠️ **不管新加的那条是通配（`/usage/:something`）还是字面段（`/usage/summary`），
  // 只要排在 `:date` 之后就恒不可达**。上一版这里写的是「真要加，请把它排在 `:date`
  // 之后」——**那句话把人直接推进坑里**，阶段 D 回填时实测订正：
  // 追加 `admin.get("/admin/api/usage/summary", …)` 之后它恒回
  // `400 date 必须是 UTC 的 YYYY-MM-DD，收到的是：summary`，而当时四道护栏一格都不红。
  // ⇒ **规矩是「更窄的排在更宽的之前」**：字面段放 `:date` 上面，通配之间想清楚谁先匹配。
  // 现在由 `tests/contract/admin-auth.test.ts` 的
  // 「窗口内更宽的模式不许排在更窄的之前 —— 被吃掉的那一条恒不可达，而它只会回一个看起来合理的 400」
  // 那一格守着，它从 `app.routes` 现算，不用回来改任何清单。
  // 同一个坑在本文件里这是第四处（`bulk` vs `:id`、`channels/:c/test` vs `tend`、
  // `keys/:id/usage`），措辞刻意一致。
  //
  // ⚠️ **「被静态兜底吃掉」这个方向，哪几格会红是实测出来的、不是推出来的**
  //（本任务变异 M6：把这三条一并挪到下面 `admin.route("/", uiRoutes())` 之后）：
  // · `tests/contract/admin-usage.test.ts` 的
  //   「Tier-2 关着时照样交出这把 key 的 Tier-1 计数 —— 两者本来就是两套账」
  //   一带**大面积变红**（三条端点全变 404）；
  // · `tests/contract/ui-serve.test.ts` 的
  //   「**/admin/api/* 不会被静态兜底吃掉**——注册顺序错了会让整套管理 API 变成 404」
  //   **不红**——它探的是 `/admin/api/session` 那一条，与这三条的注册位置无关；
  // · `tests/contract/admin-auth.test.ts` 的
  //   「每一条 /admin/api/* 都注册在 adminAuth 之后、静态兜底之前 —— 位置写错了它会恒 404 而没人拦」
  //   **会红并逐条点名**（实测报文 `[ 'GET /admin/api/usage', …(1) ]`）；
  //   而同一份文件里的「每一条路由 × 每一种凭据状态，逐格断言」**不红**——它只断言
  //   「拿对口令时不该被判 401」，而被兜底吃掉之后拿到的是 **404，照过**。
  //   ⚠️ **两格判定相反，别当成一格。**
  //   ⚠️ **上一版这里写的是「今天唯一的护栏是 `admin-usage.test.ts` 整个文件」，
  //   P3e Task 10 补的正是上面那一格，它当场把这句话变成了假话**，阶段 D 回填时实测订正。
  // ⚠️ **刻意不写死「几格红」**：那个数每加一条用例就过期一次（本任务实测吃过一次，
  // 一个补用例的提交让上一版写下的「49 格红」当场变成 51）。**「不红」不会过期**，
  // 而它才是这条记录真正承载的那半。
  // 与 `GET /admin/api/models` 上方那段记的是同一个形态、同一个结论。
  //
  // **两条都无条件注册，不看 Tier-2 开没开**：路由表随运行时配置变化的话，
  // `tests/contract/admin-auth.test.ts` 的枚举式鉴权矩阵会因为默认夹具恰好关着
  // Tier-2 而让这两条从矩阵里消失。「Tier-2 没开」是响应体里的 `tier: "off"`，
  // 不是「这条路由不存在」——与注册机那三条同一条规矩。
  //
  // ⚠️ **措辞订正：不是「静默地」消失**（评审实测：真把这两条改成条件注册之后
  // `admin-auth.test.ts` **2 格红**，因为那张 `EXPECTED` 快照少了两条）。
  // **但那道绊线只在「改成条件注册而没动快照」时才响**——照着红提示把 `EXPECTED`
  // 里那两行删掉，两条端点就真的从整个矩阵里消失了，而且从此一路全绿。
  // `admin-auth.test.ts` 里 `POST /admin/api/registrar/tend` 那段把这一步写全了，
  // 这里上一版漏了它，读起来像是「快照拦得住」——**它拦的是「忘了改快照」，
  // 不是「有意把端点做成条件注册」。**
  const usage = { usage: deps.usage, now: deps.now };
  admin.get("/admin/api/usage", usageHandler(usage));
  admin.get("/admin/api/usage/:date", usageDateHandler(usage));

  // ★ 必须在**全部** /admin/api/* 路由之后注册：Hono 把匹配上的 handler 按注册顺序
  // 串起来跑，`/admin/*` 这条兜底若排在前面会先返回 404，**整套管理 API 直接消失**
  // ——拿着正确口令也是 404，没有任何报错。（已实测；由 `tests/contract/ui-serve.test.ts`
  // 的「**/admin/api/* 不会被静态兜底吃掉**——注册顺序错了会让整套管理 API 变成 404」
  // 那一格守着。）**新增任何 /admin/api/* 端点都必须加在这一行之前。**
  //
  // ⚠️ **这段注释在 P3c Task 1 之前是 `scripts/check-comment-refs.mjs` 那道门禁看不见的**：它上面那行里的
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
