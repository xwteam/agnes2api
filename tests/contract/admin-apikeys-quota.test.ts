import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN, TEST_CONFIG } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { APIKEY_KEY } from "../../src/http/apikey-store.js";
import { APIKEY_CACHE_TTL_MS } from "../../src/http/apikey-holder.js";

/**
 * 对外 API 密钥那一族的**配额账**。**双运行时都跑。**
 *
 * ⚠️⚠️ **本文件守的是本设计的头号风险，不是一条性能指标。**
 * 鉴权中间件的第②段（「凭据不等于主口令 ⇒ 去查子密钥表」）**零凭据、零限速**：
 * 任何人拿一把错口令连打 `/v1/chat/completions` 都能走到那里。挡住它的机制只有一条：
 *
 * > **「表不存在 / 读不出来」也是一份合法快照，同样按 TTL 缓存。**
 *
 * 漏了这一条，持有者会在每次 `ensureFresh()` 上重试 ⇒ **每个错口令请求一次 KV 读**，
 * 免费档 10 万次/天当场被打穿，并连带打死 key 池的读——**而功能测试会全绿**。
 * 下面两格把「1000 次错口令 = 1 次 get」钉住；把「null 也缓存」改回「null 不缓存」，
 * 那两格当场数出 1000。
 */

const NOW = 1_700_000_000_000;
const AUTH = { "x-admin-key": TEST_ADMIN_TOKEN };
/**
 * 一格里打多少次。**下面几格的标题里逐字写着这个数**——
 * 标题是别处注释的锚（`scripts/check-comment-refs.mjs` 按标题原文核对），
 * 所以标题不许写成模板串。改这个数就要连标题一起改，那一格断言在下面第一格里。
 */
const ROUNDS = 1000;

/** 一次带凭据的转发请求。**用 `/v1/models`**：它不出站，量的就是鉴权那一段。 */
const call = (app: Awaited<ReturnType<typeof makeApp>>["app"], credential: string) =>
  app.request("/v1/models", { headers: { authorization: `Bearer ${credential}` } });

/**
 * 一台真的会缓存的 app。
 *
 * ⚠️ **TTL 必须显式传生产默认值**：`makeApp` 的默认是 `0`（不缓存），
 * 那是为了让功能类用例「改完立刻看得见」。拿 0 去量配额，量到的是另一条路径。
 */
async function quotaApp(seed?: unknown) {
  const inner = new MemoryStorage(undefined, () => NOW);
  if (seed !== undefined) await inner.put(APIKEY_KEY, seed);
  const storage = new CountingStorage(inner);
  const made = await makeApp([], ["sk-upstream-pool-key-aaaa"], {}, () => NOW, {
    apiKeys: { ttlMs: APIKEY_CACHE_TTL_MS }, storage,
  });
  // 装配、池子预热与夹具自己的那几次读都发生在这之前，从这里开始计数。
  storage.gets = 0; storage.puts = 0; storage.lists = 0; storage.deletes = 0;
  return { ...made, storage };
}

describe("配额账：错口令撬不动存储", () => {
  it("表不存在时，1000 次错口令请求只产生 1 次 get", async () => {
    expect(ROUNDS, "标题里写着 1000，两处必须是同一个数").toBe(1000);
    const { app, storage } = await quotaApp();
    for (let i = 0; i < ROUNDS; i++) {
      expect((await call(app, `sk-wrong-${i}`)).status).toBe(401);
    }
    // 「表不存在」是一份**合法快照**，照样吃满一个 TTL。
    expect(
      storage.gets,
      "每个错口令请求都真读了一次存储 —— 「读到 null 也按 TTL 缓存」那一条被拆掉了，"
      + "这正是免费档读配额被打穿的形态，而功能测试会全绿",
    ).toBe(1);
    expect(storage.puts, "鉴权路径上一个写都不许有").toBe(0);
  });

  it("存储读不出来时，1000 次错口令请求同样只产生 1 次 get", async () => {
    // 冷启动就读失败那一档：`Refreshable` 在「从未成功装载过」时**刻意不推进计时**，
    // 所以持有者必须自己把这一次降级成一份合法快照（同 `createConfigHolder` 的 `primed`）。
    // **读一律抛**，写照旧（夹具自己要落几条 key 池记录）。
    // 直接子类化 `CountingStorage`，不去拼一个原型被改过的对象——那种拼法在
    // 两个运行时里的行为并不保证一致，而这份文件正是双运行时都要跑的。
    class ReadFails extends CountingStorage {
      override async get<T>(k: string): Promise<T | null> {
        this.gets += 1;
        void k;
        throw new Error("read quota exhausted");
      }
    }
    const storage = new ReadFails(new MemoryStorage(undefined, () => NOW));
    const { app } = await makeApp([], [], {}, () => NOW, {
      apiKeys: { ttlMs: APIKEY_CACHE_TTL_MS }, storage,
    });
    storage.gets = 0;
    for (let i = 0; i < ROUNDS; i++) {
      expect((await call(app, `sk-wrong-${i}`)).status).toBe(401);
    }
    expect(storage.gets, "读失败那一档没有被当成合法快照缓存 —— 每个错口令请求都在重试").toBe(1);
  });

  it("全部用主口令的 1000 次请求 ⇒ **0 次 get**（结构性的零，不是一个 if）", async () => {
    const { app, storage } = await quotaApp();
    for (let i = 0; i < ROUNDS; i++) {
      expect((await call(app, TEST_CONFIG.gatewayToken)).status).not.toBe(401);
    }
    expect(
      storage.gets,
      "主口令那条路径上出现了存储读 —— 那条路径上本来就没有 ensureFresh() 的调用点，"
      + "出现了就说明两段的顺序被反过来了，而那正是逃生口所在",
    ).toBe(0);
  });

  it("**完全不带凭据**的请求同样 0 次 get —— 最常见的扫描形态撬不动任何东西", async () => {
    const { app, storage } = await quotaApp();
    for (let i = 0; i < ROUNDS; i++) {
      expect((await app.request("/v1/models")).status).toBe(401);
    }
    expect(storage.gets).toBe(0);
  });

  it("有一把真的子密钥在用时，读的次数由 TTL 决定，与请求数无关", async () => {
    const { app, storage } = await quotaApp();
    const issued = await (await app.request("/admin/api/apikeys", {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ name: "quota-probe" }),
    })).json() as { secret: string };
    storage.gets = 0;
    for (let i = 0; i < ROUNDS; i++) {
      expect((await call(app, issued.secret)).status).not.toBe(401);
    }
    // 时钟不动 ⇒ 一个 TTL 之内 ⇒ 恒 1 次。
    expect(storage.gets, "读取次数跟着请求数走了 —— 缓存持有者没起作用").toBe(1);
  });
});

describe("配额账：写侧", () => {
  it("一次签发恒 1 次 put、0 次 delete、0 次 list —— 单 blob 的直接好处", async () => {
    const { app, storage } = await quotaApp();
    await app.request("/admin/api/apikeys", {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ name: "write-probe" }),
    });
    expect(storage.puts).toBe(1);
    expect(storage.deletes, "这一族一次 delete 都不该有：整表覆写").toBe(0);
    expect(storage.lists, "这一族一次 list 都不该有").toBe(0);
    // 写之前那一次回读是**必须付的**：整表覆写只能建立在最新的一份上。
    expect(storage.gets).toBe(1);
  });

  it("一次清理不管删几把，仍然恒 1 次 put、0 次 delete", async () => {
    const seeded = Array.from({ length: 50 }, (_, i) => ({
      id: `seed${String(i).padStart(8, "0")}`, name: `seed-${i}`,
      hash: String(i).padStart(64, "0"), hint: "0000", createdAt: NOW,
      // 全部已过期 ⇒ 一次清理要删掉 50 把。
      expiresAt: NOW - 1,
    }));
    const { app, storage } = await quotaApp({ version: 4, keys: seeded });
    const res = await app.request("/admin/api/apikeys/purge", {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ version: 4 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 50, remaining: 0 });
    expect(storage.puts).toBe(1);
    expect(storage.deletes, "退化成逐把 delete 的话，一次点击就是 50 次 delete").toBe(0);
  });

  it("面板列一次表 = 1 次 get —— 它刻意不走持有者的快照，理由在 handler 的文件头", async () => {
    const { app, storage } = await quotaApp();
    await app.request("/admin/api/apikeys", { headers: AUTH });
    expect(storage.gets).toBe(1);
    expect(storage.puts).toBe(0);
  });
});
