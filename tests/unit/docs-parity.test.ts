import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FAIL_REASONS } from "../../src/core/dispatcher.js";
import { UPSTREAM_FACTS, type UpstreamFact } from "../../src/core/admin/upstream-facts.js";

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

/** 五份 API.md 的取文口径：真扫描与探针**共用这一份**，探针换掉的只是这个函数。 */
type ApiDocReader = (lang: Lang) => string;

const realApiDoc: ApiDocReader = (lang) => readFileSync(docPath(".", lang, "API"), "utf8");

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

  /** 变异只改一种语言的那一份，其余四份照旧走真文档。**改不动就当场炸。** */
  function readerWith(target: Lang, edit: (s: string) => string): ApiDocReader {
    return (lang) => {
      const src = realApiDoc(lang);
      if (lang !== target) return src;
      const out = edit(src);
      if (out === src) throw new Error(`变异没落到 docs/${lang}/API.md 上——这一格控制是空的`);
      return out;
    };
  }

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
 * ⚠️ 本任务落地时这张表是五项（不含 `ADMIN`）——`ADMIN.md` 由后续任务创建，
 * 那时把 `"ADMIN"` 加进来，**R1 的第一条断言会强制那一步**（不加就红）。
 */
const DOCS = ["API", "DEPLOY", "README", "REGISTRAR", "USAGE"] as const;

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
