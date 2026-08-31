import type { Fetcher } from "../../ports/fetcher.js";
import { REGISTRAR_REQUEST_TIMEOUT_MS } from "./types.js";

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

/** 发验证码。**原样返回状态码不抛错**：400 表示该域名被 Agnes 屏蔽，调用方要据此换域名。 */
export async function sendCode(deps: AgnesDeps, email: string): Promise<number> {
  const url = `${deps.platformUrl}/api/verification?email=${encodeURIComponent(email)}&purpose=register`;
  const r = await deps.fetcher.fetch(url, {
    method: "GET",
    headers: { ...BASE_HEADERS, "x-user-language": "zh-CN" },
    signal: timeoutSignal(),
  });
  return r.status;
}

export async function register(
  deps: AgnesDeps, email: string, password: string, code: string,
): Promise<boolean> {
  const r = await deps.fetcher.fetch(`${deps.platformUrl}/api/user/register`, {
    method: "POST",
    headers: { ...BASE_HEADERS, "x-user-language": "zh" },
    body: JSON.stringify({ email, password, password_confirm: password, code }),
    signal: timeoutSignal(),
  });
  return r.ok;
}

/** 登录取 access_token。上游把令牌放在四个可能位置之一，四处都要认。 */
export async function login(
  deps: AgnesDeps, email: string, password: string,
): Promise<string | null> {
  const r = await deps.fetcher.fetch(`${deps.platformUrl}/api/user/login`, {
    method: "POST",
    headers: { ...BASE_HEADERS, "x-user-language": "zh" },
    body: JSON.stringify({ username: email, password }),
    signal: timeoutSignal(),
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
  const r = await deps.fetcher.fetch(`${deps.platformUrl}/api/token`, {
    method: "POST",
    headers: { ...BASE_HEADERS, "x-user-language": "zh-CN", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
    signal: timeoutSignal(),
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
