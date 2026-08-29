import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
// 抠注释走 `scripts/lib/strip-comments.mjs` 那一份真源（P3e Task 1 收编），不在这里手写第二份。
import { blankComments } from "../helpers/strip-comments.js";
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
import { MANUAL_GUARD_KEY } from "../../src/core/admin/tend-guard.js";
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
    { token: "**120", why: "POOL_CACHE_TTL_MS 的真实上界（60s TTL + 60s 边缘缓存），加粗标记只在这句出现" },
    // ⚠️ **这个锚点是 P3e Task 30 复评回填（F7）补的，照本组的规矩「数过再加」**：
    // 加之前 `**90` 在五份里**各 1 次**（就是配置生效上界那一句，五份都用加粗包住数字），
    // 完全一致 ⇒ 是个能指得出是哪一句的锚点，不是 `48` 那种散落 7~9 次的噪声锚点。
    // 补它的直接理由是实测：把 `docs/zh-CN/DEPLOY.md` 那句 `**90 秒**` 改成 `**95 秒**`，
    // **docs-parity 251 格全绿** —— 这个数在五份文档里当时一点守卫都没有。
    // ⚠️ **它挡不住的那一种照旧**：`CONFIG_TTL_MS`/`KV_EDGE_CACHE_MS` 真改了值、
    // 五份 DEPLOY.md 一起没跟上 ⇒ 计数依然对等 ⇒ 依然绿（跨语言互校的固有边界）。
    // 设计文档 §5.3 与「重置到底重置了什么」那一节的同一批数**是**从常量现算的，
    // 由本文件末尾那一组的两格钉着；五份 DEPLOY.md 不是。
    { token: "**90", why: "配置保存后其他 isolate 的生效上界（CONFIG_TTL_MS 30s + KV_EDGE_CACHE_MS 60s），五份各只此一处" },
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
 * 一级标题。实测今天五份 `DEPLOY.md` 各有 **3 个**这样的假标题，而且报文会亲手把人引进坑
 *（往 ja 的 bash 块里加一行 `# …` ⇒ 报文说「ja 多出一个一级标题、下标 13」，可 ja 里
 * 根本没有那个标题）。**报文是唯一会被看见的护栏**，指错地方比不报还贵。
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
const DOCS = ["ADMIN", "API", "DEPLOY", "README", "REGISTRAR", "USAGE"] as const;

/**
 * `docs/` 下**不按语言分**的目录。名册之外的子目录一律必须是 `LANGS` 里的一种。
 *
 * ⚠️⚠️ **补漏评审 H3：语言轴本身原来是一张不会自己红的手写表。** `LANGS` 五项手写，
 * 全仓没有任何一处拿 `readdirSync("docs")` 钉住它——实测在 `docs/` 下新建第六种语言的
 * 目录（`fr/`）并放一份 `DEPLOY.md` 进去，整组 285 格**全绿**，没有一格知道多了一种语言。本组的立项理由逐字是「一个不会自己红的
 * 清单不是守卫，是待办」，文档轴做到了、语言轴原样留着，这一轮补上。
 * ⚠️ **豁免名册会变成永久的洞**，所以下面那条 R1 语言轴的断言**两个方向都查**：名册里
 * 的目录今天必须真的在（`design` 哪天改名/搬走，这条登记会当场红，而不是静静地放行）。
 */
const NON_LANG_DOC_DIRS = ["design"] as const;

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
 * **2 格结构上不可能变红**，而文件里原本一个字都没说这件事。实测把 `fences` 改成恒返回
 * `[]`：真仓 6 格 R3 **全绿**，只有夹具那一条控制吵——**判据用错工具时静静放行**，正是
 * 本组自己在变异 M1 里登记过的那个形态，只是这一次真数据已经站在上面了。
 *
 * ⚠️ 名册**两个方向都查**，这是它与「待办清单」的区别：
 * · 不在名册里却五份全空 ⇒ 红（这一格是空判据，要么改判据要么登记进来）；
 * · 在名册里却抽到了东西 ⇒ 红（名册过期了，删掉登记——**豁免名册会变成永久的洞**）。
 */
const EMPTY_BY_DESIGN: ReadonlyArray<readonly [rule: string, doc: string]> = [
  // 这两份文档整份没有代码围栏（不是"缩进围栏认不出"——`fences` 今天顶格与缩进一视同仁）。
  ["R3 代码围栏语言标记序列", "ADMIN"],
  ["R3 代码围栏语言标记序列", "REGISTRAR"],
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

  it("R6 扩展：根 README.md 与五语言 README.md 的标识符 code span 多重集六份相同", () => {
    // 同一道平凡相等护栏：根 README 一个标识符都抽不到的话，这一格也是空判据。
    expect(idents(readFileSync("README.md", "utf8")).length, "根 README.md 里一个标识符 code span 都没抽到——这一格是平凡相等")
      .toBeGreaterThan(0);
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
    // ⚠️ 补漏评审 H3：夹具树必须带上非语言目录，否则 R1 语言轴那条（`docs/` 子目录集合
    // 恰好等于 LANGS + 豁免名册）在这棵树上恒红，整组反向控制全部失效。
    for (const d of NON_LANG_DOC_DIRS) files[`docs/${d}/placeholder.md`] = "# placeholder\n";
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
      // 豁免名册的另一个方向：**名册会变成永久的洞**，所以名册里的目录消失了也要红。
      why: "R1 语言轴：非语言目录豁免名册过期（docs/design 不在了）",
      hits: ["R1 语言轴 docs/ 下的子目录集合与「LANGS + 非语言目录豁免名册」对不上", '少掉 ["design"]'],
      mutate: (f) => { for (const d of NON_LANG_DOC_DIRS) drop(f, `docs/${d}/placeholder.md`); },
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
 * 的子串、六份文档名单与 `DOCS` 逐项对齐、十二道门禁那一串短名逐个是 `ci.yml` 里对应那一步
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

  it("CHANGELOG 里那三串手抄清单（协议括号标签 / 六份文档 / 十二道门禁）逐项对齐真源", () => {
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

  /** 五种语言在首屏语言切换行里的**自称**，从根 `README.md` 现算。认不出 / 数量对不上返回 `null`。 */
  const nativeLangLabels = (read: (p: string) => string = readReal): string[] | null => {
    const line = read("README.md").split("\n").find((l) => l.startsWith("**Language:**"));
    if (line === undefined) return null;
    const cells = line.replace("**Language:**", "").split("|").map((s) => s.trim()).filter((s) => s !== "");
    const labels = cells.map((c) => /^\[([^\]]+)\]/.exec(c)?.[1]?.trim() ?? c);
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
    expect(changelogGateItems("- **CI 十二道门禁**：—— 一个短名都没写\n"),
      "门禁那一串一个短名都切不出来时没返回 null").toBeNull();
    expect(ciGateNames(() => "jobs:\n  ci:\n"), "ci.yml 里一步都认不出时 ciGateNames 没返回 null").toBeNull();
    expect(ciGateNames(() => "      - name: 1/2 甲\n      - name: 3/2 乙\n"),
      "ci.yml 的序号不连号时 ciGateNames 没返回 null").toBeNull();
    expect(entryStorages(() => "import { Whatever } from \"./x.js\";"), "认不出 entry 的存储实现时没返回 null").toBeNull();
    expect(dispatcherStatuses(() => "function fail() { status: 503 }"), "认不出 504 时没返回 null").toBeNull();
    expect(nativeLangLabels(() => "# 没有语言切换行\n"), "认不出语言切换行时没返回 null").toBeNull();
    expect(nativeLangLabels(() => "**Language:** English | [日本語](docs/ja/README.md)\n"),
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
 * ── 设计小节「重置到底重置了什么」的逐存储键表（P3e Task 30）─────────────────────
 *
 * 订正 D1 的原话是「『重置』到底重置了什么本身就需要一节设计，而本文档没有这一节」。
 * 这一组守的是那一节里**那张表**，不是那一节的散文。
 *
 * ⚠️ **两格是互补不是重复，别合成一格**（与 Task 10「下标不变式与 EXPECTED 互补」同一条道理）：
 * · 第一格的输入是**手写的 `import` 清单** `KEYS` ⇒ 它管「表里有没有漏」；
 * · 第二格的输入是**源码扫描** ⇒ 它管「那张 `import` 清单自己有没有漏」。
 * 合成一格之后，扫描写坏时它会静默恒绿——本仓 `--reporter=basic` 空跑那一族。
 *
 * ⚠️⚠️ **需求书那段示例代码里的 `design.slice(design.indexOf(...))` 不能照抄，实测会假绿**：
 * 它切到的是**文件尾**，于是「小节」里装着 §6–§17 整个下半本文档。
 * `config` / `key:` 这些串在下半本里本来就到处都是（实测：把整张表连同小节一起删掉，
 * 那一格照样绿）。**本组切到下一个 `## ` 为止**，`resetSection()` 就是那一刀。
 *
 * ⚠️ 判据用的是**整格 code span 相等**，不是 `includes`：`config` 这个词在任何一段中文
 * 设计文档里都能撞上（`/admin/api/config/reset` 就够了），`includes` 判据在删掉
 * `config` 那一行之后不会红——与本文件开头登记的「裸 `120` 已经出现 4 次」同一个坑。
 */
const RESET_DESIGN_DOC = "docs/design/2026-08-15-agnes2api-p3-admin-panel-design.md";
const RESET_HEADING = "## 重置到底重置了什么";

/**
 * 从真源 import 的存储键常量。**手写的是 import 列表，不是键名。**
 * 顺序与设计小节那张表一致，纯为对读方便；判据不看顺序。
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

/** 三条重置路径，顺序 = 表里那三列裁决的顺序。 */
const RESET_PATHS = ["重置配置", "清空 Key 池", "重置用量统计"] as const;
/** 裁决的**封闭词表**：留白、写成「部分」「视情况」一律红。 */
const VERDICTS = ["动", "不动"] as const;

/** 小节体：从标题切到**下一个 `## `**，不是切到文件尾（理由见本组文件头）。 */
function resetSection(design: string): string {
  const i = design.indexOf(RESET_HEADING);
  if (i < 0) return "";
  const rest = design.slice(i);
  const j = rest.indexOf("\n## ", 1);
  return j < 0 ? rest : rest.slice(0, j);
}

/**
 * 那张表：`键名字面量 → 三格裁决`。
 * 判据是「这一行恰好 6 格，且第一格是一个**完整的** code span」——
 * 三条重置路径那张表每行只有 4 格，撞不上。
 */
function keyVerdictRows(sec: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of sec.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) continue;
    const cells = t.slice(1, -1).split("|").map((c) => c.trim());
    if (cells.length !== 6) continue;
    const m = /^`([^`]+)`$/.exec(cells[0] ?? "");
    if (m === null) continue;
    out.set(m[1]!, cells.slice(3).map((c) => c.replace(/\*/g, "").trim()));
  }
  return out;
}

/** 第一格的全部判据。**报文逐条点名**，不许只说「表不对」。 */
function resetTableFailures(design: string): string[] {
  const sec = resetSection(design);
  if (sec.length < 200) {
    return [`${RESET_DESIGN_DOC} 里找不到「${RESET_HEADING}」那一节（或它短得不像一节）——`
      + "订正 D1 要求的就是这一节，它是 Task 31 / 31A 的输入。"];
  }
  const fails: string[] = [];
  const rows = keyVerdictRows(sec);
  // ⚠️ **先查清单本身**：某个真源常量被改回字面量（或改了名）之后，`import` 拿到的是
  // `undefined`，而报文会变成「存储键 `undefined` 在那张表里没有一行」——那句话会
  // 把人引去改设计文档，真因却在源码。`pnpm typecheck` 那道门禁同样会红，但这一格的报文
  // 得自己说得清楚。实测见本组 M4。
  const broken = KEYS.map((k, i) => [i, k] as const).filter(([, k]) => typeof k !== "string" || k === "");
  if (broken.length > 0) {
    return broken.map(([i]) =>
      `KEYS 第 ${i + 1} 项不是一个非空字符串 —— 它 import 的那个真源常量多半已经不再导出了。`
      + "真因在源码，不在设计文档。");
  }
  for (const k of KEYS) {
    if (!rows.has(k)) {
      fails.push(`存储键 \`${k}\` 在那张表里没有一行 —— 九把键必须逐把表态，`
        + "第一列写的是键名字面量、整格一个 code span（判据不是 includes）。");
    }
  }
  for (const [k, verdicts] of rows) {
    if (!KEYS.includes(k)) {
      fails.push(`表里多出一行 \`${k}\`，而它不在从真源 import 的那张清单里 —— `
        + "要么它是新存储键（那就 import 进 KEYS），要么这一行写错了。");
      continue;
    }
    verdicts.forEach((v, i) => {
      if (!(VERDICTS as readonly string[]).includes(v)) {
        fails.push(`\`${k}\` 在「${RESET_PATHS[i]}」那一格的裁决是「${v || "(空)"}」，`
          + `不在封闭词表 ${VERDICTS.join(" / ")} 里 —— 留白不算表态。`);
      }
    });
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
 * 两条都逐字登记在设计小节「这一节的守卫能与不能」的「也不能」那一栏里。
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
 * 「要么提成导出常量进 `KEYS` 并给设计表补一行，要么回来在设计小节表下那段登记里
 * 给它一行并说明它为什么不是业务键」。
 *
 * 今天只有一条：`src/adapters/storage-file.ts` 的 `TTL_TABLE_KEY = " ttl"`——
 * file 适配器写在 `store.json` **顶层**的 TTL 记账表，`list()` 用 `k !== TTL_TABLE_KEY`
 * 把它滤掉，Worker/KV 侧根本不存在它。它同时是 `src/` 下**唯一一个不带 `export`** 的
 * 这类常量，上一版的扫描（只认 `export const`）因此看不见它，而设计小节当时那句
 * 「全仓的存储键：九把」**就是假的**。
 */
const PORTLESS_KEYS: ReadonlyArray<{ file: string; name: string; value: string }> = [
  { file: join("src", "adapters", "storage-file.ts"), name: "TTL_TABLE_KEY", value: " ttl" },
];

/**
 * 免费档 delete 桶的每日次数，**从 `docs/zh-CN/DEPLOY.md` 那一行现抠**（复评 F8 回填）。
 *
 * 本仓没有对应常量可 import——它是 Cloudflare 的平台配额，只写在配额账那一节里。
 * 上一版小节里把它手写成 `1,000`，是那一节**唯一一个没有测法的数**。
 * ⚠️ **认不出要吵**：抠不出来时 `throw`，不许 `?? "1,000"` 之类的静默兜底——
 * 那会让判据在 DEPLOY.md 被改写之后恒绿（本仓「判据用错工具时静静放行」那一族）。
 */
function deleteBucketPerDayFromDeployDoc(): string {
  const src = readFileSync(join("docs", "zh-CN", "DEPLOY.md"), "utf8");
  const m = /`list` 与 `delete` 是另外两个桶，各 ([\d,]+) 次\/天/.exec(src);
  if (m === null) {
    throw new Error(
      "docs/zh-CN/DEPLOY.md 里认不出「`list` 与 `delete` 是另外两个桶，各 N 次/天」那一句 —— "
      + "判据坏了，不许静默当成「文档里没这个数」。要么那句话被改写了（回来把这条正则改对），"
      + "要么配额账那一节没了（那才是真问题）。",
    );
  }
  return m[1]!;
}

describe("设计小节「重置到底重置了什么」的逐存储键表（P3e Task 30）", () => {
  const realDesign = (): string => readFileSync(RESET_DESIGN_DOC, "utf8");

  /** 探针的基：真文档今天必须过判据，否则探针红了会被误读成「探针有问题」。 */
  function probeBaseReset(): void {
    const base = resetTableFailures(realDesign());
    if (base.length > 0) {
      throw new Error(
        "本格是探针，它的基取自真设计文档，而真文档今天本身就不过判据 —— "
        + "别从这一格的报文里找原因，真因在「设计小节那张表对这 9 个存储键逐个表态」那一格：\n"
        + base.join("\n"),
      );
    }
  }

  it("设计小节那张表对这 9 个存储键逐个表态 —— 删掉表里一行就红", () => {
    // ⚠️ 手写字面量等号，不许 `toBeGreaterThanOrEqual`（本计划 §通用纪律逐字禁的形态）。
    expect(KEYS.length, "键表被改动了 —— 回来把这个数改对，别删断言").toBe(9);
    expect(new Set(KEYS).size, "KEYS 里有重复的键名 —— 两个常量取了同一个值？").toBe(9);
    const failures = resetTableFailures(realDesign());
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
      + "把它 import 进 KEYS、并在设计小节那张表里给它一行（逐把表态，不许留白）：\n"
      + orphans.join("\n")).toEqual([]);

    // 不带 `export` 的那一族：与 `PORTLESS_KEYS` **逐条相等**（封闭登记，不是豁免名册）。
    // ⚠️ 报文要把两条出路都说出来，否则下一个人只会来改这张表——那就把封闭登记变成了洞。
    const fmt = (xs: readonly { file: string; name: string; value: string }[]): string[] =>
      xs.map(show).sort();
    expect(fmt(portless),
      "`src/` 下不带 `export` 的存储键常量与封闭登记 `PORTLESS_KEYS` 对不上 —— "
      + "多出来的那条要么**提成 `export` 常量**、import 进 KEYS 并给设计小节那张表补一行"
      + "（它经 `Storage` 端口就走这条），要么回来在**设计小节表下那段登记**里给它一行、"
      + "说明它为什么不是业务键，再把它加进 `PORTLESS_KEYS`。"
      + "少了一条则说明那把键没了或改了形态，回来把这张表改对：\n"
      + `实扫：${fmt(portless).join(" / ") || "(空)"}\n登记：${fmt(PORTLESS_KEYS).join(" / ")}`)
      .toEqual(fmt(PORTLESS_KEYS));

    // 封闭登记里的每一条都必须在设计小节表下那段登记里被点名（常量名 + 文件）。
    // ⚠️ 没有这一条，`PORTLESS_KEYS` 就成了一张只有测试知道、文档读者看不见的名单。
    // ⚠️ 文件名从**每一条自己的 `file`** 现算，不许写死 `"storage-file.ts"`：
    // 写死之后，将来登记里多出一条来自别的文件的键，这一格照样绿——
    // 那正是本仓「判据用错工具时不会报错，会静静地放行」那一族。
    const sec = resetSection(realDesign());
    const unnamed = PORTLESS_KEYS
      .filter((d) => !sec.includes(d.name) || !sec.includes(basename(d.file)))
      .map((d) => `${d.name}（${basename(d.file)}）`);
    expect(unnamed,
      "封闭登记里的这几把键在设计小节里一个字都没提 —— 那张表下面那段登记要点名"
      + "（常量名 + 所在文件 + 为什么它不经 `Storage` 端口 + 三条重置路径动不动它）：\n"
      + unnamed.join("\n")).toEqual([]);

    // 计数是「扫描不是空跑」的绊线，也拦「加了键、也 import 了、但没回来改这个数」。
    // ⚠️ 报文要两个方向都说得通：扫少了是扫描坏了，扫多了是清单该长大。
    expect(exported.length,
      "扫到的**导出**存储键常量条数与手写的不一致 —— 比 9 少通常是扫描写坏了（判据认不出真声明），"
      + "比 9 多说明真加了一把键：把它 import 进 KEYS、给设计小节那张表补一行，再回来把这个数改对").toBe(9);
    expect(declared.length,
      "扫到的存储键常量总数不是 10（9 把导出的业务键 + 1 把封闭登记里的适配器内部键）—— "
      + "扫少了是判据认不出真声明，扫多了见上面两条报文").toBe(10);
  });

  it("小节里那几个数一律从真源常量现算 —— 改了常量而小节没跟着改就红", () => {
    const sec = resetSection(realDesign());
    const s = (ms: number): number => ms / 1000;
    const expected: [string, string][] = [
      ["config 的生效上界（§5.3 同一个数）",
        `≤ ${s(CONFIG_TTL_MS)} 秒（holder TTL）+ 约 ${s(KV_EDGE_CACHE_MS)} 秒`
        + `（KV 边缘缓存与传播）≈ ${s(CONFIG_TTL_MS + KV_EDGE_CACHE_MS)} 秒`],
      ["key 池快照的生效上界",
        `默认 ${s(DEFAULT_POOL_CACHE_TTL_MS)} 秒）+ 约 ${s(KV_EDGE_CACHE_MS)} 秒边缘缓存`
        + ` ≈ ${s(DEFAULT_POOL_CACHE_TTL_MS + KV_EDGE_CACHE_MS)} 秒`],
      ["被实测推翻的那条有界性论证（它算的是 Tier-2 键空间，不是这颗按钮）",
        `${USAGE_DAY_RETAIN} × ${USAGE_SLOTS} = ${USAGE_DAY_RETAIN * USAGE_SLOTS}`],
      ["导入上限（用来说明它兜不着批量重置那条路）", `MAX_IMPORT_KEYS = ${MAX_IMPORT_KEYS}`],
      // 复评 F8 回填：这是小节里**唯一一个本仓没有对应常量**的数（Cloudflare 平台配额）。
      // 手写它就是一个没有测法的数字 ⇒ 改成**从五语言 DEPLOY.md 的 zh-CN 那份现抠**，
      // 两处从此一起动。抠不出来要吵，不许静默当成「没这句话」。
      ["免费档 delete 桶（口径锚在 docs/zh-CN/DEPLOY.md 那一行，不是手写）",
        `免费档 delete 桶 ${deleteBucketPerDayFromDeployDoc()}/天`],
    ];
    const missing = expected
      .filter(([, text]) => !sec.includes(text))
      .map(([what, text]) => `${what}：小节里找不到「${text}」`);
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("复评 F7 回填：§5.3 那张表的同一批数也从真源常量现算 —— 改了常量只改一处就红", () => {
    // 上一版小节里写着「（§5.3 那张表逐字，同一个数）」，实测两件事都不对：
    // ① 不逐字（§5.3 的排版是「30s / 60s」，小节里是「30 秒 / 60 秒」）；
    // ② 复评的 MUT-H（`KV_EDGE_CACHE_MS 60_000 → 75_000`）跑下来，
    //    整个 docs-parity 里**只有小节那一格红**，§5.3 纹丝不动 ⇒ 这条交叉引用当时无守卫。
    // 这一格把 §5.3 那句也钉到同一批常量上，两处从此一起红。
    // ⚠️ **剩下的欠账要写明白，而且这句话本身被实测改过一次**：草稿里写的是
    // 「五份 DEPLOY.md 那句只被『关键数字对等』那一组钉着」——**当时是假的**，
    // `**90` 那时根本不在 `NUMBERS` 表上（实测：把 zh-CN 那句 `**90 秒**` 改成
    // `**95 秒**`，docs-parity 251 格全绿）。回填时把它补进了 `NUMBERS`（见那张表）。
    // ⇒ **今天的真实分工**：§5.3 与本小节的数**从常量现算**（这一格 + 上一格）；
    // 五份 DEPLOY.md 的那句只由跨语言**计数相等**钉着 ⇒ 挡「某一份改歪」，
    // **挡不住「常量真改了、五份一起没跟上」** —— 那一种今天仍然要人手改。
    const s = (ms: number): number => ms / 1000;
    const want = `≤ ${s(CONFIG_TTL_MS)}s（holder TTL）+ 约 ${s(KV_EDGE_CACHE_MS)}s`
      + `（KV 边缘缓存与传播，默认值）≈ ${s(CONFIG_TTL_MS + KV_EDGE_CACHE_MS)} 秒`;
    expect(readFileSync(RESET_DESIGN_DOC, "utf8"),
      `§5.3 那张表里找不到「${want}」—— 要么常量改了而 §5.3 没跟着改（去改 §5.3），`
      + "要么 §5.3 那句被改写了（那就回来把这一格的拼法改对，别把它删掉）").toContain(want);
  });

  it("第三颗按钮的去向写死了：小节里恰好一条「裁定：做 / 不做」，不许留白也不许两条都在", () => {
    // 需求书逐字：「二选一，不许留白」，**且这个裁定就是 Task 31A 的输入**。
    const hits = [...resetSection(realDesign()).matchAll(/^\*\*裁定：(做|不做)。\*\*/gm)];
    expect(hits.map((m) => m[1]),
      "小节里的「裁定：X。」不是恰好一条 —— 留白或者两条都在，Task 31A 就没有输入了").toHaveLength(1);
  });

  it("该红时红：从表里删掉 `tend:history` 那一行 —— 第一格红并点名它", () => {
    probeBaseReset();
    const real = realDesign();
    const line = real.split("\n").find((l) => l.trim().startsWith(`| \`${TEND_HISTORY_KEY}\` |`));
    expect(line, "变异没落地——表里找不到 `tend:history` 那一行").toBeDefined();
    const mutated = real.split(`${line}\n`).join("");
    expect(mutated, "变异没落地——文档没变").not.toEqual(real);
    const failures = resetTableFailures(mutated);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没点名那把键").toContain(TEND_HISTORY_KEY);
  });

  it("该红时红：把某一格裁决留白 —— 第一格红并点名是哪把键的哪一条路径", () => {
    probeBaseReset();
    const real = realDesign();
    const marker = `| \`${HEALTH_PROBE_KEY}\` |`;
    const line = real.split("\n").find((l) => l.trim().startsWith(marker));
    expect(line, "变异没落地——表里找不到 `health:probe` 那一行").toBeDefined();
    // 最后一格（「重置用量统计」那一列）掏空。
    const blanked = `${(line ?? "").replace(/\|[^|]*\|$/, "|  |")}`;
    expect(blanked, "变异没落地——那一行没被改动").not.toEqual(line);
    const failures = resetTableFailures(real.split(line ?? "").join(blanked));
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "红了但报文没点名那把键").toContain(HEALTH_PROBE_KEY);
    expect(failures[0] ?? "", "红了但报文没点名是哪一条重置路径").toContain(RESET_PATHS[2]);
  });

  it("该红时红：整节被删掉 —— 报文说的是「找不到这一节」，不是九条「少一行」", () => {
    probeBaseReset();
    const gutted = realDesign().split(RESET_HEADING).join("## (gone)");
    expect(gutted, "变异没落地——标题还在").not.toContain(RESET_HEADING);
    const failures = resetTableFailures(gutted);
    expect(failures, `报文：\n${failures.join("\n")}`).toHaveLength(1);
    expect(failures[0] ?? "", "报文没说清是整节不见了").toContain(RESET_HEADING);
  });

  it("探针：切片只到下一个 `## ` —— 把整节连表一起删掉之后，下半本文档不许把它救绿", () => {
    // 这一格钉的是需求书示例里那处 `slice(indexOf(...))` 假绿：切到文件尾时，
    // `config` / `key:` 这些串在 §6–§17 里本来就有，删掉整张表也不会红。
    probeBaseReset();
    const real = realDesign();
    const sec = resetSection(real);
    expect(sec.length, "切片切出来是空的，判据本身坏了").toBeGreaterThan(200);
    expect(sec, "切片越界，把下一节的标题也吃进来了").not.toContain("## 6. 数据模型：key 池");
    const withoutSection = real.split(sec).join("\n");
    expect(withoutSection, "变异没落地——整节还在").not.toContain(RESET_HEADING);
    // 同一份判据、同一个函数：整节没了就必须红。
    expect(resetTableFailures(withoutSection), "整节删掉之后判据还是绿的").not.toEqual([]);
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

  it("不乱红：小节里多一段无关的散文、表里多一列说明 —— 不许因此红", () => {
    probeBaseReset();
    const real = realDesign();
    const noisy = real.replace(RESET_HEADING, `${RESET_HEADING}\n\n> 补记：这一段是后来加的，与那张表无关。`);
    expect(noisy, "变异没落地").not.toEqual(real);
    expect(resetTableFailures(noisy), "多一段散文把这一格弄红了").toEqual([]);
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
   *    字符都对不上；需求书 M1 用的变异串 `P3f 会提供一条正式重置路径`（这一串真的
   *    写在 `docs/design/2026-08-22-agnes2api-p3e-i18n-and-closeout-plan.md` 里）
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
   * 逐字抄自改话前的 `docs/<lang>/DEPLOY.md`（zh-CN 那句今天仍逐字写在
   * `docs/design/2026-08-22-agnes2api-p3e-i18n-and-closeout-plan.md` 的 R10 那一行里）。
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
    // ⚠️ **这一串是仓里真实存在的**：它逐字写在
    // `docs/design/2026-08-22-agnes2api-p3e-i18n-and-closeout-plan.md` 的 Task 31A M1 那一行。
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
 * ── 「改一把 key 能改哪几件事」的两个投影都从 `PATCH_FIELDS` 现算（P3e Task 31A 复评回填 H2）──
 *
 * **复评实测出来的洞**：给 `PATCH_FIELDS` 加第七个字段 ⇒ 本文件全绿、
 * Key 池写端点那一组契约用例也全绿，而五份 DEPLOY.md 那笔配额账里的动作枚举、
 * 设计文档 §11 的端点表**都停在六个字段上**。
 * 上面那一组只把 `clearStats` **这一个**字段名钉在真源上（改名当场红），
 * **表变长它一个字都看不见**——那正是 task-31A-report.md 遗留 6 与遗留 7 登记的两笔，
 * 这一组把它们收掉。
 *
 * ⚠️ **同一轮里删掉的那个数**：五份原来写着「六个动作同价 / All six actions /
 * 6 つの操作 / 여섯 동작」，而紧挨着的括号里枚举的是**七**项——`disabled` 一个字段
 * 对应「停用 / 启用」两个方向。那个数与它身边那一行自相矛盾，且真源变了也不会红。
 * **能删数字就删数字**：五份一律改成「上面每一项都同价」，数量这件事交给下面两格。
 */
describe("「改一把 key」那份动作枚举的两个投影都从 `PATCH_FIELDS` 现算（P3e Task 31A 复评回填）", () => {
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

  it("不乱红：五份一起合法地多写一句无关的话", () => {
    probeBaseEnumeration();
    const noisy: ApiDocReader = (lang) => `${realDoc("DEPLOY")(lang)}\n\n<!-- 无关的一行 -->\n`;
    expect(enumerationFailures(PATCH_FIELDS, noisy), "五份一起多写了一句无关的话，判据却红了").toEqual([]);
  });

  // ── 第二个投影：设计文档 §11 端点表那一行的请求体字段清单 ──────────────────

  const ENDPOINT_ROW_ANCHOR = "| PATCH | `/admin/api/keys/:id` |";

  /** 设计文档的取文口径。**与上面那一组同名的那个是各自 describe 里的局部量**，这里另取一份同源的。 */
  const designSrc = (): string => readFileSync(RESET_DESIGN_DOC, "utf8");

  /**
   * 从端点表那一行里把 `{ a?, b?, … }` 解析成字段数组。
   * **解析不出来返回 `null`**（行不在、或不是恰好一行、或那一格里没有花括号）——
   * 同样是「认不出要吵」：解析不出来时返回 `[]` 会让下面那格拿空数组去比，
   * 报文说的是「字段对不上」，而真相是这一格根本没找到那一行。
   */
  function endpointRowFields(src: string): string[] | null {
    const rows = src.split("\n").filter((l) => l.startsWith(ENDPOINT_ROW_ANCHOR));
    if (rows.length !== 1) return null;
    const m = (rows[0] as string).match(/\{([^}]*)\}/);
    if (m === null) return null;
    return (m[1] as string).split(",").map((s) => s.trim().replace(/\?$/, "")).filter((s) => s !== "");
  }

  it("设计文档 §11 端点表那一行的请求体字段清单，逐项逐序等于 `PATCH_FIELDS`", () => {
    const got = endpointRowFields(designSrc());
    expect(
      got,
      `${RESET_DESIGN_DOC} 里以「${ENDPOINT_ROW_ANCHOR}」开头的行不是恰好一行、`
      + "或者那一行里解析不出 `{ … }` —— 这一格是靠那一行活着的，解析不出来就是空转",
    ).not.toBeNull();
    expect(
      got,
      `${RESET_DESIGN_DOC} 的端点表那一行写的请求体字段与真源 \`PATCH_FIELDS\` 对不上`
      + "（`src/http/admin/handlers/keys-write.ts`）—— **顺序也算**：那张表的顺序"
      + "就是文档顺序，两边的顺序一旦分家，读表的人拿到的就是另一份约定",
    ).toEqual([...PATCH_FIELDS]);
  });

  it("该红时红：端点表那一行少一个字段 / 多一个字段 / 顺序换了，三种都不许绿", () => {
    const real = designSrc();
    expect(endpointRowFields(real), "探针的基坏了：真文档今天就解析不出那一行").toEqual([...PATCH_FIELDS]);
    // 三种变异串都取自那一行今天真实的原文。
    const dropped = real.split(", clearStats? }").join(" }");
    expect(dropped, "变异没落地").not.toEqual(real);
    expect(endpointRowFields(dropped), "少一个字段却绿了").not.toEqual([...PATCH_FIELDS]);
    const added = real.split(", clearStats? }").join(", clearStats?, clearNote? }");
    expect(endpointRowFields(added), "多一个字段却绿了").not.toEqual([...PATCH_FIELDS]);
    const reordered = real.split("{ disabled?, note?,").join("{ note?, disabled?,");
    expect(reordered, "变异没落地").not.toEqual(real);
    expect(endpointRowFields(reordered), "顺序换了却绿了").not.toEqual([...PATCH_FIELDS]);
  });

  it("不乱红：设计文档里多一段散文、那一行前后多几行表 —— 不许因此红", () => {
    const noisy = designSrc().replace(
      ENDPOINT_ROW_ANCHOR,
      `| PATCH | \`/admin/api/keys/:id/nothing\` | ✅ | \`{ 与上面那张真源无关 }\` |\n${ENDPOINT_ROW_ANCHOR}`,
    );
    expect(noisy, "变异没落地").not.toEqual(designSrc());
    expect(endpointRowFields(noisy), "多了一行长得像的表行，判据却红了").toEqual([...PATCH_FIELDS]);
  });
});
