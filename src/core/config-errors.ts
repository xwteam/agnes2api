/**
 * 配置错误的**词表与类型**，外加「网关拒绝服务」那一档的专用异常。
 *
 * ── 为什么它是一个独立的叶子模块 ────────────────────────────────────────────
 *
 * `ConfigError` / `CONFIG_ERROR_CODES` 原来住在 `src/core/admin/config-validate.ts`，
 * 装载侧全函数化之后 `src/core/registrar/config.ts` 也要产出 `ConfigError`。
 * 而 `config-validate.ts` 的第一行 import 的 `FIELD_EXPOSURE` 是一个**值**
 *（不是类型），来自 `src/core/config-provenance.ts`；后者又 import
 * `registrar/config.ts` ⇒ 把 `ConfigError` 留在原处会形成
 * `provenance → validate → provenance` 的**运行期值循环**，TDZ 风险随入口顺序变。
 *
 * ⇒ 词表搬到这个**零依赖的叶子**上，两边都从这里拿。`config-validate.ts` 顶部
 * **原样再导出一次**，它既有的调用方（`src/http/admin/handlers/config.ts`、
 * `tests/ui/settings.test.ts`、`tests/unit/admin/config-validate.test.ts`）
 * 一个 import 都不用改——先例是 `src/core/config.ts` 再导出 `envLockedFields`。
 *
 * ⚠️ **`configLoadBlockers` / `crossFieldErrors` 刻意没跟着搬**：它们的三个消费者
 *（`validateConfigPatch` 的跨字段阶段、`secrets/clear` 的写前预判、`readAll` 的
 * 诊断视图）全在 admin 层，搬走只会让一大片注释锚点失效而换不到任何东西。
 *
 * ── 零 IO ──────────────────────────────────────────────────────────────────
 * 本文件在 `src/core/` 下：没有时间、没有随机、没有网络、没有环境。
 */

/** 一条逐字段错误。`code` 是机器可读判别串，**面板靠它选五语言文案，不解析 message**。 */
export interface ConfigError {
  /** 面板路径，例如 `maxStrikes` / `registrar.yyds.baseUrl`。 */
  field: string;
  code: ConfigErrorCode;
  /** 渲染文案要的参数（下界、两个冲突值……）。**只放标量**，与 `LogEntry.fields` 同一条纪律。 */
  params?: Record<string, string | number>;
}

/**
 * 全部错误码。**单一真源是下面这个数组，类型从它派生。**
 *
 * ⚠️⚠️ **第一版是手写联合 + 测试里一份 `as const satisfies readonly ConfigErrorCode[]`
 * 的镜像，那条护栏实测是假的**（评审发现，我自己复现过）：`satisfies` 只做**单向
 * 可赋值检查**——它保证镜像里每一项都是合法的码，**不保证每一个码都在镜像里**。
 * 给联合加一个新码而不补 `ERROR_KEYS`、不补五语言 ⇒
 * `tsc exit=0`、`settings.test.ts` 34 passed、`check-i18n exit=0`，**零信号**；
 * 而反向（从联合里删一个）确实 `TS2322 ×2`。**删得住、加不住。**
 * 后果是：后端加错误码 ⇒ 面板 `errorMessageKey()` 返回 `null` ⇒ 走 `set.err.unknown`
 * **把裸码显示给运维**，没有任何东西会红。
 *
 * ⇒ 改成**数组是真源、类型是派生**：测试直接遍历 `CONFIG_ERROR_CODES`，
 * 加一个码而不补文案，`tests/ui/settings.test.ts` 的
 * 「后端产出的每一个错误码都有对应的 i18n 键 —— 加一个码不补文案就变红」当场红。
 */
export const CONFIG_ERROR_CODES = [
  /** 请求体里有本表不认识的字段（拼错的字段名在宽松实现下是一次「保存成功、什么都没发生」）。 */
  "unknown_field",
  /** 这个字段被环境变量锁定，写它不会生效——**拒绝而不是静默接受**，见 `validateConfigPatch` 里 `lockedBy` 那段。 */
  "locked_by_env",
  "not_an_integer",
  "below_min",
  "not_a_string",
  "not_a_boolean",
  "empty",
  "too_long",
  "not_a_url",
  "not_a_channel",
  /** 注册机开着却没选通道（装载器产出同名 blocker，注册机本次不启动）。 */
  "channel_required",
  "delay_min_gt_max",
  /** 注册机开着、这条通道被选中，却没有凭据（装载器产出同名 blocker）。 */
  "channel_credentials_missing",
  /**
   * ── 下面三条不是错误，是**不拦人的通知**（`RegistrarLoad.notices`）──────────
   *
   * ⚠️ **它们进这张表，是因为面板选文案走的是同一条路**（`errorMessageKey()`），
   * 而这张表是「每个码都有五语言文案」那格判据的遍历源。**不许因此把它们当 blocker
   * 用**：blocker 的意思是「注册机本次不启动」，这三条恰恰配着「注册机照常跑」。
   */
  /** 本次生效的通道值来自旧的存储键 `registrar.primary`（保存一次就会被规整掉）。 */
  "legacy_channel_key",
  /** 本次生效的通道值来自旧的环境变量名 `REGISTRAR_PRIMARY`（长期兼容，不设期限）。 */
  "legacy_channel_env",
  /**
   * 旧的备通道键还在，但它**不再参与选路**，被丢掉了。`params.dropped` 是那条通道名。
   *
   * ⚠️ **文案必须点名到具体通道，并且必须说清最咬人的那个场景**：一台部署的主通道
   * 凭据早已失效、一直靠备通道在铸 key，升级后产出会归零，而面板每一格都显示
   * 「已配置」。文案一旦写软成「备通道已弃用」，这就变成一次静默的生产事故。
   */
  "legacy_fallback_ignored",
  /** 两边都没有网关口令 ⇒ 冷启动会 fail-closed（`loadConfigWithProvenance` 抛 `ConfigRefusal`）。 */
  "gateway_token_required",
  /** 凭据首尾带空白：HTTP 头值在传输层被 trim，客户端**永远送不出**这个值。 */
  "whitespace_padded",
  /** 凭据含送不出去的字符（非可打印 ASCII）。判据与 `ADMIN_TOKEN` 那条同源。 */
  "not_sendable",
  "too_short",
  /** 网关口令不得等于 `ADMIN_TOKEN`：中转口令是发给每一个下游用户的。 */
  "same_as_admin_token",
  /**
   * **这份配置构造不出来，但说不出是哪一格。**
   *
   * ⚠️ **它的射程在装载器全函数化之后收窄了一大截，别照旧读。**
   * 从前它兜的是 `posInt()` 对存储里非数字的抛错那一整族；现在那一族退成了
   * **字段级降级**（回落默认值 + `config.invalid` 事件），压根不再让配置装不起来。
   * 今天真正落进这一档的只剩「`readAll` 的第二次就地重构造仍然抛，而
   * `configLoadBlockers` 说不出是哪一格」——改完之后那是一条很窄的路。
   * 保留它是因为「说不出哪一格」这件事本身必须有一个如实的表达，
   * **不编一个具体字段出来**；具体原因走事件板块。
   */
  "config_unloadable",
] as const;

export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number];

/**
 * 「网关拒绝服务」这一档的专用异常。**它与「配置有问题」不是一回事。**
 *
 * 逃出 `buildApp` 的**非** `ConfigRefusal` 异常按定义就是代码 bug，两个入口据此分流：
 * · `src/entry/worker.ts` 的 catch：`ConfigRefusal` ⇒ `503 reason:"not_configured"`，
 *   其余 ⇒ 维持不透明的 `500`；
 * · `src/entry/node.ts` 不分流（`main().catch` 打 `err.message` + `process.exit(1)`），
 *   那是 Node 形态正确的 fail-fast，一个字都不改。
 *
 * `message` 由抛点给，**逐字保留原文**：`src/entry/node.ts` 打的就是 `err.message`，
 * 五语言 DEPLOY.md 的故障排查条目引的也是那句原文（「缺少 GATEWAY_TOKEN，网关无法启动」）。
 *
 * ⚠️ **它不进任何未鉴权响应体。** Worker 那一支回的 `reason` 是**固定枚举串**，
 * 永不由 `err.message` 派生——配置细节一个字节都不到未鉴权调用方。
 */
export class ConfigRefusal extends Error {}
