#!/usr/bin/env node
// 评审 F3 新增的这道门禁（CI 里跑 `scripts/check-no-binary.mjs` 那一步）：`src/`/`tests/`/`admin-ui/`/`scripts/`/`docs/` 下
// 不许存在被 git 判定为二进制的文件。
// ⚠️ 范围含**未跟踪**的新文件（P3d Task 9 复评补，理由见下面 `--others` 那一段）。
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
//   @refs-ignore（本段举的 `src/x.ts` 是虚构的示例路径）
//   ② **工作树里被删掉、但仍在索引里的跟踪文件**（`rm src/x.ts` 未 stage）：
//      `git grep` 搜的是工作树，文件不在了自然匹配不到；第一版的 catch 分支注释
//      写着"读不到就交给下面的正常流程处理"，而那个"正常流程"就是把它报成二进制。
//      本地随手删一个跟踪文件再跑门禁就会红——已实测。
// `git ls-files --eol` 一次消掉这两个洞：空行文件是 `i/lf`，工作树删除的文件
// 索引侧照样报 `i/lf`（工作树列变成空的 `w/`）。
//
// ⚠️ **`--eol` 单独用还剩一个盲区，所以判据是两条不是一条**（评审五审必修 1）：
// `.gitattributes` 里的 `-diff` 会让一份**纯文本**文件在 `git diff` 里只剩一行
// `Binary files … differ`，而 `--eol` 照样报 `i/lf`。见下面 `check-attr` 那一段。

// ⚠️ **上面那段起因里关于 `scan-secrets.sh` 的话要按今天的实测读**（本次订正）：
// 那句"`-I` 的字面意思就是跳过二进制文件 ⇒ 对这类文件完全失明"描述的是
// `scripts/scan-secrets.sh` **去掉 `-I` 之前**的状态。今天它的前五条形态判据只看
// `git grep` 的退出码，二进制命中照样是 0 ⇒ 一段 `sk-` 开头的假凭据塞进二进制文件
// **是抓得住的**（本机在仓库副本上实测过）。**但盲区没有消失，只是缩小了**：
// 私有域名 / 邮箱这类不长成那六条形态的东西、以及任何被压过一道的字节，它一个字都读不到
// （同一次实测里这两种都是绿的）。这道门禁存在的理由因此仍然成立，只是理由的**射程**
// 要说准：它挡的是"整个文件对文本工具链隐形"，不是"凭据扫描完全失明"。
// 逐档实测数据写在 `scripts/check-png.mjs` 文件头。
//
// ── 具名放行名册 ────────────────────────────────────────────────────────────
// 模板要求 README 头部块第一行是 `docs/logo.png` 那张图，而这道门禁的射程恰好含 `docs/`。
// 处置是**具名放行 + 补偿判据**，不是把 `docs/` 从射程里摘出去：
// · 放行的是**一个字面路径**，不是 `*.png`、更不是整个 `docs/`——后两种等于废掉这道门禁；
// · 放行让出的那块（"这个文件里藏没藏东西"没人回答了）由 `scripts/check-png.mjs`
//   逐字节接回去：签名 / 逐块 CRC / 块类型黑白名单 / `IEND` 之后零尾随字节 / sha256 登记值。
// 名册**从 `scripts/check-png.mjs` import**，这里不抄第二份：抄一份出来就是两份真源，
// 而两份真源对不上的那天是静静对不上的。放行一个路径与"它会被逐字节审一遍"因此
// 是同一个动作，谁也脱不开谁。

import { execFileSync } from "node:child_process";
import { REGISTERED_BINARIES } from "./check-png.mjs";

const SCOPE_PREFIXES = ["src/", "tests/", "admin-ui/", "scripts/", "docs/"];

/** 具名放行的字面路径集合。见上面那段——真源在 `scripts/check-png.mjs` 的名册里。 */
const ALLOWLIST = new Set(Object.keys(REGISTERED_BINARIES));

/** git 判定为二进制的记号。其余（lf / crlf / mixed / none）一律是文本。 */
const BINARY_EOL = "-text";

/**
 * `git ls-files --eol -z` 的一条记录：
 *     `i/lf    w/lf    attr/                 \t<path>`
 * `-z` 之下路径不做引号转义（带空格/非 ASCII 的路径原样给出），记录之间以 NUL 分隔。
 * 路径从第一个 TAB 之后开始——前三列（i/ w/ attr/）本身不含 TAB。
 *
 * ⚠️ **索引列写成 `(\S*)`（可为空），不是 `(\S+)`**：`--others` 列出的**未跟踪**
 * 文件没有索引条目，git 那一列吐的是空的 `i/`（实测：`i/      w/-text attr/…`）。
 * 写成 `(\S+)` 的话这条记录解析不了，会掉进下面 fail-closed 那一支，
 * 报一句与真实原因毫无关系的「输出解析不了」——那不是护栏，是噪音。
 */
function parseEolRecord(record) {
  const tab = record.indexOf("\t");
  if (tab < 0) return null;
  const head = record.slice(0, tab);
  const path = record.slice(tab + 1);
  const m = /^i\/(\S*)\s+w\/(\S*)\s+attr\//.exec(head);
  if (!m) return null;
  return { path, index: m[1], worktree: m[2] };
}

/**
 * ⚠️⚠️ **`--others --exclude-standard` 是 P3d Task 9 复评补的，别把它删回去。**
 *
 * 原来只列 `--cached`（跟踪文件）⇒ **一个新增文件在 `git add` 之前完全不在扫描
 * 范围内**。这不是理论风险，是本仓实测踩过的一次：P3d Task 9 新增的
 * `tests/ui/dom/keys-verify.test.ts` 里一个字符串分隔符落盘成了字面 NUL 字节，
 * 作者在 `git add` **之前**跑这道门禁，它报的是「288 个文件全部是文本 ✅」——
 * **不是「没问题」，是「没看」**，直到 `git add` 之后才红。
 * 它的失效模式恰恰是这道门禁存在的全部理由：**整份文件从评审包 diff 里消失，
 * 而十二道门禁照样全绿。**
 *
 * `--exclude-standard` 让 `.gitignore` 继续生效（`node_modules/` / `dist/` /
 * `.superpowers/` 不会被拖进来）；`--cached` 必须显式写出来——`--others` 一旦出现，
 * git 就不再默认列出索引里的那些。
 */
const out = execFileSync("git", ["ls-files", "--eol", "-z", "--cached", "--others", "--exclude-standard"], {
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
// ⚠️ **放行只作用在"是不是二进制"这一条上，不作用在下面 `-diff` 那一条上**：
// 给 `docs/logo.png` 标 `-diff` 仍然要红。两条判据挡的是两件事（字节 / 可见性），
// 为了一张图放行了前者，不等于连后者也一起放。
const binaryInScope = inScope.filter(
  (r) => (r.index === BINARY_EOL || r.worktree === BINARY_EOL) && !ALLOWLIST.has(r.path),
);

/**
 * **第二条判据：`.gitattributes` 里的 `-diff`**（评审五审必修 1）。
 *
 * 内容是不是文本、与 git 愿不愿意把它当文本 diff，是**两件事**：给一份纯文本文件
 * 标上 `-diff`，`git ls-files --eol` 照样报 `i/lf`，而 `git diff` 对它只吐一行
 * `Binary files a/… and b/… differ`——**这正是 F3 的原始症状**（评审包里没人看得见
 * @refs-ignore（本段举的 `src/hidden.ts` 是虚构的示例路径）
 * 这份代码改了什么）。已复现：`.gitattributes` 写 `src/hidden.ts -diff`，纯文本
 * 文件，新判据放行、`git diff --stat` 显示 `Bin 7 -> 8 bytes`。
 *
 * 这道门禁是因为"文件对文本工具链隐形"才设立的，只查字节就是自述超出了实际覆盖，
 * 所以判据补齐到两条。判据同样问 git 自己（`git check-attr diff`），不去解析
 * `.gitattributes` 的匹配规则——`unset` 才是 `-diff`；`set`/具体值（textconv 驱动）
 * 仍然会产出文本 diff，不算。
 *
 * 本仓 `.gitattributes` 现在只有一行 `linguist-generated=true`，且文件头已经写明
 * "刻意不加 `-diff`"的理由；这条判据就是把那句话变成会变红的东西。
 */
let noDiffInScope = [];
if (inScope.length > 0) {
  const attrOut = execFileSync("git", ["check-attr", "-z", "--stdin", "diff"], {
    input: inScope.map((r) => r.path).join("\0") + "\0",
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  // `-z` 输出是「路径, 属性名, 值」三元组，全部以 NUL 分隔。
  const fields = attrOut.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 1] === "diff" && fields[i + 2] === "unset") noDiffInScope.push(fields[i]);
  }
}

if (binaryInScope.length > 0 || noDiffInScope.length > 0) {
  console.error("[check-no-binary] ❌ 以下文件（跟踪的 + 未跟踪但不被 .gitignore 排除的）对文本工具链是隐形的，不允许出现在这些目录下：");
  for (const r of binaryInScope) {
    console.error(`  ${r.path}  —— git 判定为二进制 (i/${r.index} w/${r.worktree})`);
  }
  for (const p of noDiffInScope) {
    console.error(`  ${p}  —— .gitattributes 给它标了 -diff，git diff 只会吐 "Binary files … differ"`);
  }
  if (binaryInScope.length > 0) {
    console.error(
      "[check-no-binary] 二进制那几个多半是某个字符串字面量里混进了不可见/控制字符" +
      "（例如 NUL），改成转义写法或可打印字符即可回到文本——见本文件头部的说明（评审 F3）。",
    );
  }
  if (noDiffInScope.length > 0) {
    console.error(
      "[check-no-binary] `-diff` 那几个请去掉这条属性：降低 diff 噪音的代价是评审再也" +
      "看不见这些文件改了什么，而这些目录下的文件恰恰是最需要被看见的（见 .gitattributes 里的说明）。",
    );
  }
  process.exit(1);
}

const allowed = inScope.filter((r) => ALLOWLIST.has(r.path)).map((r) => r.path);
console.log(
  `[check-no-binary] ✅ ${inScope.length} 个文件（${SCOPE_PREFIXES.join(", ")}，含未跟踪的新文件），`
  + "全部是文本、且都没有被 `-diff` 从评审包 diff 里屏蔽"
  + (allowed.length > 0
    // 放行必须打在屏幕上：一条没人看得见的放行，下一次就会被当成"本来就没有二进制文件"。
    ? `\n[check-no-binary] ℹ️ 具名放行 ${allowed.length} 个：${allowed.join(", ")}`
      + "（它们由 `node scripts/check-png.mjs` 逐字节审，不是没人管）"
    : ""),
);
