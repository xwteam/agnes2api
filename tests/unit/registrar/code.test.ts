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
});
