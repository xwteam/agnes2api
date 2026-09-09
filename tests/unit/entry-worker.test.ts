import { describe, it, expect, vi } from "vitest";
import worker, { type Env } from "../../src/entry/worker.js";

/**
 * 最小可用的 KVNamespace 假实现，专用于本文件：只实现 worker 入口路径
 * 会用到的 get/put/delete/list，并记录 get 调用次数——用它作为
 * “app 是否被装配过一次”的可观测代理：buildApp -> loadConfig 每次都会
 * 恰好读一次 "config" 键，所以 get 调用次数 == app 被装配的次数。
 */
function fakeKv(): { kv: Env["POOL"]; getCalls: () => number } {
  const store = new Map<string, string>();
  let calls = 0;
  const kv = {
    async get(key: string) {
      calls++;
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
  };
  return { kv: kv as unknown as Env["POOL"], getCalls: () => calls };
}

describe("worker 入口: fail-closed", () => {
  it("缺少 GATEWAY_TOKEN 时拒绝服务（不是 200）", async () => {
    const { kv } = fakeKv();
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, { POOL: kv } as Env);
    expect(res.status).not.toBe(200);
  });

  it("缺少 GATEWAY_TOKEN 时，带空 x-api-key 的受保护请求也不会被放行", async () => {
    const { kv } = fakeKv();
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": "", "content-type": "application/json" },
      body: "{}",
    });
    const res = await worker.fetch(req, { POOL: kv } as Env);
    expect(res.status).not.toBe(200);
  });

  /**
   * ⚠️⚠️ **这一格在「Worker 侧把运维配错与代码 bug 分开」那一轮换了状态码，别照旧读。**
   *
   * 从前两档共用一个不说原因的 `500`。真机上的后果是：一次常规重新部署之后
   * **81 次探测 60 次 500**（`/health` 也在内），而唯一的线索只在 `wrangler tail`
   * ——同一份代码在 Node 上是 `process.exit(1)`、运维立刻看得见。
   *
   * ⇒ `ConfigRefusal`（运维配错）改回 **`503` + 固定枚举 `reason`**，
   * 非 `ConfigRefusal`（代码 bug）维持不透明的 `500`（下一格钉那一半）。
   *
   * ⚠️ **`not.toContain("GATEWAY_TOKEN")` 那半句一个字都不许删**：`reason` 是**固定
   * 枚举串、永不由 `err.message` 派生**。这是未鉴权路径，配置细节一个字节都不许出去。
   */
  it("缺 GATEWAY_TOKEN 时每个请求回 503 + reason:\"not_configured\"，不回显异常细节——这是未鉴权路径", async () => {
    // 缺 GATEWAY_TOKEN 且存储里也没有 ⇒ buildApp 抛 ConfigRefusal「缺少 GATEWAY_TOKEN，网关无法启动」
    const { kv } = fakeKv();
    const res = await worker.fetch(new Request("https://x.test/v1/models"), { POOL: kv } as Env);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: { type: "service_unavailable", message: "网关尚未完成配置" },
      reason: "not_configured",
    });
    expect(text).not.toContain("GATEWAY_TOKEN");
  });

  /**
   * **另一半：非 `ConfigRefusal` 的异常仍然是不透明的 `500`。**
   *
   * 少了这一格，把 catch 里那个 `instanceof` 判断整个删掉、一律回 `503`，
   * 上一格照样绿——而那样做等于对着一个**代码 bug** 说「网关尚未完成配置」，
   * 把运维支去改一份根本没问题的配置。
   */
  it("非 ConfigRefusal 的装配异常仍然回不透明的 500（那是代码 bug，不是运维配错）", async () => {
    // ⚠️ **夹具必须是一个真正的「代码 bug」，不能拿某个配置错误来充数。**
    //
    // ⚠️⚠️ **这段注释被订正过，别把它读回上一版。** 上一版逐字写着「逐条对树核实过：
    // `buildApp` 里今天所有会抛的地方都是运维配错，而它们已经全部改成 `ConfigRefusal`
    // 了……生产里今天没有一条已知输入能走到这一支」——**那是假话**：
    // `resolveUsageFlushInterval()` 在「有写配额」那一侧还留着**第二处**裸 `throw new Error(`，
    // 而 `src/http/wire.ts` 无条件调它、Worker 的 `quotaModel === "kv"` ⇒ 一句
    // `USAGE_FLUSH_INTERVAL_MS=300000` 就走得到这一支，且它是纯运维配错。
    // 那一处已在评审回填里换成 `ConfigRefusal`。
    //
    // ⇒ **今天这句话只敢说到这里**：`buildApp` 路径上**已知**的抛点都是运维配错、
    // 都已是 `ConfigRefusal`，而「有没有第 N 处漏网」不由这段注释担保——
    // 由 `tests/unit/source-guards.test.ts`「src/ 下凡是点名了环境变量的 throw，恰好等于手写清单且全是 ConfigRefusal」
    // 那一格担保（上一版正是因为把这件事写在注释里而没有机器守着，才让第二处漏了整整一轮）。
    // 所以这里直接把 `buildApp` 换成一个会抛裸 `Error` 的替身，
    // 钉的是**分流本身**（`instanceof` 那一句被删掉时这一格红）。
    vi.resetModules();
    vi.doMock("../../src/http/wire.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/http/wire.js")>();
      return {
        ...actual,
        buildApp: async () => { throw new Error("模拟一个代码 bug：不是 ConfigRefusal"); },
      };
    });
    try {
      const { default: freshWorker } = await import("../../src/entry/worker.js");
      const { kv } = fakeKv();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await freshWorker.fetch(
          new Request("https://x.test/v1/models"),
          { GATEWAY_TOKEN: "token-long-enough-for-this-test", POOL: kv } as Env,
        );
        expect(res.status).toBe(500);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: { type: "internal_error", message: "网关内部错误" } });
        expect(text, "内部异常的原文一个字都不许出去").not.toContain("模拟一个代码 bug");
      } finally {
        spy.mockRestore();
      }
    } finally {
      vi.doUnmock("../../src/http/wire.js");
      vi.resetModules();
    }
  });
});

// ── app 现在无条件缓存一次，不再按 env.GATEWAY_TOKEN 是否变化决定要不要重建 ──────
//
// 原实现里 `cachedToken !== env.GATEWAY_TOKEN` 在「没设 GATEWAY_TOKEN 环境变量」时
// 恒为 false（两边都是 undefined），于是热 isolate 里被吊销的旧口令会无限期继续
// 有效——这是「保存没生效」背后那个撤销不掉的凭据。新实现把口令改由 ConfigHolder
// 每请求读一次（TTL 内命中缓存），app 本身不再持有任何配置值，因此可以无条件缓存。
//
// worker.ts 的 `cachedApp` 是模块级单例，一旦某个测试触发过一次成功装配，同一个
// 静态 import 的模块实例会在整个文件剩余测试里都复用那份缓存——这里用
// `vi.resetModules()` + 动态 import 换一份全新的模块实例，让每条用例互不干扰。
describe("worker 入口: app 只装配一次，配置改由 ConfigHolder 每请求刷新", () => {
  it("同一次装配连续两次请求 /health，只读一次存储（app 不因重复请求被重建）", async () => {
    vi.resetModules();
    const { default: freshWorker } = await import("../../src/entry/worker.js");
    const { kv, getCalls } = fakeKv();
    const token = `same-${crypto.randomUUID()}`;
    const env = { GATEWAY_TOKEN: token, POOL: kv } as Env;

    await freshWorker.fetch(new Request("http://localhost/health"), env);
    await freshWorker.fetch(new Request("http://localhost/health"), env);

    expect(getCalls()).toBe(1);
  });

  it("app 装配之后即使 env.GATEWAY_TOKEN 变了也不会重建——这正是必须靠 ConfigHolder 兜底撤销的原因", async () => {
    vi.resetModules();
    const { default: freshWorker } = await import("../../src/entry/worker.js");
    const { kv, getCalls } = fakeKv();
    const t1 = `t1-${crypto.randomUUID()}`;
    const t2 = `t2-${crypto.randomUUID()}`;

    await freshWorker.fetch(new Request("http://localhost/health"), { GATEWAY_TOKEN: t1, POOL: kv } as Env);
    await freshWorker.fetch(new Request("http://localhost/health"), { GATEWAY_TOKEN: t2, POOL: kv } as Env);

    // 与改造前的行为刻意相反：只装配一次。env 在一个部署内本来就不会变，
    // 真正需要“改了就生效”的是存储里的配置，下一条用例覆盖那条路径。
    expect(getCalls()).toBe(1);
  });

  it("缺 env.GATEWAY_TOKEN 时，改存储里的 gatewayToken，跨一个 TTL 后旧口令失效、新口令生效", async () => {
    vi.resetModules();
    const { default: freshWorker } = await import("../../src/entry/worker.js");
    const { CONFIG_TTL_MS } = await import("../../src/http/config-holder.js");

    vi.useFakeTimers();
    try {
      const store = new Map<string, string>();
      store.set("config", JSON.stringify({ gatewayToken: "old-token-aaaa" }));
      const kv = {
        async get(key: string) {
          const raw = store.get(key);
          return raw === undefined ? null : JSON.parse(raw);
        },
        async put(key: string, value: string) { store.set(key, value); },
        async delete(key: string) { store.delete(key); },
        async list() { return { keys: [], list_complete: true, cacheStatus: null }; },
      } as unknown as Env["POOL"];
      // 刻意**不设** env.GATEWAY_TOKEN：这正是「撤销不掉的凭据」那个安全缺陷的触发条件。
      const env = { POOL: kv } as Env;

      const call = (token: string) =>
        freshWorker.fetch(
          new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${token}` } }),
          env,
        );

      expect((await call("old-token-aaaa")).status).toBe(200);

      store.set("config", JSON.stringify({ gatewayToken: "new-token-bbbb" }));
      // TTL 内：旧口令仍然有效，这是被承诺的上界，不是缺陷。
      expect((await call("old-token-aaaa")).status, "TTL 内仍是旧口令").toBe(200);

      await vi.advanceTimersByTimeAsync(CONFIG_TTL_MS);

      // **两条断言都要有**：只断言「新口令能用」的话，把 auth 改成放行一切也会绿。
      expect((await call("old-token-aaaa")).status, "旧口令必须失效").toBe(401);
      expect((await call("new-token-bbbb")).status, "新口令必须可用").toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── `fetch` 必须把 ExecutionContext 一路递给 app ──────────────────────────────
//
// **入口那一行原本是 `return app.fetch(req)`，只有一个参数**——当时全仓
// 只有 `scheduled()` 用得上 ctx，所以没人发现少了它。
// 「立即补池」返回 202 之后补池还要继续跑，Worker 形态下那需要 `ctx.waitUntil`；
// 不递进去的话 handler 里的 `c.executionCtx` 直接抛错 ⇒ 退化成 fire-and-forget ⇒
// 响应一返回 isolate 就可能停摆、补池被从中间砍断 ⇒ `mintOne` 的 `finally` 不跑 ⇒
// **临时邮箱漏删**，攒够几个就把活跃邮箱名额吃光。
//
// ⚠️ **判据必须是行为，不能是 `fetch.length >= 3` 这种形状断言**：`ctx` 声明成可选
// 参数，`Function.length` 根本数不到它（可选参数不计入），那条断言在正确实现上就是
// 假的；更糟的是它对「收了参数但没往下传」完全无感——而那恰恰是最可能发生的写法。
// 所以这一格走**真实入口 + 真实端点**：`worker.fetch(req, env, ctx)` 打一次
// 「立即补池」，看那个 ctx 有没有真的收到一个后台任务。
describe("worker 入口: fetch 把 ExecutionContext 一路传给 app", () => {
  it("fetch 把 ExecutionContext 一路传给 app —— 不传的话 waitUntil 在生产里根本拿不到", async () => {
    vi.resetModules();
    const { default: freshWorker } = await import("../../src/entry/worker.js");
    const { TEST_ADMIN_TOKEN } = await import("../helpers/make-app.js");
    const { WORKER_ROUND_BUDGET_MS } = await import("../../src/core/registrar/types.js");
    const { kv } = fakeKv();
    const env = {
      GATEWAY_TOKEN: `ctx-gateway-${crypto.randomUUID()}`,
      ADMIN_TOKEN: TEST_ADMIN_TOKEN,
      POOL: kv,
      REGISTRAR_ENABLED: "true",
      REGISTRAR_PRIMARY: "yyds",
      YYDS_API_KEY: "k",
      TARGET_KEYS: "1",
      // 比 Worker 单轮墙钟预算还大 ⇒ tendOnce 一次尝试都不开始 ⇒ 零网络、毫秒级返回。
      CODE_TIMEOUT_MS: String(WORKER_ROUND_BUDGET_MS + 1),
      // 零网络的**第二道保险**：上面那条成立与否取决于被测代码真的传了 roundBudgetMs
      //（变异实测：把那一行删掉，同形的契约用例当场打了 YYDS 的线上接口）。
      // `.invalid` 是 RFC 6761 的保留 TLD，永不解析。
      YYDS_BASE_URL: "https://yyds.invalid",
    } as unknown as Env;

    const waited: Array<Promise<unknown>> = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { waited.push(p); },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await freshWorker.fetch(
        new Request("http://localhost/admin/api/registrar/tend", {
          method: "POST", headers: { "x-admin-key": TEST_ADMIN_TOKEN },
        }),
        env,
        ctx,
      );
      expect(res.status, "前置条件：这一发必须真的跑完了一轮补池").toBe(200);
      expect(
        waited.length,
        "入口把 ExecutionContext 丢在门口了 ⇒ 补池退化成 fire-and-forget，响应返回后会被截断",
      ).toBe(1);
      await Promise.all(waited);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
