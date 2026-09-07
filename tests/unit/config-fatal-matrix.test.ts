import { describe, it, expect } from "vitest";
import { loadConfigWithProvenance } from "../../src/core/config-provenance.js";
import { ConfigRefusal } from "../../src/core/config-errors.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { registrarGrid } from "../helpers/registrar-grid.js";

/**
 * **成对 fatal 矩阵：注册机那族输入怎么坏，都不影响「缺口令」这条 fatal。**
 *
 * ── 这一格是什么的绊线 ──────────────────────────────────────────────────────
 *
 * 「让一份坏配置不再把网关打掉」这件事有一种**最省事也最坏**的写法：在
 * `loadConfigWithProvenance` 外面包一个 `try/catch` 把什么都吞掉。那样做之后
 * `pnpm test` 里绝大多数用例照样绿，而**缺 `GATEWAY_TOKEN` 拒绝服务**——网关的
 * 三条不变量之一（`src/http/config-holder.ts` 里那句「首次装载失败必须抛」逐字
 * 写着它）——会被悄悄拆掉：一台没有口令的网关会**照常起来并放行流量**。
 *
 * ⇒ 这一格把两半焊在一起：同一张对抗性输入网格，
 * · **有口令**那一半：恒不抛（`blocked` 随便真假，那是另外几格的事）；
 * · **没口令**那一半：恒抛，且**恒是 `ConfigRefusal`**，message 逐字相同。
 * 谁把「降级」写成一刀切的 catch，后一半当场全红。
 *
 * ⚠️ **message 必须逐字断言**：`src/entry/node.ts` 的 `main().catch` 打的就是
 * `err.message`，五语言 DEPLOY.md 的故障排查条目引的也是这句原文。
 */
describe("fatal 矩阵：注册机怎么坏都不影响「缺 GATEWAY_TOKEN 拒绝服务」", () => {
  const GRID = registrarGrid();
  const FATAL_MESSAGE = "缺少 GATEWAY_TOKEN，网关无法启动";

  async function load(env: Record<string, string | undefined>, registrar: object) {
    const storage = new MemoryStorage();
    await storage.put("config", { registrar });
    return loadConfigWithProvenance(env, storage, NULL_LOGGER);
  }

  it("有 GATEWAY_TOKEN：整张网格恒不抛", async () => {
    const threw: string[] = [];
    for (const c of GRID) {
      try {
        await load({ GATEWAY_TOKEN: "token-for-fatal-matrix-tests", ...c.env }, c.stored);
      } catch (err) {
        threw.push(`${c.name} ⇒ ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(threw, "注册机那族输入又能把整份装载打掉了").toEqual([]);
  });

  it("没有 GATEWAY_TOKEN：整张网格恒抛 ConfigRefusal，message 逐字不变", async () => {
    const survived: string[] = [];
    const wrongClass: string[] = [];
    const wrongMessage: string[] = [];
    for (const c of GRID) {
      try {
        await load({ ...c.env }, c.stored);
        survived.push(c.name);
      } catch (err) {
        if (!(err instanceof ConfigRefusal)) wrongClass.push(`${c.name} ⇒ ${String(err)}`);
        else if (err.message !== FATAL_MESSAGE) wrongMessage.push(`${c.name} ⇒ ${err.message}`);
      }
    }
    expect(
      survived,
      "有一组输入让「没有口令」这件事被吞掉了 —— 一台没有口令的网关会照常起来并放行流量",
    ).toEqual([]);
    expect(wrongClass, "两个入口靠 `err instanceof ConfigRefusal` 分流「运维配错」与「代码 bug」").toEqual([]);
    expect(wrongMessage, "node.ts 打的就是这句 message，五语言 DEPLOY.md 引的也是它").toEqual([]);
  });

  it("反向自检：这张网格里真的有会被判 blocked 的组，否则上面两格测的是空气", async () => {
    let blocked = 0;
    let fine = 0;
    for (const c of GRID) {
      const prov = await load({ GATEWAY_TOKEN: "token-for-fatal-matrix-tests", ...c.env }, c.stored);
      if (prov.config.registrar.blocked) blocked++;
      else fine++;
    }
    // **手写下界**，不从跑出来的数字回填。
    expect(blocked, "一组 blocked 都没有 ⇒ 网格根本没打到那条分支上").toBeGreaterThan(50);
    expect(fine, "一组正常的都没有 ⇒ 那两格全是被同一种输入喂出来的").toBeGreaterThan(50);
  });
});
