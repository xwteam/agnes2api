import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { stripComments, blankComments, stripCssComments, FAIL_KINDS } from "../helpers/strip-comments.js";

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

// ── ② src/adapters、src/http、src/ports、src/ui 的裸 console ─────────────

/**
 * `src/core` 那半边由 `tests/unit/registrar/log-prefix.test.ts` 的
 * 「src/core 全目录零 console……」守着（那里还连带守
 * 五语言 REGISTRAR.md 承诺的 `[registrar]` 前缀契约）。这里守的是 Task 5/6 新增的
 * `src/http/**`（含 `admin/`）与 `src/ui/**`，以及 Task 2（本轮）新加进来的
 * `src/adapters/**` 与 `src/ports/**`。
 *
 * 为什么要扩到 adapters/ports：`storage-kv` / `storage-file` / `fetcher-native` /
 * `mailbox-*` 直接面对 IO 故障，是最容易出现「绕过 sink 的 `console.warn`」的地方，
 * 而原来的扫描范围只有 http 与 ui，一处没扫到。
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
 * ⚠️ **动态属性访问也抓不住**，且这不是假设——`src/adapters/logger-console.ts` 自己
 * 就用 `console[METHOD[e.level]](line)` 按日志级别分发到对应的 console 方法，
 * 这份正则要求字面的 `console.xxx(`，对方括号动态访问束手无策。**这不算漏报进
 * 豁免清单**：实测扫描该文件命中数是 `0`（见下面「边界自检」），所以它压根不出现在
 * `CONSOLE_EXEMPTIONS` 里——豁免清单只登记「扫描抓到、但有理由放行」的调用点，
 * 这一条连「抓到」都没有。之所以能接受，是因为它就是 sink 本身：对它而言 console
 * 是职责，不是绕过；真正要防的是**其他文件**用同样的动态分发去逃避这条门禁，
 * 那种情形与已经登记的「间接引用」是同一类已知盲点，留给评审。
 *
 * **只有 `src/entry/**` 仍整棵树排除**，这是有理由的边界而不是遗漏：那是组装根，
 * 装配失败时连 logger 都还没建起来，此时的诊断输出没有 sink 可走。
 * `src/adapters/logger-console.ts` **不**在这条整树排除名单里——它就在
 * `CONSOLE_SCAN_DIRS` 覆盖的目录内，只是恰好这份正则抓不住它内部那一行。
 */
const CONSOLE_CALL = /console\.(log|warn|error|info|debug)\(/g;

/** 扫描目录。**恰好四条，手写字面量**——见下面的绊线用例，删掉其中任何一条都会变红。 */
const CONSOLE_SCAN_DIRS = ["src/adapters", "src/http", "src/ports", "src/ui"] as const;

/**
 * **手写的豁免清单。** `wire.ts` 那两处打的是「数据目录不可写」的启动诊断：它跑在
 * `buildApp` 里、`/health` 的可写性探测那一步，而那时输出必须无条件可见（Docker 绑定
 * 挂载属主不匹配是最常见的部署事故）。其余一处都不该有。
 *
 * `src/adapters/logger-console.ts` 不在这张表里——理由见上面 `CONSOLE_CALL` 那段注释：
 * 它的调用点是动态属性访问，这份正则本来就抓不到它，加一条「豁免」进来只会让
 * 下面那条相等断言变红（实际扫描结果里根本没有这一行）。
 */
const CONSOLE_EXEMPTIONS: readonly string[] = [
  "src/http/wire.ts :: console ×2",
];

describe("src/adapters、src/http、src/ports、src/ui 里的裸 console", () => {
  it("扫描目录恰好等于手写的四条字面量", () => {
    // **绊线**：把 CONSOLE_SCAN_DIRS 里任何一条删掉，这条用例立刻变红——即使那个
    // 目录今天一个裸 console 都没有（下面那条相等断言不会因为「少扫一个空目录」
    // 而变红，必须单独钉住扫描范围本身）。
    expect([...CONSOLE_SCAN_DIRS]).toEqual(["src/adapters", "src/http", "src/ports", "src/ui"]);
  });

  it("调用点恰好等于手写的豁免清单——绕过注入 Logger 的事件永远进不了面板", () => {
    const hits: string[] = [];
    for (const dir of CONSOLE_SCAN_DIRS) {
      for (const p of walkTs(dir)) {
        // ⚠️ **`src/ui/assets.generated.ts` 是范畴错误意义上的排除，不是遗漏。**
        //
        // 这个文件由 scripts/build-ui.mjs 逐字节生成：它把 admin-ui/ 下每个前端源文件
        // 的整份文本原样塞进一个字符串字面量。Task 3 的 admin-ui/js/i18n.js 里有一处
        // **浏览器控制台**的开发期告警（`localStorage["agnes2api_debug"]` 为真时才打，
        // 生产期不打扰），字面文本 `console.warn(` 随之被逐字节烧进这份生成物。
        //
        // 这条门禁要防的是「服务端事件绕过注入的 Logger、进不了 P3b 事件面板」——
        // 前端自己在用户浏览器里打的 console 是完全不同的东西，与「事件能不能落库」
        // 毫无关系（浏览器控制台从来就不通向服务端事件流）。拿同一份正则去扫一份
        // **内嵌前端字符串**的生成物，抓到的是文本巧合，不是违规调用点。
        //
        // 不把它列进 CONSOLE_EXEMPTIONS：那张表的语义是「真的是一次调用点，但有理由
        // 放行」，而这里连调用点都不是（是字符串数据）——列进去反而会让后人误以为
        // src/ui/assets.generated.ts 里存在一次需要被追认的服务端 console 调用。
        // 前端自己的 console 用法边界写在 admin-ui/README.md，归代码评审管。
        if (p.endsWith("assets.generated.ts")) continue;
        const src = stripComments(readFileSync(p, "utf8"));
        for (const _ of src.matchAll(CONSOLE_CALL)) hits.push(`${p.split("\\").join("/")} :: console`);
      }
    }
    expect(
      tally(hits),
      "src/adapters / src/http / src/ports / src/ui 出现了新的裸 console。事件要能被 "
      + "P3b 的面板消费就必须走注入的 Logger（`logger.log({ level, event, msg, fields })`）；"
      + "确实需要 console 的话，把它连同理由加进 CONSOLE_EXEMPTIONS",
    ).toEqual([...CONSOLE_EXEMPTIONS]);
  });

  /**
   * 上面那条 `continue` 是不是在排除一个空气？**探针钉住它不是死代码**：
   * `src/ui/assets.generated.ts` 里此刻确实含着 admin-ui/js/i18n.js 那一处
   * `console.warn(`（字面文本，见上）。哪天这处前端调试告警被删掉、生成物里
   * 不再出现这个子串，这条会变红——提醒来改的人重新评估那条 `continue` 还要不要留。
   */
  it("排除 assets.generated.ts 不是排除了个空目标——它确实内嵌着前端那处 console.warn", () => {
    const generated = readFileSync("src/ui/assets.generated.ts", "utf8");
    expect(
      [...generated.matchAll(CONSOLE_CALL)].length,
      "生成物里应当至少有一处字面 console.warn(——来自 admin-ui/js/i18n.js 的开发期告警；"
      + "为 0 说明上面那条 continue 已经排除了个空目标，该重新评估是否还需要它",
    ).toBeGreaterThan(0);
  });

  it("边界自检：带 globalThis 前缀的抓得住，注释里的提及不算，间接引用与动态属性访问抓不住", () => {
    const count = (s: string) => [...stripComments(s).matchAll(CONSOLE_CALL)].length;
    expect(count('globalThis.console.warn("x");'), "globalThis 前缀").toBe(1);
    expect(count("// 这里刻意不用 console.warn(…)"), "注释里的提及").toBe(0);
    expect(count('const c = console;\nc.warn("x");'), "间接引用：已知盲点，留给评审").toBe(0);
    // 与 src/adapters/logger-console.ts 里真实的那一行同形：按日志级别动态选方法。
    // 这条确认「它是盲点」不是散文断言——它变红就意味着有人换了更聪明的正则，
    // 到时候上面 CONSOLE_CALL 的边界注释与 CONSOLE_EXEMPTIONS 的说明要一起改。
    expect(count("console[METHOD[e.level]](line);"), "动态属性访问：已知盲点，留给评审").toBe(0);
  });
});

// ── ③ 用正则抠注释的副本 ─────────────────────────────────────────────────────

/**
 * **判据从「按名字」改成「按行为」（P3e Task 1），再从「一种逐字拼法」扩到「一族拼法」（本轮）。**
 *
 * 旧判据是 `OWN_STRIP_DEF`：扫「有没有一个叫 `stripComments` 的定义」。
 * 它**结构上看不见**三份实现同样的东西但取了别的名字的副本（`codeOnly` / `strip` / 匿名内联）
 * ——P3e 开工勘察实测：真源之外有 5 份，旧守卫只登记了 2 份，另外 3 份**永不可见**。
 * 而看不见的那三份里，`codeOnly` 是网络出口扫描的底座，也就是本仓
 * 「面板只打自己 origin」的唯一机器保障。
 *
 * 新判据扫的是**那几条正则字面量本身**：一个文件里只要出现「用正则去抠注释」的那几种拼法，
 * 就是一份新副本。**取名叫什么都躲不掉，躲不掉的是那几条正则的拼法。**
 *
 * ⚠️⚠️ **「取名叫什么都躲不掉」不等于「任何第二份实现都躲不掉」，这两句差得很远。**
 * 上一版这里写的是后者（用例名还写着「新抄一份当场红」），**复评拿 8 种等价写法一试漏了 7 种**：
 * `[^]*?`、`.*?`+`s` 标志、去掉 `?` 的贪婪版、`new RegExp("…")`、以及**行注释那一族**
 *（正则里双斜杠后面接一个「吃到行尾」的匹配器 —— 那正是本任务自称顺带修好的那一族，
 * 再抄一份进来上一版看不见）。**逐字长什么样只写在下面那张 `COPY_SHAPES` 表里，
 * 而且是在运行期拼出来的**：这段注释要是把它复述一遍，本文件当场把自己数成一份副本。
 * 本轮把判据扩到**认得出那 8 种**，并把仍然看不见的形态逐条登记在 `REGEX_STRIP_MISSES` 里
 *（那张表是断言，不是散文）。**别再往这里写全称句。**
 *
 * ⚠️ **`OWN_STRIP_DEF` 那条按名字的正则整条删掉了，不留着当第二判据**：
 * 留着的话 `export { stripComments } from "…"` 这种转导出形态迟早会有人判成副本
 *（实测它今天不匹配转导出），而**判据一旦有两条，宽的那条会赢**。
 */
// 判据是「这个文件的源码里出现了用正则抠注释的那几种拼法」。
// 用**子串**匹配而不是拿正则去匹配正则 —— 后者极易写歪，而且歪了会静默恒绿。
//
// ⚠️⚠️ **这几个针脚刻意在运行期拼出来，不是手滑。** 它们拼出来才是那几条正则的字面文本，
// 于是**本文件的源码里并不含那段字面文本** ⇒ 本文件不会被自己的判据数成一份副本。
// 写成裸字面量的话，这一格就只能靠「按路径排除本文件」活着——而本仓登记过：
// 那种自我排除是一个**真绕过口**（在被排除的文件里嵌一层 `describe`、块作用域手写一份，
// `tsc --noEmit` 通过 + 门禁全绿）。同一条纪律，下面几张表里的探针也全部拼出来。
const BS = "\\";
/** 正则字面量里的块注释开头 / 结尾。 */
const RX_BLOCK_OPEN = BS + "/" + BS + "*";
const RX_BLOCK_CLOSE = BS + "*" + BS + "/";
/** 同一对写进 `new RegExp("…")` 的字符串里时的形态（反斜杠再转义一层）。 */
const STR_BLOCK_OPEN = "/" + BS + BS + "*";
const STR_BLOCK_CLOSE = BS + BS + "*" + "/";
/** 行注释那一族：正则里的双斜杠 **后面紧跟一个「吃到行尾」的匹配器**。 */
const RX_LINE_OPEN = BS + "/" + BS + "/";
const REST_OF_LINE = [".", "[^"] as const;

/**
 * ⚠️ **块注释那一族要求「开头」与「结尾」两个针脚同时在场，不是只看开头。**
 * 反向控制就在 `NOT_COPIES` 里：`scripts/check-comment-refs.mjs` 那一行只**剥掉行首的
 * 注释记号**、不吞内容，它的开头记号后面跟着一个 `+` 量词、结尾记号也是，于是它带着开头针脚
 * 却不带结尾针脚 ⇒ 不算副本。**这条边界很窄**：那一行哪天把两个量词去掉就会被数成副本。
 * 本仓在这个方向上的裁定与 `IO_PATTERNS` 一致——**宁可多报**：多报的代价是评审里加一行豁免，
 * 漏报的代价是这道门禁重新变回摆设。
 * ⚠️ 这段注释刻意**不复述**那几条正则的字面文本：复述一遍本文件就把自己数成一份副本了。
 */
const isRegexStripCopy = (src: string): boolean =>
  (src.includes(RX_BLOCK_OPEN) && src.includes(RX_BLOCK_CLOSE))
  || (src.includes(STR_BLOCK_OPEN) && src.includes(STR_BLOCK_CLOSE))
  || REST_OF_LINE.some((tail) => src.includes(RX_LINE_OPEN + tail));

/**
 * **唯一豁免：真源自己。**
 *
 * 理由**必须写准**：真源 `scripts/lib/strip-comments.mjs` 的文件头里逐字复述了那条正则，
 * 用来解释「正则版为什么不行」。那是**注释里的一句史实**，不是一份实现——
 * 它的实现是逐字符扫描器 `scan()`，唯一一处 `String.prototype.replace` 是
 * `blankComments` 把注释文本换成等长空格那一句，不参与找注释。
 *
 * ⚠️ **不许用「先抠注释再扫」来免掉这条豁免**：那会让这道守卫依赖被测函数自身
 * ——真源坏掉的那一天，它先把自己的证据抠干净，然后报绿。
 * ⚠️ **也不许开第二个文件级豁免**：`scripts/check-comment-refs.mjs` 自己写着
 * 「今天只有一种文件需要文件级豁免」，多开一个就是「开豁免名册比没有规则更糟」。
 * ⇒ 所以 `tests/helpers/strip-comments.ts` 只留一句「实现在真源、正则版为什么不行写在那边」，
 * 它原来逐字复述那条正则的那句史实**搬进了真源的文件头**，而不是给它开第二个豁免。
 */
const REGEX_STRIP_EXEMPT = "scripts/lib/strip-comments.mjs";

/**
 * **扫描范围写死在这里，不许写成「全仓」。**
 *
 * 五条理由，缺一条这道守卫就是坏的：
 * 1. **必须跨出 `tests/`**：旧的那一格用的是 `walkTs("tests")`，而 `walkTs` 只收 `.ts`；
 *    唯一豁免 `scripts/lib/strip-comments.mjs` 是 `.mjs`、在 `scripts/` 下
 *    ⇒ 不扩范围，那条豁免就是**死代码**，「删掉豁免 ⇒ 红并点名真源」永远不会发生。
 *    由下面「扫描范围真的走到了真源那一侧 —— 否则唯一豁免就是死代码」那一格钉着。
 * 2. **必须收 `.mjs` / `.js`**：被收编的五份副本里，`scripts/` 与 `admin-ui/` 那一侧全是
 *    `.mjs`/`.js`，只收 `.ts` 等于对那半个仓库失明。
 * 3. **绝不许把 `docs/` 扫进来**：`docs/design/` 下的历史计划文档正当地逐字复述那条正则，
 *    用来解释「正则版为什么不行」——扫它们等于要求篡改历史记录。
 *    ⚠️⚠️ **挡住 `docs/` 的其实是上面那张扩展名表，不是这张目录表——逐条变异量过，
 *    别把功劳记错地方**：只把 `"docs"` 加进本表、扩展名表不动 ⇒ **全绿、什么都不会发生**
 *   （历史计划文档是 `.md`，收不进来）。两张表**一起**放宽（本表加 `"docs"` 且扩展名表加
 *    `".md"`）才当场红，并点名 `docs/design/2026-08-22-agnes2api-p3e-i18n-and-closeout-plan.md`
 *   （那份文档正文里实测有 5 行含那条正则字面量）。
 *    ⚠️ **这里刻意不写本文件的总格数**：上一版在这句话里写死了一个「31/31」，
 *    而本文件族已经为「把计数写死进注释」漂过三轮。
 *    ⇒ **想收窄这条边界的人必须同时看住两张表**，下面那格另有一条断言直接钉「射程里
 *    不许出现 `docs/` 下的文件」，省得下一个人只改一张表就以为安全。
 * 4. **排除生成物**：`src/ui/assets.generated.ts` 把 admin-ui 整段当字符串嵌进去，
 *    扫它等于把 admin-ui 重复扫一遍（`scripts/check-comment-refs.mjs` 的 `SKIP` 同款理由）。
 *    ⚠️ **这张排除表也有绊线**（见下面那格）：上一版它是一张**没有绊线的豁免名册**——
 *    复评实测把一份真副本的路径加进来 ⇒ **零信号**。同文件的 `CONSOLE_SCAN_DIRS` 早就有
 *    字面量全等绊线，这张当时没有。
 * 5. **仓根那一层散装文件也要收**：上一版的射程只有四个目录，**仓根被漏在外面**——
 *    复评实测把第六份副本写进 `vitest.config.ts` ⇒ **绿、零信号**。
 *    仓根今天有 `vitest.config.ts` 与 `vitest.workers.config.ts` 两个 `.ts`，
 *    它们是真会被人顺手加工具函数的地方。**只收仓根这一层、不递归**：再往下就是
 *    `node_modules` / `dist`，那不是本仓的代码。
 */
const REGEX_STRIP_SCAN_DIRS = ["src", "tests", "scripts", "admin-ui"];
const REGEX_STRIP_SCAN_EXT = [".ts", ".js", ".mjs"];
const REGEX_STRIP_SKIP = ["src/ui/assets.generated.ts"];

/**
 * `walkTs()` 只收 `.ts`，而这道守卫的射程必须收三种扩展名。
 *
 * ⚠️ **另写一个而不是给 `walkTs()` 加参数**：`walkTs()` 现有的**两处**调用点
 *（零 IO 门禁那一格、console 门禁那一格的目录循环；`walkTs` 内部还有一处自递归）
 * 各有自己的射程论证，那些论证都建立在「只收 `.ts`」上，动它等于同时改两道门禁的射程。
 * ⚠️ 上一版这句话写的是「三处」，把 console 门禁那一处数了两遍——**别再照抄它**。
 */
function walkSrc(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walkSrc(p);
    return REGEX_STRIP_SCAN_EXT.some((e) => p.endsWith(e)) ? [p] : [];
  });
}

/** 仓根那一层的散装源文件（不递归，理由见 `REGEX_STRIP_SCAN_DIRS` 第 5 条）。 */
function repoRootFiles(): string[] {
  return readdirSync(".").sort()
    .filter((name) => REGEX_STRIP_SCAN_EXT.some((e) => name.endsWith(e)) && statSync(name).isFile());
}

/** 射程内的全部文件，路径一律用 `/` 分隔。 */
function regexStripScanFiles(): string[] {
  return [...REGEX_STRIP_SCAN_DIRS.flatMap((d) => walkSrc(d)), ...repoRootFiles()]
    .map((p) => p.split("\\").join("/"))
    .filter((rel) => !REGEX_STRIP_SKIP.includes(rel));
}

/**
 * **这张表只许变短、不许变长。**
 *
 * 它记的是「真源之外还有几份用正则抠注释的实现」。P3e Task 1 之前是 5 份（外加
 * `tests/helpers/strip-comments.ts` 文件头里那句复述史实），收编之后**恰好为空**。
 * ⚠️ **空表不等于没有守卫**：下面那一格拿它当期望值逐条比对，抄回第六份当场红并点名。
 */
const OWN_STRIP_COPIES: readonly string[] = [];

describe("用正则抠注释的副本", () => {
  it("射程内不许再有第二份用正则抠注释的实现 —— 块注释那一族与行注释那一族都算", () => {
    const found: string[] = [];
    for (const rel of regexStripScanFiles()) {
      if (rel === REGEX_STRIP_EXEMPT) continue;
      // **不先抠注释**：抠了就等于让这道守卫依赖被测函数自身，真源坏掉那天它会先把
      // 自己的证据抠干净再报绿。代价是「注释里复述那条正则」也算一份副本 —— 那是刻意的，
      // 射程内只有真源那一处需要复述它，别处想讲这段历史请指向真源。
      if (isRegexStripCopy(readFileSync(rel, "utf8"))) found.push(rel);
    }
    expect(
      found.sort(),
      "又有人用正则去抠注释了。**那种写法认不出字符串里的斜杠星号**，"
      + "一行 `admin.use(\"/admin/api/*\", …)` 就能让整道扫描静默变瞎而门禁照常报绿；"
      + "行注释那一族还会把 `\"http://…\"` 里的双斜杠当注释开头吃掉半行。"
      + "本仓裁定：一律 import `scripts/lib/strip-comments.mjs`（测试侧可走"
      + "`tests/helpers/strip-comments.ts` 的转导出）",
    ).toEqual([...OWN_STRIP_COPIES].sort());
  });

  it("排除表恰好等于手写的那一条字面量", () => {
    // **绊线**：上一版 `REGEX_STRIP_SKIP` 是一张**没有绊线的豁免名册**——复评实测：
    // 新写一份逐字副本，再把它的路径加进这张表 ⇒ **绿，零信号**。
    // 同文件的 `CONSOLE_SCAN_DIRS` 早就有字面量全等绊线，这张当时没有，现在补上：
    // 往这张表里加任何一条都会先在这里被拦下，逼加的人在评审里显式表态。
    expect([...REGEX_STRIP_SKIP]).toEqual(["src/ui/assets.generated.ts"]);
  });

  /**
   * **反向自检：扫描范围本身不是空的、而且真的走到了真源那一侧。**
   *
   * 少了这一格，把 `REGEX_STRIP_SCAN_DIRS` 写成 `[]`（或者 `walkSrc()` 写坏成恒返回空数组）
   * 时上面那格**照样绿**——期望值本来就是空表。这是本仓登记在案的第 6 种假阳性形态。
   * 第二条断言另守一件事：**唯一豁免不是死代码**。真源确实命中判据、确实被扫到、
   * 只是被那条豁免放行 ⇒ 把豁免删掉时上面那格会红并点名真源。
   */
  it("扫描范围真的走到了真源那一侧 —— 否则唯一豁免就是死代码", () => {
    const files = regexStripScanFiles();
    expect(files.length, "射程扫了个空 —— 上面那格会恒绿").toBeGreaterThan(200);
    expect(files, "真源不在射程内 ⇒ 那条豁免永远不会被用到").toContain(REGEX_STRIP_EXEMPT);
    expect(
      isRegexStripCopy(readFileSync(REGEX_STRIP_EXEMPT, "utf8")),
      "真源的文件头不再复述那条正则了 ⇒ 那条豁免变成了死代码，请把它删掉",
    ).toBe(true);
    expect(
      files.some((f) => f.endsWith(".mjs")) && files.some((f) => f.endsWith(".js")),
      "射程只收得到 .ts ⇒ 对 scripts/ 与 admin-ui/ 那半个仓库失明",
    ).toBe(true);
    expect(
      files,
      "仓根那一层不在射程里 —— 复评实测把第六份副本写进 `vitest.config.ts` 时零信号",
    ).toContain("vitest.config.ts");
    expect(
      files.filter((f) => f.startsWith("docs/")),
      "`docs/design/` 下的历史计划文档正当地逐字复述那条正则来解释「正则版为什么不行」，"
      + "扫它们等于要求篡改历史记录 —— 目录表与扩展名表**两张一起**放宽才会走到这里，"
      + "所以这条断言直接钉射程本身，别只盯着其中一张表",
    ).toEqual([]);
  });

  /**
   * **这道判据声称认得出的每一种拼法，都有探针钉着。**
   *
   * 这张表就是复评那 8 种「顺手抄一份」写法的直接产物（上一版 8 种漏 7 种）。
   * 加判据时**必须同时往这里加一行**；这张表不是文档，它是断言。
   *
   * ⚠️ **探针一律在运行期拼出来，不写字面量**，理由与上面 `BS` 那段 ⚠️⚠️ 逐字相同：
   * 写成字面量的话本文件就会被自己的判据数成一份副本。
   */
  const COPY_SHAPES: ReadonlyArray<{ why: string; body: string }> = [
    { why: "块注释族·本仓五份副本的原形态（惰性 [\\s\\S]*?）", body: `s.replace(/${RX_BLOCK_OPEN}[${BS}s${BS}S]*?${RX_BLOCK_CLOSE}/g, "")` },
    { why: "块注释族·[^]*?（与 [\\s\\S] 等价，不是「专门绕」）", body: `s.replace(/${RX_BLOCK_OPEN}[^]*?${RX_BLOCK_CLOSE}/g, "")` },
    { why: "块注释族·.*? 配 s 标志", body: `s.replace(/${RX_BLOCK_OPEN}.*?${RX_BLOCK_CLOSE}/gs, "")` },
    { why: "块注释族·(?:.|\\n)*?", body: `s.replace(/${RX_BLOCK_OPEN}(?:.|${BS}n)*?${RX_BLOCK_CLOSE}/g, "")` },
    { why: "块注释族·去掉那个 ? 的贪婪版", body: `s.replace(/${RX_BLOCK_OPEN}[${BS}s${BS}S]*${RX_BLOCK_CLOSE}/g, "")` },
    { why: "块注释族·new RegExp 字符串构造", body: `s.replace(new RegExp("${STR_BLOCK_OPEN}[${BS}${BS}s${BS}${BS}S]*?${STR_BLOCK_CLOSE}", "g"), "")` },
    { why: "行注释族·.*$ 配 m 标志（正是本任务自称顺带修好的那一族）", body: `s.replace(/${RX_LINE_OPEN}.*$/gm, "")` },
    { why: "行注释族·[^\\n]* 字符组版", body: `s.replace(/${RX_LINE_OPEN}[^${BS}n]*/g, "")` },
    { why: "块 + 行两条一起（收编前 fake-dom 那份副本的形态）", body: `s.replace(/${RX_BLOCK_OPEN}[^]*?${RX_BLOCK_CLOSE}/g, "").replace(/${RX_LINE_OPEN}.*$/gm, "")` },
  ];

  /**
   * **这道判据看不见的写法，同样每一条都有探针钉着。**
   *
   * 与 `BLIND_SPOTS` 是同一条纪律：写成会变红的断言而不是一句「本判据并不完备」。
   * 将来谁把某一条补上了，对应的用例会变红，逼他把这一行删掉——于是「边界在哪」永远
   * 与实现同步，**不会再漂成用例名里那句「新抄一份当场红」那样的全称句**。
   *
   * 为什么接受这几条：它们都不是「顺手抄一份」的形态（而后者正是本仓栽过五次的那一种），
   * 要么得先把正则拆成碎片再拼、要么压根不用正则。这一档留给代码评审，
   * 另有真源那两格行为断言 + 三格毒刺探针 + 下面第 ④ 节的扫描器边界一起兜。
   */
  const REGEX_STRIP_MISSES: ReadonlyArray<{ why: string; body: string }> = [
    { why: "把记号拆成碎片再拼：判据是子串匹配，拼接后的字面量里没有完整针脚", body: `const OPEN = "/" + "*"; const parts = s.split(OPEN);` },
    { why: "压根不用正则：手搓一个逐字符状态机（而且漏了引号分支）", body: `for (let i = 0; i < s.length; i++) { if (s[i] === "/" && s[i + 1] === "*") { skip(); } }` },
    { why: "用 Unicode 转义写出同一条正则", body: `s.replace(/${BS}u002F${BS}u002A[^]*?${BS}u002A${BS}u002F/g, "")` },
  ];

  /**
   * **反向控制：正当的写法不许被误判成副本。**
   *
   * 第三条与第四条是**仓里真实存在的形态**，不是想出来的：
   * · `/^https?:\/\//` 这类协议匹配（`admin-ui/js/pure/playground.mjs` 等三个文件里有），
   *   它带着双斜杠但后面跟的是正则结束符，不是「吃到行尾」的匹配器；
   * · `scripts/check-comment-refs.mjs` 里那条**只剥行首注释记号、不吞内容**的正则，
   *   它带着块注释开头针脚却不带结尾针脚。
   * 少了这两条，把判据放宽一点就会把它们误红，而误红的代价是下一个人去改判据把它调松，
   * 松到最后又变回摆设。
   */
  const NOT_COPIES: ReadonlyArray<{ why: string; body: string }> = [
    { why: "正当的 import 消费者不是副本", body: 'import { stripComments } from "../helpers/strip-comments.js";' },
    { why: "调用它不是副本", body: 'const code = stripComments(readFileSync(p, "utf8"));' },
    { why: "协议匹配的正则里也有双斜杠，但后面不是「吃到行尾」的匹配器", body: `const isAbs = /^https?:${BS}/${BS}//.test(u);` },
    { why: "只剥行首注释记号、不吞内容（check-comment-refs.mjs 真实那一行）", body: `t.replace(/^${BS}s*(?:${RX_BLOCK_OPEN}+|${BS}*+${BS}/|${BS}*|${RX_LINE_OPEN})/gm, " ")` },
  ];

  /**
   * **多报的那一侧，也登记成断言。**
   *
   * 行注释那一族的针脚是「正则里的双斜杠 + 一个吃到行尾的匹配器」，
   * 而一条**带路径的 URL 正则**恰好也长这样 ⇒ **会被多报**。
   * 实测：射程 259 个文件里含裸双斜杠转义的有 4 个，**会被多报的 0 个**——
   * 今天这一档是空的，所以它是「将来可能踩到」而不是「现在就在骗人」。
   *
   * 为什么接受多报而不去收窄：本仓在这个方向上的裁定与 `IO_PATTERNS` 一致——
   * 多报的代价是**门禁红、点名那个文件、评审里判一次**（一次评审动作），
   * 漏报的代价是这道门禁重新变回摆设。**多报不是致盲方向。**
   * ⚠️ 真踩到时正确的做法是**在这张表里加一行并写清理由**，
   * 不是把针脚调松到连行注释那一族一起放走。
   */
  const OVER_REPORTED: ReadonlyArray<{ why: string; body: string }> = [
    { why: "带路径的 URL 正则（`https?://` 后面接一个吃到行尾的匹配器）会被数成副本", body: `const m = /https?:${BS}/${BS}/.*${BS}.png/.exec(u);` },
    { why: "同上，字符组版", body: `const m = /https?:${BS}/${BS}/[^ ]+/.exec(u);` },
  ];

  it.each(COPY_SHAPES)("认得出的拼法：$why", ({ body }) => {
    expect(isRegexStripCopy(`const strip = (s: string) => ${body};`)).toBe(true);
  });

  it.each(REGEX_STRIP_MISSES)("已知看不见的写法确实看不见（边界是断言，不是散文）：$why", ({ body }) => {
    // 这条变红意味着**有人把这个盲点补上了**——那是好事，把对应的 REGEX_STRIP_MISSES 行删掉即可。
    expect(isRegexStripCopy(`const strip = (s: string) => { ${body} };`)).toBe(false);
  });

  it.each(NOT_COPIES)("不乱红：$why", ({ body }) => {
    expect(isRegexStripCopy(`const x = 1;\n${body}\n`)).toBe(false);
  });

  it.each(OVER_REPORTED)("已知会多报（边界是断言，不是散文）：$why", ({ body }) => {
    // 这条变红意味着**有人把针脚收窄了**——先确认收窄之后行注释那一族还认得出
    //（上面 `COPY_SHAPES` 里那两条），再把这一行删掉。
    expect(isRegexStripCopy(`const x = 1;\n${body}\n`)).toBe(true);
  });

});

/**
 * **真源交出来的三个出口，各自的语义就是它们分叉的那一件事。**
 *
 * `blankComments` 今天在本仓还没有消费者（`tests/ui/api-session.test.ts` 的
 * `braceInterpLines()` 是 P3e Task 2 的活），**所以它更需要这一格**：一个没有任何断言的
 * 导出等于一份没人验过的实现，等 Task 2 接上它的时候，错的那一版会安静地赢。
 */
describe("抠注释真源的三个出口", () => {
  const poisoned = [
    'const ADMIN_API_GLOB = "/admin/api/*";',
    "const n = 1;",
    "/* 提供闭合记号的普通块注释 */",
  ].join("\n");

  it("stripComments 把注释删掉，而字符串里的斜杠星号不是注释", () => {
    expect(stripComments(poisoned), "毒刺那一行必须原样还在").toContain('"/admin/api/*"');
    expect(stripComments(poisoned), "中间那行真代码不许被吞").toContain("const n = 1;");
    expect(stripComments(poisoned), "块注释必须被删掉").not.toContain("提供闭合记号");
  });

  it("blankComments 保住行号与列位置 —— 注释逐字符换成空格、换行原样留着", () => {
    const blanked = blankComments(poisoned);
    expect(blanked.split("\n"), "行数变了就等于行号错位").toHaveLength(3);
    expect(blanked.split("\n")[0], "非注释行必须逐字节原样").toBe('const ADMIN_API_GLOB = "/admin/api/*";');
    expect(blanked.split("\n")[2], "注释那一行必须换成等长的空格").toBe(" ".repeat("/* 提供闭合记号的普通块注释 */".length));
    expect(blanked.length, "总长度必须与原文一致 —— 列位置才不会漂").toBe(poisoned.length);
  });

  it("stripCssComments 抠掉块注释、但不认双斜杠 —— CSS 没有行注释", () => {
    const css = ".a{background:url(//cdn.example/x.png)} /* 抠掉我 */ .b{color:red}";
    expect(stripCssComments(css), "块注释必须被抠掉").not.toContain("抠掉我");
    expect(stripCssComments(css), "`url(//…)` 之后的样式不许被当行注释吃掉").toContain(".b{color:red}");
    // 反向控制：JS 那一档确实会吃掉它 —— 两个出口不是同一件事，方言之分不是摆设。
    expect(stripComments(css), "JS 语义把双斜杠之后吃到行尾，这正是 CSS 侧不能用它的理由")
      .not.toContain(".b{color:red}");
  });

  /**
   * **报文也分方言：别给下一个人指一条不存在的路。**
   *
   * 「字符串没在本行内闭合」这一档两个方言共用，但**成因不共用**：JS 侧最常见的成因是
   * 上游某条正则字面量里带了奇数个引号，而 CSS 这一档**压根没有正则字面量**。
   * 第二轮复评点到的就是这半句。
   */
  it("CSS 侧的失步报文不许提正则字面量 —— 那一档在 CSS 里不存在", () => {
    const brokenCss = '.a{content:"没有闭合\n}';
    expect(() => stripCssComments(brokenCss)).toThrow("失步");
    try {
      stripCssComments(brokenCss);
    } catch (e) {
      expect((e as Error).message, "CSS 这一档没有正则字面量，写进报文等于指错路")
        .not.toContain("正则字面量");
    }
    // 反向控制：JS 那一侧的同款报文**必须**仍然点名正则字面量 —— 那确实是它最常见的成因。
    try {
      stripComments('const a = "没有闭合\nconst b = 1;');
    } catch (e) {
      expect((e as Error).message, "JS 侧删掉这半句就等于把最常见的成因藏起来")
        .toContain("正则字面量");
    }
  });
});

// ── ④ 抠注释真源的扫描器边界 ────────────────────────────────────────────────

/**
 * **这一节是 P3e Task 1 复评那条 CRITICAL 的直接产物，读完再改。**
 *
 * 上一版真源逐字符扫，但**不认正则字面量**，而且它的「边界明写」段把危害判据写错了
 *（写的是「正则里带斜杠星号」，真判据是「正则里有奇数个引号」与 `\/`+`/`）。后果实测：
 * · 一条 `/[\s="]/`（`src/adapters/logger-console.ts` 里就有）让字符串/代码的奇偶性翻过来，
 *   之后一个真字符串的内部被当成代码、里面的斜杠星号重新变成块注释开头 ⇒ **真代码被吞**。
 *   复评在那个文件里放了一个裸 `console.log`：负责它的那道门禁**报绿**，`pnpm test` 全绿。
 * · `/^data:image\//i` 这种正则里的转义斜杠紧跟结束符被当成行注释开头，**吃到行尾**
 *  （`admin-ui/js/pure/playground.mjs` 里就有，而那个目录是四道叶子扫描的射程）。
 *
 * ⚠️ **「今天没有入口」不等于「不严重」。** 上一版把这条记成「危害档位：今天为零」，
 * 实测是**射程内 14 个文件失步、225 段假字符串**。本仓裁定：**写登记时危害档位也要实测**，
 * 降级式登记比不登记更坏——后面的人会拿它当「已评估过」。
 *
 * ⇒ 下面第一格就是那次普查的**复量方法本身**，不是报告里的一次性数字：
 * 它逐文件跑真源，把抛出来的落点收成一张表，期望值是空表。今天它扫 259 个文件、零抛出；
 * 回到上一版实现的话它会红并逐条点名那 14 个文件。
 *
 * ⚠️⚠️ **第二轮复评又在同一格上打了一次脸，改这一格之前把这段读完。**
 * 那一版这一格只有三条不变量（不抛 / 不改长度 / 不改行数 / 不比原文长），
 * 而它们对**「吞掉真代码」全瞎**：`n++ / 2` 那一族判反之后误开的块注释一路吞到文件尾，
 * `blankComments` 换等长空格、换行原样保留 ⇒ **三条全过，而真代码没了**
 *（本轮复量：`src/ports/logger.ts` 上多吞 25 字节，那个裸 `console.log` 一起没了）。
 * 「判不准就吵」那几档也一档都拦不到——它们拦的是「判不准」，这一族是「判错了但很确信」。
 *
 * ⚠️⚠️ **第三轮复评把「本轮加了两层网」这句话也打掉了，别再把这一格写成一层网。**
 * 上一版在这里加了第四条不变量 `commentSpanFaults()`（「被抠掉的每一段在原文里必须长得像
 * 一条形态完整的注释」），并把它与下面的对拍格并称「两层网」。复评实测：
 * **把 `commentSpanFaults()` 整体中和成 `return []`，全量 `pnpm test` 126 files / 2828 passed
 * —— 零信号。** 它被真源那条「块注释开了没闭合」完全支配（那一支在 `scan()` 里先抛，
 * 检查器根本拿不到那份 `blanked`），而误开的是 `//` 行注释时它永远不红
 *（行注释「到行尾为止」在原文里恒为形态完整）——第三轮那条端到端正是这一族。
 * ⇒ **本轮把它删掉了**，理由是本仓那条规矩：一条永远不触发的防御和没有防御在证据上要分辨得出来，
 * 而它今天分辨不出来；留着它的唯一后果是下一个人以为「这里已经接好了」。
 * 它原本想接的那个后果，现在由真源里的 `openerLivesInString()`（后果层，不盯符号）
 * 与下面「全射程与真解析器对拍」那一格接。**这一格剩下的三条不变量请当成便宜的形态自检，
 * 不要当成网。**
 */

describe("抠注释真源的扫描器边界", () => {
  it("射程内每个文件都扫得完 —— 一个失步都不许有", () => {
    // 判据与复评那次普查逐字相同：单双引号字符串不许跨行，跨行即失步。
    // 新真源把这条判据做进了扫描器本身（失步当场抛，不静默按某一种解释走下去），
    // 所以这里不需要第二份普查器 —— **那正是本任务要消灭的东西**。
    // ⚠️「假字符串**段数**」这个量在新语义下不存在了：失步的第一处就抛，不会再攒出第二段。
    const broken: string[] = [];
    const files = regexStripScanFiles();
    for (const rel of files) {
      const src = readFileSync(rel, "utf8");
      try {
        const stripped = stripComments(src);
        const blanked = blankComments(src);
        // 顺带把 `blankComments` 的行列不变量也钉在同一遍里：它是按行号/列位置扫的
        // 消费者（Task 2 的 `braceInterpLines()`）的全部前提。
        if (blanked.length !== src.length) broken.push(`${rel} :: blankComments 改了总长度`);
        if (blanked.split("\n").length !== src.split("\n").length) broken.push(`${rel} :: blankComments 改了行数`);
        if (stripped.length > src.length) broken.push(`${rel} :: stripComments 输出比原文还长`);
        // ⚠️ 这三条对「吞掉真代码」全瞎，别在这里再加第四条形态自检了（见本节第二段 ⚠️⚠️：
        // 上一版加过一条，实测是恒绿）。真正接住那一族的是真源的 `openerLivesInString()`
        // 与下面「射程内每个文件：抠注释不许改变程序本身」那一格。
      } catch (e) {
        broken.push(`${rel} :: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    expect(files.length, "射程扫了个空 —— 这一格会恒绿").toBeGreaterThan(200);
    expect(
      broken,
      "抠注释真源在射程内的某些文件上失步了。**这不是「量具红了」，这是致盲**："
      + "失步之后一个真字符串的内部会被当成代码，里面的斜杠星号重新变成块注释开头，"
      + "真代码整段脱离扫描而所有下游门禁照常报绿。请去真源的正则/字符串判据里补这一档，"
      + "**别在调用方加 try/catch 把它吞掉**",
    ).toEqual([]);
  });

  /**
   * **反向控制：这个扫描器认得出该认的，也确实会对判不准的当场吵。**
   *
   * 上面那格是「零」——而**一条恒等于零的断言与一条坏掉的断言长得一模一样**。
   * 这张表逐条证明：那些形状真的会被认出来 / 真的会抛。
   */
  it.each([
    [
      "正则里的奇数个引号不再翻转奇偶性（`src/adapters/logger-console.ts` 真实那一行）",
      'const q = (s: string) => s === "" || /[\\s="]/.test(s);\nconst GLOB = "/admin/api/*";\nconsole.log(1);\n/* 闭合 */',
      "console.log(1);",
    ],
    [
      "正则里的转义斜杠紧跟结束符不再被当行注释（`admin-ui/js/pure/playground.mjs` 真实那一行）",
      'const isImg = (url: string) => typeof url === "string" && /^data:image\\//i.test(url);',
      ".test(url);",
    ],
    [
      "除法不许被当成正则开头吞掉后面的代码（`src/core/dispatcher.ts` 真实那一行）",
      "const sec = Math.max(1, Math.ceil((earliest - now) / 1000));\nconst n = 1;",
      "const n = 1;",
    ],
    [
      "控制流头部的 `)` 后面确实是正则位",
      'if (ok) /["*]/.test(s);\nconst GLOB = "/admin/api/*";\nconst n = 1;\n/* 闭合 */',
      "const n = 1;",
    ],
    [
      "字符组里的裸斜杠不是正则结束符（`/[/*]/` 这种）",
      'const re = /[/*"]/;\nconst GLOB = "/admin/api/*";\nconst n = 1;\n/* 闭合 */',
      "const n = 1;",
    ],
    [
      "模板字面量里嵌模板：`${}` 的每一层都当代码扫，反引号靠栈配对不靠奇偶",
      'const s = `a${ f(`b${ g("/admin/api/*") }c`) }d`;\nconst n = 1;\n/* 闭合 */',
      "const n = 1;",
    ],
    // ↓ 这四条是第二轮复评那条 HIGH 的直接产物：**后缀运算符之后的除法**。
    //   上一版按单个字符看前一个 token，`+`/`-`/`!` 都在「前缀位 ⇒ 正则开头」那张表里，
    //   于是这一族整族被判反、静默吞掉真代码（复评实测 `n++ / 2` 那一行吞 20 字节）。
    //   毒刺 `"/admin/api/*"` 必须在场：判反之后正是它提供那个「重开块注释」的斜杠星号。
    [
      "后缀自增之后的斜杠是除法（`i++ / total` 是再普通不过的一行 JS）",
      'let n = 1;\nconst r = n++ / 2; const GLOB = "/admin/api/*";\nconst keep = 1;\n/* 闭合 */',
      "const keep = 1;",
    ],
    [
      "后缀自减之后的斜杠是除法",
      'let n = 2;\nconst r = n-- / 2; const GLOB = "/admin/api/*";\nconst keep = 1;\n/* 闭合 */',
      "const keep = 1;",
    ],
    [
      "TS 非空断言之后的斜杠是除法（`x! / 2`，`!` 与逻辑非同一个字符）",
      'const a = { b: 1 };\nconst r = a!.b! / 2; const GLOB = "/admin/api/*";\nconst keep = 1;\n/* 闭合 */',
      "const keep = 1;",
    ],
    [
      "**反向控制**：前缀位的逻辑非后面仍然是正则开头（`if (!/^a/.test(s))` 这种写法仓里到处都是）",
      'const s = "x";\nif (!/^a\\/b/.test(s)) { const GLOB = "/admin/api/*"; }\nconst keep = 1;\n/* 闭合 */',
      "const keep = 1;",
    ],
    // ↓ 这三条是第三轮复评那条 CRITICAL 的直接产物：**箭头 `=>` 的 `>` 与类型实参表收尾的 `>`**。
    //   上一版把 `>` 整个塞进「前缀位 ⇒ 正则开头」那张表（理由是箭头之后确实是正则位），
    //   于是 `x as Array<T> / 2` / `f<number> / 2` / `x satisfies X<Y> / 2` 整族判反。
    //   现在 `>` 单独走一档：前一个字符是 `=` ⇒ 箭头 ⇒ 正则位。这三条钉的是**正则位那一半**
    //  （除法位那一半是「抛」，钉在下面「判不准要吵」那张表的 `angleAfterValue` 那一行）。
    [
      "箭头函数之后仍然是正则位（`() => /re/.test(x)` 仓里到处都是）",
      'const f = () => /^a\\/b/.test(x);\nconst GLOB = "/admin/api/*";\nconst keep = 1;\n/* 闭合 */',
      "const keep = 1;",
    ],
    [
      "泛型箭头（`<T,>(x: T) => /re/`）里那两个 `>` 是两回事，只有紧挨 `=` 的那个是箭头",
      'const h = <T,>(x: T) => /x/.test(String(x));\nconst GLOB = "/admin/api/*";\nconst keep = 1;\n/* 闭合 */',
      "const keep = 1;",
    ],
    [
      "**反向控制**：`>=` 之后仍然是正则位（那个 `>` 不是箭头的一半，判据看的是它**前面**那个字符）",
      'const a = 1;\nif (a >= /x/.test("y") ? 1 : 0) { const GLOB = "/admin/api/*"; }\nconst keep = 1;\n/* 闭合 */',
      "const keep = 1;",
    ],
  ])("认得出：%s", (_why, src, mustKeep) => {
    expect(stripComments(src as string)).toContain(mustKeep as string);
  });

  /**
   * **后缀运算符那一族：逐字节原样，不是「只要留下那句话就算过」。**
   *
   * 上面那张表用的是 `toContain`，而**被吞的字节可能落在别处**（复评那三条实测里，
   * 被吞的是毒刺与它后面的一整段）。这一格把同一族的输入按「零注释 ⇒ 输出必须逐字节等于原文」
   * 钉死：少一个字节都是致盲。
   */
  it.each([
    ["后缀自增", 'let n = 1; const r = n++ / 2; const GLOB = "/admin/api/*"; const keep = 1;'],
    ["后缀自减", 'let n = 2; const r = n-- / 2; const GLOB = "/admin/api/*"; const keep = 1;'],
    ["非空断言", 'const a = { b: 1 }; const r = a!.b! / 2; const GLOB = "/admin/api/*"; const keep = 1;'],
    ["前缀自增（`++i / 2` 里那个斜杠同样是除法）", 'let i = 0; const r = ++i / 2; const GLOB = "/admin/api/*"; const keep = 1;'],
    ["比较运算符 `!==` 后面仍是正则位", 'const a = 1; if (a !== /x/.test("y")) { const keep = 1; }'],
    ["箭头之后的正则（`=>` 那个 `>`）", 'const f = () => /re/.test(x); const GLOB = "/admin/api/*"; const keep = 1;'],
    ["实例化表达式调用之后的除法（`f<number>() / 2`，`)` 才是前一个 token）", 'const r = f<number>() / 2; const GLOB = "/admin/api/*"; const keep = 1;'],
    ["右移之后的除法（`a >> 2 / 3` 里前一个 token 是数字，不是 `>`）", 'const a = 8; const r = a >> 2 / 3; const GLOB = "/admin/api/*"; const keep = 1;'],
  ])("一个字节都不许吞：%s", (_why, src) => {
    expect(stripComments(src as string), "这一行里一个注释都没有 ⇒ 输出必须逐字节等于原文").toBe(src as string);
  });

  it("反向控制：真注释还是要被抠掉 —— 别把它修成「什么都不抠」", () => {
    expect(stripComments("const n = 1; // 抠掉我\n/* 也抠掉我 */\nconst m = 2;"))
      .toBe("const n = 1; \n\nconst m = 2;");
  });

  /**
   * **判不准要吵；判错了也要吵 —— 这两件事不是一回事，第二轮复评就栽在这。**
   *
   * 正则 vs 除法是真歧义，这个扫描器**不假装能完美区分**。判据覆盖不到的那几档一律抛。
   * 但**「判不准就吵」拦不住「判错了但很确信」**：`n++ / 2` 那一族被判成正则位时扫描器
   * 一个字都不吵，静默把真代码当注释吞掉，而当时那几档一档都没资格开口。
   * ⇒ 下面这张表分两族：**「我不知道」**（判据够不着）与**「我刚才那一步不可能对」**
   *（后果层兜底）。⚠️ **别在这里写「前 N 条 / 后 N 条」**——本文件族已经为「把计数写进散文」
   * 漂过五轮，每一行自己的第四列写着它属于哪一档，那是断言。
   *
   * ⚠️ **这张表就是清单本身，别再往哪句注释里写「今天会抛的 N 档」**：
   * 上一版这里写着「这三档」而表里是四条、真源写的是「四档」——本文件族第四次为
   * 「把计数写死进注释」漂移。**计数只许以断言的形式存在**，而且**只许走运行期**：
   * 每一行第四列写的是它期望打到的档名（真源 `FAIL_KINDS` 里的名字），下面那一格
   * 把**运行期收上来的 `err.kind` 集合**与 `FAIL_KINDS` 对齐。
   *
   * ⚠️ 这几档在射程内的命中情况**不写死在注释里**：上面「射程内每个文件都扫得完」那一格
   * 期望空表，它绿着就是零命中，红了就会逐条点名。
   */
  const SHOUT_CASES: ReadonlyArray<readonly [string, string, string, string]> = [
    [
      "`>` 后面的裸斜杠：箭头 `=>` 之后是正则位、TS 类型实参表收尾之后是除法位，分不出",
      'const r = f<number> / 2; const GLOB = "/admin/api/*"; const keep = 1;',
      "不是箭头",
      "angleAfterValue",
    ],
    ["`}` 后面的裸斜杠：块结束是正则位、对象字面量结束是除法位，分不出", "const f = function () {}\n/x/.test(s);", "判不准", "braceSlash"],
    ["字符串没在本行内闭合 ⇒ 扫描器已经失步", 'const a = "没有闭合\nconst b = 1;', "失步", "unclosedString"],
    ["正则字面量没在本行内闭合 ⇒ 判据把一个除法号当成了正则开头", "const a = (1 + 2);\nconst b = /没有闭合\nconst c = 1;", "没有在本行内闭合", "unclosedRegex"],
    ["前一个有意义字符不在真源那两张判据表里 —— 宁可吵也不许猜", "const a = 1;\n@ /x/;", "两张判据表", "unknownPunct"],
    // ↓ 后果层：它们盯的是「真代码被当注释吞掉」这个后果，不是某几个符号。
    //   ⚠️ 前三条**意图对、落地仍然在盯符号**（盯 flag 字母、盯 `/*`、盯反引号），
    //   第三轮复评实测它们对 `>` 那一族**一条都没接住**（端到端：门禁当场变瞎）。
    //   最后一条 `openerInString` 才是不盯符号的那一条：它只问「这个注释开头，
    //   按本行引号收支独立重算，是不是住在一个字符串里」。
    [
      "判成正则之后引擎不认这条正则 ⇒ 判错了（`n++ / 2` 判反之后留下的正是这个现场）",
      'let n = 1;\nconst r = n + / 2; const GLOB = "/admin/api/*"; const keep = 1;',
      "引擎不认",
      "badRegex",
    ],
    ["块注释开了没有闭合记号，一路吞到文件尾", "const a = 1;\n/* 没有闭合记号", "吞到文件尾", "unclosedBlock"],
    ["扫到文件尾模板栈还没平衡（反引号没配对 / `${` 没闭合 / 插值里花括号数不平）", "const s = `abc;\nconst n = 1;", "还没平衡", "tmplUnbalanced"],
    [
      // 这一行的输入**没有用任何一个本轮修过的符号**：`of` 是一个完全合法的标识符，
      // 而它同时在真源的 `REGEX_AFTER_WORD` 里（`for (x of y)` 的那个 `of`）
      // ⇒ `of / 2` 被判成正则位。这是一个**没人在修**的判反，用它当探针正是为了证明
      // 这一档接的是后果不是符号：判反之后 `"https://x"` 里的双斜杠变成行注释开头，
      // 而独立重算说「这个开头住在一个字符串里」⇒ 当场红。
      "注释开头按独立重算住在一个字符串里 ⇒ 上游判反了（`of` 当标识符那一族）",
      'const of = 4; const half = of / 2; const P = "/"; const U = "https://x"; console.log(1);',
      "住在一个字符串里",
      "openerInString",
    ],
  ];

  it.each(SHOUT_CASES)("判不准要吵：%s", (_why, src, needle, kind) => {
    expect(() => stripComments(src)).toThrow(needle);
    // 消息里必须带上原文那一行，否则「吵」了也没人知道吵的是哪一行；
    // 档名必须是期望的那一个，否则这条探针验的是另一档（那等于这一档没人验过）。
    try {
      stripComments(src);
    } catch (e) {
      expect((e as Error).message, "抛出来的消息里必须逐字带上原文").toContain("原文：");
      expect((e as { kind?: string }).kind, "这条探针打到的不是它声称的那一档").toBe(kind);
    }
  });

  /**
   * **反向控制：这几条绊线不许乱红。**
   *
   * 「我认得出 X」的断言必须配一条「我对 X 不乱红」的——尤其是后果层那一族：
   * 它们一旦误伤，代价是每一个含正则/模板/块注释的正当文件都抛，那比没有更糟。
   * 大反向控制是上面那格（射程 259 个文件零抛出），这里补的是**最容易误伤的那几种形态**。
   * ⚠️ 本轮新加的 `openerInString` 那一档**确实有一种会误伤的形态**，它没有藏起来：
   * 见下面「已知误伤：两条各含奇数个引号的正则夹着一段注释 ⇒ 独立重算会假红」那一格。
   */
  it.each([
    ["字符组里的裸斜杠与引号（`/[/*\"]/`）是一条合法正则", 'const re = /[/*"]/;'],
    ["协议匹配里的转义斜杠（仓里三个文件的真实形态）", "const isAbs = /^https?:\\/\\//.test(u);"],
    ["Unicode 属性转义要 `u` 标志才合法 —— 带着标志一起验才不会误伤", "const re = /\\p{L}+/u;"],
    ["带 lookbehind 的真实规则（`IO_PATTERNS` 里那一条的形态）", "const re = /(?<![.\\w])set(?:Timeout|Interval|Immediate)\\s*\\(/g;"],
    ["块注释正常闭合在文件最后一个字节上", "const a = 1;\n/* 闭合了 */"],
    ["模板里嵌模板、插值里再嵌模板，栈最终是平的", "const s = `a${ f(`b${ g(1) }c`) }d`;"],
    ["带标签模板", "const s = tag`a${b}c`;"],
    // ↓ 这三条专打本轮新加的 `openerInString`：字符串里的双斜杠 + 同行一段正当注释，
    //   是本仓最常见的形态（`admin-ui/js/i18n-dict.js` 里成片都是），它一次都不许红。
    ["字符串里的双斜杠之后跟一段正当行注释", 'const U = "https://cdn.example/x"; // 正当注释'],
    ["块注释体内含一个完整的网址", 'const a = 1; /* 见 "https://cdn.example/x" */ const b = 2;'],
    ["同一行上两个字符串夹一段块注释", 'const a = "x"; /* c */ const b = "y";'],
  ])("不乱红：%s", (_why, src) => {
    expect(() => stripComments(src)).not.toThrow();
  });

  /**
   * **计数只许以断言的形式存在，而且只许走运行期。**
   *
   * ⚠️⚠️ **上一版数的是真源里 `fail` 加左括号加 `src, ` 那串字面文本，第三轮复评实测它三面漏风，
   * 别再改回去。**
   * · **格式一变就干净逃逸**：把逗号后的空格删掉、或者把参数换行写，
   *   两条新绊线可以完全绕过那个正则（复评实测：守卫数到 7、真实 9、87 格全绿）。
   * · **散文假红**：真源注释里只要出现那串字面文本就会被数进来（复评实测：数到 8、真实 7，
   *   而且报文说「加了一档就必须加一行」——指错了地方）。
   * · 它守的是「真源里这串字符出现了几次」，**不是「有几个抛出点」**。
   *
   * 现在换成运行期：真源每个抛出点都带一个档名（`err.kind`，登记处是真源的 `FAIL_KINDS`），
   * 这一格把上面那张探针表逐条跑一遍、把收到的档名收成集合，要求
   *   收到的档集合 == `FAIL_KINDS` 集合，且 `FAIL_KINDS.length` == 探针行数。
   * ⇒ 往真源加一档：`fail()` 会先要求它登记进 `FAIL_KINDS`（没登记直接内部错误），
   *   登记了而不来这张表加一行探针 ⇒ 长度对不上 **且** 那一档没出现在收到的集合里 ⇒ 当场红。
   * ⇒ 加探针而不加档（探针打到了别的档）⇒ 上面那一格的 `err.kind` 断言当场红。
   * **写法、空白、换行、注释里的字面文本，一律与这一格无关。**
   *（本轮实测：真源里那串字面文本今天出现 11 次而档只有 9 个——旧那一版会当场假红，
   *  这一版一声不吭；而复评那两条「干净逃逸」的写法在这一版当场红。）
   *
   * ⚠️ **它剩下的那个洞，写在这里而不是藏起来**：往真源加一档、**而且那一档永远走不到**、
   * **而且不登记进 `FAIL_KINDS`** ⇒ 这一格看不见它。但那一档在定义上是**死代码**，
   * 且它第一次真的被走到时 `fail()` 当场内部错误（「没有登记进 FAIL_KINDS」）。
   * 旧那一版的洞是**可达的抛出点**能干净逃逸，两者不是一个量级。
   */
  it("每一档抛出都必须有探针打到 —— 运行期收档名，不数字面文本", () => {
    const seen: string[] = [];
    for (const [, src] of SHOUT_CASES) {
      try {
        stripComments(src);
        throw new Error(`这条探针没抛：${src.slice(0, 40)}`);
      } catch (e) {
        const kind = (e as { kind?: string }).kind;
        expect(kind, `这条探针抛出来的异常没带档名：${src.slice(0, 40)}`).toBeTypeOf("string");
        seen.push(kind as string);
      }
    }
    expect(
      [...new Set(seen)].sort(),
      "真源的抛出档与「判不准要吵」那张表对不上了：往真源加了一档就必须往那张表加一行探针，"
      + "否则新那一档是一条**没人验过的绊线**——一条永远不触发的防御和没有防御在证据上要分辨得出来",
    ).toEqual([...FAIL_KINDS].sort());
    expect(
      FAIL_KINDS.length,
      "有两行探针打到了同一档 ⇒ 有一档没人验过（集合相等这一条挡不住重复）",
    ).toBe(SHOUT_CASES.length);
  });

  /**
   * **已知判反（登记成断言，不是散文）—— 而且它是致盲方向。这句话前三轮写反了三次。**
   *
   * 真源的 `endsExpression()` 认不出「这个 `!` 是 TS 非空断言（后缀位）还是逻辑非（前缀位）」，
   * 只要前一个 token 是一个完整的值就当后缀位 ⇒ 后面那条正则被当成除法 + 代码扫。
   *
   * ⚠️⚠️ **上一版在这里与真源里都写着「那一支的后果方向是把正则当代码扫，不吞代码，
   * 遇到引号/裸斜杠会撞上别的绊线当场吵，不是致盲方向」——实测为假，而且是同一句话写了三轮。**
   * 上一版登记的两条**样本**为真（`/x\/\/y/` 会吵、`/x/` 逐字节原样），
   * 但从两条样本推出来的**结论**为假：正则体里只要有**字符组包着的裸斜杠**
   *（`[/*]` / `[//]`，都是合法正则），判成除法之后它直接变成块注释 / 行注释开头。
   *
   * **测法（下面每一条都能自己跑出来）**：`stripComments(src)` 不抛 ⇒ 比
   * `输出.length` 与 `原文.length` 拿到吞掉的字节数 ⇒ 再看 `输出.includes("foo()")`。
   * 本轮实测：**吞 31 / 20 / 31 / 31 字节，`foo()` 全部消失，扫描器一个字都不吵。**
   *
   * **触发口至少四个**（上一版只登记了第一个）：
   * · ASI 断句后跟一个值：`const a = b` 换行 `!/[/*]/…`
   * · `closeParen`：`if (c) !/[/*]/…`（`endsExpression()` 对 `closeParen` 一律返回真，
   *   **连控制流头部的 `)` 也算**，而那个位置上的 `!` 必然是前缀位）
   * · `]`：`arr[0]` 换行 `!/[/*]/…`
   * · 以及任何将来让 `endsExpression()` 返回真的新形态——**这不是闭集**。
   *
   * **危害档位：高（致盲）；今天的入口数：零**（射程内 0 处这种写法）。
   * 接住它的是「全射程与真解析器对拍」那一格（本轮实测：四条全部只有裁判红）。
   * 真源那条 `openerLivesInString()` **接不住这一族**，理由写在它自己的注释里：
   * 那几行一个引号都没有，独立重算说「不在字符串里」——它说的是实话。
   */
  it.each([
    ["ASI 断句后跟一个值", "const a = b\n!/[/*]/.test(s); foo(); /* 正常注释 */\nconst keep = 1;", 31],
    ["同一族、误开的是行注释", "const a = b\n!/[//]/.test(s); foo();\nconst keep = 1;", 20],
    ["控制流头部的 `)`", "if (c) !/[/*]/.test(y); foo(); /* 正常注释 */\nconst keep = 1;", 31],
    ["方括号收尾的 `]`", "const arr = [1];\narr[0]\n!/[/*]/.test(s); foo(); /* 正常注释 */\nconst keep = 1;", 31],
  ])("已知判反且致盲：行首逻辑非被当成非空断言 —— %s", (_why, src, swallowed) => {
    // 这几条变红意味着**有人把这个盲点补上了**——那是好事，把这一格删掉即可。
    const out = stripComments(src as string);
    expect(src.length - out.length, "吞掉的字节数变了 ⇒ 危害档位要重新复量，别抄这里的数字")
      .toBe(swallowed);
    expect(out, "**这就是致盲**：真代码被当注释吞掉，而扫描器一个字都不吵").not.toContain("foo()");
    // 反向控制：同一族里不含裸斜杠的那一支确实只是「把正则当代码扫」，逐字节原样。
    expect(stripComments("const a = b\n!/x/.test(s);")).toBe("const a = b\n!/x/.test(s);");
    // 反向控制：正则体里有引号或转义斜杠时会撞上别的绊线 —— 那是「吵」，不是致盲。
    expect(() => stripComments("const a = b\n!/x\\/\\/y/.test(s);")).toThrow("判不准");
  });

  /**
   * **已知误伤（登记成断言）：`openerLivesInString()` 会把这一种形态判成判反。**
   *
   * 独立重算只按引号收支扫本行，认不出「这个引号住在一条正则里」。于是同一行上
   * **两条各含奇数个引号的正则夹着一段注释**时，它会把两条正则里的引号配成一对，
   * 判定那段注释住在字符串里 ⇒ **假红**。
   * · 射程 259 个文件实测 **0 例**（测法：拿真源逐文件跑 `stripComments`/`blankComments`，
   *   数抛出，0 抛出）。
   * · 真撞上时它是一声**响亮的抛**并逐字带上原文那一行，不是静默吞码；改法是把那一行拆开写。
   * ⇒ 本仓裁定「认不出要吵」，这一档宁可这样误伤，也不要在判反时闭嘴。
   * 将来谁把重算做得认得正则了，这一条会红——那是好事，把它删掉即可。
   */
  it("已知误伤：两条各含奇数个引号的正则夹着一段注释 ⇒ 独立重算会假红", () => {
    expect(() => stripComments('const a = /"/.test(s); /* c */ const b = /"/.test(t);'))
      .toThrow("住在一个字符串里");
    // 反向控制：只要那一行的引号收支「没结论」（奇数个），这一档就闭嘴，不许乱红。
    expect(() => stripComments('const a = /"/.test(s); /* c */ const b = 1;')).not.toThrow();
    // 反向控制：正当的「注释里带引号」不许红 —— 偶数个也不行。
    expect(() => stripComments('const s = "a"; /* 里面 " 两个 " 引号 */ const t = 1;')).not.toThrow();
  });
});

// ── ⑤ 全射程与真解析器对拍 ──────────────────────────────────────────────────

/**
 * **这一格是第二轮复评那条 HIGH 的第二层网：拿一个真解析器当常驻裁判。**
 *
 * 上一轮与这一轮的两条致命缺陷都是「同一族的第二次」：先是正则字面量整个不认，
 * 再是后缀运算符之后的除法判反。两次都是**射程内的自查全绿**，两次都靠评审员**临时**
 * 写一份对拍才现形。⚠️ **一次性的对拍是评审员的运气，不是仓库的资产。**
 * ⇒ 所以把裁判固化成这一格：下次再把任何位置的斜杠判反，**当场红**，不必等下一个评审员想到。
 *
 * **裁判是谁**：Node 内置的 `module.stripTypeScriptTypes(src, { mode: "transform" })`
 *（Node 自带的 SWC）。它是一个**真解析器**——正则 vs 除法由它自己的表达式上下文判定，
 * 而 `transform` 模式的输出**不带注释**。**本文件一行解析逻辑都没写**，这一点是这一格的全部价值：
 * 自写第二实现来对拍，正是本任务要消灭的东西（上一轮评审用的 `oracle.mjs` 就是那样）。
 *
 * **对拍口径是「后果」，不是中间量**：抠注释**不许改变程序本身**。
 *     judge(stripComments(src)) === judge(src)
 * 真代码被当注释吞掉时，抠完的那份要么解析不了、要么少了几条语句 ⇒ 两边当场不等。
 * 比「逐字节对拍注释区间」更贴要害：致盲的定义就是「真代码脱离扫描」。
 *
 * ⚠️⚠️ **这个裁判看不见什么 —— 四条，逐条测法在括号里。上一版只自陈了第一条，
 * 第三轮复评把另外三条量了出来；别把这一格读成「全都接住了」。**
 * · ①**反方向（该抠的没抠掉）看不见**：裁判两边都会把注释抠掉。那一族是**多报方向**
 *  （注释文本泄漏进代码 ⇒ 下游门禁红），由「反向控制：真注释还是要被抠掉」那一格钉着。
 * · ②**纯类型代码被吞看不见**：`interface` / `type` 别名 / `import type` / `declare` /
 *   函数重载签名——**裁判两边都做类型擦除**，吞掉它们两边都是空。
 *  （测法：`judge("interface A { x: number }\nfoo();")` 与 `judge("foo();")` 逐字节相等。）
 *   今天难以走到：这个扫描器判反之后，泄漏点前面通常会留下一个落单的引号，`mine` 多半
 *   解析不了 ⇒ 裁判照样红。**但那是运气，不是口径**。档位 MEDIUM。
 * · ③**空白与换行差异看不见**：`transform` 模式会重排格式。
 *  （测法：`judge("foo();")` 与 `judge("\n\n  foo();\n")` 逐字节相等。）
 *   `blankComments` 的行列不变量因此**不能靠这一格**，它靠上面那格的长度/行数两条。
 * · ④**CSS 方言零覆盖**：这一格的射程扩展名表是 `.ts` / `.js` / `.mjs`
 *  （`REGEX_STRIP_SCAN_EXT`），`stripCssComments` 根本没进这一格。
 *   **CSS 那一侧今天没有裁判**——它只有「三个出口」那一节里的手写探针
 *  （`url(//…)` 不许被当行注释、失步报文不许提正则字面量）和 `admin-ui/css` 的体积门禁。
 *   要给它找一个裁判的话得另找一个 CSS 解析器，本仓今天没有，**这里明写「没有」，
 *   别让下一个人以为对拍覆盖了 CSS**。
 *
 * **为什么不是 acorn**（第二轮复评那份一次性裁判用的是它）：它不在本仓依赖里，
 * 而这道断言不值得为它新增依赖；更要紧的是 **acorn 解析不了 `.ts`**，而射程 259 个文件里
 * 221 个是 `.ts` —— 拿它当裁判还得自己先做一遍类型擦除，**那等于又写一份第二实现**。
 * Node 内置这一条零依赖、零解析逻辑，`.ts`/`.js`/`.mjs` 一视同仁。
 * ⚠️ 它是实验 API（跑起来会有一行 `ExperimentalWarning`，那是真的，不是噪音），
 * 且要 Node ≥ 22.13（CI 用的是 `node-version: 22`，本机与 CI 都实测过）。
 * **所以下面第一格先验裁判自己**：裁判不再抠注释、或者看不出真代码被吞 ⇒ **红，不是跳过**。
 * 一个不会判的裁判必须吵出来，否则这一格就是一格恒绿。
 *
 * ⚠️ **「Node 太老」这一条够不着，别把它当成防线（复评实测）**：Node 太老时
 * `import { stripTypeScriptTypes } from "node:module"` 在**加载期**就
 * `SyntaxError: … does not provide an export named …`（在 `/usr/bin/node` v18.19.1 上实测到），
 * 于是红的是**整份文件收集失败**，不是那一格，报错文本与「这一格没法判」毫无关系。
 * ⇒ 结果仍然是红（诚实的），但**下面那条 `typeof` 断言永远执行不到**，留着只是文档。
 * 真正把版本钉住的是 `package.json` 的 `engines.node`（本轮补的，`>=22.13`）
 * 与 CI 的 `node-version: 22`；本机 `/usr/bin/node` 就是 v18，换个 shell 就能踩到。
 */
const judge = (src: string): string => stripTypeScriptTypes(src, { mode: "transform" });

describe("全射程与真解析器对拍", () => {
  it("先验裁判自己 —— 它抠注释、而且看得出真代码被吞", () => {
    // ⚠️ 这一条**够不着**（Node 太老是加载期 SyntaxError，整份文件收集失败）。
    //    留着是文档，别把它当防线，理由写在本节 ⚠️ 那一段里。
    expect(typeof stripTypeScriptTypes, "Node 太老，没有这个内置裁判 ⇒ 这一格没法判，红着比绿着诚实")
      .toBe("function");
    const withComments = "const a: number = 1; // 抠掉我\n/* 也抠掉我 */\nfoo();\n";
    expect(judge(withComments), "裁判不再抠注释了 ⇒ 下面那格会把「注释没抠干净」也判成一致").not.toContain("抠掉我");
    expect(judge(withComments), "裁判把真代码也弄丢了 ⇒ 它不能当裁判").toContain("foo()");
    // 正向：真代码被吞 ⇒ 裁判必须说不等（否则下面那一格是恒绿的）
    expect(
      judge("const a = 1;\nfoo();\n") === judge("const a = 1;\n"),
      "裁判看不出少了一条语句 ⇒ 它没有鉴别力",
    ).toBe(false);
    // 反向：只差注释 ⇒ 裁判必须说相等（否则下面那一格会满仓乱红）
    expect(judge("const a = 1; // c\nfoo();\n"), "只差注释却说不等 ⇒ 这一格会满仓乱红")
      .toBe(judge("const a = 1;\nfoo();\n"));
  });

  it("射程内每个文件：抠注释不许改变程序本身", () => {
    const broken: string[] = [];
    const files = regexStripScanFiles();
    for (const rel of files) {
      const src = readFileSync(rel, "utf8");
      let ref: string;
      try {
        ref = judge(src);
      } catch (e) {
        broken.push(`${rel} :: 裁判连原文都解析不了（${(e as Error).message.split("\n")[0]}）`);
        continue;
      }
      for (const [name, fn] of [["stripComments", stripComments], ["blankComments", blankComments]] as const) {
        let mine: string;
        try {
          mine = fn(src);
        } catch (e) {
          broken.push(`${rel} :: ${name} 抛出 ${(e as Error).message.split("\n")[0]}`);
          continue;
        }
        try {
          if (judge(mine) !== ref) broken.push(`${rel} :: ${name} 抠完之后程序变了`);
        } catch (e) {
          broken.push(`${rel} :: ${name} 抠完之后裁判解析不了（${(e as Error).message.split("\n")[0]}）`);
        }
      }
    }
    expect(files.length, "射程扫了个空 —— 这一格会恒绿").toBeGreaterThan(200);
    expect(
      broken,
      "**抠注释改变了程序本身 —— 这就是致盲**：真代码被当成注释吞掉之后，"
      + "所有按内容扫的下游门禁都会照常报绿。真源那几档绊线拦的是「判不准」，"
      + "拦不住「判错了但很确信」，所以这一格拿真解析器直接查后果。"
      + "请去 `scripts/lib/strip-comments.mjs` 的正则/除法判据里补这一档，"
      + "**别在这里加豁免、也别在调用方 try/catch 把它吞掉**",
    ).toEqual([]);
  }, 120_000);

  /**
   * **反向控制：这一格真的会红。**
   *
   * 一条恒等于零的断言与一条坏掉的断言长得一模一样——上面那格期望空表，这里证明它有鉴别力：
   * 拿第二轮与第三轮复评实测到的那几条输入（`++` / `--` / 非空断言 / **类型实参表收尾的 `>`**
   * 之后的除法，判反之后会吞掉真代码），各造一份「被吞掉之后的样子」，
   * 裁判必须说它与原文不是同一个程序。
   * ⚠️ 这几条**不是**在验真源今天判得对（那是上面那几格的活）：真源现在对它们要么判对、
   * 要么当场抛。这几条验的是**裁判本身有没有鉴别力**——它要是看不出「少了一条语句」，
   * 上面那格就是恒绿的。
   */
  it.each([
    ["后缀自增之后的除法", 'let n = 1; const r = n++ / 2; const GLOB = "/admin/api/*"; console.log(1);'],
    ["后缀自减之后的除法", 'let n = 2; const r = n-- / 2; const GLOB = "/admin/api/*"; console.log(1);'],
    ["非空断言之后的除法", 'const a = { b: 1 }; const r = a!.b! / 2; const GLOB = "/admin/api/*"; console.log(1);'],
    ["类型实参表收尾的 `>` 之后的除法（第三轮那条 CRITICAL）", 'const f = <T,>(x: T) => 1; const r = f<number> / 2; const GLOB = "/admin/api/*"; console.log(1);'],
  ])("裁判认得出被吞掉的真代码：%s", (_why, src) => {
    // 「判反之后的样子」：误判出来的正则在毒刺里那个斜杠上闭合，其后一路被吞掉。
    const swallowed = src.slice(0, src.indexOf('"/admin') + 3);
    expect(judge(src) === (() => { try { return judge(swallowed); } catch { return "解析不了"; } })(), "裁判看不出这一族 ⇒ 上面那格接不住它")
      .toBe(false);
    expect(judge(src), "反向控制：原文本身要能过裁判这一关，否则上面那条不等是白来的").toContain("console.log");
  });
});
