import { describe, it, expect } from "vitest";
import { mintOne } from "../../../src/core/registrar/mint.js";
import { FakeMailProvider } from "../../helpers/fake-mailbox.js";
import { recordingLogger } from "../../helpers/recording-logger.js";
import { NULL_LOGGER } from "../../../src/ports/logger.js";
import { emptyDomainLedger, newJournal } from "../../../src/core/registrar/domain-ledger.js";

/**
 * ⚠️ **`sendCode` 现在返回 `{status, body}`，`agnesStub` 的 plan 跟着变。**
 * `sendCode` 那一格从「回一个状态码」变成「回一个状态码 + 一段正文」，因为**正文
 * 是区分「域名被屏蔽的 400」与「出口被限流的 400」的唯一线索**。
 * 只给状态码的旧写法保留成 `number` 简写（正文按 `{}` 补），免得每一格都要写两遍。
 */
function agnesStub(plan: {
  sendCode?: (email: string) => number | { status: number; body: string };
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
            const r = plan.sendCode ? plan.sendCode(email) : 200;
            const { status, body } = typeof r === "number" ? { status: r, body: "{}" } : r;
            return new Response(body, { status });
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

// logger: NULL_LOGGER 而不是共享一个 recordingLogger() 实例——后者会在全文件所有用例间
// 共享同一个 entries 数组，不检查日志内容的用例也会悄悄往里面塞条目，污染真正关心日志的
// 那几条用例（下面几条会各自局部覆盖成一个新的 recordingLogger()）。
const BASE = {
  tokenName: "auto", codeTimeoutMs: 5000,
  // 域名不再由 mintOne 自己去列、也不再由它洗牌：候选由 `tendOnce` 用
  // `selectDomains` 排好序传进来（见 `src/core/registrar/mint.ts` 的 `candidates`）。
  // 这里给一份和 `FakeMailProvider` 的默认域名逐字相同的候选。
  candidates: ["a.test", "b.test", "c.test"],
  ledger: emptyDomainLedger(),
  now: 1_000_000,
  mintDelayMinMs: 0, mintDelayMaxMs: 0,
  sleep: async () => {}, rand: () => 0.5, logger: NULL_LOGGER,
};

/** 每一格都要一本**自己的**观测本子——共用一本会让上一格的观测漏进下一格。 */
const base = () => ({ ...BASE, journal: newJournal() });

describe("mintOne", () => {
  it("顺利时返回 key", async () => {
    const provider = new FakeMailProvider();
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    expect(await mintOne({ provider, agnes, ...base() })).toEqual({ ok: true, key: "sk-ok" });
  });

  it("域名被上游拒(400)时换下一个域名重试", async () => {
    const provider = new FakeMailProvider({ domains: ["blocked.test", "good.test"] });
    // 第一个域名一律 400，第二个放行
    const { seen, agnes } = agnesStub({
      sendCode: (email) => (email.endsWith("@blocked.test") ? 400 : 200),
      login: "tok",
      key: "sk-ok",
    });
    const out = await mintOne({
      provider, agnes, ...base(), candidates: ["blocked.test", "good.test"],
    });
    expect(out).toEqual({ ok: true, key: "sk-ok" });
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("所有域名都被拒时返回 domain_blocked_all", async () => {
    const provider = new FakeMailProvider({ domains: ["x.test", "y.test"] });
    const { agnes } = agnesStub({ sendCode: () => 400 });
    expect(await mintOne({ provider, agnes, ...base(), candidates: ["x.test", "y.test"] }))
      .toEqual({ ok: false, reason: "domain_blocked_all" });
  });

  it("发验证码遇到非 400 的非 2xx（上游整体故障）时返回 upstream_error 而不是 domain_blocked_all", async () => {
    const provider = new FakeMailProvider({ domains: ["x.test", "y.test"] });
    const { agnes } = agnesStub({ sendCode: () => 500 });
    expect(await mintOne({ provider, agnes, ...base(), candidates: ["x.test", "y.test"] }))
      .toEqual({ ok: false, reason: "upstream_error" });
  });

  it("400 与其他非 2xx 混杂时也归为 upstream_error（不能谎称域名全被屏蔽）", async () => {
    const provider = new FakeMailProvider({ domains: ["blocked.test", "down.test"] });
    const { agnes } = agnesStub({
      sendCode: (email) => (email.endsWith("@blocked.test") ? 400 : 503),
    });
    expect(await mintOne({ provider, agnes, ...base(), candidates: ["blocked.test", "down.test"] }))
      .toEqual({ ok: false, reason: "upstream_error" });
  });

  it("所有候选域名上都建不出邮箱时返回 provider_error（通道级失败，不是域名问题）", async () => {
    // 「连续建邮箱失败」与「列域名失败、凭据无效」是同一类：**这条通道现在产不出邮箱**。
    // 此前这条路径轮完后返回 domain_blocked_all，于是日志把排障引向域名方向，
    // 而域名一个都没问题。
    const provider = new FakeMailProvider({
      domains: ["x.test", "y.test", "z.test"],
      failCreateOn: ["x.test", "y.test", "z.test"],
    });
    const { seen, agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    expect(await mintOne({ provider, agnes, ...base(), candidates: ["x.test", "y.test", "z.test"] }))
      .toEqual({ ok: false, reason: "provider_error" });
    // 一个邮箱都没建出来 → 一次验证码都没发出去 → 根本没资格声称"域名全被屏蔽"。
    expect(provider.created).toEqual([]);
    expect(seen).toEqual([]);
  });

  /**
   * ⚠️⚠️ **这一格钉的是那条 warn 说出去的**话**，不是它的 event 名。**
   *
   * `registrar.no_mailbox_on_any_domain` 的 msg 会渲染进面板事件板块、进容器 stdout、
   * 进 `GET /admin/api/events/download`。它上一版写着「（可降级到备通道）」——
   * 而两条通道改成二选一之后，`../../../src/core/registrar/tender.ts` 那个 switch
   * 上方逐字写明「一条通道失败绝不会去碰另一条」。运维照着旧文案会等一次
   * **永远不会发生**的自动切换，把一个要人管的故障当成自愈的故障。
   *
   * 与 `tests/unit/source-guards.test.ts` 的「src 下每一个 .ts 的字符串字面量里，
   * 排名词一个都没有」互相独立：那一格扫源码文本，这一格**真跑一次 mintOne**、
   * 从注入的 logger 里把它实际说出来的那句话读回来。源码那一格挡不住
   * 「换个说法但意思照旧」，行为这一格挡不住「msg 是拼出来的」——两条路各补一半。
   */
  it("建不出邮箱那条 warn 的措辞：不许再许诺「会自动换到另一条通道」", async () => {
    const logger = recordingLogger();
    const provider = new FakeMailProvider({
      domains: ["x.test"], failCreateOn: ["x.test"],
    });
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    await mintOne({ provider, agnes, ...base(), candidates: ["x.test"], logger });
    const e = logger.entries.find((x) => x.event === "registrar.no_mailbox_on_any_domain");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    for (const w of ["备通道", "降级", "主/备"]) {
      expect(e!.msg, `这条 warn 又开始许诺自动换通道了：${e!.msg}`).not.toContain(w);
    }
    // 反向控制：整句换成一句空话也能通过上面那条。它必须**说清接下来会怎样**，
    // 否则运维只知道「失败了」，仍然不知道该不该等。
    expect(e!.msg).toContain("不会自动改用另一条通道");
  });

  it("只有部分域名建不出邮箱、其余域名被上游拒(400)时仍是 domain_blocked_all（不误报通道级失败）", async () => {
    // 与上一条成对：只要有过一次成功建邮箱，就说明通道本身是活的，失败原因该
    // 归到域名而不是通道。两条断言的 reason 不同，避免"谁赢都通过"。
    const provider = new FakeMailProvider({
      domains: ["bad.test", "blocked.test"],
      failCreateOn: ["bad.test"],
    });
    const { agnes } = agnesStub({ sendCode: () => 400 });
    expect(await mintOne({ provider, agnes, ...base(), candidates: ["bad.test", "blocked.test"] }))
      .toEqual({ ok: false, reason: "domain_blocked_all" });
    expect(provider.created).toHaveLength(1);
  });

  // === 限流：当场停手，不再「等一下换个域名接着打」 ===
  //
  // ⚠️⚠️ **这一段整个重写过，而且是收紧不是放松。** 从前 403 会 `sleep(5000)` 再换
  // 下一个域名接着打，注释里写着「取自既有生产实现（跑了一个多月）」——而真机实测
  // 上游回的是 429 与 400，那条 403 分支**一次都没走到过**。更要命的是那个形态本身：
  // 两层限流的惩罚窗口都远比 5 秒长，**窗口里每打一次就把窗口续一次**。
  // 现在三种限流形态一律**当场结束这次尝试**并把层级交回给 `tendOnce` 去记退避。

  it("撞上边缘限流（429 + 非 JSON 正文）时当场停手：只打一次、不换域名、一条域名结论都不记", async () => {
    const provider = new FakeMailProvider({ domains: ["first.test", "second.test"] });
    const slept: number[] = [];
    const journal = newJournal();
    const { seen, agnes } = agnesStub({
      sendCode: () => ({ status: 429, body: "error code: 1015" }),
    });
    const out = await mintOne({
      provider, agnes, ...base(), journal,
      candidates: ["first.test", "second.test"],
      sleep: async (ms: number) => { slept.push(ms); },
    });
    expect(out).toEqual({ ok: false, reason: "rate_limited", limitKind: "edge", marker: "1015" });
    // ① 只打了一次 —— 从前是把候选全打一遍。
    expect(seen).toHaveLength(1);
    // ② 一秒都不睡：睡完接着打正是把惩罚窗口续上的那个形态。
    expect(slept).toEqual([]);
    // ③ **一条域名结论都不记**：限流不是「这个域名不行」。
    expect(journal.observations).toEqual([]);
    // ④ 邮箱照样删干净。
    expect(provider.deleted).toEqual(provider.created);
  });

  it("撞上应用层限流（400 + 限流文案）时同样当场停手，且 limitKind 是 app", async () => {
    const provider = new FakeMailProvider({ domains: ["x.test", "y.test"] });
    const journal = newJournal();
    const { seen, agnes } = agnesStub({
      sendCode: () => ({
        status: 400,
        body: JSON.stringify({ code: 400, message: "Too many registration attempts from this IP" }),
      }),
    });
    const out = await mintOne({
      provider, agnes, ...base(), journal, candidates: ["x.test", "y.test"],
    });
    expect(out).toEqual({ ok: false, reason: "rate_limited", limitKind: "app", marker: null });
    expect(seen).toHaveLength(1);
    // 🔴 **这一条是「不把好域名判死」的第一守卫**：同一个 400，正文说的是限流。
    expect(journal.observations).toEqual([]);
  });

  it("403 也并进边缘限流那一档（它今天是死分支，但并进来比留一条「睡一会儿接着打」的路安全）", async () => {
    const provider = new FakeMailProvider({ domains: ["limited.test", "down.test"] });
    const { agnes } = agnesStub({ sendCode: () => 403 });
    expect(await mintOne({
      provider, agnes, ...base(), candidates: ["limited.test", "down.test"],
    })).toEqual({ ok: false, reason: "rate_limited", limitKind: "edge", marker: null });
  });

  it("已知能用的域名回 400 时按限流处理，不把它打成 blocked", async () => {
    // 两边代价严重不对称：判错限流只慢一轮，判错域名会把一个真好用的域名踢下去。
    const logger = recordingLogger();
    const journal = newJournal();
    const ledger = emptyDomainLedger();
    ledger.entries["good.test"] = { s: "ok", at: 1_000_000, n: 1 };
    const provider = new FakeMailProvider({ domains: ["good.test"] });
    // 正文里**不含**任何限流词 —— 换成分类器就是 `domain_blocked`。
    const { agnes } = agnesStub({ sendCode: () => ({ status: 400, body: '{"code":400,"message":"nope"}' }) });
    const out = await mintOne({
      provider, agnes, ...base(), journal, ledger, now: 1_000_000,
      candidates: ["good.test"], logger,
    });
    expect(out).toEqual({ ok: false, reason: "rate_limited", limitKind: "app", marker: null });
    expect(journal.observations).toEqual([]);
    expect(logger.has("registrar.known_good_domain_rejected")).toBe(true);
  });

  it("400 但正文是空的：分不出是哪一种，一条域名结论都不记，只换下一个域名", async () => {
    const journal = newJournal();
    const provider = new FakeMailProvider({ domains: ["a.test", "b.test"] });
    const { seen, agnes } = agnesStub({ sendCode: () => ({ status: 400, body: "   " }) });
    const out = await mintOne({
      provider, agnes, ...base(), journal, candidates: ["a.test", "b.test"],
    });
    expect(out).toEqual({ ok: false, reason: "domain_blocked_all" });
    expect(seen).toHaveLength(2);
    expect(journal.observations).toEqual([]);
  });

  it("成功那一次把 ok 记进观测本子（这是稳态下「一次成功铸号只打一次发码」的来源）", async () => {
    const journal = newJournal();
    const provider = new FakeMailProvider({ domains: ["good.test"] });
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    await mintOne({ provider, agnes, ...base(), journal, candidates: ["good.test"] });
    expect(journal.observations).toEqual([{ domain: "good.test", verdict: "ok" }]);
  });

  it("换域名之前真的等一段 mintDelayMin~Max（零间隔连打正是触发边缘限流的那个形态）", async () => {
    const slept: number[] = [];
    const provider = new FakeMailProvider({ domains: ["a.test", "b.test", "c.test"] });
    const { agnes } = agnesStub({ sendCode: () => 400 });
    await mintOne({
      provider, agnes, ...base(),
      candidates: ["a.test", "b.test", "c.test"],
      mintDelayMinMs: 1000, mintDelayMaxMs: 3000, rand: () => 0.5,
      sleep: async (ms: number) => { slept.push(ms); },
    });
    // 三个域名 ⇒ 两段间隔（第一个域名之前不等）。手写字面量：1000 + floor(0.5 × 2000)。
    expect(slept).toEqual([2000, 2000]);
  });

  it("只试调用方给的那几个候选域名（数量上限现在由 selectDomains 在轮级定死）", async () => {
    const provider = new FakeMailProvider({ domains: ["a.test", "b.test", "c.test", "d.test", "e.test"] });
    const { seen, agnes } = agnesStub({ sendCode: () => 400 });
    await mintOne({ provider, agnes, ...base(), candidates: ["a.test", "b.test"] });
    expect(seen).toHaveLength(2);
  });

  it("验证码超时返回 code_timeout", async () => {
    const provider = new FakeMailProvider({ code: null });
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    expect(await mintOne({ provider, agnes, ...base() })).toEqual({ ok: false, reason: "code_timeout" });
  });

  it("注册失败返回 register_failed", async () => {
    const provider = new FakeMailProvider();
    const { agnes } = agnesStub({ register: false });
    expect(await mintOne({ provider, agnes, ...base() })).toEqual({ ok: false, reason: "register_failed" });
  });

  it("登录拿不到令牌返回 login_failed", async () => {
    const provider = new FakeMailProvider();
    const { agnes } = agnesStub({ login: null });
    expect(await mintOne({ provider, agnes, ...base() })).toEqual({ ok: false, reason: "login_failed" });
  });

  it("建 key 失败返回 key_failed", async () => {
    const provider = new FakeMailProvider();
    const { agnes } = agnesStub({ login: "tok", key: null });
    expect(await mintOne({ provider, agnes, ...base() })).toEqual({ ok: false, reason: "key_failed" });
  });

  it("无论成功失败都删掉临时邮箱", async () => {
    for (const plan of [{ login: "tok", key: "sk-ok" }, { register: false }]) {
      const provider = new FakeMailProvider();
      const { agnes } = agnesStub(plan);
      await mintOne({ provider, agnes, ...base() });
      expect(provider.deleted).toEqual(provider.created);
      expect(provider.deleted.length).toBeGreaterThan(0);
    }
  });

  it("轮换多个域名全部失败时，每个域名建出的邮箱都被删掉（不是只删最后一个）", async () => {
    // 上一条固定单域名，deleted 恒为 1，删除是不是发生在**每一轮**域名轮换里
    // 看不出来。这条让 3 个域名依次被 400 拒掉，断言 3 个邮箱一个不落地删干净
    // ——两条通道各自都有活跃邮箱上限（数字与出处见 `src/adapters/mailbox-yyds.ts`
    // 与 `src/adapters/mailbox-moemail.ts` 的文件头），漏删会直接把配额吃光。
    const provider = new FakeMailProvider({ domains: ["a.test", "b.test", "c.test"] });
    const { agnes } = agnesStub({ sendCode: () => 400 });
    expect(await mintOne({ provider, agnes, ...base() })).toEqual({ ok: false, reason: "domain_blocked_all" });
    expect(provider.created).toHaveLength(3);
    expect(provider.deleted).toEqual(provider.created);
  });

  it("候选域名为空时返回 provider_error（列域名这件事已经提到轮级，mintOne 不再自己列）", async () => {
    // ⚠️ 这一格从前叫「列域名失败返回 provider_error」，钉的是 `mintOne` 内部
    // `provider.listDomains()` 抛错那一支。域名现在由 `tendOnce` 在**轮开头**列一次
    // 再排好序传进来（一轮 1 次而不是每个名额 1 次），那条支路整个搬走了，
    // 留在 mintOne 这边的只剩「一个候选都没有」这一档。
    const provider = new FakeMailProvider();
    const { seen, agnes } = agnesStub({});
    expect(await mintOne({ provider, agnes, ...base(), candidates: [] }))
      .toEqual({ ok: false, reason: "provider_error" });
    // 零副作用：一个邮箱都不建、一次上游请求都不发。
    expect(provider.created).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("删临时邮箱失败不会掩盖已经拿到的结果", async () => {
    const provider = new FakeMailProvider();
    provider.deleteMailbox = async () => {
      throw new Error("delete boom");
    };
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    // deleteMailbox 真的会抛，若 finally 里没包 try/catch，这次调用会以异常收场
    // 而不是拿到 mintOne 的返回值——这条断言必须能捕捉到那种回归。
    await expect(mintOne({ provider, agnes, ...base() })).resolves.toEqual({ ok: true, key: "sk-ok" });
  });

  // === 网络层错误不再穿透整轮 ===

  it("注册链路中途 fetch 抛错（网络层）时返回 network_error，而不是让异常穿透出去", async () => {
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const only = { candidates: ["only.test"] };
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
    await expect(mintOne({ provider, agnes, ...base(), ...only })).resolves.toEqual({
      ok: false, reason: "network_error",
    });
    // 网络错误也要走 finally 的清理，否则邮箱就漏了。
    expect(provider.deleted).toEqual(provider.created);
    expect(provider.deleted).toHaveLength(1);
  });

  it("发验证码这一步 fetch 抛错时同样收敛成 network_error", async () => {
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const only = { candidates: ["only.test"] };
    const agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(): Promise<Response> { throw new Error("EAI_AGAIN"); } },
    };
    await expect(mintOne({ provider, agnes, ...base(), ...only })).resolves.toEqual({
      ok: false, reason: "network_error",
    });
    expect(provider.deleted).toHaveLength(1);
  });

  it("轮询验证码抛错（邮箱侧网络错误）时也是 network_error，不穿透", async () => {
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const only = { candidates: ["only.test"] };
    provider.pollCode = async () => { throw new Error("socket hang up"); };
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    await expect(mintOne({ provider, agnes, ...base(), ...only })).resolves.toEqual({
      ok: false, reason: "network_error",
    });
    expect(provider.deleted).toHaveLength(1);
  });

  // === 四种此前完全静默的 reason 必须各留一条日志事件 ===
  //
  // 这四条 return 是「注册机停摆但日志里查不出原因」的直接成因：收尾日志只有
  // minted=0，而这四种的处置完全不同（换通道 / 等 Agnes 恢复 / 改配置）。
  // 每条都断言事件的 fields 里带得出**定位信息**（邮箱地址、超时值、tokenName），
  // 而不是只断言「事件被记过」——后者一个空字段的事件也能通过。改成 recordingLogger
  // 断言事件名 + fields，而不是 spy console 断言文案子串：console.* 已经被换成
  // 注入的 Logger，spy console 只会看到空 mock。

  it("验证码超时时记一条 registrar.code_timeout 事件，带上邮箱地址与 codeTimeoutMs", async () => {
    const logger = recordingLogger();
    const provider = new FakeMailProvider({ domains: ["only.test"], code: null });
    const only = { candidates: ["only.test"] };
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    await mintOne({ provider, agnes, ...base(), ...only, logger, codeTimeoutMs: 7777 });
    const e = logger.entries.find((x) => x.event === "registrar.code_timeout");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    expect(e?.fields?.address).toBe(provider.created[0]!);
    expect(e?.fields?.codeTimeoutMs).toBe(7777);
  });

  it("注册被拒时记一条 registrar.register_rejected 事件，带上邮箱地址", async () => {
    const logger = recordingLogger();
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const only = { candidates: ["only.test"] };
    const { agnes } = agnesStub({ register: false });
    await mintOne({ provider, agnes, ...base(), ...only, logger });
    const e = logger.entries.find((x) => x.event === "registrar.register_rejected");
    expect(e).toBeDefined();
    expect(e?.fields?.address).toBe(provider.created[0]!);
  });

  it("登录拿不到令牌时记一条 registrar.login_no_token 事件，带上邮箱地址", async () => {
    const logger = recordingLogger();
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const only = { candidates: ["only.test"] };
    const { agnes } = agnesStub({ login: null });
    await mintOne({ provider, agnes, ...base(), ...only, logger });
    const e = logger.entries.find((x) => x.event === "registrar.login_no_token");
    expect(e).toBeDefined();
    expect(e?.fields?.address).toBe(provider.created[0]!);
  });

  it("建 key 失败时记一条 registrar.key_not_returned 事件，带上邮箱地址与 tokenName", async () => {
    const logger = recordingLogger();
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const only = { candidates: ["only.test"] };
    const { agnes } = agnesStub({ login: "tok", key: null });
    await mintOne({ provider, agnes, ...base(), ...only, logger, tokenName: "my-token-name" });
    const e = logger.entries.find((x) => x.event === "registrar.key_not_returned");
    expect(e).toBeDefined();
    expect(e?.fields?.address).toBe(provider.created[0]!);
    expect(e?.fields?.tokenName).toBe("my-token-name");
  });

  it("成功铸出 key 的路径不产生这四条事件（不是无条件乱记日志）", async () => {
    // 与上面四条成对：只有「失败才记」才能同时通过这五条。若实现改成无条件
    // 记日志，这条会红。
    const logger = recordingLogger();
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const only = { candidates: ["only.test"] };
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    expect(await mintOne({ provider, agnes, ...base(), ...only, logger })).toEqual({ ok: true, key: "sk-ok" });
    expect(logger.entries).toEqual([]);
  });

  it("不传 rand 时按 Math.random 兜底也能正常出 key", async () => {
    const provider = new FakeMailProvider({ domains: ["only.test"] });
    const only = { candidates: ["only.test"] };
    const { agnes } = agnesStub({ login: "tok", key: "sk-ok" });
    const { rand: _rand, ...rest } = { ...base(), ...only };
    expect(await mintOne({ provider, agnes, ...rest })).toEqual({ ok: true, key: "sk-ok" });
  });
});
