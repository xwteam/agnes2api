# admin-ui

人手编辑的面板源码。**零构建**：把这个目录原样当静态文件挂在 `/admin/` 下就是完整可调试的
面板，不需要任何转译 / 打包 / 安装步骤。

> ⚠️ **这里原来写的是「用浏览器直接打开 `index.html`（`file://`）就是完整可调试的面板」，
> 那句是假的**——实测推翻了它。两条原因各自都是致命的：
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
> **可执行的替代验收步骤**（已实测通过）：
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
   **站点图标（`<link rel="icon">`）走的是同一条规则**：它是一段 `data:image/svg+xml,…`
   的 URI 写在 `index.html` 里，不是仓里的第二个文件——`data:` 在 `src/ui/serve.ts`
   那条 CSP 的 `img-src 'self' data:` 里是被明确允许的。**别把它换成 `.ico` / `.png`**：
   那两种连 `scripts/build-ui.mjs` 的扩展名白名单都过不去。
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

## 目录结构与板块

`index.html` 是全站唯一的 HTML：顶上一条横贯的顶栏（品牌 / 仓库链接 / 语言 / 主题 /
退出登录）、左边一列导航按钮、右边一个内容区。**语言、主题、退出登录三样在顶栏，不在侧栏底部**
——侧栏现在只剩导航。导航按钮上的
`data-section` 是**板块清单的唯一真源**——`app.js` 按它切板块，下面这张表按它排，
`i18n` 字典按它取 `nav.*` 文案。每一个 `data-section` 各配一份同名的挂载文件
（拼 DOM 与发请求）和一份同名的纯逻辑文件（可测、无 DOM）。

| `data-section` | 板块 | 挂载 | 纯逻辑 |
|---|---|---|---|
| `overview` | 概览 | `js/sec-overview.js` | `js/pure/overview.mjs` |
| `keys` | Key 池 | `js/sec-keys.js` | `js/pure/keys.mjs` |
| `registrar` | 注册机 | `js/sec-registrar.js` | `js/pure/registrar.mjs` |
| `events` | 事件 | `js/sec-events.js` | `js/pure/events.mjs` |
| `usage` | 用量 | `js/sec-usage.js` | `js/pure/usage.mjs` |
| `models` | 模型 | `js/sec-models.js` | `js/pure/models.mjs` |
| `playground` | 调试台 | `js/sec-playground.js` | `js/pure/playground.mjs` |
| `settings` | 设置 | `js/sec-settings.js` | `js/pure/settings.mjs` |

`js/pure/` 下另有几份**不与板块一一对应**的共用纯逻辑：`js/pure/format.mjs`、
`js/pure/session.mjs`、`js/pure/storage-keys.mjs`、`js/pure/sendable.mjs`、
`js/pure/examples.mjs`、`js/pure/keys-write.mjs`。上表不管它们，只钉
「一个板块 ⇒ 两份同名文件」这一条。

板块之外的共用件：`js/boot.js`（见上，全站唯一的经典脚本）、`js/app.js`（外壳：登录闸、
导航、板块注册表与 `showSection`）、`js/api.js`（打管理接口 `/admin/api/*` 的出口）、
`js/gw-api.js`（调试台打对外网关那棵树用的另一份，**拿的是另一把钥匙**）、`js/i18n.js` +
`js/i18n-dict.js`（五语言字典）、`js/theme.js`（亮/暗主题）、`js/ui.js`（DOM 小工具）。
每一份的边界与理由都写在各自文件头，这里不复述。

> **这两串枚举有完备性判据**（补这条判据的起因是一次实测：往 `js/pure/` 里新加
> 一份文件而不改这里，`docs-parity` 全绿——手抄的清单会静静过期，正是本节存在的理由）。
> 现在 `admin-ui/js/` 与 `admin-ui/js/pure/` 下**每一份** `.js` / `.mjs` 都必须在这份
> README 里以 `` `js/…` `` 的形式露过面，新加一份而这里不提 ⇒ 当场点名那一份。

> ⚠️ **这一节原来写的是一份按内部排期分段的范围说明（哪几样东西「这一段还没有」、
> 哪几样「下一段才有」），那份说明早已过期，却一路活了很久没人发现。**
> 没人守是有原因的：`scripts/check-comment-refs.mjs`
> 这道门禁的扫描目录虽然含 `admin-ui`，但它只打开
> `.ts` / `.js` / `.mjs`——这份 `.md` 从来没被任何机器看过一眼。
>
> 上面那张表现在**有机器守了**：`tests/unit/docs-parity.test.ts` 里
> 「推公开仓之前第一个访客会看到的三份自述」那一组直接拿 `index.html`
> 的 `data-section` 当真源，加一个板块、删一个板块、改一个板块的名字而不改这张表，
> 就会当场红并点名那个板块；表里那两列文件也逐个 `existsSync`。
> **上面这句话本身也有测法**：那一组的名字改了、或者这份 README 不再点它，
> 那一格会红——它拿自己的 `describe` 名去 `admin-ui/README.md` 里找。
>
> ⚠️ **「删一个板块也点名」这半句是复评回填补上的，回填之前它是假的**：那时的判据
> 只从 `index.html` 的 `data-section` 出发单向查这张表，板块删了、表里那一行还留着，
> 没有任何一格看得见它；同时主格的下限是硬编码的 `8`，于是把一个板块从
> 三处一致地删掉之后仍然被拦下，报文还说「一个 data-section 都没扫到」——当时扫到了
> 7 个，那句报文是假的。现在这张表与 `data-section` 是**双向**比集合：表里多一行、
> 少一行都点名那一行，主格的下限改成「一个都没扫到才吵」。
>
> **真要删一个板块，要动的地方比那三处多**：`index.html` 的按钮、上表那一行、
> `js/sec-<板块>.js` 与 `js/pure/<板块>.mjs` 两份文件、`CHANGELOG.md` 里的点名与计数、
> 五份 `docs/<lang>/ADMIN.md` 的板块速查表——这几处少改哪一处，`docs-parity` 就点名哪一处
> （回填实测）。`js/i18n-dict.js` 里那条 `nav.<板块>` 不归它管，归第 6 道门禁
> （`scripts/check-i18n.mjs`，未被引用的 key 是硬错）。
>
> **它只比 code span 在不在，不比中文名写得对不对**——把 `overview` 那一行的
> 「概览」改成「设置」，表里每个板块的 span 一个不少，它一个字都不会吭。
