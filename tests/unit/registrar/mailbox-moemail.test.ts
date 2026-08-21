import { describe, it, expect } from "vitest";
import { MoeMailProvider } from "../../../src/adapters/mailbox-moemail.js";
import { NULL_LOGGER } from "../../../src/ports/logger.js";
import { recordingLogger } from "../../helpers/recording-logger.js";

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
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger: NULL_LOGGER });
    expect(await p.listDomains()).toEqual(["a.test", "b.test", "c.test"]);
    expect(calls[0]!.url).toBe("https://m.test/api/config");
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("k");
  });

  it("createMailbox 带 X-API-Key，请求体含 name/expiryTime/domain，handle 用 id 而非 email", async () => {
    // id 与 email 特意给不同的值：如果实现误把 handle 设成 email（照抄 YYDS 的
    // "handle=address"），这条断言才会真正失败，而不是两条路径殊途同归。
    const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { id: "eid-99", email: "zzz@a.test" } }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger: NULL_LOGGER });
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
      sleep: async () => { t += 3000; }, now: () => t, logger: NULL_LOGGER,
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
      sleep: async () => { t += 3000; }, now: () => t, logger: NULL_LOGGER,
    });
    expect(await p.pollCode({ address: "u@a.test", handle: "eid-1" }, 5000)).toBe("998877");
  });

  it("超时返回 null 而不抛错", async () => {
    let t = 0;
    const { fetcher } = stubFetcher(() => ({ status: 200, body: { messages: [] } }));
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t, logger: NULL_LOGGER,
    });
    expect(await p.pollCode({ address: "u@a.test", handle: "eid-1" }, 5000)).toBeNull();
  });

  it("deleteMailbox 发出 DELETE 到 /api/emails/<id> 并带 X-API-Key", async () => {
    const { calls, fetcher } = stubFetcher(() => ({ status: 200 }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger: NULL_LOGGER });
    await p.deleteMailbox({ address: "u@a.test", handle: "eid-1" });
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://m.test/api/emails/eid-1");
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("k");
  });

  it("I2 四类请求（列域名/建邮箱/轮询/删邮箱）都带单请求超时的 signal", async () => {
    let t = 0;
    const { calls, fetcher } = stubFetcher((url, init) => {
      if (url.includes("/api/config")) return { status: 200, body: { emailDomains: "a.test" } };
      if (url.includes("/api/emails/generate")) return { status: 200, body: { id: "eid-1", email: "u@a.test" } };
      if ((init.method ?? "GET") === "GET") {
        return { status: 200, body: { messages: [{ id: "m1", subject: "验证码", content: "验证码 654321" }] } };
      }
      return { status: 200, body: {} };
    });
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t, logger: NULL_LOGGER,
    });
    await p.listDomains();
    const m = await p.createMailbox("a.test");
    await p.pollCode(m, 5000);
    await p.deleteMailbox(m);
    expect(calls.length).toBe(4); // 列域名 + 建邮箱 + 轮询 + 删邮箱
    for (const c of calls) {
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect(c.init.signal!.aborted).toBe(false);
    }
  });

  it("deleteMailbox 网络异常（fetch 抛错）也不向上传播", async () => {
    const fetcher = { async fetch() { throw new Error("network down"); } };
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger: NULL_LOGGER });
    await expect(p.deleteMailbox({ address: "u@a.test", handle: "eid-1" })).resolves.toBeUndefined();
  });

  it("deleteMailbox 失败时记 registrar.delete_mailbox_failed 事件（不新建日志端口）", async () => {
    // console.* 已经被换成注入的 Logger：spy console 只会看到空 mock，必须改成
    // recordingLogger 断言事件名 + fields。
    const logger = recordingLogger();
    const fetcher = { async fetch() { throw new Error("network down"); } };
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger });
    await p.deleteMailbox({ address: "u1@a.test", handle: "eid-1" });
    const e = logger.entries.find((x) => x.event === "registrar.delete_mailbox_failed");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    expect(e?.fields?.provider).toBe("moemail");
    expect(e?.fields?.address).toBe("u1@a.test");
  });

  // 与上一条成对：上一条只覆盖「fetch 抛异常」，而 404/403/500 会正常 resolve、
  // 进不了 catch，是最常见的失败路径。MoeMail 侧同样有活跃邮箱上限（数字与出处见
  // `src/adapters/mailbox-moemail.ts` 的文件头，那里同时写明它是一个可被实例覆盖
  // 的上游默认值），删不掉照样把配额吃光，必须留痕。
  it("deleteMailbox 收到非 2xx（不抛错的失败路径）也记事件并带上状态码", async () => {
    const logger = recordingLogger();
    const { fetcher } = stubFetcher(() => ({ status: 500 }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger });
    await expect(p.deleteMailbox({ address: "u1@a.test", handle: "eid-1" })).resolves.toBeUndefined();
    const e = logger.entries.find((x) => x.event === "registrar.delete_mailbox_failed");
    expect(e).toBeDefined();
    expect(e?.fields?.address).toBe("u1@a.test");
    expect(e?.fields?.status).toBe(500);
  });

  it("deleteMailbox 成功（2xx）时不产生噪音日志", async () => {
    const logger = recordingLogger();
    const { fetcher } = stubFetcher(() => ({ status: 200 }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger });
    await p.deleteMailbox({ address: "u1@a.test", handle: "eid-1" });
    expect(logger.entries).toEqual([]);
  });

  it("createMailbox 用注入的 rand 生成确定的 name 并放进请求体", async () => {
    const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { id: "eid-1", email: "fixed@a.test" } }));
    // rand 恒定返回 0 -> 字母表第 0 位 'a'，循环 10 次生成 "aaaaaaaaaa"，加前缀 "u" 共 11 位。
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, rand: () => 0,
      logger: NULL_LOGGER,
    });
    await p.createMailbox("a.test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.name).toBe("uaaaaaaaaaa");
    expect(body.name).toMatch(/^u[a-z0-9]{10}$/);
  });

  // === I7：建邮箱的不可恢复泄漏（MoeMail 侧只能留痕） ===
  // MoeMail 用服务端生成的 id 定位邮箱，请求侧推断不出，没法像 YYDS 那样兜底
  // 删除；这里明确其泄漏语义：抛错、留痕、指明只能等 TTL 自愈。

  it("I7 createMailbox 响应 2xx 但缺 id 时抛错，并记事件说明只能等 TTL 自愈", async () => {
    const logger = recordingLogger();
    const { calls, fetcher } = stubFetcher(() => ({ status: 200, body: { email: "u@a.test" } }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger });
    await expect(p.createMailbox("a.test")).rejects.toThrow(/id/);
    // 没有 handle 就删不掉，不该凭空发出一个删不中的 DELETE。
    expect(calls).toHaveLength(1);
    const e = logger.entries.find((x) => x.event === "registrar.mailbox_create_unparseable");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    expect(e?.fields?.provider).toBe("moemail");
    expect(e?.fields?.domain).toBe("a.test");
    expect(e?.fields?.ttlMinutes).toBe(60);
  });

  it("I7 createMailbox 响应 2xx 但正文非 JSON 时同样抛错并留痕（而不是抛出解析异常）", async () => {
    const logger = recordingLogger();
    const fetcher = { async fetch() { return new Response("<html>502</html>", { status: 200 }); } };
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger });
    await expect(p.createMailbox("a.test")).rejects.toThrow(/缺少 id 或 email/);
    expect(logger.has("registrar.mailbox_create_unparseable")).toBe(true);
  });

  it("createMailbox 非 2xx 时抛错并带上状态码（配额超限的 403 就走这条）", async () => {
    const { fetcher } = stubFetcher(() => ({ status: 403 }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger: NULL_LOGGER });
    await expect(p.createMailbox("a.test")).rejects.toThrow(/403/);
  });

  it("listDomains 非 2xx 时抛错并带上状态码（通道级失败信号）", async () => {
    const { fetcher } = stubFetcher(() => ({ status: 500 }));
    const p = new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", sleep: noSleep, now: () => 0, logger: NULL_LOGGER });
    await expect(p.listDomains()).rejects.toThrow(/500/);
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
      sleep: async () => { t += 3000; }, now: () => t, logger: NULL_LOGGER,
    });
    expect(await p.pollCode({ address: "u@a.test", handle: "eid-1" }, 10000)).toBe("445566");
    expect(attempts).toBe(2);
  });

  it("RM7 消息的 html 若是数组也按段拼接（上游库里是 text 列，这里是防御性对齐）", async () => {
    // MoeMail 上游 `messages[].html` 在库里是 text 列（字符串），数组形态是 YYDS
    // 那边的真机事实。两家共用同一条解析路径，避免以后各自漂移；用与 YYDS 同款的
    // 判别式 fixture（逗号拼接 → 998877，换行拼接 → 246813）。
    let t = 0;
    const { fetcher } = stubFetcher(() => ({
      status: 200,
      body: { messages: [{
        id: "m1", subject: "Your Agnes Platform Verification Code",
        html: ["<div>Order 998877</div><p class=\"verification-code\">", "246813", "</p>"],
      }] },
    }));
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t, logger: NULL_LOGGER,
    });
    expect(await p.pollCode({ address: "u@a.test", handle: "eid-1" }, 5000)).toBe("246813");
  });

  // === M3：轮询期间 fetch reject 与非 2xx 的容错必须对称（同 YYDS 适配器） ===

  it("M3 轮询请求 reject（网络抖动/超时）后不中断，下一轮仍能取到验证码", async () => {
    let attempts = 0;
    let t = 0;
    const fetcher = {
      async fetch() {
        attempts++;
        // 第 1 次以 TimeoutError reject——AbortSignal.timeout 到点时的真实行为。
        if (attempts === 1) throw new DOMException("The operation was aborted", "TimeoutError");
        return new Response(JSON.stringify({
          messages: [{ id: "m1", subject: "验证码", content: "您的验证码 998877" }],
        }), { status: 200 });
      },
    };
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t, logger: NULL_LOGGER,
    });
    expect(await p.pollCode({ address: "u@a.test", handle: "eid-1" }, 10000)).toBe("998877");
    expect(attempts).toBe(2);
  });

  it("M3 全程 reject 时按超时返回 null，而不是把异常抛给调用方", async () => {
    let t = 0;
    const fetcher = { async fetch(): Promise<Response> { throw new Error("ECONNRESET"); } };
    const p = new MoeMailProvider({
      fetcher, baseUrl: "https://m.test", apiKey: "k",
      sleep: async () => { t += 3000; }, now: () => t, logger: NULL_LOGGER,
    });
    await expect(p.pollCode({ address: "u@a.test", handle: "eid-1" }, 9000)).resolves.toBeNull();
  });
});
