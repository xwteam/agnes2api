/**
 * Key 池板块**写操作**的全部取值决策（P3c Task 4）。板块文件（`js/sec-keys.js`）
 * 只剩 DOM 拼装、事件绑定与网络调用，理由与 `pure/keys.mjs` 同一条
 * （admin-ui/README.md 硬规则 1）。
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

/** 「清冷却」按钮只在这把 key 确实处于冷却档时才有意义。 */
export function canClearCooldown(view) {
  return !!(view && view.bucket === "cooling");
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
 * 看的是 `bucket === "cooling"`（会随时间自动过期），`strikes` 不会自动清零、
 * 只能靠这个动作或者一次成功请求把它降下来。控制端裁定（追加）：这是设计
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
