# agnes2api

[![version](https://img.shields.io/badge/version-v0.1.0-success)](../../CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

**語言：** [English](../en/README.md) | [简体中文](../zh-CN/README.md) | 繁體中文 | [日本語](../ja/README.md) | [한국어](../ko/README.md)

agnes2api 是一個輕量級 API 閘道，位於 Agnes AI 服務之前，將其重新包裝成四種主流 LLM
API 協議——OpenAI、Anthropic、Gemini、OpenAI-Responses——並提供圖片與影片生成的轉發
端點。它同時支援 Cloudflare Worker 與 Docker 兩種部署形態，並內建一套會自我修復的
key 池：異常的上游 key 會被自動冷卻或剔除。

> **關於商業使用**
>
> 本專案採用 MIT 授權條款，**法律上允許商業使用**。但我們**不建議**將其用於商業服務：
>
> 1. 專案依賴第三方服務的免費額度，其可用性、延遲與配額政策隨時可能變動，不具備商業
>    服務所需的穩定性保障
> 2. 大量取得免費額度的做法與上游服務條款存在張力，相關風險由使用者自行承擔
> 3. 專案不提供任何可用性承諾或技術支援
>
> （以上僅為建議，不具法律約束力，亦非授權條款的一部分。）

## 特色

- **四種協議、同一上游** —— OpenAI、Anthropic、Gemini、OpenAI-Responses 的官方客戶端
  都能直接對接本閘道，含串流回應。
- **圖片與影片轉發** —— 圖片生成的同步轉發，以及影片生成的建立任務／輪詢兩段式流程。
- **兩種部署形態、同一套程式碼** —— Cloudflare Worker（KV 儲存）或 Docker（檔案
  儲存），兩者執行完全相同的請求處理邏輯。
- **會自我修復的 key 池** —— 上游 `429`/`402` 會讓對應 key 進入冷卻，`401`/`403` 會
  將其永久剔除，連續瞬時故障累積到閾值後同樣剔除。
- **儲存存取與流量解耦** —— key 池依 isolate／行程快取，只改遙測欄位的更新會被整個
  丟棄，因此穩態下儲存的讀與寫都不隨請求量成長。這在 Cloudflare 免費方案 KV 上究竟
  留下多少餘量，取決於同時活躍的 isolate 數——完整算法與兩個可調旋鈕見
  [DEPLOY.md](DEPLOY.md) 的「配額帳」小節。
- **接受四種憑證傳遞方式** —— `Authorization: Bearer`、`x-api-key`、
  `x-goog-api-key`、查詢參數 `?key=` 皆可接受，正好對應各協議官方 SDK 預設發送的
  憑證形式。
- **可選的自動補池（預設關閉）** —— 啟用註冊機後，可用 key 低於目標值時會自動註冊
  Agnes 帳號補齊，見 [REGISTRAR.md](REGISTRAR.md)。

## 端點速查

| 方法 | 路徑 | 協議 | 說明 |
|---|---|---|---|
| GET | `/health` | – | 不需鑑權 |
| GET | `/v1/models` | OpenAI | 模型清單 |
| POST | `/v1/chat/completions` | OpenAI | 支援串流 |
| POST | `/v1/messages` | Anthropic | 支援串流 |
| POST | `/v1/responses` | OpenAI-Responses | 支援串流 |
| GET | `/v1beta/models` | Gemini | 模型清單 |
| POST | `/v1beta/models/{model}:generateContent` | Gemini | 非串流 |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Gemini | 串流 |
| POST | `/v1/images/generations` | – | 圖片生成 |
| POST | `/v1/videos` | – | 建立影片任務 |
| GET | `/v1/videos/{id}` | – | 輪詢影片任務 |

完整請求／回應範例：[API.md](API.md)

## 模型

| 模型 | 類型 |
|---|---|
| `agnes-2.0-flash` | 對話 |
| `agnes-image-2.1-flash` | 圖片 |
| `agnes-image-2.0-flash` | 圖片 |
| `agnes-video-v2.0` | 影片 |

## 快速開始

### Cloudflare Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xwteam/agnes2api)

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install
npx wrangler kv namespace create POOL   # 把回傳的 id 填入 wrangler.toml
npx wrangler secret put GATEWAY_TOKEN
npx wrangler deploy
```

### Docker

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
cp .env.example .env   # 設定 GATEWAY_TOKEN
docker compose up -d
```

完整部署指南、環境變數說明與手動匯入 key 的方法：[DEPLOY.md](DEPLOY.md)

## 接入閘道

本閘道可作為 OpenAI SDK、Anthropic SDK、Google GenAI SDK 的基底位址直接替換使用，
各種接入範例見 [USAGE.md](USAGE.md)。

## 授權條款

MIT —— 詳見 [LICENSE](../../LICENSE)。
