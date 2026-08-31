import type { MiddlewareHandler } from "hono";

function extract(c: Parameters<MiddlewareHandler>[0]): string | null {
  const authz = c.req.header("authorization");
  if (authz) {
    const trimmed = authz.trim();
    const m = /^bearer\s+(.+)$/i.exec(trimmed);
    if (m) return m[1]!;
    // Authorization 头存在但不是 Bearer 格式，返回原值或 null（取决于是否为空）
    return trimmed.length > 0 ? trimmed : null;
  }
  const extracted =
    c.req.header("x-api-key") ??
    c.req.header("x-goog-api-key") ??
    new URL(c.req.url).searchParams.get("key");

  // 空字符串、null、undefined 都视同无凭据
  if (extracted === null || extracted === undefined) {
    return null;
  }
  const trimmed = extracted.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 口令改成**每请求取一次**。原来是 `auth(token: string)`，口令在建 app 那一刻被
 * 闭包捕获，于是面板改／吊销口令对已经建好的 app 完全无效——这不是「没生效」，
 * 是「撤销不掉的凭据」。
 *
 * 比较仍用朴素 `!==`（非常数时间）。改它另行登记，尚未落地——管理端点的
 * 鉴权届时应实现成常数时间比较，本文件这条不是它的参照实现。
 */
export function auth(getToken: () => string): MiddlewareHandler {
  return async (c, next) => {
    if (extract(c) !== getToken()) {
      return c.json({ error: { message: "未授权：缺少或无效的凭据", type: "unauthorized" } }, 401);
    }
    await next();
  };
}
