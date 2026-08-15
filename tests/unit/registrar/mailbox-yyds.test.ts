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
    // 递进假时钟而非 noSleep + now:()=>0：被测代码一旦取不到码，后者会陷入微任务
    // 饥饿式挂起（整个进程卡死、定位不到具体用例），前者只是正常地断言失败。
    let t = 0;
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) return { status: 200, body: { data: { verificationCode: "654321" } } };
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 5000)).toBe("654321");
  });

  it("verificationCode 缺失时回退到从正文抠码", async () => {
    let t = 0;
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) {
        return { status: 200, body: { data: { subject: "验证码", html: "<p>您的验证码 112233</p>" } } };
      }
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
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
    let t = 0;
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) {
        return {
          status: 200,
          body: { data: { verificationCode: "654321", subject: "验证码", html: "<p>验证码 112233</p>" } },
        };
      }
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
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

  // 上面那条 ③ 只覆盖了「fetch 抛异常」这条路径。真实上游更常见的是 404/403/500——
  // 这些会让 fetch 正常 resolve，压根进不了 catch，此前一条日志都不记，等于删邮箱
  // 失败 100% 静默。带状态码断言，避免实现只是笼统 warn 一句而丢掉排障信息。
  it("③b deleteMailbox 收到非 2xx（不抛错的失败路径）也 warn 留痕并带上状态码", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = stubFetcher(() => ({ status: 404 }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await expect(p.deleteMailbox({ address: "u1@a.test", handle: "u1@a.test" })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("u1@a.test");
    expect(msg).toContain("404");
    warnSpy.mockRestore();
  });

  it("③c deleteMailbox 成功（2xx）时不产生噪音日志", async () => {
    // 与 ③b 成对：只有「非 2xx 才 warn」才能同时通过这两条。若实现改成无条件 warn，
    // 这条会红。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = stubFetcher(() => ({ status: 200 }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await p.deleteMailbox({ address: "u1@a.test", handle: "u1@a.test" });
    expect(warnSpy).not.toHaveBeenCalled();
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

  // === I7：建邮箱的不可恢复泄漏 ===
  // 响应 2xx 但正文解析不出 data.address 时，邮箱**可能已经在上游建出来了**，
  // 而 handle 丢失就永远删不掉（YYDS 侧没有 TTL，永久占配额）。抛错之前必须用
  // 请求时已知的 localPart@domain 兜底删一次。

  it("I7 createMailbox 响应 2xx 但缺 data.address 时，按 localPart@domain 兜底删除后再抛错", async () => {
    const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { data: {} } }));
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0, rand: () => 0,
    });
    await expect(p.createMailbox("a.test")).rejects.toThrow(/data\.address/);
    // 第 2 次调用必须是针对刚才那个 localPart 的 DELETE，否则邮箱就泄漏了。
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.method).toBe("DELETE");
    expect(calls[1]!.url).toBe("https://y.test/v1/accounts/uaaaaaaaaaa%40a.test");
  });

  it("I7 createMailbox 响应 2xx 但正文非 JSON 时，同样兜底删除后再抛错", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = {
      async fetch(url: string, init: RequestInit) {
        calls.push({ url, init });
        if ((init.method ?? "GET") === "DELETE") return new Response("{}", { status: 200 });
        return new Response("<html>Bad Gateway</html>", { status: 200 });
      },
    };
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0, rand: () => 0,
    });
    await expect(p.createMailbox("a.test")).rejects.toThrow(/无法解析|data\.address/);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.method).toBe("DELETE");
    expect(calls[1]!.url).toBe("https://y.test/v1/accounts/uaaaaaaaaaa%40a.test");
  });

  it("createMailbox 非 2xx 时抛错并带上状态码，且不发出兜底删除（上游没建成，别乱删）", async () => {
    const { calls, fetcher } = stubFetcher(() => ({ status: 429 }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await expect(p.createMailbox("a.test")).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });

  it("listDomains 非 2xx 时抛错并带上状态码（通道级失败信号）", async () => {
    const { fetcher } = stubFetcher(() => ({ status: 401 }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await expect(p.listDomains()).rejects.toThrow(/401/);
  });

  it("I2 四类请求（列域名/建邮箱/轮询/删邮箱）都带单请求超时的 signal", async () => {
    // pollCode 的截止判断只在每轮循环开头做一次，请求本身挂起是不计入的——
    // 单请求超时是这条链路上唯一能兜住挂起连接的东西。
    let t = 0;
    const { calls, fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) return { status: 200, body: { data: { verificationCode: "654321" } } };
      if (url.includes("/v1/messages")) return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
      if (url.includes("/v1/domains")) return { status: 200, body: { data: [{ domain: "a.test" }] } };
      return { status: 200, body: { data: { address: "u1@a.test" } } };
    });
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    await p.listDomains();
    const m = await p.createMailbox("a.test");
    await p.pollCode(m, 5000);
    await p.deleteMailbox(m);
    expect(calls.length).toBe(5); // 列域名 + 建邮箱 + 列消息 + 拉详情 + 删邮箱
    for (const c of calls) {
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect(c.init.signal!.aborted).toBe(false);
    }
  });

  // === M3：轮询期间 fetch reject 与非 2xx 的容错必须对称 ===
  //
  // 同一个瞬时故障，返回 HTTP 500 时轮询继续、fetch reject（TCP reset / 单请求超时
  // 到点的 TimeoutError）时却穿出 pollCode、被 mint.ts 收成 network_error 作废整次
  // 铸 key——而那一刻验证码往往已经在邮箱里、窗口还剩 100 多秒。

  it("M3 列表请求 reject（网络抖动/超时）后不中断轮询，下一轮仍能取到验证码", async () => {
    let listAttempts = 0;
    let t = 0;
    const fetcher = {
      async fetch(url: string) {
        if (url.includes("/v1/messages/")) {
          return new Response(JSON.stringify({ data: { verificationCode: "654321" } }), { status: 200 });
        }
        listAttempts++;
        // 第 1 次以 TimeoutError reject——这正是 AbortSignal.timeout 到点时的真实行为。
        if (listAttempts === 1) throw new DOMException("The operation was aborted", "TimeoutError");
        return new Response(JSON.stringify({ data: { messages: [{ id: "m1" }] } }), { status: 200 });
      },
    };
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 10000)).toBe("654321");
    expect(listAttempts).toBe(2);
  });

  it("M3 详情请求 reject 时不写 seen，下一轮重新拉同一封仍能取到验证码", async () => {
    // 与「详情非 2xx」那条同构：reject 也不能让这封邮件被永久跳过，否则会一路空转到
    // 超时。断言 detailAttempts=2 才能证明真的重试了同一封，而不是靠别的邮件蒙对。
    let detailAttempts = 0;
    let t = 0;
    const fetcher = {
      async fetch(url: string) {
        if (url.includes("/v1/messages/")) {
          detailAttempts++;
          if (detailAttempts === 1) throw new Error("ECONNRESET");
          return new Response(JSON.stringify({ data: { verificationCode: "778899" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { messages: [{ id: "m1" }] } }), { status: 200 });
      },
    };
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 10000)).toBe("778899");
    expect(detailAttempts).toBe(2);
  });

  it("M3 全程 reject 时按超时返回 null，而不是把异常抛给调用方", async () => {
    // 成对用例：容错不等于吞掉一切——CODE_TIMEOUT_MS 仍是唯一的轮询截止依据。
    let t = 0;
    const fetcher = { async fetch(): Promise<Response> { throw new Error("ECONNRESET"); } };
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    await expect(p.pollCode({ address: "u1@a.test", handle: "u1@a.test" }, 9000)).resolves.toBeNull();
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
