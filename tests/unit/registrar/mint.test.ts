import { describe, it, expect } from "vitest";
import { mintOne } from "../../../src/core/registrar/mint.js";
import { FakeMailProvider } from "../../helpers/fake-mailbox.js";

function agnesStub(plan: {
  sendCode?: (email: string) => number;
  register?: boolean;
  login?: string | null;
  key?: string | null;
}) {
  const seen: string[] = [];
  return {
    seen,
    agnes: {
      platformUrl: "https://platform.test",
      fetcher: {
        async fetch(url: string) {
          if (url.includes("/api/verification")) {
            const email = decodeURIComponent(new URL(url).searchParams.get("email") ?? "");
            seen.push(email);
            return new Response("{}", { status: plan.sendCode ? plan.sendCode(email) : 200 });
          }
          if (url.includes("/api/user/register")) {
            return new Response("{}", { status: plan.register === false ? 422 : 200 });
          }
          if (url.includes("/api/user/login")) {
            return new Response(JSON.stringify({ data: { access_token: plan.login ?? null } }), { status: 200 });
          }
          if (url.includes("/api/token")) {
            return new Response(JSON.stringify({ data: { key: plan.key ?? null } }), { status: 200 });
          }
          return new Response("{}", { status: 200 });
        },
      },
    },
  };
}

const BASE = { tokenName: "auto", codeTimeoutMs: 5000, maxDomainAttempts: 8, rand: () => 0.5 };

describe("mintOne", () => {
  it("顺利时返回 key", async () => {
    const provider = new FakeMailProvider();
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: true, key: "sk-ok" });
  });

  it("域名被上游拒(400)时换下一个域名重试", async () => {
    const provider = new FakeMailProvider({ domains: ["blocked.test", "good.test"] });
    // 第一个域名一律 400，第二个放行
    const { seen, agnes } = agnesStub({
      sendCode: (email) => (email.endsWith("@blocked.test") ? 400 : 200),
      login: "tok",
      key: "sk-ok",
    });
    const out = await mintOne({ provider, agnes, ...BASE });
    expect(out).toEqual({ ok: true, key: "sk-ok" });
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("所有域名都被拒时返回 domain_blocked_all", async () => {
    const provider = new FakeMailProvider({ domains: ["x.test", "y.test"] });
    const { agnes } = agnesStub({ sendCode: () => 400 });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "domain_blocked_all" });
  });

  it("发验证码遇到非 400 的非 2xx（上游整体故障）时返回 upstream_error 而不是 domain_blocked_all", async () => {
    const provider = new FakeMailProvider({ domains: ["x.test", "y.test"] });
    const { agnes } = agnesStub({ sendCode: () => 500 });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("400 与其他非 2xx 混杂时也归为 upstream_error（不能谎称域名全被屏蔽）", async () => {
    const provider = new FakeMailProvider({ domains: ["blocked.test", "down.test"] });
    const { agnes } = agnesStub({
      sendCode: (email) => (email.endsWith("@blocked.test") ? 400 : 503),
    });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("所有候选域名上都建不出邮箱时返回 provider_error（通道级失败，可降级到备通道）", async () => {
    // 设计 §4.5 把「连续建邮箱失败」与「列域名失败、凭据无效」并列为通道级失败。
    // 此前这条路径轮完后返回 domain_blocked_all，而 tender 把 domain_blocked_all
    // 归入「换通道也没用」，备通道配了也永远不会启用。
    const provider = new FakeMailProvider({
      domains: ["x.test", "y.test", "z.test"],
      failCreateOn: ["x.test", "y.test", "z.test"],
    });
    const { seen, agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "provider_error" });
    // 一个邮箱都没建出来 → 一次验证码都没发出去 → 根本没资格声称"域名全被屏蔽"。
    expect(provider.created).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("只有部分域名建不出邮箱、其余域名被上游拒(400)时仍是 domain_blocked_all（不误报通道级失败）", async () => {
    // 与上一条成对：只要有过一次成功建邮箱，就说明通道本身是活的，失败原因该
    // 归到域名而不是通道。两条断言的 reason 不同，避免"谁赢都通过"。
    const provider = new FakeMailProvider({
      domains: ["bad.test", "blocked.test"],
      failCreateOn: ["bad.test"],
    });
    const { agnes } = agnesStub({ sendCode: () => 400 });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "domain_blocked_all" });
    expect(provider.created).toHaveLength(1);
  });

  it("最多只试 maxDomainAttempts 个域名", async () => {
    const provider = new FakeMailProvider({ domains: ["a.test", "b.test", "c.test", "d.test", "e.test"] });
    const { seen, agnes } = agnesStub({ sendCode: () => 400 });
    await mintOne({ provider, agnes, ...BASE, maxDomainAttempts: 2 });
    expect(seen).toHaveLength(2);
  });

  it("验证码超时返回 code_timeout", async () => {
    const provider = new FakeMailProvider({ code: null });
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "code_timeout" });
  });

  it("注册失败返回 register_failed", async () => {
    const provider = new FakeMailProvider();
    const { agnes } = agnesStub({ register: false });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "register_failed" });
  });

  it("登录拿不到令牌返回 login_failed", async () => {
    const provider = new FakeMailProvider();
    const { agnes } = agnesStub({ login: null });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "login_failed" });
  });

  it("建 key 失败返回 key_failed", async () => {
    const provider = new FakeMailProvider();
    const { agnes } = agnesStub({ login: "tok", key: null });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "key_failed" });
  });

  it("无论成功失败都删掉临时邮箱", async () => {
    for (const plan of [{ login: "tok", key: "sk-ok" }, { register: false }]) {
      const provider = new FakeMailProvider();
      const { agnes } = agnesStub(plan);
      await mintOne({ provider, agnes, ...BASE });
      expect(provider.deleted).toEqual(provider.created);
      expect(provider.deleted.length).toBeGreaterThan(0);
    }
  });

  it("轮换多个域名全部失败时，每个域名建出的邮箱都被删掉（不是只删最后一个）", async () => {
    // 上一条固定单域名，deleted 恒为 1，删除是不是发生在**每一轮**域名轮换里
    // 看不出来。这条让 3 个域名依次被 400 拒掉，断言 3 个邮箱一个不落地删干净
    // ——YYDS 免费档同时只能有 15 个活跃邮箱，漏删会直接把配额吃光。
    const provider = new FakeMailProvider({ domains: ["a.test", "b.test", "c.test"] });
    const { agnes } = agnesStub({ sendCode: () => 400 });
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "domain_blocked_all" });
    expect(provider.created).toHaveLength(3);
    expect(provider.deleted).toEqual(provider.created);
  });

  it("列域名失败返回 provider_error", async () => {
    const provider = {
      name: "yyds" as const,
      async listDomains(): Promise<string[]> {
        throw new Error("down");
      },
      async createMailbox() {
        throw new Error("unreachable");
      },
      async pollCode() {
        return null;
      },
      async deleteMailbox() {},
    };
    const { agnes } = agnesStub({});
    expect(await mintOne({ provider, agnes, ...BASE })).toEqual({ ok: false, reason: "provider_error" });
  });

  it("删临时邮箱失败不会掩盖已经拿到的结果", async () => {
    const provider = new FakeMailProvider();
    provider.deleteMailbox = async () => {
      throw new Error("delete boom");
    };
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    // deleteMailbox 真的会抛，若 finally 里没包 try/catch，这次调用会以异常收场
    // 而不是拿到 mintOne 的返回值——这条断言必须能捕捉到那种回归。
    await expect(mintOne({ provider, agnes, ...BASE })).resolves.toEqual({ ok: true, key: "sk-ok" });
  });

  // === I1：网络层错误不再穿透整轮 ===

  it("注册链路中途 fetch 抛错（网络层）时返回 network_error，而不是让异常穿透出去", async () => {
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const agnes = {
      platformUrl: "https://platform.test",
      fetcher: {
        async fetch(url: string) {
          // 发验证码正常，登录这一步撞上 TCP reset —— NativeFetcher 是裸 fetch，
          // 这类错误是 reject 而不是非 2xx。
          if (url.includes("/api/user/login")) throw new Error("ECONNRESET");
          return new Response("{}", { status: 200 });
        },
      },
    };
    await expect(mintOne({ provider, agnes, ...BASE })).resolves.toEqual({
      ok: false, reason: "network_error",
    });
    // 网络错误也要走 finally 的清理，否则邮箱就漏了。
    expect(provider.deleted).toEqual(provider.created);
    expect(provider.deleted).toHaveLength(1);
  });

  it("发验证码这一步 fetch 抛错时同样收敛成 network_error", async () => {
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(): Promise<Response> { throw new Error("EAI_AGAIN"); } },
    };
    await expect(mintOne({ provider, agnes, ...BASE })).resolves.toEqual({
      ok: false, reason: "network_error",
    });
    expect(provider.deleted).toHaveLength(1);
  });

  it("轮询验证码抛错（邮箱侧网络错误）时也是 network_error，不穿透", async () => {
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    provider.pollCode = async () => { throw new Error("socket hang up"); };
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    await expect(mintOne({ provider, agnes, ...BASE })).resolves.toEqual({
      ok: false, reason: "network_error",
    });
    expect(provider.deleted).toHaveLength(1);
  });

  it("不传 rand 时按 Math.random 兜底也能正常出 key", async () => {
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    const { rand: _rand, ...rest } = BASE;
    expect(await mintOne({ provider, agnes, ...rest })).toEqual({ ok: true, key: "sk-ok" });
  });
});
