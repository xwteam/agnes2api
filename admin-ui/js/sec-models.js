/**
 * 模型板块（设计文档 §10.7 / §11）：一张只读表 ——
 * 模型 ID / 类型（字段名 `modality`）/ 协议可用性矩阵（四个徽章）/ 端点。
 *
 * 板块契约（设计文档 §9.3）：`{ init?, onShow?, onHide? }`，见 admin-ui/js/app.js
 * 的 showSection。**板块内不许监听 langchange**——框架层会 apply(document) 之后
 * 重跑一次 onShow()。
 *
 * ── **本板块是「消费协议目录」这条路径的第一个前端消费者** ────────────────────
 * P3d 核心设计决定（全局约束 15）：四个消费者只许有一份「怎么调这个网关」的知识。
 * ⇒ **本文件的可执行代码里没有任何一条对外端点路径、没有任何一个协议 id、
 *    也没有任何一份请求体形状**（唯一的 admin 路径是 `api.get("/models")`，
 *    它为什么不算第二份知识见本文件头最后一段）。
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
 * 少了它，一次网络抖动会让这个板块在本次会话里一直停在错误页上
 *（`onShow()` 虽然会重试，但那要求用户先猜到「切走再切回来」这个动作）。
 *
 * ── 在飞的读只许有一条，**这是被守着的**（订正） ──────────────────────────────
 * ⚠️⚠️ **这一段原来写的是「本板块没有在飞请求的作废条件……它只有一条异步链……
 * 回来晚了的那一份写进去也不会是过期数据」，那三句里有两句是假的**
 *（P3d Task 6 评审 Important 1，已实测）：
 * · **「只有一条异步链」是假的**：`load()` 有**两个**入口——`onShow()`（`catalog === null`
 *   时）与错误横幅上那颗「再读一次」（那颗按钮不禁用、当时也没有重入护栏）。
 *   第一条读**还在飞着**时切走再切回来，`catalog` 仍是 `null` ⇒ 第二条链就发出去了。
 * · **「回来晚了的那份不会是过期数据」只对成功响应成立**：`catch` 分支把 `catalog`
 *   清成 `null`，于是一条晚到的**失败**会把**已经画好的正确的表**抹成「读不出来」。
 *   这一步在原推理里整个缺失。实测探针（修复前）：
 *   `calls=2 rowsAfterSuccess=4 rowsAfterLateFailure=0`。
 * ⇒ 治的是**根因**：`load()` 开头 `if (inFlight) return;`，**两条链不再并存**。
 * 由 `tests/ui/dom/models-section.test.ts` 的
 * 「在飞的读还没回来就切走再切回来：不许发出第二条读 —— 两条链并存正是那条晚到失败的来源」
 * 与「晚到的失败不许把已经画好的表抹掉 —— 表已经画好了，那次失败什么新东西都没说」两格钉着。
 *
 * ⚠️ **为什么不是 `admin-ui/js/sec-usage.js` 那种「最新的一条赢」的世代号**
 *（**与评审裁定有出入，明写，理由是实测出来的**）：
 * 那套规则的前提是「新数据取代旧数据」，而这份目录**是静态的**。
 * 在上面那个序列里，**成功的恰恰是先发的那一条**（世代号更小）⇒ 世代号会把它整份丢掉、
 * 转而认后发的那条**失败**为最新结果 ⇒ 终局仍然是一张「读不出来」的页面。
 * 实测：装上世代号之后，上面第二格从「表被抹掉」变成
 * 「**前置条件：成功的那一条得先把表画出来** expected +0 to be 4」——**它照样不绿**，
 * 而第一格（`calls` 仍是 2）连动都没动。
 * 装上 `inFlight` 之后世代号还会是一段**永不触发**的代码（只剩一条链、世代号恒等），
 * 而本仓对「留着一个没被钉住的守卫」已经裁过多次。
 * **哪天这个板块开始读会变的东西，那时才需要世代号——而且要连它自己的用例一起加。**
 *
 * ── `api.get("/models")` 这条 admin 路径为什么不算「第二份端点知识」 ──────────
 * 全局约束 15 管的是「怎么调**这个网关**」那张对外面（`/v1`、请求体形状、鉴权头），
 * 不是「怎么够得着那份真源」。`sec-usage.js` 已经写着同样的 `api.get("/models")` 与
 * `api.get("/capabilities")`，本文件与它同一条边界。
 * ⚠️ **但要写清代价：这条 admin 路径今天没有任何机器在守**
 *（`tests/ui/no-hardcoded-endpoints.test.ts` 的正则只认 `/v1` 开头的对外路径）。
 * 本文件头开头那句「可执行代码里没有任何一条对外端点路径」说的是**那张对外面**，不是这一条。
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { el, elI18n } from "./ui.js";
import { fmtDash } from "./pure/format.mjs";
import {
  protocolBadges, filterByProtocol, catalogProtocols, catalogModels, modalityLabelKey,
} from "./pure/models.mjs";

let nodes = null;
/**
 * 窄化之后的目录。`null` = **还没读到 / 读不出来**，两者在渲染上是同一档
 *（都还不知道这个网关认得哪些模型），区别只在「有没有人已经发过那次请求」。
 */
let catalog = null;
/** 当前选中的协议 id；`""` = 「全部」那一档。**取值来自响应，不是本地枚举。** */
let filter = "";
/**
 * 这一刻有没有一条读在飞。**它是本板块唯一的并发护栏**，理由与实测见文件头
 * 「在飞的读只许有一条」那一段（P3d Task 6 评审 Important 1）。
 *
 * ⚠️ 它同时兜住了另一件事：错误横幅上那颗「再读一次」**不禁用**，
 * 连点两下原来会发出两条链。现在第二下直接早退。
 */
let inFlight = false;

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

  const all = elI18n("button", "models.filter.all", { type: "button", class: "btn-toggle", "data-protocol": "" });
  all.classList.toggle("active", filter === "");
  all.addEventListener("click", () => { if (filter !== "") { filter = ""; render(); } });
  bar.appendChild(all);

  for (const p of catalog.protocols) {
    // 展示名走响应里的 `label`（协议的专名，**刻意不进 i18n**，理由见
    // `src/core/admin/protocol-catalog.ts` 里 `label` 字段上方那一行）。
    // 三条都不许走：本地再写一张映射、把 id 拼进一个 i18n key、直接渲染裸 id。
    const btn = el("button", { type: "button", class: "btn-toggle", "data-protocol": p.id }, p.label);
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
    //（全局约束 12：动态拼 key 会让三道 i18n 门禁一起哑）。
    const tip = b.available ? t("models.badge.yes") : t("models.badge.no");
    // ⚠️ **不可用那一档刻意不加任何修饰类**：`.badge` 的底样式本身就是中性灰，
    //    而 `admin-ui/css/sections.css` 里 `.badge-danger` 下面那段注释逐字裁过
    //    「别加一个取值与 `.badge` 逐字相同的同义类」。灰 = 不可用，绿 = 可用。
    // ⚠️ **状态不只靠颜色**：`title` 里那句话把它写成字，读屏与鼠标悬停都拿得到。
    const span = el("span", {
      class: b.available ? "badge badge-ok" : "badge",
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
  retry.addEventListener("click", () => { load(); });
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
    return;
  }
  host.appendChild(buildFilterBar());
  host.appendChild(buildTable(filterByProtocol(catalog.models, filter)));
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
async function load() {
  // ⚠️⚠️ **在飞时直接早退**（评审 Important 1）：这一行是「走到下面 catch 时
  //    确实还没成功过」这个前提的**唯一**来源。删了它，两条链就能并存，
  //    而晚到的那条失败会把已经画好的表抹掉。理由与实测见文件头。
  if (inFlight) return;
  inFlight = true;
  try {
    const body = await api.get("/models");
    const protocols = catalogProtocols(body);
    const models = catalogModels(body);
    catalog = protocols === null || models === null ? null : { protocols, models };
  } catch (e) {
    // ⚠️ **这里原来写着「走到这里只可能是『从来没成功过』」，当时那句是假的**
    //    （评审 Important 1 实测）：两条链并存时，一条晚到的失败会走到这里，
    //    而此刻 `catalog` 里可能正握着一份刚读成功的目录 ⇒ 下面这一行把它抹掉。
    //    现在那个前提由上面那行 `if (inFlight) return;` **真正**保证了。
    //    **这一行的安全性依赖那一行，改动任何一边之前先回来读这一段。**
    catalog = null;
  } finally {
    inFlight = false;
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
