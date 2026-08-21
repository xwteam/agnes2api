import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * **核心设计决定的机器护栏**：前端一个网关端点路径都不许硬编码，全部来自
 * `GET /admin/api/models`（真源 `src/core/admin/protocol-catalog.ts`）。
 *
 * ⚠️ **三种引号都要扫。** 本计划第一版用的是 `grep -rn "'/v1"`——只认单引号，
 * 而本仓 admin-ui 里双引号 4054 处、单引号 5 处 ⇒ 那条检查恒输出 0 行、恒「通过」。
 * 这与 `scripts/check-i18n.mjs:145-149` 记着的那次翻车是同一个错的镜像。
 *
 * ⚠️ **不许排除 `js/pure/`。** 那里正是唯二拼 URL 的两个模块所在地
 *（本期 Task 7 的 `examples.mjs` 与 Task 10 的 `playground.mjs`）。
 *
 * 形态照抄 `tests/ui/storage-keys.test.ts:52` 那一格——它扫的就是 `["'\`]` 三种引号，
 * 已经证明这种扫描在本仓能落地。
 */
function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(html|js|mjs)$/.test(p) ? [p] : [];
  });
}

// ⚠️ **`(?:beta)?` 不是 `beta?`。** 后者的 `?` 只管 `a` ⇒ 它匹配 `/v1beta/` 与 `/v1bet/`，
// **不匹配 `/v1/`** —— 而本仓五条对外端点里有四条是 `/v1/...`，包括下面反向自检用的
// 那个探针。这个错在本计划里被重放过三次，第三次才改对。
const ENDPOINT_RE = /["'`](\/v1(?:beta)?\/[A-Za-z0-9_{}:/.-]*)["'`]/g;

/**
 * 豁免名单。**今天是空的，故意留着这个常量而不是删掉**：
 * 字典里今天零个 `/v1` 路径（实测全树命中数 = 0），所以它一条都不需要。
 * ⚠️ **往这里加任何一项之前先问「为什么那个文件需要写端点字面量」**——
 * 这是本期核心约束**唯一**的机器护栏，在护栏上预先开一个口子，
 * 就是在给「以后总有一天用得上」留台阶。真要加，把理由写在这一行下面。
 */
const ALLOW: readonly string[] = [];

function scan(): string[] {
  const offenders: string[] = [];
  for (const p of walk("admin-ui")) {
    const rel = p.split("\\").join("/").replace(/^admin-ui\//, "");
    if (ALLOW.includes(rel)) continue;
    for (const m of readFileSync(p, "utf8").matchAll(ENDPOINT_RE)) offenders.push(`${rel}: ${m[1]}`);
  }
  return offenders;
}

describe("前端不许硬编码网关端点", () => {
  it("前端没有任何文件硬编码网关端点路径 —— 端点只许来自 /admin/api/models", () => {
    expect(scan(), "端点要从 /admin/api/models 的响应里取，别在这些地方再写一遍").toEqual([]);
  });

  /**
   * **反向自检：这条正则真的认得本仓主流的那个写法。**
   *
   * 没有这一格的话，上面那个 `[]` 有两种成因分不开：「真的没人硬编码」与
   * 「正则瞎了、什么都扫不到」。本计划第一版正是后者，而它照样报「硬编码路径为 0」。
   *
   * ⚠️ 这里**不往仓库里种探针**（那会污染工作树，也会让这一格依赖文件系统状态）：
   * 判据是同一条 `ENDPOINT_RE` 对着六条手写的字符串样本跑，
   * 六条覆盖三种引号 × `/v1/` 与 `/v1beta/` 两种路径 × 一条**不该命中**的上游路径。
   * 真正「种一行进 admin-ui/ 再跑一遍」的动作在 Task 1 Step 6b 当场做过一次。
   */
  it("正则认得三种引号下的 /v1 与 /v1beta，且不误伤上游路径 —— 否则上面那个空数组什么都没证明", () => {
    const hit = (s: string) => {
      ENDPOINT_RE.lastIndex = 0;
      return ENDPOINT_RE.test(s);
    };
    expect(hit('const __probe = "/v1/messages";'), "双引号 + /v1/（Step 6b 的探针形态）").toBe(true);
    expect(hit('path: "/v1/chat/completions"'), "双引号").toBe(true);
    expect(hit("path: '/v1/responses'"), "单引号").toBe(true);
    expect(hit("url = `/v1/images/generations`"), "反引号").toBe(true);
    expect(hit('p = "/v1beta/models/x:generateContent"'), "/v1beta/").toBe(true);
    // **不该命中**：上游路径不带 `/v1` 前缀，它是网关自己拼的，不是前端的事。
    expect(hit('upstreamPath: "/chat/completions"'), "上游路径不该被扫进来").toBe(false);
  });

  /**
   * 扫描范围的反向自检：`walk("admin-ui")` 真的走到了 `js/pure/` 里面。
   * 上面那条告诫说「不许排除 js/pure/」，而**「没排除」与「根本没走到」在结果上一样**
   *（都是 0 条 offender）。这一格把「走到了」变成可观测的。
   */
  it("扫描范围真的覆盖 js/pure/ —— 「没排除它」与「根本没走到它」在结果上长得一样", () => {
    const scanned = walk("admin-ui").map((p) => p.split("\\").join("/"));
    expect(scanned).toContain("admin-ui/js/pure/storage-keys.mjs");
    expect(scanned).toContain("admin-ui/index.html");
  });
});
