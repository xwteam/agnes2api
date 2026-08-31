import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorage } from "../../../src/adapters/storage-file.js";
import type { TendResult } from "../../../src/core/registrar/tender.js";
import type { Env } from "../../../src/entry/worker.js";

/**
 * 调度接线的守护测试。
 *
 * 存在的理由：把两个入口的调度触发**全部拔掉**（Node 的立即执行 + 定时器、
 * Worker 的 `ctx.waitUntil(tendOnce(...))`），原有 381 条用例照样全绿——也就是
 * 注册机可以完全不运行而 CI 毫无察觉。设计 §8 要求的是「Worker 的 scheduled 与
 * Node 的定时器**确实会调到 tendOnce**，且 REGISTRAR_ENABLED=false 时不会」，
 * 此前只实现了后半句，而且只覆盖了 Worker 那一半。
 *
 * 这里把 `tendOnce` 换成 spy（不打真实网络），断言的是"接线"本身：谁在什么时候
 * 调了它、间隔是不是配置里那个值、上一轮没结束时会不会重入。
 */

const tendOnceMock = vi.fn<(deps: unknown) => Promise<TendResult>>();

vi.mock("../../../src/core/registrar/tender.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/registrar/tender.js")>();
  return { ...actual, tendOnce: (deps: unknown) => tendOnceMock(deps) };
});

/**
 * 捕获 Node 入口注册的定时器。入口是显式从 `node:timers` 具名导入的
 * （为了拿到带 `unref()` 的 Node 版本），其余照搬真实模块。
 *
 * 「每轮重读配置」修复后调度循环是**自重排的 setTimeout 递归**（`src/core/tend-scheduler.ts`），
 * 不再是启动时注册一次、之后固定不变的 `setInterval`——每一轮结束（含重新读一次
 * 间隔）之后才会 push 新的一项，因此 `timers` 是一条随轮次增长的队列，不是「注册
 * 一次、以后复用同一个 fn」。取用时一律要显式等这一轮的重排落地（`timers.length`
 * 变化），不能假定它与 `tendOnceMock` 的调用计数同步——两者中间隔着一次真实的
 * `loadConfig` 存储读取。
 *
 * `setInterval` 也一并拦下（而不是让 `...actual` 透传真实实现）：一是防止「回退
 * 成 setInterval」这个回归在测试进程里悄悄起一个真的、每 30 分钟才触发一次的后台
 * 定时器；二是让下面「确实用的是 setTimeout」那条用例能直接断言 `intervalCalls`
 * 是空的，不必靠某个 `waitFor` 熬满 2 秒超时才发现回退——那种失败形态慢且不说明
 * 原因，见那条用例上方的说明。
 */
const timers: Array<{ fn: () => void; ms: number }> = [];
const intervalCalls: Array<{ fn: () => void; ms: number }> = [];

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    },
    setInterval: (fn: () => void, ms: number) => {
      intervalCalls.push({ fn, ms });
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    },
  };
});

const { main } = await import("../../../src/entry/node.js");
const worker = (await import("../../../src/entry/worker.js")).default;

const RESULT: TendResult = {
  skipped: false, available: 0, attempted: 0, minted: 0, mintedByChannel: {}, failures: [],
  // 本任务给 TendResult 加的四个字段（`tend:history` 要用）。手写字面量。
  at: 1000, primaryChannel: "yyds", durationMs: 0,
};

function deferred(): { promise: Promise<TendResult>; resolve: (v: TendResult) => void } {
  let resolve!: (v: TendResult) => void;
  const promise = new Promise<TendResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 让已经 resolve 的 promise 链跑完（宏任务一拍即可，setTimeout 未被 mock）。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * 等待某个条件成立。补池一轮里夹着真实的文件读（每轮重读配置），不是纯微任务，
 * 单靠一拍 `flush()` 不保证跑完；轮询到条件成立即可，超时就当失败。
 *
 * 本文件下面大多数 `waitFor(() => timers.length === N)` 用它的 2 秒超时兜底
 * ——如果 `node.ts` 回退成 `nodeSetInterval`，`timers` 永远不会变化，这些调用
 * 会各自等满 2 秒才报「等待条件超时」。这是已知的、**刻意接受**的次要信号：
 * 真正快、且给出明确断言消息的检测已经单独放在「调度接线」描述块最前面那条用例里
 * （拦 `setInterval` 单独计数，断言它恒为空，不依赖任何超时）。没有把这个模式
 * 铺开到本文件其余每一处 `waitFor` 调用，是因为那些调用各自还承担着别的、与
 * 这条回归无关的主要职责（等某一轮补池跑完、等某个存储写生效……），硬塞一条
 * 「或者 setInterval 也被调了」的旁路条件会让每一处的意图变得更难读，而收益
 * 只是把一个本来就有专门用例覆盖的次要信号从「慢」变成「更快一点点」。
 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 给"不该发生"的断言留出与 waitFor 同量级的观察窗口。 */
const settle = () => new Promise<void>((r) => setTimeout(r, 50));

function nodeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    GATEWAY_TOKEN: "t",
    PORT: "0",
    DATA_DIR: mkdtempSync(join(tmpdir(), "a2a-sched-")),
    REGISTRAR_ENABLED: "true",
    REGISTRAR_PRIMARY: "yyds",
    YYDS_API_KEY: "k",
    TEND_INTERVAL_MS: "1800000",
    ...extra,
  };
}

function close(server: Awaited<ReturnType<typeof main>>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface KvCounts { list: number; get: number; put: number; delete: number }

/**
 * 只实现 KvStorage 用到的四个方法，行为对齐真实 KV（存字符串、按 json 取回）。
 * 四种操作全数上：只数其中几种的计数桩，关于漏掉那几种的断言就是假的（早先的教训）。
 */
function fakeKv(counts: KvCounts = { list: 0, get: 0, put: 0, delete: 0 }): Env["POOL"] {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      counts.get++;
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    async put(key: string, value: string) {
      counts.put++;
      store.set(key, value);
    },
    async delete(key: string) {
      counts.delete++;
      store.delete(key);
    },
    async list({ prefix }: { prefix?: string } = {}) {
      counts.list++;
      const keys = [...store.keys()]
        .filter((k) => prefix === undefined || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as Env["POOL"];
}

function workerEnv(extra: Record<string, unknown> = {}): Env {
  return {
    GATEWAY_TOKEN: "t",
    POOL: fakeKv(),
    REGISTRAR_ENABLED: "true",
    REGISTRAR_PRIMARY: "yyds",
    YYDS_API_KEY: "k",
    ...extra,
  } as unknown as Env;
}

function controller(): ScheduledController {
  return { scheduledTime: Date.now(), cron: "*/30 * * * *" } as ScheduledController;
}

function fakeCtx(): { ctx: ExecutionContext; waited: Array<Promise<unknown>> } {
  const waited: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, waited };
}

beforeEach(() => {
  tendOnceMock.mockReset();
  timers.length = 0;
  intervalCalls.length = 0;
});

describe("调度接线：两个入口确实会调到 tendOnce", () => {
  it("确实用 setTimeout 自重排，不是 setInterval——回退成 setInterval 要能被一句断言快速抓住，不必靠某个 waitFor 熬满 2 秒超时", async () => {
    // 简报变异表最后一行原判定「回退到 nodeSetInterval 需人工核对，单测覆盖不到」
    // 已经不成立——本文件其余每一条依赖 `timers.length` 的 waitFor 事实上都会在
    // 回退发生时超时变红（`timers` 永远拿不到东西）。但「等待条件超时」这个失败
    // 形态慢（每条 2 秒，CI 里会连环拖慢）且不说明原因；这里把同一件事收敛成一条
    // 立即、明确的断言：`node:timers` 的 setInterval 与 setTimeout 被同一个 mock
    // 一起拦下并分别计数，冷启动那一轮走的是 `void tick()` 直接调用（不经过任何
    // 定时器），所以 `tendOnceMock` 的调用信号在「对/错」两条实现下同样快、同样
    // 可靠，可以拿来当"重排该发生了"的锚点，而不必赌 timers 会不会变化。
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await main(nodeEnv());
    try {
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
      // 重排还要经过一次真实的 loadConfig 读取，给它一点异步余量；但等的是
      // 「两条 mock 合计至少一条」，不偏向哪一条实现，所以两条路径收敛的时间
      // 量级相同，不会因为走了错误分支反而更快满足条件、抢跑掉后面的断言。
      await waitFor(() => timers.length + intervalCalls.length >= 1);
      expect(
        intervalCalls,
        "回退成 setInterval 会让补池间隔重新冻结在启动时刻——这正是「每轮重读配置」要修的缺陷",
      ).toHaveLength(0);
      expect(timers).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
      await close(server);
    }
  });

  it("Node 侧：启动立即跑一轮，并按 TEND_INTERVAL_MS 重排定时器，回调也确实调到 tendOnce", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await main(nodeEnv({ TEND_INTERVAL_MS: "1800000" }));
    try {
      // ① 冷启动立即跑一轮：否则要空等满一个间隔（默认 30 分钟）才开始补池。
      await waitFor(() => tendOnceMock.mock.calls.length === 1);

      // ② 重排的定时器要等这一轮真正走完（含重新读一次间隔的真实存储读取）才会
      // 出现，不能假定它与上面那次 tendOnce 调用同步落地，两者之间隔着一次 IO。
      await waitFor(() => timers.length === 1);
      expect(timers[0]!.ms).toBe(1_800_000);

      // ③ 定时器回调不是空壳：到点确实会再跑一轮。
      timers[0]!.fn();
      await waitFor(() => tendOnceMock.mock.calls.length === 2);
      // 等第二轮自己也重排完再收尾——不然它残留的 tick() 链会在下一个用例的
      // `beforeEach` 清空 timers/tendOnceMock 之后才落地，污染下一条用例的计数。
      await waitFor(() => timers.length === 2);

      // 传进去的确实是装配好的补池依赖，不是随便一个对象。
      const deps = tendOnceMock.mock.calls[0]![0] as { config: { enabled: boolean }; providers: Record<string, unknown> };
      expect(deps.config.enabled).toBe(true);
      expect(deps.providers.yyds).toBeDefined();
    } finally {
      logSpy.mockRestore();
      await close(server);
    }
  });

  it("Node 侧：TEND_INTERVAL_MS 改了，重排的间隔跟着改（间隔不是写死的）", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 60 秒远小于单轮最坏耗时，会触发配置告警，这里只关心间隔取值。
    const server = await main(nodeEnv({ TEND_INTERVAL_MS: "60000" }));
    try {
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
      await waitFor(() => timers.length === 1);
      expect(timers[0]!.ms).toBe(60_000);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      await close(server);
    }
  });

  it("Node 侧：REGISTRAR_ENABLED=false（默认）时一次都不调 tendOnce", async () => {
    // 定时器照常存在（见下面「每轮重读配置」那条：关着的时候也要能从存储打开），但每一轮
    // buildTendDeps 都会在构造任何 provider 之前返回 null，tendOnce 一次也不该被调到
    // ——这正是设计 §8 要求的后半句。
    tendOnceMock.mockResolvedValue(RESULT);
    const server = await main({
      GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: mkdtempSync(join(tmpdir(), "a2a-sched-off-")),
    });
    try {
      await waitFor(() => timers.length === 1);
      expect(tendOnceMock).not.toHaveBeenCalled();
      timers[0]!.fn();
      // 等第二轮自己重排完（而不是盲等 settle）：既让断言更确定，也避免这一轮
      // 残留的 tick() 链在下一条用例重置 timers/tendOnceMock 之后才落地。
      await waitFor(() => timers.length === 2);
      expect(tendOnceMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("Worker 侧：scheduled 交给 ctx.waitUntil 的 promise 确实会调用 tendOnce", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { ctx, waited } = fakeCtx();
    try {
      await worker.scheduled!(controller(), workerEnv(), ctx);
      expect(waited).toHaveLength(1);
      await waited[0];
      expect(tendOnceMock).toHaveBeenCalledTimes(1);
      const deps = tendOnceMock.mock.calls[0]![0] as { config: { enabled: boolean }; providers: Record<string, unknown> };
      expect(deps.config.enabled).toBe(true);
      expect(deps.providers.yyds).toBeDefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("Worker 侧：REGISTRAR_ENABLED 未开时不调 tendOnce（不触达邮箱/Agnes）", async () => {
    // 注意口径：这里承诺的是**不产生外部副作用**（不触达邮箱服务、不触达 Agnes），
    // 而不是「一次存储访问都没有」——loadConfig 本来就要读一次配置，从某一版
    // 起索引对账也会读一次存储，见下面那条用例。
    tendOnceMock.mockResolvedValue(RESULT);
    const { ctx, waited } = fakeCtx();
    await worker.scheduled!(controller(), workerEnv({ REGISTRAR_ENABLED: undefined, REGISTRAR_PRIMARY: undefined }), ctx);
    expect(tendOnceMock).not.toHaveBeenCalled();
    expect(waited).toHaveLength(0);
  });
});

describe("key 池索引对账接在「注册机是否启用」的判断之前", () => {
  // 两个入口都是 `if (!deps) return`，对账放在它后面等于**注册机关着时永不对账**，
  // 而索引残留（孤儿记录 / 幽灵索引项）恰恰不挑注册机开没开。挪到后面这两条即变红。

  it("Worker 侧：REGISTRAR_ENABLED 未开，scheduled() 仍然对账一次（产生 list）", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const counts: KvCounts = { list: 0, get: 0, put: 0, delete: 0 };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { ctx, waited } = fakeCtx();
    try {
      await worker.scheduled!(
        controller(),
        workerEnv({ POOL: fakeKv(counts), REGISTRAR_ENABLED: undefined, REGISTRAR_PRIMARY: undefined }),
        ctx,
      );
      expect(tendOnceMock, "注册机确实是关着的").not.toHaveBeenCalled();
      expect(waited).toHaveLength(0);
      expect(counts.list, "对账必须发生在「注册机是否启用」的判断之前").toBe(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("Node 侧：REGISTRAR_ENABLED 未开，每一轮仍然对账一次（产生 list）", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const listSpy = vi.spyOn(FileStorage.prototype, "list");
    const server = await main({
      GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: mkdtempSync(join(tmpdir(), "a2a-sched-recon-")),
    });
    try {
      // 启动即跑的那一轮：注册机关着，但对账照做。
      await waitFor(() => listSpy.mock.calls.some(([prefix]) => prefix === "key:"));
      expect(tendOnceMock, "注册机确实是关着的").not.toHaveBeenCalled();
      // 冷启动那一轮的重排要等它真正落地（含重新读一次间隔），再取用那个定时器
      // ——`timers[0]` 在它出现之前是 undefined，直接调用会抛，不能假定它与上面
      // 那次对账同步出现。
      await waitFor(() => timers.length === 1);

      // 下一次定时触发**再**对一次账——挡住「把对账挪到 main() 里只在启动时做一次」
      // 这个变异（那样挪完启动那条断言照样绿）。
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const listsOfKeys = () => listSpy.mock.calls.filter(([p]) => p === "key:").length;
      const before = listsOfKeys();
      try {
        timers[0]!.fn();
        await waitFor(() => listsOfKeys() > before);
        // 等第二轮自己也重排完再收尾，避免它残留的 tick() 链污染下一条用例。
        await waitFor(() => timers.length === 2);
      } finally {
        warnSpy.mockRestore();
      }
      expect(tendOnceMock).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      infoSpy.mockRestore();
      await close(server);
    }
  });

  /**
   * **Node 入口的补池事件落库。**
   *
   * ⚠️ **这一格是变异验证逼出来的，成因如实登记**：M7 的 Node 那一半
   * （`src/entry/node.ts` 的 `finally` 里删掉 `await deps.flush()`）在补上这一格
   * **之前是 ESCAPED 的**——`tests/contract/registrar-events.test.ts` 的
   * 「一轮补池之后，event: 键空间里确实有 registrar.* 事件」只驱动
   * **Worker** 入口（契约测试要在 workerd 下也跑一遍，而 `src/entry/node.ts`
   * 依赖 `@hono/node-server` / `node:timers`，在 workerd 里 import 不进去）。
   * 于是 Node 侧那条 `finally` **一条测试都没有守着**，删掉它全套用例照样全绿。
   * 这不是"性质不成立"，是**观测点整个缺失**。
   *
   * `tendOnce` 仍然是这个文件统一的 mock（本格不关心补池本身），但它这次**经由
   * 注入的 logger 打一条 `registrar.*` 事件**——那正是生产里真 `tendOnce` 做的事
   * （`registrar.round_budget_impossible` 等二十多个调用点）。除它之外，入口、
   * `buildTendDeps`、`StoreLogger`、`FileStorage` 全都是真的。
   *
   * 存储是**真的 `FileStorage`**（真实 fs IO，有不可忽略的异步延迟），所以
   * "有没有 await 那次 flush" 在这里是可观测的——零延迟替身抓不住这条
   * （第 8 种候选形态）。
   */
  it("Node 侧：一轮补池之后 event: 里有 registrar.*，tend:history 里有一条 trigger=cron", async () => {
    tendOnceMock.mockImplementation(async (deps: unknown) => {
      (deps as { logger: { log: (e: unknown) => void } }).logger.log({
        level: "error", event: "registrar.round_budget_impossible", msg: "探针事件",
      });
      return RESULT;
    });
    const dir = mkdtempSync(join(tmpdir(), "a2a-sched-tendlog-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await main(nodeEnv({ DATA_DIR: dir }));
    try {
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
      // 等这一轮自己重排完 —— 重排落地意味着 runTend 的 finally（含那次 flush）
      // 已经跑完，不必靠 sleep 猜时机。
      await waitFor(() => timers.length === 1);

      const storage = new FileStorage(dir);
      const eventKeys = await storage.list("event:");
      expect(eventKeys.length, "补池事件一条都没落库").toBeGreaterThan(0);
      const events = (await Promise.all(
        eventKeys.map((k) => storage.get<Array<{ event: string }>>(k)),
      )).flatMap((a) => a ?? []);
      expect(events.map((e) => e.event)).toContain("registrar.round_budget_impossible");

      const history = await storage.get<Array<{ trigger: string }>>("tend:history");
      expect(history?.length, "tend:history 里没有这一轮").toBe(1);
      expect(history?.[0]?.trigger).toBe("cron");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      await close(server);
      tendOnceMock.mockReset();
    }
  });

  /**
   * **Node 侧那次 flush 必须被 `await`，不能是 fire-and-forget。**
   *
   * ⚠️ **这一格是评审替我撤销「登记不修」之后补的，成因如实登记**：上面那格用
   * `waitFor(() => timers.length === 1)` 当观测点，而 `waitFor` 的轮询间隔足够
   * 那次 fire-and-forget 的 fs 写完成 ⇒ **把 `await deps.flush()` 改成
   * `void deps.flush()`，上面那格照样绿**。我当时把它登记成「观测点的时间分辨率
   * 不够，属固有极限」——**那句话是错的：分辨率是夹具的性质，不是固有极限。**
   *
   * 修法是给**事件分片的写**注入一段真实延迟（80ms），比调度器重排那条链长得多。
   * 于是"重排已经落地"这一刻，只有**真的 await 过**的那条路径才可能已经落盘。
   *
   * ⚠️ **不许改成纯顺序断言**（记录 `put` 与重排的先后）：`void flush()` 的
   * `get→put` 与调度器 `readIntervalMs()` 那次读是同量级的微任务竞速，顺序本身
   * 不确定，**未变异下会绿、变异下也会绿**。判据必须是**延迟**，不是顺序。
   *
   * 这是「双运行时对等——差异必须被断言而非容忍」里 Node 那一半最后一个没被
   * 断言的口子（Worker 那一半由 `tests/contract/registrar-events.test.ts` 的
   * 「waitUntil 的 promise 落定时事件已经落盘，不是之后某个时刻（真实异步延迟下可观测）」
   * 用带 5ms 延迟的替身盖住）。
   */
  it("Node 侧：那次 flush 是被 await 的（事件写注入 80ms 延迟后仍然赶在重排之前落盘）", async () => {
    tendOnceMock.mockImplementation(async (deps: unknown) => {
      (deps as { logger: { log: (e: unknown) => void } }).logger.log({
        level: "error", event: "registrar.round_budget_impossible", msg: "探针事件",
      });
      return RESULT;
    });
    const dir = mkdtempSync(join(tmpdir(), "a2a-sched-await-"));
    const origPut = FileStorage.prototype.put;
    const putSpy = vi.spyOn(FileStorage.prototype, "put").mockImplementation(
      async function (this: FileStorage, k: string, v: unknown, e?: number) {
        // 只拖慢**事件分片**那一次写：拖慢全部会把索引对账也拖进来，
        // 那时红的可能是别的东西。
        if (k.startsWith("event:")) await new Promise((r) => setTimeout(r, 80));
        return origPut.call(this, k, v, e) as Promise<void>;
      } as typeof FileStorage.prototype.put,
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await main(nodeEnv({ DATA_DIR: dir }));
    try {
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
      await waitFor(() => timers.length === 1);
      // **不额外等待**：重排一落地就查。fire-and-forget 的那 80ms 还没走完。
      const storage = new FileStorage(dir);
      expect(
        (await storage.list("event:")).length,
        "重排落地时事件还没落盘 ⇒ 那次 flush 没有被 await",
      ).toBeGreaterThan(0);
    } finally {
      putSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
      await close(server);
      tendOnceMock.mockReset();
    }
  });
  /**
   * **评审那条发现的 Node 那一半。**
   *
   * ⚠️ **成因如实登记**：`5e29624` 只给 Worker 侧补了覆盖，Node 侧那两段
   *（`logger.log(round_failed)` + `recordCrashedRound`）**整个删掉，全量 1541 全绿**
   * ——M6node / M7node / M13node 三条都补了 Node 侧，唯独这个 **Critical** 没补，
   * 直接违反「双运行时对等：差异必须被**断言**而非被容忍」。
   *
   * 防住的真实故障与 Worker 侧同一条：`tendOnce` 一抛，`recordRound` 整个被跳过
   *（它排在 `try` 里、在 `tendOnce` 之后），而 `catch` 里若只有裸 `console.error`
   * 就进不了事件缓冲 ⇒ `flush()` 首行就 return ⇒ **面板上这一轮什么都没有，
   * 与「注册机根本没跑」逐字节不可区分**。
   */
  it("Node 侧：整轮抛错时 event: 里有 registrar.round_failed，tend:history 里有 round_crashed", async () => {
    tendOnceMock.mockImplementation(async () => {
      throw new Error("补池在中途炸了");
    });
    const dir = mkdtempSync(join(tmpdir(), "a2a-sched-crash-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await main(nodeEnv({ DATA_DIR: dir }));
    try {
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
      // 等这一轮重排落地 ⇒ runTend 的 finally（含那次 flush）已经跑完。
      await waitFor(() => timers.length === 1);

      const storage = new FileStorage(dir);
      const eventKeys = await storage.list("event:");
      const events = (await Promise.all(
        eventKeys.map((k) => storage.get<Array<{ event: string }>>(k)),
      )).flatMap((a) => a ?? []);
      expect(
        events.map((e) => e.event),
        "抛错那一轮一条事件都没落库 —— 与「注册机根本没跑」不可区分",
      ).toContain("registrar.round_failed");

      const history = await storage.get<Array<{
        trigger: string; skipped: boolean; minted: number; attempted: number;
        failures: Array<{ reason: string }>;
      }>>("tend:history");
      expect(history?.length, "抛错那一轮在补池历史上没有占一格").toBe(1);
      expect(history?.[0]?.failures.map((f) => f.reason)).toEqual(["round_crashed"]);
      expect(history?.[0]?.minted).toBe(0);
      expect(history?.[0]?.attempted).toBe(0);
      expect(
        history?.[0]?.skipped,
        "`skipped` 有且只有一个含义（注册机关着），拿它表示「崩了」就是伪造",
      ).toBe(false);
      // 控制台那一路一行不减（`log-prefix` 那条契约）。
      expect(errSpy).toHaveBeenCalledWith("[registrar] 补池失败", expect.any(Error));
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      await close(server);
      tendOnceMock.mockReset();
    }
  });


});

describe("Node 侧每轮重读配置（与 Worker 每次 Cron 重读对齐）", () => {
  it("从存储把注册机打开/关掉，都无需重启进程就能生效", async () => {
    // 面板就是这份配置的编辑器（设计 §11）。此前 Node 侧把配置冻结在启动
    // 时刻：启动时关着就根本没有定时器（怎么改存储都打不开），启动时开着就从
    // 存储关也关不掉，而 Worker 侧每次 Cron 都重读——同一个面板操作两种形态
    // 行为不同。
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "a2a-sched-live-"));
    const storage = new FileStorage(dir);
    const server = await main({ GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: dir });
    try {
      // 启动时未启用：一轮都不该跑，但重排仍会发生——定时器必须在关闭状态下
      // 也继续存在（这正是本条要守的行为：不然存储怎么改都打不开）。
      await waitFor(() => timers.length === 1);
      expect(tendOnceMock).not.toHaveBeenCalled();

      // 面板（这里直接写存储）把注册机打开。
      await storage.put("config", {
        registrar: {
          enabled: true, primary: "yyds",
          yyds: { baseUrl: "https://y.test", apiKey: "k" },
        },
      });
      timers[timers.length - 1]!.fn();
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
      // 等这一轮自己的重排也落地，再取「当前」那一个定时器去关闭注册机——
      // 用固定下标 `timers[0]` 会重新触发已经跑过的那一轮。
      await waitFor(() => timers.length === 2);

      // 再从存储关掉，下一轮就该停——不必重启进程。
      await storage.put("config", { registrar: { enabled: false } });
      timers[timers.length - 1]!.fn();
      // 等第三轮（关闭后那一轮）也重排完再断言收尾，避免它残留的 tick() 链
      // 污染下一条用例的 timers/tendOnceMock 计数。
      await waitFor(() => timers.length === 3);
      expect(tendOnceMock).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      await close(server);
    }
  });

  it("从存储把 TEND_INTERVAL_MS 本身改掉，下一轮重排就跟着用新值——「每轮重读配置」不能只挡住 enabled/disabled 这一半", async () => {
    // 上面那条只验证了「关/开」会热更新，没验证「间隔本身」会热更新——这正是
    // 那条要修的缺陷本体：此前间隔冻结在启动时刻，其余配置项每一轮都重读。
    // 用 mutation 实测过：把 node.ts 里 readIntervalMs 换回返回启动快照
    // （`registrar.tendIntervalMs`），上面那条「打开/关掉」用例照样全绿——
    // 只测 enabled/disabled 逃不出这个变异，必须单独测间隔值本身。
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "a2a-sched-interval-"));
    const storage = new FileStorage(dir);
    // 刻意不设 TEND_INTERVAL_MS 环境变量：env 优先级高于存储（见 registrarFromEnv/
    // posInt），设了就测不出「从存储改」这条路径，间隔会被 env 钉死。
    const server = await main({
      GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: dir,
      REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k",
    });
    try {
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
      await waitFor(() => timers.length === 1);
      expect(timers[0]!.ms, "冷启动用的是默认值").toBe(1_800_000);

      // 面板（这里直接写存储）把间隔改掉。新旧值刻意不同——都给同一个值的话，
      // 把实现改回读启动快照也会通过，是无冲突 fixture（测试质量清单第 1 类）。
      await storage.put("config", {
        registrar: {
          enabled: true, primary: "yyds",
          yyds: { baseUrl: "https://y.test", apiKey: "k" },
          tendIntervalMs: 60_000,
        },
      });
      timers[0]!.fn();
      await waitFor(() => tendOnceMock.mock.calls.length === 2);
      await waitFor(() => timers.length === 2);
      expect(timers[1]!.ms, "第二次重排必须用新读到的值，不是启动时那份快照").toBe(60_000);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      await close(server);
    }
  });
});

describe("轮级墙钟预算只装在有平台墙钟上限的那个入口上", () => {
  // 预算本身**做什么**由 tender.test.ts 的三条用例守（真时钟推进、真的少跑一次、
  // 每次尝试都完整走完）。这里守的是接线：预算只能出现在 Worker 那一侧，而且它的
  // 取值必须同时满足两条真实约束——比 Cron 墙钟小（否则等于没有余量，照样会被平台
  // 从中间砍断、邮箱漏删），又比默认配置下的单次最坏耗时大（否则一次尝试都不敢
  // 开始，注册机直接瘫掉）。只断言「有这个字段」是不够的。

  /** Cloudflare Cron Trigger 单次调用的墙钟上限。 */
  const CRON_WALL_CLOCK_MS = 900_000;
  /** 默认配置下单次铸 key 的最坏墙钟：CODE_TIMEOUT_MS(120s) × 通道数(最多 2)。 */
  const WORST_ATTEMPT_DEFAULT_MS = 120_000 * 2;

  function budgetOf(): number | undefined {
    const deps = tendOnceMock.mock.calls[0]![0] as { roundBudgetMs?: number };
    return deps.roundBudgetMs;
  }

  it("Worker 侧传预算，且取值留出了余量、又足够开始一次尝试", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { ctx, waited } = fakeCtx();
    try {
      await worker.scheduled!(controller(), workerEnv(), ctx);
      await waited[0];
      const budget = budgetOf();
      expect(budget).toBeDefined();
      expect(budget!).toBeLessThan(CRON_WALL_CLOCK_MS);
      expect(budget!).toBeGreaterThan(WORST_ATTEMPT_DEFAULT_MS);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("Node 侧不传预算（没有平台墙钟上限，硬塞一个反而会平白少铸 key）", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await main(nodeEnv());
    try {
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
      expect(budgetOf()).toBeUndefined();
      // 等冷启动那一轮自己的重排也落地再收尾——不然它残留的 tick() 链会在后面
      // 某条用例的 `beforeEach` 清空 timers 之后才落地，往里面塞一条不属于那条
      // 用例的幽灵记录（`timers.length` 被污染，后续用例里下标全部错位）。
      await waitFor(() => timers.length === 1);
    } finally {
      logSpy.mockRestore();
      await close(server);
    }
  });
});

describe("M2 收尾日志要把 TendResult.failures 的归因打出来", () => {
  // failures 此前从未被任何一处代码引用（全仓 grep 只命中 tender.ts 自身），
  // 于是「Agnes 加了人机校验」「备通道凭据没配」这类持续性故障在生产里唯一的
  // 信号就是一行 minted=0。两个入口必须给出同一份口径。
  //
  // fixture 刻意用**两种不同的 reason + 两条不同的通道**，且各自次数不同（3 vs 1）：
  // 只打第一条、只打通道、只打 reason、丢掉计数，任何一种偷工都会被抓出来。
  const FAILED: TendResult = {
    skipped: false, available: 0, attempted: 4, minted: 0, mintedByChannel: {},
    at: 1000, primaryChannel: "yyds", durationMs: 0,
    failures: [
      { reason: "register_failed", channel: "yyds" },
      { reason: "register_failed", channel: "yyds" },
      { reason: "register_failed", channel: "yyds" },
      { reason: "code_timeout", channel: "moemail" },
    ],
  };

  function reasonsLine(warnSpy: { mock: { calls: unknown[][] } }): string | undefined {
    return warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("reasons="));
  }

  it("Node 侧：minted < attempted 时 warn 出聚合归因", async () => {
    tendOnceMock.mockResolvedValue(FAILED);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = await main(nodeEnv());
    try {
      await waitFor(() => reasonsLine(warnSpy) !== undefined);
      const line = reasonsLine(warnSpy)!;
      expect(line).toContain("yyds:register_failed×3");
      expect(line).toContain("moemail:code_timeout×1");
      // warn 落地时这一轮的 tick() 还没走到重排那一步——等它自己也重排完再
      // 收尾，否则残留的 tick() 链会在后面某条用例重置 timers 之后才落地，
      // 往里面塞一条幽灵记录（本任务复验时实测抓到过：「不可并发重入」用例因此间歇性超时）。
      await waitFor(() => timers.length === 1);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      await close(server);
    }
  });

  it("Worker 侧：minted < attempted 时 warn 出同一份聚合归因", async () => {
    tendOnceMock.mockResolvedValue(FAILED);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { ctx, waited } = fakeCtx();
    try {
      await worker.scheduled!(controller(), workerEnv(), ctx);
      await waited[0];
      const line = reasonsLine(warnSpy);
      expect(line).toBeDefined();
      expect(line).toContain("yyds:register_failed×3");
      expect(line).toContain("moemail:code_timeout×1");
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("名额全部铸出时不打这条 warn（不是无条件噪音）", async () => {
    tendOnceMock.mockResolvedValue({
      skipped: false, available: 0, attempted: 2, minted: 2, mintedByChannel: { yyds: 2 }, failures: [],
      at: 1000, primaryChannel: "yyds", durationMs: 0,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { ctx, waited } = fakeCtx();
    try {
      await worker.scheduled!(controller(), workerEnv(), ctx);
      await waited[0];
      expect(reasonsLine(warnSpy)).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("补池轮次不可并发重入", () => {
  it("Node 侧：上一轮还没结束时，同一回调被并发触发会被跳过并留痕", async () => {
    // 递归 setTimeout 天然不会自己和自己重叠——下一轮的定时器要等本轮 resolve
    // 之后才排上，这正是它与 setInterval 的本质差别（见下面另一条用例）。
    // 改成自重排之后 inFlight 守卫防的不再是「定时器自己撞自己」，而是「同一个回调
    // 被并发触发两次」——生产里对应面板的『立即补池』按钮与定时轮本身
    // 撞在一起（两者都会调用 runOnce）。这里用手动把同一个 fn 连续调用两次来
    // 模拟这种撞车。
    const gate = deferred();
    tendOnceMock.mockResolvedValueOnce(RESULT).mockImplementation(() => gate.promise);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await main(nodeEnv());
    try {
      // 冷启动那一轮先放行、正常收尾，拿到它重排出来的定时器。
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
      await waitFor(() => timers.length === 1);
      const fire = timers[0]!.fn;

      // 第二轮：到点触发，tendOnce 卡在 gate 上，本轮仍在进行中。
      fire();
      await waitFor(() => tendOnceMock.mock.calls.length === 2);

      // 同一个回调再触发一次：inFlight 已经在第一次同步执行里被置 true
      // （`runTend` 的 `await` 之前就设置），第二次调用的 runOnce 必须被挡住
      // ——但注意 `tick()` 自己的重排（readIntervalMs + setTimer）不受 inFlight
      // 影响，两次触发各自独立完成自己的重排，所以此后 `timers` 会独立多出
      // 不止一条记录。下面不再假定"一次触发对应一条新记录"，只认 tendOnce
      // 的调用计数——这才是 inFlight 守卫真正承诺的东西。
      fire();
      await settle();
      expect(tendOnceMock).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("上一轮补池仍在进行"));

      // 放行卡住的那一轮：守卫必须自己解开，不能把补池永久卡死。持续触发新
      // 出现的定时器直到 tendOnce 真的又被调用一次——被挡住那次触发自己的
      // 重排会先落地但不会推进调用计数（它的 runOnce 从未真正跑过 tendOnce），
      // 只有"卡在 gate 上那一轮"自己重排出来的那一条才会。不追踪具体下标，
      // 只认结果，两者都会被这个循环覆盖到。
      gate.resolve(RESULT);
      let fired = timers.length;
      await waitFor(() => {
        while (fired < timers.length) timers[fired++]!.fn();
        return tendOnceMock.mock.calls.length === 3;
      });
      // 让促成第三次调用的那条 tick() 链自己也重排完再收尾，避免残留的
      // 异步链拖到下一条用例（如果以后这条不再是文件里最后一个用例）才落地。
      // 用条件等待而不是固定 settle()：`fired` 在上面那个 waitFor 的最后一次
      // 成功轮询里已经推进到与当时的 `timers.length` 相等，所以"新出现一条"
      // 就是"促成第三次调用的那条链自己也 push 完了"——固定等待正是本任务
      // 复验时抓到的那一类 flaky 根源，这里不该是唯一的例外。
      await waitFor(() => timers.length > fired);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      await close(server);
    }
  });

  it("Worker 侧：上一轮的 KV 短锁还在时，本次 Cron 触发被跳过", async () => {
    const gate = deferred();
    tendOnceMock.mockImplementation(() => gate.promise);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // 同一个 env（同一个 KV）才谈得上锁：Cloudflare 不会串行化重叠的 Cron 调用。
    const env = workerEnv();
    const { ctx, waited } = fakeCtx();
    try {
      await worker.scheduled!(controller(), env, ctx);
      expect(tendOnceMock).toHaveBeenCalledTimes(1);
      expect(waited).toHaveLength(1);

      await worker.scheduled!(controller(), env, ctx);
      expect(tendOnceMock).toHaveBeenCalledTimes(1);
      expect(waited).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("跳过本次 Cron 触发"));

      // 上一轮结束 → 锁释放 → 下一次 Cron 恢复正常。
      gate.resolve(RESULT);
      await waited[0];
      await worker.scheduled!(controller(), env, ctx);
      expect(tendOnceMock).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("Worker 侧：补池抛错也会释放锁，下一次 Cron 不会被永久挡住", async () => {
    tendOnceMock.mockRejectedValue(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = workerEnv();
    const { ctx, waited } = fakeCtx();
    try {
      await worker.scheduled!(controller(), env, ctx);
      await waited[0];
      await worker.scheduled!(controller(), env, ctx);
      expect(tendOnceMock).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenCalledWith("[registrar] 补池失败", expect.any(Error));
    } finally {
      errSpy.mockRestore();
    }
  });
});
