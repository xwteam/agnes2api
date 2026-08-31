import { describe, it, expect, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { main, nodeDataDir, nodePort } from "../../src/entry/node.js";
import { FileStorage } from "../../src/adapters/storage-file.js";
import { TEND_LOCK_KEY, TEND_LOCK_TTL_MS } from "../../src/http/admin/tend-lock.js";
import { TEND_HISTORY_KEY } from "../../src/core/admin/tend-history.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { stripComments } from "../helpers/strip-comments.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "a2a-node-entry-"));
}

function close(server: Awaited<ReturnType<typeof main>>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * **`cp .env.example .env` 之后把某一行的值删空** —— compose 的 `env_file:` 送进来的是
 * 空字符串（不是「未设置」），而这两个变量在容器那一侧走的是 shell 的 `:-`（把空串当没设）。
 * 两边不同义时的后果不是报错，是**静默**：`DATA_DIR=` 会让 `store.json` 落到卷外
 *（容器一重建整池消失）、`PORT=` 会让进程监听随机端口而 compose 照旧发布 8080。
 * 归一的实现与完整失效链写在 `src/entry/node.ts` 的 `orUnset` 上方。
 */
describe("node 入口: 留空的 DATA_DIR / PORT 视同「没设」", () => {
  it("DATA_DIR= （空串）回落到 /app/data —— 不能变成相对路径 store.json（那会写到卷外）", () => {
    expect(nodeDataDir({ DATA_DIR: "" })).toBe("/app/data");
    // 反向控制：没设与真设了值这两头都不许被这条归一改掉。
    expect(nodeDataDir({})).toBe("/app/data");
    expect(nodeDataDir({ DATA_DIR: "/mnt/pool" })).toBe("/mnt/pool");
  });

  it("PORT= （空串）回落到 8080 —— 不能变成 Number('') = 0 的随机端口", () => {
    expect(nodePort({ PORT: "" })).toBe(8080);
    expect(nodePort({})).toBe(8080);
    expect(nodePort({ PORT: "3000" })).toBe(3000);
    // **显式的 `PORT=0` 仍然是「让内核挑一个」**：本文件其余用例全靠它，
    // 把它一起归一掉会让整份测试去抢 8080。
    expect(nodePort({ PORT: "0" })).toBe(0);
  });

  /**
   * 上面两格测的是两个纯函数，**而真正会被部署的是 `main()`**：把 `main()` 里那两行改回
   * `?? "/app/data"` / `?? 8080`，上面两格照样全绿——那时它们守的就是两个没人调用的函数。
   * 所以这一格盯的是「谁在读这两个变量」：读取点只许出现在归一函数里。
   * 抠注释走 `tests/helpers/strip-comments.ts` 转导出的真源，否则上方那段讲失效链的注释
   * 自己会被扫成违规（本仓注释里到处写真代码片段）。
   */
  it("main() 必须经这两个函数读 DATA_DIR / PORT —— 直接 ?? 回落会让上面两格变成空谈", () => {
    const src = stripComments(readFileSync("src/entry/node.ts", "utf8"));
    const offenders = src.split("\n")
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => /\benv\.(DATA_DIR|PORT)\b/.test(text) && !text.includes("orUnset"));
    expect(
      offenders,
      "src/entry/node.ts 里这几行绕过了 orUnset 直接读 DATA_DIR / PORT ⇒ compose 里那一行留空时"
      + "又会走回「空串不当没设」的老路（store.json 落到卷外 / 监听随机端口）。"
      + "读取点只许留在 nodeDataDir / nodePort 里",
    ).toEqual([]);
  });
});

describe("node 入口: fail-closed", () => {
  it("缺少 GATEWAY_TOKEN 时启动失败（拒绝服务），不会去监听端口", async () => {
    await expect(main({ DATA_DIR: tmpDataDir() })).rejects.toThrow(/GATEWAY_TOKEN/);
  });
});

describe("node 入口: 真实启动路径", () => {
  it("提供 GATEWAY_TOKEN 时真的监听端口并能响应 /health", async () => {
    const server = await main({ GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: tmpDataDir() });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok", version: "0.1.0", storage: { writable: true },
      });
    } finally {
      await close(server);
    }
  });
});

// ── I-RM3：Critical A 的健康信号必须由**真实入口**保证 ───────────────────────
//
// storage-health 那套用例走的是 `buildApp(..., { probeStorage: true })`，绕过了
// src/entry/node.ts。实测把入口那一行的 `{ probeStorage: true }` 删掉，全套用例照样全绿
// ——而那一行正是「冷容器 + 数据目录不可写 + 空池」这条真机路径上唯一起作用的东西：
// 不探测的话 `/health` 一直 200（空池只读不写，watchStorage 永远观测不到写失败），
// 容器被报告为 healthy，而每一次 API 调用都返回 pool_empty。故这条用例从 `main()` 起。
//
// root 无视权限位，因此以 root 跑测试时跳过（真机验证由容器那一侧覆盖）。
const notRoot = typeof process.getuid !== "function" || process.getuid() !== 0;

describe.skipIf(!notRoot)("node 入口: 数据目录不可写", () => {
  it("真实入口 main() 起的服务，/health 报 503 degraded 而不是继续报 healthy", async () => {
    const dir = tmpDataDir();
    chmodSync(dir, 0o500); // r-x：读得到、写不进，等价于绑定挂载属主不匹配
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await main({ GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: dir });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        status: "degraded", storage: { writable: false },
      });
      // 不可写的原因必须进容器日志，否则运维只看到 degraded 却查不出为什么。
      expect(logged).toHaveBeenCalled();
    } finally {
      chmodSync(dir, 0o700);
      logged.mockRestore();
      await close(server);
    }
  });
});

// ── Node 侧的补池锁是**新建**的，不是复用 ───────────────────────────────────
//
// 在此之前 Node 只有进程内的 `inFlight`（`main()` 里一个布尔）。**Docker 的多副本
// 共卷部署下它形同虚设**：同一个 `DATA_DIR` 挂给两个容器，两个副本各有各的布尔，
// 两轮补池同时跑，同时撞邮箱服务的建号限流与上游的注册风控——而「顺序铸、不并发」
// 是功能性约束，不是性能取舍（设计 §10.2 第 1 条点名要补的正是这个洞）。
//
// 观测形态：**在数据目录里预先放一把没过期的锁**（模拟"另一个副本正在补池"），
// 起 `main()`，它那一轮必须被跳过。两个方向都验：有锁跳过、无锁真跑。
//
// ⚠️⚠️ **夹具必须是「池子已经满了」（`need <= 0` 提前返回），不能用
// `CODE_TIMEOUT_MS > WORKER_ROUND_BUDGET_MS` 那一招。** 那一招只在**传了轮级预算**的
// 路径上零网络，而 **Node 的定时轮刻意不传 `roundBudgetMs`**（`src/entry/node.ts`：
// Node/Docker 没有平台墙钟上限）——实测：照抄那个夹具会让这条用例**真的去打 YYDS 的
// 线上接口**（拿到 HTTP 403/429 与八个真实域名）。这不是理论风险，是本任务写这两格
// 时当场撞到的。**「同一个零网络夹具在两个入口上未必都零网络」，这条差异本身就是
// `roundBudgetMs` 那半边故事的证据。**
describe("node 入口: 补池的存储级锁（多副本共卷部署）", () => {
  /** 池子里先放一把 key ⇒ `need = TARGET_KEYS - 1 = 0` ⇒ `tendOnce` 提前返回，零网络。 */
  async function seedFullPool(dir: string): Promise<FileStorage> {
    const storage = new FileStorage(dir);
    const repo = new KeyPoolRepo(storage, { now: () => Date.now(), logger: NULL_LOGGER, cacheTtlMs: 0 });
    await repo.add("sk-node-lock-fixture-key-aa");
    return storage;
  }

  function regEnv(dataDir: string) {
    return {
      GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: dataDir,
      REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k",
      // 池子里已经有 1 把 ⇒ 缺口 0 ⇒ 一次都不铸，一个网络请求都不发。
      TARGET_KEYS: "1",
      // 定时器只跑一轮就够：把间隔调到很大，免得测试期间又排一轮进来。
      TEND_INTERVAL_MS: "86400000",
    };
  }

  /** 轮询到某个键出现/消失为止——那一轮补池是 `void` 出去的后台链路。 */
  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
    const start = Date.now();
    let v = await read();
    while (!ok(v) && Date.now() - start <= ms) {
      await new Promise((r) => setTimeout(r, 5));
      v = await read();
    }
    return v;
  }

  it("数据目录里已经有一把没过期的锁 ⇒ 这一轮被跳过（另一个副本正在补池）", async () => {
    const dir = tmpDataDir();
    const storage = await seedFullPool(dir);
    await storage.put(TEND_LOCK_KEY, { until: Date.now() + TEND_LOCK_TTL_MS });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await main(regEnv(dir));
    try {
      await until(
        async () => warnSpy.mock.calls.some(([m]) => typeof m === "string" && m.includes("另一个副本正在补池")),
        (v) => v,
      );
      expect(
        warnSpy.mock.calls.some(([m]) => typeof m === "string" && m.includes("另一个副本正在补池")),
        "Node 侧没有存储锁 ⇒ 多副本共卷部署下两轮补池会同时跑",
      ).toBe(true);
      // **锁不许被这一轮释放**：它是别人的锁，释放它等于把并发放进来。
      expect(await storage.get(TEND_LOCK_KEY), "跳过的那一轮把别人的锁删了").not.toBeNull();
      // 而且这一轮什么都没做：补池历史里一条记录都不该有。
      expect(await storage.get(TEND_HISTORY_KEY), "被跳过的那一轮却写了补池历史").toBeNull();
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
      await close(server);
    }
  });

  /**
   * **镜像另一半：没有锁的时候那一轮必须真的跑，而且跑完把锁还回去。**
   * 只写上一格的话，一个「Node 侧永远跳过补池」的实现照样全绿。
   */
  it("没有锁 ⇒ 这一轮真的跑，跑完锁被释放（不是留到自然过期）", async () => {
    const dir = tmpDataDir();
    const storage = await seedFullPool(dir);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await main(regEnv(dir));
    try {
      // 补池历史落盘 = 这一轮真的跑完了。
      const history = await until(
        () => storage.get<unknown[]>(TEND_HISTORY_KEY),
        (v) => v !== null,
      );
      expect(history, "没有锁的时候那一轮却没跑").not.toBeNull();
      expect(
        await until(() => storage.get(TEND_LOCK_KEY), (v) => v === null),
        "跑完之后锁必须被释放（否则下一轮要空等到自然过期）",
      ).toBeNull();
      expect(
        warnSpy.mock.calls.some(([m]) => typeof m === "string" && m.includes("另一个副本正在补池")),
        "没有锁却报了「另一个副本正在补池」",
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
      await close(server);
    }
  });
});
