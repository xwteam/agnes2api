import { describe, it, expect } from "vitest";
import { tendOnce, type TendFailureReason } from "../../../src/core/registrar/tender.js";
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
  it("failures[].reason 是联合类型而不是裸 string（P3 消费时要能拿到穷尽检查）", () => {
    // 这条断言真正生效的地方是 `tsc --noEmit`：把 reason 退回 string 之后，下面
    // 的 @ts-expect-error 会变成"未使用的指令"从而让类型检查失败。运行时断言只是
    // 顺带确认取值。
    const ok: TendFailureReason = "code_timeout";
    // @ts-expect-error 不在联合里的 reason 必须在类型层就被挡住
    const bad: TendFailureReason = "not_a_real_reason";
    expect(ok).toBe("code_timeout");
    expect(bad).toBe("not_a_real_reason");
  });

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
    // 注意：这条覆盖的是**列域名失败**那一种。下面 broken.createMailbox 那行永远
    // 走不到（listDomains 先抛错，mintOne 直接返回），另一种通道级失败——「所有
    // 域名上都建不出邮箱」——由紧随其后的那条用 failCreateOn 的用例覆盖。
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

  it("主通道在所有域名上都建不出邮箱时也降级到备通道（通道级失败的第二种形态）", async () => {
    // 这是 fake-mailbox 的 failCreateOn 选项存在的理由，此前全仓零使用：域名列得
    // 出来、但每个域名的 createMailbox 都失败（凭据失效、活跃邮箱配额耗尽、邮箱
    // 服务挂了）。设计 §4.5 与五语言用户文档都承诺这种情况会降级，此前它被归成
    // domain_blocked_all，备通道永不启用。
    const brokenCreate = new FakeMailProvider({
      domains: ["a.test", "b.test", "c.test"],
      failCreateOn: ["a.test", "b.test", "c.test"],
    });
    const backup = new FakeMailProvider();
    const { repo, deps } = await makeDeps({ fallback: "moemail", targetKeys: 1 });
    deps.providers = { yyds: brokenCreate, moemail: backup };
    const out = await tendOnce(deps);
    expect(out.minted).toBe(1);
    expect(brokenCreate.created).toEqual([]);
    // 备通道确实被调用了（不是"主通道恰好也成功了"这种殊途同归）。
    expect(backup.created).toHaveLength(1);
    expect(out.failures).toEqual([{ reason: "provider_error", channel: "yyds" }]);
    expect(await repo.all()).toHaveLength(1);
  });

  // === M1：主通道收不到验证码也是通道级失败，必须降级 ===

  it("主通道收不到验证码（code_timeout）时降级到备通道，且 key 真的进了池子", async () => {
    // 死亡链的新变体：邮箱通道的 API 全 2xx（建邮箱/删邮箱/列域名一切正常），
    // 只是验证码永远收不到——MX 记录失效、Cloudflare Email Routing 的 catch-all
    // 规则被删都是这个形态。此前 code_timeout 被归进「换通道也没用」，备通道
    // 配好了也一次都不会被调用，key 池耗尽后网关整体不可用。
    //
    // 断言的是**真实效果**而不是「mock 被调过」：池子里确实多了一把 key，且那把
    // key 是备通道那条链路铸出来的。
    const deadPrimary = new FakeMailProvider({ domains: ["a.test", "b.test"], code: null });
    const backup = new FakeMailProvider();
    const { repo, deps } = await makeDeps({ fallback: "moemail", targetKeys: 1 });
    deps.providers = { yyds: deadPrimary, moemail: backup };
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: {
        async fetch(url: string) {
          if (url.includes("/api/user/login")) {
            return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
          }
          if (url.includes("/api/token")) {
            return new Response(JSON.stringify({ data: { key: "sk-from-fallback" } }), { status: 200 });
          }
          return new Response("{}", { status: 200 });
        },
      },
    };
    const out = await tendOnce(deps);
    expect(out.minted).toBe(1);
    // 备通道确实被走了一遍（建了邮箱），不是「主通道后来自己好了」。
    expect(backup.created).toHaveLength(1);
    expect(out.failures).toEqual([{ reason: "code_timeout", channel: "yyds" }]);
    const all = await repo.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.key).toBe("sk-from-fallback");
  });

  it("主通道收不到验证码时不会在通道内换域名死等（单次尝试只烧一份 codeTimeoutMs 的预算）", async () => {
    // 与上一条成对：降级是对的，但不能顺手把「逐个域名重试」也带进来——那会让
    // 单次铸 key 最坏耗时变成 MAX_DOMAIN_ATTEMPTS × CODE_TIMEOUT_MS，远超
    // Worker Cron 的 900 秒墙钟（详见 tender.ts 的 case "code_timeout" 注释）。
    // 主通道给 5 个域名、验证码永远收不到：pollCode 只该被调 1 次。
    let polls = 0;
    const deadPrimary = new FakeMailProvider({
      domains: ["a.test", "b.test", "c.test", "d.test", "e.test"], code: null,
    });
    deadPrimary.pollCode = async () => { polls++; return null; };
    const backup = new FakeMailProvider();
    const { deps } = await makeDeps({ fallback: "moemail", targetKeys: 1 });
    deps.providers = { yyds: deadPrimary, moemail: backup };
    const out = await tendOnce(deps);
    expect(polls).toBe(1);
    expect(out.minted).toBe(1);
  });

  it("无备通道时主通道收不到验证码：本次失败，但剩余名额继续尝试（不整轮中止）", async () => {
    // 单通道部署没有出口，但也不该把整轮砍掉——下一次尝试会重新洗牌域名，
    // 「个别域名 MX 坏了」这种情况靠重抽就能恢复。
    const deadPrimary = new FakeMailProvider({ domains: ["a.test", "b.test"], code: null });
    const { deps } = await makeDeps({ targetKeys: 3 }, deadPrimary);
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(3);
    expect(out.minted).toBe(0);
    expect(out.failures.every((f) => f.reason === "code_timeout")).toBe(true);
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

  it("撞上限流（rate_limited）时不中止整轮、也不换通道：与 upstream_error 的退避刻意不同", async () => {
    // 与上面 upstream_error 那条对照：同样是"每次都失败"，但 403 是限流——等一下
    // 再试是有用的，整轮中止只会把恢复拖到下一个调度周期。两条断言的 attempted
    // 不同（3 vs 1），避免"谁赢都通过"。
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const backup = new FakeMailProvider();
    const { deps } = await makeDeps({ targetKeys: 3, fallback: "moemail" }, provider);
    deps.providers = { yyds: provider, moemail: backup };
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(url: string) {
        return new Response("{}", { status: url.includes("/api/verification") ? 403 : 200 });
      } },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(3);
    expect(out.minted).toBe(0);
    expect(out.failures.every((f) => f.reason === "rate_limited")).toBe(true);
    expect(backup.created).toEqual([]);
  });

  it("网络层错误不让整轮 reject：TendResult 照常返回，剩余名额继续尝试，且不换通道", async () => {
    // I1：五处 fetcher.fetch 任何一处 reject 此前都会穿透 mintOne → tendOnce 整轮
    // reject，剩余名额作废、TendResult（P3 面板要展示的数据）也拿不到。
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const backup = new FakeMailProvider();
    const { repo, deps } = await makeDeps({ targetKeys: 3, fallback: "moemail" }, provider);
    deps.providers = { yyds: provider, moemail: backup };
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(): Promise<Response> { throw new Error("ECONNRESET"); } },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(3);
    expect(out.minted).toBe(0);
    expect(out.failures).toEqual([
      { reason: "network_error", channel: "yyds" },
      { reason: "network_error", channel: "yyds" },
      { reason: "network_error", channel: "yyds" },
    ]);
    // 打的是同一个 Agnes 后端，换邮箱通道没有意义：备通道一次都不该被调用。
    expect(backup.created).toEqual([]);
    expect(await repo.all()).toHaveLength(0);
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

  it("通道缺 provider 时记录一条失败，而不是静默空转", async () => {
    // 主通道 yyds 在 chain 里，但 providers 里根本没构造它——这是接线错误
    // （Task 7 最容易触发的那种），不是"这条通道没配"的正常状态。
    const { repo, deps } = await makeDeps({ targetKeys: 1, mintBatch: 1 });
    deps.providers = {};
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(1);
    expect(out.minted).toBe(0);
    expect(out.failures).toEqual([{ reason: "provider_missing", channel: "yyds" }]);
    expect(await repo.all()).toHaveLength(0);
  });

  it("本轮先成功铸出一把 key，紧接着下一次尝试触发 upstream_error 整轮中止时，已铸成功的 key 仍完整写入池子", async () => {
    // 与现有的两条中止类测试对照：那两条都是"第一次就失败"，从未出现
    // minted>0 之后再中止的组合。这里第一次尝试完整走完注册链路拿到 key，
    // 第二次尝试的验证码请求才切到 500 触发 upstream_error 整轮中止，
    // 断言第一次已经 add 进池子的 key 不会因为后面中止而回滚。
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const { repo, deps } = await makeDeps({ targetKeys: 3, mintBatch: 3 }, provider);
    let verificationCalls = 0;
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: {
        async fetch(url: string) {
          if (url.includes("/api/verification")) {
            verificationCalls++;
            return new Response("{}", { status: verificationCalls === 1 ? 200 : 500 });
          }
          if (url.includes("/api/user/login")) {
            return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
          }
          if (url.includes("/api/token")) {
            return new Response(JSON.stringify({ data: { key: "sk-first" } }), { status: 200 });
          }
          return new Response("{}", { status: 200 });
        },
      },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(2);
    expect(out.minted).toBe(1);
    expect(out.failures).toEqual([{ reason: "upstream_error", channel: "yyds" }]);
    const all = await repo.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.key).toBe("sk-first");
  });
});
