/**
 * 运行时能力端口。
 *
 * ⚠️ **它原来的立身之本是「双运行时差异的唯一注入点」，那个前提在 v0.4.0 没了**
 *（Cloudflare Worker 形态整体摘除，仓里只剩 Node/Docker 一种运行时）。
 * 留下这个端口的理由**换了一条，而且只剩这一条**：`process.memoryUsage()` /
 * `process.pid` / `process.uptime()` 是 Node 的全局对象，本仓的分层约定是
 * **全局与 IO 只许出现在 `src/adapters/`**（`src/core` 零 IO 那道门禁的同一条纪律）。
 * 没有这个端口，`src/http/admin/handlers/overview.ts` 就得自己伸手去摸 `process.*`。
 *
 * **它今天不是多态点**：`name` / `storageBackend` / `quotaModel` 三格各自只有一个
 * 合法值，写成字面量类型就是为了让「将来又冒出第二种形态」这件事必须先改这里、
 * 改不动就说明它不是随手能加的。真要再来一种形态，那是一次显式的设计动作。
 */
export interface ProcessMetrics {
  pid: number;
  rssBytes: number;
  uptimeMs: number;
}

export interface RuntimeInfo {
  readonly name: "node";
  readonly storageBackend: "file";
  /** 文件存储没有写配额，但每次写都重写整个 store.json。 */
  readonly quotaModel: "file";
  /**
   * 常驻进程的内存 / CPU / PID。
   *
   * ⚠️ **它今天恒返回一个对象，不返回 `null`。** 调用方看到的 `null` 只有一个来源：
   * `overview` 那一层的逐块降级（`block()` 把一次罕见的引擎抖动兜成 `null`），
   * **不是「这个形态本来就没有进程」**——后一种含义随 Worker 形态一起没了。
   */
  process(): ProcessMetrics;
}
