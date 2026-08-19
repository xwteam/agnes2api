import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep, relative, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * **测试收集门禁。放在 globalSetup 而不是某个 `*.test.ts` 里，这一点是本文件的全部意义。**
 *
 * 起因：`vitest.config.ts` 的 `include` 里去掉 `"tests/ui/**"`，整条前端纯函数测试
 * 通道就被关掉，而**没有任何一条用例变红**（实测总数从 710 静静掉到 705）。
 * 「测试还在、还绿、测的是空气」正是这个项目最怕的形态。
 *
 * 第一版把这条门禁写成了 `tests/unit/test-collection.test.ts`，并在文件头断言
 * 「收集门禁挡不住自己被取消收集，在 vitest 进程内无解」——**那句话是错的**，
 * 已被评审推翻并实测：`globalSetup` **先于且独立于测试文件的收集**运行，
 * 它抛异常直接让 `vitest run` 退出 1，跟 include 匹配到哪些文件毫无关系。
 * 于是删掉 `tests/unit/**` 这个变异现在也拦得住（本文件末尾的变异表有输出）。
 *
 * 教训记在这里：这个项目已经四次栽在「注释里的断言被后人信任」上，
 * 那句「进程内无解」当时还被写成给 Task 8 的指令，差点让它去绕远路。
 *
 * 反同义反复（与第一版相同的纪律）：
 * · 期望侧 = `readdirSync` 扫出来的磁盘真实文件清单，**与任何 vitest 配置无关**；
 * · 实际侧 = `vitest list` 自己报出来的收集结果，是 ground truth，
 *   **不在这里重新实现一遍 glob 匹配**（重实现的 matcher 判错时给出的是静默的错误答案）。
 * 两侧没有一侧是从另一侧推导出来的。
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TESTS_DIR = join(ROOT, "tests");

/** 递归子进程的保险丝。`vitest list` 实测**不**跑 globalSetup，所以正常永远不会命中； */
/** 万一将来某个版本改了这个行为，这里是「明确报错」而不是「静默无限递归挂住」。 */
const REENTRY = "AGNES_COLLECTION_GUARD_ACTIVE";

/**
 * vitest 的 CLI 入口。从它自己的 package.json 的 `bin` 字段解析，不写死路径：
 * `vitest/vitest.mjs` 不在 exports 映射里（实测 ERR_PACKAGE_PATH_NOT_EXPORTED），
 * 而 pnpm 的落盘路径带版本 hash，写死一升级就断。
 */
function vitestCli(): string {
  const pkgPath = createRequire(import.meta.url).resolve("vitest/package.json");
  const bin = JSON.parse(readFileSync(pkgPath, "utf8")).bin.vitest as string;
  return join(dirname(pkgPath), bin);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * 仓库根目录下的全部 vitest 配置，**从磁盘扫**而不是写死清单。
 * 写死的话，将来加第三份配置时「一个都不许漏」会静默地只要求被那两份覆盖——
 * 那正是本文件反对的那类漂移。
 */
function discoverConfigs(): string[] {
  return readdirSync(ROOT).filter((f) => /^vitest(\..+)?\.config\.ts$/.test(f)).sort();
}

/** 问 vitest 自己：这份配置会收集哪些文件。 */
function collectedBy(config: string): string[] {
  const out = execFileSync(
    process.execPath,
    [vitestCli(), "list", "--config", config, "--filesOnly"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, [REENTRY]: "1" } },
  );
  return out.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".test.ts"));
}

export default function setup(): void {
  if (process.env[REENTRY]) {
    throw new Error(
      "[collection-guard] 检测到递归：`vitest list` 这次跑了 globalSetup（以前不会）。"
      + "请改用不再触发 globalSetup 的方式取收集结果，别直接关掉这道门禁。",
    );
  }

  const onDisk = walk(TESTS_DIR)
    .filter((p) => p.endsWith(".test.ts"))
    .map((p) => relative(ROOT, p).split(sep).join("/"))
    .sort();

  if (onDisk.length < 40) {
    throw new Error(`[collection-guard] 只扫到 ${onDisk.length} 个测试文件，磁盘扫描本身可能坏了`);
  }

  const configs = discoverConfigs();
  if (configs.length === 0) throw new Error("[collection-guard] 一份 vitest 配置都没扫到");

  const collected = new Set(configs.flatMap(collectedBy));

  const missing = onDisk.filter((f) => !collected.has(f));
  if (missing.length > 0) {
    throw new Error(
      "[collection-guard] 这些测试文件躺在仓库里，但没有任何一份 vitest 配置会跑它们"
      + `（查了 ${configs.join("、")}）：\n  ${missing.join("\n  ")}\n`
      + "要么把它们纳入某份配置的 include，要么删掉——留着一份不会跑的测试比没有更糟。",
    );
  }

  const onDiskSet = new Set(onDisk);
  const ghosts = [...collected].filter((f) => !onDiskSet.has(f));
  if (ghosts.length > 0) {
    throw new Error(`[collection-guard] 收集结果里有磁盘上不存在的文件：\n  ${ghosts.join("\n  ")}`);
  }
}
