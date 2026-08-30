# API 文档

本文档逐条说明 agnes2api 对外暴露的四种协议端点、管理接口与错误契约。

## 认证

`/v1/*` 与 `/v1beta/*` 下的所有路由都需要凭据，`/health` 不需要。以下四种传递方式任选其一即可——正好对应各协议官方 SDK 默认发送的凭据形式，通常无需额外配置。

以下示例统一使用 `http://localhost:8080`（Docker/Node 的监听地址）。若部署在 Cloudflare Worker 上，替换成你的 `*.workers.dev` 域名（或自定义域名）即可。`your-gateway-token` 是你设置的 `GATEWAY_TOKEN` 的占位符。

### 方式 1：Authorization Bearer 请求头

OpenAI 与 OpenAI-Responses 生态的标准写法，官方 `openai` SDK 默认只发这一条：

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

### 方式 2：x-api-key 请求头

Anthropic 生态的标准写法，官方 `anthropic` SDK 默认只发这一条：

```bash
curl http://localhost:8080/v1/models \
  -H "x-api-key: your-gateway-token"
```

### 方式 3：x-goog-api-key 请求头

Gemini 生态的标准写法，官方 `google-genai` SDK 在设置了自定义 base URL 时发这一条：

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

### 方式 4：key 查询参数

设不了请求头的场景（浏览器 `EventSource`、某些网关探针）可以把凭据放进 URL：

```bash
curl "http://localhost:8080/v1beta/models?key=your-gateway-token"
```

### 凭据从哪里来

这把凭据就是部署时设置的 `GATEWAY_TOKEN`，与上游 Agnes 的 key 池完全无关——池里那些 key 一把都不会离开网关：

```env
# 必填：下游客户端调这台网关时要出示的口令，与上游 key 无关
GATEWAY_TOKEN=换成一把长随机串
```

缺少或错误的凭据返回 `401`：

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

> [!IMPORTANT]
> 管理接口 `/admin/api/*` **不接受**上面这四种传递方式，它只认 `x-admin-key` 请求头、只认 `ADMIN_TOKEN`。两把钥匙严格隔离：中转口令是发给每一个下游用户的，复用它当面板口令等于把整池 key 交出去。

## 路径说明

四种协议各自挂在自己的标准裸路径上，主流 SDK 填 `base_url` 时无需添加任何厂商前缀。

### 标准裸路径

**OpenAI 格式**：

- `POST /v1/chat/completions`
- `GET /v1/models`

**OpenAI-Responses 格式**：

- `POST /v1/responses`

**Anthropic 格式**：

- `POST /v1/messages`

**Gemini 格式**：

- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `GET /v1beta/models`

### 路径里的模型名

Gemini 那两条端点把模型名写在路径里、不在请求体中。路径**按最后一个冒号切分**，因此模型名本身包含冒号（例如 `vendor:agnes-2.0-flash`）也能被正确处理。

`GET /v1/models` 返回 OpenAI 形状的模型列表，`GET /v1beta/models` 返回 Gemini 形状的同一批模型——同一路径无法同时返回两种格式，按你用的 SDK 选一条即可。

## 错误响应

网关自己产生的错误一律是 `{ "error": { "type": ..., "message": ... } }` 这个信封，四种协议的 SDK 都解析得动。上游产生的错误则原样透传，保持上游自身的错误结构。

### 常见错误码

| 状态码 | 说明 |
|------|----|
| `400` | 请求体过不了网关这一关；上游自己返回的 `400` 也走这个码，但那是原样透传的上游结构。四类成因见表下那条说明。 |
| `401` | 缺少或错误的网关凭据（协议端点）；管理接口的 `x-admin-key` 不对。上游 `401` 的响应体绝不转发。 |
| `404` | 路径不存在；管理接口里那个 `{id}` 不存在（`没有这把 key`）。 |
| `409` | 管理接口的前置条件没满足，响应体顶层带一个机器可读的 `reason`。逐条见表下那条说明。 |
| `429` | 管理接口的出站探测护栏挡下了这一次，响应体顶层带 `reason`。 |
| `502` | 格式转换类路由上，上游回了 `200` 但响应体不是 JSON。 |
| `503` | key 池里没有可用 key（见下一节）；或管理接口不可用（两把口令撞了、这个部署没接上某个模块）。 |
| `504` | 同步端点用尽了 `UPSTREAM_SYNC_TIMEOUT_MS` 的总预算（见下面那一节）。 |

> [!NOTE]
> `400` 的四类成因：Anthropic 协议里出现非 `text` 内容块、视频任务标识形状非法、管理接口的请求体字段不认识、管理接口缺必填项。`409` 的四类：删 key 之前没先停用、清空池时池大小与你看到的对不上、注册机没启用、通道没配凭据。`429` 覆盖单把 key 验活与通道连通性测试两条出站探测，两者都**按标识限速**，互不牵连。

### key 池耗尽（`503`）

若 key 池中没有可用 key，网关会在发起上游请求之前直接返回 `503`：

| `reason` | 是否自愈 | 含义 |
|--------|--------|----|
| `pool_empty` | – | 尚未导入任何 key。 |
| `all_cooling` | **会** | 全部 key 处于冷却中（限流、欠费或瞬时故障累计）。响应头 `Retry-After` 给出最早恢复时刻。 |
| `all_disabled` | **不会** | 全部 key 被管理员在管理面板上**手工停用**。在面板上重新启用即可——**凭据本身没问题，别去换 key**。 |
| `all_evicted` | **不会** | 全部 key 因凭据失效（上游 `401`/`403`）被永久剔除，请更换 key。 |
| `upstream_error` | **会** | key 本身可用，但上游每次尝试都失败。 |

**响应**：

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
```

### 同步端点超时（`504`）

图片生成、视频建任务，以及**所有非流式对话**（四种协议）走的是同步超时预算 `UPSTREAM_SYNC_TIMEOUT_MS`（默认 120000 毫秒，见 [部署指南](DEPLOY.md#环境变量)）。当这次请求在总预算内尝试过的每一把 key 都没有响应时，返回 `504`：

| `reason` | 含义 |
|--------|----|
| `upstream_timeout` | 本次请求用尽了 `UPSTREAM_SYNC_TIMEOUT_MS` 的总预算，其间尝试过的 key 都没在各自的尝试预算内响应。 |

**响应**：

```json
{ "error": { "reason": "upstream_timeout", "message": "同步端点用尽了 120000 毫秒的总预算：已尝试 2 把 key，均未在各自的尝试预算内收到上游响应……" } }
```

成因有三种：上游整体变慢、预算配小，或这几把 key 对应的上游会话被挂起。这个总预算就是客户端的最坏等待时间，与池子大小无关。收到 `504` 时网关**没有**惩罚任何 key；只有当同一次请求里另一把 key 成功了，先超时的那把才会被记账。

### 透传与不透传

除以上情况外，上游返回的其他错误状态码（`400`、`404` 等）一律原样透传，保持上游自身的错误结构，网关不做改写。两个例外：上游 `401`/`403` 的响应体**绝不**转发（那里是上游 API 最可能回显 key 片段的地方）；格式转换类路由上，上游 `200` 但响应体不是 JSON 时返回 `502`。

上游的响应头同样不原样转发，只保留 `content-type`、`cache-control` 与 `retry-after`。其余（`set-cookie`、`www-authenticate`、各家的 `x-*` 头）一律剥掉——池子每次请求都可能换一把 key，这些头描述的是上游账号而不是你的网关。

## 模型

网关暴露四个模型，调用哪个端点决定该传哪个：

| 模型 | 用于 |
|----|----|
| `agnes-2.0-flash` | 对话/文本类端点 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## OpenAI 兼容 API

### GET /v1/models

OpenAI 格式的模型列表。不收任何参数。

**请求**：

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

**响应**：

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

### POST /v1/chat/completions

OpenAI Chat Completions 协议。非流式响应就是上游的 OpenAI 格式 JSON，原样返回。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-2.0-flash`。 |
| `messages` | array | 是 | 标准 OpenAI 消息数组。 |
| `stream` | boolean | 否 | 传 `true` 拿流式响应，默认 `false`。 |

**请求**：

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

**响应**：

```json
{
  "id": "c1",
  "choices": [{ "message": { "role": "assistant", "content": "hi" } }]
}
```

传 `"stream": true` 即可拿到流式响应：`Content-Type: text/event-stream`，标准的 OpenAI 风格 `data: {...}` 分片，以 `data: [DONE]` 结束。

> [!WARNING]
> 流式末帧带不带 usage 未经真实上游核实：本网关对这条协议的流式字节原样透传，既不解析也不改写；上游若在流末发一块 usage，那些字节会原样到达客户端。

## OpenAI Responses API

### POST /v1/responses

OpenAI-Responses 协议。请求体中的 `instructions` 与数组形态的 `input` 会在转发上游前被转换为 messages；响应会被转换为 `output[]` 结构。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-2.0-flash`。 |
| `input` | string / array | 是 | 字符串或标准 Responses 输入数组。 |
| `instructions` | string | 否 | 会被转换成一条 system 消息。 |
| `stream` | boolean | 否 | 传 `true` 拿流式响应，默认 `false`。 |

**请求**：

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

**响应**：

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

传 `"stream": true` 时响应为 `text/event-stream`，携带：`response.created`、一个或多个 `response.output_text.delta`、`response.completed`。

## Anthropic 兼容 API

### POST /v1/messages

Anthropic Messages 协议。请求体中的 `system` 与数组形态的 `content` 会在转发上游前被压平；响应会被转换为 Anthropic 的 content block 结构。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-2.0-flash`。 |
| `max_tokens` | number | 是 | Anthropic 协议自身的必填项。 |
| `messages` | array | 是 | 标准 Anthropic 消息数组。 |
| `system` | string / array | 否 | 会在转发上游前被压平成纯文本。 |
| `stream` | boolean | 否 | 传 `true` 拿流式响应，默认 `false`。 |

**请求**：

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

**响应**：

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

传 `"stream": true` 时响应为 `text/event-stream`，携带标准 Anthropic 事件序列：`message_start`、`content_block_start`、一个或多个 `content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。

> [!IMPORTANT]
> 若 `content`（或 `system`）数组里出现无法映射到内部纯文本格式的块——任何非 `text` 类型，例如 `image`、`tool_use`、`tool_result`——网关会在转发上游前直接返回 `400`，而不是像早期版本那样静默丢弃该块。报文里那句 `不支持的内容块类型: image（本网关仅支持 text）` 中的块类型会替换成实际收到的值。

## Gemini 原生 API

### GET /v1beta/models

Gemini 格式的模型列表。不收任何参数。

**请求**：

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

**响应**：

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

### POST /v1beta/models/{model}:generateContent

Gemini generateContent 协议，非流式。请求体中的 `systemInstruction` 与 `contents` 会在转发上游前被转换为 messages。模型名写在路径里，不在请求体中。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `contents` | array | 是 | 标准 Gemini 内容数组。 |
| `systemInstruction` | object | 否 | 会被转换成一条 system 消息。 |

**请求**：

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "你是一个乐于助人的助手。" }] },
    "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }]
  }'
```

**响应**：

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

### POST /v1beta/models/{model}:streamGenerateContent

请求体形态与 `generateContent` 相同，路径以 `:streamGenerateContent` 结尾。响应为 `text/event-stream`，每个事件是不带 `event:` 字段的 `data:` 行，没有 `[DONE]` 终止标记——流结束时直接关闭。

**请求**：

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }] }'
```

**响应**：

```text
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}
```

## 图片与视频 API

### POST /v1/images/generations

同步图片生成。请求体与响应体原样转发/透传自上游 Agnes API——以下示例反映的是当前上游的契约，而不是本网关自定义的格式。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-image-2.1-flash` 或 `agnes-image-2.0-flash`。 |
| `prompt` | string | 是 | 原样转发给上游。 |

**请求**：

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "一只猫" }'
```

**响应**：

```json
{ "created": 1735689600, "data": [{ "url": "https://example.com/generated-image.png" }] }
```

### POST /v1/videos

创建一个视频生成任务并立即返回，任务在上游异步执行。请求体原样转发，响应体原样透传。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-video-v2.0`。 |
| `prompt` | string | 是 | 原样转发给上游。 |

**请求**：

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "一只猫在跑" }'
```

> [!WARNING]
> 下面这段响应体的形状未经真实上游核实：它照抄的是本仓测试夹具。网关对响应体原样透传，不对它的结构做任何假设。

**响应**：

```json
{ "id": "task-1", "status": "queued" }
```

### GET /v1/videos/{id}

轮询此前创建的视频任务。响应体原样透传自上游。

**请求**：

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

**响应**：

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```

网关在转发之前先校验任务标识的形状，**只接受 `A-Za-z0-9_- (1-128)`**：前一段是允许的字符集，括号里是长度的下界与上界。不匹配的一律 400，且**一次上游请求都不会发出**。400 的报文里逐字带着这个形状，照着它把标识贴回来即可。

> [!WARNING]
> 任务标识的形状判据未经真实上游核实：它是从本仓测试夹具里那个标识**外推**出来的字符集与长度上界，不是照抄。上游真发出别的形状时，网关先回一个 400，不会把它转给上游——那时改请求参数没有用，得改网关。

## 管理 API

`/admin` 管理面板（静态资源随构建内嵌）由 `/admin/api/*` 这一族接口驱动。它们与四种协议端点**完全隔离**：只认 `x-admin-key` 请求头、只认 `ADMIN_TOKEN`，不接受 `Authorization: Bearer`，也不接受 `?key=`（口令进 URL 会落进浏览器历史、Referer 与各级访问日志）。

没有配 `ADMIN_TOKEN`、或它不满足硬规则（首尾有空白、含非可打印 ASCII、短于 24 位）时，**整棵 `/admin` 树都不注册**——访问它得到 `404` 而不是 `401`，不泄漏「这里有个后台」。

> [!WARNING]
> 管理接口的响应里没有任何一处会回显池里 key 的明文，也没有任何 reveal 端点。但拿到 `ADMIN_TOKEN` 的人可以清空整个池、改掉 `GATEWAY_TOKEN`、把注册机打开——**请把它当成比中转口令更要紧的那一把**。

### GET /admin/api/session

登录探针。面板拿它验证「这把口令能不能用」，**不返回任何配置或池子信息**。

**请求**：

```bash
curl http://localhost:8080/admin/api/session \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{ "ok": true, "version": "0.1.0" }
```

### GET /admin/api/capabilities

双运行时差异的**唯一出口**：面板启动时调一次，所有形态分支都读它。零存储访问。

**请求**：

```bash
curl http://localhost:8080/admin/api/capabilities \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "version": "0.1.0",
  "runtime": { "name": "node", "colo": null },
  "storage": { "backend": "file", "writable": true },
  "quota": { "model": "file" },
  "process": { "metrics": true },
  "logs": { "processLog": false },
  "stats": {
    "tier2Enabled": false,
    "flushIntervalMs": 60000,
    "tokensCoverage": ["anthropic", "responses", "gemini"]
  }
}
```

### GET /admin/api/overview

概览页的一次取数：版本、服务端时钟、运行时、进程指标、存储健康、池健康、Tier-1 池级聚合、两条新鲜度与配置摘要。

> [!NOTE]
> `poolStats` 是**近似值**（`approximate: true`）：并发下少计，且最多晚一个 `POOL_TOUCH_INTERVAL_MS` 落盘。面板必须把这个近似标记画出来，不许悄悄当精确值用。

**请求**：

```bash
curl http://localhost:8080/admin/api/overview \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "version": "0.1.0",
  "serverTime": 1735689600000,
  "runtime": { "name": "node" },
  "process": { "pid": 1, "rssBytes": 52428800, "uptimeMs": 3600000 },
  "storage": { "backend": "file", "writable": true, "checkedAt": 1735689600000 },
  "pool": { "total": 3, "fresh": 2, "cooling": 1, "evicted": 0, "disabled": 0 },
  "poolStats": { "requests": 42, "success": 40, "failed": 2, "clientErrors": 0, "approximate": true },
  "freshness": {
    "poolCacheTtlMs": 60000,
    "poolVisibilityUpperBoundMs": 120000,
    "poolTouchIntervalMs": 21600000,
    "configTtlMs": 30000,
    "configVisibilityUpperBoundMs": 90000,
    "kvEdgeCacheMs": 60000
  },
  "config": {
    "registrarEnabled": true,
    "primary": "moemail",
    "fallback": "yyds",
    "targetKeys": 20,
    "envLocked": ["gatewayToken"],
    "degraded": false
  }
}
```

### GET /admin/api/models

四协议 × 模型的静态目录。**零存储读**，全部来自模块级常量——集成示例卡、调试台与模型表三处都从这里取数，一个端点路径都不在前端硬编码。

**请求**：

```bash
curl http://localhost:8080/admin/api/models \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "protocols": [{ "id": "openai", "label": "OpenAI Chat Completions", "method": "POST", "pathTemplate": "/v1/chat/completions", "upstreamPath": "/chat/completions" }],
  "media": [{ "id": "image.generate", "method": "POST", "pathTemplate": "/v1/images/generations" }],
  "models": [{ "id": "agnes-2.0-flash", "modality": "chat" }],
  "samplePrompt": "ping"
}
```

### GET /admin/api/keys

Key 池只读列表，带筛选与分页。**投影里永远没有明文 key。**

**请求体**：本端点只收查询参数，不收请求体。

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `q` | string | 否 | 模糊匹配（备注、id 片段等）。 |
| `bucket` | string | 否 | 按分档筛选；不是合法档位时整个忽略。 |
| `page` | number | 否 | 1 基页号，越界时回落到 1。 |
| `size` | number | 否 | 每页条数，默认 20，上限 200。 |

**请求**：

```bash
curl "http://localhost:8080/admin/api/keys?bucket=fresh&page=1&size=20" \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "items": [{ "id": "9f2c…", "masked": "sk-a…aaa", "seq": 1, "bucket": "fresh", "strikes": 0, "disabled": false, "note": null }],
  "total": 1,
  "page": 1,
  "size": 20,
  "pages": 1,
  "counts": { "fresh": 1, "cooling": 0, "disabled": 0, "evicted": 0 },
  "approximate": true,
  "generatedAt": 1735689600000
}
```

> [!NOTE]
> `counts` **永远按整池算**，不受本次筛选影响：筛选器旁边那几个数字是「切换过去能看到几条」，拿筛完的集合去算就恒等于当前这一档的条数，另外三档全是 0。

### POST /admin/api/keys

批量导入 key。三个返回数组装的分别是 id、id 与**输入里的位置**（1 基），没有一项是明文。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `keys` | array | 是 | 字符串数组；元素类型不对时整体 `400`，不算进 `invalid`。 |
| `resetExisting` | boolean | 否 | 勾选后会清掉已存在 key 的冷却、strikes 与剔除标记，默认 `false`。 |

**请求**：

```bash
curl -X POST http://localhost:8080/admin/api/keys \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "keys": ["sk-aaa", "sk-bbb"], "resetExisting": false }'
```

**响应**：

```json
{ "added": ["9f2c…"], "duplicated": ["3b71…"], "invalid": [2], "reset": 0 }
```

> [!IMPORTANT]
> `reset` 与 `duplicated.length` **不是一个数**：本批新建的那把被粘第二遍时也算重复，但它谈不上「被重置」。面板要显示的是 `reset`，显示 `duplicated.length` 就是在撒谎。

### POST /admin/api/keys/bulk

批量操作，逐项返回结果。**只有三个动作**，与批量条上的三颗按钮逐条对应；没有「批量启用」「批量解除剔除」——那两个是「让更多 key 重新上场」的动作，逐把点比一次点全部安全。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `op` | string | 是 | 只能是 `disable` / `clearCooldown` / `delete` 之一。 |
| `ids` | array | 是 | 字符串数组，一次最多 200 项。 |

**请求**：

```bash
curl -X POST http://localhost:8080/admin/api/keys/bulk \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "op": "clearCooldown", "ids": ["9f2c…", "3b71…"] }'
```

**响应**：

```json
{ "results": [{ "id": "9f2c…", "ok": true, "reason": null }, { "id": "3b71…", "ok": false, "reason": "not_found" }] }
```

### PATCH /admin/api/keys/{id}

改一把 key：停用/启用、备注、清冷却、清 strikes、解除剔除、重置用量计数。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `disabled` | boolean | 否 | 停用或启用这把 key。 |
| `note` | string | 否 | 备注。 |
| `clearCooldown` | boolean | 否 | 动作而非状态：传 `false` 等于没传。 |
| `clearStrikes` | boolean | 否 | 动作而非状态：传 `false` 等于没传。 |
| `unevict` | boolean | 否 | 动作而非状态：传 `false` 等于没传。 |
| `clearStats` | boolean | 否 | 动作而非状态：传 `false` 等于没传。 |

**请求**：

```bash
curl -X PATCH http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "disabled": false, "clearCooldown": true }'
```

**响应**：

```json
{ "ok": true }
```

### DELETE /admin/api/keys/{id}

删除一把 key。成功是 `204`，没有响应体。

> [!WARNING]
> 删除**不可撤销**：记录里那把 key 材料就此消失，没有任何地方还留着它。所以它是唯一一条带前置条件的写操作——**没停用的 key 删不掉**，会回 `409` 加顶层 `reason: "must_disable_first"`。

**请求**：

```bash
curl -X DELETE http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{ "error": { "type": "conflict", "code": "must_disable_first", "message": "请先停用这把 key 再删除（删除不可撤销，而停用随时可以撤销）" }, "reason": "must_disable_first" }
```

### POST /admin/api/keys/purge

清空整个 Key 池。危险区那两颗按钮之一。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `expect` | number | 是 | 你在屏幕上看到的池大小，非负整数；对不上就 `409`，一把都不删。 |

**请求**：

```bash
curl -X POST http://localhost:8080/admin/api/keys/purge \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "expect": 3 }'
```

**响应**：

```json
{ "deleted": 3, "remaining": 0, "expected": 3 }
```

> [!CAUTION]
> 每把 key 的用量历史住在这条记录**里面**，删记录就是删历史，没有第二份。`remaining` 是**回读**出来的，不是常数 `0`——它顺带把「索引说空了、而存储里还躺着记录」那一档如实报出来。

### GET /admin/api/keys/{id}/usage

单把 key 的 Tier-1 计数。**与 Tier-2 完全无关**：Tier-2 关着时照样可用。

**请求**：

```bash
curl http://localhost:8080/admin/api/keys/9f2c/usage \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "id": "9f2c",
  "stats": { "requests": 12, "success": 11, "failed": 1, "clientErrors": 0, "lastErrorAt": 1735689500000, "lastErrorKind": "rate limited" },
  "approximate": true,
  "generatedAt": 1735689600000
}
```

### POST /admin/api/keys/{id}/verify

单把 key 的验活：拿这把 key 向上游打一次最小请求，**只回状态码，不回正文**。

**请求体**：本端点**不收任何选项**，空体放行；带了字段一律 `400`——`{"model":"…"}` 这种「我以为能指定模型」的写法在宽松实现下是一次静默误操作。

**请求**：

```bash
curl -X POST http://localhost:8080/admin/api/keys/9f2c/verify \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{ "ok": true, "status": 200, "latencyMs": 412, "reason": null }
```

> [!NOTE]
> 这条端点带出站探测护栏，粒度是 `verify:<id>`：同一把 key 连着点会拿到 `429` 加顶层 `reason`，而验别的 key 不受影响。它一次存储写都不产生。

### GET /admin/api/events

事件板块的取数。归并结果按 `ts` 降序。

**请求体**：本端点只收查询参数，不收请求体。

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `after` | number | 否 | 游标，只要比它新的条目。 |
| `level` | string | 否 | 按级别筛选；不是合法级别时整个忽略。 |
| `limit` | number | 否 | 本页条数，默认 200，上限 500。 |

**请求**：

```bash
curl "http://localhost:8080/admin/api/events?level=warn&limit=50" \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "items": [{ "ts": 1735689600000, "level": "warn", "event": "key.restored", "msg": "面板解除了一把 key 上的限制" }],
  "cursor": 1735689600000,
  "shardId": "a1b2",
  "buffered": 0,
  "dropped": 0,
  "budgetExhausted": false,
  "truncated": false,
  "malformed": 0,
  "cursorAhead": false,
  "generatedAt": 1735689600000
}
```

> [!IMPORTANT]
> `cursor` 只有两种合法值：**有限数字，或 `null`**。永远不会是「字段不存在」——那会让前端把「没有新事件」与「后端契约坏了」混成一件事。

### GET /admin/api/events/download

把归并结果整段导出。返回的是 `text/plain`，**逐行 JSON**（不是一个 JSON 数组）：这是给人在终端里 `grep` 用的格式，不是给程序反序列化用的 API。

**请求**：

```bash
curl -OJ http://localhost:8080/admin/api/events/download \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```text
{"ts":1735689600000,"level":"warn","event":"key.restored","msg":"面板解除了一把 key 上的限制"}
{"ts":1735689500000,"level":"info","event":"key.added","msg":"面板导入了新的 key"}
```

### GET /admin/api/config

读当前生效配置。凭据字段只报「配没配」，不报值。

> [!NOTE]
> 从未保存过的字段上，`stored` 是**不存在，而不是 `null`**：它装的是存储里那份 `config` 的原始值，而 `undefined` 过不了 JSON。下面这个例子是一台全新部署——可与 `PUT` 的响应对照，同一个字段在那边有自己的 `stored`。

**请求**：

```bash
curl http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "fields": { "upstreamTimeoutMs": { "env": null, "effective": 8000, "lockedBy": null } },
  "credentials": { "gatewayToken": { "configured": true, "hint": "3f7a", "lockedBy": "env:GATEWAY_TOKEN" } },
  "configDegraded": false,
  "loadBlocked": [],
  "editable": ["upstreamTimeoutMs"],
  "secrets": ["gatewayToken"],
  "resetBlocked": [],
  "propagation": { "configTtlMs": 30000, "kvEdgeCacheMs": 60000, "visibilityUpperBoundMs": 90000 }
}
```

### PUT /admin/api/config

写配置。顺序是**校验 → 写 → 失效缓存 → 回读**，一步都不能调换：先写后校验的话，一份非法配置已经落盘，而响应却是 `400`。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `patch` | object | 是 | 只带你要改的那几条路径；不认识的顶层字段一律 `400`。 |

**请求**：

```bash
curl -X PUT http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**响应**：

```json
{
  "fields": { "upstreamTimeoutMs": { "stored": 90000, "env": null, "effective": 90000, "lockedBy": null } },
  "credentials": { "gatewayToken": { "configured": true, "hint": "3f7a", "lockedBy": "env:GATEWAY_TOKEN" } },
  "configDegraded": false,
  "loadBlocked": [],
  "changed": ["upstreamTimeoutMs"],
  "credentialsChanged": [],
  "appliedAt": 1735689600000,
  "propagation": { "configTtlMs": 30000, "kvEdgeCacheMs": 60000, "visibilityUpperBoundMs": 90000 }
}
```

> [!IMPORTANT]
> 凭据字段传空串一律是「不改」，**不是清空**。清空只有 `POST /admin/api/config/secrets/clear` 这一条路——把空串实现成清空，后果是运维保存一次设置页就抹掉了 `gatewayToken`，而热实例当场看不出任何异常。

### POST /admin/api/config/validate

干跑一次校验，一个字节都不写。它与真跑对同一份输入给出同一组错误码。

**请求体**：与 `PUT /admin/api/config` 逐字相同（一个 `patch` 对象）。

**请求**：

```bash
curl -X POST http://localhost:8080/admin/api/config/validate \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**响应**：

```json
{ "ok": true, "changed": ["upstreamTimeoutMs"] }
```

### POST /admin/api/config/secrets/clear

显式清空一把凭据。**这是清空凭据的唯一入口。**

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `path` | string | 是 | 只能是凭据字段之一，别的路径一律 `400`。 |

**请求**：

```bash
curl -X POST http://localhost:8080/admin/api/config/secrets/clear \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "path": "gatewayToken" }'
```

**响应**：

```json
{
  "cleared": "gatewayToken",
  "stillConfigured": true,
  "gatewayTokenMissing": false,
  "loadBlocked": [],
  "fields": { "upstreamTimeoutMs": { "stored": 90000, "env": null, "effective": 90000, "lockedBy": null } },
  "credentials": { "gatewayToken": { "configured": true, "hint": "3f7a", "lockedBy": "env:GATEWAY_TOKEN" } },
  "configDegraded": false,
  "resetBlocked": [],
  "propagation": { "configTtlMs": 30000, "kvEdgeCacheMs": 60000, "visibilityUpperBoundMs": 90000 }
}
```

### POST /admin/api/config/reset

把存储里那份配置整把写回 `{}`。危险区那两颗按钮的另一颗。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `confirm` | boolean | 是 | 必须显式传 `true`，这一步不可撤销。 |

**请求**：

```bash
curl -X POST http://localhost:8080/admin/api/config/reset \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "confirm": true }'
```

**响应**：

```json
{
  "fields": { "upstreamTimeoutMs": { "env": null, "effective": 8000, "lockedBy": null } },
  "credentials": { "gatewayToken": { "configured": true, "hint": "3f7a", "lockedBy": "env:GATEWAY_TOKEN" } },
  "configDegraded": false,
  "loadBlocked": [],
  "changed": ["upstreamTimeoutMs"],
  "credentialsChanged": [],
  "resetBlocked": [],
  "appliedAt": 1735689600000,
  "propagation": { "configTtlMs": 30000, "kvEdgeCacheMs": 60000, "visibilityUpperBoundMs": 90000 }
}
```

> [!IMPORTANT]
> `appliedAt` **不是「已生效」的承诺**，它就是服务器落盘的那一刻。别的副本/别的 isolate 多久能看见，由 `propagation` 里那三个数说了算——面板不许把它渲染成「已重置并生效」。

### POST /admin/api/registrar/tend

手动触发一轮补池。成功是 `202`（已开始），不是 `200`。

**请求体**：

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `channel` | string | 否 | 只能是 `moemail` 或 `yyds`；不给就按配置里的主/备通道链跑。 |

**请求**：

```bash
curl -X POST http://localhost:8080/admin/api/registrar/tend \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "channel": "moemail" }'
```

**响应**：

```json
{
  "started": true,
  "trigger": "manual",
  "channel": "moemail",
  "remaining": 23,
  "resetAt": 1735776000000,
  "cooldownUntil": 1735690200000,
  "retryAfterMs": 600000
}
```

> [!NOTE]
> `remaining` 在成功那一支也照样给：只在耗尽那一支给它，等于让运维毫不知情地撞上一堵墙。注册机没启用是 `409` 加 `reason`，通道没配凭据也是 `409`——**那不是「这条路由不存在」**。

### GET /admin/api/registrar/status

补池板块的取数：注册机开没开、两条通道各自的接入状态、护栏还剩几次、补池历史。

> [!IMPORTANT]
> 这里的 `counted` **不叫 `available`**：它的判据是「占名额数」，被停用的与正在冷却的 key 都算在里面，而这两种恰恰都不能打上游。真正的可用数是并列的那个 `fresh`——**两者都住在 `pool` 对象里，不在顶层**。

**请求**：

```bash
curl http://localhost:8080/admin/api/registrar/status \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "serverTime": 1735689600000,
  "enabled": true,
  "primary": "moemail",
  "fallback": "yyds",
  "channels": {
    "moemail": { "configured": true, "role": "primary" },
    "yyds": { "configured": true, "role": "fallback" }
  },
  "pool": { "target": 20, "counted": 3, "gap": 17, "fresh": 2, "mintBatch": 5 },
  "lockedUntil": null,
  "manual": {
    "used": 1, "remaining": 23, "perDay": 24, "resetAt": 1735775999999,
    "cooldownUntil": null, "retryAfterMs": null
  },
  "history": {
    "entries": [
      {
        "at": 1735689000000, "trigger": "cron", "primaryChannel": "moemail",
        "skipped": false, "available": 2, "attempted": 1, "minted": 1,
        "mintedByChannel": { "moemail": 1 }, "failures": [], "durationMs": 8421
      }
    ],
    "malformed": 0
  }
}
```

### POST /admin/api/registrar/channels/{channel}/test

通道连通性测试：向邮箱服务发一次只读 GET，不建任何邮箱、不领任何 key。

响应里的 `domains` 是**探到的域名个数**（整数），不是域名清单——这条端点刻意不回显任何上游细节。

**请求体**：本端点不收请求体，通道名写在路径里（只能是 `moemail` 或 `yyds`）。

**请求**：

```bash
curl -X POST http://localhost:8080/admin/api/registrar/channels/moemail/test \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{ "ok": true, "channel": "moemail", "domains": 3, "latencyMs": 128 }
```

### GET /admin/api/usage

Tier-2 用量的区间聚合。日期一律 UTC，并且**在响应里说出来**。

两个参数**只认 epoch 毫秒整数**：不是整数、或者是负数，一律 `400`，服务端不做「善意纠正」——`2026-08-01` 这种日期串会被判成非法。**`days` 不是参数**：它是面板按钮的档位，服务端不认，前端只发 `from` / `to`。

**请求体**：本端点只收查询参数，不收请求体。

| 参数 | 类型 | 必填 | 说明 |
|----|----|----|----|
| `from` | number | 否 | 区间起点，**epoch 毫秒整数**；缺省是 `to - 86400000`。早于保留期起点的会被夹到起点，并把 `range.clamped` 置真。 |
| `to` | number | 否 | 区间终点，**epoch 毫秒整数**；缺省是服务端当前时刻。晚于当前时刻的会被夹到当前时刻，并把 `range.clamped` 置真。 |

**请求**：

```bash
curl "http://localhost:8080/admin/api/usage?from=1735689600000&to=1735775999999" \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "tier": "off",
  "timezone": "UTC",
  "approximate": true,
  "generatedAt": 1735689600000,
  "range": { "from": 1735689600000, "to": 1735775999999, "clamped": false },
  "days": null,
  "total": null,
  "shards": null,
  "malformed": null,
  "pending": null,
  "note": "tier2_off"
}
```

> [!IMPORTANT]
> Tier-2 关着时这条端点**照常回 200**，只是如实说 `tier: "off"`——回 `503` 会让面板把「运维没打开统计」渲染成「后端坏了」。「读不出来」「时钟坏了」「那天不在保留期里」各有各的 `note`，不许混成同一句「没有数据」。

### GET /admin/api/usage/{date}

某一天的用量明细：按小时、按模型、按协议三张切片。

**请求体**：本端点不收请求体，日期写在路径里，必须是 UTC 的 `YYYY-MM-DD`，否则 `400`。**与上面那条区间端点的口径刻意不同**：那条只认 epoch 毫秒整数，这条只认日期串，两者不通用。

**请求**：

```bash
curl http://localhost:8080/admin/api/usage/2026-08-30 \
  -H "x-admin-key: your-admin-token"
```

**响应**：

```json
{
  "tier": "off",
  "timezone": "UTC",
  "date": "2026-08-30",
  "approximate": true,
  "generatedAt": 1735689600000,
  "hours": null,
  "byModel": null,
  "byProtocol": null,
  "shards": null,
  "malformed": null,
  "note": "tier2_off"
}
```

## 系统 API

### GET /health

健康检查（Docker 探针适配）。**无需鉴权**，因此它也不回显任何底层错误细节。

**请求**：

```bash
curl http://localhost:8080/health
```

**响应**：

```json
{ "status": "ok", "version": "0.1.0", "storage": { "writable": true } }
```

`storage.writable` 报告的是「key 池所在的存储是否真的写得进去」。它由启动时的一次探测与运行期每一次真实写操作共同维护，健康检查自身不写盘。存储不可写时返回 **HTTP `503`**，`status` 变成 `degraded` 并附一句 `detail`（Docker 部署常见于绑定挂载的宿主目录属主与容器内运行用户不一致，详见容器日志）。

> [!NOTE]
> 镜像内置的 `HEALTHCHECK` 按响应是否成功判定，因此这种容器会被 Docker 标成 unhealthy。具体的底层错误只写进容器日志，不在这个不鉴权端点上回显。

## 请求示例

base URL 用**标准裸前缀**：OpenAI = `{host}/v1`，Anthropic = `{host}`（SDK 自动补 `/v1/messages`），Gemini = `{host}/v1beta`。

### Python - OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-gateway-token",
    base_url="http://localhost:8080/v1"
)

# 非流式请求
response = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.choices[0].message.content)

# 流式请求
for chunk in client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
):
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### JavaScript - Node.js

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "your-gateway-token",
  baseURL: "http://localhost:8080/v1"
});

const message = await client.chat.completions.create({
  model: "agnes-2.0-flash",
  messages: [{ role: "user", content: "Hello" }]
});

console.log(message.choices[0].message.content);
```

### cURL

```bash
# 非流式请求
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 流式请求
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## 获取帮助

- 用法与四种协议的 SDK 接入：[USAGE.md](USAGE.md)
- 部署两种形态与全部环境变量：[DEPLOY.md](DEPLOY.md)
- Web 管理面板：[ADMIN.md](ADMIN.md)
- 注册机（自动补池）：[REGISTRAR.md](REGISTRAR.md)
