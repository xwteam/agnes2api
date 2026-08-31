/**
 * 补池的调度循环：**自重排的 setTimeout 递归**，不是 setInterval。
 *
 * `setInterval` 的周期在创建时定死，没有任何 API 能改一个已存在 interval 的周期
 * （这是一条登记在案的缺陷）。后果是 `TEND_INTERVAL_MS` 成了面板「保存」唯一一处**确定会骗人**的
 * 字段——其余配置项每一轮都会重读、每一轮都生效，只有它不行。
 *
 * 抽成独立模块而不是留在 `main()` 里，是为了让「间隔改了第二次重排就用新值」这条
 * 断言可以确定性地测出来。定时器与配置读取都注入 ⇒ **零 IO**。
 */
export interface TendSchedulerDeps {
  /** 跑一轮补池。抛错会被兜住并交给 `onError`，链条继续。 */
  runOnce: () => Promise<void>;
  /**
   * 每轮结束后重新读一次间隔。**允许抛错**——抛了就沿用上一次已知的合法值。
   *
   * 注意不能用 `buildTendDeps` 拿它：那个函数在注册机未启用时返回 null，
   * 而定时器**必须在关闭状态下也继续存在**（否则启动时关着就再也打不开）。
   */
  readIntervalMs: () => Promise<number>;
  /**
   * 注入的定时器。Node 侧传 `node:timers` 的 setTimeout 并 `unref()`。
   *
   * **它是唯一真正无法自救的失败点**：`tick()` 把 `runOnce`/`readIntervalMs`/
   * `onError` 的异常全部兜住就是为了保证一定能走到这里，但 `setTimer` 自己
   * 抛错没有更下游的安全网可退——调用方必须保证这个函数不抛（Node 侧的
   * `node:timers.setTimeout` 本身不会因为参数合法就抛错，见下面 `clampToMaxDelayMs`
   * 对超大 `ms` 的处理）。
   */
  setTimer: (fn: () => void, ms: number) => void;
  /** 启动时读到的间隔，同时是「一次都没读成功过」时的兜底值。 */
  initialIntervalMs: number;
  /**
   * `onError` 抛错会被就地吞掉，**绝不能因此不重排**——它和 `runOnce`/
   * `readIntervalMs` 一样是消费方提供的、可能抛错的回调（上报 Sentry、写审计
   * 日志、无监听器时同步抛的 `EventEmitter.emit('error')` 都是真实场景），
   * 不能因为一个日志 sink 出故障就让整条补池调度链跟着断掉。
   */
  onError: (kind: "run" | "read_interval", err: unknown) => void;
}

/**
 * `setTimeout`/`setInterval` 的延迟参数用 32 位有符号整数表示（V8/libuv 的实现
 * 细节，Node 文档没有正式承诺但行为稳定）。超过这个值时 `node:timers` **既不
 * 抛错也不钳到这个上限**，而是静默把延迟当成 `1`——已实测：`setTimeout(fn,
 * 5_000_000_000)` 实际约 1ms 后就触发。
 *
 * 后果方向和直觉相反：把 `TEND_INTERVAL_MS` 设成一个超大值，效果不是「补池
 * 几乎永不触发」，而是**只受一次 `readIntervalMs` IO 往返约束的紧循环**——
 * 每一轮都读一次配置、可能触达邮箱/Agnes（`inFlight` 挡的是并发，挡不住高频
 * 触发）。`posInt` 从一开始就没有给这个字段设上界；把它从「只能重启
 * 进程改」变成「面板保存热更新」之后可达性实质性提升，这里必须钳一道。
 */
const MAX_SAFE_TIMER_DELAY_MS = 2_147_483_647;

function clampToMaxDelayMs(ms: number): number {
  return Math.min(ms, MAX_SAFE_TIMER_DELAY_MS);
}

export function startTendScheduler(deps: TendSchedulerDeps): void {
  let lastGoodIntervalMs = clampToMaxDelayMs(deps.initialIntervalMs);

  const tick = async (): Promise<void> => {
    // **`setTimer` 必须在 `finally` 里调用，不能只是「写在最后一行」**——
    // 位置性保证挡不住将来有人在中间插一段 `return`/`throw`；`finally` 是
    // 唯一能让「重排」在这个函数的任何提前退出路径上都成立的结构化手段。
    let nextMs = lastGoodIntervalMs;
    try {
      try {
        await deps.runOnce();
      } catch (err) {
        // 补池失败不该停掉补池。onError 自己也可能抛（见 TendSchedulerDeps.onError
        // 的注释）——那种情况绝不能连带炸掉这一轮的重排，否则一个日志 sink 故障
        // 就会让 tick() 的 promise 变成 unhandled rejection：全仓没有注册
        // unhandledRejection 处理器，Node 20+ 默认 `--unhandled-rejections=throw`，
        // 后果不是「补池永久停止」而是**整个网关进程崩溃**，转发能力也一起没了。
        try { deps.onError("run", err); } catch { /* 绝不能因此不重排 */ }
      }

      try {
        nextMs = clampToMaxDelayMs(await deps.readIntervalMs());
        lastGoodIntervalMs = nextMs;
      } catch (err) {
        // **链条断了就是「面板一次误操作永久停掉补池」**，比补池失败严重得多。
        // 有了配置的字段级降级之后这条基本不会触发（只剩 registrar 侧的脏配置还会抛），
        // 但兜底必须在——同上，onError 自己抛错也不能拖累重排。
        try { deps.onError("read_interval", err); } catch { /* 同上 */ }
      }
    } finally {
      // 无论上面发生什么（包括 onError 自己抛错），**一定重排**。这个 finally
      // 块是整个函数存在的理由。`setTimer` 自身抛错是唯一真正无法自救的情形
      // ——见 TendSchedulerDeps.setTimer 的注释。
      deps.setTimer(() => { void tick(); }, nextMs);
    }
  };

  // 立即跑一轮：否则冷启动后要空等满一个间隔（默认 30 分钟）才开始补池。
  void tick();
}
