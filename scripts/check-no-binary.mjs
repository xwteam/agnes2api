#!/usr/bin/env node
// 评审 F3 新增的第 11 道门禁：`src/`/`tests/`/`admin-ui/`/`scripts/`/`docs/` 下
// 不许存在被 git 判定为二进制的跟踪文件。
//
// 起因：`storage-file.ts` 的一个保留键常量第一版写成了字面 NUL 字节而不是转义
// 写法，git 因此把整份文件判成二进制——后果不是风格问题：
//   · 评审包生成时对这个文件只吐一行 `Binary files a/... and b/... differ`
//     （没有人真的看过这份代码的评审包）；
//   · `grep -rn "implements Storage"` 这类代码审计静默跳过它，连
//     "Binary file matches" 都不打印，返回码照样是 0；
//   · `scripts/scan-secrets.sh` 用 `git grep -I` 扫凭据，`-I` 的字面意思就是
//     "跳过二进制文件"——公开仓的"零内置凭据"门禁对着这类文件完全失明
//     （已实测：塞一段匹配现有正则的假凭据进这类文件，门禁照样放行）。
// 堵的是"这一类"问题（任何字节导致的二进制误判），不是"这一个"文件——今天是
// NUL，明天可能是别的控制字符，而评审包 diff、grep 审计、五语言 grep 核对、
// scan-secrets 这一整套质量流程全部建立在"这是文本"这个前提上。
//
// 判定方法：借用 git 自己对"是不是文本"的判据，不重新猜"什么样的字节算二进制"
// ——`git ls-files --eol` 会**逐个跟踪文件**直接报出 git 对它的判定：
//     i/-text  → git 判定为二进制（索引侧）
//     i/lf | i/crlf | i/mixed → 文本
//     i/none   → 没有任何行结束符（空文件、或整个文件只有一行且不以换行结尾）——是文本
// 这是本仓"反同义反复"的同一条纪律：期望侧从 git 自己的判据来，不在这里重新实现
// 一遍 git 的二进制探测算法（重实现的算法判错时给出的是静默的错误答案）。
//
// ⚠️ **评审四审 B 组第 2 条：第一版不是这么判的，它有两个已实测的误报，**
// **两处误报都被当时的注释描述成"不会发生"。** 第一版用的是
// `git ls-files` 的全集减去 `git grep -Il -E "."` 能匹配到的子集，并在注释里写
// "匹配『至少一个字符』的正则，对任何非空文本文件必然命中"——那句话是假的：
//   ① **只含空行的跟踪文件**（例如 `printf '\n\n\n'`）：git 判它是文本
//      （`i/lf`），但 `git grep -E "."` 一行都匹配不到（`.` 不匹配空行），于是被
//      算进"二进制"，CI 直接红，还附赠一句"多半是混进了 NUL"的错误诊断；
//   ② **工作树里被删掉、但仍在索引里的跟踪文件**（`rm src/x.ts` 未 stage）：
//      `git grep` 搜的是工作树，文件不在了自然匹配不到；第一版的 catch 分支注释
//      写着"读不到就交给下面的正常流程处理"，而那个"正常流程"就是把它报成二进制。
//      本地随手删一个跟踪文件再跑门禁就会红——已实测。
// `git ls-files --eol` 一次消掉这两个洞：空行文件是 `i/lf`，工作树删除的文件
// 索引侧照样报 `i/lf`（工作树列变成空的 `w/`）。

import { execFileSync } from "node:child_process";

const SCOPE_PREFIXES = ["src/", "tests/", "admin-ui/", "scripts/", "docs/"];

/** git 判定为二进制的记号。其余（lf / crlf / mixed / none）一律是文本。 */
const BINARY_EOL = "-text";

/**
 * `git ls-files --eol -z` 的一条记录：
 *     `i/lf    w/lf    attr/                 \t<path>`
 * `-z` 之下路径不做引号转义（带空格/非 ASCII 的路径原样给出），记录之间以 NUL 分隔。
 * 路径从第一个 TAB 之后开始——前三列（i/ w/ attr/）本身不含 TAB。
 */
function parseEolRecord(record) {
  const tab = record.indexOf("\t");
  if (tab < 0) return null;
  const head = record.slice(0, tab);
  const path = record.slice(tab + 1);
  const m = /^i\/(\S+)\s+w\/(\S*)\s+attr\//.exec(head);
  if (!m) return null;
  return { path, index: m[1], worktree: m[2] };
}

const out = execFileSync("git", ["ls-files", "--eol", "-z"], {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
const records = out.split("\0").filter(Boolean).map(parseEolRecord);

const unparsed = records.filter((r) => r === null).length;
if (unparsed > 0) {
  // fail closed：解析不了就报错，不静默当成"全是文本"。
  console.error(`[check-no-binary] ❌ 有 ${unparsed} 条 \`git ls-files --eol\` 输出解析不了，判定不可信`);
  process.exit(1);
}

const inScope = records.filter((r) => SCOPE_PREFIXES.some((p) => r.path.startsWith(p)));

// 索引侧与工作树侧都要看：索引侧是"将来会被提交、会被评审包 diff 到的那份内容"，
// 工作树侧是 `scan-secrets.sh`（`git grep --untracked`）实际扫的那份。工作树列为空
// （`w/`）表示文件已在工作树里删掉，索引侧仍然有效，不算问题。
// ⚠️ 两侧都看的直接后果：把一个二进制文件在工作树里改回文本、但**还没 `git add`**
// 时，这道门禁仍然报红（索引侧还是二进制）。这是想要的语义——"跟踪文件"指的就是
// 索引里的那份；CI 上索引与工作树同源，不会出现这个中间态。报错信息里带上
// `(i/… w/…)` 就是为了让这个中间态一眼可辨，不至于被当成门禁坏了。
const binaryInScope = inScope.filter(
  (r) => r.index === BINARY_EOL || r.worktree === BINARY_EOL,
);

if (binaryInScope.length > 0) {
  console.error("[check-no-binary] ❌ 以下跟踪文件被 git 判定为二进制，不允许出现在这些目录下：");
  for (const r of binaryInScope) console.error(`  ${r.path}  (i/${r.index} w/${r.worktree})`);
  console.error(
    "[check-no-binary] 多半是某个字符串字面量里混进了不可见/控制字符（例如 NUL），" +
    "改成转义写法或可打印字符即可回到文本——见本文件头部的说明（评审 F3）。",
  );
  process.exit(1);
}

console.log(`[check-no-binary] ✅ ${inScope.length} 个跟踪文件（${SCOPE_PREFIXES.join(", ")}），全部是文本`);
