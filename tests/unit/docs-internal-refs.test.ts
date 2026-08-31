/**
 * **出货文档不许留内部研发轨迹的标识符**（阶段编号 / 内部任务号 / 内部评审发现号）。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────────
 * 裁定 ㉚ 写的是「公开仓不暴露内部路线图与阶段编号」，而此前只有一条判据在守它，
 * 且那条判据的射程只有 `CHANGELOG.md` 一份。**其余 39 份出货文档一格都没人验过**
 * ——落地当天 `docs/{5 语言}/DEPLOY.md` 与 `docs/{5 语言}/SPONSORS.md` 共 11 份里
 * 一起带着 56 处 `P1`/`P2`/`P3`/`P3c`/`P3d`，随首个版本一路发到了公开仓。
 * 「有一条判据在守」和「那条判据看得见这份文档」是两件事，本文件补的是后者。
 *
 * ── 射程：44 份公开 markdown，从磁盘现算 ────────────────────────────────────
 * `publicDocs()` = 排版判官那 40 份（仓根全部 `.md` + `docs/{5 语言}` 下的 `.md`）
 * ＋ `admin-ui/README.md` ＋ `.github` 下（含子目录）全部 `.md`（今天 3 份）。
 * 都从磁盘现算 —— 新增一份文档会**自动**进射程，不用回来改这里。
 *
 * 🔴 **这里刻意不用 `shipDocs()`，理由必须写死在这里，不然下一个人还会接错。**
 * 第一版接的就是 `shipDocs()`，于是 `admin-ui/README.md` 一并落在射程外，
 * 而那份文档落在射程外的**唯一**依据是偏离名册第 17 条——那条登记的原文是
 *「移出 D4 的**排版**射程」，理由写的是「套 16 节骨架毫无意义」。
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

import { sep } from "node:path";

import { publicDocs, shipDocs } from "../helpers/ship-docs.js";

/**
 * 公开 markdown 全集（今天 44 份）。**从磁盘现算**。
 * 变量名刻意不叫 `SHIP_DOCS`：本文件的射程比排版轴那 40 份宽，名字一样会诱人接错真源。
 */
const PUBLIC_DOCS: readonly string[] = publicDocs();

/**
 * **登记在案的四族。每一族都必须是「今天真的泄漏过 / 真的有形状」的那一类**，
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
 *   真词。上面那一族因此只收 `C`/`I`/`Q`/`W` 四个字母——它们是本轮真泄漏过、
 *   且在这份文档集里没有同形真词的那四个。`F`/`M`/`T` 打头的发现号**今天 0 命中**，
 *   靠评审看着；哪天真泄漏了，是这条登记该被推翻的时候，不是它已经守住了。
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

describe("44 份公开 markdown 里一个内部标识符都没有（阶段编号 / 任务号 / 评审发现号）", () => {
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
    "四族逐族认得出：%s 的真串「%s」塞进 `docs/ja/DEPLOY.md` ⇒ 点名那一份",
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
});

describe("不乱红：形状像、意思不是的那几种，一处都不许命中", () => {
  // 每一条都写清「为什么它长得像」，否则下一个人会以为这张表是凑数的。
  const INNOCENT: ReadonlyArray<readonly [string, string]> = [
    ["音频格式 `MP3` 与点对点 `P2P`", "把音频转成 MP3，或者走 P2P 分发"],
    ["分位数 `P95` / `P99`", "延迟 P95 是 120ms，P99 是 300ms"],
    ["`IPv4` / `IPv6`", "同时监听 IPv4 与 IPv6"],
    ["徽章里的色值（不带 `#`，在 URL 里）", "badge/Cloudflare%20Workers-edge-F38020?style=flat"],
    ["另一枚徽章的色值", "badge/Hono-4.13-E36002?style=flat-square"],
    ["Cloudflare 的对象存储 `R2` 与数据库 `D1`", "把附件放 R2、把索引放 D1"],
    ["Apple 芯片 `M1` / `M2`（本仓 README 正在讲 arm64）", "在 M1 与 M2 上都验过 arm64 镜像"],
    ["「多阶段 Docker 构建」", "多阶段 Docker 构建、非 root 运行、多架构镜像"],
    ["`HTTP/2`、`H2` 与 `S3`", "上游走 HTTP/2；备份放 S3"],
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
