# Using the Gateway with SDKs

**Language:** English | [简体中文](../zh-CN/USAGE.md) | [繁體中文](../zh-TW/USAGE.md) | [日本語](../ja/USAGE.md) | [한국어](../ko/USAGE.md)

agnes2api implements four protocols on the wire, so you don't need a special client — point
each protocol's official SDK at the gateway's base URL and use your `GATEWAY_TOKEN` as the
API key. Replace `http://localhost:8080` below with your deployment's real URL (a Worker's
`*.workers.dev` domain, your own domain, or `http://localhost:8080` for Docker), and
`your-gateway-token` with your actual `GATEWAY_TOKEN`.

## Credential formats

Whichever SDK you use sends its own default header, and the gateway accepts all four of
these interchangeably — no extra configuration needed to make a particular SDK work:

| Form | Sent by |
|---|---|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` query parameter | Manual/browser-based calls |

## OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-gateway-token",
)

resp = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.choices[0].message.content)
```

Streaming works the same way as against OpenAI itself — pass `stream=True` and iterate the
returned generator.

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
    messages=[{"role": "user", "content": "hello"}],
)
print(msg.content[0].text)
```

Note the SDK's `base_url` does **not** include `/v1` — the SDK appends `/v1/messages`
itself.

## Google GenAI SDK

```python
from google import genai

client = genai.Client(
    api_key="your-gateway-token",
    http_options={"base_url": "http://localhost:8080"},
)

resp = client.models.generate_content(
    model="agnes-2.0-flash",
    contents="hello",
)
print(resp.text)
```

The SDK's `base_url` does **not** include `/v1beta` either — it appends
`/v1beta/models/...` itself.

## Raw HTTP — `/v1/responses`

There is no dedicated SDK for the OpenAI-Responses protocol yet in wide use, so this one is
shown as a plain HTTP call instead:

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "hello"
  }'
```

See [API.md](API.md) for the full response shape and the streaming event sequence.
