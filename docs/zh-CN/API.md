# API 参考

以下示例统一使用 `http://localhost:8080`（Docker/Node 的监听地址）。若部署在
Cloudflare Worker 上，替换成你的 `*.workers.dev` 域名（或自定义域名）即可。

`your-gateway-token` 是你设置的 `GATEWAY_TOKEN` 的占位符。

## 鉴权

`/v1/*` 与 `/v1beta/*` 下的所有路由都需要凭据，`/health` 不需要。以下四种传递方式任选
其一即可——正好对应各协议官方 SDK 默认发送的凭据形式，通常无需额外配置：

| 方式 | 示例 |
|----|----|
| `Authorization: Bearer` 请求头 | `Authorization: Bearer your-gateway-token` |
| `x-api-key` 请求头 | `x-api-key: your-gateway-token` |
| `x-goog-api-key` 请求头 | `x-goog-api-key: your-gateway-token` |
| `key` 查询参数 | `?key=your-gateway-token` |

缺少或错误的凭据返回 `401`：

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

## 模型

网关暴露四个模型，调用哪个端点决定该传哪个：

| 模型 | 用于 |
|----|----|
| `agnes-2.0-flash` | 对话/文本类端点 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## key 池耗尽时的错误

若 key 池中没有可用 key，网关会在发起上游请求之前直接返回 `503`：

| `reason` | 是否自愈 | 含义 |
|--------|--------|----|
| `pool_empty` | – | 尚未导入任何 key。 |
| `all_cooling` | **会** | 全部 key 处于冷却中（限流、欠费或瞬时故障累计）。响应头 `Retry-After` 给出最早恢复时刻。 |
| `all_disabled` | **不会** | 全部 key 被管理员在管理面板上**手工停用**。在面板上重新启用即可——**凭据本身没问题，别去换 key**。 |
| `all_evicted` | **不会** | 全部 key 因凭据失效（上游 `401`/`403`）被永久剔除，请更换 key。 |
| `upstream_error` | **会** | key 本身可用，但上游每次尝试都失败。 |

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
{ "error": { "reason": "all_disabled", "message": "全部 3 把 key 均不可用且不会自动恢复：3 把被管理员手工停用（在管理面板上重新启用即可）" } }
```

## 同步端点超时（`504`）

图片生成、视频建任务，以及**所有非流式对话**（四种协议）走的是同步超时预算
`UPSTREAM_SYNC_TIMEOUT_MS`（默认 120000 毫秒，见 [部署指南](DEPLOY.md#环境变量)）。当这次
请求在总预算内尝试过的每一把 key 都没有响应时，返回 `504`：

| `reason` | 含义 |
|--------|----|
| `upstream_timeout` | 本次请求用尽了 `UPSTREAM_SYNC_TIMEOUT_MS` 的总预算，其间尝试过的 key 都没在各自的尝试预算内响应。可能是上游整体变慢或预算配小，也可能是这几把 key 对应的上游会话被挂起。 |

```json
{ "error": { "reason": "upstream_timeout", "message": "同步端点用尽了 120000 毫秒的总预算：已尝试 2 把 key，均未在各自的尝试预算内收到上游响应……" } }
```

这个总预算就是客户端的最坏等待时间，与池子大小无关。收到 `504` 时网关**没有**惩罚任何
key；只有当同一次请求里另一把 key 成功了，先超时的那把才会被记账。

除以上情况外，上游返回的其他错误状态码（`400`、`404` 等）一律原样透传，保持上游自身的
错误结构，网关不做改写。两个例外：上游 `401`/`403` 的响应体**绝不**转发（那里是上游 API
最可能回显 key 片段的地方）；格式转换类路由上，上游 `200` 但响应体不是 JSON 时返回 `502`。

上游的响应头同样不原样转发，只保留 `content-type`、`cache-control` 与 `retry-after`。其余
（`set-cookie`、`www-authenticate`、各家的 `x-*` 头）一律剥掉——池子每次请求都可能换一把
key，这些头描述的是上游账号而不是你的网关。

## `GET /health`

无需鉴权。

```bash
curl http://localhost:8080/health
```

```json
{ "status": "ok", "version": "0.1.0", "storage": { "writable": true } }
```

`storage.writable` 报告的是「key 池所在的存储是否真的写得进去」。它由启动时的一次探测与
运行期每一次真实写操作共同维护，健康检查自身不写盘。存储不可写时返回 **HTTP `503`**：

```json
{
  "status": "degraded",
  "version": "0.1.0",
  "storage": {
    "writable": false,
    "detail": "数据目录不可写，key 池无法持久化。Docker 部署常见于绑定挂载的宿主目录属主与容器内运行用户不一致，详见容器日志"
  }
}
```

镜像内置的 `HEALTHCHECK` 按响应是否成功判定，因此这种容器会被 Docker 标成 unhealthy。
具体的底层错误只写进容器日志，不在这个不鉴权端点上回显。

## `GET /v1/models`

OpenAI 格式的模型列表。

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

```json
{
  "object": "list",
  "data": [
    { "id": "agnes-2.0-flash", "object": "model", "created": 1735689600, "owned_by": "agnes2api" },
    { "id": "agnes-image-2.1-flash", "object": "model", "created": 1735689600, "owned_by": "agnes2api" },
    { "id": "agnes-image-2.0-flash", "object": "model", "created": 1735689600, "owned_by": "agnes2api" },
    { "id": "agnes-video-v2.0", "object": "model", "created": 1735689600, "owned_by": "agnes2api" }
  ]
}
```

## `POST /v1/chat/completions`

OpenAI Chat Completions 协议。非流式响应就是上游的 OpenAI 格式 JSON，原样返回。

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

```json
{
  "id": "c1",
  "choices": [{ "message": { "role": "assistant", "content": "hi" } }]
}
```

传 `"stream": true` 即可拿到流式响应：`Content-Type: text/event-stream`，标准的
OpenAI 风格 `data: {...}` 分片，以 `data: [DONE]` 结束。

⚠️ 流式末帧带不带 usage 未经真实上游核实：本网关对这条协议的流式字节原样透传，既不
解析也不改写；上游若在流末发一块 usage，那些字节会原样到达客户端。

## `POST /v1/messages`

Anthropic Messages 协议。请求体中的 `system` 与数组形态的 `content` 会在转发上游前被
压平；响应会被转换为 Anthropic 的 content block 结构。

若 `content`（或 `system`）数组里出现无法映射到内部纯文本格式的块——任何非 `text` 类型，
例如 `image`、`tool_use`、`tool_result`——网关会在转发上游前直接返回 `400`，而不是像早期
版本那样静默丢弃该块：

```json
{ "error": { "type": "invalid_request_error", "message": "不支持的内容块类型: image（本网关仅支持 text）" } }
```

`message` 中的块类型会替换成实际收到的值。

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "x-api-key: your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "max_tokens": 1024,
    "system": "你是一个乐于助人的助手。",
    "messages": [{ "role": "user", "content": "你好" }]
  }'
```

```json
{
  "id": "msg_c1",
  "type": "message",
  "role": "assistant",
  "model": "agnes-2.0-flash",
  "content": [{ "type": "text", "text": "你好" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 3, "output_tokens": 5 }
}
```

传 `"stream": true` 时响应为 `text/event-stream`，携带标准 Anthropic 事件序列：
`message_start`、`content_block_start`、一个或多个 `content_block_delta`、
`content_block_stop`、`message_delta`、`message_stop`。

## `POST /v1/responses`

OpenAI-Responses 协议。请求体中的 `instructions` 与数组形态的 `input` 会在转发上游前
被转换为 messages；响应会被转换为 `output[]` 结构。

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "你是一个乐于助人的助手。",
    "input": "你好"
  }'
```

```json
{
  "id": "resp_c1",
  "object": "response",
  "model": "agnes-2.0-flash",
  "status": "completed",
  "output": [{
    "type": "message",
    "id": "msg_c1",
    "role": "assistant",
    "status": "completed",
    "content": [{ "type": "output_text", "text": "你好", "annotations": [] }]
  }],
  "usage": { "input_tokens": 3, "output_tokens": 5, "total_tokens": 8 }
}
```

传 `"stream": true` 时响应为 `text/event-stream`，携带：`response.created`、一个或多个
`response.output_text.delta`、`response.completed`。

## `GET /v1beta/models`

Gemini 格式的模型列表。

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

```json
{
  "models": [
    { "name": "models/agnes-2.0-flash", "displayName": "agnes-2.0-flash", "supportedGenerationMethods": ["generateContent", "streamGenerateContent"] },
    { "name": "models/agnes-image-2.1-flash", "displayName": "agnes-image-2.1-flash", "supportedGenerationMethods": ["generateContent", "streamGenerateContent"] },
    { "name": "models/agnes-image-2.0-flash", "displayName": "agnes-image-2.0-flash", "supportedGenerationMethods": ["generateContent", "streamGenerateContent"] },
    { "name": "models/agnes-video-v2.0", "displayName": "agnes-video-v2.0", "supportedGenerationMethods": ["generateContent", "streamGenerateContent"] }
  ]
}
```

## `POST /v1beta/models/{model}:generateContent`

Gemini generateContent 协议，非流式。请求体中的 `systemInstruction` 与 `contents` 会在
转发上游前被转换为 messages。模型名写在路径里，不在请求体中。

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "你是一个乐于助人的助手。" }] },
    "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }]
  }'
```

```json
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "你好" }] },
    "finishReason": "STOP",
    "index": 0
  }],
  "modelVersion": "agnes-2.0-flash",
  "usageMetadata": { "promptTokenCount": 2, "candidatesTokenCount": 3, "totalTokenCount": 5 }
}
```

注意：路径按最后一个冒号切分，因此模型名本身包含冒号（例如
`vendor:agnes-2.0-flash`）也能被正确处理。

## `POST /v1beta/models/{model}:streamGenerateContent`

请求体形态与 `generateContent` 相同，路径以 `:streamGenerateContent` 结尾。响应为
`text/event-stream`，每个事件是不带 `event:` 字段的 `data:` 行，没有 `[DONE]` 终止标记
——流结束时直接关闭：

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }] }'
```

```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}

```

## `POST /v1/images/generations`

同步图片生成。请求体与响应体原样转发/透传自上游 Agnes API——以下示例反映的是当前上游
的契约，而不是本网关自定义的格式。

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "一只猫" }'
```

```json
{ "created": 1735689600, "data": [{ "url": "https://example.com/generated-image.png" }] }
```

## `POST /v1/videos`

创建一个视频生成任务并立即返回，任务在上游异步执行。请求体原样转发，响应体原样透传。

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "一只猫在跑" }'
```

⚠️ 下面这段响应体的形状未经真实上游核实：它照抄的是本仓测试夹具。网关对响应体原样
透传，不对它的结构做任何假设。

```json
{ "id": "task-1", "status": "queued" }
```

## `GET /v1/videos/{id}`

轮询此前创建的视频任务。响应体原样透传自上游。

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

网关在转发之前先校验任务标识的形状，**只接受 `A-Za-z0-9_- (1-128)`**：前一段是允许的字符
集，括号里是长度的下界与上界。不匹配的一律 400，且**一次上游请求都不会发出**。400 的报文
里逐字带着这个形状，照着它把标识贴回来即可。

⚠️ 任务标识的形状判据未经真实上游核实：它是从本仓测试夹具里那个标识**外推**出来的字符
集与长度上界，不是照抄。上游真发出别的形状时，网关先回一个 400，不会把它转给上游
——那时改请求参数没有用，得改网关。

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```
