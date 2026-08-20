import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/check-no-binary.mjs");

/**
 * **评审 F3 新增的第 11 道门禁**（`scripts/check-no-binary.mjs`）本身的正确性——
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
