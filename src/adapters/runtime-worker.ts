import type { RuntimeInfo } from "../ports/runtime.js";

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
  };
}
