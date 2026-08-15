# API リファレンス

**Language:** [English](../en/API.md) | [简体中文](../zh-CN/API.md) | [繁體中文](../zh-TW/API.md) | 日本語 | [한국어](../ko/API.md)

以下の例はすべて `http://localhost:8080`（Docker/Node のリッスンアドレス）を
使用しています。Cloudflare Worker にデプロイしている場合は、あなたの
`*.workers.dev` ドメイン（またはカスタムドメイン）に置き換えてください。

`your-gateway-token` は、設定した `GATEWAY_TOKEN` のプレースホルダーです。

## 認証

`/v1/*` および `/v1beta/*` 配下のすべてのルートは認証情報を必要とします。
`/health` は不要です。以下の 4 つの形式のいずれか 1 つが受け付けられます——
各プロトコルの公式 SDK が既定で送信する形式にちょうど対応しているため、通常は
特別な設定は不要です。

| 形式 | 例 |
|---|---|
| `Authorization: Bearer` ヘッダー | `Authorization: Bearer your-gateway-token` |
| `x-api-key` ヘッダー | `x-api-key: your-gateway-token` |
| `x-goog-api-key` ヘッダー | `x-goog-api-key: your-gateway-token` |
| `key` クエリパラメータ | `?key=your-gateway-token` |

認証情報が欠けている、または誤っている場合は `401` が返ります。

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

（このメッセージ文字列は現時点でどの言語のドキュメントを読んでいても中国語
（簡体字）のままです——ゲートウェイ自体はまだエラー文字列を多言語化していません。）

## モデル

ゲートウェイは 4 つのモデルを公開しています。どちらを渡すべきかは呼び出す
エンドポイントによって決まります。

| モデル | 用途 |
|---|---|
| `agnes-2.0-flash` | 会話／テキスト系エンドポイント |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## key プール枯渇時のエラー

利用可能な key がプールに存在しない場合、ゲートウェイは上流を呼び出す前に
`503` を返します。

| `reason` | 自動回復 | 意味 |
|---|---|---|
| `pool_empty` | – | key がまだ登録されていない。 |
| `all_cooling` | **する** | すべての key がクールダウン中（レート制限・支払い要求・一時的失敗の累積）。`Retry-After` ヘッダーが最短の復帰時刻を示す。 |
| `all_evicted` | **しない** | すべての key が認証情報の失効（上流 `401`/`403`）により永久排除された。key の入れ替えが必要。 |
| `upstream_error` | **する** | key 自体は有効だが、上流が毎回失敗した。 |

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
```

上記以外の上流エラーステータス（`400`、`404` など）はすべてそのまま
パススルーされ、上流自身のエラー構造が保たれます。例外は二つ。上流の
`401`/`403` のレスポンスボディは**決して**転送されません（上流 API が key の
断片をエコーバックする可能性が最も高い場所であるため）。もう一つは、形式変換を
行うルートで上流が `200` を返したのにボディが JSON でない場合で、これは `502`
になります。

上流のレスポンスヘッダーもそのままは転送されません。残るのは `content-type`、
`cache-control`、`retry-after` のみで、それ以外（`set-cookie`、`www-authenticate`、
各社の `x-*` ヘッダー）はすべて取り除かれます。プールはリクエストごとに key を
切り替えるため、これらは上流アカウントの情報であってこのゲートウェイの情報では
ないからです。

---

## `GET /health`

認証不要です。

```bash
curl http://localhost:8080/health
```

```json
{ "status": "ok", "version": "0.1.0" }
```

## `GET /v1/models`

OpenAI 形式のモデル一覧です。

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

OpenAI Chat Completions プロトコルです。非ストリーミング応答は、上流の
OpenAI 形式 JSON をそのまま返したものです。

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

`"stream": true` を指定するとストリーミング応答になります。
`Content-Type: text/event-stream`、標準的な OpenAI 形式の `data: {...}` チャンクで、
`data: [DONE]` で終端します。

## `POST /v1/messages`

Anthropic Messages プロトコルです。リクエスト内の `system` と配列形式の
`content` は上流へ転送する前にフラット化され、応答は Anthropic の
content block 構造に変換されます。

`content`（または `system`）配列に内部のプレーンテキスト形式へ変換できないブロック——
`text` 以外の型、例えば `image`、`tool_use`、`tool_result`——が含まれている場合、ゲート
ウェイは上流へ転送する前に `400` を返します。以前のバージョンのようにそのブロックを
黙って捨てることはありません。

```json
{ "error": { "type": "invalid_request_error", "message": "不支持的内容块类型: image（本网关仅支持 text）" } }
```

`message` 中のブロック型は実際に受け取った値に置き換わります。メッセージ文字列自体は
前述のとおり中国語のみです。

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "x-api-key: your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "max_tokens": 1024,
    "system": "あなたは親切なアシスタントです。",
    "messages": [{ "role": "user", "content": "こんにちは" }]
  }'
```

```json
{
  "id": "msg_c1",
  "type": "message",
  "role": "assistant",
  "model": "agnes-2.0-flash",
  "content": [{ "type": "text", "text": "こんにちは" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 3, "output_tokens": 5 }
}
```

`"stream": true` の場合、応答は `text/event-stream` で、標準的な Anthropic の
イベント順序を含みます: `message_start`、`content_block_start`、1 つ以上の
`content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。

## `POST /v1/responses`

OpenAI-Responses プロトコルです。リクエスト内の `instructions` と配列形式の
`input` は上流へ転送する前に messages へ変換され、応答は `output[]` 構造に
変換されます。

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "あなたは親切なアシスタントです。",
    "input": "こんにちは"
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
    "content": [{ "type": "output_text", "text": "こんにちは", "annotations": [] }]
  }],
  "usage": { "input_tokens": 3, "output_tokens": 5, "total_tokens": 8 }
}
```

`"stream": true` の場合、応答は `text/event-stream` で、`response.created`、
1 つ以上の `response.output_text.delta`、`response.completed` を含みます。

## `GET /v1beta/models`

Gemini 形式のモデル一覧です。

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

Gemini generateContent プロトコルの非ストリーミング版です。リクエスト内の
`systemInstruction` と `contents` は上流へ転送する前に messages へ変換されます。
モデル名はリクエストボディではなくパスに含まれます。

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "あなたは親切なアシスタントです。" }] },
    "contents": [{ "role": "user", "parts": [{ "text": "こんにちは" }] }]
  }'
```

```json
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "こんにちは" }] },
    "finishReason": "STOP",
    "index": 0
  }],
  "modelVersion": "agnes-2.0-flash",
  "usageMetadata": { "promptTokenCount": 2, "candidatesTokenCount": 3, "totalTokenCount": 5 }
}
```

注意: パスは最後のコロンで分割されるため、モデル名自体にコロンが含まれる場合
（例: `vendor:agnes-2.0-flash`）でも正しく処理されます。

## `POST /v1beta/models/{model}:streamGenerateContent`

リクエストの形は `generateContent` と同じで、パスの末尾が
`:streamGenerateContent` になります。応答は `text/event-stream` で、各
イベントは `event:` フィールドを持たない `data:` 行です（`[DONE]` の終端
マーカーはなく、ストリームはそのまま終了します）。

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "こんにちは" }] }] }'
```

```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"こんにちは"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}

```

## `POST /v1/images/generations`

同期の画像生成です。リクエストボディと応答ボディは上流の Agnes API との
間でそのまま転送／パススルーされます——以下の例は本ゲートウェイ独自の形式
ではなく、現時点での上流の契約を反映したものです。

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

動画生成タスクを作成し、即座に応答を返します。タスクは上流側で非同期に
実行されます。リクエストボディはそのまま転送され、応答ボディはそのまま
パススルーされます。

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

以前に作成した動画タスクをポーリングします。応答ボディは上流からそのまま
パススルーされます。

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```
