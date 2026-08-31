import { describe, it, expect, afterEach, vi } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { registrarFromEnv, type Channel } from "../../src/core/registrar/config.js";
import type { RegistrarWiring, ChannelProbe } from "../../src/http/admin/handlers/registrar.js";
import {
  MANUAL_GUARD_KEY, MANUAL_TENDS_PER_DAY, type ManualGuard,
} from "../../src/core/admin/tend-guard.js";
import { EVENT_WRITES_PER_DAY } from "../../src/core/admin/event-ring.js";
import { TEND_LOCK_KEY } from "../../src/http/admin/tend-lock.js";
import { TEND_HISTORY_KEY, type TendRecord } from "../../src/core/admin/tend-history.js";
import { buildApp } from "../../src/http/wire.js";
import { workerRuntime } from "../../src/adapters/runtime-worker.js";
import { WORKER_ROUND_BUDGET_MS } from "../../src/core/registrar/types.js";

/**
 * `GET /admin/api/registrar/status` 与
 * `POST /admin/api/registrar/channels/:channel/test`（设计 §10.3 / §11），
 * 外加 `POST /admin/api/registrar/tend` 本任务新增的 `channel` 参数。
 *
 * ⚠️⚠️ **两个夹具，作用不同，别混着用**（与 `tests/contract/manual-tend.test.ts` 同一套）：
 * · **A（`makeApp` + 注入 `RegistrarWiring`）**：执行体可控，用来把「注册机关着」
 *   「这条通道没配」「上游抛错」这些状态**在断言的那一刻真的做成立**。
 * · **B（`buildApp`，真装配）**：跑的是 `wire.ts` 里那份真的 `runManualTendRound`
 *   与真的 `probeChannel`，**不 mock**。
 *
 * ⚠️⚠️ **本文件第一版 28 格全部只有夹具 A，那是一整个边界的零覆盖**（评审发现）。
 * 实测过的两条逃逸：
 * · `wire.ts` 的 `tend: (channel) => runManualTendRound(env, storage, channel)`
 *   改成传 `null` ⇒ **1931/1931 全绿**。而那正是「面板写着 MoeMail、实际按主通道跑」
 *   ——handler 的 202 与响应体里那个 `"channel":"moemail"` 都是它**自己的自报**，
 *   取自它自己的局部变量，**与执行体做了什么无关**。
 * · `wire.ts` 的 `probeChannel` 函数体整个换成 `return { ok: true, domains: 0 }`
 *   ⇒ **1931/1931 全绿**。而设计 §10.3 第 6 条「用数据代替推荐」的全部立论，
 *   就是"把可用域名数摆出来"——产出那个数字的代码路径当时零覆盖。
 * ⇒ 下面「真装配」那一组补的就是这一截。
 *
 * **五条贯穿本文件的判据**：
 * ① **这两条新端点一次存储写都不产生、也不 `list`**——配额账把面板的读算成
 *    「人点一下才发生」，多一次写就要回去改五语言 DEPLOY.md（红线 1 / 红线 3）。
 * ② **拒绝一律靠顶层 `reason`，不靠状态码**：`409` 有三种、`429` 有两种。
 * ③ **`counted` 不是「可用」**：判据是 `countsTowardTarget`（`!evicted`），
 *    停用的与冷却中的 key 都算在里面。这一条是 `tender.ts` 那段警告的落点。
 * ④ **通道参数在动任何护栏之前校验完**：拒绝那一支一格名额都不该消费。
 * ⑤ **每一条「handler 把 X 交给了执行体」的断言，都要有一格打在真装配上**
 *    ——handler 那层红不红，与替身另一侧那一截对不对，是两件事。
 */

afterEach(() => { vi.unstubAllGlobals(); });

const NOW = 20_000 * 86_400_000 + 9 * 3_600_000;   // 某天 UTC 上午 9 点
const DAY_END = 20_001 * 86_400_000;

/** 注册机开着、两条通道都配齐（`channel_not_configured` 那几格需要它们真的存在）。 */
/**
 * ⚠️⚠️ **`TARGET_KEYS` 与 `MINT_BATCH` 刻意挑成让 `pool` 那五个数字两两不同**
 *（评审发现 / M-5）：夹具里 `target=9`、`counted=4`、`gap=5`、`fresh=2`、`mintBatch=3`。
 *
 * 第一版是 `target=4 / counted=4 / gap=0 / fresh=2 / mintBatch=2` ⇒
 * **`counted === target` 且 `fresh === mintBatch`**，于是把 `counted` 写成 `reg.targetKeys`、
 * 或者把 `fresh` 写成 `reg.mintBatch`，那一格都**照样绿**（评审实测两条都全绿）。
 * 「覆盖的状态让被测的选择不可观测」——本仓登记的第 5 种假阳性，
 * 而它这次咬的正好是我为了诚实**专门补出来**的那个 `fresh` 字段。
 */
const BOTH_CHANNELS = registrarFromEnv({
  REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", REGISTRAR_FALLBACK: "moemail",
  YYDS_API_KEY: "yk", MOEMAIL_BASE_URL: "https://moe.invalid", MOEMAIL_API_KEY: "mk",
  TARGET_KEYS: "9", MINT_BATCH: "3",
}, {});

/** 只配了 YYDS：`moemail` 那条就是「这条通道在本次部署里没有凭据」的真实形态。 */
const ONLY_YYDS = registrarFromEnv({
  REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "yk", TARGET_KEYS: "4",
}, {});

const withKey = { "x-admin-key": TEST_ADMIN_TOKEN };
const jsonHeaders = { ...withKey, "content-type": "application/json" };

interface FixtureOptions {
  storage?: MemoryStorage | CountingStorage;
  /**
   * **一个会走的时钟**（评审发现）。缺省是冻结在 `NOW`。
   *
   * ⚠️ 冻结时钟下 `latencyMs` 的**真值恒为 0**，于是把 `deps.now() - startedAt`
   * 整个换成字面量 `0`，全套用例照样绿——「延迟」这一半在那种夹具里根本不可观测，
   * 而设计 §10.3 第 6 条要的是「可用域名数 **+ 延迟**」两样。
   */
  tickingClock?: boolean;
  /** 注册机配置。缺省是两条通道都配齐。`null` = 关着（走 `makeApp` 的默认夹具）。 */
  registrar?: ReturnType<typeof registrarFromEnv> | null;
  /** `null` = 这个 app 压根没接注册机执行体（`503 not_wired` 那一档）。 */
  wire?: boolean;
  probe?: (channel: Channel) => Promise<ChannelProbe>;
  keys?: string[];
}

function fixture(o: FixtureOptions = {}) {
  // 每调用一次前进 7ms。7 是个不整的数，好让「差值恰好是一次调用间隔」这件事
  // 不会与别处任何一个整秒/整分的常量偶然相等。
  let t = NOW;
  const now = o.tickingClock ? () => (t += 7) : () => NOW;
  const storage = o.storage ?? new MemoryStorage(undefined, now);
  const tendCalls: Array<Channel | null> = [];
  const wiring: RegistrarWiring | undefined = o.wire === false ? undefined : {
    storage,
    tend: async (channel) => { tendCalls.push(channel); },
    // **缺省抛错，不是缺省返回一个成功**：一个"看起来测通了、其实什么都没探"的
    // 默认桩正是本仓登记的第 2 种假阳性（桩不抛错）。要测成功那一支的用例
    // 自己传 `probe`。抛出来的这一支同时也是「上游报错」那几格用的形态。
    probeChannel: o.probe ?? (async () => { throw new Error("本用例没有给通道连通性测试装执行体"); }),
  };
  const registrar = o.registrar === null ? undefined : (o.registrar ?? BOTH_CHANNELS);
  return makeApp(
    [], o.keys ?? [],
    registrar === undefined ? {} : { registrar },
    now,
    { storage, registrar: wiring },
  ).then((h) => ({ ...h, storage, tendCalls }));
}

const status = (app: Awaited<ReturnType<typeof fixture>>["app"]) =>
  app.request("/admin/api/registrar/status", { headers: withKey });

const testChannel = (app: Awaited<ReturnType<typeof fixture>>["app"], channel: string) =>
  app.request(`/admin/api/registrar/channels/${channel}/test`, { method: "POST", headers: withKey });

const tend = (
  app: Awaited<ReturnType<typeof fixture>>["app"],
  body?: unknown,
) => app.request("/admin/api/registrar/tend", {
  method: "POST",
  headers: body === undefined ? withKey : jsonHeaders,
  body: body === undefined ? undefined : JSON.stringify(body),
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/api/registrar/status
// ───────────────────────────────────────────────────────────────────────────

describe("GET /admin/api/registrar/status", () => {
  it("没接执行体时如实回 503 not_wired，不编造一份空历史", async () => {
    const { app } = await fixture({ wire: false });
    const res = await status(app);
    expect(res.status).toBe(503);
    // **判据是 reason 不是状态码**：503 在这棵树上只有这一种含义，但面板选文案
    // 走的是 reason，这一格断言的是那条契约本身。
    expect((await res.json() as { reason: string }).reason).toBe("not_wired");
  });

  /**
   * ⚠️ **注册机关着时它照常 200，与 `tend` 那条相反**——「关着」是这个端点要
   * **报告**的状态，不是拒绝它的理由。做成 409 的话，运维在面板上会看到一片
   * `—`，既看不到「已关闭」这句话，也看不到关掉之前那几轮的补池历史。
   */
  it("注册机关着照常 200 并如实说 enabled:false，不是 409", async () => {
    const { app } = await fixture({ registrar: null });
    const res = await status(app);
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean; primary: string | null };
    expect(body.enabled).toBe(false);
    expect(body.primary, "关着的注册机没有主通道，如实给 null").toBeNull();
  });

  it("两条通道各自的接入状态与角色如实给出——只配了 YYDS 时 moemail 是 configured:false", async () => {
    const { app } = await fixture({ registrar: ONLY_YYDS });
    const body = await (await status(app)).json() as {
      channels: Record<string, { configured: boolean; role: string | null }>;
    };
    expect(body.channels.yyds).toEqual({ configured: true, role: "primary" });
    expect(body.channels.moemail).toEqual({ configured: false, role: null });
  });

  it("两条通道都配齐时，主/备角色各归各的——备通道不许被记成主通道", async () => {
    const { app } = await fixture();
    const body = await (await status(app)).json() as {
      channels: Record<string, { configured: boolean; role: string | null }>;
    };
    expect(body.channels.yyds).toEqual({ configured: true, role: "primary" });
    expect(body.channels.moemail).toEqual({ configured: true, role: "fallback" });
  });

  /**
   * ⚠️⚠️ **这一格是 `src/core/registrar/tender.ts` 里那段「这一栏不许按『可用』
   * 渲染」的落点。** 夹具刻意让四把 key 里有一把被停用、一把在冷却：
   * · `counted`（判据 `countsTowardTarget` = `!evicted`）= **4**，两把都算；
   * · `fresh`（真正能打上游的）= **2**。
   * 两个数字必须**不相等**，否则这一格换成 `poolHealth().fresh` 也照样绿——
   * 那就是「覆盖的状态让被测的选择不可观测」。
   */
  it("counted 是「占名额数」不是「可用数」——停用的与冷却中的 key 都算在 counted 里", async () => {
    const { app, repo } = await fixture({ keys: ["sk-a", "sk-b", "sk-c", "sk-d"] });
    const all = await repo.all();
    await repo.save({ ...all[0]!, disabled: true }, all[0]!);
    await repo.save({ ...all[1]!, cooldownUntil: NOW + 60_000 }, all[1]!);

    const body = await (await status(app)).json() as {
      pool: { target: number; counted: number; gap: number; fresh: number; mintBatch: number };
    };
    expect(body.pool.counted, "被停用的与冷却中的 key 都占名额").toBe(4);
    expect(body.pool.fresh, "真正能打上游的只剩两把").toBe(2);
    expect(body.pool.target).toBe(9);
    expect(body.pool.gap, "缺口 = target - counted，夹到非负").toBe(5);
    expect(body.pool.mintBatch, "面板算「本次最多铸几把」要它").toBe(3);

    /**
     * **反向自检：这五个数字两两不同。**
     * 少了它，夹具哪天被调成 `counted === target` 或 `fresh === mintBatch`（第一版就是），
     * 上面那五条断言会**同时**对好几种接错线的实现成立，而没有任何东西会提醒。
     */
    const five = Object.values(body.pool);
    expect(new Set(five).size, `pool 的五个数字撞了：${five.join(",")} —— 撞了的那两格互相可以冒充`)
      .toBe(five.length);
  });

  it("池子比目标少时 gap 是差额；池子超编时 gap 夹到 0 而不是负数", async () => {
    const { app } = await fixture({ registrar: ONLY_YYDS, keys: ["sk-a"] });
    const body = await (await status(app)).json() as { pool: { gap: number } };
    expect(body.pool.gap).toBe(3);

    const over = await fixture({
      registrar: registrarFromEnv({
        REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "yk", TARGET_KEYS: "1",
      }, {}),
      keys: ["sk-a", "sk-b", "sk-c"],
    });
    const overBody = await (await status(over.app)).json() as { pool: { gap: number } };
    expect(overBody.pool.gap, "池子超编时缺口是 0，不是 -2").toBe(0);
  });

  /**
   * ⚠️⚠️ **跨任务复验：`narrowTendHistory` 在这条读路径上真的挡着。**
   * 往 `tend:history` 里塞一条 `null`（外部写坏存储的最小形态），这条端点**不许 500**，
   * 而且必须**说出来丢了几条**——丢掉 `malformed` 就等于把证据静默抹掉。
   */
  it("tend:history 里塞一条 null：不许 500，坏记录被丢掉并计进 malformed", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    const good: TendRecord = {
      skipped: false, available: 1, attempted: 1, minted: 1, mintedByChannel: { yyds: 1 },
      failures: [], at: NOW - 60_000, primaryChannel: "yyds", durationMs: 1200, trigger: "cron",
    };
    await storage.put(TEND_HISTORY_KEY, [good, null, { at: "nope" }]);

    const { app } = await fixture({ storage });
    const res = await status(app);
    expect(res.status, "存储被写坏不该让这条端点 500").toBe(200);
    const body = await res.json() as { history: { entries: TendRecord[]; malformed: number } };
    expect(body.history.entries).toHaveLength(1);
    expect(body.history.entries[0]!.minted).toBe(1);
    expect(body.history.malformed, "丢了两条，必须说出来").toBe(2);
  });

  it("补池锁：`until > now` 才算「正在跑」，陈旧的锁不许被显示成正在补池", async () => {
    const live = new MemoryStorage(undefined, () => NOW);
    await live.put(TEND_LOCK_KEY, { until: NOW + 30_000 });
    const a = await fixture({ storage: live });
    expect((await (await status(a.app)).json() as { lockedUntil: number | null }).lockedUntil)
      .toBe(NOW + 30_000);

    const stale = new MemoryStorage(undefined, () => NOW);
    await stale.put(TEND_LOCK_KEY, { until: NOW - 1 });
    const b = await fixture({ storage: stale });
    expect(
      (await (await status(b.app)).json() as { lockedUntil: number | null }).lockedUntil,
      "过期的锁拦不住任何人，也不该在面板上显示成「正在补池」",
    ).toBeNull();
  });

  /**
   * ⚠️⚠️ **「点之前」与「点之后」两个方向各钉一格，这是本文件最要紧的一对。**
   *
   * 两个数字**刻意不同**，而且差 1：
   * · `status` 给的是「**现在**还剩几次」——什么都没发生，`used=5` ⇒ **19**；
   * · `202` 给的是「**点完这一次之后**还剩几次」——`used` 已经写成 6 ⇒ **18**。
   *
   * 只钉其中一个的话，把 `manualTendQuota` 写成直接复用 `checkManualTend` 的
   * `ok` 支（少 1）或者反过来（多 1），都会有一半永远绿。两个都是手写字面量，
   * **不从 `MANUAL_TENDS_PER_DAY` 推导**——从被测对象自己推导出来的期望值恒等于
   * 实际值，那是本仓登记的第 6 种假阳性。
   */
  it("点一次之前 status 说 19、点完之后 202 说 18 —— 两个方向的口径各钉一格", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    const guard: ManualGuard = { day: 20_000, used: 5, cooldownUntil: 0 };
    await storage.put(MANUAL_GUARD_KEY, guard);

    const { app } = await fixture({ storage });
    const before = await (await status(app)).json() as {
      manual: { used: number; remaining: number; perDay: number; resetAt: number; cooldownUntil: number | null };
    };
    expect(before.manual.used).toBe(5);
    expect(before.manual.remaining, "还没点，剩的是 24-5=19").toBe(19);
    expect(before.manual.perDay, "面板要说「还剩 19 次（共 24 次）」，光有 19 不够").toBe(24);
    expect(before.manual.resetAt).toBe(DAY_END);
    expect(before.manual.cooldownUntil, "不在冷却中就是 null，不是一个已经过去的时刻").toBeNull();

    const res = await tend(app);
    expect(res.status).toBe(202);
    expect(
      (await res.json() as { remaining: number }).remaining,
      "点完之后 used=6，剩 24-6=18",
    ).toBe(18);

    const after = await (await status(app)).json() as { manual: { used: number; remaining: number } };
    expect(after.manual.used, "护栏键真的被消费了一格").toBe(6);
    expect(after.manual.remaining).toBe(18);
  });

  it("冷却中时绝对时刻与相对时长成对给，不冷却时两个都是 null", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    await storage.put(MANUAL_GUARD_KEY, { day: 20_000, used: 1, cooldownUntil: NOW + 120_000 });
    const { app } = await fixture({ storage });
    const body = await (await status(app)).json() as {
      manual: { cooldownUntil: number | null; retryAfterMs: number | null };
    };
    // 相对量做倒计时（免疫客户端时钟偏差），绝对时刻显示「几点恢复」。
    // **只给一个的话，面板要显示另一个就只能拿本地时钟去减**（评审 m3）。
    expect(body.manual.cooldownUntil).toBe(NOW + 120_000);
    expect(body.manual.retryAfterMs).toBe(120_000);
  });

  it("MANUAL_TENDS_PER_DAY 是 24 —— 上面那两格手写的 19/18 建立在它上面", () => {
    // 反向自检：这个常量被改掉时，上面那两个手写字面量就不再是它们声称的那件事。
    // 这一格让「改常量」立刻变红，而不是让那两格悄悄测起别的东西。
    expect(MANUAL_TENDS_PER_DAY).toBe(24);
  });

  /**
   * ⚠️⚠️ **红线 1：面板的取数路径里不许出现 `list()`；配额账把它算成零写。**
   *
   * 数三个桶而不是一个「操作次数」：`put` / `list` / `delete` 在 KV 上是**独立**的
   * 每日配额桶，混着数会让这条断言恰好丢掉最要紧的那条信息。
   */
  it("status 与通道测试在稳态下都不写存储、也不 list —— 索引正常时面板刷得再勤也不烧写配额", async () => {
    const st = new CountingStorage(new MemoryStorage(undefined, () => NOW));
    // 注册机**开着**（`fixture` 缺省就是 `BOTH_CHANNELS`）：关着的话通道测试在
    // 第一行 409 就返回了，这一格量到的「零写」有一半根本没走到执行体那一侧。
    const { app } = await fixture({
      storage: st, keys: ["sk-a"],
      probe: async () => ({ ok: true, domains: 1 }),
    });
    const before = { puts: st.puts, deletes: st.deletes, lists: st.lists, gets: st.gets };

    expect((await status(app)).status).toBe(200);
    expect((await status(app)).status).toBe(200);
    // **断言确切的 200，不是 `< 500`**：`< 500` 对 400 / 409 一视同仁，而那两种都是
    // 「压根没走到执行体」——那样这一格量的是一条提前返回的路径的零写，没有判别力。
    expect((await testChannel(app, "moemail")).status).toBe(200);

    expect({ puts: st.puts, deletes: st.deletes, lists: st.lists },
      "这两条端点一次写都不该产生").toEqual({ puts: before.puts, deletes: before.deletes, lists: before.lists });
    // **反向自检比的是同一根轴**：`gets` 的**增量**必须大于 0。
    // 第一版写的是 `st.gets > before.puts`（gets 对 puts 的基线）——那是拿两根不同的
    // 轴比大小，即使这三次请求一次读都没发生，它照样成立。
    expect(st.gets - before.gets, "读一次都没发生 —— 那上面那个「零写」是空的").toBeGreaterThan(0);
  });

  /**
   * ⚠️⚠️ **上一格的夹具是 `probe: ok:true` —— 它只量了成功那一支（评审发现）。**
   *
   * `channelTestHandler` 的 `catch` 会打一条 `registrar.channel_test_failed`
   *（`src/http/admin/handlers/registrar.ts` 那条 `deps.logger.log`），而生产装配里
   * `logger` 是 `multiLogger(ConsoleLogger, StoreLogger)`，`logFlush` 中间件在每个
   * 非 `/health` 请求收尾调 `maybeFlush()` ⇒ **失败那一支不是无条件零写**。
   *
   * **下面每个数字都是本格自己量出来的**（不是从常量推的，也不是从别处抄的）：
   * · 失败请求**自己**这一次：**0 次 put** —— 事件只进内存缓冲，
   *   `maybeFlush()` 被 `EVENT_FLUSH_MIN_INTERVAL_MS`（60 秒，`lastFlushAt` 在 sink
   *   构造时就置成 `now()`）挡住；
   * · 紧接着 60 秒内再失败 9 次：**还是 0 次 put** —— 同一条闸，这一段是**批量**的，
   *   不是「每次失败一次写」；
   * · 跨过 60 秒之后的那一次请求：**1 次 put + 1 次 get**（读旧分片 + 写回环）；
   * · 之后每次都跨 60 秒再来 100 次：**只多 11 次 put** —— 撞上
   *   `EVENT_WRITES_PER_DAY`（每 isolate 每天 12 次）**这条已经在配额账里记过的预算**，
   *   合计恰好 12。
   *
   * ⇒ **失败支吃的不是一笔新账，是事件 sink 那笔旧账**；真正没有上界的是
   * **可观测性**：`EVENT_RING_SIZE = 100`，连点失败的连通性测试会把事件板块里
   * 别的诊断挤出环，而运维点这颗按钮的时候正是他最需要那些事件的时候。
   *
   * **成功那一支拿同一套跑法做对照**（下面最后一段）：51 次成功、跨 50 分钟，
   * put 增量恒为 0 —— 两支真的不一样，上一格量到的「零写」只对成功支成立。
   */
  it("通道测试失败那一支不是无条件零写：请求内 0 次 put，事件在之后的落盘里合并，且被每日 12 次封顶", async () => {
    let t = NOW;
    const now = () => t;
    const st = new CountingStorage(new MemoryStorage(undefined, now));
    const wiring: RegistrarWiring = {
      storage: st,
      tend: async () => {},
      // 失败夹具：这正是上一格没有的那一半。
      probeChannel: async () => { throw new Error("上游不可达"); },
    };
    const { app } = await makeApp(
      [], [], { registrar: BOTH_CHANNELS }, now, { storage: st, registrar: wiring },
    );
    const hit = () => app.request(
      "/admin/api/registrar/channels/yyds/test", { method: "POST", headers: withKey },
    );

    // ① 第一次失败：走到了 catch（200 + ok:false），而 put 一次都没发生。
    const b1 = { puts: st.puts, gets: st.gets };
    const first = await hit();
    expect(first.status, "没走到失败那一支 —— 这一格量的是别的东西").toBe(200);
    expect(await first.json()).toMatchObject({ ok: false, reason: "upstream_error" });
    expect(st.puts - b1.puts, "失败请求自己这一次就写了盘").toBe(0);

    // ② 60 秒内再失败 9 次：仍然 0 —— 这一段是批量的，不是每次一写。
    //
    // ⚠️ **循环里必须推时钟。** 这一格订正过（修复轮复评发现②）：原来 9 次失败全发生在
    // 同一个假时刻，于是它证明的只是「0 毫秒内不落盘」，**那个 60 没有锚**。实测：
    // 把 `EVENT_FLUSH_MIN_INTERVAL_MS` 从 60_000 改成 1，这一格照样绿。
    // 现在每次推 6 秒、9 次共 54 秒 —— **仍在窗内**，而把常量调到 6_000 以下就会红。
    const b2 = st.puts;
    for (let i = 0; i < 9; i++) { t += 6_000; await hit(); }
    expect(st.puts - b2, "60 秒最小间隔内的连续失败没有被合并成一次落盘").toBe(0);

    // ③ 跨过最小间隔之后的那一次请求：恰好 1 次 put + 1 次 get。
    t += 60_001;
    const b3 = { puts: st.puts, gets: st.gets };
    await hit();
    expect(st.puts - b3.puts, "跨过 60 秒之后那一次没落盘").toBe(1);
    expect(st.gets - b3.gets, "落盘是读旧分片 + 写回环，get 那一半没发生").toBe(1);

    // ④ 之后每次都跨 60 秒再来 100 次：只多 11 次，合计 12 —— 被每日预算截住。
    const b4 = st.puts;
    for (let i = 0; i < 100; i++) { t += 60_001; await hit(); }
    expect(st.puts - b4, "每日写预算没有截住它 —— 那这条路径就是无上界的").toBe(11);
    expect(st.puts - b1.puts, "110 次失败一共落了几次盘").toBe(12);
    // 反向自检：上面那个 12 就是这条常量本身（手写字面量，两边都改也拦得住）。
    expect(EVENT_WRITES_PER_DAY, "每 isolate 每天 12 次这条预算被改了").toBe(12);
    // 全程一次 list、一次 delete 都不该有（红线 1 在失败支上同样成立）。
    expect({ lists: st.lists, deletes: st.deletes }).toEqual({ lists: 0, deletes: 0 });

    // ⑤ **对照组**：同一套跑法，只把夹具换成成功支 ⇒ put 增量恒为 0。
    //    没有这一段的话，上面那些数字证明不了「两支不一样」。
    let t2 = NOW;
    const st2 = new CountingStorage(new MemoryStorage(undefined, () => t2));
    const okApp = await makeApp([], [], { registrar: BOTH_CHANNELS }, () => t2, {
      storage: st2,
      registrar: { storage: st2, tend: async () => {}, probeChannel: async () => ({ ok: true, domains: 1 }) },
    });
    const b5 = st2.puts;
    for (let i = 0; i < 51; i++) {
      t2 += 60_001;
      expect((await okApp.app.request(
        "/admin/api/registrar/channels/yyds/test", { method: "POST", headers: withKey },
      )).status).toBe(200);
    }
    expect(st2.puts - b5, "成功那一支也写了盘 —— 那上一格的「零写」本身就是假的").toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/api/registrar/channels/:channel/test
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **这条端点后来带护栏了，这是一次行为变更**：同一条通道在
 * `PROBE_MIN_INTERVAL_MS` 内的第二次点击会拿到 **429**（账本第 799 行登记的
 * 「通道连通性端点无冷却/预算护栏」那个缺口，补法是与单把 key 验活**共用一套**，
 * 见 `src/http/admin/probe-guard.ts`）。
 *
 * **本文件因此一格都没改，这件事是查过的、不是碰巧**：下面每一格要么各自
 * `fixture()` 一个新 app（一个 app 一把护栏），要么在两次点击之间把假时钟推过
 * 6 秒（`>` 3 秒），要么打的是**两条不同**的通道（kind 是 `channel:<name>`）。
 * ⚠️ **最后那一条顺带是「粒度不能写成全局」的一份旁证**：
 * 「成功：ok + 可用域名数 + 耗时，两条通道同一套形状」在同一个 app 上连着打
 * `moemail` 与 `yyds`，护栏若是全局粒度，它当场就红。
 *
 * 护栏本身的格子全部在 `tests/contract/admin-verify.test.ts` 的
 * 「出站探测护栏：与通道测试共用的那一套（全局约束 14）」那一组里，
 * **刻意不在本文件复制一份**——同一条判据写两处，改的时候必然只改一处。
 */
describe("POST /admin/api/registrar/channels/:channel/test", () => {
  it("成功：ok + 可用域名数 + 耗时，两条通道同一套形状", async () => {
    const probes: Channel[] = [];
    const { app } = await fixture({
      probe: async (channel) => { probes.push(channel); return { ok: true, domains: channel === "yyds" ? 7 : 3 }; },
    });

    const moe = await testChannel(app, "moemail");
    const yyds = await testChannel(app, "yyds");
    expect(moe.status).toBe(200);
    expect(yyds.status).toBe(200);
    const a = await moe.json() as { ok: boolean; channel: string; domains: number; latencyMs: number };
    const b = await yyds.json() as { ok: boolean; channel: string; domains: number; latencyMs: number };

    // **两条通道的响应键集合逐字相同**：设计 §10.3 第 6 条要求两个按钮
    // 「样式、位置、文案模板完全一致」，而模板一致的前提是数据形状一致。
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a).toEqual({ ok: true, channel: "moemail", domains: 3, latencyMs: 0 });
    expect(b).toEqual({ ok: true, channel: "yyds", domains: 7, latencyMs: 0 });
    expect(probes, "两条通道各自真的被探了一次，且探的是自己那条").toEqual(["moemail", "yyds"]);
  });

  /**
   * ⚠️ **上游报错走 `200 + { ok: false }`，不是 5xx。**
   * 「测出来不通」正是这颗按钮要回答的问题，做成 5xx 会让面板的通用错误处理
   * 把它当成「面板自己坏了」；而且两条通道必须同一套返回形状，一通一不通时
   * 不该一张卡走成功分支、一张走异常分支。
   */
  it("上游抛错：200 + ok:false + reason，且**不回显上游的错误文本**", async () => {
    const { app, logger } = await fixture({
      probe: async () => { throw new Error("connect ECONNREFUSED https://moe.invalid/api/config?key=SECRET"); },
    });
    const res = await testChannel(app, "moemail");
    expect(res.status, "测不通不是接口异常").toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, channel: "moemail", reason: "upstream_error", latencyMs: 0 });
    expect(
      JSON.stringify(body),
      "响应体里带上了上游的错误文本——那里面可能有 baseUrl、甚至上游原样返回的响应体",
    ).not.toContain("SECRET");
    // 详情留在事件里（事件板块是鉴权后的），不是丢掉。
    expect(logger.has("registrar.channel_test_failed"), "详情连一条事件都没留，运维无从排查").toBe(true);
  });

  /**
   * ⚠️⚠️ **`latencyMs` 必须是真的量出来的，不是一个恒为 0 的字面量。**
   *
   * 两格成对，方向相反：
   * · 时钟会走 ⇒ `latencyMs > 0`（把两处 `deps.now() - startedAt` 换成 `0` ⇒ 红）；
   * · 时钟冻住 ⇒ `latencyMs === 0`（把它换成一个随便的常量、或者去读别的字段 ⇒ 红）。
   * **只写前一格**，实现返回一个恒正的常量就能过；**只写后一格**（本文件第一版就是），
   * 实现返回字面量 `0` 就能过。
   */
  it("latencyMs 是真的量出来的：时钟会走时它 > 0，冻住时它恰好是 0", async () => {
    const ticking = await fixture({ tickingClock: true, probe: async () => ({ ok: true, domains: 1 }) });
    const a = await (await testChannel(ticking.app, "yyds")).json() as { latencyMs: number };
    expect(a.latencyMs, "时钟在走，耗时却是 0 —— 那个字段是个字面量").toBeGreaterThan(0);

    const frozen = await fixture({ probe: async () => ({ ok: true, domains: 1 }) });
    const b = await (await testChannel(frozen.app, "yyds")).json() as { latencyMs: number };
    expect(b.latencyMs, "时钟冻住时耗时应当恰好是 0，不是某个常数").toBe(0);
  });

  it("失败那一支同样量耗时 —— 「多久之后才发现连不上」正是运维要看的那个数", async () => {
    const ticking = await fixture({
      tickingClock: true,
      probe: async () => { throw new Error("connect timeout"); },
    });
    const body = await (await testChannel(ticking.app, "moemail")).json() as
      { ok: boolean; latencyMs: number };
    expect(body.ok).toBe(false);
    expect(body.latencyMs, "失败那一支的耗时是 0 —— 它与成功那一支不是同一段计时").toBeGreaterThan(0);
  });

  it("通道名不认识：400 unknown_channel，压根不去碰执行体", async () => {
    let probed = false;
    const { app } = await fixture({ probe: async () => { probed = true; return { ok: true, domains: 1 }; } });
    const res = await testChannel(app, "gmail");
    expect(res.status).toBe(400);
    expect((await res.json() as { reason: string }).reason).toBe("unknown_channel");
    expect(probed, "通道名都不合法还去打了一次上游").toBe(false);
  });

  it("注册机关着：409 registrar_disabled，一次上游请求都不发", async () => {
    let probed = false;
    const { app } = await fixture({
      registrar: null,
      probe: async () => { probed = true; return { ok: true, domains: 1 }; },
    });
    const res = await testChannel(app, "yyds");
    expect(res.status).toBe(409);
    expect((await res.json() as { reason: string }).reason).toBe("registrar_disabled");
    expect(probed).toBe(false);
  });

  it("这条通道没配凭据：409 channel_not_configured，同样一次上游请求都不发", async () => {
    let probed = false;
    const { app } = await fixture({
      registrar: ONLY_YYDS,
      probe: async () => { probed = true; return { ok: true, domains: 1 }; },
    });
    const res = await testChannel(app, "moemail");
    expect(res.status).toBe(409);
    const body = await res.json() as { reason: string; channel: string };
    expect(body.reason).toBe("channel_not_configured");
    expect(body.channel, "面板要知道是哪一条被拒了").toBe("moemail");
    expect(probed).toBe(false);
  });

  /**
   * ⚠️ **三种 409 必须各说各的，这是本文件对「状态码不是判据」那条的正面验证。**
   * 拿状态码当唯一判据的前端会把「注册机没开」（去设置里打开它）与
   * 「这条通道没配」（去把这条通道配上）说成同一句话。
   */
  it("两种 409 的 reason 互不相同 —— 只看状态码分不出「注册机没开」与「这条通道没配」", async () => {
    const off = await fixture({ registrar: null });
    const partial = await fixture({ registrar: ONLY_YYDS });
    const a = await (await testChannel(off.app, "moemail")).json() as { reason: string };
    const b = await (await testChannel(partial.app, "moemail")).json() as { reason: string };
    expect([a.reason, b.reason]).toEqual(["registrar_disabled", "channel_not_configured"]);
  });

  it("配置在两步之间被改掉：执行体回 provider_missing ⇒ 409，不假装测成了", async () => {
    const { app } = await fixture({ probe: async () => ({ ok: false, reason: "provider_missing" }) });
    const res = await testChannel(app, "moemail");
    expect(res.status).toBe(409);
    expect((await res.json() as { reason: string }).reason).toBe("channel_not_configured");
  });

  it("没接执行体：503 not_wired", async () => {
    const { app } = await fixture({ wire: false });
    const res = await testChannel(app, "yyds");
    expect(res.status).toBe(503);
    expect((await res.json() as { reason: string }).reason).toBe("not_wired");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/api/registrar/tend 的 channel 参数（后来新增）
// ───────────────────────────────────────────────────────────────────────────

describe("立即补池的 channel 参数：「只用这一条通道」", () => {
  it("不带请求体时照常 202，且传给执行体的是 null（按配置的主/备链跑）", async () => {
    const { app, tendCalls } = await fixture();
    expect((await tend(app)).status).toBe(202);
    expect(tendCalls, "不带体的旧调用方式必须一字不变地照常工作").toEqual([null]);
  });

  /**
   * ⚠️ **不只断言 202：断言执行体收到的正是那条通道。**
   * 只看状态码的话，把 `wiring.tend(channel)` 写成 `wiring.tend(null)`
   * ——也就是「菜单上选了 MoeMail，实际按主通道 YYDS 跑」——照样 202、照样绿。
   */
  it("带 channel 时，执行体收到的就是那一条（不是被悄悄换成主通道）", async () => {
    const { app, tendCalls } = await fixture();
    expect((await tend(app, { channel: "moemail" })).status).toBe(202);
    expect(tendCalls).toEqual(["moemail"]);
  });

  it("202 的响应体把这一轮实际用的通道回显出来", async () => {
    const { app } = await fixture();
    const body = await (await tend(app, { channel: "moemail" })).json() as { channel: string | null };
    expect(body.channel).toBe("moemail");

    const plain = await fixture();
    const plainBody = await (await tend(plain.app)).json() as { channel: string | null };
    expect(plainBody.channel, "没指定通道时如实给 null，不伪造成主通道").toBeNull();
  });

  /**
   * ⚠️⚠️ **拒绝那一支一格名额都不许消费。**
   * 校验排在四条护栏之前，所以护栏键不该被写、执行体不该被调。写在护栏之后的话，
   * 一次拼错通道名的点击会白白吃掉一格日预算 + 起算一次 10 分钟冷却，
   * 而**什么都没跑**——这与把「抢锁失败」挪到护栏之前是同一条理由。
   */
  it("通道名不认识：400，护栏键没被写、执行体没被调", async () => {
    const st = new CountingStorage(new MemoryStorage(undefined, () => NOW));
    const { app, tendCalls } = await fixture({ storage: st });
    const puts = st.puts;

    const res = await tend(app, { channel: "gmail" });
    expect(res.status).toBe(400);
    expect((await res.json() as { reason: string }).reason).toBe("unknown_channel");
    expect(tendCalls).toEqual([]);
    expect(st.puts, "被拒的那一次却写了存储 —— 一格日预算白白没了").toBe(puts);
    expect(await st.get(MANUAL_GUARD_KEY)).toBeNull();
  });

  it("通道没配凭据：409 channel_not_configured，同样一格名额都不消费", async () => {
    const st = new CountingStorage(new MemoryStorage(undefined, () => NOW));
    const { app, tendCalls } = await fixture({ storage: st, registrar: ONLY_YYDS });
    const puts = st.puts;

    const res = await tend(app, { channel: "moemail" });
    expect(res.status).toBe(409);
    expect((await res.json() as { reason: string; channel: string }).reason).toBe("channel_not_configured");
    expect(tendCalls).toEqual([]);
    expect(st.puts).toBe(puts);
  });

  it("拼错的字段名一律 400，不静默按「没指定通道」跑一轮", async () => {
    const { app, tendCalls } = await fixture();
    const res = await tend(app, { chanel: "moemail" });
    expect(res.status, "宽松接受的话，这是一次「点了、按主通道跑了」的静默误操作").toBe(400);
    expect(tendCalls).toEqual([]);
  });

  it("请求体不是 JSON 对象（数组 / 标量 / 坏 JSON）一律 400", async () => {
    const { app } = await fixture();
    expect((await tend(app, ["moemail"])).status).toBe(400);
    expect((await tend(app, "moemail")).status).toBe(400);
    const broken = await app.request("/admin/api/registrar/tend", {
      method: "POST", headers: jsonHeaders, body: "{not json",
    });
    expect(broken.status).toBe(400);
  });

  it("channel: null 与不给这个字段等价 —— 面板可以直接把「按配置的链」编码成 null", async () => {
    const { app, tendCalls } = await fixture();
    expect((await tend(app, { channel: null })).status).toBe(202);
    expect(tendCalls).toEqual([null]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 夹具 B：真装配（buildApp）—— 替身另一侧的那一截
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ **这一组跑的是 `wire.ts` 里那份真的 `runManualTendRound` 与真的 `probeChannel`。**
 *
 * 上面那 28 格全部只有夹具 A（注入的 `RegistrarWiring`），于是
 * **`wire.ts` 那一侧一格都没有被钉住**——两条实测过的逃逸写在本文件头。
 *
 * **零网络怎么做到的，两道保险**（照抄 `tests/contract/manual-tend.test.ts` 的
 * 「手动补池传的 roundBudgetMs 与 Cron 那一份逐字相同（780_000 手写字面量锚）」
 * 那一组的做法）：
 * ① `CODE_TIMEOUT_MS` 调到比 `WORKER_ROUND_BUDGET_MS` 还大 ⇒ `tendOnce` 判定
 *    「单次最坏耗时装不下本轮预算」，**一次尝试都不开始**就返回（补池那一组用它）；
 * ② 两条通道的 baseUrl 都指向保留 TLD `.invalid`（RFC 6761，永不解析）——
 *    即使第一道保险失效也只会 DNS 失败，不会触达任何真实服务。
 *    **通道连通性那一组还额外把全局 `fetch` 换成桩**（`NativeFetcher` 调的就是它），
 *    所以那一组连 DNS 都不查。
 *
 * 运行时用 `workerRuntime()`：后台任务落进我们自己的 `ctx.waitUntil` 数组里，
 * 用例可以 `await` 完再断言存储，**不依赖任何"等一会儿"**。
 */
describe("真装配（buildApp）：channel 参数与通道连通性走的是 wire.ts 那一截", () => {
  const REAL_ENV: Record<string, string | undefined> = {
    GATEWAY_TOKEN: "gateway-token-for-registrar-fixture",
    ADMIN_TOKEN: TEST_ADMIN_TOKEN,
    REGISTRAR_ENABLED: "true",
    // **主 yyds、备 moemail**：这样「只用 moemail」与「按配置的链跑」会得到**两个不同的**
    // `primaryChannel`。两条通道配成同一条的话，下面那对镜像断言两边都是同一个值，
    // 整组恒绿——那正是本仓登记的「夹具 A/B 同值」那种假阳性。
    REGISTRAR_PRIMARY: "yyds",
    REGISTRAR_FALLBACK: "moemail",
    YYDS_API_KEY: "yk",
    YYDS_BASE_URL: "https://yyds.invalid",
    MOEMAIL_API_KEY: "mk",
    MOEMAIL_BASE_URL: "https://moe.invalid",
    TARGET_KEYS: "1",
    CODE_TIMEOUT_MS: String(WORKER_ROUND_BUDGET_MS + 1),
  };

  async function realApp(extra: Record<string, string> = {}) {
    const storage = new MemoryStorage();
    const { app } = await buildApp({ ...REAL_ENV, ...extra }, storage, workerRuntime());
    const waited: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
    return {
      storage,
      /** 打一次请求并把后台任务跑完（`waitUntil` 里那个）。 */
      async call(path: string, body?: unknown): Promise<Response> {
        const res = await app.request(
          path,
          {
            method: "POST",
            headers: body === undefined ? withKey : jsonHeaders,
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          undefined,
          ctx as unknown as ExecutionContext,
        );
        await Promise.all(waited);
        return res;
      },
      history: () => storage.get<TendRecord[]>(TEND_HISTORY_KEY),
    };
  }

  /**
   * ⚠️⚠️ **这一格是「面板写着 MoeMail、实际按主通道跑」唯一的护栏。**
   *
   * 观测点是 **`tend:history` 那一行的 `primaryChannel`**，不是状态码、也不是响应体。
   * 三样东西在变异体里全都不会变：
   * · `202` —— handler 起跑之后就返回了，与执行体做了什么无关；
   * · 响应体里的 `"channel":"moemail"` —— 那是 handler **自己的局部变量**，是自报；
   * · 事件 `registrar.manual_tend_started` 的 `fields.channel` —— 同样是自报。
   * **只有落盘的那一行记的是真的跑了哪条通道。**
   *
   * 实测：把 `wire.ts` 的 `tend: (channel) => runManualTendRound(env, storage, channel)`
   * 改成传 `null` ⇒ 这一格红（`primaryChannel` 变回 `"yyds"`），其余 1930 格全绿。
   */
  it("带 channel 时，落盘的那一行记的是「这一轮实际用的通道」，不是配置里的主通道", async () => {
    const h = await realApp();
    const res = await h.call("/admin/api/registrar/tend", { channel: "moemail" });
    expect(res.status).toBe(202);

    const rows = await h.history();
    expect(rows, "真装配这一轮没有往 tend:history 写下任何东西").toHaveLength(1);
    expect(
      rows![0]!.primaryChannel,
      "面板上选的是 MoeMail，落盘的那一行却记着主通道 —— 202 与响应体都是 handler 的自报，抓不住这一条",
    ).toBe("moemail");
    expect(rows![0]!.trigger).toBe("manual");
  });

  /**
   * **上面那一格的镜像方向。** 少了它，把 `runManualTendRound` 写成「无条件只用
   * 请求里那条、没给就崩」或者「无条件用 moemail」都能让上面那格绿。
   */
  it("不带 channel 时，落盘的那一行记的是配置里的主通道（镜像方向）", async () => {
    const h = await realApp();
    expect((await h.call("/admin/api/registrar/tend")).status).toBe(202);
    const rows = await h.history();
    expect(rows![0]!.primaryChannel, "没指定通道时应当按配置的主/备链跑").toBe("yyds");
  });

  /**
   * ⚠️⚠️ **真的 `probeChannel` 走没走到 `listDomains`。**
   *
   * 把全局 `fetch` 换成桩（`NativeFetcher.fetch` 调的就是它），于是这一格同时钉住三件事，
   * 而**任何一件都不是「返回了个数字」能冒充的**：
   * ① 真的发起了一次上游调用（把 `probeChannel` 的函数体换成 `return { ok:true, domains:0 }`
   *    ⇒ 零次 fetch ⇒ 红）；
   * ② 打的是**这条通道自己配的 baseUrl**（provider 是从配置里建出来的那一个，
   *    不是另建的第二份——`wire.ts` 那段「测的是抄件不是原件」的论证，就靠这一条成立）；
   * ③ 两条通道各走**各自适配器的**端点与响应形态（YYDS 是 `/v1/domains` + `data[].domain`，
   *    MoeMail 是 `/api/config` + 逗号分隔的 `emailDomains`）——两条通道**共用一个
   *    provider** 的话，其中一条的解析必然得到 0 个域名。
   */
  it("通道连通性走的是真 provider：打各自配的 baseUrl、各自的端点、各自的响应形态", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      const body = String(url).includes("/v1/domains")
        ? { data: [{ domain: "a.test" }, { domain: "b.test" }, { domain: "c.test" }] }
        : { emailDomains: "x.test,y.test" };
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });

    const h = await realApp();
    const yyds = await (await h.call("/admin/api/registrar/channels/yyds/test")).json() as
      { ok: boolean; domains: number };
    const moe = await (await h.call("/admin/api/registrar/channels/moemail/test")).json() as
      { ok: boolean; domains: number };

    expect(yyds.ok).toBe(true);
    expect(moe.ok).toBe(true);
    // **两条通道的域名数刻意不同**：相同的话，「两条共用同一个 provider」这种
    // 接错线的形态就不可观测了。
    expect(yyds.domains, "YYDS 那三个域名没被解析出来 —— provider 或响应形态接错了").toBe(3);
    expect(moe.domains, "MoeMail 那两个域名没被解析出来（它是逗号分隔的字符串，不是数组）").toBe(2);
    expect(urls, "真的 listDomains 一次都没被调到 —— 那个域名数是凭空来的").toEqual([
      "https://yyds.invalid/v1/domains",
      "https://moe.invalid/api/config",
    ]);
  });

  it("真 provider 上游返回非 2xx：200 + ok:false，且不回显上游细节", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));
    const h = await realApp();
    const res = await h.call("/admin/api/registrar/channels/yyds/test");
    expect(res.status, "测不通不是接口异常").toBe(200);
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("upstream_error");
    expect(JSON.stringify(body), "把上游的响应体回显出来了").not.toContain("nope");
  });

  /**
   * **真装配这一侧同样不许写存储。** 上面那格零写用的是夹具 A（注入的执行体
   * 天然什么都不写），它证明不了 `buildTendDeps` 那一截有没有顺手写点什么
   * ——而 `buildTendDeps` 里真的建了一个 `KeyPoolRepo`。
   */
  it("真装配的通道连通性测试同样零写、零 delete", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const st = new CountingStorage(new MemoryStorage());
    const { app } = await buildApp(REAL_ENV, st, workerRuntime());
    const before = { puts: st.puts, deletes: st.deletes };
    const res = await app.request(
      "/admin/api/registrar/channels/yyds/test", { method: "POST", headers: withKey },
    );
    expect(res.status).toBe(200);
    expect({ puts: st.puts, deletes: st.deletes }, "真装配那一截顺手写了存储").toEqual(before);
    expect(st.gets - before.puts >= 0).toBe(true);
  });

  /**
   * **上一格的夹具是 200 —— 它同样只量了成功那一支（评审发现的镜像另一半）。**
   *
   * 真装配这一侧要单独量的是：`buildTendDeps` 那一截 + 真 `StoreLogger` 合起来，
   * 失败请求**自己**这一次到底写不写。量出来是 **0**：事件进缓冲，
   * 落盘由 `logFlush` → `maybeFlush()` 决定，而 sink 的 `lastFlushAt` 在构造时就置成
   * `now()` ⇒ 同一个 isolate 上紧接着的这次请求隔不到 60 秒，落不了盘。
   * 「之后什么时候落、落几次」由上面夹具 A 那一格拿假时钟逐格量死
   *（1 次 put + 1 次 get，每 isolate 每天封顶 12 次），这里不重复。
   */
  it("真装配的通道连通性测试失败时：200 + ok:false，且这一次请求自己仍然 0 次 put", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("上游不可达"); });
    const st = new CountingStorage(new MemoryStorage());
    const { app } = await buildApp(REAL_ENV, st, workerRuntime());
    const before = { puts: st.puts, deletes: st.deletes };
    const res = await app.request(
      "/admin/api/registrar/channels/yyds/test", { method: "POST", headers: withKey },
    );
    expect(res.status).toBe(200);
    // **先确认真的走到了失败那一支**，否则下面那个 0 量的是成功路径。
    expect(await res.json()).toMatchObject({ ok: false, reason: "upstream_error" });
    expect({ puts: st.puts, deletes: st.deletes }, "失败请求自己这一次就落了盘").toEqual(before);
  });
});
