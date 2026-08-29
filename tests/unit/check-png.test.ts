import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const SCRIPT = resolve("scripts/check-png.mjs");
const REAL_LOGO = resolve("docs/logo.png");

/**
 * **`scripts/check-png.mjs` 是一道补偿判据**：`scripts/check-no-binary.mjs` 对
 * `docs/logo.png` 开了一个具名放行，"这个文件里藏没藏东西"从此没人回答，这个脚本接手。
 * 所以这份测试要证的不是"它能跑"，而是两件相反的事：
 * · **该红时红，而且各自为不同的理由红**——报文互不相同这一条单独占一格，
 *   一把梭（无论什么输入都吐同一句话）在计数上与"十一条都红"是分不清的；
 * · **不乱红**——三张真正合规的图必须绿。少了这一侧，"永远红"也能拿满分。
 *
 * ⚠️ **阳性对照为什么是"本仓真图 + 两张合成图"，而不是两个参照仓的真图**（如实登记）：
 * 判据的原型验收是拿 kiro2api / gemini2api 的 `docs/logo.png` 跑的，两张都绿
 * （实测数据抄在 `scripts/check-png.mjs` 的透明度下限那段注释里）。但那两张图
 * **进不了本仓**：它们是别人仓库的二进制产物，而且任何一个二进制文件落在 `tests/`
 * 下都会被 `scripts/check-no-binary.mjs` 当场判红（那道门禁的射程含 `tests/`）。
 * ⇒ 常驻档改成"按那两张真图**实测出来的透明度**合成两张等价的图"，
 * 其中一张刻意压到 0.504——那正是两张真图里更贴近下限的那一张的实测值，
 * 它守的是"这条下限没有被抬到真实样本之上"。
 */

/** PNG 的 CRC-32。**这里刻意自己写一遍**，不从被测脚本 import：期望侧与实际侧共用一份实现，
 *  实现错了两边一起错，判据就成了同义反复。 */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 合成一张 8 位 RGBA 非隔行 PNG：前 `transparentPixels` 个像素 alpha=0，其余不透明。
 * 行过滤器一律 0（None）——被测脚本的解码路径要能吃下 0..4，这里只用得到 0，
 * 别的过滤器由本仓那张真图（PIL 出的，用的是 Paeth 等）在阳性对照里覆盖到。
 */
function synthPng(width: number, height: number, transparentPixels: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const opaque = i >= transparentPixels;
      raw[p++] = opaque ? 0x33 : 0;
      raw[p++] = opaque ? 0x88 : 0;
      raw[p++] = opaque ? 0xcc : 0;
      raw[p++] = opaque ? 0xff : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function run(args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function withTempFile(name: string, bytes: Buffer, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-png-"));
  try {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const realLogo = (): Buffer => readFileSync(REAL_LOGO);

/** `IEND` 块（长度 0 + 类型 + CRC，共 12 字节）在文件末尾的起点。 */
const iendStart = (buf: Buffer): number => buf.length - 12;

/**
 * 第一个 `IDAT` 块的起点。**走一遍块表算出来，不写死偏移**——写死 33
 * （= 8 字节签名 + 12 + 13 的 IHDR）会在换图那天静静指到别处。
 */
function firstIdatStart(buf: Buffer): number {
  // ⚠️ 这里刻意用字节算术而不是 `buf.readUInt32BE` / `buf.toString("ascii", …)`：
  // 本仓 tsconfig 的 `types` 里 `@cloudflare/workers-types` 排在 `node` 之前，
  // 全局 `Buffer` 解析到的是 workers 那份**子集**声明，那两个方法在类型上不存在
  // （`pnpm typecheck` 会报 TS2339 / TS2554，实测过）。
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = (buf[off]! * 0x1000000) + (buf[off + 1]! << 16) + (buf[off + 2]! << 8) + buf[off + 3]!;
    const type = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!);
    if (type === "IDAT") return off;
    off += 12 + len;
  }
  throw new Error("这份 PNG 里没有 IDAT —— 测试数据坏了");
}

const insertAt = (buf: Buffer, at: number, blk: Buffer): Buffer =>
  Buffer.concat([buf.subarray(0, at), blk, buf.subarray(at)]);

/**
 * 确定性的"压不动"字节。**装 iCCP 载荷那条负例需要它**：载荷若用 `Buffer.alloc(n, 0x41)`，
 * zlib 一压只剩几十字节，那条负例就只证明了"iCCP 被拒"，证不了
 * "一个 iCCP 能装下多大的东西"。用 LCG 出的噪声压完还是 20 KB 上下，
 * 而合成出来的文件仍在 32 KB 上限之内——**这一点很要紧**：它保证那条负例
 * 是被块类型判据接住的，不是被体积上限顺手挡下的。
 */
function noise(n: number): Buffer {
  const b = Buffer.alloc(n);
  let s = 0x2545f491;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    b[i] = (s >>> 16) & 0xff;
  }
  return b;
}

/** 十一条负例的构造：名字 → [文件名, 字节, 报文里必须出现的那句话]。 */
const NEGATIVES: ReadonlyArray<readonly [string, () => Buffer, string]> = [
  [
    "IEND 之后追加一段尾随字节（最常见的藏法：图一字未动，东西全接在后面）",
    // 这段载荷刻意选"私有域名 + 邮箱"这种形态：`scripts/scan-secrets.sh` 的六条规则
    // 对它一个字都读不到（本机实测），所以它恰恰是这道补偿判据要接住的那一类。
    () => Buffer.concat([realLogo(), Buffer.from("gw.internal-example.invalid ops@internal-example.invalid")]),
    "IEND 之后还有",
  ],
  [
    "塞一个 tEXt 块（能装任意字节，凭据唯一藏得住的地方）",
    () => {
      const b = realLogo();
      const text = chunk("tEXt", Buffer.concat([Buffer.from("Comment\0", "latin1"), Buffer.from("anything at all")]));
      return Buffer.concat([b.subarray(0, iendStart(b)), text, b.subarray(iendStart(b))]);
    },
    "含被禁块 tEXt",
  ],
  [
    "IDAT 里翻掉一个字节（CRC 跟着对不上）",
    () => {
      const b = Buffer.from(realLogo());
      b[200] = b[200]! ^ 0xff;
      return b;
    },
    "CRC 不符",
  ],
  [
    "尺寸换成 256×256（其余一切合规，连透明度都满分）",
    () => synthPng(256, 256, 256 * 256),
    "尺寸是 256×256",
  ],
  [
    "一整块不透明的贴片：完全透明像素 0%",
    () => synthPng(128, 128, 0),
    "低于下限",
  ],
  // ── 以下四条是回填第 1 轮补的：块白名单曾经放行三个变长块、一个块都不校验长度、块序完全没判 ──
  [
    "塞一个装了 20 KB zlib 载荷的 iCCP —— 而且放在规范允许的位置（IDAT 之前），块序完全合法",
    // 这条负例的分量在于**它一度是全绿的**：`iCCP` 曾在白名单上，
    // 载荷是压过的、`scripts/scan-secrets.sh` 一个字读不到（文件头档 D 实测），
    // 位置又合规到真解码器都挑不出毛病。它就是具名放行让出的那个洞本身，
    // 只不过从 `IEND` 尾随字节挪进了一个被祝福过的块里。
    () => {
      const b = realLogo();
      const iccp = chunk("iCCP", Buffer.concat([
        Buffer.from("p\0", "latin1"), Buffer.from([0]), deflateSync(noise(20000)),
      ]));
      return insertAt(b, firstIdatStart(b), iccp);
    },
    "含未登记块 iCCP",
  ],
  [
    "塞一个声明 20000 字节的 gAMA —— 类型在白名单上、位置也合法，只是规范里它固定 4 字节",
    // 只删 `iCCP` 是不够的：白名单回答的是"这个类型能不能来"，回答不了
    // "它能带多少字节进来"。补长度界之前这一条同样是全绿的（实测 31971 字节）。
    () => {
      const b = realLogo();
      return insertAt(b, firstIdatStart(b), chunk("gAMA", noise(20000)));
    },
    "块 gAMA 的长度是 20000 字节",
  ],
  [
    "把一个长度合法的 pHYs 挪到 IDAT 之后（`IHDR IDAT pHYs IEND` 这种块序真解码器会拒）",
    // 这一条钉的是块序判据，所以刻意用一个**在白名单上、长度也对**的块：
    // 换成 `iCCP` 的话红的会是白名单那条，块序判据一格都没被走到。
    () => {
      const b = realLogo();
      return insertAt(b, iendStart(b), chunk("pHYs", Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])));
    },
    "排在第一个 IDAT 之后",
  ],
  [
    "复制一份 IHDR 塞在原 IHDR 之后 —— 位置合法、长度合法，就是多了一个",
    // 这一条钉的是「IHDR 恰一个」。**它不是为了拦载荷**（IHDR 固定 13 字节，装不下什么），
    // 是因为块序判据只管"第一个 IDAT 之后"，管不到两个 IHDR 都在 IDAT 之前的排法。
    // 写下一条判据就得配一条会红的输入，否则那条判据只是句好听的话。
    // ⚠️ 回填第 2 轮把这条判据推广成了"非 IDAT 的块类型每种至多一次"，它没有变松：
    // 报文从「IHDR 出现了 2 次 —— 一份 PNG 只能有一个 IHDR」换成了同样以
    // 「IHDR 出现了 2 次」开头的通用句，所以下面这个 needle 一字未动仍然接得住。
    // 下一条负例（gAMA × 1000）钉的是推广出去的那一半。
    () => {
      const b = realLogo();
      const at = firstIdatStart(b);
      return insertAt(b, at, b.subarray(8, at));
    },
    "IHDR 出现了 2 次",
  ],
  // ── 以下两条是回填第 2 轮补的：IDAT 里 zlib 流之后的尾随字节没人查、块的出现次数没人管 ──
  [
    "把 20 KB 明文接在 IDAT 的 zlib 流后面（块长与 CRC 都重算过，块序仍是 IHDR IDAT IEND）",
    // **这一条一度是全绿的，而且是七条判据一条都没被走到的那种全绿**：
    // 块序合法、CRC 对、31947 字节在 32 KB 上限之内、透明度 70.1%。
    // 原因是解压那一步只对了**解压出来多少**这一笔账（`raw.length`），
    // 没对**解压用掉多少**——`inflateSync` 在 zlib 流结束后会静默吃掉后面所有字节。
    // 容量与上面那条 iCCP 负例（20 KB）一模一样，也就是说洞只是从块里挪进了块内的流尾。
    // 载荷刻意用"邮箱形态的明文"：`scripts/scan-secrets.sh` 对二进制里的这一类一个字读不到。
    () => {
      const b = realLogo();
      const at = firstIdatStart(b);
      const len = (b[at]! * 0x1000000) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
      const zlib = b.subarray(at + 8, at + 8 + len);
      const payload = Buffer.from("ops@internal-example.invalid ".repeat(714)); // ≈20 KB 明文
      return Buffer.concat([
        b.subarray(0, at),
        chunk("IDAT", Buffer.concat([zlib, payload])),
        b.subarray(at + 12 + len),
      ]);
    },
    "没被解码",
  ],
  [
    "在 IDAT 之前插 1000 个各装 4 字节载荷的合法 gAMA —— 每一个的类型、长度、位置都挑不出毛病",
    // 这一条钉的是**出现次数**，所以刻意让每个块都完全合规（`gAMA` 规范固定 4 字节，
    // 这里就装 4 字节）：长度界是逐块独立判的，它回答不了"这个类型能来几次"。
    // 1000 × 16 字节开销 + 11959 = 27959 字节，**在 32 KB 上限之内**——
    // 这一点是这条负例的分量所在：它必须被重复判据接住，不是被体积上限顺手挡下。
    () => {
      const b = realLogo();
      const at = firstIdatStart(b);
      const blocks: Buffer[] = [];
      for (let i = 0; i < 1000; i++) blocks.push(chunk("gAMA", Buffer.from("a@b.invalid".slice(i % 8, (i % 8) + 4))));
      return Buffer.concat([b.subarray(0, at), ...blocks, b.subarray(at)]);
    },
    "gAMA 出现了 1000 次",
  ],
];

describe("scripts/check-png.mjs：十一条负例各自红", () => {
  it.each(NEGATIVES.map((n, i) => [i, n[0], n[1], n[2]] as const))(
    "负例 %i：%s",
    (_i, _name, make, needle) => {
      withTempFile("logo.png", make(), (p) => {
        const r = run([p]);
        expect(r.status, `这份字节应该被判红，实际 exit ${r.status}\nstdout: ${r.stdout}`).toBe(1);
        expect(r.stderr, `报文没说到点子上：\n${r.stderr}`).toContain(needle);
      });
    },
  );

  /**
   * **这一格是上面十一格的前提，不是重复**：十一条都红、但十一句话一模一样的话，
   * 判据完全可能只是"对任何输入都红"，而计数上看不出区别。这里要求报文两两不同。
   */
  it("十一条负例的报文两两不同 —— 不是一把梭", () => {
    const messages = NEGATIVES.map(([, make]) => {
      let out = "";
      withTempFile("logo.png", make(), (p) => { out = run([p]).stderr; });
      // 临时目录名每次都不一样，比对前把路径那一段去掉，只留判据自己说的话。
      return out.replace(/\/tmp\/[^\s:]+/g, "<路径>");
    });
    expect(new Set(messages).size, `十一条负例只吐出了 ${new Set(messages).size} 种报文：\n${messages.join("\n---\n")}`)
      .toBe(NEGATIVES.length);
  });
});

describe("scripts/check-png.mjs：阳性对照 —— 判据既不过紧也不同义反复", () => {
  it("本仓真图 docs/logo.png（PIL 出的，行过滤器不止一种）：绿", () => {
    const r = run([REAL_LOGO]);
    expect(r.status, `真图被判红了：\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("128×128");
  });

  it.each([
    ["kiro2api 那张真图实测的透明度 50.4%（更贴近下限的那一张）", 0.504],
    ["gemini2api 那张真图实测的透明度 68.8%", 0.688],
  ])("合成一张 %s 的 128×128 图：绿", (_label, ratio) => {
    const total = 128 * 128;
    const bytes = synthPng(128, 128, Math.round(total * ratio));
    withTempFile("logo.png", bytes, (p) => {
      const r = run([p]);
      expect(r.status, `一张合规的图被判红了 —— 判据过紧：\n${r.stderr}`).toBe(0);
    });
  });

  it("透明度下限刚好卡在真实样本的下方：50.4% 绿、49.9% 红（这条线不是随便画的）", () => {
    const total = 128 * 128;
    withTempFile("a.png", synthPng(128, 128, Math.round(total * 0.504)), (p) => {
      expect(run([p]).status, "真实样本那一档被判红 ⇒ 下限抬得比现实还高").toBe(0);
    });
    withTempFile("b.png", synthPng(128, 128, Math.round(total * 0.499)), (p) => {
      const r = run([p]);
      expect(r.status, "低于下限却放行 ⇒ 这条线根本没在判").toBe(1);
      expect(r.stderr).toContain("低于下限");
    });
  });
});

describe("scripts/check-png.mjs：名册（路径 → sha256）这一档", () => {
  /** 造一个只有 `docs/` 的临时目录，让脚本按名册去那儿找 `docs/logo.png`。 */
  function tempRepo(fill?: (docs: string) => void): string {
    const dir = mkdtempSync(join(tmpdir(), "a2a-png-repo-"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    fill?.(join(dir, "docs"));
    return dir;
  }

  it("不带参数 = CI 那一档：按名册审真仓里那张图，绿", () => {
    const r = run([]);
    expect(r.status, `名册档在真仓上就红了：\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("docs/logo.png");
  });

  it("换了一张结构完全合规、但不是登记那张的图 ⇒ 红在 sha256 上", () => {
    const dir = tempRepo((docs) => writeFileSync(join(docs, "logo.png"), synthPng(128, 128, 128 * 128)));
    try {
      const r = run([], dir);
      expect(r.status, "换了图却照样绿 ⇒ 登记值没在判").toBe(1);
      expect(r.stderr).toContain("sha256 与登记值不符");
      expect(r.stderr, "报文没告诉人换图之后该做什么").toContain("重跑凭据扫描");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("名册里登记着、仓里却没有 ⇒ 红（不是「没什么要审的」）", () => {
    const dir = tempRepo();
    try {
      const r = run([], dir);
      expect(r.status, "文件不见了却照样绿 —— 那是这道门禁最坏的死法").toBe(1);
      expect(r.stderr).toContain("读不到");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/check-png.mjs 与 scripts/check-no-binary.mjs 的咬合", () => {
  /**
   * 具名放行的名册只有一份（`REGISTERED_BINARIES`），`scripts/check-no-binary.mjs`
   * 是 import 过去的，不是手抄。**这一格钉的就是"没有第二份手抄"**：
   * 哪天有人在那边另写一个字面量清单，这里会红。
   */
  it("check-no-binary 的放行清单是 import 来的，不是在那边手抄的第二份", () => {
    const src = readFileSync(resolve("scripts/check-no-binary.mjs"), "utf8");
    expect(src, "放行清单不再从 scripts/check-png.mjs 取 ⇒ 两份真源，迟早静静对不上")
      .toContain('import { REGISTERED_BINARIES } from "./check-png.mjs";');
    expect(src.match(/"docs\/logo\.png"/g), "那边出现了写死的字面路径 —— 名册只该有一份")
      .toBeNull();
  });

  it("ci.yml 里真的跑了这个脚本 —— 判据再好，没被跑到就是零", () => {
    const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/run:\s*node scripts\/check-png\.mjs\s*$/m);
  });

  it("名册整份恰好是 [docs/logo.png] —— 往里加一行就等于把放行扩到别处", () => {
    // ⚠️ **这一格在回填第 1 轮之前是「差一点就是守卫」的形态**，如实记下来：
    // 它当时的名字承诺「名册里每一条都真的在 docs/ 下存在」，断言体却只是
    // `readFileSync(resolve(p))` 不抛——**任何目录下的任何一个存在的文件都能过**。
    // 实测：`cp docs/logo.png src/backdoor.png` 再往名册里加一行它的 sha256 ⇒
    // `check-no-binary` 绿、这份测试 16 格一格不吵。而 `CONTRIBUTING.md` 明写着
    // 「`docs/logo.png` 是 src/ tests/ admin-ui/ scripts/ docs/ 下**唯一**被允许的二进制文件」。
    // 一条被公开承诺、却没有任何判据会为它变红的不变量，按本仓的话说不是守卫，是待办。
    //
    // 改法是**从真源现算整份名册再整体相等**，不是逐条做存在性检查：
    // 逐条检查的射程是「这一条没烂」，整体相等的射程才是「只有这一条」。
    const out = execFileSync("node", ["-e",
      "import('./scripts/check-png.mjs').then(m => console.log(Object.keys(m.REGISTERED_BINARIES).join('\\n')))",
    ], { encoding: "utf8" }).trim();
    const paths = out.split("\n").filter((s) => s !== "");
    expect(
      paths,
      "名册被扩过了 —— 具名放行的前提就是它只有这一个字面路径。"
      + "要再放行一个二进制文件，先去改 CONTRIBUTING.md 里那句「唯一」，"
      + "并回答清楚谁来替新那份回答「这个文件里藏没藏东西」。",
    ).toEqual(["docs/logo.png"]);
    // 名册不许留幽灵条目：登记了却不在仓里同样是烂名册。
    // （这一格与上面「名册里登记着、仓里却没有 ⇒ 红」是两件事：那一格测脚本的行为，
    //   这一格测**真仓今天的状态**。）
    expect(() => readFileSync(resolve(paths[0]!)), `名册里登记的 ${paths[0]} 不在仓里`).not.toThrow();
  });
});
