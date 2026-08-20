import type { Context } from "hono";
import type { Logger } from "../../../ports/logger.js";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import type { KeyRecord } from "../../../core/types.js";
import { isDisabled } from "../../../core/keypool.js";
import { httpError, readJson } from "../../errors.js";

/**
 * Key 池的四条写端点。**本仓第一批 `/admin/api/*` 写方法**——在此之前那棵树上
 * 六条路由全是 `admin.get()`。
 *
 * 三条贯穿全文件的纪律，每一条都对应一个已经发生过的失效形态：
 *
 * ① **请求体一律 `unknown` + 逐字段窄化**（硬约束 8）。JSON 里什么形状都可能来，
 *    `as` 断言只是把运行期的问题推迟到它咬人的那一刻。
 * ② **响应体里一次都不许出现明文 key**（约束 11(a)）。请求体里必然有明文
 *    （导入就是干这个的），响应体里没有任何正当理由再出现它——面板没有、
 *    也永远不会有 reveal 端点（设计 §6.4），而一个会回显的写端点就是那个端点。
 * ③ **写操作看当前真值**：全部走 `repo.get(id)`，那是**直接读存储、绕过 isolate
 *    快照**的（`src/core/keypool-repo.ts` 的 `get`）。读快照的话，一次「停用」
 *    可能建立在一份最多一个 `POOL_CACHE_TTL_MS` 前的视图上，把这期间别的 isolate
 *    写下的 `evicted` / `cooldownUntil` 原样覆盖回去。
 *    由 `tests/contract/admin-keys-write.test.ts` 的
 *    「PATCH 读的是存储里的当前真值，不是最多一个 TTL 前的快照」钉着。
 */
export interface KeysWriteDeps {
  /** **与转发路径同一个实例**，见 `AdminRouterDeps.repo`：写完要 invalidate 的正是它。 */
  repo: KeyPoolRepo;
  /**
   * 事件 sink。**用 app 那一个（多路 fan-out 到 `StoreLogger`），不是 repo 内部那个**：
   * 面板的写操作要出现在事件板块里。Task 1 刚把 `registrar.*` 接进那个板块，
   * 运维第一次能在一个地方看到「池子为什么变了」——把面板自己的写操作漏在外面，
   * 那个板块就只说了一半真话。
   */
  logger: Logger;
}

/**
 * 一次导入最多接受多少把 key。
 *
 * 取 200（与 `GET /admin/api/keys` 的 `MAX_SIZE` 同一个数，面板一页最多就这么多）：
 * 一次导入的写侧成本是 `M + 1` 次 put，而免费档写配额是 **1,000 次/天**且与
 * key 池状态回写、事件落库共用同一个桶 ⇒ 200 把已经是**单次点击吃掉两成日配额**。
 * **超了就 400，不静默截断**：截断会让用户以为 500 把全导进去了，而池子里只有 200。
 */
export const MAX_IMPORT_KEYS = 200;

/**
 * 备注长度上限。
 *
 * 它进每一条 `key:<id>` 记录，而那条记录在**每一次**状态回写里被整体重写；
 * 面板列表一次又要把整池的备注全带出来。200 字符够写清「换了下游客户，先停着」，
 * 而没有上限时它就是一个挂在池子热路径上的任意长文本字段。
 */
export const MAX_NOTE_LENGTH = 200;

/** 请求体必须是一个 JSON 对象（不是数组、不是标量）。 */
function asObject(body: unknown, what: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw httpError(400, "invalid_request_error", `${what} 必须是一个 JSON 对象`);
  }
  return body as Record<string, unknown>;
}

/**
 * 可选布尔。**缺席与 `false` 是两回事**（前者「这次不动它」，后者「把它设成 false」），
 * 所以返回 `undefined` 而不是下坠到 `false`——P1 那次真实发生的鉴权绕过，成因就是
 * `??` 对 `undefined` / 空串的下坠语义。
 */
function optBool(o: Record<string, unknown>, name: string): boolean | undefined {
  const v = o[name];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw httpError(400, "invalid_request_error", `${name} 必须是布尔值`);
  return v;
}

/** 可选备注。`null` = 清空备注，缺席 = 这次不动它。 */
function optNote(o: Record<string, unknown>): string | null | undefined {
  const v = o.note;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw httpError(400, "invalid_request_error", "note 必须是字符串或 null");
  if (v.length > MAX_NOTE_LENGTH) {
    throw httpError(400, "invalid_request_error", `note 最长 ${MAX_NOTE_LENGTH} 个字符`);
  }
  return v;
}

/**
 * 不认识的字段一律 400。
 *
 * **不是洁癖**：`{ disbaled: true }` 这种拼错在宽松实现下是一次「保存成功、什么都
 * 没发生」——而面板会如实地显示保存成功。本仓已经反复裁过同一形状（「面板说
 * 保存成功、实际没落盘」），在写端点上这条要在入口就拦住。
 */
function rejectUnknown(o: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw httpError(400, "invalid_request_error", `不认识的字段：${extra.join(", ")}`);
  }
}

/**
 * 409「必须先停用才能删」（设计 §11）。
 *
 * 判据 `!disabled && !evicted`：**两条都不成立才拦**。只看 `evicted` 的话，
 * 一把健康的 key 永远删不掉（运维只能去手工改存储，那条路绕过整个面板）。
 *
 * `disabled` 走 `isDisabled()` 而不是 `r.disabled`：那是全仓唯一一份判据
 * （`src/core/keypool.ts`），各写各的后果是「面板显示已停用、删除按钮说没停用」。
 *
 * **响应体同时给 `error` 信封与 `reason`**：信封是全仓统一的对外形状
 * （`src/http/errors.ts`），而 `reason` 是设计 §11 逐字定死的机器可读判别字段——
 * 面板要靠它选一句五语言文案，靠解析 `message` 的中文是不行的。
 */
const MUST_DISABLE_FIRST = "must_disable_first";

function deletable(r: KeyRecord): boolean {
  return isDisabled(r) || r.evicted;
}

/**
 * 路径参数 `:id`。
 *
 * `c.req.param()` 的静态类型是 `string | undefined`（`Context` 上没带路径类型参数），
 * 而这三条路由都写着 `:id` ⇒ 运行期一定有值。**刻意不写 `as string`**：那是把一个
 * 类型问题藏起来。落到空串时下面那次 `repo.get("")` 会如实得到 404，
 * 而不是拿一个 `undefined` 去拼存储键。
 */
function paramId(c: Context): string {
  return c.req.param("id") ?? "";
}

/**
 * `POST /admin/api/keys` —— 批量导入（L4）。
 *
 * 请求 `{ keys: string[], resetExisting?: boolean }` → `{ added, duplicated, invalid }`。
 * 三个数组装的分别是 id / id / **输入里的位置**（1 基），**没有一项是明文**
 * ——那是 `addMany` 的结构性性质，不是这里的自觉，见它的说明。
 *
 * `keys` 的每一项必须是字符串：**元素类型不对时整体 400，而不是把它算进
 * `invalid`**。两者的区别是「调用方（面板）写错了」与「用户粘错了」，
 * 前者不该被当成一条用户数据混进逐项结果里让人去猜。
 */
export function keysImportHandler(deps: KeysWriteDeps) {
  return async (c: Context) => {
    const body = asObject(await readJson<unknown>(c), "请求体");
    rejectUnknown(body, ["keys", "resetExisting"]);
    const raw = body.keys;
    if (!Array.isArray(raw) || !raw.every((k): k is string => typeof k === "string")) {
      throw httpError(400, "invalid_request_error", "keys 必须是字符串数组");
    }
    if (raw.length > MAX_IMPORT_KEYS) {
      throw httpError(400, "invalid_request_error", `一次最多导入 ${MAX_IMPORT_KEYS} 把 key`);
    }
    const resetExisting = optBool(body, "resetExisting") ?? false;

    const result = await deps.repo.addMany(raw, { resetExisting });

    if (result.added.length > 0) {
      deps.logger.log({
        level: "info", event: "key.added",
        msg: "面板导入了新的 key",
        fields: {
          added: result.added.length,
          duplicated: result.duplicated.length,
          invalid: result.invalid.length,
        },
      });
    }
    // **被重置的是「本批之前就已经在池子里」的那些**：本批刚新建的那把即使被粘了
    // 两遍也谈不上重置。`duplicated` 逐条对应输入、可能含重复项，所以要去重。
    const reset = resetExisting
      ? new Set(result.duplicated.filter((id) => !result.added.includes(id))).size
      : 0;
    if (reset > 0) {
      // **知情重置必须留痕。** `resetExisting` 是一条正当的「重新导入即解封」路径
      // （它把后门变成了一个要显式勾选的动作），但它同时意味着**一个能调这个端点
      // 的人可以绕过 `evicted`**。事件板块是运维唯一能看到「池子为什么变了」的
      // 地方，这条不留痕，那个板块就只说了一半真话。
      deps.logger.log({
        level: "warn", event: "key.restored",
        msg: "面板导入时勾选了「重置已存在 key 的状态」，这些 key 的冷却 / strikes / 剔除标记已被清空",
        fields: { reset },
      });
    }
    return c.json(result);
  };
}

/**
 * `DELETE /admin/api/keys/:id` —— `204` / `404` / `409 must_disable_first`。
 *
 * 删除**不可撤销**（记录里那把 key 材料就此消失，没有任何地方还留着它），
 * 所以它是本文件唯一一条带前置条件的写操作，见 `MUST_DISABLE_FIRST`。
 */
export function keyDeleteHandler(deps: KeysWriteDeps) {
  return async (c: Context) => {
    const id = paramId(c);
    const r = await deps.repo.get(id);
    if (r === null) throw httpError(404, "not_found", "没有这把 key");
    if (!deletable(r)) {
      return c.json({
        error: {
          type: "conflict",
          message: "请先停用这把 key 再删除（删除不可撤销，而停用随时可以撤销）",
        },
        reason: MUST_DISABLE_FIRST,
      }, 409);
    }
    await deps.repo.delete(id);
    deps.logger.log({
      level: "warn", event: "key.deleted",
      msg: "面板删除了一把 key",
      // **只记 id（内容哈希）**，日志常被转发到第三方。
      fields: { id, wasEvicted: r.evicted, wasDisabled: isDisabled(r) },
    });
    return c.body(null, 204);
  };
}

/** PATCH 能改的五件事。顺序即文档顺序（设计 §11）。 */
const PATCH_FIELDS = ["disabled", "note", "clearCooldown", "clearStrikes", "unevict"] as const;

/**
 * `PATCH /admin/api/keys/:id` —— 停用/启用、备注、清冷却、清 strikes、解除剔除。
 *
 * 三个布尔开关（`clearCooldown` / `clearStrikes` / `unevict`）是**动作**不是状态：
 * 传 `false` 等于没传，**不会**反过来「加一段冷却」。
 *
 * ⚠️⚠️ **落盘走 `repo.save(next)`，刻意不传 `prev`——这一行是本任务最容易写错的
 * 一行，而写错时没有任何自动化会变红。**
 *
 * `save(next, prev)` 会过写消除那道闸（`shouldElide`），判据是「scheduling 字段
 * 有没有变 + `lastUsedAt` 有没有走远」。而 `note` 在 `FIELD_ROLE` 里是
 * **telemetry**，一次「只改备注」的写**两条都满足** ⇒ 整个被丢弃：面板显示保存
 * 成功，备注既不在存储也不在快照。它还只在「这把 key 最近被用过」时发生
 * ——也就是**只对正在服役的那些 key 发生**。
 *
 * **`tests/unit/pool-cache.test.ts` 的
 * 「MAY_ELIDE 的每个字段变化都被消除——这才是写消除的全部收益」不会替你报警**
 * （P3c Task 2 评审实证）：它断言的是「只改 `note` 的写被消除**是对的**」，
 * 所以修对了它绿、写错了它也绿。
 * 唯一的护栏是 `tests/contract/admin-keys-write.test.ts` 的
 * 「只改备注的 PATCH：改完之后 GET 真的读得回来」——那一格是端到端读回来的。
 *
 * **代价老实写**：不传 `prev` 的那条分支会把这把 key 攒着的 `pendingStats` 增量
 * 丢掉（那批计数没落盘）。它换来的是「管理员的每一次写都真的落盘」，而计数本来
 * 就是标了 `≈` 的近似值，且 PATCH 是人点一下才发生的。
 * 另一半代价是绕过了 `stillExists()` 那道「删除不许被陈旧写回撤销」的闸——
 * 这一条**这里不成立**：上面那次 `repo.get(id)` 直接读的就是存储，
 * 它本身就是一次比 `stillExists` 更早、更准的存在性确认。
 */
export function keyPatchHandler(deps: KeysWriteDeps) {
  return async (c: Context) => {
    const body = asObject(await readJson<unknown>(c), "请求体");
    rejectUnknown(body, PATCH_FIELDS);
    if (Object.keys(body).length === 0) {
      // 空 patch 返回 200 就是一次「保存成功」而什么都没做，见 `rejectUnknown`。
      throw httpError(400, "invalid_request_error", "至少要改一个字段");
    }
    const disabled = optBool(body, "disabled");
    const note = optNote(body);
    const clearCooldown = optBool(body, "clearCooldown") ?? false;
    const clearStrikes = optBool(body, "clearStrikes") ?? false;
    const unevict = optBool(body, "unevict") ?? false;

    const prev = await deps.repo.get(paramId(c));
    if (prev === null) throw httpError(404, "not_found", "没有这把 key");

    const next: KeyRecord = { ...prev };
    if (disabled !== undefined) next.disabled = disabled;
    if (note !== undefined) next.note = note;
    if (clearCooldown) { next.cooldownUntil = 0; next.cooldownReason = null; }
    if (clearStrikes) next.strikes = 0;
    if (unevict) { next.evicted = false; next.evictedReason = null; }

    await deps.repo.save(next);

    // 一次 PATCH 最多打一条事件，**停用优先**：它是唯一一个让 key 停止服役的动作，
    // 而事件板块是运维事后问「这把 key 为什么不干活了」时看的地方。
    // 只改备注不打事件——备注不改变池子的任何行为，而事件板块说的是池子为什么变了。
    if (disabled === true) {
      deps.logger.log({
        level: "warn", event: "key.disabled",
        msg: "面板停用了一把 key（它仍然占着 targetKeys 的名额，不会触发补池）",
        fields: { id: next.id },
      });
    } else if (disabled === false || clearCooldown || clearStrikes || unevict) {
      deps.logger.log({
        level: "info", event: "key.restored",
        msg: "面板解除了一把 key 上的限制",
        fields: {
          id: next.id,
          enabled: disabled === false,
          clearCooldown, clearStrikes, unevict,
        },
      });
    }
    return c.json({ ok: true });
  };
}

/**
 * 批量操作的三个动作。**与设计 §10.2 批量条上的三个按钮逐条对应**
 * （批量停用 / 清冷却 / 删除），没有第四个。
 *
 * **没有「批量启用」「批量解除剔除」**：它们是「让更多 key 重新上场」的动作，
 * 逐把点比一次点全部安全，而危险的那三个恰恰是需要一次点全部的。
 */
const BULK_OPS = ["disable", "clearCooldown", "delete"] as const;
type BulkOp = (typeof BULK_OPS)[number];

function isBulkOp(v: unknown): v is BulkOp {
  return typeof v === "string" && (BULK_OPS as readonly string[]).includes(v);
}

/** 逐项结果。`reason` 只在 `ok: false` 时有值，且是机器可读的判别字符串。 */
interface BulkItemResult { id: string; ok: boolean; reason: string | null }

/**
 * `POST /admin/api/keys/bulk` —— `{ op, ids }` → 逐项结果。
 *
 * **逐项结果不是装饰**：批量删除里混着一把没停用的 key 时，整批 409 会让运维不知道
 * 哪几把成功了、要不要重试；而只回一个「成功」则会把那一把的失败吞掉。
 *
 * ⚠️ **「一键全选」的范围是当前页，不是全部筛选结果**——那条约束在前端
 * （Task 4），本端点只按收到的 `ids` 办事。写在这里是因为后端**看不出**这个区别：
 * 一次一千个 id 的删除请求在这里与一次二十个的完全同形。
 */
export function keysBulkHandler(deps: KeysWriteDeps) {
  return async (c: Context) => {
    const body = asObject(await readJson<unknown>(c), "请求体");
    rejectUnknown(body, ["op", "ids"]);
    const op = body.op;
    if (!isBulkOp(op)) {
      throw httpError(400, "invalid_request_error", `op 必须是 ${BULK_OPS.join(" / ")} 之一`);
    }
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === "string")) {
      throw httpError(400, "invalid_request_error", "ids 必须是字符串数组");
    }
    if (ids.length > MAX_IMPORT_KEYS) {
      throw httpError(400, "invalid_request_error", `一次最多操作 ${MAX_IMPORT_KEYS} 把 key`);
    }

    const results: BulkItemResult[] = [];
    /** 通过了逐项校验、真的要删的那些。**攒起来一次交给 `deleteMany`**，见下。 */
    const toDelete: string[] = [];
    let changed = 0;
    for (const id of ids) {
      const r = await deps.repo.get(id);
      if (r === null) { results.push({ id, ok: false, reason: "not_found" }); continue; }
      if (op === "delete" && !deletable(r)) {
        // **逐项用的是同一个判据函数**：批量路径上另写一份的话，「必须先停用才能删」
        // 就有了两份实现，而批量删除恰恰是后果最不可挽回的那条路。
        results.push({ id, ok: false, reason: MUST_DISABLE_FIRST });
        continue;
      }
      if (op === "delete") toDelete.push(id);
      else await applyBulk(deps.repo, op, r);
      results.push({ id, ok: true, reason: null });
      changed++;
    }
    // **一次索引写**。逐把调 `repo.delete()` 结果完全一样，只是每一把都要重写一次
    // 索引 ⇒ 一次点击最多 200 次 put，见 `KeyPoolRepo.deleteMany` 的说明。
    await deps.repo.deleteMany(toDelete);

    if (changed > 0) deps.logger.log(bulkEvent(op, changed));
    return c.json({ results });
  };
}

async function applyBulk(repo: KeyPoolRepo, op: Exclude<BulkOp, "delete">, r: KeyRecord): Promise<void> {
  // 两条都不传 `prev`，理由与 `keyPatchHandler` 那段 ⚠️⚠️ 完全相同。
  if (op === "disable") { await repo.save({ ...r, disabled: true }); return; }
  await repo.save({ ...r, cooldownUntil: 0, cooldownReason: null });
}

function bulkEvent(op: BulkOp, count: number) {
  if (op === "delete") {
    return {
      level: "warn" as const, event: "key.deleted",
      msg: "面板批量删除了 key", fields: { count },
    };
  }
  if (op === "disable") {
    return {
      level: "warn" as const, event: "key.disabled",
      msg: "面板批量停用了 key（它们仍然占着 targetKeys 的名额，不会触发补池）",
      fields: { count },
    };
  }
  return {
    level: "info" as const, event: "key.restored",
    msg: "面板批量清掉了冷却", fields: { count },
  };
}
