import { describe, it, expect } from "vitest";
import { sendable } from "../../admin-ui/js/pure/sendable.mjs";
import { isSendable, checkAdminToken } from "../../src/http/admin/auth.js";

/**
 * 「口令字符集两边一致」这句话的护栏。
 *
 * `src/http/admin/auth.ts` 的注释里写着「与前端 `sendable.mjs` 逐码位行为等价」——
 * 本项目已经被「注释里写下一句断言、后来的人直接采信、而那句话是假的」咬过二十次，
 * 所以这句话必须指得出一条会变红的东西。
 *
 * 两边不一致的后果是**真的**，而且方向都不好：
 *   · 前端比后端严 ⇒ 一个后端认可的合法口令，用户在输入框里被当场拒掉，
 *     而错误文案说的是「不被接受的字符」——运维会去改口令而不是改前端。
 *   · 前端比后端松 ⇒ 前端放行的口令 `fetch` 时抛 TypeError，用户看到「网络错误」，
 *     服务端连一条 `login_failed` 都没有——正是 K7 当初要消灭的那个形态。
 *
 * ⚠️ **这一版是行为断言，不是源码文本比对。** 上一版比对的是两处正则字面量，
 * 拦不住「加 `u` 标志」「等价改写成别的写法」这类语义分叉；那是因为当时前端那份
 * 判定还留在 `admin-ui/js/app.js` 里、根本 import 不进来。现在它在
 * `js/pure/sendable.mjs`（admin-ui/README.md 硬规则 1 本来就要求如此），
 * 于是可以直接把两份实现都 import 进来逐码位跑。
 *
 * **仍然拦不住的**：「前端把 `sendable()` 整个不调了」。那一档只有人工冒烟第 2 条
 *（输入含汉字的口令，当场报错且一个请求都不发）覆盖，边界写在这里。
 */
describe("口令字符集：前端 sendable() 与后端 isSendable() 逐码位行为等价", () => {
  /**
   * `0x00–0xFF` 全码位逐个跑。**不是采样**——字符集的两个端点（0x20 与 0x7E）
   * 与紧挨着它们的 0x1F / 0x7F 都在里面，任何「区间差一位」都会红。
   */
  it("0x00–0xFF 全 256 个码位，两边给出同一个答案", () => {
    const disagreed: string[] = [];
    for (let cp = 0; cp <= 0xff; cp++) {
      const ch = String.fromCharCode(cp);
      if (sendable(ch) !== isSendable(ch)) {
        disagreed.push(`U+${cp.toString(16).padStart(4, "0").toUpperCase()}`);
      }
    }
    expect(disagreed, "前后端字符集分叉了").toEqual([]);
  });

  /** 超出 Latin-1 的采样：CJK / emoji（代理对）/ 零宽空格 / 组合符号。 */
  it.each([
    ["CJK U+7BA1", "管"],
    ["emoji U+1F511（代理对）", "🔑"],
    ["零宽空格 U+200B", String.fromCharCode(0x200b)],
    ["组合重音 U+0301", String.fromCharCode(0x301)],
    ["行分隔符 U+2028", String.fromCharCode(0x2028)],
  ])("超出 Latin-1 的采样两边也一致：%s", (_name, ch) => {
    expect(sendable(ch)).toBe(isSendable(ch));
    // 而且答案必须是「拒」——只断言「一致」的话，两边一起放行也算一致。
    expect(sendable(ch), `${_name} 不该被放行`).toBe(false);
  });

  /**
   * **多字符串**，含空串。上一版前端 `+` / 后端 `*` 的不对称让空串成为一个例外，
   * 那时这条等价关系只能做到「除空串以外」；量词统一之后例外没有了。
   */
  it.each([
    ["空串（量词统一之后不再是例外）", ""],
    ["纯 ASCII", "admin-token-0123456789"],
    ["passphrase（中间带空格）", "correct horse battery staple"],
    ["首尾空格（字符集这一关放行，归 whitespace_padded 管）", " admin-token-0123456789 "],
    ["含 é（0x80–0xFF：送得出去，但按稳健性取舍拒）", "admin-token-café-0123456789"],
    ["含 ESC（浏览器送得出去，HTTP 解析器 400）", `admin-token${String.fromCharCode(0x1b)}0123456789`],
    ["含 CJK", "管理口令管理口令管理口令管理口令管理口令管理口令"],
  ])("多字符串两边也一致：%s", (_name, token) => {
    expect(sendable(token)).toBe(isSendable(token));
  });

  /**
   * **字符集本身是策略，用手写字面量独立钉死。**
   *
   * 只断言「两边相同」是不够的：把两边**一起**改成别的区间依然是「相同」，
   * 上面那些等价断言照样绿（已实测）。所以这里独立锚住两个端点与它们的邻居。
   *
   * 0x20（空格）在里面是评审的裁定（空格是纯 ASCII、零编码歧义，而 passphrase 是
   * 有价值的形态）；0x7F（DEL）不在里面是因为 HTTP 解析器会 400；
   * 0x80–0xFF 不在里面是**稳健性取舍**而不是物理——三段的完整实测见 auth.ts 的 SENDABLE。
   */
  it.each([
    // ⚠️ **`0x09` 这一格是复评抓出来的盲点，钉在这里。** 注释里曾把 (b) 段写成
    // 「其余 C0 控制字符 0x00–0x1F」，而当时只实测过 BEL/ESC/DEL/NEL 四个——
    // **抽样实测，却写下范围断言**。全 256 字节穷举之后才发现 TAB `0x09` 是例外：
    // `Headers.set` ACCEPTED、HTTP 解析器 **200 OK**、handler 收到 U+0009
    //（HTAB 是 RFC 9110 里合法的 field-value 字符）。它的**判定**没错（照样拒），
    // 错的是我们对它的**说法**；这一格钉住判定，注释那半由评审兜。
    ["0x09 TAB（穷举才发现：解析器**收得下**，属 (c) 那一类）", 0x09, false],
    ["0x08 BS（真的 400，(b) 段的下界邻居）", 0x08, false],
    ["0x0B VT（TAB 的上邻，真的 400——差一位就会把 TAB 的例外抹平）", 0x0b, false],
    ["0x1F（DEL 之外的 C0，解析器 400）", 0x1f, false],
    ["0x20 空格（评审裁定：放行）", 0x20, true],
    ["0x7E ~（上端点）", 0x7e, true],
    ["0x7F DEL（解析器 400）", 0x7f, false],
    ["0x85 NEL（实测 Node 解析器**不拒**，仍按稳健性取舍拦）", 0x85, false],
    ["0xE9 é（实测端到端能用，仍按稳健性取舍拦）", 0xe9, false],
    ["0xFF ÿ", 0xff, false],
  ])("字符集边界是手写字面量，不从实现推导：%s", (_name, cp, allowed) => {
    const ch = String.fromCharCode(cp);
    expect(isSendable(ch), `后端对 U+${cp.toString(16)} 的判定变了`).toBe(allowed);
    expect(sendable(ch), `前端对 U+${cp.toString(16)} 的判定变了`).toBe(allowed);
  });

  /**
   * 空串走 `too_short` 而不是 `not_sendable`：那才是运维能照着改的那句话。
   * 这是量词写 `*` 唯一能被观测到的输入。
   */
  it("空串归 too_short（量词 `*` 唯一可观测的那个输入）", () => {
    expect(isSendable("")).toBe(true);
    expect(sendable("")).toBe(true);
    expect(checkAdminToken("", "g")).toEqual({ ok: false, reason: "too_short" });
  });
});
