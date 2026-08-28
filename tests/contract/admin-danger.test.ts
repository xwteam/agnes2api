import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/http/wire.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CONFIG_KEY } from "../../src/core/config-provenance.js";
import { KEY_PREFIX, POOL_INDEX_KEY } from "../../src/core/pool-index.js";
import { TEND_HISTORY_KEY } from "../../src/core/admin/tend-history.js";
import { MANUAL_GUARD_KEY } from "../../src/core/admin/tend-guard.js";
import { USAGE_KEY_PREFIX } from "../../src/core/admin/usage-stats.js";
import { EVENT_KEY_PREFIX } from "../../src/core/admin/event-ring.js";
import { CONFIG_RESET_PATH } from "../../src/http/admin/handlers/config.js";
import { KEYS_PURGE_PATH } from "../../src/http/admin/handlers/keys-write.js";
import type { Storage } from "../../src/ports/storage.js";
import type { KeyRecord } from "../../src/core/types.js";

/**
 * 危险区那两条端点（P3e Task 31）：`POST /admin/api/config/reset` 与
 * `POST /admin/api/keys/purge`。设计侧的语义在不带编号的那一节
 * 「重置到底重置了什么」里，本文件是它的绊线。
 *
 * ⚠️⚠️ **本文件从头到尾用「真装配」（`buildApp`），一个替身都没有**，
 * 与 `tests/contract/admin-config.test.ts` 的
 * 「保存之后同一个进程立刻回读到新值 —— 观测点在 overview，走的是真 holder」逐字同源：`invalidate()` 有没有被调
 * 只有走真 `ConfigHolder` 才可观测（`fixedConfigHolder.invalidate` 是个空函数），
 * 而「回执是不是回读出来的」只有观测点落在**存储此刻的内容**上才分得清。
 *
 * ── 观测点分三类，每一格都注明自己是哪一类 ───────────────────────────────────
 * · **落盘/回读类**：观测点在存储上，或在**另一条端点**（`GET /admin/api/overview`
 *   走真 holder）上；
 * · **不动哪些类**：观测点在 `Storage` 端口的**可见值**（`get` / `list`）上。
 *   ⚠️⚠️ **绝不许写成「`store.json` 逐字节不变」**——设计小节逐字记着这条：
 *   `src/adapters/storage-file.ts` 的 `put()`/`delete()` 每次都顺手 `pruneExpired()`，
 *   于是清空 Key 池的 N 次 delete 会**顺带**清掉当时已过期的 `usage:*` / `event:*` 条目，
 *   文件字节因此**可能变**，而那不是「重置动了用量」（那些条目在此之前 `get()` 已经
 *   返回 `null`、`list()` 已经把它们滤掉了）。断言文件字节会随机变红，
 *   **而那种红会被读成「重置真的动了用量」——正好是反过来的结论。**
 * · **不出网类**：观测点在响应体，但断言的是「**没有**某个东西」（凭据明文）。
 */

const withKey = { "x-admin-key": TEST_ADMIN_TOKEN };
const GW = "gateway-token-for-danger-zone-tests";
const JSON_HEADERS = { ...withKey, "content-type": "application/json" };

/** 这一族键在两条路径下都必须纹丝不动。**键名一律从真源常量拼**，不手写字面量。 */
const USAGE_SAMPLE = `${USAGE_KEY_PREFIX}2024-10-04:0`;
const EVENT_SAMPLE = `${EVENT_KEY_PREFIX}danger-shard`;

/** 装满一箱「不该被动」的旁证键。回来逐把对读回值，见本文件头的第二类观测点。 */
const BYSTANDERS: ReadonlyArray<readonly [key: string, value: unknown]> = [
  [TEND_HISTORY_KEY, { rounds: [{ at: 1, minted: 2 }] }],
  [MANUAL_GUARD_KEY, { day: "2024-10-04", used: 3, cooldownUntil: 0 }],
  [USAGE_SAMPLE, { requests: 41 }],
  [EVENT_SAMPLE, [{ at: 1, level: "info", event: "probe" }]],
];

async function seedBystanders(storage: Storage): Promise<void> {
  for (const [k, v] of BYSTANDERS) await storage.put(k, v);
}

/** 逐把读回来，交给调用方与「动之前」的那一份比。 */
async function readBystanders(storage: Storage): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k] of BYSTANDERS) out[k] = await storage.get<unknown>(k);
  // `list` 也要比：**「值没变」与「键还在不在」是两件事**，只比 `get` 抓不住
  // 「顺手把整族键删掉、而我们恰好只点名比了其中两把」。
  out[`list:${USAGE_KEY_PREFIX}`] = (await storage.list(USAGE_KEY_PREFIX)).sort();
  out[`list:${EVENT_KEY_PREFIX}`] = (await storage.list(EVENT_KEY_PREFIX)).sort();
  return out;
}

/**
 * **真装配。** `env` 由用例给，`storage` 由用例持有 ⇒ 断言可以直接落在存储上。
 * 运行时用 `nodeRuntime()`：这两条端点没有后台任务，不需要 `ctx.waitUntil`。
 */
async function realApp(o: {
  env?: Record<string, string | undefined>;
  storage?: Storage;
  stored?: unknown;
  keys?: readonly string[];
} = {}) {
  const storage = o.storage ?? new MemoryStorage();
  if (o.stored !== undefined) await storage.put(CONFIG_KEY, o.stored);
  const env: Record<string, string | undefined> = {
    ADMIN_TOKEN: TEST_ADMIN_TOKEN,
    ...(o.env ?? { GATEWAY_TOKEN: GW }),
  };
  const built = await buildApp(env, storage, nodeRuntime());
  for (const k of o.keys ?? []) await built.repo.add(k);
  return { ...built, storage, env };
}

type App = Awaited<ReturnType<typeof realApp>>["app"];

const reset = (app: App, body: unknown = { confirm: true }) =>
  app.request(CONFIG_RESET_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

const purge = (app: App, body: unknown) =>
  app.request(KEYS_PURGE_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

/**
 * 一个在**指定键第一次被写**之后，偷偷把存储改成别的样子的装饰器。
 *
 * ⚠️⚠️ **它是「回执到底是回读出来的、还是 handler 自己拼的」这个问题唯一分得清的判据。**
 * 只断言「响应体里 `fields` 是一份空配置」的话，一个把 `RESET_VALUE` 就地转成视图
 * 交回去的实现**一模一样地绿**——那正是 `src/http/admin/handlers/config.ts` 纪律 ④
 * 逐字警告的「写错了没有任何自动化会红」的那一行。
 * 让存储在「写完」与「回读」之间变成第三种样子，回执就必须报出**那第三种样子**；
 * 自己拼的那一版永远报不出来。
 */
class SwapAfterFirstPut implements Storage {
  swapped = false;
  constructor(
    private readonly inner: Storage,
    private readonly watch: string,
    private readonly onSwap: (inner: Storage) => Promise<void>,
  ) {}

  get<T>(key: string): Promise<T | null> { return this.inner.get<T>(key); }
  delete(key: string): Promise<void> { return this.inner.delete(key); }
  list(prefix: string): Promise<string[]> { return this.inner.list(prefix); }
  async put<T>(key: string, value: T, expiresAt?: number): Promise<void> {
    await this.inner.put(key, value, expiresAt);
    if (key !== this.watch || this.swapped) return;
    this.swapped = true;
    await this.onSwap(this.inner);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 鉴权：两条端点都在 adminAuth 那一行之后
// ───────────────────────────────────────────────────────────────────────────

describe("危险区两条端点的鉴权", () => {
  /**
   * 【落盘类】**判据是 401，而且要把 404 单独点名**：这两条端点若被挪到静态兜底
   * 之后就恒 404，而 404 与 401 一样「不是 200」——只写 `not.toBe(200)` 的话，
   * 一条恒不可达的端点也能让这一格绿。整棵树的位置不变式在
   * `tests/contract/admin-auth.test.ts` 的
   * 「每一条 /admin/api/* 都注册在 adminAuth 之后、静态兜底之前 —— 位置写错了它会恒 404 而没人拦」，
   * 这里只钉这两条自己的那一格。
   */
  it("两条新端点未带 x-admin-key 时 401，而不是 200/404", async () => {
    const { app } = await realApp({ keys: ["sk-danger-auth-probe"] });
    for (const [path, body] of [
      [CONFIG_RESET_PATH, { confirm: true }],
      [KEYS_PURGE_PATH, { expect: 1 }],
    ] as const) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, `${path}：无口令必须 401（404 说明它被静态兜底吃掉了）`).toBe(401);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 重置配置：动 config 这一把，其余一把都不动
// ───────────────────────────────────────────────────────────────────────────

describe("POST /admin/api/config/reset", () => {
  /** 【不动哪些类】设计小节那张逐键表里 `config` 那一行以外的每一格「不动」。 */
  it("重置配置之后，key:* / pool:index / tend:history / usage:* / event:* 的读回值不变", async () => {
    const storage = new MemoryStorage();
    await seedBystanders(storage);
    const { app } = await realApp({
      storage, keys: ["sk-reset-untouched-1", "sk-reset-untouched-2"],
      stored: { maxStrikes: 9 },
    });

    const keyNamesBefore = (await storage.list(KEY_PREFIX)).sort();
    const recordsBefore: Record<string, unknown> = {};
    for (const name of keyNamesBefore) recordsBefore[name] = await storage.get<unknown>(name);
    const indexBefore = await storage.get<unknown>(POOL_INDEX_KEY);
    const bystandersBefore = await readBystanders(storage);

    expect((await reset(app)).status).toBe(200);

    expect((await storage.list(KEY_PREFIX)).sort(), "重置配置动了 key 池的键名").toEqual(keyNamesBefore);
    for (const name of keyNamesBefore) {
      expect(await storage.get<unknown>(name), `重置配置动了 ${name} 的值`).toEqual(recordsBefore[name]);
    }
    expect(await storage.get<unknown>(POOL_INDEX_KEY), "重置配置动了池索引").toEqual(indexBefore);
    expect(await readBystanders(storage), "重置配置动了旁边那几把键").toEqual(bystandersBefore);
    // 反向自检：**它真的动了 `config`**，否则上面那一串「没动」全是空的。
    expect(await storage.get<unknown>(CONFIG_KEY), "config 没被重置 ⇒ 上面那些「没动」什么都没证明").toEqual({});
  });

  /**
   * 【落盘/回读类】**变异 M1 的靶子：把回执改成 handler 自己拼的一份空配置。**
   *
   * 判别力全部来自 `SwapAfterFirstPut`：写完之后存储里被换成了第三种样子
   *（`maxStrikes: 7`），回执必须报出那个 7。自己拼的那一版只知道 `{}`，
   * 报出来的 `stored` 是 `null`。
   */
  it("reset 的回执是回读出来的：写完之后存储被换掉，回执必须报出存储里那一份", async () => {
    const inner = new MemoryStorage();
    // **原件写在装饰器里面那一层**：写在外面的话，那次播种就是「第一次 put」，
    // 调包会当场用掉，reset 那一次反而什么都没发生（这一格第一次写出来就是这样，
    // 而它当时的表现是「回执里 stored 是 undefined」，读起来像 handler 的错）。
    await inner.put(CONFIG_KEY, { maxStrikes: 9 });
    const storage = new SwapAfterFirstPut(inner, CONFIG_KEY, async (s) => {
      await s.put(CONFIG_KEY, { maxStrikes: 7 });
    });
    const { app } = await realApp({ storage });
    // 前置：夹具本身真的触发了那次调包，否则这一格测的是空气。
    const res = await reset(app);
    expect(res.status).toBe(200);
    expect(storage.swapped, "夹具没换成第三种样子 —— 这一格的判别力是空的").toBe(true);

    const body = await res.json() as {
      fields: Record<string, { stored: unknown; effective: unknown }> | null;
      changed: string[];
    };
    expect(body.fields?.maxStrikes?.stored,
      "回执报的不是存储此刻的样子 —— 多半是 handler 自己拼了一份空配置交回去").toBe(7);
    // `changed` 同样从回读出来的两侧算：9 → 7 是一次真的变化。
    expect(body.changed).toContain("maxStrikes");
  });

  /**
   * 【落盘/回读类】**变异 M2 的靶子：把 `configHolder.invalidate()` 删掉。**
   *
   * 观测点刻意在**另一条端点**上（`GET /admin/api/overview` 走的是真 holder），
   * 不在 reset 自己的响应体上——回读证明「落盘了」，`invalidate()` 保证的是
   * 「同一个进程的下一个请求看到的也是新值」，那是两件事
   *（`src/http/admin/handlers/config.ts` 纪律 ④ 里那段 ⚠️ 逐字说了这条）。
   */
  it("重置之后同一个进程立刻读到新值 —— 观测点在 overview，走的是真 holder", async () => {
    const { app } = await realApp({ stored: { registrar: { targetKeys: 42 } } });
    const before = await (await app.request("/admin/api/overview", { headers: withKey })).json() as {
      config: { targetKeys: number };
    };
    expect(before.config.targetKeys, "前置条件：存储里那份配置真的在生效").toBe(42);

    expect((await reset(app)).status).toBe(200);

    const after = await (await app.request("/admin/api/overview", { headers: withKey })).json() as {
      config: { targetKeys: number };
    };
    expect(after.config.targetKeys,
      "重置之后 overview 还在报旧值 —— 多半是 invalidate() 掉了，运维会在最长一个 CONFIG_TTL_MS 内读到假话")
      .not.toBe(42);
  });

  /** 【落盘类】env 锁着的那一层不受重置影响——「重置 ≠ 恢复出厂」正是设计小节的第一条。 */
  it("被环境变量锁定的字段，重置之后生效值一个比特都不动", async () => {
    const { app } = await realApp({
      env: { GATEWAY_TOKEN: GW, TARGET_KEYS: "30" },
      stored: { registrar: { targetKeys: 7 } },
    });
    const body = await (await reset(app)).json() as {
      fields: Record<string, { effective: unknown; env: unknown; lockedBy: unknown }> | null;
    };
    const f = body.fields?.["registrar.targetKeys"];
    expect(f?.effective, "env 锁着的字段被重置掉了 —— 「重置 = 恢复出厂」正是设计小节点名的误解").toBe(30);
    expect(f?.lockedBy).toBe("env:TARGET_KEYS");
  });

  /**
   * 【落盘类】两态文案的判据是 `configLoadBlockers({}, env)`，**不是「有没有
   * GATEWAY_TOKEN」**——重置连通道凭据一起清，爆炸半径严格大于「清空一把凭据」。
   * 这一格拿**通道**那一态正面钉住它：只判 `gatewayToken` 的实现在这里会给出空数组。
   */
  it("重置之后装不起来时逐条说出原因 —— 通道凭据那一态也要报，不只是 gatewayToken", async () => {
    // ⚠️ **注册机必须由 env 打开**：`{}` 里的 `enabled` 是 `false`，所以「重置之后
    // 注册机还开着、而链上通道的凭据刚被抹掉」这一态**只有 env 开着注册机时才存在**。
    // 这一格第一版把 `enabled: true` 写在存储里 ⇒ 重置之后注册机跟着关了 ⇒
    // `configLoadBlockers({}, env)` 一条都不报，**而那不是判据瞎了，是这一态压根不成立**。
    const { app } = await realApp({
      env: {
        GATEWAY_TOKEN: GW,
        REGISTRAR_ENABLED: "true",
        REGISTRAR_PRIMARY: "moemail",
        MOEMAIL_BASE_URL: "https://m.example.com",
      },
      // 通道凭据**只在存储里**：重置把它抹掉，env 那一侧接不住。
      stored: { registrar: { moemail: { apiKey: "moemail-api-key-only-in-storage" } } },
    });
    const body = await (await reset(app)).json() as {
      resetBlocked: Array<{ field: string; code: string }>;
    };
    expect(body.resetBlocked.length,
      "重置之后注册机那条链已经缺凭据了，而回执一条原因都没说 —— 判据多半只判了 gatewayToken")
      .toBeGreaterThan(0);
    expect(body.resetBlocked.map((b) => b.field).join(","))
      .toContain("registrar");
  });

  /**
   * 【落盘类】**`GET /admin/api/config` 必须**在写之前**就把「重置之后会缺什么」交出来。**
   *
   * 面板要在**二次确认框里**把后果说清，而那一刻还没发过任何写请求 ⇒ 这一格不能等到
   * 重置回执里才有。判据同样是 `configLoadBlockers({}, env)`——**面板自己不许另算一份**
   *（`src/http/admin/handlers/config.ts` 纪律 ①：来源推导只有一份）。
   * 少了这一格，`admin-ui/js/pure/settings.mjs` 的 `resetWarnings()` 会恒落到
   * 「看不出会缺什么」那一档，而运维正要抹掉唯一一把网关口令。
   */
  it("GET /admin/api/config 在写之前就交出「重置之后会缺什么」 —— 二次确认框那一刻还没发过任何写请求", async () => {
    // env 里没有 GATEWAY_TOKEN、口令只在存储里 ⇒ 重置之后这份配置装不起来。
    const { app } = await realApp({ env: {}, stored: { gatewayToken: "only-in-storage-000000001" } });
    const body = await (await app.request("/admin/api/config", { headers: withKey })).json() as {
      resetBlocked: Array<{ field: string; code: string }>;
    };
    expect(body.resetBlocked.map((b) => b.code),
      "GET 没把「重置之后会缺什么」交出来 —— 面板的二次确认框只能改成自己算一份，而那是纪律 ① 禁止的")
      .toContain("gateway_token_required");

    // 反向控制：env 里有兜底时它必须是空的，否则这一格只是在数「非空」。
    const fine = await realApp({ env: { GATEWAY_TOKEN: GW } });
    const ok2 = await (await fine.app.request("/admin/api/config", { headers: withKey })).json() as {
      resetBlocked: unknown[];
    };
    expect(ok2.resetBlocked, "env 兜住了却还在报缺失 —— 判据多半没看 env").toEqual([]);
  });

  /**
   * 【落盘类】**面板会拿哪条响应换掉手上那份 `data`，就必须在哪条响应里给出 `resetBlocked`。**
   *
   * ⚠️⚠️ 这一格是 P3e Task 31 复评回填（F4）补的，起因是前端那一半：
   * `admin-ui/js/pure/settings.mjs` 的 `resetWarnings()` 上一版把「读不到 `resetBlocked`」
   * 与「`resetBlocked` 是空数组」折进同一档，于是读不到时弹窗照说一句
   * 「重置之后这份配置仍然装载得起来」——**背后一条数据都没有**。那一档现在单独报
   * 「判断不了」（`tests/ui/settings.test.ts` 的
   * 「读不到 resetBlocked 时单独一档，绝不冒充「装得起来」—— 与 poolSizeOf 那条同源」钉着）。
   * 分开之后就冒出**后端这一半**：`POST /admin/api/config/secrets/clear` 原来没有这一格，
   * 而面板清完一把凭据正是拿它换掉 `data` 的 ⇒ 紧接着点「重置配置」会退化成一句
   * 「判断不了」，而那时后端其实完全算得出来。**三条响应形状对齐**，这一格钉住它。
   *
   * ⚠️ **顺带钉住「它只随 env 变」**：判据是 `configLoadBlockers(RESET_VALUE, env)`，
   * `RESET_VALUE` 是常量 ⇒ 同一个 env 下三条响应必须给出**同一个值**。
   * 哪天有人把其中一条改成「按存储里那份算」，这一格当场红。
   */
  it("GET / secrets/clear / reset 三条响应都给出 resetBlocked，且同一个 env 下三份一致", async () => {
    // env 里没有 GATEWAY_TOKEN、口令只在存储里 ⇒ 三条响应都该报「重置之后缺网关口令」。
    const { app } = await realApp({
      env: {},
      stored: {
        gatewayToken: "only-in-storage-000000002",
        registrar: { yyds: { apiKey: "yyds-api-key-only-in-storage" } },
      },
    });
    const codesOf = (b: unknown): string[] => {
      const rows = (b as { resetBlocked?: unknown }).resetBlocked;
      if (!Array.isArray(rows)) return ["（这条响应里根本没有 resetBlocked）"];
      return rows.map((r) => String((r as { code?: unknown }).code));
    };

    const getBody = await (await app.request("/admin/api/config", { headers: withKey })).json();
    const clearBody = await (await app.request("/admin/api/config/secrets/clear", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ path: "registrar.yyds.apiKey" }),
    })).json();
    const resetBody = await (await reset(app)).json();

    // 非空锚：这个 env 下它本来就该非空，否则下面三份「一致」是三个空数组在互相认账。
    expect(codesOf(getBody), "这一格的前提是「重置之后真的会缺东西」，而 GET 说什么都不缺")
      .toContain("gateway_token_required");
    expect(codesOf(clearBody), "secrets/clear 的响应里没有 resetBlocked —— 面板清完凭据再点重置只能说「判断不了」")
      .toEqual(codesOf(getBody));
    expect(codesOf(resetBody), "reset 回执里那一格与 GET 那一格分叉了 —— 两处判据不再同源")
      .toEqual(codesOf(getBody));
  });

  /** 【不出网类】危险区不许开任何回显口子（全局约束 12）。 */
  it("回执里没有任何一个叶子值等于凭据原串", async () => {
    const SECRET = "stored-gateway-token-danger-000001";
    const { app } = await realApp({ env: {}, stored: { gatewayToken: SECRET } });
    const text = await (await reset(app)).text();
    expect(text).not.toContain(SECRET);
  });

  /** 【落盘类】`confirm` 必填——它是鉴权矩阵不把夹具配置抹掉的唯一理由。 */
  it("不带 confirm: true 的请求是 400，且一个字节都不写", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({ storage: st, stored: { maxStrikes: 9 } });
    const putsBefore = st.puts;
    for (const body of [{}, { confirm: false }, { confirm: "true" }]) {
      const res = await reset(app, body);
      expect(res.status, `请求体 ${JSON.stringify(body)} 应当 400`).toBe(400);
    }
    // 不带请求体的那一次（枚举式鉴权矩阵真的会这么打）同样不许写。
    expect((await app.request(CONFIG_RESET_PATH, { method: "POST", headers: withKey })).status).toBe(400);
    expect(st.puts, "被拒绝的那几次里有人写了存储").toBe(putsBefore);
    expect(await st.get<unknown>(CONFIG_KEY), "配置被改了").toEqual({ maxStrikes: 9 });
  });

  /**
   * 【落盘类】**配额单价：1 次 put。** 五语言 DEPLOY.md 的配额账写的就是这个数，
   * 全局约束 14 要求这两件事同一个提交里一起改。
   */
  it("配额单价：重置一次恰好 1 次 put、0 次 delete、0 次 list", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({ storage: st, stored: { maxStrikes: 9 } });
    const before = { puts: st.puts, deletes: st.deletes, lists: st.lists };
    expect((await reset(app)).status).toBe(200);
    expect({ puts: st.puts - before.puts, deletes: st.deletes - before.deletes, lists: st.lists - before.lists })
      .toEqual({ puts: 1, deletes: 0, lists: 0 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 清空 Key 池
// ───────────────────────────────────────────────────────────────────────────

describe("POST /admin/api/keys/purge", () => {
  /** 【不动哪些类】设计小节那张表里「清空 Key 池」那一列的每一格「不动」。 */
  it("清空 Key 池之后，config / tend:history / usage:* / event:* 的读回值不变", async () => {
    const storage = new MemoryStorage();
    await seedBystanders(storage);
    const { app } = await realApp({
      storage, keys: ["sk-purge-untouched-1", "sk-purge-untouched-2", "sk-purge-untouched-3"],
      stored: { maxStrikes: 9 },
    });
    const configBefore = await storage.get<unknown>(CONFIG_KEY);
    const bystandersBefore = await readBystanders(storage);

    const res = await purge(app, { expect: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 3, remaining: 0, expected: 3 });

    expect(await storage.get<unknown>(CONFIG_KEY), "清空 Key 池动了 config").toEqual(configBefore);
    expect(await readBystanders(storage), "清空 Key 池动了旁边那几把键").toEqual(bystandersBefore);
    // 反向自检：**它真的清空了**，否则上面那一串「没动」全是空的。
    expect(await storage.list(KEY_PREFIX), "key 池没被清空 ⇒ 上面那些「没动」什么都没证明").toEqual([]);
  });

  /**
   * 【落盘/回读类】**`remaining` 是回读出来的，不是写死的 0。**
   *
   * 判别力来自 `SwapAfterFirstPut`：索引被写空之后偷偷塞回一条记录
   *（模拟「另一个副本刚导入」/「有人裸写了存储」），回读必须把它数出来。
   * 一个 `remaining: 0` 的常数只是把 handler 的心愿印在屏幕上。
   */
  it("purge 的 remaining 是回读出来的：索引写空之后存储里还躺着记录，就要如实报出来", async () => {
    const inner = new MemoryStorage();
    let ghost: KeyRecord | null = null;
    const storage = new SwapAfterFirstPut(inner, POOL_INDEX_KEY, async (s) => {
      if (ghost !== null) await s.put(KEY_PREFIX + ghost.id, ghost);
    });
    const { app, repo } = await realApp({ storage, keys: ["sk-purge-readback-1", "sk-purge-readback-2"] });
    ghost = (await repo.all())[0]!;
    // 前置：`SwapAfterFirstPut` 盯的是**索引**那一把，而 `repo.add()` 也写索引
    // ⇒ 这一格必须在 add 之后重置它，否则调包发生在 add 上、purge 时早就用掉了。
    storage.swapped = false;

    const res = await purge(app, { expect: 2 });
    expect(storage.swapped, "夹具没把记录塞回去 —— 这一格的判别力是空的").toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json(),
      "remaining 报的不是回读结果 —— 多半写死了 0，而存储里其实还躺着一条记录")
      .toEqual({ deleted: 2, remaining: 1, expected: 2 });
  });

  /** 【落盘类】`expect` 对不上 ⇒ 409，**一把都不许删**。 */
  it("expect 与当前池大小对不上时 409，且一把 key 都没删", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({ storage: st, keys: ["sk-purge-conflict-1", "sk-purge-conflict-2"] });
    const namesBefore = (await st.list(KEY_PREFIX)).sort();
    const deletesBefore = st.deletes;

    const res = await purge(app, { expect: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "pool_size_changed", expected: 1, actual: 2 });
    expect(st.deletes, "409 了却删了东西").toBe(deletesBefore);
    expect((await st.list(KEY_PREFIX)).sort()).toEqual(namesBefore);
  });

  /** 【落盘类】`expect` 必填、且必须是非负整数——同 `confirm`，它是矩阵安全的唯一理由。 */
  it("expect 缺席 / 不是非负整数时 400，且一把 key 都没删", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({ storage: st, keys: ["sk-purge-badbody"] });
    const deletesBefore = st.deletes;
    for (const body of [{}, { expect: "1" }, { expect: -1 }, { expect: 1.5 }]) {
      expect((await purge(app, body)).status, `请求体 ${JSON.stringify(body)} 应当 400`).toBe(400);
    }
    expect((await app.request(KEYS_PURGE_PATH, { method: "POST", headers: withKey })).status).toBe(400);
    expect(st.deletes, "被拒绝的那几次里有人删了 key").toBe(deletesBefore);
    expect((await st.list(KEY_PREFIX)).length).toBe(1);
  });

  /**
   * 【落盘类】**配额单价：N 次 delete + 1 次 put。** 五语言 DEPLOY.md 的配额账写的
   * 就是这个式子，全局约束 14 要求两件事同一个提交里一起改。
   *
   * ⚠️ **`put` 恰好 1 次是承重的那一半**：退化成循环调 `repo.delete()` 的话
   * 每一把都要重写一次索引 ⇒ N 次 put 打在每天 1,000 次的写桶上，而换来的信息量
   * 与一次 put 完全相同（`KeyPoolRepo.deleteMany` 的说明里逐字写着这条）。
   */
  it("配额单价：清空 N 把恰好 N 次 delete + 1 次 put（循环调 delete() 会写 N 次）", async () => {
    const st = new CountingStorage();
    const keys = ["sk-purge-cost-1", "sk-purge-cost-2", "sk-purge-cost-3", "sk-purge-cost-4"];
    const { app } = await realApp({ storage: st, keys });
    const before = { puts: st.puts, deletes: st.deletes };
    expect((await purge(app, { expect: keys.length })).status).toBe(200);
    expect(st.deletes - before.deletes, "delete 次数不等于池大小").toBe(keys.length);
    expect(st.puts - before.puts, "索引写了不止一次 —— 多半退化成了循环调 repo.delete()").toBe(1);
  });

  /**
   * 【落盘类】**连点两次：第二次一把都不删、一个字节都不写。**
   *
   * ⚠️ **量的是「第二次」，不是「一个全新部署上的第一次」，这是实测逼出来的**：
   * 全新部署上池索引压根不存在，`repo.all()` 会走「索引缺失回落 list」并
   * **顺手重建一次索引**（`KeyPoolRepo.bootstrapFromListThrottled`）⇒ 那一次
   * 恰好 1 次 put + 1 次 list，**而那笔账是 `repo.all()` 的，不是这颗按钮的**。
   * 把它算进这颗按钮的单价，五语言 DEPLOY.md 那一行就会写成一句假话。
   */
  it("连点两次清空：第二次 0 次 delete、0 次 put，回执如实说删了 0 把", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({ storage: st, keys: ["sk-purge-twice"] });
    expect((await purge(app, { expect: 1 })).status).toBe(200);

    const before = { puts: st.puts, deletes: st.deletes };
    const res = await purge(app, { expect: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 0, remaining: 0, expected: 0 });
    expect({ puts: st.puts - before.puts, deletes: st.deletes - before.deletes }).toEqual({ puts: 0, deletes: 0 });
  });

  /** 【不出网类】回执里不许出现明文 key —— 请求里本来就没有，响应里更没有理由有。 */
  it("回执里没有任何一个叶子值等于明文 key", async () => {
    const KEY = "sk-purge-never-echoed-000001";
    const { app } = await realApp({ keys: [KEY] });
    const text = await (await purge(app, { expect: 1 })).text();
    expect(text).not.toContain(KEY);
  });
});
