import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { blankComments } from "../../helpers/strip-comments.js";
import {
  ADMIN_ERROR_CODES, ADMIN_ERROR_PARAMS, isAdminErrorCode,
} from "../../../src/core/admin/admin-errors.js";

/**
 * 管理接口错误码这一族的结构守卫（P3e Task 22A）。
 *
 * **它守的那件事**：面板会渲染的那一族后端错误，必须带一个机器可读的码，
 * 而不是一句直投给 ja / en / ko 用户的中文 `message`。
 *
 * ⚠️ **这个文件里没有一条断言在证明「破口关掉了」**——那是
 * `tests/contract/admin-keys-write.test.ts`（真 HTTP 带不带码）与
 * `tests/ui/keys-write.test.ts`（面板画出来的是哪一句）的事。
 * 这里只守**结构**：闭集的形状、码文分离、面不许增长、以及不许顺手扩到网关那一半。
 */

const HAN = /[一-鿿]/;

/** 双引号串与模板串。**单引号不收**：本仓 `src/` 下没有单引号字符串风格。 */
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 一个文件里所有**含汉字的**字符串字面量。**先抠注释**——注释里的中文是说明，不是文案。 */
function hanLiterals(file: string): string[] {
  const src = blankComments(readFileSync(file, "utf8"));
  return [...src.matchAll(STRING_LITERAL)].map((m) => m[0]).filter((s) => HAN.test(s));
}

/**
 * 一条**会被塞进 HTTP 错误响应体**的中文串的落点。
 *
 * ⚠️⚠️ **判据是「这个含汉字的字面量前面紧挨着什么」，不是行级 grep。**
 * P3e Task 22A 的需求书给的量法是 `grep -rn 'message: *"[^"]*[一-龥]'`，
 * 那条 grep **量不到本任务要修的那一族**：`note 最长 200 个字符` 是
 * `httpError(400, …, \`note 最长 …\`)` 的实参、既不是 `message:` 也不是双引号串
 * ——而它恰恰是那段「归属定死归 P3e」的 docblock 点名举的**唯一例子**。
 * 实测两个量法的差：那条 grep 在 `src/http/admin/` 下数出 19，本判据数出
 * 下面 `ADMIN_MESSAGE_SITES` 那个数。**照抄需求书的量法立起来的守卫，
 * 对本任务要关的破口是瞎的。**
 *
 * **边界（登记，不是承诺）**：
 * · 日志字段（`msg: "…"` / `fields`）**刻意不收**——它们不进响应体、不上屏幕；
 * · `+` 拼出来的中文串收不到（本仓 `src/` 下今天零处，与 i18n 门禁第 ① 条同一族漏报）；
 * · 一个含汉字的串**先赋给变量、再传进来**同样收不到。
 */
function messageSites(root: string): string[] {
  const out: string[] = [];
  for (const p of walkTs(root)) {
    const src = blankComments(readFileSync(p, "utf8"));
    for (const m of src.matchAll(STRING_LITERAL)) {
      if (!HAN.test(m[0])) continue;
      const before = src.slice(Math.max(0, m.index - 200), m.index).replace(/\s+/g, " ");
      // ① `message: "…"`（信封字面量）；② 三个错误构造函数的实参位。
      if (!/(?:message:\s*|(?:httpError|adminError|adminErrorBody)\s*\([^()]*)$/.test(before)) continue;
      out.push(`${p}:${src.slice(0, m.index).split("\n").length} ${m[0].slice(0, 60)}`);
    }
  }
  return out;
}

describe("管理接口错误码：闭集的形状", () => {
  it("码里一个点都不许有 —— 点分形态会被 i18n 门禁误当成 key 引用", () => {
    // 第一版写成 `keys.notFound`，`node scripts/check-i18n.mjs` 当场把十条码
    // 逐条报成「引用了字典里没有的 key」（实测 EXIT=1），理由见 admin-errors.ts 那段。
    for (const code of ADMIN_ERROR_CODES) {
      expect(code, `错误码「${code}」里有点，会被 i18n 门禁当成一次 key 引用`).not.toContain(".");
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("反向控制：判据对仓里真实存在的点分标识确实说「有点」—— 否则上一格是空转", () => {
    // **反向控制用仓里真实存在的串**：这是 `admin-ui/js/i18n-dict.js` 里活着的一条 key，
    // 也正是 `ADMIN_ERROR_TEXT_KEY` 把 `must_disable_first` 指过去的那一条。
    expect("keys.mustDisableFirst").toContain(".");
    expect("keys.mustDisableFirst").not.toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("码不重复，且 isAdminErrorCode 认得出每一条、也认得出表外的不是", () => {
    expect(new Set(ADMIN_ERROR_CODES).size).toBe(ADMIN_ERROR_CODES.length);
    for (const code of ADMIN_ERROR_CODES) expect(isAdminErrorCode(code)).toBe(true);
    // 反向控制：一个形状完全合法、但不在表里的码必须被判为 false。
    expect(isAdminErrorCode("note_too_short")).toBe(false);
    expect(isAdminErrorCode(42)).toBe(false);
  });

  it("每一条码都在 ADMIN_ERROR_PARAMS 里有一行，两侧键集逐字相等（双向）", () => {
    expect(Object.keys(ADMIN_ERROR_PARAMS).sort()).toEqual([...ADMIN_ERROR_CODES].sort());
    for (const names of Object.values(ADMIN_ERROR_PARAMS)) {
      for (const n of names) {
        // 占位符名会被拼进 `{n}` 塞进五语言句子里，只能是 ASCII 标识符。
        expect(n).toMatch(/^[a-z][A-Za-z0-9]*$/);
      }
    }
  });
});

describe("管理接口错误码：码是码，文案在五语言字典里", () => {
  const CODES_FILE = "src/core/admin/admin-errors.ts";

  it("这个文件里没有任何用户文案 —— 码是码，文案在五语言字典里", () => {
    // 判据只看**字符串字面量**，不看注释：这个文件的注释里成段都是中文说明，
    // 那是给读代码的人的，不会出现在任何一个响应体里。
    expect(hanLiterals(CODES_FILE)).toEqual([]);
  });

  it("反向控制之一：抠注释这一步真的在干活 —— 原文里有汉字，抠完的字面量里没有", () => {
    // 少了这一格，上一格在「文件是空的」「正则一个都匹配不到」这两种情形下同样是绿的。
    expect(HAN.test(readFileSync(CODES_FILE, "utf8"))).toBe(true);
    expect(HAN.test(blankComments(readFileSync(CODES_FILE, "utf8")))).toBe(false);
  });

  it("反向控制之二：同一个判据在真的有文案的那个文件上确实捞得出来", () => {
    // **用仓里真实存在的文件**：`keys-write.ts` 的中文 `message` 是本任务要修的那一族本身。
    const found = hanLiterals("src/http/admin/handlers/keys-write.ts");
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((s) => s.includes("没有这把 key"))).toBe(true);
  });
});

/**
 * **面不许增长。**
 *
 * ⚠️ **这一格是「回来表态」型守卫，不是「不许再写中文」。** 后面的任务往
 * `src/http/admin/` 里新增一条带中文的错误 `message` 时它会红——**那是它在按设计工作**：
 * 新增的那一条要么进面板（那就得给码 + 补五语言），要么不进面板（那就把数字改掉并说清楚）。
 * **改数字可以，删这条断言不行。**
 *
 * ⚠️ **这个数刻意是手写字面量**，不是从别处算出来的：算出来的话它会跟着代码一起漂，
 * 而那正是「一个不会自己红的清单」。
 */
const ADMIN_MESSAGE_SITES = 49;

describe("面不许增长", () => {
  it("面不许增长：src/http/admin/ 下带中文 message 的落点恰好这么多", () => {
    const sites = messageSites("src/http/admin");
    expect(
      sites.length,
      `src/http/admin/ 下的中文 message 落点变成了 ${sites.length} 条（登记的是 ${ADMIN_MESSAGE_SITES}）。`
      + "新增的那条要么进面板 —— 那就给它一个 ADMIN_ERROR_CODES 里的码并补五语言，"
      + "要么不进面板 —— 那就把这里的数字改掉。**别删这条断言。**\n"
      + sites.join("\n"),
    ).toBe(ADMIN_MESSAGE_SITES);
  });

  it("反向控制：判据在一段没有中文 message 的真代码上不乱红", () => {
    // `src/core/protocol/` 是四协议的解析与改写，一条 HTTP 错误 message 都不产生
    // ——而它里面**有**中文注释、也**有**中文日志文案，正好证明判据没有宽到「见汉字就红」。
    expect(messageSites("src/core/protocol")).toEqual([]);
  });
});

/**
 * **网关业务口那一半：本期明确不做，而「不做」也要有牙。**
 *
 * 不做的理由（射程不同 / 正确做法不同 / 危害档位 MEDIUM）全文在
 * `src/core/admin/admin-errors.ts` 的文件头。这里守的是**别半做**：
 * 给网关那一族也顺手加码，会造出「一半端点有码一半没有」的第三种状态，
 * 比一致的现状更难收尾。
 */
describe("网关业务口：本期不做，而且不许半做", () => {
  const GATEWAY_ROOTS = ["src/http/routes", "src/http/middleware", "src/core/dispatcher.ts", "src/entry"];

  function callsAdminError(paths: string[]): string[] {
    const hits: string[] = [];
    for (const root of paths) {
      const files = statSync(root).isDirectory() ? walkTs(root) : [root];
      for (const p of files) {
        const src = blankComments(readFileSync(p, "utf8"));
        if (/\badminError(?:Body)?\s*\(/.test(src)) hits.push(p);
      }
    }
    return hits;
  }

  it("网关业务口那一族一个 code 都不许有 —— 半做会造出第三种状态", () => {
    expect(callsAdminError(GATEWAY_ROOTS)).toEqual([]);
  });

  it("反向控制：同一个判据在管理树上确实数得出来 —— 否则上一格是空转", () => {
    expect(callsAdminError(["src/http/admin"]).length).toBeGreaterThan(0);
  });

  it("src/http/admin/ 下不许再 import 网关那份 readJson —— 它抛的信封没有 code", () => {
    // 这一档是「第二层替第一层挡住变异」的形状：`readJson()` 住在 `src/http/errors.ts`，
    // 上面那道「面不许增长」的扫描只看 `src/http/admin/`，**看不见一次跨文件的函数调用**
    // ⇒ 管理 handler 只要还调它，畸形 JSON 那一档就仍然是一句没有码的中文，而一切全绿。
    const offenders: string[] = [];
    for (const p of walkTs("src/http/admin")) {
      const src = blankComments(readFileSync(p, "utf8"));
      if (/\breadJson\b/.test(src)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });

  it("反向控制：网关那棵树上确实还在用它 —— 上一格查的是真的存在的那个名字", () => {
    const users = walkTs("src/http/routes")
      .filter((p) => /\breadJson\b/.test(blankComments(readFileSync(p, "utf8"))));
    expect(users.length).toBeGreaterThan(0);
  });
});
