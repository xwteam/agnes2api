import type { Storage } from "../ports/storage.js";
import {
  APIKEY_SECRET_PREFIX, API_KEY_SECRET_BYTES,
  parseApiKeyTable, type ApiKeyRecord, type ApiKeyTable, type ApiKeyTableRead,
} from "../core/admin/api-keys.js";

/**
 * 对外 API 密钥表的存储层。**放入口层而不是 core：它要碰存储、要用随机数。**
 *
 * ── 为什么是**单个** blob，不是「逐条 + 索引」（上游池那一套）────────────────
 * 上游池是 `key:<id>` 逐条 + `pool:index`，一次刷新要 `1 + N` 次 get。
 * 五份 DEPLOY.md 的配额账已经写死：默认值 + 20 把上游 key + 3 个活跃副本
 * **已经用掉约 99.4% 的读配额**。在那之上再叠一份同量级的 `1 + N`，
 * **当场把免费档的读桶打穿，而且是在默认配置上打穿**。
 * 单 blob 把这一维从 `O(N)` 压成 `O(1)`：一次刷新恒 1 次 get，一次写恒 1 次 put、
 * 0 次 delete、0 次 list。
 *
 * 代价是**丢失更新**（整表覆写），由 `ApiKeyTable.version` 挡：写之前回读一次，
 * 调用方手上的版本对不上就 409。**它不是 CAS**，残余窗口写在那个字段上方。
 */

/**
 * 存储里那个键。**这是真源**：`src/http/admin/handlers/api-keys.ts` 与全部测试
 * 都从这里取，不写第二遍字面量。
 */
export const APIKEY_KEY = "apikeys";

/**
 * 一把新密钥的明文。**`sk-` + 32 位十六进制（128 bit）。**
 *
 * ⚠️ **它住在这一层而不是 `src/core`**：`crypto.getRandomValues` 是不可重放的，
 * 而「不可重放」正是 `src/core` 零 IO 那条硬约束存在的理由。core 里今天一条随机源
 * 豁免都没有（`registrar/mint.ts` 那条 `Math.random` 是**可注入参数的默认值**，
 * 不是同一类），本任务不打算开这个先例——摘要那一条豁免够了。
 *
 * ⚠️ **绝不许改成 `Math.random()`**：那是可预测的伪随机，一把能被预测的对外密钥
 * 等于没有密钥。`crypto.getRandomValues` 在 Workers 与 Node 都是标准全局。
 */
export function issueSecret(): string {
  const bytes = new Uint8Array(API_KEY_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return APIKEY_SECRET_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 一条记录的 id 有多少字节（十六进制之后是它的两倍位数）。见 `ApiKeyRecord.id`。 */
const API_KEY_ID_BYTES = 6;

/**
 * 一条新记录的 id。**独立随机，与密钥本身没有任何函数关系**——
 * id 会进 URL 与事件日志，那些地方不该携带密钥的任何函数值（见 `ApiKeyRecord.id`）。
 */
export function newApiKeyId(): string {
  const bytes = new Uint8Array(API_KEY_ID_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 读一次。**一次 get，零写。**
 *
 * ⚠️⚠️ **这条路径上一个 `put` 都不许有，这不是风格问题。** 它被鉴权中间件的第②段
 * 调用，而那一段**零凭据、零限速**：任何人拿一把错口令打 `/v1/chat/completions`
 * 都能走到这里。一次「读到坏值就顺手把原字节另存一份」的写，会把每个错口令请求
 * 变成一次 KV 写——免费档每天 1,000 次写，当场被打穿，并连带打死 key 池的状态回写。
 *
 * ⇒ **坏值的处置是「原地不动 + 如实降级 + 写路径拒绝覆盖」，不是另存一份。**
 * 这比"另存旁路"更强：坏掉的原字节留在 `apikeys` 键里**根本没被动过**，
 * 而写路径（`src/http/admin/handlers/api-keys.ts`）读到 `invalid` 一律拒绝落盘
 * ⇒ 没有任何一条路径会覆盖它。人工捞回的办法写在五份 ADMIN.md 的排障一节里。
 */
export async function loadApiKeyTable(storage: Storage): Promise<ApiKeyTableRead> {
  return parseApiKeyTable(await storage.get<unknown>(APIKEY_KEY));
}

/**
 * 整表写回，**版本号加一**。一次 put。
 *
 * `base` 是**刚刚回读出来的那一份**（不是调用方手上那份陈旧快照）——
 * 版本号从它加一，记录集合由调用方在它之上算出来。
 */
export async function saveApiKeyTable(
  storage: Storage, base: ApiKeyTable, keys: readonly ApiKeyRecord[],
): Promise<ApiKeyTable> {
  const next: ApiKeyTable = { version: base.version + 1, keys: [...keys] };
  await storage.put(APIKEY_KEY, next);
  return next;
}
