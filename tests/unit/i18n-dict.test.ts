import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { TEND_FAILURE_REASONS } from "../../src/core/registrar/tender.js";
import { stripComments } from "../helpers/strip-comments.js";
import {
  UNVERIFIED_KEYS, UNVERIFIED_BANNED, UNVERIFIED_CONCEPTS, unverifiedHit,
} from "../../scripts/lib/unverified-claims.mjs";
import { tableFromSource } from "../helpers/gate-tables.js";
// 危险区那道「不许说立即生效」的守卫，射程里那两条复用文案从真源现算。
import { resetWarnings } from "../../admin-ui/js/pure/settings.mjs";

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
/** 门禁脚本本体。**只用来抠它源码里那两张手写表**，本文件不跑它（那是另一份实现的活）。 */
const GATE = resolve("scripts/check-i18n.mjs");

// ── 「板块里当参数传的 i18n key」那道广扫的判据本体 ─────────────────────────────
// **整块从那条用例体里原样搬到模块作用域，判据一个字符没改。** 搬的理由只有一个：
// 让「毒刺在场时它还看不看得见」那一格能在内存里拼坏文本喂给同一个判据，
// 而不是另抄一份扫描逻辑（另抄一份的话，探针绿而真扫描瞎，两者永远不会互相揭发）。
//
// `set` 是设置页。**加新板块必须回来表态**，理由见下面那条用例上方的 ⚠️。
// ⚠️ `usage` 是用量板块。它进这张表**不是形式**：那个板块的
// 62 个新 key 里绝大多数走的正是 `elI18n(tag, key)`（`scripts/check-i18n.mjs`
// 的第 ① 条只认 `t("…")` 与 `data-i18n="…"`，对它们完全隐身），
// 不进表的话打错一个字母三道 i18n 门禁会一起沉默、面板上显示裸 key。
// ⚠️ `models` 是模型板块。它进这张表**不是形式**：那个板块的
// 每一个 key 走的都是 `elI18n(tag, key)` 或者当参数传给 `modalityLabelKey()`
// 的字面量，`scripts/check-i18n.mjs` 的第 ① 条对它们完全隐身，
// 不进表的话打错一个字母三道 i18n 门禁会一起沉默、面板上显示裸 key。
// ⚠️ `pg` 是 Playground 板块，**它进这张表的理由比前几个板块更硬**：
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
// ⚠️⚠️ **上面三条 ⚠️ 里「门禁对它们完全隐身」说的是旧版门禁，别当现状读。**
// 那之后 `scripts/check-i18n.mjs` 的第 ① 条换成了「命名空间前缀锚定的引号对」广扫
//（先抠注释、两种引号都扫），`elI18n(tag, key)` / return / 三元 / 数组·参数位那几族它现在都认得：
// 真仓实测「直接引用」从 125 处涨到 496 处，「未被引用」从 396 条降到 3 条。
// ⚠️⚠️ **`pg` 那一段里「只报『未被引用』的警告（第 ④ 条从不 exit 1）」同样是史实、不是现状**
//（复评补登记）：后来把第 ④ 条升成了**硬错**，`warnings` 数组也一并删了
// ⇒ 今天真打错一个字母，`scripts/check-i18n.mjs` 这道门禁 exit 1，不再有「一条没人看的警告」这一档。
// **那三段仍然逐字留着，因为它们记的是这张表当初为什么被建起来**——那是史实，不是现状。
//
// ⇒ **这张表今天的存在理由换了一条，写在这里**：它是**手写登记**，门禁那边是**从字典自动派生**，
// 两条不同的路回答同一个问题。手写表会漏掉新板块（那由下面三条反向自检在防），
// 自动派生不会漏但也不会逼人表态。**两者都留着，才是这一半还没被收编的那份冗余。**
const NAMESPACES = [
  "gate", "nav", "shell", "common", "reg", "keys", "ov", "ev", "set", "usage", "models", "pg",
  // ⚠️ `err` 是后开的命名空间（管理接口错误码 → 五语言文案）。
  // **它是被上面那条「反向自检 ②」逼出来的**：新命名空间加进字典、被
  // `admin-ui/js/pure/keys-write.mjs` 的 `ADMIN_ERROR_TEXT_KEY` 真的用作 key 前缀，
  // 而这张表没跟上 ⇒ 那一格当场红并点名 `err`。**那正是它按设计工作**——
  // 上一次（加 `ov`/`ev` 那回）没有这条自检，于是没人回来表态。
  "err",
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
 * 抠注释走 `scripts/lib/strip-comments.mjs` 那一份真源（收编过来的）——
 * 本文件原来自持一份正则实现，而那一份**认不出字符串里的斜杠星号**，
 * 一根路由 glob 毒刺就能让整道广扫变瞎。
 */
const referencedKeysIn = (src: string): string[] =>
  [...stripComments(src).matchAll(NS_KEY_RE)].map((m) => m[1]!);

/**
 * 一段源码里 `data-i18n*=` 属性与字面的 `t(…)` 调用首参写出来的 key。
 *
 * ⚠️ **这一条刻意不抠注释**，与上面 `referencedKeysIn` 不同。那不是笔误，是一条
 * **登记在案的遗留**（登记在案）：它与同文件那条广扫、以及
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
 * （早先的教训是反过来的：CI 只有一份实现、且没人验证它跑没跑过，
 *   于是加了 tee + grep 横幅。这里换一种做法——冗余实现。）
 *
 * ⚠️⚠️ **「冗余」的边界后来变窄了，别再宣称「两边处处独立」**：
 * 本文件的抠注释器已经收编成 `scripts/lib/strip-comments.mjs` 那一份真源，
 * 而后来 `scripts/check-i18n.mjs` 第 ① 条也 import 了同一份 ⇒
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
   * 理由是一次原样教训：控制端查五语言对等时 grep 用了简体「保证」，
   * 漏掉繁体「保證」，于是报告说齐全而实际不齐。简体表在 zh-TW 上等于没有检查。
   *
   * ⚠️⚠️ **作用域后来从「只有 `reg.*`」扩成了下面那张前缀表，
   * 而这一份与 `scripts/check-i18n.mjs` 的规则⑥ 是两份独立实现**（那边是 CI 上单独一步
   * `node scripts/check-i18n.mjs`，这边跟着 `pnpm test` 跑，各写各的循环）。两件事同时补上：
   * · 用户那条硬约束「YYDS 与 MoeMail 严格同级，不替人选主备」的落点是**设置页**——
   *   两条通道共用的那对凭据 key 与主 / 备两个选择器标签在这之前全在门外；
   * · `keys.addMenu.auto*` 是那道门禁**早就**扩过的范围，而这一份一直没跟上
   *  （门禁那边扩了、这边没扩 ⇒ 那一族只剩一份实现在守，「两份互为印证」当时是假的）。
   *
   * ⚠️ **刻意不是整个 `set.*`**（与门禁那边同一条推理，删了下一个人会顺手扩宽）：
   * `set.*` 里有与通道无关、却**正当地**含着表内词的运维文案。**逐字的那一条是
   * `set.field.agnesBaseUrl`：它的 ko 值是「업스트림 기본 URL」，`기본` 在这里是
   * base URL 的「基」，与「默认通道」毫无关系**——放宽成整个 `set.` 就会当场打红它。
   * ⚠️ **上一版这里写的是「有大量……（超时、冷却、口令）」，那句话当时是假的**：
   * 本轮实测放宽成 `set.` 之后全字典**只命中上面那一条**，超时 / 冷却 / 口令三族
   * 一条都没中。而「不许扩宽」这条推理的全部载重都压在它身上 ⇒ 换成一条真的反例，
   * 并且把它变成会自己红的断言（下面「作用域刻意不是整个 set.：真仓里那条正当用词的反例还在」那一格）。
   * 扩太宽 = 这道今天零命中的干净规则立刻要带一册豁免名单，
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
  // ── 危险区那一族文案里不许出现「立即生效」──────────────────────────────────────
  //
  // ⚠️⚠️ **这道守卫刻意**不**做成 `scripts/check-i18n.mjs` 的禁词表，理由是实测出来的**
  //（设计小节「重置到底重置了什么」复评逐条写着）：
  // · 那个脚本的 `BANNED` 是**偏好词**表（推荐 / 默认 / recommended / おすすめ / 권장……），
  //   作用域被 `BANNED_PREFIXES` 钉死在 `reg.` 与几条 `set.field.*` / `ov.config.*` 上；
  //   `scripts/lib/unverified-claims.mjs` 的 `UNVERIFIED_BANNED` 是**安全 / 够用**那张表。
  //   **两张表里都没有「立即」这一族词。**
  // · 而它**今天也加不进那张表**：字典里含「立即」的 key 全是正当使用（「立即补池」
  //   那一族，外加 `ov.freshness.config` —— 那一条的正文本身就写着「不是「立即生效」」），
  //   而它们恰好落在 `BANNED_PREFIXES` 的作用域里 ⇒ 按词扫会**先打中做对了的那几条**，
  //   一加就要开豁免名册，而本仓的裁定是「开豁免名册比没有规则更糟」。
  // ⇒ 处置：**按作用域另立一格**，射程只有危险区那一族 key，跟着 `pnpm test` 跑。
  //
  // ⚠️ **射程不是手写的**：`set.card.danger` + `set.danger.*` 是前缀派生，
  // 而那两条**复用**的文案（设计小节明令不许另写第三句）由 `resetWarnings()` 现算出来
  // —— 哪天有人把复用的那两条换成别的 key，射程自动跟着换，不用回来改这里。
  const dangerScope = (): string[] => {
    const reused = resetWarnings({
      resetBlocked: [{ code: "gateway_token_required" }, { code: "channel_credentials_missing" }],
    }).flatMap((r: { key: string | null }) => (r.key === null ? [] : [r.key]));
    const own = Object.keys(I18N).filter((k) => k === "set.card.danger" || k.startsWith("set.danger."));
    return [...new Set([...own, ...reused])];
  };

  /**
   * 「立即生效」那一族说法：**概念 × 语言的矩阵**，形态照抄
   * `tests/unit/docs-parity.test.ts` 的
   * 「软化词表是「概念 × 语言」的矩阵：每条概念五种语言都得有说法，缺一种就是那种语言的盲区」
   * 那张表（那一族已经被两次实测逃逸教育过：
   * 只填简体、只填一种语言，都会让某种语言在这条概念上整个瞎掉）。
   * **射程是全部语言的全部说法**：一条英文文案里冒出「즉시 반영」同样是错的。
   *
   * ⚠️⚠️ **这里收的是「立即 + 生效」这条短语，不是「立即」这个词，而这一条是实测逼出来的。**
   * 第一版按**单词**收（立即 / 立刻 / immediately / すぐに / 즉시），跑真字典当场红 9 条，
   * 红的全是设计小节明令要**复用**的那两条文案：`set.clear.effect.gatewayMissing` 与
   * `set.clear.effect.channelBreaks` 里逐字写着「清完请**立刻**在这一页写一把新的」——
   * 那是**对运维下的一句指令**，不是「这次改动马上就在别处生效」的承诺，**它做对了**。
   * 这正是设计小节复评预言过的形态：「按词扫会先打中做对了的那几条，一加就要开豁免
   * 名册」，而本仓的裁定是「开豁免名册比没有规则更糟」。⇒ 判据收窄到那条红线本身的字面：
   * 「立即生效」。
   *
   * ⚠️ **边界，如实登记：这只管词面连写的那一档。** 把两个词拆开写
   *（「本实例立即……别的副本也一样生效」）、或者换一个同义句式，它一个字都抓不住；
   * 那一档留给评审，与 `scripts/check-i18n.mjs` 的 `BANNED` 自己写着的
   * 「这只管词面」是同一条边界，**别把它升格成「杜绝一切『马上生效』的暗示」**。
   */
  const IMMEDIATE_CONCEPTS: ReadonlyArray<{ id: string; words: Record<string, readonly string[]> }> = [
    {
      id: "takes-effect-now",
      words: {
        "zh-CN": ["立即生效", "立刻生效", "马上生效"],
        "zh-TW": ["立即生效", "立刻生效", "馬上生效"],
        en: ["takes effect immediately", "effective immediately", "applies immediately", "instantly effective"],
        ja: ["即時反映", "すぐに反映", "即座に反映", "直ちに反映"],
        ko: ["즉시 적용", "즉시 반영", "바로 적용", "바로 반영"],
      },
    },
  ];

  const IMMEDIATE_WORDS = [...new Set(
    IMMEDIATE_CONCEPTS.flatMap((c) => LANGS.flatMap((l) => c.words[l] ?? [])),
  )];

  /** 一份字典 × 危险区射程。返回失败报文数组。**真扫描与探针共用这一份。** */
  function immediateFailures(dict: Record<string, Record<string, string>>): string[] {
    const out: string[] = [];
    for (const k of dangerScope()) {
      const row = dict[k];
      if (row === undefined) { out.push(`射程里的 ${k} 在字典里不存在——射程本身坏了`); continue; }
      for (const lang of LANGS) {
        const v = String(row[lang] ?? "").toLowerCase();
        for (const w of IMMEDIATE_WORDS) {
          if (v.includes(w.toLowerCase())) {
            out.push(
              `${k}/${lang} 里出现了「${w}」——危险区那两颗按钮的后果都要等传播窗口才在`
              + "别的副本上成立，把它说成这样就是当面说反话（设计 §5.3 同源）",
            );
          }
        }
      }
    }
    return out;
  }

  it("词表是「概念 × 语言」的矩阵：每条概念五种语言都得有说法，缺一种就是那种语言的盲区", () => {
    expect(IMMEDIATE_CONCEPTS.length, "概念表空了——下面整组会一格都不跑").toBeGreaterThan(0);
    const holes: string[] = [];
    for (const c of IMMEDIATE_CONCEPTS) {
      expect(Object.keys(c.words).sort(), `${c.id} 的语言集与 LANGS 对不上`).toEqual([...LANGS].sort());
      for (const lang of LANGS) {
        if ((c.words[lang] ?? []).filter((w) => w.trim() !== "").length === 0) {
          holes.push(`概念 ${c.id} 在 ${lang} 下一个说法都没有——那种语言在这条概念上是瞎的`);
        }
      }
    }
    expect(holes, holes.join("\n")).toEqual([]);
  });

  it("非空锚：射程里既有 set.danger.* 自己那一族，也有复用的那两条 —— 少一半就等于没扫", () => {
    const scope = dangerScope();
    expect(scope.filter((k) => k.startsWith("set.danger.")).length,
      "一条 set.danger.* 都没扫到——这一格测的是空气").toBeGreaterThan(0);
    expect(scope, "复用的那两条不在射程里——resetWarnings() 的映射改了，回来核对设计小节那条明令")
      .toEqual(expect.arrayContaining(["set.clear.effect.gatewayMissing", "set.clear.effect.channelBreaks"]));
  });

  it("危险区那一族文案里一句「立即生效」都没有 —— 词表是「概念 × 语言」的矩阵", () => {
    const failures = immediateFailures(I18N as Record<string, Record<string, string>>);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("反向控制：判据在真字典里认得出这条短语 —— 它在射程外正当地活着（`ov.freshness.config`）", () => {
    // **反向控制用仓里真实存在的串**：`ov.freshness.config` 的正文逐字写着
    // 「不是「立即生效」」（ja 是「即時反映」、ko 是「즉시 반영」，都被引号否定着）。
    // 少了这一格，一个词表被写空 / 判据整个瞎掉的版本照样能让上面那格绿。
    const legit = Object.entries(I18N as Record<string, Record<string, string>>)
      .filter(([k]) => !dangerScope().includes(k))
      .filter(([, row]) => LANGS.some((l) => IMMEDIATE_WORDS.some((w) => String(row[l] ?? "").includes(w))));
    expect(legit.length,
      "整本字典里一条都扫不出这条短语——判据多半已经瞎了，而上面那格会静静地绿").toBeGreaterThan(0);
    expect(legit.map(([k]) => k), "`ov.freshness.config` 不在命中里 —— 反向控制用的串该是仓里真实存在的")
      .toContain("ov.freshness.config");
    // ⚠️ **如实登记：这条反向控制只覆盖 zh-CN / zh-TW / ja / ko 四种。**
    // `ov.freshness.config` 的 en 写的是 `Not "immediately"`，**不含**本表任何一条英文说法
    //（那句话本身也不是在承诺立即生效）⇒ 真字典里今天没有一条正当的英文命中。
    // en 那一档的判别力全部来自下面那条逐语言变异，不是这一格。
    const hitLangs = LANGS.filter((l) => legit.some(([, row]) => IMMEDIATE_WORDS.some(
      (w) => String(row[l] ?? "").includes(w))));
    expect(hitLangs, "真字典里正当命中的语言集变了 —— 回来重新核对这一格覆盖了哪几种")
      .toEqual(["zh-CN", "zh-TW", "ja", "ko"]);
  });

  it("该红时红：逐种语言各往一条危险区文案里塞一次那种语言的说法 —— 每一种都要被点名", () => {
    const target = "set.danger.reset.desc";
    for (const lang of LANGS) {
      const word = IMMEDIATE_CONCEPTS[0]!.words[lang]![0]!;
      const poisoned = {
        ...(I18N as Record<string, Record<string, string>>),
        [target]: {
          ...(I18N as Record<string, Record<string, string>>)[target]!,
          [lang]: `${(I18N as Record<string, Record<string, string>>)[target]![lang]}（${word}）`,
        },
      };
      const failures = immediateFailures(poisoned);
      expect(failures.length, `${lang}：塞了「${word}」却一条都没报——这一格控制是空的`).toBe(1);
      for (const h of [target, lang, word]) {
        expect(failures[0] ?? "", "红了但报文没点名这些东西——报文是唯一会被看见的护栏").toContain(h);
      }
    }
  });

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
    // 评审发现：后来新写的那两个区（重置配置 / 高级）逐字提到
    // 「两条邮箱通道」却在射程外。理由与「为什么不含 set.danger.purge.」见门禁
    // `scripts/check-i18n.mjs` 里 `BANNED_PREFIXES` 上方那段。
    "set.danger.reset.",
    "set.advanced.",
  ] as const;

  it("通道相关命名空间不出现任何偏好词（含繁体变体）", () => {
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
   * ⚠️⚠️ **这两份手写副本必须逐条相等**（补漏评审）。
   *
   * 上面那两张表与 `scripts/check-i18n.mjs` 的 `BANNED` / `BANNED_PREFIXES` 是**逐字重复的
   * 两份手写副本**，而在这一格出现之前，仓里**没有任何东西要求它们一致**。
   * 实测的三档全绿：把这一份的 `PREFIXES` 整表清成 `[]`（上面那格扫的东西为空，
   * `toEqual([])` 只会更绿，`dead` 对空表也无话可说）、删掉其中一条、
   * 删掉门禁那一份里的两条 —— 三种改法一个字都不吵。
   *
   * 「两份独立实现互为印证」这句话要成立，前提是**两份问的是同一批东西**；
   * 两份表悄悄分了家之后，剩下的不是两份印证，是一份没人知道射程的扫描。
   * 本任务自己在 `scripts/lib/unverified-claims.mjs` 文件头把
   *「两份不一致时，瞎掉的那一份才是报绿的那一份」写成裁定，却在同一个提交里
   * 让这两张表继续各抄一份 —— 这一格把那条裁定补齐。
   *
   * ⚠️ **它只要求「字面量逐条相等」，不要求两份扫描相同**：谁扫什么、报文怎么写、
   * 失败怎么表达仍然各写各的（那才是冗余的价值所在）。抠表判据（认不出就抛，
   * 不许静默当成空表）在 `tests/helpers/gate-tables.ts`。
   */
  it("偏好词表与作用域表：这一份与门禁那一份逐条相等（抄两份可以，分家不行）", () => {
    const gateBanned = tableFromSource(GATE, "const BANNED = [");
    const gatePrefixes = tableFromSource(GATE, "const BANNED_PREFIXES = [");
    expect(gateBanned, "抠到的不是那张偏好词表").toContain("推薦");
    expect(gatePrefixes, "抠到的不是那张作用域表").toContain("reg.");
    expect([...BANNED], "偏好词表与门禁那一份分了家 —— 少的那一边就是报绿的那一边")
      .toEqual(gateBanned);
    expect([...PREFIXES], "作用域表与门禁那一份分了家 —— 少的那一边就是报绿的那一边")
      .toEqual(gatePrefixes);
  });

  /**
   * ⚠️⚠️ **「作用域刻意不是整个 `set.`」这条推理的真反例，钉成断言**（补漏评审）。
   *
   * 需求书原文给的反例是 `set.field.agnesBaseUrl` 的 ko 值含 `기본`（base URL 的「基」），
   * 而实施时它被删掉、换成了一句「`set.*` 里有**大量**……（超时、冷却、口令）」的全称句
   * —— 本轮实测：放宽成整个 `set.` 之后全字典**只命中那一条**，三个举例一条都没中。
   * 一句无人能核的全称句撑着「不许扩宽」的全部载重，而它当时就是假的。
   *
   * ⇒ 这一格把那条反例变成机器：**它今天还在**，扩宽就会当场打红一条正当文案。
   * 哪天那条 ko 文案改了词，这一格会红，那正是提醒下一个人「载重理由变了，
   * 回去重新评估作用域该不该扩」的地方 —— 而不是让他读到一句已经变假的话。
   */
  it("作用域刻意不是整个 set.：真仓里那条正当用词的反例还在", () => {
    const row = (I18N as Record<string, Record<string, string>>)["set.field.agnesBaseUrl"];
    expect(row, "反例那条 key 已经不在字典里了 —— 回去重新评估作用域该不该扩").toBeDefined();
    expect(
      row!.ko,
      "这条 ko 文案不再含 `기본` ⇒ 「不许把作用域扩成整个 set.」那条推理的载重理由变了",
    ).toContain("기본");
    // 反向控制：它今天**不在**作用域里，所以上面那格 `toEqual([])` 才是绿的。
    // 少了这一句，把 `set.` 加进 `PREFIXES` 之后这一格照样绿，而它守的正是那件事。
    expect(
      PREFIXES.some((p) => "set.field.agnesBaseUrl".startsWith(p)),
      "这条正当文案已经落进作用域里了 ⇒ 作用域被扩宽了",
    ).toBe(false);
  });

  /**
   * **未核实的事不许被说成已核实**（`scripts/check-i18n.mjs` 规则⑨ 的第二份扫描）。
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
   * ⚠️ **边界：它证明的只是「这几条 key 的文案里没出现表内那几个词」，不证明译文准确，
   * 也不等于「没有人把未核实的事说成已核实」**——判据是子串匹配，
   * 换个同义词它一个字都抓不住，反过来一句诚实的存疑句里出现表内词它照样红。
   * 那条已登记的误报边界与「为什么不给它加否定式」整段写在
   * `scripts/check-i18n.mjs` 规则⑨ 上方，这里不复述（复述两份，改的时候只会改一份）。
   */
  /**
   * 一份字典 × 白名单射程。返回失败报文数组。**真扫描与探针共用这一份。**
   * 命中口径走 `unverifiedHit`（两份实现共用的那一条），别在这里另写一个 `includes`。
   */
  function unverifiedFailures(dict: Record<string, Record<string, string>>): string[] {
    const out: string[] = [];
    for (const k of UNVERIFIED_KEYS) {
      const row = dict[k];
      // 表里指着一个字典里没有的 key ⇒ 那一条红线已经无人再守，当场说出来，不许静默跳过。
      if (row === undefined) { out.push(`${k}: 白名单里这个 key 不在字典里`); continue; }
      for (const lang of LANGS) {
        for (const w of UNVERIFIED_BANNED) {
          if (unverifiedHit(row[lang] ?? "", w)) out.push(`${k}/${lang}: ${w}`);
        }
      }
    }
    return out;
  }

  it("未核实的事不许被说成已核实（白名单 × 词表的交集）", () => {
    const failures = unverifiedFailures(I18N as Record<string, Record<string, string>>);
    expect(failures, "这几条文案描述的是尚未在真机上核实的事，不许写成已经核实过的口吻").toEqual([]);
  });

  /**
   * ⚠️⚠️ **该红时红：逐概念 × 逐语言各往白名单里那条文案塞一次那种语言的说法**
   *（补漏评审）。
   *
   * 上面那格 `toEqual([])` 是**空断言家族**里最典型的一个：词表整族被删掉、
   * 命中口径被写坏、射程被清空——三种改法都只会让它更绿。实测的那一次：
   * 把日 / 韩三个词整族从表里删掉，门禁 EXIT=0、两份测试全绿。
   *
   * ⇒ 这一格拿**同一个 `unverifiedFailures`** 去问「毒刺在场时它还看不看得见」。
   * **探针必须与真扫描共用同一份判据**：另抄一份的话，探针绿而真扫描瞎，
   * 两者永远不会互相揭发。
   */
  it("该红时红：逐概念 × 逐语言各塞一次那种语言的说法 —— 每一种都要被点名", () => {
    const target = UNVERIFIED_KEYS[0]!;
    const base = I18N as Record<string, Record<string, string>>;
    expect(base[target], "白名单第一条已经不在字典里了 —— 这一格会退化成空转").toBeDefined();
    for (const c of UNVERIFIED_CONCEPTS as Array<{ id: string; words: Record<string, string[]> }>) {
      for (const lang of LANGS) {
        const word = (c.words[lang] ?? [])[0];
        expect(word, `概念 ${c.id} 在 ${lang} 下一个说法都没有 —— 那种语言在这条概念上是瞎的`)
          .toBeTruthy();
        const poisoned = {
          ...base,
          [target]: { ...base[target]!, [lang]: `${base[target]![lang]}（${word}）` },
        };
        const failures = unverifiedFailures(poisoned);
        expect(failures.length, `${c.id}/${lang}：塞了「${word}」却一条都没报——这一格控制是空的`)
          .toBe(1);
        for (const h of [target, lang, word!]) {
          expect(failures[0] ?? "", "红了但报文没点名这些东西").toContain(h);
        }
      }
    }
  });

  /**
   * **同一个概念在 ja 里只许有一个术语**（定向复评发现）。
   *
   * 勘察实测的那一处：`reg.primary` 写的是 `プライマリチャネル`，
   * 而 `set.field.registrar.primary` 写的是 `主チャネル`（`docs/ja/REGISTRAR.md` 用的也是后者）——
   * 同一个东西，面板上两个日文词。真正要命的是**它会被下一次改词坐实**：
   * 那一轮若只改 `set.field.*` 一侧而不动 `reg.*`，两个词就从「一次疏漏」变成「两套术语」。
   *
   * ⚠️⚠️ **这一格刻意不写死是哪个词**（`toBe("主チャネル")` 那种写法）。
   * 主 / 备措辞本身还悬着三个候选，将来真换词时**三个 key 会一起换**——
   * 写死词的断言那时会红在一件完全正确的改动上，而写死"只许有一个"的断言不会：
   * 它红的时候，红的正是「只改了一半」那一种。
   */
  it("同一个概念在 ja 里只有一个术语 —— 主通道那一族", () => {
    const LABEL_KEYS = ["reg.primary", "set.field.registrar.primary", "ov.config.primary"] as const;
    /**
     * ⚠️⚠️ **下面读到的每一条 key 都要登记在这里，不许只登记 `LABEL_KEYS`**
     *（补漏评审）。上一版的反向自检只问了 `LABEL_KEYS` 三条，
     * 而用例体里还读着另外三条**没登记**的 key；`ja()` 对不存在的 key 返回 `""`，
     * 于是那两条 `toContain(ja("reg.role.primary"))` 变成 `toContain("")` **恒真**。
     * 实测：把 `reg.role.primary` 改个名、并给新 key 写回本任务要消灭的那个词 ⇒ 这一格仍然 PASS。
     * 上一版那句「这张表不许空转」承诺的射程比它的代码大 —— 这里把射程补齐。
     */
    const READ_KEYS = [...LABEL_KEYS, "reg.emptyPrimary", "reg.role.primary", "reg.tend.channelAny"];
    const ja = (k: string): string => ((I18N as Record<string, Record<string, string>>)[k] ?? {}).ja ?? "";
    expect(READ_KEYS.filter((k) => !(k in I18N)), "这一格读到的 key 里有字典中不存在的").toEqual([]);
    expect([...new Set(LABEL_KEYS.map(ja))], "同一个概念在 ja 里出现了不止一个术语").toHaveLength(1);
    const term = ja(LABEL_KEYS[0]);
    expect(term.length, "ja 值是空的 ⇒ 上面那条 `toHaveLength(1)` 是恒真的").toBeGreaterThan(0);
    /**
     * ⚠️ **短标签也要有下限，否则「长词 contains 短标签」这条方向天生松**：
     * `ja("reg.role.primary")` 退化成一个碎片（甚至空串）时，`toContain` 照样过。
     * 这里只钉「不许是空串 / 单字符碎片」这一档，**刻意不写死是哪个词**——
     * 理由与上面那段同一条：主 / 备措辞真换词时几个 key 会一起换。
     */
    const short = ja("reg.role.primary");
    expect(short.length, "短标签退化成碎片 ⇒ 下面那条 `toContain` 松到什么都能过").toBeGreaterThan(0);
    // 整句文案与短标签也必须用同一个词，不许各说各的。
    expect(ja("reg.emptyPrimary"), "那句「两条通道平级，请选择一条作为主通道」用的是另一个日文词").toContain(term);
    expect(term, "短标签 reg.role.primary 用的是另一个日文词").toContain(short);
    expect(ja("reg.tend.channelAny"), "补池范围那句用的是另一个日文词").toContain(short);
  });

  /**
   * ⚠️⚠️ **同一个概念在 ja 文档里也只许有一个术语 —— 备用通道那一族**
   *（补漏评审）。
   *
   * Step 5 当时只统一了 primary 一侧，fallback 一侧的结论是「字典内已一致，不动」——
   * **那句话只在字典内为真**。实测：同一个概念当时在 `docs/ja/` 里是「副チャネル」，
   * 而下一期新写的 `docs/ja/ADMIN.md` 又冒出第三个词「予備」，**全程零告警**，
   * 因为上面那一格的射程只有字典、不含 `docs/`。
   * 一个概念三个日文词，读文档的人无从判断它们是不是同一个东西。
   *
   * ⇒ 这一格把射程接到 `docs/ja/` 上：**面板怎么说，文档就怎么说**（正典取自字典，
   * 不在这里手写第二份），另外两个词一个都不许再出现。
   * ⚠️ **禁的是「副チャネル」与「予備」这两种指称**（后者连「予備チャネル」一起收），
   * **不是「フォールバック」这个词本身**：
   * `docs/ja/DEPLOY.md` 里好几处正当地用它描述别的回落（池空回落、`X-Forwarded-For` 回落），
   * 那些与两条邮箱通道无关，禁词写宽一格就会当场逼出一册豁免名单。
   */
  it("同一个概念在 ja 文档里也只有一个术语 —— 备用通道那一族", () => {
    const canonical = ((I18N as Record<string, Record<string, string>>)["reg.fallback"] ?? {}).ja ?? "";
    expect(canonical, "`reg.fallback` 的 ja 值没了 ⇒ 正典取不到，下面整格会空转").toBeTruthy();
    const BANNED_JA_ALIASES = ["副チャネル", "予備"];
    const dir = resolve("docs/ja");
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    // 非空锚：目录读空 / 后缀写错时，下面那条 `toEqual([])` 只会更绿。
    expect(files.length, "docs/ja 下一份 .md 都没读到 —— 这一格测的是空气").toBeGreaterThan(0);
    const hits: string[] = [];
    let canonicalSeen = 0;
    for (const f of files) {
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes(canonical)) canonicalSeen++;
        for (const w of BANNED_JA_ALIASES) {
          if (line.includes(w)) hits.push(`docs/ja/${f}:${i + 1} 用了「${w}」`);
        }
      });
    }
    expect(
      canonicalSeen,
      `docs/ja 里一处「${canonical}」都没有 —— 正典对不上文档，这一格的射程是假的`,
    ).toBeGreaterThan(0);
    expect(
      hits,
      `备用通道在 ja 里只许有一个说法（面板用的是「${canonical}」）：\n${hits.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * 设计文档 §7.3 / §9.1 第 6 条：`TendFailureReason` 的每个联合成员都要有
   * `reg.fail.<reason>` 键。当初特意把它收成联合类型正是为了消费时保有穷尽性，
   * 「这笔前期投资这次要用上」。
   *
   * **先把键写齐（含五种语言），注册机板块落地后才真正渲染它们。**
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
   * ⚠️ **上一版这里写的是「只警告」，那句话后来是假的：它已升成硬错。**
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
    // 那句话后来不成立了，那边的门槛已经删掉。**
    // 上一版在这里写着：两处必须同边界，否则会在「恰好等于 15」上永久一绿一红。
    // 复评实测两侧量的**根本不是同一个量**：这一条只认 `data-i18n*=` 属性与 `t(` 首参
    // 两种窄形态、不抠注释；那道门禁走的是抠完注释的命名空间广扫，数出来是这里的好几倍。
    // ⚠️ **「窄」说的是形态窄，不是引号窄**：后来这两种形态**单双引号都认**
    //（判据本体见模块作用域的 `ATTR_KEY_RE` / `T_CALL_KEY_RE`）。
    // 「不抠注释」那一半仍然成立，那是登记在案的遗留（登记在案）。
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
   * 后来才改的；上一版这里把两种形态连同双引号一起写死，那半句今天是假的）。
   * **板块把 key 当参数传给 `elI18n()` / `openModal()` 时它看不见**（当时的
   * `ui.js` 里 `{ labelKey: "common.cancel" }` 就是这一类，check-i18n 当时只把它报成
   * 「未被引用」的警告）。于是 `elI18n("th", "keys.col.seq")` 打错一个字，
   * 运行时会原样显示那个 key，而两道 i18n 门禁一声不吭。
   *
   * ⚠️⚠️ **上面这段、以及下面那条评审实测，记的都是当时的状况，别当现状读**
   *（复评补登记）：`scripts/check-i18n.mjs` 的第 ① 条后来换成了
   * 「抠完注释的命名空间广扫」、第 ④ 条也升成了硬错 ⇒ `elI18n(tag, key)` 那一族
   * 它今天认得，拼错一个字母当场 exit 1（单双引号都算）。
   * **这一条用例的存在理由因此换了一条**（与文件头 `NAMESPACES` 上方那段同源）：
   * 它是**手写登记**那条路，与门禁那边的**自动派生**互为印证，
   * 不再是「唯一还在守的那一层」。
   *
   * 这一条按**命名空间前缀**扫字面量补上那个缺口：admin-ui 的 JS 里凡是长得像
   * `"<已知命名空间>.<键名>"` 的字符串，都必须真的在字典里。
   * 前缀表手写，加新命名空间要在这里表态——这与本仓其它「手写清单」是同一套做法。
   *
   * ⚠️ **`ov` 与 `ev` 是评审补进来的，补之前它们不在表里**——
   * 而那正是当时新增的两个板块（概览、事件）。"加新命名空间要在这里表态"
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
    // 反向自检：扫描坏成空集时上面那条恒绿。Key 池板块一家就有 20+ 个。
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
     * 今天为空的那一个有其**如实的**理由，不是缺陷：
     * · `nav` —— 八个导航按钮的文案全写在 `index.html` 的 `data-i18n` 属性里，
     *   而本条扫的是 `admin-ui/js` 下的 `.js`/`.mjs`。那一半由
     *   `scripts/check-i18n.mjs` 的第 ① 条覆盖（它连 `.html` 一起走）。
     *
     * ⚠️ **`reg` 后来离开了这张空表**：注册机板块落地之后，
     * `sec-registrar.js` 与 `pure/registrar.mjs` 真的开始引用 `reg.*` 了。
     * 这一格因此从三条变成两条——**它变红正是它在起作用**（上一版那段说明写着
     * 「注册机板块整个排在后面，字典先铺好、还没有任何消费者」，那句话现在是假的）。
     * ⚠️ **`shell` 后来也离开了这张空表**，同一个形态：顶栏那颗服务状态徽章落地之后，
     * `pure/health.mjs` 的 `HEALTH_TEXT_KEY` 真的开始把 `shell.status.*` 写成字面量了
     *（`js/health.js` 把它挂成徽章的 `data-i18n`）。这一格因此从两条变成一条。
     */
    const emptyNamespaces = NAMESPACES.filter((ns) => !usedNamespaces.has(ns));
    expect(
      [...emptyNamespaces].sort(),
      "一个引用都没扫到的命名空间集合变了——要么前缀写错/该删，要么某个空的前缀"
      + "终于有了 JS 消费者，回来把上面那段说明改准",
    ).toEqual(["nav"]);
  });

  /**
   * **第 10 种假阳性：一根长得完全正常的毒刺让 NAMESPACES 广扫变瞎。**
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
   * **本文件哪一条与 `scripts/check-i18n.mjs` 共用抠注释真源，钉成断言（复评点名）。**
   *
   * 那道门禁的文件头写着「抠注释两边是同一份实现」，而**上一版把这句话锚在了错的那一条**
   *（锚给了只认 `data-i18n*=` 属性与 `t(` 首参那条，可那条根本不调 `stripComments`）。
   * 实测坐实：把 `scripts/lib/strip-comments.mjs` 退化成恒返回空串，被它锚住的那一格**照样绿**。
   * **一句指错了对象的话不会有任何机器为它红**，所以这里把两边的分界线写成会红的断言：
   * · `referencedKeysIn` 先抠注释 ⇒ 注释里的 key 它看不见；
   * · `attrAndTKeysIn` 刻意不抠 ⇒ 注释里的 key 它照样报（登记在案的遗留）。
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
      "这一条今天刻意不抠注释（登记在案）。它不再报注释里的 key 了？"
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
   * **面板行为覆盖那条评审发现的另一半：本文件这四条判据一律引号无关。**
   *
   * `scripts/check-i18n.mjs` 的第 ⑧ 条**早就**补了两种引号（它自己的第一版只认双引号，
   * 把当初那个 `{count}` 泄漏缺陷原样重放成单引号就 exit 0、零报错——
   *「判据建在了缺陷没采取的那个形态上」），第 ① 条后来也换成了两种引号都扫。
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
