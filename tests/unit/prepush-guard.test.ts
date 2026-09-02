import { describe, it, expect } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACEHOLDERS } from "../helpers/internal-ref-placeholders.js";

/**
 * ── `scripts/prepush.sh` 的元测试 ────────────────────────────────────────────
 *
 * 那个脚本是推送前唯一的总闸，而它最值钱的一件事是：**跑的那几道门禁是从
 * `.github/workflows/ci.yml` 当场抽出来的，不是在它自己里面手抄一份**。
 * 手抄的那份会漂，而且漂了没人会发现——本地那套安安静静地比 CI 少跑一截，
 * 正是这个脚本存在的理由的反面。
 *
 * ⚠️ **抽取器最坏的死法不是抛错，是「少抽几行还照样 exit 0」**：多行 `run: |` 块只抽到
 * 第一行的话，凭据扫描那一步就只剩工作树那一条命令，历史那一档一声不吭地消失，
 * 而屏幕上打的仍然是一排绿。所以下面每一条「我认得出 X」都配一条夹具反向控制：
 * 把 ci.yml 复制一份、只动那一处，判据必须跟着变。
 *
 * ⚠️ 这里**不重跑**那几道门禁（那是几分钟的事，也已经由 CI 自己跑着）。这里跑的是
 * `--print-gates` 干跑档：它只把抽出来的东西打出来，一道都不执行。
 */

const PREPUSH = "scripts/prepush.sh";

interface Gate {
  num: string;
  flags: string;
  name: string;
  body: string;
}

function printGates(ciPath?: string): { code: number; stdout: string; stderr: string } {
  const args = [PREPUSH, "--print-gates"];
  if (ciPath !== undefined) args.push(ciPath);
  const r = spawnSync("bash", args, { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function parseGates(stdout: string): Gate[] {
  const gates: Gate[] = [];
  let cur: Gate | null = null;
  for (const line of stdout.split("\n")) {
    const m = /^### GATE (\S+) \| (.+?) \| (.*)$/.exec(line);
    if (m) {
      cur = { num: m[1]!, flags: m[2]!, name: m[3]!, body: "" };
      gates.push(cur);
      continue;
    }
    if (cur) cur.body += line + "\n";
  }
  return gates;
}

/**
 * ci.yml 的**第二份读法**，只在这份测试里用：按 `      - ` 切成一个个 step 块。
 * 判据据此推出「该有哪几道、哪几道声明了 `shell: bash`」，再与脚本抽出来的对照。
 * 两份读法都写歪成同一个样子的概率，比抄一份期望值再一起漂低得多。
 */
function ciSteps(yml: string): { name: string; num: string; declaresBash: boolean }[] {
  const chunks = yml.split(/^ {6}- /m).slice(1);
  const out: { name: string; num: string; declaresBash: boolean }[] = [];
  for (const chunk of chunks) {
    const m = /^name: (\d+)\/\d+ .*$/m.exec(chunk);
    if (!m) continue;
    out.push({
      name: m[0].replace(/^name: /, ""),
      num: m[1]!,
      declaresBash: /^ {8}shell: bash\s*$/m.test(chunk),
    });
  }
  return out;
}

function fixture(edit: (yml: string) => string): string {
  const yml = readFileSync(".github/workflows/ci.yml", "utf8");
  const dir = mkdtempSync(join(tmpdir(), "prepush-fixture-"));
  const p = join(dir, "ci.yml");
  writeFileSync(p, edit(yml), "utf8");
  return p;
}

/* ── 逐字抠片段：探针与真扫描共用同一份判据 ───────────────────────────────────
 *
 * 下面几族用例跑的**不是这里另抄的一份等价物，是 `scripts/prepush.sh` 里那几行本身**：
 * 按名字把一个函数（或末尾那段逐格表）从脚本里原样抠出来，配上它需要的那点前置，
 * 做成一个能单跑的脚本。理由是这几格在整份脚本里跑一次要十几分钟（十二道全跑），
 * 而它们各自要验的东西是纯逻辑。
 *
 * ⚠️ **抠不到要当场抛，不许静默跳过**：抠成空串的话，下面每一条断言都会退化成同义反复
 * （「空脚本里没有 X」恒真）——这正是本仓「判据用错工具时不会报错，会静静地放行」那条。
 */
function fragment(re: RegExp, what: string): string {
  const m = re.exec(readFileSync(PREPUSH, "utf8"));
  if (!m) throw new Error(`prepush.sh 里抠不出${what} —— 判据坏了，不许静默跳过`);
  return m[0];
}

/** 抠一个顶层函数：从 `名字() {` 那一行到第一行顶格的 `}`。 */
const fnOf = (name: string): string =>
  fragment(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}$`, "m"), `${name}()`);

/** 抠一行顶层赋值（`SKIPPED_MARK=…` / `BANNER=…` 这种），值也从真源来，不在这里手抄。 */
const constOf = (name: string): string =>
  fragment(new RegExp(`^${name}=.*$`, "m"), `${name}= 那一行`);

function runBash(script: string, opts: { cwd?: string; args?: string[] } = {}) {
  const r = spawnSync("bash", ["-c", script, "prepush-fragment", ...(opts.args ?? [])], {
    encoding: "utf8",
    cwd: opts.cwd,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=xwteam@xwteam.cn", "-c", "user.name=xwteam", ...args],
    { cwd, encoding: "utf8" },
  );

/** 造一个只有 main 的真仓，再 `git clone` 一份出来 —— clone 那份是 ② 那一格的真形态。 */
function makeRepos(): { root: string; src: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "prepush-repo-"));
  const src = join(root, "src");
  execFileSync("git", ["init", "-q", "-b", "main", src], { encoding: "utf8" });
  writeFileSync(join(src, "a.txt"), "hi\n", "utf8");
  git(src, "add", "a.txt");
  git(src, "commit", "-qm", "init");
  git(root, "clone", "-q", src, join(root, "clone"));
  return { root, src, clone: join(root, "clone") };
}

/** 末尾那段逐格表 + 整体退出码，连同它真正的 `SKIPPED_MARK=` 一起抠出来单跑。 */
const TAIL_MARKER = "# ── 逐格表 ─";
function tailScript(rows: readonly (readonly [string, string, string])[]): string {
  const s = readFileSync(PREPUSH, "utf8");
  const i = s.indexOf(TAIL_MARKER);
  if (i < 0) throw new Error("prepush.sh 里找不到逐格表那一段 —— 判据坏了，不许静默跳过");
  return [
    "set -uo pipefail",
    // 逐格表认第三种状态（`--skip-smoke` 留下的那一行），它的字面量从真源抠。
    constOf("SKIPPED_MARK"),
    `CELL_IDS=(${rows.map(([id]) => `"${id}"`).join(" ")})`,
    `declare -A CELL_TITLE=(${rows.map(([id, t]) => `[${id}]="${t}"`).join(" ")})`,
    `declare -A CELL_STATUS=(${rows.map(([id, , st]) => `[${id}]="${st}"`).join(" ")})`,
    s.slice(i),
  ].join("\n");
}

describe("prepush.sh 跑的门禁是从 ci.yml 当场抽的", () => {
  it("真 ci.yml：条数、编号顺序、步名与 ci.yml 自己写的逐条对齐", () => {
    const r = printGates();
    expect(r.code, `--print-gates 干跑不该失败：${r.stderr}`).toBe(0);
    const gates = parseGates(r.stdout);
    const steps = ciSteps(readFileSync(".github/workflows/ci.yml", "utf8"));
    expect(steps.length).toBeGreaterThan(0);
    expect(gates.map((g) => g.num)).toEqual(steps.map((s) => s.num));
    expect(gates.map((g) => g.name)).toEqual(steps.map((s) => s.name));
    // 编号必须是 1..N 顺序各一次，而不是「碰巧两边都乱成同一个样子」。
    expect(gates.map((g) => g.num)).toEqual(gates.map((_, i) => String(i + 1)));
  });

  it("每一道抽出来的命令都不是空的", () => {
    const gates = parseGates(printGates().stdout);
    for (const g of gates) {
      expect(g.body.trim(), `「${g.name}」抽出来是空的`).not.toBe("");
    }
  });

  /**
   * 多行 `run: |` 块必须**整块**抽出来。只抽第一行的话，凭据扫描那一步会只剩工作树
   * 那一条命令，两个测试入口会只剩 `pnpm test`、丢掉 tee 落盘与横幅校验——
   * 三处都是「少跑了还照样打绿」。
   */
  it("多行 run 块整块抽出来，不是只抽第一行", () => {
    const gates = parseGates(printGates().stdout);
    const bodyOf = (anchor: string) => {
      const hit = gates.filter((g) => g.body.includes(anchor));
      expect(hit.length, `ci.yml 里跑「${anchor}」的步不是恰好一步`).toBe(1);
      return hit[0]!.body;
    };
    const secrets = bodyOf("bash scripts/scan-secrets.sh\n");
    expect(secrets).toContain("bash scripts/scan-secrets.sh --history");
    expect(secrets).toContain("::error::");
    expect(secrets).toContain("exit $rc");
    for (const anchor of ["pnpm test 2>&1", "pnpm test:workers 2>&1"]) {
      const body = bodyOf(anchor);
      expect(body).toContain("| tee /tmp/test-");
      expect(body).toContain("grep -qF '[collection-guard] ✅'");
    }
  });

  /**
   * 每一步用哪套 shell flag 也是抽出来的。GitHub 对 `run:` 的默认是 `bash -e {0}`，
   * 显式写了 `shell: bash` 的那几步多一个 `pipefail`——而本仓恰恰有几步靠 `pipefail`
   * 才成立（`pnpm … 2>&1 | tee` 那两步）。一律用同一套 flag 会让这份复跑要么比 CI 严、
   * 要么比 CI 松，两种都不是「复跑」。
   */
  it("shell: bash 那几步带 pipefail，没声明的那几步不带", () => {
    const gates = parseGates(printGates().stdout);
    const steps = ciSteps(readFileSync(".github/workflows/ci.yml", "utf8"));
    const declared = new Map(steps.map((s) => [s.num, s.declaresBash]));
    expect([...declared.values()].filter(Boolean).length).toBeGreaterThan(0);
    expect([...declared.values()].filter((v) => !v).length).toBeGreaterThan(0);
    for (const g of gates) {
      expect(g.flags, `「${g.name}」的 shell flag 与 ci.yml 里那一步声明的对不上`)
        .toBe(declared.get(g.num) === true ? "-eo pipefail" : "-e");
    }
  });
});

describe("prepush.sh 的抽取器：认不出要吵，不许静静放行", () => {
  it("反向控制：ci.yml 少一步 ⇒ 干跑非 0 并点名少了几道", () => {
    const p = fixture((yml) =>
      yml.replace(/^ {6}- name: 8\/13 .*\n {8}run: .*\n/m, ""),
    );
    const r = printGates(p);
    expect(r.code, "少了一步却照样 exit 0 —— 那正是这份复跑最坏的死法").not.toBe(0);
    expect(r.stderr).toMatch(/编号|道/);
  });

  it("反向控制：多行块被截短 ⇒ 抽出来的命令跟着少，判据看得见", () => {
    const p = fixture((yml) => yml.replace(/^ {10}bash scripts\/scan-secrets\.sh --history.*\n/m, ""));
    const gates = parseGates(printGates(p).stdout);
    const secrets = gates.filter((g) => g.body.includes("bash scripts/scan-secrets.sh\n"));
    expect(secrets.length).toBe(1);
    expect(secrets[0]!.body, "块判据对「块尾被删掉一行」不敏感").not.toContain("--history");
  });

  it("反向控制：删掉一处 shell: bash ⇒ 那一道的 flag 跟着变，不是恒回同一套", () => {
    const before = parseGates(printGates().stdout).find((g) => g.body.includes("pnpm test 2>&1"));
    expect(before?.flags).toBe("-eo pipefail");
    const p = fixture((yml) =>
      yml.replace(/^( {6}- name: 11\/13 .*\n) {8}shell: bash\n/m, "$1"),
    );
    const after = parseGates(printGates(p).stdout).find((g) => g.body.includes("pnpm test 2>&1"));
    expect(after?.flags, "flag 不是从 ci.yml 读的，是写死的").toBe("-e");
  });

  it("反向控制之二：判据对真 ci.yml 不乱红（上面三条动的都是副本）", () => {
    const r = printGates();
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("认不出的参数要吵，不许静静跑成默认档", () => {
    const r = spawnSync("bash", [PREPUSH, "--print-gate"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("认不出的参数");
  });
});

describe("prepush.sh 自己的形态：逐格跑完再汇总，红不许被吃掉", () => {
  const src = () => readFileSync(PREPUSH, "utf8");

  /**
   * 顶层 `-e` 会让它在第一格红的地方停住，而「④⑤ 红、其余全绿」这个结论就永远读不到了。
   * 格内的 `set -e` 是另一回事：那是为了让格子里的意外失败当场把这一格弄红。
   */
  it("顶层是 `set -uo pipefail`，不带 -e；-e 只出现在每一格自己的子壳里", () => {
    const s = src();
    expect(s).toMatch(/^set -uo pipefail$/m);
    expect(s, "顶层加回 -e ⇒ 第一格红就中止，后面几格的状态永远不知道").not.toMatch(/^set -euo/m);
    expect(s).toContain("( set -e; \"$fn\" )");
  });

  /**
   * ③ 里 `ci.yml` 的凭据扫描那一步把工作树档与历史档合成一步，红了分不清是哪一档，
   * 而两档要动的地方完全不同。它因此收窄出一种形态单独说话：红的只有那一道、
   * 且同一个脚本的工作树档单独跑是绿的 ⇒ 命中只在已提交的历史里。
   * 少任何一条，报文都必须退回笼统那一句——这一支绝不许替别的红打掩护。
   *
   * ⚠️ **它返回的是 1，不是一个「预期红」的专用退出码**（评审发现）：
   * 历史里那笔泄漏已经在一次性历史重写里清干净了，这一档再红就是新回归。
   * 曾经的 `EXPECTED_RED=35` / `MARK="EXPECTED-RED-UNTIL-TASK-35"` 一并撤掉，
   * 下面那条反向断言钉住「别把它加回来」。
   */
  it("③ 的诊断分支是收窄的：只有那一道红、且工作树档单独绿时才说「命中只在历史里」", () => {
    const body = /\ncell_gates\(\) \{\n([\s\S]*?)\n\}\n/.exec(src())?.[1];
    expect(body, "cell_gates 的函数体没抠出来，下面几条等于白写").toBeTruthy();
    expect(body!, "那一支不再要求「只有一道红」⇒ 它会替别的红打掩护")
      .toMatch(/\(\( \$\{#failed\[@\]\} == 1 \)\) && grep -qF -- "scan-secrets\.sh --history"/);
    expect(body!, "那一支不再单独确认工作树档是绿的 ⇒ 工作树里的命中会被说成「只在历史里」")
      .toContain("bash scripts/scan-secrets.sh >/dev/null 2>&1");
    expect(body!, "那一支不再按红处理 ⇒ 它又变回一个豁免").toMatch(/^ *return 1$/m);
  });

  /**
   * ⚠️ **这一格只查源码字面，它挡不住「块里那句 `exit 1` 被改掉」**（复评实测：
   * 把 `exit 1` 改成 `exit 0`，脚本从此一路放行、屏幕上照打「⇒ 不该推」却 exit 0，
   * 而这一格仍然全绿）。所以块里那一行现在也一起断言，**并且**下面
   * 「把逐格表那几行逐字抠出来跑，一格非 PASS ⇒ 整体退出码 1」
   * 那一格真的把它跑起来验退出码——字面与行为两侧都钉住。
   *
   * ⚠️ **第三档不许回来**（评审发现）：这里曾经有过
   * `EXPECTED_RED=35` / `MARK="EXPECTED-RED-UNTIL-TASK-35"` 那一档「已登记的预期红」，
   * 它的理由（历史里那个泄漏 blob 还在）在一次性历史重写落地时就了结了。
   * 下面两条反向断言锚的是**顶层赋值**，不是那两个字样——文件头与逐格框架那两段
   * 正当地复述着这段历史，锚字样会把那两段说明一起打红。
   */
  it("只要有一格非 PASS，整体退出码就是 1（而且没有第三档可以放行）", () => {
    const s = src();
    expect(s).toMatch(/if \(\( failed != 0 \)\); then/);
    expect(s, "顶层又出现了 EXPECTED_RED= ⇒ 那个只在历史重写落地前成立的豁免档位被加回来了")
      .not.toMatch(/^EXPECTED_RED=/m);
    expect(s, "顶层又出现了 MARK= ⇒ 同上；今天只该有 SKIPPED_MARK 这一个状态字面量")
      .not.toMatch(/^MARK=/m);
    const block = /\nif \(\( failed != 0 \)\); then\n([\s\S]*?)\nfi\n/.exec(s)?.[1];
    expect(block, "那个 if 块没抠出来，下面这条等于白写").toBeTruthy();
    expect(block!, "块里必须留着「⇒ 不该推」那句话，否则抠出来的不是这个块").toContain("不该推");
    expect(block!, "块里那句 exit 1 没了 ⇒ 红一路放行，屏幕照打「不该推」而退出码是 0")
      .toMatch(/^ *exit 1$/m);
  });

  /**
   * 用例数写等号、不写 `>=`。本仓在这上面栽过一次，事情记在
   * `tests/unit/docs-parity.test.ts「五语言 DEPLOY.md 的关键数字对等」` 的文件头：
   * 判据当时是「每种语言各自至少出现 N 次」，把其中一处数字悄悄改错之后计数从 3 掉到 2、
   * 仍然满足「≥ 1」，门禁一声不吭。这一格是「别把它改成 `>=` 形态」的绊线。
   */
  it("测试基线数是等号形态：比数那个函数里不许出现大小于比较", () => {
    const s = src();
    const consts = [...s.matchAll(/^EXPECT_[A-Z_]+=(\d+)$/gm)];
    expect(consts.length).toBe(4);
    // 判据锚到**比数的那个函数体**，不是整份脚本：脚本别处有正当的大小于
    // （抽取器那段 awk 的 `for (i = 1; i <= cnt; i++)`），扩到全文只会逼出一张豁免名册。
    const body = /\ncheck_log\(\) \{ #[^\n]*\n([\s\S]*?)\n\}\n/.exec(s)?.[1];
    expect(body, "check_log 的函数体没抠出来，下面几条等于白写").toBeTruthy();
    expect(body!, "改成 >= 形态 ⇒ 悄悄少掉一格用例永远不会红").not.toMatch(/-ge |-gt |>=|<=/);
    // 反向控制：抠函数体这一步真的抠到了内容——抠成空串的话，「里面没有大小于」
    // 是一句同义反复。下面三条同时也是「那四个数真的被用在判据上」的证据。
    expect(body!).toContain("passed \\(${files}\\)");
    expect(body!).toContain("passed \\(${tests}\\)");
    expect(body!.match(/\[\[ \$n != 1 \]\]/g)?.length).toBe(2);
  });

  /**
   * 复评发现：**逻辑**早就是从步名 `N/M` 推的（上面几格实测过它跟得上 13 道），
   * 但**话**曾经写死在六处，其中一处是会打到屏幕上的 ❌ 报文。
   * 本仓已有同族纪律（`tests/unit/scripts-guard.test.ts` 的
   * 「ci.yml 的注释行里不许写门禁的绝对序号」），只是那条判据只扫 `ci.yml`、够不着 `.sh`。
   *
   * ⚠️ **射程写明白，别读成「任何数字都不许」**：这里禁的是「十…道」与两位以上阿拉伯数字
   * 加「道」。个位数（写成「九道」）不在射程里——今天的门禁数是两位，缩到个位是另一回事，
   * 真发生了要回来扩这条判据。下面的正向控制用**这份脚本昨天真的写过的那句原话**，
   * 反向控制用**它今天真的还写着的那几种写法**。
   */
  it("脚本正文里不许写死门禁的总道数：那个数改的那天，写死的话会静静变假", () => {
    const s = src();
    const HARDCODED = /(?:十[一二三四五六七八九]?|\d{2,}\s?)道/g;
    // 正向控制：判据认得出这个形态（两句都是本文件历史上真的写过的）。
    expect("它是把已有的十二道按 ci.yml 的顺序重跑一遍".match(HARDCODED)).toEqual(["十二道"]);
    expect("实际只抽到 13 道".match(HARDCODED)).toEqual(["13 道"]);
    // 反向控制：脚本今天真的还写着这几句，一句都不许被误伤。
    const innocent = ["那一道红", "还有第二道红", "少的那几道不会被跑到", "每一道的退出码"];
    for (const ok of innocent) {
      expect(s, `反向控制选了一句脚本里其实没有的话「${ok}」，这条控制是空的`).toContain(ok);
      expect(ok.match(HARDCODED), `误伤了脚本里真实存在的写法「${ok}」`).toBeNull();
    }
    expect(s.match(HARDCODED) ?? [], "脚本正文里把门禁总道数写死了").toEqual([]);
  });

  /**
   * 复评发现：❌ 的解释走 stderr、末尾那张逐格表走 stdout ⇒ `> log` / `| tee` 留下来的
   * 那份日志里只剩一张说「红了」却不说为什么的表。整跑档因此把两股并成一股。
   * ⚠️ 但**干跑档不许一起并**：`--print-gates` 是给这份测试读的机器档，
   * 上面「反向控制之二：判据对真 ci.yml 不乱红」断言它 stderr 恰好 0 字节、
   * 「反向控制：ci.yml 少一步 ⇒ 干跑非 0 并点名少了几道」断言报文落在 stderr——
   * 合并会把这两条一起弄坏。所以这里连**位置**一起钉：合并必须在参数分派之后。
   */
  it("整跑档把 stderr 并进 stdout，且这一步在参数分派之后（干跑档的两股流不许被合并）", () => {
    const s = src();
    const iExec = s.indexOf("\nexec 2>&1\n");
    expect(iExec, "整跑档没合并两股流 ⇒ 留档的日志里会只剩一张不说理由的表").toBeGreaterThan(-1);
    const iEsac = s.indexOf("\nesac\n");
    expect(iEsac, "参数分派那个 case 块没找到，下面这条等于白写").toBeGreaterThan(-1);
    expect(iExec, "合并写在了参数分派之前 ⇒ 干跑档的 stderr 也被并走，上面那两条反向控制跟着坏")
      .toBeGreaterThan(iEsac);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 下面这一族**逐字抠出脚本里的那几行真跑**（见文件中部 `fragment()` 那段说明）：
 * 整份脚本跑一次是十几分钟（十二道全跑），而这几格各自要验的是纯逻辑。
 * ────────────────────────────────────────────────────────────────────────── */

describe("prepush.sh 的逐格表：红不许被吃掉，列位不许错开", () => {
  const rows = [
    ["①", "工作树干净", "PASS"],
    ["③", "门禁按 ci.yml 同序跑完", "FAIL(exit 2)"],
    ["⑥", "测试数与横幅同时校验", "FAIL(exit 1)"],
  ] as const;

  /**
   * 复评那条的行为侧：上一版只断言源码里有那个 `if`，把块里的 `exit 1` 改成 `exit 0`
   * 之后守卫仍然全绿——而那正是这份产物最值钱的一句承诺（「给自己开豁免的清单，
   * 下一次就会被人当成绿的」）。这里把那几行真跑起来看退出码。
   *
   * ⚠️ **两格喂的退出码刻意不同**（`exit 2` / `exit 1`）：汇总那一步走的是
   * 「非 PASS 且非 SKIPPED 一律记 failed」，而不是去认某一个具体的退出码——
   * 全都喂 `exit 1` 的话，把判据写成「只认 exit 1」也照样全绿。
   */
  it("把逐格表那几行逐字抠出来跑：一格非 PASS ⇒ 整体退出码 1，不论它红成哪个退出码", () => {
    const allPass = rows.map(([id, t]) => [id, t, "PASS"] as const);
    const base = runBash(tailScript(allPass));
    expect(base.code, `全过时不该红：\n${base.stdout}${base.stderr}`).toBe(0);
    // ⚠️ **判词里那个数是从 `CELL_IDS` 现数的，不是写死的「六格」**（Task 34A 加了第七格，
    //   写死的那句话当场就会变假）。这里喂进去三行，判词就该说三格。
    expect(base.stdout).toMatch(/⇒ 3 格全过。$/m);

    const exit2 = runBash(tailScript([allPass[0]!, rows[1]!, allPass[2]!]));
    expect(exit2.code, "有一格 FAIL(exit 2)，整体退出码却不是 1 ⇒ 汇总只认得 exit 1 那一种红")
      .toBe(1);
    expect(exit2.stdout).toContain("不该推");
    expect(exit2.stdout).toContain("1 格 FAIL");

    const oneFail = runBash(tailScript([allPass[0]!, allPass[1]!, rows[2]!]));
    expect(oneFail.code, "有一格真 FAIL，整体退出码却不是 1").toBe(1);
    expect(oneFail.stdout).toContain("1 格 FAIL");
  });

  /**
   * 复评发现：`printf` 的 `%-28s` 按**字节**补齐，而标题全是中日韩宽字符
   *（一个字 3 字节、显示 2 列）⇒ 标题放在补齐位时行与行的列位全错。
   * 现在补齐位放的是 ASCII 状态串，标题挪到行尾。
   */
  it("逐格表的列位对得齐：补齐的那一列是 ASCII 状态，不是按字节补不准的中日韩标题", () => {
    // 夹具自守：几个标题的字节长度必须不一样，否则「按字节补」这件事在这里根本显不出来。
    const byteLens = new Set(rows.map(([, t]) => Buffer.byteLength(t, "utf8")));
    expect(byteLens.size, "夹具的标题字节长度全一样 ⇒ 这一格判不出「按字节补齐」").toBeGreaterThan(1);
    const widest = Math.max(...rows.map(([, , status]) => status.length));
    expect(widest, "有一个状态串比补齐宽度还长 ⇒ 那一行会把后面顶开").toBeLessThan(28);

    const r = runBash(tailScript(rows));
    const lines = r.stdout.split("\n");
    // ⚠️ **两列都要量**：只量标题那一列判不出这件事——把标题挪回补齐位时它恒在第 4 列，
    //   错开的是它**后面**那一列。（这条判据第一版正是只量了标题，把「标题挪回补齐位」
    //   那次变异放行了：判据用错工具时不会报错，会静静地放行。）
    const columnStarts = (pick: (row: (typeof rows)[number]) => string): number[] =>
      rows.map((row) => {
        const [, title] = row;
        const line = lines.find((l) => l.includes(title));
        expect(line, `逐格表里没有「${title}」那一行`).toBeTruthy();
        const at = line!.indexOf(pick(row));
        expect(at, `「${pick(row)}」在那一行里找不到`).toBeGreaterThan(0);
        return at;
      });
    const titleAt = columnStarts(([, title]) => title);
    const statusAt = columnStarts(([, , status]) => status);
    expect(new Set(titleAt).size, `标题这一列的起始列位对不齐（各行是 ${titleAt.join(" / ")}）`).toBe(1);
    expect(
      new Set(statusAt).size,
      `状态这一列的起始列位对不齐（各行是 ${statusAt.join(" / ")}）—— 补齐位上放的是按字节补不准的中日韩标题`,
    ).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Task 34A：第七格（双形态真机冒烟）与它那个 `--skip-smoke` 开关。
 *
 * **一个可以静默跳过的检查等于没有**（本仓 `--reporter=basic` 空跑那一族就是这么绿了
 * 一整轮的）。所以这一族钉两件事：⑦ 真的接上了、而且跳过它会在屏幕上留下痕迹。
 * ────────────────────────────────────────────────────────────────────────── */

describe("prepush.sh 的 ⑦ 真机冒烟格：接上了，而且跳过它不是静默的", () => {
  const src = () => readFileSync(PREPUSH, "utf8");
  const SMOKE = "scripts/smoke-dual-runtime.sh";

  /**
   * ①～⑥ 全是「仓库文本 / 门禁 / 测试数」这一档，**没有一格构建镜像或跑容器**，
   * 而仓里有一批注释把自己的了结条件写成「在双形态真机验收之前」。⑦ 是它们的落点。
   * ⚠️ 这里连**被跑的那个脚本真的存在**一起断言：跑一个不存在的脚本时 bash 回 127，
   *   逐格表上会是一格 `FAIL(exit 127)`——那当然会被看见，但报文说的不是真因。
   */
  it("⑦ 接的是双形态真机冒烟脚本，而那个脚本真的在仓里", () => {
    const s = src();
    expect(s, "⑦ 那一格没接上").toContain(`run_cell "⑦"`);
    const body = /\ncell_smoke\(\) \{\n([\s\S]*?)\n\}\n/.exec(s)?.[1];
    expect(body, "cell_smoke 的函数体没抠出来，下面这条等于白写").toBeTruthy();
    expect(body!, "⑦ 跑的不是那份冒烟脚本").toContain(`bash ${SMOKE}`);
    expect(existsSync(SMOKE), `${SMOKE} 不在仓里 —— ⑦ 会以 exit 127 红在一个说不清真因的报文上`).toBe(true);
  });

  /**
   * `--skip-smoke` 必须走 `skip_cell`（记 `$SKIPPED_MARK`），不许悄悄不跑。
   * ⚠️ **正向控制用「这个开关今天真的存在」，反向控制用「它没被接到 run_cell 上」**：
   *   把 `skip_cell` 换成什么都不做的话，⑦ 连行都不会出现在逐格表里。
   */
  it("--skip-smoke 走的是 skip_cell，逐格表里那一行记的是 SKIPPED，不是「什么都没发生」", () => {
    const s = src();
    expect(s).toMatch(/^\s*--skip-smoke\) SKIP_SMOKE=1 ;;$/m);
    const block = /\nif \(\( SKIP_SMOKE == 1 \)\); then\n([\s\S]*?)\nfi\n/.exec(s)?.[1];
    expect(block, "跳过分支没抠出来，下面几条等于白写").toBeTruthy();
    expect(block!, "跳过分支不再调 skip_cell ⇒ ⑦ 会从逐格表里整行消失").toContain('skip_cell "⑦"');
    expect(block!, "跳过分支不再有「不跳过就跑」的那一支").toContain('run_cell "⑦"');
    const fn = /\nskip_cell\(\) \{ #[^\n]*\n([\s\S]*?)\n\}\n/.exec(s)?.[1];
    expect(fn, "skip_cell 的函数体没抠出来").toBeTruthy();
    expect(fn!, "skip_cell 记的不是 SKIPPED ⇒ 跳过就变成了「过」").toContain('CELL_STATUS[$id]="$SKIPPED_MARK"');
  });

  /**
   * 行为侧：把逐格表那几行逐字抠出来跑，喂一行 `SKIPPED` 进去。
   * ⚠️ **判词不许再说「N 格全过」**：那一行是这张表唯一会被当成结论引用的东西，
   *   而它在有一格根本没跑的时候是假的。退出码仍是 0（用户显式要求跳过时不该被拦住），
   *   所以「屏幕上写着他跳过了哪一格」是这里唯一的护栏。
   */
  it("--skip-smoke 不是静默跳过：逐格表里留下 SKIPPED 那一行，判词也不再说「全过」", () => {
    const rows = [
      ["①", "工作树干净", "PASS"],
      ["⑥", "测试数与横幅同时校验", "PASS"],
      ["⑦", "双形态真机冒烟", "SKIPPED"],
    ] as const;
    const allPass = rows.map(([id, t]) => [id, t, "PASS"] as const);

    const base = runBash(tailScript(allPass));
    expect(base.code, `全过时不该红：\n${base.stdout}${base.stderr}`).toBe(0);
    expect(base.stdout, "没跳过时判词就该是那一句「N 格全过。」").toMatch(/⇒ 3 格全过。$/m);
    expect(base.stdout, "一格都没跳过，汇总行却数出了跳过的格").toContain("0 格 SKIPPED");
    expect(base.stdout, "一格都没跳过，表里却出现了一行 SKIPPED").not.toContain("⑦ SKIPPED");

    const skipped = runBash(tailScript(rows));
    expect(skipped.code, "显式要求跳过时不该被拦住").toBe(0);
    expect(skipped.stdout, "逐格表里没有那一行 SKIPPED ⇒ 跳过是静默的").toContain("⑦ SKIPPED");
    expect(skipped.stdout, "汇总行没把跳过的格数单独数出来").toContain("1 格 SKIPPED");
    expect(skipped.stdout, "判词没说清那一格是没验到、不是过了").toContain("没验到，不是过了");
    expect(
      skipped.stdout,
      "有一格被跳过时判词仍然是那句干净的「N 格全过。」—— 那句话此刻是假的",
    ).not.toMatch(/⇒ \d+ 格全过。$/m);
  });
});

describe("prepush.sh 的 ② 分支格：clone 出来的仓也得是绿的", () => {
  const script = ["set -uo pipefail", fnOf("cell_branch"), "cell_branch"].join("\n");

  /**
   * 复评发现：`refs/remotes/origin/HEAD` 的 `%(refname:short)` 是**裸的 `origin`**，
   * 上一版按 `<远端>/main` 拼的放行名单认不出它 ⇒ 任何一个 `git clone` 出来的仓里
   * ② 都会红，并劝人「删掉分支「origin」」——那不是分支，删不掉。
   * 公开仓读者第一件事就是 clone，所以这是屏幕上会被看见的那一类错。
   */
  it("② cell_branch 在 clone 出来的仓里是绿的：远端 HEAD 那条符号引用不是「开了一个分支」", () => {
    const { root, src, clone } = makeRepos();
    try {
      // 先钉住这一格真的在验那个危险形态：clone 里确实躺着一条 short 形是裸 `origin` 的 ref。
      const shorts = git(clone, "branch", "-a", "--format=%(refname:short)").split("\n");
      expect(shorts, "clone 里没有那条裸 `origin` ⇒ 这一格验的不是复评那个形态").toContain("origin");

      // 反向控制：没有远端的裸仓（本仓今天的形态）本来就该绿。
      const bare = runBash(script, { cwd: src });
      expect(bare.code, `裸仓（只有 main、无远端）不该红：\n${bare.stdout}${bare.stderr}`).toBe(0);

      const cloned = runBash(script, { cwd: clone });
      expect(cloned.code, `clone 出来的仓被判红了：\n${cloned.stdout}${cloned.stderr}`).toBe(0);
      expect(cloned.stdout).toContain("HEAD = main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("② 真多开了一个分支照样红，并点名它 —— 放行远端 HEAD 不等于放行一切", () => {
    const { root, clone } = makeRepos();
    try {
      git(clone, "branch", "feat/x");
      const r = runBash(script, { cwd: clone });
      expect(r.code, "多了一个真分支却没红 ⇒ 放行条件被放得太宽").toBe(1);
      expect(r.stderr).toContain("除 main 之外还有分支");
      expect(r.stderr).toContain("feat/x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("② 远端 HEAD 指向的不是 <远端>/main ⇒ 红，且报文说清它不是一个分支、删不掉", () => {
    const { root, clone } = makeRepos();
    try {
      git(clone, "update-ref", "refs/remotes/origin/dev", "refs/remotes/origin/main");
      git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
      const r = runBash(script, { cwd: clone });
      expect(r.code, "远端 HEAD 指向别处也照样放行 ⇒ 放行条件没有收窄").toBe(1);
      expect(r.stderr).toContain("远端 HEAD 符号引用");
      expect(r.stderr, "报文得给出它自己的处置办法，不是「删分支」").toContain("set-head");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepush.sh 的报文：方向要说对，别把人指到与这次失败无关的那几行上", () => {
  /**
   * 复评发现：上一版「多抽到一道」和「少抽到一道」共用同一句「少的那几道不会被跑到」。
   * 抽到的是**多**了一道时，真正要改的是步名里的分母；照那句话去找「少掉的那几道」是死路。
   */
  it("抽到的道数与步名说的对不上时，报文得说对方向（多了 / 少了）", () => {
    const more = printGates(
      fixture((yml) => `${yml.replace(/\n?$/, "\n")}      - name: 14/13 变异追加的一道\n        run: true\n`),
    );
    expect(more.code, "多出一道却照样 exit 0").not.toBe(0);
    expect(more.stderr).toContain("步名说共");
    expect(more.stderr, "多抽到一道时说成「少的那几道」⇒ 照报文去找的是一件不存在的事")
      .toContain("多出来的那几道");
    expect(more.stderr).not.toContain("少的那几道");

    const fewer = printGates(fixture((yml) => yml.replace(/^ {6}- name: 13\/13 .*\n {8}run: .*\n?/m, "")));
    expect(fewer.code, "少了一道却照样 exit 0").not.toBe(0);
    expect(fewer.stderr).toContain("步名说共");
    expect(fewer.stderr).toContain("少的那几道");
    expect(fewer.stderr).not.toContain("多出来的那几道");
  });

  /**
   * 复评发现：`check_log` 的尾巴无条件把人指回 `EXPECT_*` 那四行。
   * 那句劝阻是这一格最值钱的护栏（人最想做的一步恰恰是「把基线改成日志里的实际值」，
   * 改完就绿），但它只对**数字对不上**那一种红成立；横幅缺失时数字明明是对的。
   */
  const checkLog = ["set -uo pipefail", constOf("BANNER"), fnOf("check_log"), 'check_log "$@"'].join("\n");
  const FILES = 133;
  const TESTS = 3632;
  const synthLog = (opts: { banner?: boolean; tests?: number } = {}): string => {
    const lines = [
      ...(opts.banner === false ? [] : ["[collection-guard] ✅ 逐一核对通过"]),
      "",
      ` Test Files  ${FILES} passed (${FILES})`,
      `      Tests  ${opts.tests ?? TESTS} passed (${opts.tests ?? TESTS})`,
      "",
    ];
    const dir = mkdtempSync(join(tmpdir(), "prepush-log-"));
    const p = join(dir, "test.log");
    writeFileSync(p, lines.join("\n"), "utf8");
    return p;
  };
  const runCheckLog = (log: string) =>
    runBash(checkLog, { args: [log, "夹具运行时", String(FILES), String(TESTS)] });

  it("check_log：数字对不上时，把人指向 EXPECT_* 那四行（并先把日志里的实际值摆出来）", () => {
    // 反向控制先跑：横幅在、两行数字都对 ⇒ 绿、stderr 一个字都没有。
    const base = runCheckLog(synthLog());
    expect(base.code, `真形态的合成日志被判红了：\n${base.stdout}${base.stderr}`).toBe(0);
    expect(base.stderr).toBe("");

    const r = runCheckLog(synthLog({ tests: TESTS - 1 }));
    expect(r.code, "少一格用例却没红").toBe(1);
    expect(r.stderr).toContain("日志里实际那两行是");
    expect(r.stderr).toContain("EXPECT_");
  });

  it("check_log：只因横幅缺失变红时，不许把人指向 EXPECT_* —— 那四行与这次失败无关", () => {
    const r = runCheckLog(synthLog({ banner: false }));
    expect(r.code, "横幅没了却没红").toBe(1);
    expect(r.stderr).toContain("收集门禁");
    expect(r.stderr, "两行数字明明都对，把人指回 EXPECT_* 等于亲手把人引进坑")
      .not.toContain("EXPECT_");
    expect(r.stderr, "数字没问题，却把日志里那两行摆出来 ⇒ 又把人的注意力引回数字上")
      .not.toContain("日志里实际那两行是");
  });
});

/**
 * ── ⑧ 未推送提交信息格 ──────────────────────────────────────────────────────
 *
 * 这一格补的是本仓栽过一次的那个洞：**没有任何判据看得住提交信息**。
 * `scan-secrets.sh --history` 只扫凭据，`docs-internal-refs.test.ts` 的射程按定义
 * 是那 44 份公开 markdown ——而提交信息随 push 一起发出去，公开仓的 `git log` 谁都读得到。
 * 结果就是：判据刚扩到第二批字母那一族，紧接着的五个 refactor 提交在**自己的提交信息里**
 * 又写回了上百处本族编号，且当场没有一道门禁红。
 *
 * ⚠️ **这一族最要紧的一条是「族定义不许手抄」**：`cell_commit_msgs` 是从
 * `docs-internal-refs.test.ts` 里那几行 `re:` 当场抽的。抽取器最坏的死法不是抛错，
 * 是**一族都没抽到还照样 exit 0**（「零族零命中」长得和「干净」一模一样）。
 * 所以下面既有正向控制（真的会红、逐族点名），也有两条针对抽取器自己的反向控制。
 *
 * ⚠️ **下面一个族串都不在这份文件里手写**：证据串是运行时从那份真源里读出来的。
 * 手写一份进来，这份测试自己就成了下一处泄漏点（它是跟踪文件，读者克隆就看得到）。
 */
describe("⑧ 未推送提交信息格：族定义抽真源、脏提交点名、已推送的不进射程", () => {
  const FAMILY_SRC = "tests/unit/docs-internal-refs.test.ts";
  const SRC_FAMILY_SRC = "tests/unit/source-internal-refs.test.ts";
  const script = [
    "set -uo pipefail",
    constOf("FAMILY_SRC"),
    constOf("SRC_FAMILY_SRC"),
    fnOf("expand_placeholders"),
    fnOf("cell_commit_msgs"),
    "cell_commit_msgs",
  ].join("\n");

  /** 真源里逐族登记的那个正向证据串，**运行时读**，不在本文件里手写一份。 */
  function evidenceStrings(): string[] {
    const out = readFileSync(FAMILY_SRC, "utf8")
      .split("\n")
      .map((l) => /^ +evidence: "(.*)",$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]!);
    if (out.length === 0) {
      throw new Error(`${FAMILY_SRC} 里一个 evidence: 都读不出来 —— 判据坏了，不许静默跳过`);
    }
    return out;
  }

  /** 真源里逐族登记的族名，报文点名点的就是它。 */
  function familyIds(): string[] {
    return readFileSync(FAMILY_SRC, "utf8")
      .split("\n")
      .map((l) => /^ +id: "(.*)",$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]!);
  }

  /**
   * 源码轴那份真源里，那三族登记的证据串。它们在文件里写成 `evidence: expand("…")`，
   * **带占位符**（真源自己在源码轴的射程里，原样写成字面量就是自己命中自己）。
   * ⇒ 这里把展开也交给 `prepush.sh` 自己那个 `expand_placeholders`。
   * ⚠️ **别把「两张展开表漂了会红」记在 ⑧ 的正向自检头上** —— 那是上一版写在这里的说法，
   * 回填时实测为假：那一步只在证据串真踩到某个占位符时才兜得住
   * （大写区间兜的是两个端点、圈号兜的是最后一个码位；轮次缩写那一个按定义就兜不住 ——
   * 正则源与证据串两边写的是同一个占位符，一起漂了照样匹配）。
   * ⇒ 两张表逐字节相不相等，由本文件下面那两格管：
   * 「🔴 两张展开表逐 token 比对：shell 那段展开与真源那张表逐字节相等」，
   * 以及它的变异探针「🔴 该红时红：shell 那段展开里某个值改一个字符 ⇒ 逐 token 比对当场对不上」。
   * 🔴 **一个真串都不在这份文件里手写** —— 手写一份进来，这份测试自己就成了下一处泄漏点。
   */
  function srcAxisEvidence(): string[] {
    const raw = readFileSync(SRC_FAMILY_SRC, "utf8")
      .split("\n")
      .map((l) => /^ +evidence: expand\("(.*)"\),$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]!);
    if (raw.length === 0) {
      throw new Error(`${SRC_FAMILY_SRC} 里一个 evidence: expand(…) 都读不出来 —— `
        + "⑧ 会少抽那几族，而它的失败模式正是「少抽还照样绿」");
    }
    const expanded = raw.map((s) => runBash(
      ["set -uo pipefail", fnOf("expand_placeholders"), `expand_placeholders ${JSON.stringify(s)}`]
        .join("\n"),
    ).stdout);
    for (const [i, s] of expanded.entries()) {
      if (s === "" || s === raw[i]) {
        throw new Error(`占位符没被展开（第 ${i + 1} 条：「${raw[i]}」⇒「${s}」）—— `
          + "拿没展开的串当探针，这一格验的就是空气");
      }
    }
    return expanded;
  }

  /** 源码轴那三族的族名，报文点名点的就是它（后面还缀着一截轴名）。 */
  function srcAxisFamilyIds(): string[] {
    const lines = readFileSync(SRC_FAMILY_SRC, "utf8").split("\n");
    const out: string[] = [];
    let id = "";
    let seen = false;
    for (const line of lines) {
      const mi = /^ +id: "(.*)",$/.exec(line);
      if (mi) { id = mi[1]!; seen = false; continue; }
      if (/^ +evidence: expand\("/.test(line) && !seen) { out.push(id); seen = true; }
    }
    return out;
  }

  /** 那张具名夹具白名单里的名字。同样运行时读，不在这份文件里手写。 */
  function allowlistNames(): string[] {
    const out = [...readFileSync(SRC_FAMILY_SRC, "utf8")
      .matchAll(/^\s+(?:\{ )?name: "([^"]+)"/gm)].map((m) => m[1]!);
    if (out.length === 0) {
      throw new Error(`${SRC_FAMILY_SRC} 里那张具名夹具白名单一条都读不出来 —— 判据坏了`);
    }
    return out;
  }

  /**
   * 一个**按定义解析不开**的文档名，拼出来。
   * 🔴 原样写成字面量的话，这份文件自己就多了一处解不开的引用 ——
   * 而源码轴那条结构化判法的射程正是跟踪文件，它会当场红在这一行上。
   */
  const ghostDoc = ["GHOST", "md"].join(".");

  const withRealSource = (cwd: string, srcOverride?: string, srcAxisOverride?: string) =>
    runBash([
      `FAMILY_SRC=${JSON.stringify(srcOverride ?? join(process.cwd(), FAMILY_SRC))}`,
      `SRC_FAMILY_SRC=${JSON.stringify(srcAxisOverride ?? join(process.cwd(), SRC_FAMILY_SRC))}`,
      script,
    ].join("\n"), { cwd });

  it("⑧ 接上了：逐格表里有它，跑的是 cell_commit_msgs，族定义的真源在仓里", () => {
    const s = readFileSync(PREPUSH, "utf8");
    expect(s, "⑧ 那一格没接上").toContain(`run_cell "⑧"`);
    expect(/run_cell "⑧"[^\n]*cell_commit_msgs/.test(s), "⑧ 接的不是 cell_commit_msgs").toBe(true);
    expect(constOf("FAMILY_SRC"), "族定义的真源那一行指的不是那份判据").toContain(FAMILY_SRC);
    expect(existsSync(FAMILY_SRC), `${FAMILY_SRC} 不在仓里 —— ⑧ 会红在一个说不清真因的报文上`)
      .toBe(true);
  });

  it("正向控制：提交信息干净的仓 ⇒ 绿，且屏幕上写着抽到几族、扫了几条", () => {
    const { root, src } = makeRepos();
    try {
      const r = withRealSource(src);
      expect(r.code, `干净的仓被判红了：\n${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout, "没说抽到几族 ⇒ 分不出「零命中」和「零族」").toMatch(/抽到 \d+ 族/);
      expect(r.stdout, "正向自检那一步没跑").toContain("正向自检");
      expect(r.stdout).toMatch(/射程：\d+ 条未推送提交/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("反向控制：逐族各塞一个证据串进提交信息 ⇒ 红，且逐族点名、点到提交", () => {
    const { root, src } = makeRepos();
    try {
      const evidence = evidenceStrings();
      git(src, "commit", "-q", "--allow-empty", "-m", `chore: 变异探针\n\n${evidence.join(" / ")}\n`);
      const sha = git(src, "rev-parse", "--short", "HEAD").trim();
      const r = withRealSource(src);
      expect(r.code, `提交信息里塞了 ${evidence.length} 族证据串却没红`).toBe(1);
      expect(r.stderr, "没点名是哪一条提交").toContain(sha);
      for (const id of familyIds()) {
        expect(r.stderr, `报文里没点名族「${id}」`).toContain(id);
      }
      for (const s of evidence) {
        expect(r.stderr, `报文里没把原串「${s}」摆出来`).toContain(s);
      }
      expect(r.stderr, "报文没给出处置办法").toContain("只动信息不动树");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **这一格是回填一条评审发现**：上一轮把三族新形状收进了源码轴那份判据，可 ⑧
   * 当时只从文档轴那七族抽 ⇒ 一条同时写着这三种形状的提交信息**七族全部零命中、
   * 当场放行**，而提交信息一旦推出去就改不动。下面两格分别盯着「抽得到」与「真的红」。
   */
  it("反向控制：源码轴那三族的证据串进提交信息 ⇒ 红，且逐族点名", () => {
    const { root, src } = makeRepos();
    try {
      const evidence = srcAxisEvidence();
      expect(evidence.length, "源码轴那几族一条证据串都没抽到").toBeGreaterThan(0);
      git(src, "commit", "-q", "--allow-empty", "-m", `chore: 变异探针\n\n${evidence.join(" / ")}\n`);
      const sha = git(src, "rev-parse", "--short", "HEAD").trim();
      const r = withRealSource(src);
      expect(r.code, `提交信息里塞了 ${evidence.length} 族源码轴证据串却没红 —— `
        + "⑧ 多半又只抽了文档轴那一份").toBe(1);
      expect(r.stderr, "没点名是哪一条提交").toContain(sha);
      for (const id of srcAxisFamilyIds()) {
        expect(r.stderr, `报文里没点名族「${id}」`).toContain(id);
      }
      for (const s of evidence) {
        expect(r.stderr, `报文里没把原串「${s}」摆出来`).toContain(s);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("两轴各抽一份：屏幕上分别写着从哪一份抽到几族，合计不少于两轴之和", () => {
    const { root, src } = makeRepos();
    try {
      const r = withRealSource(src);
      expect(r.code, `干净的仓被判红了：\n${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout, "报文里没提源码轴那份真源 ⇒ 分不出它到底抽没抽")
        .toContain(SRC_FAMILY_SRC);
      const m = /共 (\d+) 族/.exec(r.stdout);
      expect(m, "没打出合计族数 ⇒ 「少抽一族」这种失败在屏幕上看不出来").not.toBeNull();
      expect(Number(m![1]), "合计族数比两轴各自登记的还少 —— 有一份没抽到")
        .toBe(familyIds().length + srcAxisFamilyIds().length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("抽取器反向控制之三：源码轴那份的 `expand(` 形态坏了 ⇒ 红，不许当成零命中", () => {
    const { root, src } = makeRepos();
    const dir = mkdtempSync(join(tmpdir(), "prepush-families-"));
    try {
      // 只动一处：把 `source: expand("…")` 这个形态改成模板串，其余照抄真源。
      const broken = readFileSync(SRC_FAMILY_SRC, "utf8")
        .split("\n")
        .map((l) => l.replace(/^( +source: )expand\("(.*)"\),$/, "$1`$2`,"))
        .join("\n");
      const p = join(dir, "broken-source-axis.ts");
      writeFileSync(p, broken, "utf8");
      const r = withRealSource(src, undefined, p);
      expect(r.code, "源码轴那份一族都没抽到却照样 exit 0 ⇒ 那几族恒绿").toBe(1);
      expect(r.stderr).toContain("一族都没抽出来");
      expect(r.stderr, "报文得说清失败模式是「少抽还照样绿」").toContain("少抽还照样绿");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * ── 两张展开表不漂 ────────────────────────────────────────────────────────
   *
   * 🔴 **这三格是回填一条评审发现。** 族定义确实一个字都不手抄（上面那几格盯着），
   * 可 `expand_placeholders` 里那几个占位符的**值**是第二份手抄件：真值在
   * TypeScript 里，脚本那边是 shell，import 不过来，只能各写一份。
   * 而当时写在三处注释与一条提交信息里的说法是「两边漂了的话，正向自检当场红在
   * 『判据坏了』上」——**实测为假**：把 shell 那侧的圈号表削成一个字符，
   * ⑧ 的正向自检照样全绿、exit 0，而那一册指针的圈号写法在提交信息上恰恰是
   * 只由这段展开表把守的一支。正向自检按定义也兜不住那个轮次缩写
   *（正则源与证据串两边写的是同一个占位符，一起漂了照样匹配）。
   * ⇒ 这里补一格**逐 token 的字节比对**，再配一格变异探针，否则验的又是空气。
   *
   * ⚠️ **一个真值都不在本文件里手写**：TypeScript 那侧从
   * `tests/helpers/internal-ref-placeholders.ts` import，shell 那侧用 `fnOf` 从
   * `scripts/prepush.sh` 当场抠。
   */
  const expandFn = () => fnOf("expand_placeholders");

  /** 拿 shell 那段展开跑一条串。`mutate` 只给变异探针用：改完的那份照样从真源来。 */
  function expandInShell(s: string, mutate?: (fn: string) => string): string {
    const fn = expandFn();
    const body = mutate === undefined ? fn : mutate(fn);
    const r = runBash([
      "set -uo pipefail",
      body,
      `expand_placeholders ${JSON.stringify(s)}`,
    ].join("\n"));
    if (r.code !== 0) {
      throw new Error(`expand_placeholders 跑不起来（exit ${r.code}）：${r.stderr}`);
    }
    return r.stdout;
  }

  it("🔴 两张展开表逐 token 比对：shell 那段展开与真源那张表逐字节相等", () => {
    expect(PLACEHOLDERS.length, "真源那张表是空的 —— 这一格会变成零次循环，恒绿")
      .toBeGreaterThan(0);
    for (const [token, value] of PLACEHOLDERS) {
      expect(expandInShell(token),
        `占位符 ${token} 两边对不上 —— ⑧ 扫提交信息时认的形状与真源已经不是同一批，`
        + "而提交信息推出去就改不动").toBe(value);
    }
  });

  it("🔴 token 集合双向查：shell 那段展开认的占位符 = 真源那张表登记的，一条不多一条不少", () => {
    // ⚠️ 字符类刻意写成 `[^']*` 而不是大写区间：那个区间原样写进来，本文件自己就多了
    //    一处「字母 + 连字号 + 字母」的命中，源码轴那份判据会当场红在这一行上。
    const got = [...expandFn().matchAll(/\$\{s\/\/'(\{[^']*\})'\//g)].map((m) => m[1] as string);
    expect(got.length, "从那段展开里一个占位符都没抠出来 —— 抠取器坏了，这一格会恒绿")
      .toBeGreaterThan(0);
    expect([...got].sort(), "两张表的 token 集合对不上：shell 那边多一条 ⇒ 有人加了占位符"
      + "却没往真源里登记；少一条 ⇒ 真源里那一条在提交信息那一格上从来没被展开过")
      .toEqual(PLACEHOLDERS.map(([t]) => t).sort());
  });

  it("🔴 该红时红：shell 那段展开里某个值改一个字符 ⇒ 逐 token 比对当场对不上", () => {
    let probed = 0;
    for (const [token, value] of PLACEHOLDERS) {
      if (value === "") continue; // 空串那一条改不动：删一个字符还是空串
      // 拿真值的**最后一个字符**当变异点（从真源导出，不在本文件里挑一个字面量）：
      // 大写区间与那个缩写在 shell 里是拼出来的，被拼的那一小块同样只出现一次。
      const ch = [...value].at(-1) as string;
      const mutate = (fn: string) => fn.replace(ch, "");
      expect(mutate(expandFn()), `变异没落地（${token}）—— 这一格验的是空气`)
        .not.toBe(expandFn());
      expect(expandInShell(token, mutate),
        `把 shell 那侧 ${token} 的值改一个字符之后，逐 token 比对居然还相等 —— `
        + "那一格验的是空气").not.toBe(value);
      probed += 1;
    }
    expect(probed, "一个占位符都没探到 —— 真源那张表里全是空串？").toBeGreaterThan(0);
  });

  /**
   * ── 第二条判法：提交信息里引用的文档名必须解析得开 ──────────────────────────
   * 认形状那一套按定义守不住它（文件名身上一个编号形状都没有），而这一支恰恰是
   * 上一轮清掉的那一类：指着一份公开仓里根本不存在的内部账本 / 内部报告。
   */
  it("反向控制：提交信息里引用一份仓里没有的文档 ⇒ 红，点名提交与那个名字", () => {
    const { root, src } = makeRepos();
    try {
      git(src, "commit", "-q", "--allow-empty", "-m", `chore: 变异探针\n\n见 ${ghostDoc} 那一节\n`);
      const sha = git(src, "rev-parse", "--short", "HEAD").trim();
      const r = withRealSource(src);
      expect(r.code, "引用了一份不存在的文档却没红").toBe(1);
      expect(r.stderr, "没点名是哪一条提交").toContain(sha);
      expect(r.stderr, "没把那个解析不开的名字摆出来").toContain(ghostDoc);
      expect(r.stderr, "报文没给出处置办法").toContain("讲进句子里");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("不乱红：仓里真有的文档名、白名单里那些按定义就该不存在的夹具名，都不许红", () => {
    const { root, src } = makeRepos();
    try {
      writeFileSync(join(src, "README.md"), "# hi\n", "utf8");
      git(src, "add", "README.md");
      git(src, "commit", "-qm", "docs: 加一份 README.md");
      const fixtures = allowlistNames();
      git(src, "commit", "-q", "--allow-empty",
        "-m", `chore: 白名单里那几个夹具名\n\n${fixtures.join(" / ")}\n`);
      const r = withRealSource(src);
      expect(r.code, `真实文档名或白名单夹具名被误伤了：\n${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout, "没打出白名单抽到几条 ⇒ 抽空了会让每个夹具名都变假红，而屏幕上看不出来")
        .toMatch(/夹具白名单 \d+ 条/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("射程：已经推出去的那几条不进射程 —— clone 里只点名 clone 之后新提交的那条", () => {
    const { root, src, clone } = makeRepos();
    try {
      const evidence = evidenceStrings();
      // 先在源仓里造一条脏的并推上去 —— 它对 clone 来说就是「已经推出去的」。
      git(src, "commit", "-q", "--allow-empty", "-m", `chore: 已推送的脏提交\n\n${evidence[0]}\n`);
      git(clone, "fetch", "-q", "origin");
      git(clone, "reset", "-q", "--hard", "origin/main");
      const pushed = git(clone, "rev-parse", "--short", "HEAD").trim();

      const before = withRealSource(clone);
      expect(before.code, `已推送的那条被算进了射程：\n${before.stdout}${before.stderr}`).toBe(0);
      expect(before.stdout, "没说基线是哪几条远端跟踪引用").toContain("origin/main");

      git(clone, "commit", "-q", "--allow-empty", "-m", `chore: 还没推的脏提交\n\n${evidence[0]}\n`);
      const fresh = git(clone, "rev-parse", "--short", "HEAD").trim();
      const after = withRealSource(clone);
      expect(after.code, "还没推的那条脏提交没红").toBe(1);
      expect(after.stderr, "没点名还没推的那条").toContain(fresh);
      expect(after.stderr, `已推送的那条 ${pushed} 被点名了 ⇒ 射程没有停在未推送那一段`)
        .not.toContain(pushed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("抽取器反向控制：族表一族都抽不到 ⇒ 红并说「抽取器坏了」，不许当成零命中", () => {
    const { root, src } = makeRepos();
    const dir = mkdtempSync(join(tmpdir(), "prepush-families-"));
    try {
      const empty = join(dir, "no-families.ts");
      writeFileSync(empty, "export const FAMILIES = [];\n", "utf8");
      const r = withRealSource(src, empty);
      expect(r.code, "一族都没抽到却照样 exit 0 ⇒ 这一格恒绿").toBe(1);
      expect(r.stderr).toContain("一族都没抽出来");
      expect(r.stderr, "报文得说清「恒绿比没有这一格更坏」").toContain("恒绿");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("抽取器反向控制之二：正则抓不住自己那条证据串 ⇒ 红在「判据坏了」，不是「提交信息干净」", () => {
    const { root, src } = makeRepos();
    const dir = mkdtempSync(join(tmpdir(), "prepush-families-"));
    try {
      // 只动一处：把每一族的正则整条换成一个绝不可能匹配的形状，其余照抄真源。
      const broken = readFileSync(FAMILY_SRC, "utf8")
        .split("\n")
        .map((l) => (/^ +re: \//.test(l) ? "    re: /(?!x)x/g," : l))
        .join("\n");
      const p = join(dir, "broken.ts");
      writeFileSync(p, broken, "utf8");
      const r = withRealSource(src, p);
      expect(r.code, "正则被换成恒不匹配却照样 exit 0 ⇒ 自检那一步是摆设").toBe(1);
      expect(r.stderr).toContain("没被它自己那条正则抓住");
      expect(r.stderr, "报文说成「干净」会把人指反方向").toContain("判据坏了");
      expect(r.stdout, "自检没过却还打了「零命中」").not.toContain("零命中");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
