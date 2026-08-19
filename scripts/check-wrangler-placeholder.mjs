#!/usr/bin/env node
/*
 * 防止真实 KV namespace id 被提交进公开仓。
 *
 * setup-worker.mjs 会**就地改写** wrangler.toml（那是本机部署时该做的事），
 * 而这个门禁保证那次改写不会跟着提交上来——公开仓里出现真实 id 属于泄漏部署细节，
 * 与 scan-secrets.sh 是同一条纪律。
 */
import { readFileSync } from "node:fs";

const PLACEHOLDER = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID";

const toml = process.env.WRANGLER_TOML_FROM_STDIN === "1"
  ? readFileSync(0, "utf8")
  : readFileSync("wrangler.toml", "utf8");

if (!toml.includes(PLACEHOLDER)) {
  console.error(
    "[check-wrangler-placeholder] wrangler.toml 里的 KV namespace id 已不是占位符。\n"
    + "本地部署请用 `node scripts/setup-worker.mjs` 改写，**但不要提交这次改动**：\n"
    + "  git checkout -- wrangler.toml   # 提交前还原\n"
    + `占位符应为 ${PLACEHOLDER}`,
  );
  process.exit(1);
}
console.log("[check-wrangler-placeholder] ✅ KV id 仍是占位符");
