import { describe, it, expect } from "vitest";
import type { MailProvider } from "../../src/ports/mailbox.js";
import type { Mailbox } from "../../src/core/registrar/types.js";
import { YydsProvider } from "../../src/adapters/mailbox-yyds.js";
import { MoeMailProvider } from "../../src/adapters/mailbox-moemail.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { recordingLogger } from "../helpers/recording-logger.js";

/**
 * 两家各自的假上游：同样的语义，不同的线上格式。
 *
 * DELETE 请求特意 throw（模拟网络异常）而不是 resolve 一个状态码——如果只
 * resolve，被测代码即便整段丢掉 try/catch，"删邮箱不抛错" 这条断言也照样通过
 * （因为它压根不检查 delete 响应的状态码），测了个寂寞。要让 stub 真的出错，
 * 才能守住"失败不向上传播"这条约束。
 */
function yydsUpstream() {
  return async (url: string, init: RequestInit) => {
    if ((init.method ?? "GET") === "DELETE") throw new Error("network down");
    if (url.includes("/v1/domains")) {
      return new Response(JSON.stringify({ data: [{ domain: "a.test" }] }), { status: 200 });
    }
    if (url.includes("/v1/accounts") && init.method === "POST") {
      return new Response(JSON.stringify({ data: { address: "u@a.test", id: "acct-u" } }), { status: 200 });
    }
    if (url.includes("/v1/messages/")) {
      return new Response(JSON.stringify({ data: { verificationCode: "424242" } }), { status: 200 });
    }
    if (url.includes("/v1/messages")) {
      return new Response(JSON.stringify({ data: { messages: [{ id: "m1" }] } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
}

function moemailUpstream() {
  return async (url: string, init: RequestInit) => {
    if ((init.method ?? "GET") === "DELETE") throw new Error("network down");
    if (url.includes("/api/config")) {
      return new Response(JSON.stringify({ emailDomains: "a.test,b.test" }), { status: 200 });
    }
    if (url.includes("/api/emails/generate")) {
      return new Response(JSON.stringify({ id: "eid-1", email: "u@a.test" }), { status: 200 });
    }
    if (url.includes("/api/emails/") && (init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({
        messages: [{ id: "m1", subject: "验证码", content: "您的验证码 424242" }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
}

function runMailProviderContract(name: string, make: () => MailProvider) {
  describe(`MailProvider 契约: ${name}`, () => {
    it("列出的域名非空且都是字符串", async () => {
      const ds = await make().listDomains();
      expect(ds.length).toBeGreaterThan(0);
      expect(ds.every((d) => typeof d === "string" && d.length > 0)).toBe(true);
    });

    it("建出的邮箱同时有 address 与 handle", async () => {
      const m = await make().createMailbox("a.test");
      expect(m.address).toMatch(/@/);
      expect(m.handle.length).toBeGreaterThan(0);
    });

    it("能取到验证码", async () => {
      const p = make();
      const m = await p.createMailbox("a.test");
      expect(await p.pollCode(m, 5000)).toBe("424242");
    });

    it("删邮箱不抛错", async () => {
      const p = make();
      const m = await p.createMailbox("a.test");
      await expect(p.deleteMailbox(m)).resolves.toBeUndefined();
    });
  });
}

/**
 * 递进假时钟：每次 `make()` 重新造一个，`t` 只属于这一个 provider 实例。
 *
 * 没有用 `noSleep + now: () => 0`——"能取到验证码"这条走的是 pollCode 的循环，
 * 时钟不走的话，被测代码一旦退出条件被改坏（拿不到码），会陷入微任务饥饿式
 * 挂起：`sleep`/`fetch` 的 mock 都是立即 resolve 的 promise，循环体不断产生新
 * 微任务，Node 更愿意把这些微任务耗尽也不会把控制权交还给宏任务队列，连
 * vitest 自身基于 setTimeout 的用例超时都排不上号，表现为整个进程卡死而不是
 * 定位到具体用例（本任务里已用变异测试真实复现过这个挂起）。
 */
function makeClock() {
  let t = 0;
  return { sleep: async () => { t += 3000; }, now: () => t };
}

runMailProviderContract("YydsProvider", () => new YydsProvider({
  fetcher: { fetch: yydsUpstream() }, baseUrl: "https://y.test", apiKey: "k",
  ...makeClock(), logger: NULL_LOGGER,
}));

runMailProviderContract("MoeMailProvider", () => new MoeMailProvider({
  fetcher: { fetch: moemailUpstream() }, baseUrl: "https://m.test", apiKey: "k",
  ...makeClock(), logger: NULL_LOGGER,
}));

/**
 * 补充：轮询期间上游偶发返回非 JSON 的情形对两家都该成立，属于共享契约，放
 * 在这里跑一次即可，不必在各自的适配器测试里各写一份。
 *
 * 用递进假时钟（`sleep` 推进 `now`）而不是 `noSleep + now: () => 0`——被测代码
 * 一旦退出条件被改坏，前者只是断言失败，后者会陷入微任务饥饿式挂起，CI 里
 * 表现为整体卡死而不是定位到具体用例。
 */
function runPollResilienceContract(
  name: string,
  make: (fetch: (url: string, init: RequestInit) => Promise<Response>, clock: { sleep: (ms: number) => Promise<void>; now: () => number }) => MailProvider,
  flakyUpstream: () => (url: string, init: RequestInit) => Promise<Response>,
  mailbox: Mailbox,
) {
  it(`${name}: 轮询中上游偶发返回非 JSON 不中断，下一轮仍能取到验证码`, async () => {
    let t = 0;
    const clock = { sleep: async () => { t += 3000; }, now: () => t };
    const p = make(flakyUpstream(), clock);
    expect(await p.pollCode(mailbox, 10000)).toBe("777888");
  });
}

function yydsFlakyListUpstream() {
  let listAttempts = 0;
  return async (url: string) => {
    if (url.includes("/v1/messages/")) {
      return new Response(JSON.stringify({ data: { verificationCode: "777888" } }), { status: 200 });
    }
    if (url.includes("/v1/messages")) {
      listAttempts++;
      if (listAttempts === 1) return new Response("not json", { status: 200 });
      return new Response(JSON.stringify({ data: { messages: [{ id: "m1" }] } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
}

function moemailFlakyListUpstream() {
  let attempts = 0;
  return async (url: string) => {
    if (url.includes("/api/emails/")) {
      attempts++;
      if (attempts === 1) return new Response("not json", { status: 200 });
      return new Response(JSON.stringify({
        messages: [{ id: "m1", subject: "验证码", content: "您的验证码 777888" }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
}

runPollResilienceContract(
  "YydsProvider",
  (fetch, clock) => new YydsProvider({ fetcher: { fetch }, baseUrl: "https://y.test", apiKey: "k", ...clock, logger: NULL_LOGGER }),
  yydsFlakyListUpstream,
  { address: "u1@a.test", handle: "acct-u1" },
);

runPollResilienceContract(
  "MoeMailProvider",
  (fetch, clock) => new MoeMailProvider({ fetcher: { fetch }, baseUrl: "https://m.test", apiKey: "k", ...clock, logger: NULL_LOGGER }),
  moemailFlakyListUpstream,
  { address: "u1@a.test", handle: "eid-1" },
);

/**
 * 补充：删邮箱收到**非 2xx**（404/403/500）时必须留痕，这是两家共有的契约。
 *
 * 端口文档写的是「失败只应记日志」，而 `fetch` 对 404/403/500 是正常 resolve 的——
 * 只 try/catch 抛出的异常，等于把最常见的那条失败路径变成 100% 静默。而用完即删
 * 是功能能否持续工作的前提（设计 §4.1：YYDS 免费档同时 15 个邮箱、MoeMail 上游
 * 默认 30 个），删不掉又没有信号，就会以"域名全被屏蔽"的假象表现出来。
 */
function runDeleteFailureContract(
  name: string,
  make: (fetch: (url: string, init: RequestInit) => Promise<Response>, logger: ReturnType<typeof recordingLogger>) => MailProvider,
  mailbox: Mailbox,
) {
  it(`${name}: 删邮箱收到非 2xx 时不抛错，但记 registrar.delete_mailbox_failed 事件并带上状态码`, async () => {
    // console.* 已经被换成注入的 Logger：spy console 只会看到空 mock，必须改成
    // recordingLogger 断言事件名 + fields。
    const logger = recordingLogger();
    const p = make(async () => new Response("{}", { status: 404 }), logger);
    await expect(p.deleteMailbox(mailbox)).resolves.toBeUndefined();
    const e = logger.entries.find((x) => x.event === "registrar.delete_mailbox_failed");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    expect(e?.fields?.address).toBe(mailbox.address);
    expect(e?.fields?.status).toBe(404);
  });
}

runDeleteFailureContract(
  "YydsProvider",
  (fetch, logger) => new YydsProvider({ fetcher: { fetch }, baseUrl: "https://y.test", apiKey: "k", ...makeClock(), logger }),
  { address: "u1@a.test", handle: "acct-u1" },
);

runDeleteFailureContract(
  "MoeMailProvider",
  (fetch, logger) => new MoeMailProvider({ fetcher: { fetch }, baseUrl: "https://m.test", apiKey: "k", ...makeClock(), logger }),
  { address: "u1@a.test", handle: "eid-1" },
);
