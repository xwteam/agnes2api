/**
 * 邮件模板里常见的 CSS 十六进制颜色。它们会被 `\b\d{6}\b` 误命中，必须排除——
 * 否则 `background:#ffffff` 里的 ffffff 不会中招（含字母），但 `#123456` 这类会。
 */
const CSS_COLOR_LIKE = /#[0-9a-fA-F]{6}\b/g;

/**
 * 本文件下面**三条**正则（`TAGGED_CODE`、`KEYWORD_ANCHORED_CODE`、兜底的
 * `\b(\d{6})\b`）里，每一个 `*`/`+` 量词都**必须有上界**，一个都不能漏。
 *
 * 正文长度上限是 1 MiB（见 `MAX_BODY_LEN`），而无界量词后面跟一个通常匹配不上的
 * 尾巴时，正则引擎会在每个起始位置贪婪吃满再逐字符回退，整体退化成 O(n²)。实测
 * （构造性输入，非理论推断）：
 *
 * | 模式 | 64 KiB | 1 MiB |
 * |---|---|---|
 * | `[^"']*verification[^"']*["']` | 820 ms | 约 215 秒 |
 * | `[^>]*>` （载荷需**多个** `class=` 起始位置） | 382 ms | 约 139 秒 |
 * | `[^\d]*\b(\d{6})\b` | 约 85 ms | 约 22 秒 |
 * | 全部限长后 | <5 ms | 约 150 ms |
 *
 * Node 形态下这是同步 CPU，会把整个事件循环（含四个协议的转发）堵死；Worker 形态
 * 会撞 30 秒 CPU 上限被平台中止，`mintOne` 的 finally 不执行，邮箱就漏了。
 *
 * ---
 *
 * **上界取多少，必须逐段按真实数据论证，不能把一个数机械地套到所有段上。**
 * 这个文件已经在同一个坑里栽过两次：第一次漏了 `[^>]*` 没限（O(n²) 残留），
 * 第二次把 `[^"']` 的 200 直接套到 `[^>]` 上（真实模板取到错码）。逐段结论：
 *
 * - `[^"']{0,MAX_GAP}`（200）—— 段内容是 **class 属性值**，真实模板几十字符。
 * - `[^\d]{0,MAX_GAP}`（200）—— 这段**本来就跨不过任何数字**（`padding:10px`
 *   里的 10 就能截断它），实际触及范围只有「关键词到下一段数字之间」。
 * - `[^>]{0,MAX_TAG_GAP}`（400）—— 段内容是**标签剩余的全部属性**，与上面两段
 *   完全不同的长度分布：真实营销模板一个 `style=` 就能到 200+（长 font-family
 *   列表 + 字号 + 颜色 + 字距 + 内边距），实测两个「正常但不极端」的模板已经吃到
 *   175/179 字符。
 * - `\s{0,MAX_WS}`（32）—— 段内容是 `>` 与验证码之间的**排版空白**。真实 Agnes
 *   模板是 `>143770<`（零空白），但格式化过的模板是换行 + 缩进；实测「换行 + 12
 *   空格」这种普通缩进在 `{0,8}` 下就会失配。
 *
 * **超界的后果不是返回 null，而是返回一个看起来合理的错码**：快路径失配后会落到
 * 兜底的「全文第一个六位数」，正文里只要在验证码之前出现过任意一个六位数（订单号 /
 * 工单号 / 活动 ID）就会被当成验证码提交上去——白白烧掉一个补池名额和一个临时邮箱，
 * Agnes 那边还会注册失败。所以这些上界宁可留足余量，代价只是几十毫秒。
 */
const MAX_GAP = 200;

/** 标签剩余属性段的上界，见上面逐段论证。**不要复用 `MAX_GAP`**，两者长度分布不同。 */
const MAX_TAG_GAP = 400;

/** `>` 与验证码之间排版空白的上界，见上面逐段论证。 */
const MAX_WS = 32;

/**
 * 优先：带 verification 字样类名的元素。
 * **数字必须是该元素的直接文本**——这个严格性是判别器，不是缺陷：
 * verification-title 这类容器不含数字时匹配失败，正则引擎会自动前进到
 * 下一个候选容器（verification-code），从而拿到真正的验证码。
 * 放宽成 [\s\S]*? 会让第一个开标签吞掉全文，后面的容器再无机会。
 */
const TAGGED_CODE = new RegExp(
  `class=["'][^"']{0,${MAX_GAP}}verification[^"']{0,${MAX_GAP}}["'][^>]{0,${MAX_TAG_GAP}}>\\s{0,${MAX_WS}}(\\d{6})\\s{0,${MAX_WS}}<`,
);

/**
 * 关键词锚定：优先取「验证码 / verification code / auth code」附近的六位数，
 * 避免订单号之类排在前面的数字被误取。
 * 两侧 \b 缺一不可：`[^\d]` 吃不进数字但吃得进字母（abc887766 会误命中），
 * 右边界防止从时间戳/工单号这类长数字串里切出前六位。
 */
const KEYWORD_ANCHORED_CODE = new RegExp(
  `(?:验证码|verification[\\s-]?code|auth[\\s-]?code)[^\\d]{0,${MAX_GAP}}\\b(\\d{6})\\b`,
  "i",
);

/**
 * 输入长度上限。
 *
 * 这里的正文来自**临时邮箱**——那个地址一旦生成，任何人都能往它投递，正文长度
 * 完全不受我们控制。下面全是对整份正文的正则扫描，把一封几 MB 的邮件喂进来只会
 * 平白吃掉 CPU（Worker 的 CPU 时间是有上限的）。
 *
 * 上限取 1 MiB 而不是更小：Agnes 的验证码邮件走 HTML 模板，一旦内嵌 base64 logo
 *（`data:image/png;base64,…` 动辄 100 KB+）且图片排在验证码元素之前，几十 KiB 的
 * 上限会被图片整个吃掉——extractCode 恒返回 null、pollCode 一路空转到超时、注册机
 * 100% 静默失效，而单测里的正文都是短字符串，全绿。
 *
 * 提高上限的**前提**是上面 `MAX_GAP` 那一段：只有当所有量词都有上界、扫描确实是
 * 线性的时候，1 MiB 才只是毫秒级。别在没读那段注释的情况下往回调这个值，也别在
 * 这个文件里新增无界量词。
 */
const MAX_BODY_LEN = 1024 * 1024;
const MAX_SUBJECT_LEN = 1024;

/**
 * 截断到 `max` 个字符供正则扫描。
 *
 * 截断点若落在一串数字中间，会凭空造出一个左右都带 `\b` 的六位数——例如尾部是
 * 「订单号 1234567890」，切在第 6 位后变成「订单号 123456<EOF>」，末尾就是词边界，
 * `\b(\d{6})\b` 直接命中并返回一个错误的验证码。所以只要真的发生了截断，就把结尾
 * 那段数字整个丢掉（换成空格，免得把前后文粘到一起）：它本来就是残缺的，不可能是
 * 完整的码。注意补一个字符**不足以**消掉这个伪边界——空格前面照样是词边界，必须
 * 把残缺的数字本身去掉。
 */
function boundedForScan(s: string, max: number): string {
  if (s.length <= max) return s;
  // 刻意**不用** `/\d+$/` 这样的正则：保留的前缀里若有长数字串而结尾不是数字，
  // 正则引擎会在每个起始位置把数字串贪婪吃完再逐字符回退，退化成 O(n²)——实测
  // 128 KiB 就要 35 秒，1 MiB 外推到几十分钟，比它想防的那个问题严重得多。
  // 这里从截断点往回走一次即可，线性，1 MiB 全数字的最坏输入实测约 5 ms。
  let end = max;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c < 48 || c > 57) break; // 非 0-9
    end--;
  }
  return `${s.slice(0, end)} `;
}

/**
 * 把邮件正文字段规整成一个字符串。
 *
 * 真机实测：YYDS 详情响应里的 `html` 是**数组**（元素数 1），`text` 是字符串。
 * 此前代码写的是模板插值 `` `${detail.text} ${detail.html}` ``——对单元素数组碰巧
 * 等价于该元素，所以一直能工作；但多段 HTML 时 `Array.prototype.toString` 会用
 * **逗号**拼接，形态不可控（逗号会直接贴到数字上，影响 `\b` 边界判定）。
 * 这里显式处理数组形态，用换行拼接。
 *
 * 两家适配器共用：MoeMail 上游 `html`/`content` 在库里是 text 列（字符串），这条
 * 对它是防御性的，但保持两边同一条解析路径比各写各的更不容易漂移。
 */
export function normalizeBody(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : String(x ?? ""))).join("\n");
  if (typeof v === "string") return v;
  return v == null ? "" : String(v);
}

export function extractCode(subject: string, body: string): string | null {
  if (!body) return null;

  const boundedSubject = boundedForScan(subject, MAX_SUBJECT_LEN);

  // 先抹掉 CSS 十六进制颜色，避免 #123456 被当成验证码。
  const cleanBody = boundedForScan(body, MAX_BODY_LEN).replace(CSS_COLOR_LIKE, " ");

  // 优先：带 verification 字样类名的元素（理由见 TAGGED_CODE 处的注释）。
  const tagged = cleanBody.match(TAGGED_CODE);
  if (tagged) return tagged[1]!;

  const cleaned = `${boundedSubject} ${cleanBody}`;

  // 其次：关键词锚定（理由见 KEYWORD_ANCHORED_CODE 处的注释）。
  const keyword = cleaned.match(KEYWORD_ANCHORED_CODE);
  if (keyword) return keyword[1]!;

  // 兜底：全文第一个六位数。`\b\d{6}\b` 是定长量词，线性扫描，1 MiB 实测约 4 ms。
  const m = cleaned.match(/\b(\d{6})\b/);
  return m ? m[1]! : null;
}
