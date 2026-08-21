import type { RuntimeInfo, BackgroundCtx } from "../ports/runtime.js";

/**
 * Cloudflare Worker 侧。
 *
 * `process()` 恒 `null`：**Serverless 没有常驻进程**，内存/CPU/PID 这三个数在这里
 * 根本不存在。返回 `{ pid: 0, rssBytes: 0 }` 会被面板渲染成「0 MB」，
 * 而用户会把它读成「真的是 0」——设计文档 §13.3 第 6 条点名禁止这件事。
 *
 * **也不返回「isolate 存活时长」**：面板每次轮询可能打到不同 isolate，
 * 那个数字会来回跳。设计文档 §7.2 已经判过这种形态——「比没有更糟，
 * 因为它看起来在工作」。同理，§10.1 想显示的「部署于 &lt;日期&gt;」在 Worker 运行时里
 * 没有任何 API 能取到（`VERSION` 是构建期常量，不含时间），也一并不做。
 */
export function workerRuntime(): RuntimeInfo {
  return {
    name: "worker",
    storageBackend: "kv",
    quotaModel: "kv",
    process: () => null,
    /**
     * **必须交给 `ctx.waitUntil`。** 响应一返回，这个 isolate 就可能立刻停摆，
     * fire-and-forget 的任务会被从中间砍断——而「立即补池」被砍断的后果不是
     * "少铸一把"，是 `mintOne` 的 `finally` 不跑、**临时邮箱漏删**，攒够几个就把
     * 活跃邮箱名额吃光。这与 `src/entry/worker.ts` 的 Cron 路径用 `ctx.waitUntil`
     * 是同一条理由。
     *
     * `ctx` 为 `null` 时退回 fire-and-forget：那说明调用方**没有把
     * `ExecutionContext` 传进 `app.fetch(req, env, ctx)`**（本仓的 Worker 入口传了，
     * 由 `tests/unit/entry-worker.test.ts` 的
     * 「fetch 把 ExecutionContext 一路传给 app —— 不传的话 waitUntil 在生产里根本拿不到」
     * 钉着）。**这条退路不是等价物，只是不把任务整个丢掉**；它一旦被走到，
     * 上面那条截断风险就回来了。
     */
    background(task: Promise<unknown>, ctx: BackgroundCtx | null): void {
      if (ctx === null) { void task; return; }
      ctx.waitUntil(task);
    },
  };
}
