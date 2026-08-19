#!/usr/bin/env node
/*
 * 面板资源的体积预算。
 *
 * 原始字节的上限已经在 build-ui.mjs 生成时强制过一次（MAX_RAW_BYTES = 1 MiB，
 * 超了直接 fail 生成），这里的 raw 检查是防御性的第二道。这个脚本真正新增的是
 * gzip 后的上限——Worker 脚本的部署体积上限是 gzip 后的值，而约 500 KB 的字符串
 * 常量会整个进脚本。
 *
 * MAX_GZIP 的取值（Task 9，已核实，见设计文档 §17 U2）：
 * Cloudflare Worker 免费档脚本上限是 gzip 后 **3 MiB**（付费档 10 MiB）。这个
 * 3 MiB 是**整个 Worker 脚本**（路由、dispatcher、注册机等业务代码 + 这里管的
 * UI 资源）共用的一个预算，不能把它整个划给 UI 资源，否则业务代码一涨就没有
 * 余量。这里取 **3 MiB 的 1/8 ≈ 384 KiB（393216 字节）**：
 *   - 真机部署实测 UI 资源当前是 **49.76 KiB gzip**（3 MiB 的约 1.6%），
 *     384 KiB 相当于给它留了约 **7.7 倍**的增长空间（P3b 起还要加 i18n 字典、
 *     更多板块），不会「刚好够用」就报警；
 *   - 同时把 UI 这一项死死摁在 3 MiB 预算的 1/8 以内，**给脚本其余 7/8
 *     （业务逻辑、依赖）留足空间**，UI 资源一旦失控增长（例如不小心内联了
 *     一份大字典或误提交了非文本内容）会在离 3 MiB 上限还很远的地方就被拦下，
 *     而不是等到接近 Cloudflare 的硬上限才发现。
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(ROOT, "admin-ui");

const MAX_RAW = Number(process.env.UI_MAX_RAW_BYTES ?? 1024 * 1024);
const MAX_GZIP = Number(process.env.UI_MAX_GZIP_BYTES ?? (3 * 1024 * 1024) / 8);

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
