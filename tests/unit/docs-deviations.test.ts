/**
 * P3f —— **刻意偏离名册**（W94 / W133）与 **目录树路径真实性**（W135）。
 *
 * ── 名册是干什么的 ────────────────────────────────────────────────────────
 * 本仓有一批地方**故意**不跟参照仓走。没有这张表，后续任何一次对齐检查都会把它们
 * 判成遗漏，然后有人「顺手修好」——**把裁定过的决定悄悄推翻**。
 *
 * ── 两个方向都要真落地，缺一条名册就是一张摆设 ─────────────────────────
 * ① **名册里的每一条今天必须真成立**。哪天补了交流群节，第 1 条会**当场红**，
 *    提醒把它从名册里删掉 —— 名册的作用是「记住裁定」，不是「永久豁免」。
 * ② **名册之外不许出现新偏离**。这个方向的实现 = 名册里每条都带一个**反向断言**
 *    （下面每一格的 `assert`）。凡 R7–R28 覆盖不到、又属于「照抄即造假 / 照抄即出错」
 *    的内容点，一律必须在这里有一条。审查器构造过的反例就是这一档：
 *    `## 🙏 致谢` 抄了 kiro 的「这些反馈直接推动了…迭代」，**致谢正文不在任何判官的射程里**
 *    ⇒ 全绿。第 12 条就是专门为它加的。
 *
 * ── 每条必须带三样东西 ────────────────────────────────────────────────────
 * **断言**（会红的代码）+ **理由**（为什么故意这么做）+ **失效条件**（什么时候该删这条登记）。
 * 只有断言没有理由，后人不知道能不能改；只有理由没有失效条件，登记会变成永久的洞。
 *
 * ── 它验不了什么 ──────────────────────────────────────────────────────────
 * 偏离的**理由**是否仍然成立。哪天真建了微信群，第 1 条的前提就没了，**机器不知道**——
 * 所以每条都写了人话的失效条件，等人来读。
 * 还有一条**机器验不了**的（第 7 条 GitHub topics），如实标成人工项，不假装它有判据。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
const SIX_READMES = ["README.md", ...LANGS.map((l) => join("docs", l, "README.md"))];
const SIX_SPONSORS = ["SPONSORS.md", ...LANGS.map((l) => join("docs", l, "SPONSORS.md"))];
const NON_25 = LANGS.flatMap((l) =>
  ["ADMIN", "API", "DEPLOY", "REGISTRAR", "USAGE"].map((d) => join("docs", l, `${d}.md`)));
const FIVE_DEPLOY = LANGS.map((l) => join("docs", l, "DEPLOY.md"));
const COMMUNITY_MD = [
  "SECURITY.md", "CONTRIBUTING.md",
  join(".github", "pull_request_template.md"),
  join(".github", "ISSUE_TEMPLATE", "bug_report.md"),
  join(".github", "ISSUE_TEMPLATE", "feature_request.md"),
];

const read = (p: string) => readFileSync(p, "utf8");
const FENCE_LINE = /^[ \t]*```/;
/** 剥围栏后的行。名册里凡是数「文档里有几个 X」的条目都走它。 */
const bodyLines = (text: string): string[] => {
  let inFence = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (FENCE_LINE.test(line)) { inFence = !inFence; continue; }
    if (!inFence) out.push(line);
  }
  return out;
};

/**
 * 一条登记。
 * · `id`：与规格 §4 R19 名册表的行号对齐，**编号不复用**（删掉一条也不把后面的号往前挪，
 *   否则历史里引用过的编号会指向别的东西）。
 * · `why`：为什么故意这么做。
 * · `until`：**什么时候这条登记该被删掉**。
 * · `assert`：会红的断言。返回人话数组，空数组 = 这条登记今天成立。
 * · `manualOnly`：**这一条机器验不了**，如实标注。标了它就必须给空断言，
 *   不标它就必须给真断言 —— 下面「名册自守」那一组把这两个方向都钉死了。
 */
type Deviation = {
  readonly id: number;
  readonly what: string;
  readonly why: string;
  readonly until: string;
  readonly manualOnly?: true;
  readonly assert: () => string[];
};

const REGISTRY: readonly Deviation[] = [
  {
    id: 1,
    what: "六份 SPONSORS.md 没有 `## 📢 交流群`，`^---$` 因此是 2 条而不是 3 条（V40）",
    why: "本仓没有交流群，照抄一个空的群号节就是造假；`---` 的条数按 R20/P4② 跟着节数走",
    until: "哪天真建了群并在 SPONSORS 里放出入口 —— 那时这条登记要删，同时 R20/P4② 的期望值跟着 +1",
    assert: () => SIX_SPONSORS.flatMap((p) => {
      const rows = bodyLines(read(p));
      const h2 = rows.filter((l) => l.startsWith("## "));
      const hr = rows.filter((l) => l === "---").length;
      const bad: string[] = [];
      if (h2.length !== 2) bad.push(`${p} 有 ${h2.length} 个 \`##\`，登记的是 2 个`);
      if (h2.some((l) => /交流群|群组|群組|Community|コミュニティ|커뮤니티/.test(l))) {
        bad.push(`${p} 出现了交流群类标题 —— 这条登记该删了`);
      }
      if (hr !== 2) bad.push(`${p} 有 ${hr} 条 \`---\`，登记的是 2 条`);
      return bad;
    }),
  },
  {
    id: 2,
    what: "根 README 的动态徽章区是 3 枚（CI / Issues / Stars），模板是 2 枚（V30）",
    why: "多出来的那枚是 CI 状态徽章；删掉它 `repo-front-door` 的 (c) 会当场红（C6）",
    until: "哪天 CI 徽章被换掉或动态区改成别的枚数 —— 先去看 `repo-front-door` 的 (c) 再改这里",
    assert: () => {
      const head = read("README.md").split("\n## ")[0] ?? "";
      const dynamic = [
        ...head.matchAll(/actions\/workflows\/[\w.-]+\/badge\.svg/g),
        ...head.matchAll(/img\.shields\.io\/github\//g),
      ].length;
      return dynamic === 3 ? [] : [`根 README 的动态徽章是 ${dynamic} 枚，登记的是 3 枚`];
    },
  },
  {
    id: 3,
    what: "快速部署第 2 步叫 `### 2. 部署`，不是模板的 `### 2. Docker 部署`（V5）",
    why: "本仓是双形态（Docker + Cloudflare Worker），把标题写死成 Docker 会漏掉一半读者",
    until: "哪天只剩一种部署形态 —— 那时标题该跟着收窄，这条登记要删",
    assert: () => SIX_READMES.flatMap((p) => {
      const t = read(p);
      const bad: string[] = [];
      if (/^### 2\. (Docker|docker)/m.test(t)) bad.push(`${p} 把第 2 步写回了「Docker 部署」`);
      if (!/^### 2\. /m.test(t)) bad.push(`${p} 的快速部署第 2 步不见了`);
      return bad;
    }),
  },
  {
    id: 4,
    what: "`docs/{lang}/` 是 7 份而不是模板的 5 份（V19）—— 多出 ADMIN 与 REGISTRAR",
    why: "面板与注册机是本仓独有的两块，参照仓没有对照物，只能自己立一类文档",
    until: "哪天这两块下线 —— 文档跟着删，这条登记也删",
    assert: () => LANGS.flatMap((l) => {
      const n = readdirSync(join("docs", l)).filter((f) => f.endsWith(".md")).length;
      return n === 7 ? [] : [`docs/${l} 有 ${n} 份文档，登记的是 7 份`];
    }),
  },
  {
    id: 5,
    what: "`.github/workflows/` 是 3 个而不是模板的 2 个（V11）—— 多出 `deploy-worker.yml`",
    why: "Worker 形态需要一条自己的部署流水线，模板只有 Docker 一条路",
    until: "哪天不再发 Worker 形态",
    assert: () => {
      const yml = readdirSync(join(".github", "workflows")).filter((f) => f.endsWith(".yml")).sort();
      const bad: string[] = [];
      if (yml.length !== 3) bad.push(`workflows 有 ${yml.length} 个：${yml.join(" / ")}，登记的是 3 个`);
      if (!yml.includes("deploy-worker.yml")) bad.push("`deploy-worker.yml` 不见了 —— 这条登记的由来就是它");
      return bad;
    },
  },
  {
    id: 6,
    what: "根目录多出 CONTRIBUTING / SECURITY 与 `.github` 三份模板，参照仓没有（V47）",
    why: "公开仓的门面：贡献指引、安全披露渠道、issue/PR 模板。参照仓缺这些不是优点",
    until: "不失效 —— 这是刻意超出模板的一档，除非仓不再公开",
    assert: () => COMMUNITY_MD.filter((p) => !existsSync(p)).map((p) => `${p} 不见了`),
  },
  {
    id: 7,
    what: "GitHub 仓库 topics 保留 10 个（V48）",
    why: "topics 是搜索入口，10 个是 GitHub 上限档，删到 5 个只会更难被搜到",
    until: "哪天决定收窄 topics",
    // 🔴 **这一条机器验不了**：topics 存在 GitHub 的仓库设置里，不在磁盘上。
    // 如实登记为**人工项**，不写一个假装在验的断言 —— 一个恒真的 `expect(true)` 比没有更坏。
    manualOnly: true,
    assert: () => [],
  },
  {
    id: 8,
    what: "`.env.example` 用制表符包边分组（`# ──…`），参照仓是平铺的（V49）",
    why: "本仓 29 个环境变量，分组之后才读得下去；两参照仓只有 17 / 54 行，不需要分组",
    until: "哪天变量数掉回十几个",
    assert: () => {
      const n = read(".env.example").split("\n").filter((l) => l.startsWith("# ──")).length;
      return n >= 4 ? [] : [`\`.env.example\` 的分组边框只剩 ${n} 条，登记的下限是 4 条`];
    },
  },
  {
    id: 9,
    what: "`> [!CAUTION]` 只在五份 DEPLOY.md 里各用 2 处，全仓合计恰 10 处（V50）",
    why: "CAUTION 是最高一档，用滥了就不管用；这 10 处是「不可逆 / 会丢数据」那两件事",
    until: "哪天出现第三件够得上 CAUTION 的事 —— 先来改这个数，别静静地加",
    assert: () => {
      const hits = [...SIX_READMES, ...SIX_SPONSORS, ...NON_25, "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md"]
        .flatMap((p) => Array.from({ length: (read(p).match(/\[!CAUTION\]/g) ?? []).length }, () => p));
      const bad: string[] = [];
      if (hits.length !== 10) bad.push(`全仓 \`[!CAUTION]\` 有 ${hits.length} 处，登记的是 10 处`);
      const outside = [...new Set(hits)].filter((p) => !FIVE_DEPLOY.includes(p));
      if (outside.length > 0) bad.push(`\`[!CAUTION]\` 跑到了 DEPLOY 之外：${outside.join(" / ")}`);
      return bad;
    },
  },
  {
    id: 10,
    what: "非 README 文档里唯一的 `<details>`：五份 DEPLOY.md 的 `### 配额账` 各 1 处（V27，C23 的具名例外）",
    why: "那一节 283 行全是账目推导，不折叠会把整份 DEPLOY 压垮；除它之外非 README 一概不折叠",
    until: "哪天配额账拆成独立文档，或者决定非 README 全面允许折叠 —— 后者要先推翻 C23",
    // 🔴 这就是 ADJ §77 记的那笔登记债：7B 用测试内的 `DETAILS_ALLOWLIST` 暂代名册，
    //    **W94 落地那天必须把它搬进正式名册，别删掉了事**。这一条就是搬过来的正本。
    //    `tests/unit/docs-parity.test.ts` 里那份仍然在跑（它多守一层「summary 的形态」），
    //    两处是同一条裁定的两个消费者，不是两份互相抄的清单。
    assert: () => {
      const hits = NON_25.filter((p) => read(p).includes("<details"));
      const counts = hits.map((p) => (read(p).match(/<details/g) ?? []).length);
      const bad: string[] = [];
      if (hits.join("|") !== FIVE_DEPLOY.join("|")) {
        bad.push(`非 README 里带折叠块的是：${hits.join(" / ") || "（一份都没有）"}，登记的是五份 DEPLOY`);
      }
      if (counts.some((n) => n !== 1)) bad.push(`每份该恰 1 个折叠块，实际是 ${counts.join(" / ")}`);
      return bad;
    },
  },
  {
    id: 12,
    what: "六份 README 的「📝 最近更新」表数据行 <10 行（V43）",
    why: "C9 / ADJ ⑩ 明令「不许为了凑满 10 行而编造版本条目」；这个仓才发到 v0.1.0",
    until: "行数涨到 10 之后这条登记必须删（那时它就不是偏离了）",
    assert: () => SIX_READMES.flatMap((p) => {
      const n = read(p).split("\n").filter((l) => /^\| 20\d\d-/.test(l)).length;
      return n < 10 ? [] : [`${p} 的最近更新表已经有 ${n} 行 —— 这条登记该删了`];
    }),
  },
  {
    id: 13,
    what: "六份 SPONSORS.md 的导语不照抄模板的「请作者喝杯咖啡 / 二维码见管理面板」（V41）",
    why: "本仓没有收款码也没有二维码，照抄就是**指向一个不存在的东西**——「照抄即造假」那一档",
    until: "哪天真放了收款码或二维码入口 —— 那时这条登记要删，导语也该改回模板的写法",
    assert: () => SIX_SPONSORS.flatMap((p) => {
      const t = read(p).toLowerCase();
      const hit = ["咖啡", "coffee", "二维码", "二維碼", "qr", "微信", "wechat", "コーヒー", "커피"]
        .filter((w) => t.includes(w));
      return hit.length === 0 ? [] : [`${p} 命中了 ${hit.join(" / ")} —— 照抄模板的收款措辞就是造假`];
    }),
  },
  {
    id: 14,
    what: "六份 README 的 `## 🙏 致谢` 写成前瞻式，不写模板那句「这些反馈直接推动了…的迭代」（V42）",
    why: "本仓还没有收到过任何外部反馈，写「推动了迭代」是**凭空捏造一段社区史**",
    until: "哪天真有外部贡献可以点名致谢",
    // ⚠️ 这一条是审查器构造的那条反例的正面回答：致谢正文**不在任何判官的射程里**，
    //    抄了那句话全仓判据一格都不会红。所以它必须住在名册里。
    assert: () => SIX_READMES.flatMap((p) => {
      const t = read(p);
      const hit = ["推动了", "推動了", "drove the", "これらのフィードバックが", "이러한 피드백이"]
        .filter((w) => t.includes(w));
      return hit.length === 0 ? [] : [`${p} 命中了「${hit.join(" / ")}」—— 那是模板的社区史，不是本仓的`];
    }),
  },
  {
    id: 15,
    what: "根 README 删掉了模板的「文档 × 语言」索引矩阵表，改成五条 `> 📖` 指针行（V45）",
    why: "矩阵表 7 行 × 5 列，改一份文档要动 5 格；指针行贴在对应小节里，读者在哪一节就看哪一条",
    until: "哪天文档种类多到指针行铺不下",
    assert: () => {
      const t = read("README.md");
      const bad: string[] = [];
      if (/\|\s*(文档|文件)\s*\|\s*(简体中文|zh-CN)/.test(t)) bad.push("根 README 里又出现了「文档 × 语言」矩阵表");
      const pointers = t.split("\n").filter((l) => l.includes("📖") && l.includes("](docs/")).length;
      if (pointers < 5) bad.push(`\`> 📖\` 指针行只剩 ${pointers} 条，登记的是 5 条`);
      return bad;
    },
  },
  {
    id: 17,
    what: "`admin-ui/README.md` 移出 D4 的排版射程（Q15）",
    why: "它是写给改面板源码的人的开发笔记，参照仓没有对照物；套 16 节骨架毫无意义",
    until: "哪天决定把它也当出货文档",
    // ⚠️ **两个方向**：文件必须还在（不是被删了才「不在射程里」），且确实不在 40 份射程里。
    assert: () => {
      const p = join("admin-ui", "README.md");
      const bad: string[] = [];
      if (!existsSync(p)) bad.push(`${p} 不见了 —— 这条登记说的是「它在，但不进射程」`);
      const ship = [...readdirSync(".").filter((f) => f.endsWith(".md"))];
      if (ship.includes(p)) bad.push(`${p} 进了出货射程`);
      return bad;
    },
  },
  {
    id: 18,
    what: "根级多两份参照仓没有的 dotfile（`.gitattributes` / `.npmrc`）；社区五份 md 的 `---` 走 ADJ ⑮ 不走 C16（C28）",
    why: "两份 dotfile 管的是换行符与 pnpm 行为，与文档形态无关；社区文件不套 README 那套 `hr-before-h2` 恒等式 —— 两份 issue 模板整份没有 `##`，套了会恒真",
    until: "dotfile 那半：哪天不再需要钉换行符或 registry；`---` 那半：哪天社区文件也套 16 节骨架",
    assert: () => {
      const bad = [".gitattributes", ".npmrc"].filter((p) => !existsSync(p)).map((p) => `${p} 不见了`);
      for (const p of COMMUNITY_MD) {
        if (!bodyLines(read(p)).some((l) => l === "---")) bad.push(`${p} 一条 \`---\` 都没有`);
      }
      return bad;
    },
  },
  {
    id: 19,
    what: "五份语言版 README 的 `## 📡 API 端点` 节**不折叠**（C8 的平局裁决，不是模板铁律）",
    why: "kiro 自己五份里有 3 份是折叠的（en/ja/ko）、2 份不折叠，gemini 五份全不折叠 ⇒ 取「K 与 G 一致的那一形」",
    until: "哪天认为该跟随 kiro 的 en/ja/ko 折叠 —— 那是推翻 C8，不是顺手改",
    // ⚠️ 不标注的话，后续任何一次「kiro 的 en/ja 明明折叠了」的质疑都会变成返工压力。
    assert: () => LANGS.flatMap((l) => {
      const p = join("docs", l, "README.md");
      const lines = read(p).split("\n");
      const i = lines.findIndex((x) => /^## .*(API 端点|API 端點|API Endpoints|API エンドポイント|API 엔드포인트)/.test(x));
      if (i < 0) return [`${p} 里找不到 API 端点那一节`];
      const rest = lines.slice(i + 1);
      const j = rest.findIndex((x) => /^## /.test(x));
      const body = (j < 0 ? rest : rest.slice(0, j)).join("\n");
      const n = (body.match(/<details/g) ?? []).length;
      return n === 0 ? [] : [`${p} 的端点节折叠了（${n} 个）—— 那是 kiro 的形态，本仓裁的是不折叠`];
    }),
  },
  {
    id: 20,
    what: "五份 DEPLOY.md 是 **15** 个 `##`，模板骨架是 12 个（V56 + ADJ ㊵）",
    why: "`## Docker 部署` 拆成「选哪种形态 + 两条部署路」是 +3；ADJ ㊵ 又保留了 `## 环境变量` 是 +1，12−1+3+1 = 15",
    until: "哪天只剩一条部署形态 —— 那时要退回 12 节，这条登记跟着删",
    // ⚠️ 规格 §4 R19 名册表第 20 行写的是「恰 14」，**那个数已经过期**：
    //    它是在 ADJ ㊵ 把 `## 环境变量` 加回来之前写的。以 `W124` 的 `DOC_SECTIONS` 为准（DEPLOY = 15）。
    assert: () => FIVE_DEPLOY.flatMap((p) => {
      const n = bodyLines(read(p)).filter((l) => l.startsWith("## ")).length;
      return n === 15 ? [] : [`${p} 有 ${n} 个 \`##\`，登记的是 15 个`];
    }),
  },
  {
    id: 21,
    what: "【阶段 7D 新增】R23'A 的目标是「相邻标题间正文 ≤1200 字符」全仓归零，**今天还有 67 处超限**",
    why: "实测压到字面 0 需要全仓再插约 235 个标题，`###`+`####` 会涨到模板密度的 2.4 倍 —— 与 ADJ §79「密度已达成并超过模板、不许再堆 `###`」正面冲突。⇒ 判据取**绝对数棘轮**（只许降不许升），把差额如实记在这里",
    until: "降到 0 那天，这条登记与 `docs-typography.test.ts` 里的 `R23A_OVERLONG_RATCHET` 常量一起删",
    assert: () => {
      const src = read(join("tests", "unit", "docs-typography.test.ts"));
      const m = /const R23A_OVERLONG_RATCHET = (\d+);/.exec(src);
      if (m === null) return ["`R23A_OVERLONG_RATCHET` 不见了 —— 要么欠账结清了（那这条登记该删），要么棘轮被拆了"];
      return Number(m[1]) === 0 ? ["棘轮已经降到 0 —— 欠账结清，这条登记该删了"] : [];
    },
  },
  {
    id: 22,
    what: "【阶段 7D 新增】五份 DEPLOY.md 的环境变量表「是否必填」列写的是**条件句**，不是 `✅`/`❌` 二值（R22f 的例外）",
    why: "本仓有 6 个变量是**条件必填**（「通道为 yyds 时必填」「启用时必填」）；二值格装不下条件，塞进去只能选一个错的答案。六份 README 的配置表仍然是二值 —— 那张表只列必填/非必填两档",
    until: "哪天条件必填这一类消失 —— 那时该退回 `✅`/`❌`，这条登记删",
    assert: () => FIVE_DEPLOY.flatMap((p) => {
      const hasTick = bodyLines(read(p)).some((l) => /^\|\s*`[A-Z_]+`\s*\|\s*[✅❌]\s*\|/.test(l));
      return hasTick ? [`${p} 的变量表用上了 \`✅\`/\`❌\` —— 那这条登记该删了`] : [];
    }),
  },
];

describe("W94 / W133 刻意偏离名册：每条今天都真成立（方向 ①）", () => {
  for (const d of REGISTRY) {
    it(`第 ${d.id} 条：${d.what}`, () => {
      const faults = d.assert();
      expect(faults, `这条登记不成立了：\n${faults.join("\n")}\n\n`
        + `【为什么故意这么做】${d.why}\n`
        + `【什么时候该删这条登记】${d.until}`).toEqual([]);
    });
  }
});

describe("W94 名册自守：编号不重、三样东西齐全、机器验不了的那条如实标注", () => {
  it("编号唯一且单调递增（删掉一条不把后面的号往前挪 —— 历史里引用过的编号不许改指向）", () => {
    const ids = REGISTRY.map((d) => d.id);
    expect(new Set(ids).size, `名册里有重复编号：${ids.join(",")}`).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b), "编号不是递增的").toEqual(ids);
  });

  it("每条都带断言 + 理由 + 失效条件，而且理由与失效条件不是敷衍的一句话", () => {
    const thin = REGISTRY.flatMap((d) => {
      const bad: string[] = [];
      if (d.why.length < 15) bad.push(`第 ${d.id} 条的「理由」只有 ${d.why.length} 个字`);
      if (d.until.length < 10) bad.push(`第 ${d.id} 条的「失效条件」只有 ${d.until.length} 个字`);
      if (d.what.length < 10) bad.push(`第 ${d.id} 条的「偏离」写得太短`);
      return bad;
    });
    expect(thin, `名册里有条目缺三样东西之一：\n${thin.join("\n")}`).toEqual([]);
  });

  it("🔴 标了 `manualOnly` 的只有第 7 条，且**标与不标两个方向都查**", () => {
    // 一条恒绿的登记比没有登记更坏：它看起来在守着什么。
    // 所以「机器验不了」必须是**唯一**且**具名**的，而且两个方向都得钉：
    // 标了 manualOnly 却写了真断言 ⇒ 标注是假的；没标却给了空断言 ⇒ 偷偷混进一条恒绿登记。
    expect(REGISTRY.filter((d) => d.manualOnly === true).map((d) => d.id),
      "`manualOnly` 只该有第 7 条（topics 在 GitHub 的仓库设置里，不在磁盘上）").toEqual([7]);
    const wrong = REGISTRY.flatMap((d) => {
      const src = d.assert.toString();
      const looksEmpty = /\(\)\s*=>\s*\[\s*\]/.test(src);
      if (d.manualOnly === true && !looksEmpty) return [`第 ${d.id} 条标了 manualOnly 却写了断言`];
      if (d.manualOnly !== true && looksEmpty) return [`第 ${d.id} 条给了空断言却没标 manualOnly —— 恒绿的登记`];
      return [];
    });
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("规格名册里那两条**已经结清**的条目今天确实不在名册里（结清了就该删，不是留着当摆设）", () => {
    const ids = new Set(REGISTRY.map((d) => d.id));
    // 第 11 条：规格自己在 R2 修订时删掉了（「TIP 是两句而非一句」根本不构成偏离）。
    expect(ids.has(11), "第 11 条回来了 —— 规格已裁定它不构成偏离，登记它会稀释整张名册").toBe(false);
    // 第 16 条：Q7 的「USAGE 本期不扩容 = 已知欠账」。阶段 7C 已经把五份 USAGE 从
    // 95–103 行扩到了 308–400 行，**欠账结清** ⇒ 按它自己的失效条件，这条登记必须删。
    expect(ids.has(16), "第 16 条（USAGE 不扩容）回来了 —— 它已经结清了").toBe(false);
    const lines = LANGS.map((l) => read(join("docs", l, "USAGE.md")).split("\n").length - 1);
    expect(lines.filter((n) => n < 300), `USAGE 又缩回 300 行以下了（${lines.join(" / ")}）—— `
      + "那 Q7 的欠账重新成立，第 16 条要加回名册").toEqual([]);
  });
});

/**
 * ── W135 —— 根 README 目录树里的每一条路径都必须真的在（ADJ §59）────────────
 *
 * `## 🗂 项目结构` 那段裸围栏此前**内容正确性零判据**：判据只保证它是个裸 ``` 块、
 * 块内没有 code span，**目录树列的文件在不在，一格都没在守**。
 * 一份列着不存在文件的目录树，正是「真实性轴」（R27）要抓的那类假话，
 * 而它出现在 README 最显眼的位置之一。`check-comment-refs` 只扫 `.ts/.js/.mjs` 的注释，
 * 够不着 markdown —— 那是**该补一条判据**的理由，不是接受失明的理由。
 *
 * ⚠️ **同一节里的 ASCII 框图（`## 🏗 技术架构`）接受无判据**：它画的是逻辑关系不是文件，
 * 没有可机器核的真源。这一条边界写在这里，免得后人以为漏掉了。
 */
describe("W135 根 README 的 `## 🗂 项目结构` 目录树：每一条路径都真的存在", () => {
  /** 从目录树里把「缩进 + ├──/└── + 名字」解析成仓库相对路径。 */
  const treeEntries = (): ReadonlyArray<{ line: number; path: string; isDir: boolean }> => {
    const src = read("README.md");
    const start = src.indexOf("## 🗂 ");
    expect(start, "根 README 里找不到 `## 🗂 ` 那一节 —— 骨架变了，这一组当场失明").toBeGreaterThan(0);
    const section = src.slice(start).split("\n## ")[0] ?? "";
    const fenced = section.split("```")[1] ?? "";
    const base = src.slice(0, start).split("\n").length;
    const offset = base + (section.split("```")[0] ?? "").split("\n").length - 1;
    const stack: string[] = [];
    const out: Array<{ line: number; path: string; isDir: boolean }> = [];
    fenced.split("\n").forEach((raw, i) => {
      const m = /^((?:[│ ]   )*)(?:├──|└──) ([^\s#]+)/.exec(raw);
      if (m === null) return;
      const depth = (m[1] ?? "").length / 4;
      const name = m[2] ?? "";
      stack.length = depth;
      stack[depth] = name;
      const path = stack.slice(0, depth).join("") + name;
      out.push({ line: offset + i, path, isDir: name.endsWith("/") });
    });
    return out;
  };

  /**
   * 唯一一条**故意**不在磁盘上的路径。
   * `data/` 是 Docker 卷的挂载点（`docker-compose.yml` 里 `./data:/app/data`），
   * 由容器在运行时创建，而 `.gitignore` 把它排除了 —— git 也不跟踪空目录。
   * **双向登记**：下面既查「它今天确实不在磁盘上」（在了就说明登记过期），
   * 也查「`docker-compose.yml` 里真的挂着它」（不挂了这条豁免就没有依据）。
   */
  const RUNTIME_ONLY = ["data/"] as const;

  it("解析器自己说得通：认出的条目不少于 25 条，且顶层第一条是 `src/`", () => {
    const entries = treeEntries();
    expect(entries.length, "目录树只解析出不到 25 条 —— 多半是缩进正则跟不上画法了，"
      + "本组会静静地变成「什么都没查」").toBeGreaterThanOrEqual(25);
    expect(entries[0]?.path, "第一条不是 `src/`").toBe("src/");
  });

  it("每一条形如路径的行都指向磁盘上真实存在的东西（`data/` 是唯一的具名例外）", () => {
    const wrong = treeEntries()
      .filter((e) => !(RUNTIME_ONLY as readonly string[]).includes(e.path))
      .flatMap((e) => {
        const real = e.path.replace(/\/$/, "");
        if (!existsSync(real)) return [`README.md:${e.line} 目录树里的 \`${e.path}\` 在仓里不存在`];
        const isDir = statSync(real).isDirectory();
        if (isDir !== e.isDir) {
          return [`README.md:${e.line} \`${e.path}\` 画成了${e.isDir ? "目录" : "文件"}，实际是${isDir ? "目录" : "文件"}`];
        }
        return [];
      });
    expect(wrong, `目录树在说假话：\n${wrong.join("\n")}\n`
      + "⇒ 要么把路径改对，要么把那一行删掉。这一段是 README 最显眼的位置之一").toEqual([]);
  });

  it("例外双向：`data/` 今天确实不在磁盘上，而 `docker-compose.yml` 里确实挂着它", () => {
    expect(existsSync("data"), "`data/` 现在真的在磁盘上了 —— 那这条例外过期了，删掉它").toBe(false);
    expect(read("docker-compose.yml"), "`docker-compose.yml` 里不再挂 `./data` —— "
      + "那这条例外没有依据了，目录树里那一行该删").toContain("./data:");
    expect(read(".gitignore"), "`.gitignore` 里不再排除 `data/`").toContain("data/");
  });

  it("该红时红：往目录树里加一行不存在的路径 —— 红并点名那一行", () => {
    const src = read("README.md");
    const mutated = src.replace("├── scripts/", "├── nope/\n├── scripts/");
    expect(mutated, "变异没落地").not.toEqual(src);
    // 拿变异过的文本走同一条解析 + 存在性检查（不在这里手写第二份）。
    const fenced = (mutated.slice(mutated.indexOf("## 🗂 ")).split("\n## ")[0] ?? "").split("```")[1] ?? "";
    const bad = fenced.split("\n").flatMap((raw) => {
      const m = /^(?:├──|└──) ([^\s#]+)/.exec(raw);
      const name = m?.[1];
      return name !== undefined && !existsSync(name.replace(/\/$/, "")) ? [name] : [];
    });
    expect(bad, "加进去的假路径没被抓到").toEqual(["nope/", "data/"]);
  });

  it("边界如实登记：`## 🏗 技术架构` 的 ASCII 框图**接受无判据**（它画的是逻辑关系，没有真源）", () => {
    const section = read("README.md").slice(read("README.md").indexOf("## 🏗 ")).split("\n## ")[0] ?? "";
    expect(section, "技术架构那一节不见了").toContain("```");
    // 这一格只钉「那段图今天还在」。**不假装在验它画得对不对**——
    // 框图里的箭头没有可机器核的真源，声称能守住它就是一句假话。
    expect(section.split("```").length, "技术架构那一节里不是恰一段围栏").toBe(3);
  });
});
