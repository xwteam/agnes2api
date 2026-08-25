import { Hono } from "hono";
import { dispatch, type DispatchDeps } from "../../core/dispatcher.js";
import {
  VIDEO_TASK_ID_RE, VIDEO_TASK_ID_SHAPE, mediaEndpointById, withTaskId,
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
// 「媒体端点 %s：对外那条真的注册着、上游那条打到了手写表上那一条」
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
      // **报文要说得清「该怎么改」，不只是「不合法」。** 形状逐字来自
      // `VIDEO_TASK_ID_SHAPE`（真源是 `VIDEO_TASK_ID_RE` 本身，这里不许手抄第二份）。
      //
      // ⚠️ **它必须同时说出「你改得动的那一半」和「你改不动的那一半」，否则就是把人
      // 往坑里引**（阶段 D 的教训：报文说「改这个数」，照做了还是恒 400）。标识是
      // **上游在建任务那一步签发的**：读者自己弄脏了它（编码、引号、空白）时照着改就通；
      // 而上游本来就签发了别的形状时，**改请求参数一点用都没有** —— 那是本网关一条
      // 已知的未核实假设，路在这里断，得改网关。两句话缺一句都会让人白试一轮。
      throw httpError(
        400, "invalid_request_error",
        `视频任务标识格式非法：本网关只接受 ${VIDEO_TASK_ID_SHAPE} 这个形状`
        + "（前一段是允许的字符集，括号里是长度的下界与上界）。"
        + "这个标识是上游在 POST /v1/videos 那一步签发的，不是你输入的："
        + "把那次响应里的标识原样贴回来（别做 URL 编码、别带引号或空白）通常就能过；"
        + "若上游签发的标识本身就超出这个集合，改请求参数没有用——"
        + "那是本网关一条已知的未核实假设，见 API.md 的 `GET /v1/videos/{id}` 一节。",
      );
    }
    return dispatch({
      path: withTaskId(poll.upstreamPath, String(poll.taskSlot), encodeURIComponent(id)),
      body: undefined, stream: false, method: "GET", deps,
    });
  });

  return app;
}
