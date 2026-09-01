import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
// SECURITY.md 写下的那个「12 小时」一律从真源现算，不手抄。
import { SESSION_MAX_AGE_MS, sessionExpired } from "../../admin-ui/js/pure/session.mjs";

/**
 * ── 公开仓的门面 ─────────────────────────────────────────────────────────────
 *
 * 这一组守的是**陌生人第一次打开这个仓**那条路上的几件事，它们此前一件都没有机器看着：
 *
 * · **(a) 社区文件在不在——而「有哪几份」这件事本身从磁盘现算**：
 *   `CONTRIBUTING.md`、`SECURITY.md`、`.github/pull_request_template.md` 这三份的位置
 *   由 GitHub 定死；issue 模板那一档取 `.github/ISSUE_TEMPLATE/` 下的**全量**，不写死清单。
 *   ⚠️ **复评就栽在这儿**：上一版把五份社区文件写成一张冻结的字面量表，于是往
 *   `.github/ISSUE_TEMPLATE/` 里新加第六份模板（那正是本仓最会长文件的目录）、里面
 *   死链 / 查无此处的仓内路径 / 不存在的 `pnpm` 命令三种错一起犯——**二十余格全绿**。
 *   现在射程从磁盘长出来，并另配一条「表 == 磁盘」断言逼新文件回来表态；那条断言的
 *   写法抄自 `tests/unit/docs-parity.test.ts` 的
 *   「R1 五个语言目录下同名文件都存在，且 DOCS 表恰好等于每一个语言目录的 .md 全集」。
 *   ⚠️ 那条用例的标题在补漏回填里改过一次（原文说的是「等于 zh-CN 目录的
 *   .md 全集」，而那正是它当时的缺陷：只扫一个语言目录）——本行随之改真。
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
 *   ⚠️ **处数不写进这段话**（复评发现：上一版写「三处」，而报文实际摆出来的是六个取值，
 *   且随 workflow 数量增长）——要处数就去看报文，它把每一处逐个摆出来。
 *   ⚠️ 判据是**这些取值彼此相等**，不是「有没有 `engines` 字段」——后者填个 `>=1` 也能绿。
 * · **(e) tracked 的 `*.md` 与 `*.sh` 里对工作账本 `.superpowers` 的引用必须自带溯源限定**。
 *   ⚠️ **判据不是「不许引用」**：那些引用是真实的溯源记录，删掉等于抹掉出处。
 *   判据是「引用它的文件必须自己说清读者打不开」——把一条死链变成一条诚实的标注。
 *   该目录被 `.gitignore` 排除（`git ls-files .superpowers` = 0），公开仓读者点不开它。
 *   ⚠️ **`.sh` 那一半是复评补的**，理由写在 `trackedProse()` 上：
 *   `.md` 与 `.ts/.js/.mjs` 两侧各有门禁，`.sh` 正好漏在中间，于是同一个问题被原样搬了进去。
 *   ⚠️ 限定串是一个**候选集**（中英各一版），且报文把候选逐条摆出来。复评实测出
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
 *   ⚠️ 理由是复评发现：这三份模板的正文**不只在仓库文件视图里被渲染**，它会被整段塞进
 *   issue / PR 的正文，而那里的相对链接由浏览器按 issue / PR 的 URL 解析
 *  （`.github/ISSUE_TEMPLATE/` 下的 `../../SECURITY.md` 会落到 `/<owner>/SECURITY.md`）
 *   ⇒ **格子全绿而屏幕上是死链**，与「就地更新够不着盒子外的节点」同一族。
 *   绝对链接在两个面上都成立，代价是多这一条判据看着它。
 * · **(g) 社区文件里那几句「这件事由某某守着」必须点得出是哪一格**：用本仓的名字锚写法，
 *   引契约用例时标题要逐字对得上 `it("…"`，引其它文件时那段文字要逐字在那个文件里。
 *   会话上限那个「12 小时」同样从 `SESSION_MAX_AGE_MS` 现算，不手抄。
 * · **(k) `docker-compose.yml` 那条 `/etc/localtime` 挂载的说明，它的前提得在同一份文件里成立**
 *  （评审回填）。那段注释上一版给的理由是假的，而它假在哪儿本机三条 `docker run`
 *   就量得出来：`TZ` 与那条挂载**不是互补的两件事，是互相排斥的两条路**，`TZ` 一有值就赢。
 *   本格钉的是那句话赖以成立的那半件事——`environment` 里 `TZ` 无条件带一个非空默认值。
 * · **(l) healthcheck 的四个参数与探针命令，在 `Dockerfile` 与 `docker-compose.yml` 两份
 *   副本之间逐字节相同**（评审回填）。两份副本是有意的，而
 *   `docker-compose.yml` 那段注释要求它们「逐个相同」——**这句话此前没有任何判据看着**，
 *   改一边不改另一边，全仓一格都不会红。
 * · **(m) 仓库根目录的顶层文件集合 == 一张具名白名单**（评审回填）。
 *   补的是一次真实事故：一次 shell 重定向意外把两个 0 字节的空文件提交进了公开仓根目录，
 *   **十三道门禁一格都没拦住**——「工作树干净」查的是未提交的改动，`topLevelDirs()` 现算的是
 *   顶层**目录**，目录树那一组只查「目录树写的路径 ⇒ 磁盘存在」这一个方向。三条射程边界正好对齐成一个洞。
 *


 * ── 判据只有一份，反向控制从同一份进 ────────────────────────────────────────
 * 每条判据都写成 `(read, exists, list) => 失败报文[]` 的纯函数，真扫描传真 fs，反向控制传
 * 打过补丁的 `read` / `exists` / `list`。**没有第二份判据**，所以「探针绿了而真扫描是另一套
 * 逻辑」这种事在这里不成立。
 * ⚠️ `list`（目录列举）是复评补的第三个注入点：上一版 (g) 直接调真 `existsSync` /
 * `readFileSync` 去读被引文件，绕开了文件头自己声明的唯一注入点，于是「被引文件改名或被删」
 * 那一侧没法用同一套注入做反向控制。
 * 每一格反向控制在变异之前先跑一遍**基**：基本身就红的话，报文会直说「先去看真扫描那一格」，
 * 而不是让人从变异那一格的报文里找原因。
 *
 * ── 它做不到什么（明写，别读成「门面从此都是真的」）────────────────────────────
 * · (a) 只查**上报路径这句话在不在**，不查那条路径今天通不通——GitHub 侧把 Security
 *   Advisory 关掉了，这里一个字都不会吭。**推仓当天必须人手确认那个开关**，
 *   已登记在 Task 34A Step 6。
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
 *   推仓当天仍须在真 issue / PR 页面上人手点一次，已登记在 Task 34A Step 6。
 *   它也不查 `main` 这个分支名今天存不存在于远端。
 * · (g) 只查**被引的那段文字今天还在**，不查那条用例真的守着社区文件声称的那件事——
 *   一条改成 `expect(1).toBe(1)` 的用例，标题不动的话这里照样绿。
 * · (k) 只查**那句话的前提**（`TZ` 这一行的形状），**一点时区行为都不验**：容器里的
 *   `new Date()` 到底打什么，本机跑得出来、CI 里跑不出来（跑测试的进程不在容器里，
 *   而起一个容器只为了看一行时间戳，代价与收益不成比例）。实测记在那段注释里，
 *   哪天有人要改 `TZ` / 挂载这两行中的任何一行，请照那段实测重跑一遍，别只读注释。
 * · (l) 只查**两份副本彼此相等**，不查这套参数本身合不合理（`interval: 30s` 配
 *   `start_period: 10s` 对本仓的冷启动够不够，这里一个字都不知道），也不查探针命令
 *   在容器里真的跑得通——后者由 prepush ⑦ 的双形态冒烟在真容器上验，两侧分工不重叠。
 * · (m) 只查**顶层这一层**，且只查**名字**：`docs/` 之类的目录里塞进一份垃圾文件它看不见
 *   （那一层没有同型的白名单，代价与收益不成比例——顶层是陌生人第一屏，子目录不是），
 *   也不查文件大小、内容、或者「这份文件今天还有没有用」。0 字节这件事在判据里一次都没出现，
 *   钉的是**名字进没进表**——下一次事故完全可以是一份 3 字节的 `nohup.out`。
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
 * ⚠️ **缺文件不许让别的格子抛裸 `ENOENT`**（复评实测：真删 `SECURITY.md` 之后 18 格红，
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
 * 需求书写的是带斜杠那版，落地实测推翻了它：真实写法里那 8 处是
 * `git add -A -- . ':!.superpowers'`（pathspec 排除，**不带斜杠**），带斜杠的判据
 * 一处都扫不到它——而同一份需求书的 Step 4 又要求那一期也加限定。两句自相矛盾，按**更宽的那一侧**
 * 落地：宽的那一侧扫得到 pathspec 那种写法，窄的那一侧扫不到。
 */
const LEDGER = ".superpowers";

/**
 * 溯源限定的**候选集**，任一出现即算数。
 * ⚠️ **中英各留一版是复评发现的处置**：`CONTRIBUTING.md` / 根 `README.md` / `docs/en/**` 都是
 * 英文文档，只认中文串的话，它们哪天要合法引用工作账本，**只能塞一句中文**才能变绿。
 * 英文那一版今天没有消费者，但它不是摆设：下面「(e) 英文候选也算数」那一格用真形态验它。
 */
const NOTES: readonly string[] = ["不随仓库推送", "not pushed to the public repository"];
/**
 * 射程里今天**唯一**那份引用工作账本的文件，**判据必须不放过它**。
 *
 * ⚠️ **这里原来指的是一份内部计划文档**（它当时是引用大户，一份文件里就有 8 处引用）。
 * 那份文档已随全部内部设计文档移出本仓，射程里的引用方**只剩这一份**——
 * `scripts/prepush.sh` 的注释里有两条真实的工作账本引用。
 * ⚠️ **「引用大户」这个说法今天不成立了，别再照它去读这一组**：判据的价值随之缩水，
 * 但判据本身仍然成立、仍然会红——`trackedProse()` 对空集是 `throw` 而不是静默放行
 *（见它自己那段注释），所以「射程空了」不会被读成「全都合规」。
 */
const SELF_REFERRER = "scripts/prepush.sh";

/** 报文里把候选逐条摆出来——复评发现：真正的要求在上一版报文里一次都没出现过。 */
const notesHint = () => NOTES.map((n) => `「${n}」`).join(" 或 ");

/**
 * 射程 = tracked 的 `*.md` **与 `*.sh`**。
 *
 * ⚠️ **`.sh` 那一半是复评补的**：那一轮在 `scripts/prepush.sh` 的注释里新写下
 * 两条指向 `.superpowers/…` 的引用，而两边的门禁正好把 `.sh` 漏在中间——本格上一版
 * 只认 tracked 的 `*.md`，`scripts/check-comment-refs.mjs` 的 `walk()` 又自己写明
 * 「`.sh` 与 `.yml` 一个文件都不打开」⇒ 刚在 `.md` 那一侧解决掉的问题被原样搬进了 `.sh`，
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
 * ⚠️ **「像不像仓内路径」这件事不写死**（复评发现的另一半）：上一版只认「首段是一张写死的
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

/** git 索引里的全部路径。**顶层目录**与**顶层文件**两侧共用这一个入口，不各扫各的。 */
function gitLsFiles(): string[] {
  const raw = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  const files = raw.split("\0").filter(Boolean);
  if (files.length === 0) {
    throw new Error("`git ls-files` 一个文件都没列出来 —— 扫描坏了，不许静默当成空集");
  }
  return files;
}

/** 仓里真实存在的顶层目录，从 `git ls-files` 现算。 */
function topLevelDirs(tracked: readonly string[] = gitLsFiles()): string[] {
  const files = tracked;
  const dirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]!))].sort();
  if (dirs.length === 0) {
    throw new Error("`git ls-files` 扫不出任何顶层目录 —— 扫描坏了，不许静默当成「这个仓是平的」");
  }
  return dirs;
}

const looksLikeRepoPath = (t: string, topDirs: readonly string[]): boolean =>
  topDirs.includes(t.split("/")[0]!) || FILE_TAIL_RE.test(t);

/* ── (m) 仓库根目录的顶层文件全集 ─────────────────────────────────────────── */

/**
 * 🔴 **这一格是补漏，补的是一次真实事故。**
 *
 * `96fa2a6` 那一笔里，转换脚本跑 shell 时一次重定向事故把两个 **0 字节**的空文件
 * （`range` / `under`）提交进了公开仓根目录，**十三道门禁一格都没拦住**，两轮评审也都没提。
 * 漏的原因是三条各自都成立的射程边界正好在这里对齐成了一个洞：
 * · 「工作树干净」那道门禁查的是**未提交的改动** —— 文件已经提交，所以工作树确实是干净的；
 * · 上面那个 `topLevelDirs()` 从 `git ls-files` 现算的是顶层**目录**，顶层**文件**不在它眼里；
 * · 目录树那一组查的是「目录树里写的路径 ⇒ 磁盘上真的存在」**单向**，
 *   反方向（磁盘/索引上多出来的东西要不要进目录树）没人查。
 *
 * ⇒ 这一格补的正是那个反方向：**索引里的顶层文件集合 == 一张具名表**，多一份少一份都得有人来表态。
 * 判据故意做成**恒等式**而不是「不许有 0 字节文件」——后者只挡得住这一次的具体形态，
 * 而下一次事故完全可以是一个 3 字节的 `nohup.out` 或一份 `tmp.json`。
 *
 * ⚠️ **这张表是白名单不是快照**：新加一份根级文件（比如某天真的要放 `Makefile`）时，
 * 这一格会红，改表的那一下就是「这份文件该不该出现在陌生人打开仓库的第一屏」的表态点。
 */
const TOP_LEVEL_FILES: readonly string[] = [
  // 点开头的仓库配置
  ".dockerignore", ".env.example", ".gitattributes", ".gitignore", ".npmrc",
  // 公开仓门面（社区文件 + 许可 + 赞助 + 变更日志）
  "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "README.md", "SECURITY.md", "SPONSORS.md",
  // Docker 形态
  "Dockerfile", "docker-compose.yml", "docker-entrypoint.sh",
  // Node / 构建 / 测试 / Worker 形态
  "VERSION", "package.json", "pnpm-lock.yaml", "tsconfig.build.json", "tsconfig.json",
  "vitest.config.ts", "vitest.workers.config.ts", "wrangler.toml",
];

/** 仓里真实存在的顶层文件（不含目录），从 `git ls-files` 现算。 */
function topLevelFiles(tracked: readonly string[] = gitLsFiles()): string[] {
  return tracked.filter((f) => !f.includes("/")).sort();
}

/**
 * 顶层文件集合与白名单的双向差集。**纯函数**，所以反向控制可以直接喂一份伪造的索引清单，
 * 不用真往仓里扔垃圾文件。报文两个方向各自点名，不合并成一句「对不上」。
 */
const topLevelFileFailures = (actual: readonly string[], allow: readonly string[]): string[] => {
  const allowed = new Set(allow);
  const seen = new Set(actual);
  const out: string[] = [];
  for (const f of actual) {
    if (!allowed.has(f)) {
      out.push(`仓库根目录上多出一份没人表过态的文件：\`${f}\` —— 它是随手落下的垃圾，`
        + "还是真的该出现在陌生人打开仓库的第一屏？要留就把它写进 `TOP_LEVEL_FILES`");
    }
  }
  for (const f of allow) {
    if (!seen.has(f)) {
      out.push(`\`TOP_LEVEL_FILES\` 里写着 \`${f}\`，而 git 索引里没有它 —— 文件被删了就把表一起改`);
    }
  }
  return out;
};

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

describe("公开仓的门面：社区文件 / CI 徽章 / node 大版本 / 工作账本的溯源限定 / 顶层文件全集", () => {
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
   * 复评发现的正面回应。上一版这里是一张冻结的字面量表，新加第六份模板 ⇒ 二十余格全绿。
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

  /** 那条发现的机器侧：把那三行删掉 —— 判据必须点名，而不是安安静静放行。 */
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

  /* ── (i) 「什么时候才会有已发布镜像」那句话与 workflow 的触发器 ──────────
   *
   * `docker-compose.yml` 那段注释要回答的是「`docker compose up -d` 为什么可能拉不到镜像」，
   * 而答案取决于 `docker-publish.yml` 到底被什么触发。上一版写的是
   * 「镜像发布**只**在打 `v*` 标签时触发」—— 实测那份 workflow 还有 `workflow_dispatch`，
   * **那个「只」当天就是假的**（需求书同样这么写，实施者照抄；「需求书也会错」）。
   * ⚠️ 判据不是「注释里有没有 workflow_dispatch 这个词」，而是**触发器逐个点名**：
   *   那份 workflow 哪天多一个触发器（比如 `schedule`），这一格会指着那个名字红。
   */
  const PUBLISH_WF = ".github/workflows/docker-publish.yml";
  const REAL_I = "docker-compose.yml 那句「什么时候会有已发布镜像」把 docker-publish.yml 的触发器逐个点到了";

  const publishTriggerFailures = (read: Read): string[] => {
    const wf = read(PUBLISH_WF);
    // `on:` 之后、下一个顶格键之前的那一段；触发器是其中缩进两格的那几个键。
    const block = /^on:\n([\s\S]*?)(?=^\S)/m.exec(wf);
    if (block === null) throw new Error(`${PUBLISH_WF} 里读不出 on: 那一段 —— 判据坏了，不许静默跳过`);
    const triggers = [...block[1]!.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]!);
    if (triggers.length === 0) throw new Error(`${PUBLISH_WF} 的 on: 里一个触发器都没抠出来 —— 判据坏了`);
    const note = read(COMPOSE);
    return triggers
      .filter((t) => !note.includes(t))
      .map((t) => `${PUBLISH_WF} 有 \`${t}\` 这个触发器，而 ${COMPOSE} 那段注释一个字没提它 —— 「什么时候会有已发布镜像」那句话就是不全的`);
  };

  it(REAL_I, () => {
    const failures = publishTriggerFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(i) 该红时红：workflow 多一个触发器而注释没跟上 —— 点名那个触发器", () => {
    probeBase(publishTriggerFailures(realRead), REAL_I);
    const mutated = realRead(PUBLISH_WF).replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  schedule:\n    - cron: \"0 0 * * *\"\n");
    expect(mutated, "变异没落地 —— workflow 里已经不是那个形状").not.toBe(realRead(PUBLISH_WF));
    const failures = publishTriggerFailures(patchRead(realRead, PUBLISH_WF, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("`schedule`");
  });

  it("(i) 该红时红：注释里把 workflow_dispatch 那句删掉 —— 退回上一版那个假的「只」", () => {
    probeBase(publishTriggerFailures(realRead), REAL_I);
    const mutated = realRead(COMPOSE).replace("（`workflow_dispatch`）", "");
    expect(mutated, "变异没落地").not.toBe(realRead(COMPOSE));
    const failures = publishTriggerFailures(patchRead(realRead, COMPOSE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("workflow_dispatch");
  });

  it("(i) 认不出要吵：workflow 的 on: 段读不出来时当场抛，不静默当成「没有触发器」", () => {
    const gutted = realRead(PUBLISH_WF).replace(/^on:$/m, "ON_DISABLED:");
    expect(gutted, "变异没落地").not.toBe(realRead(PUBLISH_WF));
    expect(() => publishTriggerFailures(patchRead(realRead, PUBLISH_WF, gutted))).toThrow(/判据坏了/);
  });

  /* ── (k) `/etc/localtime` 那条挂载的注释，它的前提得在同一份文件里成立 ────
   *
   * 这一格是**回填**：那段注释上一版写的是「挂了它日志时间戳才跟得上宿主」，而 `TZ`
   * 在同一份文件里被无条件设着（`environment: TZ: ${TZ:-…}`），`TZ` 一有值就压过
   * `/etc/localtime` ⇒ 那句理由从落地第一天起就是假的。三条 `docker run` 就能证伪
   * （实测记在 `docker-compose.yml` 那段注释里，此处不抄第二份）。
   * ⚠️ **本格不验时区行为**——容器里的时间本机验得到、CI 里验不到，而且那是 docker 与
   *   musl 的行为不是本仓的代码。本格验的是**那句话的前提**：注释说「因为 `TZ` 无条件
   *   设着，所以这条挂载是空操作」，那么「`TZ` 无条件设着」这件事就必须在这份文件里
   *   读得出来。谁把那行 `TZ` 删掉或改成不带默认值（`${TZ:-}`），这一格当场红，
   *   逼他回来改注释——因为那时挂载**真的开始生效**，整段话反过来了。
   * ⚠️ 反方向也查：挂载在、而那句话没了 ⇒ 红。上一版那条假理由正是这么留下来的：
   *   一行挂载配一段没人对过账的说明。
   */
  const LOCALTIME_MOUNT = "- /etc/localtime:/etc/localtime:ro";
  const NOOP_CLAIM = "它对本仓今天是空操作";
  const REAL_K = "docker-compose.yml 那段 /etc/localtime 注释的前提（同一份文件里 TZ 被无条件设着）今天成立";

  const localtimeNoteFailures = (read: Read): string[] => {
    const y = read(COMPOSE);
    const mounted = y.includes(LOCALTIME_MOUNT);
    const claims = y.includes(NOOP_CLAIM);
    if (!mounted && !claims) {
      throw new Error(`${COMPOSE} 里既没有那条 /etc/localtime 挂载也没有那段说明 —— 判据坏了或射程整个没了，不许静默放行`);
    }
    const out: string[] = [];
    if (mounted && !claims) {
      out.push(`${COMPOSE} 挂了 /etc/localtime，却没写它为什么在这儿 —— 上一版那条假理由（「日志时间戳才跟得上宿主」）就是这么留下的`);
    }
    if (!claims) return out;
    const line = /^\s{6}TZ:\s*(\S.*?)\s*$/m.exec(y);
    if (line === null) {
      out.push(`${COMPOSE} 那段注释说「因为 TZ 无条件设着，所以 /etc/localtime 这条挂载是空操作」，可 environment 里已经没有 TZ 这一行了 —— 前提没了，那句话当场变假，而挂载反过来开始生效`);
      return out;
    }
    if (!/^\$\{TZ:-\S[^}]*\}$/.test(line[1]!)) {
      out.push(`${COMPOSE} 的 TZ 现在是 \`${line[1]}\`，不再是「无条件带一个非空默认值」的 \`\${TZ:-…}\` —— 那段注释的前提不成立了`);
    }
    return out;
  };

  it(REAL_K, () => {
    const failures = localtimeNoteFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(k) 该红时红：把 environment 里那行 TZ 删掉 —— 注释的前提没了，挂载反过来开始生效", () => {
    probeBase(localtimeNoteFailures(realRead), REAL_K);
    const mutated = realRead(COMPOSE).replace(/^ {6}TZ: .*\n/m, "");
    expect(mutated, "变异没落地 —— docker-compose.yml 里已经没有那行 TZ").not.toBe(realRead(COMPOSE));
    const failures = localtimeNoteFailures(patchRead(realRead, COMPOSE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("已经没有 TZ 这一行");
  });

  it("(k) 该红时红：TZ 改成不带默认值的 `${TZ:-}` —— 空串不再压过 /etc/localtime", () => {
    probeBase(localtimeNoteFailures(realRead), REAL_K);
    const mutated = realRead(COMPOSE).replace(/^( {6}TZ: ).*$/m, "$1${TZ:-}");
    expect(mutated, "变异没落地").not.toBe(realRead(COMPOSE));
    const failures = localtimeNoteFailures(patchRead(realRead, COMPOSE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("不再是「无条件带一个非空默认值」");
  });

  it("(k) 该红时红：挂载还在、那段说明被删掉 —— 一行挂载配一段没人对过账的说明", () => {
    probeBase(localtimeNoteFailures(realRead), REAL_K);
    const mutated = realRead(COMPOSE).replace(NOOP_CLAIM, "它很重要");
    expect(mutated, "变异没落地").not.toBe(realRead(COMPOSE));
    const failures = localtimeNoteFailures(patchRead(realRead, COMPOSE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("却没写它为什么在这儿");
  });

  it("(k) 认不出要吵：挂载与说明一起没了时当场抛，不静默当成「这里没有约束」", () => {
    const gutted = realRead(COMPOSE).replace(LOCALTIME_MOUNT, "- ./tz:/tz:ro").replace(NOOP_CLAIM, "无关的一句话");
    expect(gutted, "变异没落地").not.toBe(realRead(COMPOSE));
    expect(() => localtimeNoteFailures(patchRead(realRead, COMPOSE, gutted))).toThrow(/判据坏了/);
  });

  /* ── (l) healthcheck 的两份副本必须逐字节相同 ─────────────────────────────
   *
   * 四个参数 + 探针命令在 `Dockerfile` 与 `docker-compose.yml` 里**各存一份**，这是
   * 有意的（镜像内那条管「拿这个镜像跑」，compose 那条连 `build:` 回落出来的本地镜像
   * 一起管住，且改它不用重建镜像）。`docker-compose.yml` 那段注释白纸黑字要求两份
   * 「逐个相同」——**而这句话此前没有任何东西看着**：改一边不改另一边，CI 那一串门禁
   * 与 prepush 的逐格表一格都不会红（评审实测）。
   * 这正是 `CONTRIBUTING.md`「a checklist that cannot go red is not a guard, it is a to-do list」
   * 判过死刑的那个形态。
   * ⚠️ 判据不是「两边都有 healthcheck」，是**四个参数逐个相等 + 探针命令整串相等**。
   *   参数名两边写法不同（`--start-period` vs `start_period`），映射表写在 `HEALTH_KEYS`。
   * ⚠️ **任一侧多出一个没登记的参数都要红**：docker 后来加过 `--start-interval`
   *   这类新旗标，只对四个已知名字取值比对的话，新旗标会安安静静地只存在于一边。
   *   **这条对两侧对称成立，而它此前只落地了 Dockerfile 那一半**（复评实测）：
   *   给 compose 的 healthcheck 加 `disable: true`（规范里这一键把**这一份**整个关掉，
   *   Dockerfile 那条照常跑）⇒ 全量 68 格一格不红。补齐的是 `knownC` 那个循环。
   * ⚠️ 两侧抽不出来一律**当场抛**，不许静默当成「这里没有约束」——那正是「探针绿了
   *   而真扫描早就没在看」的那条老路。
   */
  const HEALTH_KEYS = [
    ["interval", "interval"],
    ["timeout", "timeout"],
    ["start-period", "start_period"],
    ["retries", "retries"],
  ] as const;
  const REAL_L = "Dockerfile 与 docker-compose.yml 的 healthcheck 四参数与探针命令逐字节相同";

  const dockerfileHealth = (read: Read): { flags: Map<string, string>; probe: string } => {
    const m = /^HEALTHCHECK((?:\s+--[a-z-]+=\S+)+)\s*\\\n\s*CMD node -e "(.*)"\s*$/m.exec(read("Dockerfile"));
    if (m === null) {
      throw new Error("Dockerfile 里那条 HEALTHCHECK 抽不出来 —— 判据坏了，不许静默当成「这里没有约束」");
    }
    return {
      flags: new Map([...m[1]!.matchAll(/--([a-z-]+)=(\S+)/g)].map((f) => [f[1]!, f[2]!])),
      probe: m[2]!,
    };
  };

  const composeHealth = (read: Read): { keys: Map<string, string>; probe: string } => {
    const block = /^\s{4}healthcheck:\n([\s\S]*?)(?=^\s{4}\S|^\s{2}\S|\Z)/m.exec(read(COMPOSE));
    if (block === null) {
      throw new Error(`${COMPOSE} 里那段 healthcheck 抽不出来 —— 判据坏了，不许静默当成「这里没有约束」`);
    }
    const body = block[1]!;
    const t = /^\s{6}test: \["CMD", "node", "-e", "(.*)"\]\s*$/m.exec(body);
    if (t === null) {
      throw new Error(`${COMPOSE} 的 healthcheck 里那条 test: 抽不出来 —— 判据坏了，不许静默当成「这里没有探针」`);
    }
    return {
      keys: new Map([...body.matchAll(/^ {6}([a-z_]+): (\S+)\s*$/gm)].map((m) => [m[1]!, m[2]!])),
      probe: t[1]!,
    };
  };

  const healthcheckParityFailures = (read: Read): string[] => {
    const d = dockerfileHealth(read);
    const c = composeHealth(read);
    const out: string[] = [];
    for (const [dk, ck] of HEALTH_KEYS) {
      const dv = d.flags.get(dk);
      const cv = c.keys.get(ck);
      if (dv === undefined) out.push(`Dockerfile 那条 HEALTHCHECK 没有 \`--${dk}=\`，而 ${COMPOSE} 写着 \`${ck}: ${cv ?? "（也没有）"}\``);
      else if (cv === undefined) out.push(`${COMPOSE} 的 healthcheck 没有 \`${ck}:\`，而 Dockerfile 写着 \`--${dk}=${dv}\``);
      else if (dv !== cv) {
        out.push(`healthcheck 的 ${dk}：Dockerfile 是 \`${dv}\`、${COMPOSE} 是 \`${cv}\``
          + " —— 同一件事的两份副本给了不同的数，「容器多久才算 unhealthy」就变成一个要先查「这次跑的是哪一份」才答得出的问题");
      }
    }
    const knownD = new Set<string>(HEALTH_KEYS.map(([dk]) => dk));
    for (const dk of d.flags.keys()) {
      if (!knownD.has(dk)) out.push(`Dockerfile 那条 HEALTHCHECK 多出一个 \`--${dk}=\`，${COMPOSE} 那边没有对应的键，也没人把它登记进 HEALTH_KEYS`);
    }
    // ⚠️ **这一段是对称的另一半**（复评实测补）：上面只扫了 Dockerfile 侧的未知旗标，
    // compose 侧加键**一个都不会红**。实测过两个真实形态：
    //   · `start_interval: 5s` —— 新参数只存在于一边，正是上面 ⚠️ 那条推理要挡的事；
    //   · `disable: true`     —— compose 规范里这一键会把**这一份 healthcheck 整个关掉**，
    //     而 Dockerfile 那条照常生效 ⇒ 「两份逐个相同」当场变成假话，而判据全绿（68/68）。
    // 上面那条 ⚠️ 的推理对两侧对称成立，此前只落地了一半。
    const knownC = new Set<string>(HEALTH_KEYS.map(([, ck]) => ck));
    for (const ck of c.keys.keys()) {
      if (!knownC.has(ck)) out.push(`${COMPOSE} 的 healthcheck 多出一个 \`${ck}:\`，Dockerfile 那边没有对应的旗标，也没人把它登记进 HEALTH_KEYS`);
    }
    if (d.probe !== c.probe) {
      out.push(`healthcheck 的探针命令两份对不上：\n  Dockerfile：${d.probe}\n  ${COMPOSE}：${c.probe}`);
    }
    return out;
  };

  it(REAL_L, () => {
    const failures = healthcheckParityFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(l) 该红时红：compose 的 start_period 改成 20s —— 点名是哪个键、两边各是什么", () => {
    probeBase(healthcheckParityFailures(realRead), REAL_L);
    const mutated = realRead(COMPOSE).replace("start_period: 10s", "start_period: 20s");
    expect(mutated, "变异没落地").not.toBe(realRead(COMPOSE));
    const failures = healthcheckParityFailures(patchRead(realRead, COMPOSE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("start-period：Dockerfile 是 `10s`");
  });

  it("(l) 该红时红：Dockerfile 的 --retries 改成 5 —— 反方向同样点名", () => {
    probeBase(healthcheckParityFailures(realRead), REAL_L);
    const mutated = realRead("Dockerfile").replace("--retries=3", "--retries=5");
    expect(mutated, "变异没落地").not.toBe(realRead("Dockerfile"));
    const failures = healthcheckParityFailures(patchRead(realRead, "Dockerfile", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("retries：Dockerfile 是 `5`");
  });

  it("(l) 该红时红：探针里的 127.0.0.1 只在一边改成 localhost —— 点名探针命令对不上", () => {
    probeBase(healthcheckParityFailures(realRead), REAL_L);
    const mutated = realRead(COMPOSE).replace("http://127.0.0.1:", "http://localhost:");
    expect(mutated, "变异没落地").not.toBe(realRead(COMPOSE));
    const failures = healthcheckParityFailures(patchRead(realRead, COMPOSE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("探针命令两份对不上");
  });

  it("(l) 该红时红：Dockerfile 多出一个 compose 那边没有的参数 —— 不许只比对四个已知名字", () => {
    probeBase(healthcheckParityFailures(realRead), REAL_L);
    const mutated = realRead("Dockerfile").replace("--retries=3", "--retries=3 --start-interval=5s");
    expect(mutated, "变异没落地").not.toBe(realRead("Dockerfile"));
    const failures = healthcheckParityFailures(patchRead(realRead, "Dockerfile", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("`--start-interval=`");
  });

  it("(l) 该红时红：compose 多出一个 Dockerfile 那边没有的参数 —— 与上一格对称的另一半", () => {
    probeBase(healthcheckParityFailures(realRead), REAL_L);
    const mutated = realRead(COMPOSE).replace("      retries: 3", "      retries: 3\n      start_interval: 5s");
    expect(mutated, "变异没落地").not.toBe(realRead(COMPOSE));
    const failures = healthcheckParityFailures(patchRead(realRead, COMPOSE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("`start_interval:`");
  });

  /**
   * 这一格比上一格要紧：`disable` 不是「多一个无害的新参数」，它是 compose 规范里
   * **把这一份 healthcheck 整个关掉**的开关。加上它之后 compose 那条不再跑，
   * 而 Dockerfile 那条照常生效 ⇒ 上面注释里「两份逐个相同」那句话当场变成假话。
   * 补这一格之前，全量 68 格一格不红（复评实测）。
   */
  it("(l) 该红时红：compose 的 healthcheck 被 `disable: true` 整个关掉 —— 两份逐个相同当场变假话", () => {
    probeBase(healthcheckParityFailures(realRead), REAL_L);
    const mutated = realRead(COMPOSE).replace("      retries: 3", "      retries: 3\n      disable: true");
    expect(mutated, "变异没落地").not.toBe(realRead(COMPOSE));
    const failures = healthcheckParityFailures(patchRead(realRead, COMPOSE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("`disable:`");
  });

  it("(l) 认不出要吵：Dockerfile 那条 HEALTHCHECK 抽不出来时当场抛，不静默放行", () => {
    const gutted = realRead("Dockerfile").replace(/^HEALTHCHECK/m, "# HEALTHCHECK");
    expect(gutted, "变异没落地").not.toBe(realRead("Dockerfile"));
    expect(() => healthcheckParityFailures(patchRead(realRead, "Dockerfile", gutted))).toThrow(/判据坏了/);
  });

  it("(l) 认不出要吵：compose 那段 healthcheck 抽不出来时当场抛，不静默放行", () => {
    const gutted = realRead(COMPOSE).replace(/^ {4}healthcheck:$/m, "    healthcheck_disabled:");
    expect(gutted, "变异没落地").not.toBe(realRead(COMPOSE));
    expect(() => healthcheckParityFailures(patchRead(realRead, COMPOSE, gutted))).toThrow(/判据坏了/);
  });

  /* ── (j) 教了那条命令的每一份文档都要写「首个镜像发布前会本地构建」 ────────
   *
   * 六份 README 有这句话，而**五份 DEPLOY.md 才是部署的权威入口**，上一版那五份没跟上
   * ⇒ 同一句话在两类文档之间断了（那一轮复评查实）。
   * ⚠️ 文档一侧不许**手数**：射程从 `docs/` 现列，多一种语言当天就进射程；
   *   判据是「教了 `docker compose up -d` 的文件必须同时提到 `build:`」——
   *   哪一份缺，就点名哪一份。
   */
  const BUILD_FALLBACK_TAUGHT = "docker compose up -d";
  const REAL_J = "教了 `docker compose up -d` 的每一份 README / DEPLOY.md 都写了 `build:` 那条回退";

  const buildFallbackFailures = (read: Read, list: List, exists: Exists): string[] => {
    const langs = list("docs").filter((d) => exists(`docs/${d}/README.md`));
    if (langs.length === 0) throw new Error("docs/ 下一种语言都没列出来 —— 判据坏了，不许静默跳过");
    const files = ["README.md", ...langs.flatMap((l) => [`docs/${l}/README.md`, `docs/${l}/DEPLOY.md`])]
      .filter((f) => exists(f));
    const teaching = files.filter((f) => read(f).includes(BUILD_FALLBACK_TAUGHT));
    if (teaching.length === 0) {
      throw new Error(`一份教 \`${BUILD_FALLBACK_TAUGHT}\` 的文档都没扫到 —— 判据坏了，不许静默放行`);
    }
    return teaching
      .filter((f) => !read(f).includes("`build:`"))
      .map((f) => `${f} 教了 \`${BUILD_FALLBACK_TAUGHT}\`，却没写「首个镜像发布前会回落到本地构建」（那段 \`build:\`）—— 陌生人照着它跑会以为拉取失败就是坏了`);
  };

  it(REAL_J, () => {
    const failures = buildFallbackFailures(realRead, realList, realExists);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(j) 该红时红：某一种语言的 DEPLOY.md 把那句删掉 —— 点名是哪一份", () => {
    probeBase(buildFallbackFailures(realRead, realList, realExists), REAL_J);
    const at = "docs/ko/DEPLOY.md";
    const mutated = realRead(at).split("`build:`").join("`buiId:`");
    expect(mutated, "变异没落地").not.toBe(realRead(at));
    const failures = buildFallbackFailures(patchRead(realRead, at, mutated), realList, realExists);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain(at);
  });

  it("(j) 认不出要吵：一份教那条命令的文档都扫不到时当场抛", () => {
    const blind: Read = (p) => realRead(p).split(BUILD_FALLBACK_TAUGHT).join("docker compose up -q");
    expect(() => buildFallbackFailures(blind, realList, realExists)).toThrow(/判据坏了/);
  });

  it(REAL_E, () => {
    const failures = ledgerUnqualified(trackedProse(), realRead, realExists);
    expect(
      failures,
      `这些文档引用了 ${LEDGER}，却没有在同一份文件里写出溯源限定（${notesHint()} 任一即可）：\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("(e) 射程自守：真的扫到了引用方，而且那份唯一的引用方在射程内", () => {
    const referrers = ledgerReferrers(trackedProse(), realRead, realExists);
    expect(referrers.length, "一份都没扫到，扫描多半写坏了").toBeGreaterThan(0);
    expect(referrers, `${SELF_REFERRER} 掉出了射程 —— 判据放过了自己`).toContain(SELF_REFERRER);
  });

  /**
   * 复评发现的正面回应。`scripts/prepush.sh` 的注释里有两条真实的工作账本引用，
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
  const REAL_REPO_BLOB = "issue / PR 模板里的绝对链接，仓名与落点都对得上";
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

  /** 复评发现的另一半：首段不是顶层目录、但末段带扩展名的假路径不许再被静默跳过。 */
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

  it("(m) 仓库根目录的顶层文件恰好等于那张具名表 —— 多一份少一份都要有人来表态", () => {
    const failures = topLevelFileFailures(topLevelFiles(), TOP_LEVEL_FILES);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
    // 恒等式本身也直接钉一格。⚠️ 表是**按用途分组**写的（可读性优先），而 `git ls-files`
    // 吐的是字节序 ⇒ 这里比的是排过序的两份，顺序差异不算错；重复项另钉一格，
    // 否则一条写两遍会让差集与长度两个方向同时看不见。
    expect(new Set(TOP_LEVEL_FILES).size, "`TOP_LEVEL_FILES` 里有重复项").toBe(TOP_LEVEL_FILES.length);
    expect(topLevelFiles()).toEqual([...TOP_LEVEL_FILES].sort());
  });

  it("(m) 该红时红：`range` / `under` 那次事故重演 —— 两份 0 字节垃圾各自被点名", () => {
    probeBase(topLevelFileFailures(topLevelFiles(), TOP_LEVEL_FILES),
      "(m) 仓库根目录的顶层文件恰好等于那张具名表 —— 多一份少一份都要有人来表态");
    // `96fa2a6` 当时索引里真实多出来的就是这两条（0 字节，git 不看大小、只看路径）。
    const failures = topLevelFileFailures(topLevelFiles([...gitLsFiles(), "range", "under"]), TOP_LEVEL_FILES);
    expect(failures).toHaveLength(2);
    expect(failures.join("\n"), "重定向事故落下的空文件没被点名 —— 这一格就白补了").toContain("`range`");
    expect(failures.join("\n")).toContain("`under`");
  });

  it("(m) 该红时红：顶层文件被删而表没跟上 —— 反方向同样点名", () => {
    const without = topLevelFiles().filter((f) => f !== "LICENSE");
    expect(without, "变异没落地 —— 索引里本来就没有 LICENSE").not.toEqual(topLevelFiles());
    expect(topLevelFileFailures(without, TOP_LEVEL_FILES))
      .toEqual(["`TOP_LEVEL_FILES` 里写着 `LICENSE`，而 git 索引里没有它 —— 文件被删了就把表一起改"]);
  });

  it("(m) 扫不出东西时要红不要绿：索引空了 ⇒ 逐条点名「表里有而索引里没有」，不静默通过", () => {
    // 这一格钉的是**失败方向**：`topLevelFiles` 是纯函数，喂空集它不抛；
    // 但差集必须因此红成 23 条，而不是「两边都是空的 ⇒ 相等 ⇒ 绿」。
    const failures = topLevelFileFailures(topLevelFiles([]), TOP_LEVEL_FILES);
    expect(failures).toHaveLength(TOP_LEVEL_FILES.length);
    expect(failures.every((m) => m.includes("而 git 索引里没有它"))).toBe(true);
    // 取数那一层另有一道：`git ls-files` 真的一条都不吐时当场抛，不把空集喂下来。
    expect(() => topLevelDirs([])).toThrow(/顶层目录/);
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

  it(REAL_REPO_BLOB, () => {
    const failures = repoBlobFailures(realRead, realExists, realList);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(f2) 该红时红：绝对链接的落点在仓里查无此处 —— 点名那个位置", () => {
    probeBase(repoBlobFailures(realRead, realExists, realList), REAL_REPO_BLOB);
    const at = `${ISSUE_TEMPLATE_DIR}/bug_report.md`;
    const mutated = realRead(at).replace("/blob/main/SECURITY.md", "/blob/main/NOPE-SECURITY.md");
    expect(mutated, "变异没落地 —— 那份模板里已经不是 /blob/main/SECURITY.md").not.toBe(realRead(at));
    const failures = repoBlobFailures(patchRead(realRead, at, mutated), realExists, realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("NOPE-SECURITY.md");
  });

  it("(f2) 该红时红：模板里留下一条跨文件的相对链接 —— 点名它并写出该改成什么", () => {
    probeBase(repoBlobFailures(realRead, realExists, realList), REAL_REPO_BLOB);
    const at = `${ISSUE_TEMPLATE_DIR}/bug_report.md`;
    const mutated = `${realRead(at)}\n\n见 [安全政策](../../SECURITY.md)。\n`;
    const failures = repoBlobFailures(patchRead(realRead, at, mutated), realExists, realList);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("还留着相对链接 ../../SECURITY.md");
    // 报文里那个「该写成什么」的样板串从 package.json 现算，不在这里手抄第二份仓名。
    expect(failures[0] ?? "").toContain(`https://github.com/${repoSlug(realRead)}/blob/main/`);
  });

  it("(f2) 该红时红：仓改了名而模板没跟上 —— 报文把两边的 <owner>/<repo> 都摆出来", () => {
    probeBase(repoBlobFailures(realRead, realExists, realList), REAL_REPO_BLOB);
    const pkg = JSON.parse(realRead("package.json")) as { repository?: { url?: string } };
    const renamed = { ...pkg, repository: { ...pkg.repository, url: "git+https://github.com/xwteam/agnes2api-renamed.git" } };
    const failures = repoBlobFailures(patchRead(realRead, "package.json", JSON.stringify(renamed)), realExists, realList);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0] ?? "").toContain("agnes2api-renamed");
  });

  it("(f2) 认不出要吵：模板里的绝对链接被改回相对链接时当场抛，不静默放行", () => {
    probeBase(repoBlobFailures(realRead, realExists, realList), REAL_REPO_BLOB);
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
   * 复评发现的守卫：`CONTRIBUTING.md` 那句「收集门禁管到哪儿为止」不许再变回一句好听的假话。
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
    // 缺文件给人话，不抛裸 ENOENT——与 (b)/(e)/(f)/(g) 同一条纪律（复评发现）。
    expect(realExists("SECURITY.md"), "SECURITY.md 不存在 —— 会话上限无从查起，先看 (a) 那一格").toBe(true);
    const hours = SESSION_MAX_AGE_MS / 3_600_000;
    expect(Number.isInteger(hours), `会话上限不再是整数小时（${SESSION_MAX_AGE_MS} ms），SECURITY.md 的措辞要跟着改`).toBe(true);
    expect(realRead("SECURITY.md"), `SECURITY.md 里没写「${hours} hours」`).toContain(`${hours} hours`);
    // 同一段里还写了「时刻在未来同样按过期算」。这句同样从真源验，不是描述性散文。
    const now = 1_000_000;
    expect(sessionExpired(now + 60_000, now), "SECURITY.md 说未来时刻按过期算，而 sessionExpired 不这么认为").toBe(true);
  });

  it("(e) 不放过自己：把那句限定从那份唯一的引用方里删掉 —— 点名它", () => {
    const files = trackedProse();
    probeBase(ledgerUnqualified(files, realRead, realExists), REAL_E);
    let mutated = realRead(SELF_REFERRER);
    for (const n of NOTES) mutated = mutated.split(n).join("（限定被变异抹掉了）");
    expect(mutated, `变异没落地 —— ${SELF_REFERRER} 里找不到任何一句限定`).not.toBe(realRead(SELF_REFERRER));
    expect(ledgerUnqualified(files, patchRead(realRead, SELF_REFERRER, mutated), realExists))
      .toEqual([SELF_REFERRER]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 五份社区文件的排版
 *
 * 🔴 **这一组的形状是推导，不是模板照搬。** 两个参照仓（kiro2api / gemini2api）
 * **根本没有** `SECURITY.md` / `CONTRIBUTING.md` / `.github/**` 这几份文件 ——
 * ADJ ⑮⑯ 裁的是「保留它们，按本仓自己的排版词汇轻改」。所以下面每一条都写清
 * **为什么是这个形状**，别当成「模板上就是这么写的」。
 *
 * · **`SECURITY.md` / `CONTRIBUTING.md`**：补 `---`（ADJ ⑮ 赢，README 那套恒等式的射程
 *   收窄到「参照仓有对照物的五类文档」，而参照仓根本没有这几份）、关键提示改
 *   `> [!IMPORTANT]` / `> [!WARNING]`、把「4 条安全行为」与「Ground rules」改成表；
 *   **不套 16 节骨架**、**不补「支持的版本」表**。
 * · **`.github/**` 三份**：补 `---`、关键提示改 alert。**不套骨架、不瘦身、不中文化**。
 *
 * ⚠️ **R23' 在这里是本地版**：全仓那条「相邻标题间正文 ≤1200 字符」今天还没启用
 * （排版判官的下半排在那一期末尾）。本组先把它用在**这两份散文**上，理由是复评的实测：
 * `SECURITY.md` 段均 496.2 字符、最长 2164，是全仓最糟的几份之一 —— 而当初那句
 * 「今天已达标」是假话。**两份 issue 模板不进这一格**：它们整份
 * 一个标题都没有，是表单不是散文，插标题会把它们变成另一种东西。
 *
 * ⚠️ **`---` 数只判「恰 1 条」，不判位置。** 25 份文档那条位置规矩（ADJ §68：
 * 最后一个 `##` 之后、页脚块之前）**推不到这里**：两份 issue 模板整份没有 `##`，
 * 按那条规矩它们的 `---` 永远合法或永远非法，判据两头落空。这里退到「恰 1 条」——
 * 它挡得住「零条（这一期白做）」与「散落好几条（回到旧的分节线用法）」两个方向。
 * ══════════════════════════════════════════════════════════════════════════ */

/** YAML front matter（issue 模板顶部那一段）不算正文，它的两条 `---` 是分隔符不是分隔线。 */
const stripFrontMatter = (text: string): string => {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  return end === -1 ? text : text.slice(end + 5);
};

/** 剥围栏后的正文行（围栏定界行本身也剥掉）。 */
const proseLines = (text: string): string[] => {
  let inFence = false;
  const out: string[] = [];
  for (const line of stripFrontMatter(text).split("\n")) {
    if (/^[ \t]*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) out.push(line);
  }
  return out;
};

const ALERT_LINE = /^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/;
/** 裸 ⚠️ 段落：不在引用块里、以 ⚠️ 起头的一行。这一族正是本期要换掉的那种写法。 */
const BARE_WARN_LINE = /^\s*⚠️/;

/** 一份文件的排版体检。**只读文本**，反向控制因此可以直接喂变异过的字符串。 */
const layoutScan = (path: string, text: string) => {
  const lines = proseLines(text);
  return {
    path,
    hr: lines.filter((l) => l === "---").length,
    alerts: lines.filter((l) => ALERT_LINE.test(l)).length,
    bareWarn: lines.filter((l) => BARE_WARN_LINE.test(l)).length,
  };
};

/** 相邻两个标题之间的正文字符数（剥围栏、剥 front matter）。返回超限的那几段。 */
const overlongSections = (path: string, text: string, cap: number): string[] => {
  const lines = proseLines(text);
  const at = lines.map((l, i) => [l, i] as const).filter(([l]) => /^#{1,6} /.test(l));
  if (at.length === 0) throw new Error(`${path} 里一个标题都没有 —— 判据在测空气`);
  const out: string[] = [];
  at.forEach(([head, i], k) => {
    const end = k + 1 < at.length ? at[k + 1]![1] : lines.length;
    const chars = lines.slice(i + 1, end).join("\n").trim().length;
    if (chars > cap) out.push(`${path} 的「${head}」之下有 ${chars} 个字符，上限 ${cap}`);
  });
  return out;
};

/** 某个 `##` 小节之下有没有一张 ≥`floor` 行数据的表。抽不到那一节时当场抛。 */
const tableRowsUnder = (path: string, text: string, heading: string): number => {
  const lines = proseLines(text);
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`${path} 里没有「${heading}」这一节 —— 判据的落点变了`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const body = end === -1 ? rest : rest.slice(0, end);
  const sep = body.findIndex((l) => /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(l));
  if (sep === -1) return 0;
  let n = 0;
  for (const l of body.slice(sep + 1)) {
    if (!l.trimStart().startsWith("|")) break;
    n += 1;
  }
  return n;
};

const R23_CAP = 1200;
/** R23' 本地版的射程：**只有这两份散文**。两份 issue 模板整份没有标题，是表单不是散文。 */
const PROSE_COMMUNITY = ["SECURITY.md", "CONTRIBUTING.md"] as const;

describe("五份社区文件的排版（推导，不是模板照搬）", () => {
  const scans = (read: Read) => communityFiles(realList).map((f) => layoutScan(f, read(f)));

  it("每份社区文件恰 1 条正文 `---`（front matter 的那两条不算）", () => {
    const wrong = scans(realRead).filter((s) => s.hr !== 1).map((s) => `${s.path} 有 ${s.hr} 条 \`---\``);
    expect(wrong, `报文：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("该红时红：某份多加一条 `---` ⇒ 那格红并点名文件与条数", () => {
    const at = "SECURITY.md";
    const read = patchRead(realRead, at, `${realRead(at)}\n---\n`);
    const wrong = scans(read).filter((s) => s.hr !== 1).map((s) => `${s.path} 有 ${s.hr} 条 \`---\``);
    expect(wrong, `报文：\n${wrong.join("\n")}`).toHaveLength(1);
    expect(wrong[0] ?? "").toContain(`${at} 有 2 条`);
  });

  it("每份至少 1 条 GitHub alert，且裸 `⚠️` 段落恒为 0（本期就是把它们换掉的）", () => {
    const wrong: string[] = [];
    for (const s of scans(realRead)) {
      if (s.alerts < 1) wrong.push(`${s.path} 一条 GitHub alert 都没有`);
      if (s.bareWarn > 0) wrong.push(`${s.path} 还有 ${s.bareWarn} 段裸 \`⚠️\` 散文`);
    }
    expect(wrong, `报文：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("该红时红：把一条 alert 退回裸 `⚠️` 散文 ⇒ 两个方向同时红（少一条 alert、多一段裸 ⚠️）", () => {
    const at = ".github/ISSUE_TEMPLATE/bug_report.md";
    const mutated = realRead(at).replace(/^> \[!WARNING\]\n> \*\*Never paste/m, "⚠️ **Never paste");
    expect(mutated, "变异没落地 —— 那一格控制是空的").not.toBe(realRead(at));
    const s = layoutScan(at, mutated);
    expect(s.bareWarn, "裸 `⚠️` 回来了却没被数到").toBe(1);
    expect(s.alerts, "alert 少了一条却没被数到").toBe(layoutScan(at, realRead(at)).alerts - 1);
  });

  it("R23' 本地版：`SECURITY.md` / `CONTRIBUTING.md` 相邻标题之间的正文 ≤1200 字符", () => {
    const over = PROSE_COMMUNITY.flatMap((f) => overlongSections(f, realRead(f), R23_CAP));
    expect(over, `报文：\n${over.join("\n")}`).toEqual([]);
  });

  /**
   * ⚠️ **为什么这一格删的是两个 `###` 而不是一个。** 落地后逐节实测，`SECURITY.md` 里
   * 单删任何一个 `###`，合并出来最大的一节是 **1047 字符**（`### Admin endpoints …` 的
   * 322 + `### An admin session …` 的 725），仍在 1200 以内 ⇒ **单删一个今天红不了**。
   * 这不是判据软，是这份文档改完之后**有余量**：把它写成「删一个就红」会是一句假话，
   * 而假话在下一次有人加长正文时会静静变成真话，谁都不知道判据是什么时候开始承重的。
   * 所以这一格如实删两个，并把「余量有多少」写在这里。
   */
  it("该红时红：把 `SECURITY.md` 里切开长节的两个 `###` 删掉 ⇒ 那格红并点名是哪一节、多长", () => {
    const at = "SECURITY.md";
    const mutated = realRead(at)
      .replace("\n### When those checks run, and when they do not\n", "\n")
      .replace("\n### What is decided outside this repository\n", "\n");
    expect(mutated, "变异没落地 —— 那两个 `###` 的文字变了").not.toBe(realRead(at));
    const over = overlongSections(at, mutated, R23_CAP);
    expect(over, `报文：\n${over.join("\n")}`).toHaveLength(1);
    expect(over[0] ?? "").toContain("What the credential gates actually check");
    expect(over[0] ?? "", "报文没说这一节到底多长，读的人还得自己去数").toMatch(/有 \d+ 个字符/);
  });

  it("那两组 bullet 已经是表：`If you operate one` 与 `Ground rules` 各 ≥4 行数据", () => {
    const rows = [
      ["SECURITY.md", "## If you operate one"] as const,
      ["CONTRIBUTING.md", "## Ground rules"] as const,
    ].map(([f, h]) => [`${f}${h}`, tableRowsUnder(f, realRead(f), h)] as const);
    const thin = rows.filter(([, n]) => n < 4).map(([k, n]) => `${k} 之下的表只有 ${n} 行数据`);
    expect(thin, `报文：\n${thin.join("\n")}`).toEqual([]);
  });

  it("该红时红：把 `Ground rules` 那张表退回 bullet 列表 ⇒ 行数掉到 0 并点名那一节", () => {
    const at = "CONTRIBUTING.md";
    const mutated = realRead(at).replace(/\n\| Rule \| What it means in practice \|\n\|[-|]+\|\n(?:\|.*\n)+/, "\n- 四条房规\n");
    expect(mutated, "变异没落地 —— `Ground rules` 那张表的表头变了").not.toBe(realRead(at));
    expect(() => tableRowsUnder(at, mutated, "## Ground rules")).not.toThrow();
    expect(tableRowsUnder(at, mutated, "## Ground rules"), "表没了却还数得出行").toBe(0);
  });
});
