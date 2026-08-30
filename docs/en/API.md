# API Reference

This document walks through every protocol endpoint, admin interface and error contract agnes2api exposes.

## Authentication

Every route under `/v1/*` and `/v1beta/*` requires a credential; `/health` does not. Pick any one of the four ways below — each matches what one of the official SDKs sends by default, so usually no extra configuration is needed.

All examples use `http://localhost:8080` (the address Docker/Node listens on). If you deployed to a Cloudflare Worker, swap in your `*.workers.dev` hostname (or your custom domain). `your-gateway-token` is a placeholder for the `GATEWAY_TOKEN` you configured.

### Method 1: Authorization Bearer header

The standard form in the OpenAI and OpenAI-Responses ecosystem; the official `openai` SDK sends only this one:

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

### Method 2: x-api-key header

The standard form in the Anthropic ecosystem; the official `anthropic` SDK sends only this one:

```bash
curl http://localhost:8080/v1/models \
  -H "x-api-key: your-gateway-token"
```

### Method 3: x-goog-api-key header

The standard form in the Gemini ecosystem; the official `google-genai` SDK sends this one once a custom base URL is set:

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

### Method 4: key query parameter

For callers that cannot set headers (browser `EventSource`, some gateway probes), the credential can go into the URL:

```bash
curl "http://localhost:8080/v1beta/models?key=your-gateway-token"
```

### Where the credential comes from

This credential is the `GATEWAY_TOKEN` you set at deploy time. It has nothing to do with the upstream Agnes key pool — not one key in that pool ever leaves the gateway:

```env
# Required: the token downstream clients present to this gateway, unrelated to upstream keys
GATEWAY_TOKEN=replace-with-a-long-random-string
```

A missing or wrong credential returns `401`:

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

> [!IMPORTANT]
> The admin interface `/admin/api/*` accepts **none** of the four ways above. It only reads the `x-admin-key` header and only accepts `ADMIN_TOKEN`. The two keys are strictly separated: the gateway token is handed to every downstream user, so reusing it as the panel password means handing over the whole key pool.

## Standard Bare Paths

Each of the four protocols is mounted on its own standard bare path, so mainstream SDKs need no vendor prefix in `base_url`.

### Bare paths per protocol

**OpenAI format**:

- `POST /v1/chat/completions`
- `GET /v1/models`

**OpenAI-Responses format**:

- `POST /v1/responses`

**Anthropic format**:

- `POST /v1/messages`

**Gemini format**:

- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `GET /v1beta/models`

### The model name inside the path

The two Gemini endpoints carry the model name in the path rather than in the body. The path is **split on the last colon**, so a model name that itself contains a colon (for example `vendor:agnes-2.0-flash`) is still handled correctly.

`GET /v1/models` returns the OpenAI-shaped model list and `GET /v1beta/models` returns the Gemini-shaped view of the same models — one path cannot return both shapes, so pick the one that matches your SDK.

## Error Responses

Errors the gateway itself produces always use the envelope `{ "error": { "type": ..., "message": ... } }`, which all four protocol SDKs can parse. Errors produced upstream are passed through unchanged, keeping the upstream error structure.

### Common status codes

| Status | Meaning |
|------|-------|
| `400` | The request body did not get past the gateway; upstream's own `400` arrives with this code too, but that one is the untouched upstream structure. The four causes are listed under the table. |
| `401` | Missing or wrong gateway credential (protocol endpoints); a wrong `x-admin-key` on the admin interface. The body of an upstream `401` is never forwarded. |
| `404` | The path does not exist; or the `{id}` on an admin endpoint does not exist (`没有这把 key`). |
| `409` | An admin precondition was not met; the body carries a machine-readable `reason` at the top level. The cases are listed under the table. |
| `429` | The outbound-probe guard rejected this attempt; the body carries a top-level `reason`. |
| `502` | On a format-converting route, upstream answered `200` but the body was not JSON. |
| `503` | No usable key in the pool (see below); or the admin interface is unavailable (the two tokens collided, or this deployment never wired a module up). |
| `504` | A synchronous endpoint burned the whole `UPSTREAM_SYNC_TIMEOUT_MS` budget (see the section below). |

> [!NOTE]
> Common causes behind `400` (not an exhaustive list): a non-`text` content block on the Anthropic protocol, a Gemini path with no method name, a malformed video task identifier, an unknown or missing required field on an admin endpoint, a field value out of range (note too long / more than 200 keys in one import / an illegal `op`), a malformed query parameter (`from` / `to` on the usage endpoints). There are six behind `409`: deleting a key that is neither disabled nor evicted, purging while the pool size differs from what you saw, the registrar being off, a channel with no credentials, a tend already in flight (`tend_in_flight`), and the cross-replica short lock being held by someone else (`locked`). `429` comes in two kinds: outbound probes (single-key verification, the channel connectivity test) are **rate limited per identifier** and never block each other; the quota guardrails on a manual tend (minimum interval and daily count) are in the "Four Guardrails" of [REGISTRAR.md](REGISTRAR.md).

### Pool exhaustion (`503`)

If no key in the pool is usable, the gateway returns `503` before any upstream request is made:

| `reason` | Self-healing | Meaning |
|--------|------------|-------|
| `pool_empty` | – | No key has been imported yet. |
| `all_cooling` | **Yes** | Every key is cooling down (rate limits, billing, or accumulated transient failures). The `Retry-After` header gives the earliest recovery time. |
| `all_disabled` | **No** | Every key was **manually disabled** by an administrator in the admin panel. Re-enable them there — **the credentials themselves are fine, do not go replace keys**. |
| `all_evicted` | **No** | Every key was permanently evicted after the credential failed upstream (`401`/`403`). Replace them. |
| `upstream_error` | **Yes** | The keys themselves work, but every upstream attempt failed. |

**Response**:

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
```

### Synchronous-endpoint timeout (`504`)

Image generation, video task creation and **every non-streaming chat call** (all four protocols) run on the synchronous budget `UPSTREAM_SYNC_TIMEOUT_MS` (120000 ms by default, see the [deployment guide](DEPLOY.md#environment-variables)). When none of the keys tried within that budget answered, the gateway returns `504`:

| `reason` | Meaning |
|--------|-------|
| `upstream_timeout` | This request burned the whole `UPSTREAM_SYNC_TIMEOUT_MS` budget and none of the keys tried answered within their own attempt budget. |

**Response**:

```json
{ "error": { "reason": "upstream_timeout", "message": "同步端点用尽了 120000 毫秒的总预算：已尝试 2 把 key，均未在各自的尝试预算内收到上游响应……" } }
```

There are three causes: upstream is slow overall, the budget is too small, or the upstream sessions behind those keys are stuck. That total budget is the client's worst-case wait and does not depend on pool size. On a `504` the gateway punishes **no** key; only when another key in the same request succeeds does the one that timed out get charged.

### What is passed through and what is not

Beyond the cases above, every other upstream status code (`400`, `404` and so on) is passed through verbatim, keeping upstream's own error structure — the gateway does not rewrite it. Two exceptions: the body of an upstream `401`/`403` is **never** forwarded (that is where an upstream API is most likely to echo a key fragment); and on a format-converting route an upstream `200` whose body is not JSON becomes a `502`.

Upstream response headers are not forwarded verbatim either: only `content-type`, `cache-control` and `retry-after` survive. The rest (`set-cookie`, `www-authenticate`, every vendor's `x-*` header) is stripped — the pool may pick a different key on every request, and those headers describe an upstream account rather than your gateway.

## Models

The gateway exposes four models; which endpoint you call decides which one to send:

| Model | Used by |
|-----|-------|
| `agnes-2.0-flash` | The chat/text endpoints |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## OpenAI Compatible API

### GET /v1/models

The OpenAI-shaped model list. Takes no parameters.

**Request**:

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

**Response**:

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

The OpenAI Chat Completions protocol. A non-streaming response is upstream's OpenAI-shaped JSON returned verbatim.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `model` | string | Yes | Use `agnes-2.0-flash`. |
| `messages` | array | Yes | A standard OpenAI message array. |
| `stream` | boolean | No | Send `true` for a streaming response; defaults to `false`. |

**Request**:

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

**Response**:

```json
{
  "id": "c1",
  "choices": [{ "message": { "role": "assistant", "content": "hi" } }]
}
```

Sending `"stream": true` gets you a streaming response: `Content-Type: text/event-stream`, standard OpenAI-style `data: {...}` chunks, terminated by `data: [DONE]`.

> [!WARNING]
> Whether the final stream chunk carries usage is not verified against the real upstream: this gateway passes the streaming bytes of this protocol through untouched, parsing nothing and rewriting nothing. If upstream emits a usage block at the end of the stream, those bytes reach the client as-is.

## OpenAI Responses API

### POST /v1/responses

The OpenAI-Responses protocol. `instructions` and an array-shaped `input` are converted into messages before being forwarded upstream; the response is converted into an `output[]` structure.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `model` | string | Yes | Use `agnes-2.0-flash`. |
| `input` | string / array | Yes | A string, or a standard Responses input array. |
| `instructions` | string | No | Converted into a single system message. |
| `stream` | boolean | No | Send `true` for a streaming response; defaults to `false`. |

**Request**:

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "You are a helpful assistant.",
    "input": "Hello"
  }'
```

**Response**:

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
    "content": [{ "type": "output_text", "text": "Hello", "annotations": [] }]
  }],
  "usage": { "input_tokens": 3, "output_tokens": 5, "total_tokens": 8 }
}
```

With `"stream": true` the response is `text/event-stream` and carries `response.created`, one or more `response.output_text.delta`, then `response.completed`.

## Anthropic Compatible API

### POST /v1/messages

The Anthropic Messages protocol. `system` and an array-shaped `content` are flattened before being forwarded upstream; the response is converted into Anthropic's content-block structure.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `model` | string | Yes | Use `agnes-2.0-flash`. |
| `max_tokens` | number | Yes | Required by the Anthropic protocol itself. |
| `messages` | array | Yes | A standard Anthropic message array. |
| `system` | string / array | No | Flattened into plain text before being forwarded upstream. |
| `stream` | boolean | No | Send `true` for a streaming response; defaults to `false`. |

**Request**:

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "x-api-key: your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

**Response**:

```json
{
  "id": "msg_c1",
  "type": "message",
  "role": "assistant",
  "model": "agnes-2.0-flash",
  "content": [{ "type": "text", "text": "Hello" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 3, "output_tokens": 5 }
}
```

With `"stream": true` the response is `text/event-stream` and carries the standard Anthropic event sequence: `message_start`, `content_block_start`, one or more `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

> [!IMPORTANT]
> If the `content` (or `system`) array contains a block that cannot be mapped to the internal plain-text format — any non-`text` type such as `image`, `tool_use` or `tool_result` — the gateway returns `400` before forwarding anything upstream instead of silently dropping the block the way early versions did. In the message `不支持的内容块类型: image（本网关仅支持 text）` the block type is replaced with whatever was actually received.

## Gemini Native API

### GET /v1beta/models

The Gemini-shaped model list. Takes no parameters.

**Request**:

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

**Response**:

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

The Gemini generateContent protocol, non-streaming. `systemInstruction` and `contents` are converted into messages before being forwarded upstream. The model name lives in the path, not in the body.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `contents` | array | Yes | A standard Gemini contents array. |
| `systemInstruction` | object | No | Converted into a single system message. |

**Request**:

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "You are a helpful assistant." }] },
    "contents": [{ "role": "user", "parts": [{ "text": "Hello" }] }]
  }'
```

**Response**:

```json
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "Hello" }] },
    "finishReason": "STOP",
    "index": 0
  }],
  "modelVersion": "agnes-2.0-flash",
  "usageMetadata": { "promptTokenCount": 2, "candidatesTokenCount": 3, "totalTokenCount": 5 }
}
```

### POST /v1beta/models/{model}:streamGenerateContent

The body has the same shape as `generateContent`; the path ends in `:streamGenerateContent`. The response is `text/event-stream` where every event is a `data:` line with no `event:` field and there is no `[DONE]` terminator — the stream simply closes when it ends.

**Request**:

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "Hello" }] }] }'
```

**Response**:

```text
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}
```

## Images and Videos API

### POST /v1/images/generations

Synchronous image generation. Request and response bodies are forwarded and passed through verbatim from the upstream Agnes API — the example below reflects the current upstream contract, not a format this gateway invented.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `model` | string | Yes | Use `agnes-image-2.1-flash` or `agnes-image-2.0-flash`. |
| `prompt` | string | Yes | Forwarded upstream verbatim. |

**Request**:

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "a cat" }'
```

**Response**:

```json
{ "created": 1735689600, "data": [{ "url": "https://example.com/generated-image.png" }] }
```

### POST /v1/videos

Creates a video generation task and returns immediately; the task runs asynchronously upstream. The request body is forwarded verbatim and the response body is passed through verbatim.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `model` | string | Yes | Use `agnes-video-v2.0`. |
| `prompt` | string | Yes | Forwarded upstream verbatim. |

**Request**:

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "a running cat" }'
```

> [!WARNING]
> The response body below is not verified against the real upstream: it is copied from this repository's test fixture. The gateway passes the response body through verbatim and assumes nothing about its structure.

**Response**:

```json
{ "id": "task-1", "status": "queued" }
```

### GET /v1/videos/{id}

Polls a video task created earlier. The response body is passed through verbatim from upstream.

**Request**:

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

**Response**:

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```

Before forwarding, the gateway checks the shape of the task identifier and **only accepts `A-Za-z0-9_- (1-128)`**: the first part is the allowed character set, the parentheses give the lower and upper length bounds. Anything else is a 400 and **not a single upstream request is made**. That 400 carries this shape verbatim, so you can paste the identifier back exactly as it came.

> [!WARNING]
> The task-identifier shape check is not verified against the real upstream: the character set and the upper length bound are **extrapolated** from the identifier in this repository's test fixture rather than copied from upstream. If upstream really issues another shape, the gateway answers 400 first and never forwards it — at that point changing request parameters does nothing, the gateway has to change.

## Admin API

The `/admin` panel (static assets embedded at build time) is driven by the `/admin/api/*` family. These endpoints are **completely isolated** from the four protocol endpoints: they only read the `x-admin-key` header and only accept `ADMIN_TOKEN`, never `Authorization: Bearer` and never `?key=` (a token in a URL ends up in browser history, `Referer` and every layer of access log).

When `ADMIN_TOKEN` is unset, or fails the hard rules (leading/trailing whitespace, non-printable ASCII, shorter than 24 characters), **the whole `/admin` tree is left unregistered** — visiting it gives `404` rather than `401`, so it does not leak the fact that a panel exists.

> [!WARNING]
> No admin response ever echoes the plaintext of a key in the pool, and there is no reveal endpoint. But whoever holds `ADMIN_TOKEN` can purge the whole pool, change `GATEWAY_TOKEN` and switch the registrar on — **treat it as the more sensitive of the two tokens**.

### GET /admin/api/session

The login probe. The panel uses it to check whether a token works and it returns **no configuration and no pool information**.

**Request**:

```bash
curl http://localhost:8080/admin/api/session \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```json
{ "ok": true, "version": "0.1.0" }
```

### GET /admin/api/capabilities

The **single exit** for dual-runtime differences: the panel calls it once at startup and every form-dependent branch reads it. Zero storage access.

**Request**:

```bash
curl http://localhost:8080/admin/api/capabilities \
  -H "x-admin-key: your-admin-token"
```

**Response**:

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

One fetch for the overview page: version, server clock, runtime, process metrics, storage health, pool health, the Tier-1 pool-level aggregate, the two freshness lines and the configuration summary.

> [!NOTE]
> `poolStats` is **approximate** (`approximate: true`): concurrent requests undercount it and it lands on disk at most one `POOL_TOUCH_INTERVAL_MS` late. The panel has to render that approximation marker rather than quietly treating it as exact.

**Request**:

```bash
curl http://localhost:8080/admin/api/overview \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```json
{
  "version": "0.1.0",
  "serverTime": 1735689600000,
  "runtime": { "name": "node" },
  "process": { "pid": 1, "rssBytes": 52428800, "uptimeMs": 3600000 },
  "storage": { "backend": "file", "writable": true, "checkedAt": 1735689600000 },
  "pool": { "total": 3, "fresh": 2, "cooling": 1, "evicted": 0, "disabled": 0 },
  "poolStats": { "requests": 42, "success": 40, "failed": 2, "clientErrors": 0, "approximate": true },
  "freshness": {
    "poolCacheTtlMs": 60000,
    "poolVisibilityUpperBoundMs": 120000,
    "poolTouchIntervalMs": 21600000,
    "configTtlMs": 30000,
    "configVisibilityUpperBoundMs": 90000,
    "kvEdgeCacheMs": 60000
  },
  "config": {
    "registrarEnabled": true,
    "primary": "moemail",
    "fallback": "yyds",
    "targetKeys": 20,
    "envLocked": ["gatewayToken"],
    "degraded": false
  }
}
```

### GET /admin/api/models

The static catalogue of four protocols × models. **Zero storage reads** — everything comes from module-level constants, and the integration-snippet card, the playground and the model table all read it, so not a single endpoint path is hardcoded in the front end.

**Request**:

```bash
curl http://localhost:8080/admin/api/models \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```json
{
  "protocols": [{ "id": "openai", "label": "OpenAI Chat Completions", "method": "POST", "pathTemplate": "/v1/chat/completions", "upstreamPath": "/chat/completions" }],
  "media": [{ "id": "image.generate", "method": "POST", "pathTemplate": "/v1/images/generations" }],
  "models": [{ "id": "agnes-2.0-flash", "modality": "chat" }],
  "samplePrompt": "ping"
}
```

### GET /admin/api/keys

The read-only key-pool listing with filtering and pagination. **The projection never contains a plaintext key.**

**Request body**: this endpoint takes query parameters only, no body.

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `q` | string | No | Fuzzy match (note, id fragment and so on). |
| `bucket` | string | No | Filter by bucket; anything that is not a valid bucket is ignored entirely. |
| `page` | number | No | 1-based page number; out-of-range values fall back to 1. |
| `size` | number | No | Items per page, 20 by default, 200 at most. |

**Request**:

```bash
curl "http://localhost:8080/admin/api/keys?bucket=fresh&page=1&size=20" \
  -H "x-admin-key: your-admin-token"
```

**Response**:

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
> `counts` is **always computed over the whole pool** and is unaffected by the current filter: the numbers next to the filter mean "how many you would see if you switched there". Computing them over the filtered set would make the current bucket equal to its own count and the other three zero.

### POST /admin/api/keys

Bulk key import. The three returned arrays hold ids, ids and **positions in your input** (1-based) respectively — not one entry is plaintext.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `keys` | array | Yes | An array of strings; a wrong element type is a whole-request `400`, not an `invalid` entry. |
| `resetExisting` | boolean | No | When set, clears cooldown, strikes and the eviction mark on keys that already existed; defaults to `false`. |

**Request**:

```bash
curl -X POST http://localhost:8080/admin/api/keys \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "keys": ["sk-aaa", "sk-bbb"], "resetExisting": false }'
```

**Response**:

```json
{ "added": ["9f2c…"], "duplicated": ["3b71…"], "invalid": [2], "reset": 0 }
```

> [!IMPORTANT]
> `reset` and `duplicated.length` are **not the same number**: a key created in this very batch and pasted twice also counts as duplicated, yet nothing about it was reset. The panel has to show `reset`; showing `duplicated.length` would be a lie.

### POST /admin/api/keys/bulk

Bulk operations with per-item results. There are **only three actions**, matching the three buttons on the bulk bar one for one. There is no "bulk enable" and no "bulk un-evict" — those put more keys back on the field, and doing that one key at a time is safer than doing it all at once.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `op` | string | Yes | One of `disable` / `clearCooldown` / `delete`. |
| `ids` | array | Yes | An array of strings, 200 at most per call. |

**Request**:

```bash
curl -X POST http://localhost:8080/admin/api/keys/bulk \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "op": "clearCooldown", "ids": ["9f2c…", "3b71…"] }'
```

**Response**:

```json
{ "results": [{ "id": "9f2c…", "ok": true, "reason": null }, { "id": "3b71…", "ok": false, "reason": "not_found" }] }
```

### PATCH /admin/api/keys/{id}

Change one key: disable/enable, note, clear cooldown, clear strikes, un-evict, reset usage counters.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `disabled` | boolean | No | Disable or enable this key. |
| `note` | string | No | A free-form note. |
| `clearCooldown` | boolean | No | An action, not a state: sending `false` is the same as not sending it. |
| `clearStrikes` | boolean | No | An action, not a state: sending `false` is the same as not sending it. |
| `unevict` | boolean | No | An action, not a state: sending `false` is the same as not sending it. |
| `clearStats` | boolean | No | An action, not a state: sending `false` is the same as not sending it. |

**Request**:

```bash
curl -X PATCH http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "disabled": false, "clearCooldown": true }'
```

**Response**:

```json
{ "ok": true }
```

### DELETE /admin/api/keys/{id}

Deletes one key. Success is `204` with no body.

> [!WARNING]
> Deletion is **irreversible**: the key material in that record is gone and nothing anywhere still holds it. That is why it is the only write with a precondition — **a key can be deleted once it is disabled or has been evicted by the system (upstream 401/403); either one is enough**, and a key that is neither gets a `409` plus a top-level `reason: "must_disable_first"`.

**Request**:

```bash
curl -X DELETE http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```json
{ "error": { "type": "conflict", "code": "must_disable_first", "message": "请先停用这把 key 再删除（删除不可撤销，而停用随时可以撤销）" }, "reason": "must_disable_first" }
```

### POST /admin/api/keys/purge

Empties the whole key pool. One of the two danger-zone buttons.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `expect` | number | Yes | The pool size you saw on screen, a non-negative integer; a mismatch is a `409` with a top-level `reason: "pool_size_changed"` and nothing is deleted. |

**Request**:

```bash
curl -X POST http://localhost:8080/admin/api/keys/purge \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "expect": 3 }'
```

**Response**:

```json
{ "deleted": 3, "remaining": 0, "expected": 3 }
```

> [!WARNING]
> Each key's usage history lives **inside** its record, so deleting the record deletes the history and there is no second copy. `remaining` is **read back** from storage rather than being the constant `0` — which is also how "the index says empty while records are still sitting in storage" gets reported honestly.

### GET /admin/api/keys/{id}/usage

The Tier-1 counters for a single key. **Completely unrelated to Tier-2**: it works even while Tier-2 is off.

**Request**:

```bash
curl http://localhost:8080/admin/api/keys/9f2c/usage \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```json
{
  "id": "9f2c",
  "stats": { "requests": 12, "success": 11, "failed": 1, "clientErrors": 0, "lastErrorAt": 1735689500000, "lastErrorKind": "rate limited" },
  "approximate": true,
  "generatedAt": 1735689600000
}
```

### POST /admin/api/keys/{id}/verify

Verifies one key by sending a minimal request upstream with it and returning **the status code only, never the body**.

**Request body**: this endpoint takes **no options at all**; an empty body is fine and any field is a `400` — a request like `{"model":"…"}` ("I thought I could pick the model") would otherwise be a silent misfire.

**Request**:

```bash
curl -X POST http://localhost:8080/admin/api/keys/9f2c/verify \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```json
{ "ok": true, "status": 200, "latencyMs": 412, "reason": null }
```

> [!NOTE]
> This endpoint sits behind the outbound-probe guard at `verify:<id>` granularity: clicking the same key repeatedly gets a `429` with a top-level `reason`, while verifying a different key is unaffected. It produces zero storage writes.

### GET /admin/api/events

The fetch behind the events section. Merged results are sorted by `ts` descending.

**Request body**: this endpoint takes query parameters only, no body.

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `after` | number | No | Cursor; only entries newer than this. |
| `level` | string | No | Filter by level; anything that is not a valid level is ignored entirely. |
| `limit` | number | No | Items on this page, 200 by default, 500 at most. |

**Request**:

```bash
curl "http://localhost:8080/admin/api/events?level=warn&limit=50" \
  -H "x-admin-key: your-admin-token"
```

**Response**:

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
> `cursor` has exactly two legal values: **a finite number, or `null`**. It is never "field absent" — that would make the front end read "no new events" and "the backend contract is broken" as the same thing.

### GET /admin/api/events/download

Exports the merged result in one go. It returns `text/plain` with **one JSON object per line** (not a JSON array): that is a format for grepping in a terminal, not an API for a program to deserialize.

**Request**:

```bash
curl -OJ http://localhost:8080/admin/api/events/download \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```text
{"ts":1735689600000,"level":"warn","event":"key.restored","msg":"面板解除了一把 key 上的限制"}
{"ts":1735689500000,"level":"info","event":"key.added","msg":"面板导入了新的 key"}
```

### GET /admin/api/config

Reads the configuration currently in effect. Credential fields report only whether they are configured, never their value.

> [!NOTE]
> On a field that was never saved, `stored` is **absent, not `null`**: it carries the raw value out of the stored `config` object, and `undefined` does not survive JSON. The example below is a fresh deployment — compare it with the `PUT` response, where the same field has a `stored` of its own.

**Request**:

```bash
curl http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```json
{
  "fields": { "upstreamTimeoutMs": { "env": null, "effective": 8000, "lockedBy": null } },
  "credentials": { "gatewayToken": { "configured": true, "hint": "3f7a", "lockedBy": "env:GATEWAY_TOKEN" } },
  "configDegraded": false,
  "loadBlocked": [],
  "editable": ["upstreamTimeoutMs"],
  "secrets": ["gatewayToken"],
  "resetBlocked": [],
  "propagation": { "configTtlMs": 30000, "kvEdgeCacheMs": 60000, "visibilityUpperBoundMs": 90000 }
}
```

### PUT /admin/api/config

Writes configuration. The order is **validate → write → invalidate the cache → read back**, and none of it can be swapped: writing before validating would leave an illegal configuration on disk while the response says `400`.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `patch` | object | Yes | Only the paths you want to change; any unknown top-level field is a `400`. |

**Request**:

```bash
curl -X PUT http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**Response**:

```json
{
  "fields": { "upstreamTimeoutMs": { "stored": 90000, "env": null, "effective": 90000, "lockedBy": null } },
  "credentials": { "gatewayToken": { "configured": true, "hint": "3f7a", "lockedBy": "env:GATEWAY_TOKEN" } },
  "configDegraded": false,
  "loadBlocked": [],
  "changed": ["upstreamTimeoutMs"],
  "credentialsChanged": [],
  "appliedAt": 1735689600000,
  "propagation": { "configTtlMs": 30000, "kvEdgeCacheMs": 60000, "visibilityUpperBoundMs": 90000 }
}
```

> [!IMPORTANT]
> An empty string in a credential field always means "leave it alone", **not "clear it"**. Clearing has exactly one route, `POST /admin/api/config/secrets/clear`. Implementing the empty string as a clear would mean an operator wipes `gatewayToken` by saving the settings page once, while hot instances show no symptom at all.

### POST /admin/api/config/validate

A dry run of the validation that writes not a single byte. It produces the same error codes as the real write for the same input.

**Request body**: identical to `PUT /admin/api/config` (a single `patch` object).

**Request**:

```bash
curl -X POST http://localhost:8080/admin/api/config/validate \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**Response**:

```json
{ "ok": true, "changed": ["upstreamTimeoutMs"] }
```

### POST /admin/api/config/secrets/clear

Explicitly clears one credential. **This is the only entrance for clearing a credential.**

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `path` | string | Yes | One of the credential fields; any other path is a `400`. |

**Request**:

```bash
curl -X POST http://localhost:8080/admin/api/config/secrets/clear \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "path": "gatewayToken" }'
```

**Response**:

```json
{
  "cleared": "gatewayToken",
  "stillConfigured": true,
  "gatewayTokenMissing": false,
  "loadBlocked": [],
  "fields": { "upstreamTimeoutMs": { "stored": 90000, "env": null, "effective": 90000, "lockedBy": null } },
  "credentials": { "gatewayToken": { "configured": true, "hint": "3f7a", "lockedBy": "env:GATEWAY_TOKEN" } },
  "configDegraded": false,
  "resetBlocked": [],
  "propagation": { "configTtlMs": 30000, "kvEdgeCacheMs": 60000, "visibilityUpperBoundMs": 90000 }
}
```

### POST /admin/api/config/reset

Writes the stored configuration back to `{}` in one go. The other of the two danger-zone buttons.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `confirm` | boolean | Yes | Must be an explicit `true`; this step cannot be undone. |

**Request**:

```bash
curl -X POST http://localhost:8080/admin/api/config/reset \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "confirm": true }'
```

**Response**:

```json
{
  "fields": { "upstreamTimeoutMs": { "env": null, "effective": 8000, "lockedBy": null } },
  "credentials": { "gatewayToken": { "configured": true, "hint": "3f7a", "lockedBy": "env:GATEWAY_TOKEN" } },
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
> `appliedAt` is **not a promise that the change is live**; it is the moment the server persisted it. How long other replicas and other isolates take to see it is what `propagation` says — the panel must not render it as "reset and in effect".

### POST /admin/api/registrar/tend

Triggers one refill round by hand. Success is `202` (started), not `200`.

**Request body**:

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `channel` | string | No | Either `moemail` or `yyds`; omit it to follow the configured primary/fallback chain. |

**Request**:

```bash
curl -X POST http://localhost:8080/admin/api/registrar/tend \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "channel": "moemail" }'
```

**Response**:

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
> `remaining` is returned on the success branch too: giving it only when the budget is exhausted means an operator walks into a wall with no warning. There are six rejections in all, and **none of them means "this route does not exist"**: `409 registrar_disabled` (the registrar is off), `409 channel_not_configured` (the channel has no credentials), `409 tend_in_flight` (a round is already running on this replica), `409 locked` (another replica holds the short lock), `429 manual_cooldown` (the minimum interval between two manual tends), `429 write_budget_exhausted` (the daily ceiling) — the last two point at the same source of truth as the "Four Guardrails" table in [REGISTRAR.md](REGISTRAR.md).

### GET /admin/api/registrar/status

The fetch behind the refill section: whether the registrar is on, the wiring state of both channels, how many guard slots are left, and the refill history.

> [!IMPORTANT]
> The field here is called `counted`, **not `available`**: its predicate is "counts toward the target", which includes keys that are disabled and keys that are cooling down — and neither of those can talk to upstream. The genuinely usable number is the `fresh` field next to it — **both of them live inside the `pool` object, not at the top level**.

**Request**:

```bash
curl http://localhost:8080/admin/api/registrar/status \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```json
{
  "serverTime": 1735689600000,
  "enabled": true,
  "primary": "moemail",
  "fallback": "yyds",
  "channels": {
    "moemail": { "configured": true, "role": "primary" },
    "yyds": { "configured": true, "role": "fallback" }
  },
  "pool": { "target": 20, "counted": 3, "gap": 17, "fresh": 2, "mintBatch": 5 },
  "lockedUntil": null,
  "manual": {
    "used": 1, "remaining": 23, "perDay": 24, "resetAt": 1735775999999,
    "cooldownUntil": null, "retryAfterMs": null
  },
  "history": {
    "entries": [
      {
        "at": 1735689000000, "trigger": "cron", "primaryChannel": "moemail",
        "skipped": false, "available": 2, "attempted": 1, "minted": 1,
        "mintedByChannel": { "moemail": 1 }, "failures": [], "durationMs": 8421
      }
    ],
    "malformed": 0
  }
}
```

### POST /admin/api/registrar/channels/{channel}/test

A channel connectivity test: one read-only GET to the mailbox service. It creates no mailbox and claims no key.

The `domains` field in the response is **the number of domains probed** (an integer), not a list of them — this endpoint deliberately echoes back no upstream detail.

**Request body**: this endpoint takes no body; the channel name lives in the path (either `moemail` or `yyds`).

**Request**:

```bash
curl -X POST http://localhost:8080/admin/api/registrar/channels/moemail/test \
  -H "x-admin-key: your-admin-token"
```

**Response**:

```json
{ "ok": true, "channel": "moemail", "domains": 3, "latencyMs": 128 }
```

### GET /admin/api/usage

The Tier-2 usage aggregate over a range. Dates are always UTC, and **the response says so**.

Both parameters take **epoch milliseconds as an integer, and nothing else**: a non-integer or a negative value is a `400`, with no well-meaning correction on the server side — a date string such as `2026-08-01` is rejected. **`days` is not a parameter**: it is a preset button on the panel, the server does not know it, and the frontend only ever sends `from` / `to`.

**Request body**: this endpoint takes query parameters only, no body.

| Parameter | Type | Required | Description |
|---------|----|--------|-----------|
| `from` | number | No | Start of the range, **epoch milliseconds as an integer**; defaults to `to - 86400000`. Earlier than the retention start is clamped there, `range.clamped` turns true. |
| `to` | number | No | End of the range, **epoch milliseconds as an integer**; defaults to the server clock. Anything later than now is clamped to now and `range.clamped` turns true. |

**Request**:

```bash
curl "http://localhost:8080/admin/api/usage?from=1735689600000&to=1735775999999" \
  -H "x-admin-key: your-admin-token"
```

**Response**:

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
> While Tier-2 is off this endpoint still answers `200` and honestly says `tier: "off"` — answering `503` would make the panel render "the operator never switched statistics on" as "the backend is broken". "Could not read", "the clock is broken" and "that day is outside the retention window" each get their own `note` and must never be collapsed into one "no data".

### GET /admin/api/usage/{date}

The detail for one day: three slices, by hour, by model and by protocol.

**Request body**: this endpoint takes no body; the date lives in the path and must be a UTC `YYYY-MM-DD`, otherwise `400`. **The convention here deliberately differs from the range endpoint above**: that one takes epoch milliseconds as an integer, this one takes a date string, and the two are not interchangeable.

**Request**:

```bash
curl http://localhost:8080/admin/api/usage/2026-08-30 \
  -H "x-admin-key: your-admin-token"
```

**Response**:

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

## System Endpoints

### GET /health

The health check (shaped for the Docker probe). **No authentication**, which is also why it echoes no low-level error detail.

**Request**:

```bash
curl http://localhost:8080/health
```

**Response**:

```json
{ "status": "ok", "version": "0.1.0", "storage": { "writable": true } }
```

`storage.writable` reports whether the storage holding the key pool really is writable. It is maintained by one probe at startup plus every real write at runtime; the health check itself never writes. When storage is not writable the endpoint returns **HTTP `503`**, `status` becomes `degraded` and a `detail` sentence is attached (on Docker this usually means the bind-mounted host directory is owned by a different user than the one inside the container — see the container log).

> [!NOTE]
> The image's built-in `HEALTHCHECK` decides purely on whether the response succeeded, so such a container is marked unhealthy by Docker. The underlying error only goes to the container log; it is never echoed on this unauthenticated endpoint.

## Request Examples

Use the **standard bare prefixes** for the base URL: OpenAI = `{host}/v1`, Anthropic = `{host}` (the SDK appends `/v1/messages` itself), Gemini = `{host}/v1beta`.

### Python - OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-gateway-token",
    base_url="http://localhost:8080/v1"
)

# Non-streaming request
response = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.choices[0].message.content)

# Streaming request
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
# Non-streaming request
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Streaming request
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## Next Steps

- Usage and SDK wiring for all four protocols: [USAGE.md](USAGE.md)
- Both deployment forms and every environment variable: [DEPLOY.md](DEPLOY.md)
- The web admin panel: [ADMIN.md](ADMIN.md)
- The registrar (automatic pool refill): [REGISTRAR.md](REGISTRAR.md)
