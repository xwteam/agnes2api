export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  /**
   * **稳定的机器可读事件名**，形如 `registrar.code_timeout`，不是自由文本。
   *
   * 自由文本没法过滤、没法 i18n、没法做面板筛选——面板的「事件」板块要按它分类，
   * 前缀（`registrar.` / `storage.` / `config.` / `admin.` / `key.` / `upstream.`）
   * 同时决定控制台渲染时用哪个前缀标签。
   */
  event: string;
  /** 给人看的一句话。可选。**过滤、i18n、面板筛选一律用 `event`，不许解析这里。** */
  msg?: string;
  /**
   * 关联 ID。**同一件事跨越的多条事件用同一个值**，面板据此把它们串成一条时间线。
   *
   * 典型场景：一次铸 key 会先后打出 `registrar.list_domains_failed` →
   * `registrar.code_timeout` → `registrar.delete_mailbox_failed`，三条分开看
   * 各自都像孤立故障，串起来才看得出是同一轮补池的同一次尝试。
   *
   * **定字段这一步只让事件板块按它分组**；把它真正串进注册机那条链要等注册机板块
   *（那时才有人看得见分组的效果）。**先定是因为改 sink 的
   * 存储格式比改一个还没人消费的字段贵得多**——事件一旦开始落库，格式就有了兼容包袱。
   */
  corr?: string;
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
 * 打到 console，事件开始落库之后就变成「有些事件进了存储、有些没进」，而这种缺口在面板上
 * 看不见。默认静默则缺口会在测试里暴露成「事件没被记下来」。
 */
export const NULL_LOGGER: Logger = { log() {} };
