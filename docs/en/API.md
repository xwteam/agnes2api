# API Reference

**Language:** English | [简体中文](../zh-CN/API.md) | [繁體中文](../zh-TW/API.md) | [日本語](../ja/API.md) | [한국어](../ko/API.md)

All examples use `http://localhost:8080` (the Docker/Node listen address). Replace it with
your Worker's `*.workers.dev` URL (or custom domain) when running on Cloudflare.

`your-gateway-token` is a placeholder for the value you set as `GATEWAY_TOKEN`.

## Authentication

Every route under `/v1/*` and `/v1beta/*` requires a credential. `/health` does not. Any one
of the following four forms is accepted — this matches what each protocol's official SDK
sends by default, so you normally don't configure anything special:

| Form | Example |
|----|-------|
| `Authorization: Bearer` header | `Authorization: Bearer your-gateway-token` |
| `x-api-key` header | `x-api-key: your-gateway-token` |
| `x-goog-api-key` header | `x-goog-api-key: your-gateway-token` |
| `key` query parameter | `?key=your-gateway-token` |

A missing or wrong credential returns `401`:

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

(The message text is currently only in Chinese regardless of which language doc you're
reading — the gateway itself does not localize error strings yet.)

## Models

Four models are exposed. Which one you should pass depends on which endpoint you're calling:

| Model | Used for |
|-----|--------|
| `agnes-2.0-flash` | chat/text endpoints |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## Pool-exhaustion errors

If no upstream key is available, the gateway returns `503` before ever calling upstream:

| `reason` | Self-healing? | Meaning |
|--------|-------------|-------|
| `pool_empty` | – | No key has been imported yet. |
| `all_cooling` | **yes** | Every key is cooling down (rate limit, payment required, or repeated transient failures). A `Retry-After` header gives the earliest recovery time. |
| `all_disabled` | **no** | Every key was **manually disabled** by an administrator in the admin panel. Re-enable them there — **the credentials are fine, do not replace the keys**. |
| `all_evicted` | **no** | Every key was permanently evicted because its credentials are invalid (upstream `401`/`403`). Import new keys. |
| `upstream_error` | **yes** | The keys are fine; the upstream failed on every attempt. |

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
{ "error": { "reason": "all_disabled", "message": "全部 3 把 key 均不可用且不会自动恢复：3 把被管理员手工停用（在管理面板上重新启用即可）" } }
```

## Synchronous-endpoint timeout (`504`)

Image generation, video job creation and **every non-streaming chat request** (all four
protocols) run on the synchronous budget `UPSTREAM_SYNC_TIMEOUT_MS` (default 120000 ms, see the
[deployment guide](DEPLOY.md#environment-variables)). When every key tried within that total
budget failed to answer, the gateway returns `504`:

| `reason` | Meaning |
|--------|-------|
| `upstream_timeout` | The request used up the whole `UPSTREAM_SYNC_TIMEOUT_MS` budget and none of the keys it tried answered within their attempt budget. Either the upstream is slow / the budget is too small, or the upstream sessions behind those keys are hung. |

```json
{ "error": { "reason": "upstream_timeout", "message": "同步端点用尽了 120000 毫秒的总预算：已尝试 2 把 key，均未在各自的尝试预算内收到上游响应……" } }
```

That total budget is the worst case a client ever waits, regardless of pool size. A `504` means
**no** key was punished; a key is only charged for its timeout when another key succeeded within
the same request.

Every other upstream error status (`400`, `404`, etc.) is passed through unchanged, in the
upstream's own error shape — the gateway does not rewrite it. The two exceptions are upstream
`401`/`403`, whose body is **never** forwarded (it is the most likely place for an upstream API
to echo back a key fragment), and an upstream `200` whose body isn't JSON on a
format-converting route, which becomes a `502`.

Upstream response headers are not forwarded either: only `content-type`, `cache-control` and
`retry-after` survive. Anything else (`set-cookie`, `www-authenticate`, vendor `x-*` headers)
is dropped, since the pool rotates keys per request and those headers describe the upstream
account, not your gateway.

---

## `GET /health`

No auth required.

```bash
curl http://localhost:8080/health
```

```json
{ "status": "ok", "version": "0.1.0", "storage": { "writable": true } }
```

`storage.writable` reports whether the storage holding the key pool is actually writable. It is
maintained by a one-off probe at startup plus every real write at runtime; the health check
itself never writes. When storage is not writable the endpoint answers **HTTP `503`**:

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

The image's built-in `HEALTHCHECK` keys off the response status, so such a container is marked
unhealthy by Docker. The underlying error goes to the container logs only — it is never echoed
on this unauthenticated endpoint.

## `GET /v1/models`

OpenAI-format model list.

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

OpenAI Chat Completions protocol. Non-streaming responses are the upstream's OpenAI-format
JSON, returned unchanged.

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

Set `"stream": true` for a streaming response: `Content-Type: text/event-stream`, standard
OpenAI-style `data: {...}` chunks, terminated by `data: [DONE]`.

⚠️ Whether the final stream chunk carries usage is not verified against the real upstream.
The gateway passes this protocol's streaming bytes through unchanged: it neither parses
nor rewrites them, so a usage chunk from the upstream reaches the client verbatim.

## `POST /v1/messages`

Anthropic Messages protocol. `system` and array-form `content` blocks are flattened before
being forwarded upstream; the response is converted into Anthropic's content-block shape.

If the `content` (or `system`) array contains a block that can't be mapped to the gateway's
internal plain-text format — any non-`text` type, e.g. `image`, `tool_use`, `tool_result` —
the gateway returns `400` before forwarding anything upstream, instead of silently dropping
the block as earlier versions did:

```json
{ "error": { "type": "invalid_request_error", "message": "不支持的内容块类型: image（本网关仅支持 text）" } }
```

The block type in `message` is substituted with whatever value was actually received; the
message text itself is Chinese-only, per the note above.

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "x-api-key: your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

```json
{
  "id": "msg_c1",
  "type": "message",
  "role": "assistant",
  "model": "agnes-2.0-flash",
  "content": [{ "type": "text", "text": "hi" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 3, "output_tokens": 5 }
}
```

With `"stream": true`, the response is `text/event-stream` carrying the standard Anthropic
event sequence: `message_start`, `content_block_start`, one or more `content_block_delta`,
`content_block_stop`, `message_delta`, `message_stop`.

## `POST /v1/responses`

OpenAI-Responses protocol. `instructions` and array-form `input` are converted into messages
before being forwarded upstream; the response is converted into the `output[]` shape.

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "You are a helpful assistant.",
    "input": "hello"
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
    "content": [{ "type": "output_text", "text": "hi", "annotations": [] }]
  }],
  "usage": { "input_tokens": 3, "output_tokens": 5, "total_tokens": 8 }
}
```

With `"stream": true`, the response is `text/event-stream` carrying: `response.created`, one
or more `response.output_text.delta`, `response.completed`.

## `GET /v1beta/models`

Gemini-format model list.

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

Gemini generateContent protocol, non-streaming. `systemInstruction` and `contents` are
converted into messages before being forwarded upstream. The model name goes in the path,
not the body.

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "You are a helpful assistant." }] },
    "contents": [{ "role": "user", "parts": [{ "text": "hello" }] }]
  }'
```

```json
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "hi" }] },
    "finishReason": "STOP",
    "index": 0
  }],
  "modelVersion": "agnes-2.0-flash",
  "usageMetadata": { "promptTokenCount": 2, "candidatesTokenCount": 3, "totalTokenCount": 5 }
}
```

Note: the path is split on the *last* colon, so model names that themselves contain a colon
(e.g. `vendor:agnes-2.0-flash`) are handled correctly.

## `POST /v1beta/models/{model}:streamGenerateContent`

Same request shape as `generateContent`, with the path ending in `:streamGenerateContent`.
The response is `text/event-stream`; each event is an unlabeled `data:` line (no `event:`
field, no `[DONE]` terminator — the stream simply ends):

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "hello" }] }] }'
```

```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}

```

## `POST /v1/images/generations`

Synchronous image generation. The request and response bodies are forwarded to/from the
upstream Agnes API unchanged — the shape below reflects the current upstream contract, not a
format defined by this gateway.

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

Creates a video generation task and returns immediately; the task runs asynchronously
upstream. Body is forwarded unchanged, response body is passed through unchanged.

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "a cat running" }'
```

⚠️ The response body below is not verified against the real upstream — it is copied from
this repo's test fixtures. The gateway passes response bodies through unchanged and
assumes nothing about their structure.

```json
{ "id": "task-1", "status": "queued" }
```

## `GET /v1/videos/{id}`

Polls a previously created video task. Response body is passed through unchanged from
upstream.

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

Before forwarding, the gateway checks the shape of the task identifier and **accepts only
`A-Za-z0-9_- (1-128)`**: the first part is the allowed character set, the parentheses hold
the lower and upper length bounds. Anything else gets a 400, and **no upstream request is
sent at all**. The 400 body carries this exact shape, so you can paste the identifier back
accordingly.

⚠️ The task-identifier shape check is not verified against the real upstream — it is a
character set and length bound **extrapolated** from the identifier in this repo's test
fixtures, not a verbatim copy. If the upstream ever issues a different shape, the gateway
answers 400 instead of forwarding it — and no request parameter you change will help;
the gateway itself has to change.

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```
