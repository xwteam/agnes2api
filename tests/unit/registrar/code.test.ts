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

  it("正文含订单号在前、验证码在后，必须取验证码那个", () => {
    const html = "订单号 887766，您的验证码是 246813，十分钟内有效";
    expect(extractCode("", html)).toBe("246813");
  });

  it("verification 类元素嵌套形态也能匹配，需干扰项区分快路径", () => {
    // 干扰项 887766 在前，只有走快路径才能拿到 123456
    const html = `<p>887766</p><div class="verification"><span>123456</span></div>`;
    expect(extractCode("", html)).toBe("123456");
  });

  it("用 verification code 或 auth code 关键词锚定（移除裸 code 防止误匹配）", () => {
    const html = "order 654321, your verification code: 135790";
    expect(extractCode("", html)).toBe("135790");
  });

  // === 约束 4 回归用例：关键词锚定右边界 ===
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

  it("边界形态：关键词在正文中间，真码在后", () => {
    const html = "订单号 112233，验证码是 445566，有效期 10 分钟";
    expect(extractCode("", html)).toBe("445566");
  });

  it("边界形态：关键词出现多次，只取第一个附近的六位数", () => {
    const html = "验证码 111111，另一个验证码 222222";
    // 第一个关键词附近的 111111，即使后面有 222222 也不取
    expect(extractCode("", html)).toBe("111111");
  });

  it("边界形态：六位数紧贴字母时不误匹配（e.g. 编码、RGB）", () => {
    const html = "色号 #ff0000 (RGB123456)，验证码 789012";
    // RGB123456 中的 123456 是一个单词的一部分（无右边界），真码在后面
    expect(extractCode("", html)).toBe("789012");
  });

  // === 根因 1 回归测试：快路径必须先抹 CSS 颜色 ===
  it("根因 1：快路径中 CSS 颜色被误匹配（#123456 不应被当成验证码）", () => {
    const html = `<div class="verification">#123456 验证码 357911</div>`;
    // 快路径必须先抹掉 #123456，然后找到真码 357911
    expect(extractCode("", html)).toBe("357911");
  });

  // === 根因 2 回归测试：快路径左边界防止滑进长数字串 ===
  it("根因 2：快路径懒惰量词滑进长数字串（2026081512 中不应切割 081512）", () => {
    const html = `<div class="verification">2026081512 验证码 357911</div>`;
    // 快路径的 [\s\S]*? 会贪心滑入数字串内部，必须加左边界 \b 挡住
    // 应该找到真码 357911 而不是从 2026081512 中切割的 081512
    expect(extractCode("", html)).toBe("357911");
  });

  // === 根因 3 回归测试：关键词路径左边界防止字母贴数字误命中 ===
  it("根因 3：关键词路径字母贴数字不应误命中（abc887766 中不应切 887766）", () => {
    const html = "abc887766 验证码 357911";
    // 关键词 «验证码» 前面有 abc887766，[^\d]* 会吃掉 abc 然后从 887766 起匹配
    // 必须加左边界 \b 确保只匹配独立数字
    expect(extractCode("", html)).toBe("357911");
  });
});
