/**
 * 面板会渲染的那一族管理接口错误的**机器可读码**。
 *
 * ⚠️⚠️ **这个文件里一个字的用户文案都不许有。** 文案住在
 * `admin-ui/js/i18n-dict.js` 的 `err.*` 命名空间里，五语言各一份，
 * 齐全性由 `node scripts/check-i18n.mjs` 的规则② 保证。
 * 这条禁令由 `tests/unit/admin/admin-errors.test.ts` 的
 * 「这个文件里没有任何用户文案 —— 码是码，文案在五语言字典里」扫着本文件的
 * 字符串字面量钉住（**只扫字面量，不扫注释**，边界见那一格）。
 *
 * ⚠️ **为什么是「后端回码 + 前端查字典」而不是「后端按 `Accept-Language` 返回」。**
 * 这就是 `admin-ui/js/pure/keys-write.mjs` 的 `isOpaqueErrorMessage` 上方那段
 * docblock 留给 P3e 的那次裁，理由写死在这里：
 * 1. 后端按 `Accept-Language` 返回，等于把**一整份五语言字典搬进 `src/`**——
 *    于是同一批文案有两份真源（面板一份、后端一份），本仓已经为这个形态付过多次代价；
 * 2. 面板的语言是**用户在面板里选的**（`admin-ui/js/i18n.js` 的 `setLang`，
 *    存在 localStorage 里），不一定等于浏览器的 `Accept-Language`
 *    ⇒ 后端那条路在「浏览器是 en 而用户把面板切到 ja」时给出的仍然是错的语言；
 * 3. 码是闭集、可被机器守（下面这张表 + 与字典的双向相等）；散文不是。
 *
 * ⚠️⚠️ **边界（如实写明，别当成全称承诺）。** 本表只覆盖**面板真的会把后端
 * `message` 画到屏幕上**的那一族，也就是 `admin-ui/js/sec-keys.js` 的
 * `errorMessage()` 够得着的那些端点（Key 池的四条写端点 + 管理鉴权那两条）。
 * 实测口径写在 `tests/unit/admin/admin-errors.test.ts` 的
 * 「面不许增长：src/http/admin/ 下带中文 message 的落点恰好这么多」那一格上方。
 *
 * **网关业务口**（`src/http/middleware/auth.ts`、`src/http/routes/gemini.ts`、
 * `src/http/routes/media.ts`、`src/core/dispatcher.ts`、`src/entry/worker.ts`）
 * 对 API 客户端**仍然只说中文**，
 * ⚠️ **条数刻意不写在这里**：P3e 计划 Task 22A 的需求书点的是「四条」，而按
 * `tests/unit/admin/admin-errors.test.ts` 的 `messageSites()` 换根目录现扫是**六处**
 * （多出 `media.ts` 的「视频任务标识格式非法」与 `dispatcher.ts` 的同步预算那句）。
 * **写死一个数只会再漂一次**，要数就去跑那个判据。
 * **本期不改**：那是四协议对外响应体的一部分，改它就是改已经写进五语言 API.md 的
 * 对外契约；而 API 客户端没有「用户选定的语言」，只能走 `Accept-Language`，
 * 正是上面第 1 条论证过不该做的那件事。它们**全部**伴随一个语言无关的
 * `type` / HTTP 状态码，程序化调用方不读 `message` 也能正确处理。
 * ⇒ 档位 MEDIUM，如实登记在 P3e 计划的「P3e 之后仍然欠着的」里，
 * **不许在任何地方说成「五语言破口已全部了结」**。
 * 「不许顺手给网关那一族也加码」这条由
 * `tests/unit/admin/admin-errors.test.ts` 的
 * 「网关业务口那一族一个 code 都不许有 —— 半做会造出第三种状态」钉着。
 */

/**
 * 全部管理接口错误码。**单一真源是这个数组，类型从它派生。**
 *
 * ⚠️ 这条「数组是真源、类型是派生」的写法与 `src/core/admin/config-validate.ts`
 * 的 `CONFIG_ERROR_CODES` 同源，理由全文在那里：手写联合 + 测试里一份
 * `satisfies` 镜像**只拦得住删、拦不住加**，而「加了码没补文案」正是会把裸码
 * 摆到运维脸上的那一档。
 *
 * ⚠️⚠️ **命名是全小写下划线，一个点都不许有。这不是风格偏好，是实测踩出来的。**
 * 第一版写成 `keys.notFound` / `admin.badJson` 那种点分形态，而
 * `node scripts/check-i18n.mjs` 的第 ① 条判据是「**命名空间前缀锚定的引号对**」
 * ——它把 `"keys.notFound"` 当成一次 i18n key 引用（`keys.` 正是字典里的一个命名空间），
 * 于是十条码逐条报「引用了字典里没有的 key」（实测 EXIT=1）。
 * 下划线形态同时也是本仓已有的码风格（`config-validate.ts` 的 `not_a_url`、
 * 设计 §11 的 `must_disable_first`、`probe-guard.ts` 的 `probe_cooldown`）。
 * 这一条由 `tests/unit/admin/admin-errors.test.ts` 的
 * 「码里一个点都不许有 —— 点分形态会被 i18n 门禁误当成 key 引用」钉着。
 */
export const ADMIN_ERROR_CODES = [
  // ── 整棵管理树共用的信封级错误 ──────────────────────────────────────
  /** 管理接口被停用（口令不合硬规则 / 与网关口令相同）。**响应体刻意不说原因**，见 `src/http/admin/auth.ts`。 */
  "admin_unavailable",
  /** 凭据缺失或不正确。⚠️ 面板走不到这条码的渲染路径：`admin-ui/js/api.js` 的 `raw()` 在 401 上直接清会话回登录闸。 */
  "admin_unauthorized",
  /** 请求体不是合法的 JSON。 */
  "bad_json",
  /** 请求体（或它里面某一层）必须是一个 JSON 对象，不是数组也不是标量。 */
  "body_not_an_object",
  /** 请求体里有本端点不认识的字段。**不是洁癖**：拼错的字段名在宽松实现下是一次「保存成功、什么都没发生」。 */
  "unknown_field",

  // ── Key 池那四条写端点 ──────────────────────────────────────────────
  /** 这个 id 在池子里不存在。 */
  "key_not_found",
  /** 删除前必须先停用（设计 §11）。**同一条约束在批量路径上是 200 + 逐项 `reason`**，见 `src/http/admin/handlers/keys-write.ts`。 */
  "must_disable_first",
  /** 某个布尔字段收到了非布尔值。 */
  "not_a_boolean",
  /** `note` 既不是字符串也不是 `null`。 */
  "note_not_a_string",
  /** `note` 超过了 `MAX_NOTE_LENGTH`。 */
  "note_too_long",
  /** `PATCH` 的请求体一个字段都没有——返回 200 就是一次「保存成功」而什么都没做。 */
  "empty_patch",
  /** 导入的 `keys` 不是字符串数组。 */
  "keys_not_a_string_array",
  /** 一次导入的把数超过了 `MAX_IMPORT_KEYS`。**超了就 400，不静默截断。** */
  "too_many_import_keys",
  /** 批量操作的 `op` 不在闭集里。 */
  "not_a_bulk_op",
  /** 批量操作的 `ids` 不是字符串数组。 */
  "ids_not_a_string_array",
  /** 一次批量操作的把数超过了 `MAX_IMPORT_KEYS`。 */
  "too_many_bulk_ids",
] as const;

export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];

/**
 * 每个码在响应体里带哪几格 `params`。**字典串里的 `{占位符}` 必须与它逐字相等。**
 *
 * ⚠️⚠️ **它存在的理由是 `node scripts/check-i18n.mjs` 的规则⑧ 对这一族结构性地看不见。**
 * 那条规则查的是「key 的字符串字面量后面紧跟着什么」，而这一族 key 出现在
 * `admin-ui/js/pure/keys-write.mjs` 的 `ADMIN_ERROR_TEXT_KEY` 里、是一张表的**值**
 * ——后面天然跟着逗号 ⇒ 那条规则照样绿，而面板上会画出裸的 `{max}`。
 * 这与那个脚本里已登记的「塞进数组时后面也是逗号，会漏过去」是同一个形态。
 * ⇒ 这一族改由**两条定点断言**守，两条都拿这张表当一侧：
 * · `tests/ui/keys-write.test.ts` 的
 *   「每个 code 的五语言字典串里的占位符与后端声明的 params 逐字相等」（字典侧）；
 * · `tests/contract/admin-keys-write.test.ts` 的
 *   「每条错误响应带的 params 与它那个 code 声明的逐字相等」（真 HTTP 侧）。
 * **两侧都是现扫现比，没有任何一张手写的期望表。**
 *
 * ⚠️ **`params` 里永不许出现中文**：它会被插进 ja/ko 的字典串里，等于把中文又漏回
 * 屏幕上——正是这次要关掉的那个破口的微缩版。**这一条钉在真 HTTP 响应体上**
 * （`params` 的值只有那一刻才是真的，源码里看到的是表达式）：
 * `tests/contract/admin-keys-write.test.ts` 的
 * 「params 里一个中文字符都不许有 —— 插进 ja/ko 的句子里就是同一个破口」，
 * 自带反向控制那一格。
 *
 * ⚠️ `satisfies Record<AdminErrorCode, …>` 在这里是**双向**的（少一个键 = 缺属性、
 * 多一个键 = 多余属性），与 `config-validate.ts` 那段警告的「数组 + satisfies 只拦得住删」
 * 不是同一个形状——那边的镜像是数组，这边是以码为键的记录。
 */
export const ADMIN_ERROR_PARAMS = {
  "admin_unavailable": [],
  "admin_unauthorized": [],
  "bad_json": [],
  "body_not_an_object": [],
  "unknown_field": ["fields"],
  "key_not_found": [],
  "must_disable_first": [],
  "not_a_boolean": ["field"],
  "note_not_a_string": [],
  "note_too_long": ["max"],
  "empty_patch": [],
  "keys_not_a_string_array": [],
  "too_many_import_keys": ["max"],
  "not_a_bulk_op": ["ops"],
  "ids_not_a_string_array": [],
  "too_many_bulk_ids": ["max"],
} as const satisfies Record<AdminErrorCode, readonly string[]>;

/**
 * 一个码是不是闭集里的。
 *
 * **给测试与运行期校验共用**：写成两份的话，「闭集」这个词在两处会各自漂。
 */
export function isAdminErrorCode(v: unknown): v is AdminErrorCode {
  return typeof v === "string" && (ADMIN_ERROR_CODES as readonly string[]).includes(v);
}
