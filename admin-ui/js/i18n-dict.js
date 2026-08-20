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
  //
  // ⚠️ **carry-forward（Task 4 → Task 5）**：`{ttl}` / `{touch}` / `{poolTtl}` 三个
  // 占位符在 Task 4 交付时没有数据源（capabilities/overview 是 Task 5 才有的），
  // 当时暂用「点名旋钮 + 括注默认值」。Task 5 拿到 `GET /admin/api/overview` 之后
  // 已把它们换成真实生效值——由 `js/pure/overview.mjs` 的 `poolKnobs()` 统一取数
  // （两个板块共用同一份，不许各写各的），点名旋钮的写法保留（运维要知道该改哪个
  // 环境变量），括注的默认值换成当前生效值。
  "keys.autoNote":    { "zh-CN": "这个板块与网关转发共用同一份 isolate 内的池子快照，所以自动刷新不额外产生存储读写。你看到的数据最多晚一个 POOL_CACHE_TTL_MS（当前 {ttl}）。", "zh-TW": "這個板塊與網關轉發共用同一份 isolate 內的池子快照，所以自動重新整理不額外產生儲存讀寫。你看到的資料最多晚一個 POOL_CACHE_TTL_MS（目前 {ttl}）。", en: "This section shares the same in-isolate pool snapshot as request forwarding, so auto refresh costs no extra storage reads or writes. What you see can lag by up to one POOL_CACHE_TTL_MS (currently {ttl}).", ja: "このセクションはゲートウェイの転送と同じ isolate 内プールスナップショットを共有するため、自動更新でストレージの読み書きが増えることはありません。表示は最大で POOL_CACHE_TTL_MS ぶん（現在の値: {ttl}）遅れることがあります。", ko: "이 섹션은 게이트웨이 전달과 동일한 isolate 내 풀 스냅숏을 공유하므로 자동 새로고침이 스토리지 읽기/쓰기를 추가로 발생시키지 않습니다. 보이는 데이터는 최대 POOL_CACHE_TTL_MS(현재 값 {ttl})만큼 늦을 수 있습니다." },
  // 新鲜度提示条：与概览页共用同一份文案（组织方式不同——概览页的 ov.freshness.pool
  // 还多了 configTtl 那一半，键池板块本来就没有配置卡，只留池子那一半）。
  "keys.freshness":   { "zh-CN": "别的实例判定的冷却 / 剔除，这里最多晚 {poolTtl} + 约 60 秒（KV 边缘缓存）才看到；而且这个窗口里本实例的写会覆盖对方刚写下的调度状态。", "zh-TW": "別的實例判定的冷卻 / 剔除，這裡最多晚 {poolTtl} + 約 60 秒（KV 邊緣快取）才看得到；而且這個視窗裡本實例的寫入會覆蓋對方剛寫下的排程狀態。", en: "Cooldowns and evictions decided by another instance take up to {poolTtl} plus about 60 seconds (KV edge cache) to show up here. Within that window, writes from this instance also overwrite the scheduling state the other one just wrote.", ja: "他のインスタンスが判定したクールダウン／除外がここに反映されるまで、最大で {poolTtl} + 約 60 秒（KV のエッジキャッシュ）かかります。しかもその間、このインスタンスの書き込みは相手が書いたばかりのスケジューリング状態を上書きします。", ko: "다른 인스턴스가 판정한 쿨다운/제외가 여기에 보이기까지 최대 {poolTtl} + 약 60초(KV 엣지 캐시)가 걸립니다. 게다가 그 구간에서는 이 인스턴스의 쓰기가 상대가 방금 기록한 스케줄링 상태를 덮어씁니다." },
  "keys.approxTip":   { "zh-CN": "近似值：并发请求下会少计（KV 没有 CAS）；且计数最多晚一个 POOL_TOUCH_INTERVAL_MS（当前 {touch}）才落盘，isolate 在此之前被回收时这一段会丢。", "zh-TW": "近似值：並發請求下會少計（KV 沒有 CAS）；且計數最多晚一個 POOL_TOUCH_INTERVAL_MS（目前 {touch}）才寫入，isolate 在此之前被回收時這一段會遺失。", en: "Approximate: concurrent requests undercount it (KV has no CAS), and counters are persisted up to one POOL_TOUCH_INTERVAL_MS late (currently {touch}) — whatever has not been persisted is lost if the isolate is recycled first.", ja: "概算値: 同時リクエスト下では少なく数えられます（KV に CAS がないため）。またカウンターの永続化は最大で POOL_TOUCH_INTERVAL_MS ぶん（現在の値: {touch}）遅れ、その前に isolate が回収されるとその分は失われます。", ko: "근사값: 동시 요청에서는 적게 집계됩니다(KV에 CAS가 없음). 또한 카운터는 최대 POOL_TOUCH_INTERVAL_MS(현재 값 {touch})만큼 늦게 저장되며, 그 전에 isolate가 회수되면 그 구간은 사라집니다." },
  // 「最后使用」与计数是**同一份** staleness（同一次落盘一起带下去），所以它同样打 ≈。
  // 这条与 keys.approxTip 说的不是一句话：那条讲「少计 + 晚落盘」，这条讲「时刻本身粗」。
  "keys.approxLastUsedTip": { "zh-CN": "近似值：这一列的精度最粗到一个 POOL_TOUCH_INTERVAL_MS（当前 {touch}）——写消除会把「只更新了最后使用时间」的那次写整个丢掉。任何其他状态变更的落盘都会顺带把它刷新，所以真出故障时它反而是新的。", "zh-TW": "近似值：這一欄的精度最粗到一個 POOL_TOUCH_INTERVAL_MS（目前 {touch}）——寫入消除會把「只更新了最後使用時間」的那次寫入整個丟掉。任何其他狀態變更的寫入都會順帶刷新它，所以真出故障時它反而是新的。", en: "Approximate: this column is only as precise as one POOL_TOUCH_INTERVAL_MS (currently {touch}) — a write that only bumps the last-used time is dropped entirely. Any other state change persists it as a side effect, so it is actually fresh whenever something is going wrong.", ja: "概算値: この列の精度は最も粗い場合で POOL_TOUCH_INTERVAL_MS ぶん（現在の値: {touch}）です——「最終使用時刻だけが変わった」書き込みは丸ごと破棄されます。他の状態変更の永続化はこの値もついでに更新するため、障害が起きているときはむしろ新しい値になります。", ko: "근사값: 이 열의 정밀도는 최대 POOL_TOUCH_INTERVAL_MS(현재 값 {touch})까지 거칠어집니다 — 마지막 사용 시각만 바뀐 쓰기는 통째로 버려지기 때문입니다. 다른 상태 변경이 저장될 때 함께 갱신되므로, 실제로 문제가 생겼을 때는 오히려 최신입니다." },
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

  // ── 概览板块（Task 5）──────────────────────────────────────────────────────
  "ov.title":            { "zh-CN": "概览", "zh-TW": "概覽", en: "Overview", ja: "概要", ko: "개요" },
  "ov.pool.total":       { "zh-CN": "总数", "zh-TW": "總數", en: "Total", ja: "総数", ko: "총계" },
  "ov.pool.fresh":       { "zh-CN": "可用", "zh-TW": "可用", en: "Available", ja: "利用可能", ko: "사용 가능" },
  "ov.pool.cooling":     { "zh-CN": "冷却中", "zh-TW": "冷卻中", en: "Cooling down", ja: "クールダウン中", ko: "쿨다운 중" },
  "ov.pool.evicted":     { "zh-CN": "已剔除", "zh-TW": "已剔除", en: "Evicted", ja: "除外済み", ko: "제외됨" },

  "ov.runtime.title":       { "zh-CN": "运行时信息", "zh-TW": "執行時資訊", en: "Runtime info", ja: "ランタイム情報", ko: "런타임 정보" },
  "ov.runtime.version":     { "zh-CN": "版本号", "zh-TW": "版本號", en: "Version", ja: "バージョン", ko: "버전" },
  "ov.runtime.runtimeLabel":{ "zh-CN": "运行时", "zh-TW": "執行時", en: "Runtime", ja: "ランタイム", ko: "런타임" },
  "ov.runtime.node":        { "zh-CN": "Node", "zh-TW": "Node", en: "Node", ja: "Node", ko: "Node" },
  "ov.runtime.worker":      { "zh-CN": "Cloudflare Workers", "zh-TW": "Cloudflare Workers", en: "Cloudflare Workers", ja: "Cloudflare Workers", ko: "Cloudflare Workers" },
  "ov.runtime.serverTime":  { "zh-CN": "服务器时间", "zh-TW": "伺服器時間", en: "Server time", ja: "サーバー時刻", ko: "서버 시각" },
  "ov.runtime.storageBackend": { "zh-CN": "存储后端", "zh-TW": "儲存後端", en: "Storage backend", ja: "ストレージバックエンド", ko: "스토리지 백엔드" },
  "ov.storage.file":        { "zh-CN": "文件（store.json）", "zh-TW": "檔案（store.json）", en: "File (store.json)", ja: "ファイル（store.json）", ko: "파일(store.json)" },
  "ov.storage.kv":          { "zh-CN": "KV", "zh-TW": "KV", en: "KV", ja: "KV", ko: "KV" },
  "ov.runtime.memory":      { "zh-CN": "内存", "zh-TW": "記憶體", en: "Memory", ja: "メモリ", ko: "메모리" },
  "ov.runtime.uptime":      { "zh-CN": "进程存活", "zh-TW": "行程存活時間", en: "Process uptime", ja: "プロセス稼働時間", ko: "프로세스 가동 시간" },
  "ov.runtime.pid":         { "zh-CN": "PID", "zh-TW": "PID", en: "PID", ja: "PID", ko: "PID" },
  // 产品不变式 11 逐字要求的那句话：不是 0、不是空、不隐藏格子。五语言都必须译出
  // 同一个意思（Serverless、没有常驻进程），不许省略成一个模糊词。
  "ov.runtime.serverless":  { "zh-CN": "Serverless · 无常驻进程", "zh-TW": "Serverless · 無常駐行程", en: "Serverless · no long-lived process", ja: "サーバーレス · 常駐プロセスなし", ko: "서버리스 · 상주 프로세스 없음" },
  "ov.runtime.writable":    { "zh-CN": "存储可写", "zh-TW": "儲存可寫", en: "Storage writable", ja: "ストレージ書き込み可否", ko: "스토리지 쓰기 가능 여부" },
  "ov.runtime.writableYes": { "zh-CN": "可写", "zh-TW": "可寫", en: "Writable", ja: "書き込み可能", ko: "쓰기 가능" },
  "ov.runtime.writableNo":  { "zh-CN": "不可写", "zh-TW": "不可寫", en: "Not writable", ja: "書き込み不可", ko: "쓰기 불가" },
  "ov.runtime.checkedAt":   { "zh-CN": "最近一次探测：{at}", "zh-TW": "最近一次探測：{at}", en: "Last checked: {at}", ja: "直近の確認: {at}", ko: "최근 확인: {at}" },

  "ov.freshness.title": { "zh-CN": "新鲜度", "zh-TW": "新鮮度", en: "Freshness", ja: "鮮度", ko: "신선도" },
  // 两条都要显示（progress.md:232 登记的那条），各自给出真实上界。数字全部由
  // overview.freshness 的响应值插入，不是硬编码——`{upper}` 已经把 `{ttl}` 与
  // KV 边缘缓存的量算过一遍，不是要求前端再算一次。
  "ov.freshness.pool":  { "zh-CN": "别的实例判定的冷却 / 剔除：最多晚 {upper}（{ttl} 快照 + 约 {edge} KV 边缘缓存）。这个窗口里本实例的写会覆盖对方刚写下的调度状态。", "zh-TW": "別的實例判定的冷卻 / 剔除：最多晚 {upper}（{ttl} 快照 + 約 {edge} KV 邊緣快取）。這個視窗裡本實例的寫入會覆蓋對方剛寫下的排程狀態。", en: "Cooldowns/evictions decided by another instance: up to {upper} late ({ttl} snapshot + about {edge} KV edge cache). Within that window, writes from this instance also overwrite the scheduling state the other one just wrote.", ja: "他のインスタンスが判定したクールダウン／除外：最大 {upper} 遅れます（{ttl} のスナップショット + 約 {edge} の KV エッジキャッシュ）。この間、このインスタンスの書き込みは相手が書いたばかりのスケジューリング状態を上書きします。", ko: "다른 인스턴스가 판정한 쿨다운/제외: 최대 {upper} 늦게 반영됩니다({ttl} 스냅숏 + 약 {edge} KV 엣지 캐시). 이 구간에서는 이 인스턴스의 쓰기가 상대가 방금 기록한 스케줄링 상태를 덮어씁니다." },
  "ov.freshness.config":{ "zh-CN": "配置保存之后生效：最多 {upper}（{ttl} 配置缓存 + 约 {edge} KV 边缘缓存）。不是「立即生效」。", "zh-TW": "設定儲存之後生效：最多 {upper}（{ttl} 設定快取 + 約 {edge} KV 邊緣快取）。不是「立即生效」。", en: "Config changes take effect after saving: up to {upper} ({ttl} config cache + about {edge} KV edge cache). Not \"immediately\".", ja: "設定は保存後に反映されます：最大 {upper}（{ttl} の設定キャッシュ + 約 {edge} の KV エッジキャッシュ）。「即時反映」ではありません。", ko: "설정은 저장 후 반영됩니다: 최대 {upper}({ttl} 설정 캐시 + 약 {edge} KV 엣지 캐시). \"즉시 반영\"이 아닙니다." },

  // F9：设计文档 §10.1「今日用量」的订正。Tier-1 的 stats 是自这把 key 加入以来的
  // 累计值，没有任何时间维度；把它标成「今日」是撒谎，标题直接写「累计（≈）」。
  // **不再硬编码 (≈)**：`≈` 现在由 usageStats() 的 approx 字段驱动，逐格渲染
  // （见 sec-overview.js 的 renderUsage/approxMark），标题只说「累计」这件事本身。
  "ov.usage.title":       { "zh-CN": "累计", "zh-TW": "累計", en: "Cumulative", ja: "累計", ko: "누적" },
  "ov.usage.requests":    { "zh-CN": "请求数", "zh-TW": "請求數", en: "Requests", ja: "リクエスト数", ko: "요청 수" },
  "ov.usage.success":     { "zh-CN": "成功", "zh-TW": "成功", en: "Success", ja: "成功", ko: "성공" },
  "ov.usage.failed":      { "zh-CN": "失败", "zh-TW": "失敗", en: "Failed", ja: "失敗", ko: "실패" },
  "ov.usage.clientErrors":{ "zh-CN": "客户端 4xx", "zh-TW": "用戶端 4xx", en: "Client 4xx", ja: "クライアント 4xx", ko: "클라이언트 4xx" },
  "ov.usage.successRate": { "zh-CN": "成功率", "zh-TW": "成功率", en: "Success rate", ja: "成功率", ko: "성공률" },
  "ov.usage.tip":         { "zh-CN": "这是自这批 key 加入以来的累计值，不是「今日」——按天/按小时的分解要等启用时间序列统计之后才有。", "zh-TW": "這是自這批 key 加入以來的累計值，不是「今日」——按天/按小時的分解要等啟用時間序列統計之後才有。", en: "This is the cumulative value since these keys were added, not \"today\" — a per-day/per-hour breakdown will only be available once time-series stats are enabled.", ja: "これはこの key が追加されて以降の累計値であり、「本日」ではありません——日次／時間次への分解は時系列統計が有効になってからのみ可能です。", ko: "이는 이 key가 추가된 이후의 누적값이며 \"오늘\"이 아닙니다 — 일별/시간별 분해는 시계열 통계가 활성화된 후에만 가능합니다." },
  // `≈` 标记的 tooltip：与 keys.approxTip 同一条道理（并发下少计 + 写消除延迟落盘），
  // 这里是整池聚合（sumStats），不是单把 key，措辞相应调整。
  "ov.usage.approxTip":   { "zh-CN": "近似值：这是整池所有 key 的累计聚合，单把 key 的计数在并发下会少计（KV 没有 CAS），且最多延迟一个触达间隔才落盘。", "zh-TW": "近似值：這是整池所有 key 的累計聚合，單把 key 的計數在並發下會少計（KV 沒有 CAS），且最多延遲一個觸達間隔才寫入。", en: "Approximate: this is the pool-wide aggregate over every key. Per-key counters undercount under concurrent requests (KV has no CAS) and can lag by up to one touch interval before being persisted.", ja: "概算値: これはプール内の全 key を集計した値です。key ごとのカウンターは同時リクエスト下で少なく数えられ（KV に CAS がないため）、永続化は最大でタッチ間隔ぶん遅れることがあります。", ko: "근사값: 이는 풀 전체 key의 누적 합계입니다. key별 카운터는 동시 요청에서 적게 집계되며(KV에 CAS 없음), 저장은 최대 하나의 접촉 간격만큼 늦어질 수 있습니다." },

  "ov.config.title":      { "zh-CN": "配置摘要", "zh-TW": "設定摘要", en: "Config summary", ja: "設定サマリー", ko: "설정 요약" },
  "ov.config.registrar":  { "zh-CN": "注册机", "zh-TW": "註冊機", en: "Registrar", ja: "レジストラー", ko: "등록기" },
  "ov.config.on":         { "zh-CN": "已启用", "zh-TW": "已啟用", en: "Enabled", ja: "有効", ko: "활성화됨" },
  "ov.config.off":        { "zh-CN": "已关闭", "zh-TW": "已關閉", en: "Disabled", ja: "無効", ko: "비활성화됨" },
  "ov.config.primary":    { "zh-CN": "主通道", "zh-TW": "主通道", en: "Primary channel", ja: "プライマリチャネル", ko: "기본 채널" },
  "ov.config.fallback":   { "zh-CN": "备用通道", "zh-TW": "備用通道", en: "Fallback channel", ja: "フォールバックチャネル", ko: "대체 채널" },
  "ov.config.none":       { "zh-CN": "无", "zh-TW": "無", en: "None", ja: "なし", ko: "없음" },
  "ov.config.targetKeys": { "zh-CN": "目标 key 数", "zh-TW": "目標 key 數", en: "Target key count", ja: "目標 key 数", ko: "목표 key 수" },
  "ov.config.envLocked":  { "zh-CN": "被环境变量锁定的字段数：{count}", "zh-TW": "被環境變數鎖定的欄位數：{count}", en: "Fields locked by environment variables: {count}", ja: "環境変数でロックされているフィールド数: {count}", ko: "환경 변수로 잠긴 필드 수: {count}" },
  "ov.config.envLockedTip": { "zh-CN": "这些字段在面板上改了也不会生效，因为环境变量的优先级更高：{fields}", "zh-TW": "這些欄位在面板上改了也不會生效，因為環境變數的優先權更高：{fields}", en: "Changing these fields in the panel has no effect — the environment variable takes priority: {fields}", ja: "これらのフィールドはパネルで変更しても反映されません。環境変数が優先されるためです: {fields}", ko: "이 필드는 패널에서 변경해도 적용되지 않습니다. 환경 변수가 우선하기 때문입니다: {fields}" },
  // 红色横幅：设计 §5.4/config.ts 的 degraded 信号第一次有消费者。
  "ov.config.degradedBanner": { "zh-CN": "本次配置装载发生了降级：部分字段读取失败或已回落到默认值，你在面板上保存过的值可能没有生效。", "zh-TW": "本次設定載入發生了降級：部分欄位讀取失敗或已回落到預設值，你在面板上儲存過的值可能沒有生效。", en: "This config load was degraded: some fields failed to read or fell back to defaults — values you saved in the panel may not be in effect.", ja: "今回の設定読み込みは劣化しました：一部のフィールドが読み込みに失敗したか既定値にフォールバックしています。パネルで保存した値が反映されていない可能性があります。", ko: "이번 설정 로드는 저하된 상태입니다: 일부 필드를 읽지 못했거나 기본값으로 대체되었습니다. 패널에서 저장한 값이 적용되지 않았을 수 있습니다." },

  "ov.storageCard.title":    { "zh-CN": "存储", "zh-TW": "儲存", en: "Storage", ja: "ストレージ", ko: "스토리지" },
  "ov.storageCard.backend":  { "zh-CN": "后端类型", "zh-TW": "後端類型", en: "Backend type", ja: "バックエンド種別", ko: "백엔드 유형" },
  "ov.storageCard.writable": { "zh-CN": "可写性", "zh-TW": "可寫性", en: "Writability", ja: "書き込み可否", ko: "쓰기 가능 여부" },
  "ov.storageCard.workerNote": { "zh-CN": "本部署预计每个 isolate 每天约 {estimate} 次 KV 读，只取决于刷新频率与池子规模，与请求数无关；实际总量还要乘以并发的 isolate 数目。详见 DEPLOY.md 的配额账小节。", "zh-TW": "本部署預計每個 isolate 每天約 {estimate} 次 KV 讀取，只取決於重新整理頻率與池子規模，與請求數無關；實際總量還要乘以並發的 isolate 數目。詳見 DEPLOY.md 的配額帳小節。", en: "This deployment is estimated at about {estimate} KV reads per isolate per day, driven only by refresh frequency and pool size — not by request volume. The real total also scales with the number of concurrently active isolates. See the quota section in DEPLOY.md.", ja: "このデプロイでは、1 isolate あたり 1 日約 {estimate} 回の KV 読み取りが見込まれます。これはリクエスト数ではなく更新頻度とプール規模だけで決まります。実際の合計は同時に動く isolate 数に比例して増えます。詳しくは DEPLOY.md の割り当てのセクションを参照してください。", ko: "이 배포는 isolate당 하루 약 {estimate}회의 KV 읽기가 예상되며, 요청 수가 아니라 새로고침 빈도와 풀 규모에만 좌우됩니다. 실제 총량은 동시에 활성화된 isolate 수만큼 곱해집니다. 자세한 내용은 DEPLOY.md의 할당량 섹션을 참고하세요." },
  "ov.storageCard.workerNoteUnknown": { "zh-CN": "本部署的 KV 读写与请求数无关，只取决于刷新频率与池子规模；相关数字暂时读不到，无法给出估算，详见 DEPLOY.md 的配额账小节。", "zh-TW": "本部署的 KV 讀寫與請求數無關，只取決於重新整理頻率與池子規模；相關數字暫時讀不到，無法給出估算，詳見 DEPLOY.md 的配額帳小節。", en: "This deployment's KV reads/writes are independent of request volume — driven only by refresh frequency and pool size. The numbers needed for an estimate are unavailable right now. See the quota section in DEPLOY.md.", ja: "このデプロイの KV 読み書きはリクエスト数とは無関係で、更新頻度とプール規模だけで決まります。見積もりに必要な数値が現在取得できません。詳しくは DEPLOY.md の割り当てのセクションを参照してください。", ko: "이 배포의 KV 읽기/쓰기는 요청 수와 무관하며 새로고침 빈도와 풀 규모에만 좌우됩니다. 추정에 필요한 수치를 현재 가져올 수 없습니다. 자세한 내용은 DEPLOY.md의 할당량 섹션을 참고하세요." },
  "ov.storageCard.nodeNote":  { "zh-CN": "文件存储没有配额限制，但每次写都会重写整个 store.json。", "zh-TW": "檔案儲存沒有配額限制，但每次寫入都會重寫整個 store.json。", en: "File storage has no quota limit, but every write rewrites the entire store.json.", ja: "ファイルストレージには割り当て制限はありませんが、書き込みのたびに store.json 全体を書き直します。", ko: "파일 스토리지는 할당량 제한이 없지만, 쓸 때마다 store.json 전체를 다시 씁니다." },

  // ── 事件板块（Task 6）────────────────────────────────────────────────────
  "ev.title":  { "zh-CN": "事件", "zh-TW": "事件", en: "Events", ja: "イベント", ko: "이벤트" },
  // 顶部常驻说明（两种运行时同一句，见 Task 5 Step 4 的 logs.processLog: false 那条先例）：
  // Serverless 没有常驻进程，逐请求日志流在这里物理上不可能是完整的。
  "ev.notice": { "zh-CN": "这里只有低频结构化事件（补池、冷却、剔除、登录失败等）。逐请求日志请看容器 stdout / Cloudflare 控制台的 Workers Logs——Serverless 形态没有常驻进程，逐请求日志流在这里物理上不可能是完整的。", "zh-TW": "這裡只有低頻結構化事件（補池、冷卻、剔除、登入失敗等）。逐請求日誌請看容器 stdout / Cloudflare 主控台的 Workers Logs——Serverless 形態沒有常駐行程，逐請求日誌流在這裡物理上不可能是完整的。", en: "This shows only low-frequency structured events (pool refills, cooldowns, evictions, failed logins, etc.). For per-request logs, check container stdout or Cloudflare's Workers Logs — the serverless shape has no long-lived process, so a complete per-request log stream is physically impossible here.", ja: "ここには低頻度の構造化イベント（補充、クールダウン、除外、ログイン失敗など）のみが表示されます。リクエストごとのログはコンテナの stdout または Cloudflare コンソールの Workers Logs をご覧ください——サーバーレス形態には常駐プロセスがなく、ここでリクエストごとの完全なログストリームを見ることは物理的に不可能です。", ko: "여기에는 저빈도 구조화 이벤트(재보충, 쿨다운, 제외, 로그인 실패 등)만 표시됩니다. 요청별 로그는 컨테이너 stdout 또는 Cloudflare 콘솔의 Workers Logs를 확인하세요——서버리스 형태에는 상주 프로세스가 없어 여기서 완전한 요청별 로그 스트림을 보는 것은 물리적으로 불가능합니다." },
  "ev.search": { "zh-CN": "搜索事件名 / 说明 / 字段…", "zh-TW": "搜尋事件名 / 說明 / 欄位…", en: "Search event / message / fields…", ja: "イベント名／説明／フィールドを検索…", ko: "이벤트명/설명/필드 검색…" },

  "ev.level.all":   { "zh-CN": "全部级别", "zh-TW": "全部級別", en: "All levels", ja: "すべてのレベル", ko: "모든 레벨" },
  "ev.level.debug": { "zh-CN": "调试", "zh-TW": "偵錯", en: "Debug", ja: "デバッグ", ko: "디버그" },
  "ev.level.info":  { "zh-CN": "信息", "zh-TW": "資訊", en: "Info", ja: "情報", ko: "정보" },
  "ev.level.warn":  { "zh-CN": "警告", "zh-TW": "警告", en: "Warn", ja: "警告", ko: "경고" },
  "ev.level.error": { "zh-CN": "错误", "zh-TW": "錯誤", en: "Error", ja: "エラー", ko: "오류" },

  "ev.pause":   { "zh-CN": "暂停", "zh-TW": "暫停", en: "Pause", ja: "一時停止", ko: "일시 정지" },
  "ev.resume":  { "zh-CN": "继续", "zh-TW": "繼續", en: "Resume", ja: "再開", ko: "재개" },
  "ev.clear":   { "zh-CN": "清空", "zh-TW": "清空", en: "Clear", ja: "クリア", ko: "지우기" },
  "ev.clearTip":{ "zh-CN": "只清前端当前显示的列表，不影响服务端已落盘的事件", "zh-TW": "只清前端目前顯示的清單，不影響服務端已寫入的事件", en: "Clears only the list shown here; does not affect events already persisted server-side", ja: "ここに表示中のリストのみクリアします。サーバー側に保存済みのイベントには影響しません", ko: "여기에 표시된 목록만 지웁니다. 서버에 이미 저장된 이벤트에는 영향을 주지 않습니다" },
  "ev.download":{ "zh-CN": "下载", "zh-TW": "下載", en: "Download", ja: "ダウンロード", ko: "다운로드" },
  "ev.autoScroll": { "zh-CN": "自动滚动", "zh-TW": "自動捲動", en: "Auto-scroll", ja: "自動スクロール", ko: "자동 스크롤" },

  "ev.pollStatus.active": { "zh-CN": "轮询中", "zh-TW": "輪詢中", en: "Polling", ja: "ポーリング中", ko: "폴링 중" },
  "ev.pollStatus.paused": { "zh-CN": "已暂停", "zh-TW": "已暫停", en: "Paused", ja: "一時停止中", ko: "일시 정지됨" },
  "ev.pollStatus.error":  { "zh-CN": "轮询出错，稍后重试", "zh-TW": "輪詢出錯，稍後重試", en: "Polling error, will retry", ja: "ポーリングエラー、後で再試行します", ko: "폴링 오류, 나중에 재시도합니다" },

  // dropped/budgetExhausted 两条黄条文案：**各自独立**，由响应对应字段各自驱动，
  // 不是同一句话的两种措辞（见 pure/events.mjs 的 shouldWarn 说明）。
  "ev.warnDropped": { "zh-CN": "本 isolate 的事件缓冲已丢弃 {count} 条最旧的事件（环形缓冲上限 100 条，落盘前被新事件顶掉）。", "zh-TW": "本 isolate 的事件緩衝已丟棄 {count} 條最舊的事件（環形緩衝上限 100 條，寫入前被新事件頂掉）。", en: "This isolate's event buffer has dropped {count} of the oldest events (ring buffer caps at 100 entries; new events pushed them out before they were persisted).", ja: "この isolate のイベントバッファは最も古い {count} 件のイベントを破棄しました（リングバッファの上限は 100 件で、書き込み前に新しいイベントに押し出されました）。", ko: "이 isolate의 이벤트 버퍼가 가장 오래된 이벤트 {count}건을 삭제했습니다(링 버퍼 상한 100건, 저장 전에 새 이벤트에 밀려남)." },
  "ev.warnBudget":  { "zh-CN": "本 isolate 这一小时的事件写入预算已用完，未落盘的事件仍在容器日志 / Cloudflare 控制台的 Workers Logs 里。", "zh-TW": "本 isolate 這一小時的事件寫入預算已用完，未寫入的事件仍在容器日誌 / Cloudflare 主控台的 Workers Logs 裡。", en: "This isolate's event-write budget for the current hour is used up. Events that were not persisted are still available in container logs / Cloudflare's Workers Logs.", ja: "この isolate の今時間帯のイベント書き込み予算を使い切りました。書き込まれなかったイベントはコンテナログ／Cloudflare コンソールの Workers Logs に残っています。", ko: "이 isolate의 현재 시간대 이벤트 쓰기 예산을 모두 사용했습니다. 저장되지 않은 이벤트는 컨테이너 로그/Cloudflare 콘솔의 Workers Logs에 남아 있습니다." },

  "ev.empty":   { "zh-CN": "还没有事件。", "zh-TW": "還沒有事件。", en: "No events yet.", ja: "まだイベントはありません。", ko: "아직 이벤트가 없습니다." },
  "ev.noMatch": { "zh-CN": "没有符合筛选条件的事件。", "zh-TW": "沒有符合篩選條件的事件。", en: "No events match the current filters.", ja: "現在のフィルター条件に一致するイベントはありません。", ko: "현재 필터 조건에 맞는 이벤트가 없습니다." },

  "ev.col.time":   { "zh-CN": "时间", "zh-TW": "時間", en: "Time", ja: "時刻", ko: "시각" },
  "ev.col.level":  { "zh-CN": "级别", "zh-TW": "級別", en: "Level", ja: "レベル", ko: "레벨" },
  "ev.col.event":  { "zh-CN": "事件", "zh-TW": "事件", en: "Event", ja: "イベント", ko: "이벤트" },
  "ev.col.detail": { "zh-CN": "说明 / 字段", "zh-TW": "說明 / 欄位", en: "Message / fields", ja: "説明／フィールド", ko: "설명/필드" },

  // 分组时间线的组头文案（P-1：按 corr 相邻折叠）。
  "ev.timeline": { "zh-CN": "时间线 · {count} 条 · {corr}", "zh-TW": "時間線 · {count} 條 · {corr}", en: "Timeline · {count} events · {corr}", ja: "タイムライン · {count} 件 · {corr}", ko: "타임라인 · {count}건 · {corr}" },
};
