/**
 * 去掉源码里的注释再扫。**逐字符扫，而且认得字符串 / 模板字面量 / 正则字面量**——不是一对正则。
 *
 * ⚠️⚠️⚠️ **谁是承重、谁是尽力而为——先读这一句，后面所有建在抠注释上的门禁都靠它分辨该信谁。**
 * **承重的是测试侧那两条全射程不变量**：`tests/unit/source-guards.test.ts` 的
 * 「射程内每个文件：抠注释不许改变程序本身」（拿 Node 内置的真解析器
 * `stripTypeScriptTypes` 全射程对拍，本仓一行解析逻辑都没写）与同一份文件里的
 * 「抠掉的每一段在原文里都必须以斜杠开头」（那一格接的是对拍看不见的那一族）。
 * **本文件里所有 `fail()` 绊线——尤其是 `openerLivesInString()`——都是尽力而为的启发式：
 * 它们红了一定有问题，它们绿了什么都不证明。** 判「这一次抠注释有没有致盲」以那两格为准，
 * **不以本文件抛不抛为准**；本文件的绊线是让人早一步看见落点，不是判据。
 *
 * ⚠️⚠️ **这个文件是本仓「抠注释」的唯一真源。** 它住在 `scripts/lib/` 而不是
 * `tests/helpers/`，是**构建物理决定的，不是偏好**：`scripts/check-i18n.mjs` 是纯 .mjs、
 * 由 `node` 直接跑，它 import 不了 `.ts`，所以真源必须落在两边都 import 得到的那一侧。
 * ⚠️ **但别把这条写成「门禁与测试今天共用一份实现」——那是意图，不是现状**：
 * 今天 `scripts/` 底下**没有任何一个文件** import 它（现场枚举：
 * `grep -rn "strip-comments" scripts/`，只命中真源自己这一份），消费者全在 `tests/` 那一侧。
 * 这个位置是**为将来的门禁留的**：哪天 `check-i18n.mjs` 那一族真要抠注释，它 import 得到，
 * 不必再手写第二份。`tests/helpers/strip-comments.ts` 现在是这个文件的**转导出**，
 * 不是第二份实现。
 *
 * ⚠️ **正则版为什么不行（本仓实测过三次，不是理论）**：正则版是
 * `src.replace(/\/\*[\s\S]*?\*\//g, "")…`，而本仓到处都有
 * `admin.use("/admin/api/*", …)` 这种写法——**字符串字面量里的 `/` 紧跟 `*` 被当成块注释
 * 开头，一路吞到下一个闭合记号**，中间整段代码脱离扫描而门禁照常报绿。
 * · 第一次是在 `probe-guard` 那一格：`src/http/admin/router.ts` 里那行路由
 *   注册把其后 172 行、7852 字节真代码（含 `createProbeGuard()` 与整张路由表）一起吞掉。
 * · 第二次是同一轮的零 IO 门禁：`src/core/admin/config-validate.ts` 里一句 `//` 注释里
 *   写着 `/v1/*`，块注释正则先跑、`//` 挡不住它，56 行 2053 字节真代码脱离扫描。
 * · 第三次是开工勘察：一根这样的毒刺让 fake-dom 平价扫描、i18n 广扫、网络出口扫描
 *   **三道同时变瞎**，而 `pnpm test` 2768/2768 全绿、十二道门禁全部 EXIT=0。
 *
 * ⚠️ **同一次勘察还量到另一族**：用一条不带保护的行注释正则（双斜杠后面吃到行尾）
 * 抠注释的实现会把 `"http://www.w3.org/2000/svg"` 这种**字符串里的双斜杠**当成行注释开头，
 * 把本行其后的代码整段吃掉（`admin-ui/js/ui.js` 与 `admin-ui/js/i18n-dict.js` 各有实例）。
 * 逐字符扫认得「这个 `//` 住在一对引号里」，这一族一并消失。
 *
 * ⚠️⚠️ **第一版逐字符扫本身也栽过一次，读完这一段再改它。** 那一版不认正则字面量，
 * 而**危害远不止「正则里带斜杠星号」**（那一版的「边界明写」只写了这一种，判据就写错了）：
 * · **正则里出现奇数个引号，字符串/代码的奇偶性整个翻过来**。`src/adapters/logger-console.ts`
 *   里 `/[\s="]/` 这条再普通不过的正则就够了：翻过来之后一个真字符串的**内部**被当成代码，
 *   里面的斜杠星号重新变成块注释开头 ⇒ **真代码被吞、静默报绿**。复评实测：射程内
 *   **14 个文件失步、225 段假字符串**；在 `logger-console.ts` 里放一个裸 `console.log`，
 *   负责它的那道门禁报绿、`pnpm test` 2770/2770 全绿。
 * · **`\//`（正则里的转义斜杠紧跟正则结束符）被当成行注释开头，吃到行尾**。
 *   `admin-ui/js/pure/playground.mjs` 的 `/^data:image\//i` 让那一行其后的
 *   `.test(url);` 整段消失，而 `admin-ui/js` 正是四道叶子扫描的射程。
 * 这两族现在都由下面的正则字面量分支认掉，并由 `tests/unit/source-guards.test.ts` 的
 * 「射程内每个文件都扫得完 —— 一个失步都不许有」那一格钉着（那一格会逐文件报出落点）。
 *
 * **边界明写（每一条都由 `tests/unit/source-guards.test.ts` 的探针钉着，不是散文）**：
 * · **认得**：`"…"` / `'…'`（含行尾续行）、模板字面量（含 `${}` 里嵌模板的任意层）、
 *   正则字面量（含字符组里的裸 `/` 与转义 `\/`）、`//` 行注释、块注释、首行 hashbang。
 * · **正则 vs 除法**是真歧义，这里**不假装能完美区分**，用的是「前一个有意义 token」判据。
 *   ⚠️⚠️ **下面这几行是「今天认得的档」，不是闭集，别把它读成全称句、也别再往里写全称句。**
 *   这个文件族已经为「闭集主张」被打脸两次：先是「上一版按单个字符看 `prev`」漏掉后缀运算符，
 *   再是上一轮注释里写下「后缀运算符恰好只有 `++`/`--`/`!` 这三个」——`>` 当场就是第四个
 *  （TS 类型实参表以 `>` 收尾，`x as Array<T> / 2` / `f<number> / 2` / `x satisfies X<Y> / 2`
 *   三种都是合法 TS，三种的 `/` 都是除法，当时三种全判反）。**判据表只许写成开区间**：
 *   认得的这几档照下面走，**其余一律抛**。
 *   · 前面是标点 / 关键字（`return`、`typeof`、`case`…）/ 文件开头 ⇒ 正则位；
 *   · 前面是标识符、数字、`]`、字符串、上一个正则、后缀运算符（`a++` / `a--` /
 *     TS 非空断言 `a!`）⇒ 除法位；
 *   · 前面是 `)` ⇒ 回头看配对的那个 `(` 前面是不是 `if`/`while`/`for`/`with`（是则正则位）；
 *   · 前面是 `>` ⇒ **再看它前面那个字符**：是 `=` 就是箭头 `=>` ⇒ 正则位，否则**抛**
 *    （类型实参表收尾与箭头在这里分不出，宁可吵）；
 *   · 前面是 `}` / 或者不在上面任何一档里 ⇒ **抛**。
 *
 * ⚠️⚠️ **「判不准就吵」拦不住「判错了但很确信」，这是第二轮复评实测打脸的那一条，读完再改判据。**
 *   上一版判据**按单个字符**看前一个 token，而 `+` / `-` / `!` 都在「前缀位 ⇒ 正则开头」那张表里
 *   ⇒ `a++ / 2`、`a-- / 2`、`x! / 2` 这一族**整族被判反**：那个除法号被当成正则开头，
 *   一路吞到同行下一个斜杠（`const K = "/admin/api/*"` 里那个就够了）、把后面的字母当 flag 吃掉，
 *   剩下的 `/*` **重新变成块注释开头**。复评在 `src/ports/logger.ts` 末尾实测：
 *   毒刺前多一行 `const zzPct = zzN++ / zzTotal;`，那个裸 `console.log` 连同它前后的真代码
 *   **静默**脱离扫描、负责它的门禁照常报绿，而**扫描器一个字都没吵**——它很确信。
 *  （复评量到 51 字节；本轮在同一个文件上复量同一形态是 **25 字节**，差在毒刺前那行声明的写法，
 *   方向与后果一模一样。**危害档位一律以复量为准，不抄上一份报告的数字。**）
 *   ⇒ 教训：**认错比认不出危险得多**。所以判对之外还要有**盯后果、不盯符号**的兜底，
 *   因为下一次判反的位置一定不在这张符号表里。
 *
 * ⚠️⚠️ **上一版说自己「加了三条盯后果不盯符号的兜底」，第三轮复评把这句话打成了过度声称，
 *   改判据之前把这一段读完。** 那三条（引擎验正则 / 块注释没闭合 / 模板栈失衡）**意图是对的，
 *   落地仍然在盯符号**——盯 flag 字母、盯 `/*`、盯反引号。复评拿 `>` 那一族做端到端：
 *   在 `src/ports/logger.ts` 末尾追加一行
 *   `const zzHalf = zzF<number> / 2; const ZZ_SEP = "/"; const ZZ_URL = "https://cdn.example/x"; console.log(…);`
 *   ⇒ 符号层漏、后果层三条**一条都没接住**（误判出来的「正则」在 `"/"` 那个斜杠上闭合，
 *   flag 位是空串 ⇒ 引擎认；泄漏出来的是 `//` 行注释 ⇒ 块注释那条不响；模板栈是平的），
 *   那个裸 `console.log` 静默消失、负责它的门禁**当场变绿**。反向控制（同一文件只追加
 *   `console.log(…)` 不加判反那一行）⇒ 那道门禁红。**差别只在判反那一行。**
 *   ⇒ 本轮加的第四条 `openerLivesInString()` 才是真的不盯符号的那一条：它只问
 *   「这个注释开头，按本行引号收支独立重算，是不是住在一个字符串里」。**它的射程与盲区
 *   写在那个函数自己的注释里，一并写了会误伤的形态**——别把它读成万能。
 *
 * · **判不准 / 判错了，一律当场抛，绝不静默按某一种解释走下去**（本仓裁定：认不出要吵）。
 *   会抛的分成两族：
 *   · **判不准**（判据够不着，抛的是「我不知道」）。
 *   · **判错了**（后果层兜底，抛的是「我刚才那一步不可能对」）。
 *   抛出来的消息里**逐字带上原文那一行**，并且**带一个档名**（`err.kind`）。
 *   ⚠️ **别再往这里写「今天会抛的 N 档」，也别在这里抄清单**：本文件族已经为
 *   「把计数写死进注释」漂过四轮，为「把清单抄进散文」漂过一轮。
 *   档名的唯一登记处是本文件的 `FAIL_KINDS`（那是代码，不是散文），探针清单在
 *   `tests/unit/source-guards.test.ts` 的「判不准要吵」那张 `it.each` 表里，
 *   那一格按**运行期收到的 `err.kind`** 与 `FAIL_KINDS` 对集合——
 *   **在这里加一档而不去那张表加一行探针，当场红。**
 *   ⚠️ 哪天真被绊到，请在这里加一档判据，**别把 `try/catch` 加在调用方把它吞掉**。
 * · **不做的事**：它不是解析器。`obj.in / 2` 这类「关键字当属性名」靠「点号前缀 ⇒ 除法位」
 *   挡住；`a?.b` / 类型标注 / 装饰器都只当普通字符搬运。
 *
 * **方言**：JS 与 CSS 的注释语义不同，由 `dialect` 选，**不是各写一份实现**。
 * · `"js"`（默认）—— 行注释 + 块注释 + 正则字面量 + 模板字面量。
 * · `"css"` —— **只认块注释与字符串**。CSS 没有行注释，也没有正则字面量：
 *   `background: url(//cdn.example/x.png)` 里的双斜杠是地址的一部分，
 *   按 JS 语义抠会把那一行其后的样式整段吃掉 ⇒ CSS 侧的扫描当场变瞎。
 *   ⚠️ 这不是假设：收编那一轮第一版把两处 CSS 消费者一起改成了 JS 语义，
 *   复评实测「不许给某一条通道开小灶」那格在违规前面加一个 `url(//…)` 就变绿。
 *
 * **前三个导出共用同一个 `scan()`，只在「注释输出成什么 / 用哪种方言」上分叉：**
 * · `stripComments` —— JS，注释**删掉**。给「按内容扫」的消费者用。
 * · `blankComments` —— JS，注释**逐字符换成空格、换行原样保留**。给「按行号 / 列位置扫」的用。
 * · `stripCssComments` —— CSS，注释**删掉**。
 *
 * **第四个导出 `stripHtmlComments` 走的是另一条路，理由写在它自己的注释里**：
 * HTML 的注释语义与 JS/CSS 都不同，而且 HTML **没有字符串字面量**——正文里一个
 * 撇号（`it's`）在 `scan()` 眼里就是一个没闭合的字符串。它不共用 `scan()`
 * 不是偷懒，是因为共用会当场制造假红；这一条的实测落点见那个函数的注释。
 *
 * ⚠️ **它们不许各写一份**：`tests/ui/api-session.test.ts`「插值捞不齐的那些行今天恰好一处
 *  —— 这道扫描在那一行上是瞎的」那一格底下的 `braceInterpLines()` 全部语义是按行数，
 * 用 `stripComments` 会把块注释里的换行一并删掉、相邻行并成一行 ⇒ 它必须用 `blankComments`。
 * **一个用留空版一个用删除版的话，两份不同实现的扫描器给出不同答案时，绿的那一份会赢。**
 *
 * ⚠️ **为什么不需要 `.d.mts`**（复评实测过，别再补一份声明文件）：`tsconfig.json` 早就为
 * `admin-ui/js/pure/*.mjs` 开了 `allowJs: true`，加上 `moduleResolution: "bundler"` 与
 * 显式 `.mjs` 后缀，`tests/helpers/strip-comments.ts` 转导出这一份**解析得开**，不报 TS7016。
 * **代价是一条真实的耦合，写在这里免得它再次没人知道**：哪天 `admin-ui/js/pure/*.mjs` 全部
 * 转成 `.ts` 而有人顺手关掉 `allowJs`，本文件的转导出会当场 TS7016。
 * 下面每个导出的 `@param {string}` / `@returns {string}` 也是同一条链上的：**没有它们，
 * 参数会被推成 `any`**（`checkJs` 没开，`strict` 管不到未检查的 JS），
 * 于是 `stripComments(123)` 在**每一个**消费者那边一路静默编过——复评实测 `tsc --noEmit` EXIT=0，
 * 补上这四行之后同一条探针立刻 `error TS2345`。
 * ⚠️ **这里刻意不写消费者的个数**：隔壁 `tests/helpers/strip-comments.ts` 的文件头早就定了
 * 这条规矩（那张清单是**该长大**的），而本文件族已经为「把计数写死进散文」漂过六轮——
 * 第六次就是这一句，上一版写的「9 个」实测是 11 个。**数字只许以断言的形式存在。**
 */

/**
 * 前面是这些标点 ⇒ 下一个 `/` 一定是正则字面量开头（它们都不能结束一个表达式）。
 *
 * ⚠️ **`>` 不在这张表里，别再把它加回来。** 它曾经在，理由是箭头函数 `=>` 之后确实是正则位；
 * 而 TS 的类型实参表**也以 `>` 收尾，那个 `>` 结束一个表达式**：`x as Array<T> / 2`、
 * `f<number> / 2`（实例化表达式）、`x satisfies Array<T> / 2` 三种都是合法 TS，三种的 `/`
 * 都是除法，而当时**三种全判反**（第三轮复评实测，`src/ports/logger.ts` 上端到端复现：
 * 判反之后同行的 `"https://…"` 里那个双斜杠变成行注释开头，把裸 `console.log` 一起吞掉，
 * 负责它的门禁照常报绿）。现在 `>` 单独走一档：**前一个字符是 `=` ⇒ 箭头 ⇒ 正则位，否则抛。**
 */
const REGEX_AFTER_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", "/"]);

/** 前面是这些关键字 ⇒ 下一个 `/` 一定是正则字面量开头（同上，它们都不能结束一个表达式）。 */
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

/** `)` 回头看配对的 `(` 前面是不是这几个词：是的话那个 `)` 结束的是控制流头部，不是表达式。 */
const CTRL_HEAD_WORD = new Set(["if", "while", "for", "with"]);

/** 前面是这些标点 ⇒ 下一个 `/` 是除法（它们结束了一个表达式）。 */
const DIVIDE_AFTER_PUNCT = new Set(["]", ".", ")"]);

const VALUE = { kind: "value" };

/**
 * 这个 token 结束了一个表达式吗？——**只给「后缀 `!`」那一档用**。
 *
 * TS 的非空断言 `x!` 与逻辑非 `!x` 是同一个字符，靠**前面那个 token** 分：
 * 前面是一个完整的值（标识符 / `)` / `]` / 字符串 / 上一个正则）⇒ 后缀位，`x! / 2` 是除法；
 * 前面是标点或 `return`/`typeof` 这类关键字 ⇒ 前缀位，`!/x/.test(s)` 里那个 `/` 是正则开头。
 *
 * ⚠️⚠️ **已知判反，而且是致盲方向 —— 这句话上一版写反了，写反了三轮，读完再改。**
 * 上一版写的是「那一支的后果方向是把正则当代码扫，不吞代码，遇到引号/裸斜杠会撞上别的绊线
 * 当场吵，**不是致盲方向**」。**实测为假。**
 *
 * **测法（逐条自己跑得出来，不是抄报告）**：把下面每条喂给 `stripComments()`，
 * 比 `输出.length` 与 `原文.length`，再看 `输出.includes("foo()")`；
 * 另拿 `node:module` 的 `stripTypeScriptTypes(src, { mode: "transform" })` 当裁判，
 * 比 `judge(输出)` 与 `judge(原文)`。**四个触发口全部实测：静默吞码，扫描器一个字不吵。**
 * · `const a = b` ⏎ `!/[/*]/.test(s); foo(); /`+`* 正常注释 *`+`/` ⇒ **吞 31 字节**，`foo()` 没了
 * · `const a = b` ⏎ `!/[//]/.test(s); foo();` ⇒ **吞 20 字节**，`foo()` 没了
 * · `if (c) !/[/*]/.test(y); foo(); …` ⇒ **吞 31 字节**（`)` 那一口：`endsExpression()`
 *   对 `closeParen` 一律返回真，连控制流头部的 `)` 也算，于是行首那个 `!` 被当成非空断言）
 * · `arr[0]` ⏎ `!/[/*]/.test(s); foo(); …` ⇒ **吞 31 字节**（`]` 那一口）
 * 机理：判成除法之后正则体被当代码扫，体里的 `[/*]` / `[//]`（字符组里的裸斜杠，**合法正则**）
 * 直接变成块注释 / 行注释开头。四条后果层兜底一条都不响（`openerLivesInString()` 也不响：
 * 那几行一个引号都没有，重算说「不在字符串里」，它说的是实话）。**只有那个独立裁判会红。**
 * ⇒ 触发口至少四个（ASI 后跟值 / `closeParen`（含控制流头部）/ `]` / 以及任何
 * `endsExpression()` 返回真的新形态），上一版只登记了「ASI 断句」一个。
 * 射程内这种写法今天 **0 处**（测法：拿一份带计数的真源副本跑全射程 259 个文件，
 * 数 `!` 后缀档在「后面紧跟 `/`」时的命中数）。**危害档位：高；今天的入口数：零。**
 * 这一条写成断言在 `tests/unit/source-guards.test.ts` 的「已知判反」那一格里。
 * @param {{kind: string, ch?: string, word?: string}|null} p
 * @returns {boolean}
 */
function endsExpression(p) {
  if (p === null) return false;
  if (p.kind === "value" || p.kind === "closeParen") return true;
  if (p.kind === "word") return !REGEX_AFTER_WORD.has(p.word);
  if (p.kind === "punct") return DIVIDE_AFTER_PUNCT.has(p.ch);
  return false;
}

/**
 * **每一个抛出点的档名。加一档就必须在这里登记一个新名字，否则 `fail()` 当场拒绝。**
 *
 * 这张表是给 `tests/unit/source-guards.test.ts` 用的**运行期**凭据，不是散文计数：
 * 那边的探针表逐条把抛出来的 `err.kind` 收上去，要求「收到的档集合 == 这张表」
 * 且「表长 == 探针行数」。⇒ 往真源加一档而不加探针 ⇒ 那一档没人验过 ⇒ 当场红。
 * ⚠️ **上一版数的是真源里 `fail(src, ` 这串字面文本**，复评实测：把逗号后的空格删掉、
 * 或者把参数换行写，两条新绊线可以**干净逃逸**（守卫数到 7、真实 9、87 格全绿）；
 * 反过来在注释里写出那串字面文本会**假红**。计数从此只走运行期，不数文本。
 *
 * ⚠️⚠️ **只走运行期还剩一个洞，第四轮复评把它打了出来：新的可达抛出点只要
 * **复用一个已经登记过的档名**，运行期那一格收到的集合不变 ⇒ 全绿放行（复评实测
 * 103/103）。** 所以现在多一格结构守卫：`tests/unit/source-guards.test.ts` 的
 * 「真源里每个 fail() 调用点的档名互不重复，并集恰好是 FAIL_KINDS」——
 * 它先拿本文件自己的 `blankComments()` 把注释抠掉（⇒ 散文里怎么写都不算数），
 * 再逐个 `fail(` 调用点取**第一个字符串字面量**当档名。
 * ⇒ **本文件的一条硬规矩：`fail()` 的档名必须写成调用点里的第一个字符串字面量。**
 * 用变量传、或者把 `why` 写到档名前面，那一格会**红**（不是漏），这是刻意的。
 * ⚠️ 它与运行期那一格是**两把不同的锁**，别合并：运行期那格管「每一档有没有人验过」，
 * 这一格管「有没有两个调用点挤在同一档名底下」。
 */
export const FAIL_KINDS = Object.freeze([
  "angleAfterValue",
  "braceSlash",
  "unknownPunct",
  "unclosedString",
  "unclosedRegex",
  "badRegex",
  "unclosedBlock",
  "tmplUnbalanced",
  "openerInString",
  "unclosedHtmlComment",
]);

/**
 * 判不准就抛，消息里逐字带上原文那一行。**这是本仓裁定的「认不出要吵」**：
 * 静默地按某一种解释走下去，代价是真代码被吞而门禁照常报绿。
 * @param {string} src
 * @param {number} pos
 * @param {string} kind 抛出档名，必须在 `FAIL_KINDS` 里
 * @param {string} why
 * @returns {never}
 */
function fail(src, pos, kind, why) {
  if (!FAIL_KINDS.includes(kind)) {
    throw new Error(`[strip-comments] 内部错误：抛出档 \`${kind}\` 没有登记进 FAIL_KINDS`);
  }
  const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
  const nl = src.indexOf("\n", pos);
  const lineEnd = nl === -1 ? src.length : nl;
  const line = src.slice(0, pos).split("\n").length;
  const err = new Error(
    `[strip-comments] ${why}（第 ${line} 行第 ${pos - lineStart + 1} 列）\n`
    + `  原文：${src.slice(lineStart, lineEnd)}`,
  );
  // 档名跟着异常走：调用方不必解析报文，测试端也不必数文本。
  Object.defineProperty(err, "kind", { value: kind, enumerable: true });
  throw err;
}

/**
 * **尽力而为的一条概率防线：这一段注释的开头，按本行的双引号收支独立重算，住不住在字符串里？**
 *
 * ⚠️⚠️⚠️ **它不是不变量，别把它当门。第四轮复评把这件事量死了，改它之前读完这一段。**
 * 它开不开口，取决于**本行双引号的奇偶**——而这个量**与「哪个斜杠被判反了」毫无关系**。
 * 复评用一个撇号就证明了反面：在 `src/ports/logger.ts` 上追加那条判反的探针行
 *（`const of = 4; const half = of / 2; const P = "/"; const U = "https://x"; console.log(…);`）
 * 时它当场红、负责裸 `console` 的门禁从绿变红；**同一行只多一个** `` const T = `it's`; ``
 * ⇒ 它**一个字都不吵**，那个裸 `console.log` 静默被吞、门禁重新报绿，
 * **只有测试侧那两条全射程不变量红**（见本文件头「谁是承重」那一段）。
 * ⇒ **一条会闭嘴的防线，在闭嘴的那一刻等于不存在。** 它的价值是「红的时候能逐字指出落点」，
 * 不是「绿的时候能证明没事」。
 *
 * **重算的方式与主判据完全无关**：只按双引号收支扫本行（反斜杠转义照算），
 * 不认正则、不认除法、不认注释——也就是说，**主扫描器判反的那个符号，这里根本没有对应的分支**。
 * ⇒ 一个谁都没想到的新形态，只要它的后果是「注释开头落进了一个双引号字符串、
 * 而且本行双引号恰好配平、而且本行没有反引号」，这里就会红。**那三个「而且」就是它的全部边界。**
 *
 * ⚠️ **本轮为什么把单引号与含反引号的行整个摘出去（第四轮复评实测的三类假红）**：
 * 上一版把 `'` 也算成引号、也不看反引号，于是**下面三类完全合法的代码当场假红**——
 * · 注释文本里的撇号：`const a = 1; /` + `* don't *` + `/ const b = 2; // it's ok`；
 * · 模板串里的撇号或双引号：`` const a = `it's`; /` + `* c *` + `/ const b = `don't`; ``；
 * · CSS 同款（`stripCssComments` 走同一条防线）：`a { color: red } /` + `* don't *` + `/ …`。
 * 复评在 `src/ports/logger.ts` 上追加**一行完全合法的 TS** 就让三格门禁一起假红，
 * 而报文写着「上游某个斜杠判反了」——**指向一个根本不存在的判反**。
 *（本轮在同一个落点上逐字复跑同一行，那三格全绿；反向控制：同一个落点换成真判反的那一行，
 * 负责裸 `console` 的门禁与两条全射程不变量一起红。）
 * **在门禁里跑的东西，对合法代码假红比漏报更坏**：它会逼后面的人加豁免，而豁免会变成永久的洞。
 * ⇒ 判据收成两条：**只数双引号**（英文撇号与单引号字符串同形，分不出）、
 * **本行只要出现反引号就闭嘴**（模板串里的引号不该参与本行的收支）。
 * 代价是**两类真阳性看不见了，登记在案**：毒刺是单引号字符串时看不见；毒刺所在行上有模板串时看不见。
 *
 * ⚠️ **它的射程与盲区，每一条都是断言不是散文**：漏报那几条在
 * `tests/unit/source-guards.test.ts` 的「已知漏报」那张表里（连吞掉的字节数一起写死），
 * 误伤那一族在同一份文件的「已知误伤：两条各含奇数个双引号的正则夹着一段注释 ⇒ 独立重算会假红」那一格。
 * · ✅ 接得住：注释开头落进**双引号**字符串（`"https://…"` 这种毒刺遍地都是），
 *   与「是哪个符号判反的」无关——`>` 那一族、`of` 当标识符那一族都实测会红
 *  （探针在「判不准要吵」那张表的 `openerInString` 那一行）。
 * · ❌ 接不住（**四条，都是静默漏报**）：本行双引号数为奇数（没结论）；本行有反引号（不开口）；
 *   毒刺是单引号字符串（不数）；注释开头落进的是**正则字符组**而不是字符串
 *  （`!/[/*]/` 那一族，全行一个引号都没有 ⇒ 重算说「不在字符串里」，它说的是实话）。
 * · ❌ **还会「确信地答错」，不只是「没结论」**：本行双引号总数为偶数、但奇偶被
 *   「不住在字符串里的引号」整体错位一格时（例：同一行前后各一条 `/"/` 正则夹着那段代码），
 *   重算会**确信地回答「不在字符串里」**而其实它就在 `"https://x"` 的肚子里 ⇒ 静默吞码。
 *   **这一类比「没结论」危险，所以单独登记**（本文件族自己的纪律：认错比认不出危险得多）。
 * · ⚠️ 仍然会误伤的那一族：同一行上两条各含**奇数个双引号**的正则夹着一段注释
 *  （`/["]/ … 注释 … /["]/`），重算把两条正则里的引号配成一对 ⇒ **假红**。
 *   射程 259 个文件实测 0 例；真撞上时它是一声响亮的抛，不是静默，改法是把那一行拆开写。
 * @param {string} src
 * @param {number} start 注释开头（那个 `/`）在 `src` 里的下标
 * @returns {boolean} 真 = 重算有结论、且这个开头落在一个双引号字符串里
 */
function openerLivesInString(src, start) {
  const lineStart = src.lastIndexOf("\n", start - 1) + 1;
  const nl = src.indexOf("\n", start);
  const lineEnd = nl === -1 ? src.length : nl;
  // 本行只要有反引号 ⇒ 模板串里的引号会把收支算歪（合法代码当场假红）⇒ 闭嘴。
  for (let k = lineStart; k < lineEnd; k += 1) {
    if (src[k] === "`") return false;
  }
  let quoted = false;
  let escaped = false;
  let insideAtStart = false;
  for (let k = lineStart; k < lineEnd; k += 1) {
    if (k === start) insideAtStart = quoted;
    const ch = src[k];
    if (!quoted) {
      // **只数双引号**：`'` 在英文里同时是撇号（`don't` / `it's`），注释文本与模板串里遍地都是。
      if (ch === '"') quoted = true;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') quoted = false;
  }
  // 本行双引号没收支平衡 ⇒ 这次重算没有结论，闭嘴。
  if (quoted) return false;
  return insideAtStart;
}

/**
 * 抠掉一段注释之前先过这一关：独立重算说这个开头住在双引号字符串里 ⇒ 当场抛。
 * @param {string} src
 * @param {number} start
 * @returns {void}
 */
function guardOpener(src, start) {
  if (!openerLivesInString(src, start)) return;
  fail(src, start, "openerInString",
    "这里被判成一段注释的开头，但按本行的双引号收支独立重算，这个开头其实住在一个字符串里 "
    + "⇒ **最常见的成因**是上游某个斜杠判反了（判成正则/除法之后错位一格，"
    + "字符串里的双斜杠或斜杠星号就变成了注释开头），"
    + "而那一支会静默吞掉真代码：长度/行数/引擎验那几条一条都不会红。"
    + "⚠️ **但这一档是一条尽力而为的概率防线，不是不变量**：它也有已登记的误伤形态"
    + "（同一行上两条各含奇数个双引号的正则夹着一段注释）。"
    + "如果你确认这一行本身合法、上游也没有判反，那就是撞上了那一族误伤——"
    + "把那一行拆开写，并去 `scripts/lib/strip-comments.mjs` 的 `openerLivesInString()` 把形态登记上去");
}

/**
 * 逐字符扫一遍源码，把注释交给 `onComment` 决定输出成什么，其余原样搬运。
 *
 * **字符串 / 模板字面量 / 正则字面量整段原样搬运**：里面的斜杠星号不是注释，
 * 里面的双斜杠也不是。这一条就是整个文件存在的理由。
 *
 * @param {string} src
 * @param {(text: string) => string} onComment
 * @param {"js" | "css"} dialect
 * @returns {string}
 */
function scan(src, onComment, dialect) {
  const js = dialect !== "css";
  const n = src.length;
  let out = "";
  let i = 0;

  // 首行 hashbang（`scripts/*.mjs` 有七个）：按语法它整行都不是代码，原样搬运。
  if (js && src.startsWith("#!")) {
    const nl = src.indexOf("\n");
    const end = nl === -1 ? n : nl;
    out += src.slice(0, end);
    i = end;
  }

  /** 模板串上下文栈：`{kind:"tmpl"}` = 模板文本；`{kind:"interp"}` = `${}` 里的代码。 */
  const stack = [];
  /** 当前代码上下文的判据状态。模板插值里另起一份，退出时还原。 */
  let ctx = { prev: null, parens: [] };

  /** 这个 `/` 是正则字面量开头吗？判不准就抛。 */
  const regexAllowed = (pos) => {
    const p = ctx.prev;
    if (p === null) return true;
    if (p.kind === "value") return false;
    // 后缀运算符结束了一个表达式 ⇒ 除法位。`++`/`--` 不分前缀后缀都走这里：前缀 `++`
    // 后面必须跟一个可赋值的操作数，而正则字面量不是 ⇒ 紧跟它的 `/` 只可能是除法。
    if (p.kind === "postfix") return false;
    if (p.kind === "word") return REGEX_AFTER_WORD.has(p.word);
    if (p.kind === "closeParen") return p.head;
    // 箭头 `=>` 的那个 `>`：右边是函数体 ⇒ 正则位（`() => /re/.test(x)` 仓里到处都是）。
    if (p.kind === "arrow") return true;
    if (p.kind === "angle") {
      fail(src, pos, "angleAfterValue",
        "判不准这个斜杠是正则字面量开头还是除法：前一个有意义字符是 `>` 而它不是箭头 `=>` 的一半。"
        + "TS 的类型实参表也以 `>` 收尾（`x as Array<T> / 2` / `f<number> / 2` / "
        + "`x satisfies Array<T> / 2`），那个 `>` **结束一个表达式** ⇒ 除法位；"
        + "而箭头之后是正则位。两者在这里分不出，请加一对括号或把类型实参写进一个变量");
    }
    if (p.kind === "closeBrace") {
      fail(src, pos, "braceSlash", "判不准这个斜杠是正则字面量开头还是除法：前一个有意义字符是 `}`，"
        + "块结束是正则位、对象字面量结束是除法位。请给它加一对括号或一个分号把歧义写没");
    }
    if (REGEX_AFTER_PUNCT.has(p.ch)) return true;
    if (DIVIDE_AFTER_PUNCT.has(p.ch)) return false;
    return fail(src, pos, "unknownPunct", `判不准这个斜杠是正则字面量开头还是除法：前一个有意义字符是 \`${p.ch}\`，`
      + "它不在真源的两张判据表里。请在 `REGEX_AFTER_PUNCT` / `DIVIDE_AFTER_PUNCT` 里给它定一个位置");
  };

  while (i < n) {
    const top = stack[stack.length - 1];

    // ── 模板文本（不是代码，整段原样搬运，只认 `${` 与结束反引号） ──────────
    if (top !== undefined && top.kind === "tmpl") {
      const c = src[i];
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === "`") {
        out += c; i += 1;
        stack.pop();
        ctx = top.saved;
        ctx.prev = VALUE;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        out += "${"; i += 2;
        stack.push({ kind: "interp", brace: 0 });
        ctx = { prev: null, parens: [] };
        continue;
      }
      out += c; i += 1;
      continue;
    }

    const c = src[i];

    // ── 字符串字面量 ──────────────────────────────────────────────────────
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      out += c; i += 1;
      let closed = false;
      while (i < n) {
        const d = src[i];
        // 行尾续行（`"abc\` + 换行）是合法的，转义分支照单全收。
        if (d === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        if (d === "\n") break;
        out += d; i += 1;
        if (d === quote) { closed = true; break; }
      }
      if (!closed) {
        // 报文按方言分叉：CSS 这一档压根没有正则字面量，把「上游某条正则」写进 CSS 的报文
        // 等于给下一个人指一条不存在的路。
        fail(src, start, "unclosedString", "单双引号字符串没有在本行内闭合 ⇒ 扫描器已经失步。"
          + (js
            ? "最常见的成因是上游某个正则字面量里带了奇数个引号而扫描器没认出它——"
              + "那会让字符串/代码的奇偶性整个翻过来，之后真代码会被当成注释吞掉"
            : "CSS 里的字符串不许含裸换行，最常见的成因是上游某段块注释没闭合、"
              + "或者这份样式表本身就坏了"));
      }
      ctx.prev = VALUE;
      continue;
    }

    // ── 模板字面量 ────────────────────────────────────────────────────────
    if (js && c === "`") {
      out += c; i += 1;
      stack.push({ kind: "tmpl", saved: ctx });
      continue;
    }

    // ── 行注释（CSS 没有这一档） ──────────────────────────────────────────
    if (js && c === "/" && src[i + 1] === "/") {
      guardOpener(src, i);
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      out += onComment(src.slice(i, j));
      i = j;
      continue;
    }

    // ── 块注释（两种方言都有） ────────────────────────────────────────────
    if (c === "/" && src[i + 1] === "*") {
      guardOpener(src, i);
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      if (j === n) {
        // **后果层兜底**：没有闭合记号的块注释一路吞到文件尾。这既可能是源码本身坏了，
        // 更可能是上游某个 `/` 判反了——判成正则、把同行下一个斜杠当结束符、
        // 剩下的 `/*` 重开一个块注释。那一支**长度与行数两条不变量全过**（换等长空格、
        // 换行原样留着），静默吞掉真代码，所以必须在这里吵。
        fail(src, i, "unclosedBlock", "块注释开了但没有闭合记号，一路吞到文件尾 ⇒ 要么这份源码坏了，"
          + "要么上游某个斜杠被判反了（判成正则之后剩下的 `/*` 会重开一个块注释）。"
          + "**这一族是致盲方向**：吞掉的是真代码而长度/行数不变量一条都不会红");
      }
      j = Math.min(j + 2, n);
      out += onComment(src.slice(i, j));
      i = j;
      continue;
    }

    // ── 正则字面量 / 除法（CSS 没有正则，`/` 一律当普通字符） ──────────────
    if (js && c === "/") {
      if (!regexAllowed(i)) {
        out += c; i += 1;
        ctx.prev = { kind: "punct", ch: "/" };
        continue;
      }
      const start = i;
      out += c; i += 1;
      let inClass = false;
      let closed = false;
      while (i < n) {
        const d = src[i];
        if (d === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        if (d === "\n") break;
        out += d; i += 1;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { closed = true; break; }
      }
      if (!closed) {
        fail(src, start, "unclosedRegex", "正则字面量没有在本行内闭合 ⇒ 判据把一个除法号当成了正则开头，"
          + "或者这里真有一处跨行的正则。两种都要人来看，不许静默吞下去");
      }
      const body = src.slice(start + 1, i - 1);
      const flagStart = i;
      while (i < n && /[a-z]/i.test(src[i])) { out += src[i]; i += 1; }
      const flags = src.slice(flagStart, i);
      // **后果层兜底，这一条盯的不是符号而是后果**：判成正则之后，交给引擎自己验一遍。
      // 判反一个除法的典型现场是 `n++ / 2; const K = "/admin/api/*";` —— 误判出来的
      // 「正则」在 `"/admin` 那个斜杠上闭合，`admin` 被当成 flag，而 `admin` 不是合法 flag
      // ⇒ 引擎当场不认。用引擎当裁判，比在这里列举「还有哪些符号会判反」可靠得多。
      try {
        new RegExp(body, flags);
      } catch (e) {
        fail(src, start, "badRegex", "这个斜杠被判成了正则字面量开头，但引擎不认它是一条正则"
          + `（${(e instanceof Error ? e.message : String(e))}）⇒ 判据判反了，这里多半是一个除法。`
          + "**这一档拦的是「判错了但很确信」**，不是「判不准」：判错不会自己吵，"
          + "它会安安静静把真代码当注释吞掉");
      }
      ctx.prev = VALUE;
      continue;
    }

    // ── 括号：`)` 的正则/除法判据要回头看配对的 `(` 前面那个词 ──────────────
    if (c === "(") {
      ctx.parens.push(ctx.prev);
      out += c; i += 1;
      ctx.prev = { kind: "punct", ch: "(" };
      continue;
    }
    if (c === ")") {
      const opener = ctx.parens.pop();
      out += c; i += 1;
      ctx.prev = {
        kind: "closeParen",
        head: opener !== undefined && opener !== null && opener.kind === "word" && CTRL_HEAD_WORD.has(opener.word),
      };
      continue;
    }

    // ── 花括号：`}` 可能结束模板插值 ──────────────────────────────────────
    if (c === "{") {
      if (top !== undefined && top.kind === "interp") top.brace += 1;
      out += c; i += 1;
      ctx.prev = { kind: "punct", ch: "{" };
      continue;
    }
    if (c === "}") {
      if (top !== undefined && top.kind === "interp") {
        if (top.brace === 0) {
          out += c; i += 1;
          stack.pop();
          continue;
        }
        top.brace -= 1;
      }
      out += c; i += 1;
      ctx.prev = { kind: "closeBrace" };
      continue;
    }

    // ── `>`：箭头的一半，还是类型实参表的收尾？ ────────────────────────────
    // 前一个字符是 `=` ⇒ 这是箭头 `=>` ⇒ 右边是函数体 ⇒ 正则位。
    // 否则**判不准**（`x as Array<T> / 2` 是除法、`() => /re/` 是正则）⇒ 记成 `angle`，
    // 真的碰到 `/` 时在 `regexAllowed()` 里抛。**别把 `>` 塞回 `REGEX_AFTER_PUNCT`。**
    if (js && c === ">") {
      out += c; i += 1;
      ctx.prev = src[i - 2] === "=" ? { kind: "arrow" } : { kind: "angle" };
      continue;
    }

    // ── 后缀运算符：`a++` / `a--` / TS 非空断言 `a!` ────────────────────────
    // **它们结束一个表达式 ⇒ 紧跟的 `/` 是除法。** 上一版按单个字符记 `prev`，
    // 而 `+`/`-`/`!` 都在「前缀位 ⇒ 正则开头」那张表里，于是这一族被整族判反（文件头 ⚠️⚠️）。
    if (js && (c === "+" || c === "-") && src[i + 1] === c) {
      out += src.slice(i, i + 2); i += 2;
      ctx.prev = { kind: "postfix", ch: c + c };
      continue;
    }
    // `!==` / `!=` 里的 `!` 是比较运算符，不是断言 ⇒ 让它走下面的通用标点分支（正则位）。
    if (js && c === "!" && src[i + 1] !== "=" && endsExpression(ctx.prev)) {
      out += c; i += 1;
      ctx.prev = { kind: "postfix", ch: "!" };
      continue;
    }

    // ── 标识符 / 数字：整段吃掉，好让「前一个词是不是关键字」问得出来 ──────
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      out += word;
      // `obj.in` 里的 `in` 是属性名不是关键字 ⇒ 点号前缀一律当值。
      ctx.prev = src[i - 1] === "." ? VALUE : { kind: "word", word };
      i = j;
      continue;
    }

    out += c; i += 1;
    if (!/\s/.test(c)) ctx.prev = { kind: "punct", ch: c };
  }
  // **后果层兜底**：模板串上下文栈扫到文件尾还没平衡 ⇒ 扫描器在某处失步了
  // （反引号没配对 / `${` 没闭合 / 插值里的花括号多了一个）。这是一个免费且确定的信号，
  // 上一版没查它：失衡时模板文本与插值都在「原样搬运」那一支，注释会泄漏出来（多报方向），
  // 不吞代码但也不吵。**免费的失步信号不许浪费。**
  if (stack.length !== 0) {
    fail(src, n, "tmplUnbalanced", "扫到文件尾时模板字面量的上下文栈还没平衡 ⇒ 扫描器已经失步"
      + "（反引号没配对、`${` 没闭合、或者插值里的花括号数不平）");
  }
  return out;
}

/**
 * JS：注释删掉。
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  return scan(src, () => "", "js");
}

/**
 * JS：注释逐字符换成空格，**换行原样保留** ⇒ 行号与列位置不变。
 * @param {string} src
 * @returns {string}
 */
export function blankComments(src) {
  return scan(src, (text) => text.replace(/[^\n]/g, " "), "js");
}

/**
 * CSS：注释删掉。**只认块注释**——CSS 没有 `//` 行注释，`url(//cdn…)` 里的双斜杠是地址。
 * @param {string} src
 * @returns {string}
 */
export function stripCssComments(src) {
  return scan(src, () => "", "css");
}

/**
 * HTML：注释（`<!-- … -->`）删掉。**不走 `scan()`。**
 *
 * ⚠️⚠️ **为什么不共用 `scan()`——这一条是实测出来的，别去"统一"它。**
 * 把 `admin-ui/index.html` 喂给 `stripComments()`（JS 方言）会当场抛
 * `unclosedRegex`：`<title>agnes2api 管理后台</title>` 里 `</title>` 的那个 `/`，
 * 前一个有意义字符是 `<`（在 `REGEX_AFTER_PUNCT` 里）⇒ 被判成正则字面量开头，
 * 本行内找不到闭合。喂给 `stripCssComments()`（CSS 方言）则相反：HTML 里没有
 * CSS 那种块注释记号，那一支几乎是恒等变换，**注释一个都抠不掉而且一声不吭**——
 * 这正是本仓那条「判据用错工具时不会报错，会静静地放行」。
 * 更根本的是 **HTML 没有字符串字面量**：正文里的撇号（`it's`）、属性值里的引号，
 * 在 `scan()` 的字符串分支里都会被当成字面量开头，轻则失步重则假红。
 *
 * **判据**：逐字符扫，遇到 `<!--` 就一路吃到这段注释的闭合处。**闭合形态按 HTML5 认**，
 * 由 `tests/unit/source-guards.test.ts` 的
 * 「stripHtmlComments 逐形态认 HTML5 的闭合注释，一条都不许被当成未闭合」那一格钉着：
 * · `-->`；
 * · `--!>`（HTML5 的 incorrectly-closed-comment：是 parse error，但注释**闭合**）；
 * · `<!-->` 与 `<!--->`（HTML5 的 abrupt-closing-of-empty-comment：**闭合的空注释**）。
 *
 * ⚠️⚠️ **吃到文件尾都没闭合 ⇒ 当场抛，不许静默返回半份结果。**
 * 上一版在这里**不抛**，理由写的是「吃到文件尾是 HTML5 的规定行为」。那句话有两处错：
 * 它把「浏览器怎么解析」与「一个扫描器该不该表态」混成了一件事；而且**它自己就偏离了
 * HTML5**——上面那两种同形闭合（`<!-->` / `<!--->`）在规范里是闭合的空注释，上一版
 * 把它们当成未闭合、一路吃到文件尾，**偏离的方向恰恰是静默**。
 * 一次复评在 `admin-ui/index.html` 上把代价量死了：删掉第 8 行那个 `-->`，
 * i18n 门禁（`scripts/check-i18n.mjs`）的引用数从 496 掉到 480 —— 整份文件尾的
 * `data-i18n=` 全部消失 —— 而门禁**打着 ✅ 横幅、exit 0**。后来把「未被引用」
 * 升成硬错之后，同一个漏写的 `-->` 会把一批活着的 key 报成死 key。
 * ⇒ 按本仓裁定办：**认不出要吵**。代价也认下来写在这里：一份注释真的没闭合的 HTML
 * 会让门禁红，而浏览器会把文件尾当注释、照常渲染前面的部分。**静默吞掉半份文件更贵。**
 *
 * **边界明写（由 `tests/unit/source-guards.test.ts` 的
 * 「stripHtmlComments 的两条已知边界」那两格钉着，不是散文）**：
 * · **属性值里的 `<!--` 会被误当成注释开头**（`<div title="<!-- x -->">` 在 HTML
 *   规范里是纯文本）。要认出它得跟标签状态机，那已经是半个解析器了。
 *   ⚠️ 这一条与上面那条抛叠在一起时的表现：属性值里出现一个**没有闭合记号**的 `<!--`
 *   ⇒ 现在是**抛**，不再是静默吃到文件尾。方向是吵，不是哑。
 * · **内联 `<script>` / `<style>` 里的 JS/CSS 注释抠不掉**——那一段的注释语法是
 *   JS/CSS 的，本函数只认 `<!-- -->`。⚠️ 这一条**不是靠人记得**：
 *   `scripts/check-i18n.mjs` 里「HTML 里出现内联脚本 / 样式」那条判据会在
 *   内联内容出现的第一时间把那道门禁打红，逼人回到这里表态。
 *
 * @param {string} src
 * @returns {string}
 */
export function stripHtmlComments(src) {
  return scanHtml(src, () => "");
}

/**
 * HTML：注释（`<!-- … -->`）逐字符换成空格，**换行原样保留** ⇒ 行号与列位置不变。
 *
 * 与 `blankComments`（JS 那一支）是同一条理由：**判据要报 `文件:行号`**，
 * 而删掉注释会让后面每一行的行号整体前移，报出来的位置指向别人。
 * 评审发现 19 就死在这上面：三个文档判官一处都没剥 HTML 注释，
 * 把一行 `> 📖 详细面板文档：…` 整行包进 `<!-- -->`，GitHub 上那条入口消失，
 * 而 764 格全绿。
 *
 * ⚠️ **与 `stripHtmlComments` 共用同一个扫描器 `scanHtml`**，不是第二份实现。
 * @param {string} src
 * @returns {string}
 */
export function blankHtmlComments(src) {
  return scanHtml(src, (text) => text.replace(/[^\n]/g, " "));
}

/**
 * `stripHtmlComments` / `blankHtmlComments` 共用的那一遍扫描。
 * @param {string} src
 * @param {(text: string) => string} replace 一段注释（含 `<!--`/`-->` 记号）换成什么
 * @returns {string}
 */
function scanHtml(src, replace) {
  const n = src.length;
  let out = "";
  let i = 0;
  while (i < n) {
    if (src.startsWith("<!--", i)) {
      const end = htmlCommentEnd(src, i);
      if (end === -1) {
        fail(src, i, "unclosedHtmlComment",
          "HTML 注释开了没有闭合记号（`-->` / `--!>`），一路到文件尾 "
          + "⇒ 再抠下去等于把从这里到文件尾的内容整段静默吞掉，"
          + "而调用方拿到的是一份看起来正常的半截源码（复评实测：`admin-ui/index.html` "
          + "少一个 `-->`，`scripts/check-i18n.mjs` 这道门禁的引用数掉了一大截、横幅照打 ✅、exit 0）。"
          + "⚠️ 如果这个 `<!--` 其实住在一个属性值里（`<div title=\"<!-- x -->\">`，"
          + "按 HTML 规范是纯文本），那是本函数已登记的那条边界撞上了这条抛 —— "
          + "把那段文本改写掉，或者去 `scripts/lib/strip-comments.mjs` 的 `stripHtmlComments` 扩判据");
      }
      out += replace(src.slice(i, end));
      i = end;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/**
 * 一段 `<!--` 注释的闭合处（返回闭合记号**之后**的下标），没闭合返回 `-1`。
 *
 * **三种闭合形态都按 HTML5 认**，理由与实测代价写在 `stripHtmlComments` 的注释里：
 * 空注释同形（`<!-->` / `<!--->`）先判，因为它们的 `>` 落在 `<!--` 紧后面、
 * 够不到下面那个 `--` 的配对；`--!>` 走 `!` 那一格（规范里是 comment end bang state）。
 * @param {string} src
 * @param {number} start `<!--` 里那个 `<` 的下标
 * @returns {number}
 */
function htmlCommentEnd(src, start) {
  const n = src.length;
  // HTML5 abrupt-closing-of-empty-comment：`<!-->` 与 `<!--->` 都是**闭合的空注释**。
  if (src[start + 4] === ">") return start + 5;
  if (src[start + 4] === "-" && src[start + 5] === ">") return start + 6;
  for (let i = start + 4; i + 1 < n; i += 1) {
    if (src[i] !== "-" || src[i + 1] !== "-") continue;
    let j = i + 2;
    if (src[j] === "!") j += 1;
    if (src[j] === ">") return j + 1;
  }
  return -1;
}
