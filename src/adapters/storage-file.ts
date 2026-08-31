import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import type { Storage } from "../ports/storage.js";

/**
 * 单文件 JSON 存储（Docker/Node 部署形态）。
 *
 * 并发说明（设计 §5.4 修正条目）：单进程 **不等于** 串行。`put`/`delete` 都是
 * 「读全量 → 改一个键 → 写全量」，这三步跨越 await 点，两个并发调用会交错，
 * 后写的那次覆盖先写的那次，造成静默丢更新；而 `dispatch` 每次请求都在返回成功
 * 响应**之前**写回 key 状态，丢更新就等于把已经成功的上游响应变成 500。
 *
 * 因此这里做两件事：
 *   ① 临时文件名唯一（带 uuid）——固定的 `.tmp` 会让两个并发写互抢同一个文件，
 *      第一个 rename 成功后 tmp 就没了，第二个必然 ENOENT；
 *   ② 用写队列把 `put`/`delete` 串行化——消除读改写竞态。
 * 读操作（`get`/`list`）是单次 readFile，天然原子（rename 是原子替换），不入队。
 */
/**
 * 保留键：一张「key → 过期时刻（epoch ms）」的表，与真实业务键存在**同一份** JSON
 * 里（评审裁定：单文件、单次 `readAll`/`writeAll`，不另开一个 sidecar 文件、不引入
 * 第二次跨文件一致性问题）。真实业务键全部带可打印 ASCII 前缀（`event:`/`key:`/
 * `pool:index`/`configHolder`/`admin:session:`/`tend:lock`……），这个保留键用一个
 * **前导空格**开头——业务代码不可能写出这样的键，不存在碰撞可能。
 *
 * ⚠️ **评审 F3**：这个常量第一版写的是字面 NUL 字节（`\x00`），不是这行注释描述的
 * 前导空格——git 因此把整个文件判成二进制，后果不是"风格问题"：评审包生成时对
 * 这个文件只吐一行 `Binary files a/... and b/... differ`（评审没看过这一轮最核心
 * 文件的代码）；`grep -rn "implements Storage"` 之类的审计静默跳过它、连
 * "Binary file matches" 都不打印；`scripts/scan-secrets.sh` 用 `git grep -nI`
 * 扫描凭据，`-I` 的含义就是跳过二进制文件——**这个文件对"仓库零内置凭据"这道门禁
 * 完全失明**（已实测：塞一段能匹配现有正则的假凭据进去，门禁照样放行）。
 * 现在改成前导空格（`0x20`）的写法，把文件带回文本；另见
 * `scripts/check-no-binary.mjs`（评审要求新增的那道门禁：`src/`/`tests/`/
 * `admin-ui/`/`scripts/`/`docs/` 下不许存在被 git 判为二进制的跟踪文件，堵的是
 * "这一类"问题，不是"这一个"字节）。
 *
 * ⚠️ **评审四审 B 组第 3 条：上面这段话的第一版写的是"改成运行期字节完全等价的
 * 前导空格写法"——那句话是假的**，而它恰恰写在一段专门用来订正另一句假注释的
 * 注释里。`" ttl"`（`0x20`）与 `"\x00ttl"`（`0x00`）**是两个不同的键**，运行期不
 * 等价：真要字节等价得写 `"\u0000ttl"`（源码是 ASCII 转义、文件仍是文本，运行期
 * 才是 NUL）。这里**有意选择不字节等价**——前导空格更好读、也不会再给别的按字节
 * 处理的工具埋雷。实际影响近乎为零，理由明写在这里而不是靠"等价"两个字糊过去：
 * 本项目尚未发布，磁盘上不存在任何按旧键写过的 `store.json`；即便存在，旧键既不
 * 匹配任何业务 `list()` 前缀（`event:`/`key:`/`pool:index`/`admin:session:`……），
 * 也不会被 `get()` 读到，**主要后果**是那份旧 TTL 表被忘掉、其中记过期的键从此
 * 不再过期。
 *
 * **另外两个后果，一并写清楚，别让"主要"两个字把它们盖掉**（评审五审）：
 * ① 那份孤儿旧表会**永久留在 `store.json` 里**——`pruneExpired()` 只清 ttl 表里
 *    登记过的键，而旧表本身从来不在新表里，没有任何一条路径会删掉它；
 * ② 下面 `list()` 的保留键过滤是 `k !== TTL_TABLE_KEY` 这条**精确等值**比较，
 *    只认新键，所以 `list("")` 会把孤儿旧键当成一条普通业务键返回。本仓今天没有
 *    任何调用方用空前缀 `list("")`（都带 `event:`/`key:`/`pool:` 这类前缀，旧键
 *    一条都不匹配），所以现在不构成问题——但这条前提要是变了，它就会变成问题。
 * 三条合起来仍然只在"已发布 + 就地升级"的世界里才需要一次迁移。
 */
const TTL_TABLE_KEY = " ttl";

/** 从 `readAll()` 的结果里取出 ttl 表，缺失/畸形一律当空表（`unknown` 窄化，不假设形状）。 */
function readTtlTable(all: Record<string, unknown>): Record<string, number> {
  const raw = all[TTL_TABLE_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export class FileStorage implements Storage {
  private readonly file: string;

  /**
   * 写队列尾。每次入队都挂在上一次之后，从而保证「读—改—写」整体串行。
   * 队列自身永远不会进入 rejected 状态（见 enqueue），否则一次失败会让后续
   * 所有写操作跟着失败。
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, "store.json");
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readAll(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  private async writeAll(data: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await rename(tmp, this.file);
    } catch (e) {
      // 写或替换失败时别把半成品临时文件留在数据目录里。
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  /**
   * 过期判定用真实墙钟。**这是 IO 边界适配器，不是核心业务逻辑**（与本文件已有的
   * `randomUUID()` 同一个层级）：判定"是否已经过期"天然需要跟"活的现在"比较，
   * 这与 KV 侧由 Cloudflare 边缘自己拿它自己的时钟判定过期是同一件事，
   * 不属于"核心模块零 Date.now()"那条规矩管的范围
   * （那条规矩管 `src/core/`；这里是 `src/adapters/`）。
   *
   * ⚠️ **这里原来写着「本文件里唯一读 `Date.now()` 的地方」，那是假的**
   *（通读评审 A9）：本文件有**两处**调用点——这个 `isExpired()`，以及
   * `pruneExpired()`（写路径上顺手清过期键的那个）。两处用的是同一个墙钟、
   * 同一条理由，说成"唯一"只会让下一个读到这句话的人以为写路径不碰时钟。
   */
  private isExpired(all: Record<string, unknown>, key: string): boolean {
    const exp = readTtlTable(all)[key];
    return exp !== undefined && exp <= Date.now();
  }

  /**
   * 顺手清掉 ttl 表里已经过期的键（评审裁定：有界性必须是"存储自己的性质"）。
   * **每次写都扫一遍整张 ttl 表，不止清这次自己写的那个键**——旧方案只 delete
   * 一个按固定偏移算出来的键，稀疏落盘（gap 超过保留期）或多 isolate 各写各的
   * 随机分片时，那个算出来的键很可能压根不是"真正该被清掉的那个"，清理率归零。
   * 这里改成：**只要有任何一次写发生**（不必是同一类键、不必是同一个 isolate），
   * 这次写都会顺手把所有已经过期的键一起清掉——键数因此由这张表本身保证有界，
   * 不依赖"落盘节奏恰好规律""槽位恰好没被随机 shardId 打散"这类前提。
   */
  private pruneExpired(all: Record<string, unknown>, ttl: Record<string, number>): void {
    const now = Date.now();
    for (const [k, exp] of Object.entries(ttl)) {
      if (exp <= now) { delete all[k]; delete ttl[k]; }
    }
  }

  private writeTtlTable(all: Record<string, unknown>, ttl: Record<string, number>): void {
    // 表空了就把保留键本身也删掉——没用过 TTL 的存储（key 池、pool:index……）
    // 不该在 store.json 里永远背着一个空对象。
    if (Object.keys(ttl).length > 0) all[TTL_TABLE_KEY] = ttl; else delete all[TTL_TABLE_KEY];
  }

  async get<T>(key: string): Promise<T | null> {
    const all = await this.readAll();
    if (this.isExpired(all, key)) return null;
    return key in all ? (all[key] as T) : null;
  }

  async put<T>(key: string, value: T, expiresAt?: number): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.readAll();
      all[key] = value;
      const ttl = readTtlTable(all);
      if (expiresAt !== undefined) ttl[key] = expiresAt; else delete ttl[key];
      this.pruneExpired(all, ttl);
      this.writeTtlTable(all, ttl);
      await this.writeAll(all);
    });
  }

  async delete(key: string): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.readAll();
      delete all[key];
      const ttl = readTtlTable(all);
      delete ttl[key];
      this.pruneExpired(all, ttl);
      this.writeTtlTable(all, ttl);
      await this.writeAll(all);
    });
  }

  async list(prefix: string): Promise<string[]> {
    const all = await this.readAll();
    return Object.keys(all).filter(
      (k) => k !== TTL_TABLE_KEY && k.startsWith(prefix) && !this.isExpired(all, k),
    );
  }
}
