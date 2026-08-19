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
import type { ConfigHolder } from "./config-holder.js";
import type { DispatchDeps } from "../core/dispatcher.js";
import type { StorageHealth } from "../core/storage-health.js";
import type { Logger } from "../ports/logger.js";

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
}

/**
 * 把 AppDeps 变成 dispatch 要的 DispatchDeps。
 *
 * `config` 用 **getter** 而不是拷值：路由工厂在建 app 那一刻就把 deps 闭包捕获了，
 * 拷值等于把配置永久冻结在启动时刻——这正是缺陷 D2 的成因。getter 让每次属性读取
 * 都取当前值；而 dispatch() 在请求开头解构一次（dispatcher.ts:209），
 * 因此**单个请求内部仍是一份一致的快照**，这正是想要的语义。
 */
function dispatchDeps(deps: AppDeps): DispatchDeps {
  return {
    repo: deps.repo,
    fetcher: deps.fetcher,
    now: deps.now,
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
   * 这个取舍由 tests/contract/security-headers.test.ts 反向钉住。
   *
   * ⚠️ **必须写在 `await next()` 之后。** 已实测（Hono 4.13.2，两个方向都跑过，
   * 见 security-headers.test.ts 末尾那条把这个语义直接钉住的用例）：
   * 写在 next() **之前**时，`c.header()` 进的是 preparedHeaders，只对 **Hono 自己
   * 构造**的响应（`c.json` / 默认 404）生效；handler 直接 `return new Response(...)`
   * 的形态（流式转发、dispatcher 的错误响应、uiRoutes 的 200/301/304/404）
   * **整条头会被静默丢掉**。写在之后则五种形态全部生效。
   *
   * 今天这条变异**在本仓是不可观测的**（唯一返回裸 Response 的 /admin 那棵树
   * 自己也设了 nosniff），所以它是留给下一个 handler 的陷阱，不是现存缺陷——
   * 那条语义用例就是为此存在的。
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
  });
  if (admin) app.route("/", admin);
  return app;
}
