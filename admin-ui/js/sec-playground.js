/**
 * Playground 板块（设计 §10.5）：左栏配请求、右栏看对话。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * ── **本板块是「消费协议目录」这条路径的第三个前端消费者** ────────────────────
 * P3d 核心设计决定（全局约束 15）：四个消费者只许有一份「怎么调这个网关」的知识。
 * ⇒ **本文件的可执行代码里没有任何一条对外端点路径、没有任何一个协议 id、
 *    也没有任何一份请求体形状**（两条 admin 路径 `api.get("/models")` 与
 *    `api.get("/config")` 为什么不算，见下面「两条 admin 路径为什么不算第二份端点知识」）。
 * 协议档位与展示名来自响应的 `protocols[]`，模型下拉来自 `models[]`，
 * URL 与请求体由 `js/pure/playground.mjs` 拿那份响应现拼。
 *
 * ── **这是面板上第二颗「按一下就真打上游」的按钮**（全局约束 14）────────────────
 * 第一颗是 Key 池的验活（P3d Task 9）。护栏在同一个任务里一起交付：
 * · **在飞去重**：同一时刻只许一次在飞，按钮 disabled，旁边出现「取消」。
 *   ⚠️ **判据只有一份，就是 `sendBlockedKey()` 的第一档**（`pg.send.blockedInFlight`）：
 *   按钮的 `disabled` 与 `sendOnce()` 的早退**读的都是它**。
 *   ⚠️⚠️ 这一版曾经在 `sendOnce()` 开头另写过一句 `if (inFlight) return;`，
 *   **变异实测删掉它 22/22 全绿**——那是一句没有任何用例守着的冗余，
 *   而当时这一段正声称它是护栏本体。**已删，这段话已改真。**
 * · **取消令牌**：`AbortController`，点取消 / 切走板块都作废这一次。
 *
 * ⚠️⚠️ **刻意不加最小间隔闸，这条差别必须写下来**：Key 池的验活有一道 3 秒闸
 * （`js/pure/keys-write.mjs` 的 `VERIFY_MIN_INTERVAL_MS`，后端 `probe-guard.ts` 还有
 * 对称的一道）。**Playground 不加**——它是**交互式调试工具**，运维改一句提示词连发
 * 几次是正常用法，而每一次都是他自己坐在那儿等结果（有在飞去重兜着，同一时刻最多
 * 一条在飞）。照抄那道闸只会得到一个让人恼火的 3 秒禁用态。
 * **下一个人别照着 `probe-guard` 把它补上。**
 *
 * ⚠️ **「重新发送时 abort 上一次」今天没有触发路径，如实写明**：在飞去重 + 按钮
 * disabled 之后，一次在飞期间根本发不出第二条。所以作废只有**两个**入口
 * （取消按钮、`onHide()`）。写一条今天走不到的抢占分支等于摆一段死代码，
 * 而本仓在 `js/sec-models.js` 的文件头上记过「一句『今天用不上它』的话会被后来的
 * 改动推翻」——所以这里记的是相反的方向：**哪天允许在飞时再发，抢占分支要连同它的
 * 世代号一起补上**，别只把 disabled 去掉。
 *
 * ⚠️⚠️ **abort 那一半在测试里天然不可观测，写清楚**：`tests/ui/dom/harness.ts` 的
 * `fetch` 替身**零处**看 `signal` ⇒ 被 abort 的那条链在测试里照样会落地。
 * **别把那几格绿了读成「abort 被钉住了」**——它们钉的是下面那个「这一次还是不是当前
 * 那一次」的判据（`current !== ctl`），与 `js/sec-keys.js` 的验活、`js/sec-models.js`
 * 的世代号是同一条判据。真实浏览器里 abort 让那条链以 `AbortError` 拒绝，
 * 同一条判据同样把它挡在外面。
 *
 * ── **网关口令：面板永远只是它的搬运工**（全局约束 11(b)）─────────────────────
 * 口令由用户手动粘贴、存在浏览器里（`js/pure/storage-keys.mjs` 的 `GW_KEY_STORE`），
 * **后端不开任何回显口子**。本文件因此有一条硬纪律：
 * **口令的值只许出现在两个地方——那个 `<input>` 的 `.value`，和 `js/gw-api.js`
 * 拼请求头的那一行。** 不许进 `title`、不许进 `data-*`、不许进任何一句错误文案的插值、
 * 更不许进右栏的任何一格。由 `tests/ui/dom/playground-section.test.ts` 的
 * 「面板上任何一处都不出现网关口令 —— 输入框的值不许漏进标题、属性或任何一句错误文案」
 * 那一格逐个属性扫着钉住。
 * ⚠️ 口令输入框旁边那句「与设置页那把对不对得上」只画**档位名**，判定在
 * `js/pure/playground.mjs` 的 `tokenHintState()`，它按定义不返回口令的任何一个字节。
 *
 * ── 媒体两档（P3d Task 12 接上）：只展示地址，**不内嵌远端任何东西** ────────────
 * ⚠️⚠️ **面板样式与 `src/ui/serve.ts` 的 CSP 一个字都没放宽**（全局约束 17）：
 * 那条 CSP 是 img-src 只放行本源与 data 两档、**且完全没有 media-src**
 * （⇒ video 元素落回 default-src none）。⇒ 媒体那两档**只展示地址 + 复制按钮 +
 * 在新标签页打开**；唯一被内嵌的是 data 开头且 MIME 为图片的那一种（CSP 本来就放行它）。
 * ⚠️ **不许为了内嵌去放宽 CSP**：那条 CSP 是 `ADMIN_TOKEN` 存在这个 origin 的浏览器
 * 本地存储里的唯一结构性防线（作用域是 origin 不是 path，
 * 论证全文在 `src/core/dispatcher.ts` 的 `DOCUMENT_MIME` 那段长注释）。
 * ⚠️ **「能不能内嵌」「能不能做链接」两条判据都是纯函数，不在本文件里目测**
 * （`js/pure/playground.mjs` 的 `mediaEmbeddable()` / `mediaLinkable()`）。
 * 由 `tests/ui/playground-media.test.ts` 的
 * 「远端 http(s) 地址一律不可内嵌 —— 面板 CSP 的 img-src 里没有任何远端主机（订正 F6）」
 * 与 `tests/ui/dom/playground-section.test.ts` 的
 * 「媒体结果只出现地址与链接，一个内嵌远端资源的元素都没有」两格钉着。
 * ⚠️ **链接元素必须显式带 `rel="noopener noreferrer"`**：`target="_blank"` 的 a 元素
 * 现代浏览器会隐式补 `noopener`，**但那是浏览器的默认值、不是这段代码的性质**，
 * 而 `window.open()` 从来不补。由 `tests/ui/dom/playground-section.test.ts` 的
 * 「结果链接带 rel 的 noopener noreferrer 两条」钉着。
 *
 * ── 视频是两段式，而轮询的三条护栏一条都不许省（设计 §10.5）─────────────────
 * ① **有上限**：判定在 `js/pure/playground.mjs` 的 `videoPollNext()`，次数与时长两条
 *    同时判。**一个忘了关的标签页就是一台永动打点机**，每一次打点都是一次真的上游请求；
 * ② **页面藏起来时暂停**（照抄事件板块 `js/sec-events.js` 的 `scheduleNext()` 做法），
 *    变回可见时接回去；
 * ③ **`onHide()` 停轮询**（板块契约，设计 §9.3）——与取消按钮走同一个 `cancelInFlight()`。
 * ⚠️ **轮询期间在飞标记不松开**（全局约束 14）：松开的话运维能同时点起第二条视频任务，
 * 而两条任务的打点会叠在一起烧配额。代价是那几分钟里发送按钮是灰的，
 * **取消按钮一直在**，随时可以停。
 *
 * ⚠️⚠️ **一次视频任务最多 1 + 60 次上游请求**（全局约束 13 的触发条件是
 * 「新增一个会写存储的代码路径」，而 P3d 那一任务一条都没新增——它只是让**已有**的
 * 那条路径被按得更频，所以当时这笔账只登记在这里）。
 * ⚠️ **P3e Task 28 起它已经进了五语言 DEPLOY.md 的配额账**（Playground 那一条），
 * 由 `tests/unit/docs-parity.test.ts「NUMBERS 表里那两个从真源常量现算的 token 都还在」`
 * 那一格钉着「那一行还在表上」，再由同文件那一族计数用例钉着「五语言计数不许分叉」；
 * 那一行的 token 从 `VIDEO_POLL_MAX_ATTEMPTS` 现算，常量改了而文档没跟上它同样会红。
 * ⚠️⚠️ **上一版这里指的是那一族的用例名（「……的出现次数彼此一致」），而用例名是模板串
 * 生成的，`……` 只认得住族名**：复评实测删掉那一整行 `token` ⇒ 本门禁 exit 0、
 * docs-parity 照绿，那句「那一格钉着」当时没有任何机器在保证。今天指的是一格标题写死
 * 的用例，删掉那一行它当场红，删掉那一格则本门禁的名字锚落空。
 * ⚠️ **再上一版写着「这条没有进 DEPLOY.md 的配额账」，那句话从 Task 28 起就是假的，
 * 随该任务一并改真。** 下面那两条仍以本处为准。
 * · **上游请求数与 key 的使用次数**：实打实按 61 倍算，这是真实成本；
 * · **存储写次数**：**不按 61 倍放大**——`lastUsedAt` 与用量计数由
 *   `src/core/keypool-repo.ts` 的 `touchIntervalMs`（默认 6 小时）那道写消除闸管着，
 *   一轮轮询打不满一次落盘。冷却 / 剔除那两笔仍按失败次数算。
 * ⇒ 会打穿的是**上游那边的配额**，不是 KV 的日写配额。别把这两件事混着读。
 *
 * ── 流式（P3d Task 11）：开关已经接上，而且两种运行时都是真的逐块 ─────────────
 * Task 10 时这个开关是 `disabled` 的（读流那一半还没写）。**现在它是真的。**
 * ⚠️ **「真的逐块」这句话是真机量出来的，不是推出来的**：假上游 1 秒/块 × 4 块，
 * `curl -N` 逐块打时间戳，**Node（`@hono/node-server`）与 Worker（`wrangler dev`
 * 起的真 workerd）两侧的到达间隔都是约 1 秒**，不是四块一起到 ⇒ 两种形态都逐块透传。
 * ⇒ **本板块因此没有任何形态分支**：流式在哪种部署上都能用，不需要降级、
 * 也不需要往 `capabilities` 里加一格「这个形态能不能流」。
 * ⚠️ **哪天这条前提变了，改的是后端那一格 + 这里读它，不是在这里嗅探运行时**
 * （全局约束 1：一切形态分支只许读 `GET /admin/api/capabilities`）。
 *
 * ⚠️⚠️ **而「哪天变了」这件事，单元测试与契约用例仍然一格都不会告诉你。**
 * 那条前提是一个**已发货功能的承重墙**，而机器测网那一侧没有它：
 * `tests/contract/stream-parity.test.ts` 的
 * 「上游第二块还没 enqueue 时客户端已经读到了第一块 —— 被整体缓冲的话 Playground 的流式开关就是假话」
 * 走的是进程内的 `app.request()`，它自己的文件头就写着**证明不了 workerd 的 HTTP 服务层**。
 * ⇒ **workerd 哪天改成缓冲，那一族测试一格都不会红，而这个面板会静默变成一句假话**
 *（开关照按、正文照出，只是一次性全到）。
 * ⚠️ **堵它的东西现在有了，但它不是一格用例，是一份要真起进程的冒烟**：
 * `scripts/smoke-dual-runtime.sh` 的 ③ 那一格 —— 假上游 1 秒/块 × 4 块，
 * **每一块的正文就是它发出去那一刻的毫秒时间戳**，客户端 `curl -N` 逐行打到达时间戳，
 * 判据是「**第一行到达** 早于 **上游最后一块发出**」。
 * 实测（2026-08-29 北京时间，Docker 与 wrangler dev 起的真 workerd 各一次）：
 * **两侧的第一行都早了约 3 秒**（= (4−1) × 1 秒）⇒ 两种形态都逐块透传。
 * ⚠️ **判据刻意不是「拿到了几块」**：整体缓冲的实现最终也会把全部内容交出来，
 * 只看总量是零鉴别力。这条与 Task 11 明令禁止的「往单块表里加一行 CRLF 样本」是同一条。
 * ⚠️ **它只在有人跑它的时候才会红**（推送前复跑清单的第七格默认跑它，
 * 但那份清单不是 CI 的一道）——所以这条前提今天有仪器，仍然没有**自动**回归网。
 *
 * ── 右栏：流式画正文，非流式仍画响应原文 ────────────────────────────────────
 * **流式没有「原文」可展示**——它天然要一块一块把正文取出来拼。「这条协议的正文在
 * 哪一格」因此顶到了台面上，而答案是**往协议目录加一格**（`streamTextPath`，
 * 真源 `src/core/admin/protocol-catalog.ts`），**不是在这里写第四份对照表**
 * （全局约束 15）。本文件因此仍然不认识任何一个协议 id。
 * ⚠️ **非流式那一档没有跟着改**：`streamTextPath` 只覆盖流式增量，
 * 「非流式响应里那句话在哪」是另一格，**今天没有第二个消费者要它**
 * ⇒ 登记 P3e，理由全文在 `js/pure/playground.mjs` 的 `prettyJson()` 上方。
 *
 * ── 流式那一轮为什么不显示 token 用量（**论证按协议分档，P3e Task 22 改写**）──────
 * ⚠️⚠️ **上一版这里写的是一句全称句：「因为网关的流式响应里根本没有真的 token 数」。
 * 那句话只对四条里的三条成立，第四条从没量过。** 逐档写清：
 *
 * · **anthropic / responses / gemini 这三条流是本仓自己合成的**
 *   （`src/core/protocol/anthropic.ts`、`src/core/protocol/responses.ts`、
 *   `src/core/protocol/gemini.ts` 的 `to*Stream()`）⇒ 里面有没有 usage 由本仓说了算。
 *   实况：responses 与 gemini 那两条**一个 usage 字段都不发**；anthropic 那条**硬写两处
 *   恒为 0** —— `src/core/protocol/anthropic.ts`「usage: { input_tokens: 0, output_tokens: 0 }」
 *   （`message_start`）与 `src/core/protocol/anthropic.ts`「usage: { output_tokens: 0 }」
 *   （`message_delta`）。⇒ 谁顺手把「响应里的 usage」画出来，Anthropic 那条流就会在面板上
 *   显示 **0 个 token**，那是全局约束 9 明令禁止的那件事（**伪造 0 比显示「没有」更糟**）。
 *   ⚠️⚠️ **上一句里 responses / gemini 那半原来是一句零判据的全称句（复评 F1，本轮补上）**：
 *   anthropic 那半靠上面两个名字锚拦得住（改一个字段名 ⇒ 注释指向那道门禁当场 EXIT=1），
 *   而 responses / gemini 那半**当时仓里没有任何东西会为它变红** —— 复评把 `usage: {…}`
 *   加进 `src/core/protocol/responses.ts` 的 `response.completed` ⇒ **全仓 3176/3176 全绿**。
 *   **补上判据之后同一次变异重跑（本轮亲手跑的）：那个文件当场 1 failed / 16 passed**；
 *   gemini 那条同款变异（往流式事件里加 `usageMetadata`）同样当场红。
 *   ⇒ 现在它由 `tests/unit/responses.test.ts`
 *   「toResponsesStream() 吐出去的字节里一个 usage 字段都没有」与 `tests/unit/gemini.test.ts`
 *   「toGeminiStream() 吐出去的字节里一个 usage 字段都没有」两格钉着，
 *   两格各带一条反向控制（非流式那条**真的**带 usage，同一份判据在它身上认得出来）。
 *
 * · **openai 那条是上游字节原样透传，「流末带不带 usage」是上游决定的、本仓未核实。**
 *   `src/http/routes/openai.ts` 不传 `expectJson` ⇒ 网关从头到尾没有 `JSON.parse` 过它。
 *   真实上游若在流末发一块 usage（不少 OpenAI 兼容实现会发，或客户端带了
 *   `stream_options.include_usage`），**那些字节会原样到达浏览器**。
 *   假上游下量不到，**需要一次真上游才能定案**。这条边界的全文与裁定在
 *   `src/core/admin/protocol-catalog.ts` 的 `streamTextPath` 上方那段
 *   「一条今天定不了案的边界」。
 *
 * ⇒ **面板那句文案因此只说本面板自己做了什么**，逐字是
 *   `admin-ui/js/i18n-dict.js`「本面板在流式这一档不读 token 用量」（key 名 pg.turn.noTokens）
 *   ——**与上游有没有 usage 无关，恒为真**。
 *   它替换掉的旧文案「流式响应不带 token 用量」是一句关于上游的全称句，对 openai 可能为假。
 *   ⚠️ **引文与路径必须紧挨着写**（复评 F2）：上一版写成「`pg.turn.noTokens` 逐字是「…」」，
 *   引文和字典那份真源之间隔着别的字 ⇒ 注释指向那道门禁**认不出这是个名字锚**，
 *   复评实测把字典里的「本面板」改成「此面板」⇒ 那道门禁 **EXIT=0**；
 *   改成现在这个形态之后**本轮亲手重跑同一次变异**：**EXIT=1，两处引文各被点名一次**。
 * ⇒ 流式那一轮**今天一个字节的 usage 都不读**，一条解析分支都没有。
 * 由 `tests/ui/dom/playground-section.test.ts` 的
 * 「流式那一轮不显示任何 token 数字 —— Anthropic 的流里带着一个恒为 0 的 usage」钉着。
 *
 * ⚠️⚠️ **别把上面那句读成「结构上不可能」——它只是「今天没写」。**（评审 F2 实测）
 * 我原来在报告里写过「结构性地不读，不是靠自觉」，**那是言过其实**：
 * 评审在 `onPayload` 里加三行解析 `usage.output_tokens`、在下面多画一行
 * `` `Tokens: ${…}` `` ⇒ **当时 103/103 全绿**，屏幕上同时出现
 *「流式响应不带 token 用量…」（**当时的旧文案**，见上一段）与「Tokens: 0」。
 * 当时守着它的只有一条**按字段名**的子串断言（换个标签就绕过）与一条**计数**断言
 *（只挡替换、不挡新增）。
 * ⇒ 现在守它的是**闭集**断言：那一格逐条比对**整个右栏**渲染出来的「标签 + class」列表，
 * **多画任何一行都红**。这仍然是一道测试，不是一条结构性的不可能。
 * ⚠️ **而「多画一行就红」这句话，P3e Task 22 之前也没有任何东西守着**：闭集判据自己
 * 被改瞎（遍历切短）的话，真扫描那一格照样全绿。补上的同格反向控制是
 * `tests/ui/dom/playground-section.test.ts` 的
 * 「反向控制（同格）：手工往流式那一轮多挂一个 p.pg-tokens —— 闭集判据看不见它就说明它是死断言」
 * 与「反向控制（同格·盒子外）：把那一行挂到 .pg-turn 外面的右栏上 —— 盒子外照样在屏幕上」。
 * ⚠️⚠️ **射程原来停在 `.pg-turn` 那个盒子上，本轮放宽到右栏（复评 F3）**：
 * 复评把 `Tokens: 0` 画在 `buildRight()` 的 `body` 上（`.pg-turn` **外面**、右栏里）
 * ⇒ **那个测试文件 81/81 全绿**，而屏幕上「本面板……不读 token 用量」与「Tokens: 0」同时在。
 * ⇒ 判据改成遍历右栏那整张卡片，上面第二条反向控制就是那次逃逸的 DOM 形态。
 * **同一次变异在放宽之后重跑（本轮亲手跑的）：那个文件 4 failed / 78 passed。**
 * ⚠️ **明写它今天仍然覆盖不到哪些**：**左栏**（请求表单）与**板块之外**不在射程里
 * ——那两处不是「有别的东西在守」，是登记在案的空当，全文与取舍写在那个测试文件里
 * `rightShape()` 上方。
 * ⚠️⚠️ **降级让这道闭集比降级之前更承重**：文案已经不再声称「上游没有 usage」，
 * 「本面板不读」这件事在右栏**只剩那一族用例在守**。别把降级读成「可以顺手加 usage 解析了」
 * ——降的是**说法**的射程，不是这条纪律。
 *
 * ── 两条 admin 路径为什么不算「第二份端点知识」 ──────────────────────────────
 * 全局约束 15 管的是「怎么调**这个网关**」那张对外面（对外路径、请求体形状、鉴权头），
 * 不是「怎么够得着那份真源」。`js/sec-models.js` 与 `js/sec-usage.js` 已经写着同样的
 * `api.get("/models")`，本文件与它们同一条边界。
 * ⚠️ **但要写清代价：这两条 admin 路径今天没有任何机器在守**
 * （`tests/ui/no-hardcoded-endpoints.test.ts` 的
 * 「前端没有任何文件硬编码网关端点路径 —— 端点只许来自 /admin/api/models」
 * 那一格的正则只认对外那棵树的路径）。
 *
 * ── 三条纪律（与其余七个板块相同）────────────────────────────────────────────
 * ① 一切来自接口的内容一律 textContent（`el()` 走的就是它）：右栏画的是**上游原样
 *    回来的响应体**，那是全站最该守这条的一处；
 * ② **取值决策一律不写在这里**，全在 `js/pure/playground.mjs` 里（admin-ui/README.md 硬规则 1）；
 * ③ **一切形态分支只读接口返回的字段**，不许自己嗅探运行时（全局约束 1）。
 *
 * ⚠️ **双运行时：非流式长请求在两种形态下可能表现不同，面板不许承诺它们一样**（U-B）。
 * 已核实的官方口径：HTTP 触发的 Worker **没有**墙钟上限、单条子请求也**没有**时间上限
 * （只要客户端还连着）；而 `wrangler.toml` 里那个 15 分钟是 `scheduled()` 的数，
 * **不是 `fetch()` 的**。官方文档**没有**说 CDN 那条 125 秒回源读超时（524）适不适用于
 * Worker 自己发出的子请求 ⇒ 按「没有平台承诺」处理。五语言 DEPLOY.md 里那一段写的是
 * 同一件事，本板块的文案因此只说「这一次等了多久」，不说「多久之内一定不会被砍断」。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n, copy } from "./ui.js";
import { readGatewayToken, writeGatewayToken, sendToGateway, streamFromGateway } from "./gw-api.js";
import { catalogModels } from "./pure/models.mjs";
import { credentialView } from "./pure/settings.mjs";
import { fmtDash } from "./pure/format.mjs";
import {
  playgroundProtocols, modelIdsForProtocol, buildRequest, tokenHintState, prettyJson, deltaText,
  mediaEndpoints, modelIdsForModality, mediaEmbeddable, mediaLinkable, mediaResultUrls,
  videoTaskIdOf, videoTaskIdSlotsText, buildPollRequest, videoPollNext, VIDEO_POLL_MAX_ATTEMPTS,
  trimTurns, PLAYGROUND_TURNS_MAX,
} from "./pure/playground.mjs";

/**
 * 三个模式档位。**写成一张本地表，因为它们是这个板块自己的 UI 状态，不是协议知识**
 * ——`chat` 走 `protocols[]`、另两档走 `media[]` 里 `modality` 与它相等的那些条目。
 * ⚠️ **`image` / `video` 这两个字符串同时是真源里 `modality` 的取值**，本文件因此
 * 与真源共享这两个词。它不归全局约束 15 管（那条管的是端点路径 / 请求体形状 / 协议名），
 * 但仍是一处会漂的耦合：真源改了形态名而这里没改，那一档会**变成一个永远没有可用端点
 * 的空档位**。
 * 由 `tests/ui/dom/playground-section.test.ts` 的
 * 「三个模式档都能选中，图片与视频各自真的挑到了自己那条端点 —— 形态名一漂就是一个永远空的档位」钉着。
 *
 * ⚠️ **漂了之后屏幕上到底是什么样，逐条数清楚**（上一版这里写的是「只显示一句
 * 『这个形态没有可用的端点』」，实测**没有这样一句话**，是一句假的描述）。
 * 下面三条是**把目录里两个 `modality` 全改名之后在 DOM 夹具里量出来的**，不是读代码推的：
 * · `buildMediaNote()` 的 `buildRequest(null, …)` 交出 `null` ⇒ 端点那一行**只剩标签，
 *   后面什么都没有**；
 * · `modelIdsForModality()` 交出空数组 ⇒ 模型下拉 0 个选项，下面多出一句
 *   `pg.model.noneMedia`「这个形态下没有可用的模型。」；
 * · `sendBlockedKey()` 走到 `pg.send.blockedNoEndpoint` ⇒ 发送按钮**变灰**，
 *   它的 tooltip 才是「协议目录里没有这个形态的端点，这一档发不出请求。」。
 * ⇒ **`pg.model.noneMedia` 与 `pg.send.blockedNoEndpoint` 这两个 key 不是死代码**：
 * 在**形态名不漂**的前提下它们确实取不到（`MODEL_CATALOG` 钉着 2 个 image + 1 个 video 模型、
 * `MEDIA_ENDPOINTS` 两档各有一条 `op === "generate"`，两者恒非空），
 * 但那个前提**正是这一段登记着会漂的东西** —— 它们是形态名漂移那一档的兜底文案，
 * 别把「结构性不可达」写成无条件的。
 * ⚠️ **这个前提本身也得有机器，两档都要**：模型条数由
 * `tests/ui/dom/playground-section.test.ts` 的
 * 「三个模式档都能选中，图片与视频各自真的挑到了自己那条端点 —— 形态名一漂就是一个永远空的档位」
 * 逐档钉着（image 2 / video 1）。原来只有 image 那一半有断言，**video 那一半是空的**
 *（P3e Task 18 回填补上）。⚠️ 顺带量清楚了：这句前提的两种漂法**不是一回事**——
 * 真源**多**一个视频模型 ⇒ 上面「1 个 video」这个数当场变假，由那一格逐档钉着；
 * 真源**少**掉那唯一一个视频模型 ⇒ 实测整份目录窄化不过、面板落进「读不出来」那一档，
 * 这一层由目录自己拦下，根本轮不到这段裁定。
 *
 * ⇒ **两个 key 的去留结案为「留」**（P3e Task 18；欠账清单 C4 那条同步改写）。
 * ⚠️ 上面那三条曾经是一份**不会自己红的清单**——写下它们的时候
 * `grep -rn "noneMedia\|blockedNoEndpoint" tests/` 零命中，按本仓的规矩那是待办不是守卫，
 * 而**这段话本身就是订正上一版一句假描述的产物**，第二次变假的代价更高。
 * 现在它们由 `tests/ui/dom/playground-section.test.ts` 的
 * 「端点行 0（真源为 1）、模型下拉 0 项（真源为 2）、发送按钮停用且两句文案逐字上屏」
 * 与同一个 describe 里 `tests/ui/dom/playground-section.test.ts` 的
 * 「反向控制（同格 describe）：真源原样时端点行 1、模型下拉 2 项」
 * 两格钉着：前者证明形态名一漂这两句真的上屏，后者证明真源原样时它们一句都不上屏。
 * ⚠️ **第二个锚前面那次路径重复不是笔误，别当冗余删掉**：`scripts/check-comment-refs.mjs`
 * 这道门禁只校验**紧跟在路径之后**的那个锚，外加 `CHAINED_ANCHOR_RE` 认得的那几个纯并列连接词
 *（`与` / `和` / `、` / `以及` / `及` / `+`，后面只许再跟 `的` / `那格` 这类连接字）。
 * 原来写的 `与同格的「…」` 里「同格」两个字不在那张连接词表上 ⇒ **这个锚一个字都没被查**
 *（实测：改掉它指向的那条 `it()` 名字，`node scripts/check-comment-refs.mjs` 仍 EXIT=0 并打绿横幅；
 * 改第一个锚当场 EXIT=1）。重复一次路径就让它变回"紧跟在路径之后"的第一个锚。
 * 这个洞本身在 `scripts/check-comment-refs.mjs` 的 `nameAnchorsAfter()` 上方逐字登记着，
 * **不是这里该顺手放宽的东西**——那张表收得窄是有意的，放宽一次就要开豁免名册。
 * ⚠️ **那两格守不到什么，也在那边逐条写着**：它们跑在 DOM 替身上，
 * 「按钮变灰之后点不动」验不到（本板块测试文件头登记的 `.disabled` 盲点），
 * 验到的只是 `disabled` 属性与 tooltip 的字面值；另外「端点那一行不画」这一条是**过定的**，
 * 单改这个文件里挑端点那一处打不红它。
 */
const MODES = [
  { mode: "chat", key: "pg.mode.chat" },
  { mode: "image", key: "pg.mode.image" },
  { mode: "video", key: "pg.mode.video" },
];

let nodes = null;
/**
 * 窄化之后的目录。`null` = **还没读到 / 读不出来**，两者在渲染上是同一档
 * （都还不知道这个网关认得哪些协议），区别只在「有没有人已经发过那次请求」。
 */
let catalog = null;
/** 设置页那把网关口令的末几位。`null` = 读不到，比不了（**不等于「对不上」**）。 */
let hint = null;
/** 已经问过一次 `GET /admin/api/config` 了吗。读不到 hint 不是错误，但也别每次切回来重问。 */
let hintAsked = false;
/** 当前选中的协议 id 与模型 id。**取值来自响应，不是本地枚举。** */
let protoId = "";
let modelId = "";
/** 输入框里的两样东西。**re-render 之后从这里回填**，所以整块重建不会丢用户输入。 */
let promptText = "";
let token = "";
/** 流式开关的当前档位（P3d Task 11）。**同样要在 re-render 之后回填。** */
let streamOn = false;
/**
 * 右栏那几轮对话。切走板块也留着（同一次会话里回头对比很常见）。
 *
 * ⚠️⚠️ **P3e Task 19 起它有上限了（`PLAYGROUND_TURNS_MAX`），这一段的历史版本
 * 别照着读**：这里曾经逐字写着「只进不出 / 没有上限 / **今天不加上限**」，
 * 当时给的理由是「加上限要么是一个需要新 UI 状态的『清空』按钮、要么是一条静默丢弃
 * 用户看得见的内容的规则，两条都比这个问题本身大；而每一轮都是运维自己按出来的，
 * 量级与他的手速同阶」。
 * **那个权衡在 P3d Task 12 之后就不成立了**：`turn.body` 从那时起可能是一张 MB 级的
 * base64 图，而单次整版重建的临时串量与轮数成正比（`onPayload` 那段 ⚠️⚠️ 实测：
 * 1 / 5 / 10 轮 = 3.0 / 15.0 / 30.0 MB）——**成本不再与手速同阶，与轮数同阶。**
 * ⇒ 本轮把当年那两条路**一起**走完，不是二选一：上限住在 `js/pure/playground.mjs`，
 * 「清空对话」就在右栏，而**被移除了几轮写在屏幕上**（`trimmedTurns` → `pg.conv.trimmed`）
 * ——静默截断正是当年被否掉的那一条，它今天照样是被否的。
 *
 * ⚠️ **P3d 那一轮只拿掉了放大它的 60 倍乘数，没有动无上界本身**
 *（P3d 全分支评审 F-2）：Task 12 给视频档加过一个**每拍都整版 `render()`** 的 60 拍循环，
 * 一次视频任务的重建量因此是 `60 × 全部轮次 × 每轮 body`（实测 `turns=10` ⇒ ≈ 1.8 GB）。
 * 处置是把那个乘数拿掉（`pollOnce()` 里那段 ⚠️⚠️；**就地改的那两处与整版重建输出逐字相同**，
 * 由那段末尾点名的第 ③ 格钉着——上一版这里写的是一句没有机器守的「输出逐字不变」，
 * 而它当时**是假的**，复评 M-4 实测证伪）⇒ 重建量回到 `每次运维自己按一下 × 全部轮次`。
 * **本轮封的是后一个因子。**
 *
 * ⚠️ **写入口只有 `pushTurn()` 与 `clearTurns()` 那两个**：绕过它们直接写 `turns`
 * 会绕过截断，而绕过之后屏幕上看起来完全正常——只是内存又变回无界的，
 * 且那句披露永远说 0 轮。
 * ⚠️⚠️ **这句话有机器守着，而它是变异实测逼出来的**：本文件有**四条** push 路径，
 * 而 DOM 那一族只走得到其中两条（另两条各自换回 `turns.push(...)` ⇒ 一格都不红）。
 * 覆盖那四条的是 `tests/ui/dom/playground-section.test.ts` 的
 * 「⑦ `turns` 的写只许出现在 pushTurn() / clearTurns() 与那句声明里（判据认得的四种写形态）—— 绕过它们的那条路径截断与披露都不会发生」，
 * 它扫的是源码形态，一次盖住四条以及将来的第五条。
 * ⚠️⚠️ **上一版这句话写成了「只有 `pushTurn()` 一个」而判据只扫 `turns.push(`**
 *（复评 F-1 / M-E 实测）：把 `failed()` 那条换成 `turns = turns.concat([turn])`
 * ⇒ **那一族 74/74 全绿**。**赋值形态不是想象出来的写法，这个文件自己就在用**
 *（`pushTurn()` 里的 `turns = kept;`、`clearTurns()` 里的 `turns = [];`）。
 * 判据已经扩成「认得出每一次写」，**它认不出哪些也在那一格里逐条登记着**。
 *
 * ⚠️⚠️ **登出不清它，下一个登录的人看得见上一个人的整段对话，如实登记（P3e 遗留）。**
 * `js/app.js` 的 `leave()` 只清存储与口令框；`turns`（含每一轮的提示词、状态码、
 * 响应体正文）与下面那个 `trimmedTurns` 都活过一次登出。
 * **为什么本轮不修，两条理由**：
 * ① **板块自己分辨不出登出与切板块**——两者走的是同一个 `onHide()`（板块契约今天是
 *    `{ init?, onShow?, onHide? }`）。在 `onHide()` 里清 = 切走再切回来对话就没了，
 *    那是运维每天都会踩到的倒退。要分辨就得给契约加一格，那是全站八个板块一起改的事。
 * ② **这不是本板块独有的形态，只清它一个反而更糟**：`js/sec-keys.js` 的 `data`
 *    是整张 Key 列表、`js/sec-usage.js` 的 `data` / `detailData`、`js/sec-events.js`
 *    的 `view`、`js/sec-registrar.js` 与 `js/sec-settings.js` 的 `data` 同样活过登出，
 *    而其中第一份比一段对话正文敏感得多。「登出清干净」要么全站成立，要么就别声称。
 * ⇒ 射程是**全站**、不是本板块，登记为 P3e 收尾待办。
 * **这条登记本身有红线**（不然它会在被修掉的那天悄悄变成假话）：
 * `tests/ui/dom/playground-section.test.ts` 的
 * 「⑧ 登出再登录：上一个人的那几轮原样还在右栏 —— 今天的形态，清干净的那天这一格会红」
 * 钉着今天的行为，那一格的报文会把人指回这一段。
 * ⚠️ **同一个文件里那把网关口令是这条的反例，别读混**：它活过登出这件事**已经修掉了**
 *（`onShow()` 里每次重读存储，理由见那段 ⚠️⚠️）——因为它有存储那一头可清，
 * 而 `turns` 从头到尾只活在内存里，没有第二处可以做文章。
 */
let turns = [];
/**
 * **累计被截断掉几轮**（`trimTurns()` 每次报的那个 `removed` 加起来）。
 *
 * 它是屏幕上那句披露唯一的数据源。**纯函数那一侧刻意不累计**：那个目录下的模块按定义
 * 没有状态，而且「清空对话」要把这个数连同 `turns` 一起归零——一个 0 轮的对话右栏
 * 还挂着「已经移除了 3 轮」，那 3 轮并不是从这个空对话里移除的（全局约束 9 的同型）。
 *
 * ⚠️ **它跟着 `turns` 一起活过登出**：下一个登录的人会连带看到那句
 * 「最旧的 N 轮已经从这里移除」，而那 N 轮是上一个人的。理由、代价与那条待办的射程，
 * 全文在 `turns` 上方那段登记里，别在这里再写一份会漂的副本。
 */
let trimmedTurns = 0;
/** 这一刻有没有一次对外请求在飞。它就是那道「在飞去重」。 */
let inFlight = false;
/**
 * 在飞那一轮的**流式** turn（非流式恒为 `null`）。
 * 存在的唯一理由是 `cancelInFlight()` 要够得着它把 `pending` 收干净 —— 理由全文在那里。
 */
let streamingTurn = null;
/**
 * 在飞那一次的取消器，**同时是「这一次还是不是当前那一次」的判据**。
 * 见文件头那段 ⚠️⚠️：abort 本身在测试里不可观测，被钉住的是这个身份比较。
 */
let current = null;
/**
 * 目录那条读的在飞标记、世代号与**取消器**（与 `js/sec-models.js` 同一套，理由见那里）。
 *
 * ⚠️⚠️ **`loadAbort` 是 P3d 全分支评审 F-4 补的，补之前这里是全面板唯一一个读不可中止的板块。**
 * 另外六个板块级读（keys / events / overview / models / registrar / usage）**全部**带
 * `AbortController` + `{ signal }`，而 `api.js` 的 `raw()` 本来就把 `init.signal` 透给 `fetch`
 * ⇒ **不是能力缺失，是这一处少写了一半**。同一个文件里 `sendOnce()` 用的就是这套写法。
 * ⚠️ **这一族天然不可测**：`tests/ui/dom/harness.ts` 的 fetch 替身**不看 `signal`**
 *（账本已登记），⇒ 「六个板块 abort 了」与「Playground 没 abort」在机器上长得一模一样。
 * 所以这一处的判据只能是**与另外六处写法一致**，不是某一格用例。
 */
let loadInFlight = false;
let loadSeq = 0;
let loadAbort = null;
/** 面板自己所在的那个源。`init()` 时读一次——**判定在纯函数里，那里拿不到浏览器全局**。 */
let origin = "";
/** 当前模式档位（`chat` / `image` / `video`）。**换档要重挑模型**，与换协议同一条理由。 */
let mode = "chat";
/**
 * 正在轮询的那一轮视频（`null` = 没有在轮）。
 *
 * ⚠️ **它与 `current` 是两件事，缺一不可**：`current` 回答「这一次还是不是当前那一次」
 * （身份比较，与非流式 / 流式共用同一条判据），这一格回答「该往哪一轮里写轮询结果」。
 * 合成一个的话，取消之后要么够不着那一轮把 `pending` 收干净（流式那一档栽过一次，
 * 见 `cancelInFlight()` 里那段 ⚠️⚠️），要么身份判据被一个可空的业务对象顶替。
 */
let pollTurn = null;
/** 轮询那一轮的取消令牌。**与 `current` 是同一个对象**，留一份只为在回调里做身份比较。 */
let pollCtl = null;
/** 定时器句柄与这一轮开始的时刻（时长上限那一条按它算）。 */
let pollTimer = null;
let pollStartedAt = 0;

/** 一个内容块：标题 + 空的 body 容器。 */
function block(titleKey) {
  const wrap = el("div", { class: "card block" });
  wrap.appendChild(elI18n("h3", titleKey));
  const body = el("div");
  wrap.appendChild(body);
  return { wrap, body };
}

/** 一行「标签 + 控件」。 */
function field(labelKey, control) {
  const wrap = el("div", { class: "pg-field" });
  wrap.appendChild(elI18n("span", labelKey, { class: "muted" }));
  wrap.appendChild(control);
  return wrap;
}

/**
 * 模式分段：对话 / 图片 / 视频。**三档都接上了**（P3d Task 12）。
 * ⚠️ 三个 key 写成三个字面量（`MODES` 那张表里），**不许把档位名拼进 key**（全局约束 12）。
 */
function buildModeBar() {
  const bar = el("div", { class: "btn-group" });
  bar.appendChild(elI18n("span", "pg.mode.label", { class: "muted" }));
  for (const m of MODES) {
    const btn = elI18n("button", m.key, {
      type: "button", class: "btn-toggle", "data-mode": m.mode,
      "aria-pressed": m.mode === mode ? "true" : "false",
    });
    btn.classList.toggle("active", m.mode === mode);
    btn.addEventListener("click", () => {
      if (mode === m.mode) return;
      mode = m.mode;
      // 换档要重挑模型：对话模型与媒体模型是两批完全不相交的 id
      //（媒体模型的 `protocols` 在真源里是空数组）。
      modelId = "";
      render();
    });
    bar.appendChild(btn);
  }
  return bar;
}

/**
 * 协议分段。**档位由响应里的 `protocols[]` 生成，本文件不认识任何一个协议 id。**
 * 展示名走响应里的 `label`（协议的专名，**刻意不进 i18n**，理由见
 * `src/core/admin/protocol-catalog.ts` 里 label 字段上方那一行）。
 */
function buildProtoBar() {
  const bar = el("div", { class: "btn-group" });
  bar.appendChild(elI18n("span", "pg.proto.label", { class: "muted" }));
  for (const p of catalog.protocols) {
    const btn = el("button", {
      type: "button", class: "btn-toggle", "data-protocol": p.id,
      "aria-pressed": p.id === protoId ? "true" : "false",
    }, p.label);
    btn.classList.toggle("active", p.id === protoId);
    btn.addEventListener("click", () => {
      if (protoId === p.id) return;
      protoId = p.id;
      // 换协议要重挑模型：上一条协议上可用的模型未必在这一条上也可用。
      modelId = "";
      render();
    });
    bar.appendChild(btn);
  }
  return bar;
}

/**
 * 媒体档里替掉协议分段的那一行：**这一档按一下会打哪条端点**。
 *
 * ⚠️ **地址是 `buildRequest()` 现拼出来的那一条，不是这里另拼一份**（全局约束 15）：
 * 另拼一份的话，屏幕上写着的那条与真发出去的那条可以不一样，而那正是本期核心设计
 * 决定要防的形态。构造不出来（目录与面板对不上）时这一行整个不画——画一条空地址
 * 比不画更糟。
 */
function buildMediaNote() {
  const wrap = el("div", { class: "pg-field pg-media-note" });
  wrap.appendChild(elI18n("span", "pg.media.endpoint", { class: "muted" }));
  const req = buildRequest(currentMediaEndpoint(), {
    model: modelId, prompt: promptText, stream: false, origin,
  });
  if (req !== null) {
    wrap.appendChild(el("span", { class: "mono pg-media-endpoint" }, `${req.method} ${req.url}`));
  }
  return wrap;
}

/** 当前选中的那条协议，没有就是 `null`。**只在对话档有意义。** */
function currentProto() {
  if (catalog === null) return null;
  for (const p of catalog.protocols) if (p.id === protoId) return p;
  return null;
}

/** 当前媒体档要打的那条**生成**端点，没有就是 `null`。 */
function currentMediaEndpoint() {
  if (catalog === null) return null;
  for (const m of catalog.media) if (m.modality === mode && m.op === "generate") return m;
  return null;
}

/** 视频那条**轮询**端点，没有就是 `null`。 */
function pollEndpoint() {
  if (catalog === null) return null;
  for (const m of catalog.media) if (m.modality === "video" && m.op === "poll") return m;
  return null;
}

/**
 * 这一档要打的那条端点（对话 = 选中的协议；媒体 = 那条生成端点）。
 * **`buildRequest()` 对两者一视同仁**——它只看 `pathTemplate` / `method` / `authHeader` /
 * `sampleBody` / `samplePrompt` 这几格，而媒体端点在真源里就是照着同一组字段填的。
 * ⇒ **本板块因此没有第二条请求构造路径**（全局约束 15 的同一条理由）。
 */
function currentTarget() {
  return mode === "chat" ? currentProto() : currentMediaEndpoint();
}

/** 这一档下可用的模型 id。**两根轴，两个纯函数**，理由见 `modelIdsForModality()` 上方。 */
function currentModelIds() {
  if (catalog === null) return [];
  return mode === "chat"
    ? modelIdsForProtocol(currentProto(), catalog.models)
    : modelIdsForModality(mode, catalog.models);
}

/**
 * 模型下拉。**只列这一档上真的可用的模型**（判定在 `js/pure/playground.mjs`）。
 * 一个都没有时下拉是空的，而下面那句提示会说清是哪一档。
 */
function buildModelSelect(ids) {
  const sel = el("select", { class: "pg-model" });
  for (const id of ids) {
    const opt = el("option", { value: id }, id);
    sel.appendChild(opt);
  }
  // **显式回写 `.value`**：整块每次重建，不写的话选中项会掉回第一项。
  sel.value = modelId;
  sel.disabled = ids.length === 0;
  sel.addEventListener("change", () => { modelId = sel.value; });
  return sel;
}

/**
 * 流式开关（P3d Task 11 接上）。
 *
 * ⚠️ **`.checked` 每次重建都要显式回写**：整块 re-render 之后不写的话，运维打开的
 * 那一档会静默地掉回关闭，而**下一次发送就是一次非流式请求**——请求照样 200、
 * 内容照样对，只是一次性全回来，面板上没有任何东西会提到这件事
 * （与 `buildModelSelect()` 里那句 `sel.value = modelId` 同一条理由）。
 */
function buildStreamToggle() {
  const box = el("input", { type: "checkbox", class: "pg-stream" });
  box.setAttribute("title", t("pg.stream.tip"));
  box.checked = streamOn;
  box.addEventListener("change", () => { streamOn = box.checked === true; });
  return box;
}

/** 口令与 hint 对不对得上那一句。**只画档位名，不含口令的任何一个字节。** */
function hintNoteKey() {
  const state = tokenHintState(token, hint);
  if (state === "empty") return "pg.token.stateEmpty";
  if (state === "unknown") return "pg.token.stateUnknown";
  if (state === "match") return "pg.token.stateMatch";
  return "pg.token.stateMismatch";
}

/** 那一句的样式档。三档颜色不同，**同时靠文字表达**（不只靠颜色）。 */
function hintNoteClass() {
  const state = tokenHintState(token, hint);
  if (state === "match") return "pg-hint pg-hint-ok";
  if (state === "mismatch") return "pg-hint pg-hint-bad";
  return "pg-hint muted";
}

/** 把那一句就地刷一遍。**不整块重画**——重画会让口令输入框丢焦点。 */
function syncHintNote() {
  if (nodes === null || nodes.hintNote === null) return;
  nodes.hintNote.textContent = t(hintNoteKey());
  nodes.hintNote.setAttribute("class", hintNoteClass());
}

/**
 * 网关口令输入框。
 *
 * ⚠️ **`type="password"`**：这把口令是发给每一个下游用户的那把中转口令，
 * 让它明晃晃地留在一块可能被投屏 / 被同事看一眼的屏幕上没有任何好处。
 * ⚠️ **`autocomplete="off"`**：别让浏览器把它和管理口令混进同一个密码条目。
 */
function buildTokenInput() {
  const input = el("input", {
    type: "password", class: "pg-token", autocomplete: "off",
    "data-i18n-ph": "pg.token.placeholder",
  });
  input.setAttribute("placeholder", t("pg.token.placeholder"));
  input.value = token;
  input.addEventListener("input", () => {
    token = input.value;
    // 存 localStorage（全局约束 11(b)：手动粘贴 + 本地保存，后端不回显）。
    writeGatewayToken(token);
    syncHintNote();
    syncSendButton();
  });
  return input;
}

/** 提示词输入框。 */
function buildPromptInput() {
  const area = el("textarea", { class: "pg-prompt", rows: "4", "data-i18n-ph": "pg.prompt.placeholder" });
  area.setAttribute("placeholder", t("pg.prompt.placeholder"));
  area.value = promptText;
  area.addEventListener("input", () => { promptText = area.value; syncSendButton(); });
  return area;
}

/** 这一刻能不能按发送；不能的话是哪一档（`null` = 能按）。 */
function sendBlockedKey() {
  if (inFlight) return "pg.send.blockedInFlight";
  // **两档说的不是同一句话**：对话档缺的是「还没选协议」（选得回来），
  // 媒体档缺的是「目录里根本没有这个形态的端点」（选不回来，是版本对不上）。
  // 折叠成一句会让运维在媒体档下去找一个屏幕上根本不存在的协议选择器。
  if (mode === "chat") {
    if (currentProto() === null) return "pg.send.blockedNoProto";
  } else if (currentMediaEndpoint() === null) {
    return "pg.send.blockedNoEndpoint";
  }
  if (modelId === "") return "pg.send.blockedNoModel";
  if (token === "") return "pg.send.blockedNoToken";
  if (promptText.trim() === "") return "pg.send.blockedNoPrompt";
  return null;
}

/**
 * 发送按钮的可用性与 tooltip 就地刷一遍（同 `syncHintNote`，不整块重画）。
 *
 * ⚠️⚠️ **视频档的那句话不能与另两档共用，这是评审 M2 抓到的一句假话。**
 * `pg.send.ready` 五语言逐字都写着「按一下会真的向上游发**一次**请求」
 * （en `one request` / ja `1 回` / ko `한 번`）——**而视频档一次点击是
 * 1 次建任务 + 最多 `VIDEO_POLL_MAX_ATTEMPTS` 次轮询。**
 * 这是全局约束 14「按钮与护栏一起交付」的**披露那一半**：护栏（在飞去重、两条上限、
 * 藏起来暂停、切走即停）我都做了，**而运维在按下之前唯一看得到的那句话没跟着改**。
 * ⚠️ **次数从常量插值进去，不写死在字典里**：写死的话改常量就会让那句话变成假话，
 * 而字典没有任何机器在守（W4b）。
 * 由 `tests/ui/dom/playground-section.test.ts` 的
 * 「视频档按下之前那句话说的是 1 + 60 次，不是「一次」 —— 它是运维唯一看得到代价的地方（评审 M2）」钉着。
 */
function syncSendButton() {
  if (nodes === null || nodes.send === null) return;
  const blocked = sendBlockedKey();
  nodes.send.disabled = blocked !== null;
  if (blocked !== null) {
    nodes.send.setAttribute("title", t(blocked));
    return;
  }
  nodes.send.setAttribute("title", mode === "video"
    ? t("pg.send.readyVideo", { count: String(VIDEO_POLL_MAX_ATTEMPTS) })
    : t("pg.send.ready"));
}

/**
 * 左栏。
 *
 * ⚠️ **协议用分段按钮而不是 `<input type="radio">`**：其余三个板块的同类控件
 * （事件级别、用量口径、模型筛选）都是这一套 `.btn-group` / `.btn-toggle`，
 * 各写一套迟早长得不一样。另有一条实测理由：`tests/helpers/fake-dom.ts` 没有
 * 单选组语义（`.checked` 只是元素上的一个普通字段），用 radio 的话「四选一」这件事
 * 会变成**只有真实浏览器才验得到**的行为（第 9 种假阳性）。
 */
function buildLeft() {
  const { wrap, body } = block("pg.req.title");
  body.appendChild(buildModeBar());

  // ⚠️ **默认模型必须在这里定下来，不能留在 `buildModelSelect()` 里**：媒体档那一行
  //    「这一档打的端点」是 `buildRequest()` 现拼的，而 `buildRequest()` 在模型为空时
  //    交出 `null` ⇒ 定得比它晚的话，那一行**永远不出现**，而屏幕上看起来只是
  //    「这一档没有端点」——一个纯粹由渲染顺序造成的假象。
  const ids = currentModelIds();
  if (modelId === "" && ids.length > 0) modelId = ids[0];

  // **协议分段只在对话档出现**：媒体那两条端点不属于任何一条对话协议
  //（真源里它们的模型 `protocols` 是空数组），摆一排选不动的协议按钮只会让人以为
  // 图片也能挑协议。媒体档换成一行「这一档打的是哪条端点」的说明。
  if (mode === "chat") {
    body.appendChild(buildProtoBar());
  } else {
    body.appendChild(buildMediaNote());
  }

  body.appendChild(field("pg.model.label", buildModelSelect(ids)));
  if (ids.length === 0) {
    body.appendChild(elI18n("p", mode === "chat" ? "pg.model.none" : "pg.model.noneMedia",
      { class: "muted note" }));
  }
  // **流式开关只在对话档出现**：媒体那两条端点没有流式形态（真源里它们连
  // `streamMode` 这一格都没有）。留一个按不动的开关会让人以为图片也能流式。
  if (mode === "chat") body.appendChild(field("pg.stream.label", buildStreamToggle()));

  const tokenInput = buildTokenInput();
  body.appendChild(field("pg.token.label", tokenInput));
  const note = el("span", { class: hintNoteClass() }, t(hintNoteKey()));
  nodes.hintNote = note;
  body.appendChild(note);
  body.appendChild(elI18n("p", "pg.token.note", { class: "muted note" }));

  body.appendChild(field("pg.prompt.label", buildPromptInput()));

  const bar = el("div", { class: "toolbar" });
  const send = elI18n("button", "pg.send", { type: "button", class: "pg-send" });
  send.addEventListener("click", () => { sendOnce(); });
  nodes.send = send;
  bar.appendChild(send);
  if (inFlight) {
    const cancel = elI18n("button", "pg.cancel", { type: "button", class: "pg-cancel" });
    cancel.addEventListener("click", () => { cancelInFlight(); render(); });
    bar.appendChild(cancel);
    bar.appendChild(elI18n("span", "pg.sending", { class: "muted pg-sending" }));
  }
  body.appendChild(bar);
  syncSendButton();
  return wrap;
}

/**
 * 一条媒体结果地址那一行：**地址原文 + 复制按钮 +（可链接就）在新标签页打开**。
 *
 * ⚠️⚠️ **`rel="noopener noreferrer"` 是显式写的，不是靠浏览器补**（评审 I9）：
 * `target="_blank"` 的 a 元素现代浏览器确实会隐式补 `noopener`，但那是**浏览器的默认值、
 * 不是这段代码的性质**——一个 `rel="opener"` 的改动、一台老浏览器、或者哪天有人把这里
 * 换成 `window.open()`（它从来不补），三条路径都会让被打开的那一页拿到
 * `opener` 引用，而**这一页的 origin 上存着 `ADMIN_TOKEN`**。
 * `noreferrer` 是另一件事：不把面板自己的地址（含路径）泄给上游给的那个主机。
 *
 * ⚠️ **只有 `mediaEmbeddable()` 为真的那一种才画 img**，判定在纯函数里、不在这里目测。
 * 远端地址一律不内嵌——CSP 的 img-src 里没有任何远端主机，画出来只会是一张永远
 * 加载失败的破图，而那比不画更让人以为「结果坏了」。
 */
function buildMediaRow(url) {
  const row = el("div", { class: "pg-media-row" });
  row.appendChild(el("span", { class: "mono pg-media-url" }, url));
  const btn = elI18n("button", "pg.media.copy", { type: "button", class: "pg-media-copy" });
  btn.addEventListener("click", () => { copy(url); });
  row.appendChild(btn);
  if (mediaLinkable(url)) {
    row.appendChild(elI18n("a", "pg.media.open", {
      class: "pg-media-open", href: url, target: "_blank", rel: "noopener noreferrer",
    }));
  }
  if (mediaEmbeddable(url)) {
    row.appendChild(el("img", { class: "pg-media-img", src: url, alt: t("pg.media.alt") }));
  }
  return row;
}

/**
 * 媒体那一轮的结果区。**四种出口，互斥且都说得出自己是哪一档**：
 * ① 有地址 ⇒ 逐条列出来（不替运维挑哪条是成片，理由见 `mediaResultUrls()`）；
 * ② 没地址、而且响应根本不是 JSON ⇒ **上游这次回的是字节流**，如实说它是什么类型；
 * ③ 没地址、响应是 JSON ⇒ 「这次的响应里没有出现任何一条地址」；
 * ④ 出错 ⇒ 错误档位名。
 *
 * ⚠️ **②与③必须分开**（全局约束 9 的同型）：`src/http/routes/media.ts` 的文件头写着
 * 「上游返回什么（地址或字节流）就原样转发」——**两种都可能，而且都不是异常**。
 * 折叠成一句「没有结果」的话，字节流那一档会被读成「这次生成失败了」，
 * 而它其实成功了、只是结果是一段字节而面板按 CSP 不内嵌它。
 *
 * ⚠️ **响应原文照旧摆出来**（与非流式对话档同一条）：它是这个调试工具最有用的东西，
 * 而且**它不会说假话**——上面那四档里任何一档判错了，原文都摆在下面可以自己看。
 */
function buildMediaResult(turn) {
  const box = el("div", { class: "pg-media" });
  // **正在轮的那一轮，把盒子本身记下来**：轮询的每一拍只重填**这一个盒子**，
  // 不整版 `render()`。理由与实测数字在 `pollOnce()` 里那段 ⚠️⚠️。
  if (turn === pollTurn) nodes.pollBox = box;
  fillMediaResult(box, turn);
  return box;
}

/**
 * 把媒体那一轮的内容填进 `box`。**`buildMediaResult()` 与轮询那一拍共用这一份**
 * ——两处各写一遍的话，轮询期间屏幕上那一格与重画之后那一格会是两套渲染判据，
 * 而它们之间的差别只在真机上看得见（本仓已登记过同型：两份实现分叉时绿的那份会赢）。
 */
function fillMediaResult(box, turn) {
  if (turn.errorKey !== null) {
    box.appendChild(elI18n("p", turn.errorKey, { class: "danger-text pg-error" }));
  }
  const urls = mediaResultUrls(turn.body);
  for (const u of urls) box.appendChild(buildMediaRow(u));
  if (urls.length === 0 && turn.errorKey === null) {
    // **判据是响应头，不是猜**（`js/gw-api.js` 的 `sendToGateway()` 把它带回来了）。
    if (turn.body === null && !/^application\/json/i.test(turn.contentType)) {
      box.appendChild(el("p", { class: "muted note pg-media-bytes" },
        t("pg.media.bytes", { type: fmtDash(turn.contentType === "" ? null : turn.contentType) })));
    } else if (turn.status !== null) {
      box.appendChild(elI18n("p", "pg.media.none", { class: "muted note pg-media-none" }));
    }
  }
  // ── 视频两段式的进度 ────────────────────────────────────────────────────
  if (turn.taskId !== null) {
    const row = el("div", { class: "pg-media-row pg-task" });
    row.appendChild(elI18n("span", "pg.media.taskId", { class: "muted" }));
    row.appendChild(el("span", { class: "mono pg-task-id" }, turn.taskId));
    const btn = elI18n("button", "pg.media.copy", { type: "button", class: "pg-task-copy" });
    btn.addEventListener("click", () => { copy(turn.taskId); });
    row.appendChild(btn);
    box.appendChild(row);
  }
  if (turn.pollState === "polling") {
    box.appendChild(el("p", { class: "muted note pg-poll" },
      t("pg.media.polling", { count: String(turn.pollAttempt) })));
  }
  if (turn.pollState === "gaveUp") {
    // **到点了要说出来，并且把标识摆着**：静默停下留下的是一个永远「进行中」的框。
    box.appendChild(elI18n("p", "pg.media.pollGaveUp", { class: "muted note pg-poll-gaveup" }));
  }
  if (turn.pollState === "noTaskId") {
    // ⚠️ **这句话带 `{slots}` 插值，所以走 `t()` + `el()`，不走 `elI18n()` 那条裸标签路径**：
    // 那条路挂 `data-i18n`，而 `apply()` 走的是**不带参数**的 `t()`，屏幕上会出现裸的占位符。
    // 写法与上面那句 `pg.media.polling` 同型。
    //
    // ⚠️⚠️ **别指望 i18n 门禁第 ⑧ 条替你拦这一族**——它的判据是「key 的字符串字面量后面
    // 紧不紧跟着一个逗号」，而 `elI18n` 里 key 是第二个参数、后面本来就跟着逗号。
    // **P3e Task 21 变异实测**：把下面这两行换回 `elI18n` 那条写法 ⇒ 那道门禁 **exit 0**。
    // 同一条边界 `pg.conv.trimmed` 上方那段已经量过一遍，那道门禁自己的文件头也登记着。
    // ⇒ 这条写法真正的红线是 `tests/ui/dom/playground-section.test.ts` 的
    // 「建任务的响应里没有任务标识时一次都不轮，并且明说是哪一档」那一格：
    // 它把屏幕上这句话与字典那句话逐字比对，占位符漏出来当场红。
    //
    // ⚠️ **那几格从 `videoTaskIdSlotsText()` 现渲染，不在字典里手抄一份**：
    // 手抄的那份会在下一次有人往槽表里加一格时静静变假。
    box.appendChild(el("p", { class: "muted note pg-no-task" },
      t("pg.media.noTaskId", { slots: videoTaskIdSlotsText() })));
  }
  if (turn.cancelled === true) {
    box.appendChild(elI18n("p", "pg.turn.cancelled", { class: "muted note pg-cancelled" }));
  }
  const text = turn.body === null ? null : prettyJson(turn.body);
  if (text !== null) box.appendChild(el("pre", { class: "mono pg-body" }, text));
}

/**
 * 一轮对话。**上行只画运维自己输入的那句话与这次打的地址，绝不画请求头**
 * ——请求头里正是那把网关口令（全局约束 11(b)）。
 */
function buildTurn(turn) {
  const wrap = el("div", { class: "pg-turn" });
  fillTurn(wrap, turn);
  return wrap;
}

/**
 * 把一轮的内容填进 `wrap`。**`buildTurn()` 与流式那一拍「把掉了几块那一行补出来」
 * 共用这一份**——理由与 `fillMediaResult()` 上面那段逐字同型：两处各写一遍的话，
 * 在途那一拍与重画之后就是两套渲染判据，而它们之间的差别只在真机上看得见。
 */
function fillTurn(wrap, turn) {
  const head = el("div", { class: "pg-turn-head" });
  head.appendChild(elI18n("span", "pg.turn.you", { class: "muted" }));
  // 地址那一格只在**这次真的构造出了一条请求**时才画：构造失败那一档 `url` 是空串，
  // 画出来会是一条看着像地址的空壳，而那次请求根本没有地址可言。
  if (turn.url !== "") {
    head.appendChild(el("span", { class: "mono pg-endpoint" }, `${turn.method} ${turn.url}`));
  }
  wrap.appendChild(head);
  wrap.appendChild(el("p", { class: "pg-turn-prompt" }, turn.promptText));

  const foot = el("div", { class: "pg-turn-head" });
  foot.appendChild(elI18n("span", "pg.turn.gateway", { class: "muted" }));
  if (turn.status !== null) {
    const status = el("span", { class: "mono pg-status" }, String(turn.status));
    // **正在轮的那一轮，把这一格也记下来**（与下面 `buildMediaResult()` 记盒子同一条理由）。
    // ⚠️⚠️ **它画在这里，不在那个媒体盒子里**，而 `pollOnce()` 每一拍都改写 `turn.status`。
    //    上一版只记了盒子 ⇒ 轮询回 500 时屏幕上这一格还停在上一拍那个 200，
    //    旁边就贴着 `{"error":…}` 的响应原文——**两句话互相矛盾，而前一句是编的**
    //    （复评 M-4 逐节点 diff 实测；同型纪律见下面流式那一档的 ⚠️）。
    if (turn === pollTurn) nodes.pollStatus = status;
    foot.appendChild(status);
  }
  wrap.appendChild(foot);

  // ── 媒体那一轮：**只画地址，不内嵌远端任何东西**（全局约束 17）─────────────────
  // 它比错误分支更早，因为媒体那一档**出错时也还有话要说**（任务标识、轮询进度），
  // 而下面那条错误分支是直接 `return` 的，走到它就什么都不剩了。
  if (turn.mode !== "chat") {
    wrap.appendChild(buildMediaResult(turn));
    return;
  }

  // ── 流式那一轮：画拼起来的正文，**不画响应原文**（它没有「原文」可画）──────────
  // ⚠️ **顺序是刻意的**：正文在最上面。这一轮就算最后失败了，运维已经看到的那半句话
  //    是真的发生过的，把它挪到错误提示下面（或者抹掉）都会让人以为它没到过。
  if (turn.stream === true && turn.streamed === true) {
    const body = el("pre", { class: "mono pg-body pg-stream-text" }, turn.text);
    // 这一轮还在收的话，把这个节点记下来：后续每一块**就地改 textContent**，
    // 不整块重画（重画会让左栏的输入框丢焦点，而流式一秒能来几十块）。
    if (turn.pending === true) {
      nodes.streamText = body;
      // **这一轮的外框也记下来，就在这一行旁边**（两句同一个条件，不许分开写：
      // `onPayload` 那一档靠「`streamText` 非 null ⟺ `streamTurn` 非 null」这条不变量）。
      // 用处：坏块**第一次**出现那一拍，那一行还不存在，得把它补出来，而
      // 「它插在哪一行之前」是这个函数的判据 ⇒ 那一拍**重填这一个框**
      //（`fillTurn()`，与整版重画共用的同一份判据），不是整版 `render()`。
      // 理由与实测数字见 `onPayload` 里那段 ⚠️⚠️。
      nodes.streamTurn = wrap;
    }
    wrap.appendChild(body);
    // **「这条流一个字都没有」是一句关于「它读完了」的话，四个前提缺一不可**（评审 F1/F3）：
    // · `pending` 期间不许说 —— 那时候它只是**还没到**（说话的是 pg.sending）；
    // · 出错那一档不许说 —— 那条流**根本没开起来 / 没读完**，说「读完了」是假话。
    //   ⚠️ 这一条是评审实测抓到的：漏掉它，断网那一轮会**同时**画出
    //   「这条流读完了，但里面一个字的正文都没有」与「这次请求没有拿到任何响应」，
    //   **两句话互相矛盾，而前一句是编的**；
    // · 取消那一档不许说 —— 同上，是运维自己把它掐了，不是它读完了。
    if (turn.text === "" && turn.pending !== true && turn.errorKey === null && turn.cancelled !== true) {
      wrap.appendChild(elI18n("p", "pg.turn.streamEmpty", { class: "muted note pg-stream-empty" }));
    }
    if (turn.cancelled === true) {
      // **取消要说出来**：一个空白框 + 一句「本面板在流式这一档不读 token 用量」什么都没解释。
      wrap.appendChild(elI18n("p", "pg.turn.cancelled", { class: "muted note pg-cancelled" }));
    }
    if (turn.malformed > 0) {
      // **静默丢弃就是撒谎**（与事件板块的 malformed 同一条理由）：读不出来的块数
      // 必须说出来，不然面板会把一段缺字的回答当成完整的回答画出去。
      const note = el("p", { class: "muted note pg-malformed" },
        t("pg.turn.malformed", { count: String(turn.malformed) }));
      // **还在收的那一轮，把这一格也记下来**（与上面 `nodes.streamText` 同一条理由，
      // 也与轮询那一档的 `nodes.pollStatus` 同一套写法与生命周期）。
      // ⚠️⚠️ **它画在那个 `<pre>` 外面**，而 `onPayload` 每来一块读不出来的数据都改
      //    `turn.malformed` ⇒ 只就地改 `<pre>` 的 `textContent` **够不着这一格**。
      //    上一版正是如此：流式在途期间屏幕上一个字都不提「掉了几块」，
      //    **把一段缺字的回答当成完整的回答画着**，直到流结束那一次整版 `render()` 才补上
      //    （复评 G2 实测：在途 `.pg-malformed` 0 / 强制重建 1）——
      //    而上面那句「静默丢弃就是撒谎」正是本文件自己写的。
      //    机理与 `.pg-status` 那一次逐字同型：**就地更新的那个节点之外，
      //    还有一份会变的状态被渲染在别处。**
      if (turn.pending === true) nodes.streamMalformed = note;
      wrap.appendChild(note);
    }
    if (turn.errorKey !== null) {
      wrap.appendChild(elI18n("p", turn.errorKey, { class: "danger-text pg-error" }));
    }
    // ⚠️ 这一句不是可有可无的客套话，理由见文件头「流式那一轮为什么不显示 token 用量」。
    wrap.appendChild(elI18n("p", "pg.turn.noTokens", { class: "muted note pg-no-tokens" }));
    return;
  }

  if (turn.errorKey !== null) {
    wrap.appendChild(elI18n("p", turn.errorKey, { class: "danger-text pg-error" }));
    return;
  }
  const text = prettyJson(turn.body);
  if (text === null) {
    // 读不出来 ≠ 空响应（全局约束 9 的同型）。
    wrap.appendChild(elI18n("p", "pg.turn.unreadable", { class: "muted note pg-unreadable" }));
    return;
  }
  wrap.appendChild(el("pre", { class: "mono pg-body" }, text));
}

/**
 * 记一轮进右栏。**`turns` 只有两个写入口，这是往里加的那一个**
 *（另一个是下面清空的 `clearTurns()`；理由见 `turns` 上面那段里「写入口」那一条）。
 *
 * ⚠️⚠️ **截断与「被移除了几轮」是同一件事的两半，所以它们在同一个函数里。**
 * 拆开的话，四条 push 路径里漏掉后一半的那一条就变成了**静默截断**，
 * 而屏幕上分辨不出来：少掉的正是最旧的那几轮，运维本来就不盯着它们。
 * 「静默丢弃用户看得见的内容就是撒谎」是 `buildTurn()` 自己写下的那句话。
 */
function pushTurn(turn) {
  turns.push(turn);
  const { kept, removed } = trimTurns(turns);
  if (removed === 0) return;
  turns = kept;
  trimmedTurns += removed;
}

/**
 * 「清空对话」。**显式动作，不是自动行为**——静默截断那条路当年就被否掉了。
 *
 * ⚠️⚠️ **在飞时一个字都不动，这句早退是护栏不是客套**：`turns` 里那一轮只要
 * `pending === true`，流式那条路的 `onPayload` 与轮询那条路的 `pollOnce()` 都还握着
 * 它的引用。清掉之后它们照写不误，而那个对象已经不在 `turns` 里
 * ⇒ **后半段回答写进一个没人看得见的对象**——正是 `render()` 里那五句节点作废在防的
 * 那件事，只是换了一条搬运路径。
 * ⇒ 在飞时这颗按钮是灰的，而旁边左栏就摆着「取消这一次」：先取消，再清空。
 * ⚠️ **`disabled` 在测试里挡不住点击**（`tests/helpers/fake-dom.ts` 的登记盲点之一，
 * 见 `tests/ui/dom/playground-section.test.ts` 文件头那段替身能力核对）
 * ⇒ 真正起作用的是这里这句早退，按钮的灰只是给人看的那一半。两者由
 * `tests/ui/dom/playground-section.test.ts` 的
 * 「⑥ 在飞时按「清空对话」：一轮都不许清掉 —— 清掉正在收的那一轮就是把后半段写进没人看得见的对象」
 * 一格分开钉着。
 *
 * ⚠️⚠️ **累计被移除的轮数跟着归零**，理由见 `trimmedTurns` 上面那段。
 * **这一句差点没有红线**：0 轮时 `buildRight()` 在披露那一句之前就早退了，
 * 所以「归没归零」在按完清空的那一刻**完全不可观测**
 *（变异实测：把它改成 `trimmedTurns += 0;` ⇒ 那个文件当时 73/73 全绿）。
 * 红线是「清空之后再发一轮」那一段补上的——没归零的那一版会在**下一轮**对话里
 * 说「最旧的 N 轮已经从这里移除」，而那 N 轮不是从这段新对话里移除的。
 * 由 `tests/ui/dom/playground-section.test.ts` 的
 * 「④ 点一下「清空对话」：右栏一轮不剩，那句「还没有发过请求」回来，披露也跟着走」钉着。
 */
function clearTurns() {
  if (inFlight) return;
  turns = [];
  trimmedTurns = 0;
  render();
}

/** 右栏。 */
function buildRight() {
  const { wrap, body } = block("pg.conv.title");
  if (turns.length === 0) {
    body.appendChild(elI18n("p", "pg.conv.empty", { class: "muted note" }));
    return wrap;
  }
  const bar = el("div", { class: "toolbar" });
  const clear = elI18n("button", "pg.conv.clear", { type: "button", class: "pg-clear" });
  clear.disabled = inFlight;
  // 灰按钮要说明理由，而那句话**与发送按钮在飞那一档同一个 key**：
  // 抄第二句出来只会得到两句会漂的话，而它们说的是同一件事。
  if (inFlight) clear.setAttribute("title", t("pg.send.blockedInFlight"));
  clear.addEventListener("click", () => { clearTurns(); });
  bar.appendChild(clear);
  body.appendChild(bar);
  if (trimmedTurns > 0) {
    /**
     * **被移除了几轮必须写在屏幕上**（与 `buildTurn()` 里那句 malformed 同一条理由）。
     *
     * ⚠️ **两个数都从常量与状态插值进去，不写死在字典里**（同 `pg.send.readyVideo`）：
     * 写死之后改 `PLAYGROUND_TURNS_MAX` 就会让这句话变成假话，而字典没有机器在守。
     * ⇒ 因此这里**不能**用 `elI18n`：那条路挂 `data-i18n`，而 `apply()` 走的是
     * **不带参数**的 `t()`，屏幕上会出现裸的占位符——i18n 门禁第 ⑧ 条正是为这一族缺陷立的。
     * 切语言不受影响：框架层在 `apply(document)` 之后还会重跑一次 `onShow()`（见 `js/i18n.js`
     * 文件头那条兜底机制），而本板块的 `onShow()` 在目录已经读到时就是一次 `render()`。
     * ⚠️⚠️ **但第 ⑧ 条拦不住 `elI18n` 这种写法，别指望它**（变异实测：把下面这两行换成
     * `elI18n("p", "pg.conv.trimmed", …)` ⇒ **那道门禁 exit 0**，红的是下面点名的那一格）：
     * 它的判据是「这个 key 的字符串字面量后面紧不紧跟着一个逗号」，而这里 key 是第二个
     * 参数、后面本来就跟着逗号——**这条边界那道门禁自己也登记着**。
     * ⇒ 这条写法唯一的红线是 `tests/ui/dom/playground-section.test.ts` 的
     * 「② 被移除了几轮写在屏幕上，次数与上限都从常量插值进去 —— 静默丢弃就是撒谎」。
     *
     * ⚠️ **`role="status"` 是刻意的**：这句话是**变化**出来的，而不是一段一直摆在那儿的
     * 说明文字；不标成活区域的话，读屏器用户按下发送之后不会听到任何提示，
     * 而他丢掉的正是屏幕上刚刚少掉的那几轮。
     * ⚠️⚠️ **代价明写：标了也未必念得到**（复评 F-6；上一版只写了「不标一定听不到」那一半，
     * 那半句真，但它会被读成「标了就听得到」）。真实读屏器对**活区域连同内容一起被插进
     * DOM** 这种形态通常**不播报**——可靠的形态是活区域先在 DOM 里、随后内容才变；
     * 而本板块每次发送都整版重建右栏（`render()` 头上先把宿主 `textContent` 清空、
     * 旧指针一律作废），这个 `<p>` 每一次都是新造出来的。⇒ 这一句今天更接近「翻回去时读得到」
     * 而不是「当场听得到」。**它仍然要标**：不标是一定听不到，标了是未必听到，
     * 那不是同一件事。同族的 `buildUnavailable()` 里那条横幅是同一个形态、同一条代价。
     * 真要修得靠让右栏那个容器活过 `render()`，那是「整版重建」这条设计的另一头，
     * 不是在这里加一个属性能解决的，本轮不动。
     */
    body.appendChild(el("p", { class: "muted note pg-trimmed", role: "status" },
      t("pg.conv.trimmed", { count: String(trimmedTurns), max: String(PLAYGROUND_TURNS_MAX) })));
  }
  for (const turn of turns) body.appendChild(buildTurn(turn));
  return wrap;
}

/**
 * 读不出来那一档。**绝不能退化成「画一个空的协议选择器」**：一排空档位会被读成
 * 「这个网关一条协议都没有」，而事实是我们**不知道**它认得哪些协议（全局约束 9 的同型）。
 */
function buildUnavailable() {
  const wrap = el("div");
  const banner = el("div", { class: "banner-danger", role: "status" });
  banner.appendChild(elI18n("span", "common.loadFailed"));
  const retry = elI18n("button", "common.refresh", { type: "button", class: "pg-retry" });
  retry.addEventListener("click", () => {
    // ⚠️ **hint 那一次也要重问**（评审 L3）：`hintAsked` 是个一次性闸，
    //    `/config` 失败一次之后它永远为真 ⇒ **整个会话的 hint 校验停在「比不了」，
    //    按了这颗按钮也不恢复**。这颗按钮的语义是「把这个板块读不到的东西再读一次」，
    //    而 hint 正是其中之一。
    hintAsked = false;
    loadHint();
    loadCatalog(true);
  });
  banner.appendChild(retry);
  wrap.appendChild(banner);
  const { wrap: card, body } = block("pg.req.title");
  body.appendChild(elI18n("p", "pg.unavailable", { class: "muted note pg-unknown" }));
  wrap.appendChild(card);
  return wrap;
}

/**
 * 整个板块重画一遍。**每次都把 body 清空重建**：藏起来的旧内容仍然在无障碍树里、
 * 仍然会被复制粘贴带走。
 */
function render() {
  const host = nodes.body;
  host.textContent = "";
  nodes.hintNote = null;
  nodes.send = null;
  // **每次重画都作废**：旧那个节点已经从文档里摘掉了，继续往它上面写字等于把
  // 后半段回答写进一个没人看得见的对象里。`buildTurn()` 会给还在收的那一轮重新挂上。
  nodes.streamText = null;
  // 同上，还在收的那一轮那句「掉了几块」（`buildTurn()` 会在 `malformed > 0` 时重新挂上；
  // 还是 0 的话它本来就不该存在，留成 null 正好）。
  // ⚠️⚠️ **这一句是有牙的，祸事今天就可达，别照着上面那句 `pollStatus` 的口径读**
  //    （变异实测：删掉它 ⇒ `tests/ui/dom/playground-section.test.ts` 的
  //     「连着两轮流式各有坏块：第二轮说的是自己那一句」当场红）：
  //    第一轮结束时 `.finally()` 会整版重画，而那一轮 `pending` 已经是 false
  //    ⇒ `buildTurn()` **不再重新挂** ⇒ 少了这一句，它就一直指着第一轮那个已经摘掉的
  //    节点，于是**第二轮的坏块全写进一个没人看得见的对象里，第二轮屏幕上那句话
  //    根本不长出来**——正是「静默丢弃就是撒谎」那一条。
  nodes.streamMalformed = null;
  // 同上，还在收的那一轮那个外框（`fillTurn()` 会在 `pending` 时重新挂上）。
  // ⚠️ **这一行是防御性的，今天走不到，别照着上面那句 `streamMalformed` 的口径读**
  //    （变异实测：删掉它 `pnpm test` **2768 全绿**）。两者差在**重挂的条件**上：
  //    那一行只在 `malformed > 0` 时才挂，所以第二轮开头那次重画**不会**把它挂上
  //    ⇒ 少了作废，指针就一直指着上一轮那个摘掉的节点；
  //    而这个外框对**每一个还在收的流式轮**都是无条件重挂的，第二轮 `sendOnce()`
  //    那次 `render()` 当场就把它覆盖成新的了。
  //    ⇒ 留着它不是因为它防住过什么，是因为多留一道对称的作废没有代价
  //      （与下面 `pollStatus` 那一行同一条裁定）。
  nodes.streamTurn = null;
  // 同上，轮询那一拍要就地重填的那个盒子（`buildMediaResult()` 会重新挂上）。
  nodes.pollBox = null;
  // 同上，那一轮的状态码那一格（`buildTurn()` 会重新挂上）。
  // ⚠️ **这一行是防御性的，今天走不到**（复评 R-1 实测：删掉它 2735 全绿）：
  //    `render()` 只有两条不重建 `pollTurn` 的早退，而**两条对轮询期间都不成立**——
  //    ① `catalog === null`：`catalog` 只由 `loadCatalog()` 写，而它的两个入口
  //       （`onShow()` 与错误横幅那颗重试）都只在 `catalog === null` 时才发得出去，
  //       轮询进行中 `pollEndpoint()` 正读着它 ⇒ 它不会翻回 null；
  //    ② `buildRight()` 的 `turns.length === 0`：`pollTurn` 本身就在 `turns` 里，
  //       而轮询期间它 `pending === true` ⇒ `trimTurns()` 按定义留着它，
  //       「清空对话」在飞时整个早退（轮询期间在飞标记不松开）⇒ 这个长度到不了 0。
  //    ⚠️ **②的理由在 P3e Task 19 换过一次，别照着旧版读**：旧版写的是
  //       「`turns` 全仓只有 push、零处清空」，那句话今天**是假的**（既有截断也有清空按钮）。
  //       结论没变，变的是它靠哪两条撑着——而那两条各自有用例钉着。
  //    ⇒ 留着它不是因为它防住过什么，是因为多留一道对称的作废没有代价，
  //      而少一道的代价要等到有人给 `render()` 加第三条早退时才看得见。
  nodes.pollStatus = null;
  if (catalog === null) {
    host.appendChild(buildUnavailable());
    return;
  }
  const cols = el("div", { class: "pg-cols" });
  cols.appendChild(buildLeft());
  cols.appendChild(buildRight());
  host.appendChild(cols);
}

/**
 * 拉一次协议目录。**成功读过一次就不再读**——目录是静态的，重读一遍只会换来一次
 * 「这次可能失败」的机会（与 `js/sec-models.js` 同一条裁定，理由见那里）。
 *
 * `preempt` 只由错误横幅上那颗「再读一次」传 `true`：显式的用户动作有权抢占一条挂住
 * 的读，隐式的板块切换没有。隐式入口在飞时**只 render() 不发请求**，否则一条永不落地
 * 的读会让此后每一次 `onShow()` 都什么都不画。
 *
 * ⚠️ **「与 `sec-models.js` 同一条裁定」这句话有边界，本轮补写清楚**（评审 F-4）：
 * 同的是上面那两条（读一次就不再读 / 隐式入口不抢占）。**不同的是切走板块那一下**——
 * `sec-models.js` 干脆没有 `onHide()`，一条挂住的读会一直挂到标签页关掉；
 * 这里跟的是 `js/sec-usage.js` 的 `onHide()`（abort + 世代号 `+1`），
 * 理由是 Playground 的 `onHide()` 本来就要作废发送那一次，
 * **一个板块里两条在飞的读一条作废一条不作废，才是那句全称注释变假的来源**。
 * ⚠️ **代价明写**：切走再切回来时目录会**重新读一条**（`sec-models.js` 那边不会）。
 * 那不是「两条链并存」——旧那条已经被 abort 且世代号已作废，它回来什么都改不了；
 * 换来的是一条挂住的读不再把这个板块永久钉在「读不出来」上。
 */
async function loadCatalog(preempt) {
  if (loadInFlight && !preempt) { render(); return; }
  // 抢占：把上一条的 socket 放掉。**它不是作废判据**，作废判据是下面那个世代号
  //（与 `js/sec-models.js` 逐字同做法与同一条理由）。
  if (loadAbort !== null) loadAbort.abort();
  loadAbort = new AbortController();
  const signal = loadAbort.signal;
  const mine = ++loadSeq;
  loadInFlight = true;
  try {
    const body = await api.get("/models", { signal });
    if (mine !== loadSeq) return;
    const protocols = playgroundProtocols(body);
    // **模型清单直接复用模型板块那份窄化**，不在这里再写一遍（`js/sec-settings.js` 同做法）。
    const models = catalogModels(body);
    // 媒体端点表（P3d Task 12）。**它读不出来同样是整份读不出来**，不是「媒体档不可用」：
    // 一个只有对话档能用、另两档静静变空的面板，运维分不出是这个网关不支持媒体、
    // 还是这份响应我们没读懂（全局约束 9 的同型）。
    // ⚠️ **代价明写（评审 L3）：媒体那几格漂了，会把整个 Playground（含对话四档）
    //    一起打死**，右栏变成那条红色横幅。这与 `playgroundProtocols()` / `catalogModels()`
    //    任何一个读不出来时的处置**逐字一致**（三者同档），**是刻意的一致而不是漏想**：
    //    「这份响应我们没读懂」时，让一半功能看起来正常才是更坏的那一档。
    //    真要退化成「媒体档单独不可用」，那是一个新的 UI 状态（第四档），不是把这一行改松。
    const media = mediaEndpoints(body);
    catalog = protocols === null || models === null || media === null
      ? null
      : { protocols, models, media };
    if (catalog !== null && protoId === "") protoId = catalog.protocols.length > 0 ? catalog.protocols[0].id : "";
  } catch (e) {
    if (mine !== loadSeq) return;
    catalog = null;
  } finally {
    // 被抢占 / 被作废的那条不许替**新**的那条（或者已经没有了的那条）清标记。
    if (mine === loadSeq) { loadInFlight = false; loadAbort = null; }
  }
  render();
}

/**
 * 作废目录那条读。**与 `cancelInFlight()` 是两件事，不能合并**（评审 F-4）：
 * `cancelInFlight()` 的作废判据是 `current` 的身份比较，而 `current` **只在 `sendOnce()`
 * 里赋值**——目录那条读用的是另一对模块变量（`loadInFlight` / `loadSeq`），
 * `current` 从来够不着它。合成一个函数的话，那颗「取消」按钮会顺手把目录读也掐了，
 * 而那两件事在 UI 上是分开的（目录读不出来时右栏是横幅，压根没有发送按钮）。
 *
 * ⚠️ **世代号 `+1` 是作废本体，`abort()` 只是省一次真实往返**（本板块四处作废判据同款）：
 * 少了 `+1` 的话，一条晚到的失败仍会走进上面那个 `catch` 把 `catalog` 抹掉。
 * ⚠️ **在这里显式清 `loadInFlight`**：被作废的那条走 `catch` → `mine !== loadSeq` 早退，
 * 它的 `finally` 那一支也不会碰标记 ⇒ 不清的话此后每一次 `onShow()` 都只 render 不发请求。
 */
function cancelCatalogLoad() {
  if (loadAbort !== null) { loadAbort.abort(); loadAbort = null; }
  loadSeq++;
  loadInFlight = false;
}

/**
 * 问一次设置页那把口令的末几位。
 *
 * ⚠️ **它失败不是错误，只是「比不了」**：`hint` 停在 `null`，那一句显示成
 * 「读不到配置，比不了」而不是「对不上」。把两者折叠成一档会让运维去改一把其实
 * 没错的口令（判定在 `js/pure/playground.mjs` 的 `tokenHintState()`）。
 * ⚠️ **它拿不到、也不该拿到明文口令**：`GET /admin/api/config` 对凭据只回
 * `{ configured, hint }`（设计 §8.6）。
 */
async function loadHint() {
  if (hintAsked) return;
  hintAsked = true;
  try {
    const body = await api.get("/config");
    hint = credentialView(body, "gatewayToken").hint;
  } catch (e) {
    hint = null;
  }
  if (nodes !== null) syncHintNote();
}

/** 作废在飞的那一次。**abort 只是省一次真实往返，作废判据是 `current` 的身份比较。** */
function cancelInFlight() {
  if (current !== null) current.abort();
  current = null;
  inFlight = false;
  /**
   * ⚠️⚠️ **在飞那一轮的收尾必须在这里做，不能指望 `.finally()`**（评审 F3）。
   *
   * `sendOnce()` 的 `.finally()` 第一句是 `if (current !== ctl) return;`，
   * 而这个函数刚把 `current` 置空 ⇒ **那条收尾路径走不到**。
   * 非流式那一档看不出来（它的 turn 压根还没进 `turns`），
   * **流式那一档看得一清二楚**：turn 早就在右栏里了，`pending` 永远停在 `true`
   * ⇒ 屏幕上留下一个空白框 + 一句「本面板在流式这一档不读 token 用量」，别的什么都不说
   *（既不说「一个字都没有」，也不说任何错误）。
   * ⇒ 这里把它收干净，并**明确标成「被取消」**——那与「读完了但没有正文」是两句话。
   */
  if (streamingTurn !== null) {
    streamingTurn.pending = false;
    streamingTurn.cancelled = true;
    streamingTurn = null;
  }
  /**
   * ⚠️⚠️ **轮询那一半在这里停，理由与上面那段逐字相同**（护栏 ③，设计 §9.3）：
   * 定时器不清的话，切走板块 / 按了取消之后**那台打点机还在跑**——每 5 秒一次真的
   * 上游请求，烧的是运维自己的配额，而屏幕上已经没有任何东西提到这一轮了。
   * `onHide()` 走的就是这个函数，所以「切走板块停轮询」与「按取消停轮询」是同一份代码。
   */
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  if (pollTurn !== null) {
    pollTurn.pending = false;
    pollTurn.cancelled = true;
    pollTurn.pollState = "stopped";
    pollTurn = null;
    pollCtl = null;
  }
}

/**
 * 轮询收尾。**每一条出口都要走它**——它是「把 `pending` 收干净 + 松开在飞标记」
 * 唯一的地方，散在各条分支里写就会漏掉某一条（流式那一档正是这么栽的）。
 */
function finishPolling(state) {
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  if (pollTurn !== null) {
    pollTurn.pollState = state;
    pollTurn.pending = false;
  }
  pollTurn = null;
  pollCtl = null;
  current = null;
  inFlight = false;
  render();
}

/**
 * 排下一次打点。**三条护栏里的第 ① 与第 ② 条都在这里。**
 *
 * ⚠️ **`videoPollNext()` 判上限，本函数不自己数**（判定在纯函数里，admin-ui/README.md
 * 硬规则 1）：写在这里的话它就没有单测，而「轮询会不会停」在屏幕上要几分钟才看得出来。
 * ⚠️ **页面藏起来时直接返回、不排定时器**（照抄 `js/sec-events.js` 的 `scheduleNext()`）：
 * 一个被切到后台的标签页不该继续烧配额。变回可见时由下面那个模块级监听接回去。
 */
function schedulePoll() {
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  if (pollTurn === null) return;
  if (document.hidden) return;
  const step = videoPollNext({ attempt: pollTurn.pollAttempt, elapsedMs: Date.now() - pollStartedAt });
  if (step.action === "giveUp") { finishPolling("gaveUp"); return; }
  pollTimer = setTimeout(() => { pollOnce(); }, step.delayMs);
}

/**
 * 页面从隐藏变回可见时，把因为它而停掉的那台打点机接回去
 * （**只注册一次的模块级监听**，与 `js/sec-events.js` 同一做法与同一理由）。
 *
 * ⚠️ **判据是「这一轮还在轮而且没有定时器在排」**，不是「本板块正在显示」：
 * 切走板块已经由 `onHide()` → `cancelInFlight()` 把 `pollTurn` 清空了，
 * 所以这里不需要再问一次板块活没活着——问了反而多一份会漂的状态。
 */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pollTurn !== null && pollTimer === null) schedulePoll();
});

/**
 * 打一次点。**每一次都是一次真的上游请求**（全局约束 14 的护栏管的正是它）。
 *
 * ⚠️ **停下来的判据是「这次响应里出现了媒体地址」，不是某个 status 字段等于某个词。**
 * 上游那份状态词表**本仓从来没有核实过**（`src/http/routes/media.ts` 的文件头只承诺
 * 原样转发），编一张出来的后果是：换一个上游实现，面板会一直轮到上限，
 * 而那条成片其实第二次打点就回来了。
 * ⚠️⚠️ **「一次失败就停」只对**传输层**成立，不对非 2xx 成立**——上一版这段逐字写着
 * 「一次失败就停，并且说出来」，**那句话对一半**（P3e Task 21 回填复核出来的）。
 * 真实行为分两路，而且是刻意的：
 * · **传输层失败**（断网 / CORS / 被拒，`sendToGateway()` 抛）⇒ 下面那个 `catch`
 *   `finishPolling("stopped")` **当场停**，任务标识还摆着，稍后可以自己再查。
 * · **非 2xx**（429 / 500 / 404：限流、任务过期、被回收）⇒ **不停，接着轮**。
 *   停的判据只有「这次响应里出现了媒体地址」与「传输失败」两条：一次限流或一次瞬时 5xx
 *   不该终结一次本来要跑 5 分钟的任务。这条**今天的行为**由
 *   `tests/ui/dom/playground-section.test.ts` 的
 *   「轮询回非 2xx 时状态码那一格显示的是这一拍的数字 —— 屏幕不许贴着错误正文说 200」
 *   那一格钉着（它逐字断言「非 2xx 之后它本来该接着轮（停的判据是拿到地址 / 传输失败）」）。
 * ⚠️ **它的代价是一句仍然会同屏矛盾的话，登记在案**：非 2xx 期间屏幕上是
 * 「正在轮询这个任务的结果，已经查过 N 次」+ 这一拍的错误正文与状态码，两句话互相矛盾。
 * 状态码那一格已经在 P3d 修成跟着这一拍走（见下面那段 ⚠️⚠️），**而「还在轮」那句话
 * 至今没有把上一拍的成败说出来**——要改就得给 `pg.media.polling` 那一族加一句
 * 「上一拍回的是 N」，那是五语言 + 渲染 + 判据的一整个任务，**不在 Task 21 的射程里**。
 */
async function pollOnce() {
  pollTimer = null;
  const turn = pollTurn;
  const ctl = pollCtl;
  // **身份比较**，与本板块其余三处作废判据是同一条（文件头那段 ⚠️⚠️）。
  if (turn === null || ctl === null || current !== ctl) return;
  const req = buildPollRequest(pollEndpoint(), turn.taskId, origin);
  if (req === null) {
    turn.errorKey = "pg.err.buildFailed";
    finishPolling("stopped");
    return;
  }
  turn.pollAttempt++;
  try {
    const r = await sendToGateway(req, token, { origin, signal: ctl.signal });
    if (current !== ctl) return;
    turn.status = r.status;
    turn.body = r.body;
    turn.contentType = typeof r.contentType === "string" ? r.contentType : "";
    if (mediaResultUrls(turn.body).length > 0) { finishPolling("done"); return; }
    /**
     * ⚠️⚠️ **这一拍只重填正在轮的那一个盒子，不整版 `render()`**（P3d 全分支评审 F-2）。
     *
     * 上一版这里是 `render()`，而 `render()` 会把**全部历史轮次**从头重建：
     * 每一轮的媒体档都要走一次 `mediaResultUrls(turn.body)`（整棵 JSON 树）
     * 再加一次 `prettyJson(turn.body)`（整份 `JSON.stringify`，**无长度上限**）。
     * 单看它便宜——**它与另外两件事相乘才有牙**：
     * ① Task 12 让 `turn.body` 可能是一张 base64 图（`mediaEmbeddable()` 放行
     *    `^data:image/`，1024×1024 那一档 ≈ 1.5 MB/轮）；
     * ② 视频轮询最多 60 拍（`VIDEO_POLL_MAX_ATTEMPTS`），**每拍一次**。
     * 实测（`npx tsx` 只 import 仓里的真函数、喂 1.5 MB base64 × N 轮）：
     * 一次整版重建在 1 / 5 / 10 轮时是 3.0 / 15.0 / **30.0 MB** 临时字符串，
     * ⇒ `turns=10` 时一次视频任务累计 **≈ 1.8 GB**、主线程占用按机器快慢在 1.5–29 s 之间。
     *
     * **这一拍在屏幕上会变的东西是三样**：`pollAttempt` 那句话、这一轮的响应原文，
     * 以及**这一轮的状态码**。前两样在那个盒子里，**第三样不在**——它由 `buildTurn()`
     * 画在 `foot` 上（那个 `.pg-status`）。所以下面**两处都要动**。
     * ⚠️⚠️ **上一版这里只重填了盒子，并且写着「唯一会变的只有两样……输出逐字相同」
     *    ——那是一句假话，复评 M-4 逐节点 diff 当场证伪**：轮询回 500 时屏幕上那一格
     *    还是上一拍的 200，而同屏的响应原文已经是 `{"error":…}` 了，
     *    **两句话互相矛盾，而前一句是编的**，最长挂到轮询结束（上限 5 分钟）。
     * ⇒ 现在的说法是可核的那一句：**这一拍就地改的两处，与整版重建的输出逐字相同**，
     *   而代价从 O(全部轮次 × 每轮 body) 降到 O(这一轮 body)，与历史轮数无关。
     * ⚠️ **仍然走同一份 `fillMediaResult()`**，不是在这里另写一套「只改那个数字」的
     * 就地更新——那会是第二套渲染判据，两套一漂只有真机上看得见。
     * （状态码那一格是一个 `textContent`，不是第二套判据：它与 `buildTurn()` 里那句
     * `String(turn.status)` 逐字同源，而「同不同源」由下面那格等价断言直接钉着。）
     * ⚠️ **终局那三条出口照旧整版 `render()`**（`finishPolling()` 里那一次）：
     * 成片/放弃/出错时整轮的形状都变了，那一次重建是必要的，而且一次任务只有一次。
     *
     * **三格一起钉着，方向各不相同**：
     * ① `tests/ui/dom/playground-section.test.ts` 的
     *    「轮询那一拍不整版重画 —— 右栏别的轮次与左栏输入框必须还是原来那几个节点对象」
     *    ——省下来的那件事（**两个方向**：右栏历史轮次 + 左栏那两个输入框，
     *    后者对应的祸事是焦点，假 DOM 没有焦点语义，只能靠节点身份看见）；
     * ② `tests/ui/dom/playground-section.test.ts` 的
     *    「轮询回非 2xx 时状态码那一格显示的是这一拍的数字 —— 屏幕不许贴着错误正文说 200」
     *    ——上面那条回归本身；
     * ③ `tests/ui/dom/playground-section.test.ts` 的
     *    「就地重填与整版重建输出逐字相同（六场景逐节点逐属性）」——等价性本身。
     */
    if (nodes.pollStatus !== null) nodes.pollStatus.textContent = String(turn.status);
    if (nodes.pollBox !== null) {
      nodes.pollBox.textContent = "";
      fillMediaResult(nodes.pollBox, turn);
    }
    schedulePoll();
  } catch (e) {
    if (current !== ctl) return;
    const code = e && e.code;
    turn.errorKey = code === "cross_origin" ? "pg.err.crossOrigin" : "pg.err.transport";
    finishPolling("stopped");
  }
}

/**
 * 建任务那一轮回来之后，要不要接着轮。**返回 true 表示这一轮还没完**
 * ——调用方据它决定**不要**松开在飞标记（全局约束 14：轮询的每一次打点同样烧配额）。
 *
 * 四种「不用轮」各自有自己的出口，**都不是静默的**：不是视频档 / 这次就失败了 /
 * 目录里没有轮询端点 / 上游一次就把成片给了 / **本面板认得的那几格里没有可用的标识**。
 * ⚠️ 最后那一档刻意**不写成**「响应里没有能当任务标识用的那一格」：那是一句关于响应的
 * 全称断言，而真正成立的只是「我们只读明写在 `VIDEO_TASK_ID_SLOTS` 上的那几格」。
 */
function startPolling(turn, ctl) {
  if (turn.mode !== "video" || turn.errorKey !== null || turn.status === null) return false;
  if (pollEndpoint() === null) return false;
  if (mediaResultUrls(turn.body).length > 0) return false;
  const id = videoTaskIdOf(turn.body);
  if (id === null) { turn.pollState = "noTaskId"; return false; }
  turn.taskId = id;
  turn.pollState = "polling";
  turn.pending = true;
  pollTurn = turn;
  pollCtl = ctl;
  pollStartedAt = Date.now();
  schedulePoll();
  return true;
}

/**
 * 按一下发送。**这是全站第二颗会真打上游的按钮**，护栏见文件头。
 *
 * ⚠️ **拦截分档在这里、不在 `buildRequest()` 里**：把「没填口令」塞进纯函数的话，
 * 它会和「构造不出请求」一起变成同一个 `null`，而这两件事在 UI 上必须分得开。
 */
function sendOnce() {
  // ⚠️⚠️ **在飞去重那一道住在 `sendBlockedKey()` 的第一档里，不在这里。**
  //    这一版曾经在这行上面多写过一句 `if (inFlight) return;`，而**变异实测把它删掉
  //    ⇒ 22/22 全绿**——它是一句没有任何用例守着的冗余，因为 `sendBlockedKey()`
  //    的第一句判的就是 `inFlight`。当时文件头正声称那句话是护栏本体，
  //    **那是一句假断言**，连同这段一起改真了。
  //    ⇒ **判据只许有一份**：要改在飞去重，改 `sendBlockedKey()` 那一档。
  if (sendBlockedKey() !== null) return;
  const proto = currentProto();
  const target = currentTarget();
  // **媒体那两条端点没有流式形态**，所以流式只在对话档才可能为真
  //（左栏在媒体档下压根不画那个开关，这里是第二道：开关的状态活过一次换档）。
  const stream = mode === "chat" && streamOn === true;
  const req = buildRequest(target, { model: modelId, prompt: promptText, stream, origin });
  if (req === null) {
    pushTurn({
      promptText, url: "", method: "", status: null, body: null, errorKey: "pg.err.buildFailed",
      stream: false, streamed: false, text: "", malformed: 0, pending: false, cancelled: false,
      mode, contentType: "", taskId: null, pollState: null, pollAttempt: 0,
    });
    render();
    return;
  }
  const ctl = new AbortController();
  current = ctl;
  inFlight = true;
  const sent = promptText;

  /**
   * 这一轮。**流式那一档在请求发出去之前就进 `turns`**，因为它要一边收一边画；
   * 非流式那一档仍然是回来之后才进（它在中途没有任何可画的东西）。
   */
  const turn = {
    promptText: sent, url: req.url, method: req.method, status: null, body: null, errorKey: null,
    stream, streamed: stream, text: "", malformed: 0, pending: stream, cancelled: false,
    mode, contentType: "", taskId: null, pollState: null, pollAttempt: 0,
  };
  if (stream) {
    pushTurn(turn);
    streamingTurn = turn;
  }
  render();

  const done = (r) => {
    turn.status = r.status;
    turn.body = r.body;
    // 流式那条路不带这一格（它读的是 SSE，不是一份响应体）⇒ 空串。
    turn.contentType = typeof r.contentType === "string" ? r.contentType : "";
    turn.streamed = r.streamed === true;
    if (!stream) pushTurn(turn);
  };
  const failed = (e) => {
    // **只认档位名，不把 `e.message` 画出去**：那条串是本地拼的，别给它机会带上
    // 任何一段请求内容（全局约束 11(b)）。
    const code = e && e.code;
    turn.errorKey = code === "cross_origin"
      ? "pg.err.crossOrigin"
      : code === "stream_error" ? "pg.err.stream" : "pg.err.transport";
    // ⚠️ **流式中途断掉时那一轮已经在 `turns` 里了，不许再 push 一次** ——
    //    再 push 一次的话，运维会看到同一轮出现两遍，其中一遍带着半截正文。
    if (!stream) pushTurn(turn);
  };

  const run = stream
    ? streamFromGateway(req, token, {
      origin,
      signal: ctl.signal,
      onPayload: (payload) => {
        // ⚠️ **取消之后就不许再往里写**：`current !== ctl` 是本板块统一的作废判据
        //    （文件头那段 ⚠️⚠️：abort 本身在测试里不可观测，被钉住的是这个比较）。
        //    少了这一句，一条已经被取消的流会继续把字写进右栏。
        if (current !== ctl) return;
        // **正文在哪一格来自协议目录**，本文件不认识任何一个协议 id（全局约束 15）。
        const piece = deltaText(proto, payload);
        if (piece === null) {
          // 读不出来的一块。**数出来、显示出来，但不中断整轮**：
          // 一块坏数据不该让运维正在读的那段回答整个消失。
          turn.malformed++;
          /**
           * ⚠️⚠️ **「显示出来」必须现在就发生，不能等到流结束**（复评 G2 实测）：
           * 这个数画在那个 `<pre>` **外面**，而下面那句就地更新只碰 `<pre>` 的
           * `textContent` ⇒ 上一版在途期间屏幕上**一个字都不提**，
           * 把一段缺字的回答当成完整的回答画着，直到 `.finally()` 那一次整版
           * `render()` 才补上（长生成是分钟级，流被挂住时无限期）。
           * 与 `.pg-status` 那一次是同一个结构性 bug，只是换到了流式这条路。
           *
           * **两档，判据只有一份，而且两档都不整版重画**：
           * · 那一行已经在屏幕上 ⇒ 就地改 `textContent`，**串本身与 `fillTurn()` 里
           *   那句 `t("pg.turn.malformed", …)` 逐字同源**（不是第二套判据）；
           * · `0 → 1` 那一下它还不存在 ⇒ **重填这一轮那一个 `.pg-turn`**
           *  （`fillTurn()`，正是整版重画用的那一份）——「它插在哪一行之前」仍然
           *   只有一份答案，而动的只有这一轮：右栏别的轮次与整个左栏一个节点都不换。
           *
           * ⚠️⚠️ **这一档曾经写的是 `render()`，那是一次真的回归**
           *（第三轮修复定向复评 F-1，实测；写在这里免得有人「为了少写一个函数」改回去）：
           * `render()` 会把**全部历史轮次 + 整个左栏**从头重建，而**兄弟路径两个提交
           * 之前刚把这件事从轮询那条路上删掉**（见 `pollOnce()` 里那段 ⚠️⚠️ 与它那格
           * 身份断言）。代价有两轴，当时那句说明只算了其中一轴：
           * · **体量**：每一轮一次 `mediaResultUrls()`（整棵 JSON 树）加一次
           *   `prettyJson()`（**无长度上限**），而 `turn.body` 可能是一张 MB 级 base64 图
           *   ⇒ 同一个文件实测过：**单次**整版重建在 1 / 5 / 10 轮时是
           *   **3.0 / 15.0 / 30.0 MB** 临时字符串（**与历史轮数成正比，不是一个定值**）。
           *   当时那句「一轮最多发生一次，与『一秒几十块都重画』不同阶」——**频率那半句
           *   是真的**（实测：一轮里 4 块坏数据只重建 1 次），但被比较掉的是错的那个基准。
           * · **焦点**（当时一个字都没提，而它是更要命的那一轴）：重画会把左栏那两个
           *   输入框换成新节点 ⇒ **运维正在打的那句话与光标当场没了**（中文输入法的
           *   候选窗一起崩）。这个文件另外三处逐字写着「重画会让左栏输入框丢焦点」，
           *   而假 DOM 没有焦点语义 ⇒ **这件事只能靠节点身份看见**（第 ④ 格）。
           *   实测那一拍：历史轮次被换掉 = true、左栏输入框被换掉 = true。
           *
           * **四格钉着，方向各不相同**：
           * ① `tests/ui/dom/playground-section.test.ts` 的
           *    「不是等流结束那一次整版重画才补上」——在途那一拍屏幕上必须有这一行本身；
           * ② `tests/ui/dom/playground-section.test.ts` 的
           *    「场景⑦流式在途：就地写字与整版重建输出逐字相同（逐节点逐属性）」
           *    ——等价性本身，与轮询那六格共用同一份装置；
           * ③ `tests/ui/dom/playground-section.test.ts` 的
           *    「连着两轮流式各有坏块：第二轮说的是自己那一句」
           *    ——`render()` 里 `streamMalformed` 那句作废（**只有那一句有牙**，
           *    旁边 `streamTurn` 那句实测是防御性的，理由写在它自己那里）；
           * ④ `tests/ui/dom/playground-section.test.ts` 的
           *    「坏块那一拍不整版重画 —— 右栏别的轮次与左栏输入框必须还是原来那几个节点对象」
           *    ——省下来的那件事本身（**身份断言**，与轮询那一格对称、两个方向）。
           *
           * ⚠️ **`streamTurn` 是 null 时这一拍什么都不做**，与下面那句
           * `nodes.streamText !== null` 同一条口径：它为 null 只可能是右栏压根没画
           *（`render()` 唯一那条早退 `catalog === null`，而流式在途走不到它，
           * 可达性论证与 `render()` 里 `pollStatus` 那段逐字相同）——
           * 那时屏幕上连这一轮都没有，没有任何一格可以就地改。
           */
          if (nodes.streamMalformed !== null) {
            nodes.streamMalformed.textContent = t("pg.turn.malformed", { count: String(turn.malformed) });
          } else if (nodes.streamTurn !== null) {
            nodes.streamTurn.textContent = "";
            fillTurn(nodes.streamTurn, turn);
          }
          return;
        }
        if (piece === "") return;
        turn.text += piece;
        // 就地改文字，不整块重画（重画会让左栏输入框丢焦点）。
        if (nodes.streamText !== null) nodes.streamText.textContent = turn.text;
      },
    })
    : sendToGateway(req, token, { origin, signal: ctl.signal });

  run
    .then((r) => { if (current === ctl) done(r); })
    .catch((e) => { if (current === ctl) failed(e); })
    .finally(() => {
      // 被取消过的话这里早退 —— 收尾已经由 `cancelInFlight()` 做完了（见那里的 ⚠️⚠️）。
      if (current !== ctl) return;
      // ⚠️ **视频那一档：建任务只是第一段，这一轮还没完。**
      //    在飞标记与取消令牌都留着不动，理由见文件头「轮询期间在飞标记不松开」。
      if (startPolling(turn, ctl)) { render(); return; }
      current = null;
      inFlight = false;
      turn.pending = false;
      streamingTurn = null;
      render();
    });
}

export const playgroundSection = {
  init(section) {
    section.textContent = "";
    section.appendChild(elI18n("h2", "pg.title"));
    section.appendChild(elI18n("p", "pg.desc", { class: "muted note" }));
    section.appendChild(elI18n("p", "pg.runtimeNote", { class: "muted note" }));
    const body = el("div");
    section.appendChild(body);
    nodes = {
      body, hintNote: null, send: null,
      streamText: null, streamMalformed: null, streamTurn: null,
      pollBox: null, pollStatus: null,
    };
    // 判定在纯函数里，而那个目录下拿不到浏览器的顶层全局，所以在这里读一次传进去。
    origin = location.origin;
    token = readGatewayToken();
  },

  onShow() {
    // ⚠️⚠️ **每次显示都重新从存储读一遍口令，不能只在 `init()` 里读一次**
    //（评审 M2）：登出**不会** reload 页面、板块也不会重新 `init()`，
    //    于是模块变量里那把口令会活过一次登出 ⇒ 下一个人登录进来时口令框是预填好的。
    //    `js/app.js` 的 `leave()` 清存储、这里重新读存储，**两处缺一不可**。
    // ⚠️ **代价明写**：隐私模式下 `writeGatewayToken()` 写不进去，于是切走再切回来
    //    会丢掉刚粘的那把——与那条「刷新后要重新粘」是同一档代价，不是新增的。
    token = readGatewayToken();
    loadHint();
    if (catalog !== null) { render(); return; }
    loadCatalog(false);
  },

  onHide() {
    // 切走板块 = 作废在飞的那**两**条（全局约束 14 的护栏之一）。
    // ⚠️⚠️ **上一版这里只有 `cancelInFlight()`，而注释写的是「作废在飞的那一次」**
    //    ——一句全称句，而目录那一次不在其中（评审 F-4，实测）：`cancelInFlight()`
    //    只动 `current`，`current` 只在 `sendOnce()` 里赋值。⇒ 两条各自的作废器都要调。
    cancelInFlight();
    cancelCatalogLoad();
  },
};
