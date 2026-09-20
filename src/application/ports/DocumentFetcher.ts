/**
 * DocumentFetcher Port
 * HTTP Fetch with conditional GET (304), WHATWG URL normalization, and security checks.
 */

export interface FetchSecurityOptions {
  allowedHosts: string[];
  includePaths: string[];
  excludePaths?: string[];
  allowHttp?: boolean;
  maxRedirects?: number;
  maxSizeBytes?: number;
}

export interface FetchRequest {
  url: string;
  eTag?: string;
  lastModified?: string;
  timeoutMs?: number;
  security?: FetchSecurityOptions;
}

export type FetchResponse =
  | {
      status: 200;
      requestedUrl: string;
      fetchedUrl: string;
      rawBody: string;
      rawHash: string;
      contentType?: string;
      eTag?: string;
      lastModified?: string;
      fetchedAt: string;
    }
  | {
      status: 304;
      requestedUrl: string;
      fetchedUrl: string;
      eTag?: string;
      lastModified?: string;
      checkedAt: string;
    }
  | {
      status: 404 | 410;
      requestedUrl: string;
      fetchedUrl: string;
      checkedAt: string;
    };

export interface DocumentFetcher {
  fetch(request: FetchRequest, signal?: AbortSignal): Promise<FetchResponse>;
}
