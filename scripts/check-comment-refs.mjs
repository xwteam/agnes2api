#!/usr/bin/env node
/*
 * 第 12 道门禁：**注释里指向的位置必须真实存在。**
 *
 * @refs-ignore（本段刻意提到几条历史上/示例中的错误指向，它们按定义就不该解析得开）
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
 * · `src/core/admin/event-ring.ts` 说"见 `tests/unit/admin/event-ring.test.ts` 里
 *   专门钉住这条代价的用例"——那个文件里**根本没有**那条用例，它在
 *   `tests/unit/logger-store.test.ts:221`。
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
 * **规则 B（强制）**：一段注释里只要出现了**断言性措辞**（钉住 / 钉着 / 钉死 /
 *   守着 / 会变红 / 变红），并且提到了某个测试文件，那个提法就必须带 `:行号`
 *   或名字锚。裸文件名不算数——`event-ring.ts` 那条正是裸文件名，
 *   而写作者只要被逼着去找出行号，就会当场发现它不在那个文件里。
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
/** 断言性措辞。命中即触发规则 B。 */
const CLAIM_MARKERS = ["钉住", "钉着", "钉死", "守着", "会变红", "变红"];

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
function anchorMatches(target, anchor) {
  // **比对前把空白全部抠掉。** 注释里的长名字必然被折行，折行处 `flatten` 会留下
  // 一个空格，而源文件里那一处没有——不抠的话，凡是跨行写的锚都会假红，
  // 那就是量具坏了（本仓登记的"判据建在缺陷没采取的那个形态上"的近亲）。
  const squash = (x) => x.replace(/\s+/g, "");
  const hay = squash(flatten(readFileSync(join(ROOT, target), "utf8")));
  let at = 0;
  for (const part of anchor.split(/…+|\.{3,}/).map((p) => squash(p)).filter(Boolean)) {
    const found = hay.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return true;
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
 *
 * ⚠️ **这是一个很粗的扫描器，边界写在这里**：它认 `/* … *\/` 块与 `//` 行，
 * 并且在判 `//` 之前先把 `://`（URL 里的那个）抠掉。它**不**解析字符串字面量，
 * 所以一个含 `/*` 的字符串会被误当成注释开头。今天仓里没有这种写法
 *（元测试里有一格专门钉住这条边界）。真要写，请在这里说明并调整判据。
 */
function commentBlocks(src) {
  const out = [];
  const lines = src.split("\n");
  let inBlock = false;
  let buf = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (inBlock) {
      buf.push(raw);
      if (raw.includes("*/")) {
        out.push({ text: buf.join("\n"), line: start });
        inBlock = false;
        buf = [];
      }
      continue;
    }
    if (raw.includes("/*")) {
      start = i + 1;
      buf = [raw];
      if (raw.includes("*/", raw.indexOf("/*") + 2)) {
        out.push({ text: raw, line: start });
        buf = [];
      } else {
        inBlock = true;
      }
      continue;
    }
    const noUrl = raw.replace(/[a-z]+:\/\//gi, "");
    const at = noUrl.indexOf("//");
    if (at !== -1) out.push({ text: noUrl.slice(at), line: i + 1 });
  }
  return out;
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
 * 逐块的豁免标记。
 *
 * @refs-ignore（这段说明自己就要举那几个不存在的示例路径）
 *
 * 需要它的只有一类注释：**刻意提到一个不该存在的路径**——
 * ① 讲历史（"那个文件在 B3 被删掉了"）；② 举例子（门禁脚本自己的说明里那些
 * `src/x.ts` / `tests/foo.test.ts` 是虚构的示例路径）。
 *
 * **这是个逃生口，所以它自己要被看住**：脚本会报出用了几次，
 * `tests/unit/check-comment-refs.test.ts` 里有一格把"用在哪些文件的哪一行"钉成
 * 手写清单——想多用一次，就得在评审里被看见。
 */
const IGNORE_MARKER = "@refs-ignore";

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

    for (const block of mergeAdjacent(commentBlocks(src))) {
      if (block.text.includes(IGNORE_MARKER)) {
        ignored.push(`${rel}:${block.line}`);
        continue;
      }
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
          if (anchor !== null && !anchorMatches(target, anchor)) {
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
