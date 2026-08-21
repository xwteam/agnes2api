import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/http/wire.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { configFromEnv } from "../../src/core/config.js";
import { loadConfig } from "../../src/core/config.js";
import { exposureFields } from "../../src/core/admin/config-validate.js";
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
    expect(await res.json()).toMatchObject({ cleared: "gatewayToken", stillConfigured: false });

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

  it("干跑端点一次写都不产生，且与 PUT 用的是同一套规则", async () => {
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
   * 判据：**绕过端点**直接改存储，然后只发一次 `PUT`（改的是**另一个**字段）。
   * 回执里那个被绕过端点改掉的字段必须是**存储里的新值**——handler 手上那份
   * `next` 是从 `PUT` 之前读的那一份合并出来的，压根不知道它变过。
   *
   * ⚠️ 这一格与上一格是**两件事**：上一格证明「同一个进程看得到」，这一格证明
   * 「回读的数据源是存储」。少了这一格，把回执改成 `fieldsOf(verdict.next)`
   * 不会有任何东西变红。
   */
  it("PUT 的回执来自存储，不是 handler 自己算出来的那份 next", async () => {
    const { app, storage } = await realApp({ stored: { maxStrikes: 3, cooldownStrikeMs: 1_800_000 } });
    // 绕过端点，直接改存储：handler 在这次 PUT 里读到的 `stored` 会包含它，
    // 但**它不在 patch 里**，所以「自报」的那种实现同样会带上它……
    // ⇒ 判别力靠的是**第二次**改：在 PUT 已经把 `next` 算好之后再改是做不到的，
    // 所以这里换一个能分开的判据：回执里的 `effective` 必须与紧随其后的
    // `GET /admin/api/config` 逐字节一致（两者都从存储读）。
    await storage.put("config", { maxStrikes: 3, cooldownStrikeMs: 7_777_000 });

    const res = await put(app, { upstreamTimeoutMs: 5_000 });
    expect(res.status).toBe(200);
    const putBody = await res.json() as { fields: Record<string, { effective: unknown }> };
    expect(
      putBody.fields.cooldownStrikeMs!.effective,
      "回执没有反映存储里的当前值 —— 它是 handler 自己那份 next 的投影",
    ).toBe(7_777_000);

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
