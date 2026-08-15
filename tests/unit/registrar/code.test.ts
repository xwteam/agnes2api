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

  // === M6：输入长度上限 ===
  // 正文来自临时邮箱——那个地址一旦生成任何人都能投递，长度不受我们控制。

  it("超长正文只扫描前 1 MiB：上限内的验证码照常取到", () => {
    const body = `验证码 246810 ${"x ".repeat(1024 * 1024)}`;
    expect(extractCode("", body)).toBe("246810");
  });

  it("超长正文里位于 1 MiB 之外的内容不参与匹配（确实截断了，而不是碰巧能跑）", () => {
    const body = `${"x".repeat(1024 * 1024)}验证码 246810`;
    expect(extractCode("", body)).toBeNull();
  });

  // === D3：上限从 64 KiB 提到 1 MiB，并处理「截断点落在数字串中间」 ===

  it("D3 验证码排在一段 >64 KiB 的内嵌大图之后时仍能取到（旧的 64 KiB 上限会漏码）", () => {
    // Agnes 的验证码邮件是 HTML 模板，内嵌 base64 logo 动辄 100 KB+。图片排在验证码
    // 元素之前时，64 KiB 的上限会被图片整个吃光 → 恒返回 null → 注册机 100% 静默失效。
    const bigImage = `<img src="data:image/png;base64,${"A".repeat(100 * 1024)}">`;
    const body = `${bigImage}<p class="verification-code">246810</p>`;
    expect(extractCode("Your Agnes Platform Verification Code", body)).toBe("246810");
  });

  it("D3 长数字串跨越上限边界时返回 null，而不是切出来的前六位", () => {
    // 截断点落在长数字串中间会凭空造出一个左右都带 \b 的六位数：
    // 「订单号 1234567890」切在第 6 位后成了「订单号 123456<EOF>」，末尾即词边界。
    // 注意：在截断处补一个空格**不能**消掉这个伪边界，必须把残缺的数字整段丢掉。
    // 数字前面必须留一个非词字符（这里是空格），否则 `x123456` 左侧压根没有 \b，
    // 裸 slice 也返回 null——那样这条用例就成了「谁赢都通过」的假阳性。
    const body = `${"x".repeat(1024 * 1024 - 7)} 1234567890`;
    expect(extractCode("", body)).toBeNull();
  });

  // === D3 的另一半：上限提到 1 MiB 的前提是扫描真的是线性的 ===
  //
  // MAX_BODY_LEN 这个常量存在的**唯一目的**就是给 CPU 封顶（Worker CPU 上限 30 秒，
  // Node 侧则是同步阻塞整个事件循环、连四个协议的转发一起堵死）。把它从 64 KiB 提到
  // 1 MiB 的同时，必须保证每条正则的量词都有上界，否则等于把防护改成了放大器。
  //
  // 下面三条 payload 各自打在一个具体的退化模式上，都是实测出来的，不是理论推断：
  //   ① 全数字后接非数字   → 旧的 `/\d+$/` 截断：128 KiB 实测 35 秒，1 MiB 几十分钟
  //   ② 重复 verification  → 无界 `[^"']*…[^"']*["']`：64 KiB 820 ms，1 MiB 约 215 秒
  //   ③ 重复关键词         → 无界 `[^\d]*\b(\d{6})\b`：1 MiB 约 22 秒
  // 阈值取 2 秒：修好后三条都在几百毫秒内，退化版则是几十秒到几十分钟，两者差着
  // 一到三个数量级，不会因为 CI 机器快慢而抖动。
  // payload 的**规模是刻意调过的**：退化实现要慢到能被 400 ms 的阈值抓住，又不能慢到
  // 把测试进程挂死。这不是保守，是必需——退化路径是**同步** CPU，vitest 自己基于
  // 定时器的用例超时根本排不上号（实测：全量 1 MiB 的 ① payload 让退化版跑了 2 分钟
  // 还没返回，CI 上表现为整体卡死而不是一条红色断言）。下面三条实测：
  //   ① 退化 2068 ms / 修复后 0.0 ms      ② 退化 2689 ms / 修复后 1.6 ms
  //   ③ 退化 1246 ms / 修复后 21 ms
  it.each([
    // ① 数字段只放 32 KiB、后面用非数字填过 MAX_BODY_LEN：既保证真的发生截断、
    // 保留的前缀又**不以数字结尾**（以数字结尾时 `/\d+$/` 第一次尝试就命中，走的是
    // 最快路径，根本触发不到回溯——第一版 payload 正是这样，变异测试当场证伪）。
    ["① 长数字串 + 截断点落在非数字上", `${"9".repeat(32 * 1024)}${"x".repeat(1024 * 1024)}`],
    // ② class 属性引号不闭合，逼 `[^"']*…[^"']*["']` 每个起始位置都扫到串尾。
    ["② 未闭合引号里重复 verification", `class="${"verification".repeat(10_000)}`],
    // ②b **多个** `class=` 起始位置且全文无 `>`，逼 `[^>]*` 每个起始位置都扫到串尾。
    // 这条是 ② 抓不到的：② 只有一个 `class=`，`[^>]*` 的外层循环只跑一次（实测
    // 11 ms 轻松通过），所以第一版限长漏掉 `[^>]*` 时全绿。构造对抗载荷要照着
    // 「这条正则的外层循环是什么」来，不能只把串拉长。
    ["②b 多个 class= 起始位置且全文无 >", 'class="verification"'.repeat(13_000)],
    // ③ 关键词密集且全文无数字，逼 `[^\d]*\b(\d{6})\b` 每个起始位置都扫到串尾。
    ["③ 密集关键词且全文无数字", "验证码".repeat(15_000)],
  ])("D3 对抗性正文 %s 必须在 400 ms 内返回（量词无上界会退化成 O(n²)）", (_name, body) => {
    const started = Date.now();
    extractCode("Your Agnes Platform Verification Code", body);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("D3 上限内的数字串不受影响（成对用例，防止把正常的码也一起丢掉）", () => {
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
