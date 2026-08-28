# Changelog

本文件记录项目的所有重要变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

## [0.1.0] - 2026-08-28

首个版本。四协议网关、注册机与管理面板一次成型，同一份代码同时跑
Cloudflare Worker 与 Node / Docker 两种运行时。

### Added

- **四协议网关**：`openai`（Chat Completions）、`anthropic`（Messages）、
  `responses`（OpenAI Responses）、`gemini`（generateContent）四条入站协议
  共用同一套上游调度、同一个 Key 池、同一份失败归因。
- **Key 池与调度**：KV 上的池索引与取号、失败归因与冷却；上游一个都用不上时
  回 503，`reason` 逐种可分辨、五语言 API.md 逐份列全。
- **注册机**：`moemail` 与 `yyds` 两条临时邮箱通道，从收码到入池全自动，
  两条通道在文案与取数顺序上严格平级。
- **管理面板**：`/admin` 下的八个板块——概览 `overview`、Key 池 `keys`、
  注册机 `registrar`、事件 `events`、用量 `usage`、模型 `models`、
  调试台 `playground`、设置 `settings`。**零构建**：`admin-ui/` 原样就是可调试的
  面板，`scripts/build-ui.mjs` 只把它逐字节烧进 `src/ui/assets.generated.ts`。
- **管理接口鉴权**：`ADMIN_TOKEN` 没设时 `/admin` 整棵树都不注册；口令只走
  `x-admin-key` 请求头，不落 Cookie、不进 query。
- **五语言**：面板与文档（README / ADMIN / API / DEPLOY / REGISTRAR / USAGE）
  各有 `zh-CN` / `zh-TW` / `en` / `ja` / `ko` 五份。
- **CI 十二道门禁**：二进制、凭据、面板生成物一致性、体积预算、i18n 齐全性、
  KV 占位符、注释指向、类型检查、Node 与 workerd 两个运行时的测试、构建。
