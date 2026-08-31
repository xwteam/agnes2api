import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorage } from "../../src/adapters/storage-file.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "a2a-storage-file-ttl-"));
}

async function rawStore(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "store.json"), "utf8")) as Record<string, unknown>;
}

/**
 * **评审发现（第二次修复）**：`FileStorage` 的 TTL 不能只是"逻辑上读不到"（那
 * `MemoryStorage` 的惰性隐藏也做得到），必须是**物理上从 `store.json` 里消失**
 * ——`Storage` 契约测试（`tests/contract/storage.test.ts`）已经覆盖了"逻辑可见性"
 * 这条通用行为，这里专门补 `FileStorage` 独有的"磁盘字节数不再无上限增长"这条
 * 性质，直接读裸 JSON 文件核验，不经过 `get()`/`list()`（那两个只能证明"读不到"，
 * 证明不了"占不占地方"）。
 */
describe("FileStorage 的 TTL：过期键真的从 store.json 里被物理删掉", () => {
  it("任何一次写都会顺手清掉已经过期的键——不限于同一个 key，piggyback 在所有写操作上", async () => {
    const dir = tmpDir();
    const st = new FileStorage(dir);

    await st.put("event:0:0", { v: "old" }, Date.now() + 100);
    let raw = await rawStore(dir);
    expect(raw["event:0:0"], "前置条件：写完立刻应该在裸文件里").toEqual({ v: "old" });

    await new Promise((r) => setTimeout(r, 200)); // 真等过期

    // 这次写的是一个完全不相关的键（不是 event:0:0 本身）——piggyback 清理的
    // 全部意义就在于"任何一次写都顺手扫一遍"，不依赖"恰好又写中同一个键"。
    await st.put("pool:index", { ids: [] });
    raw = await rawStore(dir);
    expect(raw["event:0:0"], "过期的键应该已经从裸文件里物理删掉了，不只是逻辑上读不到").toBeUndefined();
  });

  it("delete() 同样会顺手清理其他已过期的键", async () => {
    const dir = tmpDir();
    const st = new FileStorage(dir);

    await st.put("event:0:0", { v: "old" }, Date.now() + 100);
    await st.put("event:0:1", { v: "keep-me" }); // 不带 TTL，永不过期
    await new Promise((r) => setTimeout(r, 200));

    await st.delete("some:unrelated:key");
    const raw = await rawStore(dir);
    expect(raw["event:0:0"], "delete() 也应该顺手清掉过期键").toBeUndefined();
    expect(raw["event:0:1"], "没设 TTL 的键不受影响").toEqual({ v: "keep-me" });
  });

  it("没有任何键带 TTL 时，裸文件里不出现保留键——不给没用过 TTL 的存储背一个空表", async () => {
    const dir = tmpDir();
    const st = new FileStorage(dir);
    await st.put("key:a", { v: 1 });
    await st.put("key:b", { v: 2 });
    const raw = await rawStore(dir);
    const reservedKeys = Object.keys(raw).filter((k) => !k.startsWith("key:"));
    expect(reservedKeys, "不该出现除了写过的键之外的任何其他顶层键").toEqual([]);
  });

  it("ttl 表本身在最后一个带 TTL 的键过期并被清理之后也会消失", async () => {
    const dir = tmpDir();
    const st = new FileStorage(dir);
    await st.put("event:0:0", { v: "old" }, Date.now() + 100);
    let raw = await rawStore(dir);
    // 此刻确实存在一个非 "event:0:0" 的保留键（ttl 表自己）。
    expect(Object.keys(raw).some((k) => k !== "event:0:0"), "前置条件：ttl 表应该已经写进去了").toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    await st.put("key:unrelated", { v: 1 }); // 触发清理
    raw = await rawStore(dir);
    expect(raw["event:0:0"]).toBeUndefined();
    // 清理之后不该再背着一个空的 ttl 表——顶层键只剩这次真正写的那个。
    expect(Object.keys(raw)).toEqual(["key:unrelated"]);
  });

  it("未过期的键不受同批清理影响——清理只挑真正过期的，不误伤", async () => {
    const dir = tmpDir();
    const st = new FileStorage(dir);
    await st.put("event:0:0", { v: "expires-soon" }, Date.now() + 100);
    await st.put("event:1:0", { v: "expires-later" }, Date.now() + 10_000);
    await new Promise((r) => setTimeout(r, 200));
    await st.put("key:unrelated", { v: 1 });
    const raw = await rawStore(dir);
    expect(raw["event:0:0"]).toBeUndefined();
    expect(raw["event:1:0"], "还没过期的键不该被误清").toEqual({ v: "expires-later" });
  });
});
