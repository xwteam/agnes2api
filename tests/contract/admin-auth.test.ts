import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN, TEST_CONFIG } from "../helpers/make-app.js";
import {
  constantTimeEqual, checkAdminToken, ADMIN_TOKEN_MIN_LENGTH,
} from "../../src/http/admin/auth.js";
import { createApp } from "../../src/http/app.js";
import { createConfigHolder, CONFIG_TTL_MS } from "../../src/http/config-holder.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { FakeFetcher } from "../helpers/fake-fetcher.js";
import { recordingLogger } from "../helpers/recording-logger.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

describe("constantTimeEqual", () => {
  it("相等返回 true，任一位不同返回 false", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
    expect(constantTimeEqual("abcdef", "abcdeg")).toBe(false);
    expect(constantTimeEqual("abcdef", "Abcdef")).toBe(false);
  });
  it("长度不同返回 false，且不抛错", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
  it("非 ASCII 也逐码元比较", () => {
    expect(constantTimeEqual("口令令", "口令令")).toBe(true);
    expect(constantTimeEqual("口令令", "口令另")).toBe(false);
  });
});

describe("checkAdminToken", () => {
  /**
   * ⚠️ 边界值一律写**字面量 23 / 24**，不许写 `ADMIN_TOKEN_MIN_LENGTH - 1`。
   *
   * 后者是同义反复：输入从被测的那个常量推导出来，于是把下限改成 8 也照样全绿
   *（已实测：计划给的那版用例正是这么写的，变异 M9 完整逃逸）。24 是**策略**
   * ——`.env.example` 与设计文档 §8.1 对外承诺的那个数字——所以它必须被独立钉住。
   */
  it("下限是 24 位这个数字本身就是策略，独立钉死", () => {
    expect(ADMIN_TOKEN_MIN_LENGTH).toBe(24);
  });
  it("短于 24 位被拒，正好 24 位放行", () => {
    expect(checkAdminToken("x".repeat(23), "g")).toEqual({ ok: false, reason: "too_short" });
    expect(checkAdminToken("x".repeat(24), "g").ok).toBe(true);
  });
  it("空串也走 too_short 这条，绝不会被判成合规口令", () => {
    expect(checkAdminToken("", "g")).toEqual({ ok: false, reason: "too_short" });
  });
  it("等于 GATEWAY_TOKEN 被拒——复用中转口令等于把整池 key 交给每个下游用户", () => {
    const t = "x".repeat(30);
    expect(checkAdminToken(t, t)).toEqual({ ok: false, reason: "same_as_gateway_token" });
  });
});

describe("ADMIN_TOKEN 未设置时 /admin 整棵树 404（不泄漏「这里有个后台」）", () => {
  it("不带凭据是 404 而不是 401", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: undefined });
    expect((await app.request("/admin/api/session")).status).toBe(404);
  });
  it("带正确凭据也还是 404", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: undefined });
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(404);
  });
  it("空字符串的 ADMIN_TOKEN 等同未设置——**绝不能**变成「空口令就能进」", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: "" });
    expect((await app.request("/admin/api/session")).status).toBe(404);
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": "" } });
    expect(res.status).toBe(404);
  });
});

describe("ADMIN_TOKEN 不合规时同样整棵树 404，但网关照常转发", () => {
  // 「与网关口令相同」这一格必须用一个**够长**的口令：checkAdminToken 先查长度，
  // 拿夹具那个一位的 "t" 来试，命中的其实是 too_short，两条规则就分不开了。
  // 长度一律写字面量（理由见 checkAdminToken 那组用例的说明）。
  const LONG = "x".repeat(30);
  const CASES: Array<{
    name: string; token: string; gatewayToken: string; reason: string;
  }> = [
    {
      name: "太短（23 位）", token: "x".repeat(23),
      gatewayToken: TEST_CONFIG.gatewayToken, reason: "too_short",
    },
    { name: "与网关口令相同", token: LONG, gatewayToken: LONG, reason: "same_as_gateway_token" },
  ];

  for (const { name, token, gatewayToken, reason } of CASES) {
    it(`${name}：/admin 404，/v1/models 仍然 200，事件记 reason=${reason}`, async () => {
      const { app, logger } = await makeApp([], ["k1"], { gatewayToken }, undefined, { adminToken: token });
      expect((await app.request("/admin/api/session")).status).toBe(404);
      const ok = await app.request("/v1/models", { headers: { authorization: `Bearer ${gatewayToken}` } });
      // 转发能力与管理能力相互独立：管理口令配错不该让网关停摆。
      expect(ok.status).toBe(200);
      // 静默地不启用面板，运维会以为「后台坏了」而查不到原因，故必须留下事件，
      // 且两种不合规要能被区分开。
      const e = logger.entries.find((x) => x.event === "admin.token_rejected");
      expect(e?.fields?.reason).toBe(reason);
      // 事件会进容器日志与将来的事件板块，不许把口令本身带出去。
      expect(JSON.stringify(e)).not.toContain(token);
    });
  }
});

describe("adminAuth", () => {
  it("正确的 x-admin-key 放行", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(200);
  });

  it("缺凭据 / 错凭据都是 401", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/session")).status).toBe(401);
    expect((await app.request("/admin/api/session", { headers: { "x-admin-key": "wrong" } })).status).toBe(401);
  });

  it("**不接受 ?key= 查询参数**——口令进 URL 会落进浏览器历史、Referer 与各级访问日志", async () => {
    const { app } = await makeApp();
    const res = await app.request(`/admin/api/session?key=${TEST_ADMIN_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("**不接受 Authorization: Bearer**——两把钥匙必须严格隔离，网关口令不该能开后台", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/api/session", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("网关口令开不了后台，管理口令也调不动 /v1", async () => {
    const { app } = await makeApp();
    const asAdmin = await app.request("/admin/api/session", {
      headers: { "x-admin-key": TEST_CONFIG.gatewayToken },
    });
    expect(asAdmin.status).toBe(401);
    const asGateway = await app.request("/v1/models", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(asGateway.status).toBe(401);
  });

  it("失败时记 admin.login_failed 事件（面板将来靠它看爆破痕迹）", async () => {
    const { app, logger } = await makeApp();
    await app.request("/admin/api/session", { headers: { "x-admin-key": "wrong" } });
    const e = logger.entries.find((x) => x.event === "admin.login_failed");
    expect(e?.fields?.path).toBe("/admin/api/session");
    expect(e?.fields?.hasHeader).toBe(true);
  });

  it("完全没带请求头时 hasHeader=false——「带了但打错」与「压根没带」是两种痕迹", async () => {
    const { app, logger } = await makeApp();
    await app.request("/admin/api/session");
    expect(logger.entries.find((x) => x.event === "admin.login_failed")?.fields?.hasHeader).toBe(false);
  });

  it("成功时**不**记 login_failed——记了的话爆破痕迹就淹没在正常流量里", async () => {
    const { app, logger } = await makeApp();
    await app.request("/admin/api/session", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(logger.has("admin.login_failed")).toBe(false);
  });

  it("**事件里不带口令本身**——日志会被转发到第三方，泄漏它等于泄漏后台", async () => {
    const { app, logger } = await makeApp();
    await app.request("/admin/api/session", { headers: { "x-admin-key": "guessed-secret-value" } });
    const e = logger.entries.find((x) => x.event === "admin.login_failed");
    const dump = JSON.stringify(e);
    expect(dump).not.toContain("guessed-secret-value");
    expect(dump).not.toContain(TEST_ADMIN_TOKEN);
  });
});

describe("客户端 IP", () => {
  /** 打一次失败登录，把事件里记下来的 ip 取出来。 */
  async function loggedIp(
    headers: Record<string, string>,
    options: Parameters<typeof makeApp>[4] = {},
  ) {
    const { app, logger } = await makeApp([], ["k1"], {}, undefined, options);
    await app.request("/admin/api/session", { headers: { "x-admin-key": "wrong", ...headers } });
    return logger.entries.find((x) => x.event === "admin.login_failed")?.fields?.ip;
  }

  // ── 门控之外：两个头**都**不可信 ────────────────────────────────────────
  // 这个值会写进爆破痕迹，信错了等于允许任何人把痕迹嫁祸给任意 IP。

  it("默认不信 X-Forwarded-For", async () => {
    expect(await loggedIp({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).toBeNull();
  });

  it("默认**也不信 CF-Connecting-IP**——Node 直连形态下没人覆盖它，客户端自己发一个就成立", async () => {
    expect(await loggedIp({ "cf-connecting-ip": "198.51.100.9" })).toBeNull();
  });

  it("什么都拿不到时如实记 null，不伪造一个 \"unknown\" 冒充 IP", async () => {
    expect(await loggedIp({})).toBeNull();
  });

  // ── 门控之内：CF-Connecting-IP 优先，XFF 只作兜底 ────────────────────────
  // 两个头的**可伪造性根本不同**：CF-Connecting-IP 由 Cloudflare 边缘写入，且会覆盖
  // 客户端传来的同名头，请求真的经过 CF 时伪造不了；XFF 是任何中间件都能追加的链，
  // 客户端可以自己发一个假的。Worker 形态下 CF 定义上就在前面，那里优先 XFF 是错的。

  it("TRUST_PROXY=1 且两个头同时在场时取 CF-Connecting-IP，**不**取伪造的 XFF", async () => {
    // 两个头刻意给**不同的值**：给同一个值的话谁赢都通过，是这个项目的第 1 种假阳性。
    const ip = await loggedIp(
      { "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      { trustProxy: true },
    );
    expect(ip).toBe("198.51.100.9");
  });

  it("TRUST_PROXY=1 且只有 CF-Connecting-IP 时用它", async () => {
    expect(await loggedIp({ "cf-connecting-ip": "198.51.100.9" }, { trustProxy: true }))
      .toBe("198.51.100.9");
  });

  it("TRUST_PROXY=1 且 CF-Connecting-IP 缺席时，退到 XFF 首段", async () => {
    expect(await loggedIp({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, { trustProxy: true }))
      .toBe("203.0.113.7");
  });

  it("TRUST_PROXY=1 但两个头都没有时仍是 null", async () => {
    expect(await loggedIp({}, { trustProxy: true })).toBeNull();
  });
});

// ── 运行期复查：两把钥匙在**运行中**变成同一把 ─────────────────────────────
//
// 装配期那次 checkAdminToken 挡不住这个：`loadConfig` 是
// `env.GATEWAY_TOKEN ?? stored.gatewayToken`，部署者**没设**环境变量、改由存储提供时
// （文档里教的 `wrangler kv key put` / 直接编辑 store.json，以及将来 P3c 的面板，
// 都能写这个键），gatewayToken 可以在运行中被改成等于 ADMIN_TOKEN——而中转口令是发给
// **每一个下游用户**的，届时任何下游用户都能开后台，直到重启 / isolate 回收为止。
//
// 这不是「留给 P3c 在写入路径上拒绝」能解决的：手工改存储绕得过写入路径校验。
describe("运行期复查：gatewayToken 在运行中变成 ADMIN_TOKEN 时管理端 fail closed", () => {
  /** 配置**只从存储来**（env 不设 GATEWAY_TOKEN）——这正是这个洞可达的部署形态。 */
  async function appWithStoredConfig(gatewayToken: string) {
    let t = 0;
    const now = () => t;
    const storage = new MemoryStorage();
    await storage.put("config", { gatewayToken });
    const logger = recordingLogger();
    const configHolder = await createConfigHolder({ env: {}, storage, logger, now });
    const repo = new KeyPoolRepo(storage, { now, logger: NULL_LOGGER, cacheTtlMs: 0 });
    await repo.add("k1");
    const app = createApp({
      version: "0.1.0", configHolder, repo,
      fetcher: new FakeFetcher([]), now,
      storageHealth: createStorageHealth(), logger,
      adminToken: TEST_ADMIN_TOKEN, trustProxy: false,
    });
    return {
      app, logger,
      /** 改存储 + 把假时钟拨过 TTL，下一个请求的 configRefresh 就会真的重载。 */
      async setStoredGatewayToken(v: string) {
        await storage.put("config", { gatewayToken: v });
        t += CONFIG_TTL_MS * 2;
      },
    };
  }

  const withKey = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

  it("装配时两把钥匙不同 ⇒ 管理端正常可用（前置条件）", async () => {
    const { app } = await appWithStoredConfig("gateway-token-differs-from-admin");
    expect((await app.request("/admin/api/session", withKey)).status).toBe(200);
  });

  it("运行中把 gatewayToken 改成等于 ADMIN_TOKEN ⇒ 管理端从 200 变成 503", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    expect((await h.app.request("/admin/api/session", withKey)).status, "变更前应当可用").toBe(200);

    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);

    // 拿着**正确的**管理口令也进不去：fail closed 不是「换个凭据就行」。
    expect((await h.app.request("/admin/api/session", withKey)).status).toBe(503);
    // 缺凭据同样是 503 而不是 401——复查跑在验证凭据之前。
    expect((await h.app.request("/admin/api/session")).status).toBe(503);
  });

  it("停用管理端的同时，/v1 转发照常——转发能力与管理能力相互独立", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);

    expect((await h.app.request("/admin/api/session", withKey)).status).toBe(503);
    const fwd = await h.app.request("/v1/models", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(fwd.status, "网关不该因为管理口令配错而停摆").toBe(200);
  });

  it("原因只进日志，**响应体一个字都不说**", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);
    const res = await h.app.request("/admin/api/session");
    const body = await res.text();

    // 这个检查跑在验证凭据之前，任何未鉴权的调用方都能拿到这个响应。说出原因，
    // 等于告诉一个手里已经有中转口令的人「管理口令就是你手上那把」。
    for (const leak of ["GATEWAY_TOKEN", "ADMIN_TOKEN", TEST_ADMIN_TOKEN, "相同"]) {
      expect(body, `响应体不该出现 ${leak}`).not.toContain(leak);
    }

    const e = h.logger.entries.find((x) => x.event === "admin.token_conflict");
    expect(e?.level, "运维必须看得见，且要 error 级").toBe("error");
    expect(e?.fields?.reason).toBe("same_as_gateway_token");
    expect(String(e?.msg), "日志里要讲清楚怎么修").toContain("GATEWAY_TOKEN");
    // 日志常被转发到第三方，同样不许带口令本身。
    expect(JSON.stringify(e)).not.toContain(TEST_ADMIN_TOKEN);
  });

  it("把 gatewayToken 改回去，管理端立刻恢复——复查是每请求的，不是一次性锁死", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);
    expect((await h.app.request("/admin/api/session", withKey)).status).toBe(503);

    await h.setStoredGatewayToken("gateway-token-differs-again");
    expect((await h.app.request("/admin/api/session", withKey)).status).toBe(200);
  });

  it("冲突期间不记 admin.login_failed——那是爆破痕迹，配置问题别往里掺", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);
    h.logger.clear();
    await h.app.request("/admin/api/session", { headers: { "x-admin-key": "wrong" } });
    expect(h.logger.has("admin.login_failed")).toBe(false);
    expect(h.logger.has("admin.token_conflict")).toBe(true);
  });
});

// ── 枚举式鉴权矩阵 ────────────────────────────────────────────────────────
//
// 这个项目最怕的失效形态是「加了鉴权，实际没有」，而它的表现是**某一条路由被漏掉**
// ——抽样天然抽不到被漏掉的那条。所以这里跑的是笛卡尔积：
//     实际注册的每一条路由 × 每一种凭据状态，每一格都有明确期望，没有空格。
//
// 期望值**独立于实现**这一条是本块的命门（同义反复是这个项目已发现的第 6 种假阳性）：
//   · 路由清单：从 `app.routes` 动态取（手写清单会和代码漂移，而漂移方向恰恰是
//     「新加的路由忘了加进清单」），另配一份双向快照强制新端点被评审看见。
//   · 安全域：从**路径前缀**这个外部事实推导（URL 命名空间是设计先于实现的约定），
//     **不看代码里挂没挂中间件**——从「挂没挂」推「该不该挂」就是同义反复。
//   · 哪套凭据开哪个域的门：手写的策略表 `opens`，是规格，不是从被测对象读出来的。
describe("枚举式鉴权矩阵（路由 × 凭据状态，笛卡尔积）", () => {
  type Domain = "public" | "gateway" | "admin";

  /**
   * 免鉴权路径。**显式常量**，改动它必须在评审里被看见。
   * Task 6 会往里加 /admin 与静态资源，除此之外不许再长。
   */
  const PUBLIC_PATHS: readonly string[] = ["/health"];

  /**
   * 路径 → 安全域。**总函数**：分不出来就抛，逼新端点在这里表态，
   * 不允许出现「这条不用测」的空格。
   */
  function domainOf(path: string): Domain {
    if (PUBLIC_PATHS.includes(path)) return "public";
    if (path === "/admin" || path.startsWith("/admin/")) return "admin";
    if (path.startsWith("/v1/") || path.startsWith("/v1beta/")) return "gateway";
    throw new Error(
      `路由 ${path} 未登记安全域：请在 domainOf 里明确它属于 public / gateway / admin 哪一个`,
    );
  }

  /**
   * 全量路由快照。**双向比对**：少一条说明路由被误删，多一条说明有人加了新端点
   * 而没有在这里表态它该不该鉴权。
   */
  const EXPECTED = [
    "GET /health",
    "GET /v1/models",
    "POST /v1/chat/completions",
    "POST /v1/messages",
    "GET /v1beta/models",
    "POST /v1beta/models/:rest{.+}",
    "POST /v1/responses",
    "POST /v1/images/generations",
    "POST /v1/videos",
    "GET /v1/videos/:id",
    "GET /admin/api/session",
  ] as const;

  /** 路由模式 → 一条能真的打到那个 handler 的具体路径。 */
  const PROBE: Record<string, string> = {
    "/v1beta/models/:rest{.+}": "/v1beta/models/agnes-2.0-flash:generateContent",
    "/v1/videos/:id": "/v1/videos/abc123",
  };

  const GATEWAY = TEST_CONFIG.gatewayToken;
  const ADMIN = TEST_ADMIN_TOKEN;

  interface CredState {
    name: string;
    headers: Record<string, string>;
    query?: string;
    /**
     * 这套凭据**应当**能开哪些安全域的门。手写的策略声明：
     * 网关信道 = Authorization: Bearer / x-api-key / x-goog-api-key / ?key=（Gemini 协议兼容，
     * 见 tests/contract/auth.test.ts 钉住的既有契约）；管理信道 = **仅** x-admin-key。
     * 两把钥匙严格隔离，任何一把都不该开另一边的门。
     */
    opens: readonly Domain[];
  }

  const STATES: readonly CredState[] = [
    { name: "无凭据", headers: {}, opens: [] },
    { name: "错凭据（网关信道 Bearer）", headers: { authorization: "Bearer wrong-value" }, opens: [] },
    { name: "错凭据（管理信道）", headers: { "x-admin-key": "wrong-value" }, opens: [] },
    { name: "空字符串凭据（网关信道 x-api-key）", headers: { "x-api-key": "" }, opens: [] },
    { name: "空字符串凭据（管理信道）", headers: { "x-admin-key": "" }, opens: [] },
    { name: "网关口令（Bearer）", headers: { authorization: `Bearer ${GATEWAY}` }, opens: ["gateway"] },
    { name: "网关口令（x-api-key）", headers: { "x-api-key": GATEWAY }, opens: ["gateway"] },
    { name: "网关口令（x-goog-api-key）", headers: { "x-goog-api-key": GATEWAY }, opens: ["gateway"] },
    { name: "网关口令（?key= 查询参数）", headers: {}, query: `key=${GATEWAY}`, opens: ["gateway"] },
    { name: "网关口令用在管理信道", headers: { "x-admin-key": GATEWAY }, opens: [] },
    { name: "管理口令（x-admin-key）", headers: { "x-admin-key": ADMIN }, opens: ["admin"] },
    { name: "管理口令用在网关信道（Bearer）", headers: { authorization: `Bearer ${ADMIN}` }, opens: [] },
    { name: "管理口令用在网关信道（x-api-key）", headers: { "x-api-key": ADMIN }, opens: [] },
    { name: "管理口令走 ?key= 查询参数", headers: {}, query: `key=${ADMIN}`, opens: [] },
    {
      name: "两把口令各就各位（网关信道给网关口令 + 管理信道给管理口令）",
      headers: { authorization: `Bearer ${GATEWAY}`, "x-admin-key": ADMIN },
      opens: ["gateway", "admin"],
    },
  ];

  /** 免鉴权域永不 401；其余域看这套凭据有没有被登记为能开它。 */
  function must401(domain: Domain, state: CredState): boolean {
    if (domain === "public") return false;
    return !state.opens.includes(domain);
  }

  /**
   * `app.routes` 里的真实端点。
   *
   * ⚠️ 已实测：`use()` 注册的中间件也会被列成条目，method 是 `"ALL"`
   *（`{"m":"ALL","p":"/admin/api/*"}`）。不过滤掉它们，朴素的 for 循环就会拿那条
   * 中间件条目当路径去请求、轻易得到 401，制造一条**覆盖了但什么都没证明**的断言
   *（实测：`GET /admin/api/*` 确实返回 401）。
   */
  function realRoutes(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
    return app.routes.filter((r) => r.method !== "ALL");
  }

  it("路由集合与快照双向一致", async () => {
    const { app } = await makeApp();
    const actual = realRoutes(app).map((r) => `${r.method} ${r.path}`).sort();
    expect([...new Set(actual)]).toEqual([...EXPECTED].sort());
  });

  it("被过滤掉的 ALL 条目全是通配中间件，没有真端点被这层过滤藏起来", async () => {
    const { app } = await makeApp();
    const filtered = app.routes.filter((r) => r.method === "ALL");
    expect(filtered.length).toBeGreaterThan(0);
    for (const r of filtered) {
      expect(r.path.endsWith("*"), `ALL ${r.path} 不是通配路径：用 app.all() 注册的真端点会被枚举漏掉`)
        .toBe(true);
    }
  });

  it("三个安全域在矩阵里都真的出现了（否则矩阵是残缺的）", async () => {
    const { app } = await makeApp();
    const domains = new Set(realRoutes(app).map((r) => domainOf(r.path)));
    expect([...domains].sort()).toEqual(["admin", "gateway", "public"]);
  });

  it("每一条路由 × 每一种凭据状态，逐格断言", async () => {
    const { app } = await makeApp();
    const routes = realRoutes(app);
    let cells = 0;
    let denied = 0;
    let allowed = 0;

    for (const r of routes) {
      const domain = domainOf(r.path);
      const base = PROBE[r.path] ?? r.path;
      for (const state of STATES) {
        const url = state.query ? `${base}?${state.query}` : base;
        const res = await app.request(url, { method: r.method, headers: state.headers });
        const label = `${r.method} ${base} × ${state.name}`;
        if (must401(domain, state)) {
          expect(res.status, `${label}：必须 401`).toBe(401);
          denied++;
        } else {
          // 鉴权边界唯一的可观测量就是「有没有被判 401」。放行之后 handler 因为
          // 缺请求体返回 400 之类是另一回事，不在本矩阵的断言范围内。
          expect(res.status, `${label}：不该被判 401`).not.toBe(401);
          allowed++;
        }
        cells++;
      }
    }

    // 逐条断言全都「通过」但其实一格没跑，是这个循环最容易出的假阳性。
    expect(cells, "枚举的格子数必须等于 路由数 × 凭据状态数").toBe(routes.length * STATES.length);
    expect(routes.length).toBe(EXPECTED.length);
    expect(denied, "必须真的有该拒的格子").toBeGreaterThan(0);
    expect(allowed, "必须真的有该放行的格子").toBeGreaterThan(0);
  });

  it("免鉴权路径不带任何凭据也是 200（否则白名单本身就是错的）", async () => {
    const { app } = await makeApp();
    for (const p of PUBLIC_PATHS) {
      expect((await app.request(p)).status, p).toBe(200);
    }
  });

  it("矩阵里「不该 401」的格子不是空口白话：两条路由用对口令确实 200", async () => {
    const { app } = await makeApp();
    expect((await app.request("/v1/models", {
      headers: { authorization: `Bearer ${GATEWAY}` },
    })).status).toBe(200);
    expect((await app.request("/admin/api/session", {
      headers: { "x-admin-key": ADMIN },
    })).status).toBe(200);
  });
});
