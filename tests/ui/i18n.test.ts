import { describe, it, expect } from "vitest";
import { I18N } from "../../admin-ui/js/i18n-dict.js";

/**
 * ⚠️ **这里刻意不 import admin-ui/js/i18n.js**：它在模块顶层碰浏览器全局，
 * 在 node 环境里 import 就会炸。设计文档 §13.1 已裁决「不引 jsdom / happy-dom /
 * playwright 进 CI」，DOM 那半由人工冒烟清单覆盖。
 *
 * 那么 `t()` 的取值与插值逻辑靠什么守？**靠在这里重跑同一套规则的最小复刻**是错的
 *（复刻件永远验证不了原件）。正确做法是：把 `t()` 里**不碰 DOM 的那部分**判据
 * 写成断言——即「字典的形状足以让 t() 正确工作」，DOM 那半交给冒烟。
 * 下面每条都只断言字典本身的性质。
 */
describe("字典的形状足以让 t() 正确工作", () => {
  it("每个键的五种语言都是字符串（t() 不会拿到 undefined 去 split）", () => {
    for (const [k, row] of Object.entries(I18N)) {
      for (const v of Object.values(row as Record<string, unknown>)) {
        expect(typeof v, k).toBe("string");
      }
    }
  });
  it("含插值的键，占位符形如 {name}，不含嵌套或未闭合的花括号", () => {
    for (const [k, row] of Object.entries(I18N)) {
      for (const s of Object.values(row as Record<string, string>)) {
        const opens = (s.match(/\{/g) ?? []).length;
        const closes = (s.match(/\}/g) ?? []).length;
        expect(opens, `${k}: 花括号不配平`).toBe(closes);
        for (const m of s.matchAll(/\{([^}]*)\}/g)) {
          expect(m[1], `${k}: 占位符名必须是 \\w+`).toMatch(/^\w+$/);
        }
      }
    }
  });
});
