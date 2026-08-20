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
// ——`git grep -Il` 只会列出能被当文本搜索的跟踪文件，用 `git ls-files` 的全集
// 减去这个子集就是 git 判定为二进制的那些（空文件单独处理，见下）。这是本仓
// "反同义反复"的同一条纪律：期望侧从 git 自己的判据来，不在这里重新实现一遍
// git 的二进制探测算法（重实现的算法判错时给出的是静默的错误答案）。

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const SCOPE_PREFIXES = ["src/", "tests/", "admin-ui/", "scripts/", "docs/"];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const allTracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
const inScope = allTracked.filter((f) => SCOPE_PREFIXES.some((p) => f.startsWith(p)));

// `git grep -Il` 只匹配"至少有一行内容"的文本文件——空文件天然匹配不到任何东西，
// 但它不是二进制，单独用文件大小排除，不然会被误判成"二进制"。
const emptyInScope = new Set(
  inScope.filter((f) => {
    try {
      return statSync(f).size === 0;
    } catch {
      return false; // 读不到就交给下面的正常流程处理（大概率是已经被删but仍在索引里的边角情况）
    }
  }),
);

let textInScope = new Set();
if (inScope.length > 0) {
  try {
    // 匹配"至少一个字符"的正则，对任何非空文本文件必然命中；`-z` 让文件名以 NUL
    // 分隔，避免路径里带空格时被切错。`git grep` 在没有任何匹配时退出码是 1，
    // 不是错误——用 try/catch 接住，不当异常处理。
    const out = execFileSync("git", ["grep", "-Ilz", "-E", ".", "--", ...inScope], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    textInScope = new Set(out.split("\0").filter(Boolean));
  } catch (e) {
    if (e.status === 1) {
      textInScope = new Set(); // 一个匹配都没有：意味着 inScope 里全是二进制/空文件
    } else {
      throw e;
    }
  }
}

const binaryInScope = inScope.filter((f) => !textInScope.has(f) && !emptyInScope.has(f));

if (binaryInScope.length > 0) {
  console.error("[check-no-binary] ❌ 以下跟踪文件被 git 判定为二进制，不允许出现在这些目录下：");
  for (const f of binaryInScope) console.error(`  ${f}`);
  console.error(
    "[check-no-binary] 多半是某个字符串字面量里混进了不可见/控制字符（例如 NUL），" +
    "改成转义写法或可打印字符即可回到文本——见本文件头部的说明（评审 F3）。",
  );
  process.exit(1);
}

console.log(`[check-no-binary] ✅ ${inScope.length} 个跟踪文件（${SCOPE_PREFIXES.join(", ")}），全部是文本`);
