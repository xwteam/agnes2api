import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * **硬规则 1 的另一半：不许把 `js/pure/*.mjs` 里已经导出的判据抄回板块文件。**
 *
 * ⚠️⚠️ **这道扫描是评审探针实测出来的方向性缺口，它的边界被自己咬过一次。**
 *
 * `admin-ui/README.md` 硬规则 1 今天只有 `scripts/build-ui.mjs` 守住
 * 「`pure/*.mjs` 里不许出现 `import` / `document` / `window`」这**一个**方向
 * ——它拦得住「pure 模块自己违规」，拦不住「把 pure 已经导出的判据原样抄一份回
 * 板块文件、pure 里那份留成死代码」。P3c Task 4 的评审实测过：
 * 把 `pure/keys-write.mjs` 新增的全部函数抄回 `sec-keys.js`，138/138 全绿。
 *
 * **本任务（Task 6）把它从「一个模块 + 一种声明形式」扩到「全部模块 + 两种形式」**，
 * 起因同样是一次实测，而不是预防性扩容：Task 4 交接时量过——
 * **把 `fmtDash` 从 `pure/format.mjs` 抄进板块文件，全仓零信号**（旧判据只扫
 * `pure/keys-write.mjs` 一个模块），而 `fmtDash` 恰恰是「绝不伪造 0」那条产品
 * 不变式的落点。箭头函数形式（`const fmtDash = (v) => …`）同样绕得过去。
 *
 * ⚠️ **它原来住在 Key 池板块那个 DOM 用例文件里**（P3c Task 4 加的）——一道全仓级的
 * 结构门禁长在一个板块专用的文件里，扩到别的模块之后那个家就不成立了。
 * 本任务把它**移**到这里，实现照搬（判据没变，只是范围与形式变宽）。
 *
 * **这道扫描抓的是「板块文件里重新声明了那个名字」这个动作本身，不关心抄回去的
 * 实现对不对**——那正是它能便宜地成立的原因，也是它的边界。
 */

/** `admin-ui/js/pure/` 下的全部模块。**从磁盘扫，不写死清单**：写死的话，
 *  新增一个 pure 模块时它会静默地不被覆盖，而那正是本次要修的那种漂移。 */
function pureModules(): string[] {
  const dir = "admin-ui/js/pure";
  return readdirSync(dir).sort().filter((n) => n.endsWith(".mjs")).map((n) => join(dir, n));
}

/** `admin-ui/js/` 下的板块文件（`sec-*.js`）。 */
function sectionFiles(): string[] {
  const dir = "admin-ui/js";
  return readdirSync(dir).sort().filter((n) => /^sec-.*\.js$/.test(n)).map((n) => join(dir, n));
}

/**
 * 一个 pure 模块导出的全部**函数名**，两种声明形式都收：
 * · `export function name(` —— 旧判据只认这一种；
 * · `export const name = (…) =>` / `export const name = function` —— 同样是导出一个
 *   可调用的判据，抄回板块文件的后果一模一样。
 *
 * **不收 `export const NAME = [...]` 这类值常量**：判据是「重新声明了同名的
 * **函数**」，而板块文件里出现一个同名的局部常量（比如把 `CHANNELS` 拷一份）
 * 是另一件事，需要另一套判据（见下面 `KNOWN_BLIND_SPOTS`）。
 */
function exportedFunctionNames(pureFile: string): string[] {
  const src = readFileSync(pureFile, "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/^export function (\w+)\s*\(/gm)) names.add(m[1]!);
  for (const m of src.matchAll(/^export const (\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/gm)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

/**
 * **这道扫描明写自己拦不住什么**，不假装「绿了就等于判据没有第二份」：
 * · **改名抄**（`function dashOf(v)` 里放 `fmtDash` 的实现）——按名字扫天生抓不住；
 * · **值常量被拷贝**（把 `CHANNELS` 拷成板块文件里的一个局部数组）——判据只认
 *   函数声明，那一类要靠「单一真源」式的专项用例（`sec-keys.js` 与 `sec-registrar.js`
 *   共用同一个 `CHANNELS` 由 `tests/ui/dom/registrar-section.test.ts` 的
 *   「两张卡在 DOM 里的先后恒为 moemail、yyds（字母序）」那一格间接兜着）；
 * · **判据被内联成一段表达式**（不声明函数，直接在渲染里写 `v === null ? "—" : …`）。
 * 这三类留给代码评审，与 `tests/unit/source-guards.test.ts` 的
 * 「已知抓不住的写法确实抓不住（边界是断言，不是散文）」那一格背后的 `BLIND_SPOTS`
 * 是同一套「把边界写成会变红的断言」的做法。
 */
const KNOWN_BLIND_SPOTS = [
  "改名抄：按名字扫抓不住",
  "值常量被拷贝：判据只认函数声明",
  "判据被内联成一段表达式：连声明都没有",
];

describe("硬规则 1 的另一半：sec-*.js 不许重新声明 pure/*.mjs 已导出的函数名", () => {
  it("扫描范围本身不是空的——八个 pure 模块、四个板块文件都得真的被扫到", () => {
    // 反向自检：下面那条相等断言在「一个文件都没扫到」时同样是绿的。
    // 数字手写，改动 admin-ui 的文件结构时必须回来表态。
    expect(pureModules().length, "pure 模块数变了").toBe(9);
    expect(sectionFiles().length, "板块文件数变了").toBe(4);
  });

  it("全部 pure 模块的导出函数名，一个都不许在 sec-*.js 里被重新声明", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const pure of pureModules()) {
      const names = exportedFunctionNames(pure);
      scanned += names.length;
      for (const file of sectionFiles()) {
        const src = readFileSync(file, "utf8");
        for (const name of names) {
          if (new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(src)
            || new RegExp(`\\bconst\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`).test(src)) {
            offenders.push(`${file.split("\\").join("/")}: ${name}（来自 ${pure}）`);
          }
        }
      }
    }
    // 反向自检：扫描本身得先找到点什么，否则上面的循环恒绿。
    // **手写下界，不从扫描结果推导**：Task 4 那一版只扫一个模块时是 5 个以上，
    // 扩到全部模块之后实测 60 个上下，这里取 50 作为「扫描没坏」的下界。
    expect(scanned, "一个导出函数都没扫到，扫描本身坏了").toBeGreaterThan(50);
    expect(
      offenders,
      "pure/*.mjs 里已经导出的判据被复制回了板块文件——硬规则 1 只守「pure 自己别违规」"
      + "这一个方向，守不住「抄回板块文件、pure 里留死代码」这个方向，这条扫描就是补那一半",
    ).toEqual([]);
  });

  /**
   * **反向自检，证明这道扫描真的会红**：把 Task 4 交接时实测到的那个逃逸
   *（`fmtDash` 抄进板块文件）与箭头函数形式各重放一次，确认两种都抓得到。
   * 不改真实源文件——在内存里拼一份等价的坏文本，跑同一套判据。
   */
  it("反向自检：fmtDash 被抄进板块文件（两种声明形式）都抓得到", () => {
    const names = exportedFunctionNames("admin-ui/js/pure/format.mjs");
    expect(names, "前置条件：fmtDash 得真的是 format.mjs 导出的").toContain("fmtDash");

    const declared = 'function fmtDash(v) { return v === null ? "—" : String(v); }';
    const arrow = 'const fmtDash = (v) => (v === null ? "—" : String(v));';
    for (const bad of [declared, arrow]) {
      const hit = names.some((name) => new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(bad)
        || new RegExp(`\\bconst\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`).test(bad));
      expect(hit, `这种写法没被抓到：${bad}`).toBe(true);
    }
  });

  it("反向自检：箭头函数形式的导出也被算进「已导出的函数名」里", () => {
    // 判据本身的自检：只认 `export function` 的话，任何 `export const f = (…) => …`
    // 都会连同它的名字一起从扫描范围里消失（旧判据正是这样）。
    const src = "export const alpha = (a) => a;\nexport const beta = async (b) => b;\nexport const GAMMA = [1];\n";
    const names = new Set<string>();
    for (const m of src.matchAll(/^export function (\w+)\s*\(/gm)) names.add(m[1]!);
    for (const m of src.matchAll(/^export const (\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/gm)) {
      names.add(m[1]!);
    }
    expect([...names].sort()).toEqual(["alpha", "beta"]);
  });

  it("盲区清单不是空的——如实登记按名字扫拦不住的那几类", () => {
    expect(KNOWN_BLIND_SPOTS.length).toBeGreaterThan(0);
  });
});
