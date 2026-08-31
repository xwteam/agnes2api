import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * **出货文档全集**（今天 40 份）= 仓根全部 `.md` + `docs/{5 语言}/*.md`，**从磁盘现算**。
 *
 * ── 为什么住在 helpers 而不是某一份判官文件里 ────────────────────────────────
 * 它原先是排版判官那份文件里的一个模块级常量，于是偏离名册第 17 条
 *（面板那份开发笔记移出排版射程）够不着它，只好自己拿 `readdirSync(".")` 凑一份射程
 * —— 而那个凑法**结构上不可能红**：`readdirSync(".")` 返回的是当前目录的**裸文件名**，
 * 永远不含斜杠，于是那句 `includes` 恒为 `false`（评审实测：
 * `node -e` 直接求值就是 `false`）。一条恒绿的登记比没有登记更坏。
 * ⇒ 真源挪到这里，两个消费者 import 同一份，名册那一条才真的盯得住射程。
 *
 * ⚠️ **不含 `.github` 下那三份社区模板，也不含面板那份开发笔记**：
 * 后者是 Q15 的具名裁定（偏离名册第 17 条）。两者都不在本函数的输出里。
 *
 * 🔴 **这份射程只服务排版轴（D4 的 16 节骨架），不许拿它当泄漏轴的射程**。
 * 名册第 17 条豁免的是「套 16 节骨架毫无意义」——那是**排版**上的裁定；
 * 裁定 ㉚（公开仓不暴露内部路线图与阶段编号）是**另一根轴**，它一个字都没豁免。
 * 泄漏轴要用的是下面那份 `publicDocs()`。两根轴共用一份射程，就等于把一条排版豁免
 * 静静升级成泄漏豁免——本仓真的这么栽过一次，`docs-deviations.test.ts` 里有一格钉着它。
 */
export const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;

export const shipDocs = (): readonly string[] => {
  const rootDocs = readdirSync(".").filter((f) => f.endsWith(".md")).sort();
  const langDocs = LANGS.flatMap((lang) =>
    readdirSync(join("docs", lang)).filter((f) => f.endsWith(".md")).sort()
      .map((f) => join("docs", lang, f)));
  return [...rootDocs, ...langDocs];
};

/** `.github` 下（含子目录）全部 `.md`，**递归现算**：新加一份模板会自动进射程。 */
const githubDocs = (dir = ".github"): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...githubDocs(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
};

/**
 * **公开仓里读者读得到的 markdown 全集**（今天 44 份）= `shipDocs()` 那 40 份
 * + `admin-ui/README.md` + `.github` 下（含子目录）全部 `.md`（今天 3 份），**从磁盘现算**。
 *
 * ── 它为什么必须比 `shipDocs()` 宽 ────────────────────────────────────────
 * 泄漏轴（ADJ ㉚）判的是「推上去之后读者能不能读到内部研发轨迹」，与「这份文档要不要
 * 套 16 节骨架」毫无关系。`admin-ui/README.md` **确实是出货文档**：`CHANGELOG.md` 正文
 * 直接把读者指过去，`docs-parity.test.ts` 里那一组自己写着「第一个访客会看到的三份自述」。
 * `.github` 下那三份同理——提 issue / 开 PR 的人第一眼看的就是它们。
 * 它们不进排版射程是**排版轴**的裁定（名册第 17、18 条），拿那条裁定去挡泄漏轴，
 * 就是把一条排版豁免升级成泄漏豁免。
 *
 * ⚠️ **别改成「`shipDocs()` 也返回这 44 份」来省一个函数**：排版判官与名册第 17 条
 * 都靠 `shipDocs()` 恰好是那 40 份，混成一份两边都会当场红，且第 17 条会失去意义。
 */
export const publicDocs = (): readonly string[] => [
  ...shipDocs(),
  join("admin-ui", "README.md"),
  ...githubDocs(),
];
