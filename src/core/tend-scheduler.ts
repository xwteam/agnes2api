/**
 * 补池的调度循环：**自重排的 setTimeout 递归**，不是 setInterval。
 *
 * `setInterval` 的周期在创建时定死，没有任何 API 能改一个已存在 interval 的周期
 * （缺陷 I4）。后果是 `TEND_INTERVAL_MS` 成了面板「保存」唯一一处**确定会骗人**的
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
  /** 注入的定时器。Node 侧传 `node:timers` 的 setTimeout 并 `unref()`。 */
  setTimer: (fn: () => void, ms: number) => void;
  /** 启动时读到的间隔，同时是「一次都没读成功过」时的兜底值。 */
  initialIntervalMs: number;
  onError: (kind: "run" | "read_interval", err: unknown) => void;
}

export function startTendScheduler(deps: TendSchedulerDeps): void {
  let lastGoodIntervalMs = deps.initialIntervalMs;

  const tick = async (): Promise<void> => {
    try {
      await deps.runOnce();
    } catch (err) {
      // 补池失败不该停掉补池。
      deps.onError("run", err);
    }

    let nextMs = lastGoodIntervalMs;
    try {
      nextMs = await deps.readIntervalMs();
      lastGoodIntervalMs = nextMs;
    } catch (err) {
      // **链条断了就是「面板一次误操作永久停掉补池」**，比补池失败严重得多。
      // 有了配置的字段级降级之后这条基本不会触发（只剩 registrar 侧的脏配置还会抛），
      // 但兜底必须在。
      deps.onError("read_interval", err);
    }

    // 无论上面发生什么，**一定重排**。这一行是整个函数存在的理由。
    deps.setTimer(() => { void tick(); }, nextMs);
  };

  // 立即跑一轮：否则冷启动后要空等满一个间隔（默认 30 分钟）才开始补池。
  void tick();
}
