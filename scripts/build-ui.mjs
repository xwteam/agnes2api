#!/usr/bin/env node
/*
 * 把 admin-ui/ **逐字节**烧进 src/ui/assets.generated.ts。
 * 不转译、不打包、不压缩——产物字节与源文件完全相同，
 * 因此 admin-ui/index.html 用浏览器直接打开仍然是一个完整可调试的面板。
 * 这是守住硬约束 4（不引入需要构建步骤的前端框架）的全部依据，
 * 由 tests/unit/ui-assets.test.ts 钉死。
 *
 * 生成物**入仓**：deploy-worker.yml 用 wrangler-action 的 `command: deploy`，
 * 绕过一切 npm script；Cloudflare 的 Deploy 按钮也是从仓库直接部署。
 * 生成物不入仓 =「裸克隆即 wrangler deploy」这个卖点断掉。
 *
 * 用法：
 *   node scripts/build-ui.mjs             # 写默认位置 src/ui/assets.generated.ts
 *   node scripts/build-ui.mjs <出口路径>   # 写别处（tests/unit/ui-assets.test.ts 的漂移门禁用它
 *                                          # 生成到临时目录再整文件比对，不碰工作区）
 *
 * 路径一律**按本文件位置**解析，不按 cwd：CI、git hook、编辑器任务都可能从别的目录
 * 发起调用，按 cwd 解析会静默生成一份空的或报错的产物。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(ROOT, "admin-ui");
const OUT = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "src", "ui", "assets.generated.ts");
const MAX_RAW_BYTES = 1024 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function fail(msg) {
  console.error(`[build-ui] ${msg}`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  // 排序保证产物确定性：目录读取顺序在不同文件系统上不一样，不排序的话
  // 「重新生成一遍应当逐字节相同」这条漂移门禁会随机变红。
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(SRC).filter((p) => !p.endsWith("README.md"));
if (files.length === 0) fail(`${SRC} 里一个文件都没有`);

const assets = {};
let totalBytes = 0;

for (const p of files) {
  const rel = p.slice(SRC.length + 1).split(sep).join("/");
  const dot = rel.lastIndexOf(".");
  const ext = dot < 0 ? "" : rel.slice(dot);

  // 规则 1：零二进制资源。保证生成器是纯文本拼接（无 base64 分支、无懒解码），
  // 也让 CSP 能收得很紧。
  if (!(ext in TYPES)) fail(`不认识的扩展名 ${ext}（${rel}）。零二进制资源是硬规则，图标请内联 SVG`);

  const body = readFileSync(p, "utf8");
  totalBytes += Buffer.byteLength(body, "utf8");

  // 规则 3：js/pure/*.mjs 的静态校验。保证它们在 vitest 的 node 环境里 import 一定不炸。
  // 是纯文本匹配、不解析注释——规则全文与这条限制写在 admin-ui/README.md。
  if (rel.startsWith("js/pure/")) {
    if (/^\s*import\s/m.test(body)) fail(`${rel}: js/pure 下禁止 import`);
    if (/\bdocument\b/.test(body)) fail(`${rel}: js/pure 下禁止出现 DOM 全局（含注释）`);
    if (/\bwindow\b/.test(body)) fail(`${rel}: js/pure 下禁止出现浏览器窗口全局（含注释）`);
  }

  // 规则：零内联脚本（CSP script-src 'self'）。
  if (ext === ".html") {
    for (const m of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (!/\bsrc=/.test(m[1]) && m[2].trim().length > 0) fail(`${rel}: 禁止内联脚本`);
    }
  }

  // 规则：文案里不许出现「数字IP:端口」，scan-secrets.sh 的第五条正则会把 CI 打红。
  const ipPort = body.match(/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{2,5}/);
  if (ipPort) fail(`${rel}: 出现 IP:PORT 形态「${ipPort[0]}」，请改写成 localhost:8080 或 example.com`);

  const route = rel === "index.html" ? "/admin" : `/admin/${rel}`;
  assets[route] = {
    body,
    type: TYPES[ext],
    // 强 ETag，且必须是 **body** 的哈希：哈希路径的话改了内容 etag 不变，
    // 所有已缓存的浏览器会永远收到 304、停在旧面板上，而且没有任何报错。
    etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`,
  };
}

// 规则 2：体积预算。gzip 后的上限在 CI 里查（Task 8）。
if (totalBytes >= MAX_RAW_BYTES) fail(`原始总字节 ${totalBytes} 超过 1 MiB`);

const buildHash = createHash("sha256")
  .update(Object.keys(assets).sort().map((k) => k + assets[k].etag).join("\n"))
  .digest("hex").slice(0, 16);

// 规则 4：字符串一律走 JSON.stringify，不手工拼引号。
const entries = Object.keys(assets).sort().map((k) => {
  const a = assets[k];
  return `  ${JSON.stringify(k)}: { body: ${JSON.stringify(a.body)}, type: ${JSON.stringify(a.type)}, etag: ${JSON.stringify(a.etag)} },`;
}).join("\n");

const out = `// 由 scripts/build-ui.mjs 生成，**请勿手工编辑**。
// 源在 admin-ui/，改完那边跑 \`pnpm ui:build\`。产物与源逐字节相同（tests/unit/ui-assets.test.ts 钉死）。
export interface UiAsset {
  readonly body: string;
  readonly type: string;
  readonly etag: string;
}

export const UI_ASSETS: Readonly<Record<string, UiAsset>> = {
${entries}
};

export const UI_BUILD_HASH = ${JSON.stringify(buildHash)};
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out, "utf8");
console.log(`[build-ui] ${files.length} 个文件，原始 ${totalBytes} 字节，hash ${buildHash} → ${OUT}`);
