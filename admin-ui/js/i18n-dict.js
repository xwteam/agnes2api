/**
 * 五语言字典。**唯一真源。**
 *
 * 组织成 key-major（一个键下挂五种语言）而不是 lang-major：
 * 「加了一个键但只填了一种语言」在 key-major 的 diff 里一眼就能看见，
 * 而 lang-major 下它散在五个相距几百行的地方。齐全性有 CI 门禁
 *（scripts/check-i18n.mjs 与 tests/unit/i18n-dict.test.ts 两份独立实现），
 * 这个组织方式只是让人工评审也拦得住。
 *
 * 为什么是 .js 而不是 .json：`scripts/build-ui.mjs` 逐字节复制、**零例外**，
 * 那条性质是本项目守住「不引入需要构建步骤的前端框架」的全部依据。
 * 给它开一个「JSON 包裹成 JS」的例外，代价是逐字节断言要加豁免，
 * 而且生成物不在磁盘上 ⇒ 用浏览器直接打开 index.html 时 `import "./i18n-dict.js"`
 * 模块解析失败、**整个面板打不开**（ESM 的失败是整条链断）。
 * 已实测：`.js` 同样能被 vitest 直接 import，`pnpm typecheck` 退出 0。
 *
 * ⚠️ `reg.*` 命名空间有**禁用词门禁**（两条邮箱通道必须完全平级）。
 * 想说「默认值」请把那条文案放进别的命名空间，别去给禁用词表开豁免。
 */
export const I18N = {
  // ── 登录闸 ───────────────────────────────────────────────
  "gate.title":       { "zh-CN": "agnes2api 管理后台", "zh-TW": "agnes2api 管理後台", en: "agnes2api Admin", ja: "agnes2api 管理画面", ko: "agnes2api 관리 콘솔" },
  "gate.sub":         { "zh-CN": "请输入管理口令（ADMIN_TOKEN）", "zh-TW": "請輸入管理口令（ADMIN_TOKEN）", en: "Enter the admin token (ADMIN_TOKEN)", ja: "管理トークン（ADMIN_TOKEN）を入力してください", ko: "관리 토큰(ADMIN_TOKEN)을 입력하세요" },
  "gate.label":       { "zh-CN": "管理口令", "zh-TW": "管理口令", en: "Admin token", ja: "管理トークン", ko: "관리 토큰" },
  "gate.placeholder": { "zh-CN": "ADMIN_TOKEN", "zh-TW": "ADMIN_TOKEN", en: "ADMIN_TOKEN", ja: "ADMIN_TOKEN", ko: "ADMIN_TOKEN" },
  "gate.submit":      { "zh-CN": "进入", "zh-TW": "進入", en: "Enter", ja: "入る", ko: "들어가기" },
  "gate.empty":       { "zh-CN": "请输入管理口令", "zh-TW": "請輸入管理口令", en: "Please enter the admin token", ja: "管理トークンを入力してください", ko: "관리 토큰을 입력하세요" },
  "gate.invalid":     { "zh-CN": "口令无效", "zh-TW": "口令無效", en: "Invalid token", ja: "トークンが無効です", ko: "토큰이 올바르지 않습니다" },
  "gate.badShape":    { "zh-CN": "这个口令里有浏览器发不出去的字符（非 ASCII 或控制字符），请检查环境变量里的 ADMIN_TOKEN", "zh-TW": "這個口令裡有瀏覽器送不出去的字元（非 ASCII 或控制字元），請檢查環境變數裡的 ADMIN_TOKEN", en: "This token contains characters the browser cannot send (non-ASCII or control characters). Check ADMIN_TOKEN in your environment.", ja: "このトークンにはブラウザーが送信できない文字（非 ASCII または制御文字）が含まれています。環境変数の ADMIN_TOKEN を確認してください。", ko: "이 토큰에는 브라우저가 전송할 수 없는 문자(비 ASCII 또는 제어 문자)가 있습니다. 환경 변수의 ADMIN_TOKEN을 확인하세요." },
  "gate.network":     { "zh-CN": "网络错误，请稍后重试", "zh-TW": "網路錯誤，請稍後重試", en: "Network error, please retry", ja: "ネットワークエラーです。しばらくしてから再試行してください", ko: "네트워크 오류입니다. 잠시 후 다시 시도하세요" },
  "gate.httpError":   { "zh-CN": "接口异常：{status}", "zh-TW": "介面異常：{status}", en: "Request failed: {status}", ja: "リクエスト失敗: {status}", ko: "요청 실패: {status}" },

  // ── 外壳 ─────────────────────────────────────────────────
  "nav.overview":     { "zh-CN": "概览", "zh-TW": "概覽", en: "Overview", ja: "概要", ko: "개요" },
  "nav.keys":         { "zh-CN": "Key 池", "zh-TW": "Key 池", en: "Key pool", ja: "キープール", ko: "키 풀" },
  "nav.events":       { "zh-CN": "事件", "zh-TW": "事件", en: "Events", ja: "イベント", ko: "이벤트" },
  "shell.logout":     { "zh-CN": "退出登录", "zh-TW": "登出", en: "Sign out", ja: "ログアウト", ko: "로그아웃" },
  "shell.theme":      { "zh-CN": "切换主题", "zh-TW": "切換主題", en: "Toggle theme", ja: "テーマ切り替え", ko: "테마 전환" },
  "shell.lang":       { "zh-CN": "语言", "zh-TW": "語言", en: "Language", ja: "言語", ko: "언어" },
  "common.dash":      { "zh-CN": "—", "zh-TW": "—", en: "—", ja: "—", ko: "—" },
  "common.refresh":   { "zh-CN": "刷新", "zh-TW": "重新整理", en: "Refresh", ja: "更新", ko: "새로고침" },
  "common.loadFailed":{ "zh-CN": "读取失败，显示为 —", "zh-TW": "讀取失敗，顯示為 —", en: "Failed to load; shown as —", ja: "取得に失敗しました（— と表示）", ko: "불러오기 실패(—로 표시)" },
  "common.approx":    { "zh-CN": "近似值", "zh-TW": "近似值", en: "Approximate", ja: "概算値", ko: "근사값" },
  "common.copy":      { "zh-CN": "复制", "zh-TW": "複製", en: "Copy", ja: "コピー", ko: "복사" },
  "common.copied":    { "zh-CN": "已复制", "zh-TW": "已複製", en: "Copied", ja: "コピーしました", ko: "복사했습니다" },
  "common.copyFailed":{ "zh-CN": "复制失败", "zh-TW": "複製失敗", en: "Copy failed", ja: "コピーに失敗しました", ko: "복사에 실패했습니다" },
  "common.cancel":    { "zh-CN": "取消", "zh-TW": "取消", en: "Cancel", ja: "キャンセル", ko: "취소" },
  "common.confirm":   { "zh-CN": "确定", "zh-TW": "確定", en: "Confirm", ja: "確認", ko: "확인" },
  "common.sessionExpired": { "zh-CN": "会话已过期，请重新输入管理口令", "zh-TW": "工作階段已過期，請重新輸入管理口令", en: "Session expired, please sign in again", ja: "セッションが失効しました。再度サインインしてください", ko: "세션이 만료되었습니다. 다시 로그인하세요" },

  // ── 补池失败归因（P3c 的注册机板块才渲染；本期先把键写齐，好让门禁从第一天就是活的）──
  "reg.fail.domain_blocked_all": { "zh-CN": "所有域名都被上游拦下", "zh-TW": "所有網域都被上游擋下", en: "Every domain was blocked upstream", ja: "すべてのドメインが上流でブロックされました", ko: "모든 도메인이 업스트림에서 차단되었습니다" },
  "reg.fail.upstream_error":     { "zh-CN": "上游返回错误", "zh-TW": "上游回傳錯誤", en: "Upstream returned an error", ja: "上流がエラーを返しました", ko: "업스트림이 오류를 반환했습니다" },
  "reg.fail.code_timeout":       { "zh-CN": "等验证码超时", "zh-TW": "等驗證碼逾時", en: "Timed out waiting for the verification code", ja: "認証コードの待機がタイムアウトしました", ko: "인증 코드 대기 시간이 초과되었습니다" },
  "reg.fail.register_failed":    { "zh-CN": "注册这一步失败", "zh-TW": "註冊這一步失敗", en: "Registration step failed", ja: "登録ステップが失敗しました", ko: "가입 단계가 실패했습니다" },
  "reg.fail.login_failed":       { "zh-CN": "登录这一步失败", "zh-TW": "登入這一步失敗", en: "Login step failed", ja: "ログインステップが失敗しました", ko: "로그인 단계가 실패했습니다" },
  "reg.fail.key_failed":         { "zh-CN": "取 key 这一步失败", "zh-TW": "取 key 這一步失敗", en: "Key issuance step failed", ja: "キー取得ステップが失敗しました", ko: "키 발급 단계가 실패했습니다" },
  "reg.fail.provider_error":     { "zh-CN": "邮箱通道报错", "zh-TW": "郵箱通道報錯", en: "The mailbox channel returned an error", ja: "メールボックスチャネルがエラーを返しました", ko: "메일박스 채널이 오류를 반환했습니다" },
  "reg.fail.network_error":      { "zh-CN": "网络错误", "zh-TW": "網路錯誤", en: "Network error", ja: "ネットワークエラー", ko: "네트워크 오류" },
  "reg.fail.rate_limited":       { "zh-CN": "被上游限流", "zh-TW": "被上游限流", en: "Rate limited upstream", ja: "上流でレート制限されました", ko: "업스트림에서 속도 제한되었습니다" },
  "reg.fail.provider_missing":   { "zh-CN": "这条通道没有配好凭据，未构造出提供方", "zh-TW": "這條通道沒有配好憑據，未建立提供方", en: "This channel has no credentials configured, so no provider was constructed", ja: "このチャネルは資格情報が未設定のため、プロバイダーが構築されませんでした", ko: "이 채널에 자격 증명이 없어 공급자가 생성되지 않았습니다" },

  // ── Key 池板块（只读部分，Task 4）─────────────────────────────────────────
  "keys.title":       { "zh-CN": "Key 池", "zh-TW": "Key 池", en: "Key pool", ja: "キープール", ko: "키 풀" },
  "keys.search":      { "zh-CN": "搜索 id 或掩码", "zh-TW": "搜尋 id 或遮罩", en: "Search by id or masked key", ja: "id またはマスクで検索", ko: "id 또는 마스크로 검색" },
  "keys.filter":      { "zh-CN": "按状态筛选", "zh-TW": "依狀態篩選", en: "Filter by state", ja: "状態で絞り込み", ko: "상태로 필터" },
  "keys.auto":        { "zh-CN": "自动刷新", "zh-TW": "自動重新整理", en: "Auto refresh", ja: "自動更新", ko: "자동 새로고침" },
  "keys.auto.off":    { "zh-CN": "关", "zh-TW": "關", en: "Off", ja: "オフ", ko: "끄기" },
  "keys.auto.30":     { "zh-CN": "30 秒", "zh-TW": "30 秒", en: "30s", ja: "30 秒", ko: "30초" },
  "keys.auto.60":     { "zh-CN": "60 秒", "zh-TW": "60 秒", en: "60s", ja: "60 秒", ko: "60초" },
  // 开销说明**如实写**，不抄一个吓人的估算数字：这个板块与转发共用同一份 isolate
  // 快照，P3b 的形态下自动刷新确实不烧存储配额。
  "keys.autoNote":    { "zh-CN": "这个板块与网关转发共用同一份 isolate 内的池子快照，所以自动刷新不额外产生存储读写。你看到的数据最多晚一个 POOL_CACHE_TTL_MS（默认 60 秒）。", "zh-TW": "這個板塊與網關轉發共用同一份 isolate 內的池子快照，所以自動重新整理不額外產生儲存讀寫。你看到的資料最多晚一個 POOL_CACHE_TTL_MS（預設 60 秒）。", en: "This section shares the same in-isolate pool snapshot as request forwarding, so auto refresh costs no extra storage reads or writes. What you see can lag by up to one POOL_CACHE_TTL_MS (60s out of the box).", ja: "このセクションはゲートウェイの転送と同じ isolate 内プールスナップショットを共有するため、自動更新でストレージの読み書きが増えることはありません。表示は最大で POOL_CACHE_TTL_MS ぶん（既定 60 秒）遅れることがあります。", ko: "이 섹션은 게이트웨이 전달과 동일한 isolate 내 풀 스냅숏을 공유하므로 자동 새로고침이 스토리지 읽기/쓰기를 추가로 발생시키지 않습니다. 보이는 데이터는 최대 POOL_CACHE_TTL_MS(초기값 60초)만큼 늦을 수 있습니다." },
  // 新鲜度提示条：与概览页共用同一份文案，数字与五语言 DEPLOY.md 的 POOL_CACHE_TTL_MS 一行一致。
  "keys.freshness":   { "zh-CN": "别的实例判定的冷却 / 剔除，这里最多晚一个 POOL_CACHE_TTL_MS + 约 60 秒（KV 边缘缓存）才看到，默认配置下约 120 秒；而且这个窗口里本实例的写会覆盖对方刚写下的调度状态。", "zh-TW": "別的實例判定的冷卻 / 剔除，這裡最多晚一個 POOL_CACHE_TTL_MS + 約 60 秒（KV 邊緣快取）才看得到，預設設定下約 120 秒；而且這個視窗裡本實例的寫入會覆蓋對方剛寫下的排程狀態。", en: "Cooldowns and evictions decided by another instance take up to one POOL_CACHE_TTL_MS plus about 60 seconds (KV edge cache) to show up here — about 120 seconds with the default settings. Within that window, writes from this instance also overwrite the scheduling state the other one just wrote.", ja: "他のインスタンスが判定したクールダウン／除外がここに反映されるまで、最大で POOL_CACHE_TTL_MS + 約 60 秒（KV のエッジキャッシュ）かかります。既定設定では約 120 秒です。しかもその間、このインスタンスの書き込みは相手が書いたばかりのスケジューリング状態を上書きします。", ko: "다른 인스턴스가 판정한 쿨다운/제외가 여기에 보이기까지 최대 POOL_CACHE_TTL_MS + 약 60초(KV 엣지 캐시)가 걸리며, 초기 설정에서는 약 120초입니다. 게다가 그 구간에서는 이 인스턴스의 쓰기가 상대가 방금 기록한 스케줄링 상태를 덮어씁니다." },
  "keys.approxTip":   { "zh-CN": "近似值：并发请求下会少计（KV 没有 CAS）；且计数最多晚一个 POOL_TOUCH_INTERVAL_MS（默认 6 小时）才落盘，isolate 在此之前被回收时这一段会丢。", "zh-TW": "近似值：並發請求下會少計（KV 沒有 CAS）；且計數最多晚一個 POOL_TOUCH_INTERVAL_MS（預設 6 小時）才寫入，isolate 在此之前被回收時這一段會遺失。", en: "Approximate: concurrent requests undercount it (KV has no CAS), and counters are persisted up to one POOL_TOUCH_INTERVAL_MS late (6 hours out of the box) — whatever has not been persisted is lost if the isolate is recycled first.", ja: "概算値: 同時リクエスト下では少なく数えられます（KV に CAS がないため）。またカウンターの永続化は最大で POOL_TOUCH_INTERVAL_MS ぶん（既定 6 時間）遅れ、その前に isolate が回収されるとその分は失われます。", ko: "근사값: 동시 요청에서는 적게 집계됩니다(KV에 CAS가 없음). 또한 카운터는 최대 POOL_TOUCH_INTERVAL_MS(초기값 6시간)만큼 늦게 저장되며, 그 전에 isolate가 회수되면 그 구간은 사라집니다." },
  "keys.bucket.all":     { "zh-CN": "全部", "zh-TW": "全部", en: "All", ja: "すべて", ko: "전체" },
  "keys.bucket.fresh":   { "zh-CN": "可用", "zh-TW": "可用", en: "Available", ja: "利用可能", ko: "사용 가능" },
  "keys.bucket.cooling": { "zh-CN": "冷却中", "zh-TW": "冷卻中", en: "Cooling down", ja: "クールダウン中", ko: "쿨다운 중" },
  "keys.bucket.evicted": { "zh-CN": "已剔除", "zh-TW": "已剔除", en: "Evicted", ja: "除外済み", ko: "제외됨" },
  "keys.col.seq":        { "zh-CN": "#", "zh-TW": "#", en: "#", ja: "#", ko: "#" },
  "keys.col.key":        { "zh-CN": "Key", "zh-TW": "Key", en: "Key", ja: "Key", ko: "Key" },
  "keys.col.bucket":     { "zh-CN": "状态", "zh-TW": "狀態", en: "State", ja: "状態", ko: "상태" },
  "keys.col.addedAt":    { "zh-CN": "加入时间", "zh-TW": "加入時間", en: "Added", ja: "追加日時", ko: "추가 시각" },
  "keys.col.lastUsedAt": { "zh-CN": "最后使用", "zh-TW": "最後使用", en: "Last used", ja: "最終使用", ko: "마지막 사용" },
  "keys.col.cooldown":   { "zh-CN": "冷却剩余", "zh-TW": "冷卻剩餘", en: "Cooldown left", ja: "クールダウン残り", ko: "쿨다운 잔여" },
  "keys.col.strikes":    { "zh-CN": "连续失败", "zh-TW": "連續失敗", en: "Strikes", ja: "連続失敗", ko: "연속 실패" },
  "keys.col.usage":      { "zh-CN": "请求数 · 成功率", "zh-TW": "請求數 · 成功率", en: "Requests · success rate", ja: "リクエスト数 · 成功率", ko: "요청 수 · 성공률" },
  "keys.col.lastError":  { "zh-CN": "最近错误", "zh-TW": "最近錯誤", en: "Last error", ja: "直近のエラー", ko: "최근 오류" },
  "keys.empty":       { "zh-CN": "池子里还没有 key", "zh-TW": "池子裡還沒有 key", en: "No keys in the pool yet", ja: "プールにまだ key がありません", ko: "풀에 아직 key가 없습니다" },
  "keys.noMatch":     { "zh-CN": "没有符合条件的 key", "zh-TW": "沒有符合條件的 key", en: "No keys match the current filter", ja: "条件に一致する key がありません", ko: "조건에 맞는 key가 없습니다" },
  "keys.pageInfo":    { "zh-CN": "第 {page}/{pages} 页 · 共 {total} 条", "zh-TW": "第 {page}/{pages} 頁 · 共 {total} 筆", en: "Page {page} of {pages} · {total} in total", ja: "{pages} ページ中 {page} ページ目 · 全 {total} 件", ko: "{pages} 페이지 중 {page} 페이지 · 총 {total}개" },
  "keys.prev":        { "zh-CN": "上一页", "zh-TW": "上一頁", en: "Previous", ja: "前へ", ko: "이전" },
  "keys.next":        { "zh-CN": "下一页", "zh-TW": "下一頁", en: "Next", ja: "次へ", ko: "다음" },

  // 其余板块自己的键由各自的任务追加（Task 5 概览 / Task 6 事件）。
};
