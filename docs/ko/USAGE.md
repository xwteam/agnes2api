# SDK로 게이트웨이 사용하기

**언어:** [English](../en/USAGE.md) | [简体中文](../zh-CN/USAGE.md) | [繁體中文](../zh-TW/USAGE.md) | [日本語](../ja/USAGE.md) | 한국어

agnes2api는 프로토콜 수준에서 4가지 프로토콜을 구현하고 있으므로 전용
클라이언트가 필요 없습니다. 각 프로토콜의 공식 SDK가 사용하는 base URL을
이 게이트웨이로 향하게 하고, `GATEWAY_TOKEN`을 API key로 전달하면 됩니다.
아래의 `http://localhost:8080`은 실제 배포 주소(Worker의 `*.workers.dev`
도메인, 커스텀 도메인, 또는 Docker의 경우 `http://localhost:8080`)로,
`your-gateway-token`은 실제 `GATEWAY_TOKEN`으로 바꿔서 사용하세요.

## 인증 정보 전달 방식

어떤 SDK를 사용하든 각자 기본으로 보내는 헤더가 있으며, 게이트웨이는 다음 네
가지를 모두 동일하게 수용합니다 —— 특정 SDK를 위해 별도 설정을 할 필요가
없습니다.

| 방식 | 전송 주체 |
|----|---------|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` 쿼리 파라미터 | 수동 호출/브라우저 환경 |

## OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-gateway-token",
)

resp = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "안녕하세요"}],
)
print(resp.choices[0].message.content)
```

스트리밍도 OpenAI에 직접 연결할 때와 동일한 방식으로 사용할 수 있습니다.
`stream=True`를 전달하고 반환된 제너레이터를 순회하면 됩니다.

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
    messages=[{"role": "user", "content": "안녕하세요"}],
)
print(msg.content[0].text)
```

SDK의 `base_url`에는 `/v1`을 **포함하지 않는다**는 점에 유의하세요 —— SDK
내부에서 `/v1/messages`를 자동으로 붙입니다.

## Google GenAI SDK

```python
from google import genai

client = genai.Client(
    api_key="your-gateway-token",
    http_options={"base_url": "http://localhost:8080"},
)

resp = client.models.generate_content(
    model="agnes-2.0-flash",
    contents="안녕하세요",
)
print(resp.text)
```

마찬가지로 SDK의 `base_url`에는 `/v1beta`를 **포함하지 않습니다** —— SDK가
`/v1beta/models/...`를 자동으로 붙입니다.

## 순수 HTTP 호출 —— `/v1/responses`

OpenAI-Responses 프로토콜은 아직 널리 쓰이는 전용 SDK가 없으므로, 여기서는
순수 HTTP 호출로 보여드립니다.

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "안녕하세요"
  }'
```

전체 응답 구조와 스트리밍 이벤트 순서는 [API.md](API.md)를 참고하세요.
