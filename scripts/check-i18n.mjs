#!/usr/bin/env node
/*
 * i18n 门禁。设计文档 §9.1 的七条断言里，**六条在这里**，第六条（TendFailureReason
 * 穷尽）在 tests/unit/i18n-dict.test.ts —— 联合类型是编译期的，node 脚本枚举不出来，
 * 拿正则去解析 TS 源码只会得到一条随格式变化悄悄失效的断言，而那正是本项目最怕的形态。
 * **这条边界写在这里，不写成「本脚本覆盖全部七条」。**
 *
 * 与那份测试**故意是两份独立实现**：CI 第 6 道跑这个脚本、第 10 道跑那份测试，
 * 两者用不同代码路径回答同一批问题，其中一份写错时另一份会不同意。
 *
 * ⚠️⚠️ **「独立」的边界从 P3e Task 3 起变窄了，别再宣称「两边处处独立」。**
 * 本脚本第 ① 条的抠注释已经 import `scripts/lib/strip-comments.mjs`，而
 * `tests/unit/i18n-dict.test.ts` 的广扫走的是同一份真源 ⇒
 * **「怎么把注释抠掉」两边是同一份实现，它错了两边一起错。**
 * 那是刻意的：两份抠注释器不一致时，瞎掉的那一份才是会报绿的那一份（P3e Task 1 的裁定）。
 * **仍然独立的是另一件事**：那份测试手写 `NAMESPACES` 登记表 + 三条反向自检，
 * 与本脚本「从字典自动派生命名空间」是两条不同的路，那一半没有被收编。
 *
 * ⚠️ **第 ⑧ 条（带占位符的 key 不许当裸标签用）是 P3b Task 7 新加的，设计文档
 * §9.1 里没有它，而且它今天**只有这一份实现**（tests/unit/i18n-dict.test.ts 里
 * 没有对应的一条）。** 之所以还是加上：它是阶段验收的人工冒烟真抓出来的一个
 * 已上线缺陷（详见下面第 ⑧ 条的说明），而前六条一条都拦不住。
 * 单实现这件事如实写在这里，别读成「和前六条一样有两份互为印证」。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments, stripHtmlComments } from "./lib/strip-comments.mjs";

/**
 * 用法：
 *   node scripts/check-i18n.mjs            # 查本仓的 admin-ui/
 *   node scripts/check-i18n.mjs <根目录>    # 查别处的 admin-ui/
 *
 * 第二种形态**只给 tests/unit/check-i18n.test.ts 那份元测试用**（全分支评审 I2）。
 * 在它出现之前，这道门禁自己**零覆盖**：八条判据里任何一条被写坏（正则打错一个
 * 字符、循环 `continue` 错一层、`errors.push` 忘了写），门禁都会安静地 exit 0，
 * 而"门禁绿了"恰恰是所有人赖以放心的那个信号。不能拿真仓做变异——那要往
 * `admin-ui/` 里塞坏文件；给一个根目录入参，元测试就能在临时目录里造八种坏法，
 * 逐条确认它真的报错、且报的是对的那一条。
 *
 * 路径一律按这个 ROOT 解析、**不按 cwd**：CI、git hook、编辑器任务都可能从别的
 * 目录发起调用，按 cwd 解析会静默地检查一个空目录然后报"全部对得上"。
 */
const ROOT = process.argv[2]
  ? fileURLToPath(pathToFileURL(join(process.argv[2], "/")))
  : fileURLToPath(new URL("../", import.meta.url));
const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"];
const BANNED = [
  "推荐", "推薦", "建议", "建議", "默认", "預设", "預設", "主流", "首选", "首選", "优先", "優先",
  "recommended", "preferred", "default",
  "おすすめ", "推奨", "권장", "기본",
];
const IP_PORT = /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{2,5}/;

const { I18N } = await import(pathToFileURL(join(ROOT, "admin-ui/js/i18n-dict.js")).href);

function walk(dir) {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(html|js|mjs)$/.test(p) ? [p] : [];
  });
}

const errors = [];
const warnings = [];

/** 字典自己是**定义处**，不是引用点。第 ① / ⑧ 两条判据都要豁免它，所以只算一次。 */
const DICT_FILE = join(ROOT, "admin-ui/js/i18n-dict.js");

/**
 * 一个源文件抠掉注释之后的样子。**方言按后缀选，不许一律按 JS 抠。**
 *
 * ⚠️ 实测：`admin-ui/index.html` 喂给 JS 方言会当场抛（`</title>` 里那个 `/`
 * 前面是 `<`，被判成正则字面量开头、本行内找不到闭合）。HTML 的注释是
 * `<!-- -->`，走真源的第四个出口。
 */
function stripped(p, src) {
  return p.endsWith(".html") ? stripHtmlComments(src) : stripComments(src);
}

// ① 源码里引用的每个 key 都在字典里 —— **判据形状换过一次，理由写在这里，别改回去。**
//
// 旧判据是两条正则：`data-i18n(?:-ph|-title)?="([^"]+)"` 与 `\bt\("([^"]+)"`。
// 它认得的写法只占本仓真实写法的一小半：勘察实测，字典 521 个 key 里门禁只看得见
// 125 处引用，报 396 条「未被引用」，其中 371 条是**假警报**——那些 key 明明有双引号
// 字面量，只是写法不是那两种。逐族补形态**补不完**：假警报里 elI18n 只占 107 处命中，
// 其余是 return / 三元 / 数组·参数位 / 别的函数首参 / 对象属性赋值。
// **396 条警报把 3 条真的埋了**，而那正是本仓那条「一个诚实标记出现得太密就不再传递信息」。
//
// 新判据的形状是「**命名空间前缀锚定的引号对**」：
//   1. 先抠注释（`scripts/lib/strip-comments.mjs`，逐字符版，**方言按后缀选**）；
//   2. 两种引号都扫（`"` 与 `'`），
//      ⚠️ **引号无关是必须的**：实测 `elI18n('h2','usage.titel')` 能让六道脚本门禁
//      + 全量用例一起全绿，而用量板块主标题在五种语言下显示裸串；
//      ⚠️ **反引号刻意不扫**：反引号里通常是模板拼键，走下面第 4 条那条路，
//      在这里扫会与前缀表重复计算并把 `set.field.` 那一族报成「字典里没有」。
//   3. 命名空间前缀**从字典自动派生**，不手写——手写表会漏掉新板块（那正是
//      `tests/unit/i18n-dict.test.ts`「板块里当参数传的 i18n key（elI18n / labelKey 这类）同样必须在字典里」
//      那一格的手写 `NAMESPACES` 表靠反向自检在防的东西，
//      这里改成从源头免疫）；
//      ⚠️⚠️ **前缀必须写进正则本身去锚定引号对，不许先通用配对引号再回头看是不是 key**，
//      理由是实测出来的，见 `KEYLIKE` 上面那一段。
//   4. 模板拼键（`` `set.field.${path}` ``）单独收成一张**前缀**表，见下面 `TPL_PREFIX`。
//
// ⚠️⚠️ **「先抠注释」是前置，不是可选。** 不抠就广扫会当场自绊：真仓实测多出一条硬错，
// 来自 `admin-ui/js/pure/usage.mjs` 里刻意留着的 `"usage.titel"` 变异样例——那是散文，
// 不是引用点。抠注释之后误报实测为 **0**。这条由
// `tests/unit/check-i18n.test.ts` 的「(c) JS 注释里的 data-i18n 不算引用」与它的反向控制
// 两格一起钉着（**只做一半等于没做**：单看前一格，「判据整个瞎了」也能让它绿）。
//
// ⚠️ **边界（本仓的诚实纪律，别把它读成全称承诺）**：按 `+` 拼的 key
//（`"a." + b`）**不被支持**。今天全仓零处 `+` 拼键、三处模板拼键，所以现在做代价为零；
// 将来真出现 `+` 拼键，它会被报成「未被引用」，那时要么改写成模板字面量，要么扩这里。
//
// ⚠️ **`/^[a-z]+$/` 那个筛子今天筛掉零条**（实测：521 个 key 的 12 个命名空间全是纯小写），
// 它在的理由是**正则安全**——命名空间要拼进下面 `KEYLIKE` 的正则里，带元字符的前缀会把
// 那条正则改写成别的意思。**它失效的方向是吵不是哑**：真出现一个被筛掉的前缀，
// 那个命名空间底下的 key 会整族落进「未被引用」，Task 4 之后就是整族硬错——
// 刺眼但不会静默。别把它改成「筛掉就算了」，也别改成不筛。
const NS = new Set(Object.keys(I18N).map((k) => k.split(".")[0]).filter((p) => /^[a-z]+$/.test(p)));

// ⚠️⚠️⚠️ **这条正则的形状是判据的全部。**
//
// **命名空间前缀写进正则里去锚定引号对**，而不是「先通用配对引号、再回头看是不是 key」。
// 两者**在有空串字面量 `""` 的行上会分叉**，而且分叉得很难看：通用版的
// `"([^"\n]+)"` 要求引号里**至少一个字符**，遇到 `""` 时第一个引号匹配失败、引擎前进一格，
// 从**第二个引号**重新开配，**后面那个真 key 整个被吃掉**。
//
// 真仓实跑（两版逐字对照）：
//     命名空间锚定版：直接引用 496 / 拼键覆盖 22 / 未被引用 3   ← 零误报
//     通用配对引号版：直接引用 485 / 拼键覆盖 22 / 未被引用 14  ← **11 条假阳性**
// 11 条假阳性逐条同因，全是同一行上先出现一个 `""`（`reg.tend.channelAny` / `reg.locked` /
// `ov.runtime.checkedAt` / `models.empty` / `pg.send.blockedNoModel` …）。
// 危害档位不是「多报几条」：**Task 4 紧接着要把「未被引用」升成硬错**
// ⇒ 第 6/12 道门禁会 exit 1 在 **11 个正在用的 key** 上，而 Task 4 同时安排
//「处置真 0 命中 key（删 / 改）」——那条处置一旦被套到这 11 条上，删掉的就是活着的界面文案。
// 反向也只是运气：配对错位产生的碎片今天恰好都不带命名空间前缀，所以「字典里没有的 key」
// 仍是空；任何一行里出现 `""` 且其后紧跟一个 `ns.` 开头的片段，就会**凭空造出一条硬错**。
// ⇒ 这条形状由 `tests/unit/check-i18n.test.ts` 的
//「(e) 同一行上的空串字面量不许把后面那个 key 吃掉」那一格钉着。
const NSALT = [...NS].join("|");
const KEYLIKE = new RegExp(`["'](${NSALT})\\.[A-Za-z0-9_.]+["']`, "g");
// 模板拼键的**前缀**：`` `set.field.${path}` `` ⇒ `set.field.`。**取整段前缀，不取命名空间**：
// 放宽到 `set.` 会把 `set.card.*` 一并喂活，而那正是要处置的那一族。
const TPL_PREFIX = /`([A-Za-z0-9_.]*\.)\$\{/g;
// 内联 `<script>` / `<style>`：本门禁抠 HTML 只认 `<!-- -->`，那一段里的 JS/CSS 注释看不见。
const HTML_INLINE = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi;

const directlyUsed = new Set();
const tplPrefixes = new Set();
for (const p of walk(join(ROOT, "admin-ui"))) {
  // 字典自己是定义处，扫它等于**每个 key 都自证被引用** ⇒ 第 ④ 条恒绿、判据整个作废。
  // 旧判据没跳它，因为旧判据只认 `t("…"` 与 `data-i18n=`，字典里都没有。
  if (p === DICT_FILE) continue;
  const raw = readFileSync(p, "utf8");
  // **HTML 里出现内联脚本 / 样式**⇒ 认不出就吵，不许静静地放行：那一段的注释语法是
  // JS/CSS 的，`stripHtmlComments` 看不见，被注释掉的 `data-i18n=` 会当成真引用混进来。
  // 今天 `admin-ui/index.html` 的两个 `<script>` 都只有 `src=`、零内联内容。
  if (p.endsWith(".html")) {
    for (const m of raw.matchAll(HTML_INLINE)) {
      if (m[2].trim() !== "") {
        errors.push(
          `${p.slice(ROOT.length)} 里有内联 <${m[1]}>：本门禁抠 HTML 只认 \`<!-- -->\`，`
          + "那一段里的 JS/CSS 注释看不见 ⇒ 被注释掉的引用会被当成真引用。"
          + "请把它挪进外链文件，或者去 scripts/lib/strip-comments.mjs 的 stripHtmlComments 扩判据",
        );
      }
    }
  }
  const src = stripped(p, raw);
  // m[0] 含首尾引号，去掉两端即为 key 本身；前缀已由正则锚死，这里不再回头判断。
  for (const m of src.matchAll(KEYLIKE)) directlyUsed.add(m[0].slice(1, -1));
  for (const m of src.matchAll(TPL_PREFIX)) if (NS.has(m[1].split(".")[0])) tplPrefixes.add(m[1]);
}

// ⚠️ **这道门槛今天只拦得住「扫描整个塌掉」，拦不住「扫瞎了一半」**——换判据之后真实
// 数字是 ~496，`< 15` 离它三十倍远。**它仍然留着，但别把它当成防瞎的那道锁**：
// 真正分辨「认对了」与「瞎了」的是 `tests/unit/check-i18n.test.ts` 里
//「(a)(b) elI18n(…) 里拼错的 key 被抓住」那两格**正向探针**——瞎掉的判据什么都不吵。
//
// 门槛值与比较符都要与 `tests/unit/i18n-dict.test.ts`「admin-ui 里引用的每个 key 都在字典里」
// 那份独立实现保持一致（那边写的是
// `toBeGreaterThanOrEqual(15)`，同样 15 本身通过）。两处一度分别写成 `< 15` 与
// `toBeGreaterThan(15)`，在恰好等于 15 的边界上会永久一绿一红——已订正，别再拆开改。
if (directlyUsed.size < 15) errors.push(`只扫到 ${directlyUsed.size} 个 i18n 引用，扫描本身可能坏了`);
for (const k of [...directlyUsed].sort()) if (!(k in I18N)) errors.push(`引用了字典里没有的 key: ${k}`);

// **三个分桶是字典 key 的一个划分**：三个数加起来恒等于字典 key 总数。
// ⚠️ 「直接引用」数的是**字典里被直接引用的 key**，不是 `directlyUsed.size`——后者含
// 「字典里没有的 key」，加起来会超出总数，而那个和正是 Task 4 要盯的观测量。
const coveredByPrefix = Object.keys(I18N).filter(
  (k) => !directlyUsed.has(k) && [...tplPrefixes].some((p) => k.startsWith(p)),
);
const unreferenced = Object.keys(I18N).filter(
  (k) => !directlyUsed.has(k) && !coveredByPrefix.includes(k),
);
const directlyReferenced = Object.keys(I18N).filter((k) => directlyUsed.has(k));

// **分桶横幅在这里就打，而且不管后面红不红都打。**
// 放到最后的成功横幅里的话，门禁一旦 exit 1，三个分桶就看不见了——而
// Task 4 要把「未被引用」升成硬错，正需要它在**红着的时候**也能读出来。
console.log(
  `[check-i18n] 引用判据：直接引用 ${directlyReferenced.length} / 拼键覆盖 ${coveredByPrefix.length}`
  + ` / 未被引用 ${unreferenced.length}；字典共 ${Object.keys(I18N).length} 个 key`,
);
console.log(`[check-i18n] 拼键前缀: ${tplPrefixes.size === 0 ? "（无）" : [...tplPrefixes].sort().join(", ")}`);
console.log(`[check-i18n] 未被引用: ${unreferenced.length === 0 ? "（无）" : unreferenced.join(", ")}`);

// ② 每个 key 都有全部 5 种语言且非空；③ 没有多余语言码
for (const [k, row] of Object.entries(I18N)) {
  for (const lang of LANGS) {
    const v = row[lang];
    if (typeof v !== "string" || v.trim() === "") errors.push(`${k} 缺 ${lang}`);
  }
  for (const lang of Object.keys(row)) {
    if (!LANGS.includes(lang)) errors.push(`${k} 有多余的语言码 ${lang}（拼错的语言码永远取不到）`);
  }
}

// ④ 字典里没被引用的 key ⇒ **警告不报错**
//
// ⚠️ **本任务（P3e Task 3）只换第 ① 条的判据、只改输出，刻意不动这一条的严重级别**，
// 那是 Task 4 的事。拆成两个任务是有意的：判据换形状与警告升硬错是两件独立会出错的事，
// 合起来做的话「396 → 0」与「0 才算过」哪个先坏了分不清。
// 「未被引用」现在读的是上面那个分桶（已扣掉拼键前缀覆盖的那 22 条）。
for (const k of unreferenced) warnings.push(`字典里有未被引用的 key: ${k}`);

// ⑤ 插值 token 在 5 种语言里集合相同
for (const [k, row] of Object.entries(I18N)) {
  const sets = LANGS.map((l) => [...String(row[l] ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(","));
  if (new Set(sets).size !== 1) errors.push(`${k} 的插值占位符在各语言间不一致: ${sets.join(" | ")}`);
}

// ⑥ reg.* 与 keys.addMenu.auto* 禁用词（含繁体变体）
//
// ⚠️ **`keys.addMenu.auto*` 是复评追加的范围，原来只扫 `reg.*`**：P3c Task 4
// 新增的「添加 Key」下拉里，【自动注册】那两项占位文案（`keys.addMenu.autoGroup`
// / `autoMoemail` / `autoYyds`）与 `reg.*`（P2 注册机）
// 说的是同一类事——"这条通道有没有被暗示成比别的通道更好"——但原来的判据
// 只认命名空间前缀 `reg.`，这几个 key 完全不在扫描范围内，复评实测：给
// `keys.addMenu.autoMoemail` 塞一句「推荐使用」，八条断言全绿。这条门禁
// 必须在 Task 6 真正给这两条通道接线、写更多面向运维的文案之前先扩到这里。
for (const [k, row] of Object.entries(I18N)) {
  if (!k.startsWith("reg.") && !k.startsWith("keys.addMenu.auto")) continue;
  for (const lang of LANGS) {
    const s = String(row[lang] ?? "").toLowerCase();
    for (const w of BANNED) if (s.includes(w.toLowerCase())) errors.push(`${k}/${lang} 出现偏好词「${w}」`);
  }
}

// ⑦ 字典全文不命中 scan-secrets.sh 的 IP:PORT 正则
for (const [k, row] of Object.entries(I18N)) {
  for (const lang of LANGS) if (IP_PORT.test(String(row[lang] ?? ""))) errors.push(`${k}/${lang} 出现 IP:PORT 形态`);
}

// ⑧ 带 `{占位符}` 的 key 不许被当成「不带参数的裸标签」用
//
// **这一条是 P3b Task 7 的阶段验收人工冒烟抓出来的，不是凭空加的门禁。**
// `sec-overview.js` 把 `ov.config.envLocked`（一句自带 `{count}` 的完整句子）
// 传给了 `row()`，而 `row()` 内部调的是 `t(labelKey)` —— **不带参数**。
// 面板上于是长这样：
//     被环境变量锁定的字段数：{count}: 被环境变量锁定的字段数：1
// 裸的模板记号直接展示给运维看。前六条断言全绿，因为它们查的是「key 齐不齐」
// 「占位符集合各语言一不一致」，没有一条查「用的时候给没给参数」。
//
// ⚠️ **判据建在「这个 key 的字符串字面量后面紧跟着什么」上，不是建在 `t(` 上。**
// 上面那处的调用点是 `row("ov.config.envLocked")`，压根不是 `t(` 开头——只扫
// `t("…")` 的话这条门禁抓不到当初那个缺陷，那就是一道自称管用的假门禁。
// 规则：带占位符的 key 每一次以字符串字面量出现时，后面必须紧跟一个 `,`
//（也就是「还有第二个参数」）。`data-i18n="…"` 这种属性形态同样会被拦下——
// `apply()` 走的也是不带参数的 `t()`，是同一个缺陷。
//
// **边界**：把这种 key 塞进数组（`["ev.timeline", …]`）时后面也是 `,`，会漏过去；
// 放在数组末尾则会误报。今天 admin-ui/ 下没有这两种写法（实测：唯一的命中就是
// 上面那一处）。真要写，请在这里说明并调整判据，别把这条门禁删掉。
//
// ⚠️ **这一条刻意仍读原文、不抠注释**（与第 ① 条不同）：它查的是「字面量后面紧跟着什么」，
// 而注释里出现这种写法本身就值得被指出来。第 ① 条那边抠注释是因为它要回答
//「这个 key 有没有人用」——散文不算用。两条问的不是同一件事，别顺手统一。
const PLACEHOLDER_KEYS = Object.keys(I18N)
  .filter((k) => LANGS.some((l) => /\{\w+\}/.test(String(I18N[k][l] ?? ""))));
for (const p of walk(join(ROOT, "admin-ui"))) {
  // 字典自己是**定义处**，`"key": { … }` 后面跟的是 `:`，不是调用点。
  if (p === DICT_FILE) continue;
  const src = readFileSync(p, "utf8");
  for (const k of PLACEHOLDER_KEYS) {
    // ⚠️ **两种引号都要扫。** 第一版只认双引号，而仓里没有引号风格门禁：把当初那个
    // 缺陷原样重放成 `row('ov.config.envLocked')`（单引号）之后，这道门禁 exit 0、
    // 零报错——**它自己犯了它存在的全部理由要防的那个错**：判据建在了缺陷没采取的
    // 那个形态上。模板字面量（反引号）不扫：那种写法通常是动态拼 key，
    // 静态判据本来就管不了，硬扫只会误报。
    for (const quote of ['"', "'"]) {
      const needle = `${quote}${k}${quote}`;
      for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
        const after = /^\s*(.)/.exec(src.slice(i + needle.length));
        if (after && after[1] === ",") continue;
        const line = src.slice(0, i).split("\n").length;
        errors.push(
          `${p.slice(ROOT.length)}:${line} 把带占位符的 key「${k}」当成不带参数的标签用了，`
          + "面板上会出现裸的 {占位符}",
        );
      }
    }
  }
}

for (const w of warnings) console.warn(`[check-i18n] ⚠️ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`[check-i18n] ❌ ${e}`);
  process.exit(1);
}
console.log(
  `[check-i18n] ✅ ${Object.keys(I18N).length} 个 key × ${LANGS.length} 种语言，`
  + `${directlyUsed.size} 处引用，${PLACEHOLDER_KEYS.length} 个带占位符的 key 全都带着参数用，全部对得上`,
);
