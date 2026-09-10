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
 * @refs-ignore（本段提到的 `tests/unit/test-collection.test.ts` 是**已被取代**的第一版，故意留着讲教训）
 * 第一版把这条门禁写成了 `tests/unit/test-collection.test.ts`，并在文件头断言
 * 「收集门禁挡不住自己被取消收集，在 vitest 进程内无解」——**那句话是错的**，
 * 已被评审推翻并实测：`globalSetup` **先于且独立于测试文件的收集**运行，
 * 它抛异常直接让 `vitest run` 退出 1，跟 include 匹配到哪些文件毫无关系。
 * 于是删掉 `tests/unit/**` 这个变异现在也拦得住（本文件末尾的变异表有输出）。
 *
 * 教训记在这里：这个项目已经四次栽在「注释里的断言被后人信任」上，
 * 那句「进程内无解」当时还被写成一条给后续任务的指令，差点让它去绕远路。
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

/**
 * **哪个目录要求被哪几份配置收集——显式声明，不隐含在 glob 里。**
 *
 * ⚠️⚠️ **这张表在 v0.4.0 从「逐配置」缩成了「只有一份配置」，而它的结构一格没动。**
 * 从前磁盘上有两份配置（`vitest.config.ts` 与当时那份 workers 专用配置），
 * `tests/contract/**` 要求**同时**出现在两份**各自的**收集结果里。那条要求是为了修
 * 一个**并集语义**的盲区：原先的判定是「被**某**份配置收集到就算过」，于是 workers
 * 那份的 include 被**收窄**（不是清空）对它完全不可见。已复现过——
 *
 *     node 侧   [collection-guard] ✅ 51 个测试文件 × 2 份配置，无漏收集   ← 假阳性
 *     workers   Test Files  2 passed (2)                                  ← 15 个契约测试静默消失
 *
 * **两个入口都是绿的，零红色信号。**
 *
 * ⚠️ **摘掉 Worker 形态之后那份 workers 专用配置删了，只剩一份配置**，
 * 于是「并集 vs 逐配置」这个区别在今天**没有可观测差异**。
 * **判定逻辑仍然写成逐配置（下面 `byConfig` 那一段），这是刻意的**：
 * 它是这道门禁唯一见过的真实失效形态，而恢复成逐配置的成本是一次重写；
 * 何况 `discoverConfigs()` 是从磁盘扫的——**哪天真加回第二份配置，这里立刻就管用**，
 * 不需要有人记得回来改。
 *
 * ⇒ 今天这张表还在干的活只剩一件：**每个测试目录都必须在这里表过态**
 *（`POLICY.find` 找不到就报错），新开一个 `tests/xxx/` 目录而没在 include 里加它
 * 会当场红。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ⚠️ **这套机制只挡一半，另一半是有意留给代码评审的——写清楚，别以为是漏了。**
 *
 * 它校验的是「文件**在哪个目录** ⇒ 该被哪几份配置收集」，
 * **不校验目录归属本身是否合理**。把一个契约测试 `git mv` 进 `tests/unit/`，
 * 在只剩一份配置的今天它**连一格差别都没有**（两个目录同一份 include）。
 *
 * 同一类边界还有两处，是一脉相承的同一个取舍：
 * `tests/unit/ui-assets.test.ts` 的「资产清单与显式快照一致——admin-ui/ 里多一个文件
 * 就是多一个公网端点」只锁键集合、不锁已有文件内容；
 * `.gitattributes` 特意不加 `-diff`，好让生成物的改动在评审里看得见。
 * ──────────────────────────────────────────────────────────────────────────
 */
const POLICY: ReadonlyArray<{ dir: string; configs: readonly string[]; why: string }> = [
  {
    dir: "tests/contract/",
    configs: [NODE],
    why: "契约测试：整条 app 起来的端到端断言",
  },
  {
    dir: "tests/unit/",
    configs: [NODE],
    why: "单测要用 node:fs / child_process",
  },
  {
    dir: "tests/ui/",
    configs: [NODE],
    why: "前端纯函数，不碰任何运行时能力",
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
 * @refs-ignore（本段的 `tests/xxx.test.ts` 是示例，不是真实指向）
 * 本次调用带没带**显式的测试文件过滤器**（`vitest run tests/xxx.test.ts` 这种）。
 *
 * 取的是 vitest 自己解析好的 `filenamePattern`，**不是手搓 process.argv**：
 * 裸解析 argv 会把 `--config vitest.config.ts` 里那个 `vitest.config.ts` 当成位置参数，
 * 于是**每一次调用都被判成"带了过滤器"、门禁永久静默失效**——那比没有门禁更糟。
 * @refs-ignore（本段实测输出里那个文件名同样是示例）
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
   * 带过滤器是开发者的显式局部动作，威胁模型完全不同；而这道门禁每份配置都要
   * spawn 一次 `vitest list`（今天一份，几秒），加在每一次单文件调试上是真摩擦
   * ——**摩擦会推着人去绕过它**，那就本末倒置了。
   *
   * ⚠️ **这条分档依赖一个前提：CI 跑的是全量、不带测试文件过滤器。**
   * 前提一旦破了（比如有人为了分片把 CI 命令改成按文件名过滤），这道门禁在 CI 上
   * 就完全不生效，而且**没有任何迹象**。本仓另有一条断言钉这个前提，
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
   * 那种情况下这行**不会出现**，CI 那条断言 grep 它即可发现。
   *
   * ⚠️ **横幅尾巴上原来还有一句「其中 N 个要求双运行时」，v0.4.0 删了**：
   * 只剩一份配置之后那个 N 恒为 0，一句恒为 0 的统计比不说更糟。
   * 报文形状（前半句）刻意没动——`scripts/prepush.sh` grep 的是它。
   */
  console.log(
    `[collection-guard] ✅ ${onDisk.length} 个测试文件 × ${configs.length} 份配置逐一核对`,
  );
}
