import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../helpers/strip-comments.js";

/**
 * **复评必改④：替身能力扫描门禁。**
 *
 * ⚠️⚠️ **这道门禁存在的理由是一个已经上线过的真实缺陷**：`admin-ui/js/ui.js`
 * 的 `focusableIn()`（modal 焦点陷阱用它找可聚焦元素）第一版写的是 `root.walk()`
 * ——`walk()` 是 `tests/helpers/fake-dom.ts` 里 `FakeElement` 自己发明的方法，
 * **真实浏览器的 DOM 元素上根本不存在这个方法**。388 条 DOM 用例全绿，因为
 * `FakeElement` 碰巧也实现了同名的 `.walk()`；真机 Playwright 冒烟一测，
 * `TypeError: root.walk is not a function`，Tab 焦点陷阱在生产环境完全失效。
 * 这是第七种假阳性形态的一个新变体：**测试替身实现了真实对象没有的能力，
 * 而且恰好用了一个"看起来很像真实 DOM API"的名字**，没有人会去查它是不是真的
 * 存在于 `Element.prototype` 上。
 *
 * **这道门禁只做一件事**：认定 `tests/helpers/fake-dom.ts` 上一小撮命名会让人
 * 误以为"这是真实 DOM API"、但实际上**真实浏览器的 DOM 上不存在同名成员**的
 * 能力，扫描 `admin-ui/js/**`（发货代码，不含测试）有没有把它们当成真的在用。
 *
 * ⚠️ **这份"哪些是假的"清单是手工维护的，不是从 fake-dom.ts 自动派生的**——
 * `FakeElement` 同时也实现了大量**名字是真的、只是行为或返回类型跟真实 DOM
 * 不完全一致**的成员（`querySelectorAll()`/`children` 返回真数组而不是
 * `NodeList`/`HTMLCollection`、`submit()` 会派发事件而真实 `HTMLFormElement.submit()`
 * 不会、`.disabled` 挂在每一个元素而不只是表单控件）。**光按名字扫描这一半是抓不到的**
 * ——名字本身没有问题，问题在语义。
 *
 * ⚠️ **但"抓不到"不等于"没法抓"**（全分支评审 m3）：前两个的**具体危险写法**
 *（返回值后面紧跟一个数组方法）是可以按形态扫的，本轮已经把这两条形态加进上面那张表
 * ——`querySelectorAll(...).map(…)` 与 `.children.map(…)` 现在会被判成违规。
 * 剩下的（`submit()` 语义相反、`.disabled` 挂错宿主、把返回值先存进变量再调数组方法）
 * 仍然抓不到，如实记在下面的 `KNOWN_BLIND_SPOTS` 里，那一半只能靠代码评审 + 真机冒烟。
 */

/**
 * 只在真实 DOM 上不存在、且这份夹具用了容易被误认成"真实 API"名字的成员。
 *
 * `fixtureName`：反向自检去 `fake-dom.ts` 里找的那个名字。**只有在从 `label` 推不出来
 * 的时候才给**（`label` 的推导规则是「去掉开头的 `.` 与结尾的 `()`」，对
 * `querySelectorAll()` / `.children` 这种"名字真、返回类型假"的条目够用，
 * 但如果哪天有人把 `label` 写成一句话就推不出来了）。
 */
const FAKE_ONLY_MEMBERS: Array<{ pattern: RegExp; label: string; why: string; fixtureName?: string }> = [
  {
    pattern: /\.walk\(/g,
    label: ".walk()",
    why: "FakeElement 自制的「深度优先取全部后代」方法，Element.prototype 上不存在，"
      + "已经在 focusableIn() 里咬过一次（真机 TypeError）。板块代码要遍历子树，"
      + "该用 .children 递归（真实 DOM 属性）。",
  },
  {
    // `\b` 已经排除了 `.parentNode` / `.parentElement`——"parent" 后面紧跟着
    // 单词字符（N/E）时词边界不成立，不需要额外的否定断言。
    pattern: /\.parent\b/g,
    label: ".parent",
    why: "真实 DOM 上没有 .parent 这个属性，只有 .parentNode / .parentElement。"
      + "FakeElement 却叫它 .parent——生产代码一旦写成 .parent，真机上恒为 undefined。",
  },
  {
    pattern: /\.input\(/g,
    label: ".input()",
    why: "真实 DOM 元素没有 .input() 方法——「input」只是一个事件名（要用 "
      + "dispatchEvent(new Event(\"input\")) 触发），不是可以直接调用的方法。",
  },
  {
    pattern: /\.attrs\b/g,
    label: ".attrs",
    why: "真实 DOM 上没有 .attrs 这个属性，只有 .attributes（NamedNodeMap，"
      + "接口形状也完全不同）。FakeElement 的 .attrs 是内部实现细节，不是可以在"
      + "发货代码里读的东西。",
  },
  {
    pattern: /\.listeners\b/g,
    label: ".listeners",
    why: "真实 DOM 不会把已注册的事件监听器暴露成一个可读属性，FakeElement 的 "
      + ".listeners 纯粹是夹具自己记账用的内部状态。",
  },
  {
    pattern: /classList\.reset\(/g,
    label: "classList.reset()",
    why: "真实 DOMTokenList 没有 .reset() 方法。要整体替换 class 列表，真实 DOM "
      + "的写法是 el.className = \"...\" 或者重新 setAttribute(\"class\", ...)。",
  },
  /**
   * ⚠️⚠️ **下面两条是全分支评审 m3 补的，形态与上面六条不同：名字是真的，
   * 被当成假的用的是它的返回值类型。**
   *
   * 账本在 Task 4 复评时把这两个列为「九个残余里最危险的两个，因为写法最自然」，
   * 而它们当时**不在这张表里**。评审已核实**今天一处都没踩**（`admin-ui/js/` 下
   * `querySelectorAll` 的 6 处全是 `for…of`、`.children` 的 1 处也是 `for…of`），
   * 所以这是**补护栏缺口，不是修活缺陷**。
   *
   * **真实 DOM 上到底有什么，我拿真浏览器（Chromium）逐个 `typeof` 探过，
   * 不是从记忆里写的**：
   * · `NodeList`（`querySelectorAll` 的返回值）：有 `forEach`/`entries`/`keys`/`values`/
   *   `item`/`length`/`Symbol.iterator`；**没有** `map`/`filter`/`find`/`findIndex`/
   *   `some`/`every`/`reduce`/`reduceRight`/`slice`/`sort`/`flatMap`/`indexOf`/
   *   `includes`/`concat`/`join`/`at`/`reverse`/`push`/`pop`/`shift`/`splice`。
   * · `HTMLCollection`（`.children`）：**只有** `item`/`length`/`Symbol.iterator`
   *   —— 连 `forEach`/`entries`/`keys`/`values` 都没有。
   * ⇒ 所以两条正则的词表**不一样**：`forEach` 只在 `.children` 那一条里算违规。
   *
   * 而 `tests/helpers/fake-dom.ts` 两处都返回**原生数组**
   *（`querySelectorAll(): FakeElement[]`、`readonly children: FakeElement[]`），
   * 数组方法一个不缺 ⇒ 所有 DOM 用例都会绿，只有真机浏览器才会炸。
   */
  {
    // 形如 `x.querySelectorAll(".a").map(…)`。允许跨行（`\s*`），
    // 括号内不许再出现 `)`（选择器是字面量字符串，够用；嵌套调用不在覆盖内，
    // 这条边界记在下面的 KNOWN_BLIND_SPOTS 里）。
    pattern: /querySelectorAll\([^)]*\)\s*\.\s*(?:map|filter|find|findIndex|some|every|reduce|reduceRight|slice|sort|flatMap|indexOf|includes|concat|join|at|reverse|push|pop|shift|splice)\b/g,
    label: "querySelectorAll()",
    fixtureName: "querySelectorAll",
    why: "方法名是真的，返回值类型不是：真实 DOM 回的是 NodeList，"
      + "真机 Chromium 上逐个 typeof 探过——它只有 forEach/entries/keys/values/item/length，"
      + "map/filter/find/slice/sort 这些数组方法一个都没有（forEach 有，所以不在这条词表里）。"
      + "FakeElement 却回一个原生数组 ⇒ 写成 .map(…) 时全套 DOM 用例照绿、真机 TypeError。"
      + "要转成数组请显式写 Array.from(...) 或 [...nodeList]。",
  },
  {
    // 形如 `node.children.map(…)`。`\b` 排除 `.childrenFoo`。
    // ⚠️ `forEach` **在这一条里算违规**：HTMLCollection 连 forEach 都没有。
    pattern: /\.children\s*\.\s*(?:map|filter|find|findIndex|some|every|forEach|reduce|reduceRight|slice|sort|flatMap|indexOf|includes|concat|join|at|entries|keys|values|reverse|push|pop|shift|splice)\b/g,
    label: ".children",
    fixtureName: "children",
    why: "属性名是真的，返回值类型不是：真实 DOM 回的是 HTMLCollection，"
      + "真机 Chromium 上逐个 typeof 探过——它只有 item/length 和 Symbol.iterator，"
      + "连 forEach/entries/keys/values 都没有，更没有 map/filter/find。"
      + "FakeElement 却把它做成原生数组 ⇒ 同上，只有真机才会炸。"
      + "for…of 是安全的（HTMLCollection 可迭代），要数组请显式 Array.from(...)。",
  },
];

/**
 * **这道门禁明写自己拦不住什么**——按名字扫描的天生盲区，全部记在这里，
 * 不假装"扫描绿了就等于替身与真实 DOM 处处一致"：
 *
 * · `querySelectorAll()` / `children` 的返回值**被存进变量之后**再调数组方法：
 *   上面那两条形态正则要求「调用/属性紧跟着 `.map(`」，所以
 *   `const els = root.querySelectorAll(".a"); els.map(…)` **它抓不到**，
 *   `foo(root.children)` 之后在 `foo` 里调数组方法同样抓不到。
 *   ⚠️ 这条不再是"整类盲区"，只是"这一类里的间接写法"——直接写法已经被扫描覆盖，
 *   而账本点名的那两个「最自然的写法」正是直接写法。
 * · `submit()`：名字是真的（`HTMLFormElement.prototype.submit` 确实存在），
 *   但语义相反——真实浏览器的 `.submit()` **不会**派发 `submit` 事件，
 *   `FakeElement.submit()` 会。名字匹配拦不住语义不匹配。
 * · `.disabled`：真实 DOM 上这是表单控件（`button`/`input`/`select`/`textarea`/
 *   `fieldset`）特有的属性，`FakeElement` 把它挂在**每一个**元素实例上，
 *   在 `<div>`/`<span>` 上读写都不会报错。按名字扫描分不出"用在按钮上"与
 *   "用在 div 上"的区别。
 * · `keydown()` 当方法调用：与 `.walk()` 同类（真实 DOM 没有这个可调用方法，
 *   `keydown` 只是事件名），但目前只有测试代码在调用它（`dialog.keydown("Tab")`
 *   这类写法），发货代码里不会出现，暂不列入扫描——列进去只会在测试文件自己
 *   身上产生噪音，扫描范围已经限定在 `admin-ui/js/`、不含 `tests/`，这里单独
 *   写清楚是为了不让人误以为遗漏。
 *
 * 这几条今天没有对应的自动化门禁，需要代码评审 + `wrangler dev` 真机冒烟兜底。
 */
const KNOWN_BLIND_SPOTS = [
  "querySelectorAll()/children 的返回值先存进变量或传进函数之后再调数组方法（直接写法已被扫描覆盖）",
  "submit() 语义相反（真实 DOM 不派发 submit 事件，夹具会）",
  ".disabled 在夹具里挂在每个元素上，真实 DOM 只有表单控件才有",
];

function walkJs(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkJs(p) : /\.(js|mjs)$/.test(n) ? [p] : [];
  });
}

/**
 * 一段源码里命中的 `FAKE_ONLY_MEMBERS` 标签。**这道扫描的全部判据就是这个函数。**
 *
 * 抽成纯函数只为一件事：让「毒刺在场时它还看不看得见」那一格能**在内存里拼坏文本**，
 * 不改真实源文件（与下面那格「反向自检：focusableIn() 退回 root.walk() 的写法，
 * 这道门禁会抓到并点名 ui.js」同一个先例）。判据本身一个字符都没改。
 *
 * ⚠️ **抠注释走 `tests/helpers/strip-comments.ts` 转出去的真源（P3e Task 1 收编）。**
 * 本文件原来自持一份正则实现，它把注释**逐字符替换成空格**，并在旁边写着
 * 「保留原文件的行号与列位置，不需要另外算偏移」——**那句话在这里从来没有兑现过**：
 * 这道扫描只 push 文件名 + 标签，**从不报行列**，所以换成「整段删掉」不是回归。
 * 真源另有一个 `blankComments` 留给真的按行号扫的消费者。
 * ⚠️ 换过来还顺手修掉一个活着的洞：旧实现抠行注释用的是一条不带保护的正则
 *（双斜杠后面吃到行尾），它把 `admin-ui/js/ui.js` 里 `"http://www.w3.org/2000/svg"`
 * 那种**字符串里的双斜杠**当成行注释开头，本行其后整段脱离扫描
 *（`admin-ui/js/i18n-dict.js` 同款，被吃掉的是一整段字典条目）。
 */
function fakeDomOnlyApis(src: string): string[] {
  const stripped = stripComments(src);
  const hits: string[] = [];
  for (const { pattern, label } of FAKE_ONLY_MEMBERS) {
    pattern.lastIndex = 0;
    if (pattern.test(stripped)) hits.push(label);
    pattern.lastIndex = 0;
  }
  return hits;
}

describe("复评必改④：替身能力扫描——发货代码不许用到 fake-dom.ts 独有、真实 DOM 没有的成员", () => {
  it("反向自检：清单本身不是空的，且能在夹具源码里找到这些名字（否则清单本身就是废的）", () => {
    const fixtureSrc = readFileSync("tests/helpers/fake-dom.ts", "utf8");
    expect(FAKE_ONLY_MEMBERS.length).toBeGreaterThan(3);
    for (const { label, fixtureName } of FAKE_ONLY_MEMBERS) {
      const bareName = fixtureName ?? label.replace(/^\.|\(\)$/g, "").replace(/^classList\./, "");
      expect(fixtureSrc.includes(bareName), `${label} 在 fake-dom.ts 里都找不到，这条清单项是不是写错了`).toBe(true);
    }
  });

  it("admin-ui/js/ 下的发货代码不许出现 fake-dom.ts 独有的成员名", () => {
    const offenders: string[] = [];
    for (const p of walkJs("admin-ui/js")) {
      const rel = p.split("\\").join("/");
      for (const label of fakeDomOnlyApis(readFileSync(p, "utf8"))) {
        const why = FAKE_ONLY_MEMBERS.find((m) => m.label === label)!.why;
        offenders.push(`${rel}: ${label}（${why}）`);
      }
    }
    expect(
      offenders,
      "发货代码里用到了只存在于测试夹具、真实 DOM 上没有的成员——这类缺陷所有 DOM "
        + "测试都会绿，只有真机浏览器才会炸（focusableIn() 的 .walk() 就是这么漏过去的）",
    ).toEqual([]);
  });

  /**
   * **反向自检，证明这道门禁真的会红**：把 `focusableIn()` 退回到最初那个真实
   * 缺陷（用 `root.walk()` 代替 `.children` 递归），确认扫描抓得到、且报的是
   * `ui.js` 与 `.walk()` 这一条，不是别的巧合原因。不改真实源文件——在内存里
   * 拼一份等价的坏文本，跑同一套判据。
   */
  it("反向自检：focusableIn() 退回 root.walk() 的写法，这道门禁会抓到并点名 ui.js", () => {
    const regressed = `
      function focusableIn(root) {
        return root.walk().filter((el) => FOCUSABLE_TAGS.has(el.tagName.toLowerCase()));
      }
    `;
    expect(fakeDomOnlyApis(regressed), "退回 root.walk() 之后，这道扫描应该抓到 .walk() 这一条")
      .toEqual([".walk()"]);
  });

  /**
   * **第 10 种假阳性：一根长得完全正常的毒刺让整道扫描变瞎（P3e Task 1）。**
   *
   * 毒刺是本仓最自然的一行写法——字符串字面量里含 `/` 紧跟 `*`
   *（`admin.use("/admin/api/*", …)` 这种路由 glob，`src/http/admin/router.ts` 里真有）。
   * 用一对正则抠块注释的实现会把它当成块注释开头，**一路吞到下一个闭合记号为止**，
   * 中间那段真代码整段脱离扫描，而门禁照常报绿。
   *
   * ⚠️ **三行的顺序是量出来的，不是抄来的**：闭合记号必须写在**目标缺陷之后**。
   * 把闭合记号夹在毒刺与缺陷之间（第一版就是那么写的）时，被吞掉的只有毒刺自己那半行，
   * 缺陷仍然看得见 ⇒ **正则版也是绿的**，这一格零鉴别力。
   */
  it("字符串里的 /* 不再让这道扫描变瞎 —— 毒刺与真缺陷同时在场时仍要抓到 NodeList.map()", () => {
    const poisoned = [
      'const ADMIN_API_GLOB = "/admin/api/*";',
      'const rows = root.querySelectorAll(".x").map((e) => e.textContent);',
      "/* 一段普通的块注释，它提供了那个闭合记号 */",
    ].join("\n");
    expect(fakeDomOnlyApis(poisoned), "毒刺在场时这道扫描仍必须看得见 NodeList.map()")
      .toContain("querySelectorAll()");
  });

  it("盲区清单不是空的——如实登记按名字扫描拦不住的那几类，别让人以为门禁绿了就等于处处一致", () => {
    expect(KNOWN_BLIND_SPOTS.length).toBeGreaterThan(0);
  });
});
