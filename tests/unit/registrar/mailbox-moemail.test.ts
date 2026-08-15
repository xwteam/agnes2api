import { describe, it, expect, vi } from "vitest";
import { MoeMailProvider } from "../../../src/adapters/mailbox-moemail.js";

function stubFetcher(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetcher: {
      async fetch(url: string, init: RequestInit) {
        calls.push({ url, init });
        const r = handler(url, init);
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
      },
    },
  };
}

const noSleep = async () => {};

describe("MoeMailProvider", () => {
  it("listDomains 按逗号拆分字符串、去空白并过滤空项", async () => {
    const { calls, fetcher } = stubFetcher(() => ({
      status: 200, body: { emailDomains: "a.test, b.test,,c.test" },
    }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    expect(await p.listDomains()).toEqual(["a.test", "b.test", "c.test"]);
    expect(calls[0]!.url).toBe("https://m.test/api/config");
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("k");
  });

  it("createMailbox 带 X-API-Key，请求体含 name/expiryTime/domain，handle 用 id 而非 email", async () => {
    // id 与 email 特意给不同的值：如果实现误把 handle 设成 email（照抄 YYDS 的
    // "handle=address"），这条断言才会真正失败，而不是两条路径殊途同归。
    const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { id: "eid-99", email: "zzz@a.test" } }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    const m = await p.createMailbox("a.test");
    expect(m).toEqual({ address: "zzz@a.test", handle: "eid-99" });
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("k");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.domain).toBe("a.test");
    expect(typeof body.name).toBe("string");
    expect(body.expiryTime).toBe(3_600_000);
  });

  it("pollCode 一次请求即取到验证码，无需逐封拉详情", async () => {
    let t = 0;
    const { calls, fetcher } = stubFetcher((url) => {
      if (url.includes("/api/emails/eid-1")) {
        return { status: 200, body: { messages: [{ id: "m1", subject: "验证码", content: "您的验证码 654321" }] } };
      }
      return { status: 200, body: {} };
    });
    // 用递进假时钟而非 noSleep+now:()=>0：若被测代码拿不到码会陷入微任务饥饿式
    // 挂起（本任务里用变异测试真实复现过），递进时钟至少能让用例正常超时失败。
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u@a.test", handle: "eid-1" }, 5000)).toBe("654321");
    // 只应打这一次请求：GET /api/emails/<id>，不存在第二次拉详情的请求。
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://m.test/api/emails/eid-1");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("从消息的 content 字段抠码（而非 subject）", async () => {
    // subject 里没有六位数，只有 content 里有——如果实现读错字段名（比如误用
    // text 而非 content），extractCode 拿不到正文，会一路超时返回 null。
    let t = 0;
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/api/emails/eid-1")) {
        return { status: 200, body: { messages: [{ id: "m1", subject: "邮件通知", content: "验证码：998877" }] } };
      }
      return { status: 200, body: {} };
    });
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u@a.test", handle: "eid-1" }, 5000)).toBe("998877");
  });

  it("超时返回 null 而不抛错", async () => {
    let t = 0;
    const { fetcher } = stubFetcher(() => ({ status: 200, body: { messages: [] } }));
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u@a.test", handle: "eid-1" }, 5000)).toBeNull();
  });

  it("deleteMailbox 发出 DELETE 到 /api/emails/<id> 并带 X-API-Key", async () => {
    const { calls, fetcher } = stubFetcher(() => ({ status: 200 }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await p.deleteMailbox({ address: "u@a.test", handle: "eid-1" });
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://m.test/api/emails/eid-1");
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("k");
  });

  it("deleteMailbox 网络异常（fetch 抛错）也不向上传播", async () => {
    const fetcher = { async fetch() { throw new Error("network down"); } };
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await expect(p.deleteMailbox({ address: "u@a.test", handle: "eid-1" })).resolves.toBeUndefined();
  });

  it("deleteMailbox 失败时用 console.warn 留痕（不新建日志端口）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = { async fetch() { throw new Error("network down"); } };
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await p.deleteMailbox({ address: "u1@a.test", handle: "eid-1" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("u1@a.test");
    warnSpy.mockRestore();
  });

  // 与上一条成对：上一条只覆盖「fetch 抛异常」，而 404/403/500 会正常 resolve、
  // 进不了 catch，是最常见的失败路径。MoeMail 侧同样有活跃邮箱上限（上游默认 30），
  // 删不掉照样把配额吃光，必须留痕。
  it("deleteMailbox 收到非 2xx（不抛错的失败路径）也 warn 留痕并带上状态码", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = stubFetcher(() => ({ status: 500 }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await expect(p.deleteMailbox({ address: "u1@a.test", handle: "eid-1" })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("u1@a.test");
    expect(msg).toContain("500");
    warnSpy.mockRestore();
  });

  it("deleteMailbox 成功（2xx）时不产生噪音日志", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = stubFetcher(() => ({ status: 200 }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await p.deleteMailbox({ address: "u1@a.test", handle: "eid-1" });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("createMailbox 用注入的 rand 生成确定的 name 并放进请求体", async () => {
    const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { id: "eid-1", email: "fixed@a.test" } }));
    // rand 恒定返回 0 -> 字母表第 0 位 'a'，循环 10 次生成 "aaaaaaaaaa"，加前缀 "u" 共 11 位。
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, rand: () => 0,
    });
    await p.createMailbox("a.test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.name).toBe("uaaaaaaaaaa");
    expect(body.name).toMatch(/^u[a-z0-9]{10}$/);
  });

  it("轮询响应 200 但 body 非 JSON 时不中断，下一轮仍能取到验证码", async () => {
    let attempts = 0;
    let t = 0;
    const fetcher = {
      async fetch() {
        attempts++;
        if (attempts === 1) return new Response("not json", { status: 200 });
        return new Response(JSON.stringify({
          messages: [{ id: "m1", subject: "验证码", content: "您的验证码 445566" }],
        }), { status: 200 });
      },
    };
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u@a.test", handle: "eid-1" }, 10000)).toBe("445566");
    expect(attempts).toBe(2);
  });
});
