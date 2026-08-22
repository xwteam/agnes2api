import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createProbeGuard, PROBE_MIN_INTERVAL_MS } from "../../../src/http/admin/probe-guard.js";

/**
 * 出站探测护栏的两道闸（P3d Task 8，全局约束 14）。
 *
 * ⚠️ **两道闸必须各自有一格能把另一道闸排除掉的用例，否则它们互相冒充。**
 * 冻住时钟连按两次时，**在途去重与最小间隔都会拒绝第二次** ⇒ 那种夹具下
 * 「只有最小间隔」这种实现照样全绿（本仓登记的第 5 种假阳性：覆盖的状态让被测的
 * 选择不可观测）。所以下面两格各自把时钟摆到只有一道闸说得上话的位置：
 * · 在途那格**把时钟推过最小间隔**（此时只有在途去重能拒绝）；
 * · 间隔那格**先 `release()`**（此时只有最小间隔能拒绝）。
 * 两格再各自断言 `reason`，把「哪道闸拒的」也钉住。
 */
describe("出站探测护栏：两道闸", () => {
  it("在飞期间挡得住第二次 —— 时钟已经推过最小间隔，此刻只有『在途去重』说得上话", () => {
    const g = createProbeGuard();
    expect(g.tryAcquire("verify:a", 0)).toEqual({ ok: true });
    // 10_000 远大于手写的 3_000（见下面那格对常量本身的锚）：最小间隔那道闸在这里
    // **已经放行了**，还挡得住只能是因为在途去重。
    const second = g.tryAcquire("verify:a", 10_000);
    expect(second.ok, "在飞期间第二次被放行了 —— 连点会真的多打一次外网").toBe(false);
    expect(second.ok === false && second.reason).toBe("probe_in_flight");
  });

  it("release 之后 2999 毫秒仍被挡、3000 毫秒放行 —— 此刻在途已经是空的，只有『最小间隔』说得上话", () => {
    const g = createProbeGuard();
    expect(g.tryAcquire("verify:a", 0)).toEqual({ ok: true });
    g.release("verify:a");

    // 期望值一律手写字面量（第 6 种假阳性），边界值**不写成 `PROBE_MIN_INTERVAL_MS - 1`**。
    const tooSoon = g.tryAcquire("verify:a", 2_999);
    expect(tooSoon.ok, "刚探过 2999 毫秒就被放行 —— 『按住不放』那一半没挡住").toBe(false);
    expect(tooSoon.ok === false && tooSoon.reason).toBe("probe_cooldown");

    // ⚠️ 这一格同时钉住**被拒的那次不许重新盖时间戳**：盖了的话每一次被拒的重试都会
    // 把窗口往后推一个完整间隔，运维「按住不放」时这颗按钮就再也解不开了。
    // 上面那次 2999 的拒绝若盖了戳，下面这次 3000 会算成 1 毫秒 ⇒ 当场变红。
    expect(g.tryAcquire("verify:a", 3_000)).toEqual({ ok: true });
  });

  it("PROBE_MIN_INTERVAL_MS 是 3000 —— 上面两格手写的 2999/3000 建立在它上面", () => {
    expect(PROBE_MIN_INTERVAL_MS).toBe(3_000);
  });

  it("kind 各管各的：验 A 把 key 不挡验 B 把，也不挡通道测试（评审 I11）", () => {
    const g = createProbeGuard();
    expect(g.tryAcquire("verify:a", 0)).toEqual({ ok: true });
    // **不 release**：闸最紧的那一刻。
    // 粒度写成全局 `"verify"` 的话，下面第一条会 429 ——
    // 20 把 key 逐个验就要串行等 60 秒，而在飞去重让它连并行都不行。
    expect(g.tryAcquire("verify:b", 0), "另一把 key 被同一道闸挡住了").toEqual({ ok: true });
    expect(g.tryAcquire("channel:yyds", 0), "通道测试被验活挡住了").toEqual({ ok: true });
  });

  it("release 一个从没占过的 kind 不抛错 —— 一条护栏不该把本来成功的请求变成 500", () => {
    const g = createProbeGuard();
    expect(() => g.release("verify:never-acquired")).not.toThrow();
    // 而且不留下痕迹：紧接着第一次占用必须成功（留了痕迹的话它会被算成「刚探过」）。
    expect(g.tryAcquire("verify:never-acquired", 0)).toEqual({ ok: true });
  });

  it("两把独立的护栏互不影响 —— 它是实例状态，不是模块级单例", () => {
    // 若把 Map 写成模块级变量，两个 isolate/两棵 admin 树会共用一份，
    // 而 `adminRouter` 每棵树建一把，测试之间也会互相污染。
    const a = createProbeGuard();
    const b = createProbeGuard();
    expect(a.tryAcquire("verify:x", 0)).toEqual({ ok: true });
    expect(b.tryAcquire("verify:x", 0), "另一把护栏被第一把的状态影响了").toEqual({ ok: true });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 源码级：两条出站探测端点的「单一真源」（全局约束 15）
// ───────────────────────────────────────────────────────────────────────────

function walkTs(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkTs(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const read = (p: string): string => readFileSync(p, "utf8");

/**
 * ⚠️ **这一组守的是行为测试守不到的那一半，两者不重叠。**
 *
 * `tests/contract/admin-verify.test.ts`「通道测试与验活共用同一套护栏 —— 两条端点在
 * 同一个最小间隔边界上各跑一遍」能抓住「两处各拿一个自己的间隔常数」（数一漂就红），
 * **但抓不住「有人在某个 handler 里另起一份行为完全相同的实现」**——那种形态下
 * 所有行为断言照样全绿，而下一次改判据的人只会改其中一处。
 * 这一组是「没有单一真源的东西迟早会漂」那条裁定在源码上的落点。
 * ⚠️ 上一版这里跟着写了「本仓已经裁过三次」——**计数删掉了**：仓里复述它的地方有好几处，
 * **从来没有人列出过是哪三次**（本轮评审裁定：要么列出来，要么把计数删掉）。
 */
describe("出站探测：两条端点的单一真源（源码级）", () => {
  const HANDLERS = [
    "src/http/admin/handlers/verify.ts",
    "src/http/admin/handlers/registrar.ts",
  ] as const;

  /**
   * ⚠️⚠️ **这一格的判据被订正过两次，两次都是实测打脸，两次都记在这里。**
   *
   * · **第一版查 `import`** ⇒ 变异 M11b（另起一份行为完全相同的本地实现）**逃逸**：
   *   `import type { ProbeGuard }` 因为 `RegistrarDeps` 那一格仍然用得着而原样留着。
   * · **第二版查 `.tryAcquire(` 出现过** ⇒ 本轮评审的 HIGH-1 **逃逸（68/68 全绿）**：
   *   **把注入那把的调用留成一句死代码**（`void deps.probeGuard.tryAcquire(…)`）
   *   再另起本地那把，`toContain` 照样命中。当时那段注释写着
   *   「**任何**本地实现都得换掉这一句」——**已实测证伪**，是本仓被证伪的第 N 条全称句
   *   （**刻意不写第几条**：那个计数同样没人核得动，见本文件头那段裁定）。
   *
   * ⇒ **第三版的判据由三条合成，写成一个纯函数 `guardWiring()` 好让两个方向都能种探针**：
   *   ① 注入那把必须以**赋值**形态出现恰好一次（死代码 `void …` 当场出局）；
   *   ② 全文件的 `tryAcquire(` / `release(` 计数各恰好 1（多出来的那一个就是本地那把）；
   *   ③ 文件里不许出现 `new Map(`（本地护栏最自然的状态容器）。
   *
   * **边界两个方向各种一次**（下面 `COVERED` / `BLIND_SPOTS` 两张表都真的跑），
   * 这是本轮评审定的纪律：**每写一条「它抓得住 X / 抓不住 Y」，两边各种一次。**
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /** 一个文件的护栏接线画像。**纯函数**，好让真文件与手写探针走同一条判据。 */
  function guardWiring(src: string, depsField: "guard" | "probeGuard") {
    const code = stripComments(src);
    const count = (re: RegExp): number => (code.match(re) ?? []).length;
    return {
      /** 注入那把，**赋值形态**（`const x = deps.<f>.tryAcquire(`）。死代码不算。 */
      assignedAcquire: count(new RegExp(`=\\s*deps\\.${depsField}\\.tryAcquire\\(`, "g")),
      /** 注入那把的 release。 */
      injectedRelease: count(new RegExp(`deps\\.${depsField}\\.release\\(`, "g")),
      /** 全文件的 acquire / release 调用点总数 —— 多出来的就是第二把。 */
      totalAcquire: count(/tryAcquire\s*\(/g),
      totalRelease: count(/\brelease\s*\(/g),
      /** 本地护栏最自然的状态容器。 */
      maps: count(/new Map\s*\(/g),
    };
  }

  /** 接线正确的画像：注入那把各出现一次，且全文件再没有第二个 acquire/release，也没有 Map。 */
  const WIRED = { assignedAcquire: 1, injectedRelease: 1, totalAcquire: 1, totalRelease: 1, maps: 0 };

  it("两条端点的 handler 都从 probe-guard.js 取护栏 —— 各写一套就是两套判据", () => {
    const CASES: ReadonlyArray<readonly [string, "guard" | "probeGuard"]> = [
      // deps 上那一格在两处叫法不同（验活叫 `guard`，注册机叫 `probeGuard`），手写列全。
      ["src/http/admin/handlers/verify.ts", "guard"],
      ["src/http/admin/handlers/registrar.ts", "probeGuard"],
    ];
    for (const [p, field] of CASES) {
      expect(read(p), `${p} 没有从共用的护栏模块取 ProbeGuard`).toContain('from "../probe-guard.js"');
      expect(guardWiring(read(p), field), `${p} 的护栏接线画像不对（另起了一份本地实现？）`)
        .toEqual(WIRED);
    }
    // 手写字面量快照：`HANDLERS` 与这张表必须说同一件事。
    expect(CASES.map(([p]) => p)).toEqual([...HANDLERS]);
  });

  /**
   * **声称抓得住的写法真的抓得住。** 每条探针都是一段**会跑**的源码文本，
   * 走的是上面那个 `guardWiring()`——与真文件同一条判据，不是另抄一份。
   */
  const COVERED: ReadonlyArray<{ why: string; src: string }> = [
    {
      why: "本轮评审 HIGH-1 的原形：注入那把留成一句死代码 + 另起本地那把",
      src: "void deps.probeGuard.tryAcquire(k, n);\n"
        + "const g = localTryAcquire(k, n);\n"
        + "deps.probeGuard.release(k);\n"
        + "localRelease(k);\n"
        + "const localSlots = new Map();\n",
    },
    {
      why: "M11b 的原形：注入那把整个换掉，只留 import type",
      src: "const g = localTryAcquire(k, n);\nlocalRelease(k);\nconst s = new Map();\n",
    },
    {
      why: "只把 release 换成本地那把（在飞标记从此落在两张表上）",
      src: "const g = deps.probeGuard.tryAcquire(k, n);\nlocalRelease(k);\nconst s = new Map();\n",
    },
    {
      why: "本地状态容器：即使一次都不叫 tryAcquire，一个 new Map 也够可疑",
      src: "const g = deps.probeGuard.tryAcquire(k, n);\ndeps.probeGuard.release(k);\nconst s = new Map();\n",
    },
  ];

  it.each(COVERED)("声称抓得住的写法真的抓得住：$why", ({ src }) => {
    expect(guardWiring(src, "probeGuard")).not.toEqual(WIRED);
  });

  /**
   * **已知抓不住的写法确实抓不住 —— 边界是断言，不是散文。**
   *
   * 这一格变红意味着**有人把这个盲点补上了**，那是好事：把对应的行删掉即可。
   * 它存在的理由是不让「边界在哪」重新漂成一句没人验证过的散文——
   * 本轮评审判掉的两条 HIGH，成因都是**边界只写在散文里，而且写反了**。
   */
  const BLIND_SPOTS: ReadonlyArray<{ why: string; src: string }> = [
    {
      why: "本地实现不叫 tryAcquire/release、状态放模块级对象而不是 Map：三条判据一条都碰不到",
      src: "const g = deps.probeGuard.tryAcquire(k, n);\n"
        + "deps.probeGuard.release(k);\n"
        + "const slots = {};\n"
        + "const okLocal = localGate(k, n);\n",
    },
  ];

  it.each(BLIND_SPOTS)("已知抓不住的写法确实抓不住（边界是断言，不是散文）：$why", ({ src }) => {
    expect(guardWiring(src, "probeGuard")).toEqual(WIRED);
  });

  it("全 src/ 里只有一处 new 出护栏，一处定义它 —— 第二处 createProbeGuard() 就是第二把闸", () => {
    const hits = walkTs("src")
      .map((p) => p.split("\\").join("/"))
      .filter((p) => read(p).includes("createProbeGuard("));
    // 手写字面量快照。多一条 = 有人又建了一把（那时两条端点各限各的速，而
    // 「共用一套」这句话在任何行为断言上都不可观测，见 probe-guard.ts 里那段登记）。
    expect(hits.sort()).toEqual([
      "src/http/admin/probe-guard.ts",   // 定义
      "src/http/admin/router.ts",        // 唯一的调用点：建一把，交给两处
    ]);
  });

  /**
   * ⚠️ **这一格补的是行为测试**明说**抓不住的那个方向。**
   *
   * `tests/contract/admin-verify.test.ts`「出站 URL 是 agnesBaseUrl + 协议目录的
   * upstreamPath，不是对外的 pathTemplate（评审 C3）」拿的是手写字面量
   * `https://upstream.test/v1/chat/completions`——它抓得住「误用 `pathTemplate`」，
   * **但抓不住「handler 里硬编码一份 `/chat/completions`」**：两种写法今天产出
   * 逐字节相同的 URL。而硬编码正是全局约束 15 点名要防的那件事
   *（「四个消费者只许有一份『怎么调这个网关』的知识」）。
   *
   * ⚠️⚠️ **判据订正过一次，而且是「边界写反了」那一种（本轮评审 HIGH-2）。**
   * 第一版要求**引号紧挨着路径**（`["'`]/chat/completions["'`]`），于是：
   * · **最自然的那个写法整个逃掉** —— `` `${cfg.agnesBaseUrl}/chat/completions` ``
   *   （实测：把 handler 改成它 ⇒ **31/31 全绿**）；
   * · 而当时注释里登记的盲点「字符串拼接」**其实一半是抓得住的** ——
   *   实测 `cfg.agnesBaseUrl + "/chat/completions"` **CAUGHT**，
   *   只有把路径**自己**拆开的 `"/chat" + "/completions"` 才 ESCAPED。
   * · 成因很干净：**反向自检探的是「反引号紧挨路径」**（`` `/chat/completions` ``），
   *   那个形态确实抓得住，于是给了错误的安心感——**探针没探在会漏的那一侧。**
   *
   * ⇒ 判据改成**在剥注释后的代码里扫路径本身这个词**，不再要求引号紧挨：
   * 引号、反引号、模板串插值之后、字符串加号拼接，四种一网打尽。
   * 真代码里这个词一次都不该出现（它只能来自 `proto.upstreamPath`），所以零误报。
   */
  const PATH_TOKEN = /\/chat\/completions/g;
  const scanPath = (src: string): string[] => stripComments(src).match(PATH_TOKEN) ?? [];

  it("verify.ts 里没有任何写死的上游/对外路径 —— 路径只许来自协议目录（全局约束 15）", () => {
    // **必须先剥注释**（与 `tests/unit/source-guards.test.ts` 的 `stripComments` 同一条
    // 理由，那里的原话是「这个仓库的注释极其爱复述代码」）：verify.ts 的文件头就用
    // 反引号行内代码复述了 `/v1/chat/completions` 与 `/chat/completions` 两条，
    // 不剥的话这一格恒红，而恒红的断言迟早会被人直接删掉。
    expect(scanPath(read("src/http/admin/handlers/verify.ts")), "verify.ts 的**代码**里出现了写死的路径")
      .toEqual([]);
    // 反向自检：**剥注释没有把整个文件剥空**。少了它，剥注释的正则哪天写坏成
    // 「吃掉全文」时这一格照样绿——那正是「覆盖的状态让被测的选择不可观测」。
    expect(
      stripComments(read("src/http/admin/handlers/verify.ts")),
      "剥注释之后连 fetcher.fetch 都没剩下 —— 这一格已经在扫一个空串了",
    ).toContain("deps.fetcher.fetch(");
  });

  /**
   * **声称抓得住的写法真的抓得住。**
   * ⚠️ **第一条就是 HIGH-2 逃掉的那个形态**，它排在最前面不是巧合：
   * 探针要先探在**会漏的那一侧**，探在已经抓得住的那一侧只会制造安心感。
   */
  const PATH_COVERED: ReadonlyArray<{ why: string; src: string }> = [
    { why: "模板串插值之后紧跟路径（HIGH-2 逃掉的正是这个，也是最自然的写法）", src: "await f(`${cfg.agnesBaseUrl}/chat/completions`, init);" },
    { why: "加号拼接（实测：这一条第一版就抓得住，当时却被登记成盲点）", src: 'const u = cfg.agnesBaseUrl + "/chat/completions";' },
    { why: "双引号", src: 'const p = "/chat/completions";' },
    { why: "单引号（带对外 /v1 前缀）", src: "const p = '/v1/chat/completions';" },
    { why: "反引号紧挨路径", src: "const p = `/chat/completions`;" },
    { why: "对象字面量里的一格", src: 'const o = { path: "/v1/chat/completions" };' },
  ];

  it.each(PATH_COVERED)("声称抓得住的写法真的抓得住：$why", ({ src }) => {
    expect(scanPath(src).length).toBeGreaterThan(0);
  });

  /**
   * **已知抓不住的写法确实抓不住 —— 边界是断言，不是散文。**
   * 剩下的盲点只有一族：**把路径这个词自己拆开**（拼接、转义、编码）。
   * 与 `tests/ui/no-hardcoded-endpoints.test.ts`
   * 「已知抓不住的写法确实抓不住（边界是断言，不是散文）」登记的是同一族，处置也相同
   *（留给评审）。**它挡的是顺手写下一条路径，不是刻意绕开。**
   */
  const PATH_BLIND_SPOTS: ReadonlyArray<{ why: string; src: string }> = [
    { why: "把路径自己拆成两段再拼", src: 'const p = "/chat" + "/completions";' },
    { why: "用转义把斜杠藏起来", src: 'const p = "\\u002fchat\\u002fcompletions";' },
  ];

  it.each(PATH_BLIND_SPOTS)("已知抓不住的写法确实抓不住（边界是断言，不是散文）：$why", ({ src }) => {
    expect(scanPath(src)).toEqual([]);
  });
});
