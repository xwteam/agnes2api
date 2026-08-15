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

export function auth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (extract(c) !== token) {
      return c.json({ error: { message: "未授权：缺少或无效的凭据", type: "unauthorized" } }, 401);
    }
    await next();
  };
}
