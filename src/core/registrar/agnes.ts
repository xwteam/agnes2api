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
/**
 * 读正文；读不出来（连接中途断了）按「没有正文」处理。
 *
 * 🔴 **本文件四步全走它，一步都不许直接 `r.json()`。** 直接 `json()` 的那一版把
 * **正文本身**吃掉了：解析失败时只剩一个 `null`，而「上游回了什么」正是调用点唯一
 * 能拿去归因的东西。四步统一成「先拿正文字符串、再自己解析」，`sendCode` 与
 * `register`/`login`/`createKey` 的形状因此是同一条。
 */
async function readBody(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

/** 正文解析成 JSON；不是合法 JSON 时返回 `null`（与「解析出 `null`」在下游同义：取不到字段）。 */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * ⚠️⚠️ **注册链四步共用的返回形状：上游的状态码与正文**（后三步各自再叠上
 * `ok` / `token` / `key`）。
 *
 * 上一版这三步分别是 `boolean` / `string | null` / `string | null` —— **状态码与正文
 * 在函数边界就被丢光了**，于是 `./mint.ts` 那三条事件只写得出一句「Agnes 注册被拒」，
 * 而四种真因（域名在注册这一步被拉黑 / 验证码过期 / 上游把字段改名了 / 这个出口的
 * 注册额度到顶）**在面板上长得一模一样**，处置却完全不同。
 * 对照 `sendCode`：它早就返回 `{status, body}`，`mint.ts` 据此把四档分得清清楚楚
 * —— 这三步只是当时漏掉的另一半。
 *
 * 🔴 **正文在这里不截断、不脱敏**，与 `sendCode` 逐字同一条纪律：脱敏是**调用点**的
 * 职责（它才知道这一步有哪些凭据在场：邮箱地址、我们自己生成的口令、上一步拿到的
 * 令牌），实现见 `./mint.ts` 的 `stepMessage`。本函数只负责把证据完整交出去。
 */
export interface StepResult {
  status: number;
  body: string;
}

export async function sendCode(
  deps: AgnesDeps, email: string,
): Promise<StepResult> {
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
  return { status: r.status, body: await readBody(r) };
}

export async function register(
  deps: AgnesDeps, email: string, password: string, code: string,
): Promise<StepResult & { ok: boolean }> {
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
  return { ok: r.ok, status: r.status, body: await readBody(r) };
}

/**
 * 登录取 access_token。上游把令牌放在四个可能位置之一，四处都要认。
 *
 * ⚠️ `token === null` 有两种形态，**靠 `status` 分**：非 2xx（上游拒了这次登录）与
 * 2xx 却没认出令牌（上游改了字段名）。`./mint.ts` 据此说两句不同的话。
 */
export async function login(
  deps: AgnesDeps, email: string, password: string,
): Promise<StepResult & { token: string | null }> {
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
  const status = r.status;
  const body = await readBody(r);
  const fail = { token: null, status, body };
  if (!r.ok) return fail;
  // 网关超时/维护页等场景会以 200 状态返回非 JSON 正文（与 mailbox-yyds.ts 的
  // 同类防御一致），解析失败按取不到令牌处理，不让异常穿透 mintOne 的返回契约。
  const data = parseJson(body);
  if (typeof data !== "object" || data === null) return fail;
  const d = (data as Record<string, unknown>).data;
  if (typeof d === "object" && d !== null) {
    const token = (d as Record<string, unknown>).access_token || (d as Record<string, unknown>).token;
    if (typeof token === "string") return { token, status, body };
  }
  const top = data as Record<string, unknown>;
  if (typeof top.access_token === "string") return { token: top.access_token, status, body };
  if (typeof top.token === "string") return { token: top.token, status, body };
  return fail;
}

export async function createKey(
  deps: AgnesDeps, token: string, name: string,
): Promise<StepResult & { key: string | null }> {
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
  const status = r.status;
  const body = await readBody(r);
  const fail = { key: null, status, body };
  if (!r.ok) return fail;
  // 同上：非 JSON 正文按取不到 key 处理，不抛错。
  const data = parseJson(body);
  if (typeof data !== "object" || data === null) return fail;
  const d = (data as Record<string, unknown>).data;
  if (typeof d === "object" && d !== null) {
    const key = (d as Record<string, unknown>).key;
    if (typeof key === "string") return { key, status, body };
  }
  const key = (data as Record<string, unknown>).key;
  if (typeof key === "string") return { key, status, body };
  return fail;
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
