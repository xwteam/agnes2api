/**
 * 去掉源码里的注释再扫。**逐字符扫，而且认得字符串 / 模板字面量**——不是一对正则。
 *
 * ⚠️⚠️ **这个文件是本仓「抠注释」的唯一真源。** 它住在 `scripts/lib/` 而不是
 * `tests/helpers/`，是**构建物理决定的，不是偏好**：`scripts/check-i18n.mjs` 是纯 .mjs、
 * 由 `node` 直接跑，它 import 不了 `.ts`。让门禁与测试共用一份实现是这次收编的全部意义，
 * 所以真源必须落在两边都 import 得到的那一侧。`tests/helpers/strip-comments.ts`
 * 现在是这个文件的**转导出**，不是第二份实现。
 *
 * ⚠️ **正则版为什么不行（本仓实测过三次，不是理论）**：正则版是
 * `src.replace(/\/\*[\s\S]*?\*\//g, "")…`，而本仓到处都有
 * `admin.use("/admin/api/*", …)` 这种写法——**字符串字面量里的 `/` 紧跟 `*` 被当成块注释
 * 开头，一路吞到下一个闭合记号**，中间整段代码脱离扫描而门禁照常报绿。
 * · 第一次是 P3d Task 8（`probe-guard` 那格）：`src/http/admin/router.ts` 里那行路由
 *   注册把其后 172 行、7852 字节真代码（含 `createProbeGuard()` 与整张路由表）一起吞掉。
 * · 第二次是同一轮的零 IO 门禁：`src/core/admin/config-validate.ts` 里一句 `//` 注释里
 *   写着 `/v1/*`，块注释正则先跑、`//` 挡不住它，56 行 2053 字节真代码脱离扫描。
 * · 第三次是 P3e 开工勘察：一根这样的毒刺让 fake-dom 平价扫描、i18n 广扫、网络出口扫描
 *   **三道同时变瞎**，而 `pnpm test` 2768/2768 全绿、十二道门禁全部 EXIT=0。
 *
 * ⚠️ **同一次勘察还量到另一族**：用一条不带保护的行注释正则（双斜杠后面吃到行尾）
 * 抠注释的实现会把 `"http://www.w3.org/2000/svg"` 这种**字符串里的双斜杠**当成行注释开头，
 * 把本行其后的代码整段吃掉（`admin-ui/js/ui.js` 与 `admin-ui/js/i18n-dict.js` 各有实例）。
 * 逐字符扫认得「这个 `//` 住在一对引号里」，这一族一并消失。
 *
 * **边界明写**：它认得 `"…"` / `'…'` / 模板字面量与 `//`、块注释，
 * **不认得正则字面量**（例如一个内容里带斜杠星号的正则）——本仓 `src/` 与 `admin-ui/`
 * 下没有这种写法，真出现了调用方那些格子会红，届时把这里一起改。
 *
 * **两个导出，同一个扫描器，只在「注释输出成什么」上分叉：**
 * · `stripComments` —— 注释**删掉**。给「按内容扫」的消费者用。
 * · `blankComments` —— 注释**逐字符换成空格、换行原样保留**。给「按行号 / 列位置扫」的消费者用。
 *
 * ⚠️ **两者不许各写一份**：`tests/ui/api-session.test.ts`「插值捞不齐的那些行今天恰好一处
 *  —— 这道扫描在那一行上是瞎的」那一格底下的 `braceInterpLines()` 全部语义是按行数，
 * 用 `stripComments` 会把块注释里的换行一并删掉、相邻行并成一行 ⇒ 它必须用 `blankComments`。
 * **一个用留空版一个用删除版的话，两份不同实现的扫描器给出不同答案时，绿的那一份会赢。**
 */

/**
 * 逐字符扫一遍源码，把注释交给 `onComment` 决定输出成什么，其余原样搬运。
 *
 * **字符串 / 模板字面量整段原样搬运**：里面的斜杠星号不是注释，里面的双斜杠也不是。
 * 这一条就是整个文件存在的理由。
 */
function scan(src, onComment) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        const d = src[i];
        out += d;
        i += 1;
        if (d === "\\") {
          if (i < n) { out += src[i]; i += 1; }
          continue;
        }
        if (d === quote) break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      out += onComment(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      j = Math.min(j + 2, n);
      out += onComment(src.slice(i, j));
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 注释删掉。 */
export function stripComments(src) {
  return scan(src, () => "");
}

/** 注释逐字符换成空格，**换行原样保留** ⇒ 行号与列位置不变。 */
export function blankComments(src) {
  return scan(src, (text) => text.replace(/[^\n]/g, " "));
}
