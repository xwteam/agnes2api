import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// 抠注释走 `scripts/lib/strip-comments.mjs` 那一份真源（P3e Task 1 收编），不在这里手写第二份。
import { blankComments } from "../helpers/strip-comments.js";
import { FAIL_REASONS } from "../../src/core/dispatcher.js";
import { UPSTREAM_FACTS, type UpstreamFact } from "../../src/core/admin/upstream-facts.js";
import { MODEL_CATALOG, VIDEO_TASK_ID_SHAPE } from "../../src/core/admin/protocol-catalog.js";
// ADMIN.md 那一组的期望值一律从这些真源常量派生，不手写字面量。
import { ADMIN_TOKEN_MIN_LENGTH } from "../../src/http/admin/auth.js";
import { MAX_IMPORT_KEYS } from "../../src/http/admin/handlers/keys-write.js";
import { EVENT_WINDOW_MS, EVENT_WINDOW_RETAIN } from "../../src/core/admin/event-ring.js";
import { USAGE_DAY_RETAIN, USAGE_SLOTS } from "../../src/core/admin/usage-stats.js";
import { SESSION_MAX_AGE_MS } from "../../admin-ui/js/pure/session.mjs";
// 复评回填（F1 / F3）：设置卡与字符集那两句话的期望值一律从这几份真源现算，不手抄。
import { sendable } from "../../admin-ui/js/pure/sendable.mjs";
import {
  ADVANCED_FIELDS, CARD_AUTH, CARD_REGISTRAR, CARD_UPSTREAM, channelFields,
} from "../../admin-ui/js/pure/settings.mjs";
import { CHANNELS } from "../../admin-ui/js/pure/registrar.mjs";
import {
  PLAYGROUND_TURNS_MAX, VIDEO_POLL_INTERVAL_MS, VIDEO_POLL_MAX_ATTEMPTS, VIDEO_POLL_MAX_MS,
} from "../../admin-ui/js/pure/playground.mjs";

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
type Lang = (typeof LANGS)[number];

/**
 * 五语言对等的**结构性**判据：不查词，查**数字**。
 *
 * 查词的教训：P3a 查对等时用简体「保证」grep，漏掉了繁体「保證」，于是报告说
 * 「五语言齐全」而实际上有一份不齐。数字不随语言变，是唯一跨五种语言稳定的锚。
 *
 * ⚠️ **这条门禁的边界要写清楚，别再宣称成「五语言对等由测试保证」**：它只能证明
 * 「五份提到这个数的次数彼此一致」，**不能**证明「五份说的是同一件事」——同一个
 * 数字完全可能出现在语义不同的句子里。这条门禁只挡「某一份漏翻、漏写、或翻译时
 * 抄错一位数字」这一类回归，句子层面是否同义、译文是否准确，留给评审。
 *
 * ⚠️ **数字要写成文档里实际出现的字面样子，不是数值本身**——这条踩过坑：
 * `100000` / `1000` 这两个无逗号写法在五份文档里其实**从未出现**，免费档配额的
 * 原句一律写成 `100,000` / `1,000`（千位分隔逗号）。第一版直接手写了无逗号的
 * `100000`/`1000` 去核对，本该在创建时就全五语言落红——结果因为 K3/M2 那段
 * 新增的冷启动公式 `100000 ÷ (...)` 字面用了无逗号写法，`100000` 与 `1000`
 * （作为 `100000` 的前四位）碰巧都能在**同一句无关的话**里凑到一次匹配，测试
 * 意外全绿，而它验证的其实不是「配额数字写没写」。核对时按文档里的真实排版重新
 * 抄了一遍，别信数值本身。
 *
 * ⚠️ **裸数字本身可能早就在文档里出现过好几次，删掉目标句子未必能让计数归零**
 * ——这条是实测出来的，不是猜的：改动前的 `docs/<lang>/DEPLOY.md` 里裸 `120`
 * 在五种语言里各已出现 **4 次**（`UPSTREAM_SYNC_TIMEOUT_MS`/`CODE_TIMEOUT_MS` 的
 * 默认值 `120000`、isolate 扩容建议的 `120000`、`33,120` 次/天读取量），跟本任务
 * K4 新增的那句「上界约 120 秒」毫无关系。用裸 `token: "120", times: 1` 去核对，
 * 就算把 K4 那句整段删掉，计数依然是 4 ≥ 1，**这条门禁永远不会因为这个删除变红**
 * ——修法：锚定实际写下的字面样式 `**120`（五语言在这句都用了 markdown 加粗
 * 包住数字，且只有这一句这样写），而不是裸数字。
 *
 * ⚠️⚠️ **第一版在这里又踩了一次同类的坑，而且是控制端复验时抓到的**：判据当时写的是
 * 「每种语言各自至少出现 `times` 次」（`toBeGreaterThanOrEqual`）。`100,000` 在
 * ja/DEPLOY.md 里本来就出现 **3 次**（第 39、44、57 行一带），把其中一处悄悄改成
 * `999,999`（模拟翻译时抄错一位数字）之后，计数从 3 掉到 2，**仍然 ≥ 1**，
 * 门禁**完全没有反应**，15 个用例照样全绿。名字叫「关键数字对等」，实际只检查
 * 「存在」，抓不住「改错」——而「某语言改了一位数字、其余没同步改」正是五语言
 * 文档最常见的漂移形态，恰恰是这条门禁最该抓的那一种。
 *
 * 修法：**从「各自 ≥ N 次」改成「五种语言的出现次数彼此相等」。** 期望值不是手写
 * 常数，而是来自**其余四份独立文档**——这不算本文件登记的第 6 种假阳性（期望值
 * 从被测对象本身 grep 回填）：五份 DEPLOY.md 是五个独立维护的文件，一份被改坏就
 * 会与另外四份的计数分叉，跨语言互相校验挡得住「改错一处」，也挡得住「整段删掉」
 * （计数变成 0，同样和其余四份不一致）。**唯一挡不住的是「五份被同一个错误值
 * 同步污染」**——这与手写字面量方案的边界完全一样，本身就是「五份一起错」问题，
 * 不是这道门禁能力范围内的事。
 */
describe("五语言 DEPLOY.md 的关键数字对等", () => {
  const NUMBERS: ReadonlyArray<{ token: string; why: string }> = [
    { token: "**120", why: "POOL_CACHE_TTL_MS 的真实上界（60s TTL + 60s 边缘缓存），加粗标记只在这句出现" },
    { token: "100,000", why: "免费档每天读配额" },
    { token: "1,000", why: "免费档每天写 / 删除 / list 配额" },
    // ⚠️ **这个锚点是全分支评审 C2 补的，补之前它不在表里**——于是"安静部署"那条
    // 读配额包线在五语言里写歪了没有任何东西会红。它同时是本仓唯一一个"文档里的
    // 数字与一条会变红的用例（events-cursor-heal.test.ts:269 的基准线）同源"的锚点：
    // 那条用例量出来的是 70,560，文档写的也必须是 70,560。
    { token: "70,560", why: "「安静」部署单开一个面板标签页的稳态读配额包线（48 次事件 get + 1 次配置读，每天 1,440 轮）" },
    // ⚠️ **这两个锚点是 P3c Task 1 补的，加之前先数过**：改动前 `272` / `320` 在五份
    // 文档里**一次都没出现过**，加进来之后各出现 2 次（配额三栏表里一次、下面那句
    // 「这三个数都不是上界」里一次），五份完全一致。
    //
    // ⚠️⚠️ **这段说明的第一版把这道门禁的语义讲反了，评审 I3 抓到，如实登记。**
    // 当时写的是「把 `48` 当锚点等于『删掉目标句子计数依然 ≥1，门禁永远不会因为
    // 这个删除变红』」——**那句话是假的**，它描述的是本文件上面第四条 ⚠️ 记的那个
    // **已经被修掉**的旧判据（`toBeGreaterThanOrEqual`）。今天的判据是**跨语言
    // 计数相等**（`toEqual`），`toBeGreaterThan(0)` 只挡「五份都是 0」这种平凡相等。
    // 实测：把 `48` 加进本表、只把 ja 那份里的一个 `48` 改成 `49` ⇒ **红**。
    // **`48` 是一个能用的锚点，不是一个失效的锚点。**
    //
    // **那为什么仍然不加它**（结论不变，理由换掉）：
    // ① 它在五份里各已出现 7~9 次，散落在时间窗×槽位、Cron 每天的轮数、索引对账、
    //    锁释放等**互不相干**的句子里 ⇒ 变红时只说「ja 是 8、其余是 9」，
    //    **指不出是哪一句坏了**，而定位成本正是这道门禁存在的意义；
    // ② 任何一处无关改动只要在某一种语言里多写/少写一个 `48` 就会红，
    //    噪声会逼后来的人去调表而不是去改文档。
    // **它挡不住的那一种，两个锚点并无差别**：五份被同一个错误值同步污染
    //（`48` 五份一起改成 `49`、`272` 五份一起删）⇒ 计数依然对等 ⇒ 依然绿。
    // 这是跨语言互校这条判据的固有边界，不是选哪个数字能解决的。
    { token: "272", why: "注册机开着且每轮都健康时的写侧合计（80 + 96 + 48 + 0 + 48）" },
    { token: "320", why: "注册机开着且每轮都有失败事件时的写侧合计（80 + 96 + 48 + 48 + 48）" },
    // ⚠️ **这三个是第三轮补的，理由与上面两个一样：数过再加。**
    // 改动前 `1,040` 在五份里各 0 次、`288` 各 0 次、`600000` 各 0 次；
    // 现在分别是 1 / 6 / 5，五份完全一致。它们承载的是配额账里**最容易写歪**的
    // 那三处：打穿写配额的那个合计、Cron `*/5` 每天的轮数、以及触发逐轮配置
    // 警告的那个阈值（`MINT_BATCH × CODE_TIMEOUT_MS × 通道数`）。
    // **不加 `300000`**：改完之后它在五份里各 **0** 次——那个例子已经从
    // `TEND_INTERVAL_MS=300000` 换成了 Cron `*/5`（订正 ⑤：本节讲的是 Worker
    // 形态，而 `TEND_INTERVAL_MS` 只被 Node 调度器消费，在 Worker 上调它一轮都不会多）。
    // 加一个五份都不存在的 token 会被上面那条 `toBeGreaterThan(0)` 当场判死。
    { token: "1,040", why: "两轴叠加的最坏合计（Cron */5 且每轮都有事件），已打穿 1,000" },
    { token: "288", why: "Cron `*/5 * * * *` 每天的轮数，三笔按轮计费的乘数" },
    { token: "600000", why: "逐轮配置警告的阈值 MINT_BATCH×CODE_TIMEOUT_MS×通道数 的默认值" },
    // ⚠️ **P3c Task 3 补的，同样是先数过再加**：改动前 `201` 在五份文档里各 **0** 次
    //（`git show HEAD:docs/<lang>/DEPLOY.md | grep -o 201 | wc -l`），加进来之后各 **1** 次。
    // 选它而不选同一段里的 `200`（一次导入的上限）：`200` 在五份里各已出现 7 次，
    // 散落在 HTTP 200、note 长度上限等互不相干的句子里 —— 变红时指不出是哪一句坏了，
    // 而定位成本正是这道门禁存在的意义（同 `48` 那条不加的理由）。
    // `201` 只出现在「面板单次点击的写侧上界」那一句里，是那一段唯一的锚。
    { token: "201", why: "一次导入 200 把 key 的写侧上界（200 条记录 + 1 次索引），面板单次点击最贵的动作" },
    // ⚠️ **P3c Task 5 补的三个，同样是先数过再加**：改动前 `392` / `632` / `24 × 3`
    // 在五份文档里各 **0** 次（`grep -o` 数过），加进来之后各 **1** 次，五份完全一致。
    // 选它们而不选 `24`：`24` 在五份里散落在时间窗口、小时数、`24 小时` 这类互不相干的
    // 句子里各已出现十余次 —— 变红时指不出是哪一句坏了，而定位成本正是这道门禁存在的
    // 意义（同 `48` 那条不加的理由）。这三个只出现在「立即补池的日预算」那一段里。
    //
    // **三个一起加，因为它们是同一笔账的三段，各自都会被单独写歪**：
    // `24 × 3` 是算式本身、`392` 是可持续那一栏的合计、`632` 是突发上界那一栏的合计。
    // 只锚一个的话，另外两段在某一种语言里抄错一位不会有任何东西变红。
    { token: "24 × 3", why: "「立即补池」可持续写侧的算式（每天 24 次 × 每次 3 次 put）" },
    { token: "392", why: "「立即补池」可持续写侧叠上稳态第三栏之后的合计（72 + 320）" },
    { token: "632", why: "「立即补池」每次都铸满 MINT_BATCH 时的突发上界合计（312 + 320）" },
    // ⚠️ **P3d Task 3 补的五个，同样是先数过再加**：改动前 `104` / `13 × 8` / `280` /
    // `424` / `856` 在五份文档里**各 0 次**（`grep -o -F` 逐份数过），加进来之后
    // `13 × 8` / `104` / `280` / `424` / `856` 分别是 **1 / 4 / 1 / 1 / 1** 次，
    // 五份完全一致（定向复评 N8：上一版这里写的是「3 / 1 / 1 / 1 / 1」，
    // **前两个配反了，而且 `104` 后来又多了一处，早就不是 3**。
    // ⭐ 这类「注释里抄一份计数」天生会过期 —— **能变红的是下面那条跨语言互校，
    // 不是这段话**，读的人别把它当判据）。
    //
    // **五个一起加，因为它们是同一笔账里五段各自会被单独写歪的数**：
    // `13 × 8` 是算式本身、`104` 是 Tier-2 的写量增量，`280`/`424`/`856` 是四行场景表里
    // 新增的那三行合计（第一行 `176` 与 Tier-2 关掉时逐字相同，已被上面那个锚覆盖）。
    // 只锚 `104` 的话，某一种语言把 `856` 抄成 `865` 不会有任何东西变红——而 `856` 恰恰是
    // 「开了之后会不会打穿写配额」这个问题的答案（85.6% < 100%），写歪一位就是相反的结论。
    //
    // ⚠️ **不加 `13`**：它在五份里散落在「13 次 put」「12 + 1」等十几处，
    // 变红时指不出是哪一句坏了，而定位成本正是这道门禁存在的意义（同 `48` 那条不加的理由）。
    // `13 × 8` 只出现在那一句算式里，是那一段唯一的锚。
    { token: "13 × 8", why: "Tier-2 每天写量的算式（每实例 13 次 put × 8 个并发 isolate）" },
    { token: "104", why: "Tier-2 打开之后每天新增的 put 数，配额账里本期唯一的新写者" },
    { token: "280", why: "Tier-2 开、注册机关着时的写侧合计（176 + 104）" },
    { token: "424", why: "Tier-2 开、注册机开着且每轮有失败事件时的写侧合计（320 + 104）" },
    { token: "856", why: "四行场景表里最坏那一行的合计（752 + 104），85.6% —— 「开了也不打穿」这条结论就靠它" },
    // ⚠️ **P3e Task 13 补的，同样是先数过再加**：改动前 `.dev.vars.off` 在五份文档里
    // **各 0 次**（`grep -o -F | wc -l` 逐份数过），加进来之后**各 1 次**，五份完全一致。
    //
    // **这一条不是数字，是本表第一个字面 token，理由与选数字时完全一样**：本表要的是
    // 「跨五种语言稳定、且只出现在目标那一句里」的锚，`.dev.vars.off` 两条都满足——
    // 它是一条 shell 命令的产物名，五种语言都不会去翻译它，而且全仓只有那一句提到它。
    // **不选 `.dev.vars`**：它在五份里各已出现 3 次（本节原有那两句 + 新增这句），
    // 变红时指不出是哪一句坏了，而定位成本正是这道门禁存在的意义（同 `48` 那条不加的理由）。
    //
    // 它守的那一句是 Task 13 那条绊线的**唯一出路说明**：`.dev.vars` 会被
    // `pnpm test:workers` 无退出口地读进 workerd 的 env（见
    // `tests/contract/dev-vars-guard.test.ts` 的「workerd 的 env 里只该有 POOL —— .dev.vars
    // 被 pnpm test:workers 读进来了」）。绊线红了而某一种语言的文档偏偏没写出路，
    // 那种语言的读者就只剩一条无解的红——这个锚点管的正是这件事。
    { token: ".dev.vars.off", why: "`.dev.vars` 绊线红了之后的出路（跑测试前改名），五份 DEPLOY.md 各只此一处" },
    // ⚠️ **P3e Task 23 补的，同样是先数过再加**：改动前 `src/http/wire.ts` 在五份文档里
    // **各 0 次**（`grep -o -F | wc -l` 逐份数过），加进来之后**各 2 次**——
    // `POOL_CACHE_TTL_MS` 与 `POOL_TOUCH_INTERVAL_MS` 两格各一次，五份完全一致。
    //
    // **它守的是这两格里新补的那句「面板改它不会立刻生效」**。这句话在改动前
    // **一份都没写进那两格**：五份 DEPLOY.md 的正文里确实有一段说了这件事
    //（就在环境变量表下面），但**表格那两格没有**，而那张表的开场白自己写着
    // 「完整的取值范围与代价以本表为准」——照着表逐格读参数的人看不到这条代价。
    // 与之配套的面板那一半是 `admin-ui/js/pure/settings.mjs` 的 `BUILD_TIME_FIELDS`：
    // 面板的**保存回执**不再对这两格谎称「本实例已经生效」。三处说法必须一起动，
    // 只改一处就是换个地方继续说假话。
    // ⚠️ **那句话要带射程，别读成「面板任何时候都不会说本实例已经生效」**：
    // 读取态下 `set.propagation` 照旧要显示（它讲的是这个部署的传播上界本身，
    // 是 P3c 论证出来的必须显示项），只是保存留下的回读行与高亮会在回到读取态时
    // 一并作废——那一档由 `tests/ui/dom/settings-save.test.ts` 的
    // 「④ 只是读了一次配置（还没保存过）：重启那句不出现，传播上界照常在」
    // 与「⑤ 保存旋钮之后回到读取态：回读行与高亮一并作废」两格钉着
    //（⑤ 是 Task 23 复评发现 1：改动前保存完点一下「刷新」，屏幕上就编出
    // 「你刚改的那格本实例已经生效」）。
    //
    // ⚠️⚠️ **这条计数锚管不了那句正文还在不在**，别把它当成那句话的守卫：
    // 复评 R8 实测「五份同步删掉正文、只留这个路径」，本表全绿。正文那一半在
    // `tests/ui/settings.test.ts` 的「五语言 DEPLOY.md 的那两格里，正文逐格写着
    // 「面板改它不会立刻生效」，而且指着出处」那一格（逐语言查本地化正文 + 反向控制）。
    // 本条锚今天仍然有意义：它管的是**跨五种语言对等**（某一份漏改当场红），
    // 那是另一件事。
    //
    // **为什么选一条源码路径当锚**（本表第二个非数字 token）：本表要的是「跨五种语言
    // 稳定、且只出现在目标那一句里」的锚。`src/http/wire.ts` 两条都满足——路径不会被
    // 翻译，而且它**恰好就是这句话的出处**（那两个旋钮就是在那个文件里被读掉一次的），
    // 不是随手挑来当记号的。**不选「isolate」**：它在五份里各已出现 50 次上下，
    // 散落在配额账、可见性上界、冷启动等互不相干的句子里，变红时指不出是哪一句坏了
    //（同 `48` 那条不加的理由）。
    // ⚠️ **`why` 里不写计数**（复评发现 4）：上一版写的是「五份 DEPLOY.md 各 2 次」，
    // 而 `why` 会进用例名，判据却只验「五份彼此相等 + 总数 > 0」——R9 实测（回填时复跑过
    // 一次）五份各加到 3 次，本文件 66 格照旧全绿，用例名却还念着「各 2 次」。
    // **能删数字就删数字**：期望值本来就该
    // 从其余四种语言来，不从手写常数来（那是本表的设计），所以删的是那句话，不是加一个
    // `toBe(2)` 去和本表的设计对着干。「那两格里各有一处」这件事本身由
    // `tests/ui/settings.test.ts` 那条逐行查的正文守卫钉着，那里是逐格取行的。
    { token: "src/http/wire.ts", why: "这两个旋钮「建实例时读一次」的出处" },
    // ⚠️ **P3e Task 28 补的四个，同样是先数过再加**：改动前 `1 + 60` / `30 × 2` /
    // `Subrequests per invocation` / `Operations/Worker invocation` 在五份 DEPLOY.md 里
    // **各 0 次**（`grep -o -F | wc -l` 逐份数过），加进来之后五份完全一致。
    // ⭐ **这段话里的计数不是判据**（同上面 N8 那条 ⭐）：能变红的是下面那条跨语言互校。
    //
    // **它们守的是本任务新写进配额账的两笔（Task 28 的第 (3) 笔）**：
    // ① Tier-2 用量的读侧 —— `30d` 那一档一次请求发 `30 × 2` = 60 次 KV get，
    //    而 Cloudflare 两页官方文档在「一次调用能发多少条子请求」上对不上；
    // ② Playground 的视频档一次任务最多 `1 + 60` 次上游请求。
    //
    // **`Subrequests per invocation` 与 `Operations/Worker invocation` 两个都要**：
    // 那句话的全部意义是「两页对不上」，只留一行就不再是一处分歧，而是一条看起来
    // 干净的结论 —— **少掉哪一行都会让那段话变成另一件事**，所以两行各上一个锚。
    // 它们是 Cloudflare 官方文档里的行名，五种语言都不翻译（本表第三、四个非数字 token，
    // 理由同 `.dev.vars.off`：跨语言稳定、且全仓只有那一句提到它）。
    //
    // ⚠️ **不加裸 `60` / 裸 `50`**：它们在五份里散落在这两笔账、`VIDEO_POLL_MAX_ATTEMPTS`、
    // 60 秒轮询上限、`60000`、`750` 这类**子串**等互不相干的地方，变红时指不出是哪一句坏了，
    // 而定位成本正是这道门禁存在的意义（同 `48` 那条不加的理由）。
    //
    // ⚠️⚠️ **这两个 token 从真源常量现算，不写字面量**（Task 28 复评 H2）。上一版写死了
    // `"1 + 60"` 与 `"30 × 2"`，复评拿真源变更做过两次变异：`USAGE_DAY_RETAIN 30→14`、
    // `VIDEO_POLL_MAX_ATTEMPTS 60→30`，两次都**只红 3 格且全部点名 ADMIN.md**
    //（那三格是下面 `ADMIN_NUMBERS` 派生出来的），本表这两格照绿——而那三格的报文
    // 逐字写着「要么常量改了而这一份文档没跟着改」，照它做完只改五份 ADMIN.md，
    // 五份 DEPLOY.md 里的 `30 × 2` = 60 原地变成假话且全绿。**报文可以亲手把人引进坑**。
    // 改成现算之后，常量一改，token 就成了文档里查不到的串 ⇒ 下面那条
    // `total === 0` 当场红，报文点名 DEPLOY.md。测法是本组末尾那两格探针。
    {
      token: `1 + ${VIDEO_POLL_MAX_ATTEMPTS}`,
      why: "Playground 视频档一次任务的上游请求上界（1 次建任务 + 最多 VIDEO_POLL_MAX_ATTEMPTS 拍轮询）",
    },
    {
      token: `${USAGE_DAY_RETAIN} × ${USAGE_SLOTS}`,
      why: "「30d」那一档一次请求的 KV get 数（USAGE_DAY_RETAIN × USAGE_SLOTS，两个都现算）",
    },
    { token: "Subrequests per invocation", why: "Cloudflare Workers limits 页免费档 50 的那一行，口径分歧的一半" },
    { token: "Operations/Worker invocation", why: "Cloudflare KV limits 页 1,000 的那一行，口径分歧的另一半" },
  ];

  for (const { token, why } of NUMBERS) {
    it(`五语言 DEPLOY.md 里「${token}」（${why}）的出现次数彼此一致`, () => {
      const failures = numberTokenFailures(token, why, realDoc("DEPLOY"));
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }

  /**
   * ⚠️ **这一格存在的唯一理由是「让别处那句注释指得住『那一格』」**（复评 H4）。
   *
   * `admin-ui/js/sec-playground.js` 写着「这笔账由 docs-parity 那一格钉着」。上一版
   * 它指的是上面那圈 `it()` 的**用例名**，而用例名是模板串生成的，注释里的名字锚
   * 只认得住族名（`……` 省略号匹配）——复评实测**删掉 `1 + 60` 那一整行**，
   * `check-comment-refs` **exit 0**、docs-parity 照绿。**族名还在，那一格已经没了。**
   *
   * 名字锚必须落在**用例标题**里（`check-comment-refs.mjs` 的 `testTitles()`，
   * 断言性措辞触发规则 B 时收紧到标题），所以补一格标题是**字面量**的用例，
   * 逐行断言那两个派生 token 还在表上：删掉任意一行 ⇒ 这一格红；
   * 删掉这一格本身 ⇒ 注释里的名字锚落空 ⇒ 那道门禁红。两条路都不静默。
   */
  it("NUMBERS 表里那两个从真源常量现算的 token 都还在：Playground 视频档的上游请求上界、30d 那一档的 KV get 数", () => {
    const tokens = NUMBERS.map((n) => n.token);
    expect(tokens, "`1 + VIDEO_POLL_MAX_ATTEMPTS` 那一行不在 NUMBERS 表上了——"
      + "`admin-ui/js/sec-playground.js` 那段注释正声称它由那一格钉着，要么把行加回来，要么改那段注释")
      .toContain(`1 + ${VIDEO_POLL_MAX_ATTEMPTS}`);
    expect(tokens, "`USAGE_DAY_RETAIN × USAGE_SLOTS` 那一行不在 NUMBERS 表上了——"
      + "五份 DEPLOY.md 里那笔 Tier-2 读扇出的账从此没有任何跨语言守卫")
      .toContain(`${USAGE_DAY_RETAIN} × ${USAGE_SLOTS}`);
  });

  // ── 探针：真源常量漂一位 ⇒ 派生出来的 token 变成文档里查不到的串 ───────────────
  //
  // ⚠️ **这不是「换个 token 试试」，它就是「常量改了而五份 DEPLOY.md 没跟着改」那一刻
  // 判据会看到的东西**：`token` 是从常量现算的，常量改成 `n+1` 之后判据拿到的正是
  // 下面这两个串。探针与真扫描共用 `numberTokenFailures`。
  const DERIVED_PROBES = [
    {
      label: "VIDEO_POLL_MAX_ATTEMPTS",
      token: `1 + ${VIDEO_POLL_MAX_ATTEMPTS + 1}`,
      // ⚠️ 探针这句 `why` **刻意与真表那一行的不同字**：两者都会原样进报文，长得一样
      // 的时候跑红了分不清是真表那一格还是探针那一格——**报文是唯一会被看见的护栏**。
      why: "Playground 视频档的上游请求上界（探针）",
    },
    {
      label: "USAGE_DAY_RETAIN",
      token: `${USAGE_DAY_RETAIN + 1} × ${USAGE_SLOTS}`,
      why: "「30d」那一档一次请求的 KV get 数",
    },
  ] as const;

  it.each([...DERIVED_PROBES])(
    "该红时红：$label 漂一位 ⇒ 派生 token 那一格当场红，报文点名 DEPLOY.md（不是 ADMIN.md）",
    ({ token, why }) => {
      const failures = numberTokenFailures(token, why, realDoc("DEPLOY"));
      expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
      expect(failures[0]).toContain("DEPLOY.md");
      expect(failures[0]).not.toContain("ADMIN.md");
      expect(failures[0]).toContain("一次都没出现");
    },
  );

  it("不乱红：五份一起合法地多写一句无关的话 —— 上面每一格都不许因此假红", () => {
    const noisy: ApiDocReader = (lang) => `${realDoc("DEPLOY")(lang)}\n\n<!-- 无关的一行 -->\n`;
    for (const { token, why } of NUMBERS) {
      const failures = numberTokenFailures(token, why, noisy);
      expect(failures, `「${token}」：五份一起多写了一句无关的话，判据却红了\n${failures.join("\n")}`).toEqual([]);
    }
  });

  it("该红时红：只把 ko 那份里的一处锚点抹掉 ⇒ 计数分叉那一格必须点名 ko", () => {
    // 反向控制用仓里真实存在的串：`.dev.vars.off` 今天真的在五份 DEPLOY.md 里各 1 次。
    const failures = numberTokenFailures(
      ".dev.vars.off",
      ".dev.vars 绊线红了之后的出路",
      readerWith("ko", (s) => s.split(".dev.vars.off").join(".dev.vars.disabled"), "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("不一致");
    expect(failures[0]).toContain('"ko":0');
  });
});

/**
 * **503 的 `reason` 是对外 API 契约的一部分，五份 API.md（`docs/zh-CN/API.md` 等）各有一张表列着它们。**
 *
 * 上面那组数字对等**结构性地看不见这件事**：五份一样地漏掉一条 reason 时，
 * 每份的出现次数都是 0，对等照样成立（评审 I3——本任务加 `all_disabled` 时五份就是
 * 这样一起过时的，没有任何门禁响过）。所以这一组不比"五份彼此一致"，
 * 而是拿**代码里的那张真表**去比：`FAIL_REASONS` 是 `FailReason` 联合的唯一来源，
 * 加一条新 reason 却不写文档，这里会逐语言变红。
 *
 * ⚠️ 边界同样写清楚：它只证明**那个字面量出现在那份文档里**，不证明那一行说得对、
 * 也不证明五份说的是同一件事。后者仍然留给评审。
 */
describe("五语言 API.md 的 503 reason 表覆盖全部取值", () => {
  // 反向自检：这张表不许空，否则下面的 for 一格都不跑而整组照绿。
  it("FAIL_REASONS 本身不是空表，且就是 unavailable() 用的那一份", () => {
    expect([...FAIL_REASONS]).toEqual([
      "pool_empty", "all_cooling", "all_disabled", "all_evicted", "upstream_error",
    ]);
  });

  for (const reason of FAIL_REASONS) {
    it(`每一份 API.md 都写了 \`${reason}\``, () => {
      const missing = LANGS.filter((lang) => !readFileSync(`docs/${lang}/API.md`, "utf8").includes(reason));
      expect(missing, `这些语言的 API.md 没提到 reason「${reason}」——对外契约少了一条`).toEqual([]);
    });
  }
});

/**
 * ── 五语言 API.md 里那句「这条上游事实没被核实过」（从 `UPSTREAM_FACTS` 派生）──────
 *
 * **走的是上面 `FAIL_REASONS` 那条路，不是 `NUMBERS` 那条。** `NUMBERS` 的期望值来自
 * 其余四份文档，已知边界写在那张表上方：**五份被同一个错误同步污染照样绿**。
 * 而这一组要防的恰恰是那种形态——「五份一起漏掉那句限定」是它最可能的死法，
 * 所以期望值必须来自**代码里的那张真表**（`src/core/admin/upstream-facts.ts`），
 * 加一条新的假设性上游事实却不写文档，这里会逐语言、逐小节变红。
 *
 * ── 它做不到什么（明写）────────────────────────────────────────────────────
 * 它只证明**那句限定逐字出现在那一份文档的那一个小节里**，不证明那句话译得对、
 * 更不证明这条上游事实本身是真是假。后者只有一次真上游能定案；译文准确与否留给评审。
 *
 * ⚠️ **`docSections` 那一栏不是装饰**：判据是**小节内**查找，不是整份文档查找。
 * 下面「限定句被挪出指名小节」那格就是这句话的测法——把限定句挪到**文档标题之下、
 * 第一个 `## ` 之上**那片不属于任何小节的地方，整份文档照旧 `includes` 得到
 *（那一格里连这件事一起断言了），而小节内查不到 ⇒ 红。
 * ⚠️⚠️ **别把这条测法读成「挪到文件末尾」**：上一版这段逐字这么写着，而复评照它做
 * 真文件变异的结果是**全绿 EXIT=0**——`sectionBody()` 里最后一个小节的正文一直延伸到
 * EOF，所以「追加到文件末尾」等于**追加进最后一个小节**；某条事实指名的小节恰好排在
 * 最后时（今天 `video.taskIdCharset` 就是），那种变异一格都不会红。
 * 「最后一节延伸到 EOF」这半句不是散文，下面那格里连它一起断言了。
 * 同一件事在下面那格的实现旁边也写着，两处必须一起改。
 */

/** 五份同名文档的取文口径：真扫描与探针**共用这一份**，探针换掉的只是这个函数。 */
type ApiDocReader = (lang: Lang) => string;

/**
 * 取文口径的唯一工厂。**API.md 与 ADMIN.md 走同一份**——各写一份的话，两组的
 * 「真扫描读的是什么」会各有各的口径，而其中一份坏了另一份不会响。
 */
const realDoc = (doc: string): ApiDocReader => (lang) => readFileSync(docPath(".", lang, doc), "utf8");

const realApiDoc: ApiDocReader = realDoc("API");

/**
 * `## <heading>` 到下一个 `## ` 之间的正文。**找不到那个小节返回 `null`——认不出要吵，
 * 不许装没看见**：小节标题写错时若当成「这一份没有这句话」，报文会把人指向
 * 「去补一句限定」，而真正坏掉的是表里那个标题。
 */
function sectionBody(src: string, heading: string): string | null {
  const at = src.indexOf(`\n## ${heading}\n`);
  if (at === -1) return null;
  const from = at + 1;
  const next = src.indexOf("\n## ", from);
  return next === -1 ? src.slice(from) : src.slice(from, next);
}

/**
 * 变异只改一种语言的那一份，其余四份照旧走真文档。**改不动就当场炸。**
 * **三组探针（上游事实的限定句、字符集硬闸、ADMIN.md 的措辞与数字）共用这一份**，
 * 各写一份的话，三组的「变异落没落地」会各有各的口径，而其中一份坏了另一份不会响。
 * `doc` 默认 `"API"`，只有 ADMIN.md 那一组会传别的值。
 */
function readerWith(target: Lang, edit: (s: string) => string, doc = "API"): ApiDocReader {
  const base = realDoc(doc);
  return (lang) => {
    const src = base(lang);
    if (lang !== target) return src;
    const out = edit(src);
    if (out === src) throw new Error(`变异没落到 docs/${lang}/${doc}.md 上——这一格控制是空的`);
    return out;
  };
}

/**
 * 一个 token × 五份 DEPLOY.md 的计数对等。返回失败报文数组。
 * **真扫描与探针共用这一份**——各写一份的话，两边的判据会各有各的口径，
 * 而其中一份坏了另一份不会响（本文件既有纪律）。
 *
 * ⚠️ **报文里两处都点名 `DEPLOY.md`**（Task 28 复评 H2）：本文件另有一组
 * `ADMIN_NUMBERS` 报的是 ADMIN.md，两组报文长得像的时候，人会照着先看见的那一条去改
 * 另一份文档——复评实测过一次，真源常量一改只有 ADMIN.md 那三格红，照着它改完
 * DEPLOY.md 里同源的那个数原地变假且全绿。
 */
function numberTokenFailures(token: string, why: string, read: ApiDocReader): string[] {
  if (token.trim() === "") {
    return [`「${why}」的锚 token 是空串——空串永远查得到，这一格从此空转`];
  }
  const counts = Object.fromEntries(
    LANGS.map((lang) => [lang, read(lang).split(token).length - 1] as const),
  ) as Record<Lang, number>;

  // 先挡住「五份都是 0」这种平凡相等——那不叫对等，叫这个锚点压根没写进任何一份文档。
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return [
      `「${token}」（${why}）在五语言 DEPLOY.md 里一次都没出现`
      + "——要么 token 本身打错了，要么它是从真源常量现算出来的而那个常量刚改过；"
      + "后者该改的是五份 DEPLOY.md 的正文，不是把 token 改回旧值",
    ];
  }

  // 期望值来自其余语言，不是手写常数：任何一种语言的计数与其余四份不一致，
  // 下面这份逐语言计数会摊开显示，一眼看出是哪一种偏了。
  const reference = counts[LANGS[0]];
  if (LANGS.some((lang) => counts[lang] !== reference)) {
    return [
      `「${token}」（${why}）在五语言 DEPLOY.md 里的出现次数不一致`
      + `——可能有语言漏翻、漏改，或翻译时抄错了数字：${JSON.stringify(counts)}`,
    ];
  }
  return [];
}

/** 一条事实 × 五份 API.md。返回失败报文数组。真扫描与探针共用这一份。 */
function factDocFailures(fact: UpstreamFact, read: ApiDocReader): string[] {
  const out: string[] = [];
  for (const lang of LANGS) {
    const src = read(lang);
    const hint = fact.docHints[lang];
    if (hint.trim() === "") {
      out.push(`${fact.id} 在 ${lang} 下的限定 token 是空串——空串永远查得到，这条断言从此空转`);
      continue;
    }
    const bodies = fact.docSections.map((h) => [h, sectionBody(src, h)] as const);
    for (const [heading, body] of bodies) {
      if (body === null) {
        out.push(`${lang}/API.md 里找不到小节「${heading}」——${fact.id} 的限定句该贴在哪里已经说不清了`);
      }
    }
    if (fact.status === "verified") {
      if (src.includes(hint)) {
        out.push(
          `${lang}/API.md 里还留着 ${fact.id} 的「未核实」限定句「${hint}」`
          + "——这条事实已经升级成 verified，五份文档里那句限定必须一并删掉，"
          + "否则文档会继续对读者说一件已经不成立的话",
        );
      }
      continue;
    }
    for (const [heading, body] of bodies) {
      if (body !== null && !body.includes(hint)) {
        out.push(
          `${lang}/API.md 的小节「${heading}」里缺 ${fact.id} 的限定句「${hint}」`
          + "——这条上游事实今天仍是假设，读者必须在他正要照抄的那段示例旁边看见这句话",
        );
      }
    }
  }
  return out;
}

describe("五语言 API.md 逐份写着「这条上游事实未经核实」", () => {
  // 反向自检：表空了的话下面那圈 `it.each` 一格都不跑，整组照绿。
  it("UPSTREAM_FACTS 不是空表，且每条事实的 docHints 语言集恰好等于本文件的 LANGS", () => {
    expect(UPSTREAM_FACTS.length, "登记表空了——下面整组会一格都不跑").toBeGreaterThan(0);
    // 期望值是本文件那张手写的 LANGS，不是从 docHints 自己数出来再回填：两份独立的
    // 语言清单互校，某一边少一种语言时这一格当场红，而不是让下面那圈循环静静少跑一种。
    const want = [...LANGS].sort();
    for (const fact of UPSTREAM_FACTS) {
      expect(Object.keys(fact.docHints).sort(), `${fact.id} 的 docHints 语言集与本文件的 LANGS 对不上`)
        .toEqual(want);
      expect(fact.docSections.length, `${fact.id} 没写 docSections——那样它的限定句贴在哪里都算数`)
        .toBeGreaterThan(0);
    }
  });

  it.each([...UPSTREAM_FACTS])("$id 的限定句在五份 API.md 的指名小节里逐份出现", (fact) => {
    const failures = factDocFailures(fact, realApiDoc);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /**
   * 探针一律从**真实那条事实**派生，不另造一个仓里不存在的世界。取的是第一条仍是
   * `assumed` 的事实：哪天有人把它升级成 `verified`，下面几格测的形态就变了，
   * 所以先有一条非空锚把这件事挑明。
   */
  const ASSUMED = UPSTREAM_FACTS.find((f) => f.status === "assumed");

  it("非空锚：表上至少还有一条 assumed 的事实，下面那几格探针才不是空转", () => {
    expect(ASSUMED, "表上一条 assumed 都没有了——下面几格探针要改测别的形态").toBeDefined();
  });

  const FIRST = ASSUMED!;

  /**
   * **探针的「基」取自真文档，于是真文档一漂，下面几格会跟着红在被测的那件事上。**
   * **这道闸加进来之前**复评实测过：把 `docs/ja/API.md` 的小节标题改一个字 ⇒ 除真扫描
   * 那一格之外，下面几格探针**跟着一起红，而它们的报文只有一句「报文：」**，把人往错的
   * 方向指（P3e 的老教训：报文可以亲手把人引进坑）。⇒ 每格先过这一道闸：真文档今天
   * 本身就不过判据的话，当场说清「先看真扫描那一格」，别让人从探针的报文里找原因。
   * **加进来之后**同一条变异重跑（回填时亲手跑的）：这一组红 **7** 格 —— 真扫描那一格
   * 是真因本身，**5 格探针的报文逐字点名「真因在哪一格」**，剩下一格是这道闸自己的
   * 自检（它的反向控制当场红，报文里带的正是这道闸的原话）。
   *
   * `read` 留成参数是为了让这道闸自己也能被打红——见「探针自检这道闸本身有牙」那一格。
   */
  function probeBase(fact: UpstreamFact, read: ApiDocReader = realApiDoc): void {
    const base = factDocFailures(fact, read);
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + `别从这一格的报文里找原因，真因在「${fact.id} 的限定句在五份 API.md 的指名小节里逐份出现」那一格：\n`
        + base.join("\n"),
      );
    }
  }

  it("探针自检这道闸本身有牙：真文档不过判据时，探针格报的是「先看真扫描那一格」", () => {
    // 变异取真文档：把指名小节的标题抹掉，`sectionBody()` 于是找不到它。
    const heading = `## ${FIRST.docSections[0]!}`;
    const broken: ApiDocReader = (lang) => realApiDoc(lang).split(heading).join("## (gone)");
    expect(broken("ja").includes(heading), "变异没落地 —— 这一格控制是空的").toBe(false);
    expect(() => probeBase(FIRST, broken)).toThrow("本格是探针");
    // 反向控制：真文档原样传进去时它一声不吭（这一格若红，说明真文档本身坏了）。
    expect(() => probeBase(FIRST, realApiDoc)).not.toThrow();
  });

  it("该红时红：某一种语言的限定句被删掉（其余四份不动）", () => {
    probeBase(FIRST);
    const hint = FIRST.docHints.ja;
    const failures = factDocFailures(FIRST, readerWith("ja", (s) => s.replace(hint, "")));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    for (const h of ["ja/API.md", FIRST.id, FIRST.docSections[0]!]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  it("该红时红：限定句被挪出指名小节——整份文档照旧查得到，小节内查不到", () => {
    probeBase(FIRST);
    const hint = FIRST.docHints.ko;
    // 挪到**文档标题之下、第一个 `## ` 之上**——那一片不属于任何小节。
    // 不用「追加到文件末尾」：那等于挪进最后一个小节，某些事实的指名小节恰好就是它。
    // ↓ 「最后一个小节的正文一直延伸到 EOF」是上面那句话的全部依据，在这里断言掉：
    //   哪天 `sectionBody()` 改成在别处收尾，这一格当场红，逼人回来改上面那段说明。
    {
      const src = realApiDoc("ko");
      const lastHeading = [...src.matchAll(/\n## (.+)\n/g)].at(-1)?.[1] ?? "";
      expect(lastHeading, "这一份文档里一个 `## ` 小节都没有 —— 下面这条断言什么都没证明").not.toBe("");
      const lastBody = sectionBody(src, lastHeading);
      expect(lastBody, `找不到最后那个小节「${lastHeading}」`).not.toBeNull();
      expect(
        lastBody !== null && src.endsWith(lastBody),
        "最后一个小节的正文没有延伸到 EOF —— 「追加到文件末尾 = 挪进最后一个小节」这句话不再成立，回去改上面那段说明",
      ).toBe(true);
    }
    const moved = (s: string) => {
      const t = s.replace(hint, "");
      const at = t.indexOf("\n");
      return `${t.slice(0, at + 1)}\n${hint}\n${t.slice(at + 1)}`;
    };
    // 先自证这条变异**不是**「把句子删了」：整份文档里那句话还在，
    // 换成整文件 `includes` 的判据这一格会当场变绿，而那正是 docSections 那一栏的理由。
    expect(moved(realApiDoc("ko")), "变异把句子整个删掉了——那测的是上一格，不是本格")
      .toContain(hint);
    const failures = factDocFailures(FIRST, readerWith("ko", moved));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "").toContain("ko/API.md");
    expect(failures[0] ?? "").toContain(FIRST.docSections[0]!);
  });

  it("该红时红：小节标题在某一份里对不上时会吵，不装作「这一份没写那句话」", () => {
    probeBase(FIRST);
    const heading = `## ${FIRST.docSections[0]!}`;
    const failures = factDocFailures(FIRST, readerWith("en", (s) => s.replace(heading, `${heading} (draft)`)));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "报文没说是「找不到小节」——那会把人指去补一句其实已经在的限定")
      .toContain("找不到小节");
  });

  it("该红时红：事实被升级成 verified，而五份文档里那句「未核实」一个都没删", () => {
    probeBase(FIRST);
    const upgraded: UpstreamFact = { ...FIRST, status: "verified" };
    const failures = factDocFailures(upgraded, realApiDoc);
    expect(failures.length, `报文：\n${failures.join("\n")}`).toBe(LANGS.length);
    expect(failures.join("\n")).toContain("必须一并删掉");
  });

  it("该红时红：限定 token 是空串时当场判死——空串永远查得到，那条断言会静静空转", () => {
    probeBase(FIRST);
    const blanked: UpstreamFact = { ...FIRST, docHints: { ...FIRST.docHints, en: "  " } };
    const failures = factDocFailures(blanked, realApiDoc);
    expect(failures.join("\n")).toContain("空串");
    // 反向控制：其余四种语言的 token 没动，它们一条都不许跟着红。
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
  });
});

/**
 * ── 五语言 API.md 里那条字符集硬闸（期望值从 `VIDEO_TASK_ID_SHAPE` 来）──────────
 *
 * 上面那组管的是「这条事实**没被核实过**」这句限定，**它一个字都没说网关到底收什么
 * 形状**。运维手里今天只有一个 400，而这条路是两段式的：标识由上游签发，读者除了
 * 逐个字符试没有别的办法。这一组把形状本身钉进五份文档的**指名小节**里。
 *
 * ⚠️ **期望值来自代码里那个派生常量，不是文档互校**（同 `FAIL_REASONS` 那条路）：
 * `VIDEO_TASK_ID_RE` 哪天从 `{1,128}` 改成 `{1,64}`，`VIDEO_TASK_ID_SHAPE` 当场跟着变，
 * 而五份文档还写着旧上界 ⇒ 这里五格一起红并逐份点名。文档互校在这一格是无效的
 *（五份一起挂着同一个旧上界，互相校验永远一致）。
 *
 * ── 它做不到什么（明写）────────────────────────────────────────────────────
 * 它只证明**那串形状逐字出现在那一份文档的那一个小节里**。形状旁边那句解释（哪一段是
 * 字符集、括号里是什么）译得对不对、读者看不看得懂，它一概不管，留给评审。
 * 「这个字符集本身对不对」更不在它射程内——那是一条未核实的上游假设。
 */
describe("五语言 API.md 逐份写着视频任务标识的字符集", () => {
  /**
   * 该贴在哪个小节，**不另写一份**：取的是 `UPSTREAM_FACTS` 里锚在 `VIDEO_TASK_ID_RE`
   * 上的那条事实的 `docSections` —— 它说的正是这条字符集，而它的 `anchor` 已经被
   * `tests/unit/admin/upstream-facts.test.ts` 的「真表逐条的锚都在它说的那个文件里」
   * 绑在真源上。在这里手写一个 `GET /v1/videos/{id}` 就是第二份会静静漂走的知识。
   */
  const CHARSET_FACTS = UPSTREAM_FACTS.filter((f) => f.anchor === "VIDEO_TASK_ID_RE");
  const SECTIONS: readonly string[] = CHARSET_FACTS[0]?.docSections ?? [];

  /**
   * 一条形状 × 五份 API.md 的指名小节。返回失败报文数组。真扫描与探针**共用这一份**。
   * **锚没了就当场判死**，不返回空数组：空数组会让下面整组静静全绿。
   */
  function shapeDocFailures(read: ApiDocReader): string[] {
    if (SECTIONS.length === 0) {
      return ["登记表上锚在 VIDEO_TASK_ID_RE 上的事实没了 —— 这一组不知道形状该贴在哪个小节，测的是空气"];
    }
    const out: string[] = [];
    for (const lang of LANGS) {
      const src = read(lang);
      for (const heading of SECTIONS) {
        const body = sectionBody(src, heading);
        if (body === null) {
          out.push(`${lang}/API.md 里找不到小节「${heading}」——任务标识的字符集该写在哪里已经说不清了`);
          continue;
        }
        if (!body.includes(VIDEO_TASK_ID_SHAPE)) {
          out.push(
            `${lang}/API.md 的小节「${heading}」里没有逐字写明任务标识的形状「${VIDEO_TASK_ID_SHAPE}」`
            + "——运维在文档里查不到这条约束，只能从一个 400 里猜网关到底收什么",
          );
        }
      }
    }
    return out;
  }

  it("非空锚：登记表上锚在 VIDEO_TASK_ID_RE 上的事实恰好一条，下面几格才不是空转", () => {
    expect(
      CHARSET_FACTS.map((f) => f.id),
      "锚在 VIDEO_TASK_ID_RE 上的事实不是恰好一条 —— 形状该贴在哪个小节已经说不清了",
    ).toHaveLength(1);
  });

  it("五份 API.md 的指名小节里都逐字写明了任务标识的形状", () => {
    const failures = shapeDocFailures(realApiDoc);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /** 与上面那组同一条闸、同一个理由：真文档本身不过判据时，别让人从探针的报文里找原因。 */
  function probeShapeBase(read: ApiDocReader = realApiDoc): void {
    const base = shapeDocFailures(read);
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「五份 API.md 的指名小节里都逐字写明了任务标识的形状」那一格：\n"
        + base.join("\n"),
      );
    }
  }

  it("探针自检这道闸本身有牙：真文档不过判据时，探针格报的是「先看真扫描那一格」", () => {
    const broken: ApiDocReader = (lang) => realApiDoc(lang).split(VIDEO_TASK_ID_SHAPE).join("(某个形状)");
    expect(broken("en").includes(VIDEO_TASK_ID_SHAPE), "变异没落地 —— 这一格控制是空的").toBe(false);
    expect(() => probeShapeBase(broken)).toThrow("本格是探针");
    expect(() => probeShapeBase(realApiDoc)).not.toThrow();
  });

  it("该红时红：某一种语言里那段形状被删掉（其余四份不动）", () => {
    probeShapeBase();
    const failures = shapeDocFailures(readerWith("ja", (s) => s.replace(VIDEO_TASK_ID_SHAPE, "")));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    for (const h of ["ja/API.md", VIDEO_TASK_ID_SHAPE, SECTIONS[0]!]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  /**
   * 这一格是「把长度上界一起从正则派生」那条设计的**测法**：翻译时抄错一位数字，
   * 或者改了正则却只改了四份文档，形态都长这样。手抄一份形状字面量的话，
   * 这种漂移在代码侧一点痕迹都没有。
   */
  it("该红时红：某一份把形状里的长度上界抄错了一位", () => {
    probeShapeBase();
    const typo = VIDEO_TASK_ID_SHAPE.replace(/(\d+)\)$/, (_m, n: string) => `${Number(n) - 1})`);
    expect(typo, "变异串与原串相同 —— 这一格控制是空的").not.toBe(VIDEO_TASK_ID_SHAPE);
    const failures = shapeDocFailures(readerWith("ko", (s) => s.replace(VIDEO_TASK_ID_SHAPE, typo)));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "").toContain("ko/API.md");
  });

  it("该红时红：形状被挪出指名小节——整份文档照旧查得到，小节内查不到", () => {
    probeShapeBase();
    // 挪到**文档标题之下、第一个 `## ` 之上**那一片不属于任何小节的地方。
    // 「别用追加到文件末尾」的理由与上面那组逐字相同（末尾属于最后一个小节）。
    const moved = (s: string) => {
      const t = s.replace(VIDEO_TASK_ID_SHAPE, "(形状搬走了)");
      const at = t.indexOf("\n");
      return `${t.slice(0, at + 1)}\n${VIDEO_TASK_ID_SHAPE}\n${t.slice(at + 1)}`;
    };
    expect(moved(realApiDoc("zh-TW")), "变异把形状整个删掉了——那测的是上一格，不是本格")
      .toContain(VIDEO_TASK_ID_SHAPE);
    const failures = shapeDocFailures(readerWith("zh-TW", moved));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "").toContain("zh-TW/API.md");
  });

  it("该红时红：小节标题在某一份里对不上时会吵，不装作「这一份没写形状」", () => {
    probeShapeBase();
    const heading = `## ${SECTIONS[0]!}`;
    const failures = shapeDocFailures(readerWith("zh-CN", (s) => s.replace(heading, `${heading} (draft)`)));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "报文没说是「找不到小节」——那会把人指去补一句其实已经在的形状")
      .toContain("找不到小节");
  });
});

/**
 * ── 派生结构判据 R1–R6：判据从文件本身长出来，不再靠人记得回来加锚点 ──────────
 *
 * 上面那组数字锚点每加一段文档就要有人**记得**回来加一个 token，正是本仓
 * 「一个不会自己红的清单不是守卫，是待办」。证据是决定性的：`docs/ko/DEPLOY.md`
 * 里那句其余四语言早已删掉的 `POOL_CACHE_TTL_MS` 操作建议**活了 3 天、跨了两期
 * 评审**，二十余格全绿、十二道门禁全绿，没有任何东西响过一声。
 *
 * 下面这一组不比对任何人手写的清单，只比对**从五份文件各自派生出来的结构指纹**：
 * 文档基名全集（R1）、heading 层级序列（R2）、代码围栏语言标记序列（R3）、
 * 归一化后的链接目标多重集（R4）、以 `|` 开头的表格行数（R5）、
 * 标识符型行内 code span 多重集（R6）。加一份新文档、加一段新小节、多一行表格、
 * 某一份多写一个环境变量名——**没有人需要回来表态**，它自己就红。
 *
 * ⚠️ **与上面那组数字锚点是互补不是重复，那些锚点一个都不许删**：数字锚点管
 * 「同一个数字五份写得一样」，结构判据管「结构对得上」。某一份把 `856` 抄成
 * `865`，五份的结构指纹**逐字节相同**，R1–R6 全绿。反过来，某一份多一段没翻译
 * 的小节，数字锚点也可能一个都不动。两组各管各的一半。
 * ⚠️ 后续任务改 DEPLOY.md 会让锚点计数变动 ⇒ **改文档必须同步改锚点**，这是好事，
 * 但要预期到。
 *
 * ⚠️ **期望值来源沿用本文件既有先例，不是自创**：期望值来自**其余四份独立维护
 * 的文档**，一份被改坏就会与另外四份分叉。这不算本文件登记的第 6 种假阳性（期望
 * 值从被测对象自己 grep 回填）——论证与上面「修法：从『各自 ≥ N 次』改成『五种
 * 语言的出现次数彼此相等』」那一段**逐字相同**，请连同那一段一起读。
 * **唯一挡不住的仍然是「五份被同一个错误同步污染」**，边界与那一段完全一样。
 *
 * ⚠️ **R6 的正则窄到三类（全大写常量 / 斜杠开头的路径 / `agnes-` 开头的模型名），
 * 一放宽就从守卫变成纯噪声源**：本仓的公式恰恰写在 code span 里，而公式里的名词
 * 本来就该被翻译（zh-CN `key 数 × 4` / en `pool size × 4` / ko `key 수 × 4`）。
 * 「为什么不多管一点」这个问题的答案**刻意不写成一句话**，而是两条会自己变红的
 * 用例：下面「R6 的窄判据不是随手定的」把放宽之后的噪声当场列出来；反向控制那格
 * 拿这三个真串证明伪公式确实不进判据。
 * ⭐ 勘察当日曾把「放宽之后多出多少项差异」的计数写进本段当理由，**落地复核时三个
 * 数一个都没对上**。「注释里抄一份计数」天生会过期，本仓已因此漂过多次（上一个
 * 提交刚修过一处同类的），所以这里连同复核出来的新数字一起都不留：**能变红的是
 * 下面那条用例，不是这段话**，要数字就当场自己数一遍，别信注释。
 *
 * ⚠️ **不许把它挪成一个独立的门禁脚本 + 新增一道 CI 步骤**：那会让
 * `tests/unit/scripts-guard.test.ts「CI 恰好十二道门，编号 1/12 到 12/12 各出现一次」` 当场红，
 * 代价要么是改那条手写字面量（削弱一道现存守卫），要么是把新门禁塞进已有步骤里
 * 假装不是新的。放进 CI 跑 `pnpm test` 那一步的 vitest 里零副作用。
 *
 * ── 它做不到什么（明写，别读成「五语言对等由测试保证」）──────────────────────
 * 它只证明**五份的结构骨架一样**，不证明任何一份说得对：五份同时漏掉一个小节、
 * 五份把同一个链接一起指错、某一份把整段话翻译反了但一个 `#` 都没动——它全都
 * 看不见。R6 更是只看标识符：句子里的名词、语气、乃至结论正反，它一概不管。
 * 译文是否准确、语义是否同义，仍然只能靠评审。
 */

/** R2：heading 层级序列（只取 # 的个数，不取标题文本——文本本来就该被翻译）。 */
const headings = (s: string) =>
  s.split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => (l.match(/^#+/)?.[0] ?? "").length);

/** R3：代码围栏的语言标记序列。 */
const fences = (s: string) => [...s.matchAll(/^```(\w*)/gm)].map((m) => m[1] ?? "");

/** R4：归一化后的链接目标多重集（`../<lang>/` → `../LANG/`，锚点归一为 `#`）。 */
const links = (s: string) =>
  [...s.matchAll(/\]\(([^)]+)\)/g)]
    .map((m) => (m[1] ?? "").replace(/\.\.\/(zh-CN|zh-TW|en|ja|ko)\//g, "../LANG/").replace(/#.*$/, "#"))
    .sort();

/** R5：以 `|` 开头的表格行数。 */
const tableRows = (s: string) => s.split("\n").filter((l) => l.trimStart().startsWith("|")).length;

/** 行内 code span 的全量多重集——只给下面那条「放宽会变噪声」的用例用，不是判据。 */
const codeSpans = (s: string) => [...s.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "").sort();

/** R6 的三类标识符：全大写常量 / 斜杠开头的路径 / `agnes-` 开头的模型名。 */
const IDENTIFIER = /^(?:[A-Z][A-Z0-9_]{2,}|\/[^\s`]*|agnes-[^\s`]*)$/;

/** R6：标识符型行内 code span 的多重集。 */
const idents = (s: string) => codeSpans(s).filter((c) => IDENTIFIER.test(c));

/**
 * 文档基名全集。**它不是手写清单，是从磁盘派生再钉住**：加了新文档不进表 = 红，
 * 表里有磁盘上没有的 = 红。
 *
 * ⚠️ Task 9 落地时这张表是五项（不含 `ADMIN`），它当时留下的原话是「`ADMIN.md` 由后续
 * 任务创建，那时把 `"ADMIN"` 加进来，**R1 的第一条断言会强制那一步**（不加就红）」。
 * P3e Task 26 落地五份 `ADMIN.md` 时先复现了那条测法：**只把 `"ADMIN"` 加进本表、
 * 一份文件都不写** ⇒ R1 当场红并逐字点名
 * 「磁盘 [...] 表 [...ADMIN...]」，`DOCS` 表这一条不是靠人记得回来加。
 */
const DOCS = ["ADMIN", "API", "DEPLOY", "README", "REGISTRAR", "USAGE"] as const;

const RULES: ReadonlyArray<readonly [name: string, fingerprint: (s: string) => unknown]> = [
  ["R2 heading 层级序列", headings],
  ["R3 代码围栏语言标记序列", fences],
  ["R4 归一化后的链接目标多重集", links],
  ["R5 以竖线开头的表格行数", tableRows],
  ["R6 标识符型 code span 多重集", idents],
];

const docPath = (root: string, lang: string, doc: string) => join(root, "docs", lang, `${doc}.md`);

/**
 * R1。返回失败报文或 `null`。
 * **真扫描与反向控制共用这一份**——探针与被探的东西必须是同一段代码，否则探针绿了
 * 什么都不证明。
 */
function inventoryFailure(root: string, table: readonly string[]): string | null {
  const onDisk = readdirSync(join(root, "docs", "zh-CN"))
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.replace(/\.md$/, ""))
    .sort();
  const want = [...table].sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(want)) {
    return `R1 docs/zh-CN 下的文档集与 DOCS 表对不上——加了新文档要回来表态：磁盘 ${JSON.stringify(onDisk)}，表 ${JSON.stringify(want)}`;
  }
  const missing = table.flatMap((d) => LANGS.filter((l) => !existsSync(docPath(root, l, d))).map((l) => `${l}/${d}.md`));
  return missing.length ? `R1 这些语言缺同名文档：${missing.join("、")}` : null;
}

const countBy = (a: readonly unknown[]) => {
  const m = new Map<string, number>();
  for (const x of a) {
    const k = JSON.stringify(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};

const firstDiff = (a: readonly unknown[], b: readonly unknown[]) => {
  for (let k = 0; k < Math.max(a.length, b.length); k += 1) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return k;
  }
  return -1;
};

/**
 * 摊一个下标上的值，**越界时说「越界」而不是把 `undefined` 抄进报文**。
 *
 * ⚠️ 这是复评 F9 抓到的：两侧长度不同时 `firstDiff` 返回的正是**短的那一侧的长度**
 *（一份多写一个 `##`，多重集差一项、首个不同的下标恰好落在参照的末尾之后），
 * 而 `JSON.stringify(undefined)` 返回的是 `undefined` 这个值本身，模板串里就成了
 * 字面的 `参照 undefined`。**报文是唯一会被看见的护栏**——一个 `undefined` 会让人
 * 以为判据自己坏了，而真相是「参照那边根本没有这一项」。
 * 测法在下面「分叉报文：首个不同的下标越界时…」那两格（正向 + 不乱红各一）。
 */
const cellAt = (a: readonly unknown[], i: number) =>
  i >= 0 && i < a.length ? JSON.stringify(a[i]) : `（越界，这一侧只有 ${a.length} 项）`;

/**
 * 分叉报文：**只摊差异，不摊全集**。
 *
 * ⚠️ 第一版把五份指纹整个 `JSON.stringify` 摊进报文，实跑一看是灾难：DEPLOY.md 的
 * R6 有一百多项，唯一那处分叉（ko 多写了一个 `POOL_CACHE_TTL_MS`）被埋在五坨各
 * 一百多项的数组里，肉眼根本找不到。**报文是唯一会被看见的护栏**——摊不出差异的
 * 报文等于没有报文。改成：少数服从多数取参照份，只列出偏的那一份「多出/少掉了
 * 什么」，再补一个首个不同的下标（heading 与围栏是有序序列，多重集相同而顺序不同
 * 时只有下标说得清）。
 */
function divergenceReport(labels: readonly string[], values: readonly unknown[]): string | null {
  const rows = values.map((v) => JSON.stringify(v));
  if (new Set(rows).size === 1) return null;
  const head = values[0];
  if (!Array.isArray(head)) return labels.map((l, i) => `  ${l}: ${rows[i]}`).join("\n");

  const tally = countBy(values);
  const majority = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? rows[0]!;
  const refArr = JSON.parse(majority) as unknown[];
  const ref = countBy(refArr);

  const out: string[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    if (rows[i] === majority) continue;
    const arr = values[i] as unknown[];
    const mine = countBy(arr);
    const delta = [...new Set([...ref.keys(), ...mine.keys()])]
      .sort()
      .filter((k) => (ref.get(k) ?? 0) !== (mine.get(k) ?? 0))
      .map((k) => `${k} ${ref.get(k) ?? 0}→${mine.get(k) ?? 0}`);
    const at = firstDiff(refArr, arr);
    out.push(
      `  ${labels[i]}（本份 ${arr.length} 项，参照的 ${tally.get(majority)} 份 ${refArr.length} 项）：` +
        (delta.length > 0 ? `多出/少掉 ${delta.join("，")}；` : "多重集相同但顺序不同；") +
        `首个不同的下标 ${at}（参照 ${cellAt(refArr, at)} / 本份 ${cellAt(arr, at)}）`,
    );
  }
  return out.join("\n");
}

/** R2–R6 的单格：一份文档 × 一条判据。返回失败报文或 `null`。真扫描与反向控制共用这一份。 */
function parityFailure(root: string, doc: string, name: string, fingerprint: (s: string) => unknown): string | null {
  const body = divergenceReport(LANGS, LANGS.map((l) => fingerprint(readFileSync(docPath(root, l, doc), "utf8"))));
  return body === null ? null : `${doc}.md 的「${name}」在五语言之间分叉：\n${body}`;
}

/** R6 扩展：根 README 与五语言 README 六份。返回失败报文或 `null`。 */
function rootReadmeFailure(root: string): string | null {
  const six = [join(root, "README.md"), ...LANGS.map((l) => docPath(root, l, "README"))];
  const body = divergenceReport(six, six.map((p) => idents(readFileSync(p, "utf8"))));
  return body === null ? null : `R6 扩展 根 README 与五语言 README 的标识符 code span 分叉：\n${body}`;
}

/**
 * 反向控制的唯一入口：R1 + 五条判据 × 全部文档 + 根 README 一次跑完。
 * R1 不过就直接返回——文件都缺了，再去读它只会 ENOENT，报文反而更差。
 */
function allFailures(root: string, table: readonly string[]): string[] {
  const inv = inventoryFailure(root, table);
  if (inv) return [inv];
  const out: string[] = [];
  for (const doc of table) {
    for (const [name, f] of RULES) {
      const m = parityFailure(root, doc, name, f);
      if (m) out.push(m);
    }
  }
  const rr = rootReadmeFailure(root);
  if (rr) out.push(rr);
  return out;
}

describe("五语言文档的派生结构对等（R1–R6）", () => {
  it("R1 五个语言目录下同名文件都存在，且 DOCS 表恰好等于 zh-CN 目录的 .md 全集", () => {
    const failure = inventoryFailure(".", DOCS);
    expect(failure, failure ?? "").toBeNull();
  });

  for (const doc of DOCS) {
    for (const [name, fingerprint] of RULES) {
      it(`${doc}.md 的「${name}」五份逐份相同`, () => {
        const failure = parityFailure(".", doc, name, fingerprint);
        expect(failure, failure ?? "").toBeNull();
      });
    }
  }

  it("R6 扩展：根 README.md 与五语言 README.md 的标识符 code span 多重集六份相同", () => {
    const failure = rootReadmeFailure(".");
    expect(failure, failure ?? "").toBeNull();
  });

  /**
   * 「为什么不多管一点」的可执行答案之一。这条会自己变红：哪天全量 code span 在
   * 五语言之间不再分叉了（伪公式被统一成语言无关的写法），说明放宽 `IDENTIFIER`
   * 的代价没了，那时回来重新评估，别让理由继续挂着。
   */
  it("R6 的窄判据不是随手定的：放宽到全量 code span 会立刻变成噪声源", () => {
    const noisy = DOCS.filter(
      (doc) => new Set(LANGS.map((l) => JSON.stringify(codeSpans(readFileSync(docPath(".", l, doc), "utf8"))))).size !== 1,
    );
    expect(
      noisy,
      "全量 code span 判据今天在五语言之间不再分叉了——伪公式看来已经统一写法，回来重新评估 IDENTIFIER 是否还需要这么窄",
    ).not.toEqual([]);
  });
});

/**
 * ── R1–R6 的反向控制：该红时真的红，只有译文不同时不乱红 ─────────────────────
 *
 * 「我认得出 X」的断言必须配一条「我对 X 不乱红」的反向控制，而且**串一律取仓里
 * 真实存在的那些**——编一个仓里不存在的串等于在测一个不存在的世界。夹具用的四个
 * 标识符（`GATEWAY_TOKEN` / `POOL_CACHE_TTL_MS` / `/v1/messages` / `agnes-2.0-flash`）
 * 分别覆盖 `IDENTIFIER` 的三个分支，伪公式那一族取的是五份 DEPLOY.md 里的原句，
 * 下面第一条用例逐份去真文档里核对它们确实存在。
 */
describe("R1–R6 的反向控制（临时目录夹具）", () => {
  /** 夹具里的译文差异——结构必须完全相同，只有这些串随语言变。 */
  const PROSE: Record<Lang, { title: string; section: string; note: string; formula: string; link: string }> = {
    "zh-CN": { title: "网关部署", section: "环境变量", note: "必填", formula: "key 数 × 4", link: "用法" },
    "zh-TW": { title: "閘道部署", section: "環境變數", note: "必填", formula: "key 數 × 4", link: "用法" },
    en: { title: "Gateway deployment", section: "Environment variables", note: "required", formula: "pool size × 4", link: "Usage" },
    ja: { title: "ゲートウェイ配備", section: "環境変数", note: "必須", formula: "key 数 × 4", link: "使い方" },
    ko: { title: "게이트웨이 배포", section: "환경 변수", note: "필수", formula: "key 수 × 4", link: "사용법" },
  };

  /** 结构完全相同、只有译文不同的一份假文档。 */
  function fixtureDoc(lang: Lang, doc: string): string {
    const p = PROSE[lang];
    return [
      `# ${p.title} · ${doc}`,
      "",
      `\`GATEWAY_TOKEN\` ${p.note}。`,
      "",
      `## ${p.section}`,
      "",
      `| ${p.section} | ${p.note} |`,
      "| --- | --- |",
      "| `POOL_CACHE_TTL_MS` | `60000` |",
      "",
      `### ${p.link}`,
      "",
      `\`/v1/messages\` + \`agnes-2.0-flash\`，${p.note} \`${p.formula}\`。`,
      "",
      "```bash",
      "curl http://localhost:8080/v1/messages",
      "```",
      "",
      `[${p.link}](../${lang}/USAGE.md#${p.section})`,
      "",
    ].join("\n");
  }

  type Tree = Record<string, string>;

  function pristineTree(): Tree {
    const files: Tree = { "README.md": fixtureDoc("zh-CN", "README") };
    for (const doc of DOCS) for (const l of LANGS) files[`docs/${l}/${doc}.md`] = fixtureDoc(l, doc);
    return files;
  }

  /** 路径打错 = 变异没落地 = 这一格控制是空的。当场炸掉，不许静默通过。 */
  function patch(files: Tree, rel: string, f: (body: string) => string): void {
    const body = files[rel];
    if (body === undefined) throw new Error(`夹具里没有 ${rel}——变异没落到任何文件上`);
    files[rel] = f(body);
  }

  function drop(files: Tree, rel: string): void {
    if (files[rel] === undefined) throw new Error(`夹具里没有 ${rel}——删除没落到任何文件上`);
    delete files[rel];
  }

  /** 把一棵假文档树落到临时目录，交给上面那批**同款**判据函数去扫。 */
  function scanFixture(mutate: (files: Tree) => void): string[] {
    const files = pristineTree();
    mutate(files);
    const root = mkdtempSync(join(tmpdir(), "a2a-docs-parity-"));
    try {
      for (const [rel, body] of Object.entries(files)) {
        const full = join(root, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, body, "utf8");
      }
      return allFailures(root, DOCS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("反向控制用的串必须是仓里真实存在的：五种语言的伪公式逐份能在真 DEPLOY.md 里找到", () => {
    const missing = LANGS.filter((l) => !readFileSync(docPath(".", l, "DEPLOY"), "utf8").includes(`\`${PROSE[l].formula}\``));
    expect(missing, "夹具编了仓里不存在的串——造一个不存在的世界，这组控制就什么都没证明").toEqual([]);
  });

  it("反向控制用的标识符也必须是仓里真实存在的，且三个分支都覆盖到", () => {
    const used = ["GATEWAY_TOKEN", "POOL_CACHE_TTL_MS", "/v1/messages", "agnes-2.0-flash"];
    expect(used.filter((c) => !IDENTIFIER.test(c)), "夹具里的标识符没被 IDENTIFIER 认出来").toEqual([]);
    const absent = used.filter(
      (c) => !DOCS.some((d) => LANGS.every((l) => readFileSync(docPath(".", l, d), "utf8").includes(`\`${c}\``))),
    );
    expect(absent, "这些串在真文档里五语言并不齐全，拿它们当夹具是在测一个不存在的世界").toEqual([]);
  });

  /**
   * `hits` 是**报文里必须出现的串**，不是随便一个占位：每条都要求报文同时点名
   * 「哪一条判据 + 哪一份文档 + 哪一种语言 + 坏掉的那个东西」。只断言"红了"不够
   * ——**报文是唯一会被看见的护栏**，红了却指不出地方等于把定位成本原样退回给人。
   */
  const MUTATIONS: ReadonlyArray<{ why: string; hits: readonly string[]; mutate: (f: Tree) => void }> = [
    {
      why: "R1 少一份 docs/ko/USAGE.md",
      hits: ["R1 这些语言缺同名文档：ko/USAGE.md"],
      mutate: (f) => drop(f, "docs/ko/USAGE.md"),
    },
    {
      why: "R1 多一份没进 DOCS 表的 docs/zh-CN/GLOSSARY.md",
      hits: ["R1 docs/zh-CN 下的文档集与 DOCS 表对不上", "GLOSSARY"],
      mutate: (f) => { f["docs/zh-CN/GLOSSARY.md"] = fixtureDoc("zh-CN", "GLOSSARY"); },
    },
    {
      why: "R1 反方向：表里有磁盘上没有的（五份 USAGE.md 一起删）",
      hits: ["R1 docs/zh-CN 下的文档集与 DOCS 表对不上", "USAGE"],
      mutate: (f) => { for (const l of LANGS) drop(f, `docs/${l}/USAGE.md`); },
    },
    {
      why: "R2 某一份多一个 ###",
      // ⚠️ `越界` 这一项是复评 F9 的落点：ja 比参照多一项，`firstDiff` 返回的下标恰好
      // 落在参照的末尾之后。修之前这里印的是字面的 `参照 undefined`。
      hits: ["API.md 的「R2", "ja", "越界，这一侧只有"],
      mutate: (f) => patch(f, "docs/ja/API.md", (b) => `${b}\n### 追加\n`),
    },
    {
      why: "R3 某一份把 bash 围栏写成 sh",
      hits: ["DEPLOY.md 的「R3", "en", "sh"],
      mutate: (f) => patch(f, "docs/en/DEPLOY.md", (b) => b.replace("```bash", "```sh")),
    },
    {
      why: "R4 某一份的链接目标被改掉",
      hits: ["README.md 的「R4", "ko", "API.md#"],
      mutate: (f) => patch(f, "docs/ko/README.md", (b) => b.replace("USAGE.md#", "API.md#")),
    },
    {
      why: "R5 某一份多一行表格",
      hits: ["REGISTRAR.md 的「R5", "zh-TW"],
      mutate: (f) => patch(f, "docs/zh-TW/REGISTRAR.md", (b) => `${b}\n| a | b |\n`),
    },
    {
      why: "R6 某一份把 POOL_CACHE_TTL_MS 多写一次",
      hits: ["USAGE.md 的「R6", "zh-CN", "POOL_CACHE_TTL_MS"],
      mutate: (f) => patch(f, "docs/zh-CN/USAGE.md", (b) => `${b}\n再提一次 \`POOL_CACHE_TTL_MS\`。\n`),
    },
    {
      why: "R6 扩展 根 README.md 与五语言 README.md 分叉",
      hits: ["R6 扩展 根 README 与五语言 README 的标识符 code span 分叉", "README.md", "GATEWAY_TOKEN"],
      mutate: (f) => patch(f, "README.md", (b) => `${b}\n根上多提一次 \`GATEWAY_TOKEN\`。\n`),
    },
  ];

  for (const { why, hits, mutate } of MUTATIONS) {
    it(`该红时红：${why}`, () => {
      const failures = scanFixture(mutate);
      // 恰好一条：变异只该点名它坏掉的那一条判据。多出来的说明判据之间在互相串扰，
      // 报文会指向错的地方；一条都没有说明这条控制是空的。
      expect(failures, `变异「${why}」应当只让一条判据变红`).toHaveLength(1);
      const report = failures[0] ?? "";
      expect(
        hits.filter((h) => !report.includes(h)),
        `变红了但报文没点名这些东西——报文是唯一会被看见的护栏。实际报文：\n${report}`,
      ).toEqual([]);
    });
  }

  it("不乱红：只有译文不同、结构相同的五份文档全绿——被翻译的伪公式 code span 确实不进 R6", () => {
    // 先自检夹具不是平凡的：五种语言的伪公式真的写得不一样，否则这一格什么都没证明。
    expect(new Set(LANGS.map((l) => PROSE[l].formula)).size, "夹具里的伪公式五份写法相同，这条控制是空的").toBeGreaterThan(1);
    expect(
      LANGS.filter((l) => IDENTIFIER.test(PROSE[l].formula)),
      "夹具里的伪公式被 IDENTIFIER 认成了标识符，这条控制证明不了「伪公式不进判据」",
    ).toEqual([]);
    expect(scanFixture(() => {}), "结构相同、只有译文不同的五份文档不该有任何一条判据变红").toEqual([]);
  });

  /**
   * 复评 F9 的两格：**报文里不许出现字面的 `undefined`**。
   * 上面那条「R2 某一份多一个 `###`」的 `hits` 已经在真夹具上钉着同一件事，这里再直接
   * 对 `divergenceReport()` 打两枪，是因为那条走的是整棵夹具树、失败时不容易看清是
   * 哪一段字符串出的问题；这两格把正向（越界）与不乱红（不越界）分开摆着。
   */
  it("分叉报文：首个不同的下标越界时说「越界」，不许把 undefined 抄进报文", () => {
    const report = divergenceReport(
      [...LANGS],
      [[1, 2], [1, 2], [1, 2], [1, 2], [1, 2, 3]],
    ) ?? "";
    expect(report, "五份里有一份多一项，报文却是空的——这一格控制是空的").not.toBe("");
    expect(report, `报文里出现了字面的 undefined：\n${report}`).not.toContain("undefined");
    expect(report, `越界那一侧没被说清楚：\n${report}`).toContain("越界，这一侧只有 2 项");
  });

  it("不乱红：两侧长度相同、只是某一项不一样时，报文照常摊出两边的值，不说「越界」", () => {
    const report = divergenceReport(
      [...LANGS],
      [[1, 2], [1, 2], [1, 2], [1, 2], [1, 9]],
    ) ?? "";
    expect(report, "五份里有一份改了一项，报文却是空的——这一格控制是空的").not.toBe("");
    expect(report, `长度相同却说成越界：\n${report}`).not.toContain("越界");
    expect(report, `没摊出首个不同的下标上的两个值：\n${report}`).toContain("参照 2 / 本份 9");
  });
});

/**
 * ── 软化词表：「一条软化概念 × 五种语言」的矩阵 ──────────────────────────────
 *
 * P3d 立的红线：**真机了结之前，任何文案都不许把一个从没量过的上限写成「足够 / 安全」**。
 * 它今天有两个消费者，**共用这一张表**：
 * · 五份 ADMIN.md 的**整份**扫描（Task 26A）；
 * · 五份 DEPLOY.md 里那两笔「没在真机上了结过」的配额账，**逐段**扫描（Task 28 复评 H3）。
 *
 * ⚠️ **两处必须共用同一张表，这不是省代码**：这张表历史上漏过两次（繁体「足夠/夠用」、
 * 韩文「안전」都是复评实测逃逸之后才补的）。各留一份的话，下一次补词只会补到其中一边，
 * 另一边继续瞎，而且不会有任何东西告诉你它瞎了。
 * 表的完备性（每条概念五种语言都得有说法）由下面 ADMIN 那一组的
 * 「软化词表是「概念 × 语言」的矩阵……」与紧跟着的「该红时红：把某条概念的某种语言清空」
 * 两格钉着——那两格钉的就是这张表，搬到模块作用域之后仍然是同一个对象。
 */

/** 一条**软化概念**在五种语言里各自的说法。同一条概念可以有多个同义词。 */
interface SoftenerConcept {
  readonly id: string;
  readonly words: Record<Lang, readonly string[]>;
}

const SOFTENER_CONCEPTS: readonly SoftenerConcept[] = [
  {
    id: "enough",
    words: {
      "zh-CN": ["足够", "够用"],
      // ⚠️ 繁体这两个是复评实测逃逸后补的：第一版平表里只有简体，
      // 「這個上限足夠了，也夠用。」当时 117/117 全绿。
      "zh-TW": ["足夠", "夠用"],
      en: ["enough"],
      ja: ["十分"],
      ko: ["충분"],
    },
  },
  {
    id: "safe",
    // ⚠️ ko 的「안전」同样是复评实测逃逸后补的：「이 상한은 안전합니다.」当时全绿。
    words: { "zh-CN": ["安全"], "zh-TW": ["安全"], en: ["safe"], ja: ["安全"], ko: ["안전"] },
  },
  {
    id: "no-problem",
    words: {
      "zh-CN": ["没问题"],
      "zh-TW": ["沒問題"],
      en: ["no problem"],
      ja: ["問題な"],
      ko: ["문제없"],
    },
  },
];

/**
 * 打平：小写词 → 它是「哪条概念的哪种语言说法」（同一个词可能被多条命中，
 * 比如「安全」同时是 zh-CN / zh-TW / ja 的说法）。**去重是必须的**：不去重的话
 * 一次命中会产出三条失败，下面那些 `toHaveLength(1)` 会变成在数词表里的重复数。
 */
const SOFTENER_ORIGINS = ((): ReadonlyMap<string, readonly string[]> => {
  const m = new Map<string, string[]>();
  for (const c of SOFTENER_CONCEPTS) {
    for (const lang of LANGS) {
      for (const w of c.words[lang]) {
        const key = w.toLowerCase();
        m.set(key, [...(m.get(key) ?? []), `${c.id}/${lang}`]);
      }
    }
  }
  return m;
})();

const SOFTENER_WORDS: readonly string[] = [...SOFTENER_ORIGINS.keys()];

/**
 * 一段文本里命中的全部软化词。**ADMIN.md 那一组与 DEPLOY.md 那一组共用这一份判据**。
 * **射程是全部语言的全部词**（不是「这一份只查它自己语言的词」）：一份英文文档里
 * 冒出一个「충분」同样是错的，按语言分开查会把这类漏掉。
 */
function softenerHits(text: string): ReadonlyArray<{ word: string; origins: readonly string[] }> {
  const lower = text.toLowerCase();
  return SOFTENER_WORDS
    .filter((w) => lower.includes(w))
    .map((w) => ({ word: w, origins: SOFTENER_ORIGINS.get(w) ?? [] }));
}

/**
 * ── 五份 ADMIN.md 的措辞与数字守卫（P3e Task 26）─────────────────────────────
 *
 * R1–R6 只证明五份的**结构骨架**一样，句子里说了什么它们一无所知（那段边界写在
 * R1–R6 上方，别读成别的意思）。这一组管的是 ADMIN.md 特有的五件事。
 *
 * ── ① 软化词表：**概念 × 语言的矩阵**，不是一张平表 ──────────────────────────
 * 面板文档最容易犯的错，是把一件**本仓从没量过**的事写成「足够 / 安全」。这不是洁癖：
 * `admin-ui/js/pure/playground.mjs` 自己登记着「5 分钟 / 60 次对真实的视频生成可能
 * 偏短……本仓从来没有量过」，`admin-ui/js/pure/usage.mjs` 的 `RANGES` 上方登记着
 * 「30 天这一档在 Cloudflare Worker 上是否总能完成，真机未验」。⇒ 五份 ADMIN.md 里
 * 一个软化词都不许有；能写的只有上限本身。
 *
 * ⚠️⚠️ **这张表的形状是复评回填时改的，改的理由是它真的漏了两种语言**：第一版照抄
 * 需求书，是一张八个词的**平表**（简体「足够/够用」+「安全/enough/safe/十分/충분/
 * 問題な」）。复评把「這個上限足夠了，也夠用。」塞进 `docs/zh-TW/ADMIN.md`、把
 * 「이 상한은 안전합니다.」塞进 `docs/ko/ADMIN.md`，**117 格全绿放行**——繁体的
 * 「足夠/夠用」、韩文的「안전」一个都不在表里。这正是本文件开头登记的 P3a 教训
 *（简体 grep 漏繁体「保證」）在同一个文件里复发。**需求书也会错**，实测优先。
 * 修法不是往平表里补两个词（下一个漏的还是没人知道），而是**把表改成「一条软化概念
 * × 五种语言」的矩阵**，并加一格强制「每条概念五种语言都得有说法」——这样「某种语言
 * 在某条概念下是瞎的」从可能变成当场红。
 *
 * ⚠️ **反向控制也跟着改了口径**：原来那格要求**每一个词**都能在 `docs/` 下（含
 * `docs/design/`）找到出处。它有两个毛病：① `docs/design/` 里那份需求书**逐字抄着
 * 这张词表**，于是「这个词是真串」这件事可以被需求书自己满足，等于挡空气；
 * ② 更要命的是它**把表往窄里推**——「夠用」「no problem」在真文档里确实一次都没出现，
 * 照那条控制就只能把它们删掉，而「表太窄」正是这一轮出事的根因。改成
 * **按语言**：每种语言的词里至少有一个真的出现在**那种语言自己的**文档里
 *（`docs/<lang>/` 下、ADMIN.md 之外、不含 `docs/design/`）。这条控制在「zh-TW 那一列
 * 只填了简体词」时会当场红，正是这一轮漏掉的那种形态。
 *
 * ── ② 数字必须从代码常量派生 ────────────────────────────────────────────────
 * ADMIN.md 里写下的每一个运行期数字都在下面那张表上，**期望值来自真源常量**，
 * **单位词是每语言各一个的手写锚**：常量改了文档必须跟着改，那正是这张表的价值；
 * 而单位词让它在一份长文档里不会被随便一个 24 或 30 蒙混过去。
 * ⚠️ **不许退化成 `toContain(String(n))`**：那展开就是「文档里有没有出现过这个数字」，
 * 一份写着 `24h` / `12 小时` / `30d` 的文档随便哪一句都能满足它，**永远不会红**。
 * ⚠️⚠️ **正则前面那个 `(?<!\d)` 不是装饰，是落地时实测补的**：没有它时
 * `2\s?小时` 会在「12 小时」里匹配上（ja 的「2\s?時間」在「12 時間」里同理），
 * 于是下面「交叉反证」那一格会**静静放行** —— 实测记在本任务报告的变异清单里。
 *
 * ── ③ 那句「`404` 而不是 `401`」的两个状态码 ────────────────────────────────
 * ⚠️ **这一组的期望值来自其余四份文档，不来自代码**，与上面 ② 不是一条路：本仓今天
 * 没有任何一个导出的常量装着这两个状态码（没配 `ADMIN_TOKEN` 时整棵树不注册，那个
 * `404` 是 Hono 的默认响应；`401` 由 `src/http/admin/auth.ts` 那条路直接构造）。
 * ⇒ 它只挡「某一份抄错一位 / 漏写」，**挡不住五份被同一个错误同步污染**——边界与本
 * 文件 `NUMBERS` 那张表上方那一段逐字相同，请连同那一段一起读。
 *
 * ── ④ 跨文档的**小节名引用**必须在被引的那份文档里逐字找得到 ────────────────
 * 这一组是复评回填时新加的，因为它挡的是一整类 R1–R6 一个字都看不见的错：
 * 「…见 [REGISTRAR.md](REGISTRAR.md) 的「X」一节」这种句子**五份各写各的**，
 * 引号里那个名字漂了，结构判据全绿。复评当场点出三处（ja 引「管理パネルの「今すぐ
 * 補充」」而真标题是「管理画面の…」、zh-TW 引「管理口令洩漏」而真文是「外洩」、
 * en 引 "Tend now in the admin panel" 而真标题带着自己的引号），**这一组落地时又
 * 多抓出两处复评也没看见的**（en 引 "Leaked admin token" 而 DEPLOY.md 写的是
 * "Leaking the admin token"、ko 引 "관리 패널의 「지금 보충」" 而真标题用的是直引号）。
 *
 * 判据怎么认出「这是一条小节名引用」：**引号紧跟着本语言的「节 / 段」标记词**
 *（zh-CN 一节/那一段、zh-TW 一節/那一段、en section/part、ja の節/の段、ko 절/문단）。
 * 标记词是每语言各一个的手写锚，**它会不会悄悄失效由跨语言条数对等那一格兜底**：
 * 五份的结构骨架由 R2 钉死，条数就该一样，某种语言的锚认不出来时它的条数会掉下去。
 * ⚠️ **「条数一致」单独一条挡不住「五种一起归零」**（锚全坏时五份都是 0，照样一致），
 * 所以还有一格「每种语言至少认出一条」，两格缺一不可。
 *
 * ── ⑤ 两张表的行数从**屏幕的真源**派生 ─────────────────────────────────────
 * 复评发现文档写「四种警告条」，而屏幕上是 **5** 条独立的 `<p>`、可以同时亮
 *（`admin-ui/js/sec-events.js` 的 `warnBanner.appendChild(...)`）。文字里的那个数量词
 * 已经删掉（**能删数字就删数字**），但表本身的行数是有真源的：警告条那张表的行数
 * 必须等于横幅里挂上去的 `<p>` 条数，板块速查那张表的行数必须等于 `admin-ui/index.html`
 * 里 `nav-item` 的个数。⇒ 屏幕上多一条黄条 / 多一个板块而五份文档没跟着改，当场红。
 * ⚠️ **判据靠「行数恰好等于那个数的表**有且只有一张**」来认表**，认不出（0 张或 2 张）
 * 时**报错而不是放行**——将来 Task 26A 往同一份文档里加表，撞上这两个数量时它会吵。
 *
 * ── 它做不到什么（明写）────────────────────────────────────────────────────
 * 五组加起来也只证明「这些串在那一份里出现过 / 没出现过」「这些数对得上」。
 * **某一份整段翻译反了、五份一起把同一件事说错、或者哪一句该链出去的地方抄了第二份
 * 副本，它全都看不见。** 尤其是 ④ 只核对「引号里的名字在被引文档里找得到」，
 * **指错小节（名字对得上但说的不是那件事）它认不出来**。译文准确性仍然只能靠评审。
 */
describe("五份 ADMIN.md 的措辞与数字守卫", () => {
  const ADMIN = "ADMIN";
  const realAdminDoc: ApiDocReader = realDoc(ADMIN);

  /** 正则元字符转义。单位词今天都不含元字符，但锚是给后来人加的。 */
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ── ① 软化词表 ────────────────────────────────────────────────────────────
  //
  // ⚠️ 词表本身与打平表**搬到了模块作用域**（复评 H3）：同一条红线在 DEPLOY.md 那一侧
  // 也要守，两处必须共用同一张词表——各留一份的话，补一个逃逸词只会补到其中一边，
  // 而另一边继续瞎。见文件里 `SOFTENER_CONCEPTS` 上方那段。

  /**
   * 一次扫描 × 五份 ADMIN.md。返回失败报文数组。真扫描与探针**共用这一份**。
   * **射程是全部语言的全部词**（不是「这一份只查它自己语言的词」）：一份英文文档里
   * 冒出一个「충분」同样是错的，按语言分开查会把这类漏掉。
   */
  function softenerFailures(read: ApiDocReader): string[] {
    const out: string[] = [];
    for (const lang of LANGS) {
      for (const { word, origins } of softenerHits(read(lang))) {
        out.push(
          `${lang}/ADMIN.md 把一件本仓从没量过的事说成了「${word}」`
          + `（软化概念 ${origins.join("、")}）`
          + "——能写下来的只有上限本身，以及「本仓没量过」这句话",
        );
      }
    }
    return out;
  }

  it("软化词表是「概念 × 语言」的矩阵：每条概念五种语言都得有说法，缺一种就是那种语言的盲区", () => {
    expect(SOFTENER_CONCEPTS.length, "概念表空了——下面整组会一格都不跑").toBeGreaterThan(0);
    const want = [...LANGS].sort();
    const holes: string[] = [];
    for (const c of SOFTENER_CONCEPTS) {
      expect(Object.keys(c.words).sort(), `${c.id} 的语言集与本文件的 LANGS 对不上`).toEqual(want);
      for (const lang of LANGS) {
        if (c.words[lang].filter((w) => w.trim() !== "").length === 0) {
          holes.push(`软化概念 ${c.id} 在 ${lang} 下一个说法都没有——那种语言在这条概念上是瞎的`);
        }
      }
    }
    expect(holes, holes.join("\n")).toEqual([]);
  });

  it("该红时红：把某条概念的某种语言清空 —— 完备性那格必须当场点名概念与语言", () => {
    const holed = SOFTENER_CONCEPTS.map((c) => (
      c.id === "enough" ? { ...c, words: { ...c.words, "zh-TW": [] as readonly string[] } } : c
    ));
    const holes: string[] = [];
    for (const c of holed) {
      for (const lang of LANGS) {
        if (c.words[lang].filter((w) => w.trim() !== "").length === 0) {
          holes.push(`软化概念 ${c.id} 在 ${lang} 下一个说法都没有——那种语言在这条概念上是瞎的`);
        }
      }
    }
    expect(holes, "变异落地了却没红——完备性那一格是空的").toHaveLength(1);
    for (const h of ["enough", "zh-TW"]) expect(holes[0] ?? "").toContain(h);
  });

  /** 每种语言在**它自己的**文档（`docs/<lang>/` 下、ADMIN.md 之外）里的全文。 */
  function ownDocsOf(lang: Lang): string {
    return readdirSync(join(".", "docs", lang), { encoding: "utf8" })
      .filter((p) => p.endsWith(".md") && p !== "ADMIN.md")
      .map((p) => readFileSync(join(".", "docs", lang, p), "utf8"))
      .join("\n")
      .toLowerCase();
  }

  /** 某种语言的词表里，真的能在那种语言自己的文档里找到出处的那些。 */
  function attestedWords(words: readonly string[], lang: Lang): string[] {
    const own = ownDocsOf(lang);
    return words.filter((w) => own.includes(w.toLowerCase()));
  }

  const wordsOf = (lang: Lang): readonly string[] => SOFTENER_CONCEPTS.flatMap((c) => c.words[lang]);

  it("反向控制：每种语言的软化词里至少有一个真的出现在**那种语言自己的**文档里", () => {
    // ⚠️ 口径见本组上方那段：**不是**「每一个词都要有出处」（那条会把表往窄里推，
    // 而表太窄正是这一轮逃逸的根因），而是「这一列不是一堆那种语言里根本没人这么写
    // 的死串」。`docs/design/` 刻意不在射程里——那份需求书逐字抄着这张词表，
    // 让它来作证等于自己给自己签字。
    const blind: string[] = [];
    for (const lang of LANGS) {
      expect(ownDocsOf(lang).length, `docs/${lang}/ 下一份非 ADMIN.md 的文档都没读到——这一格测的是空气`)
        .toBeGreaterThan(0);
      const hit = attestedWords(wordsOf(lang), lang);
      if (hit.length === 0) blind.push(`${lang} 这一列的词在 docs/${lang}/ 里一次都没出现过：${wordsOf(lang).join("、")}`);
    }
    expect(blind, blind.join("\n")).toEqual([]);
  });

  it("该红时红：zh-TW 那一列只填简体词时，按语言的反向控制必须红 —— 这正是本轮逃逸的形态", () => {
    // 这是第一版平表在 zh-TW 上的**实际**形态：表里只有简体「足够/够用」，
    // 而 `docs/zh-TW/` 里当然一次都不会出现它们。
    const simplifiedOnly = attestedWords(["足够", "够用", "没问题"], "zh-TW");
    expect(simplifiedOnly, "简体词居然在 docs/zh-TW/ 里找得到——这一格控制是空的").toEqual([]);
    // 反向控制：今天真表里的繁体词是找得到的（否则上面那格红的是别的原因）。
    expect(attestedWords(wordsOf("zh-TW"), "zh-TW").length, "繁体词一个都找不到——真表本身坏了")
      .toBeGreaterThan(0);
  });

  it("五份 ADMIN.md 里一个软化词都没有", () => {
    const failures = softenerFailures(realAdminDoc);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /**
   * 与 API.md 那两组同一条闸、同一个理由（那里逐字写着**为什么**要有它）：真文档今天
   * 本身就不过判据时，探针格的报文只会是一句「报文：」，把人往错的方向指。
   * ⚠️ **这道闸不是照抄来的，是实测补的**：本任务做 M4（往 zh-CN 那份里塞一句
   * 「60 次足够」）时，**红的是两格**——真扫描那一格是真因，下面这格探针跟着红，
   * 而它当时的报文里只有两行重复的失败，一个字都没说「真因在哪一格」。
   */
  function probeSoftenerBase(): void {
    const base = softenerFailures(realAdminDoc);
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「五份 ADMIN.md 里一个软化词都没有」那一格：\n"
        + base.join("\n"),
      );
    }
  }

  it("探针自检这道闸本身有牙：真文档不过判据时，探针格报的是「先看真扫描那一格」", () => {
    // 反向控制：真文档原样跑时它一声不吭（这一格若红，说明真文档本身坏了）。
    expect(() => probeSoftenerBase()).not.toThrow();
    // 有牙：把词表里第一个词塞进任意一份，这道闸必须炸，而且报文点名真因那一格。
    const injected = softenerFailures(readerWith("ko", (s) => `${s}\n${SOFTENER_WORDS[0]}\n`, ADMIN));
    expect(injected, "变异落地了却一格都没红——这道闸的自检是空的").toHaveLength(1);
  });

  it("该红时红：zh-CN 那份写了「60 次足够」（其余四份不动）", () => {
    probeSoftenerBase();
    const failures = softenerFailures(readerWith("zh-CN", (s) => `${s}\n轮询上限 60 次足够。\n`, ADMIN));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    for (const h of ["zh-CN/ADMIN.md", "足够"]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  it("该红时红：en 那份写了 Safe —— 判据大小写不敏感，首字母大写照样算", () => {
    probeSoftenerBase();
    const failures = softenerFailures(readerWith("en", (s) => `${s}\nThose 60 attempts are Safe.\n`, ADMIN));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "").toContain("en/ADMIN.md");
    expect(failures[0] ?? "").toContain("safe");
  });

  /**
   * ⚠️⚠️ **下面两格是复评实测出来的逃逸，一字不改地钉在这里。** 复评往真仓里塞的就是
   * 这两句，当时 `docs-parity` **117/117 全绿**。它们不是「同族的又一个例子」，
   * 是这一组第一版**真的放行过**的两句话——删掉任何一格，那个洞就又没人看着了。
   */
  it("该红时红（复评实测的逃逸①）：zh-TW 那份写了「這個上限足夠了，也夠用。」", () => {
    probeSoftenerBase();
    const failures = softenerFailures(readerWith("zh-TW", (s) => `${s}\n這個上限足夠了，也夠用。\n`, ADMIN));
    // 一句话踩中同一条概念的两个繁体说法，所以是两条失败，不是一条。
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(2);
    expect(failures.join("\n")).toContain("zh-TW/ADMIN.md");
    for (const w of ["足夠", "夠用"]) {
      expect(failures.join("\n"), "红了但报文没点名这个繁体词——报文是唯一会被看见的护栏").toContain(w);
    }
  });

  it("该红时红（复评实测的逃逸②）：ko 那份写了「이 상한은 안전합니다.」", () => {
    probeSoftenerBase();
    const failures = softenerFailures(readerWith("ko", (s) => `${s}\n이 상한은 안전합니다.\n`, ADMIN));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    for (const h of ["ko/ADMIN.md", "안전", "safe/ko"]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  // ── ② 数字从代码常量派生 ──────────────────────────────────────────────────

  interface NumRule {
    readonly id: string;
    readonly n: number;
    readonly why: string;
    /** 每语言各一个的手写单位锚。**空串当场判死**，见 `numberFailures`。 */
    readonly unit: Record<Lang, string>;
  }

  const HOURS: Record<Lang, string> = { "zh-CN": "小时", "zh-TW": "小時", en: "hours", ja: "時間", ko: "시간" };

  const ADMIN_NUMBERS: readonly NumRule[] = [
    {
      id: "admin-token-min-length",
      n: ADMIN_TOKEN_MIN_LENGTH,
      why: "ADMIN_TOKEN 的长度下限",
      unit: { "zh-CN": "位", "zh-TW": "位", en: "characters", ja: "文字", ko: "자" },
    },
    {
      id: "session-window-hours",
      n: SESSION_MAX_AGE_MS / 3_600_000,
      why: "面板口令在 localStorage 里的可用窗口",
      unit: HOURS,
    },
    {
      id: "import-cap",
      n: MAX_IMPORT_KEYS,
      why: "一次导入的把数上限（超了就 400，不静默截断）",
      unit: { "zh-CN": "把 key", "zh-TW": "把 key", en: "keys", ja: "件の key", ko: "개의 key" },
    },
    {
      id: "event-windows",
      n: EVENT_WINDOW_RETAIN,
      why: "事件保留的窗口数",
      unit: { "zh-CN": "个窗口", "zh-TW": "個視窗", en: "windows", ja: "個のウィンドウ", ko: "개의 창" },
    },
    {
      id: "usage-retain-days",
      n: USAGE_DAY_RETAIN,
      why: "用量第二层的保留天数",
      unit: { "zh-CN": "天", "zh-TW": "天", en: "days", ja: "日", ko: "일" },
    },
    {
      id: "usage-slots",
      n: USAGE_SLOTS,
      why: "同一天里的用量分片槽位数（超过这么多副本同写就是后写覆盖）",
      unit: { "zh-CN": "个槽位", "zh-TW": "個槽位", en: "slots", ja: "つのスロット", ko: "개의 슬롯" },
    },
    // ⚠️⚠️ **下面四条是 P3e Task 26A 落的，前两条就是「轮询上限」那条红线的机器化。**
    //
    // 这条红线从 P3d 起立着：`admin-ui/js/pure/playground.mjs` 自己登记着「5 分钟 / 60 次
    // 对真实的视频生成可能偏短……本仓从来没有量过」⇒ **真机了结之前，任何文案都不许把
    // 这两个上限写成「足够 / 安全」**。今天它由**两半**共同看着，缺一半就有洞：
    // · 上面 ① 那张软化词矩阵挡「把它说成足够 / 安全」；
    // · 本表这两条挡「干脆不写这两个上限」与「常量改了文档没跟着改」。
    //
    // ⚠️ **需求书给的写法是一格独立的 `it()` + 一张 `POLL_HINT` 表，这里改成本表的两行，
    // 单位词逐字照抄那张表**（次/次/attempts/回/회、分钟/分鐘/minutes/分/분）。
    // 理由是本表已经带着三条那一格拿不到的探针：交叉反证（拿另一条规则的数字换进来，
    // 五份必须全红 —— `60` 与「配置 30s+60s」那种同族地雷正是它挡的）、
    // 漂一位（`n+1` 五份一起红，证明期望值不是手写的）、单位锚空串当场判死。
    // 判据本身还比需求书那版严一格：正则前面多一个 `(?<!\d)`，见本组上方那段 ⚠️⚠️。
    {
      id: "video-poll-attempts",
      n: VIDEO_POLL_MAX_ATTEMPTS,
      why: "视频结果轮询的次数上限（先到哪条算哪条）",
      unit: { "zh-CN": "次", "zh-TW": "次", en: "attempts", ja: "回", ko: "회" },
    },
    {
      id: "video-poll-minutes",
      n: VIDEO_POLL_MAX_MS / 60_000,
      why: "视频结果轮询的时长上限，分钟",
      unit: { "zh-CN": "分钟", "zh-TW": "分鐘", en: "minutes", ja: "分", ko: "분" },
    },
    // 间隔那一条**不是可有可无的第三个数**：没有它，「60 次」与「5 分钟」在文档里是
    // 两个互不相干的数，读者算不出它们今天恰好等价（`60 × 5000 === 300000`），
    // 也就读不懂为什么两条上限都要有。
    {
      id: "video-poll-interval-seconds",
      n: VIDEO_POLL_INTERVAL_MS / 1_000,
      why: "两次轮询之间的间隔，秒",
      unit: { "zh-CN": "秒", "zh-TW": "秒", en: "seconds", ja: "秒", ko: "초" },
    },
    {
      id: "playground-turns",
      n: PLAYGROUND_TURNS_MAX,
      why: "调试台屏幕上最多保留几轮对话",
      unit: { "zh-CN": "轮", "zh-TW": "輪", en: "turns", ja: "往復", ko: "턴" },
    },
  ];

  const ruleById = (id: string): NumRule => {
    const r = ADMIN_NUMBERS.find((x) => x.id === id);
    if (!r) throw new Error(`本表里没有 ${id} 这条规则——这一格测的是空气`);
    return r;
  };

  /** 一条规则 × 五份 ADMIN.md。返回失败报文数组。真扫描与探针**共用这一份**。 */
  function numberFailures(rule: NumRule, read: ApiDocReader): string[] {
    const out: string[] = [];
    for (const lang of LANGS) {
      const unit = rule.unit[lang];
      if (unit.trim() === "") {
        out.push(`${rule.id} 在 ${lang} 下的单位词是空串——锚会退化成裸数字，这条断言从此空转`);
        continue;
      }
      // `(?<!\d)`：见本组上方那段 ⚠️⚠️——没有它时 `2\s?小时` 会在「12 小时」里匹配上。
      const re = new RegExp(`(?<!\\d)${rule.n}\\s?${escapeRe(unit)}`);
      if (!re.test(read(lang))) {
        // ⚠️ 报文要写成**判据真正接受的形状**，不是把数字和单位一拼了事：正则里那个
        // `\s?` 允许中间有一个空格，而五份文档写的恰恰是「200 keys」这种带空格的写法。
        // 复评抓到的原报文是「找不到「201keys」」，照它去 grep 一个字都搜不到——
        // **报文可以亲手把人引进坑**，这是本仓登记过的老教训。
        out.push(
          `${lang}/ADMIN.md 里找不到「${rule.n}${unit}」或「${rule.n} ${unit}」`
          + `（中间可以有一个空格；${rule.why}）`
          + "——要么常量改了而这一份文档没跟着改，要么这一份漏写了这个数",
        );
      }
    }
    return out;
  }

  it("非空锚：数字表不是空表，且每条规则的单位词语言集恰好等于本文件的 LANGS", () => {
    expect(ADMIN_NUMBERS.length, "表空了——下面整组会一格都不跑").toBeGreaterThan(0);
    const want = [...LANGS].sort();
    for (const rule of ADMIN_NUMBERS) {
      expect(Object.keys(rule.unit).sort(), `${rule.id} 的单位词语言集与本文件的 LANGS 对不上`).toEqual(want);
      expect(Number.isFinite(rule.n) && rule.n > 0, `${rule.id} 的数字不是一个正整数`).toBe(true);
    }
  });

  it("事件那条规则的单位是「窗口」而不是「小时」，因为一个窗口恰好一小时 —— 这句话在文档里写着", () => {
    // 五份 ADMIN.md 都写着「事件按小时分窗口存放，一共留 24 个窗口 —— 也就是整整一天」。
    // 那句话只有在一个窗口 = 1 小时的时候才是真的，所以把这个前提钉在这里：
    // `EVENT_WINDOW_MS` 一旦不再是一小时，这一格当场红，逼人回去改那五句话。
    expect(EVENT_WINDOW_MS, "一个事件窗口不再是一小时了——五份 ADMIN.md 里「按小时分窗口……整整一天」那句话已经不成立")
      .toBe(3_600_000);
  });

  it.each([...ADMIN_NUMBERS])("$id：五份 ADMIN.md 都写着「$n + 本语言的单位」", (rule) => {
    const failures = numberFailures(rule, realAdminDoc);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /** 与上面两组同一条闸、同一个理由：真文档本身不过判据时，别让人从探针的报文里找原因。 */
  function probeNumberBase(rule: NumRule, read: ApiDocReader = realAdminDoc): void {
    const base = numberFailures(rule, read);
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + `别从这一格的报文里找原因，真因在「${rule.id}：五份 ADMIN.md 都写着…」那一格：\n`
        + base.join("\n"),
      );
    }
  }

  it("探针自检这道闸本身有牙：真文档不过判据时，探针格报的是「先看真扫描那一格」", () => {
    const rule = ruleById("session-window-hours");
    const broken: ApiDocReader = (lang) => realAdminDoc(lang).split(String(rule.n)).join("XX");
    expect(broken("ja").includes(String(rule.n)), "变异没落地 —— 这一格控制是空的").toBe(false);
    expect(() => probeNumberBase(rule, broken)).toThrow("本格是探针");
    expect(() => probeNumberBase(rule, realAdminDoc)).not.toThrow();
  });

  it.each([...ADMIN_NUMBERS])("$id：常量漂一位（$n → 下一个数）时五份一起红 —— 证明期望值不是手写的", (rule) => {
    probeNumberBase(rule);
    const failures = numberFailures({ ...rule, n: rule.n + 1 }, realAdminDoc);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
  });

  /**
   * **交叉反证**：把某条规则的数字换成本表里**另一条**规则的数字，五份必须全部红。
   * 这是「同族地雷」那一条的可执行答案：`24` 同时是 `ADMIN_TOKEN` 的长度下限与事件
   * 窗口数，`12` / `30` / `2` 在同一份文档里也各有别的出处 —— 单位词把它们分开这件事
   * 必须被证明，不能只写在注释里。数字相同的两条规则跳过（换了等于没换）。
   */
  it("交叉反证：把一条规则的数字换成本表里另一条的数字，五份必须全部红", () => {
    const pairs: string[] = [];
    for (const rule of ADMIN_NUMBERS) {
      probeNumberBase(rule);
      for (const other of ADMIN_NUMBERS) {
        if (other.n === rule.n) continue;
        const failures = numberFailures({ ...rule, n: other.n }, realAdminDoc);
        if (failures.length !== LANGS.length) {
          pairs.push(
            `${rule.id} 的数字换成 ${other.n}（${other.id} 的值）之后，只红了 ${failures.length}/${LANGS.length} 份`
            + " —— 说明某种语言里「另一条规则的数字 + 本条的单位词」也能凑到一次匹配，单位词没把它们分开",
          );
        }
      }
      // 反向控制：真数字原样传进去时一格都不许红（这一格若红，说明真文档本身坏了）。
      expect(numberFailures(rule, realAdminDoc), `${rule.id} 用真数字反而红了`).toEqual([]);
    }
    expect(pairs, pairs.join("\n")).toEqual([]);
  });

  it("该红时红：某一份把阿拉伯数字写成了汉字（12 小时 → 十二小时），只点名那一份", () => {
    const rule = ruleById("session-window-hours");
    probeNumberBase(rule);
    const failures = numberFailures(
      rule,
      readerWith("zh-CN", (s) => s.split(`${rule.n} 小时`).join("十二小时"), ADMIN),
    );
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    for (const h of ["zh-CN/ADMIN.md", String(rule.n), rule.why]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  it("该红时红：数字留着、单位词被换掉（12 小时 → 12 台机器）—— 证明单位词是承重的那一半", () => {
    const rule = ruleById("session-window-hours");
    probeNumberBase(rule);
    const failures = numberFailures(
      rule,
      readerWith("zh-CN", (s) => s.split(`${rule.n} 小时`).join(`${rule.n} 台机器`), ADMIN),
    );
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "").toContain("zh-CN/ADMIN.md");
  });

  it("该红时红：单位锚是空串时当场判死——空串会让锚退化成裸数字，那条断言会静静空转", () => {
    const rule = ruleById("usage-slots");
    probeNumberBase(rule);
    const blanked: NumRule = { ...rule, unit: { ...rule.unit, ja: "  " } };
    const failures = numberFailures(blanked, realAdminDoc);
    expect(failures.join("\n")).toContain("空串");
    // 反向控制：其余四种语言的单位词没动，它们一条都不许跟着红。
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
  });

  // ── ③ 那句「404 而不是 401」的两个状态码 ─────────────────────────────────

  const STATUS_TOKENS = ["`404`", "`401`"] as const;

  /** 一个状态码 × 五份 ADMIN.md 的出现次数。真扫描与探针**共用这一份**。 */
  function statusFailure(token: string, read: ApiDocReader): string | null {
    const counts = Object.fromEntries(LANGS.map((l) => [l, read(l).split(token).length - 1])) as Record<Lang, number>;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return `「${token}」在五份 ADMIN.md 里一次都没出现——那句「404 而不是 401」被删掉了，或者写法变了`;
    const reference = counts[LANGS[0]];
    const bad = LANGS.filter((l) => counts[l] !== reference);
    return bad.length === 0
      ? null
      : `「${token}」在五份 ADMIN.md 里的出现次数不一致（${JSON.stringify(counts)}）`
        + "——可能有语言漏翻、漏写，或翻译时把状态码抄错了一位";
  }

  for (const token of STATUS_TOKENS) {
    it(`五份 ADMIN.md 里「${token}」的出现次数彼此一致`, () => {
      const failure = statusFailure(token, realAdminDoc);
      expect(failure, failure ?? "").toBeNull();
    });
  }

  /** 同上那道闸，同一个理由：真文档本身不过判据时，别让人从探针的报文里找原因。 */
  function probeStatusBase(token: string): void {
    const base = statusFailure(token, realAdminDoc);
    if (base !== null) {
      throw new Error(
        "本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + `别从这一格的报文里找原因，真因在「五份 ADMIN.md 里「${token}」的出现次数彼此一致」那一格：\n`
        + base,
      );
    }
  }

  it("该红时红：ko 那份把 404 抄成了 403", () => {
    probeStatusBase("`404`");
    const failure = statusFailure("`404`", readerWith("ko", (s) => s.replace("`404`", "`403`"), ADMIN));
    expect(failure, "变异落地了却没红——这一格控制是空的").not.toBeNull();
    expect(failure ?? "").toContain("ko");
  });

  it("该红时红：五份一起把那句话删掉时报的是「一次都没出现」，不是装作对等", () => {
    probeStatusBase("`401`");
    const gone: ApiDocReader = (lang) => realAdminDoc(lang).split("`401`").join("(删了)");
    expect(gone("en").includes("`401`"), "变异没落地 —— 这一格控制是空的").toBe(false);
    const failure = statusFailure("`401`", gone);
    expect(failure ?? "").toContain("一次都没出现");
  });

  // ── ④ 跨文档的小节名引用 ─────────────────────────────────────────────────

  /** 五份 ADMIN.md 之外的**同语言兄弟文档**。射程之外的链接（外网、锚点）不参与。 */
  const SIBLING_DOCS = ["API.md", "DEPLOY.md", "README.md", "REGISTRAR.md", "USAGE.md"] as const;

  /**
   * 「这是一条小节名引用」的每语言手写锚：**引号闭合之后紧跟着的那个「节 / 段」标记词**。
   * ⚠️ 锚认不出来时不会有任何一条失败冒出来（它只是少认了一条），所以下面**必须**配
   * 「五种语言认出的条数彼此一致」+「每种至少认出一条」两格，缺一不可。
   */
  const SECTION_MARKER: Record<Lang, string> = {
    "zh-CN": "(?:一节|那一段)",
    "zh-TW": "(?:一節|那一段)",
    en: "(?:section|part)\\b",
    ja: "の(?:節|段)",
    ko: "(?:절|문단)",
  };

  /** 直角引号（允许一层嵌套，如「面板的「立即补池」」）或直引号。 */
  const QUOTE_RE = "(?:「(?:[^「」]|「[^「」]*」)*」|\"[^\"\\n]+\")";

  /** 取文口径：这一组要同时读 ADMIN.md 与被引的那份兄弟文档，所以比 `ApiDocReader` 宽一格。 */
  type SiblingReader = (lang: Lang, doc: string) => string;
  const realSiblings: SiblingReader = (lang, doc) => readFileSync(join(".", "docs", lang, doc), "utf8");

  /**
   * 被引文档里能充当「小节 / 段落的名字」的那些行：**markdown 标题行**，或**以 `**`
   * 起首的加粗领句**（本仓那几段「管理口令泄漏 = …」不是标题，是加粗领句，引用句写的是
   * 「那一段」而不是「一节」）。
   *
   * ⚠️⚠️ **这个收窄是落地时被一条真变异逼出来的，不是设计时想到的。** 第一版判据写的是
   * 「这个名字在被引文档的**全文**里逐字找得到」。实测：把 `docs/zh-CN/REGISTRAR.md:187`
   * 的 `## 面板的「立即补池」` 改名成「马上补池」（也就是**真的把小节改名了**），
   * `docs-parity` **135/135 全绿放行** —— 因为同一份文档的第 134 行还有一句散文
   * 「⚠️ **但面板的「立即补池」是例外……**」，全文 grep 照样命中。**判据当时挡的是
   * 「这几个字在那份文档里出现过」，而不是「那一节还叫这个名字」**，两者只在没有第二处
   * 出处时碰巧重合。收窄到「名字所在的那一行本身得是个标题 / 加粗领句」之后同一条变异当场红。
   */
  function titleLines(src: string): string[] {
    return src.split("\n").filter((l) => /^#{1,6}\s/.test(l) || /^\*\*/.test(l));
  }

  /**
   * 把 markdown 切成「块」：列表项 / 段落 / 表格行各自成块。**块是判据的射程单位**——
   * 引用句里那条 `](X.md)` 链接与引号常常分处两行（en 就是这样），按行切会漏；
   * 按空行切又会把整张列表并成一块，于是隔壁条目里一个无关的引号会被拖进来
   *（实测：zh-CN 的「几秒前读到的」正是这样被误判过）。
   */
  function mdBlocks(src: string): string[] {
    const out: string[] = [];
    let cur: string[] = [];
    for (const line of src.split("\n")) {
      const opensBlock = /^\s*[-*]\s/.test(line) || /^#{1,6}\s/.test(line) || line.trim() === "" || /^\s*\|/.test(line);
      if (opensBlock) {
        if (cur.length > 0) out.push(cur.join("\n"));
        cur = [line];
      } else {
        cur.push(line);
      }
    }
    if (cur.length > 0) out.push(cur.join("\n"));
    return out;
  }

  interface XrefScan {
    readonly counts: Record<Lang, number>;
    readonly failures: readonly string[];
  }

  /** 一次扫描 × 五份 ADMIN.md。真扫描与探针**共用这一份**。 */
  function xrefScan(read: SiblingReader): XrefScan {
    const counts = Object.fromEntries(LANGS.map((l) => [l, 0])) as Record<Lang, number>;
    const failures: string[] = [];
    for (const lang of LANGS) {
      const re = new RegExp(`(${QUOTE_RE})\\s*${SECTION_MARKER[lang]}`, "g");
      for (const block of mdBlocks(read(lang, "ADMIN.md"))) {
        const targets = [...new Set(
          [...block.matchAll(/\]\(([A-Za-z_]+\.md)\)/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])),
        )].filter((t) => (SIBLING_DOCS as readonly string[]).includes(t));
        for (const m of block.matchAll(re)) {
          counts[lang] += 1;
          const quoted = m[1];
          // 第 1 组在 `re` 里是必配组：匹配上了却没有捕获，说明判据本身被改坏了。
          // **认不出要吵**，不许用 `?? ""` 兜底——那会让一条空名字一路走到「找不到」的报文里。
          if (quoted === undefined) throw new Error(`${lang}/ADMIN.md：小节名引用的必配捕获组是空的——判据本身坏了`);
          const name = quoted.slice(1, -1);
          if (targets.length === 0) {
            failures.push(
              `${lang}/ADMIN.md 里「${name}」被说成是某一节，但同一段里没给出通往那份文档的链接`
              + "——读者点不过去，判据也无从核对它到底在哪一份里",
            );
            continue;
          }
          if (!targets.some((t) => titleLines(read(lang, t)).some((line) => line.includes(name)))) {
            failures.push(
              `${lang}/ADMIN.md 引了「${name}」这一节，但 ${targets.join(" / ")} 里没有哪一条标题 / 加粗领句叫这个名字`
              + "——要么被引文档那边改名了，要么这一份翻译时把名字改写了"
              + "（判据只认标题行与 `**` 起首的加粗领句：散文里碰巧提过这几个字**不算**）",
            );
          }
        }
      }
    }
    return { counts, failures };
  }

  it("五份 ADMIN.md 引的每一个小节名，在被引的那份同语言文档里逐字找得到", () => {
    const { failures } = xrefScan(realSiblings);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("非空锚：每种语言至少认出一条小节名引用 —— 全都认不出时五份会一起归零，条数对等看不出来", () => {
    const { counts } = xrefScan(realSiblings);
    const dead = LANGS.filter((l) => counts[l] === 0);
    expect(dead, `这些语言一条小节名引用都没认出来（${JSON.stringify(counts)}）——`
      + "多半是 SECTION_MARKER 里那个语言的标记词已经和文档里的写法对不上了").toEqual([]);
  });

  it("五种语言认出的小节名引用条数彼此一致 —— 标记词悄悄失效时靠这一格兜底", () => {
    const { counts } = xrefScan(realSiblings);
    const reference = counts[LANGS[0]];
    const bad = LANGS.filter((l) => counts[l] !== reference);
    expect(bad, `五份 ADMIN.md 认出的小节名引用条数不一致（${JSON.stringify(counts)}）`
      + "——R2 已经钉死五份的结构骨架，条数就该一样：要么某一份漏写了这条指路，"
      + "要么那种语言的标记词认不出它自己文档里的写法").toEqual([]);
  });

  /** 与前三组同一条闸、同一个理由：真文档本身不过判据时，别让人从探针的报文里找原因。 */
  function probeXrefBase(): void {
    const base = xrefScan(realSiblings);
    if (base.failures.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「五份 ADMIN.md 引的每一个小节名…」那一格：\n"
        + base.failures.join("\n"),
      );
    }
  }

  it("探针自检这道闸本身有牙：真文档不过判据时，探针格报的是「先看真扫描那一格」", () => {
    expect(() => probeXrefBase()).not.toThrow();
  });

  it("该红时红：被引文档那边把标题改了（zh-CN/REGISTRAR.md 的「面板的「立即补池」」）", () => {
    probeXrefBase();
    // ⚠️ **只改那一行标题，散文里那处同名不动** —— 这正是实测里逃逸过的形态：
    // 判据当时看全文，于是「改了标题」被第 134 行那句散文替它挡了下来（见 titleLines 上方）。
    const renamed: SiblingReader = (lang, doc) => {
      const src = realSiblings(lang, doc);
      if (lang !== "zh-CN" || doc !== "REGISTRAR.md") return src;
      const out = src.replace("\n## 面板的「立即补池」\n", "\n## 面板的「马上补池」\n");
      if (out === src) throw new Error("变异没落到 docs/zh-CN/REGISTRAR.md 上——这一格控制是空的");
      // 落点断言：散文里那处同名还在，判据必须**不**被它蒙混过去。
      if (!out.includes("但面板的「立即补池」是例外")) {
        throw new Error("散文里那处同名不见了——这一格就退化成了「全文找不到」，测不出收窄");
      }
      return out;
    };
    const { failures } = xrefScan(renamed);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    for (const h of ["zh-CN/ADMIN.md", "面板的「立即补池」", "REGISTRAR.md"]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  it("该红时红（复评实测的三处之一）：ja 那份把被引标题写成了「管理パネルの「今すぐ補充」」", () => {
    probeXrefBase();
    // 复评抓到的原文就是这一处：真标题是 `## 管理画面の「今すぐ補充」`。
    const drifted: SiblingReader = (lang, doc) => {
      const src = realSiblings(lang, doc);
      if (lang !== "ja" || doc !== "ADMIN.md") return src;
      const out = src.split("の「今すぐ補充」の節").join("の「管理パネルの「今すぐ補充」」の節");
      if (out === src) throw new Error("变异没落到 docs/ja/ADMIN.md 上——这一格控制是空的");
      return out;
    };
    const { counts, failures } = xrefScan(drifted);
    expect(counts.ja, "变异改掉了条数——那说明这一格红的不是名字对不上").toBe(counts["zh-CN"]);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "").toContain("管理パネルの「今すぐ補充」");
  });

  it("该红时红：某一种语言漏掉一条指路时，条数对等那一格红并逐语言报数", () => {
    probeXrefBase();
    const dropped: SiblingReader = (lang, doc) => {
      const src = realSiblings(lang, doc);
      if (lang !== "ko" || doc !== "ADMIN.md") return src;
      const out = src.split('"지금 보충" 절에').join('"지금 보충"에');
      if (out === src) throw new Error("变异没落到 docs/ko/ADMIN.md 上——这一格控制是空的");
      return out;
    };
    const { counts } = xrefScan(dropped);
    expect(counts.ko, "变异落地了却没少认出一条——这一格控制是空的").toBe(counts["zh-CN"] - 1);
    // 反向控制：其余四种语言的条数一条都没跟着变。
    expect(LANGS.filter((l) => l !== "ko").map((l) => counts[l]))
      .toEqual(LANGS.filter((l) => l !== "ko").map(() => counts["zh-CN"]));
  });

  // ── ⑤ 两张表的行数从屏幕的真源派生 ───────────────────────────────────────

  /** 每一张 markdown 表的**数据行数**（连续的 `|` 行减去表头与分隔行）。 */
  function tableSizes(src: string): number[] {
    const out: number[] = [];
    let run = 0;
    for (const line of `${src}\n`.split("\n")) {
      if (/^\s*\|/.test(line)) { run += 1; continue; }
      if (run > 0) { out.push(Math.max(0, run - 2)); run = 0; }
    }
    return out;
  }

  interface PanelCounts {
    readonly nav: number;
    readonly warn: number;
    readonly warnKeys: number;
    /** 设置页上真的建出来的卡数（P3e Task 26A）。 */
    readonly cards: number;
    /** 调试台上真的有的模式数（P3e Task 26A）。 */
    readonly modes: number;
    readonly cardNames: readonly string[];
    readonly modeKeys: readonly string[];
  }

  /** 屏幕那边的几份源码。**真扫描与探针共用这一份取文口径。** */
  interface PanelSource {
    readonly html: string;
    readonly events: string;
    readonly dict: string;
    readonly settings: string;
    readonly playground: string;
  }

  const readPanelSource = (): PanelSource => ({
    html: readFileSync(join(".", "admin-ui", "index.html"), "utf8"),
    events: readFileSync(join(".", "admin-ui", "js", "sec-events.js"), "utf8"),
    dict: readFileSync(join(".", "admin-ui", "js", "i18n-dict.js"), "utf8"),
    settings: readFileSync(join(".", "admin-ui", "js", "sec-settings.js"), "utf8"),
    playground: readFileSync(join(".", "admin-ui", "js", "sec-playground.js"), "utf8"),
  });

  /** 抠掉注释再数**调用点**：本仓的注释里到处写真代码片段，裸数会把它们一起数进来。 */
  const codeOnly = (src: string): string => blankComments(src);

  /**
   * 认源的**完备性锚**（复评 F2）。返回失败报文数组，空 = 认全了。
   *
   * ⚠️⚠️ **这一层是复评实测逼出来的，不是设计时想到的，读完再改。** 下面 `panelCounts()`
   * 那两条取名正则**只认单行字面形态**（`card("…")` 与 `{ mode: "x", key: "y" }`），
   * 而上面那些「非空锚」只验「> 0」——**它们只保证「认出来的那些不是空的」，一个字都不
   * 保证「我认全了」**。复评当场量到的逃逸：把 Task 31 那张卡写成多行
   * `const danger = card(\n  "set.card.danger",\n);`（外加五语言字典补键），
   * `check-i18n` exit 0、**本文件一格都没红**、`build-ui` 之后 `pnpm test` 全过，
   * 而此刻五份 ADMIN.md 仍写着「设置页今天有四张卡」、危险区那一节仍写着「这张卡今天还不存在」。
   * （**这里刻意不抄当时的格数与文件数**：注释里抄一份计数天生会过期，本仓已因此漂过多次。）
   * 给 `MODES` 加一档 `{ mode: "audio", key: "pg.mode.audio", beta: true }` 是同一个形状
   *（多一个属性，`}` 不再紧跟 key，正则整条认不出）。
   * **字典互认那一格挡不住它**：那一格按定义只验「找到的名字有译文」，找不到的名字它看不见。
   *
   * ⇒ 修法是给两条认源各配一条**完备性锚**：
   * · 卡：`card(` 的**调用点数**（抠注释后，排除函数声明自己）必须等于认出来的名字数；
   * · 模式：`MODES` 那张表里 `mode:` 的**条目数**必须等于认出来的键数。
   * 形态变了但名字还认得出 ⇒ 两个数分叉 ⇒ **当场吵**，而不是静静少认一个。
   *
   * ⚠️ **认不出要吵**：`card` 的函数声明、`MODES` 那张表本身，找不到就直接算失败——
   * 它们改名 / 改形态之后，这两条锚会退化成「0 === 0」那种永远成立的废话。
   */
  function recognitionFailures(src: PanelSource): string[] {
    const out: string[] = [];

    const settings = codeOnly(src.settings);
    const decl = (settings.match(/function\s+card\s*\(/g) ?? []).length;
    // `(?<![.\w$])`：排除成员访问（`x.card(`）与以 card 结尾的别的标识符。
    const allCalls = (settings.match(/(?<![.\w$])card\s*\(/g) ?? []).length;
    const cardNames = [...settings.matchAll(/card\("(set\.card\.[A-Za-z]+)"\)/g)]
      .flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
    if (decl !== 1) {
      out.push(
        `sec-settings.js 里 \`function card(\` 数到 ${decl} 处（该是 1 处）`
        + "——建卡的那个函数改名或改形态了，下面那条「调用点数 === 认出来的名字数」的锚会跟着失灵",
      );
    } else if (allCalls - decl !== cardNames.length) {
      out.push(
        `sec-settings.js 里 \`card(\` 的调用点有 ${allCalls - decl} 处，`
        + `而取名正则只认出 ${cardNames.length} 个（${cardNames.join("、")}）`
        + "——多半是某一张卡写成了多行 / 换了写法，取名正则认不出它，"
        + "于是设置卡那条计数会静静地少一张，而五份 ADMIN.md 的设置卡表、以及危险区那一节"
        + "「这张卡今天还不存在」那句话，全靠它",
      );
    }

    const playground = codeOnly(src.playground);
    const block = /(?<![.\w$])const\s+MODES\s*=\s*\[([\s\S]*?)\n\];/.exec(playground);
    const modeKeys = [...playground.matchAll(/\{\s*mode:\s*"[a-z]+",\s*key:\s*"(pg\.mode\.[a-z]+)"\s*\}/g)]
      .flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
    if (block === null || block[1] === undefined) {
      out.push(
        "sec-playground.js 里找不到 `const MODES = [ … ];` 那张表"
        + "——它改名或改形态了，下面那条「条目数 === 认出来的键数」的锚会跟着失灵",
      );
    } else {
      const entries = (block[1].match(/(?<![.\w$])mode\s*:/g) ?? []).length;
      if (entries !== modeKeys.length) {
        out.push(
          `sec-playground.js 的 MODES 表里有 ${entries} 条，而取键正则只认出 ${modeKeys.length} 个`
          + `（${modeKeys.join("、")}）——多半是某一档多带了属性 / 写成了多行，`
          + "于是调试台模式那条计数会静静地少一档，而五份 ADMIN.md 的模式表全靠它",
        );
      }
    }
    return out;
  }

  /**
   * 屏幕那边的独立计数。真扫描与探针**共用这一份**。
   *
   * ⚠️ **卡与模式取的是「真的建出来的那几张 / 那几档」，不是字典里的键数**：
   * `set.card.upstreamNote` 与 `pg.mode.label` 同样长得像 `set.card.*` / `pg.mode.*`，
   * 按字典数就会各多出一个，而屏幕上并没有那张卡、那一档。字典那边的作用是**作证**
   * （下面「两条独立派生互相认账」那一格：这里数出来的每一个名字都得在字典里有译文），
   * 不是当计数用。
   *
   * ⚠️⚠️ **认不全就抛，不返回一个少数了一张的计数**（复评 F2）：这个函数是真扫描与
   * 全部探针的**共用入口**，在这里抛，意味着「取名正则和源码对不上」这件事会在整组
   * 一起冒出来，而不是让某一格静静地拿一个偏小的数去和文档比对——那正是复评量到的逃逸。
   */
  function panelCounts(src: PanelSource): PanelCounts {
    const blind = recognitionFailures(src);
    if (blind.length > 0) {
      throw new Error(`认不出屏幕上的卡 / 模式，这一组的计数已经不可信：\n${blind.join("\n")}`);
    }
    const cardNames = [...codeOnly(src.settings).matchAll(/card\("(set\.card\.[A-Za-z]+)"\)/g)]
      .flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
    const modeKeys = [...codeOnly(src.playground).matchAll(/\{\s*mode:\s*"[a-z]+",\s*key:\s*"(pg\.mode\.[a-z]+)"\s*\}/g)]
      .flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
    return {
      nav: (src.html.match(/class="nav-item"/g) ?? []).length,
      warn: (src.events.match(/warnBanner\.appendChild\(/g) ?? []).length,
      warnKeys: new Set([...src.dict.matchAll(/"ev\.warn[A-Za-z]+"/g)].map((m) => m[0])).size,
      cards: cardNames.length,
      modes: modeKeys.length,
      cardNames,
      modeKeys,
    };
  }

  const realPanel = (): PanelCounts => panelCounts(readPanelSource());

  /**
   * 文档里那几张表**按出现顺序**该有多少数据行，期望值逐项从屏幕派生。
   * 顺序就是它们在 ADMIN.md 里出现的顺序：§3 板块速查、§7 警告条、§10 调试台模式、§11 设置卡。
   */
  function expectedTables(c: PanelCounts): ReadonlyArray<readonly [why: string, rows: number]> {
    return [["板块速查", c.nav], ["警告条", c.warn], ["调试台模式", c.modes], ["设置卡", c.cards]];
  }

  /**
   * 一份期望序列 × 五份 ADMIN.md。返回失败报文数组。真扫描与探针**共用这一份**。
   *
   * ⚠️⚠️ **判据从「行数恰好等于 n 的表有且只有一张」改成了「按位置逐张比对」，
   * 而这是 Task 26A 一条真变异逼出来的，不是设计时想到的。**
   * 旧判据（Task 26）自己在注释里预言过「将来 Task 26A 往同一份文档里加表、撞上这两个
   * 数量时它会吵」。**那句预言只对了一半，实测当场证伪另一半**：模拟 Task 31 建出第 5 张
   * 设置卡（`cards` 4 → 5）之后，`tableRowFailures(5)` 在文档里确实找到**恰好一张** 5 行的表
   * ——**那是警告条那张**。于是「该红时红」那一格**全绿放行**：判据认了别人家的表，
   * 而它本该指出「设置卡那张表少了一行」。
   * 会吵的只有「同一份文档里两张表撞了同一个行数」，**两条锚撞到同一张表上它一声不吭**。
   * ⇒ 认表不能靠行数，只能靠位置：R2 已经把五份的 heading 序列钉死，第 k 张表在五份里
   * 就是同一张。位置法顺带多守住一件旧判据完全看不见的事——**文档里多写 / 少写一张表**。
   * 「四条锚两两不同数」那一格仍然留着：它守的是上面那张期望表的**顺序假设**
   *（两条锚同数时，顺序写反了这条判据看不出来）。
   */
  function tableSeqFailures(expected: ReadonlyArray<readonly [string, number]>, read: ApiDocReader): string[] {
    const want = expected.map(([, n]) => n);
    const out: string[] = [];
    for (const lang of LANGS) {
      const got = tableSizes(read(lang));
      if (JSON.stringify(got) === JSON.stringify(want)) continue;
      if (got.length !== want.length) {
        out.push(
          `${lang}/ADMIN.md 里有 ${got.length} 张表，而屏幕那边派生出 ${want.length} 张`
          + `（本份各表的行数：${JSON.stringify(got)}，期望：${JSON.stringify(want)}）`
          + "——多写或少写了一张表，或者某张表被中间的空行拆成了两张",
        );
        continue;
      }
      const diff = expected.flatMap(([why, n], i) =>
        got[i] === n ? [] : [`第 ${i + 1} 张（${why}）该是 ${n} 行，实际 ${got[i]} 行`]);
      out.push(
        `${lang}/ADMIN.md 的表行数与屏幕对不上：${diff.join("；")}`
        + "——屏幕上多了 / 少了一条而这一份文档没跟着改",
      );
    }
    return out;
  }

  it("非空锚：屏幕那几条计数都不是 0，且黄条的两个独立来源彼此认账", () => {
    const c = realPanel();
    expect(c.nav, "index.html 里一个 nav-item 都没数到——这一组测的是空气").toBeGreaterThan(0);
    expect(c.warn, "sec-events.js 里一条 warnBanner.appendChild 都没数到——这一组测的是空气").toBeGreaterThan(0);
    expect(c.cards, "sec-settings.js 里一张 card(\"set.card.*\") 都没数到——这一组测的是空气").toBeGreaterThan(0);
    expect(c.modes, "sec-playground.js 里一档 MODES 都没数到——这一组测的是空气").toBeGreaterThan(0);
    expect(c.warnKeys, `字典里的 ev.warn* 键数（${c.warnKeys}）与横幅里挂上去的 <p> 条数（${c.warn}）对不上`
      + "——两条独立派生互相不认了，先回屏幕上核对到底有几条黄条，再改这里").toBe(c.warn);
  });

  // ── 完备性锚：「我认全了」，不只是「我认出来的那些非空」（复评 F2）─────────────

  it("完备性锚：`card(` 的调用点数 === 认出来的卡名数，MODES 的条目数 === 认出来的档位键数", () => {
    const failures = recognitionFailures(readPanelSource());
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红：Task 31 那张卡写成多行 `card(\\n \"set.card.danger\",\\n)` —— 取名正则认不出，当场吵", () => {
    const src = readPanelSource();
    // 变异取真源：这正是复评实测里全绿逃逸的那一种写法。
    const mutated = {
      ...src,
      settings: src.settings.replace(
        'const examples = card("set.card.examples");',
        'const examples = card("set.card.examples");\n    const danger = card(\n      "set.card.danger",\n    );',
      ),
    };
    expect(mutated.settings === src.settings, "变异没落到 sec-settings.js 上——这一格控制是空的").toBe(false);
    const failures = recognitionFailures(mutated);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    // ⚠️ 期望的两个数**从真源现算**，不手写：Task 31 真的落地那天卡数会变，写死会在
    // 「判据其实什么都没坏」的那天红，而代价是逼后来的人去削弱这一格。
    const cards = realPanel().cards;
    for (const h of [`调用点有 ${cards + 1} 处`, `只认出 ${cards} 个`, "设置卡表"]) {
      expect(failures[0] ?? "", "吵了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
    // 共用入口这一层：整组的计数都从 `panelCounts()` 来，它必须当场抛，而不是少数一张。
    expect(() => panelCounts(mutated), "认不出却照常返回了一个偏小的计数——这正是复评量到的逃逸")
      .toThrow("认不出屏幕上的卡");
  });

  it("该红时红：MODES 多一档且带了额外属性（`beta: true`）—— 取键正则认不出，当场吵", () => {
    const src = readPanelSource();
    const mutated = {
      ...src,
      playground: src.playground.replace(
        '  { mode: "video", key: "pg.mode.video" },\n',
        '  { mode: "video", key: "pg.mode.video" },\n  { mode: "audio", key: "pg.mode.audio", beta: true },\n',
      ),
    };
    expect(mutated.playground === src.playground, "变异没落到 sec-playground.js 上——这一格控制是空的").toBe(false);
    const failures = recognitionFailures(mutated);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    // 同上：两个数从真源现算，模式档数将来一变，这一格不会假红。
    const modes = realPanel().modes;
    for (const h of [`MODES 表里有 ${modes + 1} 条`, `只认出 ${modes} 个`, "模式表"]) {
      expect(failures[0] ?? "", "吵了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
    expect(() => panelCounts(mutated)).toThrow("认不出屏幕上的卡");
  });

  it("不乱红：注释里写一句真代码片段（`card(\"set.card.danger\")`）不算调用点 —— 抠注释这一步是必需的", () => {
    const src = readPanelSource();
    // 本仓的注释里到处写真代码片段（`sec-settings.js` 卡 4 上方那段就在讲第 5 张卡），
    // 裸数 `card(` 会把它们一起数进来 ⇒ 完备性锚会在**判据什么都没坏**的那天红。
    const mutated = {
      ...src,
      settings: src.settings.replace(
        'const examples = card("set.card.examples");',
        '// 将来 Task 31 会写 const danger = card("set.card.danger");\n    const examples = card("set.card.examples");',
      ),
    };
    expect(mutated.settings === src.settings, "变异没落到 sec-settings.js 上——这一格控制是空的").toBe(false);
    expect(recognitionFailures(mutated), "注释里的那一句被当成了真的调用点").toEqual([]);
    expect(panelCounts(mutated).cards, "注释里的那一句被数进了卡数").toBe(realPanel().cards);
  });

  /**
   * 卡与模式那两条计数的**第二个独立来源**：字典。
   * 这里数出来的每一个名字都得在 `i18n-dict.js` 里有一条真的键——名字打错、卡被改名而
   * 字典没跟着改，都会在这一格红，而不是让上面那两条计数静静地少一个。
   * ⚠️ **字典这边只作证不当计数**，理由见 `panelCounts()` 上方那段。
   * ⚠️ **它挡不住「认不出来的那一张」**（复评 F2）：找不到的名字它按定义看不见，
   * 那一族归上面那三格完备性锚。
   */
  it("两条独立派生互相认账：设置卡与调试台模式的每个名字在字典里都有译文", () => {
    const c = realPanel();
    const dict = readPanelSource().dict;
    const missing = [...c.cardNames, ...c.modeKeys].filter((n) => !dict.includes(`"${n}":`));
    expect(missing, `这些名字在 admin-ui/js/i18n-dict.js 里没有对应的键：${missing.join("、")}`
      + "——要么屏幕上那张卡 / 那一档改名了字典没跟着改，要么本组的取名正则已经和源码对不上了")
      .toEqual([]);
  });

  /**
   * `expectedTables()` 手写的是**顺序**（板块 / 黄条 / 模式 / 设置卡），不是数值——
   * 数值逐项从屏幕派生。那个顺序本身能不能被判据看住，是这一格的问题。
   *
   * 逐张比对只有在**相邻两项的数不同**时才看得出「顺序写反了」。所以这里不写一条
   * 「四个数两两不同」的洁癖断言（那种断言会在两条锚碰巧同数的那天红，而那一天
   * 判据其实什么都没坏，代价是逼后来的人去削弱一道守卫），而是直接测那件事本身：
   * **把期望表里相邻两项对调，五份必须一起红。** 哪天某一对真的同数到让对调也看不出来，
   * **红的是这一格**，报文点名是哪一对——那才是「顺序假设失效了」的准确时刻。
   */
  it("非空锚：把期望表里相邻两项的顺序对调，五份必须一起红 —— 顺序假设是看得住的", () => {
    const base = expectedTables(realPanel());
    const blind: string[] = [];
    for (let i = 0; i + 1 < base.length; i += 1) {
      const swapped = [...base];
      swapped[i] = base[i + 1]!;
      swapped[i + 1] = base[i]!;
      if (tableSeqFailures(swapped, realAdminDoc).length !== LANGS.length) {
        blind.push(
          `把第 ${i + 1} 张（${base[i]![0]}，${base[i]![1]} 行）与第 ${i + 2} 张`
          + `（${base[i + 1]![0]}，${base[i + 1]![1]} 行）对调之后，判据看不出来`
          + "——这两张表的行数已经撞成同一个数，顺序写反了没有任何东西会响，得换一条不靠数值的认表法",
        );
      }
    }
    expect(blind, blind.join("\n")).toEqual([]);
    // 反向控制：顺序原样传进去时一格都不许红（这一格若红，说明真文档本身坏了）。
    expect(tableSeqFailures(base, realAdminDoc), "真表原样反而红了——先看真扫描那一格").toEqual([]);
  });

  it("五份 ADMIN.md 里四张表的行数，逐张等于屏幕那边对应的那个计数", () => {
    const failures = tableSeqFailures(expectedTables(realPanel()), realAdminDoc);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /** 与前几组同一条闸：真文档本身不过判据时，别让人从探针的报文里找原因。 */
  function probeTableBase(): void {
    const base = tableSeqFailures(expectedTables(realPanel()), realAdminDoc);
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「五份 ADMIN.md 里四张表的行数，逐张等于屏幕那边对应的那个计数」那一格：\n"
        + base.join("\n"),
      );
    }
  }

  it("该红时红：屏幕上多出一条黄条而五份文档没跟着加行 —— 五份一起红并点名是哪一张", () => {
    probeTableBase();
    const c = realPanel();
    const failures = tableSeqFailures(expectedTables({ ...c, warn: c.warn + 1 }), realAdminDoc);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
    for (const h of ["警告条", "第 2 张"]) {
      expect(failures[0] ?? "", "红了但报文没点名是哪一张表——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  it("该红时红：只有 ja 那份的警告条表被删掉一行 —— 只点名 ja", () => {
    probeTableBase();
    const oneRowLess = readerWith("ja", (s) => s.replace(/\n\| カーソル先行 \|[^\n]*/, ""), ADMIN);
    const failures = tableSeqFailures(expectedTables(realPanel()), oneRowLess);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "").toContain("ja/ADMIN.md");
    expect(failures[0] ?? "").toContain("警告条");
  });

  it("该红时红：index.html 里注释掉一个 nav-item —— 板块速查那张表五份一起红", () => {
    probeTableBase();
    const src = readPanelSource();
    const mutated = { ...src, html: src.html.replace('class="nav-item" data-section="models"', 'data-section="models"') };
    expect(mutated.html === src.html, "变异没落到 index.html 上——这一格控制是空的").toBe(false);
    const c = panelCounts(mutated);
    expect(c.nav, "变异没让 nav-item 少一个").toBe(realPanel().nav - 1);
    const failures = tableSeqFailures(expectedTables(c), realAdminDoc);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
    expect(failures[0] ?? "").toContain("板块速查");
  });

  // ── ⑥ 设置卡表与调试台模式表：同一条派生法，多两张表（P3e Task 26A）───────────
  //
  // ⚠️ **第 12 节（危险区）今天只有一句「这张卡还不存在」，靠的就是下面那条设置卡变异。**
  // 需求书要求那一节写「见设置页第 5 张卡」——**实测推翻**：`sec-settings.js` 今天只建
  // 四张卡（`card("set.card.…")` 四处），第 5 张是 Task 31 的。往文档里写一句指向
  // 一张不存在的卡的指路，正是本仓最忌的「描述一个还不存在的功能」。
  // ⇒ 那一节改成「今天还不存在」，而**「今天是四张」这句话由这一组看着**：
  // Task 31 建出第 5 张卡的那一刻，五份 ADMIN.md 的设置卡表一起红，逼人回来同时改
  // 第 11 节的表与第 12 节那句话。**这就是那句话的测法**，不是靠人记得回来改。

  it("该红时红：设置页多出第 5 张卡（危险区落地）而五份文档没跟着加行 —— 五份一起红", () => {
    probeTableBase();
    const src = readPanelSource();
    // 变异取真源：照 Task 31 真的会写的那一行加一张卡出来。
    const mutated = {
      ...src,
      settings: src.settings.replace(
        'const examples = card("set.card.examples");',
        'const examples = card("set.card.examples");\n    const danger = card("set.card.danger");',
      ),
    };
    expect(mutated.settings === src.settings, "变异没落到 sec-settings.js 上——这一格控制是空的").toBe(false);
    const c = panelCounts(mutated);
    expect(c.cards, "变异没让卡多一张").toBe(realPanel().cards + 1);
    // ⚠️ **落点断言：这条变异恰好让 `cards` 撞上 `warn`（都是 5）**——旧判据正是在这里
    // 全绿逃逸的（它去数「5 行的表有几张」，数到警告条那张，判为「有且只有一张」）。
    // 撞号这件事必须留在这一格里，否则改天两个数不撞了，这条变异就测不到那个洞了。
    expect(c.cards, "这条变异不再撞上黄条数了——它就不再覆盖旧判据逃逸的那个形态，得换一条").toBe(c.warn);
    const failures = tableSeqFailures(expectedTables(c), realAdminDoc);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
    for (const h of ["设置卡", "第 4 张"]) {
      expect(failures[0] ?? "", "红了但报文没点名是哪一张表——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  it("该红时红：只有 en 那份的模式表被删掉一行 —— 只点名 en", () => {
    probeTableBase();
    const oneRowLess = readerWith("en", (s) => s.replace(/\n\| Image \|[^\n]*/, ""), ADMIN);
    const failures = tableSeqFailures(expectedTables(realPanel()), oneRowLess);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "").toContain("en/ADMIN.md");
    expect(failures[0] ?? "").toContain("调试台模式");
  });

  it("该红时红：调试台少掉一档模式（比如图片档下线）而五份文档没跟着删行 —— 五份一起红", () => {
    probeTableBase();
    const src = readPanelSource();
    const mutated = {
      ...src,
      playground: src.playground.replace('  { mode: "image", key: "pg.mode.image" },\n', ""),
    };
    expect(mutated.playground === src.playground, "变异没落到 sec-playground.js 上——这一格控制是空的").toBe(false);
    const c = panelCounts(mutated);
    expect(c.modes, "变异没让模式少一档").toBe(realPanel().modes - 1);
    const failures = tableSeqFailures(expectedTables(c), realAdminDoc);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
    expect(failures[0] ?? "").toContain("调试台模式");
  });

  /**
   * 位置判据比旧的行数判据多守住的那一件事，单独钉一格：**文档里多写一张表**。
   * 旧判据只会去数「行数等于 n 的表有几张」，一张与那四个数都不撞的新表**它一眼都看不到**。
   */
  it("该红时红：某一份 ADMIN.md 里多写了一张表 —— 只点名那一份，并报「几张 vs 几张」", () => {
    probeTableBase();
    const extra = readerWith("zh-CN", (s) => `${s}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`, ADMIN);
    const failures = tableSeqFailures(expectedTables(realPanel()), extra);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    for (const h of ["zh-CN/ADMIN.md", "张表"]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  // ── ⑦ 三句「今天是什么样」的话，各自的测法（P3e Task 26A 复评回填）─────────────
  //
  // 这三句都是复评实测抓到的「五份一起说错」（F1 / F3 / F6）：结构判据、数字锚、
  // 软化词矩阵全绿，而句子本身与屏幕对不上。改真之外还得留下**会自己红的那一格**，
  // 否则下一次源码一动，这三句又会一起变成假话，而没有任何东西会响。

  /**
   * F1：设置卡表第 1 行原来写的是「认证密钥 = 网关口令 **+ 各条邮箱通道自己的凭据**」。
   * 实测：`CARD_AUTH` 只有 `gatewayToken` 一格，通道凭据由 `channelFields()` 渲染进
   * **卡 3（注册机）** 的两张对称子卡 ⇒ 运维照原文在两处都找不到它们。
   *
   * 这一格钉的是改真之后那两行话：**取值侧**（三张表里没有通道凭据）与**位置侧**
   *（`channelFields()` 的调用点夹在卡 3 与卡 4 的建卡语句之间）。哪天真把通道凭据搬进
   * 卡 1，这一格当场红，逼人回来同时改五份文档的第 1 行与第 3 行。
   */
  it("设置卡表第 1 / 3 行那两句话的测法：卡 1 只有网关口令，邮箱通道凭据渲染在卡 3 里", () => {
    expect([...CARD_AUTH], "认证密钥卡的字段清单变了——五份 ADMIN.md 设置卡表第 1 行那句话得跟着改")
      .toEqual(["gatewayToken"]);

    const channelPaths = CHANNELS.flatMap((c) => channelFields(c));
    expect(channelPaths.length, "一条通道凭据字段都没数到——这一格测的是空气").toBeGreaterThan(0);
    const elsewhere = [...CARD_AUTH, ...CARD_UPSTREAM, ...CARD_REGISTRAR, ...ADVANCED_FIELDS];
    const strayed = channelPaths.filter((p) => elsewhere.includes(p));
    expect(strayed, `这些通道凭据字段跑进了别的卡的字段表：${strayed.join("、")}`
      + "——五份 ADMIN.md 说它们在卡 3 的两张子卡里，那句话已经不成立了").toEqual([]);

    // 位置侧：抠注释之后，`channelFields(` 的调用点必须夹在卡 3 与卡 4 的建卡语句之间。
    const src = codeOnly(readPanelSource().settings);
    const reg = src.indexOf('card("set.card.registrar")');
    const call = src.indexOf("channelFields(");
    const examples = src.indexOf('card("set.card.examples")');
    expect([reg, call, examples].filter((i) => i < 0), "这三个落点有认不出来的——判据本身已经和源码对不上了")
      .toEqual([]);
    expect(reg < call && call < examples,
      `通道凭据的渲染点已经不在卡 3 那一段里了（卡 3 在 ${reg}，channelFields( 在 ${call}，卡 4 在 ${examples}）`
      + "——五份 ADMIN.md 设置卡表第 3 行那句话得跟着改").toBe(true);
  });

  /**
   * F5：设置那一节原来写的是「保存之后面板**不说**「已保存并生效」」，而屏幕上
   * `set.propagation` 逐字说的正是「本实例已经生效」——**文档与屏幕当面打架**。
   * 改真之后那一句引的是屏幕原话的**开头一截**，这一格就是那句引文的测法：
   * 引文逐份从 `i18n-dict.js` 里 `set.propagation` 的第一小句现算，字典一改，五份一起红。
   *
   * ⚠️ **比对是「抹掉空白 + 不分大小写」的**，理由是物理的：markdown 会在句子中间折行，
   * 而字典里那句是一行。代价写在这里——一处多余的空格它看不出来，它管的是「这句引文
   * 还是不是屏幕上那句话」，不是排版。
   */
  const squash = (s: string) => s.replace(/[\s*`"「」]/g, "").toLowerCase();

  /** `set.propagation` 五种语言各自的**第一小句**。真扫描与探针**共用这一份**。 */
  function propagationLeads(dictSrc: string): Record<Lang, string> {
    const line = dictSrc.split("\n").find((l) => l.includes('"set.propagation":'));
    if (line === undefined) {
      throw new Error("i18n-dict.js 里找不到 `set.propagation` 那一行——判据认不出真源了，先看这里");
    }
    const out = {} as Record<Lang, string>;
    for (const lang of LANGS) {
      const m = new RegExp(`(?:"${lang}"|${lang})\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(line);
      const whole = m?.[1];
      if (whole === undefined) {
        throw new Error(`i18n-dict.js 的 set.propagation 里取不出 ${lang} 那一句——判据认不出真源了`);
      }
      // 第一小句：到第一个句读为止（中日的「；。」、英韩的「; 」「. 」）。
      const lead = whole.split(/[；;。]|\.\s/)[0] ?? "";
      if (squash(lead).length < 5) {
        throw new Error(`set.propagation 在 ${lang} 下的第一小句短得不像一句话（「${lead}」）——判据退化了`);
      }
      out[lang] = lead;
    }
    return out;
  }

  /** 一份引文表 × 五份 ADMIN.md。返回失败报文数组。真扫描与探针**共用这一份**。 */
  function propagationFailures(leads: Record<Lang, string>, read: ApiDocReader): string[] {
    return LANGS.filter((l) => !squash(read(l)).includes(squash(leads[l]))).map((l) =>
      `${l}/ADMIN.md 的设置那一节没有逐字引到屏幕上那句「${leads[l]}」`
      + "——要么 `set.propagation` 改了文案而这一份没跟着改，要么这一份把引文改写了"
      + "（比对抹掉了空白与大小写，所以折行不算问题）");
  }

  it("设置那一节引的「本实例已经生效」是屏幕原话：逐份与 i18n 字典里 set.propagation 的第一小句对得上", () => {
    const failures = propagationFailures(propagationLeads(readPanelSource().dict), realAdminDoc);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红：屏幕那句 set.propagation 改了文案而五份文档没跟着改 —— 五份一起红", () => {
    const leads = propagationLeads(readPanelSource().dict);
    const base = propagationFailures(leads, realAdminDoc);
    if (base.length > 0) {
      throw new Error("本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「设置那一节引的「本实例已经生效」是屏幕原话…」那一格：\n"
        + base.join("\n"));
    }
    const reworded = Object.fromEntries(LANGS.map((l) => [l, `${leads[l]}（改过了）`])) as Record<Lang, string>;
    const failures = propagationFailures(reworded, realAdminDoc);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
  });

  /**
   * F6：模型那一节原来写的是「同一个模型在一条协议上可用、在另一条上不可用**是常态**」。
   * 实测 `MODEL_CATALOG`：唯一的对话模型挂满四条协议，三个媒体模型的 `protocols` 是空数组
   * ⇒ **今天一个这样的例子都没有**。改真之后那句话变成「今天没有一个模型是这样」，
   * 而这一格就是它的测法：哪天真出现一个「部分可用」的模型，它当场红。
   *
   * ⚠️ 后面那条 `toEqual([4, 1, 3])` 是**手写数字**，刻意的：五份 ADMIN.md 里「四条协议 /
   * 那个对话模型 / 三个媒体模型」这三个量词在五种语言里是汉字数词 / 英文单词 / 日文
   * 「4 つ」/ 韩文「네 가지」，**没有一种正则能把五种写法一起认下来**（数字锚那张表按
   * 阿拉伯数字 + 单位词工作，这里一个都套不上）。所以数字留在这一侧：目录一动它就红，
   * 报文直接告诉人回去改哪一句。
   */
  it("模型那一节「今天没有一个模型是一条协议可用、另一条不可用」的测法", () => {
    const protocols = [...new Set(MODEL_CATALOG.flatMap((m) => [...m.protocols]))];
    expect(protocols.length, "目录里一条协议都没数到——这一格测的是空气").toBeGreaterThan(0);
    expect(MODEL_CATALOG.length, "目录里一个模型都没有——这一格测的是空气").toBeGreaterThan(0);

    const partial = MODEL_CATALOG.filter((m) => m.protocols.length > 0 && m.protocols.length < protocols.length);
    expect(partial.map((m) => m.id), `这些模型只挂了一部分协议：${partial.map((m) => m.id).join("、")}`
      + "——五份 ADMIN.md 的模型那一节写着「今天目录里没有一个模型是这样」，那句话已经不成立了")
      .toEqual([]);

    const full = MODEL_CATALOG.filter((m) => m.protocols.length === protocols.length).length;
    const media = MODEL_CATALOG.filter((m) => m.protocols.length === 0).length;
    expect([protocols.length, full, media],
      "协议数 / 挂满协议的模型数 / 协议列为空的模型数，与五份 ADMIN.md 模型那一节写的"
      + "「四条协议、那个对话模型、三个媒体模型」对不上了——那三个量词是手写的，得回去改")
      .toEqual([4, 1, 3]);
  });

  /**
   * F3：排障那一节原来写的是「登录看起来成功了，却永远进不去」。
   * 实测 `admin-ui/js/app.js` 的登录前置闸：`sendable()` 不过时当场显示 `gate.badShape`，
   * `probe()` 一次都不跑 ⇒ 屏幕上根本不会「看起来成功」；部署那一侧真配了这种口令则整棵树
   * 不注册、给的是 `404`（已由同一节的 404 那一条覆盖）。两条路径都不产生原文描述的症状。
   *
   * 改真之后那一条写的是「登录框当场说有不被接受的字符，只收可打印 ASCII（`0x20–0x7E`）」。
   * **那个区间不许手抄**：这里拿真的 `sendable()` 逐字节量一遍 0x00–0xFF，再把区间格式化成
   * 文档里那个 code span 去核对。字符集一放宽 / 一收紧，期望的串当场变，五份一起红。
   */
  const hex2 = (c: number) => `0x${c.toString(16).toUpperCase().padStart(2, "0")}`;

  /** 真的 `sendable()` 逐字节量出来的可送码位。真扫描与探针**共用这一份**。 */
  const SENDABLE_BYTES: readonly number[] = (() => {
    const ok: number[] = [];
    for (let c = 0; c <= 0xff; c += 1) if (sendable(String.fromCharCode(c))) ok.push(c);
    return ok;
  })();

  /** 一个区间 × 五份 ADMIN.md。返回失败报文数组。真扫描与探针**共用这一份**。 */
  function charsetFailures(lo: number, hi: number, read: ApiDocReader): string[] {
    const token = `\`${hex2(lo)}–${hex2(hi)}\``;
    return LANGS.filter((l) => !read(l).includes(token)).map((l) =>
      `${l}/ADMIN.md 里找不到「${token}」（那个短横是 EN DASH U+2013，与 i18n 字典里 gate.badShape 那句逐字同款）`
      + "——要么 `sendable()` 的字符集变了而这一份没跟着改，要么这一份漏写了排障那一条");
  }

  it("排障那一节里的字符集区间是从 sendable() 现算的：五份都写着它，且它真是一段连续区间", () => {
    expect(SENDABLE_BYTES.length, "一个可送码位都没量到——这一组测的是空气").toBeGreaterThan(0);
    const lo = SENDABLE_BYTES[0] ?? -1;
    const hi = SENDABLE_BYTES[SENDABLE_BYTES.length - 1] ?? -1;
    expect(SENDABLE_BYTES.length,
      `${hex2(lo)}–${hex2(hi)} 之间有洞（量到 ${SENDABLE_BYTES.length} 个可送码位，区间宽 ${hi - lo + 1}）`
      + "——文档把它写成一个区间，那句话已经不成立了，得换一种写法而不是改这一格")
      .toBe(hi - lo + 1);
    // 排障那一条**点名了 `é` / `£`**（「发得出去，但本网关同样不收」）。
    // 「发得出去」那一半是 `sendable.mjs` 文件头的全 256 字节实测，这里证不了；
    // 「本网关不收」那一半是这里这两枪——哪天真放行了它们，这一格连同上面那个区间一起红。
    expect(["é", "£"].filter((c) => sendable(c)), "五份 ADMIN.md 说这两个字符本网关不收，而 sendable() 收了")
      .toEqual([]);
    const failures = charsetFailures(lo, hi, realAdminDoc);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红：字符集放宽到 0xFF（`é` / `£` 也收）而五份文档没跟着改 —— 五份一起红", () => {
    const lo = SENDABLE_BYTES[0] ?? -1;
    const base = charsetFailures(lo, SENDABLE_BYTES[SENDABLE_BYTES.length - 1] ?? -1, realAdminDoc);
    if (base.length > 0) {
      throw new Error("本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「排障那一节里的字符集区间是从 sendable() 现算的…」那一格：\n"
        + base.join("\n"));
    }
    const failures = charsetFailures(lo, 0xff, realAdminDoc);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
    expect(failures[0] ?? "", "红了但报文没写出它在找哪个串——报文是唯一会被看见的护栏").toContain("0x20–0xFF");
  });
});

/**
 * ── 根 README 的文档索引 + 两份英文功能表的对账（P3e Task 27）────────────────
 *
 * 根 `README.md` 是 GitHub 首屏。它有几处 R1–R6 一条都看不见的东西：
 *
 * ① **正文里所有相对链接指的文件在不在**。R4 只比五语言之间的链接多重集，**根 README
 *   根本不在那五份里**；就算在，「五份一起把同一个链接指错」也照样全绿（那句边界写在
 *   R1–R6 上方，逐字适用）。首屏那张表指错了，读者第一步就撞墙。
 *   ⚠️ **射程是整份文件，不是「以 `|` 开头的行」**：复评实测指出，只扫表格行会把
 *   首屏第一行的**语言切换行**和 `## Features` 里那几条指路链接一起漏在射程外，
 *   而那两处指错同样是首屏可见。存在性还要求**是文件**：`existsSync` 对目录也返回真，
 *   `[ADMIN](docs/en)` 点开是列目录不是文档（下面有一格该红时红钉这条）。
 * ④ **索引表按「行×列」定位**，不是「这个路径在不在某个集合里」。
 *   ⚠️ 这一条是复评用两条变异逼出来的：第一版把整张表的目标塞进一个 `Set` 再问「在不在」，
 *   于是「日本語行与한국어行的 README 链接对调」「英文行的 API 格与 DEPLOY 格对调」
 *   **两种置换都全绿**——集合里的元素一个没少，而屏幕上点「日本語 → README」落到韩文文档。
 *   现在每一行的语言从**该行 README 那一格**现算（不靠行序、也不靠语言显示名），
 *   再要求同一行里每一格都是 `docs/<该行语言>/<该列文档>.md`、链接文字与列名一致。
 * ⑤ **语言切换行与索引表互相印证**：`**Language:**` 那一行的标签→语言目录映射，
 *   必须与索引表每一行的行首标签→语言目录**逐条相等**。两处各写一份，写岔了首屏自相矛盾。
 *   「当前页那一种语言不带链接」也是现算的（`LANGS` 里没被链接到的那一种），不手写 `en`。
 * ② **根 README 与 `docs/en/README.md` 的 `## Features` / `## Models` 两节**：逐字节
 *   相同却是**两份复制**，此前没有任何机器守。
 *   ⚠️ **不许为了「一致」把两份合并成一份**：两者的结尾**刻意不同**（根那份是文档
 *   索引表 + 赞助，`docs/en/README.md` 那份是「Using the gateway」），合并会砍掉
 *   GitHub 首屏的索引表。正确做法就是这里这样——**只对共有的两节逐字节对账**，
 *   差异段落照旧各写各的（下面那格「不乱红」把这条边界摆成可执行的）。
 * ②B **另外两节也是两份复制**：`## Endpoints at a glance`（**含整张端点表**）与
 *   `## Quick start`。第一版的 `MIRRORED` 只有 Features / Models，复评实测点出这两节
 *   同样逐字节复制却无人守，而端点表恰恰是最会随开发漂的一张表。
 *   ⚠️ 这两节**不能**用逐字节全等：`docs/en/README.md` 那份结尾各多一句指路
 *   （`[API.md](./API.md)` / `[DEPLOY.md](./DEPLOY.md)`），根那份没有。判据取
 *   **「根那份是 en 那份的前缀」**——分叉发生在正文任何一处都会当场断掉前缀关系。
 *   ⚠️ 前缀天然放行「en 在尾巴上追加东西」，所以同一格额外钉住：**多出来的尾巴里
 *   不许出现表格行**，端点表不会在 en 那边偷偷长出第二半（有一格该红时红钉这条）。
 * ③ **六份 README 的版本徽章**：`scripts/set-version.sh` 用一个 `sed` 一次刷六份，
 *   漏了哪一份、或者谁手改过某一份，只有这一格看得见。
 *
 * ── 归一化只做那四条替换，写死在下面，**不许加第五条特例** ────────────────────
 * 根那份的链接以仓根为基准（`docs/en/DEPLOY.md`），`docs/en/README.md` 那份以自身
 * 目录为基准（`./DEPLOY.md`），指的是同一个文件，逐字节比之前必须先抹平这一层。
 * 归一化函数一旦写复杂，改一次链接写法就要跟着调它，最后没人敢让它红。
 * **链接写法要改就一起改这四条**，别往函数里堆特例。
 * ⚠️ 语言目录那一条的备选串**从 `LANGS` 现拼**，不再手抄第二份语言名单：第一版把
 *   `zh-CN|zh-TW|en|ja|ko` 逐字抄进正则，复评指出「不许加第五条特例」约束的是**替换条数**、
 *   管不到这张表跟不跟 `LANGS` 走——加第六种语言时 `LANGS` 侧会被别处强制、这一侧不会。
 *   下面「归一化认全了五种语言」那一格是它的测法（每一种语言逐个走一遍 `norm`）。
 *
 * ⚠️ **落地实测推翻了需求书里「② 建起来就绿」那一句**：`docs/en/README.md` 当时
 * 写的是裸 `(DEPLOY.md)` / `(REGISTRAR.md)`，而根那边归一化之后是 `(./DEPLOY.md)`,
 * 这一格**建起来就是红的**。方向只有一个——让 `docs/en/README.md` 侧写 `./`：
 * 反过来让根那边写裸文件名的话，那个链接在仓根上指向一个不存在的 `DEPLOY.md`，
 * ① 当场红。五语言 README 的同目录链接因此一起统一成 `./` 形态（R4 要求五份的
 * 链接多重集相同，只改 `docs/en/README.md` 一份会让 R4 红）。
 *
 * ── 它做不到什么（明写，别读成「首屏从此都是真的」）──────────────────────────
 * ⚠️ **这份名单本身被复评实测推翻过一次**，教训比名单更值钱：第一版在这里写的是
 * 「把 API 那一整列换成 `docs/en/USAGE.md`，五个文件都在，① 全绿」。逐字看没错——
 * ① 确实全绿——但实测那条变异**会被 ④ 红着拦下并逐语言点名五条 `docs/<语言>/API.md`**。
 * 一份**指错方向**的边界名单比不写更容易让人放心：它请读者去担心一件已经有人守的事，
 * 而真正没人守的（当时是「整行/整列置换」）根本不在名单里。**下面每一条都是实测过的。**
 *
 * · ① 只查**链接指的文件在不在**，不查**指得对不对**。索引表那 `LANGS × DOCS` 格今天由
 *   ④ 按行×列兜住，**但正文散文里的链接只有 ①**：把 `## Features` 里那条指向
 *   `REGISTRAR.md` 的链接**六份一起**改指 `USAGE.md`（根那份写 `docs/en/USAGE.md`、
 *   五语言各写 `./USAGE.md`），文件在、② 不分叉、R4 五份一致 ⇒ **全绿**。
 *   这是今天真正剩下的那个洞。
 *   ⚠️ 这一条的第一版写的是「**两份**一起改 ⇒ 全绿」，**实测是红的**——只改根与 en
 *   会让 R4（五语言链接多重集）逐字点名 en。回填时差点在同一段里再写一句假话；
 *   现在这句是按「六份一起改 ⇒ 本文件全绿、EXIT=0」的实测重写的（**这里刻意不写用例条数**：
 *   那个数每加一格就漂一次，写下来就是下一句假话）。
 * · ② 只证明**两份复制没分叉**，不证明任何一份说得对：两份一起说错，它一个字都不吭。
 * · ②B 是**前缀**判据：`docs/en/README.md` 在这两节尾巴上追加的散文不受管（只钉住
 *   尾巴里不许有表格行）；根那份**永远不会**因为 en 多写而红，反过来也一样。
 * · ④⑤ 只认 `## Documentation` 那张表与 `**Language:**` 那一行的**结构**：行首标签写的是
 *   哪一国文字、链接文字与目标是不是同一种语言，它一概不看——「`한국어` 这四个字其实是韩文」
 *   这种事没有机器判据，只能靠人。
 * · ③ 只比字符串包含，管不到徽章的颜色与链接目标，也管不到 `package.json` 里那一份
 *   版本号（那是 `scripts/set-version.sh` 一次刷的另一半）。
 * · 面板条目里那句话是否属实（`ADMIN_TOKEN` 没设时 `/admin` 真的不注册），**这一组
 *   一无所知**——但那件事并非无人守：
 *   tests/contract/wiring.test.ts「ADMIN_TOKEN 真的接到了 /admin 上（两个方向都断言）」
 *   的反向那一枪钉的正是它，而且 `tests/contract/` 双运行时都跑。
 *   文档判据管不了的是**文档**，不是那个行为。
 */
describe("根 README 的文档索引与两份英文功能表（P3e Task 27）", () => {
  /** 两份**逐字节全等**的复制节。下面第一格是它的非空锚：认不出要吵，不许静静给出空串。 */
  const MIRRORED = ["Features", "Models"] as const;

  /**
   * 两份**前缀相同**的复制节：`docs/en/README.md` 那份结尾各多一句指路，根那份没有。
   * ⚠️ 复评实测：这两节此前不在 `MIRRORED` 里，而 `## Endpoints at a glance` 里是**整张端点表**。
   */
  const MIRRORED_PREFIX = ["Endpoints at a glance", "Quick start"] as const;

  /** 六份 README：根那份 + 五语言。`LANGS` 变了它自动跟着变，不手抄第二份名单。 */
  const SIX = ["README.md", ...LANGS.map((l) => `docs/${l}/README.md`)] as const;

  /**
   * ⚠️ 只做这四条替换，**不许加第五条特例**（理由见上方 docblock）。
   * 第一条的语言备选串从 `LANGS` 现拼——这里不留第二份手写语言名单。
   */
  const norm = (s: string) => s
    .replace(new RegExp(`\\(docs/(${LANGS.join("|")})/`, "g"), "(../$1/")
    .replace(/\(\.\.\/en\//g, "(./")
    .replace(/\(LICENSE\)/g, "(../../LICENSE)")
    .replace(/\(\.\.\/\.\.\/LICENSE\)/g, "(../../LICENSE)");

  /**
   * 取一节。**认不出返回 `null`，绝不返回空串。**
   *
   * 这不是洁癖：写成 `indexOf` + `slice` 的那个直觉版本，标题找不到时 `indexOf`
   * 返回 `-1`，`slice(-1, j)` 会**静静给出空串**，而两份的空串恰好相等——两份一起
   * 把 `## Features` 改成别的名字，那一格会装作没事。测法是下面「认不出要吵」那一格。
   */
  /** 取一节的原始行（**不归一化**）。④⑤ 要按原样看路径，不能拿被 `norm` 改写过的串去比。 */
  const rawSection = (body: string, heading: string): string[] | null => {
    const lines = body.split("\n");
    const i = lines.findIndex((l) => l === `## ${heading}`);
    if (i < 0) return null;
    let j = i + 1;
    while (j < lines.length && !lines[j]!.startsWith("## ")) j += 1;
    return lines.slice(i, j);
  };

  const sectionOrNull = (body: string, heading: string): string | null => {
    const lines = rawSection(body, heading);
    return lines === null ? null : norm(lines.join("\n")).trim();
  };

  const sectionOf = (body: string, heading: string, where: string): string => {
    const s = sectionOrNull(body, heading);
    if (s === null) {
      throw new Error(`${where} 里找不到 \`## ${heading}\` 这一节——两份复制的对账认不出小节时当场吵，不装作两份都是空的`);
    }
    return s;
  };

  /**
   * 根 README 里**所有**相对链接目标——不只索引表那几行，语言切换行与 `## Features`
   * 里那几条指路链接都在射程内。**真扫描与反向控制共用这一份。**
   */
  const relTargets = (body: string) =>
    [...body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!).filter((t) => !t.startsWith("http"));

  /**
   * 坏链。**「在磁盘上存在」不够，还得是文件**：`existsSync("docs/en")` 对目录返回真，
   * 而 `[ADMIN](docs/en)` 点开是列目录不是文档（下面有一格该红时红钉这条）。
   */
  const brokenTargets = (body: string) =>
    relTargets(body).filter((t) => !(existsSync(t) && statSync(t).isFile()));

  /**
   * 把两处**各出现恰好一次**的串对调。
   * ⚠️ 占位串必须是文档里不可能出现的东西，**不许用空格**——`"...".replace(" ", x)` 换的是全文第一个空格，
   * 变异会落到一个完全无关的地方，而那一格照样「红」。换不干净当场抛，不许静静给出原文。
   */
  const swapOnce = (body: string, x: string, y: string) => {
    const PH = "[[swapped-cell]]";
    for (const [s, want] of [[x, 1], [y, 1], [PH, 0]] as const) {
      const n = body.split(s).length - 1;
      if (n !== want) throw new Error(`变异没落地——「${s}」在这段文本里出现了 ${n} 次，不是 ${want} 次`);
    }
    const out = body.replace(x, PH).replace(y, x).replace(PH, y);
    if (out === body || out.includes(PH)) throw new Error("变异没落地——对调之后文本没变，或占位串没换回来");
    return out;
  };

  /**
   * 每一格「该红时红」的统一前置。
   *
   * ⚠️ 这一条是复评用两条变异逼出来的，**回填时又差点在新写的几格里重演**：探针的基取自
   * **真文档**，真文档今天本身就不过判据时，探针会跟着红，而它的报文说的是
   * 「判据坏了」——把人直直引向一个没坏的东西。仓里 `charsetFailures` 那一族早有正确写法，
   * 本族每一格现在都抄这条纪律：**先看基干不干净，脏了就当场抛并把人指回主格**。
   */
  const probeBase = (failures: readonly string[], mainCell: string) => {
    if (failures.length > 0) {
      throw new Error("本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + `别从这一格的报文里找原因，真因在「${mainCell}」那一格：\n${failures.join("\n")}`);
    }
  };

  /** 一格里的相对路径；这一格不是「[文字](目标)」的形态就返回 `null`（认不出要吵，不装作空串）。 */
  const cellTarget = (cell: string) => /^\[([^\]]*)\]\(([^)]+)\)$/.exec(cell)?.[2] ?? null;
  const cellText = (cell: string) => /^\[([^\]]*)\]\(([^)]+)\)$/.exec(cell)?.[1] ?? null;

  /**
   * `## Documentation` 那一节里的索引表，拆成表头 + 数据行（分隔行 `|---|` 丢掉）。
   * **认不出返回 `null`**，绝不返回一张空表——空表会让下面每一条判据都「零缺格」地静静放行。
   */
  const indexTable = (body: string): { header: string[]; rows: string[][] } | null => {
    const lines = rawSection(body, "Documentation");
    if (lines === null) return null;
    const cells = lines
      .filter((l) => l.startsWith("|"))
      .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
      .filter((r) => !r.every((c) => /^-+$/.test(c)));
    if (cells.length < 2 || cells[0]!.length < 2) return null;
    return { header: cells[0]!, rows: cells.slice(1) };
  };

  /** 索引表每一行的「语言目录 ← 行首显示名」。语言从**该行 README 那一格**现算。 */
  const indexRows = (body: string): Array<{ lang: string; label: string }> => {
    const t = indexTable(body);
    if (t === null) return [];
    const at = t.header.findIndex((h) => h.toLowerCase() === "readme");
    if (at < 1) return [];
    return t.rows.flatMap((row) => {
      const lang = /^docs\/([^/]+)\/README\.md$/.exec(cellTarget(row[at] ?? "") ?? "")?.[1];
      return lang === undefined ? [] : [{ lang, label: row[0] ?? "" }];
    });
  };

  /**
   * ④ 的失败报文全集：**按行×列定位**。
   * 每一行的语言从该行 README 那一格现算，于是「两行的 README 链接对调」「同一行里两格对调」
   * 都会让「行语言 × 列文档」对不上。**真扫描与反向控制共用这一份。**
   */
  const indexGridFailures = (body: string): string[] => {
    const t = indexTable(body);
    if (t === null) {
      return ["认不出根 README `## Documentation` 那一节里的索引表——认不出要吵，不许静静报零缺格"];
    }
    const cols = t.header.map((h, i) => (i === 0 ? null : DOCS.find((d) => d.toLowerCase() === h.toLowerCase()) ?? null));
    const out = cols.flatMap((d, i) =>
      i > 0 && d === null ? [`索引表第 ${i + 1} 列的表头「${t.header[i]}」在 DOCS 里没有同名文档`] : []);
    const noCol = DOCS.filter((d) => !cols.includes(d));
    if (noCol.length > 0) out.push(`这些文档在首屏索引表里连一列都没有：${noCol.join("、")}——文档写了却没有入口，等于没写`);
    const readmeAt = cols.indexOf("README");
    if (readmeAt < 1) return [...out, "索引表里没有 README 这一列——每一行的语言就是从这一格现算的，缺了它整条判据无从谈起"];
    const seen: string[] = [];
    t.rows.forEach((row, r) => {
      const where = `索引表第 ${r + 1} 行（行首「${row[0] ?? ""}」）`;
      if (row.length !== t.header.length) {
        out.push(`${where}的格数与表头对不上：${row.length} vs ${t.header.length}——整列多半被删了或多打了一根竖线`);
        return;
      }
      const lang = /^docs\/([^/]+)\/README\.md$/.exec(cellTarget(row[readmeAt] ?? "") ?? "")?.[1];
      if (lang === undefined) {
        out.push(`${where}的 README 格不是 \`docs/<语言>/README.md\` 的形态：${row[readmeAt]}`);
        return;
      }
      seen.push(lang);
      cols.forEach((doc, i) => {
        if (doc === null) return;
        const cell = row[i]!;
        const want = `docs/${lang}/${doc}.md`;
        const got = cellTarget(cell);
        if (got !== want) {
          out.push(`${where}的「${t.header[i]}」列指向 ${got ?? `一格不是链接的东西「${cell}」`}，按行×列该是 ${want}`);
        }
        const text = cellText(cell);
        if (text !== null && text.toLowerCase() !== doc.toLowerCase()) {
          out.push(`${where}的「${t.header[i]}」列链接文字写着「${text}」，与列名对不上——屏幕上写一处、点开去另一处`);
        }
      });
    });
    const missing = LANGS.filter((l) => !seen.includes(l));
    if (missing.length > 0) out.push(`索引表里没有这几种语言的行：${missing.join("、")}`);
    const extra = seen.filter((l) => !(LANGS as readonly string[]).includes(l));
    if (extra.length > 0) out.push(`索引表里有 LANGS 之外的语言行：${extra.join("、")}`);
    return out;
  };

  /**
   * ⑤ 的失败报文全集：`**Language:**` 那一行与索引表**互相印证**。
   * 「当前页那一种语言不带链接」是现算的——`LANGS` 里没被链接到的那一种，不手写 `en`。
   */
  const switcherFailures = (body: string): string[] => {
    const line = body.split("\n").find((l) => l.startsWith("**Language:**"));
    if (line === undefined) return ["认不出根 README 的语言切换行（`**Language:**` 开头那一行）——认不出要吵"];
    const cells = line.replace("**Language:**", "").split("|").map((s) => s.trim()).filter((s) => s !== "");
    const out: string[] = [];
    const label = new Map<string, string>();
    const plain: string[] = [];
    for (const c of cells) {
      const target = cellTarget(c);
      if (target === null) { plain.push(c); continue; }
      const lang = /^docs\/([^/]+)\/README\.md$/.exec(target)?.[1];
      if (lang === undefined) { out.push(`语言切换行里「${cellText(c)}」指向 ${target}，不是 \`docs/<语言>/README.md\``); continue; }
      label.set(lang, cellText(c) ?? "");
    }
    const unlinked = LANGS.filter((l) => !label.has(l));
    if (plain.length !== 1 || unlinked.length !== 1) {
      out.push(`语言切换行里应当恰好有一种语言是「当前页」（不带链接）：不带链接的有 ${plain.length} 个（${plain.join("、")}），`
        + `LANGS 里没被链接到的有 ${unlinked.length} 种（${unlinked.join("、")}）`);
    } else {
      label.set(unlinked[0]!, plain[0]!);
    }
    const rows = indexRows(body);
    if (rows.length === 0) return [...out, "认不出索引表的语言行，切换行的标签无从印证"];
    for (const { lang, label: inTable } of rows) {
      const inLine = label.get(lang);
      if (inLine === undefined) out.push(`索引表有 ${lang} 这一行，语言切换行里却没有这一种语言`);
      else if (inLine !== inTable) out.push(`${lang} 在语言切换行里叫「${inLine}」，在索引表行首却叫「${inTable}」——首屏两处自相矛盾`);
    }
    for (const lang of label.keys()) {
      if (!rows.some((r) => r.lang === lang)) out.push(`语言切换行有 ${lang}，索引表里却没有这一行`);
    }
    return out;
  };

  /** ② 的失败报文全集（逐字节全等）。**真扫描与反向控制共用这一份。** */
  const mirrorFailures = (root: string, en: string) => MIRRORED.flatMap((h) => {
    const a = sectionOf(root, h, "README.md");
    const b = sectionOf(en, h, "docs/en/README.md");
    return a === b ? [] : [`「${h}」两份复制分叉了`];
  });

  /** ②B 的失败报文全集（根那份是 en 那份的前缀 + 尾巴里不许有表格行）。**真扫描与反向控制共用这一份。** */
  const prefixFailures = (root: string, en: string) => MIRRORED_PREFIX.flatMap((h) => {
    const a = sectionOf(root, h, "README.md");
    const b = sectionOf(en, h, "docs/en/README.md");
    const out: string[] = [];
    const n = a.split("\n").length;
    if (n <= 3) out.push(`README.md 的「${h}」只取到 ${n} 行——取节的边界判据多半没落对地方`);
    if (!b.startsWith(a)) {
      out.push(`「${h}」两份复制分叉了：根那份不再是 docs/en/README.md 那份的前缀\n根：\n${a}\n——\nen：\n${b}`);
      return out;
    }
    const rows = b.slice(a.length).split("\n").filter((l) => l.trimStart().startsWith("|"));
    if (rows.length > 0) {
      out.push(`「${h}」在 docs/en/README.md 那边的尾巴里长出了表格行：${rows.join(" / ")}`
        + "——前缀判据管不到尾巴，表格必须整张落在前缀里");
    }
    return out;
  });

  it("非空锚：两节在两份里都取得出来，且都不是被截断成一两行的残节", () => {
    expect(MIRRORED.length, "复制节的名单是空的，这一组测的是空气").toBeGreaterThan(0);
    for (const p of ["README.md", "docs/en/README.md"]) {
      for (const h of MIRRORED) {
        const n = sectionOf(readFileSync(p, "utf8"), h, p).split("\n").length;
        expect(n, `${p} 的「${h}」只取到 ${n} 行——取节的边界判据多半没落对地方`).toBeGreaterThan(3);
      }
    }
  });

  it("认不出要吵：小节被改名时当场抛，不许两份空串相等就算过", () => {
    const body = readFileSync("docs/en/README.md", "utf8");
    const renamed = body.replace("\n## Features\n", "\n## Highlights\n");
    expect(renamed, "变异没落地——没找到 `## Features` 那一行，这一格控制是空的").not.toEqual(body);
    expect(sectionOrNull(renamed, "Features"), "小节改名之后仍然取出了东西").toBeNull();
    expect(() => sectionOf(renamed, "Features", "docs/en/README.md")).toThrowError(/找不到/);
  });

  it("归一化认全了五种语言 —— `norm` 里不留第二份手写语言名单", () => {
    for (const l of LANGS) {
      const want = l === "en" ? "(./API.md)" : `(../${l}/API.md)`;
      expect(norm(`[API](docs/${l}/API.md)`), `\`norm\` 认不出 ${l} 这一种语言——它的语言表没跟着 LANGS 走`)
        .toEqual(`[API]${want}`);
    }
    expect(norm("[X](docs/de/X.md)"), "`norm` 把 LANGS 之外的语言目录也归一化了——它多半没在拿 LANGS 拼")
      .toEqual("[X](docs/de/X.md)");
  });

  it("① 根 README 正文里的每一个相对链接都指向磁盘上真实存在的**文件**", () => {
    const body = readFileSync("README.md", "utf8");
    expect(relTargets(body).length, "根 README 里扫到的相对链接比索引表本身还少，链接正则多半写坏了")
      .toBeGreaterThanOrEqual(LANGS.length * DOCS.length);
    const broken = brokenTargets(body);
    expect(broken, `根 README 里这些相对链接在磁盘上不是一个存在的文件：${broken.join("、")}`).toEqual([]);
  });

  it("① 该红时红：索引表里某一行指向一个仓里没有的语言目录", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(brokenTargets(body), "① 根 README 正文里的每一个相对链接都指向磁盘上真实存在的**文件**");
    const gone = `docs/${"de"}/README.md`;
    const mutated = body.replaceAll("[README](docs/ja/README.md)", `[README](${gone})`);
    expect(mutated, "变异没落地——索引表里没有 `[README](docs/ja/README.md)` 这一格").not.toEqual(body);
    expect(brokenTargets(mutated), "索引表指向了一个不存在的文件，① 却没红").toEqual([gone]);
  });

  it("① 该红时红：链接指到的是一个**目录**而不是文件 —— `existsSync` 会放行，① 不许放行", () => {
    expect(existsSync("docs/en") && !statSync("docs/en").isFile(), "docs/en 不是一个存在的目录，这一格控制是空的").toBe(true);
    const body = readFileSync("README.md", "utf8");
    probeBase(brokenTargets(body), "① 根 README 正文里的每一个相对链接都指向磁盘上真实存在的**文件**");
    const mutated = body.replaceAll("(docs/en/ADMIN.md)", "(docs/en)");
    expect(mutated, "变异没落地——根 README 里没找到 `(docs/en/ADMIN.md)`").not.toEqual(body);
    expect([...new Set(brokenTargets(mutated))], "链接指到了一个目录，① 却放行了").toEqual(["docs/en"]);
  });

  it("① 不乱红：语言切换行与 Features 里那几条散文链接也在射程内，今天它们都是真文件", () => {
    const body = readFileSync("README.md", "utf8");
    const inTable = new Set(indexTable(body)!.rows.flatMap((r) => r.map((c) => cellTarget(c)).filter((t): t is string => t !== null)));
    const outside = relTargets(body).filter((t) => !inTable.has(t));
    expect(outside.length, "表格之外一个相对链接都没扫到——① 多半又缩回只扫 `|` 开头的行了")
      .toBeGreaterThan(0);
    expect(outside.filter((t) => !(existsSync(t) && statSync(t).isFile())), "表格之外的相对链接有坏的").toEqual([]);
  });

  it("④ 索引表按行×列定位 —— 每一行的语言从该行 README 那一格现算", () => {
    const failures = indexGridFailures(readFileSync("README.md", "utf8"));
    expect(failures, `首屏索引表对不上账：\n${failures.join("\n")}`).toEqual([]);
  });

  it("④ 该红时红：两行的 README 链接对调（目标集合一个元素都没少）—— 按行×列当场红", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(indexGridFailures(body), "④ 索引表按行×列定位 —— 每一行的语言从该行 README 那一格现算");
    const mutated = swapOnce(body, "[README](docs/ja/README.md)", "[README](docs/ko/README.md)");
    expect(new Set(relTargets(mutated)), "对调之后目标集合竟然变了，那这一格证不了「集合看不见置换」")
      .toEqual(new Set(relTargets(body)));
    const failures = indexGridFailures(mutated);
    expect(failures.length, "两行的 README 链接对调了，④ 却没红——判据多半又缩回「在不在这个集合里」").toBeGreaterThan(0);
    for (const l of ["ja", "ko"]) {
      expect(failures.join("\n"), `④ 红了却没点到 ${l} 那一行`).toContain(`docs/${l}/API.md`);
    }
  });

  it("④ 该红时红：同一行里两格的**目标**对调（英文行的 API 与 Deploy）—— 链接文字照旧对得上，只有行×列看得见", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(indexGridFailures(body), "④ 索引表按行×列定位 —— 每一行的语言从该行 README 那一格现算");
    // 只在索引表那一节里换：`(docs/en/DEPLOY.md)` 在 `## Features` 里还有一处，全文换会打偏。
    const sec = rawSection(body, "Documentation")!.join("\n");
    const mutated = body.replace(sec, swapOnce(sec, "(docs/en/API.md)", "(docs/en/DEPLOY.md)"));
    expect(mutated, "变异没落地——索引表那一节没被改写").not.toEqual(body);
    const failures = indexGridFailures(mutated);
    expect(failures.join("\n"), "同一行里两格的目标对调了，④ 却没红").toContain("按行×列该是 docs/en/API.md");
    expect(failures.join("\n"), "④ 红了却没点出另一格").toContain("按行×列该是 docs/en/DEPLOY.md");
    expect(failures.filter((f) => f.includes("链接文字")), "这一格只调了目标、没动链接文字，报「文字对不上」说明判据在拿别的东西凑红")
      .toEqual([]);
  });

  it("④ 该红时红：索引表里 ADMIN 那一整列（连表头一起）被删掉 —— ④ 点名这份文档没有入口", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(indexGridFailures(body), "④ 索引表按行×列定位 —— 每一行的语言从该行 README 那一格现算");
    const t = indexTable(body)!;
    const k = t.header.findIndex((h) => h.toLowerCase() === "admin");
    expect(k, "索引表里没有 Admin 这一列，这一格控制是空的").toBeGreaterThan(0);
    const mutated = body.split("\n").map((l) => {
      if (!l.startsWith("|")) return l;
      const cells = l.split("|").slice(1, -1);
      return cells.length === t.header.length ? `|${cells.filter((_, i) => i !== k).join("|")}|` : l;
    }).join("\n");
    expect(mutated, "变异没落地——没有一行被删掉那一列").not.toEqual(body);
    const failures = indexGridFailures(mutated);
    expect(failures.join("\n"), "整列连表头一起删了，④ 却没点名 ADMIN 没有入口").toContain("ADMIN");
    expect(failures, `整列删掉只该报「这份文档连一列都没有」这一条，实报：\n${failures.join("\n")}`).toHaveLength(1);
  });

  it("④ 该红时红：链接文字与列名对不上（写着 README、点开去 API）", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(indexGridFailures(body), "④ 索引表按行×列定位 —— 每一行的语言从该行 README 那一格现算");
    const mutated = body.replaceAll("[API](docs/ko/API.md)", "[README](docs/ko/API.md)");
    expect(mutated, "变异没落地——索引表里没找到 `[API](docs/ko/API.md)`").not.toEqual(body);
    const failures = indexGridFailures(mutated);
    expect(failures.join("\n"), "链接文字与列名对不上，④ 却没红").toContain("链接文字写着「README」");
  });

  it("④ 认不出要吵：`## Documentation` 那一节被改名时报文明说认不出，不许静静报零缺格", () => {
    const body = readFileSync("README.md", "utf8");
    const renamed = body.replace("\n## Documentation\n", "\n## Docs index\n");
    expect(renamed, "变异没落地——没找到 `## Documentation` 那一行").not.toEqual(body);
    expect(indexTable(renamed), "小节改名之后仍然解析出了索引表").toBeNull();
    expect(indexGridFailures(renamed).join("\n"), "认不出索引表却没吵").toContain("认不出");
  });

  it("⑤ 语言切换行与索引表互相印证 —— 标签、语言目录两处一致", () => {
    const failures = switcherFailures(readFileSync("README.md", "utf8"));
    expect(failures, `首屏的语言切换行与索引表对不上账：\n${failures.join("\n")}`).toEqual([]);
    expect(indexRows(readFileSync("README.md", "utf8")).length, "索引表一行语言都没解析出来，⑤ 测的是空气")
      .toBe(LANGS.length);
  });

  it("⑤ 该红时红：语言切换行里两种语言的**标签**对调（链接目标一个没动）—— 首屏两处自相矛盾", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(switcherFailures(body), "⑤ 语言切换行与索引表互相印证 —— 标签、语言目录两处一致");
    const line = body.split("\n").find((l) => l.startsWith("**Language:**"))!;
    const mutated = body.replace(line, swapOnce(line, "[日本語]", "[한국어]"));
    expect(mutated, "变异没落地——语言切换行没被改写").not.toEqual(body);
    expect(new Set(relTargets(mutated)), "只调标签不该动到任何链接目标，这一格证的正是「目标全对、标签指错」")
      .toEqual(new Set(relTargets(body)));
    const failures = switcherFailures(mutated);
    for (const l of ["ja", "ko"]) {
      expect(failures.join("\n"), `⑤ 红了却没点到 ${l}`).toContain(`${l} 在语言切换行里叫`);
    }
  });

  it("⑤ 该红时红：切换行里少一种语言（当前页那一种不再是唯一没链接的）", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(switcherFailures(body), "⑤ 语言切换行与索引表互相印证 —— 标签、语言目录两处一致");
    const mutated = body.replaceAll(" | [한국어](docs/ko/README.md)", "");
    expect(mutated, "变异没落地——语言切换行里没找到 한국어 那一段").not.toEqual(body);
    const failures = switcherFailures(mutated);
    expect(failures.join("\n"), "切换行少了一种语言，⑤ 却没红").toContain("索引表有 ko 这一行");
  });

  it("⑤ 认不出要吵：语言切换行改了写法时报文明说认不出，不许静静报零缺格", () => {
    const body = readFileSync("README.md", "utf8");
    const mutated = body.replace("**Language:**", "**Languages:**");
    expect(mutated, "变异没落地——根 README 里没找到 `**Language:**`").not.toEqual(body);
    expect(switcherFailures(mutated).join("\n"), "语言切换行认不出了却没吵").toContain("认不出");
  });

  it("④⑤ 不乱红：索引表里两整行（连行首标签一起）对调 —— 重排是合法编辑，不许红", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase([...indexGridFailures(body), ...switcherFailures(body)],
      "④ 索引表按行×列定位 —— 每一行的语言从该行 README 那一格现算");
    const lines = body.split("\n");
    const [ja, ko] = ["| 日本語 |", "| 한국어 |"].map((h) => lines.findIndex((l) => l.startsWith(h)));
    expect(Math.min(ja!, ko!), "索引表里找不到 日本語 / 한국어 那两行，这一格控制是空的").toBeGreaterThan(0);
    const swapped = [...lines];
    swapped[ja!] = lines[ko!]!;
    swapped[ko!] = lines[ja!]!;
    const mutated = swapped.join("\n");
    expect(mutated, "变异没落地——那两行没被对调").not.toEqual(body);
    expect(indexGridFailures(mutated), "两整行合法重排却让 ④ 红了——判据多半把行序也当成了判据").toEqual([]);
    expect(switcherFailures(mutated), "两整行合法重排却让 ⑤ 红了——⑤ 比的是标签与语言的对应，不是顺序").toEqual([]);
  });

  it("② 根 README 与 docs/en/README.md 的 Features / Models 两节逐字节相同", () => {
    const root = readFileSync("README.md", "utf8");
    const en = readFileSync("docs/en/README.md", "utf8");
    for (const h of MIRRORED) {
      expect(sectionOf(en, h, "docs/en/README.md"), `${h} 两份复制分叉了`).toEqual(sectionOf(root, h, "README.md"));
    }
  });

  it("② 该红时红：docs/en/README.md 的 Features 里改一个字", () => {
    const root = readFileSync("README.md", "utf8");
    const en = readFileSync("docs/en/README.md", "utf8");
    probeBase(mirrorFailures(root, en), "② 根 README 与 docs/en/README.md 的 Features / Models 两节逐字节相同");
    const mutated = en.replace("streaming included", "streaming excluded");
    expect(mutated, "变异没落地——Features 里没找到 `streaming included`").not.toEqual(en);
    expect(sectionOf(mutated, "Features", "docs/en/README.md"), "改了一个字，② 却没红")
      .not.toEqual(sectionOf(root, "Features", "README.md"));
  });

  it("② 该红时红：docs/en/README.md 把 Features 里的 `./DEPLOY.md` 写回裸 `DEPLOY.md`", () => {
    const root = readFileSync("README.md", "utf8");
    const en = readFileSync("docs/en/README.md", "utf8");
    probeBase(mirrorFailures(root, en), "② 根 README 与 docs/en/README.md 的 Features / Models 两节逐字节相同");
    const mutated = en.replace("[DEPLOY.md](./DEPLOY.md)", "[DEPLOY.md](DEPLOY.md)");
    expect(mutated, "变异没落地——Features 里没找到 `[DEPLOY.md](./DEPLOY.md)`").not.toEqual(en);
    expect(sectionOf(mutated, "Features", "docs/en/README.md"), "归一化把 `./` 也一起抹掉了——那正是第五条特例在偷偷长出来")
      .not.toEqual(sectionOf(root, "Features", "README.md"));
  });

  it("②B 端点表 / Quick start：根那份是 docs/en/README.md 那份的前缀，en 只多结尾一句指路", () => {
    expect(MIRRORED_PREFIX.length, "前缀复制节的名单是空的，这一组测的是空气").toBeGreaterThan(0);
    const failures = prefixFailures(readFileSync("README.md", "utf8"), readFileSync("docs/en/README.md", "utf8"));
    expect(failures, `根 README 与 docs/en/README.md 的这两节对不上账：\n${failures.join("\n")}`).toEqual([]);
  });

  it("②B 该红时红：docs/en/README.md 的端点表里改一格 —— 前缀关系当场断掉", () => {
    const root = readFileSync("README.md", "utf8");
    const en = readFileSync("docs/en/README.md", "utf8");
    probeBase(prefixFailures(root, en), "②B 端点表 / Quick start：根那份是 docs/en/README.md 那份的前缀，en 只多结尾一句指路");
    const mutated = en.replaceAll("| GET | `/health` | – | no auth required |", "| GET | `/health` | – | auth required |");
    expect(mutated, "变异没落地——端点表里没找到 `/health` 那一行").not.toEqual(en);
    const failures = prefixFailures(root, mutated);
    expect(failures.join("\n"), "端点表里改了一格，②B 却还认为根那份是前缀").toContain("Endpoints at a glance");
  });

  it("②B 该红时红：docs/en/README.md 在端点表尾巴上长出第二张表 —— 前缀放行，表格行那一枪不放行", () => {
    const en = readFileSync("docs/en/README.md", "utf8");
    const root = readFileSync("README.md", "utf8");
    probeBase(prefixFailures(root, en), "②B 端点表 / Quick start：根那份是 docs/en/README.md 那份的前缀，en 只多结尾一句指路");
    const mutated = en.replace("\n## Models\n", "\n| POST | `/v1/audio` | – | 只在 en 这份偷偷长出来 |\n\n## Models\n");
    expect(mutated, "变异没落地——docs/en/README.md 里没找到 `## Models` 那一行").not.toEqual(en);
    const a = sectionOf(root, "Endpoints at a glance", "README.md");
    const b = sectionOf(mutated, "Endpoints at a glance", "docs/en/README.md");
    expect(b.startsWith(a), "这一格证的正是「前缀本身放行尾巴」，前缀先得成立").toBe(true);
    const failures = prefixFailures(root, mutated);
    expect(failures.join("\n"), "尾巴上长出了一整行表格，②B 的表格行那一枪却没红").toContain("长出了表格行");
  });

  it("②B 不乱红：en 侧那两句结尾指路（`./API.md` / `./DEPLOY.md`）今天就在，且不该让这一格红", () => {
    const root = readFileSync("README.md", "utf8");
    const en = readFileSync("docs/en/README.md", "utf8");
    // 这是上方 docblock 那句「en 侧结尾各多一句指路」的测法：哪天改了写法，这一格连同那句话一起红。
    for (const [h, link] of [["Endpoints at a glance", "(./API.md)"], ["Quick start", "(./DEPLOY.md)"]] as const) {
      const tail = sectionOf(en, h, "docs/en/README.md").slice(sectionOf(root, h, "README.md").length);
      expect(tail.trim(), `en 侧「${h}」那句结尾指路不见了——这一格的前提没了，它证不了「尾巴被放行」`).not.toEqual("");
      expect(tail, `en 侧「${h}」多出来的尾巴不再是那句指向 ${link} 的话`).toContain(link);
    }
    expect(prefixFailures(root, en), "en 侧那两句结尾指路把 ②B 弄红了——前缀判据本该放行尾巴").toEqual([]);
  });

  it("② 不乱红：两份刻意不同的结尾段（根是索引表 + 赞助，另一份是 Using the gateway）不进这一格", () => {
    const root = `${readFileSync("README.md", "utf8")}\n## Extra\n\nonly at the end of the root README.\n`;
    const en = readFileSync("docs/en/README.md", "utf8");
    for (const h of MIRRORED) {
      expect(sectionOf(en, h, "docs/en/README.md"), `${h}：只在根那份结尾多加一段就让这一格红了，说明取节的右边界没有真的收住`)
        .toEqual(sectionOf(root, h, "README.md"));
    }
  });

  /** 徽章缺失的那几份。**真扫描与反向控制共用这一份**，`read` 是唯一的注入点。 */
  const badgeMissing = (v: string, read: (p: string) => string) => SIX.filter((p) => !read(p).includes(`version-v${v}`));

  it("③ 六份 README 的版本徽章与 VERSION 一致", () => {
    const v = readFileSync("VERSION", "utf8").trim();
    expect(v, "VERSION 是空的，这一格会拿空串去比，测的是空气").not.toEqual("");
    const missing = badgeMissing(v, (p) => readFileSync(p, "utf8"));
    expect(missing, `这几份 README 的徽章与 VERSION（v${v}）对不上：${missing.join("、")}`).toEqual([]);
  });

  it("③ 该红时红：只有 docs/ja/README.md 的徽章停在了另一个版本上 —— 只点名那一份", () => {
    const v = readFileSync("VERSION", "utf8").trim();
    const parts = v.split(".");
    const other = [String(Number(parts[0]) + 1), ...parts.slice(1)].join(".");
    expect(`version-v${other}`, "构造出来的另一个版本号包含了当前这个，`includes` 会照旧命中，这一格控制是空的")
      .not.toContain(`version-v${v}`);
    probeBase(badgeMissing(v, (p) => readFileSync(p, "utf8")), "③ 六份 README 的版本徽章与 VERSION 一致");
    const missing = badgeMissing(v, (p) => {
      const body = readFileSync(p, "utf8");
      if (p !== "docs/ja/README.md") return body;
      const m = body.replaceAll(`version-v${v}`, `version-v${other}`);
      if (m.includes(`version-v${v}`)) throw new Error("变异没落地——docs/ja/README.md 里的徽章串没被换干净");
      return m;
    });
    expect(missing, "只有一份的徽章落后，③ 却没有恰好点名它").toEqual(["docs/ja/README.md"]);
  });

  /** 六份里没写某个 code span 的那几份。**真扫描与反向控制共用这一份**，`read` 是唯一的注入点。 */
  const spanMissing = (span: string, read: (p: string) => string) => SIX.filter((p) => !read(p).includes(`\`${span}\``));

  it("非空锚：六份 README 都写着面板那两个标识符 —— R6 只比多重集，六份一起删掉它不会红", () => {
    for (const c of ["ADMIN_TOKEN", "/admin"]) {
      const missing = spanMissing(c, (p) => readFileSync(p, "utf8"));
      expect(missing, `这几份 README 里没有 \`${c}\` 这个 code span：${missing.join("、")}——面板条目多半被删了`).toEqual([]);
    }
  });

  it("该红时红：某一份 README 的 `/admin` code span 被写成散文 —— 非空锚点名那一份", () => {
    const victim = "docs/ko/README.md";
    // 探针的基取自真文档。真文档今天本身就不过判据的话，这一格会跟着红 —— 但**别从这一格的报文里找原因**。
    // ⚠️ 复评实测：这一格原先用 `body.replace(...)` **只换第一处**，于是六份一起合法地多写一句
    // `` `/admin` `` 就会让它**假红**，而报文说的是「非空锚却没点名它」——把人直直引向判据。
    // 现在换 `replaceAll` + 「换干净了没有」，与紧邻的 ③ 那一格同一档严谨度。
    probeBase(spanMissing("/admin", (p) => readFileSync(p, "utf8")),
      "非空锚：六份 README 都写着面板那两个标识符 —— R6 只比多重集，六份一起删掉它不会红");
    const missing = spanMissing("/admin", (p) => {
      const body = readFileSync(p, "utf8");
      if (p !== victim) return body;
      const m = body.replaceAll("`/admin`", "the admin tree");
      if (m === body) throw new Error(`变异没落地——${victim} 里没找到 \`/admin\` 这个 code span`);
      if (m.includes("`/admin`")) throw new Error(`变异没落地——${victim} 里的 \`/admin\` code span 没被换干净`);
      return m;
    });
    expect(missing, "一份的标识符被写成散文，非空锚却没点名它").toEqual([victim]);
  });

  it("不乱红：六份 README 一起合法地多写一处 `` `/admin` `` —— 上面那一格不许因此假红", () => {
    const victim = "docs/ko/README.md";
    const extra = " The panel lives under `/admin`.";
    const missing = spanMissing("/admin", (p) => {
      const body = readFileSync(p, "utf8") + extra;
      if (p !== victim) return body;
      const m = body.replaceAll("`/admin`", "the admin tree");
      if (m === body) throw new Error(`变异没落地——${victim} 里没找到 \`/admin\` 这个 code span`);
      return m;
    });
    expect(missing, "六份一起多写了一处合法的 `/admin`，控制格却把 victim 之外的份也算成缺失（或漏掉了 victim）——"
      + "多半又退回了只换第一处的 `replace`").toEqual([victim]);
  });
});

/**
 * ── P3e Task 28：五语言 DEPLOY.md 的三笔欠账，逐笔各配一条会自己红的锚 ────────
 *
 * 本组守的是**这一次改动写下的那几句话本身**，与上面那张 `NUMBERS` 表分工不同：
 * · `NUMBERS` 判的是「同一个 token 在五份里出现次数相等」——它挡「某一份漏改」，
 *   但要求那个 token **跨五种语言逐字相同**（所以表里全是数字、路径、英文行名）；
 * · 本组判的是**每种语言各自写法**的那几句话（今天三句，见下面三张表）。这几句在五种
 *   语言里本来就不同字（比如 (4) 那句是 `3~4 次 get` / `3–4 gets` / `get 3〜4 回` /
 *   `get 3~4회`），塞进 `NUMBERS` 要么恒不相等、要么被迫把 token 削成一个满仓都是的裸数字。
 *   ⇒ 写法照上面 `UPSTREAM_FACTS.docHints`：**每语言一个只在这句里出现的 token**。
 *   ⚠️ 第 (3) 笔（Tier-2 读扇出与 Playground 视频档那两笔配额账）不在本组，它跨语言逐字
 *   相同，锚在上面 `NUMBERS` 那两条**从真源常量现算**的 token 上；那两段里不许出现软化词
 *   这一条，在本文件末尾那一组。**三处分工不同，别只读其中一处就以为守全了。**
 *
 * ⚠️ **这三张表都是「清单」，所以各自配了会让它变红的断言**（P3e 头号纪律）：
 * ① 正向：每种语言在**自己那份**里恰好 1 次；
 * ② 跨份：那个 token 在**其余四份里 0 次**——这一条挡的是「五份都塞同一句英文」
 *    这种糊弄法（ja/ko 的读者会拿到一句看不懂的话，而这几笔账的全部意义是让运维
 *    看懂「一次补池要打几次 get」「那半句承诺在 Worker 上到不到得了」）；
 * ③ 反向自检：表的语言集恰好等于 `LANGS`，且**没有两种语言共用同一个 token、
 *    也没有任何一个 token 是另一个的子串**。共用（或互为子串）时，某一份漏改会被
 *    另一份「替它满足」——这正是本仓 `NUMBERS` 表的已知边界，不许在这里重演。
 *    ⚠️ 这一格是**实测逼出来的**：zh-CN 与 zh-TW 原本逐字相同（都写 `3~4 次 get`），
 *    这一格当场红。
 *    ⚠️⚠️ **第一版的处置是把 zh-TW 正文改成「get 讀取 3~4 次」，那是判据反过来指挥
 *    文案，代价由读者承担（复评 H6）**。今天的处置是把锚**往左扩**到含各自的正字
 *    （简体「保存一次设置」/ 繁体「儲存一次設定」）：两份行首本来就不同字，扩完天然
 *    互异、互不为子串，还顺带把端点与 put 次数一起锚住，而 zh-TW 正文语序恢复成
 *    与其余四份一致。**扩锚不是放宽这一格**——判据一个字没松，换的是锚。
 *    ⚠️⚠️⚠️ 这条自检**自己也配了探针**（复评 H5：上一版它在真表上一次都不触发，
 *    实测把 `.toBe(false)` 改成 `.toBe(a.includes(b))` 之后本文件全绿）——
 *    见下面「该红时红：两种语言共用 / 互为子串 / 少一种语言」那一格，它与真扫描
 *    共用 `tokenTableFailures()`。
 *
 * ⚠️ **能与不能，一句话写清**：本组能证明「五份各自写着那句话、而且没有互相顶替」，
 * **不能**证明那句话说得对、也不能证明五份说的是同一件事——译文准确性今天仍靠人。
 */
describe("五语言 DEPLOY.md 的三笔欠账各自上锚（P3e Task 28）", () => {
  /**
   * (2) ③ 段那句「欠下的那几天会在恢复之后补上」后面必须紧跟的限定。
   * 依据：`src/http/usage-sink.ts` 的 `days`/`dirty` 累加器只在内存里，
   * 而同一份文档 ② 段自己写着 Worker 的 isolate 常常只活分钟级
   * ⇒ 「恢复之后补上」在 Worker 形态下**结构上到不了**，那半句必须带限定。
   */
  const ALIVE_QUALIFIER: Record<Lang, string> = {
    "zh-CN": "这个实例还活着",
    "zh-TW": "這個實例還活著",
    en: "provided the instance is still alive",
    ja: "インスタンスが生きている",
    ko: "인스턴스가 살아 있",
  };

  /**
   * (2') 同一段里紧跟着的那句：**这道闸在 Docker 形态下压根不存在**。
   *
   * ⚠️ **它是复评 H1 抓出来的一句假话的替身，不是锦上添花**：上一版这里写的是
   * 「Docker 形态下进程长活，这句承诺才是常态成立的」，而
   * `src/http/usage-sink.ts` 的 `resolveUsageFlushInterval()` 是
   * `budgetPerDay = hasWriteQuota ? USAGE_WRITES_PER_DAY : null`，
   * `src/http/wire.ts` 传进去的是 `runtime.quotaModel === "kv"`，
   * 而 `src/adapters/runtime-node.ts` 的 `quotaModel` 恒 `"file"`
   * ⇒ **Docker 上这道闸根本不存在**，既不会耗尽也没有「恢复」。
   * 既有契约测试逐字钉着这件事：`tests/contract/usage-tier2.test.ts`
   * 的「没设这个环境变量时：两种存储形态拿到逐字相同的间隔（2 小时），差别只在
   * 「有没有写配额」那道闸」（`budgetPerDay: null`）。
   * 同一份文档 ④ 段自己也写着「文件存储（Docker）没有写配额 …… 不再有每天的写预算」
   * ——那句假话是被同一份文档紧接着的 ④ 正面证伪的，**而五份齐说，跨语言判据一格都不响**。
   * 所以这句改真之后必须自带锚：漏改一份、或哪天有人把它改回「常态成立」，这里当场红。
   */
  const FILE_HAS_NO_GATE: Record<Lang, string> = {
    "zh-CN": "Docker 形态下这道闸压根不存在",
    "zh-TW": "Docker 形態下這道閘壓根不存在",
    en: "On Docker this gate does not exist at all",
    ja: "Docker 形態ではこの閘門そのものが存在しません",
    ko: "Docker 형태에서는 이 게이트 자체가 없으므로",
  };

  /**
   * (4) 「保存一次设置要发几次 get」——P3c 账本逐字登记「⇒ 登记 P3e」的那条无锚新账。
   * 五种语言写法本来就不同，逐份一个 token。
   *
   * ⚠️ 简繁两份的锚**往左扩到了行首的正字与端点**（复评 H6）：右半截
   * 「**1 次 put** + 3~4 次 get」两份逐字相同，只锚右半截就得去拧其中一份的正文。
   * 扩完之后这两个 token 顺带锚住了端点（`PUT /admin/api/config`）与 put 次数。
   */
  const GET_COUNT_HINT: Record<Lang, string> = {
    "zh-CN": "保存一次设置**（`PUT /admin/api/config`）：**1 次 put** + 3~4 次 get",
    "zh-TW": "儲存一次設定**（`PUT /admin/api/config`）：**1 次 put** + 3~4 次 get",
    en: "3–4 gets",
    ja: "get 3〜4 回",
    ko: "get 3~4회",
  };

  const TABLES = [
    { label: "(2) ③ 段那句承诺的限定", table: ALIVE_QUALIFIER },
    { label: "(2') 那道闸在 Docker 形态下压根不存在", table: FILE_HAS_NO_GATE },
    { label: "(4) 保存一次设置的 get 次数", table: GET_COUNT_HINT },
  ] as const;

  /**
   * 一张「每语言一个 token」的锚表 × 五份 DEPLOY.md，返回失败报文数组。
   * **真扫描与下面的探针共用这一份**——各写一份的话，两边的判据会各有各的口径，
   * 而其中一份坏了另一份不会响（本文件既有纪律）。
   */
  function perLangTokenFailures(label: string, table: Record<Lang, string>, read: ApiDocReader): string[] {
    const out: string[] = [];
    for (const lang of LANGS) {
      const token = table[lang];
      // 空串永远查得到 —— 认不出要吵，不许装没看见。
      if (token.trim() === "") {
        out.push(`${label}：${lang} 的锚 token 是空串——空串永远查得到，这一格从此空转`);
        continue;
      }
      const own = read(lang).split(token).length - 1;
      if (own !== 1) {
        out.push(
          `${label}：docs/${lang}/DEPLOY.md 里「${token}」出现 ${own} 次，应当恰好 1 次`
          + "——0 次多半是这一份漏改（或翻译时抄错了一位），"
          + "2 次以上说明这个 token 不再唯一，换一个只在那句话里出现的写法",
        );
      }
      for (const other of LANGS) {
        if (other === lang) continue;
        if (read(other).includes(token)) {
          out.push(
            `${label}：${lang} 的锚 token「${token}」在 docs/${other}/DEPLOY.md 里也出现了`
            + `——${other} 的读者拿到的是一句不属于他那种语言的话，`
            + "而且这两份从此会互相顶替：其中一份漏改另一份替它满足",
          );
        }
      }
    }
    return out;
  }

  it.each([...TABLES])("$label：五份 DEPLOY.md 各自写着自己那种语言的写法，且不串门", ({ label, table }) => {
    const failures = perLangTokenFailures(label, table, realDoc("DEPLOY"));
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /**
   * 一张锚表**自身**的三条自检，返回失败报文数组。
   * **真扫描与下面那格探针共用这一份**——上一版这三条是直接写在 `it()` 里的裸
   * `expect`，仓里没有任何东西会在它坏掉时变红：复评实测把子串那条的
   * `.toBe(false)` 改成 `.toBe(a.includes(b))`（判据变成同义反复）⇒ 本文件 202 格
   * 全绿、另外三处引用本文件的测试也全绿（78 格）。**一个不会自己红的清单不是守卫，
   * 是待办**——所以搬成函数，再配下面那格探针。
   */
  function tokenTableFailures(label: string, table: Partial<Record<Lang, string>>): string[] {
    const out: string[] = [];
    // 期望值是本文件那张手写的 `LANGS`，不是从表自己数出来再回填：两份独立的语言清单
    // 互校，某一边少一种语言时这一格当场红，而不是让上面那圈循环静静少跑一种。
    const want = [...LANGS].sort();
    const got = Object.keys(table).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      out.push(`${label} 的语言集与本文件的 LANGS 对不上：表 ${JSON.stringify(got)}，LANGS ${JSON.stringify(want)}`);
    }
    const vals = LANGS.map((l) => table[l]).filter((v): v is string => typeof v === "string");
    for (let i = 0; i < vals.length; i += 1) {
      for (let j = 0; j < vals.length; j += 1) {
        if (i === j) continue;
        const a = vals[i]!;
        const b = vals[j]!;
        if (a === b) {
          // 共用同一个 token：只报一次（i < j），否则同一对会报两条。
          if (i < j) out.push(`${label} 里有两种语言共用了同一个锚 token「${a}」`);
          continue;
        }
        if (a.includes(b)) {
          out.push(
            `${label} 里「${a}」把「${b}」整个包住了——互为子串与共用同一个 token 是同一种病：`
            + "包含关系下，被包住的那一份漏改会被另一份替它满足",
          );
        }
      }
    }
    return out;
  }

  // 这一格同时是下面那格探针的「我对 X 不乱红」那一半：两格共用 `tokenTableFailures`，
  // 探针证明三条分支各自点得出名，这一格证明它们在三张真表上一格都不响。
  it("反向自检：三张锚表的语言集恰好等于 LANGS，且没有两种语言共用（或互为子串）同一个 token", () => {
    for (const { label, table } of TABLES) {
      const failures = tokenTableFailures(label, table);
      expect(failures, failures.join("\n")).toEqual([]);
    }
  });

  it("该红时红：两种语言共用同一个 token / 其中一个是另一个的子串 / 表里少一种语言 —— 三条各自当场点名", () => {
    // ⚠️ **反向控制用仓里真实存在的串**：下面三张畸形表都从今天真的写在
    // `GET_COUNT_HINT` 里的那五个 token 派生，`"gets"` 也真的写在 docs/en/DEPLOY.md 里。
    const shared = tokenTableFailures("共用", { ...GET_COUNT_HINT, ko: GET_COUNT_HINT.en });
    expect(shared.length, `应当只红一条，实际：\n${shared.join("\n")}`).toBe(1);
    expect(shared[0]).toContain("共用了同一个锚 token");
    expect(shared[0]).toContain(GET_COUNT_HINT.en);

    const substring = tokenTableFailures("子串", { ...GET_COUNT_HINT, ko: "gets" });
    expect(substring.length, `应当只红一条，实际：\n${substring.join("\n")}`).toBe(1);
    expect(substring[0]).toContain("整个包住了");
    expect(substring[0]).toContain("「gets」");

    const short: Partial<Record<Lang, string>> = { ...GET_COUNT_HINT };
    delete short.ko;
    const missing = tokenTableFailures("少一种语言", short);
    expect(missing.length, `应当只红一条，实际：\n${missing.join("\n")}`).toBe(1);
    expect(missing[0]).toContain("语言集与本文件的 LANGS 对不上");
    expect(missing[0]).toContain("ko");
  });

  // ── 探针：变异只改一份，其余四份照旧走真文档；共用上面那份 `perLangTokenFailures` ──
  //
  // ⚠️ **反向控制用仓里真实存在的串**：下面三格都从今天真的写在文档里的那句话派生，
  // 不另造一个仓里不存在的世界。`readerWith` 在变异没落地时当场炸，所以「探针绿」
  // 不可能是「变异压根没打中」造成的。

  it("探针 M1：只改四份、ko 那份的限定被删掉 ⇒ 变红并点名 ko", () => {
    const failures = perLangTokenFailures(
      "(2) ③ 段那句承诺的限定",
      ALIVE_QUALIFIER,
      readerWith("ko", (s) => s.split(ALIVE_QUALIFIER.ko).join("인스턴스가 죽어 있"), "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/ko/DEPLOY.md");
    expect(failures[0]).toContain("出现 0 次");
  });

  it("探针 M2：把 ja 那份的 `get 3〜4 回` 改成 `get 2〜3 回` ⇒ 变红并点名 ja", () => {
    const failures = perLangTokenFailures(
      "(4) 保存一次设置的 get 次数",
      GET_COUNT_HINT,
      readerWith("ja", (s) => s.split("get 3〜4 回").join("get 2〜3 回"), "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/ja/DEPLOY.md");
    expect(failures[0]).toContain("出现 0 次");
  });

  it("探针 M1'：把 zh-CN 那句改回复评抓到的那句假话（「Docker 形态下进程长活…常态成立」）⇒ 变红并点名 zh-CN", () => {
    // 这一格钉的是复评 H1：那句假话五份齐说，跨语言计数判据一格都不响，
    // 所以改真之后必须有一个**每语言各一个**的 token 盯着它，改回去当场红。
    const failures = perLangTokenFailures(
      "(2') 那道闸在 Docker 形态下压根不存在",
      FILE_HAS_NO_GATE,
      readerWith(
        "zh-CN",
        (s) => s.split(FILE_HAS_NO_GATE["zh-CN"]).join("Docker 形态下进程长活，这句承诺才是常态成立的"),
        "DEPLOY",
      ),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/zh-CN/DEPLOY.md");
    expect(failures[0]).toContain("出现 0 次");
  });

  it("探针 M3：把 en 那句英文原样塞进 ko 那份（「五份都塞同一句英文」那种糊弄法）⇒ 变红并点名 ko", () => {
    // 这一格测的是上面第 ② 条：光看「每份都含自己的 token」是抓不住串门的
    // ——ko 那份仍然写着自己的 `get 3~4회`，正向那一半照绿。
    const failures = perLangTokenFailures(
      "(4) 保存一次设置的 get 次数",
      GET_COUNT_HINT,
      readerWith("ko", (s) => s.split("get 3~4회").join("get 3~4회（3–4 gets）"), "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/ko/DEPLOY.md");
    expect(failures[0]).toContain("3–4 gets");
  });

  it("不乱红：五份一起合法地多写一句无关的话 —— 上面那几格不许因此假红", () => {
    // 与探针同源的「我对 X 不乱红」那一半：五份各追加一段既不含任何锚 token、
    // 又与那两句话无关的正文，真扫描必须仍然是空。
    const noisy: ApiDocReader = (lang) => `${realDoc("DEPLOY")(lang)}\n\n<!-- 无关的一行 -->\n`;
    for (const { label, table } of TABLES) {
      const failures = perLangTokenFailures(label, table, noisy);
      expect(failures, `${label}：五份一起多写了一句无关的话，判据却红了\n${failures.join("\n")}`).toEqual([]);
    }
  });
});

/**
 * ── P3d 那条红线在 DEPLOY.md 一侧的机器化（P3e Task 28 复评 H3）───────────────
 *
 * 红线原话（P3d 起立着，登记在 `admin-ui/js/pure/playground.mjs` 自己的注释里）：
 * **真机了结之前，任何文案都不许把一个没量过的上限写成「足够 / 安全」。**
 * 它在 ADMIN.md 那一侧由上面那张软化词矩阵**整份**守着（Task 26A）。
 * Task 28 把**同一条红线性质的结论**写进了五份 DEPLOY.md 的配额账里，却没有把射程
 * 扩过去——复评实测：把 `docs/zh-CN/DEPLOY.md` 里
 * 「两页对不上，我们也没有在真机上了结过它 …… 60 就是超的」改写成
 * 「已经在真机上了结过了 …… 这 60 次是安全的、足够用」⇒ **202 passed，EXIT=0**，一格不红。
 *
 * ⚠️ **为什么不能像 ADMIN.md 那样整份扫**：五份 DEPLOY.md 里这六族词各已**合法**出现
 * 7~9 处（zh-CN/zh-TW 各 7、en 8、ja 9、ko 8，落地时逐份数过）。zh-CN 那 7 处逐条是：
 * 「全局是否安全取决于…」「重新粘一遍整份清单是廉价且安全的」「救的是可用性、不是
 * 安全性」「`TRUST_PROXY` 是安全开关」「环境变量里有这一项时清空是安全的」
 * 「安全边界：`DATA_DIR` 被设成 `/` …」「对账触发得越少…是安全的」——
 * **没有一处在讲那两笔没量过的账**。整份套矩阵会假红一整片，而假红的守卫下一步
 * 就会被人放宽或删掉。
 * ⭐ 这段里的计数**不是判据**（同本文件 N8 那条 ⭐）：会变红的是下面那几格，
 * 数字会过期，要数就当场自己数一遍。
 * ⇒ 照 `UPSTREAM_FACTS.docSections` 的形态**收窄射程**：只扫那两笔账各自所在的
 * 那一条顶格列表项。**射程收窄不是判据放宽**——下面「射程之外那些合法用法确实存在」
 * 那一格逐语言证明这张词表在同一份文档里认得出东西，所以块内为空不是「词表瞎了」。
 *
 * ⚠️ **锚点从真源常量现算**（同 `NUMBERS` 那两条，复评 H2）：常量一改，锚点就落空，
 * 而落空时这一组**报错而不是放行**（「认不出要吵」那一格钉着）。
 *
 * ── 它做不到什么（明写）────────────────────────────────────────────────────
 * 它只挡「用这六族软化词把结论说软」。**换一个不在表里的措辞**（「这个数没什么可担心的」）
 * 它一个字都看不见——这是子串词表的固有边界，与 ADMIN.md 那一侧逐字相同。
 * 它也不证明那两笔账的数字是对的：那由上面 `NUMBERS` 的派生 token 管。
 */
describe("五语言 DEPLOY.md 的两笔「没在真机上了结过」配额账不许被软化（P3e Task 28 复评 H3）", () => {
  const REDLINE_BLOCKS = [
    {
      id: "tier2-read-fanout",
      anchor: `${USAGE_DAY_RETAIN} × ${USAGE_SLOTS}`,
      why: "`30d` 那一档一次请求的 KV get 数——Cloudflare 两页官方文档对不上，本仓没在真机上量过",
    },
    {
      id: "playground-video",
      anchor: `1 + ${VIDEO_POLL_MAX_ATTEMPTS}`,
      // 同上：与 `NUMBERS` 那一行的 `why` 不同字，两组的报文才分得开。
      why: "Playground 视频档一次任务能打出的上游请求条数——`playground.mjs` 自己登记着「本仓从来没有量过」",
    },
  ] as const;

  /**
   * 射程：含锚点的那一行往上找最近的**顶格 `- `** 行，往下到下一个顶格 `- ` 行、
   * 下一个 markdown 标题、或 EOF 为止。**这一段就是那笔账的全部正文。**
   * 五份的这两条都是顶格列表项（R2/R5 只管标题与表格行，管不到这件事，所以下面
   * 「认不出要吵」那一格连「找不到顶格 `- `」一起当失败报出来）。
   */
  function blockOf(src: string, anchor: string): { lines: string[] } | { error: string } {
    const lines = src.split("\n");
    const hits = lines.flatMap((l, i) => (l.includes(anchor) ? [i] : []));
    if (hits.length !== 1) {
      return {
        error: `含锚点「${anchor}」的行有 ${hits.length} 行，应当恰好 1 行`
          + "——0 行多半是真源常量改了而这一份文档没跟着改，2 行以上说明这个锚点不再唯一；"
          + "两种情况下这一段的射程都已经说不清，不许当成「这一段很干净」放行",
      };
    }
    let from = hits[0]!;
    while (from >= 0 && !(lines[from] ?? "").startsWith("- ")) from -= 1;
    if (from < 0) return { error: `锚点「${anchor}」那一行往上找不到顶格的 \`- \`——射程的起点说不清了` };
    let to = from + 1;
    while (to < lines.length && !(lines[to] ?? "").startsWith("- ") && !/^#{1,6} /.test(lines[to] ?? "")) to += 1;
    return { lines: lines.slice(from, to) };
  }

  /** 两笔账 × 五份 DEPLOY.md。返回失败报文数组。真扫描与探针**共用这一份**。 */
  function redlineFailures(read: ApiDocReader): string[] {
    const out: string[] = [];
    for (const { id, anchor, why } of REDLINE_BLOCKS) {
      for (const lang of LANGS) {
        const got = blockOf(read(lang), anchor);
        if ("error" in got) {
          out.push(`${id}：docs/${lang}/DEPLOY.md ${got.error}（${why}）`);
          continue;
        }
        for (const { word, origins } of softenerHits(got.lines.join("\n"))) {
          out.push(
            `${id}：docs/${lang}/DEPLOY.md 的那一段（锚点「${anchor}」）把一件本仓从没在真机上`
            + `量过的事说成了「${word}」（软化概念 ${origins.join("、")}）`
            + `——${why}；能写下来的只有上限本身，以及「本仓没量过」这句话`,
          );
        }
      }
    }
    return out;
  }

  it("真扫描：五份 DEPLOY.md 的那两段里一个软化词都没有", () => {
    const failures = redlineFailures(realDoc("DEPLOY"));
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红：把 zh-CN 那段的结论改写成「这 60 次是安全的、足够用」⇒ 当场点名 zh-CN 与两条概念", () => {
    // ⚠️ **反向控制用仓里真实存在的串**：被替换掉的那一句今天逐字写在
    // docs/zh-CN/DEPLOY.md 里，替换文就是复评做过的那次真文件变异（V3）。
    const failures = redlineFailures(readerWith(
      "zh-CN",
      (s) => s.split("**两页对不上，我们也\n  没有在真机上了结过它**")
        .join("**两页虽然写法不同，但已经\n  在真机上了结过了**，这 60 次是安全的、足够用"),
      "DEPLOY",
    ));
    // ⚠️ **三条不是两条**：「足够用」这三个字同时命中 `enough` 的两个说法
    //（「足够」与「够用」），再加上「安全」命中 `safe` —— 落地时先按两条写，实跑当场
    // 摊出三条，按实测改的期望值（**发现不符先实测再决定**）。
    expect(failures.length, `应当红三条（足够 + 够用 + 安全），实际：\n${failures.join("\n")}`).toBe(3);
    for (const f of failures) {
      expect(f).toContain("docs/zh-CN/DEPLOY.md");
      expect(f).toContain("tier2-read-fanout");
    }
    const joined = failures.join("\n");
    for (const w of ["「足够」", "「够用」", "「安全」", "enough/zh-CN", "safe/zh-CN"]) {
      expect(joined, `报文里没点名 ${w}：\n${joined}`).toContain(w);
    }
  });

  it("认不出要吵：某一份里锚点落空时报「射程说不清」，不是当成这一段很干净", () => {
    // 这就是「真源常量改了而文档没跟着改」那一刻这一组会看到的东西。
    const failures = redlineFailures(readerWith(
      "ja",
      (s) => s.split(`1 + ${VIDEO_POLL_MAX_ATTEMPTS}`).join("1 + いっぱい"),
      "DEPLOY",
    ));
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/ja/DEPLOY.md");
    expect(failures[0]).toContain("应当恰好 1 行");
    expect(failures[0]).toContain("射程都已经说不清");
  });

  it("射程之外那些合法用法确实存在：整份扫时五份都必然命中 —— 块内为空不是「词表瞎了」", () => {
    // 「我认得出 X」那一半。没有这一格，上面那条真扫描的「全绿」既可能是
    // 「那两段确实干净」，也可能是「这张词表在 DEPLOY.md 上一个字都认不出来」。
    for (const lang of LANGS) {
      const whole = softenerHits(realDoc("DEPLOY")(lang));
      expect(whole.length, `docs/${lang}/DEPLOY.md 整份扫一个软化词都没命中——`
        + "这张词表在这一份上是瞎的，上面那条真扫描的全绿就什么都不证明了").toBeGreaterThan(0);
    }
  });
});
