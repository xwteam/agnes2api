#!/usr/bin/env node
// `scripts/check-no-binary.mjs` 那道门禁对 `docs/logo.png` 开了一个**具名放行**
// （只放行这一个字面路径，不是 `*.png`、更不是整个 `docs/`）。放行是有代价的：
// 那道门禁原来的语义是"这几个目录下一个二进制文件都不许有"，一旦让进来一个，
// 就得有人替它回答"这个文件里藏没藏东西"。这个脚本就是那个人。
//
// ── 放行让出的洞到底有多大：量出来的，不是推的 ─────────────────────────────
// `scripts/scan-secrets.sh` 今天**不是**对二进制文件全瞎（那句话曾经是对的，
// 在它去掉 `git grep -I` 之前）。本机在一份仓库副本上逐档实测过四种载荷：
//   A 干净的 logo                                    ⇒ 绿（基线，证明下面三条不是恒红）
//   B `IEND` 之后追加一段 `sk-` 开头的假凭据          ⇒ **红**（前五条形态判据只看
//     `git grep` 的退出码，二进制命中照样是 0，所以它抓得住）
//   C `IEND` 之后追加一个私有域名 + 一个邮箱          ⇒ **绿 —— 它看不见**
//   D 把 B 那段假凭据 zlib 压一遍再追加               ⇒ **绿 —— 它看不见**
// ⇒ 洞的真实形状是：**凡是不长成那六条形态的东西（域名 / 邮箱 / 口令 / JWT /
//   base64 团），以及任何被压过一道的东西，凭据扫描一个字都读不到。**
// 一个 PNG 有的是地方放这些：`IEND` 之后的尾随字节、`tEXt` / `zTXt` / `iTXt` /
// `eXIf` 这类能塞任意字节的块、乃至一个 CRC 对不上的坏块。这个脚本把这些位置
// 逐个封掉——**它守的是"这个文件里除了像素什么都没有"，不是"这张图好不好看"。**
//
// ⚠️ **第 6 条规则（裸 IP）那一档是 fail-closed，今天不红是逐字节的运气。**
// 它要的是命中行的**内容**（白名单按取值放行），而 `git grep` 对二进制只吐一行
// `Binary file … matches`，于是它按失败处理并直接点名这道放行。
// 换句话说：换一张图的那天，只要新图的压缩字节里恰好出现一段形如四段点分十进制的
// ASCII，`scripts/scan-secrets.sh` 会**当场红**，而报文说的是"先看
// scripts/check-no-binary.mjs 那道门禁为什么放它进来"。这不是故障，是设计——
// 但换图的人必须提前知道，否则他会以为自己弄坏了凭据扫描。
//
// ── 换图流程（少一步都不行）────────────────────────────────────────────────
//   ① 覆盖 `docs/logo.png`（128×128、8 位 RGBA、非隔行）；
//   ② 把下面 `REGISTERED_BINARIES` 里那条 sha256 换成新图的
//      （`sha256sum docs/logo.png`）——不换的话这道门禁当场红，这是有意的：
//      **登记值就是"这张图是被人看过的那张"的唯一凭证**；
//   ③ 重跑 `bash scripts/scan-secrets.sh` 与 `bash scripts/scan-secrets.sh --history`
//      六条规则两档都要跑，理由见上面那段 fail-closed；
//   ④ 重跑 `node scripts/check-png.mjs`。
//
// ── 判据自己的边界（明写，别读成它什么都能验）──────────────────────────────
// · 它**证不了**这张图"好看"或"是我们想要的那张图"：sha256 只证明字节没变过，
//   第一次登记那个值的人有没有真的看过这张图，机器验不了。
// · 它**证不了**像素里没有隐写（LSB 之类）。真要藏，压缩数据本身就是载体，
//   而那是一条它不打算堵的路——堵它要重编码整张图，代价与收益不成比例。
//   这里堵的是"顺手把东西塞进一个不会被人看见的块"，那才是实际会发生的形态。
// · 透明度下限守的是"这是一张抠过图的标记"，不是"这张图内容对"。
//   它拦得住"一整块不透明的贴片"，拦不住"一张全透明的空图"（那种会先被
//   `IHDR` 的尺寸/体积判据之外的人眼发现，机器这里不装能耐）。

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";

/**
 * **进仓的二进制文件名册：路径 → sha256。这是全仓唯一一份。**
 *
 * `scripts/check-no-binary.mjs` 的具名放行清单**从这里 import**，不在那边手抄第二份
 * ——手抄的那份会漂（这一条是本仓的老纪律：两份真源迟早对不上，而且是静静对不上）。
 * 加一条 = 同时承诺"它会被这个脚本逐字节审一遍"，加不进来就说明它不该进仓。
 */
export const REGISTERED_BINARIES = Object.freeze({
  "docs/logo.png": "172fed1fb9545b96d93ddbef937bdb58cd16142ae6e6ca9063f578ac2602caa6",
});

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 允许出现的块：只有真正承载像素与画布信息的那几种。白名单外一律拒绝。 */
export const ALLOWED_CHUNKS = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "pHYs", "bKGD", "sBIT", "iCCP",
]);

/**
 * 明令禁止的块。**它们与"白名单外一律拒绝"不是同一件事**：白名单已经把这些挡在外面了，
 * 这张黑名单的意义是让报文说出**为什么**——"含被禁块 tEXt（可塞任意字节）"比
 * "含未登记块 tEXt"多告诉了读者一件事：这不是一个疏忽，是这个位置本身就是藏东西的地方。
 */
export const FORBIDDEN_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "hIST", "tIME", "sPLT", "dSIG"]);

export const LIMITS = Object.freeze({
  width: 128,
  height: 128,
  maxBytes: 32 * 1024,
  /**
   * 完全透明（alpha == 0）像素占比的下限。
   * ⚠️ **本机实测的三张真图是 0.504 / 0.688 / 0.701**（两个参照仓 + 本仓这张；
   * 本脚本算出来的值与 PIL 的 alpha 直方图逐位相同，两侧独立对过）。
   * 也就是说其中一张只高出这条线 0.4 个百分点 —— 这条线**没有余量**，
   * 它拦的是"整块不透明的贴片"（那种是 0.0 一档的事），不是在做质量分级。
   * 想往上抬这个数之前先量一遍手上的图，别把一张合格的图抬成不合格。
   */
  minTransparentRatio: 0.5,
});

/** PNG 的 CRC-32（多项式 0xEDB88320）。逐块算，改一个字节就对不上。 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 完全透明像素的占比。**只支持 8 位 RGBA 非隔行**——别的形态在上面就被判掉了，
 * 这里不做第二次分支：一个"顺手支持一下"的分支等于一条没人测过的解码路径。
 */
function transparentRatio(idat, width, height) {
  const raw = inflateSync(idat);
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`解压后的像素数据是 ${raw.length} 字节，按 ${width}×${height} RGBA 算应该是 ${height * (stride + 1)} 字节`);
  }
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let transparent = 0;
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    raw.copy(cur, 0, pos, pos + stride);
    pos += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (ft) {
        case 0: break;
        case 1: cur[i] = (cur[i] + a) & 0xff; break;
        case 2: cur[i] = (cur[i] + b) & 0xff; break;
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: cur[i] = (cur[i] + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`第 ${y} 行的行过滤器是 ${ft}，PNG 只定义了 0..4`);
      }
    }
    for (let x = 3; x < stride; x += bpp) if (cur[x] === 0) transparent++;
    cur.copy(prev);
  }
  return transparent / (width * height);
}

/**
 * 逐字节审一个 PNG。**不满足任何一条就 throw**，报文里带上是哪一条不满足
 * ——五条负例各自命中不同分支这件事由 `tests/unit/check-png.test.ts` 的
 * 「五条负例的报文两两不同 —— 不是一把梭」钉着。
 */
export function auditPng(path, buf = readFileSync(path)) {
  const fail = (msg) => { throw new Error(`${path}: ${msg}`); };

  if (!buf.subarray(0, 8).equals(SIGNATURE)) fail("不是 PNG（头 8 字节的签名不符）");

  const chunks = [];
  let off = 8;
  let idat = [];
  while (off < buf.length) {
    if (off + 12 > buf.length) fail(`偏移 ${off} 处块头不完整（剩下 ${buf.length - off} 字节，一个块至少要 12 字节）`);
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) fail(`偏移 ${off} 处的块类型不是四个 ASCII 字母: ${JSON.stringify(type)}`);
    const dataEnd = off + 8 + len;
    if (dataEnd + 4 > buf.length) fail(`块 ${type} 声明的长度 ${len} 越过了文件尾`);
    const crcGot = buf.readUInt32BE(dataEnd);
    const crcWant = crc32(buf.subarray(off + 4, dataEnd));
    if (crcGot !== crcWant) {
      fail(`块 ${type} CRC 不符（文件里写着 ${crcGot.toString(16)}，按内容算是 ${crcWant.toString(16)}）—— 有字节被改过`);
    }
    chunks.push(type);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, dataEnd));
    off = dataEnd + 4;
    if (type === "IEND") break;
  }

  // 最常见的藏法：整份 PNG 一字未动，东西全接在 `IEND` 后面。看图的软件一律不读它。
  if (off !== buf.length) fail(`IEND 之后还有 ${buf.length - off} 字节尾随数据 —— PNG 到 IEND 就结束了，多出来的字节没有任何用途`);
  if (chunks[0] !== "IHDR") fail(`首块是 ${chunks[0]}，不是 IHDR`);
  if (chunks.at(-1) !== "IEND") fail(`末块是 ${chunks.at(-1)}，不是 IEND`);
  for (const t of chunks) {
    if (FORBIDDEN_CHUNKS.has(t)) fail(`含被禁块 ${t}（这类块能塞任意字节，是凭据唯一藏得住的地方）`);
    if (!ALLOWED_CHUNKS.has(t)) fail(`含未登记块 ${t}（白名单外一律拒绝）`);
  }
  if (idat.length === 0) fail("一个 IDAT 都没有 —— 这份 PNG 里没有像素");

  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const [depth, colorType, compression, filter, interlace] = [buf[24], buf[25], buf[26], buf[27], buf[28]];
  if (depth !== 8 || colorType !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) {
    fail(`只收 8 位 RGBA 非隔行 PNG，这份是 depth=${depth} colorType=${colorType} compression=${compression} filter=${filter} interlace=${interlace}`);
  }
  if (width !== LIMITS.width || height !== LIMITS.height) {
    fail(`尺寸是 ${width}×${height}，模板要求 ${LIMITS.width}×${LIMITS.height}`);
  }
  if (buf.length > LIMITS.maxBytes) {
    fail(`体积 ${buf.length} 字节，超过上限 ${LIMITS.maxBytes} 字节`);
  }

  const ratio = transparentRatio(Buffer.concat(idat), width, height);
  if (ratio < LIMITS.minTransparentRatio) {
    fail(`完全透明像素只占 ${(ratio * 100).toFixed(1)}%，低于下限 ${(LIMITS.minTransparentRatio * 100).toFixed(0)}%`
      + " —— 模板要的是抠过图的标记，不是一整块不透明的贴片");
  }

  return {
    chunks, width, height, bytes: buf.length, transparentRatio: ratio,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

/**
 * 审一个登记在册的路径：结构 + sha256 两道。
 * **读不到文件也算红**（名册里登记了却不在仓里 = 名册烂了，不是"没什么要审的"）。
 */
function auditRegistered(path, want) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch (e) {
    return { path, error: `${path}: 读不到（${e.code ?? e.message}）—— 名册里登记着它，仓里却没有` };
  }
  let info;
  try {
    info = auditPng(path, buf);
  } catch (e) {
    return { path, error: e.message };
  }
  if (want !== null && info.sha256 !== want) {
    return {
      path,
      error: `${path}: sha256 与登记值不符（登记 ${want}，实际 ${info.sha256}）`
        + " —— 换图要连同 scripts/check-png.mjs 里那条登记值一起换，并按文件头那四步重跑凭据扫描",
    };
  }
  return { path, info };
}

function main(argv) {
  const targets = argv.length > 0
    ? argv.map((p) => [p, REGISTERED_BINARIES[p] ?? null])
    : Object.entries(REGISTERED_BINARIES);
  if (targets.length === 0) {
    // fail closed：名册空了说明有人把它删空了，而这个脚本会"全绿"——那是最坏的形态。
    console.error("[check-png] ❌ 名册 REGISTERED_BINARIES 是空的 —— 没有东西可审不等于审过了");
    return 1;
  }
  const results = targets.map(([p, want]) => auditRegistered(p, want));
  const bad = results.filter((r) => r.error !== undefined);
  if (bad.length > 0) {
    console.error("[check-png] ❌ 以下 PNG 没通过结构审计（它们是 check-no-binary 具名放行进来的，所以这里是它们唯一的守卫）：");
    for (const r of bad) console.error(`  ${r.error}`);
    console.error("[check-png] 判据与换图流程见 scripts/check-png.mjs 文件头；别用放宽判据来收工——放宽等于把放行让出的洞重新打开。");
    return 1;
  }
  for (const r of results) {
    const i = r.info;
    console.log(`[check-png] ✅ ${r.path}  ${i.width}×${i.height} / ${i.bytes} 字节 / 块序 ${i.chunks.join(" ")}`
      + ` / 完全透明 ${(i.transparentRatio * 100).toFixed(1)}% / sha256 ${i.sha256.slice(0, 12)}…`);
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
