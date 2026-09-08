import { describe, it, expect } from "vitest";
import { registrarFromEnv } from "../../../src/core/registrar/config.js";
import { registrarGrid } from "../../helpers/registrar-grid.js";
import { recordingLogger } from "../../helpers/recording-logger.js";

/**
 * **装载器对一张对抗性输入网格一次都不抛。**
 *
 * ── 这一格挡的是什么 ────────────────────────────────────────────────────────
 *
 * 注册机是**可选子系统**。它从前有八处 `throw`，于是「注册机开着却缺一把 key」
 * 这种运维配错会把**整个网关**打掉：
 * · Node/Docker：`main().catch` + `process.exit(1)` ⇒ 容器起不来（这是对的 fail-fast）；
 * · Worker：没有「启动」这回事，`buildApp` 每个 isolate 懒执行 ⇒ **部署"成功"、
 *   每个请求 500、真原因只落在 `console.error`**（真机实测：81 次探测 60 次 500，
 *   `/health` 也在内）。同一份代码、两种相反的运维体验。
 *
 * ⇒ 装载器全函数化：模块级零 `throw`，坏配置产出 `blockers`，注册机本次不启动。
 *
 * ⚠️ **这一格与 `tests/unit/source-guards.test.ts` 的「`src/core/registrar/` 下的
 * throw 恰好等于手写豁免清单」互为反向控制**：那一格从**源码**扫 `throw`
 *（结构，抓得住「加了一处但这张网格没覆盖到」），这一格从**行为**跑网格
 *（抓得住「throw 换了个马甲」，比如返回一个会被上层 rethrow 的东西）。
 * 少任何一格，另一格都有一整类逃逸。
 */
describe("装载器全函数化：对抗性输入网格上一次都不抛", () => {
  const GRID = registrarGrid();

  it("网格本身不是空的 —— 判据不许在测空气", () => {
    // **手写字面量下界**，不从 `registrarGrid()` 回填。
    expect(GRID.length).toBeGreaterThanOrEqual(300);
  });

  /**
   * ⚠️ **整张网格压成一格，刻意的**：`it.each` 会把 300 多组各算一格，那既让
   * 「本轮加了几格」这本账没法读，也让一次失败淹在几百行输出里。这里把抛的那些
   * **逐个点名**收集起来再断言，失败信息一样够复现。
   */
  it("整张网格跑下来一次都不抛", () => {
    const threw: string[] = [];
    for (const c of GRID) {
      try {
        // `flags` 也传：字段级降级那条路径上有一次写 `flags.degraded`，不传就走不到。
        registrarFromEnv(c.env, c.stored, recordingLogger(), { degraded: false });
      } catch (err) {
        threw.push(`${c.name} ⇒ ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(threw, "装载器又有地方抛了 —— 那意味着一份坏的注册机配置能重新把整个网关打掉")
      .toEqual([]);
  });

  /**
   * **逐条手写的期望值**，一格都不从被测对象回填。
   *
   * 挑的是网格里最容易写错的那几组：两侧的通道非法、env 非法不许穿透到存储、
   * 凭据缺一半、只对选中那条产 blocker、以及**不受 `enabled` 门控**的延迟对。
   */
  const codes = (env: Record<string, string | undefined>, stored: object): string[] =>
    registrarFromEnv(env, stored, recordingLogger(), { degraded: false })
      .blockers.map((b) => `${b.field}:${b.code}`).sort();

  it.each([
    ["关着 + 满地脏数据（含两个旧的主备键）⇒ 一条都不产",
      { REGISTRAR_PRIMARY: "abc" }, { fallback: "abc", enabled: false }, []],
    ["开着 + 什么都没选",
      { REGISTRAR_ENABLED: "true" }, {}, ["registrar.channel:channel_required"]],
    ["开着 + env 通道拼错（不许穿透到兼容别名，也不许穿透到存储里那条合法通道）",
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "abc", REGISTRAR_PRIMARY: "yyds" },
      { channel: "moemail", moemail: { baseUrl: "https://m.invalid", apiKey: "mk" } },
      ["registrar.channel:not_a_channel"]],
    ["开着 + 存储通道拼错",
      { REGISTRAR_ENABLED: "true" }, { channel: "abc" }, ["registrar.channel:not_a_channel"]],
    ["开着 + 存量旧键读得出来（兼容读）⇒ 缺的是那条通道的凭据，不是「没选通道」",
      { REGISTRAR_ENABLED: "true" }, { primary: "moemail" },
      [
        "registrar.moemail.apiKey:channel_credentials_missing",
        "registrar.moemail.baseUrl:channel_credentials_missing",
      ]],
    ["开着 + moemail 通道 + 只有 key 没有 baseUrl",
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "moemail", MOEMAIL_API_KEY: "mk" }, {},
      ["registrar.moemail.baseUrl:channel_credentials_missing"]],
    ["开着 + 选中 yyds、moemail 一格凭据都没有 ⇒ 未选中那条一条 blocker 都不产",
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k" }, {}, []],
    ["关着 + 延迟对反了 ⇒ 照样产（这一条不受 enabled 门控）",
      { MINT_DELAY_MIN_MS: "9000", MINT_DELAY_MAX_MS: "3000" }, {},
      ["registrar.mintDelayMinMs:delay_min_gt_max"]],
    // ⚠️ **这一行的两个数是重算过的，不是照抄。** 它要造的形态是「非法值回落到内置
    // 取值之后，min 与 max 的搭配**不再**反」。上一版写的是 `min=abc` + `max=3000`，
    // 当时 min 回落到 2000 < 3000 ⇒ 不产；`MINT_DELAY_MIN_MS` 的内置取值改成 60000
    // 之后 60000 > 3000 ⇒ **它反而开始产 blocker，整行测的东西反了**。
    // 手写新字面量：min 回落到 60000，给一个比它大的 max。
    ["关着 + 延迟对里那个非法值回落内置取值之后不再反 ⇒ 一条都不产",
      { MINT_DELAY_MIN_MS: "abc", MINT_DELAY_MAX_MS: "120000" }, {}, []],
    // **与上一行成对**：同样是回落，但回落之后的搭配**是反的** ⇒ 照样产。
    // 少了这一行，「回落之后一律不产」这种实现在上一行也是绿的。
    ["关着 + 非法值回落内置取值之后搭配是反的 ⇒ 照样产",
      { MINT_DELAY_MIN_MS: "abc", MINT_DELAY_MAX_MS: "3000" }, {},
      ["registrar.mintDelayMinMs:delay_min_gt_max"]],
    ["开着 + 数值全写坏 ⇒ 全部回落默认值，一条 blocker 都不产",
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k", TARGET_KEYS: "abc", MINT_BATCH: "-1" },
      {}, []],
  ] as const)("blockers 逐条等于手写期望：%s", (_n, env, stored, want) => {
    expect(codes(env as Record<string, string | undefined>, stored)).toEqual([...want]);
  });

  it("blocked 恒等于「blockers 非空」—— 这一格是那个标量与数组之间唯一的绑定", () => {
    const mismatched = GRID.filter((c) => {
      const r = registrarFromEnv(c.env, c.stored, recordingLogger(), { degraded: false });
      return r.config.blocked !== (r.blockers.length > 0);
    }).map((c) => c.name);
    expect(mismatched, "面板读的是标量 `blocked`、诊断视图读的是数组 —— 两者说不同的话就是撒谎")
      .toEqual([]);
  });

  it("blocked 为真时 enabled 一个字都不改 —— 真话是「已启用 · 本次没跑起来」", () => {
    const lying = GRID.filter((c) => {
      const r = registrarFromEnv(c.env, c.stored, recordingLogger(), { degraded: false });
      // 判据只对「运维确实打开了」的那些组成立。
      const wantEnabled = (c.env.REGISTRAR_ENABLED ?? String(c.stored.enabled ?? false)) === "true";
      return r.config.enabled !== wantEnabled;
    }).map((c) => c.name);
    expect(lying, "「运维明明打开了，面板却说未启用」是另一种撒谎，本仓刚为同形态连修两轮")
      .toEqual([]);
  });
});
