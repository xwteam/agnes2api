/**
 * 邮件模板里常见的 CSS 十六进制颜色。它们会被 `\b\d{6}\b` 误命中，必须排除——
 * 否则 `background:#ffffff` 里的 ffffff 不会中招（含字母），但 `#123456` 这类会。
 */
const CSS_COLOR_LIKE = /#[0-9a-fA-F]{6}\b/g;

export function extractCode(subject: string, body: string): string | null {
  if (!body) return null;

  // 优先：模板通常给验证码套一个带 verification 字样的类名，这是最可靠的锚点。
  // 放宽到允许嵌套元素（数字不必是直接子节点），同时右边界防止误切。
  const tagged = body.match(/class=["'][^"']*verification[^"']*["'][^>]*>[\s\S]*?(\d{6})\b/);
  if (tagged) return tagged[1]!;

  // 兜底：先把十六进制颜色抹掉，再找第一个独立的六位数。
  const cleaned = `${subject} ${body}`.replace(CSS_COLOR_LIKE, " ");

  // 先尝试在关键词附近找：优先找「验证码 / verification code / auth code」字样附近的六位数。
  // 允许关键词和数字之间有任意非数字字符（包括汉字、标点、空格）。
  // 右边界 \b 防止从长数字串（如时间戳、工单号）中切割部分数字。
  const keywordPattern = /(?:验证码|verification[\s-]?code|auth[\s-]?code)[^\d]*(\d{6})\b/i;
  const keyword = cleaned.match(keywordPattern);
  if (keyword) return keyword[1]!;

  // 没有关键词锚点时，退回到取第一个独立的六位数。
  const m = cleaned.match(/\b(\d{6})\b/);
  return m ? m[1]! : null;
}
