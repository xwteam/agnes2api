/**
 * 邮件模板里常见的 CSS 十六进制颜色。它们会被 `\b\d{6}\b` 误命中，必须排除——
 * 否则 `background:#ffffff` 里的 ffffff 不会中招（含字母），但 `#123456` 这类会。
 */
const CSS_COLOR_LIKE = /#[0-9a-fA-F]{6}\b/g;

export function extractCode(subject: string, body: string): string | null {
  if (!body) return null;

  // 优先：模板通常给验证码套一个带 verification 字样的类名，这是最可靠的锚点。
  const tagged = body.match(/class=["'][^"']*verification[^"']*["'][^>]*>\s*(\d{6})\s*</);
  if (tagged) return tagged[1]!;

  // 兜底：先把十六进制颜色抹掉，再找第一个独立的六位数。
  const cleaned = `${subject} ${body}`.replace(CSS_COLOR_LIKE, " ");
  const m = cleaned.match(/\b(\d{6})\b/);
  return m ? m[1]! : null;
}
