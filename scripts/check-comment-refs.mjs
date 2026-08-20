#!/usr/bin/env node
/*
 * 第 12 道门禁：**注释里指向的位置必须真实存在。**
 *
 * 用法：
 *   node scripts/check-comment-refs.mjs            # 查本仓
 *   node scripts/check-comment-refs.mjs <根目录>    # 查别处（只给元测试用）
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────────
 * 本仓的台账已经记了二十余次「注释/文档里写下一句假断言」，全分支评审这一轮又新
 * 查实 12 条实质性的，**发生率没有下降**。其中三条是同一个成因：**注释在写下那一
 * 刻是真的，后来被同一期自己的新代码推翻，没人回头改**。那不是"再扫一遍"能收敛的
 * 东西——扫描依赖人记得扫，而这类漂移恰恰发生在没人再看那一段的时候。
 *
 * 标本两个（都由这道门禁直接抓住）：
 *
 * @refs-ignore（本段刻意举一条**错的**指向当标本，它按定义就不该被判成对的）
 * · `src/core/admin/event-ring.ts` 说"见 `tests/unit/admin/event-ring.test.ts` 里
 *   专门钉住这条代价的用例"——那个文件确实存在，但里面**根本没有**那条用例。
 *
 * 那条用例真正在的地方是 `tests/unit/logger-store.test.ts` 的
 * 「架构裁定①的代价：同一时间窗+槽位下真并发落盘会互相覆盖」。
 * ⚠️ **这一句刻意留在豁免段之外**：它是**活指向**，腐烂了门禁必须变红。
 * 这正是本任务把豁免从块级收窄到段级的理由——「把旧错指向留作标本」和
 * 「刚更正的活指向」天然写在同一块注释里，块级豁免会把两者一起放行。
 *
 * · `src/core/config.ts` 说"全仓还没有任何代码读它"——写下时是真的，同一期后面
 *   就接上了三级消费链。
 *
 * ── 两条规则 ────────────────────────────────────────────────────────────────
 * **规则 A（校验）**：注释里出现的每一个仓内路径引用都必须解析得开。
 *   · `path` —— 文件必须存在。
 *   · `path:NNN` —— 文件必须存在，`NNN` 必须在行数范围内；若 `path` 是测试文件，
 *     则 `NNN` 上下 `WINDOW` 行内必须出现 `it(` / `test(` / `describe(` / `expect(`
 *     之一，否则这个行号指的就不是一条用例。
 *   · ``path「某某名字」`` —— **名字锚**：那段文字必须真的在文件里出现。
 *
 * **规则 B（强制）**：一段注释里只要出现了**断言性措辞**（词表见下面的
 *   `CLAIM_MARKERS`，本任务从 6 个扩到 11 个），并且提到了某个测试文件，
 *   那个提法就必须带 `:行号` 或名字锚。裸文件名不算数——`event-ring.ts` 那条
 *   正是裸文件名，而写作者只要被逼着去找出行号，就会当场发现它不在那个文件里。
 *
 * ── 它做不到什么（明写，别读成"注释从此都是真的"）────────────────────────────
 * 它验的是**指向**，不是**内容**：一个指向 `expect(1).toBe(1)` 的行号照样能过关。
 * "这条断言真的守着注释说的那件事吗"仍然只能靠评审。行号形态还有一层代价：
 * 被指向的文件在那一行之上插入内容时，指向会漂到别处——**门禁会红**（窗口里找不到
 * 用例时），但也可能恰好漂到另一条 `expect(` 上而静默通过。名字锚没有这个问题，
 * 所以两种形态都收，并且推荐名字锚。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = process.argv[2]
  ? fileURLToPath(pathToFileURL(join(process.argv[2], "/")))
  : fileURLToPath(new URL("../", import.meta.url));

/** 扫哪些目录。生成物 `src/ui/assets.generated.ts` 排除在外——它把 admin-ui 的源码
 *  整段当字符串字面量嵌进去，扫它等于把 admin-ui 的注释重复扫一遍并且行号全错。 */
const SCAN_DIRS = ["src", "tests", "scripts", "admin-ui"];
const SKIP = new Set(["src/ui/assets.generated.ts"]);
/** 只认这些开头的路径是"仓内引用"，避开 `./pure/x.mjs` 这类相对 import 的噪音。 */
const REPO_PREFIXES = ["src/", "tests/", "scripts/", "admin-ui/", "docs/", ".github/"];
/** 行号上下各看多少行找用例声明。 */
const WINDOW = 6;
const TEST_ANCHORS = ["it(", "it.each", "test(", "describe(", "expect("];
/**
 * 断言性措辞。命中即触发规则 B。
 *
 * ⚠️ **这是一张手写词表，它的边界必须自己也是会变红的断言**——一道以「不许写成
 * 散文」为全部理由的门禁，自己更不能把「认得哪些、认不得哪些」写成散文。
 * `tests/unit/check-comment-refs.test.ts` 的
 * 「声称认得的措辞真的触发规则 B」与「已知认不得的措辞确实不触发规则 B」两张表逐条钉着它。
 *
 * 本任务从 6 个扩到 11 个：原来只认「钉住/钉着/钉死/守着/会变红/变红」，
 * 而本仓同样常用的「由 X 保证」「已核实」「已实测」「拦得住」「抓得住」**它一个都
 * 看不见**——同一句断言换个说法就绕过了整道门禁。
 *
 * **它认不得什么，同样明写**：这是子串匹配，不是语义判断。「这条逻辑很安全」
 * 「不会出问题」这类没有关键词的断言它一律看不见，**换个措辞就能绕过去**。
 * 这条边界没有护栏，登记为已知盲点——规则 B 是给「顺手写下一句断言」加一道摩擦，
 * 不是给「刻意绕开」设一道墙。
 */
const CLAIM_MARKERS = [
  "钉住", "钉着", "钉死", "守着", "会变红", "变红",
  // 本任务新增。`保证` 收的是「由 X 保证」这一族——不写成带通配的「由 * 保证」是
  // 因为判据是子串匹配，`保证` 已经把那一族全包住，而多一条更窄的规则只会多一处
  // 会漂的东西。误报面由规则 B 自身的前提兜着：**只有同一段里还提到了某个
  // `tests/**.test.ts` 才会触发**。
  "保证", "已核实", "已实测", "拦得住", "抓得住",
];

const PATH_RE = new RegExp(
  String.raw`((?:${REPO_PREFIXES.map((p) => p.replace(".", "\\.")).join("|")})[A-Za-z0-9_./-]*`
  + String.raw`\.(?:ts|js|mjs|md|json|sh|yml|yaml|html|css))(?::(\d+))?`,
  "g",
);
/**
 * 名字锚：紧跟在路径（可带 `:行号`）后面的一段引文。
 *
 * 连接词与引号形态都收得比较宽，因为**本仓早就在用这个写法了**，只是没有统一：
 * `X.test.ts 的「用例名」`、`X.test.ts 那条「用例名」`、`X.test.ts 的"用例名"`
 * 三种都出现过。收窄成一种的代价是把几十处已有的、本来就正确的写法判成违规。
 * 引文里允许 `……` 省略，见 `anchorMatches()`。
 */
const ANCHOR_CONNECTOR = "(?:的|那条|那一条|那格|那一格|里的|里|中的|中|上的)?";
const NAME_ANCHOR_RE = new RegExp(
  `^\\s*${ANCHOR_CONNECTOR}\\s*[「『"\u201c]([^」』"\u201d]+)[」』"\u201d]`,
);
/** 提到某个测试文件（用于规则 B）。 */
const TEST_FILE_RE = /(tests\/[A-Za-z0-9_./-]*\.test\.ts)(:\d+)?/g;

/**
 * `flat` 里 `target` 后面紧跟的那个 `「…」`（可能有多处提及，任一处带锚即算数）。
 * 返回锚里的文字，没有则 `null`。
 */
function nameAnchorAfter(flat, target) {
  for (let i = flat.indexOf(target); i !== -1; i = flat.indexOf(target, i + 1)) {
    const m = NAME_ANCHOR_RE.exec(flat.slice(i + target.length).replace(/^:\d+/, ""));
    if (m) return m[1];
  }
  return null;
}

/**
 * 名字锚是不是真的能在目标文件里找到。
 *
 * **支持省略号**（`……` / `...`）：本仓已有的写法里，长用例名常被缩写成
 * `「只有 4xx 直通……攒够一个触达间隔也会落盘」`。判据因此是"逐段按顺序出现"，
 * 不是整串相等——既保住了这种可读的写法，又拦得住"名字整个是编的"。
 * **它不校验省略掉的那一段**，这条边界是有意的：要求逐字全抄会让注释难读，
 * 而这道门禁要防的是"指向一条不存在的用例"，不是"引文不够精确"。
 */
function anchorMatches(target, anchor, mustNameACase) {
  // **比对前把空白全部抠掉。** 注释里的长名字必然被折行，折行处 `flatten` 会留下
  // 一个空格，而源文件里那一处没有——不抠的话，凡是跨行写的锚都会假红，
  // 那就是量具坏了（本仓登记的"判据建在缺陷没采取的那个形态上"的近亲）。
  const squash = (x) => x.replace(/\s+/g, "");
  const parts = anchor.split(/…+|\.{3,}/).map((p) => squash(p)).filter(Boolean);
  const hit = (hay) => {
    let at = 0;
    for (const part of parts) {
      const found = hay.indexOf(part, at);
      if (found === -1) return false;
      at = found + part.length;
    }
    return true;
  };
  // **这一段在断言「某条用例守着某件事」时（规则 B 命中），锚必须落在某一条用例的
  // 标题里**（评审 I7 的推广，理由见 `testTitles()`）。
  //
  // **只对断言性的那一类收紧，是刻意的**：本仓也有大量**描述性**指向
  //（「观测形态照抄 X 的 `fakeCtx()`」这种），它们指的是一段代码或一段说明，
  // 不是一条用例，要求它们指向用例标题是把判据用错了地方。
  // 分界线用的就是规则 B 自己那条——**你声称它守着什么，你就得说出是哪一格。**
  if (mustNameACase && /\.test\.ts$/.test(target)) {
    return testTitles(target).some((t) => hit(squash(t)));
  }
  return hit(squash(flatten(readFileSync(join(ROOT, target), "utf8"))));
}

/**
 * 目标测试文件里所有用例/分组的**标题字符串**。
 *
 * ⚠️ **为什么不能拿整份文件当干草堆**（评审 I7 的推广，本任务实测）：
 * `anchorMatches` 原来是在**整文件压平后**做子串匹配，于是**锚只要在目标文件的
 * 任何地方出现过就算数——包括那个文件自己的注释**。本仓的写法恰恰爱在用例上方
 * 的说明里把用例名再复述一遍，于是：**把被指向的那条 `it()` 整个改名，门禁照样绿**
 * （实测两处：`tests/unit/admin/key-view.test.ts` 的「maskKey 的边界」与
 * `tests/contract/admin-events.test.ts` 的「fetch 路径仍然受最小间隔节流」，
 * 改名后 `EXIT=0`）。
 * 那是**形状断言冒充行为断言**：满足了语法、消掉了红，一条腐烂都检测不出。
 *
 * 现在锚必须落在 `it(` / `test(` / `describe(` 的标题字面量里——那才是
 * 「这条断言由那一条用例守着」这句话真正指的东西。
 *
 * **它做不到什么，明写**：标题是拼出来的（模板插值、变量拼接）时，插值那一段
 * 不在字面量里，锚就得避开它；`it.each` 的 `$why` 这类占位符同理。
 */
function testTitles(target) {
  const src = readFileSync(join(ROOT, target), "utf8");
  const out = [];
  const re = /\b(?:it|test|describe)(?:\.each\([\s\S]*?\)|\.\w+)?\s*\(\s*(["'`])/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const quote = m[1];
    const from = m.index + m[0].length;
    const end = closingQuote(src, from, quote);
    if (end !== -1) out.push(src.slice(from, end));
  }
  return out;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|js|mjs)$/.test(p) ? [p] : [];
  });
}

/**
 * 抠出注释块。返回 `{ text, line }`——`line` 是块的起始行号（1 基）。
 * 第二个返回值 `unterminated` 是「扫到文件尾还没闭合的块注释」的起始行号，
 * 有值就是**报错**，见下面「为什么它必须报错」。
 *
 * ⚠️ **它是逐字符扫的，会跳过字符串字面量（`'` / `"` / 反引号，含跨行模板）。**
 * 这一条不是锦上添花——**第一版不解析字符串字面量，那是一个会让整道门禁静默失明
 * 的洞**：`app.get("/admin/*", handler)` 里那个 `"/admin/*"` 含有 `/*`，第一版把它
 * 当成块注释开头，一路吞到文件尾都没等到 `*\/`，于是**从那一行往下的全部内容
 * 直接从校验范围里消失，而门禁照常打印 ✅**。实测：同一条坏指向插在
 * `src/ui/serve.ts` 那一行**之后** ⇒ `EXIT=0` 且打印「281 处全部解析得开」；
 * 插在**之前** ⇒ `EXIT=1`。
 *
 * ⚠️ **第一版的注释还写着「今天仓里没有这种写法」——那句话是假的，仓里有 4 处**
 * （`tests/contract/auth.test.ts:7` / `src/http/app.ts:175` /
 * `src/http/admin/router.ts:169` / `src/ui/serve.ts:85`），合计让 **136 行**
 * 脱离校验。最要命的是 `router.ts` 那一行本身就是
 * 「新增任何 /admin/api/* 端点都必须挂在这一行之后」——**一句注释里写了那个
 * 通配符，就把它下面整张路由表从门禁眼前抹掉了**，而后面几个任务要加的端点
 * 全在那之后。**这正是本仓记了二十余次的「注释里写下一句假断言」，
 * 而这一次它出现在专治这件事的那道门禁自己身上。**
 *
 * **为什么未闭合必须报错而不是静默丢弃**：第一版扫到文件尾时 `buf` 里攒着的东西
 * 被直接丢掉，没有任何信号。凡是"解析失败就当没看见"的门禁，失效时都长得和通过
 * 一模一样。现在它 `EXIT=1` 并指出是哪一行开的头。
 *
 * ⚠️ **字符串状态刻意只在「一行之内」有效，绝不跨行传递**——这一条是踩出来的：
 * 第一版的修法带了跨行的模板字面量状态，结果本文件自己第 277 行那个
 * **正则字面量** `` /`/g `` 里的反引号被当成模板开头，一路吞掉下面 20 行，
 * 把 `IGNORE_MARKER` 那整段说明（含它的豁免标记）从扫描结果里抹掉了
 * ——**修一个失明修出另一个失明**。跨行状态要正确就必须区分「除号 / 正则字面量」，
 * 那要跟踪上一个有效 token，复杂度和出错面都不值。
 *
 * ⇒ 现在：引号没在同一行闭合 ⇒ **这一行剩下的当字符串处理，状态到行尾为止清零**。
 * 代价明写：**跨行的模板字面量内部如果写了 `//`，会被误当成注释**。
 * 那是**误报**（多校验一段），不是漏报——而这道门禁一旦漏报就长得和通过一模一样，
 * 两者的代价差一个量级。今天全仓跑下来零误报。
 */
function commentBlocks(src) {
  const out = [];
  const lines = src.split("\n");
  let inBlock = false;
  let buf = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let j = 0;
    // 块注释**跨行**：先把这一行里属于上一个块的部分吃掉。
    // （只有块注释保留跨行状态，理由见上面那段 ⚠️。）
    if (inBlock) {
      const end = raw.indexOf("*/");
      if (end === -1) { buf.push(raw); continue; }
      buf.push(raw.slice(0, end + 2));
      out.push({ text: buf.join("\n"), line: start });
      inBlock = false;
      buf = [];
      j = end + 2;
    }
    for (; j < raw.length; j++) {
      const c = raw[j];
      if (c === "'" || c === '"' || c === "`") {
        const end = closingQuote(raw, j + 1, c);
        // 没闭合（跨行模板、或正则字面量里的引号）：这一行剩下的都当字符串，
        // **不往下一行传递任何状态**。
        if (end === -1) break;
        j = end;
        continue;
      }
      if (c === "/" && raw[j + 1] === "/") {
        out.push({ text: raw.slice(j), line: i + 1 });
        break;
      }
      if (c === "/" && raw[j + 1] === "*") {
        const end = raw.indexOf("*/", j + 2);
        if (end === -1) { inBlock = true; start = i + 1; buf = [raw.slice(j)]; break; }
        out.push({ text: raw.slice(j, end + 2), line: i + 1 });
        j = end + 1;
        continue;
      }
    }
  }
  return { blocks: out, unterminated: inBlock ? start : null };
}

/** 从 `from` 起找到第一个未被 `\` 转义的 `quote`，找不到回 -1。 */
function closingQuote(raw, from, quote) {
  for (let k = from; k < raw.length; k++) {
    if (raw[k] === "\\") { k++; continue; }
    if (raw[k] === quote) return k;
  }
  return -1;
}

/** 连续的 `//` 行合成一段：跨行的断言（"由 X\n// 那一格钉着"）要能被规则 B 看见。 */
function mergeAdjacent(blocks) {
  const out = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev && b.text.startsWith("//") && prev.text.startsWith("//")
      && b.line === prev.line + prev.text.split("\n").length) {
      prev.text += `\n${b.text}`;
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

/**
 * 把一段注释压成"人读到的那句话"：去掉行首的 `*` / `//` 装饰与反引号，把换行折成
 * 空格。**名字锚必须在这上面匹配**，否则一个跨行写的 `「连续失败三次之后升到\n
 * 长退避」` 会因为中间夹着 `\n * ` 而永远匹配不上——那是量具坏了，不是断链。
 */
function flatten(text) {
  return text
    .replace(/^\s*(?:\/\*+|\*+\/|\*|\/\/)/gm, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ");
}

/**
 * 逐**段**的豁免标记。
 *
 * @refs-ignore（这段说明自己就要举那几个不存在的示例路径，例如 `src/x.ts`）
 * 需要它的只有一类注释：**刻意提到一个不该存在的路径**——
 * ① 讲历史（"那个文件在 B3 被删掉了"）；② 举例子（门禁脚本自己的说明里那些
 * `src/x.ts` / `tests/foo.test.ts` 是虚构的示例路径）。
 *
 * ⚠️ **它原来是「逐块」的，本任务收窄成「逐段」，因为块级豁免太宽**：
 * 「把旧的**错**指向留作标本」和「刚更正的**活**指向」**天然写在同一块注释里**
 * ——`src/core/admin/event-ring.ts` 就是标本，那一块里同时有正确的活指向和被
 * 刻意保留的错误指向，而块级豁免把**两者一起**放行了。实测：那 13 段豁免块里
 * 藏着 19 条今天仍然解析得开的活指向，它们全都不在校验范围内，腐烂了也没人知道
 * （`src/core/admin/key-view.ts` 那条就已经腐烂了 2 行，本任务一并修）。
 *
 * **段的边界**：标记所在的那一行起，到**下一个空注释行**为止（不含）。
 * 所以想豁免哪几句，就把标记写在那几句的**同一段**里——写成单独一段（后面
 * 紧跟一个空注释行）只会豁免掉标记那一行自己。
 *
 * **这是个逃生口，所以它自己要被看住**：脚本会报出用了几次，
 * `tests/unit/check-comment-refs.test.ts` 里有一格把"用在哪些文件的哪一行"钉成
 * 手写清单——想多用一次，就得在评审里被看见。
 */
const IGNORE_MARKER = "@refs-ignore";

/**
 * 一行注释除掉 `*` / `//` 装饰之后是不是空的。**段的分隔符就是它。**
 * 复用 `flatten()` 而不是另写一个正则：两份实现会漂，而"段边界判据漂了"
 * 的后果是豁免范围悄悄变大——那正是这次收窄要治的病。
 */
function isBlankCommentLine(raw) {
  return flatten(raw).trim() === "";
}

/**
 * 把一块注释按豁免标记切成「豁免段」与「受检段」，返回受检的那些**连续行段**
 *（`{ text, line }`，`line` 是 1 基真实行号）以及这一块用了几个标记。
 *
 * 受检行按**连续段**合并而不是逐行交给规则：名字锚在本仓大量跨行写
 *（`「连续失败三次之后升到\n * 长退避」`），逐行匹配会让每一个跨行的锚假红
 * ——那时红的不是缺陷，是量具。
 */
function splitByIgnore(block) {
  const lines = block.text.split("\n");
  const exempt = new Array(lines.length).fill(false);
  let markers = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(IGNORE_MARKER)) continue;
    markers++;
    for (let j = i; j < lines.length; j++) {
      if (j > i && isBlankCommentLine(lines[j])) break;
      exempt[j] = true;
    }
  }
  const runs = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (exempt[i]) { cur = null; continue; }
    if (cur === null) runs.push((cur = { text: lines[i], line: block.line + i }));
    else cur.text += `\n${lines[i]}`;
  }
  return { runs, markers };
}

/**
 * **整份文件的豁免**。今天只有一种文件需要它：**这道门禁自己的元测试**——
 * 它的夹具字符串里按构造就装满了断链的指向（那正是它要喂给门禁的输入），
 * 而本文件的注释扫描器不解析字符串字面量（见 `commentBlocks()` 的边界说明），
 * 于是那些夹具会被当成真注释。逐块打标记要打十几处，还会把夹具写得没法读。
 *
 * 与逐块豁免同样被计数、同样被 `tests/unit/check-comment-refs.test.ts` 的
 * 「豁免清单与手写的这份一致」钉成手写清单。
 */
// ⚠️ **标记名故意拆成两段拼**：写成一个完整字面量的话，这一行自己就会命中下面
// 那条判据（`*` 紧挨着标记名），于是**门禁把自己整份豁免掉**——一个自我豁免的门禁
// 比没有门禁更糟，它还会报绿。已实测踩过一次，元测试里有一格钉着这件事。
const IGNORE_FILE_RE = new RegExp(`(?:^|\\*|//)[^\\S\\n]*@refs-ignore${"-file"}\\b`, "m");

const errors = [];
const ignored = [];
let checked = 0;
let claimChecked = 0;

const lineCache = new Map();
function linesOf(rel) {
  if (!lineCache.has(rel)) {
    lineCache.set(rel, readFileSync(join(ROOT, rel), "utf8").split("\n"));
  }
  return lineCache.get(rel);
}

for (const dir of SCAN_DIRS) {
  for (const abs of walk(join(ROOT, dir))) {
    const rel = abs.slice(ROOT.length).split("\\").join("/");
    if (SKIP.has(rel)) continue;
    const src = readFileSync(abs, "utf8");
    // **判据要求这个标记出现在注释行里**（行首、或 `*` / `//` 之后）。
    // 不这么写的话，本文件里那行 `const IGNORE_FILE_RE = …` 会让**门禁自己**整份
    // 免检——一个自我豁免的门禁比没有门禁更糟（它还会报绿）。
    if (IGNORE_FILE_RE.test(src)) {
      ignored.push(`${rel}:0`);
      continue;
    }

    const scanned = commentBlocks(src);
    // **解析失败必须是红的，不能是静默的。** 未闭合的块注释意味着从那一行到文件尾
    // 全部脱离校验——第一版把这种情况直接丢掉，失效时和通过长得一模一样。
    if (scanned.unterminated !== null) {
      errors.push(
        `${rel}:${scanned.unterminated} 有一个块注释一直到文件尾都没闭合，`
        + `从那一行往下的内容全部没有被校验——先把它闭合，或者来改 commentBlocks() 的扫描判据`,
      );
    }
    for (const wholeBlock of mergeAdjacent(scanned.blocks)) {
      // **逐段豁免**：标记只放行它所在的那一段（到下一个空注释行为止），
      // 同一块注释里其余的段照常校验。
      const { runs, markers } = splitByIgnore(wholeBlock);
      for (let n = 0; n < markers; n++) ignored.push(`${rel}:${wholeBlock.line}`);
      for (const block of runs) {
      const flat = flatten(block.text);
      // ── 规则 A ──────────────────────────────────────────────────────────
      for (const m of block.text.matchAll(PATH_RE)) {
        const target = m[1];
        const lineNo = m[2] === undefined ? null : Number(m[2]);
        const where = `${rel}:${block.line}`;
        if (!existsSync(join(ROOT, target))) {
          errors.push(`${where} 指向的 ${target} 不存在`);
          continue;
        }
        checked++;
        if (lineNo === null) {
          // 名字锚（可选）：`path「某某」`。在**压平后**的文本上找，见 flatten()。
          const anchor = nameAnchorAfter(flat, target);
          const claims = CLAIM_MARKERS.some((k) => block.text.includes(k));
          if (anchor !== null && !anchorMatches(target, anchor, claims)) {
            errors.push(`${where} 指向 ${target}「${anchor}」，但那段文字不在那个文件里`);
          }
          continue;
        }
        const lines = linesOf(target);
        if (lineNo < 1 || lineNo > lines.length) {
          errors.push(`${where} 指向 ${target}:${lineNo}，而那个文件只有 ${lines.length} 行`);
          continue;
        }
        if (!/\.test\.ts$/.test(target)) continue;
        const from = Math.max(0, lineNo - 1 - WINDOW);
        const to = Math.min(lines.length, lineNo + WINDOW);
        const window = lines.slice(from, to).join("\n");
        if (!TEST_ANCHORS.some((a) => window.includes(a))) {
          errors.push(
            `${where} 指向 ${target}:${lineNo}，但那一行上下 ${WINDOW} 行里没有任何用例声明`
            + `（it/test/describe/expect）——行号大概率已经漂了`,
          );
        }
      }

      // ── 规则 B ──────────────────────────────────────────────────────────
      if (!CLAIM_MARKERS.some((k) => block.text.includes(k))) continue;
      for (const m of block.text.matchAll(TEST_FILE_RE)) {
        claimChecked++;
        if (m[2]) continue;                       // 已经带了行号
        if (nameAnchorAfter(flat, m[1]) !== null) continue;          // 带了名字锚
        errors.push(
          `${rel}:${block.line} 这段注释写了「${CLAIM_MARKERS.find((k) => block.text.includes(k))}」`
          + `却只给了裸文件名 ${m[1]}。指向必须写成 ${m[1]}:行号 或 ${m[1]}「用例名」`
          + `——逼你去把它找出来，正是这道门禁的全部作用`,
        );
      }
      }
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`[check-comment-refs] ❌ ${e}`);
  process.exit(1);
}
console.log(
  `[check-comment-refs] ✅ ${checked} 处注释里的仓内路径引用全部解析得开，`
  + `其中 ${claimChecked} 处带断言性措辞的测试引用都给出了行号或用例名；`
  + `${ignored.length} 段注释用了 ${IGNORE_MARKER} 豁免`,
);
if (process.env.COMMENT_REFS_LIST_IGNORED === "1") {
  for (const w of ignored) console.log(`[check-comment-refs] ignored ${w}`);
}
