#!/usr/bin/env node
/*
 * Worker 部署的第一步：建 KV 命名空间并把 id 写回 wrangler.toml。
 *
 * 仓库里那份 id 永远是占位符（零内置凭据 + check-wrangler-placeholder.mjs 门禁），
 * 所以每个部署者都得自己建一个。手工步骤有三步、错一步就是部署失败且报错难懂，
 * 因此把它做成一条命令。
 *
 * 不新增依赖：靠 `wrangler` 这个已有的开发依赖 + node 内置模块。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PLACEHOLDER = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID";
const BINDING = "POOL";

function run(args) {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
}

const toml = readFileSync("wrangler.toml", "utf8");
if (!toml.includes(PLACEHOLDER)) {
  console.log("[setup-worker] wrangler.toml 里的 KV id 已经不是占位符，无需重复创建。");
  console.log("[setup-worker] 想重新来一次：git checkout -- wrangler.toml 之后再跑本脚本。");
  process.exit(0);
}

console.log(`[setup-worker] 正在创建 KV 命名空间 ${BINDING} …`);
const out = run(["kv", "namespace", "create", BINDING]);
process.stdout.write(out);

// wrangler 的输出里含 id = "…"（32 位 hex）。只认这个形态，认不出就明说，不猜。
const m = out.match(/id\s*=\s*"([0-9a-f]{32})"/i);
if (!m) {
  console.error(
    "[setup-worker] 没能从 wrangler 的输出里解析出命名空间 id。\n"
    + "请手动把上面输出里的 id 填进 wrangler.toml 的 [[kv_namespaces]] 段。",
  );
  process.exit(1);
}

writeFileSync("wrangler.toml", toml.replace(PLACEHOLDER, m[1]), "utf8");
console.log(`[setup-worker] ✅ 已写入 wrangler.toml：id = "${m[1]}"`);
console.log("");
console.log("[setup-worker] 接下来还有两步：");
console.log("  1) npx wrangler secret put GATEWAY_TOKEN     # 网关口令，发给下游用户");
console.log("  2) npx wrangler secret put ADMIN_TOKEN       # 管理口令，至少 24 位且与上面不同（不设则 /admin 整棵树不注册）");
console.log("");
console.log("  然后：node scripts/build-ui.mjs && npx wrangler deploy");
console.log("");
console.log("[setup-worker] ⚠️ **不要提交这次对 wrangler.toml 的改动**——公开仓里不该出现真实 id。");
console.log("               提交前：git checkout -- wrangler.toml");
