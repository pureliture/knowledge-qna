# Original User Request

## 2026-09-12T02:39:14Z

Build the Knowledge QnA MCP (`knowledge-qna-mcp` with CLI `docsctx`), a host-local stdio Model Context Protocol (MCP) server that provides version-aware, cited documentation context to AI coding agents from registered official documentation libraries.

Working directory: `/Users/ddalkak/Projects/knowledge-qna/.worktrees/knowledge-qna-mcp`
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
