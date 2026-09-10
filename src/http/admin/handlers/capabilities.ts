import type { Context } from "hono";
import type { RuntimeInfo } from "../../../ports/runtime.js";
import type { StorageHealth } from "../../../core/storage-health.js";
import { PROTOCOLS } from "../../../core/admin/protocol-catalog.js";
import { apiKeysCapability } from "./api-keys.js";

/**
 * **面板的形态出口**（设计文档 §11）。面板启动时调一次，所有形态分支读它——
 * 不许「这个部署有没有 X」散落进 8 个板块各写一次。
 *
 * ⚠️ **它原来的定位是「双运行时差异的唯一出口」，那个定位在 v0.4.0 没了。**
 * 摘掉 Worker 形态之后 `runtime.name` / `storage.backend` / `quota.model` /
 * `process.metrics` 四格**各自只剩一个取值**，而且**今天没有一个前端消费者**
 *（面板的运行时格子读的是 `GET /admin/api/overview` 的 `runtime.name` 与
 * `storage.backend`，不是这里的）。**留着它们是范围取舍，不是它们还在干活**：
 * 删这四格要同步改五语言 API.md 里那份响应样例与 `docs-parity` 的形状用例。
 * **登记在这里，别把它读成「这四格还是形态分支的真源」。**
 * **真正还在分叉、真正有人读的是下面那几格**：`storage.writable`、
 * `stats.tier2Enabled`、`stats.flushIntervalMs`、`stats.tokensCoverage`、
 * `apiKeys` 那一组。
 *
 * **零存储读**：全部来自内存（注入的 RuntimeInfo + StorageHealth 的内存状态 +
 * 装配时算好的 envLocked）。它是面板启动必调的第一个接口，
 * 让它去读一次存储就等于给每次刷新加一次存储读。
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
   * 现读会说 true 而这个副本 根本没有 sink ⇒ 面板画一张空图表并把它当成
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
  /**
   * 对外 API 密钥那一格。**由 `adminRouter` 从 `apiKeysCapability()` 算好交进来**
   * ——那个函数与端点 handler 住在同一个文件里，`max` / `nameMax` /
   * `plaintextRetrievable` 三格因此与真正强制它们的那段代码同源。
   * 在这里重新拼一份就是第二份真源。
   */
  apiKeys: ReturnType<typeof apiKeysCapability>;
}) {
  return (c: Context) => {
    // ⚠️ **`runtime.colo` 这一格在 v0.4.0 删掉了。** 它读的是 `c.req.raw.cf.colo`
    //（请求打在哪个 Cloudflare 边缘机房），那是 Workers 运行时给 `Request` 挂的
    // 非标准扩展属性——Node 的 `fetch`（undici）里根本没有这个属性，**它恒为 `null`**。
    // 一个恒为 null 的字段在面板上只会让人以为「这次没取到」。
    // 面板那一侧读它时本来就是防御性的（`typeof caps.runtime.colo === "string"`），
    // 字段消失与恒 null 渲染出来一模一样。
    return c.json({
      version: deps.version,
      runtime: { name: deps.runtime.name },
      storage: { backend: deps.runtime.storageBackend, writable: deps.storageHealth.status().writable },
      quota: { model: deps.runtime.quotaModel },
      process: { metrics: deps.runtime.process() !== null },
      logs: {
        /**
         * 进程内日志区。**恒 false，这仍是刻意选择。**
         * 设计文档 §7.2 想多一个「进程日志」区（MemoryLogger）。
         *
         * ⚠️ **当时不做的理由（「那会让双运行时冒烟多出一整套只在一侧存在的分支」）
         * 在 v0.4.0 没了**，只剩一种运行时。**结论仍然是不做，理由换成这一条**：
         * 逐请求日志在 Docker 部署上有一个现成且更好的去处——`docker logs`
         *（`ConsoleLogger` 一条不落地往 stdout 打）。在面板里再攒一份内存日志，
         * 攒的是同一批行，代价是常驻内存 + 一个只有本进程看得见的第二真源。
         * 事件板块顶部那句话因此也只剩一句：逐请求日志请看容器 stdout。
         * **要做的话它是一次独立的功能决定，不是这次摘形态的顺带产物。**
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
         * 哪几条协议的 token 是网关看得到的（订正）。
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
      /**
       * 对外 API 密钥。**面板据它显隐整个板块里那几处形态分支**
       *（有没有「复制完整密钥」这颗按钮、「停用之后最多还能用多久」写几分钟、
       * 这个部署接没接这张表），**一格都不许在前端写死**（全局约束 10）。
       */
      apiKeys: deps.apiKeys,
    });
  };
}
