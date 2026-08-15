export interface Fetcher {
  fetch(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response>;
}
