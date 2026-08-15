# API 参考

**语言：** [English](../en/API.md) | 简体中文 | [繁體中文](../zh-TW/API.md) | [日本語](../ja/API.md) | [한국어](../ko/API.md)

以下示例统一使用 `http://localhost:8080`（Docker/Node 的监听地址）。若部署在
Cloudflare Worker 上，替换成你的 `*.workers.dev` 域名（或自定义域名）即可。

`your-gateway-token` 是你设置的 `GATEWAY_TOKEN` 的占位符。

## 鉴权

`/v1/*` 与 `/v1beta/*` 下的所有路由都需要凭据，`/health` 不需要。以下四种传递方式任选
其一即可——正好对应各协议官方 SDK 默认发送的凭据形式，通常无需额外配置：

| 方式 | 示例 |
|---|---|
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
|---|---|
| `agnes-2.0-flash` | 对话/文本类端点 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## key 池耗尽时的错误

若 key 池中没有可用 key，网关会在发起上游请求之前直接返回 `503`：

| `reason` | 是否自愈 | 含义 |
|---|---|---|
| `pool_empty` | – | 尚未导入任何 key。 |
| `all_cooling` | **会** | 全部 key 处于冷却中（限流、欠费或瞬时故障累计）。响应头 `Retry-After` 给出最早恢复时刻。 |
| `all_evicted` | **不会** | 全部 key 因凭据失效（上游 `401`/`403`）被永久剔除，请更换 key。 |
| `upstream_error` | **会** | key 本身可用，但上游每次尝试都失败。 |

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
```

除以上情况外，上游返回的其他错误状态码（`400`、`404` 等）一律原样透传，保持上游自身的
错误结构，网关不做改写。两个例外：上游 `401`/`403` 的响应体**绝不**转发（那里是上游 API
最可能回显 key 片段的地方）；格式转换类路由上，上游 `200` 但响应体不是 JSON 时返回 `502`。

上游的响应头同样不原样转发，只保留 `content-type`、`cache-control` 与 `retry-after`。其余
（`set-cookie`、`www-authenticate`、各家的 `x-*` 头）一律剥掉——池子每次请求都可能换一把
key，这些头描述的是上游账号而不是你的网关。

---

## `GET /health`

无需鉴权。

```bash
curl http://localhost:8080/health
```

```json
{ "status": "ok", "version": "0.1.0" }
```

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

## `POST /v1/messages`

Anthropic Messages 协议。请求体中的 `system` 与数组形态的 `content` 会在转发上游前被
压平；响应会被转换为 Anthropic 的 content block 结构。

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

```json
{ "id": "task-1", "status": "queued" }
```

## `GET /v1/videos/{id}`

轮询此前创建的视频任务。响应体原样透传自上游。

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```
