import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/check-no-binary.mjs");

/**
 * **评审 F3 新增的那道门禁**（`scripts/check-no-binary.mjs`）本身的正确性——
 * 不在真实仓库上做变异（那会真的往仓库里塞一个二进制文件），改用一个独立的临时
 * git 仓库：`execFileSync` 的 `cwd` 选项让被测脚本内部的 `git ls-files`/`git grep`
 * 全部落在这个临时仓库上，不碰真实仓库的索引。
 */
function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "a2a-no-binary-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  return dir;
}

function addAndTrack(dir: string, relPath: string, content: Buffer | string): void {
  const full = join(dir, relPath);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
  execFileSync("git", ["add", relPath], { cwd: dir });
}

function run(dir: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [SCRIPT], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("scripts/check-no-binary.mjs", () => {
  it("空仓库（没有任何跟踪文件）：通过", () => {
    const dir = initTempRepo();
    const result = run(dir);
    expect(result.status).toBe(0);
  });

  it("scope 目录（src/）下的正常文本文件：通过", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "src/a.ts", "export const x = 1;\n");
    const result = run(dir);
    expect(result.status).toBe(0);
  });

  it("scope 目录之外（例如根目录的 package.json）即使是二进制也不管——只查 scope 内", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "package.json", Buffer.from("x\x00y"));
    const result = run(dir);
    expect(result.status, "scope 之外的二进制文件不该让这道门禁失败").toBe(0);
  });

  it("scope 目录（src/）下带字面 NUL 字节的跟踪文件：exit 1，报出具体文件名", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "src/bad.ts", Buffer.from("const x = \"\x00bad\";\n"));
    const result = run(dir);
    expect(result.status, "带 NUL 字节的跟踪文件应该让这道门禁失败").toBe(1);
    expect(result.stderr).toContain("src/bad.ts");
  });

  it("空文件（0 字节）不被误判成二进制", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "src/empty.ts", "");
    const result = run(dir);
    expect(result.status, "空文件不是二进制，不该让这道门禁失败").toBe(0);
  });

  /**
   * **评审四审 B 组第 2 条：门禁第一版的两处误报，各钉一条。**
   *
   * 两条都不是假想的边角——第一版的判据是"`git grep -Il -E "."` 匹配不到 ⇒ 二进制"，
   * 而这两种文件 git 自己明明判成文本，只是 `git grep` 匹配不到它们：CI 会红，
   * 并给出"多半是混进了 NUL"这句错误诊断。
   */
  it("只含空行的跟踪文件不被误判成二进制（git 判它是 i/lf，但 `git grep -E \".\"` 匹配不到空行）", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "src/blank.ts", "\n\n\n");
    const result = run(dir);
    expect(result.status, `只含空行的文件是文本，不该让门禁失败：${result.stderr}`).toBe(0);
  });

  it("工作树里被删掉但仍在索引里的跟踪文件不被误判成二进制（`git grep` 搜的是工作树，文件已不在）", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "src/gone.ts", "export const x = 1;\n");
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: dir });
    rmSync(join(dir, "src/gone.ts")); // 只删工作树，不 stage 这次删除
    const result = run(dir);
    expect(result.status, `索引里仍是文本，不该因为工作树删除就报二进制：${result.stderr}`).toBe(0);
  });

  it("单行且不以换行结尾的文件（git 报 i/none，与空文件同一档）不被误判成二进制", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "src/nonl.ts", "export const x = 1;");
    const result = run(dir);
    expect(result.status, `没有行结束符不等于二进制：${result.stderr}`).toBe(0);
  });

  /**
   * **评审五审必修 1：`.gitattributes` 的 `-diff` 盲区。**
   *
   * 内容是不是文本、与 git 愿不愿意把它当文本 diff 是两件事。标了 `-diff` 的纯
   * 文本文件在 `git ls-files --eol` 里照样是 `i/lf`，但 `git diff` 只吐一行
   * `Binary files … differ`——**正是 F3 的原始症状**（评审包里看不见这份代码改了
   * 什么）。只查字节的门禁会放行它。
   */
  it("scope 内的纯文本文件被 .gitattributes 标了 -diff：exit 1，报出文件名与原因", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "src/hidden.ts", "export const x = 1;\n");
    addAndTrack(dir, ".gitattributes", "src/hidden.ts -diff\n");
    const result = run(dir);
    expect(result.status, "-diff 让文件在评审包 diff 里隐形，必须报出来").toBe(1);
    expect(result.stderr).toContain("src/hidden.ts");
    expect(result.stderr).toContain("-diff");
  });

  it("`linguist-generated=true` 这类不影响 diff 的属性不误报（本仓 .gitattributes 现状）", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "src/gen.ts", "export const x = 1;\n");
    addAndTrack(dir, ".gitattributes", "src/gen.ts linguist-generated=true\n");
    const result = run(dir);
    expect(result.status, `只有 -diff 才该被拦，别把所有属性都当问题：${result.stderr}`).toBe(0);
  });

  it("多个 scope 目录混合、一个二进制一个正常：仍然精确报出那一个", () => {
    const dir = initTempRepo();
    addAndTrack(dir, "src/ok.ts", "export const x = 1;\n");
    addAndTrack(dir, "tests/bad.test.ts", Buffer.from("\x00"));
    addAndTrack(dir, "docs/README.md", "# hello\n");
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tests/bad.test.ts");
    expect(result.stderr, "不该把正常文件也报成二进制").not.toContain("src/ok.ts");
    expect(result.stderr, "不该把正常文件也报成二进制").not.toContain("docs/README.md");
  });
});
