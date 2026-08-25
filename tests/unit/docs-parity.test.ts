import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FAIL_REASONS } from "../../src/core/dispatcher.js";
import { UPSTREAM_FACTS, type UpstreamFact } from "../../src/core/admin/upstream-facts.js";
import { VIDEO_TASK_ID_SHAPE } from "../../src/core/admin/protocol-catalog.js";
// ADMIN.md 那一组的期望值一律从这些真源常量派生，不手写字面量。
import { ADMIN_TOKEN_MIN_LENGTH } from "../../src/http/admin/auth.js";
import { MAX_IMPORT_KEYS } from "../../src/http/admin/handlers/keys-write.js";
import { EVENT_WINDOW_MS, EVENT_WINDOW_RETAIN } from "../../src/core/admin/event-ring.js";
import { USAGE_DAY_RETAIN, USAGE_SLOTS } from "../../src/core/admin/usage-stats.js";
import { SESSION_MAX_AGE_MS } from "../../admin-ui/js/pure/session.mjs";
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
  ];

  for (const { token, why } of NUMBERS) {
    it(`五语言 DEPLOY.md 里「${token}」（${why}）的出现次数彼此一致`, () => {
      const counts = Object.fromEntries(
        LANGS.map((lang) => {
          const src = readFileSync(`docs/${lang}/DEPLOY.md`, "utf8");
          return [lang, src.split(token).length - 1] as const;
        }),
      ) as Record<(typeof LANGS)[number], number>;

      // 先挡住「五份都是 0」这种平凡相等——那不叫对等，叫这个锚点压根没写进任何
      // 一份文档（token 本身打错，或该数字被整体换了写法）。
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(total, `「${token}」（${why}）在五语言里一次都没出现，先检查 token 是否还匹配文档里的真实写法`)
        .toBeGreaterThan(0);

      // 期望值来自其余语言，不是手写常数：任何一种语言的计数与其余四份不一致，
      // 下面这个对象级 toEqual 会把完整的五语言计数摊开显示，一眼看出是哪一种偏了。
      const reference = counts[LANGS[0]];
      const expected = Object.fromEntries(LANGS.map((lang) => [lang, reference])) as Record<(typeof LANGS)[number], number>;
      expect(
        counts,
        `「${token}」（${why}）在五语言里的出现次数不一致——可能有语言漏翻、漏改，或翻译时抄错了数字`,
      ).toEqual(expected);
    });
  }
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
        `首个不同的下标 ${at}（参照 ${JSON.stringify(refArr[at])} / 本份 ${JSON.stringify(arr[at])}）`,
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
      hits: ["API.md 的「R2", "ja"],
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
});

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
   * 一次扫描 × 五份 ADMIN.md。返回失败报文数组。真扫描与探针**共用这一份**。
   * **射程是全部语言的全部词**（不是「这一份只查它自己语言的词」）：一份英文文档里
   * 冒出一个「충분」同样是错的，按语言分开查会把这类漏掉。
   */
  function softenerFailures(read: ApiDocReader): string[] {
    const out: string[] = [];
    for (const lang of LANGS) {
      const lower = read(lang).toLowerCase();
      for (const w of SOFTENER_WORDS) {
        if (lower.includes(w)) {
          out.push(
            `${lang}/ADMIN.md 把一件本仓从没量过的事说成了「${w}」`
            + `（软化概念 ${(SOFTENER_ORIGINS.get(w) ?? []).join("、")}）`
            + "——能写下来的只有上限本身，以及「本仓没量过」这句话",
          );
        }
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

  /**
   * 屏幕那边的独立计数。真扫描与探针**共用这一份**。
   *
   * ⚠️ **卡与模式取的是「真的建出来的那几张 / 那几档」，不是字典里的键数**：
   * `set.card.upstreamNote` 与 `pg.mode.label` 同样长得像 `set.card.*` / `pg.mode.*`，
   * 按字典数就会各多出一个，而屏幕上并没有那张卡、那一档。字典那边的作用是**作证**
   * （下面「两条独立派生互相认账」那一格：这里数出来的每一个名字都得在字典里有译文），
   * 不是当计数用。
   */
  function panelCounts(src: PanelSource): PanelCounts {
    const cardNames = [...src.settings.matchAll(/card\("(set\.card\.[A-Za-z]+)"\)/g)]
      .flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
    const modeKeys = [...src.playground.matchAll(/\{\s*mode:\s*"[a-z]+",\s*key:\s*"(pg\.mode\.[a-z]+)"\s*\}/g)]
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

  /**
   * 卡与模式那两条计数的**第二个独立来源**：字典。
   * 这里数出来的每一个名字都得在 `i18n-dict.js` 里有一条真的键——名字打错、卡被改名而
   * 字典没跟着改，都会在这一格红，而不是让上面那两条计数静静地少一个。
   * ⚠️ **字典这边只作证不当计数**，理由见 `panelCounts()` 上方那段。
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
});
