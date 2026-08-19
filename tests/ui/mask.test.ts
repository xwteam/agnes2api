import { describe, it, expect } from "vitest";
import { maskKey } from "../../admin-ui/js/pure/mask.mjs";

/**
 * 掩码是硬规则：`KeyPoolRepo.all()` 返回的记录含完整明文 key，直接吐给面板等于把
 * 整池上游 key 交出去。
 *
 * 这个文件同时是**前端纯函数测试通道本身**的验收——它跑得起来，就证明
 * 「vitest 直接 import .mjs + tsconfig allowJs」这条通道是通的（否则 P3b 起
 * 所有前端纯逻辑都没地方测，而那个失效是静默的）。
 */
describe("maskKey", () => {
  it("保留前 5 位与后 4 位，中间用省略号", () => {
    expect(maskKey("sk-abcdefghijklmnop")).toBe("sk-ab…mnop");
  });

  it("短到不足以掩码时整串隐去——绝不返回原值", () => {
    for (const s of ["", "sk", "sk-abc", "sk-abcdef", "sk-abcdefg"]) {
      expect(maskKey(s), s).toBe("…");
      expect(maskKey(s), `${s} 不许被原样吐出`).not.toBe(s);
    }
  });

  it("阈值是 10：10 位整串隐去，11 位才开始掩码", () => {
    // 边界值写**字面量**，不写 `THRESHOLD ± 1`：后者是同义反复，把阈值改成 2
    // 也照样全绿（本项目第 6 种假阳性，Task 4/5 已实际逃逸过一次）。
    expect(maskKey("0123456789")).toBe("…");
    expect(maskKey("0123456789a")).toBe("01234…789a");
  });

  it("掩码后的串里不含原串中间那一段", () => {
    // 夹具刻意不写成 `sk-` 开头的长串：scan-secrets.sh 的第一条正则会把 CI 打红
    //（已实测撞上过一次）。
    const key = "head1-the-middle-part-tail";
    expect(maskKey(key)).not.toContain("middle");
    expect(maskKey(key)).toBe("head1…tail");
  });

  it("非字符串输入也隐去，不抛错", () => {
    expect(maskKey(null)).toBe("…");
    expect(maskKey(undefined)).toBe("…");
    expect(maskKey(12345678901234)).toBe("…");
    expect(maskKey({ toString: () => "sk-abcdefghijklmnop" })).toBe("…");
  });
});
