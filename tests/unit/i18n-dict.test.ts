import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { TEND_FAILURE_REASONS } from "../../src/core/registrar/tender.js";
import { stripComments } from "../helpers/strip-comments.js";

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
// ⇒ 今天真打错一个字母，第 6 道门禁 exit 1，不再有「一条没人看的警告」这一档。
// **那三段仍然逐字留着，因为它们记的是这张表当初为什么被建起来**——那是史实，不是现状。
//
// ⇒ **这张表今天的存在理由换了一条，写在这里**：它是**手写登记**，门禁那边是**从字典自动派生**，
// 两条不同的路回答同一个问题。手写表会漏掉新板块（那由下面三条反向自检在防），
// 自动派生不会漏但也不会逼人表态。**两者都留着，才是这一半还没被收编的那份冗余。**
const NAMESPACES = [
  "gate", "nav", "shell", "common", "reg", "keys", "ov", "ev", "set", "usage", "models", "pg",
] as const;
const NS_KEY_RE = new RegExp(`"((?:${NAMESPACES.join("|")})\\.[A-Za-z0-9_.]+)"`, "g");
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
 * 字典的结构性断言。**与 `scripts/check-i18n.mjs` 用不同的代码路径回答同一批问题**：
 * 门禁脚本跑在 CI 的第 6 道，这份跑在 `pnpm test` 里，其中一份写错时另一份会不同意。
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
   * 设计文档 §10.3 第 4 条：`reg.*` 命名空间禁用词。
   * **这比人工评审可靠，是唯一能长期防住「某次改文案顺手写了『推荐使用 X』」的机制。**
   *
   * ⚠️ 禁用词表比设计文档 §9.1 多了**繁体变体**（推薦 / 建議 / 預設 / 首選 / 優先）。
   * 理由是 P3a Task 9 的原样教训：控制端查五语言对等时 grep 用了简体「保证」，
   * 漏掉繁体「保證」，于是报告说齐全而实际不齐。简体表在 zh-TW 上等于没有检查。
   *
   * ⚠️ **边界（明写，别宣称成「杜绝一切偏好表述」）**：这是纯词面匹配，
   * 「两条里挑一条的话就用 X」这种不含禁用词的偏好表述它抓不住，那一档留给评审。
   * 想在 `reg.*` 里合法地说「默认值」时，正确做法是**把那条文案放进别的命名空间**
   *（例如 `cfg.*`），而不是给这张表开豁免——命名空间就是这条规则的作用域。
   */
  it("reg.* 命名空间不出现任何偏好词（含繁体变体）", () => {
    const BANNED = [
      "推荐", "推薦", "建议", "建議", "默认", "預设", "預設", "主流", "首选", "首選", "优先", "優先",
      "recommended", "preferred", "default",
      "おすすめ", "推奨", "권장", "기본",
    ] as const;
    const hits: string[] = [];
    for (const [k, v] of Object.entries(I18N)) {
      if (!k.startsWith("reg.")) continue;
      for (const lang of LANGS) {
        const s = ((v as Record<string, string>)[lang] ?? "").toLowerCase();
        for (const w of BANNED) if (s.includes(w.toLowerCase())) hits.push(`${k}/${lang}: ${w}`);
      }
    }
    expect(hits, "两条邮箱通道必须完全平级，文案里不许出现偏好词").toEqual([]);
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
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/data-i18n(?:-ph|-title)?="([^"]+)"/g)) used.add(m[1]!);
      for (const m of src.matchAll(/\bt\("([^"]+)"/g)) used.add(m[1]!);
    }
    const missing = [...used].filter((k) => !(k in I18N)).sort();
    expect(missing, "引用了字典里没有的 key，运行时会原样显示 key 本身").toEqual([]);
    // 反向自检：扫描一个键都没找到时上面那条恒绿（第 6 种假阳性的近亲）。
    //
    // ⚠️⚠️ **别再把这一条读成「与 scripts/check-i18n.mjs 那道门槛是同一条边界」——
    // 那句话 P3e Task 3 之后不成立了，那边的门槛已经删掉。**
    // 上一版在这里写着：两处必须同边界，否则会在「恰好等于 15」上永久一绿一红。
    // 复评实测两侧量的**根本不是同一个量**：这一条只认 `data-i18n*="…"` 与 `t("…")`
    // 两种窄形态、不抠注释；那道门禁走的是抠完注释的命名空间广扫，数出来是这里的好几倍。
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
   * 上面那条只认两种形态：`data-i18n*="…"` 属性与字面的 `t("…")` 调用。
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
      for (const m of stripComments(readFileSync(p, "utf8")).matchAll(/"([a-z]+)\.[A-Za-z0-9_.]+"/g)) {
        if (dictNamespaces.has(m[1]!)) usedNamespaces.add(m[1]!);
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
});
