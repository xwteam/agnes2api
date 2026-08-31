import type { Context } from "hono";
import type { Logger } from "../../../ports/logger.js";
import type { Storage } from "../../../ports/storage.js";
import type { ConfigHolder } from "../../config-holder.js";
import { CONFIG_TTL_MS, KV_EDGE_CACHE_MS } from "../../config-holder.js";
import {
  CONFIG_KEY,
  loadConfigWithProvenance, type ConfigProvenance, type Env, type FieldSource,
} from "../../../core/config-provenance.js";
import {
  validateConfigPatch, clearSecret, configLoadBlockers, envNameOf,
  SECRET_FIELDS, EDITABLE_FIELDS, type ConfigError,
} from "../../../core/admin/config-validate.js";
import { httpError } from "../../errors.js";
// 管理树自己的请求体解析：**畸形 JSON 那一档要带 `code`**，理由见 `../errors.ts`。
// ⚠️ 本文件其余几处 `httpError()` 刻意仍是不带码的网关信封：设置页**从不渲染**
// `error.message`（`admin-ui/js/sec-settings.js` 的 `save()` 拿的是顶层 `errors[]`
// 里的逐字段 `code`，取不到就退回 `set.saveFailed` 那句五语言文案）
// ⇒ 它们够不着屏幕，不在那次错误码收口的射程里。**这不是漏了，是边界。**
import { readAdminJson } from "../errors.js";

/**
 * 配置的五条管理端点（设计 §5.3 / §5.4 / §8.6 / §10.4 / §11，第五条另见不带编号的
 * 那一节「重置到底重置了什么」）。
 *
 * | 方法 | 路径 | 干什么 | 写存储吗 |
 * |---|---|---|---|
 * | GET | `/admin/api/config` | 逐字段四元组 + 凭据的 `{configured,hint}` | **否** |
 * | PUT | `/admin/api/config` | 校验 → 写 → invalidate → **回读** | **是**（成功时 1 次 put） |
 * | POST | `/admin/api/config/validate` | 干跑，只回错误 | **否，一次都不写** |
 * | POST | `/admin/api/config/secrets/clear` | 显式清空一把凭据 | **是** |
 * | POST | `/admin/api/config/reset` | 危险区：`config` 整把写回 `{}` → invalidate → **回读** | **是**（1 次 put） |
 *
 * ── 贯穿本文件的四条纪律 ────────────────────────────────────────────────────
 *
 * ① **来源推导只有一份。** 「谁压过谁」全在 `loadConfigWithProvenance` 里
 *    （设计 §5.3 逐字：**不允许在面板层另写一套来源推导**）。本文件不做任何
 *    优先级判断，它只是把 `source` 分成 `fields`（公开字段）与 `credentials`
 *    （凭据）两块——**分块的判据也不是这里写的**，是 `FieldSource.exposure`，
 *    而那来自 `FIELD_EXPOSURE`。
 *
 * ② **凭据只写不读**（设计 §8.6）。`GET` 永不返回明文；`PUT` 时字段**缺席或空串
 *    = 不改**（不是清空）。§10.4「每个字段四元组」与 §11 的
 *    `fields: Record<path, {stored, env, effective, lockedBy}>` 照字面实现，
 *    就是把 `gatewayToken` 的明文放进 `stored` 与 `effective` 两个字段——而 §8.1
 *    花整节论证「不让管理面变成网关口令的 reveal 端点」。
 *
 * ③ **成功提示不得早于回读**（设计 §5.3：「本设计唯一一条不可妥协的产品原则」）。
 *    后端这一半的落点是：`PUT` 的响应体里**没有任何一个「成功了」字段**，只有
 *    **回读出来的** `fields` / `credentials` / `changed`。面板拿到的就是新状态本身，
 *    没有一个可以早于回读被渲染的「已保存」标志。前端那一半在
 *    `tests/ui/dom/settings-save.test.ts` 的
 *    「回读还没落定之前，界面上不许出现任何成功迹象」。
 *
 * ④ **回读从存储读，不从 handler 自己算出来的那份 `next` 读。**
 *    这是本文件最容易写错、而且写错了没有任何自动化会红的一行：把
 *    `fieldsOf(next)` 直接返回去，响应体一样漂亮、一样是新值，但它证明的只是
 *    「handler 说它写了什么」。真正要证明的是「存储里现在是什么」。
 *    ⇒ 写完之后**再调一次 `loadConfigWithProvenance`**，付一次读。
 *    ⚠️ 这条与 `configHolder.invalidate()` 是**两件事**，别混为一谈：
 *    回读证明的是「落盘了」，`invalidate()` 保证的是「**同一个进程的下一个请求**
 *    看到的也是新值」。少了后者，`GET /admin/api/overview` 会在最多一个
 *    `CONFIG_TTL_MS` 内继续报旧值，而运维刚刚才看到保存回执上是新值。
 *    那一条由 `tests/contract/admin-config.test.ts` 的
 *    「保存之后同一个进程立刻回读到新值 —— 观测点在 overview，走的是真 holder」钉着。
 */

/**
 * 配置读写要的两样东西。**成套给或者一个都不给**，与 `RegistrarWiring` 同一条理由：
 * 只给存储不给 `env`，四元组里 `env` 与 `lockedBy` 两格会恒为空——面板于是把一个
 * 被 `TARGET_KEYS=30` 锁死的字段显示成「可以改」，而那正是设计 §5.3 开头点名的
 * 最高频形态。
 *
 * **只有 `wire.ts` 装配得出来**（它手上才有 `env`），直接调 `createApp` 的调用方
 * 一律拿不到 ⇒ 四条端点如实回 `503 not_wired`，不假装。
 */
export interface ConfigWiring {
  /** 存 `config` 键的那一个存储。**与 key 池、与补池历史同一个实例**，不新增依赖。 */
  storage: Storage;
  /**
   * 本进程 / isolate 的环境变量。
   * **它是数据不是能力**：`src/core/` 那边的零 IO 约束因此不受影响
   * （取值发生在入口层，`config-provenance.ts` 只是收下一个 `Record`）。
   */
  env: Env;
  /**
   * 当前的 `ADMIN_TOKEN`（只从环境变量来）。**只用来查一条**：面板写进去的
   * `gatewayToken` 不许等于它——写成相等的后果是 `adminAuth` 的每请求复查把整个管理面
   * 判成 503，**而改回去的那条 `PUT` 也是 503**，面板把自己锁死（评审发现，已实测）。
   */
  adminToken?: string;
}

export interface ConfigDeps {
  /** `null` = 这个部署压根没接（只有绕过 `wire.ts` 的装配才会这样），四条端点回 503。 */
  wiring: ConfigWiring | null;
  /**
   * **与转发路径同一个 holder**。写完要 `invalidate()` 的正是它；另拿一个来调
   * 等于纯粹的空操作，而面板会显示保存成功。
   */
  configHolder: ConfigHolder;
  /** 事件 sink。用 app 那一个（fan-out 到 `StoreLogger`）：配置被谁改过要进事件板块。 */
  logger: Logger;
  now: () => number;
}

const REASON_NOT_WIRED = "not_wired";

function notWired(c: Context) {
  return c.json({
    error: { type: "internal_error", message: "这个部署没有接上配置读写（装配没走 wire.ts 的 buildApp）" },
    reason: REASON_NOT_WIRED,
  }, 503);
}

/**
 * 把 `source` 切成面板要的两块。
 *
 * **判据是 `exposure`，不是路径长得像不像密钥**：后者是一张手写词表
 *（`/token|key|secret/i` 那一类），本仓已经登记为脆弱判据。这里唯一的真源是
 * `FIELD_EXPOSURE`——加一个字段不进那张表，`tsc` 先报错。
 */
function split(source: Record<string, FieldSource>) {
  const fields: Record<string, unknown> = {};
  const credentials: Record<string, unknown> = {};
  for (const [path, f] of Object.entries(source)) {
    if (f.exposure === "secret") {
      credentials[path] = { configured: f.configured, hint: f.hint, lockedBy: f.lockedBy };
    } else {
      fields[path] = { stored: f.stored, env: f.env, effective: f.effective, lockedBy: f.lockedBy };
    }
  }
  return { fields, credentials };
}

/**
 * 把一份**已经读到手**的 `config` 值包成 `Storage`，让 `loadConfigWithProvenance`
 * 就地再构造一次而不必重读。
 *
 * 为什么不直接重读：那样这两步之间的一次写会让「构造失败」与「原件是什么」对不上，
 * 而这一段的全部意义就是**判断刚才那次失败是谁的锅**——判据必须建在同一份原件上。
 * 其余的键原样透传（`loadConfigWithProvenance` 今天只读 `config` 这一把）。
 */
function frozenConfig(stored: unknown, inner: Storage): Storage {
  return {
    async get<T>(key: string): Promise<T | null> {
      return key === CONFIG_KEY ? ((stored ?? null) as T | null) : inner.get<T>(key);
    },
    put: (k, v, e) => inner.put(k, v, e),
    delete: (k) => inner.delete(k),
    list: (p) => inner.list(p),
  };
}

export interface ConfigSnapshot {
  prov: ConfigProvenance | null;
  fields: Record<string, unknown> | null;
  credentials: Record<string, unknown> | null;
  configDegraded: boolean;
  /** 装载不起来的每一条原因。**空数组 = 装得起来**，面板据此决定要不要显示诊断横幅。 */
  loadBlocked: readonly ConfigError[];
}

/**
 * 一次装载 + 切块，**装载不起来时降级成诊断视图而不是 500**。
 *
 * ⚠️⚠️ **「降级成诊断视图」这件事是那条评审发现的收口点，它是运维唯一的出路。**
 *
 * 在它之前：存储里那份 `config` 一旦装载不起来（缺 `gatewayToken`、或注册机开着却
 * 缺链上通道的凭据），`GET /admin/api/config` 与 `PUT /admin/api/config` **全是 500**
 * ——于是「关掉注册机」「把那把 key 重新填回去」「换一条主通道」这三条自救路径
 * **一条都走不通**（实测三条全 500），而屏幕上五语言正写着「请立刻在这一页写一把新的」。
 * 加重情节：这时 `GET /admin/api/overview` 仍然 200 且 `degraded` 为假
 *（`Refreshable` 保着上一份快照），概览页一片正常。
 *
 * ⚠️ **它不是泛泛地 `catch`**，具体怎么切见下面 `catch` 里那段（三分，不是二分）。
 * 代价：失败那一支多付一次存储读；**顺利那一支仍然是 1 次 get**，配额账不变。
 *
 * ⚠️⚠️ **这段说明本身被订正过一次，形态值得记**：它原来停在 `frozenConfig` 头上
 * 当孤儿（`frozenConfig` 是后加的，插在它与 `readAll` 之间），而正文里还写着
 * 已被证伪的二分判据「没有 blocker ⇒ 原样抛出去」。**与评审删掉的那段孤儿 JSDoc、
 * 与 `ui-assets.test.ts` 那两段连续 JSDoc 是同一形态，同一轮里第三次。**
 * 判据很简单：**在两个声明之间插入新声明时，先确认上面那段文档挂的是谁。**
 */
async function readAll(wiring: ConfigWiring, logger: Logger): Promise<ConfigSnapshot> {
  try {
    const prov = await loadConfigWithProvenance(wiring.env, wiring.storage, logger);
    return { prov, ...split(prov.source), configDegraded: prov.config.degraded, loadBlocked: [] };
  } catch (err) {
    /**
     * ⚠️⚠️ **切分是三分，不是二分。这一段被订正过两次，两次都是我判据不完备。**
     *
     * · **第一版**：`configLoadBlockers` 为空 ⇒ 原样抛。**不完备**——存储里
     *   `registrar.targetKeys: "abc"` 时那个函数返回 `[]`，而 `posInt()` 对存储里的
     *   非数字**是抛错不是降级** ⇒ 那一整类连诊断视图都拿不到，`GET`/`PUT` 双双 500、
     *   面板没有出路（评审实测）。
     * · **第二版**：「存储读得出来 ⇒ 就是配置问题」。**也不完备**——存储只是**瞬时**
     *   抖了一下（第二次读就好了）时，它会把一份**完全正常**的配置判成配置问题，
     *   给出一个假的诊断视图。
     *
     * ⚠️ **承重前提：`env` 那一侧在 boot 时已经被证明可用。**
     * `loadConfigWithProvenance` 的抛错来源有两个——`env` 与存储——而下面这三分
     * **只覆盖存储那一侧**，靠的是「`env` 里的非法值在 `buildApp` 那一刻就 fail-fast、
     * 进程根本起不来」。**「进程已启动」这个前提一旦不成立，三分就不完备**：
     * 例如 `env` 里 `TARGET_KEYS=abc`，今天它在 boot 就抛、走不到这里。
     * ⚠️ **而这条前提不是永恒的**：`src/core/registrar/config.ts` 里那套校验
     * 自己登记着它沿用的是网关那一层留下的口径、与 `num()` 的字段级降级策略并不一致；
     * **哪天有人去抹平那个不一致、让 boot 侧变宽松，这一类就会变活**，
     * 到那时这段切分要跟着补一条。
     *
     * 正确的切分要问两个问题，答案三分：
     * ① **原件读得出来吗**？读不出来 ⇒ 存储真的坏了 ⇒ **原样抛第一个异常**；
     * ② 读得出来，那就拿**这一份**就地再构造一次：
     *    · 构造得出来 ⇒ 第一次那下是瞬时抖动，**用这一份，照常返回**；
     *    · 构造不出来 ⇒ 这才是配置问题 ⇒ 诊断视图。
     * 第二步用的是**已经读到手的那份原件**（`frozenConfig`），不再多付一次读，
     * 也不会被两次读之间的变化搅浑。
     */
    let stored: unknown;
    try {
      stored = await wiring.storage.get<unknown>(CONFIG_KEY);
    } catch {
      // 读不出来 ⇒ 存储真的坏了。**抛第一个异常**（那才是原因），不是这一个。
      throw err;
    }

    try {
      const prov = await loadConfigWithProvenance(
        wiring.env, frozenConfig(stored, wiring.storage), logger,
      );
      // 瞬时抖动：这一份构造得出来，照常返回，不给假的诊断视图。
      return { prov, ...split(prov.source), configDegraded: prov.config.degraded, loadBlocked: [] };
    } catch {
      const blockers = configLoadBlockers(stored ?? {}, wiring.env);
      // 具体原因（`posInt` 那类）只进事件板块，**不进响应体**。
      // ⚠️ **那件事已经裁完，这里改写成结论**：管理接口的对外契约是
      // `error.code`（闭集，见 `src/core/admin/admin-errors.ts`），**`message` 不是**
      // ——它是给日志与 API 客户端读的，措辞随时可以改而不算破坏兼容。
      // 一句后端中文 `Error.message` 因此**更不能**进响应体：它既不是契约，
      // 又会被面板当成人话画到非中文用户脸上。这一档的兜底码是
      // `config_unloadable`（下面那个 `loadBlocked`），面板已有五语言文案。
      if (blockers.length === 0) {
        logger.log({
          level: "error", event: "config.unloadable",
          msg: "存储里的配置读得出来、却构造不出一份合法配置，而逐字段判据说不出是哪一格"
            + "（多半是某个数值字段被写成了非数字）。面板已降级成诊断视图。",
          fields: { err: err instanceof Error ? err.message : String(err) },
        });
      }
      return {
        prov: null, fields: null, credentials: null, configDegraded: true,
        loadBlocked: blockers.length > 0 ? blockers : [{ field: "", code: "config_unloadable" as const }],
      };
    }
  }
}

/**
 * 真的变了的公开字段（**按回读出来的 `effective` 比**，不是按请求体比）。
 *
 * 这个区别是有后果的：`TARGET_KEYS=30` 锁着时，一次「把 targetKeys 改成 20」
 * 的 patch 会被 `locked_by_env` 拒掉——但即使没被拒（比如将来放宽了锁定语义），
 * 按 patch 比会说「改了」，而生效值纹丝不动。**面板高亮的必须是真的变了的那些。**
 * 凭据不进这份清单（它们没有可比的公开值），改没改由各自的 `credentialsChanged` 报。
 *
 * ⚠️ **两侧任一装载不起来时一律空数组**，而不是编一份差异出来：那时根本没有
 * 「生效值」这个东西可比。面板靠 `loadBlocked` 说话，不靠高亮。
 *
 * ⚠️ **`PUT` 与 `POST /admin/api/config/reset` 共用这一份，刻意的**：两条端点的回执
 * 里那一格是同一个意思（「这次落盘之后，生效值真的变了的是哪几格」），各写一份
 * 迟早分叉，而分叉的表现是同一次改动在两条路径上被高亮成不同的几格。
 */
function changedEffective(before: ConfigSnapshot, after: ConfigSnapshot): string[] {
  if (after.prov === null || before.prov === null) return [];
  const b0 = before.prov;
  const a0 = after.prov;
  return Object.keys(a0.source).filter((path) => {
    const a = b0.source[path];
    const b = a0.source[path];
    if (a === undefined || b === undefined) return false;
    if (a.exposure !== "public" || b.exposure !== "public") return false;
    return JSON.stringify(a.effective) !== JSON.stringify(b.effective);
  }).sort();
}

/** 传播时间。两个数都从 `config-holder.ts` 取，**这里没有任何字面量**（见那里的说明）。 */
const PROPAGATION = {
  configTtlMs: CONFIG_TTL_MS,
  kvEdgeCacheMs: KV_EDGE_CACHE_MS,
  visibilityUpperBoundMs: CONFIG_TTL_MS + KV_EDGE_CACHE_MS,
} as const;

/**
 * `GET /admin/api/config` —— 设置页的唯一取数端点。
 *
 * **一次存储写都不产生**，读侧是 1 次 `get("config")`（装载失败那一支多付一次，
 * 见 `readAll` 里那段三分说明）。
 */
export function configGetHandler(deps: ConfigDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const snap = await readAll(wiring, deps.logger);
    return c.json({
      fields: snap.fields,
      credentials: snap.credentials,
      /** 本次装载有没有降级。红色横幅的依据，与 `GET /admin/api/overview` 同一个值。 */
      configDegraded: snap.configDegraded,
      /**
       * 存储里那份配置**装载不起来**的每一条原因（空数组 = 装得起来）。
       * 非空时 `fields`/`credentials` 是 `null`——面板据此显示诊断视图，
       * **而不是一份编出来的空配置**，并且**表单仍然可编辑**（那是唯一的出路）。
       */
      loadBlocked: [...snap.loadBlocked],
      /** 面板能改的字段清单。**从后端给**，前端不另写一份（写两份必漂）。 */
      editable: [...EDITABLE_FIELDS],
      /** 哪几条路径是凭据。前端据此渲染「留空则不修改」的占位符与清空按钮。 */
      secrets: [...SECRET_FIELDS],
      /**
       * **按下危险区那颗「重置配置」之后，这份配置会缺什么**（空数组 = 逐字段判据看不出会缺什么）。
       *
       * ⚠️ **它必须在 `GET` 上就给，不能等重置回来再说**：面板要在**二次确认框里**
       * 就把后果说清，而那一刻还没有发过任何写请求。判据是
       * `configLoadBlockers(RESET_VALUE, env)`——与 `PUT` 的跨字段校验、与诊断视图、
       * 与 `POST /admin/api/config/reset` 自己回执里那一格**同一个函数**。
       * 让面板自己去看「`gatewayToken` 的 `lockedBy` 空不空」就是在面板层另写一套
       * 来源推导，那是本文件纪律 ① 明令禁止的事。
       *
       * **零额外存储读**：`RESET_VALUE` 是常量，`env` 手上就有。
       */
      resetBlocked: configLoadBlockers(RESET_VALUE, wiring.env),
      propagation: PROPAGATION,
    });
  };
}

/** 请求体必须是一个 JSON 对象（不是数组、不是标量）。 */
function asObject(body: unknown, what: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw httpError(400, "invalid_request_error", `${what} 必须是一个 JSON 对象`);
  }
  return body as Record<string, unknown>;
}

/**
 * 取出 `{ patch }`。
 *
 * **顶层只认 `patch` 一个键**：`{ patchs: {...} }` 这种拼错在宽松实现下是一次
 * 「保存成功、什么都没发生」，而面板会如实显示保存成功——本仓已经反复裁过同一形状。
 */
async function readPatch(c: Context): Promise<Record<string, unknown>> {
  const body = asObject(await readAdminJson<unknown>(c), "请求体");
  const extra = Object.keys(body).filter((k) => k !== "patch");
  if (extra.length > 0) {
    throw httpError(400, "invalid_request_error", `不认识的字段：${extra.join(", ")}`);
  }
  return asObject(body.patch, "patch");
}

/** 逐字段错误的统一信封。**`errors` 在顶层**：面板靠 `code` 选五语言文案，不解析 `message`。 */
function invalid(c: Context, errors: readonly ConfigError[]) {
  return c.json({
    error: { type: "invalid_request_error", message: "配置校验没通过，本次一个字节都没有写入" },
    errors: [...errors],
  }, 400);
}

/**
 * `PUT /admin/api/config` —— 校验 → 写 → `invalidate()` → **回读**。
 *
 * ⚠️ **顺序不是可以调的。** 先写后校验的话，一份非法配置已经落盘了，而响应是 400
 * ——运维照着 400 以为「没保存上」，下一次冷启动网关起不来（§5.4 的 fail-closed 反噬）。
 * 「400 那一次一次写都不产生」由 `tests/contract/admin-config.test.ts` 的
 * 「校验失败的那次请求 puts 计数一动不动 —— 只断言 400 抓不住『先写了再返回 400』」
 * 数着 put 计数钉住（只断言状态码抓不住这个形态，与另一条发现同一个形状）。
 */
export function configPutHandler(deps: ConfigDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);

    const patch = await readPatch(c);
    // **写之前先把当前状态读出来**：校验要拿它做合并（「缺席 = 不改」），
    // 回执里的 `changed` 也要拿它做对照。这一次读发生在任何写之前。
    //
    // ⚠️ **走 `readAll` 而不是裸 `loadConfigWithProvenance`**（评审发现）：存储里那份
    // 配置已经装载不起来时，裸调用会抛 ⇒ 整条 `PUT` 变成 500 ⇒ **「把那把 key 重新
    // 填回去」这条自救路径自己也走不通**（实测：关注册机 / 重填 key / 换主通道全 500）。
    // 校验只需要 `storedBefore`（原始读，永远不抛），所以写这条路完全不依赖装载成功。
    const before = await readAll(wiring, deps.logger);
    const storedBefore = (await wiring.storage.get<unknown>(CONFIG_KEY)) ?? {};

    const verdict = validateConfigPatch(patch, {
      stored: storedBefore, env: wiring.env, adminToken: wiring.adminToken,
    });
    if (!verdict.ok) return invalid(c, verdict.errors);

    await wiring.storage.put(CONFIG_KEY, verdict.next);
    // **让同一个进程的下一个请求一定重载。** 少了这一行，`GET /admin/api/overview`
    // 会在最多一个 `CONFIG_TTL_MS`（默认 30 秒）内继续报旧值。
    deps.configHolder.invalidate();

    // ── 回读。**从存储读，不是把 `verdict.next` 换个形状交回去。** ──────────────
    const after = await readAll(wiring, deps.logger);

    // 真的变了的公开字段。判据与它的全部理由见 `changedEffective()` 上方。
    const changed = changedEffective(before, after);

    /** 这次动过的凭据路径。**只报路径，不报值**——那正是 §8.6 的全部意思。 */
    const credentialsChanged = verdict.changed.filter((p) => SECRET_FIELDS.includes(p));

    if (verdict.changed.length > 0) {
      deps.logger.log({
        level: "warn", event: "config.updated",
        msg: "面板改了网关配置",
        fields: {
          // **只记路径，一个值都不记**：日志常被转发到第三方，而这批路径里有三把凭据。
          fields: verdict.changed.join(","),
          changedEffective: changed.join(","),
          secrets: credentialsChanged.length,
        },
      });
    }

    return c.json({
      fields: after.fields,
      credentials: after.credentials,
      configDegraded: after.configDegraded,
      loadBlocked: [...after.loadBlocked],
      changed,
      credentialsChanged,
      /**
       * ⚠️ **`appliedAt` 不是「已生效」的承诺，它就是服务器落盘的那一刻。**
       * 面板不许拿它渲染「已保存并生效」（设计 §5.3 明令不弹那句话）——真正
       * 该看的是上面回读出来的 `fields`，以及下面这个上界。
       */
      appliedAt: deps.now(),
      /**
       * 别的副本 / 别的 isolate 多久能看见这次改动。
       * **必须显示，不许写「立即生效」**（设计 §5.2）：本进程确实立刻生效
       *（上面那次 `invalidate()`），别的 isolate 要等 `CONFIG_TTL_MS` + KV 边缘缓存。
       */
      propagation: PROPAGATION,
    });
  };
}

/**
 * `POST /admin/api/config/validate` —— 干跑（设计 §11）。
 *
 * **一次存储写都不产生**：它跑的是与 `PUT` **同一个** `validateConfigPatch`，
 * 只是不写。另写一份「轻量版校验」就等于让干跑与真跑给出不同答案，那比没有干跑更坏。
 *
 * ⚠️⚠️ **「同一个函数」不等于「同一套判据」——上下文也必须逐字段一样。**
 * 第一版这里传的是 `{ stored, env }`，**漏了 `adminToken`**，而
 * `config-validate.ts` 的 `same_as_admin_token` 那一条判的正是
 * `ctx.adminToken !== undefined`（不给就静默跳过）⇒ 一份
 * `{ gatewayToken: <ADMIN_TOKEN> }` 的 patch 在干跑上是 **200 `{ok:true}`**、
 * 在 `PUT` 上是 **400 `same_as_admin_token`**：分叉方向是「干跑放行、真跑拒绝」，
 * 运维读到的是「面板刚说没问题」。上面那句话禁止的事，正被它自己下面这一行做着。
 * ⇒ **改这两处中的任何一处的上下文，都要把另一处一起改**；由
 * `tests/contract/admin-config.test.ts` 的「干跑与真跑对同一份输入给出同一组错误码」
 * 拿两个方向（`same_as_admin_token` / `maxStrikes`）钉住。
 */
export function configValidateHandler(deps: ConfigDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const patch = await readPatch(c);
    const stored = (await wiring.storage.get<unknown>(CONFIG_KEY)) ?? {};
    const verdict = validateConfigPatch(patch, {
      stored, env: wiring.env, adminToken: wiring.adminToken,
    });
    if (!verdict.ok) return invalid(c, verdict.errors);
    return c.json({ ok: true, changed: [...verdict.changed] });
  };
}

/**
 * `POST /admin/api/config/secrets/clear` —— 显式清空一把凭据（设计 §8.6）。
 *
 * **这是清空凭据的唯一入口。** `PUT` 里的空串一律是「不改」——把空串实现成清空，
 * 后果是运维保存一次设置页就抹掉 `gatewayToken`，而热实例因为 `Refreshable` 保留
 * 上一份快照**当场看不出任何异常**，直到下一次重启/回收才整个停摆。
 *
 * 清掉 `gatewayToken` 而环境变量里也没有时，这个后果**照样成立**——那是这条端点
 * 的既定语义（见 `clearSecret` 的说明），所以它打一条 `error` 级事件，
 * 面板侧配二次确认 + 红色警告。
 */
export function configClearSecretHandler(deps: ConfigDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);

    const body = asObject(await readAdminJson<unknown>(c), "请求体");
    const extra = Object.keys(body).filter((k) => k !== "path");
    if (extra.length > 0) {
      throw httpError(400, "invalid_request_error", `不认识的字段：${extra.join(", ")}`);
    }
    const path = body.path;
    if (typeof path !== "string" || !SECRET_FIELDS.includes(path)) {
      throw httpError(
        400, "invalid_request_error",
        `path 只能是这几条凭据之一：${SECRET_FIELDS.join(" / ")}`,
      );
    }

    const stored = (await wiring.storage.get<unknown>(CONFIG_KEY)) ?? {};
    const result = clearSecret(stored, path);
    // `SECRET_FIELDS.includes(path)` 上面已经查过，这一支走不到；留着它是因为
    // `clearSecret` 的契约里有这一档，吞掉返回值会让将来某次改动静默失败。
    if (!result.ok) throw httpError(400, "invalid_request_error", "这条路径不是凭据");

    /**
     * ⚠️⚠️ **清空之后这份配置还装载得起来吗——在写之前算好。**
     *
     * 第一版这里只判 `gatewayToken`（`nowMissing`），而**同构的通道凭据一条都没判**：
     * 清掉一条**在主/备链上**的通道 key 时，`put` 先发生 → 随后 `readAll` 抛
     *（`creds()`）→ 被 `app.onError` 吞成 **500**，于是**面板说「保存失败」，
     * 而那把凭据已经被删掉了**（实测逐字：`HTTP 500` + 存储里 `apiKey === undefined`）。
     * 那正是这段注释下面几行自己写着的禁令：「面板说失败、实际做了」。
     *
     * ⇒ 判据换成 `configLoadBlockers`（与 `PUT` 的跨字段校验、与诊断视图**同一份**），
     * 它天然覆盖 `gatewayToken` 与两条通道，将来多一条 `throw` 也只需改那一处。
     *
     * **仍然照常清空**（这是一条显式动作，运维自己的网关，不该替他做主），
     * 但：① 后果**如实进响应体**（`loadBlocked`）；② 审计**先落再回读**；
     * ③ 回读走降级后的 `readAll` ⇒ 不再有 500。
     */
    const blockedAfter = configLoadBlockers(result.next, wiring.env);

    await wiring.storage.put(CONFIG_KEY, result.next);
    deps.configHolder.invalidate();

    /**
     * 清完之后这一格还有没有值——**只看环境变量**（存储里那份刚被删掉）。
     * 不从回读结果里取：回读在诊断态下 `credentials` 是 `null`，而这件事本身
     * 与「装不装得起来」无关，用一个可能为 `null` 的东西去推它是自找的。
     */
    const envName = envNameOf(path);
    const stillConfigured = envName !== null && (wiring.env[envName] ?? "") !== "";

    /**
     * ⚠️ **审计先落，再回读。** 第一版把这条事件打在 `readAll` **之后**，
     * 于是回读抛错的那一支（正是最该留痕的那一支）**一条审计都没有**——
     * 存储被改了、面板收到 500、事件板块里什么都没有。
     */
    deps.logger.log({
      // 两支都是 `warn`：清空成功本身不是错误，装载不起来才是 error。
      level: blockedAfter.length > 0 ? "error" : "warn",
      event: "config.secret_cleared",
      msg: blockedAfter.length > 0
        ? "面板清空了一把凭据，清完之后这份配置已经装载不起来了——当前进程靠上一份快照还能跑，"
          + "但下一次冷启动会失败。请立刻在设置页里补回来，或把依赖它的那条通道从主/备里去掉。"
        : (stillConfigured
          ? "面板清空了存储里的一把凭据；环境变量里仍然有一份，生效值不变"
          : "面板清空了一把凭据；这份配置仍然装载得起来"),
      // **只记路径与机器可读的原因码**，值一个字都不记。
      fields: {
        path,
        stillConfigured,
        blocked: blockedAfter.map((b) => `${b.field}:${b.code}`).join(",") || null,
      },
    });

    const after = await readAll(wiring, deps.logger);
    return c.json({
      cleared: path,
      stillConfigured,
      /**
       * ⚠️ **保留这个字段名是为了不改前端契约**，但它现在是从 `loadBlocked` 派生的，
       * 而不是一条只认 `gatewayToken` 的独立判断。
       */
      gatewayTokenMissing: blockedAfter.some((b) => b.code === "gateway_token_required"),
      loadBlocked: [...blockedAfter],
      fields: after.fields,
      credentials: after.credentials,
      configDegraded: after.configDegraded,
      /**
       * **按下危险区那颗「重置配置」之后这份配置会缺什么**，判据与 `GET` 上那一格逐字同源
       *（`configLoadBlockers(RESET_VALUE, env)`：`RESET_VALUE` 是常量、`env` 手上就有 ⇒
       * **零额外存储读**，而且它的取值只随 `env` 变，与刚清掉的那把凭据无关）。
       *
       * ⚠️ **它是复评回填补上的（那条发现的另一半）**：面板清空一把凭据之后拿这条响应换掉了
       * 手上那份 `data`，而这条响应原来**没有**这一格 ⇒ 紧接着点「重置配置」时，
       * 前端的 `resetWarnings()` 读不到它。上一版前端把「读不到」与「空数组」折进同一档，
       * 于是弹窗照说一句没有依据的安心话；那一档现在单独报「判断不了」。
       * 补上这一格是为了让**清空凭据之后**那条正当路径仍然拿得到真判据，
       * 而不是退化成一句「判断不了」——三条响应从此形状一致。
       */
      resetBlocked: configLoadBlockers(RESET_VALUE, wiring.env),
      propagation: PROPAGATION,
    });
  };
}

/**
 * `POST /admin/api/config/reset` 的注册路径。**这个字符串是真源**：
 * `src/http/admin/router.ts` 从这里取，`tests/unit/docs-parity.test.ts` 的
 * 「危险区那两条端点的路径在五份 DEPLOY.md 的配额账里逐份写着 —— 路径从真源常量现算」
 * 也从这里取 ⇒ 改了它而五份文档没跟着改，那一格当场红。
 */
export const CONFIG_RESET_PATH = "/admin/api/config/reset";

/**
 * 重置写回的那个值。
 *
 * ⚠️ **是 `put({})`，不是 `delete(CONFIG_KEY)`**（设计小节「重置到底重置了什么」逐字三条理由）：
 * ① 与已上线的「清空凭据」走同一条写路径（本文件那两处 `storage.put`），形态一致；
 * ② 避开本仓已登记的 KV 删除墓碑那一族问题（`src/core/keypool-repo.ts` 的 `stillExists`
 *    那段：删除在 KV 上「最多一个传播窗口内可能复活」）；
 * ③ 配额落在 put 桶，与五语言 DEPLOY.md 那笔账已有的口径一致。
 *
 * ⚠️ **它与 `RESET_CONFIG=1` 不是一回事**：那个逃生口**只忽略不删**（设计 §5.4），
 * 存储里那份原值还在，改回 env 就能拿回来；这条端点是真的把它抹掉。
 */
const RESET_VALUE: Record<string, never> = {};

/**
 * `POST /admin/api/config/reset` —— 危险区第一颗按钮（「重置到底重置了什么」）。
 *
 * **重置的对象只有 `config` 这一把键**，其余八把业务键一个字节都不动。
 * 那张逐键表是一份**封闭登记**，写在 `tests/unit/docs-parity.test.ts` 的 `RESET_LEDGER` 上：
 * · 形状由 `tests/unit/docs-parity.test.ts` 的
 *   「封闭登记对这 9 个存储键逐把表态 —— 删掉登记里一行就红」钉着；
 * · **这一段函数体真的动了哪几把键**由同文件的
 *   「「重置配置」那一列裁决从重置实现现扫 —— 实现动了哪几把键，登记就得写哪几把」钉着
 *   ——它会把下面那句 `storage.put(CONFIG_KEY, …)` 从源码里扫出来，与登记逐条比对，
 *   **所以在这个函数体里多写一句 `put`/`delete` 会当场红**；
 * · 内容由 `tests/contract/admin-danger.test.ts` 的
 *   「重置配置之后，key:* / pool:index / tend:history / usage:* / event:* 的读回值不变」
 *   钉着。
 *
 * ── 与 `PUT` 逐条同源的四件事，一件都不许在这条新路径上退化 ───────────────────
 * ① **回执是回读出来的**，不是 handler 自己拼的一份空配置。写完再调一次
 *    `readAll()`，付一次读——它证明的是「存储里现在是什么」，而不是「handler 说它写了什么」。
 *    这条是本仓登记过的「写错了没有任何自动化会红」的那一行，绊线在
 *    `tests/contract/admin-danger.test.ts` 的
 *    「reset 的回执是回读出来的：写完之后存储被换掉，回执必须报出存储里那一份」。
 * ② **`invalidate()` 与回读是两件事**。少了它，`GET /admin/api/overview`
 *    会在最多一个 `CONFIG_TTL_MS` 内继续报旧值，而运维刚看到回执上是新值。
 * ③ **`changed` 走 `changedEffective()` 那一份判据**，不另写。
 * ④ **响应体里一个凭据明文都没有**：`credentials` 那一块由 `split()` 产出，
 *    只有 `{configured,hint,lockedBy}`。危险区不许开任何回显口子（全局约束 12）。
 *
 * ⚠️⚠️ **两态文案的判据是 `configLoadBlockers({}, env)`，不是「有没有 `GATEWAY_TOKEN`」。**
 * 重置 = `config` 整把写回 `{}`，它连**通道凭据**一起清，爆炸半径严格大于
 * 「清空一把凭据」那条单字段路径。本文件 `configClearSecretHandler` 里那段 ⚠️⚠️
 * 逐字记着第一版只判 `gatewayToken`、同构的通道凭据一条都没判的后果，
 * **这条新端点不许把那个缺口原样搬回来**。`{}` 就是重置之后存储里那份配置，
 * 所以这一句算的正是「重置之后装得起来吗」。
 * ⚠️ 而 `configLoadBlockers` **自己不完备**（它上方那段注释逐字说了：存储里
 * `registrar.targetKeys: "abc"` 这类它返回 `[]`、配置照样装不起来）——
 * **别把「`resetBlocked` 是空的」读成「重置之后一定装得起来」**。
 *
 * ⚠️ **`confirm: true` 是必填的，不是装饰**：枚举式鉴权矩阵会拿正确的管理口令把每一条
 * 路由真的打一遍（`tests/contract/admin-auth.test.ts` 的
 * 「每一条路由 × 每一种凭据状态，逐格断言」），一条不带请求体
 * 就会重置整份配置的端点会在那一格里**把夹具自己的配置抹掉**。带上它之后，
 * 空请求体在 `readAdminJson` 那一步就是 400，矩阵那一格断言的「不该被判 401」照样成立。
 */
export function configResetHandler(deps: ConfigDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);

    const body = asObject(await readAdminJson<unknown>(c), "请求体");
    const extra = Object.keys(body).filter((k) => k !== "confirm");
    if (extra.length > 0) {
      throw httpError(400, "invalid_request_error", `不认识的字段：${extra.join(", ")}`);
    }
    if (body.confirm !== true) {
      throw httpError(
        400, "invalid_request_error",
        "这一步不可撤销，必须显式带 confirm: true",
      );
    }

    // **写之前先回读一次**：`changed` 要拿它做对照。这一次读发生在任何写之前。
    // 走 `readAll` 而不是裸 `loadConfigWithProvenance`（同一条评审发现）：存储里那份配置
    // 已经装载不起来时，裸调用会抛 ⇒ 整条重置变成 500，而「装不起来」恰恰是运维
    // 最可能来按这颗按钮的时候。
    const before = await readAll(wiring, deps.logger);
    /** 重置之后这份配置还装不装得起来——**在写之前算好**，与 `clearSecret` 那条同源。 */
    const blockedAfter = configLoadBlockers(RESET_VALUE, wiring.env);

    await wiring.storage.put(CONFIG_KEY, RESET_VALUE);
    deps.configHolder.invalidate();

    // **审计先落，再回读**（与 `configClearSecretHandler` 同一条：回读抛错的那一支
    // 正是最该留痕的那一支）。**只记路径与机器可读的原因码，值一个字都不记。**
    deps.logger.log({
      level: blockedAfter.length > 0 ? "error" : "warn",
      event: "config.reset",
      msg: blockedAfter.length > 0
        ? "面板重置了存储里那份配置，重置之后它已经装载不起来了——当前进程靠上一份快照还能跑，"
          + "但下一次冷启动会失败。请立刻在设置页里把缺的那几格填回来。"
        : "面板重置了存储里那份配置；生效值回落到环境变量与内置默认值",
      fields: {
        blocked: blockedAfter.map((b) => `${b.field}:${b.code}`).join(",") || null,
      },
    });

    // ── 回读。**从存储读，不是把 `RESET_VALUE` 换个形状交回去。** ────────────────
    const after = await readAll(wiring, deps.logger);

    // 真的变了的公开字段。**与 `PUT` 同一份判据**，见 `changedEffective()` 上方。
    const changed = changedEffective(before, after);

    /**
     * 这次真的从「已配置」变成了「未配置」的那几把凭据。**只有路径，没有值。**
     *
     * ⚠️ **它是从回读出来的两份 `credentials` 差出来的，不是 handler 自己列的
     * `SECRET_FIELDS`**：环境变量里也提供了的那几把，重置之后仍然是「已配置」
     *（生效值纹丝不动）⇒ 不该出现在这份清单里。判据与 `changed` 同源——
     * 两格说的都是「回读前后真的变了的是哪些」。
     */
    const credentialsChanged = before.credentials === null || after.credentials === null
      ? []
      : Object.keys(before.credentials).filter((path) => {
        const b = before.credentials?.[path] as { configured?: unknown } | undefined;
        const a = after.credentials?.[path] as { configured?: unknown } | undefined;
        return b?.configured === true && a?.configured !== true;
      }).sort();

    return c.json({
      fields: after.fields,
      credentials: after.credentials,
      configDegraded: after.configDegraded,
      loadBlocked: [...after.loadBlocked],
      changed,
      credentialsChanged,
      /**
       * 重置之后这份配置装不装得起来的**逐条原因**（空数组 = 装得起来）。
       * 它与上面的 `loadBlocked` 今天算出来是同一批，但**来源不同**：这一格是
       * **写之前**按 `{}` 算的（面板据此在二次确认里就把后果说清），
       * `loadBlocked` 是**写之后回读**出来的。两格分叉时说明存储在这两步之间被别人动过。
       */
      resetBlocked: [...blockedAfter],
      /**
       * ⚠️ **不是「已生效」的承诺，就是服务器落盘的那一刻**（与 `PUT` 逐字同源）。
       * 面板不许拿它渲染「已重置并生效」。
       */
      appliedAt: deps.now(),
      /** 别的副本 / 别的 isolate 多久能看见这次重置。**必须显示，不许写「立即生效」**（设计 §5.2）。 */
      propagation: PROPAGATION,
    });
  };
}
