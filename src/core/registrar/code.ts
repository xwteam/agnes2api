/**
 * 邮件模板里常见的 CSS 十六进制颜色。它们会被 `\b\d{6}\b` 误命中，必须排除——
 * 否则 `background:#ffffff` 里的 ffffff 不会中招（含字母），但 `#123456` 这类会。
 */
const CSS_COLOR_LIKE = /#[0-9a-fA-F]{6}\b/g;

export function extractCode(subject: string, body: string): string | null {
  if (!body) return null;

  // 先抹掉 CSS 十六进制颜色——快路径也要抹，否则 #123456 会被当成验证码。
  const cleanBody = body.replace(CSS_COLOR_LIKE, " ");

  // 优先：带 verification 字样的类名是最可靠的锚点。允许嵌套元素。
  // \b(\d{6})\b 两侧边界缺一不可：懒惰量词会滑进长数字串内部，只有右边界挡不住。
  const tagged = cleanBody.match(/class=["'][^"']*verification[^"']*["'][^>]*>[\s\S]*?\b(\d{6})\b/);
  if (tagged) return tagged[1]!;

  const cleaned = `${subject} ${cleanBody}`;

  // 关键词锚定。同样要两侧边界：[^\d]* 吃不进数字但吃得进字母，abc887766 会误命中。
  const keywordPattern = /(?:验证码|verification[\s-]?code|auth[\s-]?code)[^\d]*\b(\d{6})\b/i;
  const keyword = cleaned.match(keywordPattern);
  if (keyword) return keyword[1]!;

  const m = cleaned.match(/\b(\d{6})\b/);
  return m ? m[1]! : null;
}
