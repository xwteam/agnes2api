import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 源码层门禁：**两条硬约束的自动化部分**。
 *
 * 这个文件存在的理由是一次实测打脸：台账与多处派发里都写着「`src/core` 零 IO，
 * 豁免清单不许变长，**有源码断言钉着**」——**那条断言根本不存在**（计划文档的订正 R1）。
 * 实测在 `src/core/` 下加一处 `setTimeout` 加一处 `Math.random`，typecheck、全套测试、
 * 九道 CI 门禁**全绿，零信号**。
 *
 * ⚠️⚠️ **本文件第一版自己又犯了同一个错，务必读完这一段再改它。**
 * 那一版的注释宣称扫描覆盖「**全** `src/core` 的时间/随机/定时/网络/环境使用点」。
 * 复评拿四种**最地道**的写法一试就穿了，三条断言全过、零信号：
 *
 *     globalThis.setTimeout(() => {}, 1);      // lookbehind 把带前缀的写法整个挡掉了
 *     const a = new Date().getTime();          // 压根没有这条规则
 *     const b = performance.now();             // 压根没有这条规则
 *     const c = globalThis.Math.random();      // 同第一条
 *
 * 要害不是「漏了几个记号」，而是**又一次越界宣称**——规模比 R1 小，性质一模一样，
 * 而这条门禁存在的全部理由就是治「注释里的断言被后人信任」。
 *
 * **因此本文件的边界不再由散文宣称，而是由下面两张可执行的表钉死**：
 * `COVERED`（每一种声称覆盖的写法都有探针证明真的抓得住）与
 * `BLIND_SPOTS`（每一处已知抓不住的写法都有探针证明确实抓不住，并写明为什么接受）。
 * **任何基于 grep 的门禁都不可能完备**，与其反复越界宣称，不如把「覆盖什么、不覆盖
 * 什么」一起变成会变红的断言——这和 `.gitattributes` 不加 `-diff`、资产快照只锁键集合
 * 是同一套「明写边界」的做法。
 *
 * ⚠️ 期望值一律手写字面量，绝不从被测对象 grep 出来再回填。回填出来的期望值恒等于
 * 实际值，那条断言永远绿——这是本项目登记在案的第 6 种假阳性形态。
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

/**
 * 把 `globalThis.` / `globalThis?.` / `self.` / `window.` 这层前缀**先剥掉再扫**。
 *
 * 下面每条规则都用 `(?<![.\w])` 挡住「点号前缀」，那是**本意**：`this.o.now()`、
 * `deps.fetcher.fetch()` 是注入的端口，不是全局能力，不该算违规。代价是
 * `globalThis.setTimeout(…)` 这类拼法连带隐身——而它是合法 TypeScript、在两种运行时
 * 都能跑，隐身就等于门禁形同虚设。先归一化再扫，两头都要。
 */
function stripGlobalPrefix(src: string): string {
  return src.replace(/\b(?:globalThis|self|window)\s*\.\s*/g, "");
}

/**
 * 可选链归一：`?.` → `.`。
 *
 * 不做的话 `globalThis?.Math?.random()` 会在剥完前缀之后剩下 `Math?.random()`，
 * 而规则要的是字面的 `Math.random`——又一个隐身写法。
 * **不会引入误报**：`deps.fetcher?.fetch(url)` 归一成 `deps.fetcher.fetch(url)` 之后，
 * 每条规则的 `(?<![.\w])` 照样把它挡在门外（它前面是点号，仍然是注入端口）。
 */
function collapseOptionalChain(src: string): string {
  return src.replace(/\?\./g, ".");
}

const prepare = (src: string): string =>
  stripGlobalPrefix(collapseOptionalChain(stripComments(src)));

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
 * 记号名直接取**匹配到的文本**（归一化空白、去掉尾随的 `(`），所以豁免清单天然是
 * 自解释的：写着 `crypto.subtle` 就是 `crypto.subtle`，不是一个笼统的 `crypto`。
 *
 * `Date.*` / `performance.*` / `process.*` 三条刻意取整族而不是只取 `Date.now`：
 * 一条 grep 门禁分不出 `new Date(ts)`（纯）与 `new Date()`（读时钟）、也分不出
 * `Date.parse`（纯）与 `Date.now`（不纯）。**宁可多报**——多报的代价是往豁免清单里
 * 加一行并写清理由（一次评审动作），漏报的代价是这道门禁重新变回摆设。
 */
const IO_PATTERNS: readonly RegExp[] = [
  /(?<![.\w])set(?:Timeout|Interval|Immediate)\s*\(/g,
  /(?<![.\w])new\s+Date\b/g,
  /(?<![.\w])Date\.\w+/g,
  /(?<![.\w])performance\.\w+/g,
  /(?<![.\w])Math\.random\b/g,
  /(?<![.\w])crypto\.\w+/g,
  /(?<![.\w])fetch\s*\(/g,
  /(?<![.\w])process\.\w+/g,
];

const labelOf = (m: string): string => m.replace(/\s*\($/, "").replace(/\s+/g, " ");

function scanIo(src: string): string[] {
  const out: string[] = [];
  const prepared = prepare(src);
  for (const re of IO_PATTERNS) for (const m of prepared.matchAll(re)) out.push(labelOf(m[0]));
  return out;
}

/**
 * **这道扫描声称覆盖的写法，每一条都有探针钉着。**
 *
 * 加规则时**必须同时往这里加一行**；这张表不是文档，它是断言。第一版之所以能
 * 越界宣称，正是因为「覆盖什么」只写在散文里，没有任何东西验证过它。
 */
const COVERED: ReadonlyArray<{ probe: string; expect: string }> = [
  { probe: "setTimeout(() => {}, 1);", expect: "setTimeout" },
  { probe: "globalThis.setTimeout(() => {}, 1);", expect: "setTimeout" },
  { probe: "setInterval(tick, 1000);", expect: "setInterval" },
  { probe: "setImmediate(tick);", expect: "setImmediate" },
  { probe: "const t = Date.now();", expect: "Date.now" },
  { probe: "const t = new Date().getTime();", expect: "new Date" },
  { probe: "const t = performance.now();", expect: "performance.now" },
  { probe: "const r = Math.random();", expect: "Math.random" },
  { probe: "const r = globalThis.Math.random();", expect: "Math.random" },
  { probe: "const r = globalThis?.Math?.random();", expect: "Math.random" },
  { probe: "const id = crypto.randomUUID();", expect: "crypto.randomUUID" },
  { probe: 'const r = await fetch("https://x.test");', expect: "fetch" },
  { probe: "const v = process.env.FOO;", expect: "process.env" },
];

/**
 * **这道扫描抓不住的写法，同样每一条都有探针钉着。**
 *
 * 写成会变红的断言而不是一句「本门禁并不完备」：将来谁把某一条补上了，对应的用例会
 * 变红，逼他把这一行删掉——于是「边界在哪」永远与实现同步，不会再漂成一句假话。
 *
 * 为什么接受这几条：它们都是**刻意绕开**才写得出来的形态，而门禁真正要拦的是
 * `new Date()` / `performance.now()` 这类「开发者最自然的写法」。刻意绕过这一档留给
 * 代码评审，与 `dispatcher.ts` 里模块级 `let cursor` 的处置是同一条线。
 */
const BLIND_SPOTS: ReadonlyArray<{ probe: string; why: string }> = [
  { probe: "const later = setTimeout;\nlater(() => {}, 1);", why: "间接引用：先把全局存进变量再调用，判据要求紧跟 `(`" },
  { probe: 'const r = globalThis["Math"].random();', why: "中括号取用：没有字面的 `Math.` 前缀可匹配" },
  { probe: 'import { randomUUID as uuid } from "node:crypto";\nconst id = uuid();', why: "改名导入：记号名整个消失（这一类同时也是双运行时违规，由评审与 workers 测试兜）" },
  { probe: "let cursor = 0;\nexport const next = () => cursor++;", why: "模块级可变状态：不是可 grep 的全局 API（dispatcher.ts 的 `let cursor` 就是这一类，见那里的豁免注释）" },
];

/**
 * **手写的豁免清单。P1/P2 留下的 6 处，P3a 与本修复轮都一处没新增。**
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
  "src/core/keypool-repo.ts :: crypto.subtle ×1",
  "src/core/protocol/anthropic.ts :: crypto.randomUUID ×1",
  "src/core/protocol/responses.ts :: crypto.randomUUID ×1",
  "src/core/registrar/mint.ts :: Math.random ×1",
  "src/core/storage-health.ts :: Date.now ×1",
];

describe("硬约束：src/core 零 IO", () => {
  it("扫描到的使用点恰好等于手写的豁免清单", () => {
    const hits: string[] = [];
    for (const p of walkTs("src/core")) {
      const rel = p.split("\\").join("/");
      for (const label of scanIo(readFileSync(p, "utf8"))) hits.push(`${rel} :: ${label}`);
    }
    expect(
      tally(hits),
      "src/core 的零 IO 豁免清单变了。变长就是在 core 里引入了新的不可重放能力："
      + "先确认它真的无法从构造参数注入，再把它连同理由加进 CORE_IO_EXEMPTIONS，"
      + "别只把这条断言改绿",
    ).toEqual([...CORE_IO_EXEMPTIONS]);
  });

  it.each(COVERED)("声称覆盖的写法真的抓得住：$probe", ({ probe, expect: token }) => {
    // 反向自检。上面那条全绿也可能是因为**正则一个都没匹配上**（写错 flag、写错
    // lookbehind、归一化把源码吃了、walkTs 扫了个空目录）。第一版只有一条笼统的
    // 自检，于是 `globalThis.` 前缀与 `new Date` / `performance.now` 三种最地道的
    // 写法整个隐身而没有任何信号——这条表就是那次翻车的直接产物。
    expect(scanIo(probe)).toContain(token);
  });

  it.each(BLIND_SPOTS)("已知抓不住的写法确实抓不住（边界是断言，不是散文）：$why", ({ probe }) => {
    // 这条变红意味着**有人把这个盲点补上了**——那是好事，把对应的 BLIND_SPOTS 行删掉即可。
    // 它的作用是不让「边界在哪」重新漂成一句没人验证过的散文。
    expect(scanIo(probe)).toEqual([]);
  });

  it("注释里提到的 IO 不算数——这个仓库的注释极其爱复述代码", () => {
    // `refreshable.ts` 开头就写着「不用 Date.now()/setTimeout」。不剥注释的话
    // 那一行会被算成两处违规，而真正的违规反而淹没在噪音里。
    expect(scanIo("// 本文件不用 Date.now()/setTimeout\n/* 也不用 Math.random() */\nexport const x = 1;"))
      .toEqual([]);
  });

  it("注入的端口不算数——deps.fetcher.fetch() / this.o.now() 正是零 IO 想要的形态", () => {
    expect(scanIo("const r = await deps.fetcher.fetch(url);\nconst t = this.o.now();")).toEqual([]);
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
 * **边界（明写，别再宣称成「全部」）**：判据是 `console.(log|warn|error|info|debug)(`，
 * 要求紧跟左括号（否则注释里提一句 `console.warn` 就误报，那是 Task 1 开工时的真实
 * 教训）。`globalThis.console.warn(` 抓得住（没有 lookbehind）；`const c = console;
 * c.warn(…)` 这类间接引用抓不住，留给评审。
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

  it("边界自检：带 globalThis 前缀的抓得住，注释里的提及不算，间接引用抓不住", () => {
    const count = (s: string) => [...stripComments(s).matchAll(CONSOLE_CALL)].length;
    expect(count('globalThis.console.warn("x");'), "globalThis 前缀").toBe(1);
    expect(count("// 这里刻意不用 console.warn(…)"), "注释里的提及").toBe(0);
    expect(count('const c = console;\nc.warn("x");'), "间接引用：已知盲点，留给评审").toBe(0);
  });
});
