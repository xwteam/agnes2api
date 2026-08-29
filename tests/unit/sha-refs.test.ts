import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { UI_BUILD_HASH } from "../../src/ui/assets.generated.js";

/**
 * ── tracked 文件里的提交 sha 引用必须解析得开（P3e Task 35 补漏评审 发现 3）─────────
 *
 * **这个文件存在的理由是一次实测的盲区。** Task 35 那次一次性历史重写把全部提交的 sha
 * 换了一遍，随后往 12 份 tracked 文件里回填了一批新 sha。补漏评审拿变异探针一试就穿了：
 *
 * · 把 `docs/**.md` 里一个真 sha 换成死 sha ⇒ `scripts/check-comment-refs.mjs`、
 *   `scripts/scan-secrets.sh`、`scripts/check-i18n.mjs` 这三道门禁**全绿**；
 * · 把 `src/core/admin/usage-stats.ts` 注释里的真 sha 换成死 sha ⇒
 *   `scripts/check-comment-refs.mjs` 这道门禁**绿**、`tsc` 也**绿**
 *   （它只校验**路径**指向解析得开，从来不看 sha）；
 * · 正向控制：把同一个文件注释里一条真**路径**引用改坏 ⇒ 那道门禁**红**、报文精确
 *   ⇒ 工具跑了、也能红，上面那两处的绿是**真盲区**，不是脚本没执行。
 *
 * 于是那批回填出来的 sha 是**一张没有任何东西守得住的手写表**——违反本期头号纪律
 * 「一个不会自己红的清单不是守卫，是待办」。今天它们碰巧全是对的；只要有人 rebase /
 * amend / 再重写一次历史，它们会**静默腐烂**，而十二道门禁一道都不会响。
 *
 * ⚠️ **本期不新增门禁编号**（`tests/unit/scripts-guard.test.ts`「CI 恰好十二道门，编号 1/12 到
 * 12/12 各出现一次」那一格钉着），所以这条守卫写成 `tests/unit/` 下的用例，
 * 跟着 `pnpm test` 那道门禁一起跑。
 *
 * ── 判据：什么算「一处 sha 引用」───────────────────────────────────────────────
 *
 * 光看「像不像十六进制」是**不够**的，这一点是量出来的不是想出来的：全 tracked 文件里
 * 7–40 位小写十六进制的 token 有一百多个，绝大多数根本不是 sha ——毫秒时长、Unix 时间戳、
 * UUID 的头一段、夹具里的假 key id、`assets.generated.ts` 里每份资源的 ETag。
 * 照评审建议的字面写法（「凡形如 sha 的 token 都得解析得开」）直接落地，会一次炸出
 * **一百多条**误报，逼出一张长长的豁免名册——而**豁免名册会变成永久的洞**。
 *
 * 所以判据由三件事**同时**决定，缺一条就会把噪音收进来：
 *
 *  1. **长度**：只收 7 / 8 / 40 位。
 *     **7 位**是本仓全部提交 sha 引用的实际长度（实测：一个 8 位的都没有）；
 *     **8 位**收进来是因为已销毁那三个 blob 里有一个是 8 位写法，另外 git 在缩写撞车时
 *     也会多给一位；**40 位**是完整 sha，本仓今天**一处都没有**，留着是为了将来有人写全。
 *     9–39 位的连续十六进制串在本仓里**没有一个是 sha**
 *     （实测：夹具 id、ETag、`0123456789abcdef` 这类手写常量全落在这一段）。
 *     ⚠️ 正则取的是**极大连续段**（`{7,40}` 贪婪），所以 9 位的 `abc887766` 得到的是
 *     整个 9 位段、随即被长度判据剔掉，**不会**退化成里面那个 8 位子串。
 *  2. **两侧的邻居**：紧邻的字符不许是 `[0-9A-Za-z._/\"'-]`。这一条把
 *     「引号里的字符串字面量」「带前缀的夹具名」「小数/科学计数法」「路径的一段」
 *     全部挡在外面——它们都是**别的东西的一部分**，不是一处独立的对象引用。
 *     反引号**刻意不在**这张表里：本仓写 sha 的主形态就是反引号包起来。
 *  3. **含不含字母**：不含 a–f 的串**按数字处理，不要求它解析得开**。
 *     ⚠️ **别把这条读成「纯十进制的都是数字」——那是一句假全称句**：本仓在这个射程里
 *     实有十来个纯十进制串，**其中两个恰恰是真的 sha 引用**，其余才是冷却毫秒数、
 *     `1234567` 这种千分位夹具之类。
 *     ⚠️ **所以这一格是一条真盲区，明写在这里**：一个**恰好不含 a–f** 的 7 位 sha 缩写，
 *     一旦腐烂就与一个普通十进制数**形状上无法区分**，靠形状永远认不出来。
 *     ⇒ 那两个不靠形状，而靠下面 `DECIMAL_SHA_REFS` 那张**双向校验**的登记表兜着。
 *
 * ── 三张表，每一张都有让它变红的路 ────────────────────────────────────────────
 *
 * · `DESTROYED_OBJECTS`：Task 35 那次重写**有意销毁**的 blob，正文逐字引着它们的 sha
 *   作为史实记录。它们按构造解析不开，且**没有后继**（commit 有 commit-map 可映射，
 *   blob 没有），所以不可回填。
 *   会红的路有两条：条目在扫描结果里**找不到**了（正文改写过 ⇒ 名册发霉）；
 *   条目**居然解析得开**了（那句「已销毁」是假话）。
 * · `DECIMAL_SHA_REFS`：纯十进制的 sha 引用登记表。
 *   会红的路有两条：条目解析不开了（sha 腐烂了）；扫描发现了**没登记**的同族条目。
 * · 主扫描本身：任何一个含字母、在引用位置、解析不开又不在名册上的 token ⇒ 红。
 *
 * ⚠️ **探针与真扫描共用同一份判据**：下面的正向 / 反向控制走的是同一个 `shaRefsIn()`
 * 与同一个 `resolveTypes()`（真的去问这个仓的 git），不是另写一遍。判据用错工具时不会
 * 报错、会静静地放行——本期已经在这上面栽过一次。
 *
 * ⚠️ **反向控制一律用仓里真实存在的串**，并且**当场断言那个串今天还在那个文件里**；
 * 夹具一旦对不上就吵，而不是安安静静地空跑。
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function git(args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    ...(input === undefined ? {} : { input }),
  });
}

/** 极大连续十六进制段。贪婪，所以 9 位串给出的是整段而不是里面的 8 位子串。 */
const HEX_RUN = /[0-9a-f]{7,40}/g;
/** 紧邻这些字符 ⇒ 它是别的东西的一部分，不是一处独立的对象引用。反引号刻意不在其中。 */
const GLUE = /[0-9A-Za-z._/\\"'-]/;
/** git 在本仓给出的缩写长度（7，撞车时 8）与完整 sha 长度（40）。 */
const REF_LENGTHS = new Set([7, 8, 40]);

export type ShaRef = { token: string; line: number; text: string };

/** **唯一的判据**。真扫描与探针都只走这一个函数。 */
export function shaRefsIn(text: string): ShaRef[] {
  const out: ShaRef[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(HEX_RUN)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!REF_LENGTHS.has(m[0].length)) continue;
      const before = start > 0 ? (line[start - 1] ?? "") : "";
      const after = end < line.length ? (line[end] ?? "") : "";
      if (GLUE.test(before) || GLUE.test(after)) continue;
      out.push({ token: m[0], line: i + 1, text: line.trim() });
    }
  });
  return out;
}

const hasHexLetter = (t: string) => /[a-f]/.test(t);

/**
 * 一次问清一批 token 在**这个仓**里是什么。
 * `missing` / `ambiguous` 都算「解析不开」——一个指不准的引用和一个指不到的引用，
 * 对读者是同一件事。
 */
function resolveTypes(tokens: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (tokens.length === 0) return map;
  let raw = "";
  try {
    raw = git(["cat-file", "--batch-check"], tokens.join("\n") + "\n");
  } catch (e) {
    raw = String((e as { stdout?: string }).stdout ?? "");
  }
  const lines = raw.replace(/\n$/, "").split("\n");
  // 行数对不上 ⇒ 下面按下标配对就会给出**静默的错误答案**。宁可当场吵。
  expect(lines.length, "git cat-file --batch-check 的行数与输入 token 数对不上，配对会错位").toBe(
    tokens.length,
  );
  tokens.forEach((t, i) => {
    const l = lines[i] ?? "";
    map.set(
      t,
      l.includes(" missing")
        ? "missing"
        : l.includes(" ambiguous")
          ? "ambiguous"
          : (l.split(" ")[1] ?? "?"),
    );
  });
  return map;
}

/**
 * Task 35 那次重写**有意销毁**的对象。正文逐字引着它们，作为「这里曾经有过什么」的
 * 史实记录；它们是 blob，没有后继 sha，机械回填这条路按构造不存在。
 */
const DESTROYED_OBJECTS: Record<string, string> = {
  e58deadb: "P1 核心网关设计文档的第一版，历史泄漏的载体，Task 35 重写时销毁",
  "1f8baa2": "P3e 计划文档的历史版本之一（二次泄漏），Task 35 重写时销毁",
  "0c0b540": "P3e 计划文档的历史版本之一（二次泄漏），Task 35 重写时销毁",
};

/**
 * **不含 a–f 的 sha 引用**。形状上与一个普通十进制数无法区分，所以只能逐条登记。
 * 这张表两个方向都被下面的用例校验：条目必须仍是 commit；扫描不许发现表外的同族条目。
 */
const DECIMAL_SHA_REFS = ["0472371", "3616865"];

/** 全部 tracked 文本文件。二进制由 `scripts/check-no-binary.mjs` 那道门禁挡着，这里遇到就跳过。 */
function trackedTexts(): { file: string; text: string }[] {
  const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const out: { file: string; text: string }[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    out.push({ file: f, text });
  }
  return out;
}

type Hit = ShaRef & { file: string };

function scan(entries: { file: string; text: string }[]): Hit[] {
  const out: Hit[] = [];
  for (const { file, text } of entries) {
    for (const r of shaRefsIn(text)) out.push({ file, ...r });
  }
  return out;
}

const scanRepo = () => scan(trackedTexts());

/**
 * **整条流水线**：扫描 → 只留含字母的（纯十进制走 `DECIMAL_SHA_REFS` 那条路）→
 * 问 git → 扣掉已销毁名册。剩下的每一条都是一处会让读者看到
 * `Not a valid object name` 的死引用。
 *
 * ⚠️ 真扫描与正向/反向控制**共用这一个函数**。只共用分词器是不够的：本期的教训是
 * 「判据用错工具时不会报错，会静静地放行」，而放行发生在分词之后的每一层。
 */
function offenders(entries: { file: string; text: string }[]): string[] {
  const hits = scan(entries).filter((h) => hasHexLetter(h.token));
  if (hits.length === 0) return [];
  const types = resolveTypes([...new Set(hits.map((h) => h.token))]);
  return hits
    .filter((h) => types.get(h.token) !== "commit" && !(h.token in DESTROYED_OBJECTS))
    .map((h) => `${h.file}:${h.line} 的 ${h.token} 在本仓 ${types.get(h.token)}\n    ${h.text}`);
}

describe("tracked 文件里的提交 sha 引用", () => {
  /**
   * 浅仓里**老提交本来就解析不开**，此时这条守卫报出来的红全是假的。
   * 照 `scripts/scan-secrets.sh --history` 的既有写法 fail closed，
   * 且报文点名「浅仓」这个真原因——绝不让人以为是 sha 烂了。
   */
  it("(0) 前置：这里是一个能读的、非浅的 git 仓，否则 fail closed 并说清真原因", () => {
    let shallow: string;
    try {
      shallow = git(["rev-parse", "--is-shallow-repository"]).trim();
    } catch (e) {
      throw new Error(`这里不是一个能读的 git 仓库，判不了 sha 引用（fail closed）：${String(e)}`);
    }
    expect(
      shallow,
      "这是一个浅仓（--is-shallow-repository 不是 false），老提交本来就解析不开，" +
        "此时这条守卫给不出可信答案 —— 按失败处理，不是 sha 烂了",
    ).toBe("false");
  });

  it("(a) 每一处 sha 引用要么解析得开是 commit，要么在已销毁名册上", () => {
    const entries = trackedTexts();
    // 一条也扫不到 ⇒ 判据瞎了。绿了什么都不证明，所以先逼它证明自己认得出东西。
    expect(
      scan(entries).filter((h) => hasHexLetter(h.token)).length,
      "一处 sha 引用都没扫到 —— 判据大概率瞎了，这一格的绿不作数",
    ).toBeGreaterThan(0);

    expect(
      offenders(entries),
      "这些 sha 引用在本仓解析不开，又不在已销毁名册上 —— 读者点过去只会看到 " +
        "Not a valid object name。要么改准，要么连理由一起记进 DESTROYED_OBJECTS",
    ).toEqual([]);
  });

  it("(b) 已销毁名册不许发霉：每条都还被引着，且都确实解析不开", () => {
    const hits = scanRepo();
    const seen = new Set(hits.map((h) => h.token));
    const entries = Object.keys(DESTROYED_OBJECTS);
    expect(
      entries.filter((t) => !seen.has(t)),
      "这些条目已经没有任何 tracked 文件在引用了 —— 名册发霉了，删掉它们",
    ).toEqual([]);

    const types = resolveTypes(entries);
    expect(
      entries.filter((t) => types.get(t) === "commit"),
      "这些条目居然解析得开了 —— 名册上写的「已销毁」是一句假话，理由与事实对不上",
    ).toEqual([]);
  });

  it("(c) 纯十进制的 sha 引用登记表：条目仍是 commit，且没有表外的同族", () => {
    const decimals = [...new Set(scanRepo().map((h) => h.token))].filter((t) => !hasHexLetter(t));
    const types = resolveTypes(decimals);

    expect(
      DECIMAL_SHA_REFS.filter((t) => types.get(t) !== "commit").map(
        (t) => `${t} 现在是 ${types.get(t) ?? "扫不到"}`,
      ),
      "登记表里的 sha 已经不是 commit 了 —— 它腐烂了，而它不含 a–f，形状上没人认得出",
    ).toEqual([]);

    const unregistered = decimals.filter(
      (t) => types.get(t) === "commit" && !DECIMAL_SHA_REFS.includes(t),
    );
    expect(
      unregistered,
      "这些纯十进制 token 在本仓解析得开是 commit，却没登记 —— 它们一旦腐烂就没人认得出，" +
        "要么登记进 DECIMAL_SHA_REFS，要么把引用改写成含字母的缩写",
    ).toEqual([]);
  });

  it("(d) 正向：判据认得出「引用位置上的一个死 sha」", () => {
    // 拼接而不是写成一个连续串：否则这个文件自己就成了一处死 sha 引用，(a) 会红在自己身上。
    const dead = "dead" + "b0b";
    expect(dead, "探针串必须落在判据的长度射程内，否则这一格空跑").toHaveLength(7);
    expect(
      resolveTypes([dead]).get(dead),
      "探针串在本仓居然解析得开，这一格就白跑了 —— 换一个",
    ).not.toBe("commit");

    const probe = [
      "* 这一拍的行为在 `" + dead + "` 那次提交里改过。",
      "git show " + dead + " -- src/core/config.ts",
    ].join("\n");

    expect(
      shaRefsIn(probe).map((r) => r.token),
      "反引号包起来的、以及 git 命令后面跟着的，都必须被认成一处引用",
    ).toEqual([dead, dead]);

    // 走**整条流水线**，不是只走分词器：证明这条守卫真的会红，而且报文点得出文件、行号、
    // token 与它在本仓的状态。
    const bad = offenders([{ file: "<probe>", text: probe }]);
    expect(bad, "整条流水线必须把这两处报成违规").toHaveLength(2);
    expect(bad[0]).toContain("<probe>:1");
    expect(bad[0]).toContain(dead);
    expect(bad[0]).toContain("missing");
    expect(bad[1]).toContain("<probe>:2");
  });

  it("(e) 反向控制：仓里真实存在的非 sha 串，一个都不许被当成引用", () => {
    // 每条夹具都当场回仓里核一次；对不上就吵，绝不空跑。
    const fixtures: { file: string; snippet: string }[] = [
      { file: "tests/contract/admin-usage.test.ts", snippet: "1.157e292" },
      { file: ".env.example", snippet: "COOLDOWN_STRIKE_MS=1800000" },
      // ⚠️ **这一条的值从真源现算，不写死**（P3e 全分支评审回填）：它是一个**生成物**里的
      //    构建哈希，`admin-ui/` 改一个字它就换一个值 —— 写死的那一版每改一次面板源码
      //    就会红一次，而红的报文说的是「夹具串已经不在文件里了」，指的方向与真因无关。
      //    现算之后这一格问的仍是它该问的那件事：**一段真实存在于 tracked 文件里的十六进制
      //    长串，不许被当成 sha 引用**（16 位不在 `REF_LENGTHS` 射程内，下面那条形状断言
      //    连这个前提一起钉住 —— 哈希长度哪天变成 8 或 40，这一格会先吵）。
      { file: "src/ui/assets.generated.ts", snippet: `UI_BUILD_HASH = "${UI_BUILD_HASH}"` },
      { file: "docs/en/DEPLOY.md", snippet: '"id": "1a2b3c4d5e6f7a8b"' },
      { file: "tests/ui/dom/render-text.test.ts", snippet: 'id: "abc12345"' },
      { file: "src/core/registrar/code.ts", snippet: "abc887766 会误命中" },
    ];
    for (const f of fixtures) {
      const text = readFileSync(join(ROOT, f.file), "utf8");
      expect(text, `夹具串已经不在 ${f.file} 里了，这一格会空跑`).toContain(f.snippet);
    }
    // 上面那条现算夹具的**前提**：它得真的是一段十六进制长串，而且长度落在射程之外。
    // 哪天 build-ui 换了哈希写法（长度变成 8 或 40、或者不再是纯十六进制），
    // 这一格先在这里吵，而不是让那条反向控制静静变成一句废话。
    expect(UI_BUILD_HASH, "构建哈希不再是纯十六进制串了").toMatch(/^[0-9a-f]+$/);
    expect(
      REF_LENGTHS.has(UI_BUILD_HASH.length),
      `构建哈希的长度变成了 ${UI_BUILD_HASH.length}，正好落进 sha 引用的射程 —— `
      + "它会被判成一处解析不开的引用，这条反向控制的前提没了",
    ).toBe(false);

    // 活着的提交 sha 从 git 现取，不手抄一个会随历史漂的数。
    const live = git(["rev-parse", "--short", "HEAD"]).trim();
    expect(REF_LENGTHS.has(live.length), `git 给的缩写长度 ${live.length} 不在射程内`).toBe(true);

    const types = resolveTypes([live]);
    expect(types.get(live), "HEAD 的缩写必须解析得开").toBe("commit");

    // 判据是「整条流水线一条都不许报」——这才是「不乱红」的准确含义。
    // 逐条单独跑，红的时候能一眼看出是哪条夹具。
    for (const f of fixtures) {
      expect(
        offenders([{ file: f.file, text: f.snippet }]),
        `${f.file} 里这个串不是 sha 引用，判据不许乱红：${f.snippet}`,
      ).toEqual([]);
    }
    // 一起跑一遍，防「单条各自绿、合在一起却红」。
    expect(offenders(fixtures.map((f) => ({ file: f.file, text: f.snippet })))).toEqual([]);

    // ⚠️ 这六条里，前五条是**分词器压根不收**（长度不对 / 被引号、小数点、连字符粘住），
    // 第六条 `COOLDOWN_STRIKE_MS=1800000` 不同：它**被分词器收进来了**，靠的是后面
    // 「纯十进制按数字处理」那一层才没红。把这两种「不红」分开写清楚，否则这一格会
    // 让人误以为分词器认不出等号后面的东西。
    const decimalFixture = fixtures.find((f) => f.snippet.includes("COOLDOWN_STRIKE_MS"))!;
    expect(
      shaRefsIn(decimalFixture.snippet).map((r) => r.token),
      "等号后面那个数分词器是看得见的 —— 它不红是因为纯十进制那一层，不是因为没扫到",
    ).toEqual(["1800000"]);
    for (const f of fixtures.filter((x) => x !== decimalFixture)) {
      expect(
        shaRefsIn(f.snippet).map((r) => r.token),
        `${f.file} 里这个串连分词器都不该收：${f.snippet}`,
      ).toEqual([]);
    }

    // 而一个真的活 sha 写在引用位置上：认得出，且不算违规。
    const line = "见 `" + live + "` 那次提交。";
    expect(shaRefsIn(line).map((r) => r.token), "活 sha 写在反引号里必须认得出").toEqual([live]);
    expect(offenders([{ file: "<live>", text: line }]), "活 sha 不许被报成违规").toEqual([]);
  });
});
