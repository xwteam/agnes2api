/**
 * 注册机板块的**全部取值决策**。板块文件（`js/sec-registrar.js`）只剩 DOM 拼装、
 * 网络调用与 i18n 查表（admin-ui/README.md 硬规则 1）。
 *
 * 这个目录下的文件受三条硬规则约束（禁 import、禁浏览器全局、纯文本校验），
 * 规则全文见 admin-ui/README.md。
 *
 * ⚠️ **本模块承载设计 §10.3「两条通道完全平级」八条规则里的结构性那几条**：
 * 顺序（第 3 条）、两卡同构（第 2 条的取数侧）、唯一的不对称只写事实（第 5 条）。
 * 改动它们之前先看 `tests/ui/registrar.test.ts` 与
 * `tests/ui/dom/registrar-section.test.ts` 里对应的用例。
 */

/**
 * 两条邮箱通道，**顺序固定为字母序**（设计 §10.3 第 3 条）。
 *
 * 理由逐字照抄设计文档，因为它就是这条规则的全部依据：
 * **任何顺序都会被读成排名，字母序是唯一可辩护的中立规则；不用随机化因为会伤肌肉记忆。**
 *
 * 后端 `GET /admin/api/registrar/status` 的 `channels` 是一个 JSON 对象，
 * **渲染顺序不从它来**——对象键序是后端写出来的顺序，改后端一行就能悄悄改变
 * 面板上谁排在前面。顺序的唯一真源是这里这一个常量。
 */
export const CHANNELS = ["moemail", "yyds"];

/**
 * 通道名 → i18n key。**两条各写一次字面量**，好让三道 i18n 门禁都扫得到
 *（拼接出来的 key 三道全瞎，见 tests/unit/i18n-dict.test.ts 里那条按命名空间
 * 前缀扫字面量的用例）。
 */
export function channelLabelKey(channel) {
  return channel === "yyds" ? "reg.channel.yyds" : "reg.channel.moemail";
}

/**
 * **两条通道之间唯一的不对称**，设计 §10.3 第 5 条：YYDS 的 `baseUrl` 有内置取值、
 * MoeMail 没有（代码依据：`src/core/registrar/config.ts` 的 `DEFAULTS.yydsBaseUrl`
 * 存在，而 MoeMail 那条在 `creds()` 里是「两项都必须显式提供」）。
 *
 * ⚠️⚠️ **这条不许写成「YYDS 开箱即用」——那是偏好，不是事实。** 要写成事实：
 * 一条是**地址固定的公共服务**，一条是**自建服务、每个实例地址都不同**。
 *
 * ⚠️⚠️ **措辞里绝不能出现「默认」两个字，尽管设计 §10.3 第 5 条给的原句正是
 * 「本就不存在默认地址」。** 那句话会被 §10.3 第 4 条自己的禁用词门禁
 *（`scripts/check-i18n.mjs` 第 ⑥ 条，`reg.*` 命名空间）当场拦下——「默认」就在
 * 禁用词表里。设计文档这两条互相打架，本任务按第 4 条（它是 CI 门禁）执行，
 * 把第 5 条的语义原样保住、换一个不含禁用词的说法。
 */
export function channelAddressFactKey(channel) {
  return channel === "yyds" ? "reg.channel.addressFact.yyds" : "reg.channel.addressFact.moemail";
}

/**
 * 这条通道在**本次配置**里的角色 → i18n key。
 * `null`（既不是主也不是备）同样有一句如实的文案，**不是留空**——空着会让运维
 * 以为是没读出来。
 */
export function channelRoleKey(role) {
  if (role === "primary") return "reg.role.primary";
  if (role === "fallback") return "reg.role.fallback";
  return "reg.role.unused";
}

/**
 * 补池失败归因 → i18n key。**十二个成员逐条列出，表外的一律返回 `null`。**
 *
 * ⚠️⚠️ **设计 §7.3 要的「`switch` + `never` 穷尽检查」在这个文件里做不到，这是
 * 一条如实登记的偏离，不是疏忽。** `admin-ui/js/pure/*.mjs` 是 JavaScript，而
 * `tsconfig.json` 只开了 `allowJs`、**没有开 `checkJs`**（那一行旁边写着理由：
 * 「那些 .mjs 由 tests/ui 的行为断言守着，不做类型检查」）⇒ 无论这里怎么写，
 * `tsc --noEmit` 都不会看它一眼，`never` 在这里是一句注释而不是一道检查。
 *
 * **穷尽性因此落在两处会真的变红的地方，两处方向相反：**
 * ① `tests/ui/registrar.test.ts` 的
 *    「失败归因表就是 TEND_FAILURE_REASONS 那一份——加了第 13 个成员，这一格会 tsc 报错」
 *    里那张 `Record<TendFailureReason, string>` 手写表：**联合类型多一个成员，
 *    `tsc` 当场报错**（那个文件在 `tsconfig.json` 的 include 里）；
 * ② `tests/unit/i18n-dict.test.ts` 的「TendFailureReason 的每个成员都有 reg.fail.<reason> 键」：
 *    少一条五语言文案就变红。
 *
 * **表外返回 `null` 而不是一句「未知」**：`null` 让调用方有机会**把那个 reason 原样
 * 显示出来**（`reg.fail.unknownReason`），而一句写死的「未知」会把一条本来能被
 * 运维 grep 到的线索抹掉。
 */
export function failureReasonKey(reason) {
  switch (reason) {
    case "domain_blocked_all": return "reg.fail.domain_blocked_all";
    case "upstream_error": return "reg.fail.upstream_error";
    case "code_timeout": return "reg.fail.code_timeout";
    case "register_failed": return "reg.fail.register_failed";
    case "login_failed": return "reg.fail.login_failed";
    case "key_failed": return "reg.fail.key_failed";
    case "provider_error": return "reg.fail.provider_error";
    case "network_error": return "reg.fail.network_error";
    case "rate_limited": return "reg.fail.rate_limited";
    case "provider_missing": return "reg.fail.provider_missing";
    case "round_crashed": return "reg.fail.round_crashed";
    case "key_suspicious": return "reg.fail.key_suspicious";
    default: return null;
  }
}

/**
 * 后端拒绝时那个**顶层 `reason`** → i18n key。
 *
 * ⚠️⚠️ **状态码不是判据。** `409` 有三种（`tend_in_flight` / `locked` /
 * `registrar_disabled`）、`429` 有两种（`manual_cooldown` / `write_budget_exhausted`）。
 * 拿状态码选文案的前端会把「另一个副本在跑」（等对面跑完）与「注册机压根没开」
 *（去设置里打开它）说成同一句话——两者的处置毫无共同之处。
 * 这与 Key 池那条 `must_disable_first` 在批量路径上「200 一路走过去」是同一个形状。
 *
 * 表外返回 `null`：调用方退回到一句通用的失败提示，**绝不冒充任何一档已知原因**。
 */
export function refuseReasonKey(reason) {
  switch (reason) {
    case "tend_in_flight": return "reg.refuse.tend_in_flight";
    case "locked": return "reg.refuse.locked";
    case "registrar_disabled": return "reg.refuse.registrar_disabled";
    case "write_budget_exhausted": return "reg.refuse.write_budget_exhausted";
    case "manual_cooldown": return "reg.refuse.manual_cooldown";
    case "not_wired": return "reg.refuse.not_wired";
    case "unknown_channel": return "reg.refuse.unknown_channel";
    case "channel_not_configured": return "reg.refuse.channel_not_configured";
    default: return null;
  }
}

/** 有限数字才算数，别的（含 `null` / 字符串 / NaN）一律 `null`。**绝不伪造 0。** */
function finite(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/**
 * 注册机的启用状态与两条通道的角色。
 * 整段读不到时逐字段 `null`——**「注册机关着」与「没读到」必须分得开**，
 * 前者渲染成「已关闭」，后者渲染成 `—`。
 */
export function statusView(body) {
  const b = obj(body);
  return {
    enabled: b !== null && typeof b.enabled === "boolean" ? b.enabled : null,
    primary: b !== null && typeof b.primary === "string" ? b.primary : null,
    fallback: b !== null && typeof b.fallback === "string" ? b.fallback : null,
    serverTime: b === null ? null : finite(b.serverTime),
    lockedUntil: b === null ? null : finite(b.lockedUntil),
  };
}

/**
 * 两张通道卡的取数，**顺序恒为 `CHANNELS`**。
 *
 * **一定返回两项**，读不到就把 `configured` 记成 `null`（不是 `false`）：
 * 「这条通道没配」与「读不出来」在面板上是两句不同的话，而把后者显示成前者，
 * 运维会去配一条其实已经配好的通道。
 */
export function channelCards(body) {
  const b = obj(body);
  const all = b === null ? null : obj(b.channels);
  return CHANNELS.map((channel) => {
    const one = all === null ? null : obj(all[channel]);
    return {
      channel,
      configured: one !== null && typeof one.configured === "boolean" ? one.configured : null,
      role: one !== null && typeof one.role === "string" ? one.role : null,
    };
  });
}

/**
 * 池子那一行的四个数字。
 *
 * ⚠️ **`counted` 不是「可用」**：判据是 `countsTowardTarget`（`!evicted`），
 * **被停用的与正在冷却的 key 都算在里面**，而这两种都不能打上游。真正的可用数是
 * 另一格 `fresh`。两格并排显示、各自的标签各说各的口径——这是
 * `src/core/registrar/tender.ts` 里那段「这一栏不许按『可用』渲染」的落点。
 */
export function poolView(body) {
  const b = obj(body);
  const p = b === null ? null : obj(b.pool);
  return {
    target: p === null ? null : finite(p.target),
    counted: p === null ? null : finite(p.counted),
    gap: p === null ? null : finite(p.gap),
    fresh: p === null ? null : finite(p.fresh),
    mintBatch: p === null ? null : finite(p.mintBatch),
  };
}

/**
 * 确认弹窗要明示的消耗（设计 §10.2 第 3 条护栏）：本次最多铸几把 key、
 * 最多消耗几个临时邮箱。
 *
 * 算式与 `tendOnce` 逐字相同：`rounds = min(need, mintBatch)`，`need = target - counted`
 *（后端已经把 `need` 夹到非负后叫 `gap`）。一次尝试最多建一个临时邮箱，所以两个数相等。
 *
 * ⚠️ **两个外部服务的活跃邮箱上限（YYDS / MoeMail 各自那个数）一律不写进文案。**
 * 它们一个与账号档位绑定、一个是可被实例覆盖的上游默认值，**把一个当前取值印在
 * 面板上，运维会把它当成自己这套部署的事实**。文案改成指向各自服务商的文档，
 * 完整理由见 `src/http/admin/handlers/registrar.ts` 的文件头。
 *
 * 读不出来时返回 `null` ⇒ 弹窗显示 `—`，**不伪造一个 0**（「最多铸 0 把」会让人
 * 以为点了也没用）。
 */
export function tendCost(body) {
  const p = poolView(body);
  if (p.gap === null || p.mintBatch === null) return null;
  const keys = Math.max(0, Math.min(p.gap, p.mintBatch));
  return { keys, mailboxes: keys };
}

/**
 * 「今天还剩几次 / 什么时候能再点」。
 *
 * ⚠️ **绝对时刻与相对时长成对取**（评审 m3 定死的口径）：相对量用来做倒计时
 *（免疫客户端时钟偏差），绝对时刻用来显示「几点恢复」。**绝不让面板自己拿本地
 * 时钟去减一个服务端时刻**——两条路在时钟有偏差时会给出两个不一致的答案。
 */
export function manualQuotaView(body) {
  const b = obj(body);
  const m = b === null ? null : obj(b.manual);
  return {
    remaining: m === null ? null : finite(m.remaining),
    perDay: m === null ? null : finite(m.perDay),
    resetAt: m === null ? null : finite(m.resetAt),
    cooldownUntil: m === null ? null : finite(m.cooldownUntil),
    retryAfterMs: m === null ? null : finite(m.retryAfterMs),
  };
}

/**
 * 补池历史，**最新的排在最前面**。
 *
 * 后端存的是环形追加（最新的在数组末尾），面板要倒着看——这一步是取值决策，
 * 所以在这里，不在板块文件里。
 *
 * 每一行都是后端 `narrowTendHistory` 逐字段校验过的，但**这里仍然只收对象**：
 * 一个被中间层改坏的响应体不该让整块历史抛异常消失。
 */
export function historyRows(body) {
  const b = obj(body);
  const h = b === null ? null : obj(b.history);
  const entries = h !== null && Array.isArray(h.entries) ? h.entries : [];
  return entries.filter((r) => obj(r) !== null).slice().reverse();
}

/** 后端在读补池历史时丢掉了几条读不得的记录。`null` = 整块没读到（不是 0）。 */
export function historyMalformed(body) {
  const b = obj(body);
  const h = b === null ? null : obj(b.history);
  return h === null ? null : finite(h.malformed);
}

/**
 * 一行补池记录的**结果**该说哪句话。
 *
 * 四种形态的判据逐字取自 `src/core/registrar/tender.ts` 里 `mintedByChannel` 上方
 * 那张表：**`skipped` + `attempted` + `failures` 三个字段合读**才分得清，
 * 单看任何一个都不行。别拿 `mintedByChannel` 的空表去推断这一轮发生了什么。
 */
export function roundOutcome(row) {
  const r = obj(row);
  if (r === null) return { key: "reg.row.unreadable", params: {} };
  if (r.skipped === true) return { key: "reg.row.skipped", params: {} };
  const attempted = finite(r.attempted);
  const failures = Array.isArray(r.failures) ? r.failures : [];
  if (attempted === 0 && failures.length === 0) return { key: "reg.row.healthy", params: {} };
  // 一次都没开始、却有失败归因 ⇒ 整轮抛错（`round_crashed`）或者预算装不下第一次尝试。
  // **不许渲染成「铸出 0/0 把」**：那句话读起来像「跑完了但没产出」，而它其实是
  // 「根本没跑起来」，两者的排查方向完全不同。
  if (attempted === 0) return { key: "reg.row.noAttempt", params: {} };
  return {
    key: "reg.row.minted",
    params: { minted: finite(r.minted) === null ? "—" : r.minted, attempted },
  };
}

/**
 * 一行里的失败归因列表（逐条带 `channel`）。
 * **表外的 `reason` 不丢掉**：`key` 为 `null` 时调用方原样把 `reason` 显示出来。
 */
export function roundFailures(row) {
  const r = obj(row);
  const list = r !== null && Array.isArray(r.failures) ? r.failures : [];
  return list.filter((f) => obj(f) !== null).map((f) => ({
    reason: typeof f.reason === "string" ? f.reason : "",
    channel: typeof f.channel === "string" ? f.channel : "",
    key: failureReasonKey(f.reason),
  }));
}

/**
 * 逐通道的铸出数，渲染成 `moemail 2 · yyds 1`。
 *
 * ⚠️ **这一格存在的理由是硬约束「两条通道完全平级」**（`TendResult.mintedByChannel`
 * 上那段评审 I8）：`minted` 只有总数，而一轮全靠备通道铸出来时，总数记在哪条通道
 * 名下是看不出来的——没有这一格，备通道的战绩会被持续记到主通道头上。
 *
 * 顺序：先按 `CHANNELS`（字母序），再把表里出现过的其它通道名按字典序接在后面
 *（通道名来自配置，理论上可以是别的东西；丢掉它等于让一份真实产出凭空消失）。
 * 没铸出来的通道**不出现**（后端就是这么记的，补一个 0 是伪造一次产出记录）。
 */
export function mintedByChannelText(row) {
  const r = obj(row);
  const table = r === null ? null : obj(r.mintedByChannel);
  if (table === null) return null;
  const known = CHANNELS.filter((c) => finite(table[c]) !== null);
  const extra = Object.keys(table)
    .filter((c) => !CHANNELS.includes(c) && finite(table[c]) !== null)
    .sort();
  const parts = [...known, ...extra].map((c) => `${c} ${table[c]}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * 一次通道连通性测试的结果该怎么显示。
 *
 * **两条通道用同一个函数、同一套文案模板**（设计 §10.3 第 6 条：两个按钮的样式、
 * 位置、文案模板完全一致）——「等权」在这里是结构上的，不是靠两处代码写得一样。
 *
 * `ok: false` 走的是 HTTP 200 + `{ ok: false }`：**「测出来不通」是这颗按钮要回答的
 * 问题，不是面板自己坏了**，所以它不该长得像一次接口异常。
 */
export function channelTestResult(res) {
  const r = obj(res);
  if (r === null) return { key: "reg.channel.testError", params: {}, kind: "err" };
  const latencyMs = finite(r.latencyMs);
  if (r.ok === true) {
    const domains = finite(r.domains);
    return {
      key: "reg.channel.testOk",
      params: { domains: domains === null ? "—" : domains, latencyMs: latencyMs === null ? "—" : latencyMs },
      kind: "ok",
    };
  }
  return {
    key: "reg.channel.testFailed",
    params: { latencyMs: latencyMs === null ? "—" : latencyMs },
    kind: "warn",
  };
}

/**
 * 从一次失败的接口调用里取出后端给的顶层 `reason`（`ApiError.body.reason`）。
 * 拿不到就 `null` ⇒ 调用方用一句通用文案，**不猜**。
 */
export function refuseKeyOf(errBody) {
  const b = obj(errBody);
  return b === null ? null : refuseReasonKey(b.reason);
}
