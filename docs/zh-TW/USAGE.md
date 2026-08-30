# 使用指南

本文講的是**用戶端這一側**：把各協議官方 SDK 指向一台已經跑起來的閘道，怎麼發第一個請求、怎麼開串流、被拒時先看哪一格。端點逐條的請求 / 回應契約在 [API.md](API.md)，把閘道跑起來的兩條路在 [DEPLOY.md](DEPLOY.md)。

> [!TIP]
> agnes2api 在協議層實作了四種協議，因此**不需要專門的用戶端**——把各協議官方 SDK 的基址指向本閘道，`GATEWAY_TOKEN` 當作 API key 傳入即可。

## 開始之前

### 你需要哪三樣

| 東西 | 從哪兒來 |
|------|----------|
| 閘道位址 | Worker 的 `*.workers.dev` 網域、你的自訂網域，或 Docker 部署時的 `http://localhost:8080` |
| 閘道口令 | 部署時設定的 `GATEWAY_TOKEN`，見 [部署指南](DEPLOY.md#環境變數) |
| 一把可用的上游 key | 由管理面板匯入池子，見 [管理面板](ADMIN.md) |

### 範例裡的佔位符

下文所有範例統一用這兩個佔位符，照抄之前先替換：

| 佔位符 | 換成什麼 |
|--------|----------|
| `http://localhost:8080` | 你實際部署的閘道位址 |
| `your-gateway-token` | 你真實的 `GATEWAY_TOKEN` |

> [!NOTE]
> 閘道自己不產內容，它只是把請求轉發給上游 Agnes，再把回應翻譯回你用的那種協議。池子裡一把可用 key 都沒有時，任何協議端點都直接回傳 `503`，那一族的 `reason` 見本文最後一節。

## 憑證傳遞方式

### 四種等價寫法

不同 SDK 各自傳送自己預設的請求標頭，閘道對以下四種一視同仁地接受——不需要為某個 SDK 做額外設定：

| 方式 | 由誰傳送 |
|------|----------|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` 查詢參數 | 手動呼叫/瀏覽器場景 |

`/v1/*` 與 `/v1beta/*` 下的全部路由都要這把憑證，`/health` 不要。

### 閘道口令不是上游 key

`GATEWAY_TOKEN` 是發給**下游使用者**的口令，與池子裡那些上游 key 完全無關——池裡的 key 一把都不會離開閘道。

> [!IMPORTANT]
> 管理介面 `/admin/api/*` **不接受**上面這四種寫法，它只認 `x-admin-key` 請求標頭、只認 `ADMIN_TOKEN`。兩把鑰匙嚴格隔離：複用中轉口令當面板口令，等於把整池 key 交給每一個下游使用者。

## 支援的模型

### 四個模型各自的落點

| 模型 | 用於 |
|------|------|
| `agnes-2.0-flash` | 對話/文字類端點 |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

### 模型名寫在請求體還是路徑裡

OpenAI、OpenAI-Responses 與 Anthropic 三種協議把模型名放在請求體的 `model` 欄位裡；Gemini 那兩條端點**寫在路徑裡**。路徑按最後一個冒號切分，所以模型名自身含冒號也處理得了。

`GET /v1/models` 回傳 OpenAI 形狀的模型列表，`GET /v1beta/models` 回傳 Gemini 形狀的同一批模型——同一條路徑沒法同時回傳兩種格式，按你用的 SDK 選一條即可。

> [!NOTE]
> 這兩條列表都是**固定表**，四個模型一個不多一個不少，它不反映池子裡此刻有沒有可用 key。池子空不空要看管理面板，或者直接發一次請求看回不回 `503`。

## OpenAI SDK

### 非串流呼叫

先把 `base_url` 指到閘道，再照常呼叫 `chat.completions.create`，其餘參數與直連 OpenAI 一模一樣：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-gateway-token",
)

resp = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

### 串流呼叫

傳 `stream=True`，走訪回傳的產生器即可，與直接對接 OpenAI 完全一樣：

```python
stream = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

閘道對這條協議的串流位元組**原樣透傳**，既不解析也不改寫：`Content-Type: text/event-stream`，標準的 OpenAI 風格 `data: {...}` 分片，以 `data: [DONE]` 結束。

### base_url 要帶 `/v1`

> [!IMPORTANT]
> 這一條與下面兩個 SDK **相反**：`openai` SDK 的 `base_url` **要帶** `/v1`，它會在其後直接拼 `/chat/completions`。漏掉 `/v1` 的話 SDK 會去打 `/chat/completions`，閘道上沒有這條路徑，回的是 `404` 而不是任何有用的錯誤訊息。

## Anthropic SDK

### 非串流呼叫

憑證用 `api_key` 傳進去，SDK 會自己把它放進 `x-api-key` 請求標頭，不用你手動加：

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:8080",
    api_key="your-gateway-token",
)

msg = client.messages.create(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
)
print(msg.content[0].text)
```

### 串流呼叫

```python
with client.messages.stream(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

串流回應是標準的 Anthropic 事件序列：`message_start`、`content_block_start`、一個或多個 `content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。

### base_url 不帶 `/v1`

> [!IMPORTANT]
> SDK 的 `base_url` **不帶** `/v1`——SDK 內部會自己拼上 `/v1/messages`。寫成 `http://localhost:8080/v1` 會讓它去打 `/v1/v1/messages`。

> [!WARNING]
> `content`（或 `system`）陣列裡出現任何非 `text` 類型的區塊——`image`、`tool_use`、`tool_result` 都算——閘道會在轉發上游**之前**直接回傳 `400`，而不是靜默丟掉那一塊。多模態輸入這條協議今天走不通，要發圖片請走 `/v1/images/generations`。

## Google GenAI SDK

### 非串流呼叫

這個 SDK 改基址的入口在 `http_options` 裡，不是建構函式的位置參數：

```python
from google import genai

client = genai.Client(
    api_key="your-gateway-token",
    http_options={"base_url": "http://localhost:8080"},
)

resp = client.models.generate_content(
    model="agnes-2.0-flash",
    contents="你好",
)
print(resp.text)
```

### 串流呼叫

```python
for chunk in client.models.generate_content_stream(
    model="agnes-2.0-flash",
    contents="你好",
):
    print(chunk.text or "", end="")
```

串流回應的每個事件是不帶 `event:` 欄位的 `data:` 行，**沒有 `[DONE]` 終止標記**——串流結束時直接關閉連線。按這條協議自己寫解析器的話，別去等一個永遠不來的終止影格。

### base_url 不帶 `/v1beta`

> [!IMPORTANT]
> SDK 的 `base_url` 同樣**不帶** `/v1beta`——SDK 會自己拼上 `/v1beta/models/...`。這個 SDK 在設定了自訂 base URL 之後預設傳送 `x-goog-api-key` 請求標頭，閘道認這一條，不用另外設定。

## OpenAI Responses 協議

OpenAI-Responses 協議目前還沒有被廣泛使用的專用 SDK，因此這一節直接用純 HTTP 呼叫示範。

### 非串流呼叫

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "你是一個樂於助人的助手。",
    "input": "你好"
  }'
```

`instructions` 會被轉換成一條 system 訊息，陣列形態的 `input` 會在轉發上游前被轉換為 messages；回應被轉換回 `output[]` 結構。

### 串流呼叫

多帶一個 `stream` 欄位，並給 curl 加 `-N` 關掉緩衝，否則你會等到最後才一次看到全部輸出：

```bash
curl -N -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "你好",
    "stream": true
  }'
```

### 串流事件序列

| 事件 | 何時出現 |
|------|----------|
| `response.created` | 串流的第一影格 |
| `response.output_text.delta` | 一個或多個，正文增量都在這裡 |
| `response.completed` | 串流的最後一影格 |

## 圖片與影片

### 產生一張圖

同步端點：它在上游把圖產完之前不會回傳，因此這一條走的是下面疑難排解裡那個同步逾時預算。

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "一隻貓" }'
```

### 建一個影片任務

建任務這一步立刻回傳，影片本身在上游非同步跑完，因此要靠下一節的輪詢拿結果：

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "一隻貓在跑" }'
```

### 輪詢任務狀態

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

> [!IMPORTANT]
> 閘道在轉發之前先校驗任務識別碼的形狀，**只接受 `A-Za-z0-9_- (1-128)`**：前一段是允許的字元集，括號裡是長度的下界與上界。不匹配的一律 `400`，而且**一次上游請求都不會發出**——那時改上游參數沒有用。`400` 的訊息裡逐字帶著這個形狀，照著它把識別碼貼回來即可。

## 通用 OpenAI 相容用戶端

### 填哪幾個格子

大多數第三方用戶端只給你三四個輸入框。對照著填：

| 用戶端裡的格子 | 填什麼 |
|----------------|--------|
| 介面位址 / base URL | `http://localhost:8080/v1` |
| API Key | 你的 `GATEWAY_TOKEN` |
| 模型名 | `agnes-2.0-flash` |
| 組織 / 專案 ID | 留空，閘道不看這兩個欄位 |

### 用戶端拉不到模型列表時

有些用戶端在啟動時先拉一次 `GET /v1/models`，拉不到就不讓你發訊息。先按上一節的四種寫法確認憑證發得出去；確認之後仍拉不到的，絕大多數是用戶端把 `/v1` 拼了兩次——把位址欄裡的 `/v1` 去掉再試一次。

## 對話上下文

### 閘道不保存歷史

閘道**不保存任何對話狀態**：每一次請求都是獨立的一次轉發，池子每次都可能換一把上游 key。要做多輪對話，歷史由用戶端自己維護並在每一輪完整重發——各協議官方 SDK 預設就是這麼做的。

### 四種協議各自把歷史放在哪

| 協議 | 歷史放在哪 | 系統提示放在哪 |
|------|------------|----------------|
| OpenAI | `messages` 陣列 | `messages` 裡 `role` 為 system 的那一條 |
| OpenAI-Responses | `input` 陣列 | `instructions` 欄位 |
| Anthropic | `messages` 陣列 | `system` 欄位 |
| Gemini | `contents` 陣列 | `systemInstruction` 欄位 |

## 疑難排解

### `401` —— 憑證沒送到

缺少或錯誤的閘道憑證。先確認發出去的是 `GATEWAY_TOKEN` 而不是上游 key，再確認 SDK 真的送了上面四種寫法之一。上游自己的 `401` 回應體**絕不**轉發給你——那裡是上游最可能回顯 key 片段的地方。

### `404` —— 路徑拼錯了

十有八九是 `base_url` 多了或少了一段前綴。三個 SDK 的規矩各不相同，逐條見上面三節的「base_url」小節。

### `503` —— 池子裡沒有可用 key

閘道在發起上游請求**之前**就回傳它，回應體頂層帶一個機器可讀的 `reason`：

| `reason` | 是否自癒 | 該做什麼 |
|----------|----------|----------|
| `pool_empty` | – | 還沒匯入任何 key，去管理面板匯一把。 |
| `all_cooling` | **會** | 全部 key 冷卻中，回應標頭 `Retry-After` 給出最早恢復時刻，等它。 |
| `all_disabled` | **不會** | 全部 key 被管理員手工停用，去面板重新啟用——**憑證本身沒問題，別去換 key**。 |
| `all_evicted` | **不會** | 全部 key 因憑證失效被永久剔除，換 key。 |
| `upstream_error` | **會** | key 可用但上游每次嘗試都失敗，等一等再看。 |

### `504` —— 同步端點用盡了預算

圖片生成、影片建任務，以及**所有非串流對話**走同步逾時預算 `UPSTREAM_SYNC_TIMEOUT_MS`（預設 120000 毫秒）。這個總預算就是用戶端的最壞等待時間，與池子大小無關。收到 `504` 時閘道**沒有**懲罰任何 key。要麼把預算調大，要麼改用串流。

### `400` —— 請求體過不了閘道這一關

四類成因：Anthropic 協議裡出現非 `text` 內容區塊、影片任務識別碼形狀非法、管理介面的請求體欄位不認識、管理介面缺必填項。前兩類在上面對應的小節裡各有一條說明。

### `502` —— 上游回了 200 但不是 JSON

只發生在需要做格式轉換的那幾條路由上。閘道自己沒法把非 JSON 的回應體翻譯成你要的協議形狀，於是如實報錯而不是偽造一個空回應。這一類重試一次往往就好了。

## 後續步驟

- 部署兩種形態與全部環境變數：[DEPLOY.md](DEPLOY.md)
- Web 管理面板：[ADMIN.md](ADMIN.md)
- 註冊機（自動補池）：[REGISTRAR.md](REGISTRAR.md)
- 端點清單與請求 / 回應形狀：[API.md](API.md)
- 專案概況與快速上手：[README.md](../../README.md)
- 回報問題與提問：[GitHub Issues](https://github.com/xwteam/agnes2api/issues)
