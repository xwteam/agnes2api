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
 * 🔴 **这一段是本文件对外宣称的射程边界，漏一条就等于把射程说大一分。四条，一条都不许省。**
 * ① **认形状，不认语义。** 与文档轴同一条：它认的是**标识符的形状**，
 *    不是「这句话是不是在讲内部排期」。不带任何编号的路线图陈述、内部人名、内部工具名，
 *    本文件一格都不管。
 * ② **判官自己的标本集那两份，只查处数与签名，不查内容。** 那两份（见下面 `SPECIMENS`）
 *    照样进扫描、照样逐份在册，但它们**不参与**「第二批字母那一族一处不剩」那个零——
 *    它们身上那 37 处正是判据用来认形状的真串。⇒ 那两份里某一处标本变了质、
 *    而处数与签名同时对得上，本文件不红。
 * ③ **在册文件里的同串挪位。** 签名认的是「这一份的命中串排序后的多重集」：
 *    同一个串在同一份文件里换个地方写、换个语境写，处数与签名**都不变** ⇒ 本文件不红。
 *    （签名之前的射程更小：**任何等量替换**都不红——实测把一处 Unicode 控制字符区的标准名
 *    改成一个发现号的形状，那一份处数不变、全格皆绿。签名把这一档收掉了，
 *    剩下的就是同串挪位这一档。下面「该红时红（其五）」把这条差别钉死。）
 * ④ **`H` 打头的发现号，将来一处都抓不到。** 第二批字母那一族刻意不含 `H`，
 *    理由写在族注释里（`H` + 一位数字是标题层级的日常写法，收它是拿假红换覆盖面）。
 *    今天没有一处 `H` 打头的残留，所以这条不欠账；但**明天新写的**那一批，本轴永远是绿的。
 *    ⇒ 这不是漏，是一笔明写在这里的取舍。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
 * ⚠️ 这两条排的是**根本不该进射程的东西**，与下面 `SPECIMENS` 那两份完全不是一回事：
 * 标本集那两份**在射程里、照样扫、照样逐份在册**，它们只是不参与
 * 「第二批字母那一族一处不剩」那个零。这里排掉的这两份是连扫都不扫。
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
 * **七族。六族的形状继承自文档轴那份判据，内部评审名那一族在本轴刻意拼着写。**
 *
 * ⚠️ **边界一律「前后都不是 ASCII 字母数字**、也不是下划线**」，与文档轴差的就是下划线。**
 * 这条差别是本轴实测出来的、不是想出来的：源码里满地都是
 * 大写字母 + 数字 + 下划线拼出来的**代码标识符**（常量名、枚举名），
 * 它们的头几个字符与第二批字母那一族同形。不把下划线算进边界时，那一族在全仓 120 处命中里
 * 有 43 处是这类标识符（实测）；把下划线算进边界，这 43 处**靠正则设计自己消掉**，
 * 一条名册都不用写。下面「不乱红」那一组里有一格拿真串把这条差别两个方向钉死。
 *
 * ⚠️ **第二批字母那一族刻意不含 `H`，文档轴那份含。** 理由同样是实测：`H` + 一位数字是
 * HTML 的标题层级写法，在源码与测试的注释里是日常词（讲 markdown 骨架时随手就写），
 * 歧义太大；而 `H` 打头的那批发现号在本轮清理里**已经清完**，收它今天一处新的都抓不到、
 * 却会把标题层级那一批全部变成假红。**宁可漏收，不许拿假红换覆盖面。**
 * 文档轴那边含 `H` 是对的：出货 markdown 里本来就该写 `##` / `###`，不该写标题层级的缩写。
 */
/**
 * 大写字母那个区间的写法，**拼出来**。理由与探针串同一条：本文件自己在射程里，
 * 把它原样写成字面量就是自己命中「字母 + 连字号 + 字母」那一族。
 */
const UPPER = "A" + "-" + "Z";

const FAMILIES: ReadonlyArray<{
  readonly id: string;
  readonly what: string;
  /** 正则的**源与标志，不是正则对象**。正则在每个使用点现造，理由见下面 `reOf()` 那段。 */
  readonly source: string;
  readonly flags: string;
}> = [
  {
    id: "阶段编号",
    what: "`P` + 一位数字 + 可选一个小写字母",
    source: "(?<![0-9A-Za-z_])P[1-9][a-z]?(?![0-9A-Za-z_])",
    flags: "g",
  },
  {
    id: "内部任务号",
    what: "`Task` + 数字（内部任务编号，读者手上没有这份任务表）",
    source: "(?<![0-9A-Za-z_])Task[ 　]?[0-9]+(?![0-9A-Za-z_])",
    flags: "g",
  },
  {
    id: "内部评审发现号（第一批字母）",
    what: "`C` / `I` / `Q` / `W` + 一到两位数字 + 可选一个小写字母",
    source: "(?<![0-9A-Za-z_])[CIQW][0-9]{1,2}[a-z]?(?![0-9A-Za-z_])",
    flags: "g",
  },
  {
    id: "内部评审发现号（第二批字母）",
    what: "`F` / `G` / `L` / `M` / `N` + 一到两位数字 + 可选一个小写字母（**不含 `H`**）",
    source: "(?<![0-9A-Za-z_])[FGLMN][0-9]{1,2}[a-z]?(?![0-9A-Za-z_])",
    flags: "g",
  },
  {
    id: "内部评审发现号（第三批字母）",
    what: "第三批那八个字母 + 一到两位数字 + 可选一个小写字母",
    /*
     * ⚠️ **这一族与上面那两批是同一件事的第三口**：文档轴那边当初逐字母挑子集时，
     * 把这八个字母整批放走了，理由是「它们打头的全是真词」。真词确实是真的，
     * 但**放走整批发现号的从来不是一条性质，只是时序**——同一批字母打头的发现号
     * 在跟踪文件里今天有几百处，公开 `git log` 里一个字母不缺。
     * 收它的理由与代价逐条写在文档轴那份判据的族表里，本轴不另抄一份。
     *
     * ⚠️ **这一族的同形真词分不开，只能具名躺在 `BASELINE` 里。** 分位数那一类靠
     * 「一位数字」的形状就消掉了；而对象存储与边缘数据库那两个产品名、JS 引擎那个名字，
     * 与发现号**逐字节相同**。⇒ 别来这里凑一条「分得开」的正则，凑不出来；
     * 它们在下面那张逐份表里按份数与签名钉着，涨一处就红。
     */
    source: "(?<![0-9A-Za-z_])[ABDORUVX][0-9]{1,2}[a-z]?(?![0-9A-Za-z_])",
    flags: "g",
  },
  {
    id: "内部条目号（字母 + 连字号 + 字母）",
    what: "一个大写字母 + 连字号 + 一个大写字母或数字",
    /*
     * ⚠️ **本轮之前谁都没见过的形状**：上面几族认的都是「字母紧跟数字」，
     * 而这一批内部条目号中间隔着一个连字号，于是它们从每一族底下整批溜过去。
     * 落地当天全仓实测：跟踪文件里上百处，公开 `git log` 里几十处。
     *
     * ⚠️ **正则源刻意拼出来，不写字面量**：那个字符类的写法本身就与本族同形，
     * 原样抄一遍就是自己命中自己（「本文件自己零命中」那一格会当场红在本文件上）。
     * 理由与内部评审名那一族逐字相同。
     */
    source: `(?<![0-9A-Za-z_])[${UPPER}]-[${UPPER}0-9](?![0-9A-Za-z_])`,
    flags: "g",
  },
  {
    id: "内部评审名",
    // ⚠️ 这一族的 `what` 与正则源都**刻意不写字面量**，理由与探针串同一条：
    //   本文件自己在射程里，把那个词组原样抄一遍就是自己命中自己（实测 5 处，五种语言各一）。
    //   ⇒ 五种写法拆成前后两截，运行时拼回去。**这不是花招，是本轴自守的一部分**：
    //   下面「本文件自己零命中」那一格钉着它。
    what: "五种语言里「那一轮通读评审」的内部叫法（它后面跟的就是发现号）",
    source: [
      ["全分支", "评审"], ["全分支", "評審"], ["全ブランチ", "レビュー"],
      ["full-branch ", "review"], ["전체 브랜치 ", "리뷰"],
    ].map((pair) => pair.join("")).join("|"),
    flags: "gi",
  },
];

/**
 * 🔴 **每个使用点现造一个正则；族表里不许存正则对象。**
 *
 * 带 `g` 的正则身上挂着 `lastIndex`，而它是**可变的共享状态**：一次返回 true 的 `test()`
 * 会把它推到匹配结束的位置**留在那儿**，而 `String.prototype.matchAll`
 * **会把源正则的 `lastIndex` 复制进它内部那个匹配器** ⇒ 之后每一次 `matchAll`
 * 都从那个偏移开始扫，**静默漏掉每一行头上的那几个字符**。
 *
 * 本文件实测栽过这一跤：族表存正则对象的那一版里，「两轴不漂」那一组拿族正则做 `test()`，
 * 一个 11 个字符的证据串就把 `lastIndex` 留在 11；跟着 `leaks()` / `hitsIn()` 走 `matchAll`
 * 的每一格都从第 11 个字符起扫，**漏掉的报文长得和真的一模一样**——
 * 「本文件自己零命中」那一格因此对本文件里真实存在的字面真串保持绿。
 *
 * ⚠️ **别退回去存正则对象，也别指望「用前重置 `lastIndex`」**：重置漏掉一个使用点就复现，
 * 而复现出来的是**假绿**，没有任何东西会提示。现造是这里唯一不依赖纪律的写法。
 */
function reOf(family: { readonly source: string; readonly flags: string }): RegExp {
  return new RegExp(family.source, family.flags);
}

/**
 * ── 判官自己的标本集，**恰两份**。逐份写清理由与失效条件 ────────────────────
 *
 * 🔴 **这两份不是「不用查」，它们是「第二批字母那个零对它们不成立」。**
 * 判据要认出一个形状，它自己就必须把那个形状的**真串**写在自己身上；
 * 清掉这些串等于把判据拆了，而拆了判据换来的「零命中」是假的。
 * ⇒ 下面「第二批字母那一族一处不剩」那一格把这两份跳过，**只有那一格**。
 *
 * 🔴 **它们照样进扫描、照样在 `BASELINE` 里逐份点名**（今天各 130 与 86 处，七族合计）。
 * 这一条是**修回来的**：早先这两份走的是「整份跳过、族族都不查」，
 * 后果实测过——往 `scripts/prepush.sh` 末尾新写一个第二批字母的编号加一个任务号，
 * **一格都不红**。判官的标本集要的是「这一份的数字与签名不许动」，
 * 不是「这一份不用查」。**别再把整份跳过加回来。**
 *
 * ⚠️ **除这两份之外，没有第二种放行。** 其余全靠正则设计消掉（下划线进边界、
 * 数字限死一到两位、第二批字母不含 `H`）。**别来这里加名册**：一张会长的名册，
 * 三个月后就是一张「这些文件不用查」的通行证。
 *
 * ⚠️ **双向查，而且要查对族**：下面每一份今天都必须**真的有第二批字母那一族的命中**。
 * 拿别的族凑数不算——它们免的就是那一族的零，那一族掉到零之后这条登记守的是空气，
 * 而它继续挂在这里只会让下一个人以为这份文件已经被看过了。⇒ 零命中当场红。
 * 另一半在 `BASELINE`：每一份都必须在册，否则它的处数没有任何棘轮盯着。
 */
const SPECIMENS: ReadonlyArray<{
  readonly path: string;
  readonly why: string;
  readonly until: string;
}> = [
  {
    path: "tests/unit/docs-internal-refs.test.ts",
    why: "文档轴那份判据**自己的标本集**：它的族表、探针串、误报面登记，逐条都得写真串"
      + "（族定义里的 `evidence`、`该红时红` 那一组塞进文档的探针句、"
      + "`KNOWN_FALSE_POSITIVES` 里那几条「登记它真的会咬」的句子）。"
      + "清掉这些串 = 那份判据当场失去认形状的能力，换来的零命中是假的。"
      + "⇒ 第二批字母那个零对它不成立（今天 28 处，七族合计 130 处）",
    until: "哪天那份判据改成从外部夹具读探针串（真串不再写在判据自己身上）—— "
      + "那时这份该从这里删掉，它在第二批字母那一族上的命中该降到零",
  },
  {
    path: "scripts/prepush.sh",
    why: "⑧ 那一格的来源注释里写着「本判据口径实测是 116 处而不是 91 处」那笔差额账，"
      + "**算式本身**就得把两种数法各自数到的真串写出来，否则那段说明只剩一个结论、"
      + "下一个人无从复核。⇒ 这些命中是账目的算式，不是残留（第二批字母那一族今天 9 处）",
    until: "哪天那笔差额账被删掉（或它引用的那次清理彻底作废）—— 那时这份该从这里删掉",
  },
];

/** **只有「第二批字母一处不剩」那一格看这张表。** 扫描与逐份点名一律不看。 */
const SPECIMEN_PATHS: ReadonlySet<string> = new Set(SPECIMENS.map((e) => e.path));

/** 一份文件的文本。判据与探针共用同一个读法，两边口径不许各写一套。 */
type FileReader = (path: string) => string;

const realFile: FileReader = (path) => readFileSync(path, "utf8");

/** 一处命中。报文、逐份点名、签名三处共用同一份结构，口径不许各写一套。 */
type Hit = {
  readonly path: string;
  readonly line: number;
  readonly family: string;
  readonly text: string;
  readonly context: string;
};

/**
 * 逐份逐行扫。**射程里一份都不跳过**——标本集那两份也照扫，
 * 它们走的是下面 `BASELINE` 的逐份精确棘轮，不是「整份不查」。
 */
function scan(read: FileReader, files: readonly string[] = SCOPE): Hit[] {
  const out: Hit[] = [];
  for (const path of files) {
    const lines = read(path).split("\n");
    for (const family of FAMILIES) {
      const re = reOf(family);
      for (const [i, line] of lines.entries()) {
        for (const hit of line.matchAll(re)) {
          out.push({
            path, line: i + 1, family: family.id,
            text: hit[0], context: line.trim().slice(0, 60),
          });
        }
      }
    }
  }
  return out;
}

/** 命中出一条带 `文件:行号` 的报文。 */
function leaks(read: FileReader, files: readonly string[] = SCOPE): string[] {
  return scan(read, files)
    .map((h) => `${h.path}:${h.line} 留着一个${h.family}「${h.text}」：${h.context}`)
    .sort();
}

/** 某一份文件的命中处数；给了族名就只数那一族。标本集那两份的双向查用它。 */
function hitsIn(read: FileReader, path: string, family?: string): number {
  return scan(read, [path]).filter((h) => family === undefined || h.family === family).length;
}

/**
 * 一份文件的**命中串签名**：这一份的全部命中串排序后接起来取摘要。
 *
 * 🔴 **存摘要，不存原串。** 理由是本文件自己在射程里：把在册的那些真串原样抄进基线表，
 * 就是判据给自己开后门（「本文件自己零命中」那一格会当场红在这张表上）。
 * ⚠️ 摘要认的是**多重集**（排序后再接），不是出现顺序 ⇒ **同一个串挪位置认不出来**。
 * 这一档明写在文件头「它验不了什么」的第 ③ 条里，别读成「内容变了一定会红」。
 */
function signature(hits: readonly string[]): string {
  return createHash("sha256").update([...hits].sort().join("\n")).digest("hex").slice(0, 12);
}

/** 把某一份的内容换掉，其余照读磁盘。变异探针一律走这个口子，不动真文件。 */
const readerWith = (target: string, mutate: (src: string) => string): FileReader =>
  (path) => (path === target ? mutate(realFile(path)) : realFile(path));

/**
 * ── 今天的基线：**逐份点名 + 逐份签名**，不是一个总数 ───────────────────────
 *
 * 🔴 **这张表是一笔欠账的登记，不是许可。** 上一轮清理清的是第二批字母那一族
 * （下面「新族恒为零」那一格钉着它今天在标本集之外**一处不剩**）；
 * 其余六族在跟踪文件里**从来没有被清过**，下面这 49 份就是它们的残留。
 * 每一处都是真的内部标识符或真的同形真词，逐族读过：
 *
 * 🔴 **这张表本轮从 10 份长到 49 份，长出来的一处都不是新写进去的东西。**
 * 长出来的是本轮新登记的那两族（第三批字母、字母 + 连字号 + 字母）的**存量**：
 * 它们此前对**任何一条判据**都是隐形的——一族是当初逐字母挑子集时整批挑漏了，
 * 另一族的形状谁都没见过。⇒ 数字变大是判据的射程变宽，不是仓库变脏。
 * **它们的清理不在本轮的射程里**；本轮要的是「从今天起不许再涨」，那正是这张表干的事。
 *
 * · **判据文件**（排版轴 / 对照轴 / 偏离名册 / 门面轴 / 译名表那几份）里那一大批，
 *   是那几轴**自己的规则编号**与探针串：读者在仓里 grep 得到同名的判定本体，
 *   不是内部轨迹。它们与标本集那两份同一类，但**没有拿到任何一族的免** ⇒ 数字不许涨。
 * · **面板源码 / 契约测试 / 前端测试**里那一批带连字号的，是**真的内部条目号**
 *   （某一轮待验证清单与变异编号）。这一批该清，只是不在本轮的射程里 ⇒ 登记在这里。
 * · **五份**源码 / 测试里，是 Unicode 控制字符区的两个标准名字（`C` + 一位数字那两个）。
 *   **这一类清不掉**：它是 Unicode 标准里那两个区的名字，改写就是把话讲错。
 *   ⇒ 这也是本轴**做不到「总数为零」**的硬原因，写在这里，不假装它不存在。
 *   同一档还有本轮新登记那两族带进来的同形真词：JS 引擎那个名字、对象存储与边缘
 *   数据库那两个产品名、以及正则里大写字母区间那个写法本身。它们与编号**逐字节相同**，
 *   形状上分不开，只能像这样具名躺在这张表里，靠份数与签名钉着。
 * · 两份是**判官自己的标本集**（`SPECIMENS` 那两份，今天 130 与 86 处）：
 *   它们的数字天生就高，理由逐份写在那张表里。**它们在册的意义只有一个——
 *   数字与签名不许动。** 早先它们走的是「整份跳过」，那等于往这两份里新写任何编号都不红。
 *
 * ⚠️ **这张表是精确值，三个方向都红。** 涨了 = 新回归；
 * 掉了 = 有人清掉了一批而没回来改这张表，**那时该做的是把数字改小**，不是把它删掉；
 * 处数没动而**签名变了** = 等量替换（有人把一处正当命中换成了另一个形状）。
 * 报文按方向分开说，因为这三种红的处置完全不同（本仓在 ⑥ 那一格上吃过这个亏：
 * 一句「别把脚本里的数改成新的就完事」只对其中一个方向成立）。
 *
 * 🔴 **第三列是签名，不是随便一个校验和：它是这一份全部命中串排序后的摘要**
 * （见 `signature()`，那里写着它为什么存摘要不存原串、以及它认不出什么）。
 * 没有这一列时的盲区实测过：把 `tests/unit/logger.test.ts:114` 那一行里一处控制字符区的
 * 标准名改写成一个发现号的形状，那一份**处数不变**，全格皆绿。
 * ⚠️ 签名对不上时**别只改签名**——先逐条读报文确认新的那一处正当，再改。
 */
const BASELINE: ReadonlyArray<readonly [string, number, string]> = [
  ["admin-ui/js/api.js", 1, "21eef6971ae7"],
  ["admin-ui/js/app.js", 1, "21eef6971ae7"],
  ["admin-ui/js/i18n-dict.js", 2, "591622bf1a11"],
  ["admin-ui/js/pure/playground.mjs", 3, "307dcc22cd71"],
  ["admin-ui/js/pure/sendable.mjs", 3, "6d7e39c41b4a"],
  ["admin-ui/js/pure/usage.mjs", 1, "d305e955a224"],
  ["admin-ui/js/sec-playground.js", 15, "40235c725862"],
  ["admin-ui/js/sec-settings.js", 1, "3f6c7ba5ffe7"],
  ["scripts/prepush.sh", 86, "df9576f20dce"],
  ["scripts/smoke-dual-runtime.sh", 2, "a9ec222003e9"],
  ["src/adapters/logger-console.ts", 4, "de1aa8f2a4cd"],
  ["src/core/admin/usage-stats.ts", 8, "19a2468562ab"],
  ["src/core/tend-scheduler.ts", 1, "86348ea0bf50"],
  ["src/http/admin/auth.ts", 3, "6d7e39c41b4a"],
  ["src/http/admin/handlers/overview.ts", 1, "86348ea0bf50"],
  ["src/http/admin/handlers/registrar.ts", 1, "78c7523daad8"],
  ["src/http/admin/handlers/usage.ts", 2, "d98018103bdc"],
  ["src/http/admin/router.ts", 1, "d305e955a224"],
  ["src/http/usage-sink.ts", 1, "0f9be40aaef6"],
  ["tests/contract/admin-events.test.ts", 5, "c624cbc805b7"],
  ["tests/contract/admin-registrar.test.ts", 1, "ae4183abbde3"],
  ["tests/contract/admin-usage.test.ts", 3, "966131ffe196"],
  ["tests/contract/media.test.ts", 1, "11508a93417c"],
  ["tests/contract/stream-parity.test.ts", 6, "e8e4be318786"],
  ["tests/contract/usage-tier2.test.ts", 1, "280a4a2311fb"],
  ["tests/helpers/doc-glossary.ts", 2, "2c16973275e7"],
  ["tests/helpers/readme-sections.ts", 2, "8db22afc6dc9"],
  ["tests/ui/api-session.test.ts", 14, "168cc21fb285"],
  ["tests/ui/dom/playground-section.test.ts", 18, "cc0f719a0fc9"],
  ["tests/ui/dom/usage-section.test.ts", 1, "6df15e22da98"],
  ["tests/ui/events.test.ts", 1, "82988760f79b"],
  ["tests/ui/examples.test.ts", 2, "9d4ab8a7c080"],
  ["tests/ui/i18n.test.ts", 1, "ac71a10b2936"],
  ["tests/ui/playground.test.ts", 6, "37593802c179"],
  ["tests/ui/sendable-parity.test.ts", 2, "bc4554e3aa76"],
  ["tests/ui/settings.test.ts", 2, "84ed9f000ec5"],
  ["tests/unit/admin/tend-guard.test.ts", 1, "78c7523daad8"],
  ["tests/unit/admin/usage-stats.test.ts", 2, "9381084923e7"],
  ["tests/unit/docs-deviations.test.ts", 8, "250bff753e7a"],
  ["tests/unit/docs-internal-refs.test.ts", 130, "0daf1299a96b"],
  ["tests/unit/docs-parity.test.ts", 321, "198f775bea74"],
  ["tests/unit/docs-typography.test.ts", 119, "67ce9c846574"],
  ["tests/unit/env-example-parity.test.ts", 10, "8c1af04ab776"],
  ["tests/unit/logger.test.ts", 4, "de1aa8f2a4cd"],
  ["tests/unit/readme-sections.test.ts", 1, "46165daa97b9"],
  ["tests/unit/registrar/config.test.ts", 4, "da32591f0714"],
  ["tests/unit/registrar/tender.test.ts", 2, "6f6cf8e37a7b"],
  ["tests/unit/repo-front-door.test.ts", 5, "1bae9ee8c149"],
  ["tests/unit/source-guards.test.ts", 4, "ca1a3beaa360"],
];

/** 逐份点名的实际值，形态与 `BASELINE` 一致（路径 / 处数 / 签名），直接拿去比。 */
function census(read: FileReader): Array<readonly [string, number, string]> {
  const per = new Map<string, string[]>();
  for (const h of scan(read)) {
    const cur = per.get(h.path);
    if (cur === undefined) { per.set(h.path, [h.text]); } else { cur.push(h.text); }
  }
  return [...per]
    .map(([p, texts]) => [p, texts.length, signature(texts)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * 逐份点名与基线的三个方向。**判据与变异探针共用这一个算法**，
 * 两边口径不许各写一套——探针验的必须是判据真正读的那个数。
 */
function ratchet(read: FileReader): {
  readonly grew: ReadonlyArray<readonly [string, number, string]>;
  readonly shrank: ReadonlyArray<readonly [string, number, string]>;
  readonly swapped: ReadonlyArray<readonly [string, number, string]>;
} {
  const now = census(read);
  const grew = now.filter(([p, n]) => {
    const was = BASELINE.find((b) => b[0] === p);
    return was === undefined || n > was[1];
  });
  const shrank = BASELINE.filter(([p, n]) => {
    const isNow = now.find((c) => c[0] === p);
    return isNow === undefined || isNow[1] < n;
  });
  const swapped = now.filter(([p, n, s]) => {
    const was = BASELINE.find((b) => b[0] === p);
    return was !== undefined && n === was[1] && s !== was[2];
  });
  return { grew, shrank, swapped };
}

/**
 * 探针的基：真的射程今天必须与基线逐份相等。
 * 否则探针红了会被读成「探针有问题」，而真因在仓里。
 */
function probeBase(): void {
  const now = JSON.stringify(census(realFile));
  if (now !== JSON.stringify(BASELINE.map(([p, n, s]) => [p, n, s]))) {
    throw new Error(
      "本格是探针，它的基取自真的射程，而射程今天本身就与基线对不上 —— "
      + "别从这一格的报文里找原因，真因在「逐份点名与基线相等」那一格：\n" + now,
    );
  }
}

/**
 * 探针串一律**拼出来**，不写字面量：本文件自己在射程里，
 * 写一个字面的真串，「逐份点名」那一格当场红在本文件上。
 */
const PROBE_SECOND_BATCH = "M" + "12";
const PROBE_SECOND_BATCH_SHORT = "F" + "9";

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

/**
 * 🔴 **下面每一格凡是走全射程扫描的，都显式带 60 秒预算（`}, 60_000)`），不是「放宽断言」。**
 *
 * 这一轴的每一次 `leaks()` / `census()` 都要把射程里那几百份文件逐族逐行重扫一遍，
 * 而变异探针每格还要再扫一到几遍。vitest 的默认单格超时是 5 秒：单核、有负载的机器上
 * 整套测试从 195 秒拖到 251 秒时，这些格子会被那 5 秒当场切断，
 * **红出来的报文是「超时」，不是它真正要守的那件事**——看报文的人会去找一个不存在的回归。
 * 本仓在 `tests/unit/check-comment-refs.test.ts:1421` 那一格上栽过同一跤，修法逐字相同。
 * ⚠️ **断言一个字都没动，改的只有时间预算。**
 */
describe("跟踪文件里的内部标识符：逐份点名，与登记在案的欠账相等", () => {
  it("🔴 逐份点名与基线相等（涨了是新回归，掉了是该把数字改小，签名变了是等量替换）", () => {
    const now = census(realFile);
    const expected = BASELINE.map(([p, n, s]) => [p, n, s]);
    const { grew, shrank, swapped } = ratchet(realFile);
    expect(grew, "跟踪文件里多出了内部研发标识符（新增的份 / 涨了的份见上）。\n"
      + "**不许把这张表的数字改大**：那是把回归登记成现状。\n"
      + "出路与文档轴同一条 —— 把编号换成读者用得上的说法（「那一轮」「那次修复之后」），"
      + "或者确认那条「什么时候加的」对读者无用之后删掉整句。\n"
      + `逐条：\n${leaks(realFile).join("\n")}`).toEqual([]);
    expect(shrank, "基线比实际多 —— 有人清掉了一批而没回来改这张表。"
      + "这个方向的处置与上面相反：**把数字改小**（清到零就把那一行删掉），别把这一格注掉")
      .toEqual([]);
    expect(swapped, "处数没动，但这一份的命中串变了 —— 有人把一处正当命中换成了另一个形状"
      + "（等量替换）。这个方向的处置与上面两个都不同：\n"
      + "**先逐条读下面的报文、确认新的那一处确实正当，再把第三列的签名改成新值。**\n"
      + "只改签名不读报文，等于把一处新泄漏登记成现状。\n"
      + `逐条：\n${leaks(realFile).join("\n")}`).toEqual([]);
    expect(now, "三个方向单独看都对、合起来却不相等 —— 比对写坏了").toEqual(expected);
  }, 60_000);

  it("🔴 第二批字母那一族，在标本集那两份之外**一处不剩**", () => {
    // 这一格是本文件的立法理由本身：上一轮清理清的就是这一族（1069 → 120 口径），
    // 而那次清理没有任何判据在盯。这个零从今天起有东西看着。
    // ⚠️ **这里是标本集那两份唯一被跳过的地方。** 它们的处数与签名在上面那一格里照查。
    const family = FAMILIES.find((f) => f.id.includes("第二批"));
    expect(family, "第二批字母那一族不见了 —— 本文件最核心的那一格没有判据可用").toBeDefined();
    const out = scan(realFile, SCOPE.filter((p) => !SPECIMEN_PATHS.has(p)))
      .filter((h) => h.family === family!.id)
      .map((h) => `${h.path}:${h.line}「${h.text}」：${h.context}`)
      .sort();
    expect(out, "第二批字母那一族又回潮了（逐条见上）。上一轮把它从 1069 处清到 120 处，"
      + "而那 120 处全在标本集那两份与排除的两份里 —— 这里出现任何一处都是新写进去的").toEqual([]);
  }, 60_000);

  it("🔴 该红时红（其五）：在册文件里做一次**等量替换** ⇒ 签名那个方向必须红", () => {
    // 这一格钉的是基线第三列存在的理由：只记处数时，这个变异**全格皆绿**（实测过）。
    // 替换串照例拼出来写，不写字面量。
    probeBase();
    const target = "tests/unit/logger.test.ts";
    const from = "C" + "1";
    const to = "Q" + "7";
    const mutated = readerWith(target, (src) => src.replace(from, to));
    const row = census(mutated).find(([p]) => p === target);
    const was = BASELINE.find((b) => b[0] === target);
    expect(row?.[1], "等量替换之后处数变了 —— 探针写坏了，它验的就是「处数不变」这一档")
      .toBe(was![1]);
    const { grew, shrank, swapped } = ratchet(mutated);
    expect(grew, "等量替换不该让任何一份涨").toEqual([]);
    expect(shrank, "等量替换不该让任何一份掉").toEqual([]);
    expect(swapped.map((r) => r[0]),
      "等量替换没被认出来 —— 基线只记处数就是这个盲区，第三列的签名是为它加的")
      .toEqual([target]);
  }, 60_000);
});

describe("判官的标本集恰两份：在册、真的带那一族、且没拿到「整份不查」", () => {
  /** 标本集免的就是这一族的零 ⇒ 双向查一律按这一族数，别拿别的族凑数。 */
  const secondBatch = () => {
    const family = FAMILIES.find((f) => f.id.includes("第二批"));
    expect(family, "第二批字母那一族不见了 —— 标本集的双向查没有族可数").toBeDefined();
    return family!;
  };

  it("恰两份，一份不多 —— 长了的名册就是一张「这些文件不用查」的通行证", () => {
    expect(SPECIMENS.length, "标本集的份数变了 —— 加一份之前先读那张表上面那段："
      + "本轴只对一类文件免那一族的零（判据自己的标本集），其余靠正则设计消掉").toBe(2);
    for (const e of SPECIMENS) {
      expect(e.why.length, `${e.path} 没写理由`).toBeGreaterThan(20);
      expect(e.until.length, `${e.path} 没写失效条件 —— 一条不会过期的放行是永久通行证`)
        .toBeGreaterThan(10);
    }
  });

  it("🔴 每一份今天都在，且都真的有**第二批字母那一族**的命中（零命中 = 名册过期）", () => {
    const family = secondBatch();
    for (const e of SPECIMENS) {
      expect(trackedFiles(), `标本集指的文件不在跟踪文件里：${e.path}`).toContain(e.path);
      expect(hitsIn(realFile, e.path, family.id),
        `标本集 ${e.path} 今天在第二批字母那一族上零命中 —— 它免的就是那一族的零，`
        + `现在守的是空气，该从表里删掉。失效条件写的是：${e.until}`)
        .toBeGreaterThan(0);
    }
  });

  it("🔴 两份标本集都**进扫描结果**、都在基线里在册 —— 它们没有拿到「整份不查」", () => {
    // 🔴 这一格是本组的重心：早先这两份走的是 `continue`（整份跳过，族族都不查），
    //    于是往它们里面新写任何一族的编号都一处不红。这里把「它们在册」钉死。
    const found = leaks(realFile);
    for (const e of SPECIMENS) {
      expect(SCOPE, `${e.path} 不在射程里了 —— 它连扫都不扫了`).toContain(e.path);
      expect(found.filter((f) => f.startsWith(`${e.path}:`)).length,
        `标本集 ${e.path} 一处都没进扫描结果 —— 多半是有人又把它整份跳过了`)
        .toBeGreaterThan(0);
      expect(BASELINE.map((b) => b[0]),
        `标本集 ${e.path} 不在基线里 —— 它的处数与签名没有任何棘轮盯着，`
        + "往里面新写一个编号将一格都不红").toContain(e.path);
    }
  }, 60_000);

  it("🔴 该红时红（其三）：往标本集那两份里各新写一个编号 ⇒ 逐份点名那一格必须红", () => {
    // 五个变异方向里的第三个：其一 / 其二在下面那一组，其五在上面基线那一组，其四紧跟本格。
    probeBase();
    for (const e of SPECIMENS) {
      const mutated = readerWith(e.path, (src) => `${src}\n探针：${PROBE_SECOND_BATCH}\n`);
      const was = BASELINE.find((b) => b[0] === e.path);
      const row = census(mutated).find(([p]) => p === e.path);
      expect(row?.[1], `往 ${e.path} 末尾新写一个编号之后处数没涨 —— 这一份又被整份跳过了`)
        .toBe(was![1] + 1);
      const { grew } = ratchet(mutated);
      expect(grew.map((r) => r[0]),
        `往 ${e.path} 里新写一个编号，逐份点名那一格没红 —— 「整份不查」又回来了`)
        .toEqual([e.path]);
      expect(leaks(mutated)
        .filter((f) => f.startsWith(`${e.path}:`) && f.includes(`「${PROBE_SECOND_BATCH}」`)).length,
      `${e.path} 里新写的那一处没有出现在报文里`).toBe(1);
    }
  }, 60_000);

  it("🔴 该红时红（其四）：把标本集某一份清空 ⇒ 名册过期那一格与棘轮的「掉了」方向都红", () => {
    const family = secondBatch();
    for (const e of SPECIMENS) {
      const emptied = readerWith(e.path, () => "");
      expect(hitsIn(emptied, e.path, family.id),
        `${e.path} 清空之后还有命中 —— 探针写坏了`).toBe(0);
      // 判据侧读的就是这个数：它掉到 0，「真的有那一族的命中」那一格就红。
      expect(hitsIn(realFile, e.path, family.id) > 0 && hitsIn(emptied, e.path, family.id) === 0,
        `${e.path} 上「有那一族的命中 ⇒ 清空后零命中」这条差别不成立 —— 名册过期那一格挡不住任何东西`)
        .toBe(true);
      // 另一半：它在册，所以清空之后棘轮的「掉了」方向也必须红。
      expect(ratchet(emptied).shrank.map((r) => r[0]),
        `${e.path} 清空之后棘轮没红在「掉了」那个方向 —— 它多半没在基线里`).toEqual([e.path]);
    }
  }, 60_000);
});

describe("该红时红：往跟踪文件里塞一个内部标识符 ⇒ 点名文件与行号", () => {
  // ⚠️ 探针串一律**拼出来**，不写字面量（`PROBE_*` 那两个常量，理由写在它们头上）。
  const SECOND_BATCH = PROBE_SECOND_BATCH;
  const SECOND_BATCH_SHORT = PROBE_SECOND_BATCH_SHORT;

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
  }, 60_000);

  it("🔴 该红时红（其二）：往 `tests` 下的某份文件里写一个第二批字母的编号 ⇒ 必须红", () => {
    // 口径：`tests` 算在射程内。公开仓的读者读得到每一份测试文件。
    probeBase();
    const target = "tests/unit/version.test.ts";
    expect(SCOPE, `${target} 不在射程里 —— 「tests 算在射程内」这条口径就没落实`).toContain(target);
    const found = leaks(readerWith(target, (src) => `${src}\n// 探针：${SECOND_BATCH_SHORT}\n`));
    const mine = found.filter((f) => f.startsWith(`${target}:`));
    expect(mine.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
    expect(mine[0]).toContain(`「${SECOND_BATCH_SHORT}」`);
  }, 60_000);

  it("逐族认得出：各塞一个真串进同一份脚本 ⇒ 逐族点名", () => {
    probeBase();
    const target = "scripts/build-ui.mjs";
    expect(SCOPE, `${target} 不在射程里 —— 这一格的锚该更新`).toContain(target);
    const probes: ReadonlyArray<readonly [string, string]> = [
      ["阶段编号", "P" + "3c"],
      ["内部任务号", "Task" + " 6"],
      ["内部评审发现号（第一批字母）", "C" + "4b"],
      ["内部评审发现号（第二批字母）", "M" + "5"],
      ["内部评审发现号（第三批字母）", "D" + "4"],
      ["内部条目号（字母 + 连字号 + 字母）", "U" + "-B"],
      ["内部评审名", "全分支" + "评审"],
    ];
    expect(probes.map((p) => p[0]).sort(), "探针的族名与族表对不上 —— 有人增删了族，"
      + "而这一格还在按旧的那几族逐族验").toEqual(FAMILIES.map((f) => f.id).sort());
    for (const [id, evidence] of probes) {
      const found = leaks(readerWith(target, (src) => `${src}\n// 探针：${evidence}\n`));
      const mine = found.filter((f) => f.startsWith(`${target}:`));
      expect(mine.length, `「${evidence}」应当只红一条，实际：\n${mine.join("\n")}`).toBe(1);
      expect(mine[0], `没有点名族「${id}」`).toContain(id);
      expect(mine[0], `没有点名串「${evidence}」`).toContain(`「${evidence}」`);
    }
  }, 60_000);

  it("同一串里挨着的两个标识符各报一条 —— 零宽前后瞻，不许换成会吃边界的字符类", () => {
    // 与文档轴那一格同一个机制：把边界字符一起吃掉的写法会漏掉第二个。
    probeBase();
    const target = "scripts/check-i18n.mjs";
    const found = leaks(readerWith(target, (src) => `${src}\n// 探针：post-${"M" + "5"}/${"M" + "5b"}-fix\n`));
    const mine = found.filter((f) => f.startsWith(`${target}:`));
    expect(mine.length, `应当报两条，实际：\n${mine.join("\n")}`).toBe(2);
    expect(mine.filter((f) => f.includes(`「${"M" + "5b"}」`)),
      "没有单独点名后一个 —— 多半是有人把零宽前后瞻换成了会吃掉边界字符的字符类").toHaveLength(1);
  }, 60_000);
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
  }, 60_000);

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
  }, 60_000);

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
    ["连字号两侧的真词（两侧边界只排字母数字，而它们前后各被一个字母挡住）",
      `按 ${"UTF" + "-8"} 编码，走 ${"N" + "-API"} 扩展`],
  ];

  it.each(INNOCENT)("%s 不许被判成内部标识符", (_why, sentence) => {
    probeBase();
    const found = leaks(readerWith(target, (src) => `${src}\n// ${sentence}\n`));
    expect(found.filter((f) => f.startsWith(`${target}:`)),
      `这一句被误伤了：${sentence}\n${found.join("\n")}`).toEqual([]);
  }, 60_000);

  it("注释里出现「评审」两个字但不带发现号 —— 不许因此红", () => {
    probeBase();
    const found = leaks(readerWith(target, (src) => `${src}\n// 这笔账是评审要求主动给出的。\n`));
    expect(found.filter((f) => f.startsWith(`${target}:`)),
      `「评审」这个词本身被判成了泄漏：\n${found.join("\n")}`).toEqual([]);
  }, 60_000);
});

/**
 * ── 与文档轴那份判据不漂 ────────────────────────────────────────────────────
 * 本文件的六族是**继承**来的。继承来的东西会漂，而漂了没人会发现——
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

  it("文档轴今天登记着七族，本轴也是七族", () => {
    expect(docAxisEvidence().length, `${DOC_AXIS} 的族数变了 —— `
      + "确认新增/删除的那一族在源码轴上该不该有对应的一族").toBe(7);
    expect(FAMILIES.length, "本轴的族数变了").toBe(7);
  });

  it("🔴 文档轴登记的每一个证据串，本轴至少有一族认得出", () => {
    for (const evidence of docAxisEvidence()) {
      // ⚠️ `reOf()` 现造，**不许在共享的正则上 `test()`**：那会把 `lastIndex` 留在非零，
      //    而后面每一格走 `matchAll` 的扫描都会从那个偏移起扫。理由写在 `reOf()` 头上。
      const hit = FAMILIES.some((f) => reOf(f).test(evidence));
      expect(hit, `文档轴登记的证据串「${evidence}」本轴一族都认不出 —— 两轴漂了。`
        + "要么本轴少了一族，要么本轴某一族的形状被收窄了（下划线边界与不含 `H` 这两条"
        + "是**有意**的差别，文件头写着理由；除此之外的差别都该有人来确认）").toBe(true);
    }
  });

  it("本文件自己在射程里，且今天零命中 —— 判据不许给自己开后门", () => {
    // 判据自己写在射程里的文件上，而它一处命中都没有：所有探针串都是**拼出来**的。
    // 这一格红了，说明有人往本文件里写了字面的真串。
    // ⚠️ 它曾经因为另一个原因保持假绿：族表存带 `g` 的正则对象、被 `test()` 推过 `lastIndex`，
    //    于是本文件里真实存在的字面真串被整批漏掉。⇒ 见 `reOf()` 头上那段。
    const self = "tests/unit/source-internal-refs.test.ts";
    expect(trackedFiles(), `${self} 还没进 git —— 它不在射程里，本格验的是空气`).toContain(self);
    expect(SPECIMEN_PATHS.has(self), "本文件把自己列进了标本集").toBe(false);
    expect(BASELINE.map((b) => b[0]), "本文件进了基线 —— 那等于给自己登记了一笔欠账")
      .not.toContain(self);
    expect(leaks(realFile).filter((f) => f.startsWith(`${self}:`)),
      "本文件自己命中了 —— 探针串必须拼出来写，不许写字面量").toEqual([]);
  }, 60_000);
});
