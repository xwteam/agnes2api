import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/http/wire.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { configFromEnv } from "../../src/core/config.js";
import { loadConfig } from "../../src/core/config.js";
import { exposureFields } from "../../src/core/admin/config-validate.js";
import { configGetHandler } from "../../src/http/admin/handlers/config.js";
import type { Storage } from "../../src/ports/storage.js";
import { CONFIG_TTL_MS } from "../../src/http/config-holder.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

/**
 * 配置的四条端点（设计 §5.3 / §5.4 / §8.6 / §10.4 / §11）。
 *
 * ⚠️⚠️ **本文件从头到尾用「真装配」（`buildApp`），一个替身都没有。这不是风格偏好。**
 *
 * `tests/contract/admin-registrar.test.ts` 建立的那套「28 格全用替身」的模板在这里
 * **恰好会把本任务最要紧的那条不变量做成不可观测**：
 * · 「保存之后同一个进程立刻回读到新值」（F7 / Step 5）**必须走真的
 *   `ConfigHolder`**——`fixedConfigHolder.ensureFresh` 是一个空函数，
 *   `invalidate` 也是，用它的话「有没有调 `invalidate()`」这个被测的选择
 *   **完全不可观测**（第 5 种假阳性）。
 * · 「凭据不出网」要看的是**真的那条装配**把什么放进了响应体。替身边界上的断言
 *   只能证明 handler 对着替身说了什么。
 *
 * Task 6 的 C1 就是这么栽的：`wire.ts` 把真实通道参数换成 `null` ⇒ 1939 条全绿，
 * 而响应体照样回显 `"channel":"moemail"`——**面板写着一件事、实际做了另一件事、
 * 而响应体确认了这个谎。** 判别法从那次收口里来：
 * **凡是观测点落在响应体的某个字段上，先问「这个字段是谁写的」——handler 自己的
 * 局部变量就是自报，只能证明它说了什么。**
 *
 * ⇒ 本文件的观测点分两类，**每一格都注明自己是哪一类**：
 * · **落盘/回读类**：观测点在 `storage.get("config")` 或**另一条端点**
 *   （`GET /admin/api/overview` 走真 holder）上；
 * · **不出网类**：观测点在响应体，但断言的是「**没有**某个东西」——那一类不怕自报，
 *   因为自报只会让它更容易通过泄漏，不会让它更容易通过隐藏。
 */

const withKey = { "x-admin-key": TEST_ADMIN_TOKEN };
const GW = "gateway-token-for-config-endpoint-tests";

/**
 * **真装配。** `env` 由用例给，`storage` 由用例持有 ⇒ 断言可以直接落在存储上。
 * 运行时用 `nodeRuntime()`：这四条端点没有后台任务，不需要 `ctx.waitUntil`。
 */
async function realApp(o: {
  env?: Record<string, string | undefined>;
  storage?: MemoryStorage | CountingStorage;
  stored?: unknown;
} = {}) {
  const storage = o.storage ?? new MemoryStorage();
  if (o.stored !== undefined) await storage.put("config", o.stored);
  const env: Record<string, string | undefined> = {
    ADMIN_TOKEN: TEST_ADMIN_TOKEN,
    ...(o.env ?? { GATEWAY_TOKEN: GW }),
  };
  const { app, configHolder } = await buildApp(env, storage, nodeRuntime());
  return { app, storage, env, configHolder };
}

const getConfig = (app: Awaited<ReturnType<typeof realApp>>["app"]) =>
  app.request("/admin/api/config", { headers: withKey });

function put(app: Awaited<ReturnType<typeof realApp>>["app"], patch: Record<string, unknown>) {
  return app.request("/admin/api/config", {
    method: "PUT",
    headers: { ...withKey, "content-type": "application/json" },
    body: JSON.stringify({ patch }),
  });
}

/** 遍历一个 JSON 值的**全部叶子**，逐个交给调用方。判据抄 Task 3 M8 的形状。 */
function leaves(v: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) { for (const x of v) leaves(x, out); return out; }
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v as Record<string, unknown>)) leaves(x, out);
    return out;
  }
  out.push(v);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Step 2：凭据只写不读（本任务后果最严重的一条）
// ───────────────────────────────────────────────────────────────────────────

describe("凭据只写不读（设计 §8.6）", () => {
  /**
   * **【不出网类】变异 M1 的靶子：把 `gatewayToken` 放进 `stored` 或 `effective`。**
   *
   * ⚠️ **判据是「遍历整个响应体的所有叶子值，没有一个等于原串」，不是「检查
   * `stored` 字段不存在」**——后者挡不住换个字段名放进去。
   *
   * 顺带把三把凭据一起验了：`gatewayToken` 走存储（env 里刻意不设它），
   * 两条通道的 `apiKey` 也走存储。
   */
  it("响应体里没有任何一个叶子值等于凭据原串（三把一起）", async () => {
    const SECRETS = {
      gatewayToken: "stored-gateway-token-000001",
      yyds: "stored-yyds-api-key-000002",
      moemail: "stored-moemail-api-key-000003",
    };
    const { app } = await realApp({
      // **env 里没有 GATEWAY_TOKEN**：口令只从存储来，那样存储里那把才是真的在用的
      // 那把——否则这一格测的是一个没人读的字段。
      env: {},
      stored: {
        gatewayToken: SECRETS.gatewayToken,
        registrar: {
          yyds: { baseUrl: "https://y.example.com", apiKey: SECRETS.yyds },
          moemail: { baseUrl: "https://m.example.com", apiKey: SECRETS.moemail },
        },
      },
    });

    const res = await getConfig(app);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(
        leaves(body).filter((v) => v === secret),
        `${name} 的明文出现在响应体的某个叶子上 —— 管理面板变成了 reveal 端点`,
      ).toEqual([]);
      // 更强的一道：整份响应体的文本里也不许出现它（`hint` 只有 4 位，不会误伤）。
      expect(JSON.stringify(body), `${name} 的明文出现在响应体里`).not.toContain(secret);
    }

    // **反向自检**：这一格不是因为「什么都没读到」才绿的。
    const creds = body.credentials as Record<string, { configured: boolean; hint: string | null }>;
    expect(creds.gatewayToken).toEqual({ configured: true, hint: "0001", lockedBy: null });
    expect(creds["registrar.yyds.apiKey"]!.configured).toBe(true);
    expect(creds["registrar.moemail.apiKey"]!.configured).toBe(true);
  });

  /**
   * **【落盘类】变异 M2 上半：`PUT` 时凭据字段缺席 = 不改。**
   *
   * ⚠️ 观测点是**存储里那份 `config`**，不是响应体——响应体里根本没有明文
   *（那正是上一格钉的），所以「改没改」只有落盘那一行说得清。
   * 缺席与空串**必须分开写**：合成一格的话其中一支的缺失被另一支掩盖（第 5 种假阳性）。
   */
  it("PUT 时凭据字段缺席 = 不改（观测点在落盘的那一行）", async () => {
    const { app, storage } = await realApp({
      env: {}, stored: { gatewayToken: GW, maxStrikes: 3 },
    });
    expect((await put(app, { maxStrikes: 9 })).status).toBe(200);
    const after = await storage.get<Record<string, unknown>>("config");
    expect(after?.gatewayToken, "缺席的凭据被动过了").toBe(GW);
    expect(after?.maxStrikes, "该改的那一格没落盘").toBe(9);
  });

  /**
   * **【落盘类】变异 M2 下半：`PUT` 时凭据字段空串 = 不改（**不是清空**）。**
   *
   * ⚠️ **这是本任务错一个字符就让网关停摆的那一格**：空串走清空分支意味着运维保存
   * 一次设置页就抹掉 `gatewayToken`，而热实例因为 `Refreshable` 保留上一份合法快照
   * **当场看不出任何异常**，直到下一次重启/回收才整个停摆（§5.4 的 fail-closed 反噬）。
   */
  it("PUT 时凭据字段空串 = 不改（观测点在落盘的那一行）", async () => {
    const { app, storage } = await realApp({
      env: {}, stored: { gatewayToken: GW },
    });
    expect((await put(app, { gatewayToken: "" })).status).toBe(200);
    expect(
      (await storage.get<Record<string, unknown>>("config"))?.gatewayToken,
      "空串走了清空分支 —— 保存一次设置页就抹掉网关口令",
    ).toBe(GW);
  });

  it("PUT 时凭据字段给了非空串 = 真的落盘", async () => {
    const { app, storage } = await realApp({ env: {}, stored: { gatewayToken: GW } });
    expect((await put(app, { gatewayToken: "brand-new-gateway-token-9999" })).status).toBe(200);
    expect((await storage.get<Record<string, unknown>>("config"))?.gatewayToken)
      .toBe("brand-new-gateway-token-9999");
  });

  /**
   * **【落盘类】清空只能走 `secrets/clear`，而它的后果是 fail-closed。**
   *
   * 这一格把「为什么空串不能实现成清空」这句话变成可执行的：清掉之后**下一次冷启动**
   * 真的起不来（`loadConfig` 抛「缺少 GATEWAY_TOKEN」）。
   * 热实例不会当场停摆，所以这件事在面板上是看不见的——那正是它必须是一条**显式**
   * 动作、而不是一次普通保存的副作用的全部理由。
   */
  it("清空只能走 secrets/clear，且 clear 之后 gatewayToken 缺失会 fail-closed", async () => {
    const { app, storage, env } = await realApp({ env: {}, stored: { gatewayToken: GW } });

    const res = await app.request("/admin/api/config/secrets/clear", {
      method: "POST",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ path: "gatewayToken" }),
    });
    expect(res.status).toBe(200);
    // ⚠️ **`loadBlocked` 里那个码也要断**（复评：这条路径原来只断了 `cleared`/
    // `stillConfigured`，于是 `gateway_token_required` 在契约层零覆盖，
    // 而 `config-validate.test.ts` 的例外清单正声称「这里有契约用例钉着」）。
    expect(await res.json()).toMatchObject({
      cleared: "gatewayToken",
      stillConfigured: false,
      gatewayTokenMissing: true,
      loadBlocked: [{ field: "gatewayToken", code: "gateway_token_required" }],
    });

    // ① 真的从存储里没了。
    expect((await storage.get<Record<string, unknown>>("config"))?.gatewayToken).toBeUndefined();
    // ② 下一次**冷启动**读不到它 ⇒ Node 侧 process.exit(1)、Worker 侧冷 isolate 全部 500。
    await expect(loadConfig(env, storage, NULL_LOGGER)).rejects.toThrow("缺少 GATEWAY_TOKEN");
  });

  it("secrets/clear 只认三条凭据路径，别的一律 400", async () => {
    const { app } = await realApp();
    for (const path of ["maxStrikes", "registrar.primary", "nope", ""]) {
      const res = await app.request("/admin/api/config/secrets/clear", {
        method: "POST",
        headers: { ...withKey, "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      expect(res.status, `path=${JSON.stringify(path)}`).toBe(400);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Step 1b：FIELD_EXPOSURE 的双向运行期断言（防「标了但接线没照着走」）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **夹具从 `FIELD_EXPOSURE` 派生（表是规格），断言看的是响应（被测对象的输出）。
 * 这不构成第 6 种假阳性**（期望值从被测对象自己推导）——被测的是「接线有没有照着
 * 表走」，而表本身是规格，不是实现。
 *
 * **变红条件**：① 把某个 `"secret"` 的分支接成四元组；② 把某个 `"public"` 字段静默漏掉。
 */
describe("FIELD_EXPOSURE 双向哨兵：标 secret 的不许出现，标 public 的必须出现", () => {
  /**
   * 给每个叶子种一个可区分的哨兵值。
   *
   * **类型跟着真实配置的那一格走**（数值格给数值、其余给字符串）：注册机那几个
   * 数值字段走的是 `posInt()`，塞字符串会**抛错**而不是降级——那样这个夹具连装载
   * 都过不去，一格都验不到。
   */
  function sentinels(): { stored: Record<string, unknown>; expect: Map<string, unknown> } {
    const ref = configFromEnv({
      GATEWAY_TOKEN: "x", REGISTRAR_ENABLED: "true",
      REGISTRAR_PRIMARY: "yyds", REGISTRAR_FALLBACK: "moemail",
      YYDS_API_KEY: "k", MOEMAIL_BASE_URL: "https://m.example.com", MOEMAIL_API_KEY: "k",
    }) as unknown as Record<string, unknown>;
    const typeAt = (path: string[]): string => {
      let cur: unknown = ref;
      for (const seg of path) {
        if (typeof cur !== "object" || cur === null) return "undefined";
        cur = (cur as Record<string, unknown>)[seg];
      }
      return typeof cur;
    };

    const stored: Record<string, unknown> = {};
    const wanted = new Map<string, unknown>();
    let n = 900_001;
    for (const { field } of exposureFields().sort((a, b) => a.field.localeCompare(b.field))) {
      const path = field.split(".");
      const value: unknown = typeAt(path) === "number"
        // **`mintDelayMinMs` 必须拿最小的那个哨兵**：字典序下 `…MaxMs` 排在
        // `…MinMs` 前面，顺号发下去会得到 `min > max`，而那会让
        // `registrarFromEnv` 直接抛（交叉校验）——夹具本身装不起来。
        ? (field === "registrar.mintDelayMinMs" ? 900_000 : n++)
        : `SENTINEL-${field}`;
      wanted.set(field, value);
      let cur = stored;
      for (let i = 0; i < path.length - 1; i++) {
        cur[path[i]!] = (cur[path[i]!] as Record<string, unknown>) ?? {};
        cur = cur[path[i]!] as Record<string, unknown>;
      }
      cur[path[path.length - 1]!] = value;
    }
    return { stored, expect: wanted };
  }

  it("27 个叶子逐个种哨兵：3 个 secret 一个都不许出现，24 个 public 一个都不许少", async () => {
    const { stored, expect: wanted } = sentinels();
    // 口令走存储（env 里没有 GATEWAY_TOKEN），于是 `gatewayToken` 那个哨兵是真的在用的那把。
    const { app } = await realApp({ env: {}, stored });
    const body = await (await getConfig(app)).json() as Record<string, unknown>;
    const text = JSON.stringify(body);

    const exposure = new Map(exposureFields().map((f) => [f.field, f.exposure]));
    const leaked: string[] = [];
    const missing: string[] = [];
    let secrets = 0;
    let publics = 0;
    for (const [field, value] of wanted) {
      if (exposure.get(field) === "secret") {
        secrets++;
        if (text.includes(String(value))) leaked.push(field);
      } else {
        publics++;
        if (!leaves(body).some((v) => v === value)) missing.push(field);
      }
    }

    expect(leaked, "标了 secret 的字段被接成了四元组 —— 明文出网").toEqual([]);
    expect(missing, "标了 public 的字段被静默漏掉了 —— 面板上那一格永远是空的").toEqual([]);
    // **反向自检，手写字面量**：两个计数都不许是 0，否则上面两条恒绿。
    expect(secrets, "凭据格数变了").toBe(3);
    expect(publics, "公开字段格数变了").toBe(24);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Step 4：写入前校验（400 那一次一个字节都不写）
// ───────────────────────────────────────────────────────────────────────────

describe("写入前校验（设计 §5.4 第 1 条）", () => {
  /**
   * **【落盘类】变异 M5 的靶子：先写后校验。**
   *
   * ⚠️ **只断言状态码是 400 抓不住「先写了再返回 400」**（与 F9 同一个形状）：
   * 那种实现下一份非法配置已经落盘了，而运维照着 400 以为「没保存上」，
   * 下一次冷启动网关起不来。⇒ 判据换成 `puts` 计数。
   */
  it("校验失败的那次请求 puts 计数一动不动 —— 只断言 400 抓不住『先写了再返回 400』", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({ storage: st, stored: { maxStrikes: 3 } });
    const before = st.puts;

    const res = await put(app, { maxStrikes: 0 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errors: [{ field: "maxStrikes", code: "below_min" }] });
    expect(st.puts, "校验失败了，但存储被写过").toBe(before);

    // **反向自检**：合法的那次真的会写——否则上面那个「不变」什么都没证明。
    expect((await put(app, { maxStrikes: 9 })).status).toBe(200);
    expect(st.puts).toBe(before + 1);
  });

  it("干跑端点一次写都不产生（观测点是 put 计数，不是状态码）", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({ storage: st });
    const before = st.puts;

    const dry = async (patch: Record<string, unknown>) => app.request("/admin/api/config/validate", {
      method: "POST",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ patch }),
    });

    expect((await dry({ maxStrikes: 9 })).status).toBe(200);
    const bad = await dry({ maxStrikes: 0 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ errors: [{ field: "maxStrikes", code: "below_min" }] });
    expect(st.puts, "干跑写了存储").toBe(before);
  });

  /**
   * ⚠️⚠️ **不变量：干跑与真跑对同一份输入必须给出同一组错误码。**
   *
   * 这一格是全分支评审 I1 之后才补的。**旧那一格的用例名声称「与 PUT 用的是同一套
   * 规则」，而它只跑了 `maxStrikes`** —— 一个与 `adminToken` 毫无关系的字段，
   * 于是全仓唯一会分叉的那条规则（`same_as_admin_token`）在契约层两端各自都没有一格。
   * 实测的分叉：干跑 `configValidateHandler` 少传 `adminToken` ⇒
   * `POST /config/validate` 回 **200 `{ok:true}`**，同一份 patch 的 `PUT` 回 **400
   * `same_as_admin_token`**。方向是「干跑放行、真跑拒绝」——运维读到的是「面板刚说没问题」。
   *
   * **判据是错误码集合，不是状态码**：只比状态码的话，两边各自 400 但错在不同字段
   * 上照样绿。**两个方向都跑**：
   * · `gatewayToken = ADMIN_TOKEN` —— 只有真跑拿得到 `adminToken` 时两边才一致，
   *   这一条就是被测的那个选择（**变红条件**：删掉 `configValidateHandler` 里的
   *   `adminToken: wiring.adminToken`）；
   * · `maxStrikes: 0` —— 与 `adminToken` 无关的对照组，证明这套比对本身会说话。
   *
   * **`env` 里刻意不给 `GATEWAY_TOKEN`**：给了的话 `gatewayToken` 被判 `locked_by_env`,
   * 两边都在那一条上提前返回 ⇒ `same_as_admin_token` 又变成不可观测（第 5 种假阳性）。
   */
  it("干跑与真跑对同一份输入给出同一组错误码 —— same_as_admin_token 与 maxStrikes 两个方向都验", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({ storage: st, env: {}, stored: { gatewayToken: GW, maxStrikes: 3 } });
    const before = st.puts;

    const dry = async (patch: Record<string, unknown>) => app.request("/admin/api/config/validate", {
      method: "POST",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ patch }),
    });
    /** `field:code` 的有序集合；200 是空集合。 */
    const codesOf = async (res: Response): Promise<string[]> => {
      if (res.status === 200) return [];
      const body = await res.json() as { errors?: Array<{ field: string; code: string }> };
      return (body.errors ?? []).map((e) => `${e.field}:${e.code}`).sort();
    };

    const cases: Array<{ patch: Record<string, unknown>; expected: string[] }> = [
      // ⚠️ `TEST_ADMIN_TOKEN` 是 27 个字符 ≥ MIN_GATEWAY_TOKEN_LENGTH(24)，
      // 所以它走得到 `same_as_admin_token` 那一条，不会被 `too_short` 提前截住。
      { patch: { gatewayToken: TEST_ADMIN_TOKEN }, expected: ["gatewayToken:same_as_admin_token"] },
      { patch: { maxStrikes: 0 }, expected: ["maxStrikes:below_min"] },
    ];
    for (const { patch, expected } of cases) {
      const d = await dry(patch);
      const p = await put(app, patch);
      const [dc, pc] = [await codesOf(d), await codesOf(p)];
      expect(pc, `真跑对 ${JSON.stringify(patch)} 判成了别的`).toEqual(expected);
      expect(dc, `干跑与真跑对 ${JSON.stringify(patch)} 判决不同：干跑 ${JSON.stringify(dc)}`).toEqual(pc);
      expect(d.status, `${JSON.stringify(patch)}：状态码也得一样`).toBe(p.status);
    }

    // **反向自检**：两个方向的错误码真的不同，否则上面那两轮循环在测同一件事。
    expect(cases[0]!.expected).not.toEqual(cases[1]!.expected);
    // 全程 400 ⇒ 一次写都不该发生（顺带钉住「干跑真的没写」这条性质在本格也成立）。
    expect(st.puts, "两轮全是 400，却写了存储").toBe(before);
  });

  it("顶层只认 patch 一个键，拼错的字段名一律 400", async () => {
    const { app } = await realApp();
    const res = await app.request("/admin/api/config", {
      method: "PUT",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ patchs: { maxStrikes: 9 } }),
    });
    expect(res.status).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Step 5：接 invalidate()，再谈 propagation（F7）
// ───────────────────────────────────────────────────────────────────────────

describe("F7：保存之后同一个进程立刻回读到新值", () => {
  /**
   * ⚠️⚠️ **【落盘/回读类】这一格是本任务的核心不变量，观测点的选择就是它的全部判别力。**
   *
   * **观测点在 `GET /admin/api/overview` 的 `config.targetKeys` 上，不在 `PUT` 的
   * 响应体里。** 理由：`PUT` 的回读走的是 `loadConfigWithProvenance(env, storage)`
   * ——它**直接读存储**，所以即使 `configHolder.invalidate()` 那一行被删掉，
   * `PUT` 的响应体照样是新值，那一格对被测的选择**完全不可观测**（第 5 种假阳性）。
   * 而 `overview` 读的是 `configHolder.current()`，它要经过 `configRefresh` 中间件
   * 的 `ensureFresh()` ⇒ 只有 `invalidate()` 真的调过，这一格才是新值。
   *
   * **holder 是 `buildApp` 建的真 holder**（`CONFIG_TTL_MS` = 30 秒）——
   * `fixedConfigHolder` 的 `invalidate` 是空函数，用它同样不可观测。
   *
   * **变红条件**：去掉 `configPutHandler` 里的 `deps.configHolder.invalidate()`。
   */
  it("保存之后同一个进程立刻回读到新值 —— 观测点在 overview，走的是真 holder", async () => {
    const { app } = await realApp({ stored: { registrar: { targetKeys: 20 } } });

    const before = await (await app.request("/admin/api/overview", { headers: withKey })).json() as {
      config: { targetKeys: number };
    };
    expect(before.config.targetKeys, "前置条件：改之前得是旧值").toBe(20);

    expect((await put(app, { "registrar.targetKeys": 7 })).status).toBe(200);

    const after = await (await app.request("/admin/api/overview", { headers: withKey })).json() as {
      config: { targetKeys: number };
    };
    expect(
      after.config.targetKeys,
      "同一个进程的下一个请求还在报旧值 —— `configHolder.invalidate()` 没接上，"
      + "运维会看到保存回执上是新值、而概览页上是旧值，最长持续一个 CONFIG_TTL_MS",
    ).toBe(7);
  });

  /**
   * **回读是从存储读的，不是把 handler 手上那份 `next` 换个形状交回去。**
   *
   * ⚠️⚠️ **这一格的第一版被变异 M12 完整逃逸（17/17 全绿），成因值得记下来。**
   * 那一版的做法是「PUT 之前先绕过端点改一次存储，再断言回执里有那个新值」——
   * 而 handler 在这次 `PUT` 里**本来就会读一遍存储**（校验要拿它做合并），
   * 于是 `verdict.next` 里同样带着那个值 ⇒ **投影实现与回读实现给出一模一样的
   * 响应体，被测的选择完全不可观测**（第 5 种假阳性）。
   *
   * 判别力必须来自「**落盘之后**存储里的东西与 handler 手上那份 `next` 不同」。
   * 夹具因此用一个**写进去与读出来不一致**的存储：它模拟的是一次真实的多副本
   * 竞争（我们 `put` 之后、回读之前，另一个副本又写了一次），也模拟了任何
   * 「中间层改写了这次写入」的形态。**回读实现看得到那个差，投影实现看不到。**
   */
  it("PUT 的回执来自存储，不是 handler 自己算出来的那份 next", async () => {
    const inner = new MemoryStorage();
    await inner.put("config", { maxStrikes: 3, cooldownStrikeMs: 1_800_000 });
    /** 落盘之后又被别人改了一手的存储。**只对 `config` 这个键动手。** */
    const racing = {
      async get<T>(k: string): Promise<T | null> { return inner.get<T>(k); },
      async put<T>(k: string, v: T, expiresAt?: number): Promise<void> {
        if (k !== "config") return inner.put(k, v, expiresAt);
        // 另一个副本紧接着写了一次：它把 `cooldownStrikeMs` 改成了别的值。
        return inner.put(k, { ...(v as object), cooldownStrikeMs: 4_242_000 }, expiresAt);
      },
      async delete(k: string): Promise<void> { return inner.delete(k); },
      async list(p: string): Promise<string[]> { return inner.list(p); },
    };

    const { app } = await realApp({ storage: racing as unknown as MemoryStorage });
    const res = await put(app, { upstreamTimeoutMs: 5_000 });
    expect(res.status).toBe(200);
    const putBody = await res.json() as { fields: Record<string, { effective: unknown }> };
    expect(
      putBody.fields.cooldownStrikeMs!.effective,
      "回执给的是 handler 手上那份 next 的投影，不是存储里现在真正的样子",
    ).toBe(4_242_000);

    // 再补一道：回执与紧随其后的一次 `GET` 逐字节一致（两者都从存储读）。
    const getBody = await (await getConfig(app)).json() as { fields: Record<string, unknown> };
    expect(putBody.fields, "回执与随后一次 GET 不一致 —— 两者读的不是同一个数据源")
      .toEqual(getBody.fields);
  });

  /**
   * **`propagation` 必须给，而且不许写「立即生效」**（设计 §5.2）。
   * 本进程确实立刻生效（上面那次 `invalidate()`），别的 isolate 要等
   * `CONFIG_TTL_MS` + KV 边缘缓存。**两个数手写字面量**——它们是五语言 DEPLOY.md
   * 对用户的承诺，从被测常量推导出来的期望值恒等于实际值。
   */
  it("回执里带传播上界（30 秒 + 60 秒 = 90 秒，手写字面量）", async () => {
    const { app } = await realApp();
    const body = await (await put(app, { maxStrikes: 9 })).json() as {
      propagation: { configTtlMs: number; kvEdgeCacheMs: number; visibilityUpperBoundMs: number };
    };
    expect(body.propagation).toEqual({
      configTtlMs: 30_000, kvEdgeCacheMs: 60_000, visibilityUpperBoundMs: 90_000,
    });
    // 常量本身也钉成同一个字面量：「两边一起改」因此也拦得住（形态抄 roundBudgetMs 那条双锚）。
    expect(CONFIG_TTL_MS).toBe(30_000);
  });

  /**
   * **`changed` 报的是「生效值真的变了的那些」，不是「patch 里写了哪些」。**
   *
   * 面板拿它做高亮（设计 §5.3：不弹「已保存并生效」，而是回读 `effective` 并把
   * 变化的字段高亮）。按 patch 比的话，一次「写了个和原值一样的数」也会被高亮，
   * 而那正是运维用来确认「我到底改了什么」的那一格。
   */
  it("changed 只列生效值真的变了的字段 —— 写一个和原值一样的数不算改", async () => {
    const { app } = await realApp({ stored: { maxStrikes: 3 } });
    const same = await (await put(app, { maxStrikes: 3 })).json() as { changed: string[] };
    expect(same.changed).toEqual([]);
    const diff = await (await put(app, { maxStrikes: 9 })).json() as { changed: string[] };
    expect(diff.changed).toEqual(["maxStrikes"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 锁定字段、没接线、以及事件
// ───────────────────────────────────────────────────────────────────────────

describe("被环境变量锁定的字段", () => {
  it("GET 报出 lockedBy，PUT 一律拒（且不写存储）", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({
      storage: st, env: { GATEWAY_TOKEN: GW, TARGET_KEYS: "30" }, stored: { registrar: { targetKeys: 20 } },
    });
    const body = await (await getConfig(app)).json() as {
      fields: Record<string, { stored: unknown; env: string | null; effective: unknown; lockedBy: string | null }>;
    };
    // 四元组把「面板里保存的是 20、生效的是 30」这件事逐格说清楚。
    expect(body.fields["registrar.targetKeys"]).toEqual({
      stored: 20, env: "30", effective: 30, lockedBy: "env:TARGET_KEYS",
    });

    const before = st.puts;
    const res = await put(app, { "registrar.targetKeys": 25 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      errors: [{ field: "registrar.targetKeys", code: "locked_by_env", params: { env: "TARGET_KEYS" } }],
    });
    expect(st.puts, "被拒的那次写了存储").toBe(before);
  });
});

describe("没接线的 app：四条端点如实回 503，不假装", () => {
  /**
   * `createApp` 直接装配（不经 `wire.ts`）时拿不到 `env`，四条端点因此没有接线。
   * **回 200 + 一份空配置的话，「这个 app 读不到配置」与「配置全是默认值」
   * 在面板上会长得一模一样**，而后者是一句假话。
   */
  it("GET / PUT / validate / secrets/clear 全部 503 not_wired", async () => {
    const { makeApp } = await import("../helpers/make-app.js");
    const { app } = await makeApp();
    const cases: ReadonlyArray<[string, string, unknown]> = [
      ["GET", "/admin/api/config", undefined],
      ["PUT", "/admin/api/config", { patch: {} }],
      ["POST", "/admin/api/config/validate", { patch: {} }],
      ["POST", "/admin/api/config/secrets/clear", { path: "gatewayToken" }],
    ];
    for (const [method, path, body] of cases) {
      const res = await app.request(path, {
        method,
        headers: body === undefined ? withKey : { ...withKey, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(await res.json()).toMatchObject({ reason: "not_wired" });
    }
  });
});

describe("事件：配置被改过要留痕，但一个值都不许进日志", () => {
  /**
   * ⚠️ **这一组换用 `makeApp` + 注入的 `recordingLogger`，理由要说清楚。**
   *
   * `buildApp` 那条真装配上的事件走 `StoreLogger`，而它的 `maybeFlush()` 有一道
   * `EVENT_FLUSH_MIN_INTERVAL_MS` 的间隔闸（`src/adapters/logger-store.ts`）——
   * 用例是毫秒级跑完的，那道闸下**一条都不会落盘**。在那条路上断言「存储里有这条
   * 事件」会变成断言那道闸的行为，而不是断言 handler 打没打这条事件。
   *
   * 换到注入的 sink 上没有削弱判别力：本组两条断言一条是「打了」、一条是
   * **「没带凭据的值」**——后者属于「不出网类」，自报只会让它更容易泄漏、
   * 不会让它更容易隐藏。`registrar.*` 事件真的能进事件板块这条链，由 Task 1 建、
   * `tests/contract/registrar-events.test.ts` 里那一整份用例负责，不是本任务要重证的东西。
   */
  it("config.updated 只记路径，凭据的值一个字都不记", async () => {
    const { makeApp } = await import("../helpers/make-app.js");
    const storage = new MemoryStorage();
    await storage.put("config", { gatewayToken: GW });
    const { app, logger } = await makeApp([], [], {}, () => 1000, {
      storage, config: { storage, env: {} },
    });

    const res = await app.request("/admin/api/config", {
      method: "PUT",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ patch: { maxStrikes: 9, gatewayToken: "another-brand-new-token-4242" } }),
    });
    expect(res.status).toBe(200);

    const e = logger.entries.find((x) => x.event === "config.updated");
    expect(e, "配置被改过却没有留痕 —— 事件板块是运维唯一能看到「网关为什么变了」的地方").toBeDefined();
    expect(String(e?.fields?.fields)).toContain("gatewayToken");
    expect(JSON.stringify(e), "凭据的值进了日志（日志常被转发到第三方）")
      .not.toContain("another-brand-new-token-4242");
    // 反向自检：那把凭据真的落盘了 —— 否则「日志里没有它」是因为压根没改成。
    expect((await storage.get<Record<string, unknown>>("config"))?.gatewayToken)
      .toBe("another-brand-new-token-4242");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 评审 C1 / C2：清空一条「在链上」的通道凭据
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ **这一组是评审 C1/C2 的护栏。改动之前，这两条路径一格用例都没有**
 *（现有用例只测了有护栏的那支 `gatewayToken`，与非法 `path`）。
 *
 * 缺陷原样（我自己复现过，逐字）：
 * ```
 * HTTP 状态: 500   面板看到的: {"error":{"type":"internal_error","message":"网关内部错误"}}
 * 存储里 yyds.apiKey 现在是: undefined      => 面板说失败，实际删掉了吗? 删掉了
 * PUT 关掉注册机 -> 500 / PUT 重新填这把 key -> 500 / PUT 换主通道 -> 500
 * 干跑 validate -> 200      ← 干跑说「你这个补丁合法」，真跑 500
 * ```
 */
describe("C1/C2：清掉一条在链上的通道凭据", () => {
  /** 注册机开着、yyds 是主通道、凭据只在存储里 —— 那把 key 一清就装载不起来。 */
  const ON_CHAIN = {
    gatewayToken: GW,
    registrar: {
      enabled: true, primary: "yyds",
      yyds: { baseUrl: "https://yyds.invalid", apiKey: "on-chain-key-7777" },
    },
  };

  const clear = (app: Awaited<ReturnType<typeof realApp>>["app"], path: string) =>
    app.request("/admin/api/config/secrets/clear", {
      method: "POST",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });

  /**
   * **【落盘类】变红条件**：把 `configClearSecretHandler` 里的 `configLoadBlockers`
   * 换回只判 `gatewayToken` 的那条 `nowMissing`。
   *
   * ⚠️ **两半都要断言**：只断「不是 500」的话，一个把清空整个删掉的实现照样绿；
   * 只断「删掉了」的话，回 500 的旧实现照样绿。**「删掉了」+「如实说」必须同时成立。**
   */
  it("清掉在链上的通道凭据：200 + 如实报 loadBlocked，绝不是「说失败、实际做了」", async () => {
    const { app, storage } = await realApp({ env: {}, stored: ON_CHAIN });
    const res = await clear(app, "registrar.yyds.apiKey");

    expect(res.status, "面板说失败，而那把凭据已经被删掉了 —— 方向比通常那条谎更坏").toBe(200);
    const body = await res.json() as { loadBlocked: Array<{ field: string; code: string }> };
    expect(body.loadBlocked, "清完之后装载不起来，回执里却一个字都没说").toEqual([
      { field: "registrar.yyds.apiKey", code: "channel_credentials_missing", params: { channel: "yyds" } },
    ]);
    // 另一半：它**真的**被删掉了（这条端点的语义就是清空，不是拒绝）。
    const after = await storage.get<Record<string, unknown>>("config");
    expect((after?.registrar as { yyds?: { apiKey?: string } })?.yyds?.apiKey).toBeUndefined();
  });

  /**
   * ⚠️ **审计先落，再回读。**
   * 旧实现把 `config.secret_cleared` 打在 `readAll` **之后** ⇒ 回读抛错的那一支
   *（正是最该留痕的那一支）**一条审计都没有**：存储被改了、面板收到 500、
   * 事件板块里什么都没有。
   */
  it("装载不起来的那一支也必须留下审计，且只记路径与原因码", async () => {
    const storage = new MemoryStorage();
    await storage.put("config", ON_CHAIN);
    const { makeApp } = await import("../helpers/make-app.js");
    const { app, logger } = await makeApp([], [], {}, () => 1000, {
      storage, config: { storage, env: {} },
    });
    await app.request("/admin/api/config/secrets/clear", {
      method: "POST",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ path: "registrar.yyds.apiKey" }),
    });
    const e = logger.entries.find((x) => x.event === "config.secret_cleared");
    expect(e, "清空发生了，事件板块里却什么都没有").toBeDefined();
    expect(e?.level, "装载不起来是 error 级").toBe("error");
    expect(String(e?.fields?.blocked)).toContain("channel_credentials_missing");
    expect(JSON.stringify(e), "凭据的值进了日志").not.toContain("on-chain-key-7777");
  });


  /**
   * ⚠️⚠️ **审计先落、再回读——而这条排序只在「回读真的会抛」时才有可观测差异。**
   *
   * 第一版的审计用例测的是「装载不起来的那一支有没有审计」，而诊断视图落地之后
   * `readAll` 在那一支**不再抛**了 ⇒ 把 `logger.log` 挪到 `readAll` 之后照样绿
   *（变异 M19 实测逃逸 25/25）。**排序保证真正保护的是另一种情况**：
   * 存储在 `put` 成功之后坏掉 ⇒ 回读抛 ⇒ 整条请求 500，
   * **而那次清空已经发生了**——这时那条审计是运维唯一的痕迹。
   *
   * **变红条件**：把 `deps.logger.log({ … event: "config.secret_cleared" … })`
   * 挪到 `const after = await readAll(...)` 之后。
   */
  it("审计先落再回读 —— 回读抛错时那条审计仍然必须在（500 也要留痕）", async () => {
    const inner = new MemoryStorage();
    await inner.put("config", { gatewayToken: GW, registrar: { yyds: { apiKey: "doomed-key-1234" } } });
    let reads = 0;
    const flaky = {
      async get<T>(k: string): Promise<T | null> {
        // 第一次读（`clearSecret` 要拿存储原件）放行；之后一律抛——模拟 put 成功
        // 之后存储才坏掉，那正是「审计已经该落、而回读注定失败」的那个窗口。
        if (k === "config" && ++reads > 1) throw new Error("KV 在 put 之后坏了");
        return inner.get<T>(k);
      },
      put: <T>(k: string, v: T) => inner.put(k, v),
      delete: (k: string) => inner.delete(k),
      list: (pfx: string) => inner.list(pfx),
    } as unknown as MemoryStorage;

    const { makeApp } = await import("../helpers/make-app.js");
    const { app, logger } = await makeApp([], [], {}, () => 1000, {
      storage: flaky, config: { storage: flaky, env: {} },
    });
    const res = await app.request("/admin/api/config/secrets/clear", {
      method: "POST",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ path: "registrar.yyds.apiKey" }),
    });
    // 回读真的抛了 ⇒ 这一条请求确实是 500（**存储坏了就该报 500**，不许假装成功）。
    expect(res.status, "前置条件：这一格要的就是「回读抛错」那个窗口").toBe(500);
    // 而清空**已经落盘了** —— 所以那条审计必须在。
    expect(await inner.get<Record<string, unknown>>("config").then(
      (c) => (c?.registrar as { yyds?: { apiKey?: string } })?.yyds?.apiKey,
    )).toBeUndefined();
    const e = logger.entries.find((x) => x.event === "config.secret_cleared");
    expect(e, "清空落盘了、请求 500 了，而事件板块里一条痕迹都没有").toBeDefined();
    expect(e?.fields?.path).toBe("registrar.yyds.apiKey");
    expect(JSON.stringify(e), "凭据的值进了日志").not.toContain("doomed-key-1234");
  });

  /**
   * ⚠️⚠️ **C2 的核心：清完之后运维必须有出路。**
   *
   * 旧实现下这三条自救路径**全是 500**，而屏幕上五语言正写着「请立刻在这一页
   * 写一把新的」。**变红条件**：把 `readAll` 的降级分支去掉（改回直接抛）。
   */
  it.each([
    ["关掉注册机", { "registrar.enabled": false }],
    ["把那把 key 重新填回去", { "registrar.yyds.apiKey": "refilled-key-8888" }],
    ["换一条主通道", { "registrar.primary": "moemail", "registrar.moemail.baseUrl": "https://m.invalid", "registrar.moemail.apiKey": "mk-9999" }],
  ])("装载不起来之后，「%s」这条自救路径必须走得通", async (_name, patch) => {
    const { app, storage, env } = await realApp({ env: {}, stored: ON_CHAIN });
    await clear(app, "registrar.yyds.apiKey");

    const res = await put(app, patch as Record<string, unknown>);
    expect(res.status, "自救路径被自己的 500 挡住了 —— 面板从此没有出路").toBe(200);
    // 真的修好了：这一刻**冷启动**也装载得起来。
    await expect(loadConfig(env, storage, NULL_LOGGER)).resolves.toBeDefined();
  });

  /**
   * **装载不起来时 `GET` 降级成诊断视图，而不是 500。**
   * `fields`/`credentials` 给 `null`（不编一份空配置），`loadBlocked` 逐条说清缺什么，
   * 而 `editable` 照给 —— **表单必须还能用，那是唯一的出路。**
   */
  it("装载不起来时 GET 给诊断视图：200 + fields=null + loadBlocked 逐条 + editable 照给", async () => {
    const { app } = await realApp({ env: {}, stored: ON_CHAIN });
    await clear(app, "registrar.yyds.apiKey");

    const res = await getConfig(app);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      fields: unknown; credentials: unknown; configDegraded: boolean;
      loadBlocked: Array<{ code: string }>; editable: string[];
    };
    expect(body.fields, "编了一份空配置出来 —— 那与「读不出来」长得一模一样").toBeNull();
    expect(body.credentials).toBeNull();
    expect(body.configDegraded).toBe(true);
    expect(body.loadBlocked.map((b) => b.code)).toEqual(["channel_credentials_missing"]);
    expect(body.editable.length, "连可编辑清单都不给的话，表单没法用").toBe(26);
  });

  /**
   * ⚠️⚠️ **降级不是泛泛地 `catch`。**
   *
   * 我自己在这个文件里写过这条禁令：「泛泛地 catch 会把**真的存储故障**也吞成这一支，
   * 于是一次 KV 抖动会被报成『你把口令删光了』，运维照着去重设一把不存在的问题」。
   * 判据因此是「抓到之后先算一遍 `configLoadBlockers`，**没有 blocker 就原样抛**」。
   *
   * **变红条件**：把那句 `if (blockers.length === 0) throw err;` 去掉。
   */
  it("真的存储故障不许被吞成诊断视图 —— 没有 blocker 就原样抛", async () => {
    /**
     * **持久故障**——每次读 `config` 都抛。那才是「存储真的坏了」的真实形态，
     * 也是唯一该报 500 的那一支。
     *
     * ⚠️ 这个夹具被改过两轮，两轮都是判据在变，记在这里：
     * · 第一版（每次都抛）配的是「blockers 为空就抛」那版实现，**变异 M18 完整逃逸**
     *   ——`catch` 里那次「再读一遍」也抛、直接冒出去，被测分支从头没走到；
     * · 第二版（只抛一次）配的是「存储读得出来就是配置问题」那版实现，
     *   而那版把**瞬时抖动**误判成配置问题（评审 F2 之后的自查）。
     * 现在的判据是三分：**读不出来才抛**，所以这里回到持久故障。
     * 「瞬时抖动要能自愈」由紧跟着的那一格单独钉住，两格合起来才盖住三个分支。
     */
    const broken: Storage = {
      async get<T>(k: string): Promise<T | null> {
        if (k === "config") throw new Error("KV 抖了一下");
        return null;
      },
      async put() {}, async delete() {}, async list() { return []; },
    };
    const handler = configGetHandler({
      // 配置本身没有任何 blocker（env 提供了口令）⇒ 这个异常与配置无关。
      wiring: { storage: broken, env: { GATEWAY_TOKEN: GW } },
      configHolder: { current: () => ({}) as never, ensureFresh: async () => {}, invalidate: () => {} },
      logger: NULL_LOGGER,
      now: () => 0,
    });
    await expect(handler({ json: (x: unknown) => x } as never))
      .rejects.toThrow("KV 抖了一下");
  });


  /**
   * **瞬时抖动：第一次读抛、第二次好了 ⇒ 照常返回，不许给一个假的诊断视图。**
   *
   * ⚠️ 这一格是我自己在 F2 收口时补的：那一版判据写成「存储读得出来 ⇒ 就是配置问题」，
   * 于是一次 KV 抖动会让一份**完全正常**的配置被报成「装载不起来」——
   * 与它要修的那条是同一种谎，只是方向相反。
   * **变红条件**：把 `readAll` 里那次「拿已读到的原件就地再构造一遍」去掉。
   */
  it("存储瞬时抖动（第一次读抛、第二次好了）⇒ 照常返回，不给假的诊断视图", async () => {
    const inner = new MemoryStorage();
    await inner.put("config", { gatewayToken: GW, maxStrikes: 9 });
    let first = true;
    const flaky: Storage = {
      async get<T>(k: string): Promise<T | null> {
        if (k === "config" && first) { first = false; throw new Error("KV 抖了一下"); }
        return inner.get<T>(k);
      },
      put: (k, v, e) => inner.put(k, v, e),
      delete: (k) => inner.delete(k),
      list: (p) => inner.list(p),
    };
    const handler = configGetHandler({
      wiring: { storage: flaky, env: {} },
      configHolder: { current: () => ({}) as never, ensureFresh: async () => {}, invalidate: () => {} },
      logger: NULL_LOGGER,
      now: () => 0,
    });
    const body = await handler({ json: (x: unknown) => x } as never) as unknown as {
      fields: Record<string, { effective: unknown }> | null; loadBlocked: unknown[];
    };
    expect(body.loadBlocked, "一次瞬时抖动被报成了「配置装载不起来」").toEqual([]);
    expect(body.fields, "抖动之后没有自愈，给了一个假的诊断视图").not.toBeNull();
    expect(body.fields!.maxStrikes!.effective).toBe(9);
  });

  /**
   * **`gateway_token_required` 在 `GET` 的诊断视图里也要出得来。**
   *
   * ⚠️ 这一格是复评点名补的：那个码此前**只有对 `configLoadBlockers` 的单元直测**，
   * 契约层一格都没有——而 `config-validate.test.ts` 的例外清单把「校验产不出它」
   * 的正当性全部押在「别处还有人守」上。**那句话当时是假的，这一格与上面
   * `secrets/clear` 那格一起把它变成真的。**
   */
  it("两边都没有网关口令时，GET 的诊断视图里报 gateway_token_required", async () => {
    // 先用一份好配置把 app 建起来（坏配置下 `buildApp` 在 `prime()` 就抛），
    // 再绕过面板把口令从存储里拿掉 —— 这正是 `secrets/clear` 之后的那个状态。
    const { app, storage } = await realApp({ env: {}, stored: { gatewayToken: GW } });
    await storage.put("config", {});

    const res = await getConfig(app);
    expect(res.status, "这一支给了 500，运维连「缺什么」都看不到").toBe(200);
    const body = await res.json() as { fields: unknown; loadBlocked: Array<{ field: string; code: string }> };
    expect(body.fields).toBeNull();
    expect(body.loadBlocked).toEqual([{ field: "gatewayToken", code: "gateway_token_required" }]);
    // 而且修得回来：写一把新的口令进去，冷启动就装载得起来。
    expect((await put(app, { gatewayToken: "a-brand-new-gateway-token-2099" })).status).toBe(200);
    await expect(loadConfig({}, storage, NULL_LOGGER)).resolves.toBeDefined();
  });

  /**
   * ⚠️⚠️ **F2：`configLoadBlockers` 不完备，所以它不能当「装得起来吗」的判据。**
   *
   * 复现：存储里 `registrar.targetKeys: "abc"` ⇒ 那个函数返回 `[]`，而 `posInt()`
   * 对存储里的非数字**是抛错不是降级**（`config-validate.ts` 开篇正把这件事列为
   * 本模块存在的理由之一）⇒ 第一版的 `blockers.length === 0 ⇒ 原样抛` 把这一整类
   * 判成了「存储故障」⇒ **`GET` / `PUT` 双双 500、没有诊断视图、没有出路**，
   * C2 那个形状对它原样幸存。
   *
   * 判据换成「**存储读得出来吗**」（完备）：读得出来而构造失败 ⇒ 配置问题。
   * **变红条件**：把 `readAll` 的判据换回 `blockers.length === 0 ⇒ throw`。
   */
  it("逐字段判据说不出是哪一格时，照样给诊断视图（不是 500）", async () => {
    const { app, storage } = await realApp({ env: {}, stored: { gatewayToken: GW } });
    // 绕过面板，手工把存储写成 `posInt()` 会抛的形状。
    await storage.put("config", { gatewayToken: GW, registrar: { targetKeys: "abc" } });

    const res = await getConfig(app);
    expect(res.status, "这一类缺陷连诊断视图都拿不到 —— C2 的形状原样幸存").toBe(200);
    const body = await res.json() as { fields: unknown; loadBlocked: Array<{ field: string; code: string }> };
    expect(body.fields).toBeNull();
    // **不编一个具体字段出来**：说不出是哪一格就如实说不出。
    expect(body.loadBlocked).toEqual([{ field: "", code: "config_unloadable" }]);

    // 而且修得回来。
    expect((await put(app, { "registrar.targetKeys": 20 })).status).toBe(200);
    await expect(loadConfig({}, storage, NULL_LOGGER)).resolves.toBeDefined();
  });

  /**
   * **F6：只拒这次补丁新引入的 blocker。**
   *
   * 配置**本来就**坏掉时，运维想改一个无关字段必须放行——他手上正拿着一份装不起来
   * 的配置，最需要的恰恰是一步一步修回来。**变红条件**：把那个差换回
   * 「补丁之后还有没有 blocker」。
   */
  it("配置本来就坏时，改一个无关字段要放行；而新引入 blocker 照旧拒", async () => {
    const BROKEN = {
      gatewayToken: GW,
      registrar: { enabled: true, primary: "yyds", yyds: { baseUrl: "https://y.invalid" } },
    };
    // **先用好配置把 app 建起来，再手工写坏**：坏配置下 `buildApp` 在 `prime()` 就抛，
    // 整个 app 装不出来（那是冷启动那一半，见报告 §6.9，不是这一格要测的东西）。
    const { app, storage } = await realApp({ env: {}, stored: { gatewayToken: GW } });
    await storage.put("config", BROKEN);
    // ① 无关字段：放行（只修一半）。
    expect((await put(app, { maxStrikes: 7 })).status, "本来就坏的配置连无关字段都改不了").toBe(200);
    // ② 新引入一条：照旧拒。
    const bad = await put(app, { "registrar.fallback": "yyds" });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { errors: Array<{ code: string }> }).errors.map((e) => e.code))
      .toEqual(["fallback_equals_primary"]);
  });

  /**
   * **干跑与真跑必须给同一个答案。** 旧实现下干跑回 200（「你这个补丁合法」）
   * 而真跑 500，那比没有干跑更坏。
   */
  it("干跑与真跑同一个答案 —— 不许出现「干跑说合法、真跑 500」", async () => {
    const { app } = await realApp({ env: {}, stored: ON_CHAIN });
    await clear(app, "registrar.yyds.apiKey");
    const patch = { "registrar.yyds.apiKey": "refilled-key-8888" };
    const dry = await app.request("/admin/api/config/validate", {
      method: "POST",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ patch }),
    });
    expect(dry.status).toBe(200);
    expect((await put(app, patch)).status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 全分支评审 I5：「鉴权失败 ⇒ 零副作用」这道护栏的第三处落点
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ **这一格补的是护栏缺口，不是在修一个活缺陷。**
 *
 * **今天它不可达，这一点必须先说清楚**：`tests/contract/admin-auth.test.ts` 的笛卡尔积
 * 矩阵对每条 admin 路由 × 16 种凭据状态断言 401，`EXPECTED_MIDDLEWARE` 又钉住了中间件
 * 表，两者合起来让「handler 跑了但仍返回 401」在今天的路由形状下构造不出来
 * ——全分支评审自己也如实写了这一条（I5，置信度 MEDIUM）。
 *
 * **那它为什么还要补**：这道护栏本期建过两次（Task 3 的 Key 写四条 ——
 * `tests/contract/admin-auth.test.ts` 的「鉴权失败的非幂等请求必须零副作用」；
 * Task 5 的 `POST /registrar/tend` ——
 * `tests/contract/manual-tend.test.ts` 的「鉴权失败的『立即补池』必须零副作用」），
 * **Task 7 的这两条没有** —— 而这两条恰恰是全仓
 * 危害最大的写：`PUT /admin/api/config` 能改掉 `gatewayToken`，
 * `secrets/clear` 能删掉凭据（`router.ts` 那句「一个鉴权失效的 `PUT /admin/api/config`
 * 等于把整台网关交出去」说的就是它）。它防的是 Hono 上那个真实形态：
 * `app.route("/", sub)` 写在 `app.use(path, mw)` 之前时中间件**静默失效**
 *（`src/http/admin/router.ts` 那段 ★ 已实测）⇒ handler 先跑完、鉴权再"生效"，
 * 状态码仍是 401 而副作用已经发生。**只断言 401 对这个形态完全无感。**
 */
describe("I5：鉴权失败的两条 config 写端点必须零副作用", () => {
  /**
   * ⚠️ **夹具刻意用「鉴权若不存在就一定会成功」的请求**，这是本格判别力的全部来源：
   * · `PUT` 带的是一份**合法**的 patch（非法的会被 400 拦住，那样即使鉴权失效也是 0 次写）；
   * · `secrets/clear` 打的是一把**存储里真的有值**的凭据。
   * 反向自检在最后：同样两条请求**带上口令真的会写**，否则上面那两个「计数不动」是空的。
   */
  it("无口令的 PUT /config 与 secrets/clear：401 且 put 计数一动不动", async () => {
    const st = new CountingStorage();
    const { app } = await realApp({
      storage: st, env: {},
      stored: { gatewayToken: GW, maxStrikes: 3 },
    });

    const snapshot = () => ({ puts: st.puts, deletes: st.deletes });
    const CASES: ReadonlyArray<{ name: string; path: string; body: unknown }> = [
      { name: "PUT /config 改 gatewayToken", path: "/admin/api/config", body: { patch: { gatewayToken: "attacker-planted-gateway-token" } } },
      { name: "PUT /config 改 maxStrikes", path: "/admin/api/config", body: { patch: { maxStrikes: 9 } } },
      { name: "secrets/clear 清掉 gatewayToken", path: "/admin/api/config/secrets/clear", body: { path: "gatewayToken" } },
    ];

    // 三种凭据状态各跑一遍：没有头、错的口令、拿网关口令冒充管理口令。
    const BAD_HEADERS: ReadonlyArray<Record<string, string>> = [
      {}, { "x-admin-key": "wrong-admin-key" }, { authorization: `Bearer ${GW}` },
    ];
    for (const c of CASES) {
      for (const h of BAD_HEADERS) {
        const before = snapshot();
        const res = await app.request(c.path, {
          method: c.path.endsWith("/clear") ? "POST" : "PUT",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify(c.body),
        });
        expect(res.status, `${c.name} / 凭据 ${JSON.stringify(h)}：必须 401`).toBe(401);
        expect(snapshot(), `${c.name} / 凭据 ${JSON.stringify(h)}：鉴权失败了，但存储被动过`).toEqual(before);
      }
    }

    // ── 反向自检：同样这两条请求带上口令**真的会写** ────────────────────────
    const beforeOk = st.puts;
    expect((await put(app, { maxStrikes: 9 })).status, "夹具本身就存不上 ⇒ 上面那些「零副作用」是空的").toBe(200);
    expect(st.puts, "带对口令的 PUT 一次盘都没落").toBe(beforeOk + 1);

    const cleared = await app.request("/admin/api/config/secrets/clear", {
      method: "POST",
      headers: { ...withKey, "content-type": "application/json" },
      body: JSON.stringify({ path: "gatewayToken" }),
    });
    expect(cleared.status, "夹具本身清不掉 ⇒ 上面 secrets/clear 那三格是空的").toBe(200);
    expect(st.puts, "带对口令的 secrets/clear 一次盘都没落").toBe(beforeOk + 2);
  });
});
