/**
 * 去掉源码里的注释再扫。**逐字符扫，而且认得字符串 / 模板字面量 / 正则字面量**——不是一对正则。
 *
 * ⚠️⚠️ **这个文件是本仓「抠注释」的唯一真源。** 它住在 `scripts/lib/` 而不是
 * `tests/helpers/`，是**构建物理决定的，不是偏好**：`scripts/check-i18n.mjs` 是纯 .mjs、
 * 由 `node` 直接跑，它 import 不了 `.ts`。让门禁与测试共用一份实现是这次收编的全部意义，
 * 所以真源必须落在两边都 import 得到的那一侧。`tests/helpers/strip-comments.ts`
 * 现在是这个文件的**转导出**，不是第二份实现。
 *
 * ⚠️ **正则版为什么不行（本仓实测过三次，不是理论）**：正则版是
 * `src.replace(/\/\*[\s\S]*?\*\//g, "")…`，而本仓到处都有
 * `admin.use("/admin/api/*", …)` 这种写法——**字符串字面量里的 `/` 紧跟 `*` 被当成块注释
 * 开头，一路吞到下一个闭合记号**，中间整段代码脱离扫描而门禁照常报绿。
 * · 第一次是 P3d Task 8（`probe-guard` 那格）：`src/http/admin/router.ts` 里那行路由
 *   注册把其后 172 行、7852 字节真代码（含 `createProbeGuard()` 与整张路由表）一起吞掉。
 * · 第二次是同一轮的零 IO 门禁：`src/core/admin/config-validate.ts` 里一句 `//` 注释里
 *   写着 `/v1/*`，块注释正则先跑、`//` 挡不住它，56 行 2053 字节真代码脱离扫描。
 * · 第三次是 P3e 开工勘察：一根这样的毒刺让 fake-dom 平价扫描、i18n 广扫、网络出口扫描
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
 * · **正则 vs 除法**是真歧义，这里**不假装能完美区分**，用的是「前一个有意义 token」判据：
 *   前面是标点 / 关键字（`return`、`typeof`、`case`…）/ 文件开头 ⇒ 正则位；
 *   前面是标识符、数字、`]`、字符串、上一个正则、**后缀运算符**（`a++` / `a--` /
 *   TS 非空断言 `a!`）⇒ 除法位；
 *   前面是 `)` ⇒ 回头看配对的那个 `(` 前面是不是 `if`/`while`/`for`/`with`（是则正则位）。
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
 *   ⇒ 教训：**认错比认不出危险得多**。所以这一版除了把这一族判对（后缀位单独记），
 *   还加了三条**盯后果、不盯符号**的兜底（见下一条），因为下一次判反的位置一定不在这张符号表里。
 *
 * · **判不准 / 判错了，一律当场抛，绝不静默按某一种解释走下去**（本仓裁定：认不出要吵）。
 *   今天会抛的分成两族：
 *   · **判不准**（判据够不着，抛的是「我不知道」）：单双引号字符串在本行内没闭合
 *    （⇒ 扫描器已失步）、正则字面量在本行内没闭合、`}` 后面的裸 `/`（块结束是正则位、
 *     对象字面量结束是除法位，分不出）、前一个有意义字符不在上面任何一档里的裸 `/`。
 *   · **判错了**（后果层兜底，抛的是「我刚才那一步不可能对」）：判成正则之后
 *     **引擎不认这条正则**（`new RegExp` 当场验，flag 是 `admin` 这种就当场露馅）、
 *     块注释开了**没有闭合**一路吞到文件尾、扫到文件尾**模板栈还没平衡**。
 *     这三条覆盖的是「真代码被当注释吞掉」这个**后果**，不是「我今天想得到的几个符号」。
 *   抛出来的消息里**逐字带上原文那一行**。
 *   ⚠️ **别再往这里写「今天会抛的 N 档」**：本文件族已经为「把计数写死进注释」漂过四轮。
 *   清单在 `tests/unit/source-guards.test.ts` 的「判不准要吵」那张 `it.each` 表里（那是断言，
 *   不是散文），同一格另有一条断言钉着「真源里的抛出点数必须等于那张表的行数」——
 *   **在这里加一档而不去那张表加一行，当场红。**
 *   ⚠️ 哪天真被绊到，请在这里加一档判据，**别把 `try/catch` 加在调用方把它吞掉**。
 * · **不做的事**：它不是解析器。`obj.in / 2` 这类「关键字当属性名」靠「点号前缀 ⇒ 除法位」
 *   挡住；`a?.b` / 类型标注 / 装饰器都只当普通字符搬运。
 *
 * **方言**：JS 与 CSS 的注释语义不同，由 `dialect` 选，**不是各写一份实现**。
 * · `"js"`（默认）—— 行注释 + 块注释 + 正则字面量 + 模板字面量。
 * · `"css"` —— **只认块注释与字符串**。CSS 没有行注释，也没有正则字面量：
 *   `background: url(//cdn.example/x.png)` 里的双斜杠是地址的一部分，
 *   按 JS 语义抠会把那一行其后的样式整段吃掉 ⇒ CSS 侧的扫描当场变瞎。
 *   ⚠️ 这不是假设：P3e Task 1 第一版把两处 CSS 消费者一起改成了 JS 语义，
 *   复评实测「不许给某一条通道开小灶」那格在违规前面加一个 `url(//…)` 就变绿。
 *
 * **三个导出，同一个 `scan()`，只在「注释输出成什么 / 用哪种方言」上分叉：**
 * · `stripComments` —— JS，注释**删掉**。给「按内容扫」的消费者用。
 * · `blankComments` —— JS，注释**逐字符换成空格、换行原样保留**。给「按行号 / 列位置扫」的用。
 * · `stripCssComments` —— CSS，注释**删掉**。
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
 * 于是 `stripComments(123)` 在 9 个消费者那边一路静默编过——复评实测 `tsc --noEmit` EXIT=0，
 * 补上这四行之后同一条探针立刻 `error TS2345`。
 */

/** 前面是这些标点 ⇒ 下一个 `/` 一定是正则字面量开头（它们都不能结束一个表达式）。 */
const REGEX_AFTER_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">", "/"]);

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
 * ⚠️ **已知边界（实测过，写成断言在 `tests/unit/source-guards.test.ts` 的「已知判反」那张表里）**：
 * 靠 ASI 断句的 `const a = b` 换行 `!/x/.test(s)` 会被判成后缀位。那一支的后果方向是
 * **把正则当代码扫**（不吞代码，遇到引号/裸斜杠会撞上别的绊线当场吵），不是致盲方向。
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
 * 判不准就抛，消息里逐字带上原文那一行。**这是本仓裁定的「认不出要吵」**：
 * 静默地按某一种解释走下去，代价是真代码被吞而门禁照常报绿。
 * @param {string} src
 * @param {number} pos
 * @param {string} why
 * @returns {never}
 */
function fail(src, pos, why) {
  const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
  const nl = src.indexOf("\n", pos);
  const lineEnd = nl === -1 ? src.length : nl;
  const line = src.slice(0, pos).split("\n").length;
  throw new Error(
    `[strip-comments] ${why}（第 ${line} 行第 ${pos - lineStart + 1} 列）\n`
    + `  原文：${src.slice(lineStart, lineEnd)}`,
  );
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
    if (p.kind === "closeBrace") {
      fail(src, pos, "判不准这个斜杠是正则字面量开头还是除法：前一个有意义字符是 `}`，"
        + "块结束是正则位、对象字面量结束是除法位。请给它加一对括号或一个分号把歧义写没");
    }
    if (REGEX_AFTER_PUNCT.has(p.ch)) return true;
    if (DIVIDE_AFTER_PUNCT.has(p.ch)) return false;
    return fail(src, pos, `判不准这个斜杠是正则字面量开头还是除法：前一个有意义字符是 \`${p.ch}\`，`
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
        fail(src, start, "单双引号字符串没有在本行内闭合 ⇒ 扫描器已经失步。"
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
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      out += onComment(src.slice(i, j));
      i = j;
      continue;
    }

    // ── 块注释（两种方言都有） ────────────────────────────────────────────
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      if (j === n) {
        // **后果层兜底**：没有闭合记号的块注释一路吞到文件尾。这既可能是源码本身坏了，
        // 更可能是上游某个 `/` 判反了——判成正则、把同行下一个斜杠当结束符、
        // 剩下的 `/*` 重开一个块注释。那一支**长度与行数两条不变量全过**（换等长空格、
        // 换行原样留着），静默吞掉真代码，所以必须在这里吵。
        fail(src, i, "块注释开了但没有闭合记号，一路吞到文件尾 ⇒ 要么这份源码坏了，"
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
        fail(src, start, "正则字面量没有在本行内闭合 ⇒ 判据把一个除法号当成了正则开头，"
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
        fail(src, start, "这个斜杠被判成了正则字面量开头，但引擎不认它是一条正则"
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
    fail(src, n, "扫到文件尾时模板字面量的上下文栈还没平衡 ⇒ 扫描器已经失步"
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
