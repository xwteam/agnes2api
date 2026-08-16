export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  /**
   * **稳定的机器可读事件名**，形如 `registrar.code_timeout`，不是自由文本。
   *
   * 自由文本没法过滤、没法 i18n、没法做面板筛选——P3b 的「事件」板块要按它分类，
   * 前缀（`registrar.` / `storage.` / `config.` / `admin.` / `key.` / `upstream.`）
   * 同时决定控制台渲染时用哪个前缀标签。
   */
  event: string;
  /** 给人看的一句话。可选。**过滤、i18n、面板筛选一律用 `event`，不许解析这里。** */
  msg?: string;
  fields?: Record<string, string | number | boolean | null>;
}

/** sink 负责补 `ts`——时间是 IO 能力，不该由 core 里的调用方提供。 */
export interface Logger {
  log(e: Omit<LogEntry, "ts">): void;
}

/**
 * 什么都不做的 sink。**只用于测试与「可选 logger 参数」的默认值。**
 *
 * 刻意不让默认值是 `ConsoleLogger`：那样「忘记注入」的后果是日志绕过 sink 直接
 * 打到 console，P3b 之后就变成「有些事件进了存储、有些没进」，而这种缺口在面板上
 * 看不见。默认静默则缺口会在测试里暴露成「事件没被记下来」。
 */
export const NULL_LOGGER: Logger = { log() {} };
