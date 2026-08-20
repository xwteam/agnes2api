import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAdminToken } from "../../src/http/admin/auth.js";

/**
 * 「口令字符集两边一致」这句话的护栏。
 *
 * `src/http/admin/auth.ts` 的 `SENDABLE` 注释里写着「前端 `admin-ui/js/app.js` 的
 * `sendable()` 用**同一个字符集**，两边一致」——**这条本来没有任何东西钉着**。
 * 本项目已经被「注释里写下一句断言、后来的人直接采信、而那句话是假的」咬过二十次，
 * 所以这句话必须指得出一条会变红的东西。
 *
 * 两边不一致的后果是**真的**、而且方向都不好：
 *   · 前端比后端严 ⇒ 一个后端认可的合法口令，用户在输入框里被当场拒掉，
 *     而错误文案说的是「浏览器发不出去」——一句假话，运维会去改口令而不是改前端。
 *   · 前端比后端松 ⇒ 前端放行的口令 `fetch` 时抛 TypeError，用户看到「网络错误」，
 *     服务端连一条 `login_failed` 都没有——正是 K7 当初要消灭的那个形态。
 *
 * ⚠️ **这是源码文本级断言，不是行为断言，边界写在这里。** 它比对的是两处正则字面量
 * 里的**字符类**，拦得住「一边改了字符集另一边忘了改」；**拦不住**「前端把
 * `sendable()` 整个不调了」或者「调用点传错了参数」——`admin-ui/js/app.js` 碰
 * `fetch` / `localStorage` / DOM，按设计文档 §13.1 不进 CI，那一档只有人工冒烟
 * （冒烟第 2 条：输入含汉字的口令，当场报错且一个请求都不发）覆盖。
 */
const ROOT = new URL("../../", import.meta.url);
const BACKEND = readFileSync(fileURLToPath(new URL("src/http/admin/auth.ts", ROOT)), "utf8");
const FRONTEND = readFileSync(fileURLToPath(new URL("admin-ui/js/app.js", ROOT)), "utf8");

/** 从一段源码里抠出 `^[...]<量词>$` 这个形状里的字符类与量词。 */
function charClassOf(src: string, re: RegExp, what: string): { cls: string; quant: string } {
  const m = re.exec(src);
  expect(m, `没在${what}里找到 SENDABLE 形态的正则字面量——要么它被改名/改写了，要么这条断言该更新了`)
    .not.toBeNull();
  return { cls: m![1]!, quant: m![2]! };
}

describe("口令字符集：后端 SENDABLE 与前端 sendable() 必须逐字相同", () => {
  const back = charClassOf(BACKEND, /const SENDABLE = \/\^\[([^\]]+)\]([*+])\$\//, "auth.ts");
  const front = charClassOf(FRONTEND, /return \/\^\[([^\]]+)\]([*+])\$\/\.test\(s\)/, "app.js");

  it("字符类逐字相同", () => {
    expect(front.cls, "前端与后端的口令字符集分叉了").toBe(back.cls);
  });

  /**
   * **字符集本身是策略，用手写字面量独立钉死。**
   *
   * 只断言「两边相同」是不够的：把两边**一起**收回 `\x21`（本轮评审裁定要放行的那条）
   * 依然是「相同」，那条断言照样绿。0x20 这个下界是评审的裁定
   *（留物理、去口味：空格送得出去，所以放行 passphrase），必须独立锚住。
   */
  it("字符集就是 0x20–0x7E 这一段——下界含空格是评审裁定，独立钉死", () => {
    expect(back.cls).toBe("\\x20-\\x7e");
  });

  /**
   * 量词**刻意不同**，理由写在 `auth.ts` 的 `SENDABLE` 里：后端 `*` 让空串落到
   * `too_short`（那才是运维能照着改的那句话），前端 `+` 是安全的因为 `app.js` 先用
   * `if (!key)` 把空输入接走了。把这个差异钉住，免得有人「顺手统一」之后
   * `checkAdminToken("")` 悄悄改报 `not_sendable`。
   */
  it("量词的差异是刻意的：后端 * / 前端 +", () => {
    expect(back.quant).toBe("*");
    expect(front.quant).toBe("+");
    // 这就是那个差异唯一能被观测到的输入。
    expect(checkAdminToken("", "g")).toEqual({ ok: false, reason: "too_short" });
  });
});
