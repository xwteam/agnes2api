/**
 * 模型板块（设计文档 §10.7 / §11）：三张卡 ——
 * ① **模型目录**（一张只读表：模型 ID / 类型（字段名 `modality`）/
 *    协议可用性矩阵（四个徽章）/ 端点），来自本仓写死的协议目录，零网络出站；
 * ② **上游模型**（一颗按钮 + 这次拉回来的清单与两个方向的差集），
 *    它拿池里的一把 key 去真打一次上游；
 * ③ **模型测试**（一颗按钮 + 一张「模型 / 结果 / 延迟」表），
 *    逐个模型向上游真发一次最小对话请求，串行跑。
 *
 * ⚠️⚠️ **三张卡回答的是三个问题，谁也不替代谁**：① 是「**本网关**支持什么、怎么调」，
 * ② 是「**上游账号**此刻有什么」，③ 是「**这一刻这个模型通不通、多快**」。
 * 上游那份没有协议归属、没有端点，拿它替掉目录会让集成示例 / 调试台 / 这张表
 * 一起失去所有可照抄的调用方式；而一个模型出现在 ② 的清单里、与它在 ③ 里真的能出话，
 * 同样是两件事（前者是账号的权限表，后者是这一刻的链路）。
 * 后端那两半的全文在 `src/core/admin/upstream-models.ts`
 * 与 `src/http/admin/handlers/model-test.ts` 的文件头。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * ── **本板块是「消费协议目录」这条路径的第一个前端消费者** ────────────────────
 * 核心设计决定（全局约束 15）：四个消费者只许有一份「怎么调这个网关」的知识。
 * ⇒ **本文件的可执行代码里没有任何一条对外端点路径、没有任何一个协议 id、
 *    也没有任何一份请求体形状**（admin 路径有两条，`api.get("/models")` 与
 *    上游那条，它们为什么不算第二份知识，见本文件头「那两条 admin 路径
 *    为什么不算第二份端点知识」那一段）。
 * 协议 id 与展示名来自响应的 `protocols[]`，端点原样搬运响应的 `endpoints[]`，
 * 连「视频模型是两段式」这件事都是数出来的、不是写死的。
 *
 * ⚠️ **端点那一列一个字符都不在前端拼。** 视频模型那一行会有两条（一次创建 +
 * 一次查询），**两条都要画**——只画一条就是把两段式教成一段式，而运维照着面板
 * 写出来的客户端会永远拿不到结果。由 `tests/ui/dom/models-section.test.ts` 的
 * 「视频模型那一行同时列出两条端点 —— 只显示一条就是把两段式教成一段式」那一格钉着。
 *
 * ⚠️ **别把「本文件没写端点」读成「前端从此不可能硬编码端点」**：
 * `tests/ui/no-hardcoded-endpoints.test.ts` 的
 * 「已知抓不住的写法确实抓不住（边界是断言，不是散文）」那一组自己登记着一条盲点
 *（**字符串拼接**：一条路径被拆成两截、分写在两对引号里，扫字面量的判据按定义
 * 看不见它）。那道扫描挡住的是**顺手写下一条路径**，不是**刻意绕开**。
 *
 * ── 三条纪律（与其余六个板块相同）──────────────────────────────────────────
 * ① 一切来自接口的内容一律 textContent（`el()` 走的就是它）：模型 id 与端点路径
 *    虽然今天来自本仓写死的目录，但它们是**经过一次网络往返**才到这里的；
 * ② **取值决策一律不写在这里**，全在 `js/pure/models.mjs` 里（admin-ui/README.md 硬规则 1）；
 * ③ **一切形态分支只读接口返回的字段**，不许自己嗅探运行时（全局约束 1）。
 *
 * ── 为什么没有刷新按钮，而错误横幅上却有一颗 ────────────────────────────────
 * 工具栏上**没有刷新按钮**（设计 §10.7：agnes 的模型是硬编码的，
 * 没有「跨账号刷新」这个动作）——那颗按钮会承诺一个不存在的语义。
 * 错误横幅上那颗**不是刷新，是「再读一次」**：它治的是一次读取失败，不是「数据变了」。
 * ⚠️ **上游那张卡上的按钮是第三种东西，别与这两句混起来**：它是「去问一次上游」，
 * 而上游的清单**真的会变**（换一把权限不同的 key、上游上下线一个模型）。
 * 目录那一半今天仍然没有刷新按钮，那句话没有作废。
 * 少了它，一次网络抖动会让这个板块在本次会话里一直停在错误页上
 *（`onShow()` 虽然会重试，但那要求用户先猜到「切走再切回来」这个动作）。
 *
 * ── 在飞的读只许有一条，**这是被守着的**（订正） ──────────────────────────────
 * ⚠️⚠️ **这一段原来写的是「本板块没有在飞请求的作废条件……它只有一条异步链……
 * 回来晚了的那一份写进去也不会是过期数据」，那三句里有两句是假的**
 *（评审 Important 1，已实测）：
 * · **「只有一条异步链」是假的**：`load()` 有**两个**入口——`onShow()`（`catalog === null`
 *   时）与错误横幅上那颗「再读一次」（那颗按钮不禁用、当时也没有重入护栏）。
 *   第一条读**还在飞着**时切走再切回来，`catalog` 仍是 `null` ⇒ 第二条链就发出去了。
 * · **「回来晚了的那份不会是过期数据」只对成功响应成立**：`catch` 分支把 `catalog`
 *   清成 `null`，于是一条晚到的**失败**会把**已经画好的正确的表**抹成「读不出来」。
 *   这一步在原推理里整个缺失。实测探针（修复前）：
 *   `calls=2 rowsAfterSuccess=4 rowsAfterLateFailure=0`。
 * ⇒ 治的是**根因**：`load()` 开头那条 `inFlight` 早退，**隐式入口不再发第二条链**。
 * 由 `tests/ui/dom/models-section.test.ts` 的
 * 「在飞的读还没回来就切走再切回来：不许发出第二条读 —— 两条链并存正是那条晚到失败的来源」
 * 与「晚到的失败不许把已经画好的表抹掉 —— 表已经画好了，那次失败什么新东西都没说」两格钉着。
 *
 * ⚠️⚠️ **这条不变量是有代价的，写清楚（复评发现，这是本文件自己立的规矩）**：
 * `admin-ui/js/api.js` 这条链**没有超时**（`raw()` 的 `signal` 只透传调用方给的），
 * 所以一条读可以永远飞着。上一版的 `inFlight` 是**裸早退、不调 `render()`**
 * ⇒ 挂住之后每一次 `onShow()` 都什么都不画，终局是**只剩标题和副标题的空板块**
 *（实测 `calls=1 rows=0 banner=0 retry=0 unknown=0`），
 * 而上面那句「切走再切回来」的恢复动作**当场失效**。
 * ⚠️ **控制端原本裁定的 `sec-usage.js` 那套没有这个毛病**：它每次 `load()` 都
 * `if (abort) abort.abort()` 再发，**重发即自救**。我用一条更强的不变量换掉了一条恢复性质，
 * 上一版**只写了收益、一个字没写代价**——那正是本文件两处「⚠️ 但要写清代价」要防的事。
 * ⇒ **现在两条都保住**：隐式入口（`onShow()`）在飞时**只 `render()` 不发请求**
 *（挂住时至少看得见「读不出来」+「再读一次」），
 * 而那颗「再读一次」**有权抢占**（`load(true)`：abort 掉旧的再发）。
 * 剩下的代价如实登记：**首次读挂住、且用户一次都没切回来过时，板块仍是空白的**
 *（那一刻还没有任何 `render()` 发生过）——今天不加「加载中」那一档，
 * 因为它要一个新的 UI 状态 + 新的 i18n key，而挂住本身是个真机才见得到的低频事件。
 *
 * ⚠️ **为什么不是 `admin-ui/js/sec-usage.js` 那整套**
 *（**与评审裁定有出入，明写，理由是实测出来的**）：
 * ⚠️ 先把那一套说全（复评：上一版把它概括成「最新的一条赢的世代号」，**漏了一半**）——
 * 它是**两件东西**：`AbortController`（每次 `load()` 先 `abort()` 上一条）**加**
 * `seq` / `detailSeq` 两个世代号。这里没照搬的是**「每次都无条件重发」**那一半；
 * abort + 世代号本身，本文件在抢占那条路上用的就是它。
 * 具体到「最新的一条赢」这条规则：
 * 那套规则的前提是「新数据取代旧数据」，而这份目录**是静态的**。
 * 在上面那个序列里，**成功的恰恰是先发的那一条**（世代号更小）⇒ 世代号会把它整份丢掉、
 * 转而认后发的那条**失败**为最新结果 ⇒ 终局仍然是一张「读不出来」的页面。
 * 实测：装上世代号之后，上面第二格从「表被抹掉」变成
 * 「**前置条件：成功的那一条得先把表画出来** expected +0 to be 4」——**它照样不绿**，
 * 而第一格（`calls` 仍是 2）连动都没动。
 * ⇒ **被否掉的是「每次 `load()` 都无条件重发、最新的一条赢」这条规则**，不是世代号本身。
 *
 * ⚠️ **上一版这里接着写「装上 `inFlight` 之后世代号还会是一段永不触发的代码」，
 * 那句在本轮已经变成假话，本轮一并改真**：那条复评发现之后那颗「再读一次」**有权抢占**
 *（`load(true)`），**抢占就会造出一条被作废的链** ⇒ 世代号现在有真实的触发路径，
 * 由「读挂住时点「再读一次」：旧的那条被抢占，它晚到的失败不许盖掉新的成功」那一格钉着。
 * ⭐ 记一条形状：**一句「今天用不上它」的话，会被同一个文件后来的改动推翻**——
 * 这已经是本任务第二次（上一次是「只有一条异步链」）。写这类话时先问一句
 * **「什么改动会让它变假」**，并且把那句话放在离它所描述的代码最近的地方。
 *
 * ── 触屏上「可用 / 不可用」只剩颜色一条线索（**已知不达标，另行登记**）────────────
 * ⚠️⚠️ 徽章的状态今天由三样东西表达：颜色（`.badge-ok` vs 中性灰）、
 * `title` 那句整话、以及 `data-available`。**但触屏没有 hover** ⇒ `title` 出不来；
 * 而 `data-available` 是 data 属性，**用户根本看不见**（上一版报告把它写成
 * 「触屏用户仅有的两条线索」之一，那句是错的）。
 * ⇒ **触屏上只剩颜色一条**，这是 WCAG 1.4.1（Use of Color）的正面不达标。
 * 那根 EM DASH 也同理靠 `title` + `cursor: help`，不过它那一半被**同屏的红条
 * 与「再读一次」按钮**缓解了，徽章这一半没有。
 * **本任务不在这里单独改**：`.badge` / `.badge-ok` / `.badge-warn` / `.badge-danger`
 * 是全仓四个板块共用的一套 tooltip-only 继承问题，只在模型板块改反而制造不一致。
 * **登记给后续统一处理**（做法之一：给徽章加一个不依赖 hover 的可见记号）。
 * ⚠️ 这条写在这里而不是只写在报告里，理由是本任务自己立过的那条：
 * **那些评审报告不随仓库推送（它们所在的目录被 `.gitignore` 排除），
 * 只写在报告里等于没写。** ⚠️ 这句话本身也不许指名道姓地写出那个目录：
 * 本文件会被 `scripts/build-ui.mjs` 原样搬进 `src/ui/assets.generated.ts`
 * 并随公开仓发出去，而公开仓的读者打不开一个不在仓里的路径
 *（通读评审 LOW）。
 *
 * ── 那两条 admin 路径为什么不算「第二份端点知识」 ─────────────────────────────
 * 全局约束 15 管的是「怎么调**这个网关**」那张对外面（`/v1`、请求体形状、鉴权头），
 * 不是「怎么够得着那份真源」。`sec-usage.js` 已经写着同样的 `api.get("/models")` 与
 * `api.get("/capabilities")`，本文件与它同一条边界；上游那条同理，
 * 它的路径是 admin 面的，**上游自己那条列模型路径一个字符都不在前端**
 *（那一段拼接全在 `src/http/admin/handlers/upstream-models.ts` 里）。
 * ⚠️ **但要写清代价：这条 admin 路径今天没有任何机器在守**
 *（`tests/ui/no-hardcoded-endpoints.test.ts` 的正则只认 `/v1` 开头的对外路径）。
 * 本文件头开头那句「可执行代码里没有任何一条对外端点路径」说的是**那张对外面**，不是这一条。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n } from "./ui.js";
import { fmtDash, fmtCount } from "./pure/format.mjs";
import {
  protocolBadges, filterByProtocol, catalogProtocols, catalogModels, modalityLabelKey,
  upstreamModelsView, upstreamResultCode, upstreamTransportCode, upstreamLabelKey,
} from "./pure/models.mjs";
import {
  testableModels, initTestRows, withRowActive, withRowResult, testProgress,
  rowStatusLabelKey, modelTestResultCode, modelTestTransportCode,
  nextTestDelayMs, testRoundMinSec,
} from "./pure/model-test.mjs";

let nodes = null;
/**
 * 窄化之后的目录。`null` = **还没读到 / 读不出来**，两者在渲染上是同一档
 *（都还不知道这个网关认得哪些模型），区别只在「有没有人已经发过那次请求」。
 */
let catalog = null;
/** 当前选中的协议 id；`""` = 「全部」那一档。**取值来自响应，不是本地枚举。** */
let filter = "";
/**
 * 这一刻有没有一条读在飞。
 *
 * ⚠️ **它是本板块并发护栏的「两条之一」，不是唯一的那一条**
 *（定向复评，实测订正）：另一条是 `onShow()` 里的
 * `if (catalog !== null) { render(); return; }`。
 * 实测反例：**留着本变量不动**、只删掉 `onShow()` 那一行 ⇒ 表照样被抹
 *（`rows 4→0, unknown 0→1, calls 1→2`）。上一版这里与 `load()` 的 catch 上方
 * 都写着「唯一」，**那句话把下一个人指向了两条守卫里的一条**。
 *
 * ⚠️ 它同时兜住了另一件事：错误横幅上那颗「再读一次」**不禁用**，
 * 连点两下会发出两条链——现在第二下走的是抢占那条路（见 `load()` 的 `preempt`）。
 */
let inFlight = false;
/**
 * 在飞请求的世代号。**上一轮刻意没有它，这一轮它有了真实的触发路径**：
 * 「再读一次」可以**抢占**一条挂住的读（复评发现），于是被抢占的那条必须作废。
 * 没有它的话，被抢占的那条晚到的结果会盖掉新发那条的结果——
 * 这正是评审 Important 1 那个缺陷换了个入口重演一遍。
 */
let seq = 0;
/**
 * 在飞那条读的取消器。**它省的是一次真实的网络往返，不是作废判据**——
 * 作废判据是上面那个世代号。
 *
 * ⚠️⚠️ **abort 这一半在测试里天然不可观测，写清楚**（复评发现）：
 * 全仓只有 `admin-ui/js/api.js` 一处把 `signal` 交给 `fetch`，而
 * `tests/ui/dom/harness.ts` 的 `fetch` 替身**零处**看它 ⇒ 被 abort 的那条链
 * 在测试里照样会落地。**别把「那两格绿了」读成「abort 被钉住了」**——
 * 它们钉的是世代号。真实浏览器里 abort 让那条链以 `AbortError` 拒绝，
 * 世代号在 catch 里同样把它挡在外面，两种环境走的是同一条判据。
 */
let abort = null;
/**
 * 「上游模型」那张卡的状态机。**四档，恒有一档**：
 * `idle` 还没查过 / `loading` 在飞 / `ok` 查回来了 / `error` 这次没查成。
 *
 * ⚠️⚠️ **`idle` 与 `ok` 且清单为空**是两句完全不同的话，所以它们**不共用一档**：
 * 前者是「我们还没问过上游」，后者是「问过了，上游这次一个都没回」。
 * 合成一档的话，一张什么都没查过的卡会对运维说一句关于上游的事实（全局约束 9 的同型）。
 *
 * `code` 是 `js/pure/models.mjs` 那两个 code 函数的产物，`status` 只在
 * `upstream_error` 那一档有意义（上游回了几）。`view` 是窄化之后的清单。
 */
let up = { state: "idle", code: null, status: null, view: null };
/**
 * 「模型测试」那张卡的状态。
 *
 * `rows === null` = **这一次进面板以来还没测过**，与「测过了、一行都没通」是两句
 * 完全不同的话，所以它们不共用一档（与上面 `up` 的 `idle` / `ok` 是同一条纪律）。
 * 每一行自己的三态（待测 / 进行中 / 回来了）在 `js/pure/model-test.mjs` 里。
 *
 * ⚠️ **`running` 是本板块这一侧的护栏，不是唯一那道**：后端那把 ProbeGuard
 * 才是「这台网关」级别的闸（两个标签页、一条 curl 循环都绕得过这里，绕不过它）。
 * 理由全文在 `src/http/admin/handlers/model-test.ts` 的文件头不同点 ③。
 *
 * `waiting` = **这一刻正卡在两条之间的那段最小间隔上**（`running` 恒为 `true`）。
 * ⚠️⚠️ **它不是一个可有可无的装饰位，它是这一轮加间隔的另一半**：一轮现在要二十几秒，
 * 其中大半时间**一条请求都没在飞、一行状态都不会变**。屏幕上不说这件事的话，
 * 那几秒与一个挂死的面板长得一模一样，而这张卡的进度文案本来就是照着
 *「几十秒里运维得看得见它在动」写的。见 `testCard()` 里那颗按钮的文案。
 */
let test = { rows: null, running: false, waiting: false };

/**
 * 单纯等一段时间。**只有 `runTests()` 用它**。
 *
 * ⚠️ **它没有取消口**：整轮没有中途退出的条件（理由与代价在 `runTests()` 上方），
 * 加一个取消口而不加那条早退，只会多出一条「等着的那一条被取消、但请求照样发」的路。
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 一个内容块：标题 + 空的 body 容器。 */
function block(titleKey) {
  const wrap = el("div", { class: "card block" });
  wrap.appendChild(elI18n("h3", titleKey));
  const body = el("div");
  wrap.appendChild(body);
  return { wrap, body };
}

/** 一行「表头」。 */
function headRow(keys) {
  const tr = el("tr");
  for (const k of keys) tr.appendChild(elI18n("th", k));
  return tr;
}

/**
 * 「按协议筛选」的分段选择器。**复用事件 / 用量板块那套 `.btn-group` / `.btn-toggle`**，
 * 不新起一套 class：三个板块的这个控件在交互与外观上是同一件东西，各写一份迟早长得不一样。
 *
 * ⚠️ **档位由响应里的 `protocols[]` 生成，本文件不认识任何一个协议 id。**
 * 「全部」那一档的值是空串 —— 它不是一个协议，所以它没有 id、也不从响应里来。
 */
function buildFilterBar() {
  const wrap = el("div");
  const bar = el("div", { class: "btn-group" });
  bar.appendChild(elI18n("span", "models.filter.label", { class: "muted" }));

  // ⚠️ **`aria-pressed` 与 `.active` 是同一件事的两条腿**：`.active` 只改颜色（外加一条
  //    加粗），读屏用户拿不到；四个板块的这套控件写法一致，别在这里另发明一种。
  const all = elI18n("button", "models.filter.all", {
    type: "button", class: "btn-toggle", "data-protocol": "",
    "aria-pressed": filter === "" ? "true" : "false",
  });
  all.classList.toggle("active", filter === "");
  all.addEventListener("click", () => { if (filter !== "") { filter = ""; render(); } });
  bar.appendChild(all);

  for (const p of catalog.protocols) {
    // 展示名走响应里的 `label`（协议的专名，**刻意不进 i18n**，理由见
    // `src/core/admin/protocol-catalog.ts` 里 `label` 字段上方那一行）。
    // 三条都不许走：本地再写一张映射、把 id 拼进一个 i18n key、直接渲染裸 id。
    const btn = el("button", {
      type: "button", class: "btn-toggle", "data-protocol": p.id,
      "aria-pressed": filter === p.id ? "true" : "false",
    }, p.label);
    btn.classList.toggle("active", filter === p.id);
    btn.addEventListener("click", () => { if (filter !== p.id) { filter = p.id; render(); } });
    bar.appendChild(btn);
  }
  wrap.appendChild(bar);
  return wrap;
}

/**
 * 一行的协议可用性矩阵。**四个格子恒在**，不可用的画成灰徽章。
 * 判定在 `js/pure/models.mjs` 的 `protocolBadges()`，这里只负责把它画出来
 * ——让板块文件自己目测 `model.protocols.includes(...)` 就等于把判定抄回了 DOM 代码。
 */
function badgeCell(model) {
  const td = el("td");
  for (const b of protocolBadges(model, catalog.protocols)) {
    // ⚠️ tooltip 的两个 key **写成三元里的两个字面量**，不是拼出来的
    //（全局约束 12。⚠️ 上一版这里写的是「动态拼 key 会让三道 i18n 门禁一起哑」，
    // 那句话今天是假的：第 ④ 条已升成硬错 ⇒ 拼出来的话这两个
    // **正在用**的 key 会落进「未被引用」并把 CI 打红，别拼的理由比当初更硬）。
    const tip = b.available ? t("models.badge.yes") : t("models.badge.no");
    // ⚠️ **不可用那一档带的是 `.badge-off`，不是一个换了名字的同义类**：
    //    `admin-ui/css/sections.css` 里 `.badge-danger` 下面那段注释逐字裁过
    //    「别加一个取值与 `.badge` 逐字相同的同义类」，所以 `.badge-off` 只声明
    //    **一条非颜色属性**（删掉它那条 `text-decoration`，models 板块的用例当场红）。
    // ⚠️ **上一版这里写着「刻意不加任何修饰类，灰 = 不可用、绿 = 可用」，那句话是这条
    //    WCAG 1.4.1 缺陷本身**：两个徽章的可见文字逐字相同（都是协议专名），
    //    差别只有颜色 + hover 才出得来的 `title` + 读不出来的 `data-available`
    //    ⇒ 触屏与色觉障碍用户拿不到状态（真机实测：触屏长按 1.2s
    //    之后 DOM 无任何变化，也没有任何 `[role="tooltip"]` 节点）。
    // ⚠️ **`textContent` 一个字不许动**：徽章上写的是协议的专名不是状态名，
    //    而且 `tests/ui/dom/models-section.test.ts` 有一张手写的 label 期望表。
    // ⚠️ `title` 那句话仍然留着：它是鼠标与读屏那两条路上的状态文本，与这条类不冲突。
    const span = el("span", {
      class: b.available ? "badge badge-ok" : "badge badge-off",
      "data-protocol": b.id,
      "data-available": b.available ? "yes" : "no",
      title: `${b.label} — ${tip}`,
    }, b.label);
    td.appendChild(span);
  }
  return td;
}

/**
 * 端点那一列。**原样搬运响应里的 `method` 与 `path`，一个字符都不在前端拼。**
 * 一条端点一行——挤在一行里的话视频模型那两条会被读成一条带斜杠的长路径。
 */
function endpointCell(model) {
  const td = el("td");
  for (const e of model.endpoints) {
    td.appendChild(el("div", { class: "mono models-endpoint" }, `${e.method} ${e.path}`));
  }
  return td;
}

/** 类型那一格。表外的形态**照实显示原值**，不冒充任何一档已知形态。 */
function modalityCell(model) {
  const key = modalityLabelKey(model.modality);
  const td = el("td");
  td.appendChild(key === null ? el("span", { class: "mono" }, model.modality) : elI18n("span", key));
  return td;
}

function buildTable(rows) {
  const { wrap, body } = block("models.table.title");
  if (rows.length === 0) {
    // ⚠️ **「这条协议上一个模型都没有」与「这个网关一个模型都没有」是两句话**，
    //    而它们都不是「读不出来」（那一档根本走不到这里，见 `render()` 的早退）。
    body.appendChild(elI18n(
      "p", filter === "" ? "models.empty" : "models.filterEmpty", { class: "muted note" },
    ));
    return wrap;
  }
  const table = el("table");
  table.appendChild(headRow([
    "models.col.id", "models.col.modality", "models.col.protocols", "models.col.endpoints",
  ]));
  for (const m of rows) {
    const tr = el("tr", { class: "models-row", "data-model": m.id });
    tr.appendChild(el("td", { class: "mono" }, m.id));
    tr.appendChild(modalityCell(m));
    tr.appendChild(badgeCell(m));
    tr.appendChild(endpointCell(m));
    table.appendChild(tr);
  }
  body.appendChild(table);
  return wrap;
}

/**
 * 一组模型 id：一行小标题 + 一排等宽的 id。**空数组不画**，由调用方决定那一档说什么
 * ——「这一组是空的」在三处的含义各不相同（没有多出来的 / 没有漏掉的 / 上游没回）。
 */
function idList(labelKey, ids, group) {
  const wrap = el("div", { class: "models-up-group", "data-group": group });
  // ⚠️ **小标题走 `t(key, params)` 而不是 `elI18n`**：三个 key 各自带一个 `{n}`，
  //    而 `elI18n` 内部调的是不带参数的 `t()` ⇒ 屏幕上会出现裸的占位符
  //   （`scripts/check-i18n.mjs` 第 ⑧ 条对 `elI18n` 的中间参数结构性地看不见，
  //    它拦不住这个错，所以这句写在这里）。
  wrap.appendChild(el("div", { class: "muted note" }, t(labelKey, { n: ids.length })));
  const list = el("div", { class: "models-up-list" });
  // 每个 id 画成一颗中性灰的 chip（复用 `.badge` 的底样式，**不新起一套**）：
  // 一排纯文本 id 之间只有空格，长 id 挨在一起会被读成一条串。
  for (const id of ids) list.appendChild(el("span", { class: "mono badge", "data-up-id": id }, id));
  wrap.appendChild(list);
  return wrap;
}

/**
 * 「上游模型」那张卡。**它与上面那张目录表并存，不替换它**：
 * 目录讲「本网关支持什么、拿什么端点去调」，这里讲「上游账号此刻回了什么」。
 * 上游那份**没有协议归属、也没有端点**，拿它替掉目录等于把矩阵和端点列一起抹掉。
 * ⇒ 两份并存，并且把**两个方向的差集**都画出来。
 *
 * ⚠️ **没有自动加载，只有一颗按钮。** 这条读会拿池里的一把 key 去真打一次上游
 *（全局约束 14：按一下就打上游的按钮必须自带告知与护栏）。挂在 `onShow()` 上的话，
 * 每切一次板块就打一次上游，而运维根本没要求过这件事。
 * 告知写在卡的说明里（`models.up.desc`），护栏由后端那把与验活共用的 ProbeGuard 兜底，
 * 面板这一侧再加一条：在飞时按钮 `disabled`，且 `loadUpstream()` 开头有早退。
 * ⚠️ **早退那条才是护栏**：`disabled` 在 `tests/ui/dom/fake-dom-parity.test.ts` 的
 * `KNOWN_BLIND_SPOTS` 里挂着（「`.disabled` 挂错宿主」），DOM 用例观测不到它。
 */
function upstreamCard() {
  const { wrap, body } = block("models.up.title");
  body.appendChild(elI18n("p", "models.up.desc", { class: "muted note" }));

  const btn = elI18n("button", "models.up.load", { type: "button", class: "models-up-btn" });
  btn.disabled = up.state === "loading";
  btn.addEventListener("click", () => { loadUpstream(); });
  body.appendChild(btn);

  if (up.state === "loading") {
    body.appendChild(elI18n("p", "models.up.loading", { class: "muted note" }));
    return wrap;
  }

  if (up.state === "idle") {
    // 一根破折号 + **一句看得见的话**。那句话刻意不写进 `title`：hover-only 的提示
    // 在触屏上根本出不来（`.badge` 那一族的同型问题在本文件头已登记），
    // 而「还没查过」正是最容易被误读成「上游没有模型」的一档。
    const p = el("p", { class: "models-up-idle" });
    p.appendChild(el("span", { class: "models-up-dash" }, fmtDash(null)));
    p.appendChild(elI18n("span", "models.up.idle", { class: "muted" }));
    body.appendChild(p);
    return wrap;
  }

  if (up.state === "error") {
    const banner = el("div", { class: "banner-danger", role: "status" });
    banner.appendChild(el("span", { "data-up": "msg" }, t(upstreamLabelKey(up.code))));
    // 状态码**另起一句**，不拼进上面那句：`upstreamLabelKey()` 交出来的每一个 key
    // 都不许带 `{占位符}`（那些字面量后面跟的是 `;`，`scripts/check-i18n.mjs`
    // 第 ⑧ 条会当场红），而「上游回了几」只在 `upstream_error` 那一档有意义。
    if (up.status !== null) {
      banner.appendChild(el("span", { class: "models-up-status", "data-up": "status" }, t("models.up.status", { status: up.status })));
    }
    body.appendChild(banner);
    return wrap;
  }

  const v = up.view;
  body.appendChild(el("p", { class: "muted note", "data-up": "msg" }, t(upstreamLabelKey("ok"))));
  if (v.truncated) {
    // ⚠️ **条数取的是「这次拿到手的那份」的长度，不在前端写一个上限常量**：
    // 上限是后端的（`src/core/admin/upstream-models.ts`），抄一份就会漂。
    const warn = el("div", { class: "banner-warn", "data-up": "truncated" });
    warn.appendChild(el("p", {}, t("models.up.truncated", { n: v.ids.length })));
    body.appendChild(warn);
  }
  body.appendChild(idList("models.up.listLabel", v.ids, "ids"));

  if (v.onlyUpstream.length === 0 && v.onlyCatalog.length === 0) {
    body.appendChild(elI18n("p", "models.up.diffNone", { class: "muted note" }));
  } else {
    if (v.onlyUpstream.length > 0) body.appendChild(idList("models.up.onlyUpstream", v.onlyUpstream, "onlyUpstream"));
    if (v.onlyCatalog.length > 0) body.appendChild(idList("models.up.onlyCatalog", v.onlyCatalog, "onlyCatalog"));
  }
  return wrap;
}

/**
 * 向上游查一次模型清单。**只有那颗按钮会调它**，没有任何隐式入口。
 *
 * ⚠️ **两类失败落在两个函数上**：200 的响应体走 `upstreamResultCode()`，
 * 非 2xx（`js/api.js` 抛的 `ApiError`）走 `upstreamTransportCode()`。
 * 混成一个的后果在 `js/pure/models.mjs` 那两段上方写着：护栏的 429 会被说成「上游出错了」，
 * 而那一次**一个出站请求都没发生过**。
 */
function loadUpstream() {
  if (up.state === "loading") return;
  up = { state: "loading", code: null, status: null, view: null };
  render();
  api.get("/upstream/models")
    .then((body) => {
      const code = upstreamResultCode(body);
      const view = code === "ok" ? upstreamModelsView(body.models) : null;
      up = {
        state: code === "ok" ? "ok" : "error", code,
        status: body && typeof body.status === "number" ? body.status : null, view,
      };
    })
    .catch((e) => {
      up = { state: "error", code: upstreamTransportCode(e), status: null, view: null };
    })
    .then(() => { render(); });
}

/**
 * 「模型测试」那张卡。**它与上面两张并存**，理由见本文件头那三句。
 *
 * ⚠️ **没有自动加载，只有一颗按钮**（全局约束 14：按一下就打上游的按钮必须自带告知
 * 与护栏）。挂在 `onShow()` 上的话，每切一次板块就把整份模型清单向上游打一遍。
 * 告知写在卡的说明里（`models.test.desc`，它把「每一行都真的打一次上游」和
 * 「为什么只测对话模型」两句都说了），护栏由后端那把与验活共用的 ProbeGuard 兜底，
 * 面板这一侧再加两条：跑的时候按钮 `disabled` + 显示进度，以及 `runTests()` 开头的早退。
 * ⚠️ **早退那条才是护栏**：`disabled` 在 `tests/ui/dom/fake-dom-parity.test.ts` 的
 * `KNOWN_BLIND_SPOTS` 里挂着（「`.disabled` 挂错宿主」），DOM 用例观测不到它。
 */
function testCard() {
  const { wrap, body } = block("models.test.title");
  body.appendChild(elI18n("p", "models.test.desc", { class: "muted note" }));

  // 目录读不出来时，连「有哪些模型可测」都不知道 ⇒ 画一根破折号 + 那句**看得见的**话。
  // ⚠️ **不许在这一档画一颗按钮**：按下去只会发出零个请求，而屏幕上什么都不会变。
  if (catalog === null) {
    const p = el("p", { class: "models-test-idle" });
    p.appendChild(el("span", { class: "models-up-dash" }, fmtDash(null)));
    p.appendChild(elI18n("span", "models.unavailable", { class: "muted" }));
    body.appendChild(p);
    return wrap;
  }

  // 🔴 **哪些模型进这一轮由 `js/pure/model-test.mjs` 决定**（图片 / 视频一个都不进），
  //    这里不自己判 `modality`——把那条硬边界抄回 DOM 代码就是硬规则 1 要防的事。
  const ids = testableModels(catalog.models);
  if (ids.length === 0) {
    // ⚠️ 「目录里一个模型都没有」与「目录里没有能这么测的模型」是两句话：
    //    图片与视频模型确实在目录里，只是这颗按钮不许碰它们。
    body.appendChild(elI18n("p", "models.test.empty", { class: "muted note" }));
    return wrap;
  }

  // 整轮**至少**要多少秒，先把话说在前面：一轮二十几秒，事先不说的话运维会
  // 在第一段间隔里就以为它卡住了。⚠️ 那个数由 `js/pure/model-test.mjs` 算，
  // 这里不自己乘一遍（硬规则 1），也不改口说成「大约」——它只算得出间隔那几段。
  const etaSec = testRoundMinSec(ids.length);
  if (etaSec > 0) {
    body.appendChild(el("p", { class: "muted note", "data-test": "eta" },
      t("models.test.eta", { n: ids.length, sec: etaSec })));
  }

  const prog = testProgress(test.rows);
  // 跑的时候按钮上写的是进度，**不是一句静态的「正在测」**：几十秒里运维得看得见它在动。
  // ⚠️ 进度那个 key 带 `{done}` / `{total}` 两个占位符 ⇒ 必须走 `t(key, params)`，
  //    `elI18n` 内部调的是不带参数的 `t()`，用它会让屏幕上出现裸占位符。
  // ⚠️⚠️ **在等间隔的那几秒必须换一句话，不许还写着「正在逐个测」**：那几秒里
  //    一条请求都没在飞、一行状态都不会变，只有这颗按钮上的字能说出「为什么慢」。
  //    还写着「正在逐个测：1/6」的话，那句话在那几秒里是**假的**（没有任何一条在测），
  //    而运维读到的是一个停在 1/6 不动的进度 —— 与挂死不可区分。
  //    由 `tests/ui/dom/models-test-card.test.ts` 的
  //   「等间隔的那几秒里按钮说的是「在等节流」，不是一句停住不动的「正在逐个测」」那一格钉着。
  // ⚠️ 两个 key **各写成一次完整的 `t(key, params)`**，不写成 `t(三元, params)`：
  //    `scripts/check-i18n.mjs` 第 ⑧ 条对三元里的 key 结构性地看不见，它会把这两个
  //    带占位符的 key 判成「当成不带参数的标签用了」并把 CI 打红（本任务实测踩过）。
  const label = () => {
    if (!test.running) return t("models.test.run");
    if (test.waiting) return t("models.test.progressWaiting", { done: prog.done, total: prog.total });
    return t("models.test.progress", { done: prog.done, total: prog.total });
  };
  const btn = el("button", { type: "button", class: "models-test-btn" }, label());
  btn.disabled = test.running;
  btn.addEventListener("click", () => { runTests(); });
  body.appendChild(btn);

  if (test.rows === null) {
    // 一根破折号 + **一句看得见的话**（与上游那张卡的 idle 档同一条理由：
    // 「还没测过」最容易被误读成「这些模型都不通」）。
    const p = el("p", { class: "models-test-idle" });
    p.appendChild(el("span", { class: "models-up-dash" }, fmtDash(null)));
    p.appendChild(elI18n("span", "models.test.idle", { class: "muted" }));
    body.appendChild(p);
    return wrap;
  }

  const table = el("table");
  table.appendChild(headRow([
    "models.test.col.model", "models.test.col.result", "models.test.col.latency",
  ]));
  for (const row of test.rows) {
    const tr = el("tr", { class: "models-test-row", "data-model": row.id, "data-state": row.state });
    tr.appendChild(el("td", { class: "mono" }, row.id));

    const result = el("td");
    result.appendChild(el("span", { "data-test": "msg" }, t(rowStatusLabelKey(row))));
    // 状态码**另起一句**，不拼进上面那句：`rowStatusLabelKey()` 交出来的每一个 key
    // 都不许带 `{占位符}`，而「上游回了几」只在真收到过响应头的那几档有意义。
    if (row.status !== null) {
      result.appendChild(el("span", { class: "models-up-status", "data-test": "status" },
        t("models.test.status", { status: row.status })));
    }
    tr.appendChild(result);

    // ⚠️ **`fmtCount` 而不是自己写 `String(...)`**：它对 `null` 交出破折号，
    //    而**绝不伪造 0**——0 毫秒是一句关于链路的话，「没有这个数」是关于我们自己的话。
    tr.appendChild(el("td", { class: "mono" }, fmtCount(row.latencyMs)));
    table.appendChild(tr);
  }
  body.appendChild(table);
  return wrap;
}

/**
 * 跑一轮逐模型测试。**只有那颗按钮会调它**，没有任何隐式入口。
 *
 * 🔴 **串行发，一条一条 `await`，上一条回来了才发下一条。**
 * 并发会当场撞上游的边缘限流（约 2 次快请求就被挡），把整轮变成一片红，
 * 而那片红说的是「被限流了」不是「模型不通」——运维读到的每一格都是假的。
 * 后端那把常量 kind 的护栏是同一件事的另一半（见
 * `src/http/admin/handlers/model-test.ts` 的文件头不同点 ③）。
 *
 * 🔴🔴 **光「串行」不够，两条之间还必须真的隔满最小间隔**（v0.3.0 的缺陷，线上实测修正）。
 * ⚠️ **上一版这里只写了「串行」，而串行 ≠ 有间隔**：上游实测 471~766ms 就回了，
 * 于是整轮 824ms 跑完，6 行里 **5 行是 `probe_cooldown`** ——被我们**自己**后端那把
 * 3 秒护栏挡的，而它的 kind 是常量、整轮互相挡。屏幕上是 1 行「通了」+ 5 行
 *「被节流挡下了，请稍后再测」，而「稍后再测」是死路：再点一次连第一行都在冷却窗口里。
 * ⇒ 这颗按钮永远回答不了它承诺回答的那个问题，**而那 5 行盖住的可能是真的不通的模型**。
 * ⚠️ **别把后端那把护栏读成「整轮会自动被摊开」**：共用一个 kind 只会**截断**一轮，
 * 摊开一轮**必须由发起方限速**——也就是下面那个 `nextTestDelayMs()`。
 * 数值与参照点的选法全文在 `js/pure/model-test.mjs` 的 `TEST_MIN_INTERVAL_MS`
 * 与 `nextTestDelayMs()` 上方（Key 池的验活按钮从第一天起就镜像着同一个数，
 * `js/pure/keys-write.mjs` 的 `VERIFY_MIN_INTERVAL_MS`；v0.3.0 这张新卡漏了这一半）。
 *
 * 🔴 **每一步都 `render()` 一次，不许等整轮跑完再一次性渲染。**
 * 一轮几十秒，中途不重画的话运维在那几十秒里看不到任何进展，
 * 与一个挂死的面板长得一模一样。
 *
 * ⚠️ **两类失败落在两个函数上**：200 的响应体走 `modelTestResultCode()`，
 * 非 2xx（`js/api.js` 抛的 `ApiError`）走 `modelTestTransportCode()`。
 * 混成一个的后果与上游那张卡逐字相同：护栏的 429 会被说成「上游出错了」，
 * 而那一次**一个出站请求都没有发生过**。
 *
 * ⚠️ **代价，如实登记：这一轮没有中途退出的条件，而它现在要跑二十几秒。**
 * 会话在半路失效（`js/api.js` 对 401 会清凭据 + 回登录闸）时，剩下那几条**照样会
 * 逐个发出去**，各自拿一个 401 回来、各画成「管理会话已失效」。
 * 那几次都止步在管理接口这一段、**一个上游请求都不会发生**，所以它不烧上游额度；
 * 但它确实多打了几次注定失败的往返，**而加了间隔之后这几次还会被摊到二十几秒里**
 *（切走板块同理：这一轮不会因为切板块而停）。
 * **今天仍然不加那条早退**：它要一个新的判据（「哪几种 code 该中止整轮」），
 * 而那张表一旦写歪，就会把一条**该继续**的失败（比如某一个模型 404）也当成整轮的
 * 终止条件，静默少测掉后面全部模型 —— 那比多打几次 401 坏得多。
 * 变的只是这条代价的**时长**，不是它的**性质**（请求条数一条都没多）。
 */
async function runTests() {
  if (test.running) return;
  if (catalog === null) return;
  const ids = testableModels(catalog.models);
  if (ids.length === 0) return;
  test = { rows: initTestRows(ids), running: true, waiting: false };
  render();
  /** 上一条**落定**的时刻（拿到响应或拿到错误都算）；这一轮第一条是 `null`。 */
  let prevSettledAt = null;
  for (const id of ids) {
    // 🔴 **这段等待就是「整轮真的跑得完」那条不变量本身，删掉它整轮又会退回
    //    「1 行结果 + 5 行自制的节流」。** 参照点为什么取「上一条落定」而不是
    //    「上一条发起」，见 `js/pure/model-test.mjs` 的 `nextTestDelayMs()` 上方。
    const delay = nextTestDelayMs(prevSettledAt, Date.now());
    if (delay > 0) {
      // 等之前先把「在等节流」画出来：这几秒里一行状态都不会变，
      // 不说话就与挂死不可区分（见 `test.waiting` 上方那段）。
      test = { rows: test.rows, running: true, waiting: true };
      render();
      await sleep(delay);
    }
    test = { rows: withRowActive(test.rows, id), running: true, waiting: false };
    render();
    let code = null;
    let status = null;
    let latencyMs = null;
    try {
      // ⚠️ **`encodeURIComponent`**：模型 id 来自一次网络往返，即便今天它由本仓写死
      //    也不该被原样拼进 URL——那是一条「今天安全」而不是「不可能出事」的路径。
      const resp = await api.post(`/models/${encodeURIComponent(id)}/test`);
      code = modelTestResultCode(resp);
      status = resp && typeof resp.status === "number" ? resp.status : null;
      latencyMs = resp && typeof resp.latencyMs === "number" ? resp.latencyMs : null;
    } catch (e) {
      // 传输层失败这一档**没有 `status` 也没有 `latencyMs`**：这一次连响应体都没有。
      code = modelTestTransportCode(e);
    }
    // ⚠️ **成功与失败共用同一个参照点，别只在成功支记。** 一次传输层失败同样
    //    在后端那把护栏上占过一次（走到 handler 才被 429 挡下的那一族除外，
    //    而那一族记晚了只会等得更久、不会等得更短）。
    prevSettledAt = Date.now();
    test = { rows: withRowResult(test.rows, id, code, status, latencyMs), running: true, waiting: false };
    render();
  }
  test = { rows: test.rows, running: false, waiting: false };
  render();
}

/**
 * 读不出来那一档。
 *
 * ⚠️⚠️ **这里绝不能退化成「渲染一张空表」**（全局约束 9 的同型）：一张空表会被读成
 *「这个网关一个模型都没有」，而事实是我们**不知道**它认得哪些模型。
 * 所以这一档画的是：一条红色横幅（说清是读取失败，并给一颗「再读一次」）
 * **加一根 EM DASH**——那根破折号就是「我们不知道」这句话本身。
 * 由 `tests/ui/dom/models-section.test.ts` 的
 * 「GET /admin/api/models 返回 404 时不渲染空表，而是错误提示加一根 EM DASH」那一格钉着。
 */
function buildUnavailable() {
  const wrap = el("div");
  const banner = el("div", { class: "banner-danger", role: "status" });
  banner.appendChild(elI18n("span", "common.loadFailed"));
  const retry = elI18n("button", "common.refresh", { type: "button", class: "models-retry" });
  // ⚠️ **`true` = 抢占**（复评发现）：这是用户明确表达的意图，它应该赢。
  //    传 `false` / 不传的话，一条挂住的读会让这颗按钮变成一颗按了没反应的死按钮。
  retry.addEventListener("click", () => { load(true); });
  banner.appendChild(retry);
  wrap.appendChild(banner);

  const { wrap: card, body } = block("models.table.title");
  body.appendChild(el("p", { class: "models-unknown", title: t("models.unavailable") }, fmtDash(null)));
  wrap.appendChild(card);
  return wrap;
}

/**
 * 整个板块重画一遍。**每次都把 body 清空重建**：藏起来的表格仍然在无障碍树里、
 * 仍然会被复制粘贴带走，而它们显示的可能是一份读不出来的数据。
 */
function render() {
  const host = nodes.body;
  host.textContent = "";
  if (catalog === null) {
    host.appendChild(buildUnavailable());
  } else {
    host.appendChild(buildFilterBar());
    host.appendChild(buildTable(filterByProtocol(catalog.models, filter)));
  }
  // ⚠️ **目录读不出来时这张卡照画。** 两条读没有任何依赖关系：目录那条零网络出站、
  // 这条要真打一次上游。把它塞进 `catalog !== null` 那一支的后果是，一次目录读失败
  // 会连带把一个完全能用的功能藏起来，而屏幕上不会有任何东西说它去哪了。
  host.appendChild(upstreamCard());
  // ⚠️ **同一条理由：目录读不出来时这张卡也照画。** 它自己那一档会说清
  // 「目录读不出来 ⇒ 不知道有哪些模型可测」，而把整张卡藏起来的话，
  // 屏幕上不会有任何东西说它去哪了。
  host.appendChild(testCard());
}

/**
 * 拉一次协议目录。**零存储读**（`src/http/admin/handlers/models.ts` 全部来自模块级常量），
 * 所以它不进配额账；但它仍然是一次网络往返，**成功读过一次就不再读**——
 * 目录是静态的，重读一遍只会换来一次「这次可能失败」的机会。
 *
 * ⚠️ **两个不同的失败必须落到同一档**：HTTP 失败（`api.get` 抛）与「响应读得回来
 * 但形状不对」（窄化交出 `null`）在面板上都是「我们不知道」。少了后一半的话，
 * 一份被中间件改过形状的响应会让面板画出一张**结构自洽而内容缺斤少两**的表。
 */
async function load(preempt) {
  // ⚠️⚠️ **隐式入口（`onShow()`）在飞时不再发第二条，但**必须**把当前状态画出来。**
  //    上一版这里是**裸 `return`**，于是一条永不落地的读会让此后每一次 `onShow()`
  //    都什么都不画 ⇒ 只剩标题和副标题的空板块（复评实测：
  //    `calls=1 rows=0 banner=0 retry=0 unknown=0`），**连自救入口都没有**。
  //    加上这个 `render()` 之后，挂住时切回来至少看得见「读不出来」+「再读一次」。
  // ⚠️ **`preempt` 只由那颗「再读一次」传 `true`**：显式的用户动作有权抢占，
  //    隐式的板块切换没有。由 `tests/ui/dom/models-section.test.ts` 的
  //    「读挂住之后切回来不是一片空白 —— 至少要看得见「读不出来」和那颗「再读一次」」
  //    与「读挂住时点「再读一次」：旧的那条被抢占，它晚到的失败不许盖掉新的成功」两格钉着。
  if (inFlight && !preempt) { render(); return; }
  // 抢占：把上一条的 socket 放掉。**它不是作废判据**，作废判据是下面的世代号。
  if (abort) abort.abort();
  abort = new AbortController();
  const signal = abort.signal;
  const mine = ++seq;
  inFlight = true;
  try {
    const body = await api.get("/models", { signal });
    if (mine !== seq) return;
    const protocols = catalogProtocols(body);
    const models = catalogModels(body);
    catalog = protocols === null || models === null ? null : { protocols, models };
  } catch (e) {
    // ⚠️ **这里原来写着「走到这里只可能是『从来没成功过』」，那句是假的**
    //    （评审 Important 1 实测）：两条链并存时，一条晚到的失败会走到这里，
    //    而此刻 `catalog` 里可能正握着一份刚读成功的目录 ⇒ 下面这一行把它抹掉。
    // ⚠️⚠️ **这一行的安全性架在**三**条守卫上，不是一条**（复评实测订正：
    //    上一版写的是「依赖那一行」，而它把下一个人指向了两条里的一条）：
    //    ① `load()` 开头那条 `inFlight` 早退（隐式入口不再发第二条）；
    //    ② `onShow()` 里的 `if (catalog !== null) { render(); return; }`
    //       ——**留着 ① 不动、只删 ②，表照样被抹**（`rows 4→0, unknown 0→1, calls 1→2`）；
    //    ③ 上下这两处 `if (mine !== seq) return;`（被抢占的那条不许生效）。
    //    **改动这三处里的任何一处之前，先回来读这一段。**
    if (mine !== seq) return;
    catalog = null;
  } finally {
    // 被抢占的那条不许替**新**的那条把在飞标记清掉。
    if (mine === seq) { inFlight = false; abort = null; }
  }
  render();
}

export const modelsSection = {
  init(section) {
    section.textContent = "";
    section.appendChild(elI18n("h2", "models.title"));
    section.appendChild(elI18n("p", "models.desc", { class: "muted note" }));
    const body = el("div");
    section.appendChild(body);
    nodes = { body };
  },

  onShow() {
    // 成功读过一次就直接重画（切语言时框架层会重跑 onShow，那时也走这一支）。
    if (catalog !== null) { render(); return; }
    load();
  },
};
