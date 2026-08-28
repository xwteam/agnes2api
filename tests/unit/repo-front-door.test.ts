import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
// SECURITY.md 写下的那个「12 小时」一律从真源现算，不手抄。
import { SESSION_MAX_AGE_MS, sessionExpired } from "../../admin-ui/js/pure/session.mjs";

/**
 * ── 公开仓的门面（P3e Task 29A）──────────────────────────────────────────────
 *
 * 这一组守的是**陌生人第一次打开这个仓**那条路上的五件事，它们此前一件都没有机器看着：
 *
 * · **(a) 四类社区文件在不在**：`CONTRIBUTING.md`、`SECURITY.md`、
 *   `.github/ISSUE_TEMPLATE/bug_report.md`、`.github/ISSUE_TEMPLATE/feature_request.md`、
 *   `.github/pull_request_template.md`。
 *   ⚠️ **判据不是「文件非空」**：一份只有标题的 `SECURITY.md` 比没有更糟——它向读者
 *   承诺了一条不存在的上报流程。所以 `SECURITY.md` 还要真的写出**去哪儿报**。
 * · **(b) `SECURITY.md` 不许把仓库纪律说成运行时安全承诺**。本仓的「零内置凭据」是
 *   **仓库纪律**（`scripts/scan-secrets.sh` 那道门禁），它和「这个网关跑起来是安全的」
 *   是两件事；后者本仓给不出，写下去就是一句假话。
 * · **(c) README 顶部那枚 CI 徽章指向的 workflow 真的存在**。徽章是首屏第一眼，指错了
 *   会常年显示 “no status”，而没有任何东西会因此变红。
 * · **(d) node 大版本三处一致**：`Dockerfile` 的 `FROM node:<大版本>-…`、
 *   `.github/workflows/` 里每一处 `node-version:`、`package.json` 的 `engines.node`。
 *   ⚠️ 判据是**三处相等**，不是「有没有 `engines` 字段」——后者填个 `>=1` 也能绿。
 * · **(e) tracked 文档里对工作账本 `.superpowers` 的引用必须自带溯源限定**。
 *   ⚠️ **判据不是「不许引用」**：那些引用是真实的溯源记录，删掉等于抹掉出处。
 *   判据是「引用它的文件必须自己说清读者打不开」——把一条死链变成一条诚实的标注。
 *   该目录被 `.gitignore` 排除（`git ls-files .superpowers` = 0），公开仓读者点不开它。
 *
 * 另有两条是**为这一轮新写下的话**配的测法——写档位就连测法一起写，这是本期的纪律：
 *
 * · **(f) 社区文件里写下的每一条仓内指向都得解析得开**，`pnpm <名字>` 也必须是
 *   `package.json` 里真有的 script。这四份散文是**唯一一批不进 `scripts/check-comment-refs.mjs`
 *   射程**的（那道门禁的 `SCAN_DIRS` 只收 `.ts/.js/.mjs`），而它们恰恰最爱写「见某某文件」。
 * · **(g) `SECURITY.md` 里那几句「这件事由测试守着」必须点得出是哪一格**：用本仓的名字锚
 *   写法引契约用例，标题逐字对不上就红。会话上限那个「12 小时」同样从
 *   `SESSION_MAX_AGE_MS` 现算，不手抄。
 *
 * ── 判据只有一份，反向控制从同一份进 ────────────────────────────────────────
 * 每条判据都写成 `(read, exists) => 失败报文[]` 的纯函数，真扫描传真 fs，反向控制传
 * 打过补丁的 `read`/`exists`。**没有第二份判据**，所以「探针绿了而真扫描是另一套逻辑」
 * 这种事在这里不成立。每一格反向控制在变异之前先跑一遍**基**：基本身就红的话，
 * 报文会直说「先去看真扫描那一格」，而不是让人从变异那一格的报文里找原因。
 *
 * ── 它做不到什么（明写，别读成「门面从此都是真的」）────────────────────────────
 * · (a) 只查**上报路径这句话在不在**，不查那条路径今天通不通——GitHub 侧把 Security
 *   Advisory 关掉了，这里一个字都不会吭。
 * · (b) 是**子串匹配的黑名单**，不是语义判断：换一句没在 `SOFT` 表里的措辞
 *   （“battle-tested”、“无需担心”）照样能把同一个意思写进去，它看不见。
 *   这条边界没有护栏，登记为已知盲点。
 * · (c) 只查**徽章指的 workflow 文件在不在**，不查那个 workflow 今天跑不跑得起来、
 *   更不查徽章链接点过去落在哪个分支。
 * · (d) 只查**三处的大版本相等**，不查这个大版本本身是不是还在维护期。
 * · (e) 只查**「引用了」与「有没有那句限定」这两件事的共现**，不查那句限定写在哪儿。
 *   把限定塞进文件最后一行、读者读到死链时根本没看到它——这里照样绿。
 *   ⚠️ 更要紧的一条：它**只认 tracked 的 `*.md`**。同一条死引用写进 `src/**.ts` 的注释里
 *   它一眼都不看（那一侧归 `scripts/check-comment-refs.mjs` 那道门禁管，而它
 *   的 `REPO_PREFIXES` 里没有 `.superpowers/`，两边合起来仍有这个洞）。
 * · (f) 只查**路径解析得开**，不查那份文件里真有它被引来说明的那件事；`pnpm` 那一半只查
 *   script 名字在不在，不查参数、也不查这个命令今天跑不跑得通。
 * · (g) 只查**被引的标题今天还在**，不查那条用例真的守着 `SECURITY.md` 声称的那件事——
 *   一条改成 `expect(1).toBe(1)` 的用例，标题不动的话这里照样绿。
 * · 整组都**只看仓库里的文本**：GitHub 侧的设置（Security Advisory 开没开、issue 模板认不认）
 *   一个字都验不到。
 */

type Read = (p: string) => string;
type Exists = (p: string) => boolean;

const realRead: Read = (p) => readFileSync(p, "utf8");
const realExists: Exists = (p) => existsSync(p);

/** 把某一份文件的内容换成变异版，其余照旧。**变异的唯一注入点**。 */
const patchRead = (base: Read, at: string, body: string): Read => (p) => (p === at ? body : base(p));
/** 把某一份文件变成「不存在」，其余照旧。 */
const hideFile = (base: Exists, at: string): Exists => (p) => (p === at ? false : base(p));

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

const COMMUNITY: readonly string[] = [
  "CONTRIBUTING.md",
  "SECURITY.md",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/pull_request_template.md",
];

/** 「去哪儿报」那句话。GitHub 的功能名或「私下 / 非公开」的说法，任一即可。 */
const REPORT_PATH_RE = /Security Advisor|security advisor|私下|privately|非公开/i;

function communityFailures(exists: Exists, read: Read): string[] {
  const out = COMMUNITY.filter((f) => !exists(f)).map((f) => `${f} 不存在`);
  if (!exists("SECURITY.md")) return out;
  if (!REPORT_PATH_RE.test(read("SECURITY.md"))) {
    out.push("SECURITY.md 没写去哪儿报 —— 一份只有标题的安全政策，比没有更糟");
  }
  return out;
}

/* ── (b) 别把仓库纪律说成运行时安全承诺 ───────────────────────────────────── */

const SOFT = ["is secure", "完全安全", "绝对安全", "安全です", "안전합니다"];

function softClaims(read: Read): string[] {
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

/* ── (d) node 大版本三处一致 ──────────────────────────────────────────────── */

interface MajorAt { where: string; major: string }

/** `.github/workflows/` 下的 yml，**从磁盘扫**，不写死清单——加第四个 workflow 时它自动进射程。 */
function workflowFiles(): string[] {
  return readdirSync(".github/workflows").filter((f) => f.endsWith(".yml")).sort();
}

function nodeMajors(read: Read): MajorAt[] {
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
  for (const f of workflowFiles()) {
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

function nodeMajorFailures(read: Read): string[] {
  const all = nodeMajors(read);
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
/** 溯源限定里那句话。改词就要连这里一起改，改不动就说明有文档没跟上。 */
const NOTE = "不随仓库推送";
/** 本计划文件。它自己就是引用大户，**判据必须不放过它**。 */
const PLAN = "docs/design/2026-08-22-agnes2api-p3e-i18n-and-closeout-plan.md";

function trackedMarkdown(): string[] {
  const raw = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { encoding: "utf8" });
  const files = raw.split("\0").filter(Boolean);
  if (files.length === 0) {
    throw new Error("`git ls-files -- '*.md'` 一个文件都没列出来 —— 扫描坏了，不许静默当成空集");
  }
  return files;
}

const ledgerReferrers = (files: readonly string[], read: Read): string[] =>
  files.filter((f) => read(f).includes(LEDGER));

const ledgerUnqualified = (files: readonly string[], read: Read): string[] =>
  ledgerReferrers(files, read).filter((f) => !read(f).includes(NOTE));

/* ── (f) 四份社区文件写下的每一条仓内指向都得解析得开 ─────────────────────── */

/**
 * 社区文件是**唯一一批不进 `scripts/check-comment-refs.mjs` 射程**的散文（那道门禁的 `SCAN_DIRS` 只收
 * `.ts/.js/.mjs`），而它们恰恰是最爱写「见某某文件」的一批。这里补上同一件事的 markdown 侧。
 *
 * 两种形态都收，因为两种都在这四份文件里真的出现了：
 * · markdown 相对链接 `[文字](路径)` —— **按所在文件的目录解析**，
 *   `.github/ISSUE_TEMPLATE/bug_report.md` 里那条 `../../SECURITY.md` 只有这样才判得对；
 * · 行内 code span 里的仓内路径（`scripts/scan-secrets.sh` 这种）—— 必须带至少一个 `/`
 *   且首段是仓里真有的顶层目录，否则 `pnpm/action-setup` 这类外部名字会被误收。
 */
const TOP_DIRS = ["src", "tests", "scripts", "docs", "admin-ui", ".github"];
const LINK_RE = /\]\(([^)\s]+)\)/g;
const CODE_PATH_RE = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?)`/g;

function communityRefs(read: Read): { from: string; target: string; resolved: string }[] {
  const out: { from: string; target: string; resolved: string }[] = [];
  for (const from of COMMUNITY) {
    const body = read(from);
    const here = dirname(from);
    for (const m of body.matchAll(LINK_RE)) {
      const t = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("#")) continue;
      out.push({ from, target: t, resolved: normalize(join(here, t)) });
    }
    for (const m of body.matchAll(CODE_PATH_RE)) {
      const t = m[1]!;
      if (!TOP_DIRS.includes(t.split("/")[0]!)) continue;
      out.push({ from, target: t, resolved: normalize(t) });
    }
  }
  return out;
}

function communityRefFailures(read: Read, exists: Exists): string[] {
  const refs = communityRefs(read);
  if (refs.length === 0) {
    throw new Error("四份社区文件里一条仓内指向都没抠出来 —— 判据坏了，不许静默当成「它们没提任何文件」");
  }
  return refs
    .filter((r) => !exists(r.resolved))
    .map((r) => `${r.from} 指向 ${r.target}（解析成 ${r.resolved}），而那个位置不存在`);
}

/** 社区文件里写下的 `pnpm <名字>` 必须是 `package.json` 里真有的 script。 */
const PNPM_RE = /`pnpm ([a-z][a-z0-9:_-]*)`/g;

function pnpmScriptFailures(read: Read): string[] {
  const scripts = (JSON.parse(read("package.json")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  const out: string[] = [];
  let seen = 0;
  for (const from of COMMUNITY) {
    for (const m of read(from).matchAll(PNPM_RE)) {
      seen += 1;
      const name = m[1]!;
      if (!(name in scripts)) out.push(`${from} 让人跑 \`pnpm ${name}\`，而 package.json 里没有这个 script`);
    }
  }
  if (seen === 0) {
    throw new Error("四份社区文件里一条 `pnpm <名字>` 都没抠出来 —— 判据坏了，不许静默当成「它们没写任何命令」");
  }
  return out;
}

/* ── (g) SECURITY.md 引的那两条契约用例，标题必须逐字对得上 ───────────────── */

/**
 * 一条契约测试的路径，紧跟着用 「」 括起来的用例标题 —— 本仓的名字锚写法，
 * 这里把它用在 markdown 那一侧。
 * ⚠️ 这段注释刻意不举字面例子：举一个就要么指向一个不存在的文件（那道注释指向门禁会当场红），
 * 要么把某份真测试写进一段与它无关的说明里。
 */
const CITED_CASE_RE = /`(tests\/contract\/[A-Za-z0-9_.-]+\.test\.ts)`「([^」]+)」/g;

function citedCaseFailures(read: Read): string[] {
  const cites = [...read("SECURITY.md").matchAll(CITED_CASE_RE)];
  if (cites.length === 0) {
    throw new Error(
      "SECURITY.md 里一条带名字锚的契约用例引用都没抠出来 —— 要么判据坏了，"
      + "要么那几句「这件事由测试守着」被改成了空口白话，两种都该有人来看",
    );
  }
  const out: string[] = [];
  for (const c of cites) {
    const file = c[1]!;
    const title = c[2]!;
    if (!existsSync(file)) {
      out.push(`SECURITY.md 引了 ${file}，而那个文件不存在`);
      continue;
    }
    if (!readFileSync(file, "utf8").includes(`it("${title}"`)) {
      out.push(`SECURITY.md 引了 ${file}「${title}」，而那个文件里没有这条用例`);
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */

describe("公开仓的门面：社区文件 / CI 徽章 / node 大版本 / 工作账本的溯源限定", () => {
  const REAL_A = "公开仓的社区文件都在，且 SECURITY.md 里有一条可用的上报路径";
  const REAL_B = "SECURITY.md 不把仓库纪律说成运行时安全承诺";
  const REAL_C = "README 的 CI 徽章指向 .github/workflows 下真的存在的那个 workflow";
  const REAL_D = "Dockerfile / CI / package.json 三处钉的 node 大版本一致";
  const REAL_E = "引用工作账本 .superpowers 的 tracked 文档都写明了它不随仓库推送";

  it(REAL_A, () => {
    const failures = communityFailures(realExists, realRead);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(a) 该红时红：SECURITY.md 删到只剩一行标题 —— 报文说的是「没写去哪儿报」，不是「文件不存在」", () => {
    probeBase(communityFailures(realExists, realRead), REAL_A);
    const failures = communityFailures(realExists, patchRead(realRead, "SECURITY.md", "# Security Policy\n"));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("SECURITY.md 没写去哪儿报");
  });

  it("(a) 该红时红：少一份社区文件 —— 逐份点名，不是只说「有文件缺了」", () => {
    probeBase(communityFailures(realExists, realRead), REAL_A);
    const gone = ".github/ISSUE_TEMPLATE/feature_request.md";
    const failures = communityFailures(hideFile(realExists, gone), realRead);
    expect(failures).toEqual([`${gone} 不存在`]);
  });

  it(REAL_B, () => {
    const hits = softClaims(realRead);
    expect(hits, `报文：\n${hits.join("\n")}`).toEqual([]);
  });

  it("(b) 该红时红：SECURITY.md 里写一句 “this gateway is secure”", () => {
    probeBase(softClaims(realRead), REAL_B);
    const mutated = `${realRead("SECURITY.md")}\n\nThis gateway is secure.\n`;
    const hits = softClaims(patchRead(realRead, "SECURITY.md", mutated));
    expect(hits).toEqual(["SECURITY.md 里出现「is secure」"]);
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
    const failures = nodeMajorFailures(realRead);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(d) 该红时红：Dockerfile 换成 node:20-alpine —— 报文把三处各自的值都摆出来", () => {
    probeBase(nodeMajorFailures(realRead), REAL_D);
    const mutated = realRead("Dockerfile").replaceAll("node:22-", "node:20-");
    expect(mutated, "变异没落地 —— Dockerfile 里已经不是 node:22-").not.toBe(realRead("Dockerfile"));
    const failures = nodeMajorFailures(patchRead(realRead, "Dockerfile", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("Dockerfile");
    expect(failures[0] ?? "").toContain("= 20");
    expect(failures[0] ?? "").toContain("package.json 的 engines.node = 22");
  });

  it("(d) 该红时红：engines 整个删掉 —— 报文说的是「（缺失）」，不是静默放行", () => {
    probeBase(nodeMajorFailures(realRead), REAL_D);
    const pkg = JSON.parse(realRead("package.json")) as Record<string, unknown>;
    delete pkg["engines"];
    const failures = nodeMajorFailures(patchRead(realRead, "package.json", JSON.stringify(pkg)));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("package.json 的 engines.node = （缺失）");
  });

  it("(d) 认不出要吵：Dockerfile 里认不出 node 大版本时当场抛，不静默当成「这里没有约束」", () => {
    const blind = patchRead(realRead, "Dockerfile", "FROM alpine\n");
    expect(() => nodeMajorFailures(blind)).toThrow(/判据坏了/);
  });

  it(REAL_E, () => {
    const failures = ledgerUnqualified(trackedMarkdown(), realRead);
    expect(failures, `这些文档引用了 ${LEDGER} 却没说读者打不开：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(e) 射程自守：真的扫到了引用方，而且本计划文件在射程内 —— 它自己就是引用大户", () => {
    const referrers = ledgerReferrers(trackedMarkdown(), realRead);
    expect(referrers.length, "一份都没扫到，扫描多半写坏了").toBeGreaterThan(0);
    expect(referrers, "本计划文件掉出了射程 —— 判据放过了自己").toContain(PLAN);
  });

  it("(e) 该红时红：新加一条 .superpowers 引用而不加那句限定 —— 点名新加的那一份", () => {
    const files = trackedMarkdown();
    probeBase(ledgerUnqualified(files, realRead), REAL_E);
    const victim = "README.md";
    expect(ledgerReferrers(files, realRead), "选错了变异对象：README.md 今天本来就引用了工作账本")
      .not.toContain(victim);
    const mutated = `${realRead(victim)}\n\n（变异）出处见 ${LEDGER}/sdd/p3e-backlog.md。\n`;
    expect(ledgerUnqualified(files, patchRead(realRead, victim, mutated))).toEqual([victim]);
  });

  const REAL_F = "四份社区文件写下的每一条仓内指向都解析得开";
  const REAL_G = "SECURITY.md 引的那几条契约用例，文件与标题都对得上";

  it(REAL_F, () => {
    const failures = communityRefFailures(realRead, realExists);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(f) 该红时红：issue 模板里那条 ../../SECURITY.md 写成 ../SECURITY.md —— 按所在目录解析，点名它", () => {
    probeBase(communityRefFailures(realRead, realExists), REAL_F);
    const at = ".github/ISSUE_TEMPLATE/bug_report.md";
    const mutated = realRead(at).replace("../../SECURITY.md", "../SECURITY.md");
    expect(mutated, "变异没落地 —— 模板里已经不是 ../../SECURITY.md").not.toBe(realRead(at));
    const failures = communityRefFailures(patchRead(realRead, at, mutated), realExists);
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain(at);
    expect(failures[0] ?? "").toContain(".github/SECURITY.md");
  });

  it("(f) 不乱红：`pnpm/action-setup` 这种外部名字不是仓内路径，不许被收进射程", () => {
    probeBase(communityRefFailures(realRead, realExists), REAL_F);
    const at = "CONTRIBUTING.md";
    const mutated = `${realRead(at)}\n\nCI 用的是 \`pnpm/action-setup\` 与 \`actions/setup-node\`。\n`;
    expect(communityRefFailures(patchRead(realRead, at, mutated), realExists)).toEqual([]);
  });

  it("社区文件里写下的每一条 `pnpm <名字>` 都是 package.json 里真有的 script", () => {
    const failures = pnpmScriptFailures(realRead);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(f2) 该红时红：把 `pnpm test:workers` 写成 `pnpm test:worker` —— 点名那份文件与那个名字", () => {
    probeBase(pnpmScriptFailures(realRead), "社区文件里写下的每一条 `pnpm <名字>` 都是 package.json 里真有的 script");
    const at = "CONTRIBUTING.md";
    const mutated = realRead(at).replaceAll("`pnpm test:workers`", "`pnpm test:worker`");
    expect(mutated, "变异没落地 —— CONTRIBUTING.md 里已经不写 `pnpm test:workers`").not.toBe(realRead(at));
    const failures = pnpmScriptFailures(patchRead(realRead, at, mutated));
    expect(failures).toEqual([`${at} 让人跑 \`pnpm test:worker\`，而 package.json 里没有这个 script`]);
  });

  it(REAL_G, () => {
    const failures = citedCaseFailures(realRead);
    expect(failures, `报文：\n${failures.join("\n")}`).toEqual([]);
  });

  it("(g) 该红时红：被引的那条用例改了名 —— SECURITY.md 那句「由测试守着」当场变红", () => {
    probeBase(citedCaseFailures(realRead), REAL_G);
    const mutated = realRead("SECURITY.md").replace("响应体整段文本里都找不到明文 key", "响应体里找不到明文 key");
    expect(mutated, "变异没落地 —— SECURITY.md 里已经不是那条标题").not.toBe(realRead("SECURITY.md"));
    const failures = citedCaseFailures(patchRead(realRead, "SECURITY.md", mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("tests/contract/admin-keys.test.ts「响应体里找不到明文 key」");
  });

  it("(g) 认不出要吵：SECURITY.md 里一条名字锚都没有时当场抛，不静默当成「没什么可查」", () => {
    const stripped = realRead("SECURITY.md").replaceAll("「", "【").replaceAll("」", "】");
    expect(() => citedCaseFailures(patchRead(realRead, "SECURITY.md", stripped))).toThrow(/判据坏了|空口白话/);
  });

  it("SECURITY.md 写的会话上限与 `SESSION_MAX_AGE_MS` 一致 —— 那个「12 小时」不是手抄的", () => {
    const hours = SESSION_MAX_AGE_MS / 3_600_000;
    expect(Number.isInteger(hours), `会话上限不再是整数小时（${SESSION_MAX_AGE_MS} ms），SECURITY.md 的措辞要跟着改`).toBe(true);
    expect(realRead("SECURITY.md"), `SECURITY.md 里没写「${hours} hours」`).toContain(`${hours} hours`);
    // 同一段里还写了「时刻在未来同样按过期算」。这句同样从真源验，不是描述性散文。
    const now = 1_000_000;
    expect(sessionExpired(now + 60_000, now), "SECURITY.md 说未来时刻按过期算，而 sessionExpired 不这么认为").toBe(true);
  });

  it("(e) 不放过自己：把那句限定从本计划文件里删掉 —— 点名本计划文件", () => {
    const files = trackedMarkdown();
    probeBase(ledgerUnqualified(files, realRead), REAL_E);
    const mutated = realRead(PLAN).split(NOTE).join("（限定被变异抹掉了）");
    expect(mutated, "变异没落地 —— 本计划文件里找不到那句限定").not.toBe(realRead(PLAN));
    expect(ledgerUnqualified(files, patchRead(realRead, PLAN, mutated))).toEqual([PLAN]);
  });
});
