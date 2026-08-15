# 用 SDK 接入閘道

**語言：** [English](../en/USAGE.md) | [简体中文](../zh-CN/USAGE.md) | 繁體中文 | [日本語](../ja/USAGE.md) | [한국어](../ko/USAGE.md)

agnes2api 在協議層實作了四種協議，因此不需要專用的用戶端——把各協議官方 SDK 的基底
位址指向本閘道，`GATEWAY_TOKEN` 當作 API key 傳入即可。下文的 `http://localhost:8080`
請換成你實際部署的位址（Worker 的 `*.workers.dev` 網域、自訂網域，或 Docker 部署時的
`http://localhost:8080`），`your-gateway-token` 換成你真實的 `GATEWAY_TOKEN`。

## 憑證傳遞方式

不同 SDK 各自發送自己預設的請求標頭，閘道對以下四種一視同仁地接受——不需要為特定
SDK 做額外設定：

| 方式 | 由誰發送 |
|---|---|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` 查詢參數 | 手動呼叫／瀏覽器場景 |

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

串流呼叫方式與直接對接 OpenAI 完全一樣——傳 `stream=True`，遍歷回傳的產生器即可。

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

注意 SDK 的 `base_url` **不含** `/v1`——SDK 內部會自行接上 `/v1/messages`。

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

SDK 的 `base_url` 同樣**不含** `/v1beta`——SDK 會自行接上 `/v1beta/models/...`。

## 裸 HTTP 呼叫 —— `/v1/responses`

OpenAI-Responses 協議目前還沒有被廣泛使用的專屬 SDK，因此這裡直接示範一次純 HTTP
呼叫：

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "你好"
  }'
```

完整的回應結構與串流事件序列見 [API.md](API.md)。
