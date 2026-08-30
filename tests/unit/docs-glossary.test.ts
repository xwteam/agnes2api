/**
 * W134 —— 「同一源词在同一语言的不同文档里必须用同一译词」这条判官。
 *
 * 表在 `tests/helpers/doc-glossary.ts`，那里写了它为什么存在、怎么读、验不了什么。
 * 这里只放**判据**与它的反向控制。
 *
 * ── 判据为什么长这样（先读这一段，再读断言）────────────────────────────────
 * 本工作项**只建表与判据、不修正文**：落地当天正文里就有 28 组术语打架，
 * 修它们会与阶段 5B/7 的重写正面相撞。于是判据不能写成
 * 「一条冲突都不许有」——那样今天就是红的，只能被人加 `skip` 绕过去，
 * 而一条被绕过去的判据比没有更坏。
 *
 * 判据的形态是**欠账登记 + 逐条相等**：
 * `PENDING_TERM_CONFLICTS` 逐字记下今天的全部冲突，断言是 `toEqual`。
 * ⇒ **两个方向都会红**：
 * ① 新添一组打架（改坏了）——多出一行；
 * ② 悄悄修好一组而不销账（改好了但台账没跟上）——少一行。
 * 后者是刻意的：欠账清单是阶段 5B/7 的输入，它漂了下一期就会照着一份假清单干活。
 *
 * ⚠️ **它不判「哪个译法是对的」。** 表里两种译法并列，判据对谁去谁留没有意见——
 * 那是人的决定，写在阶段报告里。判据只保证「今天的现状被如实记着，且改动瞒不过去」。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  GLOSSARY,
  GLOSSARY_DOCS,
  GLOSSARY_LANGS,
  type GlossaryDoc,
  type GlossaryLang,
  type GlossaryTerm,
} from "../helpers/doc-glossary.js";

/** 读一份出货文档的原文。反向控制会换成夹具版本。 */
type DocReader = (lang: GlossaryLang | "zh-CN", doc: GlossaryDoc) => string;

const realDocReader: DocReader = (lang, doc) =>
  readFileSync(join("docs", lang, `${doc}.md`), "utf8");

const HEADING_LINE = /^[ \t]{0,3}#{1,6} .*$/gm;

const scopedText = (text: string, scope: GlossaryTerm["scope"]) =>
  scope === "headings" ? (text.match(HEADING_LINE) ?? []).join("\n") : text;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/**
 * 一个译法在一段文本里出现了没有。
 *
 * ⚠️ 两处形态是踩出来的，别顺手"简化"：
 * ① **拉丁字母的译法两头都要 `\b`**。只加前缀边界时 `repo` 会命中 `report`，
 *    实测把 `docs/en/API.md`（正文里只有 `report`，没有 `repo`）误算成"用了 `repo`"，
 *    整条 en `仓库` 的冲突形状当场变成假的。
 * ② **长的译法先扫、扫完抹掉**。`レジストラ` 是 `レジストラー` 的真子串，
 *    不按长度倒序扫的话，凡是写了 `レジストラー` 的文档都会被同时算成"也用了 `レジストラ`"，
 *    于是**每一份文档都冲突**——一条永远解释不清的红。
 */
function renderingsIn(text: string, variants: readonly string[]): string[] {
  let rest = text;
  const hit: string[] = [];
  for (const v of [...variants].sort((a, b) => b.length - a.length)) {
    const re = /^[\x20-\x7e]+$/.test(v)
      ? new RegExp(`\\b${escapeRe(v)}\\b`, "gi")
      : new RegExp(escapeRe(v), "g");
    if (re.test(rest)) {
      hit.push(v);
      rest = rest.replace(re, " ");
    }
  }
  return hit.sort();
}

/**
 * 冲突的可读形态：`语言｜源词｜文档=译法+译法｜文档=译法`。
 *
 * 用字符串而不是对象，是为了让 `toEqual` 失败时那张 diff **自己就说清了是哪个词、
 * 哪几份文档**——这正是本项验收要的那句「点名是哪个词、哪两份文档」。
 */
function termConflicts(read: DocReader): string[] {
  const out: string[] = [];
  for (const term of GLOSSARY) {
    for (const lang of GLOSSARY_LANGS) {
      const variants = term.renderings[lang];
      if (variants.length === 0) continue;
      const byDoc: [GlossaryDoc, string[]][] = [];
      for (const doc of GLOSSARY_DOCS) {
        const found = renderingsIn(scopedText(read(lang, doc), term.scope), variants);
        if (found.length > 0) byDoc.push([doc, found]);
      }
      const shapes = new Set(byDoc.map(([, r]) => r.join("+")));
      const conflict = shapes.size > 1 || byDoc.some(([, r]) => r.length > 1);
      if (!conflict) continue;
      out.push(
        [lang, term.term, ...byDoc.map(([doc, r]) => `${doc}=${r.join("+")}`)].join("｜"),
      );
    }
  }
  return out.sort();
}

/**
 * 今天的全部术语冲突，逐字登记。
 *
 * **归属阶段**写在本轮的阶段报告里（不随仓推送），不写进代码：
 * 阶段编号会随排期变，而一个会漂的字段迟早变成谎话。
 * ⚠️ **条数也不写进这段话**：它落地当天是 28，`docs/ja/README.md` 换成 12 节形态那天
 * 就变成了 27（`ja｜速查` 那一组真的销账了）。写死的条数会在下一次销账时静静变假，
 * 而下面那张表自己就是条数的真源。
 *
 * ── 阶段 5B-3 之一（`docs/ja/README.md` 扩成 12 节）动了哪几行 ────────────────
 * · `ja｜速查`：**整行消失**。README 那一侧的 `一覧` 没了（旧标题 `## エンドポイント一覧`
 *   被 W38 常量表的 `## 📡 API エンドポイント` 取代），只剩 ADMIN 一份用 `早見表` ⇒ 不再打架。
 * · `ja｜默认`：README 从 `デフォルト+既定` 收敛成 `既定`（**一份文档内部**两种说法并存
 *   是这张表最刺眼的那一类，先把自己这一份统一掉；`既定` 是 ADMIN / API / USAGE 三份的用词）。
 * · `ja｜文档`：README 这一侧**新进表**，用的是 ja 里已经占多数的 `ドキュメント`
 *   ——**没有制造新的分歧**，只是这份文档从此也被这条判据看着了。
 * · 其余各行的分歧全在 ADMIN / DEPLOY / REGISTRAR 一侧，**不是本步的射程**，原样留着。
 *
 * ── 阶段 5B-3 之二（`docs/ko/README.md` 扩成 12 节）动了哪几行 ────────────────
 * · `ko｜凭据`：README 从 `인증 정보` 改成 `자격 증명` —— ADMIN / DEPLOY / REGISTRAR
 *   三份用的都是后者，README 跟上多数（USAGE 那一份仍是 `인증 정보`，归阶段 7）。
 * · `ko｜邮箱`：README 这一侧**新进表**（`메일함`）。⚠️ 这一条**不是销账**：
 *   `메일함` 与 `메일박스` 今天在 DEPLOY / REGISTRAR 内部就并存，谁去谁留还没定，
 *   README 只是挑了其中一个、把自己这一份写统一，**分歧一条没少**。
 * · `ko｜上游`（`README=업스트림`）与 `ko｜免费档`（`README=무료 등급`）**逐字不动**：
 *   前者是下面反向控制 ④ 的支点（它拿 ko/README 的 `업스트림` 制造新冲突），
 *   后者本来就是多数用词。
 *
 * ── 阶段 5B-3 之三（`docs/zh-TW/README.md` 扩成 12 节）动了哪几行 ────────────
 * 🔴 **这一步销账数是 0，六行只是换了形状。** 别把「动了六行」读成「统一了六个词」——
 * 下面这六行今天的分歧**全部落在 README 之外的那几份**（ADMIN / DEPLOY / REGISTRAR /
 * SPONSORS 内部或彼此之间），README 这一侧改成什么都消不掉它们。**一行都消不掉**
 * 这件事本身是可核的：`zh-TW｜排障` 要 ADMIN 那份改口、`zh-TW｜调试台` 要 DEPLOY
 * 那份改口、`zh-TW｜余量` 要 REGISTRAR 那份**内部**先统一 —— 三处都不在本步射程里。
 * · `zh-TW｜客户端`：README 从 `客戶端`（大陆用词）改成 `用戶端`（台标），跟上 API / USAGE。
 *   ⚠️ 这不是销账：DEPLOY 那一份自己内部两种都在写，ADMIN 仍是 `客戶端`。
 * · `zh-TW｜仓库`：README 这一侧**新进表**（`儲存庫`，台标，与 REGISTRAR 同）。
 *   DEPLOY / SPONSORS 仍写 `倉庫` ⇒ 分歧一条没少，只是 README 也被看着了。
 * · `zh-TW｜密钥`：README 这一侧**新进表**（`金鑰`，台标，与 REGISTRAR 同）。
 * · `zh-TW｜调试台`：README 这一侧**新进表**（`除錯台`，与 ADMIN 同；DEPLOY 的 `偵錯台` 照旧）。
 * · `zh-TW｜邮箱`：README 这一侧**新进表**（`信箱`，与 REGISTRAR 同、也是 DEPLOY 里的多数）。
 * · `zh-TW｜余量`：README **退出这一行**。旧的 9 节骨架里有一句讲 KV 配额余量，
 *   12 节形态的 README 不再展开那笔账（它归 DEPLOY.md 的「配额帐」小节），
 *   `餘量` 在 README 里就此零命中。**同样不是销账**：DEPLOY 与 REGISTRAR 之间照旧打架。
 * · `zh-TW｜免费档`（`README=免費方案`）、`zh-TW｜凭据`（`README=憑證`）、
 *   `zh-TW｜协议`（`README=協議`）、`zh-TW｜网关`（`README=閘道`）**逐字不动**：
 *   四条本来就写的是多数用词，重写时照原样搬了过去。
 *   ⚠️ `zh-TW｜排障` 那一行 README 两侧都不沾（`排障` / `疑難排解` 一次都没写），
 *   它是下面反向控制 ①② 的支点，本步一个字都不许碰。
 */
const PENDING_TERM_CONFLICTS: readonly string[] = [
  "en｜仓库｜ADMIN=repo｜API=repo｜DEPLOY=repo+repository｜REGISTRAR=repository｜SPONSORS=repository",
  "en｜免费档｜DEPLOY=free plan+free tier",
  "en｜补池｜ADMIN=refill+tend｜DEPLOY=refill+tend｜README=refill｜REGISTRAR=refill+tend+top-up",
  "ja｜免费档｜DEPLOY=無料プラン+無料枠｜README=無料枠",
  "ja｜凭据｜ADMIN=資格情報｜API=認証情報｜DEPLOY=認証情報+資格情報｜README=認証情報｜REGISTRAR=認証情報+資格情報｜USAGE=認証情報",
  "ja｜并发｜ADMIN=並行｜DEPLOY=並行+同時実行｜REGISTRAR=並行",
  // ⚠️ P3f 阶段 7B（W99）新增 `DEPLOY=トラブルシューティング` 那一格：DEPLOY.md 的 15 节骨架
  // 由 `DOC_SECTIONS` 钉死，ja 第 9 槽的译名就是 `## トラブルシューティング`（W124 从两仓实测
  // 出来的 K∩G 值）。⇒ 这一格**不是新的漏翻，是骨架落地的必然结果**，而且它让这一条欠账
  // 从「ADMIN 与 REGISTRAR 两份打架」变成「ADMIN 一份孤立」——修的时候动 ADMIN 那一份即可。
  "ja｜排障｜ADMIN=障害対応｜DEPLOY=トラブルシューティング｜REGISTRAR=トラブルシューティング",
  "ja｜文档｜ADMIN=ドキュメント+文書｜API=ドキュメント｜DEPLOY=ドキュメント+文書｜README=ドキュメント｜SPONSORS=ドキュメント",
  "ja｜注册机｜ADMIN=レジストラ+レジストラー｜DEPLOY=レジストラ+レジストラー｜README=レジストラー｜REGISTRAR=レジストラー｜SPONSORS=レジストラ",
  "ja｜默认｜ADMIN=既定｜API=既定｜DEPLOY=デフォルト+既定｜README=既定｜REGISTRAR=デフォルト+既定｜USAGE=既定",
  "ko｜上游｜ADMIN=업스트림｜API=업스트림｜DEPLOY=상류+업스트림｜README=업스트림｜REGISTRAR=업스트림",
  "ko｜免费档｜DEPLOY=무료 등급+무료 요금제｜README=무료 등급",
  "ko｜凭据｜ADMIN=자격 증명｜API=인증 정보+자격 증명｜DEPLOY=자격 증명｜README=자격 증명｜REGISTRAR=자격 증명｜USAGE=인증 정보",
  "ko｜邮箱｜ADMIN=메일박스｜DEPLOY=메일박스+메일함｜README=메일함｜REGISTRAR=메일박스+메일함",
  "zh-TW｜仓库｜DEPLOY=倉庫｜README=儲存庫｜REGISTRAR=儲存庫｜SPONSORS=倉庫",
  "zh-TW｜余量｜DEPLOY=餘量｜REGISTRAR=餘裕+餘量",
  "zh-TW｜免费档｜DEPLOY=免費方案+免費檔｜README=免費方案",
  "zh-TW｜凭据｜ADMIN=憑證｜API=憑證｜DEPLOY=憑據+憑證｜README=憑證｜REGISTRAR=憑證｜USAGE=憑證",
  "zh-TW｜判据｜API=判據｜DEPLOY=判據+判準｜REGISTRAR=判據+判準",
  "zh-TW｜协议｜ADMIN=協定｜API=協定+協議｜DEPLOY=協定｜README=協議｜SPONSORS=協議｜USAGE=協議",
  "zh-TW｜客户端｜ADMIN=客戶端｜API=用戶端｜DEPLOY=客戶端+用戶端｜README=用戶端｜USAGE=用戶端",
  "zh-TW｜密钥｜ADMIN=密鑰｜DEPLOY=密鑰｜README=金鑰｜REGISTRAR=金鑰",
  "zh-TW｜并发｜ADMIN=並行｜DEPLOY=並發+並行｜REGISTRAR=並行",
  "zh-TW｜排障｜ADMIN=排障｜REGISTRAR=疑難排解",
  "zh-TW｜网关｜ADMIN=閘道｜API=閘道｜DEPLOY=網關+閘道｜README=閘道｜REGISTRAR=閘道｜USAGE=閘道",
  "zh-TW｜调试台｜ADMIN=除錯台｜DEPLOY=偵錯台｜README=除錯台",
  "zh-TW｜邮箱｜ADMIN=郵箱｜DEPLOY=信箱+郵箱｜README=信箱｜REGISTRAR=信箱",
];

describe("W134 五语言术语表：同一源词在同一语言的不同文档里必须用同一译词", () => {
  it("术语表里的每个源词都真的出现在 zh-CN 出货文档里（表不许指向不存在的词）", () => {
    const missing = GLOSSARY.filter((t) => {
      const hits = GLOSSARY_DOCS.filter((doc) =>
        scopedText(realDocReader("zh-CN", doc), t.scope).includes(t.term),
      );
      return hits.length === 0;
    }).map((t) => t.term);
    expect(missing, "这些源词在 zh-CN 出货文档里一次都没出现——表锈了").toEqual([]);
  });

  it("每条术语至少给一种语言列了译法（空行等于这条什么都不验）", () => {
    const empty = GLOSSARY.filter((t) =>
      GLOSSARY_LANGS.every((l) => t.renderings[l].length === 0),
    ).map((t) => t.term);
    expect(empty, "这些术语条目五种语言全空，扫也扫不出东西来").toEqual([]);
  });

  it("今天的术语冲突全集与欠账登记逐条相等", () => {
    expect(termConflicts(realDocReader)).toEqual([...PENDING_TERM_CONFLICTS]);
  });
});

describe("W134 判官的反向控制（换掉读文件那一步，注入夹具）", () => {
  /** 在真文本上做一次定点替换，其余原样。 */
  const patched = (
    lang: GlossaryLang | "zh-CN",
    doc: GlossaryDoc,
    from: string,
    to: string,
  ): DocReader =>
    (l, d) => {
      const text = realDocReader(l, d);
      return l === lang && d === doc ? text.split(from).join(to) : text;
    };

  it("① 把 zh-TW/REGISTRAR.md 的「疑難排解」改成「排障」⇒ 冲突消失、台账对不上，红里点名是哪个词哪两份文档", () => {
    const after = termConflicts(patched("zh-TW", "REGISTRAR", "疑難排解", "排障"));
    expect(after).not.toEqual([...PENDING_TERM_CONFLICTS]);
    // 少掉的正是那一行，而那一行自己就写着源词与两份文档。
    const gone = PENDING_TERM_CONFLICTS.filter((c) => !after.includes(c));
    expect(gone).toEqual(["zh-TW｜排障｜ADMIN=排障｜REGISTRAR=疑難排解"]);
    expect(gone[0]).toContain("排障");
    expect(gone[0]).toContain("ADMIN");
    expect(gone[0]).toContain("REGISTRAR");
  });

  it("② 反过来：把 zh-TW/ADMIN.md 的「排障」也改成「疑難排解」⇒ 同样红，因为两份就此一致了", () => {
    const after = termConflicts(patched("zh-TW", "ADMIN", "排障", "疑難排解"));
    expect(after).not.toEqual([...PENDING_TERM_CONFLICTS]);
    expect(after).not.toContain("zh-TW｜排障｜ADMIN=排障｜REGISTRAR=疑難排解");
  });

  it("③ 登记在案的射程边界：换成表外的词（`관문`）判据看不见，一行都不多", () => {
    const after = termConflicts(patched("ko", "README", "게이트웨이", "관문"));
    const added = after.filter((c) => !PENDING_TERM_CONFLICTS.includes(c));
    expect(added).toEqual([]);
    // ⚠️ 上面这一格**故意断言"没多出来"**：`관문` 不在术语表的 `renderings.ko` 里，
    // 判据看不见它——这正是表的射程边界（表外的词一律失明），
    // 写成用例是为了让这条边界**有人守**，而不是留在注释里当传说。
    // 真正能被看见的新冲突见下一格。
  });

  it("④ 用表内已列的译法制造新冲突：把 ko/README.md 的「업스트림」换成「상류」⇒ ko 上游那一行的形状变了", () => {
    const before = PENDING_TERM_CONFLICTS.find((c) => c.startsWith("ko｜上游"))!;
    const after = termConflicts(patched("ko", "README", "업스트림", "상류"));
    expect(after).not.toContain(before);
    expect(after.find((c) => c.startsWith("ko｜上游"))).toContain("README=상류");
  });

  it("⑤ 判据没有被夹具本身骗过：不做任何替换时，夹具读法给出的结果与真读法逐条相等", () => {
    expect(termConflicts(patched("ko", "README", "不存在的字符串", "x"))).toEqual(
      termConflicts(realDocReader),
    );
  });
});
