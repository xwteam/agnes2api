/**
 * 从门禁脚本源码里逐字抠出一张手写字面量表。
 *
 * **它为什么存在。** 本仓有几张表是**故意抄两份**的（一份在门禁脚本里、一份在
 * 「第二份独立实现」的测试里），冗余本身是设计：两份实现同时写错的概率远低于一份。
 * 但**抄两份的代价是两份会不声不响地漂**，而本仓对这种形态早就有裁定，
 * 逐字写在 `scripts/lib/unverified-claims.mjs` 文件头：
 * **两份不一致时，瞎掉的那一份才是报绿的那一份。**
 * 实测的那一次：`scripts/check-i18n.mjs` 的偏好词作用域表在第二份实现里被整表清成 `[]`，
 * 那份测试仍然全绿——它扫的东西为空，`toEqual([])` 只会更绿。
 * ⇒ **抄两份可以，但必须有一条机器要求两份逐条相等**，这个函数就是那条机器的取数一侧。
 *
 * ⚠️⚠️ **形态照抄 `tests/unit/check-comment-refs.test.ts` 的
 * 「反向控制：抠出来的确实是那张词表（认不出会抛，不会静默放行）」那一族**，
 * 三条一起治，一条都不许省：
 * ① **抠注释走 `scripts/lib/strip-comments.mjs` 那一份真源**（行尾注释也抠得掉，
 *    而且它认得字符串字面量，不会被成员里的斜杠星号带瞎）——别在这里手写第二份；
 * ② 三种引号形态都认（`"` / `'` / 反引号）——只认双引号的话，单引号写的成员会被漏掉，
 *    **而真门禁认得它**：机器全绿而两份真的不同；
 * ③ **认不出要吵**：把认出来的成员整段挖掉之后，表体里不许还剩下任何非空白残渣
 *    ——剩下就说明有一种写法没被认出来（拼接、常量引用、展开另一张表……），
 *    此时**抛异常，不许当成「今天那张表就长这样」**。
 *
 * ⚠️ **它只证明「两份字面量逐条相等」，不证明那张表收得对、更不证明门禁真的在用它。**
 * 「门禁真的在用它」那一半由各自的正向格承担（拿真门禁跑一遍夹具）；
 * 「收得对不对」那一半留给评审。别把这个函数读成「作用域现在有机器核了」。
 */
import { readFileSync } from "node:fs";
import { blankComments } from "./strip-comments.js";

export function tableFromSource(file: string, head: string): string[] {
  const src = blankComments(readFileSync(file, "utf8"));
  const start = src.indexOf(head);
  const end = src.indexOf("\n];", start);
  // **认不出要吵，不能装没看见**：抠不出来时静默返回空表的话，比对那一格会一起变绿
  //（两个空数组永远相等）——那正是本仓反复登记的「判据用错工具时不会报错，会静静地放行」。
  if (start === -1 || end === -1) {
    throw new Error(`认不出 ${file} 里 \`${head}\` 那张表的落点——判据坏了，不许静默当成空表`);
  }
  const body = src.slice(start + head.length, end);
  const words = [...body.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
  if (words.length === 0) throw new Error(`${file} 的 \`${head}\` 一个成员都没抠出来——判据坏了`);
  const residue = body.replace(/["'`][^"'`]*["'`]/g, "").replace(/[\s,]/g, "");
  if (residue !== "") {
    throw new Error(
      `${file} 的 \`${head}\` 里有一段没被认出来：「${residue}」。`
      + "抠表判据只认三种引号写的字面量成员，认不出的写法一律抛——"
      + "静默跳过它就等于「两份逐条相等」那条断言对那个成员集体失明",
    );
  }
  return words;
}
