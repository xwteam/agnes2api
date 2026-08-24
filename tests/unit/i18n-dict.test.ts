import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { TEND_FAILURE_REASONS } from "../../src/core/registrar/tender.js";
import { stripComments } from "../helpers/strip-comments.js";
import { UNVERIFIED_KEYS, UNVERIFIED_BANNED } from "../../scripts/lib/unverified-claims.mjs";

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;

// ── 「板块里当参数传的 i18n key」那道广扫的判据本体 ─────────────────────────────
// **整块从那条用例体里原样搬到模块作用域，判据一个字符没改。** 搬的理由只有一个：
// 让「毒刺在场时它还看不看得见」那一格能在内存里拼坏文本喂给同一个判据，
// 而不是另抄一份扫描逻辑（另抄一份的话，探针绿而真扫描瞎，两者永远不会互相揭发）。
//
// `set` 是 P3c Task 7 的设置页。**加新板块必须回来表态**，理由见下面那条用例上方的 ⚠️。
// ⚠️ `usage` 是 P3d Task 5 的用量板块。它进这张表**不是形式**：那个板块的
// 62 个新 key 里绝大多数走的正是 `elI18n(tag, key)`（`scripts/check-i18n.mjs`
// 的第 ① 条只认 `t("…")` 与 `data-i18n="…"`，对它们完全隐身），
// 不进表的话打错一个字母三道 i18n 门禁会一起沉默、面板上显示裸 key。
// ⚠️ `models` 是 P3d Task 6 的模型板块。它进这张表**不是形式**：那个板块的
// 每一个 key 走的都是 `elI18n(tag, key)` 或者当参数传给 `modalityLabelKey()`
// 的字面量，`scripts/check-i18n.mjs` 的第 ① 条对它们完全隐身，
// 不进表的话打错一个字母三道 i18n 门禁会一起沉默、面板上显示裸 key。
// ⚠️ `pg` 是 P3d Task 10 的 Playground 板块，**它进这张表的理由比前几个板块更硬**：
// 那个板块有整整一族 key **根本不出现在 `t(` 或 `data-i18n=` 里**——
// 它们是当**返回值**从 `hintNoteKey()` / `sendBlockedKey()` 交出去、
// 再被 `elI18n(tag, key)` 或 `setAttribute("title", t(key))` 消费的字面量。
// 实测：`scripts/check-i18n.mjs` 对 `pg.*` 41 个 key 里的 **37 个**只报
// 「未被引用」的**警告**（第 ④ 条从不 exit 1）⇒ 打错一个字母，三道 i18n 门禁一起沉默，
// 面板上五种语言全部显示裸 key。
// **那个板块新增 41 个 `pg.*` + 1 个 `nav.playground`（导航项，理由见字典里那一行），
// 下面那条用例是它们拼写的全部机器保障。** 别在任何地方写成「由 i18n 门禁保证」。
// ⚠️ **它守的是拼写，不是措辞**：「日文那句话通不通顺」没有任何东西在守。
//
// ⚠️⚠️ **上面三条 ⚠️ 里「门禁对它们完全隐身」说的是 P3e Task 3 之前的门禁，别当现状读。**
// 那之后 `scripts/check-i18n.mjs` 的第 ① 条换成了「命名空间前缀锚定的引号对」广扫
//（先抠注释、两种引号都扫），`elI18n(tag, key)` / return / 三元 / 数组·参数位那几族它现在都认得：
// 真仓实测「直接引用」从 125 处涨到 496 处，「未被引用」从 396 条降到 3 条。
// ⚠️⚠️ **`pg` 那一段里「只报『未被引用』的警告（第 ④ 条从不 exit 1）」同样是史实、不是现状**
//（P3e Task 4 复评 F1 补登记）：Task 4 把第 ④ 条升成了**硬错**，`warnings` 数组也一并删了
// ⇒ 今天真打错一个字母，`scripts/check-i18n.mjs` 这道门禁 exit 1，不再有「一条没人看的警告」这一档。
// **那三段仍然逐字留着，因为它们记的是这张表当初为什么被建起来**——那是史实，不是现状。
//
// ⇒ **这张表今天的存在理由换了一条，写在这里**：它是**手写登记**，门禁那边是**从字典自动派生**，
// 两条不同的路回答同一个问题。手写表会漏掉新板块（那由下面三条反向自检在防），
// 自动派生不会漏但也不会逼人表态。**两者都留着，才是这一半还没被收编的那份冗余。**
const NAMESPACES = [
  "gate", "nav", "shell", "common", "reg", "keys", "ov", "ev", "set", "usage", "models", "pg",
] as const;
// ⚠️ **两种引号都要扫。** 与 `scripts/check-i18n.mjs` 规则 ⑧ 早就补上的那条同源：
// 实测 `elI18n('h2','usage.titel')`（单引号 + 拼错）能让六道脚本门禁 + 全量用例
// 一起放行，而用量板块主标题在五种语言下原样显示 `usage.titel`。
// **模板字面量（反引号）仍不扫**，理由照 `check-i18n.mjs` 已写明的那条：
// 那种写法通常是动态拼 key，静态判据本来就管不了，硬扫只会误报。
const NS_KEY_RE = new RegExp(`["']((?:${NAMESPACES.join("|")})\\.[A-Za-z0-9_.]+)["']`, "g");

// ── 另外三条判据同样搬到模块作用域 ────────────────────────────────────────────
// 搬的理由与上面 `NS_KEY_RE` 那一条**逐字相同**：探针必须喂给**真扫描用的那一份**判据。
// 另抄一份的话，探针绿而真扫描瞎，两者永远不会互相揭发。
// **搬运时判据一个字符没改**，改判据是紧接着的下一步、单独一次改动。
//
// ⚠️ `ATTR_KEY_RE` / `T_CALL_KEY_RE` 归「admin-ui 里引用的每个 key 都在字典里」那一格，
// `NS_PREFIX_RE` 归「板块里当参数传的 i18n key（elI18n / labelKey 这类）同样必须在字典里」
// 那一格里的**反向自检 ②**。
// ⚠️ **这三条与上面 `NS_KEY_RE` 同一条理由：两种引号都要扫、反引号仍然不扫。**
const ATTR_KEY_RE = /data-i18n(?:-ph|-title)?=["']([^"']+)["']/g;
const T_CALL_KEY_RE = /\bt\(["']([^"']+)["']/g;
const NS_PREFIX_RE = /["']([a-z]+)\.[A-Za-z0-9_.]+["']/g;

const walkJs = (d: string): string[] =>
  readdirSync(d).sort().flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walkJs(p) : /\.(js|mjs)$/.test(p) ? [p] : [];
  });

/**
 * 一段源码里被当字面量写出来的 `"<已知命名空间>.<键名>"`。
 *
 * **先去注释再扫。** 这个仓库的注释极其爱复述代码（下面那条用例第一版就被
 * `admin-ui/js/sec-keys.js` 里一句「不许拼 `"keys.bucket." + b`」的说明打红）。
 * 抠注释走 `scripts/lib/strip-comments.mjs` 那一份真源（P3e Task 1 收编）——
 * 本文件原来自持一份正则实现，而那一份**认不出字符串里的斜杠星号**，
 * 一根路由 glob 毒刺就能让整道广扫变瞎。
 */
const referencedKeysIn = (src: string): string[] =>
  [...stripComments(src).matchAll(NS_KEY_RE)].map((m) => m[1]!);

/**
 * 一段源码里 `data-i18n*=` 属性与字面的 `t(…)` 调用首参写出来的 key。
 *
 * ⚠️ **这一条刻意不抠注释**，与上面 `referencedKeysIn` 不同。那不是笔误，是一条
 * **登记在案的遗留**（P3e Task 4 的 L5）：它与同文件那条广扫、以及
 * `scripts/check-i18n.mjs` 的第 ① 条口径不一致 ⇒ 在 `admin-ui/` 的注释里把这两种
 * 形态写全、值取一个字典里没有的串，这一格会**假红**而那道门禁 EXIT=0。
 * **修法是把调用点的 `readFileSync` 包一层 `stripComments`，本任务按界不动**
 *（本任务只改「认几种引号」，见下面 `attrAndTKeysIn` 那一族探针）。
 * ⚠️ **在它被修掉之前，`admin-ui/js/i18n-dict.js` 与 `admin-ui/js/pure/usage.mjs`
 * 两处「别在注释里把形态写全」的纪律必须留着**——本任务把这一条**放宽成引号无关**，
 * 那条纪律的**射程因此变大了**（单引号写法从此也会踩响），不是变小了。
 */
const attrAndTKeysIn = (src: string): string[] => [
  ...[...src.matchAll(ATTR_KEY_RE)].map((m) => m[1]!),
  ...[...src.matchAll(T_CALL_KEY_RE)].map((m) => m[1]!),
];

/** 一段源码里被当字面量写出来的 `"<某个纯小写前缀>.<键名>"` 里的**前缀**。先抠注释，理由同上。 */
const namespacePrefixesIn = (src: string): string[] =>
  [...stripComments(src).matchAll(NS_PREFIX_RE)].map((m) => m[1]!);

/**
 * 字典的结构性断言。**与 `scripts/check-i18n.mjs` 用不同的代码路径回答同一批问题**：
 * 门禁脚本在 CI 上是单独一步（`node scripts/check-i18n.mjs`），这份跟着 `pnpm test` 跑，
 * 两条入口互不遮蔽，其中一份写错时另一份会不同意。
 * （P3a 的教训是反过来的：CI 只有一份实现、且没人验证它跑没跑过，
 *   于是加了 tee + grep 横幅。这里换一种做法——冗余实现。）
 *
 * ⚠️⚠️ **「冗余」的边界从 P3e Task 1 起变窄了，别再宣称「两边处处独立」**：
 * 本文件的抠注释器已经收编成 `scripts/lib/strip-comments.mjs` 那一份真源，
 * 而 P3e Task 3 起 `scripts/check-i18n.mjs` 第 ① 条也 import 了同一份 ⇒
 * **「怎么把注释抠掉」两边将是同一份实现，它错了两边一起错。**
 * 那是刻意的：两份抠注释器不一致时，瞎掉的那一份才是会报绿的那一份。
 * **仍然冗余的是另一件事**：本文件手写 `NAMESPACES` 登记表 + 三条反向自检，
 * 与门禁脚本那边「从字典自动派生」是两条不同的路，那一半没有被收编。
 */
describe("i18n 字典", () => {
  it("每个 key 都有全部 5 种语言且非空", () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(I18N)) {
      for (const lang of LANGS) {
        const s = (v as Record<string, unknown>)[lang];
        if (typeof s !== "string" || s.trim() === "") bad.push(`${k} / ${lang}`);
      }
    }
    expect(bad, "缺翻译的键").toEqual([]);
  });

  it("每个 key 只有这 5 种语言，没有多余的语言码（拼错的语言码会静默地永远取不到）", () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(I18N)) {
      const extra = Object.keys(v as object).filter((x) => !LANGS.includes(x as never));
      if (extra.length) bad.push(`${k}: ${extra.join(",")}`);
    }
    expect(bad).toEqual([]);
  });

  it("插值 token 在 5 种语言里集合相同", () => {
    // ⚠️ **`?? ""` 是必须的，不是防御性代码噪音**：某个语言的翻译整个缺失时
    // （比如被误删），`s` 会是 `undefined`，裸调用 `.matchAll` 直接抛 `TypeError`——
    // 这条断言仍然会让测试变红（不漏判），但诊断退化成一条与「插值占位符对不上」
    // 毫无关系的堆栈信息，可读性远不如上面「每个 key 都有全部 5 种语言」那条已经
    // 给出的明确失败原因。`scripts/check-i18n.mjs` 里同一处逻辑一直是
    // `String(row[l] ?? "")`，这里之前没对齐，现在补上。
    const tokens = (s: string | undefined) =>
      [...String(s ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(",");
    const bad: string[] = [];
    for (const [k, v] of Object.entries(I18N)) {
      const sets = LANGS.map((l) => tokens((v as Record<string, string>)[l]));
      if (new Set(sets).size !== 1) bad.push(`${k}: ${sets.join(" | ")}`);
    }
    expect(bad, "同一个键在不同语言里的插值占位符对不上").toEqual([]);
  });

  /**
   * 设计文档 §10.3 第 4 条：通道相关命名空间的禁用词。
   * **这比人工评审可靠，是唯一能长期防住「某次改文案顺手写了『推荐使用 X』」的机制。**
   *
   * ⚠️ 禁用词表比设计文档 §9.1 多了**繁体变体**（推薦 / 建議 / 預設 / 首選 / 優先）。
   * 理由是 P3a Task 9 的原样教训：控制端查五语言对等时 grep 用了简体「保证」，
   * 漏掉繁体「保證」，于是报告说齐全而实际不齐。简体表在 zh-TW 上等于没有检查。
   *
   * ⚠️⚠️ **作用域在 P3e Task 7 从「只有 `reg.*`」扩成了下面那张前缀表，
   * 而这一份与 `scripts/check-i18n.mjs` 的规则⑥ 是两份独立实现**（那边是 CI 上单独一步
   * `node scripts/check-i18n.mjs`，这边跟着 `pnpm test` 跑，各写各的循环）。两件事同时补上：
   * · 用户那条硬约束「YYDS 与 MoeMail 严格同级，不替人选主备」的落点是**设置页**——
   *   两条通道共用的那对凭据 key 与主 / 备两个选择器标签在这之前全在门外；
   * · `keys.addMenu.auto*` 是那道门禁**早就**扩过的范围，而这一份一直没跟上
   *  （门禁那边扩了、这边没扩 ⇒ 那一族只剩一份实现在守，「两份互为印证」当时是假的）。
   *
   * ⚠️ **刻意不是整个 `set.*`**（与门禁那边同一条推理，删了下一个人会顺手扩宽）：
   * `set.*` 里有大量与通道无关、且**正当地**会出现「默认 / 优先 / 推荐」的运维文案
   *（超时、冷却、口令）。扩太宽 = 这道今天零命中的干净规则立刻要带一册豁免名单，
   * 而本仓的裁定是「开豁免名册比没有规则更糟」。
   *
   * ⚠️ **边界（明写，别宣称成「杜绝一切偏好表述」）**：这是纯词面匹配，
   * 「两条里挑一条的话就用 X」这种不含禁用词的偏好表述它抓不住，那一档留给评审。
   * 想在作用域内合法地说「默认值」时，正确做法是**把那条文案放进别的命名空间**，
   * 而不是给这张表开豁免——前缀表就是这条规则的作用域。
   *
   * ⚠️⚠️ **最后两条（`ov.config.primary` / `ov.config.fallback`）是本轮追加的**，
   * 与 `scripts/check-i18n.mjs` 同一次改动、同一条起因：韩文实测里 `ov.config.primary`
   * 的 ko 值写成了「기본 채널」（＝默认通道），而同一概念在 `reg.primary` /
   * `set.field.registrar.primary` 都是「주 채널」（＝主通道）——概览页把「槽位」
   * 说成了「默认值」，正是用户那条硬约束明令禁止的暗示。
   * **登记的是两条整 key，不是 `ov.config.` 前缀**：`ov.config.` 底下的
   * `envLockedTip`（zh-CN/zh-TW/ja 正当地用「优先/優先」描述环境变量优先级）与
   * `degradedBanner`（zh-CN/zh-TW/en/ko 正当地用「默认/預設/default/기본」描述配置
   * 降级回落到默认值）都与「两条通道平级」无关，扩宽前缀会把这两条正当文案一起
   * 打红，逼着开豁免名册——理由与上面「刻意不是整个 `set.*`」同一条。
   */
  it("通道相关命名空间不出现任何偏好词（含繁体变体）", () => {
    const BANNED = [
      "推荐", "推薦", "建议", "建議", "默认", "預设", "預設", "主流", "首选", "首選", "优先", "優先",
      "recommended", "preferred", "default",
      "おすすめ", "推奨", "권장", "기본",
    ] as const;
    const PREFIXES = [
      "reg.",
      "keys.addMenu.auto",
      "set.field.registrar.primary",
      "set.field.registrar.fallback",
      "set.field.channel.",
      "set.card.registrar",
      "ov.config.primary",
      "ov.config.fallback",
    ] as const;
    const hits: string[] = [];
    for (const [k, v] of Object.entries(I18N)) {
      if (!PREFIXES.some((p) => k.startsWith(p))) continue;
      for (const lang of LANGS) {
        const s = ((v as Record<string, string>)[lang] ?? "").toLowerCase();
        for (const w of BANNED) if (s.includes(w.toLowerCase())) hits.push(`${k}/${lang}: ${w}`);
      }
    }
    expect(hits, "两条邮箱通道必须完全平级，文案里不许出现偏好词").toEqual([]);
    /**
     * **反向自检：这张前缀表不许有死条目。**
     * 少了它，把某条前缀打错一个字符（`set.card.registar`）就等于把那一族悄悄放行，
     * 而上面那条 `toEqual([])` 只会更绿。**「警报变少」与「判据认对了」长得一模一样**，
     * 分辨两者靠的就是这一格。
     */
    const dead = PREFIXES.filter((p) => !Object.keys(I18N).some((k) => k.startsWith(p)));
    expect(dead, "这些前缀在字典里一个 key 都对不上 —— 要么打错了字，要么那一族已经改名").toEqual([]);
  });

  /**
   * **未核实的事不许被说成已核实**（P3e Task 7；`scripts/check-i18n.mjs` 规则⑨ 的第二份扫描）。
   *
   * 用户点名的红线是：真机了结之前，任何文案都不许把「上限是 60 次」写成「60 次是安全的」。
   * `usage.range.retention` 那句今天如实写着「尚未在真机上验证过」，
   * 把它改成「在 Worker 上没问题」是一次纯文案改动，**在这条判据出现之前没有任何机器在看**。
   *
   * ⚠️ **两张表与门禁那边共用一份真源**（`scripts/lib/unverified-claims.mjs`），
   * **扫描是各写各的**：理由写在那份文件头——表抄成三份时，守表的那条自检守的是它自己那份副本。
   * 表**自身**不空转由 `tests/unit/check-i18n.test.ts` 的
   * 「⑨ 反向自检：白名单非空、词表非空、且白名单里每个 key 都真的在字典里」那一格钉着。
   *
   * ⚠️ **边界：它证明的只是「没有人把未核实的事说成已核实」，不证明译文准确。**
   */
  it("未核实的事不许被说成已核实（白名单 × 词表的交集）", () => {
    const hits: string[] = [];
    for (const k of UNVERIFIED_KEYS) {
      const row = (I18N as Record<string, Record<string, string> | undefined>)[k];
      // 表里指着一个字典里没有的 key ⇒ 那一条红线已经无人再守，当场说出来，不许静默跳过。
      if (row === undefined) { hits.push(`${k}: 白名单里这个 key 不在字典里`); continue; }
      for (const lang of LANGS) {
        const s = (row[lang] ?? "").toLowerCase();
        for (const w of UNVERIFIED_BANNED) {
          if (s.includes(w.toLowerCase())) hits.push(`${k}/${lang}: ${w}`);
        }
      }
    }
    expect(hits, "这几条文案描述的是尚未在真机上核实的事，不许写成已经核实过的口吻").toEqual([]);
  });

  /**
   * **同一个概念在 ja 里只许有一个术语**（P3e Task 7 / NEW-7）。
   *
   * 勘察实测的那一处：`reg.primary` 写的是 `プライマリチャネル`，
   * 而 `set.field.registrar.primary` 写的是 `主チャネル`（`docs/ja/REGISTRAR.md` 用的也是后者）——
   * 同一个东西，面板上两个日文词。真正要命的是**它会被下一次改词坐实**：
   * G2 那轮若只改 `set.field.*` 一侧而不动 `reg.*`，两个词就从「一次疏漏」变成「两套术语」。
   *
   * ⚠️⚠️ **这一格刻意不写死是哪个词**（`toBe("主チャネル")` 那种写法）。
   * 主 / 备措辞本身还悬着三个候选，将来真换词时**三个 key 会一起换**——
   * 写死词的断言那时会红在一件完全正确的改动上，而写死"只许有一个"的断言不会：
   * 它红的时候，红的正是「只改了一半」那一种。
   */
  it("同一个概念在 ja 里只有一个术语 —— 主通道那一族", () => {
    const LABEL_KEYS = ["reg.primary", "set.field.registrar.primary", "ov.config.primary"] as const;
    const ja = (k: string): string => ((I18N as Record<string, Record<string, string>>)[k] ?? {}).ja ?? "";
    // 反向自检：这张表不许空转（key 改了名之后下面几条会在空字符串上恒真）。
    expect(LABEL_KEYS.filter((k) => !(k in I18N)), "表里有字典中不存在的 key").toEqual([]);
    expect([...new Set(LABEL_KEYS.map(ja))], "同一个概念在 ja 里出现了不止一个术语").toHaveLength(1);
    const term = ja(LABEL_KEYS[0]);
    expect(term.length, "ja 值是空的 ⇒ 上面那条 `toHaveLength(1)` 是恒真的").toBeGreaterThan(0);
    // 整句文案与短标签也必须用同一个词，不许各说各的。
    expect(ja("reg.emptyPrimary"), "那句「两条通道平级，请选择一条作为主通道」用的是另一个日文词").toContain(term);
    expect(term, "短标签 reg.role.primary 用的是另一个日文词").toContain(ja("reg.role.primary"));
    expect(ja("reg.tend.channelAny"), "补池范围那句用的是另一个日文词").toContain(ja("reg.role.primary"));
  });

  /**
   * 设计文档 §7.3 / §9.1 第 6 条：`TendFailureReason` 的每个联合成员都要有
   * `reg.fail.<reason>` 键。P2 特意把它收成联合类型正是为了 P3 消费时保有穷尽性，
   * 「这笔前期投资这次要用上」。
   *
   * **本期先把键写齐（含五种语言），P3c 的注册机板块才真正渲染它们。**
   * 先写的理由：一道从上线第一天就被豁免的门禁永远不会被启用。
   */
  it("TendFailureReason 的每个成员都有 reg.fail.<reason> 键", () => {
    const missing = TEND_FAILURE_REASONS.filter((r) => !(`reg.fail.${r}` in I18N));
    expect(missing, "补池失败归因缺 i18n 键").toEqual([]);
    expect(TEND_FAILURE_REASONS.length, "联合成员数变了，请在评审里确认").toBe(12);
  });

  it("字典全文不命中 scan-secrets.sh 的 IP:PORT 正则", () => {
    const hits: string[] = [];
    for (const [k, v] of Object.entries(I18N)) {
      for (const lang of LANGS) {
        const s = (v as Record<string, string>)[lang]!;
        if (/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{2,5}/.test(s)) hits.push(`${k}/${lang}`);
      }
    }
    expect(hits, "文案里出现「数字IP:端口」会把 CI 的凭据扫描打红").toEqual([]);
  });

  /**
   * 源码里引用到的每个 key 都必须在字典里。
   * 反向那一半（字典里没被引用的）归 `scripts/check-i18n.mjs` 的第 ④ 条 ——
   * ⚠️ **上一版这里写的是「只警告」，那句话在 P3e Task 4 之后是假的：它已升成硬错。**
   */
  it("admin-ui 里引用的每个 key 都在字典里", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).sort().flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(html|js|mjs)$/.test(p) ? [p] : [];
      });
    const used = new Set<string>();
    for (const p of walk("admin-ui")) {
      // 判据本体（`ATTR_KEY_RE` / `T_CALL_KEY_RE` / `attrAndTKeysIn`）在模块作用域，
      // 理由见那里的说明：探针必须与真扫描走同一份判据。
      for (const k of attrAndTKeysIn(readFileSync(p, "utf8"))) used.add(k);
    }
    const missing = [...used].filter((k) => !(k in I18N)).sort();
    expect(missing, "引用了字典里没有的 key，运行时会原样显示 key 本身").toEqual([]);
    // 反向自检：扫描一个键都没找到时上面那条恒绿（第 6 种假阳性的近亲）。
    //
    // ⚠️⚠️ **别再把这一条读成「与 scripts/check-i18n.mjs 那道门槛是同一条边界」——
    // 那句话 P3e Task 3 之后不成立了，那边的门槛已经删掉。**
    // 上一版在这里写着：两处必须同边界，否则会在「恰好等于 15」上永久一绿一红。
    // 复评实测两侧量的**根本不是同一个量**：这一条只认 `data-i18n*=` 属性与 `t(` 首参
    // 两种窄形态、不抠注释；那道门禁走的是抠完注释的命名空间广扫，数出来是这里的好几倍。
    // ⚠️ **「窄」说的是形态窄，不是引号窄**：P3e Task 5 起这两种形态**单双引号都认**
    //（判据本体见模块作用域的 `ATTR_KEY_RE` / `T_CALL_KEY_RE`）。
    // 「不抠注释」那一半仍然成立，那是登记在案的遗留（Task 4 的 L5）。
    // 「恰好等于 15」两侧都不可达 ⇒ 那条对齐论证是空转的，而那道门槛在它自己那一侧
    // 有 97% 的死区（判据瞎掉九成七它仍然一声不吭），已按「一条走不到的门槛不是守卫，
    // 是待办」删除。
    //
    // ⚠️ **留在这里的这一条只当它自己那一半的反向自检用，别给它加戏**：
    // 它拦的是「上面那个 `walk()` 整个塌掉、一个键都没扫到」这一种，
    // 拦不住「扫瞎了一半」。真正分辨「认对了」与「瞎了」的是下面那条按命名空间前缀
    // 扫字面量的用例，以及 `tests/unit/check-i18n.test.ts` 的
    //「(a)(b) elI18n(%s…) 里拼错的 key 被抓住（%s 形态）：exit 1」那两格正向探针。
    expect(used.size, "一个 i18n 引用都没扫到，扫描本身坏了").toBeGreaterThanOrEqual(15);
  });

  /**
   * 上面那条只认两种形态：`data-i18n*=` 属性与字面的 `t(` 调用首参（**单双引号都认**，
   * P3e Task 5 起；上一版这里把两种形态连同双引号一起写死，那半句今天是假的）。
   * **板块把 key 当参数传给 `elI18n()` / `openModal()` 时它看不见**（Task 3 的
   * `ui.js` 里 `{ labelKey: "common.cancel" }` 就是这一类，check-i18n 当时只把它报成
   * 「未被引用」的警告）。于是 Task 4 的 `elI18n("th", "keys.col.seq")` 打错一个字，
   * 运行时会原样显示那个 key，而两道 i18n 门禁一声不吭。
   *
   * ⚠️⚠️ **上面这段、以及下面那条评审实测，记的都是 P3b 当时的状况，别当现状读**
   *（P3e Task 4 复评 F1 补登记）：`scripts/check-i18n.mjs` 的第 ① 条在 P3e Task 3 换成了
   * 「抠完注释的命名空间广扫」、第 ④ 条在 P3e Task 4 升成硬错 ⇒ `elI18n(tag, key)` 那一族
   * 它今天认得，拼错一个字母当场 exit 1（单双引号都算）。
   * **这一条用例的存在理由因此换了一条**（与文件头 `NAMESPACES` 上方那段同源）：
   * 它是**手写登记**那条路，与门禁那边的**自动派生**互为印证，
   * 不再是「唯一还在守的那一层」。
   *
   * 这一条按**命名空间前缀**扫字面量补上那个缺口：admin-ui 的 JS 里凡是长得像
   * `"<已知命名空间>.<键名>"` 的字符串，都必须真的在字典里。
   * 前缀表手写，加新命名空间要在这里表态——这与本仓其它「手写清单」是同一套做法。
   *
   * ⚠️ **`ov` 与 `ev` 是全分支评审 I6 补进来的，补之前它们不在表里**——
   * 而那正是 P3b 本期新增的两个板块（概览、事件）。"加新命名空间要在这里表态"
   * 这句话就写在上面一行，本期加了两个板块却没人回来表态。
   * 评审实测：把 `sec-overview.js` 的 `elI18n("h2", "ov.title")` 改成 `"ov.titel"`，
   * **三道 i18n 门禁全部沉默**，概览页的主标题在五种语言下原样显示 `ov.titel`。
   * 下面那条"至少 20 个"的反向自检也拦不住它：Key 池板块一家就够 20 个。
   */
  it("板块里当参数传的 i18n key（elI18n / labelKey 这类）同样必须在字典里", () => {
    // 判据本体（`NAMESPACES` / `NS_KEY_RE` / `referencedKeysIn`）在模块作用域，
    // 理由见那里的说明：探针必须与真扫描走同一份判据。
    const referenced = new Set<string>();
    for (const p of walkJs("admin-ui/js")) {
      // 字典自己就是这些键的定义处，扫它等于自证。
      if (p.endsWith("i18n-dict.js")) continue;
      for (const k of referencedKeysIn(readFileSync(p, "utf8"))) referenced.add(k);
    }
    expect([...referenced].filter((k) => !(k in I18N)).sort(), "板块引用了字典里没有的 key").toEqual([]);
    // 反向自检：扫描坏成空集时上面那条恒绿。Task 4 的 Key 池板块一家就有 20+ 个。
    expect(referenced.size, "一个都没扫到，扫描本身坏了").toBeGreaterThanOrEqual(20);
    /**
     * **反向自检 ②：`NAMESPACES` 这张表本身不许漏掉一个真的在用的命名空间。**
     *
     * ⚠️ **这一格的判据方向是自查改过来的。** 第一版写的是「表里每个前缀都要扫到
     * 至少一个引用」，拿变异一试就发现它**只挡加错的、挡不住删掉的**：把 `ov`/`ev`
     * 从表里删掉，那两个前缀连同它们的引用一起从计算里消失，集合纹丝不动、8 条全绿
     * ——而"本期加了两个板块却没人回来把它们加进表里"**正是这次真实发生的事**。
     * 判据必须反过来建：**从字典里已有的命名空间出发**，凡是在 `admin-ui/js` 里
     * 真的被用作 key 前缀的，都必须在表里。
     */
    const dictNamespaces = new Set(
      Object.keys(I18N).map((k) => k.split(".")[0]!).filter((p) => /^[a-z]+$/.test(p)),
    );
    const usedNamespaces = new Set<string>();
    for (const p of walkJs("admin-ui/js")) {
      if (p.endsWith("i18n-dict.js")) continue;
      // 判据本体（`NS_PREFIX_RE` / `namespacePrefixesIn`）同样在模块作用域，理由同上。
      for (const ns of namespacePrefixesIn(readFileSync(p, "utf8"))) {
        if (dictNamespaces.has(ns)) usedNamespaces.add(ns);
      }
    }
    expect(
      [...usedNamespaces].filter((ns) => !(NAMESPACES as readonly string[]).includes(ns)).sort(),
      "这些命名空间在 admin-ui/js 里真的被用作 key 前缀，却不在 NAMESPACES 表里"
      + "——这一条对那一段 key 整个失效（另一半由 check-i18n.mjs 的命名空间广扫接着，"
      + "但那一半是自动派生的，不会逼人回来表态）",
    ).toEqual([]);

    /**
     * **反向自检 ③：表里不许有死条目。** 与 ② 是同一件事的另一半
     *（② 挡"漏了"，③ 挡"多了 / 前缀写错"）。
     *
     * 今天为空的两个各有其**如实的**理由，都不是缺陷：
     * · `shell` / `nav` —— 壳层标题与六个导航按钮的文案全写在 `index.html` 的
     *   `data-i18n` 属性里，而本条扫的是 `admin-ui/js` 下的 `.js`/`.mjs`。那一半由
     *   `scripts/check-i18n.mjs` 的第 ① 条覆盖（它连 `.html` 一起走）。
     *
     * ⚠️ **`reg` 在 P3c Task 6 离开了这张空表**：注册机板块落地之后，
     * `sec-registrar.js` 与 `pure/registrar.mjs` 真的开始引用 `reg.*` 了。
     * 这一格因此从三条变成两条——**它变红正是它在起作用**（上一版那段说明写着
     * 「注册机板块整个排在 P3c，字典先铺好、还没有任何消费者」，那句话现在是假的）。
     */
    const emptyNamespaces = NAMESPACES.filter((ns) => !usedNamespaces.has(ns));
    expect(
      [...emptyNamespaces].sort(),
      "一个引用都没扫到的命名空间集合变了——要么前缀写错/该删，要么某个空的前缀"
      + "终于有了 JS 消费者，回来把上面那段说明改准",
    ).toEqual(["nav", "shell"]);
  });

  /**
   * **第 10 种假阳性：一根长得完全正常的毒刺让 NAMESPACES 广扫变瞎（P3e Task 1）。**
   *
   * 形状与 `tests/ui/dom/fake-dom-parity.test.ts` 的
   * 「字符串里的 /* 不再让这道扫描变瞎 —— 毒刺与真缺陷同时在场时仍要抓到 NodeList.map()」
   * 逐字相同，只换了目标缺陷（这里是一个字典里没有的假 key）。
   * 三行的顺序同样是量出来的：闭合记号必须在缺陷之后，否则正则版也绿、这一格零鉴别力。
   */
  it("字符串里的 /* 不再让 NAMESPACES 广扫变瞎 —— 毒刺与假 key 同时在场时仍要抓到", () => {
    const poisoned = [
      'const ADMIN_API_GLOB = "/admin/api/*";',
      'elI18n("h2", "models.zzzParamKey");',
      "/* 提供闭合记号的普通块注释 */",
    ].join("\n");
    expect(referencedKeysIn(poisoned), "毒刺在场时这道扫描仍必须看得见被当参数传的 key")
      .toContain("models.zzzParamKey");
    // **反向控制（「我对 X 不乱红」那一半）**：把假 key 那一行拿掉、毒刺与闭合记号原样留着，
    // 这道扫描不许凭空报出它。少了这条，上面那条 `toContain` 可能只是因为扫描器见谁都报。
    const poisonOnly = [
      'const ADMIN_API_GLOB = "/admin/api/*";',
      "/* 提供闭合记号的普通块注释 */",
    ].join("\n");
    expect(referencedKeysIn(poisonOnly), "假 key 不在场时不许报出它 —— 否则上面那条是恒真的")
      .not.toContain("models.zzzParamKey");
  });

  /**
   * **本文件哪一条与 `scripts/check-i18n.mjs` 共用抠注释真源，钉成断言（P3e Task 15A 复评）。**
   *
   * 那道门禁的文件头写着「抠注释两边是同一份实现」，而**上一版把这句话锚在了错的那一条**
   *（锚给了只认 `data-i18n*=` 属性与 `t(` 首参那条，可那条根本不调 `stripComments`）。
   * 实测坐实：把 `scripts/lib/strip-comments.mjs` 退化成恒返回空串，被它锚住的那一格**照样绿**。
   * **一句指错了对象的话不会有任何机器为它红**，所以这里把两边的分界线写成会红的断言：
   * · `referencedKeysIn` 先抠注释 ⇒ 注释里的 key 它看不见；
   * · `attrAndTKeysIn` 刻意不抠 ⇒ 注释里的 key 它照样报（P3e Task 4 的 L5，登记在案的遗留）。
   *
   * ⚠️ **这一格断言的是「今天就是这样」，不是「这样是对的」**：哪天那条遗留被修掉
   *（把调用点的 `readFileSync` 包一层 `stripComments`），下面第二条当场变红
   * ——那正是该回来改那道门禁文件头、以及 `attrAndTKeysIn` 上方那段说明的时刻。
   */
  it("抠注释这一步两边不同源：广扫走真源，属性与 t 调用那条刻意不走", () => {
    const src = '// elI18n("h2", "models.zzzCommentKey"); <b data-i18n="models.zzzCommentAttr">x</b>\n';
    expect(
      referencedKeysIn(src),
      "命名空间广扫必须先抠注释 —— 它与 `scripts/check-i18n.mjs` 第 ① 条共用 scripts/lib/strip-comments.mjs",
    ).not.toContain("models.zzzCommentKey");
    expect(
      attrAndTKeysIn(src),
      "这一条今天刻意不抠注释（Task 4 的 L5）。它不再报注释里的 key 了？"
      + "那条遗留被修掉了，回去把 scripts/check-i18n.mjs 文件头那段射程说明一起改",
    ).toContain("models.zzzCommentAttr");
    // 反向控制：同样两处形态**不写在注释里**时，两条判据都必须看得见
    // ——否则上面两格可能只是因为判据整个瞎了。
    const plain = 'elI18n("h2", "models.zzzCommentKey"); const h = \'<b data-i18n="models.zzzCommentAttr">\';';
    expect(referencedKeysIn(plain), "不在注释里就必须扫得到，否则上面那条是恒真的")
      .toContain("models.zzzCommentKey");
    expect(attrAndTKeysIn(plain), "不在注释里就必须扫得到，否则上面那条是恒真的")
      .toContain("models.zzzCommentAttr");
  });

  /**
   * **B1 的另一半：本文件这四条判据一律引号无关（P3e Task 5）。**
   *
   * `scripts/check-i18n.mjs` 的第 ⑧ 条**早就**补了两种引号（它自己的第一版只认双引号，
   * 把当初那个 `{count}` 泄漏缺陷原样重放成单引号就 exit 0、零报错——
   *「判据建在了缺陷没采取的那个形态上」），第 ① 条在 P3e Task 3 也换成了两种引号都扫。
   * **同一份仓里同一个坑，本文件这四条一处都没补**：实测 `elI18n('h2','usage.titel')`
   * 能让六道脚本门禁 + 全量用例一起放行，而用量板块主标题在五种语言下显示裸串。
   *
   * ⚠️ **模板字面量（反引号）刻意仍然不扫**，理由照 `scripts/check-i18n.mjs` 已写明的那条：
   * 那种写法通常是动态拼 key，静态判据本来就管不了；在这里扫还会与那道门禁的
   * 拼键前缀路径**重复计算**，并把 `` `set.field.${path}` `` 这类动态拼键当成一个字面
   * key 报「字典里没有」。
   *
   * ⚠️ **放宽判据天生减少漏报、也可能制造误报**，所以下面每一条正向都配了
   * 「我对 X 不乱红」的那一半。真仓实测（放宽前后逐字对照，四条判据同时换）：
   * 属性 + `t(` 那一格 125 处引用 → **125 处**，命名空间广扫 481 处 → **481 处**，
   * 两侧「字典里没有的 key」都是 **0** ⇒ 今天零误报，因为 `admin-ui/` 下
   * **一处单引号 i18n key 都没有**（`grep -ron "'[a-z]\+\.[A-Za-z0-9_.]\+'" admin-ui/` → 0 行）。
   * 换句话说这次放宽今天**不改变任何结论**，它防的是明天有人第一次写下单引号那一处。
   */
  describe("四条 key 判据一律引号无关", () => {
    it.each(['"', "'"])("被当参数传的 i18n key，%s 引号写法都必须被扫到", (q) => {
      const src = `elI18n("h2", ${q}models.zzzParamKey${q});`;
      expect(referencedKeysIn(src)).toContain("models.zzzParamKey");
    });

    it.each(['"', "'"])("data-i18n 属性里的 key，%s 引号写法都必须被扫到", (q) => {
      const src = `<h2 data-i18n=${q}models.zzzAttrKey${q}>x</h2>`;
      expect(attrAndTKeysIn(src)).toContain("models.zzzAttrKey");
    });

    it.each(['"', "'"])("t(…) 首参里的 key，%s 引号写法都必须被扫到", (q) => {
      const src = `const s = t(${q}models.zzzCallKey${q});`;
      expect(attrAndTKeysIn(src)).toContain("models.zzzCallKey");
    });

    it.each(['"', "'"])("反向自检 ② 数命名空间前缀时，%s 引号写法都必须被扫到", (q) => {
      const src = `elI18n("h2", ${q}models.zzzParamKey${q});`;
      expect(namespacePrefixesIn(src)).toContain("models");
    });

    /**
     * **下面三条是「我对 X 不乱红」那一半。** 少了它们，上面八格用「见谁都报」的
     * 判据（例如把正则放宽成扫一切引号对）同样能全绿，而那正是这次放宽最可能翻的车。
     */
    it.each(['"', "'"])("不乱红：第一段不是已知命名空间的 %s 引号字符串不许被当成 key", (q) => {
      const src = `const route = ${q}router.push.path${q};`;
      expect(referencedKeysIn(src), "`router` 不在 NAMESPACES 表里").toEqual([]);
    });

    it("不乱红：放宽之后这两条仍然只认那两种形态，不是通用字符串扫描器", () => {
      // 同一个 key 字面量，既不在 `data-i18n*=` 属性里、也不是 `t(` 的首参。
      expect(attrAndTKeysIn("const s = 'models.zzzParamKey';")).toEqual([]);
      expect(attrAndTKeysIn('const s = "models.zzzParamKey";')).toEqual([]);
    });

    it.each(['"', "'"])("不乱红：前缀不是纯小写时不算命名空间（%s 引号）", (q) => {
      expect(namespacePrefixesIn(`const n = ${q}Math.max${q};`)).toEqual([]);
    });

    /**
     * **登记在案的边界：放宽之后这几条正则接受「引号不配对」的一对。**
     *
     * 形状是刻意与 `scripts/check-i18n.mjs` 的 `KEYLIKE`（`["'](…)["']`）**对齐**的：
     * 两边收窄得不一样的话，「同一个量的两份实现」会在这一档上永久一绿一红，
     * 而本文件为「两侧量的根本不是同一个量」已经栽过一次（见上面那段 ⚠️⚠️）。
     * 今天 `admin-ui/` 下零处这种写法 ⇒ 射程为空。**这一格断言的是「今天就是这样」，
     * 不是「这样是对的」**：哪天两边一起收窄，红的地方正是该回来改这段边界的地方。
     */
    it("边界：引号不配对的一对也会被认成 key（与 check-i18n.mjs 的 KEYLIKE 同形状）", () => {
      expect(attrAndTKeysIn(`<h2 data-i18n="models.zzzMixed'>x</h2>`)).toContain("models.zzzMixed");
    });
  });
});
