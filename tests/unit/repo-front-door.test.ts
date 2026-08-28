import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
// SECURITY.md 写下的那个「12 小时」一律从真源现算，不手抄。
import { SESSION_MAX_AGE_MS, sessionExpired } from "../../admin-ui/js/pure/session.mjs";

/**
 * ── 公开仓的门面（P3e Task 29A）──────────────────────────────────────────────
 *
 * 这一组守的是**陌生人第一次打开这个仓**那条路上的几件事，它们此前一件都没有机器看着：
 *
 * · **(a) 社区文件在不在——而「有哪几份」这件事本身从磁盘现算**：
 *   `CONTRIBUTING.md`、`SECURITY.md`、`.github/pull_request_template.md` 这三份的位置
 *   由 GitHub 定死；issue 模板那一档取 `.github/ISSUE_TEMPLATE/` 下的**全量**，不写死清单。
 *   ⚠️ **复评 F2 就栽在这儿**：上一版把五份社区文件写成一张冻结的字面量表，于是往
 *   `.github/ISSUE_TEMPLATE/` 里新加第六份模板（那正是本仓最会长文件的目录）、里面
 *   死链 / 查无此处的仓内路径 / 不存在的 `pnpm` 命令三种错一起犯——**二十余格全绿**。
 *   现在射程从磁盘长出来，并另配一条「表 == 磁盘」断言逼新文件回来表态；那条断言的
 *   写法抄自 `tests/unit/docs-parity.test.ts` 的
 *   「R1 五个语言目录下同名文件都存在，且 DOCS 表恰好等于 zh-CN 目录的 .md 全集」。
 *   ⚠️ **判据不是「文件非空」**：一份只有标题的 `SECURITY.md` 比没有更糟——它向读者
 *   承诺了一条不存在的上报流程。所以 `SECURITY.md` 还要真的写出**去哪儿报**。
 * · **(b) `SECURITY.md` 不许把仓库纪律说成运行时安全承诺**。本仓的「零内置凭据」是
 *   **仓库纪律**（`scripts/scan-secrets.sh` 那道门禁），它和「这个网关跑起来是安全的」
 *   是两件事；后者本仓给不出，写下去就是一句假话。
 * · **(c) README 顶部那枚 CI 徽章指向的 workflow 真的存在**。徽章是首屏第一眼，指错了
 *   会常年显示 “no status”，而没有任何东西会因此变红。
 * · **(d) node 大版本在所有钉它的地方彼此相等**：`Dockerfile` 的 `FROM node:<大版本>-…`、
 *   `.github/workflows/` 下**每一份** yml 里的每一处 `node-version:`、`package.json` 的
 *   `engines.node`。
 *   ⚠️ **处数不写进这段话**（复评 F9：上一版写「三处」，而报文实际摆出来的是六个取值，
 *   且随 workflow 数量增长）——要处数就去看报文，它把每一处逐个摆出来。
 *   ⚠️ 判据是**这些取值彼此相等**，不是「有没有 `engines` 字段」——后者填个 `>=1` 也能绿。
 * · **(e) tracked 的 `*.md` 与 `*.sh` 里对工作账本 `.superpowers` 的引用必须自带溯源限定**。
 *   ⚠️ **判据不是「不许引用」**：那些引用是真实的溯源记录，删掉等于抹掉出处。
 *   判据是「引用它的文件必须自己说清读者打不开」——把一条死链变成一条诚实的标注。
 *   该目录被 `.gitignore` 排除（`git ls-files .superpowers` = 0），公开仓读者点不开它。
 *   ⚠️ **`.sh` 那一半是 Task 34 复评 F5 补的**，理由写在 `trackedProse()` 上：
 *   `.md` 与 `.ts/.js/.mjs` 两侧各有门禁，`.sh` 正好漏在中间，于是同一个问题被原样搬了进去。
 *   ⚠️ 限定串是一个**候选集**（中英各一版），且报文把候选逐条摆出来。复评 F5 实测出
 *   上一版的两个毛病：文档里明明写了「读者打不开它」，报文却断言「却没说读者打不开」；
 *   而真正要求的那个字面串在报文里一次都没出现，且只认中文——英文文档要变绿只能塞中文。
 *
 * 另有几条是**为这一轮新写下的话**配的测法——写档位就连测法一起写，这是本期的纪律：
 *
 * · **(f) 社区文件里写下的每一条仓内指向都得解析得开**，`pnpm <名字>` 也必须是
 *   `package.json` 里真有的 script。这批散文是**唯一一批不进 `scripts/check-comment-refs.mjs`
 *   射程**的（那道门禁的 `SCAN_DIRS` 只收 `.ts/.js/.mjs`），而它们恰恰最爱写「见某某文件」。
 * · **(f2) issue / PR 模板里跨文件的指路一律写成绝对链接**，且 `<owner>/<repo>` 必须与
 *   `package.json` 的 `repository` 一致、`blob/main/` 之后那段必须在仓里真的存在；
 *   反过来，这几份文件里**一条跨文件的相对链接都不许剩**（「一律」这两个字的另一半，
 *   只查绝对链接对不对是挡不住有人再加一条相对的）。
 *   ⚠️ 理由是复评 F6：这三份模板的正文**不只在仓库文件视图里被渲染**，它会被整段塞进
 *   issue / PR 的正文，而那里的相对链接由浏览器按 issue / PR 的 URL 解析
 *  （`.github/ISSUE_TEMPLATE/` 下的 `../../SECURITY.md` 会落到 `/<owner>/SECURITY.md`）
 *   ⇒ **格子全绿而屏幕上是死链**，与 P3d「就地更新够不着盒子外的节点」同一族。
 *   绝对链接在两个面上都成立，代价是多这一条判据看着它。
 * · **(g) 社区文件里那几句「这件事由某某守着」必须点得出是哪一格**：用本仓的名字锚写法，
 *   引契约用例时标题要逐字对得上 `it("…"`，引其它文件时那段文字要逐字在那个文件里。
 *   会话上限那个「12 小时」同样从 `SESSION_MAX_AGE_MS` 现算，不手抄。
 *
 * ── 判据只有一份，反向控制从同一份进 ────────────────────────────────────────
 * 每条判据都写成 `(read, exists, list) => 失败报文[]` 的纯函数，真扫描传真 fs，反向控制传
 * 打过补丁的 `read` / `exists` / `list`。**没有第二份判据**，所以「探针绿了而真扫描是另一套
 * 逻辑」这种事在这里不成立。
 * ⚠️ `list`（目录列举）是复评 F10 补的第三个注入点：上一版 (g) 直接调真 `existsSync` /
 * `readFileSync` 去读被引文件，绕开了文件头自己声明的唯一注入点，于是「被引文件改名或被删」
 * 那一侧没法用同一套注入做反向控制。
 * 每一格反向控制在变异之前先跑一遍**基**：基本身就红的话，报文会直说「先去看真扫描那一格」，
 * 而不是让人从变异那一格的报文里找原因。
 *
 * ── 它做不到什么（明写，别读成「门面从此都是真的」）────────────────────────────
 * · (a) 只查**上报路径这句话在不在**，不查那条路径今天通不通——GitHub 侧把 Security
 *   Advisory 关掉了，这里一个字都不会吭。**推仓当天必须人手确认那个开关**，
 *   已登记在 Task 34A Step 6 的 L7。
 * · (b) 是**子串匹配的黑名单**，不是语义判断：换一句没在 `SOFT` 表里的措辞
 *   （“battle-tested”、“无需担心”）照样能把同一个意思写进去，它看不见。
 *   这条边界没有护栏，登记为已知盲点。
 * · (c) 只查**徽章指的 workflow 文件在不在**，不查那个 workflow 今天跑不跑得起来、
 *   更不查徽章链接点过去落在哪个分支。
 * · (d) 只查**这些取值彼此相等**，不查这个大版本本身是不是还在维护期。
 * · (e) 只查**「引用了」与「有没有那句限定」这两件事的共现**，不查那句限定写在哪儿。
 *   把限定塞进文件最后一行、读者读到死链时根本没看到它——这里照样绿。
 *   ⚠️ 更要紧的一条：它**只认 tracked 的 `*.md` 与 `*.sh`**。同一条死引用写进 `src/**.ts`
 *   或 `admin-ui/**.js` 的注释里它一眼都不看（那一侧归 `scripts/check-comment-refs.mjs`
 *   那道门禁管，而它的 `REPO_PREFIXES` 里没有 `.superpowers/`，两边合起来仍有这个洞）。
 *   `*.yml` 同样两边都不在射程里。
 * · (f) 只查**路径解析得开**，不查那份文件里真有它被引来说明的那件事；`pnpm` 那一半只查
 *   script 名字在不在，不查参数、也不查这个命令今天跑不跑得通。
 *   ⚠️ 还有一类它**故意**不收：首段不是仓里的顶层目录、末段又不带扩展名的 code span
 *   （`pnpm/action-setup`、`actions/setup-node` 就长这样）。收了就会把外部名字判成死链。
 *   代价是同样形态的假仓内路径也跟着漏掉，这条边界由下面「不乱红」那一格钉着**今天的行为**。
 * · (f2) 只查**绝对链接的形态与落点**，**不查 GitHub 那一面到底怎么渲染**——本机验不到，
 *   推仓当天仍须在真 issue / PR 页面上人手点一次，已登记在 Task 34A Step 6 的 L8。
 *   它也不查 `main` 这个分支名今天存不存在于远端。
 * · (g) 只查**被引的那段文字今天还在**，不查那条用例真的守着社区文件声称的那件事——
 *   一条改成 `expect(1).toBe(1)` 的用例，标题不动的话这里照样绿。
 * · 整组都**只看仓库里的文本**：GitHub 侧的设置（Security Advisory 开没开、issue 模板认不认）
 *   一个字都验不到。
 */

type Read = (p: string) => string;
type Exists = (p: string) => boolean;
type List = (dir: string) => string[];

const realRead: Read = (p) => readFileSync(p, "utf8");
const realExists: Exists = (p) => existsSync(p);
const realList: List = (d) => readdirSync(d);

/** 把某一份文件的内容换成变异版，其余照旧。**变异的唯一注入点之一**。 */
const patchRead = (base: Read, at: string, body: string): Read => (p) => (p === at ? body : base(p));
/** 把某一份文件变成「不存在」，其余照旧。 */
const hideFile = (base: Exists, at: string): Exists => (p) => (p === at ? false : base(p));
/** 把某个目录的列举结果换成变异版，其余照旧。 */
const patchList = (base: List, at: string, names: readonly string[]): List => (p) => (p === at ? [...names] : base(p));

/**
 * 变异格的基自检：真仓今天必须过这条判据，否则这一格报的就不是变异的事。
 * 与真扫描共用同一份 `failures`，不另写一份。
 */
function probeBase(failures: string[], realCase: string): void {
  if (failures.length > 0) {
    throw new Error(
      "本格是探针，它的基取自真仓，而真仓今天本身就不过这条判据 —— "
      + `别从这一格的报文里找原因，真因在「${realCase}」那一格：\n${failures.join("\n")}`,
    );
  }
}

/* ── (a) 社区文件 ─────────────────────────────────────────────────────────── */

const ISSUE_TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";

/** 位置由 GitHub 定死的那三份，不会长出第二份。 */
const COMMUNITY_FIXED: readonly string[] = [
  "CONTRIBUTING.md",
  "SECURITY.md",
  ".github/pull_request_template.md",
];

/**
 * 今天**该有**哪几份社区文件。这张表不负责决定射程（射程见 `communityFiles`，从磁盘现算），
 * 它只负责「表 == 磁盘」那条断言的另一侧：加了一份新模板而没回来改这张表 ⇒ 红。
 */
const COMMUNITY_TABLE: readonly string[] = [
  ...COMMUNITY_FIXED,
  `${ISSUE_TEMPLATE_DIR}/bug_report.md`,
  `${ISSUE_TEMPLATE_DIR}/feature_request.md`,
].sort();

/**
 * 社区文件的**射程**：三份固定的 + `.github/ISSUE_TEMPLATE/` 下的全量。
 * 固定那三份即使磁盘上不在也留在射程里——「它不在」正是 (a) 要报的事，不是「不用管」。
 */
function communityFiles(list: List): string[] {
  const templates = list(ISSUE_TEMPLATE_DIR)
    .filter((n) => n.endsWith(".md"))
    .map((n) => `${ISSUE_TEMPLATE_DIR}/${n}`);
  if (templates.length === 0) {
    throw new Error("`.github/ISSUE_TEMPLATE/` 下一份 issue 模板都没扫到 —— 扫描坏了，不许静默当成「本仓不提供 issue 模板」");
  }
  return [...COMMUNITY_FIXED, ...templates].sort();
}

/** 「表 == 磁盘」。写法与 `tests/unit/docs-parity.test.ts` 的 R1 同款。 */
function communityInventoryFailure(list: List): string | null {
  const onDisk = communityFiles(list);
  const want = [...COMMUNITY_TABLE].sort();
  if (JSON.stringify(onDisk) === JSON.stringify(want)) return null;
  const extra = onDisk.filter((f) => !want.includes(f));
  const missing = want.filter((f) => !onDisk.includes(f));
  return "社区文件的磁盘全集与 COMMUNITY_TABLE 对不上 —— 新增一份社区文件要回来表态，"
    + `否则没人会去看它写了什么：磁盘多出 ${JSON.stringify(extra)}，表里多出 ${JSON.stringify(missing)}`;
}

/** 「去哪儿报」那句话。GitHub 的功能名或「私下 / 非公开」的说法，任一即可。 */
const REPORT_PATH_RE = /Security Advisor|security advisor|私下|privately|非公开/i;

function communityFailures(exists: Exists, read: Read, list: List): string[] {
  const out = communityFiles(list).filter((f) => !exists(f)).map((f) => `${f} 不存在`);
  const inventory = communityInventoryFailure(list);
  if (inventory) out.push(inventory);
  if (!exists("SECURITY.md")) return out;
  if (!REPORT_PATH_RE.test(read("SECURITY.md"))) {
    out.push("SECURITY.md 没写去哪儿报 —— 一份只有标题的安全政策，比没有更糟");
  }
  return out;
}

/**
 * 社区文件里今天读得到的那几份、读不到的那几份。
 * ⚠️ **缺文件不许让别的格子抛裸 `ENOENT`**（复评 F11 实测：真删 `SECURITY.md` 之后 18 格红，
 * 只有 (a) 给了人话，其余抛 `ENOENT: no such file or directory`）——文件不存在这件事已经由
 * (a) 逐份点名了，别的格子再抛一次只会把人从「谁缺了」引到「哪行代码炸了」。
 */
function splitPresent(exists: Exists, list: List): { present: string[]; missing: string[] } {
  const all = communityFiles(list);
  return { present: all.filter((f) => exists(f)), missing: all.filter((f) => !exists(f)) };
}

const missingNote = (missing: readonly string[], what: string) =>
  `${missing.join("、")} 不存在 —— ${what}无从查起，先看 (a) 那一格`;

/* ── (b) 别把仓库纪律说成运行时安全承诺 ───────────────────────────────────── */

const SOFT = ["is secure", "完全安全", "绝对安全", "安全です", "안전합니다"];

function softClaims(read: Read, exists: Exists): string[] {
  if (!exists("SECURITY.md")) return [missingNote(["SECURITY.md"], "运行时安全承诺这件事")];
  const sec = read("SECURITY.md").toLowerCase();
  return SOFT.filter((w) => sec.includes(w.toLowerCase())).map((w) => `SECURITY.md 里出现「${w}」`);
}

/* ── (c) CI 徽章 ──────────────────────────────────────────────────────────── */

const BADGE_RE = /workflows\/([A-Za-z0-9_.-]+\.yml)\/badge\.svg/g;

function badgeFailures(read: Read, exists: Exists): string[] {
  const names = [...read("README.md").matchAll(BADGE_RE)].map((m) => m[1]!);
  if (names.length === 0) {
    return ["README.md 里一枚 workflow 状态徽章都没有（找不到 `workflows/<名字>.yml/badge.svg`）"];
  }
  return names
    .filter((n) => !exists(`.github/workflows/${n}`))
    .map((n) => `README.md 的徽章指向 .github/workflows/${n}，而那个 workflow 不存在`);
}

/* ── (d) node 大版本在所有钉它的地方彼此相等 ──────────────────────────────── */

interface MajorAt { where: string; major: string }

/** `.github/workflows/` 下的 yml，**从磁盘扫**，不写死清单——加第四个 workflow 时它自动进射程。 */
function workflowFiles(list: List): string[] {
  return list(".github/workflows").filter((f) => f.endsWith(".yml")).sort();
}

function nodeMajors(read: Read, list: List): MajorAt[] {
  const out: MajorAt[] = [];
  const pull = (where: string, body: string, re: RegExp): number => {
    let n = 0;
    for (const m of body.matchAll(re)) {
      out.push({ where, major: m[1]! });
      n += 1;
    }
    return n;
  };

  if (pull("Dockerfile 的 `FROM node:<大版本>-…`", read("Dockerfile"), /node:(\d+)[.-]/g) === 0) {
    throw new Error("Dockerfile 里一处 `node:<大版本>-` 都没认出来 —— 判据坏了，不许静默当成「这里没有约束」");
  }
  let ci = 0;
  for (const f of workflowFiles(list)) {
    ci += pull(`.github/workflows/${f} 的 node-version`, read(`.github/workflows/${f}`), /node-version:\s*(\d+)/g);
  }
  if (ci === 0) {
    throw new Error("`.github/workflows/` 下一处 `node-version:` 都没认出来 —— 判据坏了，不许静默当成「CI 不钉 node 版本」");
  }

  const engines = (JSON.parse(read("package.json")) as { engines?: { node?: string } }).engines;
  const declared = engines?.node;
  if (declared === undefined) {
    out.push({ where: "package.json 的 engines.node", major: "（缺失）" });
    return out;
  }
  const m = /(\d+)/.exec(declared);
  out.push({ where: "package.json 的 engines.node", major: m ? m[1]! : `（从 "${declared}" 里读不出大版本）` });
  return out;
}

function nodeMajorFailures(read: Read, list: List): string[] {
  const all = nodeMajors(read, list);
  if (new Set(all.map((s) => s.major)).size === 1) return [];
  return [`node 大版本在这几处对不上：${all.map((s) => `${s.where} = ${s.major}`).join("；")}`];
}

/* ── (e) 工作账本引用的溯源限定 ───────────────────────────────────────────── */

/**
 * 射程判据用的是**裸 `.superpowers`**，不是 `.superpowers/`。
 * 需求书写的是带斜杠那版，落地实测推翻了它：`docs/design/2026-08-15-agnes2api-p2-registrar-plan.md`
 * 里那 8 处是 `git add -A -- . ':!.superpowers'`（pathspec 排除，**不带斜杠**），带斜杠的判据
 * 一处都扫不到它——而同一份需求书的 Step 4 又要求 P2 也加限定。两句自相矛盾，按**更宽的那一侧**
 * 落地：宽的那一侧扫得到 P2，窄的那一侧扫不到。
 */
const LEDGER = ".superpowers";

/**
 * 溯源限定的**候选集**，任一出现即算数。
 * ⚠️ **中英各留一版是复评 F5 的处置**：`CONTRIBUTING.md` / 根 `README.md` / `docs/en/**` 都是
 * 英文文档，只认中文串的话，它们哪天要合法引用工作账本，**只能塞一句中文**才能变绿。
 * 英文那一版今天没有消费者，但它不是摆设：下面「(e) 英文候选也算数」那一格用真形态验它。
 */
const NOTES: readonly string[] = ["不随仓库推送", "not pushed to the public repository"];
/** 本计划文件。它自己就是引用大户，**判据必须不放过它**。 */
const PLAN = "docs/design/2026-08-22-agnes2api-p3e-i18n-and-closeout-plan.md";

/** 报文里把候选逐条摆出来——复评 F5：真正的要求在上一版报文里一次都没出现过。 */
const notesHint = () => NOTES.map((n) => `「${n}」`).join(" 或 ");

/**
 * 射程 = tracked 的 `*.md` **与 `*.sh`**。
 *
 * ⚠️ **`.sh` 那一半是 Task 34 复评 F5 补的**：那一轮在 `scripts/prepush.sh` 的注释里新写下
 * 两条指向 `.superpowers/…` 的引用，而两边的门禁正好把 `.sh` 漏在中间——本格上一版
 * 只认 tracked 的 `*.md`，`scripts/check-comment-refs.mjs` 的 `walk()` 又自己写明
 * 「`.sh` 与 `.yml` 一个文件都不打开」⇒ [V7] 刚在 `.md` 那一侧解决掉的问题被原样搬进了 `.sh`，
 * **没有任何机器看得见**。
 * ⚠️ 剩下的洞照旧登记在文件头：`src/**.ts` / `admin-ui/**.js` 的注释仍然不在任何一侧的射程里。
 */
function trackedProse(): string[] {
  const raw = execFileSync("git", ["ls-files", "-z", "--", "*.md", "*.sh"], { encoding: "utf8" });
  const files = raw.split("\0").filter(Boolean);
  if (files.length === 0) {
    throw new Error("`git ls-files -- '*.md' '*.sh'` 一个文件都没列出来 —— 扫描坏了，不许静默当成空集");
  }
  if (!files.some((f) => f.endsWith(".sh"))) {
    throw new Error("射程里一个 `.sh` 都没有 —— 那一半被谁收窄掉了，不许静默放行");
  }
  return files;
}

/** git 索引里有、磁盘上却读不到的那几份。它们不是「限定缺失」，报文必须分开说。 */
const ledgerUnreadable = (files: readonly string[], exists: Exists): string[] =>
  files.filter((f) => !exists(f));

const ledgerReferrers = (files: readonly string[], read: Read, exists: Exists): string[] =>
  files.filter((f) => exists(f) && read(f).includes(LEDGER));

const ledgerUnqualified = (files: readonly string[], read: Read, exists: Exists): string[] =>
  ledgerReferrers(files, read, exists).filter((f) => !NOTES.some((n) => read(f).includes(n)));

/* ── (f) 社区文件写下的每一条仓内指向都得解析得开 ──────────────────────────── */

/**
 * 社区文件是**唯一一批不进 `scripts/check-comment-refs.mjs` 射程**的散文（那道门禁的 `SCAN_DIRS` 只收
 * `.ts/.js/.mjs`），而它们恰恰是最爱写「见某某文件」的一批。这里补上同一件事的 markdown 侧。
 *
 * 两种形态都收，因为两种都在这几份文件里真的出现了：
 * · markdown 相对链接 `[文字](路径)` —— **按所在文件的目录解析**，
 *   `.github/ISSUE_TEMPLATE/bug_report.md` 里那种 `../../` 只有这样才判得对；
 * · 行内 code span 里的仓内路径（`scripts/scan-secrets.sh` 这种）。
 *
 * ⚠️ **「像不像仓内路径」这件事不写死**（复评 F2 的另一半）：上一版只认「首段是一张写死的
 * 顶层目录表里的名字」，于是 `packages/gateway/index.ts` / `deploy/nope.yaml` 这类查无此目录的
 * 假路径被静默跳过。现在两条规则取并集：
 * ① 首段是 `git ls-files` 现算出来的**真实顶层目录**（这一条不再写死，加一个顶层目录时自动进射程）；
 * ② 末段带文件扩展名（`foo/bar.ts`）——首段不是顶层目录也照收。
 * `pnpm/action-setup` / `actions/setup-node` 这类外部名字两条都不沾（首段不是顶层目录、末段没扩展名），
 * 仍然被跳过，这正是 ② 要保留的那条边界。
 */
const LINK_RE = /\]\(([^)\s]+)\)/g;
const CODE_PATH_RE = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?)`/g;
/** 末段带扩展名 ⇒ 它自称是一个文件，那就得真的解析得开。 */
const FILE_TAIL_RE = /\.[A-Za-z0-9]{1,6}$/;

/** 仓里真实存在的顶层目录，从 `git ls-files` 现算。 */
function topLevelDirs(): string[] {
  const raw = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  const files = raw.split("\0").filter(Boolean);
  if (files.length === 0) {
    throw new Error("`git ls-files` 一个文件都没列出来 —— 扫描坏了，不许静默当成空集");
  }
  const dirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]!))].sort();
  if (dirs.length === 0) {
    throw new Error("`git ls-files` 扫不出任何顶层目录 —— 扫描坏了，不许静默当成「这个仓是平的」");
  }
  return dirs;
}

const looksLikeRepoPath = (t: string, topDirs: readonly string[]): boolean =>
  topDirs.includes(t.split("/")[0]!) || FILE_TAIL_RE.test(t);

function communityRefs(read: Read, exists: Exists, list: List): { from: string; target: string; resolved: string }[] {
  const topDirs = topLevelDirs();
  const out: { from: string; target: string; resolved: string }[] = [];
  for (const from of splitPresent(exists, list).present) {
    const body = read(from);
    const here = dirname(from);
    for (const m of body.matchAll(LINK_RE)) {
      const t = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("#")) continue;
      out.push({ from, target: t, resolved: normalize(join(here, t)) });
    }
    for (const m of body.matchAll(CODE_PATH_RE)) {
      const t = m[1]!;
      if (!looksLikeRepoPath(t, topDirs)) continue;
      out.push({ from, target: t, resolved: normalize(t) });
    }
  }
  return out;
}

function communityRefFailures(read: Read, exists: Exists, list: List): string[] {
  const { missing } = splitPresent(exists, list);
  const refs = communityRefs(read, exists, list);
  if (refs.length === 0) {
    if (missing.length > 0) return [missingNote(missing, "仓内指向")];
    throw new Error("社区文件里一条仓内指向都没抠出来 —— 判据坏了，不许静默当成「它们没提任何文件」");
  }
  const out = refs
    .filter((r) => !exists(r.resolved))
    .map((r) => `${r.from} 指向 ${r.target}（解析成 ${r.resolved}），而那个位置不存在`);
  if (missing.length > 0) out.push(missingNote(missing, "这几份文件里的仓内指向"));
  return out;
}

/** 社区文件里写下的 `pnpm <名字>` 必须是 `package.json` 里真有的 script。 */
const PNPM_RE = /`pnpm ([a-z][a-z0-9:_-]*)`/g;

function pnpmScriptFailures(read: Read, exists: Exists, list: List): string[] {
  const scripts = (JSON.parse(read("package.json")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  const { present, missing } = splitPresent(exists, list);
  const out: string[] = [];
  let seen = 0;
  for (const from of present) {
    for (const m of read(from).matchAll(PNPM_RE)) {
      seen += 1;
      const name = m[1]!;
      if (!(name in scripts)) out.push(`${from} 让人跑 \`pnpm ${name}\`，而 package.json 里没有这个 script`);
    }
  }
  if (seen === 0) {
    if (missing.length > 0) return [missingNote(missing, "`pnpm <名字>` 这件事")];
    throw new Error("社区文件里一条 `pnpm <名字>` 都没抠出来 —— 判据坏了，不许静默当成「它们没写任何命令」");
  }
  if (missing.length > 0) out.push(missingNote(missing, "这几份文件里的 `pnpm <名字>`"));
  return out;
}

/* ── (f2) issue / PR 模板里跨文件的指路必须是绝对链接，且落点在仓里 ────────── */

/**
 * `<owner>/<repo>` 从 `package.json` 的 `repository` 现算，不手抄——仓改名时两边一起动，
 * 否则模板里那几条绝对链接会集体指向一个不存在的仓而没人吭声。
 */
function repoSlug(read: Read): string {
  const url = (JSON.parse(read("package.json")) as { repository?: { url?: string } }).repository?.url ?? "";
  const m = /github\.com[/:]([^/\s]+\/[^/.\s]+)/.exec(url);
  if (!m) {
    throw new Error(`package.json 的 repository.url 里读不出 <owner>/<repo>（拿到的是 "${url}"）—— 判据坏了`);
  }
  return m[1]!;
}

const BLOB_RE = /https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/blob\/main\/([^)\s#]+)/g;
/** 正文会被塞进 issue / PR 页面渲染的那几份，相对链接在那一面解析不到仓库根。 */
const RENDERED_OFF_TREE = (list: List): string[] =>
  communityFiles(list).filter((f) => f.startsWith(".github/"));

function repoBlobFailures(read: Read, exists: Exists, list: List): string[] {
  const slug = repoSlug(read);
  const targets = RENDERED_OFF_TREE(list);
  const missing = targets.filter((f) => !exists(f));
  const out: string[] = [];
  let seen = 0;
  for (const from of targets.filter((f) => exists(f))) {
    const body = read(from);
    for (const m of body.matchAll(BLOB_RE)) {
      seen += 1;
      const got = m[1]!;
      const path = m[2]!;
      if (got !== slug) {
        out.push(`${from} 的绝对链接指向 ${got}，而 package.json 说本仓是 ${slug}`);
      } else if (!exists(path)) {
        out.push(`${from} 的绝对链接指向 ${path}，而仓里没有这个位置`);
      }
    }
    // 「一律绝对」的另一半：这几份文件里**不许**再留跨文件的相对链接。
    for (const m of body.matchAll(LINK_RE)) {
      const t = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("#")) continue;
      out.push(
        `${from} 里还留着相对链接 ${t} —— 这份文件的正文会被塞进 issue / PR 的正文渲染，`
        + `那里的相对链接由浏览器按那个页面的 URL 解析，够不到仓库根；`
        + `请改写成 https://github.com/${slug}/blob/main/<路径> 这种绝对链接`,
      );
    }
  }
  if (seen === 0) {
    if (missing.length > 0) return [missingNote(missing, "绝对链接")];
    throw new Error(
      "issue / PR 模板里一条 `https://github.com/<owner>/<repo>/blob/main/…` 都没抠出来 —— "
      + "要么判据坏了，要么有人把它们改回了相对链接。相对链接在 issue / PR 正文里由浏览器按那个页面的 "
      + "URL 解析，够不到仓库根，屏幕上就是死链",
    );
  }
  if (missing.length > 0) out.push(missingNote(missing, "这几份文件里的绝对链接"));
  return out;
}

/* ── (g) 社区文件里的名字锚，被引的那段文字必须逐字对得上 ──────────────────── */

/**
 * 一个仓内路径，紧跟着用 「」 括起来的一段文字 —— 本仓的名字锚写法，这里把它用在 markdown 那一侧。
 * ⚠️ 这段注释刻意不举字面例子：举一个就要么指向一个不存在的文件（那道注释指向门禁会当场红），
 * 要么把某份真测试写进一段与它无关的说明里。
 * ⚠️ 引契约用例时判据更严一档：那段文字必须是一条**用例标题**（`it("…"`），不是文件里随便一段话。
 */
const NAME_ANCHOR_RE = /`((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)`「([^」]+)」/g;
const CONTRACT_CASE_RE = /^tests\/contract\/[A-Za-z0-9_.-]+\.test\.ts$/;

function citedAnchorFailures(read: Read, exists: Exists, list: List): string[] {
  const { present, missing } = splitPresent(exists, list);
  const out: string[] = [];
  let seen = 0;
  for (const from of present) {
    for (const c of read(from).matchAll(NAME_ANCHOR_RE)) {
      seen += 1;
      const file = c[1]!;
      const title = c[2]!;
      if (!exists(file)) {
        out.push(`${from} 引了 ${file}，而那个文件不存在`);
        continue;
      }
      const body = read(file);
      if (CONTRACT_CASE_RE.test(file)) {
        if (!body.includes(`it("${title}"`)) out.push(`${from} 引了 ${file}「${title}」，而那个文件里没有这条用例`);
      } else if (!body.includes(title)) {
        out.push(`${from} 引了 ${file}「${title}」，而那个文件里没有这段文字`);
      }
    }
  }
  if (seen === 0) {
    if (missing.length > 0) return [missingNote(missing, "名字锚")];
    throw new Error(
      "社区文件里一条名字锚都没抠出来 —— 要么判据坏了，"
      + "要么那几句「这件事由某某守着」被改成了空口白话，两种都该有人来看",
    );
  }
  if (missing.length > 0) out.push(missingNote(missing, "这几份文件里的名字锚"));
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */

describe("公开仓的门面：社区文件 / CI 徽章 / node 大版本 / 工作账本的溯源限定", () => {
  const REAL_A = "公开仓的社区文件都在，且 SECURITY.md 里有一条可用的上报路径";
  const REAL_B = "SECURITY.md 不把仓库纪律说成运行时安全承诺";
  const REAL_C = "README 的 CI 徽章指向 .github/workflows 下真的存在的那个 workflow";
  const REAL_D = "Dockerfile / CI / package.json 钉的 node 大版本彼此相等";
  const REAL_E = "引用工作账本 .superpowers 的 tracked 文档都写明了它不随仓库推送";
  const REAL_H = "docker-compose.yml 有 build 回退 —— 没有已发布镜像时 `docker compose up -d` 仍跑得起来";
  const COMPOSE = "docker-compose.yml";

  it(REAL_A, () => {
    const failures = communityFailures(realExists, realRead, realList);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(a) 该红时红：SECURITY.md 删到只剩一行标题 —— 报文说的是「没写去哪儿报」，不是「文件不存在」", () => {
    probeBase(communityFailures(realExists, realRead, realList), REAL_A);
    const failures = communityFailures(realExists, patchRead(realRead, "SECURITY.md", "# Security Policy\n"), realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("SECURITY.md 没写去哪儿报");
  });

  it("(a) 该红时红：少一份社区文件 —— 逐份点名，不是只说「有文件缺了」", () => {
    probeBase(communityFailures(realExists, realRead, realList), REAL_A);
    const gone = `${ISSUE_TEMPLATE_DIR}/feature_request.md`;
    const failures = communityFailures(hideFile(realExists, gone), realRead, realList);
    expect(failures).toEqual([`${gone} 不存在`]);
  });

  /**
   * 复评 F2 的正面回应。上一版这里是一张冻结的字面量表，新加第六份模板 ⇒ 二十余格全绿。
   * 现在射程从磁盘长出来，而「表 == 磁盘」那条断言逼新文件回来表态。
   */
  it("(a) 该红时红：`.github/ISSUE_TEMPLATE/` 里凭空多出第六份模板 —— 点名它，不许静默扩容", () => {
    probeBase(communityFailures(realExists, realRead, realList), REAL_A);
    const grown = patchList(realList, ISSUE_TEMPLATE_DIR, [...realList(ISSUE_TEMPLATE_DIR), "question.md"]);
    const failures = communityFailures(realExists, realRead, grown);
    expect(failures.join("\n")).toContain(`${ISSUE_TEMPLATE_DIR}/question.md`);
    expect(failures.join("\n")).toContain("COMMUNITY_TABLE 对不上");
  });

  it("(a) 不乱红：目录列举的顺序变了 —— 排序之后与表相等，不许因此变红", () => {
    const shuffled = patchList(realList, ISSUE_TEMPLATE_DIR, [...realList(ISSUE_TEMPLATE_DIR)].reverse());
    expect(realList(ISSUE_TEMPLATE_DIR).length, "这条控制是空的：目录里只有一份文件，反转看不出顺序").toBeGreaterThan(1);
    expect(communityFailures(realExists, realRead, shuffled)).toEqual([]);
  });

  it("(a) 认不出要吵：issue 模板目录列举为空时当场抛，不静默当成「本仓不提供模板」", () => {
    const blind = patchList(realList, ISSUE_TEMPLATE_DIR, []);
    expect(() => communityFailures(realExists, realRead, blind)).toThrow(/扫描坏了/);
  });

  it(REAL_B, () => {
    const hits = softClaims(realRead, realExists);
    expect(hits, `报文：\n${hits.join("\n")}`).toEqual([]);
  });

  it("(b) 该红时红：SECURITY.md 里写一句 “this gateway is secure”", () => {
    probeBase(softClaims(realRead, realExists), REAL_B);
    const mutated = `${realRead("SECURITY.md")}\n\nThis gateway is secure.\n`;
    const hits = softClaims(patchRead(realRead, "SECURITY.md", mutated), realExists);
    expect(hits).toEqual(["SECURITY.md 里出现「is secure」"]);
  });

  it("(b) 缺文件给人话：SECURITY.md 不存在时报的是人话，不是裸 ENOENT", () => {
    const hits = softClaims(realRead, hideFile(realExists, "SECURITY.md"));
    expect(hits).toHaveLength(1);
    expect(hits[0] ?? "").toContain("先看 (a) 那一格");
  });

  it(REAL_C, () => {
    const failures = badgeFailures(realRead, realExists);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(c) 该红时红：徽章里的 workflow 名改成 nope.yml —— 报文点名 nope.yml", () => {
    probeBase(badgeFailures(realRead, realExists), REAL_C);
    const mutated = realRead("README.md").replace(BADGE_RE, "workflows/nope.yml/badge.svg");
    const failures = badgeFailures(patchRead(realRead, "README.md", mutated), realExists);
    expect(failures).toEqual([".github/workflows/nope.yml"].map((p) => `README.md 的徽章指向 ${p}，而那个 workflow 不存在`));
  });

  it("(c) 该红时红：README 里一枚徽章都没有 —— 「徽章被整条删掉」不许静默通过", () => {
    probeBase(badgeFailures(realRead, realExists), REAL_C);
    const mutated = realRead("README.md").replace(BADGE_RE, "workflows-removed");
    const failures = badgeFailures(patchRead(realRead, "README.md", mutated), realExists);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("一枚 workflow 状态徽章都没有");
  });

  it(REAL_D, () => {
    const failures = nodeMajorFailures(realRead, realList);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(d) 该红时红：Dockerfile 换成 node:20-alpine —— 报文把每一处各自的值都摆出来", () => {
    probeBase(nodeMajorFailures(realRead, realList), REAL_D);
    const mutated = realRead("Dockerfile").replaceAll("node:22-", "node:20-");
    expect(mutated, "变异没落地 —— Dockerfile 里已经不是 node:22-").not.toBe(realRead("Dockerfile"));
    const failures = nodeMajorFailures(patchRead(realRead, "Dockerfile", mutated), realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("Dockerfile");
    expect(failures[0] ?? "").toContain("= 20");
    expect(failures[0] ?? "").toContain("package.json 的 engines.node = 22");
  });

  it("(d) 该红时红：engines 整个删掉 —— 报文说的是「（缺失）」，不是静默放行", () => {
    probeBase(nodeMajorFailures(realRead, realList), REAL_D);
    const pkg = JSON.parse(realRead("package.json")) as Record<string, unknown>;
    delete pkg["engines"];
    const failures = nodeMajorFailures(patchRead(realRead, "package.json", JSON.stringify(pkg)), realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("package.json 的 engines.node = （缺失）");
  });

  /** 扫盘是真跟着真源走的：凭空多一份 workflow，它自动进射程并被点名。 */
  it("(d) 扫盘跟随真源：多出一份钉了别的大版本的 workflow —— 自动进射程并点名那份文件", () => {
    probeBase(nodeMajorFailures(realRead, realList), REAL_D);
    const extra = "extra-publish.yml";
    const grown = patchList(realList, ".github/workflows", [...realList(".github/workflows"), extra]);
    const withBody = patchRead(realRead, `.github/workflows/${extra}`, "jobs:\n  x:\n    steps:\n      - with: { node-version: 20 }\n");
    const failures = nodeMajorFailures(withBody, grown);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain(extra);
    expect(failures[0] ?? "").toContain("= 20");
  });

  it("(d) 认不出要吵：Dockerfile 里认不出 node 大版本时当场抛，不静默当成「这里没有约束」", () => {
    const blind = patchRead(realRead, "Dockerfile", "FROM alpine\n");
    expect(() => nodeMajorFailures(blind, realList)).toThrow(/判据坏了/);
  });

  it("(d) 认不出要吵：workflow 里一处 node-version 都认不出时当场抛", () => {
    const blind = patchList(realList, ".github/workflows", []);
    expect(() => nodeMajorFailures(realRead, blind)).toThrow(/判据坏了/);
  });

  /* ── (h) docker-compose.yml 的 build 回退 ────────────────────────────────
   *
   * `docker-compose.yml` 写的是一个**已发布镜像**的 tag，而镜像发布只在打 `v*` 标签时触发。
   * 推送当天 `git tag` = 0 ⇒ **README 教的那条 `docker compose up -d` 拉不到那个 tag**。
   * fork 之后同理。`build:` 回退把这条路补上：拉不到就本地构建。
   * ⚠️ **判据不是「有没有 build 这个词」**：`context` 与 `dockerfile` 两格都得在，
   *   而且 `dockerfile` 指的那份文件必须真的在仓里 —— 指到一个不存在的 Dockerfile
   *   同样是「陌生人第一天跑不起来」，只是失败得更晚一点。
   * ⚠️ 六份 README 里那句「首个镜像发布前会本地构建」是这条判据的散文侧，
   *   由 (f) 一族看着它写下的仓内指向解析得开；**两侧都不替对方说话**。
   */
  const composeFailures = (read: Read, exists: Exists): string[] => {
    const y = read(COMPOSE);
    const svc = /^\s{4}build:\n([\s\S]*?)(?=^\s{4}\S|^\s{2}\S|\Z)/m.exec(y);
    if (svc === null) return [`${COMPOSE} 里没有 build 回退 —— 没有已发布镜像时 \`docker compose up -d\` 会直接失败`];
    const block = svc[1] ?? "";
    const out: string[] = [];
    if (!/^\s{6}context:\s*\.\s*$/m.test(block)) out.push(`${COMPOSE} 的 build 块里没有 \`context: .\``);
    const df = /^\s{6}dockerfile:\s*(\S+)\s*$/m.exec(block);
    if (df === null) out.push(`${COMPOSE} 的 build 块里没有 \`dockerfile:\``);
    else if (!exists(df[1]!)) out.push(`${COMPOSE} 的 build 块指向 ${df[1]}，而那个文件不在仓里`);
    return out;
  };

  it(REAL_H, () => {
    const failures = composeFailures(realRead, realExists);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /** M1 的机器侧：把那三行删掉 —— 判据必须点名，而不是安安静静放行。 */
  it("(h) 该红时红：把 build 那三行整段删掉 —— 点名「没有已发布镜像时会直接失败」", () => {
    probeBase(composeFailures(realRead, realExists), REAL_H);
    const mutated = realRead(COMPOSE).replace(/^\s{4}build:\n(?:^\s{6}\S.*\n)+/m, "");
    expect(mutated, "变异没落地 —— docker-compose.yml 里已经没有那段 build").not.toBe(realRead(COMPOSE));
    expect(composeFailures(patchRead(realRead, COMPOSE, mutated), realExists)).toHaveLength(1);
    expect(composeFailures(patchRead(realRead, COMPOSE, mutated), realExists)[0] ?? "")
      .toContain("没有 build 回退");
  });

  it("(h) 该红时红：build 指向一份仓里没有的 Dockerfile —— 说的是「那个文件不在仓里」", () => {
    probeBase(composeFailures(realRead, realExists), REAL_H);
    const mutated = realRead(COMPOSE).replace("dockerfile: Dockerfile", "dockerfile: Dockerfile.nope");
    expect(mutated, "变异没落地").not.toBe(realRead(COMPOSE));
    const failures = composeFailures(patchRead(realRead, COMPOSE, mutated), realExists);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("Dockerfile.nope，而那个文件不在仓里");
  });

  it(REAL_E, () => {
    const failures = ledgerUnqualified(trackedProse(), realRead, realExists);
    expect(
      failures,
      `这些文档引用了 ${LEDGER}，却没有在同一份文件里写出溯源限定（${notesHint()} 任一即可）：\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("(e) 射程自守：真的扫到了引用方，而且本计划文件在射程内 —— 它自己就是引用大户", () => {
    const referrers = ledgerReferrers(trackedProse(), realRead, realExists);
    expect(referrers.length, "一份都没扫到，扫描多半写坏了").toBeGreaterThan(0);
    expect(referrers, "本计划文件掉出了射程 —— 判据放过了自己").toContain(PLAN);
  });

  /**
   * Task 34 复评 F5 的正面回应。`scripts/prepush.sh` 的注释里有两条真实的工作账本引用，
   * 它必须落在射程里——否则「`.md` 那一侧解决掉的问题被原样搬进 `.sh`」会再发生一次。
   * ⚠️ 这一格钉的是**射程**（`.sh` 真的被扫到了），不是那两条引用本身；
   * 它们合不合规由上面那格真扫描判。
   */
  it("(e) 射程含 tracked 的 `*.sh`：脚本注释里的工作账本引用同样要被扫到", () => {
    const files = trackedProse();
    const shellFiles = files.filter((f) => f.endsWith(".sh"));
    expect(shellFiles, "射程里一个 `.sh` 都没有 —— 那一半被收窄掉了").not.toEqual([]);
    expect(
      ledgerReferrers(files, realRead, realExists),
      "scripts/prepush.sh 掉出了射程 —— 它的注释里真的引用着工作账本",
    ).toContain("scripts/prepush.sh");
  });

  it("(e) 该红时红（`.sh` 侧）：往脚本里加一条 .superpowers 引用而不加那句限定 —— 点名它", () => {
    const files = trackedProse();
    probeBase(ledgerUnqualified(files, realRead, realExists), REAL_E);
    const victim = "scripts/scan-secrets.sh";
    expect(files, "选错了变异对象：它不在 tracked *.sh 里").toContain(victim);
    expect(ledgerReferrers(files, realRead, realExists), "选错了变异对象：它今天本来就引用了工作账本")
      .not.toContain(victim);
    const mutated = `${realRead(victim)}\n# （变异）出处见 ${LEDGER}/sdd/prepush/history-leak.md。\n`;
    expect(ledgerUnqualified(files, patchRead(realRead, victim, mutated), realExists)).toEqual([victim]);
  });

  it("(e) 该红时红：新加一条 .superpowers 引用而不加那句限定 —— 点名新加的那一份", () => {
    const files = trackedProse();
    probeBase(ledgerUnqualified(files, realRead, realExists), REAL_E);
    const victim = "README.md";
    expect(ledgerReferrers(files, realRead, realExists), "选错了变异对象：README.md 今天本来就引用了工作账本")
      .not.toContain(victim);
    const mutated = `${realRead(victim)}\n\n（变异）出处见 ${LEDGER}/sdd/p3e-backlog.md。\n`;
    expect(ledgerUnqualified(files, patchRead(realRead, victim, mutated), realExists)).toEqual([victim]);
  });

  /**
   * 英文候选不是摆设：同一条引用配上英文限定就该放行。
   * 这一格与上一格共用同一份判据、同一个变异对象，只差那句限定的语言。
   */
  it("(e) 英文候选也算数：同一条引用配一句英文限定 —— 不许红", () => {
    const files = trackedProse();
    probeBase(ledgerUnqualified(files, realRead, realExists), REAL_E);
    const victim = "README.md";
    const english = NOTES.find((n) => !/[\u4e00-\u9fff]/.test(n));
    expect(english, "候选集里没有英文那一版，这条控制是空的").toBeTruthy();
    const mutated = `${realRead(victim)}\n\n(mutation) Provenance: ${LEDGER}/sdd/p3e-backlog.md — that directory is ${english!}.\n`;
    expect(ledgerUnqualified(files, patchRead(realRead, victim, mutated), realExists)).toEqual([]);
  });

  it("(e) 缺文件给人话：git 索引里有而磁盘上读不到时不抛裸 ENOENT，另立一格说清楚", () => {
    const files = trackedProse();
    const gone = "SECURITY.md";
    expect(files, "选错了对象：SECURITY.md 不在 tracked *.md 里").toContain(gone);
    const hidden = hideFile(realExists, gone);
    expect(() => ledgerUnqualified(files, realRead, hidden)).not.toThrow();
    expect(ledgerUnreadable(files, hidden)).toEqual([gone]);
  });

  const REAL_F = "社区文件写下的每一条仓内指向都解析得开";
  const REAL_F2 = "issue / PR 模板里的绝对链接，仓名与落点都对得上";
  const REAL_G = "社区文件里那几条名字锚，文件与被引的文字都对得上";

  it(REAL_F, () => {
    const failures = communityRefFailures(realRead, realExists, realList);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(f) 该红时红：模板里写一条解析不开的相对链接 —— 按**所在文件的目录**解析，报文摆出解析后的位置", () => {
    probeBase(communityRefFailures(realRead, realExists, realList), REAL_F);
    const at = `${ISSUE_TEMPLATE_DIR}/bug_report.md`;
    const mutated = `${realRead(at)}\n\n见 [安全政策](../../nope/SECURITY.md)。\n`;
    const failures = communityRefFailures(patchRead(realRead, at, mutated), realExists, realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain(at);
    expect(failures[0] ?? "").toContain("解析成 nope/SECURITY.md");
  });

  it("(f) 不乱红：同一份模板里那条 ../../ 指到仓库根的真文件 —— 按所在目录解析得开", () => {
    probeBase(communityRefFailures(realRead, realExists, realList), REAL_F);
    const at = `${ISSUE_TEMPLATE_DIR}/bug_report.md`;
    const mutated = `${realRead(at)}\n\n见 [安全政策](../../SECURITY.md)。\n`;
    expect(communityRefFailures(patchRead(realRead, at, mutated), realExists, realList)).toEqual([]);
  });

  /** 复评 F2 的另一半：首段不是顶层目录、但末段带扩展名的假路径不许再被静默跳过。 */
  it("(f) 该红时红：code span 里一条首段查无此目录、末段带扩展名的假路径 —— 点名它", () => {
    probeBase(communityRefFailures(realRead, realExists, realList), REAL_F);
    const at = "CONTRIBUTING.md";
    const fake = ["packages", "gateway", "index.ts"].join("/");
    expect(topLevelDirs(), "选错了变异对象：仓里真有这个顶层目录").not.toContain("packages");
    const mutated = `${realRead(at)}\n\n入口在 \`${fake}\`。\n`;
    const failures = communityRefFailures(patchRead(realRead, at, mutated), realExists, realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain(fake);
  });

  it("(f) 不乱红：`pnpm/action-setup` 这种外部名字不是仓内路径，不许被收进射程", () => {
    probeBase(communityRefFailures(realRead, realExists, realList), REAL_F);
    const at = "CONTRIBUTING.md";
    const mutated = `${realRead(at)}\n\nCI 用的是 \`pnpm/action-setup\` 与 \`actions/setup-node\`。\n`;
    expect(communityRefFailures(patchRead(realRead, at, mutated), realExists, realList)).toEqual([]);
  });

  it("(f) 顶层目录是现算的：`git ls-files` 扫出来的那几个都在，而不是一张冻结的表", () => {
    const dirs = topLevelDirs();
    expect(dirs, "扫盘结果里没有 src —— 判据多半接错了").toContain("src");
    expect(dirs, "扫盘结果里没有 .github —— 以点开头的顶层目录被漏掉了").toContain(".github");
    expect(dirs, "`docs/` 掉出了顶层目录集合").toContain("docs");
  });

  it("社区文件里写下的每一条 `pnpm <名字>` 都是 package.json 里真有的 script", () => {
    const failures = pnpmScriptFailures(realRead, realExists, realList);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(f2) 该红时红：把 `pnpm test:workers` 写成 `pnpm test:worker` —— 点名那份文件与那个名字", () => {
    probeBase(
      pnpmScriptFailures(realRead, realExists, realList),
      "社区文件里写下的每一条 `pnpm <名字>` 都是 package.json 里真有的 script",
    );
    const at = "CONTRIBUTING.md";
    const mutated = realRead(at).replaceAll("`pnpm test:workers`", "`pnpm test:worker`");
    expect(mutated, "变异没落地 —— CONTRIBUTING.md 里已经不写 `pnpm test:workers`").not.toBe(realRead(at));
    const failures = pnpmScriptFailures(patchRead(realRead, at, mutated), realExists, realList);
    expect(failures).toEqual([`${at} 让人跑 \`pnpm test:worker\`，而 package.json 里没有这个 script`]);
  });

  it(REAL_F2, () => {
    const failures = repoBlobFailures(realRead, realExists, realList);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(f2) 该红时红：绝对链接的落点在仓里查无此处 —— 点名那个位置", () => {
    probeBase(repoBlobFailures(realRead, realExists, realList), REAL_F2);
    const at = `${ISSUE_TEMPLATE_DIR}/bug_report.md`;
    const mutated = realRead(at).replace("/blob/main/SECURITY.md", "/blob/main/NOPE-SECURITY.md");
    expect(mutated, "变异没落地 —— 那份模板里已经不是 /blob/main/SECURITY.md").not.toBe(realRead(at));
    const failures = repoBlobFailures(patchRead(realRead, at, mutated), realExists, realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("NOPE-SECURITY.md");
  });

  it("(f2) 该红时红：模板里留下一条跨文件的相对链接 —— 点名它并写出该改成什么", () => {
    probeBase(repoBlobFailures(realRead, realExists, realList), REAL_F2);
    const at = `${ISSUE_TEMPLATE_DIR}/bug_report.md`;
    const mutated = `${realRead(at)}\n\n见 [安全政策](../../SECURITY.md)。\n`;
    const failures = repoBlobFailures(patchRead(realRead, at, mutated), realExists, realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("还留着相对链接 ../../SECURITY.md");
    // 报文里那个「该写成什么」的样板串从 package.json 现算，不在这里手抄第二份仓名。
    expect(failures[0] ?? "").toContain(`https://github.com/${repoSlug(realRead)}/blob/main/`);
  });

  it("(f2) 该红时红：仓改了名而模板没跟上 —— 报文把两边的 <owner>/<repo> 都摆出来", () => {
    probeBase(repoBlobFailures(realRead, realExists, realList), REAL_F2);
    const pkg = JSON.parse(realRead("package.json")) as { repository?: { url?: string } };
    const renamed = { ...pkg, repository: { ...pkg.repository, url: "git+https://github.com/xwteam/agnes2api-renamed.git" } };
    const failures = repoBlobFailures(patchRead(realRead, "package.json", JSON.stringify(renamed)), realExists, realList);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0] ?? "").toContain("agnes2api-renamed");
  });

  it("(f2) 认不出要吵：模板里的绝对链接被改回相对链接时当场抛，不静默放行", () => {
    probeBase(repoBlobFailures(realRead, realExists, realList), REAL_F2);
    const stripped: Read = (p) => realRead(p).replaceAll("https://github.com/", "https://nope.example/");
    expect(() => repoBlobFailures(stripped, realExists, realList)).toThrow(/判据坏了|死链/);
  });

  it(REAL_G, () => {
    const failures = citedAnchorFailures(realRead, realExists, realList);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(g) 该红时红：被引的那条契约用例改了名 —— SECURITY.md 那句「由测试守着」当场变红", () => {
    probeBase(citedAnchorFailures(realRead, realExists, realList), REAL_G);
    const mutated = realRead("SECURITY.md").replace("响应体整段文本里都找不到明文 key", "响应体里找不到明文 key");
    expect(mutated, "变异没落地 —— SECURITY.md 里已经不是那条标题").not.toBe(realRead("SECURITY.md"));
    const failures = citedAnchorFailures(patchRead(realRead, "SECURITY.md", mutated), realExists, realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("tests/contract/admin-keys.test.ts「响应体里找不到明文 key」");
  });

  /**
   * 复评 F1 的守卫：`CONTRIBUTING.md` 那句「收集门禁管到哪儿为止」不许再变回一句好听的假话。
   * 变异落在**被引的那一侧**（把 `tests/global-setup.ts` 里那段实测结论改掉），
   * 这正是上一版做不到的那一半——(g) 当时用真 fs 读被引文件，绕开了唯一注入点。
   */
  it("(g) 该红时红：被引文件里那段实测结论被改掉 —— 引它的社区文件当场变红", () => {
    probeBase(citedAnchorFailures(realRead, realExists, realList), REAL_G);
    const at = "tests/global-setup.ts";
    const anchor = "不校验目录归属本身是否合理";
    expect(realRead(at), "选错了落点：那段文字不在 tests/global-setup.ts 里").toContain(anchor);
    expect(realRead("CONTRIBUTING.md"), "CONTRIBUTING.md 没有引这段文字，这一格是空的").toContain(anchor);
    const mutated = realRead(at).split(anchor).join("（变异抹掉了这段实测结论）");
    const failures = citedAnchorFailures(patchRead(realRead, at, mutated), realExists, realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain(`CONTRIBUTING.md 引了 ${at}「${anchor}」`);
  });

  it("(g) 该红时红：名字锚指向一个不存在的文件 —— 说的是「那个文件不存在」", () => {
    probeBase(citedAnchorFailures(realRead, realExists, realList), REAL_G);
    const at = "CONTRIBUTING.md";
    const mutated = realRead(at).replaceAll("`tests/global-setup.ts`「", "`tests/nope-setup.ts`「");
    expect(mutated, "变异没落地").not.toBe(realRead(at));
    const failures = citedAnchorFailures(patchRead(realRead, at, mutated), realExists, realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("tests/nope-setup.ts，而那个文件不存在");
  });

  it("(g) 认不出要吵：社区文件里一条名字锚都没有时当场抛，不静默当成「没什么可查」", () => {
    probeBase(citedAnchorFailures(realRead, realExists, realList), REAL_G);
    const stripped: Read = (p) => realRead(p).replaceAll("「", "【").replaceAll("」", "】");
    expect(() => citedAnchorFailures(stripped, realExists, realList)).toThrow(/判据坏了|空口白话/);
  });

  it("(g) 缺文件给人话：SECURITY.md 不存在时报的是人话，不是裸 ENOENT", () => {
    const failures = citedAnchorFailures(realRead, hideFile(realExists, "SECURITY.md"), realList);
    expect(failures.join("\n")).toContain("先看 (a) 那一格");
  });

  it("SECURITY.md 写的会话上限与 `SESSION_MAX_AGE_MS` 一致 —— 那个「12 小时」不是手抄的", () => {
    // 缺文件给人话，不抛裸 ENOENT——与 (b)/(e)/(f)/(g) 同一条纪律（复评 F11）。
    expect(realExists("SECURITY.md"), "SECURITY.md 不存在 —— 会话上限无从查起，先看 (a) 那一格").toBe(true);
    const hours = SESSION_MAX_AGE_MS / 3_600_000;
    expect(Number.isInteger(hours), `会话上限不再是整数小时（${SESSION_MAX_AGE_MS} ms），SECURITY.md 的措辞要跟着改`).toBe(true);
    expect(realRead("SECURITY.md"), `SECURITY.md 里没写「${hours} hours」`).toContain(`${hours} hours`);
    // 同一段里还写了「时刻在未来同样按过期算」。这句同样从真源验，不是描述性散文。
    const now = 1_000_000;
    expect(sessionExpired(now + 60_000, now), "SECURITY.md 说未来时刻按过期算，而 sessionExpired 不这么认为").toBe(true);
  });

  it("(e) 不放过自己：把那句限定从本计划文件里删掉 —— 点名本计划文件", () => {
    const files = trackedProse();
    probeBase(ledgerUnqualified(files, realRead, realExists), REAL_E);
    let mutated = realRead(PLAN);
    for (const n of NOTES) mutated = mutated.split(n).join("（限定被变异抹掉了）");
    expect(mutated, "变异没落地 —— 本计划文件里找不到任何一句限定").not.toBe(realRead(PLAN));
    expect(ledgerUnqualified(files, patchRead(realRead, PLAN, mutated), realExists)).toEqual([PLAN]);
  });
});
