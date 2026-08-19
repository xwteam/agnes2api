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
| `POOL_CACHE_TTL_MS` | 否 | `60000` | 每個 isolate／行程在記憶體裡快取一份 key 池快照，本值是它的存活時長；`0` = 關閉快取。**KV 讀取次數與請求數無關**，只取決於重新整理頻率，算法見下文「配額帳」。代價：其他 isolate 判定的冷卻／剔除，本 isolate 最多晚這麼久才看到。 |
| `POOL_TOUCH_INTERVAL_MS` | 否 | `21600000` | key 的「最後使用時間」最多多久寫入一次；`0` = 每次成功請求都寫入。它是純展示欄位、不參與排程，為它每次請求寫一次 KV 會把免費方案 1,000 次／天的寫入配額吃光，連冷卻與剔除都寫不進去。代價：面板「最後使用」的精度最粗到這個間隔。 |
| `PORT` | 否（僅 Node/Docker） | `8080` | Node 執行時的監聽埠，Worker 不使用此變數。 |
| `DATA_DIR` | 否（僅 Node/Docker） | `/app/data` | 檔案儲存寫入 `store.json` 的目錄，Worker 不使用此變數。 |

`COOLDOWN_RATE_LIMIT_MS` 與 `COOLDOWN_PAYMENT_MS` 預設沒有寫在 `.env.example` 中，但
兩種部署形態都會讀取這兩個環境變數，可依需求設定。以上數值型變數都必須是整數；除
`POOL_CACHE_TTL_MS` 與 `POOL_TOUCH_INTERVAL_MS` 的下界是 `0`（`0` 表示「關閉」）之外，
其餘都必須大於 `0`，否則閘道拒絕啟動。

`POOL_CACHE_TTL_MS` 與 `POOL_TOUCH_INTERVAL_MS` 是**建立 app 時讀取一次**的，改了要重啟
容器／等 isolate 回收才生效，不像其餘設定項那樣逐次生效。

### 配額帳：Worker + 免費方案 KV 能撐多少請求

免費方案 KV 每天 100,000 次讀、1,000 次寫。閘道的讀寫次數都**不隨請求數成長**，所以這筆帳
不是「每請求幾次」，而是「每天固定幾次」：

- **預設設定下 KV 不再是瓶頸**，上限變成 Cloudflare Worker 免費方案自身的 **100,000 次請求／天**。
  但這個結論**有前提，不是無條件的**：KV 的讀配額轉而約束「同時活躍的 isolate 數」，而那是
  隨流量地理分布變化的量，你無法直接設定。每個活躍 isolate 每天消耗

      (86400 ÷ POOL_CACHE_TTL_MS 秒數) × (1 + 池中 key 數)  +  2880

  次讀，末項 2880 是設定持有者每 30 秒一次的重新整理，吃同一個桶。預設值 + 20 把 key 時
  是每 isolate **33,120 次**，加上每天 48~96 次索引對帳，**3 個活躍 isolate 就用掉約 99.5%**。
  也就是預設值在建議設定處已經臨界；預期 isolate 更多就要把 `POOL_CACHE_TTL_MS` 調大
  （20 把 key、5 個 isolate 需要約 `120000`）。
- **關閉快取**（`POOL_CACHE_TTL_MS=0`，逃生口）時讀隨請求數線性成長，保底約
  `100,000 ÷ (1 + key 數)` ⇒ 20 把 key 時約 **4,700 次請求／天**。
- **寫入側**：穩態每天約 `key 數 × 4` 次（`lastUsedAt` 每 6 小時觸達一次），20 把 key 時 80 次，
  占寫配額 8%，其餘留給冷卻與剔除的記帳。每把 key **首次**被用到時另有一次性的一次寫。

### 管理面板相關變數（P3，預設關閉）

| 變數 | 是否必填 | 預設值 | 說明 |
|---|---|---|---|
| `ADMIN_TOKEN` | 否 | 無（面板不啟用） | 管理介面的口令。**必須與 `GATEWAY_TOKEN` 不同**，且至少 24 位。未設定或不合規時整棵 `/admin` 樹都不註冊。 |
| `TRUST_PROXY` | 否 | 未設定（**不**信任 `X-Forwarded-For`） | 只有在閘道確實位於你自己的反向代理之後時才設成 `1`。設了之後，`X-Forwarded-For` 的首段會被當作用戶端 IP 寫進登入失敗事件。 |

**沒設定就是面板整個不可用，而閘道照常轉發。** 此時存取 `/admin/...` 得到的是 **`404` 而不是
`401`**：整棵樹根本沒註冊，因此不會洩漏「這裡有個後台」。這與註冊機預設關閉是同一條規矩——
`ADMIN_TOKEN` 缺失或設錯，絕不能讓閘道轉發停擺。

**為什麼有 24 位的下限。** Worker 形態**沒有分散式登入限速**。要做它就得拿 KV 當計數視窗，
那等於給攻擊者一根消耗寫入配額的槓桿，把攻擊面從「猜口令」擴大到「打死 key 池的狀態回寫」。
因此口令熵是這裡唯一的防線，下限不是建議值。低於下限時面板不會啟用，容器日誌裡會有一條
`admin.token_rejected`。

**為什麼必須與 `GATEWAY_TOKEN` 不同。** `GATEWAY_TOKEN` 是你發給**每一個下游使用者**的中轉
口令。複用它當面板口令，等於任何拿到中轉口令的人都能讀走你的整池 key、關掉註冊機、把註冊
後端指向他自己的伺服器——從此每一次註冊的信箱、密碼、驗證碼都會被他收走。

這條規則在啟動時校驗，**並且在每一個管理請求上複查**。若兩者在執行中變成相同——例如用
`wrangler kv key put` 或直接編輯 `store.json` 手工把 `gatewayToken` 寫成了管理口令——管理
介面會**立刻開始回傳 `503`**，同時打一條 error 級的 `admin.token_conflict`。**閘道轉發不受
影響。** 把其中任一把口令改回去，管理介面會自行恢復：改儲存裡的 `gatewayToken`，在設定快取下一次
重新整理之後生效，不需要重啟；改 `ADMIN_TOKEN` 則因為它是環境變數，需要重新部署（Worker）或
重建容器（Docker）。

`ADMIN_TOKEN` **只從環境變數讀、不從儲存讀**：面板不能自助輪換自己的鑰匙。輪換方式：Worker
執行 `npx wrangler secret put ADMIN_TOKEN` 後重新部署；Docker 改 `.env` 後重建容器。

**`TRUST_PROXY` 是安全開關，所以預設關閉。** 它決定的用戶端 IP 會寫進 `admin.login_failed`
事件，無腦信任 `X-Forwarded-For` 等於允許任何人把爆破痕跡嫁禍給任意 IP。關閉時改用
`CF-Connecting-IP`（Cloudflare 由平台注入，用戶端偽造不了）；兩者都拿不到時該欄位如實記
`null`，**絕不偽造一個 `"unknown"`**——那會被當成一個真實來源。

### 註冊機相關變數（可選，預設關閉）

註冊機是一套可選的自動補池元件，預設關閉，不影響閘道的核心轉發功能。以下僅列變數
速查，運作原理、兩條信箱通道如何選擇、Cloudflare Cron 牆鐘限制等完整說明見
[REGISTRAR.md](REGISTRAR.md)。

| 變數 | 是否必填 | 預設值 | 說明 |
|---|---|---|---|
| `REGISTRAR_ENABLED` | 否 | `false` | 總開關，須為 `true` 才會啟用註冊機。 |
| `REGISTRAR_PRIMARY` | 啟用時必填 | 無 | 主通道，`yyds` 或 `moemail`；兩者平等，無預設值。 |
| `REGISTRAR_FALLBACK` | 否 | 空（不降級） | 備用通道，`yyds` 或 `moemail`。 |
| `TARGET_KEYS` | 否 | `20` | 目標可用 key 數。 |
| `MINT_BATCH` | 否 | `5` | 單輪最多鑄幾把 key。 |
| `TEND_INTERVAL_MS` | 否（僅 Node/Docker） | `1800000` | Node 側補池間隔；Worker 側則由 `wrangler.toml` 的 Cron 決定。 |
| `CODE_TIMEOUT_MS` | 否 | `120000` | 輪詢驗證碼的逾時。 |
| `MINT_DELAY_MIN_MS` / `MINT_DELAY_MAX_MS` | 否 | `2000` / `5000` | 每次鑄 key 之間的隨機間隔。 |
| `MAX_DOMAIN_ATTEMPTS` | 否 | `8` | 單次鑄 key 最多嘗試幾個網域。 |
| `REGISTRAR_TOKEN_NAME` | 否 | `auto` | 鑄出的 key 在 Agnes 後台顯示的名稱。 |
| `AGNES_PLATFORM_URL` | 否 | `https://platform-backend.agnes-ai.com` | 註冊用的 Agnes 平台後端位址。 |
| `YYDS_BASE_URL` / `YYDS_API_KEY` | 否 / 通道為 yyds 時必填 | `https://maliapi.215.im` / 空 | YYDS Mail 通道憑證。 |
| `MOEMAIL_BASE_URL` / `MOEMAIL_API_KEY` | 通道為 moemail 時必填 | 空 / 空 | MoeMail 通道憑證（自建服務，無預設位址）。 |

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

這樣匯入的 key 從下一個請求起立即生效：閘道用一個 `pool:index` 鍵保存池內的 id 清單
（這樣每次轉發都不必消耗 KV 的 `list` 操作——免費方案的 list 配額只有每天 1,000 次），
而索引不知道的手動匯入記錄會被自動發現並補進索引。

**即使你完全不用註冊機，也不要刪掉 `wrangler.toml` 裡的 `[triggers]`**：那個 cron 是
`pool:index` 與實際 `key:` 記錄之間唯一的對帳修復路徑，且與 `REGISTRAR_ENABLED` 無關。
