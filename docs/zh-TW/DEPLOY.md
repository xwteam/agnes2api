# 部署指南

**語言：** [English](../en/DEPLOY.md) | [简体中文](../zh-CN/DEPLOY.md) | 繁體中文 | [日本語](../ja/DEPLOY.md) | [한국어](../ko/DEPLOY.md)

agnes2api 提供兩種部署形態，建構自同一套程式碼與請求處理邏輯，依你的基礎設施擇一
即可。兩者僅在儲存後端上有差異：Worker 使用 Cloudflare KV 命名空間，Docker 使用掛載
卷上的 JSON 檔案。

## 環境變數

| 變數 | 是否必填 | 預設值 | 說明 |
|---|---|---|---|
| `GATEWAY_TOKEN` | **是** | – | 客戶端呼叫本閘道時必須攜帶的權杖。 |
| `AGNES_BASE_URL` | 否 | `https://apihub.agnes-ai.com/v1` | 上游 Agnes API 的基底位址。 |
| `UPSTREAM_TIMEOUT_MS` | 否 | `8000` | **串流**回應與影片輪詢的首位元組逾時：超過此毫秒數未收到上游首位元組則中止本次呼叫。 |
| `UPSTREAM_SYNC_TIMEOUT_MS` | 否 | `120000` | **同步**端點的整體逾時預算，只作用於「首位元組要等上游把整個結果算完才到達」的請求：圖片生成、影片建任務，以及所有**非串流**對話。見下文說明。 |
| `MAX_STRIKES` | 否 | `3` | 連續瞬時故障（逾時、網路錯誤、上游 `5xx`）累積到此閾值後，該 key 進入長冷卻。 |
| `COOLDOWN_RATE_LIMIT_MS` | 否 | `60000` | 上游回傳 `429` 後，對應 key 的冷卻時長。 |
| `COOLDOWN_PAYMENT_MS` | 否 | `3600000` | 上游回傳 `402` 後，對應 key 的冷卻時長。 |
| `COOLDOWN_STRIKE_MS` | 否 | `1800000` | key 的瞬時故障累積到 `MAX_STRIKES` 後的冷卻時長，到期自動恢復。 |
| `PORT` | 否（僅 Node/Docker） | `8080` | Node 執行時的監聽埠，Worker 不使用此變數。 |
| `DATA_DIR` | 否（僅 Node/Docker） | `/app/data` | 檔案儲存寫入 `store.json` 的目錄，Worker 不使用此變數。 |

`COOLDOWN_RATE_LIMIT_MS` 與 `COOLDOWN_PAYMENT_MS` 預設沒有寫在 `.env.example` 中，但
兩種部署形態都會讀取這兩個環境變數，可依需求設定。以上數值型變數都必須是正整數，
否則閘道拒絕啟動。

### 兩檔逾時各自管什麼

判準是「上游的第一個位元組什麼時候才可能到達」，不是端點的名字：

| 檔位 | 適用端點 | 用哪個變數 |
|---|---|---|
| 首位元組檔 | **串流**對話（`stream: true`）、影片輪詢 `GET /v1/videos/{id}` | `UPSTREAM_TIMEOUT_MS` |
| 同步檔 | 圖片生成、影片建任務、**所有非串流對話**（四種協定皆是） | `UPSTREAM_SYNC_TIMEOUT_MS` |

非串流請求要等上游把整段回答生成完才發回應標頭，和圖片生成是同一種延遲語意，用 8 秒的
首位元組檔去卡它只會讓正常請求大量失敗並連累 key 池。

`UPSTREAM_SYNC_TIMEOUT_MS` 是**一次請求的總預算**，也就是用戶端的最壞等待時間——不是
「池大小 × 預算」。閘道在這個預算裡最多為單一 key 花掉一半，剩下的用來換一把 key 再試，
這樣池裡有一把 key 掛起（連得上但永不回應）時不會白白吃掉這次請求。因此請把它設成
**單次呼叫最壞耗時的兩倍以上**。

同步檔逾時不會立刻懲罰 key：只有當同一次請求裡換的另一把 key 真的成功了，閘道才把逾時
算到先逾時的那把 key 頭上（累積到 `MAX_STRIKES` 進冷卻）；如果本次請求裡每一把都逾時，
則一把都不懲罰——那更可能是預算設太小或上游整體變慢。

「剔除」與「冷卻」是兩回事。不論上述參數如何設定，上游 `401`/`403` 都會**永久**剔除該
key——這兩種狀態被視為「這把 key 已失效」，重試沒有意義。瞬時故障則永遠不會導致剔除：
累積到 `MAX_STRIKES` 只是進入 `COOLDOWN_STRIKE_MS` 的冷卻，到期自動恢復，因此上游抽風
不會永久損毀你的 key 池。

當沒有任何 key 能服務本次請求時，閘道回傳 `503`，並在 `error.reason` 中給出可判別的原因：
`pool_empty`（尚未匯入 key）、`all_cooling`（全部 key 冷卻中，會自動恢復，回應標頭
`Retry-After` 給出恢復時刻）、`all_evicted`（全部 key 因憑證失效被永久剔除，**不會**自癒，
請更換 key）、`upstream_error`（key 本身可用，但上游每次嘗試都失敗）。

## Cloudflare Worker

### 方式一：Deploy to Cloudflare 按鈕

點擊根目錄 [README](../../README.md) 中的按鈕，授權 Cloudflare 後會自動 fork/clone
本倉庫並完成部署。之後仍需依下文完成 **secret** 與 **KV 命名空間** 兩步——按鈕本身
不會幫你設定這兩項。

### 方式二：手動部署

1. 克隆倉庫並安裝相依套件：

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   pnpm install
   ```

2. 為 key 池建立一個 KV 命名空間並綁定為 `POOL`：

   ```bash
   npx wrangler kv namespace create POOL
   ```

   把回傳的命名空間 `id` 填入 `wrangler.toml`，取代
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`：

   ```toml
   [[kv_namespaces]]
   binding = "POOL"
   id = "your-namespace-id"
   ```

3. 把閘道權杖設定為 Worker secret（絕對不要提交進 `wrangler.toml`）：

   ```bash
   npx wrangler secret put GATEWAY_TOKEN
   ```

4. 部署：

   ```bash
   npx wrangler deploy
   ```

### 推送 tag 自動部署

`.github/workflows/deploy-worker.yml` 會在推送 `v*` tag 時自動部署 Worker，前提是
倉庫在 **Settings → Secrets and variables → Actions** 中設定了
`CLOUDFLARE_API_TOKEN`。若未設定，工作流程會印出警告並跳過部署步驟，不會讓整個
執行失敗。

### 本機開發

```bash
npx wrangler dev
```

把 `GATEWAY_TOKEN` 寫進 `wrangler.toml` 同目錄下的本機 `.dev.vars` 檔案（已列入
`.gitignore`）——不要把密鑰直接寫進 `wrangler.toml`。

## Docker

1. 克隆倉庫並準備環境變數檔：

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   cp .env.example .env
   ```

2. 編輯 `.env`，至少設定 `GATEWAY_TOKEN`。其餘變數見上方
   [環境變數](#環境變數) 表。

3. 啟動容器：

   ```bash
   docker compose up -d
   ```

   `docker-compose.yml` 預設發布 `8080` 埠（可透過 `.env` 內的 `PORT` 覆寫），並將
   `./data` 掛載到容器內的 `/app/data`——`store.json`（key 池與任何持久化設定）就存
   放在這裡。重啟／升級時務必保留這個目錄，它是已匯入 key 池的唯一副本。

4. 確認容器健康：

   ```bash
   curl http://localhost:8080/health
   ```

   映像檔內建 `HEALTHCHECK`，Docker 會依此回報容器健康狀態。資料目錄不可寫時 `/health`
   回傳 `503` 且 `status` 為 `degraded`，容器會被標成 unhealthy，具體原因見容器日誌。

### 容器會改寫 `./data` 的擁有者（請先知悉）

容器**以 root 進入 entrypoint**，做兩件事後再降權：

- 若 `DATA_DIR`（預設 `/app/data`）的擁有者與容器內執行使用者 `app`（**uid 100 / gid 101**）
  不一致，就遞迴 `chown` 該目錄；擁有者已經一致時不做任何改寫。
- 隨後用 `su-exec` 降權，**主行程（PID 1）以 app 執行，不是 root**。

必須在執行期做這件事的原因是：綁定掛載時宿主目錄的擁有者會蓋過映像檔建置期的 `chown`，
容器內的 app 因此寫不進 `store.json`，而這種失敗是靜默的（所有 API 回傳 `pool_empty`）。

**副作用**：綁定掛載改的是**宿主**上的檔案——`docker compose up -d` 之後，你的 `./data`
及其中的檔案擁有者會從你自己的 uid 變成 `100:101`，之後在宿主上讀寫或備份它需要 `sudo`。
不希望發生這件事的話，用 `--user`（或 compose 的 `user:`）指定非 root 執行：此時
entrypoint 完全不 chown，資料目錄的擁有者與可寫性由你自己準備。

基於同樣的原因，映像檔**沒有** `USER app`，預設使用者是 root
（`docker inspect --format '{{.Config.User}}' <image>` 輸出為空）。這對 Kubernetes 有影響：
設了 `runAsNonRoot: true` 卻沒明確給 `runAsUser` 時，kubelet 會拒絕啟動該容器。這類部署請
明確寫 `runAsUser: 100`、`runAsGroup: 101`（或任何你自己的 uid），並自行準備磁碟區的
擁有者——非 root 啟動時 entrypoint 走的是「不 chown、直接執行」的分支。

安全邊界：`DATA_DIR` 被設成 `/` 或某個頂層系統目錄（`/etc`、`/usr` 等）時，entrypoint
拒絕在其上遞迴 chown（只印出警告，不影響啟動），避免把整個容器檔案系統改成 app 可寫。

## 匯入 Agnes 上游 key

目前版本的閘道沒有提供匯入 key 的 HTTP 介面，需要直接寫入儲存後端。每筆記錄是一個
鍵為 `key:<id>` 的 JSON 物件，`<id>` 可以是池內唯一的任意字串（閘道自己建立記錄時
會用 key 的雜湊值推導一個，但讀取時不會校驗這個值，所以手動匯入時用任意唯一識別碼
即可）：

```json
{
  "id": "1a2b3c4d5e6f7a8b",
  "key": "你的真實-agnes-api-key",
  "addedAt": 1735689600000,
  "lastUsedAt": null,
  "cooldownUntil": 0,
  "strikes": 0,
  "evicted": false,
  "evictedReason": null
}
```

### Docker

先停止容器，避免與正在執行的程序產生寫入競爭；在主機上編輯 `./data/store.json`，
在鍵 `"key:1a2b3c4d5e6f7a8b"` 下加入如上記錄，然後再啟動容器：

```bash
docker compose stop
# 編輯 ./data/store.json
docker compose start
```

若 `./data/store.json` 尚不存在，直接新建一個 JSON 物件檔案，鍵為若干個
`key:<id>` 字串即可。

### Cloudflare Worker

用 wrangler 直接把記錄寫進 `POOL` KV 命名空間：

```bash
npx wrangler kv key put --binding=POOL "key:1a2b3c4d5e6f7a8b" \
  '{"id":"1a2b3c4d5e6f7a8b","key":"你的真實-agnes-api-key","addedAt":1735689600000,"lastUsedAt":null,"cooldownUntil":0,"strikes":0,"evicted":false,"evictedReason":null}' \
  --remote
```

不加 `--remote` 則寫入 `wrangler dev` 使用的本機命名空間，而非正式環境。
