import type { Fetcher } from "../ports/fetcher.js";

export class NativeFetcher implements Fetcher {
  fetch(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
    return fetch(url, init);
  }
}
