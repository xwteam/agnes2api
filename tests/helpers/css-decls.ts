/**
 * CSS 声明块的**属性名判据**：一条声明到底算不算「非颜色的、看得见的」那一种。
 *
 * ⚠️⚠️ **这里是唯一一份实现，别在测试文件里再手写一遍**（同 `tests/helpers/strip-comments.ts`
 * 文件头那句话的理由：两份不同实现的判据给出不同答案时，**绿的那一份会赢**）。
 * 现场枚举消费者：`grep -rn "^import.*helpers/css-decls" tests/`。
 * **刻意不在这里写消费者计数**——它该长大，写死一个数只会换来机械 bump。
 *
 * ── 它为什么长这样（不是「子串包含」）─────────────────────────────────────────
 * 第一版用的是**子串白名单** `body.includes("text-decoration")` / `body.includes("outline")`。
 * P3e Task 20 复评实测把它打穿了：`text-decoration-color: red` 与 `outline-color: red`
 * **本身就是颜色属性**，却逐字包含白名单里的串 ⇒ 那两条 CSS 断言**全绿放行**，
 * 而真机 computed 退回 `text-decoration-line: none` / `outline-style: none` / `font-weight: 400`，
 * **屏幕上与缺陷修复前一模一样**。一格叫「状态不许只由颜色表达」的守卫放行了纯颜色声明，
 * 它存在的全部理由当场作废。所以判据必须切到**逐条声明的属性名**上。
 *
 * ── 边界明写（每一条都由消费者那边的断言或本文件的抛错钉着，不是散文）───────────
 * · **切分靠 `;` 与第一个 `:`**。取值里含 `;` 的写法（`content: "\003b"`、
 *   `url(data:…;base64,…)`）会把切分带偏——带偏之后那一段拿不到冒号 ⇒ **抛错**，
 *   不是返回一份残缺的清单。本仓今天没有这种写法，而「今天没有」**刻意不写成断言**：
 *   抛错本身就是当天的证据。
 * · **属性名认不出就抛**（`/^[a-z-][a-z0-9-]*$/` 之外的一律抛）。"认不出当没看见"
 *   是这一族判据最常见的死法。
 * · **它不渲染**：`font-weight: 401`、`outline: 1px solid transparent` 这种
 *   「声明还在、取值却看不出来」它一律放行。那一族只有真机截图接得住，而截图不会自己红。
 *   `OFF_VALUES` 只堵住**逐字把自己关掉**的那几个关键字，不是一层取值分析。
 */

/** 一条声明。`prop` / `value` 都已 `trim()` + 小写。 */
export type Decl = { prop: string; value: string };

/**
 * 把一个声明块（`{}` 之间那一段，**注释必须先抠掉**）切成逐条声明。
 * 认不出的形态一律抛错并把原文带上，绝不返回一份残缺的清单。
 */
export function declarations(body: string): Decl[] {
  const out: Decl[] = [];
  for (const chunk of body.split(";")) {
    const s = chunk.trim();
    if (s === "") continue;
    const at = s.indexOf(":");
    if (at === -1) {
      throw new Error(`CSS 声明 \`${s}\` 里没有冒号 —— 切分已经失步，别信它的结果`);
    }
    const prop = s.slice(0, at).trim().toLowerCase();
    if (!/^[a-z-][a-z0-9-]*$/.test(prop)) {
      throw new Error(`认不出的 CSS 属性名 \`${prop}\`（原文 \`${s}\`）—— **先回来改判据**，别让它静静放行`);
    }
    out.push({ prop, value: s.slice(at + 1).trim().toLowerCase() });
  }
  return out;
}

/**
 * 颜色属性：`color` 本身，以及 `*-color` 那一族
 *（`border-color` / `text-decoration-color` / `outline-color` / `background-color` …）。
 * **这一族一律不算「非颜色线索」**，哪怕它的属性名逐字包含某个非颜色简写的名字。
 */
export function isColorProp(prop: string): boolean {
  return prop === "color" || prop.endsWith("-color");
}

/**
 * 逐字把自己关掉的那几个取值。带这种取值的声明**在场也等于不在场**，不算数。
 * ⚠️ 这不是取值分析：`font-weight: 401` 这种"在场但看不出来"的它接不住（见文件头边界）。
 */
const OFF_VALUES: ReadonlySet<string> = new Set(["none", "normal", "0", "0px", "initial", "unset", "revert"]);

/**
 * 从一个声明块里挑出「属于 `families` 这几族、且不是颜色属性、且没被逐字关掉」的声明。
 *
 * `families` 里写的是**简写名**（`text-decoration` / `outline` / `font-weight` / `box-shadow`）；
 * 一条声明算命中，当且仅当它的属性名**等于**那个简写名，或者是它的长写
 *（`text-decoration-line` / `outline-style` …，即 `简写名 + "-"` 开头）——
 * 而 `-color` 那一族先被 `isColorProp()` 剔掉。
 */
export function visibleNonColorDecls(body: string, families: readonly string[]): Decl[] {
  return declarations(body).filter((d) =>
    families.some((f) => d.prop === f || d.prop.startsWith(`${f}-`))
    && !isColorProp(d.prop)
    && !OFF_VALUES.has(d.value));
}
