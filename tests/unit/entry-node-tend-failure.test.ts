import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { FileStorage } from "../../src/adapters/storage-file.js";

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

/**
 * 等待某个条件成立。`main()` 里那一轮 `runTend()` 是 `void` 出去的后台链路，
 * 且开头夹着索引对账的真实文件读——`main()` 返回时它未必已经走到 buildTendDeps。
 * 断言"某件事迟早会发生"必须轮询，不能靠 `main()` 返回这个时刻碰巧够晚。
 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("node 入口: buildTendDeps 装配失败不影响网关启动", () => {
  it("buildTendDeps 抛错时 main() 仍正常监听端口并响应 /health，只记日志不崩溃", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await main({ GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: tmpDataDir() });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      await waitFor(() => buildTendDepsMock.mock.calls.length > 0);
      await waitFor(() =>
        errSpy.mock.calls.some(([m]) => m === "[registrar] 装配补池依赖失败"),
      );
      expect(errSpy).toHaveBeenCalledWith("[registrar] 装配补池依赖失败", expect.any(Error));
    } finally {
      errSpy.mockRestore();
      await close(server);
    }
  });
});

// ── 防回归：main() 启动时只读一次 "config" 键 ────────────────────────────────
//
// 此前 main() 里除了 buildApp() 内部（现为 configHolder 的 prime()）那次，还单独
// 调了一次 loadConfig(env, storage) 只为取 registrar.tendIntervalMs 建定时器，且
// 没传 logger（配置告警会静默落到 NULL_LOGGER）。修复是让定时器直接复用 buildApp
// 返回的 configHolder，删掉那次独立调用——但这只消除了缺陷的当前实例，没有堵上
// 复发通道：日后有人（很自然地）想清理这处「看起来多余」的存储读取，或者不小心
// 在 main() 里加回一次独立的 loadConfig，都不会被任何测试拦住。这里补上。
//
// 本文件已经把 buildTendDeps mock 成立刻 throw（见文件顶部），因此 runTend() 的
// 异步链路永远不会真的调用 loadConfig/storage.get("config")——用它天然隔离掉
// 「每轮补池都重新读一次配置」这条*设计如此*的独立读取，让计数只反映启动路径。
describe("node 入口: 防回归 —— 启动时只读一次 config 键", () => {
  it("main() 从构造 storage 到监听端口，期间只 get(\"config\") 一次", async () => {
    const getSpy = vi.spyOn(FileStorage.prototype, "get");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await main({ GATEWAY_TOKEN: "t", PORT: "0", DATA_DIR: tmpDataDir() });
    try {
      const configGets = getSpy.mock.calls.filter(([key]) => key === "config");
      expect(configGets.length).toBe(1);
    } finally {
      getSpy.mockRestore();
      errSpy.mockRestore();
      await close(server);
    }
  });
});
