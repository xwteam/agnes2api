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
// 逐个封掉——**它守的是"这个文件里没有第二个能自由写字节的地方"**，不是"这张图好不好看"。
// 这句话展开是三件事，缺一件它就是句假话（前两轮回填各抓到缺了哪一件）：
//   · `IDAT` 之外每个块的长度都被规范钉死（`CHUNK_SIZE`）；
//   · `IDAT` 之外每种块**至多出现一次**——一千个合法瘦块与一个超长胖块是同一个口袋；
//   · `IDAT` 自己**两侧都对账**：解压**出来**多少（`宽×高×4 + 每行 1 字节`）
//     与解压**用掉**多少（`engine.bytesWritten` 必须吃满整段 `IDAT`）都要对上。
//
// ⚠️ **上面这句话在第一版里是假的，回填第 1 轮才变成真的。** 第一版的白名单里有
// `iCCP`（"名字 \0 + 压缩方法 + 任意长度 zlib 流"）、`PLTE`、`tRNS` 三个变长块，
// 而且**任何一个白名单块都没有长度校验**——`gAMA` 按规范固定 4 字节，声明成
// 20000 字节照样放行（评审复现出前三个，第四个是回填时自己量出来的）。
// 本机复现（数字都是自己跑出来的，不是抄评审的）：往 `IEND` 之前插一个装了 20000 字节
// zlib 载荷的 `iCCP` ⇒「✅ 块序 IHDR IDAT iCCP IEND」；`tRNS` 装一段域名+邮箱 ⇒ ✅；
// `PLTE` 装 768 字节 ⇒ ✅；`gAMA` 声明 20000 字节 ⇒「✅ 31971 字节」。
// 四条全在 32 KB 上限之内 —— 也就是说体积上限一次都没被走到，是块判据自己漏的。
// 载荷是压过的，而压过的东西 `scripts/scan-secrets.sh` 一个字都读不到（见上面的档 D）。
// **也就是说具名放行让出的洞原样还在，只是从 IEND 尾随字节挪进了一个被白名单
// 祝福过的块里。** 处置是三条一起上，不是改文案：
//   ① `iCCP` / `PLTE` / `tRNS` 从白名单里删掉——三张真图（本仓 + 两个参照仓）的块序
//      都是 `IHDR IDAT IEND`，删掉零代价；且本脚本只收 colorType=6，按 PNG 规范
//      `tRNS` 在这个色彩类型下根本不该出现，`PLTE` 也只是个"建议调色板"；
//   ② 每个白名单块配长度界（`CHUNK_SIZE`），`IDAT` 是唯一的变长块；
//   ③ 补块序校验：`IHDR` 恰一个且在首、`IEND` 在末、其余块必须排在第一个 `IDAT` 之前。
//      （`IDAT` 连续性由 ③ 推出，不另设一条——两个 IDAT 之间只可能夹 IHDR/IEND/辅助块，
//      三种都已各自被判掉。多写一条恒真的判据就是一条不会红的判据。）
//
// ⚠️ **回填第 1 轮那句话仍然是假的，第 2 轮才补齐——同一个洞又挪了两个窝。**
// 上面那段自称"除了 IDAT，其余每个块的长度都被钉死"，评审复现出两条还开着的路，
// 数字都是本机自己跑出来的：
//   ⑴ **`IDAT` 里 zlib 流之后的尾随字节没人查。** `inflateSync` 在流正常结束后会
//      **静默忽略**剩下的输入（单独验过：`inflateSync(concat(deflate(src), "PAYLOAD"), {info:true})`
//      正常返回，`engine.bytesWritten` 只有 24，输入 36）。原来唯一的校验是
//      `raw.length !== height * (stride + 1)`——它只对**解压结果**的长度对账，
//      完全不管**输入**有没有被吃完。实测：把 19988 字节明文接在本仓 `docs/logo.png`
//      那个 `IDAT` 的 zlib 流后面、重算块长与 CRC ⇒ 31947 字节的文件
//      **「✅ 128×128 / 块序 IHDR IDAT IEND / 完全透明 70.1%」，七条判据一条都没被走到**。
//      容量与被判红的那条 `iCCP` 负例（31990 字节 / 20 KB 载荷）一模一样。
//      ⇒ 处置：`inflateSync(idat, { info: true })` + `engine.bytesWritten !== idat.length` 即红。
//   ⑵ **白名单块的「出现次数」没人管。** 长度界是逐块独立判的：`CHUNK_SIZE` 回答
//      "这一个块能带多少字节"，回答不了"这个类型能来几次"。实测：在第一个 `IDAT` 之前
//      插 1000 个各装 4 字节明文载荷的合法 `gAMA`（每块 16 字节开销，共 16000 字节）
//      ⇒ 27959 字节、**全绿**；换成 `sRGB`（规范固定 1 字节）插 1200 个同样全绿。
//      上限约 (32768−真图字节数)/16×4，**随真图大小变**（今天这张 20159 字节 ⇒ 约 3100 字节），
//      而且载荷可以是一段被拆散的 zlib 流。
//      ⇒ 处置：按 PNG 规范第 4.2 节，白名单里除 `IDAT` 外**全部是"至多出现一次"**的块，
//      于是把"IHDR 恰一个"推广成"非 IDAT 的块类型每种至多一次"，零代价
//      （三张真图的块序都是 `IHDR IDAT IEND`），且"IHDR 恰一个"仍是它与首块判据的合取。
// 两条的共同教训与第 1 轮是同一条：**对了一半的账等于没对账。**
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
// 同一份流程在 `CONTRIBUTING.md` 的「Replacing docs/logo.png」一节里还有一份英文的：
// 那一份是给外部贡献者看的，这一份是给改这个脚本的人看的。**两份都要改**——
// 它们不是同一句话的两处复制（一份讲判据为什么长这样，一份讲流程怎么走），
// 但第 ③ 步那条 fail-closed 的理由两边都必须在，少一边就会有人以为凭据扫描坏了。
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
  "docs/logo.png": "af6540babf42c49762c81ca1b04fdab64dafeb15900f0dae5635b44b63e82279",
});

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 允许出现的块：只有真正承载像素与画布信息的那几种。白名单外一律拒绝。
 *
 * ⚠️ **进这张表的门槛是「长度被钉死」，不是「PNG 规范认得它」**（回填第 1 轮改的判准）。
 * `iCCP` / `PLTE` / `tRNS` 三个曾经在这张表里，它们的共同点是**变长**——
 * `iCCP` 更是直接允许一段任意长度的 zlib 流。一个变长块被白名单祝福，
 * 等于把具名放行让出的那个洞原样搬进来。三者一律删除，理由见文件头 ①。
 * 唯一的例外是 `IDAT`，它的内容不是靠长度而是靠 `transparentRatio()` 里**两侧的对账**验的：
 * 解压**出来**多少（`raw.length !== height * (stride + 1)`）**与**解压**用掉**多少
 * （`engine.bytesWritten !== idat.length`）。⚠️ 第二笔账是回填第 2 轮补的——
 * 只对第一笔时，接在 zlib 流后面的 19988 字节明文是全绿的（文件头 ⑴ 有实测数字）。
 *
 * ⚠️ 这张表还有第二重约束**不在这里，而在块序那段**：白名单只回答"这个类型能不能来"，
 * 长度界只回答"这一个块能带多少字节"，**"这个类型能来几次"由那边的重复判据回答**
 * （规范第 4.2 节：这张表里除 `IDAT` 外全是"至多出现一次"的块）。三条缺一条，
 * 载荷就换个窝继续进来——第 1 轮缺长度界，第 2 轮缺次数。
 */
export const ALLOWED_CHUNKS = new Set([
  "IHDR", "IDAT", "IEND", "gAMA", "cHRM", "sRGB", "pHYs", "bKGD", "sBIT",
]);

/**
 * 每个白名单块的长度界 `[最小, 最大]`（按 PNG 规范第 11 章的固定长度写死）。
 * **`IDAT` 不在表里 —— 它是唯一允许变长的块**，上界由文件总体积 `LIMITS.maxBytes` 兜。
 *
 * 没有这张表的话删掉 `iCCP` 只是把载荷挪个窝：实测一个声明 20000 字节的 `gAMA`
 * （规范里它固定 4 字节）在补这张表之前是**全绿**的。
 * `sBIT` / `bKGD` 的长度随色彩类型变，本脚本只收 colorType=6 ⇒ 分别恰好是 4 与 6。
 */
export const CHUNK_SIZE = Object.freeze({
  IHDR: [13, 13],
  IEND: [0, 0],
  gAMA: [4, 4],
  cHRM: [32, 32],
  sRGB: [1, 1],
  pHYs: [9, 9],
  sBIT: [4, 4],
  bKGD: [6, 6],
});

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
   * ⚠️ **本机实测的三张真图是 0.504 / 0.688 / 0.639**（两个参照仓 + 本仓这张；
   * 前两个数是立这条线时拿参照仓那两张量的，第三个数随本仓换图而变 —— 换图要重量；
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
function transparentRatio(idat, width, height, fail) {
  // ⚠️ **两笔账，缺一笔就等于没对账**（回填第 2 轮补的第二笔，理由见文件头 ⑴）：
  // `inflateSync` 在 zlib 流正常结束后会**静默忽略后面所有输入字节**，所以
  // "解压出来多少"对上了，完全不能推出"输入有没有被吃完"。`{ info: true }` 让它
  // 连同 `engine` 一起返回，`engine.bytesWritten` = 被喂进去并真正消费掉的输入字节数
  //（本机验过：干净流 `bytesWritten === 输入长度`，带尾随时严格小于）。
  // 这一条必须落在解压这一步、且在返回 ratio 之前——`IDAT` 是本文件唯一变长的块，
  // 它的 zlib 流之后就是最后一个还能自由写字节的口袋。
  const { buffer: raw, engine } = inflateSync(idat, { info: true });
  if (engine.bytesWritten !== idat.length) {
    fail(`IDAT 的 zlib 流在第 ${engine.bytesWritten} 字节就结束了，后面还有 ${idat.length - engine.bytesWritten} 字节没被解码`
      + " —— 那是一个能自由写字节的口袋：zlib 解压在流结束后会静默忽略剩下的输入，"
      + "而「解压出来多少」与「解压用掉多少」是两笔账，只对前一笔等于没对账");
  }
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) {
    fail(`解压后的像素数据是 ${raw.length} 字节，按 ${width}×${height} RGBA 算应该是 ${height * (stride + 1)} 字节`);
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
        default: fail(`第 ${y} 行的行过滤器是 ${ft}，PNG 只定义了 0..4`);
      }
    }
    for (let x = 3; x < stride; x += bpp) if (cur[x] === 0) transparent++;
    cur.copy(prev);
  }
  return transparent / (width * height);
}

/**
 * 逐字节审一个 PNG。**不满足任何一条就 throw**，报文里带上是哪一条不满足
 * ——十一条负例各自命中不同分支这件事由 `tests/unit/check-png.test.ts` 的
 * 「十一条负例的报文两两不同 —— 不是一把梭」钉着。
 */
export function auditPng(path, buf = readFileSync(path)) {
  const fail = (msg) => { throw new Error(`${path}: ${msg}`); };

  if (!buf.subarray(0, 8).equals(SIGNATURE)) fail("不是 PNG（头 8 字节的签名不符）");

  const chunks = [];
  const sizes = [];
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
    sizes.push(len);
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

  // ── 长度界：`IDAT` 之外的每个块都被钉死 ────────────────────────────────────
  // 白名单只回答"这个类型能不能来"，回答不了"它能带多少字节进来"。
  // 少了这一条，删掉 `iCCP` 只是把载荷挪进 `gAMA`：一个声明 20000 字节的 `gAMA`
  // （规范里固定 4 字节）在补这条判据之前是全绿的，实测过。
  for (let i = 0; i < chunks.length; i++) {
    const bound = CHUNK_SIZE[chunks[i]];
    if (bound === undefined) continue; // 只有 IDAT 落到这儿：它靠解压后逐字节对账，不靠长度
    const [lo, hi] = bound;
    if (sizes[i] < lo || sizes[i] > hi) {
      fail(`块 ${chunks[i]} 的长度是 ${sizes[i]} 字节，PNG 规范里它${lo === hi ? `固定 ${lo}` : `只能是 ${lo}..${hi}`} 字节`
        + " —— 一个超长的定长块就是一个能自由写字节的口袋");
    }
  }

  // ── 块序：辅助块一律排在像素之前 ───────────────────────────────────────────
  // 规范原文（第 5.6 节）：`PLTE` 与绝大多数辅助块必须排在第一个 `IDAT` 之前。
  // `IHDR IDAT gAMA IEND` 这种排法真解码器会拒，而没有这条判据时本脚本照收——
  // 那正是"看起来一切正常的图后面接了点东西"最容易伪装的位置。
  // ⚠️ **`IDAT` 连续性不另设一条**：两个 `IDAT` 之间只可能夹 `IHDR`（下面那条判掉）、
  // `IEND`（解析到它就 break，多出来的字节走尾随判据）或辅助块（这条判掉），
  // 所以连续性是这三条的推论。再写一条只会得到一条永远不会红的判据。
  // ⚠️ **「IHDR 恰一个」在回填第 2 轮被推广成了一条通用规则**（理由见文件头 ⑵）：
  // 长度界是**逐块独立**判的，它回答不了"这个类型能来几次"——实测 1000 个各装 4 字节
  // 载荷的合法 `gAMA`（每块 16 字节开销）在补这条判据之前是全绿的，
  // 一千个瘦块拼起来和一个超长胖块是同一个口袋。按 PNG 规范第 4.2 节，
  // 这张白名单里除 `IDAT` 外**全部是"至多出现一次"**的块，所以这条判据零代价：
  // 三张真图（本仓 + 两个参照仓）的块序都是 `IHDR IDAT IEND`。
  // 「IHDR 恰**一**个」不因此丢失：它 = 这条（至多一个）∧ 上面那条首块必须是 IHDR（至少一个）。
  const dup = chunks.filter((t) => t !== "IDAT").find((t, i, a) => a.indexOf(t) !== i);
  if (dup !== undefined) {
    fail(`${dup} 出现了 ${chunks.filter((t) => t === dup).length} 次 —— 按 PNG 规范第 4.2 节，`
      + "除 IDAT 外每种块至多只能出现一次；一千个长度合法的瘦块拼起来，和一个超长的胖块是同一个口袋");
  }
  const firstIdat = chunks.indexOf("IDAT");
  for (let i = firstIdat + 1; i < chunks.length; i++) {
    if (chunks[i] !== "IDAT" && chunks[i] !== "IEND") {
      fail(`块 ${chunks[i]} 排在第一个 IDAT 之后（块序 ${chunks.join(" ")}）`
        + " —— PNG 规范要求辅助块排在像素数据之前，真解码器会拒这份文件");
    }
  }

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

  const ratio = transparentRatio(Buffer.concat(idat), width, height, fail);
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
