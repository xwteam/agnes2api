import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import {
  stripComments, blankComments, stripCssComments, stripHtmlComments, FAIL_KINDS,
} from "../helpers/strip-comments.js";
import { declarations, isColorProp, visibleNonColorDecls } from "../helpers/css-decls.js";

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
 * 3. **绝不许把 `docs/` 扫进来**：`docs/` 装的是**散文**，而散文正当地会逐字复述那条正则
 *    来解释「正则版为什么不行」——把散文扫进来等于要求文档不许引用它所解释的东西。
 *    ⚠️⚠️ **挡住 `docs/` 的其实是上面那张扩展名表，不是这张目录表——逐条变异量过，
 *    别把功劳记错地方**：只把 `"docs"` 加进本表、扩展名表不动 ⇒ **全绿、什么都不会发生**
 *   （`docs/` 下全是 `.md`，收不进来）。两张表**一起**放宽（本表加 `"docs"` 且扩展名表加
 *    `".md"`）才会真的走到 `docs/` 里去。
 *    ⚠️ **当年量这一条时，被点名的那份文档已经不在仓里了**：它是一份内部计划文档
 *    （正文里实测有 5 行含那条正则字面量），已随全部内部设计文档移出本仓。
 *    所以今天两张表一起放宽**不一定还会红**——射程扩到 `docs/` 这件事本身仍然是错的，
 *    下面那条「射程里不许出现 `docs/` 下的文件」的断言钉的正是射程本身，不依赖某一份文档在不在。
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
      "`docs/` 装的是散文，而散文正当地会逐字复述那条正则来解释「正则版为什么不行」，"
      + "扫它们等于要求文档不许引用它所解释的东西 —— 目录表与扩展名表**两张一起**放宽才会走到这里，"
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
 * `blankComments` 的生产消费者今天是 `tests/ui/api-session.test.ts` 的 `braceInterpLinesIn()`
 *（P3e Task 2 接上的）。**这一格不因为有了消费者就可以撤**：它验的是「留空版换出来的是空格、
 * 不是删掉」这一件事本身，而消费者那边验的是「按行对齐之后数得对」——
 * 上一版这里写的是「今天还没有消费者」，那句已经不成立，留着就是一条会腐的散文。
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

  /**
   * **HTML 是第三种注释语义，而它的消费者是 i18n 门禁**（`scripts/check-i18n.mjs`
   * 的引用广扫要扫 `admin-ui/index.html` 里那 16 处 `data-i18n=`）。
   * 下面三格分别钉住：**正向抠得掉**、**前三个导出在 HTML 上各自怎么坏**、
   * **两条已知边界确实是那个样子**。
   */
  it("stripHtmlComments 抠掉 `<!-- -->`，而 HTML 里的斜杠与撇号都不是注释", () => {
    const html = '<title>a/b</title>\n<!-- 抠掉我 -->\n<p>it\'s fine</p>\n<a href="/x/y">z</a>\n';
    const got = stripHtmlComments(html);
    expect(got, "HTML 注释必须被抠掉").not.toContain("抠掉我");
    expect(got, "`</title>` 里的斜杠不是注释开头").toContain("<title>a/b</title>");
    expect(got, "正文里的撇号不是字符串开头").toContain("it's fine");
    expect(got, "属性里的路径不许被吞").toContain('href="/x/y"');
  });

  /**
   * **反向控制：前三个导出在同一份 HTML 上都不能用。**
   * 少了这一格，「HTML 需要第四个方言」就只是一句散文——而本仓已经为
   * 「拿错方言去抠」栽过一次（P3e Task 1 把两处 CSS 消费者改成 JS 语义）。
   */
  it("同一份 HTML 喂给前三个导出：JS 方言当场抛、CSS 方言一声不吭地什么都没抠", () => {
    const html = '<title>a/b</title>\n<!-- 抠掉我 -->\n';
    expect(() => stripComments(html), "JS 方言把 `</title>` 的斜杠判成正则开头 ⇒ 必须抛")
      .toThrow("正则字面量");
    expect(stripCssComments(html), "CSS 方言在 HTML 上是恒等变换 —— 静静地放行，这正是它不能用的理由")
      .toContain("抠掉我");
  });

  /**
   * **stripHtmlComments 的两条已知边界**（真源那个函数的注释里逐条写着这两句）。
   * **这两格断言的是「当前实现就是这样」，不是「这样是对的」**：哪天判据被改进，
   * 这里会红，而红的地方正是该回去改那段注释的地方。
   */
  it("stripHtmlComments 的两条已知边界：属性值里的 `<!--` 会误抠；内联 script 里的 JS 注释抠不掉", () => {
    // 边界一：按 HTML 规范这是纯文本，本实现会把它当注释吃掉。
    const attr = '<div title="<!-- x -->">留下我</div>';
    expect(stripHtmlComments(attr), "判据被改进了（认得出标签状态）—— 请回去改真源那段边界说明")
      .not.toContain("<!-- x -->");
    // 边界二：内联脚本里的 `//` 行注释不是 HTML 注释，本函数看不见它。
    const inline = "<script>\n// data-i18n=\"nav.zzz\"\n</script>";
    expect(stripHtmlComments(inline), "判据被改进了（认得出内联脚本）—— 请回去改真源那段边界说明")
      .toContain('data-i18n="nav.zzz"');
  });

  /**
   * ⚠️⚠️ **「没闭合就抛」的反向控制 —— 只做「会抛」那一半等于把一族合法 HTML 打红。**
   *
   * P3e Task 3 复评（F2）实测：`admin-ui/index.html` 少一个 `-->` ⇒ i18n 门禁的引用数
   * 从 496 掉到 480（整份文件尾的 `data-i18n=` 被静默吞掉），而门禁打着 ✅ 横幅 exit 0。
   * 修法是「未闭合就抛」，**而修它的时候最容易顺手搬来的新问题就是把合法注释一起打红**：
   * HTML5 里 `<!-->` 与 `<!--->` 是 **abrupt-closing-of-empty-comment**，
   * 也就是**闭合的空注释**（上一版把它们当成未闭合、一路吃到文件尾——那一支恰恰是
   * 它拿「HTML5 规定行为」给自己背书的方向的反面）；`--!>` 是
   * **incorrectly-closed-comment**，是 parse error 但注释照样闭合。
   * 这一格逐形态钉住：**这三种都不许抛，而且注释之后的内容必须原样活着**
   *（活着才证明它没有一路吃到文件尾）。
   */
  it("stripHtmlComments 逐形态认 HTML5 的闭合注释，一条都不许被当成未闭合", () => {
    const TAIL = '<p data-i18n="nav.tail"></p>';
    for (const [why, comment] of [
      ["最常见的形态", "<!-- 抠掉我 -->"],
      ["空注释：`<!-->`（abrupt-closing-of-empty-comment）", "<!-->"],
      ["空注释：`<!--->`（同上，多一个连字符）", "<!--->"],
      ["`<!---->`：走的是正常的 `-->` 那一路", "<!---->"],
      ["`--!>`（incorrectly-closed-comment，浏览器照样闭合）", "<!-- 抠掉我 --!>"],
      ["`---!>`：注释结束态里的连字符可以重复", "<!-- 抠掉我 ---!>"],
    ] as const) {
      const html = `${comment}\n${TAIL}\n`;
      expect(() => stripHtmlComments(html), `${why}：这是闭合的注释，不许抛`).not.toThrow();
      expect(stripHtmlComments(html), `${why}：注释本身必须被抠掉`).not.toContain("抠掉我");
      expect(
        stripHtmlComments(html),
        `${why}：注释之后的内容不见了 ⇒ 它被当成未闭合、一路吃到了文件尾`,
      ).toContain(TAIL);
    }
    // **最大的一条反向控制：真的那份 `admin-ui/index.html`**（`scripts/check-i18n.mjs` 这道门禁每次都要抠它）。
    expect(() => stripHtmlComments(readFileSync(join("admin-ui", "index.html"), "utf8")))
      .not.toThrow();
  });
});

// ── ④ 抠注释真源的扫描器边界 ────────────────────────────────────────────────

/**
 * `blankComments()` 动过的每一段，在原文里都必须以斜杠开头；返回不合格的那几段。
 *
 * **它不解析任何东西**——`blankComments` 保长度，于是「哪些位置被动过」是逐字节比出来的。
 * 「同一段」的判据：中间只隔着空格或换行（注释里原有的空格换成空格之后与原文相等，
 * 换行原样保留），隔着别的字节就算两段。**这是刻意的最弱形态**，只认「起点不是斜杠」这一件事，
 * 因为已删的那条不变量的另外三条分支实测被支配（见下面 describe 的文件头）。
 */
function blankedSpanFaults(src: string, blanked: string): string[] {
  const faults: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (blanked[i] === src[i]) { i += 1; continue; }
    const start = i;
    let end = i;
    let k = i;
    while (k < n) {
      if (blanked[k] !== src[k]) { end = k; k += 1; continue; }
      if (src[k] === " " || src[k] === "\n") { k += 1; continue; }
      break;
    }
    if (src[start] !== "/") {
      const line = src.slice(0, start).split("\n").length;
      faults.push(`第 ${line} 行抠掉的一段以 ${JSON.stringify(src.slice(start, start + 24))} 开头，那不是注释`);
    }
    i = end + 1;
  }
  return faults;
}

/**
 * 真源里每个 `fail()` **调用点**的档名（取该调用点里第一个字符串字面量），
 * 外加 `function fail(` 定义点的个数（给「这道守卫扫对地方了吗」当反向自检）。
 *
 * **先抠注释再找**（用的就是被守的那份真源自己的 `blankComments`）：散文里怎么写都不算数——
 * 上上一版数字面文本时，注释里出现那串字符就会假红并指错地方。
 * **格式无关**：空白 / 换行 / 缩进都不参与判据。
 */
function failCallSites(source: string): { sites: Array<string | null>; defs: number } {
  const code = blankComments(source);
  const sites: Array<string | null> = [];
  let defs = 0;
  const re = /\bfail\s*\(/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index))) { defs += 1; continue; }
    sites.push(firstStringLiteral(code, m.index + m[0].length - 1));
  }
  return { sites, defs };
}

/** 从 `openParen` 那个左括号起，取这一对括号里的第一个字符串字面量；没有就 `null`。 */
function firstStringLiteral(code: string, openParen: number): string | null {
  let depth = 0;
  for (let i = openParen; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") { depth -= 1; if (depth === 0) return null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      let lit = "";
      for (let j = i + 1; j < code.length; j += 1) {
        if (code[j] === "\\") { j += 1; continue; }
        if (code[j] === ch) break;
        lit += code[j];
      }
      return lit;
    }
  }
  return null;
}

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
 * ⇒ 上一轮**把它整个删掉了**，理由是本仓那条规矩：一条永远不触发的防御和没有防御在证据上
 * 要分辨得出来，而它当时分辨不出来；留着它的唯一后果是下一个人以为「这里已经接好了」。
 *
 * ⚠️⚠️ **第四轮复评在这里又打了一次脸：整个删掉带走了一样东西，而当时那句
 * 「它原本想接的那个后果，现在由 `openerLivesInString()` 与对拍那一格接」是假的。**
 * 复评逐条复刻已删的那个函数、与现有各层对拍，量出来的是：它的四条分支里三条确实被支配，
 * **但第一条（「被抠掉的一段在原文里不是以斜杠开头」）今天没有任何一层接**——
 * 合成实验（整条 `interface` / `type` 别名 / `import type` 被换成等长空格）实测：
 * 三条便宜不变量全过、真源不抛、**独立裁判两边逐字节相等（它做类型擦除，看不见）**，
 * 而已删的那一条会红。⇒ 删掉它，恰好带走了**裁判已登记盲区②的唯一覆盖层**。
 * ⇒ **本轮把那一条分支单独留回来**，落在下面「抠掉的每一段在原文里都必须以斜杠开头」那一格，
 * 并且这一次**带正向控制**（合成一份「整条 interface 被吞」的输入，它必须红，同时证明裁判绿）——
 * 上一版恒绿正是因为没有正向控制。**其余三条分支不要抄回来，它们真的被支配。**
 * **这一格剩下的三条不变量仍然请当成便宜的形态自检，不要当成网。**
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
        // ⚠️ 这三条对「吞掉真代码」全瞎，别在这里往里塞第四条：真正接住那一族的是
        // 下面那两格全射程不变量（「抠掉的每一段在原文里都必须以斜杠开头」与
        // 「射程内每个文件：抠注释不许改变程序本身」），它们各自带着正向控制，
        // 而这三条只是便宜的形态自检。真源那条 `openerLivesInString()` 是尽力而为的
        // 概率防线，**它绿着什么都不证明**（理由写在真源那个函数自己的注释里）。
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
   * **`blankComments()` 抠掉的每一段，在原文里必须以斜杠开头 —— 这一格接的是裁判看不见的那一族。**
   *
   * 判据只看**差异区间**，不看扫描器做过什么判断：`blankComments` 保长度，
   * 于是「哪些位置被动过」是一个可以逐字节数出来的量。被动过的每一段，
   * 在原文里的**第一个字节必须是斜杠**（`//` 或斜杠星号的开头）——注释只能这么开头。
   * 一段真代码被当注释吞掉时，那一段多半不是以斜杠开头 ⇒ 当场红并点名行号。
   *
   * ⚠️ **缝隙的口径写在这里，别照抄成「连续区间」**：注释里原本就有的空格
   * 换成空格之后与原文相等，换行更是原样留着 ⇒ 差异区间天然是碎的。
   * 所以「同一段」的判据是「中间只隔着空格或换行」；隔着任何别的字节就算两段。
   *
   * ⚠️⚠️ **它为什么值得单独一格（这一条是第四轮复评的直接产物）**：
   * 下面「射程内每个文件：抠注释不许改变程序本身」那一格拿真解析器当裁判，
   * 而**裁判两边都做类型擦除** ⇒ 整条 `interface` / `type` 别名 / `import type`
   * 被吞掉时它两边逐字节相等、**完全看不见**（那是它自陈的盲区②）。
   * 这一格是那一族**今天唯一的覆盖层**，正向控制就在下面那一格里。
   */
  it("抠掉的每一段在原文里都必须以斜杠开头 —— 裁判盲区②的唯一覆盖层", () => {
    const faults: string[] = [];
    const files = regexStripScanFiles();
    for (const rel of files) {
      const src = readFileSync(rel, "utf8");
      let blanked: string;
      // `blankComments` 抛出时**这一格刻意让路**：那种失败由上面「射程内每个文件都扫得完」
      // 那一格逐文件点名，在这里再抛一次只会用一句「以斜杠开头」盖掉真正的报文。
      try { blanked = blankComments(src); } catch { continue; }
      for (const f of blankedSpanFaults(src, blanked)) faults.push(`${rel} :: ${f}`);
    }
    expect(files.length, "射程扫了个空 —— 这一格会恒绿").toBeGreaterThan(200);
    expect(
      faults,
      "有一段**不以斜杠开头**的东西被抠掉了 ⇒ 那不是注释，是真代码。"
      + "**这一族正是独立裁判看不见的那一族**（它两边都做类型擦除，整条 `interface` / "
      + "`type` 别名 / `import type` 被吞掉时它判两边相等）。"
      + "请去 `scripts/lib/strip-comments.mjs` 找那一段是被哪一档抠掉的，"
      + "**别在这里加豁免**",
    ).toEqual([]);
  });

  /**
   * **正向 + 反向控制：上面那格真的会红，而且它对正当注释不乱红。**
   *
   * 上一轮删掉的那条不变量恒绿，根因就是**没有正向控制**——一条恒等于零的断言与一条
   * 坏掉的断言长得一模一样。这一格拿第四轮复评实测的那三种形态当输入：
   * 整条纯类型语句被换成等长空格。三种在真源今天都走不到（**这里验的不是真源判得对**），
   * 验的是**上面那格有没有鉴别力**，以及**裁判确实看不见它**。
   */
  it.each([
    ["interface 声明", "interface A { x: number }\nfoo();\n"],
    ["type 别名", "type A = { x: number };\nfoo();\n"],
    ["import type", 'import type { A } from "./a";\nfoo();\n'],
  ])("正向控制：整条纯类型语句被吞时上面那格会红，而独立裁判看不见：%s", (_why, src) => {
    const head = src.indexOf("\n");
    const swallowed = " ".repeat(head) + src.slice(head);
    expect(
      blankedSpanFaults(src, swallowed),
      "上面那格看不出「一整条纯类型语句被换成了空格」⇒ 它是恒绿的",
    ).not.toEqual([]);
    expect(
      judge(src),
      "裁判要是看得见这一族，上面那格就不是「唯一覆盖层」——那样的话请把这一条改写成登记",
    ).toBe(judge(swallowed));
  });

  it("反向控制：正当的注释不许被判成「不以斜杠开头」", () => {
    for (const src of [
      "const a = 1; /* c */\n// x\nfoo();\n",
      "/* 跨行\n   注释 */\nfoo();\n",
      'const s = "/*"; // 字符串里的斜杠星号不是注释\n',
      "const a = 1; /* 前 */  /* 后 */ const b = 2;\n",
      "#!/usr/bin/env node\n// 首行 hashbang 之后的行注释\nfoo();\n",
    ]) {
      expect(blankedSpanFaults(src, blankComments(src)), `这一条是正当注释，不许红：${src.slice(0, 24)}`)
        .toEqual([]);
    }
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
  /**
   * ⚠️ **第五列是入口函数，不是装饰**：真源的抛出档**不全在 JS 方言那一路上**。
   * `unclosedHtmlComment` 只有 `stripHtmlComments()` 走得到，写死用 `stripComments()`
   * 跑这张表的话，那一档会永远没有探针打到，而下面那格「每一档抛出都必须有探针打到」
   * 只会报「集合对不上」——指不出是因为入口选错了。**每一行自己带着它该走的那个出口。**
   */
  const SHOUT_CASES: ReadonlyArray<readonly [string, string, string, string, (src: string) => string]> = [
    [
      "`>` 后面的裸斜杠：箭头 `=>` 之后是正则位、TS 类型实参表收尾之后是除法位，分不出",
      'const r = f<number> / 2; const GLOB = "/admin/api/*"; const keep = 1;',
      "不是箭头",
      "angleAfterValue",
      stripComments,
    ],
    ["`}` 后面的裸斜杠：块结束是正则位、对象字面量结束是除法位，分不出", "const f = function () {}\n/x/.test(s);", "判不准", "braceSlash", stripComments],
    ["字符串没在本行内闭合 ⇒ 扫描器已经失步", 'const a = "没有闭合\nconst b = 1;', "失步", "unclosedString", stripComments],
    ["正则字面量没在本行内闭合 ⇒ 判据把一个除法号当成了正则开头", "const a = (1 + 2);\nconst b = /没有闭合\nconst c = 1;", "没有在本行内闭合", "unclosedRegex", stripComments],
    ["前一个有意义字符不在真源那两张判据表里 —— 宁可吵也不许猜", "const a = 1;\n@ /x/;", "两张判据表", "unknownPunct", stripComments],
    // ↓ 后果层：它们盯的是「真代码被当注释吞掉」这个后果，不是某几个符号。
    //   ⚠️ 前三条**意图对、落地仍然在盯符号**（盯 flag 字母、盯 `/*`、盯反引号），
    //   第三轮复评实测它们对 `>` 那一族**一条都没接住**（端到端：门禁当场变瞎）。
    //   最后一条 `openerInString` 是唯一不盯符号的：它只问「这个注释开头，
    //   按本行双引号收支独立重算，是不是住在一个字符串里」。
    //   ⚠️⚠️ **但它是一条概率防线，不是不变量**：开不开口由本行双引号的奇偶决定，
    //   而那个量与「哪个斜杠被判反了」毫无关系（第四轮复评：一个撇号就能让它闭嘴）。
    //   它的四类漏报钉在下面「已知漏报」那张表里，承重在哪一侧写在真源的文件头。
    [
      "判成正则之后引擎不认这条正则 ⇒ 判错了（`n++ / 2` 判反之后留下的正是这个现场）",
      'let n = 1;\nconst r = n + / 2; const GLOB = "/admin/api/*"; const keep = 1;',
      "引擎不认",
      "badRegex",
      stripComments,
    ],
    ["块注释开了没有闭合记号，一路吞到文件尾", "const a = 1;\n/* 没有闭合记号", "吞到文件尾", "unclosedBlock", stripComments],
    ["扫到文件尾模板栈还没平衡（反引号没配对 / `${` 没闭合 / 插值里花括号数不平）", "const s = `abc;\nconst n = 1;", "还没平衡", "tmplUnbalanced", stripComments],
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
      stripComments,
    ],
    [
      // 这一行走的是**第四方言**（`stripHtmlComments`），不是上面那个出口。
      // 上一版这里不抛：`<!--` 没有闭合记号时一路吃到文件尾，理由写的是「这是 HTML5 的
      // 规定行为」。P3e Task 3 复评实测了那一支的代价：`admin-ui/index.html` 少一个
      // `-->` ⇒ i18n 门禁的引用数从 496 掉到 480、整份文件尾的 `data-i18n=` 全部消失，
      // 而门禁**打着 ✅ 横幅 exit 0**。⇒ 现在按本仓裁定办：认不出要吵。
      "HTML 注释开了没有闭合记号，一路吃到文件尾 ⇒ 再抠下去就是静默吞掉半份文件",
      '<p data-i18n="nav.usage"></p>\n<!-- 没有闭合记号\n<p data-i18n="nav.keys"></p>\n',
      "HTML 注释开了没有闭合记号",
      "unclosedHtmlComment",
      stripHtmlComments,
    ],
  ];

  it.each(SHOUT_CASES)("判不准要吵：%s", (_why, src, needle, kind, entry) => {
    expect(() => entry(src)).toThrow(needle);
    // 消息里必须带上原文那一行，否则「吵」了也没人知道吵的是哪一行；
    // 档名必须是期望的那一个，否则这条探针验的是另一档（那等于这一档没人验过）。
    try {
      entry(src);
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
   * ⚠️ `openerInString` 那一档**至今仍有一种会误伤的形态**，它没有藏起来：
   * 见下面「已知误伤：两条各含奇数个双引号的正则夹着一段注释 ⇒ 独立重算会假红」那一格。
   */
  it.each([
    ["字符组里的裸斜杠与引号（`/[/*\"]/`）是一条合法正则", 'const re = /[/*"]/;'],
    ["协议匹配里的转义斜杠（仓里三个文件的真实形态）", "const isAbs = /^https?:\\/\\//.test(u);"],
    ["Unicode 属性转义要 `u` 标志才合法 —— 带着标志一起验才不会误伤", "const re = /\\p{L}+/u;"],
    ["带 lookbehind 的真实规则（`IO_PATTERNS` 里那一条的形态）", "const re = /(?<![.\\w])set(?:Timeout|Interval|Immediate)\\s*\\(/g;"],
    ["块注释正常闭合在文件最后一个字节上", "const a = 1;\n/* 闭合了 */"],
    ["模板里嵌模板、插值里再嵌模板，栈最终是平的", "const s = `a${ f(`b${ g(1) }c`) }d`;"],
    ["带标签模板", "const s = tag`a${b}c`;"],
    // ↓ 这三条专打 `openerInString`：字符串里的双斜杠 + 同行一段正当注释，
    //   是本仓最常见的形态（`admin-ui/js/i18n-dict.js` 里成片都是），它一次都不许红。
    ["字符串里的双斜杠之后跟一段正当行注释", 'const U = "https://cdn.example/x"; // 正当注释'],
    ["块注释体内含一个完整的网址", 'const a = 1; /* 见 "https://cdn.example/x" */ const b = 2;'],
    ["同一行上两个字符串夹一段块注释", 'const a = "x"; /* c */ const b = "y";'],
    // ↓ 这六条是第四轮复评实测到的**假红**（X4 那一族），本轮在真源里修掉了：
    //   上一版把 `'` 也算成引号、也不看反引号 ⇒ 撇号与模板串会把本行收支算歪。
    //   **它们全部是完全合法的代码**，一条都不许红。
    ["注释文本里的撇号（两段注释各一个）", "const a = 1; /* don't */ const b = 2; // it's ok"],
    ["注释里的撇号 + 一个正当字符串", 'const a = 1; /* it\'s */ const b = "x"; // don\'t'],
    ["模板串里的撇号（两个模板串各一个）", "const a = `it's`; /* c */ const b = `don't`;"],
    ["模板串里的双引号（收支被模板算歪的那一支）", "const a = `say \"hi`; /* c */ const b = `bye\" now`;"],
    ["复评 X4：往真文件里追加的那一行完全合法的 TS", "export const zzA = 1; /* don't */ export const zzB = 2; // it's fine"],
    ["单引号字符串夹一段块注释（单引号一律不数）", "const a = 'x'; /* c */ const b = 'y';"],
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
   * ⚠️ **这里刻意不写「那串字面文本今天出现几次」**：上一版写了个数，而它与自己引用的
   * 那个旧守卫（正则带着「不数函数定义那一处」）算出来的数对不上——**又一次计数漂移的现场，
   * 而且漂的正是一句用来说明「别再数文本」的话**。数字只许以断言的形式存在，
   * 判据本身已经把「有几个抛出点」变成了断言。
   *
   * ⚠️ **它剩下的那个洞，写在这里而不是藏起来**：往真源加一档、**而且那一档永远走不到**、
   * **而且不登记进 `FAIL_KINDS`** ⇒ 这一格看不见它。但那一档在定义上是**死代码**，
   * 且它第一次真的被走到时 `fail()` 当场内部错误（「没有登记进 FAIL_KINDS」）。
   * ⚠️ **另一个洞（可达、且能干净逃逸）由下面那一格接**：复用一个已登记的档名开第二个
   * 抛出点，这一格收到的集合一个字不变。别再把两者写成「不是一个量级」——
   * 上一版那句对比是**过度声称**，粒度只是从「站点级」退到了「档名级」。
   */
  it("每一档抛出都必须有探针打到 —— 运行期收档名，不数字面文本", () => {
    const seen: string[] = [];
    for (const [, src, , , entry] of SHOUT_CASES) {
      try {
        entry(src);
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
   * **上面那格剩的那个洞：新的可达抛出点只要复用一个已登记的档名，就能干净逃逸。**
   *
   * 第四轮复评实测（M-K2）：在真源里新加一个**真的走得到**的抛出点、档名复用
   * `unknownPunct` ⇒ 运行期收到的档集合一个字没变 ⇒ **103/103 全绿**。
   * （同一轮的 M-K1 —— 新档名 + 不加探针 —— 上面那格红且指对地方，那一半是好的。）
   * ⚠️ 上一版在那段注释里写着「旧那一版的洞是**可达的**抛出点能干净逃逸，两者不是一个量级」，
   * **那句对比是过度声称**：新那一版同样放行可达的新抛出点，只是粒度从「站点级」退到「档名级」。
   *
   * ⇒ 这一格把粒度补回站点级，判据是**结构**不是计数：
   * 先拿真源自己的 `blankComments()` 把注释抠掉（⇒ 散文里写多少个 `fail(` 都不算数，
   * 那正是上上一版假红的成因），再逐个 `fail(` 调用点取**第一个字符串字面量**当档名，
   * 要求**互不重复**且**并集恰好等于 `FAIL_KINDS`**。
   * · 换行写 / 删空格 / 改缩进 ⇒ 与判据无关（复评那两条「干净逃逸」的写法在这里逃不掉）。
   * · 复用已有档名开第二个调用点 ⇒ 重复 ⇒ **红**。
   * · 档名用变量传、或者把 `why` 写到档名前面 ⇒ 取到的不是档名 ⇒ **红**（不是漏）。
   *   这是刻意的：真源那条硬规矩就是「档名必须写成调用点里的第一个字符串字面量」。
   * ⚠️ **它仍然看不见什么**：把 `fail` 换个名字（比如包一层 `boom()` 再调）——
   * 那一层包装里的 `fail(` 仍然会被数到，但包装函数自己成了多个抛出点共用的档名出口。
   * 登记在此，档位 LOW：本仓真源今天没有这种包装，而加一层包装是评审看得见的动作。
   */
  it("真源里每个 fail() 调用点的档名互不重复，并集恰好是 FAIL_KINDS", () => {
    const { sites, defs } = failCallSites(readFileSync(REGEX_STRIP_EXEMPT, "utf8"));
    expect(defs, "在真源里找不到 `function fail(` 的定义 ⇒ 这道守卫扫错了地方，它会恒绿")
      .toBeGreaterThan(0);
    expect(
      sites.filter((k) => k === null),
      "有 `fail()` 调用点没把档名写成第一个字符串字面量（用变量传？把 why 写前面了？）"
      + "⇒ 这道守卫从此看不见那个站点。真源的硬规矩：档名必须是调用点里的第一个字符串字面量",
    ).toEqual([]);
    expect(
      sites.filter((k, i) => sites.indexOf(k) !== i),
      "有两个 `fail()` 调用点共用同一个档名 ⇒ 其中一个是**没人验过的可达抛出点**："
      + "运行期那一格只看档名集合，它对「同档名的第二个站点」天然失明（复评 M-K2 实测全绿逃逸）。"
      + "请给新那一档起一个新名字、登记进 `FAIL_KINDS`，并去「判不准要吵」那张表加一行探针",
    ).toEqual([]);
    expect(
      [...sites].sort(),
      "真源的抛出站点与 `FAIL_KINDS` 对不上了",
    ).toEqual([...FAIL_KINDS].sort());
  });

  /**
   * **反向控制：上面那格真的会红 —— 三种形态各一条，全部拿合成源码跑，不碰真源。**
   *
   * 一条恒等于「干净」的断言与一条坏掉的断言长得一模一样。这三条分别对应它声称能接住的
   * 三件事：复用档名 / 档名用变量传 / 注释里的散文不算数。
   */
  it("反向控制：档名守卫认得出复用与变量传，而注释里的散文不算数", () => {
    const real = readFileSync(REGEX_STRIP_EXEMPT, "utf8");
    // ① 复用已有档名的第二个可达抛出点（复评 M-K2 的落点与档名逐字相同）
    const dup = real.replace(
      "if (REGEX_AFTER_PUNCT.has(p.ch)) return true;",
      'if (p.ch === "#") fail(src, pos, "unknownPunct", "复评 M-K2 的落点");\n'
      + "    if (REGEX_AFTER_PUNCT.has(p.ch)) return true;",
    );
    expect(dup, "落点断言：这条变异必须真的落进真源").not.toBe(real);
    const dupKinds = failCallSites(dup).sites;
    expect(dupKinds.filter((k, i) => dupKinds.indexOf(k) !== i), "复用档名逃掉了 ⇒ 上面那格没有鉴别力")
      .toEqual(["unknownPunct"]);
    // ② 档名用变量传 ⇒ 取到的是 why，不是档名
    const viaVar = real.replace('fail(src, i, "unclosedBlock"', "fail(src, i, kindFromSomewhere");
    expect(viaVar, "落点断言：这条变异必须真的落进真源").not.toBe(real);
    expect(
      failCallSites(viaVar).sites.some((k) => k !== null && !FAIL_KINDS.includes(k)),
      "档名用变量传的站点没被认出来 ⇒ 上面那格会放行它",
    ).toBe(true);
    // ③ 注释里的散文不算数（上上一版数字面文本时，这一条会假红并指错地方）
    const prose = real.replace(
      "const VALUE = { kind: \"value\" };",
      "// 散文里写一句 fail(src, pos, \"unknownPunct\", …) 不许被数进去\nconst VALUE = { kind: \"value\" };",
    );
    expect(prose, "落点断言：这条变异必须真的落进真源").not.toBe(real);
    expect([...failCallSites(prose).sites].sort(), "注释里的字面文本被数进来了 ⇒ 假红")
      .toEqual([...FAIL_KINDS].sort());
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
   * 独立重算只按双引号收支扫本行，认不出「这个引号住在一条正则里」。于是同一行上
   * **两条各含奇数个双引号的正则夹着一段注释**时，它会把两条正则里的引号配成一对，
   * 判定那段注释住在字符串里 ⇒ **假红**。
   * · 射程 259 个文件实测 **0 例**（测法：拿真源逐文件跑 `stripComments`/`blankComments`，
   *   数抛出，0 抛出）。
   * · 真撞上时它是一声**响亮的抛**并逐字带上原文那一行，不是静默吞码；改法是把那一行拆开写。
   * ⇒ 这一档宁可留着这一族误伤，也不去猜「这个引号是不是住在正则里」——猜错的方向是致盲。
   * 将来谁把重算做得认得正则了，这一条会红——那是好事，把它删掉即可。
   *
   * ⚠️ **第四轮复评量到的另外三类误伤（注释文本 / 模板串 / CSS 里的撇号与引号）
   * 本轮已经在真源里修掉了**，它们是**合法代码**，判据是「在门禁里跑的东西，
   * 对合法代码假红比漏报更坏」。那六条现在钉在上面「不乱红」那张表里，CSS 那两条在
   * 「CSS 侧同样不许对合法样式假红」那一格。
   */
  it("已知误伤：两条各含奇数个双引号的正则夹着一段注释 ⇒ 独立重算会假红", () => {
    expect(() => stripComments('const a = /"/.test(s); /* c */ const b = /"/.test(t);'))
      .toThrow("住在一个字符串里");
    // 反向控制：只要那一行的引号收支「没结论」（奇数个），这一档就闭嘴，不许乱红。
    expect(() => stripComments('const a = /"/.test(s); /* c */ const b = 1;')).not.toThrow();
    // 反向控制：正当的「注释里带引号」不许红 —— 偶数个也不行。
    expect(() => stripComments('const s = "a"; /* 里面 " 两个 " 引号 */ const t = 1;')).not.toThrow();
  });

  /**
   * **CSS 侧走的是同一条防线，所以同一族假红也要在 CSS 上钉一遍。**
   *
   * `stripCssComments` 与 `stripComments` 共用 `guardOpener()`，第四轮复评在 CSS 上
   * 实测到两条假红（撇号那一族）。CSS 那一侧**今天没有独立裁判**（理由写在
   * `tests/unit/source-guards.test.ts` 的「先验裁判自己 —— 它抠注释、而且看得出真代码被吞」
   * 那一节的 ④ 里），所以这几条手写探针就是它全部的护栏，一条都不能省。
   */
  it.each([
    ["选择器之间两段注释各带一个撇号", "a { color: red } /* don't */ b { color: blue } /* won't */"],
    ["注释里的撇号 + 一个正当的字符串值", 'a { /* it\'s */ content: "x"; } /* don\'t */'],
    ["url() 里的双斜杠不是行注释（CSS 没有行注释这一档）", "a { background: url(//cdn.example/x.png) } /* c */"],
    ["两个字符串值夹一段注释", 'a { content: "x" } /* c */ b { content: "y" }'],
  ])("CSS 侧同样不许对合法样式假红：%s", (_why, src) => {
    expect(() => stripCssComments(src)).not.toThrow();
  });

  /**
   * **已知漏报（登记成断言）：`openerLivesInString()` 闭嘴或答错的那四类。**
   *
   * ⚠️⚠️ **这一格存在的全部理由是「别把那条防线当门」。** 它是一条**概率防线**：
   * 开不开口由**本行双引号的奇偶**决定，而那个量与「哪个斜杠被判反了」毫无关系。
   * 第四轮复评的 X3 在真文件上量过代价：同一行只多一个撇号 ⇒ 它一个字不吵、
   * 负责裸 `console` 的门禁重新报绿 —— **只有测试侧那两条全射程不变量还红着**。
   *
   * 下面每一条都写死了**吞掉的字节数**：这几条变红意味着有人把某一族补上了（好事，
   * 把那一行删掉即可），或者危害档位变了（**要重新复量，别抄这里的数字**）。
   */
  it.each([
    ["本行有反引号 ⇒ 直接闭嘴（复评 X3：同一行只多一个撇号）", "const of = 4; const T = `it's`; const half = of / 2; const P = \"/\"; const U = \"https://x\"; console.log(1);", 21],
    ["毒刺是单引号字符串 ⇒ 单引号一律不数", "const of = 4; const half = of / 2; const P = '/'; const U = 'https://x'; console.log(1);", 21],
    [
      "**确信地答错**：本行双引号是偶数，但奇偶被两条正则里的引号整体错位一格",
      'const of = 4; const R1 = /"/; const half = of / 2; const P = "/"; const U = "https://x"; const R2 = /"/; console.log(1);',
      37,
    ],
  ])("已知漏报：%s", (_why, src, swallowed) => {
    const out = stripComments(src as string);
    expect(src.length - out.length, "吞掉的字节数变了 ⇒ 危害档位要重新复量，别抄这里的数字")
      .toBe(swallowed);
    expect(out, "**这就是致盲**：真代码被静默吞掉，而这条防线一个字都不吵").not.toContain("console.log");
    // 反向控制：同一族只要把那个「让它闭嘴 / 让它答错」的东西拿掉，它必须当场红。
    expect(
      () => stripComments('const of = 4; const half = of / 2; const P = "/"; const U = "https://x"; console.log(1);'),
      "反向控制：这一族的裸形态它必须接住，否则上面那几条漏报证明不了任何事",
    ).toThrow("住在一个字符串里");
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
 *   ⚠️ **这一条不是没人接**（上一轮它确实一层都没有，第四轮复评把那件事量了出来）：
 *   接它的是上面那一节里的「抠掉的每一段在原文里都必须以斜杠开头」——那一格不看语义，
 *   只看差异区间的第一个字节，于是整条纯类型语句被换成空格时它当场红。
 *   **那一格是这一族今天唯一的覆盖层**，动它之前先想清楚这句话。
 * · ③**空白与换行差异看不见**：`transform` 模式会重排格式。
 *  （测法：`judge("foo();")` 与 `judge("\n\n  foo();\n")` 逐字节相等。）
 *   `blankComments` 的行列不变量因此**不能靠这一格**，它靠上面那格的长度/行数两条。
 * · ④**CSS 方言零覆盖**：这一格的射程扩展名表是 `.ts` / `.js` / `.mjs`
 *  （`REGEX_STRIP_SCAN_EXT`），`stripCssComments` 根本没进这一格。
 *   **CSS 那一侧今天没有裁判**——它只有「三个出口」那一节里的手写探针
 *  （`url(//…)` 不许被当行注释、失步报文不许提正则字面量）、④ 那一节里的
 *   「CSS 侧同样不许对合法样式假红」那张表，和 `admin-ui/css` 的体积门禁。
 *   ⚠️⚠️ **本轮显式裁定「不补」，理由写在这里，别读成「还没来得及」**：
 *   ① 本仓没有任何 CSS 解析器，`node:module` 那个裁判只认 JS/TS 家族；
 *   ② 补它就得**新增一个生产/开发依赖**，而这道断言不值得为它加依赖——
 *      这与上面「为什么不是 acorn」是同一条裁定；
 *   ③ 自己写一个 CSS 解析器来对拍，正是本任务要消灭的东西（第二实现）；
 *   ④ 曝光面：射程里 CSS 只有 3 个文件、总量以 KB 计，而 CSS 的注释语义只有
 *      「块注释 + 字符串」两档，比 JS 那一侧窄得多。
 *   ⇒ **CSS 这一侧的承重是那几条手写探针，不是对拍**。哪天 CSS 侧出第二次事故，
 *   或者本仓因为别的理由已经引入了 CSS 解析器，就回来把这一条改掉。
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
 * ⚠️ **「Node 太老」这一条够不着，别把它当成防线，而且上一版写的那个现场是错的（第四轮复评实测）**：
 * 上一版写着「Node 太老时 `import { stripTypeScriptTypes } from "node:module"` 在加载期
 * SyntaxError ⇒ 整份文件收集失败」。那句话只有**直接用老 node 跑那个模块**时才成立；
 * **在本仓 `pnpm test` 这条路径上根本走不到它**——实测 `/usr/bin/node` v18.19.1 跑
 * `node_modules/vitest/vitest.mjs run` ⇒ **`Startup Error`：`rolldown` 里
 * `import { formatWithOptions, styleText } from "node:util"` 报
 * `does not provide an export named 'styleText'`，EXIT=1**。
 * **整个测试运行器先死在启动上**，压根到不了本文件的收集，更到不了下面那条 `typeof` 断言。
 * ⇒ 结果仍然是红（诚实的），但那条 `typeof` 断言永远执行不到，留着只是文档。
 * 真正把版本挡在门外的是 `package.json` 的 `engines.node`（`>=22.13`）**加上仓根 `.npmrc`
 * 里的 `engine-strict=true`**：光有 `engines` 不是门禁——实测 pnpm 默认只打一行
 * `WARN Unsupported engine` 而 **EXIT=0**，加上那一行之后才是
 * `ERR_PNPM_UNSUPPORTED_ENGINE` / **EXIT=1**（两种都在本机同一份 lockfile 上跑过）。
 * CI 那一侧是 `node-version: 22`；本机 `/usr/bin/node` 就是 v18，换个 shell 就能踩到。
 */
const judge = (src: string): string => stripTypeScriptTypes(src, { mode: "transform" });

describe("全射程与真解析器对拍", () => {
  it("先验裁判自己 —— 它抠注释、而且看得出真代码被吞", () => {
    // ⚠️ 这一条**够不着**（Node 太老时整个 vitest 先死在启动上，到不了这里）。
    //    留着是文档，别把它当防线，理由与实测现场写在本节 ⚠️ 那一段里。
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

/**
 * ── 两份 `frameEnd()` 的**函数体**必须逐字节相同 ──────────────────────────────
 *
 * **它为什么存在（实测，不是预防性扩容）**：P3e Task 11 把两处内联的 `indexOf("\n\n")`
 * 提炼成了**两个同名同体的 `frameEnd()`**——`src/core/protocol/sse.ts`（网关读上游）
 * 与 `admin-ui/js/pure/playground.mjs`（面板渲染）。提炼本身是好事，但它把「隐式的重复」
 * 变成了「显式的、跨运行时边界的、有名字的重复」，而**当时没有任何机器要求这两份一致**：
 *
 * | 判据轴 | 单改一份会不会红（阶段 D 收口实测） |
 * |---|---|
 * | 认不认 `\r\n\r\n` | **会红**（两侧红名单互不相交，看协议名就知道坏的是哪份） |
 * | 认不认裸 `\r\r` | **不红** |
 * | LF 优先 vs 取靠前 | **不红**（穷举 66429 个 token 串证明对外可观测行为等价） |
 * | `len: 4` vs `len: 2` | 网关侧**不红** / 面板侧会红（不对称） |
 *
 * 最强的那条是全量跑出来的：只给**网关那份**加上裸 `\r\r` 支持、面板那份一字不动
 * ⇒ `pnpm test` 与 `pnpm test:workers` **两个运行时、三千多条断言，零信号**。
 * ⇒ **四条轴里三条无守卫。** 而 `admin-ui/js/pure/playground.mjs` 里被点名说
 * 「两份实现共享同一套判据」的那一组（`tests/ui/playground.test.ts` 的
 * 「同一段字节喂进去必须给出同一串负载」），5 条样本**全是 LF**
 * ——**被点名的守卫恰好不覆盖新写进去的那条判据。**
 *
 * ⚠️ **P3d 的全分支评审已经因为这两份实现在 `[DONE]` 上分叉记过一条 HIGH，这是同一处
 * 的第二次。** 所以这里不再往行为层补第 N 条样本（那是在追已经想到的那几条轴），
 * 而是**把「两份必须一样」这件事本身钉成一格**：判据从两个真源现抠，不写第三份实现，
 * 任何一侧单独漂——不管漂在哪条轴上——都当场红。
 *
 * ⚠️ **它接不住什么，明写**：
 * · **只比函数体**，不比签名（TS 那份带类型标注，本来就不同，见下面那格反向控制）、
 *   不比上方的说明文字（理由刻意只写一份，见 `playground.mjs` 的 frameEnd docblock）。
 * · **它不判对错**：两份一起改错、一起漂，它照样绿。那一族由行为用例接。
 * · **抠法是「签名行上最后一个 `{` 起，大括号配平」**，不解析字符串。今天两份的函数体里
 *   没有任何含大括号的字符串字面量；哪天有了，抠出来的边界会变——那时这一格会**红**
 *  （两侧抠法一致，但边界一变，比对的东西就不是函数体了），不会静默。
 * · 签名写成跨行时抠不到 ⇒ 返回 `null` ⇒ 下面第一条断言当场红，**不是静默跳过**。
 */
describe("两份 frameEnd 是跨运行时边界的孪生体", () => {
  const GATEWAY = "src/core/protocol/sse.ts";
  const PANEL = "admin-ui/js/pure/playground.mjs";

  /** 签名行（`function frameEnd(...` 那一行）。 */
  function signatureLine(rel: string): string | null {
    const src = readFileSync(rel, "utf8");
    const at = src.indexOf("function frameEnd(");
    if (at === -1) return null;
    const eol = src.indexOf("\n", at);
    return src.slice(at, eol === -1 ? src.length : eol);
  }

  /**
   * 函数体（不含签名、不含最外层那对大括号）。
   * 抠不到一律返回 `null`——调用方必须为此变红，"抠不到就当通过"是这一族门禁最常见的死法。
   */
  function frameEndBody(rel: string): string | null {
    const src = readFileSync(rel, "utf8");
    const at = src.indexOf("function frameEnd(");
    if (at === -1) return null;
    const eol = src.indexOf("\n", at);
    // 签名行上**最后一个** `{` 才是函数体的开括号：TS 那份的返回类型标注
    // （`: { idx: number; len: number } | null`）里也有一个 `{`，取第一个会抠错。
    const open = src.lastIndexOf("{", eol === -1 ? src.length : eol);
    if (open < at) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
    }
    return null;
  }

  it("两份 frameEnd 的函数体逐字节相同 —— 只改一边的话两个运行时都不会有任何信号", () => {
    const gw = frameEndBody(GATEWAY);
    const pg = frameEndBody(PANEL);
    // 自检：抠不到 / 抠成空的时候，下面那句 `toBe` 会变成 `"" === ""` 的恒真，
    // 那正是这一格最容易的死法。**先让抠取本身变红。**
    expect(gw, `在 ${GATEWAY} 里没抠到 frameEnd 的函数体 —— 先来修抠法，别让这一格恒绿`).not.toBeNull();
    expect(pg, `在 ${PANEL} 里没抠到 frameEnd 的函数体 —— 先来修抠法，别让这一格恒绿`).not.toBeNull();
    expect(gw!, "抠出来的函数体里没有 indexOf —— 抠错位置了").toContain("indexOf(");
    expect(pg!, "抠出来的函数体里没有 indexOf —— 抠错位置了").toContain("indexOf(");

    expect(pg, `面板那份 frameEnd 与网关那份分叉了。**两份都得改**：`
      + `裸 \\r、LF 优先 vs 取靠前、len 取 4 还是 2 —— 这三条轴单改一份时，`
      + `node 与 workerd 两套用例一条都不会红（阶段 D 收口全量实测）。`
      + `一份是协议实现、一份是展示端，展示端多说或少说的那几句正是运维最没办法判真伪的`)
      .toBe(gw);
  });

  it("反向控制：两份的签名今天本来就不同，这一格不许因此乱红", () => {
    const gw = signatureLine(GATEWAY);
    const pg = signatureLine(PANEL);
    expect(gw, `在 ${GATEWAY} 里没抠到 frameEnd 的签名行`).not.toBeNull();
    expect(pg, `在 ${PANEL} 里没抠到 frameEnd 的签名行`).not.toBeNull();
    // 仓里真实存在的合法差异：TS 那份带类型标注，`.mjs` 那份不带。
    expect(gw!, "网关那份的签名里没有类型标注了？那上面那格的射程说明要回来改").toContain("buf: string");
    expect(pg!, "面板那份是 .mjs，不该出现 TS 类型标注").not.toContain("buf: string");
    expect(gw).not.toBe(pg);
  });
});

/**
 * ── 分段选择器（`.btn-toggle`）：每个创建点都要带 `aria-pressed` ─────────────────
 *
 * **为什么是源码扫描而不是只写四格 DOM 用例**：DOM 用例只能覆盖它自己点得到的那几组，
 * 而这个控件今天分布在五个板块文件里、还在长。P3e Task 20 开工时的实测形态是
 * **调试台那两组带 `aria-pressed` 并且有对应断言，另外四个板块一处都没有**
 * ——做法早就定下了，只是没铺开，而"没铺开"这件事**在这一格出现之前零信号**。
 *
 * ⚠️ **扫的是「创建点」，不是 grep 命中。** 裸 `grep -n 'btn-toggle' admin-ui/js/sec-*.js`
 * 今天会把三处横向说明的注释一起数进来（models / playground / usage 各一处），
 * 而"把注释也数进去"正是本期 Task 2 刚拆掉的那个形态。所以先走
 * `scripts/lib/strip-comments.mjs` 的 `blankComments`（注释换空格、**行号列位置不变**，
 * 报文才点得准落点），再在**属性对象字面量**这个窗口里判。
 *
 * **边界明写（每一条都由下面的断言或抛错钉着，不是散文）**：
 * · **认得**：`el(…, { …, class: "btn-toggle…", … })` / `elI18n(…, { … })` 这种
 *   **写在属性对象的 `class` 上**的形态——本仓五个板块今天全是这一种。
 * · **认不出就抛**，不是放行：`btn-toggle` 出现在别处（例如 `classList.add("btn-toggle")`、
 *   或者拼在一个更长的 class 串中间）时，`toggleSites()` **抛错并点名 file:line**。
 *   "认不出当没看见"是这一族门禁最常见的死法。
 * · **大括号配平也会抛**：窗口靠字符串感知的大括号配对抠出来，扫完还有没闭合的 `{`
 *   ⇒ 抛错并点名文件。**它不认正则字面量**：一条含引号或含单边大括号的正则会把扫描器带偏，
 *   而带偏之后配平几乎必然失败 ⇒ 抛错。**「今天仓里有没有这种正则」不写成断言里的一句话**
 *   ——配平通过本身就是当天的证据，写一句「今天只有某某一条」反而是一句没人守的话。
 * · **它不判「值对不对」**：`aria-pressed` 恒写死成 `"false"` 它照样绿。那一族由四个板块
 *   各自的 DOM 用例（点第二颗 ⇒ 第一颗转 false、第二颗转 true）接。
 */
describe("分段选择器的每个创建点都带 aria-pressed", () => {
  const SEC_DIR = "admin-ui/js";

  /**
   * 射程：`admin-ui/js/sec-*.js` 全部。**板块文件之间不开豁免名册**——名册会变成永久的洞。
   *
   * ⚠️ **但 `sec-` 这个前缀本身就是一份隐式名册**：`admin-ui/js/` 下所有**不以 `sec-` 开头**
   * 的 `.js`、以及 `admin-ui/js/pure/*.mjs`，全都天然在射程外
   *（那一批不在这里手抄，由下面那条绊线的 `offScopeFiles()` 从盘上枚举）。
   * P3e Task 20 复评实测：在 `admin-ui/js/app.js` 插一处不带 `aria-pressed` 的
   * `class: "btn-toggle"` 创建点 ⇒ **全绿，零信号**。而 `app.js` 自己就在管一组
   * 分段式控件（`.nav-item` + 就地 `classList.toggle("active")`）、`ui.js` 是共用的
   * `el()/elI18n()` 元素工厂 —— 把共用控件工厂挪进 `ui.js` 是很自然的下一步。
   * 那个洞现在由下面「绊线：射程外的 admin-ui js 里今天一处 btn-toggle 都没有」堵着：
   * **它该长大时会红，那是设计，不是故障**——红了就把射程扩到那个文件，别加豁免。
   */
  function sectionFiles(): string[] {
    return readdirSync(SEC_DIR).sort()
      .filter((n) => n.startsWith("sec-") && n.endsWith(".js"))
      .map((n) => join(SEC_DIR, n));
  }

  /** 射程外的那一批：面板 JS 里**不是** `sec-*.js` 的全部（含 `pure/*.mjs`）。 */
  function offScopeFiles(): string[] {
    const top = readdirSync(SEC_DIR).sort()
      .filter((n) => n.endsWith(".js") && !n.startsWith("sec-"))
      .map((n) => join(SEC_DIR, n));
    const pure = readdirSync(join(SEC_DIR, "pure")).sort()
      .filter((n) => n.endsWith(".mjs"))
      .map((n) => join(SEC_DIR, "pure", n));
    return [...top, ...pure];
  }

  type Pair = { open: number; close: number };

  /**
   * 字符串感知的大括号配对。引号 / 模板字面量整段跳过（模板里的 `${…}` 一并跳过，
   * 那对我们要找的属性对象没有影响）。**配不平就抛**，绝不返回一份残缺的配对表。
   *
   * ⚠️ **登记：这是本仓第二个手写的字符串感知扫描器，比真源弱**（P3e Task 20 复评 F7）。
   * `scripts/lib/strip-comments.mjs` 里那套 JS 词法扫描认得出正则字面量（`unclosedRegex`），
   * 这一份不认。**本轮没有改**，理由写在这里而不是在报告里：那份真源今天只导出四个
   * 抠注释函数与 `FAIL_KINDS`，没有「大括号配对」或「把正则字面量一并抹掉」的入口；
   * 要共用就得给它加新导出，而那份真源同时供着注释指向门禁（`scripts/check-comment-refs.mjs`）、
   * i18n 完整性门禁（`scripts/check-i18n.mjs`）与整套测试，自己还带着一格
   * 「真源里每个 fail() 调用点的档名互不重复，并集恰好是 FAIL_KINDS」的元测试
   * ——**那是一整个任务，不是顺手改一行**。
   * 在那之前，这一份靠 **fail-loud** 兜底，两条抛错路径都实测过：
   * 引号那一支（正则里带引号 ⇒ `有一个 " 没闭合`）与大括号那一支（`/[{]/` ⇒ `还有 N 个 { 没闭合`）。
   */
  function bracePairs(src: string, rel: string): Pair[] {
    const pairs: Pair[] = [];
    const stack: number[] = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i++;
        let closed = false;
        while (i < src.length) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === quote) { i++; closed = true; break; }
          i++;
        }
        if (!closed) throw new Error(`${rel}: 有一个 ${quote} 没闭合 —— 扫描器已经失步，别信它的结果`);
        continue;
      }
      if (c === "{") { stack.push(i); i++; continue; }
      if (c === "}") {
        const open = stack.pop();
        if (open === undefined) throw new Error(`${rel}: 多出一个 } —— 扫描器已经失步，别信它的结果`);
        pairs.push({ open, close: i });
        i++;
        continue;
      }
      i++;
    }
    if (stack.length > 0) throw new Error(`${rel}: 还有 ${stack.length} 个 { 没闭合 —— 扫描器已经失步，别信它的结果`);
    return pairs;
  }

  /** 落点渲染成 `路径:行号`。行号来自 `blankComments` 的输出，与原文逐行对齐。 */
  function at(rel: string, blanked: string, idx: number): string {
    return `${rel}:${blanked.slice(0, idx).split("\n").length}`;
  }

  /** 一个创建点：写在属性对象 `class` 上的一处 `btn-toggle`。 */
  function toggleSites(): Array<{ rel: string; where: string; hasAriaPressed: boolean }> {
    const out: Array<{ rel: string; where: string; hasAriaPressed: boolean }> = [];
    for (const rel of sectionFiles()) {
      const blanked = blankComments(readFileSync(rel, "utf8"));
      const pairs = bracePairs(blanked, rel);
      for (const m of blanked.matchAll(/btn-toggle/g)) {
        const idx = m.index ?? -1;
        if (idx < 0) throw new Error(`${rel}: matchAll 没给出落点 —— 扫描器不许在这种情况下继续`);
        const where = at(rel, blanked, idx);
        // 最内层的那一对：属性对象自己。
        let inner: Pair | null = null;
        for (const p of pairs) {
          if (p.open < idx && idx < p.close && (inner === null || p.open > inner.open)) inner = p;
        }
        if (inner === null) {
          throw new Error(`${where}: 这处 btn-toggle 不在任何一对大括号里，扫描器认不出它是什么`);
        }
        const before = blanked.slice(inner.open + 1, idx);
        if (!/\bclass\s*:\s*["'`]$/.test(before)) {
          throw new Error(
            `${where}: 这处 btn-toggle 不是写在属性对象的 class 值开头（例如 classList.add(…)`
            + `、或者拼在一个更长的 class 串中间）。**先回来改判据**，别让它静静放行`,
          );
        }
        const region = blanked.slice(inner.open, inner.close + 1);
        out.push({ rel, where, hasAriaPressed: /["']aria-pressed["']\s*:/.test(region) });
      }
    }
    return out;
  }

  it("sec-*.js 里每一个 btn-toggle 创建点都带 aria-pressed", () => {
    const gaps = toggleSites().filter((s) => !s.hasAriaPressed).map((s) => s.where);
    expect(
      gaps,
      "这几处分段按钮只用 class 表达选中态 —— 读屏用户读不出当前在哪一档。"
      + "照 sec-playground.js 那两组的写法，在属性对象里补一条 aria-pressed",
    ).toEqual([]);
  });

  /**
   * **反向控制：量具自己有鉴别力。**
   * 没有这一格的话，上面那格的扫描写坏成「一个都扫不到」时它恒绿——本仓登记在案的
   * 「判据认不出任何东西 ⇒ 真仓全变绿」那一族。
   *
   * ⚠️ **期望值写成逐文件的清单而不是一个总数**（任务书原本写的是 `.length === 10`）：
   * 总数拦不住「把一颗按钮从这个板块搬到那个板块」，而逐文件的这份连搬家一起拦。
   * 总数由这份清单相加得出，**刻意不再单写一遍**——两个数迟早会互相说谎。
   * ⚠️ 加 / 删按钮组时这一格会红，**那是它在按设计工作**。正确处置是**两件事，不是一件**：
   *   ① 改这里的数字；
   *   ② **连它自己的 DOM 行为用例一起补**（「值真的跟着点击走」那一族，每个板块一格）。
   * **只做 ① 就是把这条覆盖悄悄放掉**：源码扫描不判值，`aria-pressed` 全写死成 `"false"`
   * 它照样绿。这半句以前只写在被 `.gitignore` 掉的任务报告里，等于不在仓库里 ——
   * P3e Task 20 复评点名，现在它同时写在 docblock 和下面那条报文里。
   */
  it("反向控制：今天扫得到的 btn-toggle 创建点逐文件列全", () => {
    const byFile: Record<string, number> = {};
    for (const s of toggleSites()) byFile[s.rel] = (byFile[s.rel] ?? 0) + 1;
    expect(
      byFile,
      "扫得到的创建点变了 —— 要么真加/删了按钮组，要么量具坏了。"
      + "真加了的话：**改完数字还要连它的 DOM 行为用例一起补**（点第二颗 ⇒ 第一颗转 false、"
      + "第二颗转 true），只改数字就是把这条覆盖悄悄放掉 —— 这一格不判 aria-pressed 的值",
    ).toEqual({
      "admin-ui/js/sec-events.js": 2,
      "admin-ui/js/sec-models.js": 2,
      "admin-ui/js/sec-playground.js": 2,
      "admin-ui/js/sec-settings.js": 2,
      "admin-ui/js/sec-usage.js": 2,
    });
  });

  /**
   * **反向控制：「就地改 `aria-pressed`」今天只有一处。**
   *
   * 上面那格扫的是**创建点**，拦「漏写」；它拦不住另一族：一个板块**不重建按钮、
   * 就地改 `.active`**，于是屏幕上换了档而属性还停在首帧
   *（P3d 那次「就地更新够不着盒子外的节点」的同一个形状）。
   * `sec-events.js` 的 `setLevel()` 就是这一族，它因此多写了一行 `setAttribute`。
   * 这一格把「别处没有第二处就地改」变成一条会红的断言 ——
   * 哪天别的板块也改成就地更新，先在这里被看见，再去补它自己的 DOM 用例。
   *
   * ⚠️ **边界明写**：它认得的只有 `setAttribute("aria-pressed"` 这一种写法。
   * 用 `btn.ariaPressed = …` 之类的写法就地改，它看不见（那一族仍然只有各板块
   * 自己的 DOM 用例接得住）。
   */
  it("反向控制：就地改 aria-pressed 的只有 sec-events.js 那一处", () => {
    const byFile: Record<string, number> = {};
    for (const rel of sectionFiles()) {
      const n = [...blankComments(readFileSync(rel, "utf8"))
        .matchAll(/setAttribute\(\s*["']aria-pressed["']/g)].length;
      if (n > 0) byFile[rel] = n;
    }
    expect(
      byFile,
      "有板块改成了「就地改 aria-pressed」——先回来看一眼它的 .active 与 aria-pressed 是不是同生同死",
    ).toEqual({ "admin-ui/js/sec-events.js": 1 });
  });

  /**
   * **绊线：射程是从盘上枚举出来的，不是一张手抄的文件名表。**
   * 没有这一格的话，`sectionFiles()` 写坏成「一个文件都枚举不到」时，上面那格的
   * `toEqual({…})` 会红——但红的原因会被读成"按钮组没了"。这一格先把射程本身钉住。
   */
  it("绊线：射程枚举得到 admin-ui/js/sec-*.js，且不含别的文件", () => {
    const files = sectionFiles();
    expect(files, "一个板块文件都枚举不到 —— 上面两格在对着空气报绿/报红").not.toEqual([]);
    expect(files.every((f) => /^admin-ui\/js\/sec-[a-z-]+\.js$/.test(f)), `枚举到了射程外的文件：${files.join(", ")}`).toBe(true);
    // 仓里真实存在的两个文件：一个有分段选择器、一个没有。两个都得在射程里
    //（"只枚举有 btn-toggle 的那几个"等于让新板块天生豁免）。
    expect(files, "sec-models.js 不在射程里").toContain("admin-ui/js/sec-models.js");
    expect(files, "sec-keys.js 不在射程里 —— 射程不许只收今天有 btn-toggle 的那几个").toContain("admin-ui/js/sec-keys.js");
  });

  /**
   * **绊线：射程外的面板 JS 里今天一处 `btn-toggle` 都没有。**
   *
   * 这一格补的是 `sec-` 前缀那份**隐式豁免名册**（P3e Task 20 复评 F2）：上面几格全都
   * 只看 `sec-*.js`，于是 `app.js` / `ui.js` / `pure/*.mjs` 里冒出来的分段按钮**零信号**
   *（复评实测：在 `app.js` 插一处不带 `aria-pressed` 的创建点 ⇒ 全绿，什么都没说；
   * 本轮回填后把同一处变异再打一次 ⇒ **这一格红并点名 `admin-ui/js/app.js×1`**）。
   *
   * ⚠️ **它红了不等于有 bug，等于射程该长大了**：把那个文件收进 `sectionFiles()`
   *（或者把控件工厂本身收进来），**别在这里加一行豁免**——豁免名册会变成永久的洞。
   *
   * ⚠️ **边界明写**：
   * · 只扫 `admin-ui/js/*.js` 与 `admin-ui/js/pure/*.mjs`，不扫 CSS（`.btn-toggle` 的样式
   *   本来就住在 `admin-ui/css/sections.css`）、不扫 `admin-ui/index.html`
   *  （HTML 喂给 JS 词法扫描器会当场失步，见 `tests/helpers/strip-comments.ts` 文件头）。
   * · 走 `blankComments` 抠注释，与上面那几格**共用同一份判据**：
   *   射程外的注释里提一句 `btn-toggle` 不算数，创建点才算。
   */
  it("绊线：射程外的 admin-ui js 里今天一处 btn-toggle 都没有", () => {
    const off = offScopeFiles();
    expect(off, "射程外一个文件都枚举不到 —— 这一格在对着空气报绿").not.toEqual([]);
    // 仓里真实存在的两个射程外文件：共用元素工厂，以及自己在管一组分段式导航的那个。
    expect(off, "ui.js 没被枚举到 —— 共用元素工厂正是最可能长出 btn-toggle 的地方").toContain("admin-ui/js/ui.js");
    expect(off, "app.js 没被枚举到").toContain("admin-ui/js/app.js");
    const hits = off
      .map((rel) => ({ rel, n: [...blankComments(readFileSync(rel, "utf8")).matchAll(/btn-toggle/g)].length }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.rel}×${x.n}`);
    expect(
      hits,
      "射程外的面板 JS 里出现了 btn-toggle —— 上面那几格**看不见它**（它们只收 sec-*.js）。"
      + "把这个文件收进 sectionFiles() 的射程，别在这里加豁免",
    ).toEqual([]);
  });
});

/**
 * ── `.btn-toggle.active` 与 `.badge` 一族：状态不许只由颜色表达（WCAG 1.4.1）──────
 *
 * `.btn-toggle.active` 原来只改 `color` 与 `border-color`。P3e Task 20 在真浏览器上
 * 量过（触屏模拟 `(hover: none)` + `(pointer: coarse)`）：选中与未选中两颗按钮的
 * `font-weight` 都是 400、`text-decoration` 都是 none、`::before` / `::after` 都没有
 * ⇒ **差别只有颜色**。这一格钉的就是"至少还有一条非颜色声明"。
 *
 * **它接不住什么，明写**：这是纯文本扫描。它不渲染、不算对比度，也不知道那条非颜色
 * 声明**看不看得出来**（把 `font-weight: 600` 改成 `font-weight: 401` 它照样绿）。
 * 那一族只能靠真机截图，而截图不是会自己红的守卫——两半分工不同，都不许省。
 *
 * ⚠️⚠️ **判据是逐条声明的属性名，不是「整块里找子串」**（P3e Task 20 复评实测打穿过一次，
 * 回填时换掉）：第一版写的是 `body.includes("text-decoration")` / `body.includes("outline")`，
 * 而 `text-decoration-color` / `outline-color` **本身就是颜色属性**、却逐字包含那两个串
 * ⇒ 把两条声明分别换成它们，两个测试文件**全绿放行**，真机 computed 退回
 * `text-decoration-line: none` / `outline-style: none` / `font-weight: 400`，**屏幕与修复前同形**。
 * 现在的判据住在 `tests/helpers/css-decls.ts`（`visibleNonColorDecls()`），
 * `-color` 那一族由 `isColorProp()` 剔掉。**别在这里再手写一份**。
 */
describe("状态不许只由颜色表达", () => {
  /** 抠 CSS 一律走**只认块注释**的那一档：CSS 没有 `//` 行注释。 */
  const stripCss = stripCssComments;

  const SECTIONS_CSS = "admin-ui/css/sections.css";

  /**
   * 非颜色线索的**简写名**白名单，逐条手写。判据不是"包含这个串"，而是
   * 「属性名等于它、或是它的长写（`text-decoration-line` / `outline-style` …）」，
   * 并且 `-color` 那一族先被剔掉 —— 逐条见 `tests/helpers/css-decls.ts`。
   */
  const NON_COLOR = ["font-weight", "text-decoration", "box-shadow", "outline"];

  /** 一条规则的声明块。抠不到一律 `null`——"抠不到就当通过"是这一族最常见的死法。 */
  function ruleBody(css: string, selector: string): string | null {
    const re = new RegExp(`${selector.replace(/[.\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
    const m = re.exec(css);
    return m === null ? null : m[1]!;
  }

  it(".btn-toggle.active 至少有一条非颜色声明 —— 只改颜色的话触屏与色觉障碍用户拿不到选中态", () => {
    const css = stripCss(readFileSync(SECTIONS_CSS, "utf8"));
    const body = ruleBody(css, ".btn-toggle.active");
    expect(body, `${SECTIONS_CSS} 里找不到 .btn-toggle.active 这条规则 —— 先来修抠法`).not.toBeNull();
    expect(body!.trim(), "抠出来的是空块 —— 抠错了，下面那条会变成恒真").not.toBe("");
    expect(
      visibleNonColorDecls(body!, NON_COLOR).map((d) => d.prop),
      `.btn-toggle.active 只剩颜色声明了（抠到的是 \`${body!.trim()}\`）。`
      + `⚠️ \`outline-color\` / \`text-decoration-color\` 这一族**不算数**，它们本身就是颜色属性。`
      + `这是五个板块共用的类，别只给某一个板块另加新类 —— 那是 sec-models.js 与 sec-usage.js 亲口否掉的做法`,
    ).not.toEqual([]);
  });

  /**
   * **反向控制：同一个量具对着仓里真实存在的另一条规则不许乱报有。**
   * `.btn-toggle`（未选中的底样式）今天只有间距 / 字体继承 / 颜色 / 边框，
   * 这四条一条都没有 —— 量具若把 `font: inherit` 读成 `font-weight`、
   * 或者干脆退化成"在整份 CSS 里找子串"，这一格会红。
   */
  it("反向控制：同一个量具对着 .btn-toggle 底样式报「没有非颜色声明」", () => {
    const css = stripCss(readFileSync(SECTIONS_CSS, "utf8"));
    const body = ruleBody(css, ".btn-toggle");
    expect(body, "连底样式都抠不到了 —— 抠法坏了").not.toBeNull();
    expect(body!, "抠到的不是 .btn-toggle 底样式（它该有 padding）").toContain("padding");
    expect(
      visibleNonColorDecls(body!, NON_COLOR).map((d) => d.prop),
      "量具在 .btn-toggle 底样式上报出了非颜色声明 —— 它多半在整份 CSS 里瞎找，上面那格的绿不算数",
    ).toEqual([]);
  });

  /**
   * **反向控制（用仓里真实存在的串）：颜色属性的分类是对的。**
   * `.btn-toggle.active` 今天逐字是 `color` / `border-color` / `font-weight` 三条 ——
   * 前两条必须被判成颜色、第三条必须被判成非颜色。
   * `isColorProp()` 退化成恒 `false` 时这一格红；退化成恒 `true` 时上面第一格红。
   */
  it("反向控制：.btn-toggle.active 那三条声明的颜色/非颜色分类逐条对得上", () => {
    const css = stripCss(readFileSync(SECTIONS_CSS, "utf8"));
    const body = ruleBody(css, ".btn-toggle.active");
    expect(body, "抠不到 .btn-toggle.active").not.toBeNull();
    // 期望值手写字面量，不是从被测对象读出来再回填。
    expect(
      declarations(body!).map((d) => `${d.prop}=${isColorProp(d.prop) ? "色" : "非色"}`),
      "抠出来的声明清单变了 —— 要么这条规则真改了，要么切分/分类坏了",
    ).toEqual(["color=色", "border-color=色", "font-weight=非色"]);
  });

  /**
   * **判据自证：复评实测打穿过的那两条写法，现在会被判成「不算数」。**
   *
   * ⚠️ 这两条**不是**仓里存在的串——本仓今天一条 `text-decoration-color` / `outline-color`
   * 声明都没有（`.btn-toggle.active` 里那条 `border-color` 是另一回事，它由上面那格
   * 「反向控制：.btn-toggle.active 那三条声明的颜色/非颜色分类逐条对得上」用真串守着）——
   * 所以它只能是夹具。它守的是**判据本身**：`isColorProp()` 一旦放松，这一格立刻红，
   * 不必等到有人真去改 `sections.css`。真仓那一侧由上面第一格守着，两层分工不同。
   * 夹具里的字符串逐字取自 P3e Task 20 复评的 M-G-a / M-G-b 两条变异。
   */
  it("判据自证：text-decoration-color / outline-color 不算「非颜色线索」", () => {
    expect(
      visibleNonColorDecls("text-decoration-color: red;", NON_COLOR).map((d) => d.prop),
      "`text-decoration-color` 被当成了非颜色线索 —— 它本身就是颜色属性",
    ).toEqual([]);
    expect(
      visibleNonColorDecls("color: var(--text); border-color: var(--primary); outline-color: red;", NON_COLOR)
        .map((d) => d.prop),
      "`outline-color` 被当成了非颜色线索 —— 它本身就是颜色属性",
    ).toEqual([]);
    // 同一个夹具换成长写里**不是**颜色的那一支，必须认得出来 —— 否则上面两条会退化成恒真。
    expect(
      visibleNonColorDecls("text-decoration-line: line-through; outline-style: solid;", NON_COLOR)
        .map((d) => d.prop),
      "长写里不是颜色的那一支也被剔掉了 —— 判据把 `-color` 那一族之外的一起误杀了",
    ).toEqual(["text-decoration-line", "outline-style"]);
    // 逐字把自己关掉的取值同样不算数（本仓遗留：`font-weight: 401` 这种它仍然接不住）。
    expect(
      visibleNonColorDecls("text-decoration: none; outline: 0; font-weight: normal;", NON_COLOR)
        .map((d) => d.prop),
      "`text-decoration: none` 这种「声明还在、逐字把自己关掉」的写法被放行了",
    ).toEqual([]);
  });
});

/**
 * ── 主题 token 与 WCAG 对比度的**共用量具**（下面两个 describe 各用一半）─────────
 * 一份实现两个消费者：`--muted` 的正文对比度下限（1.4.3）与轮询状态灯的非文字
 * 对比度下限（1.4.11）。**别再各写一份**——两份不同实现给出不同答案时绿的那份会赢。
 */
const BASE_CSS = "admin-ui/css/base.css";

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!.toLowerCase();
  return out;
}

/** 亮 / 暗两个 `:root` 块各自的 token 表。抠不到一律 `null`。 */
function themeTokens(theme: "light" | "dark"): Record<string, string> | null {
  const css = stripCssComments(readFileSync(BASE_CSS, "utf8"));
  const head = theme === "light" ? ":root {" : ':root[data-theme="dark"] {';
  const at = css.indexOf(head);
  if (at === -1) return null;
  const end = css.indexOf("}", at);
  if (end === -1) return null;
  return tokens(css.slice(at, end));
}

/** WCAG 相对亮度 + 对比度。**公式手写，不引依赖**（全局约束：本期不新增依赖）。 */
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * ── 轮询状态灯：**非文字**状态指示的对比度下限（WCAG 1.4.11，P3e Task 20 复评 F3）──
 *
 * 上一版这里只量了**文字**对比度（下一个 describe），于是同一个板块里的
 * `.poll-dot` 三态**在两个主题下都看不见**却零信号：`--ok-fg` / `--danger-fg` 是
 * 「画在有色底上的前景色」，亮色里两个逐字都是 `#ffffff` ⇒ 轮询中那颗是纯白点画在
 * 纯白卡上，而且「轮询中」与「出错」**同色**。真机复量证实了这一条，本轮把三态改成
 * `--ok` / `--muted` / `--danger`，并把下限变成会自己红的断言。
 *
 * **它接不住什么，明写**：
 * · 只认 `background: var(--token)` 这一种写法。写成字面色值或 `color-mix(…)`
 *   ⇒ **抠不到、当场抛**，不是静默放行。
 * · 底色是**手写枚举**的三种（同下一个 describe 的理由），不是从用法里推出来的。
 * · 它不判**形状**：三态今天只有颜色差，红绿两态在亮色下几乎等亮度 —— 那一条由本组
 *   最后一格**登记成断言**（不是散文），修好了它会红。
 */
describe("轮询状态灯：非文字状态指示（WCAG 1.4.11）", () => {
  const SECTIONS_CSS = "admin-ui/css/sections.css";
  /** 三态各自的类名，逐条手写。 */
  const DOTS = [".poll-dot-active", ".poll-dot-paused", ".poll-dot-error"] as const;
  /** 状态灯今天可能落在哪几种底色上。手写枚举，同 `--muted` 那一格的理由。 */
  const SURFACES = ["--bg", "--panel", "--panel-2"] as const;

  /** 从 `sections.css` 抠出一个类的 `background: var(--x)` 里那个 token 名。抠不到就抛。 */
  function dotToken(cls: string): string {
    const css = stripCssComments(readFileSync(SECTIONS_CSS, "utf8"));
    const m = new RegExp(`\\${cls}\\s*\\{([^}]*)\\}`).exec(css);
    if (m === null) throw new Error(`${SECTIONS_CSS} 里找不到 ${cls} 这条规则 —— 先回来改抠法`);
    const v = /background\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/.exec(m[1]!);
    if (v === null) {
      throw new Error(
        `${cls} 的 background 不是 \`var(--token)\` 形态（抠到的是 \`${m[1]!.trim()}\`）——`
        + "这一格只认那一种写法，**先回来改判据**，别让它静静放行",
      );
    }
    return v[1]!;
  }

  it("三态的取值在每个主题下互不相同 —— 同色等于少一态", () => {
    for (const theme of ["light", "dark"] as const) {
      const tk = themeTokens(theme);
      expect(tk, `${BASE_CSS} 里抠不到 ${theme} 的 token 块`).not.toBeNull();
      const seen = DOTS.map((c) => {
        const name = dotToken(c);
        const val = tk![name];
        expect(val, `${theme}: 抠不到 ${c} 用的 ${name}`).not.toBe(undefined);
        return `${c}=${val}`;
      });
      expect(
        new Set(seen.map((s) => s.split("=")[1]!)).size,
        `${theme} 主题下轮询状态灯有两态同色（${seen.join(" / ")}）——`
        + "屏幕上「轮询中」与「出错」长得一模一样",
      ).toBe(DOTS.length);
    }
  });

  it("三态画在三种底色上都不低于 3:1（WCAG 1.4.11 非文字对比度）", () => {
    for (const theme of ["light", "dark"] as const) {
      const tk = themeTokens(theme);
      expect(tk, `${BASE_CSS} 里抠不到 ${theme} 的 token 块`).not.toBeNull();
      for (const cls of DOTS) {
        const name = dotToken(cls);
        const fg = tk![name];
        expect(fg, `${theme}: 抠不到 ${cls} 用的 ${name}`).not.toBe(undefined);
        for (const surface of SURFACES) {
          const bg = tk![surface];
          expect(bg, `${theme}: 抠不到 ${surface}`).not.toBe(undefined);
          const cr = contrast(fg!, bg!);
          expect(
            cr >= 3,
            `${theme} 主题下 ${cls}(${name} = ${fg}) 画在 ${surface}(${bg}) 上只有 ${cr.toFixed(2)}:1，`
            + "低于 WCAG 1.4.11 对非文字指示的 3:1 —— 屏幕上这颗点看不见。"
            + "⚠️ `--ok-fg` / `--danger-fg` 那一族是**画在有色底上的前景色**，不是拿来画在卡片上的",
          ).toBe(true);
        }
      }
    }
  });

  /**
   * **反向控制：量具对着旧的那一对取值确实报坏。**
   * 没有这一格的话，`dotToken()` / `contrast()` 一起退化成"什么都过"时上面两格恒绿。
   * `--ok-fg` / `--danger-fg` 是仓里**真实存在**的两个 token，正是这次换掉的那一对。
   */
  it("反向控制：换回 --ok-fg / --danger-fg 那一对，量具当场报「同色」且「不到 3:1」", () => {
    for (const theme of ["light", "dark"] as const) {
      const tk = themeTokens(theme)!;
      expect(
        tk["--ok-fg"],
        `${theme}: --ok-fg 与 --danger-fg 不再是同一个取值了 —— 这一格是用来证明上面那格认得出旧缺陷的，`
        + "回来换一对新的反例，或者删掉它并写明为什么不再需要",
      ).toBe(tk["--danger-fg"]);
      expect(
        contrast(tk["--ok-fg"]!, tk["--panel"]!) < 3,
        `${theme}: --ok-fg 画在 --panel 上现在过 3:1 了 —— 同上，回来换反例`,
      ).toBe(true);
    }
  });

  /**
   * **已登记的欠账（是断言，不是散文）**：三态只有颜色差，而 `--ok` 与 `--danger`
   * 在亮色主题下**亮度几乎相同** ⇒ 红绿色觉障碍用户分不出「轮询中」与「出错」。
   * 今天兜底的是 `sec-events.js` 给状态灯挂的 `title` / `aria-label` 文字。
   * 真修要给三态各一个形状差（圆 / 方 / 菱形），那是结构改动，本轮按搬运风险登记不做。
   * ⚠️ **这一格红了是好事**：说明有人把它修好了 —— 把它删掉，并把
   * `admin-ui/css/sections.css` 里那段「仍然欠着」的注释一起删掉。
   */
  it("已登记的欠账：亮色下 --ok 与 --danger 几乎等亮度，红绿色觉障碍分不出这两态", () => {
    const tk = themeTokens("light")!;
    const cr = contrast(tk["--ok"]!, tk["--danger"]!);
    expect(
      cr < 3,
      `亮色下 --ok(${tk["--ok"]}) 与 --danger(${tk["--danger"]}) 之间已经有 ${cr.toFixed(2)}:1 了 ——`
      + "这条欠账被修好了，把这一格与 sections.css 里那段登记一起删掉",
    ).toBe(true);
  });
});

/**
 * ── `--muted` 的对比度下限（WCAG 1.4.3 AA，P3e Task 20 真机实测）────────────────
 *
 * `--muted` 不只画"次要说明文字"：`.badge` 的底样式、表头 `th`、未选中的 `.btn-toggle`
 * 全是 `--muted` 画在 `--panel-2` 上，而那是本面板对比度最紧的一对。
 * 亮色那份原来是 `#6b7280`，在 `#f0f1f5` 上量出来 4.28:1 —— 低于 4.5:1。
 * 这个读数**不是抄来的**：把 token 改回 `#6b7280`，下面那格会把它算出来的比值逐字打进报文。
 * 真浏览器五语言 × 两主题冒烟（每格逐板块遍历所有带文字的元素）：
 * **亮色那五格逐格都量出不达标元素、深色那五格 0 处，五种语言逐格同数**
 * ⇒ 是 token 的事，不是文案的事。
 * ⚠️ **具体条数刻意不写**（P3e Task 20 复评 F4）：它随当时渲染了几行模型目录漂
 *（`.badge-off` 是大头），写下来就是一个复现不出来、又没有测法的数。
 *
 * **它接不住什么，明写**：
 * · 只算 `--muted` 这一个前景色在三种底色上的比值。别的组合（`--warn-fg` 画在
 *   `--warn` 上之类）不在这一格里 —— 那一族由真机冒烟接，而真机冒烟不会自己红。
 *   **例外是 `.poll-dot` 那三态**，本轮已经单独立了一个 describe（上面那组）。
 * · 只认 `#rrggbb`。token 改成 `rgb(…)` / `color-mix(…)` 时**抠不到 ⇒ 断言当场红**，
 *   不是静默跳过。
 * · 它不知道**实际画在哪个底色上**：三种底色是手写枚举的，不是从用法里推出来的。
 */
describe("--muted 在三种底色上都过 4.5:1", () => {
  /** `--muted` 今天真正落在哪几种底色上：面板底、卡片底、次级块底。手写枚举。 */
  const SURFACES = ["--bg", "--panel", "--panel-2"] as const;

  it("量具自证：黑白是 21:1，同色是 1:1", () => {
    // 手写字面量，不是从被测对象算出来再回填。
    expect(Math.round(contrast("#000000", "#ffffff"))).toBe(21);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
  });

  it("反向控制：亮暗两块是分开抠的，没有互相串味", () => {
    const light = themeTokens("light");
    const dark = themeTokens("dark");
    expect(light, `${BASE_CSS} 里抠不到亮色 :root 块`).not.toBeNull();
    expect(dark, `${BASE_CSS} 里抠不到深色 :root 块`).not.toBeNull();
    // 仓里真实存在的两个取值，各自只属于一块。串味 / 抠成同一块时这两条会红。
    expect(light!["--panel"], "亮色的 --panel 不是纯白了？那三种底色的枚举要回来重新表态").toBe("#ffffff");
    expect(dark!["--bg"], "抠到的深色块不对").toBe("#14161a");
  });

  it("亮暗两套主题下，--muted 画在三种底色上都不低于 4.5:1", () => {
    for (const theme of ["light", "dark"] as const) {
      const tk = themeTokens(theme);
      expect(tk, `${BASE_CSS} 里抠不到 ${theme} 的 token 块`).not.toBeNull();
      const fg = tk!["--muted"];
      expect(fg, `${theme}: 抠不到 --muted（改成 rgb()/color-mix() 了？先回来改抠法）`).not.toBe(undefined);
      for (const surface of SURFACES) {
        const bg = tk![surface];
        expect(bg, `${theme}: 抠不到 ${surface}`).not.toBe(undefined);
        const cr = contrast(fg!, bg!);
        expect(
          cr >= 4.5,
          `${theme} 主题下 --muted(${fg}) 画在 ${surface}(${bg}) 上只有 ${cr.toFixed(2)}:1，低于 WCAG 1.4.3 AA 的 4.5:1。`
          + `--muted 画的不只是说明文字 —— .badge、表头 th、未选中的 .btn-toggle 全走它`,
        ).toBe(true);
      }
    }
  });
});
