import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { WORKER_CRON_WALL_CLOCK_MS, WORKER_ROUND_BUDGET_MS } from "../../../src/core/registrar/types.js";
import { registrarFromEnv, requirePrimary } from "../../../src/core/registrar/config.js";
import { recordingLogger } from "../../helpers/recording-logger.js";

describe("registrarFromEnv", () => {
  it("默认不启用", () => {
    expect(registrarFromEnv({}, {}).enabled).toBe(false);
  });

  it("默认值与设计文档一致", () => {
    const c = registrarFromEnv({}, {});
    expect(c.fallback).toBeNull();
    expect(c.targetKeys).toBe(20);
    expect(c.mintBatch).toBe(5);
    expect(c.tendIntervalMs).toBe(1_800_000);
    expect(c.codeTimeoutMs).toBe(120_000);
    expect(c.maxDomainAttempts).toBe(8);
  });

  it("启用但没指定主通道时抛错（两条通道平级，不预设默认）", () => {
    expect(() => registrarFromEnv({ REGISTRAR_ENABLED: "true" }, {}))
      .toThrow(/REGISTRAR_PRIMARY/);
  });

  it("启用但主通道凭据缺失时抛错并指明缺项", () => {
    expect(() => registrarFromEnv({ REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds" }, {}))
      .toThrow(/YYDS_API_KEY/);
  });

  it("启用且凭据齐备时通过", () => {
    const c = registrarFromEnv({ REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" }, {});
    expect(c.enabled).toBe(true);
    expect(c.yyds).toEqual({ baseUrl: "https://maliapi.215.im", apiKey: "k" });
  });

  it("配了备通道则备通道凭据也必须齐备", () => {
    expect(() => registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k", REGISTRAR_FALLBACK: "moemail" }, {},
    )).toThrow(/MOEMAIL/);
  });

  it("M5 yyds 作**备**通道时 YYDS_API_KEY 同样必填（不是「主通道才要」）", () => {
    // 与上一条镜像：上一条只覆盖了 moemail 作备通道，yyds 那一半零覆盖，而
    // .env.example 的错误注释（「主通道启用时必填」）正是把用户往这个配置上引——
    // 结果 Node 进程 process.exit(1)、Worker 全部请求 500，整个网关的转发能力被
    // 一个备通道凭据打掉。两条方向都钉住，才算守住「两条通道一视同仁」。
    expect(() => registrarFromEnv(
      {
        REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "moemail",
        MOEMAIL_BASE_URL: "https://m.test", MOEMAIL_API_KEY: "mk",
        REGISTRAR_FALLBACK: "yyds",
      },
      {},
    )).toThrow(/YYDS_API_KEY/);
  });

  it("M5 .env.example 的凭据注释按「主通道或备通道任一」措辞，两条通道对称", () => {
    // .env.example 是用户复制来改的那份文件，它的措辞就是这条约束对外的唯一说明；
    // 上面那条断言的是代码行为，这条断言的是文档不与代码矛盾。
    const env = readFileSync(".env.example", "utf8");
    expect(env).toContain("# YYDS Mail 凭据（主通道或备通道任一为 yyds 时必填）");
    expect(env).toContain("主通道或备通道任一为 moemail 时两项都必填");
    // 旧措辞会让用户以为备通道凭据可以不填。
    expect(env).not.toContain("（主通道启用时必填）");
  });

  it("MoeMail 作主通道时同时要 base url 与 key（自建服务无默认地址）", () => {
    expect(() => registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "moemail", MOEMAIL_API_KEY: "k" }, {},
    )).toThrow(/MOEMAIL_BASE_URL/);
  });

  it("环境变量优先于存储", () => {
    const c = registrarFromEnv({ TARGET_KEYS: "7" }, { targetKeys: 30 });
    expect(c.targetKeys).toBe(7);
  });

  it("存储值在环境变量缺失时生效", () => {
    expect(registrarFromEnv({}, { targetKeys: 30 }).targetKeys).toBe(30);
  });

  it("数值非法时抛错而不是静默取 NaN", () => {
    expect(() => registrarFromEnv({ TARGET_KEYS: "abc" }, {})).toThrow(/TARGET_KEYS/);
    expect(() => registrarFromEnv({ MINT_BATCH: "0" }, {})).toThrow(/MINT_BATCH/);
    expect(() => registrarFromEnv({}, { targetKeys: -1 })).toThrow(/targetKeys/);
  });

  // P1 遗留：配置校验此前只覆盖环境变量层，没覆盖存储层。primary/fallback 是决定
  // 走哪条代码分支的枚举值，若存储里的垃圾值能绕过校验静默流入，下游按通道分支的
  // 代码（例如选哪个 MailProvider 适配器）会拿到既不是 yyds 也不是 moemail 的值。
  // 通道格式校验现在受 enabled 门控（见下面"未启用时…只 warn"的用例），故这里要
  // 显式启用注册机，才能真正打在"启用时格式非法必须抛错"这条分支上。
  it("启用时存储中的 primary 非法值抛错，不能绕过校验静默流入", () => {
    expect(() => registrarFromEnv({ REGISTRAR_ENABLED: "true" }, { primary: "garbage" as never }))
      .toThrow(/primary/);
  });

  it("启用时存储中的 fallback 非法值抛错，不能绕过校验静默流入", () => {
    expect(() => registrarFromEnv({ REGISTRAR_ENABLED: "true" }, { fallback: "garbage" as never }))
      .toThrow(/fallback/);
  });

  // 注册机关闭时，一个用不到的字段不该让整个网关起不来（例如 P3 面板写入 bug、
  // 手工改存储、跨版本迁移遗留）。只留痕，不阻断启动。
  it("未启用时存储中通道格式脏数据只记事件不抛错，网关仍能正常启动", () => {
    // console.* 已经被换成注入的 Logger（第 3 个可选参数）：spy console 只会看到空
    // mock，必须改成 recordingLogger 断言事件名。
    const logger = recordingLogger();
    let cfg: ReturnType<typeof registrarFromEnv> | undefined;
    expect(() => {
      cfg = registrarFromEnv({}, { primary: "garbage" as never, fallback: "trash" as never }, logger);
    }).not.toThrow();
    expect(cfg!.enabled).toBe(false);
    expect(logger.has("registrar.config_ignored")).toBe(true);
  });

  it("主备通道相同时抛错（降级到自己没有意义）", () => {
    expect(() => registrarFromEnv(
      { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k", REGISTRAR_FALLBACK: "yyds" }, {},
    )).toThrow(/相同/);
  });

  // 回归用例：主备相同的校验此前没有像"启用但未指定主通道"那条一样受 enabled
  // 门控，导致运维在真正打开注册机之前先把两个通道变量摆成同一个值（例如照抄
  // 文档示例、提前布置环境变量）就会让 registrarFromEnv 抛错——而这个函数是
  // loadConfig()/buildApp() 内部调用链的一环，两个入口都会经过它，于是关闭状态
  // 下的一条注册机专属校验会把整个网关的启动都拖垮。
  it("未启用时主备通道相同不抛错，网关能正常构建（关闭状态不该受注册机专属校验拖累）", () => {
    expect(() => registrarFromEnv(
      { REGISTRAR_PRIMARY: "yyds", REGISTRAR_FALLBACK: "yyds" }, {},
    )).not.toThrow();
    const c = registrarFromEnv({ REGISTRAR_PRIMARY: "yyds", REGISTRAR_FALLBACK: "yyds" }, {});
    expect(c.enabled).toBe(false);
  });

  it("未启用时不校验凭据（关着就不该因为没配 key 而启动失败）", () => {
    // 关键：REGISTRAR_PRIMARY 已指定但对应凭据缺失——原始测试只传了
    // { REGISTRAR_ENABLED: "false" }，此时 primary 本来就是 null，凭据校验循环
    // 天然不会跑到，删掉"未启用时跳过校验"的分支这条测试也照样通过（验证过：
    // 真的删掉代码里的 `if (!enabled) return cfg;` 后 12 个测试仍全绿）。
    // 必须让 primary 有值、凭据没给，才能真正打在"关闭时跳过凭据校验"这条分支上。
    expect(() => registrarFromEnv(
      { REGISTRAR_ENABLED: "false", REGISTRAR_PRIMARY: "yyds" }, {},
    )).not.toThrow();
  });

  it("mintDelayMinMs 大于 mintDelayMaxMs 时抛错并点名两个环境变量", () => {
    expect(() => registrarFromEnv({ MINT_DELAY_MIN_MS: "9000", MINT_DELAY_MAX_MS: "3000" }, {}))
      .toThrow(/MINT_DELAY_MIN_MS/);
    expect(() => registrarFromEnv({ MINT_DELAY_MIN_MS: "9000", MINT_DELAY_MAX_MS: "3000" }, {}))
      .toThrow(/MINT_DELAY_MAX_MS/);
  });

  it("mintDelayMinMs 等于 mintDelayMaxMs 时不抛错（固定延迟是合法配置）", () => {
    const c = registrarFromEnv({ MINT_DELAY_MIN_MS: "3000", MINT_DELAY_MAX_MS: "3000" }, {});
    expect(c.mintDelayMinMs).toBe(3000);
    expect(c.mintDelayMaxMs).toBe(3000);
  });

  it("tokenName 读的是 REGISTRAR_TOKEN_NAME（无前缀的 TOKEN_NAME 在容器里太容易撞车）", () => {
    expect(registrarFromEnv({ REGISTRAR_TOKEN_NAME: "mine" }, {}).tokenName).toBe("mine");
    // 无前缀的旧名字不再被读取——否则编排层里别的组件设的 TOKEN_NAME 会静默生效。
    expect(registrarFromEnv({ TOKEN_NAME: "someone-elses" }, {}).tokenName).toBe("auto");
  });

  // === C4：补池间隔与单轮最坏耗时的交叉校验（只 warn，不抛错） ===

  const ENABLED = { REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" };

  // console.* 已经被换成注入的 Logger（第 3 个可选参数）：下面全部改成 recordingLogger
  // 断言事件名 + fields，而不是 spy console 断言文案子串。

  it("TEND_INTERVAL_MS 小于 MINT_BATCH×CODE_TIMEOUT_MS 时启动期记 registrar.interval_shorter_than_worst_round（轮次会重叠）", () => {
    const logger = recordingLogger();
    const c = registrarFromEnv(
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

  it("配了备通道时单轮最坏耗时按两条通道算（code_timeout 会降级重试一次）", () => {
    // M1 之后 code_timeout 属于通道级失败，配了备通道时同一个补池名额最坏要等
    // 两次 CODE_TIMEOUT_MS。墙钟模型跟着变，这条告警的阈值必须同步，否则用户按
    // 「没告警＝安全」调参会直接撞上轮次重叠。
    const logger = recordingLogger();
    // 700000 > 5×120000 = 600000（单通道不告警），< 5×120000×2 = 1200000（双通道要告警）。
    // 阈值取在两个模型之间，旧模型下这条必红。
    registrarFromEnv(
      {
        ...ENABLED, REGISTRAR_FALLBACK: "moemail",
        MOEMAIL_BASE_URL: "https://m.test", MOEMAIL_API_KEY: "mk",
        TEND_INTERVAL_MS: "700000", MINT_BATCH: "5", CODE_TIMEOUT_MS: "120000",
      },
      {}, logger,
    );
    const e = logger.entries.find((x) => x.event === "registrar.interval_shorter_than_worst_round");
    expect(e).toBeDefined();
    expect(e?.fields?.worstRoundMs).toBe(1200000);
  });

  it("同样的 700000 在单通道下不告警（成对用例，锁住通道数这个因子）", () => {
    const logger = recordingLogger();
    registrarFromEnv(
      { ...ENABLED, TEND_INTERVAL_MS: "700000", MINT_BATCH: "5", CODE_TIMEOUT_MS: "120000" }, {}, logger,
    );
    expect(logger.has("registrar.interval_shorter_than_worst_round")).toBe(false);
  });

  it("I-1 CODE_TIMEOUT_MS×通道数 超过 Worker 轮级预算时启动期记 registrar.attempt_exceeds_worker_budget（否则是永久静默停摆）", () => {
    // CODE_TIMEOUT_MS 无上界，而 Worker 的轮级预算是固定值。超过之后 tendOnce 连
    // 第一次尝试都不敢开始：attempted=0、minted=0、failures=[]，两个入口的归因日志
    // 走的是 `minted < attempted`（0<0 为假）一条都不打——用户只看到「本轮预算不足」，
    // 读起来像瞬时状况，实际每一轮都零产出。
    const logger = recordingLogger();
    // 400s × 2 通道 = 800s > 780s 预算。TEND_INTERVAL_MS 给得足够大，避免上面那条
    // 重叠告警混进来——这条断言要能确定命中的是新加的这一条。
    registrarFromEnv(
      {
        ...ENABLED, REGISTRAR_FALLBACK: "moemail",
        MOEMAIL_BASE_URL: "https://m.test", MOEMAIL_API_KEY: "mk",
        CODE_TIMEOUT_MS: "400000", MINT_BATCH: "1", TEND_INTERVAL_MS: "9000000",
      },
      {}, logger,
    );
    const e = logger.entries.find((x) => x.event === "registrar.attempt_exceeds_worker_budget");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    expect(e?.fields?.worstAttemptMs).toBe(800000);
    // 必须点明形态差异，否则 Node 用户会以为自己也中招。
    expect(e?.msg).toContain("Node/Docker");
  });

  it("I-1 同样的 400s 在单通道下不告警（400s < 780s 预算，成对用例）", () => {
    // 与上一条唯一的差别是没有备通道：`× 通道数` 这个因子被真正求值了才能同时通过
    // 这两条。若实现漏乘通道数，上一条就不会触发。
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

describe("requirePrimary", () => {
  it("enabled 且 primary 合法时返回该通道", () => {
    const cfg = registrarFromEnv({ REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" }, {});
    expect(requirePrimary(cfg)).toBe("yyds");
  });

  it("enabled=false 时抛错（即便 primary 字段因类型断言而非空）", () => {
    const cfg = registrarFromEnv({}, {});
    expect(() => requirePrimary(cfg)).toThrow();
  });

  it("enabled=true 但 primary 为 null 时抛错", () => {
    // registrarFromEnv 本身在 enabled 且 primary 为空时已经抛错，这里直接构造
    // 一个"绕过 registrarFromEnv"的畸形 cfg 来验证 requirePrimary 自身的判空逻辑，
    // 不依赖上游是否也会拦截。
    const cfg = { enabled: true, primary: null } as unknown as Parameters<typeof requirePrimary>[0];
    expect(() => requirePrimary(cfg)).toThrow();
  });
});

describe("I-2 五语言文档对轮级预算的表述必须有条件、且与代码同步", () => {
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
    // 改成「按事件名 grep」——英日韩用户此前永远搜不到中文片段（P2 M-5 遗留）。
    const logger = recordingLogger();
    registrarFromEnv(
      {
        REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k",
        REGISTRAR_FALLBACK: "moemail",
        MOEMAIL_BASE_URL: "https://m.test", MOEMAIL_API_KEY: "mk",
        CODE_TIMEOUT_MS: "400000", MINT_BATCH: "1", TEND_INTERVAL_MS: "9000000",
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
