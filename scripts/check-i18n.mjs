#!/usr/bin/env node
/*
 * i18n 门禁。设计文档 §9.1 的七条断言里，**六条在这里**，第六条（TendFailureReason
 * 穷尽）在 tests/unit/i18n-dict.test.ts —— 联合类型是编译期的，node 脚本枚举不出来，
 * 拿正则去解析 TS 源码只会得到一条随格式变化悄悄失效的断言，而那正是本项目最怕的形态。
 * **这条边界写在这里，不写成「本脚本覆盖全部七条」。**
 *
 * 与那份测试**故意是两份独立实现**：CI 第 5 道跑这个脚本、第 8 道跑那份测试，
 * 两者用不同代码路径回答同一批问题，其中一份写错时另一份会不同意。
 *
 * ⚠️ **第 ⑧ 条（带占位符的 key 不许当裸标签用）是 P3b Task 7 新加的，设计文档
 * §9.1 里没有它，而且它今天**只有这一份实现**（tests/unit/i18n-dict.test.ts 里
 * 没有对应的一条）。** 之所以还是加上：它是阶段验收的人工冒烟真抓出来的一个
 * 已上线缺陷（详见下面第 ⑧ 条的说明），而前六条一条都拦不住。
 * 单实现这件事如实写在这里，别读成「和前六条一样有两份互为印证」。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"];
const BANNED = [
  "推荐", "推薦", "建议", "建議", "默认", "預设", "預設", "主流", "首选", "首選", "优先", "優先",
  "recommended", "preferred", "default",
  "おすすめ", "推奨", "권장", "기본",
];
const IP_PORT = /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{2,5}/;

const { I18N } = await import(pathToFileURL(join(ROOT, "admin-ui/js/i18n-dict.js")).href);

function walk(dir) {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(html|js|mjs)$/.test(p) ? [p] : [];
  });
}

const errors = [];
const warnings = [];

// ① 源码里引用的每个 key 都在字典里
const used = new Set();
for (const p of walk(join(ROOT, "admin-ui"))) {
  const src = readFileSync(p, "utf8");
  for (const m of src.matchAll(/data-i18n(?:-ph|-title)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bt\("([^"]+)"/g)) used.add(m[1]);
}
// ⚠️ 门槛不是设计文档写的 20：本期（Task 3）只铺框架骨架，字面引用一共 18 处，
// 见 tests/unit/i18n-dict.test.ts 对应断言的同一条注释。这里改成 15，与那份测试
// 用同一个数字，避免「同一件事两处写两个门槛」自己先漂移。
//
// ⚠️ **比较符也要与那份测试一致，不只是数字一致**：这里是 `< 15` 才报错（15 本身
// 通过），那份测试对应写的是 `toBeGreaterThanOrEqual(15)`（同样 15 本身通过）。
// 两处一度分别写成 `< 15` 与 `toBeGreaterThan(15)`，在 `used.size === 15` 这个
// 精确边界上会永久一绿一红，破坏「两份独立实现互为印证」的设计意图——已订正。
if (used.size < 15) errors.push(`只扫到 ${used.size} 个 i18n 引用，扫描本身可能坏了`);
for (const k of [...used].sort()) if (!(k in I18N)) errors.push(`引用了字典里没有的 key: ${k}`);

// ② 每个 key 都有全部 5 种语言且非空；③ 没有多余语言码
for (const [k, row] of Object.entries(I18N)) {
  for (const lang of LANGS) {
    const v = row[lang];
    if (typeof v !== "string" || v.trim() === "") errors.push(`${k} 缺 ${lang}`);
  }
  for (const lang of Object.keys(row)) {
    if (!LANGS.includes(lang)) errors.push(`${k} 有多余的语言码 ${lang}（拼错的语言码永远取不到）`);
  }
}

// ④ 字典里没被引用的 key ⇒ **警告不报错**（动态拼接的 key 抓不到，报错会误伤）
for (const k of Object.keys(I18N)) if (!used.has(k)) warnings.push(`字典里有未被引用的 key: ${k}`);

// ⑤ 插值 token 在 5 种语言里集合相同
for (const [k, row] of Object.entries(I18N)) {
  const sets = LANGS.map((l) => [...String(row[l] ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(","));
  if (new Set(sets).size !== 1) errors.push(`${k} 的插值占位符在各语言间不一致: ${sets.join(" | ")}`);
}

// ⑥ reg.* 禁用词（含繁体变体）
for (const [k, row] of Object.entries(I18N)) {
  if (!k.startsWith("reg.")) continue;
  for (const lang of LANGS) {
    const s = String(row[lang] ?? "").toLowerCase();
    for (const w of BANNED) if (s.includes(w.toLowerCase())) errors.push(`${k}/${lang} 出现偏好词「${w}」`);
  }
}

// ⑦ 字典全文不命中 scan-secrets.sh 的 IP:PORT 正则
for (const [k, row] of Object.entries(I18N)) {
  for (const lang of LANGS) if (IP_PORT.test(String(row[lang] ?? ""))) errors.push(`${k}/${lang} 出现 IP:PORT 形态`);
}

// ⑧ 带 `{占位符}` 的 key 不许被当成「不带参数的裸标签」用
//
// **这一条是 P3b Task 7 的阶段验收人工冒烟抓出来的，不是凭空加的门禁。**
// `sec-overview.js` 把 `ov.config.envLocked`（一句自带 `{count}` 的完整句子）
// 传给了 `row()`，而 `row()` 内部调的是 `t(labelKey)` —— **不带参数**。
// 面板上于是长这样：
//     被环境变量锁定的字段数：{count}: 被环境变量锁定的字段数：1
// 裸的模板记号直接展示给运维看。前六条断言全绿，因为它们查的是「key 齐不齐」
// 「占位符集合各语言一不一致」，没有一条查「用的时候给没给参数」。
//
// ⚠️ **判据建在「这个 key 的字符串字面量后面紧跟着什么」上，不是建在 `t(` 上。**
// 上面那处的调用点是 `row("ov.config.envLocked")`，压根不是 `t(` 开头——只扫
// `t("…")` 的话这条门禁抓不到当初那个缺陷，那就是一道自称管用的假门禁。
// 规则：带占位符的 key 每一次以字符串字面量出现时，后面必须紧跟一个 `,`
//（也就是「还有第二个参数」）。`data-i18n="…"` 这种属性形态同样会被拦下——
// `apply()` 走的也是不带参数的 `t()`，是同一个缺陷。
//
// **边界**：把这种 key 塞进数组（`["ev.timeline", …]`）时后面也是 `,`，会漏过去；
// 放在数组末尾则会误报。今天 admin-ui/ 下没有这两种写法（实测：唯一的命中就是
// 上面那一处）。真要写，请在这里说明并调整判据，别把这条门禁删掉。
const DICT_FILE = join(ROOT, "admin-ui/js/i18n-dict.js");
const PLACEHOLDER_KEYS = Object.keys(I18N)
  .filter((k) => LANGS.some((l) => /\{\w+\}/.test(String(I18N[k][l] ?? ""))));
for (const p of walk(join(ROOT, "admin-ui"))) {
  // 字典自己是**定义处**，`"key": { … }` 后面跟的是 `:`，不是调用点。
  if (p === DICT_FILE) continue;
  const src = readFileSync(p, "utf8");
  for (const k of PLACEHOLDER_KEYS) {
    const needle = `"${k}"`;
    for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
      const after = /^\s*(.)/.exec(src.slice(i + needle.length));
      if (after && after[1] === ",") continue;
      const line = src.slice(0, i).split("\n").length;
      errors.push(
        `${p.slice(ROOT.length)}:${line} 把带占位符的 key「${k}」当成不带参数的标签用了，`
        + "面板上会出现裸的 {占位符}",
      );
    }
  }
}

for (const w of warnings) console.warn(`[check-i18n] ⚠️ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`[check-i18n] ❌ ${e}`);
  process.exit(1);
}
console.log(
  `[check-i18n] ✅ ${Object.keys(I18N).length} 个 key × ${LANGS.length} 种语言，`
  + `${used.size} 处引用，${PLACEHOLDER_KEYS.length} 个带占位符的 key 全都带着参数用，全部对得上`,
);
