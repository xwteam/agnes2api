import type { Context } from "hono";
import type { RuntimeInfo } from "../../../ports/runtime.js";
import type { StorageHealth } from "../../../core/storage-health.js";
import { PROTOCOLS } from "../../../core/admin/protocol-catalog.js";

/**
 * **双运行时差异的唯一出口**（设计文档 §11）。面板启动时调一次，
 * 所有形态分支读它——不许 `runtime === "worker"` 散落进 8 个板块。
 *
 * **零存储读**：全部来自内存（注入的 RuntimeInfo + StorageHealth 的内存状态 +
 * 装配时算好的 envLocked）。它是面板启动必调的第一个接口，
 * 让它去读一次存储就等于给每次刷新加一次 KV 读。
 */
export function capabilitiesHandler(deps: {
  runtime: RuntimeInfo;
  storageHealth: StorageHealth;
  version: string;
  /**
   * Tier-2 到底有没有在记账。
   *
   * ⚠️ **它必须来自「这个 app 到底建没建 sink」，不许来自 `configHolder` 现读的
   * `usageStatsEnabled`。** 两者在一种真实情形下会分叉：那个开关是**建 app 时读一次**的
   *（见 `GatewayConfig.usageStatsEnabled`），有人往存储里把它改成 true 之后，
   * 现读会说 true 而这个 isolate 根本没有 sink ⇒ 面板画一张空图表并把它当成
   * 「这段时间没有流量」，那是三态混一（全局约束 9）。
   * `createApp` 因此传的是 `deps.usageSink !== undefined`——**同一个事实的同一个来源**。
   */
  usageStatsEnabled: boolean;
  /**
   * **生效的**落盘间隔，不是那个后端常量（评审发现）。
   * 运维经 `USAGE_FLUSH_INTERVAL_MS` 调过之后，这里必须报调过的那个值——
   * 报常量等于面板对「尾巴最长多久」说了一句与实际不符的话。
   */
  usageFlushIntervalMs: number;
}) {
  return (c: Context) => {
    // `cf` 只在 Cloudflare 边缘存在。**取不到就如实 null**，不伪造一个 "unknown"。
    const cf = (c.req.raw as { cf?: { colo?: unknown } }).cf;
    const colo = typeof cf?.colo === "string" && cf.colo !== "" ? cf.colo : null;
    return c.json({
      version: deps.version,
      runtime: { name: deps.runtime.name, colo },
      storage: { backend: deps.runtime.storageBackend, writable: deps.storageHealth.status().writable },
      quota: { model: deps.runtime.quotaModel },
      process: { metrics: deps.runtime.process() !== null },
      logs: {
        /**
         * 进程内日志区。**两种运行时都是 false，这是本期的刻意选择。**
         * 设计文档 §7.2 想在 Node 侧多一个「进程日志」区（MemoryLogger），
         * 但那会让双运行时冒烟多出一整套只在一侧存在的分支。
         * 现在先把两种形态的事件板块做成完全一样的，那一条另行登记。
         * 事件板块顶部**两种形态都写**同一句：逐请求日志请看容器 stdout /
         * Cloudflare 控制台的 Workers Logs。
         */
        processLog: false,
      },
      stats: {
        /** 现在是真值了。为假时面板渲染说明卡而不是空图表（设计 §10.6）。 */
        tier2Enabled: deps.usageStatsEnabled,
        /**
         * 落盘最小间隔，**给面板用来说清「未落盘的尾巴最长多久」**。
         * 面板不许把这个数写死：它是后端常量，写死就会在改常量的那天变成一句假话
         *（那条全局约束：诚实标记由后端字段驱动）。
         */
        flushIntervalMs: deps.usageFlushIntervalMs,
        /**
         * 哪几条协议的 token 是网关看得到的（订正 F1）。
         * **不许在前端硬编码这个列表**——它由协议目录的 `usagePath` 是否为 null 决定，
         * 而那一格记的是「网关这条路径解不解析响应体」（`expectJson`），
         * 不是「这条协议有没有 usage」。
         *
         * ⚠️ **形状是裸 `string[]`（协议 id 的数组），只从这一个出口发。**
         * `GET /admin/api/usage` **不带它**——同一份知识两个出口，前端就要面对
         * 「读哪一个」这个不该存在的问题。用量读端点落地之后这句话有护栏了：
         * `tests/contract/admin-usage.test.ts` 的
         * 「用量端点不带 tokensCoverage —— 同一份知识只许有一个出口」
         * 双向钉着（两条用量端点都不许带，而这一个出口必须真的有）。
         */
        tokensCoverage: PROTOCOLS.filter((p) => p.usagePath !== null).map((p) => p.id),
      },
    });
  };
}
