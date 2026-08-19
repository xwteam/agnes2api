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
- **`list` 與 `delete` 是另外兩個桶，各 1,000 次／天**，與讀、寫那兩個桶互不相通。穩態轉發
  一次 `list` 都不用——`pool:index` 索引鍵正是為此存在的。只有兩處會消耗它：每天 48~96 次
  索引對帳，以及**池子為空時的兜底掃描**（索引合法卻一條活記錄都讀不到時，閘道 `list` 一次，
  確認是不是有手工匯入的記錄沒進索引）。兜底掃描按內建的 **10 分鐘**退避（固定常數，不是
  環境變數），因此空池期間每個 isolate 每天最多 144 次。
- **`list` 桶被打穿的後果是失能而不是降級。** 池子為空且 `list` 失敗時，閘道回傳 `500` 並把
  真實原因寫進日誌，**不會**偽裝成 `503 pool_empty`——因為此時對帳用的是同一個桶、同樣在失敗，
  本文件給出的兩條自癒路徑都已經不可用，只能等 UTC 跨天配額重置。

### 管理面板相關變數（P3，預設關閉）

| 變數 | 是否必填 | 預設值 | 說明 |
|---|---|---|---|
| `ADMIN_TOKEN` | 否 | 無（面板不啟用） | 管理介面的口令。**必須與 `GATEWAY_TOKEN` 不同**，且至少 24 位。另外**首尾不得有空白**：HTTP 請求標頭的值在傳輸層會被去掉首尾空白，而環境變數不會，帶空白的口令任何用戶端都送不出來。未設定或不合規時整棵 `/admin` 樹都不註冊，具體原因記在 `admin.token_rejected` 事件裡。 |
| `TRUST_PROXY` | 否 | 未設定（**任何**轉發標頭都不信） | 只有在閘道確實位於代理之後時才設成 `1`——**Cloudflare Worker 形態也屬於這種情況，應當設上**。設了之後，登入失敗事件裡的用戶端 IP 取自 `CF-Connecting-IP`，缺席時才退到 `X-Forwarded-For` 的首段。 |

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

這條規則**只在每一個管理請求上複查，不在啟動時攔**。若兩者相同——例如用
`wrangler kv key put` 或直接編輯 `store.json` 手工把 `gatewayToken` 寫成了管理口令——管理
介面會**回傳 `503`**，同時打一條 error 級的 `admin.token_conflict`（啟動時就撞上衝突的話，
啟動日誌裡也會有同樣一條，方便你立刻看到原因）。**閘道轉發不受影響。** 把其中任一把口令改回去，
管理介面會自行恢復：改儲存裡的 `gatewayToken`，在設定快取下一次重新整理之後生效，**不需要重啟**；
改 `ADMIN_TOKEN` 則因為它是環境變數，需要重新部署（Worker）或重建容器（Docker）。

**為什麼這一條刻意不在啟動時攔。** `gatewayToken` 執行中會變，而啟動時的判定沒有第二次求值的
機會：一旦在那裡把整棵 `/admin` 樹反註冊掉，衝突期間冷啟動的 isolate（以及衝突期間啟動的整個
Docker 容器）就會**永久 404**，把設定改回去也救不了，必須重啟——而衝突之前建好的那些只是 `503`
且改回去立刻恢復。同一份設定、同一時刻兩種結果，上面那句「不需要重啟」就成了半句假話。
相比之下 `ADMIN_TOKEN` 自身的兩條規則（首尾空白 / 長度不足）只取決於環境變數，執行中不會變，
所以它們仍然在啟動時攔，失效形態是 `404`。

`ADMIN_TOKEN` **只從環境變數讀、不從儲存讀**：面板不能自助輪換自己的鑰匙。輪換方式：Worker
執行 `npx wrangler secret put ADMIN_TOKEN` 後重新部署；Docker 改 `.env` 後重建容器。

**`TRUST_PROXY` 是安全開關，所以預設關閉。** 它決定的用戶端 IP 會寫進 `admin.login_failed`
事件，無腦信任一個由用戶端提供的標頭，等於允許任何人把爆破痕跡嫁禍給任意 IP。

**關閉時任何轉發標頭都不信，該欄位一律記 `null`——`CF-Connecting-IP` 也不例外。** 這個標頭常被說成
「平台注入、偽造不了」，但那個性質**只在請求真的經過 Cloudflare 時**成立；Node/Docker 直連暴露時
沒有任何東西會覆蓋它，用戶端自己發一個 `CF-Connecting-IP: 1.2.3.4` 就會被採信——而直連正是 Docker
部署的預設形態。

**打開時 `CF-Connecting-IP` 優先，`X-Forwarded-For` 只作備援。** 兩個標頭的可偽造性根本不同：

- `CF-Connecting-IP` 由 Cloudflare 邊緣寫入，並且會**覆蓋**用戶端傳來的同名標頭——只要請求真的經過
  Cloudflare，它就偽造不了。
- `X-Forwarded-For` 是任何中介都能追加的鏈，用戶端可以自己發一個假的，可信與否完全取決於你的
  代理鏈長什麼樣。

**Worker 形態請設 `TRUST_PROXY=1`。** 那裡 Cloudflare 定義上就在前面，`CF-Connecting-IP` 是權威值；
在這種形態下優先 `X-Forwarded-For` 是錯的——那條鏈裡可能裝著用戶端自己塞的東西。不設這個開關的話，
該欄位就只是記成 `null`。

**通用反向代理（nginx / Caddy / Traefik）後面打開 `TRUST_PROXY=1` 時，請在反向代理上把
`CF-Connecting-IP` 剝掉。** 那種拓撲裡沒有任何東西會覆蓋這個標頭，而閘道按「Cloudflare 在前面」
優先採信它，於是攻擊者自帶一個就會**壓過**反向代理剛寫好的 `X-Forwarded-For`。nginx 加一行即可：

```nginx
proxy_set_header CF-Connecting-IP "";
```

Caddy 用 `header_up CF-Connecting-IP ""`，Traefik 用中介軟體的 `customRequestHeaders`。

**兩個標頭都會先過一遍形態檢查**：只有 IPv4 點分十進位與 IPv6 形態（十六進位、冒號，以及
`::ffff:` 映射裡的點）能進事件，其餘一律記 `null`。這條不是鑑權防線（這個值全倉只有登入失敗
事件一個消費點），它防的是「未鑑權的呼叫方往稽核欄位裡塞任意文字」——管理面板的事件區塊
要按這個欄位做篩選與顯示。

什麼都拿不到時該欄位如實記 `null`，**絕不偽造一個 `"unknown"`**——那會被當成一個真實來源。

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

2. 為 key 池建立一個 KV 命名空間並寫回 `wrangler.toml`：

   ```bash
   node scripts/setup-worker.mjs
   ```

   倉庫裡 `wrangler.toml` 的 `id` 永遠是佔位符（公開倉不放任何真實部署細節），
   這一步必不可少。腳本內部做的事等同於手動執行 `npx wrangler kv namespace
   create POOL` 後把回傳的 `id` 填進 `[[kv_namespaces]]` 段取代
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。**跑完不要提交這次對 `wrangler.toml`
   的改動**——`check-wrangler-placeholder.mjs` 那道 CI 門禁會擋下誤提交的真實 id。

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

閘道用一個 `pool:index` 鍵保存池內的 id 清單，這樣每次轉發都不必消耗 KV 的 `list` 操作
（免費方案的 `list` 配額只有每天 1,000 次，是獨立於讀、寫之外的另一個桶）。**手動寫記錄不會
動這個索引**，所以新 key 多久能被用上，取決於池子當時的狀態：

- **池子為空時**：索引說池子是空的、記錄也確實一條都讀不到，閘道會回落一次 `list` 掃描把
  手動匯入的記錄發現並補進索引。這條掃描有內建的 10 分鐘退避（見上文「配額帳」），因此
  可見上界是 **≤10 分鐘 + 一個 `POOL_CACHE_TTL_MS`**。
- **池子非空時**：轉發路徑只按索引取記錄，索引不知道的記錄**完全隱身**，而且沒有任何報錯。
  它要等下一次 Cron 對帳把索引修好（預設 30 分鐘，且**觸發時機沒有官方保證**，見下），
  之後再等最多一個 `POOL_CACHE_TTL_MS`。

**想讓手動匯入立刻生效，就在寫記錄的同時把 id 補進 `pool:index`：**

```bash
npx wrangler kv key get --binding=POOL "pool:index" --remote
# 把新 id 追加進 ids 陣列再整個寫回（v 固定為 1）
npx wrangler kv key put --binding=POOL "pool:index" \
  '{"v":1,"ids":["已有的id","1a2b3c4d5e6f7a8b"]}' --remote
```

索引寫完之後，各 isolate 最多再等一個 `POOL_CACHE_TTL_MS` 就會用上這把 key。

**即使你完全不用註冊機，也不要刪掉 `wrangler.toml` 裡的 `[triggers]`**：那個 cron 是
`pool:index` 與實際 `key:` 記錄之間唯一的對帳修復路徑，且與 `REGISTRAR_ENABLED` 無關。

**這個 cron 的觸發時機沒有官方保證。** Cloudflare 沒有文件化 Cron Trigger 按
`crons` 表達式觸發的可靠性承諾（不保證不跳過、不保證延遲上界）。這對配額帳
是安全的——對帳觸發得越少，實際消耗的 KV 讀寫只會比預估更少，不會更多；但
**孤兒記錄／幽靈索引項被撿回索引的時間沒有保證**，極端情況下可能比預期的
「最長 30 分鐘」更晚。這段等待期間該 key 只是暫時用不上，不會造成資料損壞。

## 吊銷一把 key

**刪記錄、再把 id 從 `pool:index` 裡摘掉，兩步都要做。** 只刪記錄不會出錯（讀不到的記錄會被
直接過濾掉），但索引裡那個 id 還在，每次重新整理都白付一次讀，要等下一次對帳才會被剪掉。

```bash
npx wrangler kv key delete --binding=POOL "key:1a2b3c4d5e6f7a8b" --remote
# 把該 id 從 ids 陣列裡去掉再整個寫回
npx wrangler kv key put --binding=POOL "pool:index" '{"v":1,"ids":["剩下的id"]}' --remote
```

Docker 形態就是在 `./data/store.json` 裡刪掉 `"key:<id>"` 那個鍵，並把 `"pool:index"` 的
`ids` 陣列改好，建議先 `docker compose stop`。

已經裝載了舊快照的 isolate／行程最多再等一個 `POOL_CACHE_TTL_MS` 才會停止選中這把 key；
Worker 上還要再加一個 KV 的傳播視窗（約 60 秒），因為刪除要這麼久才對所有 colo 可見。

**這段視窗裡它也不會被寫回來**：閘道在落盤任何狀態變更之前都會先確認記錄還在，讀不到就
丟棄這次寫並立刻重新整理自己的快照。唯一的例外同樣是那個傳播視窗——確認用的那次讀若被 KV
的邊緣快取擋下，本 colo 會以為記錄還在。Docker（檔案儲存）沒有這層快取，那裡是精確的。
