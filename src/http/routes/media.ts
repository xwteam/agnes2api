import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";

// 图片：同步转发。视频：建任务 + 轮询的两段式。
// 成片不在网关落地——上游返回什么（URL 或字节流）就原样转发，
// 让 Worker 与 Docker 两种部署形态行为一致，也不引入对象存储依赖。
export function mediaRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();

  app.post("/v1/images/generations", async (c) =>
    dispatch({ path: "/images/generations", body: await c.req.json(), stream: false, deps }));

  app.post("/v1/videos", async (c) =>
    dispatch({ path: "/videos", body: await c.req.json(), stream: false, deps }));

  app.get("/v1/videos/:id", async (c) =>
    dispatch({ path: `/videos/${c.req.param("id")}`, body: undefined, stream: false, method: "GET", deps }));

  return app;
}
