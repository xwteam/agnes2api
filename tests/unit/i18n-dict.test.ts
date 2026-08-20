import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { TEND_FAILURE_REASONS } from "../../src/core/registrar/tender.js";

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;

/**
 * 字典的结构性断言。**与 `scripts/check-i18n.mjs` 是两份独立实现，这是有意的**：
 * 门禁脚本跑在 CI 的第 5 道，这份跑在 `pnpm test` 里；两者用不同的代码路径回答
 * 同一批问题，其中一份写错时另一份会不同意。
 * （P3a 的教训是反过来的：CI 只有一份实现、且没人验证它跑没跑过，
 *   于是加了 tee + grep 横幅。这里换一种做法——冗余实现。）
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
    expect(TEND_FAILURE_REASONS.length, "联合成员数变了，请在评审里确认").toBe(11);
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

  /** 源码里引用到的每个 key 都必须在字典里（反向：字典里没被引用的只警告，见 check-i18n.mjs）。 */
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
    // ⚠️ **门槛不是设计文档写的 20**：本期（Task 3）只铺框架骨架，字面引用一共
    // 18 处（index.html 的 11 个 data-i18n* + app.js 的 5 个 t("...") + ui.js 的
    // 2 个 t("...")），Task 4/5/6 的业务板块落地前这个数字涨不上 20——按 20 写
    // 这条会对着当前真实文件常年打红，属于「以为有护栏」的同一种错误，这里核实
    // 后改成 15：仍然远高于「扫描整个坏掉」时的 0，只是不再拿一个未来才成立的
    // 数字卡当前状态。
    //
    // ⚠️ **比较符与 scripts/check-i18n.mjs 必须是同一条边界**：那边写的是
    // `used.size < 15` 才报错（15 本身通过）。这里如果写成 `toBeGreaterThan(15)`，
    // 两份「独立实现」会在 `used.size === 15` 这个精确边界上永久互相矛盾——一份绿
    // 一份红，恰恰破坏了「两份独立实现互为印证」这个设计意图。所以这里同样用
    // `>= 15`（`toBeGreaterThanOrEqual`），15 本身两边都通过。
    expect(used.size, "一个 i18n 引用都没扫到，扫描本身坏了").toBeGreaterThanOrEqual(15);
  });

  /**
   * 上面那条只认两种形态：`data-i18n*="…"` 属性与字面的 `t("…")` 调用。
   * **板块把 key 当参数传给 `elI18n()` / `openModal()` 时它看不见**（Task 3 的
   * `ui.js` 里 `{ labelKey: "common.cancel" }` 就是这一类，check-i18n 只把它报成
   * 「未被引用」的警告）。于是 Task 4 的 `elI18n("th", "keys.col.seq")` 打错一个字，
   * 运行时会原样显示那个 key，而两道 i18n 门禁一声不吭。
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
    const NAMESPACES = ["gate", "nav", "shell", "common", "reg", "keys", "ov", "ev"] as const;
    const re = new RegExp(`"((?:${NAMESPACES.join("|")})\\.[A-Za-z0-9_.]+)"`, "g");
    const walk = (d: string): string[] =>
      readdirSync(d).sort().flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(js|mjs)$/.test(p) ? [p] : [];
      });
    // **先去注释再扫。** 这个仓库的注释极其爱复述代码（本条用例第一版就被
    // sec-keys.js 里一句「不许拼 `"keys.bucket." + b`」的说明打红），与
    // pool-cache.test.ts / source-guards.test.ts 用的是同一套处理。
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const referenced = new Set<string>();
    for (const p of walk("admin-ui/js")) {
      // 字典自己就是这些键的定义处，扫它等于自证。
      if (p.endsWith("i18n-dict.js")) continue;
      for (const m of stripComments(readFileSync(p, "utf8")).matchAll(re)) referenced.add(m[1]!);
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
    for (const p of walk("admin-ui/js")) {
      if (p.endsWith("i18n-dict.js")) continue;
      for (const m of stripComments(readFileSync(p, "utf8")).matchAll(/"([a-z]+)\.[A-Za-z0-9_.]+"/g)) {
        if (dictNamespaces.has(m[1]!)) usedNamespaces.add(m[1]!);
      }
    }
    expect(
      [...usedNamespaces].filter((ns) => !(NAMESPACES as readonly string[]).includes(ns)).sort(),
      "这些命名空间在 admin-ui/js 里真的被用作 key 前缀，却不在 NAMESPACES 表里"
      + "——那一段 key 打错字时三道 i18n 门禁会全部沉默",
    ).toEqual([]);

    /**
     * **反向自检 ③：表里不许有死条目。** 与 ② 是同一件事的另一半
     *（② 挡"漏了"，③ 挡"多了 / 前缀写错"）。
     *
     * 今天为空的三个各有其**如实的**理由，都不是缺陷：
     * · `shell` / `nav` —— 壳层标题与三个导航按钮的文案全写在 `index.html` 的
     *   `data-i18n` 属性里，而本条扫的是 `admin-ui/js` 下的 `.js`/`.mjs`。那一半由
     *   `scripts/check-i18n.mjs` 的第 ① 条覆盖（它连 `.html` 一起走）。
     * · `reg` —— 注册机板块整个排在 P3c，字典先铺好、还没有任何消费者
     *   （`scripts/check-i18n.mjs` 会把它们报成"未被引用"的**警告**）。
     */
    const emptyNamespaces = NAMESPACES.filter((ns) => !usedNamespaces.has(ns));
    expect(
      [...emptyNamespaces].sort(),
      "一个引用都没扫到的命名空间集合变了——要么前缀写错/该删，要么某个空的前缀"
      + "终于有了 JS 消费者，回来把上面那段说明改准",
    ).toEqual(["nav", "reg", "shell"]);
  });
});
