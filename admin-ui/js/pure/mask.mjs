/**
 * 上游 key 的掩码。
 *
 * `KeyPoolRepo.all()` 返回的记录含完整明文 key，直接吐给面板等于把整池上游 key
 * 交出去，所以掩码是硬规则，不是显示偏好。
 *
 * **这个目录（js/pure）下的文件受三条硬规则约束**，由 scripts/build-ui.mjs 与
 * tests/unit/ui-assets.test.ts 各守一道，规则全文见 admin-ui/README.md。
 * 其中一条禁止触碰浏览器全局，而校验是**纯文本匹配、不解析注释**——所以那几个
 * 全局的名字连注释里都不许写出来，本文件因此只在 README 里展开说明。
 */
export function maskKey(key) {
  // 阈值 10：再短就不值得掩码了（前 5 + 后 4 会把几乎整串露出来），一律整串隐去。
  // **绝不返回原值**：返回原值的「掩码」比没有掩码更糟，调用方会以为它安全了。
  if (typeof key !== "string" || key.length <= 10) return "…";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
