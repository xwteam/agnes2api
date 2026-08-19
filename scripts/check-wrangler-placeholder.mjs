#!/usr/bin/env node
/*
 * 防止真实 KV namespace id 被提交进公开仓，并防止 KV binding 改名后没人发现。
 *
 * setup-worker.mjs 会**就地改写** wrangler.toml（那是本机部署时该做的事），
 * 而这个门禁保证那次改写不会跟着提交上来——公开仓里出现真实 id 属于泄漏部署细节，
 * 与 scan-secrets.sh 是同一条纪律。
 *
 * 第二条断言（binding 名）是 Task 8 复验时登记的一个缺口：`src/entry/worker.ts`
 * 硬编码读 `env.POOL`（`Env.POOL: KVNamespace` 字段 + 两处 `new KvStorage(env.POOL)`），
 * 这个名字来自 `wrangler.toml` 的 `[[kv_namespaces]] binding = "POOL"`——**两边只是
 * 靠约定对上，没有任何类型系统或测试把它们钉在一起**。契约测试用 miniflare 的
 * `kvNamespaces: ["POOL"]` 是测试自己声明的绑定，不读 `wrangler.toml`，所以就算有人
 * 把 `wrangler.toml` 里的 binding 改成别的名字，契约测试照样全绿；只有真机部署时
 * `env.POOL` 才会是 `undefined`，运行时才炸，而且炸得很隐蔽（`new KvStorage(undefined)`
 * 不会立刻抛错，等到第一次真正的 KV 操作才会失败）。这里把 `wrangler.toml` 里的
 * 实际 binding 名与代码期望的 `"POOL"` 钉在一起，改名会在 CI 里被立刻拦下。
 */
import { readFileSync } from "node:fs";

const PLACEHOLDER = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID";
const EXPECTED_BINDING = "POOL"; // 必须与 src/entry/worker.ts 的 `env.POOL` 一致

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

const bindingMatch = toml.match(/^\s*binding\s*=\s*"([^"]*)"/m);
if (!bindingMatch) {
  console.error(
    "[check-wrangler-placeholder] wrangler.toml 里没找到 `binding = \"...\"`。\n"
    + "[[kv_namespaces]] 段必须声明一个 binding，否则 Worker 运行时 env.POOL 取不到值。",
  );
  process.exit(1);
}
if (bindingMatch[1] !== EXPECTED_BINDING) {
  console.error(
    `[check-wrangler-placeholder] wrangler.toml 的 KV binding 是 "${bindingMatch[1]}"，`
    + `但代码硬编码读的是 env.${EXPECTED_BINDING}（src/entry/worker.ts）。\n`
    + `真机部署时 env.${EXPECTED_BINDING} 会是 undefined，只会在真正调用 KV 时才炸。\n`
    + `请把 wrangler.toml 的 binding 改回 "${EXPECTED_BINDING}"，或同步改代码里的 env.${EXPECTED_BINDING} 引用。`,
  );
  process.exit(1);
}

console.log("[check-wrangler-placeholder] ✅ KV id 仍是占位符");
console.log(`[check-wrangler-placeholder] ✅ KV binding 与代码期望的 "${EXPECTED_BINDING}" 一致`);
