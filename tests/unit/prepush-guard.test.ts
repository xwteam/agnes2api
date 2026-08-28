import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      yml.replace(/^ {6}- name: 7\/12 .*\n {8}run: .*\n/m, ""),
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
      yml.replace(/^( {6}- name: 10\/12 .*\n) {8}shell: bash\n/m, "$1"),
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

describe("prepush.sh 自己的形态：逐格跑完再汇总，预期红不许被吃掉", () => {
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
   * ③ 那一格在一次性历史重写落地之前不可能全绿：`ci.yml` 的凭据扫描那一步自己就把
   * 历史那一档包在里面。它因此认一种「已登记的预期红」——而**任何一个预期红分支都是
   * 一个豁免形状的东西**，所以它必须是收窄的：红的只有那一道、且同一个脚本的工作树档
   * 单独跑是绿的，两条都成立才算。少任何一条，这一格就该按真红处理。
   */
  it("③ 的预期红是收窄的：只有那一道红、且工作树档单独绿时才算", () => {
    const body = /\ncell_gates\(\) \{\n([\s\S]*?)\n\}\n/.exec(src())?.[1];
    expect(body, "cell_gates 的函数体没抠出来，下面几条等于白写").toBeTruthy();
    expect(body!, "预期红分支不再要求「只有一道红」⇒ 它会替别的红打掩护")
      .toMatch(/\(\( \$\{#failed\[@\]\} == 1 \)\) && grep -qF -- "scan-secrets\.sh --history"/);
    expect(body!, "预期红分支不再单独确认工作树档是绿的 ⇒ 工作树回归会被当成历史欠账放过去")
      .toContain("bash scripts/scan-secrets.sh >/dev/null 2>&1");
    expect(body!).toContain('return "$EXPECTED_RED"');
  });

  it("预期红也算没过：只要有一格非 PASS，整体退出码就是 1", () => {
    const s = src();
    expect(s).toMatch(/if \(\( failed != 0 \|\| expected != 0 \)\); then/);
    expect(s).toContain("EXPECTED-RED-UNTIL-TASK-35");
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
});
