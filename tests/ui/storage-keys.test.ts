import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  KEY_STORE, SAVED_AT_STORE, SECTION_STORE, THEME_STORE, LANG_STORE, DEBUG_STORE, GW_KEY_STORE,
} from "../../admin-ui/js/pure/storage-keys.mjs";

/**
 * **浏览器存储键名的单一真源**（全分支评审 C4）。
 *
 * 被守护的性质来自一个实测的失效：`agnes2api_admin_key` 与
 * `agnes2api_admin_key_at` 原来在 `js/app.js`（写入方）与 `js/api.js`（读取方）
 * **各声明一遍**。把写入方那一处改掉 ⇒ 登录成功、进壳层，随后每个请求送出去的
 * `x-admin-key` 都是空串 ⇒ 401 ⇒ 登出循环，**面板彻底不可用**，
 * 而当时 1357/1357 条用例全绿。
 *
 * 下面第二格才是真正把这件事变成不可能的那一格：**除 `js/boot.js` 外，
 * `admin-ui/` 下任何文件都不许再出现 `agnes2api_` 开头的字面量。**
 * 只断言"这个模块导出了这几个常量"是形状断言，拦不住有人在别处再写一遍。
 */
const MODULE_FILE = "admin-ui/js/pure/storage-keys.mjs";
const BOOT_FILE = "admin-ui/js/boot.js";
const ALL_KEYS = {
  KEY_STORE, SAVED_AT_STORE, SECTION_STORE, THEME_STORE, LANG_STORE, DEBUG_STORE, GW_KEY_STORE,
};

function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(html|js|mjs)$/.test(p) ? [p] : [];
  });
}

describe("面板存储键名：单一真源", () => {
  /**
   * 反向自检先行：键名本身必须都还长着 `agnes2api_` 前缀，否则下面那条扫描的
   * needle 就与真实写法脱节，扫不到任何东西也会"全绿"。
   */
  it("七个键名都带 agnes2api_ 前缀，且互不相同", () => {
    const values = Object.values(ALL_KEYS);
    for (const [name, v] of Object.entries(ALL_KEYS)) {
      expect(v, `${name} 不像一个面板存储键`).toMatch(/^agnes2api_/);
    }
    expect(new Set(values).size, "有两个常量取了同一个键名").toBe(values.length);
    // **手写的条数锚**：上面那两条断言在「有人把某个常量从 `ALL_KEYS` 里删掉」时
    // 一样是绿的——少一项，下面那条扫描就少查一个名字，而扫描本身照常报 `[]`。
    // P3d Task 10 新增 `GW_KEY_STORE` ⇒ **6 → 7**。
    expect(values.length, "键的条数变了：新增/删除存储键时回来表态").toBe(7);
  });

  /**
   * **两把钥匙的存储键必须是两个不同的名字**（P3d Task 10，设计 §10.5）。
   *
   * 上面那条「互不相同」已经覆盖了这一对，这一格单独把它拎出来是因为**这两个的
   * 后果与别的键完全不同级**：管理口令进的是 `x-admin-key` 那条路，网关口令是发给
   * **每一个下游用户**的那把中转口令。两者共用一个键的话，面板登录一次就会把
   * Playground 那格里的中转口令覆盖掉（或者反过来），而两条路径都不会报任何错。
   *
   * ⚠️ **前缀关系同样不许有**：`agnes2api_admin_key` 与 `agnes2api_admin_key_at`
   * 已经是一对前缀关系（那一对是刻意的，两个键一起写一起清）。再加一个恰好以
   * 管理口令键为前缀的名字，将来任何一次「按前缀批量清理」都会把它一起带走。
   */
  it("网关口令与管理口令是两个不同的存储键，且互不构成前缀 —— 共用一个键会让登录一次就覆盖掉中转口令", () => {
    expect(GW_KEY_STORE).not.toBe(KEY_STORE);
    expect(GW_KEY_STORE.startsWith(KEY_STORE), "网关口令键以管理口令键为前缀").toBe(false);
    expect(KEY_STORE.startsWith(GW_KEY_STORE), "管理口令键以网关口令键为前缀").toBe(false);
    // 期望值手写字面量，**不从常量推导**（第 6 种假阳性）。
    expect(KEY_STORE).toBe("agnes2api_admin_key");
    expect(GW_KEY_STORE).toBe("agnes2api_gw_key");
  });

  /**
   * **除 `js/boot.js` 外，任何文件都不许再写 `agnes2api_` 字面量。**
   *
   * `boot.js` 是全站唯一的经典脚本（`<head>` 里同步、非 module），**经典脚本没有
   * `import`**，所以主题与语言那两个名字在它里面必然是字面量——这是结构性的豁免，
   * 由下面那一格逐字比对兜住，不是"忘了改"。
   */
  it("除 boot.js 外没有任何文件再写 agnes2api_ 字面量", () => {
    const offenders: string[] = [];
    for (const p of walk("admin-ui")) {
      const rel = p.split("\\").join("/");
      if (rel === MODULE_FILE || rel === BOOT_FILE) continue;
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/["'`](agnes2api_[A-Za-z0-9_]*)["'`]/g)) {
        offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(offenders, `键名要从 ${MODULE_FILE} import，别在这些地方再写一遍`).toEqual([]);
  });

  /**
   * `boot.js` 抄不了那个模块，所以它抄下来的那两个字面量必须**逐字**与模块一致。
   * 这一格是那条结构性豁免的全部代价：改模块里的名字而忘了改 boot.js（或反过来），
   * 后果是主题闪白 / 语言复原失效，而两边各自都"自洽"。
   */
  it("boot.js 里必然重复的那两个字面量与模块逐字相同", () => {
    const boot = readFileSync(BOOT_FILE, "utf8");
    expect(boot, "boot.js 读的主题键与 THEME_STORE 不一致").toContain(`"${THEME_STORE}"`);
    expect(boot, "boot.js 读的语言键与 LANG_STORE 不一致").toContain(`"${LANG_STORE}"`);
    // 反向：boot.js 只许出现这两个，多出来的说明它又自己加了一个键。
    const inBoot = [...boot.matchAll(/["'](agnes2api_[A-Za-z0-9_]*)["']/g)].map((m) => m[1]!).sort();
    expect([...new Set(inBoot)], "boot.js 里出现了模块之外的存储键").toEqual(
      [THEME_STORE, LANG_STORE].sort(),
    );
  });

  /**
   * 写入方（`app.js`）与读取方（`api.js`）**必须从同一个模块拿键名**。
   * 上面那条扫描已经保证了"没人再写字面量"，这一条保证"它们确实读了这个模块"
   * ——两条合起来才排除掉「谁也没写字面量，但其中一方压根没用这些键」。
   */
  it("写入方与读取方都从这个模块 import 那两个凭据键", () => {
    for (const f of ["admin-ui/js/app.js", "admin-ui/js/api.js"]) {
      const src = readFileSync(f, "utf8");
      const m = /import\s*\{([^}]*)\}\s*from\s*"\.\/pure\/storage-keys\.mjs"/.exec(src);
      expect(m, `${f} 没有从 storage-keys.mjs import`).not.toBeNull();
      const named = m![1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim());
      expect(named, `${f} 没有拿口令键`).toContain("KEY_STORE");
      expect(named, `${f} 没有拿时刻键`).toContain("SAVED_AT_STORE");
    }
  });
});
