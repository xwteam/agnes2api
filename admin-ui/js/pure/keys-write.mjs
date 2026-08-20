/**
 * Key 池板块**写操作**的绝大多数取值决策（P3c Task 4）。
 *
 * ⚠️⚠️ **这里原来写着"板块文件只剩 DOM 拼装、事件绑定与网络调用"，是一句被
 * 复评证伪过的"一律"**：`js/sec-keys.js` 自己的文件头如实登记了一条至今仍然
 * 留在板块文件里、且被判定为可接受的例外（`runBulkWithConfirm` 的
 * `ids.length === 0` 早退，理由见那份文件头）。两份文件头不该各说各话——
 * 这条纪律的诚实版本与 `sec-keys.js` 那句是同一句：**"取值决策原则上住在这里，
 * 例外必须在留下它的那个文件里说清楚是哪些、为什么"**，不是一句无条件的"只剩"。
 *
 * 这一批判据尤其容易被漏放在这里——上一期（P3b）在同一条规则上栽了四次，
 * 每次都是「先写在板块文件里，下一期再搬」。本文件覆盖简报点名的三类判据：
 * **按钮可用性、确认文案要不要出现、批量选择的边界**。
 *
 * 这个目录下的文件受三条硬规则约束（禁 import、禁浏览器全局、纯文本校验），
 * 规则全文见 admin-ui/README.md。
 */

/**
 * 一把 key 能不能删。**与后端 `src/http/admin/handlers/keys-write.ts` 的
 * `deletable()` 是同一条判据的前端半身**，两条都不成立才拦：
 * `disabled === true || evicted === true`。
 *
 * ⚠️ **只看 `evicted` 是一个已知会咬人的错误写法**——一把被运维手动停用、
 * 但从未被系统剔除的 key 会被前端永远挡在删除按钮外面，即使后端本来放行。
 * 反过来只看 `disabled` 同样错：一把被系统剔除但运维没手动停用过的 key
 * 也必须删得掉。
 */
export function isDeletable(view) {
  return !!(view && (view.disabled === true || view.evicted === true));
}

/**
 * 单条 `DELETE` 的 409 拒绝是不是「必须先停用」这一种。
 *
 * ⚠️ **它与批量路径的判据是同一件事的两种形状**：单条是 HTTP 409 + 顶层
 * `reason`，批量是 HTTP 200 + 逐项 `reason`（`bulkResultSummary()` 判的就是
 * 后一种，见该函数的说明）。两条路径各自读自己那种形状，但「reason 字符串
 * 是不是等于 `must_disable_first`」这条比较本身只应该有一份实现——原来它
 * 直接写在 `sec-keys.js` 的 `deleteOne()` 里，评审指出这与文件头「取值决策
 * 一律不写在这里」的说法矛盾（它确实是一条判据，只是恰好也有测试守着），
 * 现在搬到这里，两边都不用再各自比较字符串。
 */
export function isMustDisableFirstConflict(status, reason) {
  return status === 409 && reason === "must_disable_first";
}

/**
 * 「清冷却」按钮只在这把 key 确实处在冷却期时才有意义。
 *
 * ⚠️⚠️ **判据是 `cooldownUntil > now`，不是 `bucket === "cooling"`**（评审实测抓到
 * 的一个真缺陷）：`bucket` 是 `src/core/admin/key-view.ts` 的 `keyBucket()` 按
 * `disabled > evicted > cooling > fresh` 算出来的**优先级投影**，一把「已停用
 * 且仍在冷却」的 key 的 `bucket` 是 `"disabled"`，不是 `"cooling"`——但它的
 * `cooldownUntil` 确实还没到，后端的 `PATCH { clearCooldown: true }` 照样接受、
 * 照样清得掉。拿 `bucket` 当判据会让这把 key 的「清冷却」按钮永远禁用，即使
 * 运维刚把它启用回来——**按钮说「不能」，后端说「能」，两边对不上**。
 */
export function canClearCooldown(view, now) {
  return !!(view && typeof view.cooldownUntil === "number" && typeof now === "number"
    && view.cooldownUntil > now);
}

/** 「解除剔除」按钮只在这把 key 确实被剔除时才有意义。 */
export function canUnevict(view) {
  return !!(view && view.evicted === true);
}

/**
 * 「清 strikes」按钮只在这把 key 确实有连续失败计数时才有意义
 * （`view.strikes > 0`）——零 strikes 时点它什么都不会变，按钮亮着只是噪音。
 *
 * ⚠️ **这不是「清冷却」的同义词，两者的可用性判据也刻意不同**：`canClearCooldown`
 * 看的是 `cooldownUntil > now`（见上面那个函数自己的说明——那里也记着为什么
 * 不能改成看 `bucket`），`strikes` 不会自动清零、只能靠这个动作或者一次成功
 * 请求把它降下来。控制端裁定（追加）：这是设计
 * §10.2 行内动作清单里本来就有、后端 PATCH 也已经支持的第五个动作，第一版的
 * 简报动作清单漏列了它——补的是遗漏，不是新范围。
 */
export function canClearStrikes(view) {
  return !!(view && typeof view.strikes === "number" && view.strikes > 0);
}

/** 停用/启用那颗按钮该显示哪个 i18n key，取决于当前是不是已经停用。 */
export function toggleDisableLabelKey(view) {
  return view && view.disabled === true ? "keys.action.enable" : "keys.action.disable";
}

/**
 * 哪些单条行内动作在执行前需要一次确认弹窗。**两种不同的理由触发它，别混成一条：**
 *
 * ① **不可撤销**——只有删除符合。停用/启用/清冷却/解除剔除随时可以再点一次撤回，
 *    弹窗只会让运维在这几个动作上多点一次没有实际保护作用的确认——那不是谨慎，
 *    是让人对真正需要谨慎的那个动作（删除）变得麻木。
 * ② **语义容易与相邻动作混淆**——`clearStrikes` 符合。它与「清冷却」长得像
 *    "清空某个数字"，但清冷却只是让这把 key **现在**能用，它离下一次被剔除仍然
 *    只差一次失败；`clearStrikes` 才会把连续失败计数真正清零，给它一次干净的
 *    机会。这里的确认弹窗保护的不是"能不能撤销"（它本身也能撤销——strikes 会
 *    随后续失败重新累积），是"点的时候知不知道自己点的是哪一个"——运维容易
 *    以为点了「清冷却」就等于清空了账本。
 */
export function rowActionNeedsConfirm(action) {
  return action === "delete" || action === "clearStrikes";
}

/** 同一条判据用在批量动作上。三个批量动作里只有 `delete` 需要确认。 */
export function bulkNeedsConfirm(op) {
  return op === "delete";
}

/**
 * 「全选」动作要选中的 id 集合。**只能是调用方传入的 `items` 里的 id**——
 * 也就是**当前页**，不许基于 `total` / `counts.all` 这类别的字段去构造一个
 * 更大的集合。
 *
 * 照抄 kiro2api 的安全约束（设计文档 §10.2）：一键选中一千个看不见的行再批量
 * 删除，后果不可挽回。这个函数的入参就是唯一的信任边界——它没有办法访问
 * 当前页之外的任何东西，"选中全部筛选结果"这类实现只能通过**另外发起请求
 * 拉更多数据**才能做到，那种改法在源码 diff 里不会长得像"改一行"。
 */
export function selectAllIds(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const v of items) if (v && typeof v.id === "string") out.push(v.id);
  return out;
}

/**
 * 换页 / 换筛选之后，哪些已选中的 id 还留得住。
 *
 * 不在当前页 `items` 里的 id 一律丢弃——选择框只描述"当前能看到、且被勾选"
 * 的那些行，留着看不见的 id 会让批量条上的「已选 N 把」这个数字与屏幕上
 * 实际打勾的行对不上。
 */
export function pruneSelection(selectedIds, items) {
  const present = new Set(selectAllIds(items));
  const list = Array.isArray(selectedIds) ? selectedIds : [];
  return list.filter((id) => present.has(id));
}

/**
 * 单行勾选框变化之后，选中集合该变成什么样。
 *
 * ⚠️ **评审第二轮点名的例外之一**：这条去重加入 / 过滤移除的逻辑原来直接写在
 * `sec-keys.js` 的 `selectCell()` 事件处理器里，没有任何测试钉着——`selected`
 * 是不是真的去重了（同一个 id 被两次 `change` 事件加进去两次）、移除是不是真的
 * 精确匹配 id，都只能靠代码评审信。搬到这里，`selected.includes(id)` 那道
 * 去重闸与 `filter` 的移除都能单独测。
 */
export function toggleSelection(selectedIds, id, checked) {
  const list = Array.isArray(selectedIds) ? selectedIds : [];
  if (checked) return list.includes(id) ? list : [...list, id];
  return list.filter((x) => x !== id);
}

/**
 * 表头「全选本页」复选框变化之后，选中集合该变成什么样（并集 / 差集）。
 *
 * ⚠️ **评审第二轮点名的例外之一**：并集/差集这两步原来直接写在 `headerSelectCell()`
 * 的事件处理器里。**并集用 `Set` 去重，差集只删当前页的 id**——后者尤其要紧：
 * 取消全选时如果直接把 `selected` 清空，会把"用户在别的页面手动勾过的行"也
 * 一起清掉，那不是这个复选框该管的范围（它只代表"当前页"）。
 */
export function applySelectAll(selectedIds, pageIds, checked) {
  const selected = Array.isArray(selectedIds) ? selectedIds : [];
  const ids = Array.isArray(pageIds) ? pageIds : [];
  if (checked) return [...new Set([...selected, ...ids])];
  const drop = new Set(ids);
  return selected.filter((id) => !drop.has(id));
}

/**
 * 表头「全选本页」复选框该不该打勾。
 *
 * **空页（`pageIds.length === 0`）恒不打勾**，即使 `every()` 对空数组恒真——
 * 这不是数学上的边界情形，是一条产品判据：读失败 / 空列表时那一列没有任何
 * 一行，勾选框打上勾等于在向运维宣称"我选中了点东西"，而屏幕上什么都没有。
 */
export function headerSelectAllChecked(pageIds, selectedIds) {
  const ids = Array.isArray(pageIds) ? pageIds : [];
  const selected = Array.isArray(selectedIds) ? selectedIds : [];
  return ids.length > 0 && ids.every((id) => selected.includes(id));
}

/** 批量条该不该出现。设计文档 §10.2：「选中才出现」。 */
export function bulkBarVisible(selectedCount) {
  return typeof selectedCount === "number" && selectedCount > 0;
}

/**
 * 三个旋钮（`ttl` / `touch` / `edge`）是不是已经拿到过一次生效值——`loadKnobs()`
 * 用它决定要不要再打一次 `/overview`。
 *
 * ⚠️ **评审第二轮点名的例外之一**：这条判据原来是 `sec-keys.js` 里一个内联的
 * 三元 `||` 判断。**只要有一个非 null 就算"已经拿到过"**，不要求三个都非
 * null——三个旋钮来自同一次响应的同一个块（`overview.freshness`），只要那次
 * 响应成功过，三个字段要么一起有值、要么一起是 null（同一次 `poolKnobs()`
 * 投影），检查任意一个就够，写成"三个都要非 null"反而会在响应体只給出
 * 部分字段的畸形情形下误判成"还没拿到"、重复发请求。
 */
export function knobsLoaded(knobs) {
  return !!(knobs && (knobs.ttl !== null || knobs.touch !== null || knobs.edge !== null));
}

/**
 * `POST /admin/api/keys/bulk` 的逐项结果汇总成面板要显示的四个数。
 *
 * ⚠️⚠️ **这个函数存在的全部理由**：`bulk` 端点的 HTTP 状态码永远是 200
 * （见 `src/http/admin/handlers/keys-write.ts` 的 `keysBulkHandler` 文件头），
 * 「必须先停用才能删」这条拒绝**只活在逐项结果的 `reason` 字段里**。
 * 拿状态码当唯一判据的前端会在这条路径上完全看不到这条拒绝——
 * 一次「批量删除 20 把」里有 3 把被拒，前端会显示"全部成功"。
 * 这个函数把"看不看得到"变成了一次纯函数调用，不需要在渲染代码里重新数一遍。
 */
export function bulkResultSummary(results) {
  const list = Array.isArray(results) ? results : [];
  let ok = 0, mustDisableFirst = 0, notFound = 0, otherFailed = 0;
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    if (r.ok === true) { ok++; continue; }
    if (r.reason === "must_disable_first") mustDisableFirst++;
    else if (r.reason === "not_found") notFound++;
    else otherFailed++;
  }
  const failed = mustDisableFirst + notFound + otherFailed;
  return { total: list.length, ok, failed, mustDisableFirst, notFound, otherFailed };
}

/**
 * 批量结果提示该用哪个 i18n key 起头。**判据只看 `failed`**（上面那个函数
 * 已经把"被拒绝"这件事从状态码里解放出来了），不是看 HTTP 状态。
 */
export function bulkResultKey(summary) {
  return summary && summary.failed > 0 ? "keys.bulk.partial" : "keys.bulk.allOk";
}

/**
 * `bulkResultSummary()` 的输出再投影成 toast 要用的全部东西：拼哪几个 i18n key
 * （按顺序）、`kind` 是 `"ok"` 还是 `"warn"`、要不要 `sticky`。
 *
 * ⚠️⚠️ **评审第二轮点名的例外**：这三件事原来分散写在 `sec-keys.js` 的
 * `runBulk()` 里——三段字符串拼接、`summary.failed > 0 ? "warn" : "ok"`、
 * `summary.failed > 0 ? {sticky:true} : undefined`，三处判据各写各的，容易
 * 有的改了、有的忘了改（例如把 sticky 的条件改对了，却漏改 kind）。**这里
 * 不能直接拼出文案本身**——那需要 `t()`，而 `t()` 要 `import "./i18n.js"`，
 * `js/pure/` 下禁止 import（admin-ui/README.md 硬规则 1）。这个函数返回的是
 * "拼哪些 key、以什么顺序"，真正调 `t()` 插值仍然在 `sec-keys.js`。
 *
 * ⚠️ **每个候选 key 都是数组的独立元素、都带着尾逗号**——不是风格洁癖：
 * `scripts/check-i18n.mjs` 第 ⑧ 条的判据是"这个带占位符的 key 字面量后面
 * 紧跟的是不是逗号"，写成 `x ? "key" : null` 的话字面量后面紧跟的是空格加
 * `:`，会被那道门禁误判成"当裸标签用"。用 `条件 && "key"` 让字面量后面直接
 * 是数组的逗号分隔符，天然满足门禁——数组元素带尾逗号是这个文件已有的写法
 * （`sec-keys.js` 的 `for (const key of [...])` 那几处同样在最后一个元素后
 * 留了尾逗号），不是为了糊弄门禁去构造一个巧合写法。
 */
export function bulkResultPresentation(summary) {
  const s = summary || {};
  const conditional = [
    s.mustDisableFirst > 0 && "keys.bulk.mustDisableFirstSuffix",
    s.notFound > 0 && "keys.bulk.notFoundSuffix",
  ].filter((k) => typeof k === "string");
  const messageKeys = [
    bulkResultKey(s),
    "keys.bulk.countsSuffix",
    ...conditional,
  ];
  return { messageKeys, kind: s.failed > 0 ? "warn" : "ok", sticky: s.failed > 0 };
}

/**
 * 导入框的原始文本按行拆开。**逐行原样返回，含空行**——这是 Task 3 在
 * `src/core/keypool-repo.ts` 的 `addMany()` 里定死的口径：后端把空行整条跳过、
 * 但非法项的位置仍按**原始下标**算（1 基）。前端如果先过滤掉空行再发，
 * 位置就与运维在文本框里数到的行号错位；如果把空行也报成"第 N 行不合法"，
 * 那是一条用户没犯过的错误。**两难的唯一解法是原样发**，这个函数就是那个
 * "原样"——不 trim、不过滤、只按行分隔符拆开。
 *
 * `\r\n` / `\r` / `\n` 三种换行都认：textarea 在不同操作系统上可能产出任意一种。
 */
export function importLines(text) {
  if (typeof text !== "string" || text === "") return [];
  return text.split(/\r\n|\r|\n/);
}

/** 拆完的行里有没有至少一把看起来像 key 的内容（非空白）。用来挡掉空提交。 */
export function hasImportableContent(lines) {
  return Array.isArray(lines) && lines.some((l) => typeof l === "string" && l.trim() !== "");
}

/**
 * `POST /admin/api/keys` 响应体投影成面板要显示的计数。
 *
 * ⚠️⚠️ **`reset` 必须原样取自响应字段，不许用 `duplicated.length` 代替**
 * （评审 I2）。两者不是一回事：本批之前就已经在池子里、又勾了 `resetExisting`
 * 的那些才算"被重置"；本批刚新建的那把即使被粘了两遍也谈不上重置。
 * `src/core/keypool-repo.ts` 的 `addMany()` 原话：「一个动作两个数字，
 * 正是面板开始撒谎的方式」——这里就是那两个数字第一次分道扬镳的地方。
 */
export function importResultCounts(body) {
  const b = body && typeof body === "object" ? body : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    added: arr(b.added).length,
    duplicated: arr(b.duplicated).length,
    invalidLines: arr(b.invalid).filter((n) => typeof n === "number" && Number.isFinite(n)),
    reset: typeof b.reset === "number" && Number.isFinite(b.reset) ? b.reset : 0,
  };
}

/**
 * `importResultCounts()` 的输出再投影成 toast 要用的东西：`keys.import.result`
 * 的插值参数、要不要再拼一段"不合法的行"、`kind` 是 `"ok"` 还是 `"warn"`。
 *
 * ⚠️⚠️ **评审第二轮点名的例外**：`invalidLines.length > 0` 这条判据原来在
 * `sec-keys.js` 的 `openImport()` 里被问了两次（一次决定要不要拼后缀、一次
 * 决定 `kind`），两处各写一份布尔表达式——这正是"同一件事两处判断，容易改
 * 一处漏一处"的形状。这里只算一次。
 */
export function importResultPresentation(counts) {
  const c = counts || {};
  const invalidLines = Array.isArray(c.invalidLines) ? c.invalidLines : [];
  const hasInvalid = invalidLines.length > 0;
  return {
    resultParams: { added: c.added ?? 0, duplicated: c.duplicated ?? 0, reset: c.reset ?? 0, invalid: invalidLines.length },
    showInvalidSuffix: hasInvalid,
    kind: hasInvalid ? "warn" : "ok",
  };
}

/**
 * 一条错误 `message` 是不是"内部码"，不该原样丢给运维看。
 *
 * ⚠️⚠️ **这条判据存在的理由是 `sec-keys.js` 一句被评审探针证伪的注释**：
 * 原来那句「绝不把裸的 `http_500` 这类内部码丢给运维」只判断了"是不是非空
 * 字符串"，而 `js/api.js` 的 `json()` 在响应体没有 `error.message` 时把
 * message 落成 `` `http_${res.status}` ``（如 `"http_500"`），401/会话过期时
 * 落成字面量 `"unauthorized"` / `"session_expired"`——三种都是非空字符串，
 * 会原样出现在 toast 里。
 *
 * **这不是全部破口**：后端校验类 400 的 `error.message` 是中文散文（例如
 * note 超长时的「note 最长 200 个字符」），没有配套的机器可读 `reason` 字段
 * （不像 409 `must_disable_first` 那样），这条判据拦不住它——那句中文会被
 * 直接投到 ja/en/ko 的面板上。这是全面板第一处把后端原始 message 渲染给
 * 用户的地方。**归属定死：这条破口归 P3e（五语言与收尾）**——机制解是后端
 * 只回错误码、前端查五语言字典，或后端按 `Accept-Language` 返回，两条路各有
 * 代价，留给 P3e 裁，本任务不在这里假装解决。
 */
export function isOpaqueErrorMessage(message) {
  if (typeof message !== "string" || message === "") return true;
  return /^http_\d+$/.test(message) || message === "unauthorized" || message === "session_expired";
}

/**
 * 备注框的字符上限，与 `src/http/admin/handlers/keys-write.ts` 的
 * `MAX_NOTE_LENGTH` 保持一致——这个常量只用来给 `<textarea>` 一个 `maxlength`
 * 提示，真正的边界仍然由后端强制（超长会 400，前端不重复实现那条校验）。
 *
 * ⚠️ **它原来是 `sec-keys.js` 里一个本地常量，没有任何测试钉着它的值**——
 * 改成 20 也不会有任何东西变红，而 200 这个数字本身是一条与后端契约对齐的
 * 判据（不是随手选的），理应像 `MAX_IMPORT_KEYS` / `MAX_NOTE_LENGTH` 在
 * `tests/contract/admin-keys-write.test.ts`「三个边界常量写字面量钉死」那格
 * 一样被钉住。这里的对应测试见 `tests/ui/keys-write.test.ts`「是 200，不是别的数字」。
 */
export const NOTE_MAX_LENGTH = 200;

/**
 * 备注格该显示内容还是显示 `—`。
 *
 * ⚠️ **评审第二轮点名的例外之一**：这条判据原来直接写在 `sec-keys.js` 的
 * `noteCell()` 里。**空字符串算"没有内容"，不是"有内容但是空的"**——后端把
 * `note: ""` 与 `note: null` 都投影成不同的值（`KeyView.note` 恒是
 * `string | null`），但对运维来说"这一格能不能读出字来"只有一个答案，
 * 空字符串与 `null` 应该显示成同一个 `—`。
 */
export function hasNote(view) {
  return !!(view && typeof view.note === "string" && view.note.length > 0);
}

/**
 * 备注编辑框的内容转成 PATCH 请求体里的 `note` 字段。
 *
 * **清空输入框 = 清空备注（`null`），不是发一个空字符串**：空字符串在后端是一个
 * "合法但没有意义"的备注值，而用户清空文本框时想表达的是"删掉这条备注"，
 * 两者应该是同一个动作，不许留一个只有实现者自己知道的分叉。
 */
export function noteToPatch(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  return text;
}
