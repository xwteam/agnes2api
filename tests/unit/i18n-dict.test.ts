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
    const tokens = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(",");
    const bad: string[] = [];
    for (const [k, v] of Object.entries(I18N)) {
      const sets = LANGS.map((l) => tokens((v as Record<string, string>)[l]!));
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
    expect(TEND_FAILURE_REASONS.length, "联合成员数变了，请在评审里确认").toBe(10);
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
    expect(used.size, "一个 i18n 引用都没扫到，扫描本身坏了").toBeGreaterThan(15);
  });
});
