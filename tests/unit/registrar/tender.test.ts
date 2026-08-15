import { describe, it, expect } from "vitest";
import { tendOnce } from "../../../src/core/registrar/tender.js";
import { KeyPoolRepo } from "../../../src/core/dispatcher.js";
import { MemoryStorage } from "../../helpers/fake-storage.js";
import { FakeMailProvider } from "../../helpers/fake-mailbox.js";
import type { MailProvider } from "../../../src/ports/mailbox.js";
import type { Channel, RegistrarConfig } from "../../../src/core/registrar/config.js";

// 显式标注 RegistrarConfig：brief 给的字面量没有类型注解，`fallback: null` 会被
// 收窄成字面量类型 null 而非 Channel | null，下面按测试用例覆盖成 "moemail" 时
// 类型检查会报错（vitest 的 esbuild 转换不做类型检查，只有 tsc --noEmit 会揪出）。
const CFG: RegistrarConfig = {
  enabled: true, primary: "yyds", fallback: null,
  targetKeys: 3, mintBatch: 5, tendIntervalMs: 1000, codeTimeoutMs: 5000,
  mintDelayMinMs: 1, mintDelayMaxMs: 1, maxDomainAttempts: 8,
  tokenName: "auto", agnesPlatformUrl: "https://platform.test",
  yyds: { baseUrl: "https://y.test", apiKey: "k" }, moemail: null,
};

function agnesOk() {
  return {
    platformUrl: "https://platform.test",
    fetcher: {
      async fetch(url: string) {
        if (url.includes("/api/user/login")) {
          return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
        }
        if (url.includes("/api/token")) {
          return new Response(JSON.stringify({ data: { key: `sk-${Math.random().toString(36).slice(2, 10)}` } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    },
  };
}

async function makeDeps(over: Partial<RegistrarConfig> = {}, provider: MailProvider = new FakeMailProvider()) {
  const repo = new KeyPoolRepo(new MemoryStorage());
  const providers: Partial<Record<Channel, MailProvider>> = { yyds: provider };
  return {
    repo,
    deps: {
      repo, config: { ...CFG, ...over },
      providers,
      agnes: agnesOk(), now: () => 1000, sleep: async () => {}, rand: () => 0.5,
    },
  };
}

describe("tendOnce", () => {
  it("未启用时立即返回且零副作用", async () => {
    const { repo, deps } = await makeDeps({ enabled: false });
    const out = await tendOnce(deps);
    expect(out.skipped).toBe(true);
    expect(out.minted).toBe(0);
    expect(await repo.all()).toHaveLength(0);
  });

  it("空池时补到目标数", async () => {
    const { repo, deps } = await makeDeps();
    const out = await tendOnce(deps);
    expect(out.minted).toBe(3);
    expect(await repo.all()).toHaveLength(3);
  });

  it("已达目标数时不铸", async () => {
    const { repo, deps } = await makeDeps();
    for (const k of ["a", "b", "c"]) await repo.add(k);
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(0);
    expect(out.minted).toBe(0);
  });

  it("单轮不超过 mintBatch", async () => {
    const { deps } = await makeDeps({ targetKeys: 10, mintBatch: 2 });
    expect((await tendOnce(deps)).attempted).toBe(2);
  });

  it("已剔除与冷却中的 key 不计入可用数", async () => {
    const { repo, deps } = await makeDeps();
    const a = await repo.add("a"); await repo.save({ ...a, evicted: true });
    const b = await repo.add("b"); await repo.save({ ...b, cooldownUntil: 999_999 });
    const out = await tendOnce(deps);
    expect(out.available).toBe(0);
    expect(out.minted).toBe(3);
  });

  it("单次失败不中断整轮（域名全被拒 domain_blocked_all）", async () => {
    // 域名全被拒 → 每次 mintOne 都失败，但仍应尝试满 batch 次
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const { deps } = await makeDeps({ targetKeys: 3 }, provider);
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(url: string) {
        return new Response("{}", { status: url.includes("/api/verification") ? 400 : 200 });
      } },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(3);
    expect(out.minted).toBe(0);
    expect(out.failures).toHaveLength(3);
    expect(out.failures.every((f) => f.reason === "domain_blocked_all")).toBe(true);
  });

  it("上游整体故障（upstream_error）时本轮立即回退，不把 mintBatch 耗完", async () => {
    // 与上一条对照：同样是「每次都失败」，但这次的非 2xx 不是 400（域名屏蔽）而是
    // 500（上游整体故障）。domain_blocked_all 换一轮还有机会，upstream_error
    // 换通道/换轮都打的是同一个瘫痪的后端，继续尝试没有意义，必须立刻停止本轮，
    // 而不是像上一条那样把 3 次名额都用掉。两条测试给的状态码不同、断言的
    // attempted 也不同，避免「谁赢都通过」的假阳性。
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const { deps } = await makeDeps({ targetKeys: 3 }, provider);
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(url: string) {
        return new Response("{}", { status: url.includes("/api/verification") ? 500 : 200 });
      } },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(1);
    expect(out.minted).toBe(0);
    expect(out.failures).toEqual([{ reason: "upstream_error", channel: "yyds" }]);
  });

  it("主通道通道级失败时降级到备通道", async () => {
    const broken: MailProvider = {
      name: "yyds" as const,
      async listDomains(): Promise<string[]> { throw new Error("down"); },
      async createMailbox() { throw new Error("x"); },
      async pollCode() { return null; },
      async deleteMailbox() {},
    };
    const backup = new FakeMailProvider();
    const { repo, deps } = await makeDeps({ fallback: "moemail", targetKeys: 1 });
    deps.providers = { yyds: broken, moemail: backup };
    const out = await tendOnce(deps);
    expect(out.minted).toBe(1);
    expect(backup.created.length).toBe(1);
    expect(await repo.all()).toHaveLength(1);
  });

  it("无备通道时主通道失败即本次失败", async () => {
    const broken: MailProvider = {
      name: "yyds" as const,
      async listDomains(): Promise<string[]> { throw new Error("down"); },
      async createMailbox() { throw new Error("x"); },
      async pollCode() { return null; },
      async deleteMailbox() {},
    };
    const { deps } = await makeDeps({ targetKeys: 1 });
    deps.providers = { yyds: broken };
    const out = await tendOnce(deps);
    expect(out.minted).toBe(0);
    expect(out.failures[0]!.reason).toBe("provider_error");
  });

  it("顺序铸 key，不并发：每一次的建邮箱/删邮箱必须成对完成才能进入下一次", async () => {
    // 守护「顺序执行不并发」这条业务硬约束：如果实现改成 Promise.all，三次
    // mintOne 的 createMailbox 会在任何一次的 deleteMailbox 之前就抢跑，
    // order 就不会是严格的 create/delete 交替，这条断言会先变红。
    const order: string[] = [];
    let n = 0;
    const provider: MailProvider = {
      name: "yyds" as const,
      async listDomains() { return ["a.test"]; },
      async createMailbox(domain: string) {
        const address = `u${n++}@${domain}`;
        order.push(`create:${address}`);
        return { address, handle: address };
      },
      async pollCode() { return "123456"; },
      async deleteMailbox(m) { order.push(`delete:${m.address}`); },
    };
    const { deps } = await makeDeps({ targetKeys: 3 }, provider);
    const out = await tendOnce(deps);
    expect(out.minted).toBe(3);
    expect(order).toEqual([
      "create:u0@a.test", "delete:u0@a.test",
      "create:u1@a.test", "delete:u1@a.test",
      "create:u2@a.test", "delete:u2@a.test",
    ]);
  });
});
