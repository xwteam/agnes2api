import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorResponse } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { openaiRoutes } from "./routes/openai.js";
import { anthropicRoutes } from "./routes/anthropic.js";
import { geminiRoutes } from "./routes/gemini.js";
import { responsesRoutes } from "./routes/responses.js";
import { mediaRoutes } from "./routes/media.js";
import { auth } from "./middleware/auth.js";
import { adminRouter } from "./admin/router.js";
import { configRefresh } from "./config-refresh.js";
import { logFlush } from "./log-flush.js";
import { usageFlush } from "./usage-flush.js";
import type { UsageSink, UsageRecording } from "./usage-sink.js";
import { USAGE_FLUSH_MIN_INTERVAL_MS } from "../core/admin/usage-stats.js";
import type { ConfigHolder } from "./config-holder.js";
import type { DispatchDeps } from "../core/dispatcher.js";
import type { StorageHealth } from "../core/storage-health.js";
import type { Logger } from "../ports/logger.js";
import type { RuntimeInfo } from "../ports/runtime.js";
import { nodeRuntime } from "../adapters/runtime-node.js";
import { StoreLogger } from "../adapters/logger-store.js";
import type { Storage } from "../ports/storage.js";
import { createTendGate, type TendGate } from "./admin/tend-lock.js";
import type { RegistrarWiring } from "./admin/handlers/registrar.js";
import type { ConfigWiring } from "./admin/handlers/config.js";

export interface AppDeps extends Omit<DispatchDeps, "config"> {
  version: string;
  configHolder: ConfigHolder;
  storageHealth: StorageHealth;
  logger: Logger;
  /**
   * 管理口令。**只从环境变量读、不从存储读**（设计文档 §8.1 规则 2）——这一刀同时
   * 切掉了「面板改自己的钥匙 + 配置缓存陈旧 + 把自己锁在外面」这一整类问题。
   *
   * 未设置（或不合规）时**整棵 /admin 树都不注册**，访问得到 404 而不是 401，
   * 不泄漏「这里有个后台」；网关转发不受任何影响。
   */
  adminToken?: string;
  /** 见 `clientIp`：设了才信 `X-Forwarded-For`。默认 false。 */
  trustProxy?: boolean;
  /**
   * 双运行时差异的唯一注入点（`GET /admin/api/capabilities` 与 `overview` 的来源）。
   *
   * **这里可选、默认 `nodeRuntime()`**——与 `wire.ts` 里 `buildApp` 那个必填参数
   * 刻意不同：那里是两个**生产入口**唯一装配 app 的地方，忘传就是真实的双运行时
   * 失配；这里是被海量既有测试直接调用的底层装配函数，给它一个安全的默认值
   * 换来的是不必为一个与 runtime 无关的测试改动去牵连几十个调用点。
   */
  runtime?: RuntimeInfo;
  /** 被环境变量锁定的字段清单（`envLockedFields` 的结果）。默认空数组，理由同 `runtime`。 */
  envLocked?: readonly string[];
  /**
   * 事件落库 sink（Task 6）。**可选，默认建一个独立的、与 `deps.logger` 无关的
   * `StoreLogger`**——与 `runtime`/`envLocked` 同一条理由：这里是被海量既有测试
   * 直接调用的底层装配函数，给它一个安全默认值换来的是不必为一个与事件持久化无关
   * 的测试改动去牵连几十个调用点。
   *
   * **两个生产入口经 `wire.ts` 的 `buildApp` 总是显式传入与 `deps.logger` fan-out
   * 到同一个实例的 `StoreLogger`**，那时它才真正接进日志链路。这里的默认值从不被
   * 任何调用方 `.log()`（没人把它 fan-out 进 `deps.logger`），所以在默认夹具下
   * `/admin/api/events` 恒是「没有事件」——这是刻意的空转，不是缺陷。
   */
  storeLogger?: StoreLogger;
  /**
   * 注册机的执行体与它的存储（P3c Task 5 建，Task 6 扩到三样成套）。
   * **可选，缺省 `undefined`**。
   *
   * 只有 `wire.ts` 的 `buildApp` 装配得出来（它要 `env`），所以直接调 `createApp` 的
   * 那几十个测试一律不传。**缺省时三条端点照常注册、照常鉴权，但会如实回
   * `503 not_wired`**——`tend` 不假装 202、`status` 不编造一份空历史，
   * 见 `RegistrarWiring`。
   */
  registrar?: RegistrarWiring;
  /**
   * 补池在途守卫。**可选，缺省新建一个只属于这个 app 的**。
   *
   * `wire.ts` 显式传入并把同一把交给 `src/entry/node.ts` 的定时轮：Node 是单进程，
   * 定时轮与面板按钮必须共用**这一把**。Worker 的 `fetch` isolate 与 `scheduled`
   * isolate 本来就不共享内存，那里各自一把是**正确的**，跨 isolate 由存储锁负责。
   */
  tendGate?: TendGate;
  /**
   * 配置读写的接线（P3c Task 7）。**可选，缺省 `undefined`**，理由与 `registrar`
   * 完全相同：只有 `wire.ts` 的 `buildApp` 手上才有 `env`。
   *
   * **缺省时四条端点照常注册、照常鉴权，但如实回 `503 not_wired`**——不假装读到了
   * 一份空配置。「这个 app 读不到配置」与「配置全是默认值」在面板上会长得一模一样，
   * 而后者是一句假话。
   */
  config?: ConfigWiring;
  /**
   * Tier-2 用量 sink（P3d Task 3）。**可选，缺省 `undefined` = Tier-2 关着。**
   *
   * ⚠️ **缺席时这里一个兜底实例都不建**，与 `storeLogger` 那条刻意相反：
   * 那一份缺省会 new 一个背后接 no-op `Storage` 的 `StoreLogger`，因为两个 handler
   * 需要一个总能调的实例；这一份**必须真的不存在**——全局约束 16 的原话是
   * 「关闭时一次存储访问都不许有、**一个内存累加器都不许建**」，
   * 一个「反正没写盘」的累加路径迟早会被某次改动接上写。
   * 缺席的三处后果都是结构性的、不靠 `if` 维持：
   * ① `usageFlush` 中间件整条不挂；② 四条路由的 `recordUsage()` 第一行就 return；
   * ③ `GET /admin/api/capabilities` 的 `stats.tier2Enabled` 如实报 false。
   *
   * **只有 `wire.ts` 的 `buildApp` 会传它**（它才读得到 `USAGE_STATS_ENABLED`），
   * 直接调 `createApp` 的那几十个测试一律不传 ⇒ 它们的行为一个字节都没变。
   */
  usageSink?: UsageSink;
  /**
   * 生效的落盘间隔（P3d Task 3）。**可选，缺省 = 后端常量**
   *（`USAGE_FLUSH_MIN_INTERVAL_MS`），理由与 `runtime`/`envLocked` 同一条：
   * 这里是被海量既有测试直接调用的底层装配函数。
   *
   * 只有 `wire.ts` 的 `buildApp` 算得出它（要 `env` 与 `runtime.quotaModel` 两样），
   * 它会经 `GET /admin/api/capabilities` 的 `stats.flushIntervalMs` 发给面板。
   * **与 `usageSink` 是两件事**：Tier-2 关着的时候这个数照样有意义
   *（说明卡要说清「打开之后尾巴最长多久」）。
   */
  usageFlushIntervalMs?: number;
}

/**
 * `AppDeps.storeLogger` 缺省时的兜底：一个背后接着「无操作」`Storage` 的
 * `StoreLogger`。它永远不会被写入任何真实数据（没人把它接进 `deps.logger`），
 * 存在的唯一理由是让 `logFlush` 中间件与 `/admin/api/events` 两个 handler
 * 始终有一个可调用的实例，不必在这两处各自判断「有没有配置」。
 *
 * ⚠️ **评审四审 B 组第 4 条**：下面这个 `inertStorage` 是**对象字面量**形式的
 * `Storage` 实现，因此 `grep -rln "implements Storage" src/`（修复轮 5 用来论证
 * "`runStorageContract` 覆盖了全部生产实现"的那条命令）**按构造就看不见它**。
 * 它有意不进那份契约名册——no-op sink，不持有任何数据，没有那份契约要守的性质
 * （TTL、`list` 过期过滤、有界性），今天也因此没有任何有界性后果。完整理由与
 * 修订后的判据写在 `tests/contract/storage.test.ts` 的名册注释里；**若有人把它
 * 换成会真的存东西的实现，那条注释就是该被拦下的地方。**
 */
function defaultStoreLogger(now: () => number): StoreLogger {
  const inertStorage: Storage = {
    async get() { return null; },
    async put() { /* 默认 sink 不落任何盘，见 AppDeps.storeLogger 的说明 */ },
    async delete() { /* 同上 */ },
    async list() { return []; },
  };
  return new StoreLogger({ storage: inertStorage, now, shardId: "unwired", onError: () => {} });
}

/**
 * 把 AppDeps 变成 dispatch 要的 DispatchDeps。
 *
 * `config` 用 **getter** 而不是拷值：路由工厂在建 app 那一刻就把 deps 闭包捕获了，
 * 拷值等于把配置永久冻结在启动时刻——这正是缺陷 D2 的成因。getter 让每次属性读取
 * 都取当前值；而 dispatch() 在请求开头解构一次（dispatcher.ts:209），
 * 因此**单个请求内部仍是一份一致的快照**，这正是想要的语义。
 *
 * ⚠️ **返回值不许被展开（`{ ...dispatchDeps(deps) }`）。** 展开会**当场求值**那个
 * getter 并把结果拷成一个普通属性 ⇒ 配置重新冻结在建 app 那一刻，缺陷 D2 原样复活，
 * 而 `tsc` 一个字都不会说。P3d Task 3 加 `usageSink` 那一格时差点这么写
 * ——**要加字段就加在下面这个对象字面量里**，别在调用点拼。
 */
function dispatchDeps(deps: AppDeps): DispatchDeps & UsageRecording {
  return {
    repo: deps.repo,
    fetcher: deps.fetcher,
    now: deps.now,
    logger: deps.logger,
    /**
     * Tier-2 归因（P3d Task 3）。**协议名由路由层传，不改 `dispatch()` 的签名**：
     * 那个函数的参数里没有「这是哪条协议」这一维（V5），加一维要牵动 30 多处测试
     * 构造点，而路由层本来就是唯一知道答案的那一层。
     * 缺席（Tier-2 关着）时四条路由的 `recordUsage()` 第一行就 return。
     */
    usageSink: deps.usageSink,
    get config() { return deps.configHolder.current(); },
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // 没有这个兜底时，任何未捕获异常都会变成 Hono 默认的 `500 Internal Server Error`
  // 纯文本响应——四种协议的客户端 SDK 都会在解析 JSON 时二次报错，拿不到任何线索。
  // 只输出固定文案，不回显 err.message：异常信息里可能含上游 URL、栈帧等内部细节。
  app.onError((err) => {
    if (err instanceof HTTPException) return err.getResponse();
    return errorResponse(500, "internal_error", "网关内部错误");
  });

  // ★ 顺序敏感（已实测 Hono 4.13.2）：把 route 写在 use 之前，中间件会**静默失效
  // 且不报错**（实测 200 handler 而不是 401）。任何新增的 use 都必须写在这一段里，
  // 不许混进下面那堆 route 中间。
  app.use("*", configRefresh(deps.configHolder));

  // 事件落库中间件（Task 6）。**挂在 configRefresh 之后、其余中间件（含下面的全局
  // nosniff）之前**——它必须在 `await next()` 之后才 flush（本次请求自己产生的事件
  // 要先进缓冲），这条与全局 nosniff 必须挂在 `next()` 之后是同一条理由的另一面，
  // 见 `src/http/log-flush.ts` 的说明。
  //
  // `deps.storeLogger` 缺省时用 `defaultStoreLogger()`：它的存储是纯内存的
  // no-op，`maybeFlush()` 在缓冲恒为空的情况下第一行就 `return`，对现存的几十个
  // 直接调用 `createApp()` 的测试零行为影响。
  const storeLogger = deps.storeLogger ?? defaultStoreLogger(deps.now);
  app.use("*", logFlush(() => storeLogger.maybeFlush()));

  // Tier-2 用量落盘（P3d Task 3）。**`usageSink` 缺席时整条不挂**——见 `AppDeps.usageSink`
  // 的说明（全局约束 16：「关」不是一个 if，是这条路径压根不存在）。
  //
  // 相对 `logFlush` 的位置**不承载语义**，两个 sink 各有各的键空间、各有各的写预算，
  // 谁先落都一样（用量 sink 的 `onError` 刻意走 console 而不是事件链路，所以它也不会
  // 反过来给事件缓冲添东西——见 `wire.ts` 里建它那一段）。
  // ⚠️ **别把「注册在后面」读成「落盘在后面」**：中间件的收尾段是**由内向外**跑的，
  // 注册得越晚，`await next()` 之后那一半反而越早执行 ⇒ 今天是**用量先落、事件后落**。
  // 本任务实测吃过这个亏：一条「用量 flush 没 await」的变异之所以逃逸，正是因为
  // 紧随其后的事件 flush 那次存储 I/O 顺手把它带完了（现在那一格靠一个足够长的
  // 挂起点摆脱了对排序的依赖，见 `tests/contract/usage-tier2.test.ts` 的
  // 「落盘在响应返回之前就完成：把那次写卡在闸门上，响应就出不来 ——……」）。
  const usageSink = deps.usageSink;
  if (usageSink !== undefined) app.use("*", usageFlush(() => usageSink.maybeFlush()));

  /**
   * 全应用级 `nosniff`。
   *
   * Task 6 之前**整个网关一条安全响应头都没有**（实测 `/health` 的
   * `x-content-type-options` 是 null），而 Task 6 又正是第一次在这个 origin 上
   * 建立凭据存储的提交——面板把 `ADMIN_TOKEN` 原样放进 localStorage，作用域是
   * **origin 而不是 path**，所以 `/admin` 之外任何一条能被浏览器当 HTML 解析的
   * 响应，都是这份凭据的攻击面。
   *
   * **只提 nosniff，不提 CSP / X-Frame-Options**：后两条防的是「文档被渲染 /
   * 被套进 iframe」，而 `/v1/*` 与 `/health` 从不返回文档，加上去只是仪式感；
   * 面板那棵树该有的全套在 src/ui/serve.ts 里，那里才是真的会被当页面加载的地方。
   * 这个取舍由 `tests/contract/security-headers.test.ts` 的
   * 「网关侧刻意**不**加 CSP / X-Frame-Options」反向钉住。
   *
   * ⚠️ **必须写在 `await next()` 之后。** 已实测（Hono 4.13.2，两个方向都跑过，
   * 见 security-headers.test.ts 末尾那条把这个语义直接钉住的用例）：
   * 写在 next() **之前**时，`c.header()` 进的是 preparedHeaders，只对 **Hono 自己
   * 构造**的响应（`c.json` / 默认 404）生效；handler 直接 `return new Response(...)`
   * 的形态（流式转发、dispatcher 的错误响应、uiRoutes 的 200/301/304/404）
   * **整条头会被静默丢掉**。写在之后则五种形态全部生效。
   *
   * ⚠️ **这里原来写着「今天这条变异在本仓是不可观测的（唯一返回裸 Response 的
   * /admin 那棵树自己也设了 nosniff）」——那句现在是假的，两处都假**
   *（全分支评审 A9）：
   * ① 把这一行**移动**到 `next()` 之前（不是新增一行）之后实测 **2 failed**：
   *    `tests/contract/admin-events.test.ts` 的「下载端点是裸 Response，且**仍然**带全局 nosniff」
   *    （`/admin/api/events/download` 是裸 `Response`，且它自己**不**设 nosniff——
   *    全靠这条全局的）与 `tests/contract/media.test.ts` 的
   *    「上游 text/html 经这条真实路由出来时是 application/octet-stream，且 nosniff 还在」；
   * ② 「唯一返回裸 Response 的是 /admin 那棵树」本身也不成立——`routes/media.ts`
   *    在 `/v1` 上就返回裸 `Response`。
   * 所以这条变异**今天就是一个可观测的现存缺陷**，不是"留给下一个 handler 的陷阱"。
   * 那条语义用例照旧有价值（它把 Hono 的行为本身钉住，与本仓路由清单无关），
   * 但它不再是唯一的护栏。
   */
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
  });

  const dd = dispatchDeps(deps);
  app.route("/", healthRoutes(deps.version, deps.storageHealth));
  app.use("/v1/*", auth(() => deps.configHolder.current().gatewayToken));
  app.use("/v1beta/*", auth(() => deps.configHolder.current().gatewayToken));
  app.route("/", openaiRoutes(dd));
  app.route("/", anthropicRoutes(dd));
  app.route("/", geminiRoutes(dd));
  app.route("/", responsesRoutes(dd));
  app.route("/", mediaRoutes(dd));

  // /admin 挂在最后不要紧：它的鉴权 use 收在子 app 内部的第一行，外层 route 的
  // 位置对它无关紧要（已实测，见 admin/router.ts 的说明）。
  //
  // `currentGatewayToken` 传 **getter 而不是值**（与 dispatchDeps 的 config getter
  // 同一个理由）：「ADMIN_TOKEN 不得等于 GATEWAY_TOKEN」这条规则要在每个管理请求上
  // 复查，而 gatewayToken 可以在运行中被改（见 admin/auth.ts 的运行期复查说明）。
  const admin = adminRouter({
    adminToken: deps.adminToken,
    currentGatewayToken: () => deps.configHolder.current().gatewayToken,
    version: deps.version,
    logger: deps.logger,
    trustProxy: deps.trustProxy ?? false,
    // **原样传转发路径那一个 repo**，不新建：面板与转发共用同一份 isolate 快照，
    // 面板轮询才不会各自去读一遍存储（设计文档 §2.4 第 1、2 条）。
    repo: deps.repo,
    now: deps.now,
    configHolder: deps.configHolder,
    storageHealth: deps.storageHealth,
    // 双运行时差异的唯一注入点，见 AppDeps.runtime 的说明。
    runtime: deps.runtime ?? nodeRuntime(),
    envLocked: deps.envLocked ?? [],
    storeLogger,
    // 注册机接线（P3c Task 5/6）。两者都可选，缺省的后果各自写在 `AppDeps` 上：
    // 没接执行体 ⇒ 三条端点如实回 503；没传守卫 ⇒ 这个 app 自己一把（Worker 形态本来就该这样）。
    registrar: deps.registrar ?? null,
    tendGate: deps.tendGate ?? createTendGate(),
    config: deps.config ?? null,
    // **同一个事实的同一个来源**：面板问的是「Tier-2 有没有在记账」，
    // 而那件事的全部真相就是「这个 app 建没建 sink」。不从 `configHolder` 现读
    // `usageStatsEnabled`——那个开关是建 app 时读一次的，现读会与事实分叉，
    // 见 `capabilitiesHandler` 的同名参数。
    usageStatsEnabled: usageSink !== undefined,
    usageFlushIntervalMs: deps.usageFlushIntervalMs ?? USAGE_FLUSH_MIN_INTERVAL_MS,
  });
  if (admin) app.route("/", admin);
  return app;
}
