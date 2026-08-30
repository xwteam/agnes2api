# Usage Guide

This page is about the **client side**: pointing each protocol's official SDK at a gateway that is already running, sending the first request, turning streaming on, and knowing which box to look in when a call is rejected. The per-endpoint request / response contracts live in [API.md](API.md); the two ways to get a gateway running live in [DEPLOY.md](DEPLOY.md).

> [!TIP]
> agnes2api implements four protocols on the wire, so you **don't need a special client** —
> point each protocol's official SDK at the gateway's base URL and pass your `GATEWAY_TOKEN` as
> the API key.

## Before you start

### The three things you need

| Thing | Where it comes from |
|-------|---------------------|
| The gateway URL | A Worker's `*.workers.dev` domain, your own domain, or `http://localhost:8080` for Docker |
| The gateway token | The `GATEWAY_TOKEN` you set at deploy time — see the [deployment guide](DEPLOY.md#environment-variables) |
| At least one working upstream key | Imported into the pool from the admin panel — see the [admin panel](ADMIN.md) |

### Placeholders used below

Every example on this page uses these two placeholders. Replace them before copying anything:

| Placeholder | Replace with |
|-------------|--------------|
| `http://localhost:8080` | The URL your gateway actually answers on |
| `your-gateway-token` | Your real `GATEWAY_TOKEN` |

> [!NOTE]
> The gateway does not produce content itself. It forwards your request to the upstream Agnes
> service and translates the response back into whichever protocol you spoke. When the pool
> holds no usable key, every protocol endpoint answers `503` straight away; that family of
> `reason` values is in the last section of this page.

## Credential formats

### Four interchangeable forms

Whichever SDK you use sends its own default header, and the gateway accepts all four of these
interchangeably — no extra configuration needed to make a particular SDK work:

| Form | Sent by |
|------|---------|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` query parameter | Manual/browser-based calls |

Every route under `/v1/*` and `/v1beta/*` needs this credential; `/health` does not.

### The gateway token is not an upstream key

`GATEWAY_TOKEN` is the credential you hand to **downstream users**. It has nothing to do with
the upstream keys in the pool — not one of those ever leaves the gateway.

> [!IMPORTANT]
> The admin API under `/admin/api/*` **does not accept** any of the four forms above. It only
> reads the `x-admin-key` header, and only accepts `ADMIN_TOKEN`. The two keys are strictly
> separated: reusing the gateway token as the panel password hands the entire pool to every
> downstream user.

## Supported models

### What each of the four models is for

| Model | Used by |
|-------|---------|
| `agnes-2.0-flash` | The chat / text endpoints |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

### Whether the model name goes in the body or the path

OpenAI, OpenAI-Responses and Anthropic all carry the model name in the request body's `model`
field. The two Gemini endpoints carry it **in the path** instead. The path is split on its
last colon, so a model name that itself contains a colon is still handled correctly.

`GET /v1/models` returns the model list in OpenAI shape and `GET /v1beta/models` returns the
same models in Gemini shape — one path cannot answer in two formats at once, so pick the one
that matches your SDK.

> [!NOTE]
> Both lists are a **fixed table** of exactly those four models. Neither reflects whether the
> pool currently holds a usable key. To learn that, look at the admin panel, or simply send a
> request and see whether it comes back `503`.

## OpenAI SDK

### A non-streaming call

Point `base_url` at the gateway and then call `chat.completions.create` as usual — every other argument is the same as against OpenAI itself:

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

### A streaming call

Pass `stream=True` and iterate the returned generator — exactly as you would against OpenAI
itself:

```python
stream = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

For this protocol the gateway **passes the streamed bytes through untouched** — it neither
parses nor rewrites them: `Content-Type: text/event-stream`, ordinary OpenAI-style
`data: {...}` chunks, terminated by `data: [DONE]`.

### The base_url does include `/v1`

> [!IMPORTANT]
> This one is the **opposite** of the two SDKs below: the `openai` SDK's `base_url` **does**
> include `/v1`, because it appends `/chat/completions` directly onto it. Leave `/v1` out and
> the SDK will call `/chat/completions`, a path the gateway does not serve, so you get a bare
> `404` rather than anything useful.

## Anthropic SDK

### A non-streaming call

Pass the credential as `api_key`; the SDK puts it into the `x-api-key` header for you, so there is nothing to add by hand:

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

### A streaming call

```python
with client.messages.stream(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "hello"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

The streamed response is the standard Anthropic event sequence: `message_start`,
`content_block_start`, one or more `content_block_delta`, `content_block_stop`,
`message_delta`, `message_stop`.

### The base_url does not include `/v1`

> [!IMPORTANT]
> This SDK's `base_url` does **not** include `/v1` — the SDK appends `/v1/messages` itself.
> Writing `http://localhost:8080/v1` makes it call `/v1/v1/messages`.

> [!WARNING]
> If the `content` (or `system`) array holds any block that is not of type `text` — `image`,
> `tool_use` and `tool_result` all count — the gateway answers `400` **before** forwarding
> anything upstream, rather than silently dropping that block. Multimodal input does not work
> over this protocol today; to generate an image, use `/v1/images/generations`.

## Google GenAI SDK

### A non-streaming call

For this SDK the base URL is changed through `http_options`, not through a positional argument of the constructor:

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

### A streaming call

```python
for chunk in client.models.generate_content_stream(
    model="agnes-2.0-flash",
    contents="hello",
):
    print(chunk.text or "", end="")
```

Each event in the streamed response is a `data:` line with no `event:` field, and there is
**no `[DONE]` sentinel** — the stream simply closes when it ends. If you write your own parser
for this protocol, do not sit waiting for a terminator that never arrives.

### The base_url does not include `/v1beta`

> [!IMPORTANT]
> This SDK's `base_url` likewise does **not** include `/v1beta` — the SDK appends
> `/v1beta/models/...` itself. Once a custom base URL is configured it sends the
> `x-goog-api-key` header by default, which the gateway accepts as-is; nothing else to set up.

## The OpenAI Responses protocol

There is no dedicated SDK for the OpenAI-Responses protocol yet in wide use, so this section
demonstrates it with plain HTTP calls.

### A non-streaming call

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

`instructions` becomes a system message, and an `input` given as an array is converted into
messages before the request goes upstream; the response is converted back into an `output[]`
structure.

### A streaming call

Add a `stream` field, and pass `-N` to curl so it does not buffer — otherwise you will see the whole output only at the very end:

```bash
curl -N -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "hello",
    "stream": true
  }'
```

### The streamed event sequence

| Event | When it shows up |
|-------|------------------|
| `response.created` | The first frame of the stream |
| `response.output_text.delta` | One or more; every content increment arrives here |
| `response.completed` | The last frame of the stream |

## Images and video

### Generating one image

A synchronous endpoint: it does not answer until the upstream service has finished the image, which means this call runs on the synchronous timeout budget described under troubleshooting below.

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "a cat" }'
```

### Creating a video job

Creating the job returns immediately while the video itself finishes asynchronously upstream, so the result has to be picked up by the polling call in the next section:

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "a running cat" }'
```

### Polling the job

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

> [!IMPORTANT]
> The gateway validates the shape of the task id before forwarding anything, and **only
> accepts `A-Za-z0-9_- (1-128)`**: the first part is the permitted character set, the bracket
> holds the lower and upper length bounds. Anything else is a `400`, and **no upstream request
> is made at all** — changing an upstream parameter will not help at that point. The `400`
> carries that shape verbatim, so paste the id back in the form it describes.

## Any OpenAI-compatible client

### Which boxes to fill in

Most third-party clients give you three or four input boxes. Fill them in like this:

| The box in the client | What to put in it |
|-----------------------|-------------------|
| API base URL | `http://localhost:8080/v1` |
| API key | Your `GATEWAY_TOKEN` |
| Model name | `agnes-2.0-flash` |
| Organization / project id | Leave empty; the gateway reads neither field |

### When the client cannot fetch the model list

Some clients call `GET /v1/models` at startup and refuse to send anything until it succeeds.
First confirm the credential goes out at all, using one of the four forms above; if it does
and the list still fails, the client has almost certainly joined `/v1` on twice — drop the
`/v1` from the URL box and try again.

## Conversation context

### The gateway keeps no history

The gateway holds **no conversation state at all**: every request is an independent forward,
and the pool may hand it a different upstream key each time. For a multi-turn conversation the
client keeps the history and resends it in full on every turn — which is exactly what each
protocol's official SDK does by default.

### Where each protocol puts the history

| Protocol | Where the history goes | Where the system prompt goes |
|----------|------------------------|------------------------------|
| OpenAI | The `messages` array | The entry in `messages` whose `role` is system |
| OpenAI-Responses | The `input` array | The `instructions` field |
| Anthropic | The `messages` array | The `system` field |
| Gemini | The `contents` array | The `systemInstruction` field |

## Troubleshooting

### `401` — the credential never arrived

A missing or wrong gateway credential. First confirm you are sending `GATEWAY_TOKEN` and not
an upstream key, then confirm your SDK really sends one of the four forms above. An upstream
`401` response body is **never** forwarded to you — that is the place where an upstream API is
most likely to echo a fragment of a key.

### `404` — the path is wrong

Nine times out of ten the `base_url` has one prefix too many or one too few. The rule differs
per SDK; each of the three sections above has its own "base_url" note.

### `503` — no usable key in the pool

The gateway returns this **before** making any upstream request, with a machine-readable
`reason` at the top level of the body:

| `reason` | Self-healing | What to do |
|----------|--------------|------------|
| `pool_empty` | – | No key has been imported yet; import one from the admin panel. |
| `all_cooling` | **Yes** | Every key is cooling down; the `Retry-After` header gives the earliest recovery time. Wait. |
| `all_disabled` | **No** | Every key was disabled by hand in the panel; re-enable one there — **the credentials are fine, do not go replacing keys**. |
| `all_evicted` | **No** | Every key was evicted for good after its credential stopped working; replace them. |
| `upstream_error` | **Yes** | The keys work but every upstream attempt failed; wait and look again. |

### `504` — a synchronous endpoint ran out of budget

Image generation, video job creation and **every non-streaming chat call** run against the
synchronous timeout budget `UPSTREAM_SYNC_TIMEOUT_MS` (120000 ms by default). That total
budget is the client's worst-case wait, and it has nothing to do with pool size. A `504` does
**not** penalise any key. Either raise the budget or switch to streaming.

### `400` — the body did not get past the gateway

Four causes: a non-`text` content block in the Anthropic protocol, a malformed video task id,
an unrecognised field in an admin request body, and a missing required field in an admin
request body. The first two each have their own note in the sections above.

### `502` — upstream answered 200 with something that is not JSON

This only happens on the routes that have to convert between formats. The gateway cannot
translate a non-JSON body into the protocol shape you asked for, so it reports the truth
instead of fabricating an empty response. Retrying once usually clears it.

## Next Steps

- Endpoints of all four protocols, with request / response shapes: [API.md](API.md)
- Both deployment forms and every environment variable: [DEPLOY.md](DEPLOY.md)
- The web admin panel: [ADMIN.md](ADMIN.md)
- The registrar (automatic pool refill): [REGISTRAR.md](REGISTRAR.md)
