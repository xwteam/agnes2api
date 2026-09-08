import type { Fetcher } from "../../ports/fetcher.js";
import { REGISTRAR_REQUEST_TIMEOUT_MS } from "./types.js";
import { fetchChannel } from "./fetch.js";

export interface AgnesDeps {
  fetcher: Fetcher;
  /** Agnes 站点后端，与网关转发用的 apihub 不是同一个服务。 */
  platformUrl: string;
}

const BASE_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
} as const;

/**
 * 注册链四步各自的单请求超时。没有它，一个挂起的连接就能把整轮补池拖过 Worker
 * Cron 的 15 分钟墙钟，正在铸的那个邮箱的清理（mintOne 的 finally）也就永远不会
 * 执行。与转发路径（core/dispatcher.ts）带 AbortController 的做法一致。
 */
const timeoutSignal = () => AbortSignal.timeout(REGISTRAR_REQUEST_TIMEOUT_MS);

/**
 * 发验证码。**原样返回状态码与正文，不抛错。**
 *
 * ⚠️⚠️ **这里原来只返回状态码，注释逐字写着「400 表示该域名被 Agnes 屏蔽」——
 * 那句话只对了一半。** 上游用 `400` 同时表达「这个域名被屏蔽了」与「你这个出口
 * 发得太频繁了」，而**正文是唯一的区分线索**。把正文整个丢掉，就等于在代码层面
 * 让这两件事永远分不开：一次出口级限流会被读成「这些域名被屏蔽了」，然后照着
 * 「换个域名就好」继续打，把上游的惩罚窗口一次次续上。
 *
 * 分辨交给 `./domain-ledger.ts` 的 `classifySendCode`，**而且那是启发式**
 *（词表匹配），这句话在那边的文件头逐字登记着。
 *
 * ⚠️ **正文在这里不截断、不脱敏**：那是调用点的职责（正文里可能带我们自己拼进
 * URL 的邮箱地址，进事件之前必须过 `./url.ts` 的脱敏并截断）。
 * 本函数只负责把证据完整交出去。
 */
export async function sendCode(
  deps: AgnesDeps, email: string,
): Promise<{ status: number; body: string }> {
  const url = `${deps.platformUrl}/api/verification?email=${encodeURIComponent(email)}&purpose=register`;
  const r = await fetchChannel({
    fetcher: deps.fetcher, provider: "Agnes", action: "发验证码", url,
    init: {
      method: "GET",
      headers: { ...BASE_HEADERS, "x-user-language": "zh-CN" },
      signal: timeoutSignal(),
    },
  });
  // 读正文失败（连接中途断了）按「没有正文」处理，不让它把一次已经拿到状态码的
  // 请求变成异常——与本文件 `login` / `createKey` 对非 JSON 正文的处置同一条。
  let body: string;
  try {
    body = await r.text();
  } catch {
    body = "";
  }
  return { status: r.status, body };
}

export async function register(
  deps: AgnesDeps, email: string, password: string, code: string,
): Promise<boolean> {
  const r = await fetchChannel({
    fetcher: deps.fetcher, provider: "Agnes", action: "注册",
    url: `${deps.platformUrl}/api/user/register`,
    init: {
      method: "POST",
      headers: { ...BASE_HEADERS, "x-user-language": "zh" },
      body: JSON.stringify({ email, password, password_confirm: password, code }),
      signal: timeoutSignal(),
    },
  });
  return r.ok;
}

/** 登录取 access_token。上游把令牌放在四个可能位置之一，四处都要认。 */
export async function login(
  deps: AgnesDeps, email: string, password: string,
): Promise<string | null> {
  const r = await fetchChannel({
    fetcher: deps.fetcher, provider: "Agnes", action: "登录",
    url: `${deps.platformUrl}/api/user/login`,
    init: {
      method: "POST",
      headers: { ...BASE_HEADERS, "x-user-language": "zh" },
      body: JSON.stringify({ username: email, password }),
      signal: timeoutSignal(),
    },
  });
  if (!r.ok) return null;
  // 网关超时/维护页等场景会以 200 状态返回非 JSON 正文（与 mailbox-yyds.ts 的
  // 同类防御一致），解析失败按取不到令牌处理，不让异常穿透 mintOne 的返回契约。
  let data: unknown;
  try {
    data = await r.json();
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = (data as Record<string, unknown>).data;
  if (typeof d === "object" && d !== null) {
    const token = (d as Record<string, unknown>).access_token || (d as Record<string, unknown>).token;
    if (typeof token === "string") return token;
  }
  if (typeof (data as Record<string, unknown>).access_token === "string") {
    return (data as Record<string, unknown>).access_token as string;
  }
  if (typeof (data as Record<string, unknown>).token === "string") {
    return (data as Record<string, unknown>).token as string;
  }
  return null;
}

export async function createKey(
  deps: AgnesDeps, token: string, name: string,
): Promise<string | null> {
  const r = await fetchChannel({
    fetcher: deps.fetcher, provider: "Agnes", action: "建 key",
    url: `${deps.platformUrl}/api/token`,
    init: {
      method: "POST",
      headers: { ...BASE_HEADERS, "x-user-language": "zh-CN", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
      signal: timeoutSignal(),
    },
  });
  if (!r.ok) return null;
  // 同上：非 JSON 正文按取不到 key 处理，不抛错。
  let data: unknown;
  try {
    data = await r.json();
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = (data as Record<string, unknown>).data;
  if (typeof d === "object" && d !== null) {
    const key = (d as Record<string, unknown>).key;
    if (typeof key === "string") return key;
  }
  const key = (data as Record<string, unknown>).key;
  if (typeof key === "string") return key;
  return null;
}

const PW_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 随机源注入以便测试可复现。末尾固定加一个非字母数字字符满足复杂度要求。 */
export function randomPassword(rand: () => number): string {
  let out = "";
  for (let i = 0; i < 14; i++) {
    out += PW_ALPHABET[Math.floor(rand() * PW_ALPHABET.length)]!;
  }
  return `${out}Q!`;
}
