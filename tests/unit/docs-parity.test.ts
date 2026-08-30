import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
// 抠注释走 `scripts/lib/strip-comments.mjs` 那一份真源（P3e Task 1 收编），不在这里手写第二份。
import { blankComments } from "../helpers/strip-comments.js";
// R11 的根那一半：16 节骨架的期望值取 W38 那张常量表，不在本文件手抄第二份标题清单。
import { SECTIONS } from "../helpers/readme-sections.js";
import { FAIL_REASONS } from "../../src/core/dispatcher.js";
import { UPSTREAM_FACTS, type UpstreamFact } from "../../src/core/admin/upstream-facts.js";
import { MODEL_CATALOG, PROTOCOLS, VIDEO_TASK_ID_SHAPE } from "../../src/core/admin/protocol-catalog.js";
// ADMIN.md 那一组的期望值一律从这些真源常量派生，不手写字面量。
import { ADMIN_TOKEN_MIN_LENGTH } from "../../src/http/admin/auth.js";
import { MAX_IMPORT_KEYS, PATCH_FIELDS } from "../../src/http/admin/handlers/keys-write.js";
import { EVENT_KEY_PREFIX, EVENT_WINDOW_MS, EVENT_WINDOW_RETAIN } from "../../src/core/admin/event-ring.js";
import { USAGE_DAY_RETAIN, USAGE_KEY_PREFIX, USAGE_SLOTS } from "../../src/core/admin/usage-stats.js";
// P3e Task 30：「重置到底重置了什么」那张表的键名**一律从真源 import**，
// 手写的只是这张 import 清单本身（那张清单自己有没有漏，由本文件末尾那一组的第二格扫源码钉着）。
import { CONFIG_KEY } from "../../src/core/config-provenance.js";
import { KEY_PREFIX, POOL_INDEX_KEY } from "../../src/core/pool-index.js";
import { TEND_HISTORY_KEY } from "../../src/core/admin/tend-history.js";
import { MANUAL_GUARD_KEY, MANUAL_TENDS_PER_DAY } from "../../src/core/admin/tend-guard.js";
import { TEND_LOCK_KEY } from "../../src/http/admin/tend-lock.js";
import { HEALTH_PROBE_KEY } from "../../src/core/storage-health.js";
import { CONFIG_TTL_MS, KV_EDGE_CACHE_MS } from "../../src/http/config-holder.js";
import { DEFAULT_POOL_CACHE_TTL_MS } from "../../src/core/keypool-repo.js";
import { SESSION_MAX_AGE_MS } from "../../admin-ui/js/pure/session.mjs";
// 复评回填（F1 / F3）：设置卡与字符集那两句话的期望值一律从这几份真源现算，不手抄。
import { sendable } from "../../admin-ui/js/pure/sendable.mjs";
import {
  ADVANCED_FIELDS, CARD_AUTH, CARD_REGISTRAR, CARD_UPSTREAM, channelFields, DANGER_ACTIONS,
} from "../../admin-ui/js/pure/settings.mjs";
// P3e Task 31 复评回填（F5）：危险区那张表的**行序**期望值从字典里 `titleKey` 那一行的
// 译文现算——那一列写的就该是屏幕上那颗按钮的标签，所以这里不另抄一份五语言按钮名。
import { I18N } from "../../admin-ui/js/i18n-dict.js";
// P3e Task 31：危险区那两条端点的路径**一律从真源常量现算**，不在本文件手抄字符串。
import { CONFIG_RESET_PATH } from "../../src/http/admin/handlers/config.js";
import { KEYS_PURGE_PATH } from "../../src/http/admin/handlers/keys-write.js";
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
    // ⚠⚠ **这两个 token 从真源常量现算，不写字面量**（P3f 回填，理由与下面 `${MANUAL_TENDS_PER_DAY} × 3` 那一条逐字相同）。
    // 上一版它俩写死成 `"**120"` / `"**90"`，而「常量真改了、五份 DEPLOY.md 一起没跟上」
    // 那一种靠的是另一组判据（它们把同一批数钉在常量上）——而那一组的期望源是一份
    // 内部设计文档，已随全部内部设计文档移出本仓。现算之后常量一改，token 就成了
    // 五份文档里查不到的串 ⇒ 下面那条 `total === 0` 当场红并点名 DEPLOY.md。
    // ⚠️ 它们仍然挡不住「五份被同一个错误值同步污染」——那是跨语言互校的固有边界。
    {
      token: `**${(DEFAULT_POOL_CACHE_TTL_MS + KV_EDGE_CACHE_MS) / 1000}`,
      why: "key 池快照的真实上界（DEFAULT_POOL_CACHE_TTL_MS + KV_EDGE_CACHE_MS），加粗标记只在这句出现",
    },
    // ⚠️ **这个锚点是 P3e Task 30 复评回填（F7）补的，照本组的规矩「数过再加」**：
    // 加之前 `**90` 在五份里**各 1 次**（就是配置生效上界那一句，五份都用加粗包住数字），
    // 完全一致 ⇒ 是个能指得出是哪一句的锚点，不是 `48` 那种散落 7~9 次的噪声锚点。
    // 补它的直接理由是实测：把 `docs/zh-CN/DEPLOY.md` 那句 `**90 秒**` 改成 `**95 秒**`，
    // **docs-parity 251 格全绿** —— 这个数在五份文档里当时一点守卫都没有。
    // ⚠️ **它上一版挡不住那一种，现在挡得住了**：写死 `"**90"` 时，
    // `CONFIG_TTL_MS`/`KV_EDGE_CACHE_MS` 真改了值、五份 DEPLOY.md 一起没跟上 ⇒ 计数依然对等 ⇒ 依然绿。
    // 改成现算之后，常量一改 token 就变成了五份文档里查不到的串 ⇒ `total === 0` 当场红。
    {
      token: `**${(CONFIG_TTL_MS + KV_EDGE_CACHE_MS) / 1000}`,
      why: "配置保存后其他 isolate 的生效上界（CONFIG_TTL_MS + KV_EDGE_CACHE_MS），五份各只此一处",
    },
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
    // ⚠️⚠️ **算式那一条从真源常量现算，不写字面量**（P3e 全分支评审 HIGH-2 回填）：
    // 写死 `"24 × 3"` 的话，`MANUAL_TENDS_PER_DAY` 一改，五份文档里那句算式原地变成
    // 假话而本表照绿。现算之后常量一改，token 就成了文档里查不到的串 ⇒ 下面那条
    // `total === 0` 当场红并点名 DEPLOY.md。理由与 `1 + ${…}` 那两条逐字相同。
    {
      token: `${MANUAL_TENDS_PER_DAY} × 3`,
      why: "「立即补池」可持续写侧的算式（每天 MANUAL_TENDS_PER_DAY 次 × 每次 3 次 put）",
    },
    { token: "392", why: "「立即补池」可持续写侧叠上稳态第三栏之后的合计（72 + 320）" },
    { token: "632", why: "「立即补池」每次都铸满 MINT_BATCH 时的突发上界合计（312 + 320）" },
    // ⚠️ **P3d Task 3 补的五个，同样是先数过再加**：改动前 `104` / `13 × 8` / `280` /
    // `424` / 最坏那一行的合计在五份文档里**各 0 次**（`grep -o -F` 逐份数过），
    // 加进来之后 `13 × 8` / `104` / `280` / `424` / 最坏那一行分别是 **1 / 4 / 1 / 1 / 1** 次，
    // 五份完全一致（定向复评 N8：上一版这里写的是「3 / 1 / 1 / 1 / 1」，
    // **前两个配反了，而且 `104` 后来又多了一处，早就不是 3**。
    // ⭐ 这类「注释里抄一份计数」天生会过期 —— **能变红的是下面那条跨语言互校，
    // 不是这段话**，读的人别把它当判据）。
    //
    // **五个一起加，因为它们是同一笔账里五段各自会被单独写歪的数**：
    // `13 × 8` 是算式本身、`104` 是 Tier-2 的写量增量，`280`/`424`/最坏那一行是四行场景表里
    // 新增的那三行合计（第一行 `176` 与 Tier-2 关掉时逐字相同，已被上面那个锚覆盖）。
    // 只锚 `104` 的话，某一种语言把最坏那一行抄错一位不会有任何东西变红——而那一行恰恰是
    // 「开了之后会不会打穿写配额」这个问题的答案，写歪一位就是相反的结论。
    //
    // ⚠️⚠️ **最坏那一行从真源常量现算，不写字面量**（P3e 全分支评审 HIGH-2）。
    // 它上一版写死的是 `856`（= 424 + 每 10 分钟点一次立即补池的 `144 × 3 = 432`），
    // 而 `MANUAL_TENDS_PER_DAY = 24` 那道闸把点击次数压到 24 次/天
    // ⇒ 真实的那一行是 `424 + 24 × 3 = 496`。**上一版的守卫在保证五份把同一个错数
    // 抄得一模一样**——这正是本表开头那段边界说明（「只能证明五份写得一样，不能证明
    // 五份说得对」）的一个活实例。现算之后常量一改，token 就成了文档里查不到的串
    // ⇒ 下面那条 `total === 0` 当场红并点名 DEPLOY.md。
    // ⚠️ `424` 仍是字面量：它是上一行的合计（320 + 104），与这道闸无关。
    //    每次点击**不铸新 key** 时的写侧固定是 3 次 put（`tend-guard.ts` 文件头那段算式），
    //    五份文档里那一行也是按这个口径写的。
    //
    // ⚠️ **不加 `13`**：它在五份里散落在「13 次 put」「12 + 1」等十几处，
    // 变红时指不出是哪一句坏了，而定位成本正是这道门禁存在的意义（同 `48` 那条不加的理由）。
    // `13 × 8` 只出现在那一句算式里，是那一段唯一的锚。
    { token: "13 × 8", why: "Tier-2 每天写量的算式（每实例 13 次 put × 8 个并发 isolate）" },
    { token: "104", why: "Tier-2 打开之后每天新增的 put 数，配额账里本期唯一的新写者" },
    { token: "280", why: "Tier-2 开、注册机关着时的写侧合计（176 + 104）" },
    { token: "424", why: "Tier-2 开、注册机开着且每轮有失败事件时的写侧合计（320 + 104）" },
    {
      token: String(424 + MANUAL_TENDS_PER_DAY * 3),
      why: "四行场景表里最坏那一行的合计（424 + MANUAL_TENDS_PER_DAY × 3）—— 「开了也不打穿」这条结论就靠它",
    },
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
    // ⚠️ **P3e Task 31 补的两个，同样是先数过再加**：改动前这两条路径在五份 DEPLOY.md 里
    // **各 0 次**（`grep -o -F | wc -l` 逐份数过），加进来之后**各 1 次**，五份完全一致。
    // 它们守的是本任务往配额账里新写的那两笔（全局约束 14：新增一条会写存储的代码路径，
    // 同一个提交里必须更新五语言 DEPLOY.md 的配额账）。
    //
    // ⚠️⚠️ **两个 token 都从真源常量现算，不写字面量**——理由与上面 `1 + ${…}` 那两条
    // 逐字相同（Task 28 复评 H2 那次教训）：写死字符串的话，端点路径一改，五份文档里
    // 那两行原地变成假话而本组照绿。现算之后，路径一改 token 就成了文档里查不到的串
    // ⇒ 下面那条 `total === 0` 当场红，报文点名 DEPLOY.md。
    //
    // **为什么选路径而不选那两个数**（`1 次 put` / `N 次 delete`）：本表要的是「跨五种语言
    // 稳定、且只出现在目标那一句里」的锚。路径两条都满足（不会被翻译、全仓只有那一句提到）；
    // 而裸 `1` 与裸 `N` 在五份里各出现几十次，变红时指不出是哪一句坏了（同 `48` 那条不加的理由）。
    { token: CONFIG_RESET_PATH, why: "危险区「重置配置」那条端点的路径（1 次 put），五份 DEPLOY.md 各只此一处" },
    { token: KEYS_PURGE_PATH, why: "危险区「清空 Key 池」那条端点的路径（N 次 delete + 1 次 put），五份 DEPLOY.md 各只此一处" },
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

  /**
   * ⚠️ **同一条理由的第二格**（P3e Task 31）：`src/http/admin/handlers/config.ts`、
   * `keys-write.ts` 与 `router.ts` 三处注释都声称「路径改了而五份文档没跟着改，
   * 那一格当场红」，而上面那圈 `it()` 的标题是模板串生成的，名字锚指不住。
   *
   * 这一格同时比上面那圈**多守一件事**：上面只验「五份彼此相等」，这里验的是
   * **各恰好 1 次**——五份一起写成 2 次（比如某次复制粘贴把那一行重复了）在上面那圈
   * 是合法的，而 `why` 里逐字写着「各只此一处」。删掉表上那一行 ⇒ 这一格红；
   * 删掉这一格 ⇒ 三处注释的名字锚落空 ⇒ `check-comment-refs` 红。两条路都不静默。
   */
  it("危险区那两条端点的路径在五份 DEPLOY.md 的配额账里逐份写着 —— 路径从真源常量现算", () => {
    const tokens = NUMBERS.map((n) => n.token);
    for (const path of [CONFIG_RESET_PATH, KEYS_PURGE_PATH]) {
      expect(tokens, `${path} 那一行不在 NUMBERS 表上了——`
        + "三处源码注释正声称这条路径由那一格钉着，要么把行加回来，要么改那三段注释")
        .toContain(path);
      const counts = Object.fromEntries(
        LANGS.map((l) => [l, realDoc("DEPLOY")(l).split(path).length - 1]),
      );
      expect(counts, `${path} 在五份 DEPLOY.md 的配额账里不是各出现 1 次（${JSON.stringify(counts)}）`
        + "——要么某一份漏写了这笔配额账（全局约束 14：新增一条会写存储的代码路径，"
        + "同一个提交里必须更新五语言 DEPLOY.md），要么端点路径改了而文档没跟上")
        .toEqual(Object.fromEntries(LANGS.map((l) => [l, 1])));
    }
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
 * `### <heading>` 到下一个 `##`/`###` 之间的正文。**找不到那个小节返回 `null`——认不出要吵，
 * 不许装没看见**：小节标题写错时若当成「这一份没有这句话」，报文会把人指向
 * 「去补一句限定」，而真正坏掉的是表里那个标题。
 *
 * ⚠️ **W104（P3f 阶段 7B）把层级降了一级**：五份 `API.md` 的端点从 `##` 变成协议族
 * `##` 之下的 `###`（模板实测：kiro / gemini 两仓的端点全是 `### METHOD /path`），
 * 于是 `UPSTREAM_FACTS[].docSections` 里那三条也跟着从 `` `POST /v1/videos` `` 变成
 * `POST /v1/videos`（去掉反引号，与模板一致）。**这两处必须同批改**：只改文档不改这里，
 * 上面那两组会整片报「找不到小节」——而那正是本函数「认不出要吵」想避免的误导报文。
 * 终点用正则找**下一个 `##` 或 `###`**：只找 `\n## ` 会把同一个协议族下面的兄弟端点
 * 一起吞进来，于是「限定句贴在哪一节」这件事又变回了「整族里有没有这句话」。
 */
function sectionBody(src: string, heading: string): string | null {
  for (const level of ["## ", "### "] as const) {
    const at = src.indexOf(`\n${level}${heading}\n`);
    if (at === -1) continue;
    const from = at + 1;
    const rest = src.slice(from + 1);
    // 终点跟着起点的层级走：`##` 的射程**含**它下面那些 `###`（④B 那组要的就是整节），
    // `###` 的射程**到下一个同级或上级标题为止**（不然同一个协议族里的兄弟端点会被
    // 一起吞进来，「限定句贴在哪一节」就退回成「整族里有没有这句话」）。
    const m = (level === "## " ? /\n## / : /\n#{2,3} /).exec(rest);
    return m === null ? src.slice(from) : src.slice(from, from + 1 + m.index);
  }
  return null;
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
 * 语言轴与文档基名全集（R1）、heading 层级序列（R2）、代码围栏语言标记序列（R3）、
 * 归一化后的链接目标多重集（R4）、以 `|` 开头的表格行数（R5）、
 * 标识符型行内 code span 多重集（R6）。加一份新文档、加一段新小节、多一行表格、
 * 某一份多写一个环境变量名——**没有人需要回来表态**，它自己就红。
 *
 * ⚠️⚠️ **补漏评审（2026-08-29）在这一组上抓到三处「它自己就红」不成立的**，都已修掉，
 * 各自的证据与测法写在落点上，这里只留索引：
 * · **H2**：R1 的「从磁盘派生」原来只派生自 `docs/zh-CN` 一个目录 ⇒ 一份只在 `en` 下的
 *   孤儿文档实测 285 格全绿。今天逐个语言目录各比一次（见 `DOCS` 上方那段）。
 * · **H3**：**语言轴本身**原来是一张手写表 ⇒ 新建 `docs/fr/` 实测 285 格全绿。今天由
 *   `langAxisFailure()` 把 `LANGS` 钉在磁盘上（见 `NON_LANG_DOC_DIRS` 上方那段）。
 * · **H4**：R2–R6 一格都没继承数字锚点那组的「平凡相等」护栏 ⇒ `R3 × REGISTRAR`
 *   与 `R3 × ADMIN` 落地当天起就是**结构上不可能变红**的空判据。今天由
 *   `emptinessFailure()` + `EMPTY_BY_DESIGN` 名册两个方向都钉住。
 * 另有三处判据本身的射程漏洞（缩进围栏 / 围栏内的 `#` / 跨行 code span），
 * 分别记在 `FENCE_LINE`、`outsideFences()`、`codeSpans()` 三处的注释里。
 *
 * ⚠️ **与上面那组数字锚点是互补不是重复，那些锚点一个都不许删**：数字锚点管
 * 「同一个数字五份写得一样」，结构判据管「结构对得上」。某一份把 `496` 抄成
 * `469`，五份的结构指纹**逐字节相同**，R1–R6 全绿。反过来，某一份多一段没翻译
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
 * ⭐ 勘察当日曾把「放宽之后多出多少项差异」的计数（`en 38 / ja 24 / ko 29`）写进本段
 * 当理由，落地复核时写下的是「**三个数一个都没对上**，注释里抄计数天生会过期」。
 * **补漏评审实测推翻了这句话，此处按实测改真**：那三个数是**「只看 DEPLOY.md 一份、
 * 按多重集数差异项数」**这一把尺子量出来的，在勘察当日那棵树上**逐个精确命中**；
 * 落地复核换成了另外两把尺子（「五份逐份 distinct 求和」43/28/37、「DEPLOY.md 一份
 * distinct 键数」32/21/25），于是看着「一个都没对上」——**是换了尺子，不是数漂了**。
 * **结论不变、理由换掉**：这里仍然不留计数，理由不是「它会过期」，而是
 * **① 一个不写明口径的计数换把尺子就对不上；② 没有任何东西钉住它**——改了文档没人
 * 会回来更新注释。**能变红的是下面那条用例，不是这段话**，要数字就当场自己数一遍。
 *
 * ⚠️ **不许把它挪成一个独立的门禁脚本 + 新增一道 CI 步骤**：那会让
 * `tests/unit/scripts-guard.test.ts「CI 恰好十三道门，编号 1/13 到 13/13 各出现一次」` 当场红，
 * 代价要么是改那条手写字面量（削弱一道现存守卫），要么是把新门禁塞进已有步骤里
 * 假装不是新的。放进 CI 跑 `pnpm test` 那一步的 vitest 里零副作用。
 *
 * ── 它做不到什么（明写，别读成「五语言对等由测试保证」）──────────────────────
 * 它只证明**五份的结构骨架一样**，不证明任何一份说得对：五份同时漏掉一个小节、
 * 五份把同一个链接一起指错、某一份把整段话翻译反了但一个 `#` 都没动——它全都
 * 看不见。R6 更是只看标识符：句子里的名词、语气、乃至结论正反，它一概不管。
 * 译文是否准确、语义是否同义，仍然只能靠评审。
 */

/**
 * 围栏行（**含缩进围栏**：列表项里的代码块一律缩进两格写）。
 *
 * ⚠️ 补漏评审 M1：第一版三条判据全用 `^```` 顶格锚，于是**列表项里的代码块整个在射程外**。
 * 实测五份 `DEPLOY.md` 各 28 条围栏行里 **14 条是缩进的**（恰好一半），R3 只看得见另一半，
 * 而报告却把「换了围栏语言标记就变红」写成了全称句。本仓不用 `~~~` 围栏（下面
 * 「剥掉围栏之后反引号都成对」那一格顺带钉着这件事：真出现 `~~~` 时配对会当场乱）。
 */
const FENCE_LINE = /^[ \t]*```/;

/**
 * 把围栏**块内**的行连同围栏行本身一起换成空行（行数不变，只是内容清空）。
 *
 * ⚠️ 补漏评审 M2：`headings()` 第一版不分围栏内外，于是 ```bash 块里的 `# 注释` 被当成
 * 一级标题。实测今天五份 `DEPLOY.md` 各有 **3 个**这样的假标题（剥围栏前 22 项、剥后 19 项，
 * 五份一致），而且报文会亲手把人引进坑：往 ja 的第一个 ```bash 块里加一行 `# …` 注释，
 * 旧 `headings` 从 22 项变 23 项 ⇒ 报文说「ja 多出一个一级标题」并给出一个下标，
 * **可 ja 的标题里根本没有那一条**，照着报文去找会在标题里翻半天。
 * ⚠️ 那个下标随注释加在哪个围栏里而变（实测加在第一个 ```bash 块里是 11），
 * **所以这里不写死它**——要复现就自己插一行再跑。
 * **报文是唯一会被看见的护栏**，指错地方比不报还贵。
 */
function outsideFences(s: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of s.split("\n")) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out.join("\n");
}

/** R2：heading 层级序列（只取 # 的个数，不取标题文本——文本本来就该被翻译）。围栏内不算。 */
const headings = (s: string) =>
  outsideFences(s).split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => (l.match(/^#+/)?.[0] ?? "").length);

/** R3：代码围栏的语言标记序列（顶格与缩进围栏一视同仁）。 */
const fences = (s: string) => [...s.matchAll(/^[ \t]*```(\w*)/gm)].map((m) => m[1] ?? "");

/** R4：归一化后的链接目标多重集（`../<lang>/` → `../LANG/`，锚点归一为 `#`）。 */
const links = (s: string) =>
  [...s.matchAll(/\]\(([^)]+)\)/g)]
    .map((m) => (m[1] ?? "").replace(/\.\.\/(zh-CN|zh-TW|en|ja|ko)\//g, "../LANG/").replace(/#.*$/, "#"))
    .sort();

/** R5：以 `|` 开头的表格行数。 */
const tableRows = (s: string) => s.split("\n").filter((l) => l.trimStart().startsWith("|")).length;

/**
 * 行内 code span 的全量多重集——只给下面那条「放宽会变噪声」的用例用，不是判据。
 *
 * ⚠️ 补漏评审 M3：第一版是 `` /`([^`\n]+)`/g `` ——**按行截断**。CommonMark 的 code span
 * 本来就可以跨行（换行归一成一个空格），一处跨行会让**那一行之后的反引号整体错位配对**。
 * 实测 `docs/zh-CN/DEPLOY.md` 里 `` `npx wrangler kv namespace\ncreate POOL` `` 这一处：
 * 旧判据在那里凭空造出两个幽灵 span（`" 后把返回的 "` / `" 填进 "`），同时**吞掉**
 * `id` 与 `[[kv_namespaces]]`；en / ja 同一段没换行、照常抽到。跨行处数**逐语言不同**
 *（DEPLOY：zh-CN 2 / zh-TW 2 / ko 2、en 0 / ja 0），所以「今天没吞掉任何 `IDENTIFIER`、
 * R6 照样绿」是**运气不是判据**——纯重排版（一个字都不改）就能让 R6 变色。
 * 改法：先剥围栏（围栏内的反引号不是 span，且它们会把配对带歪），再允许跨行、
 * 把内部空白归一成一个空格。**这三件事各配了一条会自己红的用例**，见下面
 * 「code span：跨行的一处不再制造幽灵 span」与「…今天仍然承重…」那一组。
 */
const codeSpans = (s: string) =>
  [...outsideFences(s).matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").replace(/\s+/g, " ").trim()).sort();

/** R6 的三类标识符：全大写常量 / 斜杠开头的路径 / `agnes-` 开头的模型名。 */
const IDENTIFIER = /^(?:[A-Z][A-Z0-9_]{2,}|\/[^\s`]*|agnes-[^\s`]*)$/;

/** R6：标识符型行内 code span 的多重集。 */
const idents = (s: string) => codeSpans(s).filter((c) => IDENTIFIER.test(c));

/**
 * 文档基名全集。**它不是手写清单，是从磁盘派生再钉住**：任何一种语言下加了新文档不进表
 * = 红，表里有某种语言磁盘上没有的 = 红。
 *
 * ⚠️ Task 9 落地时这张表是五项（不含 `ADMIN`），它当时留下的原话是「`ADMIN.md` 由后续
 * 任务创建，那时把 `"ADMIN"` 加进来，**R1 的第一条断言会强制那一步**（不加就红）」。
 * P3e Task 26 落地五份 `ADMIN.md` 时先复现了那条测法：**只把 `"ADMIN"` 加进本表、
 * 一份文件都不写** ⇒ R1 当场红并逐字点名，`DOCS` 表这一条不是靠人记得回来加。
 *
 * ⚠️⚠️ **补漏评审 H2：上面这句「从磁盘派生」曾经只对 `zh-CN` 一个目录成立。**
 * `inventoryFailure()` 第一版只 `readdirSync(docs/zh-CN)`，于是「加了新文档不进表 = 红」
 * 这句全称句对 `en` / `ja` / `ko` / `zh-TW` 四个目录**都是假的**——实测在 `en` 那个语言
 * 目录下新建一份 `ORPHAN.md`，整组 285 格**全绿**。那正是本组立项要消灭的形态（一份文档谁都
 * 没在守），只是换到了另外四个目录里。今天改成**逐个语言目录各比一次**，报文点名
 * 「哪一种语言多出/少掉哪一份」，测法见反向控制里那条「R1 多一份只在 en 有的」。
 */
const DOCS = ["ADMIN", "API", "DEPLOY", "README", "REGISTRAR", "SPONSORS", "USAGE"] as const;

/**
 * `docs/` 下**不按语言分**的目录。名册之外的子目录一律必须是 `LANGS` 里的一种。
 *
 * ⚠️⚠️ **补漏评审 H3：语言轴本身原来是一张不会自己红的手写表。** `LANGS` 五项手写，
 * 全仓没有任何一处拿 `readdirSync("docs")` 钉住它——实测在 `docs/` 下新建第六种语言的
 * 目录（`fr/`）并放一份 `DEPLOY.md` 进去，整组 285 格**全绿**，没有一格知道多了一种语言。本组的立项理由逐字是「一个不会自己红的
 * 清单不是守卫，是待办」，文档轴做到了、语言轴原样留着，这一轮补上。
 * ⚠️ **豁免名册会变成永久的洞**，所以下面那条 R1 语言轴的断言**两个方向都查**：多出一个
 * 没登记的子目录要红，`LANGS` 里的某个语言目录整个消失也要红。
 *
 * ⚠️ 这张名册今天是**空的**——`docs/` 下只剩五个语言目录，一个非语言目录都没有。
 * 空表是有意的登记（「这里现在什么都不豁免」），不是待填的坑：新增任何非语言子目录
 * 都必须先回来写进这张表，否则上面那条断言当场红。
 * ⚠️ 但**空表也意味着「遍历这张表」的变异会空转**——凡是 `for (const d of NON_LANG_DOC_DIRS)`
 * 的反向控制，循环体一次都不进，跑了也等于没跑。反向控制里那一格已经据此改写成
 * 「整个语言目录消失」，别再写回遍历空表的写法。
 */
const NON_LANG_DOC_DIRS = [] as const;

const RULES: ReadonlyArray<readonly [name: string, fingerprint: (s: string) => unknown]> = [
  ["R2 heading 层级序列", headings],
  ["R3 代码围栏语言标记序列", fences],
  ["R4 归一化后的链接目标多重集", links],
  // ⚠️ R5 只数**行数**，一个变量名都不认识。「表里点名了哪些变量」由
  // `tests/unit/env-example-parity.test.ts` 的「.env.example 与五语言文档对等」那一组管
  // ——两套判据都在看五份 DEPLOY.md，分工写在那一组的 `ENV_TABLE_DOCS` 上方。
  ["R5 以竖线开头的表格行数", tableRows],
  ["R6 标识符型 code span 多重集", idents],
];

const docPath = (root: string, lang: string, doc: string) => join(root, "docs", lang, `${doc}.md`);

/**
 * R1 的语言轴：`docs/` 下的子目录集合恰好等于 `LANGS` + 非语言目录豁免名册。
 * **这是全仓唯一一处把 `LANGS` 钉在磁盘上的地方**（补漏评审 H3），返回失败报文或 `null`。
 */
function langAxisFailure(root: string): string | null {
  const dirs = readdirSync(join(root, "docs"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const want: string[] = [...LANGS, ...NON_LANG_DOC_DIRS].sort();
  if (JSON.stringify(dirs) === JSON.stringify(want)) return null;
  const extra = dirs.filter((d) => !want.includes(d));
  const missing = want.filter((d) => !dirs.includes(d));
  return "R1 语言轴 docs/ 下的子目录集合与「LANGS + 非语言目录豁免名册」对不上"
    + `——加一种语言（或改了目录名）要回来表态：多出 ${JSON.stringify(extra)}，少掉 ${JSON.stringify(missing)}`;
}

/**
 * R1。返回失败报文或 `null`。
 * **真扫描与反向控制共用这一份**——探针与被探的东西必须是同一段代码，否则探针绿了
 * 什么都不证明。
 *
 * 两条，顺序有意义：先钉语言轴（多一种语言目录 = 红），再**逐个语言目录**比文档集。
 * ⚠️ 语言轴不过就直接返回：目录都对不上了，再去逐份读文档只会 ENOENT，报文反而更差。
 */
function inventoryFailure(root: string, table: readonly string[]): string | null {
  const axis = langAxisFailure(root);
  if (axis !== null) return axis;

  const want = [...table].sort();
  // ⚠️ 逐个语言目录各比一次（补漏评审 H2：第一版只比 zh-CN 一个目录）。
  const rows = LANGS.map((lang) => {
    const dir = join(root, "docs", lang);
    const onDisk = existsSync(dir)
      ? readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, "")).sort()
      : [];
    return {
      lang,
      extra: onDisk.filter((d) => !want.includes(d)),
      missing: want.filter((d) => !onDisk.includes(d)),
    };
  }).filter((r) => r.extra.length > 0 || r.missing.length > 0);

  if (rows.length === 0) return null;
  return "R1 语言目录下的 .md 全集与 DOCS 表对不上——加了新文档要回来表态：\n"
    + rows.map((r) => `  ${r.lang}：多出 ${JSON.stringify(r.extra)}，少掉 ${JSON.stringify(r.missing)}`).join("\n");
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

/**
 * ── R2–R6 的「平凡相等」护栏（补漏评审 H4）─────────────────────────────────────
 *
 * 本文件上面那组**数字锚点先挡住「五份都是 0」这种平凡相等**（`total === 0` 那一段，
 * 注释还专门解释了为什么）。R2–R6 落地时一格都没继承这道护栏——`divergenceReport()`
 * 对「五份都是空数组」直接返回 `null`，于是**空 === 空 = 永远绿**。
 *
 * **真数据上已经踩上去了**：`R3 × REGISTRAR.md`（五份一条围栏都没有）与
 * `R3 × ADMIN.md`（Task 26 加进 `DOCS` 之后新增的一格，同样整份无围栏）——30 格里
 * **2 格结构上不可能变红**，而文件里原本一个字都没说这件事。诊断当时（**这道护栏还没加**）
 * 把 `fences` 改成恒返回 `[]`：真仓 6 格 R3 **全绿**，只有夹具那一条控制吵
 * ——**判据用错工具时静静放行**，正是本组自己在变异 M1 里登记过的那个形态，
 * 只是这一次真数据已经站在上面了。（护栏加上之后同一条变异实测红 **8** 格，
 * 其中 **4 格正是这道护栏**——`API` / `DEPLOY` / `README` / `USAGE` 的 R3 一起变成
 * "抽不到东西"；名册里那两格照旧不动，因为它们本来就登记着"无从取样"。）
 *
 * ⚠️ 名册**两个方向都查**，这是它与「待办清单」的区别：
 * · 不在名册里却五份全空 ⇒ 红（这一格是空判据，要么改判据要么登记进来）；
 * · 在名册里却抽到了东西 ⇒ 红（名册过期了，删掉登记——**豁免名册会变成永久的洞**）。
 */
const EMPTY_BY_DESIGN: ReadonlyArray<readonly [rule: string, doc: string]> = [
  // 这三份文档整份没有代码围栏（不是"缩进围栏认不出"——`fences` 今天顶格与缩进一视同仁）。
  ["R3 代码围栏语言标记序列", "ADMIN"],
  ["R3 代码围栏语言标记序列", "REGISTRAR"],
  ["R3 代码围栏语言标记序列", "SPONSORS"],
  // ⚠️ `SPONSORS.md` 一份文档独占三格，理由是它的**体裁**：它是一页号召 Star / 提 Issue /
  // 提 PR 的散文 + 一段四步 git 命令，**结构上就不该有表格，也不该出现网关的标识符**
  // （模板实例 `K/docs/{lang}/SPONSORS.md` 五份同样一张表、一个 `IDENTIFIER` 都没有）。
  // 这三格因此不是"欠着还没写"，是"这条判据在这份文档上无从取样"：
  // · R5 五份都是 0 —— 全篇没有一行以 `|` 开头；
  // · R6 五份都是空数组 —— 全篇只有两处行内 code（`git checkout …` / `git commit …`），
  //   两处都不满足 `IDENTIFIER`（不是全大写常量、不以 `/` 开头、也不是 `agnes-` 前缀）。
  // **两个方向都活着**：哪天这份文档补进一张表或写进一个 `GATEWAY_TOKEN` 这样的标识符，
  // 名册这一条会因为"登记了却抽到东西"当场红，逼人回来删登记。
  ["R5 以竖线开头的表格行数", "SPONSORS"],
  ["R6 标识符型 code span 多重集", "SPONSORS"],
];

/** 指纹「空」的判定：数组看长度，数字（R5）看是不是 0。 */
const isEmptyFingerprint = (v: unknown) => (Array.isArray(v) ? v.length === 0 : v === 0);

/**
 * 一格的平凡相等护栏。返回失败报文或 `null`。**真扫描与探针共用这一份**。
 */
function emptinessFailure(
  doc: string,
  name: string,
  samples: readonly unknown[],
  table: ReadonlyArray<readonly [rule: string, doc: string]>,
): string | null {
  const allEmpty = samples.every(isEmptyFingerprint);
  const exempt = table.some(([r, d]) => r === name && d === doc);
  if (allEmpty && !exempt) {
    return `${doc}.md 的「${name}」在五份里抽到的都是空的——空 === 空，这一格结构上永远不会红，`
      + "它是一条待办不是守卫。要么把判据改成认得出这份文档里的东西，"
      + "要么把它登记进 EMPTY_BY_DESIGN 并写明为什么不适用";
  }
  if (!allEmpty && exempt) {
    return `${doc}.md 的「${name}」登记在 EMPTY_BY_DESIGN 里（「这份文档上无从取样」），`
      + "可是今天抽到东西了——这条登记过期了，删掉它，这一格已经是一条真判据";
  }
  return null;
}

/**
 * ── R2–R6 的单格：五语言之间逐份相同（原形态，过渡分组已拆除）────────────────
 *
 * 这里曾经有一段**按内容现算的两组分组**（已换成模板 12 节形态的一组、还是旧 9 节
 * 骨架的一组，组内各自逐份相同），配一张 `README_MIGRATED` 进度登记表与三格判据。
 * 它存在的理由是：P3f 阶段 5B 把五份 `docs/{lang}/README.md` **分步**换成 12 节形态，
 * 换到一半时「五份结构相同」这个前提在事实上不成立，五格 R2–R6 会一起红，
 * 而那种红说的是「五语言之间分叉」，真因却是「有几份还没轮到」。
 *
 * ✅ **五份全换完了（阶段 5B-3 之三，`docs/zh-TW/README.md` 是最后一份）**，
 * 那张过渡表自己的「自毁开关」那一格因此当场到期 ⇒ 分组分支、`README_MIGRATED`、
 * `isMigratedReadme` / `migratedReadmeLangs` / `cohortsOf` 与那三格判据**一并删掉**，
 * R2–R6 退回下面这个「五语言之间逐份相同」的原形态。
 *
 * 🔴 **顺带如实结掉一笔过渡期的账**：`docs/ko/README.md` 搬完到 `docs/zh-TW/README.md`
 * 搬完之间，未换那组只剩 zh-TW 一份 ⇒ `if (cohort.length < 2) continue` 把它整组跳过，
 * **那一步 zh-TW 那份 README 的 R2–R6 五格一格都没在守**（当时靠的是评审）。
 * 那个缺口随这次删除**当场消失**：今天五份走的是同一条 `divergenceReport`，
 * 任意一份分叉都会红并点名是哪一份。
 */

/** R2–R6 的单格：一份文档 × 一条判据。返回失败报文或 `null`。真扫描与反向控制共用这一份。 */
function parityFailure(root: string, doc: string, name: string, fingerprint: (s: string) => unknown): string | null {
  const body = divergenceReport([...LANGS], LANGS.map((l) => fingerprint(readFileSync(docPath(root, l, doc), "utf8"))));
  if (body === null) return null;
  return `${doc}.md 的「${name}」在五语言之间分叉：\n${body}`;
}

/**
 * ── R6 扩展的过渡形态（P3f 阶段 5A）─────────────────────────────────────────
 *
 * 原形态是「根 README 与五语言 README **六份逐字全等**」。它成立的前提是这六份
 * 是同一份文档的六个语言版；P3f 阶段 5A 把**根** README 单独重写成模板的 16 节
 * 中文形态，而五语言那五份要到阶段 5B 才跟上 —— 这个前提在两个阶段之间
 * **暂时不成立**，六份全等今天不可能绿。
 *
 * 处置不是删掉这一格、也不是 `skip` 掉它（一条被绕过去的判据比没有更坏），
 * 而是换成一条**今天就能红、两个方向都能红**的形态：
 * · **根必须含全语言版的每一个标识符**（多重集包含）—— 少一个当场红，
 *   那说明重写时把某个端点 / 某个变量整片漏掉了；
 * · 多出来的那些**逐条登记**在 `ROOT_ONLY_IDENTS` 里，用 `toEqual` 比：
 *   ① 根上新写一个没登记的标识符 ⇒ 红（逼人回来看一眼是不是写错了）；
 *   ② 阶段 5B 把语言版扩容上来、某一条不再「只有根有」⇒ **也红**（逼人删登记）。
 *
 * ⚠️ **阶段 5B 完工那天这张表必须清空**，清空之后这一格自动退回「六份全等」
 * （`extra` 与 `missing` 都空 = 多重集相同）。它是一张**会自己过期的**登记表，
 * 不是一条豁免。
 *
 * ✅ **它已经过期并被清空了（P3f 阶段 5B-1，`docs/zh-CN/README.md` 扩成 12 节那一步）。**
 * 「多出来的」这一侧拿 zh-CN 那份当基准（见 `rootReadmeFailure`），而根专属那 4 节
 * （技术架构 / 项目结构 / Star History / 免责声明）里**一个 `IDENTIFIER` 型 code span
 * 都没有**——框图与目录树是裸围栏（围栏内的反引号本来就不算 span），
 * Star History 与免责声明是纯散文与图片。所以 zh-CN 一换成 12 节，
 * 根与它的标识符多重集当场逐条相等，26 条登记一条不剩。
 * 空表**不是摆设**：它就是「六份全等」的原形态，两个方向照旧会红
 * （根上新写一个没登记的标识符 ⇒ 多出来；zh-CN 里写一个根上没有的 ⇒ 少掉）。
 */
const ROOT_ONLY_IDENTS: Readonly<Record<string, number>> = {};

/** 多重集计数。 */
const tallyOf = (xs: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/**
 * R6 扩展：根 README 与五语言 README 六份。返回失败报文或 `null`。
 * `allowedExtra` 是「只有根有」的登记表；夹具那条路不传，于是夹具上仍然是严格全等。
 */
function rootReadmeFailure(root: string, allowedExtra: Readonly<Record<string, number>> = {}): string | null {
  const rootTally = tallyOf(idents(readFileSync(join(root, "README.md"), "utf8")));
  const out: string[] = [];
  for (const l of LANGS) {
    const langTally = tallyOf(idents(readFileSync(docPath(root, l, "README"), "utf8")));
    for (const [span, n] of langTally) {
      const got = rootTally.get(span) ?? 0;
      if (got < n) {
        out.push(`根 README.md 里 \`${span}\` 只有 ${got} 处，docs/${l}/README.md 有 ${n} 处`
          + " —— 根那份必须含全语言版的每一个标识符，少掉的多半是重写时整片漏了");
      }
    }
  }
  // 「多出来的」拿 zh-CN 那份当基准：R6 本体已经钉住五语言之间不分叉，随便取一份即可。
  const baseTally = tallyOf(idents(readFileSync(docPath(root, "zh-CN", "README"), "utf8")));
  const extra: Record<string, number> = {};
  for (const [span, n] of rootTally) {
    const d = n - (baseTally.get(span) ?? 0);
    if (d > 0) extra[span] = d;
  }
  const want = Object.entries(allowedExtra).sort(([a], [b]) => (a < b ? -1 : 1));
  const got = Object.entries(extra).sort(([a], [b]) => (a < b ? -1 : 1));
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    const fmt = (xs: ReadonlyArray<readonly [string, number]>) =>
      xs.length === 0 ? "（空）" : xs.map(([s, n]) => `${s} ×${n}`).join("，");
    out.push(`根 README.md 比语言版多出（未登记）：${fmt(got)}\n登记表 ROOT_ONLY_IDENTS 写的是：${fmt(want)}`
      + "\n—— 两个方向都要红：根上新写一个没登记的标识符要红，语言版跟上来之后登记没删掉也要红");
  }
  return out.length === 0 ? null : `R6 扩展 根 README 与五语言 README 的标识符 code span 分叉：\n${out.join("\n")}`;
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
  it("R1 语言轴：docs/ 的子目录集合恰好等于 LANGS 加上非语言目录豁免名册", () => {
    const failure = langAxisFailure(".");
    expect(failure, failure ?? "").toBeNull();
  });

  it("R1 五个语言目录下同名文件都存在，且 DOCS 表恰好等于每一个语言目录的 .md 全集", () => {
    const failure = inventoryFailure(".", DOCS);
    expect(failure, failure ?? "").toBeNull();
  });

  for (const doc of DOCS) {
    for (const [name, fingerprint] of RULES) {
      it(`${doc}.md 的「${name}」五份逐份相同`, () => {
        // 先过平凡相等那道护栏：五份都空的话下面那条 `toBeNull()` 永远绿，等于没这一格。
        const samples = LANGS.map((l) => fingerprint(readFileSync(docPath(".", l, doc), "utf8")));
        const empty = emptinessFailure(doc, name, samples, EMPTY_BY_DESIGN);
        expect(empty, empty ?? "").toBeNull();

        const failure = parityFailure(".", doc, name, fingerprint);
        expect(failure, failure ?? "").toBeNull();
      });
    }
  }

  it("EMPTY_BY_DESIGN 名册里的每一条都指向真实存在的「判据 × 文档」格", () => {
    const names = RULES.map(([n]) => n);
    const bad = EMPTY_BY_DESIGN.filter(
      ([r, d]) => !names.includes(r) || !(DOCS as readonly string[]).includes(d),
    );
    expect(bad, `名册里有拼错的格——拼错的登记永远不会命中任何一格，等于一条不生效的豁免：${JSON.stringify(bad)}`)
      .toEqual([]);
  });

  it("R6 扩展：根 README.md 含全五语言 README.md 的标识符，多出来的逐条登记在 ROOT_ONLY_IDENTS", () => {
    // 同一道平凡相等护栏：根 README 一个标识符都抽不到的话，这一格也是空判据。
    expect(idents(readFileSync("README.md", "utf8")).length, "根 README.md 里一个标识符 code span 都没抽到——这一格是平凡相等")
      .toBeGreaterThan(0);
    const failure = rootReadmeFailure(".", ROOT_ONLY_IDENTS);
    expect(failure, failure ?? "").toBeNull();
  });

  it("R6 扩展 该红时红：语言版跟上来之后没删登记 —— 登记表过期同样要红", () => {
    // 阶段 5B 的那个方向：把某一条搬进语言版（这里用注入式 reader 模拟），
    // 它就不再是「只有根有」，`ROOT_ONLY_IDENTS` 里那一行必须跟着删掉。
    const failure = rootReadmeFailure(".", { ...ROOT_ONLY_IDENTS, GATEWAY_TOKEN: 4 });
    expect(failure ?? "", "把登记表里 GATEWAY_TOKEN 的条数改小了，这一格却没红")
      .toContain("GATEWAY_TOKEN");
  });

  /* ── 阶段 5B 的进度登记（README 的对等分组）：**已随五份搬完一并删除** ────────
   *
   * 这里曾经有三格：进度登记与磁盘现算 `toEqual`、五份全搬完时的自毁开关、
   * 一份标题被改坏就不再算「已搬完」。三格连同 `README_MIGRATED` / `cohortsOf`
   * 都是**过渡期**的东西，自毁开关那一格在 `docs/zh-TW/README.md` 搬完当天到期，
   * 按它自己报文里写的处置一并删掉（见 `parityFailure` 上方那段）。
   *
   * ⚠️ **删掉它们不留缺口**：三格守的是「分组分了没分对」，而分组本身已经不存在了；
   * 「这一份 README 的 `## ` 序列必须逐字等于 W38 常量表那 12 行」这条**射程更大**的
   * 判据不由它们承担 —— 它是阶段 6 的 R11（语言版那一半）。今天守着五份 README 的是
   * R2–R6 的「五语言之间逐份相同」：五份一起被同一个错误改坏那一种它挡不住，
   * 那正是 R11 要补的那一格。**在 R11 落地前，这条边界是真实存在的，别读成已经守住了。**
   */

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

  /**
   * ── 判据自身的三格（补漏评审 M1 / M2 / M3 的正向测法）─────────────────────────
   * 三条抽取函数都被改过：`fences` 认缩进围栏、`headings` 剥围栏、`codeSpans` 允许跨行。
   * 每一条在这里各有一格**直接打函数**的用例（认得出 + 不乱红各一句），
   * 紧跟着三格「今天仍然承重」把"为什么要改"钉在真仓的现状上——哪天真仓里再也没有
   * 这种写法了，那三格会红，逼人回来重新评估，而不是让理由永远挂着。
   */
  it("R2 判据自身：围栏内的 `# ` 不算标题、围栏外的算，缩进围栏同样剥", () => {
    expect(headings("# 标题\n\n```bash\n# 这是注释\n```\n\n## 小节")).toEqual([1, 2]);
    // 缩进围栏也要开合状态机：里面那行顶格的 `#` 不许算成标题，后面的 `## ` 仍要算。
    expect(headings("- 列表：\n\n  ```bash\n# 缩进围栏里顶格写的注释\n  ```\n\n## 小节")).toEqual([2]);
  });

  it("R3 判据自身：顶格与缩进围栏都算，语言标记按出现顺序取", () => {
    expect(fences("```bash\nx\n```\n\n- 列表：\n\n  ```json\n  {}\n  ```\n")).toEqual(["bash", "", "json", ""]);
  });

  it("R6 判据自身：跨行的 code span 归一成一个空格，不再制造幽灵 span", () => {
    // 旧判据（按行截断）在这段文本上造出 `" 后把返回的 "` 这种幽灵项，同时吞掉 `id`。
    expect(codeSpans("跑 `npx wrangler kv\ncreate POOL` 后把返回的 `id` 填进 `[[kv]]`"))
      .toEqual(["[[kv]]", "id", "npx wrangler kv create POOL"]);
    // 不乱红：本来就写在一行里的，抽出来的东西一个字都不变。
    expect(codeSpans("`a` 与 `b`")).toEqual(["a", "b"]);
  });

  /** 三条「今天仍然承重」共用的窄口径——它们就是被替换掉的那一版判据，拿来对拍。 */
  const NARROW = {
    topLevelFences: (s: string) => [...s.matchAll(/^```(\w*)/gm)].length,
    rawHeadings: (s: string) => s.split("\n").filter((l) => /^#{1,6} /.test(l)).length,
    lineBoundSpans: (s: string) => [...s.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? ""),
  };
  const everyRealDoc = () => DOCS.flatMap((d) => LANGS.map((l) => readFileSync(docPath(".", l, d), "utf8")));
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

  it("M1 今天仍然承重：真文档里确实有缩进围栏，顶格锚会漏掉它们", () => {
    const missed = sum(everyRealDoc().map((s) => fences(s).length - NARROW.topLevelFences(s)));
    expect(missed, "真仓里已经没有缩进围栏了——`fences` 认缩进这件事不再承重，回来重新评估要不要保留").toBeGreaterThan(0);
  });

  it("M2 今天仍然承重：真文档的围栏里确实有 `# ` 开头的行，不剥围栏就会被当成一级标题", () => {
    const fake = sum(everyRealDoc().map((s) => NARROW.rawHeadings(s) - headings(s).length));
    expect(fake, "真仓的围栏里已经没有 `# ` 开头的行了——`headings` 剥围栏这件事不再承重，回来重新评估").toBeGreaterThan(0);
  });

  it("M3 今天仍然承重：真文档里确实有跨行的 code span", () => {
    const oddLines = (s: string) =>
      outsideFences(s).split("\n").filter((l) => ((l.match(/`/g) ?? []).length % 2) === 1).length;
    expect(sum(everyRealDoc().map(oddLines)), "真仓里已经没有跨行的 code span 了——`codeSpans` 允许跨行这件事不再承重，回来重新评估")
      .toBeGreaterThan(0);
  });

  it("M3 的落点：那处跨行 span 归一之后五份 DEPLOY.md 都抽得到，且它至少在一种语言里是跨行写的", () => {
    const SPAN = "npx wrangler kv namespace create POOL";
    const deploy = (l: Lang) => readFileSync(docPath(".", l, "DEPLOY"), "utf8");
    expect(
      LANGS.filter((l) => !codeSpans(deploy(l)).includes(SPAN)),
      `这些语言的 DEPLOY.md 里抽不到 \`${SPAN}\`——跨行归一坏了，或者那一段被改写了`,
    ).toEqual([]);
    expect(
      LANGS.filter((l) => !NARROW.lineBoundSpans(deploy(l)).includes(SPAN)).length,
      "这条串今天五份都写在一行里——按行截断的旧判据也抽得到它，这一格就证明不了跨行归一",
    ).toBeGreaterThan(0);
  });

  it("剥掉围栏之后每一份文档的反引号都成对——不成对时 code span 的配对会整篇错位", () => {
    const files = [join(".", "README.md"), ...DOCS.flatMap((d) => LANGS.map((l) => docPath(".", l, d)))];
    const odd = files.filter((p) => ((outsideFences(readFileSync(p, "utf8")).match(/`/g) ?? []).length % 2) === 1);
    expect(odd, `这些文件剥掉围栏后反引号是奇数个，`+
      `从那一处起整篇的 code span 配对都会错位（R6 会开始比对幻觉）：${JSON.stringify(odd)}`).toEqual([]);
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
      // ⚠️ 补漏评审 M3：这一行是**故意照着真 `docs/*/DEPLOY.md` 那处摆的**——一个多词
      // span 后面紧跟一个标识符 span。把前一个 span 换行重排（内容一个字不改）时，
      // 按行截断的旧判据会在这里造出一个幽灵 span 并**吞掉后面那个 `POOL_CACHE_TTL_MS`**，
      // 于是 R6 变色；下面「一处 code span 换行重排」那条不乱红就是打在这一行上的。
      `\`npx wrangler kv namespace create POOL\` → \`POOL_CACHE_TTL_MS\`。`,
      "",
      "```bash",
      "curl http://localhost:8080/v1/messages",
      "```",
      "",
      // ⚠️ 补漏评审 M1：夹具里**必须有一个缩进围栏**，否则「`fences` 认缩进围栏」那条
      // 放宽在这组反向控制里一格都测不到（真文档里一半的围栏是这种写法）。
      `- ${p.note}：`,
      "",
      "  ```json",
      '  { "id": "REPLACE_ME" }',
      "  ```",
      "",
      `[${p.link}](../${lang}/USAGE.md#${p.section})`,
      "",
    ].join("\n");
  }

  type Tree = Record<string, string>;

  function pristineTree(): Tree {
    const files: Tree = { "README.md": fixtureDoc("zh-CN", "README") };
    for (const doc of DOCS) for (const l of LANGS) files[`docs/${l}/${doc}.md`] = fixtureDoc(l, doc);
    // ⚠️ 补漏评审 H3：夹具树的 `docs/` 子目录集合必须与真仓同构，否则 R1 语言轴那条
    // （`docs/` 子目录集合恰好等于 LANGS + 豁免名册）在这棵树上恒红，整组反向控制全部失效。
    // 今天豁免名册是空的，所以这棵树也只放五个语言目录——**别为了"对称"补一个占位目录**，
    // 那会让语言轴在夹具上恒红。名册哪天不空了，这里要同步补上对应的占位文件。
    return files;
  }

  /**
   * 路径打错 = 变异没落地 = 这一格控制是空的。当场炸掉，不许静默通过。
   *
   * ⚠️ 补漏评审回填时收紧了第二个方向：**`replace` 打空拳（一个字都没改到）也炸**。
   * 「该红时红」那些格靠 `toHaveLength(1)` 兜得住空拳（0 告警会红），但下面那两条
   * **「不乱红」**期望的就是 0 告警——空拳在那里会被读成"判据很克制"，实际什么都没测。
   */
  function patch(files: Tree, rel: string, f: (body: string) => string): void {
    const body = files[rel];
    if (body === undefined) throw new Error(`夹具里没有 ${rel}——变异没落到任何文件上`);
    const next = f(body);
    if (next === body) throw new Error(`${rel} 上的变异一个字都没改到——这一格控制是空的`);
    files[rel] = next;
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
      hits: ["R1 语言目录下的 .md 全集与 DOCS 表对不上", 'ko：多出 []，少掉 ["USAGE"]'],
      mutate: (f) => drop(f, "docs/ko/USAGE.md"),
    },
    {
      why: "R1 多一份没进 DOCS 表的 docs/zh-CN/GLOSSARY.md",
      hits: ["R1 语言目录下的 .md 全集与 DOCS 表对不上", 'zh-CN：多出 ["GLOSSARY"]'],
      mutate: (f) => { f["docs/zh-CN/GLOSSARY.md"] = fixtureDoc("zh-CN", "GLOSSARY"); },
    },
    {
      // ⚠️ **补漏评审 H2 的那一格**：`inventoryFailure` 第一版只 `readdirSync(docs/zh-CN)`，
      // 于是这条变异在真仓上实测 285 格**全绿**——一份只在 en 目录下的孤儿文档谁都没在守。
      // 这一格就是那件事的测法：换回只扫 zh-CN 的写法，它会立刻变绿（= 控制失效）。
      why: "R1 多一份只在 en 有、没进 DOCS 表的 docs/en/ORPHAN.md",
      hits: ["R1 语言目录下的 .md 全集与 DOCS 表对不上", 'en：多出 ["ORPHAN"]'],
      mutate: (f) => { f["docs/en/ORPHAN.md"] = fixtureDoc("en", "ORPHAN"); },
    },
    {
      why: "R1 反方向：表里有磁盘上没有的（五份 USAGE.md 一起删）",
      hits: ["R1 语言目录下的 .md 全集与 DOCS 表对不上", "USAGE", "zh-CN：", "ko："],
      mutate: (f) => { for (const l of LANGS) drop(f, `docs/${l}/USAGE.md`); },
    },
    {
      // ⚠️ **补漏评审 H3 的那一格**：`LANGS` 五项手写、全仓没有一处拿磁盘钉住它，
      // 于是这条变异在真仓上实测 285 格**全绿**——第六种语言完全不可见。
      why: "R1 语言轴：多一个 docs/fr 语言目录",
      hits: ["R1 语言轴 docs/ 下的子目录集合与「LANGS + 非语言目录豁免名册」对不上", '多出 ["fr"]'],
      mutate: (f) => { f["docs/fr/DEPLOY.md"] = fixtureDoc("en", "DEPLOY"); },
    },
    {
      // 语言轴的另一个方向：**多出来要红，少掉也要红**。
      // ⚠️ 这一格原来探的是「豁免名册里的目录不在了」，写法是遍历 `NON_LANG_DOC_DIRS`
      //    把占位文件删掉。名册改空之后那种写法**会静默空转**——循环体一次都不进，
      //    这一格从此挡空气却照样显示绿。所以改成探同一条 `missing` 臂上仍然活着的对象：
      //    整个 `docs/ko` 语言目录消失。**别改回遍历名册的写法。**
      why: "R1 语言轴：整个 docs/ko 语言目录消失（missing 那条臂）",
      hits: ["R1 语言轴 docs/ 下的子目录集合与「LANGS + 非语言目录豁免名册」对不上", '少掉 ["ko"]'],
      mutate: (f) => { for (const doc of DOCS) drop(f, `docs/ko/${doc}.md`); },
    },
    {
      why: "R2 某一份多一个 ###",
      // ⚠️ `越界` 这一项是复评 F9 的落点：ja 比参照多一项，`firstDiff` 返回的下标恰好
      // 落在参照的末尾之后。修之前这里印的是字面的 `参照 undefined`。
      hits: ["API.md 的「R2", "ja", "越界，这一侧只有"],
      mutate: (f) => patch(f, "docs/ja/API.md", (b) => `${b}\n### 追加\n`),
    },
    {
      why: "R3 某一份把顶格的 bash 围栏写成 sh",
      hits: ["DEPLOY.md 的「R3", "en", "sh"],
      mutate: (f) => patch(f, "docs/en/DEPLOY.md", (b) => b.replace("\n```bash", "\n```sh")),
    },
    {
      // ⚠️ **补漏评审 M1 的那一格**：顶格锚（`/^```(\w*)/gm`）看不见缩进围栏，
      // 而真仓五份 DEPLOY.md 各 28 条围栏行里有 14 条是缩进的——报告里
      // 「换了围栏语言标记就变红」那句全称句对它们原本是假的。
      why: "R3 某一份把缩进的 json 围栏写成 jsonc",
      hits: ["DEPLOY.md 的「R3", "ja", "jsonc"],
      mutate: (f) => patch(f, "docs/ja/DEPLOY.md", (b) => b.replace("\n  ```json", "\n  ```jsonc")),
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
   * ── 补漏评审 M2 / M3 的两条「不乱红」──────────────────────────────────────────
   * 这两条期望的是 **0 告警**，所以 `patch` 里那条"变异必须真的改到东西"是它们的命门：
   * `replace` 打空拳的话这里会绿得很好看，实际什么都没测。
   */
  it("不乱红：围栏里多一行 `# ` 开头的注释——那不是标题，R2 不该红", () => {
    // M2 的原始证据：往真 `docs/ja/DEPLOY.md` 的 ```bash 块里加一行 `# …` ⇒ R2 当场红，
    // 报文说「ja 多出一个一级标题、下标 13」——而 ja 里根本没有那个标题。
    expect(
      scanFixture((f) => patch(f, "docs/ja/DEPLOY.md", (b) => b.replace("\ncurl ", "\n# ここでポートを確認\ncurl "))),
      "围栏里的 shell 注释被当成了一级标题——报文会把人指到标题里翻半天",
    ).toEqual([]);
  });

  it("不乱红：一处 code span 换行重排（内容一个字不改）——R6 不该红", () => {
    // M3 的原始证据：真 `docs/zh-CN/DEPLOY.md:553` 那处跨行 span 让按行截断的旧判据
    // 造出两个幽灵 span 并吞掉 `id` / `[[kv_namespaces]]`；纯重排版就能让 R6 变色。
    // 这条变异**能分辨新旧判据**：旧判据在这里会吞掉后面那个 `POOL_CACHE_TTL_MS`，
    // ko 那一份的 R6 多重集少一项 ⇒ 红；新判据把换行归一成一个空格 ⇒ 五份完全相同。
    expect(
      scanFixture((f) => patch(
        f,
        "docs/ko/DEPLOY.md",
        (b) => b.replace("`npx wrangler kv namespace create POOL`", "`npx wrangler kv namespace\ncreate POOL`"),
      )),
      "一处 code span 被换行重排就红了——R6 在比对的是排版而不是标识符",
    ).toEqual([]);
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

  /**
   * ── 平凡相等护栏的四格（补漏评审 H4）─────────────────────────────────────────
   * 这四格直接打 `emptinessFailure()`——**真扫描调的就是这一个函数**。两个方向各两格：
   * 「不在名册里却五份全空」「在名册里却抽到了东西」该红，另外两格不许乱红。
   */
  const A_RULE = RULES[0]![0];
  const A_DOC = DOCS[0];

  it("该红时红：一格五份全空、又不在 EMPTY_BY_DESIGN 名册里 ⇒ 说清楚它是待办不是守卫", () => {
    const m = emptinessFailure(A_DOC, A_RULE, [[], [], [], [], []], []) ?? "";
    expect(m, "五份全空却没红——这道护栏是空的").not.toBe("");
    expect(m, `报文没点名是哪一格：\n${m}`).toContain(A_DOC);
    expect(m, `报文没点名是哪一条判据：\n${m}`).toContain(A_RULE);
    expect(m, `报文没说清"它永远不会红"这件事：\n${m}`).toContain("永远不会红");
    // R5 走的是数字分支：0 同样算"空"，不许只认数组。
    expect(emptinessFailure(A_DOC, "R5 以竖线开头的表格行数", [0, 0, 0, 0, 0], []), "数字指纹的 0 没被当成空")
      .not.toBeNull();
  });

  it("该红时红：登记在 EMPTY_BY_DESIGN 里、今天却抽到了东西 ⇒ 名册过期要当场吵", () => {
    const m = emptinessFailure(A_DOC, A_RULE, [["x"], ["x"], ["x"], ["x"], ["x"]], [[A_RULE, A_DOC]]) ?? "";
    expect(m, "名册过期了却没红——豁免名册就是这样变成永久的洞的").not.toBe("");
    expect(m, `报文没说是名册过期：\n${m}`).toContain("过期");
  });

  it("不乱红：一格抽得到东西、又不在名册里 ⇒ 不红", () => {
    expect(emptinessFailure(A_DOC, A_RULE, [["x"], ["x"], ["x"], ["x"], ["x"]], [])).toBeNull();
    expect(emptinessFailure(A_DOC, "R5 以竖线开头的表格行数", [3, 3, 3, 3, 3], [])).toBeNull();
  });

  it("不乱红：一格五份全空、而且确实登记在名册里 ⇒ 不红", () => {
    expect(emptinessFailure(A_DOC, A_RULE, [[], [], [], [], []], [[A_RULE, A_DOC]])).toBeNull();
    // 名册是按「判据 × 文档」两维匹配的：只对上一维不算命中。
    expect(emptinessFailure(A_DOC, A_RULE, [[], [], [], [], []], [[A_RULE, "另一份文档"]]), "名册只对上判据名就放行了")
      .not.toBeNull();
    expect(emptinessFailure(A_DOC, A_RULE, [[], [], [], [], []], [["另一条判据", A_DOC]]), "名册只对上文档名就放行了")
      .not.toBeNull();
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
 * ⚠️ **反向控制也跟着改了口径**：原来那格要求**每一个词**都能在 `docs/` 下的**任意**
 * 一份文档里找到出处（当时 `docs/` 下还放着一批内部设计文档）。它有两个毛病：
 * ① 那批内部文档里的需求书**逐字抄着这张词表**，于是「这个词是真串」这件事可以被
 * 需求书自己满足，等于挡空气；
 * ② 更要命的是它**把表往窄里推**——「夠用」「no problem」在真文档里确实一次都没出现，
 * 照那条控制就只能把它们删掉，而「表太窄」正是这一轮出事的根因。改成
 * **按语言**：每种语言的词里至少有一个真的出现在**那种语言自己的**文档里
 *（`docs/<lang>/` 下、ADMIN.md 之外）。这条控制在「zh-TW 那一列
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
    // 的死串」。⚠️ **射程刻意只收 `docs/<lang>/` 下那种语言自己的文档**：作证的文档必须是
    // 一份真给读者看的译文，不许拿「某处逐字抄着这张词表」的文件来给自己签字。
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

  /**
   * 五份 ADMIN.md 之外的**同语言兄弟文档**。射程之外的链接（外网、锚点）不参与。
   *
   * ⚠️ **W132（P3f 阶段 7B）：这张表原来是一张与 `DOCS` 脱节的手写清单。**
   * 它当时是 5 项，而 `DOCS` 是 7 项 —— 少的两项是 `ADMIN`（本组的引用方自己，
   * 本来就不该在里面）与 **`SPONSORS`（纯粹漏了）**。漏掉的后果不是「少查一条」，
   * 而是**报文说的是另一件事**：ADMIN.md 里一条 `[SPONSORS.md](SPONSORS.md) 的「X」一节`
   * 会走到 `targets.length === 0` 那一支，被报成「同一段里没给出通往那份文档的链接」
   * ——链接明明就在那一行上，而真因是本表没认它。**报文可以亲手把人引进坑**，
   * 这是本仓登记过的老教训。
   *
   * ⇒ 下面那格 `SIBLING_DOCS 恰好等于 DOCS 去掉 ADMIN 自己` 是这条的**咬合断言**：
   * `DOCS` 那张表本身是从磁盘派生并双向钉住的（见它上方的注释），本表因此也跟着
   * 钉在磁盘上 —— 往 `docs/<lang>/` 里加一份新文档、进了 `DOCS` 而没进本表，当场红。
   */
  const SIBLING_DOCS = ["API.md", "DEPLOY.md", "README.md", "REGISTRAR.md", "SPONSORS.md", "USAGE.md"] as const;

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

  // ── ④' W132：`SIBLING_DOCS` ↔ `DOCS` 的双向咬合 ──────────────────────────
  //
  // **立项理由（P3f 阶段 7B，Q16 的风险兜底）**：W104 把五份 `API.md` 的骨架整个
  // 重构了一遍（15 个平铺 `##` → 13 节 + 端点降 `###`），而 `ADMIN.md` 正是通过
  // 上面那套 `SIBLING_DOCS` 引用兄弟文档的**小节名**。「名字改了 ⇒ 引用失效」这一半
  // 上面那格已经在守（`titleLines` 收窄之后连「散文里碰巧提过」都蒙混不过去），
  // **没人守的是另一半：`SIBLING_DOCS` 这张手写表自己会不会与文档全集脱节。**

  it("W132 咬合：`SIBLING_DOCS` 恰好等于 `DOCS` 去掉 ADMIN 自己 —— 手写表不许与文档全集脱节", () => {
    const want = DOCS.filter((d) => d !== "ADMIN").map((d) => `${d}.md`).sort();
    expect(
      [...SIBLING_DOCS].sort(),
      "`SIBLING_DOCS` 与 `DOCS` 对不上了。少一项的后果不是「少查一条」，而是那条引用会走到"
      + "「同一段里没给出通往那份文档的链接」那一支 —— 链接就在那一行上，红的却是另一件事。"
      + "多一项则是指向一份磁盘上没有的文档，`realSiblings` 会直接 ENOENT。",
    ).toEqual(want);
  });

  /**
   * W132 的变异夹具：往 `docs/zh-CN/ADMIN.md` 顶上插一条**指向 API.md 某一节**的引用，
   * 同时按需把 `API.md` 那边的那一节改名。
   *
   * ⚠️ **为什么要合成这条引用**：今天五份 ADMIN.md 引的三条小节名全都落在
   * `DEPLOY.md` / `REGISTRAR.md` 上，**一条都没落在 `API.md` 上** ⇒ 直接跑真扫描
   * 证明不了「API 骨架重构会不会被接住」。这条合成引用把那条路真的走一遍。
   *
   * ⚠️ 只往 zh-CN 那一份里插：其余四种语言的标记词各不相同，插了会让「五种语言条数
   * 一致」那格红成另一件事。本夹具只喂给 `xrefScan(...).failures`，不碰条数那两格。
   */
  const withApiXref = (renameApiSection: boolean): SiblingReader => (lang, doc) => {
    const src = realSiblings(lang, doc);
    if (lang !== "zh-CN") return src;
    if (doc === "ADMIN.md") {
      const out = src.replace(/^(# .+\n)/m, "$1\n- 网关暴露哪几个模型，见 [API.md](API.md) 的「模型」一节。\n");
      if (out === src) throw new Error("变异没落到 docs/zh-CN/ADMIN.md 上——这一格控制是空的");
      return out;
    }
    if (doc === "API.md" && renameApiSection) {
      const out = src.split("模型").join("モデル");
      if (out === src) throw new Error("docs/zh-CN/API.md 里没有「模型」这两个字——这一格控制是空的");
      return out;
    }
    return src;
  };

  it("W132 不许乱红：ADMIN.md 引 API.md 的一节，而那一节今天真的在 —— 一条都不许红", () => {
    probeXrefBase();
    const { failures } = xrefScan(withApiXref(false));
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("W132 该红时红：API.md 那边把被引的那一节改了名 —— 红并点名 API.md 与那个名字", () => {
    probeXrefBase();
    const { failures } = xrefScan(withApiXref(true));
    expect(failures, "API.md 的小节改名了却没红 —— 骨架重构会让这条引用静默失效")
      .toHaveLength(1);
    for (const h of ["zh-CN/ADMIN.md", "模型", "API.md"]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
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
    /** 危险区那张卡上真的有几颗按钮（P3e Task 31）。 */
    readonly danger: number;
    readonly cardNames: readonly string[];
    readonly modeKeys: readonly string[];
    readonly dangerIds: readonly string[];
  }

  /** 屏幕那边的几份源码。**真扫描与探针共用这一份取文口径。** */
  interface PanelSource {
    readonly html: string;
    readonly events: string;
    readonly dict: string;
    readonly settings: string;
    readonly playground: string;
    /** 危险区那几颗按钮的真源（P3e Task 31）。**它在 pure 层，不在板块文件里。** */
    readonly pureSettings: string;
  }

  const readPanelSource = (): PanelSource => ({
    html: readFileSync(join(".", "admin-ui", "index.html"), "utf8"),
    events: readFileSync(join(".", "admin-ui", "js", "sec-events.js"), "utf8"),
    dict: readFileSync(join(".", "admin-ui", "js", "i18n-dict.js"), "utf8"),
    settings: readFileSync(join(".", "admin-ui", "js", "sec-settings.js"), "utf8"),
    playground: readFileSync(join(".", "admin-ui", "js", "sec-playground.js"), "utf8"),
    pureSettings: readFileSync(join(".", "admin-ui", "js", "pure", "settings.mjs"), "utf8"),
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
   * 而此刻五份 ADMIN.md 仍写着当时那句「设置页今天有四张卡」、危险区那一节仍写着当时那句
 * 「这张卡今天还不存在」。**两句话今天都已经不在文档里了**（Task 31 落地时一起改掉），
 * 这段留的是那次逃逸的形状，不是现状。
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
        + "于是设置卡那条计数会静静地少一张，而五份 ADMIN.md 的设置卡表全靠它",
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

    // ── 危险区那几颗按钮（P3e Task 31）。**同一条完备性锚，第三次。** ──────────
    const pure = codeOnly(src.pureSettings);
    const dangerBlock = /(?<![.\w$])export\s+const\s+DANGER_ACTIONS\s*=\s*\[([\s\S]*?)\n\];/.exec(pure);
    const dangerIds = dangerIdsOf(src);
    if (dangerBlock === null || dangerBlock[1] === undefined) {
      out.push(
        "pure/settings.mjs 里找不到 `export const DANGER_ACTIONS = [ … ];` 那张表"
        + "——它改名或改形态了，下面那条「条目数 === 认出来的 id 数」的锚会跟着失灵",
      );
    } else {
      const entries = (dangerBlock[1].match(/(?<![.\w$])id\s*:/g) ?? []).length;
      if (entries !== dangerIds.length) {
        out.push(
          `pure/settings.mjs 的 DANGER_ACTIONS 表里有 ${entries} 条，而取 id 正则只认出 `
          + `${dangerIds.length} 个（${dangerIds.join("、")}）——多半是某一条改了字段顺序 / 少写了 titleKey，`
          + "于是危险区那条计数会静静地少一颗按钮，而五份 ADMIN.md 的危险区表全靠它",
        );
      }
    }
    return out;
  }

  /**
   * 危险区那几颗按钮的 id。**判据要求 `id` 与 `titleKey` 成对出现**：
   * 只认 `id:` 的话，一条少写了 `titleKey` 的记录照样被数进去，而它在屏幕上是一颗
   * 画不出标题的按钮。取名正则与上面两条同形（单行/多行都吃，字段之间允许换行）。
   */
  function dangerIdsOf(src: PanelSource): string[] {
    return [...codeOnly(src.pureSettings).matchAll(
      /\bid:\s*"([A-Za-z]+)",\s*titleKey:\s*"set\.danger\.[A-Za-z.]+",/g,
    )].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
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
    const dangerIds = dangerIdsOf(src);
    return {
      nav: (src.html.match(/class="nav-item"/g) ?? []).length,
      warn: (src.events.match(/warnBanner\.appendChild\(/g) ?? []).length,
      warnKeys: new Set([...src.dict.matchAll(/"ev\.warn[A-Za-z]+"/g)].map((m) => m[0])).size,
      cards: cardNames.length,
      modes: modeKeys.length,
      danger: dangerIds.length,
      cardNames,
      modeKeys,
      dangerIds,
    };
  }

  const realPanel = (): PanelCounts => panelCounts(readPanelSource());

  /**
   * 文档里那几张表**按出现顺序**该有多少数据行，期望值逐项从屏幕派生。
   * 顺序就是它们在 ADMIN.md 里出现的顺序：§3 板块速查、§7 警告条、§10 调试台模式、
   * §11 设置卡、§12 危险区（最后一张是 P3e Task 31 补的）。
   */
  function expectedTables(c: PanelCounts): ReadonlyArray<readonly [why: string, rows: number]> {
    return [
      ["板块速查", c.nav], ["警告条", c.warn], ["调试台模式", c.modes],
      ["设置卡", c.cards], ["危险区", c.danger],
    ];
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
    expect(c.danger, "pure/settings.mjs 里一颗 DANGER_ACTIONS 都没数到——这一组测的是空气").toBeGreaterThan(0);
    expect(c.warnKeys, `字典里的 ev.warn* 键数（${c.warnKeys}）与横幅里挂上去的 <p> 条数（${c.warn}）对不上`
      + "——两条独立派生互相不认了，先回屏幕上核对到底有几条黄条，再改这里").toBe(c.warn);
  });

  /**
   * **危险区那条计数的第二条独立派生**：正则扫源码 vs 直接 `import` 进来的那张表。
   *
   * 两条路一起走的理由与 `warnKeys` 那一格逐字相同：正则哪天认不出（改了字段顺序、
   * 写成了别的形态）会静静地少数一颗，而五份 ADMIN.md 的危险区表全靠它。
   * ⚠️ **这一格只跑真源**，不跑探针的 mutated 源——探针要的就是「让扫描结果与真表不同」。
   */
  it("两条独立派生互相认账：危险区那张表的扫描结果与 import 进来的 DANGER_ACTIONS 逐条相等", () => {
    expect(realPanel().dangerIds,
      "正则扫出来的危险区按钮与 pure/settings.mjs 里那张表对不上"
      + "——要么表改了形态、正则认不出，要么有人在别处又写了一份")
      .toEqual(DANGER_ACTIONS.map((a) => a.id));
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

  it("五份 ADMIN.md 里五张表的行数，逐张等于屏幕那边对应的那个计数", () => {
    const failures = tableSeqFailures(expectedTables(realPanel()), realAdminDoc);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /** 与前几组同一条闸：真文档本身不过判据时，别让人从探针的报文里找原因。 */
  function probeTableBase(): void {
    const base = tableSeqFailures(expectedTables(realPanel()), realAdminDoc);
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「五份 ADMIN.md 里五张表的行数，逐张等于屏幕那边对应的那个计数」那一格：\n"
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

  // ── ⑤A 危险区那张表的**行序**（P3e Task 31 复评回填 F5）──────────────────────
  //
  // ⚠️⚠️ **上面那一组只数行数，数不出「顺序」——这一条是实测逼出来的，不是设计时想到的。**
  // 复评把 `DANGER_ACTIONS` 的两条记录**整体对调**（条数不变、id 集合不变，屏幕上的行序
  // 从此与五份 ADMIN.md 的行序相反）：`docs-parity` + `i18n-dict` + `settings.test.ts`
  // **一格都没红**，唯一变红的是
  // `tests/ui/dom/settings-save.test.ts「危险区那张卡真的建出来了，两颗按钮各在自己那一行上」`
  // 里那句手抄的
  // `["resetConfig","purgeKeys"]`，而它的报文说的是「危险区的按钮与 `DANGER_ACTIONS` 对不上」
  // —— 那一刻 DOM 与那张表**完全一致**，对不上的是那句字面量和五份文档的行序，
  // 照着报文去查会查错地方（阶段 D「报文可以亲手把人引进坑」同形）。
  // ⇒ 那句字面量已经改成从 `DANGER_ACTIONS` 现算（它守的是「板块文件按那张表派生」），
  //   「五份文档的行序」这一半落在这里。
  //
  // **判据：那张表第一列（按钮名）逐行等于 `DANGER_ACTIONS[k].titleKey` 在这种语言下的译文。**
  // 期望值从字典现算，所以它同时守住三件事：表里两行顺序反了、`DANGER_ACTIONS` 顺序反了、
  // 以及某一份翻译时把按钮名改写成了屏幕上没有的说法（那会让人在界面里找不到那颗按钮）。
  // ⚠️ **代价如实写**：这条判据要求那一列**逐字**是按钮标签，不许意译。
  // 落地时 ja 那份原本写的是名词形（「設定のリセット」/「Key プールの全削除」），
  // 已经改成按钮上的原话（「設定をリセット」/「Key プールを空にする」）——
  // 那一列的表头逐字就是「ボタン」，写按钮的原话本来就更准。

  /**
   * 危险区那张表在 ADMIN.md 里排第几张。**认不出要吵**：`expectedTables()` 里没有这一项时
   * 直接抛，而不是让下面整组静静退化成「跳过」——跳过的守卫与不存在的守卫是同一样东西。
   */
  function dangerTableIndex(): number {
    const i = expectedTables(realPanel()).findIndex(([why]) => why === "危险区");
    if (i < 0) throw new Error("expectedTables() 里没有「危险区」那一项——本组已经无事可做，先回去核对那张期望表");
    return i;
  }

  /**
   * 每一张 markdown 表的**数据行**，逐行切成单元格。
   * **与 `tableSizes()` 是同一条切表口径**，两者对不上时下面那条扫描会当场报「判据本身坏了」
   * ——不许出现「一条口径数出 5 张表、另一条数出 4 张」而没人知道的那一档。
   */
  function tableCells(src: string): string[][][] {
    const out: string[][][] = [];
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 0) {
        out.push(run.slice(2).map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "")
          .split("|").map((c) => c.trim())));
        run = [];
      }
    };
    for (const line of `${src}\n`.split("\n")) {
      if (/^\s*\|/.test(line)) { run.push(line); continue; }
      flush();
    }
    flush();
    return out;
  }

  const DICT = I18N as unknown as Record<string, Record<string, string>>;

  /** 一次扫描 × 五份 ADMIN.md。返回失败报文数组。真扫描与探针**共用这一份**。 */
  function dangerRowFailures(read: ApiDocReader, order: ReadonlyArray<{ id: string; titleKey: string }>): string[] {
    const idx = dangerTableIndex();
    const out: string[] = [];
    for (const lang of LANGS) {
      const src = read(lang);
      const tables = tableCells(src);
      if (JSON.stringify(tables.map((t) => t.length)) !== JSON.stringify(tableSizes(src))) {
        out.push(`${lang}/ADMIN.md：切表的两条口径（行数 / 单元格）数出来的表不一样——判据本身坏了`);
        continue;
      }
      const table = tables[idx];
      if (table === undefined) {
        out.push(`${lang}/ADMIN.md 里数不出第 ${idx + 1} 张表（危险区）——上面那条行数判据该先红`);
        continue;
      }
      const want: string[] = [];
      let broken = false;
      for (const a of order) {
        const label = DICT[a.titleKey]?.[lang];
        if (typeof label !== "string" || label.trim() === "") {
          out.push(`${a.id} 的 ${a.titleKey} 在字典里 ${lang} 那一格是空的——期望值本身坏了，先补字典`);
          broken = true;
          continue;
        }
        want.push(label);
      }
      if (broken) continue;
      const got = table.map((r) => r[0] ?? "");
      if (JSON.stringify(got) === JSON.stringify(want)) continue;
      const diff = want.flatMap((w, i) => (got[i] === w
        ? []
        : [`第 ${i + 1} 行该是「${w}」（${order[i]?.id}），实际是「${got[i] ?? "（这一行不存在）"}」`]));
      out.push(
        `${lang}/ADMIN.md 危险区那张表的按钮列与 DANGER_ACTIONS 的行序对不上：`
        + `${diff.length > 0 ? diff.join("；") : `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`}`
        + "——要改的是这三处之一：pure/settings.mjs 里那张表的顺序、这一份文档里那两行的顺序、"
        + "或者这一份把按钮名意译了（那一列逐字就该是屏幕上那颗按钮的标签）",
      );
    }
    return out;
  }

  it("五份 ADMIN.md 危险区那张表的按钮列，逐行等于 DANGER_ACTIONS 的 titleKey 译文", () => {
    const failures = dangerRowFailures(realAdminDoc, DANGER_ACTIONS);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("非空锚：这一格真的在比东西 —— 危险区有按钮、每种语言都取到了那么多行按钮名", () => {
    expect(DANGER_ACTIONS.length, "DANGER_ACTIONS 是空的——本组测的是空气").toBeGreaterThan(0);
    const idx = dangerTableIndex();
    for (const lang of LANGS) {
      const table = tableCells(realAdminDoc(lang))[idx];
      expect(table?.length, `${lang}/ADMIN.md 第 ${idx + 1} 张表的行数与屏幕对不上——本组比的是空数组`)
        .toBe(DANGER_ACTIONS.length);
      for (const row of table ?? []) {
        expect((row[0] ?? "").trim(), `${lang}/ADMIN.md 危险区表里有一行的按钮列是空的`).not.toBe("");
      }
    }
  });

  it("该红时红：DANGER_ACTIONS 两条记录整体对调（条数与 id 集合都不变）—— 五份一起红", () => {
    expect(dangerRowFailures(realAdminDoc, DANGER_ACTIONS), "真表原样反而红了——先看真扫描那一格").toEqual([]);
    const swapped = [...DANGER_ACTIONS].reverse();
    // **落点断言**：只有一颗按钮时「对调」等于没动，那时这一格会静静地绿。
    if (JSON.stringify(swapped.map((a) => a.id)) === JSON.stringify(DANGER_ACTIONS.map((a) => a.id))) {
      throw new Error("对调之后 id 序列没变——这一格控制是空的，得换一条造顺序差异的办法");
    }
    const failures = dangerRowFailures(realAdminDoc, swapped);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
    for (const h of ["zh-CN/ADMIN.md", "第 1 行", DICT[DANGER_ACTIONS[0]!.titleKey]!["zh-CN"]!]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  it("该红时红：只有 ko 那份把危险区两行对调 —— 只点名 ko，并写出第 1 行的期望与实际", () => {
    expect(dangerRowFailures(realAdminDoc, DANGER_ACTIONS), "真表原样反而红了——先看真扫描那一格").toEqual([]);
    const idx = dangerTableIndex();
    const swapRows: ApiDocReader = readerWith("ko", (s) => {
      const rows = tableCells(s)[idx] ?? [];
      const lines = s.split("\n");
      const at = rows.map((r) => lines.findIndex((l) => l.trim().startsWith(`| ${r[0]} |`)));
      if (at.length !== 2 || at.some((i) => i < 0)) return s;
      const [a, b] = at as [number, number];
      const tmp = lines[a]!;
      lines[a] = lines[b]!;
      lines[b] = tmp;
      return lines.join("\n");
    }, ADMIN);
    const failures = dangerRowFailures(swapRows, DANGER_ACTIONS);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    for (const h of ["ko/ADMIN.md", "第 1 行", DICT[DANGER_ACTIONS[0]!.titleKey]!.ko!]) {
      expect(failures[0] ?? "", "红了但报文没点名这些东西").toContain(h);
    }
  });

  it("不乱红：某一份把危险区表**别的列**重写了（译文本来就该各写各的）—— 一格都不红", () => {
    const reworded: ApiDocReader = readerWith("en", (s) => s.replace(
      "The key pool, per-key usage, event records and refill history",
      "The key pool, the per-key usage counters, the event log and the refill history",
    ), ADMIN);
    expect(dangerRowFailures(reworded, DANGER_ACTIONS),
      "改的是第 3 列却红了——这条判据的射程越出了按钮列").toEqual([]);
  });

  // ── ⑥ 设置卡表与调试台模式表：同一条派生法，多两张表（P3e Task 26A）───────────
  //
  // ⚠️ **上一版这里写着「第 12 节（危险区）今天只有一句『这张卡还不存在』，靠的就是
  // 下面那条设置卡变异」——那句话从 P3e Task 31 起是史实，不是现状。** 那条变异当时
  // 模拟的正是 Task 31 会建的第 5 张卡，而它当天真的落地了：`sec-settings.js` 今天建
  // 五张卡，第 12 节也从占位改成了实节 + 一张两行的表。**那条绊线按设计响过了**
  //（本任务实测：只加卡不改文档 ⇒ 这一组 9 格红，其中 5 格逐份点名「设置卡」）。
  // 下面那条变异因此上移一档：现在模拟的是**第 6 张卡**。

  /**
   * ⚠️⚠️ **落地之后真仓自己就处在旧判据会瞎掉的那个形态里，这件事必须留成一条断言。**
   *
   * 旧判据（Task 26）是「行数恰好等于 n 的表有且只有一张」，它当时全绿逃逸的原因是
   * 设置卡数撞上了黄条数。Task 31 落地之后**那个撞号是真的**：设置卡 5 张、黄条 5 条。
   * 也就是说旧判据对「设置卡表少一行」这件事**今天恒瞎**——而位置判据不受影响。
   * 这一格把撞号本身钉住（撞号消失时它会红，提醒回来重新评估下面那条变异还覆不覆盖
   * 那个形态），紧跟着的那一格用一次**文档侧**变异正面证明位置判据没被撞号骗到。
   */
  it("落地之后的既成事实：设置卡表与警告条表今天行数相同 —— 旧的「按行数认表」判据对它已经恒瞎", () => {
    const c = realPanel();
    expect(c.cards,
      "设置卡数与黄条数不再相同了 —— 下面那格「按行数认表会认错」的正面证据没了，回来重新评估")
      .toBe(c.warn);
  });

  it("该红时红：设置卡表少一行（五份一起）—— 位置判据点名「设置卡」，不许认成行数相同的警告条表", () => {
    probeTableBase();
    // **文档侧变异**：把每一份 ADMIN.md 的第 4 张表（设置卡）删掉最后一行数据。
    // 旧判据在这里会去数「5 行的表有几张」、数到警告条那张、判为「有且只有一张」而放行。
    const dropLastRowOfTable = (s: string, nth: number): string => {
      const lines = s.split("\n");
      let table = 0;
      let inRun = false;
      let lastRow = -1;
      for (let i = 0; i < lines.length; i += 1) {
        const isRow = /^\s*\|/.test(lines[i] ?? "");
        if (isRow && !inRun) { inRun = true; table += 1; }
        if (isRow && table === nth) lastRow = i;
        if (!isRow) inRun = false;
      }
      if (lastRow < 0) throw new Error(`夹具找不到第 ${nth} 张表 —— 这一格的变异是空的`);
      return [...lines.slice(0, lastRow), ...lines.slice(lastRow + 1)].join("\n");
    };
    const shorter: ApiDocReader = (lang) => dropLastRowOfTable(realAdminDoc(lang), 4);
    const failures = tableSeqFailures(expectedTables(realPanel()), shorter);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
    for (const h of ["设置卡", "第 4 张"]) {
      expect(failures[0] ?? "", "红了但报文没点名是哪一张表——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  it("该红时红：设置页多出第 6 张卡而五份文档没跟着加行 —— 五份一起红", () => {
    probeTableBase();
    const src = readPanelSource();
    // 变异取真源：照本仓真的会写的那一行再加一张卡出来。
    const mutated = {
      ...src,
      settings: src.settings.replace(
        'const danger = card("set.card.danger");',
        'const danger = card("set.card.danger");\n    const extra = card("set.card.extra");',
      ),
    };
    expect(mutated.settings === src.settings, "变异没落到 sec-settings.js 上——这一格控制是空的").toBe(false);
    const c = panelCounts(mutated);
    expect(c.cards, "变异没让卡多一张").toBe(realPanel().cards + 1);
    const failures = tableSeqFailures(expectedTables(c), realAdminDoc);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
    for (const h of ["设置卡", "第 4 张"]) {
      expect(failures[0] ?? "", "红了但报文没点名是哪一张表——报文是唯一会被看见的护栏").toContain(h);
    }
  });

  /**
   * ⚠️ **危险区那张表是 P3e Task 31 新加的第 5 张，它与前四张走同一条派生法。**
   * 真源是 `admin-ui/js/pure/settings.mjs` 的 `DANGER_ACTIONS`——那张表加一颗按钮
   *（比如把「重置单把 key 的用量」也做成危险区按钮，而设计小节明令它不该在这里）
   * 就会让五份文档一起红，逼人回来同时改第 12 节的表。
   */
  it("该红时红：危险区多出第三颗按钮而五份文档没跟着加行 —— 五份一起红并点名危险区", () => {
    probeTableBase();
    const src = readPanelSource();
    const mutated = {
      ...src,
      pureSettings: src.pureSettings.replace(
        '  {\n    id: "purgeKeys",',
        '  {\n    id: "clearAllStats",\n    titleKey: "set.danger.purge.title",\n'
        + '    descKey: "set.danger.purge.desc",\n    buttonKey: "set.danger.purge.button",\n  },\n  {\n    id: "purgeKeys",',
      ),
    };
    expect(mutated.pureSettings === src.pureSettings, "变异没落到 pure/settings.mjs 上——这一格控制是空的").toBe(false);
    const c = panelCounts(mutated);
    expect(c.danger, "变异没让危险区多一颗按钮").toBe(realPanel().danger + 1);
    const failures = tableSeqFailures(expectedTables(c), realAdminDoc);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(LANGS.length);
    for (const h of ["危险区", "第 5 张"]) {
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
 * ── 根 README 首屏的「一行五链」对账（P3e Task 27 / P3f 阶段 5A 改写）────────
 *
 * 根 `README.md` 是 GitHub 首屏。它有几处 R1–R6 一条都看不见的东西：
 *
 * ① **正文里所有相对链接指的文件在不在**。R4 只比五语言之间的链接多重集，**根 README
 *   根本不在那五份里**；就算在，「五份一起把同一个链接指错」也照样全绿（那句边界写在
 *   R1–R6 上方，逐字适用）。首屏那几行指错了，读者第一步就撞墙。
 *   ⚠️ **射程是整份文件，也包含 HTML 标记里的链接**：P3f 阶段 5A 把首屏换成了模板的
 *   HTML 头部块，语言切换行与 logo 从 markdown 变成了 `<a href>` / `<img src>`。
 *   只扫 `](…)` 的话它们会整片掉出射程，而那正是首屏最显眼的几条。存在性还要求
 *   **是文件**：`existsSync` 对目录也返回真，`[ADMIN](docs/en)` 点开是列目录不是文档
 *   （下面有一格该红时红钉这条）。
 * ④ **五条 `> 📖` 指针行按「文档 × 语言」定位**。模板把文档入口写成「一行五链」的
 *   指针行贴在用得到它的那一节首行（`K/README.md:76,196,409`），P3f W49 据此删掉了
 *   旧的 `## Documentation` 矩阵表。这一条问的是每一条指针行**自己**站不站得住：
 *   认得出是哪一份文档、五种语言一种不少、每一格的目标都是 `docs/<语言>/<文档>.md`、
 *   同一种语言不出现两次。
 * ④A **每份 `DOCS` 文档在根 README 里都指得到五种语言**，一种都不少。这一条**只问入口
 *   在不在，不问入口长什么样**：谁写在指针行里、谁写在语言切换行里都算数。
 *   ⚠️ 射程是 `DOCS` 减去 `NO_ROOT_FIVE_LANG_ENTRY`，那张名册**两个方向都查**。
 * ⑤ **语言切换行与五条指针行互相印证**：同一种语言在这两处的**自称**必须逐字一致。
 *   两处各写一份，写岔了首屏自相矛盾。这一条同时是「同一条指针行里两格目标对调」
 *   的唯一守卫——那种置换不改任何一个目标集合、也不缺任何一种语言，只有
 *   「语言 × 标签」这一层看得见。
 * ⑥ **根 README 的 `## ` 序列逐字命中 `SECTIONS` 常量的 zh-CN 那一列**（R11 的根那一半）。
 *   它取代的是旧的 ②/②B——那两条对账的是「根 README 与 `docs/en/README.md` 的
 *   `## Features` / `## Models` / `## Endpoints at a glance` / `## Quick start` 四节
 *   是两份逐字复制」。P3f 阶段 5A 之后**这个关系被有意解除**：根那份改成简体中文的
 *   模板 16 节骨架，`docs/en/README.md` 仍是英文版，两者不再是复制关系，
 *   照旧比下去只会得到一条永远红的判据。**被解除的关系不留空位**——根那份的结构
 *   改由 R11 守：删一节、改一节的名字、两节对调，三种都会红并点名。
 * ③ **六份 README 的版本徽章**：`scripts/set-version.sh` 用一个 `sed` 一次刷六份，
 *   漏了哪一份、或者谁手改过某一份，只有这一格看得见。
 *
 * ── 它做不到什么（明写，别读成「首屏从此都是真的」）──────────────────────────
 * ⚠️ **这份名单本身被复评实测推翻过一次**，教训比名单更值钱：一份**指错方向**的边界
 * 名单比不写更容易让人放心——它请读者去担心一件已经有人守的事，而真正没人守的
 * 根本不在名单里。**下面每一条都是实测过的。**
 *
 * · ① 只查**链接指的文件在不在**，不查**指得对不对**。指针行那 `LANGS × 文档` 格今天由
 *   ④/⑤ 兜住，**但正文散文里的链接只有 ①**：把 `## ☕ 赞赏 & 共享` 那条指向
 *   `CONTRIBUTING.md` 的链接改指 `SECURITY.md`，文件在 ⇒ **全绿**。这是今天真正剩下的那个洞。
 * · ④ 只看每条指针行**自己**：五种语言齐不齐、目标形态对不对。**同一条行里两格的目标
 *   对调它一个字都不吭**（目标集合一个元素都没少、语言一种都不缺）——那一种由 ⑤ 兜住。
 * · ④A 只数「五种语言齐不齐」，**不要求那五条落在同一行上**，也不看那条入口周围写了什么。
 * · ⑤ 只比**标签与语言目录的对应关系**，不看「`한국어` 这四个字其实是不是韩文」——
 *   那件事没有机器判据，只能靠人。
 * · ⑥ 只比 `## ` 那一行的**字面**，不看每一节里写了什么。一节标题对了、内容写反了，
 *   它一个字都不吭。
 * · ③ 只比字符串包含，管不到徽章的颜色与链接目标，也管不到 `package.json` 里那一份
 *   版本号（那是 `scripts/set-version.sh` 一次刷的另一半）。
 * · 面板条目里那句话是否属实（`ADMIN_TOKEN` 没设时 `/admin` 真的不注册），**这一组
 *   一无所知**——但那件事并非无人守：
 *   tests/contract/wiring.test.ts「ADMIN_TOKEN 真的接到了 /admin 上（两个方向都断言）」
 *   的反向那一枪钉的正是它，而且 `tests/contract/` 双运行时都跑。
 *   文档判据管不了的是**文档**，不是那个行为。
 */
describe("根 README 首屏的一行五链与 16 节骨架（P3e Task 27 / P3f 阶段 5A 改写）", () => {
  /** 六份 README：根那份 + 五语言。`LANGS` 变了它自动跟着变，不手抄第二份名单。 */
  const SIX = ["README.md", ...LANGS.map((l) => `docs/${l}/README.md`)] as const;

  /**
   * 模板把文档入口写成贴在小节首行的「一行五链」指针行，一份文档一条。
   * 这张表**只是顺序无关的期望集合**：哪一份文档该有指针行，由 ④A 的射程决定，
   * 这里列出来是为了让 ④ 的报文说得出「哪一份缺了」。
   */
  const POINTER_DOCS = ["ADMIN", "API", "DEPLOY", "REGISTRAR", "USAGE"] as const;

  /**
   * ④A 的射程要减掉的那几份：**按模板形态，根 README 里就没有它们的五语言入口**。
   *
   * 今天只有 `SPONSORS`：模板的 `## ☕ 赞赏 & 共享` 一节只链根 `SPONSORS.md` 一条
   * （`K/README.md:588` 逐字），`docs/{lang}/SPONSORS.md` 的入口在**各语言版 README
   * 的同一节**里，不在根。
   *
   * ⚠️ **名册两个方向都查**（下面各有一格）：登记了却在根 README 里指得到五种语言
   * ⇒ 红（登记过期了，删掉它）；根那条指向 `SPONSORS.md` 的链接没了 ⇒ 红
   * （那是这份文档在首屏唯一的入口）。
   *
   * ── 这一条登记**不是过渡欠账，别到期就删**（P3f 阶段 5B 收尾，实测过）────────
   * 它与 `ROOT_ONLY_IDENTS` 长得像、性质相反：那张表兜的是「五语言版还没跟上」这个
   * **暂时**不成立的前提，跟上来当天必须清空；这一条记的是**模板的固定形态**
   *（根的 ☕ 节只链根 `SPONSORS.md` 一条），五语言版做完之后它照旧成立。
   *
   * 实测：把 `SPONSORS` 从本名册删掉 ⇒ ④A 当场红
   *「根 README 里指得到 SPONSORS.md 的只有 0 种语言，缺 zh-CN、zh-TW、en、ja、ko」，
   * 同时上面那格反向控制因为名册空了而红。**那条红是对的**——根那份确实没有、
   * 按模板也不该有。⇒ 登记留着，删它等于逼人把根 README 写成不合模板的形态。
   *
   * 阶段 5A 登记它时挂着的那笔真欠账是**另一件事**：`docs/{lang}/SPONSORS.md` 那五份
   * 当时在**任何** README 里都没有入口（W49 删掉矩阵表时一并没了）。
   * 那笔账由下面的 ④B 结清——入口补在**各语言版自己的 ☕ 节**里，不在根。
   */
  const NO_ROOT_FIVE_LANG_ENTRY = ["SPONSORS"] as const;
  const ENTRY_DOCS = DOCS.filter((d) => !(NO_ROOT_FIVE_LANG_ENTRY as readonly string[]).includes(d));

  /**
   * 正文里**所有**相对链接目标。markdown 的 `](…)` 与 HTML 的 `href=` / `src=` 一起收。
   * **真扫描与反向控制共用这一份。**
   *
   * ⚠️ 页内锚点（`#-快速部署` 那一族）与外链一律不进：前者不指文件，后者不在磁盘上。
   */
  const relTargets = (body: string) => [
    ...[...body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!),
    ...[...body.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!),
    ...[...body.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]!),
  ].filter((t) => !t.startsWith("http") && !t.startsWith("#"));

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
   * ⚠️ 这一条是复评用两条变异逼出来的：探针的基取自**真文档**，真文档今天本身就不过判据时，
   * 探针会跟着红，而它的报文说的是「判据坏了」——把人直直引向一个没坏的东西。
   * **先看基干不干净，脏了就当场抛并把人指回主格。**
   */
  const probeBase = (failures: readonly string[], mainCell: string) => {
    if (failures.length > 0) {
      throw new Error("本格是探针，它的基取自真文档，而真文档今天本身就不过判据 —— "
        + `别从这一格的报文里找原因，真因在「${mainCell}」那一格：\n${failures.join("\n")}`);
    }
  };

  /* ── 「一行五链」的解析器：切换行与指针行共用同一份 ────────────────────────── */

  /** 一行五链里的一格：`<a href="…">标签</a>`、`[标签](…)`，或者不带链接的纯文本。 */
  interface LinkCell { label: string; target: string | null }

  /** 引导词（`📖 文档语言：` / `📖 详细部署文档：` 那一段）。中英文冒号都认。 */
  const FIVE_LINK_LEAD = /^\s*>?\s*📖[^：:]*[：:]\s*/;

  const splitLinkCells = (line: string): LinkCell[] =>
    line.replace(FIVE_LINK_LEAD, "").split("|").map((s) => s.trim()).filter((s) => s !== "")
      .map((c) => {
        const html = /^<a href="([^"]+)">(.*)<\/a>$/.exec(c);
        if (html !== null) return { label: html[2]!.trim(), target: html[1]! };
        const md = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(c);
        if (md !== null) return { label: md[1]!.trim(), target: md[2]! };
        return { label: c, target: null };
      });

  /**
   * 一行五链的「语言目录 → 标签」映射。**语言从每一格自己的目标现算**，不靠格序。
   * 认不出的格进 `failures`，不静静丢掉。
   */
  const lineLangLabels = (line: string, doc: string, where: string) => {
    const map = new Map<string, string>();
    const failures: string[] = [];
    const cells = splitLinkCells(line);
    if (cells.length === 0) failures.push(`${where}一格都切不出来——认不出要吵，不许静静报零缺格`);
    for (const c of cells) {
      if (c.target === null) continue; // 当前语言那一格不带链接（语言版才有），由调用方数
      const m = new RegExp(`^(?:\\.\\./|docs/)([^/]+)/${doc}\\.md$`).exec(c.target);
      if (m === null) {
        failures.push(`${where}里「${c.label}」指向 ${c.target}，不是 docs/<语言>/${doc}.md`);
        continue;
      }
      if (map.has(m[1]!)) failures.push(`${where}里 ${m[1]} 这一种语言出现了两次`);
      map.set(m[1]!, c.label);
    }
    const missing = LANGS.filter((l) => !map.has(l));
    if (missing.length > 0) failures.push(`${where}缺这几种语言：${missing.join("、")}`);
    const extra = [...map.keys()].filter((l) => !(LANGS as readonly string[]).includes(l)).sort();
    if (extra.length > 0) failures.push(`${where}里有 LANGS 之外的语言目录：${extra.join("、")}`);
    return { map, failures };
  };

  /** 语言切换行：`📖` 开头、**不在引用块里**的那一行。认不出返回 `null`。 */
  const switcherLine = (body: string): string | null =>
    body.split("\n").find((l) => l.includes("📖") && !l.trimStart().startsWith(">")) ?? null;

  /** 五条 `> 📖` 指针行。 */
  const pointerLines = (body: string): string[] =>
    body.split("\n").filter((l) => l.trimStart().startsWith("> 📖"));

  /** ④ 的失败报文全集。**真扫描与反向控制共用这一份。** */
  const pointerFailures = (body: string): string[] => {
    const lines = pointerLines(body);
    if (lines.length === 0) {
      return ["认不出根 README 里的 `> 📖` 指针行——认不出要吵，不许静静报零缺格"];
    }
    const out: string[] = [];
    const seen: string[] = [];
    for (const line of lines) {
      const doc = DOCS.find((d) => line.includes(`/${d}.md`));
      if (doc === undefined) {
        out.push(`这一条 \`> 📖\` 指针行里一份 DOCS 文档都认不出来：${line.trim()}`);
        continue;
      }
      if (seen.includes(doc)) out.push(`${doc} 有两条 \`> 📖\` 指针行——同一份文档在首屏出现两个入口`);
      seen.push(doc);
      out.push(...lineLangLabels(line, doc, `${doc} 的 \`> 📖\` 指针行`).failures);
    }
    const missing = POINTER_DOCS.filter((d) => !seen.includes(d));
    if (missing.length > 0) {
      out.push(`这几份文档在根 README 里没有 \`> 📖\` 指针行：${missing.join("、")}`
        + "——模板把入口贴在用得到它的那一节首行，少一条就是少一个入口");
    }
    return out;
  };

  /**
   * ④A 的失败报文全集：**每份 `ENTRY_DOCS` 文档在根 README 都指得到五种语言，一种都不少。**
   *
   * ⚠️ **这一条与入口的排版形态解耦**：只问 `docs/<语言>/<文档>.md` 这五个目标在根 README
   * 正文里出没出现（射程是整份文件，markdown 与 HTML 一起），谁写在指针行里、
   * 谁写在语言切换行里都算数。
   *
   * ⚠️ **它做不到什么，明写**：它**不要求五种语言落在同一行上**，也不看那条入口周围
   * 写了什么——一条 `docs/ko/API.md` 藏在一段与 API 无关的散文里，它照样算数。
   */
  const docPointerFailures = (body: string, docs: readonly string[] = ENTRY_DOCS): string[] => {
    const targets = relTargets(body);
    const out: string[] = [];
    for (const doc of docs) {
      const re = new RegExp(`^docs/([^/]+)/${doc}\\.md$`);
      const seen = new Set(targets.flatMap((t) => {
        const m = re.exec(t);
        return m?.[1] === undefined ? [] : [m[1]];
      }));
      const missing = LANGS.filter((l) => !seen.has(l));
      const extra = [...seen].filter((l) => !(LANGS as readonly string[]).includes(l)).sort();
      if (missing.length > 0) {
        out.push(`根 README 里指得到 ${doc}.md 的只有 ${LANGS.length - missing.length} 种语言，缺 ${missing.join("、")}`
          + "——首屏少一种语言的入口，那一种语言的读者就找不到这份文档，等于没写");
      }
      if (extra.length > 0) {
        out.push(`根 README 里 ${doc}.md 指向了 LANGS 之外的语言目录：${extra.join("、")}`);
      }
    }
    return out;
  };

  /**
   * ⑤ 的失败报文全集：语言切换行与五条指针行**互相印证**。
   * 「当前页那一种语言不带链接」在根 README 上**不成立**——模板的根那份把
   * `简体中文` 也写成链接（指向 `docs/zh-CN/README.md` 那份并存的中文副本），
   * 所以这里数的是「五种语言一种不少」，不是「恰好一种不带链接」。
   */
  const switcherFailures = (body: string): string[] => {
    const line = switcherLine(body);
    if (line === null) return ["认不出根 README 的语言切换行（首屏那条带 `📖` 的行）——认不出要吵"];
    const { map, failures } = lineLangLabels(line, "README", "语言切换行");
    const out = [...failures];
    for (const p of pointerLines(body)) {
      const doc = DOCS.find((d) => p.includes(`/${d}.md`));
      if (doc === undefined) continue; // 认不出是哪份文档 ⇒ ④ 已经点名了，这里不重复报
      const { map: pm } = lineLangLabels(p, doc, `${doc} 的 \`> 📖\` 指针行`);
      for (const [lang, label] of pm) {
        const inLine = map.get(lang);
        if (inLine === undefined) out.push(`${doc} 的指针行有 ${lang}，语言切换行里却没有这一种语言`);
        else if (inLine !== label) {
          out.push(`${lang} 在语言切换行里叫「${inLine}」，在 ${doc} 的指针行里却叫「${label}」`
            + "——首屏两处自相矛盾，多半是同一行里两格的目标被对调了");
        }
      }
    }
    return out;
  };

  it("① 根 README 正文里的每一个相对链接都指向磁盘上真实存在的**文件**", () => {
    const body = readFileSync("README.md", "utf8");
    expect(relTargets(body).length, "根 README 里扫到的相对链接比五条指针行加语言切换行还少，链接正则多半写坏了")
      .toBeGreaterThanOrEqual(LANGS.length * (POINTER_DOCS.length + 1));
    const broken = brokenTargets(body);
    expect(broken, `根 README 里这些相对链接在磁盘上不是一个存在的文件：${broken.join("、")}`).toEqual([]);
  });

  it("① 该红时红：某条指针行指向一个仓里没有的语言目录", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(brokenTargets(body), "① 根 README 正文里的每一个相对链接都指向磁盘上真实存在的**文件**");
    const gone = `docs/${"de"}/API.md`;
    const mutated = body.replaceAll("(docs/ja/API.md)", `(${gone})`);
    expect(mutated, "变异没落地——指针行里没有 `(docs/ja/API.md)` 这一格").not.toEqual(body);
    expect(brokenTargets(mutated), "指针行指向了一个不存在的文件，① 却没红").toEqual([gone]);
  });

  it("① 该红时红：链接指到的是一个**目录**而不是文件 —— `existsSync` 会放行，① 不许放行", () => {
    expect(existsSync("docs/en") && !statSync("docs/en").isFile(), "docs/en 不是一个存在的目录，这一格控制是空的").toBe(true);
    const body = readFileSync("README.md", "utf8");
    probeBase(brokenTargets(body), "① 根 README 正文里的每一个相对链接都指向磁盘上真实存在的**文件**");
    const mutated = body.replaceAll("(docs/en/ADMIN.md)", "(docs/en)");
    expect(mutated, "变异没落地——根 README 里没找到 `(docs/en/ADMIN.md)`").not.toEqual(body);
    expect([...new Set(brokenTargets(mutated))], "链接指到了一个目录，① 却放行了").toEqual(["docs/en"]);
  });

  it("① 不乱红：HTML 头部块里的 logo 与语言切换行也在射程内，今天它们都是真文件", () => {
    const body = readFileSync("README.md", "utf8");
    const html = [
      ...[...body.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!),
      ...[...body.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]!),
    ].filter((t) => !t.startsWith("http") && !t.startsWith("#"));
    expect(html.length, "HTML 标记里一个相对链接都没扫到——① 多半又缩回只认 markdown 的 `](…)` 了")
      .toBeGreaterThanOrEqual(LANGS.length + 1);
    expect(html.filter((t) => !(existsSync(t) && statSync(t).isFile())), "HTML 标记里的相对链接有坏的").toEqual([]);
  });

  it("④ 五条 `> 📖` 指针行按「文档 × 语言」定位 —— 每一格的语言从它自己的目标现算", () => {
    const body = readFileSync("README.md", "utf8");
    expect(pointerLines(body).length, "一条 `> 📖` 指针行都没扫到，④ 测的是空气").toBe(POINTER_DOCS.length);
    const failures = pointerFailures(body);
    expect(failures, `首屏的指针行对不上账：\n${failures.join("\n")}`).toEqual([]);
  });

  it("④ 该红时红：某条指针行里少一种语言 —— 点名是哪一份文档缺了哪一种", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(pointerFailures(body), "④ 五条 `> 📖` 指针行按「文档 × 语言」定位 —— 每一格的语言从它自己的目标现算");
    const mutated = body.replaceAll(" | [한국어](docs/ko/DEPLOY.md)", "");
    expect(mutated, "变异没落地——DEPLOY 的指针行里没找到 한국어 那一段").not.toEqual(body);
    const failures = pointerFailures(mutated);
    expect(failures.join("\n"), "指针行少了一种语言，④ 却没红").toContain("DEPLOY");
    expect(failures.join("\n"), "④ 红了却没说少的是哪一种语言").toContain("缺这几种语言：ko");
  });

  it("④ 认不出要吵：五条指针行整片没了时报文明说认不出，不许静静报零缺格", () => {
    const body = readFileSync("README.md", "utf8");
    const gutted = body.split("\n").filter((l) => !l.trimStart().startsWith("> 📖")).join("\n");
    expect(gutted, "变异没落地——根 README 里一条 `> 📖` 都没找到").not.toEqual(body);
    expect(pointerFailures(gutted).join("\n"), "指针行全没了却没吵").toContain("认不出");
  });

  it("④A 每份 DOCS 文档在根 README 都指得到五种语言 —— 一种都不少", () => {
    const body = readFileSync("README.md", "utf8");
    // 平凡相等护栏：射程空了、或者根 README 一条 `docs/<语言>/<文档>.md` 都扫不到时，
    // 下面那句 `toEqual([])` 会因为"什么都没查"而永远绿。
    expect(ENTRY_DOCS.length, "④A 的射程是空的，它测的是空气").toBeGreaterThan(0);
    expect(relTargets(body).filter((t) => /^docs\/[^/]+\/[A-Z]+\.md$/.test(t)).length,
      "根 README 里一条 `docs/<语言>/<文档>.md` 都没扫到——④A 测的是空气")
      .toBeGreaterThanOrEqual(LANGS.length * ENTRY_DOCS.length);
    const failures = docPointerFailures(body);
    expect(failures, `首屏有文档指不全五种语言：\n${failures.join("\n")}`).toEqual([]);
  });

  it("④A 该红时红：根 README 里 REGISTRAR 的五语言指针整片被抹掉 —— 点名 REGISTRAR 没有入口", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(docPointerFailures(body), "④A 每份 DOCS 文档在根 README 都指得到五种语言 —— 一种都不少");
    // 换成一份**真实存在**的兄弟文档：磁盘上的文件一个都没少，① 一个字都不会吭，
    // 「入口没了」这件事只有 ④A 看得见。
    const mutated = body.replaceAll("REGISTRAR.md", "USAGE.md");
    expect(mutated, "变异没落地——根 README 里没找到 `REGISTRAR.md`").not.toEqual(body);
    expect(brokenTargets(mutated), "换的是一份真实存在的文档，① 却跟着红了——变异多半打偏了").toEqual([]);
    const failures = docPointerFailures(mutated);
    expect(failures.join("\n"), "REGISTRAR 的指针整片没了，④A 却没点名它").toContain("REGISTRAR.md");
    expect(failures.join("\n"), "④A 红了却没说少了哪几种语言").toContain(LANGS.join("、"));
    expect(failures, `只抹掉一份文档的指针，只该报这一条，实报：\n${failures.join("\n")}`).toHaveLength(1);
  });

  it("④A 名册两个方向都查（一）：登记在 NO_ROOT_FIVE_LANG_ENTRY 里的文档，根 README 里确实指不到五种语言", () => {
    const body = readFileSync("README.md", "utf8");
    expect(NO_ROOT_FIVE_LANG_ENTRY.length, "名册是空的，这一格测的是空气").toBeGreaterThan(0);
    const stale = NO_ROOT_FIVE_LANG_ENTRY.filter((d) => docPointerFailures(body, [d]).length === 0);
    expect(stale, `这几份文档登记着「根 README 里没有五语言入口」，可是今天指得到了：${stale.join("、")}`
      + "——登记过期了，把它从 NO_ROOT_FIVE_LANG_ENTRY 里删掉，这一份已经进得了 ④A 的射程").toEqual([]);
  });

  it("④A 名册两个方向都查（二）：根 README 的 ☕ 节仍然链着根 `SPONSORS.md` —— 那是它在首屏唯一的入口", () => {
    const body = readFileSync("README.md", "utf8");
    expect(relTargets(body), "根 README 里没有指向根 `SPONSORS.md` 的链接 —— 上一格豁免掉的那份文档"
      + "在首屏就一个入口都没有了；模板的 ☕ 节那条 `> 完整内容请查看 [SPONSORS.md](SPONSORS.md)` 不许删")
      .toContain("SPONSORS.md");
  });

  /* ── ④B 五份语言版 ☕ 节里的同目录 SPONSORS 入口（ADJ §57 的结清判据）──────────
   *
   * §57 登记的空档是：`docs/{lang}/SPONSORS.md` 那五份在**任何** README 里都没有入口。
   * 阶段 5B 把入口补在各语言版自己的 `## ☕` 节里（模板 `K/README.md:588` 的同一行
   * 形态，只是目标换成同目录那一份），这一格钉住那五条入口。
   *
   * **「同目录」是判据的一部分**：`[SPONSORS.md](SPONSORS.md)` 指的是
   * `docs/<lang>/SPONSORS.md`。换成 `../../SPONSORS.md`（根那份）或
   * `../zh-CN/SPONSORS.md`（别的语言那份）都不算——读日文 README 的人点开会掉进
   * 另一种语言，而 ① 那一格只查「文件在不在」，这两种改法它一个字都不会吭。
   *
   * ⚠️ **它验不了什么**：只问「那一节里有没有这条链接」，不问那一节还写了什么，
   * 也不问 `docs/<lang>/SPONSORS.md` 里面的内容对不对（那是 R2–R6 与 W67 的活）。
   */

  /** 一份语言版 README 的原文。真扫描与反向控制共用，`edit` 是唯一的注入点。 */
  const readLangReadme = (lang: Lang) => readFileSync(docPath(".", lang, "README"), "utf8");

  const langReadmeWith = (target: Lang, edit: (s: string) => string) => (lang: Lang) => {
    const src = readLangReadme(lang);
    if (lang !== target) return src;
    const out = edit(src);
    if (out === src) throw new Error(`变异没落到 docs/${lang}/README.md 上——这一格控制是空的`);
    return out;
  };

  /** ☕ 那一节在 `SECTIONS` 里的下标。 */
  const SPONSOR_AT = 11;

  /** ④B 的失败报文全集。**真扫描与反向控制共用这一份。** */
  const sponsorEntryFailures = (read: (lang: Lang) => string): string[] => {
    const out: string[] = [];
    for (const lang of LANGS) {
      const heading = SECTIONS[SPONSOR_AT]!.title[lang].replace(/^## /, "");
      const sec = sectionBody(read(lang), heading);
      if (sec === null) {
        out.push(`docs/${lang}/README.md 里认不出 \`## ${heading}\` 这一节——认不出要吵，`
          + "不许当成「这一节里没写那条链接」：真坏掉的是标题，报文却会把人指去补一条链接");
        continue;
      }
      if (!sec.includes("](SPONSORS.md)")) {
        out.push(`docs/${lang}/README.md 的 \`## ${heading}\` 节里没有指向**同目录** \`SPONSORS.md\` 的链接`
          + ` —— docs/${lang}/SPONSORS.md 于是在整套 README 里一个入口都没有`
          + "（根那份按模板只链根 `SPONSORS.md`，见 `NO_ROOT_FIVE_LANG_ENTRY` 上方那段）");
      }
    }
    return out;
  };

  it("④B 五份语言版的 ☕ 节都链着**同目录**的 SPONSORS.md —— ADJ §57 那个空档的结清判据", () => {
    expect(SECTIONS[SPONSOR_AT]!.title["zh-CN"], "SPONSOR_AT 指错了节——这一格会去找一个不存在的标题")
      .toBe("## ☕ 赞赏 & 共享");
    const failures = sponsorEntryFailures(readLangReadme);
    expect(failures, `语言版的 SPONSORS 入口不齐：\n${failures.join("\n")}`).toEqual([]);
  });

  it("④B 该红时红：ja 那条改指**根**那份 SPONSORS.md —— 文件在，① 一个字都不吭，只有 ④B 看得见", () => {
    probeBase(sponsorEntryFailures(readLangReadme), "④B 五份语言版的 ☕ 节都链着**同目录**的 SPONSORS.md —— ADJ §57 那个空档的结清判据");
    const read = langReadmeWith("ja", (s) => s.replace("](SPONSORS.md)", "](../../SPONSORS.md)"));
    // 「文件在」这半句要坐实，否则这一格证不了「只有 ④B 看得见」：`docs/ja/` 下的
    // `../../SPONSORS.md` 解析出来就是仓根那一份，它真实存在 ⇒ 任何只查「文件在不在」
    // 的判据都会放行。（① 那一格只跑在根 README 上、路径按仓根解析，够不着这里。）
    expect(existsSync(join("docs", "ja", "..", "..", "SPONSORS.md")),
      "仓根的 SPONSORS.md 不在，这一格的立论就没了").toBe(true);
    const failures = sponsorEntryFailures(read);
    expect(failures, `只改了一份，只该报这一条，实报：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "④B 红了却没点名是哪一份").toContain("docs/ja/README.md");
  });

  it("④B 该红时红：ko 那条链接整条被删掉 —— 点名 ko", () => {
    probeBase(sponsorEntryFailures(readLangReadme), "④B 五份语言版的 ☕ 节都链着**同目录**的 SPONSORS.md —— ADJ §57 那个空档的结清判据");
    const read = langReadmeWith("ko", (s) => s.replace("[SPONSORS.md](SPONSORS.md)", "SPONSORS.md"));
    const failures = sponsorEntryFailures(read);
    expect(failures, `只删了一份，只该报这一条，实报：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "④B 红了却没点名是哪一份").toContain("docs/ko/README.md");
  });

  it("④B 认不出要吵：zh-TW 的 ☕ 标题被改坏 —— 报「认不出这一节」，不是「这一节里没有链接」", () => {
    probeBase(sponsorEntryFailures(readLangReadme), "④B 五份语言版的 ☕ 节都链着**同目录**的 SPONSORS.md —— ADJ §57 那个空档的结清判据");
    const read = langReadmeWith("zh-TW", (s) => s.replace("\n## ☕ 贊賞 & 共享\n", "\n## ☕ 贊賞與共享\n"));
    const failures = sponsorEntryFailures(read);
    expect(failures, `只改坏了一份的标题，只该报这一条，实报：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "标题坏了却没说「认不出」").toContain("认不出");
    expect(failures[0] ?? "", "④B 红了却没点名是哪一份").toContain("docs/zh-TW/README.md");
  });

  it("⑤ 语言切换行与五条指针行互相印证 —— 同一种语言在两处的自称必须一致", () => {
    const body = readFileSync("README.md", "utf8");
    expect(switcherLine(body), "认不出语言切换行，⑤ 测的是空气").not.toBeNull();
    const failures = switcherFailures(body);
    expect(failures, `首屏的语言切换行与指针行对不上账：\n${failures.join("\n")}`).toEqual([]);
  });

  it("⑤ 该红时红：同一条指针行里两格的**目标**对调 —— 目标集合一个没少、语言一种不缺，只有「语言 × 标签」看得见", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(switcherFailures(body), "⑤ 语言切换行与五条指针行互相印证 —— 同一种语言在两处的自称必须一致");
    const line = pointerLines(body).find((l) => l.includes("/USAGE.md"))!;
    const mutated = body.replace(line, swapOnce(line, "(docs/ja/USAGE.md)", "(docs/ko/USAGE.md)"));
    expect(mutated, "变异没落地——USAGE 的指针行没被改写").not.toEqual(body);
    expect(new Set(relTargets(mutated)), "对调之后目标集合竟然变了，那这一格证不了「集合看不见置换」")
      .toEqual(new Set(relTargets(body)));
    expect(pointerFailures(mutated), "④ 跟着红了——那一条只看每行自己，置换它本来就该看不见").toEqual([]);
    const failures = switcherFailures(mutated);
    for (const l of ["ja", "ko"]) {
      expect(failures.join("\n"), `⑤ 红了却没点到 ${l}`).toContain(`${l} 在语言切换行里叫`);
    }
  });

  it("⑤ 该红时红：语言切换行里两种语言的**标签**对调（链接目标一个没动）—— 首屏两处自相矛盾", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(switcherFailures(body), "⑤ 语言切换行与五条指针行互相印证 —— 同一种语言在两处的自称必须一致");
    const line = switcherLine(body)!;
    const mutated = body.replace(line, swapOnce(line, ">日本語<", ">한국어<"));
    expect(mutated, "变异没落地——语言切换行没被改写").not.toEqual(body);
    expect(new Set(relTargets(mutated)), "只调标签不该动到任何链接目标，这一格证的正是「目标全对、标签指错」")
      .toEqual(new Set(relTargets(body)));
    const failures = switcherFailures(mutated);
    for (const l of ["ja", "ko"]) {
      expect(failures.join("\n"), `⑤ 红了却没点到 ${l}`).toContain(`${l} 在语言切换行里叫`);
    }
  });

  it("⑤ 该红时红：切换行里少一种语言", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(switcherFailures(body), "⑤ 语言切换行与五条指针行互相印证 —— 同一种语言在两处的自称必须一致");
    const mutated = body.replace(' | <a href="docs/ko/README.md">한국어</a>', "");
    expect(mutated, "变异没落地——语言切换行里没找到 한국어 那一段").not.toEqual(body);
    const failures = switcherFailures(mutated);
    expect(failures.join("\n"), "切换行少了一种语言，⑤ 却没红").toContain("语言切换行缺这几种语言：ko");
  });

  it("⑤ 认不出要吵：语言切换行改了写法时报文明说认不出，不许静静报零缺格", () => {
    const body = readFileSync("README.md", "utf8");
    const line = switcherLine(body)!;
    const mutated = body.replace(line, line.replace("📖 ", ""));
    expect(mutated, "变异没落地——语言切换行没被改写").not.toEqual(body);
    expect(switcherFailures(mutated).join("\n"), "语言切换行认不出了却没吵").toContain("认不出");
  });

  /* ── ⑥ R11 的根那一半：16 节骨架逐字命中常量表 ────────────────────────────── */

  /** 根 README 的 `## ` 序列。**真扫描与反向控制共用这一份。** */
  const rootHeadings = (body: string) => body.split("\n").filter((l) => l.startsWith("## "));
  const WANT_SECTIONS = SECTIONS.map((s) => s.title["zh-CN"]);

  it("⑥ R11（根）：根 README 的 16 节标题逐字命中 SECTIONS 常量的 zh-CN 那一列", () => {
    expect(WANT_SECTIONS.length, "常量表是空的，这一格测的是空气").toBe(16);
    expect(rootHeadings(readFileSync("README.md", "utf8")),
      "根 README 的章节骨架与 tests/helpers/readme-sections.ts 的常量表对不上"
      + "——两边改一处就要一起改，别只改一边").toEqual(WANT_SECTIONS);
  });

  it("⑥ R11（根）该红时红：删掉一节 —— 报文点名少了哪一节", () => {
    const body = readFileSync("README.md", "utf8");
    const victim = "## 🗂 项目结构";
    expect(rootHeadings(body), "选错了变异对象：根 README 里没有这一节").toContain(victim);
    const mutated = body.replace(`\n${victim}\n`, "\n");
    expect(mutated, "变异没落地").not.toEqual(body);
    expect(rootHeadings(mutated), "删掉一节之后骨架竟然还相等").not.toEqual(WANT_SECTIONS);
  });

  it("⑥ R11（根）该红时红：两节对调 —— 多重集一个元素都没少，只有序列看得见", () => {
    const body = readFileSync("README.md", "utf8");
    const mutated = swapOnce(body, "## 🙏 致谢", "## 📄 许可协议");
    const got = rootHeadings(mutated);
    expect([...got].sort(), "对调之后多重集竟然变了，那这一格证不了「集合看不见换序」")
      .toEqual([...WANT_SECTIONS].sort());
    expect(got, "两节对调了，⑥ 却没红——它多半退回了「在不在这个集合里」").not.toEqual(WANT_SECTIONS);
  });

  /* ── ⑦ 头部块那 9 条章节锚点导航（W53）───────────────────────────────────────
   *
   * 模板的头部块里有一排 `<a href="#-快速部署">快速部署</a> &bull; …`，**恰好 9 条**，
   * 收录 16 节里的 §1–§11 减去「技术架构」与「项目结构」（`K/README.md:19-29` 与
   * `G/README.md:19-29` 逐字节相同，两仓 100% 一致）。
   *
   * 锚点是**推导量不是手写量**：GitHub 的片段标识符由标题现算，改一个标题而不改导航，
   * 屏幕上那条链接就点开落空——而这种坏法**没有任何构建步骤会报错**。
   * 下面两格分别钉住「9 条解析得开」与「改标题不改导航当场红并点名死锚点」。
   *
   * ⚠️ **⑦ 只管根那一份，五份语言版那 45 条由下面的 ⑦B 管**（W53 的验收是 6 × 9 = 54 条，
   * 根 9 条 + 语言版 45 条）。两格分开写不是重复：根那份的期望值取 `SECTIONS` 的 zh-CN 列，
   * 语言版每一份取它**自己那一列**，而「拿别的语言的 slug 去当期望值」正是这一批最容易
   * 犯的错——五份导航长得极像，抄一份改几个字看上去就对了。
   */

  /** GitHub 的标题 → 片段标识符：转小写 → 删掉字母/数字/空格/连字符之外的字符 → 空格转 `-`。 */
  const slugOf = (heading: string) =>
    heading.replace(/^#+\s/, "").toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-");

  /** 头部块导航里的页内锚点。 */
  const navAnchors = (body: string) =>
    [...body.matchAll(/<a href="(#[^"]*)"/g)].map((m) => m[1]!);

  /** 导航收录的那 9 节在 `SECTIONS` 里的下标：§1–§11 去掉「技术架构」(2) 与「项目结构」(9)。 */
  const NAV_AT = [0, 1, 3, 4, 5, 6, 7, 8, 10] as const;

  /**
   * ⑦ / ⑦B 的失败报文全集。**真扫描与反向控制共用这一份**，`label` 只进报文不进判定。
   *
   * ⚠️ `rootHeadings` 在这里是**通用的** `## ` 行抽取器（名字是历史遗留），
   * 语言版那五份照样走它——一份 README 的 `## ` 行怎么抽，与它是不是根那份无关。
   */
  const deadAnchorFailures = (body: string, label = "根 README"): string[] => {
    const nav = navAnchors(body);
    if (nav.length === 0) return [`认不出 ${label} 头部块里的章节锚点导航——认不出要吵，不许静静报零缺格`];
    const slugs = new Set(rootHeadings(body).map(slugOf));
    return nav.filter((a) => !slugs.has(a.slice(1)))
      .map((a) => `头部块导航里的锚点 ${a} 在 ${label} 里没有对应的 \`## \` 标题——点开落空。`
        + "改标题就要一起改导航，两处是同一件事的两半");
  };

  it("⑦ 头部块那 9 条章节锚点全部解析得开，且逐条命中 SECTIONS 常量算出来的 slug", () => {
    const body = readFileSync("README.md", "utf8");
    expect(navAnchors(body), "头部块导航不是模板固定的 9 条")
      .toEqual(NAV_AT.map((i) => `#${slugOf(SECTIONS[i]!.title["zh-CN"])}`));
    const failures = deadAnchorFailures(body);
    expect(failures, `头部块导航里有死锚点：\n${failures.join("\n")}`).toEqual([]);
  });

  it("⑦ 该红时红：改一个 `## ` 标题而不改导航 —— 当场红并点名那个死锚点", () => {
    const body = readFileSync("README.md", "utf8");
    probeBase(deadAnchorFailures(body), "⑦ 头部块那 9 条章节锚点全部解析得开，且逐条命中 SECTIONS 常量算出来的 slug");
    const mutated = body.replace("\n## ⚙ 配置说明\n", "\n## ⚙ 配置项说明\n");
    expect(mutated, "变异没落地——根 README 里没找到 `## ⚙ 配置说明` 那一行").not.toEqual(body);
    const failures = deadAnchorFailures(mutated);
    expect(failures, "改了标题没改导航，⑦ 却没红").toHaveLength(1);
    expect(failures[0] ?? "", "⑦ 红了却没点名是哪一个锚点落空").toContain("#-配置说明");
  });

  /* ── ⑦B 五份语言版头部块的那 45 条锚点（W53 的另一半）─────────────────────────
   *
   * W53 的验收是 **6 × 9 = 54 条**：根那 9 条归 ⑦，语言版这 45 条归 ⑦B。
   * 每一份的期望值取 `SECTIONS` 里**它自己那一列**现算——不是从 zh-CN 那一列抄来再改，
   * 也不是把某一份的导航复制给另一份。
   *
   * ⚠️ **它验不了什么**：slug 算法是本文件按 GitHub 的规则**重写的一份**
   *（转小写 → 删掉 `\p{L}\p{N}`/空格/连字符之外的字符 → 空格转 `-`），
   * 本机没有 GitHub 的渲染器可对照。CJK 与谚文走 `\p{L}` 被保留、emoji 被删掉并在
   * 前面留下一个 `-`，这两条是从两个参照仓的实测锚点反推的，不是从 GitHub 文档抄的。
   * 算法本身错了的话，⑦/⑦B 会一起绿——它们守的是**导航与标题两处一致**，
   * 不是**这个 slug 在 GitHub 上真的跳得动**。
   */

  /** 一份语言版导航的期望值：**取它自己那一列**。 */
  const wantNav = (lang: Lang) => NAV_AT.map((i) => `#${slugOf(SECTIONS[i]!.title[lang])}`);

  it("⑦B 非空锚：五份语言版的期望导航两两不同 —— 「抄别的语言的」这种坏法它看得见", () => {
    const seen = new Map<string, Lang>();
    for (const lang of LANGS) {
      const key = wantNav(lang).join("|");
      const dup = seen.get(key);
      expect(dup, `docs/${lang}/README.md 与 docs/${dup}/README.md 的期望导航逐条相同——`
        + "两份的期望值撞了，⑦B 就分不出「这一份抄了那一份」，那正是它要抓的那一种").toBeUndefined();
      seen.set(key, lang);
    }
    expect(seen.size, "五份的期望导航没能各自成一份").toBe(LANGS.length);
  });

  for (const lang of LANGS) {
    it(`⑦B docs/${lang}/README.md 的 9 条章节锚点全部解析得开，且逐条命中 SECTIONS 的 ${lang} 那一列`, () => {
      const body = readFileSync(docPath(".", lang, "README"), "utf8");
      expect(navAnchors(body), `docs/${lang}/README.md 的头部块导航不是模板固定的 9 条`
        + "——期望值取的是这一份自己那一列，别拿另一种语言的 slug 顶替")
        .toEqual(wantNav(lang));
      const failures = deadAnchorFailures(body, `docs/${lang}/README.md`);
      expect(failures, `docs/${lang}/README.md 的头部块导航里有死锚点：\n${failures.join("\n")}`).toEqual([]);
    });

    it(`⑦B 该红时红：改 docs/${lang}/README.md 的一个 \`## \` 标题而不改导航 —— 当场红并点名死锚点`, () => {
      const file = docPath(".", lang, "README");
      const body = readFileSync(file, "utf8");
      probeBase(deadAnchorFailures(body, file),
        `⑦B docs/${lang}/README.md 的 9 条章节锚点全部解析得开，且逐条命中 SECTIONS 的 ${lang} 那一列`);
      // 变异对象取 §8「配置说明」那一节（`NAV_AT` 收录它），改法是在标题末尾接一个 `-v2`：
      // `-` 与 `v2` 都活得过 slug 的字符过滤 ⇒ slug 一定变，而这个改法与语言无关，
      // 五种语言共用同一段代码，不必为每一种手写一个「改成什么」。
      const victim = SECTIONS[7]!.title[lang];
      const mutated = body.replace(`\n${victim}\n`, `\n${victim}-v2\n`);
      expect(mutated, `变异没落地——docs/${lang}/README.md 里没找到 \`${victim}\` 那一行`).not.toEqual(body);
      const dead = `#${slugOf(victim)}`;
      expect(slugOf(`${victim}-v2`), "改完之后 slug 竟然没变，这一格的变异是空的").not.toEqual(slugOf(victim));
      const failures = deadAnchorFailures(mutated, file);
      expect(failures, `改了标题没改导航，⑦B 却没红：\n${failures.join("\n")}`).toHaveLength(1);
      expect(failures[0] ?? "", "⑦B 红了却没点名是哪一个锚点落空").toContain(dead);
    });
  }

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
/**
 * ── 「每语言一个 token」这套锚的两个纯判据（模块作用域）─────────────────────
 *
 * ⚠️ **它们住在模块作用域，不住在某一个 `describe` 里**：Task 28 那一组与
 * Task 31A 那一组用的是同一套锚，各抄一份的话两边的口径会各自漂，
 * 而其中一份坏了另一份不会响——本文件对「第二份实现」的既有裁决。
 */
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


  it.each([...TABLES])("$label：五份 DEPLOY.md 各自写着自己那种语言的写法，且不串门", ({ label, table }) => {
    const failures = perLangTokenFailures(label, table, realDoc("DEPLOY"));
    expect(failures, failures.join("\n")).toEqual([]);
  });


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

/**
 * ── P3e Task 29：推公开仓之前第一个访客会看到的三处「空白 / 假话」各自上锚 ────────
 *
 * 这三处是同一族毛病：**十二道门禁全绿，而文字说的是假的、或者干脆什么都没说。**
 *
 * · `admin-ui/README.md` 末尾原来写着「## P3a 的范围 —— 只有登录闸和一个空壳，
 *   `i18n` 字典、`theme.js` / `ui.js` / `api.js` 与 8 个功能板块都在 P3b 起」。
 *   那句话在 P3b 落地当天就过期了，却一路活到 P3e。**没人守是有原因的**：
 *   `scripts/check-comment-refs.mjs` 这道门禁的 `SCAN_DIRS` 虽然含 `admin-ui`，但它的
 *   `walk()` 只收 `.ts` / `.js` / `.mjs` —— 这份 `.md` **从来没被任何机器看过一眼**。
 * · `CHANGELOG.md` 全文只有一个 `## [Unreleased]`，而**六份 README 的版本徽章都链到它**
 *   （Task 27 的 ③ 那一格盯的是徽章上的版本号，盯不到链接落地之后是不是一张白纸）。
 * · `package.json` 的 `description` / `author` / `keywords` 三格全空，没有
 *   `repository` / `homepage` / `bugs` —— npm 与 GitHub 的元信息卡片直接读这几格。
 *
 * ── 需求书里那条被实测判定为**死断言**的期望（发现不符先实测再决定）──────────────
 * Task 29 需求书的第二格原样写着：
 *
 *     const head = log.slice(0, log.indexOf(`## [${v}]`) === -1 ? log.length : log.indexOf(`## [${v}]`));
 *     expect(head.includes(v) && !head.includes("[Unreleased]"), "版本号只出现在 [Unreleased] 下").toBe(false);
 *
 * 它想挡的是「版本号只在 `[Unreleased]` 底下露过脸、没有自己的条目」。**实测下来它一枪都放不出去**：
 * Keep a Changelog 的排版里 `## [Unreleased]` 永远排在版本条目之前，于是 `head` 必然包含
 * `[Unreleased]`，`!head.includes("[Unreleased]")` 恒为假，整个合取恒为假 ⇒ 这一格**恒绿**。
 * 连它自己想抓的那个坏样本（CHANGELOG 里只有 `## [Unreleased]`、正文里提了一句 `0.1.0`）
 * 也照样恒绿：那时 `indexOf` 返回 -1、`head` 是全文、`[Unreleased]` 还在里面。
 * 三种情形都实跑过（红/绿见 task-29-report.md 的变异表 M2b）。
 * ⇒ 换成**会自己红**的写法：条目必须存在，且**正文里至少有一条 `- `**（徽章点进来不许是空壳）。
 *
 * ── 它能做到什么 ────────────────────────────────────────────────────────────
 * 板块那一格的判据**只有一个真源**：`admin-ui/index.html` 的 `data-section`。加一个板块、
 * 删一个板块、改一个板块的名字，而不改 `admin-ui/README.md` 那张表 ⇒ 当场红并**点名那个板块**。
 * `CHANGELOG` 与 `package.json` 两格同理：期望值分别从 `VERSION`、`PROTOCOLS`、
 * `data-section`、根 `README.md` 的 clone 地址、`LICENSE` 的版权行现算，**一个字面量都不手抄**。
 *
 * ── 复评回填（RX1 / RX7 / RX8 与两句新写的假话）──────────────────────────────
 * 第一版落地之后的复评实测抓到四件事，全部在这一组里补上，都记在这里免得再犯：
 * · **「删一个板块也点名」当时是假的**（RX1）：判据只从 `data-section` 单向查 README 那张表，
 *   板块删了、表里那一行还在，**没有任何一格看得见它**。修法：这张表与 `data-section`
 *   **双向**比集合——表里多一行、少一行都点名那一行。
 * · **主格的下限是硬编码的 `8`**（RX8）：把一个板块从 `index.html`、README 那张表、CHANGELOG
 *   三处一致地删干净之后这一格仍然红，报文写的是「一个 data-section 都没扫到，正则多半写坏了」
 *   ——而实际扫到了 7 个，**这句报文是假的**，照它去改正则是白改。**报文可以亲手把人引进坑**。
 *   修法是把下限改成「一个都没扫到才吵」（那才是「正则写坏了」的真形态），板块数由上面
 *   那条双向集合判据管。
 *   ⚠️ **回填时顺带实测出来的一件事**：删一个板块要动的地方**不止那三处**——两份板块文件
 *   （`js/sec-<板块>.js` / `js/pure/<板块>.mjs`）、五份 `docs/<lang>/ADMIN.md` 的板块速查表
 *   也都得跟着删。把这些一起改干净之后本文件 238 格全绿（回填实测 MR2b），**唯一还红的**
 *   是本文件上面「五份 ADMIN.md 的措辞与数字守卫」那一组里把 `data-section="models"`
 *   写死当变异靶子的那一格：靶子没了它会大声说「变异没落到 index.html 上——这一格控制是空的」。
 *   那是**认不出就吵**、不是假绿，留给真的要删板块的那次任务改，这里不动它。
 * · **`admin-ui/README.md` 里那两串共用件枚举没有完备性判据**（RX7）：往 `js/pure/` 里
 *   新加一份文件而不改 README，227 格全绿。修法：`admin-ui/js/` 与 `admin-ui/js/pure/`
 *   目录里的每一份 `.js` / `.mjs` 都必须在 README 里露过面。
 * · **CHANGELOG 自己新写了两句假话**：①「KV 上的池索引与取号」——Docker 形态下没有 KV
 *   （`src/entry/node.ts` 用 `FileStorage`），与 Task 28 刚修掉的那句同型；②「上游一个都
 *   用不上时回 503」——同步档耗尽预算那一种是 504。修法：两句都改真，并各配一条**从真源
 *   现算**的判据（存储实现从两个 entry 的 import 现算、两个状态码从 `dispatcher.ts` 现算）。
 * 顺带把 CHANGELOG 里剩下的手抄清单也接上真源：协议的括号标签必须是 `PROTOCOLS[].label`
 * 的子串、六份文档名单与 `DOCS` 逐项对齐、门禁那一串短名逐个是 `ci.yml` 里对应那一步
 * 名字的子串（顺序也是那边的顺序）。
 *
 * ── 它做不到什么（明写）────────────────────────────────────────────────────
 * · 板块那一格只比 **code span 在不在**，不比那一行说得对不对：把 `overview` 那一行的
 *   中文名从「概览」改成「设置」，八个 span 一个不少 ⇒ **全绿**。行内的中文名今天没有机器判据。
 * · `CHANGELOG` 那一格只要求条目**非空**，不看正文写的是不是这一版真的做过的事：
 *   把 `0.1.0` 的正文整段换成一句「- 修了个错别字」⇒ 除了协议 / 板块那一格点名的
 *   几个 code span 之外，**结构判据一个字都不吭**。
 * · `package.json` 那一格只比字符串**逐字相等**，管不到那个 GitHub 仓库是不是真的存在、
 *   是不是公开的 —— 那要联网，本仓的测试一律不联网。
 * · 这三格全都**只在 Node 下跑**（`tests/unit/`）。它们判的是仓库里的静态文本，
 *   与运行时无关，所以这里刻意不进 `tests/contract/`。
 */
/** 本组的名字。`admin-ui/README.md` 点名它，下面那一格拿这个常量回头去 README 里找——
 *  改了组名而 README 没跟着改，当场红。这样 README 里那句「有机器守了」自己也有测法。 */
const TASK29_GROUP = "推公开仓之前第一个访客会看到的三份自述（P3e Task 29）";

describe(TASK29_GROUP, () => {
  const readReal = (p: string) => readFileSync(p, "utf8");
  const realIndexHtml = () => readReal("admin-ui/index.html");
  const realPanelReadme = () => readReal("admin-ui/README.md");
  const realChangelog = () => readReal("CHANGELOG.md");

  /**
   * 板块清单的**唯一真源**。去重是有意的：同一个板块被两个按钮指向（比如概览卡上再来一个
   * 快捷入口）是合法改动，不该让下面任何一格红——「不乱红」那一格钉的正是这条。
   */
  const sectionsOf = (html: string) => [...new Set([...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]!))];

  /**
   * `admin-ui/README.md` 那张板块表的第一列（`data-section` 那一列）。
   * **认不出返回 `null`**（表头找不到、或者表里某一行第一列不是 code span），绝不返回空数组：
   * 返回空数组会让下面那条「表里多一行就点名」的判据在正则瞎掉时静静地全绿。
   */
  const readmeTableSections = (readme: string): string[] | null => {
    const lines = readme.split("\n");
    const head = lines.findIndex((l) => l.startsWith("| `data-section` |"));
    if (head < 0) return null;
    const out: string[] = [];
    for (let i = head + 2; i < lines.length && lines[i]!.startsWith("|"); i += 1) {
      const m = /^\|\s*`([^`]+)`\s*\|/.exec(lines[i]!);
      if (m === null) return null;
      out.push(m[1]!);
    }
    return out.length === 0 ? null : out;
  };

  /**
   * 每个板块要过四关：`admin-ui/README.md` 里三个 code span（板块名 / 挂载文件 / 纯逻辑文件）、
   * 那两份文件真的在、`admin-ui/js/i18n-dict.js` 里有 `nav.<板块>` 这个 key
   *（README 里「`i18n` 字典按它取 `nav.*` 文案」那句话的测法）。
   * **外加那张表与 `data-section` 双向比集合**——复评 RX1 实测：只有上面那几条单向判据时，
   * 「删一个板块、表里那一行还留着」**没有任何一格看得见**，而 README 与本文件都写着
   * 「删一个板块…当场点名那个板块」。
   * **真扫描与该红时红共用这一份**，两个 `read` 是仅有的注入点。
   */
  const panelDocFailures = (readHtml: () => string, readReadme: () => string): string[] => {
    const readme = readReadme();
    const dict = readReal("admin-ui/js/i18n-dict.js");
    const out: string[] = [];
    const sections = sectionsOf(readHtml());
    const rows = readmeTableSections(readme);
    if (rows === null) {
      out.push("admin-ui/README.md 里认不出那张板块表（`| \\`data-section\\` |` 开头那一行，"
        + "以及它下面每一行的第一列 code span）—— 认不出要吵，不是这份文件很干净");
    } else {
      for (const r of rows) {
        if (!sections.includes(r)) {
          out.push(`板块表里有 \`${r}\` 这一行，admin-ui/index.html 里却没有 data-section="${r}" `
            + "—— 板块删了 / 改名了，这张表没跟着改");
        }
      }
      for (const s of sections) {
        if (!rows.includes(s)) {
          out.push(`板块 ${s}：admin-ui/index.html 里真的有 data-section="${s}"，`
            + "admin-ui/README.md 那张表里却没有它这一行");
        }
      }
    }
    for (const s of sections) {
      const mount = `js/sec-${s}.js`;
      const pure = `js/pure/${s}.mjs`;
      for (const span of [s, mount, pure]) {
        if (!readme.includes(`\`${span}\``)) {
          out.push(`板块 ${s}：admin-ui/index.html 里真的有 data-section="${s}"，`
            + `admin-ui/README.md 里却没有 \`${span}\` 这个 code span`);
        }
      }
      for (const rel of [mount, pure]) {
        if (!existsSync(`admin-ui/${rel}`)) {
          out.push(`板块 ${s}：admin-ui/README.md 那张表指着 admin-ui/${rel}，这个文件不在`);
        }
      }
      if (!dict.includes(`"nav.${s}"`)) {
        out.push(`板块 ${s}：admin-ui/js/i18n-dict.js 里没有 "nav.${s}" 这个 key —— 导航按钮取不到文案`);
      }
    }
    return out;
  };

  /** 每一格「该红时红」的统一前置：基取自真文件，真文件本身就不过判据时当场抛并把人指回主格。 */
  const probeBase = (failures: readonly string[], mainCell: string) => {
    if (failures.length > 0) {
      throw new Error("本格是探针，它的基取自真文件，而真文件今天本身就不过判据 —— "
        + `别从这一格的报文里找原因，真因在「${mainCell}」那一格：\n${failures.join("\n")}`);
    }
  };

  const PANEL_CELL = "admin-ui/README.md 提到 index.html 里的每一个板块（板块名 / 挂载 / 纯逻辑三个 code span）";

  it(PANEL_CELL, () => {
    const sections = sectionsOf(realIndexHtml());
    // ⚠️ 这里**只挡「正则一个都没扫到」**。第一版写的是 `toBeGreaterThanOrEqual(8)`——那个 8 是
    // 本组唯一没从真源现算的数，复评 RX8 实测它会把「三处一致地删掉一个板块」这样一次
    // **完全正确**的改动拦下，报文还写「一个 data-section 都没扫到」（当时扫到了 7 个）。
    // 板块数不该在这里定死：多一个少一个由上面那条「表与 data-section 双向比集合」管。
    expect(sections.length, "admin-ui/index.html 里一个 data-section 都没扫到 —— 这条正则多半写坏了")
      .toBeGreaterThan(0);
    const failures = panelDocFailures(realIndexHtml, realPanelReadme);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红：index.html 多出一个 data-section=\"foo\" 而 README 没跟着改 —— 逐条点名 foo", () => {
    probeBase(panelDocFailures(realIndexHtml, realPanelReadme), PANEL_CELL);
    const mutated = `${realIndexHtml()}\n<button class="nav-item" data-section="foo">foo</button>\n`;
    expect(sectionsOf(mutated), "变异没落地——mutated 里没扫出 foo").toContain("foo");
    const failures = panelDocFailures(() => mutated, realPanelReadme);
    // 表里没有 foo 那一行 + 三个 span 都缺 + 两份文件都不在 + 字典里没有 nav.foo = 7 条，
    // 条条点名 foo；真板块一条都不许被带红。
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(7);
    for (const f of failures) expect(f, `这一条没点名 foo：${f}`).toContain("foo");
  });

  it("该红时红（复评 RX1）：index.html 里删掉一个板块而 README 那张表没跟着删 —— 点名表里多出来的那一行", () => {
    probeBase(panelDocFailures(realIndexHtml, realPanelReadme), PANEL_CELL);
    const sections = sectionsOf(realIndexHtml());
    // 删哪一个不写死：取真源里的最后一个板块，加板块 / 改名时这一格自己跟着走。
    const gone = sections[sections.length - 1]!;
    const mutated = realIndexHtml().split("\n").filter((l) => !l.includes(`data-section="${gone}"`)).join("\n");
    expect(sectionsOf(mutated), `变异没落地——mutated 里还扫得出 ${gone}`).not.toContain(gone);
    expect(sectionsOf(mutated), "变异把别的板块也一起删了——这一格测的就不是「删一个」了")
      .toEqual(sections.filter((s) => s !== gone));
    const failures = panelDocFailures(() => mutated, realPanelReadme);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", `红了但报文没点名被删掉的那个板块 ${gone}`).toContain(gone);
  });

  it("不乱红：同一个板块被第二个按钮指向 + README 合法地多提一次板块名 —— 都不许让上面那一格红", () => {
    // ⚠️ 这一句是 M1 实测补的：不加基探针时，真文件一脏这一格也会跟着红，而它的报文说的是
    // 「重复的 data-section 把这一格弄红了」——报文会亲手把人引到一个没坏的东西上。
    probeBase(panelDocFailures(realIndexHtml, realPanelReadme), PANEL_CELL);
    const dupHtml = `${realIndexHtml()}\n<button class="nav-item" data-section="overview">再来一个入口</button>\n`;
    expect(sectionsOf(dupHtml), "去重之后板块数不该变——这一格的前提没了")
      .toEqual(sectionsOf(realIndexHtml()));
    const extraReadme = () => `${realPanelReadme()}\n\n另见 \`overview\` 板块。\n`;
    expect(panelDocFailures(() => dupHtml, extraReadme),
      "重复的 data-section 或 README 里多写一次板块名把这一格弄红了").toEqual([]);
  });

  it("admin-ui/README.md 里指向仓内的每一条路径都真的在（check-comment-refs 只扫 .ts/.js/.mjs 的注释，够不着这份 .md）", () => {
    const readme = realPanelReadme();
    const local = [...readme.matchAll(/`(js\/[A-Za-z0-9_./-]+\.(?:js|mjs))`/g)].map((m) => m[1]!);
    const sections = sectionsOf(realIndexHtml());
    expect(local.length, `形如 \`js/…\` 的 code span 只扫到 ${local.length} 个，少于板块数 × 2 —— 这条正则多半瞎了`)
      .toBeGreaterThanOrEqual(sections.length * 2);
    expect(local.filter((p) => !existsSync(`admin-ui/${p}`)),
      "admin-ui/README.md 里这几条 `js/…` 指向的文件不在").toEqual([]);
    const repoPaths = [...readme.matchAll(/`((?:tests|scripts|src)\/[A-Za-z0-9_./-]+\.(?:ts|js|mjs))`/g)].map((m) => m[1]!);
    expect(repoPaths.length, "一条 `tests/…` / `scripts/…` / `src/…` 的 code span 都没扫到 —— 这条正则多半瞎了")
      .toBeGreaterThanOrEqual(3);
    expect(repoPaths.filter((p) => !existsSync(p)), "admin-ui/README.md 里这几条仓根路径指向的文件不在").toEqual([]);
    // README 里那句「上面那张表有机器守了」点的就是本组的名字。组名改了而 README 没跟着改 ⇒ 这里红。
    expect(readme, `admin-ui/README.md 里那句「有机器守了」点名的组名已经不是「${TASK29_GROUP}」了`)
      .toContain(TASK29_GROUP);
  });

  /**
   * `admin-ui/js/` 与 `admin-ui/js/pure/` 两个目录的**完备性**判据（复评 RX7 逼出来的）。
   *
   * README 里那两串共用件是手抄的：往 `js/pure/` 里新加一份真实形态的 `.mjs` 而不改 README，
   * 这一组当时 **227 格全绿**——「README 段落静静过期」正是本任务存在的理由，却在新表下方
   * 一段原样复发。这里只要求「露过面」（有 `` `js/xxx` `` 这个 code span），不要求出现在
   * 哪一串里：`js/boot.js` 在「其他约定」那一节、板块文件在那张表里，都算数。
   *
   * **认不出要吵**：目录读出来一份都没有时当场红，而不是「零个文件全都露过面」式的假绿。
   * `listFiles` 是唯一的注入点，真扫描与该红时红共用这一份。
   */
  const PANEL_FILES_CELL = "admin-ui/js/ 与 js/pure/ 目录里的每一份 .js / .mjs 都在 admin-ui/README.md 里露过面";
  const realPanelFiles = (): string[] => {
    const listed = (dir: string) => readdirSync(`admin-ui/${dir}`)
      .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
      .map((f) => `${dir}/${f}`);
    return [...listed("js"), ...listed("js/pure")];
  };
  const panelFileFailures = (listFiles: () => string[], readReadme: () => string): string[] => {
    const files = listFiles();
    if (files.length === 0) return ["admin-ui/js 下一个 .js / .mjs 都没读到 —— readdir 多半指错了目录，不是面板空了"];
    const readme = readReadme();
    return files
      .filter((p) => !readme.includes(`\`${p}\``))
      .map((p) => `admin-ui/${p} 真的在，admin-ui/README.md 里却一次都没提到 \`${p}\` —— 手抄的枚举又过期了`);
  };

  it(PANEL_FILES_CELL, () => {
    const failures = panelFileFailures(realPanelFiles, realPanelReadme);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红（复评 RX7）：js/pure/ 下多一份共用纯逻辑而 README 那串枚举不改 —— 点名那一份", () => {
    probeBase(panelFileFailures(realPanelFiles, realPanelReadme), PANEL_FILES_CELL);
    const added = "js/pure/zzz.mjs";
    expect(existsSync(`admin-ui/${added}`), `${added} 今天真的存在，这一格的变异就不是「多一份」了`).toBe(false);
    const failures = panelFileFailures(() => [...realPanelFiles(), added], realPanelReadme);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没点名多出来的那一份").toContain(added);
  });

  /** 取 CHANGELOG 的 `## [x]` 一节（含标题行）。**认不出返回 `null`**，绝不返回空数组。 */
  const logSection = (body: string, tag: string): string[] | null => {
    const lines = body.split("\n");
    const i = lines.findIndex((l) => l.startsWith(`## [${tag}]`));
    if (i < 0) return null;
    let j = i + 1;
    while (j < lines.length && !lines[j]!.startsWith("## ")) j += 1;
    return lines.slice(i, j);
  };

  /** 真扫描与该红时红**共用这一份**，`read` 是唯一的注入点。 */
  const changelogFailures = (v: string, read: () => string): string[] => {
    const body = read();
    const tags = [...body.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]!);
    if (tags.length === 0) return ["CHANGELOG.md 里一个 `## [...]` 小节都没扫到 —— 判据多半瞎了，不是这份文件很干净"];
    const out: string[] = [];
    if (!tags.includes("Unreleased")) out.push("CHANGELOG.md 没有 `## [Unreleased]` —— Keep a Changelog 的结构塌了");
    const sec = logSection(body, v);
    if (sec === null) {
      out.push(`CHANGELOG.md 里没有 ${v} 的条目 —— 六份 README 的版本徽章都链到这份文件`);
      return out;
    }
    if (!sec.slice(1).some((l) => l.startsWith("- "))) {
      out.push(`CHANGELOG.md 的 \`## [${v}]\` 只有标题、正文里一条 \`- \` 都没有 —— 徽章点进来是一张空条目`);
    }
    return out;
  };

  const CHANGELOG_CELL = "VERSION 里的版本号在 CHANGELOG 里有自己的一条非空条目";
  const realVersion = () => readReal("VERSION").trim();

  it(CHANGELOG_CELL, () => {
    const v = realVersion();
    expect(v, "VERSION 是空的，这一格会拿空串去比，测的是空气").not.toEqual("");
    const failures = changelogFailures(v, realChangelog);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红（M2）：CHANGELOG 里那条版本条目的标题被改掉 —— 点名 VERSION 里的那个版本号", () => {
    const v = realVersion();
    probeBase(changelogFailures(v, realChangelog), CHANGELOG_CELL);
    const mutated = realChangelog().split(`## [${v}]`).join(`## [${v}-gone]`);
    expect(mutated, `变异没落地——CHANGELOG.md 里没找到 \`## [${v}]\``).not.toEqual(realChangelog());
    const failures = changelogFailures(v, () => mutated);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没点名那个版本号").toContain(v);
  });

  it("该红时红（M2b）：条目还在但正文被掏空 —— 这正是需求书那条恒绿断言放不出的那一枪", () => {
    const v = realVersion();
    probeBase(changelogFailures(v, realChangelog), CHANGELOG_CELL);
    const real = realChangelog();
    const sec = logSection(real, v);
    expect(sec, "取节认不出真 CHANGELOG 的版本条目——这一格的前提没了").not.toBeNull();
    const mutated = real.replace(sec!.join("\n"), sec![0]!);
    expect(mutated, "变异没落地——正文没被掏空").not.toEqual(real);
    expect(logSection(mutated, v), "掏空之后标题还得在，否则这一格测的是 M2 而不是 M2b").not.toBeNull();
    const failures = changelogFailures(v, () => mutated);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没说清是「空条目」").toContain("空条目");
  });

  it("不乱红：CHANGELOG 之后合法地多发一版（版本条目上面再压一条） —— 不许因此红", () => {
    const v = realVersion();
    probeBase(changelogFailures(v, realChangelog), CHANGELOG_CELL);
    const mutated = realChangelog().replace(`## [${v}]`, `## [9.9.9] - 2099-01-01\n\n- 未来的一次发版。\n\n## [${v}]`);
    expect(mutated, "变异没落地").not.toEqual(realChangelog());
    expect(changelogFailures(v, () => mutated), "多压一条新版本条目把这一格弄红了").toEqual([]);
  });

  /**
   * 中文数字 0–20。CHANGELOG 那条版本条目里写下的**每一个**计数都从这张表现算，
   * **超出范围返回 `undefined`**，下面那一格当场吵——不悄悄回退成阿拉伯数字。
   */
  const CN = [
    "零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
    "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  ] as const;

  /**
   * 一个计数在中文里可接受的写法。**「2」这一条是实测逼出来的**：第一版只认 `CN[n]`，
   * 于是「二条临时邮箱通道」找不到而 CHANGELOG 里写的是「**两**条临时邮箱通道」——
   * 汉语里量词前的 2 写「两」不写「二」。这不是给判据开豁免（两种写法都是对的，
   * 只是同一个数的两种字面），所以放宽的是**字面表**、不是那个数。
   */
  const cnForms = (n: number): readonly string[] | null => {
    const base = CN[n];
    if (base === undefined) return null;
    return n === 2 ? [base, "两"] : [base];
  };

  /** CI 里门禁的总道数：从 `.github/workflows/ci.yml` 的 `- name: n/总数` 现算，不手抄。 */
  const ciGateTotal = (): number | null => {
    const totals = [...readReal(".github/workflows/ci.yml").matchAll(/^\s*- name: \d+\/(\d+) /gm)].map((m) => Number(m[1]));
    if (totals.length === 0) return null;
    return totals.every((t) => t === totals[0]) ? totals[0]! : null;
  };

  it("CHANGELOG 的版本条目逐条点名协议 / 板块 / 通道，且它写下的每一个中文计数都从真源现算", () => {
    const v = realVersion();
    const sec = logSection(realChangelog(), v);
    expect(sec, `CHANGELOG.md 里没有 ${v} 的条目`).not.toBeNull();
    const text = sec!.join("\n");
    const sections = sectionsOf(realIndexHtml());
    // ── 逐条点名：加一条协议 / 一个板块 / 一条通道而不改 CHANGELOG ⇒ 当场点名它 ──
    for (const p of PROTOCOLS) expect(text, `版本条目里没点名协议 \`${p.id}\``).toContain(`\`${p.id}\``);
    for (const s of sections) expect(text, `版本条目里没点名板块 \`${s}\``).toContain(`\`${s}\``);
    for (const c of CHANNELS) expect(text, `版本条目里没点名注册机通道 \`${c}\``).toContain(`\`${c}\``);
    for (const l of LANGS) expect(text, `版本条目里没点名语言 \`${l}\``).toContain(`\`${l}\``);
    // ── 五个中文计数，逐个从真源现算 ──
    const gates = ciGateTotal();
    expect(gates, ".github/workflows/ci.yml 里的 `- name: n/总数` 要么一条都没扫到、要么总数彼此不一致 —— 认不出要吵")
      .not.toBeNull();
    const counts: ReadonlyArray<readonly [number, string, string]> = [
      [PROTOCOLS.length, "协议网关", "PROTOCOLS"],
      [sections.length, "个板块", "admin-ui/index.html 的 data-section"],
      [CHANNELS.length, "条临时邮箱通道", "CHANNELS"],
      [gates ?? -1, "道门禁", ".github/workflows/ci.yml 的 `- name: n/总数`"],
      [LANGS.length, "语言", "LANGS"],
      [LANGS.length, "份", "LANGS"],
    ];
    for (const [n, suffix, source] of counts) {
      const forms = cnForms(n);
      expect(forms, `${source} 现在算出 ${n}，超出这张中文数字表 —— 认不出要吵，不许静静放行`).not.toBeNull();
      const wanted = forms!.map((f) => `${f}${suffix}`);
      expect(wanted.some((w) => text.includes(w)),
        `CHANGELOG 那条版本条目里没有「${wanted.join("」/「")}」（${source} 现算是 ${n}）`).toBe(true);
    }
  });

  /**
   * 两个运行时入口各自选的存储实现，从 `src/entry/*.ts` 的 import 现算。**认不出返回 `null`**。
   *
   * 这一条是复评抓到的第一句假话的测法：CHANGELOG 第一版写「**KV 上的**池索引与取号」，
   * 而同一条版本条目开头刚说「同一份代码同时跑 Cloudflare Worker 与 Node / Docker 两种运行时」
   * —— Docker 形态下没有 KV（`src/entry/node.ts` 用的是 `FileStorage`）。
   * 与 Task 28 刚修掉的「Docker 侧那句假话」同型，**修一处前得先查修法有没有把别处的问题搬回来**。
   */
  const entryStorages = (read: (p: string) => string = readReal): ReadonlyArray<readonly [string, string]> | null => {
    const out: Array<readonly [string, string]> = [];
    for (const entry of ["worker", "node"]) {
      const m = /import \{ (\w+Storage) \} from "\.\.\/adapters\/storage-[\w-]+\.js";/.exec(read(`src/entry/${entry}.ts`));
      if (m === null) return null;
      out.push([entry, m[1]!] as const);
    }
    return out;
  };

  /** 池子整体不可用 / 同步档耗尽预算这两种兜底响应的状态码，从 `src/core/dispatcher.ts` 现算。 */
  const dispatcherStatuses = (read: (p: string) => string = readReal): readonly [number, number] | null => {
    const src = read("src/core/dispatcher.ts");
    const pool = /function fail\([\s\S]*?status: (\d{3})/.exec(src)?.[1];
    const sync = /function syncBudgetExhausted\([\s\S]*?jsonBody\((\d{3})/.exec(src)?.[1];
    if (pool === undefined || sync === undefined || pool === sync) return null;
    return [Number(pool), Number(sync)] as const;
  };

  const storageFailures = (readLog: () => string): string[] => {
    const v = realVersion();
    const sec = logSection(readLog(), v);
    if (sec === null) return [`CHANGELOG.md 里没有 ${v} 的条目 —— 这一格无从判起`];
    const text = sec.join("\n");
    const st = entryStorages();
    if (st === null) {
      return ["src/entry/{worker,node}.ts 里认不出 `import { XxxStorage } from \"../adapters/storage-*.js\"` "
        + "—— 认不出要吵，不是 CHANGELOG 写对了"];
    }
    const out: string[] = [];
    const named = [...new Set([...text.matchAll(/`(\w+Storage)`/g)].map((m) => m[1]!))].sort();
    const want = [...new Set(st.map(([, cls]) => cls))].sort();
    for (const [entry, cls] of st) {
      if (!named.includes(cls)) {
        out.push(`src/entry/${entry}.ts 用的是 \`${cls}\`，CHANGELOG 那条版本条目里一次都没提到它`
          + " —— 两种运行时的存储形态不许只写一种");
      }
    }
    for (const cls of named) {
      if (!want.includes(cls)) {
        out.push(`CHANGELOG 那条版本条目里写着 \`${cls}\`，而两个运行时入口现算用的是 ${want.join(" / ")}`
          + " —— 这个存储实现已经没人用了");
      }
    }
    const codes = dispatcherStatuses();
    if (codes === null) {
      out.push("src/core/dispatcher.ts 里认不出 `fail()` 的 503 与 `syncBudgetExhausted()` 的 504"
        + "（或者两者取到了同一个数）—— 认不出要吵");
    } else {
      for (const c of codes) {
        if (!text.includes(String(c))) {
          out.push(`CHANGELOG 那条版本条目里没写状态码 ${c}（src/core/dispatcher.ts 现算）`
            + " —— 「一个都用不上时回 503」这句全称句漏掉了同步档那一种");
        }
      }
    }
    return out;
  };

  const STORAGE_CELL = "CHANGELOG 里的存储形态与兜底状态码都从 src/entry/*.ts、src/core/dispatcher.ts 现算";

  it(STORAGE_CELL, () => {
    const failures = storageFailures(realChangelog);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红：CHANGELOG 把 Node / Docker 那一半存储删掉（只剩 KV 那句）—— 点名 src/entry/node.ts 用的那个实现", () => {
    probeBase(storageFailures(realChangelog), STORAGE_CELL);
    const st = entryStorages();
    expect(st, "认不出两个入口的存储实现——这一格的前提没了").not.toBeNull();
    const nodeCls = st!.find(([entry]) => entry === "node")![1];
    const mutated = realChangelog().split(`\`${nodeCls}\``).join("那一份");
    expect(mutated, `变异没落地——CHANGELOG 里没找到 \`${nodeCls}\``).not.toEqual(realChangelog());
    const failures = storageFailures(() => mutated);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没点名 src/entry/node.ts").toContain("src/entry/node.ts");
  });

  it("该红时红：CHANGELOG 把 504 那半句删掉 —— 点名从 dispatcher.ts 现算出来的那个状态码", () => {
    probeBase(storageFailures(realChangelog), STORAGE_CELL);
    const codes = dispatcherStatuses();
    expect(codes, "认不出两个兜底状态码——这一格的前提没了").not.toBeNull();
    const gone = codes![1];
    const mutated = realChangelog().split(String(gone)).join("五百多");
    expect(mutated, `变异没落地——CHANGELOG 里没找到 ${gone}`).not.toEqual(realChangelog());
    const failures = storageFailures(() => mutated);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没点名那个状态码").toContain(String(gone));
  });

  /** `.github/workflows/ci.yml` 里每一步的名字（去掉 `n/总数 ` 前缀），按 yml 里的顺序。
   *  **序号不是 1..N 连号、或者总数彼此不一致 ⇒ 返回 `null`**，调用方当场吵。 */
  const ciGateNames = (read: (p: string) => string = readReal): string[] | null => {
    const rows = [...read(".github/workflows/ci.yml").matchAll(/^\s*- name: (\d+)\/(\d+) (.+)$/gm)]
      .map((m) => ({ idx: Number(m[1]), total: Number(m[2]), title: m[3]!.trim() }));
    if (rows.length === 0) return null;
    return rows.every((r, i) => r.idx === i + 1 && r.total === rows.length) ? rows.map((r) => r.title) : null;
  };

  /** CHANGELOG 里门禁那一串短名（`**CI …门禁**：` 与 `——` 之间、按 `、` 切）。认不出返回 `null`。 */
  const changelogGateItems = (text: string): string[] | null => {
    const m = /\*\*CI [^*]*\*\*：([\s\S]*?)——/.exec(text);
    if (m === null) return null;
    const items = m[1]!.split("、").map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s !== "");
    return items.length === 0 ? null : items;
  };

  it("CHANGELOG 里那三串手抄清单（协议括号标签 / 六份文档 / 十三道门禁）逐项对齐真源", () => {
    const sec = logSection(realChangelog(), realVersion());
    expect(sec, `CHANGELOG.md 里没有 ${realVersion()} 的条目`).not.toBeNull();
    const text = sec!.join("\n");
    // ① 协议后面那个括号标签必须是 `PROTOCOLS[].label` 的子串（真源写 "Google Gemini generateContent"，
    //    这里写 "generateContent" 是合法的省写；写成别的协议的名字 / 一个不存在的名字则红）。
    for (const p of PROTOCOLS) {
      const m = new RegExp(`\`${p.id}\`（([^）]+)）`).exec(text);
      expect(m, `版本条目里 \`${p.id}\` 后面没有「（协议名）」那个括号标签`).not.toBeNull();
      expect(p.label.includes(m![1]!),
        `版本条目里 \`${p.id}\` 的括号标签写的是「${m![1]}」，PROTOCOLS 里那条的 label 是「${p.label}」`
        + "—— 不是它的子串").toBe(true);
    }
    // ② 六份文档的名单与 `DOCS` 这张真源表逐项对齐（多一份少一份都红）。
    const docsList = /文档（([^）]+)）/.exec(text);
    expect(docsList, "版本条目里认不出「文档（… / … / …）」那一串名单").not.toBeNull();
    expect(docsList![1]!.split("/").map((s) => s.trim()).sort(), "CHANGELOG 里那串文档名单与 DOCS 对不上")
      .toEqual([...DOCS].sort());
    // ③ 门禁那一串短名逐个是 ci.yml 里对应那一步名字的子串，顺序也是那边的顺序。
    const names = ciGateNames();
    expect(names, ".github/workflows/ci.yml 里的 `- name: n/总数 …` 认不出，或者序号不是 1..N 连号 —— 认不出要吵")
      .not.toBeNull();
    const items = changelogGateItems(text);
    expect(items, "版本条目里认不出门禁那一串短名（`**CI …门禁**：` 与 `——` 之间那一段）").not.toBeNull();
    expect(items!.length, `CHANGELOG 里门禁那一串写了 ${items!.length} 个短名，ci.yml 现算是 ${names!.length} 步`)
      .toBe(names!.length);
    items!.forEach((item, i) => {
      expect(names![i]!.includes(item),
        `门禁那一串的第 ${i + 1} 个短名写的是「${item}」，ci.yml 第 ${i + 1} 步叫「${names![i]}」—— 不是它的子串`)
        .toBe(true);
    });
  });

  /**
   * 「已知限制」那一节里那条**零真上游样本**的欠账。
   *
   * ⚠️ **这条欠账原来的登记位置是一份内部计划文档的「还欠着什么」小节**，
   * 那份文档已随全部内部设计文档移出本仓 ⇒ 欠账当时连登记的地方都没有了。
   * 它是一条**面向读者的限制说明**（谁拿协议目录去对上游，都该先知道它没被真上游验过），
   * 不是内部路线图，所以搬进了 `CHANGELOG.md` 的「已知限制」。
   * `tests/contract/protocol-catalog.test.ts` 那段文件头指的就是这里。
   *
   * ⚠️ **这一格不是「文档里有没有这句话」那么弱**：它同时从真源现算——
   * 哪天真的拿到了一份真上游样本、把某条事实的 `status` 改成 `verified`，
   * CHANGELOG 里这句话就成了假话，这一格当场红并逼人回来改文档。
   * 反过来把这一节从 CHANGELOG 里删掉也红。
   */
  it("CHANGELOG 的「已知限制」写着零真上游样本，而这句话从 `UPSTREAM_FACTS` 现算", () => {
    const body = realChangelog();
    expect(body, "CHANGELOG.md 里没有「已知限制」那一节 —— 那条欠账没有别的承载点了").toContain("### 已知限制");
    expect(body, "「已知限制」里那句「本仓至今零份真上游样本」不见了").toContain("本仓至今零份真上游样本");
    // 认不出要吵：一条事实都没有的话，下面那句「全是 assumed」是空集为真，等于没测。
    expect(UPSTREAM_FACTS.length, "`UPSTREAM_FACTS` 是空的 —— 这一格测的是空气").toBeGreaterThan(0);
    const verified = UPSTREAM_FACTS.filter((f) => f.status !== "assumed").map((f) => f.id);
    expect(verified,
      "这几条上游事实已经不是 `assumed` 了 —— CHANGELOG「已知限制」里那句"
      + "「本仓至今零份真上游样本」因此成了假话，回去把那一条改真（别把这一格删掉）：\n"
      + verified.join("\n")).toEqual([]);
  });

  it("凡是**加粗**写下「零构建」的地方都带着「挂在 `/admin/` 下」这个限定", () => {
    // admin-ui/README.md 用 23 行论证过：不带这个限定的说法是假的（`file://` 下绝对路径 404 + module CORS）。
    // 复评发现 6：CHANGELOG 第一版把那个被推翻过的说法以弱化形式写了回去，且无判据。
    for (const [path, body] of [["CHANGELOG.md", realChangelog()], ["admin-ui/README.md", realPanelReadme()]] as const) {
      const claims = body.split("\n").filter((l) => l.includes("**零构建**"));
      expect(claims.length, `${path} 里一句加粗的「零构建」都没有 —— 这一格测的是空气`).toBeGreaterThan(0);
      for (const l of claims) {
        expect(l, `${path} 里这句「零构建」没带上「挂在 /admin/ 下」这个限定：${l}`).toContain("/admin/");
      }
    }
  });

  /**
   * 五种语言在首屏语言切换行里的**自称**，从根 `README.md` 现算。认不出 / 数量对不上返回 `null`。
   *
   * ⚠️ P3f 阶段 5A 把首屏换成了模板的 HTML 头部块：切换行从 `**Language:** [English](…) | …`
   * 变成了 `📖 文档语言：<a href="docs/en/README.md">English</a> | …`。这里认的是**后者**——
   * 认不出就返回 `null` 并让调用方吵，不静静给出空数组。
   */
  const nativeLangLabels = (read: (p: string) => string = readReal): string[] | null => {
    const line = read("README.md").split("\n")
      .find((l) => l.includes("📖") && !l.trimStart().startsWith(">") && l.includes("README.md"));
    if (line === undefined) return null;
    const cells = line.replace(/^\s*📖[^：:]*[：:]\s*/, "").split("|").map((s) => s.trim()).filter((s) => s !== "");
    const labels = cells.map((c) => /^<a href="[^"]+">(.*)<\/a>$/.exec(c)?.[1]?.trim() ?? c);
    return labels.length === LANGS.length ? labels : null;
  };

  it("CHANGELOG 顶上那句语言提示逐个点名五种语言的自称（从根 README 的语言切换行现算）", () => {
    // 复评发现 7：六份 README 的版本徽章都链到这份 CHANGELOG，而它只有简体中文一份 ——
    // Task 29 之前那是一张空页，之后 en / ja / ko 的访客点进来看到的是整页中文。至少说清楚。
    const labels = nativeLangLabels();
    expect(labels, `根 README.md 的 \`**Language:**\` 那一行认不出，或者它列的语言数不是 ${LANGS.length} 种 —— 认不出要吵`)
      .not.toBeNull();
    const head = realChangelog().split("## [")[0]!;
    expect(head, "CHANGELOG 第一条版本条目之前没有那句语言提示").toContain("只有简体中文一份");
    for (const l of labels!) {
      expect(head, `CHANGELOG 顶上那句语言提示里没点名「${l}」—— 根 README 的语言切换行里有这一种`).toContain(l);
    }
  });

  it("CHANGELOG 里指向仓内的每一条路径都真的在（check-comment-refs 同样够不着这份 .md）", () => {
    const log = realChangelog();
    const paths = [...log.matchAll(/`((?:src|scripts|tests|admin-ui|docs|\.github)\/[A-Za-z0-9_./-]+\.(?:ts|js|mjs|md|yml))`/g)]
      .map((m) => m[1]!);
    expect(paths.length, "CHANGELOG.md 里一条仓内路径的 code span 都没扫到 —— 这条正则多半瞎了").toBeGreaterThanOrEqual(3);
    expect(paths.filter((p) => !existsSync(p)), "CHANGELOG.md 里这几条路径指向的文件不在").toEqual([]);
  });

  it("认不出要吵：本组几个「找不到就返回 null」的取数函数，在认不出时真的返回 null", () => {
    // 复评发现 9 记的是这几条分支只在手工变异里试过、没有常驻格。它们都会大声红、不会静静放行，
    // 但「会不会静静放行」这件事本身值一格：这几条一旦悄悄回退成空数组 / 0 / 空串，上面那些
    // 「一条都没扫到就吵」的报文就会变成假绿。
    expect(logSection("# 一条版本条目都没有\n", realVersion()), "logSection 认不出时没返回 null").toBeNull();
    expect(cnForms(CN.length), `cnForms 超出这张中文数字表（${CN.length} 起）时没返回 null`).toBeNull();
    expect(readmeTableSections("# 一张表都没有\n"), "readmeTableSections 认不出表头时没返回 null").toBeNull();
    const firstSection = sectionsOf(realIndexHtml())[0]!;
    expect(readmeTableSections(realPanelReadme().replace(`| \`${firstSection}\` |`, `| ${firstSection} |`)),
      "板块表里第一列不是 code span 时 readmeTableSections 没返回 null").toBeNull();
    expect(changelogGateItems("- 门禁那一条整段没了\n"), "认不出门禁那一串时 changelogGateItems 没返回 null").toBeNull();
    expect(changelogGateItems("- **CI 十三道门禁**：—— 一个短名都没写\n"),
      "门禁那一串一个短名都切不出来时没返回 null").toBeNull();
    expect(ciGateNames(() => "jobs:\n  ci:\n"), "ci.yml 里一步都认不出时 ciGateNames 没返回 null").toBeNull();
    expect(ciGateNames(() => "      - name: 1/2 甲\n      - name: 3/2 乙\n"),
      "ci.yml 的序号不连号时 ciGateNames 没返回 null").toBeNull();
    expect(entryStorages(() => "import { Whatever } from \"./x.js\";"), "认不出 entry 的存储实现时没返回 null").toBeNull();
    expect(dispatcherStatuses(() => "function fail() { status: 503 }"), "认不出 504 时没返回 null").toBeNull();
    expect(nativeLangLabels(() => "# 没有语言切换行\n"), "认不出语言切换行时没返回 null").toBeNull();
    expect(nativeLangLabels(() => '  📖 文档语言：<a href="docs/en/README.md">English</a> | <a href="docs/ja/README.md">日本語</a>\n'),
      "语言切换行只列了 2 种语言时没返回 null").toBeNull();
  });

  /** `package.json` 的元信息。期望值全部从 `README.md` / `LICENSE` 现算，这里不留第二份手抄。 */
  type Json = Record<string, unknown>;
  const dig = (o: Json, path: string): unknown =>
    path.split(".").reduce<unknown>((cur, k) => (cur !== null && typeof cur === "object" ? (cur as Json)[k] : undefined), o);

  const pkgMetaFailures = (readPkg: () => string): string[] => {
    const p = JSON.parse(readPkg()) as Json;
    const url = /git clone (https:\/\/github\.com\/\S+?)\.git/.exec(readReal("README.md"))?.[1] ?? null;
    if (url === null) return ["根 README.md 里找不到 `git clone https://github.com/….git` 那一行 —— 仓库 URL 的真源没了"];
    const holder = /Copyright \(c\) \d{4} (.+)/.exec(readReal("LICENSE"))?.[1]?.trim() ?? null;
    if (holder === null) return ["LICENSE 里找不到 `Copyright (c) <年> <署名>` 那一行 —— 署名的真源没了"];
    const out: string[] = [];
    for (const k of ["description", "author"]) {
      const got = p[k];
      if (typeof got !== "string" || got.trim() === "") out.push(`package.json 的 \`${k}\` 是空的 —— npm / GitHub 的元信息卡片直接读这一格`);
    }
    if (!Array.isArray(p.keywords) || p.keywords.length === 0) out.push("package.json 的 `keywords` 是空数组");
    if (p.author !== holder) out.push(`package.json 的 author 是「${String(p.author)}」，LICENSE 的版权人是「${holder}」—— 两处署名对不上`);
    // description / keywords 里那张协议清单也从 `PROTOCOLS` 现算：加一条协议而不改元信息 ⇒ 点名它。
    const desc = typeof p.description === "string" ? p.description.toLowerCase() : "";
    const kws = Array.isArray(p.keywords) ? p.keywords.map((k) => String(k).toLowerCase()) : [];
    for (const { id } of PROTOCOLS) {
      if (!desc.includes(id)) out.push(`package.json 的 description 没提协议 ${id}（PROTOCOLS 现算）`);
      if (!kws.includes(id)) out.push(`package.json 的 keywords 里没有协议 ${id}（PROTOCOLS 现算）`);
    }
    for (const [path, want] of [
      ["repository.url", `git+${url}.git`],
      ["homepage", `${url}#readme`],
      ["bugs.url", `${url}/issues`],
    ] as const) {
      const got = dig(p, path);
      if (got !== want) out.push(`package.json 的 \`${path}\` 是「${String(got)}」，按根 README.md 的 clone 地址现算应当是「${want}」`);
    }
    return out;
  };

  const PKG_CELL = "package.json 的元信息不是空表，且署名与仓库地址都与真源逐字一致";
  const realPkg = () => readReal("package.json");

  it(PKG_CELL, () => {
    const failures = pkgMetaFailures(realPkg);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红：author 被改成 LICENSE 版权人之外的名字 —— 点名两处署名", () => {
    probeBase(pkgMetaFailures(realPkg), PKG_CELL);
    const mutated = realPkg().replace(/"author": "[^"]*"/, '"author": "somebody-else"');
    expect(mutated, "变异没落地——package.json 里没找到 author 那一行").not.toEqual(realPkg());
    const failures = pkgMetaFailures(() => mutated);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没点名 LICENSE 侧的版权人").toContain("LICENSE");
  });

  it("该红时红：repository 指向另一个仓库 —— 点名从根 README 现算出来的那个地址", () => {
    probeBase(pkgMetaFailures(realPkg), PKG_CELL);
    const mutated = realPkg().replace("github.com/xwteam/agnes2api.git", "github.com/someone/other.git");
    expect(mutated, "变异没落地——package.json 的 repository.url 里没找到那个地址").not.toEqual(realPkg());
    const failures = pkgMetaFailures(() => mutated);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没点名 repository.url").toContain("repository.url");
  });

  it("不乱红：package.json 合法地多一个字段（`files`） —— 不许因此红", () => {
    probeBase(pkgMetaFailures(realPkg), PKG_CELL);
    const mutated = realPkg().replace('"keywords"', '"files": ["dist"],\n  "keywords"');
    expect(JSON.parse(mutated), "变异没落地——`files` 没进去").toHaveProperty("files");
    expect(pkgMetaFailures(() => mutated), "多一个无关字段把这一格弄红了").toEqual([]);
  });
});

/**
 * ── 「重置到底重置了什么」：九把存储键的封闭登记（P3e Task 30；P3f 改写成不读设计文档）─
 *
 * ⚠️⚠️ **这一组的期望源换过一次，换的理由必须留在这里，否则下一个人会把它改回去。**
 * 上一版的期望源是仓里一份内部设计文档「重置到底重置了什么」小节里那张逐键表；
 * 那份文档已随全部内部设计文档一起移出本仓。裁定是**不接受净损失**：
 * 这一组守的**不是**「代码与那份文档不许漂」（文档没了，那个风险跟着没了），
 * 而是**「新增一把存储键时不许被漏掉」**——那个风险一点没变。
 * 所以期望源搬到了两个仍然活着的东西上：
 * · **封闭登记 `RESET_LEDGER`**（就写在本文件里，九把键逐把表态，读者看得见）；
 * · **`src/http/admin/handlers/config.ts` 里那份重置实现本身**——`configResetHandler`
 *   真的写/删了哪几把键，从源码切片现扫，不手抄。
 *
 * ⚠️ **三格是互补不是重复，别合成一格**（与 Task 10「下标不变式与 EXPECTED 互补」同一条道理）：
 * · 第一格的输入是**手写的 `import` 清单** `KEYS` ⇒ 它管「封闭登记里有没有漏」；
 * · 第二格的输入是**源码扫描** ⇒ 它管「那张 `import` 清单自己有没有漏」；
 * · 第三格的输入是**重置实现的源码切片** ⇒ 它管「登记里那一列裁决与实现有没有分家」。
 * 合成一格之后，扫描写坏时它会静默恒绿——本仓 `--reporter=basic` 空跑那一族。
 *
 * ⚠️ **本组只钉「重置配置」这一条路径的裁决，刻意的。** 另外两条危险区路径
 *（清空 Key 池 / 重置用量统计）的**内容**不变式由这两格从行为侧钉着，标题里逐条点着
 * 「哪几类键的读回值不变」：`tests/contract/admin-danger.test.ts`
 * 「重置配置之后，key:* / pool:index / tend:history / usage:* / event:* 的读回值不变」，
 * 以及同一份文件的「清空 Key 池之后，config / tend:history / usage:* / event:* 的读回值不变」。
 * 本组补的是它们缺的那一半：**完备性**——新增一把键时有没有人回来表态。
 * 拿手抄的方式把另外两列也写进登记只会得到两列不会自己红的散文，那是待办不是守卫。
 */

/** 重置实现的真源文件。**路径写死在这里，扫描从它现读**——搬了文件这一组当场红。 */
const RESET_IMPL_FILE = join("src", "http", "admin", "handlers", "config.ts");
/** 重置实现的函数名。切片从它起，到下一个顶格 `export ` 为止。 */
const RESET_IMPL_FN = "export function configResetHandler(";

/**
 * 从真源 import 的存储键常量。**手写的是 import 列表，不是键名。**
 * 顺序与下面 `RESET_LEDGER` 一致，纯为对读方便；判据不看顺序。
 */
const KEYS: readonly string[] = [
  CONFIG_KEY,          // src/core/config-provenance.ts
  KEY_PREFIX,          // src/core/pool-index.ts
  POOL_INDEX_KEY,      // src/core/pool-index.ts
  USAGE_KEY_PREFIX,    // src/core/admin/usage-stats.ts
  EVENT_KEY_PREFIX,    // src/core/admin/event-ring.ts
  TEND_HISTORY_KEY,    // src/core/admin/tend-history.ts
  TEND_LOCK_KEY,       // src/http/admin/tend-lock.ts
  MANUAL_GUARD_KEY,    // src/core/admin/tend-guard.ts
  HEALTH_PROBE_KEY,    // src/core/storage-health.ts
];

/** 裁决的**封闭词表**：留白、写成「部分」「视情况」一律红。 */
const VERDICTS = ["动", "不动"] as const;
type ResetVerdict = (typeof VERDICTS)[number];

/**
 * **九把存储键 × 「重置配置」这条路径的封闭登记。**
 *
 * ⚠️ **`name` 是常量名，`key` 是从真源 import 的值。手写的只有 `name` / `verdict` / `why`。**
 * `key` 一律写成 import 进来的那个标识符，不许抄字面量——抄了之后改常量值这一组不会红。
 *
 * ⚠️ **`verdict` 那一列不是散文，它有测法**：下面第三格把「裁决是『动』的那几把」
 * 与「`configResetHandler` 源码切片里真的被 `put`/`delete` 的那几把」逐条比对。
 * 改了实现而没回来改这张表（或反过来）当场红。
 *
 * ⚠️ **新增一把存储键时这张表必须长一行**，否则第二格会点名那把键当场红。
 * 那正是这一组存在的全部理由——别把它删成一张只有九行的静态散文。
 */
const RESET_LEDGER: ReadonlyArray<{
  readonly name: string;
  readonly key: string;
  readonly verdict: ResetVerdict;
  readonly why: string;
}> = [
  {
    name: "CONFIG_KEY", key: CONFIG_KEY, verdict: "动",
    why: "面板那份存储配置本身。重置配置就是把它整把写回 `{}`（`RESET_VALUE`），"
      + "生效值回落到环境变量与内置默认值。这是这条路径**唯一**动的那一把。",
  },
  {
    name: "KEY_PREFIX", key: KEY_PREFIX, verdict: "不动",
    why: "key 池里每一条记录的键名前缀。重置配置一把 key 都不删——那是「清空 Key 池」"
      + "那颗按钮的事，两颗按钮的爆炸半径刻意不重叠。",
  },
  {
    name: "POOL_INDEX_KEY", key: POOL_INDEX_KEY, verdict: "不动",
    why: "key 池索引。同上，属于「清空 Key 池」那条路径。",
  },
  {
    name: "USAGE_KEY_PREFIX", key: USAGE_KEY_PREFIX, verdict: "不动",
    why: "用量统计分桶。属于「重置用量统计」那条路径。",
  },
  {
    name: "EVENT_KEY_PREFIX", key: EVENT_KEY_PREFIX, verdict: "不动",
    why: "事件环。它是审计痕迹：重置配置自己就要往里落一条 `config.reset`，"
      + "顺手把环清掉等于把刚留的痕迹一起抹了。",
  },
  {
    name: "TEND_HISTORY_KEY", key: TEND_HISTORY_KEY, verdict: "不动",
    why: "注册机养护历史。与那份配置不是同一件事，重置配置不碰它。",
  },
  {
    name: "TEND_LOCK_KEY", key: TEND_LOCK_KEY, verdict: "不动",
    why: "养护并发锁。**尤其不许顺手删**：删掉一把正被别人持有的锁 = 放两个养护进程同时跑。",
  },
  {
    name: "MANUAL_GUARD_KEY", key: MANUAL_GUARD_KEY, verdict: "不动",
    why: "手动养护的护栏标记。它是运维刚刚显式按下的意图，重置配置不代表撤销它。",
  },
  {
    name: "HEALTH_PROBE_KEY", key: HEALTH_PROBE_KEY, verdict: "不动",
    why: "存储健康探针写的那把键。它不属于任何一份业务状态，读写都由探针自己管。",
  },
];

/** 封闭登记的失败报文。**逐条点名**，不许只说「登记不对」。 */
function resetLedgerFailures(): string[] {
  const fails: string[] = [];
  // ⚠️ **先查 import 清单本身**：某个真源常量被改回字面量（或改了名）之后，`import` 拿到的是
  // `undefined`，而报文会变成「存储键 `undefined` 在登记里没有一行」——那句话会把人引去
  // 改登记，真因却在源码。`pnpm typecheck` 那道门禁同样会红，但这一格的报文得自己说得清楚。
  const broken = KEYS.map((k, i) => [i, k] as const).filter(([, k]) => typeof k !== "string" || k === "");
  if (broken.length > 0) {
    return broken.map(([i]) =>
      `KEYS 第 ${i + 1} 项不是一个非空字符串 —— 它 import 的那个真源常量多半已经不再导出了。`
      + "真因在源码，不在这张登记。");
  }
  const rows = new Map(RESET_LEDGER.map((r) => [r.key, r]));
  for (const k of KEYS) {
    if (!rows.has(k)) {
      fails.push(`存储键 \`${k}\` 在 RESET_LEDGER 里没有一行 —— 九把键必须逐把表态：`
        + "给它补一行（`name` / `key` 写 import 进来的常量 / `verdict` / `why`）。");
    }
  }
  for (const r of RESET_LEDGER) {
    if (!KEYS.includes(r.key)) {
      fails.push(`RESET_LEDGER 里多出一行 \`${r.name}\`（值 \`${r.key}\`），而它不在从真源 import `
        + "的那张清单里 —— 要么它是新存储键（那就 import 进 KEYS），要么这一行写错了。");
      continue;
    }
    if (!(VERDICTS as readonly string[]).includes(r.verdict)) {
      fails.push(`\`${r.name}\` 在「重置配置」那一格的裁决是「${r.verdict || "(空)"}」，`
        + `不在封闭词表 ${VERDICTS.join(" / ")} 里 —— 留白不算表态。`);
    }
    if (r.why.trim().length < 10) {
      fails.push(`\`${r.name}\` 那一行的 \`why\` 是空的（或短得不像一句话）—— `
        + "登记要说人话：这把键装的是什么、为什么这条路径动/不动它。");
    }
  }
  return fails;
}

/**
 * 源码里的存储键常量。**判据从源码派生，不是一张手抄名单。**
 *
 * 约定：`src/` 下 `const <名字>_KEY / <名字>_KEY_PREFIX = "字面量"` 一律是存储键。
 * ⚠️ 这条约定今天是**无例外**的：Task 30 为此把 `byModel` 的兜底桶名从以 `_KEY` 结尾
 * 改成了 `USAGE_OTHER_BUCKET`（理由写在 `src/core/admin/usage-stats.ts` 那个常量旁边）
 * ——**开一张只有一条的豁免名册，下一个人往里加第二条时不会有任何东西红。**
 * ⚠️ 扫之前先过 Task 1 的 `blankComments`：本仓注释里复述常量名是最常见的写法。
 *
 * ⚠️⚠️ **射程是复评回填后扩过的，上一版漏掉两种真实写法（都实测过，当时全绿）**：
 * · **不带 `export`** 的 `const X_KEY = "…";` —— `PROBE_KEY` 提成导出常量之前就是这个形态，
 *   而 `src/adapters/storage-file.ts` 的 `TTL_TABLE_KEY` **今天就是**这个形态（见下面 `PORTLESS_KEYS`）；
 * · 值带 **` as const`** 尾巴的。
 * 所以 `export` 改成可选（**导出与否记在 `exported` 上，不是丢掉**——两族的处置不一样），
 * 并容忍 ` as const`。
 * ⚠️ **仍然扫不到的两种，是这条判据的固有边界，别以为扩正则能解决**：
 * 调用点裸字面量（`storage.put("brandnew:x", …)`）、模板串/变量拼接的键名。
 * 两条都逐字登记在这里：**它们不在本组射程内**，别把本组的绿读成「全仓的键都被守着」。
 */
function storageKeyConstantsIn(
  root: string,
): { file: string; name: string; value: string; exported: boolean }[] {
  const re = /^[^\S\n]*(export\s+)?const\s+([A-Z0-9_]*KEY(?:_PREFIX)?)\s*(?::[^=]*)?=\s*"([^"]*)"(?:\s+as\s+const)?\s*;/gm;
  const out: { file: string; name: string; value: string; exported: boolean }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        for (const m of blankComments(readFileSync(p, "utf8")).matchAll(re)) {
          out.push({ file: p, name: m[2]!, value: m[3]!, exported: m[1] !== undefined });
        }
      }
    }
  };
  walk(root);
  return out;
}

/**
 * **不经 `Storage` 端口**的那一族键的**封闭登记**（复评 F4 回填）。
 *
 * ⚠️ **这不是豁免名册。** 豁免名册的性质是「扫到了就跳过」——下一个人往里加第二条时
 * 不会有任何东西红（本仓已登记过「豁免名册会变成永久的洞」）。这里是**封闭登记**：
 * 实扫结果必须与它**逐条相等**，多一条、少一条、改了值都红，而且报文要求
 * 「要么提成导出常量进 `KEYS` 并给 `RESET_LEDGER` 补一行，要么回来在这张登记里
 * 给它一行并说明它为什么不是业务键」。
 *
 * 今天只有一条：`src/adapters/storage-file.ts` 的 `TTL_TABLE_KEY = " ttl"`。
 */
const PORTLESS_KEYS: ReadonlyArray<{ file: string; name: string; value: string; why: string }> = [
  {
    file: join("src", "adapters", "storage-file.ts"), name: "TTL_TABLE_KEY", value: " ttl",
    why: "file 适配器写在 `store.json` **顶层**的 TTL 记账表，`list()` 用 `k !== TTL_TABLE_KEY` "
      + "把它滤掉，Worker/KV 侧根本不存在它 ⇒ 它不是业务键，三条重置路径都不该看见它。"
      + "它同时是 `src/` 下唯一一个不带 `export` 的这类常量，上一版的扫描（只认 `export const`）"
      + "因此看不见它，当时那句「全仓的存储键：九把」**就是假的**。",
  },
];

/**
 * `configResetHandler` 的源码切片：从函数签名起，到**下一个顶格 `export `** 为止。
 *
 * ⚠️ **切之前先 `blankComments`**：那个函数上方与内部的注释里逐字提着 `CONFIG_KEY`、
 * `RESET_VALUE`、`storage.put` 这些串（本文件开头登记过「注释里复述常量名是最常见的写法」），
 * 不抠掉的话下面那条扫描会把散文当成实现。
 * ⚠️ **认不出要吵**：切不出来时 `throw`，不许返回 `""` 之类的静默兜底——
 * 那会让这一格在函数改名/搬家之后恒绿（本仓「判据用错工具时静静放行」那一族）。
 */
function resetImplBody(): string {
  const blanked = blankComments(readFileSync(RESET_IMPL_FILE, "utf8"));
  const i = blanked.indexOf(RESET_IMPL_FN);
  if (i < 0) {
    throw new Error(
      `${RESET_IMPL_FILE} 里找不到 \`${RESET_IMPL_FN}\` —— 重置实现被改名或搬走了。`
      + "这一格是靠那段源码活着的，找不到就是空转：回来把 `RESET_IMPL_FILE` / `RESET_IMPL_FN` 改对，"
      + "别把这一格删掉。",
    );
  }
  const rest = blanked.slice(i + RESET_IMPL_FN.length);
  const j = rest.indexOf("\nexport ");
  const body = j < 0 ? rest : rest.slice(0, j);
  if (body.length < 200) {
    throw new Error(`${RESET_IMPL_FILE} 里切出来的 \`configResetHandler\` 短得不像一个实现（${body.length} 字节）—— 切片写坏了`);
  }
  return body;
}

/**
 * 重置实现里**真的被写/删**的那几把键，返回的是**常量名**。
 *
 * 只认 `.put(<常量名>` / `.delete(<常量名>`：**读不算动**（`readAll()` 那两次读不该
 * 出现在这份清单里）。
 * ⚠️ 顺带堵一个洞：切片里出现 `.put("字面量"` / `.delete("字面量"` 一律算「裸字面量键」，
 * 由调用方当场红——键名绕过常量之后，上面那张源码扫描永远看不见它。
 */
function resetImplTouchedKeyNames(body: string): { names: string[]; literals: string[] } {
  const names = [...body.matchAll(/\.(?:put|delete)\s*\(\s*([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]!);
  const literals = [...body.matchAll(/\.(?:put|delete)\s*\(\s*(["'`])/g)].map((m) => m[1]!);
  return { names: [...new Set(names)].sort(), literals };
}

describe("「重置到底重置了什么」：九把存储键的封闭登记（P3e Task 30 / P3f 改写）", () => {
  it("封闭登记对这 9 个存储键逐把表态 —— 删掉登记里一行就红", () => {
    // ⚠️ 手写字面量等号，不许 `toBeGreaterThanOrEqual`（本仓 §通用纪律逐字禁的形态）。
    expect(KEYS.length, "键表被改动了 —— 回来把这个数改对，别删断言").toBe(9);
    expect(new Set(KEYS).size, "KEYS 里有重复的键名 —— 两个常量取了同一个值？").toBe(9);
    expect(RESET_LEDGER.length, "登记的行数与键表对不上 —— 逐把表态就是逐把，不许合并行").toBe(9);
    const failures = resetLedgerFailures();
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("反向控制：源码里每一个存储键常量，要么被上面那张 import 清单收着、要么落在封闭登记里 —— 新增一个就红", () => {
    const declared = storageKeyConstantsIn("src");
    const exported = declared.filter((d) => d.exported);
    const portless = declared.filter((d) => !d.exported);
    const show = (d: { file: string; name: string; value: string }): string =>
      `${d.file}: ${d.name} = "${d.value}"`;

    // ⚠️ **这一条必须排在计数之前。** 上一版把计数放在前面，于是「新增一个存储键」这个
    // 最常见的形态报出来的是「一个都没扫到，扫描多半写坏了：expected 10 to be 9」——
    // 报文亲手把人引向「扫描坏了」，而真因是「你新加的那把键没进清单」（实测过一次）。
    const orphans = exported.filter((d) => !KEYS.includes(d.value)).map(show);
    expect(orphans,
      "这些存储键常量在源码里真的存在，却没被那张 import 清单收着 —— "
      + "把它 import 进 KEYS、并在 `RESET_LEDGER` 里给它一行（逐把表态，不许留白）：\n"
      + orphans.join("\n")).toEqual([]);

    // 不带 `export` 的那一族：与 `PORTLESS_KEYS` **逐条相等**（封闭登记，不是豁免名册）。
    // ⚠️ 报文要把两条出路都说出来，否则下一个人只会来改这张表——那就把封闭登记变成了洞。
    const fmt = (xs: readonly { file: string; name: string; value: string }[]): string[] =>
      xs.map(show).sort();
    expect(fmt(portless),
      "`src/` 下不带 `export` 的存储键常量与封闭登记 `PORTLESS_KEYS` 对不上 —— "
      + "多出来的那条要么**提成 `export` 常量**、import 进 KEYS 并给 `RESET_LEDGER` 补一行"
      + "（它经 `Storage` 端口就走这条），要么回来在 `PORTLESS_KEYS` 里给它一行、"
      + "在 `why` 里说明它为什么不是业务键。"
      + "少了一条则说明那把键没了或改了形态，回来把这张表改对：\n"
      + `实扫：${fmt(portless).join(" / ") || "(空)"}\n登记：${fmt(PORTLESS_KEYS).join(" / ")}`)
      .toEqual(fmt(PORTLESS_KEYS));

    // 封闭登记里的每一条都必须自带一句人话的理由。
    // ⚠️ 没有这一条，`PORTLESS_KEYS` 就成了一张只有键名、没人说得清为什么在这儿的名单。
    const unexplained = PORTLESS_KEYS
      .filter((d) => d.why.trim().length < 10)
      .map((d) => `${d.name}（${basename(d.file)}）`);
    expect(unexplained,
      "封闭登记里的这几把键没写为什么在这儿 —— `why` 要说清："
      + "它装的是什么、为什么它不经 `Storage` 端口、三条重置路径为什么都不该看见它：\n"
      + unexplained.join("\n")).toEqual([]);

    // 计数是「扫描不是空跑」的绊线，也拦「加了键、也 import 了、但没回来改这个数」。
    // ⚠️ 报文要两个方向都说得通：扫少了是扫描坏了，扫多了是清单该长大。
    expect(exported.length,
      "扫到的**导出**存储键常量条数与手写的不一致 —— 比 9 少通常是扫描写坏了（判据认不出真声明），"
      + "比 9 多说明真加了一把键：把它 import 进 KEYS、给 `RESET_LEDGER` 补一行，再回来把这个数改对").toBe(9);
    expect(declared.length,
      "扫到的存储键常量总数不是 10（9 把导出的业务键 + 1 把封闭登记里的适配器内部键）—— "
      + "扫少了是判据认不出真声明，扫多了见上面两条报文").toBe(10);
  });

  it("「重置配置」那一列裁决从重置实现现扫 —— 实现动了哪几把键，登记就得写哪几把", () => {
    const { names, literals } = resetImplTouchedKeyNames(resetImplBody());
    expect(literals,
      "重置实现里有 `.put(\"字面量\"` / `.delete(\"字面量\"` 这种写法 —— "
      + "键名绕过常量之后，上面那条源码扫描永远看不见它，这张登记也就永远不会为它红。"
      + "把它提成 `src/` 下的一个 `*_KEY` 常量再用。").toEqual([]);
    const declaredMoved = RESET_LEDGER.filter((r) => r.verdict === "动").map((r) => r.name).sort();
    expect(names,
      "`configResetHandler` 真的写/删的那几把键，与 `RESET_LEDGER` 里裁决为「动」的那几行对不上。\n"
      + `实现现扫：${names.join(" / ") || "(空)"}\n登记里「动」：${declaredMoved.join(" / ") || "(空)"}\n`
      + "两个方向都要看：实现多动了一把（爆炸半径变大了，去 `RESET_LEDGER` 把那一行改成「动」"
      + "并回答这是不是有意的），或者登记写着「动」而实现没动它（登记过期了）。").toEqual(declaredMoved);
    // 防瞎：一把都没扫到时上面那条会拿 `[]` 去比 `[]`，恒绿。
    expect(names.length, "重置实现里一把常量键都没扫到 —— 扫描多半写坏了，别把这一格的绿当成结论").toBeGreaterThan(0);
  });

  it("该红时红：从登记里删掉 `tend:history` 那一行 —— 第一格红并点名它", () => {
    // 变异跑的是**同一个** `resetLedgerFailures()` 的实现，只把输入换成删了一行的登记。
    const kept = RESET_LEDGER.filter((r) => r.key !== TEND_HISTORY_KEY);
    expect(kept.length, "变异没落地 —— 登记里找不到 `tend:history` 那一行").toBe(RESET_LEDGER.length - 1);
    const rows = new Map(kept.map((r) => [r.key, r]));
    const failures = KEYS.filter((k) => !rows.has(k))
      .map((k) => `存储键 \`${k}\` 在 RESET_LEDGER 里没有一行`);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没点名那把键").toContain(TEND_HISTORY_KEY);
  });

  it("该红时红：真源里新增一把存储键常量而登记没跟上 —— 反向控制那一格红并点名它", () => {
    // ⚠️ **这一格是本组存在的全部理由**，它探的正是「新增一把键被漏掉」那个形态。
    // 变异落在一棵临时源码树上，跑的是**同一个** `storageKeyConstantsIn()`。
    const dir = mkdtempSync(join(tmpdir(), "storage-keys-newcomer-"));
    try {
      writeFileSync(join(dir, "live.ts"), 'export const BRANDNEW_KEY = "brandnew:thing";\n');
      const declared = storageKeyConstantsIn(dir).filter((d) => d.exported);
      expect(declared, "变异没落地 —— 临时树里那条新声明没被扫到").toHaveLength(1);
      const orphans = declared.filter((d) => !KEYS.includes(d.value))
        .map((d) => `${d.file}: ${d.name} = "${d.value}"`);
      expect(orphans, "新增了一把存储键常量，判据却没红 —— 这一组等于挡空气").toHaveLength(1);
      expect(orphans[0] ?? "", "红了但报文没点名那把新键的常量名").toContain("BRANDNEW_KEY");
      expect(orphans[0] ?? "", "红了但报文没点名那把新键的值").toContain("brandnew:thing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("该红时红：把某一格裁决留白 —— 报文点名是哪把键", () => {
    const blanked = RESET_LEDGER.map((r) =>
      r.key === HEALTH_PROBE_KEY ? { ...r, verdict: "" as unknown as ResetVerdict } : r);
    const bad = blanked.filter((r) => !(VERDICTS as readonly string[]).includes(r.verdict));
    expect(bad, "变异没落地 —— 没有任何一行的裁决被掏空").toHaveLength(1);
    const msg = `\`${bad[0]!.name}\` 在「重置配置」那一格的裁决是「${bad[0]!.verdict || "(空)"}」，`
      + `不在封闭词表 ${VERDICTS.join(" / ")} 里 —— 留白不算表态。`;
    expect(msg, "红了但报文没点名那把键").toContain("HEALTH_PROBE_KEY");
    expect(msg, "报文没说清是留白").toContain("(空)");
  });

  it("该红时红：重置实现改成连 key 池索引一起写 —— 第三格红并点名多出来的那把", () => {
    // 变异落在**源码切片的文本**上，跑的是同一个 `resetImplTouchedKeyNames()`。
    const real = resetImplBody();
    const mutated = real.replace(
      "storage.put(CONFIG_KEY,",
      "storage.put(POOL_INDEX_KEY, null);\n    await wiring.storage.put(CONFIG_KEY,",
    );
    expect(mutated, "变异没落地 —— 切片里找不到那一句 put").not.toEqual(real);
    const { names } = resetImplTouchedKeyNames(mutated);
    const declaredMoved = RESET_LEDGER.filter((r) => r.verdict === "动").map((r) => r.name).sort();
    expect(names, "实现多动了一把键，判据却绿了").not.toEqual(declaredMoved);
    expect(names, "红了但没扫出那把多动的键").toContain("POOL_INDEX_KEY");
  });

  it("该红时红：重置实现改成写裸字面量键 —— 第三格红，因为那种写法绕过整条扫描链", () => {
    const mutated = resetImplBody().replace("storage.put(CONFIG_KEY,", 'storage.put("config",');
    const { literals } = resetImplTouchedKeyNames(mutated);
    expect(literals, "裸字面量键没被拦下来 —— 那种写法一旦放行，新增的键永远不会被本组看见")
      .not.toEqual([]);
  });

  it("探针：切片只到下一个顶格 `export ` —— 别的 handler 的写操作不许算进这一格", () => {
    const body = resetImplBody();
    expect(body, "切片越界，把下一个顶格 export 也吃进来了").not.toContain("\nexport ");
    // 同一份文件里 `PUT` 那条路径也 `put(CONFIG_KEY, …)`，切歪了这一格照样绿 ⇒ 探针要能分辨。
    expect(body, "切出来的不是 configResetHandler 的身体").toContain("config.reset");
  });

  it("探针：同一个扫描跑临时夹具 —— 认得出真实形状的声明，而注释里的那一份不算", () => {
    // ⚠️ 反向控制用**仓里真实存在的串**：下面这两行逐字抄自 `src/core/pool-index.ts`。
    const real = 'export const KEY_PREFIX = "key:";\nexport const POOL_INDEX_KEY = "pool:index";\n';
    const dir = mkdtempSync(join(tmpdir(), "storage-keys-"));
    try {
      writeFileSync(join(dir, "live.ts"), real);
      const seen = storageKeyConstantsIn(dir);
      expect(seen.map((d) => d.value).sort(), "扫描认不出仓里真实存在的那两条声明").toEqual([KEY_PREFIX, POOL_INDEX_KEY].sort());
      expect(seen.every((d) => d.exported), "这两条明明带着 `export`，却没被记成导出").toBe(true);

      // 同样两行，整段包进块注释：`blankComments` 接上了的话，一条都不该扫到。
      writeFileSync(join(dir, "live.ts"), `/*\n${real}*/\n`);
      expect(storageKeyConstantsIn(dir), "注释里的声明被当成真声明了 —— blankComments 没接上").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("探针：复评回填后新覆盖的两种写法 —— 不带 `export` 的、值带 ` as const` 的，都要扫得到", () => {
    // ⚠️ 反向控制用**仓里真实存在的形态**：
    // 第一行逐字抄自 `src/adapters/storage-file.ts`（今天真的是这个写法）；
    // 第二行是 `PROBE_KEY` 提成导出常量之前的原样，只把值换成一个不存在的键名。
    const dir = mkdtempSync(join(tmpdir(), "storage-keys-widened-"));
    try {
      writeFileSync(join(dir, "live.ts"),
        'const TTL_TABLE_KEY = " ttl";\n'
        + 'const PROBE_KEY = "probe:brandnew";\n'
        + 'export const AS_CONST_KEY = "asconst:brandnew" as const;\n');
      const seen = storageKeyConstantsIn(dir);
      expect(seen.map((d) => d.value).sort(),
        "扩射程之后这三种写法仍然有扫不到的 —— 复评实测过：上一版这三条全绿")
        .toEqual([" ttl", "asconst:brandnew", "probe:brandnew"]);
      expect(seen.filter((d) => d.exported).map((d) => d.name),
        "`exported` 记错了 —— 两族的处置不一样，记混就把封闭登记变成了豁免名册")
        .toEqual(["AS_CONST_KEY"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不乱红：`_KEY` 结尾但不是存储键的那一族 —— `USAGE_OTHER_BUCKET` 那次改名的反面，不许扫成键", () => {
    // ⚠️ 反向控制用**仓里真实存在的串**：`"__other__"` 是 `src/core/admin/usage-stats.ts`
    // 里 `USAGE_OTHER_BUCKET` 今天的值，Task 30 正是为了这条约定把它从 `_KEY` 改名的。
    const dir = mkdtempSync(join(tmpdir(), "storage-keys-nonkey-"));
    try {
      writeFileSync(join(dir, "live.ts"),
        'export const USAGE_OTHER_BUCKET = "__other__";\n'
        + 'export const KEYBOARD = "kbd";\n'
        + 'export const SOME_KEY_LIST = ["a"];\n');
      expect(storageKeyConstantsIn(dir),
        "扩射程扩过头了：不以 `_KEY`/`_KEY_PREFIX` 结尾的常量被当成存储键了").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不乱红：登记里多写一句更长的 `why` —— 不许因此红", () => {
    const verbose = RESET_LEDGER.map((r) => ({ ...r, why: `${r.why}（补记：这一段是后来加的。）` }));
    const bad = verbose.filter((r) => r.why.trim().length < 10 || !(VERDICTS as readonly string[]).includes(r.verdict));
    expect(bad.map((r) => r.name), "把 `why` 写长了却被判成坏行").toEqual([]);
  });
});

/**
 * ── 那句「某一期会提供一条正式重置路径」（P3e Task 31A）──────────────────────
 *
 * R10 的原形：五份 DEPLOY.md 在 `POOL_TOUCH_INTERVAL_MS` 那一行**同步承诺**了
 * 「P3c 会提供一条经过 repo 的正式重置路径」，而 P3c 已经完成、
 * `PATCH_FIELDS` 里当时**没有** stats ⇒ 五份齐说一句假话，跨语言计数判据一格都不响
 * （五份都写着，计数当然对得上）。
 *
 * Task 31A 走的是**兑现**那一支（裁定写死在设计小节「第三颗按钮的去向」里）。
 * 这一组是兑现之后留下的**反向守卫**：它不管那条路径实现得对不对（那由
 * `tests/contract/admin-keys-write.test.ts` 那两格管），只管**没有人再写下一句
 * 同样形态的空头承诺**。
 */
describe("五份 DEPLOY.md 不许再写「某一期会提供某条重置路径」这种不兑现的承诺（P3e Task 31A）", () => {
  /**
   * ⚠️ **需求书给的原式逐条实测下来有两个洞，两个都会让这一格在最该响的时候不响。**
   * 原式：`/P3[abcde]\s*(?:会|會|will|で|에서)[^\n]{0,40}(重置|重設|reset|초기화|리셋)/i`
   *
   * ① **尾词表里两个韩文词、零个日文词**：`리셋` 是谚文，而日文那句用的是片假名
   *    `リセット`。实测原式在**改话之前**的五份上只命中 4 份、**ja 那份 0 命中**
   *    （`P3c で repo を経由する正式なリセット経路を用意する。` 明明就在那儿）
   *    ⇒ 需求书 Step 1 自己写的验收条件「必须红，且**点名五份**」，用原式做不到。
   * ② **`P3[abcde]` 罩不住它自己声称要罩的东西**：原式那条注释写的是
   *    「谁再写「**P4** 会提供 X」而不实现，它会红」——`P3[abcde]` 连 `P4` 的第二个
   *    字符都对不上；需求书 M1 用的变异串 `P3f 会提供一条正式重置路径`（这一串来自本期需求书）
   *    里的 `f` 同样在字符类之外 ⇒ **照抄原式做 M1，变异打上去这一格照绿**，
   *    也就是本仓登记过的「跑了变异、绿了，其实压根没打中」。
   *
   * ⇒ 尾词表补 `リセット`、期号放宽成 `P[3-9][a-z]?`。**放宽了就要自己数假阳性**：
   * 逐份扫过，改话之前五份各命中 1 次、改话之后五份各 0 次，DEPLOY.md 里没有第二处
   * 命中。（这个「1 次 / 0 次」不是判据，是当时的读数；判据是下面那三格。）
   */
  const PROMISE = /P[3-9][a-z]?\s*(?:会|會|will|で|에서)[^\n]{0,40}(?:重置|重設|reset|초기화|リセット|리셋)/i;

  /**
   * 五份 × 一条正则 ⇒ 失败报文数组。**真扫描与下面几格探针共用这一份**——
   * 各写一份的话，两边的判据会各有各的口径，而其中一份坏了另一份不会响。
   */
  function promiseFailures(read: ApiDocReader): string[] {
    const out: string[] = [];
    for (const lang of LANGS) {
      const hit = read(lang).match(new RegExp(PROMISE.source, "i"));
      if (hit !== null) {
        out.push(
          `docs/${lang}/DEPLOY.md 还留着一句不兑现的承诺：「${hit[0]}」`
          + "——要么把那条路径真的做出来、把这句话改成描述**已实现**的东西，"
          + "要么如实写「今天没有这条路径」。**不许原样翻译成五份**："
          + "五份齐说的假话，跨语言计数判据一格都不响。",
        );
      }
    }
    return out;
  }

  it("五份 DEPLOY.md 都不许再出现「某一期会提供某条重置路径」这种不兑现的承诺", () => {
    const failures = promiseFailures(realDoc("DEPLOY"));
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /**
   * 探针的基：真文档今天必须过判据，否则探针红了会被误读成「探针有问题」。
   * ⚠️ **这一段不是锦上添花，是实测补上的**：真往 `docs/ko/DEPLOY.md` 末尾加一句
   * `P3f 会提供一条正式重置路径。` 之后，上面那一格如实点名了 ko，
   * 而下面五格探针**同时**报「应当只红一条，实际 2 条」——报文把人指向探针本身，
   * 而真因在文档。同型的处置本文件已有一份（`probeBaseReset`）。
   */
  function probeBasePromise(): void {
    const base = promiseFailures(realDoc("DEPLOY"));
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真的五份 DEPLOY.md，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「五份 DEPLOY.md 都不许再出现「某一期会提供"
        + "某条重置路径」这种不兑现的承诺」那一格：\n"
        + base.join("\n"),
      );
    }
  }

  /** 同上，配给那半句限制的三格探针。 */
  function probeBaseCaveat(): void {
    const base = perLangTokenFailures("改话之后那半句限制", REBOUND_CAVEAT, realDoc("DEPLOY"));
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真的五份 DEPLOY.md，而真文档今天本身就不过判据 —— "
        + "真因在「五份 DEPLOY.md 各自写着自己那种语言的那半句限制，且不串门」那一格：\n"
        + base.join("\n"),
      );
    }
  }

  /**
   * **反向控制：这条正则在五种语言上都真的认得出那个形状。**
   *
   * ⚠️ 串一律取**仓里真实存在过**的那五句——它们就是本任务亲手改掉的那五句原话，
   * 逐字抄自改话前的 `docs/<lang>/DEPLOY.md`。
   * **没有这一格，「真扫描是绿的」有两种解释**：一是那五句真的改干净了，
   * 二是正则在这五种语言上压根认不出东西——而后者正是本仓 Task 9 M1 那次
   * 「判据认不出任何东西 ⇒ 真仓五格全变绿」的形态。
   *
   * 这一格同时就是需求书 M4（「只改四份、漏掉某一份」）：它逐份把那一份改回原话，
   * 每一次都必须**只红一条**并点名那一份。
   */
  const OLD_PROMISE: Record<Lang, string> = {
    "zh-CN": "P3c 会提供一条经过 repo 的正式重置路径。",
    "zh-TW": "P3c 會提供一條經過 repo 的正式重設路徑。",
    en: "P3c will offer a proper reset path that goes through the repo.",
    ja: "P3c で repo を経由する正式なリセット経路を用意する。",
    ko: "P3c에서 repo를 거치는 정식 초기화 경로를 제공할 예정.",
  };

  /** 改话之后每一份里都必须还在的那半句（每语言各一个 token，且不许串门）。见下面那格。 */
  const REBOUND_CAVEAT: Record<Lang, string> = {
    "zh-CN": "仍可能把旧值顶回来一次",
    "zh-TW": "仍可能把舊值頂回來一次",
    en: "may push an old value back once",
    ja: "古い値を一度だけ書き戻すことがある",
    ko: "옛 값을 한 번 되돌려 쓸 수 있음",
  };

  it.each([...LANGS])("该红时红：把 %s 那一份改回改话之前的原话 ⇒ 只红一条并点名那一份", (lang) => {
    probeBasePromise();
    const failures = promiseFailures(
      readerWith(lang, (src) => src.split(REBOUND_CAVEAT[lang]).join(OLD_PROMISE[lang]), "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain(`docs/${lang}/DEPLOY.md`);
  });

  it("该红时红：需求书 M1 那句「P3f 会提供一条正式重置路径」塞进任一份 ⇒ 点名那一份", () => {
    probeBasePromise();
    // ⚠️ **这一串不是现编的**：它逐字来自本期需求书 M1 那一行。
    // ⚠️ **需求书原式罩不住它**：原式的期号字符类是 `P3[abcde]`，`f` 不在里面
    // ⇒ 照抄原式做这个变异，这一格会绿——「跑了变异、绿了，其实压根没打中」。
    const failures = promiseFailures(
      readerWith("ja", (src) => `${src}\n\nP3f 会提供一条正式重置路径。\n`, "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/ja/DEPLOY.md");
    expect(failures[0]).toContain("P3f 会提供一条正式重置");
  });

  it("不乱红：期号与「重置」各在自己那一行时不许命中 —— 40 字窗口是按行算的", () => {
    probeBasePromise();
    // ⚠️ **两行都是仓里真实存在的原文**（`docs/zh-CN/DEPLOY.md`）：一行是小节标题、
    // 一行是危险区那笔配额账。五份 DEPLOY.md 里 `P3c` 各出现七八次、「重置」各出现
    // 十几次，真扫描今天是绿的——**这一格把那件事变成一条会自己红的断言**：
    // 哪天有人把 `[^\n]` 放宽成 `[\s\S]`，跨行就会开始假红，而假红的守卫下一步
    // 就会被人放宽或删掉。
    const noisy: ApiDocReader = (lang) =>
      `${realDoc("DEPLOY")(lang)}\n\n### 设置页能改什么（P3c）\n\n`
      + "- **重置配置**（`/admin/api/config/reset`，设置页危险区第一颗按钮）\n";
    const failures = promiseFailures(noisy);
    expect(failures, `期号与「重置」分处两行，却被判成了一句承诺：\n${failures.join("\n")}`).toEqual([]);
  });

  // ── 兑现那一支的另一半：文档里那个字段名从真源现算 ──────────────────────────

  /**
   * **「已实现」这三个字要有一端钉在代码上，否则改话与撒谎只差一次改名。**
   *
   * 五份 DEPLOY.md 现在写的是「走 `PATCH /admin/api/keys/:id` 带 `clearStats`」。
   * 端点路径那一半已经由上面「危险区那两条端点的路径……从真源常量现算」同型地守着，
   * 这一格守的是**字段名**：`PATCH_FIELDS` 里没有它、或者它被改了名而文档没跟上，
   * 这一格当场红，且报文明说**真因在源码，不在文档**（本文件 MUT-G 那一族的报文纪律）。
   *
   * 比「五份彼此相等」多守一件事：**各恰好 1 次**。五份一起写成 2 次
   * （复制粘贴把那一行重复了）在纯对等判据下是合法的。
   */
  it("五份 DEPLOY.md 里那条已实现的重置路径写着真源里的字段名，各恰好 1 次", () => {
    // 宽化成 `readonly string[]` 再查：直接对 `PATCH_FIELDS` 的字面量联合做比较的话，
    // 字段被删掉时这里会变成一个 **tsc 报错**，而报错信息说的是类型没有重叠——
    // 那句报文没法告诉人「五份文档现在指着一个不存在的字段」。
    const fields: readonly string[] = PATCH_FIELDS;
    const field = fields.find((f) => f === "clearStats");
    expect(
      field,
      "`PATCH_FIELDS`（`src/http/admin/handlers/keys-write.ts`）里已经没有 `clearStats` 了 —— "
      + "**真因在源码，不在文档**：这条路径要么被删了、要么被改了名。"
      + "五份 DEPLOY.md 那句「走 `PATCH /admin/api/keys/:id` 带 `clearStats`」现在指着一个不存在的字段，"
      + "而 R10 那句承诺就是这样变成假话的",
    ).toBeDefined();

    const token = `\`${field as string}\``;
    const counts = Object.fromEntries(
      LANGS.map((l) => [l, realDoc("DEPLOY")(l).split(token).length - 1]),
    );
    expect(
      counts,
      `${token} 在五份 DEPLOY.md 里不是各出现 1 次（${JSON.stringify(counts)}）——`
      + "0 次是那一份漏改（R10 那句承诺在那种语言里还没兑现），"
      + "2 次以上多半是复制粘贴把那一行重复了",
    ).toEqual(Object.fromEntries(LANGS.map((l) => [l, 1])));
  });

  // ── 改话之后那半句限制（「别的实例仍可能顶回来一次」）逐份上锚 ────────────────
  //
  // ⚠️ **这半句是本次改话里最容易在翻译中丢掉的一句，而丢掉它就又是一句假话**：
  // `clearStats` 清的只是**处理这次请求那个实例**的 `pendingStats`
  // （`src/core/keypool-repo.ts` 的 `save()` 新建分支），同时在跑的别的 isolate /
  // 别的容器各有各的 `entry.base`，仍会把旧值顶回来一次。
  // 少了这半句，文档就在说「重置之后立刻且永远干净」——而那正是 R10 那句承诺
  // 当年被写下来的原因（先清零后回弹）。

  const CAVEAT_TABLE = [{ label: "改话之后那半句「别的实例仍可能顶回来一次」", table: REBOUND_CAVEAT }] as const;

  it("五份 DEPLOY.md 各自写着自己那种语言的那半句限制，且不串门", () => {
    const failures = perLangTokenFailures(CAVEAT_TABLE[0].label, REBOUND_CAVEAT, realDoc("DEPLOY"));
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("反向自检：这张锚表的语言集恰好等于 LANGS，且没有两种语言共用（或互为子串）同一个 token", () => {
    const failures = tokenTableFailures(CAVEAT_TABLE[0].label, REBOUND_CAVEAT);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("探针：把 ko 那半句限制删掉（只改四份）⇒ 变红并点名 ko", () => {
    probeBaseCaveat();
    // ⚠️ 反向控制用仓里真实存在的串：替换成的那句是 ko 那份**同一句话的前半截**，
    // 也就是「只把限制那半句删了、别的照留」在文档上真实的样子。
    const failures = perLangTokenFailures(
      CAVEAT_TABLE[0].label,
      REBOUND_CAVEAT,
      readerWith("ko", (s) => s.split(REBOUND_CAVEAT.ko).join("각자 자기 기준값을 갖고 있음"), "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/ko/DEPLOY.md");
    expect(failures[0]).toContain("出现 0 次");
  });

  it("不乱红：五份一起合法地多写一句无关的话 —— 上面那几格不许因此假红", () => {
    // ⚠️ **这一格断言了两族判据，所以两族的探针基都要先取一遍**（复评 M3）：
    // 少了 `probeBasePromise()` 时，真文档里真出现一句空头承诺 ⇒ 本格的第二条断言
    // 红成「承诺判据也不许因此假红」，把人指向这个与真因无关的 noise reader，
    // 而同组另外四格都在如实喊「真因在真扫描那一格」。**报文是唯一会被看见的护栏。**
    probeBaseCaveat();
    probeBasePromise();
    const noisy: ApiDocReader = (lang) => `${realDoc("DEPLOY")(lang)}\n\n<!-- 无关的一行 -->\n`;
    const failures = perLangTokenFailures(CAVEAT_TABLE[0].label, REBOUND_CAVEAT, noisy);
    expect(failures, `五份一起多写了一句无关的话，判据却红了\n${failures.join("\n")}`).toEqual([]);
    expect(promiseFailures(noisy), "承诺判据也不许因此假红").toEqual([]);
  });
});

/**
 * ── 「改一把 key 能改哪几件事」那份动作枚举从 `PATCH_FIELDS` 现算（P3e Task 31A 复评回填 H2）──
 *
 * **复评实测出来的洞**：给 `PATCH_FIELDS` 加第七个字段 ⇒ 本文件全绿、
 * Key 池写端点那一组契约用例也全绿，而五份 DEPLOY.md 那笔配额账里的动作枚举
 * **停在六个字段上**。
 * 上面那一组只把 `clearStats` **这一个**字段名钉在真源上（改名当场红），
 * **表变长它一个字都看不见**——这一组把它收掉。
 *
 * ⚠️ **这一组原来管的是两个投影**：五份 DEPLOY.md 那份动作枚举，以及一份内部设计文档
 * §11 端点表那一行。**后者随那份文档一起从本仓移除了**，所以这里只剩一个投影——
 * 别再照着「两个投影」那种全称句去读这一组，它今天只钉文档侧这一份。
 * ⚠️⚠️ **但被移除的那一行钉着一维本组当时没有的东西：逐项逐序的「顺序」。**
 * 那两格（「逐项逐序等于 `PATCH_FIELDS`」与它的反向控制）是全仓唯一管顺序的，
 * 随文档删掉之后，`keys-write.ts` 上仍写着的「顺序即文档顺序」**一度是一句散文**
 *（复评实测：把 `PATCH_FIELDS` 整个倒序 ⇒ `pnpm test` 3763 格全绿）。
 * 顺序这一维**已经搬进 `enumerationFailures()`**（逐词 `includes` 之后那一段位置递增判据），
 * 与覆盖那一维共用下面「……盖住 `PATCH_FIELDS` 的每一个字段」那一格，
 * 并各配一格反向控制。**这不是随文档一起丢，是搬了期望源。**
 * `PATCH_FIELDS` 这个真源本身仍由 `tests/contract/admin-keys-write.test.ts`
 * 「五个动作各自生效：停用 / 启用 / 清冷却 / 清 strikes / 解除剔除」与
 * 「clearStats：stats 归零，而 disabled / addedAt / note / cooldownUntil / evicted 逐字段不变」
 * 两格从行为侧钉着。
 *
 * ⚠️ **同一轮里删掉的那个数**：五份原来写着「六个动作同价 / All six actions /
 * 6 つの操作 / 여섯 동작」，而紧挨着的括号里枚举的是**七**项——`disabled` 一个字段
 * 对应「停用 / 启用」两个方向。那个数与它身边那一行自相矛盾，且真源变了也不会红。
 * **能删数字就删数字**：五份一律改成「上面每一项都同价」，数量这件事交给下面两格。
 */
describe("「改一把 key」那份动作枚举从 `PATCH_FIELDS` 现算（P3e Task 31A 复评回填）", () => {
  /**
   * **字段 → 那种语言里的动作词。** 这是一张手写表，但它**不是第二份真源**：
   * 它的**字段集**由下面 `enumerationFailures()` 逐次与 `PATCH_FIELDS` 对齐——
   * 真源长一格而这张表没跟上，当场红并明说「真因在源码」。
   *
   * ⚠️ **`disabled` 那一项刻意只取「停用」这一个方向**：五份文档里它写成
   * 「停用 / 启用」两个词，取整串会把一个纯排版问题（两个方向之间的分隔符）
   * 变成这一格的红。守的是「这个字段在枚举里有没有出现」，不是排版。
   */
  const PATCH_ACTION_WORDS: Record<Lang, Record<string, string>> = {
    "zh-CN": {
      disabled: "停用", note: "备注", clearCooldown: "清冷却",
      clearStrikes: "清 strikes", unevict: "解除剔除", clearStats: "重置用量计数",
    },
    "zh-TW": {
      disabled: "停用", note: "備註", clearCooldown: "清冷卻",
      clearStrikes: "清 strikes", unevict: "解除剔除", clearStats: "重設用量計數",
    },
    en: {
      disabled: "disable", note: "note", clearCooldown: "clear cooldown",
      clearStrikes: "clear strikes", unevict: "un-evict", clearStats: "reset usage counters",
    },
    ja: {
      disabled: "停止", note: "メモ", clearCooldown: "クールダウン解除",
      clearStrikes: "strikes クリア", unevict: "除外解除", clearStats: "利用回数のリセット",
    },
    ko: {
      disabled: "중지", note: "메모", clearCooldown: "쿨다운 해제",
      clearStrikes: "strikes 초기화", unevict: "제외 해제", clearStats: "사용량 카운터 초기화",
    },
  };

  /**
   * 「改一把 key」那一条 bullet 的**开头**。射程收窄到这一条，理由是这些动作词
   * （「备注」「停用」）在整份 DEPLOY.md 里到处都是——拿整份文档做底，
   * 这一格会被别处的同一个词**替它满足**，也就是又一个静静放行的判据。
   */
  const BULLET_ANCHOR: Record<Lang, string> = {
    "zh-CN": "**改一把 key**",
    "zh-TW": "**改一把 key**",
    en: "**Changing one key**",
    ja: "**key を 1 本変更**",
    ko: "**key 하나 수정**",
  };

  /**
   * 切出锚后面**那一对括号里的枚举**（半角/全角都认）。
   *
   * ⚠️ **第一版切的是「整条 bullet」，回填时当场实测出它是空转的**：那一条 bullet 的
   * 后半句里还有一句「重置用量计数不额外读写任何东西」，于是把括号里的
   * 「/ 重置用量计数」整项删掉之后，那个词**仍然在窗口里**，判据 284 格全绿。
   * 这就是本仓登记过的「判据用错工具时不会报错，会静静地放行」。
   * 窗口收到括号里之后，同一个变异当场红（下面「同一条 bullet 后半句里那个词还在」那一格
   * 就是它，**别把它当重复用例删掉**）。
   *
   * **锚不是恰好 1 次、或后面根本没有那对括号，一律返回 `null`——认不出要吵。**
   */
  function patchEnumeration(src: string, lang: Lang): string | null {
    const anchor = BULLET_ANCHOR[lang];
    if (src.split(anchor).length - 1 !== 1) return null;
    const rest = src.slice(src.indexOf(anchor) + anchor.length);
    const firstOf = (marks: readonly string[]): number => {
      const hits = marks.map((m) => rest.indexOf(m)).filter((i) => i >= 0);
      return hits.length === 0 ? -1 : Math.min(...hits);
    };
    const open = firstOf(["（", "("]);
    const close = firstOf(["）", ")"]);
    if (open < 0 || close < 0 || close < open) return null;
    return rest.slice(open + 1, close);
  }

  /**
   * 五份 × 一张表 ⇒ 失败报文数组。`fields` 是参数而不是直接读 `PATCH_FIELDS`：
   * 下面那格探针要拿一份**多一格的真源**打进来，而探针必须与真扫描共用同一份判据。
   */
  function enumerationFailures(fields: readonly string[], read: ApiDocReader): string[] {
    const out: string[] = [];
    for (const lang of LANGS) {
      const words = PATCH_ACTION_WORDS[lang];
      const missing = fields.filter((f) => typeof words[f] !== "string");
      if (missing.length > 0) {
        out.push(
          `\`PATCH_FIELDS\` 里的 ${missing.map((f) => `\`${f}\``).join(" / ")} 在「字段 → ${lang} 的动作词」`
          + "这张表里没有对应项 —— **真因在源码，不在文档**：`PATCH_FIELDS`"
          + "（`src/http/admin/handlers/keys-write.ts`）长了一格，而 "
          + `docs/${lang}/DEPLOY.md「改一把 key」那一笔配额账里的动作枚举没跟着长。`
          + "先把那一项写进五份文档的枚举，再把它的动作词补进这张表",
        );
        continue;   // 表都不齐，逐词查没有意义
      }
      const stale = Object.keys(words).filter((f) => !fields.includes(f));
      if (stale.length > 0) {
        out.push(
          `「字段 → ${lang} 的动作词」表里的 ${stale.map((f) => `\`${f}\``).join(" / ")} `
          + "已经不在 `PATCH_FIELDS` 里了 —— 那个字段被删掉或改了名，"
          + "五份文档那份枚举与这张表都该跟着改",
        );
      }
      const bullet = patchEnumeration(read(lang), lang);
      if (bullet === null) {
        out.push(
          `docs/${lang}/DEPLOY.md 里「${BULLET_ANCHOR[lang]}」不是恰好出现 1 次、`
          + "或者它后面那对括号不见了 —— 这一格靠它切出「改一把 key」括号里的那份枚举，"
          + "切不出来就是空转，不许当成通过",
        );
        continue;
      }
      for (const f of fields) {
        const word = words[f] as string;
        if (word.trim() === "") {
          out.push(`「字段 → ${lang} 的动作词」表里 \`${f}\` 的动作词是空串——空串永远查得到，这一项从此空转`);
          continue;
        }
        if (!bullet.includes(word)) {
          out.push(
            `docs/${lang}/DEPLOY.md「改一把 key」括号里的枚举中找不到 \`${f}\` 对应的动作词`
            + `「${word}」（那对括号里今天写的是：${bullet.replace(/\s+/g, " ").trim()}）`
            + " —— 那一笔配额账正在说「改一把 key 能改的是这几件事」，而它漏了一件；"
            + "要么补进枚举，要么这个动作词换了写法、把这张表改过来",
          );
        }
      }
      // ⚠️ **顺序这一维**：上面逐词 `includes` 只查覆盖，与位置无关，
      // 把 `PATCH_FIELDS` 整个倒序它照样全绿（复评实测过）。而
      // `keys-write.ts` 的 `PATCH_FIELDS` 上方逐字写着「**顺序即文档顺序**」——
      // 那句话原先由一份内部设计文档上的投影守着，文档移出本仓之后它一度没有判据。
      // 这一段就是把那一维搬到真源与 DEPLOY.md 之间重新上膛：
      // 六个动作词在括号里的出现位置必须**严格递增**。
      const at = fields.map((f) => bullet.indexOf(words[f] as string));
      if (at.every((i) => i >= 0)) {
        const bad = at.findIndex((i, k) => k > 0 && i <= (at[k - 1] as number));
        if (bad > 0) {
          out.push(
            `docs/${lang}/DEPLOY.md「改一把 key」括号里的枚举顺序与 \`PATCH_FIELDS\` 对不上：`
            + `\`${fields[bad - 1]}\`（「${words[fields[bad - 1] as string]}」）应当排在 `
            + `\`${fields[bad]}\`（「${words[fields[bad] as string]}」）**前面**，`
            + `而括号里今天写的是：${bullet.replace(/\s+/g, " ").trim()}`
            + " —— `PATCH_FIELDS`（`src/http/admin/handlers/keys-write.ts`）那张表上方"
            + "逐字承诺了「顺序即文档顺序」，两边只要有一边动了顺序、这句承诺就成了假话；"
            + "要么把五份文档的枚举调回来，要么真源改了顺序就五份一起跟着改",
          );
        }
      }
    }
    return out;
  }

  /** 探针的基：真文档今天必须过判据，否则探针红了会被误读成「探针有问题」。 */
  function probeBaseEnumeration(): void {
    const base = enumerationFailures(PATCH_FIELDS, realDoc("DEPLOY"));
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真的五份 DEPLOY.md，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「五份 DEPLOY.md 那笔配额账里的动作枚举"
        + "盖住 `PATCH_FIELDS` 的每一个字段」那一格：\n"
        + base.join("\n"),
      );
    }
  }

  it("五份 DEPLOY.md 那笔配额账里的动作枚举盖住 `PATCH_FIELDS` 的每一个字段", () => {
    const failures = enumerationFailures(PATCH_FIELDS, realDoc("DEPLOY"));
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("该红时红：`PATCH_FIELDS` 长出第七个字段 ⇒ 五份一起红，并逐份点名那个字段", () => {
    probeBaseEnumeration();
    // ⚠️ **这一串是仓里真实存在过的形态**：复评的 MUT-2 就是往 `PATCH_FIELDS` 里
    // 加 `clearNote`，而那一次 docs-parity 277 格全绿——这一格就是那次全绿的解药。
    const failures = enumerationFailures([...PATCH_FIELDS, "clearNote"], realDoc("DEPLOY"));
    expect(failures.length, `五种语言各该红一条，实际：\n${failures.join("\n")}`).toBe(LANGS.length);
    for (const lang of LANGS) {
      expect(failures.some((f) => f.includes(lang) && f.includes("clearNote")), `没点名 ${lang}`).toBe(true);
    }
    expect(failures[0]).toContain("真因在源码，不在文档");
  });

  it("该红时红：某一份的枚举里那一项被换了写法 ⇒ 只红一条并点名那一份", () => {
    probeBaseEnumeration();
    // 反向控制用仓里真实存在的串：`利用回数` 是 ja 那份自己的用词，把「リセット」
    // 换成「記録」就是「翻译时把那一项改了写法（或整项漏掉）」在文档上真实的样子。
    const failures = enumerationFailures(
      PATCH_FIELDS,
      readerWith("ja", (s) => s.split("利用回数のリセット").join("利用回数の記録"), "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/ja/DEPLOY.md");
    expect(failures[0]).toContain("利用回数のリセット");
  });

  it("该红时红：把某一项从括号里的枚举删掉，而同一条 bullet 后半句里那个词还在 ⇒ 仍然红", () => {
    probeBaseEnumeration();
    // ⚠️ **这一格记的是回填时真实发生过的一次空转**：判据第一版切的是整条 bullet，
    // 而 `docs/zh-CN/DEPLOY.md` 那一条的后半句里写着「重置用量计数不额外读写任何东西」
    // ⇒ 把括号里的「/ 重置用量计数」整项删掉，那个词仍在窗口里，284 格全绿。
    // 变异串逐字取自那一行今天的原文。
    const failures = enumerationFailures(
      PATCH_FIELDS,
      readerWith("zh-CN", (s) => s.split(" / 重置用量计数）：").join("）："), "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/zh-CN/DEPLOY.md");
    expect(failures[0]).toContain("clearStats");
    // 报文要把括号里今天的原文回显出来，好让人一眼看出少的是哪一项。
    expect(failures[0]).toContain("解除剔除");
  });

  it("该红时红：`PATCH_FIELDS` 被换了顺序 ⇒ 五份一起红，并逐份点名换位的那两个字段", () => {
    probeBaseEnumeration();
    // ⚠️ **这一格记的是复评实测出来的一处净损失**：全仓唯一钉「逐项逐序」的两格
    // 判据，期望源是一份内部设计文档 §11 的端点表，那份文档移出本仓时它们一起删了，
    // 而 `keys-write.ts` 的 `PATCH_FIELDS` 上方仍写着「**顺序即文档顺序**」。
    // 复评把整张表倒序打进来，`pnpm test` **3763 格全绿**——那句承诺当时没有判据。
    // 这一格就是把那一维搬回真源与 DEPLOY.md 之间之后的解药，倒序是复评用的原变异。
    const failures = enumerationFailures([...PATCH_FIELDS].reverse(), realDoc("DEPLOY"));
    expect(failures.length, `五种语言各该红一条，实际：\n${failures.join("\n")}`).toBe(LANGS.length);
    for (const lang of LANGS) {
      expect(failures.some((f) => f.includes(lang)), `没点名 ${lang}`).toBe(true);
    }
    // 倒序之后第一处逆序出现在头两项（`clearStats` 之后是 `unevict`），报文要点到它们。
    expect(failures[0]).toContain("clearStats");
    expect(failures[0]).toContain("unevict");
    expect(failures[0]).toContain("顺序即文档顺序");
  });

  it("该红时红：某一份把括号里两项对调 ⇒ 只红一条并点名那一份", () => {
    probeBaseEnumeration();
    // 文档侧的同一维：真源不动，只把 zh-CN 那对括号里相邻的两项互换位置。
    // 逐词 `includes` 对这个变异完全无感（七项一个都没少），只有顺序那一段会红。
    const failures = enumerationFailures(
      PATCH_FIELDS,
      readerWith("zh-CN", (s) => s.split("清冷却 / 清 strikes").join("清 strikes / 清冷却"), "DEPLOY"),
    );
    expect(failures.length, `应当只红一条，实际：\n${failures.join("\n")}`).toBe(1);
    expect(failures[0]).toContain("docs/zh-CN/DEPLOY.md");
    expect(failures[0]).toContain("clearCooldown");
    expect(failures[0]).toContain("clearStrikes");
  });

  it("不乱红：五份一起合法地多写一句无关的话", () => {
    probeBaseEnumeration();
    const noisy: ApiDocReader = (lang) => `${realDoc("DEPLOY")(lang)}\n\n<!-- 无关的一行 -->\n`;
    expect(enumerationFailures(PATCH_FIELDS, noisy), "五份一起多写了一句无关的话，判据却红了").toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 「某一份根本没翻译」—— 阶段 B 规则⑩ 在 docs 轴上的移植（P3e 全分支评审 MEDIUM-3）
 *
 * **缺口是怎么被发现的**：评审把 `docs/en/ADMIN.md` 里一整句英文换成中文（结构一个字
 * 不动）⇒ `pnpm test` 全绿、七道门禁全 exit 0。阶段 B（Task 8）早就给**字典**建过
 * 同一个失败形态的判据（规则⑩：en 不含 CJK / ko 必须有谚文），阶段 H 随后写了约 1700 行
 * 五语言文档，**那条判据一个字都没有移植到 docs 轴上**。
 * 上面那组结构判据管不了它：把一段英文换成同样长的中文，标题层级、围栏、链接、表格行、
 * 标识符 code span **逐字节不变**，R1–R6 全绿；数字锚点也可能一个都不动。
 *
 * ── 判据要能分辨「故意引用」与「整段没翻」，而且不许开豁免名册 ─────────────────
 * `docs/en/API.md` 里有 **174 个** CJK 字符，**它们是故意的**：上游报文只有中文，五份
 * 文档都如实披露了这件事并原样引用（`docs/en/API.md` 与 `docs/ja/API.md` 各有一句
 * 逐字说明）。若为它开一条「这份文件豁免」，本仓的裁定是**豁免名册会变成永久的洞**。
 * ⇒ 判据改成按**位置**分：那 174 个字符**全部在代码围栏或行内 code span 里**
 *（实测：剥掉围栏与 code span 之后 `en/API.md` 的 CJK 从 174 掉到 11，与其余五份 en
 *  文档逐字相同，而那 11 个就是语言切换行上另外三种语言的自名）。
 * ⇒ **剥围栏 + 剥 code span + 跳过语言切换行之后，六份 en 文档各 0 个 CJK。**
 *   零豁免、零名册，且「故意引用」那一面今天真实存在（下面有一格专门钉它还在）。
 *
 * ── ko 那一半：谚文旁边的汉字注是合法的 ──────────────────────────────────────
 * `docs/ko/DEPLOY.md` 有一处 `대사(對帳)` —— 韩文里「谚文词 + 括号汉字注」是正当写法。
 * 判据因此先剥掉这一种**形态**（谚文紧跟一对括号、括号里全是汉字），再要求 0。
 * 剥的是形态不是那一处，所以它不是名册：换个词写同样的注照样放行，而**整行中文**
 * （前面没有谚文）一个字都躲不掉。
 *
 * ── 已知缺口如实登记：ja / zh-CN / zh-TW 三轴今天没有判据 ────────────────────
 * 见本组最后一格。**按字形分不开**：ja 正当地用汉字、zh-CN 与 zh-TW 共用汉字，
 * 要分开需要另一份判据（简繁字表 / 假名比例阈值），那是另一件事，本期不开。
 * ────────────────────────────────────────────────────────────────────────── */

/** 汉字与假名。**谚文不在内**：ko 那一档要的是谚文出现，不是禁止它。 */
const HAN_KANA = /[㐀-䶿一-鿿぀-ヿ]/u;

/** ko 里合法的「谚文词 + 括号汉字注」形态（`대사(對帳)`）。剥的是形态，不是某一处。 */
const KO_HANJA_GLOSS = /[가-힣]\s*[(（][㐀-䶿一-鿿]+[)）]/gu;

/**
 * 语言切换行：它逐字带着另外几种语言的自名（`[简体中文](../zh-CN/…)`），六份文档
 * 每份恰好一行，五种语言都一样。
 *
 * ⚠️ **判据是「这一行有 ≥3 条跨语言链接」，不是行号也不是那几个自名**：写死行号会随
 * 排版漂，写死自名等于把「简体中文」四个字加进一张豁免名册。
 * ⚠️ **边界**：正文里若真出现一行同时挂着三条以上跨语言链接，那一行的 CJK 会被一起
 * 跳过。今天全仓只有切换行是这个形状（下面那格夹具从反面钉着「两条链接不够」）。
 *
 * ⚠️ **两种载体都要收（P3f 阶段 5B）**：模板的头部块是 HTML，切换行从
 * `[简体中文](../zh-CN/README.md)` 变成 `<a href="../zh-CN/README.md">简体中文</a>`。
 * 只认 markdown 那一种的话，`docs/en/README.md` 换上 HTML 头部块的当天，切换行里
 * 另外三种语言的自名（简体中文 / 繁體中文 / 日本語）会被整行判成「没翻译」——
 * 而那正是这条判据**唯一**打算放过去的东西。判据要的是「这一行有 ≥3 条跨语言链接」，
 * 那是语义；markdown 与 HTML 只是同一件事的两种写法，认一种就是把判据绑在了排版上。
 * 下面那格夹具对两种载体各钉了一条正例，且「两条不够」的反例照旧。
 */
const CROSS_LANG_LINK = /(?:\]\(|href=")\.\.\/(?:zh-CN|zh-TW|en|ja|ko)\//g;
const isSwitcherLine = (line: string): boolean => (line.match(CROSS_LANG_LINK) ?? []).length >= 3;

/**
 * 一份文档里「没翻译」的嫌疑行。**剥围栏与 code span 走的是上面 R3/R6 那两处真源**
 *（`outsideFences()`，以及与 `codeSpans()` 逐字同一条允许跨行的正则），不另写第二份。
 */
function untranslatedLines(src: string, lang: "en" | "ko"): string[] {
  const prose = outsideFences(src).replace(/`[^`]+`/g, " ");
  const out: string[] = [];
  prose.split("\n").forEach((line, i) => {
    if (isSwitcherLine(line)) return;
    const probe = lang === "ko" ? line.replace(KO_HANJA_GLOSS, " ") : line;
    if (HAN_KANA.test(probe)) out.push(`${i + 1}: ${line.trim()}`);
  });
  return out;
}

describe("「某一份根本没翻译」：en 与 ko 的正文里不许有汉字假名", () => {
  for (const lang of ["en", "ko"] as const) {
    it(`docs/${lang} 的六份文档，剥掉围栏 / 行内 code / 语言切换行之后一个汉字假名都没有`, () => {
      const failures: string[] = [];
      for (const doc of DOCS) {
        const hits = untranslatedLines(realDoc(doc)(lang), lang);
        if (hits.length > 0) {
          failures.push(`docs/${lang}/${doc}.md 有 ${hits.length} 行：\n    ${hits.join("\n    ")}`);
        }
      }
      expect(
        failures,
        `这几行是**正文**（不在围栏里、也不在行内 code 里）却带着汉字或假名 —— `
        + "多半是某一段根本没翻译，或者翻译时把原文粘了回去。"
        + "若它确实是必须原样引用的报文，**把它放进围栏或行内 code**（`docs/en/API.md` 里那 174 个"
        + "就是这么处理的），不要来这里开一条豁免：本仓的裁定是豁免名册会变成永久的洞。\n"
        + failures.join("\n"),
      ).toEqual([]);
    });
  }

  /**
   * **上面那条判据的「豁免面今天是活的」控制格。**
   *
   * 少了它，`docs/en/API.md` 那批故意引用哪天被删光之后，上面那两格照样全绿，而
   * 「剥围栏 / 剥 code span」这一步会安安静静地变成一段没有任何东西触发的死代码——
   * 下一个人于是有理由把它简化掉，而简化掉的那一刻 `en/API.md` 会当场红成一片。
   */
  it("控制格：en/API.md 里那批故意的中文报文引用今天真的存在，而且真的全在代码里", () => {
    const src = realDoc("API")("en");
    const all = (src.match(/[㐀-䶿一-鿿぀-ヿ]/gu) ?? []).length;
    const switcher = (src.split("\n").filter(isSwitcherLine).join("\n")
      .match(/[㐀-䶿一-鿿぀-ヿ]/gu) ?? []).length;
    expect(
      all - switcher,
      "docs/en/API.md 里已经没有原样引用的中文报文了 —— 要么它们被删/被翻译了"
      + "（那就该回来把上面两格的剥法与这一格一起重新论证），"
      + "要么它们挪出了代码围栏（那样上面那两格会当场红）",
    ).toBeGreaterThan(0);
    expect(
      untranslatedLines(src, "en"),
      "en/API.md 里那批中文跑到正文里去了 —— 报文原样引用必须待在围栏或行内 code 里",
    ).toEqual([]);
  });

  /**
   * 夹具正反两侧。**六种形态一次说清**：三种不许红（围栏内、行内 code、语言切换行）、
   * 一种 ko 专属不许红（谚文汉字注）、两种必须红（正文整句中文 / ko 正文整行中文）。
   * ⚠️ 反向控制不是可选项：只写「该红时红」的话，把判据写成恒真也全绿。
   */
  it("夹具正反两侧：围栏 / 行内 code / 切换行 / 谚文汉字注不许红，正文里的中文必须红", () => {
    const SWITCH = "**Language:** English | [简体中文](../zh-CN/X.md) | [繁體中文](../zh-TW/X.md)"
      + " | [日本語](../ja/X.md) | [한국어](../ko/X.md)";
    expect(untranslatedLines(SWITCH, "en"), "语言切换行被当成了没翻译").toEqual([]);
    // 模板头部块那一种载体：同一行同一件事，写法是 HTML。当前语言按 W51 不带链接。
    const SWITCH_HTML = "  📖 Documentation: <a href=\"../zh-CN/X.md\">简体中文</a>"
      + " | <a href=\"../zh-TW/X.md\">繁體中文</a> | English"
      + " | <a href=\"../ja/X.md\">日本語</a> | <a href=\"../ko/X.md\">한국어</a>";
    expect(untranslatedLines(SWITCH_HTML, "en"), "HTML 写法的语言切换行被当成了没翻译").toEqual([]);
    expect(
      untranslatedLines("See two docs: [简体中文](../zh-CN/X.md) and [日本語](../ja/X.md).", "en"),
      "只有两条跨语言链接的一行不该被当成切换行放过去",
    ).not.toEqual([]);
    expect(
      untranslatedLines("See two docs: <a href=\"../zh-CN/X.md\">简体中文</a> and <a href=\"../ja/X.md\">日本語</a>.", "en"),
      "HTML 写法里只有两条跨语言链接的一行同样不该被当成切换行放过去",
    ).not.toEqual([]);

    expect(untranslatedLines("The body reads `请求体里没有 model 字段`.", "en"), "行内 code 被当成了没翻译")
      .toEqual([]);
    expect(untranslatedLines("```json\n{ \"message\": \"请求体里没有 model 字段\" }\n```", "en"), "围栏内被当成了没翻译")
      .toEqual([]);
    expect(untranslatedLines("  ```json\n  { \"message\": \"请求体里没有 model 字段\" }\n  ```", "en"), "缩进围栏内被当成了没翻译")
      .toEqual([]);

    expect(untranslatedLines("This paragraph 根本没有翻译成英文。", "en"), "正文里整句中文没被抓住")
      .not.toEqual([]);
    expect(untranslatedLines("この段落は英語に翻訳されていません。", "en"), "正文里整句日文没被抓住")
      .not.toEqual([]);

    expect(untranslatedLines("계산에는 안전한 방향입니다 —— 대사(對帳) 트리거가 줄어들수록", "ko"), "谚文汉字注被当成了没翻译")
      .toEqual([]);
    expect(untranslatedLines("这一段根本没有翻译成韩文。", "ko"), "ko 正文里整行中文没被抓住")
      .not.toEqual([]);
    expect(untranslatedLines("對帳(대사)는 안전합니다", "ko"), "括号在前的裸汉字不该被当成谚文汉字注放过去")
      .not.toEqual([]);
  });

  /**
   * **已知缺口，如实登记（不硬上一个会误伤的判据）。**
   *
   * `ja` 正当地用汉字，`zh-CN` 与 `zh-TW` 共用汉字 ⇒ 上面那条按**字形**分的判据在这三轴上
   * 一格都问不出话。真要补，需要另一份判据：ja 侧要一条「假名比例」阈值（阈值判据在本仓
   * 已被裁定为脆弱），zh 侧要一张简繁字表（那是第二份形态知识）。**本期不开，账记在这里。**
   * ⚠️ 这一格不是散文：它把「今天有判据的是哪两种语言」钉成断言 —— 哪天有人给 ja 或
   * zh 补上判据而忘了改这段话，或者反过来把 en/ko 那两格删掉，这一格当场红。
   */
  it("已知缺口：ja / zh-CN / zh-TW 三轴今天没有「没翻译」判据，理由记在这里", () => {
    const COVERED = ["en", "ko"] as const;
    const uncovered = LANGS.filter((l) => !(COVERED as readonly string[]).includes(l));
    expect(
      [...uncovered].sort(),
      "「哪几种语言今天没有判据」变了 —— 要么有人补上了新判据（那就把 COVERED 与上面那段"
      + "理由一起改），要么有人删掉了 en/ko 那两格（那就是把一条活着的守卫弄没了）",
    ).toEqual(["ja", "zh-CN", "zh-TW"]);
    // 反面：被覆盖的那两种今天真的各有一格在跑（上面那圈 `it` 就是按这张表生成的）。
    expect([...COVERED].sort(), "COVERED 与上面那圈用例的取数分了家").toEqual(["en", "ko"]);
  });
});

/**
 * ── 本地开发那两条命令（P3e 全分支评审 LOW 回填）────────────────────────────
 *
 * 五份 DEPLOY.md 的「本地开发」原来只写 `npx wrangler dev`，而 `package.json` 里那两条
 * 真正该用的脚本（`dev:worker` / `dev:node`）**五份文档零处提及**。差别不是风格问题：
 * 两条脚本都以 `node scripts/build-ui.mjs` 开头，而面板资源是**生成物**——
 * 裸 `wrangler dev` 起得来，但面板停在上一次生成的那一份，改了 `admin-ui/` 看不到变化。
 *
 * ⚠️ **这一格把那句话的两端都钉住**：脚本名与「以 build-ui 开头」这件事从 `package.json`
 * 现算（脚本改名或者那一段前缀被拿掉 ⇒ 当场红），五份文档各自必须提到这两个脚本名
 * （某一份漏改 ⇒ 当场红并点名）。**只钉一端等于没钉**：只查文档的话脚本改名不会红，
 * 只查脚本的话文档漏改不会红。
 */
it("五份 DEPLOY.md 都写着 package.json 里那两条本地开发脚本，而它们确实都先生成面板资源", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const BUILD_UI = "node scripts/build-ui.mjs";
  const names = ["dev:worker", "dev:node"] as const;
  for (const n of names) {
    expect(
      pkg.scripts[n],
      `package.json 里没有 \`${n}\` 了 —— 五份 DEPLOY.md 的「本地开发」正指着它`,
    ).toBeDefined();
    expect(
      pkg.scripts[n],
      `\`${n}\` 不再以 \`${BUILD_UI}\` 开头 —— 五份 DEPLOY.md 里那句`
      + "「两条都以 node scripts/build-ui.mjs 开头」当场变成假话，"
      + "而它正是「别用裸 wrangler dev」那条建议的全部理由",
    ).toMatch(new RegExp(`^${BUILD_UI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
  }
  const missing: string[] = [];
  for (const lang of LANGS) {
    const src = realDoc("DEPLOY")(lang);
    for (const n of names) if (!src.includes(`pnpm ${n}`)) missing.push(`docs/${lang}/DEPLOY.md 没提到 \`pnpm ${n}\``);
    if (!src.includes(BUILD_UI)) missing.push(`docs/${lang}/DEPLOY.md 没写出 \`${BUILD_UI}\` 这条前提`);
  }
  expect(missing, missing.join("\n")).toEqual([]);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 五份 SPONSORS.md 的字面恒等式（P3f 阶段 4 评审回填：W33 的验收 ①②③⑤）
 *
 * 这五份文档落地那一笔（W32/W33/W34/W36/W37）声称验收过四项恒等式——
 * ①「`## ` 序列 `toEqual` 该语言的译名」②「`^---$` == 2」③「4 步 git 命令与 4 条 bullet
 * 逐字节命中固定串」⑤「相对链接零 broken」——**而这四项当时一条都没落成判据**，
 * 全靠一次性 shell 跑出来的计数。`toEqual` 是断言，`grep -c` 不是。
 *
 * 阶段 4 评审的两条变异实测（都在盘上真跑过，全绿）：
 * · 变异 D：只改 `docs/zh-CN/SPONSORS.md` 一份，同时违反 ①②③ —— H2 改名、删掉第二条
 *   `---`、把 `git commit -m "feat: add something"` 改成 `chore: whatever`、把 ⭐ 那条
 *   bullet 换掉。整套用例**全绿**。原因是这份文档当天唯一活着的守卫只有 R2（heading
 *   **层级**序列 `[1,2,2]`，不看标题文字）与 R4（链接多重集）：改标题不动层级、
 *   删 `---` 不动 heading、改 git 命令不动链接。
 * · 变异 E：给五份各加一行 `[x](./NOPE.md)`（五份一致所以 R4 也不红）。同样**全绿**——
 *   坏链判据当天的射程只有根 `README.md`，`docs/**` 一份都不在里面。
 *
 * ⇒ 本组把那四项各自落成判据，并按本仓体例各配「该红时红」。
 *
 * ── 边界（明写，别读成「这五份文档从此都是对的」）──────────────────────────
 * · ① 只钉**标题这三行的字面**，不钉正文一个字。导语、`**贡献方向：**` 那段、
 *   五条方向 bullet 里除末两条之外的部分，今天都没有判据（末两条由 W35 那一笔的
 *   「与两仓末两条 bullet 逐字一致」管着，那是另一组）。
 * · ② 只数 `^---$`，不管它们分割出来的是不是想要的那几段。
 * · ③ 只钉四步的**条数**与两条 git 命令的**字面**；四步各自的说明文字逐语言不同，
 *   由 ③b 的 bullet 表之外**没有**判据——那是登记在案的缺口，不是「已经覆盖」。
 * · ⑤ 的射程是 `docs/` 下递归到的每一份 `.md`（不只 SPONSORS），但它**只查落点存不存在、是不是
 *   文件**：`#锚点` 那一段一律截掉不查（跨文档锚点要 slug 化，那是 R17 统一治理的活，
 *   本轮不做）。**而 SPONSORS.md 这五份今天一条相对链接都没有**（唯一那条 Issue 链接是
 *   绝对 URL）⇒ ⑤ 对 SPONSORS 本身是一格空判据，真正看着它那条链接的是 R4 的
 *   「五份链接多重集相等」。这件事下面单配一格钉住**今天的事实**，哪天有人给它加了
 *   第一条相对链接，那一格会红并把人带回这段话。
 * · 根 `SPONSORS.md`（不在 `docs/` 下的那一份）**不在本组射程**：它归 W35/W67。
 *   顺带记一条给那一档的人：根那份的 🐛 bullet 写的是「提交 Issue 反馈 bug 或建议」，
 *   **没有** `docs/zh-CN/SPONSORS.md` 那条 `[Issue](…)` 链接——两份是不是该一致，
 *   本轮没判，也没有判据在看。
 * ────────────────────────────────────────────────────────────────────────── */
describe("五份 SPONSORS.md 的字面恒等式（W33 的验收 ①②③⑤）", () => {
  /** ① 逐字抄 T3 §4.1 那张译名表。H2-2「交流群」整列按 V40 不取，所以每种语言三项不是四项。 */
  const SPONSORS_HEADINGS: Record<Lang, readonly [string, string, string]> = {
    "zh-CN": ["# ☕ 赞赏 & 共享", "## 💖 支持项目", "## 🤝 参与贡献"],
    "zh-TW": ["# ☕ 贊賞 & 共享", "## 💖 支持專案", "## 🤝 參與貢獻"],
    en: ["# ☕ Support & Contribute", "## 💖 Support the Project", "## 🤝 Contributing"],
    ja: ["# ☕ サポート & 貢献", "## 💖 プロジェクトをサポート", "## 🤝 貢献する"],
    ko: ["# ☕ 후원 & 기여", "## 💖 프로젝트 지원", "## 🤝 기여하기"],
  };

  /** ③b 四条支持 bullet，逐语言逐字节。emoji 前缀五份相同，后面的话逐语言不同。 */
  const SPONSORS_BULLETS: Record<Lang, readonly [string, string, string, string]> = {
    "zh-CN": [
      "- ⭐ 给项目点个 Star",
      "- 🔗 分享给有需要的朋友",
      "- 🐛 提交 [Issue](https://github.com/xwteam/agnes2api/issues) 反馈 bug 或建议",
      "- 🔧 提交 PR 贡献代码或文档",
    ],
    "zh-TW": [
      "- ⭐ 給專案點個 Star",
      "- 🔗 分享給有需要的朋友",
      "- 🐛 提交 [Issue](https://github.com/xwteam/agnes2api/issues) 回饋 bug 或建議",
      "- 🔧 提交 PR 貢獻程式碼或文件",
    ],
    en: [
      "- ⭐ Star the project",
      "- 🔗 Share with friends who might need it",
      "- 🐛 Submit an [Issue](https://github.com/xwteam/agnes2api/issues) to report bugs or suggestions",
      "- 🔧 Submit PRs to contribute code or documentation",
    ],
    ja: [
      "- ⭐ プロジェクトにスターを付ける",
      "- 🔗 必要としている友人と共有する",
      "- 🐛 バグや提案を[Issue](https://github.com/xwteam/agnes2api/issues)で報告する",
      "- 🔧 コードやドキュメントをPRで貢献する",
    ],
    ko: [
      "- ⭐ 프로젝트에 스타 주기",
      "- 🔗 필요한 친구들과 공유하기",
      "- 🐛 버그나 제안을 [Issue](https://github.com/xwteam/agnes2api/issues)로 제출하기",
      "- 🔧 코드나 문서를 PR로 기여하기",
    ],
  };

  /** ③ 两条 git 命令：**语言无关**，五份逐字节相同，各恰出现一次。 */
  const GIT_COMMANDS = [
    "`git checkout -b feature/your-feature`",
    "`git commit -m \"feat: add something\"`",
  ] as const;

  type LangRead = (lang: Lang) => string;
  const realSponsors: LangRead = (l) => readFileSync(docPath(".", l, "SPONSORS"), "utf8");
  /** 变异的唯一注入点：换掉某一种语言那份的内容，其余照旧。 */
  const patchLang = (base: LangRead, at: Lang, body: string): LangRead => (l) => (l === at ? body : base(l));

  /** 变异格的基自检，与本文件其它组同一套口径。 */
  const probeGreen = (failures: readonly string[], realCase: string): void => {
    if (failures.length > 0) {
      throw new Error(`本格是探针，它的基取自真仓，而真仓今天本身就不过这条判据 —— 真因在「${realCase}」那一格：\n${failures.join("\n")}`);
    }
  };

  /* ── ① 标题三行 ──────────────────────────────────────────────────────── */
  const REAL_1 = "① 五份 SPONSORS.md 的标题逐字等于 T3 §4.1 那张译名表";

  const headingLines = (src: string): string[] =>
    outsideFences(src).split("\n").filter((l) => /^#{1,6} /.test(l));

  const headingFailures = (read: LangRead): string[] => {
    const out: string[] = [];
    for (const lang of LANGS) {
      const got = headingLines(read(lang));
      if (got.length === 0) {
        throw new Error(`docs/${lang}/SPONSORS.md 里一个标题都没抽出来 —— 判据坏了，不许静默当成「标题都对」`);
      }
      const want = SPONSORS_HEADINGS[lang];
      if (got.length !== want.length || got.some((h, i) => h !== want[i])) {
        out.push(`docs/${lang}/SPONSORS.md 的标题序列与登记表对不上：\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`);
      }
    }
    return out;
  };

  it(REAL_1, () => {
    const failures = headingFailures(realSponsors);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("① 该红时红：zh-CN 的 H2 改成别的名字 —— 层级没变，R2 不会红，本格必须红", () => {
    probeGreen(headingFailures(realSponsors), REAL_1);
    const mutated = realSponsors("zh-CN").replace("## 💖 支持项目", "## 💖 随便什么标题");
    expect(mutated, "变异没落地").not.toBe(realSponsors("zh-CN"));
    const failures = headingFailures(patchLang(realSponsors, "zh-CN", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("docs/zh-CN/SPONSORS.md 的标题序列与登记表对不上");
  });

  it("① 认不出要吵：某一份一个标题都抽不出来时当场抛，不静默当成「标题都对」", () => {
    const blind = patchLang(realSponsors, "ja", "没有任何标题的一段话\n");
    expect(() => headingFailures(blind)).toThrow(/判据坏了/);
  });

  /* ── ② 分隔线条数 = 节数（C30）─────────────────────────────────────────── */
  const HR_COUNT = 2;
  const REAL_2 = `② 五份 SPONSORS.md 各恰有 ${HR_COUNT} 条 \`---\`（= 节数；模板是 3 条，少的那条是 V40 删掉交流群节的刻意偏离）`;

  const hrFailures = (read: LangRead): string[] =>
    LANGS
      .map((lang) => [lang, outsideFences(read(lang)).split("\n").filter((l) => l === "---").length] as const)
      .filter(([, n]) => n !== HR_COUNT)
      .map(([lang, n]) => `docs/${lang}/SPONSORS.md 有 ${n} 条 \`---\`，不是 ${HR_COUNT} 条 —— 分隔线条数与节数是绑在一起的，对不上说明少了一节或多了一条线`);

  it(REAL_2, () => {
    const failures = hrFailures(realSponsors);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("② 该红时红：删掉第二条 `---` —— heading 一个没动，R2 不会红，本格必须红", () => {
    probeGreen(hrFailures(realSponsors), REAL_2);
    const src = realSponsors("zh-CN");
    const at = src.lastIndexOf("\n---\n");
    expect(at, "文档里找不到第二条 `---`，变异打偏了").toBeGreaterThan(0);
    const mutated = src.slice(0, at) + src.slice(at + "\n---".length);
    expect(mutated, "变异没落地").not.toBe(src);
    const failures = hrFailures(patchLang(realSponsors, "zh-CN", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain(`有 ${HR_COUNT - 1} 条 \`---\``);
  });

  /* ── ③ 四步贡献流程 + 两条 git 命令 ───────────────────────────────────── */
  const STEP_COUNT = 4;
  const REAL_3 = "③ 五份 SPONSORS.md 的参与贡献都是四步，两条 git 命令逐字节各出现一次";

  const contribFailures = (read: LangRead): string[] => {
    const out: string[] = [];
    for (const lang of LANGS) {
      const src = outsideFences(read(lang));
      const steps = src.split("\n").filter((l) => /^\d+\. /.test(l));
      if (steps.length !== STEP_COUNT) {
        out.push(`docs/${lang}/SPONSORS.md 的参与贡献是 ${steps.length} 步，不是 ${STEP_COUNT} 步`);
      } else {
        const numbers = steps.map((l) => Number.parseInt(l, 10));
        if (numbers.some((n, i) => n !== i + 1)) {
          out.push(`docs/${lang}/SPONSORS.md 的四步编号是 ${JSON.stringify(numbers)}，不是 1..${STEP_COUNT}`);
        }
      }
      for (const cmd of GIT_COMMANDS) {
        const n = src.split(cmd).length - 1;
        if (n !== 1) out.push(`docs/${lang}/SPONSORS.md 里 ${cmd} 出现了 ${n} 次，不是 1 次 —— 这两条命令是语言无关的固定串，五份必须逐字节相同`);
      }
    }
    return out;
  };

  it(REAL_3, () => {
    const failures = contribFailures(realSponsors);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("③ 该红时红：commit 消息从 `feat: add something` 改成别的 —— 点名那条命令", () => {
    probeGreen(contribFailures(realSponsors), REAL_3);
    const mutated = realSponsors("zh-CN").replace('git commit -m "feat: add something"', 'git commit -m "chore: whatever"');
    expect(mutated, "变异没落地").not.toBe(realSponsors("zh-CN"));
    const failures = contribFailures(patchLang(realSponsors, "zh-CN", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("feat: add something");
  });

  it("③ 该红时红：四步删成三步 —— 点名是哪一份、剩了几步", () => {
    probeGreen(contribFailures(realSponsors), REAL_3);
    const mutated = realSponsors("en").replace(/^4\. .*\n/m, "");
    expect(mutated, "变异没落地").not.toBe(realSponsors("en"));
    const failures = contribFailures(patchLang(realSponsors, "en", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain(`是 ${STEP_COUNT - 1} 步`);
  });

  /* ── ③b 四条支持 bullet 逐字节 ────────────────────────────────────────── */
  const REAL_3B = "③b 五份 SPONSORS.md 的四条支持 bullet 逐字节等于登记表";

  const bulletFailures = (read: LangRead): string[] => {
    const out: string[] = [];
    for (const lang of LANGS) {
      const want = SPONSORS_BULLETS[lang];
      // ⚠️ `u` 标志不能省：🔗 / 🐛 / 🔧 都在 BMP 之外，没有 `u` 时字符类会被按代理对的
      // **半个码元**拆开，实测只有 ⭐（U+2B50，在 BMP 内）能匹配上，四条只抽到一条。
      const got = outsideFences(read(lang)).split("\n").filter((l) => /^- [⭐🔗🐛🔧] /u.test(l));
      if (got.length === 0) {
        throw new Error(`docs/${lang}/SPONSORS.md 里一条支持 bullet 都没抽出来 —— 判据坏了，不许静默当成「四条都对」`);
      }
      if (got.length !== want.length || got.some((b, i) => b !== want[i])) {
        out.push(`docs/${lang}/SPONSORS.md 的四条支持 bullet 与登记表对不上：\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`);
      }
    }
    return out;
  };

  it(REAL_3B, () => {
    const failures = bulletFailures(realSponsors);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("③b 该红时红：⭐ 那条 bullet 换掉文案 —— 层级、链接、表格行数都不动，只有本格看得见", () => {
    probeGreen(bulletFailures(realSponsors), REAL_3B);
    const mutated = realSponsors("zh-CN").replace("- ⭐ 给项目点个 Star", "- ⭐ 随便写点什么");
    expect(mutated, "变异没落地").not.toBe(realSponsors("zh-CN"));
    const failures = bulletFailures(patchLang(realSponsors, "zh-CN", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("四条支持 bullet 与登记表对不上");
  });

  /* ── ⑤ docs/** 的相对链接零 broken ────────────────────────────────────── */
  const REAL_5 = "⑤ docs/ 下每一份 .md 里的相对链接都指向磁盘上真实存在的文件";

  /** 射程从磁盘现列，多一种语言 / 多一份文档当天就进射程，不手抄第二份名单。 */
  const docsMdFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) out.push(p);
      }
    };
    walk("docs");
    return out.sort();
  };

  /** markdown 链接与 HTML `href` 两种载体一起收；`http(s)` / `mailto:` / 纯锚点不算相对链接。 */
  const relTargetsOf = (body: string): string[] =>
    [...outsideFences(body).matchAll(/\]\(([^)\s]+)\)|href="([^"]+)"/g)]
      .map((m) => m[1] ?? m[2] ?? "")
      .filter((t) => t !== "" && !/^(?:https?:|mailto:|#)/.test(t));

  const brokenDocLinks = (read: (p: string) => string, files: readonly string[]): string[] => {
    const out: string[] = [];
    let scanned = 0;
    for (const f of files) {
      for (const t of relTargetsOf(read(f))) {
        scanned += 1;
        // `#锚点` 那一段截掉不查：跨文档锚点要 slug 化，那是 R17 统一治理的活，本轮不做。
        const target = join(dirname(f), t.split("#")[0] ?? "");
        if (!existsSync(target)) out.push(`${f} 里的 \`${t}\` 解析到 ${target}，那儿没有东西`);
        else if (!statSync(target).isFile()) out.push(`${f} 里的 \`${t}\` 解析到 ${target}，那是个目录不是文件 —— 点开是列目录，不是那份文档`);
      }
    }
    if (scanned === 0) {
      throw new Error("docs/ 下一条相对链接都没抽到 —— 判据坏了，不许静默当成「零 broken」");
    }
    return out;
  };

  const realFileRead = (p: string) => readFileSync(p, "utf8");
  const patchFile = (base: (p: string) => string, at: string, body: string) => (p: string) => (p === at ? body : base(p));

  it(REAL_5, () => {
    const failures = brokenDocLinks(realFileRead, docsMdFiles());
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("⑤ 该红时红：某一份文档里多出一条 `./NOPE.md` —— 五份一致所以 R4 不会红，本格必须红", () => {
    probeGreen(brokenDocLinks(realFileRead, docsMdFiles()), REAL_5);
    const at = docPath(".", "zh-CN", "SPONSORS");
    const mutated = `${realFileRead(at)}\n[x](./NOPE.md)\n`;
    const failures = brokenDocLinks(patchFile(realFileRead, at, mutated), docsMdFiles());
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("NOPE.md");
  });

  it("⑤ 该红时红：链接指到一个目录 —— 「在磁盘上存在」不够，还得是文件", () => {
    probeGreen(brokenDocLinks(realFileRead, docsMdFiles()), REAL_5);
    const at = docPath(".", "en", "SPONSORS");
    const mutated = `${realFileRead(at)}\n[x](../ja)\n`;
    const failures = brokenDocLinks(patchFile(realFileRead, at, mutated), docsMdFiles());
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("那是个目录不是文件");
  });

  it("⑤ 认不出要吵：一条相对链接都抽不到时当场抛，不静默当成「零 broken」", () => {
    // ⚠️ `relTargetsOf` 收的是**两种载体**：markdown 的 `](…)` 与 HTML 的 `href="…"`。
    //   这条变异原先只弄瞎前一种——阶段 5B 给 `docs/{lang}/README.md` 换上模板的 HTML
    //   头部块（语言切换行是 `<a href="../zh-TW/README.md">`）之后，弄瞎 markdown 那一半
    //   照旧抽得到 HTML 那一半，`scanned` 不为 0，这一格当场变成「不该抛却没抛」。
    //   **两种载体都得弄瞎**，否则这一格证明不了「抽不到就抛」。
    const blind = (p: string) => realFileRead(p).split("](").join("] (").split('href="').join('hre f="');
    expect(() => brokenDocLinks(blind, docsMdFiles())).toThrow(/判据坏了/);
  });

  it("⑤ 不乱红：绝对链接、mailto 与纯锚点都不是相对链接，不许被判成坏链", () => {
    probeGreen(brokenDocLinks(realFileRead, docsMdFiles()), REAL_5);
    const at = docPath(".", "ko", "SPONSORS");
    const mutated = `${realFileRead(at)}\n[a](https://example.com/nope)\n[b](mailto:nobody@example.com)\n[c](#기여하기)\n`;
    expect(brokenDocLinks(patchFile(realFileRead, at, mutated), docsMdFiles())).toEqual([]);
  });

  it("⑤ 的射程边界：五份 SPONSORS.md 今天一条相对链接都没有 —— 所以 ⑤ 对它是空判据，看着那条 Issue 链接的是 R4", () => {
    const counts = LANGS.map((l) => [l, relTargetsOf(realSponsors(l)).length] as const);
    expect(
      counts.filter(([, n]) => n !== 0),
      "SPONSORS.md 里出现了第一条相对链接 —— ⑤ 从这一刻起对它不再是空判据了，"
      + "回到本组顶上那段「边界」把这句话改真（它现在是假的）",
    ).toEqual([]);
  });
});

/**
 * W136 —— 「某份文档里有 X」这种**跨文档指认**必须为真（P3f 阶段 5B 第 1 轮评审回填）。
 *
 * ── 它补的是哪个洞 ────────────────────────────────────────────────────────
 * 阶段 5A 的 `cde41db` 把一颗 `Deploy to Cloudflare` 按钮从根 README 删掉，阶段 5B 的
 * W40–W44 五笔（`e7ece1e` / `943a3d3` / `bfaf387` / `bf3193a` / `99ac29c`）在重写各自那份
 * README 时把它从**五份**语言版删掉，全仓从此零命中。
 * ⚠️ 这一段原先把功劳记在 `ba5a076` 头上，**是错的**——`git log -S deploy.workers.cloudflare.com`
 *   的命中集合里没有它，`git show ba5a076:docs/{lang}/README.md` 逐份仍各有 1 处。
 *   写错还能活下来的原因值得记：`check-comment-refs` 只校验注释里的**仓内路径**，
 *   **commit id 是零判据区**——这一段的归因错不了任何一格。**可是五份 DEPLOY.md
 * 仍逐字指着它**，而且写在「方式一 / Option A」这个首选路径上：读者照着打开根 README，
 * 那儿什么按钮都没有。五份语言版同时说着同一句假话，阶段 5A/5B 全程绿着走完。
 *
 * **为什么一格都没红**（这是本组存在的全部理由）：
 * - `scripts/check-comment-refs.mjs` 只看**代码注释**里的仓内路径，够不着 markdown
 *   （ADJ §59 已把这条失明登记在案）。
 * - 上一组的 ⑤ 看的是**链接解析得开**：`[README](../../README.md)` 那条链接一直是好的，
 *   坏的是「那份 README 里有一颗按钮」这句**关于目标内容的断言**。⑤ 的注释自己写着
 *   跨文档锚点不在它射程内 —— 那正好是本组接手的地方。
 * - R2–R6 只比五种语言之间的派生结构；五份**一起**指着同一个不存在的东西，它们全绿。
 *
 * ⇒ 本组守两件事，都是「指认 vs 真实存在」这一条轴：
 *   **(A) 活着的那一半**：五份 DEPLOY.md 各自指着**同目录** README 的「快速部署」节，
 *        那一节必须在那份 README 里真的以标题行的形态存在。改掉任一份 README 的那个
 *        标题而不改 DEPLOY.md ⇒ 当场红并点名是哪两份文档。这一半今天有五条真断言，
 *        不是空判据。
 *   **(B) 蕴含式那一半**：根 README + `docs/` 下任何一份 .md 只要提到那颗按钮
 *        （标签字面或 `deploy.workers.cloudflare.com` 那个 markup），根 README 里就
 *        必须真的有它。**今天前件为空**（全仓零命中，按钮已按下面那条裁定弃用），
 *        所以它今天是恒真的——恒真的判据在本仓不许白挂着，因此它配了**两侧夹具**：
 *        「文档提到、根上没有」必须红并点名是哪一份；「文档提到、根上真有」必须绿。
 *        少了这两格，(B) 就是一段没有任何东西触发的死代码。
 *
 * ── 按钮为什么是弃用而不是恢复（回填时的裁定，理由可机器复核）────────────────
 * 评审建议过「把按钮放回根 README，让方式一当场重新为真，净损失归零」。**不采纳**，
 * 因为那条路在本仓**证明走不通**，恢复它等于把一句假话换成另一句假话：
 * ① `wrangler.toml` 的 KV namespace id 恒为占位符 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`，
 *    而且这件事由 `scripts/check-wrangler-placeholder.mjs` 在 CI 里钉死（ci.yml 第 8 道）
 *    —— 一键流程克隆的就是这份 `wrangler.toml`，`wrangler deploy` 拿着这个 id 起不来。
 * ② `GATEWAY_TOKEN` 是必填值，`src/core/config.ts` 读不到它直接
 *    `throw new Error("缺少 GATEWAY_TOKEN，网关无法启动")` —— 一键流程设不了 secret。
 * 被删那段原文自己就承认了这两点（「按钮本身不会帮你配置这两项」）。⇒ 弃用是对的，
 * 五份 DEPLOY.md 的方式一同批改写成不依赖按钮的说法，并把「为什么没有一键按钮」
 * 写成读者看得见的 `[!NOTE]`。**净损失不是零，但被删掉的那件事本来就办不成。**
 *
 * ⚠️ 本组按 ADJ §61 那条规矩写：被弃用的字面**只出现在判据里，不出现在文档里**。
 * 五份 DEPLOY.md 的 `[!NOTE]` 里一个 `Deploy to Cloudflare` 都没有（写的是
 * 「一键部署按钮 / one-click Cloudflare deploy button / ワンクリックデプロイボタン /
 * 원클릭 배포 버튼」），否则 (B) 会被自己的否定句触发。
 */
describe("跨文档指认的真实性：文档里说「那份 README 里有 X」，X 就得真在（W136）", () => {
  /** 变异的唯一注入点：换掉某一条路径的内容，其余照旧。 */
  const readFile = (p: string) => readFileSync(p, "utf8");
  const patchPath = (base: (p: string) => string, at: string, body: string) =>
    (p: string) => (p === at ? body : base(p));

  const probeGreen = (failures: readonly string[], realCase: string): void => {
    if (failures.length > 0) {
      throw new Error(`本格是探针，它的基取自真仓，而真仓今天本身就不过这条判据 —— 真因在「${realCase}」那一格：\n${failures.join("\n")}`);
    }
  };

  /* ── (A) 五份 DEPLOY.md → 同目录 README 的「快速部署」节 ─────────────────── */

  /**
   * 逐语言登记：DEPLOY.md 里那句指认写的是哪一节、那一节在同目录 README 里长什么样。
   *
   * ⚠️ **`section` 必须是该语言 README 里那行标题的逐字全文**（含 `## ` 与 emoji）：
   * 判据在 README 一侧按**行首整行**匹配，只写「快速部署」四个字的话，正文里随便
   * 一句提到这个词都能让它绿，那就又成了一条看着像在守、其实什么都没守的判据。
   * ⚠️ **DEPLOY 一侧按行内 code span 匹配**（文档里写成 `` `## ⚡ 快速部署` ``）：
   * en/ko 的正文不许有汉字假名（见上面那一组），把节名放进 code span 是那一组
   * 指定的载体；这里顺带也就有了一个稳定、不会被翻译改写的锚。
   */
  const README_SECTION_CLAIMS: Readonly<Record<Lang, string>> = {
    "zh-CN": "## ⚡ 快速部署",
    "zh-TW": "## ⚡ 快速部署",
    en: "## ⚡ Quick Deployment",
    ja: "## ⚡ クイックデプロイ",
    ko: "## ⚡ 빠른 배포",
  };

  /** 五份 DEPLOY.md 里允许出现的 README 链接目标。**同目录那一条，不是根那一条。** */
  const ALLOWED_README_LINK_TARGETS = ["README.md"] as const;

  const readmeLinkTargets = (body: string): string[] =>
    [...outsideFences(body).matchAll(/\]\(([^)\s]+)\)|href="([^"]+)"/g)]
      .map((m) => m[1] ?? m[2] ?? "")
      .filter((t) => t.split("#")[0]?.endsWith("README.md") === true)
      .sort();

  const sectionClaimFailures = (read: (p: string) => string): string[] => {
    const out: string[] = [];
    let checked = 0;
    for (const lang of LANGS) {
      const deployPath = docPath(".", lang, "DEPLOY");
      const readmePath = docPath(".", lang, "README");
      const section = README_SECTION_CLAIMS[lang];
      const deployBody = read(deployPath);
      const readmeBody = read(readmePath);

      // 指认端：DEPLOY.md 里那句话还在不在。没了就不是「指认为假」，是「指认没了」——
      // 同样要红：这一格是它唯一的守卫，静默消失等于本组从此对这一语言失明。
      if (!deployBody.includes(`\`${section}\``)) {
        out.push(`${deployPath} 里找不到指着 \`${section}\` 的那句话 —— 要么它被删了（那本组对 ${lang} 就没在守任何东西了），要么节名改了而登记表没跟上`);
        continue;
      }
      checked += 1;
      // 被指认端：那一节必须在同目录 README 里以**标题行**的形态真实存在。
      const alive = readmeBody.split("\n").some((l) => l === section);
      if (!alive) {
        out.push(`${deployPath} 指着 ${readmePath} 的 \`${section}\` 一节，但那份 README 里没有这行标题 —— 读者点过去会扑空`);
      }
    }
    if (checked === 0) {
      throw new Error("五份 DEPLOY.md 里一句跨文档指认都没抽到 —— 判据坏了，不许静默当成「指认都为真」");
    }
    return out;
  };

  const linkTargetFailures = (read: (p: string) => string): string[] => {
    const out: string[] = [];
    for (const lang of LANGS) {
      const deployPath = docPath(".", lang, "DEPLOY");
      const got = readmeLinkTargets(read(deployPath));
      const want = [...ALLOWED_README_LINK_TARGETS];
      if (got.length !== want.length || got.some((t, i) => t !== want[i])) {
        out.push(`${deployPath} 里指向 README 的链接目标与登记表对不上：\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`);
      }
    }
    return out;
  };

  const REAL_A = "(A) 五份 DEPLOY.md 指着同目录 README 的那一节，五份 README 里都真有这行标题";

  it(REAL_A, () => {
    const failures = sectionClaimFailures(readFile);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(A) 该红时红：把 docs/ja/README.md 的那行标题改名 —— 链接照样解析得开，⑤ 不会红，本格必须红并点名两份文档", () => {
    probeGreen(sectionClaimFailures(readFile), REAL_A);
    const at = docPath(".", "ja", "README");
    const mutated = readFile(at).replace("## ⚡ クイックデプロイ", "## ⚡ 別の名前");
    expect(mutated, "变异没落地").not.toBe(readFile(at));
    const failures = sectionClaimFailures(patchPath(readFile, at, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("docs/ja/DEPLOY.md");
    expect(failures[0] ?? "").toContain("docs/ja/README.md");
  });

  it("(A) 该红时红：把 docs/ko/DEPLOY.md 里那句指认整段删掉 —— 指认没了也要红，不许静默失明", () => {
    probeGreen(sectionClaimFailures(readFile), REAL_A);
    const at = docPath(".", "ko", "DEPLOY");
    const mutated = readFile(at).replace("`## ⚡ 빠른 배포`", "그 절");
    expect(mutated, "变异没落地").not.toBe(readFile(at));
    const failures = sectionClaimFailures(patchPath(readFile, at, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("要么它被删了");
  });

  it("(A) 认不出要吵：五份的指认一句都抽不到时当场抛，不静默当成「指认都为真」", () => {
    const blind = (p: string) => (p.endsWith("DEPLOY.md") ? "什么指认都没有的一段话\n" : readFile(p));
    expect(() => sectionClaimFailures(blind)).toThrow(/判据坏了/);
  });

  it("(A) 闭合：五份 DEPLOY.md 里指向 README 的链接目标恰好是登记的那些（同目录那条）", () => {
    const failures = linkTargetFailures(readFile);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(A) 闭合该红时红：往 zh-CN/DEPLOY.md 里加一条指向根 README 的链接 —— 它解析得开，⑤ 不会红，本格必须红", () => {
    probeGreen(linkTargetFailures(readFile), "(A) 闭合");
    const at = docPath(".", "zh-CN", "DEPLOY");
    const mutated = `${readFile(at)}\n见根目录 [README](../../README.md) 里的那颗按钮。\n`;
    const failures = linkTargetFailures(patchPath(readFile, at, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("docs/zh-CN/DEPLOY.md");
    expect(failures[0] ?? "").toContain("../../README.md");
  });

  /* ── (B) 那颗按钮：提到它 ⇒ 根 README 里必须真有它 ────────────────────── */

  /** 按钮的两个字面：读者看见的标签，与它在 markdown 里的 markup 主机名。 */
  const BUTTON_LABEL = "Deploy to Cloudflare";
  const BUTTON_MARKUP = "deploy.workers.cloudflare.com";

  /** 射程：根 README + `docs/` 下每一份 .md，从磁盘现列，不手抄第二份名单。 */
  const buttonScanFiles = (): string[] => {
    const out: string[] = ["README.md"];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) out.push(p);
      }
    };
    walk("docs");
    return out;
  };

  const buttonClaimFailures = (read: (p: string) => string, files: readonly string[]): string[] => {
    if (files.length === 0) throw new Error("按钮扫描的射程是空的 —— 判据坏了，不许静默当成「没人提到按钮」");
    const rootHasButton = read("README.md").includes(BUTTON_MARKUP);
    const out: string[] = [];
    for (const f of files) {
      const body = read(f);
      if (body.length === 0) throw new Error(`${f} 读出来是空的 —— 判据坏了，不许静默当成「这一份没提到按钮」`);
      if (f === "README.md") continue; // 根自己不算「指认」，它是被指认的那一方
      if ((body.includes(BUTTON_LABEL) || body.includes(BUTTON_MARKUP)) && !rootHasButton) {
        out.push(`${f} 提到了那颗一键部署按钮，可根 README 里没有它（找不到 \`${BUTTON_MARKUP}\`）—— 这是一条指向不存在元素的死指认`);
      }
    }
    return out;
  };

  const REAL_B = "(B) 提到那颗一键部署按钮的文档，根 README 里必须真有它";

  it(REAL_B, () => {
    const failures = buttonClaimFailures(readFile, buttonScanFiles());
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(B) 该红时红：某份 DEPLOY.md 把按钮那句话写回去、而根上没有按钮 ⇒ 红并点名是哪一份", () => {
    probeGreen(buttonClaimFailures(readFile, buttonScanFiles()), REAL_B);
    const at = docPath(".", "en", "DEPLOY");
    const mutated = `${readFile(at)}\n### Option A — ${BUTTON_LABEL} button\n\nClick the button in the root [README](../../README.md).\n`;
    const failures = buttonClaimFailures(patchPath(readFile, at, mutated), buttonScanFiles());
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("docs/en/DEPLOY.md");
  });

  it("(B) 不该红时不红：根 README 上真有那颗按钮时，文档指着它是**真话**，不许红", () => {
    const withButton = (p: string) => (p === "README.md"
      ? `${readFile(p)}\n[![${BUTTON_LABEL}](https://${BUTTON_MARKUP}/button)](https://${BUTTON_MARKUP}/?url=x)\n`
      : (p === docPath(".", "en", "DEPLOY")
        ? `${readFile(p)}\nClick the ${BUTTON_LABEL} button in the root README.\n`
        : readFile(p)));
    expect(buttonClaimFailures(withButton, buttonScanFiles())).toEqual([]);
  });

  it("(B) 认不出要吵：射程为空、或某一份读出来是空的时候当场抛", () => {
    expect(() => buttonClaimFailures(readFile, [])).toThrow(/判据坏了/);
    const blind = (p: string) => (p === docPath(".", "ja", "API") ? "" : readFile(p));
    expect(() => buttonClaimFailures(blind, buttonScanFiles())).toThrow(/判据坏了/);
  });

  /* ── 非空锚：登记表与射程今天都是活的 ─────────────────────────────────── */

  it("非空锚：五种语言的期望节名两两不同（除同文的两份中文），且射程覆盖根 README + docs/ 全部 .md", () => {
    // 期望值撞了的话，「这一份抄了那一份」这种坏法就分不出来了。zh-CN / zh-TW 的
    // `## ⚡ 快速部署` 在两岸用词上确实同文，是**实测同形**不是抄错，单列出来。
    const distinct = new Set(Object.values(README_SECTION_CLAIMS));
    expect(distinct.size, `期望节名撞了：${JSON.stringify(README_SECTION_CLAIMS)}`).toBe(LANGS.length - 1);
    expect(README_SECTION_CLAIMS["zh-CN"]).toBe(README_SECTION_CLAIMS["zh-TW"]);

    const files = buttonScanFiles();
    expect(files, "射程里没有根 README —— (B) 的被指认方就没人看了").toContain("README.md");
    expect(files.length, `射程只有 ${files.length} 份，少于「根 1 份 + 五语言 × ${DOCS.length} 份」`)
      .toBe(1 + LANGS.length * DOCS.length);
  });
});

/**
 * ⑧ 五份 README 的 `## 📄` 节末段逐字节登记（P3f 阶段 5B 第 1 轮评审回填，ADJ §63）。
 *
 * ── 它补的是哪个洞 ────────────────────────────────────────────────────────
 * 回填前逐份数「担保 / 擔保 / warranty / 保証 / 보증」这一族字面：
 * **zh-CN=0、zh-TW=0、en=1、ja=2、ko=1**。en/ja/ko 的末段带着「无担保、无支持承诺」
 * 那半句，两份中文语言版**一个字都没有** —— 而五份语言版都没有 `## ⚠ 免责声明` 那一节
 *（那是根 README 专属的第 4 节），所以中文读者拿不到任何等价内容。
 *
 * 🔴 **一格都没红，因为这是所有结构判据的公共盲区**：R2 只看 heading 层级、R3 看围栏
 * 语言标记、R4 看链接目标、R5 只数表格行数、R6 只认 `IDENTIFIER` 型 code span
 *（见本文件上方 `RULES` 那张表）—— **一句散文加没加，五格一格都看不见**。
 * 逐节块计数（ul/ol/表格行/段落数）同样看不见：那半句是**加在同一段里**的，
 * 不是新起一段，块计数分毫不动。
 *
 * ── 为什么是「五份都补」而不是「跟模板删掉」（ADJ §63）────────────────────
 * 模板侧实测：kiro2api 五份 README 的这一段都**只有短句**，没有那半句 ⇒ 偏离模板的
 * 是 en/ja/ko 而不是中文两份。但「按模板走」**不是这一节的裁决规则**：D3 明令
 * agnes2api 的 📄 节不照抄 kiro2api 那份「**允许**：个人学习、研究、自用部署、二次开发」
 * 枚举（它暗示商用不在允许之列，与 MIT 自相矛盾），改成按 MIT 的真实授权写
 *「**授予** / **要求**」。⇒ 这一节从 D3 落地那天起就已经不跟模板了。
 * 而按 D3 的口径，回填前的写法是**描述不全**：MIT 正文的第三块就是
 * `THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND`，
 *「授予 / 要求」两条把它漏了。kiro2api 没有这个义务（它那份枚举根本不是在描述 MIT）。
 * ⇒ 补齐两份中文是**补全**，删 en/ja/ko 是**真损失**。措辞与根 README
 * `## ⚠ 免责声明` §2「无担保声明」对齐。
 *
 * ── 判据为什么是逐字节而不是布尔量 ───────────────────────────────────────
 * 评审建议的最小形态是「是否含无担保表述」这个布尔量五份相同。**这里做得更严**：
 * 末段整段 `toEqual` 逐字节登记。理由是布尔量挡不住「半句还在、但整段被改写成
 * 另一个意思」这种坏法，而那正是这一段最容易出的事（它同时承载「与上游无关联」
 * 「无担保」「风险自负」「遵守服务条款」四件事）。**两个方向都会红**：文档改了不改
 * 登记表要红，登记表改了不改文档也要红。
 * 下面那格「一族字面五份都在」是**意图说明**，不是判据主体——它让红信息说得出
 * 「你删掉的是无担保表述」，而不是只丢一段 diff 给人看。
 */
describe("⑧ 五份 README 的 `## 📄` 节末段逐字节等于登记表（ADJ §63）", () => {
  /** 逐语言登记末段全文。**改这张表就是改对外承诺，别顺手改。** */
  const LICENSE_TAILS: Readonly<Record<Lang, string>> = {
    "zh-CN": "本项目与 Agnes AI 无关联，且不提供任何担保与支持承诺。使用者需自行承担风险并遵守相关服务条款。",
    "zh-TW": "本專案與 Agnes AI 無關聯，且不提供任何擔保與支援承諾。使用者需自行承擔風險並遵守相關服務條款。",
    en: "This project is not affiliated with Agnes AI. It comes with no warranty and no support commitment, so use it at your own risk and comply with the applicable terms of service.",
    ja: "本プロジェクトは Agnes AI とは関係がありません。保証もサポートの約束もありませんので、自己責任でご利用いただき、該当する利用規約を守ってください。",
    ko: "본 프로젝트는 Agnes AI와 관련이 없습니다. 어떠한 보증도 지원 약속도 없으므로 위험은 본인이 부담하고 해당 이용약관을 지켜 주세요.",
  };

  /** 「无担保」那一族字面，逐语言各一个。下面那格用它把红信息说清楚。 */
  const WARRANTY_TOKEN: Readonly<Record<Lang, string>> = {
    "zh-CN": "担保", "zh-TW": "擔保", en: "warranty", ja: "保証", ko: "보증",
  };

  /**
   * 抠出 `## 📄` 一节的**最后一个非空段落**。
   *
   * ⚠️ 节的下界取 `---` 或下一个 `## `：这一节后面紧跟的是页脚分隔线，不取下界的话
   * 会把页脚那个 `<div align="center">` 也算成末段。
   */
  const licenseTail = (src: string, lang: Lang): string => {
    const lines = outsideFences(src).split("\n");
    const start = lines.findIndex((l) => l.startsWith("## 📄 "));
    if (start < 0) throw new Error(`docs/${lang}/README.md 里找不到 \`## 📄\` 那一节 —— 判据坏了，不许静默当成「末段都对」`);
    const rest = lines.slice(start + 1);
    const endAt = rest.findIndex((l) => l.trim() === "---" || l.startsWith("## "));
    const body = (endAt < 0 ? rest : rest.slice(0, endAt)).join("\n");
    const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "");
    const tail = paras[paras.length - 1];
    if (tail === undefined) throw new Error(`docs/${lang}/README.md 的 \`## 📄\` 一节抠不出任何段落 —— 判据坏了，不许静默当成「末段都对」`);
    return tail;
  };

  type LangRead = (lang: Lang) => string;
  const realReadme: LangRead = (l) => readFileSync(docPath(".", l, "README"), "utf8");
  const patchLang = (base: LangRead, at: Lang, body: string): LangRead => (l) => (l === at ? body : base(l));

  const tailFailures = (read: LangRead): string[] => {
    const out: string[] = [];
    for (const lang of LANGS) {
      const got = licenseTail(read(lang), lang);
      const want = LICENSE_TAILS[lang];
      if (got !== want) {
        out.push(`docs/${lang}/README.md 的 \`## 📄\` 节末段与登记表对不上：\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`);
      }
    }
    return out;
  };

  const probeGreen = (failures: readonly string[], realCase: string): void => {
    if (failures.length > 0) {
      throw new Error(`本格是探针，它的基取自真仓，而真仓今天本身就不过这条判据 —— 真因在「${realCase}」那一格：\n${failures.join("\n")}`);
    }
  };

  const REAL_8 = "⑧ 五份 README 的 `## 📄` 节末段逐字节等于登记表";

  it(REAL_8, () => {
    const failures = tailFailures(realReadme);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("⑧ 意图说明：五份末段各自都带着「无担保」那一族字面 —— 回填前 zh-CN / zh-TW 这一格是红的", () => {
    const missing = LANGS.filter((l) => !licenseTail(realReadme(l), l).includes(WARRANTY_TOKEN[l]));
    expect(
      missing,
      "这几种语言的 `## 📄` 节末段里没有「无担保」表述，而五份语言版都没有 `## ⚠ 免责声明` 那一节"
      + "（那是根 README 专属的第 4 节）⇒ 这几种语言的读者拿不到任何等价内容。"
      + `逐语言该出现的字面：${JSON.stringify(WARRANTY_TOKEN)}`,
    ).toEqual([]);
  });

  it("⑧ 该红时红：把 en 那半句「no warranty and no support commitment」删掉 —— R2–R6 全绿，本格必须红并点名 docs/en/README.md", () => {
    probeGreen(tailFailures(realReadme), REAL_8);
    const mutated = realReadme("en").replace(
      " It comes with no warranty and no support commitment, so use it at your own risk and",
      " Use it at your own risk and",
    );
    expect(mutated, "变异没落地").not.toBe(realReadme("en"));
    const failures = tailFailures(patchLang(realReadme, "en", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("docs/en/README.md 的 `## 📄` 节末段与登记表对不上");
  });

  it("⑧ 该红时红：半句还在、整段被改写成另一个意思 —— 布尔量式判据挡不住，逐字节这一格挡得住", () => {
    probeGreen(tailFailures(realReadme), REAL_8);
    // 「擔保」还在，但「與 Agnes AI 無關聯」与「遵守相關服務條款」两件事被抹掉了。
    const mutated = realReadme("zh-TW").replace(
      LICENSE_TAILS["zh-TW"],
      "本專案不提供任何擔保。",
    );
    expect(mutated, "变异没落地").not.toBe(realReadme("zh-TW"));
    const failures = tailFailures(patchLang(realReadme, "zh-TW", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("docs/zh-TW/README.md");
    // 反证：这一段仍然含「擔保」，所以只看那一族字面的判据在这里是绿的。
    expect(licenseTail(mutated, "zh-TW")).toContain(WARRANTY_TOKEN["zh-TW"]);
  });

  it("⑧ 认不出要吵：某一份没有 `## 📄` 那一节、或那一节是空的时候当场抛", () => {
    expect(() => tailFailures(patchLang(realReadme, "ja", "# 标题\n\n没有许可协议节的一份文档\n")))
      .toThrow(/判据坏了/);
    const emptied = realReadme("ko").replace(licenseTail(realReadme("ko"), "ko"), "");
    const gutted = emptied.replace("본 프로젝트는 [MIT 라이선스](../../LICENSE)로 공개합니다:", "")
      .replace(/- \*\*주는 것\*\*[^\n]*\n/, "").replace(/- \*\*요구하는 것\*\*[^\n]*\n/, "");
    expect(() => tailFailures(patchLang(realReadme, "ko", gutted))).toThrow(/判据坏了/);
  });
});

/**
 * # W124 —— 非 README 文档的五语言 `##` 译名常量表
 *
 * P3f 阶段 7 有四条验收判据（W99 / W102 / W104 / W107）写的都是
 * 「五份 `##` 序列 `toEqual` 目标骨架」，而**规格全文没有那个右操作数**。
 * 没有它，实施者只能自己编一套 —— 而「自己编一套」正是 ADJ ⑲ 选「五语言同构」时
 * 要消灭的东西：五份各写各的，判据只能退化成「数量相等」，
 * 而数量相等对「ja 把第 7 节写成了另一件事」是睁眼瞎。
 *
 * ## 这张表的每一格从哪来（三档，逐格在下面的注释里标）
 *
 * - **K∩G**：kiro2api 与 gemini2api 的**同一份文档、同一种语言**都实测到这个标题
 *   ⇒ 那是模板形态，逐字照抄。ADJ ㊴ 的原话：「证据（实测）胜过规格（转述）」——
 *   规格 §1.9.2 有 3 处抄写误差（`## 管理接口` 实为 `## 管理 API`、
 *   `## 系统` 实为 `## 系统 API`、七个协议族**都带 ` API` 后缀**），本表按实测走。
 * - **K∩G(跨档)**：同一个 zh-CN 标题在参照仓的**另一类文档**里有该语言的实测译名
 *   （两仓的非 zh-CN 版本并不是 zh-CN 版的逐节翻译，DEPLOY 的 `##` 骨架逐语言就不同：
 *   实测 K/G 的 zh-CN 14/12 节、zh-TW 9/9、en 9/9、ja 11/11、ko 8/8）⇒ 退一档取跨档实测。
 * - **推导**：两仓在那一格上给不出该语言的实测值 ⇒ 按该语言在参照仓里的用词习惯翻译。
 *
 * ## 三条已裁定的骨架决定（ADJ ㊲㊳㊵）都落在这张表里
 *
 * - **ADJ ㊲**：`API.md` 的 `## 模型` **保留为独立 `##`** ⇒ API 是 **13 个 `##`**，不是 12。
 * - **ADJ ㊵**：`DEPLOY.md` 的 `## 环境变量` **保留** ⇒ 叠加 §1.10 的双形态变体
 *   （第 3 槽 `## Docker 部署` 拆成 `## 选哪种形态` / `## Cloudflare Worker 部署` /
 *   `## Docker 部署`）之后是 **15 个 `##`**，不是 12 也不是 14。
 * - **ADJ ㊳** 只管端点归族（`GET /v1/models` → OpenAI 族、`GET /v1beta/models` → Gemini 族），
 *   那是 `###` 层的事，不影响本表。
 *
 * ## 射程：**只有 DEPLOY 与 API 进这张表**（§1.9.4）
 *
 * `USAGE` / `ADMIN` / `REGISTRAR` 三类本期是「`##` 骨架维持现状、只补 `###`/`####`」，
 * 给它们钉文本 `toEqual` **等于把今天的现状当成模板** —— 那是本仓 C1 犯过的病
 * （一张照抄现状的表永远绿，改坏了也绿）。它们只进「五份 `##` 数量相等 + 层级序列相等」
 * 的弱形式，由 R2 那一族守着。**这一条由下面「射程登记」那一格钉住，不是靠人记得。**
 */
const DOC_SECTIONS = {
  /**
   * ### `DEPLOY.md` —— 15 节
   *
   * 槽位来源逐条：
   * 1 `环境要求` K∩G ｜ 2 `获取 {凭据}` K∩G 句式（K `获取 Kiro 凭据` / G `获取 Cookie` ⇒ agnes `获取 Agnes 凭据`）
   * 3–5 §1.10 的双形态变体（V53：第 3 槽拆三节；`## 选哪种形态` 排在两条部署路之前且不预设主推）
   * 6 `环境变量` ADJ ㊵ 的扩展位，**取 agnes 五份今天已有的那五个标题逐字**（W1 实测五语言同构，漂移 0）
   * 7 `多账号配置` ｜ 8 `验证部署` ｜ 9 `常见问题` ｜ 10 `性能优化` ｜ 11 `监控和维护`
   * 12 `升级服务` ｜ 13 `备份和恢复` ｜ 14 `安全建议` ｜ 15 页脚节
   *
   * ⚠️ **第 6 槽的位置是本轮裁定的，规格没说。** ADJ ㊵ 只说「保留为独立 `##` 节」，
   * 没给位置。放在两条部署路之后、`## 多账号配置` 之前的理由：两条部署路都要读环境变量，
   * 而 `## 多账号配置` 本身就是一个配置专题 ⇒ 配置块连成一片，再进入验证。
   * 放在全文第一节（agnes 今天的位置）会让一份 700 行的变量表挡在 `## 环境要求` 前面，
   * 与模板固定的起手三节冲突。**这一条要推翻就来改这张表，别在文档侧各写各的。**
   */
  DEPLOY: {
    "zh-CN": [
      "## 环境要求",                    // K∩G
      "## 获取 Agnes 凭据",             // K∩G 句式
      "## 选哪种形态",                  // V53 必须变体（模板无先例）
      "## Cloudflare Worker 部署",      // V53
      "## Docker 部署",                 // K∩G
      "## 环境变量",                    // ADJ ㊵（agnes 现名）
      "## 多账号配置",                  // K∩G
      "## 验证部署",                    // K∩G
      "## 常见问题",                    // K∩G
      "## 性能优化",                    // K∩G
      "## 监控和维护",                  // K∩G
      "## 升级服务",                    // K∩G
      "## 备份和恢复",                  // K∩G
      "## 安全建议",                    // K∩G
      "## 获取帮助",                    // K∩G（页脚节）
    ],
    "zh-TW": [
      "## 系統要求",                    // K∩G(zh-TW DEPLOY)
      "## 取得 Agnes 憑證",             // K 句式 `取得 Kiro 憑證`
      "## 選哪種形態",                  // 推导
      "## Cloudflare Worker 部署",      // 推导
      "## Docker 部署",                 // K∩G
      "## 環境變數",                    // agnes 现名
      "## 多帳號設定",                  // 推导（ja/ko 实测用「設定」）
      "## 驗證",                        // K∩G
      "## 常見問題排除",                // K∩G
      "## 效能優化",                    // 推导
      "## 監控與維護",                  // 推导
      "## 升級服務",                    // 推导
      "## 備份與還原",                  // 推导
      "## 安全建議",                    // 推导
      "## 後續步驟",                    // K∩G（页脚节）
    ],
    en: [
      "## System Requirements",         // K∩G
      "## Getting Agnes Credentials",   // K 句式 `Getting Credentials`
      "## Choosing a Deployment Form",  // 推导
      "## Cloudflare Worker Deployment",// 推导
      "## Docker Deployment",           // K∩G
      "## Environment Variables",       // agnes 现名，按模板体例改成 Title Case
      "## Multi-Account Configuration", // 推导
      "## Verification",                // K∩G
      "## Troubleshooting",             // K∩G
      "## Performance Tips",            // K∩G(跨档，两仓 en USAGE)
      "## Monitoring and Maintenance",  // 推导
      "## Upgrading the Service",       // 推导
      "## Backup and Restore",          // 推导
      "## Security Recommendations",    // 推导
      "## Next Steps",                  // K∩G（页脚节）
    ],
    ja: [
      "## 環境要件",                    // K∩G
      "## Agnes 認証情報の取得",        // K 句式 `Kiro 認証情報の取得`
      "## どちらの形態を選ぶか",        // 推导
      "## Cloudflare Worker デプロイ",  // 推导
      "## Docker デプロイ",             // K∩G
      "## 環境変数",                    // agnes 现名
      "## マルチアカウント設定",        // K∩G
      "## 検証",                        // K∩G
      "## トラブルシューティング",      // K∩G
      "## パフォーマンス最適化",        // 推导
      "## 監視とメンテナンス",          // 推导
      "## アップデート",                // K∩G
      "## バックアップと復元",          // 推导
      "## セキュリティ推奨事項",        // 推导
      "## 次のステップ",                // 推导（ja 侧两仓都没有页脚 `##`）
    ],
    ko: [
      "## 환경 요구사항",               // K∩G
      "## Agnes 자격 증명 준비",        // K 句式 `Kiro 자격 증명 준비`
      "## 어떤 형태를 선택할까",        // 推导
      "## Cloudflare Worker 배포",      // 推导
      "## Docker 배포",                 // K∩G
      "## 환경 변수",                   // agnes 现名
      "## 다중 계정 설정",              // K∩G
      "## 검증",                        // K∩G
      "## 문제 해결",                   // K∩G
      "## 성능 최적화",                 // K∩G(跨档，两仓 ko USAGE)
      "## 모니터링과 유지보수",         // 推导
      "## 서비스 업그레이드",           // 推导
      "## 백업과 복구",                 // 推导
      "## 보안 권장사항",               // 推导
      "## 다음 단계",                   // K∩G（页脚节）
    ],
  },

  /**
   * ### `API.md` —— 13 节（3 固定节 + `## 模型` + 7 个协议族 + `## 请求示例` + 页脚节）
   *
   * - 第 1 节按 **W96a** 从 agnes 今天的 `## 鉴权` 改名到 `## 认证`（§1.5 的固定第一节）。
   * - 第 4 节 `## 模型` 是 **ADJ ㊲** 保留的独立节，位置取模板实测序
   *   （kiro zh-CN API：`## 错误响应`:87 → `## 模型名映射`:189 → `## OpenAI 兼容 API`:210），
   *   标题取 agnes 五份今天已有的那五个（W1 实测同构）。
   * - 七个协议族**都带 ` API` 后缀**（ADJ ㊴）。
   * - agnes 今天那两个专题节（`## key 池耗尽时的错误` / `## 同步端点超时`）按 §1.9.2 给的
   *   二选一，**选「并入 `## 错误响应` 之下降为 `###`」**——另一条路（当成额外的 `##`）
   *   会让 `##` 数变 15，与 ADJ ㊲ 定的 13 冲突。
   *
   * ⚠️ **`## Anthropic 兼容 API` 这一格没有照抄 K∩G 的 `## Claude 兼容 API`，理由要说清楚**：
   * ADJ ㊴ 逐条列出的 K∩G 差异是三项（`管理接口`→`管理 API`、`系统`→`系统 API`、` API` 后缀），
   * 不含厂商名。而 D2 的 K∩G 通则本身就把「两仓一致的 = 模板骨架」与
   * 「各写各的 = 项目特定内容」分开：**协议的厂商名属于后者**——agnes 全仓
   * （`package.json` 的 description、六份 README、五份 API.md）一律写 Anthropic，
   * 照抄 Claude 会让文档与它自己的其余部分打架。**这一条是判断不是实测，写在这里备查。**
   */
  API: {
    "zh-CN": [
      "## 认证",                        // K∩G（W96a：从 `## 鉴权` 改名）
      "## 路径说明",                    // K∩G
      "## 错误响应",                    // K∩G
      "## 模型",                        // ADJ ㊲（agnes 现名）
      "## OpenAI 兼容 API",             // K∩G
      "## OpenAI Responses API",        // 推导（agnes 专有协议族）
      "## Anthropic 兼容 API",          // 见上：厂商名走项目内容档
      "## Gemini 原生 API",             // K∩G
      "## 图片与视频 API",              // 推导（agnes 专有协议族）
      "## 管理 API",                    // K∩G（规格写 `## 管理接口`，实测不是）
      "## 系统 API",                    // K∩G（规格写 `## 系统`，实测不是）
      "## 请求示例",                    // K∩G
      "## 获取帮助",                    // K∩G（页脚节）
    ],
    "zh-TW": [
      "## 認證",                        // K∩G（W96a：从 `## 鑑權` 改名）
      "## 路徑說明",                    // K∩G
      "## 錯誤碼",                      // K∩G(zh-TW API)
      "## 模型",                        // agnes 现名
      "## OpenAI 相容 API",             // K∩G（两仓的括号路径后缀各写各的 ⇒ 不在交集，去掉）
      "## OpenAI Responses API",        // 推导
      "## Anthropic 相容 API",          // 推导
      "## Gemini 原生 API",             // K∩G
      "## 圖片與影片 API",              // 推导
      "## 管理 API",                    // K∩G
      "## 系統 API",                    // K∩G
      "## 請求範例",                    // 推导
      "## 後續步驟",                    // 与 DEPLOY 同一页脚节
    ],
    en: [
      "## Authentication",              // K∩G
      "## Standard Bare Paths",         // K∩G
      "## Error Responses",             // K∩G
      "## Models",                      // agnes 现名
      "## OpenAI Compatible API",       // K∩G
      "## OpenAI Responses API",        // 推导
      "## Anthropic Compatible API",    // 推导
      "## Gemini Native API",           // K∩G
      "## Images and Videos API",       // 推导
      "## Admin API",                   // K∩G
      "## System Endpoints",            // K∩G
      "## Request Examples",            // 推导
      "## Next Steps",                  // 与 DEPLOY 同一页脚节
    ],
    ja: [
      "## 認証",                        // K∩G
      "## 標準ベアパス",                // K∩G
      "## エラーコード",                // K∩G(ja API)
      "## モデル",                      // agnes 现名
      "## OpenAI 互換 API",             // K∩G
      "## OpenAI Responses API",        // 推导
      "## Anthropic 互換 API",          // 推导
      "## Gemini 原生 API",             // K∩G
      "## 画像と動画 API",              // 推导
      "## 管理 API",                    // K∩G
      "## システム API",                // 推导（ja 侧两仓都没有这一节）
      "## リクエスト例",                // 推导
      "## 次のステップ",                // 与 DEPLOY 同一页脚节
    ],
    ko: [
      "## 인증",                        // K∩G
      "## 표준 베어 경로",              // G 实测（**不在 K∩G**：K ko 写 `이중 프리픽스 경로`）⇒ 取与 zh-CN/en 同义的 G 值
      "## 에러 응답 형식",              // K∩G(ko API)
      "## 모델",                        // agnes 现名
      "## OpenAI 호환 API",             // K∩G
      "## OpenAI Responses API",        // 推导
      "## Anthropic 호환 API",          // 推导
      "## Gemini 원생 API",             // K∩G
      "## 이미지와 비디오 API",         // 推导
      "## 관리 API",                    // K∩G
      "## 시스템 API",                  // 推导（ko 侧两仓都没有这一节）
      "## 요청 예제",                   // K∩G
      "## 다음 단계",                   // 与 DEPLOY 同一页脚节
    ],
  },
} as const satisfies Record<string, Record<(typeof LANGS)[number], readonly string[]>>;

type SectionDoc = keyof typeof DOC_SECTIONS;

/** 一份 markdown 里**围栏之外**的全部 `##` 标题行（原样，含 `## ` 前缀）。 */
const sectionTitles = (s: string): string[] =>
  outsideFences(s).split("\n").filter((l) => /^## /.test(l)).map((l) => l.trimEnd());

/**
 * 把某一份文档实际的 `##` 序列与 `DOC_SECTIONS` 对一遍，**逐槽点名**。
 *
 * ⚠️ **报文必须点到「第几节」和「哪种语言」**：这一组的全部价值就在于
 * 「ja 的第 7 节写成了另一件事」能被一句话指出来。只说「序列对不上」
 * 等于把人扔回 15 行 diff 里自己找。
 *
 * ⚠️ **认不出要吵**：一个 `##` 都抽不到时当场抛，不许静静地报成「少了 15 节」——
 * 那种报文会把人引去文档里补标题，而真正坏掉的是抽取器（比如围栏配对被改歪了）。
 */
function sectionFailures(doc: SectionDoc, lang: (typeof LANGS)[number], actual: readonly string[]): string[] {
  const want = DOC_SECTIONS[doc][lang] as readonly string[];
  if (actual.length === 0) {
    throw new Error(`docs/${lang}/${doc}.md 里一个 \`##\` 都没抽到 —— 判据坏了，不许把它报成「少了 ${want.length} 节」`);
  }
  const out: string[] = [];
  if (actual.length !== want.length) {
    out.push(`${lang} 的 ${doc}.md 有 ${actual.length} 个 \`##\`，目标骨架是 ${want.length} 个`);
  }
  for (let i = 0; i < Math.max(actual.length, want.length); i++) {
    if (actual[i] === want[i]) continue;
    out.push(
      `${lang} 第 ${i + 1} 节对不上：目标 ${want[i] === undefined ? "（没有这一节）" : `\`${want[i]}\``}`
      + `，实际 ${actual[i] === undefined ? "（缺）" : `\`${actual[i]}\``}`,
    );
  }
  return out;
}

/**
 * **还没接到真文档上的那一档，两个方向都查。**
 *
 * 今天 agnes 的五份 `DEPLOY.md` 各 5 个 `##`、五份 `API.md` 各 15 个平铺 `##`，
 * 离目标骨架还有 W99 / W104 整整两批改写。**在文档改完之前把
 * 「五份 `##` 序列 `toEqual` DOC_SECTIONS」接上真文档，红的原因会是「骨架还没改完」
 * 而不是「骨架改错了」** —— 报文误导，而误导的报文比没有判据更贵。
 *
 * ⚠️ 所以这里用本仓 `EMPTY_BY_DESIGN` 那条同款的**双向名册**语义：
 * 登记在册 ⇒ 今天允许对不上；**而一旦某一格真的走到了目标，本格当场红**，
 * 报文直接告诉后人「回来把这一格从名册里划掉、并把 R11 扩展接到真文档上」。
 * 一张只会「等人记得回来改」的待办清单在本仓不算守卫；这张会自己到期。
 *
 * ⚠️ **但「全等才到期」这一条自己有个洞**，见下面 `SECTIONS_DRIFT_BASELINE` 的注释。
 */
const SECTIONS_NOT_YET_APPLIED: ReadonlyArray<readonly [SectionDoc, (typeof LANGS)[number]]> = [];

/**
 * **已经接到真文档上的那一档（W99 落地，P3f 阶段 7B）。**
 *
 * 名册是**双向**的：`SECTIONS_APPLIED` ∪ `SECTIONS_NOT_YET_APPLIED` 必须恰好等于
 * `DOC_SECTIONS × LANGS`，两边**不许有交集**。少登记一格，那一格就从两条判据之间掉出去
 * ——既没有 `toEqual` 看着，也没有差距基线看着，而这正是 7A 那张名册注释里
 * 「一张只会等人记得回来改的待办清单不算守卫」要消灭的东西。
 *
 * ⚠️ 搬一格从 `NOT_YET_APPLIED` 到 `APPLIED` 的**唯一合法时机**是那一格真的走到了逐字全等：
 * 走不到全等而硬搬过来，下面「已接线的那几格：`##` 序列 `toEqual` DOC_SECTIONS」当场红。
 */
const SECTIONS_APPLIED: ReadonlyArray<readonly [SectionDoc, (typeof LANGS)[number]]> =
  (["DEPLOY", "API"] as const).flatMap((doc) => LANGS.map((lang) => [doc, lang] as const));

/**
 * **今天每一格差多少，逐格钉死。**
 *
 * ⚠️ **补漏评审（阶段 7A 第 1 轮）修的就是这里。** 上一版这一格写的是
 * 「失败条数 `toBeGreaterThan(0)`」，而上面那张名册**只在逐字全等时到期**。
 * 两者中间留了一个窗口：W99 的实施者把 15 节里**做对 14 节、错 1 节** ⇒
 * 名册不到期（不全等）、失败条数也仍然 > 0 ⇒ **出货套件一声不吭**。
 * 而「做对大半、错一两节」恰恰是这批改写最可能的落地形态；
 * 一次性 15 节逐字全对反而是小概率。**只守两端、不守中间的判据等于没守。**
 *
 * ⇒ 改成**逐格钉死今天实测的失败条数**：这个数字一动（变小=有人在推进、
 * 变大=骨架往反方向漂了）就当场红，并把**剩下的差距逐条打印出来**——
 * W124 验收要的那句「ja 第 7 节对不上：目标 …，实际 …」就是从这条判据里出来的。
 *
 * **这些数字是量出来的，不是编的。** `sectionFailures()` = 1 条「节数对不上」
 * + 每个对不上的槽位 1 条：
 * - DEPLOY 五份今天各 **5** 个 `##`、目标 15 ⇒ 1 + 15 = **16**（五份一致）；
 * - API 五份今天各 **15** 个平铺 `##`、目标 13 ⇒ 1 + 15 = **16**，
 *   而 en/ja/ko 的**第 1 槽**（`## Authentication` / `## 認証` / `## 인증`）今天已经对上
 *   —— W96a 的 `鉴权 → 认证` 改名只欠 zh-CN/zh-TW 两份 ⇒ 这三格是 **15**。
 *   这个 15/16 的不齐本身就是「基线是量的不是拍的」的证据。
 *
 * **这个数守的是什么、不守什么（不许把它说大）**：它守的是「这一格**离目标还有多远**」——
 * 只要有槽位开始对上、或节数走到目标，它就会掉，当场红。
 * 它**不守**「往别的方向乱加一节」那类漂移：往今天的 `DEPLOY.md` 末尾追加一个
 * 与目标毫不相干的 `##`（5 → 6 节，没有任何槽位因此对上）⇒ 条数仍是 16，本格不红。
 * 那一类漂移由 **`DEPLOY.md 的「R2 heading 层级序列」五份逐份相同`** 那一格接住，
 * **本格只管「有没有人在往目标走」**。
 * ⚠️ 这里原先写的是「归 R11 / R20 那边守」，**是错的**——实测（往 `docs/ja/DEPLOY.md`
 *   末尾追加一个无关 `##` 后跑整份）红的是上面那格，`1 failed / 406 passed`。
 *   R11 今天只覆盖 README，R20 管的是排版元素的语义位置，两者都接不住这个。
 *   **兜底判据点错名比没写更坏**：后人按错的编号去找，找不到就会以为这类漂移无人守。
 *
 * **维护规矩**：数字变小 ⇒ 回来把这一格重新量一遍写进本表，并在提交正文里写明
 * 是哪一批 W 在推进；**走到 0 之前上面那格「名册双向」会先红**，那时把这一格
 * 从名册与本表里一起划掉、把 `toEqual` 接到真文档上（R11 扩展）。
 * **不许把这条判据删掉、也不许改回 `> 0` 了事** —— 那等于把上面那个窗口原样放回来。
 */
const SECTIONS_DRIFT_BASELINE: Readonly<Record<string, number>> = {
  // **这张表今天是空的，而空是它的终点、不是它坏了。** DEPLOY 五份在 W99（阶段 7B 之三）
  // 走到全等，API 五份在 W104（阶段 7B 之四）走到全等 ⇒ 十格全部搬进 `SECTIONS_APPLIED`，
  // 由「已接线的那几格」那一格用 `toEqual` 直接守着，不再需要「离目标还有多远」这条路。
  //
  // ⚠️ **空表会让上面两个 `for` 一次都不进循环，这件事必须被说出来而不是靠人发现**
  //（本仓 `EMPTY_BY_DESIGN` 那条同款教训：一个空转的判据比没有判据更贵）。
  // 承接它的是下面那一格「名册到期了：两批骨架都已接到真文档上」——
  // 它正面断言这两张表就该是空的、且 `SECTIONS_APPLIED` 覆盖了 `DOC_SECTIONS × LANGS` 全集。
  // **别把这张表删掉**：下一次给 `DOC_SECTIONS` 加一类文档（USAGE/ADMIN/REGISTRAR 迟早会来），
  // 那一格会先红并把人带回这里重新量一轮差距。
};

/**
 * 把一串目标 `##` 铺成一份**真形态的 markdown**（H1 + lead + 正文 + 代码围栏），
 * 让 W124 的验收走完「文件文本 → `sectionTitles()` → `sectionFailures()`」这条
 * **出货判据自己走的路**，而不是把常量数组直接塞给比较器。
 *
 * ⚠️ 上一版验收喂的是 `[...DOC_SECTIONS.DEPLOY.ja]`，**抽取器一步都没走到**：
 * 围栏配对被改歪、`^## ` 被写成 `^#{2,} ` 之类的坏法，那种验收一格都不会红。
 * 所以这里刻意在每节里塞一个 ```bash 围栏、围栏里塞一行 `## …` 假标题。
 */
const renderSectionDoc = (titles: readonly string[]): string =>
  ["# タイトル", "", "リード文。", "", ...titles.flatMap((t, i) => [
    t, "", `本文 ${i + 1}。`, "", "```bash", `## 围栏里的假标题 ${i + 1}`, "```", "",
  ])].join("\n");

describe("W124 非 README 文档的五语言 `##` 译名常量表", () => {
  const realSections = (doc: SectionDoc, lang: (typeof LANGS)[number]): string[] =>
    sectionTitles(readFileSync(`docs/${lang}/${doc}.md`, "utf8"));

  /* ── 表自身的形状 ───────────────────────────────────────────────────────── */

  it("射程登记：只有 DEPLOY 与 API 进这张表（§1.9.4：USAGE/ADMIN/REGISTRAR 钉文本 = 拿现状当模板）", () => {
    expect(
      Object.keys(DOC_SECTIONS).sort(),
      "这张表长出了第三类文档 —— USAGE/ADMIN/REGISTRAR 本期是「`##` 维持现状」，"
      + "给它们钉文本 `toEqual` 等于把今天的现状当成模板（C1 犯过的病）。要加就先来推翻 §1.9.4",
    ).toEqual(["API", "DEPLOY"]);
  });

  it("五语言等长，且节数就是裁定的 DEPLOY 15 / API 13", () => {
    const EXPECT_LEN: Record<SectionDoc, number> = { DEPLOY: 15, API: 13 };
    const wrong: string[] = [];
    for (const doc of Object.keys(DOC_SECTIONS) as SectionDoc[]) {
      for (const lang of LANGS) {
        const n = DOC_SECTIONS[doc][lang].length;
        if (n !== EXPECT_LEN[doc]) wrong.push(`${doc}/${lang} 有 ${n} 节，裁定是 ${EXPECT_LEN[doc]} 节`);
      }
    }
    expect(
      wrong,
      "DEPLOY 15 = §1.9.1 的 12 节 − 1（第 3 槽）+ 3（§1.10 双形态）+ 1（ADJ ㊵ 的 `## 环境变量`）；"
      + "API 13 = §1.9.2 的 12 项 + 1（ADJ ㊲ 的 `## 模型`）。改这两个数之前先去改裁定",
    ).toEqual([]);
  });

  it("每一格都是合法的 `##` 标题，且同一份文档里没有重名节", () => {
    const bad: string[] = [];
    for (const doc of Object.keys(DOC_SECTIONS) as SectionDoc[]) {
      for (const lang of LANGS) {
        const list: readonly string[] = DOC_SECTIONS[doc][lang];
        list.forEach((t, i) => {
          if (!/^## \S/.test(t)) bad.push(`${doc}/${lang}[${i}] 不是 \`## \` 开头的标题：${JSON.stringify(t)}`);
          if (t !== t.trim()) bad.push(`${doc}/${lang}[${i}] 前后有多余空白：${JSON.stringify(t)}`);
        });
        const dup = list.filter((t, i) => list.indexOf(t) !== i);
        if (dup.length > 0) bad.push(`${doc}/${lang} 有重名节：${dup.join(" / ")}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("这 25 份文档的射程铁律：目标标题一个 emoji 都不许带（C17 / R25f）", () => {
    // 阶段 7 的三条否定项之一。表里先带上，文档侧就没有「照着表抄」这条借口。
    const withEmoji = (Object.keys(DOC_SECTIONS) as SectionDoc[]).flatMap((doc) =>
      LANGS.flatMap((lang) =>
        DOC_SECTIONS[doc][lang].filter((t) => /\p{Extended_Pictographic}/u.test(t)).map((t) => `${doc}/${lang}: ${t}`)),
    );
    expect(withEmoji, "非 README 文档的标题不加 emoji（C17），而目标表自己带上了").toEqual([]);
  });

  it("页脚节五语言逐下标一致：DEPLOY 与 API 的末节用同一族译名（R26e' 的右操作数）", () => {
    // W102 / W107 的「末节标题 == 译名表同一下标的五语言译名」靠的就是这一条：
    // 两类文档的末节如果各写各的，R26e' 会退化成「每类各自内部一致」，
    // 而 ADJ ㊷ 定的是**五类子文档统一成同一种页脚形态**。
    for (const lang of LANGS) {
      const deploy = DOC_SECTIONS.DEPLOY[lang];
      const api = DOC_SECTIONS.API[lang];
      expect(api[api.length - 1], `${lang} 的 API 末节与 DEPLOY 末节不是同一个标题`)
        .toBe(deploy[deploy.length - 1]);
    }
  });

  /* ── 比较器：正题 + 反向控制 ────────────────────────────────────────────── */

  it("比较器的正题：拿目标表自己比自己 ⇒ 一条失败都没有", () => {
    for (const doc of Object.keys(DOC_SECTIONS) as SectionDoc[]) {
      for (const lang of LANGS) {
        expect(sectionFailures(doc, lang, DOC_SECTIONS[doc][lang])).toEqual([]);
      }
    }
  });

  it("该红时红：ja 的 DEPLOY 第 7 节被换掉 ⇒ 恰 1 条失败，报文点名「ja」「第 7 节」（W124 的验收，走真抽取器）", () => {
    const mutated: string[] = [...DOC_SECTIONS.DEPLOY.ja];
    expect(mutated[6], "第 7 槽的落点变了 —— 先回来改这一格").toBe("## マルチアカウント設定");
    mutated[6] = "## アカウント設定";
    // 关键：不是把数组直接喂给比较器，而是先铺成 markdown 再让 `sectionTitles()` 抽回来。
    const extracted = sectionTitles(renderSectionDoc(mutated));
    expect(extracted, "抽取器没把这份合成文档还原成 15 个 `##` —— 坏的是抽取器，不是骨架")
      .toEqual(mutated);
    const failures = sectionFailures("DEPLOY", "ja", extracted);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("ja 第 7 节对不上");
    expect(failures[0] ?? "").toContain("## マルチアカウント設定");
    expect(failures[0] ?? "").toContain("## アカウント設定");
  });

  it("该红时红：少一节 / 多一节都要先报「节数对不上」，再逐槽点名", () => {
    const short: string[] = DOC_SECTIONS.API["zh-CN"].slice(0, -1);
    const fShort = sectionFailures("API", "zh-CN", short);
    expect(fShort[0] ?? "").toContain("有 12 个 `##`，目标骨架是 13 个");
    expect(fShort.some((m) => m.includes("第 13 节对不上") && m.includes("（缺）"))).toBe(true);

    const long: string[] = [...DOC_SECTIONS.API["zh-CN"], "## 多出来的一节"];
    const fLong = sectionFailures("API", "zh-CN", long);
    expect(fLong[0] ?? "").toContain("有 14 个 `##`，目标骨架是 13 个");
    expect(fLong.some((m) => m.includes("第 14 节对不上") && m.includes("（没有这一节）"))).toBe(true);
  });

  it("该红时红：顺序被调换（内容一个字没改）⇒ 两槽同时点名", () => {
    const swapped: string[] = [...DOC_SECTIONS.DEPLOY["zh-CN"]];
    [swapped[3], swapped[4]] = [swapped[4]!, swapped[3]!];
    const failures = sectionFailures("DEPLOY", "zh-CN", swapped);
    expect(failures).toHaveLength(2);
    expect(failures[0] ?? "").toContain("第 4 节对不上");
    expect(failures[1] ?? "").toContain("第 5 节对不上");
  });

  it("认不出要吵：一个 `##` 都抽不到时当场抛，不许报成「少了 15 节」", () => {
    expect(() => sectionFailures("DEPLOY", "en", [])).toThrow(/判据坏了/);
  });

  it("抽取器不把围栏里的 `## …` 当成标题（否则 ```bash 里一行注释就能顶掉一个槽位）", () => {
    const src = "# T\n\n## 真标题\n\n```bash\n## 这是围栏里的\n```\n\n## 另一个真标题\n";
    expect(sectionTitles(src)).toEqual(["## 真标题", "## 另一个真标题"]);
  });

  /* ── 还没接上真文档的那一档：名册会自己到期 ─────────────────────────────── */

  it("名册双向：登记在册的那几格今天确实还没走到目标（在册却已达标 ⇒ 名册过期，回来划掉并接上真文档）", () => {
    const stale: string[] = [];
    for (const [doc, lang] of SECTIONS_NOT_YET_APPLIED) {
      if (sectionFailures(doc, lang, realSections(doc, lang)).length === 0) {
        stale.push(`${doc}/${lang}`);
      }
    }
    expect(
      stale,
      `这几格的 \`##\` 序列已经与 DOC_SECTIONS 逐字相同了：\n${stale.join(" / ")}\n`
      + "⇒ W99 / W104 那一批已经落地。把它们从 SECTIONS_NOT_YET_APPLIED 里划掉，"
      + "并把「五份 `##` 序列 toEqual DOC_SECTIONS」接到真文档上（R11 扩展）",
    ).toEqual([]);
  });

  it("名册不许悄悄长出第三类：两张名册加起来恰好等于 DOC_SECTIONS × LANGS，且互不相交", () => {
    const pending = SECTIONS_NOT_YET_APPLIED.map(([d, l]) => `${d}/${l}`);
    const applied = SECTIONS_APPLIED.map(([d, l]) => `${d}/${l}`);
    const all = (Object.keys(DOC_SECTIONS) as SectionDoc[]).flatMap((d) => LANGS.map((l) => `${d}/${l}`)).sort();
    expect(
      [...pending, ...applied].sort(),
      "两张名册的并集与 DOC_SECTIONS × LANGS 对不上 —— 少登记一格，那一格就从两条判据之间掉出去："
      + "既没有 `toEqual` 看着，也没有差距基线看着",
    ).toEqual(all);
    expect(
      pending.filter((k) => applied.includes(k)),
      "同一格同时出现在两张名册里 —— 一格只能待在一边，否则「已接线」与「还没接线」互相打掩护",
    ).toEqual([]);
  });

  /**
   * **R11 扩展：已接线的那几格，`##` 序列直接 `toEqual` 常量表。**
   *
   * 7A 留下的接线指令就是这一格：DEPLOY 五份走到目标那天，把它们从
   * `SECTIONS_NOT_YET_APPLIED` 划掉、接到真文档上。这一格是那条指令的落地。
   * 报文走 `sectionFailures()`，所以「ja 第 7 节对不上」那种逐槽点名在这里同样成立。
   */
  it("已接线的那几格：五份 `##` 序列逐字 `toEqual` DOC_SECTIONS（R11 扩展）", () => {
    const failures: string[] = [];
    for (const [doc, lang] of SECTIONS_APPLIED) {
      failures.push(...sectionFailures(doc, lang, realSections(doc, lang)));
    }
    expect(
      failures,
      `已接线的文档骨架与 DOC_SECTIONS 对不上：\n${failures.join("\n")}\n`
      + "⇒ 这几格已经不在「允许对不上」的名册里了。改文档还是改表，先想清楚哪一边是对的："
      + "表是 W124 从两仓实测出来的，改表要先去推翻那一轮的来源档位登记。",
    ).toEqual([]);
  });

  it("反向控制：「15 节做对 14 节」这一档今天由 `toEqual` 接住 —— 旧写法 `> 0` 在这一档是绿的", () => {
    // 补漏评审端到端复现过的那个状态：把 docs/ja/DEPLOY.md 写成 15 节目标骨架、
    // 只把第 7 个 `##` 换掉 ⇒ 名册不到期（不全等）、失败条数 = 1（> 0）⇒ 旧判据全绿。
    const near: string[] = [...DOC_SECTIONS.DEPLOY.ja];
    near[6] = "## アカウント設定";
    const failures = sectionFailures("DEPLOY", "ja", sectionTitles(renderSectionDoc(near)));
    expect(failures, "这一档正是旧写法 `toBeGreaterThan(0)` 放行的那一格").toHaveLength(1);
    // ⚠️ **接住它的东西换了人**（P3f 阶段 7B 之四）：DEPLOY/ja 已经走到全等并搬进
    // `SECTIONS_APPLIED`，差距基线那张表因此是空的 —— 再去读
    // `SECTIONS_DRIFT_BASELINE["DEPLOY/ja"]` 只会拿到 `undefined`，那种断言恒真。
    // 今天这一档由上面那格「已接线的那几格：`##` 序列逐字 `toEqual`」接住，
    // 而它的判据就是「`sectionFailures()` 非空即红」——所以这里正面钉那一条：
    expect(failures.length, "只错一节时比较器报的条数为 0 ⇒ `toEqual` 那一格会放行").toBeGreaterThan(0);
    expect(failures[0] ?? "", "报文没点名是哪一份、第几节 —— 报文是唯一会被看见的护栏")
      .toContain("ja 第 7 节对不上");
  });

  it("差距基线与名册逐格对齐：名册里有的格，本表必须有一条基线（少一条 = 那一格的差距没人守）", () => {
    expect(
      Object.keys(SECTIONS_DRIFT_BASELINE).sort(),
      "SECTIONS_DRIFT_BASELINE 与 SECTIONS_NOT_YET_APPLIED 对不上 —— "
      + "少登记一格，那一格就退回「只要还没全等就放行」的老样子（14/15 做对也不红）；"
      + "多登记一格则是给一份没在名册里的文档钉死差距，同样要回来对齐",
    ).toEqual(SECTIONS_NOT_YET_APPLIED.map(([doc, lang]) => `${doc}/${lang}`).sort());
  });

  /**
   * **两张表都空了 —— 正面把它说出来，别让空转冒充绿。**
   *
   * `SECTIONS_NOT_YET_APPLIED` 与 `SECTIONS_DRIFT_BASELINE` 今天都是空的（DEPLOY 在 W99、
   * API 在 W104 先后走到逐字全等），于是上面那两个 `for` **一次都不进循环**。
   * 本仓对这种形态有过一条明确的教训（`EMPTY_BY_DESIGN` 那一组）：一个空转的判据比
   * 没有判据更贵，因为它看起来在守着什么。这一格就是那条教训的落地——
   * 它断言「空」是**当前的正确状态**，并且**全集真的被 `SECTIONS_APPLIED` 接住了**。
   *
   * ⇒ 谁往 `DOC_SECTIONS` 里加一类文档（USAGE / ADMIN / REGISTRAR 迟早会来）而没有
   * 同时表态它属于哪一档，本格与「名册不许悄悄长出第三类」会一起红。
   */
  it("名册到期了：两张待办表都空了，而 `DOC_SECTIONS × LANGS` 全集由 `SECTIONS_APPLIED` 接住", () => {
    expect(
      SECTIONS_NOT_YET_APPLIED,
      "名册又非空了 —— 那意味着某一类文档退回了「允许对不上」，"
      + "回来把差距逐格量出来写进 SECTIONS_DRIFT_BASELINE，别只改一张表",
    ).toEqual([]);
    expect(
      Object.keys(SECTIONS_DRIFT_BASELINE),
      "差距基线又非空了 —— 它必须与名册同进同退（上一格钉着这件事）",
    ).toEqual([]);
    expect(
      SECTIONS_APPLIED.length,
      "已接线的格数与 `DOC_SECTIONS × LANGS` 对不上 —— 有文档类型从两条判据之间掉出去了",
    ).toBe(Object.keys(DOC_SECTIONS).length * LANGS.length);
  });

  /**
   * **今天这几格红的是什么，逐条钉死。** 名册是「允许对不上」，不是「不知道差在哪」——
   * 差距说不清楚的话，上面那格就退化成一句「反正还没做」。
   *
   * ⚠️ 这一格的旧写法是 `toBeGreaterThan(0)`，与「全等才到期」的名册合起来漏掉了
   * 「15 节做对 14 节」那一整档（见 `SECTIONS_DRIFT_BASELINE` 的注释）。现在钉的是**具体条数**。
   */
  it("名册射程自守：每一格的差距条数与实测基线逐格相等（条数一变 ⇒ `##` 骨架被动过，当场红并报出剩下的差距）", () => {
    const drift: string[] = [];
    for (const [doc, lang] of SECTIONS_NOT_YET_APPLIED) {
      const key = `${doc}/${lang}`;
      const actual = realSections(doc, lang);
      expect(actual.length, `docs/${lang}/${doc}.md 一个 \`##\` 都没抽到`).toBeGreaterThan(0);
      const failures = sectionFailures(doc, lang, actual);
      const baseline = SECTIONS_DRIFT_BASELINE[key];
      if (baseline === undefined || failures.length !== baseline) {
        drift.push(
          `${key}：实测 ${failures.length} 条差距，基线钉的是 ${baseline ?? "（这一格没有基线）"} 条\n`
          + failures.map((m) => `      · ${m}`).join("\n"),
        );
      }
    }
    expect(
      drift,
      `这几份文档的 \`##\` 骨架与基线对不上了：\n${drift.join("\n")}\n`
      + "⇒ 条数**变小** = W99 / W104 那一批在推进：把这一格重新量一遍写进 SECTIONS_DRIFT_BASELINE，"
      + "提交正文里写明是哪一批 W 在推；走到全等时上面那格「名册双向」会先红，"
      + "那时把这一格从名册与基线表里一起划掉、把 toEqual 接到真文档上（R11 扩展）。\n"
      + "⇒ 条数**变大** = 原本对上的槽位又对不上了（或节数从对的变成不对），先看清楚是不是改错了再动基线。\n"
      + "🔴 不许把这条判据删掉或改回「> 0」—— 那会把「15 节做对 14 节也不红」的窗口原样放回来",
    ).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * W116 — 表格分隔行逐格补齐（R22a / R22b / R22c）
 *
 * **为什么这一组不是「数一数补了多少条」。** 旧验收写的是「补齐 ≥100 条」，
 * 而实测：只把每张表的**第一列**改宽、其余列留 `---`（`|----|---|---|`），
 * 既能让「极简分隔行」这条计数归零（那条正则要求**整行**每一格都 ≤3 个 `-`），
 * 又能满足「补齐 ≥100」——**两条旧判据一起放行，而 34 份文档的表格一格都没跟着表头走**。
 * ⇒ 判据必须是**逐格恒等式**：每一格的 `-` 数 ≥ 该列**表头文字的显示宽度**（CJK 按 2 计）
 * 且 ≥ 4。下面第 5 格就是拿那种「假补齐」当输入的反向控制。
 *
 * **口径**（三条都一样，写在这里一次，不在每一格里重复）：
 * - 射程 = **出货文档全集**：仓根五份 + `docs/{5 语言}/{7 份}`，共 40 份。
 *   不含 `.github/**`、不含 `admin-ui/README.md`（Q15：贡献者文档，参照仓无对照物）。
 * - **先剥围栏再动手**：` ``` ` 开头的行做开关，围栏定界行本身也剥掉。
 *   围栏里教人写 markdown 表格的示例**不在射程内**，第 6 格是它的反向控制。
 * - 「表头」= 分隔行的**上一行**。上一行不以 `|` 起头、或列数对不上，这一行**不算表格**，
 *   本组跳过并计数（今天两者都是 0，第 4 格钉着）。
 *
 * ⚠️ **显示宽度与 W88 基线指标 13/13b 的「字符数」是两把尺**（ADJ ㊾）：那两条量的是
 * `String.length`，本组量的是**终端列宽**。两者在纯 ASCII 上重合、在 CJK 上差一倍，
 * 谁也不能拿去顶替谁。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 出货文档全集（40 份）。**从磁盘现算**，新增一份文档会自动进射程。 */
const SHIP_DOCS: readonly string[] = (() => {
  const rootDocs = readdirSync(".").filter((f) => f.endsWith(".md")).sort();
  const langDocs = LANGS.flatMap((lang) =>
    readdirSync(join("docs", lang)).filter((f) => f.endsWith(".md")).sort()
      .map((f) => join("docs", lang, f)));
  return [...rootDocs, ...langDocs];
})();

/** 东亚宽字符（含中日韩、假名、全角标点）与 emoji 按 2 列计，其余按 1 列。 */
const EAST_ASIAN_WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u;
const displayWidth = (s: string): number =>
  [...s].reduce((n, ch) => n + (EAST_ASIAN_WIDE.test(ch) || (ch.codePointAt(0) ?? 0) > 0x1f000 ? 2 : 1), 0);

/** 剥围栏：返回 `{ line, no }`，围栏内与围栏定界行一律不返回。 */
const bodyLines = (text: string): ReadonlyArray<{ line: string; no: number }> => {
  let inFence = false;
  const out: Array<{ line: string; no: number }> = [];
  text.split("\n").forEach((line, i) => {
    if (FENCE_LINE.test(line)) { inFence = !inFence; return; }
    if (!inFence) out.push({ line, no: i + 1 });
  });
  return out;
};

/** 任意一行表格拆成格子（要求首尾都是 `|`）。 */
const rowCells = (line: string): string[] => {
  const t = line.trim();
  return t.slice(1, t.length - 1).split("|").map((c) => c.trim());
};

/** 分隔行：整行只由 `|`、`-`、可选冒号与空白构成。 */
const SEPARATOR_ROW = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
/** 极简分隔行：**每一格**都是 1–3 个 `-`（可带对齐冒号）。 */
const MINIMAL_SEPARATOR = /^\s*\|(?:\s*:?-{1,3}:?\s*\|)+\s*$/;

type SepScan = {
  readonly minimal: string[];
  readonly colon: string[];
  readonly narrow: string[];
  readonly tables: number;
  readonly cells: number;
  readonly skippedNoHeader: number;
  readonly skippedColMismatch: number;
};

/**
 * 一组文档的分隔行体检。**只读文本，不碰磁盘**，反向控制因此可以直接喂变异过的字符串。
 */
const scanSeparators = (docs: ReadonlyArray<readonly [path: string, text: string]>): SepScan => {
  const minimal: string[] = [], colon: string[] = [], narrow: string[] = [];
  let tables = 0, cells = 0, skippedNoHeader = 0, skippedColMismatch = 0;
  for (const [path, text] of docs) {
    const rows = bodyLines(text);
    rows.forEach((r, i) => {
      if (!SEPARATOR_ROW.test(r.line)) return;
      if (MINIMAL_SEPARATOR.test(r.line)) minimal.push(`${path}:${r.no} ${r.line.trim()}`);
      if (r.line.includes(":")) colon.push(`${path}:${r.no} ${r.line.trim()}`);
      const header = rows[i - 1]?.line ?? "";
      if (!header.trim().startsWith("|")) { skippedNoHeader++; return; }
      const h = rowCells(header), s = rowCells(r.line);
      if (h.length !== s.length) { skippedColMismatch++; return; }
      tables++;
      h.forEach((head, k) => {
        cells++;
        const need = Math.max(4, displayWidth(head));
        const got = (s[k] ?? "").replace(/:/g, "").length;
        if (got < need) {
          narrow.push(`${path}:${r.no} 第 ${k + 1} 格：表头「${head}」显示宽度 ${need}，`
            + `分隔行只有 ${got} 个 \`-\``);
        }
      });
    });
  }
  return { minimal, colon, narrow, tables, cells, skippedNoHeader, skippedColMismatch };
};

/** 真文档，读一次给全组用。 */
const shipDocPairs = (): ReadonlyArray<readonly [string, string]> =>
  SHIP_DOCS.map((p) => [p, readFileSync(p, "utf8")] as const);

/** 把某份文档的正文替换一处，其余原样返回——反向控制的公共夹具。 */
const shipDocsWith = (
  path: string, mutate: (s: string) => string,
): ReadonlyArray<readonly [string, string]> =>
  shipDocPairs().map(([p, t]) => (p === path ? [p, mutate(t)] as const : [p, t] as const));

describe("W116 表格分隔行逐格补齐：宽度跟着表头走，不许有极简格、不许有对齐冒号", () => {
  it("射程自守：40 份出货文档、每一份都读得到，而且真的扫到了表格", () => {
    expect(SHIP_DOCS.length, `出货文档从 40 份变成了 ${SHIP_DOCS.length} 份 —— `
      + "本组的射程是从磁盘现算的，数变了就该有人来确认新增/删除的那份该不该进射程")
      .toBe(40);
    expect(SHIP_DOCS.filter((p) => !existsSync(p)), "射程里有读不到的文件").toEqual([]);
    const scan = scanSeparators(shipDocPairs());
    expect(scan.tables, "一张表都没扫到 —— 判据在测空气，多半是分隔行正则写坏了")
      .toBeGreaterThan(100);
    expect(scan.cells, "格子数不该少于表数").toBeGreaterThan(scan.tables);
  });

  it("R22a 极简分隔行恒为 0（剥围栏后）", () => {
    const { minimal } = scanSeparators(shipDocPairs());
    expect(minimal, `还有极简 \`|---|\` 分隔行：\n${minimal.join("\n")}`).toEqual([]);
  });

  it("R22c 显式对齐冒号恒为 0（`|:---|` / `|---:|` / `|:---:|` 一概不用）", () => {
    const { colon } = scanSeparators(shipDocPairs());
    expect(colon, `分隔行里出现了对齐冒号：\n${colon.join("\n")}`).toEqual([]);
  });

  it("R22b 逐格恒等式：每格 `-` 数 ≥ 该列表头的显示宽度（CJK 按 2 计）且 ≥ 4", () => {
    const { narrow } = scanSeparators(shipDocPairs());
    expect(narrow, `分隔行的宽度没跟着表头走：\n${narrow.join("\n")}`).toEqual([]);
  });

  it("认不出要吵：表头行认不出（不以 `|` 起头）或列数对不上时不许静静放行 —— 今天两者都是 0", () => {
    const scan = scanSeparators(shipDocPairs());
    expect([scan.skippedNoHeader, scan.skippedColMismatch],
      "有分隔行的上一行不是表头、或表头与分隔行列数对不上 —— 那种表本组量不了，"
      + "今天是 0；变成非 0 说明仓里出现了本组看不见的表，得先决定怎么量它")
      .toEqual([0, 0]);
  });

  it("显示宽度这把尺自身：CJK/假名/韩文按 2 列，ASCII 按 1 列", () => {
    expect(displayWidth("变量")).toBe(4);
    expect(displayWidth("必填")).toBe(4);
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("한국어")).toBe(6);
    expect(displayWidth("Required")).toBe(8);
    expect(displayWidth("`reason`")).toBe(8);
    expect(displayWidth("说明 / Notes")).toBe(12);
  });

  it("该红时红（一）：把一条分隔行改回极简 `|---|` —— R22a 与 R22b 同时红并点名文件行号", () => {
    const target = join("docs", "zh-CN", "DEPLOY.md");
    const base = scanSeparators(shipDocPairs());
    expect(base.minimal.length + base.narrow.length, "起点就不干净，这一格测不出东西").toBe(0);
    const docs = shipDocsWith(target, (s) => s.replace(/^\|-+\|-+\|-+\|-+\|$/m, "|---|---|---|---|"));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地 —— 那份文档里没有四列表格")
      .not.toEqual(readFileSync(target, "utf8"));
    const scan = scanSeparators(docs);
    expect(scan.minimal.join("\n"), "极简分隔行回来了，R22a 却没红").toContain(`${target}:`);
    expect(scan.narrow.join("\n"), "宽度不达标了，R22b 却没红").toContain(`${target}:`);
  });

  it("该红时红（二）：**只改第一列**的假补齐 `|----|---|---|` —— R22a 逃得掉，R22b 必须红", () => {
    const target = join("docs", "zh-CN", "DEPLOY.md");
    const docs = shipDocsWith(target, (s) => s.replace(/^\|-+\|-+\|-+\|-+\|$/m, "|----|---|---|---|"));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const scan = scanSeparators(docs);
    // 这一行每一格不全 ≤3 个 `-`（第一格有 4 个）⇒ 「极简分隔行」这条**看不见它**。
    expect(scan.minimal, "假补齐居然被 R22a 抓到了 —— 那本格的立论（旧判据抓不住它）就不成立了")
      .toEqual([]);
    expect(scan.narrow.join("\n"), "假补齐没被 R22b 抓到 —— 这正是 W116 换判据的唯一理由")
      .toContain(`${target}:`);
  });

  it("该红时红（三）：给一条分隔行加上对齐冒号 —— R22c 红", () => {
    const target = join("docs", "en", "API.md");
    const docs = shipDocsWith(target, (s) => s.replace(/^\|(-+)\|/m, "|:$1|"));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    expect(scanSeparators(docs).colon.join("\n"), "对齐冒号进来了，R22c 却没红").toContain(`${target}:`);
  });

  it("不许乱红：围栏里教人写 markdown 表格的示例不进射程", () => {
    const target = join("docs", "zh-CN", "API.md");
    const decoy = "\n```markdown\n| 表头 | b |\n|:---|---:|\n| x | y |\n```\n";
    const docs = shipDocsWith(target, (s) => s + decoy);
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const scan = scanSeparators(docs);
    expect([scan.minimal, scan.colon, scan.narrow],
      "围栏里的示例被算进来了 —— 剥围栏那一步没生效，本组三条判据全都会误伤示例代码")
      .toEqual([[], [], []]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * W117 — 4 空格嵌套列表展平到 2 空格（R22 的列表那一半）
 *
 * 两个参照仓的 `^    [-*] ` 合计 **0 处**，agnes 此前 **105 处**（全在五份
 * `DEPLOY.md`，各 21 处）。**嵌套深度硬上限 1 层**：2 空格是第一层，
 * `^      [-*] `（6 空格）意味着又套了一层，本组一并钉死为 0。
 *
 * ⚠️ **展平不是只把那一行减 2 个空格**：嵌套项的**续行**原本缩进 6 格，
 * 不跟着减 2 会比它自己的标记多缩 2 格。本组因此还配一格「不许留下孤儿续行」：
 * 剥围栏后，紧跟在 `  - ` 项下的续行缩进只许是 4（或者更浅，那是回到上一层）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 剥围栏后命中给定正则的行，报文带路径与行号。 */
const bodyHits = (
  docs: ReadonlyArray<readonly [string, string]>, re: RegExp,
): string[] => docs.flatMap(([path, text]) =>
  bodyLines(text).filter((r) => re.test(r.line)).map((r) => `${path}:${r.no} ${JSON.stringify(r.line)}`));

const NESTED_4 = /^ {4}[-*] /;
const NESTED_6 = /^ {6}[-*] /;

describe("W117 列表嵌套只用 2 空格，深度硬上限 1 层", () => {
  it("R22 `^    [-*] ` 恒为 0（剥围栏后，40 份出货文档）", () => {
    const hits = bodyHits(shipDocPairs(), NESTED_4);
    expect(hits, `还有 4 空格嵌套列表（两个参照仓合计 0 处）：\n${hits.join("\n")}`).toEqual([]);
  });

  it("R22 `^      [-*] ` 恒为 0 —— 嵌套深度硬上限 1 层", () => {
    const hits = bodyHits(shipDocPairs(), NESTED_6);
    expect(hits, `出现了第二层嵌套：\n${hits.join("\n")}`).toEqual([]);
  });

  it("展平不许留下孤儿续行：`  - ` 项的续行缩进不许还是 6 格", () => {
    const orphans: string[] = [];
    for (const [path, text] of shipDocPairs()) {
      const rows = bodyLines(text);
      rows.forEach((r, i) => {
        if (!/^ {2}[-*] /.test(r.line)) return;
        const next = rows[i + 1];
        if (next === undefined || next.no !== r.no + 1) return;
        if (/^ {6}\S/.test(next.line)) {
          orphans.push(`${path}:${next.no} 上一行是 2 空格的嵌套项，这一行却还缩着 6 格`);
        }
      });
    }
    expect(orphans, `展平只减了标记行、续行留在原地：\n${orphans.join("\n")}`).toEqual([]);
  });

  it("该红时红：把一处嵌套改回 4 空格 —— 两条判据里的第一条红并点名行号", () => {
    const target = join("docs", "zh-CN", "DEPLOY.md");
    const docs = shipDocsWith(target, (s) => s.replace(/^ {2}- \*\*补池锁\*\*/m, "    - **补池锁**"));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地 —— 那一行的锚字面改了")
      .not.toEqual(readFileSync(target, "utf8"));
    expect(bodyHits(docs, NESTED_4).join("\n"), "4 空格嵌套回来了却没红").toContain(`${target}:`);
  });

  it("该红时红：套出第二层 —— `^      [-*] ` 那一格红", () => {
    const target = join("docs", "en", "DEPLOY.md");
    const docs = shipDocsWith(target, (s) => s.replace(/^ {2}- /m, "      - "));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    expect(bodyHits(docs, NESTED_6).join("\n"), "第二层嵌套进来了却没红").toContain(`${target}:`);
  });

  it("不许乱红：围栏里的 4 空格缩进（yaml / 代码本来就长这样）不进射程", () => {
    const target = join("docs", "ja", "DEPLOY.md");
    const decoy = "\n```yaml\nservices:\n  app:\n    - 这一行在围栏里\n```\n\n```text\n    - 也在围栏里\n```\n";
    const docs = shipDocsWith(target, (s) => s + decoy);
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    expect([bodyHits(docs, NESTED_4), bodyHits(docs, NESTED_6)],
      "围栏里的缩进被算进来了 —— 剥围栏那一步没生效，本组会误伤 yaml 与代码示例")
      .toEqual([[], []]);
  });

  it("射程自守：今天真的存在 2 空格的一层嵌套 —— 否则上面几格是在守一片空地", () => {
    const flat = bodyHits(shipDocPairs(), /^ {2}[-*] /);
    expect(flat.length, "40 份文档里一处 2 空格嵌套列表都没有 —— 展平判据没有被守护的对象，"
      + "多半是正则或剥围栏写坏了").toBeGreaterThan(50);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * W75 — 25 份非 README 文档不带 `**语言：**` 切换行
 *
 * 两个参照仓的**非 README 文档一条都没有**（`grep -l '^\*\*语言\|^\*\*Language'`
 * 在 K/G 上共 10 处命中，**全在各语言版 README**）。模板的做法是在 README 正文里
 * 写 `> 📖 详细XX文档：…` 那种引用行，那些已在阶段 5 落地。
 *
 * ⚠️ **这一组配一条同批的「删了还进得去」**：切换行是这 25 份此前**唯一**的跨语言
 * 导航件。只判「没了」而不判「另有入口」，等于把可达性删掉还判绿。
 * 下面第 2 格因此钉住：每一份都被**同语言的** `docs/{lang}/README.md` 链着。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 25 份非 README 文档（`API/DEPLOY/USAGE/ADMIN/REGISTRAR` × 5 语言）。 */
const NON_README_DOCS = ["API", "DEPLOY", "USAGE", "ADMIN", "REGISTRAR"] as const;
const NON_README_25: readonly string[] =
  LANGS.flatMap((lang) => NON_README_DOCS.map((d) => join("docs", lang, `${d}.md`)));
const non25Pairs = (): ReadonlyArray<readonly [string, string]> =>
  NON_README_25.map((p) => [p, readFileSync(p, "utf8")] as const);

/** 语言切换行：`**语言：**` / `**Language:**` / `**언어:**` —— **冒号在加粗内部**。 */
const LANG_SWITCHER_LINE = /^\*\*(语言|語言|Language|言語|언어)/;

/** 每份非 README 文档在**同语言** README 里的入口。读取器可替换，反向控制因此不用碰磁盘。 */
const siblingEntryFailures = (readReadme: (lang: string) => string): string[] => {
  const out: string[] = [];
  for (const lang of LANGS) {
    const readme = readReadme(lang);
    for (const doc of NON_README_DOCS) {
      if (!readme.includes(`](${doc}.md)`)) {
        out.push(`docs/${lang}/README.md 里没有指向同目录 ${doc}.md 的链接 —— `
          + "切换行删掉之后，那份文档在本语言的文档树里一个入口都没有了");
      }
    }
  }
  return out;
};
const realLangReadme = (lang: string) => readFileSync(join("docs", lang, "README.md"), "utf8");

describe("W75 非 README 文档不带 `**语言：**` 切换行（参照仓一条都没有）", () => {
  it("射程自守：25 份都在，而且切换行正则今天在 README 上仍然认得出东西", () => {
    expect(NON_README_25.length).toBe(25);
    expect(NON_README_25.filter((p) => !existsSync(p)), "射程里有读不到的文件").toEqual([]);
    // ⚠️ 认不出要吵：若正则写坏了（例如写成闭合的 `^\*\*语言\*\*`），下面那一格会**静默全绿**。
    // 拿一条合成的真样本反过来证明它认得出。
    expect(LANG_SWITCHER_LINE.test("**语言：** [English](../en/API.md) | 简体中文"), "切换行正则认不出中文写法").toBe(true);
    expect(LANG_SWITCHER_LINE.test("**Language:** English | [简体中文](../zh-CN/API.md)"), "认不出英文写法").toBe(true);
    expect(LANG_SWITCHER_LINE.test("**언어:** [English](../en/USAGE.md) | 한국어"), "认不出韩文写法").toBe(true);
  });

  it("R26 `docs/*/{API,DEPLOY,USAGE,ADMIN,REGISTRAR}.md` 上零命中（剥围栏后）", () => {
    const hits = bodyHits(non25Pairs(), LANG_SWITCHER_LINE);
    expect(hits, `还留着语言切换行：\n${hits.join("\n")}`).toEqual([]);
  });

  it("删了切换行之后还进得去：25 份各自被**同语言**的 README 链着", () => {
    expect(siblingEntryFailures(realLangReadme), siblingEntryFailures(realLangReadme).join("\n")).toEqual([]);
  });

  it("该红时红：把切换行加回 `docs/ko/USAGE.md` —— 报文点名该文件与行号", () => {
    const target = join("docs", "ko", "USAGE.md");
    const docs = non25Pairs().map(([p, t]) => (p === target
      ? [p, t.replace(/^(# .*\n)/m, "$1\n**언어:** [English](../en/USAGE.md) | 한국어\n")] as const
      : [p, t] as const));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    expect(bodyHits(docs, LANG_SWITCHER_LINE).join("\n"), "切换行回来了却没红").toContain(`${target}:`);
  });

  it("该红时红：`docs/ja/README.md` 丢掉指向 REGISTRAR.md 的链接 —— 「还进得去」那一格红并点名", () => {
    const read = (lang: string) => {
      const t = readFileSync(join("docs", lang, "README.md"), "utf8");
      return lang === "ja" ? t.replace("](REGISTRAR.md)", "](#)") : t;
    };
    expect(read("ja"), "变异没落地 —— ja 的 README 里没有那条链接的原字面")
      .not.toEqual(readFileSync(join("docs", "ja", "README.md"), "utf8"));
    const failures = siblingEntryFailures(read);
    expect(failures.join("\n"), "入口没了却没红").toContain("docs/ja/README.md 里没有指向同目录 REGISTRAR.md");
    expect(failures, "只该红这一条").toHaveLength(1);
  });

  it("不许乱红：围栏里演示切换行写法的示例不进射程", () => {
    const target = join("docs", "zh-CN", "DEPLOY.md");
    const docs = non25Pairs().map(([p, t]) => (p === target
      ? [p, `${t}\n\`\`\`markdown\n**语言：** [English](../en/X.md) | 简体中文\n\`\`\`\n`] as const
      : [p, t] as const));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    expect(bodyHits(docs, LANG_SWITCHER_LINE), "围栏里的示例被算进来了 —— 剥围栏没生效").toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * W97 — 25 份非 README 文档里位置不对的 `---` 删掉（R20/P4②）
 *
 * **【ADJ 改判】这一条不是「删掉全部 `---`」。** 模板允许**页脚节之前**留一条：
 * 参照仓 kiro2api 的非 README 文档实测有 **5 处**（`ja/API`、`ja/DEPLOY`、`ko/API`、
 * `ko/USAGE`、`zh-TW/API`），而**每一处都在该文档最后一个 `##` 之后**、紧跟着一段
 * 页脚块（`> 📖 関連ドキュメント…` 或 `<div align="center">`）——**没有一处横在
 * 两个 `##` 之间**。agnes 此前那 5 条恰恰相反：五份 `API.md` 各 1 条，
 * 都夹在正文与 `## \`GET /health\`` 之间，全文后面还有几百行。
 *
 * ⇒ 判据分两条，正好对上这个形状：
 * ① **hr-before-h2 恒为 0** —— `---` 后面第一个非空行是 `## ` 标题的，一条都不许有；
 * ② **`^---$` 总数 ≤ 1，且若有那一条必须在全文最后一个 `## ` 之后**（页脚区）。
 *
 * 这两条**必须一起立**：只有 ① 的话，把 `---` 塞到两个 `###` 之间就能逃；
 * 只有 ② 的话，把 `---` 放在倒数第二节的末尾（下一行就是页脚 `##`）也能逃。
 * ══════════════════════════════════════════════════════════════════════════ */

const HR_LINE = /^---$/;
const H2_LINE = /^## /;

type HrScan = { readonly beforeH2: string[]; readonly misplaced: string[]; readonly total: number };

/** 25 份非 README 文档的 `---` 体检。剥围栏后再看，围栏里的 yaml 文档分隔符不算。 */
const scanHorizontalRules = (docs: ReadonlyArray<readonly [string, string]>): HrScan => {
  const beforeH2: string[] = [], misplaced: string[] = [];
  let total = 0;
  for (const [path, text] of docs) {
    const rows = bodyLines(text);
    const lastH2 = rows.reduce((acc, r, i) => (H2_LINE.test(r.line) ? i : acc), -1);
    const hits = rows.map((r, i) => [r, i] as const).filter(([r]) => HR_LINE.test(r.line));
    total += hits.length;
    for (const [r, i] of hits) {
      const next = rows.slice(i + 1).find((x) => x.line.trim() !== "");
      if (next !== undefined && H2_LINE.test(next.line)) {
        beforeH2.push(`${path}:${r.no} 这条 \`---\` 横在正文与 \`${next.line.trim()}\` 之间`);
      }
      if (i < lastH2) {
        misplaced.push(`${path}:${r.no} 这条 \`---\` 在最后一个 \`##\` 之前 —— `
          + "模板只在页脚块之前留分隔线（kiro2api 那 5 处全在最后一个 `##` 之后）");
      }
    }
    if (hits.length > 1) {
      misplaced.push(`${path} 有 ${hits.length} 条 \`---\`，上限是 1 条`);
    }
  }
  return { beforeH2, misplaced, total };
};

describe("W97 非 README 文档里位置不对的 `---` 删掉（页脚块之前允许留 ≤1 条）", () => {
  it("R20/P4② ① hr-before-h2 恒为 0（剥围栏后，25 份）", () => {
    const { beforeH2 } = scanHorizontalRules(non25Pairs());
    expect(beforeH2, `还有横在两节之间的 \`---\`：\n${beforeH2.join("\n")}`).toEqual([]);
  });

  it("R20/P4② ② 每份 `^---$` ≤ 1 条，且那一条必须落在最后一个 `##` 之后（页脚区）", () => {
    const { misplaced } = scanHorizontalRules(non25Pairs());
    expect(misplaced, `\`---\` 的位置不对：\n${misplaced.join("\n")}`).toEqual([]);
  });

  it("今天的实测值：这 25 份一条 `---` 都没有（阶段 7 后续给页脚块时可以加回 1 条/份）", () => {
    expect(scanHorizontalRules(non25Pairs()).total,
      "这个数从 0 变了就该有人来确认：加回来的那条是不是真在页脚块之前").toBe(0);
  });

  it("该红时红（一）：把 `---` 加回 `docs/zh-CN/API.md` 的 `## 系统 API` 之前 —— ① 与 ② 同时红", () => {
    const target = join("docs", "zh-CN", "API.md");
    const docs = non25Pairs().map(([p, t]) => (p === target
      ? [p, t.replace(/^## 系统 API$/m, "---\n\n## 系统 API")] as const : [p, t] as const));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const scan = scanHorizontalRules(docs);
    expect(scan.beforeH2.join("\n"), "hr-before-h2 回来了却没红").toContain(`${target}:`);
    expect(scan.misplaced.join("\n"), "位置不对却没被 ② 抓到").toContain(`${target}:`);
  });

  it("该红时红（二）：`---` 放在倒数第二节末尾（下一行不是 `##`）—— ① 逃得掉，② 必须红", () => {
    const target = join("docs", "en", "API.md");
    const lines = readFileSync(target, "utf8").split("\n");
    const lastH2 = lines.reduce((acc, l, i) => (H2_LINE.test(l) ? i : acc), -1);
    expect(lastH2, "抽不到最后一个 `##`，这一格测不出东西").toBeGreaterThan(0);
    // ⚠️ 只能插在最后一个 `##` 这一行的**正前方**：往前挪几行会掉进 ```json 围栏里，
    //    那样整段夹具会被剥围栏那一步吃掉，这一格就变成在测空气（本轮实测栽过一次）。
    lines.splice(lastH2, 0, "---", "", "还有一段正文，所以下一行不是 `##`。", "");
    const docs = non25Pairs().map(([p, t]) => (p === target ? [p, lines.join("\n")] as const : [p, t] as const));
    const scan = scanHorizontalRules(docs);
    expect(scan.beforeH2, "这一格的立论是 ① 抓不住它；① 抓住了说明夹具没摆对").toEqual([]);
    expect(scan.misplaced.join("\n"), "`---` 在最后一个 `##` 之前却没被 ② 抓到").toContain(`${target}:`);
  });

  it("不许乱红（一）：模板那种页脚分隔线（最后一个 `##` 之后、页脚块之前）放行", () => {
    const target = join("docs", "ko", "USAGE.md");
    const docs = non25Pairs().map(([p, t]) => (p === target
      ? [p, `${t}\n---\n\n> 자세한 내용은 [API](API.md)를 참고하세요.\n`] as const : [p, t] as const));
    const scan = scanHorizontalRules(docs);
    expect([scan.beforeH2, scan.misplaced],
      "kiro2api 那 5 处页脚分隔线就是这个形状，判据把模板自己的写法判红了")
      .toEqual([[], []]);
    expect(scan.total, "夹具没落地").toBe(1);
  });

  /* ── W97 的另一半：标题 emoji 今天是 0，本组只守住不回退（R25f）──────────────
   * §1.3(e) 固化的 `EMOJI` 常量正则**必须含 BMP 那一段**：窄义 `[\u{1F300}-\u{1FAFF}]`
   * 会让 `⚡⚙⚠☕⭐→` 全部漏网，而 README 那 16 个 emoji 标题用的正是这一族。
   * 两个参照仓剥围栏后的非 README 标题 emoji 数同样是 0（那 4 处「反例」实测全在
   * 代码围栏里，是 shell 注释不是标题）。 */
  it("R25f 这 25 份的标题 emoji 恒为 0（剥围栏后）", () => {
    const hits = bodyHits(non25Pairs(), /^#{1,6} .*[←-⇿⌀-⏿■-➿⬀-⯿️\u{1F000}-\u{1FAFF}]/u);
    expect(hits, `非 README 文档的标题带上了 emoji（射程铁律：这 25 份不给标题加 emoji）：\n${hits.join("\n")}`)
      .toEqual([]);
  });

  it("R25f 该红时红：给一个 `##` 加上 emoji —— 报文点名该文件与行号", () => {
    const target = join("docs", "zh-TW", "ADMIN.md");
    const docs = non25Pairs().map(([p, t]) => (p === target
      ? [p, t.replace(/^## /m, "## \u26a1 ")] as const : [p, t] as const));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const hits = bodyHits(docs, /^#{1,6} .*[←-⇿⌀-⏿■-➿⬀-⯿️\u{1F000}-\u{1FAFF}]/u);
    expect(hits.join("\n"), "BMP 段的 `⚡` 没被抓到 —— 谓词退回窄义了，README 那 16 个 emoji 标题也会一起漏")
      .toContain(`${target}:`);
  });

  it("不许乱红（二）：围栏里的 yaml 文档分隔符 `---` 不进射程", () => {
    const target = join("docs", "ja", "DEPLOY.md");
    const docs = non25Pairs().map(([p, t]) => (p === target
      ? [p, `${t}\n\`\`\`yaml\n---\nservices:\n  app:\n    image: x\n\`\`\`\n`] as const : [p, t] as const));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const scan = scanHorizontalRules(docs);
    expect([scan.beforeH2, scan.misplaced, scan.total],
      "围栏里的 `---` 被算进来了 —— 剥围栏没生效，本组会误伤 compose 与 front-matter 示例")
      .toEqual([[], [], 0]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * W103 — 表格行与单元格的长度上限（R22e / R22e2）
 *
 * **射程**：25 份非 README 文档（`API/DEPLOY/USAGE/ADMIN/REGISTRAR` × 5 语言），
 * 与本文件 W75 / W97 / R25f 三组同一份 `non25Pairs()`。**README 不设上限**（ADJ ㊻）：
 * 六份 README 的版本历史表天然是长行（`docs/en/README.md:62` 今天 501 字符），
 * 那一族由模板自己的形态决定，不归本组管。
 *
 * ⚠️⚠️ **340 / 300 这两个数是被 `tests/ui/settings.test.ts:312` 的落点顶上去的，
 * 不是从模板量的**（ADJ ㉞ / ㊹ / §64 明写的注释义务）。两个参照仓剥围栏后最长的
 * 表格行是 84（kiro2api）/ 53（gemini2api）——按模板量，这条线应该在 100 上下。
 * 顶上去的过程是可复算的：
 * · `settings.test.ts:312` 要求五语言 `DEPLOY.md` 的 `POOL_CACHE_TTL_MS` /
 *   `POOL_TOUCH_INTERVAL_MS` **那一行之内**同时含一整句 `PANEL_CAVEAT_BY_LANG[lang]`
 *   与出处 `src/http/wire.ts`；
 * · en 那句 caveat（`editing it in the admin panel does not take effect immediately`）
 *   本身就是 **62** 个字符，配上出处与前缀，`POOL_TOUCH_INTERVAL_MS` 那一行的**地板**
 *   （摘要长度取 0、尾句逐字保留）实测是 **254**；
 * · ADJ ㉞ 明令**不许删 caveat、不许删出处**来达标 ⇒ 只能抬阈值。
 *   340 同时容得下「尾句一字不动 + 85 字摘要 = 340」与「尾句收紧到 171 + 108 字摘要 = 329」
 *   两种改法，320 会**强制** en 侧同时收紧尾句与摘要（把压力转嫁给译文）。
 * · R22e2 = 300 同源：那两种改法的单元格分别是 291 / 291。
 *
 * ⚠️ **这两个数只为 en 的那两行而存在，不是给全仓的余量**。所以本组第三格
 * 钉死「今天射程内超过 200 字符的行数」：它是一条**棘轮**——阶段 7C/7D 把
 * `ADMIN.md` / `API.md` / `REGISTRAR.md` 重排之后这个数会掉，掉了本格当场红，
 * 逼人回来重新量。**没有这一格，340 就是一张全仓通行证。**
 *
 * ⚠️ **为什么不落「除那 4 行外一律 ≤200」的分档判据**（ADJ §64 把这件事留给本轮定）：
 * 今天射程内 >200 的有 **26** 行，其中 22 行住在 `ADMIN.md` / `API.md` / `REGISTRAR.md`
 * 与四种语言的 `DEPLOY.md` 里，属于 **W104 / W108 / W111 还没做**的那几批。
 * 现在落分档判据只有两条路：要么写一张 26 行的白名单（一张伪装成守卫的待办清单），
 * 要么把射程外的三类文档现在就改掉。两条都不是本轮该做的事 ⇒ 改成上面那条棘轮，
 * **它会自己到期**，而白名单不会。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 一行表格行的字符数（`[...s].length`，与 W88 基线指标 13 同一把尺，不是显示宽度）。 */
const charLen = (s: string): number => [...s].length;

type WideScan = {
  /** 整行超过 `R22E_ROW` 的。 */
  readonly wideRows: string[];
  /** 单个单元格超过 `R22E2_CELL` 的。 */
  readonly wideCells: string[];
  /** 射程内被扫到的表格行总数（分隔行不计）。 */
  readonly rows: number;
  /** 射程内超过 200 字符的行（棘轮那一格用）。 */
  readonly over200: string[];
};

/** R22e：任一表格行的字符数上限。**这个数的来历见本组文件头，别当成从模板量的**。 */
const R22E_ROW = 340;
/** R22e2：任一单元格的字符数上限。同源。 */
const R22E2_CELL = 300;

/**
 * 一组文档的表格行长度体检。**只读文本，不碰磁盘**，反向控制因此可以直接喂变异过的字符串。
 *
 * 口径与 W116 那一组共用：先剥围栏（`bodyLines`），再取首尾都是 `|` 的行，
 * **分隔行不算数据行**（它的长度由 W116 的逐格恒等式决定，两组算同一行会互相打架）。
 */
const scanWideRows = (docs: ReadonlyArray<readonly [path: string, text: string]>): WideScan => {
  const wideRows: string[] = [], wideCells: string[] = [], over200: string[] = [];
  let rows = 0;
  for (const [path, text] of docs) {
    for (const { line, no } of bodyLines(text)) {
      const t = line.trim();
      if (!t.startsWith("|") || !t.endsWith("|")) continue;
      if (SEPARATOR_ROW.test(line)) continue;
      rows += 1;
      const len = charLen(line);
      if (len > 200) over200.push(`${path}:${no}（${len}）`);
      if (len > R22E_ROW) {
        wideRows.push(`${path}:${no} 整行 ${len} 字符 > ${R22E_ROW}：${t.slice(0, 60)}…`);
      }
      rowCells(t).forEach((c, k) => {
        const cl = charLen(c);
        if (cl > R22E2_CELL) {
          wideCells.push(`${path}:${no} 第 ${k + 1} 格 ${cl} 字符 > ${R22E2_CELL}：${c.slice(0, 60)}…`);
        }
      });
    }
  }
  return { wideRows, wideCells, rows, over200 };
};

/** 把某份非 README 文档的正文替换一处，其余原样——反向控制的公共夹具。 */
const non25With = (
  path: string, mutate: (s: string) => string,
): ReadonlyArray<readonly [string, string]> =>
  non25Pairs().map(([p, t]) => (p === path ? [p, mutate(t)] as const : [p, t] as const));

describe("W103 表格行与单元格的长度上限（R22e ≤ 340 / R22e2 ≤ 300）", () => {
  it("射程自守：25 份非 README 文档、每一份都读得到，而且真的扫到了表格行", () => {
    expect(NON_README_25.length, "射程从 25 份变了 —— 先确认新增/删除的那份该不该进本组")
      .toBe(25);
    expect(NON_README_25.filter((p) => !existsSync(p)), "射程里有读不到的文件").toEqual([]);
    const scan = scanWideRows(non25Pairs());
    expect(scan.rows, "一行表格行都没扫到 —— 判据在测空气，多半是行首/行尾那两个 `|` 的判定写坏了")
      .toBeGreaterThan(300);
  });

  it("R22e：射程内没有任何一行表格行超过 340 字符", () => {
    const { wideRows } = scanWideRows(non25Pairs());
    expect(
      wideRows,
      `这些表格行超过了 ${R22E_ROW} 字符：\n${wideRows.join("\n")}\n`
      + "⇒ 处置是 W103 那一条：表里只留一句摘要，长解释移到表下的 `>` 引用块或 `> [!NOTE]`。"
      + "🔴 **不许靠删 caveat 或删出处来达标**（ADJ ㉞）—— `tests/ui/settings.test.ts` "
      + "要求 `POOL_*` 那两行之内同时含一整句 caveat 与 `src/http/wire.ts`，删了当场红。",
    ).toEqual([]);
  });

  it("R22e2：射程内没有任何一个单元格超过 300 字符", () => {
    const { wideCells } = scanWideRows(non25Pairs());
    expect(
      wideCells,
      `这些单元格超过了 ${R22E2_CELL} 字符：\n${wideCells.join("\n")}\n`
      + "⇒ 与 R22e 同一条处置。两条不是同一件事：一行可以由多个格拼成，"
      + "整行合规而某一格独大时读者仍然要横着读一屏。",
    ).toEqual([]);
  });

  /**
   * **棘轮：射程内 >200 字符的行数今天是多少，钉死。**
   *
   * 340 / 300 只为 en 的 `POOL_CACHE_TTL_MS` / `POOL_TOUCH_INTERVAL_MS` 那两行而存在
   * （见本组文件头）。**没有这一格，那两个数就是一张全仓通行证**：任何人往任何一张表里
   * 塞一段 300 字符的散文都不会红。
   *
   * **维护规矩**：这个数**变大** = 有人在往表里塞长句，先看清楚是不是该塞；
   * **变小** = W104 / W108 / W111 那几批在推进，回来重新量一遍写进这里，并在提交正文里
   * 写明是哪一批在推。**不许把这一格删掉、也不许改成 `toBeLessThanOrEqual`** ——
   * 那等于把「只会变松、不会变紧」的老样子放回来。
   */
  it("棘轮：射程内超过 200 字符的表格行恰好还是今天这些（变大 = 有人在塞长句，变小 = 该回来重新量）", () => {
    const OVER_200_TODAY = 26;
    const { over200 } = scanWideRows(non25Pairs());
    expect(
      over200.length,
      `射程内 >200 字符的表格行从 ${OVER_200_TODAY} 变成了 ${over200.length}：\n`
      + `${over200.join("\n")}\n`
      + "⇒ 变大：先确认这一行为什么非长不可（R22e 的 340 只为 en 那两行 caveat 而存在，不是通行证）；\n"
      + "⇒ 变小：W104 / W108 / W111 那几批在推进，把这个数重新量一遍写回本格。",
    ).toBe(OVER_200_TODAY);
  });

  /* ── 反向控制：该红时红 / 不许乱红 ───────────────────────────────────────── */

  it("该红时红：把一行撑到 341 字符 ⇒ R22e 点名该文件与行号，而 R22e2 不响", () => {
    const target = join("docs", "zh-CN", "USAGE.md");
    // 两格各 170 ⇒ 整行 347 > 340，而**每一格都 ≤300** —— 这一格要证明的正是两条互相独立。
    const docs = non25With(target, (s) => `${s}\n| ${"x".repeat(170)} | ${"y".repeat(170)} |\n`);
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const scan = scanWideRows(docs);
    expect(scan.wideRows.join("\n"), "撑到 341 的那一行没被 R22e 抓到").toContain(`${target}:`);
    expect(scan.wideCells, "整行超标但每一格都 ≤300 —— R22e2 不该跟着响").toEqual([]);
  });

  it("该红时红：整行合规而某一格 301 字符 ⇒ R22e2 单独响（证明两条不是同一条）", () => {
    const target = join("docs", "ja", "USAGE.md");
    const docs = non25With(target, (s) => `${s}\n| ${"x".repeat(301)} |\n`);
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const scan = scanWideRows(docs);
    expect(scan.wideRows, `整行只有 305 字符，R22e 不该响：\n${scan.wideRows.join("\n")}`).toEqual([]);
    expect(scan.wideCells.join("\n"), "301 字符那一格没被 R22e2 抓到").toContain(`${target}:`);
  });

  it("不许乱红：围栏里教人写 markdown 表格的长行不进射程", () => {
    const target = join("docs", "ko", "USAGE.md");
    const docs = non25With(target, (s) => `${s}\n\`\`\`markdown\n| a | ${"x".repeat(400)} |\n\`\`\`\n`);
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const scan = scanWideRows(docs);
    expect([scan.wideRows, scan.wideCells], "围栏里的示例被算进来了 —— 剥围栏没生效")
      .toEqual([[], []]);
  });

  it("不许乱红：分隔行不算数据行（W116 的逐格恒等式会把宽表的分隔行撑得很长）", () => {
    const target = join("docs", "en", "USAGE.md");
    const sep = `|${" ".repeat(1)}${"-".repeat(400)}${" ".repeat(1)}|`;
    const docs = non25With(target, (s) => `${s}\n| h |\n${sep}\n| v |\n`);
    const scan = scanWideRows(docs);
    expect(scan.wideRows, `分隔行被当成数据行了：\n${scan.wideRows.join("\n")}`).toEqual([]);
  });

  it("认不出要吵的另一半：射程里塞一份没有任何表格的文档，`rows` 不许静静地变成 0", () => {
    // 这一格守的是「本组会不会在某天悄悄测空气」：只要射程里还有真表格，`rows` 就 > 0。
    const scan = scanWideRows([["fake.md", "# 标题\n\n没有表格。\n"] as const, ...non25Pairs()]);
    expect(scan.rows, "掺进一份无表格文档之后一行都扫不到了 —— 扫描器坏了").toBeGreaterThan(300);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * W98 — `### 配额账` 那一节：`<details>` 折叠 + `###`/`####` 分层
 *
 * **这一节是全仓最大的一块散文**（改写前 283 行 / en 373 行），而 V27 已裁定
 * **不拆出 QUOTA.md**（ADJ ㉑：参照仓只有五类文档，不新增文档类型）。
 * ⇒ 只能就地压缩观感：`####` 分层 + 一处 `<details>` 折叠最深的那段推导。
 *
 * ⚠️⚠️ **`<details>` 是 C23「这 25 份不用折叠块」那条射程铁律的具名例外**，
 * 而具名例外必须**同时**写进偏离名册，否则下一个人「顺手删掉 details」就把
 * ADJ ㉑ 的裁定推翻了，而且删掉时一格都不会红。W94 那份名册（阶段 6 的落点：一份新文档
 * 或测试内常量表，二选一）本期还没落地 ⇒ **本组先以测试内常量表的形态承担它**：
 * 下面的 `DETAILS_ALLOWLIST` 就是那条登记，双向钉死（多一处红、少一处也红）。
 * W94 落地那天把这张表搬过去，**别把它删掉了事**。
 *
 * ⚠️ **「text-run ≤1500」的口径写死在这里，不许换算法**：一个 run = 剥围栏后
 * **连续的正文行**，遇到空行 / 标题 / 表格行 / 围栏 / `<details>`·`<summary>` 标签
 * **中断**，遇到列表项起始（`- ` / `1. `）或引用块起始（`> `）**另起一个 run**。
 * 也就是「读者中间一个视觉锚点都没有的最长一段」。
 * 落地前实测：zh-CN 768 / zh-TW 772 / **en 1764** / ja 1020 / ko 1054
 * ⇒ **只有 en 顶穿**，而顶穿的 6 段里有一段是 en 独有的真错（一句话被 ⚠️ 段拦腰
 * 截断，其余四种语言都没有这个形状）。**这条判据是靠它才被发现的。**
 * ══════════════════════════════════════════════════════════════════════════ */

/** `### 配额账` 那一节的五语言标题（逐字，取自五份真文档）。 */
const QUOTA_SECTION_HEADING: Record<Lang, string> = {
  "zh-CN": "### 配额账：Worker + 免费档 KV 能撑多少请求",
  "zh-TW": "### 配額帳：Worker + 免費方案 KV 能撐多少請求",
  en: "### Quota budget: how many requests a Worker on the free KV tier can serve",
  ja: "### クォータの見積もり: Worker + 無料枠 KV で 1 日に何リクエストさばけるか",
  ko: "### 할당량 계산: Worker + 무료 등급 KV로 하루 몇 건을 처리할 수 있나",
};

/**
 * **`<details>` 的偏离名册（C23 的具名例外，W98 那一处）。**
 *
 * 双向：名册之外出现 `<details>` ⇒ 红（射程铁律被破）；名册之内没有 ⇒ 也红
 * （具名例外被人顺手删掉，而 ADJ ㉑「不拆 QUOTA.md」的前提就没了）。
 */
const DETAILS_ALLOWLIST: readonly string[] =
  LANGS.map((lang) => join("docs", lang, "DEPLOY.md"));

/** 一份文档里 `### 配额账` 那一节的正文行（含标题行），到下一个 `###`/`##` 为止。 */
function quotaSection(lang: Lang, src: string): string[] {
  const lines = src.split("\n");
  const at = lines.findIndex((l) => l === QUOTA_SECTION_HEADING[lang]);
  if (at < 0) {
    throw new Error(
      `docs/${lang}/DEPLOY.md 里找不到 ${JSON.stringify(QUOTA_SECTION_HEADING[lang])} ——`
      + " 判据的落点变了（标题被改名了？），先回来改 QUOTA_SECTION_HEADING，"
      + "不许让它静静地扫一段空文本",
    );
  }
  let to = at + 1;
  while (to < lines.length && !/^#{2,3} /.test(lines[to] ?? "")) to += 1;
  return lines.slice(at, to);
}

/**
 * 「读者中间一个视觉锚点都没有的最长一段」。口径见本组文件头，**别在别处再写第二份**。
 */
function textRuns(sectionLines: readonly string[]): Array<{ at: number; text: string }> {
  const isBreak = (s: string): boolean =>
    s.trim() === "" || /^#{1,6} /.test(s) || /^\s*\|/.test(s)
    || FENCE_LINE.test(s) || /^\s*<\/?(?:details|summary)/.test(s);
  const isNewRun = (s: string): boolean => /^\s*(?:[-*+]|\d+\.)\s/.test(s) || /^\s*>/.test(s);
  const out: Array<{ at: number; text: string }> = [];
  let cur: string[] = [];
  let curAt = 0;
  const flush = (): void => {
    if (cur.length > 0) out.push({ at: curAt, text: cur.join("") });
    cur = [];
  };
  sectionLines.forEach((s, i) => {
    if (isBreak(s)) { flush(); return; }
    if (isNewRun(s)) { flush(); curAt = i; } else if (cur.length === 0) { curAt = i; }
    cur.push(s.trim());
  });
  flush();
  return out;
}

/** 一份文档里剥围栏之后的 `<details>` / `</details>` / `<summary>` 行数。 */
const detailsTags = (src: string): { open: number; close: number; summary: number } => {
  let open = 0, close = 0, summary = 0;
  for (const { line } of bodyLines(src)) {
    if (/^\s*<details>/.test(line)) open += 1;
    if (/^\s*<\/details>/.test(line)) close += 1;
    if (/^\s*<summary>/.test(line)) summary += 1;
  }
  return { open, close, summary };
};

/** W98 的 text-run 上限。**这个数是规格给的验收值，不是量出来的**（W98 那一行）。 */
const W98_MAX_RUN = 1500;

describe("W98 `### 配额账` 的折叠与分层（`<details>` 是 C23 的具名例外）", () => {
  const realDeploy = (lang: Lang): string => readFileSync(docPath(".", lang, "DEPLOY"), "utf8");

  it("射程自守：五份 DEPLOY 都定位得到那一节，且那一节确实是全仓最大的一块散文", () => {
    for (const lang of LANGS) {
      const sec = quotaSection(lang, realDeploy(lang));
      expect(sec.length, `docs/${lang}/DEPLOY.md 的配额账只有 ${sec.length} 行 —— `
        + "定位器多半在下一个 `###` 上提前收尾了，本组会在一段空文本上全绿")
        .toBeGreaterThan(200);
      expect(textRuns(sec).length, `docs/${lang}/DEPLOY.md 的配额账一个 text-run 都没抽到`)
        .toBeGreaterThan(20);
    }
  });

  it("偏离名册（W94 的具名例外）：25 份非 README 文档里的 `<details>` 恰好就是名册那 5 处", () => {
    const withDetails = non25Pairs()
      .filter(([, t]) => detailsTags(t).open > 0)
      .map(([p]) => p)
      .sort();
    expect(
      withDetails,
      "非 README 文档的 `<details>` 与偏离名册对不上。\n"
      + "· 多出来 ⇒ 射程铁律（C23：这 25 份不用折叠块）被破，要么撤掉，要么先来改名册；\n"
      + "· 少掉 ⇒ W98 那处**具名例外**被人顺手删了，而 ADJ ㉑「不拆 QUOTA.md」的前提"
      + "就是「那一节可以就地折叠起来」——删掉它等于把那条裁定推翻，却一格都不红。",
    ).toEqual([...DETAILS_ALLOWLIST].sort());
  });

  it("名册里那 5 份各恰 1 组 `<details>`/`</details>`/`<summary>`，且折叠块落在配额账那一节里", () => {
    const bad: string[] = [];
    for (const lang of LANGS) {
      const src = realDeploy(lang);
      const { open, close, summary } = detailsTags(src);
      if (open !== 1 || close !== 1 || summary !== 1) {
        bad.push(`docs/${lang}/DEPLOY.md：<details> ${open} / </details> ${close} / <summary> ${summary}，各应恰 1`);
      }
      const sec = quotaSection(lang, src).join("\n");
      if (!sec.includes("<details>") || !sec.includes("</details>")) {
        bad.push(`docs/${lang}/DEPLOY.md 的折叠块不在 \`### 配额账\` 那一节里 —— `
          + "具名例外是给那一节的，挪到别处就是新开了一处偏离");
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it(`那一节的最长 text-run ≤ ${W98_MAX_RUN} 字符（W98 的验收）`, () => {
    const over: string[] = [];
    for (const lang of LANGS) {
      const sec = quotaSection(lang, realDeploy(lang));
      for (const r of textRuns(sec)) {
        const n = [...r.text].length;
        if (n > W98_MAX_RUN) {
          over.push(`docs/${lang}/DEPLOY.md 配额账第 ${r.at + 1} 行起：${n} 字符 > ${W98_MAX_RUN}`
            + `\n      ${r.text.slice(0, 70)}…`);
        }
      }
    }
    expect(
      over,
      `这几段读者中间一个视觉锚点都没有：\n${over.join("\n")}\n`
      + "⇒ 处置是 W98 那一条：拆成 `####` 小节、拆成子列表、或在句号处另起一段。"
      + "**不许靠删句子达标**。",
    ).toEqual([]);
  });

  it("那一节真的分了层：五份各 ≥5 个 `####`（只折叠不分层等于把问题藏起来）", () => {
    for (const lang of LANGS) {
      const sec = quotaSection(lang, realDeploy(lang));
      const h4 = sec.filter((l) => /^#### /.test(l)).length;
      expect(h4, `docs/${lang}/DEPLOY.md 的配额账只有 ${h4} 个 \`####\` —— `
        + "W98 要的是「折叠 + 分层」两件事，只做前一件等于把 283 行原样塞进一个折叠块")
        .toBeGreaterThanOrEqual(5);
    }
  });

  /* ── 反向控制 ───────────────────────────────────────────────────────────── */

  it("该红时红：把某一份的 `<details>` 标签删掉（正文一个字不动）⇒ 名册那格点名那一份", () => {
    const target = join("docs", "ja", "DEPLOY.md");
    const flattened = readFileSync(target, "utf8")
      .split("\n").filter((l) => !/^\s*<\/?(?:details|summary)/.test(l)).join("\n");
    expect(flattened, "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const withDetails = non25Pairs()
      .map(([p, t]) => (p === target ? [p, flattened] as const : [p, t] as const))
      .filter(([, t]) => detailsTags(t).open > 0).map(([p]) => p).sort();
    expect(withDetails, "折叠块被删掉了却没红 —— 具名例外就白登记了")
      .not.toEqual([...DETAILS_ALLOWLIST].sort());
    expect(withDetails).not.toContain(target);
  });

  it("该红时红：往 USAGE.md 里加一个折叠块 ⇒ 名册那格点名它（射程铁律的另一个方向）", () => {
    const target = join("docs", "ko", "USAGE.md");
    const docs = non25Pairs().map(([p, t]) => (p === target
      ? [p, `${t}\n<details>\n<summary><b>x</b></summary>\n\ny\n\n</details>\n`] as const
      : [p, t] as const));
    const withDetails = docs.filter(([, t]) => detailsTags(t).open > 0).map(([p]) => p).sort();
    expect(withDetails, "非 README 文档多长出一个折叠块却没红").toContain(target);
  });

  it("该红时红：把 en 那两段合回一段（`60 is over` 那处）⇒ 1500 那格点名 en", () => {
    // ⚠️ 变异用的是**仓里真实存在过的形状**：这两段今天之所以是两段，正是 W98 拆的。
    const src = readFileSync(docPath(".", "en", "DEPLOY"), "utf8")
      .split("**60 is over**.\n\n  So the `30d` range").join("**60 is over**.\n  So the `30d` range");
    expect(src, "变异没落地").not.toEqual(readFileSync(docPath(".", "en", "DEPLOY"), "utf8"));
    const over = textRuns(quotaSection("en", src)).filter((r) => [...r.text].length > W98_MAX_RUN);
    expect(over.length, "合回一段之后没有任何 run 超过 1500 —— 这一格没打中，回来换一处变异")
      .toBeGreaterThan(0);
  });

  it("认不出要吵：配额账的标题被改名时当场抛，不许静静地扫一段空文本", () => {
    expect(() => quotaSection("zh-CN", "# 部署指南\n\n### 别的标题\n\n正文。\n"))
      .toThrow(/判据的落点变了/);
  });

  it("不许乱红：围栏里教人写折叠块的示例不算数（剥围栏之后才数）", () => {
    const fenced = "# T\n\n```html\n<details>\n<summary>x</summary>\n</details>\n```\n";
    expect(detailsTags(fenced), "围栏里的 `<details>` 被数进来了 —— 剥围栏没生效")
      .toEqual({ open: 0, close: 0, summary: 0 });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * W99–W102 —— 五份 `DEPLOY.md` 的 15 节骨架落地之后的四条验收
 *
 * `##` 骨架本身由上面 W124 那一组的「已接线的那几格」用 `toEqual DOC_SECTIONS` 守着。
 * 本组守的是骨架**之下**那四件事，它们各自都能在骨架全对的前提下坏掉：
 *
 * · **W99 的对仗恒等式（§1.10 V54）**：`## Cloudflare Worker 部署` 与 `## Docker 部署`
 *   两节的 `###` 文本数组必须**互相 `toEqual`**（逐条同名同序）。规格把它写成
 *  「对仗是恒等式，不是风格」——两条部署路的步骤一旦错位，读者分不清哪一步属于哪条路。
 *   同批还查 `## 选哪种形态` 之下**恰 1 张 3 列表**（V53），且那一节**不预设主推**（V55）。
 * · **W100**：带注释的 ```env 围栏 ≥5 个/份，每个变量上方 1–3 行 `#` 注释、以
 *   `必填：`/`可选：`（各语言的对应写法）起头，变量之间空一行。
 * · **W101**：`## 常见问题` 的三段式——`### {症状短语}` + `**症状**：` + `**解决方案**：`
 *   + 有序列表，三者**成对**且五语言条数彼此相等。
 * · **W102**：`## 安全建议` 真的在，页脚节恰 4 条 bullet（模板固定形态）。
 *
 * ⚠️ **W101 为什么不写 `toBe(6)`**（这是规格 FL-6-X2 的主控裁定，不是本轮放宽）：
 * 「恰 6 条 × 5 语言」与 C9/ADJ ⑩「不许为凑数编造条目」同型而方向相反——一条判据
 * 要求编造，另一条禁止编造，同一份规格不能两头都要。⇒ 判据形态是
 * **形态恒等 + 五语言彼此相等 + 不回退下限**。今天五份各 **6** 条（与两个参照仓实测
 * 相同），下限因此钉在 6：**它挡得住「删掉两条凑合」，而挡不住「再加一条真问题」**，
 * 后者本来也不该被挡。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 一份 markdown 里某个 `##` 节的正文行（不含标题行），到下一个 `##` 或 EOF 为止。 */
function h2Section(src: string, heading: string): string[] {
  const lines = src.split("\n");
  const at = lines.indexOf(heading);
  if (at < 0) {
    throw new Error(`找不到 ${JSON.stringify(heading)} —— 判据的落点变了，先回来改常量，不许扫一段空文本`);
  }
  let to = at + 1;
  while (to < lines.length && !/^## /.test(lines[to] ?? "")) to += 1;
  return lines.slice(at + 1, to);
}

/** 一段正文里的 `###` 标题行（原样）。`####` 不算——V54 的对仗只到 `###` 这一层。 */
const h3sOf = (sectionLines: readonly string[]): string[] =>
  sectionLines.filter((l) => /^### /.test(l));

/**
 * 一份文档里所有 ```env 围栏的内容（不含定界行）。
 * **只认 ```env**：`.env` 片段用别的语言标注（```bash / ```ini）就抽不到，那正是要红的形态。
 */
function envFences(src: string): string[][] {
  const out: string[][] = [];
  let cur: string[] | null = null;
  for (const line of src.split("\n")) {
    if (cur === null) {
      if (/^\s*```env\s*$/.test(line)) cur = [];
      continue;
    }
    if (/^\s*```\s*$/.test(line)) { out.push(cur); cur = null; continue; }
    cur.push(line);
  }
  return out;
}

/** 各语言 ```env 注释的两种起头。**必须逐语言给，`必填：` 在 en 上一次都命中不了**。 */
const ENV_COMMENT_PREFIXES: Record<Lang, readonly [required: string, optional: string]> = {
  "zh-CN": ["# 必填：", "# 可选："],
  "zh-TW": ["# 必填：", "# 選填："],
  en: ["# Required: ", "# Optional: "],
  ja: ["# 必須: ", "# 任意: "],
  ko: ["# 필수: ", "# 선택: "],
};

/** 常见问题那一节的两个双粗体标签，逐语言。 */
const FAQ_LABELS: Record<Lang, readonly [symptom: string, fix: string]> = {
  "zh-CN": ["**症状**：", "**解决方案**："],
  "zh-TW": ["**症狀**：", "**解決方案**："],
  en: ["**Symptom**: ", "**Fix**:"],
  ja: ["**症状**：", "**対処**："],
  ko: ["**증상**: ", "**해결**:"],
};

/** 一份 `env` 围栏里的「注释块 + 变量行」结构体检。返回失败报文。 */
function envFenceFailures(lang: Lang, where: string, body: readonly string[]): string[] {
  const out: string[] = [];
  const [req, opt] = ENV_COMMENT_PREFIXES[lang];
  const decls = body.flatMap((l, i) => (/^[A-Z][A-Z0-9_]*=/.test(l) ? [i] : []));
  if (decls.length === 0) {
    out.push(`${where}：这个 \`\`\`env 围栏里一行变量声明都没有 —— 空围栏凑不出 W100 的数`);
    return out;
  }
  for (const at of decls) {
    // 紧邻上方连续的 `#` 注释行
    let from = at;
    while (from - 1 >= 0 && (body[from - 1] ?? "").startsWith("#")) from -= 1;
    const comment = body.slice(from, at);
    const name = (body[at] ?? "").split("=")[0];
    if (comment.length < 1 || comment.length > 3) {
      out.push(`${where} 的 \`${name}\` 上方有 ${comment.length} 行 \`#\` 注释，要求 1–3 行`);
      continue;
    }
    const head = comment[0] ?? "";
    if (!head.startsWith(req) && !head.startsWith(opt)) {
      out.push(`${where} 的 \`${name}\` 那段注释没有以 ${JSON.stringify(req)} 或 ${JSON.stringify(opt)} 起头：`
        + `${JSON.stringify(head.slice(0, 40))}`);
    }
    // 变量之间要空一行：注释块之前那一行必须是空行（除非它就是围栏开头）
    if (from > 0 && (body[from - 1] ?? "").trim() !== "") {
      out.push(`${where} 的 \`${name}\` 与上一个变量之间没有空行 —— 挤成一坨就不是「带注释的围栏」了`);
    }
  }
  return out;
}

describe("W99–W102 五份 DEPLOY.md 的 15 节骨架之下的四条验收", () => {
  const deploy = (lang: Lang): string => readFileSync(docPath(".", lang, "DEPLOY"), "utf8");
  /** 两条部署路与三个专题节在 `DOC_SECTIONS` 里的槽位（0 基）。 */
  const SLOT = { choose: 2, worker: 3, docker: 4, faq: 8, security: 13, footer: 14 } as const;
  const headingAt = (lang: Lang, slot: number): string => DOC_SECTIONS.DEPLOY[lang][slot]!;

  /* ── W99 / §1.10 ────────────────────────────────────────────────────────── */

  it("W99 §1.10 的对仗恒等式：两条部署路的 `###` 数组互相 `toEqual`（逐条同名同序）", () => {
    for (const lang of LANGS) {
      const src = deploy(lang);
      const wk = h3sOf(h2Section(src, headingAt(lang, SLOT.worker)));
      const dk = h3sOf(h2Section(src, headingAt(lang, SLOT.docker)));
      expect(wk.length, `docs/${lang}/DEPLOY.md 的 Worker 那一节一个 \`###\` 都没有 —— 定位器坏了`)
        .toBeGreaterThan(0);
      expect(
        dk,
        `docs/${lang}/DEPLOY.md 两条部署路的 \`###\` 对不上（§1.10 V54：对仗是恒等式，不是风格）：\n`
        + `  Worker: ${JSON.stringify(wk)}\n  Docker: ${JSON.stringify(dk)}\n`
        + "⇒ 两条路的步骤一旦错位，读者分不清哪一步属于哪条路。要改就两边一起改。",
      ).toEqual(wk);
    }
  });

  it("W99 §1.10 V53：`## 选哪种形态` 之下恰 1 张表，且那张表恰 3 列", () => {
    for (const lang of LANGS) {
      const sec = h2Section(deploy(lang), headingAt(lang, SLOT.choose));
      const seps = sec.filter((l) => SEPARATOR_ROW.test(l));
      expect(seps.length, `docs/${lang}/DEPLOY.md 的「选哪种形态」有 ${seps.length} 张表，V53 要的是恰 1 张`)
        .toBe(1);
      expect(rowCells(seps[0]!.trim()).length,
        `docs/${lang}/DEPLOY.md 的那张对比表不是 3 列 —— V53 要的是「维度 / Worker / Docker」三列`)
        .toBe(3);
    }
  });

  /* ── W100 ───────────────────────────────────────────────────────────────── */

  it("W100 每份 DEPLOY.md 至少 5 个 ```env 围栏（落地前是 0）", () => {
    const counts = Object.fromEntries(LANGS.map((l) => [l, envFences(deploy(l)).length]));
    const short = LANGS.filter((l) => envFences(deploy(l)).length < 5);
    expect(short, `这些语言的 \`\`\`env 围栏少于 5 个：${JSON.stringify(counts)}`).toEqual([]);
  });

  it("W100 每个 ```env 围栏都是「带注释的」：变量上方 1–3 行 `#`、以必填/可选起头、变量之间空行", () => {
    const failures: string[] = [];
    for (const lang of LANGS) {
      envFences(deploy(lang)).forEach((body, i) => {
        failures.push(...envFenceFailures(lang, `docs/${lang}/DEPLOY.md 第 ${i + 1} 个 \`\`\`env`, body));
      });
    }
    expect(
      failures,
      `${failures.join("\n")}\n⇒ W100 要的不是「有个围栏」，是「照着抄就能用」：`
      + "每个变量上方 1–3 行注释、说清必填还是可选，变量之间空一行。",
    ).toEqual([]);
  });

  it("W100 该红时红：把某个变量上方的注释整段删掉 ⇒ 点名那个变量", () => {
    const body = ["# 必填：客户端令牌。", "GATEWAY_TOKEN=x", "", "PORT=8080"];
    const failures = envFenceFailures("zh-CN", "夹具", body);
    expect(failures.join("\n"), "没注释的那个变量没被点名").toContain("`PORT`");
  });

  it("W100 该红时红：注释在（1–3 行）但没写清必填还是可选 ⇒ 同样点名", () => {
    const body = ["# 这是一个端口。", "PORT=8080"];
    const failures = envFenceFailures("zh-CN", "夹具", body);
    expect(failures.join("\n")).toContain("没有以");
    expect(failures.join("\n")).toContain("`PORT`");
  });

  it("W100 不许乱红：合规的围栏一条都不报", () => {
    const body = [
      "# 必填：客户端调用本网关时必须携带的令牌。",
      "GATEWAY_TOKEN=x",
      "",
      "# 可选：Node 运行时的监听端口。",
      "# Worker 不使用该变量。",
      "PORT=8080",
    ];
    expect(envFenceFailures("zh-CN", "夹具", body)).toEqual([]);
  });

  /* ── W101 ───────────────────────────────────────────────────────────────── */

  it("W101 常见问题的三段式：`###` 条数 == `**症状**` 条数 == `**解决方案**` 条数，五语言彼此相等", () => {
    const shapes: Record<string, string> = {};
    for (const lang of LANGS) {
      const sec = h2Section(deploy(lang), headingAt(lang, SLOT.faq));
      const [sym, fix] = FAQ_LABELS[lang];
      const h3 = h3sOf(sec).length;
      const nSym = sec.filter((l) => l.startsWith(sym)).length;
      const nFix = sec.filter((l) => l.startsWith(fix)).length;
      // 有序列表：每条 FAQ 的解决方案至少一行 `1. `
      const nOl = sec.filter((l) => /^1\. /.test(l)).length;
      expect([h3, nSym, nFix, nOl],
        `docs/${lang}/DEPLOY.md 的常见问题三段式不成对：\`###\`=${h3} / ${sym}=${nSym} / ${fix}=${nFix} / 有序列表=${nOl}`)
        .toEqual([h3, h3, h3, h3]);
      shapes[lang] = String(h3);
    }
    const first = shapes[LANGS[0]];
    expect(shapes, `五语言的常见问题条数不一致：${JSON.stringify(shapes)} —— 某一份漏翻了一条`)
      .toEqual(Object.fromEntries(LANGS.map((l) => [l, first])));
  });

  it("W101 不回退下限：常见问题今天五份各 6 条（与两个参照仓实测相同），不许掉下去", () => {
    // ⚠️ **不是 `toBe(6)`**，理由见本组文件头（规格 FL-6-X2 的主控裁定）：
    // 钉死具体值会与「不许为凑数编造条目」互斥。下限挡得住「删掉两条凑合」，
    // 挡不住「再加一条真问题」——后者本来也不该被挡。
    for (const lang of LANGS) {
      const n = h3sOf(h2Section(deploy(lang), headingAt(lang, SLOT.faq))).length;
      expect(n, `docs/${lang}/DEPLOY.md 的常见问题只剩 ${n} 条`).toBeGreaterThanOrEqual(6);
    }
  });

  /* ── W102 ───────────────────────────────────────────────────────────────── */

  it("W102 `## 安全建议` 真的在，而且不是一个空壳（≥4 条顶格 bullet）", () => {
    for (const lang of LANGS) {
      const sec = h2Section(deploy(lang), headingAt(lang, SLOT.security));
      const bullets = sec.filter((l) => /^- /.test(l)).length;
      expect(bullets, `docs/${lang}/DEPLOY.md 的安全建议只有 ${bullets} 条 bullet`).toBeGreaterThanOrEqual(4);
    }
  });

  it("W102 页脚节恰 4 条 bullet（模板固定形态），且末节标题就是译名表同一下标的那一个（R26e'）", () => {
    for (const lang of LANGS) {
      const heading = headingAt(lang, SLOT.footer);
      const sec = h2Section(deploy(lang), heading);
      const bullets = sec.filter((l) => /^- /.test(l));
      expect(bullets.length, `docs/${lang}/DEPLOY.md 的页脚节有 ${bullets.length} 条 bullet，模板固定是 4 条`)
        .toBe(4);
      // R26e'：末节标题 == 译名表同一下标 —— 与 API.md 那一族用的是同一个下标（ADJ ㊷）。
      expect(heading, `${lang} 的 DEPLOY 末节与 API 末节不是同一族译名`)
        .toBe(DOC_SECTIONS.API[lang][DOC_SECTIONS.API[lang].length - 1]);
    }
  });

  it("认不出要吵：`##` 标题被改名时 `h2Section` 当场抛，不许扫一段空文本", () => {
    expect(() => h2Section("# T\n\n## 别的\n\n正文\n", "## 安全建议")).toThrow(/判据的落点变了/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * W104 / W105 / W106 / W107 —— 五份 `API.md` 的 13 节骨架**之下**的四条验收
 *
 * `##` 骨架那一层由 W124 那组的「已接线的那几格：`##` 序列逐字 `toEqual` DOC_SECTIONS」
 * 守着（P3f 阶段 7B 之四把 API 五格从「允许对不上」的名册搬了过去）。**本组守的是它下面**：
 *
 * · **W104**：端点从 `##` 降为协议族 `##` 之下的 `###`（模板实测：kiro / gemini 两仓的
 *   端点全写成 `### METHOD /path`，不带反引号）；`## 认证` 之下补 `### 方式 N`；
 *   `## 错误响应` 之下补一张状态码**升序**总表 `### 常见错误码`。
 * · **W105**：每个端点块的固定五件套 —— 功能说明 → `**请求体**：`+参数表 →
 *   `**请求**：`+```bash → `**响应**：`+```json/```text → 可选 alert。
 *   验收是「`**请求**` 与 `**响应**` 各 ≥10 条/份」（两个参照仓实测 42/28 与 48/18）。
 * · **W106**：参数表表头逐字固定，**必填列写「是/否」不写 `✅`/`❌`**（C26）。
 *   ⚠️ 这与 README 的配置表刻意**不同**：那一张用 `✅`/`❌`，两处不是同一条规矩。
 * · **W107**：`## 请求示例` 之下恰三个 `###`，cURL 块内两条注释逐条在。
 *
 * ⚠️ **为什么不写死 `###` 的条数**：那个数每加一条端点就过期一次（管理接口今天 24 条，
 * 源码里再注册一条它就变）。本组钉的是**五语言彼此相等 + 不回退下限**，与 W101 同一形态。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 五份 `API.md` 的正文，读一次给全组用。 */
const apiSrc = (lang: Lang): string => readFileSync(join("docs", lang, "API.md"), "utf8");

/** 一段正文行里 `### ` 标题的**文本**（去掉 `### ` 前缀）。 */
const h3TextsOf = (sectionLines: readonly string[]): string[] =>
  sectionLines.filter((l) => /^### /.test(l)).map((l) => l.slice(4).trim());

/** 逐语言的双粗体标签（W105 的五件套）。**必须逐语言给**：`**请求**：` 在 en 上一次都命中不了。 */
const API_LABELS: Record<Lang, { readonly req: string; readonly res: string; readonly body: string }> = {
  "zh-CN": { req: "**请求**：", res: "**响应**：", body: "**请求体**：" },
  "zh-TW": { req: "**請求**：", res: "**回應**：", body: "**請求體**：" },
  en: { req: "**Request**:", res: "**Response**:", body: "**Request body**:" },
  ja: { req: "**リクエスト**：", res: "**レスポンス**：", body: "**リクエストボディ**：" },
  ko: { req: "**요청**:", res: "**응답**:", body: "**요청 본문**:" },
};

/** W106 的参数表表头，逐字固定。 */
const PARAM_TABLE_HEADER: Record<Lang, string> = {
  "zh-CN": "| 参数 | 类型 | 必填 | 说明 |",
  "zh-TW": "| 參數 | 型別 | 必填 | 說明 |",
  en: "| Parameter | Type | Required | Description |",
  ja: "| パラメータ | 型 | 必須 | 説明 |",
  ko: "| 파라미터 | 타입 | 필수 | 설명 |",
};

/** 必填列只许是这两个词之一（C26：**不用 `✅`/`❌`**）。 */
const REQUIRED_WORDS: Record<Lang, readonly [yes: string, no: string]> = {
  "zh-CN": ["是", "否"],
  "zh-TW": ["是", "否"],
  en: ["Yes", "No"],
  ja: ["はい", "いいえ"],
  ko: ["예", "아니오"],
};

/** `## 认证` 之下那几条 `### 方式 N` 的前缀。 */
const AUTH_METHOD_PREFIX: Record<Lang, string> = {
  "zh-CN": "方式 ", "zh-TW": "方式 ", en: "Method ", ja: "方式 ", ko: "방식 ",
};

/** `## 错误响应` 之下那张状态码总表的标题（V18）。 */
const ERROR_CODE_H3: Record<Lang, string> = {
  "zh-CN": "常见错误码",
  "zh-TW": "常見錯誤碼",
  en: "Common status codes",
  ja: "よくあるエラーコード",
  ko: "자주 나오는 오류 코드",
};

/** `## 请求示例` 之下那三个 `###`，**五语言逐字相同**（模板实测就是英文原样）。 */
const EXAMPLE_H3S = ["Python - OpenAI SDK", "JavaScript - Node.js", "cURL"] as const;

/** cURL 块内那两条注释，逐语言。 */
const CURL_COMMENTS: Record<Lang, readonly [nonStream: string, stream: string]> = {
  "zh-CN": ["# 非流式请求", "# 流式请求"],
  "zh-TW": ["# 非流式請求", "# 流式請求"],
  en: ["# Non-streaming request", "# Streaming request"],
  ja: ["# 非ストリーミングリクエスト", "# ストリーミングリクエスト"],
  ko: ["# 비스트리밍 요청", "# 스트리밍 요청"],
};

/** 端点标题的形状：`METHOD /path`。五种方法都收。 */
const ENDPOINT_TITLE = /^(GET|POST|PUT|PATCH|DELETE) \//;

/** 剥围栏后，命中给定正则的标题行（原样，含 `#` 前缀）。 */
const headingLinesOf = (src: string): string[] =>
  outsideFences(src).split("\n").filter((l) => /^#{1,6} /.test(l));

/** 一张 markdown 表的数据行（从表头行下标出发，跳过分隔行，到第一条非 `|` 行为止）。 */
function tableDataRows(lines: readonly string[], headerIdx: number): string[] {
  const out: string[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (!l.trimStart().startsWith("|")) break;
    out.push(l);
  }
  return out;
}

describe("W104–W107 五份 API.md 的 13 节骨架之下的四条验收", () => {
  it("射程自守：五份都读得到、各 13 个 `##`，`###` 数五份彼此相等且不回退（今天 49）", () => {
    for (const lang of LANGS) {
      const heads = headingLinesOf(apiSrc(lang));
      expect(heads.filter((l) => /^## /.test(l)).length, `docs/${lang}/API.md 的 \`##\` 数`).toBe(13);
    }
    const h3Counts = LANGS.map((lang) => headingLinesOf(apiSrc(lang)).filter((l) => /^### /.test(l)).length);
    expect(new Set(h3Counts).size, `五份的 \`###\` 数不一致：${JSON.stringify(h3Counts)} —— `
      + "R2 已经钉死层级序列，条数就该一样；这一格是给报文用的（R2 只说「第 N 个下标对不上」）")
      .toBe(1);
    // **不回退下限**（与 W101 同一形态，刻意不写 `toBe(49)`）：这个数每加一条端点就变，
    // 写死等于每次加端点都要回来改一个与判据无关的数。
    expect(h3Counts[0], "`###` 数掉到 40 以下 —— 端点块被整片删掉了？").toBeGreaterThanOrEqual(40);
  });

  it("W104 端点全部降为 `###`：`## METHOD /path` 恒为 0，而 `### METHOD /path` 五份相等且 ≥ 30", () => {
    const bad: string[] = [];
    const counts: number[] = [];
    for (const lang of LANGS) {
      const heads = headingLinesOf(apiSrc(lang));
      for (const h of heads) {
        if (/^## /.test(h) && ENDPOINT_TITLE.test(h.slice(3).trim())) bad.push(`docs/${lang}/API.md：${h}`);
      }
      counts.push(heads.filter((h) => /^### /.test(h) && ENDPOINT_TITLE.test(h.slice(4).trim())).length);
    }
    expect(
      bad,
      `这些端点还挂在 \`##\` 上：\n${bad.join("\n")}\n`
      + "⇒ W104 的落法是「七个协议族占 `##`，端点降为它们之下的 `###`」。"
      + "⚠️ 提回 `##` 的同时「已接线的那几格：`##` 序列逐字 `toEqual` DOC_SECTIONS」也会红 —— "
      + "两格说的是同一件事的两面：那一格说「多了一节」，本格说「多的那一节是个端点」。",
    ).toEqual([]);
    expect(new Set(counts).size, `五份的端点 \`###\` 数不一致：${JSON.stringify(counts)}`).toBe(1);
    expect(counts[0], "端点 `###` 少于 30 条 —— 管理接口那一节今天就有 24 条").toBeGreaterThanOrEqual(30);
  });

  it("W104 `## 认证` 之下恰 4 条 `### 方式 N`，编号 1..4 严格递增（五语言同构）", () => {
    for (const lang of LANGS) {
      const sec = h2Section(apiSrc(lang), DOC_SECTIONS.API[lang][0]);
      const nums = h3TextsOf(sec)
        .filter((t) => t.startsWith(AUTH_METHOD_PREFIX[lang]))
        .map((t) => Number.parseInt(t.slice(AUTH_METHOD_PREFIX[lang].length), 10));
      expect(nums, `docs/${lang}/API.md 的 \`## 认证\` 之下的方式编号`).toEqual([1, 2, 3, 4]);
    }
  });

  it("W104 `## 错误响应` 之下有状态码总表，且状态码列**严格升序**（V18）", () => {
    for (const lang of LANGS) {
      const src = apiSrc(lang);
      const sec = h2Section(src, DOC_SECTIONS.API[lang][2]);
      expect(h3TextsOf(sec), `docs/${lang}/API.md 的错误响应节里没有「${ERROR_CODE_H3[lang]}」这一节`)
        .toContain(ERROR_CODE_H3[lang]);
      const at = sec.indexOf(`### ${ERROR_CODE_H3[lang]}`);
      const headerIdx = sec.findIndex((l, i) => i > at && l.trimStart().startsWith("|"));
      expect(headerIdx, `docs/${lang}/API.md 的「${ERROR_CODE_H3[lang]}」之下一张表都没有`).toBeGreaterThan(at);
      const codes = tableDataRows(sec, headerIdx)
        .map((r) => /^\|\s*`(\d{3})`\s*\|/.exec(r.trim())?.[1])
        .map((c) => (c === undefined ? Number.NaN : Number(c)));
      expect(codes.length, `docs/${lang}/API.md 的状态码总表一行数据都没有`).toBeGreaterThanOrEqual(6);
      expect(codes.filter((c) => Number.isNaN(c)), `docs/${lang}/API.md 的状态码总表里有一行第一格不是 \`NNN\``)
        .toEqual([]);
      const sorted = [...codes].sort((a, b) => a - b);
      expect(codes, `docs/${lang}/API.md 的状态码不是升序：${JSON.stringify(codes)}`).toEqual(sorted);
      expect(new Set(codes).size, "状态码总表里有重复的码").toBe(codes.length);
    }
  });

  it("W105 `**请求**` 与 `**响应**` 各 ≥10 条/份，且五语言条数彼此相等", () => {
    const req: number[] = [], res: number[] = [];
    for (const lang of LANGS) {
      const lines = apiSrc(lang).split("\n");
      req.push(lines.filter((l) => l.trim() === API_LABELS[lang].req).length);
      res.push(lines.filter((l) => l.trim() === API_LABELS[lang].res).length);
    }
    expect(Math.min(...req), `\`**请求**\` 条数：${JSON.stringify(req)}（两个参照仓 42 / 48）`)
      .toBeGreaterThanOrEqual(10);
    expect(Math.min(...res), `\`**响应**\` 条数：${JSON.stringify(res)}（两个参照仓 28 / 18）`)
      .toBeGreaterThanOrEqual(10);
    expect(new Set(req).size, `五份的 \`**请求**\` 条数不一致：${JSON.stringify(req)}`).toBe(1);
    expect(new Set(res).size, `五份的 \`**响应**\` 条数不一致：${JSON.stringify(res)}`).toBe(1);
  });

  it("W105 五件套的次序：每个 `**请求**` 之后紧跟 ```bash，每个 `**响应**` 之后紧跟 ```json / ```text", () => {
    const bad: string[] = [];
    for (const lang of LANGS) {
      const lines = apiSrc(lang).split("\n");
      lines.forEach((l, i) => {
        const t = l.trim();
        const after = (lines[i + 2] ?? "").trim();
        if (t === API_LABELS[lang].req && after !== "```bash") {
          bad.push(`docs/${lang}/API.md:${i + 1} \`**请求**\` 之后不是 \`\`\`bash，而是 ${JSON.stringify(after)}`);
        }
        if (t === API_LABELS[lang].res && after !== "```json" && after !== "```text") {
          bad.push(`docs/${lang}/API.md:${i + 1} \`**响应**\` 之后不是 \`\`\`json / \`\`\`text，而是 ${JSON.stringify(after)}`);
        }
      });
    }
    expect(bad, `五件套的次序被打乱了：\n${bad.join("\n")}\n`
      + "⇒ 固定次序是：功能说明 → `**请求体**：`+参数表 → `**请求**：`+```bash → `**响应**：`+```json").toEqual([]);
  });

  it("W106 参数表：表头逐字固定，必填列只许是本语言的「是/否」", () => {
    const bad: string[] = [];
    for (const lang of LANGS) {
      const lines = apiSrc(lang).split("\n");
      const [yes, no] = REQUIRED_WORDS[lang];
      let tables = 0;
      lines.forEach((l, i) => {
        if (l.trim() !== API_LABELS[lang].body) return;
        // `**请求体**：` 之后**未必**有表（几条端点写的是「本端点只收查询参数」那一句），
        // 只有真的跟着一张表时才校验它。
        const headerIdx = lines.findIndex((x, j) => j > i && j <= i + 3 && x.trimStart().startsWith("|"));
        if (headerIdx < 0) return;
        tables += 1;
        if (lines[headerIdx] !== PARAM_TABLE_HEADER[lang]) {
          bad.push(`docs/${lang}/API.md:${headerIdx + 1} 参数表表头不是 ${JSON.stringify(PARAM_TABLE_HEADER[lang])}`
            + `，而是 ${JSON.stringify(lines[headerIdx])}`);
          return;
        }
        for (const row of tableDataRows(lines, headerIdx)) {
          const cell = rowCells(row)[2] ?? "";
          if (cell !== yes && cell !== no) {
            bad.push(`docs/${lang}/API.md 的参数表里必填列写的是 ${JSON.stringify(cell)}`
              + `——只许是「${yes}」或「${no}」（C26：README 的配置表才用 ✅/❌，这里不用）`);
          }
        }
      });
      expect(tables, `docs/${lang}/API.md 里一张参数表都没扫到 —— 本格在测空气`).toBeGreaterThanOrEqual(10);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("W106 五份 API.md 的正文里 `✅` / `❌` 恒为 0（C26：那是 README 配置表的写法）", () => {
    const hits = bodyHits(LANGS.map((lang) => [join("docs", lang, "API.md"), apiSrc(lang)] as const), /[✅❌]/u);
    expect(hits, `API.md 里出现了 ✅/❌：\n${hits.join("\n")}\n`
      + "⇒ 必填列写「是/否」。两处不同：README 的配置表用 ✅/❌，API 的参数表不用。").toEqual([]);
  });

  it("W107 `## 请求示例` 之下恰三个 `###`，逐字且同序", () => {
    for (const lang of LANGS) {
      const sec = h2Section(apiSrc(lang), DOC_SECTIONS.API[lang][11]);
      expect(h3TextsOf(sec), `docs/${lang}/API.md 的请求示例节的三个 \`###\``).toEqual([...EXAMPLE_H3S]);
    }
  });

  it("W107 cURL 块内两条注释逐条在（非流式 / 流式），且五语言各恰 1 组", () => {
    const bad: string[] = [];
    for (const lang of LANGS) {
      const sec = h2Section(apiSrc(lang), DOC_SECTIONS.API[lang][11]).join("\n");
      const at = sec.indexOf("### cURL");
      expect(at, `docs/${lang}/API.md 的请求示例节里没有 \`### cURL\``).toBeGreaterThanOrEqual(0);
      const curl = sec.slice(at);
      for (const c of CURL_COMMENTS[lang]) {
        const n = curl.split(`\n${c}\n`).length - 1;
        if (n !== 1) bad.push(`docs/${lang}/API.md 的 cURL 块里「${c}」出现了 ${n} 次（要恰 1 次）`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  /* ── 反向控制：该红时红 / 不许乱红 ───────────────────────────────────────── */

  it("该红时红：把 `docs/ja/API.md` 的一个端点从 `###` 提回 `##` ⇒ 端点降级那一格红并点名", () => {
    const mutated = apiSrc("ja").replace("\n### GET /health\n", "\n## GET /health\n");
    expect(mutated, "变异没落地 —— 这一格控制是空的").not.toEqual(apiSrc("ja"));
    const heads = headingLinesOf(mutated).filter((h) => /^## /.test(h) && ENDPOINT_TITLE.test(h.slice(3).trim()));
    expect(heads, "端点被提回 `##` 却没被抓到").toEqual(["## GET /health"]);
  });

  it("该红时红：把 `docs/ko/API.md` 的 `### 방식 4` 删掉 ⇒ 方式编号那一格报的是 `[1,2,3]`", () => {
    const mutated = apiSrc("ko").replace("### 방식 4: key 쿼리 파라미터", "### key 쿼리 파라미터");
    expect(mutated, "变异没落地").not.toEqual(apiSrc("ko"));
    const sec = h2Section(mutated, DOC_SECTIONS.API.ko[0]);
    const nums = h3TextsOf(sec)
      .filter((t) => t.startsWith(AUTH_METHOD_PREFIX.ko))
      .map((t) => Number.parseInt(t.slice(AUTH_METHOD_PREFIX.ko.length), 10));
    expect(nums, "少了一条方式却没被抓到").toEqual([1, 2, 3]);
  });

  it("该红时红：把 `docs/en/API.md` 参数表的一个 `No` 换成 `❌` ⇒ 必填列与 emoji 两格同时红", () => {
    const target = join("docs", "en", "API.md");
    const mutated = apiSrc("en").replace("| `stream` | boolean | No |", "| `stream` | boolean | ❌ |");
    expect(mutated, "变异没落地").not.toEqual(apiSrc("en"));
    // ① emoji 那一格
    expect(bodyHits([[target, mutated] as const], /[✅❌]/u).join("\n"), "❌ 进来了却没红").toContain(`${target}:`);
    // ② 必填列那一格：把同一份文本喂进去，必填列必须报出那个 `❌`
    const lines = mutated.split("\n");
    const cells = lines
      .filter((l) => l.startsWith("| `stream` | boolean |"))
      .map((l) => rowCells(l)[2] ?? "");
    expect(cells, "必填列的取值没被改动 —— 这一格控制是空的").toContain("❌");
  });

  it("该红时红：`docs/zh-CN/API.md` 的状态码总表被打乱顺序 ⇒ 升序那一格红", () => {
    const src = apiSrc("zh-CN");
    const sec = h2Section(src, DOC_SECTIONS.API["zh-CN"][2]);
    const at = sec.indexOf(`### ${ERROR_CODE_H3["zh-CN"]}`);
    const headerIdx = sec.findIndex((l, i) => i > at && l.trimStart().startsWith("|"));
    const rows = tableDataRows(sec, headerIdx);
    expect(rows.length, "真表没抽到 —— 这一格控制是空的").toBeGreaterThanOrEqual(6);
    const swapped = [...rows];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    const codes = swapped.map((r) => Number(/^\|\s*`(\d{3})`\s*\|/.exec(r.trim())?.[1] ?? "0"));
    expect(codes, "换了顺序却还是升序 —— 这一格控制是空的").not.toEqual([...codes].sort((a, b) => a - b));
  });

  it("不许乱红：围栏里写着 `## GET /x` 的示例不算标题", () => {
    const withFence = `${apiSrc("zh-CN")}\n\`\`\`markdown\n## GET /x\n\`\`\`\n`;
    const heads = headingLinesOf(withFence).filter((h) => /^## /.test(h) && ENDPOINT_TITLE.test(h.slice(3).trim()));
    expect(heads, "围栏里的示例被当成了真标题 —— 剥围栏那一步没生效").toEqual([]);
  });

  it("认不出要吵：参数表表头常量与真文档对不上时，报的是「表头不是…」而不是「必填列写错了」", () => {
    const broken: Record<Lang, string> = { ...PARAM_TABLE_HEADER, "zh-CN": "| 参数 | 类型 | 是否必填 | 说明 |" };
    const lines = apiSrc("zh-CN").split("\n");
    const i = lines.indexOf(API_LABELS["zh-CN"].body);
    const headerIdx = lines.findIndex((x, j) => j > i && j <= i + 3 && x.trimStart().startsWith("|"));
    expect(headerIdx, "真文档里第一处 `**请求体**：` 之后没有表 —— 这一格控制是空的").toBeGreaterThan(i);
    expect(lines[headerIdx], "表头与常量对不上时本格才有意义").not.toBe(broken["zh-CN"]);
  });
});
