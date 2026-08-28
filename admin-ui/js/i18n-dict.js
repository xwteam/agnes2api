/**
 * 五语言字典。**唯一真源。**
 *
 * 组织成 key-major（一个键下挂五种语言）而不是 lang-major：
 * 「加了一个键但只填了一种语言」在 key-major 的 diff 里一眼就能看见，
 * 而 lang-major 下它散在五个相距几百行的地方。齐全性有 CI 门禁
 *（`scripts/check-i18n.mjs` 与 `tests/unit/i18n-dict.test.ts` 的
 * 「每个 key 都有全部 5 种语言且非空」两份独立实现），
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
  "gate.badShape":    { "zh-CN": "这个口令里有不被接受的字符。只允许可打印 ASCII（0x20–0x7E）：汉字 / emoji / 零宽空格这类字符浏览器根本发不出去；é / £ 这类字符其实发得出去，但本网关出于跨运行时编码的稳健性考虑同样不接受。请检查环境变量里的 ADMIN_TOKEN。", "zh-TW": "這個口令裡有不被接受的字元。只允許可列印 ASCII（0x20–0x7E）：漢字 / emoji / 零寬空格這類字元瀏覽器根本送不出去；é / £ 這類字元其實送得出去，但本網關基於跨執行時編碼的穩健性考量同樣不接受。請檢查環境變數裡的 ADMIN_TOKEN。", en: "This token contains characters that are not accepted. Only printable ASCII (0x20–0x7E) is allowed: CJK characters, emoji and zero-width spaces simply cannot be sent by the browser, while characters like é or £ can be sent but are still rejected here as a cross-runtime encoding robustness choice. Check ADMIN_TOKEN in your environment.", ja: "このトークンには受け付けられない文字が含まれています。使用できるのは印字可能な ASCII（0x20–0x7E）のみです: 漢字・emoji・ゼロ幅スペースはブラウザーがそもそも送信できません。é や £ のような文字は送信自体は可能ですが、ランタイム間のエンコーディングに関する堅牢性の判断としてここでは受け付けていません。環境変数の ADMIN_TOKEN を確認してください。", ko: "이 토큰에는 허용되지 않는 문자가 있습니다. 출력 가능한 ASCII(0x20–0x7E)만 사용할 수 있습니다: 한자 / 이모지 / 폭 없는 공백은 브라우저가 아예 보낼 수 없고, é 나 £ 같은 문자는 보낼 수는 있지만 런타임 간 인코딩 견고성을 위한 선택으로 여기서는 받지 않습니다. 환경 변수의 ADMIN_TOKEN을 확인하세요." },
  "gate.network":     { "zh-CN": "网络错误，请稍后重试", "zh-TW": "網路錯誤，請稍後重試", en: "Network error, please retry", ja: "ネットワークエラーです。しばらくしてから再試行してください", ko: "네트워크 오류입니다. 잠시 후 다시 시도하세요" },
  "gate.httpError":   { "zh-CN": "接口异常：{status}", "zh-TW": "介面異常：{status}", en: "Request failed: {status}", ja: "リクエスト失敗: {status}", ko: "요청 실패: {status}" },

  // ── 外壳 ─────────────────────────────────────────────────
  "nav.overview":     { "zh-CN": "概览", "zh-TW": "概覽", en: "Overview", ja: "概要", ko: "개요" },
  "nav.keys":         { "zh-CN": "Key 池", "zh-TW": "Key 池", en: "Key pool", ja: "キープール", ko: "키 풀" },
  // ⚠️ 导航项刻意放在 `nav.*` 而不是 `reg.*`：`reg.*` 是禁用词门禁的作用域，
  // 而那道门禁管的是「两条邮箱通道有没有被暗示成有高下」，与一个板块名无关。
  "nav.registrar":    { "zh-CN": "注册机", "zh-TW": "註冊機", en: "Registrar", ja: "レジストラー", ko: "등록기" },
  "nav.events":       { "zh-CN": "事件", "zh-TW": "事件", en: "Events", ja: "イベント", ko: "이벤트" },
  // ⚠️ 与 `nav.registrar` 同一条理由，放 `nav.*` 而不是 `usage.*`：命名空间在这里
  // 表示的是「壳层导航」，与板块内部的文案分开。
  "nav.usage":        { "zh-CN": "用量", "zh-TW": "用量", en: "Usage", ja: "使用量", ko: "사용량" },
  // ⚠️ 与 `nav.registrar` 同一条理由，放 `nav.*` 而不是 `models.*`：命名空间在这里
  // 表示的是「壳层导航」，与板块内部的文案分开。
  "nav.models":       { "zh-CN": "模型", "zh-TW": "模型", en: "Models", ja: "モデル", ko: "모델" },
  // ⚠️ 与 `nav.registrar` 同一条理由，放 `nav.*` 而不是 `pg.*`：命名空间在这里
  // 表示的是「壳层导航」，与板块内部的文案分开。
  "nav.playground":   { "zh-CN": "调试台", "zh-TW": "偵錯台", en: "Playground", ja: "プレイグラウンド", ko: "플레이그라운드" },
  // ⚠️ 与 `nav.registrar` 同一条理由，放 `nav.*` 而不是 `set.*`：命名空间在这里
  // 表示的是「壳层导航」，与板块内部的文案分开。
  "nav.settings":     { "zh-CN": "设置", "zh-TW": "設定", en: "Settings", ja: "設定", ko: "설정" },
  "shell.logout":     { "zh-CN": "退出登录", "zh-TW": "登出", en: "Sign out", ja: "ログアウト", ko: "로그아웃" },
  "shell.theme":      { "zh-CN": "切换主题", "zh-TW": "切換主題", en: "Toggle theme", ja: "テーマ切り替え", ko: "테마 전환" },
  "shell.lang":       { "zh-CN": "语言", "zh-TW": "語言", en: "Language", ja: "言語", ko: "언어" },
  "common.refresh":   { "zh-CN": "刷新", "zh-TW": "重新整理", en: "Refresh", ja: "更新", ko: "새로고침" },
  "common.loadFailed":{ "zh-CN": "读取失败，显示为 —", "zh-TW": "讀取失敗，顯示為 —", en: "Failed to load; shown as —", ja: "取得に失敗しました（— と表示）", ko: "불러오기 실패(—로 표시)" },
  "common.copy":      { "zh-CN": "复制", "zh-TW": "複製", en: "Copy", ja: "コピー", ko: "복사" },
  "common.copied":    { "zh-CN": "已复制", "zh-TW": "已複製", en: "Copied", ja: "コピーしました", ko: "복사했습니다" },
  "common.copyFailed":{ "zh-CN": "复制失败", "zh-TW": "複製失敗", en: "Copy failed", ja: "コピーに失敗しました", ko: "복사에 실패했습니다" },
  "common.cancel":    { "zh-CN": "取消", "zh-TW": "取消", en: "Cancel", ja: "キャンセル", ko: "취소" },
  "common.confirm":   { "zh-CN": "确定", "zh-TW": "確定", en: "Confirm", ja: "確認", ko: "확인" },
  // 需要手动关闭的 toast 上那颗「×」按钮的无障碍标签（P3c Task 4：批量操作部分
  // 失败这类信息不自动消失，见 js/ui.js 的 toast() 说明）。
  "common.dismiss":   { "zh-CN": "关闭提示", "zh-TW": "關閉提示", en: "Dismiss", ja: "閉じる", ko: "닫기" },
  "common.sessionExpired": { "zh-CN": "会话已过期，请重新输入管理口令", "zh-TW": "工作階段已過期，請重新輸入管理口令", en: "Session expired, please sign in again", ja: "セッションが失効しました。再度サインインしてください", ko: "세션이 만료되었습니다. 다시 로그인하세요" },

  // ── 管理接口错误码 → 五语言文案（P3e Task 22A）───────────────────────────
  //
  // ⚠️⚠️ **这一族存在的全部理由：在它之前，后端那句中文 `error.message` 被
  // `js/sec-keys.js` 原样画到 ja / en / ko 的屏幕上。** 现在后端只回一个闭集里的
  // `error.code`（`src/core/admin/admin-errors.ts`），文案在这里，五语言各一份。
  // 码 → 键的对照表在 `js/pure/keys-write.mjs` 的 `ADMIN_ERROR_TEXT_KEY`，
  // **写成字面量而不是 `err.` 前缀拼键**——拼键会把整族变成永久豁免，理由写在那张表上方。
  //
  // ⚠️ **`keys.mustDisableFirst` 刻意不在这个命名空间里另开一条**：那句话早就有了
  // （下面 Key 池写操作那一段），再写一份就是同一批文案两份真源。对照表直接指过去。
  "err.untranslated": { "zh-CN": "{message}（这句是后端原话，本面板还没有这条错误码的译文）", "zh-TW": "{message}（這句是後端原話，本面板還沒有這條錯誤碼的譯文）", en: "{message} (raw text from the backend; this panel has no translation for that error code yet)", ja: "{message}（これはバックエンドの原文です。このパネルにはそのエラーコードの訳文がまだありません）", ko: "{message} (백엔드가 보낸 원문입니다. 이 패널에는 해당 오류 코드의 번역문이 아직 없습니다)" },
  "err.admin_unavailable": { "zh-CN": "管理接口已停用。原因只写进了服务端日志，请查一下管理口令的配置。", "zh-TW": "管理介面已停用。原因只寫進了伺服器日誌，請查一下管理口令的設定。", en: "The admin API is disabled. The reason is written only to the server log; check the admin token configuration.", ja: "管理 API は停止しています。理由はサーバーログにのみ記録されます。管理トークンの設定を確認してください。", ko: "관리 API가 중지되었습니다. 이유는 서버 로그에만 기록되므로 관리 토큰 설정을 확인하세요." },
  "err.admin_unauthorized": { "zh-CN": "口令缺失或不正确", "zh-TW": "口令缺失或不正確", en: "Missing or invalid token", ja: "トークンがないか、正しくありません", ko: "토큰이 없거나 올바르지 않습니다" },
  "err.bad_json": { "zh-CN": "请求体不是合法的 JSON", "zh-TW": "請求體不是合法的 JSON", en: "The request body is not valid JSON", ja: "リクエストボディが正しい JSON ではありません", ko: "요청 본문이 올바른 JSON이 아닙니다" },
  "err.body_not_an_object": { "zh-CN": "请求体必须是一个 JSON 对象", "zh-TW": "請求體必須是一個 JSON 物件", en: "The request body must be a JSON object", ja: "リクエストボディは JSON オブジェクトである必要があります", ko: "요청 본문은 JSON 객체여야 합니다" },
  "err.unknown_field": { "zh-CN": "后端不认识这些字段：{fields}。多半是面板与网关的版本对不上。", "zh-TW": "後端不認識這些欄位：{fields}。多半是面板與網關的版本對不上。", en: "The backend does not recognize these fields: {fields}. The panel and the gateway are most likely on different versions.", ja: "バックエンドが認識できない項目があります: {fields}。パネルとゲートウェイのバージョンが一致していない可能性が高いです。", ko: "백엔드가 인식하지 못하는 항목이 있습니다: {fields}. 패널과 게이트웨이의 버전이 다를 가능성이 큽니다." },
  "err.key_not_found": { "zh-CN": "池子里没有这把 key，可能已经被别的副本删掉了", "zh-TW": "池子裡沒有這把 key，可能已經被別的副本刪掉了", en: "This key is not in the pool; another replica may have deleted it already", ja: "この key はプールにありません。別のレプリカが既に削除した可能性があります", ko: "이 key는 풀에 없습니다. 다른 복제본이 이미 삭제했을 수 있습니다" },
  "err.not_a_boolean": { "zh-CN": "字段 {field} 必须是开或关", "zh-TW": "欄位 {field} 必須是開或關", en: "The field {field} must be on or off", ja: "項目 {field} はオンまたはオフである必要があります", ko: "항목 {field}은(는) 켜기 또는 끄기여야 합니다" },
  "err.note_not_a_string": { "zh-CN": "备注必须是文本，或者留空表示清掉它", "zh-TW": "備註必須是文字，或者留空表示清掉它", en: "The note must be text, or empty to clear it", ja: "備考は文字列にするか、空にして削除してください", ko: "메모는 문자열이어야 하며, 비우면 삭제됩니다" },
  "err.note_too_long": { "zh-CN": "备注最长 {max} 个字符", "zh-TW": "備註最長 {max} 個字元", en: "The note may be at most {max} characters", ja: "備考は最大 {max} 文字です", ko: "메모는 최대 {max}자입니다" },
  "err.empty_patch": { "zh-CN": "这次没有要改的字段。一次什么都没做的保存不会被说成「已保存」。", "zh-TW": "這次沒有要改的欄位。一次什麼都沒做的儲存不會被說成「已儲存」。", en: "Nothing was changed this time. A save that does nothing will not be reported as saved.", ja: "今回は変更する項目がありません。何もしない保存を「保存しました」とは表示しません。", ko: "이번에는 변경할 항목이 없습니다. 아무것도 하지 않은 저장을 저장됨으로 표시하지 않습니다." },
  "err.keys_not_a_string_array": { "zh-CN": "导入的内容必须是一组文本，面板与网关的版本可能对不上", "zh-TW": "匯入的內容必須是一組文字，面板與網關的版本可能對不上", en: "The imported keys must be an array of strings; the panel and the gateway may be on different versions", ja: "取り込む key は文字列の配列である必要があります。パネルとゲートウェイのバージョンが異なる可能性があります", ko: "가져올 key는 문자열 배열이어야 합니다. 패널과 게이트웨이의 버전이 다를 수 있습니다" },
  "err.too_many_import_keys": { "zh-CN": "一次最多导入 {max} 把 key。超出的部分不会被静默截断，请分几次导入。", "zh-TW": "一次最多匯入 {max} 把 key。超出的部分不會被靜默截斷，請分幾次匯入。", en: "At most {max} keys per import. Anything beyond that is rejected rather than silently truncated, so split it into several imports.", ja: "1 回の取り込みは最大 {max} 件です。超過分は黙って切り捨てるのではなく拒否するため、数回に分けて取り込んでください。", ko: "한 번에 최대 {max}개까지 가져올 수 있습니다. 초과분은 조용히 잘라내지 않고 거부하므로 여러 번에 나눠 가져오세요." },
  "err.not_a_bulk_op": { "zh-CN": "这个批量操作后端不认识，它只接受：{ops}", "zh-TW": "這個批次操作後端不認識，它只接受：{ops}", en: "The backend does not recognize this bulk operation; it only accepts: {ops}", ja: "このバッチ操作はバックエンドが認識しません。受け付けるのは次のみです: {ops}", ko: "백엔드가 이 일괄 작업을 인식하지 못합니다. 허용되는 값은 다음뿐입니다: {ops}" },
  "err.ids_not_a_string_array": { "zh-CN": "批量操作的 id 列表必须是一组文本，面板与网关的版本可能对不上", "zh-TW": "批次操作的 id 清單必須是一組文字，面板與網關的版本可能對不上", en: "The id list for a bulk operation must be an array of strings; the panel and the gateway may be on different versions", ja: "バッチ操作の id 一覧は文字列の配列である必要があります。パネルとゲートウェイのバージョンが異なる可能性があります", ko: "일괄 작업의 id 목록은 문자열 배열이어야 합니다. 패널과 게이트웨이의 버전이 다를 수 있습니다" },
  "err.too_many_bulk_ids": { "zh-CN": "一次最多操作 {max} 把 key，请分几次来", "zh-TW": "一次最多操作 {max} 把 key，請分幾次來", en: "At most {max} keys per bulk operation; split it into several rounds", ja: "1 回のバッチ操作は最大 {max} 件です。数回に分けてください", ko: "일괄 작업은 한 번에 최대 {max}개까지입니다. 여러 번에 나눠 주세요" },

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
  // 评审 C1：整轮抛错。它不是一次铸 key 失败，是「这一轮根本没跑完」——
  // 加它是为了让崩掉的那一轮在补池历史的时间线上**占一格**，而不是与
  // 「注册机根本没跑」长得一模一样。
  "reg.fail.round_crashed": { "zh-CN": "整轮补池抛错中断", "zh-TW": "整輪補池拋錯中斷", en: "The whole tend round threw and was aborted", ja: "補充ラウンド全体が例外で中断しました", ko: "보충 라운드 전체가 예외로 중단되었습니다" },
  "reg.fail.provider_missing":   { "zh-CN": "这条通道没有配好凭据，未构造出提供方", "zh-TW": "這條通道沒有配好憑據，未建立提供方", en: "This channel has no credentials configured, so no provider was constructed", ja: "このチャネルは資格情報が未設定のため、プロバイダーが構築されませんでした", ko: "이 채널에 자격 증명이 없어 공급자가 생성되지 않았습니다" },
  // ⚠️ P3c Task 5：这一条**不是失败**——那一轮真的铸出来了（`minted` 照常 +1，
  // 上游账号与临时邮箱都真的花掉了），只是发回来的 key 材料含不可打印字符或空白。
  // 它照常存进池子（拒收 = 销毁凭据），但多半每次被选中都会让转发失败。
  // 五种语言的措辞都必须说清「已存下来 + 请去处理它」，不许写成「铸失败了」。
  "reg.fail.key_suspicious": { "zh-CN": "铸出来的 key 材料可疑（已存入池子，请手动停用或删除）", "zh-TW": "鑄出來的 key 材料可疑（已存入池子，請手動停用或刪除）", en: "The minted key material looks malformed (stored in the pool anyway — disable or delete it)", ja: "発行されたキーの内容が不正に見えます（プールには保存済み — 無効化または削除してください）", ko: "발급된 키 내용이 손상된 것으로 보입니다(풀에는 저장되었으니 비활성화하거나 삭제하세요)" },

  // ── 注册机板块（P3c Task 6）───────────────────────────────────────────────
  //
  // ⚠️⚠️ **整个 `reg.*` 命名空间受禁用词门禁管**（`scripts/check-i18n.mjs` 第 ⑥ 条 +
  // `tests/unit/i18n-dict.test.ts` 那条同名断言，两份独立实现）：
  // `推荐/推薦/建议/建議/默认/預设/預設/主流/首选/首選/优先/優先/recommended/
  // preferred/default/おすすめ/推奨/권장/기본` 一个都不许出现，**繁体变体与
  // 韩语的「기본」尤其容易误踩**（「기본 채널」= primary channel 的自然译法，
  // 这里一律改成「주 채널」）。
  //
  // ⚠️⚠️ **设计 §10.3 第 5 条给的原句「本就不存在默认地址」自己就踩了第 4 条的
  // 禁用词表**（「默认」在表里，繁体「預設」同样在表里）。两条设计规则互相打架，
  // 本任务按第 4 条执行（它是 CI 门禁，第 5 条只能靠评审），语义原样保住、
  // 换成「没有可以预填的地址」。判据与理由见
  // `admin-ui/js/pure/registrar.mjs` 的 `channelAddressFactKey()`。
  "reg.title":        { "zh-CN": "注册机", "zh-TW": "註冊機", en: "Registrar", ja: "レジストラー", ko: "등록기" },
  "reg.state":        { "zh-CN": "注册机", "zh-TW": "註冊機", en: "Registrar", ja: "レジストラー", ko: "등록기" },
  "reg.state.on":     { "zh-CN": "已启用", "zh-TW": "已啟用", en: "Enabled", ja: "有効", ko: "사용 중" },
  "reg.state.off":    { "zh-CN": "已关闭", "zh-TW": "已關閉", en: "Disabled", ja: "無効", ko: "꺼짐" },
  "reg.primary":      { "zh-CN": "主通道", "zh-TW": "主通道", en: "Primary channel", ja: "主チャネル", ko: "주 채널" },
  "reg.fallback":     { "zh-CN": "备用通道", "zh-TW": "備用通道", en: "Fallback channel", ja: "フォールバックチャネル", ko: "대체 채널" },
  "reg.none":         { "zh-CN": "未选择", "zh-TW": "未選擇", en: "Not selected", ja: "未選択", ko: "선택 안 됨" },
  // 设计 §10.3 第 8 条逐字：空状态说「两条通道平级，请选择一条作为主通道」，
  // **不是**「未选择时使用 X」。
  "reg.emptyPrimary": { "zh-CN": "两条通道平级，请选择一条作为主通道。", "zh-TW": "兩條通道平級，請選擇一條作為主通道。", en: "The two channels rank equally — pick one as the primary channel.", ja: "2 つのチャネルは対等です。どちらか一方を主チャネルとして選んでください。", ko: "두 채널은 동등합니다. 둘 중 하나를 주 채널로 선택하세요." },

  "reg.pool.target":  { "zh-CN": "目标 key 数", "zh-TW": "目標 key 數", en: "Target key count", ja: "目標 key 数", ko: "목표 key 수" },
  // ⚠️ **这一格不叫「可用」，理由在 `src/core/registrar/tender.ts` 的 `available` 字段上**：
  // 判据是 `countsTowardTarget`（`!evicted`），被停用的与正在冷却的 key **都算在里面**，
  // 而这两种恰恰都不能打上游。旁边那格 `reg.pool.fresh` 才是真正的可用数。
  "reg.pool.counted": { "zh-CN": "占名额", "zh-TW": "佔名額", en: "Counted toward target", ja: "枠を占有", ko: "정원 차지" },
  "reg.pool.countedTip": { "zh-CN": "补池算缺口用的就是这个数：判据只有「没被剔除」，所以被停用的 key 与正在冷却的 key 都算在里面——它们都占着目标名额，但都不能打上游。", "zh-TW": "補池算缺口用的就是這個數：判據只有「沒被剔除」，所以被停用的 key 與正在冷卻的 key 都算在裡面——它們都佔著目標名額，但都不能打上游。", en: "This is the number the refill loop uses to compute the gap. The test is only \"not evicted\", so disabled keys and cooling keys are both counted here — they occupy a slot yet cannot serve traffic.", ja: "補充ラウンドが不足数を計算するのに使う値です。判定は「除外されていない」だけなので、無効化済みの key もクールダウン中の key もここに含まれます——どちらも枠を占有しますが、上流には使えません。", ko: "보충 라운드가 부족분을 계산할 때 쓰는 값입니다. 판정은 「제외되지 않음」뿐이라 정지된 key와 쿨다운 중인 key가 모두 포함됩니다 — 둘 다 정원을 차지하지만 업스트림에는 쓸 수 없습니다." },
  "reg.pool.gap":     { "zh-CN": "缺口", "zh-TW": "缺口", en: "Gap", ja: "不足", ko: "부족분" },
  "reg.pool.fresh":   { "zh-CN": "可用（能打上游）", "zh-TW": "可用（能打上游）", en: "Available (can serve traffic)", ja: "利用可能（上流に使える）", ko: "사용 가능(업스트림 가능)" },

  "reg.channels.title": { "zh-CN": "邮箱通道", "zh-TW": "郵箱通道", en: "Mailbox channels", ja: "メールボックスチャネル", ko: "메일박스 채널" },
  "reg.channel.moemail": { "zh-CN": "MoeMail", "zh-TW": "MoeMail", en: "MoeMail", ja: "MoeMail", ko: "MoeMail" },
  "reg.channel.yyds":    { "zh-CN": "YYDS", "zh-TW": "YYDS", en: "YYDS", ja: "YYDS", ko: "YYDS" },
  // 设计 §10.3 第 5 条：两条通道之间**唯一**的不对称，必须写成事实而不是偏好。
  // 「YYDS 开箱即用」是偏好，不许写。
  "reg.channel.addressFact.moemail": { "zh-CN": "自建服务：每个实例的地址都不一样，本就没有可以预填的地址，必须自己填。", "zh-TW": "自建服務：每個實例的位址都不一樣，本就沒有可以預先填入的位址，必須自己填。", en: "Self-hosted service: every instance lives at a different address, so there is no address to prefill — you provide it.", ja: "セルフホストのサービスです。インスタンスごとにアドレスが異なるため、あらかじめ入れておけるアドレスは存在しません。自分で指定してください。", ko: "직접 호스팅하는 서비스입니다. 인스턴스마다 주소가 달라 미리 채워 둘 주소가 존재하지 않으므로 직접 입력해야 합니다." },
  "reg.channel.addressFact.yyds":    { "zh-CN": "地址固定的公共服务：内置了一个地址，也可以自己改。", "zh-TW": "位址固定的公共服務：內建了一個位址，也可以自己改。", en: "Public service at a fixed address: one address ships with the gateway, and you can still override it.", ja: "アドレスが固定された公開サービスです。アドレスが 1 つ同梱されており、上書きもできます。", ko: "주소가 고정된 공개 서비스입니다. 주소 하나가 내장되어 있으며 직접 바꿀 수도 있습니다." },
  "reg.channel.role":     { "zh-CN": "角色", "zh-TW": "角色", en: "Role", ja: "役割", ko: "역할" },
  "reg.role.primary":     { "zh-CN": "主通道", "zh-TW": "主通道", en: "Primary", ja: "主", ko: "주 채널" },
  "reg.role.fallback":    { "zh-CN": "备用通道", "zh-TW": "備用通道", en: "Fallback", ja: "フォールバック", ko: "대체 채널" },
  "reg.role.unused":      { "zh-CN": "本次配置没有用到它", "zh-TW": "本次設定沒有用到它", en: "Not used by the current configuration", ja: "現在の設定では使われていません", ko: "현재 설정에서는 사용되지 않습니다" },
  "reg.channel.creds":    { "zh-CN": "凭据", "zh-TW": "憑證", en: "Credentials", ja: "資格情報", ko: "자격 증명" },
  "reg.channel.credsYes": { "zh-CN": "已配好", "zh-TW": "已配好", en: "Configured", ja: "設定済み", ko: "설정됨" },
  "reg.channel.credsNo":  { "zh-CN": "未配置", "zh-TW": "未設定", en: "Not configured", ja: "未設定", ko: "설정 안 됨" },
  // 设计 §10.3 第 6 条：用数据代替推荐——两个**等权**的按钮，返回可用域名数。
  // P2 design §4.5：可用域名多寡是选主通道时唯一值得看的指标，与是哪家服务无关。
  "reg.channel.test":     { "zh-CN": "测试连接", "zh-TW": "測試連線", en: "Test connection", ja: "接続テスト", ko: "연결 테스트" },
  "reg.channel.testing":  { "zh-CN": "测试中…", "zh-TW": "測試中…", en: "Testing…", ja: "テスト中…", ko: "테스트 중…" },
  "reg.channel.testOk":     { "zh-CN": "连通：可用域名 {domains} 个 · 耗时 {latencyMs} ms", "zh-TW": "連通：可用網域 {domains} 個 · 耗時 {latencyMs} ms", en: "Reachable: {domains} usable domain(s) · {latencyMs} ms", ja: "接続できました: 利用可能なドメイン {domains} 件 · {latencyMs} ms", ko: "연결됨: 사용 가능한 도메인 {domains}개 · {latencyMs} ms" },
  "reg.channel.testFailed": { "zh-CN": "没有连上（耗时 {latencyMs} ms）。详细原因在事件板块里，事件名 registrar.channel_test_failed。", "zh-TW": "沒有連上（耗時 {latencyMs} ms）。詳細原因在事件板塊裡，事件名 registrar.channel_test_failed。", en: "Could not connect ({latencyMs} ms). The details are in the Events section under registrar.channel_test_failed.", ja: "接続できませんでした（{latencyMs} ms）。詳細はイベントセクションの registrar.channel_test_failed を参照してください。", ko: "연결하지 못했습니다({latencyMs} ms). 자세한 내용은 이벤트 섹션의 registrar.channel_test_failed에 있습니다." },
  "reg.channel.testError":  { "zh-CN": "测试请求本身失败了，没有测到这条通道", "zh-TW": "測試請求本身失敗了，沒有測到這條通道", en: "The test request itself failed, so this channel was never reached", ja: "テストのリクエスト自体が失敗したため、このチャネルには到達していません", ko: "테스트 요청 자체가 실패해 이 채널에는 도달하지 못했습니다" },
  "reg.channel.testHint":   { "zh-CN": "测试只读取这条通道的可用域名列表，不建邮箱、不注册账号，不消耗任何名额。", "zh-TW": "測試只讀取這條通道的可用網域清單，不建郵箱、不註冊帳號，不消耗任何名額。", en: "The test only reads this channel's list of usable domains: no mailbox is created, no account is registered, no quota is consumed.", ja: "テストはこのチャネルの利用可能ドメイン一覧を読むだけです。メールボックスの作成もアカウント登録も行わず、枠も消費しません。", ko: "테스트는 이 채널의 사용 가능한 도메인 목록만 읽습니다. 메일박스를 만들지도, 계정을 등록하지도, 정원을 소비하지도 않습니다." },

  "reg.tend.button":       { "zh-CN": "立即补池", "zh-TW": "立即補池", en: "Refill now", ja: "今すぐ補充", ko: "지금 보충" },
  "reg.tend.confirmTitle": { "zh-CN": "确认立即补池", "zh-TW": "確認立即補池", en: "Confirm refill", ja: "補充の確認", ko: "보충 확인" },
  // 设计 §10.2 第 3 条护栏：确认弹窗必须明示消耗。
  // ⚠️ **两个外部服务的活跃邮箱上限一律不写数字**：一个与账号档位绑定、一个是可被
  // 实例覆盖的上游默认值，把当前取值印在面板上，运维会当成自己这套部署的事实。
  // 完整理由见 `src/http/admin/handlers/registrar.ts` 的文件头。
  "reg.tend.confirmMsg":   { "zh-CN": "本次最多铸 {keys} 把 key，将消耗最多 {mailboxes} 个临时邮箱。两条通道各自的活跃邮箱上限请查各自服务商的文档。", "zh-TW": "本次最多鑄 {keys} 把 key，將消耗最多 {mailboxes} 個臨時郵箱。兩條通道各自的活躍郵箱上限請查各自服務商的文件。", en: "This run mints at most {keys} key(s) and consumes at most {mailboxes} temporary mailbox(es). For each channel's active-mailbox limit, check that provider's own documentation.", ja: "今回発行する key は最大 {keys} 件、消費する一時メールボックスは最大 {mailboxes} 件です。各チャネルのアクティブなメールボックス上限は、それぞれの提供元のドキュメントを確認してください。", ko: "이번 실행에서 최대 {keys}개의 key를 발급하고 최대 {mailboxes}개의 임시 메일박스를 사용합니다. 각 채널의 활성 메일박스 상한은 해당 제공자의 문서를 확인하세요." },
  "reg.tend.confirmUnknown": { "zh-CN": "读不到当前的缺口与单轮上限，这次会铸几把 key 说不准。请先刷新，确认状态之后再点。", "zh-TW": "讀不到目前的缺口與單輪上限，這次會鑄幾把 key 說不準。請先重新整理，確認狀態之後再點。", en: "The current gap and per-round ceiling could not be read, so how many keys this run mints is unknown. Refresh first and confirm the state before proceeding.", ja: "現在の不足数と 1 ラウンドの上限が読み取れないため、今回いくつ key を発行するかは不明です。まず更新して状態を確認してから実行してください。", ko: "현재 부족분과 라운드당 상한을 읽지 못해 이번에 key를 몇 개 발급할지 알 수 없습니다. 먼저 새로고침해 상태를 확인한 뒤 진행하세요." },
  // 通道下拉：**初始为占位符，两条通道都不预选**（设计 §10.3 第 1 条同一条纪律）。
  "reg.tend.channelLabel": { "zh-CN": "用哪条通道", "zh-TW": "用哪條通道", en: "Which channel", ja: "使用するチャネル", ko: "사용할 채널" },
  "reg.tend.channelAny":   { "zh-CN": "按当前配置的主 / 备通道", "zh-TW": "按目前設定的主 / 備通道", en: "Follow the configured primary / fallback chain", ja: "設定されている主／フォールバックの順に従う", ko: "설정된 주/대체 채널 순서를 따름" },
  "reg.tend.started":      { "zh-CN": "已开始补池。结果会出现在下面的补池历史里——这颗按钮只负责发起，不等它跑完。", "zh-TW": "已開始補池。結果會出現在下面的補池歷史裡——這顆按鈕只負責發起，不等它跑完。", en: "Refill started. The result will show up in the refill history below — this button only kicks it off and does not wait for it to finish.", ja: "補充を開始しました。結果は下の補充履歴に表示されます——このボタンは開始するだけで、完了を待ちません。", ko: "보충을 시작했습니다. 결과는 아래 보충 기록에 표시됩니다 — 이 버튼은 시작만 할 뿐 완료를 기다리지 않습니다." },
  "reg.tend.failed":       { "zh-CN": "这次补池没有发起成功", "zh-TW": "這次補池沒有發起成功", en: "This refill was not started", ja: "今回の補充は開始できませんでした", ko: "이번 보충을 시작하지 못했습니다" },
  // 「今天还剩几次」**在点之前就要显示**，不是等到点不动了才说。
  "reg.tend.quota":        { "zh-CN": "今天还可以点 {remaining} 次（每天上限 {perDay} 次）", "zh-TW": "今天還可以點 {remaining} 次（每天上限 {perDay} 次）", en: "{remaining} more click(s) available today (daily cap {perDay})", ja: "本日はあと {remaining} 回押せます（1 日の上限 {perDay} 回）", ko: "오늘 {remaining}번 더 누를 수 있습니다(하루 상한 {perDay}회)" },
  "reg.tend.quotaReset":   { "zh-CN": "，{at} 重置", "zh-TW": "，{at} 重置", en: ", resets at {at}", ja: "、{at} にリセット", ko: ", {at}에 초기화" },
  // ⚠️ **绝对时刻与相对时长成对给**：相对量做倒计时（免疫客户端时钟偏差），
  // 绝对时刻显示「几点恢复」。绝不让面板拿本地时钟去减一个服务端时刻。
  "reg.tend.cooldown":     { "zh-CN": "冷却中：{at} 之后可以再点（还有 {left}）", "zh-TW": "冷卻中：{at} 之後可以再點（還有 {left}）", en: "Cooling down: available again at {at} (in {left})", ja: "クールダウン中: {at} 以降に再度実行できます（あと {left}）", ko: "쿨다운 중: {at} 이후 다시 누를 수 있습니다(남은 시간 {left})" },
  "reg.locked":            { "zh-CN": "有一轮补池正在跑，持锁方声明最晚 {at} 结束", "zh-TW": "有一輪補池正在跑，持鎖方聲明最晚 {at} 結束", en: "A refill round is running; the lock holder declares it ends by {at} at the latest", ja: "補充ラウンドが実行中です。ロック保持側は遅くとも {at} には終わると宣言しています", ko: "보충 라운드가 실행 중입니다. 잠금 보유자는 늦어도 {at}에는 끝난다고 선언했습니다" },

  "reg.history.title":  { "zh-CN": "补池历史", "zh-TW": "補池歷史", en: "Refill history", ja: "補充履歴", ko: "보충 기록" },
  "reg.history.empty":  { "zh-CN": "还没有补池记录。", "zh-TW": "還沒有補池記錄。", en: "No refill rounds recorded yet.", ja: "補充ラウンドの記録はまだありません。", ko: "아직 보충 라운드 기록이 없습니다." },
  "reg.history.malformed": { "zh-CN": "存储里有 {count} 条读不得的补池记录被丢弃了，多半是存储被本网关之外的东西写过。", "zh-TW": "儲存裡有 {count} 條讀不得的補池記錄被丟棄了，多半是儲存被本閘道之外的東西寫過。", en: "{count} unreadable refill record(s) in storage were discarded — most likely storage was written by something other than this gateway.", ja: "ストレージ内の読み取れない補充記録 {count} 件を破棄しました。本ゲートウェイ以外から書き込まれた可能性が高いです。", ko: "저장소의 읽을 수 없는 보충 기록 {count}건을 버렸습니다. 이 게이트웨이 외부에서 기록되었을 가능성이 높습니다." },
  "reg.col.at":       { "zh-CN": "时间", "zh-TW": "時間", en: "Time", ja: "時刻", ko: "시각" },
  "reg.col.trigger":  { "zh-CN": "触发", "zh-TW": "觸發", en: "Trigger", ja: "トリガー", ko: "트리거" },
  "reg.col.channel":  { "zh-CN": "这一轮的通道", "zh-TW": "這一輪的通道", en: "Channel this round", ja: "このラウンドのチャネル", ko: "이 라운드의 채널" },
  "reg.col.result":   { "zh-CN": "结果", "zh-TW": "結果", en: "Result", ja: "結果", ko: "결과" },
  "reg.col.duration": { "zh-CN": "耗时", "zh-TW": "耗時", en: "Duration", ja: "所要時間", ko: "소요 시간" },
  "reg.col.failures": { "zh-CN": "失败归因", "zh-TW": "失敗歸因", en: "Failure reasons", ja: "失敗の内訳", ko: "실패 원인" },
  "reg.trigger.cron":   { "zh-CN": "定时", "zh-TW": "定時", en: "Scheduled", ja: "定期実行", ko: "예약 실행" },
  "reg.trigger.manual": { "zh-CN": "面板", "zh-TW": "面板", en: "Panel", ja: "パネル", ko: "패널" },
  // 四种形态的判据来自 `src/core/registrar/tender.ts` 里 `mintedByChannel` 上那张表：
  // `skipped` + `attempted` + `failures` **三个字段合读**才分得清。
  "reg.row.skipped":  { "zh-CN": "注册机当时是关闭的，这一轮什么都没做", "zh-TW": "註冊機當時是關閉的，這一輪什麼都沒做", en: "The registrar was off at the time; this round did nothing", ja: "その時点でレジストラーは無効でした。このラウンドは何もしていません", ko: "그 시점에 등록기가 꺼져 있었고 이 라운드는 아무것도 하지 않았습니다" },
  "reg.row.healthy":  { "zh-CN": "池子已经够用，这一轮不需要铸 key", "zh-TW": "池子已經夠用，這一輪不需要鑄 key", en: "The pool was already full enough; no key needed minting this round", ja: "プールは十分だったため、このラウンドでは key を発行していません", ko: "풀이 이미 충분해 이 라운드에서는 key를 발급하지 않았습니다" },
  "reg.row.noAttempt": { "zh-CN": "这一轮一次尝试都没开始（不是「跑完了没产出」）", "zh-TW": "這一輪一次嘗試都沒開始（不是「跑完了沒產出」）", en: "This round never started a single attempt (not \"ran and produced nothing\")", ja: "このラウンドは 1 回も試行を開始していません（「実行したが成果ゼロ」ではありません）", ko: "이 라운드는 시도를 한 번도 시작하지 않았습니다(「실행했지만 성과 없음」이 아닙니다)" },
  "reg.row.minted":   { "zh-CN": "铸出 {minted} / 尝试 {attempted}", "zh-TW": "鑄出 {minted} / 嘗試 {attempted}", en: "{minted} minted / {attempted} attempted", ja: "発行 {minted} / 試行 {attempted}", ko: "발급 {minted} / 시도 {attempted}" },
  "reg.row.unreadable": { "zh-CN": "这一行读不得", "zh-TW": "這一行讀不得", en: "This row is unreadable", ja: "この行は読み取れません", ko: "이 행은 읽을 수 없습니다" },
  // ⚠️ 逐通道铸出数**必须显示**：`minted` 只有总数，一轮全靠备通道铸出来时，
  // 总数记在哪条通道名下是看不出来的——没有这一格，备通道的战绩会被持续记到
  // 主通道头上，与「两条通道完全平级」正面冲突。
  "reg.row.byChannel": { "zh-CN": "逐通道：{detail}", "zh-TW": "逐通道：{detail}", en: "By channel: {detail}", ja: "チャネル別: {detail}", ko: "채널별: {detail}" },
  "reg.fail.unknownReason": { "zh-CN": "这个版本的面板不认识的失败归因：{reason}", "zh-TW": "這個版本的面板不認識的失敗歸因：{reason}", en: "A failure reason this panel build does not know: {reason}", ja: "このパネルのビルドが認識できない失敗理由: {reason}", ko: "이 패널 빌드가 알지 못하는 실패 원인: {reason}" },

  // ── 后端拒绝的八种 reason，各自一句五语言（P3c Task 6）────────────────────
  //
  // ⚠️⚠️ **状态码不是判据，`reason` 才是。** `409` 有三种、`429` 有两种，
  // 而它们的处置毫无共同之处。逐条的语义差别必须在文案里体现出来，尤其：
  // · `tend_in_flight`（**这个**副本在跑：等一会儿）与 `locked`（**另一个**副本在跑：
  //   说明你是多副本部署，不是你点错了）；
  // · `write_budget_exhausted` **不许写成「太频繁」**——它挡的是**存储写配额**、
  //   不是邮箱名额，而运维看到「太频繁」的第一反应是等一等，正确处置却是等到
  //   UTC 零点或者调 MANUAL_TENDS_PER_DAY。
  "reg.refuse.tend_in_flight": { "zh-CN": "这个副本上已经有一轮补池在跑，等它结束就能再点。", "zh-TW": "這個副本上已經有一輪補池在跑，等它結束就能再點。", en: "This replica already has a refill round in flight; you can click again once it finishes.", ja: "このレプリカでは補充ラウンドがすでに実行中です。終了すれば再度実行できます。", ko: "이 복제본에서 이미 보충 라운드가 실행 중입니다. 끝나면 다시 누를 수 있습니다." },
  "reg.refuse.locked":          { "zh-CN": "另一个副本正在补池，本次没有启动。补池是顺序执行的：并发会同时撞邮箱建号限流与上游注册风控。", "zh-TW": "另一個副本正在補池，本次沒有啟動。補池是順序執行的：並發會同時撞郵箱建號限流與上游註冊風控。", en: "Another replica is refilling, so this run did not start. Refills run one at a time: concurrent rounds hit both the mailbox creation rate limit and the upstream registration risk controls.", ja: "別のレプリカが補充中のため、今回は開始しませんでした。補充は逐次実行です: 同時に走らせるとメールボックス作成のレート制限と上流の登録リスク制御の両方に当たります。", ko: "다른 복제본이 보충 중이어서 이번에는 시작하지 않았습니다. 보충은 순차 실행입니다: 동시에 돌리면 메일박스 생성 속도 제한과 업스트림 가입 위험 관리에 모두 걸립니다." },
  "reg.refuse.registrar_disabled": { "zh-CN": "注册机没有打开，没有可补的池。请先在设置里打开它，并配好至少一条邮箱通道。", "zh-TW": "註冊機沒有打開，沒有可補的池。請先在設定裡打開它，並配好至少一條郵箱通道。", en: "The registrar is not turned on, so there is nothing to refill. Turn it on in Settings and configure at least one mailbox channel first.", ja: "レジストラーが有効になっていないため、補充する対象がありません。まず設定で有効にし、メールボックスチャネルを少なくとも 1 つ構成してください。", ko: "등록기가 켜져 있지 않아 보충할 대상이 없습니다. 먼저 설정에서 켜고 메일박스 채널을 최소 하나 구성하세요." },
  "reg.refuse.write_budget_exhausted": { "zh-CN": "今天的手动补池次数已经用完。这道闸挡的是存储写配额，不是邮箱名额——等到重置时刻会自动恢复，也可以调大 MANUAL_TENDS_PER_DAY。", "zh-TW": "今天的手動補池次數已經用完。這道閘擋的是儲存寫配額，不是郵箱名額——等到重置時刻會自動恢復，也可以調大 MANUAL_TENDS_PER_DAY。", en: "Today's manual refill allowance is used up. This gate protects the storage write quota, not the mailbox allowance — it restores itself at the reset time, or you can raise MANUAL_TENDS_PER_DAY.", ja: "本日の手動補充回数を使い切りました。このゲートが守っているのはストレージの書き込み割り当てであり、メールボックスの枠ではありません——リセット時刻に自動で回復します。MANUAL_TENDS_PER_DAY を大きくすることもできます。", ko: "오늘의 수동 보충 횟수를 모두 사용했습니다. 이 게이트가 지키는 것은 스토리지 쓰기 할당량이지 메일박스 정원이 아닙니다 — 초기화 시각에 자동으로 회복되며, MANUAL_TENDS_PER_DAY를 늘릴 수도 있습니다." },
  "reg.refuse.manual_cooldown": { "zh-CN": "两次手动补池之间要隔一段冷却时间，还没到。", "zh-TW": "兩次手動補池之間要隔一段冷卻時間，還沒到。", en: "Two manual refills must be spaced apart by a cooldown, and it has not elapsed yet.", ja: "手動補充どうしの間にはクールダウンが必要で、まだ経過していません。", ko: "수동 보충 사이에는 쿨다운이 필요하며 아직 지나지 않았습니다." },
  "reg.refuse.not_wired":      { "zh-CN": "这个部署没有接上注册机的执行体，读不到补池记录也补不了池。这是装配问题，不是运行状态——正常经容器 / Worker 入口启动的部署不会出现。", "zh-TW": "這個部署沒有接上註冊機的執行體，讀不到補池記錄也補不了池。這是裝配問題，不是執行狀態——正常經容器 / Worker 入口啟動的部署不會出現。", en: "This deployment has no registrar executor wired in, so it can neither read refill records nor refill. That is an assembly problem, not a runtime state — it cannot happen for deployments started through the container or Worker entry point.", ja: "このデプロイにはレジストラーの実行体が接続されていないため、補充記録を読むことも補充することもできません。これは組み立ての問題であり実行時の状態ではありません——コンテナや Worker のエントリーポイント経由で起動したデプロイでは発生しません。", ko: "이 배포에는 등록기 실행체가 연결되어 있지 않아 보충 기록을 읽을 수도, 보충할 수도 없습니다. 이는 조립 문제이지 실행 상태가 아닙니다 — 컨테이너나 Worker 진입점으로 기동한 배포에서는 발생하지 않습니다." },
  "reg.refuse.unknown_channel": { "zh-CN": "通道名不认识，只能是 moemail 或 yyds。", "zh-TW": "通道名不認識，只能是 moemail 或 yyds。", en: "Unknown channel name; it can only be moemail or yyds.", ja: "チャネル名が不明です。moemail か yyds のいずれかである必要があります。", ko: "알 수 없는 채널 이름입니다. moemail 또는 yyds만 가능합니다." },
  "reg.refuse.channel_not_configured": { "zh-CN": "这条通道在本次部署里没有配好凭据，用不了。请先在设置里把它配上。", "zh-TW": "這條通道在本次部署裡沒有配好憑證，用不了。請先在設定裡把它配上。", en: "This channel has no credentials configured in this deployment, so it cannot be used. Configure it in Settings first.", ja: "このチャネルはこのデプロイで資格情報が設定されていないため使用できません。まず設定で構成してください。", ko: "이 채널은 이 배포에 자격 증명이 설정되어 있지 않아 사용할 수 없습니다. 먼저 설정에서 구성하세요." },
  "reg.refuse.probe_in_flight": { "zh-CN": "上一次探测还没有返回，等它结束再试（这颗按钮每按一次都会真的向邮箱服务发一次请求）。", "zh-TW": "上一次探測還沒有回來，等它結束再試（這顆按鈕每按一次都會真的向郵箱服務發一次請求）。", en: "The previous probe has not returned yet; wait for it to finish before retrying (each click really does send a request to the mailbox service).", ja: "前回のプローブがまだ返っていません。終了してから再試行してください（このボタンは押すたびにメールサービスへ実際にリクエストを送ります）。", ko: "이전 탐지가 아직 반환되지 않았습니다. 끝난 뒤에 다시 시도하세요(이 버튼은 누를 때마다 메일 서비스로 실제 요청을 보냅니다)." },
  "reg.refuse.probe_cooldown": { "zh-CN": "两次探测之间至少要隔一小段时间，请稍后再试。这不是通道故障。", "zh-TW": "兩次探測之間至少要隔一小段時間，請稍後再試。這不是通道故障。", en: "There is a minimum interval between two probes; please retry shortly. This is not a channel failure.", ja: "プローブとプローブの間には最小間隔があります。少し待ってから再試行してください。チャネルの障害ではありません。", ko: "탐지와 탐지 사이에는 최소 간격이 있습니다. 잠시 후 다시 시도하세요. 채널 장애가 아닙니다." },

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
  //
  // ⚠️ **P3b 待办第 4 条的收尾**：`{edge}` 原来是硬编码的「约 60 秒」，现在与
  // `ov.freshness.pool` 一样由响应的 `kvEdgeCacheMs` 驱动（两个板块共用
  // `pure/overview.mjs` 的 `poolKnobs()` 取同一个数字，见该函数的说明）。
  "keys.freshness":   { "zh-CN": "别的实例判定的冷却 / 剔除，这里最多晚 {poolTtl} + {edge}（KV 边缘缓存）才看到；而且这个窗口里本实例的写会覆盖对方刚写下的调度状态。", "zh-TW": "別的實例判定的冷卻 / 剔除，這裡最多晚 {poolTtl} + {edge}（KV 邊緣快取）才看得到；而且這個視窗裡本實例的寫入會覆蓋對方剛寫下的排程狀態。", en: "Cooldowns and evictions decided by another instance take up to {poolTtl} plus {edge} (KV edge cache) to show up here. Within that window, writes from this instance also overwrite the scheduling state the other one just wrote.", ja: "他のインスタンスが判定したクールダウン／除外がここに反映されるまで、最大で {poolTtl} + {edge}（KV のエッジキャッシュ）かかります。しかもその間、このインスタンスの書き込みは相手が書いたばかりのスケジューリング状態を上書きします。", ko: "다른 인스턴스가 판정한 쿨다운/제외가 여기에 보이기까지 최대 {poolTtl} + {edge}(KV 엣지 캐시)가 걸립니다. 게다가 그 구간에서는 이 인스턴스의 쓰기가 상대가 방금 기록한 스케줄링 상태를 덮어씁니다." },
  "keys.approxTip":   { "zh-CN": "近似值：并发请求下会少计（KV 没有 CAS）；且计数最多晚一个 POOL_TOUCH_INTERVAL_MS（当前 {touch}）才落盘，isolate 在此之前被回收时这一段会丢。", "zh-TW": "近似值：並發請求下會少計（KV 沒有 CAS）；且計數最多晚一個 POOL_TOUCH_INTERVAL_MS（目前 {touch}）才寫入，isolate 在此之前被回收時這一段會遺失。", en: "Approximate: concurrent requests undercount it (KV has no CAS), and counters are persisted up to one POOL_TOUCH_INTERVAL_MS late (currently {touch}) — whatever has not been persisted is lost if the isolate is recycled first.", ja: "概算値: 同時リクエスト下では少なく数えられます（KV に CAS がないため）。またカウンターの永続化は最大で POOL_TOUCH_INTERVAL_MS ぶん（現在の値: {touch}）遅れ、その前に isolate が回収されるとその分は失われます。", ko: "근사값: 동시 요청에서는 적게 집계됩니다(KV에 CAS가 없음). 또한 카운터는 최대 POOL_TOUCH_INTERVAL_MS(현재 값 {touch})만큼 늦게 저장되며, 그 전에 isolate가 회수되면 그 구간은 사라집니다." },
  // 「最后使用」与计数是**同一份** staleness（同一次落盘一起带下去），所以它同样打 ≈。
  // 这条与 keys.approxTip 说的不是一句话：那条讲「少计 + 晚落盘」，这条讲「时刻本身粗」。
  "keys.approxLastUsedTip": { "zh-CN": "近似值：这一列的精度最粗到一个 POOL_TOUCH_INTERVAL_MS（当前 {touch}）——写消除会把「只更新了最后使用时间」的那次写整个丢掉。任何其他状态变更的落盘都会顺带把它刷新，所以真出故障时它反而是新的。", "zh-TW": "近似值：這一欄的精度最粗到一個 POOL_TOUCH_INTERVAL_MS（目前 {touch}）——寫入消除會把「只更新了最後使用時間」的那次寫入整個丟掉。任何其他狀態變更的寫入都會順帶刷新它，所以真出故障時它反而是新的。", en: "Approximate: this column is only as precise as one POOL_TOUCH_INTERVAL_MS (currently {touch}) — a write that only bumps the last-used time is dropped entirely. Any other state change persists it as a side effect, so it is actually fresh whenever something is going wrong.", ja: "概算値: この列の精度は最も粗い場合で POOL_TOUCH_INTERVAL_MS ぶん（現在の値: {touch}）です——「最終使用時刻だけが変わった」書き込みは丸ごと破棄されます。他の状態変更の永続化はこの値もついでに更新するため、障害が起きているときはむしろ新しい値になります。", ko: "근사값: 이 열의 정밀도는 최대 POOL_TOUCH_INTERVAL_MS(현재 값 {touch})까지 거칠어집니다 — 마지막 사용 시각만 바뀐 쓰기는 통째로 버려지기 때문입니다. 다른 상태 변경이 저장될 때 함께 갱신되므로, 실제로 문제가 생겼을 때는 오히려 최신입니다." },
  "keys.bucket.all":     { "zh-CN": "全部", "zh-TW": "全部", en: "All", ja: "すべて", ko: "전체" },
  "keys.bucket.fresh":   { "zh-CN": "可用", "zh-TW": "可用", en: "Available", ja: "利用可能", ko: "사용 가능" },
  "keys.bucket.cooling": { "zh-CN": "冷却中", "zh-TW": "冷卻中", en: "Cooling down", ja: "クールダウン中", ko: "쿨다운 중" },
  "keys.bucket.evicted": { "zh-CN": "已剔除", "zh-TW": "已剔除", en: "Evicted", ja: "除外済み", ko: "제외됨" },
  "keys.bucket.disabled": { "zh-CN": "已停用", "zh-TW": "已停用", en: "Disabled", ja: "無効化済み", ko: "비활성화됨" },
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

  // ── Key 池板块：写操作（P3c Task 4）─────────────────────────────────────────
  // 行内动作列。**停用/启用/清冷却/清连续失败/解除剔除/删除**，与后端
  // `PATCH /admin/api/keys/:id` 支持的五个字段逐一对应（见下面 `keys.action.clearStrikes`
  // 那条注释——它是控制端追加裁定补的，简报第一版的动作清单漏列了它）。
  "keys.action.disable":      { "zh-CN": "停用", "zh-TW": "停用", en: "Disable", ja: "無効化", ko: "정지" },
  "keys.action.enable":       { "zh-CN": "启用", "zh-TW": "啟用", en: "Enable", ja: "有効化", ko: "활성화" },
  "keys.action.clearCooldown":{ "zh-CN": "清冷却", "zh-TW": "清冷卻", en: "Clear cooldown", ja: "クールダウン解除", ko: "쿨다운 해제" },
  // ⚠️ 控制端追加裁定（评审前）：设计 §10.2 的行内动作清单本来就有「清 strikes」，
  // 后端 PATCH 的 clearStrikes 字段 Task 3 也已经实现全，是简报的动作清单第一版
  // 漏列了它——补的是遗漏，不是新范围。命名跟着 keys.col.strikes（「连续失败」）
  // 走，不叫「清 strikes」：面板上不该出现只有开发者认得的英文字段名。
  "keys.action.clearStrikes": { "zh-CN": "清连续失败", "zh-TW": "清連續失敗", en: "Clear strikes", ja: "連続失敗をクリア", ko: "연속 실패 초기화" },
  "keys.action.unevict":      { "zh-CN": "解除剔除", "zh-TW": "解除剔除", en: "Unevict", ja: "除外解除", ko: "제외 해제" },
  "keys.action.note":         { "zh-CN": "备注", "zh-TW": "備註", en: "Note", ja: "備考", ko: "비고" },
  "keys.action.delete":       { "zh-CN": "删除", "zh-TW": "刪除", en: "Delete", ja: "削除", ko: "삭제" },
  "keys.col.note":            { "zh-CN": "备注", "zh-TW": "備註", en: "Note", ja: "備考", ko: "비고" },
  "keys.col.actions":         { "zh-CN": "操作", "zh-TW": "操作", en: "Actions", ja: "操作", ko: "작업" },

  // 批量选择：**全选只选当前页**（照抄 kiro2api 的安全约束，设计 §10.2：
  // 一键选中一千个看不见的行再批量删除，后果不可挽回）。判据在
  // `js/pure/keys-write.mjs` 的 `selectAllIds()`。
  "keys.selectAll":  { "zh-CN": "全选本页", "zh-TW": "全選本頁", en: "Select all on this page", ja: "このページを全選択", ko: "이 페이지 전체 선택" },
  "keys.selectRow":  { "zh-CN": "选择这一行", "zh-TW": "選擇這一行", en: "Select this row", ja: "この行を選択", ko: "이 행 선택" },
  "keys.bulk.selectedCount": { "zh-CN": "已选中 {count} 把", "zh-TW": "已選中 {count} 把", en: "{count} selected", ja: "{count} 件選択中", ko: "{count}개 선택됨" },
  "keys.bulk.disable":        { "zh-CN": "批量停用", "zh-TW": "批量停用", en: "Bulk disable", ja: "一括無効化", ko: "일괄 정지" },
  "keys.bulk.clearCooldown":  { "zh-CN": "批量清冷却", "zh-TW": "批量清冷卻", en: "Bulk clear cooldown", ja: "一括クールダウン解除", ko: "일괄 쿨다운 해제" },
  "keys.bulk.delete":         { "zh-CN": "批量删除", "zh-TW": "批量刪除", en: "Bulk delete", ja: "一括削除", ko: "일괄 삭제" },
  "keys.bulk.confirmTitle":   { "zh-CN": "确认批量操作", "zh-TW": "確認批次操作", en: "Confirm bulk action", ja: "一括操作の確認", ko: "일괄 작업 확인" },
  "keys.bulk.confirmDelete":  { "zh-CN": "确定要删除选中的 {count} 把 key 吗？此操作不可撤销。", "zh-TW": "確定要刪除選中的 {count} 把 key 嗎？此操作不可復原。", en: "Delete the selected {count} key(s)? This cannot be undone.", ja: "選択した {count} 件の key を削除しますか？この操作は取り消せません。", ko: "선택한 key {count}개를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다." },

  // 批量结果提示。⚠️⚠️ **`keys.bulk.allOk` / `keys.bulk.partial` 刻意不带占位符**：
  // `js/pure/keys-write.mjs` 的 `bulkResultKey()` 把它们当裸字符串 `return`，
  // 若这两个 key 带 `{}` 占位符，`scripts/check-i18n.mjs` 第 ⑧ 条会在那一行报错
  // （字面量后面跟的是 `;` 不是 `,`）。实际的数字由 `keys.bulk.countsSuffix` /
  // `mustDisableFirstSuffix` / `notFoundSuffix` 三个**始终带参数调用**的 key 承载
  // ——**「批量里有 3 把被拒、前端必须显示出来」这条判据落在这三个 key 上**。
  "keys.bulk.allOk":  { "zh-CN": "批量操作已完成：全部成功。", "zh-TW": "批次操作已完成：全部成功。", en: "Bulk action completed: all succeeded.", ja: "一括操作が完了しました：すべて成功しました。", ko: "일괄 작업 완료: 모두 성공했습니다." },
  "keys.bulk.partial":{ "zh-CN": "批量操作已完成，但不是全部成功。", "zh-TW": "批次操作已完成，但不是全部成功。", en: "Bulk action completed, but not all succeeded.", ja: "一括操作は完了しましたが、すべては成功していません。", ko: "일괄 작업이 완료되었지만 전부 성공하지는 않았습니다." },
  "keys.bulk.countsSuffix":           { "zh-CN": "（{ok}/{total} 把成功）", "zh-TW": "（{ok}/{total} 把成功）", en: " ({ok}/{total} succeeded)", ja: "（{ok}/{total} 件成功）", ko: " ({ok}/{total}개 성공)" },
  "keys.bulk.mustDisableFirstSuffix": { "zh-CN": "；{mustDisableFirst} 把未停用/未剔除，需要先停用才能删除。", "zh-TW": "；{mustDisableFirst} 把未停用/未剔除，需要先停用才能刪除。", en: "; {mustDisableFirst} key(s) are neither disabled nor evicted and must be disabled before deletion.", ja: "；{mustDisableFirst} 件は無効化も除外もされていないため、削除には先に無効化が必要です。", ko: "; {mustDisableFirst}개는 정지되지도 제외되지도 않아 삭제 전에 먼저 정지해야 합니다." },
  "keys.bulk.notFoundSuffix":         { "zh-CN": "；{notFound} 把已经不存在。", "zh-TW": "；{notFound} 把已經不存在。", en: "; {notFound} key(s) no longer exist.", ja: "；{notFound} 件はすでに存在しません。", ko: "; {notFound}개는 이미 존재하지 않습니다." },

  // 「添加 Key」分组下拉（设计 §10.2，控制端裁定现在就建容器）。
  // 【自动注册】两项先占位禁用，留给 Task 6 接线到注册机端点；容器与两组
  // 平级的结构现在定死，Task 6 只需要摘掉 disabled、接上真实 onClick。
  "keys.addMenu.open":          { "zh-CN": "添加 Key", "zh-TW": "新增 Key", en: "Add key", ja: "Key を追加", ko: "Key 추가" },
  "keys.addMenu.autoGroup":     { "zh-CN": "自动注册", "zh-TW": "自動註冊", en: "Auto-register", ja: "自動登録", ko: "자동 등록" },
  "keys.addMenu.autoMoemail":   { "zh-CN": "通过 MoeMail 通道立即补池", "zh-TW": "透過 MoeMail 通道立即補池", en: "Mint via the MoeMail channel now", ja: "MoeMail チャネルで今すぐ補充", ko: "MoeMail 채널로 즉시 보충" },
  "keys.addMenu.autoYyds":      { "zh-CN": "通过 YYDS 通道立即补池", "zh-TW": "透過 YYDS 通道立即補池", en: "Mint via the YYDS channel now", ja: "YYDS チャネルで今すぐ補充", ko: "YYDS 채널로 즉시 보충" },
  // ⚠️ **`keys.addMenu.autoPlaceholder` 在 P3c Task 6 被删掉了，不是漏了。**
  // 它是 Task 4 给【自动注册】那两项占位时用的 tooltip（「这个通道还没有接入本面板」），
  // 本任务把两项真的接上了 ⇒ 那句话变成假话。**留一条零消费者的死文案比删掉它更贵**：
  // 下一个读字典的人会以为面板上还有这么一句提示。
  // ⚠️ **上一版这里写的理由是「check-i18n 只会把它报成一条警告」，那句话在 P3e Task 4
  // 之后是假的**：第 ④ 条已升成硬错 ⇒ 真留着它，`scripts/check-i18n.mjs` 这道门禁当场 exit 1。
  // 删它的理由因此不再是「门禁拦不住」，而是上面那句——**死文案本身会骗人**。
  "keys.addMenu.manualGroup":   { "zh-CN": "手动", "zh-TW": "手動", en: "Manual", ja: "手動", ko: "수동" },
  "keys.addMenu.pasteSingle":   { "zh-CN": "粘贴单个 Key", "zh-TW": "貼上單一 Key", en: "Paste a single key", ja: "単一の key を貼り付け", ko: "단일 key 붙여넣기" },
  // ⚠️ **不照抄设计原文"批量导入（多行 / JSON 数组）"**：导入框只按行拆
  // （`js/pure/keys-write.mjs` 的 `importLines()`），不解析 JSON 数组——照抄那句
  // 等于承诺一个没有实现的能力，粘一个 `["sk-a","sk-b"]` 进去只会得到"不合法
  // 的 key"，不是两把导入成功的 key。这句话如实描述现在的行为。
  "keys.addMenu.bulkImport":    { "zh-CN": "批量导入（每行一把）", "zh-TW": "批量匯入（每行一把）", en: "Bulk import (one per line)", ja: "一括インポート（1 行に 1 つ）", ko: "일괄 가져오기(한 줄에 하나)" },

  // 导入弹窗。⚠️ **导入框必须原样按行发（空行也发）**：`js/pure/keys-write.mjs`
  // 的 `importLines()` 与后端 `src/core/keypool-repo.ts` 的 `addMany()` 共用同一个
  // 口径——位置（1 基）就是行号，前端先过滤空行会让报给运维的行号错位。
  "keys.import.title":      { "zh-CN": "批量导入 Key", "zh-TW": "批量匯入 Key", en: "Import keys", ja: "Key の一括インポート", ko: "Key 일괄 가져오기" },
  "keys.import.placeholder":{ "zh-CN": "每行一把 key，支持多行粘贴", "zh-TW": "每行一把 key，支援多行貼上", en: "One key per line; multi-line paste supported", ja: "1 行につき 1 つの key。複数行の貼り付けに対応", ko: "한 줄에 하나의 key. 여러 줄 붙여넣기 지원" },
  "keys.import.resetExisting":    { "zh-CN": "对已存在的 key 也重置冷却 / strikes / 剔除状态", "zh-TW": "對已存在的 key 也重設冷卻 / strikes / 剔除狀態", en: "Also reset cooldown / strikes / eviction for keys that already exist", ja: "既存の key もクールダウン／strikes／除外状態をリセットする", ko: "이미 존재하는 key도 쿨다운/strikes/제외 상태를 재설정" },
  "keys.import.resetExistingWarn":{ "zh-CN": "这会让一把被剔除的 key 重新可用，请确认这是你想要的。", "zh-TW": "這會讓一把被剔除的 key 重新可用，請確認這是你想要的。", en: "This can bring an evicted key back into service — make sure this is what you want.", ja: "これにより除外済みの key が再び使用可能になります。意図した操作か確認してください。", ko: "이렇게 하면 제외된 key가 다시 사용 가능해집니다. 의도한 작업인지 확인하세요." },
  "keys.import.submit":     { "zh-CN": "导入", "zh-TW": "匯入", en: "Import", ja: "インポート", ko: "가져오기" },
  "keys.import.emptyErr":   { "zh-CN": "请至少输入一把 key", "zh-TW": "請至少輸入一把 key", en: "Enter at least one key", ja: "少なくとも 1 つの key を入力してください", ko: "key를 하나 이상 입력하세요" },
  // ⚠️⚠️ **`reset` 直接取响应字段，不是 `duplicated.length`**（评审 I2）——
  // 两个数字不是一回事，见 `js/pure/keys-write.mjs` 的 `importResultCounts()`。
  "keys.import.result":       { "zh-CN": "已添加 {added} 把，{duplicated} 把重复被跳过（其中 {reset} 把已重置状态），{invalid} 行不是合法的 key。", "zh-TW": "已新增 {added} 把，{duplicated} 把重複被跳過（其中 {reset} 把已重設狀態），{invalid} 行不是合法的 key。", en: "Added {added}, skipped {duplicated} duplicate(s) ({reset} of them reset), {invalid} line(s) are not valid keys.", ja: "{added} 件を追加、{duplicated} 件の重複をスキップ（うち {reset} 件をリセット）、{invalid} 行は無効な key です。", ko: "{added}개 추가, 중복 {duplicated}개 건너뜀(그중 {reset}개 재설정), {invalid}줄은 유효한 key가 아닙니다." },
  "keys.import.invalidLines": { "zh-CN": "不合法的行：{lines}", "zh-TW": "不合法的行：{lines}", en: " Invalid line(s): {lines}", ja: "無効な行：{lines}", ko: " 잘못된 줄: {lines}" },

  "keys.note.title": { "zh-CN": "编辑备注", "zh-TW": "編輯備註", en: "Edit note", ja: "備考を編集", ko: "비고 편집" },
  "keys.note.save":  { "zh-CN": "保存", "zh-TW": "儲存", en: "Save", ja: "保存", ko: "저장" },

  "keys.deleteConfirmTitle": { "zh-CN": "删除这把 key？", "zh-TW": "刪除這把 key？", en: "Delete this key?", ja: "この key を削除しますか？", ko: "이 key를 삭제하시겠습니까?" },
  "keys.deleteConfirmMsg":   { "zh-CN": "此操作不可撤销。删除前请确认这把 key 已经停用或已被剔除。", "zh-TW": "此操作不可復原。刪除前請確認這把 key 已經停用或已被剔除。", en: "This cannot be undone. Make sure this key is already disabled or evicted before deleting.", ja: "この操作は取り消せません。削除する前に、この key がすでに無効化または除外されていることを確認してください。", ko: "이 작업은 되돌릴 수 없습니다. 삭제하기 전에 이 key가 이미 정지되었거나 제외되었는지 확인하세요." },
  // 「清连续失败」的确认弹窗：**它保护的不是"能不能撤销"，是"点的时候知不知道
  // 点的是哪一个"**——清冷却只让 key 现在就能用，离下一次被剔除仍只差一次失败；
  // 清连续失败才是真的清账。两句话必须点名对方，不能只说"这是一个危险操作"。
  "keys.clearStrikesConfirmTitle": { "zh-CN": "清空连续失败计数？", "zh-TW": "清空連續失敗計數？", en: "Clear the strike count?", ja: "連続失敗回数をクリアしますか？", ko: "연속 실패 횟수를 초기화하시겠습니까?" },
  "keys.clearStrikesConfirmMsg":   { "zh-CN": "这与「清冷却」不是一回事：清冷却只是让这把 key 现在就能用，它离下一次被剔除仍然只差一次失败；清连续失败才会把失败计数真正清零，给它一次干净的机会。", "zh-TW": "這與「清冷卻」不是一回事：清冷卻只是讓這把 key 現在就能用，它離下一次被剔除仍然只差一次失敗；清連續失敗才會把失敗計數真正清零，給它一次乾淨的機會。", en: "This is not the same as clearing the cooldown: clearing the cooldown only lets this key work right now — it is still just one more failure away from eviction. Clearing strikes actually zeroes the failure count, giving it a genuinely clean slate.", ja: "「クールダウン解除」とは別物です。クールダウン解除はこの key を今すぐ使えるようにするだけで、次に 1 回失敗すれば依然として除外されます。連続失敗回数のクリアは、その回数を実際にゼロへ戻し、本当の意味でやり直させます。", ko: "「쿨다운 해제」와는 다릅니다. 쿨다운 해제는 이 key를 지금 당장 사용할 수 있게 할 뿐, 여전히 한 번만 더 실패하면 제외됩니다. 연속 실패 초기화는 실패 횟수를 실제로 0으로 되돌려 진짜 깨끗한 기회를 줍니다." },
  // 单条 DELETE 的 409 拒绝文案（HTTP 409 + 顶层 reason，与批量路径的 200 + 逐项
  // reason 是两种不同的形状，见 `src/http/admin/handlers/keys-write.ts` 的
  // `keyDeleteHandler` 文件头 ⚠️⚠️ 那一段）。
  "keys.mustDisableFirst": { "zh-CN": "请先停用这把 key 再删除（删除不可撤销，而停用随时可以撤销）", "zh-TW": "請先停用這把 key 再刪除（刪除不可復原，而停用隨時可以復原）", en: "Disable this key before deleting it (deletion is permanent; disabling can be undone anytime)", ja: "削除する前にこの key を無効化してください（削除は取り消せませんが、無効化はいつでも元に戻せます）", ko: "삭제하기 전에 이 key를 먼저 정지하세요(삭제는 되돌릴 수 없지만 정지는 언제든 되돌릴 수 있습니다)" },
  "keys.actionOk":     { "zh-CN": "操作成功", "zh-TW": "操作成功", en: "Done", ja: "操作が完了しました", ko: "작업 완료" },
  "keys.writeFailed":  { "zh-CN": "操作失败，请稍后重试", "zh-TW": "操作失敗，請稍後重試", en: "Action failed, please try again", ja: "操作に失敗しました。しばらくしてから再試行してください", ko: "작업에 실패했습니다. 잠시 후 다시 시도하세요" },

  // ── Key 池板块：单把 key 的验活（P3d Task 9）───────────────────────────────
  //
  // ⚠️⚠️ **这一整段刻意一个 `{占位符}` 都没有。** 它们全部经
  // `js/pure/keys-write.mjs` 的 `verifyResultLabelKey()` / `verifyDisabledTitleKey()`
  // 以**裸标签**的形式返回，再交给 `elI18n(tag, key)`（不带参数的 `t()`）。
  // 任何一条加上占位符，`scripts/check-i18n.mjs` 第 ⑧ 条会在那两个函数的
  // `return "…";` 那一行报错（字面量后面跟的是 `;` 不是 `,`）——与
  // `keys.bulk.allOk` / `keys.bulk.partial` 那两条是同一个约束。
  //
  // ⚠️⚠️ **`probeInFlight` 与 `probeCooldown` 是两条键，不许合成一条。**
  // 后端 `src/http/admin/probe-guard.ts` 在**同一个 429** 下产出这两种拒绝，
  // 而处置完全不同：前者等上一次回来，后者隔一小段再来，**且后者不是这把 key
  // 的故障**。合成一条就是让运维去换一把其实完好的 key。这两句与 `reg.refuse.*`
  // 那两条说的是同一件事的两个入口（通道测试 / 验活共用同一份护栏），文案因此
  // 只差「向邮箱服务发一次请求」与「向上游发一次请求」这一处。
  "keys.action.verify": { "zh-CN": "验活", "zh-TW": "驗活", en: "Verify", ja: "疎通確認", ko: "활성 확인" },
  "keys.verify.running": { "zh-CN": "正在探测…", "zh-TW": "正在探測…", en: "Probing…", ja: "確認中…", ko: "확인 중…" },
  // 只读探针那句话（订正 F8）。**它必须是可见文本，不是 tooltip**：运维会以为
  // 「验活成功」就等于把 strikes 清了，而这条端点写零个存储字段。
  "keys.verify.readOnlyNote": { "zh-CN": "这是一次人造探测，不改变这把 key 的状态：strikes、冷却、用量统计都不会动。", "zh-TW": "這是一次人造探測，不改變這把 key 的狀態：strikes、冷卻、用量統計都不會動。", en: "This is a synthetic probe. It does not change this key's state — strikes, cooldown and usage stats all stay untouched.", ja: "これは人工的なプローブです。この key の状態は変わりません（strikes・クールダウン・利用統計はいずれも動きません）。", ko: "이것은 인위적인 탐지입니다. 이 key의 상태는 바뀌지 않습니다(strikes·쿨다운·사용량 통계 모두 그대로입니다)." },
  "keys.verify.hintEnabled": { "zh-CN": "按一下会真的向上游发一次请求。", "zh-TW": "按一下會真的向上游發一次請求。", en: "Each click really does send one request upstream.", ja: "クリックするたびに上流へ実際にリクエストを 1 回送ります。", ko: "누를 때마다 업스트림으로 실제 요청을 한 번 보냅니다." },
  "keys.verify.disabledInFlight": { "zh-CN": "上一次探测还在飞，等它回来。", "zh-TW": "上一次探測還在飛，等它回來。", en: "The previous probe is still in flight; wait for it to come back.", ja: "前回のプローブがまだ実行中です。戻るまでお待ちください。", ko: "이전 탐지가 아직 진행 중입니다. 돌아올 때까지 기다리세요." },
  "keys.verify.disabledCoolingDown": { "zh-CN": "刚探过，隔一小段时间再试。", "zh-TW": "剛探過，隔一小段時間再試。", en: "Just probed; try again in a moment.", ja: "たった今確認したばかりです。少し待ってから再試行してください。", ko: "방금 탐지했습니다. 잠시 후 다시 시도하세요." },
  "keys.verify.disabledNoKey": { "zh-CN": "这一行没有可用的 key 标识，点不了。", "zh-TW": "這一行沒有可用的 key 識別碼，點不了。", en: "This row has no usable key id, so the button does nothing.", ja: "この行には利用可能な key の識別子がないため、押せません。", ko: "이 행에는 사용할 수 있는 key 식별자가 없어 누를 수 없습니다." },
  "keys.verify.ok": { "zh-CN": "验活通过：上游接受了这把 key。", "zh-TW": "驗活通過：上游接受了這把 key。", en: "Verified: upstream accepted this key.", ja: "確認できました：上流はこの key を受け付けました。", ko: "확인 완료: 업스트림이 이 key를 수락했습니다." },
  "keys.verify.unauthorized": { "zh-CN": "上游拒绝了这把 key（401/403）：它已经失效，需要换一把。", "zh-TW": "上游拒絕了這把 key（401/403）：它已經失效，需要換一把。", en: "Upstream rejected this key (401/403): it is no longer valid — replace it.", ja: "上流がこの key を拒否しました（401/403）：すでに無効です。差し替えてください。", ko: "업스트림이 이 key를 거부했습니다(401/403): 이미 무효이므로 교체해야 합니다." },
  "keys.verify.rateLimited": { "zh-CN": "上游正在限流（429）：这把 key 本身没问题，等一会儿再用。", "zh-TW": "上游正在限流（429）：這把 key 本身沒問題，等一會兒再用。", en: "Upstream is rate limiting (429): the key itself is fine — wait a while.", ja: "上流がレート制限中です（429）：key 自体に問題はありません。しばらく待ってください。", ko: "업스트림이 속도를 제한하고 있습니다(429): key 자체는 문제없으니 잠시 기다리세요." },
  "keys.verify.upstreamError": { "zh-CN": "上游回了一个未细分的错误状态码：这次探测没能确认这把 key 是好是坏。", "zh-TW": "上游回了一個未細分的錯誤狀態碼：這次探測沒能確認這把 key 是好是壞。", en: "Upstream returned an error status we do not classify further: this probe could not tell whether the key is good.", ja: "上流が細分していないエラーステータスを返しました：この key が有効かどうかは今回の確認では判断できません。", ko: "업스트림이 세분화하지 않은 오류 상태를 반환했습니다: 이번 탐지로는 이 key의 정상 여부를 알 수 없습니다." },
  "keys.verify.timeout": { "zh-CN": "探测超时：上游在超时档内没有返回响应头。", "zh-TW": "探測逾時：上游在逾時檔內沒有返回回應標頭。", en: "Probe timed out: upstream did not return response headers within the timeout budget.", ja: "プローブがタイムアウトしました：上流はタイムアウト時間内にレスポンスヘッダーを返しませんでした。", ko: "탐지 시간 초과: 업스트림이 제한 시간 안에 응답 헤더를 반환하지 않았습니다." },
  "keys.verify.networkError": { "zh-CN": "连不上上游：这次探测没有拿到任何响应。", "zh-TW": "連不上上游：這次探測沒有拿到任何回應。", en: "Cannot reach upstream: this probe got no response at all.", ja: "上流に到達できません：今回のプローブは応答をまったく受け取れませんでした。", ko: "업스트림에 연결할 수 없습니다: 이번 탐지는 어떤 응답도 받지 못했습니다." },
  // 「后端加了一种、面板还不认识」时的诚实出口。**绝不冒充任何一档已知原因**——
  // 落进「连不上上游」的话，面板会把一件它其实不懂的事说成一句确定的话。
  "keys.verify.unknownReason": { "zh-CN": "后端给出了面板还不认识的一种探测结果，请核对两边的版本。", "zh-TW": "後端給出了面板還不認識的一種探測結果，請核對兩邊的版本。", en: "The backend reported a probe outcome this panel does not recognise yet — check that both sides are on the same version.", ja: "この画面がまだ認識できない種類の結果がバックエンドから返りました。両者のバージョンを確認してください。", ko: "이 콘솔이 아직 인식하지 못하는 종류의 결과가 백엔드에서 반환되었습니다. 양쪽 버전을 확인하세요." },
  "keys.verify.probeInFlight": { "zh-CN": "上一次探测还没有返回，等它结束再试（这颗按钮每按一次都会真的向上游发一次请求）。", "zh-TW": "上一次探測還沒有回來，等它結束再試（這顆按鈕每按一次都會真的向上游發一次請求）。", en: "The previous probe has not returned yet; wait for it to finish before retrying (each click really does send a request upstream).", ja: "前回のプローブがまだ返っていません。終了してから再試行してください（このボタンは押すたびに上流へ実際にリクエストを送ります）。", ko: "이전 탐지가 아직 반환되지 않았습니다. 끝난 뒤에 다시 시도하세요(이 버튼은 누를 때마다 업스트림으로 실제 요청을 보냅니다)." },
  "keys.verify.probeCooldown": { "zh-CN": "两次探测之间至少要隔一小段时间，请稍后再试。这不是这把 key 的故障。", "zh-TW": "兩次探測之間至少要隔一小段時間，請稍後再試。這不是這把 key 的故障。", en: "There is a minimum interval between two probes; please retry shortly. This is not a fault of the key.", ja: "プローブとプローブの間には最小間隔があります。少し待ってから再試行してください。key の障害ではありません。", ko: "탐지와 탐지 사이에는 최소 간격이 있습니다. 잠시 후 다시 시도하세요. key의 장애가 아닙니다." },
  "keys.verify.keyNotFound": { "zh-CN": "这把 key 已经不在池子里了，刷新一下列表。", "zh-TW": "這把 key 已經不在池子裡了，重新整理一下列表。", en: "This key is no longer in the pool — refresh the list.", ja: "この key はすでにプールにありません。一覧を再読み込みしてください。", ko: "이 key는 더 이상 풀에 없습니다. 목록을 새로 고치세요." },
  "keys.verify.unauthorizedAdmin": { "zh-CN": "管理会话已失效，请重新输入管理口令。", "zh-TW": "管理工作階段已失效，請重新輸入管理口令。", en: "The admin session has expired; enter the admin token again.", ja: "管理セッションの有効期限が切れました。管理トークンを入力し直してください。", ko: "관리 세션이 만료되었습니다. 관리 토큰을 다시 입력하세요." },
  "keys.verify.transportError": { "zh-CN": "这次探测没有发出去：请求本身失败了，与上游状态无关。", "zh-TW": "這次探測沒有發出去：請求本身失敗了，與上游狀態無關。", en: "This probe never left the panel: the request itself failed, which says nothing about upstream.", ja: "今回のプローブは送信されていません：リクエスト自体が失敗しており、上流の状態とは無関係です。", ko: "이번 탐지는 전송되지 않았습니다: 요청 자체가 실패한 것이며 업스트림 상태와는 무관합니다." },

  // ── 概览板块（Task 5）──────────────────────────────────────────────────────
  "ov.title":            { "zh-CN": "概览", "zh-TW": "概覽", en: "Overview", ja: "概要", ko: "개요" },
  "ov.pool.total":       { "zh-CN": "总数", "zh-TW": "總數", en: "Total", ja: "総数", ko: "총계" },
  "ov.pool.fresh":       { "zh-CN": "可用", "zh-TW": "可用", en: "Available", ja: "利用可能", ko: "사용 가능" },
  "ov.pool.cooling":     { "zh-CN": "冷却中", "zh-TW": "冷卻中", en: "Cooling down", ja: "クールダウン中", ko: "쿨다운 중" },
  "ov.pool.evicted":     { "zh-CN": "已剔除", "zh-TW": "已剔除", en: "Evicted", ja: "除外済み", ko: "제외됨" },
  "ov.pool.disabled":    { "zh-CN": "已停用", "zh-TW": "已停用", en: "Disabled", ja: "無効化済み", ko: "비활성화됨" },

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
  "ov.config.primary":    { "zh-CN": "主通道", "zh-TW": "主通道", en: "Primary channel", ja: "主チャネル", ko: "주 채널" },
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
  // **评审 I2**：本期只有 config/pool 索引/管理接口/事件落库自身四类运维诊断事件
  // 会出现在本面板（见 src/core/keypool-repo.ts / config.ts / admin/auth.ts /
  // adapters/logger-store.ts 的 logger.log() 调用点）。
  // **评审 I2b（round 3）修正**：round 2 的文案曾错误地说"注册机（补池）事件还没有
  // 产出"——这不属实。`src/core/registrar/{mint,config,tender}.ts` 与
  // `adapters/mailbox-*.ts` 里有二十多处 `registrar.*` logger.log() 调用点，
  // 这些事件是真实产出的，只是走的是裸 `ConsoleLogger`（src/http/wire.ts 的
  // buildTendDeps()，Worker 的 scheduled() 与 fetch() 是两个不同的 isolate
  // 生命周期，没有请求/响应边界可挂 logFlush，接上去需要 ctx.waitUntil 一类的
  // 独立落盘机制，留给 P3c 与注册机板块一起做），从未接进 `StoreLogger`，因此
  // 从不落库、也就从不出现在本面板——"产出了但没接线"与"压根没产出"是两件不同
  // 的事，前一版文案把它们混成了一件。key 的冷却/剔除**确实**目前压根不为这两类
  // 状态变化打事件，这半句评审确认属实，未改动。
  // ⚠️ P3c Task 7 订正（§0.1 的禁令到这一步才解除，且**改之前跑过一次真机冒烟**：
  // Node 真进程 + 真存储 + 真跑一轮补池，事件板块里数出 registrar.list_domains_failed ×4 /
  // registrar.manual_tend_started ×1 / registrar.manual_tend_partial ×1 / config.updated ×1 /
  // key.added ×2，凭据明文一个字都没有）。上一版说「注册机事件还没接入本面板」——
  // **那句话从 P3c Task 1 起就不成立了**。同时补两件当时没说的事：面板自己的写操作也进这里；
  // 事件要等攒批或一个触达间隔才落盘，刚发生的那条最长晚一分钟。
  // **没变的那一半仍然如实写着**：转发路径自动打的冷却/剔除今天还是不产出事件。
  "ev.notice": {"zh-CN": "这里只有低频结构化事件：配置读取失败、池索引重建、管理接口登录失败这类运维诊断，加上注册机的补池事件与面板自己的写操作（导入 / 停用 / 删除 key、改配置）。**key 被转发路径自动打进冷却或剔除时目前仍然不产出事件**，那一段要看池子里那把 key 自己的状态。事件是攒够一批或隔满一个触达间隔才落盘的，所以刚发生的那条最长要等一分钟才出现在这里。逐请求日志请看容器 stdout / Cloudflare 控制台的 Workers Logs——Serverless 形态没有常驻进程，逐请求日志流在这里物理上不可能是完整的。", "zh-TW": "這裡只有低頻結構化事件：設定讀取失敗、池索引重建、管理接口登入失敗這類維運診斷，加上註冊機的補池事件與面板自己的寫操作（匯入 / 停用 / 刪除 key、改設定）。**key 被轉發路徑自動打進冷卻或剔除時目前仍然不產出事件**，那一段要看池子裡那把 key 自己的狀態。事件是攢夠一批或隔滿一個觸達間隔才寫入的，所以剛發生的那條最長要等一分鐘才出現在這裡。逐請求日誌請看容器 stdout / Cloudflare 主控台的 Workers Logs——Serverless 形態沒有常駐行程，逐請求日誌流在這裡物理上不可能是完整的。", en: "This board shows only low-frequency structured events: operational diagnostics such as config read failures, pool index rebuilds and failed admin logins, plus the registrar's pool-refill events and the panel's own write operations (importing / disabling / deleting keys, changing configuration). **Cooldowns and evictions applied automatically by the forwarding path still produce no events** — for those, look at the state of the key itself in the pool. Events are persisted in batches or once a flush interval has elapsed, so a just-happened event can take up to a minute to appear here. For per-request logs, check container stdout or Cloudflare's Workers Logs — the serverless shape has no long-lived process, so a complete per-request log stream is physically impossible here.", ja: "ここには低頻度の構造化イベントのみが表示されます：設定読み込み失敗、プール索引の再構築、管理者ログイン失敗などの運用診断に加え、レジストラーの補充イベントと、パネル自身の書き込み操作（キーのインポート／無効化／削除、設定変更）です。**転送経路が自動で付けたクールダウンや除外は、今のところイベントを出力しません**——その分はプール内のキー自身の状態を見てください。イベントはまとめて、またはフラッシュ間隔が経過してから保存されるため、たった今起きたものがここに現れるまで最大 1 分かかることがあります。リクエストごとのログはコンテナの stdout または Cloudflare コンソールの Workers Logs をご覧ください——サーバーレス形態には常駐プロセスがなく、ここで完全なリクエストごとのログストリームを見ることは物理的に不可能です。", ko: "여기에는 저빈도 구조화 이벤트만 표시됩니다: 설정 읽기 실패, 풀 인덱스 재구축, 관리자 로그인 실패 같은 운영 진단에 더해, 등록기의 풀 보충 이벤트와 패널 자신의 쓰기 작업(키 가져오기/정지/삭제, 설정 변경)입니다. **전달 경로가 자동으로 적용한 쿨다운·제외는 아직 이벤트를 생성하지 않습니다** — 그 부분은 풀에 있는 키 자체의 상태를 보세요. 이벤트는 일정량이 모이거나 플러시 간격이 지난 뒤에 저장되므로, 방금 발생한 이벤트가 여기에 나타나기까지 최대 1분이 걸릴 수 있습니다. 요청별 로그는 컨테이너 stdout 또는 Cloudflare 콘솔의 Workers Logs를 확인하세요 — 서버리스 형태에는 상주 프로세스가 없어 여기서 완전한 요청별 로그 스트림을 보는 것은 물리적으로 불가능합니다."},
  "ev.search": { "zh-CN": "搜索事件名 / 说明 / 字段…", "zh-TW": "搜尋事件名 / 說明 / 欄位…", en: "Search event / message / fields…", ja: "イベント名／説明／フィールドを検索…", ko: "이벤트명/설명/필드 검색…" },

  "ev.level.all":   { "zh-CN": "全部级别", "zh-TW": "全部級別", en: "All levels", ja: "すべてのレベル", ko: "모든 레벨" },
  "ev.level.debug": { "zh-CN": "调试", "zh-TW": "偵錯", en: "Debug", ja: "デバッグ", ko: "디버그" },
  "ev.level.info":  { "zh-CN": "信息", "zh-TW": "資訊", en: "Info", ja: "情報", ko: "정보" },
  "ev.level.warn":  { "zh-CN": "警告", "zh-TW": "警告", en: "Warn", ja: "警告", ko: "경고" },
  "ev.level.error": { "zh-CN": "错误", "zh-TW": "錯誤", en: "Error", ja: "エラー", ko: "오류" },
  // 评审 I4：一条事件的 level 字段缺失/畸形时，显式归到这一档，不冒充任何已知级别。
  "ev.level.unknown": { "zh-CN": "未知", "zh-TW": "未知", en: "Unknown", ja: "不明", ko: "알 수 없음" },

  "ev.pause":   { "zh-CN": "暂停", "zh-TW": "暫停", en: "Pause", ja: "一時停止", ko: "일시 정지" },
  "ev.resume":  { "zh-CN": "继续", "zh-TW": "繼續", en: "Resume", ja: "再開", ko: "재개" },
  "ev.clear":   { "zh-CN": "清空", "zh-TW": "清空", en: "Clear", ja: "クリア", ko: "지우기" },
  "ev.clearTip":{ "zh-CN": "只清前端当前显示的列表，不影响服务端已落盘的事件。被清掉的不会自动回来——要重看请点「下载」或刷新页面", "zh-TW": "只清前端目前顯示的清單，不影響服務端已寫入的事件。被清掉的不會自動回來——要重看請點「下載」或重新整理頁面", en: "Clears only the list shown here; events already persisted server-side are unaffected. Cleared entries do not come back on their own — use Download, or reload the page", ja: "ここに表示中のリストのみクリアします。サーバー側に保存済みのイベントには影響しません。クリアした分は自動では戻りません——「ダウンロード」を使うか、ページを再読み込みしてください", ko: "여기에 표시된 목록만 지웁니다. 서버에 이미 저장된 이벤트에는 영향을 주지 않습니다. 지운 항목은 저절로 돌아오지 않습니다 — 「다운로드」를 쓰거나 페이지를 새로고침하세요" },
  "ev.download":{ "zh-CN": "下载", "zh-TW": "下載", en: "Download", ja: "ダウンロード", ko: "다운로드" },
  "ev.downloadFailed": { "zh-CN": "下载失败", "zh-TW": "下載失敗", en: "Download failed", ja: "ダウンロードに失敗しました", ko: "다운로드 실패" },
  "ev.autoScroll": { "zh-CN": "自动滚动", "zh-TW": "自動捲動", en: "Auto-scroll", ja: "自動スクロール", ko: "자동 스크롤" },

  "ev.pollStatus.active": { "zh-CN": "轮询中", "zh-TW": "輪詢中", en: "Polling", ja: "ポーリング中", ko: "폴링 중" },
  "ev.pollStatus.paused": { "zh-CN": "已暂停", "zh-TW": "已暫停", en: "Paused", ja: "一時停止中", ko: "일시 정지됨" },
  "ev.pollStatus.error":  { "zh-CN": "轮询出错，稍后重试", "zh-TW": "輪詢出錯，稍後重試", en: "Polling error, will retry", ja: "ポーリングエラー、後で再試行します", ko: "폴링 오류, 나중에 재시도합니다" },
  // 评审 M2：轮询指示灯的提示语接上"本 isolate"到底是哪一个（shardId），
  // 拼在状态文案后面，不是独立一句——避免多语言各自维护一套"状态+分片"的组合句。
  "ev.pollStatus.shardSuffix": { "zh-CN": "（本 isolate：{shardId}）", "zh-TW": "（本 isolate：{shardId}）", en: " (this isolate: {shardId})", ja: "（この isolate：{shardId}）", ko: "(이 isolate: {shardId})" },
  // 评审 N1：`buffered` 单独不占用黄条（见 pure/events.mjs 的 shouldWarn 说明），
  // 但 isolate 随时可能被回收、缓冲里的事件会随之永久丢失——这里补一句 tooltip
  // 常驻提示，愿意看的人看得到，不打扰不关心的人。
  "ev.pollStatus.bufferedSuffix": { "zh-CN": "（本 isolate 还有 {count} 条事件未落盘，isolate 被回收会丢失）", "zh-TW": "（本 isolate 還有 {count} 條事件未寫入，isolate 被回收會遺失）", en: " ({count} events in this isolate not yet persisted — lost if the isolate is recycled)", ja: "（この isolate にはまだ {count} 件のイベントが未保存です。isolate が回収されると失われます）", ko: "(이 isolate에 아직 저장되지 않은 이벤트 {count}건이 있습니다. isolate가 회수되면 손실됩니다)" },
  // 评审 N1 [LOW]：`generatedAt` 是响应生成时刻，tooltip 报一句"数据截至几点"，
  // 运维不用另外去猜面板有没有卡住（同 pure/keys.mjs 用它当参照时刻的理由）。
  "ev.pollStatus.generatedAtSuffix": { "zh-CN": "（数据截至 {time}）", "zh-TW": "（資料截至 {time}）", en: " (data as of {time})", ja: "（データ基準時刻：{time}）", ko: "(데이터 기준 시각: {time})" },
  // 本任务：`malformed` 恒为 0（`src/` 里没有产出畸形条目的路径），非 0 就说明
  // 存储被外部写坏过。与 `buffered` 一样只进 tooltip、**不进黄条**——恒为假的
  // 分支挂在告警判据上没有意义（见 pure/events.mjs 的 shouldWarn 说明）。
  "ev.pollStatus.malformedSuffix": { "zh-CN": "（存储里有 {count} 条畸形事件被丢弃，多半是存储被本网关之外的东西写过）", "zh-TW": "（儲存裡有 {count} 條畸形事件被丟棄，多半是儲存被本閘道之外的東西寫過）", en: " ({count} malformed events in storage were discarded — most likely storage was written by something other than this gateway)", ja: "（ストレージ内の不正なイベント {count} 件を破棄しました。本ゲートウェイ以外から書き込まれた可能性が高いです）", ko: "(저장소의 잘못된 이벤트 {count}건을 버렸습니다. 이 게이트웨이 외부에서 기록되었을 가능성이 높습니다)" },


  // dropped/budgetExhausted/truncated/cursorAhead 四条黄条文案：**各自独立**，
  // 由响应对应字段各自驱动，不是同一句话的两种措辞（见 pure/events.mjs 的
  // shouldWarn 说明）。
  "ev.warnDropped": { "zh-CN": "本 isolate 的事件缓冲已丢弃 {count} 条最旧的事件（环形缓冲上限 100 条，落盘前被新事件顶掉）。", "zh-TW": "本 isolate 的事件緩衝已丟棄 {count} 條最舊的事件（環形緩衝上限 100 條，寫入前被新事件頂掉）。", en: "This isolate's event buffer has dropped {count} of the oldest events (ring buffer caps at 100 entries; new events pushed them out before they were persisted).", ja: "この isolate のイベントバッファは最も古い {count} 件のイベントを破棄しました（リングバッファの上限は 100 件で、書き込み前に新しいイベントに押し出されました）。", ko: "이 isolate의 이벤트 버퍼가 가장 오래된 이벤트 {count}건을 삭제했습니다(링 버퍼 상한 100건, 저장 전에 새 이벤트에 밀려남)." },
  "ev.warnBudget":  { "zh-CN": "本 isolate 今天的事件写入预算已用完，未落盘的事件仍在容器日志 / Cloudflare 控制台的 Workers Logs 里。", "zh-TW": "本 isolate 今天的事件寫入預算已用完，未寫入的事件仍在容器日誌 / Cloudflare 主控台的 Workers Logs 裡。", en: "This isolate's event-write budget for today is used up. Events that were not persisted are still available in container logs / Cloudflare's Workers Logs.", ja: "この isolate の本日のイベント書き込み予算を使い切りました。書き込まれなかったイベントはコンテナログ／Cloudflare コンソールの Workers Logs に残っています。", ko: "이 isolate의 오늘 이벤트 쓰기 예산을 모두 사용했습니다. 저장되지 않은 이벤트는 컨테이너 로그/Cloudflare 콘솔의 Workers Logs에 남아 있습니다." },
  // 评审 I3：after+limit 组合截掉了一部分本该出现的旧事件，必须如实说，不能悄悄吞掉。
  "ev.warnTruncated": { "zh-CN": "这一页没有显示全部符合条件的事件（超出了每次拉取的上限），更早的一部分被截掉了。", "zh-TW": "這一頁沒有顯示全部符合條件的事件（超出了每次拉取的上限），更早的一部分被截掉了。", en: "This page doesn't show every matching event (the per-fetch limit was exceeded); some older ones were cut off.", ja: "このページには条件に一致するすべてのイベントが表示されていません（取得件数の上限を超えました）。より古い一部が省略されています。", ko: "이 페이지에는 조건에 맞는 모든 이벤트가 표시되지 않습니다(가져오기 상한 초과). 더 오래된 일부가 잘렸습니다." },
  // 评审 C6：游标领先于本次请求的时钟（时钟回拨 / isolate 间时钟偏移），空结果
  // 不代表没有新事件。前端已经自动把冻结的游标丢掉重新冷读（见 sec-events.js 的
  // poll()），这条只是如实告诉运维"刚刚发生过一次自动恢复"，不需要手动操作。
  // 评审 I6：后端吐的 `cursor` 既不是有限数字也不是 null ⇒ **后端契约当场被破坏**。
  // **上黄条**（不是只进 tooltip）：它意味着游标推不动、面板可能永远看不到新事件，
  // 而旁边那条会自愈的 `cursorAhead` 反倒在判据里。一个悬停才看得见的提示，
  // 把「面板在撒谎」降级成了「面板在小声说」。
  "ev.warnCursorBroken": { "zh-CN": "接口返回的游标不合契约（既不是数字也不是空），面板可能一直看不到新事件。已保留上一个游标；请检查事件存储是否被本网关之外的东西写过。", "zh-TW": "介面回傳的游標不合契約（既不是數字也不是空），面板可能一直看不到新事件。已保留上一個游標；請檢查事件儲存是否被本閘道之外的東西寫過。", en: "The cursor returned by the API violates the contract (neither a number nor null); the board may never show new events. The previous cursor was kept — check whether the event storage was written by something other than this gateway.", ja: "API が返したカーソルが契約に反しています（数値でも null でもありません）。ボードに新しいイベントが今後まったく表示されない可能性があります。直前のカーソルを保持しました。イベントストレージが本ゲートウェイ以外から書き込まれていないか確認してください。", ko: "API가 반환한 커서가 계약을 위반했습니다(숫자도 null도 아님). 보드에 새 이벤트가 계속 표시되지 않을 수 있습니다. 이전 커서를 유지했으니, 이벤트 저장소가 이 게이트웨이 외부에서 기록되지 않았는지 확인하세요.", },
  "ev.warnCursorAhead": { "zh-CN": "检测到游标领先于服务端时钟（可能是时钟回拨或 isolate 间时钟偏移），已自动重新拉取最新数据。", "zh-TW": "偵測到游標領先於服務端時鐘（可能是時鐘回撥或 isolate 間時鐘偏移），已自動重新擷取最新資料。", en: "Detected a cursor ahead of the server clock (possibly a clock rollback or skew between isolates); automatically re-fetched from a fresh cursor.", ja: "カーソルがサーバー時刻より先行していることを検出しました（時刻の巻き戻し、または isolate 間の時刻ずれの可能性）。自動的に新しいカーソルから再取得しました。", ko: "커서가 서버 시계보다 앞서 있는 것을 감지했습니다(시계 롤백 또는 isolate 간 시계 편차 가능성). 새 커서로 자동으로 다시 가져왔습니다." },

  "ev.empty":   { "zh-CN": "还没有事件。", "zh-TW": "還沒有事件。", en: "No events yet.", ja: "まだイベントはありません。", ko: "아직 이벤트가 없습니다." },
  // 全分支评审 I5：点过「清空」之后**不许**再显示 ev.empty ——那是在对运维说
  // "这个部署从来没出过事"，而服务端明明有事件。这一句同时说清恢复路径。
  "ev.cleared": { "zh-CN": "已清空本页显示。服务端已落盘的事件不受影响——点「下载」可取到全部，或刷新页面重新拉取。", "zh-TW": "已清空本頁顯示。服務端已寫入的事件不受影響——點「下載」可取得全部，或重新整理頁面重新拉取。", en: "Cleared the list shown here. Events already persisted server-side are unaffected — use Download to get them all, or reload the page to fetch them again.", ja: "このページの表示をクリアしました。サーバー側に保存済みのイベントには影響しません——「ダウンロード」で全件取得できます。ページを再読み込みすれば再取得されます。", ko: "이 페이지의 표시를 지웠습니다. 서버에 이미 저장된 이벤트에는 영향이 없습니다 — 「다운로드」로 전부 받을 수 있고, 페이지를 새로고침하면 다시 불러옵니다." },
  "ev.noMatch": { "zh-CN": "没有符合筛选条件的事件。", "zh-TW": "沒有符合篩選條件的事件。", en: "No events match the current filters.", ja: "現在のフィルター条件に一致するイベントはありません。", ko: "현재 필터 조건에 맞는 이벤트가 없습니다." },

  "ev.col.time":   { "zh-CN": "时间", "zh-TW": "時間", en: "Time", ja: "時刻", ko: "시각" },
  "ev.col.level":  { "zh-CN": "级别", "zh-TW": "級別", en: "Level", ja: "レベル", ko: "레벨" },
  "ev.col.event":  { "zh-CN": "事件", "zh-TW": "事件", en: "Event", ja: "イベント", ko: "이벤트" },
  "ev.col.detail": { "zh-CN": "说明 / 字段", "zh-TW": "說明 / 欄位", en: "Message / fields", ja: "説明／フィールド", ko: "설명/필드" },

  // 分组时间线的组头文案（P-1：按 corr 相邻折叠）。
  "ev.timeline": { "zh-CN": "时间线 · {count} 条 · {corr}", "zh-TW": "時間線 · {count} 條 · {corr}", en: "Timeline · {count} events · {corr}", ja: "タイムライン · {count} 件 · {corr}", ko: "타임라인 · {count}건 · {corr}" },

  // ── 设置页（P3c Task 7，设计 §10.4 的前三张卡）────────────────────────────
  //
  // ⚠️ **命名空间刻意用 `set.*` 而不是 `reg.*`**，两条理由：
  // ① `reg.*` 是禁用词门禁（`scripts/check-i18n.mjs` 第 ⑥ 条）的作用域，而那道门禁
  //    管的是「两条邮箱通道有没有被暗示成有高下」；设置页里绝大多数文案（超时、
  //    冷却、口令）与通道毫无关系，塞进 `reg.*` 只会让那道门禁的作用域失焦。
  // ② **真正与通道有关的那几处，本任务用的是结构性做法而不是词表**：两条通道的
  //    凭据字段**共用同一对 key**（`set.field.channel.baseUrl` / `…apiKey`），
  //    通道名与地址事实那两句仍然走 `reg.channel.*`（在门禁作用域内）。
  //    共用一对 key 比词表强：想给某一条通道多写半句话，得先造出第二个 key，
  //    而那一步在评审里看得见。
  //
  // ⚠️⚠️ **`set.field.*` 这一整族的完整名字，静态判据看不出来**：`fieldLabelKey()`
  // 返回的是**模板字面量** `` `set.field.${path}` ``（`reg.fail.*` 那一族因为在 switch 里
  // 直接 return 字面量，已经踩过同一个坑，见 P3c Task 6 报告 §2.4）。
  // ⚠️ **上一版这里写的两句在 P3e Task 3 之后是假的，订正如下**：
  // ①「这一族对三道 i18n 门禁是隐身的」—— 今天 `scripts/check-i18n.mjs` 把
  //   `` `set.field.${…}` `` 收成一条**拼键前缀**（横幅第二行逐字打出来），
  //   这一族落进「拼键覆盖」桶。**代价换了个形状但没消失**：那一桶等于**永久豁免
  //   死 key 检查** —— 这一族里真有一条没人用的 key，第 ④ 条那条硬错永远看不见它。
  // ②「门禁第 ① 条不去注释，注释里写一个长得像调用点的片段会被当成真实引用」——
  //   **归到第 ① 条头上这半句今天是假的**：它现在先抠注释再广扫（实测：注释里写一个
  //   拼错的完整属性形态 ⇒ EXIT=0；同一串挪到注释之外 ⇒ EXIT=1）。
  //   ⚠️ **但「别在注释里把形态写全」这条纪律没作废，只是换了个引信**：真正不抠注释的是
  //   `tests/unit/i18n-dict.test.ts` 的「admin-ui 里引用的每个 key 都在字典里」那一格，
  //   它对整份原文跑两条窄正则 —— P3e Task 4 改注释时当场把它踩响过一次。
  //   ⚠️ **P3e Task 5 起那两条正则是引号无关的**（单双引号都认，反引号仍不认）
  //   ⇒ 这条纪律的射程**变大了**：从前写成单引号能躲过去，今天躲不掉。
  // ⇒ **补一道自己的**：`tests/ui/settings.test.ts` 的
  // 「后端 EDITABLE_FIELDS 的每条路径都有一条 set.field.* 文案」从后端那份
  // 编译期强制的清单出发反查字典，加字段不补文案当场红。
  "set.title": { "zh-CN": "设置", "zh-TW": "設定", en: "Settings", ja: "設定", ko: "설정" },
  "set.save": { "zh-CN": "保存", "zh-TW": "儲存", en: "Save", ja: "保存", ko: "저장" },
  "set.card.auth": { "zh-CN": "认证密钥", "zh-TW": "認證密鑰", en: "Credentials", ja: "認証キー", ko: "인증 키" },
  "set.card.upstream": { "zh-CN": "上游与冷却", "zh-TW": "上游與冷卻", en: "Upstream & cooldowns", ja: "上流とクールダウン", ko: "업스트림 및 쿨다운" },
  "set.card.registrar": { "zh-CN": "注册机", "zh-TW": "註冊機", en: "Registrar", ja: "レジストラー", ko: "등록기" },
  // ── 第 4 张卡：集成示例（P3d Task 7，设计 §10.4）────────────────────────────
  // ⚠️ **这几条里一个地址字面量都不许出现。** 示例里的 base URL 只能在运行期从
  // 面板自己的 origin 取（`admin-ui/js/sec-settings.js` 读一次再传给纯函数），
  // 写死任何一个都是错的；占位口令走 `{key}` 插值，取值是
  // `admin-ui/js/pure/examples.mjs` 的 `KEY_PLACEHOLDER`，字典里不再抄一份。
  "set.card.examples": { "zh-CN": "集成示例", "zh-TW": "整合範例", en: "Integration examples", ja: "統合サンプル", ko: "통합 예제" },
  "set.examples.desc": { "zh-CN": "下面的示例由本网关自己的协议目录生成，地址取自你现在访问面板用的那个域名。把 {key} 换成你的网关口令再执行——面板读不到明文口令，这里只能给占位符。", "zh-TW": "下面的範例由本網關自己的協議目錄產生，位址取自你現在存取面板用的那個網域。把 {key} 換成你的網關口令再執行——面板讀不到明文口令，這裡只能給佔位符。", en: "These snippets are generated from this gateway's own protocol catalog, and the base address is the origin you are viewing this panel on. Replace {key} with your gateway token before running them — the panel cannot read the token in clear text, so only a placeholder is shown here.", ja: "以下のサンプルはこのゲートウェイ自身のプロトコルカタログから生成され、基準アドレスは今このパネルを開いているオリジンです。実行する前に {key} をご自身のゲートウェイトークンに置き換えてください。パネルはトークンの平文を読めないため、ここではプレースホルダーのみを表示します。", ko: "아래 예제는 이 게이트웨이 자체의 프로토콜 카탈로그에서 생성되며, 기준 주소는 지금 이 패널을 열고 있는 오리진입니다. 실행하기 전에 {key}를 본인의 게이트웨이 토큰으로 바꾸세요. 패널은 토큰 평문을 읽을 수 없으므로 여기에는 자리표시자만 표시합니다." },
  "set.examples.proto": { "zh-CN": "协议", "zh-TW": "協議", en: "Protocol", ja: "プロトコル", ko: "프로토콜" },
  "set.examples.lang": { "zh-CN": "语言", "zh-TW": "語言", en: "Language", ja: "言語", ko: "언어" },
  "set.examples.noModel": { "zh-CN": "这条协议上没有可用的模型，因此没有可以照抄的示例。", "zh-TW": "這條協議上沒有可用的模型，因此沒有可以照抄的範例。", en: "No model is available on this protocol, so there is no example to copy.", ja: "このプロトコルで使えるモデルがないため、コピーできるサンプルはありません。", ko: "이 프로토콜에서 쓸 수 있는 모델이 없어 복사할 예제가 없습니다." },
  "set.examples.unavailable": { "zh-CN": "协议目录读不出来，这里不猜一段示例给你看。", "zh-TW": "協議目錄讀不出來，這裡不猜一段範例給你看。", en: "The protocol catalog could not be read, and no example is guessed here.", ja: "プロトコルカタログを取得できませんでした。ここで推測したサンプルは出しません。", ko: "프로토콜 카탈로그를 읽지 못했습니다. 여기서 추측한 예제는 보여 주지 않습니다." },
  "set.card.upstreamNote": { "zh-CN": "池快照缓存与写消除间隔是建实例时读一次的：改了要重启容器 / 等 isolate 回收才生效，不是下一个请求就变。", "zh-TW": "池快照快取與寫入消除間隔是建立實例時讀一次的：改了要重啟容器 / 等 isolate 回收才生效，不是下一個請求就變。", en: "The pool snapshot cache and the write-elision interval are read once when the instance is built: changing them takes effect after a container restart or isolate recycle, not on the next request.", ja: "プールスナップショットのキャッシュと書き込み省略の間隔は、インスタンス構築時に一度だけ読まれます。変更は次のリクエストではなく、コンテナ再起動または isolate の再生成後に反映されます。", ko: "풀 스냅숏 캐시와 쓰기 생략 간격은 인스턴스를 만들 때 한 번만 읽습니다. 변경은 다음 요청이 아니라 컨테이너 재시작 또는 isolate 회수 이후에 반영됩니다." },
  "set.adminTokenNote": { "zh-CN": "管理口令（ADMIN_TOKEN）只从环境变量读，面板改不了自己的钥匙；要轮换请改部署那一侧的环境变量并重启。", "zh-TW": "管理口令（ADMIN_TOKEN）只從環境變數讀，面板改不了自己的鑰匙；要輪換請改部署那一側的環境變數並重啟。", en: "The admin token (ADMIN_TOKEN) is read from the environment only — the panel cannot change its own key. To rotate it, change the environment variable on the deployment side and restart.", ja: "管理トークン（ADMIN_TOKEN）は環境変数からのみ読み込まれ、パネルが自分の鍵を変更することはできません。ローテーションするにはデプロイ側の環境変数を変更して再起動してください。", ko: "관리 토큰(ADMIN_TOKEN)은 환경 변수에서만 읽으며, 패널이 자신의 키를 바꿀 수는 없습니다. 교체하려면 배포 쪽 환경 변수를 바꾸고 재시작하세요." },
  "set.secretPlaceholder": { "zh-CN": "留空则不修改", "zh-TW": "留空則不修改", en: "Leave blank to keep unchanged", ja: "空欄のままにすると変更されません", ko: "비워 두면 변경되지 않습니다" },
  "set.secretSet": { "zh-CN": "已配置", "zh-TW": "已設定", en: "configured", ja: "設定済み", ko: "설정됨" },
  "set.secretUnset": { "zh-CN": "未配置", "zh-TW": "未設定", en: "not configured", ja: "未設定", ko: "설정 안 됨" },
  "set.clearSecret": { "zh-CN": "清空", "zh-TW": "清空", en: "Clear", ja: "クリア", ko: "지우기" },
  "set.meta.secret": { "zh-CN": "{state} · 末 4 位 {hint}", "zh-TW": "{state} · 末 4 位 {hint}", en: "{state} · last 4: {hint}", ja: "{state} · 末尾 4 桁 {hint}", ko: "{state} · 마지막 4자리 {hint}" },
  "set.meta.quad": { "zh-CN": "存储 {stored} · 环境变量 {env} · 生效 {effective}", "zh-TW": "儲存 {stored} · 環境變數 {env} · 生效 {effective}", en: "stored {stored} · env {env} · effective {effective}", ja: "保存値 {stored} · 環境変数 {env} · 実効値 {effective}", ko: "저장값 {stored} · 환경 변수 {env} · 실효값 {effective}" },
  "set.meta.unreadable": { "zh-CN": "这一格没读到", "zh-TW": "這一格沒讀到", en: "Could not read this field", ja: "この項目は取得できませんでした", ko: "이 항목을 읽지 못했습니다" },
  "set.lockedBy": { "zh-CN": "由环境变量 {env} 锁定，面板改了不会生效；要改请改部署那一侧的 {env} 并重启。", "zh-TW": "由環境變數 {env} 鎖定，面板改了不會生效；要改請改部署那一側的 {env} 並重啟。", en: "Locked by the environment variable {env}; editing it here has no effect. Change {env} on the deployment side and restart.", ja: "環境変数 {env} によりロックされています。ここで編集しても反映されません。デプロイ側の {env} を変更して再起動してください。", ko: "환경 변수 {env}로 잠겨 있어 여기서 수정해도 반영되지 않습니다. 배포 쪽 {env}를 바꾸고 재시작하세요." },
  "set.propagation": { "zh-CN": "本实例已经生效；别的副本 / isolate 最长 {bound} 之后才看得到这次改动。", "zh-TW": "本實例已經生效；別的副本 / isolate 最長 {bound} 之後才看得到這次改動。", en: "This instance already picked it up; other replicas/isolates may take up to {bound} to see the change.", ja: "このインスタンスには既に反映されています。他のレプリカ／isolate には最大 {bound} かかります。", ko: "이 인스턴스에는 이미 반영되었습니다. 다른 복제본/isolate는 최대 {bound} 걸릴 수 있습니다." },
  "set.propagation.buildTime": { "zh-CN": "这次改动里有建实例时读一次的字段：已经落盘，但本实例也还没生效——要重启容器 / 等 isolate 回收才看得到。", "zh-TW": "這次改動裡有建立實例時讀一次的欄位：已經落盤，但本實例也還沒生效——要重啟容器 / 等 isolate 回收才看得到。", en: "This save touched fields that are read once when the instance is built: they are persisted, but this instance has not picked them up either — restart the container or wait for the isolate to be recycled.", ja: "今回の変更には、インスタンス構築時に一度だけ読まれる項目が含まれます。保存はされましたが、このインスタンスにもまだ反映されていません。コンテナを再起動するか、isolate の再生成を待ってください。", ko: "이번 변경에는 인스턴스를 만들 때 한 번만 읽는 항목이 있습니다. 저장은 되었지만 이 인스턴스에도 아직 반영되지 않았습니다. 컨테이너를 재시작하거나 isolate가 회수되기를 기다리세요." },
  "set.readback": { "zh-CN": "已回读生效值，{count} 个字段发生了变化（已高亮）。", "zh-TW": "已回讀生效值，{count} 個欄位發生了變化（已標示）。", en: "Read back the effective values: {count} field(s) changed (highlighted).", ja: "実効値を読み戻しました。{count} 個の項目が変化しました（ハイライト済み）。", ko: "실효값을 다시 읽었습니다. {count}개 항목이 변경되었습니다(강조 표시)." },
  "set.readback.none": { "zh-CN": "已回读生效值，没有字段发生变化。", "zh-TW": "已回讀生效值，沒有欄位發生變化。", en: "Read back the effective values: nothing changed.", ja: "実効値を読み戻しました。変化した項目はありません。", ko: "실효값을 다시 읽었습니다. 변경된 항목이 없습니다." },
  "set.nothingToSave": { "zh-CN": "没有要保存的改动", "zh-TW": "沒有要儲存的改動", en: "Nothing to save", ja: "保存する変更はありません", ko: "저장할 변경 사항이 없습니다" },
  "set.saveFailed": { "zh-CN": "保存失败", "zh-TW": "儲存失敗", en: "Save failed", ja: "保存に失敗しました", ko: "저장에 실패했습니다" },
  "set.degraded": { "zh-CN": "本次装载有字段回落到了内置取值（存储里的值读不出来或不合法）。面板上「生效」那一列才是真的在用的值。", "zh-TW": "本次載入有欄位回落到了內建取值（儲存裡的值讀不出來或不合法）。面板上「生效」那一列才是真的在用的值。", en: "Some fields fell back to their built-in values on this load (the stored value was unreadable or invalid). The \\u201ceffective\\u201d column is what is actually in use.", ja: "今回の読み込みで一部の項目が組み込み値にフォールバックしました（保存値が読めないか不正）。実際に使われているのは「実効値」の列です。", ko: "이번 로드에서 일부 항목이 내장값으로 폴백했습니다(저장값을 읽을 수 없거나 올바르지 않음). 실제로 쓰이는 값은 「실효값」 열입니다." },
  "set.advanced.title": { "zh-CN": "高级（改动前请读一遍说明）", "zh-TW": "進階（改動前請讀一遍說明）", en: "Advanced (read the note first)", ja: "詳細設定（先に説明をお読みください）", ko: "고급(먼저 설명을 읽으세요)" },
  "set.advanced.warn": { "zh-CN": "这里填的地址是每一次自动注册的去向：换成别的服务器，那台服务器就能收到本网关注册时用的邮箱、密码与验证码。只有你自己搭了同样的注册后端时才改它。", "zh-TW": "這裡填的位址是每一次自動註冊的去向：換成別的伺服器，那台伺服器就能收到本網關註冊時用的信箱、密碼與驗證碼。只有你自己搭了同樣的註冊後端時才改它。", en: "This address is where every automated registration goes. Point it elsewhere and that server receives the mailbox, password and verification code used for each registration. Change it only if you run an equivalent registration backend yourself.", ja: "ここに入れるアドレスは、すべての自動登録の送信先です。別のサーバーに変えると、そのサーバーが各登録に使うメールアドレス・パスワード・認証コードを受け取ります。同等の登録バックエンドを自分で運用している場合にのみ変更してください。", ko: "여기에 넣는 주소는 모든 자동 가입의 전송 대상입니다. 다른 서버로 바꾸면 그 서버가 각 가입에 쓰이는 메일 주소·비밀번호·인증 코드를 받게 됩니다. 동일한 가입 백엔드를 직접 운영하는 경우에만 변경하세요." },
  "set.advanced.confirmTitle": { "zh-CN": "确认修改注册去向", "zh-TW": "確認修改註冊去向", en: "Confirm the registration endpoint change", ja: "登録先の変更を確認", ko: "가입 대상 변경 확인" },
  "set.advanced.save": { "zh-CN": "保存高级设置", "zh-TW": "儲存進階設定", en: "Save advanced settings", ja: "詳細設定を保存", ko: "고급 설정 저장" },
  "set.clear.title": { "zh-CN": "清空凭据", "zh-TW": "清空憑據", en: "Clear credential", ja: "資格情報をクリア", ko: "자격 증명 지우기" },
  "set.clear.warn": { "zh-CN": "要把「{field}」从存储里删掉吗？这一步不可撤销。", "zh-TW": "要把「{field}」從儲存裡刪掉嗎？這一步不可撤銷。", en: "Delete \\u201c{field}\\u201d from storage? This cannot be undone.", ja: "「{field}」をストレージから削除しますか？この操作は取り消せません。", ko: "「{field}」을(를) 저장소에서 삭제할까요? 되돌릴 수 없습니다." },
  // ⚠️⚠️ **清空凭据的那句警告按状态分岔成四条，每一条都是确定句、没有「如果」。**
  // 第一版是一句带「如果环境变量里也没有……」的条件句 —— 那等于把判断推回给读的人，
  // 而他手上恰恰没有比面板更多的信息。**同一句通用红字，在这几种状态下有的是救命、
  // 有的是吓人。** 分岔判据在 `admin-ui/js/pure/settings.mjs` 的 `clearWarning()`，
  // 那里连「红不红」也一起给（取值决策不许落在板块文件里）。
  "set.clear.effect.env": { "zh-CN": "环境变量里也提供了这一项：清空之后会回落到环境变量里的值，生效值不变。", "zh-TW": "環境變數裡也提供了這一項：清空之後會回落到環境變數裡的值，生效值不變。", en: "The environment also supplies this value: after clearing, it falls back to the environment variable and the effective value does not change.", ja: "この項目は環境変数からも与えられています。クリアすると環境変数の値にフォールバックし、実効値は変わりません。", ko: "이 항목은 환경 변수에서도 제공됩니다. 지우면 환경 변수의 값으로 폴백하며 실효값은 바뀌지 않습니다." },
  "set.clear.effect.gatewayMissing": { "zh-CN": "环境变量里没有 GATEWAY_TOKEN：清空之后当前进程靠上一份快照还能继续跑，但下一次重启 / isolate 回收会起不来。清完请立刻在这一页写一把新的网关口令。", "zh-TW": "環境變數裡沒有 GATEWAY_TOKEN：清空之後當前行程靠上一份快照還能繼續跑，但下一次重啟 / isolate 回收會起不來。清完請立刻在這一頁寫一把新的網關口令。", en: "GATEWAY_TOKEN is not in the environment: after clearing, this process keeps running on its last good snapshot, but the next restart or isolate recycle will fail to start. Set a new gateway token on this page immediately afterwards.", ja: "環境変数に GATEWAY_TOKEN がありません。クリア後、現在のプロセスは直前の有効なスナップショットで動き続けますが、次の再起動や isolate の再生成で起動できなくなります。クリア後はすぐにこのページで新しいゲートウェイトークンを設定してください。", ko: "환경 변수에 GATEWAY_TOKEN이 없습니다. 지운 뒤 현재 프로세스는 마지막 정상 스냅숏으로 계속 동작하지만, 다음 재시작이나 isolate 회수 시 기동에 실패합니다. 지운 직후 이 페이지에서 새 게이트웨이 토큰을 설정하세요." },
  "set.clear.effect.channelBreaks": { "zh-CN": "环境变量里没有这一项，而注册机开着、这条通道就在主/备链上：清空之后当前进程还能跑，但下一次重启 / isolate 回收会起不来。清完请立刻重新填上，或者先把这条通道从主/备里去掉。", "zh-TW": "環境變數裡沒有這一項，而註冊機開著、這條通道就在主/備鏈上：清空之後當前行程還能跑，但下一次重啟 / isolate 回收會起不來。清完請立刻重新填上，或者先把這條通道從主/備裡去掉。", en: "The environment does not supply this value, the registrar is on, and this channel is on the primary/fallback chain: after clearing, this process keeps running, but the next restart or isolate recycle will fail to start. Re-enter it immediately, or first remove this channel from the primary/fallback selection.", ja: "この項目は環境変数になく、レジストラーは有効で、このチャネルは主／フォールバックの連鎖に入っています。クリア後も現在のプロセスは動き続けますが、次の再起動や isolate の再生成で起動できなくなります。すぐに入れ直すか、先にこのチャネルを主／フォールバックから外してください。", ko: "이 항목은 환경 변수에 없고, 등록기가 켜져 있으며, 이 채널이 주/대체 체인에 들어 있습니다. 지운 뒤에도 현재 프로세스는 계속 동작하지만 다음 재시작이나 isolate 회수 시 기동에 실패합니다. 즉시 다시 입력하거나, 먼저 이 채널을 주/대체에서 빼세요." },
  "set.clear.effect.channelIdle": { "zh-CN": "这条通道现在不在主/备链上（或注册机是关着的），清空它现在不影响任何东西；但把它接上链之前必须重新填。", "zh-TW": "這條通道現在不在主/備鏈上（或註冊機是關著的），清空它現在不影響任何東西；但把它接上鏈之前必須重新填。", en: "This channel is not on the primary/fallback chain right now (or the registrar is off), so clearing it changes nothing today — but you must fill it in again before putting the channel back on the chain.", ja: "このチャネルは現在、主／フォールバックの連鎖に入っていません（またはレジストラーが無効です）。今クリアしても何にも影響しませんが、このチャネルを連鎖に戻す前には入れ直す必要があります。", ko: "이 채널은 지금 주/대체 체인에 들어 있지 않습니다(또는 등록기가 꺼져 있습니다). 지금 지워도 아무 영향이 없지만, 이 채널을 다시 체인에 넣기 전에는 반드시 다시 입력해야 합니다." },
  "set.clear.gatewayMissing": { "zh-CN": "网关口令已经被清空，而环境变量里也没有：请立刻在这一页写一把新的，否则下一次重启会起不来。", "zh-TW": "網關口令已經被清空，而環境變數裡也沒有：請立刻在這一頁寫一把新的，否則下一次重啟會起不來。", en: "The gateway token has been cleared and there is none in the environment either. Set a new one on this page now, or the next restart will fail.", ja: "ゲートウェイトークンがクリアされ、環境変数にもありません。今すぐこのページで新しいものを設定してください。さもないと次回の起動に失敗します。", ko: "게이트웨이 토큰이 지워졌고 환경 변수에도 없습니다. 지금 이 페이지에서 새로 설정하지 않으면 다음 재시작에 실패합니다." },
  "set.clear.done": { "zh-CN": "「{field}」已从存储里清空", "zh-TW": "「{field}」已從儲存裡清空", en: "\\u201c{field}\\u201d cleared from storage", ja: "「{field}」をストレージからクリアしました", ko: "「{field}」을(를) 저장소에서 지웠습니다" },

  // ── 第 5 张卡：危险区（P3e Task 31，设计里不带编号的那一节「重置到底重置了什么」）──
  //
  // ⚠️⚠️ **这一族文案里一个「立即生效」都不许有**（设计 §5.3 那句同源）：两颗按钮的
  // 后果都要等传播窗口才在别的副本上成立，说成「立即生效」就是当面说反话。
  // **今天守它的不是 `scripts/check-i18n.mjs` 的禁词表**——那张表是「偏好词」表
  //（推荐/默认/おすすめ/권장……）、作用域被 `BANNED_PREFIXES` 钉在 `reg.` 与几条
  // `set.field.*` 上，两张表里都没有「立即」这一族词，而且**今天也加不进去**：
  // 字典里含「立即」的 key 全是正当使用（「立即补池」那一族，外加 `ov.freshness.config`
  // 那句正文本身就写着「不是「立即生效」」），按词扫会先打中做对了的那几条。
  // ⇒ 守它的是 `tests/unit/i18n-dict.test.ts` 的
  // 「危险区那一族文案里一句「立即生效」都没有 —— 词表是「概念 × 语言」的矩阵」那一格。
  "set.card.danger": { "zh-CN": "危险区", "zh-TW": "危險區", en: "Danger zone", ja: "危険ゾーン", ko: "위험 구역" },
  "set.danger.intro": { "zh-CN": "这一区里的两个操作都不可撤销，而且没有任何撤销路径。点之前请把每一句话读完。", "zh-TW": "這一區裡的兩個操作都不可撤銷，而且沒有任何撤銷路徑。點之前請把每一句話讀完。", en: "Both actions in this zone are irreversible and there is no undo path. Read every line before you click.", ja: "このゾーンの 2 つの操作はいずれも取り消せず、元に戻す手段もありません。押す前にすべて読んでください。", ko: "이 구역의 두 작업은 모두 되돌릴 수 없으며 취소 경로도 없습니다. 누르기 전에 모두 읽어 주세요." },

  "set.danger.reset.title": { "zh-CN": "重置配置", "zh-TW": "重置設定", en: "Reset configuration", ja: "設定をリセット", ko: "설정 초기화" },
  "set.danger.reset.desc": { "zh-CN": "把存储里那份配置整把写回空，含网关口令与两条邮箱通道的凭据。生效值随后回落到环境变量与内置取值——被环境变量锁住的字段一个比特都不会动，所以这一步不等于恢复出厂。key 池、用量、事件与补池历史都不碰。", "zh-TW": "把儲存裡那份設定整把寫回空，含網關口令與兩條郵箱通道的憑據。生效值隨後回落到環境變數與內建取值——被環境變數鎖住的欄位一個位元都不會動，所以這一步不等於恢復原廠。key 池、用量、事件與補池歷史都不碰。", en: "Writes the stored configuration back to empty in one go, including the gateway token and both mailbox channel credentials. Effective values then fall back to environment variables and built-in values \u2014 fields locked by the environment do not move by a single bit, so this is not a factory reset. The key pool, usage, events and refill history are left alone.", ja: "ストレージ上の設定をまるごと空に書き戻します（ゲートウェイトークンと 2 つのメールチャネルの資格情報を含む）。実効値はその後、環境変数と組み込みの値にフォールバックします。環境変数でロックされた項目は 1 ビットも動かないため、これは工場出荷状態への復元ではありません。キープール・使用量・イベント・補充履歴には触れません。", ko: "저장소에 있는 설정을 통째로 비웁니다(게이트웨이 토큰과 두 메일 채널의 자격 증명 포함). 이후 실효값은 환경 변수와 내장 값으로 폴백합니다. 환경 변수로 잠긴 항목은 1비트도 움직이지 않으므로 이것은 공장 초기화가 아닙니다. 키 풀·사용량·이벤트·보충 이력은 건드리지 않습니다." },
  "set.danger.reset.button": { "zh-CN": "重置配置", "zh-TW": "重置設定", en: "Reset configuration", ja: "設定をリセット", ko: "설정 초기화" },
  "set.danger.reset.confirmTitle": { "zh-CN": "确认重置配置", "zh-TW": "確認重置設定", en: "Confirm resetting the configuration", ja: "設定のリセットを確認", ko: "설정 초기화 확인" },
  "set.danger.reset.warn": { "zh-CN": "这一步不可撤销：存储里那份配置会被整把抹掉，其中包括网关口令与两条邮箱通道的凭据。", "zh-TW": "這一步不可撤銷：儲存裡那份設定會被整把抹掉，其中包括網關口令與兩條郵箱通道的憑據。", en: "This cannot be undone: the stored configuration is wiped in one go, including the gateway token and both mailbox channel credentials.", ja: "この操作は取り消せません。ストレージ上の設定はまるごと消去され、ゲートウェイトークンと 2 つのメールチャネルの資格情報も含まれます。", ko: "이 작업은 되돌릴 수 없습니다. 저장소의 설정이 통째로 지워지며 게이트웨이 토큰과 두 메일 채널의 자격 증명도 함께 사라집니다." },
  "set.danger.reset.scope": { "zh-CN": "只动存储里那一把配置：key 池、每把 key 的用量、事件记录与补池历史都不会被碰。", "zh-TW": "只動儲存裡那一把設定：key 池、每把 key 的用量、事件記錄與補池歷史都不會被碰。", en: "Only that one stored configuration entry is touched: the key pool, per-key usage, event records and refill history are all left alone.", ja: "触れるのはストレージ上のその設定 1 件だけです。キープール、キーごとの使用量、イベント記録、補充履歴には一切触れません。", ko: "저장소의 그 설정 항목 하나만 바뀝니다. 키 풀, 키별 사용량, 이벤트 기록, 보충 이력은 전혀 건드리지 않습니다." },
  "set.danger.reset.propagation": { "zh-CN": "本实例下一个请求就按新值跑；别的副本 / isolate 最长 {bound} 之后才看得到这次重置。", "zh-TW": "本執行個體下一個請求就按新值跑；別的副本 / isolate 最長 {bound} 之後才看得到這次重置。", en: "The next request on this instance already uses the new values; other replicas or isolates can take up to {bound} to see this reset.", ja: "このインスタンスは次のリクエストから新しい値で動きます。他のレプリカや isolate がこのリセットを見るまで最大 {bound} かかります。", ko: "이 인스턴스는 다음 요청부터 새 값으로 동작합니다. 다른 복제본이나 isolate가 이 초기화를 보기까지 최대 {bound}가 걸립니다." },
  "set.danger.reset.effect.ok": { "zh-CN": "按逐字段判据看，重置之后这份配置仍然装载得起来（缺的那几格环境变量兜住了）。这条判据本身并不完备，它说不出「一定没事」。", "zh-TW": "按逐欄位判據看，重置之後這份設定仍然裝載得起來（缺的那幾格環境變數兜住了）。這條判據本身並不完備，它說不出「一定沒事」。", en: "By the field-by-field check, the configuration still loads after the reset (the environment covers what is removed). That check is not complete, so it cannot promise that nothing will break.", ja: "項目ごとの判定では、リセット後もこの設定は読み込めます（欠ける項目は環境変数が補います）。この判定自体は網羅的ではないため、「絶対に問題ない」とは言えません。", ko: "항목별 판정 기준으로는 초기화 후에도 이 설정을 불러올 수 있습니다(빠지는 항목은 환경 변수가 채웁니다). 이 판정 자체가 완전하지는 않으므로 문제가 없다고 단정할 수는 없습니다." },
  "set.danger.reset.done": { "zh-CN": "已重置，并已回读生效值；真的变了的那几格已经高亮出来。", "zh-TW": "已重置，並已回讀生效值；真的變了的那幾格已經高亮出來。", en: "Reset done, and the effective values were read back; the fields that actually changed are highlighted.", ja: "リセットが完了し、実効値を読み戻しました。実際に変わった項目はハイライトしています。", ko: "초기화를 마치고 실효값을 다시 읽어 왔습니다. 실제로 바뀐 항목은 강조 표시했습니다." },

  "set.danger.purge.title": { "zh-CN": "清空 Key 池", "zh-TW": "清空 Key 池", en: "Purge the key pool", ja: "Key プールを空にする", ko: "Key 풀 비우기" },
  "set.danger.purge.desc": { "zh-CN": "删掉池子里每一把 key 的记录。key 明文只在存储里有这一份，删了没有第二处可以找回来；每把 key 的用量历史住在记录里面，跟着一起没。配置、事件与补池历史都不碰。", "zh-TW": "刪掉池子裡每一把 key 的記錄。key 明文只在儲存裡有這一份，刪了沒有第二處可以找回來；每把 key 的用量歷史住在記錄裡面，跟著一起沒。設定、事件與補池歷史都不碰。", en: "Deletes the record of every key in the pool. The key material exists only in storage, so once deleted there is no second copy to recover from; each key\u2019s usage history lives inside its record and goes with it. Configuration, events and refill history are left alone.", ja: "プール内のすべての key のレコードを削除します。key の平文はストレージにしか存在せず、削除すると取り戻せる場所は他にありません。キーごとの使用量履歴はレコードの中にあるため一緒に消えます。設定・イベント・補充履歴には触れません。", ko: "풀에 있는 모든 key의 레코드를 삭제합니다. key 원문은 저장소에만 있으므로 지우면 되찾을 곳이 없습니다. 키별 사용량 이력은 레코드 안에 있어 함께 사라집니다. 설정·이벤트·보충 이력은 건드리지 않습니다." },
  "set.danger.purge.button": { "zh-CN": "清空 Key 池", "zh-TW": "清空 Key 池", en: "Purge the key pool", ja: "Key プールを空にする", ko: "Key 풀 비우기" },
  "set.danger.purge.confirmTitle": { "zh-CN": "确认清空 Key 池", "zh-TW": "確認清空 Key 池", en: "Confirm purging the key pool", ja: "Key プールを空にする確認", ko: "Key 풀 비우기 확인" },
  "set.danger.purge.warn": { "zh-CN": "池子里现在有 {count} 把 key，这一步会把它们全部永久删掉。", "zh-TW": "池子裡現在有 {count} 把 key，這一步會把它們全部永久刪掉。", en: "The pool currently holds {count} keys; this will permanently delete all of them.", ja: "プールには現在 {count} 件の key があります。この操作でそのすべてを完全に削除します。", ko: "풀에는 현재 {count}개의 key가 있으며, 이 작업으로 모두 영구 삭제됩니다." },
  "set.danger.purge.stats": { "zh-CN": "每把 key 的用量历史（请求数 / 成功数 / 最近一次错误）住在这条记录的值里面：删记录就是删历史，没有第二份。", "zh-TW": "每把 key 的用量歷史（請求數 / 成功數 / 最近一次錯誤）住在這條記錄的值裡面：刪記錄就是刪歷史，沒有第二份。", en: "Each key\u2019s usage history (requests, successes, last error) lives inside the value of that record: deleting the record deletes the history, and there is no second copy.", ja: "キーごとの使用量履歴（リクエスト数・成功数・直近のエラー）はそのレコードの値の中にあります。レコードを削除することは履歴を削除することであり、控えはありません。", ko: "키별 사용량 이력(요청 수, 성공 수, 마지막 오류)은 그 레코드의 값 안에 있습니다. 레코드를 지우는 것은 이력을 지우는 것이며 사본은 없습니다." },
  "set.danger.purge.propagation": { "zh-CN": "转发路径最长要等一个池快照 TTL 加上边缘缓存才不再选中这些 key；屏幕上清空了不等于那一刻它们就退出服役。", "zh-TW": "轉發路徑最長要等一個池快照 TTL 加上邊緣快取才不再選中這些 key；螢幕上清空了不等於那一刻它們就退出服役。", en: "The forwarding path can keep selecting these keys for up to one pool-snapshot TTL plus the edge cache; a cleared screen does not mean they leave service at that moment.", ja: "転送経路はプールスナップショットの TTL とエッジキャッシュの合計だけ、これらの key を選び続けることがあります。画面上で空になっても、その時点で稼働から外れたわけではありません。", ko: "전달 경로는 풀 스냅숏 TTL과 엣지 캐시를 합한 시간만큼 이 key들을 계속 고를 수 있습니다. 화면이 비었다고 그 시점에 서비스에서 빠진 것은 아닙니다." },
  "set.danger.purge.typeTo": { "zh-CN": "请把当前池大小 {count} 手打一遍以确认：", "zh-TW": "請把目前池大小 {count} 手打一遍以確認：", en: "Type the current pool size {count} to confirm:", ja: "確認のため、現在のプールサイズ {count} を入力してください:", ko: "확인을 위해 현재 풀 크기 {count}을(를) 입력하세요:" },
  "set.danger.purge.mismatch": { "zh-CN": "输入的数字与当前池大小对不上，这一步没有执行。", "zh-TW": "輸入的數字與目前池大小對不上，這一步沒有執行。", en: "The number you typed does not match the current pool size; nothing was done.", ja: "入力された数値が現在のプールサイズと一致しません。何も実行していません。", ko: "입력한 숫자가 현재 풀 크기와 다릅니다. 아무것도 실행하지 않았습니다." },
  "set.danger.purge.done": { "zh-CN": "已删掉 {deleted} 把 key；回读之后池子是空的。", "zh-TW": "已刪掉 {deleted} 把 key；回讀之後池子是空的。", en: "Deleted {deleted} keys; the read-back shows the pool is empty.", ja: "{deleted} 件の key を削除しました。読み戻した結果、プールは空です。", ko: "{deleted}개의 key를 삭제했습니다. 다시 읽어 본 결과 풀은 비어 있습니다." },
  "set.danger.purge.leftover": { "zh-CN": "已删掉 {deleted} 把 key，但回读之后存储里还有 {remaining} 把——多半是别的副本在这中间又写进来了。请刷新之后再看一眼。", "zh-TW": "已刪掉 {deleted} 把 key，但回讀之後儲存裡還有 {remaining} 把——多半是別的副本在這中間又寫進來了。請重新整理之後再看一眼。", en: "Deleted {deleted} keys, but the read-back still finds {remaining} in storage \u2014 most likely another replica wrote some in the meantime. Refresh and take another look.", ja: "{deleted} 件の key を削除しましたが、読み戻すとストレージにまだ {remaining} 件あります。おそらくその間に別のレプリカが書き込んでいます。再読み込みしてもう一度確認してください。", ko: "{deleted}개의 key를 삭제했지만 다시 읽어 보니 저장소에 {remaining}개가 남아 있습니다. 그 사이 다른 복제본이 기록했을 가능성이 큽니다. 새로 고친 뒤 다시 확인하세요." },
  "set.danger.purge.sizeUnknown": { "zh-CN": "读不到当前池大小，因此不打开确认框：没有那个数就无法确认你要删的到底是哪一池。", "zh-TW": "讀不到目前池大小，因此不打開確認框：沒有那個數就無法確認你要刪的到底是哪一池。", en: "The current pool size could not be read, so no confirmation dialog is opened: without that number there is no way to confirm which pool you are about to delete.", ja: "現在のプールサイズを取得できないため、確認ダイアログは開きません。その数値がなければ、どのプールを削除しようとしているのか確認できません。", ko: "현재 풀 크기를 읽지 못해 확인 창을 열지 않습니다. 그 숫자가 없으면 어떤 풀을 지우려는지 확인할 수 없습니다." },
  "set.danger.purge.changed": { "zh-CN": "池子在你确认之前变了，一把都没有删。请刷新之后重来。", "zh-TW": "池子在你確認之前變了，一把都沒有刪。請重新整理之後重來。", en: "The pool changed before you confirmed, so nothing was deleted. Refresh and try again.", ja: "確認する前にプールが変化したため、1 件も削除していません。再読み込みしてやり直してください。", ko: "확인하기 전에 풀이 바뀌어 하나도 삭제하지 않았습니다. 새로 고친 뒤 다시 시도하세요." },
  "set.danger.failed": { "zh-CN": "这一步没有成功。存储可能一个字节都没动，也可能只做了一半。请刷新之后核对当前状态，再决定要不要重来。", "zh-TW": "這一步沒有成功。儲存可能一個位元組都沒動，也可能只做了一半。請重新整理之後核對目前狀態，再決定要不要重來。", en: "This step did not succeed. Storage may be untouched, or the work may be half done. Refresh, check the current state, and then decide whether to retry.", ja: "この操作は成功しませんでした。ストレージは 1 バイトも変わっていないかもしれませんし、途中まで進んでいるかもしれません。再読み込みして現在の状態を確認してから、やり直すかどうかを決めてください。", ko: "이 작업은 성공하지 못했습니다. 저장소가 전혀 바뀌지 않았을 수도 있고, 절반만 진행되었을 수도 있습니다. 새로 고쳐 현재 상태를 확인한 뒤 다시 시도할지 결정하세요." },
  "set.loadBlocked": { "zh-CN": "存储里这份配置现在装载不起来：当前进程靠上一份合法快照还在跑，但下一次重启 / isolate 回收会失败。下面逐条列出缺什么，改完保存即可恢复——这一页仍然可以编辑。", "zh-TW": "儲存裡這份設定現在載入不起來：當前行程靠上一份合法快照還在跑，但下一次重啟 / isolate 回收會失敗。下面逐條列出缺什麼，改完儲存即可恢復——這一頁仍然可以編輯。", en: "The stored configuration currently cannot be loaded: this process is still running on its last good snapshot, but the next restart or isolate recycle will fail. What is missing is listed below — fix and save to recover; this page is still editable.", ja: "保存されている設定は現在読み込めません。このプロセスは直前の有効なスナップショットで動作を続けていますが、次の再起動や isolate の再生成で失敗します。不足している項目を以下に列挙します。修正して保存すれば復旧できます——このページは引き続き編集できます。", ko: "저장된 설정을 현재 불러올 수 없습니다. 이 프로세스는 마지막 정상 스냅숏으로 계속 동작 중이지만 다음 재시작이나 isolate 회수 시 실패합니다. 무엇이 빠졌는지 아래에 나열합니다. 고쳐서 저장하면 복구됩니다 — 이 페이지는 계속 편집할 수 있습니다." },
  "set.err.unknown_field": { "zh-CN": "这个字段后端不认识", "zh-TW": "這個欄位後端不認識", en: "The backend does not recognize this field", ja: "このフィールドはバックエンドが認識しません", ko: "백엔드가 인식하지 못하는 항목입니다" },
  "set.err.locked_by_env": { "zh-CN": "被环境变量 {env} 锁定，改不了", "zh-TW": "被環境變數 {env} 鎖定，改不了", en: "Locked by the environment variable {env}", ja: "環境変数 {env} によりロックされています", ko: "환경 변수 {env}로 잠겨 있습니다" },
  "set.err.not_an_integer": { "zh-CN": "必须是整数", "zh-TW": "必須是整數", en: "Must be an integer", ja: "整数である必要があります", ko: "정수여야 합니다" },
  "set.err.below_min": { "zh-CN": "不能小于 {min}", "zh-TW": "不能小於 {min}", en: "Must be at least {min}", ja: "{min} 以上である必要があります", ko: "{min} 이상이어야 합니다" },
  "set.err.not_a_string": { "zh-CN": "必须是文本", "zh-TW": "必須是文字", en: "Must be text", ja: "文字列である必要があります", ko: "문자열이어야 합니다" },
  "set.err.not_a_boolean": { "zh-CN": "必须是开或关", "zh-TW": "必須是開或關", en: "Must be on or off", ja: "オンまたはオフである必要があります", ko: "켜기 또는 끄기여야 합니다" },
  "set.err.empty": { "zh-CN": "这一格不能留空", "zh-TW": "這一格不能留空", en: "This field cannot be empty", ja: "この項目は空にできません", ko: "이 항목은 비울 수 없습니다" },
  "set.err.too_long": { "zh-CN": "最长 {max} 个字符", "zh-TW": "最長 {max} 個字元", en: "At most {max} characters", ja: "最大 {max} 文字です", ko: "최대 {max}자입니다" },
  "set.err.not_a_url": { "zh-CN": "必须是 http:// 或 https:// 开头的地址", "zh-TW": "必須是 http:// 或 https:// 開頭的位址", en: "Must be an http:// or https:// URL", ja: "http:// または https:// で始まる URL が必要です", ko: "http:// 또는 https:// 로 시작하는 주소여야 합니다" },
  "set.err.not_a_channel": { "zh-CN": "只能选列表里的通道", "zh-TW": "只能選清單裡的通道", en: "Pick one of the listed channels", ja: "一覧にあるチャネルから選んでください", ko: "목록에 있는 채널 중에서 선택하세요" },
  "set.err.primary_required": { "zh-CN": "注册机开着时必须选一条主通道", "zh-TW": "註冊機開著時必須選一條主通道", en: "A primary channel is required while the registrar is on", ja: "レジストラーが有効なときは主チャネルの選択が必要です", ko: "등록기가 켜져 있을 때는 주 채널을 선택해야 합니다" },
  "set.err.fallback_equals_primary": { "zh-CN": "备用通道不能与主通道是同一条", "zh-TW": "備用通道不能與主通道是同一條", en: "The fallback channel cannot be the same as the primary one", ja: "フォールバックチャネルは主チャネルと同じにできません", ko: "대체 채널은 주 채널과 같을 수 없습니다" },
  "set.err.delay_min_gt_max": { "zh-CN": "最小间隔 {min} 不能大于最大间隔 {max}", "zh-TW": "最小間隔 {min} 不能大於最大間隔 {max}", en: "The minimum delay {min} cannot exceed the maximum {max}", ja: "最小間隔 {min} は最大間隔 {max} を超えられません", ko: "최소 간격 {min}은 최대 간격 {max}보다 클 수 없습니다" },
  "set.err.channel_credentials_missing": { "zh-CN": "{channel} 这条通道还差凭据，注册机开着时它必须配全", "zh-TW": "{channel} 這條通道還差憑據，註冊機開著時它必須配全", en: "The {channel} channel is missing credentials, which are required while the registrar is on", ja: "{channel} チャネルの資格情報が不足しています。レジストラーが有効な間は必須です", ko: "{channel} 채널의 자격 증명이 없습니다. 등록기가 켜져 있는 동안에는 필수입니다" },
  "set.err.gateway_token_required": { "zh-CN": "网关口令不能两边都没有：环境变量里没有，存储里也清空了，下一次冷启动会起不来", "zh-TW": "網關口令不能兩邊都沒有：環境變數裡沒有，儲存裡也清空了，下一次冷啟動會起不來", en: "The gateway token cannot be missing from both sides: it is absent from the environment and cleared in storage, so the next cold start will fail", ja: "ゲートウェイトークンが両方にない状態にはできません。環境変数になく、ストレージでもクリアされているため、次のコールドスタートで起動できなくなります", ko: "게이트웨이 토큰이 양쪽 모두에 없을 수는 없습니다. 환경 변수에도 없고 저장소에서도 지워져 다음 콜드 스타트에 기동이 실패합니다" },
  "set.err.whitespace_padded": { "zh-CN": "首尾不能有空白：HTTP 请求头的值在传输层会被去掉首尾空白，带空白的口令客户端永远送不出来", "zh-TW": "首尾不能有空白：HTTP 請求標頭的值在傳輸層會被去掉首尾空白，帶空白的口令客戶端永遠送不出來", en: "No leading or trailing whitespace: header values are trimmed in transport, so a padded token can never be sent by any client", ja: "先頭・末尾に空白を含められません。HTTP ヘッダー値は転送時に前後の空白が取り除かれるため、空白付きのトークンはどのクライアントからも送信できません", ko: "앞뒤에 공백을 넣을 수 없습니다. HTTP 헤더 값은 전송 단계에서 앞뒤 공백이 제거되므로 공백이 붙은 토큰은 어떤 클라이언트도 보낼 수 없습니다" },
  "set.err.not_sendable": { "zh-CN": "只能用可打印 ASCII（0x20–0x7E）：汉字 / emoji / 零宽空格这类字符浏览器根本发不出去", "zh-TW": "只能用可列印 ASCII（0x20–0x7E）：漢字 / emoji / 零寬空格這類字元瀏覽器根本送不出去", en: "Printable ASCII only (0x20–0x7E): CJK characters, emoji and zero-width spaces simply cannot be sent by the browser", ja: "印字可能な ASCII（0x20–0x7E）のみ使用できます。漢字・emoji・ゼロ幅スペースはブラウザーがそもそも送信できません", ko: "출력 가능한 ASCII(0x20–0x7E)만 쓸 수 있습니다. 한자 / 이모지 / 폭 없는 공백은 브라우저가 아예 보낼 수 없습니다" },
  "set.err.too_short": { "zh-CN": "至少 {min} 位：这条路没有分布式限速，口令熵是唯一的防线", "zh-TW": "至少 {min} 位：這條路沒有分散式限速，口令熵是唯一的防線", en: "At least {min} characters: there is no distributed rate limiting on this path, so token entropy is the only defence", ja: "{min} 文字以上にしてください。この経路には分散レート制限がないため、トークンのエントロピーが唯一の防御です", ko: "최소 {min}자 이상이어야 합니다. 이 경로에는 분산 속도 제한이 없어 토큰 엔트로피가 유일한 방어선입니다" },
  "set.err.same_as_admin_token": { "zh-CN": "网关口令不能与管理口令相同：中转口令是发给每一个下游用户的，设成相同之后管理接口会立刻停用，连改回去都做不到", "zh-TW": "網關口令不能與管理口令相同：中轉口令是發給每一個下游使用者的，設成相同之後管理介面會立刻停用，連改回去都做不到", en: "The gateway token must differ from the admin token: the gateway token is handed to every downstream user, and making them equal disables the admin API immediately — you could not even change it back", ja: "ゲートウェイトークンは管理トークンと同じにできません。ゲートウェイトークンはすべての下流ユーザーに配るものであり、同じにすると管理 API が即座に無効化され、元に戻すことすらできなくなります", ko: "게이트웨이 토큰은 관리 토큰과 같을 수 없습니다. 게이트웨이 토큰은 모든 하위 사용자에게 배포하는 값이며, 같게 만들면 관리 API가 즉시 중단되어 되돌리는 것조차 불가능합니다" },
  "set.err.config_unloadable": { "zh-CN": "这份配置构造不出来，而逐字段判据说不出是哪一格（多半是某个数值字段被写成了非数字）。具体原因在事件板块的 config.unloadable 里。", "zh-TW": "這份設定建構不出來，而逐欄位判據說不出是哪一格（多半是某個數值欄位被寫成了非數字）。具體原因在事件板塊的 config.unloadable 裡。", en: "This configuration cannot be constructed, and the per-field checks cannot say which field is at fault (most likely a numeric field was written as a non-number). The concrete reason is in the events board under config.unloadable.", ja: "この設定は構築できませんが、項目ごとの判定ではどの項目が原因かを特定できません（数値項目が数値以外で書かれている可能性が高いです）。具体的な理由はイベント一覧の config.unloadable にあります。", ko: "이 설정을 구성할 수 없으며, 항목별 판정으로는 어느 항목이 원인인지 알 수 없습니다(숫자 항목이 숫자가 아닌 값으로 기록되었을 가능성이 큽니다). 구체적인 이유는 이벤트 보드의 config.unloadable에 있습니다." },
  "set.err.unknown": { "zh-CN": "后端返回了这个面板版本不认识的错误码：{code}", "zh-TW": "後端回傳了這個面板版本不認識的錯誤碼：{code}", en: "The backend returned an error code this panel build does not know: {code}", ja: "このパネルのビルドが認識しないエラーコードが返されました: {code}", ko: "이 패널 빌드가 알지 못하는 오류 코드가 반환되었습니다: {code}" },
  "set.field.gatewayToken": { "zh-CN": "网关口令", "zh-TW": "網關口令", en: "Gateway token", ja: "ゲートウェイトークン", ko: "게이트웨이 토큰" },
  "set.field.agnesBaseUrl": { "zh-CN": "上游地址", "zh-TW": "上游位址", en: "Upstream base URL", ja: "上流ベース URL", ko: "업스트림 기본 URL" },
  "set.field.upstreamTimeoutMs": { "zh-CN": "上游超时（毫秒）", "zh-TW": "上游逾時（毫秒）", en: "Upstream timeout (ms)", ja: "上流タイムアウト（ミリ秒）", ko: "업스트림 타임아웃(ms)" },
  "set.field.upstreamSyncTimeoutMs": { "zh-CN": "同步端点超时（毫秒）", "zh-TW": "同步端點逾時（毫秒）", en: "Sync endpoint timeout (ms)", ja: "同期エンドポイントのタイムアウト（ミリ秒）", ko: "동기 엔드포인트 타임아웃(ms)" },
  "set.field.maxStrikes": { "zh-CN": "连续失败上限", "zh-TW": "連續失敗上限", en: "Max consecutive failures", ja: "連続失敗の上限", ko: "연속 실패 상한" },
  "set.field.cooldownRateLimitMs": { "zh-CN": "限流冷却（毫秒）", "zh-TW": "限流冷卻（毫秒）", en: "Rate-limit cooldown (ms)", ja: "レート制限クールダウン（ミリ秒）", ko: "속도 제한 쿨다운(ms)" },
  "set.field.cooldownPaymentMs": { "zh-CN": "欠费冷却（毫秒）", "zh-TW": "欠費冷卻（毫秒）", en: "Payment-required cooldown (ms)", ja: "支払い必要時のクールダウン（ミリ秒）", ko: "결제 필요 쿨다운(ms)" },
  "set.field.cooldownStrikeMs": { "zh-CN": "失败冷却（毫秒）", "zh-TW": "失敗冷卻（毫秒）", en: "Strike cooldown (ms)", ja: "失敗クールダウン（ミリ秒）", ko: "실패 쿨다운(ms)" },
  "set.field.poolCacheTtlMs": { "zh-CN": "池快照缓存（毫秒，0 = 关闭）", "zh-TW": "池快照快取（毫秒，0 = 關閉）", en: "Pool snapshot cache (ms, 0 = off)", ja: "プールスナップショットのキャッシュ（ミリ秒、0 = 無効）", ko: "풀 스냅숏 캐시(ms, 0 = 끔)" },
  "set.field.poolTouchIntervalMs": { "zh-CN": "写消除间隔（毫秒，0 = 关闭）", "zh-TW": "寫入消除間隔（毫秒，0 = 關閉）", en: "Write-elision interval (ms, 0 = off)", ja: "書き込み省略の間隔（ミリ秒、0 = 無効）", ko: "쓰기 생략 간격(ms, 0 = 끔)" },
  "set.field.registrar.enabled": { "zh-CN": "启用注册机", "zh-TW": "啟用註冊機", en: "Enable the registrar", ja: "レジストラーを有効にする", ko: "등록기 사용" },
  "set.field.registrar.primary": { "zh-CN": "主通道", "zh-TW": "主通道", en: "Primary channel", ja: "主チャネル", ko: "주 채널" },
  "set.field.registrar.fallback": { "zh-CN": "备用通道", "zh-TW": "備用通道", en: "Fallback channel", ja: "フォールバックチャネル", ko: "대체 채널" },
  "set.field.registrar.targetKeys": { "zh-CN": "目标 key 数", "zh-TW": "目標 key 數", en: "Target key count", ja: "目標キー数", ko: "목표 key 수" },
  "set.field.registrar.mintBatch": { "zh-CN": "单轮最多铸几把", "zh-TW": "單輪最多鑄幾把", en: "Max keys minted per round", ja: "1 ラウンドあたりの最大発行数", ko: "라운드당 최대 발급 수" },
  "set.field.registrar.tendIntervalMs": { "zh-CN": "补池间隔（毫秒）", "zh-TW": "補池間隔（毫秒）", en: "Refill interval (ms)", ja: "補充間隔（ミリ秒）", ko: "보충 간격(ms)" },
  "set.field.registrar.codeTimeoutMs": { "zh-CN": "等验证码超时（毫秒）", "zh-TW": "等驗證碼逾時（毫秒）", en: "Verification-code timeout (ms)", ja: "認証コード待機のタイムアウト（ミリ秒）", ko: "인증 코드 대기 타임아웃(ms)" },
  "set.field.registrar.mintDelayMinMs": { "zh-CN": "两次铸 key 的最小间隔（毫秒）", "zh-TW": "兩次鑄 key 的最小間隔（毫秒）", en: "Minimum delay between mints (ms)", ja: "発行間の最小間隔（ミリ秒）", ko: "발급 간 최소 간격(ms)" },
  "set.field.registrar.mintDelayMaxMs": { "zh-CN": "两次铸 key 的最大间隔（毫秒）", "zh-TW": "兩次鑄 key 的最大間隔（毫秒）", en: "Maximum delay between mints (ms)", ja: "発行間の最大間隔（ミリ秒）", ko: "발급 간 최대 간격(ms)" },
  "set.field.registrar.maxDomainAttempts": { "zh-CN": "换域名重试次数上限", "zh-TW": "換網域重試次數上限", en: "Max domain retries", ja: "ドメイン再試行の上限", ko: "도메인 재시도 상한" },
  "set.field.registrar.tokenName": { "zh-CN": "铸出的 key 在上游后台的显示名", "zh-TW": "鑄出的 key 在上游後台的顯示名", en: "Display name for minted keys upstream", ja: "発行したキーの上流での表示名", ko: "발급된 key의 업스트림 표시 이름" },
  "set.field.registrar.agnesPlatformUrl": { "zh-CN": "注册后端地址", "zh-TW": "註冊後端位址", en: "Registration backend URL", ja: "登録バックエンドの URL", ko: "가입 백엔드 URL" },
  "set.field.channel.baseUrl": { "zh-CN": "服务地址", "zh-TW": "服務位址", en: "Service URL", ja: "サービス URL", ko: "서비스 URL" },
  "set.field.channel.apiKey": { "zh-CN": "API Key", "zh-TW": "API Key", en: "API key", ja: "API キー", ko: "API 키" },

  // ── 用量板块（P3d Task 5，设计 §10.6）──────────────────────────────────────
  //
  // ⚠️ **这一段的每一条文案都在回答「这个数字为什么长这样」，而不是给一个数配一个名字。**
  // 这个板块的全部难点是「今天真的是 0 次请求」「Tier-2 没开」「读不出来」
  // 「读到的分片全坏了」在面板上长得一模一样，而它们是四件事。
  //
  // ⚠️ **`{占位符}` 的那几条一律只经 `t(key, {…})` 用**（门禁第 ⑧ 条）：
  // 交给 `elI18n(tag, key)` 会让裸的 `{count}` 直接展示给运维看
  //（`sec-overview.js` 的 `ov.config.envLocked` 上方记着那次真实事故）。
  "usage.title":      { "zh-CN": "用量", "zh-TW": "用量", en: "Usage", ja: "使用量", ko: "사용량" },
  "usage.rangeLabel": { "zh-CN": "时间范围", "zh-TW": "時間範圍", en: "Time range", ja: "期間", ko: "기간" },
  "usage.range.24h":  { "zh-CN": "24 小时", "zh-TW": "24 小時", en: "24h", ja: "24 時間", ko: "24시간" },
  "usage.range.3d":   { "zh-CN": "3 天", "zh-TW": "3 天", en: "3d", ja: "3 日", ko: "3일" },
  "usage.range.7d":   { "zh-CN": "7 天", "zh-TW": "7 天", en: "7d", ja: "7 日", ko: "7일" },
  "usage.range.30d":  { "zh-CN": "30 天", "zh-TW": "30 天", en: "30d", ja: "30 日", ko: "30일" },
  // 覆盖区间**渲染服务端回读的那一对**，不是前端自己算的显示区间。
  "usage.covered":    { "zh-CN": "覆盖区间：{from} — {to}", "zh-TW": "涵蓋區間：{from} — {to}", en: "Covered range: {from} — {to}", ja: "対象期間: {from} — {to}", ko: "대상 구간: {from} — {to}" },
  // ⚠️ **30 天那一档的说明。写「更早的已过期」是事实（保留期 30 天）；
  //    而它一次要读满 30 天的分片这件事在 Cloudflare Worker 上还没有真机结论
  //    ——**这里刻意不写「这些子请求是安全的」**，也不写它一定会失败。
  "usage.range.retention": { "zh-CN": "最多保留 30 天，更早的数据已经过期。30 天这一档一次要把整段区间的分片全部读回来；它在 Cloudflare Worker 上是否总能完成，尚未在真机上验证过——失败时这里会如实显示为读取失败，不会给出一份看起来完整的数字。", "zh-TW": "最多保留 30 天，更早的資料已經過期。30 天這一檔一次要把整段區間的分片全部讀回來；它在 Cloudflare Worker 上是否總能完成，尚未在真機上驗證過——失敗時這裡會如實顯示為讀取失敗，不會給出一份看起來完整的數字。", en: "At most 30 days are retained; anything older has expired. The 30-day option reads every shard in the whole range in one go; whether that always completes on Cloudflare Workers has not been verified on real infrastructure yet. If it fails, this page reports a read failure rather than showing numbers that look complete.", ja: "保持期間は最長 30 日で、それより古いデータは失効しています。30 日の選択肢は区間全体のシャードを一度に読み出します。これが Cloudflare Workers 上で常に完了するかどうかは実機で未検証です。失敗した場合は、完全に見える数字を出すのではなく読み取り失敗として表示します。", ko: "최대 30일까지만 보관하며 그보다 오래된 데이터는 만료되었습니다. 30일 옵션은 구간 전체의 샤드를 한 번에 읽습니다. 이것이 Cloudflare Workers에서 항상 완료되는지는 실제 환경에서 아직 검증되지 않았습니다. 실패하면 완전해 보이는 숫자를 보여주는 대신 읽기 실패로 표시합니다." },

  // ── 六张汇总卡（设计 §10.6）────────────────────────────────────────────────
  "usage.card.requests":  { "zh-CN": "总请求数", "zh-TW": "總請求數", en: "Requests", ja: "リクエスト数", ko: "요청 수" },
  "usage.card.successRate": { "zh-CN": "成功率", "zh-TW": "成功率", en: "Success rate", ja: "成功率", ko: "성공률" },
  // ⚠️ **单位写进标题，值那一格只放数字**：`format.mjs` 的 `fmtDuration` 只到
  //    「秒 / 分」两档精度（那是给运行时长设计的），拿它渲染 300 毫秒会写出
  //    「0秒」——而本模块不许再写第三个格式化函数（评审 I17）。
  "usage.card.latency":   { "zh-CN": "平均延迟（毫秒）", "zh-TW": "平均延遲（毫秒）", en: "Avg latency (ms)", ja: "平均レイテンシ（ミリ秒）", ko: "평균 지연(밀리초)" },
  "usage.card.errorRate": { "zh-CN": "错误率", "zh-TW": "錯誤率", en: "Error rate", ja: "エラー率", ko: "오류율" },
  // 标题里**直接写「仅非流式」**：流式请求的 token 网关根本看不到，
  // 一个不带这三个字的「Token」会被读成全量。
  "usage.card.tokens":    { "zh-CN": "Token（仅非流式）", "zh-TW": "Token（僅非串流）", en: "Tokens (non-streaming only)", ja: "トークン（非ストリーミングのみ）", ko: "토큰(비스트리밍만)" },
  "usage.card.streaming": { "zh-CN": "流式请求数", "zh-TW": "串流請求數", en: "Streaming requests", ja: "ストリーミングリクエスト数", ko: "스트리밍 요청 수" },
  // 协议名来自 `GET /admin/api/models` 的 `protocols[].label`，**不在前端硬编码**。
  "usage.card.tokensTip": { "zh-CN": "只统计得到这几条协议的非流式响应：{protocols}。流式响应与其余协议的 token 网关看不到，所以这个数只会偏小。", "zh-TW": "只統計得到這幾條協定的非串流回應：{protocols}。串流回應與其餘協定的 token 網關看不到，所以這個數只會偏小。", en: "Only non-streaming responses of these protocols are counted: {protocols}. Streaming responses and the remaining protocols are invisible to the gateway, so this number can only be an undercount.", ja: "次のプロトコルの非ストリーミング応答のみを集計しています: {protocols}。ストリーミング応答とその他のプロトコルはゲートウェイからは見えないため、この数値は過小になります。", ko: "다음 프로토콜의 비스트리밍 응답만 집계합니다: {protocols}. 스트리밍 응답과 나머지 프로토콜은 게이트웨이에서 볼 수 없으므로 이 값은 실제보다 적게 나옵니다." },
  "usage.card.tokensTipUnknown": { "zh-CN": "覆盖了哪几条协议这一次没读出来。这个数只统计非流式响应，流式的 token 网关看不到。", "zh-TW": "涵蓋了哪幾條協定這一次沒讀出來。這個數只統計非串流回應，串流的 token 網關看不到。", en: "Could not read which protocols are covered this time. This number counts non-streaming responses only; streaming tokens are invisible to the gateway.", ja: "どのプロトコルが対象かを今回は取得できませんでした。この数値は非ストリーミング応答のみを集計しており、ストリーミングのトークンはゲートウェイからは見えません。", ko: "이번에는 어떤 프로토콜이 포함되는지 읽지 못했습니다. 이 값은 비스트리밍 응답만 집계하며 스트리밍 토큰은 게이트웨이에서 볼 수 없습니다." },
  "usage.card.streamingTip": { "zh-CN": "单列一栏，好让 Token 那一格缺掉的正是这些请求这件事看得见。", "zh-TW": "單列一欄，好讓 Token 那一格缺掉的正是這些請求這件事看得見。", en: "Listed separately so that the gap in the token count is visible: these are exactly the requests it cannot see.", ja: "トークン数に欠けているのがまさにこれらのリクエストであることが分かるよう、独立した項目にしています。", ko: "토큰 수에서 빠진 것이 바로 이 요청들이라는 사실이 보이도록 별도 항목으로 둡니다." },

  // ── 单元格的两根破折号（P3d Task 5 评审 I15 的裁定）────────────────────────
  // ⚠️ **`–`（EN DASH）与 `—`（EM DASH）说的是两件事，视觉上必须分得开。**
  // 前者：这一次读成功了，只是这一格没有样本 / 没有分母；
  // 后者：整块就没读出来，我们不知道。
  "usage.cell.noneTip":    { "zh-CN": "这一次读成功了，只是这段时间没有可用的样本。", "zh-TW": "這一次讀成功了，只是這段時間沒有可用的樣本。", en: "The read succeeded; there simply were no samples in this period.", ja: "取得には成功しましたが、この期間にサンプルがありませんでした。", ko: "읽기는 성공했지만 이 기간에 사용할 샘플이 없습니다." },
  "usage.cell.unknownTip": { "zh-CN": "这一格读不出来。显示的不是 0——我们不知道它是多少。", "zh-TW": "這一格讀不出來。顯示的不是 0——我們不知道它是多少。", en: "This value could not be read. It is not zero — we do not know what it is.", ja: "この値は取得できませんでした。0 ではなく、値が分からないという意味です。", ko: "이 값을 읽지 못했습니다. 0이 아니라 값을 알 수 없다는 뜻입니다." },
  // `≈` 的 tooltip。落盘间隔那个数**从 capabilities 取，不在前端算死**。
  "usage.approxTip":        { "zh-CN": "近似值：Tier-1 在并发下会少计；Tier-2 还有一段最长 {flush} 的未落盘窗口。", "zh-TW": "近似值：Tier-1 在並行下會少計；Tier-2 還有一段最長 {flush} 的未落盤窗口。", en: "Approximate: Tier-1 undercounts under concurrency, and Tier-2 has an unflushed window of up to {flush}.", ja: "概算値: Tier-1 は並行時に少なく数え、Tier-2 には最大 {flush} の未書き込み時間があります。", ko: "근사값: Tier-1은 동시 요청에서 적게 세며, Tier-2에는 최대 {flush}의 미기록 구간이 있습니다." },
  "usage.approxTipUnknown": { "zh-CN": "近似值：Tier-1 在并发下会少计；Tier-2 还有一段未落盘窗口，它有多长这一次没读出来。", "zh-TW": "近似值：Tier-1 在並行下會少計；Tier-2 還有一段未落盤窗口，它有多長這一次沒讀出來。", en: "Approximate: Tier-1 undercounts under concurrency, and Tier-2 has an unflushed window whose length could not be read this time.", ja: "概算値: Tier-1 は並行時に少なく数え、Tier-2 には未書き込み時間がありますが、その長さは今回取得できませんでした。", ko: "근사값: Tier-1은 동시 요청에서 적게 세며, Tier-2에는 미기록 구간이 있으나 그 길이를 이번에는 읽지 못했습니다." },
  // ⚠️ **「不完整」这个标记本身就是全局约束 9 的一半**：伪造的不只是 `0`，
  //    还有「这份数据是全的」这个印象。
  "usage.incomplete":    { "zh-CN": "不完整", "zh-TW": "不完整", en: "Incomplete", ja: "不完全", ko: "불완전" },
  "usage.incompleteTip": { "zh-CN": "这段区间里有 {malformed} 个分片是畸形的，读不回来。下面这些数字缺了那几块，不是完整的用量。", "zh-TW": "這段區間裡有 {malformed} 個分片是畸形的，讀不回來。下面這些數字缺了那幾塊，不是完整的用量。", en: "{malformed} shard(s) in this range are malformed and could not be read. The numbers below are missing those parts — this is not the complete usage.", ja: "この期間には不正なシャードが {malformed} 件あり、読み取れませんでした。以下の数値はその分が欠けており、完全な使用量ではありません。", ko: "이 구간에 손상된 샤드가 {malformed}개 있어 읽지 못했습니다. 아래 수치는 그만큼 빠져 있어 완전한 사용량이 아닙니다." },

  // ── 九条 note code，各自一句（`src/http/admin/handlers/usage.ts` 的 `USAGE_NOTES`）──
  // ⚠️ **后端加第十条时这里不会有任何东西红**（那张表的穷举用例证明的是
  //    「已列出的八种互不相同」，不是「没有第九种」）⇒ 表外的 code 走
  //    `usage.note.unknown`，把原码照实显示出来。
  "usage.note.tier2Off":          { "zh-CN": "时间序列统计没有开启，这个部署没有在记账。", "zh-TW": "時間序列統計沒有開啟，這個部署沒有在記帳。", en: "Time-series stats are off; this deployment is not recording usage.", ja: "時系列統計が無効のため、このデプロイでは使用量を記録していません。", ko: "시계열 통계가 꺼져 있어 이 배포는 사용량을 기록하지 않습니다." },
  "usage.note.clockUnavailable":  { "zh-CN": "服务端时钟给不出有限数字，区间与保留期都算不出来。这不是「没有数据」。", "zh-TW": "伺服器時鐘給不出有限數字，區間與保留期都算不出來。這不是「沒有資料」。", en: "The server clock did not return a finite value, so neither the range nor the retention window can be computed. This is not “no data”.", ja: "サーバー時計が有限の値を返さないため、期間も保持期間も計算できません。これは「データがない」という意味ではありません。", ko: "서버 시계가 유한한 값을 주지 않아 구간과 보관 기간을 계산할 수 없습니다. 이것은 “데이터 없음”이 아닙니다." },
  "usage.note.readFailed":        { "zh-CN": "读取存储时出错，这段时间的数字整块拿不到。显示的破折号不是 0。", "zh-TW": "讀取儲存時出錯，這段時間的數字整塊拿不到。顯示的破折號不是 0。", en: "Reading storage failed, so none of the numbers for this period are available. The dashes are not zeros.", ja: "ストレージの読み取りに失敗したため、この期間の数値は取得できません。表示のダッシュは 0 ではありません。", ko: "스토리지 읽기에 실패하여 이 기간의 수치를 가져오지 못했습니다. 표시된 대시는 0이 아닙니다." },
  "usage.note.rangeClamped":      { "zh-CN": "要的区间被夹到了保留期之内，只显示了能拿到的那一段。上面的覆盖区间是服务端真正查过的那一对。", "zh-TW": "要的區間被夾到了保留期之內，只顯示了能拿到的那一段。上面的涵蓋區間是伺服器真正查過的那一對。", en: "The requested range was clamped into the retention window; only the part that could be fetched is shown. The covered range above is what the server actually queried.", ja: "要求した期間は保持期間内に丸められ、取得できた部分のみを表示しています。上の対象期間がサーバーが実際に照会した範囲です。", ko: "요청한 구간이 보관 기간 안으로 조정되어 가져올 수 있는 부분만 표시합니다. 위의 대상 구간이 서버가 실제로 조회한 범위입니다." },
  "usage.note.dateOutOfRetention": { "zh-CN": "这一天整个落在保留期之外。不是那天没有请求，是那天的记录已经不在了。", "zh-TW": "這一天整個落在保留期之外。不是那天沒有請求，是那天的記錄已經不在了。", en: "This day lies entirely outside the retention window. It is not that there were no requests — that day's records are gone.", ja: "この日は保持期間の外です。リクエストがなかったのではなく、その日の記録がもう残っていません。", ko: "이 날짜는 보관 기간을 완전히 벗어났습니다. 요청이 없었던 것이 아니라 그날의 기록이 남아 있지 않습니다." },
  "usage.note.noShards":          { "zh-CN": "读成功了，这段区间里一个分片都没有——这个部署确实没有记下任何用量。", "zh-TW": "讀成功了，這段區間裡一個分片都沒有——這個部署確實沒有記下任何用量。", en: "The read succeeded and there were no shards at all in this range — this deployment genuinely recorded no usage.", ja: "読み取りには成功しましたが、この期間にシャードが 1 件もありません。このデプロイは実際に使用量を記録していません。", ko: "읽기는 성공했지만 이 구간에 샤드가 하나도 없습니다. 이 배포는 실제로 사용량을 기록하지 않았습니다." },
  "usage.note.allMalformed":      { "zh-CN": "读到了分片，但每一个都是畸形的——这段时间的用量我们一无所知。请去查存储里是谁写的。", "zh-TW": "讀到了分片，但每一個都是畸形的——這段時間的用量我們一無所知。請去查儲存裡是誰寫的。", en: "Shards were found but every one of them is malformed — we know nothing about usage in this period. Check what wrote them in storage.", ja: "シャードは見つかりましたが、すべて不正な形式です。この期間の使用量は一切分かりません。ストレージに何が書き込まれたか確認してください。", ko: "샤드를 찾았지만 모두 손상되어 있습니다. 이 기간의 사용량을 전혀 알 수 없습니다. 스토리지에 무엇이 기록되었는지 확인하세요." },
  "usage.note.partialMalformed":  { "zh-CN": "一部分分片是畸形的，下面这些数字缺了那几块。请去查存储里是谁写的。", "zh-TW": "一部分分片是畸形的，下面這些數字缺了那幾塊。請去查儲存裡是誰寫的。", en: "Some shards are malformed, so the numbers below are missing those parts. Check what wrote them in storage.", ja: "一部のシャードが不正な形式のため、以下の数値はその分が欠けています。ストレージに何が書き込まれたか確認してください。", ko: "일부 샤드가 손상되어 아래 수치에서 그만큼 빠져 있습니다. 스토리지에 무엇이 기록되었는지 확인하세요." },
  "usage.note.noRequestDetail":   { "zh-CN": "这里没有逐请求流水，只有按小时 / 模型 / 协议的分解。需要逐请求粒度请看容器 stdout 或 Cloudflare Workers Logs。", "zh-TW": "這裡沒有逐請求流水，只有按小時 / 模型 / 協定的分解。需要逐請求粒度請看容器 stdout 或 Cloudflare Workers Logs。", en: "There is no per-request log here, only breakdowns by hour, model and protocol. For per-request detail see the container stdout or Cloudflare Workers Logs.", ja: "ここにはリクエスト単位のログはなく、時間 / モデル / プロトコル別の内訳のみです。リクエスト単位が必要な場合はコンテナの stdout または Cloudflare Workers Logs を参照してください。", ko: "여기에는 요청별 로그가 없고 시간 / 모델 / 프로토콜별 분해만 있습니다. 요청 단위가 필요하면 컨테이너 stdout 또는 Cloudflare Workers Logs를 확인하세요." },
  // ⚠️ **「这段时间真的是 0」必须有自己的一句话**：后端第 ④ 种状态
  //（有分片、只是请求数是 0）的 `note` 是 `null`，那一档没有任何 code 可读，
  //    而它与「读不出来」在数字上都是「什么都没有」——不说出来就是三态混一。
  "usage.empty":                  { "zh-CN": "这段区间里一次请求都没有。这不是读取失败——我们确实读到了，答案就是零。", "zh-TW": "這段區間裡一次請求都沒有。這不是讀取失敗——我們確實讀到了，答案就是零。", en: "There were no requests at all in this range. This is not a read failure — the read succeeded and the answer is zero.", ja: "この期間にリクエストは 1 件もありませんでした。読み取り失敗ではなく、取得に成功したうえで答えが 0 です。", ko: "이 구간에는 요청이 한 건도 없었습니다. 읽기 실패가 아니라, 읽기에 성공했고 답이 0입니다." },
  "usage.note.unknown":           { "zh-CN": "服务端给了一个这个面板还不认识的状态码：{code}。原样显示在这里，好让你拿它去查后端。", "zh-TW": "伺服器給了一個這個面板還不認識的狀態碼：{code}。原樣顯示在這裡，好讓你拿它去查後端。", en: "The server returned a status code this panel does not recognise yet: {code}. It is shown verbatim so you can look it up in the backend.", ja: "この画面がまだ認識していないステータスコードがサーバーから返されました: {code}。バックエンドで調べられるよう、そのまま表示しています。", ko: "이 화면이 아직 인식하지 못하는 상태 코드를 서버가 반환했습니다: {code}. 백엔드에서 찾아볼 수 있도록 그대로 표시합니다." },

  // ── Tier-2 关闭时的说明卡（设计 §10.6：不渲染空图表）──────────────────────
  // ⚠️⚠️ **设计 §10.6 写的是「『开启时间序列统计』按钮（跳设置页）」，本任务
  //    刻意没有做那颗按钮，理由写在 `admin-ui/js/sec-usage.js` 的说明卡那一段：
  //    `usageStatsEnabled` 今天不在 `EDITABLE` 里、设置页上没有它的入口
  //    （`src/core/config.ts` 的 `usageStatsEnabled` 上方逐字写着这一条），
  //    跳过去只会让运维在一个没有这个开关的页面上找一圈。这里改成写清怎么开。
  "usage.off.title": { "zh-CN": "时间序列统计没有开启", "zh-TW": "時間序列統計沒有開啟", en: "Time-series stats are off", ja: "時系列統計が無効です", ko: "시계열 통계가 꺼져 있습니다" },
  "usage.off.body":  { "zh-CN": "这个部署没有在按天记账，所以这里没有可以显示的数字。不画空图表是刻意的——一张全是 0 的图会被读成「这段时间没人用」。", "zh-TW": "這個部署沒有在按天記帳，所以這裡沒有可以顯示的數字。不畫空圖表是刻意的——一張全是 0 的圖會被讀成「這段時間沒人用」。", en: "This deployment is not recording daily usage, so there are no numbers to show. Deliberately no empty chart is drawn: a chart of zeros reads as “nobody used it”.", ja: "このデプロイは日次の使用量を記録していないため、表示できる数値がありません。空のグラフを描かないのは意図的です。0 ばかりのグラフは「誰も使っていない」と読まれてしまいます。", ko: "이 배포는 일별 사용량을 기록하지 않으므로 표시할 수치가 없습니다. 빈 차트를 그리지 않는 것은 의도적입니다. 0으로 채워진 차트는 “아무도 쓰지 않았다”로 읽힙니다." },
  "usage.off.howto": { "zh-CN": "要开启：把环境变量 USAGE_STATS_ENABLED 设成 true，然后重启容器（Cloudflare Worker 上是等 isolate 回收）。这个开关是建应用时读一次的，设置页上没有它的入口。", "zh-TW": "要開啟：把環境變數 USAGE_STATS_ENABLED 設成 true，然後重啟容器（Cloudflare Worker 上是等 isolate 回收）。這個開關是建應用時讀一次的，設定頁上沒有它的入口。", en: "To enable it: set the environment variable USAGE_STATS_ENABLED to true, then restart the container (on Cloudflare Workers, wait for the isolate to recycle). This switch is read once when the app is built, so the settings page has no control for it.", ja: "有効にするには: 環境変数 USAGE_STATS_ENABLED を true に設定し、コンテナを再起動してください（Cloudflare Workers では isolate の再生成を待ちます）。このスイッチはアプリ構築時に一度だけ読まれるため、設定ページには項目がありません。", ko: "켜려면: 환경 변수 USAGE_STATS_ENABLED를 true로 설정한 뒤 컨테이너를 재시작하세요(Cloudflare Workers에서는 isolate 재생성을 기다립니다). 이 스위치는 앱을 만들 때 한 번만 읽으므로 설정 페이지에는 항목이 없습니다." },
  "usage.off.cost":  { "zh-CN": "开启的代价：每个实例最长每 {flush} 往存储写一次分片。在 Cloudflare KV 上那是写配额，请对着部署文档里的配额账估一下再开。", "zh-TW": "開啟的代價：每個實例最長每 {flush} 往儲存寫一次分片。在 Cloudflare KV 上那是寫配額，請對著部署文件裡的配額帳估一下再開。", en: "What it costs: each instance writes a shard to storage at most once every {flush}. On Cloudflare KV that is write quota — check the quota budget in the deployment docs before turning it on.", ja: "コスト: 各インスタンスは最短で {flush} ごとにシャードをストレージへ書き込みます。Cloudflare KV では書き込みクォータを消費するため、デプロイ文書のクォータ計算を確認してから有効にしてください。", ko: "비용: 각 인스턴스가 최소 {flush}마다 스토리지에 샤드를 한 번 기록합니다. Cloudflare KV에서는 쓰기 쿼터를 소모하므로 배포 문서의 쿼터 계산을 확인한 뒤 켜세요." },
  "usage.off.costUnknown": { "zh-CN": "开启的代价：每个实例会定期往存储写一次分片。间隔有多长这一次没读出来（capabilities 没拿到）。", "zh-TW": "開啟的代價：每個實例會定期往儲存寫一次分片。間隔有多長這一次沒讀出來（capabilities 沒拿到）。", en: "What it costs: each instance periodically writes a shard to storage. The interval could not be read this time (capabilities were not available).", ja: "コスト: 各インスタンスは定期的にシャードをストレージへ書き込みます。その間隔は今回取得できませんでした（capabilities を取得できていません）。", ko: "비용: 각 인스턴스가 주기적으로 스토리지에 샤드를 기록합니다. 그 간격은 이번에 읽지 못했습니다(capabilities를 가져오지 못함)." },
  "usage.off.tier1": { "zh-CN": "顺带一提：Key 池板块里逐把 key 的累计计数与这个开关无关，它在这里关着的时候照样可用。", "zh-TW": "順帶一提：Key 池板塊裡逐把 key 的累計計數與這個開關無關，它在這裡關著的時候照樣可用。", en: "Note: the per-key counters in the key pool section are unrelated to this switch and remain available while it is off.", ja: "補足: キープール画面のキーごとの累計カウントはこのスイッチとは無関係で、無効のままでも利用できます。", ko: "참고: 키 풀 화면의 키별 누적 카운트는 이 스위치와 무관하며, 꺼져 있어도 계속 사용할 수 있습니다." },

  // ── 日汇总表与单日下钻 ─────────────────────────────────────────────────────
  "usage.table.title":     { "zh-CN": "按天", "zh-TW": "按天", en: "By day", ja: "日別", ko: "일별" },
  "usage.table.date":      { "zh-CN": "日期（UTC）", "zh-TW": "日期（UTC）", en: "Date (UTC)", ja: "日付（UTC）", ko: "날짜(UTC)" },
  "usage.table.requests":  { "zh-CN": "请求", "zh-TW": "請求", en: "Requests", ja: "リクエスト", ko: "요청" },
  "usage.table.success":   { "zh-CN": "成功", "zh-TW": "成功", en: "Success", ja: "成功", ko: "성공" },
  "usage.table.errors":    { "zh-CN": "错误", "zh-TW": "錯誤", en: "Errors", ja: "エラー", ko: "오류" },
  "usage.table.tokens":    { "zh-CN": "Token 入 / 出", "zh-TW": "Token 入 / 出", en: "Tokens in / out", ja: "トークン 入 / 出", ko: "토큰 입력 / 출력" },
  "usage.table.streaming": { "zh-CN": "流式", "zh-TW": "串流", en: "Streaming", ja: "ストリーミング", ko: "스트리밍" },
  "usage.table.latency":   { "zh-CN": "平均延迟（毫秒）", "zh-TW": "平均延遲（毫秒）", en: "Avg latency (ms)", ja: "平均レイテンシ（ミリ秒）", ko: "평균 지연(밀리초)" },
  "usage.table.empty":     { "zh-CN": "这段区间里没有可以列出的日子。", "zh-TW": "這段區間裡沒有可以列出的日子。", en: "There are no days to list in this range.", ja: "この期間に一覧できる日はありません。", ko: "이 구간에 나열할 날짜가 없습니다." },
  // ⚠️ **「读不出来」与「没有可以列出的日子」是两句话**（P3d Task 5 评审 C1）：
  //    `read_failed` 那一档 `days` 是 null ⇒ 行数也是 0，照上面那句渲染
  //    等于把一次读取失败说成「这段时间本来就没有日子」。
  "usage.table.unavailable": { "zh-CN": "这段区间的按天数据读不出来，所以这里是空的——不是这段时间没有日子。", "zh-TW": "這段區間的按天資料讀不出來，所以這裡是空的——不是這段時間沒有日子。", en: "The per-day data for this range could not be read, so this is empty — it is not that the range has no days.", ja: "この期間の日次データを取得できなかったため空になっています。期間に日がないという意味ではありません。", ko: "이 구간의 일별 데이터를 읽지 못해 비어 있습니다. 구간에 날짜가 없다는 뜻이 아닙니다." },
  "usage.table.drill":     { "zh-CN": "下钻", "zh-TW": "下鑽", en: "Drill down", ja: "詳細", ko: "자세히" },
  "usage.detail.title":    { "zh-CN": "{date} 的分解", "zh-TW": "{date} 的分解", en: "Breakdown for {date}", ja: "{date} の内訳", ko: "{date} 분해" },
  "usage.detail.hours":    { "zh-CN": "按小时（UTC）", "zh-TW": "按小時（UTC）", en: "By hour (UTC)", ja: "時間別（UTC）", ko: "시간별(UTC)" },
  "usage.detail.models":   { "zh-CN": "按模型", "zh-TW": "按模型", en: "By model", ja: "モデル別", ko: "모델별" },
  "usage.detail.protocols": { "zh-CN": "按协议", "zh-TW": "按協定", en: "By protocol", ja: "プロトコル別", ko: "프로토콜별" },
  "usage.detail.hour":     { "zh-CN": "小时", "zh-TW": "小時", en: "Hour", ja: "時", ko: "시" },
  "usage.detail.model":    { "zh-CN": "模型", "zh-TW": "模型", en: "Model", ja: "モデル", ko: "모델" },
  "usage.detail.protocol": { "zh-CN": "协议", "zh-TW": "協定", en: "Protocol", ja: "プロトコル", ko: "프로토콜" },
  "usage.detail.close":    { "zh-CN": "收起", "zh-TW": "收起", en: "Collapse", ja: "閉じる", ko: "접기" },
  "usage.detail.empty":    { "zh-CN": "这一天没有可以分解的记录。", "zh-TW": "這一天沒有可以分解的記錄。", en: "There is nothing to break down for this day.", ja: "この日は内訳を表示できる記録がありません。", ko: "이 날짜에는 분해할 기록이 없습니다." },
  // ⚠️ 与 `usage.table.unavailable` 同一条理由，C1 点名的「第三屏」：分片全坏 /
  //    读取失败 / 落在保留期外时三个 map 合出来都是空的，照上面那句渲染就是
  //    把「我们什么都不知道」说成「这一天没有记录」。
  // ⚠️ **单日口径，不能拿 `usage.incompleteTip` 顶替**（定向复评 N7）：
  //    后者逐字写着「这段区间里」，而下钻说的是**一天**。
  "usage.detail.incomplete": { "zh-CN": "这一天有 {malformed} 个分片是畸形的，读不回来。下面这些数字缺了那几块，不是这一天完整的用量。", "zh-TW": "這一天有 {malformed} 個分片是畸形的，讀不回來。下面這些數字缺了那幾塊，不是這一天完整的用量。", en: "{malformed} shard(s) for this day are malformed and could not be read. The numbers below are missing those parts — this is not the complete usage for the day.", ja: "この日は不正なシャードが {malformed} 件あり、読み取れませんでした。以下の数値はその分が欠けており、この日の完全な使用量ではありません。", ko: "이 날짜에 손상된 샤드가 {malformed}개 있어 읽지 못했습니다. 아래 수치는 그만큼 빠져 있어 이 날짜의 완전한 사용량이 아닙니다." },
  "usage.detail.unavailable": { "zh-CN": "这一天的分解读不出来，所以这里是空的——不是这一天没有记录。", "zh-TW": "這一天的分解讀不出來，所以這裡是空的——不是這一天沒有記錄。", en: "The breakdown for this day could not be read, so this is empty — it is not that the day has no records.", ja: "この日の内訳を取得できなかったため空になっています。この日に記録がないという意味ではありません。", ko: "이 날짜의 분해를 읽지 못해 비어 있습니다. 이 날짜에 기록이 없다는 뜻이 아닙니다." },

  // ── 未落盘的尾巴（`pending` 块）───────────────────────────────────────────
  // ⚠️ 判据是 `count`，**不是 `ms`**：`ms` 数的是「距上一次落盘*尝试*多久」，
  //    `count > 0 && ms ≈ 0` 要读作「刚试过、没写成」。
  "usage.pending":          { "zh-CN": "还有 {count} 条计数没有落盘，上面的数字少了这一截。", "zh-TW": "還有 {count} 條計數沒有落盤，上面的數字少了這一截。", en: "{count} counter(s) have not been flushed yet; the numbers above are short by that much.", ja: "未書き込みのカウントが {count} 件あります。上の数値はその分少なくなっています。", ko: "아직 기록되지 않은 카운트가 {count}건 있습니다. 위 수치는 그만큼 적습니다." },
  "usage.pendingExhausted": { "zh-CN": "写配额已经耗尽，还有 {count} 条计数暂时写不进存储。这不是「没有尾巴」，是写不进去。", "zh-TW": "寫配額已經耗盡，還有 {count} 條計數暫時寫不進儲存。這不是「沒有尾巴」，是寫不進去。", en: "The write budget is exhausted; {count} counter(s) cannot be written to storage for now. This is not “nothing pending” — the writes are failing.", ja: "書き込み予算を使い切ったため、{count} 件のカウントを当面ストレージへ書き込めません。「未書き込みがない」のではなく、書き込めていません。", ko: "쓰기 예산이 소진되어 {count}건의 카운트를 당분간 스토리지에 기록할 수 없습니다. “대기 중인 것이 없음”이 아니라 기록에 실패하고 있습니다." },

  // ── 模型板块（P3d Task 6，设计 §10.7 / §11）────────────────────────────────
  // ⚠️⚠️ **这一段里一个端点路径、一个协议 id 都没有，是刻意的**（P3d 全局约束 15）：
  //    协议的展示名是**专名**，由 `GET /admin/api/models` 的 `protocols[].label` 直接
  //    给出，翻译它只会制造歧义；端点由响应的 `endpoints[]` 原样渲染。
  //    ⇒ 字典里只放**要翻译的东西**：列名、三个形态名、两句 tooltip、三句空态说明。
  // ⚠️ 「类型」是那一列的**显示名**，代码里那个字段一律叫 `modality`（评审 Minor 9）。
  "models.title":            { "zh-CN": "模型", "zh-TW": "模型", en: "Models", ja: "モデル", ko: "모델" },
  "models.desc":             { "zh-CN": "本网关认得的模型，以及每个模型在哪几条协议上真的可用。", "zh-TW": "本閘道認得的模型，以及每個模型在哪幾條協定上真的可用。", en: "The models this gateway knows about, and which protocols each one is actually available on.", ja: "このゲートウェイが認識しているモデルと、各モデルが実際に利用できるプロトコルです。", ko: "이 게이트웨이가 인식하는 모델과, 각 모델이 실제로 사용 가능한 프로토콜입니다." },
  "models.table.title":      { "zh-CN": "模型目录", "zh-TW": "模型目錄", en: "Model catalog", ja: "モデルカタログ", ko: "모델 카탈로그" },
  "models.filter.label":     { "zh-CN": "按协议筛选", "zh-TW": "依協定篩選", en: "Filter by protocol", ja: "プロトコルで絞り込み", ko: "프로토콜로 필터" },
  "models.filter.all":       { "zh-CN": "全部", "zh-TW": "全部", en: "All", ja: "すべて", ko: "전체" },
  "models.col.id":           { "zh-CN": "模型 ID", "zh-TW": "模型 ID", en: "Model ID", ja: "モデル ID", ko: "모델 ID" },
  "models.col.modality":     { "zh-CN": "类型", "zh-TW": "類型", en: "Type", ja: "種類", ko: "유형" },
  "models.col.protocols":    { "zh-CN": "协议可用性", "zh-TW": "協定可用性", en: "Protocol availability", ja: "プロトコル対応", ko: "프로토콜 지원" },
  "models.col.endpoints":    { "zh-CN": "端点", "zh-TW": "端點", en: "Endpoints", ja: "エンドポイント", ko: "엔드포인트" },
  "models.modality.chat":    { "zh-CN": "对话", "zh-TW": "對話", en: "Chat", ja: "チャット", ko: "대화" },
  "models.modality.image":   { "zh-CN": "图片", "zh-TW": "圖片", en: "Image", ja: "画像", ko: "이미지" },
  "models.modality.video":   { "zh-CN": "视频", "zh-TW": "影片", en: "Video", ja: "動画", ko: "동영상" },
  // ⚠️ 灰徽章那一句必须说「不可用」，**不许说「未知」**：矩阵里的每一格都是从目录里
  //    读出来的确定答案，把它说成「未知」就把一句确定的话降级成了含糊话。
  "models.badge.yes":        { "zh-CN": "这个模型在这条协议上可用", "zh-TW": "這個模型在這條協定上可用", en: "This model is available on this protocol", ja: "このモデルはこのプロトコルで利用できます", ko: "이 모델은 이 프로토콜에서 사용할 수 있습니다" },
  "models.badge.no":         { "zh-CN": "这个模型在这条协议上不可用", "zh-TW": "這個模型在這條協定上不可用", en: "This model is not available on this protocol", ja: "このモデルはこのプロトコルでは利用できません", ko: "이 모델은 이 프로토콜에서 사용할 수 없습니다" },
  // ⚠️ 三句空态说明**互不重叠**，理由与用量板块那三态是同一条（全局约束 9）：
  //    「一个模型都没有」「这条协议上没有」「读不出来」在屏幕上必须分得开。
  "models.empty":            { "zh-CN": "这份目录里一个模型都没有。", "zh-TW": "這份目錄裡一個模型都沒有。", en: "This catalog contains no models.", ja: "このカタログにはモデルが 1 つもありません。", ko: "이 카탈로그에는 모델이 하나도 없습니다." },
  "models.filterEmpty":      { "zh-CN": "这条协议上没有可用的模型。", "zh-TW": "這條協定上沒有可用的模型。", en: "No models are available on this protocol.", ja: "このプロトコルで利用できるモデルはありません。", ko: "이 프로토콜에서 사용할 수 있는 모델이 없습니다." },
  "models.unavailable":      { "zh-CN": "模型目录读不出来，所以这里是一根破折号——不是这个网关一个模型都没有。", "zh-TW": "模型目錄讀不出來，所以這裡是一根破折號——不是這個閘道一個模型都沒有。", en: "The model catalog could not be read, so this shows a dash — it is not that the gateway has no models.", ja: "モデルカタログを取得できなかったためダッシュを表示しています。ゲートウェイにモデルがないという意味ではありません。", ko: "모델 카탈로그를 읽지 못해 대시를 표시합니다. 게이트웨이에 모델이 없다는 뜻이 아닙니다." },

  // ── Playground 板块（P3d Task 10）────────────────────────────────────────
  // ⚠️ **这一段一个 `{占位符}` 都没有，是刻意的**：`scripts/check-i18n.mjs` 的第 ⑧ 条
  //    要求带占位符的 key 每一次以字面量出现时后面都紧跟一个 `,`，而本板块把大量
  //    key 交给 `elI18n(tag, key)`（第二个参数后面确实是 `,` 或 `)`），
  //    形态一旦掺进占位符就要逐处核对。这里用不上参数，那就一个都不写。
  // ⚠️ **协议名与模型 id 一律不进字典**：它们是专名 / 标识符，来自协议目录的响应。
  "pg.title":                { "zh-CN": "调试台", "zh-TW": "偵錯台", en: "Playground", ja: "プレイグラウンド", ko: "플레이그라운드" },
  "pg.desc":                 { "zh-CN": "在面板里直接向这个网关发一次真实请求，用来确认四条协议以及图片、视频两条媒体端点各自是不是通的。", "zh-TW": "在面板裡直接向這個閘道發一次真實請求，用來確認四條協定以及圖片、影片兩條媒體端點各自是不是通的。", en: "Send a real request to this gateway from the panel to confirm each of the four protocols, plus the image and video endpoints, works.", ja: "この画面からゲートウェイへ実際にリクエストを送り、4 つのプロトコルと画像・動画の各エンドポイントが通るかを確認します。", ko: "콘솔에서 이 게이트웨이로 실제 요청을 보내 네 가지 프로토콜과 이미지·동영상 엔드포인트가 각각 동작하는지 확인합니다." },
  // ⚠️ **这一句是 U-B 的落点，措辞不许放松成「两种形态一样」**：官方文档说 HTTP 触发的
  //    Worker 没有墙钟上限、单条子请求也没有时间上限，但**没有**说 CDN 那条回源读超时
  //    适不适用于 Worker 自己发出的子请求 ⇒ 按「没有平台承诺」处理。
  "pg.runtimeNote":          { "zh-CN": "一次非流式请求要等上游把整段回答生成完才返回，可能很慢。Worker 与 Docker 两种部署形态在超长请求上的表现不一定相同，这里不对「多久之内一定不会被中断」做任何承诺。", "zh-TW": "一次非串流請求要等上游把整段回答產生完才返回，可能很慢。Worker 與 Docker 兩種部署形態在超長請求上的表現不一定相同，這裡不對「多久之內一定不會被中斷」做任何承諾。", en: "A non-streaming request only returns once upstream has finished generating the whole answer, so it can be slow. The Worker and Docker deployments may behave differently on very long requests; nothing here promises how long a request is guaranteed to survive.", ja: "非ストリーミングのリクエストは上流が回答全体を生成し終えるまで返りません。非常に長いリクエストでは Worker と Docker の挙動が同じとは限らず、「何秒までは必ず中断されない」といった保証はここでは一切行いません。", ko: "비스트리밍 요청은 업스트림이 답변 전체를 만들어야 반환되므로 느릴 수 있습니다. 아주 긴 요청에서는 Worker와 Docker의 동작이 같다고 볼 수 없으며, 여기서는 「몇 초까지는 반드시 끊기지 않는다」는 약속을 하지 않습니다." },
  "pg.req.title":            { "zh-CN": "请求配置", "zh-TW": "請求設定", en: "Request", ja: "リクエスト設定", ko: "요청 설정" },
  "pg.mode.label":           { "zh-CN": "模式", "zh-TW": "模式", en: "Mode", ja: "モード", ko: "모드" },
  "pg.mode.chat":            { "zh-CN": "对话", "zh-TW": "對話", en: "Chat", ja: "チャット", ko: "대화" },
  "pg.mode.image":           { "zh-CN": "图片", "zh-TW": "圖片", en: "Image", ja: "画像", ko: "이미지" },
  "pg.mode.video":           { "zh-CN": "视频", "zh-TW": "影片", en: "Video", ja: "動画", ko: "동영상" },
  "pg.proto.label":          { "zh-CN": "协议", "zh-TW": "協定", en: "Protocol", ja: "プロトコル", ko: "프로토콜" },
  "pg.model.label":          { "zh-CN": "模型", "zh-TW": "模型", en: "Model", ja: "モデル", ko: "모델" },
  "pg.model.noneMedia":      { "zh-CN": "这个形态下没有可用的模型。", "zh-TW": "這個形態下沒有可用的模型。", en: "No model is available for this modality.", ja: "この種類で利用できるモデルがありません。", ko: "이 형태에서 사용할 수 있는 모델이 없습니다." },
  "pg.model.none":           { "zh-CN": "这条协议上没有可用的模型，换一条协议试试。", "zh-TW": "這條協定上沒有可用的模型，換一條協定試試。", en: "No model is available on this protocol; try another one.", ja: "このプロトコルで利用できるモデルがありません。別のプロトコルをお試しください。", ko: "이 프로토콜에서 사용할 수 있는 모델이 없습니다. 다른 프로토콜을 사용해 보세요." },
  "pg.stream.label":         { "zh-CN": "流式", "zh-TW": "串流", en: "Streaming", ja: "ストリーミング", ko: "스트리밍" },
  "pg.stream.tip":           { "zh-CN": "打开后回答会一块一块地到，右栏边收边显示；这一档不统计 token。", "zh-TW": "打開後回答會一塊一塊地到，右欄邊收邊顯示；這一檔不統計 token。", en: "When on, the answer arrives in chunks and the right column fills in as it goes; this mode reports no token counts.", ja: "オンにすると回答が少しずつ届き、右側に順次表示されます。このモードでは token 数は表示されません。", ko: "켜면 답변이 조각으로 도착해 오른쪽에 차례로 표시됩니다. 이 모드에서는 token 수를 집계하지 않습니다." },
  "pg.token.label":          { "zh-CN": "网关口令", "zh-TW": "閘道口令", en: "Gateway token", ja: "ゲートウェイトークン", ko: "게이트웨이 토큰" },
  "pg.token.placeholder":    { "zh-CN": "粘贴 GATEWAY_TOKEN", "zh-TW": "貼上 GATEWAY_TOKEN", en: "Paste GATEWAY_TOKEN", ja: "GATEWAY_TOKEN を貼り付け", ko: "GATEWAY_TOKEN 붙여넣기" },
  // ⚠️ 这句话必须说清「面板拿不到它」，否则运维会一直找那颗并不存在的「填入我的口令」按钮。
  "pg.token.note":           { "zh-CN": "这把口令由你手动粘贴，只存在这台浏览器里。面板读不到它的明文（凭据只写不读），所以没有「一键填入」。", "zh-TW": "這把口令由你手動貼上，只存在這台瀏覽器裡。面板讀不到它的明文（憑據只寫不讀），所以沒有「一鍵填入」。", en: "You paste this token yourself and it stays in this browser. The panel cannot read its plaintext (credentials are write-only), so there is no auto-fill.", ja: "このトークンはご自身で貼り付け、このブラウザーにのみ保存されます。画面側は平文を読み取れない（資格情報は書き込み専用）ため、自動入力はありません。", ko: "이 토큰은 직접 붙여넣으며 이 브라우저에만 저장됩니다. 콘솔은 평문을 읽을 수 없으므로(자격 증명은 쓰기 전용) 자동 채우기는 없습니다." },
  "pg.token.stateEmpty":     { "zh-CN": "还没粘口令", "zh-TW": "還沒貼口令", en: "No token pasted yet", ja: "トークン未入力", ko: "토큰이 아직 없습니다" },
  // ⚠️ 「比不了」与「对不上」是两句话，**不许折叠成一档**：折叠之后运维会去改一把其实没错的口令。
  "pg.token.stateUnknown":   { "zh-CN": "读不到设置页里的末位提示，这次比不了", "zh-TW": "讀不到設定頁裡的末位提示，這次比不了", en: "Cannot read the stored token hint, so no comparison was made", ja: "設定側の末尾ヒントを取得できないため、照合できません", ko: "설정의 끝자리 힌트를 읽을 수 없어 대조하지 못했습니다" },
  "pg.token.stateMatch":     { "zh-CN": "末位与设置页里配的那把一致", "zh-TW": "末位與設定頁裡配的那把一致", en: "Last characters match the configured token", ja: "末尾が設定済みのトークンと一致します", ko: "끝자리가 설정된 토큰과 일치합니다" },
  "pg.token.stateMismatch":  { "zh-CN": "末位与设置页里配的那把对不上", "zh-TW": "末位與設定頁裡配的那把對不上", en: "Last characters do not match the configured token", ja: "末尾が設定済みのトークンと一致しません", ko: "끝자리가 설정된 토큰과 일치하지 않습니다" },
  "pg.prompt.label":         { "zh-CN": "提示词", "zh-TW": "提示詞", en: "Prompt", ja: "プロンプト", ko: "프롬프트" },
  "pg.prompt.placeholder":   { "zh-CN": "输入要发给模型的一句话", "zh-TW": "輸入要發給模型的一句話", en: "Type a message to send to the model", ja: "モデルに送る文章を入力", ko: "모델에 보낼 문장을 입력" },
  "pg.send":                 { "zh-CN": "发送", "zh-TW": "發送", en: "Send", ja: "送信", ko: "보내기" },
  "pg.cancel":               { "zh-CN": "取消这一次", "zh-TW": "取消這一次", en: "Cancel this request", ja: "このリクエストを中止", ko: "이 요청 취소" },
  "pg.sending":              { "zh-CN": "正在等上游返回…", "zh-TW": "正在等上游返回…", en: "Waiting for upstream…", ja: "上流からの応答を待っています…", ko: "업스트림 응답을 기다리는 중…" },
  "pg.send.ready":           { "zh-CN": "按一下会真的向上游发一次请求。", "zh-TW": "按一下會真的向上游發一次請求。", en: "Each click really does send one request upstream.", ja: "クリックするたびに上流へ実際にリクエストを 1 回送ります。", ko: "누를 때마다 업스트림으로 실제 요청을 한 번 보냅니다." },
  "pg.send.readyVideo":      { "zh-CN": "按一下会真的向上游发请求：一次视频任务是 1 次建任务 + 最多 {count} 次轮询查询。", "zh-TW": "按一下會真的向上游發請求：一次影片任務是 1 次建任務 + 最多 {count} 次輪詢查詢。", en: "Each click really does hit upstream: one video job is 1 create request plus up to {count} polling requests.", ja: "クリックすると上流へ実際にリクエストを送ります。動画タスク 1 件はタスク作成 1 回 + 最大 {count} 回のポーリングです。", ko: "누르면 업스트림으로 실제 요청을 보냅니다. 동영상 작업 1건은 생성 요청 1회와 최대 {count}회의 폴링으로 이루어집니다." },
  "pg.send.blockedInFlight": { "zh-CN": "上一次请求还在飞，等它回来或者取消它。", "zh-TW": "上一次請求還在飛，等它回來或者取消它。", en: "The previous request is still in flight; wait for it or cancel it.", ja: "前回のリクエストがまだ実行中です。完了を待つか中止してください。", ko: "이전 요청이 아직 진행 중입니다. 완료를 기다리거나 취소하세요." },
  "pg.send.blockedNoProto":  { "zh-CN": "先选一条协议。", "zh-TW": "先選一條協定。", en: "Pick a protocol first.", ja: "先にプロトコルを選んでください。", ko: "먼저 프로토콜을 선택하세요." },
  "pg.send.blockedNoEndpoint": { "zh-CN": "协议目录里没有这个形态的端点，这一档发不出请求。", "zh-TW": "協定目錄裡沒有這個形態的端點，這一檔發不出請求。", en: "The protocol catalog has no endpoint for this modality, so nothing can be sent from this mode.", ja: "プロトコルカタログにこの種類のエンドポイントがないため、このモードからは送信できません。", ko: "프로토콜 카탈로그에 이 형태의 엔드포인트가 없어 이 모드에서는 요청을 보낼 수 없습니다." },
  "pg.send.blockedNoModel":  { "zh-CN": "先选一个模型。", "zh-TW": "先選一個模型。", en: "Pick a model first.", ja: "先にモデルを選んでください。", ko: "먼저 모델을 선택하세요." },
  "pg.send.blockedNoToken":  { "zh-CN": "先粘贴网关口令。", "zh-TW": "先貼上閘道口令。", en: "Paste the gateway token first.", ja: "先にゲートウェイトークンを貼り付けてください。", ko: "먼저 게이트웨이 토큰을 붙여넣으세요." },
  "pg.send.blockedNoPrompt": { "zh-CN": "先写一句提示词。", "zh-TW": "先寫一句提示詞。", en: "Type a prompt first.", ja: "先にプロンプトを入力してください。", ko: "먼저 프롬프트를 입력하세요." },
  "pg.conv.title":           { "zh-CN": "对话", "zh-TW": "對話", en: "Conversation", ja: "やり取り", ko: "대화" },
  "pg.conv.empty":           { "zh-CN": "还没有发过请求。左栏配好之后按「发送」。", "zh-TW": "還沒有發過請求。左欄配好之後按「發送」。", en: "No request has been sent yet. Configure the left column, then press Send.", ja: "まだリクエストを送っていません。左側を設定してから「送信」を押してください。", ko: "아직 요청을 보내지 않았습니다. 왼쪽을 설정한 뒤 「보내기」를 누르세요." },
  "pg.conv.clear":           { "zh-CN": "清空对话", "zh-TW": "清空對話", en: "Clear conversation", ja: "やり取りを消去", ko: "대화 지우기" },
  "pg.conv.trimmed":         { "zh-CN": "屏幕上最多保留 {max} 轮，最旧的 {count} 轮已经从这里移除。", "zh-TW": "畫面上最多保留 {max} 輪，最舊的 {count} 輪已經從這裡移除。", en: "At most {max} turns are kept on screen; the oldest {count} have been removed from here.", ja: "画面に残すのは最大 {max} 往復までで、古い方の {count} 往復はここから削除されました。", ko: "화면에는 최대 {max}턴까지만 남기며, 가장 오래된 {count}턴은 여기에서 삭제되었습니다." },
  "pg.turn.you":             { "zh-CN": "你发出的", "zh-TW": "你發出的", en: "Sent", ja: "送信内容", ko: "보낸 내용" },
  // ⚠️ 「网关回的」而不是「模型回的」：中间隔着这个网关的协议转换，说成后者会把
  //    一次网关侧的错误归到模型头上。
  "pg.turn.gateway":         { "zh-CN": "网关回的", "zh-TW": "閘道回的", en: "Gateway replied", ja: "ゲートウェイの応答", ko: "게이트웨이 응답" },
  "pg.turn.streamEmpty":     { "zh-CN": "这条流读完了，但里面一个字的正文都没有。", "zh-TW": "這條串流讀完了，但裡面一個字的正文都沒有。", en: "This stream finished without carrying a single character of answer text.", ja: "このストリームは完了しましたが、本文が 1 文字も含まれていませんでした。", ko: "이 스트림은 끝났지만 본문이 한 글자도 들어 있지 않았습니다." },
  "pg.turn.cancelled":       { "zh-CN": "这一次被你取消了，上面那段是取消之前真的收到的内容。", "zh-TW": "這一次被你取消了，上面那段是取消之前真的收到的內容。", en: "You cancelled this request; the text above is what really arrived before it stopped.", ja: "このリクエストは中止されました。上の本文は中止前に実際に届いた内容です。", ko: "이 요청은 취소되었습니다. 위 본문은 중단되기 전에 실제로 도착한 내용입니다." },
  "pg.turn.malformed":       { "zh-CN": "这条流里有 {count} 块数据读不出来，已跳过——上面这段回答可能是缺字的。", "zh-TW": "這條串流裡有 {count} 塊資料讀不出來，已跳過——上面這段回答可能是缺字的。", en: "{count} chunk(s) in this stream could not be read and were skipped — the answer above may be missing characters.", ja: "このストリームでは {count} 個のチャンクを読み取れず、スキップしました。上の回答は文字が欠けている可能性があります。", ko: "이 스트림에서 {count}개의 청크를 읽지 못해 건너뛰었습니다. 위 답변은 글자가 빠졌을 수 있습니다." },
  // ⚠️ **这一句在 P3e 被降过一级，别改回去**：原文是「流式响应不带 token 用量」
  // ——那是一句关于**上游**的全称句，而四条协议里 openai 那条是上游字节原样透传，
  // 上游会不会在流末发一块 usage **本仓从没量过**。改成「**本面板**不读」之后，
  // 它说的是本面板自己的行为，**与上游无关、恒为真**。论证与那条未定案的边界见
  // `admin-ui/js/sec-playground.js` 的文件头「流式那一轮为什么不显示 token 用量」那段。
  "pg.turn.noTokens":        { "zh-CN": "本面板在流式这一档不读 token 用量，所以这里不显示数字——显示 0 会是假的。", "zh-TW": "本面板在串流這一檔不讀 token 用量，所以這裡不顯示數字——顯示 0 會是假的。", en: "This panel does not read token usage in streaming mode, so no number is shown here — showing 0 would be a lie.", ja: "このパネルはストリーミングでは token 使用量を読み取らないため、ここには数値を表示しません。0 と表示するのは嘘になります。", ko: "이 패널은 스트리밍 모드에서 token 사용량을 읽지 않으므로 여기에 숫자를 표시하지 않습니다. 0으로 표시하면 거짓이 됩니다." },
  "pg.turn.unreadable":      { "zh-CN": "这次的响应体读不出来（不是空响应，是解析不了）。", "zh-TW": "這次的回應內容讀不出來（不是空回應，是解析不了）。", en: "This response body could not be read — it is not empty, it could not be parsed.", ja: "今回のレスポンス本文を読み取れませんでした（空ではなく、解析できませんでした）。", ko: "이번 응답 본문을 읽지 못했습니다(비어 있는 것이 아니라 파싱하지 못했습니다)." },
  "pg.err.buildFailed":      { "zh-CN": "这次请求没能构造出来：协议目录里的样例形状与面板对不上，请核对两边的版本。", "zh-TW": "這次請求沒能構造出來：協定目錄裡的樣例形狀與面板對不上，請核對兩邊的版本。", en: "The request could not be built: the sample shape in the protocol catalog does not match what this panel expects — check that both sides are on the same version.", ja: "リクエストを組み立てられませんでした。プロトコルカタログのサンプル形状がこの画面の想定と合いません。両者のバージョンを確認してください。", ko: "요청을 만들지 못했습니다. 프로토콜 카탈로그의 샘플 형태가 이 콘솔의 기대와 다릅니다. 양쪽 버전을 확인하세요." },
  "pg.err.crossOrigin":      { "zh-CN": "这次请求一个字节都没发出去：拼出来的地址不在本面板所在的源上。口令不会被送去别处。", "zh-TW": "這次請求一個位元組都沒發出去：拼出來的位址不在本面板所在的來源上。口令不會被送去別處。", en: "Nothing was sent: the assembled address is not on this panel's own origin. The token was not sent anywhere.", ja: "今回は 1 バイトも送信していません。組み立てたアドレスがこの画面のオリジンではありません。トークンはどこにも送られていません。", ko: "이번에는 한 바이트도 보내지 않았습니다. 조립된 주소가 이 콘솔의 출처가 아닙니다. 토큰은 어디로도 전송되지 않았습니다." },
  "pg.err.transport":        { "zh-CN": "这次请求没有拿到任何响应：可能是断网、被取消，或者请求本身失败了。这与上游的状态无关。", "zh-TW": "這次請求沒有拿到任何回應：可能是斷網、被取消，或者請求本身失敗了。這與上游的狀態無關。", en: "This request got no response at all: the network may be down, it may have been cancelled, or the request itself failed. This says nothing about upstream.", ja: "今回のリクエストは応答をまったく受け取れませんでした。ネットワーク断、中止、あるいはリクエスト自体の失敗が考えられます。上流の状態とは無関係です。", ko: "이번 요청은 아무 응답도 받지 못했습니다. 네트워크 문제, 취소, 또는 요청 자체의 실패일 수 있습니다. 업스트림 상태와는 무관합니다." },
  "pg.err.stream":           { "zh-CN": "这条流没读完就断了。上面那段正文是真的收到过的，后面还有多少不知道。", "zh-TW": "這條串流沒讀完就斷了。上面那段正文是真的收到過的，後面還有多少不知道。", en: "This stream broke off before it finished. The text above really did arrive; how much was still to come is unknown.", ja: "このストリームは完了前に切断されました。上の本文は実際に届いたものですが、残りがどれだけあったかは分かりません。", ko: "이 스트림은 끝나기 전에 끊겼습니다. 위 본문은 실제로 도착한 내용이며, 남은 분량은 알 수 없습니다." },
  "pg.media.endpoint":       { "zh-CN": "这一档打的端点", "zh-TW": "這一檔打的端點", en: "Endpoint for this mode", ja: "このモードのエンドポイント", ko: "이 모드가 호출하는 엔드포인트" },
  "pg.media.copy":           { "zh-CN": "复制", "zh-TW": "複製", en: "Copy", ja: "コピー", ko: "복사" },
  "pg.media.open":           { "zh-CN": "在新标签页打开", "zh-TW": "在新分頁開啟", en: "Open in a new tab", ja: "新しいタブで開く", ko: "새 탭에서 열기" },
  "pg.media.alt":            { "zh-CN": "上游返回的图片。内嵌的是 data 形式的内容，没有向任何远端发起请求。", "zh-TW": "上游返回的圖片。內嵌的是 data 形式的內容，沒有向任何遠端發起請求。", en: "Image returned by upstream. It is embedded as inline data, so no request was made to any remote host.", ja: "上流が返した画像です。data 形式で埋め込んでいるため、外部のホストへのリクエストは発生していません。", ko: "업스트림이 반환한 이미지입니다. data 형식으로 삽입되므로 어떤 원격 호스트에도 요청하지 않습니다." },
  "pg.media.bytes":          { "zh-CN": "上游这次直接回的是一段字节流（{type}），不是一份带地址的结果。面板不内嵌媒体，所以这里只报告它的类型。", "zh-TW": "上游這次直接回的是一段位元組流（{type}），不是一份帶位址的結果。面板不內嵌媒體，所以這裡只報告它的類型。", en: "Upstream returned raw bytes this time ({type}), not a result carrying a URL. The panel never embeds media, so only the type is reported here.", ja: "今回、上流はアドレス付きの結果ではなくバイト列（{type}）をそのまま返しました。この画面はメディアを埋め込まないため、種類のみを表示します。", ko: "이번에 업스트림은 주소가 담긴 결과가 아니라 바이트 스트림({type})을 그대로 반환했습니다. 콘솔은 미디어를 삽입하지 않으므로 여기서는 형식만 알려 줍니다." },
  "pg.media.none":           { "zh-CN": "这次的响应里没有出现任何一条媒体地址。下面是网关原样返回的内容。", "zh-TW": "這次的回應裡沒有出現任何一條媒體位址。下面是閘道原樣返回的內容。", en: "No media address appeared in this response. Below is exactly what the gateway returned.", ja: "今回の応答にはメディアのアドレスが 1 件も含まれていません。以下はゲートウェイがそのまま返した内容です。", ko: "이번 응답에는 미디어 주소가 하나도 없습니다. 아래는 게이트웨이가 그대로 반환한 내용입니다." },
  "pg.media.taskId":         { "zh-CN": "任务标识", "zh-TW": "任務識別碼", en: "Task ID", ja: "タスク ID", ko: "작업 ID" },
  "pg.media.polling":        { "zh-CN": "正在轮询这个任务的结果，已经查过 {count} 次。", "zh-TW": "正在輪詢這個任務的結果，已經查過 {count} 次。", en: "Polling this task for its result; {count} check(s) so far.", ja: "このタスクの結果を確認中です。これまでに {count} 回問い合わせました。", ko: "이 작업의 결과를 폴링하는 중입니다. 지금까지 {count}회 조회했습니다." },
  "pg.media.pollGaveUp":     { "zh-CN": "轮询已经到上限，先停下了——任务本身可能仍在进行。请稍后拿上面这个任务标识再查一次。", "zh-TW": "輪詢已經到上限，先停下了——任務本身可能仍在進行。請稍後拿上面這個任務識別碼再查一次。", en: "Polling hit its limit and stopped — the task itself may still be running. Check again later using the task ID above.", ja: "ポーリングが上限に達したため停止しました。タスク自体はまだ実行中の可能性があります。後ほど上のタスク ID で再度確認してください。", ko: "폴링이 상한에 도달해 중단했습니다. 작업 자체는 아직 진행 중일 수 있습니다. 잠시 후 위의 작업 ID로 다시 조회하세요." },
  "pg.media.noTaskId":       { "zh-CN": "本面板只把这几格当任务标识来读：{slots}。这次建任务的响应里，它们都没有能用的标识，面板不替你猜，所以没有自动轮询。响应原文见下面。", "zh-TW": "本面板只把這幾格當任務識別碼來讀：{slots}。這次建任務的回應裡，它們都沒有能用的識別碼，面板不替你猜，所以沒有自動輪詢。回應原文見下面。", en: "This panel reads only these fields as a task ID: {slots}. None of them carried a usable ID in this create-task response, and the panel will not guess one, so nothing was polled. The raw response is below.", ja: "この画面がタスク ID として読むのは次の項目だけです：{slots}。今回のタスク作成の応答では、いずれにも使える識別子がありませんでした。画面側で推測はしないため、ポーリングは行っていません。応答の原文は下にあります。", ko: "이 콘솔이 작업 ID로 읽는 항목은 다음뿐입니다: {slots}. 이번 작업 생성 응답에서는 어느 항목에도 쓸 수 있는 식별자가 없었고, 콘솔은 추측하지 않으므로 폴링하지 않았습니다. 응답 원문은 아래에 있습니다." },
  "pg.unavailable":          { "zh-CN": "协议目录读不出来，所以这里什么都配不了——不是这个网关一条协议都没有。", "zh-TW": "協定目錄讀不出來，所以這裡什麼都配不了——不是這個閘道一條協定都沒有。", en: "The protocol catalog could not be read, so nothing can be configured here — it is not that the gateway has no protocols.", ja: "プロトコルカタログを取得できなかったため、ここでは何も設定できません。ゲートウェイにプロトコルがないという意味ではありません。", ko: "프로토콜 카탈로그를 읽지 못해 여기서는 아무것도 설정할 수 없습니다. 게이트웨이에 프로토콜이 없다는 뜻이 아닙니다." },
};
