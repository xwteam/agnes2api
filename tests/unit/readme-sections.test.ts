/**
 * W38 —— README 章节标题常量表的自守判据。
 *
 * 表在 `tests/helpers/readme-sections.ts`，那里写了它是什么、译名从哪来、
 * 哪几格是新定的。这里只放**判据**。
 *
 * ── 一张还没有主消费者的表，判据能守什么 ────────────────────────────────
 * 这张表的主消费者是后续的「章节骨架」判据（根 16 节 / 语言版 12 节的 `toEqual`），
 * 而仓里六份 README 今天还是旧骨架，那条判据还立不起来。
 * 一张**只被自己读**的常量表是本仓反复登记过的坏形态：写完当天是对的，
 * 之后没有任何机器会因为它错了而变红。
 *
 * 所以这里做两件事，缺一不可：
 * ① **结构自守**——16/12 的划分、emoji 逐行五语言一致、无空格无 `UNKNOWN`、
 *    新定格子的登记完整。这些拦的是「编辑这张表时手滑」。
 * ② **接一个今天就真实存在的消费者**——`docs/{lang}/SPONSORS.md` 的 H1
 *    恰好就是本表下标 11（`## ☕ 赞赏 & 共享`）那一行去掉 `## `。
 *    五语言逐份对上，这张表就不是死的：**改坏表里那一行，这一格当场红**。
 *
 * ⚠️ **它验不了什么**：这张表的译名**对不对**。`## 🧪 統合例` 是不是比
 * `## 🧪 インテグレーション例` 更好，判据没有意见——12 行照抄参照仓、
 * 新定的 9 格逐一登记在 `COINED` 里等人复核，这是判据能给出的全部保证。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COINED,
  SECTIONS,
  SECTION_LANGS,
  type ReadmeSection,
  type SectionLang,
} from "../helpers/readme-sections.js";

/** 取一行的 emoji（`## ` 之后到下一个空格之前）。 */
const emojiOf = (title: string) => title.slice(3).split(" ")[0] ?? "";

/** 语言版承载的那 12 节。 */
const shared = (table: readonly ReadmeSection[]) => table.filter((x) => x.rootOnly !== true);

/** 一张表里所有说不通的地方，逐条给出人话。反向控制会拿改坏的表来喂它。 */
function tableFaults(table: readonly ReadmeSection[]): string[] {
  const faults: string[] = [];
  table.forEach((sec, i) => {
    const emojis = new Set(SECTION_LANGS.map((l) => emojiOf(sec.title[l])));
    if (emojis.size !== 1) {
      faults.push(`第 ${i} 行五语言的 emoji 不是同一个：${[...emojis].join(" / ")}`);
    }
    for (const lang of SECTION_LANGS) {
      const t = sec.title[lang];
      if (!t.startsWith("## ")) faults.push(`第 ${i} 行 ${lang} 不是以「## 」开头：${t}`);
      if (t.includes("UNKNOWN")) faults.push(`第 ${i} 行 ${lang} 还留着 UNKNOWN：${t}`);
      if (t.trim() !== t || t.includes("  ")) faults.push(`第 ${i} 行 ${lang} 有多余空白：${t}`);
      if (emojiOf(t) === "") faults.push(`第 ${i} 行 ${lang} 没有 emoji：${t}`);
    }
  });
  for (const lang of SECTION_LANGS) {
    const twelve = shared(table).map((x) => x.title[lang]);
    if (new Set(twelve).size !== twelve.length) {
      faults.push(`${lang} 的 12 节里有重名`);
    }
  }
  return faults;
}

describe("W38 README 章节标题常量表", () => {
  it("恰 16 节；根专属恰 4 节，落在下标 2 / 9 / 13 / 15；语言版承载 12 节", () => {
    expect(SECTIONS).toHaveLength(16);
    const rootOnlyAt = SECTIONS.flatMap((x, i) => (x.rootOnly === true ? [i] : []));
    expect(rootOnlyAt).toEqual([2, 9, 13, 15]);
    expect(shared(SECTIONS)).toHaveLength(12);
  });

  it("16 行的 emoji 序列逐字钉住（顺序变了就红）", () => {
    expect(SECTIONS.map((x) => emojiOf(x.title["zh-CN"]))).toEqual([
      "📝", "🌟", "🏗", "📋", "⚡", "🧪", "📡", "⚙",
      "⚠", "🗂", "🗺", "☕", "🙏", "⭐", "📄", "⚠",
    ]);
  });

  it("表本身说得通：五语言 emoji 逐行一致、都以「## 」开头、没有 UNKNOWN 与多余空白、12 节无重名", () => {
    expect(tableFaults(SECTIONS)).toEqual([]);
  });

  it("`⭐ Star History` 那一行五语言逐字节相同（en / ja 的历史实例都不翻译）", () => {
    const row = SECTIONS[13]!;
    expect(new Set(SECTION_LANGS.map((l) => row.title[l]))).toEqual(
      new Set(["## ⭐ Star History"]),
    );
  });

  it("新定的格子登记完整，且**一格都不在语言版承载的那 12 节里**", () => {
    expect(Object.keys(COINED).sort()).toEqual([
      "13:ko", "13:zh-TW", "15:ja", "15:ko", "15:zh-TW",
      "2:ja", "2:ko", "2:zh-TW", "9:zh-TW",
    ]);
    for (const key of Object.keys(COINED)) {
      const [idx, lang] = key.split(":") as [string, SectionLang];
      const sec = SECTIONS[Number(idx)];
      expect(sec, `COINED 的键 ${key} 指向不存在的行`).toBeDefined();
      expect(SECTION_LANGS).toContain(lang);
      // 12 节共享骨架在两个参照仓里逐字一致，一格都不该是新定的；
      // 真有一格落进来，说明照抄那一步出了问题。
      expect(sec!.rootOnly, `COINED 的 ${key} 落在了语言版也承载的那 12 节里`).toBe(true);
      expect(COINED[key]!.length, `COINED 的 ${key} 没写理由`).toBeGreaterThan(4);
    }
    // zh-CN 一格都不该出现在 COINED 里：16 行的简体标题全部照抄参照仓的根 README。
    expect(Object.keys(COINED).filter((k) => k.endsWith(":zh-CN"))).toEqual([]);
    // en 同理：四节根专属里，en 在参照仓的 `docs/en/README.md` 都有实例。
    expect(Object.keys(COINED).filter((k) => k.endsWith(":en"))).toEqual([]);
  });

  it("阳性对照：五份 SPONSORS.md 的 H1 就是本表下标 11 那一行（这张表今天就有真实消费者）", () => {
    for (const lang of SECTION_LANGS) {
      const h1 = readFileSync(join("docs", lang, "SPONSORS.md"), "utf8").split("\n")[0];
      expect(h1, `docs/${lang}/SPONSORS.md 的首行`).toBe(
        SECTIONS[11]!.title[lang].replace(/^## /, "# "),
      );
    }
  });
});

describe("W38 的反向控制（拿改坏的表喂同一个检查函数）", () => {
  const mutate = (i: number, lang: SectionLang, title: string): ReadmeSection[] =>
    SECTIONS.map((sec, k) =>
      k === i ? { ...sec, title: { ...sec.title, [lang]: title } } : sec,
    );

  it("① 把某一行的 ja emoji 换掉 ⇒ 报「五语言的 emoji 不是同一个」", () => {
    const faults = tableFaults(mutate(5, "ja", "## 🔬 統合例"));
    expect(faults).toEqual(["第 5 行五语言的 emoji 不是同一个：🧪 / 🔬"]);
  });

  it("② 把某一格写回 UNKNOWN ⇒ 报 UNKNOWN（这正是 T3 里那两处待办的形态）", () => {
    expect(tableFaults(mutate(15, "ko", "## ⚠ UNKNOWN"))).toContain(
      "第 15 行 ko 还留着 UNKNOWN：## ⚠ UNKNOWN",
    );
  });

  it("③ 把 12 节里的两行写成重名 ⇒ 报 zh-TW 重名（重名判的是整行，不是只判名字）", () => {
    // ⚠️ 实测过一次：写成 `## 🙏 核心功能`（只搬名字、留着本行的 emoji）**不算重名**
    //   ——重名判的是整行逐字相等，emoji 不同就是两行。要造重名得连 emoji 一起搬。
    expect(tableFaults(mutate(12, "zh-TW", "## 🌟 核心功能"))).toContain("zh-TW 的 12 节里有重名");
  });

  it("④ 掉了 `## ` 前缀 ⇒ 报出来，不会静静放行", () => {
    expect(tableFaults(mutate(0, "en", "📝 Recent Updates"))).toContain(
      "第 0 行 en 不是以「## 」开头：📝 Recent Updates",
    );
  });

  it("⑤ 改坏下标 11 那一行 ⇒ SPONSORS 阳性对照当场对不上", () => {
    const bad = mutate(11, "ja", "## ☕ スポンサー")[11]!;
    const h1 = readFileSync(join("docs", "ja", "SPONSORS.md"), "utf8").split("\n")[0];
    expect(h1).not.toBe(bad.title.ja.replace(/^## /, "# "));
  });
});
