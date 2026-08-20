import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep, relative, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * @refs-ignore（下面提到的 `tests/unit/test-collection.test.ts` 是**已被取代**的第一版，故意留着讲教训）
 *
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

const NODE = "vitest.config.ts";
const WORKERS = "vitest.workers.config.ts";

/**
 * **哪个目录要求被哪几份配置收集——显式声明，不隐含在 glob 里。**
 *
 * ⚠️ 这张表是为了修掉一个**并集语义**的盲区。原先的判定是「这个文件被**某**份配置
 * 收集到就算过」，于是 `vitest.workers.config.ts` 的 include 被**收窄**（不是清空）
 * 对它完全不可见。已复现：把 workers 的 include 收窄成两个文件后——
 *
 *     node 侧   [collection-guard] ✅ 51 个测试文件 × 2 份配置，无漏收集   ← 假阳性
 *     workers   Test Files  2 passed (2)                                  ← 15 个契约测试静默消失
 *
 * **两个入口都是绿的，零红色信号**，而消失的正是 admin 的 CSP / nosniff / 资产伺服
 * 在 **workerd 侧**的覆盖——设计文档 §4.2 的整个立论（pool 会丢弃 `[assets]` 的
 * directory，所以必须双运行时验证）就靠那一份。
 *
 * 所以判定改成**逐配置**：`tests/contract/**` 的每个文件必须**同时**出现在两份配置
 * **各自的**收集结果里，出现在并集里不算过。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ⚠️ **这套机制只挡一半，另一半是有意留给代码评审的——写清楚，别以为是漏了。**
 *
 * 它校验的是「文件**在哪个目录** ⇒ 该被哪几份配置收集」，
 * **不校验目录归属本身是否合理**。把一个契约测试 `git mv` 进 `tests/unit/`，
 * 它就**合法地**只跑 node 侧，这里不会报错——已实测：把
 * `tests/contract/ui-serve.test.ts`（正是验证 admin 的 CSP/nosniff 在 workerd 侧
 * 覆盖的那个文件）挪进 `tests/unit/`，两个入口全绿，横幅照常打 ✅，
 * 只是双跑计数从 18 静默降到 17。
 *
 * **为什么只自动化了另一半**：两种改动的**可见性差一个量级**。
 * `git mv` 在任何 PR diff 里都是显眼的 rename；而 include 收窄是配置文件里
 * 一行不起眼的改动，正是评审最容易滑过去的形态。
 *
 * **为什么不加「双跑计数必须等于 N」的绊线**：P3b–P3d 要新增大量契约测试，
 * 每次都得改那个数字，久了就变成机械 bump，绊线自己先失效——成本是长期反复的，
 * 而收益已经被上面那条高可见度信号覆盖了。
 *
 * 同一类边界还有两处，是一脉相承的同一个取舍：
 * `tests/unit/ui-assets.test.ts` 的资产快照只锁键集合、不锁已有文件内容；
 * `.gitattributes` 特意不加 `-diff`，好让生成物的改动在评审里看得见。
 * ──────────────────────────────────────────────────────────────────────────
 */
const POLICY: ReadonlyArray<{ dir: string; configs: readonly string[]; why: string }> = [
  {
    dir: "tests/contract/",
    configs: [NODE, WORKERS],
    why: "契约测试要求**双运行时对等**：同一份断言在 node 与 workerd 下各跑一遍",
  },
  {
    dir: "tests/unit/",
    configs: [NODE],
    why: "单测要用 node:fs / child_process，workerd 里没有",
  },
  {
    dir: "tests/ui/",
    configs: [NODE],
    why: "前端纯函数，不碰任何运行时能力，跑两遍只是浪费",
  },
];

/** 问 vitest 自己：这份配置会收集哪些文件。 */
function collectedBy(config: string): string[] {
  const out = execFileSync(
    process.execPath,
    [vitestCli(), "list", "--config", config, "--filesOnly"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, [REENTRY]: "1" } },
  );
  return out.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".test.ts"));
}

/** globalSetup 拿到的第一个参数（`TestProject`）里我们唯一用得上的那一小块。 */
interface MaybeProject {
  vitest?: { filenamePattern?: unknown };
}

/**
 * @refs-ignore（`tests/xxx.test.ts` 与实测输出里那个文件名都是示例，不是真实指向）
 *
 * 本次调用带没带**显式的测试文件过滤器**（`vitest run tests/xxx.test.ts` 这种）。
 *
 * 取的是 vitest 自己解析好的 `filenamePattern`，**不是手搓 process.argv**：
 * 裸解析 argv 会把 `--config vitest.config.ts` 里那个 `vitest.config.ts` 当成位置参数，
 * 于是**每一次调用都被判成"带了过滤器"、门禁永久静默失效**——那比没有门禁更糟。
 * 已实测这个字段：带过滤器时是 `["tests/ui/mask.test.ts"]`，全量时是 `undefined`，
 * 且 `--config` / `--reporter=dot` 都不会被误算进去。
 *
 * **读不到就当作"没有过滤器"⇒ 照常跑门禁**（fail closed）。将来某个 vitest 版本
 * 改了这个字段名，代价是门禁多跑几次（慢），而不是门禁静默消失（不安全）。
 */
function fileFilters(project?: MaybeProject): readonly string[] | null {
  const v = project?.vitest;
  if (!v || typeof v !== "object") return null;
  const p = v.filenamePattern;
  if (!Array.isArray(p) || p.length === 0) return null;
  return p.every((x): x is string => typeof x === "string") ? p : null;
}

export default function setup(project?: MaybeProject): void {
  /*
   * 分档：带文件过滤器就跳过。
   *
   * 门禁要防的是「**有人改配置悄悄关掉一整条通道，而 CI 全绿**」。
   * 带过滤器是开发者的显式局部动作，威胁模型完全不同；而这道门禁要 spawn 两次
   * `vitest list`（约 5 秒），加在每一次单文件调试上是真摩擦——**摩擦会推着人去
   * 绕过它**，那就本末倒置了。
   *
   * ⚠️ **这条分档依赖一个前提：CI 跑的是全量、不带测试文件过滤器。**
   * 前提一旦破了（比如有人为了分片把 CI 命令改成按文件名过滤），这道门禁在 CI 上
   * 就完全不生效，而且**没有任何迹象**。Task 8 的必做项里有一条断言钉这个前提，
   * 改 CI 命令前先去看那一条。
   */
  const filters = fileFilters(project);
  if (filters) {
    console.log(
      `[collection-guard] 本次带了文件过滤器（${filters.join(" ")}），收集门禁已跳过；`
      + "全量 `pnpm test` 会跑它。门禁本身没有被关掉。",
    );
    return;
  }

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

  // 磁盘上的配置与 POLICY 引用的配置必须**双向一致**。加了一份新配置却没在 POLICY
  // 里表过态，它收集什么、该收集什么都没人管——那是下一个并集盲区的入口。
  const referenced = [...new Set(POLICY.flatMap((r) => r.configs))].sort();
  const unreferenced = configs.filter((c) => !referenced.includes(c));
  const dangling = referenced.filter((c) => !configs.includes(c));
  if (unreferenced.length > 0 || dangling.length > 0) {
    throw new Error(
      "[collection-guard] POLICY 与磁盘上的 vitest 配置对不上。\n"
      + (unreferenced.length ? `  磁盘上有但 POLICY 没提：${unreferenced.join("、")}\n` : "")
      + (dangling.length ? `  POLICY 提了但磁盘上没有：${dangling.join("、")}\n` : "")
      + "  新增配置必须在 POLICY 里声明它负责哪些目录。",
    );
  }

  /** 每份配置**各自**收集到什么。逐配置比对，不取并集。 */
  const byConfig = new Map(configs.map((c) => [c, new Set(collectedBy(c))]));

  const problems: string[] = [];
  for (const f of onDisk) {
    // 总函数：分不出归属就报错，逼新目录在 POLICY 里表态，不允许「这个不用管」的空格。
    const rule = POLICY.find((r) => f.startsWith(r.dir));
    if (!rule) {
      problems.push(`${f}：不在任何已声明的目录下，请在 POLICY 里说明它该被哪几份配置收集`);
      continue;
    }
    for (const cfg of rule.configs) {
      if (!byConfig.get(cfg)?.has(f)) {
        problems.push(`${f}：应当被 ${cfg} 收集，实际没有（${rule.why}）`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      "[collection-guard] 测试文件的收集范围与声明不符：\n  "
      + problems.join("\n  ")
      + "\n要么修好 include，要么改 POLICY 并在评审里说明——留着一份不会跑的测试比没有更糟。",
    );
  }

  const onDiskSet = new Set(onDisk);
  for (const [cfg, files] of byConfig) {
    const ghosts = [...files].filter((f) => !onDiskSet.has(f));
    if (ghosts.length > 0) {
      throw new Error(`[collection-guard] ${cfg} 收集到了磁盘上不存在的文件：\n  ${ghosts.join("\n  ")}`);
    }
  }

  /*
   * 成功也打一行。**这行不是噪音，是给 CI 的抓手**：
   * 门禁失效的形态是「静默跳过」——比如有人把上面的过滤器检测改成裸解析
   * process.argv，于是每次调用都被判成带过滤器，门禁再也不跑而 CI 全绿。
   * 那种情况下这行**不会出现**，Task 8 的 CI 断言 grep 它即可发现。
   */
  const dual = onDisk.filter((f) => (POLICY.find((r) => f.startsWith(r.dir))?.configs.length ?? 0) > 1);
  console.log(
    `[collection-guard] ✅ ${onDisk.length} 个测试文件 × ${configs.length} 份配置逐一核对，`
    + `其中 ${dual.length} 个要求双运行时`,
  );
}
