# 用 SDK 接入网关

agnes2api 在协议层实现了四种协议，因此不需要专门的客户端——把各协议官方 SDK 的基址
指向本网关，`GATEWAY_TOKEN` 当作 API key 传入即可。下文的 `http://localhost:8080`
请替换成你实际部署的地址（Worker 的 `*.workers.dev` 域名、自定义域名，或 Docker 部署
时的 `http://localhost:8080`），`your-gateway-token` 替换成你真实的 `GATEWAY_TOKEN`。

## 凭据传递方式

不同 SDK 各自发送自己默认的请求头，网关对以下四种一视同仁地接受——不需要为某个 SDK
做额外配置：

| 方式 | 由谁发送 |
|----|--------|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` 查询参数 | 手动调用/浏览器场景 |

## OpenAI SDK

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

流式调用与直接对接 OpenAI 完全一样——传 `stream=True`，遍历返回的生成器即可。

## Anthropic SDK

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

注意 SDK 的 `base_url` **不带** `/v1`——SDK 内部会自己拼上 `/v1/messages`。

## Google GenAI SDK

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

SDK 的 `base_url` 同样**不带** `/v1beta`——SDK 会自己拼上 `/v1beta/models/...`。

## 裸 HTTP 调用 —— `/v1/responses`

OpenAI-Responses 协议目前还没有被广泛使用的专用 SDK，因此这里直接用一次纯 HTTP 调用
示范：

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "你好"
  }'
```

完整的响应结构与流式事件序列见 [API.md](API.md)。
