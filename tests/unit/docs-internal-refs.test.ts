/**
 * **出货文档不许留内部研发轨迹的标识符**（阶段编号 / 内部任务号 / 内部评审发现号 /
 * 内部条目号 / 内部评审名）。⚠️ 这一行是导读，**册子是下面的 `FAMILIES`**：
 * 收了新族要顺手补进来，别让这一行退化成一份漏项的名单。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────────
 * 裁定 ㉚ 写的是「公开仓不暴露内部路线图与阶段编号」，而此前只有一条判据在守它，
 * 且那条判据的射程只有 `CHANGELOG.md` 一份。**其余 39 份出货文档一格都没人验过**
 * ——落地当天 `docs/{5 语言}/DEPLOY.md` 与 `docs/{5 语言}/SPONSORS.md` 共 11 份里
 * 一起带着 56 处阶段编号，随首个版本一路发到了公开仓。
 * 「有一条判据在守」和「那条判据看得见这份文档」是两件事，本文件补的是后者。
 *
 * ── 射程：44 份公开 markdown，从磁盘现算 ────────────────────────────────────
 * `publicDocs()` = 排版判官那 40 份（仓根全部 `.md` + `docs/{5 语言}` 下的 `.md`）
 * ＋ `admin-ui/README.md` ＋ `.github` 下（含子目录）全部 `.md`（今天 3 份）。
 *
 * ⚠️ **「从磁盘现算」只在那几个根**之内**成立，别读成「新增一份文档一定会自动进射程」**
 *（这一版之前这里就是这么写的，而它是假的）：那几个根是**手抄**的，
 * 一个**新目录**下的 `.md` 谁也没在枚举它。实测：`examples/README.md` 里写一句带
 * 内部标识符的话，本文件全部用例照绿。这与本轮修掉的那条 Critical（射程接错了函数）
 * 是**同一种失效模式**——射程靠手抄，而不是从「读者读得到什么」这个真源推导出来。
 * ⇒ 下面「射程自守」那一组里多一格，拿 `git` 列出来的 markdown 全集**两个方向**对齐：
 * 多一份少一份都点名。今天两边都是那 44 份、零行为差异，
 * 这一格买的是**判据**：射程等于读者读得到的东西，从此不是巧合。
 *
 * 🔴 **这里刻意不用 `shipDocs()`，理由必须写死在这里，不然下一个人还会接错。**
 * 第一版接的就是 `shipDocs()`，于是 `admin-ui/README.md` 一并落在射程外，
 * 而那份文档落在射程外的**唯一**依据是偏离名册第 17 条——那条登记的原文是
 *「移出**排版**轴的射程」，理由写的是「套 16 节骨架毫无意义」。
 * **那是排版轴的豁免**。ADJ ㉚（公开仓不暴露内部路线图与阶段编号）是**另一根轴**，
 * 它一个字都没豁免过任何一份文档。接错射程 = 把一条排版豁免静静升级成泄漏豁免，
 * 而 `admin-ui/README.md` 确确实实是出货文档（`CHANGELOG.md` 正文直接把读者指过去，
 * `docs-parity.test.ts` 里那一组自己写着「第一个访客会看到的三份自述」）——
 * 实测：接 `shipDocs()` 的那一版，它里面 11 处阶段编号 / 任务号本判据一处都看不见。
 * ⇒ 泄漏轴走 `publicDocs()`，排版轴继续走 `shipDocs()`，
 * 两根轴各自一份射程；`docs-deviations.test.ts` 里另有一格钉住「第 17 条只豁免排版」。
 *
 * ⚠️ **不剥围栏、不剥 HTML 注释，全文扫**。排版轴的判据要剥（围栏里教人写 markdown
 * 的示例不该被当成正文），这一条恰恰相反：**围栏里的阶段编号照样是泄漏**，
 * 被整行包进 `<!-- -->` 的阶段编号在仓库里也照样读得到。剥了就等于给泄漏留了两个后门。
 *
 * ── 它验不了什么（明写，别读成「路线图从此不会泄漏」）──────────────────────
 * 它认的是**标识符的形状**，不是「这句话是不是在讲内部排期」。
 * 「这个能力我们下一版再做」这种**不带任何编号**的路线图陈述，本文件一格都不管
 * ——那只能靠评审。同理，它也不管一句话删掉编号之后**还通不通顺**：
 * 语义保全是改写者的事，机器只保证编号不再出现。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { sep } from "node:path";

import { publicDocs, shipDocs } from "../helpers/ship-docs.js";

/**
 * **仓里读者读得到的 markdown 全集，从 `git` 现列**——射程那一格的对照真源。
 *
 * ⚠️ **`--others --exclude-standard` 不是可选项，去掉它这一格就守不住它存在的理由。**
 * 只列 `--cached` 的话，一份**还没 `git add`** 的新文档 `git` 压根不认，
 * 而本格要抓的恰恰是「新建一个目录、往里放一份 `.md`」这个动作——
 * 实测的复现步骤里那份 `examples/README.md` 就是未跟踪的，
 * 只列已跟踪时这一格照绿，等于把判据摆在了它要防的那件事够不着的地方。
 * `--exclude-standard` 让 `.gitignore` 照常生效（`node_modules` 之类不会涌进来）。
 *
 * ⚠️ 空集不许静默通过：`git` 一份都没列出来时是**扫描坏了**，
 * 而一个恒等于空集的射程会让下面两个方向的比对同时变成「多出来的都是射程里那 44 份」，
 * 报文还长得像真的。⇒ 直接抛。
 */
function trackedMarkdown(): readonly string[] {
  const raw = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard",
    "--", "*.md"], { encoding: "utf8" });
  const files = raw.split("\0").filter(Boolean);
  if (files.length === 0) {
    throw new Error("`git ls-files -- '*.md'` 一份 markdown 都没列出来 —— 扫描坏了，不许静默当成空集");
  }
  return files.map((p) => p.split("/").join(sep)).sort();
}

/**
 * 公开 markdown 全集（今天 44 份）。**从磁盘现算**。
 * 变量名刻意不叫 `SHIP_DOCS`：本文件的射程比排版轴那 40 份宽，名字一样会诱人接错真源。
 */
const PUBLIC_DOCS: readonly string[] = publicDocs();

/**
 * **登记在案的这几族。每一族都必须是「今天真的泄漏过 / 真的有形状」的那一类**，
 * ⚠️ 这里刻意不写死族数：族表会随下一次收族变长，写死的那个数会当场变成假话
 * （它曾经写着一个比表里少两条的数，而没有任何一格盯着这句散文）。
 * 要族数就现数 `FAMILIES.length`；源码轴那份判据里有一格**真的断言**着两轴的族数。
 * 不是想象出来的。下面每一条的 `evidence` 就是它在本轮真被抓到的原串。
 *
 * ⚠️ **边界一律用「前后都不是 ASCII 字母数字」，不用 `\b`。**
 * ⚠️ **先说清一件差点被写成假话的事**：起草时这里写的理由是「`\b` 会漏掉 ko 的
 * `P3c부터`」——那是**用 Python 扫出来的结论，在 JS 上不成立**。JS 的 `\b` 只认
 * ASCII 词字符，谚文/汉字/假名一律算非词字符，所以 `P3c부터` 它认得出；改前的 40 份
 * 上 `\bP[1-9][a-z]?\b` 与本文件这条前后瞻实测**都是 56 处**，一处不差。
 * 拿别的语言的正则语义当本仓的实测结论，正是这个仓已经栽过很多次的那种假话。
 *
 * **JS 上真正的差别在下划线**：`\b` 把 `_` 当词字符，于是 markdown 的斜体写法
 * `_P3c_` 用 `\b` 版**认不出来**（实测 `false`），而前后瞻版认得出。文档里用
 * `_…_` 强调一个词是随手就会写出来的形态，一条挡不住它的判据等于留了个口子。
 * ⇒ 用前后瞻，并在下面留一格反向控制把这条差别钉死。
 */
const FAMILIES: ReadonlyArray<{
  readonly id: string;
  readonly what: string;
  readonly re: RegExp;
  readonly evidence: string;
}> = [
  {
    id: "阶段编号",
    what: "`P` + 一位数字 + 可选一个小写字母（P1 / P2 / P3 / P3c / P3d …）",
    // 字母类刻意是 `[a-z]` 而不是 `[abcde]`：本仓已经栽过一次「字符类罩不住它自己
    // 声称要罩的东西」——`P3[abcde]` 连 `P3f` 都对不上，拿 `P3f` 做变异会照绿。
    re: /(?<![0-9A-Za-z])P[1-9][a-z]?(?![0-9A-Za-z])/g,
    evidence: "P3c",
  },
  {
    id: "内部任务号",
    what: "`Task` + 数字（内部任务编号，读者手上没有这份任务表）",
    re: /(?<![0-9A-Za-z])Task[ 　]?[0-9]+(?![0-9A-Za-z])/g,
    evidence: "Task 6",
  },
  {
    id: "内部评审发现号",
    what: "`C` / `I` / `Q` / `W` + 一到两位数字 + 可选一个小写字母（C4 / C4b / I2 / W13 …）",
    // ⚠️ **数字刻意限死 1~2 位**：放开成 `[0-9]+` 会把六份 README 徽章里的色值
    // `F38020` / `E36002` 当成发现号（实测各 6 处、共 12 处假红）。
    re: /(?<![0-9A-Za-z])[CIQW][0-9]{1,2}[a-z]?(?![0-9A-Za-z])/g,
    evidence: "C4b",
  },
  {
    id: "内部评审发现号（第二批字母）",
    what: "`F` / `G` / `H` / `L` / `M` / `N` + 一到两位数字 + 可选一个小写字母（F3 / M14a / H1 / L4 …）",
    /*
     * ⚠️ **这一族与上面那四个字母不是一回事，收它的理由必须读完再改。**
     *
     * 上面那条登记（下面「刻意不收的两族」那段）当初否掉的是
     * **`[A-Z]` + 数字这个通用形状**，理由是 `R2` / `D1` / `S3` / `M1` / `M2` 全是真词。
     * 那条否定今天仍然成立——本族**没有**放开成 `[A-Z]`，它是一个逐字母挑出来的子集，
     * 而 `R`/`D`/`S`（`R2` / `D1` / `S3` 那三个真词的首字母）**本族**一个都没收。
     *（`R` 与 `D` 后来随第三批字母那一族收了进去，代价逐条登记在那一族的注释里。
     * 那是另一族的账，与本族的形状无关。）
     * 唯一被继承下来的同形真词是 `M1`/`M2`（Apple 芯片），下面
     * `KNOWN_FALSE_POSITIVES` 那张表把它连同出路一起登记着，并且有一格钉住它**真的会咬**。
     *
     * **为什么现在收：** 旧登记写的是「这几个字母打头的发现号今天 0 命中，靠评审看着」。
     * 「今天 0 命中」这一半今天仍然为真（落地当天实测：44 份公开 markdown 里本族**零命中**，
     * 所以这一族落地当天不多抓一处、也不多红一处）；
     * **而「靠评审看着」那一半，是本仓反复证伪过的一种守法**——同一批标识符
     * 在**非 markdown 的跟踪文件**里今天有**上千处**（落地当天全仓实测），
     * 它们没走到那 44 份里靠的是时序，不是任何一条性质。
     * 一族真实存在、形状明确、只是还没跨过那道门的标识符，不该等它跨过去之后才立判据。
     *
     * ⚠️ **本文件的射程按定义看不见那上千处**：它只扫 `publicDocs()` 那 44 份 markdown。
     * 清掉源码注释里的那一批、以及「用什么判据钉住它不回潮」，是**另一根轴**上的事，
     * 与本族收不收无关。别把这一族读成「那批已经有人管了」。
     *
     * 数字同样限死 1~2 位，理由与上面那族逐字相同，而**在本族更吃紧**：
     * 六份 README 徽章里的色值 `F38020` 就是 `F` 打头的，放开成 `[0-9]+` 会当场假红。
     * 下面 `INNOCENT` 那张表里有一格拿真串钉着它今天不红。
     */
    re: /(?<![0-9A-Za-z])[FGHLMN][0-9]{1,2}[a-z]?(?![0-9A-Za-z])/g,
    evidence: "M5",
  },
  {
    id: "内部评审发现号（第三批字母）",
    what: "`A` / `B` / `D` / `O` / `R` / `U` / `V` / `X` + 一到两位数字 + 可选一个小写字母",
    /*
     * ⚠️ **这一族收的正是上面那条登记里点名放走过的几个字母，读完再改。**
     *
     * **旧登记为什么放走它们：** 理由写的是「`R2` / `D1` / `S3` 全是真词」。
     * 那半句今天仍然为真——真词是真的存在，代价也是真的。
     * **被推翻的是「所以这些字母打头的一律不收」这个结论。**
     * 同一批字母打头的内部发现号在**非 markdown 的跟踪文件**里今天有**几百处**
     *（落地当天全仓实测），公开仓的 `git log` 里也一个字母不缺；
     * 它们没走到那 44 份里靠的是时序，不是任何一条性质。
     * 这与第二批字母那一族收编时的理由逐字相同。
     *
     * ⚠️ **代价没法靠正则消掉，只能具名登记。** `R2`（Cloudflare 对象存储）、
     * `D1`（同一家的数据库）、`V8`（JS 引擎）与本族的发现号**逐字节相同**——
     * 分位数 `P95` 那一类靠「一位数字」的形状就消掉了，这一类**形状上分不开**。
     * ⇒ 出路只有两条：改写那句话（首选），或者回来给一条**具名**登记。
     * 下面 `KNOWN_FALSE_POSITIVES` 里那**两条**就是这么来的（产品名那一对一条、
     * 引擎名一条），每一条都有一格钉住它**真的会咬**。
     * ⚠️ 引擎名那一条是**补上的**：这段话原先点了它的名，那张表里却没有它。
     * 一个「注释说登记了、表里没有」的真词，正是这张表悄悄变成摆设的第一步。
     * **别为了绕开它去凑一条分得开的正则**——凑出来的只会是一族分不开的假绿。
     *
     * ⚠️ **`S` 没有收进来**：`S3` 是真词，而本仓今天拿不出一个 `S` 打头的发现号真串。
     * **宁可漏收，不许凭想象扩族**（`T` 那条登记也是这么处置的）。
     * `A` / `B` / `O` / `U` / `X` 今天在跟踪文件里一处命中都没有，收它们靠的是
     * 公开 `git log` 里那批真串，不是想象。
     * ⚠️ **`Q` 不在本族**：它早就在第一批字母里了，写进来等于同一个形状登记两遍。
     */
    re: /(?<![0-9A-Za-z])[ABDORUVX][0-9]{1,2}[a-z]?(?![0-9A-Za-z])/g,
    evidence: "D4",
  },
  {
    id: "内部条目号（字母 + 连字号 + 字母）",
    what: "一个大写字母 + `-` + 一个大写字母或数字（内部待验证清单与变异编号的写法）",
    /*
     * ⚠️ **这是本轮之前谁都没见过的形状，上面每一族都抓不到它。**
     * 上面几族认的都是「字母紧跟数字」，而这一批内部条目号中间**隔着一个连字号**，
     * 于是它们从每一族底下整批溜了过去：落地当天全仓实测，跟踪文件里**上百处**，
     * 公开 `git log` 里几十处。**形状明确、真串成批，只是从来没人给它立过族。**
     *
     * ⚠️ **两侧边界照旧只排 ASCII 字母数字，不排连字号**：排掉连字号会把
     * `post-M-5` 这种真串的前一半挡在外面（实测少认一处）。
     * `UTF-8` / `N-API` 这类真词不靠连字号边界活着——它们靠的是**同一条**字母数字
     * 边界（`UTF-8` 的 `F` 前面是 `T`，`N-API` 的 `A` 后面是 `P`）。
     *
     * ⚠️ 剩下**分不开**的同形真词只有正则字符类那一种（`[A-Z]` 这个写法本身），
     * 同样具名登记在 `KNOWN_FALSE_POSITIVES` 里，并有一格钉住它真的会咬。
     */
    re: /(?<![0-9A-Za-z])[A-Z]-[A-Z0-9](?![0-9A-Za-z])/g,
    evidence: "U-B",
  },
  {
    id: "内部评审名",
    what: "五种语言里「全分支评审」那个词组（它后面跟的就是发现号）",
    re: /全分支评审|全分支評審|全ブランチレビュー|full-branch review|전체 브랜치 리뷰/gi,
    evidence: "全分支评审",
  },
];

/**
 * ── 刻意**不收**的两族，连同否掉它们的实测证据一起登记 ──────────────────────
 * 登记在这里而不是删掉，是为了让下一个想「顺手收紧一下」的人先读到实测结果。
 *
 * · **`阶段 <数字/大写字母>`**：六份 README 里的「多**阶段** **D**ocker 构建」
 *   （zh-CN / zh-TW / 仓根三份写的就是这五个字）会当场假红。中文里「阶段」是个
 *   日常词，它后面跟什么完全由句子决定，形状上分不出内部排期与技术名词。
 * · **`[A-Z]` + 数字 的通用发现号**：`R2`（Cloudflare 对象存储）、`D1`（Cloudflare
 *   数据库）、`S3`、`M1`/`M2`（Apple 芯片，而本仓 README 正在讲 arm64 镜像）全都是
 *   真词。**这一条今天仍然成立，发现号那三族都不是 `[A-Z]`**，而是逐字母挑出来的
 *   三个子集：`C`/`I`/`Q`/`W`、`F`/`G`/`H`/`L`/`M`/`N` 与 `A`/`B`/`D`/`O`/`R`/`U`/`V`/`X`。
 *   ⚠️ **这一条里有半句本轮被推翻了**：旧版写的是「`R`/`D`/`S` 一个都没进来」。
 *   `R` 与 `D` 随第三批字母那一族进来了——放走它们的从来不是一条性质，只是时序；
 *   代价（`R2` / `D1` / `V8` 这类逐字节同形的真词）具名登记在
 *   `KNOWN_FALSE_POSITIVES` 里。`S` 仍然没进来，理由写在那一族的注释里。
 *
 * ⚠️ **这段话里有一条登记本轮被推翻了，推翻的理由写在这里，别照着旧版读。**
 * 旧版写的是「`F`/`M`/`T` 打头的发现号今天 0 命中，**靠评审看着**；
 * 哪天真泄漏了，是这条登记该被推翻的时候，不是它已经守住了」。
 * · 「今天 0 命中」这一半**今天仍然为真**：落地当天实测，44 份公开 markdown 里
 *   `F`/`G`/`H`/`L`/`M`/`N` 那一族**零命中**，收它一处新的都没抓到、一处假红也没有。
 * · 被推翻的是**「靠评审看着」**那一半。同一批标识符在**非 markdown 的跟踪文件**里
 *   今天有**上千处**（落地当天全仓实测）——它们没走到那 44 份里靠的是时序，
 *   不是任何一条性质，而「靠评审看着」正是本仓反复证伪过的守法。
 *   ⇒ 不等它跨过门再立判据。代价（`M1`/`M2` 这类同形真词）逐条登记在
 *   `KNOWN_FALSE_POSITIVES` 里，每一条都有一格钉着它**真的会咬**，不是嘴上说说。
 * · `T` 打头的**没有**收进来：本仓今天拿不出 `T` 打头发现号的真串，
 *   而 `T3`（Tier-3）这类同形真词随手就写得出。**宁可漏收，不许凭想象扩族。**
 */

/** 一份文档的文本。判据与探针共用同一个读法，两边口径不许各写一套。 */
type DocReader = (path: string) => string;

const realDoc: DocReader = (path) => readFileSync(path, "utf8");

/** 逐份逐行扫，命中就出一条带 `文件:行号` 的报文。 */
function leaks(read: DocReader, docs: readonly string[] = PUBLIC_DOCS): string[] {
  const out: string[] = [];
  for (const path of docs) {
    const lines = read(path).split("\n");
    for (const family of FAMILIES) {
      for (const [i, line] of lines.entries()) {
        for (const hit of line.matchAll(family.re)) {
          out.push(
            `${path}:${i + 1} 留着一个${family.id}「${hit[0]}」：${line.trim().slice(0, 60)}`,
          );
        }
      }
    }
  }
  return out.sort();
}

/** 把某一份的内容换掉，其余照读磁盘。变异探针一律走这个口子，不动真文件。 */
const readerWith = (target: string, mutate: (src: string) => string): DocReader =>
  (path) => (path === target ? mutate(realDoc(path)) : realDoc(path));

/**
 * 探针的基：真的 44 份今天必须过判据。
 * 否则探针红了会被读成「探针有问题」，而真因在文档。
 */
function probeBase(): void {
  const base = leaks(realDoc);
  if (base.length > 0) {
    throw new Error(
      "本格是探针，它的基取自真的 44 份公开 markdown，而真文档今天本身就不过判据 —— "
      + "别从这一格的报文里找原因，真因在「44 份公开 markdown 里一个内部标识符都没有」那一格：\n"
      + base.join("\n"),
    );
  }
}

describe("射程自守：44 份公开 markdown，逐份读得到", () => {
  it("射程是从磁盘现算的 44 份，且每一份都真的读得到", () => {
    expect(PUBLIC_DOCS.length,
      `公开 markdown 从 44 份变成了 ${PUBLIC_DOCS.length} 份 —— 数变了就该有人来确认`
      + "新增/删除的那一份该不该进射程").toBe(44);
    expect(PUBLIC_DOCS.filter((p) => !existsSync(p)), "射程里有读不到的文件").toEqual([]);
  });

  /**
   * 🔴 **射程 = 仓里读者读得到的 markdown 全集。两个方向都查，多一份少一份都点名。**
   *
   * ── 它补的是哪个洞 ────────────────────────────────────────────────────────
   * `publicDocs()` 是从**三个手抄的根**枚举出来的（仓根 / `docs` 五语言 /
   * `admin-ui/README.md` / `.github`）。三个根之内确实是现算的，
   * 而**新建目录一个人都没在管**：实测 `mkdir examples` 再往
   * `examples/README.md` 里写一句带内部标识符的话，本文件全部用例照绿——
   * 一份读者点得开的文档，带着内部研发轨迹，从判据底下整份溜了过去。
   *
   * ⚠️ **这与本轮那条 Critical（泄漏轴接了排版轴的射程）是同一种失效模式**，
   * 不是两件事：**射程靠手抄，而不是从「读者读得到什么」这个真源推导**。
   * 上一条的表现是漏了一份具体文档，这一条的表现是漏了一整个还没被建出来的目录；
   * 成因一模一样，所以处置也该一样——把真源换成机器算得出的那一份。
   *
   * ⚠️ **今天零行为差异**：两边都是那 44 份，一份不差（落地当天实测）。
   * 这一格买的不是「今天多抓到几处」，是**判据**：
   * 「射程恰好等于读者读得到的东西」从一个巧合变成一条会变红的断言。
   * 保留枚举而不是直接改用 `git` 的输出，是因为 `shipDocs()` 那 40 份还被排版轴与
   * 偏离名册第 17 条按份数钉着，两根轴的射程今天必须各是各的。
   */
  it("🔴 射程恰好等于 `git` 列出来的 markdown 全集 —— 新建目录下的 `.md` 不许溜过去", () => {
    const tracked = trackedMarkdown();
    const scope = [...PUBLIC_DOCS].sort();
    expect(tracked.filter((p) => !scope.includes(p)),
      "仓里有读者读得到的 markdown 落在射程外 —— 多半是新建了一个目录，"
      + "而 `publicDocs()` 那三个根是手抄的、谁也没在枚举新目录。"
      + "把它接进射程（或说明白它为什么不算读者读得到的东西）").toEqual([]);
    expect(scope.filter((p) => !tracked.includes(p)),
      "射程里有 `git` 不认的 markdown —— 要么文件被删了没同步射程，要么它被 `.gitignore` 排除，"
      + "而一份推不上去的文档不该占着泄漏轴的射程").toEqual([]);
    expect(scope, "两个方向单独看都对、合起来却不相等 —— 比对写坏了").toEqual([...tracked]);
  });

  it("射程盖住仓根与五个语言目录，不是只盯着 `CHANGELOG.md` 那一份", () => {
    // 这一格钉的正是本文件的立法理由：老判据只看 `CHANGELOG.md`，
    // 于是 `docs/**` 那 35 份带着 56 处阶段编号一路发到了公开仓。
    expect(PUBLIC_DOCS).toContain("CHANGELOG.md");
    for (const lang of ["zh-CN", "zh-TW", "en", "ja", "ko"]) {
      for (const base of ["DEPLOY.md", "SPONSORS.md"]) {
        expect(PUBLIC_DOCS, `${lang}/${base} 不在射程里`).toContain(`docs/${lang}/${base}`);
      }
    }
  });

  it("🔴 泄漏轴的射程比排版轴宽出的正是那 4 份：面板自述 + `.github` 三份社区模板", () => {
    // 这一格钉的是本轮那条 Critical：第一版把泄漏轴挂在了 `shipDocs()` 上，
    // 于是 `admin-ui/README.md` 借着**排版轴**的豁免（名册第 17 条）一并逃出泄漏轴，
    // 而它当时真的带着 11 处阶段编号 / 任务号躺在公开仓里。
    // 两个方向都查：宽出来的必须恰好是这 4 份（多了要有人来确认），
    // 且这 4 份确实不在排版轴那份射程里（不然第 17 条就自己不成立了）。
    const extra = PUBLIC_DOCS.filter((p) => !shipDocs().includes(p));
    expect([...extra].sort(), "泄漏轴比排版轴宽出来的不是那 4 份 —— 谁动了射程").toEqual([
      ".github/ISSUE_TEMPLATE/bug_report.md",
      ".github/ISSUE_TEMPLATE/feature_request.md",
      ".github/pull_request_template.md",
      "admin-ui/README.md",
    ].map((p) => p.split("/").join(sep)));
    expect(shipDocs().length, "排版轴那份射程不再是 40 份 —— 名册第 17 条那两格会先红").toBe(40);
  });
});

describe("44 份公开 markdown 里一个内部标识符都没有（阶段编号 / 任务号 / 发现号 / 条目号 / 评审名）", () => {
  it("真扫描：零命中", () => {
    const found = leaks(realDoc);
    expect(found, `出货文档里还留着内部研发轨迹的标识符：\n${found.join("\n")}\n`
      + "**不要靠删整句了事** —— 这些编号所在的句子都在讲一件真事，"
      + "要把编号换成读者用得上的说法（「较新的能力」「那次修复之后」），"
      + "或者确认那条「什么时候加的」对读者无用之后再删。").toEqual([]);
  });
});

describe("该红时红：往任一份公开 markdown 塞一个内部标识符 ⇒ 只红一条并点名那一份那一行", () => {
  it.each([...PUBLIC_DOCS])("%s 末尾塞一句带 `P3c` 的话", (target) => {
    probeBase();
    const found = leaks(readerWith(target, (src) => `${src}\n\nP3c 起这条路径才有。\n`));
    expect(found.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
    expect(found[0]).toContain(target);
    expect(found[0]).toContain("P3c");
  });

  it.each(FAMILIES.map((f) => [f.id, f.evidence] as const))(
    "逐族认得出：%s 的真串「%s」塞进 `docs/ja/DEPLOY.md` ⇒ 点名那一份",
    (_id, evidence) => {
      probeBase();
      const target = "docs/ja/DEPLOY.md";
      const found = leaks(readerWith(target, (src) => `${src}\n\n${evidence} —— 这一句是探针。\n`));
      expect(found.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
      expect(found[0]).toContain(target);
      expect(found[0]).toContain(evidence);
    },
  );

  it("行号点得准：塞在第 3 行就报第 3 行，不是报整份文件", () => {
    probeBase();
    const target = "SPONSORS.md";
    const found = leaks(readerWith(target, (src) => {
      const lines = src.split("\n");
      lines.splice(2, 0, "这一行是探针，它带一个 P2。");
      return lines.join("\n");
    }));
    expect(found.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
    expect(found[0]).toContain("SPONSORS.md:3 ");
  });

  it("围栏里的阶段编号照样红 —— 本文件不剥围栏，剥了就是给泄漏留后门", () => {
    probeBase();
    const target = "docs/en/DEPLOY.md";
    const found = leaks(readerWith(target, (src) => `${src}\n\n\`\`\`bash\n# P3c only\n\`\`\`\n`));
    expect(found.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
    expect(found[0]).toContain("P3c");
  });

  it("HTML 注释里的阶段编号照样红 —— GitHub 上看不见，仓库里读得到", () => {
    probeBase();
    const target = "docs/ko/DEPLOY.md";
    const found = leaks(readerWith(target, (src) => `${src}\n\n<!-- P3d 再补 -->\n`));
    expect(found.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
    expect(found[0]).toContain("P3d");
  });

  it("编号后面直接跟谚文（`P3c부터`）也认得出 —— ko 那一份原文就是这个形状", () => {
    probeBase();
    const target = "docs/ko/SPONSORS.md";
    const found = leaks(readerWith(target, (src) => `${src}\n\nP3c부터 지원합니다.\n`));
    expect(found.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
    expect(found[0]).toContain("P3c");
  });

  it("markdown 斜体包起来的 `_P3c_` 也认得出 —— 这是不用 `\\b` 的那条真理由", () => {
    probeBase();
    const target = "docs/en/SPONSORS.md";
    const found = leaks(readerWith(target, (src) => `${src}\n\nOnly in _P3c_.\n`));
    expect(found.length, `应当只红一条，实际：\n${found.join("\n")}`).toBe(1);
    expect(found[0]).toContain("P3c");
    // 反向把差别钉死：`\b` 版在 JS 上**认不出** `_P3c_`（`_` 被它当词字符）。
    // 这一格不是在测正则库，是在保证「以后有人把边界改回 `\b`」时有东西会红，
    // 顺带保证文件头那段说明不会在某次改动后静静变假。
    expect(/\bP[1-9][a-z]?\b/.test("Only in _P3c_."), "`\\b` 版认出了 `_P3c_` —— "
      + "文件头那段「JS 上真正的差别在下划线」的说明就该被推翻，回去重新实测").toBe(false);
    expect(/\bP[1-9][a-z]?\b/.test("P3c부터 지원합니다."), "`\\b` 版认不出 `P3c부터` —— "
      + "文件头那段「JS 的 `\\b` 只认 ASCII 词字符，谚文这一处它认得出」的说明就该被推翻").toBe(true);
  });

  /**
   * 🔴 **同一串里挨着的两个标识符，必须**各报一条**。**
   *
   * 这不是想出来的边界，是本仓真的数错过一次的**那个机制**：清理那一批时的处数是用
   * `grep -oE '[^0-9A-Za-z]…[^0-9A-Za-z]'` 这种**把边界字符一起吃掉**的写法数出来的
   *（前后各配一个「非字母数字」的字符类，而不是零宽的前后瞻）。
   * 落到 `post-C4/C4b-fix` 这种真串上：第一次匹配吃掉了 `C4` 后面那个 `/`，
   * 而 `C4b` 前面本来就靠那个 `/` 当边界 —— 于是**下一次匹配再也起不来**，`C4b` 整个被漏掉。
   * 实测：改前那 40 份里 `C4b` 真有 10 处，吃边界的写法只数到 5 处。
   * 提交标题里那个「91 处」就是这么来的（本判据口径实测是 116 处，
   * 差额与分解登记在 `scripts/prepush.sh` 那段来源注释里）。
   *
   * 本文件各族用的是**零宽前后瞻**，天然没有这个毛病；这一格把「没有这个毛病」钉死，
   * 免得哪天有人图省事把前后瞻换回字符类，判据又开始少报而没人知道。
   */
  it("🔴 同一串里挨着的两个标识符各报一条（`C4/C4b` / `P3c Task 1`）—— 数错那 25 处的机制就在这里", () => {
    probeBase();
    const target = "docs/zh-TW/DEPLOY.md";

    const twoFindings = leaks(readerWith(target,
      (src) => `${src}\n\n這一行是探針：post-C4/C4b-fix 的實測數字。\n`));
    expect(twoFindings.length,
      `\`C4/C4b\` 应当报两条（\`C4\` 与 \`C4b\` 各一条），实际：\n${twoFindings.join("\n")}`).toBe(2);
    expect(twoFindings.filter((f) => f.includes("「C4」")), "没有单独点名 `C4` 的那一条").toHaveLength(1);
    expect(twoFindings.filter((f) => f.includes("「C4b」")), "没有单独点名 `C4b` 的那一条 —— "
      + "多半是有人把零宽前后瞻换成了会吃掉边界字符的字符类，`C4b` 前面那个 `/` 被上一次匹配吃掉了")
      .toHaveLength(1);

    // 跨族的同一种形态：一族的匹配吃掉分隔的空格，另一族就跟着瞎。
    const crossFamily = leaks(readerWith(target,
      (src) => `${src}\n\n這一行是探針：P3c Task 1 起才有。\n`));
    expect(crossFamily.length,
      `\`P3c Task 1\` 应当报两条（阶段编号 + 任务号），实际：\n${crossFamily.join("\n")}`).toBe(2);
    expect(crossFamily.filter((f) => f.includes("「P3c」")), "没有点名阶段编号 `P3c`").toHaveLength(1);
    expect(crossFamily.filter((f) => f.includes("「Task 1」")), "没有点名任务号 `Task 1`").toHaveLength(1);

    // ⚠️ 反向控制：把「吃边界」那种写法拿过来跑同一串，它**必须只数到一个**。
    // 这一条不是在测正则库，是在保证上面那段注释讲的机制今天仍然成立——
    // 哪天它也数到两个，说明这段来源说明该重新实测，而不是继续照抄。
    const eatsBoundary = /[^0-9A-Za-z][CIQW][0-9]{1,2}[a-z]?[^0-9A-Za-z]/g;
    expect([..."post-C4/C4b-fix".matchAll(eatsBoundary)].length,
      "吃边界的写法居然也数到了两个 —— 文件里那段「91 是这么数错的」说明就该被推翻，回去重新实测")
      .toBe(1);
  });
});

describe("不乱红：形状像、意思不是的那几种，一处都不许命中", () => {
  // 每一条都写清「为什么它长得像」，否则下一个人会以为这张表是凑数的。
  const INNOCENT: ReadonlyArray<readonly [string, string]> = [
    ["音频格式 `MP3` 与点对点 `P2P`", "把音频转成 MP3，或者走 P2P 分发"],
    ["分位数 `P95` / `P99`", "延迟 P95 是 120ms，P99 是 300ms"],
    ["`IPv4` / `IPv6`", "同时监听 IPv4 与 IPv6"],
    ["徽章里的色值（不带 `#`，在 URL 里）", "badge/Cloudflare%20Workers-edge-F38020?style=flat"],
    ["另一枚徽章的色值", "badge/Hono-4.13-E36002?style=flat-square"],
    ["`UTF-8` 与 `N-API`（连字号两侧被字母数字边界挡住）", "按 UTF-8 编码，走 N-API 扩展"],
    ["「多阶段 Docker 构建」", "多阶段 Docker 构建、非 root 运行、多架构镜像"],
    ["`HTTP/2`、`H2` 与 `S3`（`HTTP/2` 里 `P` 后面跟的是斜杠，不是数字）", "上游走 HTTP/2；备份放 S3"],
    // ↓ 三条是随「第二批字母」那一族一起收编的。它们全靠**「一到两位数字」+ 后瞻**
    //   这两条边界活着，而那一族里 `F` / `H` / `L` 恰好是它们的首字母 ⇒ 边界一松就假红。
    ["GPU 型号 `H100` / `L40S`（三位数字，被「一到两位」那条挡住）", "在 H100 与 L40S 上都跑过"],
    ["固态盘规格 `M.2`（`M` 后面是点号，不是数字）", "换成 M.2 固态盘之后快了一倍"],
    ["架构名 `amd64` / `arm64`（数字前面是字母，被前瞻挡住）", "多架构镜像：amd64 与 arm64"],
  ];

  it.each(INNOCENT)("%s 不许被判成内部标识符", (_why, sentence) => {
    probeBase();
    const target = "docs/zh-CN/README.md";
    const found = leaks(readerWith(target, (src) => `${src}\n\n${sentence}\n`));
    expect(found, `这一句被误伤了：${sentence}\n${found.join("\n")}`).toEqual([]);
  });

  it("正文里出现「评审」两个字但不带发现号 —— 不许因此红", () => {
    probeBase();
    const target = "docs/zh-CN/DEPLOY.md";
    const found = leaks(readerWith(target, (src) => `${src}\n\n这份账是评审要求主动给出的。\n`));
    expect(found, `「评审」这个词本身被判成了泄漏：\n${found.join("\n")}`).toEqual([]);
  });
});

/**
 * ── 登记在案的**误报面**：本判据确实会咬到的真词，连同「为什么仍然收」与出路 ────
 *
 * 这张表管的是**带同形真词的那几族**：第二批字母（`F`/`G`/`H`/`L`/`M`/`N`）、
 * 第三批字母、以及字母 + 连字号 + 字母那一族。头四个字母那一族没有同形真词，
 * 一条都不在这里。⚠️ 这段话原先只讲第二批字母那一族——后两族收编时补了行、
 * 没补这段说明，于是它开始把「这张表只为一族服务」讲成事实。
 * 这张表把每一个已知的同形真词写下来，并且**拿探针钉住它真的会咬**
 * ——这不是「大概会误报吧」的散文，是可执行的代价清单。
 *
 * 🔴 **别把这张表读成「所以这几族该删掉」**，三条理由缺一不可，都是实测：
 * ① **今天代价为零**：44 份公开 markdown 里这几族**零命中**，下面每一句都是**构造**的，
 *    没有一句真的写在任何一份公开文档里（落地当天逐份实测）。
 * ② **收益不为零**：同一批标识符在非 markdown 的跟踪文件里今天有**上千处**，
 *    它们没走到那 44 份里靠的是时序，不是任何一条性质。
 * ③ **误报有出路，漏报没有**：踩到下面任何一条时，改写一句话就行（每条都给了写法），
 *    而漏掉一处真泄漏是推上公开仓之后才发现的。
 *
 * ⚠️ **哪天这几句里有一句真的要写进公开文档**，出路按顺序是：
 * ① 照第三列改写（首选，读者读着也更清楚）；
 * ② 真改不动，就回来给一条**具名**豁免（写清是哪一份文档的哪一句），
 *    **不是**把那一族整族删掉，也**不是**把边界放宽。
 * 这一格红了不等于判据坏了——先分清是踩到了登记在案的哪一条，还是真的漏了一处。
 */
describe("登记在案的误报面：这几族确实会咬到的真词，代价写死在这里", () => {
  const KNOWN_FALSE_POSITIVES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    [
      "Apple 芯片 `M1` / `M2` —— 出路：写成「Apple 芯片（M 系列）」",
      "在 M1 与 M2 上都验过 arm64 镜像",
      ["M1", "M2"],
    ],
    [
      "HTML 标题层级 `H1` / `H2` —— 出路：markdown 里本来就该写 `##` / `###`",
      "这一节用 H2，下一级用 H3",
      ["H2", "H3"],
    ],
    [
      "网络分层 `L4` / `L7` —— 出路：写成「传输层 / 应用层」",
      "在 L4 转发，不做 L7 解析",
      ["L4", "L7"],
    ],
    [
      "功能键 `F1` —— 出路：写成「帮助键」；本仓今天根本没有键盘帮助这一说",
      "按 F1 打开帮助",
      ["F1"],
    ],
    [
      "Cloudflare 的对象存储 `R2` 与数据库 `D1` —— 出路：写成「对象存储 / 边缘数据库」",
      "把附件放 R2、把索引放 D1",
      ["D1", "R2"],
    ],
    [
      "JS 引擎 `V8` —— 出路：写成「JavaScript 引擎」（读者也不必先知道引擎叫什么）",
      "堆上限交给 V8 自己决定",
      ["V8"],
    ],
    [
      "正则里的字符类 `[A-Z]` —— 出路：写成「全部大写字母」，出货文档本来就不该贴正则",
      "抽取用的字符类写的是 [A-Z] 那一种",
      ["A-Z"],
    ],
  ];

  it.each(KNOWN_FALSE_POSITIVES)("%s", (why, sentence, expected) => {
    probeBase();
    const target = "docs/zh-CN/README.md";
    const found = leaks(readerWith(target, (src) => `${src}\n\n${sentence}\n`));
    expect(found.length, `这一条登记的是「会咬」，而它今天没咬 —— 要么有人把这一族的边界放宽/收窄了，`
      + `要么这条登记该更新。别直接删掉它：${why}\n${found.join("\n")}`).toBe(expected.length);
    for (const hit of expected) {
      expect(found.filter((f) => f.includes(`「${hit}」`)),
        `没有单独点名 \`${hit}\` 的那一条`).toHaveLength(1);
    }
  });

  it("🔴 这张表登记的每一句，今天都不在任何一份公开文档里 —— 代价确确实实是零", () => {
    // 这一格是上面那三条理由里的第 ①：**「今天代价为零」不许是一句散文**。
    // 少了它，这张表可以在某份文档真的写了「在 M1 上验过」之后照旧全绿
    //（那一句会被「真扫描：零命中」抓住，但没人会回来更新这张表的说明）。
    const bodies = new Map(PUBLIC_DOCS.map((p) => [p, realDoc(p)] as const));
    for (const [why, sentence] of KNOWN_FALSE_POSITIVES) {
      const hits = [...bodies].filter(([, body]) => body.includes(sentence)).map(([p]) => p);
      expect(hits, `这一句已经真的写进公开文档了，上面那句「今天代价为零」就成了假话：`
        + `${why}\n出现在：${hits.join(" / ")}`).toEqual([]);
    }
  });
});
