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

/**
 * 「响应返回之后还要继续跑」的任务载体。Worker 上就是 `ExecutionContext`
 *（`c.executionCtx`），Node 上没有对应物。
 *
 * 只声明用得着的那一个方法，不直接依赖 `ExecutionContext` 类型：这个端口要能被
 * `src/core` 之外任何一层实现，而 workers-types 只在 Worker 那一侧有意义。
 */
export interface BackgroundCtx {
  waitUntil(p: Promise<unknown>): void;
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
  /**
   * 把一个「响应之后还要继续跑」的任务交给运行时驱动（`202 Accepted` 那一类）。
   *
   * **两种运行时的载体真的不同，所以它必须是注入的、且两侧各有一条断言**（硬约束 1）：
   * · Worker：**必须**交给 `ctx.waitUntil`。不交的话响应一返回 isolate 就可能停摆，
   *   任务被从中间砍断——而「立即补池」被砍断的后果是临时邮箱漏删（`mintOne` 的
   *   `finally` 不跑）。
   * · Node：长寿进程，直接 fire-and-forget；**`ctx` 一概不看**（Node 侧压根没有
   *   这个东西，Hono 的 `c.executionCtx` 在那里会抛错）。
   *
   * 在 handler 里写 `runtime.name === "worker" ? … : …` 是不行的：那会让**同一份
   * handler 代码在两种运行时下走不同分支**，正是这个端口要消灭的东西。
   */
  background(task: Promise<unknown>, ctx: BackgroundCtx | null): void;
}
