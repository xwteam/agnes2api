# admin-ui

人手编辑的面板源码。**零构建**：把这个目录原样当静态文件挂在 `/admin/` 下就是完整可调试的
面板，不需要任何转译 / 打包 / 安装步骤。

> ⚠️ **这里原来写的是「用浏览器直接打开 `index.html`（`file://`）就是完整可调试的面板」，
> 那句是假的**——P3b Task 7 的阶段验收实测推翻了它。两条原因各自都是致命的：
> ① `index.html` 里的资源引用是**绝对路径**（`/admin/js/boot.js`、`/admin/css/base.css`、
> `/admin/js/app.js`）。实测 `new URL("/admin/js/boot.js", "file:///…/admin-ui/index.html")`
> 得到 `file:///admin/js/boot.js`，那个路径在任何机器上都不存在 ⇒ CSS 与 JS 全部 404，
> 只剩一张没有样式、没有行为的裸 HTML。
> ② 就算把它们改成相对路径也救不回来：现代浏览器把 `file://` 文档的源当成 `null`，
> `<script type="module">` 会被 CORS 挡下。
>
> **绝对路径本身是对的，所以不改 `index.html`**：生产上 `/admin` 这条路由没有尾斜杠，
> 用相对路径反而会解析到 `/js/app.js` 而 404。
>
> **可执行的替代验收步骤**（Task 7 已实测通过）：
>
> ```bash
> mkdir -p /tmp/rawserve && ln -s "$PWD/admin-ui" /tmp/rawserve/admin
> (cd /tmp/rawserve && python3 -m http.server 8097)
> # 浏览器打开 http://localhost:8097/admin/
> ```
>
> 期望：登录闸**带样式**渲染出来、语言下拉框被 `app.js` 填了 5 项（说明整条 ESM 模块图
> 都解析成功）、控制台除 `favicon.ico` 的 404 外没有别的错误。这一步用的是**原始源目录**、
> 没经过生成器，所以它证明的正是「零构建」这件事。

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
2. **零二进制资源**；**零内联脚本**（CSP 的 `script-src 'self'`）。
   图标一律**内联** SVG（写在 HTML/JS 里）。**独立的 `.svg` 文件同样被拒**——
   它会以 `image/svg+xml` 挂在 `/admin/` 下，直接导航过去就是一个**同源文档**，
   里面的 `<script>` / `on*` / `javascript:` 都会执行，而脚本校验只对 `.html` 生效。
   「零内联脚本」的判据是**属性边界**匹配：`<script data-src="x">payload</script>`
   这类假 `src` 伪装拦得住（浏览器只在真有 `src` 时才忽略内联体）。
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
