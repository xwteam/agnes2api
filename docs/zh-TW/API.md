# API 文檔

本文檔逐條說明 agnes2api 對外暴露的四種協議端點、管理介面與錯誤契約。

## 認證

`/v1/*` 與 `/v1beta/*` 底下的所有路由都需要憑證，`/health` 不需要。以下四種傳遞方式任選其一即可——正好對應各協議官方 SDK 預設送出的憑證形式，通常不必額外設定。

以下範例統一使用 `http://localhost:8080`（Docker/Node 的監聽位址）。若部署在 Cloudflare Worker 上，換成你的 `*.workers.dev` 網域（或自訂網域）即可。`your-gateway-token` 是你設定的 `GATEWAY_TOKEN` 的佔位符。

### 方式 1：Authorization Bearer 請求標頭

OpenAI 與 OpenAI-Responses 生態的標準寫法，官方 `openai` SDK 預設只送這一條：

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

### 方式 2：x-api-key 請求標頭

Anthropic 生態的標準寫法，官方 `anthropic` SDK 預設只送這一條：

```bash
curl http://localhost:8080/v1/models \
  -H "x-api-key: your-gateway-token"
```

### 方式 3：x-goog-api-key 請求標頭

Gemini 生態的標準寫法，官方 `google-genai` SDK 在設了自訂 base URL 時送這一條：

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

### 方式 4：key 查詢參數

設不了請求標頭的場景（瀏覽器 `EventSource`、某些閘道探針）可以把憑證放進 URL：

```bash
curl "http://localhost:8080/v1beta/models?key=your-gateway-token"
```

### 憑證從哪裡來

這把憑證就是部署時設定的 `GATEWAY_TOKEN`，與上游 Agnes 的 key 池完全無關——池裡那些 key 一把都不會離開閘道：

```env
# 必填：下游用戶端呼叫這台閘道時要出示的口令，與上游 key 無關
GATEWAY_TOKEN=換成一把長隨機字串
```

缺少或錯誤的憑證回傳 `401`：

```json
{ "error": { "message": "未授权：缺少或无效的凭据", "type": "unauthorized" } }
```

> [!IMPORTANT]
> 管理介面 `/admin/api/*` **不接受**上面這四種傳遞方式，它只認 `x-admin-key` 請求標頭、只認 `ADMIN_TOKEN`。兩把鑰匙嚴格隔離：中轉口令是發給每一個下游使用者的，拿它當面板口令等於把整池 key 交出去。

## 路徑說明

四種協議各自掛在自己的標準裸路徑上，主流 SDK 填 `base_url` 時不必加任何廠商前綴。

### 標準裸路徑

**OpenAI 格式**：

- `POST /v1/chat/completions`
- `GET /v1/models`

**OpenAI-Responses 格式**：

- `POST /v1/responses`

**Anthropic 格式**：

- `POST /v1/messages`

**Gemini 格式**：

- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `GET /v1beta/models`

### 路徑裡的模型名

Gemini 那兩條端點把模型名寫在路徑裡、不在請求內容中。路徑**按最後一個冒號切分**，因此模型名本身含冒號（例如 `vendor:agnes-2.0-flash`）也能被正確處理。

`GET /v1/models` 回傳 OpenAI 形狀的模型列表，`GET /v1beta/models` 回傳 Gemini 形狀的同一批模型——同一路徑無法同時回傳兩種格式，按你用的 SDK 選一條即可。

## 錯誤碼

閘道自己產生的錯誤一律是 `{ "error": { "type": ..., "message": ... } }` 這個信封，四種協議的 SDK 都解析得動。上游產生的錯誤則原樣透傳，保持上游自身的錯誤結構。

### 常見錯誤碼

| 狀態碼 | 說明 |
|------|----|
| `400` | 請求內容過不了閘道這一關；上游自己回傳的 `400` 也走這個碼，但那是原樣透傳的上游結構。四類成因見表下那條說明。 |
| `401` | 缺少或錯誤的閘道憑證（協議端點）；管理介面的 `x-admin-key` 不對。上游 `401` 的回應內容絕不轉發。 |
| `404` | 路徑不存在；管理介面裡那個 `{id}` 不存在（`没有这把 key`）。 |
| `409` | 管理介面的前置條件沒滿足，回應內容頂層帶一個機器可讀的 `reason`。逐條見表下那條說明。 |
| `429` | 管理介面的對外探測護欄擋下了這一次，回應內容頂層帶 `reason`。 |
| `502` | 格式轉換類路由上，上游回了 `200` 但回應內容不是 JSON。 |
| `503` | key 池裡沒有可用 key（見下一節）；或管理介面不可用（兩把口令撞了、這個部署沒接上某個模組）。 |
| `504` | 同步端點用盡了 `UPSTREAM_SYNC_TIMEOUT_MS` 的總預算（見下面那一節）。 |

> [!NOTE]
> `400` 的四類成因：Anthropic 協議裡出現非 `text` 內容區塊、影片任務識別碼形狀非法、管理介面的請求內容欄位不認識、管理介面缺必填項。`409` 的四類：刪 key 之前沒先停用、清空池時池大小與你看到的對不上、註冊機沒啟用、通道沒配憑證。`429` 涵蓋單把 key 驗活與通道連通性測試兩條對外探測，兩者都**按識別碼限速**，互不牽連。

### key 池耗盡（`503`）

若 key 池中沒有可用 key，閘道會在發起上游請求之前直接回傳 `503`：

| `reason` | 是否自癒 | 含義 |
|--------|--------|----|
| `pool_empty` | – | 尚未匯入任何 key。 |
| `all_cooling` | **會** | 全部 key 處於冷卻中（限流、欠費或瞬時故障累計）。回應標頭 `Retry-After` 給出最早恢復時刻。 |
| `all_disabled` | **不會** | 全部 key 被管理員在管理面板上**手動停用**。在面板上重新啟用即可——**憑證本身沒問題，別去換 key**。 |
| `all_evicted` | **不會** | 全部 key 因憑證失效（上游 `401`/`403`）被永久剔除，請更換 key。 |
| `upstream_error` | **會** | key 本身可用，但上游每次嘗試都失敗。 |

**回應**：

```json
{ "error": { "reason": "all_cooling", "message": "全部 key 暂不可用：2 把冷却中（到期自动恢复）、0 把已永久剔除" } }
```

### 同步端點逾時（`504`）

圖片生成、影片建任務，以及**所有非流式對話**（四種協議）走的是同步逾時預算 `UPSTREAM_SYNC_TIMEOUT_MS`（預設 120000 毫秒，見 [部署指南](DEPLOY.md#環境變數)）。當這次請求在總預算內嘗試過的每一把 key 都沒有回應時，回傳 `504`：

| `reason` | 含義 |
|--------|----|
| `upstream_timeout` | 本次請求用盡了 `UPSTREAM_SYNC_TIMEOUT_MS` 的總預算，其間嘗試過的 key 都沒在各自的嘗試預算內回應。 |

**回應**：

```json
{ "error": { "reason": "upstream_timeout", "message": "同步端点用尽了 120000 毫秒的总预算：已尝试 2 把 key，均未在各自的尝试预算内收到上游响应……" } }
```

成因有三種：上游整體變慢、預算設太小，或這幾把 key 對應的上游工作階段被掛起。這個總預算就是用戶端的最壞等待時間，與池子大小無關。收到 `504` 時閘道**沒有**懲罰任何 key；只有當同一次請求裡另一把 key 成功了，先逾時的那把才會被記帳。

### 透傳與不透傳

除以上情況外，上游回傳的其他錯誤狀態碼（`400`、`404` 等）一律原樣透傳，保持上游自身的錯誤結構，閘道不做改寫。兩個例外：上游 `401`/`403` 的回應內容**絕不**轉發（那裡是上游 API 最可能回顯 key 片段的地方）；格式轉換類路由上，上游 `200` 但回應內容不是 JSON 時回傳 `502`。

上游的回應標頭同樣不原樣轉發，只保留 `content-type`、`cache-control` 與 `retry-after`。其餘（`set-cookie`、`www-authenticate`、各家的 `x-*` 標頭）一律剝掉——池子每次請求都可能換一把 key，這些標頭描述的是上游帳號而不是你的閘道。

## 模型

閘道暴露四個模型，呼叫哪個端點決定該傳哪個：

| 模型 | 用於 |
|----|----|
| `agnes-2.0-flash` | 對話/文字類端點 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

## OpenAI 相容 API

### GET /v1/models

OpenAI 格式的模型列表。不收任何參數。

**請求**：

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"
```

**回應**：

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

OpenAI Chat Completions 協議。非流式回應就是上游的 OpenAI 格式 JSON，原樣回傳。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-2.0-flash`。 |
| `messages` | array | 是 | 標準 OpenAI 訊息陣列。 |
| `stream` | boolean | 否 | 傳 `true` 拿流式回應，預設 `false`。 |

**請求**：

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

**回應**：

```json
{
  "id": "c1",
  "choices": [{ "message": { "role": "assistant", "content": "hi" } }]
}
```

傳 `"stream": true` 即可拿到流式回應：`Content-Type: text/event-stream`，標準的 OpenAI 風格 `data: {...}` 分片，以 `data: [DONE]` 結束。

> [!WARNING]
> 串流末幀帶不帶 usage 未經真實上游核實：本閘道對這條協議的串流位元組原樣透傳，既不解析也不改寫；上游若在流末發一塊 usage，那些位元組會原樣抵達用戶端。

## OpenAI Responses API

### POST /v1/responses

OpenAI-Responses 協議。請求內容中的 `instructions` 與陣列形態的 `input` 會在轉發上游前被轉換為 messages；回應會被轉換為 `output[]` 結構。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-2.0-flash`。 |
| `input` | string / array | 是 | 字串或標準 Responses 輸入陣列。 |
| `instructions` | string | 否 | 會被轉換成一條 system 訊息。 |
| `stream` | boolean | 否 | 傳 `true` 拿流式回應，預設 `false`。 |

**請求**：

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

**回應**：

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

傳 `"stream": true` 時回應為 `text/event-stream`，攜帶：`response.created`、一個或多個 `response.output_text.delta`、`response.completed`。

## Anthropic 相容 API

### POST /v1/messages

Anthropic Messages 協議。請求內容中的 `system` 與陣列形態的 `content` 會在轉發上游前被壓平；回應會被轉換為 Anthropic 的 content block 結構。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-2.0-flash`。 |
| `max_tokens` | number | 是 | Anthropic 協議自身的必填項。 |
| `messages` | array | 是 | 標準 Anthropic 訊息陣列。 |
| `system` | string / array | 否 | 會在轉發上游前被壓平成純文字。 |
| `stream` | boolean | 否 | 傳 `true` 拿流式回應，預設 `false`。 |

**請求**：

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

**回應**：

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

傳 `"stream": true` 時回應為 `text/event-stream`，攜帶標準 Anthropic 事件序列：`message_start`、`content_block_start`、一個或多個 `content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。

> [!IMPORTANT]
> 若 `content`（或 `system`）陣列裡出現無法對應到內部純文字格式的區塊——任何非 `text` 型別，例如 `image`、`tool_use`、`tool_result`——閘道會在轉發上游前直接回傳 `400`，而不是像早期版本那樣靜默丟棄該區塊。報文裡那句 `不支持的内容块类型: image（本网关仅支持 text）` 中的區塊型別會換成實際收到的值。

## Gemini 原生 API

### GET /v1beta/models

Gemini 格式的模型列表。不收任何參數。

**請求**：

```bash
curl http://localhost:8080/v1beta/models \
  -H "x-goog-api-key: your-gateway-token"
```

**回應**：

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

Gemini generateContent 協議，非流式。請求內容中的 `systemInstruction` 與 `contents` 會在轉發上游前被轉換為 messages。模型名寫在路徑裡，不在請求內容中。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `contents` | array | 是 | 標準 Gemini 內容陣列。 |
| `systemInstruction` | object | 否 | 會被轉換成一條 system 訊息。 |

**請求**：

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:generateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": { "parts": [{ "text": "你是一個樂於助人的助理。" }] },
    "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }]
  }'
```

**回應**：

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

### POST /v1beta/models/{model}:streamGenerateContent

請求內容形態與 `generateContent` 相同，路徑以 `:streamGenerateContent` 結尾。回應為 `text/event-stream`，每個事件是不帶 `event:` 欄位的 `data:` 行，沒有 `[DONE]` 終止標記——流結束時直接關閉。

**請求**：

```bash
curl -X POST "http://localhost:8080/v1beta/models/agnes-2.0-flash:streamGenerateContent?key=your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "contents": [{ "role": "user", "parts": [{ "text": "你好" }] }] }'
```

**回應**：

```text
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}
```

## 圖片與影片 API

### POST /v1/images/generations

同步圖片生成。請求內容與回應內容原樣轉發/透傳自上游 Agnes API——以下範例反映的是目前上游的契約，而不是本閘道自訂的格式。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-image-2.1-flash` 或 `agnes-image-2.0-flash`。 |
| `prompt` | string | 是 | 原樣轉發給上游。 |

**請求**：

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "一隻貓" }'
```

**回應**：

```json
{ "created": 1735689600, "data": [{ "url": "https://example.com/generated-image.png" }] }
```

### POST /v1/videos

建立一個影片生成任務並立即回傳，任務在上游非同步執行。請求內容原樣轉發，回應內容原樣透傳。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `model` | string | 是 | 取 `agnes-video-v2.0`。 |
| `prompt` | string | 是 | 原樣轉發給上游。 |

**請求**：

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "一隻貓在跑" }'
```

> [!WARNING]
> 下面這段回應內容的形狀未經真實上游核實：它照抄的是本倉測試夾具。閘道對回應內容原樣透傳，不對它的結構做任何假設。

**回應**：

```json
{ "id": "task-1", "status": "queued" }
```

### GET /v1/videos/{id}

輪詢此前建立的影片任務。回應內容原樣透傳自上游。

**請求**：

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

**回應**：

```json
{ "id": "task-1", "status": "completed", "url": "https://example.com/generated-video.mp4" }
```

閘道在轉發之前先校驗任務識別碼的形狀，**只接受 `A-Za-z0-9_- (1-128)`**：前一段是允許的字元集，括號裡是長度的下界與上界。不符合的一律 400，且**一次上游請求都不會發出**。400 的報文裡逐字帶著這個形狀，照著它把識別碼貼回來即可。

> [!WARNING]
> 任務識別碼的形狀判據未經真實上游核實：它是從本倉測試夾具裡那個識別碼**外推**出來的字元集與長度上界，不是照抄。上游真發出別的形狀時，閘道先回一個 400，不會把它轉給上游——那時改請求參數沒有用，得改閘道。

## 管理 API

`/admin` 管理面板（靜態資源隨建置內嵌）由 `/admin/api/*` 這一族介面驅動。它們與四種協議端點**完全隔離**：只認 `x-admin-key` 請求標頭、只認 `ADMIN_TOKEN`，不接受 `Authorization: Bearer`，也不接受 `?key=`（口令進 URL 會落進瀏覽器歷史、Referer 與各級存取日誌）。

沒有設定 `ADMIN_TOKEN`、或它不滿足硬規則（首尾有空白、含非可列印 ASCII、短於 24 位）時，**整棵 `/admin` 樹都不註冊**——存取它得到 `404` 而不是 `401`，不洩漏「這裡有個後台」。

> [!WARNING]
> 管理介面的回應裡沒有任何一處會回顯池裡 key 的明文，也沒有任何 reveal 端點。但拿到 `ADMIN_TOKEN` 的人可以清空整個池、改掉 `GATEWAY_TOKEN`、把註冊機打開——**請把它當成比中轉口令更要緊的那一把**。

### GET /admin/api/session

登入探針。面板拿它驗證「這把口令能不能用」，**不回傳任何設定或池子資訊**。

**請求**：

```bash
curl http://localhost:8080/admin/api/session \
  -H "x-admin-key: your-admin-token"
```

**回應**：

```json
{ "ok": true, "version": "0.1.0" }
```

### GET /admin/api/capabilities

雙執行環境差異的**唯一出口**：面板啟動時呼叫一次，所有形態分支都讀它。零儲存存取。

**請求**：

```bash
curl http://localhost:8080/admin/api/capabilities \
  -H "x-admin-key: your-admin-token"
```

**回應**：

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

概覽頁的一次取數：版本、伺服器時鐘、執行環境、行程指標、儲存健康、池健康、Tier-1 池級彙總、兩條新鮮度與設定摘要。

> [!NOTE]
> `poolStats` 是**近似值**（`approximate: true`）：並行下少計，且最多晚一個 `POOL_TOUCH_INTERVAL_MS` 落盤。面板必須把這個近似標記畫出來，不許悄悄當精確值用。

**請求**：

```bash
curl http://localhost:8080/admin/api/overview \
  -H "x-admin-key: your-admin-token"
```

**回應**：

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

四協議 × 模型的靜態目錄。**零儲存讀**，全部來自模組級常數——整合範例卡、除錯台與模型表三處都從這裡取數，一個端點路徑都不在前端寫死。

**請求**：

```bash
curl http://localhost:8080/admin/api/models \
  -H "x-admin-key: your-admin-token"
```

**回應**：

```json
{
  "protocols": [{ "id": "openai", "label": "OpenAI Chat Completions", "method": "POST", "pathTemplate": "/v1/chat/completions", "upstreamPath": "/chat/completions" }],
  "media": [{ "id": "image.generate", "method": "POST", "pathTemplate": "/v1/images/generations" }],
  "models": [{ "id": "agnes-2.0-flash", "modality": "chat" }],
  "samplePrompt": "ping"
}
```

### GET /admin/api/keys

Key 池唯讀列表，帶篩選與分頁。**投影裡永遠沒有明文 key。**

**請求體**：本端點只收查詢參數，不收請求內容。

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `q` | string | 否 | 模糊比對（備註、id 片段等）。 |
| `bucket` | string | 否 | 按分檔篩選；不是合法檔位時整個忽略。 |
| `page` | number | 否 | 1 基頁號，越界時回落到 1。 |
| `size` | number | 否 | 每頁條數，預設 20，上限 200。 |

**請求**：

```bash
curl "http://localhost:8080/admin/api/keys?bucket=fresh&page=1&size=20" \
  -H "x-admin-key: your-admin-token"
```

**回應**：

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
> `counts` **永遠按整池算**，不受本次篩選影響：篩選器旁邊那幾個數字是「切換過去能看到幾條」，拿篩完的集合去算就恆等於目前這一檔的條數，另外三檔全是 0。

### POST /admin/api/keys

批次匯入 key。三個回傳陣列裝的分別是 id、id 與**輸入裡的位置**（1 基），沒有一項是明文。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `keys` | array | 是 | 字串陣列；元素型別不對時整體 `400`，不算進 `invalid`。 |
| `resetExisting` | boolean | 否 | 勾選後會清掉已存在 key 的冷卻、strikes 與剔除標記，預設 `false`。 |

**請求**：

```bash
curl -X POST http://localhost:8080/admin/api/keys \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "keys": ["sk-aaa", "sk-bbb"], "resetExisting": false }'
```

**回應**：

```json
{ "added": ["9f2c…"], "duplicated": ["3b71…"], "invalid": [2], "reset": 0 }
```

> [!IMPORTANT]
> `reset` 與 `duplicated.length` **不是一個數**：本批新建的那把被貼第二遍時也算重複，但它談不上「被重置」。面板要顯示的是 `reset`，顯示 `duplicated.length` 就是在說謊。

### POST /admin/api/keys/bulk

批次操作，逐項回傳結果。**只有三個動作**，與批次列上的三顆按鈕逐條對應；沒有「批次啟用」「批次解除剔除」——那兩個是「讓更多 key 重新上場」的動作，逐把點比一次點全部安全。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `op` | string | 是 | 只能是 `disable` / `clearCooldown` / `delete` 之一。 |
| `ids` | array | 是 | 字串陣列，一次最多 200 項。 |

**請求**：

```bash
curl -X POST http://localhost:8080/admin/api/keys/bulk \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "op": "clearCooldown", "ids": ["9f2c…", "3b71…"] }'
```

**回應**：

```json
{ "results": [{ "id": "9f2c…", "ok": true, "reason": null }, { "id": "3b71…", "ok": false, "reason": "not_found" }] }
```

### PATCH /admin/api/keys/{id}

改一把 key：停用/啟用、備註、清冷卻、清 strikes、解除剔除、重設用量計數。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `disabled` | boolean | 否 | 停用或啟用這把 key。 |
| `note` | string | 否 | 備註。 |
| `clearCooldown` | boolean | 否 | 動作而非狀態：傳 `false` 等於沒傳。 |
| `clearStrikes` | boolean | 否 | 動作而非狀態：傳 `false` 等於沒傳。 |
| `unevict` | boolean | 否 | 動作而非狀態：傳 `false` 等於沒傳。 |
| `clearStats` | boolean | 否 | 動作而非狀態：傳 `false` 等於沒傳。 |

**請求**：

```bash
curl -X PATCH http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "disabled": false, "clearCooldown": true }'
```

**回應**：

```json
{ "ok": true }
```

### DELETE /admin/api/keys/{id}

刪除一把 key。成功是 `204`，沒有回應內容。

> [!WARNING]
> 刪除**不可撤銷**：記錄裡那把 key 材料就此消失，沒有任何地方還留著它。所以它是唯一一條帶前置條件的寫操作——**沒停用的 key 刪不掉**，會回 `409` 加頂層 `reason: "must_disable_first"`。

**請求**：

```bash
curl -X DELETE http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token"
```

**回應**：

```json
{ "error": { "type": "conflict", "code": "must_disable_first", "message": "请先停用这把 key 再删除（删除不可撤销，而停用随时可以撤销）" }, "reason": "must_disable_first" }
```

### POST /admin/api/keys/purge

清空整個 Key 池。危險區那兩顆按鈕之一。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `expect` | number | 是 | 你在螢幕上看到的池大小，非負整數；對不上就 `409`，一把都不刪。 |

**請求**：

```bash
curl -X POST http://localhost:8080/admin/api/keys/purge \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "expect": 3 }'
```

**回應**：

```json
{ "deleted": 3, "remaining": 0, "expected": 3 }
```

> [!WARNING]
> 每把 key 的用量歷史住在這條記錄**裡面**，刪記錄就是刪歷史，沒有第二份。`remaining` 是**回讀**出來的，不是常數 `0`——它順帶把「索引說空了、而儲存裡還躺著記錄」那一檔如實報出來。

### GET /admin/api/keys/{id}/usage

單把 key 的 Tier-1 計數。**與 Tier-2 完全無關**：Tier-2 關著時照樣可用。

**請求**：

```bash
curl http://localhost:8080/admin/api/keys/9f2c/usage \
  -H "x-admin-key: your-admin-token"
```

**回應**：

```json
{
  "id": "9f2c",
  "stats": { "requests": 12, "success": 11, "failed": 1, "clientErrors": 0, "lastErrorAt": 1735689500000, "lastErrorKind": "rate limited" },
  "approximate": true,
  "generatedAt": 1735689600000
}
```

### POST /admin/api/keys/{id}/verify

單把 key 的驗活：拿這把 key 向上游打一次最小請求，**只回狀態碼，不回內容**。

**請求體**：本端點**不收任何選項**，空內容放行；帶了欄位一律 `400`——`{"model":"…"}` 這種「我以為能指定模型」的寫法在寬鬆實作下是一次靜默誤操作。

**請求**：

```bash
curl -X POST http://localhost:8080/admin/api/keys/9f2c/verify \
  -H "x-admin-key: your-admin-token"
```

**回應**：

```json
{ "ok": true, "status": 200, "latencyMs": 412, "reason": null }
```

> [!NOTE]
> 這條端點帶對外探測護欄，粒度是 `verify:<id>`：同一把 key 連著點會拿到 `429` 加頂層 `reason`，而驗別的 key 不受影響。它一次儲存寫都不產生。

### GET /admin/api/events

事件板塊的取數。歸併結果按 `ts` 降序。

**請求體**：本端點只收查詢參數，不收請求內容。

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `after` | number | 否 | 游標，只要比它新的條目。 |
| `level` | string | 否 | 按級別篩選；不是合法級別時整個忽略。 |
| `limit` | number | 否 | 本頁條數，預設 200，上限 500。 |

**請求**：

```bash
curl "http://localhost:8080/admin/api/events?level=warn&limit=50" \
  -H "x-admin-key: your-admin-token"
```

**回應**：

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
> `cursor` 只有兩種合法值：**有限數字，或 `null`**。永遠不會是「欄位不存在」——那會讓前端把「沒有新事件」與「後端契約壞了」混成一件事。

### GET /admin/api/events/download

把歸併結果整段匯出。回傳的是 `text/plain`，**逐行 JSON**（不是一個 JSON 陣列）：這是給人在終端裡 `grep` 用的格式，不是給程式反序列化用的 API。

**請求**：

```bash
curl -OJ http://localhost:8080/admin/api/events/download \
  -H "x-admin-key: your-admin-token"
```

**回應**：

```text
{"ts":1735689600000,"level":"warn","event":"key.restored","msg":"面板解除了一把 key 上的限制"}
{"ts":1735689500000,"level":"info","event":"key.added","msg":"面板导入了新的 key"}
```

### GET /admin/api/config

讀目前生效設定。憑證欄位只報「設沒設」，不報值。

> [!NOTE]
> 從未儲存過的欄位上，`stored` 是**不存在，而不是 `null`**：它裝的是儲存裡那份 `config` 的原始值，而 `undefined` 過不了 JSON。下面這個例子是一台全新部署——可與 `PUT` 的回應對照，同一個欄位在那邊有自己的 `stored`。

**請求**：

```bash
curl http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token"
```

**回應**：

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

寫設定。順序是**校驗 → 寫 → 失效快取 → 回讀**，一步都不能調換：先寫後校驗的話，一份非法設定已經落盤，而回應卻是 `400`。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `patch` | object | 是 | 只帶你要改的那幾條路徑；不認識的頂層欄位一律 `400`。 |

**請求**：

```bash
curl -X PUT http://localhost:8080/admin/api/config \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**回應**：

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
> 憑證欄位傳空字串一律是「不改」，**不是清空**。清空只有 `POST /admin/api/config/secrets/clear` 這一條路——把空字串實作成清空，後果是維運儲存一次設定頁就抹掉了 `gatewayToken`，而熱實例當場看不出任何異常。

### POST /admin/api/config/validate

乾跑一次校驗，一個位元組都不寫。它與真跑對同一份輸入給出同一組錯誤碼。

**請求體**：與 `PUT /admin/api/config` 逐字相同（一個 `patch` 物件）。

**請求**：

```bash
curl -X POST http://localhost:8080/admin/api/config/validate \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "patch": { "upstreamTimeoutMs": 90000 } }'
```

**回應**：

```json
{ "ok": true, "changed": ["upstreamTimeoutMs"] }
```

### POST /admin/api/config/secrets/clear

明確清空一把憑證。**這是清空憑證的唯一入口。**

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `path` | string | 是 | 只能是憑證欄位之一，別的路徑一律 `400`。 |

**請求**：

```bash
curl -X POST http://localhost:8080/admin/api/config/secrets/clear \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "path": "gatewayToken" }'
```

**回應**：

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

把儲存裡那份設定整把寫回 `{}`。危險區那兩顆按鈕的另一顆。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `confirm` | boolean | 是 | 必須明確傳 `true`，這一步不可撤銷。 |

**請求**：

```bash
curl -X POST http://localhost:8080/admin/api/config/reset \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "confirm": true }'
```

**回應**：

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
> `appliedAt` **不是「已生效」的承諾**，它就是伺服器落盤的那一刻。別的副本/別的 isolate 多久能看見，由 `propagation` 裡那三個數說了算——面板不許把它算繪成「已重設並生效」。

### POST /admin/api/registrar/tend

手動觸發一輪補池。成功是 `202`（已開始），不是 `200`。

**請求體**：

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `channel` | string | 否 | 只能是 `moemail` 或 `yyds`；不給就按設定裡的主/備通道鏈跑。 |

**請求**：

```bash
curl -X POST http://localhost:8080/admin/api/registrar/tend \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "channel": "moemail" }'
```

**回應**：

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
> `remaining` 在成功那一支也照樣給：只在耗盡那一支給它，等於讓維運毫不知情地撞上一堵牆。註冊機沒啟用是 `409` 加 `reason`，通道沒配憑證也是 `409`——**那不是「這條路由不存在」**。

### GET /admin/api/registrar/status

補池板塊的取數：註冊機開沒開、兩條通道各自的接入狀態、護欄還剩幾次、補池歷史。

> [!IMPORTANT]
> 這裡的 `counted` **不叫 `available`**：它的判據是「佔名額數」，被停用的與正在冷卻的 key 都算在裡面，而這兩種恰恰都不能打上游。真正的可用數是並列的那個 `fresh`——**兩者都住在 `pool` 物件裡，不在頂層**。

**請求**：

```bash
curl http://localhost:8080/admin/api/registrar/status \
  -H "x-admin-key: your-admin-token"
```

**回應**：

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

通道連通性測試：向信箱服務發一次唯讀 GET，不建任何信箱、不領任何 key。

回應裡的 `domains` 是**探到的網域個數**（整數），不是網域清單——這條端點刻意不回顯任何上游細節。

**請求體**：本端點不收請求內容，通道名寫在路徑裡（只能是 `moemail` 或 `yyds`）。

**請求**：

```bash
curl -X POST http://localhost:8080/admin/api/registrar/channels/moemail/test \
  -H "x-admin-key: your-admin-token"
```

**回應**：

```json
{ "ok": true, "channel": "moemail", "domains": 3, "latencyMs": 128 }
```

### GET /admin/api/usage

Tier-2 用量的區間彙總。日期一律 UTC，並且**在回應裡說出來**。

兩個參數**只認 epoch 毫秒整數**：不是整數、或者是負數，一律 `400`，伺服端不做「善意修正」——`2026-08-01` 這種日期字串會被判成非法。**`days` 不是參數**：它是面板按鈕的檔位，伺服端不認，前端只發 `from` / `to`。

**請求體**：本端點只收查詢參數，不收請求內容。

| 參數 | 型別 | 必填 | 說明 |
|----|----|----|----|
| `from` | number | 否 | 區間起點，**epoch 毫秒整數**；預設是 `to - 86400000`。早於保留期起點的會被夾到起點，並把 `range.clamped` 設為真。 |
| `to` | number | 否 | 區間終點，**epoch 毫秒整數**；預設是伺服端當前時刻。晚於當前時刻的會被夾到當前時刻，並把 `range.clamped` 設為真。 |

**請求**：

```bash
curl "http://localhost:8080/admin/api/usage?from=1735689600000&to=1735775999999" \
  -H "x-admin-key: your-admin-token"
```

**回應**：

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
> Tier-2 關著時這條端點**照常回 200**，只是如實說 `tier: "off"`——回 `503` 會讓面板把「維運沒打開統計」算繪成「後端壞了」。「讀不出來」「時鐘壞了」「那天不在保留期裡」各有各的 `note`，不許混成同一句「沒有資料」。

### GET /admin/api/usage/{date}

某一天的用量明細：按小時、按模型、按協議三張切片。

**請求體**：本端點不收請求內容，日期寫在路徑裡，必須是 UTC 的 `YYYY-MM-DD`，否則 `400`。**與上面那條區間端點的口徑刻意不同**：那條只認 epoch 毫秒整數，這條只認日期字串，兩者不通用。

**請求**：

```bash
curl http://localhost:8080/admin/api/usage/2026-08-30 \
  -H "x-admin-key: your-admin-token"
```

**回應**：

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

## 系統 API

### GET /health

健康檢查（Docker 探針適配）。**無需認證**，因此它也不回顯任何底層錯誤細節。

**請求**：

```bash
curl http://localhost:8080/health
```

**回應**：

```json
{ "status": "ok", "version": "0.1.0", "storage": { "writable": true } }
```

`storage.writable` 報告的是「key 池所在的儲存是否真的寫得進去」。它由啟動時的一次探測與執行期每一次真實寫操作共同維護，健康檢查自身不寫盤。儲存不可寫時回傳 **HTTP `503`**，`status` 變成 `degraded` 並附一句 `detail`（Docker 部署常見於繫結掛載的主機目錄擁有者與容器內執行使用者不一致，詳見容器日誌）。

> [!NOTE]
> 映像內建的 `HEALTHCHECK` 按回應是否成功判定，因此這種容器會被 Docker 標成 unhealthy。具體的底層錯誤只寫進容器日誌，不在這個不認證端點上回顯。

## 請求範例

base URL 用**標準裸前綴**：OpenAI = `{host}/v1`，Anthropic = `{host}`（SDK 自動補 `/v1/messages`），Gemini = `{host}/v1beta`。

### Python - OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-gateway-token",
    base_url="http://localhost:8080/v1"
)

# 非流式請求
response = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.choices[0].message.content)

# 流式請求
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
# 非流式請求
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 流式請求
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## 後續步驟

- 用法與四種協議的 SDK 接入：[USAGE.md](USAGE.md)
- 部署兩種形態與全部環境變數：[DEPLOY.md](DEPLOY.md)
- Web 管理面板：[ADMIN.md](ADMIN.md)
- 註冊機（自動補池）：[REGISTRAR.md](REGISTRAR.md)
