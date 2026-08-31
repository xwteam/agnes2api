import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, readFileSync, existsSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/pretag.sh");
const CI_FILE = resolve(".github/workflows/ci.yml");

/**
 * **打 tag 前那道门禁（`scripts/pretag.sh`）自身的正确性。**
 *
 * 这个文件存在的直接理由（复评发现）：本仓的**首个版本就是从一棵红树上发出去的**。
 * `v0.1.0` 落在 `a636dc1`，而 GitHub 记着那个提交的 `lint-and-test` 是 **failure**
 *（`.github/workflows/ci.yml` 里 pnpm 版本给了两处 ⇒ `Multiple versions of pnpm specified`，
 * 那十三步一步没跑；修完 pnpm 之后又露出 `tests/ui/dom` 在 `node-version: 22` 上 119 格红），
 * 与此同时 `origin/main` 已经比那个 tag 多了两个提交。
 * 而 `.github/workflows/docker-publish.yml` 只有 checkout + buildx + push，**一道测试都不跑**
 * ⇒ `ghcr.io` 上那三个公开标签照发不误。「发版 = 一棵能过自己 CI 的树」这条
 * **在流水线里原本没有任何一处把关**，`scripts/pretag.sh` 就是补上的那一处。
 *
 * 测法与 `tests/unit/scan-secrets.test.ts` 同轨：**把脚本复制到一个临时目录里跑**。
 * 脚本开头是 `cd "$(dirname "$0")/.."`，所以它会 cd 到那个临时目录——由我们决定那里的
 * git 仓库长什么样、远端有什么、`gh` 回什么。真实仓库与真实 GitHub 全程不被碰。
 *
 * ⚠️ **`gh` 用 PATH 上的一个夹具顶替**，因为这道门禁问的是「GitHub 那边记着什么」，
 * 那是一个网络事实：真跑一次既要网、又要一个恰好红着的提交，两样在测试里都不该有。
 * 夹具做的只有一件事：**原样吐回一段 check-runs 响应**（或者失败），响应长什么样由每一格自己给。
 */

/** `.github/workflows/ci.yml` 里的 job 名单——脚本认的就是这一份，夹具跟着它走。 */
const CI_JOBS = (): string[] => {
  const src = readFileSync(CI_FILE, "utf8");
  const out: string[] = [];
  let inJobs = false;
  for (const line of src.split("\n")) {
    if (/^jobs:/.test(line)) { inJobs = true; continue; }
    if (inJobs && /^\S/.test(line)) { inJobs = false; continue; }
    const m = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
    if (m) out.push(m[1]!);
  }
  return out;
};

type Run = { name: string; status?: string; conclusion?: string | null; started_at?: string };

/** 一段 `GET /repos/…/check-runs` 的响应。缺省是「跑完了、绿的」。 */
const checkRuns = (runs: readonly Run[]): string => JSON.stringify({
  total_count: runs.length,
  check_runs: runs.map((r) => ({
    status: "completed", conclusion: "success", started_at: "2026-08-31T00:00:00Z", ...r,
  })),
});

/** ci.yml 里每个 job 各一条绿记录——「本该放行」的那份响应。 */
const allGreen = (): string => checkRuns(CI_JOBS().map((name) => ({ name })));

/** 夹具仓库登记的远端地址：形态与真仓那条一致，⑥ 从它认 `<owner>/<repo>`。 */
const ORIGIN_URL = "https://github.com/xwteam/agnes2api.git";

type Repo = { root: string; origin: string; bin: string };

/**
 * 一个能过全部六格的仓库：脚本 + 真 ci.yml + VERSION + CHANGELOG，
 * main 上一个提交，推给一个本地裸仓当 `origin`，外加一个假 `gh`。
 * ⚠️ ci.yml 是**从真仓复制**的，不是现编的：job 名单换了名字，这里跟着换。
 */
function makeRepo(): Repo {
  const root = mkdtempSync(join(tmpdir(), "a2a-pretag-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "scripts", "pretag.sh"));
  chmodSync(join(root, "scripts", "pretag.sh"), 0o755);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  copyFileSync(CI_FILE, join(root, ".github", "workflows", "ci.yml"));
  writeFileSync(join(root, "VERSION"), "1.2.3\n");
  writeFileSync(join(root, "CHANGELOG.md"), "# 更新日志\n\n## [1.2.3] - 2026-08-31\n\n### Added\n\n- 一条条目\n");

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", "初始"], { cwd: root });

  // ⚠️ 远端**登记的是一个 GitHub 地址**（⑥ 要从它认出 `<owner>/<repo>`），而**传输落到本地**
  // 那个裸仓：靠 `url.<本地路径>.insteadOf <那个 GitHub 地址>` 改写。
  // 于是 fetch / ls-remote / push 全程不出机器，而脚本读到的 slug 与真仓一模一样。
  // 这也正是脚本读 `git config --get remote.origin.url`（不展开改写）而不是
  // `git remote get-url`（展开改写）的原因——两者在这里给的是两个不同的答案。
  const origin = mkdtempSync(join(tmpdir(), "a2a-pretag-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["config", `url.${origin}.insteadOf`, ORIGIN_URL], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", ORIGIN_URL], { cwd: root });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: root });

  // 假 `gh`：`FAKE_GH_FAIL=1` 时模拟请求失败（gh 的报错走 stderr 且退出非零），
  // 否则把 `FAKE_GH_BODY` 原样吐出来。**它不认识 `--jq`**——脚本也不用，
  // 脚本自己拿 node 解 JSON，所以夹具与真 gh 在这一点上是同形的。
  // ⚠️ 假 `gh` 放在**仓库外面**：放进 `root` 里的话它是一个未跟踪文件，① 那一格会
  // 当场报「工作树不干净」，于是每一格都顺带红一次——夹具自己把被测对象弄红了。
  const bin = mkdtempSync(join(tmpdir(), "a2a-pretag-bin-"));
  const gh = join(bin, "gh");
  writeFileSync(gh, [
    "#!/usr/bin/env bash",
    'if [ "${FAKE_GH_FAIL:-0}" = "1" ]; then',
    '  echo "gh: Not Found (HTTP 404)" >&2',
    "  exit 1",
    "fi",
    'printf %s "${FAKE_GH_BODY:-}"',
    "",
  ].join("\n"));
  chmodSync(gh, 0o755);
  return { root, origin, bin };
}

type RunResult = { status: number; out: string };

function run(repo: Repo, args: string[] = [], env: Record<string, string> = {}): RunResult {
  const r = spawnSync("bash", [join(repo.root, "scripts", "pretag.sh"), ...args], {
    encoding: "utf8",
    cwd: repo.root,
    env: {
      ...process.env,
      PATH: `${repo.bin}:${process.env.PATH ?? ""}`,
      FAKE_GH_BODY: allGreen(),
      ...env,
    },
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** 在 main 上再压一个提交（不推），用来做「HEAD 跑到远端前面去了」这一档。 */
function commitMore(repo: Repo): void {
  writeFileSync(join(repo.root, "NOTE.md"), "又改了一点\n");
  execFileSync("git", ["add", "-A"], { cwd: repo.root });
  execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", "又一笔"], { cwd: repo.root });
}

describe("打 tag 前的门禁：tag 只许落在「远端 main 那个提交」且「GitHub 记着它是绿的」（复评发现）", () => {
  it("非空锚：ci.yml 里真的抽得出 job 名单 —— 抽不出的话下面每一格测的都是空气", () => {
    const jobs = CI_JOBS();
    expect(jobs.length, ".github/workflows/ci.yml 里一个 job 都认不出").toBeGreaterThan(0);
    expect(jobs, "CI 的 job 名单变了 —— 门禁认的是这一份，回本文件顶上那段读一遍")
      .toEqual(["lint-and-test"]);
  });

  it("六格全过：干净的 main、HEAD 就是远端 main、远端还没这个 tag、CI 记着全绿 ⇒ 退出 0", () => {
    const repo = makeRepo();
    const r = run(repo);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("六格全过");
    expect(r.out).toContain("lint-and-test：completed/success");
  });

  it("该红时红：GitHub 记着 lint-and-test 是 failure ⇒ 拒打，并把那个结论原样打出来", () => {
    const repo = makeRepo();
    const r = run(repo, [], {
      FAKE_GH_BODY: checkRuns([{ name: "lint-and-test", conclusion: "failure" }]),
    });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("completed/failure");
    expect(r.out).toContain("这棵树的 CI 不是绿的");
    expect(r.out).toContain("不该打 tag");
  });

  it("该红时红：这个 sha 上根本没跑过 lint-and-test，只有发镜像那个 job 绿着 ⇒ 拒打", () => {
    // ⚠️ 这**正是 v0.1.0 当时的形态**：`build-and-push success` / `lint-and-test failure`。
    // 这一格钉的是更坏的一种：那个 job 一条记录都没有——「没有坏消息」不是「好消息」。
    const repo = makeRepo();
    const r = run(repo, [], { FAKE_GH_BODY: checkRuns([{ name: "build-and-push" }]) });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("一次都没跑过这个 job");
    expect(r.out).toContain("lint-and-test");
  });

  it("该红时红：那个 job 还在跑（conclusion 还是 null）⇒ 拒打，不许把「还没结论」当成绿", () => {
    const repo = makeRepo();
    const r = run(repo, [], {
      FAKE_GH_BODY: checkRuns([{ name: "lint-and-test", status: "in_progress", conclusion: null }]),
    });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("in_progress/null");
  });

  it("该红时红：同一个 job 重跑过 —— 取 started_at 最新的那一条，不许拿旧的那条绿记录放行", () => {
    const repo = makeRepo();
    const r = run(repo, [], {
      FAKE_GH_BODY: checkRuns([
        { name: "lint-and-test", conclusion: "success", started_at: "2026-08-30T00:00:00Z" },
        { name: "lint-and-test", conclusion: "failure", started_at: "2026-08-31T00:00:00Z" },
      ]),
    });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("completed/failure");
  });

  it("认不出要吵：gh 请求失败 ⇒ 拒打（把 gh 的报错原样带出来），不是「查不到就算绿」", () => {
    const repo = makeRepo();
    const r = run(repo, [], { FAKE_GH_FAIL: "1" });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("check-runs 失败");
    expect(r.out).toContain("HTTP 404");
  });

  it("认不出要吵：响应根本不是 JSON ⇒ 拒打并说解析不出", () => {
    const repo = makeRepo();
    const r = run(repo, [], { FAKE_GH_BODY: "<html>登录页</html>" });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("解析不出 JSON");
  });

  it("认不出要吵：这台机器上没有 gh ⇒ 拒打，不许因为「查不了」就放行", () => {
    const repo = makeRepo();
    // ⚠️ PATH 必须**恰好**是「脚本要用的那几个命令，但没有 gh」。
    // 第一版写成 `PATH=<空目录>:/usr/bin:/bin`，于是本机真的那个 `/usr/bin/gh` 被找到，
    // 这一格**真去打了一次 GitHub**（回 422：那个夹具 sha 在真仓里不存在）。
    // 测试不许联网，也不许把「本机装没装 gh」这种事变成用例的前提。
    const only = mkdtempSync(join(tmpdir(), "a2a-pretag-nogh-"));
    for (const name of ["git", "awk", "sed", "grep", "tr", "cat", "bash", "dirname"]) {
      const src = ["/usr/bin", "/bin"].map((d) => join(d, name)).find((p) => existsSync(p));
      expect(src, `本机找不到 ${name}，这一格的前提没了`).toBeDefined();
      symlinkSync(src!, join(only, name));
    }
    symlinkSync(process.execPath, join(only, "node"));
    const probe = spawnSync("bash", ["-c", "command -v gh"], { encoding: "utf8", env: { PATH: only } });
    expect(`${probe.stdout}`.trim(), "夹具没落地——这个 PATH 上仍然找得到 gh").toBe("");

    const r = spawnSync("bash", [join(repo.root, "scripts", "pretag.sh")], {
      encoding: "utf8",
      cwd: repo.root,
      env: { PATH: only, HOME: process.env.HOME ?? "", FAKE_GH_BODY: allGreen() },
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(1);
    expect(out).toContain("gh 不在这台机器上");
    // 红的只有 ⑥ 那一格：前五格照旧过，证明这一格红在「查不了」而不是「PATH 被砍秃了」。
    expect(out, "④ 都没过 —— 那这一格红在别的地方").toContain("✅ HEAD == origin/main");
  });

  it("该红时红：job 名单是从 ci.yml 现算的 —— 把 job 改个名而 GitHub 那边还是老名字 ⇒ 拒打", () => {
    // 这一格钉的是「名单不是手抄在脚本里的常量」：手抄的话改了 ci.yml 这里会照绿。
    const repo = makeRepo();
    const at = join(repo.root, ".github", "workflows", "ci.yml");
    const before = readFileSync(at, "utf8");
    const after = before.replace(/^ {2}lint-and-test:$/m, "  lint-and-test-v2:");
    expect(after, "变异没落地——ci.yml 里没找到那个 job").not.toEqual(before);
    writeFileSync(at, after);
    execFileSync("git", ["add", "-A"], { cwd: repo.root });
    execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", "改名"], { cwd: repo.root });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo.root });
    const r = run(repo);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("lint-and-test-v2");
    expect(r.out).toContain("一次都没跑过这个 job");
  });

  it("该红时红：HEAD 跑到远端 main 前面去了 ⇒ 拒打，并把两个 sha 都打出来", () => {
    // v0.1.0 当时是**落后**两个提交，这里测的是同一条判据的另一侧：两个方向都不许。
    const repo = makeRepo();
    commitMore(repo);
    const r = run(repo);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("这两个必须是同一个提交");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.root, encoding: "utf8" }).trim();
    const remote = execFileSync("git", ["rev-parse", "origin/main"], { cwd: repo.root, encoding: "utf8" }).trim();
    expect(r.out).toContain(head);
    expect(r.out).toContain(remote);
    expect(head, "变异没落地——HEAD 和远端 main 还是同一个").not.toEqual(remote);
  });

  it("该红时红：工作树不干净 ⇒ 拒打，并逐行列出没提交的东西", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.root, "DIRTY.md"), "手上多出来的东西\n");
    const r = run(repo);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("工作树不干净");
    expect(r.out).toContain("DIRTY.md");
  });

  it("该红时红：不在 main 上 ⇒ 拒打", () => {
    const repo = makeRepo();
    execFileSync("git", ["checkout", "-q", "-b", "feat/x"], { cwd: repo.root });
    const r = run(repo);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("本仓只在 main 上发版");
  });

  it("该红时红：CHANGELOG 里没有这个版本的条目 ⇒ 拒打（VERSION 改了而日志没跟）", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.root, "VERSION"), "9.9.9\n");
    execFileSync("git", ["add", "-A"], { cwd: repo.root });
    execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", "改版本"], { cwd: repo.root });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo.root });
    const r = run(repo);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("[9.9.9]");
    expect(r.out).toContain("这个版本没有条目");
  });

  it("该红时红 / 该放时放：远端已经有这个 tag ⇒ 默认拒打，`--allow-retag` 才放行", () => {
    const repo = makeRepo();
    execFileSync("git", ["tag", "v1.2.3"], { cwd: repo.root });
    execFileSync("git", ["push", "-q", "origin", "v1.2.3"], { cwd: repo.root });
    const blocked = run(repo);
    expect(blocked.status, blocked.out).toBe(1);
    expect(blocked.out).toContain("要重打就显式加 --allow-retag");

    const allowed = run(repo, ["--allow-retag"]);
    expect(allowed.status, allowed.out).toBe(0);
    expect(allowed.out).toContain("这是一次重打");
    // ⚠️ `--allow-retag` 放松的**只有 ⑤ 那一格**：CI 那一格照旧一票否决。
    const stillRed = run(repo, ["--allow-retag"], {
      FAKE_GH_BODY: checkRuns([{ name: "lint-and-test", conclusion: "failure" }]),
    });
    expect(stillRed.status, stillRed.out).toBe(1);
    expect(stillRed.out).toContain("这棵树的 CI 不是绿的");
  });

  it("不认得的参数当场退出 2，不许当成「没给参数」照跑", () => {
    const repo = makeRepo();
    const r = run(repo, ["--force"]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("不认得的参数");
  });
});
