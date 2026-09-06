import { describe, it, expect } from "vitest";
import {
  parseUpstreamModels, diffAgainstCatalog, UPSTREAM_MODELS_MAX,
} from "../../../src/core/admin/upstream-models.js";
import { MODEL_CATALOG } from "../../../src/core/admin/protocol-catalog.js";

/**
 * 上游那份模型清单的窄化与对照（`src/core/admin/upstream-models.ts`）。
 *
 * 契约那一侧（`tests/contract/admin-upstream-models.test.ts`）验的是「handler 真的把
 * 它接上了」；这里验的是**窄化本身的边界**——那些形态在契约层要造一个完整的 app
 * 才喂得进去，而它们恰恰是最容易写错的部分。
 */

describe("parseUpstreamModels：读不出来是 null，坏记录逐条跳过", () => {
  /**
   * ⚠️⚠️ **「上游一个模型都没有」与「这份响应我们看不懂」必须分得开。**
   * 后者返回空数组的话，面板上两者长得一模一样（全局约束 9 的同型）——
   * 而前者是一句关于上游的事实，后者是一句关于我们自己的话。
   */
  it.each([
    ["不是对象", 42],
    ["是数组", [{ id: "m" }]],
    ["没有 data", { object: "list" }],
    ["data 不是数组", { data: { id: "m" } }],
    ["null", null],
  ])("%s ⇒ null，不是空清单", (_name, payload) => {
    expect(parseUpstreamModels(payload)).toBeNull();
  });

  it("data 是空数组 ⇒ 空清单（这是一句关于上游的事实，不是「读不出来」）", () => {
    expect(parseUpstreamModels({ data: [] })).toEqual({ ids: [], truncated: false });
  });

  /**
   * ⚠️ **与 `catalogModels()` 的「一条坏的就整份判成读不出来」刻意相反。**
   * 那份是本仓自己的目录（坏了就是本仓的缺陷，必须整份报警），
   * 这份是别人家的清单——多一条我们不认识的记录，不该让整个功能失效。
   */
  it("坏记录逐条跳过，好的照留", () => {
    expect(parseUpstreamModels({
      data: [{ id: "good-1" }, null, 7, { id: 9 }, { id: "" }, ["x"], { name: "no-id" }, { id: "good-2" }],
    })).toEqual({ ids: ["good-1", "good-2"], truncated: false });
  });

  /**
   * ⚠️⚠️ **「逐条跳过」的尽头：一条都没抽出来。**
   *
   * **变红条件**：删掉 `parseUpstreamModels()` 末尾那句
   * `if (data.length > 0 && ids.length === 0) return null;`
   * ⇒ 本格拿到 `{ ids: [], truncated: false }`，handler 回 `ok: true`，
   * 面板照着画出「上游这次一个模型都没回」。
   * 那是**一句关于上游的事实**，而我们手上只有一句关于自己的话
   *（「这几条记录我们一条都读不懂」）——正是本端点当初点名要防的那一种。
   *
   * 三个夹具刻意覆盖三种「读不懂」的来源：字段名不对、`id` 类型不对、元素类型不对。
   * **反向的那一半由上面「坏记录逐条跳过，好的照留」那格担着**：跳掉几条之后还留得下
   * 东西时不许整份判死——判据是「一条都没抽出来」，不是「跳过了几条」。
   */
  it.each([
    ["字段名不是 id", { data: [{ name: "x" }, { name: "y" }] }],
    ["id 不是字符串", { data: [{ id: 7 }, { id: null }] }],
    ["元素根本不是对象", { data: ["m-1", 42] }],
  ])("data 非空而一条 id 都抽不出来（%s）⇒ null，不是「上游一个模型都没有」", (_name, payload) => {
    expect(parseUpstreamModels(payload)).toBeNull();
  });

  it("重复的 id 只留一条（上游重复回一条不是两个模型）", () => {
    expect(parseUpstreamModels({ data: [{ id: "a" }, { id: "a" }, { id: "b" }] })?.ids)
      .toEqual(["a", "b"]);
  });

  /**
   * 上限那一格：**截断要如实交代**。静默丢的后果是运维以为上游就这些模型
   * ——那是一句面板凭空说出来的话。
   */
  it("超过上限时截断，并且 truncated 为真；恰好等于上限时不算截断", () => {
    const many = Array.from({ length: UPSTREAM_MODELS_MAX + 1 }, (_v, i) => ({ id: `m-${i}` }));
    const over = parseUpstreamModels({ data: many })!;
    expect(over.ids).toHaveLength(UPSTREAM_MODELS_MAX);
    expect(over.truncated).toBe(true);

    const exact = parseUpstreamModels({ data: many.slice(0, UPSTREAM_MODELS_MAX) })!;
    expect(exact.ids).toHaveLength(UPSTREAM_MODELS_MAX);
    expect(exact.truncated, "恰好装得下却报了截断").toBe(false);
  });
});

describe("diffAgainstCatalog：两个方向都从 MODEL_CATALOG 现算", () => {
  it("上游多出来的与目录里没被回的，各自算对", () => {
    const first = MODEL_CATALOG[0]!.id;
    const d = diffAgainstCatalog([first, "brand-new"]);
    expect(d.onlyUpstream).toEqual(["brand-new"]);
    expect(d.onlyCatalog).toEqual(MODEL_CATALOG.map((m) => m.id).filter((id) => id !== first));
  });

  it("上游把目录里的全回了 ⇒ onlyCatalog 是空的（前置条件：目录非空）", () => {
    expect(MODEL_CATALOG.length, "目录是空的，这一族测的是空气").toBeGreaterThan(0);
    const d = diffAgainstCatalog(MODEL_CATALOG.map((m) => m.id));
    expect(d.onlyCatalog).toEqual([]);
    expect(d.onlyUpstream).toEqual([]);
  });

  /**
   * ⚠️ **`onlyUpstream` 保的是上游那份的顺序，不是排过序的**：面板按上游给的顺序
   * 逐条画，两处顺序不一致时徽章会挂到别的行上。
   */
  it("onlyUpstream 保上游那份的顺序", () => {
    expect(diffAgainstCatalog(["z-new", "a-new"]).onlyUpstream).toEqual(["z-new", "a-new"]);
  });
});
