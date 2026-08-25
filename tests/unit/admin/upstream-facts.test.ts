import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { UPSTREAM_FACTS, type UpstreamFact } from "../../../src/core/admin/upstream-facts.js";

/**
 * ── 上游事实登记表的守卫 ────────────────────────────────────────────────────
 *
 * 这张表要把两类东西分开：**我们验证过的**，与**我们假设的**。本组守的是
 * 「分类没被人偷偷改掉」，**不是**「假设本身对不对」——后者只有一次真上游能定案，
 * 本仓至今**零非自造依据**。
 *
 * ⚠️ **判据一律写成函数，真扫描与探针共用同一份。** 只跑「今天这张表通过」是形状
 * 断言：判据改成恒 `null` 也会绿。而这张表今天**一条 `verified` 都没有**，
 * 那条依据强度判据在真表上是**空转**的 —— 它的牙全在下面那组探针里。
 */

/**
 * 依据强度判据（对应「`verified` 必须有本仓之外的依据」）。返回失败报文或 `null`。
 *
 * `exists` 是注入的端口，探针因此不必往磁盘上摆一份假文档；真扫描传的是真的
 * `existsSync`。
 */
function sourceFailure(fact: UpstreamFact, exists: (p: string) => boolean): string | null {
  if (fact.status !== "verified") return null;
  if (fact.source.startsWith("tests/")) {
    return `${fact.id} 标成 verified，但依据是 ${fact.source} —— 那是本仓自己的夹具，拿它当上游依据是循环取证`;
  }
  if (!/^(https?:\/\/|docs\/)/.test(fact.source)) {
    return `${fact.id} 标成 verified，但依据 ${fact.source} 既不是本仓之外的链接，也不是 docs/ 下的一份文档`;
  }
  if (fact.source.startsWith("docs/")) {
    const path = (fact.source.split("#")[0] ?? "").split(/\s/)[0] ?? "";
    if (!exists(path)) return `${fact.id} 的依据指向 ${path}，而那份文档不存在 —— 一条悬空的依据不是依据`;
  }
  return null;
}

/**
 * 锚判据（对应「真源里必须有同名锚」）。返回失败报文或 `null`。
 *
 * `read` 是注入的端口：文件读不到时返回 `null`。**读不到必须是红的**，
 * 不许当成「这个文件里没有那个锚」——那两句话该把人指去的地方不一样。
 */
function anchorFailure(fact: UpstreamFact, read: (p: string) => string | null): string | null {
  const src = read(fact.anchorFile);
  if (src === null) return `${fact.id} 的锚文件 ${fact.anchorFile} 读不到 —— 文件被删了或路径写错了`;
  if (!src.includes(fact.anchor)) {
    return `${fact.id} 的锚「${fact.anchor}」不在 ${fact.anchorFile} 里 —— 登记表与真源已经对不上了`;
  }
  return null;
}

const realRead = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);

describe("上游事实登记表：表本身", () => {
  it("表非空且 id 唯一 —— 防「表被清空之后整组空转」", () => {
    expect(UPSTREAM_FACTS.length, "登记表空了 —— 本文件与 docs-parity 那一组会一格都不跑").toBeGreaterThanOrEqual(3);
    expect(new Set(UPSTREAM_FACTS.map((f) => f.id)).size, "有两条事实用了同一个 id，报文点名会指错地方")
      .toBe(UPSTREAM_FACTS.length);
    for (const f of UPSTREAM_FACTS) {
      expect(f.subject.trim(), `${f.id} 没写 subject`).not.toBe("");
      expect(f.assumed.trim(), `${f.id} 没写今天假定的答案`).not.toBe("");
      expect(f.source.trim(), `${f.id} 没写依据 —— 「无」也要写出来，空着等于没登记`).not.toBe("");
    }
  });

  /**
   * **这一格是上面那句「今天在真表上是空转」的测法**，不是散文。
   * 哪天真有人拿到真上游依据把某一条升级成 `verified`，它会当场红 —— 那是好事：
   * 逼他回来把本文件顶上那段说明连同这一格一起改掉，别让「空转」这句话变成假话。
   */
  it("今天一条 verified 都没有 —— 依据强度判据在真表上是空转的，牙全在探针那一组", () => {
    expect(
      UPSTREAM_FACTS.filter((f) => f.status === "verified").map((f) => f.id),
      "有事实被升级成 verified 了 —— 回来改本文件顶上那段说明，并确认五份 API.md 里那句「未核实」已经删掉",
    ).toEqual([]);
  });

  it("docHints 五语言齐全、非空，且跨事实互不相同也互不包含", () => {
    // 期望值是**手写字面量**（`tests/unit/docs-parity.test.ts` 里那张 LANGS 是另一份
    // 独立的手写清单，两边互校），不从 docHints 自己数出来再回填。
    const want = ["en", "ja", "ko", "zh-CN", "zh-TW"];
    const all: Array<{ id: string; lang: string; hint: string }> = [];
    for (const f of UPSTREAM_FACTS) {
      expect(Object.keys(f.docHints).sort(), `${f.id} 的 docHints 语言集不是那五种`).toEqual(want);
      for (const [lang, hint] of Object.entries(f.docHints)) {
        expect(hint.trim(), `${f.id} 在 ${lang} 下的限定 token 是空的 —— 空串永远查得到`).not.toBe("");
        all.push({ id: f.id, lang, hint });
      }
    }
    // **互不包含**比「互不相同」严一档，而这一档是必需的：`toContain` 判据下，
    // A 的 token 是 B 的子串时，B 的那句限定就能把 A 的断言喂饱，A 从此空转。
    const collisions = all.flatMap((a) =>
      all
        .filter((b) => b.lang === a.lang && b.id !== a.id && b.hint.includes(a.hint))
        .map((b) => `${a.lang}：${a.id} 的 token 是 ${b.id} 的子串`),
    );
    expect(collisions, "两条事实的限定 token 撞了 —— 一条的限定句会把另一条的断言喂饱").toEqual([]);
  });

  it("每条事实都指名了至少一个 API.md 小节 —— 没有它，限定句贴在哪里都算数", () => {
    for (const f of UPSTREAM_FACTS) {
      expect(f.docSections.length, `${f.id} 的 docSections 是空的`).toBeGreaterThan(0);
    }
  });
});

describe("上游事实登记表：依据强度判据", () => {
  it("真表逐条过判据", () => {
    const failures = UPSTREAM_FACTS.map((f) => sourceFailure(f, existsSync)).filter((m) => m !== null);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /**
   * 探针一律从**真实那条事实**派生（`{ ...fact, ... }`），不另造一个仓里不存在的世界。
   * **挑的是「依据逐字写着本仓夹具」的那一条**，不写死 id：写死 id 的话，那一条哪天
   * 被升级或改名，这几格会红在「探针挑错了人」上，而不是红在被测的那件事上。
   */
  const REAL = UPSTREAM_FACTS.find((f) => f.source.startsWith("tests/"));

  it("非空锚：表上确实还有一条「依据是本仓夹具」的事实，下面几格探针才不是空转", () => {
    expect(REAL, "表上一条「依据是本仓夹具」的事实都没有了 —— 下面几格探针测的是一个不存在的世界")
      .toBeDefined();
  });

  it("该红时红：只把 status 翻成 verified，依据仍是本仓夹具", () => {
    const m = sourceFailure({ ...REAL!, status: "verified" }, existsSync);
    expect(m, "拿本仓夹具当上游依据居然放行了").not.toBeNull();
    expect(m ?? "").toContain("循环取证");
    expect(m ?? "", "报文没点名是哪一条事实").toContain(REAL!.id);
  });

  it("该红时红：依据既不是外部链接也不是 docs/ 下的文档", () => {
    const m = sourceFailure({ ...REAL!, status: "verified", source: "我记得是这样的" }, existsSync);
    expect(m ?? "", "一句「我记得」被当成了上游依据").toContain("既不是本仓之外的链接");
  });

  it("该红时红：依据指向 docs/ 下一份并不存在的文档", () => {
    const m = sourceFailure({ ...REAL!, status: "verified", source: "docs/zh-CN/UPSTREAM.md" }, existsSync);
    expect(m ?? "", "悬空的依据被当成了依据").toContain("而那份文档不存在");
  });

  it("不乱红：真外部链接、以及 docs/ 下真实存在的一份文档，都不许被判成循环取证", () => {
    expect(sourceFailure({ ...REAL!, status: "verified", source: "https://example.invalid/agnes/videos" }, existsSync))
      .toBeNull();
    // 反向控制用的路径取仓里**真实存在**的那一份，不编一个。
    expect(existsSync("docs/zh-CN/API.md"), "反向控制用的文档不存在 —— 这一格什么都没证明").toBe(true);
    expect(sourceFailure({ ...REAL!, status: "verified", source: "docs/zh-CN/API.md" }, existsSync)).toBeNull();
  });

  it("不乱红：assumed 的那些，依据写成本仓夹具正是它该有的样子", () => {
    expect(sourceFailure({ ...REAL!, status: "assumed" }, existsSync)).toBeNull();
  });
});

describe("上游事实登记表：真源锚判据", () => {
  it("真表逐条的锚都在它说的那个文件里", () => {
    const failures = UPSTREAM_FACTS.map((f) => anchorFailure(f, realRead)).filter((m) => m !== null);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  const REAL = UPSTREAM_FACTS.find((f) => f.source.startsWith("tests/"))!;

  it("该红时红：真源里那个名字被删掉或改名", () => {
    const scrub = (p: string) => (realRead(p) ?? "").split(REAL.anchor).join("VIDEO_TASK_SLOT_TABLE");
    // 先自证变异落地了：改名之后那个名字真的不在文件里了。
    expect(scrub(REAL.anchorFile).includes(REAL.anchor), "变异没落地 —— 这一格控制是空的").toBe(false);
    const m = anchorFailure(REAL, scrub);
    expect(m ?? "", "锚名没了却照样放行").toContain("已经对不上了");
    expect(m ?? "").toContain(REAL.anchorFile);
  });

  it("该红时红：锚文件读不到时会吵，报文说的是「读不到」而不是「没有那个锚」", () => {
    const m = anchorFailure(REAL, () => null);
    expect(m ?? "").toContain("读不到");
  });

  it("不乱红：真源原样读回来时一条都不红", () => {
    expect(anchorFailure(REAL, realRead)).toBeNull();
  });
});
