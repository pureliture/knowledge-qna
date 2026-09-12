/**
 * DocumentFetcher Port
 * HTTP Fetch with conditional GET (304), WHATWG URL normalization, and security checks.
 */

export interface FetchRequest {
  url: string;
  eTag?: string;
  lastModified?: string;
  timeoutMs?: number;
}

export type FetchResponse =
  | {
      status: 200;
      url: string;
      rawBody: string;
      eTag?: string;
      lastModified?: string;
      fetchedAt: string;
    }
  | {
      status: 304;
      url: string;
      eTag?: string;
      lastModified?: string;
      checkedAt: string;
    }
  | {
      status: 404 | 410;
      url: string;
    };

export interface DocumentFetcher {
  fetch(request: FetchRequest): Promise<FetchResponse>;
}
