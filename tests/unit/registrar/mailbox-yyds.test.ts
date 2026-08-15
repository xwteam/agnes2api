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

  it("RM1 createMailbox 的 handle 取 data.id 而不是 data.address", async () => {
    // 真机契约：收信要 address（`/v1/messages?address=`），删除要 id
    // （`/v1/accounts/{id}`），两个接口用的键不一样。fixture 里 address 与 id
    // **必须取不同的值**，否则这条就是「谁赢都通过」的假阳性。
    const { calls, fetcher } = stubFetcher(() => ({
      status: 200, body: { data: { address: "u1@a.test", id: "acct-42" } },
    }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    const m = await p.createMailbox("a.test");
    expect(m).toEqual({ address: "u1@a.test", handle: "acct-42" });
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("k");
    expect(JSON.parse(calls[0]!.init.body as string).domain).toBe("a.test");
  });

  it("RM1 createMailbox 响应有 address 但缺 id 时抛错（缺 id 等于删不掉）", async () => {
    // 与上一条成对：只校验 address 的实现会让 handle 落成 undefined，删邮箱 100% 打空。
    const { fetcher } = stubFetcher(() => ({ status: 200, body: { data: { address: "u1@a.test" } } }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await expect(p.createMailbox("a.test")).rejects.toThrow(/data\.id/);
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
    const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { data: { address: "fixed@a.test", id: "acct-fixed" } } }));
    // rand 恒定返回 0 -> 字母表第 0 位 'a'，循环 10 次生成 "aaaaaaaaaa"，加前缀 "u" 共 11 位。
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0, rand: () => 0,
    });
    await p.createMailbox("a.test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.localPart).toBe("uaaaaaaaaaa");
    expect(body.localPart).toMatch(/^u[a-z0-9]{10}$/);
  });

  // === RM3：建邮箱解析失败时不做无效兜底，改成诚实告警 ===
  // 响应 2xx 但解析不出 data.address/data.id 时，邮箱**可能已经在上游建出来了**。
  // 此前这里按 `localPart@domain` 兜底删一次——但删除要 id，而 id 恰恰就是这条
  // 路径丢掉的东西（真机实测用 address 删恒 404，且没有按 address 反查 id 的端点）。
  // 那次 DELETE 只会稳定产出假 404，稀释「邮箱在堆积」这个真信号。

  it("RM3 createMailbox 缺 data.id 时不发出注定 404 的兜底 DELETE，只留一条诚实告警", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { data: {} } }));
      const p = new YydsProvider({
        fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0, rand: () => 0,
      });
      await expect(p.createMailbox("a.test")).rejects.toThrow(/data\.address|data\.id/);
      // 只有建邮箱那一次请求：不再有第二次注定失败的 DELETE。
      expect(calls).toHaveLength(1);
      expect(calls.some((c) => (c.init.method ?? "GET") === "DELETE")).toBe(false);
      // 告警要能人工核对（带 localPart@domain）并说明它什么时候自己消失。
      const msg = String(warnSpy.mock.calls[0]?.[0]);
      expect(msg).toContain("uaaaaaaaaaa@a.test");
      expect(msg).toContain("24");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("RM3 createMailbox 响应 2xx 但正文非 JSON 时同样只告警、不发兜底 DELETE", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
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
      await expect(p.createMailbox("a.test")).rejects.toThrow(/无法解析|data\.address|data\.id/);
      expect(calls).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
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
      return { status: 200, body: { data: { address: "u1@a.test", id: "acct-42" } } };
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

  // === RM7：详情的 html 字段真机上是数组，不是字符串 ===

  it("RM7 detail.html 是多段数组时按段拼接，逗号拼接会抠出错误的码", async () => {
    // 真机实测 html 是数组（元素数 1），单元素时 `${array}` 碰巧等价于该元素，
    // 所以旧实现一直能工作。多段时 `${array}` 走 Array.prototype.toString，用
    // **逗号**拼接——而 extractCode 的快路径要求
    // `class="…verification…">\s*(\d{6})\s*<`，逗号不是 `\s`，快路径直接失配，
    // 于是回退到"全文第一个六位数"，被正文里排在前面的订单号抢走。
    //
    // 这条用例特意让两种拼接产出**不同**的结果（逗号 → 998877，换行 → 246813），
    // 而不是随便造一段多段 HTML——后者两条路都能通过，等于没测。
    let t = 0;
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) {
        return {
          status: 200,
          body: { data: { subject: "Your Agnes Platform Verification Code", html: [
            "<div>Order 998877</div><p class=\"verification-code\">",
            "246813",
            "</p>",
          ] } },
        };
      }
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "acct-42" }, 5000)).toBe("246813");
  });

  it("RM7 detail.html 仍是字符串时照常工作（不能为了修数组把字符串路径改坏）", async () => {
    let t = 0;
    const { fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) {
        return { status: 200, body: { data: { subject: "验证码", html: "<p>您的验证码 135791</p>" } } };
      }
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "acct-42" }, 5000)).toBe("135791");
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

  it("RM1 deleteMailbox 打在 /v1/accounts/<id> 上（不是 address）", async () => {
    // address 与 handle(id) 取不同的值，两条路径不再殊途同归：实现若沿用
    // `/v1/accounts/{address}`（真机实测恒 404），这条会红。
    const { calls, fetcher } = stubFetcher(() => ({ status: 200 }));
    const p = new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", sleep: noSleep, now: () => 0 });
    await p.deleteMailbox({ address: "u1@a.test", handle: "acct-42" });
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://y.test/v1/accounts/acct-42");
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("k");
  });

  it("RM1 pollCode 的 address= 带的是 address（不是 id），列表与详情两处都是", async () => {
    // 真机实测：`GET /v1/messages?address={id}` 返回 404 inbox_not_found。
    // 这里 address 与 handle 取不同值，实现若沿用 mailbox.handle 就会红。
    let t = 0;
    const { calls, fetcher } = stubFetcher((url) => {
      if (url.includes("/v1/messages/")) return { status: 200, body: { data: { verificationCode: "654321" } } };
      return { status: 200, body: { data: { messages: [{ id: "m1" }] } } };
    });
    const p = new YydsProvider({
      fetcher, baseUrl: "https://y.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t,
    });
    expect(await p.pollCode({ address: "u1@a.test", handle: "acct-42" }, 5000)).toBe("654321");
    expect(calls[0]!.url).toBe("https://y.test/v1/messages?address=u1%40a.test");
    expect(calls[1]!.url).toBe("https://y.test/v1/messages/m1?address=u1%40a.test");
    expect(calls.every((c) => !c.url.includes("acct-42"))).toBe(true);
  });
});
