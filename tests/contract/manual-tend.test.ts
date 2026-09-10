import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN, TEST_CONFIG } from "../helpers/make-app.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { registrarFromEnv } from "../../src/core/registrar/config.js";
import type { GatewayConfig } from "../../src/core/config.js";
import {
  MANUAL_GUARD_KEY, MANUAL_TENDS_PER_DAY, MANUAL_TEND_COOLDOWN_MS, type ManualGuard,
} from "../../src/core/admin/tend-guard.js";
import {
  TEND_LOCK_KEY, TEND_LOCK_TTL_MANUAL_MS, acquireTendLock, createTendGate,
} from "../../src/http/admin/tend-lock.js";
import type { RegistrarWiring } from "../../src/http/admin/handlers/registrar.js";
import { buildApp } from "../../src/http/wire.js";
import {
  MANUAL_CODE_TIMEOUT_MS, MANUAL_MINT_BATCH, MANUAL_ROUND_BUDGET_MS, SCHEDULED_ROUND_BUDGET_MS,
} from "../../src/core/registrar/types.js";
import { TEND_HISTORY_KEY, type TendRecord } from "../../src/core/admin/tend-history.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

/**
 * `POST /admin/api/registrar/tend` —— 面板「立即补池」的四条护栏（设计 §10.2）。
 *
 * **这是本仓第一条会产生真实上游副作用的写端点**：Key 池那四条只动本地存储，
 * 这一条会去建临时邮箱、注册 Agnes 账号、领 key。一个失效的护栏在这里的后果不是
 * 「数据被改坏」，是**外部服务的配额被花掉，而且收不回来**。
 *
 * ⚠️ **两个夹具，作用不同，别混着用**：
 * · **A（`makeApp` + 注入 `manualTend`）**：执行体可控（手动 resolve / reject），
 *   用来把「上一轮还在跑」这个状态**在断言的那一刻真的做成立**。四条护栏、载体、
 *   锁的释放全在这里验。
 * · **B（`buildApp`，真装配）**：跑的是 `wire.ts` 里那份真的 `runManualTendRound`
 *   与真的 `tendOnce`，**不 mock**（第 7 种假阳性：测的是抄件不是原件）。
 *   `roundBudgetMs` 与 `trigger: "manual"` 这两条只能在这里验。
 */

const NOW = 20_000 * 86_400_000 + 9 * 3_600_000;   // 某天 UTC 上午 9 点
const DAY_END = 20_001 * 86_400_000;

const REGISTRAR_ON = registrarFromEnv({
  REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k", TARGET_KEYS: "1",
}, {}).config;

const withKey = { "x-admin-key": TEST_ADMIN_TOKEN };

type App = Awaited<ReturnType<typeof makeApp>>["app"];

async function post(app: App, headers: Record<string, string> = withKey): Promise<Response> {
  return app.request("/admin/api/registrar/tend", { method: "POST", headers });
}

/**
 * 一个**执行体可控**的手动补池：调用之后挂着不返回，直到用例自己 `release()` /
 * `fail()`。**这是本文件大部分判别力的来源**——补池要真的处于"在跑"的状态，
 * 「上一轮还在跑就不许再起一轮」才有东西可测。
 */
function gatedRun() {
  let release!: () => void;
  let fail!: (e: unknown) => void;
  let started = 0;
  const gate = new Promise<void>((res, rej) => { release = res; fail = rej; });
  return {
    starts: () => started,
    release, fail,
    /** 落定之后再等一个宏任务，好让 `finally` 里那次 `releaseTendLock` 真的跑完。 */
    settled: () => gate.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 5))),
    run: async () => { started++; await gate; },
  };
}

/**
 * 等到注入的执行体**真的起跑**。
 *
 * ⚠️ 端点现在是**跑完整轮再返回**的（那正是这次修复的全部内容），所以本文件里凡是
 * 用 `gatedRun()` 把一轮按住不放的用例，都**不能**先 `await post(...)`——那会死锁。
 * 正确形态是：先拿住 promise、等它起跑、做完并发/锁的断言、再放闸、最后 `await`。
 */
async function started(g: { starts: () => number }, n = 1): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (g.starts() >= n) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("执行体一直没起跑");
}

/** 夹具 A。`registrar` 打开，存储与注入的执行体共用同一个实例。 */
async function fixtureA(o: {
  storage?: MemoryStorage | CountingStorage;
  run?: () => Promise<void>;
  wire?: boolean;
  now?: () => number;
  tendGate?: ReturnType<typeof createTendGate>;
  config?: Partial<GatewayConfig>;
} = {}) {
  const now = o.now ?? (() => NOW);
  const storage = o.storage ?? new MemoryStorage(undefined, now);
  const wiring: RegistrarWiring | undefined = o.wire === false
    ? undefined
    : {
      storage,
      tend: async (..._a) => { await (o.run ?? (async () => {}))(); return ({ kind: "done" as const, result: { skipped: false, available: 0, attempted: 0, minted: 0, mintedByChannel: {}, failures: [], primaryChannel: "moemail", at: 0, durationMs: 0 }, capped: null }); },
      // 本文件一条都不测通道连通性（那是 tests/contract/admin-registrar.test.ts 的活）。
      // **刻意抛错而不是返回一个假的成功**：真有哪条用例误打到这条端点上，红的会是
      // 那条用例，而不是一个悄悄通过的假结果。
      probeChannel: async () => { throw new Error("本文件的夹具不接通道连通性测试"); },
    };
  const h = await makeApp(
    [], [], { registrar: REGISTRAR_ON, ...o.config }, now,
    { storage, registrar: wiring, tendGate: o.tendGate },
  );
  return { ...h, storage };
}

const guardOf = (s: MemoryStorage | CountingStorage) => s.get<ManualGuard>(MANUAL_GUARD_KEY);

// ───────────────────────────────────────────────────────────────────────────
// 护栏 1a / 1b：两把锁，作用域不同
// ───────────────────────────────────────────────────────────────────────────

describe("护栏 1：两个副本 / 两个并发请求，只有一个真的跑起来", () => {
  /**
   * **设计文档点名要求的那一条测试（§10.2 第 1 条）。**
   *
   * 防住的真实故障：Node 侧此前**只有进程内的 `inFlight`**，而 Docker 多副本共卷
   *（同一个 `DATA_DIR` 挂给两个容器）下它形同虚设——两个副本各有各的布尔，
   * 两轮补池同时跑，同时撞邮箱服务的建号限流与上游的注册风控。
   * 「顺序铸、不并发」是功能性约束，不是性能取舍。
   *
   * **两个 app 各自有自己的 `TendGate`**（`createApp` 默认每个 app 一把），
   * 所以这一格唯一能拦住第二个请求的东西就是**存储锁**。
   * **变红条件**：把 handler 里的 `acquireTendLock` 整个去掉（只剩进程内守卫）。
   *
   * ⚠️ **时钟要跨过那 10 分钟冷却，这一步不能省，而且它不是"绕开护栏"**：
   * 冷却与锁是**两条不同的护栏**，冷却期内第二次点击本来就该被冷却拦下（429），
   * 那时锁根本轮不到出手 ⇒ 这一格会变成在测冷却，**对「锁存不存在」完全无感**
   *（第 5 种假阳性：覆盖的状态让被测的选择不可观测）。
   * **而「冷却过了、上一轮还在跑」这个窗口是真实存在的**：单轮墙钟预算是
   * `SCHEDULED_ROUND_BUDGET_MS` = 13 分钟，比 10 分钟的冷却长——**那正是存储锁唯一
   * 无可替代的那段时间**。
   *
   * ⚠️ **替身存储带 `delayMs`**（第 8 种候选形态）：零延迟的替身让任何
   * happens-before 性质都不可观测。**但这一格的判别力其实来自「第一轮真的还挂着」，
   * 不来自存储时序**——把 `delayMs` 改回 0 这一格**不会红**，那是刻意的对照实验，
   * 实测结果写进了任务报告。
   */
  it("上一轮（Cron）还持着锁时，手动点击拿到 409 locked 且执行体一次都不跑", async () => {
    const storage = new MemoryStorage(1, () => NOW);
    const g = gatedRun();
    const a = await fixtureA({ storage, run: g.run, now: () => NOW });

    // 🔴 **场景换了，不是把旧用例调绿。** 旧用例让「第一个副本的手动轮」持锁到冷却
    // 之后再点第二次，靠的是「单轮预算 13 分钟 > 冷却 10 分钟」。手动那份 TTL 改成
    // 180 秒之后**那个场景在结构上不存在了**（180 秒 < 600 秒冷却）——而那正是这次
    // 修复要的效果：一次被砍断的点击不再能挡住后面的补池。
    // 于是这一格改成钉**今天真实存在**的那个重叠：Cron 轮持着 15 分钟的锁。
    await storage.put(TEND_LOCK_KEY, { until: NOW + 900_000 });

    const res = await post(a.app);
    expect(res.status, "上一轮还持着锁，这一次必须被拦下").toBe(409);
    expect(await res.json()).toMatchObject({ reason: "locked", until: NOW + 900_000 });
    // **两半都要断言**：只看状态码抓不住「409 之后又偷偷跑了一轮」。
    expect(g.starts(), "被 409 拦下之后一次都不许跑").toBe(0);
  });

  /**
   * **手动那份锁 TTL 必须短于手动冷却。**
   *
   * 这条不是风格问题，是那次事故的第二半：手动轮被平台砍断时 `releaseTendLock` 不跑，
   * 锁只能等自然过期。TTL 取 Cron 那份 15 分钟时，**一次点击必然挡掉至少一轮 Cron**
   *（线上实测发生过两次，日志里留着两条「上一轮补池仍在进行，跳过本次 Cron 触发」）。
   * 短于冷却之后，最坏情况下那把泄漏的锁在下一次可点之前就已经自己过期了。
   *
   * **变红条件**：把 `TEND_LOCK_TTL_MANUAL_MS` 改回 `SCHEDULED_ROUND_WALL_CLOCK_MS`。
   */
  it("手动锁的 TTL 必须短于手动冷却 —— 泄漏的锁不许活到下一次可点", () => {
    expect(TEND_LOCK_TTL_MANUAL_MS).toBe(180_000);
    expect(
      TEND_LOCK_TTL_MANUAL_MS < MANUAL_TEND_COOLDOWN_MS,
      "一把泄漏的手动锁活得比冷却还久 ⇒ 它必然挡掉中间的 Cron 轮",
    ).toBe(true);
  });

  /**
   * **同一个副本上的两个并发请求：靠的是另一把锁。**
   *
   * 上一格两个 app 各有各的 `TendGate`，所以它证明不了这一条；而存储锁在这里
   * **拦不住**——`acquireTendLock` 是 `get` → 检查 → `put` 三步，两个同 tick 的请求
   * 会在那个窗口里双双拿到 `ok: true`（下面「诚实限定」那一格把它直接钉住）。
   * **能拦住的只有同步获取的进程内守卫。**
   * **变红条件**：把 handler 里的 `deps.gate.tryEnter()` 去掉；
   * 或把它改成「先问一句 `busy()` 再去 `run()`」——那样检查与占用之间就有 `await` 了。
   */
  it("同一个副本上两个并发请求：只有一个真跑（进程内守卫，存储锁在这里拦不住）", async () => {
    const g = gatedRun();
    const a = await fixtureA({ storage: new MemoryStorage(1, () => NOW), run: g.run });

    const q1 = post(a.app);
    const q2 = post(a.app);
    // 被守卫拦下的那一个**立刻**返回；跑起来的那一个要等放闸。
    await started(g);
    g.release();
    const [r1, r2] = await Promise.all([q1, q2]);
    const codes = [r1.status, r2.status].sort();
    expect(codes, "两个并发请求必须一个 200 一个 409").toEqual([200, 409]);
    const rejected = r1.status === 409 ? r1 : r2;
    expect(await rejected.json()).toMatchObject({ reason: "tend_in_flight" });
    expect(g.starts(), "补池只许起一轮").toBe(1);

    await g.settled();
  });

  /**
   * ⚠️ **诚实限定：这把存储锁不是互斥原语，别把上面两格读成「并发已解决」。**
   *
   * KV 是最终一致的，`acquireTendLock` 是读改写：`get` 与 `put` 之间有一个真实窗口，
   * 同一时刻发起的两次抢锁**都会成功**。这一格把那个窗口直接钉成一条断言，
   * 免得日后有人在文档或注释里把它写成「并发已解决」。
   *
   * 它挡的是「上一轮明明还在跑」这种最常见的重叠（上面第一格），不是纳秒级竞态。
   */
  it("【诚实限定】同一 tick 的两次抢锁都会成功 —— 存储锁是尽力而为，不是互斥原语", async () => {
    const storage = new MemoryStorage(1, () => NOW);
    const [x, y] = await Promise.all([
      acquireTendLock(storage, NOW, TEND_LOCK_TTL_MANUAL_MS),
      acquireTendLock(storage, NOW, TEND_LOCK_TTL_MANUAL_MS),
    ]);
    expect([x.ok, y.ok], "两个都抢到了 —— 这正是那个 get→put 窗口").toEqual([true, true]);
  });

  /**
   * **锁必须在 `finally` 里释放。**
   * **变红条件**：把 `releaseTendLock` 从 `finally` 挪进 `try` 的末尾
   * ——一次抛错的补池会让锁留到自然过期（最长 15 分钟）才肯放下一轮进来，
   * 也就是**一次失败换一段停摆**。
   */
  it("补池抛错时锁仍然被释放，且失败留下一条事件（这一轮的结局现在同步交回给面板了）", async () => {
    let t = NOW;
    const storage = new MemoryStorage(undefined, () => t);
    const g = gatedRun();
    const a = await fixtureA({ storage, run: g.run, now: () => t });

    const p1 = post(a.app);
    await started(g);
    g.fail(new Error("补池在中途炸了"));
    expect((await p1).status).toBe(200);
    await g.settled();

    expect(await storage.get(TEND_LOCK_KEY), "抛错那一轮把锁留在了存储里").toBeNull();
    const e = a.logger.entries.find((x) => x.event === "registrar.manual_tend_failed");
    expect(e?.level).toBe("error");
    expect(String(e?.fields?.error)).toContain("补池在中途炸了");

    // 反向自检：锁真的没了 ⇒ 冷却过去之后能再点（不是靠等 15 分钟自然过期）。
    t += MANUAL_TEND_COOLDOWN_MS;
    expect((await post(a.app)).status, "锁没释放的话这里会是 409").toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 护栏 2 / 4：冷却 + 每日写预算闸
// ───────────────────────────────────────────────────────────────────────────

describe("护栏 2 与 4：手动冷却 + 每日写预算闸（评审那条护栏的读法 B）", () => {
  /**
   * ⚠️⚠️ **本任务最重要的一格。**
   *
   * 它是唯一能把评审那两种读法区分开的判据：
   * · **读法 A（失效）**：冷却与预算共用一把键、`expiresAt` 跟着冷却走 ⇒
   *   这把键每 10 分钟蒸发一次 ⇒ `used` 随之归零 ⇒ **日预算闸永远走不到耗尽**。
   * · **读法 B（本仓采用）**：`{ day, used, cooldownUntil }`，**一律不传 `expiresAt`**，
   *   跨天靠 `day` 的值比较、冷却靠 `cooldownUntil` 的值比较，互不借用。
   *
   * **变红条件**：给 `registrar_manual_guard` 加一个跟着 `cooldownUntil` 走的
   * `expiresAt` —— 第二次点之前那把键已经蒸发 ⇒ `used` 读回 0 ⇒ 写回 1 ⇒ 这里变红。
   * 第一版计划给的三条判据对这条变异**全部无感**，所以它们被作废了。
   */
  it("点一次 → 等 11 分钟（假时钟）→ 再点：used 必须是 2 不是 1", async () => {
    let t = NOW;
    const storage = new MemoryStorage(undefined, () => t);
    const a = await fixtureA({ storage, now: () => t });

    expect((await post(a.app)).status).toBe(200);
    expect((await guardOf(storage))?.used, "前置条件：第一次点之后是 1").toBe(1);

    t += 11 * 60_000;
    expect((await post(a.app)).status, "11 分钟 > 10 分钟冷却，该放行").toBe(200);
    expect(
      (await guardOf(storage))?.used,
      "护栏键在两次点击之间蒸发了 ⇒ 日预算闸永远走不到耗尽",
    ).toBe(2);
  });

  /**
   * **两个方向同一格，是刻意的**：只测"会归零"或只测"不会归零"都能被另一种错误实现
   * 满足（第 5 种假阳性：覆盖的状态让被测的选择不可观测）。
   *
   * **变红条件**：① 去掉 `day` 判定（则永不归零，后半红）；
   * ② 把 `expiresAt` 跟着冷却走（则 11 分钟就归零，前半红）。
   */
  it("跨过当日 24:00 之后 used 归零，而 11 分钟不会", async () => {
    let t = NOW;
    const storage = new MemoryStorage(undefined, () => t);
    const a = await fixtureA({ storage, now: () => t });

    expect((await post(a.app)).status).toBe(200);
    t += 11 * 60_000;
    expect((await post(a.app)).status).toBe(200);
    expect((await guardOf(storage))?.used, "11 分钟不归零").toBe(2);

    t = DAY_END + 60_000;                       // 跨过当日 24:00
    expect((await post(a.app)).status).toBe(200);
    const g = await guardOf(storage);
    expect(g?.used, "新的一天从 1 重新数").toBe(1);
    expect(g?.day, "写回去的是新那一天的序号").toBe(20_001);
  });

  /**
   * **预算耗尽 ⇒ 429，且响应体里给得出 `resetAt`。**
   * 只回一个 429 而不说"什么时候恢复"，运维只能靠猜或者一直点。
   */
  it("用满当天额度之后 429 write_budget_exhausted，并说清楚什么时候恢复", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    await storage.put(MANUAL_GUARD_KEY, { day: 20_000, used: MANUAL_TENDS_PER_DAY, cooldownUntil: 0 });
    const g = gatedRun();
    const a = await fixtureA({ storage, run: g.run });

    const res = await post(a.app);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      reason: "write_budget_exhausted", remaining: 0, resetAt: DAY_END,
    });
    expect(g.starts(), "被闸门拦下的那次一轮都不许跑").toBe(0);
    expect(await storage.get(TEND_LOCK_KEY), "被拦下时连锁都不该抢").toBeNull();
  });

  it("冷却期内 429 manual_cooldown，且与预算耗尽是两个不同的 reason", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    await storage.put(MANUAL_GUARD_KEY, { day: 20_000, used: 1, cooldownUntil: NOW + 60_000 });
    const a = await fixtureA({ storage });

    const res = await post(a.app);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      reason: "manual_cooldown", retryAfterMs: 60_000, remaining: MANUAL_TENDS_PER_DAY - 1,
      // **绝对时刻与相对时长成对给**（评审 m3）：只给相对量的话，面板要显示
      // 「几点恢复」就只能拿**客户端本地时钟**去加，时钟有偏差时两条路会给出
      // 两个不一致的倒计时。
      cooldownUntil: NOW + 60_000,
    });
  });

  /**
   * **面板要如实显示还剩几次，不是等到耗尽才说。**
   * **变红条件（第一版三条判据里仍然有效的第 ④ 条）**：只在 429 那一支给 `remaining`。
   */
  it("响应体里就带着「今天还剩几次」与冷却到期时刻", async () => {
    const a = await fixtureA();
    const res = await post(a.app);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      started: true,
      trigger: "manual",
      remaining: MANUAL_TENDS_PER_DAY - 1,
      resetAt: DAY_END,
      cooldownUntil: NOW + MANUAL_TEND_COOLDOWN_MS,
      // 成对给（评审 m3）：面板拿相对量做倒计时、拿绝对时刻显示「几点恢复」。
      retryAfterMs: 600_000,
    });
  });

  /**
   * ⚠️ **预算必须落在存储里，不是实例字段**（计划里那两条是同一个错）。
   *
   * 手动补池是人驱动的、可能打到任意 isolate。计数做成实例字段的话，
   * **每一个新 isolate 都带着一份全新的预算** ⇒ 那道闸既拦不住什么也不构成上界，
   * （这句话原来的另一半说的是 Worker 上 isolate 逐请求随机新建/回收，那个形态没了）。
   * **变红条件**：把 `used` 搬进 handler 闭包 / app 实例字段。
   */
  it("两个 app 实例不许各拿一份新预算 —— 计数在存储里，不在实例上", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    await storage.put(MANUAL_GUARD_KEY, { day: 20_000, used: MANUAL_TENDS_PER_DAY, cooldownUntil: 0 });
    const a = await fixtureA({ storage });
    const b = await fixtureA({ storage });   // 第二个"isolate"

    expect((await post(a.app)).status).toBe(429);
    expect((await post(b.app)).status, "换一个实例就绕过了日预算闸").toBe(429);
  });

  /**
   * **抢锁失败那一支一次写都不产生。**
   *
   * 反过来（先消费护栏再抢锁）的话，一次抢锁失败会白白吃掉一格日预算 + 起算一次
   * 10 分钟冷却——**明明什么都没跑，按钮却被锁住十分钟**。
   * **变红条件**：把 `storage.put(MANUAL_GUARD_KEY, …)` 挪到 `acquireTendLock` 之前。
   */
  it("被别的副本抢了锁时，护栏一格都不消费（不许「什么都没跑却锁十分钟」）", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    await storage.put(TEND_LOCK_KEY, { until: NOW + 60_000 });   // 别人正持着锁
    const st = new CountingStorage(storage);
    const a = await fixtureA({ storage: st });

    const before = { puts: st.puts, deletes: st.deletes };
    expect((await post(a.app)).status).toBe(409);
    expect({ puts: st.puts, deletes: st.deletes }, "抢锁失败却写了盘").toEqual(before);
    expect(await guardOf(st), "冷却被起算了 ⇒ 按钮白白锁十分钟").toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 载体：整轮由端点自己 await 到底
//
// ⚠️ **这一节原来是两格，标题是「两种运行时的差异必须是被断言的」（硬约束 1）：**
// 一格钉「Worker 侧必须把整轮交给 `ctx.waitUntil`」，一格是它的镜像
// 「Node 侧连看都不看 `ctx`」。**v0.4.0 摘掉 Worker 形态之后，被对照的那一侧没了**，
// `runtime.background` 与 `backgroundCtx()` 一起从源码里删掉了。
//
// **两格并成一格，判别力逐条交代**：
// · 「响应必须等整轮跑完才返回」——**整条修复的承重断言，原样保留**（下面第一半）。
//   它与运行时无关：变红条件仍是把 handler 里那行 `await task;` 删掉。
// · 「不许再挂任何后台载体」——**保留**（下面第二半），但它今天钉的**不是**对等，
//   而是「别再把那个空操作加回来」：Node 是长寿进程，`task` 一经创建就跑到底，
//   再挂一次 `ctx.waitUntil` 是一次不做任何事的调用，只会让人以为还有一层保护。
// · 「Worker 侧必须挂 waitUntil」——**删**，被断言的那个对象不存在了。
// ───────────────────────────────────────────────────────────────────────────

describe("整轮由端点自己 await 到底", () => {
  /**
   * 🔴 **这一格就是整条修复。** 从前端点起跑之后立刻回 202，整轮的载体只有
   * `ctx.waitUntil`，而平台在响应后约 30 秒把它取消掉（实测 3/3）；取消不抛异常，
   * 于是锁不放、历史不写、面板上与「压根没点过」逐字节不可区分。
   * **变红条件**：把 handler 里那行 `await task;` 删掉。
   *
   * 第二半（`waited.length === 0`）：**即使调用方递一个带 `waitUntil` 的 ctx 进来，
   * handler 也一格都不许碰它。** 见本节顶部那段——它防的是「把那个空操作加回来」。
   */
  it("响应等整轮跑完才返回；即使递一个带 waitUntil 的 ctx 进来也一格都不碰", async () => {
    const g = gatedRun();
    const a = await fixtureA({ run: g.run });
    const waited: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); } };

    const p = a.app.request(
      "/admin/api/registrar/tend",
      { method: "POST", headers: withKey },
      undefined,
      // 第三个参数是 Hono 的 executionCtx。平台形态砍掉之后本仓没有任何生产路径
      // 会填它，所以这里就地造一个结构等价物 —— 断言的就是 handler 一格都不碰它。
      ctx as unknown as Parameters<typeof a.app.request>[3],
    );
    await started(g);

    let responded = false;
    void Promise.resolve(p).then(() => { responded = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(responded, "整轮还没跑完端点就返回了 —— 那正是被平台砍断的那个缺陷").toBe(false);

    g.release();
    const res = await p;
    expect(res.status).toBe(200);
    expect(g.starts()).toBe(1);
    expect(waited.length, "handler 又挂了一层后台载体 —— 那是一次不做任何事的调用").toBe(0);
    await g.settled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 鉴权与两种"不能跑"的状态
// ───────────────────────────────────────────────────────────────────────────

describe("鉴权与不可用状态", () => {
  /**
   * **鉴权失效的这一条不是泄露数据、也不是销毁数据，是替你花掉外部服务的配额。**
   * 只断言 401 抓不住「先跑了再返回 401」，所以判据是**存储计数逐字段相等 + 执行体
   * 一次都没被调用**。
   *
   * ⚠️ **夹具刻意用「鉴权若不存在就一定会成功」的请求**：注册机是开着的、执行体接好了、
   * 护栏干净——鉴权失效时它会真的跑起来并写下三把键。反向自检在最后一行。
   */
  it("鉴权失败的『立即补池』必须零副作用 —— 只断言 401 抓不住『先跑了再返回 401』", async () => {
    const st = new CountingStorage(new MemoryStorage(undefined, () => NOW));
    const g = gatedRun();
    const a = await fixtureA({ storage: st, run: g.run });

    const before = { puts: st.puts, deletes: st.deletes };
    for (const headers of [{}, { "x-admin-key": "wrong" }, { authorization: `Bearer ${TEST_CONFIG.gatewayToken}` }]) {
      const res = await post(a.app, headers as Record<string, string>);
      expect(res.status, `凭据 ${JSON.stringify(headers)}：必须 401`).toBe(401);
    }
    expect({ puts: st.puts, deletes: st.deletes }, "鉴权失败了，但存储被动过").toEqual(before);
    expect(g.starts(), "鉴权失败了，但补池已经跑起来了").toBe(0);

    // 反向自检：带上口令**真的会跑**——否则上面那两个 0 什么都没证明。
    const p1 = post(a.app);
    await started(g);
    g.release();
    expect((await p1).status).toBe(200);
    expect(g.starts()).toBe(1);
    expect(st.puts, "带对口令的那次一次盘都没落").toBeGreaterThan(before.puts);
    await g.settled();
  });

  /**
   * **注册机关着时一次写都不产生**——配额账里那根轴（「一切都以 `registrar.enabled`
   * 为轴分两栏」）在这条端点上的对应物：默认部署下本任务新增的写是 **0**，不是"少几次"。
   *
   * 而且必须是 **409 + 一个机器可读的 `reason`**，不是 202：回 202 就是面板显示
   * 「已开始」而实际什么都不会发生。
   */
  it("注册机关着：409 registrar_disabled，且一把键都不写", async () => {
    const st = new CountingStorage(new MemoryStorage(undefined, () => NOW));
    const g = gatedRun();
    const a = await fixtureA({ storage: st, run: g.run, config: { registrar: TEST_CONFIG.registrar } });

    const before = { puts: st.puts, gets: st.gets, deletes: st.deletes };
    const res = await post(a.app);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "registrar_disabled" });
    expect({ puts: st.puts, gets: st.gets, deletes: st.deletes }, "注册机关着却碰了存储").toEqual(before);
    expect(g.starts()).toBe(0);
  });

  /**
   * **没接执行体时如实回 503，不假装 202。**
   *
   * 这条只有"直接调 `createApp` 而不经 `wire.ts`"的装配才走得到（生产两个入口都经
   * `buildApp`）。做成 202 的话面板会显示「已开始」而实际什么都不会发生，
   * 那正是本仓反复裁过的「面板说保存成功、其实没落盘」的同一形状。
   */
  it("app 没接手动补池执行体：503 not_wired + 一条 error 事件，绝不假装 202", async () => {
    const a = await fixtureA({ wire: false });
    const res = await post(a.app);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "not_wired" });
    expect(a.logger.entries.find((x) => x.event === "registrar.manual_tend_not_wired")?.level)
      .toBe("error");
  });

  it("成功那一次在事件板块里留一条痕迹 —— 运维要看得出「池子为什么变了」", async () => {
    const a = await fixtureA();
    expect((await post(a.app)).status).toBe(200);
    const e = a.logger.entries.find((x) => x.event === "registrar.manual_tend_started");
    expect(e?.level).toBe("info");
    expect(e?.fields?.remaining).toBe(MANUAL_TENDS_PER_DAY - 1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 夹具 B：真装配、真 tendOnce（不 mock）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **这一组跑的是 `wire.ts` 里那份真的 `runManualTendRound` 与真的 `tendOnce`。**
 *
 * 夹具挑的是 `registrar.round_budget_impossible` 这条路径（照抄
 * `tests/unit/registrar/scheduling-wiring.test.ts` 的同一个做法）：`CODE_TIMEOUT_MS` 调到比
 * `SCHEDULED_ROUND_BUDGET_MS` 还大 ⇒ `tendOnce` 判定「单次最坏耗时装不下本轮预算」，
 * **一次尝试都不开始**就打一条 error 事件并返回 ⇒ 零网络、毫秒级返回。
 *
 * ⚠️ **这一组原来要注入 `workerRuntime()` 并自备一个 `ctx.waitUntil` 数组**，
 * 好让用例 `await` 完后台任务再断言存储。**v0.4.0 之后端点自己 `await` 整轮再返回**
 *（见本文件「整轮由端点自己 await 到底」那一节），`await app.request(...)` 返回时
 * 该写的已经全写完 —— 夹具因此少了一整层，而「不依赖任何『等一会儿』」原样保住。
 */
describe("真装配：手动补池的 roundBudgetMs 与补池历史", () => {
  async function realApp(extra: Record<string, string> = {}) {
    const storage = new MemoryStorage();
    const env: Record<string, string | undefined> = {
      GATEWAY_TOKEN: "gateway-token-for-manual-tend-fixture",
      ADMIN_TOKEN: TEST_ADMIN_TOKEN,
      REGISTRAR_ENABLED: "true",
      REGISTRAR_PRIMARY: "yyds",
      YYDS_API_KEY: "k",
      TARGET_KEYS: "1",
      // 刻意配一个**远大于手动上限**的值：这一轮会被 `Math.min` 压回
      // `MANUAL_CODE_TIMEOUT_MS`，而「压了没说」正是下面那一格要钉的东西。
      CODE_TIMEOUT_MS: String(SCHEDULED_ROUND_BUDGET_MS + 1),
      MINT_BATCH: "5",
      // ⚠️ **第二道保险，不是装饰**：本夹具"零网络"的第一道保险是生产代码真的传了
      // `roundBudgetMs`（`tendOnce` 一次尝试都不开始）。**变异把那一行删掉之后，
      // 这条用例当场打了 YYDS 的线上接口**（拿到真实域名与 HTTP 403/429）——
      // 也就是说第一道保险成立与否取决于被测代码本身。把 baseUrl 指到保留 TLD
      // `.invalid`（RFC 6761，永不解析），即使那道保险失效也只会 DNS 失败，
      // 不会触达任何真实服务。
      YYDS_BASE_URL: "https://yyds.invalid",

      ...extra,
    };
    const { app } = await buildApp(env, storage);
    const res = await app.request(
      "/admin/api/registrar/tend",
      { method: "POST", headers: withKey },
    );
    return { res, storage };
  }

  /** 存储里所有 `event:` 分片里的全部条目。 */
  async function storedEvents(storage: MemoryStorage) {
    const keys = await storage.list("event:");
    const out: Array<{ event: string; level: string; fields?: Record<string, unknown> }> = [];
    for (const k of keys) {
      const shard = await storage.get<unknown>(k);
      if (Array.isArray(shard)) out.push(...shard as typeof out);
    }
    return out;
  }

  /**
   * ⚠️⚠️ **手动补池必须传 `roundBudgetMs`，而且要与 Cron 那一份逐字相同。**
   *
   * 不传的话：点一次「立即补池」，铸到第三把时进程被硬杀，`mintOne` 的
   * `finally` 不跑，**两个临时邮箱留在上游**；点几次占满活跃邮箱名额 ⇒ 注册机
   * 彻底铸不出 key，而面板上没有任何东西会说明原因。
   *
   * **观测点是那条 error 事件里的 `roundBudgetMs` 字段**，于是两条变异各自都拦得住：
   * · **不传** ⇒ `tendOnce` 根本不做预算判断 ⇒ 这条事件不会出现 ⇒ 红；
   * · **传另一个值** ⇒ 字段值对不上那个手写字面量 ⇒ 红。
   *
   * ⚠️ **期望值写手写字面量 `780_000`，不写 `SCHEDULED_ROUND_BUDGET_MS`**：从被测对象
   * 推导出来的期望值恒等于实际值，那样「两边一起改」就绕过去了。
   * 下面第二条断言把那个常量本身也钉成同一个字面量 —— Cron 路径用的正是它。
   */
  /**
   * ⚠️⚠️ **手动补池用的是 `MANUAL_*` 那一族，与 Cron 那份 780_000 必须不是同一个数。**
   *
   * 上一版这一格的标题逐字是「与 Cron 那一份**逐字相同**（780_000 手写字面量锚）」，
   * 也就是说**这条判据当时把那个缺陷本身钉成了契约**——它每一次都绿，而线上
   * 每一次点击都被平台在约 30 秒处砍断（实测 3/3，日志原话见
   * `src/core/registrar/types.ts` 的 `MANUAL_MINT_BATCH`）。判据钉错了对象时，
   * 绿色恰恰是它最危险的样子。
   *
   * **观测点换成 `registrar.manual_round_capped` 事件**（旧那条
   * `round_budget_impossible` 在手动这一轮上打不出来：三格压顶之后
   * `worstAttemptMs` 恒 = 60 秒 < 70 秒预算，这正是压顶的目的之一）。
   *
   * ⚠️⚠️ **上一版这段括号里写的是「已经不可能触发了」，那句话当时是假的。**
   * 预算判据是 `elapsedMs + delayMs + worstAttemptMs > roundBudgetMs`，而 `elapsedMs`
   * 当时从**整轮开头**算起 ⇒ 留给准备阶段的只有 10 秒，而准备阶段里的
   * `provider.listDomains()` 单请求就允许 `REGISTRAR_REQUEST_TIMEOUT_MS`（15 秒）
   * ⇒ 上游邮箱服务挂起一次，那条 error 就会打出来、按钮诚实空转，
   * 还甩锅给一个手动轮根本不看的 `CODE_TIMEOUT_MS`。
   * 括号里那句话**现在**才成立：`src/core/registrar/tender.ts` 已经把预算判据的起点
   * 挪到准备阶段之后（全文在那里 `roundStartedAt` 的上方），判据因此退化成
   * 纯配置量 `worstAttemptMs > roundBudgetMs`。**正面钉住它的是**
   * `tests/unit/registrar/tender.test.ts` 的
   *「准备阶段（列域名）慢了 15 秒时，手动那一轮照样开得起来 —— 不许诚实空转、更不许甩锅给 CODE_TIMEOUT_MS」
   * ——这一格自己不测那件事，别把这段散文当成判据。
   *
   * 三条变异各自拦得住：
   * · **不压顶**（`Math.min` 那三行删掉）⇒ 这条事件不出现 ⇒ 红；
   * · **压顶了但不说**（只删打事件那一段）⇒ 同上 ⇒ 红；
   * · **手动预算改回 780_000** ⇒ 最后那条「两族不许相等」的断言 ⇒ 红。
   *
   * ⚠️ 期望值一律写手写字面量，不写常量本身：从被测对象推导出来的期望值恒等于
   * 实际值，那样「两边一起改」就绕过去了。
   */
  it("手动补池用自己那一族预算，且把设置里更大的值压顶后如实说出来", async () => {
    const { res, storage } = await realApp();
    // 202「已受理」→ 200「跑完了」：这一轮的结果现在是同步交出来的。
    expect(res.status, "手动补池现在必须跑完再返回").toBe(200);
    const body = await res.json() as { outcome?: { kind?: string } };
    expect(body.outcome?.kind, "响应体里必须带上这一轮的真实结局").toBeDefined();

    // ⚠️ **观测点是响应体，不是事件。** 压顶每一次点击都会发生（默认 mintBatch 5 > 1），
    // 做成事件就是每点一次多一次 put ⇒ 打破「健康的一轮零写」，而那条性质正是
    // 五语言 DEPLOY.md 配额账（一次成功点击恰好 3 次 put）的立身之本。
    const capped = (body as { outcome?: { capped?: Record<string, unknown> | null } }).outcome?.capped;
    expect(capped, "设置里的值被压小了却没说 —— 面板说 A 实际做 B").toBeTruthy();
    expect(capped?.budgetMs, "手动那一份预算漂了").toBe(70_000);
    expect(capped?.codeTimeoutMs, "等码超时没被压到手动上限").toBe(60_000);
    expect(capped?.mintBatch, "手动一轮最多铸 1 把").toBe(1);
    expect(capped?.configuredMintBatch, "被压之前的值要如实报出来").toBe(5);

    // 🔴 整条修复的立身之本：两族**不许**再相等。
    expect(
      Number(MANUAL_ROUND_BUDGET_MS),
      "手动与 Cron 共用一份预算 —— 那正是被平台砍断的那个缺陷",
    ).not.toBe(Number(SCHEDULED_ROUND_BUDGET_MS));
    expect(MANUAL_ROUND_BUDGET_MS).toBe(70_000);
    expect(MANUAL_CODE_TIMEOUT_MS).toBe(60_000);
    expect(MANUAL_MINT_BATCH).toBe(1);
    expect(SCHEDULED_ROUND_BUDGET_MS, "Cron 那一份不该被这次改动碰到").toBe(780_000);
  });

  /**
   * **补池历史里这一行必须标成 `manual`。**
   * 分不清是自动补的还是有人点的，运维看到池子突然多了两把 key 时就只能猜。
   * **变红条件**：`recordRound(r, "manual")` 写成 `"cron"`。
   */
  it("跑完之后 tend:history 里多一条 trigger=manual 的记录", async () => {
    const { storage } = await realApp();
    const history = await storage.get<TendRecord[]>(TEND_HISTORY_KEY);
    expect(history?.length).toBe(1);
    expect(history?.[0]?.trigger).toBe("manual");
    expect(history?.[0]?.skipped, "`skipped` 有且只有一个含义（注册机关着）").toBe(false);
    expect(history?.[0]?.primaryChannel).toBe("yyds");
  });

  /**
   * **红线 1：面板这条路上不许出现 `list()`。**
   * 这里数的是**整条真实路径**（鉴权 → 护栏 → 抢锁 → 真 `tendOnce` → 写历史 → 落盘）。
   */
  it("整条真实路径零 list —— 红线 1（面板路径不许碰 list 那个每天 1,000 次的桶）", async () => {
    const inner = new MemoryStorage();
    const st = new CountingStorage(inner);
    // **池子里先放一把 key**：空池 + 无索引时 `repo.all()` 会回落到一次 `list("key:")`
    // （`pool.index_bootstrapped`），那是**空池兜底**这条既有路径，不是手动补池带来的。
    // 不先建好索引的话这一格量到的 1 次 list 属于夹具，不属于被测路径。
    const seed = new KeyPoolRepo(st, { now: () => Date.now(), logger: NULL_LOGGER, cacheTtlMs: 0 });
    await seed.add("sk-manual-tend-seed-key-aa");
    const env: Record<string, string | undefined> = {
      GATEWAY_TOKEN: "gateway-token-for-manual-tend-fixture",
      ADMIN_TOKEN: TEST_ADMIN_TOKEN,
      REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k",
      // 目标 2、池里 1 ⇒ 缺口 1 ⇒ 真的走进补池循环（而不是 `need <= 0` 提前返回）。
      TARGET_KEYS: "2", CODE_TIMEOUT_MS: String(SCHEDULED_ROUND_BUDGET_MS + 1),
      // 零网络的第二道保险，理由见 `realApp()` 里同名字段那一段。
      YYDS_BASE_URL: "https://yyds.invalid",
    };
    const { app } = await buildApp(env, st);
    st.lists = 0;
    await app.request("/admin/api/registrar/tend", { method: "POST", headers: withKey });
    expect(st.lists, "手动补池这条路上出现了 list()").toBe(0);
  });

  /**
   * ⚠️⚠️ **五语言 DEPLOY.md 里「点一次立即补池 = 固定 3 次 put + 1 次 delete」那个数字的锚
   *（评审发现）。**
   *
   * 在这一格之前，**全仓没有任何一格数过一次成功手动补池的 put**：
   * `manual-tend.test.ts` 里三格数的都是被拒绝的路径（都该是 0），唯一跑成功路径的那格
   * 是 `toBeGreaterThan(before.puts)` —— **它对 3、4、13 一视同仁**。而配额账开头那句
   * 「下面每个数字都是一次实测读数」把整份清单声明成了实测结果。
   *
   * **可复现的静默失效**（评审给的、我照着走了一遍）：在 `runManualTendRound` 里加任意
   * 一条 `deps.logger.log(...)`，或者把 `wire.ts` 里 `if (r.minted < r.attempted)` 那条
   * 判断删掉 ⇒ 单次点击从 3 次 put 变 4 次，而**全量用例一条不红**，五份文档里那个 3
   * 静默变成假的。这一格就是补上的那个锚。
   *
   * ⚠️⚠️ **本格的 `env` 与本 describe 里其余几格不同，这不是疏忽：**
   * 那几格用 `CODE_TIMEOUT_MS = SCHEDULED_ROUND_BUDGET_MS + 1` 换「零网络」，
   * 而那个取值同时踩中**两条逐轮配置警告**（`registrar.interval_shorter_than_worst_round`
   * 与 `registrar.attempt_exceeds_worker_budget`，`buildTendDeps` 里打）。
   * **实测**：拿那份 env 量到的是 **4 次 put**（多出来的第 4 次是 `event:` 分片，
   * 由 `deps.flush()` 无条件落盘），它量的是**一台配错了的部署**，不是配额账说的那个 3。
   * 本格改用「池子已经到 `targetKeys`」拿零网络：`tendOnce` 在 `need <= 0` 上早退，
   * 一次尝试都不开始 ⇒ 既没有网络，也没有事件。**下面第 ② 段把那台配错的部署当对照组
   * 一起量**，证明这个 3 不是一个对多写一次无感的常数。
   */
  it("成功一轮的确切代价：3 次 put（抢锁 + 护栏键 + tend:history）+ 1 次 delete，手写字面量", async () => {
    const SEED = "sk-manual-tend-cost-anchor-key";
    /** 池子已经满了 ⇒ `need <= 0` ⇒ 零尝试、零网络、零事件。 */
    async function clickOnce(extra: Record<string, string> = {}) {
      const st = new CountingStorage(new MemoryStorage());
      // 先把 key 与索引建好：空池 + 无索引会让 `repo.all()` 回落到一次 list，
      // 那是空池兜底这条既有路径，不属于被测的这一次点击。
      const seed = new KeyPoolRepo(st, { now: () => Date.now(), logger: NULL_LOGGER, cacheTtlMs: 0 });
      await seed.add(SEED);
      const env: Record<string, string | undefined> = {
        GATEWAY_TOKEN: "gateway-token-for-manual-tend-fixture",
        ADMIN_TOKEN: TEST_ADMIN_TOKEN,
        REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k",
        // 目标 1、池里 1 ⇒ 缺口 0 ⇒ 第一道零网络保险。
        TARGET_KEYS: "1",
        // 第二道保险（与本文件其余几格同一条理由）：保留 TLD `.invalid` 永不解析。
        YYDS_BASE_URL: "https://yyds.invalid",
        ...extra,
      };
      const { app } = await buildApp(env, st);
      const before = { puts: st.puts, deletes: st.deletes, lists: st.lists };
      const res = await app.request(
        "/admin/api/registrar/tend", { method: "POST", headers: withKey },
      );
      return {
        st, res,
        puts: st.puts - before.puts,
        deletes: st.deletes - before.deletes,
        lists: st.lists - before.lists,
      };
    }

    // ── ① 正常配置下的一次成功点击 ─────────────────────────────────────────
    const one = await clickOnce();
    expect(one.res.status, "没走到成功那一支 —— 那下面数的是一条被拒绝的路径").toBe(200);

    // **先证明这一轮真的跑完了**，否则「3」可能是某条提前返回的路径的读数。
    const history = await one.st.get<TendRecord[]>(TEND_HISTORY_KEY);
    expect(history?.length, "这一轮压根没进补池历史").toBe(1);
    expect(history?.[0]?.trigger).toBe("manual");
    expect(history?.[0]?.skipped, "注册机被判成关着了 —— 那是另一条路径").toBe(false);

    // **确切的数字，手写字面量**（不写成 `FIXED_PUTS` 这类从被测对象推导的常量）。
    expect(one.puts, "一次成功点击的 put 次数与五语言 DEPLOY.md 的配额账对不上了").toBe(3);
    expect(one.deletes, "释放锁那一次 delete 没发生（或者多发生了几次）").toBe(1);
    expect(one.lists, "红线 1：这条路上不许碰 list 桶").toBe(0);

    // **那 3 次分别落在哪三把键上**：只数总数的话，把 `tend:history` 换成别的键
    // 照样是 3。锁那把在 `finally` 里被删掉，所以它的痕迹是「已经不在了」。
    expect(await one.st.get(MANUAL_GUARD_KEY), "护栏键那一次 put 没发生").not.toBeNull();
    expect(await one.st.get(TEND_LOCK_KEY), "跑完之后锁必须被释放").toBeNull();

    // ── ② 对照组：同一次点击，配置换成会打逐轮警告的那一份 ⇒ 4 次 put ──────
    // 这一段是这个 3 的**判别力来源**：没有它，`toBe(3)` 证明不了计数器对
    // 「多落一次盘」是敏感的（本仓登记过的「覆盖态让被测的选择不可观测」）。
    const warned = await clickOnce({ CODE_TIMEOUT_MS: String(SCHEDULED_ROUND_BUDGET_MS + 1) });
    expect(warned.res.status).toBe(200);
    expect(
      warned.puts,
      "多一条事件却没多一次 put —— 那上面那个 3 对「多写一次」是无感的",
    ).toBe(4);
    expect(warned.deletes, "对照组的 delete 应当还是那一次释放锁").toBe(1);
  });
});
