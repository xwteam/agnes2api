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
