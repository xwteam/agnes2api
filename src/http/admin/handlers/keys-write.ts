import type { Context } from "hono";
import type { Logger } from "../../../ports/logger.js";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import type { KeyRecord } from "../../../core/types.js";
import { isDisabled } from "../../../core/keypool.js";
import { EMPTY_STATS } from "../../../core/admin/stats.js";
import { adminError, adminErrorBody, readAdminJson } from "../errors.js";
// 危险区那条端点走**不带码的网关信封**，理由见 `POOL_SIZE_CHANGED` 上方那段 ⚠️。
import { httpError } from "../../errors.js";

/**
 * Key 池的五条写端点（第五条「清空 Key 池」是危险区那一颗按钮）。
 * **前四条是本仓第一批 `/admin/api/*` 写方法**——在此之前那棵树上六条路由全是 `admin.get()`。
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
   * 面板的写操作要出现在事件板块里。`registrar.*` 刚接进那个板块，
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
    // ⚠️ **`what` 刻意不进 `params`**：它是一句中文（「请求体」），插进 ja/ko 的
    // 字典串里等于把中文又漏回屏幕上——正是这次要关掉的那个破口的微缩版。
    // 它只留在 `message` 里给日志与 API 客户端读。
    throw adminError(400, "invalid_request_error", "body_not_an_object", `${what} 必须是一个 JSON 对象`);
  }
  return body as Record<string, unknown>;
}

/**
 * 可选布尔。**缺席与 `false` 是两回事**（前者「这次不动它」，后者「把它设成 false」），
 * 所以返回 `undefined` 而不是下坠到 `false`——早先那次真实发生的鉴权绕过，成因就是
 * `??` 对 `undefined` / 空串的下坠语义。
 */
function optBool(o: Record<string, unknown>, name: string): boolean | undefined {
  const v = o[name];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw adminError(400, "invalid_request_error", "not_a_boolean", `${name} 必须是布尔值`, { field: name });
  }
  return v;
}

/** 可选备注。`null` = 清空备注，缺席 = 这次不动它。 */
function optNote(o: Record<string, unknown>): string | null | undefined {
  const v = o.note;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") {
    throw adminError(400, "invalid_request_error", "note_not_a_string", "note 必须是字符串或 null");
  }
  if (v.length > MAX_NOTE_LENGTH) {
    throw adminError(
      400, "invalid_request_error", "note_too_long",
      `note 最长 ${MAX_NOTE_LENGTH} 个字符`, { max: MAX_NOTE_LENGTH },
    );
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
    throw adminError(
      400, "invalid_request_error", "unknown_field",
      `不认识的字段：${extra.join(", ")}`, { fields: extra.join(", ") },
    );
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
 *
 * ⚠️⚠️ **同一条约束在线上有两种形状，面板必须分两支处理**（评审发现 m8）：
 *   · 单条 `DELETE /admin/api/keys/:id` ⇒ **HTTP 409** + **顶层** `reason`；
 *   · `POST /admin/api/keys/bulk` ⇒ **HTTP 200** + 逐项结果里那一项的 `reason`
 *     （整批 409 会让运维不知道哪几把成功了）。
 * 拿状态码当唯一判据的前端会在批量路径上**完全看不到这条拒绝**——
 * 200 一路走过去，而那几把 key 根本没删掉。
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
 * `POST /admin/api/keys` —— 批量导入（「重复导入即解封」那个后门的落点）。
 *
 * 请求 `{ keys: string[], resetExisting?: boolean }` → `{ added, duplicated, invalid, reset }`。
 * 三个数组装的分别是 id / id / **输入里的位置**（1 基、`number[]`），
 * **没有一项是明文**——那是 `addMany` 的结构性性质，不是这里的自觉，见它的说明。
 *
 * ⚠️ **`reset` 必须进响应体，这不是顺手多给一个字段**（评审发现）：
 * `duplicated.length` **不等于**被重置的把数（本批新建的那把被粘第二遍时也算重复），
 * 本文件下面那段计算就是为这件事存在的。只把它写进事件、不写进响应，
 * 面板要么显示 `duplicated.length`（**撒谎**），要么在前端把这条判据再实现一遍——
 * 而 `src/core/keypool-repo.ts` 的 `addMany` 里正写着「一个动作两个数字，
 * 正是面板开始撒谎的方式」。**算出来的那个诚实数字必须交到面板手上。**
 *
 * `keys` 的每一项必须是字符串：**元素类型不对时整体 400，而不是把它算进
 * `invalid`**。两者的区别是「调用方（面板）写错了」与「用户粘错了」，
 * 前者不该被当成一条用户数据混进逐项结果里让人去猜。
 */
export function keysImportHandler(deps: KeysWriteDeps) {
  return async (c: Context) => {
    const body = asObject(await readAdminJson<unknown>(c), "请求体");
    rejectUnknown(body, ["keys", "resetExisting"]);
    const raw = body.keys;
    if (!Array.isArray(raw) || !raw.every((k): k is string => typeof k === "string")) {
      throw adminError(400, "invalid_request_error", "keys_not_a_string_array", "keys 必须是字符串数组");
    }
    if (raw.length > MAX_IMPORT_KEYS) {
      throw adminError(
        400, "invalid_request_error", "too_many_import_keys",
        `一次最多导入 ${MAX_IMPORT_KEYS} 把 key`, { max: MAX_IMPORT_KEYS },
      );
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
    return c.json({ ...result, reset });
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
    if (r === null) throw adminError(404, "not_found", "key_not_found", "没有这把 key");
    if (!deletable(r)) {
      return c.json({
        ...adminErrorBody(
          "conflict", "must_disable_first",
          "请先停用这把 key 再删除（删除不可撤销，而停用随时可以撤销）",
        ),
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

/**
 * PATCH 能改的那几件事。**顺序即文档顺序**（五份 DEPLOY.md 那笔配额账里的动作枚举就照这个顺序）。
 * ⚠️ 这里原先写的是「能改的**六**件事」——一个只在写下那天为真、表长一格也不会红的数。
 * 数量这件事今天由下面**第二条**（覆盖）守着——具体是
 * `tests/unit/docs-parity.test.ts` 的
 * 「该红时红：`PATCH_FIELDS` 长出第七个字段 ⇒ 五份一起红，并逐份点名那个字段」，
 * 注释里不再复述这个数（复评发现）。
 * ⚠️ 这里原先写的是「第三条」，而第三条管的是**顺序**、结构上管不了数量：
 * `enumerationFailures()` 里表长一格 ⇒ `missing.length > 0` ⇒ push 之后 `continue`，
 * 顺序那一段根本执行不到（复评实测：把顺序段整个中和，只红两格顺序反向控制，
 * 数量相关一格没动）。挂错判据的注释比没有注释更坏——它让人以为某个维度有人守。
 *
 * ⚠️ **这张表是真源，两处文档投影都从它现算**，三个维度各有一格判据：
 *   ① 字段名——把 `clearStats` 改名而文档没跟着改 ⇒ `tests/unit/docs-parity.test.ts` 的
 *      「五份 DEPLOY.md 里那条已实现的重置路径写着真源里的字段名，各恰好 1 次」红，
 *      并明说「真因在源码，不在文档」。
 *   ② 覆盖——本表**长一格**而五份 DEPLOY.md 那笔配额账里的动作枚举没跟着长 ⇒
 *      `tests/unit/docs-parity.test.ts` 的
 *      「五份 DEPLOY.md 那笔配额账里的动作枚举盖住 `PATCH_FIELDS` 的每一个字段」红。
 *   ③ **顺序**——上面那句「顺序即文档顺序」由 ② **同一格**守着：六个动作词在那对括号里的
 *      出现位置必须严格递增，本表换顺序、或某一份文档把括号里两项对调，都当场红。
 *      两个方向各配一格反向控制：`tests/unit/docs-parity.test.ts`
 *      「该红时红：`PATCH_FIELDS` 被换了顺序 ⇒ 五份一起红，并逐份点名换位的那两个字段」
 *      与「该红时红：某一份把括号里两项对调 ⇒ 只红一条并点名那一份」。
 * ⚠️ **原来还有第三处投影**：一份内部设计文档 §11 端点表那一行的请求体字段清单，
 * 全仓只有它钉着「逐项逐序」。那份文档已随全部内部设计文档移出本仓；随它删掉的
 * **覆盖**那一维本来就有 ② 承接，而**顺序**那一维一度无人承接——复评实测把本表整个倒序
 * ⇒ `pnpm test` 3763 格全绿。③ 就是把顺序搬回「真源 ↔ DEPLOY.md」之间的补偿判据，
 * 不是随文档一起丢。
 * ⚠️ ② 是复评回填补上的：在那之前**本表长一格，文档侧一个字都不会红**
 *（复评实测：加第七个字段 ⇒ docs-parity 与契约双双全绿）。
 */
export const PATCH_FIELDS = [
  "disabled", "note", "clearCooldown", "clearStrikes", "unevict", "clearStats",
] as const;

/**
 * `PATCH /admin/api/keys/:id` —— 停用/启用、备注、清冷却、清 strikes、解除剔除、
 * 重置用量计数。
 *
 * 四个布尔开关（`clearCooldown` / `clearStrikes` / `unevict` / `clearStats`）是
 * **动作**不是状态：传 `false` 等于没传，**不会**反过来「加一段冷却」。
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
 * （评审实证）：它断言的是「只改 `note` 的写被消除**是对的**」，
 * 所以修对了它绿、写错了它也绿。
 * 唯一的护栏是 `tests/contract/admin-keys-write.test.ts` 的
 * 「只改备注的 PATCH：改完之后 GET 真的读得回来」——那一格是端到端读回来的。
 *
 * **代价老实写**：不传 `prev` 的那条分支会把这把 key 攒着的 `pendingStats` 增量
 * 丢掉（那批计数没落盘）。它换来的是「管理员的每一次写都真的落盘」，而计数本来
 * 就是标了 `≈` 的近似值，且 PATCH 是人点一下才发生的。
 * 另一半代价是绕过了 `stillExists()` 那道「删除不许被陈旧写回撤销」的闸——
 * 这一条**这里不成立**：上面那次 `repo.get(id)` 直接读的就是存储，与 `stillExists`
 * **问的是同一个问题、读的是同一个键、准确度完全相同，只是更早**。
 * （⚠️ 这里原来写的是「更早、**更准**」——那个方向是反的：更早的读对「现在还在不在」
 * 只会**更弱**，不会更强。两者的差是一个窗口，不是一个精度。评审 m4 订正。）
 *
 * ── `clearStats`：那条承诺过的「经过 repo 的正式重置路径」──────────────────────
 *
 * 五份 DEPLOY.md 在 `POOL_TOUCH_INTERVAL_MS` 那一行**同步承诺**过它，而当时
 * `PATCH_FIELDS` 里并没有 stats ⇒ 五份齐说一句假话。裁定「做」与它的形态
 * （**加一个字段，不做危险区第三颗按钮**）写死在设计小节「第三颗按钮的去向」里，
 * 判据是**有界性**：加一个字段 = 单把 key、1 次 put，硬有界；批量重置全池 = N 次 put，
 * 而本仓没有任何常量给 N 上界。
 *
 * ⚠️ **「经过 repo」这半句才是整条承诺的重点，别当成修辞。**
 * 绕过 repo 直接改存储会先看到清零、随后被下一次真落盘按 `pendingStats` 的基线顶回
 * 旧值——那正是那一行文档描述的现象。走这里则**不传 `prev`**，而 `save()` 的
 * 「新建」分支头一行就是 `this.pendingStats.delete(next.id)`
 * （`src/core/keypool-repo.ts`）⇒ 本实例攒着的基线与未落盘增量一并作废。
 * ⚠️ **它清的只是「处理这次请求的那个实例」那一份，而且只对「这次重置之后才开始的
 * 请求」成立。** 同时在跑的别的实例（Worker 的其它 isolate / 同一个卷上的另一个容器）
 * 各有各的基线，仍可能把旧值再顶回来一次——这条限制五份 DEPLOY.md 里逐份写着，
 * 别在任何一侧把它说没了。
 * 绊线是 `tests/contract/admin-keys-write.test.ts` 的
 * 「clearStats 之后再来一次真落盘，不许把重置前攒着的增量补写回去」。
 *
 * ⚠️⚠️ **本实例的在飞请求同样会把旧值顶回来一次，这一句是复评实测订正的**
 * （原文写的是「所以那个实例不会再把旧值顶回去」，那是一句假话）：
 * `dispatch` 开头 `repo.all()` 拿到的那份 `records` 是**每请求一份的浅拷贝**
 * （`src/core/keypool-repo.ts` 的 `all()` 末尾 `[...cur]`），重置**不会**回头改它；
 * 这次重置之前就已经取到 `records` 的那个请求收尾时走
 * `repo.save(updated, records[at])`，`save()` 的同 id 分支第一行
 * `trackBaseline(next.id, normalizeStats(prev.stats), at)` 会拿**重置前的那份 stats**
 * 重新建出 `entry.base` ⇒ 落盘 = 旧基线 + 本次增量，屏幕上的 0 自己跳回去。
 * **窗口 = 那一个请求从 `repo.all()` 到 `repo.save()` 之间**：非流式端点
 * （`timeout: "sync"`）的等待预算是 `UPSTREAM_SYNC_TIMEOUT_MS`，流式端点是每把 key
 * 一个 `UPSTREAM_TIMEOUT_MS` 的首字节预算、逐把重试。
 * **它今天没有被修，只是被说清楚了**：要修得在 repo 里给「刚重置过」立一个不吸收
 * `seen` 的标记，而 `trackBaseline` 恰恰是靠吸收 `seen` 才不会把别的 isolate
 * 写得更高的计数压回去——两者是同一个旋钮的两个方向，不是顺手一行。
 * 两个方向各有一格用例钉着：
 * `tests/contract/admin-keys-write.test.ts`
 * 「clearStats 之后，重置前就在飞的那个请求收尾时会把旧基线顶回来一次（登记在案的代价）」
 * 与「clearStats 之后新开始的请求收尾，落盘的就是重置后的真实计数」。
 *
 * ⚠️ **它是独立动作，绝不能顺手挂进 `addMany` 的 `resetExisting` 字段集。**
 * `resetExisting` 之所以刻意不动 `stats`（逐字：「用量是历史，不是失败态」），
 * 是「重新导入即解封」那个后门的收口结论；挂进去就是把刚收口的后门重新打开。
 * 那一侧由「resetExisting 只重置失败态，`stats` 一个数都不许动」正面钉着。
 *
 * ⚠️ **它刻意不打事件，代价明写**：事件白名单（设计 §7.2）里没有「用量被清零」
 * 这一条，而事件板块的口径是「池子为什么变了」——`stats` 在 `FIELD_ROLE` 里是
 * telemetry，清零不改变任何调度行为，这与「只改备注不打事件」是同一把尺子。
 * **代价是：面板上那把 key 的计数会突然掉到 0，而事件板块里没有任何痕迹**，
 * 今天唯一看得出发生过这件事的是访问日志。这条当时登记成了遗留。
 * 「不打事件」由下面那格用例正面钉着，将来要改成打事件，先回设计 §7.2 加白名单。
 */
export function keyPatchHandler(deps: KeysWriteDeps) {
  return async (c: Context) => {
    const body = asObject(await readAdminJson<unknown>(c), "请求体");
    rejectUnknown(body, PATCH_FIELDS);
    if (Object.keys(body).length === 0) {
      // 空 patch 返回 200 就是一次「保存成功」而什么都没做，见 `rejectUnknown`。
      throw adminError(400, "invalid_request_error", "empty_patch", "至少要改一个字段");
    }
    const disabled = optBool(body, "disabled");
    const note = optNote(body);
    const clearCooldown = optBool(body, "clearCooldown") ?? false;
    const clearStrikes = optBool(body, "clearStrikes") ?? false;
    const unevict = optBool(body, "unevict") ?? false;
    const clearStats = optBool(body, "clearStats") ?? false;

    const prev = await deps.repo.get(paramId(c));
    if (prev === null) throw adminError(404, "not_found", "key_not_found", "没有这把 key");

    const next: KeyRecord = { ...prev };
    if (disabled !== undefined) next.disabled = disabled;
    if (note !== undefined) next.note = note;
    if (clearCooldown) { next.cooldownUntil = 0; next.cooldownReason = null; }
    if (clearStrikes) next.strikes = 0;
    if (unevict) { next.evicted = false; next.evictedReason = null; }
    // **摊平一份新的，不是复用 `EMPTY_STATS` 那个 frozen 单例。**
    // ⚠️ 这里原来写的理由是「整池共享同一个对象时，任何一处顺手改一个计数都会同时改掉
    // 别的 key 那一份（冻结只在严格模式下抛）」——**那个理由在本仓不成立**（复评发现）：
    // 本仓是 ESM/TS，**全程严格模式**，真有人原地改共享单例会当场抛 `TypeError`，
    // 不会静静串改；而且今天 `src/` 里没有任何一处原地改 `record.stats`
    // （`src/core/admin/stats.ts` 里凡是把它当成**一份新的 stats** 用的地方同样都摊平，
    // 只有当只读入参传给 `statsDelta` 那一处是直接用的）。
    // **真实的口径是：这一行是防御性的，而且它今天没有绊线**——回填时实测把它换成共享
    // 单例，`tests/contract/admin-keys-write.test.ts` 与 `tests/unit/docs-parity.test.ts`
    // 一格都不红。留着它是为了让「这条记录能不能被随手改一格」这个问题在本文件里
    // 不必被回答，代价是一次对象摊平。
    if (clearStats) next.stats = { ...EMPTY_STATS };

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
 * （面板那一侧），本端点只按收到的 `ids` 办事。写在这里是因为后端**看不出**这个区别：
 * 一次一千个 id 的删除请求在这里与一次二十个的完全同形。
 */
export function keysBulkHandler(deps: KeysWriteDeps) {
  return async (c: Context) => {
    const body = asObject(await readAdminJson<unknown>(c), "请求体");
    rejectUnknown(body, ["op", "ids"]);
    const op = body.op;
    if (!isBulkOp(op)) {
      throw adminError(
        400, "invalid_request_error", "not_a_bulk_op",
        `op 必须是 ${BULK_OPS.join(" / ")} 之一`, { ops: BULK_OPS.join(" / ") },
      );
    }
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === "string")) {
      throw adminError(400, "invalid_request_error", "ids_not_a_string_array", "ids 必须是字符串数组");
    }
    if (ids.length > MAX_IMPORT_KEYS) {
      throw adminError(
        400, "invalid_request_error", "too_many_bulk_ids",
        `一次最多操作 ${MAX_IMPORT_KEYS} 把 key`, { max: MAX_IMPORT_KEYS },
      );
    }

    const results: BulkItemResult[] = [];
    /** 通过了逐项校验、真的要删的那些。**攒起来一次交给 `deleteMany`**，见下。 */
    const toDelete: string[] = [];
    /** 真的被改动了的那些 id —— 事件要靠它说清「变的是哪几把」，见 `bulkEvent`。 */
    const changed: string[] = [];
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
      changed.push(id);
    }
    // **一次索引写**。逐把调 `repo.delete()` 结果完全一样，只是每一把都要重写一次
    // 索引 ⇒ 一次点击最多 200 次 put，见 `KeyPoolRepo.deleteMany` 的说明。
    await deps.repo.deleteMany(toDelete);

    if (changed.length > 0) deps.logger.log(bulkEvent(op, changed));
    return c.json({ results });
  };
}

async function applyBulk(repo: KeyPoolRepo, op: Exclude<BulkOp, "delete">, r: KeyRecord): Promise<void> {
  // 两条都不传 `prev`，理由与 `keyPatchHandler` 那段 ⚠️⚠️ 完全相同。
  if (op === "disable") { await repo.save({ ...r, disabled: true }); return; }
  await repo.save({ ...r, cooldownUntil: 0, cooldownReason: null });
}

/**
 * 批量事件里最多逐条列出多少个 id。
 *
 * 取 **20**：那是 `GET /admin/api/keys` 的默认每页条数，而批量条操作的正是「当前页」
 * （设计 §10.2 的全选只选当前页）⇒ **最常见的一次批量恰好装得下**。
 *
 * 为什么要有这个上限：`LogEntry.fields` 的值是标量，id 只能拼成一个字符串，
 * 200 个 16 位 id 就是约 3.4 KB **挂在一条事件上**，而事件是环形缓冲里逐条读出来的。
 */
const BULK_EVENT_IDS_MAX = 20;

/**
 * 批量操作的事件。
 *
 * ⚠️ **第一版只记 `count`，评审指出那与单条路径不对称**：单条 `DELETE` 记
 * `{ id, wasEvicted, wasDisabled }`，批量删 200 把却只说「少了 200 把」，
 * 说不出是哪 200 把——而删除不可撤销，事后追查时那正是唯一要问的问题。
 *
 * **逐条打 200 条事件不是选项**（会直接撞穿 `EVENT_WRITES_PER_DAY`），所以取中间：
 * **不超过 `BULK_EVENT_IDS_MAX` 就逐个列出，超了就明说自己没列**
 * （`idsOmitted: true`，而不是让 `ids: null` 去暗示这件事）——
 * 「面板说不出自己缺了什么」在本仓是被单独裁过的一类缺陷。
 */
function bulkEvent(op: BulkOp, changed: readonly string[]) {
  const listed = changed.length <= BULK_EVENT_IDS_MAX;
  const fields = {
    count: changed.length,
    ids: listed ? changed.join(",") : null,
    idsOmitted: !listed,
  };
  if (op === "delete") {
    return { level: "warn" as const, event: "key.deleted", msg: "面板批量删除了 key", fields };
  }
  if (op === "disable") {
    return {
      level: "warn" as const, event: "key.disabled",
      msg: "面板批量停用了 key（它们仍然占着 targetKeys 的名额，不会触发补池）",
      fields,
    };
  }
  return { level: "info" as const, event: "key.restored", msg: "面板批量清掉了冷却", fields };
}

/**
 * `POST /admin/api/keys/purge` 的注册路径。**这个字符串是真源**：
 * `src/http/admin/router.ts` 从这里取，`tests/unit/docs-parity.test.ts` 的
 * 「危险区那两条端点的路径在五份 DEPLOY.md 的配额账里逐份写着 —— 路径从真源常量现算」
 * 也从这里取 ⇒ 改了它而五份文档没跟着改，那一格当场红。
 */
export const KEYS_PURGE_PATH = "/admin/api/keys/purge";

/**
 * 池子在「你看到的那一刻」与「你按下确认那一刻」之间变了。
 *
 * **它不是洁癖**：清空 Key 池是本系统最不可撤销的动作（key 明文只在存储里有一份），
 * 而面板上那个数字是运维**读过一眼**的。中间被别人导入 / 补池铸出新 key 时，
 * 一次「我确认清掉这 3 把」会连带把第 4 把一起删掉，而那把 key 他从来没见过。
 * ⇒ 请求体里必须带上他看到的那个数，对不上就 **409 + 两边的数**，一把都不删。
 *
 * **响应体同时给 `error` 信封与顶层 `reason`**，与 `MUST_DISABLE_FIRST` 同一条理由：
 * 面板要靠机器可读的判别字段选一句五语言文案，靠解析 `message` 的中文是不行的。
 *
 * ⚠️ **本端点的两处错误走的是不带 `code` 的网关信封（`httpError`），与同文件上面那四条
 * 端点刻意不同，这是边界不是疏忽。** `ADMIN_ERROR_CODES` 那张闭集的射程写在
 * `src/core/admin/admin-errors.ts` 里，逐字是「面板真的会把后端 `message` 画到屏幕上
 * 的那一族，也就是 `admin-ui/js/sec-keys.js` 的 `errorMessage()` 够得着的那些端点」。
 * **这一条的消费者是设置页的危险区卡**，而设置页**从不渲染 `error.message`**
 *（`src/http/admin/handlers/config.ts` 文件头那段逐字写着这条纪律）——它按顶层
 * `reason` 选一句五语言文案（`set.danger.purge.changed`）。给它发一个码，等于在一个
 * 够不着屏幕的位置上多一条要五语言维护的契约。
 */
const POOL_SIZE_CHANGED = "pool_size_changed";

/**
 * `POST /admin/api/keys/purge` —— 危险区第二颗按钮（设计小节「重置到底重置了什么」）。
 *
 * 请求 `{ expect: number }` → `{ deleted, remaining, expected }`。
 *
 * ── 四件事，每一件都对应设计小节里的一条裁定 ─────────────────────────────────
 * ① **只动 `key:<id>` 与 `pool:index` 两族键。** `config` / `usage:` / `event:` /
 *    `tend:history` / 两把补池键 / `health:probe` 一个字节都不动——那是一条设计裁定，
 *    不是疏忽：任何一颗重置按钮顺手去删诊断历史，等于把「诊断用的历史」和「运维的
 *    一次误操作」绑在一起，而运维往往正是**因为**出事才来按它的。
 *    绊线在 `tests/contract/admin-danger.test.ts` 的
 *    「清空 Key 池之后，config / tend:history / usage:* / event:* 的读回值不变」。
 * ② **走 `repo.deleteMany()`，不许退化成循环调 `repo.delete()`。** 后者每一把都要
 *    「读索引 + 写索引」，N 把就是 N 次索引 put 打在每天 1,000 次的写桶上，
 *    而换来的信息量与一次 put 完全相同（那个方法的说明里逐字写着这条）。
 *    ⇒ 单价是 **N 次 delete + 1 次 put**，五语言 DEPLOY.md 的配额账写的就是这个。
 * ③ **`stats` 跟着记录一起没了，这是它的语义不是它的 bug。** 每把 key 的用量历史
 *    住在 `key:<id>` 的**值里面**，删记录就是删历史，没有第二份 ⇒ 面板的二次确认
 *    必须把这句话说破（`set.danger.purge.stats`）。
 * ④ **回执里的 `remaining` 是回读出来的**，不是 `0` 这个常数。走 `repo.all()`——
 *    `deleteMany` 的 `finally` 里已经 `invalidate()` 过，所以这一次是真的去存储读。
 *    它顺带把「索引说空了、而存储里还躺着记录」那一档如实报出来（空池兜底会 `list()`
 *    一次，见 `KeyPoolRepo.rescanEmptyResult`）——**那正是「清空之后真的空了吗」
 *    这个问题的唯一诚实答案**，写死一个 `0` 只是把 handler 的心愿印在屏幕上。
 *
 * ⚠️ **`expect` 是必填的，理由与 `configResetHandler` 的 `confirm` 逐字相同**：
 * 枚举式鉴权矩阵会拿正确的管理口令把每一条路由真的打一遍，一条不带请求体就会清空
 * 整池的端点会在那一格里把夹具自己的 key 池抹掉。
 */
export function keysPurgeHandler(deps: KeysWriteDeps) {
  return async (c: Context) => {
    const body = asObject(await readAdminJson<unknown>(c), "请求体");
    rejectUnknown(body, ["expect"]);
    const expected = body.expect;
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
      throw httpError(
        400, "invalid_request_error",
        "expect 必须是一个非负整数：它是你在屏幕上看到的池大小",
      );
    }

    const before = await deps.repo.all();
    if (before.length !== expected) {
      return c.json({
        error: {
          type: "conflict",
          message: `池子在你确认之前变了：你看到的是 ${expected} 把，现在是 ${before.length} 把。一把都没有删，请刷新后重来`,
        },
        reason: POOL_SIZE_CHANGED,
        expected,
        actual: before.length,
      }, 409);
    }

    await deps.repo.deleteMany(before.map((r) => r.id));

    // **回读**：从存储读回来，不是拿 `before.length` 反推。
    const after = await deps.repo.all();

    if (before.length > 0) {
      deps.logger.log({
        level: "warn", event: "key.deleted",
        msg: "面板清空了整个 Key 池（每把 key 的用量历史随记录一起没了，没有第二份）",
        // **只记数**：一次清空的 id 可能有几百个，而 `LogEntry.fields` 的值是标量，
        // 拼成一个字符串就是几 KB 挂在一条事件上（同 `BULK_EVENT_IDS_MAX` 那段）。
        fields: { count: before.length, remaining: after.length },
      });
    }

    return c.json({ deleted: before.length, remaining: after.length, expected });
  };
}
