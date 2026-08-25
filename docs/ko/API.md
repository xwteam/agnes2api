# API 레퍼런스

**언어:** [English](../en/API.md) | [简体中文](../zh-CN/API.md) | [繁體中文](../zh-TW/API.md) | [日本語](../ja/API.md) | 한국어

아래 예시는 모두 `http://localhost:8080`(Docker/Node의 리스닝 주소)을
사용합니다. Cloudflare Worker에 배포한 경우 여러분의 `*.workers.dev` 도메인
(또는 커스텀 도메인)으로 바꿔서 사용하세요.

`your-gateway-token`은 여러분이 설정한 `GATEWAY_TOKEN`의 자리표시자입니다.

## 인증

`/v1/*`와 `/v1beta/*` 하위의 모든 경로는 인증 정보가 필요하며, `/health`는
필요하지 않습니다. 아래 네 가지 방식 중 하나면 됩니다 —— 각 프로토콜의 공식
SDK가 기본으로 전송하는 형식과 정확히 일치하므로, 보통 별도 설정이
필요 없습니다.

| 방식 | 예시 |
|---|---|
| `Authorization: Bearer` 헤더 | `Authorization: Bearer your-gateway-token` |
| `x-api-key` 헤더 | `x-api-key: your-gateway-token` |
| `x-goog-api-key` 헤더 | `x-goog-api-key: your-gateway-token` |
| `key` 쿼리 파라미터 | `?key=your-gateway-token` |

인증 정보가 없거나 잘못된 경우 `401`이 반환됩니다.

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

(이 메시지 문자열은 어떤 언어 문서를 보고 있든 현재는 중국어(간체)로만
표시됩니다 —— 게이트웨이 자체가 아직 오류 문자열을 다국어화하지 않았습니다.)

## 모델

게이트웨이는 4개의 모델을 노출합니다. 어떤 값을 전달해야 하는지는 호출하는
엔드포인트에 따라 다릅니다.

| 모델 | 용도 |
|---|---|
| `agnes-2.0-flash` | 대화/텍스트 계열 엔드포인트 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## key 풀 고갈 시 오류

풀에 사용 가능한 key가 없으면 게이트웨이는 업스트림을 호출하기 전에 바로
`503`을 반환합니다.

| `reason` | 자동 복구 | 의미 |
|---|---|---|
| `pool_empty` | – | 아직 key가 등록되지 않음. |
| `all_cooling` | **예** | 모든 key가 쿨다운 중(레이트 리밋·결제 필요·일시적 실패 누적). `Retry-After` 헤더가 가장 이른 복구 시점을 알려줌. |
| `all_disabled` | **아니오** | 모든 key가 관리 패널에서 관리자에 의해 **수동으로 비활성화**됨. 패널에서 다시 활성화하면 됨 — **자격 증명 자체는 정상이므로 key를 교체할 필요 없음**. |
| `all_evicted` | **아니오** | 모든 key가 자격 증명 실효(업스트림 `401`/`403`)로 영구 제거됨. key 교체 필요. |
| `upstream_error` | **예** | key 자체는 정상이나 업스트림이 매번 실패함. |

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
{ "error": { "reason": "all_disabled", "message": "全部 3 把 key 均不可用且不会自动恢复：3 把被管理员手工停用（在管理面板上重新启用即可）" } }
```

## 동기 엔드포인트 타임아웃 (`504`)

이미지 생성, 비디오 작업 생성, 그리고 **모든 비스트리밍 대화**(네 가지 프로토콜 모두)는
동기 타임아웃 예산 `UPSTREAM_SYNC_TIMEOUT_MS`(기본 120000밀리초,
[배포 가이드](DEPLOY.md#환경-변수) 참조)를 사용합니다. 그 총예산 안에서 시도한 모든 key가
응답하지 않으면 `504`를 반환합니다:

| `reason` | 의미 |
|---|---|
| `upstream_timeout` | 이번 요청이 `UPSTREAM_SYNC_TIMEOUT_MS` 총예산을 모두 소진했고, 시도한 key 중 어느 것도 각자의 시도 예산 안에 응답하지 않음. 업스트림이 전반적으로 느리거나 예산이 너무 작을 수도 있고, 해당 key들의 업스트림 세션이 멈춰 있을 수도 있음. |

```json
{ "error": { "reason": "upstream_timeout", "message": "同步端点用尽了 120000 毫秒的总预算：已尝试 2 把 key，均未在各自的尝试预算内收到上游响应……" } }
```

이 총예산이 클라이언트의 최악 대기 시간이며 풀 크기와는 무관합니다. `504`를 받았을 때
게이트웨이는 어떤 key도 처벌하지 않습니다. key에 책임을 묻는 것은 같은 요청 안에서 다른
key가 성공했을 때뿐입니다.

위 경우를 제외한 다른 업스트림 오류 상태 코드(`400`, `404` 등)는 업스트림 자체의
오류 구조를 그대로 유지한 채 변경 없이 전달됩니다. 예외는 두 가지입니다. 업스트림
`401`/`403`의 응답 본문은 **절대** 전달되지 않습니다(업스트림 API가 key 조각을 그대로
되돌려 줄 가능성이 가장 높은 지점이기 때문입니다). 또한 형식 변환 라우트에서 업스트림이
`200`을 반환했지만 본문이 JSON이 아니면 `502`가 됩니다.

업스트림 응답 헤더도 그대로 전달되지 않습니다. `content-type`, `cache-control`,
`retry-after`만 남고 나머지(`set-cookie`, `www-authenticate`, 벤더별 `x-*` 헤더)는
모두 제거됩니다. 풀은 요청마다 key를 바꾸므로 이런 헤더는 여러분의 게이트웨이가 아니라
업스트림 계정을 설명하기 때문입니다.

---

## `GET /health`

인증이 필요 없습니다.

```bash
curl http://localhost:8080/health
```

```json
{ "status": "ok", "version": "0.1.0", "storage": { "writable": true } }
```

`storage.writable`은 "key 풀이 저장되는 스토리지에 실제로 쓸 수 있는지"를 보고합니다.
시작 시 한 번 수행하는 탐지와 런타임의 모든 실제 쓰기로 유지되며, 헬스 체크 자체는
디스크에 쓰지 않습니다. 쓸 수 없을 때는 **HTTP `503`**을 반환합니다:

```json
{
  "status": "degraded",
  "version": "0.1.0",
  "storage": {
    "writable": false,
    "detail": "数据目录不可写，key 池无法持久化。Docker 部署常见于绑定挂载的宿主目录属主与容器内运行用户不一致，详见容器日志"
  }
}
```

이미지에 내장된 `HEALTHCHECK`는 응답의 성공 여부로 판단하므로, 이런 컨테이너는 Docker에서
unhealthy로 표시됩니다. 원인이 되는 예외는 컨테이너 로그에만 남기며, 인증이 필요 없는 이
엔드포인트에는 노출하지 않습니다.

## `GET /v1/models`

OpenAI 형식의 모델 목록입니다.

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

OpenAI Chat Completions 프로토콜입니다. 비스트리밍 응답은 업스트림의 OpenAI
형식 JSON을 그대로 반환한 것입니다.

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

`"stream": true`를 지정하면 스트리밍 응답이 됩니다: `Content-Type:
text/event-stream`, 표준 OpenAI 형식의 `data: {...}` 청크가 이어지며
`data: [DONE]`으로 종료됩니다.

⚠️ 스트림 마지막 청크에 usage가 붙는지는 실제 업스트림에서 검증되지 않았습니다.
게이트웨이는 이 프로토콜의 스트림 바이트를 변경 없이 패스스루하며 파싱도 재작성도
하지 않습니다. 업스트림이 스트림 끝에 usage를 보내면 그 바이트는 그대로 클라이언트에
도달합니다.

## `POST /v1/messages`

Anthropic Messages 프로토콜입니다. 요청의 `system`과 배열 형태의 `content`는
업스트림으로 전달되기 전에 평탄화되며, 응답은 Anthropic의 content block
구조로 변환됩니다.

`content`(또는 `system`) 배열에 내부 일반 텍스트 형식으로 변환할 수 없는 블록——`text`가
아닌 타입, 예: `image`, `tool_use`, `tool_result`——이 포함되어 있으면, 게이트웨이는
업스트림으로 전달하기 전에 `400`을 반환합니다. 이전 버전처럼 해당 블록을 조용히
버리지 않습니다.

```json
{ "error": { "type": "invalid_request_error", "message": "不支持的内容块类型: image（本网关仅支持 text）" } }
```

`message`의 블록 타입은 실제로 받은 값으로 대체됩니다. 메시지 문자열 자체는 위에서
설명한 대로 중국어로만 제공됩니다.

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "x-api-key: your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "max_tokens": 1024,
    "system": "당신은 친절한 어시스턴트입니다.",
    "messages": [{ "role": "user", "content": "안녕하세요" }]
  }'
```

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

`"stream": true`인 경우 응답은 `text/event-stream`이며, 표준 Anthropic 이벤트
순서인 `message_start`, `content_block_start`, 하나 이상의
`content_block_delta`, `content_block_stop`, `message_delta`,
`message_stop`을 포함합니다.

## `POST /v1/responses`

OpenAI-Responses 프로토콜입니다. 요청의 `instructions`와 배열 형태의
`input`은 업스트림으로 전달되기 전에 messages로 변환되며, 응답은 `output[]`
구조로 변환됩니다.

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "당신은 친절한 어시스턴트입니다.",
    "input": "안녕하세요"
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
    "content": [{ "type": "output_text", "text": "안녕하세요", "annotations": [] }]
  }],
  "usage": { "input_tokens": 3, "output_tokens": 5, "total_tokens": 8 }
}
```

`"stream": true`인 경우 응답은 `text/event-stream`이며, `response.created`,
하나 이상의 `response.output_text.delta`, `response.completed`를 포함합니다.

## `GET /v1beta/models`

Gemini 형식의 모델 목록입니다.

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

Gemini generateContent 프로토콜의 비스트리밍 버전입니다. 요청의
`systemInstruction`과 `contents`는 업스트림으로 전달되기 전에 messages로
변환됩니다. 모델명은 요청 본문이 아니라 경로에 포함됩니다.

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "당신은 친절한 어시스턴트입니다." }] },
    "contents": [{ "role": "user", "parts": [{ "text": "안녕하세요" }] }]
  }'
```

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

참고: 경로는 마지막 콜론을 기준으로 분리되므로, 모델명 자체에 콜론이 포함된
경우(예: `vendor:agnes-2.0-flash`)에도 올바르게 처리됩니다.

## `POST /v1beta/models/{model}:streamGenerateContent`

요청 형식은 `generateContent`와 동일하며, 경로 끝이
`:streamGenerateContent`로 끝납니다. 응답은 `text/event-stream`이며, 각
이벤트는 `event:` 필드가 없는 `data:` 라인입니다(`[DONE]` 종료 마커가
없으며, 스트림은 그대로 종료됩니다).

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "안녕하세요" }] }] }'
```

```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"안녕하세요"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}

```

## `POST /v1/images/generations`

동기식 이미지 생성입니다. 요청 본문과 응답 본문은 업스트림 Agnes API와
변경 없이 그대로 전달/패스스루됩니다 —— 아래 예시는 이 게이트웨이가 정의한
형식이 아니라 현재 업스트림의 계약을 반영한 것입니다.

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "a cat" }'
```

```json
{ "created": 1735689600, "data": [{ "url": "https://example.com/generated-image.png" }] }
```

## `POST /v1/videos`

동영상 생성 작업을 생성하고 즉시 응답합니다. 작업은 업스트림에서 비동기로
실행됩니다. 요청 본문은 변경 없이 전달되고, 응답 본문은 변경 없이
패스스루됩니다.

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "a cat running" }'
```

⚠️ 아래 응답 본문의 형태는 실제 업스트림에서 검증되지 않았습니다. 이 저장소의 테스트
픽스처를 그대로 옮긴 것입니다. 게이트웨이는 응답 본문을 변경 없이 패스스루하며 그
구조에 대해 아무것도 가정하지 않습니다.

```json
{ "id": "task-1", "status": "queued" }
```

## `GET /v1/videos/{id}`

이전에 생성한 동영상 작업을 폴링합니다. 응답 본문은 업스트림에서 변경 없이
패스스루됩니다.

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

⚠️ 작업 식별자 형태 판정은 실제 업스트림에서 검증되지 않았습니다. 이 저장소의 테스트
픽스처에 있는 그 식별자에서 **외삽**한 문자 집합과 길이 상한이며, 그대로 옮긴 것이
아닙니다. 업스트림이 다른 형태를 발급하면 게이트웨이는 그것을 업스트림으로 전달하지
않고 400을 돌려줍니다.

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```
