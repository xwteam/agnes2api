import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
 * 不会、`.disabled` 挂在每一个元素而不只是表单控件），这些**按名字扫描天生
 * 抓不到**——名字本身没有问题，问题在语义。这道门禁明写自己的边界，不假装
 * 覆盖这一半（见下面 `KNOWN_BLIND_SPOTS`），那一半仍然只能靠代码评审 + 真机冒烟。
 */

/** 只在真实 DOM 上不存在、且这份夹具用了容易被误认成"真实 API"名字的成员。 */
const FAKE_ONLY_MEMBERS: Array<{ pattern: RegExp; label: string; why: string }> = [
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
];

/**
 * **这道门禁明写自己拦不住什么**——按名字扫描的天生盲区，全部记在这里，
 * 不假装"扫描绿了就等于替身与真实 DOM 处处一致"：
 *
 * · `querySelectorAll()` / `children`：**方法名和属性名都是真的**，但
 *   `FakeElement` 让它们返回原生数组（带 `.map`/`.find`/`.filter`），真实 DOM
 *   返回的是 `NodeList` / `HTMLCollection`（没有这些数组方法）。板块代码今天
 *   没有对这两者的返回值调用数组方法，但这道门禁**没有能力**验证"以后也不会"
 *   ——按名字扫描只能确认"用没用这个名字"，确认不了"返回值当成了什么类型来用"。
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
  "querySelectorAll()/children 返回真数组而不是 NodeList/HTMLCollection",
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
 * 去掉块注释与行注释，只留代码本体——否则连本文件、`ui.js` 自己那句"第一版
 * 写的是 `root.walk()`"的历史说明注释都会被误判成"生产代码在用 .walk()"。
 * 逐字符替换成空格而不是整段删掉：保留原文件的行号与列位置，不需要另外算偏移。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

describe("复评必改④：替身能力扫描——发货代码不许用到 fake-dom.ts 独有、真实 DOM 没有的成员", () => {
  it("反向自检：清单本身不是空的，且能在夹具源码里找到这些名字（否则清单本身就是废的）", () => {
    const fixtureSrc = readFileSync("tests/helpers/fake-dom.ts", "utf8");
    expect(FAKE_ONLY_MEMBERS.length).toBeGreaterThan(3);
    for (const { label } of FAKE_ONLY_MEMBERS) {
      const bareName = label.replace(/^\.|\(\)$/g, "").replace(/^classList\./, "");
      expect(fixtureSrc.includes(bareName), `${label} 在 fake-dom.ts 里都找不到，这条清单项是不是写错了`).toBe(true);
    }
  });

  it("admin-ui/js/ 下的发货代码不许出现 fake-dom.ts 独有的成员名", () => {
    const offenders: string[] = [];
    for (const p of walkJs("admin-ui/js")) {
      const rel = p.split("\\").join("/");
      const stripped = stripComments(readFileSync(p, "utf8"));
      for (const { pattern, label, why } of FAKE_ONLY_MEMBERS) {
        pattern.lastIndex = 0;
        if (pattern.test(stripped)) offenders.push(`${rel}: ${label}（${why}）`);
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
    const stripped = stripComments(regressed);
    const hit = FAKE_ONLY_MEMBERS.find(({ pattern }) => {
      pattern.lastIndex = 0;
      return pattern.test(stripped);
    });
    expect(hit?.label, "退回 root.walk() 之后，这道扫描应该抓到 .walk() 这一条").toBe(".walk()");
  });

  it("盲区清单不是空的——如实登记按名字扫描拦不住的那几类，别让人以为门禁绿了就等于处处一致", () => {
    expect(KNOWN_BLIND_SPOTS.length).toBeGreaterThan(0);
  });
});
