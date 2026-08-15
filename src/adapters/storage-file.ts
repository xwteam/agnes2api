import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Storage } from "../ports/storage.js";

export class FileStorage implements Storage {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "store.json");
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
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  async get<T>(key: string): Promise<T | null> {
    const all = await this.readAll();
    return key in all ? (all[key] as T) : null;
  }

  async put<T>(key: string, value: T): Promise<void> {
    const all = await this.readAll();
    all[key] = value;
    await this.writeAll(all);
  }

  async delete(key: string): Promise<void> {
    const all = await this.readAll();
    delete all[key];
    await this.writeAll(all);
  }

  async list(prefix: string): Promise<string[]> {
    return Object.keys(await this.readAll()).filter((k) => k.startsWith(prefix));
  }
}
