import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../../src/http/wire.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";

/**
 * **真机事故的回归：注册机开着却缺 MoeMail 凭据，整个网关不许因此死掉。**
 *
 * ── 取证（这一格是照着它写的）────────────────────────────────────────────────
 *
 * 线上 Cloudflare Worker 部署，一次常规重新部署之后 **81 次探测里 60 次返回 500**
 *（74%），`/health` 也在内。`wrangler tail` 捞出的真因逐字是：
 *
 *     [agnes2api] 装配失败
 *     Error: 注册机已启用但缺少 MOEMAIL_API_KEY
 *       at creds → registrarFromEnv → loadConfigWithProvenance
 *       → loadConfig → createConfigHolder → buildApp → Object.fetch
 *
 * KV 里的配置早就被存成「注册机已启用 + 缺 moemail 凭据」，但老 isolate 缓存着旧配置
 * 照常跑；一次重新部署把老 isolate 全清掉，新 isolate 一读配置就抛 ⇒ 全线 500。
 * **这颗雷潜伏了很久才引爆。**
 *
 * ── 为什么是 contract（两个池子都跑）──────────────────────────────────────────
 *
 * 「同一份代码在两种运行时上得到相反的运维体验」正是这次缺陷的第二层。这一格因此
 * 必须在 node 与 workerd 两个池子里各跑一遍——只在 node 上绿，证明不了 Worker 那边
 * 的 isolate 冷启动也活得下来。
 *
 * ⚠️ **判据里那条 `console.error` 计数不许删**：Worker 入口把装配异常 catch 成一个
 * 不带原因的通用响应，唯一的线索就是那行 `console.error`。它被调过 = 装配又抛了
 * ——即便别的断言碰巧还绿（例如 `cachedApp` 恰好被别的用例填过）。
 */
describe("注册机装不起来时，网关照常活着（真机 74% 500 的回归）", () => {
  /** 线上那份 KV 值**原样**：注册机开着、主通道 moemail、只有 baseUrl 没有 apiKey。 */
  const BROKEN = {
    registrar: {
      enabled: true,
      primary: "moemail",
      moemail: { baseUrl: "https://mail.example.invalid" },
    },
  };

  const GW = "gateway-token-for-config-degrade-test";
  /** ≥ `ADMIN_TOKEN_MIN_LENGTH` 且与 `GW` 不同 —— 两条硬规则都得满足，否则 `/admin` 根本不注册。 */
  const ADMIN = "admin-token-for-config-degrade-test";

  async function coldApp() {
    const storage = new MemoryStorage();
    await storage.put("config", BROKEN);
    // **走真的 `buildApp`**，不是夹具装配：这次缺陷的成因整条链是
    // `buildApp → createConfigHolder → prime → loadConfig → registrarFromEnv`，
    // 照抄一份装配永远验证不了原件。
    return buildApp({ GATEWAY_TOKEN: GW, ADMIN_TOKEN: ADMIN }, storage);
  }

  it("冷装配本身不抛，且一行「装配失败」都没打", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(coldApp()).resolves.toBeDefined();
      expect(
        spy.mock.calls.filter((c) => String(c[0]).includes("[agnes2api] 装配失败")),
        "又抛了 —— Worker 上这等于「部署成功、每个请求 500、原因只在 wrangler tail」",
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("/health 不是 500 —— 它是不鉴权端点，也是镜像 HEALTHCHECK 认的那一条", async () => {
    const { app } = await coldApp();
    const res = await app.request("/health");
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
  });

  it("带口令的 /v1/models 不是 500 —— 转发能力与可选子系统无关", async () => {
    const { app } = await coldApp();
    const res = await app.request("/v1/models", { headers: { authorization: `Bearer ${GW}` } });
    expect(res.status).not.toBe(500);
  });

  it("GET /admin/api/config 给的是完整视图 + 逐条 loadBlocked，不是诊断视图", async () => {
    const { app } = await coldApp();
    const res = await app.request("/admin/api/config", {
      headers: { "x-admin-key": ADMIN },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      fields: Record<string, { effective: unknown }> | null;
      loadBlocked: Array<{ field: string; code: string; params?: Record<string, unknown> }>;
    };
    expect(body.fields, "注册机缺一把 key，不该让面板读不到任何当前值").not.toBeNull();
    expect(body.loadBlocked, "面板上必须逐条说清缺的是哪一格").toEqual([
      { field: "registrar.moemail.apiKey", code: "channel_credentials_missing", params: { channel: "moemail" } },
    ]);
    // **开关一个字都不改**，真话是「已启用 · 本次没跑起来」。
    expect(body.fields!["registrar.enabled"]!.effective).toBe(true);
    expect(body.fields!["registrar.blocked"]!.effective).toBe(true);
  });
});
