import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { main } from "../../src/entry/node.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "a2a-node-entry-"));
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
      expect(await res.json()).toEqual({ status: "ok", version: "0.1.0" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
