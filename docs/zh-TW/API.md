# API 參考

**語言：** [English](../en/API.md) | [简体中文](../zh-CN/API.md) | 繁體中文 | [日本語](../ja/API.md) | [한국어](../ko/API.md)

以下範例統一使用 `http://localhost:8080`（Docker/Node 的監聽位址）。若部署在
Cloudflare Worker 上，換成你的 `*.workers.dev` 網域（或自訂網域）即可。

`your-gateway-token` 是你設定的 `GATEWAY_TOKEN` 的佔位符。

## 鑑權

`/v1/*` 與 `/v1beta/*` 底下所有路由都需要憑證，`/health` 不需要。以下四種傳遞方式
任選其一即可——正好對應各協議官方 SDK 預設發送的憑證形式，通常不需要額外設定：

| 方式 | 範例 |
|---|---|
| `Authorization: Bearer` 標頭 | `Authorization: Bearer your-gateway-token` |
| `x-api-key` 標頭 | `x-api-key: your-gateway-token` |
| `x-goog-api-key` 標頭 | `x-goog-api-key: your-gateway-token` |
| `key` 查詢參數 | `?key=your-gateway-token` |

缺少或錯誤的憑證回傳 `401`：

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

（目前無論你在讀哪個語言版本的文件，這段訊息文字都只有簡體中文——閘道本身尚未
在地化錯誤字串。）

## 模型

閘道暴露四個模型，該傳哪一個取決於呼叫哪個端點：

| 模型 | 用於 |
|---|---|
| `agnes-2.0-flash` | 對話／文字類端點 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## key 池耗盡時的錯誤

若 key 池中沒有可用 key，閘道會在發出上游請求之前直接回傳 `503`：

| `reason` | 是否自癒 | 含義 |
|---|---|---|
| `pool_empty` | – | 尚未匯入任何 key。 |
| `all_cooling` | **會** | 全部 key 處於冷卻中（限流、欠費或瞬時故障累積）。回應標頭 `Retry-After` 給出最早恢復時刻。 |
| `all_evicted` | **不會** | 全部 key 因憑證失效（上游 `401`/`403`）被永久剔除，請更換 key。 |
| `upstream_error` | **會** | key 本身可用，但上游每次嘗試都失敗。 |

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
```

除上述情況外，上游回傳的其他錯誤狀態碼（`400`、`404` 等）一律原樣透傳，維持上游自身的
錯誤結構，閘道不做改寫。兩個例外：上游 `401`/`403` 的回應內容**絕不**轉發（那裡是上游 API
最可能回顯 key 片段的地方）；格式轉換類路由上，上游 `200` 但回應內容不是 JSON 時回傳 `502`。

上游的回應標頭同樣不原樣轉發，只保留 `content-type`、`cache-control` 與 `retry-after`。其餘
（`set-cookie`、`www-authenticate`、各家的 `x-*` 標頭）一律剝除——池子每次請求都可能換一把
key，這些標頭描述的是上游帳號而非你的閘道。

---

## `GET /health`

不需鑑權。

```bash
curl http://localhost:8080/health
```

```json
{ "status": "ok", "version": "0.1.0" }
```

## `GET /v1/models`

OpenAI 格式的模型清單。

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

OpenAI Chat Completions 協議。非串流回應就是上游的 OpenAI 格式 JSON，原樣回傳。

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

傳 `"stream": true` 即可取得串流回應：`Content-Type: text/event-stream`，標準的
OpenAI 風格 `data: {...}` 分片，以 `data: [DONE]` 結束。

## `POST /v1/messages`

Anthropic Messages 協議。請求內的 `system` 與陣列形式的 `content` 會在轉發上游前被
壓平；回應會轉換為 Anthropic 的 content block 結構。

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "x-api-key: your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "max_tokens": 1024,
    "system": "你是一個樂於助人的助理。",
    "messages": [{ "role": "user", "content": "你好" }]
  }'
```

```json
{
  "id": "msg_c1",
  "type": "message",
  "role": "assistant",
  "model": "agnes-2.0-flash",
  "content": [{ "type": "text", "text": "你好" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 3, "output_tokens": 5 }
}
```

傳 `"stream": true` 時回應為 `text/event-stream`，攜帶標準 Anthropic 事件序列：
`message_start`、`content_block_start`、一個或多個 `content_block_delta`、
`content_block_stop`、`message_delta`、`message_stop`。

## `POST /v1/responses`

OpenAI-Responses 協議。請求內的 `instructions` 與陣列形式的 `input` 會在轉發上游前
被轉換為 messages；回應會轉換為 `output[]` 結構。

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "你是一個樂於助人的助理。",
    "input": "你好"
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
    "content": [{ "type": "output_text", "text": "你好", "annotations": [] }]
  }],
  "usage": { "input_tokens": 3, "output_tokens": 5, "total_tokens": 8 }
}
```

傳 `"stream": true` 時回應為 `text/event-stream`，攜帶：`response.created`、一個或
多個 `response.output_text.delta`、`response.completed`。

## `GET /v1beta/models`

Gemini 格式的模型清單。

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

Gemini generateContent 協議，非串流。請求內的 `systemInstruction` 與 `contents` 會在
轉發上游前被轉換為 messages。模型名寫在路徑裡，不在請求內容中。

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "你是一個樂於助人的助理。" }] },
    "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }]
  }'
```

```json
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "你好" }] },
    "finishReason": "STOP",
    "index": 0
  }],
  "modelVersion": "agnes-2.0-flash",
  "usageMetadata": { "promptTokenCount": 2, "candidatesTokenCount": 3, "totalTokenCount": 5 }
}
```

注意：路徑按最後一個冒號切分，因此模型名本身含冒號（例如
`vendor:agnes-2.0-flash`）也能被正確處理。

## `POST /v1beta/models/{model}:streamGenerateContent`

請求形態與 `generateContent` 相同，路徑以 `:streamGenerateContent` 結尾。回應為
`text/event-stream`，每個事件是不帶 `event:` 欄位的 `data:` 行，沒有 `[DONE]`
終止標記——串流結束時直接關閉：

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }] }'
```

```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}

```

## `POST /v1/images/generations`

同步圖片生成。請求內容與回應內容原樣轉發／透傳自上游 Agnes API——以下範例反映的是
目前上游的契約，而非本閘道自訂的格式。

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "一隻貓" }'
```

```json
{ "created": 1735689600, "data": [{ "url": "https://example.com/generated-image.png" }] }
```

## `POST /v1/videos`

建立一個影片生成任務並立即回傳，任務在上游非同步執行。請求內容原樣轉發，回應內容
原樣透傳。

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "一隻貓在跑" }'
```

```json
{ "id": "task-1", "status": "queued" }
```

## `GET /v1/videos/{id}`

輪詢先前建立的影片任務。回應內容原樣透傳自上游。

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```
