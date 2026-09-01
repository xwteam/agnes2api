import { describe, it, expect } from "vitest";
import { extractCode } from "../../../src/core/registrar/code.js";

describe("extractCode", () => {
  it("优先取带 verification 类名的元素里的六位数", () => {
    const html = `<div class="code verification-code">123456</div><p>987654</p>`;
    expect(extractCode("", html)).toBe("123456");
  });

  it("没有类名标记时取正文里第一个独立六位数", () => {
    expect(extractCode("Agnes 验证码", "您的验证码是 246813，十分钟内有效")).toBe("246813");
  });

  it("跳过 CSS 十六进制颜色值", () => {
    // 邮件模板里 #ffffff / #000000 这类会被 \b\d{6}\b 误命中
    const html = `<body style="background:#ffffff;color:#000000">您的验证码 135790</body>`;
    expect(extractCode("", html)).toBe("135790");
  });

  it("正文为空时返回 null", () => {
    expect(extractCode("subject", "")).toBeNull();
  });

  it("没有六位数时返回 null", () => {
    expect(extractCode("hi", "no digits here 12345")).toBeNull();
  });

  // === 快路径：优先级 + 严格形态 ===

  it("快路径优先于兜底：干扰项在前也要取 verification 容器里的码", () => {
    // 兜底会取到前面的 887766，只有快路径先命中才能拿到 123456。
    const html = `<p>887766</p><div class="verification">123456</div>`;
    expect(extractCode("", html)).toBe("123456");
  });

  it("多容器：verification-title 不含数字时要前进到 verification-code", () => {
    // 快路径要求数字是元素的**直接文本**，这个严格性是判别器：title 匹配失败后
    // 正则引擎自动前进到下一个候选容器。放宽成 [\s\S]*? 会让 title 的开标签
    // 吞掉全文，直接返回错误的 246813。
    const html = `<td class="verification-title">邮箱验证</td><td>246813</td><td class="verification-code">357911</td>`;
    expect(extractCode("", html)).toBe("357911");
  });

  it("多容器：verification-wrapper 包着整张表也要落到 verification-code", () => {
    const html = `<table class="verification-wrapper"><tr><td>246813</td></tr><tr><td class="verification-code">357911</td></tr></table>`;
    expect(extractCode("", html)).toBe("357911");
  });

  it("CSS 颜色要在兜底路径生效：#123456 不能被当成验证码", () => {
    // 这条不含关键词，必须走兜底，才真正守得住 CSS_COLOR_LIKE。
    const html = `<body style="border-color:#123456">Agnes 135790</body>`;
    expect(extractCode("", html)).toBe("135790");
  });

  // === 关键词锚定 ===

  it("正文含订单号在前、验证码在后，必须取验证码那个", () => {
    const html = "订单号 887766，您的验证码是 246813，十分钟内有效";
    expect(extractCode("", html)).toBe("246813");
  });

  it("用 verification code 或 auth code 关键词锚定（移除裸 code 防止误匹配）", () => {
    const html = "order 654321, your verification code: 135790";
    expect(extractCode("", html)).toBe("135790");
  });

  it("边界形态：关键词后紧跟时间戳 10 位数字，只取 6 位不误切", () => {
    const html = "验证码有效期至 2026081512:00，为 246813";
    // 关键词 «验证码» 后面是 «有效期至» 然后是 10 位数 2026081512
    // 不能从 2026081512 中切割前 6 位 202608，要继续找到真码 246813
    expect(extractCode("", html)).toBe("246813");
  });

  it("边界形态：关键词后紧跟工单号 8 位数字，不误切成 6 位", () => {
    const html = "验证码工单 20260815001 对应 135790";
    // 关键词后 8 位工单号 20260815，不能从中切割，要找到真码 135790
    expect(extractCode("", html)).toBe("135790");
  });

  it("边界形态：关键词后字母贴数字不应误命中（abc887766 中不应切 887766）", () => {
    const html = "验证码abc887766 要显示 357911";
    // [^\d]* 吃不进数字但吃得进字母，会吃掉 abc 后从 887766 起匹配。
    // 干扰项必须放在关键词**之后**，左边界 \b 才真正被考验。
    expect(extractCode("", html)).toBe("357911");
  });

  it("边界形态：关键词在正文中间，真码在后", () => {
    const html = "订单号 112233，验证码是 445566，有效期 10 分钟";
    expect(extractCode("", html)).toBe("445566");
  });

  it("边界形态：关键词出现多次，只取第一个附近的六位数", () => {
    const html = "验证码 111111，另一个验证码 222222";
    expect(extractCode("", html)).toBe("111111");
  });

  it("边界形态：六位数紧贴字母时不误匹配（e.g. 编码、RGB）", () => {
    const html = "色号 #ff0000 (RGB123456)，验证码 789012";
    // RGB123456 中的 123456 是一个单词的一部分（无左边界），真码在后面
    expect(extractCode("", html)).toBe("789012");
  });

  // === 输入长度上限 ===
  // 正文来自临时邮箱——那个地址一旦生成任何人都能投递，长度不受我们控制。

  it("超长正文只扫描前 1 MiB：上限内的验证码照常取到", () => {
    const body = `验证码 246810 ${"x ".repeat(1024 * 1024)}`;
    expect(extractCode("", body)).toBe("246810");
  });

  it("超长正文里位于 1 MiB 之外的内容不参与匹配（确实截断了，而不是碰巧能跑）", () => {
    const body = `${"x".repeat(1024 * 1024)}验证码 246810`;
    expect(extractCode("", body)).toBeNull();
  });

  // === 上限从 64 KiB 提到 1 MiB，并处理「截断点落在数字串中间」 ===

  it("验证码排在一段 >64 KiB 的内嵌大图之后时仍能取到（旧的 64 KiB 上限会漏码）", () => {
    // Agnes 的验证码邮件是 HTML 模板，内嵌 base64 logo 动辄 100 KB+。图片排在验证码
    // 元素之前时，64 KiB 的上限会被图片整个吃光 → 恒返回 null → 注册机 100% 静默失效。
    const bigImage = `<img src="data:image/png;base64,${"A".repeat(100 * 1024)}">`;
    const body = `${bigImage}<p class="verification-code">246810</p>`;
    expect(extractCode("Your Agnes Platform Verification Code", body)).toBe("246810");
  });

  it("长数字串跨越上限边界时返回 null，而不是切出来的前六位", () => {
    // 截断点落在长数字串中间会凭空造出一个左右都带 \b 的六位数：
    // 「订单号 1234567890」切在第 6 位后成了「订单号 123456<EOF>」，末尾即词边界。
    // 注意：在截断处补一个空格**不能**消掉这个伪边界，必须把残缺的数字整段丢掉。
    // 数字前面必须留一个非词字符（这里是空格），否则 `x123456` 左侧压根没有 \b，
    // 裸 slice 也返回 null——那样这条用例就成了「谁赢都通过」的假阳性。
    const body = `${"x".repeat(1024 * 1024 - 7)} 1234567890`;
    expect(extractCode("", body)).toBeNull();
  });

  // === 同一条裁定的另一半：上限提到 1 MiB 的前提是扫描真的是线性的 ===
  //
  // MAX_BODY_LEN 这个常量存在的**唯一目的**就是给 CPU 封顶（Worker CPU 上限 30 秒，
  // Node 侧则是同步阻塞整个事件循环、连四个协议的转发一起堵死）。把它从 64 KiB 提到
  // 1 MiB 的同时，必须保证每条正则的量词都有上界，否则等于把防护改成了放大器。
  //
  // 下面每条 payload 各自打在一个具体的退化模式上，都是实测出来的，不是理论推断：
  //   ① 全数字后接非数字   → 旧的 `/\d+$/` 截断：128 KiB 实测 35 秒，1 MiB 几十分钟
  //   ② 重复 verification  → 无界 `[^"']*…[^"']*["']`：64 KiB 820 ms，1 MiB 约 215 秒
  //   ②b 多个 class= 无 `>` → 无界 `[^>]*>`：1 MiB 约 139 秒
  //   ③ 重复关键词         → 无界 `[^\d]*\b(\d{6})\b`：1 MiB 约 22 秒
  //
  // **阈值 1000 ms —— 代码里、用例标题里、这段注释里必须是同一个数。** 这条纪律是赔出来
  // 的：旧版代码写 400 ms、而这段注释写的是「2 秒」「不会因为 CI 机器快慢而抖动」，然后它
  // 在本机满载那一轮真红了一次（`expected 400 to be less than 400`）。一条会随机红、又对不
  // 上自己注释的断言，第一次被人当成噪声之后就再也不传递信息了。
  //
  // ⚠️⚠️ **这里刻意不再抄任何一次墙钟观测值（回填时删掉的）。**
  // 上一版把本机（1 核 ARM）上的一次性观测抄进来二十多个——空载一组、抢占一组、退化一组，
  // **一个都没有机器守着**，而复评当场证伪了其中两句（见下面两条 ⚠️）。本仓的纪律逐字是
  // 「能删数字就删数字」，而这一族数字换一台机器就全错。**要知道今天这台机器上是多少，
  // 就自己量**，两条测法各自独立、跑完就撤，别把量出来的数抄回这里：
  //   · 噪声侧：把下面那个 `1000` 临时改成 `1`，单跑本文件 ⇒ 四格的报文里就是真耗时。
  //     想复现 CI 上的抢占，另开 `nproc` 个 `yes > /dev/null` 再跑一遍。
  //   · 退化侧（= 变红条件）：把 `MAX_GAP` / `MAX_TAG_GAP` 任一处的 `{0,N}` 改回 `*`，
  //     单跑本文件 ⇒ 对应那一格当场红，报文里直接带着这台机器上量到的毫秒数。
  //
  // ⚠️ **上一版在这里写「退化侧与阈值差一个数量级」——那句话对四格里的三格是假的**
  //（复评两轮实测：只有一格够得上 10×，最慢那条只有 5× 出头），而且它与同一段注释里
  // 自己写的「重新拉开到 5～10 倍」互相打架。⇒ 现在只留下**会自己红的那半**：
  // **撤掉任意一处上界，有且只有对应的那一格当场红**（四条退化路径互不遮蔽，复评逐条撤过）。
  //
  // payload 的**规模是刻意调过的**：阈值从 400 抬到 1000 的那一刻，原来那组规模下退化侧
  // 最快的一条（③）离阈值只剩一点点余量，**换一台快一档的机器它就会静静地变绿**
  // ——只抬阈值不同步放大 payload，等于把断言改绿而不是修问题。所以 ①（数字段 32→64 KiB）、
  // ②（10_000→20_000）、③（15_000→30_000）一起放大了一档。
  //
  // ⚠️⚠️ **上一版还写着「只许往大调」，理由是「修复侧几乎没动（受量词上界封顶，
  // 不随 payload 线性涨）」——那条理由被 A/B 实测证伪，阶段 D 回填订正**：
  // 修复侧是 O(n × 上界)，上界封顶的是**每个起始位置**的工作量、不是总量，**总量仍随
  // payload 线性涨**。实测把 ③ 的 payload 再翻一倍，修复侧耗时就精确翻一倍（空载、
  // 抢占两种条件下各量过一轮，两轮都翻倍）。只有 ① 真的不涨——它走的是兜底定长扫描，
  // 耗时由 1 MiB 截断长度决定、与数字段长度无关。**上一版把 ① 这一格的性质当成了四格的通性，
  // 于是「只许往大调」读起来像是一条没有代价的授权书。**
  // ⇒ **代价是真的**：这一次放大之后，③ 的噪声余量已经从几十倍掉到个位数倍。
  // 真要再往大调，**必须连噪声侧一起重量**（测法见上）；量完发现余量不到 5 倍就别调了
  // ——那时该补的是遗留里那条**静态**判据（断言正则里没有作用在字符类上的无界 `*`/`+`），
  // 它同时解决「随机器速度浮动」与「运行时无关」两件事，而不是继续跟墙钟赛跑。
  //
  // 反过来也不能无限放大：退化路径是**同步** CPU，vitest 自己基于定时器的用例超时根本
  // 排不上号（实测：把 ① 的数字段放到全量 1 MiB 再撤上界，退化版跑了两分多钟还没返回，
  // CI 上表现为整体卡死而不是一条红色断言）。
  it.each([
    // ① 数字段只放 64 KiB、后面用非数字填过 MAX_BODY_LEN：既保证真的发生截断、
    // 保留的前缀又**不以数字结尾**（以数字结尾时 `/\d+$/` 第一次尝试就命中，走的是
    // 最快路径，根本触发不到回溯——第一版 payload 正是这样，变异测试当场证伪）。
    ["① 长数字串 + 截断点落在非数字上", `${"9".repeat(64 * 1024)}${"x".repeat(1024 * 1024)}`],
    // ② class 属性引号不闭合，逼 `[^"']*…[^"']*["']` 每个起始位置都扫到串尾。
    ["② 未闭合引号里重复 verification", `class="${"verification".repeat(20_000)}`],
    // ②b **多个** `class=` 起始位置且全文无 `>`，逼 `[^>]*` 每个起始位置都扫到串尾。
    // 这条是 ② 抓不到的：② 只有一个 `class=`，`[^>]*` 的外层循环只跑一次，所以第一版
    // 限长漏掉 `[^>]*` 时全绿。构造对抗载荷要照着「这条正则的外层循环是什么」来，不能
    // 只把串拉长。**这条断言配着一条反向控制**：只把 `[^>]{0,MAX_TAG_GAP}` 一处改回
    // `[^>]*`（其余上界不动）单跑本文件 ⇒ **只有 ②b 一格红，另外三格纹丝不动**
    //（复评把四条上界逐条单撤过一遍，四次都是「只红对应的那一格」）。
    // ⚠️ 这里同样不抄毫秒数：那一族数字换台机器就全错，测法在上面那段里。
    ["②b 多个 class= 起始位置且全文无 >", 'class="verification"'.repeat(13_000)],
    // ③ 关键词密集且全文无数字，逼 `[^\d]*\b(\d{6})\b` 每个起始位置都扫到串尾。
    ["③ 密集关键词且全文无数字", "验证码".repeat(30_000)],
  ])("对抗性正文 %s 必须在 1000 ms 内返回（量词无上界会退化成 O(n²)）", (_name, body) => {
    const started = Date.now();
    extractCode("Your Agnes Platform Verification Code", body);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // === 快路径的上界必须够真实模板用，超界的后果是**错码**不是 null ===
  //
  // 快路径失配后会落到兜底的「全文第一个六位数」，所以下面每条载荷都在验证码**之前**
  // 放了一个干扰六位数（订单号 998877）。没有这个干扰项的话，超界与不超界都会返回
  // 143770（前者靠兜底、后者靠快路径），就是一条「谁赢都通过」的假阳性。

  it("长内联 style 的验证码元素（属性段 >200 <400）取到真码而不是前面的订单号", () => {
    // 很普通的营销模板形态：一个 style 里放长 font-family 列表 + 字号 + 颜色 +
    // 字距 + 内边距，属性段轻松超过 200。实测把上界从 400 收回 200 时，这条返回的
    // 是 998877——不是 null，是一个看起来完全合理的错码，会被当验证码提交上去。
    const body = '<p>Order 998877</p>'
      + '<div class="verification-code" style="font-family:-apple-system,BlinkMacSystemFont,'
      + "'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Hiragino Sans GB',sans-serif;"
      + 'font-size:32px;line-height:1.4;color:#333333;letter-spacing:4px;padding:16px 0;'
      + 'text-align:center">143770</div>';
    const attrs = body.indexOf(">", body.indexOf("verification-code"))
      - (body.indexOf('"', body.indexOf("class=") + 7) + 1);
    // 夹在两个上界之间，这条才同时守住「200 不够」和「不必放到 800」。
    expect(attrs).toBeGreaterThan(200);
    expect(attrs).toBeLessThan(400);
    expect(extractCode("Your Agnes Platform Verification Code", body)).toBe("143770");
  });

  it("格式化过的模板（换行 + 缩进空白）也取到真码而不是前面的订单号", () => {
    // `>` 与验证码之间的排版空白：真实 Agnes 模板是 `>143770<`（零空白），但格式化
    // 过的模板是换行 + 缩进。实测「换行 + 12 空格」在 `\\s{0,8}` 下就会失配并返回
    // 998877——这正是「别不加论证就随手定一个小上界」的第二个例子。
    const body = '<p>Order 998877</p>\n'
      + '        <div class="verification-code">\n'
      + '            143770\n'
      + '        </div>';
    expect(extractCode("Your Agnes Platform Verification Code", body)).toBe("143770");
  });

  it("上限内的数字串不受影响（成对用例，防止把正常的码也一起丢掉）", () => {
    // 与上一条对照：同样以数字收尾，但没发生截断，就必须照常取到。
    const body = `${"x".repeat(100)}验证码 654321`;
    expect(extractCode("", body)).toBe("654321");
  });

  it("超长主题同样被截断（主题也来自外部输入）", () => {
    // 主题前 1 KiB 全是无关内容，真码在 1 KiB 之外；正文里没有六位数。
    const subject = `${"y".repeat(1024)}验证码 135791`;
    expect(extractCode(subject, "正文没有码")).toBeNull();
    // 对照：主题在上限内时照常能取到。
    expect(extractCode("验证码 135791", "正文没有码")).toBe("135791");
  });
});
