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
 * 捕获 Node 入口注册的定时器。只替换 `setInterval`，其余照搬真实模块——入口是
 * 显式从 `node:timers` 具名导入的（为了拿到带 `unref()` 的 Node 版本）。
 */
const intervals: Array<{ fn: () => void; ms: number }> = [];

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    setInterval: (fn: () => void, ms: number) => {
      intervals.push({ fn, ms });
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    },
  };
});

const { main } = await import("../../../src/entry/node.js");
const worker = (await import("../../../src/entry/worker.js")).default;

const RESULT: TendResult = { skipped: false, available: 0, attempted: 0, minted: 0, failures: [] };

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

/** 只实现 KvStorage 用到的四个方法，行为对齐真实 KV（存字符串、按 json 取回）。 */
function fakeKv(): Env["POOL"] {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cacheStatus: null };
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
  intervals.length = 0;
});

describe("C3 调度接线：两个入口确实会调到 tendOnce", () => {
  it("Node 侧：启动立即跑一轮，并按 TEND_INTERVAL_MS 注册定时器，回调也确实调到 tendOnce", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await main(nodeEnv({ TEND_INTERVAL_MS: "1800000" }));
    try {
      // ① 冷启动立即跑一轮：否则要空等满一个间隔（默认 30 分钟）才开始补池。
      await waitFor(() => tendOnceMock.mock.calls.length === 1);

      // ② 定时器真的注册了，且用的是配置里的间隔（不是硬编码的常量）。
      expect(intervals).toHaveLength(1);
      expect(intervals[0]!.ms).toBe(1_800_000);

      // ③ 定时器回调不是空壳：到点确实会再跑一轮。
      intervals[0]!.fn();
      await waitFor(() => tendOnceMock.mock.calls.length === 2);

      // 传进去的确实是装配好的补池依赖，不是随便一个对象。
      const deps = tendOnceMock.mock.calls[0]![0] as { config: { enabled: boolean }; providers: Record<string, unknown> };
      expect(deps.config.enabled).toBe(true);
      expect(deps.providers.yyds).toBeDefined();
    } finally {
      logSpy.mockRestore();
      await close(server);
    }
  });

  it("Node 侧：TEND_INTERVAL_MS 改了，定时器的间隔跟着改（间隔不是写死的）", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 60 秒远小于单轮最坏耗时，会触发配置告警，这里只关心间隔取值。
    const server = await main(nodeEnv({ TEND_INTERVAL_MS: "60000" }));
    try {
      expect(intervals).toHaveLength(1);
      expect(intervals[0]!.ms).toBe(60_000);
      // 等启动那一轮跑完再收尾，否则它会拖到下一个用例里去调 spy。
      await waitFor(() => tendOnceMock.mock.calls.length === 1);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      await close(server);
    }
  });

  it("Node 侧：REGISTRAR_ENABLED=false（默认）时一次都不调 tendOnce", async () => {
    // 定时器照常存在（见下面 I4 那条：关着的时候也要能从存储打开），但每一轮
    // buildTendDeps 都会在构造任何 provider 之前返回 null，tendOnce 一次也不该被调到
    // ——这正是设计 §8 要求的后半句。
    tendOnceMock.mockResolvedValue(RESULT);
    const server = await main({
      GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: mkdtempSync(join(tmpdir(), "a2a-sched-off-")),
    });
    try {
      await settle();
      expect(tendOnceMock).not.toHaveBeenCalled();
      intervals[0]?.fn();
      await settle();
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

  it("Worker 侧：REGISTRAR_ENABLED 未开时不调 tendOnce（零副作用）", async () => {
    tendOnceMock.mockResolvedValue(RESULT);
    const { ctx, waited } = fakeCtx();
    await worker.scheduled!(controller(), workerEnv({ REGISTRAR_ENABLED: undefined, REGISTRAR_PRIMARY: undefined }), ctx);
    expect(tendOnceMock).not.toHaveBeenCalled();
    expect(waited).toHaveLength(0);
  });
});

describe("I4 Node 侧每轮重读配置（与 Worker 每次 Cron 重读对齐）", () => {
  it("从存储把注册机打开/关掉，都无需重启进程就能生效", async () => {
    // P3 的面板就是这份配置的编辑器（设计 §11）。此前 Node 侧把配置冻结在启动
    // 时刻：启动时关着就根本没有定时器（怎么改存储都打不开），启动时开着就从
    // 存储关也关不掉，而 Worker 侧每次 Cron 都重读——同一个面板操作两种形态
    // 行为不同。
    tendOnceMock.mockResolvedValue(RESULT);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "a2a-sched-live-"));
    const storage = new FileStorage(dir);
    const server = await main({ GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: dir });
    try {
      // 启动时未启用：一轮都不该跑。
      await settle();
      expect(tendOnceMock).not.toHaveBeenCalled();

      // 面板（这里直接写存储）把注册机打开。
      await storage.put("config", {
        registrar: {
          enabled: true, primary: "yyds",
          yyds: { baseUrl: "https://y.test", apiKey: "k" },
        },
      });
      intervals[0]!.fn();
      await waitFor(() => tendOnceMock.mock.calls.length === 1);

      // 再从存储关掉，下一轮就该停——不必重启进程。
      await storage.put("config", { registrar: { enabled: false } });
      intervals[0]!.fn();
      await settle();
      expect(tendOnceMock).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      await close(server);
    }
  });
});

describe("C4 补池轮次不可并发重入", () => {
  it("Node 侧：上一轮还没结束时，定时器再次到点会被跳过并留痕", async () => {
    const gate = deferred();
    tendOnceMock.mockImplementation(() => gate.promise);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await main(nodeEnv());
    try {
      // 启动时立即跑的那一轮还挂着（gate 没 resolve）。
      await waitFor(() => tendOnceMock.mock.calls.length === 1);

      const tick = intervals[0]!.fn;
      tick();
      await settle();
      // 重入被挡住：仍然只有第一轮在跑。
      expect(tendOnceMock).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("上一轮补池仍在进行"));

      // 上一轮结束后，下一次触发必须恢复正常——守卫不能把定时器永久卡死。
      gate.resolve(RESULT);
      await settle();
      tick();
      await waitFor(() => tendOnceMock.mock.calls.length === 2);
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
