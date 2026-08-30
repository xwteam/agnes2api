# 使用指南

本文讲的是**客户端这一侧**：把各协议官方 SDK 指向一台已经跑起来的网关，怎么发第一个请求、怎么开流式、被拒时先看哪一格。端点逐条的请求 / 响应契约在 [API.md](API.md)，把网关跑起来的两条路在 [DEPLOY.md](DEPLOY.md)。

agnes2api 在协议层实现了四种协议，因此**不需要专门的客户端**——把各协议官方 SDK 的基址指向本网关，`GATEWAY_TOKEN` 当作 API key 传入即可。

## 开始之前

### 你需要哪三样

| 东西 | 从哪儿来 |
|------|----------|
| 网关地址 | Worker 的 `*.workers.dev` 域名、你的自定义域名，或 Docker 部署时的 `http://localhost:8080` |
| 网关口令 | 部署时设置的 `GATEWAY_TOKEN`，见 [部署指南](DEPLOY.md#环境变量) |
| 一把可用的上游 key | 由管理面板导入池子，见 [管理面板](ADMIN.md) |

### 示例里的占位符

下文所有示例统一用这两个占位符，照抄之前先替换：

| 占位符 | 换成什么 |
|--------|----------|
| `http://localhost:8080` | 你实际部署的网关地址 |
| `your-gateway-token` | 你真实的 `GATEWAY_TOKEN` |

> [!NOTE]
> 网关自己不产内容，它只是把请求转发给上游 Agnes，再把响应翻译回你用的那种协议。池子里一把可用 key 都没有时，任何协议端点都直接返回 `503`，那一族的 `reason` 见本文最后一节。

## 凭据传递方式

### 四种等价写法

不同 SDK 各自发送自己默认的请求头，网关对以下四种一视同仁地接受——不需要为某个 SDK 做额外配置：

| 方式 | 由谁发送 |
|------|----------|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` 查询参数 | 手动调用/浏览器场景 |

`/v1/*` 与 `/v1beta/*` 下的全部路由都要这把凭据，`/health` 不要。

### 网关口令不是上游 key

`GATEWAY_TOKEN` 是发给**下游用户**的口令，与池子里那些上游 key 完全无关——池里的 key 一把都不会离开网关。

> [!IMPORTANT]
> 管理接口 `/admin/api/*` **不接受**上面这四种写法，它只认 `x-admin-key` 请求头、只认 `ADMIN_TOKEN`。两把钥匙严格隔离：复用中转口令当面板口令，等于把整池 key 交给每一个下游用户。

## 支持的模型

### 四个模型各自的落点

| 模型 | 用于 |
|------|------|
| `agnes-2.0-flash` | 对话/文本类端点 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

### 模型名写在请求体还是路径里

OpenAI、OpenAI-Responses 与 Anthropic 三种协议把模型名放在请求体的 `model` 字段里；Gemini 那两条端点**写在路径里**。路径按最后一个冒号切分，所以模型名自身含冒号也处理得了。

`GET /v1/models` 返回 OpenAI 形状的模型列表，`GET /v1beta/models` 返回 Gemini 形状的同一批模型——同一条路径没法同时返回两种格式，按你用的 SDK 选一条即可。

> [!NOTE]
> 这两条列表都是**固定表**，四个模型一个不多一个不少，它不反映池子里此刻有没有可用 key。池子空不空要看管理面板，或者直接发一次请求看回不回 `503`。

## OpenAI SDK

### 非流式调用

先把 `base_url` 指到网关，再照常调 `chat.completions.create`，其余参数与直连 OpenAI 一模一样：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-gateway-token",
)

resp = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

### 流式调用

传 `stream=True`，遍历返回的生成器即可，与直接对接 OpenAI 完全一样：

```python
stream = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

网关对这条协议的流式字节**原样透传**，既不解析也不改写：`Content-Type: text/event-stream`，标准的 OpenAI 风格 `data: {...}` 分片，以 `data: [DONE]` 结束。

### base_url 要带 `/v1`

> [!IMPORTANT]
> 这一条与下面两个 SDK **相反**：`openai` SDK 的 `base_url` **要带** `/v1`，它会在其后直接拼 `/chat/completions`。漏掉 `/v1` 的话 SDK 会去打 `/chat/completions`，网关上没有这条路径，回的是 `404` 而不是任何有用的报错。

## Anthropic SDK

### 非流式调用

凭据用 `api_key` 传进去，SDK 会自己把它放进 `x-api-key` 请求头，不用你手动加：

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:8080",
    api_key="your-gateway-token",
)

msg = client.messages.create(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
)
print(msg.content[0].text)
```

### 流式调用

```python
with client.messages.stream(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

流式响应是标准的 Anthropic 事件序列：`message_start`、`content_block_start`、一个或多个 `content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。

### base_url 不带 `/v1`

> [!IMPORTANT]
> SDK 的 `base_url` **不带** `/v1`——SDK 内部会自己拼上 `/v1/messages`。写成 `http://localhost:8080/v1` 会让它去打 `/v1/v1/messages`。

> [!WARNING]
> `content`（或 `system`）数组里出现任何非 `text` 类型的块——`image`、`tool_use`、`tool_result` 都算——网关会在转发上游**之前**直接返回 `400`，而不是静默丢掉那一块。多模态输入这条协议今天走不通，要发图片请走 `/v1/images/generations`。

## Google GenAI SDK

### 非流式调用

这个 SDK 改基址的入口在 `http_options` 里，不是构造函数的位置参数：

```python
from google import genai

client = genai.Client(
    api_key="your-gateway-token",
    http_options={"base_url": "http://localhost:8080"},
)

resp = client.models.generate_content(
    model="agnes-2.0-flash",
    contents="你好",
)
print(resp.text)
```

### 流式调用

```python
for chunk in client.models.generate_content_stream(
    model="agnes-2.0-flash",
    contents="你好",
):
    print(chunk.text or "", end="")
```

流式响应的每个事件是不带 `event:` 字段的 `data:` 行，**没有 `[DONE]` 终止标记**——流结束时直接关闭连接。按这条协议自己写解析器的话，别去等一个永远不来的终止帧。

### base_url 不带 `/v1beta`

> [!IMPORTANT]
> SDK 的 `base_url` 同样**不带** `/v1beta`——SDK 会自己拼上 `/v1beta/models/...`。这个 SDK 在设置了自定义 base URL 之后默认发 `x-goog-api-key` 请求头，网关认这一条，不用另配。

## OpenAI Responses 协议

OpenAI-Responses 协议目前还没有被广泛使用的专用 SDK，因此这一节直接用纯 HTTP 调用示范。

### 非流式调用

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

`instructions` 会被转换成一条 system 消息，数组形态的 `input` 会在转发上游前被转换为 messages；响应被转换回 `output[]` 结构。

### 流式调用

多带一个 `stream` 字段，并给 curl 加 `-N` 关掉缓冲，否则你会等到最后才一次性看到全部输出：

```bash
curl -N -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "你好",
    "stream": true
  }'
```

### 流式事件序列

| 事件 | 何时出现 |
|------|----------|
| `response.created` | 流的第一帧 |
| `response.output_text.delta` | 一个或多个，正文增量都在这里 |
| `response.completed` | 流的最后一帧 |

## 图片与视频

### 生成一张图

同步端点：它在上游把图出完之前不会返回，因此这一条走的是下面故障排查里那个同步超时预算。

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "一只猫" }'
```

### 建一个视频任务

建任务这一步立刻返回，视频本身在上游异步跑完，因此要靠下一节的轮询拿结果：

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "一只猫在跑" }'
```

### 轮询任务状态

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

> [!IMPORTANT]
> 网关在转发之前先校验任务标识的形状，**只接受 `A-Za-z0-9_- (1-128)`**：前一段是允许的字符集，括号里是长度的下界与上界。不匹配的一律 `400`，而且**一次上游请求都不会发出**——那时改上游参数没有用。`400` 的报文里逐字带着这个形状，照着它把标识贴回来即可。

## 通用 OpenAI 兼容客户端

### 填哪几个格子

大多数第三方客户端只给你三四个输入框。对照着填：

| 客户端里的格子 | 填什么 |
|----------------|--------|
| 接口地址 / base URL | `http://localhost:8080/v1` |
| API Key | 你的 `GATEWAY_TOKEN` |
| 模型名 | `agnes-2.0-flash` |
| 组织 / 项目 ID | 留空，网关不看这两个字段 |

### 客户端拉不到模型列表时

有些客户端在启动时先拉一次 `GET /v1/models`，拉不到就不让你发消息。先按上一节的四种写法确认凭据发得出去；确认之后仍拉不到的，绝大多数是客户端把 `/v1` 拼了两次——把地址栏里的 `/v1` 去掉再试一次。

## 会话上下文

### 网关不保存历史

网关**不保存任何会话状态**：每一次请求都是独立的一次转发，池子每次都可能换一把上游 key。要做多轮对话，历史由客户端自己维护并在每一轮完整重发——各协议官方 SDK 默认就是这么做的。

### 四种协议各自把历史放在哪

| 协议 | 历史放在哪 | 系统提示放在哪 |
|------|------------|----------------|
| OpenAI | `messages` 数组 | `messages` 里 `role` 为 system 的那一条 |
| OpenAI-Responses | `input` 数组 | `instructions` 字段 |
| Anthropic | `messages` 数组 | `system` 字段 |
| Gemini | `contents` 数组 | `systemInstruction` 字段 |

## 故障排查

### `401` —— 凭据没送到

缺少或错误的网关凭据。先确认发出去的是 `GATEWAY_TOKEN` 而不是上游 key，再确认 SDK 真的发了上面四种写法之一。上游自己的 `401` 响应体**绝不**转发给你——那里是上游最可能回显 key 片段的地方。

### `404` —— 路径拼错了

十有八九是 `base_url` 多了或少了一段前缀。三个 SDK 的规矩各不相同，逐条见上面三节的「base_url」小节。

### `503` —— 池子里没有可用 key

网关在发起上游请求**之前**就返回它，响应体顶层带一个机器可读的 `reason`：

| `reason` | 是否自愈 | 该做什么 |
|----------|----------|----------|
| `pool_empty` | – | 还没导入任何 key，去管理面板导一把。 |
| `all_cooling` | **会** | 全部 key 冷却中，响应头 `Retry-After` 给出最早恢复时刻，等它。 |
| `all_disabled` | **不会** | 全部 key 被管理员手工停用，去面板重新启用——**凭据本身没问题，别去换 key**。 |
| `all_evicted` | **不会** | 全部 key 因凭据失效被永久剔除，换 key。 |
| `upstream_error` | **会** | key 可用但上游每次尝试都失败，等一等再看。 |

### `504` —— 同步端点用尽了预算

图片生成、视频建任务，以及**所有非流式对话**走同步超时预算 `UPSTREAM_SYNC_TIMEOUT_MS`（默认 120000 毫秒）。这个总预算就是客户端的最坏等待时间，与池子大小无关。收到 `504` 时网关**没有**惩罚任何 key。要么把预算调大，要么改用流式。

### `400` —— 请求体过不了网关这一关

四类成因：Anthropic 协议里出现非 `text` 内容块、视频任务标识形状非法、管理接口的请求体字段不认识、管理接口缺必填项。前两类在上面对应的小节里各有一条说明。

### `502` —— 上游回了 200 但不是 JSON

只发生在需要做格式转换的那几条路由上。网关自己没法把非 JSON 的响应体翻译成你要的协议形状，于是如实报错而不是伪造一个空响应。这一类重试一次往往就好了。

## 获取帮助

- 四条协议的端点与请求 / 响应形状：[API.md](API.md)
- 部署两种形态与全部环境变量：[DEPLOY.md](DEPLOY.md)
- Web 管理面板：[ADMIN.md](ADMIN.md)
- 注册机（自动补池）：[REGISTRAR.md](REGISTRAR.md)
