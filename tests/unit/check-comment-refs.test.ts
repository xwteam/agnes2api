import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const SCRIPT = resolve("scripts/check-comment-refs.mjs");

/**
 * **第 12 道门禁（`scripts/check-comment-refs.mjs`）自己的元测试**（全分支评审 B2）。
 *
 * @refs-ignore-file —— **整份文件豁免，理由是构造性的**：下面每个夹具字符串里都装着
 * 一条**故意断掉**的指向（那正是要喂给门禁的输入），而门禁的注释扫描器不解析字符串
 * 字面量，会把它们当成真注释。逐块打标记要打十几处，还会让夹具没法读。
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

describe("scripts/check-comment-refs.mjs 元测试：规则 B（带断言性措辞就必须给得出指向）", () => {
  it.each(["钉住", "钉着", "钉死", "守着", "会变红"])(
    "写了「%s」却只给裸文件名：exit 1",
    (marker) => {
      const r = run({
        files: {
          "tests/x.test.ts": TARGET,
          "src/a.ts": `/** 这条由 \`tests/x.test.ts\` ${marker}。 */\nexport const a = 1;\n`,
        },
      });
      expect(r.status, `「${marker}」没有触发规则 B`).toBe(1);
      expect(r.stderr).toContain("只给了裸文件名");
    },
  );

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
   * **注释扫描器是粗的，边界同样钉住**：它不解析字符串字面量，所以一个含
   * `/*` 的字符串会被误当成注释开头。今天仓里没有这种写法；哪天有了，
   * 这一格会先变红，提醒去调判据而不是去改注释。
   */
  it("边界：字符串字面量里的块注释记号会被误当成注释（已知、如实登记）", () => {
    const r = run({
      // 一个**字符串字面量**，里面同时有块注释的开头与结尾，以及一条断掉的指向。
      // 扫描器不解析字符串字面量，于是把它整段当注释读 ⇒ 误报。
      files: { "src/a.ts": 'export const a = "/* 见 tests/nope.test.ts */";\n' },
    });
    expect(
      r.status,
      "扫描器被升级成会解析字符串字面量了？那就回去改它 commentBlocks() 那段边界说明",
    ).toBe(1);
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
      // 门禁脚本自己：文件头、逐块豁免的说明、整份豁免的说明——三段都要举
      // 不存在的示例路径，那正是它们在讲的事。
      "scripts/check-comment-refs.mjs",
      "scripts/check-comment-refs.mjs",
      "scripts/check-comment-refs.mjs",
      // 第 11 道门禁的两段说明里同样举了 `src/x.ts` / `src/hidden.ts` 两个虚构路径。
      "scripts/check-no-binary.mjs",
      "scripts/check-no-binary.mjs",
      // 事件环：全分支评审 A9 的标本，那条**错误的**旧指向刻意原样留着当反面教材。
      "src/core/admin/event-ring.ts",
      // 掩码：要点名 B3 删掉的那个前端副本。
      "src/core/admin/key-view.ts",
      // 收集门禁：讲第一版 `tests/unit/test-collection.test.ts` 的教训；
      // 以及过滤器判定那一段里的示例文件名。
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
