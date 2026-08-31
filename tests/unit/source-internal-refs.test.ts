/**
 * **跟踪文件里不许留内部研发轨迹的标识符**（阶段编号 / 内部任务号 / 内部评审发现号）。
 * 这是**源码轴**；文档轴是 `tests/unit/docs-internal-refs.test.ts`「44 份公开 markdown
 * 里一个内部标识符都没有（阶段编号 / 任务号 / 评审发现号）」那一格，两根轴各是各的。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────────
 * 文档轴那份判据的射程按定义只有 44 份公开 markdown；`scripts/prepush.sh` 的 ⑧ 只看
 * 未推送提交的提交信息。**跟踪文件本身，一格都没有人盯着。**
 * 而公开仓的读者点得开的恰恰是这些文件：源码、测试、脚本、面板源码。
 *
 * 落地前的一轮清理把这一批从 1069 处清到了 120 处（第二批字母那一族的口径），
 * 残留逐条复核过、全是同形真词。**但那次清理从头到尾没有任何判据在盯**——
 * 它是一次人工动作，而人工动作的保质期是零：明天有人往某个注释里写一个本族编号，
 * 今天的仓库里没有任何东西会红。本文件补的就是那一格。
 *
 * 🔴 **刻意新开一份文件，不塞进文档轴那份 6000 行的判据里。**
 * 立法理由与 `scripts/check-i18n.mjs` 那一条逐字相同：合成一步之后，这一轴的红会被
 * 另一轴的红盖住——文档轴任何一格红了，跑的人只会去看 markdown，
 * 而源码轴那条真正的新回归就静静混在同一份报文里。**两轴两份文件，各红各的。**
 *
 * ── 射程：`git ls-files` 的全部跟踪文件，减三类 ──────────────────────────────
 * ① **含 NUL 字节的文件**（今天恰好只有 `docs/logo.png` 一份）。
 *    判别方式是**读字节找 NUL**，不是抄一张后缀名表——抄的那张表会漂，
 *    而漂了没人会发现（本仓已经栽过一次「射程靠手抄」）。
 *    二进制里凑巧凑出本族形状的字节序列不是泄漏，那里没有读者读得懂的句子。
 * ② `pnpm-lock.yaml`：`sha512-` 后面那串 base64 与本族同形（今天 4 处），
 *    而它是包管理器写的、一个字都不是人写的。
 * ③ `src/ui/assets.generated.ts`：**生成物**，真源在 `admin-ui/` 下，而 `admin-ui/`
 *    整个在射程里。改那边就够了；手改这一份会被 CI 里「生成面板资源 + 生成物一致性」
 *    那一对当场逮住（前一道重新生成、后一道 `git diff --exit-code` 跟着红）。
 *
 * ⚠️ **只列跟踪文件，不列未跟踪的，这一点与文档轴刻意相反。** 文档轴要抓的是
 * 「新建一个目录、往里放一份还没 `git add` 的 markdown」，所以它必须带
 * `--others --exclude-standard`。本轴不需要：一个未跟踪的文件推不上去、读者读不到，
 * 而**推送前它必须已经进树**——`scripts/prepush.sh` 的 ① 那一格盯的就是工作树干净。
 * 把未跟踪文件收进来的唯一效果，是让本地随手放的探针脚本把这份判据弄红。
 *
 * ── 它验不了什么（明写，别读成「内部轨迹从此不会泄漏」）────────────────────
 * 与文档轴同一条：它认的是**标识符的形状**，不是「这句话是不是在讲内部排期」。
 * 不带任何编号的路线图陈述、内部人名、内部工具名，本文件一格都不管。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * 仓里全部跟踪文件，从 `git` 现列。
 *
 * ⚠️ 空集不许静默通过：`git` 一份都没列出来时是**扫描坏了**，
 * 而一个恒等于空集的射程会让下面每一格都变成「零命中」，报文还长得像真的。⇒ 直接抛。
 */
function trackedFiles(): readonly string[] {
  const raw = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  const files = raw.split("\0").filter(Boolean);
  if (files.length === 0) {
    throw new Error("`git ls-files` 一份文件都没列出来 —— 扫描坏了，不许静默当成空集");
  }
  return files.sort();
}

/** 含 NUL 字节 ⇒ 二进制。**读字节判定，不抄后缀名表。** */
function isBinary(path: string): boolean {
  return readFileSync(path).includes(0);
}

/**
 * 射程里刻意排掉的**非二进制**文件，逐条写清理由与失效条件。
 * ⚠️ 这两条不是豁免（豁免见下面 `EXEMPTIONS`）：它们排的是**根本不该进射程的东西**，
 * 而豁免排的是「进了射程、今天确实有命中、但那些命中正当」的东西。
 */
const EXCLUSIONS: ReadonlyArray<{
  readonly path: string;
  readonly why: string;
  readonly until: string;
}> = [
  {
    path: "pnpm-lock.yaml",
    why: "包管理器写的完整性哈希：`sha512-` 后面那串 base64 与本族同形（今天 4 处），"
      + "没有一个字是人写的，也没有一句读者读得懂的话",
    until: "哪天锁文件不再内嵌 base64 哈希（或换了包管理器）—— 那时这条排除要重新实测",
  },
  {
    path: "src/ui/assets.generated.ts",
    why: "生成物。真源是 `admin-ui/` 下那几份，而它们整个在射程里 ⇒ 改真源就够了；"
      + "手改这一份会被 CI 里「生成面板资源 + 生成物一致性」那一对当场逮住",
    until: "哪天这份文件不再由 `scripts/build-ui.mjs` 生成，或那一对门禁被撤 —— "
      + "那时它就成了一份没人盯的手写文件，必须收回射程",
  },
];

/** 今天射程里那批文件。**从 `git` 现算**，不手抄。 */
const SCOPE: readonly string[] = trackedFiles()
  .filter((p) => !isBinary(p))
  .filter((p) => !EXCLUSIONS.some((e) => e.path === p));

/**
 * **五族。四族继承自文档轴那份判据，第五族是本轴自己的形态。**
 *
 * ⚠️ **边界一律「前后都不是 ASCII 字母数字**、也不是下划线**」，与文档轴差的就是下划线。**
 * 这条差别是本轴实测出来的、不是想出来的：源码里满地都是
 * 大写字母 + 数字 + 下划线拼出来的**代码标识符**（常量名、枚举名），
 * 它们的头几个字符与第五族同形。不把下划线算进边界时，第五族在全仓 120 处命中里
 * 有 43 处是这类标识符（实测）；把下划线算进边界，这 43 处**靠正则设计自己消掉**，
 * 一条豁免都不用写。下面「不乱红」那一组里有一格拿真串把这条差别两个方向钉死。
 *
 * ⚠️ **第五族刻意不含 `H`，文档轴那份含。** 理由同样是实测：`H` + 一位数字是
 * HTML 的标题层级写法，在源码与测试的注释里是日常词（讲 markdown 骨架时随手就写），
 * 歧义太大；而 `H` 打头的那批发现号在本轮清理里**已经清完**，收它今天一处新的都抓不到、
 * 却会把标题层级那一批全部变成假红。**宁可漏收，不许拿假红换覆盖面。**
 * 文档轴那边含 `H` 是对的：出货 markdown 里本来就该写 `##` / `###`，不该写标题层级的缩写。
 */
const FAMILIES: ReadonlyArray<{
  readonly id: string;
  readonly what: string;
  readonly re: RegExp;
}> = [
  {
    id: "阶段编号",
    what: "`P` + 一位数字 + 可选一个小写字母",
    re: /(?<![0-9A-Za-z_])P[1-9][a-z]?(?![0-9A-Za-z_])/g,
  },
  {
    id: "内部任务号",
    what: "`Task` + 数字（内部任务编号，读者手上没有这份任务表）",
    re: /(?<![0-9A-Za-z_])Task[ 　]?[0-9]+(?![0-9A-Za-z_])/g,
  },
  {
    id: "内部评审发现号（第一批字母）",
    what: "`C` / `I` / `Q` / `W` + 一到两位数字 + 可选一个小写字母",
    re: /(?<![0-9A-Za-z_])[CIQW][0-9]{1,2}[a-z]?(?![0-9A-Za-z_])/g,
  },
  {
    id: "内部评审发现号（第二批字母）",
    what: "`F` / `G` / `L` / `M` / `N` + 一到两位数字 + 可选一个小写字母（**不含 `H`**）",
    re: /(?<![0-9A-Za-z_])[FGLMN][0-9]{1,2}[a-z]?(?![0-9A-Za-z_])/g,
  },
  {
    id: "内部评审名",
    // ⚠️ 这一族的 `what` 与正则都**刻意不写字面量**，理由与探针串同一条：
    //   本文件自己在射程里，把那个词组原样抄一遍就是自己命中自己（实测 5 处，五种语言各一）。
    //   ⇒ 五种写法拆成前后两截，运行时拼回去。**这不是花招，是本轴自守的一部分**：
    //   下面「本文件自己零命中」那一格钉着它。
    what: "五种语言里「那一轮通读评审」的内部叫法（它后面跟的就是发现号）",
    re: new RegExp([
      ["全分支", "评审"], ["全分支", "評審"], ["全ブランチ", "レビュー"],
      ["full-branch ", "review"], ["전체 브랜치 ", "리뷰"],
    ].map((pair) => pair.join("")).join("|"), "gi"),
  },
];

/**
 * ── 具名豁免，**恰两条**。逐条写清理由与失效条件 ────────────────────────────
 *
 * 🔴 **两条都属于同一类：判官自己的标本集。** 这不是巧合，是本轴唯一收的那一类——
 * 判据要认出一个形状，它自己就必须把那个形状的**真串**写在自己身上；
 * 清掉这些串等于把判据拆了，而拆了判据换来的「零命中」是假的。
 *
 * ⚠️ **除这两条之外，一条豁免都没有。** 其余全靠正则设计消掉（下划线进边界、
 * 数字限死一到两位、第五族不含 `H`）。**别来这里加名册**：一张会长的豁免名册，
 * 三个月后就是一张「这些文件不用查」的通行证。
 *
 * ⚠️ **豁免要双向查**：下面每一条今天都必须**真的有命中**。
 * 一条指着零命中文件的豁免是**过期名册**——它守的是空气，
 * 而它继续挂在这里只会让下一个人以为这份文件已经被看过了。⇒ 零命中当场红。
 */
const EXEMPTIONS: ReadonlyArray<{
  readonly path: string;
  readonly why: string;
  readonly until: string;
}> = [
  {
    path: "tests/unit/docs-internal-refs.test.ts",
    why: "文档轴那份判据**自己的标本集**：它的族表、探针串、误报面登记，逐条都得写真串"
      + "（族定义里的 `evidence`、`该红时红` 那一组塞进文档的探针句、"
      + "`KNOWN_FALSE_POSITIVES` 里那几条「登记它真的会咬」的句子）。"
      + "清掉这些串 = 那份判据当场失去认形状的能力，换来的零命中是假的",
    until: "哪天那份判据改成从外部夹具读探针串（真串不再写在判据自己身上）—— "
      + "那时这条豁免要删，命中该降到零",
  },
  {
    path: "scripts/prepush.sh",
    why: "⑧ 那一格的来源注释里写着「本判据口径实测是 116 处而不是 91 处」那笔差额账，"
      + "**算式本身**就得把两种数法各自数到的真串写出来，否则那段说明只剩一个结论、"
      + "下一个人无从复核。⇒ 这些命中是账目的算式，不是残留",
    until: "哪天那笔差额账被删掉（或它引用的那次清理彻底作废）—— 那时这条豁免要删",
  },
];

const EXEMPT_PATHS: ReadonlySet<string> = new Set(EXEMPTIONS.map((e) => e.path));

/** 一份文件的文本。判据与探针共用同一个读法，两边口径不许各写一套。 */
type FileReader = (path: string) => string;

const realFile: FileReader = (path) => readFileSync(path, "utf8");

/** 逐份逐行扫，命中就出一条带 `文件:行号` 的报文。**豁免的那两份不进这里**。 */
function leaks(read: FileReader, files: readonly string[] = SCOPE): string[] {
  const out: string[] = [];
  for (const path of files) {
    if (EXEMPT_PATHS.has(path)) { continue; }
    const lines = read(path).split("\n");
    for (const family of FAMILIES) {
      for (const [i, line] of lines.entries()) {
        for (const hit of line.matchAll(family.re)) {
          out.push(`${path}:${i + 1} 留着一个${family.id}「${hit[0]}」：${line.trim().slice(0, 60)}`);
        }
      }
    }
  }
  return out.sort();
}

/** 某一份文件在某个族下的命中处数。豁免那两份的双向查用它。 */
function hitsIn(read: FileReader, path: string): number {
  const lines = read(path).split("\n");
  let n = 0;
  for (const family of FAMILIES) {
    for (const line of lines) { n += [...line.matchAll(family.re)].length; }
  }
  return n;
}

/** 把某一份的内容换掉，其余照读磁盘。变异探针一律走这个口子，不动真文件。 */
const readerWith = (target: string, mutate: (src: string) => string): FileReader =>
  (path) => (path === target ? mutate(realFile(path)) : realFile(path));

/**
 * ── 今天的基线：**逐份点名**，不是一个总数 ──────────────────────────────────
 *
 * 🔴 **这张表是一笔欠账的登记，不是许可。** 上一轮清理清的是第二批字母那一族
 * （下面「新族恒为零」那一格钉着它今天在豁免之外**一处不剩**）；
 * 其余四族在跟踪文件里**从来没有被清过**，下面这 10 份就是它们的残留。
 * 每一处都是真的内部标识符或真的同形真词，逐份读过：
 *
 * · 四份判据文件（排版轴 / 对照轴 / 偏离名册 / 门面轴）里，是那几轴**自己的规则编号**
 *   与探针串——与豁免那两条同一类，但它们**没有拿到豁免**：这一族的清理该做，
 *   只是不在本轮的射程里。⇒ 登记在这里，数字不许涨。
 * · 四份源码 / 测试里，是 Unicode 控制字符区的两个标准名字（`C` + 一位数字那两个）。
 *   **这一类清不掉**：它是 Unicode 标准里那两个区的名字，改写就是把话讲错。
 *   ⇒ 这也是本轴**做不到「总数为零」**的硬原因，写在这里，不假装它不存在。
 *
 * ⚠️ **这张表是精确值，两个方向都红。** 涨了 = 新回归；
 * 掉了 = 有人清掉了一批而没回来改这张表，**那时该做的是把数字改小**，不是把它删掉。
 * 报文按方向分开说，因为这两种红的处置完全相反（本仓在 ⑥ 那一格上吃过这个亏：
 * 一句「别把脚本里的数改成新的就完事」只对其中一个方向成立）。
 */
const BASELINE: ReadonlyArray<readonly [string, number]> = [
  ["admin-ui/js/pure/sendable.mjs", 3],
  ["src/adapters/logger-console.ts", 4],
  ["src/http/admin/auth.ts", 3],
  ["tests/helpers/ship-docs.ts", 1],
  ["tests/ui/sendable-parity.test.ts", 2],
  ["tests/unit/docs-deviations.test.ts", 5],
  ["tests/unit/docs-parity.test.ts", 25],
  ["tests/unit/docs-typography.test.ts", 29],
  ["tests/unit/logger.test.ts", 4],
  ["tests/unit/repo-front-door.test.ts", 1],
];

/** 逐份点名的实际值，形态与 `BASELINE` 一致，直接拿去比。 */
function census(read: FileReader): Array<readonly [string, number]> {
  const per = new Map<string, number>();
  for (const line of leaks(read)) {
    const m = /^(.*):[0-9]+ /.exec(line);
    if (m === null) { throw new Error(`报文形态不认识，逐份点名没法从它算出来：${line}`); }
    const path = m[1] as string;
    per.set(path, (per.get(path) ?? 0) + 1);
  }
  return [...per].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * 探针的基：真的射程今天必须与基线逐份相等。
 * 否则探针红了会被读成「探针有问题」，而真因在仓里。
 */
function probeBase(): void {
  const now = JSON.stringify(census(realFile));
  if (now !== JSON.stringify(BASELINE.map(([p, n]) => [p, n]))) {
    throw new Error(
      "本格是探针，它的基取自真的射程，而射程今天本身就与基线对不上 —— "
      + "别从这一格的报文里找原因，真因在「逐份点名与基线相等」那一格：\n" + now,
    );
  }
}

describe("射程自守：`git` 的全部跟踪文件，减掉二进制与两条排除", () => {
  it("射程从 `git` 现算，且每一份都读得到", () => {
    expect(SCOPE.length, "射程空了 —— 扫描坏了").toBeGreaterThan(300);
    for (const p of SCOPE) {
      expect(() => realFile(p), `射程里有读不到的文件：${p}`).not.toThrow();
    }
  });

  it("🔴 射程 = 跟踪文件 − 二进制 − 两条排除，一份不多一份不少", () => {
    const tracked = trackedFiles();
    const binaries = tracked.filter((p) => isBinary(p));
    const expected = tracked
      .filter((p) => !binaries.includes(p))
      .filter((p) => !EXCLUSIONS.some((e) => e.path === p));
    expect([...SCOPE], "射程与「跟踪文件减二进制减排除」对不上 —— 有人动了射程").toEqual(expected);
    // 二进制那一档今天恰好只有一份。多出来一份要有人来确认它真是二进制、
    // 而不是某个被 NUL 字节污染的文本文件（那种文件会**整份**溜出判据）。
    expect(binaries, "跟踪文件里的二进制不再只有那一份 —— 确认新增的那份真的没有可读正文")
      .toEqual(["docs/logo.png"]);
  });

  it("两条排除指的文件今天都在，且都真的会命中（否则这条排除守的是空气）", () => {
    for (const e of EXCLUSIONS) {
      expect(trackedFiles(), `排除项指的文件不在跟踪文件里：${e.path}（${e.until}）`).toContain(e.path);
      expect(hitsIn(realFile, e.path),
        `排除项 ${e.path} 今天零命中 —— 这条排除已经没有产出点了，该删：${e.why}`)
        .toBeGreaterThan(0);
    }
  });

  it("射程盖住源码 / 测试 / 脚本 / 面板源码四类 —— 不是只盯 `src` 那一层", () => {
    for (const probe of [
      "src/http/admin/auth.ts",
      "tests/unit/docs-internal-refs.test.ts",
      "scripts/prepush.sh",
      "admin-ui/js/pure/sendable.mjs",
      ".github/workflows/ci.yml",
    ]) {
      expect(trackedFiles(), `${probe} 不在跟踪文件里了 —— 这一格的锚该更新`).toContain(probe);
    }
    // 🔴 口径：`tests` 整个在射程里。公开仓的读者读得到每一份测试文件，
    // 「测试不算出货物」在一个公开仓里是假的。
    expect(SCOPE.filter((p) => p.startsWith("tests/")).length,
      "射程里一份测试文件都没有 —— 测试轴整个漏了").toBeGreaterThan(50);
  });
});

describe("跟踪文件里的内部标识符：逐份点名，与登记在案的欠账相等", () => {
  it("🔴 逐份点名与基线相等（涨了是新回归，掉了是该把数字改小）", () => {
    const now = census(realFile);
    const expected = BASELINE.map(([p, n]) => [p, n]);
    const grew = now.filter(([p, n]) => {
      const was = BASELINE.find((b) => b[0] === p);
      return was === undefined || n > was[1];
    });
    const shrank = BASELINE.filter(([p, n]) => {
      const isNow = now.find((c) => c[0] === p);
      return isNow === undefined || isNow[1] < n;
    });
    expect(grew, "跟踪文件里多出了内部研发标识符（新增的份 / 涨了的份见上）。\n"
      + "**不许把这张表的数字改大**：那是把回归登记成现状。\n"
      + "出路与文档轴同一条 —— 把编号换成读者用得上的说法（「那一轮」「那次修复之后」），"
      + "或者确认那条「什么时候加的」对读者无用之后删掉整句。\n"
      + `逐条：\n${leaks(realFile).join("\n")}`).toEqual([]);
    expect(shrank, "基线比实际多 —— 有人清掉了一批而没回来改这张表。"
      + "这个方向的处置与上面相反：**把数字改小**（清到零就把那一行删掉），别把这一格注掉")
      .toEqual([]);
    expect(now, "两个方向单独看都对、合起来却不相等 —— 比对写坏了").toEqual(expected);
  });

  it("🔴 第二批字母那一族，在豁免之外**一处不剩**", () => {
    // 这一格是本文件的立法理由本身：上一轮清理清的就是这一族（1069 → 120 口径），
    // 而那次清理没有任何判据在盯。这个零从今天起有东西看着。
    const family = FAMILIES.find((f) => f.id.includes("第二批"));
    expect(family, "第二批字母那一族不见了 —— 本文件最核心的那一格没有判据可用").toBeDefined();
    const out: string[] = [];
    for (const path of SCOPE) {
      if (EXEMPT_PATHS.has(path)) { continue; }
      for (const [i, line] of realFile(path).split("\n").entries()) {
        for (const hit of line.matchAll(family!.re)) {
          out.push(`${path}:${i + 1}「${hit[0]}」：${line.trim().slice(0, 60)}`);
        }
      }
    }
    expect(out, "第二批字母那一族又回潮了（逐条见上）。上一轮把它从 1069 处清到 120 处，"
      + "而那 120 处全在豁免的两份与排除的两份里 —— 这里出现任何一处都是新写进去的").toEqual([]);
  });
});

describe("具名豁免恰两条，且两条今天都真的有命中（名册过期当场红）", () => {
  it("恰两条，一条不多 —— 长了的豁免名册就是一张「这些文件不用查」的通行证", () => {
    expect(EXEMPTIONS.length, "豁免条数变了 —— 加一条之前先读文件头那段：本轴只收一类豁免"
      + "（判官自己的标本集），其余靠正则设计消掉").toBe(2);
    for (const e of EXEMPTIONS) {
      expect(e.why.length, `${e.path} 的豁免没写理由`).toBeGreaterThan(20);
      expect(e.until.length, `${e.path} 的豁免没写失效条件 —— 一条不会过期的豁免是永久通行证`)
        .toBeGreaterThan(10);
    }
  });

  it("🔴 每一条豁免指的文件今天都在，且都真的有命中（零命中 = 名册过期）", () => {
    for (const e of EXEMPTIONS) {
      expect(trackedFiles(), `豁免指的文件不在跟踪文件里：${e.path}`).toContain(e.path);
      expect(hitsIn(realFile, e.path),
        `豁免 ${e.path} 今天零命中 —— 这条豁免守的是空气，该删。失效条件写的是：${e.until}`)
        .toBeGreaterThan(0);
    }
  });

  it("🔴 该红时红（其三）：把某条豁免指的文件清空到零命中 ⇒ 名册过期那一格必须红", () => {
    // 这是三个变异方向里的第三个。前两个在下面那一组。
    for (const e of EXEMPTIONS) {
      const emptied = readerWith(e.path, () => "");
      expect(hitsIn(emptied, e.path),
        `${e.path} 清空之后还有命中 —— 探针写坏了`).toBe(0);
      // 判据侧读的就是这个数：它掉到 0，上面那一格就红。
      expect(hitsIn(realFile, e.path) > 0 && hitsIn(emptied, e.path) === 0,
        `${e.path} 上「有命中 ⇒ 清空后零命中」这条差别不成立 —— 名册过期那一格挡不住任何东西`)
        .toBe(true);
    }
  });

  it("豁免的那两份**不进**扫描结果 —— 否则「逐份点名」那一格永远红", () => {
    const found = leaks(realFile);
    for (const e of EXEMPTIONS) {
      expect(found.filter((f) => f.startsWith(`${e.path}:`)),
        `豁免的 ${e.path} 还是进了扫描结果`).toEqual([]);
    }
  });
});

describe("该红时红：往跟踪文件里塞一个内部标识符 ⇒ 点名文件与行号", () => {
  // ⚠️ 探针串一律**拼出来**，不写字面量。本文件自己在射程里：
  //   写一个字面的真串，上面「逐份点名」那一格当场红在本文件上。
  const SECOND_BATCH = "M" + "12";
  const SECOND_BATCH_SHORT = "F" + "9";

  it("🔴 该红时红（其一）：往 `src` 的某个 `.ts` 注释里写一个第二批字母的编号 ⇒ 点名文件:行号", () => {
    probeBase();
    const target = "src/core/config.ts";
    expect(SCOPE, `${target} 不在射程里 —— 这一格的锚该更新`).toContain(target);
    const found = leaks(readerWith(target, (src) => {
      const lines = src.split("\n");
      lines.splice(2, 0, `// 这一行是探针，它带一个 ${SECOND_BATCH}。`);
      return lines.join("\n");
    }));
    const mine = found.filter((f) => f.startsWith(`${target}:`));
    expect(mine.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
    expect(mine[0], "没有点名行号").toContain(`${target}:3 `);
    expect(mine[0], "没有点名命中的那个串").toContain(`「${SECOND_BATCH}」`);
    expect(mine[0], "没有点名族").toContain("第二批字母");
  });

  it("🔴 该红时红（其二）：往 `tests` 下的某份文件里写一个第二批字母的编号 ⇒ 必须红", () => {
    // 口径：`tests` 算在射程内。公开仓的读者读得到每一份测试文件。
    probeBase();
    const target = "tests/unit/version.test.ts";
    expect(SCOPE, `${target} 不在射程里 —— 「tests 算在射程内」这条口径就没落实`).toContain(target);
    const found = leaks(readerWith(target, (src) => `${src}\n// 探针：${SECOND_BATCH_SHORT}\n`));
    const mine = found.filter((f) => f.startsWith(`${target}:`));
    expect(mine.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
    expect(mine[0]).toContain(`「${SECOND_BATCH_SHORT}」`);
  });

  it("五族逐族认得出：各塞一个真串进同一份脚本 ⇒ 逐族点名", () => {
    probeBase();
    const target = "scripts/build-ui.mjs";
    expect(SCOPE, `${target} 不在射程里 —— 这一格的锚该更新`).toContain(target);
    const probes: ReadonlyArray<readonly [string, string]> = [
      ["阶段编号", "P" + "3c"],
      ["内部任务号", "Task" + " 6"],
      ["内部评审发现号（第一批字母）", "C" + "4b"],
      ["内部评审发现号（第二批字母）", "M" + "5"],
      ["内部评审名", "全分支" + "评审"],
    ];
    expect(probes.map((p) => p[0]).sort(), "探针的族名与族表对不上 —— 有人增删了族，"
      + "而这一格还在按旧的五族逐族验").toEqual(FAMILIES.map((f) => f.id).sort());
    for (const [id, evidence] of probes) {
      const found = leaks(readerWith(target, (src) => `${src}\n// 探针：${evidence}\n`));
      const mine = found.filter((f) => f.startsWith(`${target}:`));
      expect(mine.length, `「${evidence}」应当只红一条，实际：\n${mine.join("\n")}`).toBe(1);
      expect(mine[0], `没有点名族「${id}」`).toContain(id);
      expect(mine[0], `没有点名串「${evidence}」`).toContain(`「${evidence}」`);
    }
  });

  it("同一串里挨着的两个标识符各报一条 —— 零宽前后瞻，不许换成会吃边界的字符类", () => {
    // 与文档轴那一格同一个机制：把边界字符一起吃掉的写法会漏掉第二个。
    probeBase();
    const target = "scripts/check-i18n.mjs";
    const found = leaks(readerWith(target, (src) => `${src}\n// 探针：post-${"M" + "5"}/${"M" + "5b"}-fix\n`));
    const mine = found.filter((f) => f.startsWith(`${target}:`));
    expect(mine.length, `应当报两条，实际：\n${mine.join("\n")}`).toBe(2);
    expect(mine.filter((f) => f.includes(`「${"M" + "5b"}」`)),
      "没有单独点名后一个 —— 多半是有人把零宽前后瞻换成了会吃掉边界字符的字符类").toHaveLength(1);
  });
});

describe("不乱红：形状像、意思不是的那几种，一处都不许命中", () => {
  const target = "src/core/config.ts";

  /**
   * 🔴 **下划线进边界，这一条是本轴与文档轴唯一的形态差别，两个方向都钉死。**
   * 正向：大写字母 + 数字 + 下划线拼出来的代码标识符**不许**命中。
   * 反向：把下划线从边界里拿掉的那一版**必须**命中同一串——
   * 否则文件头那段「这 43 处靠正则设计自己消掉」就成了一句没有依据的话。
   */
  it("🔴 代码标识符（大写字母 + 数字 + 下划线）不许命中，且去掉下划线边界的那版必须命中", () => {
    probeBase();
    const ident = "M" + "2" + "_COUNT";
    const found = leaks(readerWith(target, (src) => `${src}\n// const ${ident} = 3;\n`));
    expect(found.filter((f) => f.startsWith(`${target}:`)),
      `代码标识符 ${ident} 被判成了内部编号 —— 下划线掉出边界了`).toEqual([]);

    const withoutUnderscore = /(?<![0-9A-Za-z])[FGLMN][0-9]{1,2}[a-z]?(?![0-9A-Za-z])/g;
    expect(withoutUnderscore.test(`const ${ident} = 3;`),
      "去掉下划线边界的那一版居然也不命中 —— 文件头那段「43 处靠正则设计消掉」该重新实测")
      .toBe(true);
  });

  /**
   * 🔴 **第二批字母不含 `H`，两个方向都钉死。**
   * 正向：标题层级的写法不许命中。反向：把 `H` 加回去的那版必须命中同一串。
   */
  it("🔴 标题层级（`H` + 一位数字）不许命中，且把 `H` 加回族里的那版必须命中", () => {
    probeBase();
    const heading = "H" + "2";
    const found = leaks(readerWith(target, (src) => `${src}\n// 这一节的标题层级用 ${heading}。\n`));
    expect(found.filter((f) => f.startsWith(`${target}:`)),
      `标题层级 ${heading} 被判成了内部编号 —— 有人把 \`H\` 加回第二批字母那一族了`).toEqual([]);

    const withH = /(?<![0-9A-Za-z_])[FGHLMN][0-9]{1,2}[a-z]?(?![0-9A-Za-z_])/g;
    expect(withH.test(`这一节的标题层级用 ${heading}。`),
      "把 `H` 加回去的那版居然也不命中 —— 文件头那段「收 `H` 会把标题层级全变成假红」该重新实测")
      .toBe(true);
  });

  // 每一条都写清「为什么它长得像」，否则下一个人会以为这张表是凑数的。
  const INNOCENT: ReadonlyArray<readonly [string, string]> = [
    ["音频格式与点对点（`P` 后面那位数字被后面的字母挡住）", `转成 ${"MP" + "3"}，或者走 ${"P" + "2P"} 分发`],
    ["分位数（三位数字，被「一位数字」那条挡住）", `延迟 ${"P" + "95"} 是 120ms`],
    ["网络协议版本（`P` 后面跟的是斜杠，不是数字）", `上游走 ${"HTTP/" + "2"}`],
    ["架构名（数字前面是字母，被前瞻挡住）", `多架构镜像：${"amd" + "64"} 与 ${"arm" + "64"}`],
    ["显卡型号（三位数字，被「一到两位」那条挡住）", `在 ${"H" + "100"} 与 ${"L" + "40S"} 上都跑过`],
    ["固态盘规格（字母后面是点号，不是数字）", `换成 ${"M" + ".2"} 固态盘之后快了一倍`],
    ["徽章色值（六位十六进制，被「一到两位」那条挡住）", `badge/edge-${"F" + "38020"}?style=flat`],
    ["带下划线的枚举成员名", `const ${"N" + "1" + "_MODE"} = "a";`],
  ];

  it.each(INNOCENT)("%s 不许被判成内部标识符", (_why, sentence) => {
    probeBase();
    const found = leaks(readerWith(target, (src) => `${src}\n// ${sentence}\n`));
    expect(found.filter((f) => f.startsWith(`${target}:`)),
      `这一句被误伤了：${sentence}\n${found.join("\n")}`).toEqual([]);
  });

  it("注释里出现「评审」两个字但不带发现号 —— 不许因此红", () => {
    probeBase();
    const found = leaks(readerWith(target, (src) => `${src}\n// 这笔账是评审要求主动给出的。\n`));
    expect(found.filter((f) => f.startsWith(`${target}:`)),
      `「评审」这个词本身被判成了泄漏：\n${found.join("\n")}`).toEqual([]);
  });
});

/**
 * ── 与文档轴那份判据不漂 ────────────────────────────────────────────────────
 * 本文件的四族是**继承**来的。继承来的东西会漂，而漂了没人会发现——
 * 文档轴那边加了第六族，本轴不会有任何反应，两轴从此认的不是同一批形状。
 * ⇒ 拿那边**当场抽**出来的族表与本文件对齐。
 * 抽取形态与 `scripts/prepush.sh` 的 ⑧ 逐字相同（`id:` / `re:` / `evidence:` 各占一行）。
 */
describe("与文档轴那份真源不漂：族数对得上，它登记的每个证据串本轴都认得出", () => {
  const DOC_AXIS = "tests/unit/docs-internal-refs.test.ts";

  /** 从文档轴那份文件里抽出每一族登记的证据串。抽不到就当场红（抽空了会让这一组恒绿）。 */
  function docAxisEvidence(): string[] {
    const src = realFile(DOC_AXIS);
    const out = [...src.matchAll(/^ +evidence: "(.*)",$/gm)].map((m) => m[1] as string);
    if (out.length === 0) {
      throw new Error(`从 ${DOC_AXIS} 一族都没抽出来 —— 抽取器坏了。`
        + "一个抽空了的族表会让这一组恒绿，那比没有这一组更坏");
    }
    return out;
  }

  it("文档轴今天登记着五族，本轴也是五族", () => {
    expect(docAxisEvidence().length, `${DOC_AXIS} 的族数变了 —— `
      + "确认新增/删除的那一族在源码轴上该不该有对应的一族").toBe(5);
    expect(FAMILIES.length, "本轴的族数变了").toBe(5);
  });

  it("🔴 文档轴登记的每一个证据串，本轴至少有一族认得出", () => {
    for (const evidence of docAxisEvidence()) {
      const hit = FAMILIES.some((f) => {
        f.re.lastIndex = 0;
        return f.re.test(evidence);
      });
      expect(hit, `文档轴登记的证据串「${evidence}」本轴一族都认不出 —— 两轴漂了。`
        + "要么本轴少了一族，要么本轴某一族的形状被收窄了（下划线边界与不含 `H` 这两条"
        + "是**有意**的差别，文件头写着理由；除此之外的差别都该有人来确认）").toBe(true);
    }
  });

  it("本文件自己在射程里，且今天零命中 —— 判据不许给自己开后门", () => {
    // 判据自己写在射程里的文件上，而它一处命中都没有：所有探针串都是**拼出来**的。
    // 这一格红了，说明有人往本文件里写了字面的真串 —— 那正是豁免那两份才有的特权。
    const self = "tests/unit/source-internal-refs.test.ts";
    expect(trackedFiles(), `${self} 还没进 git —— 它不在射程里，本格验的是空气`).toContain(self);
    expect(EXEMPT_PATHS.has(self), "本文件给自己开了豁免").toBe(false);
    expect(leaks(realFile).filter((f) => f.startsWith(`${self}:`)),
      "本文件自己命中了 —— 探针串必须拼出来写，不许写字面量").toEqual([]);
  });
});
