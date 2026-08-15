export interface Storage {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
