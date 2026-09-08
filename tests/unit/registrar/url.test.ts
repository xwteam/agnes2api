import { describe, it, expect } from "vitest";
import { redactUrl, httpFailMessage, UNPARSEABLE_URL } from "../../../src/core/registrar/url.js";

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
});
