/**
 * 设置页的**全部取值决策**。板块文件（`js/sec-settings.js`）只剩 DOM 拼装、
 * 网络调用与 i18n 查表（admin-ui/README.md 硬规则 1）。
 *
 * 这个目录下的文件受三条硬规则约束（禁 import、禁浏览器全局、纯文本校验），
 * 规则全文见 admin-ui/README.md。
 *
 * ⚠️ **本模块承载设计 §5.3 / §5.4 / §8.6 / §10.4 里属于前端的那几条**：
 * · 四元组怎么读、锁定字段怎么判（§5.3）；
 * · 前端只做四条最轻量的即时提示，其余全靠渲染后端错误码（§10.4）；
 * · 凭据字段「留空则不修改」，清空走单独的动作（§8.6）；
 * · `agnesPlatformUrl` 折进高级区（§8.6 第二行）。
 */

/**
 * 三张卡各自的字段，**顺序即渲染顺序**（设计 §10.4 卡 1/2/3）。
 *
 * ⚠️ **`registrar.agnesPlatformUrl` 不在这三张表里**，它在下面的 `ADVANCED_FIELDS`。
 * 设计 §8.6 逐字：它是**注册凭据的去向**——改成自己的服务器就能收走每次注册的
 * 邮箱 + 密码 + 验证码 ⇒ 折进「高级」折叠区 + 红色警告 + 二次确认，**不放主表单**。
 * `tests/ui/settings.test.ts` 的
 * 「agnesPlatformUrl 只在高级区，主表单三张卡一格都不许有它」正面钉着这一条。
 */
export const CARD_AUTH = ["gatewayToken"];

export const CARD_UPSTREAM = [
  "agnesBaseUrl",
  "upstreamTimeoutMs",
  "upstreamSyncTimeoutMs",
  "maxStrikes",
  "cooldownRateLimitMs",
  "cooldownPaymentMs",
  "cooldownStrikeMs",
  // ⚠️ **这两个旋钮设计 §10.4 卡 2 的清单里没有，是本任务补进来的。**
  // 后端的 `EDITABLE` 里有它们（存储里本来就能改），不在面板上给入口的话，
  // `GET /admin/api/config` 会返回一份「说能改、却没有任何地方能改」的字段清单
  // ——那正是本仓反复裁过的「面板说一件事、实际是另一件事」。
  // **它们与别的字段有一条真实差异**：建 app 时读一次，改了要重启容器 / 等 isolate
  // 回收才生效，卡 2 底下那句 `set.card.upstreamNote` 就是说这件事的。
  // ⚠️ **上面这句话曾经是假的**：那个 key 在字典里躺了整整一期，
  // `sec-settings.js` 从来没把它渲染出来（`scripts/check-i18n.mjs` 这道门禁把它报成「未被引用」）。
  // 现在它真的上屏了，并由 tests/ui/dom/settings-save.test.ts 的
  // 「卡 2 底下真的印着那句「改了要重启」」钉着——这一条别再退回成散文。
  // ⚠️ **那一句只是常驻的静态提示，回执那一半是后来才补上的**：
  // 在那之前保存完一律渲染 `set.propagation`「本实例已经生效」，对这两格是**当面说反话**。
  // 这两格今天在下面的 `BUILD_TIME_FIELDS` 里，回执按那张表分岔。
  "poolCacheTtlMs",
  "poolTouchIntervalMs",
];

/**
 * 注册机卡里**与通道无关**的那些旋钮。两条通道各自的凭据由 `channelFields()` 给，
 * 而那个函数对两条通道**返回同构的清单**——「两张子卡完全对称」（§10.3 第 2 条）
 * 因此是结构上的，不是靠两处写得一样来维持的。
 */
export const CARD_REGISTRAR = [
  "registrar.enabled",
  "registrar.primary",
  "registrar.fallback",
  "registrar.targetKeys",
  "registrar.mintBatch",
  "registrar.tendIntervalMs",
  "registrar.codeTimeoutMs",
  "registrar.mintDelayMinMs",
  "registrar.mintDelayMaxMs",
  "registrar.maxDomainAttempts",
  "registrar.tokenName",
];

/** 折进「高级」折叠区的字段。见 `CARD_AUTH` 上面那段。 */
export const ADVANCED_FIELDS = ["registrar.agnesPlatformUrl"];

/**
 * 危险区（第 5 张卡）上的那几颗按钮。**顺序即渲染顺序**，也是五份 ADMIN.md
 * 危险区那张表的行序。
 *
 * ⚠️ **上面这两句话各自有一条会自己红的判据，别再当散文读**（复评回填）：
 * · 「顺序即渲染顺序」由 `tests/ui/dom/settings-save.test.ts` 的
 *   「危险区那张卡真的建出来了，两颗按钮各在自己那一行上」钉着——它拿 DOM 上的
 *   `data-danger` 序列与**本表现算**出来的 id 序列比，不再手抄字面量；
 * · 「也是五份 ADMIN.md 那张表的行序」由 `tests/unit/docs-parity.test.ts` 的
 *   「五份 ADMIN.md 危险区那张表的按钮列，逐行等于 DANGER_ACTIONS 的 titleKey 译文」
 *   钉着——期望值从**字典里 `titleKey` 那一行的译文**现算，所以那张表的第一列
 *   必须逐字是屏幕上那颗按钮的标签。
 * ⚠️ **这两条判据在复评之前都不存在**：当时把两条记录**整体对调**（条数与 id 集合
 * 都不变），`docs-parity` + `i18n-dict` + `settings.test.ts` **一格都没红**，
 * 唯一变红的是 DOM 那格手抄的字面量，而它的报文把人指向「按钮与本表对不上」
 *——那一刻 DOM 与本表恰恰完全一致，对不上的是五份文档的行序。
 *
 * ⚠️ **文案 key 写成字面量、放在这张表里，不许在板块文件里拼模板**
 *（`` `set.danger.${a}.title` `` 那种形态）。两条硬理由：
 * ① `scripts/check-i18n.mjs` 的第 ① 条对拼键只认「整条模板就是一个 key」，
 *    `${…}` 后面还跟着别的东西时它**当场吵**（那是它明写的「分不清就吵」那一档）；
 * ② 就算拼成了合法形态，那也会往那道门禁的「拼键前缀」表里加一条 `set.danger.`，
 *    **把整族 key 一并喂活** —— 于是这一族里将来任何一个真死 key 从此永远不会红，
 *    而第 ④ 条今天是硬错。这两条都是那个脚本自己逐字登记过的形态。
 *
 * ⚠️ **今天恰好两颗，第三颗刻意不在这里**（设计小节「第三颗按钮的去向」）：
 * 「重置单把 key 的用量统计」做成了 `PATCH /admin/api/keys/:id` 的一个字段，
 * 判据是**有界性**——`PATCH_FIELDS` 加一格 = 单把 key、1 次 put，硬有界；
 * 而做成危险区第三颗按钮（批量重置全池 stats）= N 次 put，**本仓没有任何常量给它上界**。
 *
 * 这张表的**条数**是五份 ADMIN.md 危险区那张表的行数真源，由
 * `tests/unit/docs-parity.test.ts` 的
 * 「五份 ADMIN.md 里五张表的行数，逐张等于屏幕那边对应的那个计数」钉着。
 */
export const DANGER_ACTIONS = [
  {
    id: "resetConfig",
    titleKey: "set.danger.reset.title",
    descKey: "set.danger.reset.desc",
    buttonKey: "set.danger.reset.button",
  },
  {
    id: "purgeKeys",
    titleKey: "set.danger.purge.title",
    descKey: "set.danger.purge.desc",
    buttonKey: "set.danger.purge.button",
  },
];

/**
 * **建实例时读一次**的字段。它们与别的字段的差异是一条**性质**，不是一份巧合的名单：
 * `src/http/wire.ts` 里 `const cfg = configHolder.current()` 之后拿它们建 `KeyPoolRepo`，
 * 此后不随 ConfigHolder 每次刷新而变 ⇒ 改了要重启容器 / 等 isolate 回收才生效。
 *
 * ⚠️ **这张表不是手写清单，是那条性质的交集，而且它会自己红**：
 * `tests/ui/settings.test.ts` 的
 * 「BUILD_TIME_FIELDS 就是 wire.ts 建 app 时读的那份快照里、面板又能改的那几格」
 * 抠掉注释之后从 `src/http/wire.ts` 扫出那份快照被读到的字段名，再与后端的
 * `EDITABLE` 求交，逐字与本表比对——删一项、多一项、或者哪天 `wire.ts` 又多读一个
 * 面板改得动的字段而没人回来补，那一格当场红。
 *
 * ⚠️ **DOM 层必须从这张表派生**，不许在 `sec-settings.js` 里写
 * `if (path === "poolCacheTtlMs" || …)` —— 那就是又一份会漂的手写清单，
 * 本仓已经因为同一形态（`FIELD_EXPOSURE` vs `EDITABLE` 那两张表）加过一整组对账用例。
 *
 * ⚠️ **`usageStatsEnabled` 同样是建实例时读一次的，但它不在这里**，理由不是遗漏：
 * 它压根不在后端的 `EDITABLE` 里 ⇒ 面板改不到它 ⇒ 保存回执里永远不会提到它。
 * 这条边界由上面那格的反向控制正面钉着（那一格要求它**被扫得出来、却不在本表里**）。
 */
export const BUILD_TIME_FIELDS = ["poolCacheTtlMs", "poolTouchIntervalMs"];

/** 这次保存里有没有碰到「建实例时读一次」的字段。 */
export function touchesBuildTimeField(changedPaths) {
  return changedPaths.some((p) => BUILD_TIME_FIELDS.includes(p));
}

/**
 * 这次保存里有没有碰到逐次生效的字段。
 *
 * ⚠️ **它不是 `!touchesBuildTimeField()`。** 两者都为真是**常态**（运维顺手一起改了），
 * 写成互斥就会在混合保存里吞掉其中一句话——那一档由
 * `tests/ui/dom/settings-save.test.ts` 的
 * 「③ 混合保存：同时改一个逐次生效的字段和一个旋钮 ⇒ 两句都出现」钉着。
 * 两者都为假也有意义：一次「什么都没变」的回读，两句话都不该说。
 */
export function touchesLiveField(changedPaths) {
  return changedPaths.some((p) => !BUILD_TIME_FIELDS.includes(p));
}

/**
 * 这份响应是不是**一次保存的回执**（而不是「只是读了一次配置」）。
 *
 * 判据是 `changed` 这一格**在不在**，不是它空不空：`PUT /admin/api/config` 的响应
 * 恒有它（哪怕是空数组），而 `GET /admin/api/config` 与清空凭据那条响应里
 * **一个字都没有**（`src/http/admin/handlers/config.ts` 三个 handler 的 `c.json(...)` 逐字如此）。
 *
 * ⚠️ **有了它，「上一次保存动了什么」就不必在板块文件里另存一份状态**——
 * 而那份状态正是会忘记清的那种东西（刷新一次、清空一把凭据之后它还留着，
 * 于是回执里那句话对着一次根本没发生的保存继续说）。**判据跟着数据走，不跟着时间走。**
 */
export function isSaveReceipt(body) {
  const b = obj(body);
  return b !== null && Array.isArray(b.changed);
}

/**
 * 两条邮箱通道，**顺序固定为字母序**（设计 §10.3 第 3 条）。
 *
 * ⚠️ **这里不重新声明一份，从 `registrar.mjs` 那份来**——它是顺序的唯一真源，
 * 而 `tests/ui/pure-boundary.test.ts` 的「全部 pure 模块的导出函数名，一个都不许在
 * sec-*.js 里被重新声明」那道结构门禁只拦「函数被抄回板块文件」，
 * **拦不住值常量被拷贝**（它自己的 `KNOWN_BLIND_SPOTS` 第二条逐字写着这件事）。
 * pure 模块之间不许 import（硬规则 1），所以由**板块文件**把 `CHANNELS` 传进来，
 * 本模块只负责按传入的顺序产出同构的字段清单。
 */
export function channelFields(channel) {
  // **两条通道返回的清单逐字同构**：同字段数、同顺序、同类型。
  // 加一行给某一条通道就必须加给另一条，否则「完全对称」当场破。
  return [`registrar.${channel}.baseUrl`, `registrar.${channel}.apiKey`];
}

/**
 * 字段路径 → 标签 i18n key。
 *
 * **两条通道的凭据字段共用 `set.field.channel.*` 两个 key**（不按通道各写一套）：
 * 那正是「两张子卡完全对称」在文案层面的落点——各写一套的话，某天有人给其中一条
 * 多写半句说明，对称就没了，而没有任何门禁看得见。
 */
export function fieldLabelKey(path) {
  const m = /^registrar\.(moemail|yyds)\.(baseUrl|apiKey)$/.exec(path);
  if (m !== null) return m[2] === "baseUrl" ? "set.field.channel.baseUrl" : "set.field.channel.apiKey";
  return `set.field.${path}`;
}

/**
 * ⚠️ **写成查表而不是 `switch` + `return`，是被门禁逼出来的，记在这里。**
 *
 * `scripts/check-i18n.mjs` 第 ⑧ 条（带占位符的 key 不许当不带参数的裸标签用）的
 * 判据是「这个 key 的字符串字面量后面必须紧跟一个 `,`」。`switch` 里
 * 那种写法后面跟的是 `;` ⇒ 本表里 5 个带占位符的 key **全部被报成违规**，
 * 而它们在调用点其实是带着参数用的（`errorRows()` 交出 `params`，板块文件
 * 调的是带第二个参数的翻译）——那是一次**误报**。
 *
 * 该门禁自己的边界注释写着「今天 admin-ui/ 下没有会漏过 / 会误报的那两种写法」，
 * **本任务写出了第三种**。处置：改成查表（每个字面量后面天然是 `,`），
 * 而不是去动门禁——查表本身也不比 `switch` 差，且这条边界如实登记在这里，
 * 下一个人写 `switch` + 带占位符的 key 时会再撞上同一条。
 */
const ERROR_KEYS = {
  unknown_field: "set.err.unknown_field",
  locked_by_env: "set.err.locked_by_env",
  not_an_integer: "set.err.not_an_integer",
  below_min: "set.err.below_min",
  not_a_string: "set.err.not_a_string",
  not_a_boolean: "set.err.not_a_boolean",
  empty: "set.err.empty",
  too_long: "set.err.too_long",
  not_a_url: "set.err.not_a_url",
  not_a_channel: "set.err.not_a_channel",
  primary_required: "set.err.primary_required",
  fallback_equals_primary: "set.err.fallback_equals_primary",
  delay_min_gt_max: "set.err.delay_min_gt_max",
  channel_credentials_missing: "set.err.channel_credentials_missing",
  // 评审接连三次点名补的五条。**加码就必须补这里 + 补五语言**，由
  // `tests/ui/settings.test.ts` 的「后端产出的每一个错误码都有对应的 i18n 键 —— 加一个码不补文案就变红」
  // 遍历后端的 `CONFIG_ERROR_CODES`（单一真源）钉着。
  gateway_token_required: "set.err.gateway_token_required",
  whitespace_padded: "set.err.whitespace_padded",
  not_sendable: "set.err.not_sendable",
  too_short: "set.err.too_short",
  same_as_admin_token: "set.err.same_as_admin_token",
  config_unloadable: "set.err.config_unloadable",
};

/**
 * 后端错误码 → i18n key。**逐条列出，表外的返回 `null`。**
 *
 * ⚠️ **表外返回 `null` 而不是一句「保存失败」**：`null` 让调用方有机会**把那个码
 * 原样显示出来**（`set.err.unknown`，带上码本身），而一句写死的「保存失败」会把
 * 一条本来能被运维 grep 到的线索抹掉——与 `registrar.mjs` 的 `failureReasonKey()`
 * 同一条纪律。
 *
 * `tests/ui/settings.test.ts` 的
 * 「后端产出的每一个错误码都有对应的 i18n 键 —— 加一个码不补文案就变红」
 * **直接遍历后端的 `CONFIG_ERROR_CODES`**（数组是真源、类型从它派生）来比对本表，
 * 那是设计 §10.4 要求的那条 CI 断言。
 *
 * ⚠️ **这里原来写的是「拿 `ConfigErrorCode` 那个联合类型的手写镜像来比对」——
 * 那份镜像已经不存在了**（评审当场实测：`satisfies` 只做单向可赋值检查，删得住、加不住，
 * 实测加一个码零信号）。同一个文件下面 `ERROR_KEYS` 上那段是对的，两句一度互相矛盾。
 * ⚠️ **它逃过了 `scripts/check-comment-refs.mjs` 这道门禁**，因为规则 B 查的是「指向存不存在」而不是「那句话真不真」
 * ——正是本仓登记在 `scripts/check-comment-refs.mjs` 里的那个盲区。
 */
export function errorMessageKey(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_KEYS, code) ? ERROR_KEYS[code] : null;
}

/** 有限数字才算数，别的（含 `null` / 字符串 / NaN）一律 `null`。**绝不伪造 0**。 */
function finite(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/**
 * 一个公开字段的四元组视图。
 *
 * **整段读不到时逐格 `null`**——「这一格是空的」与「没读到」必须分得开，
 * 前者渲染成空输入框，后者渲染成 `—` 并禁用保存。
 */
export function fieldView(body, path) {
  const b = obj(body);
  const all = b === null ? null : obj(b.fields);
  const one = all === null ? null : obj(all[path]);
  if (one === null) {
    return { present: false, stored: null, env: null, effective: null, lockedBy: null, locked: false };
  }
  const lockedBy = typeof one.lockedBy === "string" ? one.lockedBy : null;
  return {
    present: true,
    // `stored` / `effective` 是**任意 JSON 值**（数字 / 字符串 / 布尔 / null），
    // 这里原样交出去，渲染那一层再决定怎么显示。
    stored: one.stored === undefined ? null : one.stored,
    env: typeof one.env === "string" ? one.env : null,
    effective: one.effective === undefined ? null : one.effective,
    lockedBy,
    /** `lockedBy` 非空 ⇒ 输入框置灰 + 锁徽标 + 一句怎么轮换的说明（设计 §5.3 UI 规则）。 */
    locked: lockedBy !== null,
  };
}

/** 一把凭据的视图。**永远没有明文**（设计 §8.6），只有「配没配」与末 4 位。 */
export function credentialView(body, path) {
  const b = obj(body);
  const all = b === null ? null : obj(b.credentials);
  const one = all === null ? null : obj(all[path]);
  if (one === null) {
    return { present: false, configured: null, hint: null, lockedBy: null, locked: false };
  }
  const lockedBy = typeof one.lockedBy === "string" ? one.lockedBy : null;
  return {
    present: true,
    configured: typeof one.configured === "boolean" ? one.configured : null,
    hint: typeof one.hint === "string" ? one.hint : null,
    lockedBy,
    locked: lockedBy !== null,
  };
}

/** 这条路径是不是凭据。判据取**后端给的那份清单**，前端不另写一份（写两份必漂）。 */
export function isSecret(body, path) {
  const b = obj(body);
  const list = b === null || !Array.isArray(b.secrets) ? [] : b.secrets;
  return list.includes(path);
}

/**
 * 这一次保存要送的 patch。
 *
 * @param raw    `{ 路径: 输入框里的字符串 }`（下拉框与开关也先归一成字符串 / 布尔）。
 * @param body   最近一次 `GET /admin/api/config` 的响应，用来判类型与「变没变」。
 *
 * 三条规则：
 * ① **锁定的字段一律不送**（送了会被后端 `locked_by_env` 拒，而那次拒绝会把整份
 *    patch 一起打回来——运维改的另外五格也保存不上）；
 * ② **凭据留空 = 不送**（设计 §8.6：缺席或空串 = 不改）；
 * ③ **值没变的字段不送**：少送一格就少一次「其实没改却被算成改了」的高亮。
 */
export function buildPatch(raw, body, touched) {
  const patch = {};
  // `touched` = 运维**真的动过**的那些路径（板块文件按 input/change 事件收集）。
  // 不给就是 `null`，那时「没有基线」的格一律不送，见下面那段 ⚠️⚠️。
  const dirty = touched === undefined || touched === null ? null : new Set(touched);
  for (const path of Object.keys(raw)) {
    const value = raw[path];
    if (isSecret(body, path)) {
      const cred = credentialView(body, path);
      if (cred.locked) continue;
      if (typeof value !== "string" || value === "") continue;
      patch[path] = value;
      continue;
    }
    const view = fieldView(body, path);
    if (view.locked) continue;

    // ⚠️⚠️ **没有基线的格，只送运维真的动过的那些。**
    //
    // `present === false` 意味着这一格**连当前值都读不到**（诊断态下后端把 `fields`
    // 整个给 `null`，那是它如实的形态）。没有基线 ⇒ **「变没变」这个问题没有答案**，
    // 而第一版照旧拿 `sameScalar(null, 值)` 去比 ⇒ 注册机那个 checkbox 读出来恒是
    // `false`、与 `null` 不等 ⇒ **凭空替运维送一个 `registrar.enabled: false`**。
    //
    // 后果比「面板说了一件没发生的事」更坏：**面板做了运维没要求的事，然后显示成功**
    // ——横幅随后消失（恰恰是因为注册机被关掉了配置才装得起来），运维读成「恢复了」，
    // 而五语言 `set.loadBlocked` 正写着「改完保存即可恢复」。
    //
    // ⚠️ **为什么不是「`present === false` 一律不送」**：那样运维就再也没法从诊断态
    // 里把注册机**打开**（那同样是一条正当的自救路径）。判据必须是「他动没动过」，
    // 而不是「这一格现在有没有值」。
    if (view.present === false && (dirty === null || !dirty.has(path))) continue;

    // ⚠️⚠️ **空框 + 存储里本来就没有这一格 ⇒ 这次不改它。**
    //
    // 真机冒烟量出来的第二半：输入框回填的是**存储层**那个值，而全新部署下存储层
    // 是空的 ⇒ 一整页空框。数值格那一半由 `coerce()` 挡住了（空串→`undefined`），
    // **字符串格没有**：`agnesBaseUrl` / `registrar.tokenName` 会被原样当成 `""`
    // 送出去，然后吃一条后端的 `empty` ——运维一个字都没改，却被告知两格不能留空。
    // 「空且原本就没有」与「用户把一个有值的格清空了」是两件事，后者照常送出去、
    // 照常被后端拒（那是一句该说的话），前者什么都不做。`localErrors` 同源。
    if (value === "" && (view.stored === null || view.stored === undefined)) continue;
    const next = coerce(value, view.stored === null ? view.effective : view.stored);
    if (next === undefined) continue;
    // **「变没变」比的是 `stored ?? effective`。**
    //
    // ⚠️ 第一版只比 `stored`，真机冒烟量出来的后果是：全新部署下存储层是空的，
    // 而注册机那个开关（checkbox）读出来恒是 `false` ⇒ `sameScalar(null, false)`
    // 为假 ⇒ **每一次保存都会把 `registrar.enabled: false` 写进存储**，哪怕运维
    // 一个字都没改。那既是一次白花的写配额，也把一个内置取值**固化**进了存储
    //（以后改内置默认值就再也传播不到这个部署）。
    // ⚠️ **拿 `effective` 兜底不会让被 env 压过的字段永远显示成「有改动」**：
    // 那种字段在上面 `view.locked` 那一行就已经整个跳过了。
    const current = view.stored === null || view.stored === undefined ? view.effective : view.stored;
    if (sameScalar(current, next)) continue;
    patch[path] = next;
  }
  return patch;
}

/**
 * 把输入框里的字符串归一成后端要的类型。
 *
 * **参照的是这一格当前的值的类型**，而不是一张手写的「哪些字段是数字」表——
 * 后者会与后端的 `EDITABLE` 漂移，而漂了之后的症状是「保存一个数字被当成字符串
 * 拒掉」，运维完全看不出为什么。
 *
 * 拿不准（当前值也是 `null`、看不出类型）时**按字符串送**，让后端的权威校验去判：
 * 那正是设计 §10.4 的取舍——规则只有一份，前端不复刻。
 */
function coerce(value, reference) {
  if (typeof value === "boolean") return value;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  if (typeof reference === "number") {
    if (value.trim() === "") return undefined;
    const n = Number(value);
    // **`NaN` 不送**：送过去只会得到一条 `not_an_integer`，而前端本来就有
    // 「是数字」这条即时提示（见 `localErrors`）。
    return Number.isNaN(n) ? undefined : n;
  }
  if (typeof reference === "boolean") return value === "true";
  return value;
}

function sameScalar(a, b) {
  return Object.is(a, b);
}

/**
 * 前端**只做四条最轻量的即时提示**（设计 §10.4）：
 * 必填 / 是数字 / 非负 / `fallback ≠ primary`。**其余全靠渲染后端错误码。**
 *
 * ⚠️⚠️ **第四条只在注册机启用时拦。**
 * 后端 `registrarFromEnv` 里那条 `fallback === primary` 的抛错写在
 * `if (enabled && …)` 里，关着的注册机它一条都不抛 ⇒ 前端无条件拦截的后果是
 * **「关着注册机时连下拉框都改不了」**，而后端明明会收下。
 * **两边判据必须同源**，这一条由 `tests/ui/settings.test.ts` 的
 * 「注册机关着时前端不拦 fallback === primary —— 与后端同源」钉着。
 *
 * @param raw   `{ 路径: 值 }`，与 `buildPatch` 同一份输入。
 * @param body  最近一次 `GET /admin/api/config` 的响应（判「哪些是凭据」与当前类型）。
 */
export function localErrors(raw, body) {
  const out = [];
  for (const path of Object.keys(raw)) {
    if (isSecret(body, path)) continue;
    const view = fieldView(body, path);
    if (view.locked) continue;
    const value = raw[path];
    const reference = view.stored === null ? view.effective : view.stored;
    if (typeof reference !== "number") continue;
    if (typeof value !== "string") continue;
    // ① 必填。
    //
    // ⚠️⚠️ **判据是「用户把一个原本有值的格清空了」，不是「这一格是空的」。**
    // 真机冒烟量出来的：全新部署下存储里一个字段都没有 ⇒ 每个数值格的输入框都是空的
    //（框里回填的是**存储层**那个值，生效值在下面那行四元组里写着）⇒ 第一版的
    // 「空就报错」让运维**点一次保存收到 12 条「这一格不能留空」**，而他一个字都没改。
    // 空且存储里本来就没有 ⇒ 「这次不改这一格」，`buildPatch` 也是这么处理的，两边同源。
    if (value.trim() === "") {
      if (view.stored !== null && view.stored !== undefined) out.push({ field: path, code: "empty" });
      continue;
    }
    const n = Number(value);
    // ② 是数字。
    if (Number.isNaN(n)) { out.push({ field: path, code: "not_an_integer" }); continue; }
    // ③ 非负。**只到「非负」为止**——具体下界（1 还是 0）是后端的事，
    //    在这里复刻一份会与 `EDITABLE` 漂移，而那正是 §10.4 要避免的。
    if (n < 0) out.push({ field: path, code: "below_min" });
  }

  // ④ `fallback ≠ primary`，**只在启用时**。
  const enabled = pickBool(raw, body, "registrar.enabled");
  const primary = pickText(raw, body, "registrar.primary");
  const fallback = pickText(raw, body, "registrar.fallback");
  if (enabled === true && fallback !== "" && fallback !== null && fallback === primary) {
    out.push({ field: "registrar.fallback", code: "fallback_equals_primary" });
  }
  return out;
}

/** 表单里有就用表单的，没有就用当前四元组里那一格。 */
function pickBool(raw, body, path) {
  const v = raw[path];
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "false") return v === "true";
  const view = fieldView(body, path);
  const cur = view.stored === null ? view.effective : view.stored;
  return typeof cur === "boolean" ? cur : null;
}

function pickText(raw, body, path) {
  const v = raw[path];
  if (typeof v === "string") return v;
  const view = fieldView(body, path);
  const cur = view.stored === null ? view.effective : view.stored;
  return typeof cur === "string" ? cur : null;
}

/**
 * 一次保存的回执里，哪些字段的**生效值**真的变了。
 *
 * 设计 §5.3 UI 规则：**保存后不弹「已保存并生效」**，而是回读 `effective` 并把
 * 变化的字段高亮。这份清单就是「高亮哪几格」的依据，**由后端给**——前端自己
 * 拿保存前后两份响应去 diff 也做得到，但那样「高亮」与「真的落盘了什么」
 * 就成了两件可以不一致的事。
 */
export function changedFields(body) {
  const b = obj(body);
  return b !== null && Array.isArray(b.changed) ? b.changed.filter((x) => typeof x === "string") : [];
}

/** 这次动过的凭据路径（**只有路径，没有值**）。 */
export function changedSecrets(body) {
  const b = obj(body);
  return b !== null && Array.isArray(b.credentialsChanged)
    ? b.credentialsChanged.filter((x) => typeof x === "string") : [];
}

/**
 * 「别的副本多久能看见」。
 *
 * **必须显示，不许写「立即生效」**（设计 §5.2）：本进程确实立刻生效，
 * 别的 isolate 要等 `configTtlMs` + KV 边缘缓存。读不到就 `null` ⇒ 那一行不渲染，
 * **不伪造一个 0**（「0 秒生效」正好是被禁的那句话）。
 *
 * ⚠️ **「本进程确实立刻生效」这半句有一族例外，别再照上一版读**：
 * `BUILD_TIME_FIELDS` 里那两格是建实例时读一次的，**本进程也没生效**。
 * 这个函数只负责把上界读出来，「这一次该不该说那句话」的判据在
 * `touchesLiveField()` / `touchesBuildTimeField()` 那两条，落点在 `sec-settings.js`
 * 的 `render()`。
 */
export function propagationView(body) {
  const b = obj(body);
  const p = b === null ? null : obj(b.propagation);
  return {
    configTtlMs: p === null ? null : finite(p.configTtlMs),
    kvEdgeCacheMs: p === null ? null : finite(p.kvEdgeCacheMs),
    visibilityUpperBoundMs: p === null ? null : finite(p.visibilityUpperBoundMs),
  };
}

/**
 * 后端返回的逐字段错误 → 渲染用的清单。
 *
 * `key` 为 `null` 时调用方**把那个码原样显示出来**（`set.err.unknown`），
 * 不冒充任何一档已知原因。
 */
export function errorRows(errBody) {
  const b = obj(errBody);
  const list = b !== null && Array.isArray(b.errors) ? b.errors : [];
  return list.filter((e) => obj(e) !== null).map((e) => ({
    field: typeof e.field === "string" ? e.field : "",
    code: typeof e.code === "string" ? e.code : "",
    key: errorMessageKey(e.code),
    params: obj(e.params) === null ? {} : e.params,
  }));
}

/**
 * 存储里那份配置**装载不起来**了吗。
 *
 * ⚠️⚠️ **诊断态下表单必须仍然可编辑——那是运维唯一的出路。**
 * 后端在这个状态下把 `fields`/`credentials` 给 `null`（不编一份空配置出来），
 * 于是 `fieldView()` 对每一格都回 `present: false`。板块文件**不许**据此把输入框
 * 一律置灰：那会把「关掉注册机 / 把那把 key 填回去」这两条自救路径在 UI 上堵死，
 * 而后端明明放行。
 *
 * ⚠️ **别把它读成「改动前表单被置灰了」——那是一句被证伪的史实（复评发现）。**
 * 改动前 `setLock()` 里一行死代码会把调用方刚设好的 `disabled` 抹回 `false`，
 * 所以诊断态下的表单**从来没被置灰过**；真正的缺陷是反过来那条
 *（「这一格单独没读到」该置灰却没灰）。这个函数是**新加的判据**，
 * 让「诊断态」与「单独一格没读到」两种状态第一次分得开，不是在修一个置灰缺陷。
 */
export function isDiagnostic(body) {
  const b = obj(body);
  return b !== null && b.fields === null && Array.isArray(b.loadBlocked) && b.loadBlocked.length > 0;
}

/**
 * 装载不起来的每一条原因 → 渲染用的行。**判据与 `errorRows()` 是同一份**
 *（同样的 `code` → 同样的文案），两者的区别只在数据从响应体的哪一格来。
 */
export function loadBlockedRows(body) {
  const b = obj(body);
  const list = b !== null && Array.isArray(b.loadBlocked) ? b.loadBlocked : [];
  return list.filter((e) => obj(e) !== null).map((e) => ({
    field: typeof e.field === "string" ? e.field : "",
    code: typeof e.code === "string" ? e.code : "",
    key: errorMessageKey(e.code),
    params: obj(e.params) === null ? {} : e.params,
  }));
}

/**
 * 清空这一把凭据之前，**必须对运维说的那一句话**。
 *
 * ⚠️⚠️ **一句通用红字在这几种状态下，有的是救命、有的是吓人。**
 * 面板手上有分辨它们的全部数据（`lockedBy` 说 env 里有没有；注册机开没开、这条通道
 * 在不在主/备链上都在四元组里），**所以不许让运维自己猜**。
 * 第一版给的是一句带「如果……」的条件句——那等于把判断推回给读的人，而他手上
 * 恰恰没有比面板更多的信息。
 *
 * 四种状态，每一种都是**确定句**，没有「如果」：
 *
 * | 状态 | 说什么 | 轻重 |
 * |---|---|---|
 * | env 里也有这一项（`lockedBy` 非空） | 清空之后**回落到环境变量里的值**，生效值不变 | info |
 * | `gatewayToken`，env 里没有 | 清空之后**下一次冷启动会失败** | danger |
 * | 通道 key，env 里没有，且注册机开着 + 这条通道在链上 | 同上：**下一次冷启动会失败** | danger |
 * | 通道 key，env 里没有，且注册机关着或这条通道不在链上 | 现在不影响任何东西；**把这条通道接上链之前必须重新填** | info |
 *
 * 第三行不是过度警告：`registrarFromEnv` 的 `creds()` 在「启用 + 这条通道在链上 +
 * 缺凭据」时是**抛错**，与 `gatewayToken` 缺失是同一类 fail-closed，
 * 只是触发条件多两个。第四行也不是轻描淡写——那时它真的什么都不影响。
 *
 * `kind` 一起返回：**红不红是取值决策，不该由板块文件自己拍。**
 */
export function clearWarning(body, path) {
  const cred = credentialView(body, path);
  if (cred.lockedBy !== null) return { key: "set.clear.effect.env", kind: "info" };
  if (path === "gatewayToken") return { key: "set.clear.effect.gatewayMissing", kind: "danger" };

  const enabled = fieldView(body, "registrar.enabled").effective === true;
  const channel = /^registrar\.(moemail|yyds)\.apiKey$/.exec(path);
  const onChain = channel !== null && (
    fieldView(body, "registrar.primary").effective === channel[1]
    || fieldView(body, "registrar.fallback").effective === channel[1]
  );
  return enabled && onChain
    ? { key: "set.clear.effect.channelBreaks", kind: "danger" }
    : { key: "set.clear.effect.channelIdle", kind: "info" };
}

/**
 * 清空一把凭据之后，网关还有没有口令。
 * `gatewayTokenMissing === true` ⇒ **下一次冷启动会起不来**，面板必须把这句话
 * 显示出来（热实例靠上一份快照还在跑，所以这件事本来是看不见的）。
 */
export function clearResultView(body) {
  const b = obj(body);
  if (b === null) return { cleared: null, stillConfigured: null, gatewayTokenMissing: null };
  return {
    cleared: typeof b.cleared === "string" ? b.cleared : null,
    stillConfigured: typeof b.stillConfigured === "boolean" ? b.stillConfigured : null,
    gatewayTokenMissing: typeof b.gatewayTokenMissing === "boolean" ? b.gatewayTokenMissing : null,
  };
}

/**
 * 这一格该显示成什么（四元组的「生效值」那一列）。
 * 布尔与 `null` 都要有确定的显示形态，**`null` 不许显示成空白**——空白读起来像
 * 「没读到」，而 `null` 在这里的意思是「这一格没有值」。
 */
export function displayValue(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// ───────────────────────────────────────────────────────────────────────────
// 危险区（第 5 张卡）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 重置配置**之前**必须对运维说的那几句话。
 *
 * ⚠️⚠️ **判据不是这里算的，是后端给的 `resetBlocked`。**
 * 那一格由 `configLoadBlockers({}, env)` 产出——与 `PUT` 的跨字段校验、与诊断视图
 * **同一份**。设计小节逐字裁过这条：上一版把两态写成「有没有 `GATEWAY_TOKEN`」，
 * 那是把早先已经收口过一次的缺口原样搬回来（重置连**通道凭据**一起清，
 * 爆炸半径严格大于「清空一把凭据」那条单字段路径）。
 * **面板这一层只负责把码翻成话，一个优先级判断都不做。**
 *
 * 两句复用**已经上线的**那两条文案，不许另写（设计小节明令）：
 * · `gateway_token_required` ⇒ `set.clear.effect.gatewayMissing`；
 * · `channel_credentials_missing` ⇒ `set.clear.effect.channelBreaks`（一族只说一次）。
 * 其余的码走 `errorMessageKey()` 那张既有映射，表外的码**原样把码显示出来**
 *（`key` 为 `null` ⇒ 调用方用 `set.err.unknown`），与 `errorRows()` 逐条同源。
 *
 * ⚠️ **空数组不等于「重置之后一定装得起来」**：`configLoadBlockers` 自己不完备
 *（存储里 `registrar.targetKeys: "abc"` 这类它返回 `[]`、配置照样装不起来），
 * 本仓为这个等号栽过一次。所以空数组那一档说的是
 * `set.danger.reset.effect.ok`——「按逐字段判据看不出会缺什么」，不是「一定没事」。
 *
 * ⚠️⚠️ **「读不到 `resetBlocked`」与「`resetBlocked` 是空数组」是两件事，不许折进同一档**
 *（复评回填）。上一版把两者一起兜到 `set.danger.reset.effect.ok` 那一句上，
 * 实测后果：`GET /admin/api/config` 返回 500（⇒ 板块文件把 `data` 清成 `null`）之后点
 * 「重置配置」，弹窗照样逐字说「按逐字段判据看，重置之后这份配置仍然装载得起来」
 * ——**那句安心话背后一条数据都没有**。同一个文件下面的 `poolSizeOf()` 对同一件事
 * 的裁定逐字是「读不出来就 `null`，**绝不伪造 0**」，这里不许自相矛盾。
 * ⇒ 读不到时单独一档 `set.danger.reset.effect.unknown`，而且它是 `danger`：
 * 「判断不了」在一颗不可撤销的按钮上就是一条该红的提示。
 * ⚠️ **判据是「`resetBlocked` 这一格在不在」，不是「body 空不空」**：
 * `GET /admin/api/config` 与 `POST /admin/api/config/reset` 两条响应里都有它
 *（`src/http/admin/handlers/config.ts` 两处 `c.json(...)` 逐字如此），
 * 而清空凭据那条响应里原来没有——那条也已经补上了，理由写在那个 handler 里。
 * ⚠️ **这一档不禁用按钮**：与 `purgeConfirmed()` 那边「读不到池大小就不开确认框」
 * 不同——那边读不到的是**确认动作本身要用的基线**（没有那个数就没有「打对了」这回事），
 * 这边读不到的只是**后果预览**，而「配置装不起来」恰恰是运维最可能来按这颗按钮的时候，
 * 把它堵死等于关掉唯一的自救路径（后端 `configResetHandler` 上方那段 ⚠️ 写的是同一件事）。
 */
export function resetWarnings(body) {
  const b = obj(body);
  if (b === null || !Array.isArray(b.resetBlocked)) {
    return [{ code: "", key: "set.danger.reset.effect.unknown", params: {}, kind: "danger" }];
  }
  const list = b.resetBlocked;
  const rows = [];
  const seen = new Set();
  for (const e of list) {
    if (obj(e) === null) continue;
    const code = typeof e.code === "string" ? e.code : "";
    // 同一族只说一次：两条通道各缺一把凭据时，那句话说两遍不会更清楚。
    const key = code === "gateway_token_required"
      ? "set.clear.effect.gatewayMissing"
      : (code === "channel_credentials_missing" ? "set.clear.effect.channelBreaks" : errorMessageKey(code));
    const id = key === null ? `unknown:${code}` : key;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ code, key, params: obj(e.params) === null ? {} : e.params, kind: "danger" });
  }
  if (rows.length === 0) {
    return [{ code: "", key: "set.danger.reset.effect.ok", params: {}, kind: "info" }];
  }
  return rows;
}

/**
 * 当前池大小。取的是 `GET /admin/api/keys` 那份响应的 `total`。
 *
 * **读不出来就 `null`，绝不伪造 0**：`0` 在这里的意思是「池子是空的」，而那会让
 * 二次确认要求运维输入一个 `0` 然后**真的把一池 key 删掉**——「读不到」与
 * 「真的是空的」必须分得开，这是本仓反复裁过的同一条。
 */
export function poolSizeOf(body) {
  const b = obj(body);
  const n = b === null ? null : b.total;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * 清空 Key 池的二次确认：**运维必须把当前池大小那个数字亲手打一遍。**
 *
 * ⚠️ **判据是「逐字等于」，不是「数值相等」**：`Number("１")`（全角）在某些环境下
 * 会解析成 1，`" 3 "` 也会。用 `Number()` 比较等于把「打对了」放宽成「像那个数」，
 * 而这颗按钮的全部意义就是逼人**看清楚那个数**再手打一遍。只 `trim()` 两端空白
 *（复制粘贴带的），中间与形态一律照字面比。
 *
 * `poolSize` 读不出来（`null`）时**一律 `false`**：没有基线就没有「打对了」这回事。
 */
export function purgeConfirmed(typed, poolSize) {
  if (typeof poolSize !== "number" || !Number.isInteger(poolSize) || poolSize < 0) return false;
  if (typeof typed !== "string") return false;
  return typed.trim() === String(poolSize);
}

/**
 * 清空 Key 池的回执。**`remaining` 是后端回读出来的**，不是 `0` 这个常数——
 * 索引写空之后存储里还躺着记录（另一个副本刚导入 / 有人裸写了存储）时它非零，
 * 而面板必须如实说出来，不许把 handler 的心愿印在屏幕上。
 * 读不出来一律 `null`（同 `poolSizeOf`：绝不伪造 0）。
 */
export function purgeResultView(body) {
  const b = obj(body);
  const num = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  if (b === null) return { deleted: null, remaining: null };
  return { deleted: num(b.deleted), remaining: num(b.remaining) };
}

/**
 * 这次失败是不是「池子在你确认之前变了」。
 *
 * 判据是**顶层 `reason`**（机器可读的判别字符串），不是解析 `message` 里的中文
 * ——与 `keys-write.mjs` 对 `must_disable_first` 的处置逐字同源。
 */
export function isPoolSizeChanged(errBody) {
  const b = obj(errBody);
  return b !== null && b.reason === "pool_size_changed";
}
