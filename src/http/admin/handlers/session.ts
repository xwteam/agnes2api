import type { Context } from "hono";

/**
 * 登录探针。前端拿它验证「这把口令能不能用」，**不返回任何配置或池子信息**——
 * 它是登录闸背后的第一个端点，越薄越好。
 */
export function sessionHandler(version: string) {
  return (c: Context) => c.json({ ok: true, version });
}
