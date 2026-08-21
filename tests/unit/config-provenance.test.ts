import { describe, it, expect } from "vitest";
import {
  loadConfigWithProvenance, FIELD_EXPOSURE, envLockedFields,
} from "../../src/core/config-provenance.js";
import { loadConfig } from "../../src/core/config.js";
import { registrarFromEnv } from "../../src/core/registrar/config.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { recordingLogger } from "../helpers/recording-logger.js";

/**
 * `loadConfigWithProvenance` —— 设计 §5.3 的「面板不承诺生效，而是回读生效值」
 * 那一半的**唯一**实现。
 *
 * ⚠️ **本文件所有期望值一律手写字面量，绝不从 `DEFAULTS` / `ENV_LOCK_MAP` /
 * `FIELD_EXPOSURE` 反推。** 从被测对象推导出来的期望值恒等于实际值（本仓登记的
 * 第 6 种假阳性）——而这里被测的恰恰是「优先级判断有没有第二份实现」，
 * 一旦期望值也从那份实现里来，两份实现一起改的变异会完整逃逸。
 */

async function withStored(stored: unknown, env: Record<string, string | undefined>) {
  const storage = new MemoryStorage();
  if (stored !== undefined) await storage.put("config", stored);
  return { storage, env };
}

describe("四元组：env > 存储 > 内置默认值，逐字段说清是谁赢了", () => {
  /**
   * **这一格是变异 M3（把来源推导写进 handler）的靶子。**
   *
   * 三个字段各代表一种赢法，而且刻意**让存储与 env 给出不同的值**——两边同值的话
   * 「谁赢了」这件事整个不可观测（本仓第 1 种假阳性：夹具无冲突数据）。
   */
  it("env 赢 / 存储赢 / 默认值赢，三种各一格，期望值全部手写字面量", async () => {
    const { storage, env } = await withStored(
      { maxStrikes: 4, cooldownStrikeMs: 7_777_000 },
      { GATEWAY_TOKEN: "gw-token-for-provenance", MAX_STRIKES: "9" },
    );
    const { config, source } = await loadConfigWithProvenance(env, storage);

    // ① env 赢：存储里写着 4，环境变量写着 9。
    expect(source.maxStrikes).toEqual({
      exposure: "public", stored: 4, env: "9", effective: 9, lockedBy: "env:MAX_STRIKES",
    });
    expect(config.maxStrikes).toBe(9);

    // ② 存储赢：环境变量没设这一项。
    expect(source.cooldownStrikeMs).toEqual({
      exposure: "public", stored: 7_777_000, env: null, effective: 7_777_000, lockedBy: null,
    });
    expect(config.cooldownStrikeMs).toBe(7_777_000);

    // ③ 默认值赢：两边都没有。`stored` 是 `undefined`（**不是 `null`**——
    // 「存储里没有这一格」与「存储里明确写了 null」是两件事）。
    expect(source.cooldownPaymentMs).toEqual({
      exposure: "public", stored: undefined, env: null, effective: 3_600_000, lockedBy: null,
    });
    expect(config.cooldownPaymentMs).toBe(3_600_000);
  });

  /**
   * **`loadConfig` 真的是薄封装，不是第二份实现**（设计 §5.3 逐字）。
   *
   * 判据是**逐字节相同**（`JSON.stringify` 比对），不是抽查几个字段：抽查漏掉的
   * 那一格正好是两份实现开始漂的地方时，这条会全绿。
   * **变红条件**：在 `loadConfig` 里补任何一条「顺手的」优先级判断。
   */
  it("loadConfig 与 loadConfigWithProvenance 对同一组输入给出逐字节相同的 config", async () => {
    const { storage, env } = await withStored(
      {
        maxStrikes: 4, agnesBaseUrl: "https://stored.example.com/v1",
        registrar: { enabled: true, primary: "moemail", moemail: { baseUrl: "https://m.example.com", apiKey: "mk" } },
      },
      { GATEWAY_TOKEN: "gw-token-for-provenance", POOL_CACHE_TTL_MS: "0" },
    );
    const viaWrapper = await loadConfig(env, storage);
    const { config } = await loadConfigWithProvenance(env, storage);
    expect(JSON.stringify(viaWrapper)).toBe(JSON.stringify(config));
    // 反向自检：夹具本身得真的有内容，否则上面那条在两个空对象上也是绿的。
    expect(config.registrar.enabled).toBe(true);
    expect(config.agnesBaseUrl).toBe("https://stored.example.com/v1");
  });

  /**
   * **字段级降级那条分支上，面板必须说实话。**
   *
   * 这是「面板层另写一套来源推导」最容易翻车的一格：照着「有存储就显示存储」推，
   * 面板会把那个非法值报成生效值，而网关实际在用默认值。
   */
  it("存储里的非法值：stored 如实回显那个非法值，effective 是回落后的默认值", async () => {
    const logger = recordingLogger();
    const { storage, env } = await withStored(
      { maxStrikes: "not-a-number" },
      { GATEWAY_TOKEN: "gw-token-for-provenance" },
    );
    const { config, source } = await loadConfigWithProvenance(env, storage, logger);
    expect(source.maxStrikes).toEqual({
      exposure: "public", stored: "not-a-number", env: null, effective: 3, lockedBy: null,
    });
    expect(config.maxStrikes).toBe(3);
    expect(config.degraded, "字段回落了却没报降级 ⇒ 面板上的红色横幅不会出现").toBe(true);
    expect(logger.has("config.invalid")).toBe(true);
  });

  /**
   * **判据是「这个键在 env 里存在」，不是「值合法」。**
   * `MAX_STRIKES=`（空串）会走进 `num()` 的 env 分支然后抛错——面板必须显示它是
   * 锁定的，否则用户会一直改存储、一直没效果。
   * **变红条件**：把 `lockedBy` 的判据从「键存在」改成「值合法」（变异 M8）。
   */
  it("空串的环境变量也算锁定 —— 判据是键存在，不是值合法", async () => {
    const { storage, env } = await withStored(undefined, {
      GATEWAY_TOKEN: "gw-token-for-provenance", COOLDOWN_PAYMENT_MS: "",
    });
    // 空串会让 `num()` 抛（`Number("") === 0` 不满足 `>= 1`），所以这里只验锁定表。
    expect(envLockedFields(env).sort()).toEqual(["cooldownPaymentMs", "gatewayToken"]);
  });
});

describe("凭据只写不读（设计 §8.6）", () => {
  it("三把凭据都走 { configured, hint }，响应形状里没有 stored / effective 两格", async () => {
    const { storage, env } = await withStored(
      { registrar: { yyds: { apiKey: "yyds-secret-abcd" } } },
      { GATEWAY_TOKEN: "gateway-secret-wxyz" },
    );
    const { source } = await loadConfigWithProvenance(env, storage);

    expect(source.gatewayToken).toEqual({
      exposure: "secret", configured: true, hint: "wxyz", lockedBy: "env:GATEWAY_TOKEN",
    });
    expect(source["registrar.yyds.apiKey"]).toEqual({
      exposure: "secret", configured: true, hint: "abcd", lockedBy: null,
    });
    expect(source["registrar.moemail.apiKey"]).toEqual({
      exposure: "secret", configured: false, hint: null, lockedBy: null,
    });
  });

  /**
   * **短于 5 位一律不给 hint**：末 4 位对一把 4 位的口令就是全部，那不叫提示、
   * 那叫 reveal。夹具默认的 `gatewayToken` 恰好是 1 位，这条在真实夹具上就成立。
   */
  it("短于 5 位的凭据不给 hint —— 给了就是给全", async () => {
    const { storage, env } = await withStored(undefined, { GATEWAY_TOKEN: "abcd" });
    const { source } = await loadConfigWithProvenance(env, storage);
    expect(source.gatewayToken).toEqual({
      exposure: "secret", configured: true, hint: null, lockedBy: "env:GATEWAY_TOKEN",
    });
  });

  /**
   * ⚠️ **设计 §5.5：读模型 ≠ 生效模型。**
   *
   * `registrarFromEnv` 的结尾是 `if (!enabled) return cfg;`，之后才填 `cfg.yyds`
   * ⇒ **注册机关闭时两家的凭据恒为 `null`，虽然存储里有却读不出来。**
   * 用户「先填凭据、后开开关」这个最自然的顺序下，照生效模型报的面板会显示
   * 「未配置」，逼他再填一遍。
   *
   * **变红条件**：把 `configured` 的判据从「存储原件 + env」改成「生效配置」。
   */
  it("注册机关着时，存储里填过的凭据仍然报 configured: true（读模型 ≠ 生效模型）", async () => {
    const { storage, env } = await withStored(
      { registrar: { enabled: false, moemail: { baseUrl: "https://m.example.com", apiKey: "moe-secret-1234" } } },
      { GATEWAY_TOKEN: "gw-token-for-provenance" },
    );
    const { config, source } = await loadConfigWithProvenance(env, storage);
    // 前置条件：生效模型里它确实是 null —— 否则这一格测的不是它想测的那件事。
    expect(config.registrar.moemail, "前置条件不成立：关着的注册机应当解析不出凭据").toBeNull();
    expect(source["registrar.moemail.apiKey"]).toEqual({
      exposure: "secret", configured: true, hint: "1234", lockedBy: null,
    });
    // 同一条理由对**公开**的那一格同样成立：`baseUrl` 的 `stored` 必须来自存储原件。
    expect(source["registrar.moemail.baseUrl"]).toMatchObject({
      stored: "https://m.example.com", effective: null,
    });
  });
});

describe("FIELD_EXPOSURE 是「哪些字段是凭据」的唯一真源", () => {
  /**
   * 表里恰好三格 `"secret"`，**手写字面量**。
   *
   * 它不是重复 `FIELD_EXPOSURE`：那张表是嵌套的、按字段组织；这里是**扁平的路径
   * 清单**，而路径清单正是四元组的键集合。把某个 `"secret"` 改成 `"public"`
   * ⇒ 这一格红（同时 `admin-config.test.ts` 的哨兵双向断言也红，两处方向不同）。
   */
  it("凭据恰好是这三条路径（手写清单，加一把新密钥必须在评审里被看见）", async () => {
    const { storage, env } = await withStored(undefined, { GATEWAY_TOKEN: "gw-token-for-provenance" });
    const { source } = await loadConfigWithProvenance(env, storage);
    const secrets = Object.entries(source)
      .filter(([, f]) => f.exposure === "secret").map(([p]) => p).sort();
    expect(secrets).toEqual([
      "gatewayToken", "registrar.moemail.apiKey", "registrar.yyds.apiKey",
    ]);
  });

  it("四元组的键集合就是 FIELD_EXPOSURE 走出来的全部叶子（手写的 27 条）", async () => {
    const { storage, env } = await withStored(undefined, { GATEWAY_TOKEN: "gw-token-for-provenance" });
    const { source } = await loadConfigWithProvenance(env, storage);
    const paths = Object.keys(source).sort();
    expect(paths).toEqual([
      "agnesBaseUrl", "cooldownPaymentMs", "cooldownRateLimitMs", "cooldownStrikeMs",
      "degraded", "gatewayToken", "maxStrikes", "poolCacheTtlMs", "poolTouchIntervalMs",
      "registrar.agnesPlatformUrl", "registrar.codeTimeoutMs", "registrar.enabled",
      "registrar.fallback", "registrar.maxDomainAttempts", "registrar.mintBatch",
      "registrar.mintDelayMaxMs", "registrar.mintDelayMinMs", "registrar.moemail.apiKey",
      "registrar.moemail.baseUrl", "registrar.primary", "registrar.targetKeys",
      "registrar.tendIntervalMs", "registrar.tokenName", "registrar.yyds.apiKey",
      "registrar.yyds.baseUrl", "upstreamSyncTimeoutMs", "upstreamTimeoutMs",
    ]);
    expect(paths.length, "27 这个数是手写的：加字段必须在评审里被看见").toBe(27);
  });

  /**
   * ⚠️ **已知盲点，写成断言而不是散文**（做法抄 `tests/unit/source-guards.test.ts`
   * 的「已知抓不住的写法确实抓不住（边界是断言，不是散文）」那一族）：`ExposureMap<T>` 的判据是 `extends object`，而**数组也满足它**
   * ⇒ 将来给 `GatewayConfig` 加一个数组字段时，那张表会要求为它写一张「子表」，
   * 而不是一格 `Exposure`。`GatewayConfig` 今天没有数组字段，所以这条今天不咬人。
   *
   * 这一格变红意味着**有人给配置加了数组字段**——到时候要回 `config-provenance.ts`
   * 给 `ExposureMap` 补一条数组分支，并把这条断言删掉。
   */
  it("已知盲点：数组字段会被当成对象递归 —— 边界是断言不是散文", () => {
    const hasArrayLeaf = (node: unknown): boolean => {
      if (Array.isArray(node)) return true;
      if (typeof node !== "object" || node === null) return false;
      return Object.values(node as Record<string, unknown>).some(hasArrayLeaf);
    };
    expect(
      hasArrayLeaf(FIELD_EXPOSURE),
      "FIELD_EXPOSURE 里出现了数组 —— ExposureMap 的 `extends object` 会把它当对象递归，"
      + "请去 config-provenance.ts 给它补一条数组分支，然后删掉这一格",
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F10：锁定表的防漂断言（分支矩阵的并集，不是单次调用）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ **判据必须是「四种配置的并集」，不能是一次调用。**
 *
 * `creds()`（`src/core/registrar/config.ts` 的「启用时才校验凭据」那一段）读
 * 4 个 env 名字，而它**只在 `enabled === true` 且该通道在链上时才被调**，并且
 * **缺凭据时会抛**。一次调用最多摸到 12 个名字 ⇒ 断言写成「实际读到 ⊆ 锁定表」时，
 * **未走到的分支上新增的读取点静默逃逸**。
 *
 * ⇒ 四种配置（关 / 开×yyds 主 / 开×moemail 主 / 开×双通道）各跑一次 Proxy 追踪，
 * **抛错的那次也要把已访问的名字收下**，断言并集恰好等于下面那张手写清单。
 * **变红条件**：① 给 `registrarFromEnv` 或 `creds()` 任一分支加一个新读取点而不进
 * 锁定表；② 把矩阵砍成一种配置（则 `creds()` 那 4 个名字漏出）。
 */
describe("F10：registrarFromEnv 读到的 env 名字，全部进了锁定表", () => {
  /** 用 Proxy 记下一次 `registrarFromEnv` 摸过哪些 env 键。**抛错也要把已访问的收下。** */
  function tracked(base: Record<string, string | undefined>): string[] {
    const seen = new Set<string>();
    const proxy = new Proxy(base, {
      get(target, prop) {
        if (typeof prop === "string") seen.add(prop);
        return Reflect.get(target, prop);
      },
      has(target, prop) {
        if (typeof prop === "string") seen.add(prop);
        return Reflect.has(target, prop);
      },
    });
    try {
      registrarFromEnv(proxy, {}, NULL_LOGGER);
    } catch {
      // 抛了也算——`creds()` 缺凭据时就是抛的，而它抛之前已经读过那几个名字了。
    }
    return [...seen];
  }

  const MATRIX: ReadonlyArray<{ name: string; env: Record<string, string | undefined> }> = [
    { name: "关", env: {} },
    {
      name: "开 × yyds 主",
      env: { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" },
    },
    {
      name: "开 × moemail 主",
      env: {
        REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "moemail",
        MOEMAIL_BASE_URL: "https://m.example.com", MOEMAIL_API_KEY: "k",
      },
    },
    {
      name: "开 × 双通道",
      env: {
        REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", REGISTRAR_FALLBACK: "moemail",
        YYDS_API_KEY: "k", MOEMAIL_BASE_URL: "https://m.example.com", MOEMAIL_API_KEY: "k",
      },
    },
  ];

  /**
   * **手写字面量清单，不是 `.length`。** 只断言个数的话，「删掉一个名字、加上另一个」
   * 会完整逃逸——而那正是改名时最容易发生的事。
   */
  const EXPECTED_ENV_NAMES = [
    "AGNES_PLATFORM_URL", "CODE_TIMEOUT_MS", "MAX_DOMAIN_ATTEMPTS", "MINT_BATCH",
    "MINT_DELAY_MAX_MS", "MINT_DELAY_MIN_MS", "MOEMAIL_API_KEY", "MOEMAIL_BASE_URL",
    "REGISTRAR_ENABLED", "REGISTRAR_FALLBACK", "REGISTRAR_PRIMARY", "REGISTRAR_TOKEN_NAME",
    "TARGET_KEYS", "TEND_INTERVAL_MS", "YYDS_API_KEY", "YYDS_BASE_URL",
  ] as const;

  it("四种配置的并集恰好是手写的这 16 个名字", () => {
    const union = new Set<string>();
    for (const cell of MATRIX) for (const n of tracked(cell.env)) union.add(n);
    expect([...union].sort()).toEqual([...EXPECTED_ENV_NAMES].sort());
  });

  /**
   * **反向自检：单跑一种配置真的摸不全。**
   *
   * 不写这一格的话，「把矩阵砍成一种配置」这条变异**不会红**——上面那条会跟着
   * 少 4 个名字一起被改绿。这一格把「为什么必须是并集」钉成一条会变红的断言。
   */
  it("单跑「关」这一种配置只摸得到 12 个 —— creds() 那 4 个会静默逃逸", () => {
    const only = tracked({}).sort();
    expect(only.length).toBe(12);
    for (const leaked of ["YYDS_API_KEY", "YYDS_BASE_URL", "MOEMAIL_API_KEY", "MOEMAIL_BASE_URL"]) {
      expect(only, `${leaked} 在「关」这一支上本来就摸不到`).not.toContain(leaked);
    }
  });

  /**
   * 并集里的每一个名字都必须在锁定表里。
   * **判据走 `envLockedFields`**（那是面板真正消费的那个函数），不是去读私有的
   * `ENV_LOCK_MAP`——后者是实现细节，前者是契约。
   */
  it("这 16 个名字每一个都能让 envLockedFields 报出一条锁定字段", () => {
    const missing = EXPECTED_ENV_NAMES.filter((n) => envLockedFields({ [n]: "x" }).length === 0);
    expect(
      missing,
      "这些环境变量会被 registrarFromEnv 读到、却不在锁定表里 ⇒ 面板会把一个"
      + "「改了也不生效」的字段显示成可以改，而那正是设计 §5.3 开头点名的最高频形态",
    ).toEqual([]);
  });

  /** 锁定表的完整清单（10 个网关 + 16 个注册机）。**手写，加字段必须在评审里被看见。** */
  it("锁定表恰好是这 26 条字段路径", () => {
    const all = envLockedFields(Object.fromEntries([
      "GATEWAY_TOKEN", "AGNES_BASE_URL", "UPSTREAM_TIMEOUT_MS", "UPSTREAM_SYNC_TIMEOUT_MS",
      "MAX_STRIKES", "COOLDOWN_RATE_LIMIT_MS", "COOLDOWN_PAYMENT_MS", "COOLDOWN_STRIKE_MS",
      "POOL_CACHE_TTL_MS", "POOL_TOUCH_INTERVAL_MS",
      ...EXPECTED_ENV_NAMES,
    ].map((n) => [n, "x"]))).sort();
    expect(all).toEqual([
      "agnesBaseUrl", "cooldownPaymentMs", "cooldownRateLimitMs", "cooldownStrikeMs",
      "gatewayToken", "maxStrikes", "poolCacheTtlMs", "poolTouchIntervalMs",
      "registrar.agnesPlatformUrl", "registrar.codeTimeoutMs", "registrar.enabled",
      "registrar.fallback", "registrar.maxDomainAttempts", "registrar.mintBatch",
      "registrar.mintDelayMaxMs", "registrar.mintDelayMinMs", "registrar.moemail.apiKey",
      "registrar.moemail.baseUrl", "registrar.primary", "registrar.targetKeys",
      "registrar.tendIntervalMs", "registrar.tokenName", "registrar.yyds.apiKey",
      "registrar.yyds.baseUrl", "upstreamSyncTimeoutMs", "upstreamTimeoutMs",
    ]);
  });
});
