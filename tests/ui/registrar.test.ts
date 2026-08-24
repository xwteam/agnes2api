import { describe, it, expect } from "vitest";
import {
  CHANNELS, channelLabelKey, channelAddressFactKey, channelRoleKey,
  failureReasonKey, refuseReasonKey, refuseKeyOf,
  statusView, channelCards, poolView, tendCost, manualQuotaView,
  historyRows, historyMalformed, roundOutcome, roundFailures, mintedByChannelText,
  channelTestResult,
} from "../../admin-ui/js/pure/registrar.mjs";
import { TEND_FAILURE_REASONS, type TendFailureReason } from "../../src/core/registrar/tender.js";
import { I18N } from "../../admin-ui/js/i18n-dict.js";

/**
 * 注册机板块的取值决策（`admin-ui/js/pure/registrar.mjs`）。
 * admin-ui/README.md 硬规则 1：需要测试的逻辑必须落在 `js/pure/`，板块文件里
 * 只剩 DOM 拼装与网络调用。
 */

// ───────────────────────────────────────────────────────────────────────────
// 失败归因的穷尽性（设计 §7.3）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ **这张表就是计划 M1 要的那个「编译期穷尽检查」，它只能长在这里。**
 *
 * 计划写的是「失败归因渲染从 `switch` + `never` 改成 `default: return "未知"` ⇒
 * `tsc` 应当报错」。**在 `admin-ui/js/pure/registrar.mjs` 里做不到**：那是
 * JavaScript，而 `tsconfig.json` 只开了 `allowJs`、**没有开 `checkJs`**
 *（那一行旁边写着理由：「那些 .mjs 由 tests/ui 的行为断言守着，不做类型检查」）
 * ⇒ 无论那个 `switch` 怎么写，`tsc --noEmit` 都不会看它一眼。
 *
 * **`Record<TendFailureReason, string>` 把穷尽性搬到了唯一能承载它的地方**：
 * 这个文件在 `tsconfig.json` 的 `include` 里，`TendFailureReason` 多一个成员时
 * **`tsc` 当场在这张表上报错**（与 `router.ts` 的 `REJECT_MESSAGE`、
 * `tend-history.ts` 的 `FIELD_CHECKS` 是同一招）。
 *
 * **十二行全是手写字面量，不从 `TEND_FAILURE_REASONS` 拼出来**：从被测对象自己
 * 推导出来的期望值恒等于实际值（本仓登记的第 6 种假阳性）。
 */
const EXPECTED_FAILURE_KEY: Record<TendFailureReason, string> = {
  domain_blocked_all: "reg.fail.domain_blocked_all",
  upstream_error: "reg.fail.upstream_error",
  code_timeout: "reg.fail.code_timeout",
  register_failed: "reg.fail.register_failed",
  login_failed: "reg.fail.login_failed",
  key_failed: "reg.fail.key_failed",
  provider_error: "reg.fail.provider_error",
  network_error: "reg.fail.network_error",
  rate_limited: "reg.fail.rate_limited",
  provider_missing: "reg.fail.provider_missing",
  round_crashed: "reg.fail.round_crashed",
  key_suspicious: "reg.fail.key_suspicious",
};

describe("failureReasonKey：补池失败归因的穷尽渲染", () => {
  it("失败归因表就是 TEND_FAILURE_REASONS 那一份——加了第 13 个成员，这一格会 tsc 报错", () => {
    // 运行期这一半：手写表的成员集合必须与联合类型的运行期表**双向一致**。
    // 编译期那一半由上面 `Record<TendFailureReason, string>` 承担（少一行就 tsc 红）。
    expect(Object.keys(EXPECTED_FAILURE_KEY).sort()).toEqual([...TEND_FAILURE_REASONS].sort());
  });

  it("十二个成员各自渲染成自己那条 reg.fail.* 键", () => {
    for (const [reason, key] of Object.entries(EXPECTED_FAILURE_KEY)) {
      expect(failureReasonKey(reason), reason).toBe(key);
    }
  });

  it("每条 reg.fail.* 键都真的在字典里——渲染出一个字典里没有的 key 等于把 key 本身显示给运维", () => {
    for (const key of Object.values(EXPECTED_FAILURE_KEY)) {
      expect(key in I18N, `${key} 不在字典里`).toBe(true);
    }
  });

  /**
   * ⚠️ **表外的 reason 返回 `null` 而不是一句写死的「未知」。**
   * `null` 让调用方有机会把那个 reason **原样显示出来**
   *（`reg.fail.unknownReason` 带 `{reason}` 占位符），而一句写死的「未知」
   * 会把一条本来能被运维 grep 到的线索抹掉。
   */
  it("表外的 reason 返回 null，不冒充任何一档已知归因", () => {
    expect(failureReasonKey("something_new_from_the_future")).toBeNull();
    expect(failureReasonKey("")).toBeNull();
    expect(failureReasonKey(null)).toBeNull();
    expect(failureReasonKey(undefined)).toBeNull();
    expect(failureReasonKey(42)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 后端拒绝原因（状态码不是判据）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 后端**顶层 `reason`** 的完整清单，手写。
 *
 * ⚠️ **同一个状态码下的几种必须映射到不同的文案 key**——这正是这张表存在的理由：
 * `409` 有三种（`tend_in_flight` / `locked` / `registrar_disabled`）、
 * `429` 有两种（`manual_cooldown` / `write_budget_exhausted`），
 * 拿状态码选文案的前端会把「另一个副本在跑」和「注册机压根没开」说成同一句话。
 */
const EXPECTED_REFUSE_KEY: ReadonlyArray<readonly [string, string]> = [
  ["tend_in_flight", "reg.refuse.tend_in_flight"],
  ["locked", "reg.refuse.locked"],
  ["registrar_disabled", "reg.refuse.registrar_disabled"],
  ["write_budget_exhausted", "reg.refuse.write_budget_exhausted"],
  ["manual_cooldown", "reg.refuse.manual_cooldown"],
  ["not_wired", "reg.refuse.not_wired"],
  ["unknown_channel", "reg.refuse.unknown_channel"],
  ["channel_not_configured", "reg.refuse.channel_not_configured"],
  // ── P3d Task 8：出站探测护栏的两种 ────────────────────────────────────────
  //
  // ⚠️ **这两条是「后端加了拒绝原因、前端没跟上」的真实形态**：Task 8 给通道测试
  // 上了护栏（此前连点必成功），而这张表当时**没有跟着加**⇒ `refuseReasonKey`
  // 返回 `null` ⇒ `sec-registrar.js` 退回通用的 `reg.channel.testError`
  // ⇒ **「刚测过，隔几秒再来」与「这条通道真的连不上」在面板上一模一样**，
  // 而运维恰恰会在一次失败之后立刻重试，也就是必然撞上这一格。
  ["probe_in_flight", "reg.refuse.probe_in_flight"],
  ["probe_cooldown", "reg.refuse.probe_cooldown"],
];

describe("refuseReasonKey：拒绝原因 → 文案（状态码不是判据）", () => {
  it("每一种 reason 各自一条键，且每条都真的在字典里", () => {
    for (const [reason, key] of EXPECTED_REFUSE_KEY) {
      expect(refuseReasonKey(reason), reason).toBe(key);
      expect(key in I18N, `${key} 不在字典里`).toBe(true);
    }
    // 手写字面量的规模锚：这张表短一条**不会**让上面那个循环变红（它只遍历表自己），
    // 只有这一条能拦住「悄悄把某一种从表里删掉」。
    expect(EXPECTED_REFUSE_KEY.length, "拒绝原因表被改过，请在评审里确认这是有意的").toBe(10);
  });

  it("同一个状态码下的几种映射到互不相同的键 —— 三种 409、四种 429 不许说成同一句话", () => {
    const conflict = ["tend_in_flight", "locked", "registrar_disabled"].map(refuseReasonKey);
    expect(new Set(conflict).size, "三种 409 里有两种共用了同一句文案").toBe(3);
    // ⚠️ **429 从两种变成四种了**（P3d Task 8 加了护栏那两种）。
    // 「今天的额度用完了」「再等几分钟」「上一次还在飞」「刚探过」——四种处置各不相同，
    // 而它们的状态码**一模一样**。这正是「状态码不是判据」这条规矩的最强证据。
    const rateLimited = ["manual_cooldown", "write_budget_exhausted", "probe_in_flight", "probe_cooldown"]
      .map(refuseReasonKey);
    expect(new Set(rateLimited).size, "四种 429 里有两种共用了同一句文案").toBe(4);
  });

  it("表外的 reason 返回 null，调用方退回一句通用文案而不是猜一个", () => {
    expect(refuseReasonKey("must_disable_first")).toBeNull();
    expect(refuseReasonKey(undefined)).toBeNull();
  });

  it("refuseKeyOf：从错误响应体里取 reason；取不到就是 null", () => {
    expect(refuseKeyOf({ reason: "locked", until: 1 })).toBe("reg.refuse.locked");
    expect(refuseKeyOf({ error: { message: "x" } })).toBeNull();
    expect(refuseKeyOf(null)).toBeNull();
    expect(refuseKeyOf(undefined)).toBeNull();
    expect(refuseKeyOf("locked"), "响应体是个字符串时不许当成对象去取").toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 设计 §10.3 的八条平级规则里，结构性的那几条
// ───────────────────────────────────────────────────────────────────────────

describe("两条通道完全平级（设计 §10.3）", () => {
  /**
   * **第 3 条：顺序固定为字母序。**
   * 期望值手写成两个字面量，**不写成 `[...CHANNELS].sort()`**——那是从被测对象
   * 自己推导期望值，把顺序改成任何东西它都恒绿。
   */
  it("第 3 条：通道顺序恒为 moemail, yyds（字母序，唯一可辩护的中立规则）", () => {
    expect(CHANNELS).toEqual(["moemail", "yyds"]);
  });

  it("第 3 条的反面：顺序不是从响应体里读的 —— 后端换个键序也不影响面板", () => {
    const cards = channelCards({ channels: { yyds: { configured: true, role: "primary" }, moemail: { configured: false, role: null } } });
    expect(cards.map((c) => c.channel), "顺序跟着响应体的键序跑了").toEqual(["moemail", "yyds"]);
  });

  it("两条通道的标签键与地址事实键各自独立，两两不相等", () => {
    expect(channelLabelKey("moemail")).toBe("reg.channel.moemail");
    expect(channelLabelKey("yyds")).toBe("reg.channel.yyds");
    expect(channelAddressFactKey("moemail")).toBe("reg.channel.addressFact.moemail");
    expect(channelAddressFactKey("yyds")).toBe("reg.channel.addressFact.yyds");
    for (const key of ["reg.channel.moemail", "reg.channel.yyds",
      "reg.channel.addressFact.moemail", "reg.channel.addressFact.yyds"]) {
      expect(key in I18N, `${key} 不在字典里`).toBe(true);
    }
  });

  /**
   * **第 5 条：唯一的不对称必须标为事实而非偏好。**
   *
   * ⚠️⚠️ **这一格只能钉住「没有出现某些具体的词」，钉不住「这句话是事实不是偏好」。**
   * 「两条里挑一条的话就用 X」这种不含任何禁用词的偏好表述，任何词面匹配都抓不住
   *（`tests/unit/i18n-dict.test.ts` 的「通道相关命名空间不出现任何偏好词（含繁体变体）」
   *  那一格自己也明写了这条边界；⚠️ **那一格的作用域在 P3e Task 7 从「只有 `reg.*`」
   *  扩到了设置页那几个通道前缀，用例名跟着改过**——边界那句话没变）。
   * ⇒ **第 5 条如实登记为人工勾选项**，下面这一格是它的下界，不是它本身。
   *
   * 这里额外挡住的是**这次真的差点写出来的那一句**：设计 §10.3 第 5 条给的原句
   * 「本就不存在**默认**地址」自己就踩了第 4 条的禁用词表。
   */
  it("第 5 条的下界：地址事实那两句里不出现「开箱即用」这类偏好措辞（是不是事实仍要人工勾选）", () => {
    const banned = ["开箱即用", "更好", "更省事", "out of the box", "easier", "better"];
    for (const channel of CHANNELS) {
      const row = I18N[channelAddressFactKey(channel)] as Record<string, string>;
      for (const [lang, text] of Object.entries(row)) {
        for (const word of banned) {
          expect(text.toLowerCase().includes(word.toLowerCase()), `${channel}/${lang} 出现了「${word}」`).toBe(false);
        }
      }
    }
  });

  it("角色：主 / 备 / 没用到，三档各有一句如实的文案（没用到那档不许留空）", () => {
    expect(channelRoleKey("primary")).toBe("reg.role.primary");
    expect(channelRoleKey("fallback")).toBe("reg.role.fallback");
    expect(channelRoleKey(null)).toBe("reg.role.unused");
    expect(channelRoleKey("something-else")).toBe("reg.role.unused");
  });

  it("channelCards：读不出来时 configured 是 null 而不是 false —— 「没配」与「没读到」是两句话", () => {
    const cards = channelCards(null);
    expect(cards.map((c) => c.channel)).toEqual(["moemail", "yyds"]);
    expect(cards.every((c) => c.configured === null && c.role === null)).toBe(true);

    const broken = channelCards({ channels: { moemail: { configured: "yes" }, yyds: 42 } });
    expect(broken.every((c) => c.configured === null)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 取数与降级
// ───────────────────────────────────────────────────────────────────────────

describe("statusView / poolView：逐字段降级，绝不伪造", () => {
  it("整段读不到时逐字段 null", () => {
    expect(statusView(null)).toEqual({ enabled: null, primary: null, fallback: null, serverTime: null, lockedUntil: null });
    expect(poolView(null)).toEqual({ target: null, counted: null, gap: null, fresh: null, mintBatch: null });
  });

  it("「注册机关着」（enabled:false）与「没读到」（null）分得开", () => {
    expect(statusView({ enabled: false }).enabled).toBe(false);
    expect(statusView({}).enabled).toBeNull();
    expect(statusView({ enabled: "false" }).enabled, "字符串不当成布尔").toBeNull();
  });

  it("pool 那块整个是 null 时逐格 null，不退化成 0", () => {
    expect(poolView({ pool: null }).counted).toBeNull();
    expect(poolView({ pool: { counted: 0, target: 4, gap: 4, fresh: 0, mintBatch: 5 } })).toEqual({
      target: 4, counted: 0, gap: 4, fresh: 0, mintBatch: 5,
    });
  });
});

describe("tendCost：确认弹窗要明示的消耗（设计 §10.2 第 3 条护栏）", () => {
  it("算式与 tendOnce 逐字相同：min(gap, mintBatch)，两个数字相等", () => {
    expect(tendCost({ pool: { gap: 9, mintBatch: 5 } })).toEqual({ keys: 5, mailboxes: 5 });
    expect(tendCost({ pool: { gap: 2, mintBatch: 5 } })).toEqual({ keys: 2, mailboxes: 2 });
  });

  it("池子已满时是 0 —— 那句话是真的（这一次不会铸任何 key）", () => {
    expect(tendCost({ pool: { gap: 0, mintBatch: 5 } })).toEqual({ keys: 0, mailboxes: 0 });
  });

  it("读不出来时返回 null，让弹窗说「说不准」而不是伪造一个 0", () => {
    expect(tendCost(null)).toBeNull();
    expect(tendCost({ pool: { gap: 3 } }), "缺 mintBatch 一样算不出来").toBeNull();
    expect(tendCost({ pool: { mintBatch: 3 } })).toBeNull();
  });
});

describe("manualQuotaView：还剩几次 / 什么时候能再点", () => {
  it("成对取绝对时刻与相对时长 —— 面板绝不拿本地时钟去减服务端时刻", () => {
    expect(manualQuotaView({
      manual: { used: 5, remaining: 19, perDay: 24, resetAt: 1700, cooldownUntil: 900, retryAfterMs: 400 },
    })).toEqual({ remaining: 19, perDay: 24, resetAt: 1700, cooldownUntil: 900, retryAfterMs: 400 });
  });

  it("不在冷却中时两个时间字段都是 null（不是一个已经过去的时刻）", () => {
    const q = manualQuotaView({ manual: { remaining: 24, perDay: 24, resetAt: 1700, cooldownUntil: null, retryAfterMs: null } });
    expect(q.cooldownUntil).toBeNull();
    expect(q.retryAfterMs).toBeNull();
  });

  it("整块读不到时 remaining 是 null 而不是 0 —— 「还剩 0 次」是一句会让人放弃点击的假话", () => {
    expect(manualQuotaView(null).remaining).toBeNull();
    expect(manualQuotaView({ manual: null }).remaining).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 补池历史
// ───────────────────────────────────────────────────────────────────────────

const round = (over: Record<string, unknown> = {}) => ({
  skipped: false, available: 3, attempted: 2, minted: 2, mintedByChannel: { yyds: 2 },
  failures: [], at: 1000, primaryChannel: "yyds", durationMs: 1200, trigger: "cron",
  ...over,
});

describe("historyRows：最新的排在最前面", () => {
  it("后端是环形追加（最新在末尾），面板倒着看", () => {
    const body = { history: { entries: [round({ at: 1 }), round({ at: 2 }), round({ at: 3 })], malformed: 0 } };
    expect(historyRows(body).map((r: { at: number }) => r.at)).toEqual([3, 2, 1]);
  });

  it("不就地改原数组 —— 同一份响应体渲染两次不许得到两种顺序", () => {
    const entries = [round({ at: 1 }), round({ at: 2 })];
    const body = { history: { entries, malformed: 0 } };
    const ats = () => historyRows(body).map((r: { at: number }) => r.at);
    expect(ats()).toEqual([2, 1]);
    expect(entries.map((r) => r.at), "原数组被 reverse() 就地改掉了").toEqual([1, 2]);
    expect(ats(), "第二次渲染得到了另一种顺序 —— 说明第一次就地改了原数组").toEqual([2, 1]);
  });

  it("整块读不到 / 形状不对时是空列表，不抛异常", () => {
    expect(historyRows(null)).toEqual([]);
    expect(historyRows({ history: null })).toEqual([]);
    expect(historyRows({ history: { entries: "nope" } })).toEqual([]);
  });

  it("malformed：0 与「没读到」分得开", () => {
    expect(historyMalformed({ history: { entries: [], malformed: 0 } })).toBe(0);
    expect(historyMalformed({ history: { entries: [], malformed: 2 } })).toBe(2);
    expect(historyMalformed({ history: null }), "整块没读到是 null，不是 0").toBeNull();
    expect(historyMalformed(null)).toBeNull();
  });
});

describe("roundOutcome：四种形态靠 skipped + attempted + failures 三个字段合读", () => {
  it("skipped:true —— 注册机当时关着", () => {
    expect(roundOutcome(round({ skipped: true, attempted: 0, minted: 0 })).key).toBe("reg.row.skipped");
  });

  it("健康轮：跑了、但缺口是 0，一次尝试都不需要", () => {
    expect(roundOutcome(round({ attempted: 0, minted: 0, failures: [] })).key).toBe("reg.row.healthy");
  });

  /**
   * ⚠️ **崩掉的那一轮不许渲染成「铸出 0 / 尝试 0」。**
   * 那句话读起来像「跑完了但没产出」，而它其实是「根本没跑起来」——两者的
   * 排查方向完全不同（前者查上游，后者查配置与墙钟预算）。
   */
  it("整轮抛错：attempted 是 0 但 failures 非空 —— 说「一次尝试都没开始」，不说「铸出 0/0」", () => {
    const crashed = round({
      skipped: false, attempted: 0, minted: 0, mintedByChannel: {},
      failures: [{ reason: "round_crashed", channel: "yyds" }],
    });
    expect(roundOutcome(crashed).key).toBe("reg.row.noAttempt");
    expect(roundOutcome(crashed).key, "与健康轮撞成同一句话了").not.toBe("reg.row.healthy");
  });

  it("正常轮：铸出 N / 尝试 M", () => {
    const r = roundOutcome(round({ attempted: 3, minted: 1 }));
    expect(r.key).toBe("reg.row.minted");
    expect(r.params).toEqual({ minted: 1, attempted: 3 });
  });

  it("整行读不得时如实说读不得，不抛异常也不冒充任何一档", () => {
    expect(roundOutcome(null).key).toBe("reg.row.unreadable");
    expect(roundOutcome("nope").key).toBe("reg.row.unreadable");
  });

  it("四种形态的文案键两两不同，且都在字典里", () => {
    const keys = ["reg.row.skipped", "reg.row.healthy", "reg.row.noAttempt", "reg.row.minted", "reg.row.unreadable"];
    expect(new Set(keys).size).toBe(5);
    for (const k of keys) expect(k in I18N, `${k} 不在字典里`).toBe(true);
  });
});

describe("roundFailures / mintedByChannelText", () => {
  it("表外的 reason 不丢掉：key 是 null，reason 原样带出来给调用方显示", () => {
    const list = roundFailures(round({
      failures: [{ reason: "code_timeout", channel: "yyds" }, { reason: "from_the_future", channel: "moemail" }],
    }));
    expect(list).toEqual([
      { reason: "code_timeout", channel: "yyds", key: "reg.fail.code_timeout" },
      { reason: "from_the_future", channel: "moemail", key: null },
    ]);
  });

  it("failures 不是数组时是空列表，不抛异常", () => {
    expect(roundFailures(round({ failures: null }))).toEqual([]);
    expect(roundFailures(null)).toEqual([]);
  });

  /**
   * ⚠️⚠️ **这一格是「两条通道完全平级」在补池历史上的落点**（`TendResult.mintedByChannel`
   * 上那段评审 I8）：`minted` 只有总数，一轮全靠**备**通道铸出来时，总数记在哪条
   * 通道名下是看不出来的。没有这一格，备通道的战绩会被持续记到主通道头上。
   */
  it("逐通道铸出数：全靠备通道铸出来的那一轮，功劳记在备通道名下", () => {
    // 主通道 yyds 一把没铸出来，两把全是备通道 moemail 铸的。
    const r = round({ primaryChannel: "yyds", minted: 2, mintedByChannel: { moemail: 2 } });
    expect(mintedByChannelText(r)).toBe("moemail 2");
  });

  it("两条都有产出时按字母序排（与 CHANNELS 同一个真源）", () => {
    expect(mintedByChannelText(round({ mintedByChannel: { yyds: 1, moemail: 2 } }))).toBe("moemail 2 · yyds 1");
  });

  it("表里出现别的通道名时照样带出来（通道名是配置来的，丢掉等于让一份真实产出消失）", () => {
    expect(mintedByChannelText(round({ mintedByChannel: { zeta: 1, moemail: 2 } }))).toBe("moemail 2 · zeta 1");
  });

  it("空表 / 缺字段时返回 null，调用方不渲染这一行（补一个 0 是伪造一次产出记录）", () => {
    expect(mintedByChannelText(round({ mintedByChannel: {} }))).toBeNull();
    expect(mintedByChannelText(round({ mintedByChannel: null }))).toBeNull();
    expect(mintedByChannelText(null)).toBeNull();
  });
});

describe("channelTestResult：两条通道同一套文案模板", () => {
  it("成功：可用域名数 + 耗时", () => {
    expect(channelTestResult({ ok: true, channel: "yyds", domains: 7, latencyMs: 120 })).toEqual({
      key: "reg.channel.testOk", params: { domains: 7, latencyMs: 120 }, kind: "ok",
    });
  });

  it("上游不通：warn 而不是 err —— 「测出来不通」是这颗按钮要回答的问题，不是面板坏了", () => {
    const r = channelTestResult({ ok: false, channel: "moemail", reason: "upstream_error", latencyMs: 3000 });
    expect(r.key).toBe("reg.channel.testFailed");
    expect(r.params).toEqual({ latencyMs: 3000 });
    expect(r.kind).toBe("warn");
  });

  it("响应体整个读不到：err，且与「上游不通」是两句不同的话", () => {
    expect(channelTestResult(null)).toEqual({ key: "reg.channel.testError", params: {}, kind: "err" });
    expect(channelTestResult(null).key).not.toBe(channelTestResult({ ok: false }).key);
  });

  it("数字字段缺失时填 —，不伪造 0（「可用域名 0 个」与「不知道几个」是两回事）", () => {
    expect(channelTestResult({ ok: true }).params).toEqual({ domains: "—", latencyMs: "—" });
  });

  it("两条通道走同一条代码路径：换个通道名，返回的 key 与 params 形状一字不变", () => {
    const a = channelTestResult({ ok: true, channel: "moemail", domains: 3, latencyMs: 10 });
    const b = channelTestResult({ ok: true, channel: "yyds", domains: 3, latencyMs: 10 });
    expect(a).toEqual(b);
  });
});
