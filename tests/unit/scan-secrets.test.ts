import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/scan-secrets.sh");

/**
 * **凭据扫描门禁（`scripts/scan-secrets.sh`）自身的正确性。**
 *
 * 这个文件存在的直接理由（评审四审 B 组第 5 条）：`scan-secrets.sh` 原来用
 * `set -uo pipefail`（**没有** `-e`）+ `if git grep …; then 命中; fi` 判命中，而
 * `git grep` 的约定是 `0=有命中 / 1=没命中 / >1=出错`。`if` 只分零与非零，于是
 * **出错（实测过的两类：坏的 pathspec、`.git` 读不到／不在 git 仓库里，都是 128）
 * 被当成"没命中"**，脚本照样
 * 打印 `✅ 未发现疑似凭据` 并 exit 0——一道安全门禁在扫不动的时候报"扫干净了"。
 * 这不是假想：同一道门禁刚刚才因为 `-I` 的二进制盲区吃过一次亏（评审 F3）。
 *
 * 测法：**把脚本复制到一个临时目录里跑**。脚本开头是 `cd "$(dirname "$0")/.."`，
 * 所以它会 cd 到那个临时目录的父目录——由我们决定那里是不是一个 git 仓库、里面
 * 有没有东西。真实仓库的索引全程不被碰。
 */
function stageInto(root: string): string {
  mkdirSync(join(root, "scripts"), { recursive: true });
  const dest = join(root, "scripts", "scan-secrets.sh");
  copyFileSync(SCRIPT, dest);
  chmodSync(dest, 0o755);
  return root;
}

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function stageScript(makeRepo: boolean): string {
  const root = stageInto(mkdtempSync(join(tmpdir(), "a2a-scan-secrets-")));
  if (makeRepo) initRepo(root);
  return root;
}

/** 提交暂存区里的一切。`--no-gpg-sign` 免得跑在配了签名的机器上时挂住。 */
function commit(root: string, msg: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", msg], { cwd: root });
}

function run(
  root: string,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [join(root, "scripts", "scan-secrets.sh"), ...args], {
    encoding: "utf8",
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/**
 * **喂给被测脚本的 IP 一律在运行时拼出来，绝不在本文件里写成一个连续的字面量。**
 *
 * 本文件自己就在 `scripts/scan-secrets.sh` 的射程里（它扫工作树的全部跟踪文件，
 * 只排除自己和锁文件）。写一个公网可路由的 IP 进来，或者写一个「IP 冒号端口」
 * 进来，`scripts/scan-secrets.sh` 这道门禁当场打红——**这不是理论风险**：P3e 上一处提交刚把这类写法拆开，
 * 紧接着的一版又原样搬了回来，一次打红 9 处。
 * 同一条纪律的先例逐字在 `tests/unit/check-i18n.test.ts`。
 * ⇒ 用例标题与断言消息里也只写「哪一类地址」，不写那个值。
 */
const ip = (...octets: string[]): string => octets.join(".");

describe("scripts/scan-secrets.sh", () => {
  it("干净的仓库：exit 0 并打出成功横幅", () => {
    const root = stageScript(true);
    writeFileSync(join(root, "src.txt"), "nothing to see here\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("未发现疑似凭据");
  });

  it("仓库里混进疑似凭据：exit 1，且不打成功横幅", () => {
    const root = stageScript(true);
    // 字面量在这里**拼出来**，免得这个测试文件本身命中真实仓库的同一道门禁。
    const planted = "sk-" + "A".repeat(24);
    writeFileSync(join(root, "leak.txt"), `token = "${planted}"\n`);
    execFileSync("git", ["add", "-A"], { cwd: root });
    const result = run(root);
    expect(result.status, "命中疑似凭据必须 exit 1").toBe(1);
    expect(result.stdout, "命中时绝不能打成功横幅").not.toContain("未发现疑似凭据");
  });

  /**
   * **本文件的核心那一条**：`git grep` 以 0/1 之外的码失败时必须 fail closed。
   * 构造方式是"根本不在 git 仓库里"（`git grep` 退出码 128）——这是最容易复现、
   * 也最贴近真实故障形态（CI 上 checkout 没成功就跑到了这一步）的一种。
   * **不用"破坏 `.git/index`"来构造**：实测那种情况下 `git grep --untracked` 退出码
   * ≤ 1（它会退回去扫工作树），根本不是这条用例要覆盖的分支。
   */
  it("git grep 执行失败（不在 git 仓库里，退出码 128）：fail closed，绝不报「未发现疑似凭据」", () => {
    const root = stageScript(false); // 刻意不 git init
    const result = run(root);
    expect(result.status, "扫不动必须按失败处理，不能 exit 0").not.toBe(0);
    expect(result.stdout, "扫不动绝不能打成功横幅").not.toContain("未发现疑似凭据");
    expect(result.stderr).toContain("git grep 执行失败");
  });
});

/**
 * ── 第 6 条规则：不带端口的裸 IP + 白名单 ────────────────────────────────────
 *
 * **它为什么在这里**：第 5 条规则（`IP:PORT`）强制要有冒号和端口，于是一个
 * **不带端口**的服务器地址从它底下整个逃走。P3e 勘察用变异探针当场复现过这条逃逸。
 *
 * ⚠️ **两条规则必须各自独立**，绝不许合并成「IP，端口可选」再统一过白名单：
 * 回环地址在白名单里，合并会一次性废掉 P3d 真实抓获过的「回环地址加端口」那一格
 * ——那正是「把别处刚解决的问题搬过来」的正面靶子。下面 (c) 就是它的绊线。
 */
describe("scripts/scan-secrets.sh 第 6 条规则：裸 IP", () => {
  it.each([
    ["公网可路由的示例地址（example.com 当年那个 A 记录）", ["93", "184", "216", "34"]],
    ["私网段 172.16/12 的下边界外一格 —— 白名单宽了就会放它过去", ["172", "15", "0", "1"]],
    ["私网段 172.16/12 的上边界外一格 —— 同上", ["172", "32", "0", "1"]],
  ])("(a) 公网可路由且不在白名单的 IP ⇒ exit 1：%s", (_label, octets) => {
    const root = stageScript(true);
    writeFileSync(join(root, "deploy.md"), `部署在 ${ip(...octets)} 上\n`);
    execFileSync("git", ["add", "-A"], { cwd: root });
    const result = run(root);
    expect(result.status, "不在白名单里的裸 IP 必须 exit 1").toBe(1);
    expect(result.stdout, "命中时绝不能打成功横幅").not.toContain("未发现疑似凭据");
  });

  /**
   * **反向控制：白名单里的每一格都要有人站着。**
   * 少一格不是「宽松了」而是「严了」——被删掉的那一格会让这里当场变红，
   * 所以这张表同时是「白名单的每条 CIDR 都真的在生效」的测法。
   * ⚠️ 值一律用 `ip()` 拼，理由见它上面那段。
   */
  it("(b) 反向控制：白名单覆盖的每一类地址都不许红", () => {
    const root = stageScript(true);
    const allowed: [string, string[]][] = [
      ["回环 127/8", ["127", "0", "0", "1"]],
      ["私网 10/8", ["10", "0", "0", "1"]],
      ["私网 172.16/12 下边界", ["172", "16", "0", "1"]],
      ["私网 172.16/12 上边界", ["172", "31", "255", "254"]],
      ["私网 192.168/16", ["192", "168", "1", "100"]],
      ["RFC 5737 文档保留段之一", ["192", "0", "2", "1"]],
      ["RFC 5737 文档保留段之二", ["198", "51", "100", "9"]],
      ["RFC 5737 文档保留段之三", ["203", "0", "113", "7"]],
      ["未指定地址", ["0", "0", "0", "0"]],
      ["受限广播地址", ["255", "255", "255", "255"]],
      ["字面白名单第一条（本仓通用占位）", ["1", "2", "3", "4"]],
      ["字面白名单第二条（公共 DNS）", ["8", "8", "8", "8"]],
      ["八位组越界，根本不是 IP", ["999", "1", "1", "1"]],
    ];
    writeFileSync(
      join(root, "docs.md"),
      allowed.map(([label, o]) => `${label}: ${ip(...o)}`).join("\n") + "\n",
    );
    execFileSync("git", ["add", "-A"], { cwd: root });
    const result = run(root);
    expect(result.status, `白名单里的地址不许红。脚本说：\n${result.stdout}${result.stderr}`)
      .toBe(0);
  });

  /**
   * ⚠️⚠️ **这是 P3d 那次真实抓获**（回环地址 + 面板端口，写在一份测试的字面量里），
   * 白名单绝不能把它放过去：第 5 条规则**零白名单**，回环进白名单只对第 6 条生效。
   * 把两条规则合并成「IP，端口可选」再统一过白名单，这一格就会变绿——那正是本任务
   * 最省事也最错的那种写法。
   */
  it("(c) 保住旧能力：回环地址加 8791 端口那种写法仍然 exit 1", () => {
    const root = stageScript(true);
    const planted = `${ip("127", "0", "0", "1")}${":"}8791`;
    writeFileSync(join(root, "panel.md"), `页面停在 http://${planted}/panel\n`);
    execFileSync("git", ["add", "-A"], { cwd: root });
    const result = run(root);
    expect(result.status, "回环地址带端口是第 5 条规则的射程，必须 exit 1").toBe(1);
  });

  /**
   * 白名单自己的元测试。**字面白名单是这道门禁上唯一一处「人手放行真实公网地址」
   * 的地方**，它长大一格没有任何别的东西看得见。
   */
  it("(d) 字面白名单里每一条都带放行理由，且条数是手写的 —— 悄悄多放一个公网 IP 会红", () => {
    const sh = readFileSync("scripts/scan-secrets.sh", "utf8");
    const block = /字面白名单：([\s\S]*?)\n#\s*⚠️⚠️/.exec(sh)?.[1];
    expect(block, "找不到字面白名单那段").toBeTypeOf("string");
    const entries = [...block!.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((m) => m[0]);
    // 手写字面量等号：今天恰好 2 条。多一条就该有人来改这一行并写清理由。
    expect(entries.length, "字面白名单的条数变了 —— 回来改这个数并确认新那条真的是公开示例地址")
      .toBe(2);
    expect(block!, "白名单里有一条没写放行理由").toMatch(/放行理由[：:]/g);
  });

  /**
   * **两档的「形态判据」是两份，「放行判据」只有一份 —— 这一格钉的是后半句。**
   *
   * 工作树档把候选交给 `git grep -E`（那里 `\b` 是词边界），历史档把候选交给
   * `gawk`（**那里 `\b` 是退格，不是词边界**——照抄过去会静静地变成另一个意思）。
   * 所以形态那一层只能是两份各自成立的**超集**，而「哪些放行」必须只有一份。
   * ⇒ 同一条文本，两档必须给同一个答案；给不出来就是那一份放行判据被抄成了两份。
   */
  it("(e) 同一条裸 IP，工作树档与 --history 档给同一个答案", () => {
    for (const [label, octets, expected] of [
      ["白名单外的公网地址", ["93", "184", "216", "34"], 1],
      ["白名单里的文档保留段", ["203", "0", "113", "7"], 0],
    ] as [string, string[], number][]) {
      const root = stageScript(true);
      writeFileSync(join(root, "note.md"), `${label}: ${ip(...octets)}\n`);
      commit(root, "note");
      const worktree = run(root);
      const history = run(root, ["--history"]);
      expect(worktree.status, `工作树档：${label}`).toBe(expected);
      expect(history.status, `--history 档：${label}\n${history.stdout}${history.stderr}`)
        .toBe(expected);
    }
  });
});

/**
 * ── `--history`：扫可达历史里的每一个 blob ──────────────────────────────────
 *
 * **它为什么在这里**：不带 `--history` 时这个脚本只扫工作树。一个凭据只要进过一个
 * 提交，哪怕下一个提交就 `git rm` 掉，工作树那一档一个字都看不见——而 `git push`
 * 发的是历史。P3e 勘察用变异探针当场复现过：提交后再 `git rm` 提交，脚本仍 exit 0。
 */
describe("scripts/scan-secrets.sh --history", () => {
  it("(a) 提交一段假凭据后 git rm 再提交 ⇒ --history exit 1，而不带 --history 的同一次调用 exit 0", () => {
    const root = stageScript(true);
    writeFileSync(join(root, "ok.txt"), "clean\n");
    commit(root, "base");
    const planted = "sk-" + "B".repeat(24);
    writeFileSync(join(root, "leak.txt"), `token = "${planted}"\n`);
    commit(root, "leak");
    execFileSync("git", ["rm", "-q", "leak.txt"], { cwd: root });
    commit(root, "remove");

    const worktree = run(root);
    expect(worktree.status, `工作树档看不见被删掉的历史，这里必须 0：\n${worktree.stdout}`).toBe(0);
    const history = run(root, ["--history"]);
    expect(history.status, "历史档必须看见它").toBe(1);
    expect(history.stdout + history.stderr, "命中时绝不能打成功横幅")
      .not.toContain("未发现疑似凭据");
  });

  /**
   * **证明「只扫可达」这条边界是有意的，不是漏扫。**
   * `git add` 会把 blob 写进对象库，`git reset` 之后它变成不可达——**`git push`
   * 永远不会发送它**。真仓盘上此刻就躺着几十个这样的对象（历次变异探针的残渣，
   * 其中有带 `sk-…` 的，也有带「IP 冒号端口」形态的；**这个数随 auto-gc 随时会变，
   * 所以哪儿都别把它写死**）。改成 `--batch-all-objects` 会让这道门禁今天就红在
   * 那些残渣上，然后被人 `--no-verify` 绕过——那是把「警报淹掉信号」原样搬到
   * 安全门禁上。
   */
  it("(b) 反向控制：git add 假凭据但不提交、随后 git reset ⇒ --history exit 0", () => {
    const root = stageScript(true);
    writeFileSync(join(root, "ok.txt"), "clean\n");
    commit(root, "base");
    const planted = "sk-" + "C".repeat(24);
    writeFileSync(join(root, "loose.txt"), `token = "${planted}"\n`);
    execFileSync("git", ["add", "-A"], { cwd: root });   // blob 落进对象库
    execFileSync("git", ["reset", "-q"], { cwd: root }); // …随即变成不可达
    rmSync(join(root, "loose.txt"));                    // 工作树也清掉，否则命中的是工作树那一档
    const result = run(root, ["--history"]);
    expect(result.status, `不可达对象不该被扫到：\n${result.stdout}${result.stderr}`).toBe(0);
  });

  it("(c) 浅仓（git clone --depth 1）⇒ exit≠0 且 stderr 含「历史不完整，按失败处理」", () => {
    const src = mkdtempSync(join(tmpdir(), "a2a-scan-secrets-src-"));
    initRepo(src);
    writeFileSync(join(src, "a.txt"), "one\n");
    commit(src, "one");
    writeFileSync(join(src, "b.txt"), "two\n");
    commit(src, "two");
    // `file://` 而不是裸路径：裸路径会走本地硬链接优化，`--depth` 被忽略，克隆出来
    // 的仓根本不是浅仓——这条用例会在"看起来通过"的情况下什么都没验。
    const root = mkdtempSync(join(tmpdir(), "a2a-scan-secrets-shallow-"));
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${src}`, root]);
    expect(
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8" })
        .trim(),
      "夹具没造出浅仓，这条用例会空跑",
    ).toBe("true");
    stageInto(root);

    const result = run(root, ["--history"]);
    expect(result.status, "浅仓必须 fail closed").not.toBe(0);
    expect(result.stderr).toContain("历史不完整，按失败处理");
    expect(result.stdout, "扫不动绝不能打成功横幅").not.toContain("未发现疑似凭据");
  });

  it("(d) 空仓（0 提交）⇒ exit≠0，同样 fail closed", () => {
    const root = stageScript(true); // git init 了，但一个提交都没有
    const result = run(root, ["--history"]);
    expect(result.status, "空仓必须 fail closed").not.toBe(0);
    expect(result.stderr).toContain("历史不完整，按失败处理");
    expect(result.stdout, "扫不动绝不能打成功横幅").not.toContain("未发现疑似凭据");
  });

  /**
   * **这一格钉的是"报文别把证据弄丢"，而它是本任务自己踩出来的坑。**
   *
   * 第一版在 awk 里 `substr($0, 1, 300)` 截断命中行，一次撞出两个缺陷：
   * ① **fail open**：判定在下游做，第 301 个字节之后的凭据**整条消失**——真仓上
   *    立刻能构造出"历史里有、门禁说干净"；
   * ② LC_ALL=C 下截断是按字节切的，切在多字节字符中间之后，下游 bash 的 `read`
   *    **会把下一条记录连着吞进来**（最小复现：`printf 'A\tB\tabc\xe9\x87\nC\tD\tx\n'`
   *    喂给 `while IFS=$'\t' read -r a b c`，两条并成一行，第二条的 sha 与路径当场丢失）。
   *
   * 夹具刻意让第一条命中的 IP 落在第 300 字节之后，第二条紧跟其后：
   * 截断一回来，这一格就从「2 条」变成「1 条」或「前缀不对」。
   */
  it("(e) 命中行超长、截断点落在多字节字符上：两条命中各自成行，一条都不许丢", () => {
    const root = stageScript(true);
    const bad = ip("93", "184", "216", "34");
    // 150 个三字节汉字 = 450 字节，后面那个 IP 稳稳落在第 300 字节之后。
    writeFileSync(join(root, "long.md"), `${"中".repeat(150)}${bad} 第一条\n${bad} 第二条\n`);
    commit(root, "long");
    execFileSync("git", ["rm", "-q", "long.md"], { cwd: root }); // 只留历史，排除工作树那一档
    commit(root, "drop");

    expect(run(root).status, "工作树已经干净").toBe(0);
    const r = run(root, ["--history"]);
    expect(r.status, "历史里还在，必须红").toBe(1);
    const detail = r.stderr.split("\n").filter((l) => l.startsWith("   "));
    expect(detail.length, `两条命中要各报一条，实际报文：\n${r.stderr}`).toBe(2);
    for (const l of detail) {
      expect(l, "每一条都要带得出自己的 sha —— 记录被并行吞掉时这里会失手").toMatch(/^ {3}[0-9a-f]{12} /);
    }
  });

  it("(f) 未知参数 ⇒ exit≠0，不许当成默认档静静跑过去", () => {
    const root = stageScript(true);
    writeFileSync(join(root, "ok.txt"), "clean\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    const result = run(root, ["--histroy"]); // 手滑拼错
    expect(result.status, "认不出的参数要吵，不能装没看见").not.toBe(0);
    expect(result.stdout, "认不出参数时绝不能打成功横幅").not.toContain("未发现疑似凭据");
  });
});

/**
 * ── 注释与门禁序号 ──────────────────────────────────────────────────────────
 */
describe("scripts/scan-secrets.sh 的注释", () => {
  it("scan-secrets.sh 的注释写明了三条已知边界", () => {
    const s = readFileSync("scripts/scan-secrets.sh", "utf8");
    expect(s, "少了「只扫工作树」那条边界").toContain("不带 --history 时只扫工作树");
    expect(s, "少了「裸 IP 走哪条规则」那条边界").toContain("裸 IP 走第 6 条规则");
    expect(s, "少了「本脚本自己是盲区」那条边界").toContain("本脚本把自己排除在扫描外");
  });

  /**
   * **`scripts/check-comment-refs.mjs` 的规则 E 够不着 `.sh`**，理由是它的 `walk()`
   * 只收 `.ts` / `.js` / `.mjs`，而且 `commentBlocks()` 只认 `//` 与块注释、
   * 认不出 `#` 那种方言——**两层，两层都不在**。于是在这个 shell 脚本的注释里写回
   * 一个绝对序号，机器一声不吭。P3e Task 15 把仓里那几处手改完之后，**没有任何
   * 东西守着它们继续对**；那份报告把补法逐字写成了「在凭据扫描门禁自己那份元测试
   * 里加一格源码级断言」——就是这一格，与 `tests/unit/scripts-guard.test.ts`
   * 的「ci.yml 的注释行里不许写门禁的绝对序号」补 `.yml` 那一半的做法同形。
   *
   * ⚠️ **今天它建起来就是绿的**（Task 15 已改完），所以它是回归守卫而不是先红的
   * 断言。它不是死断言这件事由本任务的变异 M4 证明：往 `scripts/scan-secrets.sh`
   * 里写一句「第 N 道门禁」，这一格当场红。
   *
   * ⚠️ **判据不是「git grep 第 N 道」那种全仓正则**（需求书里那一版实测有四十余处
   * 命中，全部是「第二道保险 / 第一道筛子 / 第二道闸」这类**本来就正当**的句子）。
   * 判据要的是规则 E 那一条：**带门禁标记的绝对序号**才算。
   */
  const GATE_ORDINAL_CORE = "第\\s*(?:\\d+\\s*/\\s*\\d+|\\d+|[一二三四五六七八九十]+)\\s*道";
  const GATE_ORDINAL_RE = new RegExp(
    `${GATE_ORDINAL_CORE}\\s*门禁`
    + `|CI\\s*的?\\s*${GATE_ORDINAL_CORE}`
    + "|第\\s*\\d+\\s*/\\s*\\d+\\s*道",
  );

  it("scripts/scan-secrets.sh 里不许写门禁的绝对序号（这道门禁的射程够不着 .sh）", () => {
    const bad = readFileSync("scripts/scan-secrets.sh", "utf8")
      .split("\n")
      .flatMap((t, i) => (GATE_ORDINAL_RE.test(t) ? [`${i + 1}: ${t.trim()}`] : []));
    expect(
      bad,
      "这里写着门禁的绝对序号。CI 里增删或重排一步，它会静静变假，而"
      + "`scripts/check-comment-refs.mjs` 扫不到 .sh——改写成脚本名"
      + "（「`scripts/某个脚本.mjs` 这道门禁」）。⚠️ 改成写对的那个序号一样红：判据禁的是序号本身",
    ).toEqual([]);
  });

  /**
   * **上面那条判据是从 `scripts/check-comment-refs.mjs` 抄过来的第二份 —— 这一格
   * 是它们的逐字节孪生体比对。**
   * 那个脚本不导出任何东西（它是**直接跑**的门禁脚本，不是模块），import
   * 进来会把整道扫描连带跑一遍，所以只能抄。抄来的判据会漂：规则 E 收窄或放宽一次，
   * 上面那一格就在**不报错**的情况下开始验一件别的事。
   * ⇒ 拿真源的字面量当期望值。它红了不代表谁错了，代表「规则 E 动过，回来看一眼
   * 这里要不要跟着动」。
   */
  it("上面那条判据与 check-comment-refs.mjs 的规则 E 是同一条（逐字节孪生体比对）", () => {
    const refs = readFileSync("scripts/check-comment-refs.mjs", "utf8");
    const hint = "规则 E 的正则改过了 —— 回到 tests/unit/scan-secrets.test.ts"
      + " 把抄过来的那一份改成一样的，否则 .sh 那一半守的是另一件事";
    expect(refs, hint).toContain(`const GATE_ORDINAL_CORE = ${JSON.stringify(GATE_ORDINAL_CORE)};`);
    expect(refs, hint).toContain("`|CI\\\\s*的?\\\\s*${GATE_ORDINAL_CORE}`");
    expect(refs, hint).toContain('"|第\\\\s*\\\\d+\\\\s*/\\\\s*\\\\d+\\\\s*道"');
  });
});
