import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const SCRIPT = resolve("scripts/check-comment-refs.mjs");

/**
 * **第 12 道门禁（`scripts/check-comment-refs.mjs`）自己的元测试**（全分支评审 B2）。
 *
 * @refs-ignore-file —— **整份文件豁免，理由是构造性的**：这份元测试的**真注释**里
 * 到处点名故意不存在的路径（手写豁免清单要逐条解释每个虚构路径的来历、每组夹具的
 * 说明要把它喂进去的那条断链引出来）。逐段打标记要打十几处，还会让说明没法读。
 *
 * ⚠️ **这条理由在 P3c Task 1 被改写过，旧的那条是假的**：原文写的是「夹具**字符串**
 * 会被扫描器当成真注释」，依据是「扫描器不解析字符串字面量」——那句话现在不成立了
 * （I1 之后它逐字符扫、跳过字符串）。实测把这行标记停掉，夹具字符串一条都不再泄漏，
 * 剩下的全是这份文件自己的真注释。**豁免仍然需要，但需要它的理由换了一个。**
 *
 * 它守的那件事：本仓台账已记二十余次「注释里写下一句假断言」，全分支评审这一轮又新
 * 查实 12 条，**发生率没有下降**。其中三条同一成因——注释在写下那一刻是真的，
 * 后来被同一期自己的新代码推翻，没人回头改。
 *
 * ⚠️ **这份元测试与 `tests/unit/check-i18n.test.ts` 的「空仓库（没有任何跟踪文件）：通过」
 * 是同一套做法**，理由也一样：门禁不测自己等于没有门禁。
 *
 * ── 我对评审给的机制做了一处**加强**，理由写在这里 ─────────────────────────
 * 评审的原话是「必须写成指向具体 `file:line`」。实测全仓有 **58 处** source→test
 * 引用，逐一改成行号有两个代价：① 一次性 54 处机械改动；② **行号本身会漂**——
 * 被指向的文件在那一行之上插入几行，指向就悄悄指到别处，而它**可能恰好落在另一条
 * `expect(` 上而静默通过**，等于把一种假断言换成另一种。
 *
 * 所以这道门禁同时接受**名字锚**（`X.test.ts` 的「用例名」，允许 `……` 省略）：
 * 它不随行号漂移，而且比行号**更精确**——行号只能证明"那里有一条用例"，名字锚
 * 能证明"那条用例就是这一条"。行号形态照旧收下（评审要的那个形态没有被拒绝），
 * 只是不再是唯一形态。**两种形态都验不了"这条断言真的守着注释说的那件事"**，
 * 那一层仍然只能靠评审——这条边界下面有一格专门钉住。
 */

interface Fixture {
  /** 相对根目录的路径 -> 文件内容。 */
  files: Record<string, string>;
}

function run(fx: Fixture): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-refs-"));
  try {
    for (const [rel, body] of Object.entries(fx.files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
    const r = spawnSync("node", [SCRIPT, dir], { encoding: "utf8" });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 一份最小但真实的被指向测试文件。 */
const TARGET = `import { describe, it, expect } from "vitest";
describe("一组", () => {
  it("被指向的那一格", () => {
    expect(1).toBe(1);
  });
});
`;

describe("scripts/check-comment-refs.mjs 元测试：规则 A（指向必须解析得开）", () => {
  /** **反向自检，必须在最前**：少了它，"一律 exit 1"也能让下面每格全绿。 */
  it("干净的树：exit 0", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 见 `tests/x.test.ts` 的「被指向的那一格」。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("全部解析得开");
  });

  it("指向一个不存在的文件：exit 1，且报出那个路径", () => {
    const r = run({
      files: { "src/a.ts": "/** 见 `tests/nope.test.ts`。 */\nexport const a = 1;\n" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("tests/nope.test.ts");
    expect(r.stderr).toContain("不存在");
  });

  it("行号超出文件行数：exit 1，且报出真实行数", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 见 `tests/x.test.ts:9999`。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/而那个文件只有 \d+ 行/);
  });

  /**
   * **行号在范围内、但那一带根本没有用例声明**——这正是"行号漂了"的形态。
   * 目标文件前面塞满纯注释行，把 `it(` 推到窗口之外。
   */
  it("行号落在没有任何用例声明的地方：exit 1", () => {
    const pad = "// 占位\n".repeat(40);
    const r = run({
      files: {
        "tests/x.test.ts": pad + TARGET,
        "src/a.ts": "/** 见 `tests/x.test.ts:3`。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("没有任何用例声明");
  });

  it("非测试文件的行号只查范围，不要求那里有用例声明", () => {
    const r = run({
      files: {
        "src/b.ts": "export const b = 1;\n",
        "src/a.ts": "/** 见 `src/b.ts:1`。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("名字锚对不上：exit 1", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 见 `tests/x.test.ts` 的「一条根本不存在的用例」。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("那段文字不在那个文件里");
  });

  it("名字锚允许 `……` 省略（本仓已有的写法，长用例名照抄不下来）", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 见 `tests/x.test.ts` 的「被指向……那一格」。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * **跨行折断的名字锚必须照样匹配。** 这一格是量具自检：本仓的长用例名在注释里
   * 必然被折行，中间夹着 `\n * `，而源文件里那一处没有空格。判据不抠空白的话，
   * **每一个跨行写的锚都会假红**——那时红的不是缺陷，是量具。
   */
  it("跨行折断的名字锚照样匹配（判据抠掉空白）", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/**\n * 见 `tests/x.test.ts` 的「被指向的\n * 那一格」。\n */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("相对 import 路径（`./pure/x.mjs`）不被当成仓内引用——那是 import，不是指向", () => {
    const r = run({
      files: { "src/a.ts": '// 判定在 `./pure/x.mjs` 里。\nexport const a = 1;\n' },
    });
    expect(r.status, r.stderr).toBe(0);
  });
});

/**
 * **规则 B 的词表边界，两张表，都是会变红的断言。**
 *
 * 照抄 `tests/unit/source-guards.test.ts` 的「声称覆盖的写法真的抓得住」
 * 与「已知抓不住的写法确实抓不住」两张表的形状，
 * 理由也一样：**任何基于关键词的门禁都不可能完备**，与其在脚本注释里反复宣称
 * 覆盖范围，不如把「认得哪些、认不得哪些」一起变成断言。
 * **一道以「不许写成散文」为全部理由的门禁，自己更不能把边界写成散文。**
 *
 * ⚠️ 期望值一律手写字面量，不从 `CLAIM_MARKERS` 反算——回填出来的期望值恒等于
 * 实际值，那条断言永远绿（本仓登记的第 6 种假阳性）。
 */
const COVERED: ReadonlyArray<{ claim: string; why: string }> = [
  { claim: "这条由 `tests/x.test.ts` 钉住。", why: "钉住" },
  { claim: "这条由 `tests/x.test.ts` 钉着。", why: "钉着" },
  { claim: "这条由 `tests/x.test.ts` 钉死。", why: "钉死" },
  { claim: "这条由 `tests/x.test.ts` 守着。", why: "守着" },
  { claim: "改坏了 `tests/x.test.ts` 会变红。", why: "会变红" },
  { claim: "改坏了 `tests/x.test.ts` 就变红。", why: "变红" },
  // ── 本任务新增的五个（V22：原来这五种说法门禁一个都看不见）──
  { claim: "这条由 `tests/x.test.ts` 保证。", why: "由 X 保证" },
  { claim: "这条已核实，见 `tests/x.test.ts`。", why: "已核实" },
  { claim: "已实测：`tests/x.test.ts` 会拦下这个变异。", why: "已实测" },
  { claim: "这个变异 `tests/x.test.ts` 拦得住。", why: "拦得住" },
  { claim: "这个变异 `tests/x.test.ts` 抓得住。", why: "抓得住" },
  // ── 第三轮补的三个：每一个当时都是**正在漏**的活口子，不是预防性扩容 ──
  { claim: "四条不变量各自的守护者见 `tests/x.test.ts`。", why: "守护（原来只认「守着」）" },
  { claim: "`tests/x.test.ts` 正钉这件事。", why: "正钉 —— 由新加的 `钉` 单字接住" },
  { claim: "把两条判断对调，只有 `tests/x.test.ts` 那一格会红。", why: "会红（原来只认「会变红」）" },
];

/**
 * **已知认不得的措辞。** 判据是子串匹配、不是语义判断，所以**换个说法就能绕过去**。
 * 这不是"还没做完"，是这道门禁的**能力边界**：它给「顺手写下一句断言」加一道摩擦，
 * 不给「刻意绕开」设一道墙。哪天某一条被覆盖了，这一格会变红，逼人把它从这里删掉
 * 并挪进 `COVERED`——那是设计，不是故障。
 */
const BLIND_SPOTS: ReadonlyArray<{ claim: string; why: string }> = [
  { claim: "这条逻辑很安全，见 `tests/x.test.ts`。", why: "「很安全」不含任何关键词" },
  { claim: "改坏了 `tests/x.test.ts` 会失败。", why: "「会失败」是「会变红」的同义说法，词表里没有" },
  { claim: "`tests/x.test.ts` 覆盖了这条。", why: "「覆盖」是本仓极常用的断言词，刻意没收进去——它同时也大量出现在纯描述句里" },
  { claim: "这条不会出问题，`tests/x.test.ts` 试过。", why: "「试过」「不会出问题」都不在词表里" },
];

describe("scripts/check-comment-refs.mjs 元测试：规则 B（带断言性措辞就必须给得出指向）", () => {
  it.each(COVERED)("声称认得的措辞真的触发规则 B：$why", ({ claim, why }) => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": `/** ${claim} */\nexport const a = 1;\n`,
      },
    });
    expect(r.status, `「${why}」没有触发规则 B`).toBe(1);
    expect(r.stderr).toContain("只给了裸文件名");
  });

  it.each(BLIND_SPOTS)("已知认不得的措辞确实不触发规则 B：$why", ({ claim }) => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": `/** ${claim} */\nexport const a = 1;\n`,
      },
    });
    expect(
      r.status,
      "这条措辞现在被认出来了？把它从 BLIND_SPOTS 挪进 COVERED，"
      + "并去掉 `scripts/check-comment-refs.mjs` 里 CLAIM_MARKERS 那段对应的边界说明",
    ).toBe(0);
  });

  /**
   * **断言性指向的名字锚必须落在某一条用例的标题里，不能只是"在那个文件里出现过"。**
   *
   * ⚠️ **这一格是评审 I7 逼出来的，成因如实登记**：判据原来是「整份文件压平后子串
   * 匹配」，而本仓的写法恰恰爱在用例上方的说明里把用例名再复述一遍
   * ——于是**把被指向的那条 `it()` 整个改名，门禁照样绿**。实测四处（两处是本任务
   * 自己新写的锚，两处是存量：`dispatcher.ts` 指的其实是一句 `expect` 失败提示语，
   * `sec-events.js` 指的那个标题在目标文件里**根本不存在**）。
   * **满足了语法、消掉了红，一条腐烂都检测不出——形状断言冒充行为断言。**
   */
  it("断言性指向：锚只出现在目标文件的注释里、不是任何一条用例的标题 ⇒ exit 1", () => {
    const r = run({
      files: {
        // 目标文件里那段文字**只在注释里**出现，没有任何一条用例叫这个名字。
        "tests/x.test.ts": `import { describe, it, expect } from "vitest";\n`
          + `// 这里提一句「一条只存在于注释里的名字」。\n`
          + `describe("一组", () => {\n  it("真正的用例名", () => {\n    expect(1).toBe(1);\n  });\n});\n`,
        "src/a.ts": "/** 这条由 `tests/x.test.ts` 的「一条只存在于注释里的名字」钉住。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, "锚落在目标文件的注释里就算数 ⇒ 目标用例改名/删掉都不会红").toBe(1);
    expect(r.stderr).toContain("那段文字不在那个文件里");
  });

  it("断言性指向：锚落在真实用例标题里 ⇒ 放行", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 这条由 `tests/x.test.ts` 的「被指向的那一格」钉住。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * **只对断言性的那一类收紧，是刻意的。** 本仓也有大量**描述性**指向
   *（「观测形态照抄 X 的 `fakeCtx()`」这种），它们指的是一段代码或一段说明，
   * 不是一条用例——要求它们指向用例标题是把判据用错了地方。
   * 分界线用的就是规则 B 自己那条。
   */
  it("描述性指向（同段没有断言性措辞）：锚指向用例标题之外的代码，照样放行", () => {
    const r = run({
      files: {
        "tests/x.test.ts": `function fakeCtx() { return 1; }\n` + TARGET,
        "src/a.ts": "/** 形态照抄 `tests/x.test.ts` 的「function fakeCtx()」。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("同样的裸文件名，注释里**没有**断言性措辞时不报错（规则 B 不是「提到测试就要给行号」）", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 相关背景见 `tests/x.test.ts`。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("带了行号就放行", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 这条由 `tests/x.test.ts:3` 钉住。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("带了名字锚也放行（本轮加强的那一半）", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 这条由 `tests/x.test.ts` 的「被指向的那一格」钉住。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * **连续的 `//` 行要被当成同一段。** 断言性措辞与文件名常常分处两行
   *（本仓真实写法），一行一段的话规则 B 有一半看不见。
   */
  it("断言性措辞与文件名分处相邻两行时，规则 B 仍然看得见", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "// 这条由 `tests/x.test.ts`\n// 钉住。\nexport const a = 1;\n",
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("只给了裸文件名");
  });
});

describe("scripts/check-comment-refs.mjs 元测试：豁免标记与它的边界", () => {
  it("@refs-ignore 让整段注释免检，并被计数报出来", () => {
    const r = run({
      files: {
        "src/a.ts": "/**\n * @refs-ignore（这是个示例路径）\n * 见 `tests/nope.test.ts` 钉住。\n */\nexport const a = 1;\n",
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout, "豁免必须被数出来，否则它就是一个看不见的逃生口").toContain("1 段注释用了 @refs-ignore");
  });

  /**
   * **它验的是「指向」，不是「内容」——这条边界必须是一条会变红的断言，
   * 不能只写在脚本注释里**（本仓已经栽过二十余次"注释里写下一句假断言"）。
   * 一个指向 `expect(1).toBe(1)` 的行号照样过关：这道门禁没有、也做不到
   * "这条断言真的守着注释说的那件事"这一层。
   */
  it("边界：指向一条与注释毫无关系的用例，照样过关（这道门禁不管内容）", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 「太阳从西边升起」这条由 `tests/x.test.ts:3` 钉住。 */\nexport const a = 1;\n",
      },
    });
    expect(
      r.status,
      "这道门禁被加强到能判断注释内容了？那就回去改脚本文件头那段「它做不到什么」",
    ).toBe(0);
  });

  /**
   * **字符串字面量里的注释记号不许影响扫描。**
   *
   * ⚠️ **这一格原来的断言方向是反的，如实登记**：它原本写着「字符串里的块注释
   * 记号会被**误当成**注释（已知、如实登记）」并断言 `exit 1`。那描述只说对了
   * 一半——真正的后果不是"多校验一段"（误报），而是**块注释一旦开了就再也没闭合，
   * 从那一行到文件尾全部脱离校验，而门禁照常报绿**（漏报）。
   * **元测试当时只钉了误报方向，漏报方向一条断言都没有**，于是全仓 4 处、
   * 合计 136 行长期不在校验范围内，没有任何信号。
   */
  it("字符串字面量里的块注释记号不再被当成注释开头", () => {
    const r = run({
      files: { "src/a.ts": 'export const a = "/* 见 tests/nope.test.ts */";\n' },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * **漏报方向：这一格才是那个洞本身。**
   *
   * 变红条件：`commentBlocks()` 退回"不解析字符串字面量"的写法 ⇒ `"/admin/*"`
   * 里那个 `/*` 开出一个永不闭合的块 ⇒ 下面那条坏指向被吞掉 ⇒ `exit 0`。
   * 仓里的真实原型：`src/http/admin/router.ts` 那行
   * 「新增任何 /admin/api/* 端点都必须加在这一行之前」——**一句注释里写了那个
   * 通配符，就把它下面整张路由表从门禁眼前抹掉了**。
   */
  it("通配符路由字符串之后的坏指向仍然被抓住（漏报方向）", () => {
    const r = run({
      files: {
        "src/a.ts": 'app.get("/admin/*", handler);\n// 见 `tests/nope.test.ts`。\n',
      },
    });
    expect(r.status, "字符串里的 /* 把后面的内容整个吞掉了 —— 门禁在报绿的同时没有在看").toBe(1);
    expect(r.stderr).toContain("tests/nope.test.ts");
  });

  it("同一条坏指向，放在通配符那一行之前/之后，结论必须一致", () => {
    const before = run({
      files: { "src/a.ts": '// 见 `tests/nope.test.ts`。\napp.get("/admin/*", handler);\n' },
    });
    const after = run({
      files: { "src/a.ts": 'app.get("/admin/*", handler);\n// 见 `tests/nope.test.ts`。\n' },
    });
    expect(after.status, "位置不该改变结论 —— 改变了就说明扫描器把后半截吞了").toBe(before.status);
  });

  /**
   * **真正未闭合的块注释必须报错，不能静默丢弃。**
   * 凡是"解析失败就当没看见"的门禁，失效时都长得和通过一模一样。
   */
  it("块注释一直到文件尾都没闭合：exit 1 并指出是哪一行开的头", () => {
    const r = run({ files: { "src/a.ts": "export const a = 1;\n/* 开了没关\n * 见 tests/nope.test.ts\n" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("没闭合");
    expect(r.stderr, "要指出是哪一行开的头").toContain("src/a.ts:2");
  });

  /**
   * **正则字面量里的引号不许把后面的内容吞掉。**
   * ⚠️ 这一格是修 I1 时**踩出来的**：第一版的修法带了跨行的模板字面量状态，
   * 于是门禁自己文件里那个 `` /`/g `` 正则中的反引号被当成模板开头，
   * 一路吞掉下面 20 行——**修一个失明修出另一个失明**。
   * 现在字符串状态只在一行之内有效，行尾一律清零。
   */
  it("正则字面量里的反引号不会把后面若干行吞掉", () => {
    const r = run({
      files: {
        "src/a.ts": 'export const f = (s) => s.replace(/`/g, "");\n// 见 `tests/nope.test.ts`。\n',
      },
    });
    expect(r.status, "反引号开了一个跨行的假字符串，把后面的注释吞了").toBe(1);
    expect(r.stderr).toContain("tests/nope.test.ts");
  });
  /**
   * **同一行里，未闭合的引号之后的注释也必须被看见。**
   *
   * ⚠️ **这一整组是第三轮补的，成因如实登记**：上面那几格把坏指向放在**下一行**，
   * 于是只证明了"跨行传染治好了"。**同一行的残留没有任何断言**——把同一条坏指向
   * 挪到**同一行**，`EXIT` 当场从 1 翻成 0。当时那段自述写的是「代价是**误报**
   * 不是漏报」，**那句话是假的**：`if (end === -1) break` 丢的是这一行剩下的
   * 全部内容，**包括后面的整条注释**，而门禁照常打印 ✅。
   *
   * 变红条件：把那个 `continue` 改回 `break`。
   */
  it.each([
    ["字符类正则里的引号", "const RE = /['\"]/;  // 见 `tests/nope.test.ts`。\n"],
    ["正则里的撇号", "const RE = /don't/; // 见 `tests/nope.test.ts`。\n"],
    ["单个未闭合的双引号", "const s = \"开头没结尾; // 见 `tests/nope.test.ts`。\n"],
  ])("同一行里 %s 之后的坏指向仍然被抓住（漏报方向）", (_why, line) => {
    const r = run({ files: { "src/a.ts": line } });
    expect(r.status, "未闭合的引号把同一行剩下的内容整个吞掉了").toBe(1);
    expect(r.stderr).toContain("tests/nope.test.ts");
  });

  it("同一行未闭合引号之后，规则 B 也照样看得见（不是只有规则 A）", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "const RE = /['\"]/;  // 这条由 `tests/x.test.ts` 钉住。\n",
      },
    });
    expect(r.status, "规则 B 跟着一起瞎了").toBe(1);
    expect(r.stderr).toContain("只给了裸文件名");
  });

  /**
   * **同一块注释里的第二个及以后的锚，也必须逐个校验。**
   *
   * ⚠️ **这是第三轮抓到的另一条静默漏报**：`nameAnchorAfter` 每个「注释块 × 目标
   * 文件」**只取第一个锚**，同块里第二个从不校验。于是**同一段话，锚的先后决定
   * 查不查**——实测本仓当时有 2 条带断言性措辞的活逃逸
   *（`src/core/dispatcher.ts` 与 `tests/contract/admin-auth.test.ts` 各一条）。
   *
   * 变红条件：`nameAnchorsAfter` 退回只返回第一个。
   */
  it("同一块里第一个锚真、第二个锚编造：仍然 exit 1", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 见 `tests/x.test.ts` 的「被指向的那一格」，"
          + "另见 `tests/x.test.ts` 的「完全编造的名字」。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, "同块第二个锚从不校验 —— 锚的先后决定查不查").toBe(1);
    expect(r.stderr).toContain("完全编造的名字");
  });

  it("顺序对调（编造在前、真的在后）结论必须一致", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": "/** 见 `tests/x.test.ts` 的「完全编造的名字」，"
          + "另见 `tests/x.test.ts` 的「被指向的那一格」。 */\nexport const a = 1;\n",
      },
    });
    expect(r.status, "位置不该改变结论").toBe(1);
  });


  /**
   * **门禁不许把自己整份豁免掉。** 已实测踩过一次：`IGNORE_FILE_RE` 那一行原来把
   * 标记名写成完整字面量，而判据认「`*` 紧挨着标记名」，于是那一行自己命中判据，
   * 整个 `scripts/check-comment-refs.mjs` 免检、门禁照报绿。
   */
  it("门禁自己不在整份豁免的名单里（自我豁免的门禁比没有门禁更糟）", () => {
    const r = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, COMMENT_REFS_LIST_IGNORED: "1" },
    });
    // `:0` 是整份文件豁免的标记（逐块豁免带的是真实行号）。
    expect(r.stdout).not.toContain("ignored scripts/check-comment-refs.mjs:0");
  });
});

/**
 * **豁免用在哪几处，钉成手写清单。**
 *
 * `@refs-ignore` 是个逃生口。逃生口不被看住就会被顺手用掉——本仓对"手写清单"
 * 这件事已经有成例（`source-guards.test.ts` 的豁免名册）。加一处豁免就得改这里，
 * 于是它一定会出现在评审的 diff 里。
 */
describe("本仓 @refs-ignore 的使用处，逐条列名", () => {
  it("豁免清单与手写的这份一致", () => {
    const r = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, COMMENT_REFS_LIST_IGNORED: "1" },
    });
    expect(r.status, r.stderr).toBe(0);
    const used = (r.stdout.match(/ignored (\S+)/g) ?? [])
      .map((s) => s.replace("ignored ", "").replace(/:\d+$/, ""))
      .sort();
    expect(used, "有人加了新的 @refs-ignore 豁免——请在这里表态说明理由").toEqual([
      // 门禁脚本自己：文件头的标本段、逐段豁免的说明——两段都要举不存在的示例路径，
      // 那正是它们在讲的事。
      // ⚠️ **这里从 3 条减到 2 条，是修 I1（扫描器不解析字符串字面量）的直接后果**：
      // 第三条根本不是一段注释，是 `IGNORE_FILE_RE` 那行**正则字符串里**的
      // `//` 被旧扫描器误当成行注释、而那个字符串里恰好又有豁免标记。
      // 扫描器改成逐字符扫、跳过字符串之后，那个假注释消失了。
      "scripts/check-comment-refs.mjs",
      "scripts/check-comment-refs.mjs",
      // ⚠️ **第三条是 P3c Task 7 加的（`KNOWN_MARKER_GAPS` 上面那段）。**
      // 那段登记的是词表自己的一个已知漏法（肯定式在表内、否定式全在表外），
      // 内容有两种规则 B 天生会误报的形态：**扫描结果里的路径清单**（是数据，
      // 不是指向声明）与**被引用的词表成员**（`拦得住`/`抓得住` 是词，不是断言）。
      // 段落刻意不拆开，就是为了让豁免区间盖住整段。
      "scripts/check-comment-refs.mjs",
      // 第 11 道门禁的两段说明里同样举了 `src/x.ts` / `src/hidden.ts` 两个虚构路径。
      "scripts/check-no-binary.mjs",
      "scripts/check-no-binary.mjs",
      // 事件环：全分支评审 A9 的标本，那条**错误的**旧指向刻意原样留着当反面教材。
      "src/core/admin/event-ring.ts",
      // 掩码：要点名 B3 删掉的那个前端副本。
      "src/core/admin/key-view.ts",
      // 收集门禁：讲第一版 `tests/unit/test-collection.test.ts` 的教训；
      // 以及过滤器判定那一段里的两处示例文件名。
      // ⚠️ **这里从 2 条变成 3 条是本任务把豁免收窄到「段级」的直接后果**：
      // 过滤器判定那一块注释里，两个虚构路径分处**两段**，段级豁免下各要一个标记
      // （块级时一个标记盖住整块）。这正是这份手写清单存在的意义——范围变了，
      // 清单就得跟着改，改动会出现在评审的 diff 里。
      "tests/global-setup.ts",
      "tests/global-setup.ts",
      "tests/global-setup.ts",
      // 同样要点名 B3 删掉的两个前端文件。
      "tests/unit/admin/key-view.test.ts",
      "tests/unit/admin/key-view.test.ts",
      // 本文件：**整份**豁免，理由见文件头（夹具按构造就是断链的）。
      "tests/unit/check-comment-refs.test.ts",
      // 举例说明「带了过滤器」长什么样。
      "tests/unit/scripts-guard.test.ts",
    ]);
  });
});

/**
 * **逐段豁免（本任务把它从逐块收窄到逐段）。**
 *
 * 防住的真实故障：「把旧的**错**指向留作标本」和「刚更正的**活**指向」**天然写在
 * 同一块注释里**——`src/core/admin/event-ring.ts` 与门禁脚本自己的文件头都是这个
 * 形态。块级豁免把两者一起放行，于是那 13 段豁免块里藏着 19 条今天仍然解析得开的
 * 活指向，全都不在校验范围内；`src/core/admin/key-view.ts` 那条已经腐烂了 2 行，
 * 而门禁一声都没吭。
 */
describe("scripts/check-comment-refs.mjs 元测试：豁免是「段级」的，不是「块级」", () => {
  /** 一块注释，两段：第一段带标记（里面的坏指向该放行），第二段不带（该照常校验）。 */
  const TWO_PARAGRAPHS = `/**
 * @refs-ignore（本段刻意举一条不存在的指向当标本）
 * 见 \`tests/gone.test.ts\`。
 *
 * 而这一段里的 \`tests/also-gone.test.ts\` 是活指向，必须照常校验。
 */
export const a = 1;
`;

  it("① 同一块注释里，豁免段**之外**的坏指向仍然 exit 1", () => {
    // 变红条件：把逐段豁免还原成块级（`if (block.text.includes(MARKER)) continue`）
    const r = run({ files: { "src/a.ts": TWO_PARAGRAPHS } });
    expect(r.status, r.stdout).toBe(1);
    expect(r.stderr, "被报出来的必须是豁免段之外那一条").toContain("tests/also-gone.test.ts");
    expect(r.stderr, "豁免段之内那一条不许被报出来").not.toContain("tests/gone.test.ts");
  });

  it("② 豁免段**之内**的坏指向仍然放行（收窄不等于把逃生口堵死）", () => {
    // 变红条件：把豁免整个删掉 ⇒ `tests/gone.test.ts` 也会被报出来
    const r = run({
      files: {
        "src/a.ts": `/**
 * @refs-ignore（本段刻意举一条不存在的指向当标本）
 * 见 \`tests/gone.test.ts\`。
 */
export const a = 1;
`,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("1 段注释用了 @refs-ignore");
  });

  /**
   * **段的边界是「空注释行」，这一条要能被读者预测。**
   * 标记单独成段（后面紧跟一个空注释行）时，它**只**豁免自己那一行——
   * 想豁免哪几句就得跟那几句写在一起。这不是实现细节，是使用者每次都要做的决定。
   */
  it("标记单独成段时只豁免它自己那一行，下一段照常校验", () => {
    const r = run({
      files: {
        "src/a.ts": `/**
 * @refs-ignore（标记自己单独一段）
 *
 * 见 \`tests/gone.test.ts\`。
 */
export const a = 1;
`,
      },
    });
    expect(r.status, "标记与它要豁免的话之间隔了一个空注释行，那一句不该被豁免").toBe(1);
    expect(r.stderr).toContain("tests/gone.test.ts");
  });

  it("规则 B 同样按段走：豁免段里的裸文件名 + 断言性措辞不再触发", () => {
    const r = run({
      files: {
        "tests/x.test.ts": TARGET,
        "src/a.ts": `/**
 * @refs-ignore（本段刻意用裸文件名当标本）
 * 这条由 \`tests/x.test.ts\` 钉住。
 */
export const a = 1;
`,
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
