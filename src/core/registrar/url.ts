/**
 * 通道请求出错时，**把它实际打的那个地址说出来**——以及说出来之前先把凭据抹掉。
 *
 * ── 为什么需要脱敏（理由要写对，写错了下一个人会照着错的理由放松它）────────
 *
 * ⚠️ **要防的不是面板。** `registrar.yyds.baseUrl` 在 `src/core/config-provenance.ts`
 * 的 `FIELD_EXPOSURE` 里标的是 `"public"`，`GET /admin/api/config` 今天就把它明文
 * 返给已鉴权的管理员；事件板块同样在 `adminAuth` 之后。**「事件板块没鉴权」是假的，
 * 别把它写成理由。**
 *
 * 真正的理由有两条：
 * · `GET /admin/api/events/download`（`src/http/admin/router.ts`）的设计用途就是
 *   **被导出**——粘进 issue、贴进聊天窗口。导出的那一刻它就离开了鉴权边界。
 * · 事件同时进 `ConsoleLogger` ⇒ 容器 stdout / `wrangler tail`，那是另一个信任域。
 *
 * ── 射程（**盲区在这里登记，文档里不许说成「已脱敏」**）──────────────────────
 *
 * 只挡三处：**userinfo（用户名/口令）、查询串、片段**。
 * **凭据写在路径段里挡不住**——形如 `https://host/t/<token>/v1` 的地址会**原样**
 * 打进日志。这是已知缺口，不是遗漏：路径段里哪一段是凭据没有可靠判据，而
 * `config-provenance.ts` 里那条禁令（「不要用关键词启发式去兜底，那是一张手写词表」）
 * 逐字管着这种场合。
 *
 * ── 零 IO ─────────────────────────────────────────────────────────────────
 * 本文件在 `src/core/` 下：纯字符串函数，没有时间、没有随机、没有网络、没有环境。
 */

/**
 * `new URL()` 解析不开时的固定占位串。
 *
 * ⚠️ **刻意不回落成原样输出。** 解析不开的串照样可能含凭据——env 侧的
 * `YYDS_BASE_URL` / `MOEMAIL_BASE_URL` 只过 `asNonEmpty`（`./config.ts`），
 * 一道 URL 校验都不走，运维粘错半截带口令的串是完全可能的。
 * 而「它压根不是一个 URL」本身就是一条**完整的**诊断结论：知道这一点，
 * 运维就该去看自己填的那一格，而不是去查上游。
 */
export const UNPARSEABLE_URL = "<不是一个可解析的 URL>";

/**
 * 把一个 URL 变成可以安全写进日志的形态。
 *
 * 四条行为：
 * · 解析失败 ⇒ 返回 `UNPARSEABLE_URL`（**不回落原串**，理由见上）。
 * · userinfo 任一非空 ⇒ 两者清空，主机名前留 `***@` 这个**可见标记**。
 *   留标记而不是静默删掉：运维如果真把凭据塞进了 baseUrl，他需要知道我们抹了它。
 * · 查询串非空 ⇒ 整段换成 `?<redacted>`。**不做逐参数白名单**（同一条禁令）。
 *   留占位而不是直接删：`…/domains?x=1` 与 `…/domains` 在日志里必须读得出区别。
 * · 片段非空 ⇒ 同样换成 `#<redacted>`。这条不是洁癖：baseUrl 带 `#` 时，
 *   适配器里 `${baseUrl}/v1/domains` 追加的那段路径整个掉进 fragment，
 *   `fetch` 实际打的是原来的 pathname —— 这个占位符是那条失败形态唯一的线索。
 *
 * **幂等**：`redactUrl(redactUrl(x)) === redactUrl(x)`。判据只看「非不非空」，
 * 所以第二遍看到的 `***` / 被百分号编码过的占位串照样落回同一个输出。
 */
export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return UNPARSEABLE_URL;
  }
  const hadCreds = u.username !== "" || u.password !== "";
  const hadSearch = u.search !== "";
  const hadHash = u.hash !== "";
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  // 先清空再写回 `***`：直接改 username 会把 password 留在原地。
  if (hadCreds) u.username = "***";
  return `${u.href}${hadSearch ? "?<redacted>" : ""}${hadHash ? "#<redacted>" : ""}`;
}

/**
 * 通道请求非 2xx 时的统一错误消息模板，形如
 * `YYDS 列域名失败: HTTP 404 (GET https://maliapi.215.im/v1/v1/domains)`。
 *
 * **两条通道共用同一个模板**，与「两条邮箱通道完全平级」同源：只给一条通道带上
 * 地址，另一条的同类故障就没人守。
 *
 * ⚠️ **URL 拼进的是那条 Error 的 message，不是一个新的结构化字段**，代价明写：
 * · 收益 —— `src/core/registrar/mint.ts` 的 `registrar.list_domains_failed` 与
 *   `src/http/admin/handlers/registrar.ts` 的 `registrar.channel_test_failed`
 *   都只搬运 `err.message`，一个字都不用改就同时带上了地址；
 * · 代价 —— 地址因此是消息串的一部分，**面板不能按它筛选或聚合**。要结构化就得给
 *   Error 挂属性、再让 `mintOne` 把它读出来，那是 core 层的改动，为一条诊断信息
 *   不值当。这是有意取舍，不是遗漏。
 *
 * ⚠️ `method` 是一个**参数**而不是写死的 `GET`：`createMailbox` 打的是 POST，
 * 写死会让日志报一个它没发过的方法——那是新的一句假话。
 */
export function httpFailMessage(p: {
  provider: string;
  action: string;
  method: string;
  url: string;
  status: number;
}): string {
  return `${p.provider} ${p.action}失败: HTTP ${p.status} (${p.method} ${redactUrl(p.url)})`;
}
