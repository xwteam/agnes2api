import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN, TEST_CONFIG } from "../helpers/make-app.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { APIKEY_KEY } from "../../src/http/apikey-store.js";
import { APIKEY_MAX } from "../../src/core/admin/api-keys.js";

/**
 * 对外 API 密钥（我们**签发**给下游的那一族）的端到端契约。**双运行时都跑。**
 *
 * ⚠️ 与 `tests/contract/admin-keys*.test.ts` 是两回事：那一族是**上游 key 池**
 *（我们持有的凭据），这一族是我们签发的。完整对照表在
 * `src/core/admin/api-keys.ts` 的文件头。
 *
 * 本文件里的每一格都对应一条设计上的裁定，而不是「把 CRUD 各点一遍」：
 * ① 签发出来的密钥真的能打 `/v1`，停用 / 过期 / 删除之后真的打不动；
 * ② **主口令那条逃生口**在密钥表坏掉时一个字节都不受影响；
 * ③ 明文只在签发那一次的响应体里出现过（**整个响应体子串扫描**）；
 * ④ 乐观并发、上限、坏值不覆盖。
 */

const NOW = 1_700_000_000_000;
const AUTH = { "x-admin-key": TEST_ADMIN_TOKEN };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

type App = Awaited<ReturnType<typeof makeApp>>["app"];

/** 一台接了子密钥存储的 app。**存储交出来**，几格用例要直接看它。 */
async function akApp(now: () => number = () => NOW) {
  const storage = new MemoryStorage(undefined, now);
  const made = await makeApp([], ["sk-upstream-pool-key-aaaa"], {}, now, { apiKeys: {}, storage });
  return { ...made, storage };
}

async function issue(app: App, body: Record<string, unknown>) {
  const res = await app.request("/admin/api/apikeys", {
    method: "POST", headers: JSON_AUTH, body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.clone().text(), body: await res.json() as Record<string, unknown> };
}

/** 拿一把凭据去打网关。**用 `/v1/models`**：它不出站，够干净地把「通不通」这件事分出来。 */
const call = async (app: App, credential: string): Promise<Response> =>
  await app.request("/v1/models", { headers: { authorization: `Bearer ${credential}` } });

describe("对外 API 密钥：签发之后真的能用，停用 / 过期 / 删除之后真的用不了", () => {
  it("签发 → 打 /v1 通 → 停用 → 401", async () => {
    const { app } = await akApp();
    const issued = await issue(app, { name: "mobile-app" });
    expect(issued.status).toBe(201);
    const secret = issued.body.secret as string;
    const record = issued.body.record as { id: string };

    // **与主口令拿到的是同一个状态码**：这一格要证的是「这把密钥被当成一把
    // 合法凭据放行了」，而不是某个具体端点的返回值。
    const master = await call(app, TEST_CONFIG.gatewayToken);
    expect((await call(app, secret)).status).toBe(master.status);
    expect(master.status).not.toBe(401);

    const patched = await app.request(`/admin/api/apikeys/${record.id}`, {
      method: "PATCH", headers: JSON_AUTH,
      body: JSON.stringify({ version: issued.body.version, disabled: true }),
    });
    expect(patched.status).toBe(200);
    expect((await call(app, secret)).status).toBe(401);
    // 停用不影响主口令。
    expect((await call(app, TEST_CONFIG.gatewayToken)).status).toBe(master.status);
  });

  it("过期 → 401，而且边界是「到期那一刻已经在期外」", async () => {
    let clock = NOW;
    const { app } = await akApp(() => clock);
    const issued = await issue(app, { name: "expiring", expiresAt: NOW + 1000 });
    expect(issued.status).toBe(201);
    const secret = issued.body.secret as string;

    clock = NOW + 999;
    expect((await call(app, secret)).status).not.toBe(401);
    clock = NOW + 1000;
    expect((await call(app, secret)).status).toBe(401);
  });

  it("删除 → 401", async () => {
    const { app } = await akApp();
    const issued = await issue(app, { name: "throwaway" });
    const secret = issued.body.secret as string;
    const record = issued.body.record as { id: string };
    const del = await app.request(
      `/admin/api/apikeys/${record.id}?version=${issued.body.version}`,
      { method: "DELETE", headers: AUTH },
    );
    expect(del.status).toBe(204);
    expect((await call(app, secret)).status).toBe(401);
  });

  it("401 的响应体对「没这把」「停用了」「过期了」说的是同一句话 —— 区分它们就是给扫描者一个枚举接口", async () => {
    let clock = NOW;
    const { app } = await akApp(() => clock);
    const a = await issue(app, { name: "to-disable" });
    await app.request(`/admin/api/apikeys/${(a.body.record as { id: string }).id}`, {
      method: "PATCH", headers: JSON_AUTH,
      body: JSON.stringify({ version: a.body.version, disabled: true }),
    });
    const b = await issue(app, { name: "to-expire", expiresAt: NOW + 10 });
    clock = NOW + 10;

    const bodies = await Promise.all([
      call(app, "sk-nobody-ever-issued-this-one").then((r) => r.text()),
      call(app, a.body.secret as string).then((r) => r.text()),
      call(app, b.body.secret as string).then((r) => r.text()),
    ]);
    expect(new Set(bodies).size, `三档的响应体不一样：${JSON.stringify(bodies)}`).toBe(1);
  });

  it("认出来但不可用时打一条事件（带 id 与档位）；而「没有这把密钥」一条都不打 —— 那条路径零凭据零限速", async () => {
    const { app, logger } = await akApp();
    const issued = await issue(app, { name: "to-disable" });
    await app.request(`/admin/api/apikeys/${(issued.body.record as { id: string }).id}`, {
      method: "PATCH", headers: JSON_AUTH,
      body: JSON.stringify({ version: issued.body.version, disabled: true }),
    });
    logger.clear();

    await call(app, "sk-nobody-ever-issued-this-one");
    expect(logger.entries.filter((e) => e.event === "apikey.rejected"), "扫描器不该能往事件里灌东西")
      .toEqual([]);

    await call(app, issued.body.secret as string);
    const rejected = logger.entries.filter((e) => e.event === "apikey.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.fields?.id).toBe((issued.body.record as { id: string }).id);
    expect(rejected[0]?.fields?.bucket).toBe("disabled");
  });
});

describe("对外 API 密钥：主口令那条逃生口", () => {
  it("密钥表是坏值时主口令仍然通 —— 这一条就是逃生口本身", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    await storage.put(APIKEY_KEY, "这不是一张表");
    const { app } = await makeApp([], ["sk-upstream-pool-key-aaaa"], {}, () => NOW, {
      apiKeys: {}, storage,
    });
    const res = await call(app, TEST_CONFIG.gatewayToken);
    expect(res.status).not.toBe(401);
    // 而任何一把子密钥（哪怕格式看起来对）此刻都验不过：表读不出来 = 没有可用的表。
    expect((await call(app, "sk-anything-at-all")).status).toBe(401);
  });

  it("坏值不许被写路径覆盖 —— 原字节留在存储里一个都没动", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    await storage.put(APIKEY_KEY, { version: 1, keys: [{ id: "x" }] });
    const { app } = await makeApp([], [], {}, () => NOW, { apiKeys: {}, storage });

    const res = await app.request("/admin/api/apikeys", {
      method: "POST", headers: JSON_AUTH, body: JSON.stringify({ name: "must-not-overwrite" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("apikeys_unreadable");
    expect(await storage.get(APIKEY_KEY)).toEqual({ version: 1, keys: [{ id: "x" }] });
  });

  it("列表端点如实报「读不出来」，而不是报一张空表 —— 两者在面板上必须分得开", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    await storage.put(APIKEY_KEY, "这不是一张表");
    const { app } = await makeApp([], [], {}, () => NOW, { apiKeys: {}, storage });
    const body = await (await app.request("/admin/api/apikeys", { headers: AUTH })).json() as {
      unreadable: boolean; version: number | null; keys: unknown[];
    };
    expect(body.unreadable).toBe(true);
    expect(body.version).toBeNull();
    expect(body.keys).toEqual([]);
  });
});

describe("对外 API 密钥：明文只在签发那一次出现", () => {
  it("整个响应体子串扫描 —— 列表 / 单条改动 / 事件下载里都不含它", async () => {
    const { app, logger } = await akApp();
    const issued = await issue(app, { name: "plaintext-probe" });
    const secret = issued.body.secret as string;
    expect(issued.text, "签发那一次必须真的带明文，否则这一格在测空气").toContain(secret);
    const record = issued.body.record as { id: string };

    // ⚠️ **扫的是整个响应体文本，不是某个字段名**：查字段名的话，
    // 哪天有人把明文塞进 `debug` 或错误信息里，这一格照样绿。
    const list = await (await app.request("/admin/api/apikeys", { headers: AUTH })).text();
    expect(list).not.toContain(secret);

    const patched = await (await app.request(`/admin/api/apikeys/${record.id}`, {
      method: "PATCH", headers: JSON_AUTH,
      body: JSON.stringify({ version: issued.body.version, name: "renamed" }),
    })).text();
    expect(patched).not.toContain(secret);

    const events = await (await app.request("/admin/api/events", { headers: AUTH })).text();
    expect(events).not.toContain(secret);
    for (const e of logger.entries) expect(JSON.stringify(e)).not.toContain(secret);
  });

  it("摘要同样不出网：列表里既没有明文也没有它的 SHA-256", async () => {
    const { app, storage } = await akApp();
    const issued = await issue(app, { name: "digest-probe" });
    const stored = await storage.get<{ keys: Array<{ hash: string }> }>(APIKEY_KEY);
    const hash = stored?.keys[0]?.hash;
    expect(hash, "存储里必须真的有一份摘要，否则这一格在测空气").toMatch(/^[0-9a-f]{64}$/);
    expect(issued.text).not.toContain(hash);
    const list = await (await app.request("/admin/api/apikeys", { headers: AUTH })).text();
    expect(list).not.toContain(hash);
  });

  /**
   * ⚠️⚠️ **这一格的断言在 2026-09-10 被整个翻转了，翻转是用户拍板的结果，不是回归。**
   *
   * 它从前逐字断言「存储里一个字节的明文都没有 —— 这一族存的是摘要」。用户明确要求
   * 面板能「点击显示明文并复制」，而这一族的明文在签发那次 201 之后**不存在于世界上**，
   * 唯一的实现路径就是把明文一并存下来。代价已在
   * `src/core/admin/api-keys.ts` 的 `ApiKeyRecord.secret` 里如实登记：
   * 面板被打穿 = 全部客户端密钥明文一次性泄漏；存储介质的处置级别要跟着升。
   *
   * 🔴 **翻转的是「存不存」，不是「随便给」。** 下面第二、三条钉住的才是真正的防线，
   * 它们一个字都没松：**明文不进列表响应、不进事件**。
   */
  it("签发的明文会落进存储 —— 这是用户拍板的取舍，不是漏存摘要", async () => {
    const { app, storage } = await akApp();
    const issued = await issue(app, { name: "storage-probe" });
    const raw = JSON.stringify(await storage.get(APIKEY_KEY));
    expect(raw, "明文没落盘 ⇒ 面板的『显示明文』永远只能回 null").toContain(issued.body.secret as string);
    // 摘要仍然在，且仍是鉴权那条热路径的依据 —— 这次改动一个字都没动鉴权。
    expect(raw).toContain('"hash"');
  });

  it("明文绝不进列表响应 —— 列表是高频无意识调用的，塞进去等于到处都是凭据", async () => {
    const { app } = await akApp();
    const issued = await issue(app, { name: "list-probe" });
    const res = await app.request("/admin/api/apikeys", { headers: AUTH });
    const text = await res.text();
    expect(text, "明文出现在列表响应里了").not.toContain(issued.body.secret as string);
  });

  it("取明文要留痕，但事件里绝不含明文本身", async () => {
    const { app, logger } = await akApp();
    const issued = await issue(app, { name: "reveal-probe" });
    const id = (issued.body.record as { id: string }).id;
    const res = await app.request(`/admin/api/apikeys/${id}/reveal`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((await res.json() as { secret: string }).secret).toBe(issued.body.secret);

    const e = logger.entries.find((x) => x.event === "apikey.revealed");
    expect(e, "取回明文是一次凭据访问，必须留痕").toBeDefined();
    expect(JSON.stringify(e), "事件里带上了明文 —— 事件常被转发到第三方")
      .not.toContain(issued.body.secret as string);
  });
});

describe("对外 API 密钥：乐观并发、上限与接线", () => {
  it("拿旧 version 来写 ⇒ 409 stale_write，而且一个字节都没写", async () => {
    const { app, storage } = await akApp();
    const a = await issue(app, { name: "one" });
    const id = (a.body.record as { id: string }).id;
    const stale = a.body.version as number;
    // 别人先改了一次 ⇒ 版本号往前走。
    await app.request(`/admin/api/apikeys/${id}`, {
      method: "PATCH", headers: JSON_AUTH, body: JSON.stringify({ version: stale, name: "two" }),
    });
    const before = await storage.get(APIKEY_KEY);

    const res = await app.request(`/admin/api/apikeys/${id}`, {
      method: "PATCH", headers: JSON_AUTH,
      body: JSON.stringify({ version: stale, name: "from-a-stale-screen" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; params: Record<string, number> } };
    expect(body.error.code).toBe("stale_write");
    expect(body.error.params).toEqual({ expected: stale, actual: stale + 1 });
    expect(await storage.get(APIKEY_KEY)).toEqual(before);
  });

  it("删除与清理同样收 version —— 那是运维屏幕上那个数", async () => {
    const { app } = await akApp();
    const a = await issue(app, { name: "one" });
    const id = (a.body.record as { id: string }).id;
    const stale = a.body.version as number;
    await app.request(`/admin/api/apikeys/${id}`, {
      method: "PATCH", headers: JSON_AUTH, body: JSON.stringify({ version: stale, name: "two" }),
    });
    expect((await app.request(`/admin/api/apikeys/${id}?version=${stale}`, {
      method: "DELETE", headers: AUTH,
    })).status).toBe(409);
    expect((await app.request("/admin/api/apikeys/purge", {
      method: "POST", headers: JSON_AUTH, body: JSON.stringify({ version: stale }),
    })).status).toBe(409);
  });

  it("超过 APIKEY_MAX ⇒ 400，不静默截断", async () => {
    const storage = new MemoryStorage(undefined, () => NOW);
    await storage.put(APIKEY_KEY, {
      version: 1,
      keys: Array.from({ length: APIKEY_MAX }, (_, i) => ({
        id: `full${String(i).padStart(8, "0")}`, name: `full-${i}`,
        hash: String(i).padStart(64, "0"), hint: "0000", createdAt: NOW, expiresAt: null,
      })),
    });
    const { app } = await makeApp([], [], {}, () => NOW, { apiKeys: {}, storage });
    const res = await app.request("/admin/api/apikeys", {
      method: "POST", headers: JSON_AUTH, body: JSON.stringify({ name: "one-too-many" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("too_many_apikeys");
    const after = await storage.get<{ keys: unknown[] }>(APIKEY_KEY);
    expect(after?.keys).toHaveLength(APIKEY_MAX);
  });

  it("清理失效：删掉的恰好是「此刻用不了的那些」，可用的一把不动", async () => {
    let clock = NOW;
    const { app } = await akApp(() => clock);
    const keep = await issue(app, { name: "keep" });
    const dis = await issue(app, { name: "disabled" });
    await app.request(`/admin/api/apikeys/${(dis.body.record as { id: string }).id}`, {
      method: "PATCH", headers: JSON_AUTH,
      body: JSON.stringify({ version: dis.body.version, disabled: true }),
    });
    const exp = await issue(app, { name: "expiring", expiresAt: NOW + 10 });
    clock = NOW + 10;

    const list = await (await app.request("/admin/api/apikeys", { headers: AUTH })).json() as {
      version: number; counts: Record<string, number>;
    };
    expect(list.counts).toEqual({ all: 3, active: 1, disabled: 1, expired: 1 });

    const res = await app.request("/admin/api/apikeys/purge", {
      method: "POST", headers: JSON_AUTH, body: JSON.stringify({ version: list.version }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 2, remaining: 1 });
    // 留下的正是那把还能用的。
    expect((await call(app, keep.body.secret as string)).status).not.toBe(401);
    expect((await call(app, exp.body.secret as string)).status).toBe(401);
  });

  it("没接线的部署：五条端点如实回 503 not_wired，而 /v1 的主口令照常通", async () => {
    // **默认夹具就是没接的那一档**，这是生产上一个正常形态（一把子密钥都没签发过）。
    const { app } = await makeApp([], ["sk-upstream-pool-key-aaaa"], {}, () => NOW);
    const probes: Array<[string, RequestInit]> = [
      ["/admin/api/apikeys", { headers: AUTH }],
      ["/admin/api/apikeys", { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ name: "x" }) }],
      ["/admin/api/apikeys/purge", { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ version: 0 }) }],
      ["/admin/api/apikeys/abc?version=0", { method: "DELETE", headers: AUTH }],
      ["/admin/api/apikeys/abc", { method: "PATCH", headers: JSON_AUTH, body: JSON.stringify({ version: 0, name: "x" }) }],
    ];
    for (const [path, init] of probes) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(503);
      expect((await res.json() as { reason: string }).reason, path).toBe("not_wired");
    }
    expect((await call(app, TEST_CONFIG.gatewayToken)).status).not.toBe(401);
  });

  it("capabilities 如实报接没接、上限与生效的缓存 TTL —— 面板不许在前端写死它们", async () => {
    const { app } = await akApp();
    const cap = await (await app.request("/admin/api/capabilities", { headers: AUTH })).json() as {
      apiKeys: { wired: boolean; max: number; plaintextRetrievable: boolean; cacheTtlMs: number };
    };
    expect(cap.apiKeys.wired).toBe(true);
    expect(cap.apiKeys.max).toBe(APIKEY_MAX);
    // **恒 false 是一条契约不是一格状态**：这一族存的是摘要，明文只出现过一次。
    // ⚠️ **2026-09-10 起是 true**：用户拍板把明文一并存下来（以安全性换面板上的
    // 「显示明文 / 复制」）。这一格当初被设计成「契约而不是状态」正是为了这一天。
    expect(cap.apiKeys.plaintextRetrievable).toBe(true);
    // 夹具把 TTL 设成 0（不缓存），`capabilities` 报的必须是**生效**的那个值。
    expect(cap.apiKeys.cacheTtlMs).toBe(0);

    const { app: bare } = await makeApp([], [], {}, () => NOW);
    const capBare = await (await bare.request("/admin/api/capabilities", { headers: AUTH })).json() as {
      apiKeys: { wired: boolean };
    };
    expect(capBare.apiKeys.wired).toBe(false);
  });
});
