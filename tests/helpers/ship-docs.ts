import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * **出货文档全集**（今天 40 份）= 仓根全部 `.md` + `docs/{5 语言}/*.md`，**从磁盘现算**。
 *
 * ── 为什么住在 helpers 而不是某一份判官文件里 ────────────────────────────────
 * 它原先是排版判官那份文件里的一个模块级常量，于是偏离名册第 17 条
 *（面板那份开发笔记移出排版射程）够不着它，只好自己拿 `readdirSync(".")` 凑一份射程
 * —— 而那个凑法**结构上不可能红**：`readdirSync(".")` 返回的是当前目录的**裸文件名**，
 * 永远不含斜杠，于是那句 `includes` 恒为 `false`（P3f 整分支评审发现 17 实测：
 * `node -e` 直接求值就是 `false`）。一条恒绿的登记比没有登记更坏。
 * ⇒ 真源挪到这里，两个消费者 import 同一份，名册那一条才真的盯得住射程。
 *
 * ⚠️ **不含 `.github` 下那三份社区模板，也不含面板那份开发笔记**：
 * 后者是 Q15 的具名裁定（偏离名册第 17 条）。两者都不在本函数的输出里。
 */
export const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;

export const shipDocs = (): readonly string[] => {
  const rootDocs = readdirSync(".").filter((f) => f.endsWith(".md")).sort();
  const langDocs = LANGS.flatMap((lang) =>
    readdirSync(join("docs", lang)).filter((f) => f.endsWith(".md")).sort()
      .map((f) => join("docs", lang, f)));
  return [...rootDocs, ...langDocs];
};
