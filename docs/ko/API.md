# API 레퍼런스

이 문서는 agnes2api가 외부에 노출하는 네 가지 프로토콜 엔드포인트, 관리 인터페이스, 오류 계약을 하나씩 설명합니다.

## 인증

`/v1/*`와 `/v1beta/*` 아래의 모든 라우트는 자격 증명이 필요하고 `/health`는 필요 없습니다. 아래 네 가지 전달 방식 중 하나만 고르면 됩니다 — 각 프로토콜 공식 SDK가 기본으로 보내는 형태와 그대로 맞아떨어지므로 보통 추가 설정이 필요 없습니다.

아래 예제는 모두 `http://localhost:8080`(Docker/Node가 듣는 주소)을 씁니다. Cloudflare Worker에 배포했다면 여러분의 `*.workers.dev` 도메인(또는 커스텀 도메인)으로 바꾸면 됩니다. `your-gateway-token`은 여러분이 설정한 `GATEWAY_TOKEN`의 자리표시자입니다.

### 방식 1: Authorization Bearer 헤더

OpenAI와 OpenAI-Responses 생태계의 표준 표기이며, 공식 `openai` SDK는 기본으로 이것만 보냅니다:

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

### 방식 2: x-api-key 헤더

Anthropic 생태계의 표준 표기이며, 공식 `anthropic` SDK는 기본으로 이것만 보냅니다:

```bash
curl http://localhost:8080/v1/models \
  -H "x-api-key: your-gateway-token"
```

### 방식 3: x-goog-api-key 헤더

Gemini 생태계의 표준 표기이며, 공식 `google-genai` SDK는 커스텀 base URL을 설정하면 이것을 보냅니다:

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

### 방식 4: key 쿼리 파라미터

헤더를 설정할 수 없는 상황(브라우저 `EventSource`, 일부 게이트웨이 프로브)에서는 자격 증명을 URL에 넣을 수 있습니다:

```bash
curl "http://localhost:8080/v1beta/models?key=your-gateway-token"
```

### 자격 증명은 어디서 오는가

이 자격 증명은 배포할 때 설정한 `GATEWAY_TOKEN` 그 자체이며, 업스트림 Agnes의 key 풀과는 전혀 무관합니다 — 풀에 있는 key는 한 개도 게이트웨이 밖으로 나가지 않습니다:

```env
# 필수: 다운스트림 클라이언트가 이 게이트웨이를 호출할 때 제시하는 토큰. 업스트림 key와 무관
GATEWAY_TOKEN=긴-무작위-문자열로-바꾸세요
```

자격 증명이 없거나 틀리면 `401`을 돌려줍니다:

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

> [!IMPORTANT]
> 관리 인터페이스 `/admin/api/*`는 위 네 가지 방식을 **하나도 받지 않습니다**. `x-admin-key` 헤더만 읽고 `ADMIN_TOKEN`만 받습니다. 두 열쇠는 엄격히 분리됩니다: 중계 토큰은 모든 다운스트림 사용자에게 나눠 주는 것이므로, 그것을 패널 토큰으로 돌려쓰면 풀 전체를 넘겨주는 것과 같습니다.

## 표준 베어 경로

네 프로토콜은 각자 자기 표준 베어 경로에 올라가 있어서, 주요 SDK는 `base_url`에 벤더 접두사를 붙일 필요가 없습니다.

### 프로토콜별 베어 경로

**OpenAI 형식**:

- `POST /v1/chat/completions`
- `GET /v1/models`

**OpenAI-Responses 형식**:

- `POST /v1/responses`

**Anthropic 형식**:

- `POST /v1/messages`

**Gemini 형식**:

- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `GET /v1beta/models`

### 경로 안의 모델 이름

Gemini의 두 엔드포인트는 모델 이름을 본문이 아니라 경로에 씁니다. 경로는 **마지막 콜론에서 잘리므로**, 모델 이름 자체에 콜론이 들어 있어도(예: `vendor:agnes-2.0-flash`) 올바르게 처리됩니다.

`GET /v1/models`는 OpenAI 형태의 모델 목록을, `GET /v1beta/models`는 같은 모델들의 Gemini 형태를 돌려줍니다 — 같은 경로가 두 형태를 동시에 돌려줄 수는 없으니 쓰는 SDK에 맞는 쪽을 고르세요.

## 에러 응답 형식

게이트웨이가 스스로 만드는 오류는 언제나 `{ "error": { "type": ..., "message": ... } }`라는 봉투이며, 네 프로토콜의 SDK가 모두 파싱할 수 있습니다. 업스트림이 만든 오류는 그대로 통과시켜 업스트림 자신의 오류 구조를 유지합니다.

### 자주 나오는 오류 코드

| 상태 코드 | 설명 |
|---------|----|
| `400` | 요청 본문이 게이트웨이 단계를 통과하지 못했습니다. 업스트림이 스스로 돌려주는 `400`도 같은 코드지만 그쪽은 손대지 않은 업스트림 구조입니다. 네 가지 원인은 표 아래를 보세요. |
| `401` | 게이트웨이 자격 증명이 없거나 틀림(프로토콜 엔드포인트); 관리 인터페이스의 `x-admin-key`가 틀림. 업스트림 `401`의 본문은 절대 전달하지 않습니다. |
| `404` | 경로가 없음; 또는 관리 엔드포인트의 `{id}`가 없음(`没有这把 key`). |
| `409` | 관리 쪽 전제 조건이 충족되지 않음. 본문 최상위에 기계가 읽을 수 있는 `reason`이 붙습니다. 네 가지 경우는 표 아래를 보세요. |
| `429` | 아웃바운드 프로브 가드가 이번 호출을 막았습니다. 본문 최상위에 `reason`이 붙습니다. |
| `502` | 형식 변환 라우트에서 업스트림이 `200`을 돌려줬지만 본문이 JSON이 아니었습니다. |
| `503` | 풀에 쓸 수 있는 key가 없음(다음 절 참고); 또는 관리 인터페이스를 쓸 수 없음(두 토큰이 충돌했거나, 이 배포가 모듈을 연결하지 않았음). |
| `504` | 동기 엔드포인트가 `UPSTREAM_SYNC_TIMEOUT_MS` 총예산을 다 썼습니다(아래 절 참고). |

> [!NOTE]
> `400`의 네 가지 원인: Anthropic 프로토콜에 `text`가 아닌 콘텐츠 블록이 있음, 비디오 작업 식별자 형태가 잘못됨, 관리 엔드포인트의 필드를 모름, 관리 엔드포인트의 필수 항목이 빠짐. `409`의 네 가지: 비활성화하지 않고 key를 지우려 함, 풀 크기가 화면에서 본 값과 다름, 레지스트라가 꺼져 있음, 채널에 자격 증명이 없음. `429`는 단일 key 확인과 채널 연결 테스트 두 아웃바운드 프로브를 덮으며 둘 다 **식별자별로 속도 제한**되어 서로를 막지 않습니다.

### key 풀 고갈 (`503`)

풀에 쓸 수 있는 key가 하나도 없으면 게이트웨이는 업스트림 요청을 보내기 전에 바로 `503`을 돌려줍니다:

| `reason` | 자가 회복 | 뜻 |
|--------|---------|----|
| `pool_empty` | – | 아직 key를 하나도 가져오지 않았습니다. |
| `all_cooling` | **함** | 모든 key가 쿨다운 중입니다(속도 제한, 요금, 순간 장애 누적). `Retry-After` 헤더가 가장 이른 회복 시각을 알려줍니다. |
| `all_disabled` | **안 함** | 모든 key가 관리 패널에서 관리자에 의해 **수동으로 비활성화**되었습니다. 패널에서 다시 켜면 됩니다 — **자격 증명 자체는 멀쩡하니 key를 바꾸지 마세요**. |
| `all_evicted` | **안 함** | 모든 key가 업스트림 인증 실패(`401`/`403`)로 영구 제거되었습니다. 교체하세요. |
| `upstream_error` | **함** | key 자체는 쓸 수 있지만 업스트림 시도가 매번 실패합니다. |

**응답**:

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
```

### 동기 엔드포인트 타임아웃 (`504`)

이미지 생성, 비디오 작업 생성, 그리고 **모든 비스트리밍 대화**(네 프로토콜)는 동기 타임아웃 예산 `UPSTREAM_SYNC_TIMEOUT_MS`(기본 120000밀리초, [배포 가이드](DEPLOY.md#환경-변수) 참고) 위에서 돕니다. 그 총예산 안에서 시도한 key가 하나도 응답하지 않으면 `504`를 돌려줍니다:

| `reason` | 뜻 |
|--------|----|
| `upstream_timeout` | 이번 요청이 `UPSTREAM_SYNC_TIMEOUT_MS` 총예산을 다 썼고, 그 사이 시도한 key 중 어느 것도 자기 시도 예산 안에 응답하지 않았습니다. |

**응답**:

```json
{ "error": { "reason": "upstream_timeout", "message": "同步端点用尽了 120000 毫秒的总预算：已尝试 2 把 key，均未在各自的尝试预算内收到上游响应……" } }
```

원인은 셋입니다: 업스트림 전체가 느리거나, 예산이 너무 작거나, 그 key들에 대응하는 업스트림 세션이 멈춰 있음. 이 총예산이 곧 클라이언트의 최악 대기 시간이며 풀 크기와는 무관합니다. `504`를 받았을 때 게이트웨이는 어떤 key도 **벌하지 않습니다**; 같은 요청 안에서 다른 key가 성공했을 때에만 먼저 타임아웃된 쪽이 기록됩니다.

### 통과시키는 것과 시키지 않는 것

위 경우를 빼면 업스트림이 돌려주는 다른 오류 상태 코드(`400`, `404` 등)는 모두 그대로 통과되어 업스트림 자신의 오류 구조가 유지되며, 게이트웨이는 고쳐 쓰지 않습니다. 예외는 둘: 업스트림 `401`/`403`의 본문은 **절대** 전달하지 않고(거기가 업스트림 API가 key 조각을 가장 흘리기 쉬운 자리입니다), 형식 변환 라우트에서 업스트림이 `200`을 줬는데 본문이 JSON이 아니면 `502`가 됩니다.

업스트림 응답 헤더도 그대로 전달하지 않고 `content-type`, `cache-control`, `retry-after`만 남깁니다. 나머지(`set-cookie`, `www-authenticate`, 각 벤더의 `x-*` 헤더)는 모두 벗겨냅니다 — 풀은 요청마다 다른 key를 고를 수 있고, 그 헤더들은 여러분의 게이트웨이가 아니라 업스트림 계정을 설명하기 때문입니다.

## 모델

게이트웨이는 네 모델을 노출하며, 어느 엔드포인트를 부르느냐가 무엇을 보낼지 정합니다:

| 모델 | 쓰는 곳 |
|----|-------|
| `agnes-2.0-flash` | 대화/텍스트 계열 엔드포인트 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## OpenAI 호환 API

### GET /v1/models

OpenAI 형식의 모델 목록. 파라미터를 받지 않습니다.

**요청**:

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

**응답**:

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

OpenAI Chat Completions 프로토콜. 비스트리밍 응답은 업스트림의 OpenAI 형식 JSON을 그대로 돌려준 것입니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `model` | string | 예 | `agnes-2.0-flash`를 씁니다. |
| `messages` | array | 예 | 표준 OpenAI 메시지 배열. |
| `stream` | boolean | 아니오 | `true`를 보내면 스트리밍. 기본값은 `false`. |

**요청**:

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

**응답**:

```json
{
  "id": "c1",
  "choices": [{ "message": { "role": "assistant", "content": "hi" } }]
}
```

`"stream": true`를 보내면 스트리밍 응답을 받습니다: `Content-Type: text/event-stream`, 표준 OpenAI 스타일 `data: {...}` 조각, 마지막은 `data: [DONE]`입니다.

> [!WARNING]
> 스트림 마지막 청크에 usage가 붙는지는 실제 업스트림에서 검증되지 않았습니다: 이 게이트웨이는 이 프로토콜의 스트리밍 바이트를 그대로 통과시키며 파싱도 재작성도 하지 않습니다. 업스트림이 스트림 끝에 usage 블록을 보내면 그 바이트가 그대로 클라이언트에 도착합니다.

## OpenAI Responses API

### POST /v1/responses

OpenAI-Responses 프로토콜. 본문의 `instructions`와 배열 형태의 `input`은 업스트림으로 전달하기 전에 messages로 변환되고, 응답은 `output[]` 구조로 변환됩니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `model` | string | 예 | `agnes-2.0-flash`를 씁니다. |
| `input` | string / array | 예 | 문자열 또는 표준 Responses 입력 배열. |
| `instructions` | string | 아니오 | system 메시지 하나로 변환됩니다. |
| `stream` | boolean | 아니오 | `true`를 보내면 스트리밍. 기본값은 `false`. |

**요청**:

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "당신은 친절한 도우미입니다.",
    "input": "안녕하세요"
  }'
```

**응답**:

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
    "content": [{ "type": "output_text", "text": "안녕하세요", "annotations": [] }]
  }],
  "usage": { "input_tokens": 3, "output_tokens": 5, "total_tokens": 8 }
}
```

`"stream": true`일 때 응답은 `text/event-stream`이며 `response.created`, 하나 이상의 `response.output_text.delta`, `response.completed`를 실어 나릅니다.

## Anthropic 호환 API

### POST /v1/messages

Anthropic Messages 프로토콜. 본문의 `system`과 배열 형태의 `content`는 업스트림으로 전달하기 전에 평탄화되고, 응답은 Anthropic의 content block 구조로 변환됩니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `model` | string | 예 | `agnes-2.0-flash`를 씁니다. |
| `max_tokens` | number | 예 | Anthropic 프로토콜 자체의 필수 항목. |
| `messages` | array | 예 | 표준 Anthropic 메시지 배열. |
| `system` | string / array | 아니오 | 업스트림으로 전달하기 전에 평문으로 평탄화됩니다. |
| `stream` | boolean | 아니오 | `true`를 보내면 스트리밍. 기본값은 `false`. |

**요청**:

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "x-api-key: your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "max_tokens": 1024,
    "system": "당신은 친절한 도우미입니다.",
    "messages": [{ "role": "user", "content": "안녕하세요" }]
  }'
```

**응답**:

```json
{
  "id": "msg_c1",
  "type": "message",
  "role": "assistant",
  "model": "agnes-2.0-flash",
  "content": [{ "type": "text", "text": "안녕하세요" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 3, "output_tokens": 5 }
}
```

`"stream": true`일 때 응답은 `text/event-stream`이며 표준 Anthropic 이벤트 순서를 실어 나릅니다: `message_start`, `content_block_start`, 하나 이상의 `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

> [!IMPORTANT]
> `content`(또는 `system`) 배열에 내부 평문 형식으로 옮길 수 없는 블록 — `image`, `tool_use`, `tool_result` 같은 `text` 이외의 모든 타입 — 이 있으면 게이트웨이는 업스트림으로 아무것도 보내기 전에 `400`을 돌려줍니다. 초기 버전처럼 그 블록을 조용히 버리지 않습니다. 메시지 `不支持的内容块类型: image（本网关仅支持 text）`의 블록 타입은 실제로 받은 값으로 바뀝니다.

## Gemini 원생 API

### GET /v1beta/models

Gemini 형식의 모델 목록. 파라미터를 받지 않습니다.

**요청**:

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

**응답**:

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

Gemini generateContent 프로토콜, 비스트리밍. 본문의 `systemInstruction`과 `contents`는 업스트림으로 전달하기 전에 messages로 변환됩니다. 모델 이름은 본문이 아니라 경로에 씁니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `contents` | array | 예 | 표준 Gemini contents 배열. |
| `systemInstruction` | object | 아니오 | system 메시지 하나로 변환됩니다. |

**요청**:

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "당신은 친절한 도우미입니다." }] },
    "contents": [{ "role": "user", "parts": [{ "text": "안녕하세요" }] }]
  }'
```

**응답**:

```json
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "안녕하세요" }] },
    "finishReason": "STOP",
    "index": 0
  }],
  "modelVersion": "agnes-2.0-flash",
  "usageMetadata": { "promptTokenCount": 2, "candidatesTokenCount": 3, "totalTokenCount": 5 }
}
```

### POST /v1beta/models/{model}:streamGenerateContent

본문 형태는 `generateContent`와 같고 경로가 `:streamGenerateContent`로 끝납니다. 응답은 `text/event-stream`이고 각 이벤트는 `event:` 필드가 없는 `data:` 줄이며 `[DONE]` 종료 표시가 없습니다 — 스트림이 끝나면 그대로 닫힙니다.

**요청**:

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "안녕하세요" }] }] }'
```

**응답**:

```text
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"안녕하세요"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}
```

## 이미지와 비디오 API

### POST /v1/images/generations

동기 이미지 생성. 요청과 응답 본문은 업스트림 Agnes API로 그대로 전달·통과됩니다 — 아래 예제는 이 게이트웨이가 정한 형식이 아니라 현재 업스트림 계약을 비춘 것입니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `model` | string | 예 | `agnes-image-2.1-flash` 또는 `agnes-image-2.0-flash`를 씁니다. |
| `prompt` | string | 예 | 업스트림으로 그대로 전달됩니다. |

**요청**:

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "고양이 한 마리" }'
```

**응답**:

```json
{ "created": 1735689600, "data": [{ "url": "https://example.com/generated-image.png" }] }
```

### POST /v1/videos

비디오 생성 작업을 만들고 즉시 돌아옵니다. 작업은 업스트림에서 비동기로 돕니다. 요청 본문은 그대로 전달되고 응답 본문은 그대로 통과됩니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `model` | string | 예 | `agnes-video-v2.0`을 씁니다. |
| `prompt` | string | 예 | 업스트림으로 그대로 전달됩니다. |

**요청**:

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "달리는 고양이" }'
```

> [!WARNING]
> 아래 응답 본문의 형태는 실제 업스트림에서 검증되지 않았습니다: 이 저장소의 테스트 픽스처를 그대로 옮긴 것입니다. 게이트웨이는 응답 본문을 그대로 통과시키며 그 구조에 대해 아무것도 가정하지 않습니다.

**응답**:

```json
{ "id": "task-1", "status": "queued" }
```

### GET /v1/videos/{id}

앞서 만든 비디오 작업을 폴링합니다. 응답 본문은 업스트림에서 그대로 통과됩니다.

**요청**:

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

**응답**:

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```

전달하기 전에 게이트웨이는 작업 식별자의 형태를 검사하고 **`A-Za-z0-9_- (1-128)`만 받습니다**: 앞부분은 허용되는 문자 집합이고 괄호 안은 길이의 하한과 상한입니다. 맞지 않으면 모두 400이며 **업스트림 요청은 한 번도 나가지 않습니다**. 그 400 메시지는 이 형태를 글자 그대로 싣고 있으니 그대로 맞춰 식별자를 다시 붙여 넣으면 됩니다.

> [!WARNING]
> 작업 식별자 형태 판정은 실제 업스트림에서 검증되지 않았습니다: 문자 집합과 길이 상한은 이 저장소 테스트 픽스처의 식별자에서 **외삽**한 것이지 그대로 옮긴 것이 아닙니다. 업스트림이 정말 다른 형태를 발급하면 게이트웨이가 먼저 400을 돌려주고 업스트림으로 넘기지 않습니다 — 그때는 요청 파라미터를 바꿔도 소용이 없고 게이트웨이를 고쳐야 합니다.

## 관리 API

`/admin` 관리 패널(정적 자원은 빌드 시점에 내장)은 `/admin/api/*` 계열 인터페이스로 돕니다. 이들은 네 프로토콜 엔드포인트와 **완전히 분리**되어 있습니다: `x-admin-key` 헤더만 읽고 `ADMIN_TOKEN`만 받으며, `Authorization: Bearer`도 `?key=`도 받지 않습니다(토큰이 URL에 들어가면 브라우저 기록, `Referer`, 각 계층의 접근 로그에 남습니다).

`ADMIN_TOKEN`이 없거나 단단한 규칙(앞뒤 공백, 인쇄 불가능한 ASCII, 24자 미만)을 만족하지 않으면 **`/admin` 트리 전체가 등록되지 않습니다** — 접근하면 `401`이 아니라 `404`가 되어 "여기 관리 화면이 있다"는 사실 자체를 흘리지 않습니다.

> [!WARNING]
> 관리 인터페이스 응답은 풀에 있는 key의 평문을 어디서도 되비추지 않고 reveal 엔드포인트도 없습니다. 하지만 `ADMIN_TOKEN`을 쥔 사람은 풀 전체를 비우고, `GATEWAY_TOKEN`을 바꾸고, 레지스트라를 켤 수 있습니다 — **중계 토큰보다 더 무거운 열쇠로 다루세요**.

### GET /admin/api/session

로그인 프로브. 패널은 이것으로 "이 토큰이 쓸 수 있는지"를 확인하며, **설정도 풀 정보도 전혀 돌려주지 않습니다**.

**요청**:

```bash
curl http://localhost:8080/admin/api/session \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```json
{ "ok": true, "version": "0.1.0" }
```

### GET /admin/api/capabilities

이중 런타임 차이의 **유일한 출구**: 패널이 시작할 때 한 번 부르고, 형태에 따라 갈라지는 모든 분기가 이것을 읽습니다. 스토리지 접근은 0입니다.

**요청**:

```bash
curl http://localhost:8080/admin/api/capabilities \
  -H "x-admin-key: your-admin-token"
```

**응답**:

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

개요 페이지의 한 번치 조회: 버전, 서버 시계, 런타임, 스토리지 건강도, 풀 건강도, 그리고 Tier-1 풀 집계.

> [!NOTE]
> `poolStats`는 **근사값**입니다(`approximate: true`): 동시 요청에서는 적게 세고, 디스크에는 최대 `POOL_TOUCH_INTERVAL_MS` 한 주기만큼 늦게 내려갑니다. 패널은 이 근사 표시를 반드시 그려야 하며 조용히 정확한 값처럼 다루면 안 됩니다.

**요청**:

```bash
curl http://localhost:8080/admin/api/overview \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```json
{
  "version": "0.1.0",
  "serverTime": 1735689600000,
  "runtime": { "name": "node" },
  "storage": { "backend": "file", "writable": true, "checkedAt": 1735689600000 },
  "pool": { "total": 3, "fresh": 2, "cooling": 1, "evicted": 0, "disabled": 0 },
  "poolStats": { "requests": 42, "success": 40, "failed": 2, "clientErrors": 0, "approximate": true }
}
```

### GET /admin/api/models

네 프로토콜 × 모델의 정적 카탈로그. **스토리지 읽기 0**이며 전부 모듈 수준 상수에서 옵니다 — 연동 스니펫 카드, 플레이그라운드, 모델 표 세 곳이 여기서 가져오므로 엔드포인트 경로가 프런트엔드에 하나도 박혀 있지 않습니다.

**요청**:

```bash
curl http://localhost:8080/admin/api/models \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```json
{
  "protocols": [{ "id": "openai", "label": "OpenAI Chat Completions", "method": "POST", "pathTemplate": "/v1/chat/completions", "upstreamPath": "/chat/completions" }],
  "media": [{ "id": "image.generate", "method": "POST", "pathTemplate": "/v1/images/generations" }],
  "models": [{ "id": "agnes-2.0-flash", "modality": "chat" }],
  "samplePrompt": "ping"
}
```

### GET /admin/api/keys

Key 풀의 읽기 전용 목록이며 필터와 페이지네이션이 있습니다. **투영에는 평문 key가 절대 들어가지 않습니다.**

**요청 본문**: 이 엔드포인트는 쿼리 파라미터만 받고 본문은 받지 않습니다.

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `q` | string | 아니오 | 흐린 일치(메모, id 조각 등). |
| `bucket` | string | 아니오 | 버킷으로 거르기; 올바른 값이 아니면 통째로 무시됩니다. |
| `page` | number | 아니오 | 1부터 세는 페이지 번호. 범위를 벗어나면 1로 돌아갑니다. |
| `size` | number | 아니오 | 한 페이지 개수. 기본 20, 최대 200. |

**요청**:

```bash
curl "http://localhost:8080/admin/api/keys?bucket=fresh&page=1&size=20" \
  -H "x-admin-key: your-admin-token"
```

**응답**:

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
> `counts`는 **언제나 풀 전체로 계산**되며 이번 필터의 영향을 받지 않습니다: 필터 옆의 숫자는 "그쪽으로 바꾸면 몇 개가 보이는가"를 뜻합니다. 거른 집합으로 계산하면 지금 버킷은 자기 개수와 같아지고 나머지 셋은 전부 0이 되어 버립니다.

### POST /admin/api/keys

key 일괄 가져오기. 돌아오는 세 배열은 각각 id, id, 그리고 **입력 안의 위치**(1부터)이며 평문은 하나도 없습니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `keys` | array | 예 | 문자열 배열; 원소 타입이 틀리면 요청 전체가 `400`이고 `invalid`에는 들어가지 않습니다. |
| `resetExisting` | boolean | 아니오 | 켜면 이미 있던 key의 쿨다운·strikes·제거 표시를 지웁니다. 기본값은 `false`. |

**요청**:

```bash
curl -X POST http://localhost:8080/admin/api/keys \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "keys": ["sk-aaa", "sk-bbb"], "resetExisting": false }'
```

**응답**:

```json
{ "added": ["9f2c…"], "duplicated": ["3b71…"], "invalid": [2], "reset": 0 }
```

> [!IMPORTANT]
> `reset`과 `duplicated.length`는 **같은 수가 아닙니다**: 이번 배치에서 새로 만들어진 key를 두 번 붙여 넣어도 중복으로 세지만, 그것이 초기화된 것은 아닙니다. 패널이 보여야 할 것은 `reset`이며 `duplicated.length`를 보이는 것은 거짓말입니다.

### POST /admin/api/keys/bulk

일괄 작업이며 항목별 결과를 돌려줍니다. **동작은 셋뿐**이고 일괄 바의 버튼 셋과 하나씩 짝을 이룹니다. "일괄 활성화"도 "일괄 제거 해제"도 없습니다 — 그것들은 "더 많은 key를 다시 무대에 올리는" 동작이고, 하나씩 누르는 편이 한 번에 전부 누르는 것보다 안전하기 때문입니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `op` | string | 예 | `disable` / `clearCooldown` / `delete` 중 하나. |
| `ids` | array | 예 | 문자열 배열, 한 번에 최대 200개. |

**요청**:

```bash
curl -X POST http://localhost:8080/admin/api/keys/bulk \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "op": "clearCooldown", "ids": ["9f2c…", "3b71…"] }'
```

**응답**:

```json
{ "results": [{ "id": "9f2c…", "ok": true, "reason": null }, { "id": "3b71…", "ok": false, "reason": "not_found" }] }
```

### PATCH /admin/api/keys/{id}

key 하나를 바꿉니다: 비활성화/활성화, 메모, 쿨다운 해제, strikes 지우기, 제거 해제, 사용량 카운터 초기화.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `disabled` | boolean | 아니오 | 이 key를 비활성화하거나 활성화합니다. |
| `note` | string | 아니오 | 메모. |
| `clearCooldown` | boolean | 아니오 | 상태가 아니라 동작입니다: `false`를 보내는 것은 안 보내는 것과 같습니다. |
| `clearStrikes` | boolean | 아니오 | 상태가 아니라 동작입니다: `false`를 보내는 것은 안 보내는 것과 같습니다. |
| `unevict` | boolean | 아니오 | 상태가 아니라 동작입니다: `false`를 보내는 것은 안 보내는 것과 같습니다. |
| `clearStats` | boolean | 아니오 | 상태가 아니라 동작입니다: `false`를 보내는 것은 안 보내는 것과 같습니다. |

**요청**:

```bash
curl -X PATCH http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "disabled": false, "clearCooldown": true }'
```

**응답**:

```json
{ "ok": true }
```

### DELETE /admin/api/keys/{id}

key 하나를 지웁니다. 성공은 `204`이고 본문이 없습니다.

> [!WARNING]
> 삭제는 **되돌릴 수 없습니다**: 레코드 안의 key 재료는 거기서 사라지고 어디에도 남지 않습니다. 그래서 이것은 전제 조건을 가진 유일한 쓰기입니다 — **비활성화하지 않은 key는 지울 수 없고** `409`와 최상위 `reason: "must_disable_first"`가 돌아옵니다.

**요청**:

```bash
curl -X DELETE http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```json
{ "error": { "type": "conflict", "code": "must_disable_first", "message": "请先停用这把 key 再删除（删除不可撤销，而停用随时可以撤销）" }, "reason": "must_disable_first" }
```

### POST /admin/api/keys/purge

Key 풀 전체를 비웁니다. 위험 구역의 두 버튼 중 하나입니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `expect` | number | 예 | 화면에서 본 풀 크기, 0 이상의 정수; 어긋나면 `409`이고 하나도 지우지 않습니다. |

**요청**:

```bash
curl -X POST http://localhost:8080/admin/api/keys/purge \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "expect": 3 }'
```

**응답**:

```json
{ "deleted": 3, "remaining": 0, "expected": 3 }
```

> [!CAUTION]
> 각 key의 사용 이력은 그 레코드 **안에** 살고 있어서, 레코드를 지우는 것이 곧 이력을 지우는 것이며 두 번째 사본은 없습니다. `remaining`은 상수 `0`이 아니라 **되읽은** 값입니다 — "인덱스는 비었다는데 스토리지에는 레코드가 남아 있다"는 상황도 이것이 정직하게 알려 줍니다.

### GET /admin/api/keys/{id}/usage

단일 key의 Tier-1 카운터. **Tier-2와는 전혀 무관**하며 Tier-2가 꺼져 있어도 쓸 수 있습니다.

**요청**:

```bash
curl http://localhost:8080/admin/api/keys/9f2c/usage \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```json
{
  "id": "9f2c",
  "stats": { "requests": 12, "success": 11, "failed": 1, "clientErrors": 0 },
  "approximate": true,
  "generatedAt": 1735689600000
}
```

### POST /admin/api/keys/{id}/verify

단일 key 확인: 그 key로 업스트림에 최소한의 요청을 한 번 보내고 **상태 코드만 돌려주며 본문은 돌려주지 않습니다**.

**요청 본문**: 이 엔드포인트는 **어떤 옵션도 받지 않습니다**. 빈 본문은 통과하고 필드가 있으면 전부 `400`입니다 — `{"model":"…"}` 같은 "모델을 고를 수 있는 줄 알았다"는 표기는 느슨한 구현에서 조용한 오조작이 되기 때문입니다.

**요청**:

```bash
curl -X POST http://localhost:8080/admin/api/keys/9f2c/verify \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```json
{ "ok": true, "status": 200, "latencyMs": 412, "reason": null }
```

> [!NOTE]
> 이 엔드포인트는 `verify:<id>` 단위로 아웃바운드 프로브 가드 뒤에 있습니다: 같은 key를 연달아 누르면 최상위 `reason`이 붙은 `429`가 되지만 다른 key 확인은 영향을 받지 않습니다. 스토리지 쓰기는 한 번도 일어나지 않습니다.

### GET /admin/api/events

이벤트 구역의 조회. 병합 결과는 `ts` 내림차순입니다.

**요청 본문**: 이 엔드포인트는 쿼리 파라미터만 받고 본문은 받지 않습니다.

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `after` | number | 아니오 | 커서. 이보다 새로운 항목만. |
| `level` | string | 아니오 | 레벨로 거르기; 올바른 값이 아니면 통째로 무시됩니다. |
| `limit` | number | 아니오 | 이 페이지의 개수. 기본 50, 최대 200. |

**요청**:

```bash
curl "http://localhost:8080/admin/api/events?level=warn&limit=50" \
  -H "x-admin-key: your-admin-token"
```

**응답**:

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
> `cursor`의 합법한 값은 딱 둘입니다: **유한한 숫자, 또는 `null`**. 절대 "필드가 없음"이 되지 않습니다 — 그러면 프런트엔드가 "새 이벤트가 없다"와 "백엔드 계약이 깨졌다"를 같은 것으로 읽게 됩니다.

### GET /admin/api/events/download

병합 결과를 통째로 내려받습니다. 돌아오는 것은 `text/plain`이며 **한 줄에 JSON 하나**(JSON 배열이 아닙니다): 이것은 터미널에서 `grep`하기 위한 형식이지 프로그램이 역직렬화하기 위한 API가 아닙니다.

**요청**:

```bash
curl -OJ http://localhost:8080/admin/api/events/download \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```text
{"ts":1735689600000,"level":"warn","event":"key.restored","msg":"面板解除了一把 key 上的限制"}
{"ts":1735689500000,"level":"info","event":"key.added","msg":"面板导入了新的 key"}
```

### GET /admin/api/config

지금 유효한 설정을 읽습니다. 자격 증명 필드는 "설정되었는지"만 알려 주고 값은 알려 주지 않습니다.

**요청**:

```bash
curl http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```json
{
  "fields": { "upstreamTimeoutMs": { "value": 120000, "source": "default" } },
  "credentials": { "gatewayToken": { "configured": true, "source": "env" } },
  "configDegraded": false,
  "loadBlocked": [],
  "editable": ["upstreamTimeoutMs"],
  "secrets": ["gatewayToken"]
}
```

### PUT /admin/api/config

설정을 씁니다. 순서는 **검증 → 쓰기 → 캐시 무효화 → 되읽기**이며 하나도 바꿔 끼울 수 없습니다: 먼저 쓰고 나중에 검증하면 잘못된 설정이 이미 디스크에 올라간 채로 응답만 `400`이 됩니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `patch` | object | 예 | 바꾸려는 경로만 싣습니다; 모르는 최상위 필드는 모두 `400`. |

**요청**:

```bash
curl -X PUT http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**응답**:

```json
{
  "fields": { "upstreamTimeoutMs": { "value": 90000, "source": "stored" } },
  "credentials": { "gatewayToken": { "configured": true, "source": "env" } },
  "configDegraded": false,
  "loadBlocked": [],
  "changed": ["upstreamTimeoutMs"],
  "credentialsChanged": []
}
```

> [!IMPORTANT]
> 자격 증명 필드의 빈 문자열은 언제나 "바꾸지 않음"이지 **"지움"이 아닙니다**. 지우는 길은 `POST /admin/api/config/secrets/clear` 하나뿐입니다 — 빈 문자열을 지움으로 구현하면 운영자가 설정 페이지를 한 번 저장하는 것만으로 `gatewayToken`이 사라지고, 게다가 살아 있는 인스턴스에는 아무 징후도 나타나지 않습니다.

### POST /admin/api/config/validate

한 바이트도 쓰지 않는 검증 드라이런. 같은 입력에 대해 실제 쓰기와 같은 오류 코드를 냅니다.

**요청 본문**: `PUT /admin/api/config`와 글자 그대로 같습니다(`patch` 객체 하나).

**요청**:

```bash
curl -X POST http://localhost:8080/admin/api/config/validate \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**응답**:

```json
{ "ok": true, "changed": ["upstreamTimeoutMs"] }
```

### POST /admin/api/config/secrets/clear

자격 증명 하나를 명시적으로 지웁니다. **자격 증명을 지우는 유일한 입구입니다.**

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `path` | string | 예 | 자격 증명 필드 중 하나; 다른 경로는 모두 `400`. |

**요청**:

```bash
curl -X POST http://localhost:8080/admin/api/config/secrets/clear \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "path": "gatewayToken" }'
```

**응답**:

```json
{
  "cleared": "gatewayToken",
  "stillConfigured": true,
  "gatewayTokenMissing": false,
  "loadBlocked": [],
  "fields": { "upstreamTimeoutMs": { "value": 90000, "source": "stored" } },
  "credentials": { "gatewayToken": { "configured": true, "source": "env" } },
  "configDegraded": false
}
```

### POST /admin/api/config/reset

스토리지에 있는 설정을 통째로 `{}`로 되돌립니다. 위험 구역 두 버튼의 나머지 하나입니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `confirm` | boolean | 예 | 반드시 명시적으로 `true`여야 합니다. 이 단계는 되돌릴 수 없습니다. |

**요청**:

```bash
curl -X POST http://localhost:8080/admin/api/config/reset \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "confirm": true }'
```

**응답**:

```json
{
  "fields": { "upstreamTimeoutMs": { "value": 120000, "source": "default" } },
  "credentials": { "gatewayToken": { "configured": true, "source": "env" } },
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
> `appliedAt`은 **"이미 적용되었다"는 약속이 아니라** 서버가 저장한 그 순간입니다. 다른 복제본이나 다른 isolate가 언제 보게 되는지는 `propagation`의 세 숫자가 말합니다 — 패널은 이것을 "초기화되어 적용됨"으로 그리면 안 됩니다.

### POST /admin/api/registrar/tend

보충을 손으로 한 바퀴 돌립니다. 성공은 `200`이 아니라 `202`(시작함)입니다.

**요청 본문**:

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `channel` | string | 아니오 | `moemail` 또는 `yyds`만; 빼면 설정의 주/대체 채널 사슬을 따릅니다. |

**요청**:

```bash
curl -X POST http://localhost:8080/admin/api/registrar/tend \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "channel": "moemail" }'
```

**응답**:

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
> `remaining`은 성공 분기에서도 돌려줍니다: 다 썼을 때만 주는 것은 운영자를 아무것도 모르는 채로 벽에 부딪히게 하는 것과 같습니다. 레지스트라가 꺼져 있으면 `reason`이 붙은 `409`, 채널에 자격 증명이 없어도 `409`입니다 — **그것은 "이 라우트가 없다"가 아닙니다**.

### GET /admin/api/registrar/status

보충 구역의 조회: 레지스트라가 켜져 있는지, 두 채널 각각의 연결 상태, 가드가 몇 번 남았는지, 보충 이력.

> [!IMPORTANT]
> 여기 필드는 `available`이 **아니라** `counted`입니다: 판정 기준이 "목표 수에 센다"여서 비활성화된 key와 쿨다운 중인 key가 모두 들어가는데, 그 둘은 업스트림과 말을 섞을 수 없습니다. 진짜 쓸 수 있는 수는 옆에 나란히 있는 `fresh`입니다.

**요청**:

```bash
curl http://localhost:8080/admin/api/registrar/status \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```json
{
  "serverTime": 1735689600000,
  "enabled": true,
  "primary": "moemail",
  "fallback": "yyds",
  "counted": 3,
  "fresh": 2
}
```

### POST /admin/api/registrar/channels/{channel}/test

채널 연결 테스트: 메일 서비스로 읽기 전용 GET을 한 번 보냅니다. 메일함도 만들지 않고 key도 받지 않습니다.

**요청 본문**: 이 엔드포인트는 본문을 받지 않으며 채널 이름은 경로에 씁니다(`moemail` 또는 `yyds`만).

**요청**:

```bash
curl -X POST http://localhost:8080/admin/api/registrar/channels/moemail/test \
  -H "x-admin-key: your-admin-token"
```

**응답**:

```json
{ "ok": true, "channel": "moemail", "domains": ["example.test"], "latencyMs": 128 }
```

### GET /admin/api/usage

Tier-2 사용량의 구간 집계. 날짜는 언제나 UTC이며 **응답 안에서 그렇다고 말합니다**.

**요청 본문**: 이 엔드포인트는 쿼리 파라미터만 받고 본문은 받지 않습니다.

| 파라미터 | 타입 | 필수 | 설명 |
|--------|----|----|----|
| `from` | string | 아니오 | 구간 시작; 파싱되지 않으면 Tier-2가 켜져 있든 아니든 `400`. |
| `to` | string | 아니오 | 구간 끝; 보존 기간을 넘는 부분은 잘리고 `note`에서 설명합니다. |

**요청**:

```bash
curl "http://localhost:8080/admin/api/usage?from=2026-08-01&to=2026-08-30" \
  -H "x-admin-key: your-admin-token"
```

**응답**:

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
> Tier-2가 꺼져 있어도 이 엔드포인트는 **평소대로 200을 돌려주고** 정직하게 `tier: "off"`라고 말합니다 — `503`을 돌려주면 패널이 "운영자가 통계를 켜지 않았다"를 "백엔드가 망가졌다"로 그리게 됩니다. "읽지 못했다", "시계가 망가졌다", "그날은 보존 기간 밖이다"는 각자 다른 `note`를 가지며 같은 "데이터가 없다"로 뭉뚱그리면 안 됩니다.

### GET /admin/api/usage/{date}

하루치 사용량 상세: 시간별, 모델별, 프로토콜별 세 조각.

**요청 본문**: 이 엔드포인트는 본문을 받지 않으며 날짜는 경로에 쓰고 UTC의 `YYYY-MM-DD`가 아니면 `400`입니다.

**요청**:

```bash
curl http://localhost:8080/admin/api/usage/2026-08-30 \
  -H "x-admin-key: your-admin-token"
```

**응답**:

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

## 시스템 API

### GET /health

헬스 체크(Docker 프로브에 맞춘 형태). **인증이 필요 없으며**, 그래서 낮은 수준의 오류 상세도 전혀 되비추지 않습니다.

**요청**:

```bash
curl http://localhost:8080/health
```

**응답**:

```json
{ "status": "ok", "version": "0.1.0", "storage": { "writable": true } }
```

`storage.writable`은 "key 풀이 올라가 있는 스토리지에 정말 쓸 수 있는가"를 알려 줍니다. 시작할 때의 한 번의 프로브와 실행 중의 모든 실제 쓰기가 함께 유지하며, 헬스 체크 자신은 쓰지 않습니다. 쓸 수 없을 때는 **HTTP `503`**을 돌려주고 `status`가 `degraded`가 되며 `detail` 한 문장이 붙습니다(Docker에서는 바인드 마운트한 호스트 디렉터리 소유자와 컨테이너 안의 실행 사용자가 다른 경우가 많으며 자세한 내용은 컨테이너 로그에 있습니다).

> [!NOTE]
> 이미지에 내장된 `HEALTHCHECK`는 응답이 성공했는지만 보고 판정하므로 그런 컨테이너는 Docker가 unhealthy로 표시합니다. 근본 오류는 컨테이너 로그에만 쓰이고 이 인증 없는 엔드포인트에는 되비추지 않습니다.

## 요청 예제

base URL에는 **표준 베어 접두사**를 씁니다: OpenAI = `{host}/v1`, Anthropic = `{host}`(SDK가 `/v1/messages`를 스스로 붙입니다), Gemini = `{host}/v1beta`.

### Python - OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-gateway-token",
    base_url="http://localhost:8080/v1"
)

# 비스트리밍 요청
response = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.choices[0].message.content)

# 스트리밍 요청
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
# 비스트리밍 요청
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 스트리밍 요청
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## 다음 단계

- 사용법과 네 프로토콜의 SDK 연동: [USAGE.md](USAGE.md)
- 두 배포 형태와 모든 환경 변수: [DEPLOY.md](DEPLOY.md)
- 웹 관리 패널: [ADMIN.md](ADMIN.md)
- 레지스트라(자동 풀 보충): [REGISTRAR.md](REGISTRAR.md)
