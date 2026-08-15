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

  it("不传 rand 时按 Math.random 兜底也能正常出 key", async () => {
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    const { rand: _rand, ...rest } = BASE;
    expect(await mintOne({ provider, agnes, ...rest })).toEqual({ ok: true, key: "sk-ok" });
  });
});
