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
 *   一把梭（无论什么输入都吐同一句话）在计数上与"五条都红"是分不清的；
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

/** 五条负例的构造：名字 → [文件名, 字节, 报文里必须出现的那句话]。 */
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
];

describe("scripts/check-png.mjs：五条负例各自红", () => {
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
   * **这一格是上面五格的前提，不是重复**：五条都红、但五句话一模一样的话，
   * 判据完全可能只是"对任何输入都红"，而计数上看不出区别。这里要求报文两两不同。
   */
  it("五条负例的报文两两不同 —— 不是一把梭", () => {
    const messages = NEGATIVES.map(([, make]) => {
      let out = "";
      withTempFile("logo.png", make(), (p) => { out = run([p]).stderr; });
      // 临时目录名每次都不一样，比对前把路径那一段去掉，只留判据自己说的话。
      return out.replace(/\/tmp\/[^\s:]+/g, "<路径>");
    });
    expect(new Set(messages).size, `五条负例只吐出了 ${new Set(messages).size} 种报文：\n${messages.join("\n---\n")}`)
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

  it("放行的路径与被审的路径是同一批：名册里每一条都真的在 docs/ 下存在", () => {
    // 这一格与上面「名册里登记着、仓里却没有 ⇒ 红」是两件事：那一格测脚本的行为，
    // 这一格测**真仓今天的状态**——名册不许留幽灵条目。
    const out = execFileSync("node", ["-e",
      "import('./scripts/check-png.mjs').then(m => console.log(Object.keys(m.REGISTERED_BINARIES).join('\\n')))",
    ], { encoding: "utf8" }).trim();
    const paths = out.split("\n").filter((s) => s !== "");
    expect(paths.length, "名册空了 —— 空名册会让这道门禁静静地什么都不审").toBeGreaterThan(0);
    for (const p of paths) {
      expect(() => readFileSync(resolve(p)), `名册里登记的 ${p} 不在仓里`).not.toThrow();
    }
  });
});
