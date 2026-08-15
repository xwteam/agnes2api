import { Hono } from "hono";
import type { StorageHealth } from "../../core/storage-health.js";

/**
 * 存储不可写时对外的固定说明。
 *
 * 刻意不回显底层异常信息（例如 `EACCES: permission denied, open '/app/data/...'`）：
 * `/health` 是不鉴权端点，不该把内部路径与原始错误暴露给任何人。真正的异常写在容器
 * 日志里，排障看日志即可。
 */
const UNWRITABLE_DETAIL =
  "数据目录不可写，key 池无法持久化。Docker 部署常见于绑定挂载的宿主目录属主与容器内运行用户不一致，详见容器日志";

export function healthRoutes(version: string, storage: StorageHealth): Hono {
  const app = new Hono();

  // 只读内存中的状态，不触发任何存储 I/O——HEALTHCHECK 每 30 秒来一次也不会写盘。
  app.get("/health", (c) => {
    const { writable } = storage.status();
    if (writable) return c.json({ status: "ok", version, storage: { writable: true } });

    // 503 而不是 200：镜像内置的 HEALTHCHECK 按响应是否 ok 判定，只有这样容器才会被
    // 标成 unhealthy。原实现里这种容器一直报 healthy，而每一次 API 调用都在失败。
    return c.json(
      { status: "degraded", version, storage: { writable: false, detail: UNWRITABLE_DETAIL } },
      503,
    );
  });

  return app;
}
