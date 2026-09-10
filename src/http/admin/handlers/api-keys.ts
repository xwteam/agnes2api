import type { Context } from "hono";
import type { Logger } from "../../../ports/logger.js";
import type { Storage } from "../../../ports/storage.js";
import type { ApiKeyHolder } from "../../apikey-holder.js";
import { APIKEY_CACHE_TTL_MS } from "../../apikey-holder.js";
import { loadApiKeyTable, saveApiKeyTable, issueSecret, newApiKeyId } from "../../apikey-store.js";
import {
  APIKEY_MAX, API_KEY_NAME_MAX, apiKeyCounts, checkApiKeyExpiresAt, checkApiKeyName,
  digest, emptyApiKeyTable, hintOf, isApiKeyUsable, toApiKeyViews,
  type ApiKeyRecord, type ApiKeyTable,
} from "../../../core/admin/api-keys.js";
import { adminError, readAdminJson } from "../errors.js";

/**
 * 对外 API 密钥的五条端点。
 *
 * ⚠️⚠️ **路径是 `/admin/api/apikeys`，不是 `/admin/api/keys`。** 后者是**上游 key 池**
 * 那条已经发布的公开契约（我们持有、拿去向 Agnes 证明身份的凭据），改它等于破坏
 * 已发布的 API。两个名字很像是**已知代价**，缓解手段是文案与文档，不是改既有路径。
 * 两者的完整对照表在 `src/core/admin/api-keys.ts` 的文件头。
 *
 * 三条贯穿全文件的纪律，与 `keys-write.ts` 逐字同源：
 * ① **请求体一律 `unknown` + 逐字段窄化**（硬约束 8）；
 * ② **响应体里只有签发那一次的 201 带明文**，此后任何端点、任何字段都拿不到它
 *    ——由 `tests/contract/admin-apikeys.test.ts` 的
 *    「整个响应体子串扫描 —— 列表 / 单条改动 / 事件下载里都不含它」钉着：
 *    它扫的是**整个响应体文本**，不是查某个字段名（查字段名的话，
 *    哪天有人把明文塞进 `debug` 或错误信息里它照样绿）；
 * ③ **写操作看当前真值**：全部先 `loadApiKeyTable()` 直接读存储，不读持有者的快照
 *    ——读快照的话，一次「停用」可能建立在一份最多一个 TTL 前的视图上，
 *    把这期间别的 isolate（或别的运维）写下的记录整份覆盖回去。
 *
 * ── 读侧的配额账（写进五份 DEPLOY.md）─────────────────────────────────────────
 * `GET /admin/api/apikeys` **每次面板打开这个板块 1 次 get**。它刻意不走持有者的
 * 快照，两条理由：① 乐观并发的 `version` 必须是**刚读回来的那个**，读快照会让
 * 「拿旧版本写」这条护栏建立在一个更旧的版本上；② 只有直接读得出「表坏了」这一档，
 * 而那一档必须如实报给运维（快照里它与「还没签发过」长得一模一样）。
 */
export interface ApiKeyWiring {
  /** **与鉴权那条路径同一个存储实例**：写完 `invalidate()` 的正是它背后那份快照。 */
  storage: Storage;
  /** **与鉴权那条路径同一个持有者**，写完要作废它，否则新签发的密钥要等满一个 TTL。 */
  holder: ApiKeyHolder;
}

export interface ApiKeysDeps {
  /** **`null` = 这个 app 没接**，五条端点仍然注册、仍然鉴权，但如实回 `503 not_wired`。 */
  wiring: ApiKeyWiring | null;
  now: () => number;
  logger: Logger;
  /** 生效的缓存 TTL，`GET /admin/api/capabilities` 与本端点都要如实报它。 */
  cacheTtlMs: number;
}

/**
 * 没接线时的 503。**与 `registrar` / `config` 那两族逐字同源**：端点照常注册、
 * 照常鉴权，但不假装读到了一张空表——「这个 app 没接」与「一把密钥都没签发过」
 * 在面板上会长得一模一样，而后者是一句假话。
 *
 * ⚠️ **它走不带 `code` 的网关信封 + 顶层 `reason`**，与 `config.ts` 的 `notWired`
 * 逐字同源：这一档是「装配没走 `wire.ts`」，运维在容器日志里就该看到它，
 * 面板对它只有一句固定文案（按 `reason` 选），不需要一条要五语言维护的码。
 */
const REASON_NOT_WIRED = "not_wired";

function notWired(c: Context) {
  return c.json({
    error: { type: "internal_error", message: "这个部署没有接上对外 API 密钥的存储（装配没走 wire.ts 的 buildApp）" },
    reason: REASON_NOT_WIRED,
  }, 503);
}

/** 请求体必须是一个 JSON 对象（不是数组、不是标量）。与 `keys-write.ts` 那份同一条判据。 */
function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw adminError(400, "invalid_request_error", "body_not_an_object", "请求体必须是一个 JSON 对象");
  }
  return body as Record<string, unknown>;
}

/** 不认识的字段一律 400。理由与 `keys-write.ts` 的 `rejectUnknown` 逐字相同。 */
function rejectUnknown(o: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw adminError(
      400, "invalid_request_error", "unknown_field",
      `不认识的字段：${extra.join(", ")}`, { fields: extra.join(", ") },
    );
  }
}

function checkedName(v: unknown): string {
  const problem = checkApiKeyName(v);
  if (problem === "name_not_a_string") {
    throw adminError(400, "invalid_request_error", "name_not_a_string", "name 必须是字符串");
  }
  if (problem === "name_empty") {
    throw adminError(400, "invalid_request_error", "name_empty", "name 不能为空");
  }
  if (problem === "name_too_long") {
    throw adminError(
      400, "invalid_request_error", "name_too_long",
      `name 最长 ${API_KEY_NAME_MAX} 个字符`, { max: API_KEY_NAME_MAX },
    );
  }
  return (v as string).trim();
}

function checkedExpiresAt(v: unknown, now: number): number | null {
  const problem = checkApiKeyExpiresAt(v, now);
  if (problem === "expires_not_a_number") {
    throw adminError(
      400, "invalid_request_error", "expires_not_a_number",
      "expiresAt 必须是整数毫秒时间戳，或者 null（不过期）",
    );
  }
  if (problem === "expires_in_the_past") {
    throw adminError(
      400, "invalid_request_error", "expires_in_the_past",
      "expiresAt 已经过去了：签发一把生下来就过期的密钥不是一个有意义的动作",
    );
  }
  return v as number | null;
}

/**
 * 调用方手上那份快照的版本号。
 *
 * ⚠️ **它是必填的，而且必须是**调用方屏幕上那个数**。** 面板上那张列表是运维
 * **读过一眼**的，中间被别人签发 / 删掉一把时，一次「清理失效」会连带删掉他
 * 从来没见过的那一条。这与 `POST /admin/api/keys/purge` 的 `expect` 是同一条纪律，
 * 只是这一族拿版本号而不是条数（版本号能识别「删一把又加一把」这种条数没变的改动）。
 */
function checkedVersion(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw adminError(
      400, "invalid_request_error", "version_not_a_number",
      "version 必须是一个非负整数：它是你屏幕上那份列表的版本号",
    );
  }
  return v;
}

/**
 * 写之前回读一次。**那一次 get 本来就要付**（整表覆写必须建立在最新的一份上）。
 *
 * 读到坏值一律**拒绝写**：覆盖它是不可逆的，而坏掉的原字节此刻还完整地留在存储里
 *（`loadApiKeyTable` 一个 put 都不做，见那里的说明）。运维捞回它的办法写在
 * 五份 ADMIN.md 的排障一节。
 */
async function readForWrite(wiring: ApiKeyWiring): Promise<ApiKeyTable> {
  const read = await loadApiKeyTable(wiring.storage);
  if (read.kind === "invalid") {
    throw adminError(
      409, "conflict", "apikeys_unreadable",
      "存储里的对外 API 密钥表结构不认，本次写入已拒绝，以免覆盖掉里面还留着的内容",
    );
  }
  return read.kind === "ok" ? read.table : emptyApiKeyTable();
}

/**
 * 乐观并发。**它不是 CAS**：读到写之间仍有一个窗口，这一条在 `ApiKeyTable.version`
 * 上方与五份 ADMIN.md 里都写着，别在任何一处把它说成「不会丢更新」。
 */
function requireFresh(table: ApiKeyTable, given: number): void {
  if (table.version !== given) {
    throw adminError(
      409, "conflict", "stale_write",
      `这份列表已经被改过了：你看到的是第 ${given} 版，现在是第 ${table.version} 版。什么都没有改，请刷新后重来`,
      { expected: given, actual: table.version },
    );
  }
}

/** 路径参数 `:id`。理由与 `keys-write.ts` 的 `paramId` 逐字相同（刻意不写 `as string`）。 */
function paramId(c: Context): string {
  return c.req.param("id") ?? "";
}

/**
 * `GET /admin/api/apikeys` —— 列表 + 统计 + 版本号。
 *
 * ⚠️ **`unreadable: true` 时 `keys` 是空数组，而那**不是**「一把都没有」。**
 * 面板必须按 `unreadable` 这一格分支去渲染，不许拿 `keys.length === 0` 判——
 * 那正是本仓反复裁过的三态混一（「读不出来」被画成「没有数据」）。
 */
export function apiKeysListHandler(deps: ApiKeysDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const read = await loadApiKeyTable(wiring.storage);
    if (read.kind === "invalid") {
      return c.json({
        unreadable: true, version: null, keys: [], counts: apiKeyCounts([]),
        max: APIKEY_MAX, cacheTtlMs: deps.cacheTtlMs,
      });
    }
    const table = read.kind === "ok" ? read.table : emptyApiKeyTable();
    const views = toApiKeyViews(table.keys, deps.now());
    return c.json({
      unreadable: false, version: table.version, keys: views, counts: apiKeyCounts(views),
      max: APIKEY_MAX, cacheTtlMs: deps.cacheTtlMs,
    });
  };
}

/**
 * `POST /admin/api/apikeys` —— 签发，**201 带一次明文**。
 *
 * ⚠️⚠️ **这是全仓唯一一处在响应体里交出凭据明文的地方，边界必须钉死。**
 * 它与「凭据永远没有明文回显」那条既有姿态**局部相反**，而之所以成立，是因为
 * 这一族凭据**根本不存明文**（存的是 SHA-256），签发那一刻是它唯一存在过的时刻
 * ——不给出去就等于发了一把谁也拿不到的密钥。完整论证在
 * `src/core/admin/api-keys.ts` 的 `ApiKeyRecord.hash` 上方。
 * **代价明写：明文丢了找不回来，只能删掉重发。** 这句话在面板对话框、
 * 签发成功提示、五份 ADMIN.md 三处都要有。
 *
 * ⚠️ **本端点不收 `version`**，与另外三条刻意不同：签发是**追加**，
 * 它落在「刚刚回读出来的那一份」之上，不会覆盖任何别人写下的记录。
 * 收一个版本号只会让「两个人同时各签一把」这件完全正当的事失败一次。
 */
export function apiKeyIssueHandler(deps: ApiKeysDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const body = asObject(await readAdminJson<unknown>(c));
    rejectUnknown(body, ["name", "expiresAt"]);
    const now = deps.now();
    const name = checkedName(body.name);
    // 缺席 = 不过期。**与显式 `null` 同义**：面板那个「不过期」选项送的就是 `null`，
    // 而 cURL 用户不写这一格是同一个意思，让两者分道扬镳只会造出一条要解释的差异。
    const expiresAt = checkedExpiresAt(body.expiresAt === undefined ? null : body.expiresAt, now);

    const table = await readForWrite(wiring);
    if (table.keys.length >= APIKEY_MAX) {
      // **超了就 400，不静默截断**，与导入那条同规。
      throw adminError(
        400, "invalid_request_error", "too_many_apikeys",
        `最多只能有 ${APIKEY_MAX} 把对外 API 密钥`, { max: APIKEY_MAX },
      );
    }

    const secret = issueSecret();
    const record: ApiKeyRecord = {
      id: newApiKeyId(),
      name,
      hash: await digest(secret),
      // **明文落盘**（2026-09-10 用户拍板：以安全性换面板上的「显示明文/复制」）。
      // 代价与「升级前的记录没有这一格」两条，见 `ApiKeyRecord.secret` 的注释。
      secret,
      hint: hintOf(secret),
      createdAt: now,
      expiresAt,
    };
    const next = await saveApiKeyTable(wiring.storage, table, [...table.keys, record]);
    wiring.holder.invalidate();

    deps.logger.log({
      level: "warn", event: "apikey.issued",
      msg: "面板签发了一把对外 API 密钥",
      // **只记 id 与到期**，绝不记明文、绝不记摘要：日志常被转发到第三方。
      // ⚠️ 这一条在明文落盘之后**更要紧**了，不是更不要紧。
      fields: { id: record.id, expiresAt: record.expiresAt },
    });

    return c.json({
      // **明文只在这里**。字段名刻意叫 `secret` 而不是 `key`：这棵树上 `key`
      // 已经是上游池那一族的词，两族在同一份响应里撞名会让人读错。
      secret,
      record: toApiKeyViews([record], now)[0],
      version: next.version,
    }, 201);
  };
}

/**
 * PATCH 能改的那几件事。**顺序即文档顺序。**
 * `version` 不在其中——它是并发凭证，不是一个可改的字段。
 */
export const APIKEY_PATCH_FIELDS = ["name", "disabled", "expiresAt"] as const;

/**
 * `PATCH /admin/api/apikeys/:id` —— 改名 / 停用启用 / 改到期。
 *
 * ⚠️ **停用不是即时的**：本实例立刻生效（下面 `invalidate()`），而别的 isolate
 * 最多还要一个 `APIKEY_CACHE_TTL_MS` + KV 边缘缓存 ≈ **6 分钟**才看得见。
 * 这是安全相关的，面板的成功提示里要写这个具体数字，见 `apikey-holder.ts`。
 */
export function apiKeyPatchHandler(deps: ApiKeysDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const body = asObject(await readAdminJson<unknown>(c));
    rejectUnknown(body, [...APIKEY_PATCH_FIELDS, "version"]);
    const version = checkedVersion(body.version);
    const now = deps.now();
    const patch: Partial<ApiKeyRecord> = {};
    if (body.name !== undefined) patch.name = checkedName(body.name);
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") {
        throw adminError(400, "invalid_request_error", "not_a_boolean", "disabled 必须是布尔值", { field: "disabled" });
      }
      patch.disabled = body.disabled;
    }
    // ⚠️ **`expiresAt: null` 是「改成不过期」，缺席才是「这次不动它」**——
    // 两者绝不能合并，那正是 `keys-write.ts` 的 `optNote` 记的同一条。
    if (body.expiresAt !== undefined) patch.expiresAt = checkedExpiresAt(body.expiresAt, now);
    if (Object.keys(patch).length === 0) {
      // 空 patch 返回 200 就是一次「保存成功」而什么都没做。
      throw adminError(400, "invalid_request_error", "empty_patch", "至少要改一个字段");
    }

    const table = await readForWrite(wiring);
    requireFresh(table, version);
    const id = paramId(c);
    const at = table.keys.findIndex((r) => r.id === id);
    if (at < 0) throw adminError(404, "not_found", "apikey_not_found", "没有这把对外 API 密钥");
    const nextRecord: ApiKeyRecord = { ...table.keys[at]!, ...patch };
    const keys = [...table.keys];
    keys[at] = nextRecord;
    const next = await saveApiKeyTable(wiring.storage, table, keys);
    wiring.holder.invalidate();

    // 一次 PATCH 最多打一条事件，**停用优先**（同 `keyPatchHandler` 那条纪律）：
    // 它是唯一一个让密钥停止服役的动作，而事件板块是运维事后问「它为什么突然不能用了」
    // 时看的地方。只改名不打事件——名字不改变任何鉴权行为。
    if (patch.disabled === true) {
      deps.logger.log({
        level: "warn", event: "apikey.disabled",
        msg: "面板停用了一把对外 API 密钥（别的实例最多还要一个缓存周期才看得见）",
        fields: { id: nextRecord.id },
      });
    } else if (patch.disabled === false) {
      deps.logger.log({
        level: "info", event: "apikey.enabled",
        msg: "面板重新启用了一把对外 API 密钥",
        fields: { id: nextRecord.id },
      });
    }
    return c.json({ ok: true, record: toApiKeyViews([nextRecord], now)[0], version: next.version });
  };
}

/**
 * `DELETE /admin/api/apikeys/:id?version=N` —— `204` / `404` / `409`。
 *
 * ⚠️ **版本号走查询参数，不走请求体。** `DELETE` 带请求体在规范上合法，但中间代理
 * 与部分 HTTP 客户端会把它丢掉，而一条**被静默丢掉的并发凭证**在这里的后果是
 * 「运维以为自己带了那道保险，其实没带」。查询参数在每一层都活得下来。
 *
 * ⚠️ **它刻意没有「必须先停用才能删」那道前置**（上游池那边有）。两者的差别是真的：
 * 上游 key 删掉之后**那把凭据本身就没了**（明文只在存储里有一份，删了就再也拿不回来）；
 * 而这一族删掉的只是我们自己签发的一条验证记录，重发一把是完全正常的操作。
 * 给它加一道前置只会让「吊销一把已泄漏的密钥」变成两步——而那一步恰恰要越快越好。
 */
/**
 * `GET /admin/api/apikeys/:id/reveal` —— 取回一把密钥的**明文**。
 *
 * 🔴 **明文刻意不走列表响应，只走这条专门端点。** 塞进列表的话，每一次面板轮询、
 * 每一条被记下的响应体、每一个中间层缓存里都会带着全部客户端密钥的明文 ——
 * 而列表是**高频、无意识**被调用的。这条端点是**显式动作**，可以被审计。
 *
 * ⚠️ **升级前签发的记录没有明文**（`ApiKeyRecord.secret` 缺席）：如实回
 * `{ secret: null, reason: "issued_before_plaintext" }`，**不许用掩码或空串冒充**。
 */
export function apiKeyRevealHandler(deps: ApiKeysDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const table = await readForWrite(wiring);
    const id = paramId(c);
    const rec = table.keys.find((r) => r.id === id);
    if (!rec) throw adminError(404, "not_found", "apikey_not_found", "没有这把对外 API 密钥");

    // **取明文是一次凭据访问，必须留痕。** 与 `apikey.issued` 同级别（warn）：
    // 事件板块上运维要看得见「谁在什么时候把哪把密钥的明文调出来过」。
    deps.logger.log({
      level: "warn", event: "apikey.revealed",
      msg: "面板取回了一把对外 API 密钥的明文",
      // 只记 id 与「有没有明文」，**绝不记明文本身**：事件常被转发到第三方，
      // 这一条在明文落盘之后更要紧，不是更不要紧。
      fields: { id, available: rec.secret !== undefined },
    });

    if (rec.secret === undefined) {
      return c.json({ secret: null, reason: "issued_before_plaintext" });
    }
    return c.json({ secret: rec.secret });
  };
}

export function apiKeyDeleteHandler(deps: ApiKeysDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const raw = new URL(c.req.url).searchParams.get("version");
    const version = checkedVersion(raw === null ? null : Number(raw));
    const table = await readForWrite(wiring);
    requireFresh(table, version);
    const id = paramId(c);
    const at = table.keys.findIndex((r) => r.id === id);
    if (at < 0) throw adminError(404, "not_found", "apikey_not_found", "没有这把对外 API 密钥");
    const keys = table.keys.filter((_, i) => i !== at);
    await saveApiKeyTable(wiring.storage, table, keys);
    wiring.holder.invalidate();
    deps.logger.log({
      level: "warn", event: "apikey.deleted",
      msg: "面板删除了一把对外 API 密钥（拿着它的客户端最多再过一个缓存周期就会开始 401）",
      fields: { id },
    });
    return c.body(null, 204);
  };
}

/**
 * `POST /admin/api/apikeys/purge` 的注册路径。**这个字符串是真源**，
 * `src/http/admin/router.ts` 从这里取，理由与 `KEYS_PURGE_PATH` 那段逐字相同。
 */
export const APIKEYS_PURGE_PATH = "/admin/api/apikeys/purge";

/**
 * `POST /admin/api/apikeys/purge` —— 一次清掉全部「已失效」（已停用或已过期）。
 *
 * **单价恒是 1 次 put，0 次 delete**（整表覆写，见 `apikey-store.ts` 的文件头），
 * 与上游池那条 `N 次 delete + 1 次 put` 不是同一个量级——这是单 blob 的直接好处。
 *
 * ⚠️ **判据是 `!isApiKeyUsable`，也就是「此刻用不了的那些」**，与面板上那两张
 * 统计卡（已停用 / 已过期）之和逐条相同。**不许在这里另写一条判据**：
 * 面板上写着「清理失效（N）」，而 N 是按分档数出来的——两份判据一漂，
 * 那颗按钮删掉的条数就与它自己写的数字对不上。
 */
export function apiKeysPurgeHandler(deps: ApiKeysDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) return notWired(c);
    const body = asObject(await readAdminJson<unknown>(c));
    rejectUnknown(body, ["version"]);
    const version = checkedVersion(body.version);
    const table = await readForWrite(wiring);
    requireFresh(table, version);
    const now = deps.now();
    const kept = table.keys.filter((r) => isApiKeyUsable(r, now));
    const deleted = table.keys.length - kept.length;
    const next = await saveApiKeyTable(wiring.storage, table, kept);
    wiring.holder.invalidate();
    if (deleted > 0) {
      deps.logger.log({
        level: "warn", event: "apikey.deleted",
        msg: "面板清理了全部已失效的对外 API 密钥",
        // **只记数**：一次清理的 id 可能有上百个，而 `LogEntry.fields` 的值是标量
        //（同 `BULK_EVENT_IDS_MAX` 那段）。
        fields: { count: deleted, remaining: kept.length },
      });
    }
    return c.json({ deleted, remaining: kept.length, version: next.version });
  };
}

/** `GET /admin/api/capabilities` 里 `apiKeys` 那一格。**面板据它显隐，不在前端自己判。** */
export function apiKeysCapability(deps: { wired: boolean; cacheTtlMs: number }) {
  return {
    /** 这个 app 接没接对外密钥的存储。为假时面板画一句「这个部署没接」，不画空列表。 */
    wired: deps.wired,
    max: APIKEY_MAX,
    nameMax: API_KEY_NAME_MAX,
    /**
     * **明文取不取得回来。** 面板据它决定「有没有『显示明文 / 复制完整密钥』这两颗
     * 按钮」——**不许在前端写死**，写死就会在哪天有人改了后端存法时变成假话。
     *
     * ⚠️ **这一格从前是「恒 false」，2026-09-10 起不再是。** 用户拍板把
     * `ApiKeyRecord` 改成同时存明文（以安全性换面板上的显示/复制），
     * 代价的完整登记见 `src/core/admin/api-keys.ts` 的 `ApiKeyRecord.secret`。
     * 这一格当初被设计成「契约而不是状态」正是为了这一天：后端存法一变，
     * 面板自己就跟着变，不需要去改前端。
     *
     * 🔴 **它是「这个部署能不能取回明文」，不是「每一把都取得回来」**：
     * 升级之前签发的记录没有明文，reveal 端点对它们会如实回
     * `{ secret: null, reason: "issued_before_plaintext" }`，面板要照实说明，
     * **不许用掩码或空串冒充明文**。
     */
    plaintextRetrievable: true,
    /** 生效的缓存 TTL。面板据它算「停用之后最多还能用多久」，**不许在前端写死**。 */
    cacheTtlMs: deps.cacheTtlMs,
    /** 后端常量的默认值，面板在说明里要写清「运维没调过时是多少」。 */
    defaultCacheTtlMs: APIKEY_CACHE_TTL_MS,
  };
}
