#!/usr/bin/env node
/*
 * 面板资源的体积预算。
 *
 * 原始字节的上限已经在 build-ui.mjs 生成时强制过一次（MAX_RAW_BYTES = 1 MiB，
 * 超了直接 fail 生成），这里的 raw 检查是防御性的第二道。这个脚本真正新增的是
 * gzip 后的上限——Worker 脚本的部署体积上限是 gzip 后的值，而约 500 KB 的字符串
 * 常量会整个进脚本。上限数字见待复核项 U1/U2，复核完之前这两个阈值按保守值取。
 *
 * ⚠️ **刻意不 import `../src/ui/assets.generated.js`**：那是 .ts 生成物，纯 node
 * （没有 tsx/ts-node）下 import 不了。改为直接读 admin-ui/ 源目录算字节——这样门禁
 * 与生成物解耦，不依赖任何 TS 运行时；生成物是否与源一致，交给门禁 3
 * （`git diff --exit-code src/ui/assets.generated.ts`）负责，这里只管体积。
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(ROOT, "admin-ui");

const MAX_RAW = Number(process.env.UI_MAX_RAW_BYTES ?? 1024 * 1024);
const MAX_GZIP = Number(process.env.UI_MAX_GZIP_BYTES ?? 400 * 1024);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// README.md 只给人看，不投递（build-ui.mjs 同样把它排除在生成物之外）。
const files = walk(SRC).filter((p) => !p.endsWith("README.md"));

let raw = 0;
const parts = [];
const bodies = [];
for (const p of files) {
  const body = readFileSync(p, "utf8");
  const n = Buffer.byteLength(body, "utf8");
  raw += n;
  bodies.push(body);
  parts.push(`${p.slice(SRC.length + 1).split(sep).join("/")} ${n}B`);
}

const gzip = gzipSync(Buffer.from(bodies.join(""), "utf8")).length;

console.log(`[check-ui-budget] 原始 ${raw}B / 上限 ${MAX_RAW}B；gzip ${gzip}B / 上限 ${MAX_GZIP}B`);
console.log(parts.map((p) => `  ${p}`).join("\n"));

if (raw > MAX_RAW || gzip > MAX_GZIP) {
  console.error("[check-ui-budget] ❌ 超出预算");
  process.exit(1);
}
console.log("[check-ui-budget] ✅ 体积在预算内");
