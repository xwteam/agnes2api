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
  /**
   * 这一轮的时钟。**省略 = 定在 `NOW`**（绝大多数格只跑一轮，时间不动更好读）。
   *
   * 给它的唯一理由是**跨轮**判据：退避窗口是拿 `until > now` 判的，把好几轮全钉在同一
   * 时刻的话，第一轮记下的窗口会把后面每一轮都拦掉 —— 量到的就不是「补池会不会卡死」
   * 而是「同一毫秒里连打六次会怎样」。
   */
  now?: () => number;
}) {
  const provider = new FakeMailProvider({ domains: p.domains ?? ["a.test", "b.test"] });
  const { verification, agnes } = agnesStub(p.sendCode);
  const io = makeIo(p.ledger ?? emptyDomainLedger(), p.backoff ?? null);
  const logger = recordingLogger();
  const now = p.now ?? (() => NOW);
  const deps: TendDeps = {
    repo: new KeyPoolRepo(new MemoryStorage(), { now, logger }),
    config: { ...CFG, ...p.over },
    providers: { yyds: provider },
    agnes,
    now,
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
   * 判据④。上周还能过的域名今天回一个**不含限流词**的 400。
   *
   * ⚠️⚠️ **这一格的期望翻过一次面，翻的理由写在这里。** 它从前钉的是那道「已知 ok 就
   * 改判成限流、台账里它还是 ok」的保险 —— 而那正是把整轮停死、一条结论都不记的那条
   * 路径（死锁全文见 `src/core/registrar/mint.ts` 的 `domain_blocked` 那一支，
   * 复现探针是上面「连着 6 轮：坏域名被降下去……」那一格）。今天的行为是
   * **照分类器的结论记一跳**，而**诊断留着** —— 这一格钉的就是「拆掉保险没顺手把
   * 那条早期信号也一起拆掉」。
   *
   * 变异：删掉 `mintOne` 里那条 `registrar.known_good_domain_rejected` 日志
   * ⇒ 最后一行红（而台账那两行照绿 —— 两件事分得开）。
   */
  it("已知能用的域名回 400：照记一跳，并单独留一条点名它的诊断事件", async () => {
    const { deps, io, logger } = makeDeps({
      domains: ["b.test"],
      ledger: { v: 1, updatedAt: NOW - 1, total: 1, entries: {
        "b.test": { s: "ok", at: NOW - 1, n: 4 },
      } },
      sendCode: () => DOMAIN_400,
    });

    const out = await tendOnce(deps);

    // 只降一跳：`ok(n=4)` ⇒ `blocked(n=1)`，方向一变 `n` 就归 1，判死还差一跳。
    expect(io.ledger.entries["b.test"]).toEqual({ s: "blocked", at: NOW, n: 1 });
    expect(out.failures).toEqual([{ reason: "domain_blocked_all", channel: "yyds" }]);
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

/**
 * 🔴 **一个已知能用的域名被上游真的拉黑之后，补池不许卡死。**
 *
 * 这一族钉的是从前那道「已知 ok 的域名回 400 就按限流处理」的保险留下的死锁：
 * 它**一条域名结论都不记**（台账里那条 `ok` 的 `at` 永远不刷新）、**当场 return**
 *（同一次尝试里后面的候选一个都不试），而 `./tender.ts` 据此中止整轮并记指数退避。
 * `selectDomains` 的档内次序是 `at` 升序 ⇒ 那条 `at` 冻住的坏域名每一轮都排第一
 * ⇒ 每轮都是「打它一次 → 判成限流 → 停整轮 → 退避翻倍」，一把 key 都出不来，
 * 直到 `OK_TTL_MS`（7 天）把那条 `ok` 过期掉才自愈。
 */
describe("已知能用的域名被上游真的拉黑之后，补池不许卡死", () => {
  const domainsOf = (addresses: readonly string[]): string[] =>
    addresses.map((a) => a.slice(a.indexOf("@") + 1));

  /** 两轮补池之间隔多久。取内置的 `TEND_INTERVAL_MS` 那一档（30 分钟）。 */
  const ROUND_GAP_MS = 1_800_000;

  /**
   * 🔴 **承重格：连着 6 轮之后仍然铸得出 key。**
   *
   * 夹具就是实测复现出来的那个形态：台账里 `b.test` 是上周真用过的「已知能用」，
   * 上游今天真的把它拉黑了（回一个**不含任何限流词**的 400），而另外三个域名
   * 从没试过、且完全正常。
   *
   * 变异：把 `mintOne` 里那道保险改回「`isKnownGood` ⇒ 当场 return `rate_limited`
   * 且不记任何域名结论」⇒ 六轮 `minted` 全是 0、退避键被写三次、`b.test` 在台账里
   * 还是 `ok` 且 `at` 一次都没刷新 ⇒ 红。
   */
  it("连着 6 轮：坏域名被降下去，另外三个候选派得出去，key 照样铸得出来", async () => {
    const domains = ["b.test", "c.test", "d.test", "e.test"];
    const sendCode: SendCode = (email) => (email.endsWith("@b.test") ? DOMAIN_400 : OK());

    let ledger: DomainLedger = { v: 1, updatedAt: NOW - 1, total: 4, entries: {
      "b.test": { s: "ok", at: NOW - 1000, n: 3 },
    } };
    let backoff: BackoffState | null = null;
    const mintedPerRound: number[] = [];
    const backoffWrites: Array<BackoffState | null> = [];
    const hit: string[] = [];

    for (let r = 0; r < 6; r++) {
      const at = NOW + r * ROUND_GAP_MS;
      const round = makeDeps({ domains, ledger, backoff, sendCode, now: () => at });
      const out = await tendOnce(round.deps);
      mintedPerRound.push(out.minted);
      backoffWrites.push(...round.io.savedBackoff);
      hit.push(...domainsOf(round.verification));
      ledger = round.io.ledger;
      backoff = round.io.backoff;
    }

    // **手写字面量。** 第一轮把它那一个名额花在「发现 b.test 真的不行」上
    //（`MAX_DOMAIN_ATTEMPTS` 的内置取值是 1，一次尝试只试一个候选），
    // 从第二轮起每一轮都铸得出来。改动之前这里是 [0, 0, 0, 0, 0, 0]。
    expect(mintedPerRound).toEqual([0, 1, 1, 1, 1, 1]);
    // 全程一次限流都没撞到 ⇒ 一个退避窗口都不许记。
    // 改动之前这里是三次 app 退避，窗口 30min → 60min → 120min 地翻倍。
    expect(backoffWrites).toEqual([]);
    // 坏域名被降到「待复查」那一档（`n = 1`，两跳规则还没判死它），`at` 刷新到第一轮。
    expect(ledger.entries["b.test"]).toEqual({ s: "blocked", at: NOW, n: 1 });
    // 前置条件：另外三个从没试过的域名真的被派出去了（否则上面那行 minted 是白给的）。
    expect(hit.filter((d) => d !== "b.test").length).toBeGreaterThan(0);
  });

  /**
   * 🔴 **承重格：防误判没被这次改动丢掉 —— 一次误判不许立刻把好域名判死。**
   *
   * 场景是那道保险当初唯一想防的风险：**上游改了限流文案**，于是一句真限流的回话
   * 落进负向匹配、被判成「域名被屏蔽」。今天接住它的是**两跳规则**：
   * 第一跳只把域名降到「待复查」（`n = 1`，仍然会被选中），一次 2xx 无条件覆盖回「可用」。
   *
   * 变异：把 `commitJournal` 里 `n` 的方向判定改成无脑 `prev.n + 1`
   *（`ok(n=5)` ⇒ `blocked(n=6)`）⇒ 第一跳就 `n >= 2`、`registrar.domain_blocked` 当场发出
   * ⇒ 红。
   */
  it("上游改了限流文案时，一次误判只把好域名降到「待复查」，一次成功就回到「可用」", async () => {
    // 一句真限流的回话，但措辞是词表里一个都没有的那种 —— 分类器会把它读成「域名被屏蔽」。
    const REWORDED = { status: 400, body: '{"code":400,"message":"Slow down, mate."}' };

    const first = makeDeps({
      domains: ["b.test"],
      ledger: { v: 1, updatedAt: NOW - 1, total: 1, entries: {
        "b.test": { s: "ok", at: NOW - 1000, n: 5 },
      } },
      sendCode: () => REWORDED,
    });
    await tendOnce(first.deps);

    // 只降一跳：`n = 1` 落在「待复查」那一档，**不是**判死的 `n >= 2`。
    expect(first.io.ledger.entries["b.test"]).toEqual({ s: "blocked", at: NOW, n: 1 });
    expect(first.logger.has("registrar.domain_blocked")).toBe(false);

    // 下一轮上游恢复正常：一次 2xx 无条件覆盖回「可用」，而且它照样被选中了
    //（`selectDomains` 永不 filter）。
    const second = makeDeps({
      domains: ["b.test"],
      ledger: first.io.ledger,
      sendCode: OK,
      now: () => NOW + ROUND_GAP_MS,
    });
    const out = await tendOnce(second.deps);
    expect(out.minted).toBe(1);
    expect(second.io.ledger.entries["b.test"]).toEqual({ s: "ok", at: NOW + ROUND_GAP_MS, n: 1 });
  });


  /**
   * 🔴🔴 **承重格（评审回填）：反方向那一档 —— 上游改了限流文案时，一轮打几次、
   * 写不写退避。**
   *
   * 这一格补的是那道保险拆掉之后**没人守的那一维**。拆保险治的是「上游真把好域名
   * 拉黑」那半边（那半边从前一整轮只打 1 次就停死七天）；而它的另一半是：
   * **上游改了限流文案**，于是一句真限流的回话落进负向匹配、被逐条读成「域名被屏蔽」
   * —— 这一档里 `mintOne` 的两条限流支一次都进不去，`edge` / `app` 两档退避
   * **一个都不会产生**，而本轮也不再提前停手。
   *
   * 拆保险之后、接上处置之前的实测（同一份夹具、内置值、5 轮）：
   * 每一轮都打满 `mintBatch` = 5 次注定失败的发码请求、退避恒为 `null`、
   * 台账因为钳位一个字不变 ⇒ 下一轮逐字节重演。Cron 每 30 分钟一轮
   * ⇒ 240 次/天，而本仓在 `src/core/registrar/backoff.ts` 与本文件被测的
   * `tender.ts` 里逐字登记着上游的行为是「窗口里每打一次请求就把窗口续一次」。
   *
   * 治它的是 `finishRound` 里那一档：这一轮**成片**判出「域名被屏蔽」
   *（`commitJournal` 的 `discarded > 0`，即同一轮里 ≥2 个域名被判屏蔽；或者上游列出来的
   * 域名一个不落全被判屏蔽 —— 后一条是给单域名部署的，判据在下一格）
   * **且这一轮零产出**时，按 `cluster` 记一个跨轮退避。
   * 它**不中止本轮**、**不吞任何域名结论**，所以那把 `at` 冻住的死锁不会回来。
   *
   * ⚠️ **这一格钉的是两个数：一轮打几次、退避写了什么**（都是手写字面量）。
   * 反向控制在下面那一格「同一轮里两个已知能用的域名同时被拉黑……」：
   * 那一格 `discarded` 同样 > 0，但**这一轮铸得出 key**，于是一个退避键都不许写。
   *
   * 变异：把 `finishRound` 里 `toSave = nextBackoff(..., "cluster", ...)` 那一行删掉
   * ⇒ 十轮请求数变成 5 × 10、退避恒为 null ⇒ 红。
   */
  it("上游改了限流文案时：一轮打满 mintBatch 次，但记下 cluster 退避把后面几轮按住", async () => {
    // 一句真限流的回话，措辞是词表里一个都没有的那种 ⇒ 分类器逐条读成「域名被屏蔽」。
    const REWORDED = { status: 400, body: '{"code":400,"message":"Slow down, mate."}' };
    const domains = ["b.test", "c.test", "d.test", "e.test"];
    // 稳态台账：b / c 是上周真用过的「已知能用」。冷启动那一档不会走到这里
    //（空台账下 `discarded` 同样 > 0，但那一档本来就该退避 —— 见下面那条断言）。
    let ledger: DomainLedger = { v: 1, updatedAt: NOW - 1, total: 4, entries: {
      "b.test": { s: "ok", at: NOW - 3000, n: 2 },
      "c.test": { s: "ok", at: NOW - 2000, n: 2 },
    } };
    let backoff: BackoffState | null = null;
    const perRound: number[] = [];
    const mintedPerRound: number[] = [];
    const kinds = new Set<string>();

    for (let r = 0; r < 10; r++) {
      const at = NOW + r * ROUND_GAP_MS;
      const round = makeDeps({
        domains, ledger, backoff, now: () => at,
        over: { targetKeys: 5, mintBatch: 5 },
        sendCode: () => REWORDED,
      });
      const out = await tendOnce(round.deps);
      perRound.push(round.verification.length);
      mintedPerRound.push(out.minted);
      ledger = round.io.ledger;
      backoff = round.io.backoff;
      if (backoff !== null) kinds.add(backoff.kind);
    }

    // 🔴 **手写字面量。** 打满的那几轮仍然是 5 次（本轮不提前停手这一条没变），
    // 但 0 的那几轮是退避窗口把整轮挡在门外 ——「不发一次上游请求」。
    // 接上处置之前这里是 5 × 10 = 50 次；现在是 20 次。
    expect(perRound).toEqual([5, 5, 0, 5, 0, 0, 0, 5, 0, 0]);
    // 前置条件：这一档里一把 key 都铸不出来（否则上面那串 0 是「池子满了」造成的）。
    expect(mintedPerRound).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // 退避确实记下来了，而且归因是**这一轮的形状**，不是冒充上游说过的话。
    expect(kinds).toEqual(new Set(["cluster"]));
    // 指数真的在涨：这十轮里真正打出去的是第 0/1/3/7 轮，第 4 次撞（第 7 轮，
    // 也就是 `NOW + 7 × 30min`）算出来的窗口是 30 分钟 × 2³ = 4 小时，正好撞上封顶。
    // `since` 停在第一次撞的时刻 —— 它说的是「这一串是从什么时候开始的」。
    expect(backoff).toEqual({
      until: NOW + 7 * ROUND_GAP_MS + 14_400_000, kind: "cluster", since: NOW, hits: 4,
    });
    // 钳位照旧生效 ⇒ 台账一个字都没变（这一维一格都没动）。
    expect(ledger.entries).toEqual({
      "b.test": { s: "ok", at: NOW - 3000, n: 2 },
      "c.test": { s: "ok", at: NOW - 2000, n: 2 },
    });
  });

  /**
   * 🔴🔴 **承重格：钳位生效的那一支，横幅让运维去翻的那条事件根本发不出来。**
   *
   * 这一格是评审拿探针实测出来的，不是推断，而且**它钉的是上面那格没人管的一维**：
   * 上面那格与下面那格钉的都是「请求量与退避键」，钳位这一支的**事件形态**一格都没有。
   *
   * 可证的部分（`./domain-ledger.ts` 的 `commitJournal`）：钳位一生效，`applied` 就把
   * **全部** `blocked` 判定滤光 ⇒ 剩下的只可能是 `ok` ⇒ `newlyBlocked`（只从
   * `s === "blocked"` 那一支产生）**恒为空** ⇒ `registrar.domain_blocked` 一条都发不出来。
   * 而同一轮发出的 `registrar.domain_verdicts_discarded` 的 `fields` 只有条数、本轮产出
   * 与退避截止时刻，**一个字的上游原话都不带**。
   *
   * ⇒ 面板横幅与五语言文档从前逐字写着「去翻 registrar.domain_blocked 带的上游原话」，
   * 在这一支上指向一条永远不会发出的事件。现在按支分开写，而这一支**唯一**带得出上游
   * 原话的是 `./mint.ts` 的 `registrar.known_good_domain_rejected`，且它只覆盖台账里
   * 已知能用的那些域名 —— 这一格把这三件事一起钉住。
   *
   * ⚠️ **`domain_blocked` 那条断言是「全程一条都没有」，不是「第 0 轮没有」**：
   * 只看第 0 轮的话，「判死要两跳」本来就让它在第一轮沉默，那条断言会退化成空转。
   *
   * 变异：把 `commitJournal` 里 `applied` 那一行的钳位过滤去掉
   *（`const applied = roundVerdicts`）⇒ 台账学得到 blocked、第二轮就发出
   * `registrar.domain_blocked` ⇒ 红。
   */
  it("钳位生效那一轮：registrar.domain_blocked 一条都发不出来，上游原话只在 known_good_domain_rejected 里", async () => {
    const REWORDED = { status: 400, body: '{"code":400,"message":"Slow down, mate."}' };
    const domains = ["b.test", "c.test", "d.test", "e.test"];
    let ledger: DomainLedger = { v: 1, updatedAt: NOW - 1, total: 4, entries: {
      "b.test": { s: "ok", at: NOW - 3000, n: 2 },
      "c.test": { s: "ok", at: NOW - 2000, n: 2 },
    } };
    let backoff: BackoffState | null = null;
    const blockedSeen: string[] = [];
    const discardedFieldKeys: string[][] = [];
    const wordingCarriers: string[] = [];

    // 4 轮里真正打出去的是第 0/1/3 轮（退避把其余轮次挡在门外）——够走过「两跳判死」。
    for (let r = 0; r < 4; r++) {
      const at = NOW + r * ROUND_GAP_MS;
      const round = makeDeps({
        domains, ledger, backoff, now: () => at,
        over: { targetKeys: 5, mintBatch: 5 },
        sendCode: () => REWORDED,
      });
      await tendOnce(round.deps);
      ledger = round.io.ledger;
      backoff = round.io.backoff;
      for (const e of round.logger.entries) {
        if (e.event === "registrar.domain_blocked") blockedSeen.push(`r${r}`);
        if (e.event === "registrar.domain_verdicts_discarded") {
          discardedFieldKeys.push(Object.keys(e.fields ?? {}).sort());
        }
        // 上游那句原话逐字出现在哪条事件里。**这就是运维手里真正能拿到的证据**。
        if (JSON.stringify(e.fields ?? {}).includes("Slow down, mate.")) wordingCarriers.push(e.event);
      }
    }

    // ① 横幅从前指向的那条事件，这一支上**全程一条都没有**。
    expect(blockedSeen).toEqual([]);
    // ② 这一支真正发出来的是它，而它的字段里**没有 message 这一栏**（手写字面量）。
    expect(discardedFieldKeys).toEqual([
      ["backoffUntil", "count", "minted"],
      ["backoffUntil", "count", "minted"],
      ["backoffUntil", "count", "minted"],
    ]);
    // ③ 上游原话唯一的落点：台账里已知能用的那两个域名的那条诊断。
    expect(new Set(wordingCarriers)).toEqual(new Set(["registrar.known_good_domain_rejected"]));
    // ④ 前置条件：钳位真的生效了（台账一个字都没学到），否则上面三条量的是别的东西。
    expect(ledger.entries).toEqual({
      "b.test": { s: "ok", at: NOW - 3000, n: 2 },
      "c.test": { s: "ok", at: NOW - 2000, n: 2 },
    });
  });

  /**
   * 🔴🔴 **承重格：只配了一个邮箱域名的部署，上一格那一档必须同样接得住。**
   *
   * 上一格那一档从前的触发条件是「同一轮里 **≥2 个**域名被判屏蔽」（`commitJournal`
   * 那道钳位的 `discarded > 0`）。**只配了一个邮箱域名的部署永远凑不满 2 个**
   * ⇒ 这一档一次都不会命中，而上游改文案那件事对它照样发生。
   *
   * 改动前的实测（同一份夹具、20 轮）：逐轮请求数恒为 5、`minted` 恒为 0、
   * 退避键 20 轮**一次都没写**。Cron 每 30 分钟一轮 ⇒ 稳态 **240 次/天**。
   * 而拆掉那道保险之前（`mintOne` 里「已知好域名回 400 就改判限流」还在的时候），
   * 同一份夹具是 `[1,1,0,1,0,…]` + app 退避 ⇒ 稳态约 **6 次/天** ——
   * 也就是说这种部署形态上，那一档接不住时的请求量是上一版的 **40 倍**。
   *
   * ⚠️ **上一版并不是白得的 6 次/天**：它那 20 轮里台账一个字都没学到
   *（`{s:"ok"}` 原封不动），`registrar.domain_blocked` 一条都没有 —— 也就没有
   * 「上游那句原话」这个唯一的现场证据，而那正是那把死锁的来源。
   *
   * 治它的是触发条件的语义本身：这一档要的是**「这一轮的候选全军覆没」**，
   * 逐字实现成「上游列出来的域名一个不落全试过了、而且全被判成屏蔽」——
   * 单域名下「就那一个，试了、被拒了」同样满足。判据在 `./tender.ts` 的 `finishRound`。
   * ⚠️ **「一个不落全试过」那半句不是修饰**：省掉它，「池子快满、这一轮只开了 1 个名额」
   * 也会记退避 —— 反向控制是本 describe 第一格（连着 6 轮那格逐字断言全程不写退避键）。
   *
   * ⚠️ **这一格钉的是三个数：逐轮请求数、minted、退避那把键的内容**（都是手写字面量）。
   * 20 轮 = 10 小时，够走到指数封顶那一档 —— 稳态是「每 8 轮打一次、每次 5 个请求」，
   * 48 轮/天 ÷ 8 × 5 = **30 次/天**（这就是写进 CHANGELOG 与五语言文档的那个数）。
   *
   * ⚠️ **外加这一档自己那条事件（评审回填）**：`registrar.round_all_domains_rejected`
   * 在全仓只有这里守着 —— 它被加出来的理由正是「单域名下钳位没生效，照
   * `registrar.domain_verdicts_discarded` 的名字发出去就是假话」，所以两条一起断言：
   * 第 0 轮该发的发了、不许发的那条一条都没有。没有它的话整段 `else if` 被删掉都没人发现
   *（实测：补这两行之前把那一整段 `else if` 删干净，注册机那一批判据 402/402 全绿、
   * `tsc --noEmit` 也是 0）。
   *
   * 变异：把 `finishRound` 里 `roundAllRejected` 那一项从触发条件里删掉
   * ⇒ 逐轮请求数变回 5 × 20、退避恒为 null ⇒ 红。
   */
  it("只配了一个邮箱域名 + 上游换了限流措辞：退避照样记得下来，请求量被按住", async () => {
    const REWORDED = { status: 400, body: '{"code":400,"message":"Slow down, mate."}' };
    let ledger: DomainLedger = { v: 1, updatedAt: NOW - 1, total: 1, entries: {
      "b.test": { s: "ok", at: NOW - 3000, n: 2 },
    } };
    let backoff: BackoffState | null = null;
    const perRound: number[] = [];
    const mintedPerRound: number[] = [];
    /** 第 0 轮那把事件名。**这一档新加的那条事件在全仓只有这里守着。** */
    let round0 = [] as string[];

    for (let r = 0; r < 20; r++) {
      const at = NOW + r * ROUND_GAP_MS;
      const round = makeDeps({
        domains: ["b.test"], ledger, backoff, now: () => at,
        over: { targetKeys: 5, mintBatch: 5 },
        sendCode: () => REWORDED,
      });
      const out = await tendOnce(round.deps);
      perRound.push(round.verification.length);
      mintedPerRound.push(out.minted);
      if (r === 0) round0 = round.logger.events();
      ledger = round.io.ledger;
      backoff = round.io.backoff;
    }

    // 🔴 **手写字面量。** 改动前这里是 5 × 20 = 100 次；现在是 25 次。
    // 打出去的是第 0/1/3/7/15 轮 —— 间隔 1、2、4、8、8 轮，正是指数走到封顶。
    expect(perRound).toEqual([5, 5, 0, 5, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0]);
    // 前置条件：这一档里一把 key 都铸不出来（否则上面那串 0 是「池子满了」造成的）。
    expect(mintedPerRound).toEqual(Array(20).fill(0));
    // 归因是**这一轮的形状**，不是冒充上游说过的话；第 5 次撞算出来的窗口撞上封顶。
    expect(backoff).toEqual({
      until: NOW + 15 * ROUND_GAP_MS + 14_400_000, kind: "cluster", since: NOW, hits: 5,
    });
    // ⚠️ 单域名下钳位（≥2 个才生效）一次都没触发 ⇒ 台账照常学得到那条结论，
    // `registrar.domain_blocked` 也照常带得出上游原话。**这一维一格都没动。**
    expect(ledger.entries["b.test"]?.s).toBe("blocked");
    // 🔴 **这一档自己那条事件**：退避是按「这一轮的候选全军覆没」这个形状记的，
    // 而钳位那条事件的名字说的是「钳位作废了几条结论」—— 单域名下钳位压根没生效，
    // 冒用它的名字就是假话。两条一起断言：该发的发了、不许发的一条都没有。
    expect(round0).toContain("registrar.round_all_domains_rejected");
    expect(round0).not.toContain("registrar.domain_verdicts_discarded");
  });

  /**
   * 🔴 **承重格：两个已知能用的域名同时被拉黑时，钳位不许把补池按到零。**
   *
   * 这一格是上一格（连着 6 轮）留下的洞，**是实测出来的、不是推断**：把保险拆掉之后，
   * `commitJournal` 的「一轮最多学 1 条」钳位会在**同一轮里两个域名都被拒**时
   * 把两条结论整体作废 ⇒ 台账一个字都不变 ⇒ 下一轮排序与这一轮逐字节相同 ⇒
   * 每一轮都把全部名额喂给那两个坏域名。实测那一次：三个名额全打在 `b`/`c` 上、
   * `minted = 0`、台账里两条 `ok` 原封不动，而 `d.test` 一次都没被派出去。
   *
   * 治它的是 `selectDomains` 的第七个实参（`./tender.ts` 的 `rejectedThisRound`）：
   * 本轮被上游当面拒过的域名**跨档**排到全表最后，于是同一轮的下一个名额就落到
   * 第二档的 `d.test` 上。**钳位一格都没动。**
   *
   * 变异：把 `selectDomains` 排序里的 `rejected` 那一项删掉（或不传第七个实参）
   * ⇒ 三个名额全落在 `b`/`c` 上、`minted` 变 0 ⇒ 红。
   */
  it("同一轮里两个已知能用的域名同时被拉黑：结论照旧被钳位作废，但这一轮仍然铸得出 key", async () => {
    const { deps, io, logger, verification } = makeDeps({
      domains: ["b.test", "c.test", "d.test"],
      over: { targetKeys: 3, mintBatch: 3 },
      ledger: { v: 1, updatedAt: NOW - 1, total: 3, entries: {
        "b.test": { s: "ok", at: NOW - 1000, n: 3 },
        "c.test": { s: "ok", at: NOW - 900, n: 3 },
      } },
      sendCode: (email) =>
        (email.endsWith("@b.test") || email.endsWith("@c.test")) ? DOMAIN_400 : OK(),
    });

    const out = await tendOnce(deps);

    // 手写字面量：两个坏域名各吃掉一个名额，第三个名额落到从没试过的 `d.test` 上。
    // 改动之前这里是 ["b.test", "c.test", "b.test"]、`minted` 是 0。
    expect(domainsOf(verification)).toEqual(["b.test", "c.test", "d.test"]);
    expect(out.minted).toBe(1);
    // 钳位照旧生效：两条 blocked 整体作废，台账里那两条 `ok` 一个字都没变。
    expect(logger.has("registrar.domain_verdicts_discarded")).toBe(true);
    expect(io.ledger.entries["b.test"]).toEqual({ s: "ok", at: NOW - 1000, n: 3 });
    expect(io.ledger.entries["c.test"]).toEqual({ s: "ok", at: NOW - 900, n: 3 });
    // 成功那一条照常学下来（钳位只作废 blocked）。
    expect(io.ledger.entries["d.test"]).toEqual({ s: "ok", at: NOW, n: 1 });
    // 🔴 **这一行同时是上一格那个 `cluster` 退避的反向控制**：这一轮 `discarded` 同样
    // > 0，但**铸得出 key** ⇒ 上游明明还在给我们发号，一个退避键都不许写。
    // 变异：把 `finishRound` 里那一档的 `p.minted === 0` 前提删掉 ⇒ 这一行当场红。
    expect(io.savedBackoff).toEqual([]);
  });

  /**
   * ⚠️ **「同一个域名以最后一条观测为准」这句话必须有一格钉着。**
   *
   * `rejectedThisRound` 的折叠口径与 `commitJournal` 的折叠是同一句话（「这一轮这个域名
   * 到底怎么样」两处必须给同一个答案）。**改成「取第一条」时全仓其余判据一格都不红**
   *（实测），所以这一格是它唯一的检测点：一个域名这一轮先被拒、后来又成功过，
   * 之后的名额**不该**再把它让到后面。
   *
   * 夹具：`b` 第一次被拒、之后放行，`c`/`d` 一直被拒。`rand = 0.9` 让洗牌在三个元素上
   * 是恒等置换 ⇒ 未知那一档的档内次序就是 b、c、d。
   * 变异：把折叠改成「取第一条」⇒ 第 5 个名额上 `b` 仍算被拒过、次序落回
   * 「派得少的先上」⇒ 打到 `c`（又是 400）⇒ 铸出数从 2 变 1 ⇒ 红。
   */
  it("同一个域名先被拒、后来又成功：这一轮之后的名额不再把它让到后面", async () => {
    let bHits = 0;
    const { deps, verification } = makeDeps({
      domains: ["b.test", "c.test", "d.test"],
      over: { targetKeys: 5, mintBatch: 5, maxDomainAttempts: 1 },
      ledger: warmLedger(3),
      rand: () => 0.9,
      sendCode: (email) => {
        if (email.endsWith("@b.test")) return ++bHits === 1 ? DOMAIN_400 : OK();
        return DOMAIN_400;
      },
    });

    const out = await tendOnce(deps);

    // 手写字面量：前三个名额各试一个新域名（都被拒），第四个名额上全表都被拒过
    // ⇒ 次序落回四档、`b` 回到队首并这次成功了；第五个名额上 `b` 的最后一条观测是
    // 成功，所以它不再被让到后面 —— 直接又是 `b`。
    expect(domainsOf(verification)).toEqual(["b.test", "c.test", "d.test", "b.test", "b.test"]);
    expect(out.minted).toBe(2);
  });

  /**
   * 🔴 **承重格：不许把「我们自己的判断」伪造成「上游在限你」。**
   *
   * 面板的 `reg.backoff.app` 那条横幅只由**退避键**驱动。从前这个场景里根本没有限流，
   * 却照样记下一个 `kind: "app"` 的退避窗口 ⇒ 面板逐字告诉运维「这个出口地址的注册
   * 额度可能已经到顶，多半只能等，或者换一个出口」，而换出口一点用都没有。
   * 这一格钉的就是**那条假信号在源头上不再产生**；横幅的措辞另有一格，是
   * `tests/unit/i18n-dict.test.ts`「退避横幅那条 app 文案先说清判据归属，再不许把换出口说成唯一出路（五语言各一格）」。
   *
   * ⚠️⚠️ **这一格的断言改过一次，改的理由与它钉的那件事无关，写在这里免得被读成放水**：
   * 夹具是**只配了一个邮箱域名**的部署，而「这一轮把上游列出来的域名一个不落全试过、
   * 还全被判成屏蔽、且零产出」现在会记一个 `cluster` 退避（`./tender.ts` 的 `finishRound`，
   * 全文见那里）。所以这里不再断言「一把退避键都不写」，改成断言**归因**：
   * 写出来的只许是 `cluster`（这一轮的形状），**`app` / `edge` 一条都不许有** ——
   * 那两档才是「上游在限你」，而这一轮上游一个限流字眼都没回。
   * 这一档的横幅逐字说明两种可能都还开着（上游换了限流措辞 / 上游真把域名拉黑了），
   * 与 `app` 那条「上游在限你」不是同一句话。
   *
   * 变异：把那道保险改回「`isKnownGood` ⇒ 当场 return `rate_limited` / `limitKind: "app"`」
   * ⇒ 退避 `kind` 变成 `app`、归因变成 `rate_limited` ⇒ 下面两行各红一次。
   */
  it("好域名被真的拉黑时只按「这一轮的形状」退避：归因是域名，不是「上游在限你」", async () => {
    const { deps, io } = makeDeps({
      domains: ["b.test"],
      ledger: { v: 1, updatedAt: NOW - 1, total: 1, entries: {
        "b.test": { s: "ok", at: NOW - 1000, n: 4 },
      } },
      sendCode: () => DOMAIN_400,
    });

    const out = await tendOnce(deps);

    // 🔴 归因只许是「这一轮的形状」。`app` / `edge` 那两档是「上游回话里的字眼」，
    // 而这一轮上游一个限流字眼都没回 —— 写出那两档就是把一句上游没说的话安上去。
    expect(io.savedBackoff.map((s) => s?.kind ?? null)).toEqual(["cluster"]);
    expect(out.failures).toEqual([{ reason: "domain_blocked_all", channel: "yyds" }]);
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
