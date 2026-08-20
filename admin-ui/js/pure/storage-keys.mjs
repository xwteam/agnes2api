/**
 * 面板用到的**全部浏览器存储键名，单一真源**。
 *
 * ⚠️ **这个文件是全分支评审 C4 的直接产物。** 在它出现之前，`agnes2api_admin_key`
 * 与 `agnes2api_admin_key_at` 这两个名字**各自在两个文件里被声明了两遍**
 *（写入方 `js/app.js` 一份、读取方 `js/api.js` 一份），而两份之间没有任何东西
 * 把它们绑在一起。实测：只改写入方那一处 ⇒ 登录成功、进壳层，随后每个请求送出去的
 * `x-admin-key` 是空串 ⇒ 401 ⇒ 登出循环，**面板彻底不可用，而 1357 条用例全绿**。
 *
 * 它同时满足 admin-ui/README.md 硬规则 1：判据（这里是"名字是什么"这个取值决策）
 * 不许留在板块/框架文件里各写一份。
 *
 * ⚠️ **`js/boot.js` 抄不了这里，那是结构性的，不是疏漏**：它是全站唯一的经典脚本
 *（`<head>` 里同步、非 module，理由见该文件头），**经典脚本没有 `import`**。
 * 于是主题与语言这两个名字在 `boot.js` 里必然是字面量。这条缺口不靠自觉，靠
 * `tests/ui/storage-keys.test.ts` 里"boot.js 的字面量必须与本模块逐字相同"那一格
 * 兜住——那一格也顺带钉住"除 boot.js 外任何文件都不许再写 `agnes2api_` 字面量"。
 *
 * 这个目录下的文件受三条硬规则约束（禁 import、禁浏览器全局、纯文本校验），
 * 规则全文见 admin-ui/README.md。
 */

/** 管理口令本身。**与下面那个时刻键必须一起写、一起清**，理由见 SAVED_AT_STORE。 */
export const KEY_STORE = "agnes2api_admin_key";

/**
 * 「口令是什么时候存下来的」。会话绝对上限靠它算年龄，判定本身在
 * `js/pure/session.mjs`（`sessionExpired`）。
 *
 * **两个键必须一起写、一起清**：只清口令不清时刻，下次登录前那个时刻还是旧的；
 * 只写口令不写时刻，`sessionExpired()` 拿不到时刻会把刚登录的会话判成过期
 *（方向是 fail closed，但用户会永远进不去）。
 */
export const SAVED_AT_STORE = "agnes2api_admin_key_at";

/** 上次停留在哪个板块（刷新复原用）。 */
export const SECTION_STORE = "agnes2api_section";

/** 主题。**`js/boot.js` 里有一份必然的字面量副本**，见文件头。 */
export const THEME_STORE = "agnes2api_theme";

/** 界面语言。同样在 `js/boot.js` 里有一份必然的字面量副本。 */
export const LANG_STORE = "agnes2api_lang";

/**
 * 开发期开关：为真时 `t()` 会把缺失的 key 打进控制台。
 * **面板自己从不写它**（只读），运维/开发者手工设，所以它没有"两处分叉"的风险；
 * 收进来只是为了让「除 boot.js 外不许再出现 `agnes2api_` 字面量」那条判据能收干净。
 */
export const DEBUG_STORE = "agnes2api_debug";
