# Changelog

本文件记录项目的所有重要变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> **语言**：本文件只有简体中文一份。繁體中文 / English / 日本語 / 한국어 那几份 README
> 里的版本徽章同样链到这里，点进来看到的就是这一份中文。

## [Unreleased]

## [0.1.0] - 2026-08-28

首个版本。四协议网关、注册机与管理面板一次成型，同一份代码同时跑
Cloudflare Worker 与 Node / Docker 两种运行时。

### Added

- **四协议网关**：`openai`（Chat Completions）、`anthropic`（Messages）、
  `responses`（OpenAI Responses）、`gemini`（generateContent）四条入站协议
  共用同一套上游调度、同一个 Key 池、同一份失败归因。
- **Key 池与调度**：池索引与取号（Worker 形态落在 KV 上，走 `KvStorage`；
  Node / Docker 形态落在单文件 JSON 上，走 `FileStorage`）、失败归因与冷却；
  上游一个都用不上时回 503，其中「同步档把总预算耗光、一把 key 都没应答」那一种回 504，
  `reason` 逐种可分辨、五语言 API.md 逐份列全。
- **注册机**：`moemail` 与 `yyds` 两条临时邮箱通道，从收码到入池全自动，
  两条通道在文案与取数顺序上严格平级。
- **管理面板**：`/admin` 下的八个板块——概览 `overview`、Key 池 `keys`、
  注册机 `registrar`、事件 `events`、用量 `usage`、模型 `models`、
  调试台 `playground`、设置 `settings`。**零构建**：`admin-ui/` 原样挂在 `/admin/` 下
  就是可调试的面板（`file://` 直接打开不行，理由见 `admin-ui/README.md`），
  `scripts/build-ui.mjs` 只把它逐字节烧进 `src/ui/assets.generated.ts`。
- **管理接口鉴权**：`ADMIN_TOKEN` 没设时 `/admin` 整棵树都不注册；口令只走
  `x-admin-key` 请求头，不落 Cookie、不进 query。
- **五语言**：面板与文档（README / ADMIN / API / DEPLOY / REGISTRAR / USAGE）
  各有 `zh-CN` / `zh-TW` / `en` / `ja` / `ko` 五份。
- **CI 十三道门禁**：跟踪文件不许是二进制、具名放行的 PNG 结构审计、凭据扫描、
  生成面板资源、生成物一致性、面板体积预算、i18n 完整性、KV namespace id 仍是占位符、
  注释里的指向必须解析得开、类型检查、单元 / 契约 / 前端纯函数测试、
  契约测试（workerd 运行时）、构建
  —— 这一串短名逐个对应 `.github/workflows/ci.yml` 里那十三步，顺序也是那边的顺序。

### 已知限制

- **本仓至今零份真上游样本。** `src/core/admin/upstream-facts.ts` 那张上游事实表里，
  每一条的 `status` 都是 `assumed`，`source` 逐条如实写着依据来自我们自己写的假上游；
  契约测试里的上游同样全是桩。所以「示例请求在本仓这份 app 上调得通」
  **不等于**「上游真的接受它」。验后者必须联网打真上游，而真上游要真凭据，
  与本仓「仓库零内置凭据」那条硬约束冲突 —— 这是一条带理由的登记，不是遗漏。
  拿这份协议目录去对接上游之前，请自行核对。
