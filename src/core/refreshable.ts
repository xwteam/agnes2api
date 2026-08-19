/**
 * 「TTL + 失效 + 加载失败保留上一份合法快照」的最小原语。**零 IO**：不 fetch、
 * 不读环境变量、不用 Date.now()/setTimeout——时间与加载器都从构造参数注入。
 *
 * 它同时是 `ConfigHolder`（配置）与 `KeyPoolRepo` 的池快照缓存（Task 4）的底座。
 * 两者回答的是同一个问题——「刚改完，什么时候能看见？」——而设计文档 §5.2 对用户
 * 承诺的生效时间只有一份。各写一份实现必然漂移出两套语义，那时面板上写的数字和
 * 实际行为就对不上了。
 */
export interface RefreshableOptions<T> {
  /** 真正去拿数据。**允许抛错**——抛错时保留上一份快照，见 reload。 */
  load: () => Promise<T>;
  /** 距上次成功加载多久之后，ensureFresh() 才会真的调用 load()。0 = 每次都重载。 */
  ttlMs: number;
  now: () => number;
  /** 加载失败时的回调（记事件用）。**它自己抛错会被吞掉**，sink 故障不许拖垮主流程。 */
  onError?: (err: unknown) => void;
}

export class Refreshable<T> {
  private value: T | undefined;
  /** 曾经成功装载过（或被 set 过）。与 loadedAt 分开，因为 invalidate 只重置后者。 */
  private everLoaded = false;
  /** 上一次**真加载**的时刻。invalidate 把它设成 -Infinity 以强制下次重载。 */
  private loadedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly o: RefreshableOptions<T>) {}

  /** 同步读当前快照。**永不抛**；从未装载过时返回 undefined。 */
  current(): T | undefined {
    return this.value;
  }

  isEmpty(): boolean {
    return !this.everLoaded;
  }

  /**
   * TTL 到期才真的重载。**永不抛。**
   *
   * 并发调用共享同一次加载：突发流量下不做这一步，N 个请求就是 N 次存储读取，
   * 正是本计划 §配额账最怕的形态（也是「读取次数与请求数解耦」这条结论的前提）。
   */
  async ensureFresh(): Promise<void> {
    if (this.everLoaded && this.o.now() - this.loadedAt < this.o.ttlMs) return;
    if (!this.inFlight) {
      const clear = () => { this.inFlight = null; };
      // reload() 内部已全量 try/catch，理论上不会 reject；两个回调都挂上是为了
      // 万一它真的 reject 也不会让 inFlight 永久卡住（那等于整个 isolate 再也不刷新）。
      this.inFlight = this.reload().then(clear, clear);
    }
    return this.inFlight;
  }

  /** 强制装载一次，**失败会抛**。供启动时的 fail-closed 路径用（缺 GATEWAY_TOKEN 拒绝服务）。 */
  async prime(): Promise<void> {
    this.value = await this.o.load();
    this.everLoaded = true;
    this.loadedAt = this.o.now();
  }

  /** 下一次 ensureFresh() 一定真的重载。面板写操作成功后调用。 */
  invalidate(): void {
    this.loadedAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * 就地替换快照而不产生任何读取（写穿透）。
   *
   * **刻意不推进 loadedAt**：推进了就意味着一个持续写入的实例永远不会再去读存储，
   * 于是它永远看不到别的实例（或面板）的改动。写穿透只保证「我自己写的我立刻看得见」，
   * 不该顺带延长「别人写的我多久能看见」的上界。
   */
  set(v: T): void {
    this.value = v;
    this.everLoaded = true;
  }

  private async reload(): Promise<void> {
    try {
      this.value = await this.o.load();
      this.everLoaded = true;
      this.loadedAt = this.o.now();
    } catch (err) {
      try {
        this.o.onError?.(err);
      } catch {
        // sink 自身故障不许影响主流程。
      }
      // **失败也推进计时，但只在已有兜底快照时。**
      // 有兜底：故障期每个请求都重试等于把存储打爆，而这正是「配置读不出来」时
      //   最不该做的事；代价是失败后最多再等一个 TTL 才重试。
      // 无兜底（冷启动就失败）：不推进，让下一次调用继续尝试——否则冷启动撞一次
      //   网络抖动就要空等满一个 TTL，期间 current() 是 undefined。
      if (this.everLoaded) this.loadedAt = this.o.now();
    }
  }
}
