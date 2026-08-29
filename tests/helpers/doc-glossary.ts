/**
 * W134 —— 五语言术语表（同一源词在同一语言的不同文档里必须用同一译词）。
 *
 * **它为什么存在。** 出货文档的「五语言逐节对齐」那一族判据（`tests/unit/docs-parity.test.ts`
 * 的「五语言文档的派生结构对等（R1–R6）」）比的是**每一份文档内部的派生结构**：
 * 标题层级序列、围栏语言、链接数、表格行数……射程全都落在「同一份文档的五种语言之间」。
 * 那一族全绿的同时，**另一类缺陷在结构上看不见**：
 * **同一种语言、跨不同文档，同一个源词被译成了两个不同的词。**
 *
 * 实测两例（本表落地时的真实状态，不是假想）：
 * · zh-TW：`docs/zh-TW/ADMIN.md` 的 `## 排障` vs `docs/zh-TW/REGISTRAR.md` 的 `## 疑難排解`
 *   ——而且 `排障` 是简体用词，繁体正常写 `疑難排解`，那一处疑似漏翻。
 * · ja：`docs/ja/ADMIN.md` 的 `## 障害対応` vs `docs/ja/REGISTRAR.md` 的
 *   `## トラブルシューティング`。
 *
 * ── 表怎么读 ────────────────────────────────────────────────────────────────
 * 每一条 `GlossaryTerm` 是**一个 zh-CN 源词**，`renderings[lang]` 是这个源词在该语言
 * 出货文档里**实际出现过的全部译法**（不是「允许的译法」——这张表记的是现状，
 * 不是规范）。`scope` 决定判据在哪一层文本上找这些译法：
 * · `"headings"` —— 只在 `#{1,6} ` 开头的标题行里找。给那些译法在正文里另有正当含义的
 *   源词用（例：`速查` 的 ja 译法之一是 `一覧`，而 `一覧` 在正文里更常见的是「列表」的
 *   意思 ⇒ 全文扫会把一堆无关命中算成冲突）。
 * · `"all"` —— 全文（含标题）都找。
 *
 * ⚠️ **这张表不是「规范译名表」，`renderings[lang][0]` 也不是「钦定的那一个」。**
 * 本工作项**只建表与判据、不修正文**（修正文会与阶段 5B/7 的重写打架），
 * 所以表里如实记录两种译法并列的现状，由 `PENDING_TERM_CONFLICTS` 把它登记成欠账。
 * 哪一个该留、归哪一期修，写在报告里，不写死在这里——**一个没有消费者的「推荐值」
 * 迟早会漂**。
 *
 * ⚠️ **它验不了什么**（别读成「术语从此统一了」）：
 * ① 它只认表里列了的词。**表外的术语打架，判据一个都看不见**——收词是人做的，
 *    收得全不全只能靠评审。这条边界由
 *    `tests/unit/docs-glossary.test.ts` 的
 *    「③ 登记在案的射程边界：换成表外的词（`관문`）判据看不见，一行都不多」钉住。
 * ② 它比的是**字符串出现与否**，不是**语义**：同一个词在一份文档里当动词、在另一份
 *    里当名词，它一律算「同一个译法」。
 * ③ `scope: "headings"` 那几条对正文里的打架**完全失明**——那是拿射程换假阳性，
 *    是自觉的取舍，不是疏漏。
 */

export const GLOSSARY_LANGS = ["zh-TW", "en", "ja", "ko"] as const;
export type GlossaryLang = (typeof GLOSSARY_LANGS)[number];

/** 出货文档的七个基名；五语言目录下各一份，共 35 份。 */
export const GLOSSARY_DOCS = [
  "ADMIN",
  "API",
  "DEPLOY",
  "README",
  "REGISTRAR",
  "SPONSORS",
  "USAGE",
] as const;
export type GlossaryDoc = (typeof GLOSSARY_DOCS)[number];

export interface GlossaryTerm {
  /** zh-CN 源词。判据会另行要求它在 zh-CN 出货文档里真的出现过。 */
  readonly term: string;
  /** 这条为什么收进来（给读判据红信息的人看的）。 */
  readonly note: string;
  /** 在哪一层文本上找译法。 */
  readonly scope: "all" | "headings";
  /** 各语言实际出现过的译法全集。空数组 = 该语言这条没打架（判据仍会扫，扫不到就是没有）。 */
  readonly renderings: Readonly<Record<GlossaryLang, readonly string[]>>;
}

export const GLOSSARY: readonly GlossaryTerm[] = [
  {
    term: "排障",
    note: "ADJ-STAGE0 #8 实证的第一组：zh-TW 漏翻成简体用词、ja 两种说法并存",
    scope: "all",
    renderings: {
      "zh-TW": ["排障", "疑難排解"],
      en: ["Troubleshooting"],
      ja: ["障害対応", "トラブルシューティング"],
      ko: ["문제 해결"],
    },
  },
  {
    term: "凭据",
    note: "ADJ-STAGE0 #8 实证的第二组：ja / ko 各有两种说法，zh-TW 有一处写成大陆用词",
    scope: "all",
    renderings: {
      "zh-TW": ["憑證", "憑據"],
      en: ["credential"],
      ja: ["認証情報", "資格情報"],
      ko: ["자격 증명", "인증 정보"],
    },
  },
  {
    term: "调试台",
    note: "ADJ-STAGE0 #8 实证的第三组：zh-TW 的 DEPLOY 用了另一个词",
    scope: "all",
    renderings: {
      "zh-TW": ["除錯台", "偵錯台"],
      en: ["Playground"],
      ja: ["プレイグラウンド"],
      ko: ["플레이그라운드"],
    },
  },
  {
    term: "网关",
    note: "zh-TW 的 DEPLOY 里 `網關`（大陆用词）与 `閘道` 并存",
    scope: "all",
    renderings: {
      "zh-TW": ["閘道", "網關"],
      en: ["gateway"],
      ja: ["ゲートウェイ"],
      ko: ["게이트웨이"],
    },
  },
  {
    term: "协议",
    note: "zh-TW 的 `協定`（台标译法）与 `協議` 按文档分头站队",
    scope: "all",
    renderings: {
      "zh-TW": ["協定", "協議"],
      en: ["protocol"],
      ja: ["プロトコル"],
      ko: ["프로토콜"],
    },
  },
  {
    term: "并发",
    note: "zh-TW 的 `並發` / ja 的 `同時実行` 各自只在 DEPLOY 出现一两次，其余处是另一个词",
    scope: "all",
    renderings: {
      "zh-TW": ["並行", "並發"],
      en: ["concurrent"],
      ja: ["並行", "同時実行"],
      ko: ["동시"],
    },
  },
  {
    term: "邮箱",
    note: "zh-TW 的 `郵箱`（大陆用词）vs `信箱`；ko 的 `메일함` vs `메일박스`",
    scope: "all",
    renderings: {
      "zh-TW": ["郵箱", "信箱"],
      en: ["mailbox"],
      ja: ["メールボックス"],
      ko: ["메일함", "메일박스"],
    },
  },
  {
    term: "仓库",
    note: "zh-TW 的 `儲存庫` vs `倉庫`；en 的 `repository` vs 缩写 `repo`",
    scope: "all",
    renderings: {
      "zh-TW": ["儲存庫", "倉庫"],
      en: ["repository", "repo"],
      ja: ["リポジトリ"],
      ko: ["저장소"],
    },
  },
  {
    term: "免费档",
    note: "四种语言里有三种把 Cloudflare 的 free tier 写成了两个词",
    scope: "all",
    renderings: {
      "zh-TW": ["免費方案", "免費檔"],
      en: ["free tier", "free plan"],
      ja: ["無料枠", "無料プラン"],
      ko: ["무료 등급", "무료 요금제"],
    },
  },
  {
    term: "判据",
    note: "zh-TW 的 `判據` vs `判準`",
    scope: "all",
    renderings: { "zh-TW": ["判據", "判準"], en: [], ja: [], ko: [] },
  },
  {
    term: "余量",
    note: "zh-TW 的 `餘量` vs `餘裕`（后者在 REGISTRAR 内部与前者并存）",
    scope: "all",
    renderings: { "zh-TW": ["餘量", "餘裕"], en: [], ja: [], ko: [] },
  },
  {
    term: "客户端",
    note: "zh-TW 的 `用戶端`（台标）vs `客戶端`（大陆用词）",
    scope: "all",
    renderings: { "zh-TW": ["用戶端", "客戶端"], en: [], ja: [], ko: [] },
  },
  {
    term: "密钥",
    note: "zh-TW 的 `金鑰`（台标）vs `密鑰`（大陆用词）",
    scope: "all",
    renderings: { "zh-TW": ["金鑰", "密鑰"], en: [], ja: [], ko: [] },
  },
  {
    term: "注册机",
    note: "ja 的长音符号写法不统一：`レジストラー` vs `レジストラ`（后者是前者的真子串，判据按最长匹配收）",
    scope: "all",
    renderings: { "zh-TW": [], en: [], ja: ["レジストラー", "レジストラ"], ko: [] },
  },
  {
    term: "默认",
    note: "ja 的 `デフォルト` vs `既定`，两者在同一份 DEPLOY 里就并存",
    scope: "all",
    renderings: { "zh-TW": [], en: [], ja: ["デフォルト", "既定"], ko: [] },
  },
  {
    term: "文档",
    note: "ja 的 `ドキュメント` vs `文書`",
    scope: "all",
    renderings: { "zh-TW": [], en: [], ja: ["ドキュメント", "文書"], ko: [] },
  },
  {
    term: "上游",
    note: "ko 的 `업스트림` vs `상류`（后者只在 DEPLOY 出现）",
    scope: "all",
    renderings: { "zh-TW": [], en: [], ja: [], ko: ["업스트림", "상류"] },
  },
  {
    term: "速查",
    note:
      "ja 的 `早見表`（ADMIN）vs `一覧`（README）。**只扫标题**："
      + "`一覧` 在正文里更常见的是「列表」的意思，全文扫会把一堆无关命中算成冲突",
    scope: "headings",
    renderings: {
      "zh-TW": ["速查"],
      en: ["at a glance"],
      ja: ["早見表", "一覧"],
      ko: ["한눈에 보기"],
    },
  },
  {
    term: "补池",
    note: "en 的 `refill` / `top-up` / `tend` 三种说法并存（`tend` 同时是本仓代码里的动词）",
    scope: "all",
    renderings: {
      "zh-TW": ["補池"],
      en: ["refill", "top-up", "tend"],
      ja: ["補充"],
      ko: ["보충"],
    },
  },
];
