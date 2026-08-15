/** 一个临时邮箱。`handle` 供 provider 内部定位（YYDS 用地址、MoeMail 用 id）。 */
export interface Mailbox {
  address: string;
  handle: string;
}

/**
 * 注册机链路上**每一个** HTTP 请求的超时上限（毫秒）。
 *
 * 为什么必须有：注册机的所有耗时预算（`CODE_TIMEOUT_MS`、Worker Cron 的 15 分钟
 * 墙钟）都建立在"每个请求都会及时返回"这个未言明的前提上。一次挂起的请求就能把
 * 单轮推过墙钟上限 → Cron 被平台中止 → 正在铸的那个邮箱的 `finally` 不会执行 →
 * 邮箱泄漏 → 悄悄耗尽活跃邮箱配额。P1 的转发路径（`core/dispatcher.ts`）本就带
 * `AbortController`，注册机这条链路此前是唯一的空白。
 *
 * 取 15 秒：这条链路上全是小 JSON 控制面请求（列域名、建邮箱、发码、注册、登录、
 * 建 key），比 P1 转发用的首字节超时（默认 8 秒）宽裕一倍，同时让"每个请求都超时"
 * 的病态情况仍是可算的有限值。用 `AbortSignal.timeout()` 而不是自建
 * `AbortController`+`setTimeout`：它是标准 Web API，Node 与 Workers 都原生支持，
 * 且定时器不会阻止进程退出。
 */
export const REGISTRAR_REQUEST_TIMEOUT_MS = 15_000;
