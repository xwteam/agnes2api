# API リファレンス

本ドキュメントは agnes2api が外部に公開する四つのプロトコルエンドポイント、管理インターフェース、エラー契約を一つずつ説明します。

## 認証

`/v1/*` と `/v1beta/*` 配下のすべてのルートは認証情報を必要とし、`/health` は必要としません。以下の四つの渡し方はどれか一つを選べば十分です——それぞれが各プロトコルの公式 SDK が既定で送る形式に対応しているので、通常は追加設定が要りません。

以下の例はすべて `http://localhost:8080`（Docker/Node が待ち受けるアドレス）を使います。Cloudflare Worker にデプロイした場合はあなたの `*.workers.dev` ドメイン（またはカスタムドメイン）に置き換えてください。`your-gateway-token` は設定した `GATEWAY_TOKEN` のプレースホルダーです。

### 方式 1：Authorization Bearer ヘッダー

OpenAI と OpenAI-Responses 系の標準的な書き方で、公式 `openai` SDK は既定でこれだけを送ります：

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

### 方式 2：x-api-key ヘッダー

Anthropic 系の標準的な書き方で、公式 `anthropic` SDK は既定でこれだけを送ります：

```bash
curl http://localhost:8080/v1/models \
  -H "x-api-key: your-gateway-token"
```

### 方式 3：x-goog-api-key ヘッダー

Gemini 系の標準的な書き方で、公式 `google-genai` SDK はカスタム base URL を設定するとこれを送ります：

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

### 方式 4：key クエリパラメータ

ヘッダーを設定できない場面（ブラウザの `EventSource`、一部のゲートウェイのプローブ）では認証情報を URL に置けます：

```bash
curl "http://localhost:8080/v1beta/models?key=your-gateway-token"
```

### 認証情報はどこから来るか

この認証情報はデプロイ時に設定した `GATEWAY_TOKEN` そのもので、上流 Agnes の key プールとは一切関係ありません——プールの key は一本たりともゲートウェイの外に出ません：

```env
# 必須: 下流クライアントがこのゲートウェイを呼ぶときに提示するトークン。上流の key とは無関係
GATEWAY_TOKEN=長いランダム文字列に置き換える
```

認証情報が無い、または誤っている場合は `401` を返します：

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

> [!IMPORTANT]
> 管理インターフェース `/admin/api/*` は上の四つの渡し方を**一つも受け付けません**。`x-admin-key` ヘッダーだけを読み、`ADMIN_TOKEN` だけを受け付けます。二本の鍵は厳密に分離されています：中継トークンは下流の利用者全員に配るものなので、それをパネルのトークンに使い回すことはプール全体を渡すことと同じです。

## 標準ベアパス

四つのプロトコルはそれぞれ自分の標準ベアパスに載っているので、主要な SDK は `base_url` にベンダー接頭辞を足す必要がありません。

### プロトコル別のベアパス

**OpenAI 形式**：

- `POST /v1/chat/completions`
- `GET /v1/models`

**OpenAI-Responses 形式**：

- `POST /v1/responses`

**Anthropic 形式**：

- `POST /v1/messages`

**Gemini 形式**：

- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `GET /v1beta/models`

### パスの中のモデル名

Gemini の二つのエンドポイントはモデル名をボディではなくパスに書きます。パスは**最後のコロンで分割**されるので、モデル名自体にコロンが含まれていても（例：`vendor:agnes-2.0-flash`）正しく扱われます。

`GET /v1/models` は OpenAI 形状のモデル一覧を、`GET /v1beta/models` は同じモデル群の Gemini 形状を返します——同じパスで両方の形状は返せないので、使う SDK に合う方を選んでください。

## エラーコード

ゲートウェイ自身が生むエラーは常に `{ "error": { "type": ..., "message": ... } }` という封筒で、四つのプロトコルの SDK がどれも解析できます。上流が生んだエラーはそのまま透過され、上流自身のエラー構造を保ちます。

### よくあるエラーコード

| ステータス | 説明 |
|----------|----|
| `400` | リクエストボディがゲートウェイの段階で通らなかった。上流自身が返す `400` も同じコードですが、そちらは手を加えていない上流の構造です。四つの原因は表の下を参照。 |
| `401` | ゲートウェイの認証情報が無いか誤っている（プロトコルエンドポイント）；管理インターフェースの `x-admin-key` が違う。上流の `401` のボディは決して転送しません。 |
| `404` | パスが存在しない；または管理エンドポイントの `{id}` が存在しない（`没有这把 key`）。 |
| `409` | 管理側の前提条件が満たされていない。ボディのトップレベルに機械可読な `reason` が付きます。四つの場合は表の下を参照。 |
| `429` | 外向きプローブのガードがこの一回を弾いた。ボディのトップレベルに `reason` が付きます。 |
| `502` | 形式変換系のルートで、上流が `200` を返したのにボディが JSON ではなかった。 |
| `503` | プールに使える key が無い（次の節を参照）；または管理インターフェースが利用不可（二本のトークンが衝突した、このデプロイがモジュールを配線していない）。 |
| `504` | 同期エンドポイントが `UPSTREAM_SYNC_TIMEOUT_MS` の総予算を使い切った（下の節を参照）。 |

> [!NOTE]
> `400` の四つの原因：Anthropic プロトコルに `text` 以外のコンテンツブロックがある、動画タスク識別子の形が不正、管理エンドポイントのフィールドが未知、管理エンドポイントの必須項目が無い。`409` の四つ：無効化せずに key を削除しようとした、プールサイズが画面で見た数と違う、レジストラーが無効、チャネルに認証情報が無い。`429` は単体 key の疎通確認とチャネル疎通テストの二つの外向きプローブを覆い、どちらも**識別子ごとにレート制限**されるので互いを塞ぎません。

### key プール枯渇（`503`）

プールに使える key が一本も無い場合、ゲートウェイは上流へのリクエストを出す前に `503` を返します：

| `reason` | 自己回復 | 意味 |
|--------|--------|----|
| `pool_empty` | – | まだ key が一本もインポートされていません。 |
| `all_cooling` | **する** | すべての key がクールダウン中です（レート制限、課金、瞬間的な失敗の累積）。`Retry-After` ヘッダーが最も早い回復時刻を示します。 |
| `all_disabled` | **しない** | すべての key が管理パネルで管理者に**手動で無効化**されています。パネルで有効に戻してください——**認証情報自体に問題は無いので、key を交換しないでください**。 |
| `all_evicted` | **しない** | すべての key が上流での認証失敗（`401`/`403`）により恒久的に排除されました。交換してください。 |
| `upstream_error` | **する** | key 自体は使えますが、上流への試行が毎回失敗しています。 |

**レスポンス**：

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
```

### 同期エンドポイントのタイムアウト（`504`）

画像生成、動画タスク作成、そして**すべての非ストリーミング対話**（四つのプロトコル）は同期タイムアウト予算 `UPSTREAM_SYNC_TIMEOUT_MS`（既定 120000 ミリ秒、[デプロイガイド](DEPLOY.md#環境変数)を参照）で動きます。その総予算の中で試したどの key も応答しなかった場合、`504` を返します：

| `reason` | 意味 |
|--------|----|
| `upstream_timeout` | このリクエストは `UPSTREAM_SYNC_TIMEOUT_MS` の総予算を使い切り、その間に試したどの key も自分の試行予算内に応答しませんでした。 |

**レスポンス**：

```json
{ "error": { "reason": "upstream_timeout", "message": "同步端点用尽了 120000 毫秒的总预算：已尝试 2 把 key，均未在各自的尝试预算内收到上游响应……" } }
```

原因は三つ：上流全体が遅い、予算が小さすぎる、それらの key に対応する上流セッションが止まっている。この総予算がクライアントにとっての最悪の待ち時間であり、プールの大きさとは無関係です。`504` を受け取ったとき、ゲートウェイはどの key も**罰しません**；同じリクエストの中で別の key が成功したときにだけ、先にタイムアウトした方が記録されます。

### 透過するものとしないもの

以上の場合を除き、上流が返すその他のエラーステータス（`400`、`404` など）はすべてそのまま透過され、上流自身のエラー構造が保たれます——ゲートウェイは書き換えません。例外は二つ：上流の `401`/`403` のボディは**決して**転送しません（そこは上流 API が key の断片を最も echo しやすい場所です）；形式変換系のルートで上流が `200` を返してもボディが JSON でないときは `502` になります。

上流のレスポンスヘッダーもそのままは転送せず、`content-type`、`cache-control`、`retry-after` だけを残します。その他（`set-cookie`、`www-authenticate`、各社の `x-*` ヘッダー）はすべて剥がします——プールはリクエストごとに別の key を選ぶ可能性があり、これらのヘッダーはあなたのゲートウェイではなく上流アカウントを説明するものだからです。

## モデル

ゲートウェイは四つのモデルを公開しており、どのエンドポイントを呼ぶかでどれを送るかが決まります：

| モデル | 用途 |
|------|----|
| `agnes-2.0-flash` | 対話/テキスト系のエンドポイント |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## OpenAI 互換 API

### GET /v1/models

OpenAI 形式のモデル一覧。パラメータは受け取りません。

**リクエスト**：

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

**レスポンス**：

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

OpenAI Chat Completions プロトコル。非ストリーミングのレスポンスは上流の OpenAI 形式 JSON をそのまま返したものです。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `model` | string | はい | `agnes-2.0-flash` を指定します。 |
| `messages` | array | はい | 標準的な OpenAI のメッセージ配列。 |
| `stream` | boolean | いいえ | `true` を送るとストリーミング。既定は `false`。 |

**リクエスト**：

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

**レスポンス**：

```json
{
  "id": "c1",
  "choices": [{ "message": { "role": "assistant", "content": "hi" } }]
}
```

`"stream": true` を送るとストリーミングレスポンスになります：`Content-Type: text/event-stream`、標準的な OpenAI 風の `data: {...}` チャンクで、`data: [DONE]` で終わります。

> [!WARNING]
> ストリーム最終チャンクに usage が付くかは実際の上流では未検証です：本ゲートウェイはこのプロトコルのストリーミングバイトをそのまま透過し、解析も書き換えもしません。上流がストリーム末尾に usage を出すなら、そのバイトはそのままクライアントに届きます。

## OpenAI Responses API

### POST /v1/responses

OpenAI-Responses プロトコル。ボディの `instructions` と配列形態の `input` は上流へ転送する前に messages へ変換され、レスポンスは `output[]` 構造に変換されます。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `model` | string | はい | `agnes-2.0-flash` を指定します。 |
| `input` | string / array | はい | 文字列、または標準的な Responses の入力配列。 |
| `instructions` | string | いいえ | system メッセージ一件に変換されます。 |
| `stream` | boolean | いいえ | `true` を送るとストリーミング。既定は `false`。 |

**リクエスト**：

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

**レスポンス**：

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

`"stream": true` のときレスポンスは `text/event-stream` になり、`response.created`、一つ以上の `response.output_text.delta`、`response.completed` を運びます。

## Anthropic 互換 API

### POST /v1/messages

Anthropic Messages プロトコル。ボディの `system` と配列形態の `content` は上流へ転送する前に平坦化され、レスポンスは Anthropic の content block 構造に変換されます。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `model` | string | はい | `agnes-2.0-flash` を指定します。 |
| `max_tokens` | number | はい | Anthropic プロトコル自身の必須項目。 |
| `messages` | array | はい | 標準的な Anthropic のメッセージ配列。 |
| `system` | string / array | いいえ | 上流へ転送する前にプレーンテキストへ平坦化されます。 |
| `stream` | boolean | いいえ | `true` を送るとストリーミング。既定は `false`。 |

**リクエスト**：

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

**レスポンス**：

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

`"stream": true` のときレスポンスは `text/event-stream` になり、標準的な Anthropic のイベント列を運びます：`message_start`、`content_block_start`、一つ以上の `content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。

> [!IMPORTANT]
> `content`（または `system`）配列に内部のプレーンテキスト形式へ写像できないブロック——`image`、`tool_use`、`tool_result` のような `text` 以外のあらゆる型——があると、ゲートウェイは上流へ転送する前に `400` を返します。初期の版のようにそのブロックを黙って捨てることはしません。メッセージ `不支持的内容块类型: image（本网关仅支持 text）` のブロック型は実際に受け取った値に置き換わります。

## Gemini 原生 API

### GET /v1beta/models

Gemini 形式のモデル一覧。パラメータは受け取りません。

**リクエスト**：

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

**レスポンス**：

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

Gemini generateContent プロトコル、非ストリーミング。ボディの `systemInstruction` と `contents` は上流へ転送する前に messages へ変換されます。モデル名はボディではなくパスに書きます。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `contents` | array | はい | 標準的な Gemini の contents 配列。 |
| `systemInstruction` | object | いいえ | system メッセージ一件に変換されます。 |

**リクエスト**：

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "あなたは親切なアシスタントです。" }] },
    "contents": [{ "role": "user", "parts": [{ "text": "こんにちは" }] }]
  }'
```

**レスポンス**：

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

### POST /v1beta/models/{model}:streamGenerateContent

ボディの形は `generateContent` と同じで、パスが `:streamGenerateContent` で終わります。レスポンスは `text/event-stream` で、各イベントは `event:` フィールドの無い `data:` 行、`[DONE]` の終端マーカーはありません——ストリームは終わるときにそのまま閉じます。

**リクエスト**：

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "こんにちは" }] }] }'
```

**レスポンス**：

```text
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"こんにちは"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}
```

## 画像と動画 API

### POST /v1/images/generations

同期の画像生成。リクエストとレスポンスのボディは上流 Agnes API へそのまま転送・透過されます——以下の例は現在の上流の契約を映したものであり、本ゲートウェイが決めた形式ではありません。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `model` | string | はい | `agnes-image-2.1-flash` または `agnes-image-2.0-flash` を指定します。 |
| `prompt` | string | はい | 上流へそのまま転送されます。 |

**リクエスト**：

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "一匹の猫" }'
```

**レスポンス**：

```json
{ "created": 1735689600, "data": [{ "url": "https://example.com/generated-image.png" }] }
```

### POST /v1/videos

動画生成タスクを作成してすぐ返します。タスクは上流で非同期に走ります。リクエストボディはそのまま転送され、レスポンスボディはそのまま透過されます。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `model` | string | はい | `agnes-video-v2.0` を指定します。 |
| `prompt` | string | はい | 上流へそのまま転送されます。 |

**リクエスト**：

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "走っている猫" }'
```

> [!WARNING]
> 以下のレスポンスボディの形は実際の上流では未検証です：これは本リポジトリのテストフィクスチャを写したものです。ゲートウェイはレスポンスボディをそのまま透過し、その構造について何も仮定しません。

**レスポンス**：

```json
{ "id": "task-1", "status": "queued" }
```

### GET /v1/videos/{id}

先に作成した動画タスクをポーリングします。レスポンスボディは上流からそのまま透過されます。

**リクエスト**：

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

**レスポンス**：

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```

転送の前に、ゲートウェイはタスク識別子の形を検査し、**`A-Za-z0-9_- (1-128)` だけを受け付けます**：前半が許される文字集合、括弧の中が長さの下限と上限です。一致しないものはすべて 400 で、**上流へのリクエストは一度も出ません**。その 400 のメッセージはこの形を一字一句そのまま載せているので、それに合わせて識別子を貼り直せば通ります。

> [!WARNING]
> タスク識別子の形状判定は実際の上流では未検証です：文字集合と長さの上限は、本リポジトリのテストフィクスチャにある識別子から**外挿**したものであり、写したものではありません。上流が本当に別の形を発行した場合、ゲートウェイはまず 400 を返し、上流へは渡しません——そのときリクエストのパラメータを変えても意味がなく、ゲートウェイを直す必要があります。

## 管理 API

`/admin` 管理パネル（静的アセットはビルド時に埋め込まれます）は `/admin/api/*` 系のインターフェースで動きます。これらは四つのプロトコルエンドポイントとは**完全に分離**されています：`x-admin-key` ヘッダーだけを読み、`ADMIN_TOKEN` だけを受け付け、`Authorization: Bearer` も `?key=` も受け付けません（トークンが URL に入るとブラウザ履歴、`Referer`、各層のアクセスログに残ります）。

`ADMIN_TOKEN` が未設定、または硬いルール（前後の空白、印字不可能な ASCII、24 文字未満）を満たさない場合、**`/admin` のツリーは丸ごと登録されません**——アクセスすると `401` ではなく `404` になり、「ここに管理画面がある」ことを漏らしません。

> [!WARNING]
> 管理インターフェースのレスポンスはプール内の key の平文をどこにも echo せず、reveal エンドポイントもありません。しかし `ADMIN_TOKEN` を握った人はプール全体を空にでき、`GATEWAY_TOKEN` を変更でき、レジストラーを有効にできます——**中継トークンより重い方の鍵として扱ってください**。

### GET /admin/api/session

ログインプローブ。パネルはこれで「このトークンが使えるか」を確かめます。**設定もプール情報も一切返しません。**

**リクエスト**：

```bash
curl http://localhost:8080/admin/api/session \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

```json
{ "ok": true, "version": "0.1.0" }
```

### GET /admin/api/capabilities

デュアルランタイム差分の**唯一の出口**：パネルは起動時に一度だけ呼び、形態依存の分岐はすべてこれを読みます。ストレージアクセスはゼロです。

**リクエスト**：

```bash
curl http://localhost:8080/admin/api/capabilities \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

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

概要ページの一回分の取得：バージョン、サーバー時計、ランタイム、プロセス指標、ストレージの健康状態、プールの健康状態、Tier-1 のプール集計、2 本の鮮度、そして設定の要約。

> [!NOTE]
> `poolStats` は**近似値**です（`approximate: true`）：並行時には少なめに数え、書き込みは最大で `POOL_TOUCH_INTERVAL_MS` 一回分だけ遅れます。パネルはこの近似マーカーを必ず描かねばならず、黙って正確値として扱ってはいけません。

**リクエスト**：

```bash
curl http://localhost:8080/admin/api/overview \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

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

四プロトコル × モデルの静的カタログ。**ストレージ読み取りはゼロ**で、すべてモジュールレベルの定数から来ます——連携スニペットのカード、プレイグラウンド、モデル表の三箇所がここから取るので、エンドポイントのパスはフロントエンドに一つもハードコードされていません。

**リクエスト**：

```bash
curl http://localhost:8080/admin/api/models \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

```json
{
  "protocols": [{ "id": "openai", "label": "OpenAI Chat Completions", "method": "POST", "pathTemplate": "/v1/chat/completions", "upstreamPath": "/chat/completions" }],
  "media": [{ "id": "image.generate", "method": "POST", "pathTemplate": "/v1/images/generations" }],
  "models": [{ "id": "agnes-2.0-flash", "modality": "chat" }],
  "samplePrompt": "ping"
}
```

### GET /admin/api/keys

Key プールの読み取り専用一覧で、絞り込みとページングが付きます。**投影に平文の key は決して含まれません。**

**リクエストボディ**：このエンドポイントはクエリパラメータのみを取り、ボディは取りません。

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `q` | string | いいえ | あいまい一致（メモ、id の断片など）。 |
| `bucket` | string | いいえ | バケットで絞り込み；正しくない値は丸ごと無視されます。 |
| `page` | number | いいえ | 1 始まりのページ番号。範囲外なら 1 に戻ります。 |
| `size` | number | いいえ | 1 ページの件数。既定 20、上限 200。 |

**リクエスト**：

```bash
curl "http://localhost:8080/admin/api/keys?bucket=fresh&page=1&size=20" \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

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
> `counts` は**常にプール全体で計算**され、今回の絞り込みの影響を受けません：絞り込みの横にある数字は「そちらに切り替えたら何件見えるか」を意味します。絞り込み後の集合で計算すると、今のバケットは自分の件数と等しくなり、残り三つはすべて 0 になってしまいます。

### POST /admin/api/keys

key の一括インポート。返る三つの配列はそれぞれ id、id、**入力の中の位置**（1 始まり）であり、平文は一つもありません。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `keys` | array | はい | 文字列の配列；要素の型が違うとリクエスト全体が `400` で、`invalid` には入りません。 |
| `resetExisting` | boolean | いいえ | 有効にすると既存 key のクールダウン・strikes・排除マークを消します。既定は `false`。 |

**リクエスト**：

```bash
curl -X POST http://localhost:8080/admin/api/keys \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "keys": ["sk-aaa", "sk-bbb"], "resetExisting": false }'
```

**レスポンス**：

```json
{ "added": ["9f2c…"], "duplicated": ["3b71…"], "invalid": [2], "reset": 0 }
```

> [!IMPORTANT]
> `reset` と `duplicated.length` は**同じ数ではありません**：このバッチで新しく作られた key を二度貼っても重複として数えられますが、それはリセットされたわけではありません。パネルが出すべきなのは `reset` で、`duplicated.length` を出すのは嘘になります。

### POST /admin/api/keys/bulk

一括操作で、項目ごとに結果を返します。**動作は三つだけ**で、一括バーの三つのボタンと一対一で対応します。「一括で有効化」も「一括で排除解除」もありません——それらは「もっと多くの key を再び場に出す」動作であり、一本ずつ押す方が一度に全部押すより安全だからです。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `op` | string | はい | `disable` / `clearCooldown` / `delete` のいずれか。 |
| `ids` | array | はい | 文字列の配列。一度に最大 200 件。 |

**リクエスト**：

```bash
curl -X POST http://localhost:8080/admin/api/keys/bulk \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "op": "clearCooldown", "ids": ["9f2c…", "3b71…"] }'
```

**レスポンス**：

```json
{ "results": [{ "id": "9f2c…", "ok": true, "reason": null }, { "id": "3b71…", "ok": false, "reason": "not_found" }] }
```

### PATCH /admin/api/keys/{id}

key を一本変更します：無効化/有効化、メモ、クールダウン解除、strikes 消去、排除解除、使用量カウンタのリセット。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `disabled` | boolean | いいえ | この key を無効化または有効化します。 |
| `note` | string | いいえ | メモ。 |
| `clearCooldown` | boolean | いいえ | 状態ではなく動作です：`false` を送るのは送らないのと同じです。 |
| `clearStrikes` | boolean | いいえ | 状態ではなく動作です：`false` を送るのは送らないのと同じです。 |
| `unevict` | boolean | いいえ | 状態ではなく動作です：`false` を送るのは送らないのと同じです。 |
| `clearStats` | boolean | いいえ | 状態ではなく動作です：`false` を送るのは送らないのと同じです。 |

**リクエスト**：

```bash
curl -X PATCH http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "disabled": false, "clearCooldown": true }'
```

**レスポンス**：

```json
{ "ok": true }
```

### DELETE /admin/api/keys/{id}

key を一本削除します。成功は `204` でボディはありません。

> [!WARNING]
> 削除は**取り消せません**：レコードの中の key 素材はそこで消え、どこにも残っていません。だからこれは前提条件を持つ唯一の書き込みです——**無効化していない key は削除できず**、`409` とトップレベルの `reason: "must_disable_first"` が返ります。

**リクエスト**：

```bash
curl -X DELETE http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

```json
{ "error": { "type": "conflict", "code": "must_disable_first", "message": "请先停用这把 key 再删除（删除不可撤销，而停用随时可以撤销）" }, "reason": "must_disable_first" }
```

### POST /admin/api/keys/purge

Key プールを丸ごと空にします。危険ゾーンの二つのボタンのうちの一つです。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `expect` | number | はい | 画面で見たプールサイズ、0 以上の整数；食い違うと `409` で、一本も削除されません。 |

**リクエスト**：

```bash
curl -X POST http://localhost:8080/admin/api/keys/purge \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "expect": 3 }'
```

**レスポンス**：

```json
{ "deleted": 3, "remaining": 0, "expected": 3 }
```

> [!CAUTION]
> 各 key の使用履歴はそのレコードの**中**にあるので、レコードを消すことは履歴を消すことであり、二つ目の写しはありません。`remaining` は定数 `0` ではなく**読み戻した**値です——「インデックスは空と言っているのにストレージにはまだレコードが残っている」という状態も、これが正直に報告します。

### GET /admin/api/keys/{id}/usage

単体 key の Tier-1 カウンタ。**Tier-2 とは完全に無関係**で、Tier-2 が無効でも使えます。

**リクエスト**：

```bash
curl http://localhost:8080/admin/api/keys/9f2c/usage \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

```json
{
  "id": "9f2c",
  "stats": { "requests": 12, "success": 11, "failed": 1, "clientErrors": 0, "lastErrorAt": 1735689500000, "lastErrorKind": "rate limited" },
  "approximate": true,
  "generatedAt": 1735689600000
}
```

### POST /admin/api/keys/{id}/verify

単体 key の疎通確認：その key で上流へ最小のリクエストを一度送り、**ステータスコードだけを返し、本文は返しません**。

**リクエストボディ**：このエンドポイントは**オプションを一切取りません**。空ボディは通り、フィールドがあればすべて `400` です——`{"model":"…"}` のような「モデルを指定できると思った」書き方は、緩い実装では静かな誤操作になるからです。

**リクエスト**：

```bash
curl -X POST http://localhost:8080/admin/api/keys/9f2c/verify \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

```json
{ "ok": true, "status": 200, "latencyMs": 412, "reason": null }
```

> [!NOTE]
> このエンドポイントは `verify:<id>` の粒度で外向きプローブのガードの後ろにあります：同じ key を続けて押すとトップレベルの `reason` 付きで `429` になりますが、別の key の確認は影響を受けません。ストレージ書き込みは一度も発生しません。

### GET /admin/api/events

イベント区画の取得。マージ結果は `ts` の降順です。

**リクエストボディ**：このエンドポイントはクエリパラメータのみを取り、ボディは取りません。

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `after` | number | いいえ | カーソル。これより新しい項目だけ。 |
| `level` | string | いいえ | レベルで絞り込み；正しくない値は丸ごと無視されます。 |
| `limit` | number | いいえ | このページの件数。既定 200、上限 500。 |

**リクエスト**：

```bash
curl "http://localhost:8080/admin/api/events?level=warn&limit=50" \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

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
> `cursor` の合法な値はちょうど二つ：**有限の数値か `null`** です。「フィールドが無い」には決してなりません——それではフロントエンドが「新しいイベントが無い」と「バックエンドの契約が壊れた」を同じものとして読んでしまいます。

### GET /admin/api/events/download

マージ結果を丸ごと書き出します。返るのは `text/plain` で、**一行に一つの JSON**（JSON 配列ではありません）：これは端末で `grep` するための形式であり、プログラムがデシリアライズするための API ではありません。

**リクエスト**：

```bash
curl -OJ http://localhost:8080/admin/api/events/download \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

```text
{"ts":1735689600000,"level":"warn","event":"key.restored","msg":"面板解除了一把 key 上的限制"}
{"ts":1735689500000,"level":"info","event":"key.added","msg":"面板导入了新的 key"}
```

### GET /admin/api/config

現在有効な設定を読みます。認証情報のフィールドは「設定済みかどうか」だけを報告し、値は報告しません。

> [!NOTE]
> 一度も保存されていないフィールドでは、`stored` は **`null` ではなく「存在しない」** です：それは保存された `config` オブジェクトの生の値を運ぶもので、`undefined` は JSON を越えられません。下の例は新規デプロイのものです。同じフィールドが自前の `stored` を持つ `PUT` の応答と見比べてください。

**リクエスト**：

```bash
curl http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

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

設定を書きます。順序は**検証 → 書き込み → キャッシュ無効化 → 読み戻し**で、一つも入れ替えられません：先に書いてから検証すると、不正な設定が既にディスクに載っているのにレスポンスは `400` になります。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `patch` | object | はい | 変更したいパスだけを載せます；未知のトップレベルフィールドはすべて `400`。 |

**リクエスト**：

```bash
curl -X PUT http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**レスポンス**：

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
> 認証情報フィールドの空文字列は常に「変更しない」であり、**「消す」ではありません**。消す経路は `POST /admin/api/config/secrets/clear` の一本だけです——空文字列を消去として実装すると、運用者が設定ページを一度保存しただけで `gatewayToken` が消え、しかも稼働中のインスタンスには何の兆候も出ません。

### POST /admin/api/config/validate

一バイトも書かない検証のドライラン。同じ入力に対して本番の書き込みと同じエラーコードを返します。

**リクエストボディ**：`PUT /admin/api/config` と一字一句同じです（`patch` オブジェクト一つ）。

**リクエスト**：

```bash
curl -X POST http://localhost:8080/admin/api/config/validate \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**レスポンス**：

```json
{ "ok": true, "changed": ["upstreamTimeoutMs"] }
```

### POST /admin/api/config/secrets/clear

認証情報を一つ明示的に消します。**認証情報を消す唯一の入口です。**

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `path` | string | はい | 認証情報フィールドのいずれか；それ以外のパスはすべて `400`。 |

**リクエスト**：

```bash
curl -X POST http://localhost:8080/admin/api/config/secrets/clear \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "path": "gatewayToken" }'
```

**レスポンス**：

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

ストレージ上の設定を丸ごと `{}` に書き戻します。危険ゾーンの二つのボタンのもう一方です。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `confirm` | boolean | はい | 明示的に `true` が必要です。この操作は取り消せません。 |

**リクエスト**：

```bash
curl -X POST http://localhost:8080/admin/api/config/reset \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "confirm": true }'
```

**レスポンス**：

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
> `appliedAt` は**「もう有効になった」という約束ではなく**、サーバーが永続化したその瞬間です。他のレプリカや他の isolate がいつ見えるようになるかは `propagation` の三つの数値が語ります——パネルはこれを「リセット済みで有効」と描いてはいけません。

### POST /admin/api/registrar/tend

補充を手動で一巡だけ起動します。成功は `200` ではなく `202`（開始した）です。

**リクエストボディ**：

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `channel` | string | いいえ | `moemail` か `yyds` のみ；省くと設定のプライマリ／フォールバックチャネルの連鎖に従います。 |

**リクエスト**：

```bash
curl -X POST http://localhost:8080/admin/api/registrar/tend \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "channel": "moemail" }'
```

**レスポンス**：

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
> `remaining` は成功の分岐でも返します：使い切ったときだけ返すのは、運用者に何も知らせないまま壁にぶつけるのと同じだからです。レジストラーが無効なら `reason` 付きの `409`、チャネルに認証情報が無い場合も `409` です——**それは「このルートが存在しない」ではありません**。

### GET /admin/api/registrar/status

補充区画の取得：レジストラーが有効かどうか、二つのチャネルそれぞれの配線状態、ガードの残り回数、補充履歴。

> [!IMPORTANT]
> ここのフィールドは `available` **ではなく** `counted` です：判定基準は「目標数に数える」であり、無効化された key もクールダウン中の key も含まれます。そしてそのどちらも上流とは話せません。本当に使える数は隣にある `fresh` です——**どちらも `pool` オブジェクトの中にあり、トップレベルにはありません**。

**リクエスト**：

```bash
curl http://localhost:8080/admin/api/registrar/status \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

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

チャネルの疎通テスト：メールサービスへ読み取り専用の GET を一度だけ送ります。メールボックスも作らず key も受け取りません。

レスポンスの `domains` は**探れたドメインの個数**（整数）であって、ドメインの一覧ではありません——このエンドポイントは上流の詳細を意図的に一切返しません。

**リクエストボディ**：このエンドポイントはボディを取りません。チャネル名はパスに書きます（`moemail` か `yyds` のみ）。

**リクエスト**：

```bash
curl -X POST http://localhost:8080/admin/api/registrar/channels/moemail/test \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

```json
{ "ok": true, "channel": "moemail", "domains": 3, "latencyMs": 128 }
```

### GET /admin/api/usage

Tier-2 使用量の区間集計。日付は常に UTC で、**レスポンスの中でそう明言します**。

どちらのパラメータも**epoch ミリ秒の整数しか受け取りません**：整数でない値や負の値は一律 `400` で、サーバー側は「善意の補正」をしません——`2026-08-01` のような日付文字列は不正として弾かれます。**`days` はパラメータではありません**：パネルのボタンの区分であって、サーバーは知りません。フロントは `from` / `to` しか送りません。

**リクエストボディ**：このエンドポイントはクエリパラメータのみを取り、ボディは取りません。

| パラメータ | 型 | 必須 | 説明 |
|----------|----|----|----|
| `from` | number | いいえ | 区間の始点。**epoch ミリ秒の整数**。既定は `to - 86400000`。保持期間の開始より前はそこへクランプされ、`range.clamped` が真になります。 |
| `to` | number | いいえ | 区間の終点。**epoch ミリ秒の整数**。既定はサーバーの現在時刻。現在時刻より後はそこへクランプされ、`range.clamped` が真になります。 |

**リクエスト**：

```bash
curl "http://localhost:8080/admin/api/usage?from=1735689600000&to=1735775999999" \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

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
> Tier-2 が無効でもこのエンドポイントは**普通に 200 を返し**、正直に `tier: "off"` と言います——`503` を返すと、パネルは「運用者が統計を有効にしていない」を「バックエンドが壊れた」として描いてしまいます。「読めなかった」「時計が壊れている」「その日は保持期間の外」はそれぞれ別の `note` を持ち、同じ「データがありません」に潰してはいけません。

### GET /admin/api/usage/{date}

ある一日の使用量の内訳：時間別、モデル別、プロトコル別の三つの切り口。

**リクエストボディ**：このエンドポイントはボディを取りません。日付はパスに書き、UTC の `YYYY-MM-DD` でなければ `400` です。**上の区間エンドポイントとは口径が意図的に異なります**：あちらは epoch ミリ秒の整数しか取らず、こちらは日付文字列しか取りません。互換性はありません。

**リクエスト**：

```bash
curl http://localhost:8080/admin/api/usage/2026-08-30 \
  -H "x-admin-key: your-admin-token"
```

**レスポンス**：

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

## システム API

### GET /health

ヘルスチェック（Docker のプローブ向け）。**認証不要**であり、だからこそ低レベルのエラー詳細も一切 echo しません。

**リクエスト**：

```bash
curl http://localhost:8080/health
```

**レスポンス**：

```json
{ "status": "ok", "version": "0.1.0", "storage": { "writable": true } }
```

`storage.writable` は「key プールが載っているストレージに本当に書き込めるか」を報告します。起動時の一度のプローブと実行中のすべての実書き込みで維持され、ヘルスチェック自身は書き込みません。書き込めないときは **HTTP `503`** を返し、`status` が `degraded` になって `detail` の一文が付きます（Docker ではバインドマウントしたホストディレクトリの所有者とコンテナ内の実行ユーザーが食い違っている場合が多く、詳細はコンテナログにあります）。

> [!NOTE]
> イメージ内蔵の `HEALTHCHECK` はレスポンスが成功したかどうかだけで判定するので、そうしたコンテナは Docker から unhealthy と見なされます。根本のエラーはコンテナログにだけ書かれ、この認証不要のエンドポイントには echo されません。

## リクエスト例

base URL には**標準ベア接頭辞**を使います：OpenAI = `{host}/v1`、Anthropic = `{host}`（SDK が `/v1/messages` を自分で足します）、Gemini = `{host}/v1beta`。

### Python - OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-gateway-token",
    base_url="http://localhost:8080/v1"
)

# 非ストリーミングリクエスト
response = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.choices[0].message.content)

# ストリーミングリクエスト
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
# 非ストリーミングリクエスト
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# ストリーミングリクエスト
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## 次のステップ

- 使い方と四つのプロトコルの SDK 接続：[USAGE.md](USAGE.md)
- 二つのデプロイ形態とすべての環境変数：[DEPLOY.md](DEPLOY.md)
- Web 管理パネル：[ADMIN.md](ADMIN.md)
- レジストラー（自動プール補充）：[REGISTRAR.md](REGISTRAR.md)
