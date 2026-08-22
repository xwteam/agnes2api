/**
 * 去掉源码里的注释再扫。**逐字符扫，而且认得字符串/模板字面量**——不是一对正则。
 *
 * ⚠️⚠️ **正则版在 P3d Task 8 当场翻车，成因本仓早就登记过。**
 * 正则版是 `src.replace(/\/\*[\s\S]*?\*\//g, "")…`，而
 * `src/http/admin/router.ts` 里有一行 `admin.use("/admin/api/*", adminAuth(...))`
 * ——**字符串字面量里的 `/*` 被当成块注释开头，一路吞到下一个 `*​/`**，
 * 把中间整段代码（含 `createProbeGuard()` 那次调用）全吃掉 ⇒
 * `tests/unit/admin/probe-guard.test.ts` 的「全 src/ 里只有一处 new 出护栏」
 * 当场红成「只找到 1 处」。
 * **这与 `src/http/admin/router.ts` 里那段注释记的是同一个坑**：第 12 道门禁的
 * `commentBlocks()` 当年正是这么把整张 `/admin/api/*` 路由表吞掉并照常报绿的，
 * 那道门禁后来**改成了逐字符扫**。这里照同一条路走。
 *
 * **边界明写**：它认得 `"…"` / `'…'` / `` `…` `` 与 `//`、`/* … *​/`，
 * **不认得**正则字面量（`/foo\/*bar/`）——本仓 `src/` 下没有这种写法，
 * 真出现了调用方那些格子会红，届时把这里一起改。
 *
 * ⚠️⚠️ **它住在 `tests/helpers/` 而不是各调用方本地，是 P3d Task 9 的裁定。**
 * 本仓在这条上栽过：`stripComments` 一度有**五份手写副本、实现并不一致**
 *（有的是上面那种会把字符串里的 `/*` 当块注释的正则版），
 * 而「哪一份是对的」只有踩过的人知道。**新的调用点一律 import 这一份，
 * 不许再抄第六份**——两份不同实现的扫描器给出不同答案时，绿的那一份会赢。
 * 今天仍然各持一份本地副本的那几处**没有被本任务一并收编**（改动面远超本任务），
 * 如实登记在这里：`tests/unit/i18n-dict.test.ts`「板块里当参数传的 i18n key（elI18n / labelKey 这类）同样必须在字典里」
 * 与 `tests/ui/dom/fake-dom-parity.test.ts`「admin-ui/js/ 下的发货代码不许出现 fake-dom.ts 独有的成员名」
 * 里的本地副本仍是正则版，它们扫的是 `admin-ui/`（那里今天没有含 `/*` 的字符串），
 * 不是这条坑的射程内——**但这是「今天不在射程内」，不是「它们是对的」。**
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        const d = src[i]!;
        out += d;
        i++;
        if (d === "\\") { if (i < src.length) { out += src[i]!; i++; } continue; }
        if (d === quote) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
