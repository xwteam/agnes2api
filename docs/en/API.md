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
|---|---|
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
|---|---|
| `agnes-2.0-flash` | chat/text endpoints |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## Pool-exhaustion errors

If no upstream key is available, the gateway returns `503` before ever calling upstream:

```json
{ "error": { "reason": "pool_empty", "message": "key 池为空，请先导入 key" } }
```

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 处于冷却或已剔除状态" } }
```

Every other upstream error status (`400`, `404`, etc.) is passed through unchanged, in the
upstream's own error shape — the gateway does not rewrite it.

---

## `GET /health`

No auth required.

```bash
curl http://localhost:8080/health
```

```json
{ "status": "ok", "version": "0.1.0" }
```

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

## `POST /v1/messages`

Anthropic Messages protocol. `system` and array-form `content` blocks are flattened before
being forwarded upstream; the response is converted into Anthropic's content-block shape.

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

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```
