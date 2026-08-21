import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * **核心设计决定的机器护栏**：前端一个网关端点路径都不许硬编码，全部来自
 * `GET /admin/api/models`（真源 `src/core/admin/protocol-catalog.ts`）。
 *
 * ⚠️ **三种引号都要扫。** 本计划第一版用的是 `grep -rn "'/v1"`——只认单引号，
 * 而本仓 admin-ui 里双引号 4054 处、单引号 5 处 ⇒ 那条检查恒输出 0 行、恒「通过」。
 * 这与 `scripts/check-i18n.mjs:145-149` 记着的那次翻车是同一个错的镜像。
 *
 * ⚠️ **不许排除 `js/pure/`。** 那里正是唯二拼 URL 的两个模块所在地
 *（本期 Task 7 的 `examples.mjs` 与 Task 10 的 `playground.mjs`）。
 *
 * 形态照抄 `tests/ui/storage-keys.test.ts:52` 那一格——它扫的就是 `["'\`]` 三种引号，
 * 已经证明这种扫描在本仓能落地。
 *
 * ── **它抓得住什么、抓不住什么：边界写成两张会红的表，不是散文（评审 Important 2）** ──
 *
 * 判据是「**扫字符串字面量**」，所以它天生只看得见「整条路径写在一对引号里」的形态。
 * 下面 `COVERED` 与 `BLIND_SPOTS` 两张表把这条边界变成可执行的
 *（形态照抄 `tests/unit/source-guards.test.ts`「已知抓不住的写法确实抓不住（边界是断言，不是散文）」）。
 *
 * **`BLIND_SPOTS` 今天只有一条：字符串拼接**（`"/v1" + "/messages"`）。
 * 处置它有**三条路，不是两条**（⚠️ 我原来在这里写成了二选一，**那是个假二分**，
 * 而「呈现一个假二分」与「写一句假断言」是同一族问题——下一个人会以为选项已经穷尽）：
 *
 * **(A) 放宽判据到「连 `"/v1"` 这个裸前缀也算」。否掉。**
 * 实测有 **2 处误报**：`admin-ui/js/api.js:15` 与 `:20` 的注释里各有一个 `` `/v1` ``
 * 行内代码——**是散文，不是端点知识**。而且这是**系统性**误报（以后任何一段提到
 * `/v1` 的注释都会踩），为它开 `ALLOW` 口子正是下面那段告诫要防的事。
 *
 * **(B) 按行扫描 + 跳过 `^\\s*(\\*|//|<!--)` 的注释行。今天不做，但它是可行的。**
 * 已实跑验证过：全树 `OFFENDERS(code lines) = []`（零误报），
 * `SKIPPED(comment lines) = ["admin-ui/js/api.js:15","admin-ui/js/api.js:20"]`，
 * 而 `const u = "/v1" + "/messages";` **CAUGHT** —— 唯一的盲点会被补上。
 * **三条代价，明写**：① 判据从「一条正则」变成「正则 + 一条注释启发式」，
 * **启发式本身是一个新的可错判断**；② 块注释里的端点从此不被扫（含
 * `/* … *\\/` 中间那些不以 `*` 起首的行，判据会误判成代码行、或反之）；
 * ③ **跳过逻辑自己需要一格自检**，否则「跳过范围悄悄变大」和现在这条 `lastIndex`
 * 致盲通道是同一类无声失效。
 * ⇒ **今天不做的理由**：Task 1 已经够长，而这三条代价里的每一条都要各自的实测。
 * **登记给 P3e，连同上面那组实跑数据一起——不必重量。**
 *
 * **(C) 登记成盲点（今天采纳）。** 拼接形态靠评审 +
 * Task 7 / Task 10 各自检查单上那句「端点只许来自 /admin/api/models」。
 *
 * ⚠️ **别把这份文件读成「前端从此不可能硬编码端点」。** 它挡住的是**顺手写下一条路径**，
 * 不是**刻意绕开**。
 */
function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(html|js|mjs)$/.test(p) ? [p] : [];
  });
}

// ⚠️ **`(?:beta)?` 不是 `beta?`。** 后者的 `?` 只管 `a` ⇒ 它匹配 `/v1beta/` 与 `/v1bet/`，
// **不匹配 `/v1/`** —— 而本仓五条对外端点里有四条是 `/v1/...`，包括下面反向自检用的
// 那个探针。这个错在本计划里被重放过三次，第三次才改对。
//
// ⚠️ **字符类里的 `$` `?` `=` 是评审 Important 2 之后补的，每一个都堵着一条实测逃逸**：
// 补之前 `` `/v1beta/models/${m}:generateContent` ``（`$` 断在类外）与
// `"/v1/chat/completions?stream=1"`（`?`/`=` 断在类外）**两种写法都逃得掉**。
// 前一条最要命：**Task 10 的 Playground 拼 Gemini URL 时最自然的写法就是它**
// ——护栏原来在它最该守的那个消费者身上有洞。两条的变红实测见下面 COVERED 那一格。
const ENDPOINT_RE = /["'`](\/v1(?:beta)?\/[A-Za-z0-9_{}$?=:/.-]*)["'`]/g;

/**
 * 豁免名单。**今天是空的，故意留着这个常量而不是删掉**：
 * 字典里今天零个 `/v1` 路径（实测全树命中数 = 0），所以它一条都不需要。
 * ⚠️ **往这里加任何一项之前先问「为什么那个文件需要写端点字面量」**——
 * 这是本期核心约束**唯一**的机器护栏，在护栏上预先开一个口子，
 * 就是在给「以后总有一天用得上」留台阶。真要加，把理由写在这一行下面。
 */
const ALLOW: readonly string[] = [];

/**
 * 一条样本会不会被 `ENDPOINT_RE` 抓住。
 *
 * ⚠️ **带 `g` 的正则有两侧危害，第一版只看见了「读」那一侧**（评审 HIGH 1，实测）：
 * · **读**：`.test()` 从 `lastIndex` 起扫，不重置会**隔次漏判**——入口这行 `= 0` 治的是它；
 * · **写**：`.test()` 命中之后会把 `lastIndex` **留成非零**，而 `scan()` 用的
 *   `String.matchAll()` **会把当时的 `lastIndex` 复制进它的克隆**
 *   ⇒ 每个文件开头若干字符被整段跳过。
 *
 * 实测过那条致盲通道有多近：在 `admin-ui/index.html` 首行种一条真的硬编码端点
 * `<!--"/v1/messages"-->`，**只要在 `scan()` 之前多调一次 `hit()`**，
 * 整个文件从 `1 failed` 变成 `7 passed`——**本期核心约束的唯一机器护栏当场恒绿**。
 * 当时没炸只靠两个偶然（扫描那格声明在前先跑；最后一次 `.test()` 恰好返回 false
 * 而引擎顺手把 `lastIndex` 归零），**两个都不是设计出来的、也没写进注释**。
 *
 * ⇒ 出口也归零，并且 `matchesIn()` 每次都自己重置一遍（**两道，不是一道**：
 * 谁将来直接用 `ENDPOINT_RE.test()` 而不走 `hit()`，`matchesIn()` 那道仍然兜得住）。
 * 由下面「扫描不受上一次 hit() 留下的 lastIndex 影响」那一格常驻钉着。
 */
function hit(s: string): boolean {
  ENDPOINT_RE.lastIndex = 0;
  const r = ENDPOINT_RE.test(s);
  ENDPOINT_RE.lastIndex = 0;
  return r;
}

/**
 * 一段源码里所有被抓住的端点。**`scan()` 与那格反向自检走的是同一条路径**——
 * 自检若另走一条，它证明的就是抄件不是原件（第 7 种假阳性）。
 */
function matchesIn(src: string): string[] {
  ENDPOINT_RE.lastIndex = 0;
  return [...src.matchAll(ENDPOINT_RE)].map((m) => m[1]!);
}

/**
 * 声称抓得住的写法。**每一条都写明它是哪个消费者会写出来的**——
 * 一条抓不到真实写法的护栏，和没有护栏是一回事。
 */
const COVERED: ReadonlyArray<{ probe: string; why: string }> = [
  {
    probe: "const url = `/v1beta/models/${model}:generateContent`;",
    why: "模板插值（**Task 10 拼 Gemini URL 最自然的写法**，字符类缺 `$` 时整条逃掉）",
  },
  {
    probe: 'fetch("/v1/chat/completions?stream=1");',
    why: "带查询串（字符类缺 `?` / `=` 时整条逃掉）",
  },
  {
    probe: "const p = `/v1/videos/${id}`;",
    why: "模板插值 + 媒体两段式的第二段（Task 12 会写它）",
  },
];

/**
 * 已知抓不住的写法，连同**为什么接受**一起登记。
 * 今天只有一条。**处置它的三条路（A 否掉 / B 可行但今天不做 / C 采纳）见文件头那段**
 * ——那里是三条，不是二选一。
 */
const BLIND_SPOTS: ReadonlyArray<{ probe: string; why: string }> = [
  {
    probe: 'const u = "/v1" + "/messages";',
    why: "字符串拼接 —— 整条路径不在同一对引号里，扫字面量的判据按定义看不见它。"
      + "处置有三条路：(A) 放宽到「裸 `/v1` 前缀也算」⇒ 实测 2 处系统性误报，否掉；"
      + "(B) 按行扫描 + 跳过注释行 ⇒ 实测零误报且能抓住它，**可行但今天不做**（三条代价见文件头，登记 P3e）；"
      + "(C) 登记成盲点 ⇒ 今天采纳",
  },
];

function scan(): string[] {
  const offenders: string[] = [];
  for (const p of walk("admin-ui")) {
    const rel = p.split("\\").join("/").replace(/^admin-ui\//, "");
    if (ALLOW.includes(rel)) continue;
    for (const found of matchesIn(readFileSync(p, "utf8"))) offenders.push(`${rel}: ${found}`);
  }
  return offenders;
}

describe("前端不许硬编码网关端点", () => {
  it("前端没有任何文件硬编码网关端点路径 —— 端点只许来自 /admin/api/models", () => {
    expect(scan(), "端点要从 /admin/api/models 的响应里取，别在这些地方再写一遍").toEqual([]);
  });

  /**
   * ── **致盲通道的常驻反向自检（评审 HIGH 1）** ──────────────────────────────
   *
   * 被守护的性质：**`scan()` 的结果不许依赖「在它之前有没有人调过 `hit()`」。**
   *
   * 这不是假想。实测：在 `admin-ui/index.html` 首行种一条真的硬编码端点
   * `<!--"/v1/messages"-->`，
   * · 现状 ⇒ `expected [ 'index.html: /v1/messages' ] to deeply equal []`（红，护栏有效）；
   * · **只在 `scan()` 之前多调一次 `hit()`** ⇒ `Test Files 1 passed / Tests 7 passed`
   *   ——**端点还躺在文件里，而护栏恒绿。**
   * 成因是 `String.matchAll()` 把原正则当时的 `lastIndex` 复制进克隆，
   * 于是每个文件开头若干字符被整段跳过。
   *
   * ⚠️ **这一格才是本条修复的重点，不是那两行 `lastIndex = 0`。**
   * 光把当时那条通道堵上，下一次重排用例、或在前面加一格用 `hit()` 的断言，
   * 就会把它无声地重新打开。
   *
   * **变红条件**：把 `matchesIn()` 里那行 `ENDPOINT_RE.lastIndex = 0;` 删掉。
   */
  it("扫描不受上一次 hit() 留下的 lastIndex 影响 —— 这条通道一旦打开，唯一的护栏会静默恒绿", () => {
    const planted = '<!--"/v1/messages"-->';
    // 前置条件①：这一条必须真的命中，否则下面弄不脏 `lastIndex`，整格就是空的。
    expect(hit(COVERED[2]!.probe), "前置条件：这条样本必须命中").toBe(true);
    // 前置条件②：**把 `lastIndex` 真的弄脏**。`hit()` 出口会归零，所以这里绕过它，
    // 直接用 `ENDPOINT_RE.test()` —— 那正是「谁将来不走 hit()」的那条路径。
    ENDPOINT_RE.lastIndex = 0;
    expect(ENDPOINT_RE.test(COVERED[2]!.probe), "前置条件：裸 test() 也必须命中").toBe(true);
    expect(ENDPOINT_RE.lastIndex, "前置条件：命中之后 lastIndex 必须非零，否则弄不脏").toBeGreaterThan(
      planted.length,
    );
    // 真正的断言：脏着 `lastIndex` 去扫，仍然要扫得到开头那条端点。
    expect(matchesIn(planted), "扫描被上一次 test() 留下的 lastIndex 带偏了").toEqual(["/v1/messages"]);
  });

  /**
   * **反向自检：这条正则真的认得本仓主流的那个写法。**
   *
   * 没有这一格的话，上面那个 `[]` 有两种成因分不开：「真的没人硬编码」与
   * 「正则瞎了、什么都扫不到」。本计划第一版正是后者，而它照样报「硬编码路径为 0」。
   *
   * ⚠️ 这里**不往仓库里种探针**（那会污染工作树，也会让这一格依赖文件系统状态）：
   * 判据是同一条 `ENDPOINT_RE` 对着六条手写的字符串样本跑，
   * 六条覆盖三种引号 × `/v1/` 与 `/v1beta/` 两种路径 × 一条**不该命中**的上游路径。
   * 真正「种一行进 admin-ui/ 再跑一遍」的动作在 Task 1 Step 6b 当场做过一次。
   */
  it("正则认得三种引号下的 /v1 与 /v1beta，且不误伤上游路径 —— 否则上面那个空数组什么都没证明", () => {
    expect(hit('const __probe = "/v1/messages";'), "双引号 + /v1/（Step 6b 的探针形态）").toBe(true);
    expect(hit('path: "/v1/chat/completions"'), "双引号").toBe(true);
    expect(hit("path: '/v1/responses'"), "单引号").toBe(true);
    expect(hit("url = `/v1/images/generations`"), "反引号").toBe(true);
    expect(hit('p = "/v1beta/models/x:generateContent"'), "/v1beta/").toBe(true);
    // **不该命中**：上游路径不带 `/v1` 前缀，它是网关自己拼的，不是前端的事。
    expect(hit('upstreamPath: "/chat/completions"'), "上游路径不该被扫进来").toBe(false);
  });

  /**
   * **声称抓得住的写法真的抓得住。**（评审 Important 2 补的两条，都是当时正在漏的活口子）
   *
   * 这一格红了只有一种意思：`ENDPOINT_RE` 的字符类又被改窄了，
   * 而窄回去的那一刻 Task 10 的 Playground 就能免检硬编码 Gemini 的 URL。
   */
  it.each(COVERED)("声称抓得住的写法真的抓得住：$why", ({ probe }) => {
    expect(hit(probe), `这条写法逃掉了：${probe}`).toBe(true);
  });

  /**
   * **已知抓不住的写法确实抓不住 —— 边界是断言，不是散文。**
   *
   * 形态照抄 `tests/unit/source-guards.test.ts`
   * 「已知抓不住的写法确实抓不住（边界是断言，不是散文）」。
   * **这一格变红意味着有人把这个盲点补上了——那是好事**，把对应的 `BLIND_SPOTS` 行删掉即可。
   * 它存在的理由是：一条只写在注释里的边界，改判据的人不会读到；写成用例才拦得住
   * 「以为它抓得住」的下一个人。
   */
  it.each(BLIND_SPOTS)("已知抓不住的写法确实抓不住（边界是断言，不是散文）：$why", ({ probe }) => {
    expect(hit(probe), `这条写法现在被抓住了，请把它从 BLIND_SPOTS 里删掉`).toBe(false);
  });

  /**
   * 扫描范围的反向自检：`walk("admin-ui")` 真的走到了 `js/pure/` 里面。
   * 上面那条告诫说「不许排除 js/pure/」，而**「没排除」与「根本没走到」在结果上一样**
   *（都是 0 条 offender）。这一格把「走到了」变成可观测的。
   */
  it("扫描范围真的覆盖 js/pure/ —— 「没排除它」与「根本没走到它」在结果上长得一样", () => {
    const scanned = walk("admin-ui").map((p) => p.split("\\").join("/"));
    expect(scanned).toContain("admin-ui/js/pure/storage-keys.mjs");
    expect(scanned).toContain("admin-ui/index.html");
  });
});
