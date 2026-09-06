#!/usr/bin/env node
/*
 * 面板资源的体积预算。**两条线，量的不是同一件事**，这一段把两条各自的职责写清；
 * build-ui.mjs 那一侧只执行 raw 这一条，它指回这里，不在那边复述。
 *
 * ── gzip 这条是真护栏 ──────────────────────────────────────────────────────
 * 平台只管 gzip 后的脚本体积：Cloudflare Worker 免费档脚本上限是 gzip 后 **3 MiB**
 *（付费档 10 MiB，已核实，见设计文档 §17）。**raw 那个数平台一眼都不看。**
 *
 * 这 3 MiB 是**整个 Worker 脚本**（路由、dispatcher、注册机等业务代码 + 这里管的
 * UI 资源）共用的一个预算，不能把它整个划给 UI 资源，否则业务代码一涨就没有余量。
 * MAX_GZIP 取 **3 MiB 的 1/8 = 384 KiB（393216 字节）**，把 UI 这一项摁在 1/8 以内，
 * **给脚本其余 7/8（业务逻辑、依赖）留足空间**。
 *   - 分母是 3 MiB，不是「当前用量」：面板资源会随板块与五语言字典一起长，
 *     **别把某一天的实测值写死在这里当参照**（这一行原先写着 49.76 KiB，那是很早以前的数，
 *     后来一路长到三位数 KiB 都没人来改它）。要知道今天多少、离平台硬限还有多远，
 *     跑一次本脚本——它最后那行会把 gzip 占 3 MiB 的百分比**现算**给你，
 *     所以这里一个百分比都不写死。
 *
 * ── raw 这条是早期预警，不是护栏 ────────────────────────────────────────────
 * MAX_RAW = **2 MiB**（build-ui.mjs 生成时先强制一次，这里是防御性的第二道）。
 *
 * ① **它预警什么。** raw 与平台无关，它盯的是**源目录本身的量级**：admin-ui/ 是一份
 *    人要读、要审、要 grep 的手写目录，而 build-ui.mjs 会把它逐字节烧成字符串常量。
 *    2 MiB 是「一份手写前端目录的合理上界」这个量级判断——**再翻一番就该停下来问
 *    是不是塞进了不该由人手维护的东西**，而不是「今天用了多少所以画在哪」。
 *    它还是**唯一一条 `pnpm ui:build` 自己会执行的线**（那个脚本不算 gzip），
 *    职责因此是：让生成这一步在明显失控时当场停下，不必等 CI 跑到本脚本。
 *
 * ② **抬到 2 MiB 损失了什么，这一半必须写出来。** 名义上的代价是：
 *    「误塞一份大字典 / 一份不该入仓的生成文件」这类事故，要多一倍的量才会被 raw 拦下。
 *    但**实测下来这个代价比字面小，也比字面窄，两头都别夸**：
 *      · 两条线可以换算——`MAX_RAW / MAX_GZIP = 5.33`，也就是说 raw 这条只在
 *        **压缩比高于 5.33x** 的内容上才可能先于 gzip 触发；
 *      · 现算过的压缩比：本仓整份文本约 2.7x、五语言字典约 2.8x、CSS 约 2.5x，
 *        二进制走 base64 约 1.3x（`node -e` 一句 gzipSync 即可复算）。**全都低于 5.33x。**
 *    ⇒ 结论要说全：**「误提交非文本内容」这一类，raw 这条本来就不是拦它的那一条**
 *      （base64 只压 1.3x，gzip 那条会早两个数量级红）；真正被这次抬高放宽的，
 *      只有「压缩比 > 5.33x 的高度重复内容」——大段空白、被 pretty-print 开的生成文件
 *      这一类。对这一类，事故确实会晚一倍才被发现，且中间那一段没有任何别的线接住它。
 *
 * ③ **两条线的关系。** 抬之前 raw 那条（1 MiB）与 gzip 那条几乎重合（按本仓 2.7x 的
 *    压缩比，384 KiB gzip 折回去差不多就是 1 MiB raw），等于两条线在测同一件事；
 *    抬完之后它们才真正分工：**gzip 那条管「部署得进去吗」，raw 这条管「这个目录还是
 *    人写的吗」**。⚠️ 因此**报警会先从 gzip 那条来**——要放宽体积，该被重新论证的是
 *    MAX_GZIP 与那个 1/8 的分法，不是这里。
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(ROOT, "admin-ui");

/** 平台那条硬上限。**只用来现算「还剩多远」那一行**，比较用的是 MAX_GZIP。 */
const PLATFORM_GZIP = 3 * 1024 * 1024;

const MAX_RAW = Number(process.env.UI_MAX_RAW_BYTES ?? 2 * 1024 * 1024);
const MAX_GZIP = Number(process.env.UI_MAX_GZIP_BYTES ?? PLATFORM_GZIP / 8);

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

// **离平台硬限还有多远，现算**：文件头 ② / ③ 那两段刻意不写死任何百分比，
// 「今天多少」只有这一行说了算。⚠️ 分母是 PLATFORM_GZIP（3 MiB）不是 MAX_GZIP：
// 这一行回答的是「平台那条还剩多少」，本仓自设的 1/8 由上面那行负责报。
const pct = (n, d) => `${((n / d) * 100).toFixed(2)}%`;
console.log(
  `[check-ui-budget] gzip 占本仓上限 ${pct(gzip, MAX_GZIP)}；占平台硬限 ${PLATFORM_GZIP}B 的 ${pct(gzip, PLATFORM_GZIP)}`,
);

if (raw > MAX_RAW || gzip > MAX_GZIP) {
  console.error("[check-ui-budget] ❌ 超出预算");
  process.exit(1);
}
console.log("[check-ui-budget] ✅ 体积在预算内");
