import { describe, it, expect } from "vitest";
import {
  KEY_PREFIX, POOL_INDEX_KEY, POOL_INDEX_VERSION,
  makePoolIndex, parsePoolIndex, idsFromKeyNames, sameIdSet,
} from "../../src/core/pool-index.js";

describe("常量", () => {
  it("键名固定——改了它等于让所有既有部署的索引凭空消失", () => {
    expect(KEY_PREFIX).toBe("key:");
    expect(POOL_INDEX_KEY).toBe("pool:index");
    expect(POOL_INDEX_VERSION).toBe(1);
  });
});

describe("parsePoolIndex", () => {
  it("合法结构原样解析", () => {
    expect(parsePoolIndex({ v: 1, ids: ["a", "b"] })).toEqual({ v: 1, ids: ["a", "b"] });
  });

  it("null / 非对象 / 数组一律返回 null", () => {
    for (const raw of [null, undefined, 42, "x", ["a"]]) expect(parsePoolIndex(raw)).toBeNull();
  });

  it("版本号不匹配返回 null——将来换结构时旧索引要被当成缺失而重建，不能半解析", () => {
    expect(parsePoolIndex({ v: 2, ids: ["a"] })).toBeNull();
    expect(parsePoolIndex({ ids: ["a"] })).toBeNull();
  });

  it("ids 不是数组返回 null", () => {
    expect(parsePoolIndex({ v: 1, ids: "a,b" })).toBeNull();
    expect(parsePoolIndex({ v: 1 })).toBeNull();
  });

  it("ids 里的非字符串与空串被剔掉，其余保留——存储里混进脏数据不该让整个索引作废", () => {
    expect(parsePoolIndex({ v: 1, ids: ["a", 1, null, "", "b", {}] })).toEqual({ v: 1, ids: ["a", "b"] });
  });

  it("去重", () => {
    expect(parsePoolIndex({ v: 1, ids: ["a", "a", "b", "a"] })).toEqual({ v: 1, ids: ["a", "b"] });
  });
});

describe("idsFromKeyNames", () => {
  it("只取带前缀的，并剥掉前缀", () => {
    expect(idsFromKeyNames(["key:aa", "key:bb", "config", "pool:index"])).toEqual(["aa", "bb"]);
  });

  it("裸前缀（key:）不产生空 id", () => {
    expect(idsFromKeyNames(["key:", "key:aa"])).toEqual(["aa"]);
  });

  it("不会把 pool:index 自己当成一把 key——它不带 key: 前缀，但这条要有测试守着", () => {
    expect(idsFromKeyNames([POOL_INDEX_KEY])).toEqual([]);
  });
});

describe("sameIdSet", () => {
  it("顺序不同视为相同——索引的顺序无语义，按顺序比会造成无谓的写", () => {
    expect(sameIdSet(["a", "b"], ["b", "a"])).toBe(true);
  });
  it("元素不同视为不同", () => {
    expect(sameIdSet(["a", "b"], ["a", "c"])).toBe(false);
  });
  it("长度不同视为不同", () => {
    expect(sameIdSet(["a"], ["a", "b"])).toBe(false);
    expect(sameIdSet(["a", "b"], ["a"])).toBe(false);
  });
  it("空集合相同", () => {
    expect(sameIdSet([], [])).toBe(true);
  });

  it("含重复元素时**两个方向都**判不同——比长度加单向包含会在这里说谎", () => {
    // 原实现（长度相等 + 单向包含）对这组入参返回 true：两边长度都是 2，
    // 而 ["x","x"] 的每个元素都在 {"x","y"} 里。当前两个调用点的入参都已 dedupe
    // 因而触发不到，但它的表现形式是「对账认为一致因而不修」——最难查的那种沉默。
    expect(sameIdSet(["x", "y"], ["x", "x"])).toBe(false);
    expect(sameIdSet(["x", "x"], ["x", "y"])).toBe(false);
    // 只是重复、集合本身相同的，仍然算相同。
    expect(sameIdSet(["x", "x", "y"], ["y", "x"])).toBe(true);
  });
});

describe("makePoolIndex", () => {
  it("打上版本号并去重", () => {
    expect(makePoolIndex(["a", "a", "b"])).toEqual({ v: POOL_INDEX_VERSION, ids: ["a", "b"] });
  });
});
