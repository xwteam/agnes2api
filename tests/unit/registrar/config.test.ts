import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { WORKER_CRON_WALL_CLOCK_MS, WORKER_ROUND_BUDGET_MS } from "../../../src/core/registrar/types.js";
import {
  registrarFromEnv, requireChannel, migrateStoredRegistrar,
} from "../../../src/core/registrar/config.js";
import { recordingLogger } from "../../helpers/recording-logger.js";

/** 只要生效配置那一半。装载器现在返回 `{ config, blockers, notices }` 三格。 */
const cfg = (
  env: Parameters<typeof registrarFromEnv>[0],
  stored: Parameters<typeof registrarFromEnv>[1] = {},
  logger?: Parameters<typeof registrarFromEnv>[2],
): ReturnType<typeof registrarFromEnv>["config"] => registrarFromEnv(env, stored, logger).config;

/** `blockers` 压成 `field:code` 排序清单——逐条比对时读起来是人话。 */
const codes = (r: ReturnType<typeof registrarFromEnv>): string[] =>
  r.blockers.map((b) => `${b.field}:${b.code}`).sort();

describe("registrarFromEnv", () => {
  it("默认不启用", () => {
    expect(cfg({}, {}).enabled).toBe(false);
  });

  it("默认值与设计文档一致", () => {
    const c = cfg({}, {});
    expect(c.targetKeys).toBe(20);
    expect(c.mintBatch).toBe(5);
    expect(c.tendIntervalMs).toBe(1_800_000);
    expect(c.codeTimeoutMs).toBe(120_000);
    expect(c.maxDomainAttempts).toBe(8);
  });

  // ⚠️⚠️ **这一族用例在「装载器全函数化」那一轮从「抛错」改判成「产出 blocker」。**
  // 判据的**行为**没有放松，换的是失败形态：从前一份坏配置让**整个网关**起不来
  //（Node 进程退出 / Worker 每个请求 500），现在只让**注册机本次不启动**，
  // 转发、`/health`、面板照常。`blocked` 与逐条 `blockers` 是那件事的对外表达。
  it("启用但没选通道时产出 channel_required（两条通道平级，不预设默认）", () => {
    const r = registrarFromEnv({ REGISTRAR_ENABLED: "true" }, {});
    expect(codes(r)).toEqual(["registrar.channel:channel_required"]);
    expect(r.config.blocked).toBe(true);
    // **`enabled` 一个字都不改**：「运维明明打开了，面板却说未启用」是另一种撒谎。
    expect(r.config.enabled).toBe(true);
  });

  it("启用但选中通道的凭据缺失时产出 channel_credentials_missing 并指明是哪一格", () => {
    const r = registrarFromEnv({ REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds" }, {});
    expect(r.blockers).toEqual([
      { field: "registrar.yyds.apiKey", code: "channel_credentials_missing", params: { channel: "yyds" } },
    ]);
    // **不发明取值**：缺凭据的通道保持 null，下游拿不到一份半真的 ChannelCreds。
    expect(r.config.yyds).toBeNull();
    expect(r.config.blocked).toBe(true);
  });

  it("启用且凭据齐备时通过（blockers 空、blocked 假）", () => {
    const r = registrarFromEnv({ REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k" }, {});
    expect(r.config.enabled).toBe(true);
    expect(r.config.yyds).toEqual({ baseUrl: "https://maliapi.215.im", apiKey: "k" });
    expect(r.blockers).toEqual([]);
    expect(r.config.blocked).toBe(false);
  });

  it("配置模型上根本不存在第二条通道的槽位（界面藏起来、内部还是主备就会红）", () => {
    // ⚠️ **必须比键集合，不能只写 `expect(cfg.fallback).toBeUndefined()`**：
    // 一个「保留 fallback 字段但恒为 null」的实现能从后者那边蒙混过去，
    // 而那正是「面板上把第二个下拉藏起来、内部还是主备」这个谎的形状。
    const r = registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k" },
      { primary: "moemail", fallback: "moemail" } as never,
    );
    expect(Object.keys(r.config).sort()).toEqual([
      "agnesPlatformUrl", "blocked", "channel", "codeTimeoutMs", "enabled",
      "maxDomainAttempts", "mintBatch", "mintDelayMaxMs", "mintDelayMinMs",
      "moemail", "targetKeys", "tendIntervalMs", "tokenName", "yyds",
    ]);
    expect(Object.keys(r.config)).not.toContain("fallback");
    expect(Object.keys(r.config)).not.toContain("primary");
  });

  it("两条通道都解析凭据，但只有选中那条的缺凭据产 blocker（正向）", () => {
    // 未选中那条的 `configured` 必须是真话 —— 面板的「测试连接」与「添加 Key ▸
    // 自动注册」都拿它当判据，而「切换前先比一比」是二选一模型下最核心的工作流。
    const r = registrarFromEnv({
      REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k",
      MOEMAIL_BASE_URL: "https://m.test", MOEMAIL_API_KEY: "mk",
    }, {});
    expect(r.config.moemail).toEqual({ baseUrl: "https://m.test", apiKey: "mk" });
    expect(r.blockers).toEqual([]);
    expect(r.config.blocked).toBe(false);
  });

  it("未选中那条通道缺凭据时不产 blocker（反向，与上一条缺一不可）", () => {
    // 没选它就不该拦人。少了这一条，一个「两条都收 blocker」的实现照样能过上一条。
    const r = registrarFromEnv({
      REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k",
      MOEMAIL_BASE_URL: "https://m.test",
    }, {});
    expect(r.config.moemail).toBeNull();
    expect(r.blockers).toEqual([]);
    expect(r.config.blocked).toBe(false);
  });

  it("反向控制：选中 moemail 时，缺的是 moemail 的凭据（两条通道一视同仁）", () => {
    expect(codes(registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "moemail", MOEMAIL_API_KEY: "k" }, {},
    ))).toEqual(["registrar.moemail.baseUrl:channel_credentials_missing"]);
  });

  it(".env.example 的凭据注释两条通道对称，且不再提主备", () => {
    // .env.example 是用户复制来改的那份文件，它的措辞就是这条约束对外的唯一说明；
    // 上面那几条断言的是代码行为，这条断言的是文档不与代码矛盾。
    const env = readFileSync(".env.example", "utf8");
    expect(env).toContain("# YYDS Mail 凭据（选中的通道为 yyds 时必填）");
    expect(env).toContain("选中的通道为 moemail 时两项都必填");
    // 旧措辞里那对「主通道 / 备通道」已经不存在了，留着就是在教一个不存在的模型。
    expect(env).not.toContain("主通道或备通道任一");
  });

  it("环境变量优先于存储", () => {
    expect(cfg({ TARGET_KEYS: "7" }, { targetKeys: 30 }).targetKeys).toBe(7);
  });

  it("存储值在环境变量缺失时生效", () => {
    expect(cfg({}, { targetKeys: 30 }).targetKeys).toBe(30);
  });

  /**
   * ⚠️⚠️ **这一格是本轮唯一一处主动放弃的 fail-fast，判据跟着整个换了。**
   *
   * 从前 `TARGET_KEYS=abc` 在两侧都抛：Node 上容器起不来（运维立刻看得见），
   * Worker 上则是**部署成功、每个请求 500、原因只在 `wrangler tail`**。
   * 现在两侧一律回落默认值 + 一条 `config.invalid` + `degraded` 标记，
   * **不产 blocker**（字段回落之后注册机照样跑得起来，与 `num()` 的既有策略一致）。
   *
   * 代价明写在被测代码的 `posInt()` 注释里：Node 运维不能再靠「容器崩了」发现部署笔误。
   */
  it("数值非法时回落默认值 + 记 config.invalid + 打 degraded，而不是抛错也不是 NaN", () => {
    const logger = recordingLogger();
    const flags = { degraded: false };
    const r = registrarFromEnv({ TARGET_KEYS: "abc", MINT_BATCH: "0" }, { tendIntervalMs: -1 }, logger, flags);
    expect(r.config.targetKeys).toBe(20);
    expect(r.config.mintBatch).toBe(5);
    expect(r.config.tendIntervalMs).toBe(1_800_000);
    expect(r.blockers).toEqual([]);
    expect(r.config.blocked).toBe(false);
    expect(flags.degraded).toBe(true);
    expect(
      logger.entries.filter((x) => x.event === "config.invalid").map((x) => x.fields?.field).sort(),
    ).toEqual(["registrar.mintBatch", "registrar.targetKeys", "registrar.tendIntervalMs"]);
    // **env 与 stored 两侧都要能分辨**：面板文案里「是你写的环境变量还是面板存的值」
    // 是运维接下来改哪里的唯一依据。
    expect(
      logger.entries.filter((x) => x.event === "config.invalid").map((x) => x.fields?.source).sort(),
    ).toEqual(["env", "env", "stored"]);
  });

  it("不传 flags 时同样不抛（configFromEnv 这条路径没有存储来源，也就没有 degraded 可打）", () => {
    expect(() => registrarFromEnv({ TARGET_KEYS: "abc" }, {})).not.toThrow();
  });

  // 早期遗留：配置校验此前只覆盖环境变量层，没覆盖存储层。primary/fallback 是决定
  // 走哪条代码分支的枚举值，若存储里的垃圾值能绕过校验静默流入，下游按通道分支的
  // 代码（例如选哪个 MailProvider 适配器）会拿到既不是 yyds 也不是 moemail 的值。
  // 通道格式校验现在受 enabled 门控（见下面"未启用时…只 warn"的用例），故这里要
  // 显式启用注册机，才能真正打在"启用时格式非法必须抛错"这条分支上。
  it("启用时存储中的 channel 非法值产出 not_a_channel，不能绕过校验静默流入", () => {
    const r = registrarFromEnv({ REGISTRAR_ENABLED: "true" }, { channel: "garbage" as never });
    expect(codes(r)).toEqual(["registrar.channel:not_a_channel"]);
    // **不同时报 channel_required**：值写错了与压根没选是两句不同的话。
    expect(r.config.channel).toBeNull();
  });

  /**
   * ⚠️⚠️ **这一格是本轮改动**自己引入**的缺陷的堵口，别删。**
   *
   * `channel()` / `storedChannel()` 合并成一个 `resolveChannel()` 之后，调用点原来
   * 那句 `channel(...) ?? storedChannel(...)` 如果照搬，`REGISTRAR_PRIMARY=yydss`
   * 会**静默穿透**成存储里那条通道——运维写错一个字母，网关拿另一条通道去跑，
   * 一句话都不说。判据钉的是「env 侧写错就不再看存储」这个行为。
   */
  it("新名字非法时既不落到兼容别名、也不落到存储（四级之间同样不许穿透）", () => {
    // 候选从 2 级变 4 级之后，「本级判死就到此为止」这条纪律一个字都不能松：
    // 松了的话新名字写错一个字母，网关会静默拿旧名字或存储里那条通道去跑。
    const r = registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yydss", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" },
      { channel: "moemail" as never, moemail: { baseUrl: "https://m.test", apiKey: "k" } },
    );
    expect(r.config.channel).toBeNull();
    expect(codes(r)).toEqual(["registrar.channel:not_a_channel"]);
  });

  it("env 侧通道值是空串时算「没写」，继续往下看（compose 里 `REGISTRAR_CHANNEL=` 是常见写法）", () => {
    const r = registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "", YYDS_API_KEY: "k" },
      { channel: "yyds" as never },
    );
    expect(r.config.channel).toBe("yyds");
    expect(r.blockers).toEqual([]);
  });

  // 注册机关闭时，一个用不到的字段不该让整个网关起不来（例如面板写入 bug、
  // 手工改存储、跨版本迁移遗留）。只留痕，不阻断启动。
  it("未启用时存储中通道格式脏数据只记事件不抛错，网关仍能正常启动", () => {
    // console.* 已经被换成注入的 Logger（第 3 个可选参数）：spy console 只会看到空
    // mock，必须改成 recordingLogger 断言事件名。
    const logger = recordingLogger();
    let got: ReturnType<typeof registrarFromEnv> | undefined;
    expect(() => {
      got = registrarFromEnv({}, { channel: "garbage" as never }, logger);
    }).not.toThrow();
    expect(got!.config.enabled).toBe(false);
    // **关着的注册机一条 blocker 都不产**：那几条全部受 enabled 门控。
    expect(got!.blockers).toEqual([]);
    expect(got!.config.blocked).toBe(false);
    expect(logger.has("registrar.config_ignored")).toBe(true);
  });

  it("未启用时不校验凭据（关着就不该因为没配 key 而让注册机记一笔）", () => {
    // 关键：REGISTRAR_PRIMARY 已指定但对应凭据缺失——原始测试只传了
    // { REGISTRAR_ENABLED: "false" }，此时 primary 本来就是 null，凭据校验循环
    // 天然不会跑到，删掉"未启用时跳过校验"的分支这条测试也照样通过（验证过：
    // 真的删掉代码里的 `if (!enabled) return cfg;` 后 12 个测试仍全绿）。
    // 必须让 primary 有值、凭据没给，才能真正打在"关闭时跳过凭据校验"这条分支上。
    const r = registrarFromEnv({ REGISTRAR_ENABLED: "false", REGISTRAR_CHANNEL: "yyds" }, {});
    expect(r.blockers).toEqual([]);
    expect(r.config.yyds).toBeNull();
  });

  it("mintDelayMinMs 大于 mintDelayMaxMs 时产出 delay_min_gt_max，且带上两个生效值", () => {
    const r = registrarFromEnv({ MINT_DELAY_MIN_MS: "9000", MINT_DELAY_MAX_MS: "3000" }, {});
    expect(r.blockers).toEqual([
      { field: "registrar.mintDelayMinMs", code: "delay_min_gt_max", params: { min: 9000, max: 3000 } },
    ]);
    // **这一条不受 enabled 门控**——与 `crossFieldErrors` 里那条逐字一致。
    expect(r.config.enabled).toBe(false);
    expect(r.config.blocked).toBe(true);
  });

  it("delay 那条比的是**生效值**：env 只给了 min，max 走内置默认值照样比得出来", () => {
    // 从前 `crossFieldErrors` 比的是存储原件里那两个数，这一类整个漏在外面。
    expect(codes(registrarFromEnv({ MINT_DELAY_MIN_MS: "9000" }, {})))
      .toEqual(["registrar.mintDelayMinMs:delay_min_gt_max"]);
  });

  it("mintDelayMinMs 等于 mintDelayMaxMs 时不产 blocker（固定延迟是合法配置）", () => {
    const c = cfg({ MINT_DELAY_MIN_MS: "3000", MINT_DELAY_MAX_MS: "3000" }, {});
    expect(c.mintDelayMinMs).toBe(3000);
    expect(c.mintDelayMaxMs).toBe(3000);
  });

  it("tokenName 读的是 REGISTRAR_TOKEN_NAME（无前缀的 TOKEN_NAME 在容器里太容易撞车）", () => {
    expect(cfg({ REGISTRAR_TOKEN_NAME: "mine" }, {}).tokenName).toBe("mine");
    // 无前缀的旧名字不再被读取——否则编排层里别的组件设的 TOKEN_NAME 会静默生效。
    expect(cfg({ TOKEN_NAME: "someone-elses" }, {}).tokenName).toBe("auto");
  });

  // === 补池间隔与单轮最坏耗时的交叉校验（只 warn，不抛错） ===

  const ENABLED = { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k" };

  // console.* 已经被换成注入的 Logger（第 3 个可选参数）：下面全部改成 recordingLogger
  // 断言事件名 + fields，而不是 spy console 断言文案子串。

  it("TEND_INTERVAL_MS 小于 MINT_BATCH×CODE_TIMEOUT_MS 时启动期记 registrar.interval_shorter_than_worst_round（轮次会重叠）", () => {
    const logger = recordingLogger();
    const c = cfg(
      { ...ENABLED, TEND_INTERVAL_MS: "60000", MINT_BATCH: "5", CODE_TIMEOUT_MS: "120000" }, {}, logger,
    );
    expect(c.enabled).toBe(true); // 只是警告，配置照常生效
    const e = logger.entries.find((x) => x.event === "registrar.interval_shorter_than_worst_round");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    expect(e?.fields?.tendIntervalMs).toBe(60000);
    expect(e?.fields?.worstRoundMs).toBe(600000); // 算出来的单轮最坏耗时
  });

  it("TEND_INTERVAL_MS 足够大时不记该事件（成对用例，防止无条件告警）", () => {
    const logger = recordingLogger();
    registrarFromEnv({ ...ENABLED, TEND_INTERVAL_MS: "1800000", MINT_BATCH: "5", CODE_TIMEOUT_MS: "120000" }, {}, logger);
    expect(logger.has("registrar.interval_shorter_than_worst_round")).toBe(false);
  });

  it("轮级预算告警①：CODE_TIMEOUT_MS 超过 Worker 轮级预算时启动期记 registrar.attempt_exceeds_worker_budget（否则是永久静默停摆）", () => {
    // CODE_TIMEOUT_MS 无上界，而 Worker 的轮级预算是固定值。超过之后 tendOnce 连
    // 第一次尝试都不敢开始：attempted=0、minted=0、failures=[]，两个入口的归因日志
    // 走的是 `minted < attempted`（0<0 为假）一条都不打——用户只看到「本轮预算不足」，
    // 读起来像瞬时状况，实际每一轮都零产出。
    const logger = recordingLogger();
    // 800s > 780s 预算。TEND_INTERVAL_MS 给得足够大，避免上面那条重叠告警混进来。
    registrarFromEnv(
      { ...ENABLED, CODE_TIMEOUT_MS: "800000", MINT_BATCH: "1", TEND_INTERVAL_MS: "9000000" },
      {}, logger,
    );
    const e = logger.entries.find((x) => x.event === "registrar.attempt_exceeds_worker_budget");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    expect(e?.fields?.worstAttemptMs).toBe(800000);
    // 必须点明形态差异，否则 Node 用户会以为自己也中招。
    expect(e?.msg).toContain("Node/Docker");
  });

  it("轮级预算告警②：400s 不告警（400s < 780s 预算，与①成对）", () => {
    // 与①成对：没有它的话，一个「无条件告警」的实现照样能过①。
    // ⚠️ 这一对从前钉的是 `× 通道数` 那个因子（400s × 2 通道 = 800s）。
    // 两条通道改成二选一之后那个因子不存在了，判据改成钉阈值本身。
    const logger = recordingLogger();
    registrarFromEnv(
      { ...ENABLED, CODE_TIMEOUT_MS: "400000", MINT_BATCH: "1", TEND_INTERVAL_MS: "9000000" },
      {}, logger,
    );
    expect(logger.has("registrar.attempt_exceeds_worker_budget")).toBe(false);
  });

  it("注册机未启用时不做这项告警（关着的子系统不该刷屏）", () => {
    const logger = recordingLogger();
    registrarFromEnv({ TEND_INTERVAL_MS: "1000", MINT_BATCH: "5", CODE_TIMEOUT_MS: "120000" }, {}, logger);
    expect(logger.entries).toEqual([]);
  });
});

/**
 * **存量存储 / 环境变量里那两个旧的主备键：读得出来，而且丢掉的那条被点名说出来。**
 *
 * 这一族是整个改动里最容易撒谎的一栏：仓库已经发过 tag，线上存储里确实躺着
 * `{"registrar":{"primary":"yyds","fallback":"moemail"}}` 这种数据。静默丢弃
 * `fallback` 就是撒谎，而无条件提示又会常年顶着一条假通知 —— 两个方向都要钉住。
 */
describe("存量主备旧键的迁移", () => {
  const notices = (r: ReturnType<typeof registrarFromEnv>): string[] =>
    r.notices.map((n) => `${n.field}:${n.code}`).sort();

  it("旧键读得出来，注册机照常跑，而丢掉的那条被点名说出来", () => {
    const r = registrarFromEnv(
      { REGISTRAR_ENABLED: "true" },
      { primary: "yyds", fallback: "moemail", yyds: { baseUrl: "https://y.test", apiKey: "k" } } as never,
    );
    expect(r.config.channel).toBe("yyds");
    // **照常跑**：为一个已失去意义的旧键把一台正常运行的注册机拦停，是拿正确性换洁癖。
    expect(r.blockers).toEqual([]);
    expect(r.config.blocked).toBe(false);
    expect(notices(r)).toEqual([
      "registrar.channel:legacy_channel_key",
      "registrar.channel:legacy_fallback_ignored",
    ]);
    const dropped = r.notices.find((n) => n.code === "legacy_fallback_ignored");
    // **必须点名到具体通道**：一台主通道凭据早已失效、一直靠备通道铸 key 的部署，
    // 升级后产出会归零而面板每一格都显示「已配置」——这条点名是唯一的防线。
    expect(dropped?.params).toEqual({ dropped: "moemail", source: "stored" });
  });

  it("反向控制：没有 fallback 就一条 notice 都不许有", () => {
    // 没有它，上一条可以靠「无条件每次打一条」蒙混过关。
    const r = registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k" }, {},
    );
    expect(r.notices).toEqual([]);
  });

  it("反向控制：fallback 是空串等于没写（compose 里 `REGISTRAR_FALLBACK=` 极常见）", () => {
    expect(registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_FALLBACK: "" },
      { primary: "yyds", yyds: { baseUrl: "https://y.test", apiKey: "k" } } as never,
    ).notices.filter((n) => n.code === "legacy_fallback_ignored")).toEqual([]);
    expect(registrarFromEnv(
      { REGISTRAR_ENABLED: "true" },
      { primary: "yyds", fallback: "", yyds: { baseUrl: "https://y.test", apiKey: "k" } } as never,
    ).notices.filter((n) => n.code === "legacy_fallback_ignored")).toEqual([]);
  });

  it("fallback 与生效的通道相同时一条 notice 都不许产（那份配置从前就没生效过）", () => {
    // 它从前被「备通道等于主通道」那条 blocker 拦着、**一把 key 都没铸过**，
    // 说「丢弃了一条降级路径」是假话。
    const r = registrarFromEnv(
      { REGISTRAR_ENABLED: "true" },
      { primary: "yyds", fallback: "yyds", yyds: { baseUrl: "https://y.test", apiKey: "k" } } as never,
    );
    expect(notices(r)).toEqual(["registrar.channel:legacy_channel_key"]);
    expect(r.notices.filter((n) => n.code === "legacy_fallback_ignored")).toEqual([]);
  });

  it("旧的环境变量名仍然能用，但每次都要说一声（长期兼容，不设废弃期限）", () => {
    const r = registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", REGISTRAR_FALLBACK: "moemail", YYDS_API_KEY: "k" }, {},
    );
    expect(r.config.channel).toBe("yyds");
    expect(r.blockers).toEqual([]);
    expect(notices(r)).toEqual([
      "registrar.channel:legacy_channel_env",
      "registrar.channel:legacy_fallback_ignored",
    ]);
    expect(r.notices.find((n) => n.code === "legacy_fallback_ignored")?.params)
      .toEqual({ dropped: "moemail", source: "env" });
  });

  it("新名字在场时不报「用的是旧名字」（那句话会变成假话）", () => {
    const r = registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", REGISTRAR_PRIMARY: "moemail", YYDS_API_KEY: "k" }, {},
    );
    expect(r.config.channel).toBe("yyds");
    expect(r.notices).toEqual([]);
  });

  it("迁移通知走状态不走事件：同一份配置连装三次，注入的 logger 一条事件都收不到", () => {
    // 装载器每 30 秒刷一次 ⇒ 每 isolate 每天约 2880 次装载，而事件环只有 100 格。
    // 做成事件会在运维升级完来查问题的那一刻把诊断挤出去。钉的是这条行为，
    // 不是计数洁癖。
    const logger = recordingLogger();
    const env = { REGISTRAR_ENABLED: "true" };
    const stored = {
      primary: "yyds", fallback: "moemail", yyds: { baseUrl: "https://y.test", apiKey: "k" },
    } as never;
    for (let i = 0; i < 3; i++) {
      expect(registrarFromEnv(env, stored, logger).notices.length).toBeGreaterThan(0);
    }
    expect(logger.entries, `实际事件：${JSON.stringify(logger.events())}`).toEqual([]);
  });

  it("规整：`channel` 缺席时把 `primary` 抬上来，然后两个旧键都消失", () => {
    // 读路径与写路径共用这一份实现 —— 两处各写一份就是本仓反复裁过的「两份实现必漂」。
    const { next } = migrateStoredRegistrar({ primary: "yyds", fallback: "moemail", targetKeys: 7 });
    expect(next.channel).toBe("yyds");
    expect(Object.keys(next).sort()).toEqual(["channel", "targetKeys"]);
  });

  it("规整：`channel` 已经在了就不覆盖它，旧键照样清掉", () => {
    const { next } = migrateStoredRegistrar({ channel: "moemail", primary: "yyds", fallback: "yyds" });
    expect(next.channel).toBe("moemail");
    expect(Object.keys(next).sort()).toEqual(["channel"]);
  });
});

describe("requireChannel", () => {
  it("enabled 且 channel 合法时返回该通道", () => {
    const c = registrarFromEnv({ REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k" }, {}).config;
    expect(requireChannel(c)).toBe("yyds");
  });

  it("enabled=false 时抛错（即便 channel 字段因类型断言而非空）", () => {
    const c = registrarFromEnv({}, {}).config;
    expect(() => requireChannel(c)).toThrow();
  });

  it("enabled=true 但 channel 为 null 时抛错", () => {
    // ⚠️ **上一句原来写的是「registrarFromEnv 本身在 enabled 且通道为空时已经抛错」
    // ——那句今天是假的**：装载器全函数化之后它只产 `channel_required` blocker，
    // `config.channel` 照旧是 `null`。于是这颗**消费方护栏**第一次是真正必要的：
    // 它挡的是「某个消费者跳过了 enabled / blocked 两道 gate」这种代码 bug。
    // 这里仍然直接构造一个畸形 cfg，钉的是 requireChannel 自身的判空逻辑。
    const c = { enabled: true, channel: null } as unknown as Parameters<typeof requireChannel>[0];
    expect(() => requireChannel(c)).toThrow();
  });
});

describe("五语言文档对轮级预算的表述必须有条件、且与代码同步", () => {
  // 这个功能的立项理由就是「不接受用文档兜」，所以文档反过来把它写成无条件保证是
  // 特别有害的一种错：既掩盖了残余场景（预算判据不含单请求超时与 403 退避），
  // 也在公开仓里立了一个站不住的承诺（「邮箱一定被删掉」）。
  //
  // 每种语言各给一条**必须出现**的残余说明和一条**禁止出现**的无条件措辞，
  // 任何一种语言漏改都会红——五语言同步靠的就是这条，人工核对靠不住。
  const LANGS: Array<{ lang: string; must: string; banned: string }> = [
    { lang: "zh-CN", must: "残余场景仍然存在", banned: "不需要为此调参数" },
    { lang: "zh-TW", must: "殘餘場景仍然存在", banned: "不需要為此調參數" },
    { lang: "en", must: "a residual case remains", banned: "you do not need to tune anything" },
    { lang: "ja", must: "残るケースがあります", banned: "調整する必要はありません" },
    { lang: "ko", must: "남는 시나리오가 있습니다", banned: "조정할 필요가 없습니다" },
  ];

  it.each(LANGS)("$lang 写出了残余场景，且没有无条件保证的措辞", ({ lang, must, banned }) => {
    const doc = readFileSync(`docs/${lang}/REGISTRAR.md`, "utf8");
    expect(doc, `${lang} 缺少残余场景说明`).toContain(must);
    expect(doc, `${lang} 仍有无条件保证的措辞`).not.toContain(banned);
  });

  it("文档写的 87% 与代码里的预算/墙钟比例一致（改了常量就得改文档）", () => {
    // 五语言都拿 87% 这个数向用户解释余量从哪来。它是从两个常量算出来的，
    // 只调常量不改文档就会对不上——这条把它们钉在一起。
    const pct = Math.round((WORKER_ROUND_BUDGET_MS / WORKER_CRON_WALL_CLOCK_MS) * 100);
    expect(pct).toBe(87);
    for (const { lang } of LANGS) {
      expect(readFileSync(`docs/${lang}/REGISTRAR.md`, "utf8"), `${lang} 没写 ${pct}%`)
        .toContain(`${pct}%`);
    }
    // 只钉比例是不够的：按比例同改两个常量（例如 1560000/1800000）pct 仍是 87、
    // 全绿，而文档里「约 120 秒余量」会变成 240 秒且无人发觉。余量的**绝对值**才是
    // 五语言拿来解释「尾巴由谁吸收」的那个数，一并钉住。
    const marginMs = WORKER_CRON_WALL_CLOCK_MS - WORKER_ROUND_BUDGET_MS;
    expect(marginMs).toBe(120_000);
    for (const { lang } of LANGS) {
      expect(readFileSync(`docs/${lang}/REGISTRAR.md`, "utf8"), `${lang} 没写 ${marginMs / 1000} 秒余量`)
        .toContain(`${marginMs / 1000}`);
    }
  });

  it("启动那条是 warn 不是 error，且五语言给的可 grep 事件名与代码真实输出一致", () => {
    // 复评抓到的：五语言都写「启动时打印**错误**日志」，而代码用的是 warn 级别，
    // 且那条 error 是运行期每轮打的。级别和时机双双对不上，用户按文档去启动日志里
    // grep error 会一无所获。这条把文档给的锚点与代码真实输出钉在一起——改了事件名
    // 就必须同步改五语言，反之亦然。
    //
    // console.* 已经被换成注入的 Logger：spy console 只会看到空 mock，必须改成
    // recordingLogger 断言事件名 + 级别。五语言的可 grep 锚点也从「按中文文案 grep」
    // 改成「按事件名 grep」——英日韩用户此前永远搜不到中文片段（评审发现的遗留）。
    const logger = recordingLogger();
    registrarFromEnv(
      {
        REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds", YYDS_API_KEY: "k",
        CODE_TIMEOUT_MS: "800000", MINT_BATCH: "1", TEND_INTERVAL_MS: "9000000",
      },
      {}, logger,
    );
    const EVENT = "registrar.attempt_exceeds_worker_budget";
    const e = logger.entries.find((x) => x.event === EVENT);
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    // 启动期**不能**用 error：那会与「缺凭据启动即报错、网关起不来」混为一谈，
    // 而这里刻意选了不阻止启动（Node 侧同一份配置完全合法）。
    expect(e?.level).toBe("warn");
    expect(logger.entries.some((x) => x.level === "error")).toBe(false);
    for (const { lang } of LANGS) {
      const doc = readFileSync(`docs/${lang}/REGISTRAR.md`, "utf8");
      expect(doc, `${lang} 没给启动告警的可 grep 事件名`).toContain(EVENT);
      // 必须把两个级别都写出来，否则读者分不清哪条在启动、哪条在运行期。
      expect(doc, `${lang} 没区分 warn/error 两个级别`).toContain("console.warn");
      expect(doc, `${lang} 没区分 warn/error 两个级别`).toContain("console.error");
    }
  });
});
