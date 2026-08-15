import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import { httpError, readJson } from "../errors.js";

/**
 * 视频任务标识的合法形状。
 *
 * 原实现把 `:id` 直接拼进上游路径，已鉴权的客户端因此可以拿池中的真实上游 key
 * 打上游的任意路径：`/v1/videos/..%2F..%2Fadmin` 会拼出 `.../v1/videos/../../admin`，
 * fetch 规范化后落到 `/admin`；`/v1/videos/x%3Fsecret%3D1` 则是查询参数注入。
 * 故先按白名单校验形状（不匹配直接 400），再 encodeURIComponent 做纵深防御。
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/;

// 图片：同步转发。视频：建任务 + 轮询的两段式。
// 成片不在网关落地——上游返回什么（URL 或字节流）就原样转发，
// 让 Worker 与 Docker 两种部署形态行为一致，也不引入对象存储依赖。
export function mediaRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();

  app.post("/v1/images/generations", async (c) =>
    dispatch({ path: "/images/generations", body: await readJson(c), stream: false, deps }));

  app.post("/v1/videos", async (c) =>
    dispatch({ path: "/videos", body: await readJson(c), stream: false, deps }));

  app.get("/v1/videos/:id", async (c) => {
    const id = c.req.param("id");
    if (!VIDEO_ID.test(id)) {
      throw httpError(400, "invalid_request_error", "视频任务标识格式非法");
    }
    return dispatch({
      path: `/videos/${encodeURIComponent(id)}`, body: undefined, stream: false, method: "GET", deps,
    });
  });

  return app;
}
