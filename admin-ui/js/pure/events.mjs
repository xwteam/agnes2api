/**
 * 事件板块的**全部取值决策**。板块文件（`js/sec-events.js`）只剩 DOM 拼装、
 * 网络调用与 i18n 查表。理由与 `pure/keys.mjs` / `pure/overview.mjs` 同一条
 * （admin-ui/README.md 硬规则 1）。
 *
 * 这个目录下的文件受三条硬规则约束（禁 import、禁浏览器全局、纯文本校验），
 * 规则全文见 admin-ui/README.md。
 */

/** 轮询最短间隔（页面可见、内容有变化时）。 */
export const EVENTS_POLL_MIN_MS = 15_000;
/** 轮询最长间隔（内容连续无变化时指数退避到这里封顶）。 */
export const EVENTS_POLL_MAX_MS = 60_000;

/** 四个日志级别，顺序即级别按钮组的渲染顺序。不含 "all"（那是"不筛"，另处理）。 */
export const LEVELS = ["debug", "info", "warn", "error"];

/**
 * 级别按钮组用的 i18n key——**只用于工具栏的筛选按钮**，入参恒是 `LEVELS` 里的
 * 一个（调用方 `for (const lvl of LEVELS)` 保证）。"全部级别" 按钮的文案由调用方
 * 直接写字面量 `"ev.level.all"`，不经过这个函数。
 */
export function levelLabelKey(level) {
  if (level === "debug") return "ev.level.debug";
  if (level === "info") return "ev.level.info";
  if (level === "warn") return "ev.level.warn";
  return "ev.level.error";
}

/**
 * **评审裁定**：一条事件真实的 `level` 字段来自接口响应，可能缺失/畸形——
 * 原来 `eventRow` 里 `typeof item.level === "string" ? item.level : "info"` 会把
 * 这类数据**伪装成 info**（绿色徽章），与"绝不伪造"的产品不变式矛盾。这里给出
 * 唯一的判据：四个已知级别原样透传，其余（含 `undefined`/数字/畸形字符串）一律
 * 归到显式的 `"unknown"` 档，不冒充任何一个已知级别。
 */
export function effectiveLevel(item) {
  const level = item && typeof item === "object" ? item.level : undefined;
  return (LEVELS.includes(level)) ? level : "unknown";
}

/** `effectiveLevel()` 的结果 → i18n key，与 `levelLabelKey` 分开：这个要接受 "unknown"。 */
export function eventLevelLabelKey(level) {
  if (level === "debug") return "ev.level.debug";
  if (level === "info") return "ev.level.info";
  if (level === "warn") return "ev.level.warn";
  if (level === "error") return "ev.level.error";
  return "ev.level.unknown";
}

/**
 * 级别徽章颜色。与 `pure/keys.mjs` 的 `badgeClass` 同一套配色语义。
 * **`"unknown"` 单独一档**（灰色/muted），不落进任何一个"看起来正常"的颜色。
 */
export function levelBadgeClass(level) {
  if (level === "error") return "badge badge-danger";
  if (level === "warn") return "badge badge-warn";
  if (level === "debug" || level === "info") return "badge badge-ok";
  return "badge"; // unknown：不给任何一种"正常/异常"的颜色暗示
}

/**
 * `GET /admin/api/events` 的查询串。
 *
 * `level` 为 `"all"`（或任何不认识的值）时**不发这个参数**——与 `keysQuery` 的
 * `bucket` 处理同一条理由：后端把无法识别的值当作不筛，发过去只是噪音。
 */
export function eventsQuery(state) {
  const parts = [];
  if (typeof state.after === "number" && Number.isFinite(state.after)) parts.push(`after=${state.after}`);
  if (LEVELS.includes(state.level)) parts.push(`level=${encodeURIComponent(state.level)}`);
  if (typeof state.limit === "number" && Number.isFinite(state.limit)) parts.push(`limit=${state.limit}`);
  return parts.join("&");
}

/** 「这份响应里有没有可渲染的条目」——同 `pure/keys.mjs` 的 `itemsOf`，全模块唯一判据。 */
export function itemsOf(body) {
  return body && typeof body === "object" && Array.isArray(body.items) ? body.items : null;
}

/**
 * 事件列表区该显示哪条消息（`null` = 显示表格）。与 `pure/keys.mjs` 的
 * `listMessageKey` 同一个模式（判据一律不写在 `sec-events.js` 里，见硬规则 1）。
 *
 * **评审发现**：原来 `sec-events.js` 用一个模块级的 `everLoaded` 标记（"这次进入
 * 本板块之后有没有成功过一次"），`onShow()` 每次都把它重置成 `false`——于是重新
 * 进入本板块时，只要第一轮轮询恰好失败，就会把 `view` 里明明还留着的历史事件
 * 整段换成"读取失败"，即使数据一直都在，只是这一轮没刷新成功。
 *
 * 判据改成只看 `viewLength`（视图里有没有数据）而不是"这一次有没有成功过"：
 * 只要视图里还有数据，哪怕最新一轮轮询失败了，也继续显示已有数据（轮询指示灯
 * 会转成"出错"提示这件事，不需要靠替换整个列表区来提示）；只有视图本身是空的
 * 且这一轮又失败了，才说"读取失败"。
 *
 * ⚠️ **`cleared` 这一档是通读评审提出的，修的是一个已经上线的、面板对运维说假话的
 * 缺陷。** 点"清空"之后 `view` 变成 `[]`，而原来这里只看 `viewLength === 0`，
 * 于是列表区显示**「还没有事件。」**——与同一个按钮的 tooltip（"只清前端当前显示的
 * 列表，不影响服务端已落盘的事件"）当场自相矛盾，而且它说的那件事是假的：服务端
 * 明明有事件。运维照着这句话会得出"这个部署从来没出过事"的结论。
 *
 * **"清空"的语义刻意保持不变**（游标不回退，被清掉的不会自动回来）：这个按钮的
 * 用途就是"把噪音清掉、从此刻起盯着新的"。把游标一起重置的话，下一轮冷读会立刻
 * 把同一批事件原样拉回来——按钮看上去等于没生效。所以这里修的是**措辞**，
 * 并由 `ev.cleared` 把恢复路径（下载 / 刷新页面）一并说清楚。
 */
export function eventsListMessageKey(loadError, viewLength, filteredLength, cleared) {
  if (loadError && viewLength === 0) return "common.loadFailed";
  if (filteredLength === 0) {
    if (viewLength > 0) return "ev.noMatch";
    return cleared === true ? "ev.cleared" : "ev.empty";
  }
  return null;
}

/**
 * 本 isolate 的分片 id（评审发现）。**没有数据时是 null**，不是空串——
 * 空串会被当成"有值但恰好是空"，与"读不出来"混在一起。
 */
export function shardIdOf(body) {
  const v = body && typeof body === "object" ? body.shardId : null;
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * 响应生成时刻（后端 `now()`，评审点名的第二个零消费者字段，[LOW]）。
 *
 * 与 `pure/keys.mjs` 的 `generatedAt` 同一条理由（那边用它当 `cooldownRemaining`
 * 的参照时刻，不用浏览器时钟）：这里没有需要拿它算差值的场景，**最小、低风险的
 * 消费方式**是让轮询指示灯的 tooltip 报一句"数据截至几点"——运维只要看这个
 * tooltip 就知道当前显示的是不是刚刚拉到的，不需要另外去猜面板有没有卡住。
 * 缺失/畸形时是 `null`（渲染成不显示这一段，不是显示一个假时间）。
 */
export function generatedAtOf(body) {
  const v = body && typeof body === "object" ? body.generatedAt : null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 响应自述状态。**没有数据时逐项 null**（不是 0/false）——那几个字面上恰好
 * 也是"一切正常"的值，混进"读不出来"里会把面板变成在撒谎。
 *
 * - `truncated`（评审补的）：`after`+`limit` 组合截掉了一部分本该出现的旧事件。
 * - `buffered`（评审发现）：本 isolate 缓冲里还有多少条事件没有落盘。isolate 在
 *   下一次成功 flush 之前被回收（Worker 上是常态）时，这些事件会**永久丢失**，
 *   而 `dropped` 不计它（`dropped` 只统计已经落盘/已经在内存环里明确丢弃的那些，
 *   还"活在"缓冲区里、尚未有机会落盘或丢弃的不算）。字段消费者审计发现这是
 *   唯一一个响应里给了但没有任何地方读的字段，这里补上。
 * - `cursorAhead`（评审补的）：`after` 领先于本次请求的时钟（时钟回拨 / isolate
 *   间时钟偏移），`items` 恒为空但这**不代表没有新事件**，前端必须能区分开。
 * - `malformed`（本任务）：这一次读里被逐条丢掉的畸形条目数。`src/` 里没有任何
 *   路径能产出它，**恒为 0 正是它的价值**——运维手改存储 / KV 值损坏 /
 *   `store.json` 被写到一半时，它是唯一能把「面板少了几条事件」与「本来就没有
 *   事件」区分开的信号。**刻意不进 `shouldWarn`**（见那个函数的说明），
 *   只进轮询指示灯的 tooltip，与 `buffered` 走同一条路。
 */
export function bufferStatus(body) {
  const dropped = body && typeof body === "object" ? body.dropped : null;
  const budgetExhausted = body && typeof body === "object" ? body.budgetExhausted : null;
  const truncated = body && typeof body === "object" ? body.truncated : null;
  const buffered = body && typeof body === "object" ? body.buffered : null;
  const cursorAhead = body && typeof body === "object" ? body.cursorAhead : null;
  const malformed = body && typeof body === "object" ? body.malformed : null;
  return {
    dropped: typeof dropped === "number" && Number.isFinite(dropped) ? dropped : null,
    budgetExhausted: typeof budgetExhausted === "boolean" ? budgetExhausted : null,
    truncated: typeof truncated === "boolean" ? truncated : null,
    buffered: typeof buffered === "number" && Number.isFinite(buffered) ? buffered : null,
    cursorAhead: typeof cursorAhead === "boolean" ? cursorAhead : null,
    malformed: typeof malformed === "number" && Number.isFinite(malformed) ? malformed : null,
  };
}

/**
 * 顶部黄条要不要出现。**诚实标记必须由后端字段驱动**（一条评审裁定，
 * 隔了一个板块又原样复发过一次）：判据只看 `status.dropped` /
 * `status.budgetExhausted` / `status.truncated` / `status.cursorAhead` 这几个
 * 从响应里取出来的值，不许在这里或调用方硬编码一个 true/false。
 * `null`（没有数据）不触发——不知道不等于"有问题"。**不含 `buffered`**：单纯
 * "缓冲区里还有事件没落盘"是运行中的正常状态（还没到落盘时机而已），只有搭配
 * "isolate 可能被回收"这层风险才值得说，这条风险不是靠一个数字大小能判断的，
 * 交给轮询指示灯的 tooltip 常驻显示（见 `sec-events.js`），不占用黄条。
 *
 * **也不含 `malformed`**（本任务，刻意的）：`src/` 里没有任何路径能产出畸形条目，
 * 它恒为 0，挂上来只会让黄条的判据多一条**永远为假**的分支——那是「形状断言
 * 冒充行为断言」在产品面上的等价物。它与 `buffered` 一样走 tooltip。
 *
 * ⚠️ **但 `cursorBroken` 进来了（评审要求）**，而且它比在座任何一条都更该在：
 * 它意味着**后端此刻正在违约**——`cursor` 既不是有限数字也不是 `null`，于是游标
 * 推不动、面板可能**永远看不到新事件**。判据里那条 `cursorAhead` 反倒是会自愈的
 * 时钟纠纷。第一版只把它接进 tooltip，**等于把「面板在撒谎」降级成「面板在小声说」**
 * ——而上面「黄条是给『现在有问题』用的」这条推理，恰恰要求它上黄条。
 * 它**不是**恒为假：`src/` 产不出畸形条目，但畸形 `cursor` 的来源是**存储被外部
 * 写坏**，与 `malformed` 同源、也同样是真实可达的。
 */
export function shouldWarn(status) {
  return (status.dropped !== null && status.dropped > 0)
    || status.budgetExhausted === true
    || status.truncated === true
    || status.cursorAhead === true
    || status.cursorBroken === true;
}

/**
 * 下一次轮询该带的 `after` 游标，**以及后端契约有没有被破坏**。
 *
 * 三种输入，三种语义，**不许合并成两种**：
 * · `cursor` 是有限数字 ⇒ 推进。
 * · `cursor` 是 `null` ⇒ **本页没有新事件**，保留当前值。不能回退成 null 或某个
 *   旧值——那会让下一次轮询把已经看过的事件重新拉一遍。
 * · `cursor` 是别的（缺字段 / `undefined` / `NaN` / 字符串）⇒ **后端契约被破坏了**，
 *   保留当前值**但把这件事说出去**。
 *
 * 原来第三支与第二支是合并的（`nextAfter` 一个三元表达式），于是「后端在吐畸形
 * 数据」被显示成「一切正常，只是没有新事件」——**面板在撒谎**，而且撒的正是让人
 * 查不下去的那种谎：游标永远推不动，每一轮都是满额 48 次 get 的冷读，稳态读吞吐
 * 276,480 次/天（包线 70,560 的 3.9 倍），面板上却什么异常都看不到。
 */
export function cursorOutcome(current, cursor) {
  if (typeof cursor === "number" && Number.isFinite(cursor)) return { after: cursor, broken: false };
  if (cursor === null) return { after: current, broken: false };
  return { after: current, broken: true };
}

/**
 * 下一次轮询该带的 `after` 游标（只要取值那一半）。
 * **判据只有 `cursorOutcome` 一份**，这里不重新实现——同一个判据的第二份实现
 * 正是本仓反复裁过的那一族。
 */
export function nextAfter(current, cursor) {
  return cursorOutcome(current, cursor).after;
}

/**
 * 轮询的**全部跨轮状态**。三个字段合成一个对象是有意为之，见 `pollOutcome()`
 * 的"为什么是一个状态对象"一段。
 *
 * - `after`：下一次请求要带的游标（`null` = 冷读）。
 * - `healing`：正处在一次游标自愈之后、**还没有重新建立起游标**的那一段。
 * - `delayMs`：下一次轮询的退避间隔。
 */
export function initialPollState() {
  return { after: null, healing: false, delayMs: EVENTS_POLL_MIN_MS };
}

/**
 * 重新进入本板块时的状态。**保留 `after`**（已经看过的事件不该因为切走又切回来
 * 再拉一遍），但把退避与自愈状态归零——这两者描述的是"最近这一段轮询发生了什么"，
 * 隔了一段时间之后不再成立。
 *
 * 这条也是决策，不是拼装：写在板块文件里就又是一处没人测的跨轮规则。
 */
export function resumePollState(prev) {
  const state = prev && typeof prev === "object" ? prev : {};
  const after = typeof state.after === "number" && Number.isFinite(state.after) ? state.after : null;
  return { after, healing: false, delayMs: EVENTS_POLL_MIN_MS };
}

/**
 * 一轮轮询成功之后的**完整状态转换**（游标那一条的二审 / 三审(a) / 四审 B1）。这条
 * 判断原来直接摊在 `sec-events.js` 的 `poll()` 里，是纯状态转换却没有测试覆盖，
 * 两个联带 bug 都是从这个洞里漏出来的——**这不是渲染逻辑，是决策逻辑**，与
 * `admin-ui/README.md` 硬规则 1 管的是同一类东西。
 *
 * **为什么入参/返回值是一个状态对象，而不是把跨轮标记单独传进传出**：三审(a) 的
 * 第一版把 `justHealed` 做成"第五个入参 + 板块文件在每轮末尾自己用 `resetView`
 * 更新"，于是"上一轮的自愈不算这一轮的新内容"这条**跨轮规则**有一半落在板块文件
 * 里——而板块文件没有任何自动化覆盖。四审实测：把板块文件里那一行改成恒 `false`
 * （并重跑 `scripts/build-ui.mjs`，免得被逐字节漂移门禁冒充抓到），全套 1241 条
 * 用例**一条都不红**，包括当时专门为这条修复新写的那条端到端用例——因为那条用例
 * 用自己的局部变量把这半条规则**又抄了一遍**，测的是抄件不是原件。现在整条规则
 * （置位、清位、保持）都在这个函数里，板块文件只剩一次整体赋值，不再持有判据。
 *
 * 返回：
 * - **`resetView`**：`cursorAhead` 为 `true` 时视图必须跟着游标一起清空，不能只清
 *   游标——`mergeIntoView` 是纯 `[...inc, ...cur]`，不去重；不清视图的话，自愈之后
 *   下一轮冷读回来的是"最新"的一批，会跟视图里已经卡在"未来"、语义已经不可信的
 *   那一批拼在一起，造成整页重复（无条件，单次自愈就会触发）。
 * - **`hadNewItems`**：退避间隔要不要回到最短，**只能看服务端这次真的返回了几条**
 *   （`items.length > 0`），不能借用"游标变没变"当替身——原来的实现正是用
 *   `state.after !== beforeAfter` 当替身，自愈本身也会让游标变化（从非 null 变成
 *   null），于是"游标被清空"被误判成"来了新事件"，退避永远回不到最长间隔（评审
 *   实测：稳态吞吐从原先算好的那条包线涨到约两倍）。
 * - **`next`**：下一轮的完整状态，见 `initialPollState()` 的字段说明。
 *   - `after`：`nextAfter()` 叠加"游标自愈"——`cursorAhead` 为 `true` 时无条件重置
 *     为 `null`，不管 `cursor`/旧值算出来是什么。冻结在未来的游标不能继续带下去，
 *     下一轮必须变成冷读才能真正恢复。
 *   - `healing`：自愈时置位，**真正重新建立起游标**（`after` 从 `null` 变回一个
 *     数字）时清位，其余保持。见下面一段。
 *   - `delayMs`：`nextPollDelayMs(上一轮的间隔, hadNewItems)`。
 *
 * ⚠️ **`healing` 为什么是"自愈之后直到重新建立起游标为止"，不是"刚好上一轮"**
 * （评审四审 B2）：三审(a) 那一版写的是"只遮紧接着的一轮"，而**冷读状态会持续
 * 很多轮**——落后的那个 isolate 结构上看不见领先 isolate 写进未来窗口的事件，
 * 恒返回 `cursor: null`，`nextAfter()` 就把 `after` 一直留在 `null`。于是此后
 * **每一次**落到领先的 isolate，都会把同一批旧事件当成"新内容"，退避塌回 15 秒。
 * 四审逐轮实测（负载均衡每 4 轮才命中一次领先 isolate）：
 *
 *     0 B ahead=0 items=1 jhIn=0 new=1 gets=48 delay=15s   <- 旧事件被当成新内容
 *     1 A ahead=1 items=0 jhIn=0 new=0 gets= 0 delay=30s   <- 自愈
 *     2 A ahead=0 items=0 jhIn=1 new=0 gets=48 delay=60s   <- 旧规则只遮到这一轮
 *     3 A ahead=0 items=0 jhIn=0 new=0 gets=48 delay=60s
 *     4 B ahead=0 items=1 jhIn=0 new=1 gets=48 delay=15s   <- 又塌回去
 *
 * 稳态吞吐随之**只与"平均多少轮才命中一次领先 isolate"（记作 k）有关**，与"修没修
 * 三审(a)"几乎无关：旧规则下 k=3 / 4 / 6 / 8 实测 78,994 / 75,404 / 72,758 /
 * 71,680 次每天（k=2 的严格交替是唯一的例外，34,560，旧规则恰好也够用），
 * **k≥3 全部超出原先规划、五语言 DEPLOY.md 白纸黑字承诺的包线**。改成
 * "直到重新建立起游标为止"之后，退避在整个 k 轮周期里再也不会被塌回最短，稳态
 * 吞吐变成 `69,120 × (k−1) ÷ k + 1,440`：k=2 → 36,000、k=3 → 47,520、
 * k=4 → 53,280、k=6 → 59,040、k=8 → 61,920，**k 再大也只是从下方逼近 70,560，
 * 不会越过**（k→∞ 就是"没有时钟偏移"那条基准线本身，恰好等于 70,560）。
 *
 * ⚠️ 上面这一组数与那一行 `+1,440`（通读评审点出来的）：**每一轮轮询自己还会顺带
 * 触发一次配置读**（配置刷新中间件挂在所有路由之前，配置缓存 TTL 30 秒 < 稳态
 * 轮询间隔 60 秒 ⇒ 每轮恰好一次）。上一版的夹具用固定 holder，把这一项整个漏掉，
 * 于是那时写下的 34,560 / 46,080 / 51,840 / 57,600 / 60,480 与包线 69,120
 * **全部偏低 1,440**。
 * 这几个数字由 `tests/contract/events-cursor-heal.test.ts` 的
 * 「轮命中一次领先 isolate：稳态吞吐」那一组逐个钉住（连同 70,560 基准线本身，
 * 同文件的「基准线：没有时钟偏移时稳态就是 70,560 次/天」），不是只写在这里。
 *
 * ⚠️ **这两个指向原来写的是 `:224` / `:269`，两个行号都在本轮漂掉了**——
 * 那个文件只是加了几行注释。**行号会腐烂，名字不会**；两处都改成名字锚。
 *
 * **代价，明写，并且是可证的上界**：`healing` 为真的那一段里 `after` 恒是 `null`
 * （自愈把它清成 null，只有拿到非 `null` 的 `cursor` 才会变回数字），而后端契约是
 * `cursor` 非 `null` **当且仅当** `items` 非空（见 `events.ts` 的
 * `cursor: items.length > 0 ? items[0].ts : null`）。所以"清位"这件事发生在
 * **自愈之后第一份非空响应**那一轮上——夹在中间被遮住的那些轮次本来就是空的
 * （`hadNewItems` 不遮也是 `false`）。换句话说：**一次自愈只会让恰好一批 `items`
 * 不把退避顶回 15 秒**，与遮了多少轮无关；这批要么本来就是自愈时刚扔掉的那一批
 * （正是要遮的东西），要么是一批真的新事件——那种情况下代价是它晚一个退避周期
 * （≤60 秒）才被"盯着看"的人更快刷新到，事件本身该显示的照常显示，不影响正确性。
 * 这条上界由 `tests/ui/events.test.ts` 的"保持：自愈之后连续多轮冷读……"那条用例
 * 直接演示（5 轮空冷读全遮住 → 第一批非空也遮住并清位 → 再下一批正常回到 15 秒）。
 */
export function pollOutcome(prev, items, cursor, cursorAhead) {
  const state = prev && typeof prev === "object" ? prev : {};
  const healed = cursorAhead === true;
  const currentAfter = typeof state.after === "number" && Number.isFinite(state.after) ? state.after : null;
  const wasHealing = state.healing === true;
  const outcome = cursorOutcome(currentAfter, cursor);
  const nextAfterValue = healed ? null : outcome.after;
  // **`broken` 时不许把 `hadNewItems` 判成真** —— 那正是 `cursorOutcome()` 上那段写的 276,480 的直接
  // 成因：游标畸形 ⇒ 每轮都是冷读 ⇒ `items` 恒非空 ⇒ 退避每轮被顶回 15 秒。
  // 判据放在这里而不是板块文件里：它是跨轮状态转换，不是渲染（硬规则 1）。
  const hadNewItems = (wasHealing || outcome.broken)
    ? false
    : (Array.isArray(items) && items.length > 0);
  return {
    resetView: healed,
    hadNewItems,
    /** 后端这一轮吐的 `cursor` 不是「数字或 null」——面板必须说出去，不许显示成"正常"。 */
    cursorBroken: outcome.broken,
    next: {
      after: nextAfterValue,
      healing: healed ? true : (nextAfterValue !== null ? false : wasHealing),
      delayMs: nextPollDelayMs(
        typeof state.delayMs === "number" && Number.isFinite(state.delayMs) ? state.delayMs : EVENTS_POLL_MIN_MS,
        hadNewItems,
      ),
    },
  };
}

/**
 * 指数退避的下一个轮询间隔。**有新内容 ⇒ 立刻回到最短间隔**（运维正在盯着，
 * 让它尽快看见后续变化）；**没有新内容 ⇒ 翻倍，封顶到 `EVENTS_POLL_MAX_MS`**。
 */
export function nextPollDelayMs(currentDelayMs, hadNewItems) {
  if (hadNewItems) return EVENTS_POLL_MIN_MS;
  const doubled = currentDelayMs * 2;
  return doubled > EVENTS_POLL_MAX_MS ? EVENTS_POLL_MAX_MS : doubled;
}

/** 轮询状态指示灯该显示哪个状态。三态：暂停 / 出错 / 正常，暂停优先于出错。 */
export function pollIndicatorState(state) {
  if (state.paused) return "paused";
  if (state.lastError) return "error";
  return "active";
}

/** 轮询状态 → i18n key。三条各写一次字面量，好让 i18n 门禁扫得到（同 levelLabelKey）。 */
export function pollIndicatorLabelKey(kind) {
  if (kind === "paused") return "ev.pollStatus.paused";
  if (kind === "error") return "ev.pollStatus.error";
  return "ev.pollStatus.active";
}

/**
 * 搜索框的过滤判据。匹配 `event` / `msg` / `corr` / 字段值（不区分大小写的子串匹配）。
 * `q` 为空串时一律匹配（不筛）。
 */
export function matchesSearch(item, q) {
  const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
  if (needle === "") return true;
  if (!item || typeof item !== "object") return false;
  const haystack = [
    typeof item.event === "string" ? item.event : "",
    typeof item.msg === "string" ? item.msg : "",
    typeof item.corr === "string" ? item.corr : "",
    item.fields && typeof item.fields === "object" ? JSON.stringify(item.fields) : "",
  ].join(" ").toLowerCase();
  return haystack.includes(needle);
}

/**
 * `fields` 对象格式化成一行文本，供渲染时整体塞进一个 `textContent`。
 * **值一律不可信**（可能是攻击者能控制的内容），但这里只做展示格式化，
 * 不做转义/截断——由调用方统一走 `textContent`，不解析成 HTML。
 */
export function formatFields(fields) {
  if (!fields || typeof fields !== "object") return "";
  return Object.entries(fields).map(([k, v]) => `${k}=${v === null ? "null" : String(v)}`).join(" ");
}

/**
 * 一条事件"说明 / 字段"列要显示的文本（评审提出：原来这是 `sec-events.js` 里的
 * 纯取值函数，零测试覆盖，搬进来）。`msg` 与格式化后的 `fields` 用 `·` 连接，
 * 缺一段就不留多余的分隔符。
 */
export function buildDetailText(item) {
  const msg = item && typeof item === "object" && typeof item.msg === "string" ? item.msg : "";
  const fields = item && typeof item === "object" && item.fields && typeof item.fields === "object"
    ? formatFields(item.fields) : "";
  return [msg, fields].filter((s) => s !== "").join(" · ");
}

/**
 * 按 `corr` 相邻折叠成时间线。**只折叠相邻的**（不是全局按 corr 分组）——
 * 与设计意图一致：同一次操作打出的几条事件在时间上天然挨在一起，
 * 隔着别的事件的两条同名 corr 更可能是巧合，不该被强行拼进同一条时间线。
 *
 * 本期几乎没有事件带 `corr`（要等注册机把它串进来才有），**无 corr 的每条都是独立的单条组**
 * ——这条函数在"一个 corr 都没有"时必须一样能正确工作
 * （见 `tests/ui/events.test.ts` 的「groupEvents：按 corr 相邻折叠」那一组）。
 */
export function groupEvents(items) {
  if (!Array.isArray(items)) return [];
  const groups = [];
  for (const item of items) {
    const corr = item && typeof item === "object" && typeof item.corr === "string" && item.corr !== ""
      ? item.corr : null;
    const last = groups[groups.length - 1];
    if (corr !== null && last && last.corr === corr) {
      last.items.push(item);
    } else {
      groups.push({ corr, items: [item] });
    }
  }
  return groups;
}

/** 后端给的是 ts 降序（最新在前）；面板要"自动滚动"到最新，按时间正序（旧→新）展示。 */
export function orderForDisplay(items) {
  return Array.isArray(items) ? [...items].reverse() : [];
}

/**
 * 把新拉到的一批（ts 降序，且全部比 `existing` 里任何一条都新——由 `after` 游标保证）
 * 并入客户端已经攒下的视图。**新的在前**，保持整体仍是 ts 降序，与后端契约一致，
 * 只在渲染前的最后一步（`orderForDisplay`）才反转成正序。
 */
export function mergeIntoView(existing, incoming) {
  const inc = Array.isArray(incoming) ? incoming : [];
  const cur = Array.isArray(existing) ? existing : [];
  return [...inc, ...cur];
}
