# Knowledge QnA MCP (`knowledge-qna-mcp` / `docsctx`)

Host-local stdio Model Context Protocol (MCP) server that provides version-aware, cited documentation context to AI coding agents from registered official technical documentation libraries.

## Architecture

This project follows a strict Hexagonal / Clean Architecture design:
- **`src/domain/`**: Pure domain models (`Library`, `Snapshot`, `Chunk`, `Corpus`, `Generation`, `Search`), deterministic identity hashing (`identity.ts`), and domain error taxonomy (`errors.ts`). **Zero Node I/O and Zero external SDK dependencies**.
- **`src/application/`**: Use cases (`resolve-library.ts`, `get-context.ts`) and ports (`SearchBackend`, `IndexBackend`, `TokenCounter`, `CorpusStore`, `ManifestStore`, `LibraryRegistry`, etc.). Application does not import infrastructure or interfaces.
- **`src/infrastructure/`**: Concrete adapters (`YamlLibraryRegistry`, `SqliteManifestStore`, `FilesystemCorpusStore`, `TiktokenCounter`, `StderrLogger`).
- **`src/interfaces/`**: Inbound driving adapters:
  - `mcp/`: Stdio MCP v2 server exposing exactly `resolve_library` and `get_context` with stdout integrity protection.
  - `cli/`: `docsctx` CLI commands (`serve`, `doctor`).
- **`src/composition/`**: Dependency injection composition root (`container.ts`).
- **`src/main.ts`**: Entry point for CLI.

## Requirements

- Node.js >= 24.0.0 (LTS)
- npm >= 11.0.0

## Quick Start

```bash
# Install dependencies
npm install

# Build TypeScript to ESM (dist/)
npm run build

# Run read-only environment and registry doctor
npm run docsctx -- doctor

# Run Stdio MCP server
npm run docsctx -- serve
```

## Testing

```bash
# Run all tests (unit, contract, architecture)
npm test

# Run architecture boundary tests
npm run test:arch

# Typecheck without emitting
npm run typecheck
```
