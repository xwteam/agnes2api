import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 源码层门禁：**两条硬约束的自动化部分**。
 *
 * 这个文件存在的理由是一次实测打脸：台账与多处派发里都写着「`src/core` 零 IO，
 * 豁免清单不许变长，**有源码断言钉着**」——**那条断言根本不存在**。全仓当时只有两处
 * 源码扫描（`registrar/log-prefix.test.ts` 扫 `src/core` 的裸 console、
 * `pool-cache.test.ts` 扫 `lastUsedAt` 的读取点），没有任何一条查 `setTimeout` /
 * `Date.now` / `Math.random`。实测在 `src/core/` 下加一处 `setTimeout` 加一处
 * `Math.random`，typecheck、全套单元/契约测试、九道 CI 门禁**全绿，零信号**。
 *
 * 同一段话的另一半也不成立：Task 5 新增的 `src/http/admin/**` 与 Task 6 新增的
 * `src/ui/**` 两棵树，既不在 `LOGGER_ONLY_SOURCES` 里，也不在任何 `walkTs` 的目录里。
 *
 * ⚠️ **期望值一律手写字面量，绝不从被测对象 grep 出来再回填。** 回填出来的期望值
 * 恒等于实际值，那条断言永远绿——这是本项目登记在案的第 6 种假阳性形态。
 * 下面两份清单都是逐条对着源码手敲的，清单变长就变红，逼加豁免的人在评审里表态。
 */

/**
 * 去掉注释再扫。不去的话注释里提一句 `Date.now()` 就误报，而这个仓库的注释**极其**
 * 爱复述代码（`refreshable.ts` 开头就写着「不用 Date.now()/setTimeout」）。
 * 行注释的正则要求 `//` 前面不是冒号，免得把 `https://…` 之后的半行代码一起吃掉。
 * 与 `pool-cache.test.ts` 里那条 `lastUsedAt` 扫描用的是同一套处理。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walkTs(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkTs(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** 找到的每一处渲染成 `路径 :: 记号 ×次数`，排好序。**次数必须在里面**：只记「哪个文件用了
 * setTimeout」的话，同一个文件里再加第二处不会有任何信号。 */
function tally(hits: string[]): string[] {
  const n = new Map<string, number>();
  for (const h of hits) n.set(h, (n.get(h) ?? 0) + 1);
  return [...n].map(([k, c]) => `${k} ×${c}`).sort();
}

// ── ① src/core 零 IO ──────────────────────────────────────────────────────

/**
 * 「IO」在这条硬约束里的定义：**时间、随机、定时、网络、环境**——凡是让纯函数变得
 * 不可重放的东西。`src/core` 里这些一律要从构造参数注入（`now`、`sleep`、`rand`、
 * `fetcher`、`logger`），否则测试只能靠等真实时间或碰运气。
 *
 * `(?<![.\w])` 挡掉方法调用：`deps.fetcher.fetch(…)` 与 `this.o.now()` 是注入的端口，
 * 不是全局能力，不该被算成违规。
 */
const IO_RULES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "setTimeout", re: /(?<![.\w])setTimeout\s*\(/g },
  { label: "setInterval", re: /(?<![.\w])setInterval\s*\(/g },
  { label: "Date.now", re: /(?<![.\w])Date\.now\b/g },
  { label: "Math.random", re: /(?<![.\w])Math\.random\b/g },
  { label: "crypto", re: /(?<![.\w])crypto\.\w+/g },
  { label: "fetch(", re: /(?<![.\w])fetch\s*\(/g },
  { label: "process.env", re: /(?<![.\w])process\.env\b/g },
];

/**
 * **手写的豁免清单。P1/P2 留下的 6 处，P3a 一处没新增。**
 *
 * 每一条都要能一句话说清为什么它不是「环境能力注入」的漏网之鱼：
 * - `dispatcher.ts` 的 `setTimeout`：`AbortController` 的超时闸。注入它就要注入一整套
 *   假定时器，而被测的是「超时会不会真的中止」，假定时器证明不了。已登记的既定豁免。
 * - `keypool-repo.ts` 的 `crypto.subtle`：算 key 的 id。WebCrypto 在 Workers 与 Node
 *   都是标准全局，注入只会多一个端口、多一份假实现，换不到可测性。已登记。
 * - 两处 `crypto.randomUUID`：协议层给响应造 id（`msg_…` / `resp_…`）。同上。
 * - `storage-health.ts` 与 `registrar/mint.ts` 的 `Date.now` / `Math.random`：都是
 *   **可注入参数的默认值**（`now: () => number = () => Date.now()`、
 *   `deps.rand ?? Math.random`），测试里全都传了假的进去。
 *
 * 清单变长 = 有人在 core 里引入了新的不可重放能力，**必须在评审里显式表态**，
 * 而不是让它悄悄绿过去。
 */
const CORE_IO_EXEMPTIONS: readonly string[] = [
  "src/core/dispatcher.ts :: setTimeout ×1",
  "src/core/keypool-repo.ts :: crypto ×1",
  "src/core/protocol/anthropic.ts :: crypto ×1",
  "src/core/protocol/responses.ts :: crypto ×1",
  "src/core/registrar/mint.ts :: Math.random ×1",
  "src/core/storage-health.ts :: Date.now ×1",
];

describe("硬约束：src/core 零 IO", () => {
  it("时间 / 随机 / 定时 / 网络 / 环境的使用点恰好等于手写的豁免清单", () => {
    const hits: string[] = [];
    for (const p of walkTs("src/core")) {
      const src = stripComments(readFileSync(p, "utf8"));
      for (const { label, re } of IO_RULES) {
        for (const _ of src.matchAll(re)) hits.push(`${p.split("\\").join("/")} :: ${label}`);
      }
    }
    expect(
      tally(hits),
      "src/core 的零 IO 豁免清单变了。变长就是在 core 里引入了新的不可重放能力："
      + "先确认它真的无法从构造参数注入，再把它连同理由加进 CORE_IO_EXEMPTIONS，"
      + "别只把这条断言改绿",
    ).toEqual([...CORE_IO_EXEMPTIONS]);
  });

  it("扫描本身是活的——在 src/core 随便挑一个文件加一处 setTimeout 就必须能被抓到", () => {
    // 反向自检：上面那条断言全绿也可能是因为**正则一个都没匹配上**（写错 flag、
    // 写错 lookbehind、walkTs 扫了个空目录）。拿一段一定含违规的假源码过一遍同一套
    // 判据，确认它真的报得出来。不做这一步的话，把 IO_RULES 整个清空、把
    // CORE_IO_EXEMPTIONS 也清空，上面那条照样绿。
    const fake = stripComments(`
      // 这行注释里的 Date.now() 不算
      const t = setTimeout(() => {}, 1);
      const r = Math.random();
      const ok = deps.fetcher.fetch(url);   // 注入的端口，不算
      const bad = fetch(url);
    `);
    const found: string[] = [];
    for (const { label, re } of IO_RULES) {
      for (const _ of fake.matchAll(re)) found.push(`fake :: ${label}`);
    }
    expect(tally(found)).toEqual([
      "fake :: Math.random ×1",
      "fake :: fetch( ×1",
      "fake :: setTimeout ×1",
    ]);
  });
});

// ── ② src/http 与 src/ui 的裸 console ────────────────────────────────────

/**
 * `src/core` 那半边由 `tests/unit/registrar/log-prefix.test.ts` 守着（那里还连带守
 * 五语言 REGISTRAR.md 承诺的 `[registrar]` 前缀契约）。这里补的是 Task 5/6 新增的
 * 两棵树：`src/http/**`（含 `admin/`）与 `src/ui/**`。
 *
 * 为什么要守：Task 1 把裸 `console.*` 归零的理由是「事件要能落库」——P3b 的事件板块
 * 要消费的是注入 Logger 打出来的结构化事件，绕过 sink 直接 `console.warn` 的那条
 * 信息**永远进不了面板**，而且没有任何报错。P3b 恰恰要往 `src/http/admin/handlers/`
 * 里大量新增文件。
 *
 * **不扫 `src/entry/**` 与 `src/adapters/logger-console.ts`**，这是有理由的边界而不是
 * 遗漏：前者是组装根（装配失败时连 logger 都还没建起来），后者就是 sink 本身——
 * 对它们而言 console 是职责，不是违规。
 */
const CONSOLE_CALL = /console\.(log|warn|error|info|debug)\(/g;

/**
 * **手写的豁免清单。** `wire.ts` 那两处打的是「数据目录不可写」的启动诊断：它跑在
 * `buildApp` 里、`/health` 的可写性探测那一步，而那时输出必须无条件可见（Docker 绑定
 * 挂载属主不匹配是最常见的部署事故）。其余一处都不该有。
 */
const HTTP_UI_CONSOLE_EXEMPTIONS: readonly string[] = [
  "src/http/wire.ts :: console ×2",
];

describe("src/http 与 src/ui 里的裸 console", () => {
  it("调用点恰好等于手写的豁免清单——绕过注入 Logger 的事件永远进不了面板", () => {
    const hits: string[] = [];
    for (const dir of ["src/http", "src/ui"]) {
      for (const p of walkTs(dir)) {
        const src = stripComments(readFileSync(p, "utf8"));
        for (const _ of src.matchAll(CONSOLE_CALL)) hits.push(`${p.split("\\").join("/")} :: console`);
      }
    }
    expect(
      tally(hits),
      "src/http / src/ui 出现了新的裸 console。事件要能被 P3b 的面板消费就必须走注入的 "
      + "Logger（`logger.log({ level, event, msg, fields })`）；确实需要 console 的话，"
      + "把它连同理由加进 HTTP_UI_CONSOLE_EXEMPTIONS",
    ).toEqual([...HTTP_UI_CONSOLE_EXEMPTIONS]);
  });
});
