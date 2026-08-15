/**
 * 邮件模板里常见的 CSS 十六进制颜色。它们会被 `\b\d{6}\b` 误命中，必须排除——
 * 否则 `background:#ffffff` 里的 ffffff 不会中招（含字母），但 `#123456` 这类会。
 */
const CSS_COLOR_LIKE = /#[0-9a-fA-F]{6}\b/g;

/**
 * 输入长度上限。
 *
 * 这里的正文来自**临时邮箱**——那个地址一旦生成，任何人都能往它投递，正文长度
 * 完全不受我们控制。下面全是对整份正文的正则扫描，把一封几 MB 的邮件喂进来只会
 * 平白吃掉 CPU（Worker 的 CPU 时间是有上限的），而 Agnes 的验证码邮件远小于这个
 * 量级，截断不影响识别。64 KiB 正文 / 1 KiB 主题即便对富文本邮件也很宽裕。
 */
const MAX_BODY_LEN = 64 * 1024;
const MAX_SUBJECT_LEN = 1024;

export function extractCode(subject: string, body: string): string | null {
  if (!body) return null;

  const boundedSubject = subject.slice(0, MAX_SUBJECT_LEN);

  // 先抹掉 CSS 十六进制颜色，避免 #123456 被当成验证码。
  const cleanBody = body.slice(0, MAX_BODY_LEN).replace(CSS_COLOR_LIKE, " ");

  // 优先：带 verification 字样类名的元素。
  // **数字必须是该元素的直接文本**——这个严格性是判别器，不是缺陷：
  // verification-title 这类容器不含数字时匹配失败，正则引擎会自动前进到
  // 下一个候选容器（verification-code），从而拿到真正的验证码。
  // 放宽成 [\s\S]*? 会让第一个开标签吞掉全文，后面的容器再无机会。
  const tagged = cleanBody.match(/class=["'][^"']*verification[^"']*["'][^>]*>\s*(\d{6})\s*</);
  if (tagged) return tagged[1]!;

  const cleaned = `${boundedSubject} ${cleanBody}`;

  // 关键词锚定：优先取「验证码 / verification code / auth code」附近的六位数，
  // 避免订单号之类排在前面的数字被误取。
  // 两侧 \b 缺一不可：[^\d]* 吃不进数字但吃得进字母（abc887766 会误命中），
  // 右边界防止从时间戳/工单号这类长数字串里切出前六位。
  const keywordPattern = /(?:验证码|verification[\s-]?code|auth[\s-]?code)[^\d]*\b(\d{6})\b/i;
  const keyword = cleaned.match(keywordPattern);
  if (keyword) return keyword[1]!;

  const m = cleaned.match(/\b(\d{6})\b/);
  return m ? m[1]! : null;
}
