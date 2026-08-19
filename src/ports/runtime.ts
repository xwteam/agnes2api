/**
 * 运行时能力。**双运行时差异的唯一注入点。**
 *
 * 为什么是端口而不是在 handler 里嗅探：`process` 在 workerd 里根本不存在，
 * 在 handler 里写 `typeof process !== "undefined"` 会让**同一份 handler 代码
 * 在两种运行时下走不同分支**，而那正是硬约束 1 要消灭的东西。注入之后，
 * handler 只有一条代码路径，差异全在装配层，且两侧各有一条契约断言。
 */
export interface ProcessMetrics {
  pid: number;
  rssBytes: number;
  uptimeMs: number;
}

export interface RuntimeInfo {
  readonly name: "node" | "worker";
  readonly storageBackend: "file" | "kv";
  /** KV 有四个每天的配额桶；文件存储没有配额，但每次写都重写整个 store.json。 */
  readonly quotaModel: "kv" | "file";
  /**
   * **Worker 恒返回 `null`，绝不返回 `{ pid: 0 }` 之类冒充。**
   * 设计文档 §13.3 第 6 条：Worker 形态下内存/CPU/PID 必须显示
   *「Serverless · 无常驻进程」，**不是 0 也不是空**。返回 0 会被读成「真的是 0」。
   */
  process(): ProcessMetrics | null;
}
