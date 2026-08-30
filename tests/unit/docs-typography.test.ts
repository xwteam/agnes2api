/**
 * P3f 阶段 7D —— **排版轴判官**（W92a / W92b）。
 *
 * ── 为什么单独一个文件，不塞进 `tests/unit/docs-parity.test.ts` ────────────────
 * 那份已经 11346 行，而且它守的是**对等轴**（五语言之间、文档与源码之间）。
 * 排版轴是另一件事：它守的是「这份文档长什么样」。两轴合成一步的坏处与
 * `scripts/check-i18n.mjs:9-12` 立法时说的一模一样 —— **一条红会被另一条红盖住**，
 * 读日志的人只看得见第一个失败，剩下的要修完再跑一轮才浮出来。
 *
 * ── 两批启用，不是一批（X3 / O7 / Q17）────────────────────────────────────
 * · **W92a**（与阶段 7 的改写无关，本文件上半）：R20/P1–P4、R22f/g、R24、R25a–e、R28。
 * · **W92b**（依赖阶段 7 的成果，本文件下半）：R20/P5、R21、R23'、R26。
 *   R25f 在阶段 7A 就随 W97 落进了 `tests/unit/docs-parity.test.ts`（两格：真扫描 +
 *   「给一个 `##` 加 emoji 必须红」），**本文件不重复实现**，只在 R25 那一组的注释里
 *   写明它住在哪儿。
 *   R22a/b/c/d/e/e2 同理：W116 / W117 / W103 三组已经在那份文件里跑着，
 *   本文件只补它没覆盖的 **f（必填列）** 与 **g（无默认值的写法）**。
 *
 * ── 口径（一次写清，下面每一格都按这个来）────────────────────────────────
 * · **射程**：出货文档 40 份 = 仓根 5 份 + `docs/{5 语言}/{7 份}`。**从磁盘现算**。
 *   不含 `.github/**`（3 份）与 `admin-ui/README.md`（1 份）—— 后者是 Q15 的
 *   具名裁定，登记在偏离名册第 17 条。
 * · **先剥围栏**：以 ``` 起头的行做开关，围栏定界行本身也剥掉。
 *   围栏里教人写 markdown 的示例不进任何一格的射程。
 * · **字符数**一律 `String.length`（`docs-parity.test.ts` 里 R22b 用的「显示宽度」
 *   是另一把尺，两者在 CJK 上差一倍，谁也不能顶替谁 —— ADJ ㊾）。
 *
 * ── 它整体验不了什么 ──────────────────────────────────────────────────────
 * 一份文档**写得好不好**。本文件全部是形态判据：alert 在不在该在的位置、
 * 标题之间有多长、表格的必填格是不是二值。**alert 选的类型贴不贴合语义（N7）、
 * 一句风险陈述写得全不全、译文地不地道，机器一格都不管。**
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { SECTIONS, SECTION_LANGS } from "../helpers/readme-sections.js";

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
type Lang = (typeof LANGS)[number];

/** 非 README 的五类文档。**这 25 份是阶段 7 的射程铁律所在**。 */
const NON_README_DOCS = ["ADMIN", "API", "DEPLOY", "REGISTRAR", "USAGE"] as const;

/** 出货文档全集（40 份）。**从磁盘现算**，新增一份文档会自动进射程。 */
const SHIP_DOCS: readonly string[] = (() => {
  const rootDocs = readdirSync(".").filter((f) => f.endsWith(".md")).sort();
  const langDocs = LANGS.flatMap((lang) =>
    readdirSync(join("docs", lang)).filter((f) => f.endsWith(".md")).sort()
      .map((f) => join("docs", lang, f)));
  return [...rootDocs, ...langDocs];
})();

const SIX_READMES: readonly string[] = ["README.md", ...LANGS.map((l) => join("docs", l, "README.md"))];
const SIX_SPONSORS: readonly string[] = ["SPONSORS.md", ...LANGS.map((l) => join("docs", l, "SPONSORS.md"))];
const NON_25: readonly string[] =
  LANGS.flatMap((l) => NON_README_DOCS.map((d) => join("docs", l, `${d}.md`)));

/** 社区文件：`---` 走 ADJ ⑮（只判「≥1 条」），不套 README 那套恒等式（C28）。 */
const COMMUNITY_MD: readonly string[] = [
  "SECURITY.md",
  "CONTRIBUTING.md",
  join(".github", "pull_request_template.md"),
  join(".github", "ISSUE_TEMPLATE", "bug_report.md"),
  join(".github", "ISSUE_TEMPLATE", "feature_request.md"),
];

type Doc = readonly [path: string, text: string];
const pairsOf = (paths: readonly string[]): readonly Doc[] =>
  paths.map((p) => [p, readFileSync(p, "utf8")] as const);

/** 把某一份换成变异过的文本，其余原样 —— 反向控制的公共夹具。 */
const withMutation = (docs: readonly Doc[], path: string, mutate: (s: string) => string): readonly Doc[] =>
  docs.map(([p, t]) => (p === path ? [p, mutate(t)] as const : [p, t] as const));

const FENCE_LINE = /^[ \t]*```/;

/** 剥围栏后的正文行（1-based 行号跟着原文走）。 */
const bodyLines = (text: string): ReadonlyArray<{ line: string; no: number }> => {
  let inFence = false;
  const out: Array<{ line: string; no: number }> = [];
  text.split("\n").forEach((line, i) => {
    if (FENCE_LINE.test(line)) { inFence = !inFence; return; }
    if (!inFence) out.push({ line, no: i + 1 });
  });
  return out;
};

/**
 * emoji 谓词 —— §1.3(e) 固化的那一条，与 `docs-parity.test.ts` 里 R25f 用的
 * **逐字符相同**。
 *
 * ⚠️ **必须含 BMP 那一段**：窄义 `[\u{1F300}-\u{1FAFF}]` 会让 `⚡⚙⚠☕⭐` 全部漏网，
 * 而 README 那 16 个 emoji 标题用的正是这一族 —— 用窄义的话 R25a 会整条塌陷
 * （16 节里有 5 节的 emoji 在 BMP，判据会说「这些标题没有 emoji」）。
 */
const EMOJI = /[←-⇿⌀-⏿■-➿⬀-⯿️\u{1F000}-\u{1FAFF}]/u;

/** 一行标题的 emoji（`## ` 之后第一个 token）。取不到返回空串。 */
const headingEmoji = (line: string): string => {
  const token = line.replace(/^#{1,6} /, "").split(" ")[0] ?? "";
  return EMOJI.test(token) ? token : "";
};

/** 一份文档按 `##` 切成小节：`[标题行, 该节正文行]`。首个 `##` 之前的内容不进任何节。 */
type Section = { readonly title: string; readonly body: ReadonlyArray<{ line: string; no: number }> };
const sectionsOf = (text: string): readonly Section[] => {
  const out: Array<{ title: string; body: Array<{ line: string; no: number }> }> = [];
  for (const r of bodyLines(text)) {
    if (/^## /.test(r.line)) out.push({ title: r.line.trim(), body: [] });
    else out[out.length - 1]?.body.push(r);
  }
  return out;
};

/** `##` 之前的头部区（徽章块 / 导航块 / 警示带都在这儿）。 */
const headOf = (text: string): ReadonlyArray<{ line: string; no: number }> => {
  const out: Array<{ line: string; no: number }> = [];
  for (const r of bodyLines(text)) {
    if (/^## /.test(r.line)) break;
    out.push(r);
  }
  return out;
};

/**
 * 取某一节的**原文**（含围栏定界行）—— 从标题行到下一个 `## ` 之前。
 * 需要看「这一节里有没有围栏」的格子只能用它：`bodyLines()` 把 ``` 行剥掉了。
 */
const rawSection = (text: string, title: string): string => {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() === title);
  if (i < 0) throw new Error(`取不到「${title}」这一节`);
  const rest = lines.slice(i + 1);
  const j = rest.findIndex((l) => /^## /.test(l));
  return (j < 0 ? rest : rest.slice(0, j)).join("\n");
};

/** 按下标取 README 的某一节 —— 顺序由 `SECTIONS` 常量表定，不靠字面 grep。 */
const sectionAt = (text: string, path: string, idx: number): Section => {
  const lang: Lang | "root" = path === "README.md" ? "root" : (path.split("/")[1] as Lang);
  const wanted = SECTIONS[idx]?.title[lang === "root" ? "zh-CN" : lang] ?? "";
  const hit = sectionsOf(text).find((s) => s.title === wanted);
  if (hit === undefined) {
    throw new Error(`${path} 里找不到 SECTIONS[${idx}]「${wanted}」—— 骨架变了，`
      + "本组的按下标取节整片失效，先去 R11 那边确认骨架，不许在这里改成字面 grep");
  }
  return hit;
};

/* ══════════════════════════════════════════════════════════════════════════
 * W92a —— 与阶段 7 改写无关的那一批
 * ══════════════════════════════════════════════════════════════════════════ */

describe("W92a 射程自守：40 份出货文档、逐份读得到，分组不重不漏", () => {
  it("射程 40 份，且 README/SPONSORS/非 README 三组加起来正好盖住 `docs/` 那 35 份", () => {
    expect(SHIP_DOCS.length, `出货文档从 40 份变成了 ${SHIP_DOCS.length} 份 —— 射程是从磁盘现算的，`
      + "数变了就该有人来确认新增/删除的那份该不该进射程（ADJ §67 裁的就是这个数）")
      .toBe(40);
    expect(SHIP_DOCS.filter((p) => !existsSync(p)), "射程里有读不到的文件").toEqual([]);
    const grouped = new Set([...SIX_READMES, ...SIX_SPONSORS, ...NON_25]);
    const langDocs = SHIP_DOCS.filter((p) => p.startsWith("docs"));
    expect(langDocs.filter((p) => !grouped.has(p)),
      "`docs/` 下有文档不属于 README / SPONSORS / 非 README 三组中的任何一组 —— "
      + "本文件每一格都按组取射程，漏一份就是漏一整份文档没人守").toEqual([]);
    expect([SIX_READMES.length, SIX_SPONSORS.length, NON_25.length]).toEqual([6, 6, 25]);
  });

  it("社区文件五条路径都在（P4④ 与偏离名册第 18 条共用这份清单）", () => {
    expect(COMMUNITY_MD.filter((p) => !existsSync(p)), "社区文件缺了").toEqual([]);
  });
});

/* ── R20/P1 —— alert 的语义位置 ────────────────────────────────────────────
 * 判「在哪儿、恰几个」，不判「一共几个」。灌水到别处不加分，灌水到本节会超出恰好。
 * **它验不了什么**：那一条 alert 选的 TYPE 贴不贴合语义（N7）；也不管全仓 alert 总数。
 * ────────────────────────────────────────────────────────────────────────── */

/** 一段正文里以 `> [!TYPE]` 起头的块，返回 TYPE 序列。 */
const alertTypes = (rows: ReadonlyArray<{ line: string }>): string[] =>
  rows.flatMap((r) => {
    const m = /^> \[!([A-Z]+)\]/.exec(r.line);
    return m === null ? [] : [m[1] as string];
  });

describe("R20/P1 alert 的语义位置：头部恰 4 块、系统要求节末恰 1 条 TIP、接入示例节首恰 1 条 NOTE", () => {
  it("① 六份 README 的头部警示带恰 4 块，类型序列逐份 `toEqual` NOTE/WARNING/TIP/IMPORTANT", () => {
    const wrong = pairsOf(SIX_READMES).flatMap(([p, t]) => {
      const seq = alertTypes(headOf(t));
      return seq.join(",") === "NOTE,WARNING,TIP,IMPORTANT" ? [] : [`${p}: ${seq.join(",") || "（一块都没有）"}`];
    });
    expect(wrong, `头部警示带的类型序列不对：\n${wrong.join("\n")}\n`
      + "四块的顺序是模板形态（R12 守的是同一件事，这里守的是它在 `##` 之前）").toEqual([]);
  });

  it("② 六份 README 的 `## 📋 系统要求` 节里恰 1 条 `> [!TIP]`，且它是该节最后一个内容块", () => {
    const wrong = pairsOf(SIX_READMES).flatMap(([p, t]) => {
      const sec = sectionAt(t, p, 3);
      const types = alertTypes(sec.body);
      const meaningful = sec.body.filter((r) => r.line.trim() !== "" && r.line.trim() !== "---");
      const tail = meaningful[meaningful.length - 1]?.line ?? "";
      const bad: string[] = [];
      if (types.join(",") !== "TIP") bad.push(`alert 序列是 ${types.join(",") || "空"}，该是恰一条 TIP`);
      if (!tail.startsWith(">")) bad.push(`节末不是那条 TIP，而是：${tail.slice(0, 40)}`);
      return bad.length === 0 ? [] : [`${p}: ${bad.join("；")}`];
    });
    expect(wrong, `系统要求节的 TIP 位置不对：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("③ 六份 README 的 `## 🧪 接入示例` 节里恰 1 条 `> [!NOTE]`，且它是该节第一个内容块", () => {
    const wrong = pairsOf(SIX_READMES).flatMap(([p, t]) => {
      const sec = sectionAt(t, p, 5);
      const types = alertTypes(sec.body);
      const head = sec.body.find((r) => r.line.trim() !== "")?.line ?? "";
      const bad: string[] = [];
      if (types.join(",") !== "NOTE") bad.push(`alert 序列是 ${types.join(",") || "空"}，该是恰一条 NOTE`);
      if (!head.startsWith("> [!NOTE]")) bad.push(`节首不是那条 NOTE，而是：${head.slice(0, 40)}`);
      return bad.length === 0 ? [] : [`${p}: ${bad.join("；")}`];
    });
    expect(wrong, `接入示例节的 NOTE 位置不对：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("④ 六份 SPONSORS.md 与 CHANGELOG.md 的 alert 数恒为 0（两仓 12+2 份 100% 如此）", () => {
    const wrong = pairsOf([...SIX_SPONSORS, "CHANGELOG.md"]).flatMap(([p, t]) => {
      const n = alertTypes(bodyLines(t)).length;
      return n === 0 ? [] : [`${p} 有 ${n} 条 alert`];
    });
    expect(wrong, `这两类文档不放 alert 块：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("该红时红：把系统要求节的 TIP 挪到节首 —— ② 红并点名那一份", () => {
    const target = "README.md";
    const src = readFileSync(target, "utf8");
    const sec = sectionAt(src, target, 3);
    const tip = sec.body.filter((r) => r.line.startsWith(">")).map((r) => r.line).join("\n");
    expect(tip, "夹具取不到那条 TIP").toContain("[!TIP]");
    const moved = src.replace(`${tip}\n`, "").replace(sec.title, `${sec.title}\n\n${tip}`);
    expect(moved, "变异没落地").not.toEqual(src);
    const s2 = sectionAt(moved, target, 3);
    const meaningful = s2.body.filter((r) => r.line.trim() !== "" && r.line.trim() !== "---");
    expect(meaningful[meaningful.length - 1]?.line.startsWith(">"),
      "TIP 挪到节首之后「节末是 TIP」这一格居然还成立 —— 那这一格判的不是位置").toBe(false);
  });

  it("该红时红：往 `docs/ja/SPONSORS.md` 塞一条 alert —— ④ 红并点名它", () => {
    const target = join("docs", "ja", "SPONSORS.md");
    const docs = withMutation(pairsOf([...SIX_SPONSORS, "CHANGELOG.md"]), target,
      (s) => `${s}\n> [!NOTE]\n> 灌一条水。\n`);
    const wrong = docs.flatMap(([p, t]) => (alertTypes(bodyLines(t)).length === 0 ? [] : [p]));
    expect(wrong, "SPONSORS 里多出来的 alert 没被抓到").toEqual([target]);
  });

  it("不许乱红：围栏里教人写 `> [!NOTE]` 的示例不算 alert 块", () => {
    const fenced = "# X\n\n一句话。\n\n```markdown\n> [!NOTE]\n> 这是教程里的示例\n```\n";
    expect(alertTypes(bodyLines(fenced)), "剥围栏没生效 —— 围栏里的示例被当成了真 alert").toEqual([]);
  });
});

/* ── R20/P2 —— `<details>` 的位置与数量 ───────────────────────────────────
 * 非 README 那一半（恰 5 处 + 五条路径白名单）在 `tests/unit/docs-parity.test.ts` 的
 * 「W98 `### 配额账` 的折叠与分层」组里跑着（`DETAILS_ALLOWLIST` 双向钉死），
 * 本组只补 README 这一半。
 * ────────────────────────────────────────────────────────────────────────── */

describe("R20/P2 `<details>` 的位置与数量（README 这一半）", () => {
  const SUMMARY_ROOT = "<summary><b>点击展开完整端点列表</b></summary>";

  it("① 根 README 的 `## 📡 API 端点` 节恰 1 个 `<details>`，summary 逐字命中模板", () => {
    const sec = sectionAt(readFileSync("README.md", "utf8"), "README.md", 6);
    const text = sec.body.map((r) => r.line).join("\n");
    expect((text.match(/<details/g) ?? []).length, "根 README 的端点节不是恰 1 个折叠块").toBe(1);
    expect(text, `summary 不是模板那句：期望 ${SUMMARY_ROOT}`).toContain(SUMMARY_ROOT);
  });

  it("② 五份语言版 README 的同一节 0 个 `<details>`（C8 平局裁决，登记在名册第 19 条）", () => {
    const wrong = LANGS.flatMap((lang) => {
      const p = join("docs", lang, "README.md");
      const sec = sectionAt(readFileSync(p, "utf8"), p, 6);
      const n = (sec.body.map((r) => r.line).join("\n").match(/<details/g) ?? []).length;
      return n === 0 ? [] : [`${p} 有 ${n} 个`];
    });
    expect(wrong, `语言版的端点节不折叠 —— 这是 K/G 分歧处的平局裁决（kiro 的 en/ja/ko 三份是折叠的），`
      + `不是模板铁律，改它先去改名册第 19 条：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("③ 六份 README 的 `## 🧪 接入示例` 节：`<details>` 数 == `<summary><b>` 数 == 6", () => {
    const wrong = pairsOf(SIX_READMES).flatMap(([p, t]) => {
      const text = sectionAt(t, p, 5).body.map((r) => r.line).join("\n");
      const d = (text.match(/<details/g) ?? []).length;
      const s = (text.match(/<summary><b>/g) ?? []).length;
      return d === 6 && s === 6 ? [] : [`${p}: details ${d} / summary ${s}`];
    });
    expect(wrong, `接入示例节的六个折叠块对不上：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("该红时红：给 `docs/ko/README.md` 的端点节加一个折叠块 —— ② 红并点名它", () => {
    const p = join("docs", "ko", "README.md");
    const src = readFileSync(p, "utf8");
    const sec = sectionAt(src, p, 6);
    const mutated = src.replace(sec.title, `${sec.title}\n\n<details>\n<summary><b>x</b></summary>\n\n</details>`);
    expect(mutated, "变异没落地").not.toEqual(src);
    const n = (sectionAt(mutated, p, 6).body.map((r) => r.line).join("\n").match(/<details/g) ?? []).length;
    expect(n, "语言版端点节多出来的折叠块没被抓到").toBe(1);
  });
});

/* ── R20/P3 —— 表格的位置 ────────────────────────────────────────────────── */

describe("R20/P3 表格只许出现在指定的四节，且全仓零 HTML `<table>`", () => {
  /** README 里允许出表的四节下标（`SECTIONS` 的下标，不是字面名）。 */
  const TABLE_SECTIONS_ROOT = [0, 3, 6, 7] as const;

  it("六份 README 的表格只出现在「最近更新 / 系统要求 / API 端点 / 配置说明」四节", () => {
    const wrong = pairsOf(SIX_READMES).flatMap(([p, t]) => {
      const allowed = new Set(TABLE_SECTIONS_ROOT.map((i) => sectionAt(t, p, i).title));
      return sectionsOf(t).flatMap((s) => {
        const rows = s.body.filter((r) => r.line.trim().startsWith("|")).length;
        return rows > 0 && !allowed.has(s.title) ? [`${p} 的「${s.title}」里有 ${rows} 行表格`] : [];
      });
    });
    expect(wrong, `表格跑到了不该有表的节里：\n${wrong.join("\n")}\n`
      + "（模板的四节之外一律不放表；要放先去改 §1.2 的骨架裁定）").toEqual([]);
  });

  it("40 份出货文档里 HTML `<table>` 恒为 0（两仓实测 0）—— 堵掉「用 HTML 表绕过位置判据」", () => {
    const wrong = pairsOf(SHIP_DOCS).flatMap(([p, t]) => {
      const hits = bodyLines(t).filter((r) => /<table[\s>]/i.test(r.line));
      return hits.map((r) => `${p}:${r.no}`);
    });
    expect(wrong, `出现了 HTML 表格：\n${wrong.join("\n")}\n`
      + "位置判据只数「竖线开头的行」，HTML 表对它零命中 —— 所以这一条必须单独存在").toEqual([]);
  });

  it("该红时红：往根 README 的 `## 🌟 核心功能` 里塞一张 markdown 表 —— 位置判据点名那一节", () => {
    const src = readFileSync("README.md", "utf8");
    const sec = sectionAt(src, "README.md", 1);
    const mutated = src.replace(sec.title, `${sec.title}\n\n| a | b |\n|------|------|\n| 1 | 2 |`);
    const allowed = new Set(TABLE_SECTIONS_ROOT.map((i) => sectionAt(mutated, "README.md", i).title));
    const wrong = sectionsOf(mutated).flatMap((s) =>
      (s.body.some((r) => r.line.trim().startsWith("|")) && !allowed.has(s.title) ? [s.title] : []));
    expect(wrong, "核心功能里塞进去的表没被抓到").toEqual([sec.title]);
  });

  it("该红时红：同一处改用 HTML `<table>` —— 位置判据看不见它，`<table>` 那一格必须红", () => {
    const src = readFileSync("README.md", "utf8");
    const sec = sectionAt(src, "README.md", 1);
    const mutated = src.replace(sec.title, `${sec.title}\n\n<table><tr><td>1</td></tr></table>`);
    const allowed = new Set(TABLE_SECTIONS_ROOT.map((i) => sectionAt(mutated, "README.md", i).title));
    const byPipe = sectionsOf(mutated).flatMap((s) =>
      (s.body.some((r) => r.line.trim().startsWith("|")) && !allowed.has(s.title) ? [s.title] : []));
    expect(byPipe, "HTML 表居然被「竖线开头」的口径抓到了 —— 那本格的立论就不成立了").toEqual([]);
    expect(bodyLines(mutated).filter((r) => /<table[\s>]/i.test(r.line)).length,
      "HTML 表没被 `<table>` 那一格抓到").toBe(1);
  });
});

/* ── R20/P4 —— 分隔线的位置 ──────────────────────────────────────────────── */

/** 一份文档里 `^---$`（严格整行）的行号，以及「紧贴在 `##` 之前」的那几条。 */
const hrScan = (text: string) => {
  const rows = bodyLines(text);
  const hr = rows.filter((r) => r.line === "---");
  const h2 = rows.map((r, i) => [r, i] as const).filter(([r]) => /^## /.test(r.line));
  const before = h2.filter(([, i]) =>
    rows.slice(Math.max(0, i - 2), i).some((r) => r.line === "---"));
  return { hr: hr.map((r) => r.no), h2: h2.length, beforeH2: before.length };
};

describe("R20/P4 分隔线的位置（README / SPONSORS / 25 份 / 社区文件四档，剥围栏后统计）", () => {
  it("① 六份 README：`hr-before-h2` 100%，`^---$` 总数 == 节数 + 2", () => {
    const wrong = pairsOf(SIX_READMES).flatMap(([p, t]) => {
      const s = hrScan(t);
      const bad: string[] = [];
      if (s.beforeH2 !== s.h2) bad.push(`${s.h2} 个 \`##\` 里只有 ${s.beforeH2} 个前面有 \`---\``);
      if (s.hr.length !== s.h2 + 2) bad.push(`\`---\` 有 ${s.hr.length} 条，该是 ${s.h2 + 2}（节数 + 2）`);
      return bad.length === 0 ? [] : [`${p}: ${bad.join("；")}`];
    });
    expect(wrong, `README 的分隔线纪律破了：\n${wrong.join("\n")}\n`
      + "（+2 = 头部块之后一条 + 页脚之前一条）").toEqual([]);
  });

  it("② 六份 SPONSORS.md：`hr-before-h2` 100%，`^---$` 总数 == 节数（**不是** 节数 + 2，C30）", () => {
    const wrong = pairsOf(SIX_SPONSORS).flatMap(([p, t]) => {
      const s = hrScan(t);
      return s.beforeH2 === s.h2 && s.hr.length === s.h2
        ? [] : [`${p}: \`---\` ${s.hr.length} 条 / \`##\` ${s.h2} 个 / 贴在 \`##\` 前的 ${s.beforeH2} 条`];
    });
    expect(wrong, `SPONSORS 的分隔线纪律破了：\n${wrong.join("\n")}\n`
      + "⚠️ 第 1 版的公式（节数 + 2）会**要求**往头尾各加一条，与两仓实测相反").toEqual([]);
  });

  it("③ 25 份非 README 的那一档由 `docs-parity.test.ts` 的 W97 组守着 —— 这里只做交接控制", () => {
    // 那一组判的是「`hr-before-h2` 恒为 0 且 `^---$` ≤1 条、位置在最后一个 `##` 之后」。
    // 本格不重复实现它，只钉住**今天这 25 份确实是那个形态**，
    // 免得两边同时被改坏而谁都不吭声。
    const wrong = pairsOf(NON_25).flatMap(([p, t]) => {
      const s = hrScan(t);
      return s.beforeH2 === 0 && s.hr.length <= 1 ? [] : [`${p}: ${s.hr.length} 条 / 贴 \`##\` 前 ${s.beforeH2} 条`];
    });
    expect(wrong, `25 份非 README 的 \`---\` 形态变了：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("④ 社区文件五份：只判「各有 ≥1 条 `---`」，不套上面任何一条（ADJ ⑮ / C28）", () => {
    const wrong = pairsOf(COMMUNITY_MD).flatMap(([p, t]) =>
      (bodyLines(t).some((r) => r.line === "---") ? [] : [p]));
    expect(wrong, `社区文件里一条 \`---\` 都没有：\n${wrong.join("\n")}\n`
      + "（这一档刻意不套 `hr-before-h2`：两份 issue 模板整份没有 `##`，套了会恒真）").toEqual([]);
  });

  it("该红时红：从 `docs/en/README.md` 删掉一条 `---` —— ① 红并报出差了几条", () => {
    const p = join("docs", "en", "README.md");
    const src = readFileSync(p, "utf8");
    const mutated = src.replace("\n---\n", "\n");
    expect(mutated, "变异没落地").not.toEqual(src);
    const s = hrScan(mutated);
    expect(s.hr.length, "删掉一条之后总数居然没变").toBe(s.h2 + 1);
  });

  it("该红时红：往 `docs/ja/SPONSORS.md` 头尾各加一条 `---` —— ② 红（第 1 版的公式反而会要求加）", () => {
    const p = join("docs", "ja", "SPONSORS.md");
    const src = readFileSync(p, "utf8");
    const s0 = hrScan(src);
    const s1 = hrScan(`---\n${src}\n---\n`);
    expect(s0.hr.length, "起点就不是「== 节数」").toBe(s0.h2);
    expect(s1.hr.length, "加了两条之后总数没变 —— 那这一格测不出东西").toBe(s0.h2 + 2);
    expect(s1.hr.length === s1.h2, "加完之后 ② 居然还成立").toBe(false);
  });
});

/* ── R22f/g —— 表格里的二值格与「无默认值」的写法 ──────────────────────────
 * R22 的 a/b/c/d/e/e2 六条已经在 `docs-parity.test.ts` 的 W116 / W117 / W103 三组里
 * 跑着，本组只补那三组没覆盖的两条。
 * ────────────────────────────────────────────────────────────────────────── */

/** 表头里含某一列名的表，逐张返回该列的全部数据格。 */
const columnCells = (text: string, headerRe: RegExp): ReadonlyArray<{ no: number; value: string }> => {
  const rows = bodyLines(text);
  const SEP = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
  const cells: Array<{ no: number; value: string }> = [];
  rows.forEach((r, i) => {
    if (!SEP.test(r.line)) return;
    const head = rows[i - 1]?.line ?? "";
    if (!head.trim().startsWith("|")) return;
    const cut = (l: string) => l.trim().slice(1, -1).split("|").map((c) => c.trim());
    const k = cut(head).findIndex((c) => headerRe.test(c));
    if (k < 0) return;
    for (let j = i + 1; j < rows.length; j++) {
      const line = rows[j]?.line ?? "";
      if (!line.trim().startsWith("|")) break;
      const cs = cut(line);
      cells.push({ no: rows[j]?.no ?? 0, value: cs[k] ?? "<缺格>" });
    }
  });
  return cells;
};

const REQUIRED_HEAD = /必填|必須|必需|Required|필수/;
const YES_NO = new Set(["是", "否", "Yes", "No", "はい", "いいえ", "예", "아니오"]);

describe("R22f/g 必填列是二值格、无默认值写全角破折号", () => {
  it("f-① 六份 README 的配置表：必填列每一格是 `✅` 或 `❌` 二选一", () => {
    const wrong = pairsOf(SIX_READMES).flatMap(([p, t]) =>
      columnCells(t, REQUIRED_HEAD).filter((c) => c.value !== "✅" && c.value !== "❌")
        .map((c) => `${p}:${c.no} 必填格是「${c.value}」`));
    expect(wrong, `README 配置表的必填列不是二值：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("f-② 五份 API.md 的参数表：必填列写「是/否」的五语言译法，**出现 `✅`/`❌` 即红**（C26）", () => {
    const wrong = LANGS.flatMap((lang) => {
      const p = join("docs", lang, "API.md");
      return columnCells(readFileSync(p, "utf8"), REQUIRED_HEAD)
        .filter((c) => !YES_NO.has(c.value))
        .map((c) => `${p}:${c.no} 必填格是「${c.value}」`);
    });
    expect(wrong, `API 参数表的必填列不是「是/否」：\n${wrong.join("\n")}\n`
      + "（C26：参数表用文字、配置表用勾叉，两类刻意分开）").toEqual([]);
  });

  it("g 全部出货文档：默认值列不许留空、不许 `N/A`、不许半角 `-`；无默认值一律全角 `—`", () => {
    const DEFAULT_HEAD = /默认值|預設值|Default|既定値|기본값/;
    const wrong = pairsOf(SHIP_DOCS).flatMap(([p, t]) =>
      columnCells(t, DEFAULT_HEAD)
        .filter((c) => c.value === "" || c.value === "-" || /^n\/a$/i.test(c.value) || c.value === "<缺格>")
        .map((c) => `${p}:${c.no} 默认值格是「${c.value}」`));
    expect(wrong, `默认值列出现了留空 / N/A / 半角短横：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("该红时红：把 `docs/ko/API.md` 某个参数表的必填格改成 `✅` —— f-② 红并点名行号", () => {
    const p = join("docs", "ko", "API.md");
    const src = readFileSync(p, "utf8");
    const mutated = src.replace("| 예 |", "| ✅ |");
    expect(mutated, "变异没落地").not.toEqual(src);
    const wrong = columnCells(mutated, REQUIRED_HEAD).filter((c) => !YES_NO.has(c.value));
    expect(wrong.length, "参数表里混进来的 `✅` 没被抓到").toBeGreaterThan(0);
  });

  it("该红时红：把根 README 配置表的某个必填格写成「是」—— f-① 红", () => {
    const src = readFileSync("README.md", "utf8");
    const mutated = src.replace("| ✅ |", "| 是 |");
    expect(mutated, "变异没落地").not.toEqual(src);
    const wrong = columnCells(mutated, REQUIRED_HEAD).filter((c) => c.value !== "✅" && c.value !== "❌");
    expect(wrong.length, "配置表里混进来的「是」没被抓到").toBe(1);
  });
});

/* ── R24 —— 代码围栏与强调（守住已达标项，只设上限）────────────────────── */

/**
 * **只取开围栏**的语言标注。
 *
 * 🔴 7C 踩过的坑，写在这里给后面的人：把每一条 ``` 行都算一格的实现（闭合行恒为空串）
 * 拿去算「语言标注率」，会得出「每份文档都有一半围栏没标语言」这种**恒红的假话**——
 * 因为闭合行本来就不该带语言。判语言标注率**必须**只数开围栏。
 */
const openFences = (text: string): string[] => {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (!FENCE_LINE.test(line)) continue;
    if (!inFence) out.push(/^[ \t]*```(\S*)/.exec(line)?.[1] ?? "");
    inFence = !inFence;
  }
  return out;
};

describe("R24 代码围栏与强调", () => {
  it("a 围栏语言标注率 ≥ 94%（K 94% / G 95%；agnes 已超出，本格守住不回退）", () => {
    const all = pairsOf(SHIP_DOCS).flatMap(([, t]) => openFences(t));
    const tagged = all.filter((x) => x !== "").length;
    expect(all.length, "一个围栏都没数到 —— 多半是开围栏识别写坏了").toBeGreaterThan(600);
    const rate = (100 * tagged) / all.length;
    expect(rate, `围栏语言标注率掉到了 ${rate.toFixed(2)}%（${tagged}/${all.length}）`)
      .toBeGreaterThanOrEqual(94);
  });

  it("b 未标语言的围栏只许出现在根 README 的技术架构与项目结构两节，**且两节各恰 1 个**", () => {
    const bare = pairsOf(SHIP_DOCS).flatMap(([p, t]) =>
      openFences(t).filter((x) => x === "").map(() => p));
    expect(bare, "未标语言的围栏跑到了别处（或数量不对）—— "
      + "ASCII 图刻意不标语言是为了不让高亮器上色，别的地方没有这个理由")
      .toEqual(["README.md", "README.md"]);
    // 存在性那一半：把 ASCII 图整个删掉会让 a 升到 100%、b 空真为真，两条一起绿。
    // ⚠️ 这里必须读**原文**：`bodyLines()` 把围栏定界行本身也剥掉了，
    // 拿它去找「有没有围栏」永远是 0。
    for (const idx of [2, 9]) {
      const title = SECTIONS[idx]?.title["zh-CN"] ?? "";
      const raw = rawSection(readFileSync("README.md", "utf8"), title);
      expect(openFences(raw), `SECTIONS[${idx}]「${title}」里不是恰一段未标语言的围栏`).toEqual([""]);
    }
  });

  it("c 五份 DEPLOY.md 各有 ≥5 段 ```env 围栏", () => {
    const wrong = LANGS.flatMap((lang) => {
      const p = join("docs", lang, "DEPLOY.md");
      const n = openFences(readFileSync(p, "utf8")).filter((x) => x === "env").length;
      return n >= 5 ? [] : [`${p} 只有 ${n} 段`];
    });
    expect(wrong, `\`\`\`env 围栏不够：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("e 加粗密度上限 40 处/100 行（不是下限：「太简单」说的不是行内强调不够）", () => {
    const wrong = pairsOf(SHIP_DOCS).flatMap(([p, t]) => {
      const rows = bodyLines(t);
      const bold = rows.reduce((n, r) => n + (r.line.match(/\*\*[^*]+\*\*/g) ?? []).length, 0);
      const d = (100 * bold) / Math.max(rows.length, 1);
      return d > 40 ? [`${p}: ${d.toFixed(1)} 处/100 行`] : [];
    });
    expect(wrong, `加粗密度超过 40 处/100 行：\n${wrong.join("\n")}\n`
      + "（40 = 两倍于 kiro 的 17.0；超过它才是真的滥用）").toEqual([]);
  });

  it("g `<details>` 结构：每个配一个 `<summary><b>`，`</summary>` 后与 `</details>` 前各有空行", () => {
    const wrong = pairsOf(SHIP_DOCS).flatMap(([p, t]) => {
      const bad: string[] = [];
      const d = (t.match(/<details/g) ?? []).length;
      const s = (t.match(/<summary><b>/g) ?? []).length;
      if (d !== s) bad.push(`${p}: details ${d} 个 / \`<summary><b>\` ${s} 个`);
      const lines = t.split("\n");
      lines.forEach((l, i) => {
        if (l.includes("</summary>") && (lines[i + 1] ?? "x").trim() !== "") {
          bad.push(`${p}:${i + 1} \`</summary>\` 之后没有空行（块内围栏会不解析）`);
        }
        if (l.includes("</details>") && (lines[i - 1] ?? "x").trim() !== "") {
          bad.push(`${p}:${i + 1} \`</details>\` 之前没有空行`);
        }
      });
      return bad;
    });
    expect(wrong, `折叠块的结构不对：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("该红时红：把根 README 项目结构那段围栏标上 `text` —— b 的存在性那一半必须红", () => {
    const src = readFileSync("README.md", "utf8");
    const title = SECTIONS[9]?.title["zh-CN"] ?? "";
    const raw = rawSection(src, title);
    const mutated = src.replace(raw, raw.replace("```", "```text"));
    expect(mutated, "变异没落地").not.toEqual(src);
    expect(openFences(rawSection(mutated, title)),
      "把 ASCII 图标上语言之后「这一节恰一段未标语言的围栏」居然还成立").not.toEqual([""]);
    expect(openFences(mutated).filter((x) => x === "").length,
      "全仓裸围栏数没跟着掉 —— 那 a 与 b 数的不是同一批围栏").toBe(1);
  });

  it("该红时红：`</summary>` 后面的空行被删掉 —— g 点名文件行号", () => {
    const src = readFileSync("README.md", "utf8");
    const mutated = src.replace("</summary>\n\n", "</summary>\n");
    expect(mutated, "变异没落地").not.toEqual(src);
    const lines = mutated.split("\n");
    const bad = lines.flatMap((l, i) =>
      (l.includes("</summary>") && (lines[i + 1] ?? "x").trim() !== "" ? [i + 1] : []));
    expect(bad.length, "`</summary>` 后少的那个空行没被抓到").toBeGreaterThan(0);
  });
});

/* ── R25a–e —— emoji 标题按文档类分档 ────────────────────────────────────
 * f（25 份非 README 标题 emoji 恒为 0）在 `docs-parity.test.ts` 的 W97 组里，
 * 连「给一个 `##` 加 emoji 必须红」那格一起，**本组不重复实现**。
 * ────────────────────────────────────────────────────────────────────────── */

describe("R25a–e emoji 标题按文档类分档（两端都查）", () => {
  it("a 根 README 的 `##` emoji 序列 `toEqual` 常量表算出来的 16 元组", () => {
    const want = SECTIONS.map((s) => headingEmoji(s.title["zh-CN"]));
    const got = sectionsOf(readFileSync("README.md", "utf8")).map((s) => headingEmoji(s.title));
    expect(got, "根 README 的 emoji 序列与 `SECTIONS` 对不上").toEqual(want);
    expect(want.filter((x) => x === ""), "常量表里有一节没 emoji —— 那 a 这一格在测空气").toEqual([]);
  });

  it("b 五份语言版 README 的 `##` emoji 序列 `toEqual` 那 12 元组（逐语言取自己那一列）", () => {
    const shared = SECTIONS.filter((s) => s.rootOnly !== true);
    for (const lang of SECTION_LANGS) {
      const want = shared.map((s) => headingEmoji(s.title[lang]));
      const got = sectionsOf(readFileSync(join("docs", lang, "README.md"), "utf8"))
        .map((s) => headingEmoji(s.title));
      expect(got, `docs/${lang}/README.md 的 emoji 序列与常量表对不上`).toEqual(want);
    }
  });

  it("c `## 🌟 核心功能` 下的 H3 emoji ⊆ 固定集合，且必含 `🖥`、末位是 `⚡`", () => {
    const ALLOWED = new Set(["🔌", "🔐", "🔄", "🔀", "🖥", "⚡", "🤖", "☁", "🖼"]);
    const wrong = pairsOf(SIX_READMES).flatMap(([p, t]) => {
      const h3 = sectionAt(t, p, 1).body.filter((r) => /^### /.test(r.line)).map((r) => headingEmoji(r.line));
      const bad: string[] = [];
      const outside = h3.filter((e) => !ALLOWED.has(e));
      if (outside.length > 0) bad.push(`集合外的 emoji：${outside.join(" ")}`);
      if (!h3.includes("🖥")) bad.push("缺 `🖥`（面板那一条）");
      if (h3[h3.length - 1] !== "⚡") bad.push(`末位不是 \`⚡\` 而是 \`${h3[h3.length - 1] ?? "空"}\``);
      return bad.length === 0 ? [] : [`${p}: ${bad.join("；")}`];
    });
    expect(wrong, `核心功能的 H3 emoji 不对：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("d `## ⚡ 快速部署` 下恰 3 条 `### N. `，且**一个 emoji 都不带**（流程步骤用数字）", () => {
    const wrong = pairsOf(SIX_READMES).flatMap(([p, t]) => {
      const h3 = sectionAt(t, p, 4).body.filter((r) => /^### /.test(r.line)).map((r) => r.line);
      const numbered = h3.filter((l) => /^### [0-9]\. /.test(l));
      const withEmoji = h3.filter((l) => headingEmoji(l) !== "");
      const bad: string[] = [];
      if (numbered.length !== 3) bad.push(`\`### N. \` 有 ${numbered.length} 条，该是 3 条`);
      if (h3.length !== numbered.length) bad.push(`该节还有 ${h3.length - numbered.length} 条不带序号的 H3`);
      if (withEmoji.length > 0) bad.push(`带 emoji 的步骤：${withEmoji.join(" / ")}`);
      return bad.length === 0 ? [] : [`${p}: ${bad.join("；")}`];
    });
    expect(wrong, `快速部署的三步不对：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("e 六份 SPONSORS.md：H1 带 `☕`，两个 H2 分别带 `💖` / `🤝`（按 V40 没有 `📢`）", () => {
    const wrong = pairsOf(SIX_SPONSORS).flatMap(([p, t]) => {
      const rows = bodyLines(t);
      const h1 = rows.find((r) => /^# /.test(r.line))?.line ?? "";
      const h2 = rows.filter((r) => /^## /.test(r.line)).map((r) => headingEmoji(r.line));
      const bad: string[] = [];
      if (!h1.includes("☕")) bad.push(`H1 没带 \`☕\`：${h1}`);
      if (h2.join(",") !== "💖,🤝") bad.push(`H2 的 emoji 序列是 ${h2.join(",") || "空"}，该是 💖,🤝`);
      return bad.length === 0 ? [] : [`${p}: ${bad.join("；")}`];
    });
    expect(wrong, `SPONSORS 的 emoji 分档不对：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("该红时红：从根 README 的某个 `##` 去掉 emoji —— a 红并指出是第几节", () => {
    const src = readFileSync("README.md", "utf8");
    const first = SECTIONS[0]?.title["zh-CN"] ?? "";
    const mutated = src.replace(first, `## ${first.slice(3).split(" ").slice(1).join(" ")}`);
    expect(mutated, "变异没落地").not.toEqual(src);
    const got = sectionsOf(mutated).map((s) => headingEmoji(s.title));
    expect(got, "去掉 emoji 之后 a 居然还绿").not.toEqual(SECTIONS.map((s) => headingEmoji(s.title["zh-CN"])));
  });

  it("谓词自守：BMP 段的 `⚡⚙⚠☕⭐` 与星平面的 `📝🌟🗂` 都算 emoji，纯文字不算", () => {
    for (const e of ["⚡", "⚙", "⚠", "☕", "⭐", "📝", "🌟", "🗂", "🖥"]) {
      expect(EMOJI.test(e), `谓词认不出 \`${e}\` —— 退回窄义了，R25a 会整条塌陷`).toBe(true);
    }
    for (const s of ["API", "文档", "한국어", "-", "1."]) {
      expect(EMOJI.test(s), `谓词把「${s}」当成了 emoji`).toBe(false);
    }
  });
});

/* ── R28 —— 排版基线不回退（回归轴）────────────────────────────────────────
 * 基线的**权威文本**在 P3f 的工作区（`docs-typography-baseline.tsv`，每行带口径列），
 * 那份文件不进公开仓（它记着两个参照仓的实测值，属工程过程物）。
 * ⚠️ 那份文件的备注列分两段：`[agnes@7D]`（本仓侧，随基线一起**现算**）与
 * `[模板/口径]`（参照仓与规格的结论，冻结）。**分段是补一次真实事故**：刷新时只刷了数值列、
 * 备注列逐字留在阶段 0，20 行里 18 行数值与证据自相矛盾（指标 14 甚至给一个错值打了对勾）。
 * 工作区侧另有 `w88_evidence_guard.py` 守着「数值变了证据也必须变」，与本文件这一侧分工不重叠。
 * 进仓的是**判据这一侧**：把基线里那些「只许朝一个方向走」的指标，逐条钉成会红的常量。
 *
 * ⚠️ **没有体量基线，这条判据奖励删内容**：全部 `↓` 型指标都可以靠把
 * `docs/en/DEPLOY.md` 截断到 30 行一次性归零。所以下面第一格钉的是**体量下限**。
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * W88 指标 16 —— 逐份行数体量下限。
 *
 * **数值 = 2026-08-30（北京时间）实测值的 90%**（向下取整），不是实测值本身：
 * 留 10% 余量是给正常的精简留路，掉出 10% 就该有人来说明为什么。
 * **口径**：`wc -l`，即换行符个数（与基线文件第 16 项逐字同口径）。
 */
const VOLUME_FLOOR: Readonly<Record<string, number>> = {
  // 仓根 5 份
  "CHANGELOG.md": 43, "CONTRIBUTING.md": 207, "README.md": 554,
  "SECURITY.md": 112, "SPONSORS.md": 27,
  // docs/en
  "docs/en/ADMIN.md": 534, "docs/en/API.md": 1184, "docs/en/DEPLOY.md": 1355,
  "docs/en/README.md": 452, "docs/en/REGISTRAR.md": 392, "docs/en/SPONSORS.md": 27,
  "docs/en/USAGE.md": 360,
  // docs/ja
  "docs/ja/ADMIN.md": 527, "docs/ja/API.md": 1184, "docs/ja/DEPLOY.md": 1332,
  "docs/ja/README.md": 452, "docs/ja/REGISTRAR.md": 392, "docs/ja/SPONSORS.md": 27,
  "docs/ja/USAGE.md": 308,
  // docs/ko
  "docs/ko/ADMIN.md": 520, "docs/ko/API.md": 1184, "docs/ko/DEPLOY.md": 1306,
  "docs/ko/README.md": 451, "docs/ko/REGISTRAR.md": 382, "docs/ko/SPONSORS.md": 27,
  "docs/ko/USAGE.md": 308,
  // docs/zh-CN
  "docs/zh-CN/ADMIN.md": 452, "docs/zh-CN/API.md": 1184, "docs/zh-CN/DEPLOY.md": 1140,
  "docs/zh-CN/README.md": 450, "docs/zh-CN/REGISTRAR.md": 336, "docs/zh-CN/SPONSORS.md": 27,
  "docs/zh-CN/USAGE.md": 308,
  // docs/zh-TW
  "docs/zh-TW/ADMIN.md": 452, "docs/zh-TW/API.md": 1184, "docs/zh-TW/DEPLOY.md": 1143,
  "docs/zh-TW/README.md": 450, "docs/zh-TW/REGISTRAR.md": 336, "docs/zh-TW/SPONSORS.md": 27,
  "docs/zh-TW/USAGE.md": 308,
};

describe("R28 排版基线不回退（W88 的 16 个指标里，能进仓的那几条）", () => {
  it("指标 16 体量下限：逐份行数不许掉到登记值以下（没有这一条，下面每一格都能靠删内容达标）", () => {
    const wrong = SHIP_DOCS.flatMap((p) => {
      const floor = VOLUME_FLOOR[p];
      if (floor === undefined) return [`${p} 不在体量登记表里 —— 新增文档必须先登记一个下限`];
      const lines = readFileSync(p, "utf8").split("\n").length - 1;
      return lines >= floor ? [] : [`${p} 只剩 ${lines} 行，登记的下限是 ${floor}`];
    });
    expect(wrong, `文档被掏空了：\n${wrong.join("\n")}\n`
      + "⇒ 真要精简先来改这张表，并说明为什么").toEqual([]);
    expect(Object.keys(VOLUME_FLOOR).filter((p) => !SHIP_DOCS.includes(p)),
      "体量登记表里有已经不在射程里的文件 —— 登记过期了，删掉它").toEqual([]);
  });

  it("指标 1/2/3：极简分隔行、4 空格与 6 空格嵌套列表恒为 0（W116/W117 的回归面）", () => {
    const MIN_SEP = /^\s*\|(?:\s*:?-{1,3}:?\s*\|)+\s*$/;
    const wrong = pairsOf(SHIP_DOCS).flatMap(([p, t]) => bodyLines(t).flatMap((r) => {
      if (MIN_SEP.test(r.line)) return [`${p}:${r.no} 极简分隔行`];
      if (/^ {4}[-*] /.test(r.line)) return [`${p}:${r.no} 4 空格嵌套`];
      if (/^ {6}[-*] /.test(r.line)) return [`${p}:${r.no} 6 空格嵌套`];
      return [];
    }));
    expect(wrong, `基线回退了：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("指标 15：`.env.example` 不许缩水（C20 的落地形式）", () => {
    const src = readFileSync(".env.example", "utf8");
    const lines = src.split("\n").length - 1;
    const comments = src.split("\n").filter((l) => l.startsWith("#")).length;
    expect([lines >= 197, comments >= 139], `.env.example 现在 ${lines} 行 / ${comments} 条注释行，`
      + "登记的下限是 197 / 139 —— 这一条是 agnes 刻意超出模板的部分（K 17/13、G 54/15），"
      + "只能守住不回退，不能拿模板当目标").toEqual([true, true]);
  });

  it("该红时红：把 `docs/en/DEPLOY.md` 截断到 30 行 —— 体量那一格红并点名它", () => {
    const p = join("docs", "en", "DEPLOY.md");
    const truncated = readFileSync(p, "utf8").split("\n").slice(0, 30).join("\n");
    const lines = truncated.split("\n").length - 1;
    expect(lines < (VOLUME_FLOOR[p] ?? 0),
      "截断到 30 行居然还在下限之上 —— 那这张表拦不住「掏空文档把 ↓ 型指标一次性归零」").toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * W92b —— 依赖阶段 7 成果的那一批（R20/P5、R21、R23'、R26）
 *
 * 为什么单独一批：R21 判的是「W118 把 195 处裸警告转完之后」的状态、R23' 判的是
 * 「W119 在语义边界上插完标题之后」的状态、R26 判的是「W95 收完开篇之后」的状态。
 * 在阶段 7 中途启用，整个阶段 7 全程 CI 红，而且**红的原因是「活还没干完」**，报文误导
 *（X3 / O7 / Q17）。所以它们排在最后一批之后，**启用当天就必须全绿**。
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── R21 —— 裸警告 emoji 归零（上限判据，不可灌水）────────────────────────── */

const BARE_WARN = /⚠️|⚠|❗|🚫/g;

/**
 * §1.2 强制骨架里那两个**标题**自带 `⚠`：`## ⚠ 注意事项`（六份 README）与
 * `## ⚠ 免责声明`（根 README，`SECTIONS[15]` 是 rootOnly）。合计 7 处，
 * 这是模板要求的，不是「写在正文里的一个字符」。
 *
 * ⚠️ **登记是双向的**：下面那格既查「标题之外恒为 0」，也查「这 7 处今天真的还在」——
 * 骨架哪天改了名，这条豁免就该跟着删，而不是继续豁免一个不存在的东西。
 */
const HEADING_WARN_COUNT = 7;

describe("R21 出货文档正文里的裸警告 emoji 恒为 0（白名单已取消）", () => {
  /** 一行是不是「语言切换行」：一行里有 ≥3 条跨语言链接就算，不认字面前缀。 */
  const CROSS_LANG = /(?:\]\(|href=")(?:\.\.\/|docs\/)(?:zh-CN|zh-TW|en|ja|ko)\//g;
  const isSwitcher = (line: string) => (line.match(CROSS_LANG) ?? []).length >= 3;

  /** 正文里的裸警告：剥围栏、剥表格行、剥语言切换行、剥标题行之后还剩下的。 */
  const bareWarnings = (docs: readonly Doc[]): string[] =>
    docs.flatMap(([p, t]) => bodyLines(t).flatMap((r) => {
      if (/^#{1,6} /.test(r.line) || r.line.trim().startsWith("|") || isSwitcher(r.line)) return [];
      const n = (r.line.match(BARE_WARN) ?? []).length;
      return n > 0 ? [`${p}:${r.no} ${n} 处：${r.line.trim().slice(0, 60)}`] : [];
    }));

  it("40 份出货文档：标题之外一处裸 `⚠️`/`⚠`/`❗`/`🚫` 都没有（W118 把 195 处转完之后的状态）", () => {
    const hits = bareWarnings(pairsOf(SHIP_DOCS));
    expect(hits, `正文里还有裸警告 emoji：\n${hits.join("\n")}\n`
      + "⇒ 逐处判型转成 `> [!WARNING]` / `> [!IMPORTANT]` / `> [!TIP]`。"
      + "GitHub 上行内 emoji 不渲染成带色块，扫读时和普通粗体没区别").toEqual([]);
  });

  it("🔴 这一条**比 R21 的字面更严**：连 alert 块正文里也不许有 —— 理由与实测一起写在这里", () => {
    // R21 的原文允许裸警告住在 `> [!TYPE]` 块的正文行里。**本仓不开这一档**：
    // 实测今天全仓 alert 块正文里的裸警告数 = 0（下面这一格钉着）。
    // 开一条**零使用**的豁免，等于给「以后往 alert 里塞 emoji」提前留门，
    // 而本仓对豁免的裁定一贯是「豁免名册会变成永久的洞」。
    // 哪天真需要，改这里比从一个已经开着的洞里往回收容易得多。
    const inAlert = pairsOf(SHIP_DOCS).flatMap(([p, t]) => {
      let alert = false;
      return bodyLines(t).flatMap((r) => {
        if (/^> \[!/.test(r.line)) { alert = true; return []; }
        if (!r.line.startsWith(">")) { alert = false; return []; }
        return alert && BARE_WARN.test(r.line) ? [`${p}:${r.no}`] : [];
      });
    });
    expect(inAlert, `alert 块正文里出现了裸警告 emoji：\n${inAlert.join("\n")}`).toEqual([]);
  });

  it("豁免的另一半：标题里那 7 处 `⚠` 今天真的还在（骨架改名了这条豁免就该删）", () => {
    const inHeadings = pairsOf(SHIP_DOCS).reduce((n, [, t]) =>
      n + bodyLines(t).filter((r) => /^#{1,6} /.test(r.line))
        .reduce((m, r) => m + (r.line.match(BARE_WARN) ?? []).length, 0), 0);
    expect(inHeadings, `标题里的 \`⚠\` 从 ${HEADING_WARN_COUNT} 处变成了 ${inHeadings} 处 —— `
      + "`## ⚠ 注意事项`（六份）与 `## ⚠ 免责声明`（根那份）是 §1.2 的强制骨架，"
      + "数变了说明骨架动了，这条豁免要跟着重新论证").toBe(HEADING_WARN_COUNT);
  });

  it("该红时红：往 `docs/zh-CN/DEPLOY.md` 正文塞一个裸 `⚠️` —— 红并给出文件:行号", () => {
    const target = join("docs", "zh-CN", "DEPLOY.md");
    const docs = withMutation(pairsOf(SHIP_DOCS), target, (s) => `${s}\n⚠️ 这一句是变异探针。\n`);
    expect(bareWarnings(docs).join("\n"), "塞进去的裸 `⚠️` 没被抓到").toContain(`${target}:`);
  });

  it("🔴 该红时红（主反例）：给那一行加个 `> ` 前缀 —— **必须仍然红**（白名单被取消的全部意义）", () => {
    // 可判定性审查构造的一次性机械变换：`sed 's/^\(.*⚠️\)/> \1/'`。
    // 第 1 版的 R21 给 `>` 引用块开了一整类白名单，这一行 sed 能把 210 处**全部**搬进去，
    // 而 **0 个 alert 块被创建**。所以白名单必须是「点一个名」而不是「开一类」。
    const target = join("docs", "zh-CN", "DEPLOY.md");
    const docs = withMutation(pairsOf(SHIP_DOCS), target, (s) => `${s}\n> ⚠️ 这一句是变异探针。\n`);
    expect(bareWarnings(docs).join("\n"),
      "加了 `> ` 前缀就逃掉了 —— 那条白名单又回来了，一行 sed 就能把全仓刷绿").toContain(`${target}:`);
  });

  it("不许乱红：围栏里的 `⚠️`（shell 注释 / 日志样例）与表格行里的不进射程", () => {
    const fenced: readonly Doc[] = [["x.md", "# X\n\n一句话。\n\n```bash\n# ⚠️ 注意\n```\n\n| a | b |\n|------|------|\n| ⚠️ | 1 |\n"]];
    expect(bareWarnings(fenced), "剥围栏 / 剥表格行没生效").toEqual([]);
  });
});

/* ── R23' —— 长度驱动的分层（不数个数，数「标题之间有多长」）────────────────
 *
 * 🔴 **原 R23 的三条抗填充护栏被模板自己证伪，整组作废**（kiro 违反护栏 1 共 93 次、
 * gemini 71 次；护栏 2 连数量都不等：48/49/63/37/61）。替换成下面三条。
 *
 * 🔴🔴 **B 那条阈值的出处，ADJ §80 已裁定，逐字抄在这里，别再「修正」它**：
 *   ① 阈值保留 **≤15%**（agnes 今天 13.9%，已达标）；
 *   ② **它不是「从模板现算」的** —— 规格里那句「K 93/631 = 14.7%、G 71/614 = 11.6%」
 *      用错了分母（标题数实测是 873/847）。主控用同一把尺独立复算：
 *      **agnes 14.6% / kiro2api 21.2% / gemini2api 38.1%** ⇒ **模板自己过不了 15%**。
 *      所以这是**一条严于模板的自定标准**，不是对齐项；
 *   ③ 性质是**棘轮**（防回退），不是「要去达到的目标」；
 *   ④ **不许为了过线去删 `###`**。
 *   写在这里的理由：带着假出处的阈值，后来的人回去复算发现对不上，会把它当错误
 *   「修正」掉 —— 而它其实是对的，错的只是那句出处。**假理由撑着的真判据，
 *   迟早死于理由被推翻。**（与 ADJ §54 同一个教训。）
 * ────────────────────────────────────────────────────────────────────────── */

type Interval = { readonly path: string; readonly no: number; readonly title: string; readonly chars: number };

/**
 * 相邻两个标题之间的正文字符数。**含列表、含表格，剥围栏**；
 * 字符数 = 区间内各行 `trim()` 之后拼起来的 `String.length`。
 * 最后一个标题到文末也算一个区间。
 *
 * ⚠️ **为什么不用 text-run**：`docs/en/DEPLOY.md:52-180` 实测是 129 行**全 bullet 列表**，
 * 按 text-run 判，给 bullet 逐条插空行就能全绿（run 被切碎）而一个 `###` 都没加。
 * 按「相邻标题间字符数」判，插空行**毫无用处，必须插标题**。
 */
const intervalsOf = (docs: readonly Doc[]): readonly Interval[] => {
  const out: Interval[] = [];
  for (const [path, text] of docs) {
    const rows = bodyLines(text);
    const idx = rows.flatMap((r, i) => (/^#{1,6} /.test(r.line) ? [i] : []));
    idx.forEach((i, k) => {
      const j = idx[k + 1] ?? rows.length;
      const chars = rows.slice(i + 1, j).reduce((n, r) => n + r.line.trim().length, 0);
      out.push({ path, no: rows[i]?.no ?? 0, title: rows[i]?.line.trim() ?? "", chars });
    });
  }
  return out;
};

/**
 * **R23'A 今天的棘轮值**：>1200 字符的区间数。
 *
 * 🔴 **规格给的目标是 0，今天是 67，差 67 —— 这是一笔如实登记的欠账，不是达标。**
 * 为什么不硬冲 0：实测把全仓压到字面 0 需要每种语言约 47 个新标题、全仓约 235 个，
 * `###`+`####` 会从 1095 涨到约 1330 = **模板密度的 2.4 倍**，与 ADJ §79
 *（「排版密度已达成并超过模板，不许再堆 `###`，本阶段是收口不是加量」）正面冲突。
 * ⇒ 本判据取**绝对数棍轮**：只许降不许升。
 * **用绝对数而不是比例**：比例可以靠「多加几个短小节」把分母做大来稀释，
 * 绝对数不行 —— 想让它降只能真的把长段切开。
 * 登记在偏离名册第 21 条，**降到 0 那天这个常量与那条登记一起删**。
 */
const R23A_OVERLONG_RATCHET = 67;
/** R23'A 的长度线。 */
const R23A_LIMIT = 1200;
/** R23'B 的薄标题线与占比上限（出处见上面那段 ADJ §80 的逐字裁定）。 */
const R23B_THIN = 40;
const R23B_RATIO = 15;

/**
 * R23'C 的判定本体：同一类文档的五种语言，标题**层级序列**必须逐位相等。
 * **真扫描与反向控制共用它**，反向控制喂的是变异过的 `Doc[]`。
 */
const levelSeqFaults = (docs: readonly Doc[]): string[] => {
  const byDoc = new Map<string, Array<{ lang: string; seq: number[] }>>();
  for (const [p, t] of docs) {
    const [, lang, file] = p.split("/");
    const doc = (file ?? "").replace(/\.md$/, "");
    const seq = bodyLines(t).flatMap((r) => {
      const m = /^(#{1,6}) /.exec(r.line);
      return m === null ? [] : [m[1]?.length ?? 0];
    });
    byDoc.set(doc, [...(byDoc.get(doc) ?? []), { lang: lang ?? "?", seq }]);
  }
  return [...byDoc.entries()].flatMap(([doc, rows]) => {
    const base = rows[0];
    if (base === undefined) return [];
    return rows.slice(1).flatMap(({ lang, seq }) => {
      if (seq.length !== base.seq.length) {
        return [`${doc}: ${lang} 有 ${seq.length} 个标题，${base.lang} 有 ${base.seq.length} 个`];
      }
      const i = seq.findIndex((v, k) => v !== base.seq[k]);
      return i < 0 ? [] : [`${doc}: ${lang} 第 ${i + 1} 个标题是 h${seq[i]}，${base.lang} 是 h${base.seq[i]}`];
    });
  });
};

describe("R23' 结构分层：相邻标题间的长度、薄标题占比、五语言层级序列", () => {
  const all = () => intervalsOf(pairsOf(SHIP_DOCS));

  it("射程自守：标题总数与区间数相等且都在四位数 —— 判据不是在测空气", () => {
    const ints = all();
    expect(ints.length, "区间数掉到三位数了 —— 多半是标题正则或剥围栏写坏了").toBeGreaterThan(1000);
  });

  it("A（棘轮）：>1200 字符的区间数不许比登记值多 —— 今天 67，规格的目标是 0（欠账，名册第 21 条）", () => {
    const over = all().filter((x) => x.chars > R23A_LIMIT);
    const worst = [...over].sort((a, b) => b.chars - a.chars).slice(0, 5)
      .map((x) => `${x.path}:${x.no} ${x.chars} 字符 ${x.title.slice(0, 40)}`);
    expect(over.length, `>${R23A_LIMIT} 字符的区间从 ${R23A_OVERLONG_RATCHET} 涨到了 ${over.length}。`
      + `最长的几处：\n${worst.join("\n")}\n`
      + "⇒ 想让它降只能**在语义边界上插标题**（给 bullet 逐条插空行对它毫无用处）；"
      + "⚠️ 也不许靠删内容降 —— R28 的体量下限那一格盯着")
      .toBeLessThanOrEqual(R23A_OVERLONG_RATCHET);
  });

  it("B（棘轮）：薄标题（相邻标题间 <40 字符）占比 ≤15% —— 今天 13.9%，余量 21 个空壳标题", () => {
    const ints = all();
    const thin = ints.filter((x) => x.chars < R23B_THIN).length;
    const ratio = (100 * thin) / ints.length;
    expect(ratio, `薄标题占比 ${ratio.toFixed(2)}%（${thin}/${ints.length}）超过了 ${R23B_RATIO}%。`
      + "这一条专治「塞 20 个空壳 `### 说明 N` + 每个三行废话」那种刷密度的改法："
      + "空壳标题**只会让这个比例变坏**。⚠️ 反过来也不许为了过线去删 `###`（ADJ §80 第 ④ 条）")
      .toBeLessThanOrEqual(R23B_RATIO);
  });

  it("C：七类文档的标题**层级序列**五语言逐份相等（只比层级，不比文本）", () => {
    const wrong = levelSeqFaults(pairsOf(SHIP_DOCS.filter((p) => p.startsWith("docs"))));
    expect(wrong, `五语言的标题层级序列对不上：\n${wrong.join("\n")}\n`
      + "⚠️ 这一条**刻意不比文本**：模板上「五语言 `###` 数不等」（48/49/63/37/61）"
      + "说明比文本本来就不该要求；比文本还得先造一张 5×N 译名表").toEqual([]);
  });

  it("① 该红时红：从 `docs/ja/API.md` 删掉 5 个 `###` —— C 红并点名 ja", () => {
    const target = join("docs", "ja", "API.md");
    const docs = withMutation(pairsOf(SHIP_DOCS.filter((p) => p.startsWith("docs"))), target, (s) => {
      let n = 0;
      return s.split("\n").filter((l) => !(/^### /.test(l) && n++ < 5)).join("\n");
    });
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const faults = levelSeqFaults(docs).join("\n");
    expect(faults, "删掉 5 个 `###` 之后 C 居然还绿").toContain("API: ja 有");
  });

  it("② 该红时红：加 22 个空壳 `### 占位` —— B 被顶穿（专门证明「填充不管用」）", () => {
    // 今天 232/1669 = 13.90%。要顶穿 15% 需要 x 满足 (232+x)/(1669+x) > 0.15 ⇒ x ≥ 22。
    // **余量只有 21 个空壳标题**，这个数写在这里是为了让后来的人知道这条线有多紧。
    const target = join("docs", "zh-CN", "USAGE.md");
    const filler = Array.from({ length: 22 }, (_, i) => `### 占位 ${i + 1}\n`).join("\n");
    const docs = withMutation(pairsOf(SHIP_DOCS), target, (s) => `${s}\n${filler}`);
    const ints = intervalsOf(docs);
    const ratio = (100 * ints.filter((x) => x.chars < R23B_THIN).length) / ints.length;
    expect(ratio, `塞了 22 个空壳标题之后占比才 ${ratio.toFixed(2)}% —— B 没被顶穿，那它拦不住刷密度`)
      .toBeGreaterThan(R23B_RATIO);
  });

  it("③ 该红时红：给一段 bullet 洪流逐条插空行而不加标题 —— A 的计数**一个都不许少**", () => {
    // 这一条专打第 1 版被攻破的那条路：按 text-run 判，插空行能把 run 切碎从而全绿。
    const target = join("docs", "en", "DEPLOY.md");
    const docs = withMutation(pairsOf(SHIP_DOCS), target, (s) => s.replace(/\n- /g, "\n\n- "));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const after = intervalsOf(docs).filter((x) => x.chars > R23A_LIMIT).length;
    expect(after, "逐条插空行之后超限区间居然变少了 —— 那这条判据数的还是 text-run，被攻破的那条路又开着")
      .toBeGreaterThanOrEqual(R23A_OVERLONG_RATCHET);
  });

  it("④ 该红时红：把某两个标题之间撑到 3000 字符 —— A 的计数上升并点得出文件:行号", () => {
    const target = join("docs", "zh-CN", "SPONSORS.md");
    const docs = withMutation(pairsOf(SHIP_DOCS), target, (s) => `${s}\n## 撑一段\n\n${"字".repeat(3000)}\n`);
    const over = intervalsOf(docs).filter((x) => x.chars > R23A_LIMIT);
    expect(over.length, "撑到 3000 字符的那一段没被算进来").toBe(R23A_OVERLONG_RATCHET + 1);
    expect(over.map((x) => x.path), "报文点不出是哪一份").toContain(target);
  });
});

/* ── R26 —— 非 README 文档的开篇与页脚形态 ────────────────────────────────
 * d（无语言切换行）在 `docs-parity.test.ts` 的 W75 组里、
 * e'（末节标题 == 译名表同一下标）在 W102 / W107 / W115 三组里，本组不重复实现。
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 25 份非 README 的 H1 译名表。**这是右操作数，不是从磁盘现算的**——
 * 从磁盘现算就是拿被测对象跟自己比，构造上恒真。
 */
const DOC_H1: Readonly<Record<string, Readonly<Record<Lang, string>>>> = {
  ADMIN: { "zh-CN": "# 管理面板", "zh-TW": "# 管理面板", en: "# Admin panel", ja: "# 管理パネル", ko: "# 관리 패널" },
  API: { "zh-CN": "# API 文档", "zh-TW": "# API 文檔", en: "# API Reference", ja: "# API リファレンス", ko: "# API 레퍼런스" },
  DEPLOY: { "zh-CN": "# 部署指南", "zh-TW": "# 部署指南", en: "# Deployment Guide", ja: "# デプロイガイド", ko: "# 배포 가이드" },
  REGISTRAR: {
    "zh-CN": "# 注册机（自动补池）", "zh-TW": "# 註冊機（自動補池）", en: "# Registrar (auto-refill)",
    ja: "# レジストラー（自動プール補充）", ko: "# 레지스트라(자동 키 풀 보충)",
  },
  USAGE: { "zh-CN": "# 使用指南", "zh-TW": "# 使用指南", en: "# Usage Guide", ja: "# 使い方ガイド", ko: "# 사용 가이드" },
};

/** R26a 的判定本体。**真扫描与三条反向控制共用它**，不在反向控制里手写第二份。 */
const openingFaults = (docs: readonly Doc[]): string[] =>
  docs.flatMap(([p, t]) => {
    const ls = t.split("\n");
    const bad: string[] = [];
    if (!/^# \S/.test(ls[0] ?? "")) bad.push(`第 1 行不是 H1：${(ls[0] ?? "").slice(0, 40)}`);
    if ((ls[1] ?? "x") !== "") bad.push("第 2 行不是空行");
    const lead = ls[2] ?? "";
    if (lead.trim() === "") bad.push("第 3 行是空的（没有 lead）");
    if (/^[>|<#![]/.test(lead)) bad.push(`第 3 行不是一句散文：${lead.slice(0, 40)}`);
    if (!/[。.！!？?]$/.test(lead.trim())) bad.push(`第 3 行没有以句末标点收尾：…${lead.trim().slice(-20)}`);
    if ((ls[3] ?? "x") !== "") bad.push("第 4 行不是空行（lead 不止一段）");
    return bad.length === 0 ? [] : [`${p}: ${bad.join("；")}`];
  });

/** R26c 的判定本体。同上，反向控制喂的是变异过的文本，不是另一份手写比较。 */
const h1Faults = (docs: readonly Doc[]): string[] =>
  docs.flatMap(([p, t]) => {
    const [, lang, file] = p.split("/");
    const doc = (file ?? "").replace(/\.md$/, "");
    const want = DOC_H1[doc]?.[lang as Lang] ?? "<表里没有这一格>";
    const got = (t.split("\n")[0] ?? "").trim();
    return got === want ? [] : [`${p}: 是「${got}」，译名表写的是「${want}」`];
  });

describe("R26a–c 25 份非 README 的开篇三行形态与 H1 译名", () => {
  it("a 开篇四行：`# 标题` / 空 / **一句** lead / 空 —— lead 恰一段，不许是徽章行或 alert", () => {
    const wrong = openingFaults(pairsOf(NON_25));
    expect(wrong, `开篇形态不对：\n${wrong.join("\n")}\n`
      + "⚠️ 「第 3 行非空」这一条单独太松：放一条徽章行或一个 `> [!NOTE]` 照样过，"
      + "所以加了「不得以 `>`/`<`/`|`/`#`/`!`/`[` 开头」与「必须句末标点收尾」两道").toEqual([]);
  });

  it("b H1 的 emoji 按文件类型二分：六份 SPONSORS 必带 `☕`，25 份非 README 必**不**带", () => {
    const wrong = [
      ...pairsOf(SIX_SPONSORS).flatMap(([p, t]) => {
        const h1 = t.split("\n")[0] ?? "";
        return h1.startsWith("# ☕ ") ? [] : [`${p} 的 H1 没带 \`☕\`：${h1}`];
      }),
      ...pairsOf(NON_25).flatMap(([p, t]) => {
        const h1 = t.split("\n")[0] ?? "";
        return headingEmoji(h1) === "" ? [] : [`${p} 的 H1 带了 emoji：${h1}`];
      }),
    ];
    expect(wrong, `H1 的 emoji 分档不对：\n${wrong.join("\n")}`).toEqual([]);
  });

  it("c 25 份的 H1 文字逐份命中译名表（右操作数是常量，不是磁盘）", () => {
    const wrong = h1Faults(pairsOf(NON_25));
    expect(wrong, `H1 与译名表对不上：\n${wrong.join("\n")}`).toEqual([]);
    // 表自守：25 格齐全、都是合法 H1、同一类文档的五种语言两两不同（不许有两格抄同一句）。
    for (const doc of NON_README_DOCS) {
      const row = LANGS.map((l) => DOC_H1[doc]?.[l] ?? "");
      expect(row.filter((x) => !/^# \S/.test(x)), `${doc} 那一行有格子不是合法 H1`).toEqual([]);
      // zh-CN 与 zh-TW 的「部署指南 / 使用指南」在两岸用词相同，是真实情况，不强求两两不等；
      // 但**五格全同**一定是抄漏了。
      expect(new Set(row).size, `${doc} 五种语言的 H1 全都一样 —— 多半是没翻译`).toBeGreaterThan(1);
    }
  });

  it("该红时红：把 `docs/ja/USAGE.md` 的 lead 拆成两段（第 4 行不空）—— a 红并点名它", () => {
    const target = join("docs", "ja", "USAGE.md");
    const docs = withMutation(pairsOf(NON_25), target, (s) => {
      const ls = s.split("\n");
      ls.splice(3, 0, "二段目のリード文です。");
      return ls.join("\n");
    });
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    expect(openingFaults(docs).join("\n"), "lead 拆成两段之后 a 居然还绿").toContain(`${target}: 第 4 行不是空行`);
  });

  it("🔴 该红时红：第 3 行换成一条 `> [!NOTE]` —— 「第 3 行非空」放行，只有新加的两道看得见", () => {
    const target = join("docs", "en", "API.md");
    const docs = withMutation(pairsOf(NON_25), target, (s) => {
      const ls = s.split("\n");
      ls[2] = "> [!NOTE]";
      return ls.join("\n");
    });
    const faults = openingFaults(docs).join("\n");
    expect(faults, "把 lead 换成一条 alert 之后 a 居然还绿 —— 「第 3 行非空」这一条单独就是这么松")
      .toContain(`${target}: 第 3 行不是一句散文`);
  });

  it("该红时红：把 `docs/ko/API.md` 的 H1 改成另一种合法译法 —— c 红并写出期望值", () => {
    const target = join("docs", "ko", "API.md");
    const docs = withMutation(pairsOf(NON_25), target, (s) => s.replace(/^# .*/, "# API 문서"));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const faults = h1Faults(docs).join("\n");
    expect(faults, "H1 换了说法之后 c 居然还绿").toContain(`${target}: 是「# API 문서」`);
    expect(faults, "报文里没写出期望值，读的人还得自己去翻表").toContain("# API 레퍼런스");
  });
});

/* ── R20/P5 —— alert 的**内容锚定下限**（对「四个 sed 全绿」的正面回答）────
 *
 * 先交代问题有多硬：可判定性审查构造了一条一次性机械变换，跑四个 sed 就能让纯上限体系
 * 全绿，而 25 份非 README 里的 alert 块**仍然是 0 个**、内容一个字没动。
 * 根因是「宁取上限与恒等式，不取下限」贯彻得太彻底：**上限只能防退化，不能驱动改进**，
 * 而 D4（「现在的太简单了」）是一个改进诉求。
 *
 * P5 的形态**不是回到计数下限**（那可灌水），而是**内容锚定**：
 * 出货文档正文里每出现一处「风险语义句」，它所在的块必须以 `> [!TYPE]` 起头。
 * **分子分母绑在同一批句子上** ⇒ 多写 alert 不加分（没有任何总数下限可以满足）、
 * 少写直接红、想减少分母就得删掉真实的风险陈述（被 R28 的体量下限挡住）。
 *
 * **它验不了什么**：alert 选的**类型**对不对（N7）；一句风险陈述**写得全不全**。
 * ⇒ W118 的判型转换有人工评审（Q17 已定），P5 只保证「风险句必须住在框里」。
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 风险语义词表。**闭合**，且**双向登记**：
 * 标 `attested` 的格子今天必须在那种语言的出货文档里出现过 ≥1 次；
 * 标 `reserve` 的格子今天必须**一次都没有** —— 那是「留着以后用」的储备译法，
 * 不是「已经在守的东西」。两个方向都查，表才不会发霉成一张守空气的清单。
 */
type WordCell = { readonly words: readonly string[]; readonly reserve?: true };
const RISK_WORDS: ReadonlyArray<readonly [concept: string, cells: Readonly<Record<Lang, WordCell>>]> = [
  ["服务条款（合规风险）", {
    "zh-CN": { words: ["服务条款"] }, "zh-TW": { words: ["服務條款"] },
    en: { words: ["terms of service"] }, ja: { words: ["利用規約"] },
    ko: { words: ["이용약관", "서비스 약관"] },
  }],
  ["未经核实（诚实限定）", {
    "zh-CN": { words: ["未经核实"], reserve: true }, "zh-TW": { words: ["未經核實"], reserve: true },
    en: { words: ["unverified"] }, ja: { words: ["未検証"] }, ko: { words: ["검증되지 않"] },
  }],
  ["数据丢失", {
    "zh-CN": { words: ["数据丢失"] }, "zh-TW": { words: ["資料遺失"] },
    en: { words: ["data loss"] }, ja: { words: ["データ損失"], reserve: true }, ko: { words: ["데이터 손실"] },
  }],
];

/**
 * P5 够不着的两类，**逐条点名**（不是开一类白名单）：
 * ① 六份 README 的 `## 📄 许可协议` 与 `## ⚠ 免责声明` 两节 —— ADJ §63 把它们的末段
 *    **逐字节**钉在了登记表上，把里面的句子搬进 alert 就会当场破掉那条恒等式；
 *    这两节本身就是「整节都是免责声明」，再套一层框子也不增加可读性。
 * ② 两处写在长段中间的括注。它们是**限定语**不是**警告**，
 *    单独拎进框里会把一段技术解释拦腰截断（ADJ §76 记过同型的真实伤害）。
 * **登记是双向的**：下面那格查「这些位置今天确实还命中着词表」——
 * 哪天句子改写了、词不在了，登记就该删，而不是留着守空气。
 * （写这张表时第一版多列了一条 `docs/ko/ADMIN.md:429`，它命中的「不可逆」概念因为
 *   五语言里只有三种语言在用、被踢出了词表 ⇒ 那条登记当场被这一格判成过期，已删。
 *   **这就是双向登记该起的作用**，记一笔。）
 */
const P5_OUTSIDE_ALERT: ReadonlyArray<readonly [path: string, no: number, why: string]> = [
  [join("docs", "en", "DEPLOY.md"), 832, "长段中间的括注：`(we have only verified this on Node; … is unverified)`"],
  [join("docs", "ja", "DEPLOY.md"), 819, "同上，ja 那一份的对应括注"],
];

describe("R20/P5 风险语义句必须住在 alert 块里（内容锚定的下限，不可灌水）", () => {
  /** 六份 README 里 ADJ §63 钉死的那两节的标题（`SECTIONS` 下标 14 / 15）。 */
  const pinnedSectionTitles = (path: string): readonly string[] => {
    const lang = path === "README.md" ? "zh-CN" : (path.split("/")[1] as Lang);
    return [14, 15].flatMap((i) => {
      const s = SECTIONS[i];
      if (s === undefined) return [];
      if (s.rootOnly === true && path !== "README.md") return [];
      return [s.title[lang]];
    });
  };

  /** 逐行扫：命中词表、且所在块不是 alert 的行。 */
  const escapes = (docs: readonly Doc[]) => {
    const out: Array<{ path: string; no: number; word: string; line: string }> = [];
    for (const [path, text] of docs) {
      const lang: Lang = path.startsWith("docs") ? (path.split("/")[1] as Lang) : "zh-CN";
      const pinned = new Set(pinnedSectionTitles(path));
      let alert = false;
      let inPinned = false;
      for (const r of bodyLines(text)) {
        if (/^## /.test(r.line)) inPinned = pinned.has(r.line.trim());
        if (/^> \[!/.test(r.line)) alert = true;
        else if (!r.line.startsWith(">")) alert = false;
        if (alert || inPinned) continue;
        if (/^#{1,6} /.test(r.line) || r.line.trim().startsWith("|")) continue;
        for (const [, cells] of RISK_WORDS) {
          for (const w of cells[lang].words) {
            if (r.line.toLowerCase().includes(w.toLowerCase())) {
              out.push({ path, no: r.no, word: w, line: r.line.trim() });
            }
          }
        }
      }
    }
    return out;
  };

  const registered = new Set(P5_OUTSIDE_ALERT.map(([p, n]) => `${p}:${n}`));

  it("真扫描：风险语义句一处都没有落在 alert 块之外（名册里那两处除外）", () => {
    const wrong = escapes(pairsOf(SHIP_DOCS))
      .filter((x) => !registered.has(`${x.path}:${x.no}`))
      .map((x) => `${x.path}:${x.no} 命中「${x.word}」：${x.line.slice(0, 70)}`);
    expect(wrong, `这些风险陈述写在了普通段落里：\n${wrong.join("\n")}\n`
      + "⇒ 把它所在的块改成 `> [!WARNING]` / `> [!IMPORTANT]`。"
      + "⚠️ 不许反过来删掉这句话来达标 —— R28 的体量下限盯着").toEqual([]);
  });

  it("🔴 灌水不管用：往 `docs/ja/API.md` 塞 10 个空的 `> [!NOTE]` —— 报文一个字都不许变", () => {
    // 这一格是 P5 的**全部意义**：分子分母绑在同一批句子上，
    // 加的不是「承载风险句的块」就对判据毫无贡献。
    const before = escapes(pairsOf(SHIP_DOCS)).length;
    const filler = Array.from({ length: 10 }, () => "> [!NOTE]\n> 水。\n").join("\n");
    const after = escapes(withMutation(pairsOf(SHIP_DOCS), join("docs", "ja", "API.md"),
      (s) => `${s}\n${filler}`)).length;
    expect(after, "塞 10 个空 alert 之后逃逸数居然变了 —— 那这条判据是可以靠灌水刷绿的").toBe(before);
  });

  it("该红时红：把一句含「服务条款」的话从 alert 块里挪到普通段落 —— 红并给出文件:行号", () => {
    const target = join("docs", "zh-CN", "REGISTRAR.md");
    const docs = withMutation(pairsOf(SHIP_DOCS), target,
      (s) => s.replace(/^> \[!WARNING\]\n/m, ""));
    expect(docs.find(([p]) => p === target)?.[1], "变异没落地").not.toEqual(readFileSync(target, "utf8"));
    const hits = escapes(docs).filter((x) => x.path === target);
    expect(hits.map((x) => `${x.path}:${x.no}`).join("\n"),
      "从 alert 里掉出来的那句合规提示没被抓到").toContain(`${target}:`);
  });

  it("词表双向登记（一）：标 attested 的格子今天真的命中着东西", () => {
    const wrong = RISK_WORDS.flatMap(([concept, cells]) => LANGS.flatMap((lang) => {
      const cell = cells[lang];
      if (cell.reserve === true) return [];
      const n = SHIP_DOCS.filter((p) => (p.startsWith("docs") ? p.split("/")[1] : "zh-CN") === lang)
        .reduce((m, p) => m + cell.words.filter((w) =>
          readFileSync(p, "utf8").toLowerCase().includes(w.toLowerCase())).length, 0);
      return n > 0 ? [] : [`「${concept}」的 ${lang} 格标着 attested 却一次都没命中：${cell.words.join(" / ")}`];
    }));
    expect(wrong, `词表发霉了（守的是空气）：\n${wrong.join("\n")}\n`
      + "⇒ 要么改成 `reserve: true`，要么换一个这门语言真的在用的说法").toEqual([]);
  });

  it("词表双向登记（二）：标 reserve 的格子今天确实一次都没命中（命中了就该转成 attested）", () => {
    const wrong = RISK_WORDS.flatMap(([concept, cells]) => LANGS.flatMap((lang) => {
      const cell = cells[lang];
      if (cell.reserve !== true) return [];
      const hits = SHIP_DOCS.filter((p) => (p.startsWith("docs") ? p.split("/")[1] : "zh-CN") === lang)
        .flatMap((p) => cell.words.filter((w) => readFileSync(p, "utf8").toLowerCase().includes(w.toLowerCase()))
          .map((w) => `${p} 命中「${w}」`));
      return hits.length === 0 ? [] : [`「${concept}」的 ${lang} 格标着 reserve 却命中了：\n    ${hits.join("\n    ")}`];
    }));
    expect(wrong, `储备格用上了，登记该改成 attested（否则这些命中处不进 P5 的射程）：\n${wrong.join("\n")}`)
      .toEqual([]);
  });

  it("名册双向（一）：那两条登记今天确实还命中着词表（句子改写了就该删登记）", () => {
    const found = new Set(escapes(pairsOf(SHIP_DOCS)).map((x) => `${x.path}:${x.no}`));
    const stale = P5_OUTSIDE_ALERT.filter(([p, n]) => !found.has(`${p}:${n}`))
      .map(([p, n, why]) => `${p}:${n}（${why}）`);
    expect(stale, `这几条登记已经过期了，删掉它们：\n${stale.join("\n")}`).toEqual([]);
  });

  it("名册双向（二）：ADJ §63 钉死的那两节今天确实含着风险词（否则那条豁免也在守空气）", () => {
    const inPinned = pairsOf(SIX_READMES).flatMap(([p, t]) => {
      const lang: Lang = p === "README.md" ? "zh-CN" : (p.split("/")[1] as Lang);
      const titles = pinnedSectionTitles(p);
      return titles.flatMap((title) => {
        const raw = rawSection(t, title).toLowerCase();
        return RISK_WORDS.flatMap(([, cells]) =>
          cells[lang].words.filter((w) => raw.includes(w.toLowerCase())).map(() => `${p} ${title}`));
      });
    });
    expect(inPinned.length, "许可协议 / 免责声明两节里一个风险词都没有 —— "
      + "那「这两节不进 P5 射程」这条豁免守的是空气，该删").toBeGreaterThan(0);
  });
});
