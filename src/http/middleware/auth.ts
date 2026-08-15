import type { MiddlewareHandler } from "hono";

function extract(c: Parameters<MiddlewareHandler>[0]): string | null {
  const authz = c.req.header("authorization");
  if (authz) {
    const m = /^bearer\s+(.+)$/i.exec(authz.trim());
    if (m) return m[1]!;
    return authz.trim();
  }
  const extracted =
    c.req.header("x-api-key") ??
    c.req.header("x-goog-api-key") ??
    new URL(c.req.url).searchParams.get("key");

  // 拒绝空或纯空白的凭据，视同无凭据
  if (extracted && extracted.trim().length === 0) {
    return null;
  }
  return extracted;
}

export function auth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (extract(c) !== token) {
      return c.json({ error: { message: "未授权：缺少或无效的凭据", type: "unauthorized" } }, 401);
    }
    await next();
  };
}
