<div align="center">

<img src="../logo.png" width="128" height="128" alt="agnes2api">

<h1>agnes2api</h1>
<h3>多協議 AI 中轉 · Agnes 後端</h3>
<p>一套程式碼同時相容 OpenAI / Anthropic / OpenAI-Responses / Gemini 四大 AI SDK，由 Agnes AI 後端統一供給對話與圖片、影片生成，Cloudflare Worker 與 Node 雙執行時共用同一份轉發核心，Docker 快速部署。</p>

<p>
  <img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Hono-4.13-E36002?style=flat-square&logo=hono&logoColor=white" alt="Hono">
  <img src="https://img.shields.io/badge/Cloudflare%20Workers-edge-F38020?style=flat-square&logo=cloudflareworkers&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Docker-20.10+-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20arm64-4285F4?style=flat-square&logo=linux&logoColor=white" alt="Arch">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/version-v0.1.1-success?style=flat-square" alt="Version">
</p>

<p>
  <a href="#-最近更新">最近更新</a> &bull;
  <a href="#-核心功能">核心功能</a> &bull;
  <a href="#-系統需求">系統需求</a> &bull;
  <a href="#-快速部署">快速部署</a> &bull;
  <a href="#-接入範例">接入範例</a> &bull;
  <a href="#-api-端點">API 端點</a> &bull;
  <a href="#-設定說明">設定說明</a> &bull;
  <a href="#-注意事項">注意事項</a> &bull;
  <a href="#-開發路線">開發路線</a>
</p>

<p>
  📖 文件語言：<a href="../zh-CN/README.md">简体中文</a> | 繁體中文 | <a href="../en/README.md">English</a> | <a href="../ja/README.md">日本語</a> | <a href="../ko/README.md">한국어</a>
</p>

<br>

<a href="https://github.com/xwteam/agnes2api/issues"><img src="https://img.shields.io/github/issues/xwteam/agnes2api?style=flat-square" alt="Issues"></a>
<a href="https://github.com/xwteam/agnes2api/stargazers"><img src="https://img.shields.io/github/stars/xwteam/agnes2api?style=flat-square" alt="Stars"></a>

</div>

---

> [!NOTE]
> 本專案僅供研究和學習用途，請合理使用，不建議用於任何商業目的。

> [!WARNING]
> 本專案與 Agnes AI 無任何關聯或授權關係。它把 Agnes AI 服務包裝成多協議相容 API，這種用法可能不符合上游的服務條款；大量取得免費額度的做法與上游條款存在張力。使用風險自負，作者不對任何帳號處罰或資料遺失承擔責任。

> [!TIP]
> 上游由一池 Agnes API key 供給：對話走 `agnes-2.0-flash`，圖片走 `agnes-image-2.1-flash` 與 `agnes-image-2.0-flash`，影片走 `agnes-video-v2.0`（建任務 + 輪詢兩段式）。key 池會自癒——上游 `429`/`402` 讓對應 key 進入冷卻，`401`/`403` 把它永久剔除，連續瞬時故障累積到 `MAX_STRIKES` 後讓它進入長冷卻（`COOLDOWN_STRIKE_MS`，預設 30 分鐘）而不是剔除。到期自動恢復的那幾類不需要人工介入。

> [!IMPORTANT]
> **本閘道是 fail-closed 的，不存在「不設定口令也能用」這種狀態。** `GATEWAY_TOKEN` 是必填項，缺少時閘道**直接拒絕啟動**（`src/core/config.ts` 拋 `缺少 GATEWAY_TOKEN，网关无法启动`）；注意這條啟動路徑**只判存在、不判長度**，短口令照樣能把閘道拉起來，夠不夠強由你自己負責。管理面板預設**不存在**：未設定 `ADMIN_TOKEN` 時整棵 `/admin` 樹根本不註冊、存取得到 404；設了但短於 24 位（`ADMIN_TOKEN_MIN_LENGTH`）同樣不啟用，日誌寫「管理面板未啟用（閘道轉發不受影響）」；設了且夠長、卻與 `GATEWAY_TOKEN` **相同**時，管理介面持續回傳 503（閘道轉發照常）。`ADMIN_TOKEN` 只從環境變數讀、不從儲存讀，面板無法自助輪換自己的鑰匙。

---

## 📝 最近更新

| 日期 | 更新內容 |
|------|----------|
| 2026-08-31 | v0.1.1 - 🧹 **整備版**：把內部研發編號從公開倉大面積清掉。面板資源那 470 處會隨 /admin/js/*.js 發給每個打開面板的訪客，是唯一真正外洩的一塊；其餘散在原始碼、測試、門禁指令稿、出貨文件與提交訊息裡。順帶修好「一條排版豁免被靜靜升級成洩漏豁免」和三格卡在預設逾時邊界上的測試。行為面沒有改動 |
| 2026-08-31 | v0.1.0 - 🎉 **首個版本**：四協議閘道、註冊機與管理面板一次成型，同一份程式碼同時跑 Cloudflare Worker 與 Node / Docker 兩種執行時。四條入站協議共用同一套上游排程、同一個 key 池、同一份失敗歸因；註冊機的兩條臨時信箱通道嚴格平級；面板八個板塊零建置；文件五語言各一份 |

> 完整更新日誌請查看 [CHANGELOG.md](../../CHANGELOG.md)。

---

## 🌟 核心功能

> 📖 詳細使用文件：[USAGE.md](USAGE.md)

### 🔌 四協議前端，一套上游

- 一個服務同時提供 **OpenAI Chat**、**Anthropic Messages**、**OpenAI Responses**、**Gemini 原生** 四種 SDK 格式，各協議官方 SDK 只改基底位址即可直連
- 四條入站協議共用同一套上游排程、同一個 key 池、同一份失敗歸因，串流（SSE）在四條上都支援
- 除對話外還轉發**圖片生成**（`/v1/images/generations`）與**影片生成**（`/v1/videos` 建任務 + `/v1/videos/{id}` 輪詢的兩段式）
- 路徑只有**裸前綴**一套：OpenAI 與 Anthropic 掛在 `/v1` 下，Gemini 掛在 `/v1beta` 下

### 🔐 統一鑑權閘

- 四種憑證通道一視同仁地接受：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、查詢參數 `?key=`，正好覆蓋各協議官方 SDK 預設發送的那一種
- 閘道口令 `GATEWAY_TOKEN` **必填**，缺少時行程起不來；管理口令 `ADMIN_TOKEN` 與它是**兩把不同的鑰匙**，相同即停用管理介面
- `/health` 探活端點不鑑權，其餘全部走鑑權閘

### 🔄 key 池自癒與自動補池

> 📖 詳細註冊機文件：[REGISTRAR.md](REGISTRAR.md)

- 上游 `429`/`402` 讓對應 key 進入分級冷卻，`401`/`403` 永久剔除，連續瞬時故障累積到 `MAX_STRIKES` 後進入長冷卻（預設 30 分鐘）、到期自動恢復
- 一把 key 都用不上時如實回 `503` 並給出可分辨的 `reason`（尚未匯入 / 全部冷卻 / 全部停用 / 全部剔除 / 上游持續失敗），冷卻那一種帶 `Retry-After`
- **自動補池預設關閉**：打開 `REGISTRAR_ENABLED` 之後，可用 key 低於 `TARGET_KEYS` 時會自動註冊 Agnes 帳號補齊
- 註冊機的兩條臨時信箱通道（`yyds` / `moemail`）**嚴格平級**，主備由你自己選，不預設推薦值

### 🔀 雙執行時，同一份轉發核心

- 同一份 TypeScript 程式碼同時跑 **Cloudflare Worker**（key 池落 KV）與 **Node / Docker**（key 池落單檔案 JSON），請求處理邏輯逐字相同
- 儲存存取與流量解耦：key 池按 isolate／行程快取，只改遙測欄位的更新會被整個丟棄，穩態下儲存的讀與寫都**不隨請求量成長**
- Worker 形態的補池排程走 Cron 觸發器，Node 形態走行程內計時器，兩邊的補池語義一致

### 🖥 Web 管理面板

> 📖 詳細面板文件：[ADMIN.md](ADMIN.md)

- **預設關閉**：未設定 `ADMIN_TOKEN` 時整棵 `/admin` 樹根本不註冊，存取得到 404，而不是一個不鑑權的面板
- 八個板塊：概覽、key 池、註冊機、事件、用量、模型、除錯台、設定
- **零建置**：`admin-ui/` 原樣掛在 `/admin/` 下就是可除錯的面板，建置腳本只把它逐位元組燒進一份產物
- 口令只走 `x-admin-key` 請求標頭，不落 Cookie、不進 query

### ⚡ 高效能架構

- 基於 **TypeScript + Hono**，Worker 與 Node 兩個入口共用同一棵路由樹
- 上游回應以串流轉發為主；非串流請求原樣以 `stream:false` 發給上游，閘道解析上游那份 JSON 再翻譯成你用的協議形狀
- port 層與 adapter 層分離（儲存、抓取、日誌、信箱都是可替換的 port），契約測試在兩種執行時上各跑一遍
- 多階段 Docker 建置、非 root 執行、多架構映像檔（amd64 / arm64）、健康檢查

---

## 📋 系統需求

| 相依 | 版本 | 說明 |
|------|------|------|
| Node.js | 22.13+ | 僅從原始碼建置或直接用 Node 跑時需要；Docker 部署無需本機安裝 |
| Docker | 20.10+ | 推薦用 Docker 部署，官方映像檔多架構 |
| Agnes 帳號 | — | 需要至少一把有效的 Agnes API key（也可交給註冊機自動補池） |
| Cloudflare 帳號 | wrangler 4+ | 僅 Cloudflare Worker 形態需要：一個 KV 命名空間加一次部署 |

> [!TIP]
> 使用 Docker 部署無需本機安裝 Node.js 環境，只需 Docker 和有效的 Agnes API key 即可。部署到 Cloudflare Worker 則連伺服器都不需要，只要一個 Cloudflare 帳號和 wrangler 命令列。

---

## ⚡ 快速部署

> 📖 詳細部署文件：[DEPLOY.md](DEPLOY.md)

> **前置條件**：你需要至少一把有效的 Agnes API key，以及一個 Cloudflare 帳號（Worker 形態）或一台能跑 Docker 的機器。

### 1. 取得上游 key

在 Agnes AI 平台建立一把 API key 備用。不想手工準備也可以先把閘道跑起來，再打開註冊機讓它自動補池——兩條路都在部署文件裡寫全了。

### 2. 部署

#### Cloudflare Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xwteam/agnes2api)

一鍵部署省掉本機複製這一步，但有兩件事它替不了你：`wrangler.toml` 裡的 KV 命名空間 id（儲存庫裡那個恆為佔位符）與 `GATEWAY_TOKEN` secret——缺任何一項閘道都起不來。想全程自己走，或者部署完回來補這兩項，用下面這幾條指令：

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install

# 建一個 KV 命名空間，把回傳的 id 填進 wrangler.toml
npx wrangler kv namespace create POOL

# 閘道口令是必填的敏感值，用 secret 注入，不要寫進儲存庫
npx wrangler secret put GATEWAY_TOKEN

npx wrangler deploy
```

#### Docker

```bash
# 克隆儲存庫
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api

# 建立環境變數檔案
cp .env.example .env
```

編輯 `.env`，至少填一個閘道口令：

```env
GATEWAY_TOKEN=你的閘道口令
# 管理面板口令；不填則整棵 /admin 樹不註冊。填就必須與 GATEWAY_TOKEN 不同，且至少 24 位。
ADMIN_TOKEN=
```

啟動服務：

```bash
mkdir -p data
docker compose up -d
```

查看日誌確認啟動成功：

```bash
docker compose logs -f
# 看到監聽埠即表示啟動成功
```

> **首個映像發布之前**（或在 fork 裡），`docker compose up -d` 會回落到本機建置
> —— `docker-compose.yml` 裡那段 `build:` 就是幹這個的。

### 3. 驗證

```bash
# 健康檢查（不鑑權）。Worker 形態換成你的 https://<name>.<sub>.workers.dev
curl http://localhost:8080/health
# {"status":"ok","version":"0.1.0"}

# 查看可用模型
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"

# 發送測試請求
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","messages":[{"role":"user","content":"你好"}]}'
```

看到 AI 回覆的文字即部署成功。如果回傳 401，請檢查 API Key 是否正確。

---

## 🧪 接入範例

> [!NOTE]
> 所有請求都要帶上閘道口令。鑑權閘對以下四種憑證通道一視同仁——不需要為某個 SDK 做額外設定：
> - `Authorization: Bearer <token>`（OpenAI SDK 預設發這一種）
> - `x-api-key: <token>`（Anthropic SDK 預設發這一種）
> - `x-goog-api-key: <token>`（Google GenAI SDK 預設發這一種）
> - 查詢參數 `?key=<token>`（手動呼叫與瀏覽器場景）
>
> 下文的 `http://localhost:8080` 請換成你實際部署的位址（Worker 的 `*.workers.dev` 網域、自訂網域，或 Docker 部署的本機位址），`your-gateway-token` 換成你真實的閘道口令。

<details>
<summary><b>OpenAI SDK（Python）</b></summary>

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

串流呼叫與直接對接 OpenAI 完全一樣——傳 `stream=True`，遍歷回傳的產生器即可。

</details>

<details>
<summary><b>Anthropic SDK（Python）</b></summary>

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

注意 SDK 的 `base_url` **不帶** `/v1`——SDK 內部會自己拼上 `/v1/messages`。

</details>

<details>
<summary><b>Gemini SDK（Python）</b></summary>

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

SDK 的 `base_url` 同樣**不帶** `/v1beta`——SDK 會自己拼上 `/v1beta/models/...`。

</details>

<details>
<summary><b>OpenAI-Responses（cURL）</b></summary>

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","input":"你好"}'
```

這條協議目前還沒有被廣泛使用的專用 SDK，所以直接用一次純 HTTP 呼叫示範。完整的回應結構與串流事件序列見各語言的 API 文件。

</details>

<details>
<summary><b>圖片生成</b></summary>

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-image-2.1-flash","prompt":"一隻貓"}'
```

同步轉發：請求體與回應體都原樣透傳自上游，閘道不改寫結構。它走的是同步逾時預算，不是串流的首位元組逾時。

</details>

<details>
<summary><b>影片生成（兩段式）</b></summary>

```bash
# ① 建任務，立即回傳
curl -X POST http://localhost:8080/v1/videos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-video-v2.0","prompt":"一隻貓在跑"}'

# ② 拿上一步的 id 輪詢
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

任務在上游非同步執行，閘道只負責轉發與輪詢，兩步的回應體都原樣透傳。

</details>

---

## 📡 API 端點

> 📖 詳細 API 文件：[API.md](API.md)

### OpenAI 相容（`/v1`）

| 方法 | 端點 | 功能 |
|------|------|------|
| GET | `/v1/models` | 模型清單 |
| POST | `/v1/chat/completions` | 對話補全（支援串流） |

### OpenAI Responses（`/v1`）

| 方法 | 端點 | 功能 |
|------|------|------|
| POST | `/v1/responses` | Responses API（支援串流） |

### Anthropic 相容（`/v1`）

| 方法 | 端點 | 功能 |
|------|------|------|
| POST | `/v1/messages` | Messages（支援串流） |

### Gemini 原生（`/v1beta`）

| 方法 | 端點 | 功能 |
|------|------|------|
| GET | `/v1beta/models` | 模型清單 |
| POST | `/v1beta/models/{model}:generateContent` | 內容生成（非串流） |
| POST | `/v1beta/models/{model}:streamGenerateContent` | 串流生成 |

### 圖片與影片

| 方法 | 端點 | 功能 |
|------|------|------|
| POST | `/v1/images/generations` | 圖片生成（同步轉發） |
| POST | `/v1/videos` | 建立影片任務 |
| GET | `/v1/videos/{id}` | 輪詢影片任務 |

### 管理介面

| 方法 | 端點 | 功能 |
|------|------|------|
| GET | `/admin` | 管理面板本體（**未設 `ADMIN_TOKEN` 時整棵樹不註冊，存取得 404**） |
| GET · POST · PUT · DELETE | `/admin/api/*` | 管理介面：key 池 / 註冊機 / 事件 / 用量 / 模型 / 設定（憑 `x-admin-key`） |

### 系統

| 方法 | 端點 | 功能 |
|------|------|------|
| GET | `/health` | 探活（不鑑權，回傳版本與儲存健康） |

> URL 裡的 `localhost:8080` 只是範例：Node 形態的埠由 `PORT` 決定，Worker 形態是你自己的 `*.workers.dev` 或自訂網域，按你的部署替換。
>
> 鑑權閘接受四種憑證通道：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、查詢參數 `?key=`。廠商原生的標頭與參數**同樣被接受**，官方 SDK 只換基底位址即可直連；要換掉的是**值**——任何通道裡傳的都必須是**本閘道**的口令，而不是真正的廠商金鑰。

---

## ⚙ 設定說明

優先順序：**環境變數 > 儲存裡的設定 > 內建預設**。下表只列最常用的那幾個；全部變數的取值範圍與「預設值是怎麼算出來的」見 `.env.example` 與各語言的部署文件。

| 變數 | 必填 | 預設值 | 說明 |
|------|------|--------|------|
| `GATEWAY_TOKEN` | ✅ | — | 閘道口令，用戶端用它呼叫本閘道；缺少時閘道拒絕啟動 |
| `ADMIN_TOKEN` | ❌ | — | 管理面板口令；未設時整棵 `/admin` 樹不註冊，設了必須與閘道口令不同且至少 24 位 |
| `AGNES_BASE_URL` | ❌ | `https://apihub.agnes-ai.com/v1` | Agnes 上游基底位址 |
| `PORT` | ❌ | `8080` | Node 形態的監聽埠（Worker 不用） |
| `DATA_DIR` | ❌ | `/app/data` | 檔案儲存的落盤目錄（Worker 不用） |
| `UPSTREAM_TIMEOUT_MS` | ❌ | `8000` | 串流回應與影片輪詢的上游首位元組逾時（毫秒） |
| `UPSTREAM_SYNC_TIMEOUT_MS` | ❌ | `120000` | 同步端點的整體逾時預算（毫秒） |
| `MAX_STRIKES` | ❌ | `3` | 瞬時故障累積上限，達到則進入長冷卻 |
| `POOL_CACHE_TTL_MS` | ❌ | `60000` | key 池快照在單個 isolate／行程裡的存活時長（毫秒） |
| `REGISTRAR_ENABLED` | ❌ | `false` | 註冊機總開關；打開後可用 key 低於目標值會自動補池 |
| `TRUST_PROXY` | ❌ | — | 置 1 才信任轉發標頭；放在 Cloudflare 後面時應當設上 |
| `USAGE_STATS_ENABLED` | ❌ | `false` | 面板「用量」板塊的時間序列；預設關，關閉時零成本 |

**Cloudflare Worker 側的設定不走 `.env`**：非敏感項寫在 `wrangler.toml` 的 `[vars]` 段裡，敏感值用 secret 注入，KV 命名空間與補池 Cron 也在同一份檔案裡宣告。

```bash
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

---

## ⚠ 注意事項

1. **對外部署必須設定 `GATEWAY_TOKEN`，面板要用就再設 `ADMIN_TOKEN`**：前者缺少時閘道**根本起不來**，不存在「沒設定也能用」這種狀態；後者不設時整棵 `/admin` 樹**不註冊**（404），設了則必須與閘道口令不同、且不短於 24 位，否則面板不啟用（閘道轉發不受影響）。

2. **串流輸出**：四種協議均支援串流；`stream:false` 時閘道同樣以 `stream:false` 請求上游，把上游那份 JSON 翻譯成你用的協議形狀後一次性回傳（上游回 `200` 但回應體不是 JSON 時回 `502`）。上游報錯原樣透傳（`401`/`403` 的回應體除外，它可能回顯 key 片段）；**上游串流中途斷開時閘道不會插入錯誤事件**——用戶端看到的是一次外觀正常收尾的串流，要判斷有沒有被截斷請依賴上游自己的 `finish_reason`。

3. **key 池自癒**：上游 `429`/`402` 讓對應 key 冷卻，連續瞬時故障累積到 `MAX_STRIKES` 後進入長冷卻（`COOLDOWN_STRIKE_MS`，預設 30 分鐘）、到期自動恢復；**永久剔除只發生在上游 `401`/`403`**。一把可用 key 都沒有時回傳 `503` 並給出可分辨的原因；同步檔把總預算耗光、一把 key 都沒應答的那一種回傳 `504`。

4. **Cloudflare 免費方案的 KV 配額**：每天的讀次數只與重新整理頻率和活躍 isolate 數有關，與請求量無關，但預設值在推薦設定處已經臨界。上線前請按部署文件裡的「配額帳」算一遍，必要時調大 `POOL_CACHE_TTL_MS`。

5. **網路環境**：部署側需要能存取 Agnes 上游（`AGNES_BASE_URL`）。啟用註冊機時還要能存取所選的臨時信箱服務與 Agnes 平台後端。

---

## 🗺 開發路線

- [x] 四協議前端（OpenAI / Anthropic / OpenAI-Responses / Gemini）
- [x] 統一轉發核心 + 四種憑證通道的鑑權閘
- [x] 串流（SSE）與非串流在四條協議上一致
- [x] 圖片生成轉發 + 影片生成兩段式轉發
- [x] key 池：取號、分級冷卻、永久剔除、可分辨的耗盡原因
- [x] 雙執行時：Cloudflare Worker（KV）與 Node / Docker（檔案儲存）同一份程式碼
- [x] 註冊機：兩條臨時信箱通道平級，從收碼到入池全自動
- [x] Web 管理面板八個板塊（零建置，預設關閉）
- [x] 管理介面鑑權：fail-closed，口令只走請求標頭
- [x] 五語言文件與五語言面板
- [x] CI 十三道門禁 + 雙執行時契約測試
- [ ] 用真實上游樣本核對協議目錄（今天上游事實表裡每一條都標著 assumed）
- [ ] 發布首個公開容器映像檔

---

## ☕ 贊賞 & 共享

> 完整內容請查看 [SPONSORS.md](SPONSORS.md)

覺得有幫助？歡迎給專案點個 Star，這是對開源維護者最直接的支持。

agnes2api 主要由個人維護，歡迎透過程式碼、文件、修復或 PR 參與建設。

**參與貢獻：**

1. Fork 本儲存庫
2. 建立分支 `git checkout -b feature/your-feature`
3. 提交程式碼 `git commit -m "feat: add something"`
4. 推送並建立 Pull Request

提程式碼前請先讀 [CONTRIBUTING.md](../../CONTRIBUTING.md)。發現安全問題請按 [SECURITY.md](../../SECURITY.md) 私下回報，不要開公開 issue。

---

## 🙏 致謝

感謝每一位願意花時間試用它的人。bug 重現、日誌、相容性回饋和功能建議都歡迎提到 [Issues](https://github.com/xwteam/agnes2api/issues) —— 這是首個版本，key 池、註冊機、雙執行時、多協議相容、Web 面板都還在等真實場景來打磨。

---

## 📄 授權協議

本專案採用 [MIT 授權](../../LICENSE)：

- **授予**：使用、複製、修改、合併、發布、散布、再授權與銷售本軟體的權利
- **要求**：保留版權與授權聲明

本專案與 Agnes AI 無關聯，且不提供任何擔保與支援承諾。使用者需自行承擔風險並遵守相關服務條款。

---

<div align="center">
  <sub>Built with TypeScript + Hono + Cloudflare Workers | Powered by Agnes AI</sub>
</div>
