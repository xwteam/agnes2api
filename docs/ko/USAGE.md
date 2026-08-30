# 사용 가이드

이 문서가 다루는 것은 **클라이언트 쪽**입니다. 이미 돌고 있는 게이트웨이에 각 프로토콜 공식 SDK의 주소를 맞추고, 첫 요청을 보내고, 스트리밍을 켜고, 거절당했을 때 어디부터 볼지를 씁니다. 엔드포인트별 요청 / 응답 계약은 [API.md](API.md)에, 게이트웨이를 띄우는 두 갈래 길은 [DEPLOY.md](DEPLOY.md)에 있습니다.

> [!TIP]
> agnes2api는 프로토콜 계층에서 네 가지 프로토콜을 구현하므로 **전용 클라이언트가 필요 없습니다**. 각 프로토콜 공식 SDK의 base URL을 이 게이트웨이로 향하게 하고 `GATEWAY_TOKEN`을 API 키로 넘기면 됩니다.

## 시작하기 전에

### 필요한 것 세 가지

| 항목 | 어디서 오는가 |
|------|---------------|
| 게이트웨이 주소 | Worker의 `*.workers.dev` 도메인, 직접 쓰는 도메인, 또는 Docker일 때의 `http://localhost:8080` |
| 게이트웨이 토큰 | 배포할 때 설정한 `GATEWAY_TOKEN`. [배포 가이드](DEPLOY.md#환경-변수) 참고 |
| 쓸 수 있는 업스트림 key 최소 한 개 | 관리 패널에서 풀로 가져옵니다. [관리 패널](ADMIN.md) 참고 |

### 예제에서 쓰는 자리표시자

아래 모든 예제는 이 두 자리표시자를 씁니다. 그대로 복사하기 전에 바꾸세요:

| 자리표시자 | 무엇으로 바꾸는가 |
|------------|-------------------|
| `http://localhost:8080` | 실제로 배포한 게이트웨이 주소 |
| `your-gateway-token` | 당신의 진짜 `GATEWAY_TOKEN` |

> [!NOTE]
> 게이트웨이는 스스로 내용을 만들지 않습니다. 요청을 업스트림 Agnes로 넘기고, 응답을 당신이 쓴 프로토콜로 되번역할 뿐입니다. 풀에 쓸 수 있는 key가 하나도 없으면 어떤 프로토콜 엔드포인트든 곧바로 `503`을 돌려줍니다. 그 갈래의 `reason`은 이 문서 마지막 절에 있습니다.

## 자격 증명 전달 방식

### 동등한 네 가지 표기

SDK마다 자기 기본 요청 헤더를 보냅니다. 게이트웨이는 아래 네 가지를 차별 없이 받습니다 — 특정 SDK를 위해 따로 설정할 것은 없습니다:

| 방식 | 누가 보내는가 |
|------|---------------|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` 쿼리 파라미터 | 수동 호출/브라우저 상황 |

`/v1/*`와 `/v1beta/*` 아래 모든 라우트가 이 자격 증명을 요구하고, `/health`는 요구하지 않습니다.

### 게이트웨이 토큰은 업스트림 key가 아니다

`GATEWAY_TOKEN`은 **다운스트림 사용자**에게 나눠 주는 토큰이며, 풀에 든 업스트림 key와는 아무 관계가 없습니다 — 풀의 key는 한 개도 게이트웨이 밖으로 나가지 않습니다.

> [!IMPORTANT]
> 관리 API `/admin/api/*`는 위 네 가지 표기를 **받지 않습니다**. 오직 `x-admin-key` 헤더만 읽고, 오직 `ADMIN_TOKEN`만 통과시킵니다. 두 열쇠는 엄격히 분리됩니다: 중계 토큰을 패널 비밀번호로 돌려쓰는 것은 풀 전체를 모든 다운스트림 사용자에게 넘기는 것과 같습니다.

## 지원 모델

### 네 모델이 각각 쓰이는 자리

| 모델 | 쓰이는 곳 |
|------|-----------|
| `agnes-2.0-flash` | 대화 / 텍스트 계열 엔드포인트 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

### 모델 이름은 본문에 넣는가, 경로에 넣는가

OpenAI, OpenAI-Responses, Anthropic 세 프로토콜은 모델 이름을 요청 본문의 `model` 필드에 넣습니다. Gemini의 두 엔드포인트는 **경로에 씁니다**. 경로는 마지막 콜론을 기준으로 나누므로 모델 이름 자체에 콜론이 들어 있어도 제대로 처리됩니다.

`GET /v1/models`는 OpenAI 모양의 모델 목록을, `GET /v1beta/models`는 같은 모델들을 Gemini 모양으로 돌려줍니다 — 한 경로가 두 형식을 동시에 돌려줄 수는 없으니 쓰는 SDK에 맞는 쪽을 고르세요.

> [!NOTE]
> 두 목록 모두 네 모델이 더도 덜도 없이 들어 있는 **고정 표**입니다. 지금 이 순간 풀에 쓸 수 있는 key가 있는지는 반영하지 않습니다. 그것을 알려면 관리 패널을 보거나, 그냥 요청을 한 번 보내 `503`이 오는지 보세요.

## OpenAI SDK

### 비스트리밍 호출

`base_url`을 게이트웨이로 향하게 한 다음 평소처럼 `chat.completions.create`를 부르면 됩니다. 나머지 인자는 OpenAI 본가와 똑같습니다:

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

### 스트리밍 호출

`stream=True`를 넘기고 돌아온 제너레이터를 돌리면 됩니다. OpenAI 본가에 직접 붙일 때와 똑같습니다:

```python
stream = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "안녕하세요"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

이 프로토콜의 스트리밍 바이트를 게이트웨이는 **그대로 통과시킵니다**. 파싱도 고쳐 쓰기도 하지 않습니다: `Content-Type: text/event-stream`, 표준 OpenAI 방식의 `data: {...}` 조각, 끝은 `data: [DONE]`입니다.

### base_url에는 `/v1`을 붙인다

> [!IMPORTANT]
> 이것은 아래 두 SDK와 **반대**입니다: `openai` SDK의 `base_url`에는 `/v1`을 **붙입니다**. 그 뒤에 `/chat/completions`를 그대로 이어 붙이기 때문입니다. `/v1`을 빠뜨리면 SDK는 `/chat/completions`를 두드리는데, 게이트웨이에 그런 경로는 없어서 아무 도움도 안 되는 `404`가 돌아옵니다.

## Anthropic SDK

### 비스트리밍 호출

자격 증명은 `api_key`로 넘깁니다. SDK가 그것을 `x-api-key` 헤더에 넣어 주므로 손으로 더할 것은 없습니다:

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

### 스트리밍 호출

```python
with client.messages.stream(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "안녕하세요"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

스트리밍 응답은 표준 Anthropic 이벤트 순서입니다: `message_start`, `content_block_start`, 하나 이상의 `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

### base_url에 `/v1`을 붙이지 않는다

> [!IMPORTANT]
> 이 SDK의 `base_url`에는 `/v1`을 **붙이지 않습니다** — SDK가 스스로 `/v1/messages`를 이어 붙입니다. `http://localhost:8080/v1`이라고 쓰면 `/v1/v1/messages`를 두드리게 됩니다.

> [!WARNING]
> `content`(또는 `system`) 배열에 `text`가 아닌 블록이 하나라도 있으면 — `image`, `tool_use`, `tool_result` 모두 해당합니다 — 게이트웨이는 업스트림으로 넘기기 **전에** `400`을 돌려줍니다. 그 블록을 조용히 버리지 않습니다. 멀티모달 입력은 이 프로토콜로 오늘 통하지 않습니다. 이미지를 만들려면 `/v1/images/generations`를 쓰세요.

## Google GenAI SDK

### 비스트리밍 호출

이 SDK에서 base URL을 바꾸는 입구는 `http_options`이며, 생성자의 위치 인자가 아닙니다:

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

### 스트리밍 호출

```python
for chunk in client.models.generate_content_stream(
    model="agnes-2.0-flash",
    contents="안녕하세요",
):
    print(chunk.text or "", end="")
```

스트리밍 응답의 각 이벤트는 `event:` 필드가 없는 `data:` 줄이고, **`[DONE]` 종료 표시가 없습니다** — 스트림은 끝나면 그냥 닫힙니다. 이 프로토콜용 파서를 직접 쓴다면 영영 오지 않을 종료 프레임을 기다리지 마세요.

### base_url에 `/v1beta`를 붙이지 않는다

> [!IMPORTANT]
> 이 SDK의 `base_url`에도 `/v1beta`를 **붙이지 않습니다** — SDK가 스스로 `/v1beta/models/...`를 이어 붙입니다. 사용자 지정 base URL을 설정하면 이 SDK는 기본으로 `x-goog-api-key` 헤더를 보내고, 게이트웨이는 그것을 그대로 받으므로 따로 설정할 것이 없습니다.

## OpenAI Responses 프로토콜

OpenAI-Responses 프로토콜에는 널리 쓰이는 전용 SDK가 아직 없어서, 이 절은 순수 HTTP 호출로 보여 줍니다.

### 비스트리밍 호출

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "당신은 친절한 조수입니다.",
    "input": "안녕하세요"
  }'
```

`instructions`는 system 메시지 하나로 바뀌고, 배열 형태의 `input`은 업스트림으로 넘기기 전에 messages로 바뀝니다. 응답은 `output[]` 구조로 되돌려집니다.

### 스트리밍 호출

`stream` 필드를 하나 더 넣고 curl에는 `-N`을 줘서 버퍼링을 끕니다. 끄지 않으면 마지막에 한꺼번에 출력이 옵니다:

```bash
curl -N -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "안녕하세요",
    "stream": true
  }'
```

### 스트리밍 이벤트 순서

| 이벤트 | 언제 나오는가 |
|--------|---------------|
| `response.created` | 스트림의 첫 프레임 |
| `response.output_text.delta` | 하나 이상. 본문 증분은 전부 여기로 옵니다 |
| `response.completed` | 스트림의 마지막 프레임 |

## 이미지와 비디오

### 이미지 한 장 만들기

동기 엔드포인트입니다. 업스트림이 이미지를 다 만들 때까지 돌려주지 않으므로, 이 호출은 아래 문제 해결에 있는 동기 타임아웃 예산 위에서 돕니다.

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "고양이 한 마리" }'
```

### 비디오 작업 만들기

작업 생성은 즉시 돌아오고 비디오 자체는 업스트림에서 비동기로 끝나므로, 결과는 다음 절의 폴링으로 가져와야 합니다:

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "달리는 고양이 한 마리" }'
```

### 작업 상태 조회하기

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

> [!IMPORTANT]
> 게이트웨이는 넘기기 전에 작업 식별자의 모양을 검사하며 **`A-Za-z0-9_- (1-128)`만 받습니다**: 앞부분은 허용되는 문자 집합이고 괄호 안은 길이의 하한과 상한입니다. 맞지 않으면 무조건 `400`이고, 게다가 **업스트림 요청은 한 번도 나가지 않습니다** — 그때 업스트림 파라미터를 고쳐 봐야 소용이 없습니다. `400` 본문에 이 모양이 글자 그대로 담겨 있으니 그대로 맞춰 식별자를 다시 붙이세요.

## 범용 OpenAI 호환 클라이언트

### 어느 칸을 채우는가

대부분의 서드파티 클라이언트는 입력 칸을 서너 개만 줍니다. 이렇게 채우세요:

| 클라이언트의 칸 | 무엇을 넣는가 |
|-----------------|---------------|
| API base URL | `http://localhost:8080/v1` |
| API 키 | 당신의 `GATEWAY_TOKEN` |
| 모델 이름 | `agnes-2.0-flash` |
| 조직 / 프로젝트 ID | 비워 두세요. 게이트웨이는 이 두 필드를 읽지 않습니다 |

### 클라이언트가 모델 목록을 못 가져올 때

시작할 때 `GET /v1/models`를 한 번 부르고, 그것이 될 때까지 메시지를 못 보내게 하는 클라이언트가 있습니다. 먼저 위 네 가지 표기 중 하나로 자격 증명이 아예 나가고 있는지 확인하세요. 나가는데도 목록만 실패한다면 십중팔구 클라이언트가 `/v1`을 두 번 이어 붙인 것입니다 — 주소 칸의 `/v1`을 빼고 다시 해 보세요.

## 대화 맥락

### 게이트웨이는 이력을 보관하지 않는다

게이트웨이는 **대화 상태를 전혀 보관하지 않습니다**. 요청은 매번 독립된 한 번의 전달이고, 풀이 건네는 업스트림 key도 매번 달라질 수 있습니다. 여러 턴 대화를 하려면 이력은 클라이언트가 들고 매 턴 통째로 다시 보냅니다 — 각 프로토콜 공식 SDK가 기본으로 하는 일이 바로 그것입니다.

### 프로토콜마다 이력을 어디에 두는가

| 프로토콜 | 이력을 두는 곳 | 시스템 프롬프트를 두는 곳 |
|----------|----------------|---------------------------|
| OpenAI | `messages` 배열 | `messages` 중 `role`이 system인 항목 |
| OpenAI-Responses | `input` 배열 | `instructions` 필드 |
| Anthropic | `messages` 배열 | `system` 필드 |
| Gemini | `contents` 배열 | `systemInstruction` 필드 |

## 문제 해결

### `401` —— 자격 증명이 닿지 않았다

게이트웨이 자격 증명이 없거나 틀렸습니다. 먼저 보내는 것이 업스트림 key가 아니라 `GATEWAY_TOKEN`인지 확인하고, 다음으로 SDK가 위 네 가지 표기 중 하나를 정말 보내는지 확인하세요. 업스트림 자신의 `401` 응답 본문은 **결코** 전달되지 않습니다 — 거기가 업스트림 API가 key 조각을 되비칠 가능성이 가장 큰 자리이기 때문입니다.

### `404` —— 경로가 틀렸다

열에 아홉은 `base_url`의 접두사가 하나 많거나 하나 모자랍니다. 규칙은 SDK마다 다르며, 위 세 절에 각각 "base_url" 소절이 있습니다.

### `503` —— 풀에 쓸 수 있는 key가 없다

게이트웨이는 업스트림 요청을 내기 **전에** 이것을 돌려주고, 본문 최상위에 기계가 읽을 수 있는 `reason`을 싣습니다:

| `reason` | 저절로 낫는가 | 무엇을 해야 하는가 |
|----------|---------------|--------------------|
| `pool_empty` | – | 아직 하나도 가져오지 않았습니다. 관리 패널에서 넣으세요. |
| `all_cooling` | **낫는다** | 모든 key가 냉각 중입니다. 응답 헤더 `Retry-After`가 가장 이른 회복 시각을 줍니다. 기다리세요. |
| `all_disabled` | **안 낫는다** | 모든 key를 관리자가 손으로 껐습니다. 패널에서 다시 켜세요 — **자격 증명 자체는 멀쩡하니 key를 갈지 마세요**. |
| `all_evicted` | **안 낫는다** | 자격 증명이 죽어 모든 key가 영구히 퇴출됐습니다. key를 갈아 주세요. |
| `upstream_error` | **낫는다** | key는 쓸 수 있는데 업스트림이 매번 실패합니다. 좀 기다렸다 다시 보세요. |

### `504` —— 동기 엔드포인트가 예산을 다 썼다

이미지 생성, 비디오 작업 생성, 그리고 **모든 비스트리밍 대화**는 동기 타임아웃 예산 `UPSTREAM_SYNC_TIMEOUT_MS`(기본 120000밀리초) 위에서 돕니다. 이 총예산이 곧 클라이언트의 최악 대기 시간이고, 풀 크기와는 상관이 없습니다. `504`일 때 게이트웨이는 어떤 key도 **벌하지 않습니다**. 예산을 올리거나 스트리밍으로 바꾸세요.

### `400` —— 본문이 게이트웨이를 통과하지 못했다

원인은 네 갈래입니다: Anthropic 프로토콜의 `text` 아닌 내용 블록, 비디오 작업 식별자 모양이 잘못됨, 관리 API 요청 본문에 모르는 필드, 관리 API 필수 항목 누락. 앞의 둘은 위 해당 절에 각각 설명이 있습니다.

### `502` —— 업스트림이 200을 줬는데 JSON이 아니다

형식을 변환하는 라우트에서만 일어납니다. 게이트웨이는 JSON이 아닌 본문을 당신이 요구한 프로토콜 모양으로 번역할 수 없으므로, 빈 응답을 지어내지 않고 사실대로 알립니다. 이 종류는 한 번 다시 해 보면 풀릴 때가 많습니다.

## 다음 단계

- 두 배포 형태와 모든 환경 변수: [DEPLOY.md](DEPLOY.md)
- 웹 관리 패널: [ADMIN.md](ADMIN.md)
- 레지스트라(자동 풀 보충): [REGISTRAR.md](REGISTRAR.md)
- 네 프로토콜의 엔드포인트와 요청 / 응답 형태: [API.md](API.md)
- 프로젝트 개요와 빠른 시작: [README.md](../../README.md)
- 버그 신고와 질문: [GitHub Issues](https://github.com/xwteam/agnes2api/issues)
