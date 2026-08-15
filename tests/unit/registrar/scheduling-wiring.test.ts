import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("C4 补池轮次不可并发重入", () => {
  it("Node 侧：上一轮还没结束时，定时器再次到点会被跳过并留痕", async () => {
    const gate = deferred();
    tendOnceMock.mockImplementation(() => gate.promise);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await main(nodeEnv());
    try {
      await flush();
      // 启动时立即跑的那一轮还挂着（gate 没 resolve）。
      expect(tendOnceMock).toHaveBeenCalledTimes(1);

      const tick = intervals[0]!.fn;
      tick();
      await flush();
      // 重入被挡住：仍然只有第一轮在跑。
      expect(tendOnceMock).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("上一轮补池仍在进行"));

      // 上一轮结束后，下一次触发必须恢复正常——守卫不能把定时器永久卡死。
      gate.resolve(RESULT);
      await flush();
      tick();
      await flush();
      expect(tendOnceMock).toHaveBeenCalledTimes(2);
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
