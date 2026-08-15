# SDK でゲートウェイを利用する

**Language:** [English](../en/USAGE.md) | [简体中文](../zh-CN/USAGE.md) | [繁體中文](../zh-TW/USAGE.md) | 日本語 | [한국어](../ko/USAGE.md)

agnes2api はワイヤレベルで 4 つのプロトコルを実装しているため、専用クライアント
は不要です。各プロトコルの公式 SDK のベース URL をこのゲートウェイに向け、
`GATEWAY_TOKEN` を API key として渡すだけで使えます。以下の
`http://localhost:8080` は、実際のデプロイ先の URL（Worker の
`*.workers.dev` ドメイン、独自ドメイン、または Docker の場合は
`http://localhost:8080`）に、`your-gateway-token` は実際の `GATEWAY_TOKEN`
に置き換えてください。

## 認証情報の形式

どの SDK を使っても、それぞれが既定で送信するヘッダーがあり、ゲートウェイは
以下の 4 種類をすべて同等に受け付けます——特定の SDK のために追加設定を
する必要はありません。

| 形式 | 送信元 |
|---|---|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` クエリパラメータ | 手動呼び出し／ブラウザ経由 |

## OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-gateway-token",
)

resp = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "こんにちは"}],
)
print(resp.choices[0].message.content)
```

ストリーミングも OpenAI 本体に接続する場合と同じ方法で使えます。
`stream=True` を渡し、返されたジェネレータを反復処理してください。

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
    messages=[{"role": "user", "content": "こんにちは"}],
)
print(msg.content[0].text)
```

SDK の `base_url` には `/v1` を**含めない**点に注意してください——SDK 内部で
`/v1/messages` が自動的に付加されます。

## Google GenAI SDK

```python
from google import genai

client = genai.Client(
    api_key="your-gateway-token",
    http_options={"base_url": "http://localhost:8080"},
)

resp = client.models.generate_content(
    model="agnes-2.0-flash",
    contents="こんにちは",
)
print(resp.text)
```

同様に、SDK の `base_url` には `/v1beta` を**含めません**——SDK が
`/v1beta/models/...` を自動的に付加します。

## 生の HTTP 呼び出し —— `/v1/responses`

OpenAI-Responses プロトコルには広く使われている専用 SDK がまだないため、
ここでは素の HTTP 呼び出しとして示します。

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "こんにちは"
  }'
```

完全な応答の形とストリーミングイベントの順序は [API.md](API.md) を
参照してください。
