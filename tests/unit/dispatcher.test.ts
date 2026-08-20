import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as DispatcherModule from "../../src/core/dispatcher.js";
import { configFromEnv } from "../../src/core/config.js";
import { registrarFromEnv } from "../../src/core/registrar/config.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { FakeFetcher } from "../helpers/fake-fetcher.js";
// KeyPoolRepo 静态 import：它已经搬到 keypool-repo.ts，不再持有需要重置的模块级状态。
// 下面那个动态 import 只为重置 dispatcher.ts 的模块级 `cursor`，保持原样。
import { KeyPoolRepo, keyId } from "../../src/core/keypool-repo.js";
import { KEY_PREFIX } from "../../src/core/pool-index.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import type { Storage } from "../../src/ports/storage.js";

// dispatcher.ts 按简报把游标设计为模块级变量，用于在不同请求之间维持轮询位置——
// 这在生产环境下是正确的（否则每次请求都会从第一把 key 开始，起不到轮询作用）。
// 但同一个测试文件里的多个 it() 共享同一份模块实例，会导致游标在用例之间串位。
// 因此这里改为每个用例前 vi.resetModules() 后动态重新 import，
// 让每个用例都拿到一份全新的模块（游标重新从 0 开始），
// 不改动 dispatcher.ts 本身的设计，只做测试隔离。
let dispatch: typeof DispatcherModule.dispatch;

beforeEach(async () => {
  vi.resetModules();
  ({ dispatch } = await import("../../src/core/dispatcher.js"));
});

const CONFIG = {
  gatewayToken: "t",
  agnesBaseUrl: "https://upstream.test/v1",
  upstreamTimeoutMs: 8000,
  upstreamSyncTimeoutMs: 120_000,
  maxStrikes: 3,
  cooldownRateLimitMs: 60_000,
  cooldownPaymentMs: 3_600_000,
  cooldownStrikeMs: 1_800_000,
  // 本文件量的是 dispatch 的**记账语义**（谁被记 strike、谁进冷却），一律通过
  // 「改完再 all() 读回来」断言。快照缓存与写消除都会挡在这条读回路上，开着它们
  // 等于让这些断言测的是缓存而不是记账。两者由 pool-cache / quota-account 覆盖。
  poolCacheTtlMs: 0, poolTouchIntervalMs: 0,
  registrar: registrarFromEnv({}, {}),
  degraded: false,
};

async function makeRepo(keys: string[]) {
  const s = new MemoryStorage();
  const repo = new KeyPoolRepo(s, {
    now: () => 1000, logger: NULL_LOGGER,
    cacheTtlMs: CONFIG.poolCacheTtlMs, touchIntervalMs: CONFIG.poolTouchIntervalMs,
  });
  for (const k of keys) await repo.add(k);
  return repo;
}

describe("dispatch", () => {
  it("首把 key 成功即返回，不再尝试其他 key", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 200, body: '{"ok":true}' }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1"]);
  });

  it("429 后换下一把 key，并把前一把置为冷却", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 429 }, { status: 200, body: "{}" }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    const k1 = (await repo.all()).find((r) => r.key === "k1")!;
    expect(k1.cooldownUntil).toBe(1000 + 60_000);
    expect(k1.cooldownReason).toBe("rate limited");
  });

  it("401 把该 key 永久剔除后换下一把", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 401 }, { status: 200, body: "{}" }]);
    await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    const k1 = (await repo.all()).find((r) => r.key === "k1")!;
    expect(k1.evicted).toBe(true);
  });

  it("非 401/403/429/402/5xx 的 4xx 直接透传，不换 key", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 400, body: '{"error":"bad request"}' }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(400);
    expect(f.usedKeys).toEqual(["k1"]);
  });

  it("池中无 key 时返回 503 且错误体说明是空池", async () => {
    const repo = await makeRepo([]);
    const f = new FakeFetcher([]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "pool_empty" } });
  });

  it("全部 key 冷却中时返回 503 且原因为 all_cooling", async () => {
    const repo = await makeRepo(["k1"]);
    const only = (await repo.all())[0]!;
    await repo.save({ ...only, cooldownUntil: 999_999 });
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: new FakeFetcher([]), config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "all_cooling" } });
  });

  it("所有 key 都失败时返回最后一次上游错误", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 500 }, { status: 502 }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(502);
  });

  it("成功后清零该 key 的 strikes", async () => {
    const repo = await makeRepo(["k1"]);
    const only = (await repo.all())[0]!;
    await repo.save({ ...only, strikes: 2 });
    await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: new FakeFetcher([{ status: 200, body: "{}" }]), config: CONFIG, now: () => 1000 },
    });
    expect((await repo.all())[0]!.strikes).toBe(0);
  });

  it("fetch 抛普通异常时记 strike 并换下一把 key 重试成功", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ throws: new Error("boom") }, { status: 200, body: "{}" }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: { ...CONFIG, maxStrikes: 1 }, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    const k1 = (await repo.all()).find((r) => r.key === "k1")!;
    expect(k1.evicted).toBe(false);
    expect(k1.cooldownUntil).toBe(1000 + CONFIG.cooldownStrikeMs);
    expect(k1.cooldownReason).toBe("network error");
  });

  it("fetch 抛 AbortError（超时）时同样记 strike 并换下一把", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const f = new FakeFetcher([{ throws: abortErr }, { status: 200, body: "{}" }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: { ...CONFIG, maxStrikes: 1 }, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    const k1 = (await repo.all()).find((r) => r.key === "k1")!;
    expect(k1.evicted).toBe(false);
    expect(k1.cooldownUntil).toBe(1000 + CONFIG.cooldownStrikeMs);
    expect(k1.cooldownReason).toBe("timeout");
  });

  // M3：网络全失败时 key 本身还没冷却也没被剔除，报 all_cooling 是自相矛盾的
  // （message 写「全部 key 均已尝试且失败」，reason 却暗示「在冷却，会自愈」）。
  it("所有 key 都抛网络错误时报 upstream_error，而不是 all_cooling", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ throws: new Error("e1") }, { throws: new Error("e2") }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "upstream_error" } });
  });

  // ── C2：上游一次抖动不得永久摧毁整个 key 池 ──────────────────────────────
  // 复现评审实测：3 把 key、上游持续 503，原实现只需 5 个请求就把整池打成永久剔除，
  // 上游恢复后网关永久返回 503。现在改为长冷却，到期自动恢复。

  it("上游持续 5xx 打满 strike 后，整池进入冷却而非永久剔除", async () => {
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const at = 1000;
    // 3 把 key × maxStrikes 3 = 9 次失败才可能打满，给足 30 次 503。
    const f = new FakeFetcher(Array.from({ length: 30 }, () => ({ status: 503 })));
    for (let i = 0; i < 10; i++) {
      await dispatch({
        path: "/chat/completions", body: {}, stream: false,
        deps: { repo, fetcher: f, config: CONFIG, now: () => at },
      });
    }
    const all = await repo.all();
    expect(all.map((r) => r.evicted)).toEqual([false, false, false]);
    expect(all.every((r) => r.cooldownUntil === at + CONFIG.cooldownStrikeMs)).toBe(true);
  });

  it("冷却到期后上游恢复，网关自动恢复服务（不需要任何人工干预）", async () => {
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const at = 1000;
    // 上游故障是可恢复的：down 为 true 时一律 503，翻回 false 即代表上游恢复。
    let down = true;
    const f = {
      async fetch() {
        return down ? new Response("{}", { status: 503 }) : new Response('{"ok":true}', { status: 200 });
      },
    };
    for (let i = 0; i < 10; i++) {
      await dispatch({
        path: "/chat/completions", body: {}, stream: false,
        deps: { repo, fetcher: f as never, config: CONFIG, now: () => at },
      });
    }
    // 冷却期内确实不可用
    const during = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f as never, config: CONFIG, now: () => at + 1 },
    });
    expect(during.status).toBe(503);

    // 上游恢复 + 冷却到期 → 无需任何人工干预即恢复服务
    down = false;
    const after = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f as never, config: CONFIG, now: () => at + CONFIG.cooldownStrikeMs },
    });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ ok: true });
  });

  // ── M3：reason 必须区分「会自愈」与「不会自愈」 ─────────────────────────

  it("全池因 strike 冷却时报 all_cooling 并给出 Retry-After", async () => {
    const repo = await makeRepo(["k1"]);
    const at = 1000;
    const f = new FakeFetcher(Array.from({ length: 10 }, () => ({ status: 503 })));
    for (let i = 0; i < 3; i++) {
      await dispatch({
        path: "/chat/completions", body: {}, stream: false,
        deps: { repo, fetcher: f, config: CONFIG, now: () => at },
      });
    }
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => at + 1 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "all_cooling" } });
    expect(Number(res.headers.get("retry-after"))).toBe(CONFIG.cooldownStrikeMs / 1000);
  });

  it("全池因凭据失效被剔除时报 all_evicted（明示不会自愈），且不带 Retry-After", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 401 }, { status: 401 }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { reason: "all_evicted" } });
    expect(res.headers.get("retry-after")).toBeNull();
    expect((await repo.all()).every((r) => r.evicted)).toBe(true);
  });

  // ── P3c Task 2：第四条 reason `all_disabled` ────────────────────────────
  //
  // **全部是行为断言**：构造真实的池子状态，打真 `dispatch`，断言响应体里的
  // reason **字面量**与 Retry-After 头，不去看 `poolHealth` 返回了什么。

  /** 走 `repo.save`——将来面板的 `PATCH` 也走这条，不另造一条只有测试会走的路。 */
  async function disable(repo: KeyPoolRepo, ids: readonly string[]): Promise<void> {
    for (const r of await repo.all()) {
      if (ids.includes(r.id)) await repo.save({ ...r, disabled: true }, r);
    }
  }
  const allIds = async (repo: KeyPoolRepo) => (await repo.all()).map((r) => r.id);

  /**
   * **这一格守的是常见路径，不是罕见路径**：运维停用池子里的一把 key，是这个功能
   * 最普通的用法，而网关必须照常服务。
   * **变红条件**：`poolHealth` 把 disabled 计进 `evicted`（则 `h.evicted === h.total`
   * 不成立但 `fresh` 少了一把……），或 `selectKey` 之外任何一处把「有 disabled」
   * 当成整池不可用。
   */
  it("停用一把、其余仍可用时照常 200，且被停用的那把一次都没被发出去", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const [first] = await allIds(repo);
    await disable(repo, [first!]);
    const f = new FakeFetcher([{ status: 200, body: '{"ok":true}' }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(f.usedKeys, "只有没被停用的那把上过场").toEqual(["k2"]);
  });

  it("整池被管理员停用时报 all_disabled（不是 all_evicted），不带 Retry-After，且一次上游都不打", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    await disable(repo, await allIds(repo));
    const f = new FakeFetcher([{ status: 200, body: '{"ok":true}' }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { reason: string; message: string } };
    // 字面量断言：`all_disabled` 退回复用 `all_evicted` 时这一行变红。
    expect(body.error.reason).toBe("all_disabled");
    expect(body.error.message, "说成「凭据失效，请更换 key」会让运维去做一件完全没用的事")
      .toContain("被管理员手工停用");
    expect(res.headers.get("retry-after"), "停用不会自己恢复，给 Retry-After 等于让客户端空转").toBeNull();
    expect(f.usedKeys, "被停用的 key 一把都不许被发出去").toEqual([]);
  });

  /**
   * 混合池：`disabled` + `evicted`，一把冷却中的都没有。
   * 两条路都不会自愈，但**运维该做的事不同**——一个点面板、一个换 key。
   * reason 取「最先能让池子重新可用的那一类」，所以是 `all_disabled`；
   * 精确的两个数在 message 里给全。
   */
  it("停用 + 剔除混合、无冷却时报 all_disabled，message 把两个数都说出来", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 401 }]);
    // k1 先被 401 打成 evicted。
    await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    const evictedIds = (await repo.all()).filter((r) => r.evicted).map((r) => r.id);
    expect(evictedIds, "前置条件：恰好一把被剔除").toHaveLength(1);
    await disable(repo, (await repo.all()).filter((r) => !r.evicted).map((r) => r.id));

    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: new FakeFetcher([]), config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { reason: string; message: string } };
    expect(body.error.reason).toBe("all_disabled");
    expect(body.error.message).toContain("1 把被管理员手工停用");
    expect(body.error.message).toContain("1 把因凭据失效被永久剔除");
  });

  /**
   * ⚠️ **评审 I1：`disabled === 0` 时 message 必须与 P3b 逐字相同。**
   *
   * 这一格是**逐字节**断言，不是 `toContain`。理由是评审实测出来的：全仓没有任何
   * 一条用例断言过 `all_cooling` 的 message 文本，**所以"既有用例一条都没红"在
   * 这件事上什么都不证明**——无条件拼上「0 把被管理员停用」会让每一条既有 503 都
   * 多出一句废话，而 1583 条会全绿。
   *
   * 两种变体并排放：只钉一种的话，「无条件拼接」与「永远不拼」各能溜过去一个。
   * **变红条件**：把 `unavailable()` 里那个 `h.disabled > 0 ? … : ""` 拿掉。
   */
  it("503 的 message 文本：没有停用的 key 时与 P3b 逐字相同", async () => {
    const at = 1000;
    const mkPool = async (disabledCount: number) => {
      const repo = await makeRepo(["k1", "k2"]);
      const rs = await repo.all();
      await repo.save({ ...rs[0]!, cooldownUntil: at + 60_000, cooldownReason: "rate limited" }, rs[0]!);
      if (disabledCount > 0) await repo.save({ ...rs[1]!, disabled: true }, rs[1]!);
      else await repo.save({ ...rs[1]!, evicted: true, evictedReason: "upstream 401" }, rs[1]!);
      const res = await dispatch({
        path: "/chat/completions", body: {}, stream: false,
        deps: { repo, fetcher: new FakeFetcher([]), config: CONFIG, now: () => at + 1 },
      });
      return (await res.json() as { error: { message: string } }).error.message;
    };

    // 一把冷却 + 一把剔除、零停用 ⇒ P3b 那句话，一个字都不多。
    expect(await mkPool(0))
      .toBe("全部 key 暂不可用：1 把冷却中（到期自动恢复）、1 把已永久剔除");
    // 一把冷却 + 一把停用 ⇒ 中间多出停用那一段，而且必须真的说出来。
    expect(await mkPool(1))
      .toBe("全部 key 暂不可用：1 把冷却中（到期自动恢复）、1 把被管理员停用、0 把已永久剔除");
  });

  /**
   * 同一条纪律用在 `all_disabled` 上：整池都是停用时，不许拖一句「0 把因凭据失效被永久剔除」。
   * **变红条件**：把那个 `h.evicted > 0 ? … : ""` 拿掉。
   */
  it("all_disabled 的 message：没有被剔除的 key 时不拖一句「0 把」", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    await disable(repo, await allIds(repo));
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: new FakeFetcher([]), config: CONFIG, now: () => 1000 },
    });
    expect((await res.json() as { error: { message: string } }).error.message)
      .toBe("全部 2 把 key 均不可用且不会自动恢复：2 把被管理员手工停用（在管理面板上重新启用即可）");
  });

  /**
   * ⚠️ **本组最要紧的一格。** 混合池：一把冷却中 + 一把被停用。
   *
   * 被停用的那把 `cooldownUntil` 是 0（它根本没在冷却）。Retry-After 的取值若把它
   * 算进去，`Math.min` 会取到 0 ⇒ **`Retry-After: 1`，客户端每秒重试一次，而池子
   * 要等半小时才回来**。这不是显示问题，是网关对着每一个下游用户说了一句假话。
   * **变红条件**：`unavailable()` 的 `records.filter(...)` 里去掉 `!isDisabled(r)`。
   */
  it("冷却 + 停用混合时报 all_cooling，Retry-After 取真正冷却那把的，不被停用的 0 污染", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const at = 1000;
    // 池子状态**直接构造**：上一格已经用真 503 走过 strike ⇒ 冷却那条路，这一格要测的
    // 是 Retry-After 的**取值**，让两把 key 各自处在一个确定的状态比绕一圈更清楚。
    // 两个状态在生产上都可达（`applyCooldown` 写 cooldownUntil、面板写 disabled）。
    const [a, b] = await repo.all();
    await repo.save({ ...a!, cooldownUntil: at + 1_800_000, cooldownReason: "rate limited" }, a!);
    await repo.save({ ...b!, disabled: true }, b!);

    const after = await repo.all();
    const cooling = after.filter((r) => r.cooldownUntil > at);
    expect(cooling, "前置条件：恰好一把在冷却").toHaveLength(1);
    expect(after.find((r) => r.disabled)!.cooldownUntil, "前置条件：被停用那把的 cooldownUntil 是 0").toBe(0);

    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: new FakeFetcher([]), config: CONFIG, now: () => at + 1 },
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { reason: string; message: string } };
    expect(body.error.reason).toBe("all_cooling");
    // 手写字面量：冷却到 at+1_800_000，而 now 是 at+1 ⇒ 还剩 1_799_999ms ⇒ 向上取整 1800 秒。
    // 漏筛 disabled 时这里会变成 1（`Math.min` 取到那把停用 key 的 0）。
    expect(Number(res.headers.get("retry-after"))).toBe(1800);
    expect(body.error.message, "三个数都要说出来，否则运维看不出那 1 把去哪了")
      .toContain("1 把被管理员停用");
  });

  // ── I2：上游响应头与 401 错误体绝不外泄 ─────────────────────────────────

  it("上游响应头不原样转发（set-cookie / x-* 一律剥掉）", async () => {
    const repo = await makeRepo(["k1"]);
    const f = new FakeFetcher([{
      status: 200, body: "{}",
      headers: {
        "set-cookie": "sess=upstream", "x-upstream-internal": "leak",
        "www-authenticate": "Bearer realm=upstream", "content-type": "application/json",
      },
    }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-upstream-internal")).toBeNull();
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("content-disposition 会被透传（媒体路由下载文件名依赖它），set-cookie 等仍被剥掉", async () => {
    const repo = await makeRepo(["k1"]);
    const f = new FakeFetcher([{
      status: 200, body: "binary-ish",
      headers: {
        "content-disposition": 'attachment; filename="video.mp4"',
        "set-cookie": "sess=upstream", "content-type": "video/mp4",
      },
    }]);
    const res = await dispatch({
      path: "/videos", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="video.mp4"');
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-type")).toBe("video/mp4");
  });

  /**
   * ── K5：上游 content-type 不许把本源变成一个可渲染的同源文档 ───────────────
   *
   * `GET /v1/videos/:id` 是一条接受 `?key=` 的 GET 路由（Gemini 协议兼容），而
   * content-type 是上游**逐字透传**的 ⇒ 拿着网关口令的下游用户能构造一条同源 URL
   * 让它返回 `text/html` / `image/svg+xml`，**直接导航过去就是一个同源文档**，
   * 里面的 `<script>` / `on*` / `javascript:` 都会执行——而面板把 `ADMIN_TOKEN`
   * 原样放在这个 origin 的 localStorage 里（作用域是 origin 而不是 path）。
   * 全局 `nosniff` 只否掉「按内容嗅探」，挡不住「显式声明成 text/html」。
   *
   * **正反两组缺一不可。** 只有正向那组时，把 `clampContentType` 改成「一律
   * 返回 octet-stream」照样全绿，而那会让媒体路由整个坏掉（图片/视频/SSE 全变下载）
   * ——修过头比不修更糟，所以反向那组同样是被守护的性质。
   */
  describe("上游 content-type 不许把本源变成一个可渲染的同源文档", () => {
    /** 上游声明成这个 content-type 时，网关最终回给客户端的那个值。 */
    async function forwarded(upstreamType: string): Promise<string | null> {
      const repo = await makeRepo(["k1"]);
      const f = new FakeFetcher([{
        status: 200, body: "<html>whatever</html>",
        headers: { "content-type": upstreamType },
      }]);
      const res = await dispatch({
        // 用真实那条可达路由的形态：GET /videos/{id}，非流式、无请求体。
        path: "/videos/abc", body: undefined, stream: false, method: "GET",
        deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
      });
      return res.headers.get("content-type");
    }

    for (const bad of ["text/html", "text/html; charset=utf-8", "IMAGE/SVG+XML", "application/javascript"]) {
      it(`上游返回 ${bad} 时改写成 application/octet-stream`, async () => {
        expect(await forwarded(bad)).toBe("application/octet-stream");
      });
    }

    // **反向一组**：把常用类型全打成下载是「修过头」，比不修更糟（媒体路由整个坏掉）。
    for (const ok of [
      "application/json", "text/event-stream", "image/png",
      "video/mp4", "audio/mpeg", "text/plain; charset=utf-8",
    ]) {
      it(`${ok} 原样透传`, async () => {
        expect(await forwarded(ok)).toBe(ok);
      });
    }
  });

  it("上游 401 的错误体绝不透传给客户端（那是最可能回显 key 片段的地方）", async () => {
    const repo = await makeRepo(["k1"]);
    const leak = '{"error":"invalid api key: sk-live-ABCDEF0123456789"}';
    const f = new FakeFetcher([{ status: 401, body: leak }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    const text = await res.text();
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("invalid api key");
    expect(JSON.parse(text)).toMatchObject({ error: { reason: "all_evicted" } });
  });

  it("先 5xx 后 401 时仍回第一把 key 的真实上游错误，而不是被 401 抹掉", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ status: 500, body: '{"e":"upstream boom"}' }, { status: 401, body: "secret" }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret");
  });

  // ── I6：换 key 重试时被丢弃的上游响应体必须被取消 ───────────────────────

  it("换 key 重试时取消掉被丢弃的上游响应体", async () => {
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const cancelled: string[] = [];
    const bodyOf = (tag: string) =>
      new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode(tag)); },
        cancel() { cancelled.push(tag); },
      });
    let n = 0;
    const fetcher = {
      async fetch() {
        n++;
        if (n < 3) return new Response(bodyOf(`err${n}`), { status: 500 });
        return new Response('{"ok":true}', { status: 200 });
      },
    };
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: fetcher as never, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    // err1 在被 err2 覆盖时取消，err2 在成功返回时取消。
    expect(cancelled.sort()).toEqual(["err1", "err2"]);
  });

  // ── I3：上游 200 但不是 JSON ────────────────────────────────────────────

  it("expectJson 时上游返回非 JSON 的 200 会记 strike 并换下一把 key", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([
      { status: 200, body: "<html>502 Bad Gateway</html>" },
      { status: 200, body: '{"ok":true}' },
    ]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false, expectJson: true,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await repo.all()).find((r) => r.key === "k1")!.strikes).toBe(1);
  });

  it("expectJson 时全池都返回非 JSON 的 200 则回 502，而不是 500 纯文本", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([
      { status: 200, body: "<html>oops</html>" },
      { status: 200, body: "not json either" },
    ]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false, expectJson: true,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ error: { reason: "upstream_bad_body" } });
  });

  it("GET 请求不携带 body", async () => {
    const repo = await makeRepo(["k1"]);
    let seen: RequestInit | null = null;
    const fetcher = { async fetch(_u: string, init: RequestInit) { seen = init; return new Response("{}"); } };
    await dispatch({ path: "/videos/x", body: undefined, stream: false, method: "GET",
      deps: { repo, fetcher: fetcher as any, config: CONFIG, now: () => 1 } });
    expect(seen!.body).toBeUndefined();
    expect(seen!.method).toBe("GET");
  });
});

// ── 记账失败仍要推进本请求内的视图 ──────────────────────────────────────────
//
// Step 1 把 commit() 包了一层 try/catch（记账失败不许把成功的转发变成 500），
// 但 `records[at] = updated` 必须留在 try/catch **外面**：commit() 抛错时，
// 这次调度的中间状态（例如「刚被判过冷却」）也必须推进到本请求内存里的
// `records` 数组，否则同一个请求里换下一把 key 时 selectKey 读到的还是
// 陈旧状态，可能把刚判过冷却的那把 key 在同一个请求里重新选中一次。
//
// 这条不是靠单纯的「换下一把 key」类用例（如「429 后换下一把 key」）测出来的
// ——那些用例里 selectKey 天然不会绕回第一把被冷却的 key（池子刚好够走一轮）。
// 要造出「commit 抛错后，同一个请求里 selectKey 需要绕回那把刚被冷却的 key」
// 这个场景，必须让**另一把 key 也不可用**，逼 selectKey 在本次 selectKey 调用内部
// 环绕回来重新检查第一把——这正是本用例的构造方式。
describe("commit 抛错后仍要推进本请求内的视图", () => {
  /** 只在指定的存储键上、且是「第二次」读取时才抛错——第一次读取（dispatch 开头
   * 加载整个池子）必须放行，否则连测试场景都搭不起来；第二次读取正是
   * commit() 的 stillExists() 确认存在性那次，模拟它在这一刻撞上瞬时读失败。 */
  class ThrowOnSecondGet implements Storage {
    private readonly inner = new MemoryStorage();
    private hits = 0;
    constructor(private readonly target: string) {}
    async get<T>(k: string): Promise<T | null> {
      if (k === this.target) {
        this.hits++;
        if (this.hits >= 2) throw new Error("KV read quota exhausted");
      }
      return this.inner.get<T>(k);
    }
    async put<T>(k: string, v: T): Promise<void> { return this.inner.put(k, v); }
    async delete(k: string): Promise<void> { return this.inner.delete(k); }
    async list(p: string): Promise<string[]> { return this.inner.list(p); }
  }

  it("429 记账失败后，同一个请求不许把刚被判冷却的那把 key 再选一次", async () => {
    const k1Id = await keyId("k1");
    const storage = new ThrowOnSecondGet(KEY_PREFIX + k1Id);
    const repo = new KeyPoolRepo(storage, {
      now: () => 1000, logger: NULL_LOGGER,
      cacheTtlMs: CONFIG.poolCacheTtlMs, touchIntervalMs: CONFIG.poolTouchIntervalMs,
    });
    // 用 add() 的返回值直接拿到 k2 的记录，**不额外调 repo.all()**——那会连带
    // 读一遍 k1 的记录，提前吃掉 ThrowOnSecondGet 的「第一次放行」额度，
    // 让节流点错位到 dispatch() 自己的初次加载上，测试搭都搭不起来。
    await repo.add("k1");
    const k2 = await repo.add("k2");
    // 逼 selectKey 在本次调用内部环绕：k2 必须不可用，这样第二次尝试才会绕回 k1。
    await repo.save({ ...k2, cooldownUntil: 999_999 }, k2);

    // 只给一个 outcome：k1 若被重新选中并再发一次请求，拿到的只能是
    // FakeFetcher 的默认兜底（200），从而把「重新选中」这件事暴露成响应体的差异。
    const f = new FakeFetcher([{ status: 429 }]);
    const res = await dispatch({
      path: "/chat/completions", body: {}, stream: false,
      deps: { repo, fetcher: f, config: CONFIG, now: () => 1000 },
    });

    // 行为断言，不是形状断言：状态码与实际发起的请求次数都要对。
    // 正确实现：k1 被判冷却后，即使记账失败，records[at] 仍然推进；k2 本就在冷却，
    // selectKey 第二次调用内部环绕回 k1 时看到的是「已冷却」，选不出任何 key，
    // dispatch 直接把 429 那份 lastError 交还，k1 全程只被尝试一次。
    expect(res.status, "记账失败让本请求内的视图没推进，k1 被当成还能用又选了一次").toBe(429);
    expect(f.usedKeys, "k1 不许在同一个请求里被选中两次").toEqual(["k1"]);
  });
});

// ── C-RM2：8 秒是「流式首字节」的调优值，不能统一套到同步端点 ────────────────
//
// 真机实测：直连上游 /images/generations 首字节耗时 11.99 秒（HTTP 200，同步接口，
// 首字节 = 整张图渲染完）。经网关（8 秒超时）则每把 key 各记一次 strike 后返回失败，
// 三次图片请求即可把整池打进 30 分钟长冷却。
//
// 本组用例刻意使用 configFromEnv 产出的**内置默认配置**而不是文件顶部的 CONFIG 字面量：
// 只有这样，把 DEFAULTS.upstreamSyncTimeoutMs 改回 8000 才会让它们变红。
describe("按端点语义区分超时", () => {
  const DEFAULTS = configFromEnv({ GATEWAY_TOKEN: "t", AGNES_BASE_URL: "https://upstream.test/v1" });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("内置默认值：同步端点的预算远大于流式首字节的 8 秒", () => {
    expect(DEFAULTS.upstreamTimeoutMs).toBe(8000);
    expect(DEFAULTS.upstreamSyncTimeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("同步端点：上游 12 秒才吐首字节（实测值），用内置默认配置照样成功", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1"]);
    const f = new FakeFetcher([
      { status: 200, body: '{"data":[{"url":"https://example.invalid/a.png"}]}', delayMs: 11_990 },
    ]);
    const pending = dispatch({
      path: "/images/generations", body: {}, stream: false, timeout: "sync",
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => 1000 },
    });
    await vi.advanceTimersByTimeAsync(11_990);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ url: "https://example.invalid/a.png" }] });
    expect((await repo.all())[0]!.strikes).toBe(0);
  });

  it("流式对话：同一个 12 秒的上游，仍然在 8 秒被甩掉并记 strike（§7.3 语义不变）", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1"]);
    const f = new FakeFetcher([{ status: 200, body: "{}", delayMs: 11_990 }]);
    const pending = dispatch({
      path: "/chat/completions", body: {}, stream: true, timeout: "firstByte",
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => 1000 },
    });
    await vi.advanceTimersByTimeAsync(11_990);
    const res = await pending;

    expect(res.status).toBe(503);
    const k1 = (await repo.all())[0]!;
    expect(k1.strikes).toBe(1);
    expect(k1.cooldownUntil).toBe(0);
  });

  // 非流式对话与图片生成是同一种延迟语义（上游把整段回答生成完才发响应头），
  // 路由层因此给它 `sync` 档。这条钉住的是「一次 12 秒的非流式对话不该伤到池」。
  it("非流式对话（同步档）：12 秒的上游照样成功，池毫发无损", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const f = new FakeFetcher([{ status: 200, body: '{"choices":[]}', delayMs: 11_990 }]);
    const pending = dispatch({
      path: "/chat/completions", body: {}, stream: false, timeout: "sync",
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => Date.now() },
    });
    await vi.advanceTimersByTimeAsync(11_990);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1"]);
    const all = await repo.all();
    expect(all.every((r) => r.strikes === 0 && r.cooldownUntil === 0)).toBe(true);
  });

  // ── C-RM2b：同步档的预算跨 key 共享，一把挂起的 key 不再吃掉整个请求 ─────────
  //
  // 「挂起」= TCP 连得上但上游永不响应，触发的是网关自己的 AbortController，因此走的是
  // 超时分支而**不是**网络错误分支——原实现在这里直接返回 504，池中其余 key 一把都不试，
  // 于是 N 把 key 的池子里只要挂了 1 把，就有 1/N 的请求硬失败且永远如此。

  it("一把 key 挂起时改用下一把，请求成功，并把超时记到挂起的那把头上", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([
      { status: 200, body: "{}", delayMs: 300_000 },      // k1 挂起
      { status: 200, body: '{"ok":true}', delayMs: 500 }, // k2 正常
    ]);
    const pending = dispatch({
      path: "/images/generations", body: {}, stream: false, timeout: "sync",
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => Date.now() },
    });
    await vi.advanceTimersByTimeAsync(DEFAULTS.upstreamSyncTimeoutMs);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    // 同一次请求里 k2 成功了 = 上游当时应答得了 → k1 的超时归因于 k1 自己。
    const all = await repo.all();
    expect(all.find((r) => r.key === "k1")!.strikes).toBe(1);
    expect(all.find((r) => r.key === "k2")!.strikes).toBe(0);
  });

  it("挂起的 key 连续被归因到 MAX_STRIKES 后进入长冷却，池子自己把它淘汰掉", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1", "k2"]);
    const f = {
      async fetch(_u: string, init: RequestInit & { signal?: AbortSignal }) {
        const hung = new Headers(init.headers).get("authorization") === "Bearer k1";
        if (!hung) return new Response('{"ok":true}', { status: 200 });
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          }, { once: true });
        });
      },
    };
    for (let i = 0; i < DEFAULTS.maxStrikes; i++) {
      const pending = dispatch({
        path: "/images/generations", body: {}, stream: false, timeout: "sync",
        deps: { repo, fetcher: f as never, config: DEFAULTS, now: () => Date.now() },
      });
      await vi.advanceTimersByTimeAsync(DEFAULTS.upstreamSyncTimeoutMs);
      expect((await pending).status).toBe(200);
    }
    const k1 = (await repo.all()).find((r) => r.key === "k1")!;
    expect(k1.cooldownReason).toBe("sync timeout");
    expect(k1.cooldownUntil).toBeGreaterThan(Date.now());
    expect(k1.evicted).toBe(false); // 是可自愈的长冷却，不是永久剔除
    expect((await repo.all()).find((r) => r.key === "k2")!.cooldownUntil).toBe(0);
  });

  it("整体预算耗尽才返回 504：客户端最坏只等一个预算，且不惩罚任何 key", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const f = new FakeFetcher(
      Array.from({ length: 3 }, () => ({ status: 200, body: "{}", delayMs: 300_000 })),
    );
    const pending = dispatch({
      path: "/images/generations", body: {}, stream: false, timeout: "sync",
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => Date.now() },
    });
    await vi.advanceTimersByTimeAsync(DEFAULTS.upstreamSyncTimeoutMs);
    const res = await pending;

    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { reason: "upstream_timeout" } });
    // 等待上界 = 一个 UPSTREAM_SYNC_TIMEOUT_MS，不是「池大小 × 预算」。
    expect(Date.now() - started).toBe(DEFAULTS.upstreamSyncTimeoutMs);
    // 预算被切成两半，因此这一个预算内换了一次 key；第三把没轮到。
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    // 全都超时 = 没有任何对照说明是 key 的问题，一把都不惩罚。
    const all = await repo.all();
    expect(all.map((r) => r.strikes)).toEqual([0, 0, 0]);
    expect(all.map((r) => r.cooldownUntil)).toEqual([0, 0, 0]);
    expect(all.map((r) => r.evicted)).toEqual([false, false, false]);
  });

  it("三次图片超时之后，整池依然全部可用（连带摧毁 key 池的路径已断开）", async () => {
    vi.useFakeTimers();
    const repo = await makeRepo(["k1", "k2", "k3"]);
    const f = new FakeFetcher(
      Array.from({ length: 9 }, () => ({ status: 200, body: "{}", delayMs: 300_000 })),
    );
    for (let i = 0; i < 3; i++) {
      const pending = dispatch({
        path: "/images/generations", body: {}, stream: false, timeout: "sync",
        deps: { repo, fetcher: f, config: DEFAULTS, now: () => Date.now() },
      });
      await vi.advanceTimersByTimeAsync(DEFAULTS.upstreamSyncTimeoutMs);
      expect((await pending).status).toBe(504);
    }
    const all = await repo.all();
    expect(all.every((r) => !r.evicted && r.cooldownUntil === 0 && r.strikes === 0)).toBe(true);
  });

  // 只豁免「超时」，不豁免「连不上」：真正坏掉的 key 会立刻抛网络错误，那条通路仍然
  // 记 strike 并换下一把，否则同步端点就永远没有淘汰坏 key 的能力了。
  it("同步端点的网络错误仍然记 strike 并换下一把 key", async () => {
    const repo = await makeRepo(["k1", "k2"]);
    const f = new FakeFetcher([{ throws: new Error("ECONNREFUSED") }, { status: 200, body: "{}" }]);
    const res = await dispatch({
      path: "/images/generations", body: {}, stream: false, timeout: "sync",
      deps: { repo, fetcher: f, config: DEFAULTS, now: () => 1000 },
    });

    expect(res.status).toBe(200);
    expect(f.usedKeys).toEqual(["k1", "k2"]);
    expect((await repo.all()).find((r) => r.key === "k1")!.strikes).toBe(1);
  });
});
