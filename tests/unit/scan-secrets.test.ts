import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/scan-secrets.sh");

/**
 * **凭据扫描门禁（CI 第 2/11 道）自身的正确性。**
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
function stageScript(makeRepo: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "a2a-scan-secrets-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  const dest = join(root, "scripts", "scan-secrets.sh");
  copyFileSync(SCRIPT, dest);
  chmodSync(dest, 0o755);
  if (makeRepo) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  }
  return root;
}

function run(root: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [join(root, "scripts", "scan-secrets.sh")], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

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
