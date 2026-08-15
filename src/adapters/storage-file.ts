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

  async get<T>(key: string): Promise<T | null> {
    const all = await this.readAll();
    return key in all ? (all[key] as T) : null;
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.readAll();
      all[key] = value;
      await this.writeAll(all);
    });
  }

  async delete(key: string): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.readAll();
      delete all[key];
      await this.writeAll(all);
    });
  }

  async list(prefix: string): Promise<string[]> {
    return Object.keys(await this.readAll()).filter((k) => k.startsWith(prefix));
  }
}
