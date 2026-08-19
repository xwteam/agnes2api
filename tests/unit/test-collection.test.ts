import { describe, it, expect } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep, relative, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * **测试通道自身的门禁。**
 *
 * 起因：`vitest.config.ts` 的 `include` 里去掉 `"tests/ui/**"` 这一行，整条前端纯函数
 * 测试通道就被关掉了，而**没有任何一条用例变红**——实测总数从 710 静静掉到 705。
 * 「测试还在、还绿、测的是空气」正是这个项目最怕的形态，靠约定和转交清单挡不住
 *（P2 有过一条待办在三个任务之间转交、全程没落地也没人再提起的前科）。
 *
 * 因此这条断言放**仓内**，`pnpm test` 就能发现；CI 层的门禁另算，两层不冲突。
 *
 * 反同义反复：
 * · 期望侧 = `readdirSync` 扫出来的磁盘真实文件清单，**与任何 vitest 配置无关**；
 * · 实际侧 = `vitest list` 自己报出来的收集结果，是 ground truth，
 *   **不在这里重新实现一遍 glob 匹配**（重实现的 matcher 判错时会给出静默的错误答案）。
 * 两侧没有一侧是从另一侧推导出来的。
 *
 * ⚠️ **这条守不住的一格，写在这里而不是转交清单里**（转交清单会被静默丢掉，
 * P2 有前科）：**收集门禁挡不住自己被取消收集**。已实测——把 `tests/unit/**`
 * 从 `vitest.config.ts` 的 include 里删掉，本文件自己就不再被收集，于是
 * 500 多条单测连同这条门禁一起消失，**没有任何一条变红**（`pnpm test` 只是
 * 从 718 条静静掉到 250 条上下）。这是自指的死结，在 vitest 进程内无解。
 *
 * ⇒ **Task 8 的 CI 必须补上第二层，且要在 vitest 进程之外做**：把磁盘上
 * `tests/**\/*.test.ts` 的文件清单，与 CI 里实际跑过的文件清单直接比对。
 * 本文件保证「本地跑测试就能发现漏收集」，那一层保证「有人把整个目录摘掉
 * 也拦得住」。两层缺一不可，别因为有了本文件就以为够了。
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TESTS_DIR = join(ROOT, "tests");
/**
 * vitest 的 CLI 入口。**从它自己的 package.json 的 `bin` 字段解析**，不写死路径：
 * `vitest/vitest.mjs` 不在 exports 映射里（已实测报 ERR_PACKAGE_PATH_NOT_EXPORTED），
 * 而 pnpm 的实际落盘路径带版本 hash，写死一升级就断。
 */
const VITEST_CLI = (() => {
  const pkgPath = createRequire(import.meta.url).resolve("vitest/package.json");
  const bin = JSON.parse(readFileSync(pkgPath, "utf8")).bin.vitest as string;
  return join(dirname(pkgPath), bin);
})();

const CONFIGS = ["vitest.config.ts", "vitest.workers.config.ts"] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** 问 vitest 自己：这份配置会收集哪些文件。同一次运行内配置不会变，缓存掉重复的 spawn。 */
const cache = new Map<string, string[]>();
function collectedBy(config: string): string[] {
  const hit = cache.get(config);
  if (hit) return hit;
  const out = execFileSync(
    process.execPath,
    [VITEST_CLI, "list", "--config", config, "--filesOnly"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const files = out.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".test.ts"));
  cache.set(config, files);
  return files;
}

/** 磁盘上真实存在的测试文件（posix 分隔符，与 vitest 的输出对齐）。 */
const ON_DISK = walk(TESTS_DIR)
  .filter((p) => p.endsWith(".test.ts"))
  .map((p) => relative(ROOT, p).split(sep).join("/"))
  .sort();

describe("测试收集范围", () => {
  it("磁盘上有测试文件可扫（否则下面几条全是空断言）", () => {
    expect(ON_DISK.length).toBeGreaterThan(40);
  });

  /**
   * 这一条是具体的、点名的：`tests/ui/mask.test.ts` 必须真的在 node 侧的收集结果里。
   * 断言的是「这个文件在收集结果里」，不是「配置里写的目录都存在」——后者会随配置
   * 一起变，把 include 删干净也照样绿。
   */
  it("tests/ui/mask.test.ts 被 vitest.config.ts 收集——前端纯函数通道不许被一行配置静默关掉", () => {
    expect(collectedBy("vitest.config.ts")).toContain("tests/ui/mask.test.ts");
  });

  it("tests/ 下每个 *.test.ts 都至少被一份配置收集，一个都不许漏", () => {
    const collected = new Set(CONFIGS.flatMap(collectedBy));
    const missing = ON_DISK.filter((f) => !collected.has(f));
    expect(
      missing,
      `这些测试文件躺在仓库里但没有任何一份 vitest 配置会跑它们：\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("收集结果里没有磁盘上不存在的文件（配置指向了错的路径同样要暴露）", () => {
    const onDisk = new Set(ON_DISK);
    const ghosts = [...new Set(CONFIGS.flatMap(collectedBy))].filter((f) => !onDisk.has(f));
    expect(ghosts).toEqual([]);
  });
});
