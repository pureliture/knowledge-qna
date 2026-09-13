# Original User Request

## 2026-09-12T02:39:14Z

Build the Knowledge QnA MCP (`knowledge-qna-mcp` with CLI `docsctx`), a host-local stdio Model Context Protocol (MCP) server that provides version-aware, cited documentation context to AI coding agents from registered official documentation libraries.

Working directory: `<worktree-path>`
Integrity mode: development
Execution contract: agentic-execution (maintain milestones.md, vertical slice progression, requirements-preserving design amendments permitted, strict authority boundaries)

## Reference Specifications
- Approved Intention Spec: `docs/specs/knowledge-qna-mcp/intention.md`
- Approved Design Spec: `docs/specs/knowledge-qna-mcp/design.md`

## Requirements

### R1. Project Bootstrap & Architecture Conformance (M0)
- Single npm package with TypeScript strict, ESM, Node.js 24 LTS.
- Package name `knowledge-qna-mcp`, CLI binary name `docsctx`.
- Enforce strict hexagonal/clean layer boundaries:
  `interfaces → application → domain`, and `infrastructure → application/ports + domain`.
  Composition root assembles concrete adapters per command. Domain has zero I/O, MCP SDK, or Google SDK dependencies.
- Architecture test suite to verify import boundaries automatically.

### R2. Host-Local Library Registry & Stdio MCP Server (M0 / T-01, T-10)
- Local deterministic string matching for library and version resolution (no LLM in resolution path).
- Handle exact ID matches, alias matches, and ambiguity returning `AMBIGUOUS_LIBRARY` with candidate list.
- Stdio MCP v2 server exposing exactly two tools: `resolve_library` and `get_context`.
- Strict stdio boundary: JSON-RPC exclusively on stdout, all logging and diagnostics routed to stderr.
- Machine-readable Zod-based wire schemas and standardized `ToolEnvelope` error/success envelopes.

### R3. Canonical Corpus & SQLite Manifest Pipeline (M1 / T-02 ~ T-06)
- Incremental discovery & fetch over allowed hosts/paths with WHATWG URL normalization and conditional GET (HTTP 304 handling).
- HTML-to-Markdown normalization preserving semantic structure, headings, code fences, and tables.
- Deterministic AST chunker (target 800 tokens, min 200, max 1400) preserving code blocks and tables as atomic units, flagging oversized blocks up to 16,000 tokens.
- Content-addressable SHA-256 canonical hashing for documents, snapshots, chunks, and immutable corpus revisions under `var/corpus/`.
- Host-local SQLite manifest (`var/manifest/catalog.sqlite`) tracking runs, observations, immutable revisions, and single-writer lease fencing.
- Clear separation: `docsctx sync` produces local corpus revision without publishing or altering search index.

### R4. Search Adapter Port, Retrieval Engine & Token Budget (T-09, T-11, T-12)
- Clean separation of `SearchBackend` (read) and `IndexBackend` (write) ports.
- Fixed `js-tiktoken` (`cl100k_base`) tokenizer for context string budget enforcement (default 6,000 tokens, bounded 256–16,000).
- Hydrate search hits into canonical local chunks, verifying generation and corpus membership.
- One-to-one citation mapping (`S1`, `S2`...) with titles, official URLs (preserving validated anchors), and heading paths. Return `TOKEN_BUDGET_EXCEEDED` or `truncated` indicators when appropriate.
- Fully functional in-memory search adapter for offline automated tests and portable corpus reconstruction (T-12).

### R5. Controlled Infrastructure & CLI Operations (I-013, I-014)
- Google Agent Search adapter designed to consume ADC standard credentials without embedding credentials or secrets in logs/code.
- Comprehensive CLI commands: `docsctx sync`, `docsctx index`, `docsctx search`, `docsctx serve`, and read-only `docsctx doctor`.

## Acceptance Criteria

### Build & Architecture Gates
- [ ] `npm run build` compiles clean with zero TypeScript errors under ESM strict mode.
- [ ] Automated architecture import test passes, verifying that `domain` and `application` layers do not import infrastructure or interface packages.
- [ ] `milestones.md` is initialized and maintained tracking active vertical slices and evidence.

### MCP Protocol & Contract Gates (T-01, T-10, T-11)
- [ ] MCP `tools/list` returns exactly two tools: `resolve_library` and `get_context`.
- [ ] `resolve_library` correctly resolves valid aliases, returns `AMBIGUOUS_LIBRARY` with candidate list for ambiguous queries, and handles unmapped libraries gracefully.
- [ ] `get_context` respects requested `maxTokens` budget on the formatted context text, outputs validated citations (`S1`, `S2`...), and handles empty matches with `status: "no_matches"`.
- [ ] Stdio server emits zero non-JSON-RPC text to stdout.

### Storage & Pipeline Integrity Gates (T-03, T-04, T-06, T-12)
- [ ] Re-fetching unchanged documents (HTTP 304 or identical normalized hash) reuses existing snapshot and chunk IDs deterministically.
- [ ] Code blocks and tables are preserved atomically in chunks without arbitrary truncation.
- [ ] Executing `docsctx sync` creates a new corpus revision without modifying published search generation pointers.
- [ ] Offline test suite demonstrates complete corpus reconstruction and search execution using the in-memory adapter without network access.

## 2026-09-13T03:40:48Z

Resume the implementation of Knowledge QnA MCP (`knowledge-qna-mcp` with CLI `docsctx`) from Milestone M1 (Canonical Corpus & SQLite Manifest Pipeline) through M2 (Retrieval Engine & Token Budget), building upon the completed Milestone M0 baseline.

Working directory: `<worktree-path>`
Integrity mode: development
Execution contract: agentic-execution (maintain milestones.md, vertical slice progression, requirements-preserving design amendments permitted, strict authority boundaries)

## Reference Specifications
- Approved Intention Spec: `docs/specs/knowledge-qna-mcp/intention.md`
- Approved Design Spec: `docs/specs/knowledge-qna-mcp/design.md`
- Current Milestones & Baseline: `milestones.md` (M0 complete, 87/87 tests passing, commit 41d7bc6)

## Context & Completed Foundation (M0)
- Hexagonal architecture with domain models, deterministic SHA-256 identity (`identity.ts`), domain errors (`errors.ts`).
- Stdio MCP v2 server (`resolve_library`, `get_context` stubs) with strict stdout JSON-RPC isolation.
- AST layer-boundary tests (`test/architecture/layer-boundaries.test.ts`), YAML library registry (`YamlLibraryRegistry.ts`).

## Requirements for Resume (M1 & M2)

### R1. Web / Sitemap Discovery & Incremental Fetching (M1 / T-02, T-03, T-05)
- Implement `SourceProvider` and `DocumentFetcher` ports under `src/infrastructure/`.
- Support sitemap parsing (nested index, recursion/cycle limits, max document limits) and static URL sources.
- WHATWG URL normalization (case, default port, trailing slash policy, strip fragment, `canonicalQueryKeys` sorting).
- SSRF and security controls: enforce allowed hosts/paths, HTTPS default (disallow private/loopback IP), handle robots.txt rules.
- HTTP conditional GET: evaluate ETag / Last-Modified, process HTTP 304 as unchanged without re-normalizing.
- Deletion detection: require 2 consecutive full discovery absences or explicit 404/410; partial discovery failures or timeouts must not trigger document deletion.

### R2. Structure-Preserving Normalizer & Atomic AST Chunker (M1 / T-03, T-04)
- Implement `DocumentNormalizer`: HTML to Markdown conversion preserving headings, lists, tables, code blocks, language identifiers, and indentation. Remove nav/footer/script/style per parser config.
- Implement `DocumentChunker`: AST-based chunking respecting heading hierarchy (target 800 tokens, min 200, max 1400 tokens).
- Code blocks and tables must be preserved as atomic units without mid-block fragmentation.
- Support oversized atomic units up to 16,000 tokens with `oversized: true`. Source documents exceeding 16,000 tokens fail with `DOCUMENT_TOO_LARGE`.
- Generate deterministic `snapshotId` and `chunkId` using SHA-256 per design spec §5.1.

### R3. Content-Addressable Corpus & SQLite Manifest Store (M1 / T-06)
- Implement `FilesystemCorpusStore` managing `var/corpus/`:
  - `documents/<documentId>/<snapshotId>.json`
  - `chunks/<chunkerProfileId>/<snapshotId>.jsonl`
  - `revisions/<corpusRevisionId>.json`
  - `profiles/<profileId>.json`
- Implement `SqliteManifestStore` (`var/manifest/catalog.sqlite`):
  - Track `sync_runs`, `fetch_observations`, `corpus_revisions`, `writer_leases`.
  - Single-writer lease with fencing token (30s lease, 10s renew).
  - Atomicity: atomic file flush & rename before committing SQLite transaction.
- Separation of sync and index: `docsctx sync` builds complete immutable corpus revision without publishing or altering search generation pointers.

### R4. Context Packing & In-Memory Retrieval Pipeline (M2 / T-09, T-11, T-12)
- Implement context packing engine using `js-tiktoken` (`cl100k_base`) enforcing `maxTokens` budget (default 6,000).
- Hydrate candidate search hits into canonical local chunks, verifying corpus membership and content hash.
- Map citations one-to-one (`S1`, `S2`...) with valid titles, official URLs (with validated anchors), and heading paths.
- Handle `TOKEN_BUDGET_EXCEEDED`, `truncated: true`, and empty search `status: "no_matches"`.
- Implement and test `InMemorySearchAdapter` enabling full offline corpus reconstruction and retrieval verification (T-12).

### R5. CLI Integration & Doctor Diagnostics (I-013)
- Implement `docsctx sync <libraryId>` CLI command supporting `--version`, reporting run summary and new revision ID.
- Enhance `docsctx doctor` to validate corpus directory, SQLite manifest integrity, and parser profiles.

## Acceptance Criteria

### Build & Integrity Gates
- [ ] `npm run build` compiles clean with zero TypeScript errors.
- [ ] All 87 existing tests continue to pass.
- [ ] Architecture boundary tests (`npm run test:arch`) pass without any new illegal layer imports.
- [ ] `milestones.md` is updated to record M1 progress, active slice state, and verification evidence.

### Pipeline & Normalization Gates (T-02 ~ T-06)
- [ ] Sitemap cycle/depth/host enforcement correctly rejects out-of-scope URLs and private IPs (T-02).
- [ ] Conditional GET (304) and identical content hashes reuse existing snapshot/chunk IDs deterministically (T-03).
- [ ] Code blocks and tables remain atomic in output chunks without arbitrary truncation (T-04).
- [ ] Partial fetch failures or timeouts do NOT cause document deletion (T-05).
- [ ] Running `docsctx sync` creates a new immutable revision while search published pointer remains untouched (T-06).

### Retrieval & Budget Gates (T-09, T-11, T-12)
- [ ] In-memory search adapter verifies complete offline corpus reconstruction and search round-trip (T-12).
- [ ] Context packing strictly honors `maxTokens` budget and formats validated citations (`S1`, `S2`...) correctly (T-11).

