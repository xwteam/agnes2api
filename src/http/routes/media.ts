import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import {
  VIDEO_TASK_ID_RE, mediaEndpointById, withTaskId,
} from "../../core/admin/protocol-catalog.js";
import { httpError, readJson } from "../errors.js";

// 图片：同步转发。视频：建任务 + 轮询的两段式。
// 成片不在网关落地——上游返回什么（URL 或字节流）就原样转发，
// 让 Worker 与 Docker 两种部署形态行为一致，也不引入对象存储依赖。
//
// ⚠️ **这三条路径（对外那半与上游那半）都不再写在本文件里**（P3d Task 12）：
// 它们住在 `src/core/admin/protocol-catalog.ts` 的 `MEDIA_ENDPOINTS` 里，本文件是
// 它的消费者之一，Playground 的媒体模式是另一个。搬过去的理由与那张表上方那段
// 一致——**对外路径与上游路径是同一条路由的两半**，把一半搬进真源、另一半留在这里，
// 等于让下一个改动的人只看见一半。
// 由 `tests/contract/protocol-catalog.test.ts` 的
// 「媒体端点 %s：对外那条真的注册着、上游那条逐字等于 agnesBaseUrl + upstreamPath」
// 钉着（观测点是真出站 URL，不是比对本文件与目录的两个字段，那是同义反复）。
//
// 超时档位（`timeout`）在本文件里三条路由上并不一致，这是刻意的：
// 图片生成与视频建任务是**同步**接口，首字节要等上游把整个结果算完才到达（实测图片
// 11.99 秒），必须用 `sync` 档；视频轮询只是查一次任务状态，是快接口，沿用默认的 8 秒
// 首字节档即可——给它长超时只会让一次上游卡死拖住客户端两分钟。
// 轮询是「非流式但仍用首字节档」的唯一一处例外，对话四条路由的判据是
// `stream ? "firstByte" : "sync"`（见 TimeoutProfile）。
export function mediaRoutes(deps: DispatchDeps): Hono {
  const app = new Hono();
  const image = mediaEndpointById("image.generate");
  const create = mediaEndpointById("video.create");
  const poll = mediaEndpointById("video.poll");

  app.post(image.pathTemplate, async (c) =>
    dispatch({ path: image.upstreamPath, body: await readJson(c), stream: false, timeout: "sync", deps }));

  app.post(create.pathTemplate, async (c) =>
    dispatch({ path: create.upstreamPath, body: await readJson(c), stream: false, timeout: "sync", deps }));

  app.get(poll.pathTemplate, async (c) => {
    // 参数名从占位符本身derive（`":id"` → `"id"`），**不再写第二遍**：
    // 路径模板换个占位符名字而这里没跟着改的话，取到的是 `undefined`，
    // 而那会让**每一次**轮询都 400——一条只有部署完才发现的故障。
    const id = c.req.param(String(poll.taskSlot).slice(1)) ?? "";
    if (!VIDEO_TASK_ID_RE.test(id)) {
      throw httpError(400, "invalid_request_error", "视频任务标识格式非法");
    }
    return dispatch({
      path: withTaskId(poll.upstreamPath, String(poll.taskSlot), encodeURIComponent(id)),
      body: undefined, stream: false, method: "GET", deps,
    });
  });

  return app;
}
