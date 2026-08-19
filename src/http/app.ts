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
  // `gatewayToken` 在这里取的是**装配时刻**的快照，用途只有一个：拒绝
  // ADMIN_TOKEN == GATEWAY_TOKEN 这种配置。它不参与逐次请求的鉴权判定。
  const admin = adminRouter({
    adminToken: deps.adminToken,
    gatewayToken: deps.configHolder.current().gatewayToken,
    version: deps.version,
    logger: deps.logger,
    trustProxy: deps.trustProxy ?? false,
  });
  if (admin) app.route("/", admin);
  return app;
}
