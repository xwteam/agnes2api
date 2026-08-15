# 註冊機（自動補池）

**語言：** [English](../en/REGISTRAR.md) | [简体中文](../zh-CN/REGISTRAR.md) | 繁體中文 | [日本語](../ja/REGISTRAR.md) | [한국어](../ko/REGISTRAR.md)

> **預設關閉。** `REGISTRAR_ENABLED` 預設為 `false`，裝上本專案不會自動開始註冊任何帳號；
> 只有明確把它設為 `true` 才會啟用註冊機。

## 這是什麼

註冊機是一個可選元件：當 key 池中的可用 key 數低於 `TARGET_KEYS` 時，它會自動註冊新的
Agnes 帳號、登入、鑄出一把 API key 寫入池子。註冊過程需要接收 Agnes 寄來的信箱驗證碼，
因此依賴下文的信箱通道之一。

> **合規提示**
>
> 大量註冊與 Agnes 服務條款之間存在張力。是否啟用註冊機、以何種頻率使用，須由部署者自行
> 判斷並承擔相應責任——本專案不替使用者做這個決定。

## 兩條信箱通道：如何選擇

註冊機支援兩條信箱通道，用來接收驗證碼：

| | YYDS Mail | MoeMail |
|---|---|---|
| 性質 | 第三方臨時信箱服務 | 可自行部署的臨時信箱服務 |
| API 基底位址 | 有預設值（`YYDS_BASE_URL`，指向其公開 API 端點） | 無預設值（`MOEMAIL_BASE_URL`），需填入你自己部署實例的位址 |
| 取得憑證 | 向該服務申請 API Key（`YYDS_API_KEY`） | 在自己部署的實例中產生 API Key（`MOEMAIL_API_KEY`） |

**兩條通道完全平等，本專案不預設主通道，也不推薦任何一條。** `REGISTRAR_PRIMARY` 沒有
預設值，啟用註冊機時必須明確指定為 `yyds` 或 `moemail`。`REGISTRAR_FALLBACK` 為選填：
主通道遇到**通道層級失敗**（列網域失敗、連續建信箱失敗、憑證無效、收不到驗證碼）時會
自動降級到備用通道；留空表示不降級。

> 「收不到驗證碼」也算通道層級失敗：驗證碼正是經由這條信箱通道投遞的，所以網域 MX 記錄
> 失效、郵件轉發規則被刪這類故障——API 全部回傳 2xx、只是信永遠不到——同樣屬於「這條
> 通道現在產不出 key」。

判斷依據：註冊機靠「換網域」繞開 Agnes 對一次性信箱網域的封鎖，可用網域越多，註冊機就
越耐用。查一下你在兩邊各自擁有多少可用網域，網域較多的那一條更適合作為主通道——這與是
哪家服務無關，只取決於你自己的帳號或自建實例的配置。

## 零內建憑證，請自行準備

本儲存庫不包含任何真實金鑰、帳號或私有網域。啟用註冊機前，你需要自行準備：

- **使用 YYDS Mail**：向該服務申請一個 API Key，填入 `YYDS_API_KEY`（`YYDS_BASE_URL`
  已有預設值，通常無需更改）。
- **使用 MoeMail**：自行部署一個 MoeMail 實例，把它的存取位址填入 `MOEMAIL_BASE_URL`、
  在實例中產生的 API Key 填入 `MOEMAIL_API_KEY`（兩項都沒有預設值，必須明確提供）。

至少準備好 `REGISTRAR_PRIMARY` 所指向的那一條通道；若配置了 `REGISTRAR_FALLBACK`，也要
準備好對應通道的憑證。

## 設定項目

| 變數 | 是否必填 | 預設值 | 說明 |
|---|---|---|---|
| `REGISTRAR_ENABLED` | 否 | `false` | 總開關，須為 `true` 才會啟用註冊機。 |
| `REGISTRAR_PRIMARY` | 啟用時必填 | 無 | 主通道，`yyds` 或 `moemail`；兩者平等，無預設值。 |
| `REGISTRAR_FALLBACK` | 否 | 空（不降級） | 備用通道，`yyds` 或 `moemail`；主通道發生通道層級失敗時降級至此。 |
| `TARGET_KEYS` | 否 | `20` | 目標可用 key 數，低於此值才會觸發補池。 |
| `MINT_BATCH` | 否 | `5` | 單輪最多鑄幾把 key。 |
| `TEND_INTERVAL_MS` | 否（僅 Node/Docker） | `1800000`（30 分鐘） | Node 側補池排程間隔；Worker 側則由 `wrangler.toml` 的 Cron 決定，見下文。 |
| `CODE_TIMEOUT_MS` | 否 | `120000`（120 秒） | 單次鑄 key 等待驗證碼的逾時。 |
| `MINT_DELAY_MIN_MS` | 否 | `2000` | 單輪內每次鑄 key 之間隨機間隔的下限（毫秒）。 |
| `MINT_DELAY_MAX_MS` | 否 | `5000` | 單輪內每次鑄 key 之間隨機間隔的上限（毫秒）。 |
| `MAX_DOMAIN_ATTEMPTS` | 否 | `8` | 單次鑄 key 最多嘗試幾個臨時信箱網域。 |
| `REGISTRAR_TOKEN_NAME` | 否 | `auto` | 鑄出的 Agnes API key 在 Agnes 後台顯示的名稱。 |
| `AGNES_PLATFORM_URL` | 否 | `https://platform-backend.agnes-ai.com` | 註冊、登入、鑄 key 使用的 Agnes 平台後端位址（廠商公開端點）。 |
| `YYDS_BASE_URL` | 否 | `https://maliapi.215.im` | YYDS Mail 的 API 基底位址（廠商公開端點）。 |
| `YYDS_API_KEY` | 通道為 yyds 時必填 | 空 | YYDS Mail 的 API Key。 |
| `MOEMAIL_BASE_URL` | 通道為 moemail 時必填 | 空 | 你自己部署的 MoeMail 實例位址，無預設值。 |
| `MOEMAIL_API_KEY` | 通道為 moemail 時必填 | 空 | 該 MoeMail 實例的 API Key。 |

`MINT_DELAY_MIN_MS`、`MINT_DELAY_MAX_MS`、`REGISTRAR_TOKEN_NAME`、`AGNES_PLATFORM_URL` 預設沒有寫
在 `.env.example` 中（預設值通常已足夠），但兩種部署形態都會讀取，可依需求設定。以上
數值型變數皆須為正整數，否則閘道拒絕啟動。

## 兩種執行時的排程差異

| 部署形態 | 觸發方式 | 由誰決定間隔 |
|---|---|---|
| Cloudflare Worker | `wrangler.toml` 的 `[triggers]` Cron（預設 `*/30 * * * *`，即每 30 分鐘一次） | 修改 `wrangler.toml` 中的 cron 表達式 |
| Node / Docker | 行程內計時器 | `TEND_INTERVAL_MS`（預設 `1800000` 毫秒） |

兩種執行時最終都會呼叫同一個補池函式，設定項目完全相同，差異只在「由誰負責準時觸
發」。

### Cloudflare Cron 觸發器的牆鐘上限（務必讀完再調整參數）

若使用 Worker 部署，補池由 Cron Trigger 觸發，請務必了解以下限制：

- Cron Trigger 單次呼叫的牆鐘（wall-clock）上限為 **15 分鐘（900 秒）**。
- **`ctx.waitUntil()` 不會延長此上限**——該寬限機制只對 HTTP 請求生效，對 Cron 觸發的
  呼叫不適用。
- CPU 時間上限為 30 秒，但補池過程中的 `await` 網路請求（寄驗證碼、輪詢驗證碼等）不計
  入 CPU 時間，所以 CPU 上限並非實際瓶頸。
- 註冊機鏈路上的**每個 HTTP 請求都有 15 秒的單請求逾時**（固定值，不可設定）。它是下面
  兩個估算成立的前提：沒有它，一個掛起的連線就能讓單輪無限拖長。
- **常態耗時**（每個請求都很快返回、第一個網域就沒被封鎖）由等待驗證碼主導：約
  `MINT_BATCH × CODE_TIMEOUT_MS` = 5 × 120 秒 = 600 秒，加上單輪內鑄 key 之間的隨機
  間隔（最多 4 次、每次至多 5 秒）約 20 秒，合計約 **600～620 秒**，距 900 秒的牆鐘上
  限還有約 **30% 的餘裕**。
- **理論最差耗時**要把單請求逾時算進去。單次鑄 key 除了輪詢驗證碼，還要打「1 次列網域
  ＋每嘗試一個網域 3 次（建信箱、寄驗證碼、刪信箱）＋3 次（註冊、登入、建 key）」，
  即 `CODE_TIMEOUT_MS + (1 + 3 × MAX_DOMAIN_ATTEMPTS + 3) × 15 秒`，預設值下約
  120 + 420 = **540 秒**；再乘以 `MINT_BATCH` 就遠超 900 秒。也就是說**預設設定在極端
  情況下會頂到牆鐘上限**——這是刻意接受的取捨：每鑄出一把 key 就立即寫入儲存，被中止
  只會讓當輪不完整（見下一條）。若希望連極端情況也留在牆鐘內，把 `MINT_BATCH` 調到
  1～2，或調小 `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`。
- **配了 `REGISTRAR_FALLBACK` 時，「最差耗時」要乘以通道數（即 ×2）；常態耗時不變。**
  常態下驗證碼正常到達，備用通道根本不會被啟用；只有「收不到驗證碼」這類通道層級失敗，
  才會讓同一個補池名額在備用通道上再等一次 `CODE_TIMEOUT_MS`。啟動時那條
  `TEND_INTERVAL_MS 小於單輪最差耗時` 的告警用的就是這個模型：
  `MINT_BATCH × CODE_TIMEOUT_MS × 通道數`。
- **Worker 形態會在牆鐘耗盡前主動收手（覆蓋上面「最差耗時」那一項，不覆蓋「理論最差」）。**
  每次準備開始一次鑄 key 之前，註冊機都會先算「剩餘牆鐘夠不夠完整跑完這一次」，
  判據是 `CODE_TIMEOUT_MS × 通道數` 再加上嘗試間隔；不夠就**根本不開始**，提前結束
  本輪、印出一條 `本轮墙钟预算不足以再完整跑完一次铸 key，提前收尾`，已經鑄好的 key
  照常入池，剩餘名額留給下個排程週期。
  關鍵在於「不開始」而不是「跑到一半被砍」：被平台從中間中止時，那次正在用的臨時信箱
  來不及刪除就會殘留（YYDS 約 24 小時後隨 `expiresAt` 過期，MoeMail 按 1 小時 TTL 過期）。
  因此 **`MINT_BATCH` 在 Worker 上是「單輪上限」而不是「保證值」**：單輪可能鑄不滿。
  Node/Docker 沒有平台牆鐘上限，不啟用這個機制，`MINT_BATCH` 會照常跑滿。
- **⚠️ 這個預算不是萬能的，殘餘場景仍然存在。** 判據裡只有佔大頭的
  `CODE_TIMEOUT_MS × 通道數`，**沒有**把單請求逾時（每個 15 秒）與 403 退避算進去——
  把它們也算進去就會變成一次嘗試都不敢開始（上面那條「理論最差」本來就高於 900 秒）。
  預算取牆鐘的 87%，留下的那約 120 秒餘量就是給這些尾巴的。所以：
  - **「上游只是收不到驗證碼」**（本節最常見的那種慢）**已被完全兜住**；
  - **「幾乎每個 HTTP 請求都掛滿 15 秒」**這種病態情形，單次嘗試可能超出預留餘量、
    仍被平台中止，那次的臨時信箱會殘留。擔心這一種就按上面「理論最差」的公式把
    `MINT_BATCH` 調到 1~2，或調小 `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`。
- **`CODE_TIMEOUT_MS` 別調得過大。** `CODE_TIMEOUT_MS × 通道數` 一旦超過單輪預算
  （牆鐘的 87%），Worker 形態下**一次嘗試都無法開始**，補池會持續零產出。有兩條日誌：
  - **啟動時**印出一條**警告**（`console.warn`），形如
    `[registrar] CODE_TIMEOUT_MS×通道数(...) 超过 Worker 单轮墙钟预算(...)`。
    它**不會阻止閘道啟動**——這一點與「缺憑證啟動即報錯」不同：Node/Docker 沒有平台
    牆鐘上限，同一份設定在那邊完全合法，所以兩種形態都會印這條警告，但只有 Worker
    真正受影響。
  - **Worker 每一輪補池**再印一條**錯誤**（`console.error`），形如
    `[registrar] 单次铸 key 的最坏耗时(...ms = CODE_TIMEOUT_MS×通道数)已超过本轮墙钟预算`。
    每輪都會出現，可據此確認這是持續狀態而非偶發。
- **在調大 `MINT_BATCH`、`CODE_TIMEOUT_MS` 或 `MAX_DOMAIN_ATTEMPTS` 之前，請自行依上述
  兩個公式核算。** 頂到上限時，本次 Cron 呼叫會被平台中止。
- 即使被中止也不會遺失已經鑄好的 key——每鑄出一把就立即寫入儲存，只是當輪次的補池不
  完整，下一個排程週期會繼續嘗試補齊。

## 為什麼依序鑄 key、不並行

補池在單輪內**依序**鑄 key，每次之間插入隨機間隔，而不是並行發出多個鑄 key 請求。這不
是效能取捨，而是功能性限制：並行會同時撞上 YYDS Mail 的建號限流（短時間內建立信箱超過
約 10 次會回傳 `403`）與 Agnes 自身的註冊風控。依序執行加隨機間隔是讓註冊機能持續運作
的必要條件，不建議透過並行來「最佳化」它。

## 隱私說明

註冊過程中產生的信箱位址、帳號密碼只在記憶體中短暫存在，**用完即棄、不會被持久化**；
儲存中只會出現鑄出的 API key 記錄。鑄 key 結束後（無論成功或失敗）臨時信箱都會被刪除。

## 疑難排解

- **啟用後若缺憑證，啟動即報錯並指明缺少哪一項設定**：註冊機採用 fail-closed 策略，缺
  憑證不會靜默降級，而是讓閘道明確失敗，方便排查。
- 補池過程中的日誌一律帶 `[registrar]` 前綴，可據此過濾查看註冊機相關的執行狀態。
- **一輪裡有名額沒鑄出來時，收尾會多打一條帶 `reasons=` 的告警**，形如
  `reasons=yyds:register_failed×3 moemail:code_timeout×1`。先看這一行判斷故障在哪一層：
  `code_timeout` = 這條通道收不到 Agnes 的信（網域 MX／郵件轉發規則）；
  `register_failed` / `login_failed` / `key_failed` = Agnes 側的註冊鏈路變了；
  `provider_error` = 信箱服務本身（憑證、活躍信箱配額、服務不可用）；
  `provider_missing` = 內部接線錯誤，正常設定下不會出現（缺憑證是啟動即報錯，走不到這裡）。
- 若某條通道持續註冊失敗（例如 Agnes 收緊了驗證碼或人機驗證策略），這是程式碼層面無法
  規避的上游變化，可以關閉註冊機、改為手動匯入 key（見 [DEPLOY.md](DEPLOY.md)）。
