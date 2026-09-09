import { describe, it, expect } from "vitest";
import {
  redactUrl, httpFailMessage, httpFail, httpFailStatus, transportFailMessage, redactInMessage,
  UNPARSEABLE_URL, UNSAFE_MESSAGE,
} from "../../../src/core/registrar/url.js";

/**
 * 哨兵串用 `sentinel*` 前缀而不是 `user` / `pw`：短串可能在别的字里自然出现，
 * 「不包含」这一类断言会因此假阴性（`pw` 恰好是某个 host 名的一部分就通不过了）。
 */
const CREDS_URL = "https://sentineluser:sentinelsecret@h.invalid:8443/v1/domains?k=SENTINELQ#SENTINELF";

describe("redactUrl", () => {
  it("脱敏真的脱了，而且没把诊断信息一起删掉", () => {
    const out = redactUrl(CREDS_URL);
    // ① 该抹的都抹了
    expect(out).not.toContain("sentinelsecret");
    expect(out).not.toContain("sentineluser");
    expect(out).not.toContain("SENTINELQ");
    expect(out).not.toContain("SENTINELF");
    // ② 该留的都留着——**这一半同样是判据**：一个把整串换成 `<redacted>` 的实现
    // 也能通过上面四条，而它把这条日志唯一的诊断价值一起删掉了。
    expect(out).toContain("***@");
    expect(out).toContain("h.invalid:8443");
    expect(out).toContain("/v1/domains");
    expect(out).toContain("<redacted>");
  });

  it("解析不开时返回固定占位串，绝不回落成原样输出", () => {
    // `toBe` 不是 `toContain`：回落原串的实现里，原串同样「包含」不了占位符，
    // 但一个「占位符 + 原串」的折中实现能骗过 toContain。
    expect(redactUrl("not a url")).toBe(UNPARSEABLE_URL);
    expect(redactUrl("not a url")).not.toContain("not a url");
  });

  it("幂等：脱敏过的串再脱一次还是它自己", () => {
    // 事件在两条路上都可能被再包一层（消息串搬运 + fields 里单开一格），
    // 不幂等的话第二遍会把 `***@` 或占位符当成新的凭据/查询串再改一次形状。
    const once = redactUrl(CREDS_URL);
    expect(redactUrl(once)).toBe(once);
  });
});

describe("httpFailMessage", () => {
  it("消息里同时有状态码与脱敏后的地址，方法名照实报", () => {
    const msg = httpFailMessage({
      provider: "YYDS", action: "建邮箱", method: "POST",
      url: "https://sentineluser:sentinelsecret@h.invalid/v1/accounts", status: 403,
    });
    expect(msg).toContain("403");
    expect(msg).toContain("POST");
    // 写死 GET 的实现会在这里说一个它没发过的方法——那是新的一句假话。
    expect(msg).not.toContain("GET");
    expect(msg).toContain("h.invalid/v1/accounts");
    expect(msg).not.toContain("sentinelsecret");
  });

  /**
   * 🔴 **`httpFail` 与 `httpFailMessage` 出自同一个工厂：消息逐字节相同，状态码取得回来。**
   *
   * 这一格钉两件事，缺任何一件都会长出一句假话：
   * ① **逐字节相等** —— `httpFail` 自己另拼一句消息的话，「消息里写着 404、属性上挂着 403」
   *    就有了长出来的地方；
   * ② **状态码不是从 message 里抠出来的** —— 拿一个 message 长得一模一样、但**不是**
   *    `httpFail` 造的 Error 喂进去，必须得到 `null`。改成正则抠 `HTTP (\d+)` 时这一条当场红，
   *    而那正是 `src/core/config-provenance.ts`「不要用关键词启发式」那条禁令管着的形态。
   */
  it("httpFail 与 httpFailMessage 同构：message 逐字节相等，且状态码取得回来", () => {
    const p = {
      provider: "YYDS", action: "列域名", method: "GET",
      url: "https://sentineluser:sentinelsecret@h.invalid/v1/domains", status: 403,
    };
    const err = httpFail(p);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(httpFailMessage(p));
    expect(httpFailStatus(err)).toBe(403);

    // ② 消息串长得一模一样，但它不是这个工厂造的 ⇒ 读不到状态码，而不是「抠出 404」。
    const handRolled = new Error(httpFailMessage({ ...p, status: 404 }));
    expect(handRolled.message).toContain("HTTP 404");
    expect(httpFailStatus(handRolled), "状态码是从 message 里抠出来的").toBeNull();

    // 边界：不是对象 / 没有那个属性 / 属性不是有限整数 ⇒ 一律 null，**不许兜底成 0**。
    expect(httpFailStatus(null)).toBeNull();
    expect(httpFailStatus("HTTP 403")).toBeNull();
    expect(httpFailStatus(Object.assign(new Error("x"), { status: "403" }))).toBeNull();
    expect(httpFailStatus(Object.assign(new Error("x"), { status: 4.5 }))).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 「fetch 压根没发出去」那一半 —— 上一版这里是**零覆盖**
 *
 * ⚠️ 上一版的判据只覆盖 `if (!r.ok)` 那一支（请求发得出去、上游回非 2xx）。
 * baseUrl 带 userinfo 时那一支**一行都不执行**：undici 在构造 Request 的那一步就抛，
 * 而它自己的 message 里带着完整的原始 URL，一路裸搬进事件板块与容器 stdout。
 * 下面这一族钉的就是另一半。
 * ══════════════════════════════════════════════════════════════════════════ */
describe("redactInMessage（运行时自己写的那句话）", () => {
  /**
   * ⚠️ **这一串不是编的。** 本机 Node v24.15.0 的 undici 对
   * `fetch("https://user:pass@host/path")` 实际抛出的 `TypeError.message`
   * 逐字就是下面这个模板（真跑过一次抄回来的），冒号后面是**原样的完整 URL**。
   */
  const undiciMsg = (u: string) =>
    `Request cannot be constructed from a URL that includes credentials: ${u}`;

  it("运行时把完整 URL 写进了 message：口令没了，地址还在", () => {
    const url = "https://sentineluser:sentinelsecret@h.invalid/v1/domains";
    const out = redactInMessage(undiciMsg(url), url);
    expect(out).not.toContain("sentinelsecret");
    // 后半截同样是判据：整段丢掉的实现也能通过上面那条，而它把唯一的线索一起删了。
    expect(out).toContain("Request cannot be constructed");
    expect(out).toContain("***@h.invalid/v1/domains");
  });

  it("口令以**另一种形态**残留（不等于原串）⇒ 整段丢弃，而不是放它过去", () => {
    // 运行时把 URL 重新拼过（这里模拟「大小写/前缀变了、但口令还在」），于是
    // 「把原串替换掉」这一招够不着它。**只做替换、不做回查**的实现会在这里放行。
    const url = "https://sentineluser:sentinelsecret@h.invalid/v1/domains";
    const out = redactInMessage(`connect ECONNREFUSED for sentinelsecret@h.invalid`, url);
    expect(out).toBe(UNSAFE_MESSAGE);
    expect(out).not.toContain("sentinelsecret");
  });

  it("URL 解析不开 ⇒ 无条件整段丢弃（连哪几段是凭据都说不出来时不许赌）", () => {
    // 与 `redactUrl` 那格用同一个「解析不开」的支点（`not a url`）。
    // ⚠️ **别拿 `oops:pw@x` 当解析不开的例子**：它其实解析得开（非特殊协议，
    // `pw@x` 整个落在 pathname 上），本轮实测过 —— 那种形态属于文件头登记的
    // 「凭据写在路径段里挡不住」那条已知缺口，不是这一格要测的东西。
    const raw = "not a url/v1/domains";
    expect(redactInMessage(`Failed to parse URL from ${raw}`, raw)).toBe(UNSAFE_MESSAGE);
  });

  it("反向控制：URL 里一个凭据成分都没有时，消息原样放行（不许乱丢）", () => {
    // 少了这一格，一个「无论如何都返回 UNSAFE_MESSAGE」的实现能通过上面三格，
    // 而它把每一条网络诊断都变成了同一句废话。
    const url = "https://h.invalid/v1/domains";
    expect(redactInMessage("fetch failed", url)).toBe("fetch failed");
  });

  it("查询串与片段也在射程里（凭据不是只会写在 userinfo 上）", () => {
    const url = "https://h.invalid/v1?token=SENTINELQ#SENTINELF";
    const out = redactInMessage(undiciMsg(url), url);
    expect(out).not.toContain("SENTINELQ");
    expect(out).not.toContain("SENTINELF");
  });
});

describe("transportFailMessage", () => {
  it("与 httpFailMessage 同构：同一个前缀、同一个 (方法 地址) 尾巴", () => {
    const url = "https://sentineluser:sentinelsecret@h.invalid/v1/accounts";
    const t = transportFailMessage({
      provider: "YYDS", action: "建邮箱", method: "POST", url,
      cause: new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`),
    });
    const h = httpFailMessage({ provider: "YYDS", action: "建邮箱", method: "POST", url, status: 403 });
    // 「两半失败在日志里长同一个样」这条性质本身就是判据：运维不必先分辨自己撞上的
    // 是哪一半，才知道该去哪儿找地址。
    expect(t.startsWith("YYDS 建邮箱失败: ")).toBe(true);
    expect(h.startsWith("YYDS 建邮箱失败: ")).toBe(true);
    expect(t.endsWith(`(POST ${redactUrl(url)})`)).toBe(true);
    expect(h.endsWith(`(POST ${redactUrl(url)})`)).toBe(true);
    expect(t).not.toContain("sentinelsecret");
    // 写死 GET 的实现会在这里说一个它没发过的方法。
    expect(t).not.toContain("GET");
  });

  it("非 Error 抛出物也照样过一遍脱敏（`throw \"…\"` 不是不可能）", () => {
    const url = "https://sentineluser:sentinelsecret@h.invalid/v1/domains";
    const out = transportFailMessage({
      provider: "MoeMail", action: "列域名", method: "GET", url, cause: url,
    });
    expect(out).not.toContain("sentinelsecret");
  });
});
