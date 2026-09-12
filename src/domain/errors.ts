/**
 * Domain Error Hierarchy and Error Codes
 * Strict Domain Layer: Zero Node I/O, Zero External SDKs
 */

export type McpErrorCode =
  | 'LIBRARY_NOT_FOUND'
  | 'AMBIGUOUS_LIBRARY'
  | 'VERSION_NOT_FOUND'
  | 'CORPUS_NOT_READY'
  | 'INVALID_REQUEST'
  | 'TOKEN_BUDGET_EXCEEDED'
  | 'BACKEND_MISCONFIGURED'
  | 'INDEX_BACKEND_UNAVAILABLE'
  | 'SEARCH_FAILED'
  | 'INDEX_INCONSISTENT'
  | 'CORPUS_CORRUPT'
  | 'DEADLINE_EXCEEDED'
  | 'RESPONSE_TOO_LARGE';

export type CliErrorCode =
  | 'SOURCE_FETCH_FAILED'
  | 'DOCUMENT_PARSE_FAILED'
  | 'UNSUPPORTED_SOURCE'
  | 'SOURCE_EMPTY'
  | 'DOCUMENT_TOO_LARGE'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'RESOURCE_BUSY'
  | 'INDEX_RUN_PENDING'
  | 'INDEX_PARTIAL_FAILURE'
  | 'READINESS_PENDING';

export interface LibraryCandidate {
  libraryId: string;
  name: string;
}

export class DomainError extends Error {
  readonly code: McpErrorCode;
  readonly retryable: boolean;
  readonly candidates?: LibraryCandidate[];

  constructor(
    code: McpErrorCode,
    message: string,
    retryable: boolean = false,
    candidates?: LibraryCandidate[],
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = retryable;
    this.candidates = candidates;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LibraryNotFoundError extends DomainError {
  constructor(queryOrId: string) {
    super('LIBRARY_NOT_FOUND', `Library not found: '${queryOrId}'`, false);
    this.name = 'LibraryNotFoundError';
  }
}

export class AmbiguousLibraryError extends DomainError {
  constructor(query: string, candidates: LibraryCandidate[]) {
    super(
      'AMBIGUOUS_LIBRARY',
      `Ambiguous library query: '${query}'. Multiple candidates matched.`,
      false,
      candidates,
    );
    this.name = 'AmbiguousLibraryError';
  }
}

export class VersionNotFoundError extends DomainError {
  constructor(libraryId: string, versionKey: string, availableVersions: string[]) {
    super(
      'VERSION_NOT_FOUND',
      `Version '${versionKey}' not found for library '${libraryId}'. Available versions: ${availableVersions.join(', ')}`,
      false,
    );
    this.name = 'VersionNotFoundError';
  }
}

export class CorpusNotReadyError extends DomainError {
  constructor(libraryId: string, versionKey: string) {
    super(
      'CORPUS_NOT_READY',
      `Corpus is not published or ready for library '${libraryId}' version '${versionKey}'. Please run 'docsctx index'.`,
      false,
    );
    this.name = 'CorpusNotReadyError';
  }
}

export class InvalidRequestError extends DomainError {
  constructor(message: string) {
    super('INVALID_REQUEST', message, false);
    this.name = 'InvalidRequestError';
  }
}

export class TokenBudgetExceededError extends DomainError {
  constructor(maxTokens: number, requiredTokens?: number) {
    super(
      'TOKEN_BUDGET_EXCEEDED',
      `Cannot fit any complete candidate chunk within maxTokens budget of ${maxTokens}${requiredTokens ? ` (smallest candidate requires ${requiredTokens} tokens)` : ''}.`,
      false,
    );
    this.name = 'TokenBudgetExceededError';
  }
}

export class BackendMisconfiguredError extends DomainError {
  constructor(message: string) {
    super('BACKEND_MISCONFIGURED', message, false);
    this.name = 'BackendMisconfiguredError';
  }
}

export class IndexBackendUnavailableError extends DomainError {
  constructor(message: string) {
    super('INDEX_BACKEND_UNAVAILABLE', message, true);
    this.name = 'IndexBackendUnavailableError';
  }
}

export class SearchFailedError extends DomainError {
  constructor(message: string, retryable: boolean = false) {
    super('SEARCH_FAILED', message, retryable);
    this.name = 'SearchFailedError';
  }
}

export class IndexInconsistentError extends DomainError {
  constructor(message: string) {
    super('INDEX_INCONSISTENT', message, false);
    this.name = 'IndexInconsistentError';
  }
}

export class CorpusCorruptError extends DomainError {
  constructor(message: string) {
    super('CORPUS_CORRUPT', message, false);
    this.name = 'CorpusCorruptError';
  }
}

export class DeadlineExceededError extends DomainError {
  constructor(message: string = 'Operation exceeded deadline (20s).') {
    super('DEADLINE_EXCEEDED', message, true);
    this.name = 'DeadlineExceededError';
  }
}

export class ResponseTooLargeError extends DomainError {
  constructor(sizeBytes: number, limitBytes: number = 1048576) {
    super(
      'RESPONSE_TOO_LARGE',
      `Response size (${sizeBytes} bytes) exceeded maximum allowable limit of ${limitBytes} bytes (1 MiB).`,
      false,
    );
    this.name = 'ResponseTooLargeError';
  }
}

export class CliOperationError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly stage?: string;
  readonly runId?: string;
  readonly resumeRunId?: string;

  constructor(params: {
    code: CliErrorCode;
    message: string;
    exitCode?: number;
    retryable?: boolean;
    stage?: string;
    runId?: string;
    resumeRunId?: string;
  }) {
    super(params.message);
    this.name = 'CliOperationError';
    this.code = params.code;
    this.exitCode = params.exitCode ?? (params.code === 'READINESS_PENDING' ? 2 : 1);
    this.retryable = params.retryable ?? false;
    this.stage = params.stage;
    this.runId = params.runId;
    this.resumeRunId = params.resumeRunId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
