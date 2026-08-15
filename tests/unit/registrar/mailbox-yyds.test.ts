import { describe, it, expect, vi } from "vitest";
import { YydsProvider } from "../../../src/adapters/mailbox-yyds.js";

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

describe("YydsProvider", () => {
  it("listDomains 从 data[].domain 取值并过滤空项", async () => {
    const { fetcher } = stubFetcher(() => ({
      status: 200, body: { data: [{ domain: "a.test" }, { domain: "" }, { domain: "b.test" }] },
    }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    expect(await p.listDomains()).toEqual(["a.test", "b.test"]);
  });

  it("createMailbox 带 X-API-Key 并返回 data.address", async () => {
    const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { data: { address: "u1@a.test" } } }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    const m = await p.createMailbox("a.test");
    expect(m).toEqual({ address: "u1@a.test", handle: "u1@a.test" });
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("k");
    expect(JSON.parse(calls[0]!.init.body as string).domain).toBe("a.test");
  });

  it("pollCode 逐封拉详情并优先用 verificationCode 字段", async () => {
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) return { status: 200, body: { data: { verificationCode: "654321" } } };
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 5000)).toBe("654321");
  });

  it("verificationCode 缺失时回退到从正文抠码", async () => {
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) {
        return { status: 200, body: { data: { subject: "验证码", html: "<p>您的验证码 112233</p>" } } };
      }
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 5000)).toBe("112233");
  });

  it("超时返回 null 而不抛错", async () => {
    let t = 0;
    const { fetcher } = stubFetcher(() => ({ status: 200, body: { data: { messages: [] } } }));
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 5000)).toBeNull();
  });

  it("deleteMailbox 失败不抛错（用完即删是尽力而为）", async () => {
    const { fetcher } = stubFetcher(() => ({ status: 500 }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await expect(p.deleteMailbox({ address: "u1@a.test", handle: "u1@a.test" })).resolves.toBeUndefined();
  });

  // 补充：上面的「优先用 verificationCode 字段」用例里，正文本身抠不出码，
  // 所以就算把判断顺序反过来它也照样能通过——不足以守住「顺序不能反」这条约束。
  // 这条让 detail 同时带 verificationCode 与另一个可抠码的正文，两者不同，
  // 只有真正先看 verificationCode 字段才能通过。
  it("detail 同时含 verificationCode 与可抠码正文时，取 verificationCode 而非正文里的码", async () => {
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) {
        return {
          status: 200,
          body: { data: { verificationCode: "654321", subject: "验证码", html: "<p>验证码 112233</p>" } },
        };
      }
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 5000)).toBe("654321");
  });

  // 补充：上面的「deleteMailbox 失败不抛错」用例里 fetcher 只是返回 500 状态码的
  // 正常 Response，从不 reject，try/catch 形同虚设也能通过。这条让 fetcher 真正
  // 抛异常（模拟网络错误），只有 catch 真的生效才不会向上传播。
  it("deleteMailbox 网络异常（fetch 抛错）也不向上传播", async () => {
    const fetcher = { async fetch() { throw new Error("network down"); } };
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await expect(p.deleteMailbox({ address: "u1@a.test", handle: "u1@a.test" })).resolves.toBeUndefined();
  });

  // === 评审回来的必修项 ===
  // 注：以下用例统一用「sleep 推进假时钟」而非 noSleep + now:()=>0，避免代码被
  // 改坏时陷入微任务饥饿式死循环——那种挂起不是干净的断言失败，会拖垮 CI。

  it("① 拉详情瞬时失败（如 500）后，下一轮列表仍能重试并拿到验证码，而不是永久跳过", async () => {
    let detailAttempts = 0;
    let t = 0;
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) {
        detailAttempts++;
        if (detailAttempts === 1) return { status: 500 };
        return { status: 200, body: { data: { verificationCode: "654321" } } };
      }
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 10000)).toBe("654321");
    expect(detailAttempts).toBe(2);
  });

  it("② 列表响应 200 但 body 非 JSON 时不中断轮询，下一轮仍能取到验证码", async () => {
    let listAttempts = 0;
    let t = 0;
    const fetcher = {
      async fetch(url: string) {
        if (url.includes("/v1/messages/")) {
          return new Response(JSON.stringify({ data: { verificationCode: "111222" } }), { status: 200 });
        }
        listAttempts++;
        if (listAttempts === 1) return new Response("<html>Bad Gateway</html>", { status: 200 });
        return new Response(JSON.stringify({ data: { messages: [{ id: "m1" }] } }), { status: 200 });
      },
    };
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 10000)).toBe("111222");
  });

  it("② 详情响应 200 但 body 非 JSON 时视为该封失败，不中断轮询也不抛错", async () => {
    let detailAttempts = 0;
    let t = 0;
    const fetcher = {
      async fetch(url: string) {
        if (url.includes("/v1/messages/")) {
          detailAttempts++;
          if (detailAttempts === 1) return new Response("not json", { status: 200 });
          return new Response(JSON.stringify({ data: { verificationCode: "333444" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { messages: [{ id: "m1" }] } }), { status: 200 });
      },
    };
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 10000)).toBe("333444");
  });

  it("③ deleteMailbox 失败时用 console.warn 留痕（不新建日志端口）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = { async fetch() { throw new Error("network down"); } };
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await p.deleteMailbox({ address: "u1@a.test", handle: "u1@a.test" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("u1@a.test");
    warnSpy.mockRestore();
  });

  it("④ createMailbox 用注入的 rand 生成确定的 localPart 并放进请求体", async () => {
    const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { data: { address: "fixed@a.test" } } }));
    // rand 恒定返回 0 -> 字母表第 0 位 'a'，循环 10 次生成 "aaaaaaaaaa"，加前缀 "u" 共 11 位。
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0, rand: () => 0,
    });
    await p.createMailbox("a.test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.localPart).toBe("uaaaaaaaaaa");
    expect(body.localPart).toMatch(/^u[a-z0-9]{10}$/);
  });

  it("deleteMailbox 发出的是 DELETE 到 /v1/accounts/<handle> 并带 X-API-Key", async () => {
    const { calls, fetcher } = stubFetcher(() => ({ status: 200 }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await p.deleteMailbox({ address: "u1@a.test", handle: "u1@a.test" });
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://y.test/v1/accounts/u1%40a.test");
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("k");
  });
});
