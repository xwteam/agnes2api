import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// buildTendDeps 抛错时，node 入口的装配阶段必须吞掉这个异常并只打日志——不能让
// buildApp() 已经成功之后，整个 main() 因为补池装配失败而跟着 reject。当前这条
// 路径在真实配置下不可达（buildApp 会对同一份注册机配置先做同等校验并率先抛错），
// 所以只能用 vi.mock 直接让 buildTendDeps 抛错来验证 try/catch 本身确实兜住了。
const buildTendDepsMock = vi.fn(async () => {
  throw new Error("装配补池依赖失败-测试注入");
});

vi.mock("../../src/http/wire.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/http/wire.js")>();
  return {
    ...actual,
    buildTendDeps: buildTendDepsMock,
  };
});

const { main } = await import("../../src/entry/node.js");

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "a2a-node-tend-fail-"));
}

function close(server: Awaited<ReturnType<typeof main>>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("node 入口: buildTendDeps 装配失败不影响网关启动", () => {
  it("buildTendDeps 抛错时 main() 仍正常监听端口并响应 /health，只记日志不崩溃", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await main({ GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: tmpDataDir() });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(buildTendDepsMock).toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith("[registrar] 装配补池依赖失败", expect.any(Error));
    } finally {
      errSpy.mockRestore();
      await close(server);
    }
  });
});
