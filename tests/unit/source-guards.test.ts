import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments.js";

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

// ── ③ tests/ 下的 stripComments 副本 ─────────────────────────────────────────

/**
 * **`tests/helpers/strip-comments.ts` 立的那条禁令的执行机构**（P3d 全分支评审 F-5）。
 *
 * 那个文件写着「新的调用点一律 import 这一份，**不许再抄第六份**」——而在这一格
 * 出现之前，那条禁令**一个机器都没守**，同文件里那张「谁还各持一份正则副本」的清单
 * 也只是散文。**评审实测**：那个文件另一处写着「已经收编成这一份（**4 个消费者**）」，
 * 而当天真实是 **6 个**（Task 12 加了两个）⇒ **通篇讲「会漂」的文件里，漂的正是那个计数。**
 *
 * ⚠️⚠️ **本格守的是「不许再抄第六份」，不是「消费者有几个」**（两句话方向相反）：
 * 消费者那一侧**该长大**——每收编一个调用点都是好事，给它配一道绊线只会换来机械 bump，
 * 所以那一侧按 Task 5 I3 的处置**把计数删掉**、改成现场 `grep` 的写法。
 * 这一侧相反：它**只许变短、不许变长**，所以它才配得上一条会红的断言。
 *
 * ⚠️ **判据锚在「这个文件里自己定义了一个叫 stripComments 的东西」上**，
 * 不是「这个文件里出现过 stripComments 这个词」——后者会把每一个**正当的 import
 * 消费者**一起数进来，那正好是反过来守错了方向。
 * ⚠️ **本文件自己被排除在外**（它 import 的是真源，不是副本），
 * `tests/helpers/strip-comments.ts` 也排除（它就是真源本体）。
 *
 * **已知射程**：换个名字抄一份（`function stripCmts(...)`）扫不到——**按名字扫的天花板**，
 * 与本文件上面两道门禁登记的「间接引用抓不住」是同一族边界。
 */
const OWN_STRIP_COPIES: readonly string[] = [
  // 两者扫的都是 `admin-ui/`，那里今天没有含 `/*` 的字符串 ⇒ 今天不在射程内，
  // **不是「它们是对的」**。收编它们的改动面超出当时那个任务，逐字理由在真源文件里。
  "tests/ui/dom/fake-dom-parity.test.ts",
  "tests/unit/i18n-dict.test.ts",
];

/** 一个文件里有没有**自己定义**一个叫 `stripComments` 的东西（函数声明 / 赋给变量）。 */
const OWN_STRIP_DEF = /(?:function\s+stripComments\b|(?:const|let|var)\s+stripComments\s*[=:])/;

describe("tests/ 下的 stripComments 副本", () => {
  it("tests/ 下自己手写 stripComments 的文件恰好是登记的那两个 —— 第六份一出现当场红", () => {
    const found: string[] = [];
    for (const p of walkTs("tests")) {
      const rel = p.split("\\").join("/");
      if (rel === "tests/helpers/strip-comments.ts") continue;   // 真源本体
      if (rel === "tests/unit/source-guards.test.ts") continue;  // 本文件：上面那条正则里就写着这个名字
      if (OWN_STRIP_DEF.test(stripComments(readFileSync(p, "utf8")))) found.push(rel);
    }
    expect(
      found.sort(),
      "tests/ 下手写 stripComments 副本的文件变了。**多出来一个 = 有人抄了第六份**"
      + "（本仓裁定：新的调用点一律 import tests/helpers/strip-comments.ts）；"
      + "少了一个 = 收编成功，把 OWN_STRIP_COPIES 与那个文件里那张清单一起改短",
    ).toEqual([...OWN_STRIP_COPIES].sort());
  });

  /**
   * **反向自检：这道判据认得出该认的、认不出不该认的。**
   * 少了它，把 `OWN_STRIP_DEF` 写坏成一个永不匹配的正则，上面那格会红成
   * 「少了两个」——方向看着像好事（清单变短了），而实际是护栏瞎了。
   */
  it.each([
    ["function stripComments(src: string): string { return src; }", true, "函数声明"],
    ["const stripComments = (src: string) => src;", true, "赋给 const"],
    ["let stripComments = (s) => s;", true, "赋给 let"],
    ['import { stripComments } from "../helpers/strip-comments.js";', false, "正当消费者：import 不算副本"],
    ["const stripped = stripComments(readFileSync(p));", false, "调用它不算副本"],
    ["// 这里刻意不再抄一份 stripComments", false, "注释里的提及不算（先抠注释）"],
  ])("反向自检：%s", (probe, expected) => {
    expect(OWN_STRIP_DEF.test(stripComments(probe as string))).toBe(expected as boolean);
  });
});
