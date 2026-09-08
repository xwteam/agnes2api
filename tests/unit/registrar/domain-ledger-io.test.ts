import { describe, it, expect, vi, afterEach } from "vitest";
import { tendOnce, type TendDeps } from "../../../src/core/registrar/tender.js";
import { KeyPoolRepo } from "../../../src/core/keypool-repo.js";
import { MemoryStorage } from "../../helpers/fake-storage.js";
import { KeyedCountingStorage } from "../../helpers/counting-storage.js";
import { FakeMailProvider } from "../../helpers/fake-mailbox.js";
import { recordingLogger } from "../../helpers/recording-logger.js";
import type { RegistrarConfig } from "../../../src/core/registrar/config.js";
import {
  DOMAIN_LEDGER_KEY, emptyDomainLedger, type DomainLedger,
} from "../../../src/core/registrar/domain-ledger.js";
import {
  EDGE_BACKOFF_MS, APP_BACKOFF_MS, REGISTRAR_BACKOFF_KEY, type BackoffState,
} from "../../../src/core/registrar/backoff.js";
import { buildTendDeps } from "../../../src/http/wire.js";

/**
 * 「注册机把自己锁死了」那条缺陷的**行为判据**：域名结论记不记得住、撞上限流之后
 * 还打不打、一轮往存储里写几次。
 *
 * 判据一律钉**行为**（上游被打了几次 / 台账里有什么 / put 计数是多少），
 * 不钉调用点计数，也不复述另一份文件的内容。
 */

const NOW = 1_700_000_000_000;

const CFG: RegistrarConfig = {
  enabled: true, channel: "yyds",
  targetKeys: 1, mintBatch: 1, tendIntervalMs: 1_800_000, codeTimeoutMs: 5000,
  mintDelayMinMs: 0, mintDelayMaxMs: 0, maxDomainAttempts: 1,
  tokenName: "auto", agnesPlatformUrl: "https://platform.test",
  yyds: { baseUrl: "https://y.test", apiKey: "k" }, moemail: null,
  blocked: false,
};

/** 一次发验证码要回什么。`body` 是**分辨两种 400 的唯一线索**，所以每一格都要给。 */
type SendCode = (email: string) => { status: number; body: string };

function agnesStub(sendCode: SendCode) {
  /** 每一次 `/api/verification` 请求打给了哪个邮箱地址。**这就是「上游被打了几次」。** */
  const verification: string[] = [];
  const agnes = {
    platformUrl: "https://platform.test",
    fetcher: {
      async fetch(url: string) {
        if (url.includes("/api/verification")) {
          const email = decodeURIComponent(new URL(url).searchParams.get("email") ?? "");
          verification.push(email);
          const r = sendCode(email);
          return new Response(r.body, { status: r.status });
        }
        if (url.includes("/api/user/login")) {
          return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
        }
        if (url.includes("/api/token")) {
          return new Response(JSON.stringify({ data: { key: `sk-${verification.length}` } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    },
  };
  return { verification, agnes };
}

function makeIo(ledger: DomainLedger = emptyDomainLedger(), backoff: BackoffState | null = null) {
  const io = {
    ledger,
    backoff,
    /** 每一次落盘写回的那份台账。**长度就是「这一轮写了几次」。** */
    saved: [] as DomainLedger[],
    savedBackoff: [] as Array<BackoffState | null>,
    loadDomainLedger: async () => io.ledger,
    saveDomainLedger: async (l: DomainLedger) => { io.saved.push(l); io.ledger = l; },
    loadBackoff: async () => io.backoff,
    saveBackoff: async (s: BackoffState | null) => { io.savedBackoff.push(s); io.backoff = s; },
  };
  return io;
}

function makeDeps(p: {
  sendCode: SendCode;
  domains?: string[];
  over?: Partial<RegistrarConfig>;
  ledger?: DomainLedger;
  backoff?: BackoffState | null;
  rand?: () => number;
}) {
  const provider = new FakeMailProvider({ domains: p.domains ?? ["a.test", "b.test"] });
  const { verification, agnes } = agnesStub(p.sendCode);
  const io = makeIo(p.ledger ?? emptyDomainLedger(), p.backoff ?? null);
  const logger = recordingLogger();
  const deps: TendDeps = {
    repo: new KeyPoolRepo(new MemoryStorage(), { now: () => NOW, logger }),
    config: { ...CFG, ...p.over },
    providers: { yyds: provider },
    agnes,
    now: () => NOW,
    sleep: async () => {},
    rand: p.rand ?? (() => 0.5),
    logger,
    loadDomainLedger: io.loadDomainLedger,
    saveDomainLedger: io.saveDomainLedger,
    loadBackoff: io.loadBackoff,
    saveBackoff: io.saveBackoff,
  };
  return { deps, io, logger, provider, verification };
}

const OK = (): { status: number; body: string } => ({ status: 200, body: "{}" });
/** 真机上撞到的应用层限流逐字长这样。 */
const APP_LIMIT = { status: 400, body: '{"code":400,"message":"Too many registration attempts from this IP"}' };
/** 真机上撞到的边缘限流：**纯文本，不是 JSON**。 */
const EDGE_LIMIT = { status: 429, body: "error code: 1015" };
/** 「域名被屏蔽」那一档的 400：**正文里不含任何限流词**。 */
const DOMAIN_400 = { status: 400, body: '{"code":400,"message":"domain not allowed"}' };

/**
 * 一份「上游域名总数已经记过了」的空台账。
 *
 * ⚠️ **不是无关紧要的夹具细节**：`total` 变了本身就算台账内容变了（面板那一格要跟着走），
 * 所以**冷启动那一轮无论如何都会写一次**。要量「一条域名结论都没产生 ⇒ 一次写都不发」，
 * 就得先把 `total` 这根轴钉住 —— 否则量到的是「第一次见到这批域名」而不是「没学到东西」。
 */
function warmLedger(total: number): DomainLedger {
  return { v: 1, updatedAt: NOW - 1, total, entries: {} };
}

// ───────────────────────────────────────────────────────────────────────────

describe("域名台账让稳态下一次成功铸号只打一次发码请求", () => {
  /**
   * 判据①。台账里 A 已经判死、B 是已知能用；固定 `rand` 让**纯洗牌**确定性地把 A
   * 排在前面 —— 于是「按台账排序」与「照旧随机洗牌」这两种实现给出的第一个候选
   * 恰好相反，这一格才分得开它们。
   *
   * 变异：把 `selectDomains` 换回 `shuffle(全部域名).slice(0, maxDomainAttempts)`
   * ⇒ 次数变 2、第一个是 A ⇒ 红。
   */
  it("台账里有已知能用的域名时，一次成功铸号只打一次 /api/verification", async () => {
    const { deps, verification } = makeDeps({
      // A 判死、B 已知能用。
      ledger: { v: 1, updatedAt: NOW - 1, total: 2, entries: {
        "a.test": { s: "blocked", at: NOW - 1, n: 2 },
        "b.test": { s: "ok", at: NOW - 1, n: 1 },
      } },
      // Fisher-Yates 在两个元素上：`rand() = 0.9 ⇒ j = 1 ⇒ 不交换 ⇒ 纯洗牌先给 a.test`。
      rand: () => 0.9,
      sendCode: (email) => (email.endsWith("@a.test") ? DOMAIN_400 : OK()),
    });

    const out = await tendOnce(deps);

    expect(out.minted).toBe(1);
    // 手写字面量：**恰好 1 次**。照旧洗牌的实现在这份夹具下是 2 次。
    expect(verification).toHaveLength(1);
    expect(verification[0]!.endsWith("@b.test"), `实际打给了 ${verification[0]}`).toBe(true);
  });

  it("成功那一次把结论写回台账（这条结论才是下一轮「只打一次」的来源）", async () => {
    const { deps, io } = makeDeps({ sendCode: OK, domains: ["b.test"] });
    await tendOnce(deps);
    expect(io.saved).toHaveLength(1);
    expect(io.saved[0]!.entries["b.test"]).toEqual({ s: "ok", at: NOW, n: 1 });
    // 上游域名总数也记下来了 —— 面板那一格不许现打一次 listDomains 去凑。
    expect(io.saved[0]!.total).toBe(1);
  });
});

describe("撞上限流：整轮当场停手，并记一个跨轮退避", () => {
  /**
   * 判据②。**四条断言缺一不可**，因为这个缺陷有内外两层：
   * `mintOne` 里「换个域名接着打」，和 `tendOnce` 里「下一个名额照常开始」。
   *
   * 变异 a：把 429 放回 `status < 200 || status >= 300` 那一支（当成上游故障）
   * ⇒ 次数变 8（把候选打满）且不写退避键 ⇒ 红。
   * 变异 b：只改 `mintOne`、不把 `tender.ts` 那个 switch 里的 `rate_limited`
   * 挪到 `abortRound` ⇒ 次数变 `mintBatch` ⇒ 红。
   * **两条变异各红一次，说明内层与外层同时被钉住了。**
   */
  it("撞上边缘限流（429 + 非 JSON 正文）时整轮立刻停：只打一次、不记域名结论、写退避键", async () => {
    const domains = ["d0.test", "d1.test", "d2.test", "d3.test", "d4.test", "d5.test", "d6.test", "d7.test"];
    const { deps, io, verification } = makeDeps({
      domains,
      over: { targetKeys: 5, mintBatch: 5, maxDomainAttempts: 8 },
      ledger: warmLedger(8),
      sendCode: () => EDGE_LIMIT,
    });

    const out = await tendOnce(deps);

    // ① 上游只被打了一次。改动之前这里是 8（`maxDomainAttempts` 打满）。
    expect(verification).toHaveLength(1);
    // ② 一条域名结论都没记 —— 限流不是「这个域名不行」。
    expect(io.saved).toEqual([]);
    expect(io.ledger.entries).toEqual({});
    // ③ 退避键被写上，手写字面量（15 分钟 = 实测约 14 分钟的窗口向上取整 + 余量）。
    expect(io.savedBackoff).toEqual([{ until: NOW + 900_000, kind: "edge", since: NOW, hits: 1 }]);
    expect(EDGE_BACKOFF_MS).toBe(900_000);
    // ④ 归因是限流本身，不是「域名全被屏蔽」。
    expect(out.failures).toEqual([{ reason: "rate_limited", channel: "yyds" }]);
    expect(out.attempted).toBe(1);
  });

  /**
   * 判据③【承重】。同一个 400，正文说的是限流。
   *
   * 🔴 **这一格是「不会把好域名判死」的第一守卫。** 变异：把分类器改成
   * 「400 一律 domain_blocked」⇒ 台账里冒出 blocked、归因变成 `domain_blocked_all`、
   * 退避键的 kind 变了 ⇒ 红。**删了它，这个缺陷就重新变成静默的**：
   * 行为上只表现为「补池慢了一点」，而台账在系统性地记错。
   */
  it("400 带限流文案时绝不判域名死：台账里没有这个域名，归因是限流，退避走应用层那一档", async () => {
    const { deps, io } = makeDeps({ sendCode: () => APP_LIMIT, ledger: warmLedger(2) });
    const out = await tendOnce(deps);

    expect(io.ledger.entries).toEqual({});
    expect(io.saved).toEqual([]);
    expect(out.failures).toEqual([{ reason: "rate_limited", channel: "yyds" }]);
    expect(io.savedBackoff).toEqual([{ until: NOW + 1_800_000, kind: "app", since: NOW, hits: 1 }]);
    expect(APP_BACKOFF_MS).toBe(1_800_000);
  });

  /**
   * 判据④。上周还能过的域名今天回一个**不含限流词**的 400 —— 两边代价严重不对称，
   * 所以按限流处理。变异：删掉 `mintOne` 里那句「已知 ok 就不判死」的保险
   * ⇒ B 变成 `blocked(n=1)` ⇒ 红。
   */
  it("已知能用的域名回 400 时按限流处理，台账里它还是 ok", async () => {
    const { deps, io, logger } = makeDeps({
      domains: ["b.test"],
      ledger: { v: 1, updatedAt: NOW - 1, total: 1, entries: {
        "b.test": { s: "ok", at: NOW - 1, n: 4 },
      } },
      sendCode: () => DOMAIN_400,
    });

    const out = await tendOnce(deps);

    expect(io.ledger.entries["b.test"]).toEqual({ s: "ok", at: NOW - 1, n: 4 });
    expect(out.failures).toEqual([{ reason: "rate_limited", channel: "yyds" }]);
    expect(logger.has("registrar.known_good_domain_rejected")).toBe(true);
  });

  /**
   * 判据⑤【承重】：与上游文案无关的那道钳位。
   *
   * 模拟「上游改了限流文案」——8 个全新域名一律回 400，而正文里**一个限流词都没有**，
   * 于是分类器逐条判成「域名被屏蔽」。**唯一还站着的防线就是这道钳位。**
   *
   * 变异：删掉 `commitJournal` 里的钳位 ⇒ 写回的台账里 blocked 变 8 条 ⇒ 红。
   */
  it("一轮里冒出好几条疑似域名屏蔽时整体作废，台账里一条 blocked 都不许留", async () => {
    const domains = ["d0.test", "d1.test", "d2.test", "d3.test", "d4.test", "d5.test", "d6.test", "d7.test"];
    const { deps, io, logger, verification } = makeDeps({
      domains,
      over: { targetKeys: 1, mintBatch: 1, maxDomainAttempts: 8 },
      sendCode: () => DOMAIN_400,
    });

    await tendOnce(deps);

    // 前置条件：8 个候选真的都被试过了（否则下面那条零 blocked 是白给的）。
    expect(verification).toHaveLength(8);
    const blocked = Object.entries(io.ledger.entries).filter(([, e]) => e.s === "blocked");
    expect(blocked).toEqual([]);
    expect(logger.has("registrar.domain_verdicts_discarded")).toBe(true);
  });

  it("撞第二次时退避按指数翻倍（Cron 雷打不动地来，固定退避会让每轮都去续一次窗口）", async () => {
    const { deps, io } = makeDeps({
      sendCode: () => EDGE_LIMIT,
      backoff: { until: NOW - 1, kind: "edge", since: NOW - 10_000, hits: 1 },
    });
    await tendOnce(deps);
    // 手写字面量：第二次 = 15 分钟 × 2 = 30 分钟；`since` 取的是旧的那个。
    expect(io.savedBackoff).toEqual([{ until: NOW + 1_800_000, kind: "edge", since: NOW - 10_000, hits: 2 }]);
  });

  /**
   * 🔴 **承重格（评审回填）：一轮里既出了 key 又撞了限流，指数从头数。**
   *
   * 这是默认参数下**最常见的一轮形态**：`MINT_BATCH = 5`，而实测预算是「每窗口 4~6 次、
   * 余量为零」⇒「前几把成功、最后一把撞限流」。从前收尾那两支是
   * 「撞过限流 ⇒ 写 `nextBackoff(旧的)`」优先、「铸出来了 ⇒ 清键」殿后，于是这种一轮
   * 照样把 `hits` 一路推上去：连着几轮都长这样 ⇒ 15min → 30min → 1h → 2h → 4h(封顶)，
   * **而每一轮其实都在正常出 key**。五语言 REGISTRAR.md 与 CHANGELOG 逐字承诺的是相反
   * 的那句话。
   *
   * 变异：把 `tender.ts` 那一行改回 `nextBackoff(backoff, …)`
   * ⇒ 落盘的是 `hits: 4` / 2 小时 ⇒ 红。
   */
  it("同一轮里既铸出了 key 又撞上限流：退避重新起一串（hits 回到 1），不接着翻倍", async () => {
    let n = 0;
    const { deps, io } = makeDeps({
      domains: ["b.test"],
      over: { targetKeys: 5, mintBatch: 5 },
      // 前两把成功，第三把撞上边缘限流。
      sendCode: () => (++n <= 2 ? OK() : EDGE_LIMIT),
      backoff: { until: NOW - 1, kind: "edge", since: NOW - 100_000, hits: 3 },
    });

    const out = await tendOnce(deps);

    // 前置条件：这一轮**真的**铸出了 key，而且真的撞上了限流。
    expect(out.minted).toBe(2);
    expect(out.failures).toEqual([{ reason: "rate_limited", channel: "yyds" }]);
    // 手写字面量：重新起一串 ⇒ 15 分钟那一档、`hits: 1`、`since` 推到此刻。
    // 改动之前这里是 `{ until: NOW + 7_200_000, since: NOW - 100_000, hits: 4 }`。
    expect(io.savedBackoff).toEqual([{ until: NOW + 900_000, kind: "edge", since: NOW, hits: 1 }]);
  });

  it("成功铸出 key 之后把陈旧的退避键清掉（指数从头数）", async () => {
    const { deps, io } = makeDeps({
      sendCode: OK,
      backoff: { until: NOW - 1, kind: "edge", since: NOW - 10_000, hits: 3 },
    });
    await tendOnce(deps);
    expect(io.savedBackoff).toEqual([null]);
  });

  it("没有退避键时，成功的一轮一次退避写都不产生（别为清一个不存在的键白付一次写）", async () => {
    const { deps, io } = makeDeps({ sendCode: OK });
    await tendOnce(deps);
    expect(io.savedBackoff).toEqual([]);
  });
});

describe("一轮之内：域名轮着用，同一个域名最多学一跳", () => {
  /** 从被打过的那些邮箱地址里把域名取出来 —— 「这一轮到底用到了几个不同域名」。 */
  const domainsOf = (addresses: readonly string[]): string[] =>
    addresses.map((a) => a.slice(a.indexOf("@") + 1));

  /**
   * 🔴 **承重格（评审回填）：一轮 5 把 key 不许全挂在同一个域名上。**
   *
   * 台账**轮内不更新**（落盘统一在收尾），而 `selectDomains` 对「已知 ok」那一档是按
   * `at` 的全序排序 ⇒ 每个名额都会拿到**同一个**域名：默认间隔下 6 分钟里 5 个账号
   * 全挂在一个域名下，而那一档的 JSDoc 逐字写着「LRU 轮换，别把一个好域名打成上游
   * 风控的焦点」。轮换从前只发生在轮与轮之间。
   *
   * ⚠️ **这一格钉的是「用到了几个不同域名」，不是排序函数的返回值**：
   * `selectDomains` 那几格量的是纯函数的列表，量不到「一轮之内实际打到哪去了」。
   *
   * 变异：删掉 `tender.ts` 里的 `usedThisRound`（或排序里的 `spent` 那一项）
   * ⇒ 5 个名额全是 `p.test` ⇒ 红。
   */
  it("台账里有 3 个已知能用的域名时，一轮 5 个名额轮着用，不是全打同一个", async () => {
    const { deps, verification } = makeDeps({
      domains: ["p.test", "q.test", "r.test"],
      over: { targetKeys: 5, mintBatch: 5 },
      ledger: { v: 1, updatedAt: NOW - 1, total: 3, entries: {
        "p.test": { s: "ok", at: NOW - 300, n: 1 },
        "q.test": { s: "ok", at: NOW - 200, n: 1 },
        "r.test": { s: "ok", at: NOW - 100, n: 1 },
      } },
      sendCode: OK,
    });

    const out = await tendOnce(deps);

    expect(out.minted).toBe(5);
    // 手写字面量：`at` 旧→新轮着来，第 4、5 个名额转回头。
    expect(domainsOf(verification))
      .toEqual(["p.test", "q.test", "r.test", "p.test", "q.test"]);
  });

  /**
   * 🔴 **承重格（评审回填）：一轮之内不许把一个域名从「没见过」判死。**
   *
   * 钳位数的是**域名数**（`Set`，同一个域名撞几次都还是 1 ⇒ 不触发），而 `n` 从前是按
   * **观测条数**累加的 ⇒ 同一个域名在一轮里被拒两次就直接 `n = 2` ⇒ **一轮之内判死**
   * 并发出 `registrar.domain_blocked`。而
   * `src/core/registrar/domain-ledger.ts` 的文件头把「判死要两跳」登记为压着误判的第一层、
   * 逐字写着「一次误分类只让好域名短暂降权」。
   *
   * 变异：把 `commitJournal` 的折叠删掉 ⇒ `n` 变 2、事件冒出来 ⇒ 红。
   */
  it("一轮之内同一个域名连着两次 400：只学一跳，一条 registrar.domain_blocked 都不发", async () => {
    const { deps, io, logger, verification } = makeDeps({
      domains: ["x.test"],
      over: { targetKeys: 2, mintBatch: 2, maxDomainAttempts: 1 },
      ledger: warmLedger(1),
      sendCode: () => DOMAIN_400,
    });

    await tendOnce(deps);

    // 前置条件：这一轮真的把同一个域名打了两次（否则下面两条是白给的）。
    expect(domainsOf(verification)).toEqual(["x.test", "x.test"]);
    expect(io.ledger.entries["x.test"]).toEqual({ s: "blocked", at: NOW, n: 1 });
    expect(logger.has("registrar.domain_blocked")).toBe(false);
  });

  /**
   * **反向控制**：第二跳来自**下一轮**时照常判死并发事件 —— 上面那一格不是把整条
   * 判死路径关掉了。
   */
  it("第二轮再挨一次才判死，事件这时才发", async () => {
    const first = makeDeps({
      domains: ["x.test"],
      over: { targetKeys: 1, mintBatch: 1 },
      ledger: warmLedger(1),
      sendCode: () => DOMAIN_400,
    });
    await tendOnce(first.deps);
    expect(first.io.ledger.entries["x.test"]!.n).toBe(1);

    const second = makeDeps({
      domains: ["x.test"],
      over: { targetKeys: 1, mintBatch: 1 },
      ledger: first.io.ledger,
      sendCode: () => DOMAIN_400,
    });
    await tendOnce(second.deps);

    expect(second.io.ledger.entries["x.test"]!.n).toBe(2);
    expect(second.logger.has("registrar.domain_blocked")).toBe(true);
  });
});

describe("写次数：一轮最多写一次台账，结论没变时零次", () => {
  /**
   * 判据⑧的前半。变异：把落盘挪进 `for` 循环里（每个名额写一次）⇒ 变 5 ⇒ 红。
   */
  it("铸 5 把的一轮只写一次台账", async () => {
    const { deps, io } = makeDeps({
      domains: ["b.test"],
      over: { targetKeys: 5, mintBatch: 5 },
      sendCode: OK,
    });
    const out = await tendOnce(deps);
    expect(out.minted).toBe(5);
    expect(io.saved).toHaveLength(1);
  });

  /**
   * 判据⑧的后半 + 判据⑩的一半：**这一轮一条域名结论都没产生**（邮箱压根建不出来）
   * ⇒ 一次写都不许发。这是稳态下「台账那把键日写 0 次」的来源。
   */
  it("一条域名结论都没产生的一轮，一次写都不发", async () => {
    const provider = new FakeMailProvider({ domains: ["a.test"], failCreateOn: ["a.test"] });
    const { verification, agnes } = agnesStub(OK);
    const io = makeIo(warmLedger(1));
    const logger = recordingLogger();
    const out = await tendOnce({
      repo: new KeyPoolRepo(new MemoryStorage(), { now: () => NOW, logger }),
      config: { ...CFG },
      providers: { yyds: provider },
      agnes, now: () => NOW, sleep: async () => {}, rand: () => 0.5, logger,
      ...io,
    });
    expect(out.failures).toEqual([{ reason: "provider_error", channel: "yyds" }]);
    expect(verification).toEqual([]);
    expect(io.saved).toEqual([]);
    expect(io.savedBackoff).toEqual([]);
  });
});

describe("噪声不进台账", () => {
  /**
   * 判据⑩。5xx 与「请求压根没发出去」说的都是「这次没走通」，不是「上游怎么看这个
   * 域名」。变异：把 `upstream_error` 也接进 `recordVerdict` ⇒ 红。
   */
  it("上游 5xx 一条域名结论都不记", async () => {
    const { deps, io } = makeDeps({ sendCode: () => ({ status: 500, body: "boom" }), ledger: warmLedger(2) });
    const out = await tendOnce(deps);
    expect(out.failures).toEqual([{ reason: "upstream_error", channel: "yyds" }]);
    expect(io.ledger.entries).toEqual({});
    expect(io.saved).toEqual([]);
  });

  it("fetch 直接 reject（网络层）时同样一条都不记", async () => {
    const provider = new FakeMailProvider({ domains: ["a.test"] });
    const io = makeIo(warmLedger(1));
    const logger = recordingLogger();
    const out = await tendOnce({
      repo: new KeyPoolRepo(new MemoryStorage(), { now: () => NOW, logger }),
      config: { ...CFG },
      providers: { yyds: provider },
      agnes: {
        platformUrl: "https://platform.test",
        fetcher: { async fetch(): Promise<Response> { throw new Error("ECONNRESET"); } },
      },
      now: () => NOW, sleep: async () => {}, rand: () => 0.5, logger,
      ...io,
    });
    expect(out.failures).toEqual([{ reason: "network_error", channel: "yyds" }]);
    expect(io.ledger.entries).toEqual({});
    expect(io.saved).toEqual([]);
  });
});

describe("轮级墙钟预算把域内间隔算进去", () => {
  /**
   * 判据⑨。**漏掉这一项的后果不是变慢，是漏邮箱**：低估 ⇒ 开始一次跑不完的尝试
   * ⇒ 平台从中间砍断 ⇒ `mintOne` 的 `finally` 不执行 ⇒ 临时邮箱漏删且没有日志。
   *
   * 夹具刻意落在「旧公式会启动第 2 次尝试、新公式不会」的区间。
   * 变异：`worstAttemptMs` 改回只算 `codeTimeoutMs` ⇒ `attempted` 变 2 ⇒ 红。
   */
  it("maxDomainAttempts=3 时单次最坏耗时是 120000 + 2×90000，预算据此提前收尾", async () => {
    let t = 0;
    const provider = new FakeMailProvider({ domains: ["a.test"] });
    const { agnes } = agnesStub(OK);
    const io = makeIo(warmLedger(1));
    const logger = recordingLogger();
    const out = await tendOnce({
      repo: new KeyPoolRepo(new MemoryStorage(), { now: () => t, logger }),
      config: {
        ...CFG, targetKeys: 5, mintBatch: 5,
        codeTimeoutMs: 120_000, maxDomainAttempts: 3,
        mintDelayMinMs: 90_000, mintDelayMaxMs: 90_000,
      },
      providers: { yyds: provider },
      agnes,
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
      rand: () => 0.5,
      logger,
      // 预算 400000：旧公式（worstAttempt = 120000）下第 2 次尝试
      // `0 + 90000 + 120000 = 210000 ≤ 400000` 会开始；
      // 新公式（worstAttempt = 300000）下 `0 + 90000 + 300000 = 390000` 也 ≤ 400000……
      // 所以取 380000：旧公式 210000 ≤ 380000 开始，新公式 390000 > 380000 不开始。
      roundBudgetMs: 380_000,
      ...io,
    });

    expect(out.attempted).toBe(1);
    const e = logger.entries.find((x) => x.event === "registrar.round_budget_exhausted");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    // **手写字面量**：120000 + (3 − 1) × 90000。不从被测对象反查回填。
    expect(e?.fields?.worstAttemptMs).toBe(300_000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 存储那一侧：真的经过 `buildTendDeps`，按键数 put
// ───────────────────────────────────────────────────────────────────────────

describe("台账落盘走的是真接线（buildTendDeps），按键数写次数", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("一轮铸 5 把，registrar:domains 只被 put 一次；退避键一次都不写", async () => {
    // 出站全部拦在 `globalThis.fetch` 上：`buildTendDeps` 里那个 `NativeFetcher`
    // 就是裸 `fetch`，这样这一格走的是**真的接线**而不是一份抄件。
    let mailboxes = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/verification")) return new Response("{}", { status: 200 });
      if (url.includes("/api/user/login")) {
        return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
      }
      if (url.includes("/api/token")) {
        return new Response(JSON.stringify({ data: { key: `sk-${mailboxes}` } }), { status: 200 });
      }
      // YYDS 邮箱通道。形状照适配器实际读的那几个字段，**顺序有讲究**：
      // 详情那条路径（`/v1/messages/<id>?…`）必须排在列表（`/v1/messages?…`）前面。
      if (url.includes("/v1/domains")) {
        return new Response(JSON.stringify({ data: [{ domain: "b.test" }] }), { status: 200 });
      }
      if (url.includes("/v1/accounts")) {
        mailboxes++;
        return new Response(
          JSON.stringify({ data: { address: `u${mailboxes}@b.test`, id: `id-${mailboxes}` } }),
          { status: 200 },
        );
      }
      if (/\/v1\/messages\/[^?]+/.test(url)) {
        return new Response(JSON.stringify({ data: { verificationCode: "123456" } }), { status: 200 });
      }
      if (url.includes("/v1/messages")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });

    const storage = new KeyedCountingStorage();
    const deps = await buildTendDeps({
      GATEWAY_TOKEN: "t",
      REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k",
      TARGET_KEYS: "5", MINT_BATCH: "5", MINT_DELAY_MIN_MS: "1", MINT_DELAY_MAX_MS: "1",
      // ⚠️ **不许把它调成 1 图快。** 这一格用的是真的 `sleep`/`now`（`buildTendDeps` 自己
      // 装的那一份），而 `pollCode` 的循环条件是 `now() - start < codeTimeoutMs`：
      // 给 1 毫秒的话，只要第一次 fetch 花掉 ≥1ms，循环一次都不进 ⇒ `code_timeout` ⇒
      // 这一轮铸不满 5 把。**实测 13 次里偶发红过 1 次**，成因就是它。
      // 收码那一步在这份夹具里是立刻返回的，所以给足超时不会让这一格变慢。
      CODE_TIMEOUT_MS: "60000",
    }, storage);
    expect(deps, "接线没装起来，这一格量的就不是真接线了").not.toBeNull();

    const out = await tendOnce(deps!);

    // 前置条件：这一轮真的铸满了 5 把（否则「铸 5 把只写一次」是白给的）。
    expect(out.minted).toBe(5);
    // 手写字面量：**恰好 1 次**。把落盘挪进 for 循环之后这里会是 5。
    expect(storage.puts.get(DOMAIN_LEDGER_KEY) ?? 0).toBe(1);
    expect(storage.puts.get(REGISTRAR_BACKOFF_KEY) ?? 0).toBe(0);
  });

  /**
   * 🔴 **承重格（评审回填）：「重新起一串」必须活着穿过落盘那一层。**
   *
   * `tendOnce` 那一侧的判据用的是注入的假 `saveBackoff`，**量不到 `mergeBackoff`**：
   * 真接线上写回去要先 `get` 再 merge，而 merge 从前对 `hits` 是无脑取大 ⇒ 写回来的
   * `hits: 1` 被存储里那份旧的 `hits: 5` 顶掉 ⇒ 承诺在真接线上原地失效，而上面那些格
   * 照样全绿。**一份行为在两个地方各说各话，只有走真存储的这一格看得见。**
   *
   * 变异：把 `mergeBackoff` 的 `hits` 改回 `Math.max(cur.hits, next.hits)`
   * ⇒ 落盘的是 `hits: 6` ⇒ 红。
   */
  it("真接线：同一轮里既铸出了 key 又撞上限流，落盘的 hits 是 1 不是接着翻倍", async () => {
    let mailboxes = 0;
    let sent = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/verification")) {
        // 前两把成功，第三把撞上边缘限流（429 + 纯文本正文）。
        return ++sent <= 2
          ? new Response("{}", { status: 200 })
          : new Response("error code: 1015", { status: 429 });
      }
      if (url.includes("/api/user/login")) {
        return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
      }
      if (url.includes("/api/token")) {
        return new Response(JSON.stringify({ data: { key: `sk-${mailboxes}` } }), { status: 200 });
      }
      if (url.includes("/v1/domains")) {
        return new Response(JSON.stringify({ data: [{ domain: "b.test" }] }), { status: 200 });
      }
      if (url.includes("/v1/accounts")) {
        mailboxes++;
        return new Response(
          JSON.stringify({ data: { address: `u${mailboxes}@b.test`, id: `id-${mailboxes}` } }),
          { status: 200 },
        );
      }
      if (/\/v1\/messages\/[^?]+/.test(url)) {
        return new Response(JSON.stringify({ data: { verificationCode: "123456" } }), { status: 200 });
      }
      if (url.includes("/v1/messages")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });

    const storage = new KeyedCountingStorage();
    // 存储里先摆一把「上一串已经滚到 5」的退避键（窗口早就过完了，拦不住这一轮）。
    const before = Date.now();
    await storage.put(REGISTRAR_BACKOFF_KEY, {
      until: before - 1000, kind: "edge", since: before - 200_000, hits: 5,
    });
    // 摆夹具那一次 put 不算这一轮的账 —— 下面要数的是「这一轮写了几次」。
    storage.puts.clear();

    const deps = await buildTendDeps({
      GATEWAY_TOKEN: "t",
      REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k",
      TARGET_KEYS: "5", MINT_BATCH: "5", MINT_DELAY_MIN_MS: "1", MINT_DELAY_MAX_MS: "1",
      CODE_TIMEOUT_MS: "60000",
    }, storage);
    expect(deps, "接线没装起来，这一格量的就不是真接线了").not.toBeNull();

    const out = await tendOnce(deps!);

    // 前置条件：这一轮**真的**铸出了 key，而且真的撞上了限流。
    expect(out.minted).toBe(2);
    expect(out.failures).toEqual([{ reason: "rate_limited", channel: "yyds" }]);

    // 写配额账里那一笔的判据：**撞上限流的那一轮，退避键恰好被 put 一次**
    //（五语言 DEPLOY.md 按「每轮最多 1 次 ⇒ 上界 48 次/天」记账）。
    expect(storage.puts.get(REGISTRAR_BACKOFF_KEY) ?? 0).toBe(1);

    const saved = await storage.get<BackoffState>(REGISTRAR_BACKOFF_KEY);
    expect(saved?.hits, "重新起一串被 mergeBackoff 顶掉了").toBe(1);
    expect(saved?.kind).toBe("edge");
    // 窗口长度回到基数那一档（15 分钟），不是 `hits: 6` 那一档的 4 小时封顶。
    // 这里用真时钟，所以给一分钟的容差而不是等值断言。
    expect(saved!.until).toBeGreaterThan(before + EDGE_BACKOFF_MS - 60_000);
    expect(saved!.until).toBeLessThanOrEqual(Date.now() + EDGE_BACKOFF_MS);
  });
});
