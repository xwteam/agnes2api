/**
 * README 的章节标题常量表（根 16 节 / 语言版 12 节 × 五语言）。
 *
 * **它是什么。** 参照仓 kiro2api / gemini2api 的根 `README.md` 有一套**逐字节相同**的
 * 16 节骨架，`docs/{lang}/README.md` 承载其中 **12 节**（去掉 4 节根专属）。
 * 这张表把那 16 行 × 5 语言逐字钉下来，供后续「章节骨架」那条判据（R11）当
 * `toEqual` 的右操作数：根断言 `SECTIONS.map(s => s["zh-CN"])`，
 * 每份语言版断言 `SECTIONS.filter(s => !s.rootOnly).map(s => s[lang])`。
 *
 * **「五语言逐节对齐」是这张表的结构性副产物**——五份都从同一张表的同一批下标取值，
 * 对不齐在数据结构上就不可能。
 *
 * ── 出处，以及哪些格子是**新定的** ────────────────────────────────────────
 * 12 行 × 4 语言的译名在两个参照仓里**逐字一致**，直接照抄。
 * 剩下的格子在两仓的**完整（非浅克隆）历史**里都查不到实例，只能新定；
 * 新定的格子逐一登记在 `COINED` 里，**不许假装是抄来的**。
 * 查证方式（两仓各 99 / 若干个提交的 `git rev-list --all` 全量 `git grep`）：
 * · `## ⭐ Star History` 在 `docs/ja/README.md` 的历史版本里出现过、且**没有翻译**，
 *   en 同理 ⇒ ko / zh-TW 按同一先例照写，属「有先例的新定」。
 * · `🏗 技术架构` / `⚠ 免责声明` 在 ja / ko / zh-TW 下**一个实例都没有**；
 *   `🗂 项目结构` 在 zh-TW 下也没有 ⇒ 纯新定。
 *   新定时贴着两仓里已确立的**构词法**走，不自己另起炉灶：
 *   `架构` 在 ja / ko / zh-TW 已确立为 `アーキテクチャ` / `아키텍처` / `架構`
 *  （来源是两仓都有的 `### ⚡ 高性能アーキテクチャ` / `### ⚡ 고성능 아키텍처` /
 *   `### ⚡ 高效能架構`），`项目` 在 zh-TW 已确立为 `專案`（`## 💖 支持專案`）。
 *
 * ⚠️ **本表只是常量，能不能证明仓里的 README 长成这样，全看它有几个消费者。**
 * 根那一半已经落地：根 README 就是本表 zh-CN 那一列的 16 节形态，由
 * `tests/unit/docs-parity.test.ts` 的「⑥ R11（根）：根 README 的 16 节标题逐字命中……」
 * 逐字守着；`docs/{lang}/README.md` 今天仍是旧骨架，语言版那 12 节的 `toEqual` 等阶段 5B。
 * 第二个消费者是下标 11——五份 `docs/{lang}/SPONSORS.md` 的 H1 正是这一行，判据拿它
 * 当阳性对照，守住根判据够不着的**五语言**那一维。
 */

export const SECTION_LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
export type SectionLang = (typeof SECTION_LANGS)[number];

export interface ReadmeSection {
  /** 五语言的 `## ` 全行（含 emoji），逐字。 */
  readonly title: Readonly<Record<SectionLang, string>>;
  /** 只在根 README 出现、语言版不承载。四节：技术架构 / 项目结构 / Star History / 免责声明。 */
  readonly rootOnly?: true;
}

const s = (
  zhCN: string,
  zhTW: string,
  en: string,
  ja: string,
  ko: string,
  rootOnly?: true,
): ReadmeSection => ({
  title: { "zh-CN": zhCN, "zh-TW": zhTW, en, ja, ko },
  ...(rootOnly ? { rootOnly } : {}),
});

export const SECTIONS: readonly ReadmeSection[] = [
  s("## 📝 最近更新", "## 📝 最近更新", "## 📝 Recent Updates", "## 📝 最近の更新", "## 📝 최근 업데이트"),
  s("## 🌟 核心功能", "## 🌟 核心功能", "## 🌟 Core Features", "## 🌟 主な機能", "## 🌟 핵심 기능"),
  s("## 🏗 技术架构", "## 🏗 技術架構", "## 🏗 Architecture", "## 🏗 技術アーキテクチャ", "## 🏗 기술 아키텍처", true),
  s("## 📋 系统要求", "## 📋 系統需求", "## 📋 System Requirements", "## 📋 システム要件", "## 📋 시스템 요구사항"),
  s("## ⚡ 快速部署", "## ⚡ 快速部署", "## ⚡ Quick Deployment", "## ⚡ クイックデプロイ", "## ⚡ 빠른 배포"),
  s("## 🧪 接入示例", "## 🧪 接入範例", "## 🧪 Integration Examples", "## 🧪 統合例", "## 🧪 통합 예제"),
  s("## 📡 API 端点", "## 📡 API 端點", "## 📡 API Endpoints", "## 📡 API エンドポイント", "## 📡 API 엔드포인트"),
  s("## ⚙ 配置说明", "## ⚙ 設定說明", "## ⚙ Configuration", "## ⚙ 設定", "## ⚙ 설정"),
  s("## ⚠ 注意事项", "## ⚠ 注意事項", "## ⚠ Important Notes", "## ⚠ 重要な注意事項", "## ⚠ 주의사항"),
  s("## 🗂 项目结构", "## 🗂 專案結構", "## 🗂 Project Structure", "## 🗂 プロジェクト構成", "## 🗂 프로젝트 구조", true),
  s("## 🗺 开发路线", "## 🗺 開發路線", "## 🗺 Roadmap", "## 🗺 ロードマップ", "## 🗺 로드맵"),
  s("## ☕ 赞赏 & 共享", "## ☕ 贊賞 & 共享", "## ☕ Support & Contribute", "## ☕ サポート & 貢献", "## ☕ 후원 & 기여"),
  s("## 🙏 致谢", "## 🙏 致謝", "## 🙏 Acknowledgments", "## 🙏 謝辞", "## 🙏 감사의 말"),
  s("## ⭐ Star History", "## ⭐ Star History", "## ⭐ Star History", "## ⭐ Star History", "## ⭐ Star History", true),
  s("## 📄 许可协议", "## 📄 授權協議", "## 📄 License", "## 📄 ライセンス", "## 📄 라이선스"),
  s("## ⚠ 免责声明", "## ⚠ 免責聲明", "## ⚠ Disclaimer", "## ⚠ 免責事項", "## ⚠ 면책 조항", true),
];

/**
 * 新定的格子：`下标:语言` → 理由。**这张表存在的唯一目的是不许把新定的当成抄来的。**
 *
 * 「有先例」与「纯新定」写在理由里，两者的把握程度差着一档：前者有 en / ja 的同款实例，
 * 后者只有构词法可依。评审拿这张表当"哪些译名需要人再看一眼"的清单。
 */
export const COINED: Readonly<Record<string, string>> = {
  "2:zh-TW": "纯新定；`架構` 取自两仓都有的 `### ⚡ 高效能架構`",
  "2:ja": "纯新定；`アーキテクチャ` 取自两仓都有的 `### ⚡ 高性能アーキテクチャ`",
  "2:ko": "纯新定；`아키텍처` 取自两仓都有的 `### ⚡ 고성능 아키텍처`",
  "9:zh-TW": "纯新定；`專案` 取自 zh-TW 的 `## 💖 支持專案`",
  "13:zh-TW": "有先例：en / ja 的历史实例都写 `## ⭐ Star History`，不翻译",
  "13:ko": "有先例：同上",
  "15:zh-TW": "纯新定；两仓无任何免责声明标题的繁体实例",
  "15:ja": "纯新定；同上",
  "15:ko": "纯新定；同上",
};
