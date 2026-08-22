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
 * 「没有单一真源的东西迟早会漂」本仓已经裁过三次，这一组是那条裁定在源码上的落点。
 */
describe("出站探测：两条端点的单一真源（源码级）", () => {
  const HANDLERS = [
    "src/http/admin/handlers/verify.ts",
    "src/http/admin/handlers/registrar.ts",
  ] as const;

  /**
   * ⚠️ **判据是「真的调了注入进来的那把」，不是「import 了那个模块」。**
   *
   * 只查 import 的写法**实测抓不住**（本任务变异 M11b：在 `registrar.ts` 里另起一份
   * 行为完全相同的本地实现，`import type { ProbeGuard }` 因为 `RegistrarDeps` 那一格
   * 仍然用得着而原样留在文件里 ⇒ 那条断言照绿）。查 `.tryAcquire(` 的调用点才有牙：
   * 任何本地实现都得换掉这一句。
   */
  it("两条端点的 handler 都从 probe-guard.js 取护栏 —— 各写一套就是两套判据", () => {
    const CALLS: ReadonlyArray<readonly [string, string]> = [
      // deps 上那一格在两处叫法不同（验活叫 `guard`，注册机叫 `probeGuard`），
      // 手写字面量列全，别写成正则——写成正则就会把本地实现也一起认下。
      ["src/http/admin/handlers/verify.ts", "deps.guard.tryAcquire("],
      ["src/http/admin/handlers/registrar.ts", "deps.probeGuard.tryAcquire("],
    ];
    for (const [p, call] of CALLS) {
      expect(read(p), `${p} 没有从共用的护栏模块取 ProbeGuard`).toContain('from "../probe-guard.js"');
      expect(read(p), `${p} 没有真的去调注入进来的那把护栏（另起了一份本地实现？）`).toContain(call);
    }
    // 手写字面量快照：`HANDLERS` 与上面这张表必须说同一件事。
    expect(CALLS.map(([p]) => p)).toEqual([...HANDLERS]);
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
   * ⚠️ **边界明写，别把它读成「这个文件从此不可能硬编码端点」**：判据是扫字符串
   * 字面量，`"/chat" + "/completions"` 这种拼接它看不见——与
   * `tests/ui/no-hardcoded-endpoints.test.ts`「已知抓不住的写法确实抓不住（边界是断言，不是散文）」
   * 登记的那条盲点是同一条，处置也相同（留给评审）。
   * 它挡的是**顺手写下一条路径**，不是**刻意绕开**。
   */
  it("verify.ts 里没有任何写死的上游/对外路径字面量 —— 路径只许来自协议目录（全局约束 15）", () => {
    // 三种引号都要扫：本仓 `tests/ui/no-hardcoded-endpoints.test.ts` 记着一次
    // 「只认单引号 ⇒ 那条检查恒输出 0 行、恒通过」的翻车。
    const RE = /["'`](?:\/v1(?:beta)?)?\/chat\/completions["'`]/g;
    // **必须先剥注释**（与 `tests/unit/source-guards.test.ts` 的 `stripComments` 同一条
    // 理由，那里的原话是「这个仓库的注释极其爱复述代码」）：verify.ts 的文件头就用
    // 反引号行内代码复述了 `/v1/chat/completions` 与 `/chat/completions` 两条，
    // 不剥的话这一格恒红，而恒红的断言迟早会被人直接删掉。
    const code = read("src/http/admin/handlers/verify.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code.match(RE) ?? [], "verify.ts 的**代码**里出现了写死的路径字面量").toEqual([]);

    // 反向自检①：这条正则真的认得那三种引号，否则上面那个空数组什么都没证明。
    for (const probe of [
      'const p = "/chat/completions";',
      "const p = '/v1/chat/completions';",
      "const p = `/chat/completions`;",
    ]) {
      RE.lastIndex = 0;
      expect(RE.test(probe), `这条写法逃掉了：${probe}`).toBe(true);
    }
    // 反向自检②：**剥注释没有把整个文件剥空**。少了它，剥注释的正则哪天写坏成
    // 「吃掉全文」时这一格照样绿——那正是「覆盖的状态让被测的选择不可观测」。
    expect(code, "剥注释之后连 fetcher.fetch 都没剩下 —— 这一格已经在扫一个空串了")
      .toContain("deps.fetcher.fetch(");
  });
});
