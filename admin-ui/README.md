# admin-ui

人手编辑的面板源码。**零构建**：用浏览器直接打开 `index.html` 就是完整可调试的面板。

`scripts/build-ui.mjs` 只是把这些文件**逐字节**烧进 `src/ui/assets.generated.ts`，
不转译、不打包、不压缩。它是投递方式，不是构建管线——这是本项目守住
「不引入需要构建步骤的前端框架」这条硬约束的全部依据，并由
`tests/unit/ui-assets.test.ts` 的逐字节断言钉死。

改完这里之后**必须**跑一次 `pnpm ui:build`。忘了不会有任何提示，但
`tests/unit/ui-assets.test.ts` 会把 `pnpm test` 打红（它重跑一遍生成器再整文件比对），
CI 的漂移门禁同样会红。

## 三条硬规则（违反即 `pnpm ui:build` 退出 1）

1. **`js/pure/*.mjs`**：顶层只允许 `export function` / `export const`，禁止 `import`，
   禁止出现 `document` / `window`。**所有需要测试的逻辑必须放这里**，板块文件里
   只允许有 DOM 拼装与网络调用。
   ⚠️ 校验是**纯文本匹配、不解析注释**，所以 `document` / `window` 这两个词连注释里
   都不能写——要说明这条规则请链接到本文件，别在 `js/pure/` 里复述。
2. **零二进制资源**（图标一律内联 SVG）；**零内联脚本**（CSP 的 `script-src 'self'`）。
3. 文案与占位符里不许出现「数字IP:端口」形态，会被 `scripts/scan-secrets.sh` 打红。
   一律写 `localhost:8080` 或 `https://your-gateway.example.com`。

## 其他约定

- `js/boot.js` 是全站唯一的经典脚本（`<head>` 里同步、无 `defer`、非 module），
  理由写在文件头。其余脚本一律 `type="module"`。
- 口令只走 `localStorage` + `x-admin-key` 请求头。**禁止 Cookie 会话、禁止 `?key=`**
  （见设计文档 §8.3）。
- 一切来自接口的内容一律 `textContent`，不用 `innerHTML`。
- 所有颜色引用 CSS 变量，零硬编码色值。主色是 indigo：同一个运维会同时开着
  kiro2api（emerald）和本面板，颜色是最快最可靠的区分信号。

## P3a 的范围

只有登录闸和一个空壳。`i18n` 字典、`theme.js` / `ui.js` / `api.js` 与 8 个功能板块
都在 P3b 起。`index.html` 里的文案先写 zh-CN 并挂上 `data-i18n` 属性占位，
P3b 接字典时不用改结构。
