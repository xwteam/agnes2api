import { describe, it, expect, vi } from "vitest";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { main } from "../../src/entry/node.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "a2a-node-entry-"));
}

function close(server: Awaited<ReturnType<typeof main>>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("node 入口: fail-closed", () => {
  it("缺少 GATEWAY_TOKEN 时启动失败（拒绝服务），不会去监听端口", async () => {
    await expect(main({ DATA_DIR: tmpDataDir() })).rejects.toThrow(/GATEWAY_TOKEN/);
  });
});

describe("node 入口: 真实启动路径", () => {
  it("提供 GATEWAY_TOKEN 时真的监听端口并能响应 /health", async () => {
    const server = await main({ GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: tmpDataDir() });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok", version: "0.1.0", storage: { writable: true },
      });
    } finally {
      await close(server);
    }
  });
});

// ── I-RM3：Critical A 的健康信号必须由**真实入口**保证 ───────────────────────
//
// storage-health 那套用例走的是 `buildApp(..., { probeStorage: true })`，绕过了
// src/entry/node.ts。实测把入口那一行的 `{ probeStorage: true }` 删掉，全套用例照样全绿
// ——而那一行正是「冷容器 + 数据目录不可写 + 空池」这条真机路径上唯一起作用的东西：
// 不探测的话 `/health` 一直 200（空池只读不写，watchStorage 永远观测不到写失败），
// 容器被报告为 healthy，而每一次 API 调用都返回 pool_empty。故这条用例从 `main()` 起。
//
// root 无视权限位，因此以 root 跑测试时跳过（真机验证由容器那一侧覆盖）。
const notRoot = typeof process.getuid !== "function" || process.getuid() !== 0;

describe.skipIf(!notRoot)("node 入口: 数据目录不可写", () => {
  it("真实入口 main() 起的服务，/health 报 503 degraded 而不是继续报 healthy", async () => {
    const dir = tmpDataDir();
    chmodSync(dir, 0o500); // r-x：读得到、写不进，等价于绑定挂载属主不匹配
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await main({ GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: dir });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        status: "degraded", storage: { writable: false },
      });
      // 不可写的原因必须进容器日志，否则运维只看到 degraded 却查不出为什么。
      expect(logged).toHaveBeenCalled();
    } finally {
      chmodSync(dir, 0o700);
      logged.mockRestore();
      await close(server);
    }
  });
});
