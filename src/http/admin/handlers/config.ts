import type { Context } from "hono";
import type { Logger } from "../../../ports/logger.js";
import type { Storage } from "../../../ports/storage.js";
import type { ConfigHolder } from "../../config-holder.js";
import { CONFIG_TTL_MS, KV_EDGE_CACHE_MS } from "../../config-holder.js";
import {
  loadConfigWithProvenance, type ConfigProvenance, type Env, type FieldSource,
} from "../../../core/config-provenance.js";
import {
  validateConfigPatch, clearSecret, SECRET_FIELDS, EDITABLE_FIELDS, type ConfigError,
} from "../../../core/admin/config-validate.js";
import { httpError, readJson } from "../../errors.js";

/**
 * 配置的四条管理端点（设计 §5.3 / §5.4 / §8.6 / §10.4 / §11）。
 *
 * | 方法 | 路径 | 干什么 | 写存储吗 |
 * |---|---|---|---|
 * | GET | `/admin/api/config` | 逐字段四元组 + 凭据的 `{configured,hint}` | **否** |
 * | PUT | `/admin/api/config` | 校验 → 写 → invalidate → **回读** | **是**（成功时 1 次 put） |
 * | POST | `/admin/api/config/validate` | 干跑，只回错误 | **否，一次都不写** |
 * | POST | `/admin/api/config/secrets/clear` | 显式清空一把凭据 | **是** |
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
 *    看到的也是新值」（F7）。少了后者，`GET /admin/api/overview` 会在最多一个
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
 * 一次装载 + 切块。**读失败一律如实抛**（由 `app.onError` 转成 500 固定文案）：
 * 这个端点存在的全部意义就是说清「现在到底是什么」，编一份空数据出来比报错更坏。
 */
async function readAll(wiring: ConfigWiring, logger: Logger): Promise<{
  prov: ConfigProvenance;
  fields: Record<string, unknown>;
  credentials: Record<string, unknown>;
}> {
  const prov = await loadConfigWithProvenance(wiring.env, wiring.storage, logger);
  return { prov, ...split(prov.source) };
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
 * **一次存储写都不产生**，读侧是 1 次 `get("config")`。
 */
export function configGetHandler(deps: ConfigDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const { prov, fields, credentials } = await readAll(wiring, deps.logger);
    return c.json({
      fields,
      credentials,
      /** 本次装载有没有降级。红色横幅的依据，与 `GET /admin/api/overview` 同一个值。 */
      configDegraded: prov.config.degraded,
      /** 面板能改的字段清单。**从后端给**，前端不另写一份（写两份必漂）。 */
      editable: [...EDITABLE_FIELDS],
      /** 哪几条路径是凭据。前端据此渲染「留空则不修改」的占位符与清空按钮。 */
      secrets: [...SECRET_FIELDS],
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
  const body = asObject(await readJson<unknown>(c), "请求体");
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
 * 数着 put 计数钉住（只断言状态码抓不住这个形态，与 F9 同一个形状）。
 */
export function configPutHandler(deps: ConfigDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);

    const patch = await readPatch(c);
    // **写之前先把当前状态读出来**：校验要拿它做合并（「缺席 = 不改」），
    // 回执里的 `changed` 也要拿它做对照。这一次读发生在任何写之前。
    const before = await loadConfigWithProvenance(wiring.env, wiring.storage, deps.logger);
    const storedBefore = (await wiring.storage.get<unknown>("config")) ?? {};

    const verdict = validateConfigPatch(patch, { stored: storedBefore, env: wiring.env });
    if (!verdict.ok) return invalid(c, verdict.errors);

    await wiring.storage.put("config", verdict.next);
    // **F7：让同一个进程的下一个请求一定重载。** 少了这一行，`GET /admin/api/overview`
    // 会在最多一个 `CONFIG_TTL_MS`（默认 30 秒）内继续报旧值。
    deps.configHolder.invalidate();

    // ── 回读。**从存储读，不是把 `verdict.next` 换个形状交回去。** ──────────────
    const after = await readAll(wiring, deps.logger);

    /**
     * 真的变了的公开字段（**按回读出来的 `effective` 比**，不是按 patch 比）。
     *
     * 这个区别是有后果的：`TARGET_KEYS=30` 锁着时，一次「把 targetKeys 改成 20」
     * 的 patch 会被 `locked_by_env` 拒掉——但即使没被拒（比如将来放宽了锁定语义），
     * 按 patch 比会说「改了」，而生效值纹丝不动。**面板高亮的必须是真的变了的那些。**
     * 凭据不进这份清单（它们没有可比的公开值），改没改由 `credentialsChanged` 报。
     */
    const changed = Object.keys(after.prov.source).filter((path) => {
      const a = before.source[path];
      const b = after.prov.source[path];
      if (a === undefined || b === undefined) return false;
      if (a.exposure !== "public" || b.exposure !== "public") return false;
      return JSON.stringify(a.effective) !== JSON.stringify(b.effective);
    }).sort();

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
      configDegraded: after.prov.config.degraded,
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
 */
export function configValidateHandler(deps: ConfigDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const patch = await readPatch(c);
    const stored = (await wiring.storage.get<unknown>("config")) ?? {};
    const verdict = validateConfigPatch(patch, { stored, env: wiring.env });
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

    const body = asObject(await readJson<unknown>(c), "请求体");
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

    const stored = (await wiring.storage.get<unknown>("config")) ?? {};
    const result = clearSecret(stored, path);
    // `SECRET_FIELDS.includes(path)` 上面已经查过，这一支走不到；留着它是因为
    // `clearSecret` 的契约里有这一档，吞掉返回值会让将来某次改动静默失败。
    if (!result.ok) throw httpError(400, "invalid_request_error", "这条路径不是凭据");

    /**
     * ⚠️⚠️ **清掉 `gatewayToken` 而环境变量里也没有 ⇒ 下一次装载会抛
     * 「缺少 GATEWAY_TOKEN」**（§5.4 的 fail-closed 反噬）。
     *
     * **这件事必须在写之前算好，而不是靠 try/catch 兜住那次回读。** 两条理由：
     * ① 回读抛出去会变成一个 500，而清空**已经发生了**——「面板说失败、实际做了」
     *    正是本仓反复裁过的那类谎，方向还比通常那条更坏；
     * ② 泛泛地 `catch` 那次回读会把**真的存储故障**也吞成这一支，于是一次
     *    KV 抖动会被报成「你把口令删光了」，运维照着去重设一把不存在的问题。
     *
     * 处置：照常清空（这是一条显式动作），**但如实说清后果**，并打一条 `error`
     * 事件。热实例因为 `Refreshable` 保留上一份合法快照不会当场停摆，所以这件事
     * 在面板上本来是**看不见**的——`gatewayTokenMissing` 就是让它可见的那一格。
     * 恢复路径也如实给：这一刻面板还活着（`ADMIN_TOKEN` 只从环境变量来，与它无关），
     * 直接 `PUT` 一把新的 `gatewayToken` 就行。
     */
    const nowMissing = path === "gatewayToken" && wiring.env.GATEWAY_TOKEN === undefined;

    await wiring.storage.put("config", result.next);
    deps.configHolder.invalidate();

    if (nowMissing) {
      deps.logger.log({
        level: "error", event: "config.secret_cleared",
        msg: "面板清空了 gatewayToken，且环境变量里也没有——当前进程靠上一份快照还能跑，"
          + "但下一次冷启动会起不来。请立刻在设置页里写一把新的网关口令。",
        // **只记路径**，值一个字都不记。
        fields: { path, stillConfigured: false, gatewayTokenMissing: true },
      });
      // **不回读**：这一刻的装载一定抛（见上）。四元组给 `null`，面板据此显示
      // 一句「读不回来了」而不是一份编出来的空配置。
      return c.json({
        cleared: path,
        stillConfigured: false,
        gatewayTokenMissing: true,
        fields: null,
        credentials: null,
        configDegraded: null,
        propagation: PROPAGATION,
      });
    }

    const after = await readAll(wiring, deps.logger);
    const stillConfigured = (after.credentials[path] as { configured: boolean } | undefined)?.configured === true;
    deps.logger.log({
      level: stillConfigured ? "warn" : "error",
      event: "config.secret_cleared",
      msg: stillConfigured
        ? "面板清空了存储里的一把凭据；环境变量里仍然有一份，生效值不变"
        : "面板清空了一把凭据，且环境变量里也没有——补池会因此拿不到它",
      fields: { path, stillConfigured, gatewayTokenMissing: false },
    });

    return c.json({
      cleared: path,
      stillConfigured,
      gatewayTokenMissing: false,
      fields: after.fields,
      credentials: after.credentials,
      configDegraded: after.prov.config.degraded,
      propagation: PROPAGATION,
    });
  };
}
