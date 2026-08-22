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
 *
 * ── 五份副本今天各自在哪（逐条实测，别再写成一句概括）────────────────────────
 *
 * **已经收编成这一份（4 个消费者）**：
 * · `tests/unit/admin/probe-guard.test.ts`「两条端点的 handler 都从 probe-guard.js 取护栏 —— 各写一套就是两套判据」
 * · `tests/ui/keys-write.test.ts`「护栏产出的每一条 reason，验活与通道测试两个前端都认得 —— Task 8 就是「后端加了两条、前端没跟上」的那个案例」
 * · `tests/unit/pool-cache.test.ts`「只许被写、不许被读」那一格（`lastUsedAt` 的读写扫描）
 * · `tests/unit/source-guards.test.ts`「扫描到的使用点恰好等于手写的豁免清单」
 *   与同文件「调用点恰好等于手写的豁免清单——绕过注入 Logger 的事件永远进不了面板」
 *
 * ⚠️⚠️ **后两个是 P3d Task 9 复评补收编的，而且它们当时各有一个已被实测的活洞
 *（既存缺陷，不是本轮引入的）**：
 * · **零 IO 门禁**（全局约束 2 的执行机构，扫 `src/core`）：
 *   `src/core/admin/config-validate.ts` 第 368 行是一句 `//` 注释，里面写着 `/v1/*`
 *   ——**块注释正则先跑，`//` 挡不住它**，那个 `/*` 一路吞到第 423 行
 *   （**56 行、2053 字节真代码**）。金丝雀实测：往被吞区间里插一句
 *   `const IO_CANARY = Date.now();` ⇒ **正则版 24/24 全绿**，换成这一份后当场红、
 *   且报的就是 `src/core/admin/config-validate.ts :: Date.now ×1`。
 * · **console 门禁**（扫 `src/adapters` / `src/http` / `src/ports` / `src/ui`）：
 *   `src/http/admin/router.ts` 第 258 行是**真代码**
 *   `admin.use("/admin/api/*", adminAuth(...))`，那个 `/*` 吞到第 429 行
 *   （**172 行、7852 字节**，其中含 `createProbeGuard()` 与整张 `/admin/api/*` 路由表）。
 *   金丝雀实测：往被吞区间里插一句 `console.log(...)` ⇒ **正则版全绿**，
 *   换成这一份后当场红、且报的就是 `src/http/admin/router.ts :: console ×1`。
 *   ⚠️ 这正是 `src/http/admin/router.ts` 自己那段注释里记着的、第 12 道门禁
 *   `commentBlocks()` 当年踩过的**同一个坑在另一处复发**。
 * · **同一次测量顺带证伪了一句**：复评把零 IO 那个洞归给
 *   `src/core/admin/event-ring.ts`。**实测不是它**——逐文件比对两种实现的输出，
 *   `src/core` 下今天只有 `config-validate.ts` 一处分叉（`event-ring.ts` 两种实现
 *   输出等长）。洞是真的，文件说错了。
 *
 * **仍然各持一份正则副本、本轮未收编**（改动面超出本任务）：
 * · `tests/unit/i18n-dict.test.ts`「板块里当参数传的 i18n key（elI18n / labelKey 这类）同样必须在字典里」
 * · `tests/ui/dom/fake-dom-parity.test.ts`「admin-ui/js/ 下的发货代码不许出现 fake-dom.ts 独有的成员名」
 * 两者扫的都是 `admin-ui/`，那里今天没有含 `/*` 的字符串
 * ——**但这是「今天不在射程内」，不是「它们是对的」。**
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
