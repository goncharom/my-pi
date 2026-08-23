# pi-lsp

Read-only Language Server Protocol tools for Pi.

## Tools

- `lsp_query` — hover, definitions, declarations, type definitions, implementations, and references.
- `lsp_symbols` — document outlines and workspace symbol search.
- `lsp_diagnostics` — file diagnostics with optional severity filtering.

Pi starts language servers lazily and reuses one process per language and workspace root. A compact footer item reports `LSP idle`, `starting`, `ready`, or `error`.

## Supported languages

| Language | Required executable | Files |
| --- | --- | --- |
| Go | `gopls` | `.go` |
| Java (Bazel workspaces only) | `jdtls` | `.java` |
| TypeScript/JavaScript | `typescript-language-server` and `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` |

Executables must already be installed and available on `PATH`.

Java projects must have an enclosing `MODULE.bazel`, `WORKSPACE.bazel`, or `WORKSPACE`. Maven, Gradle, and Eclipse project discovery are intentionally unsupported.

Root discovery prefers language-specific roots, then a shared Bazel workspace root, then a Git root, then Pi's cwd. Java requires the Bazel step to succeed.

## Install

```bash
pi install ./packages/extensions/pi-lsp
```

Or install this repository's aggregate package:

```bash
pi install .
```

## Examples

Ask Pi to:

- “Find the definition of the symbol at `src/main.ts:18:12`.”
- “Find references to the Go function at `internal/server.go:42:6`.”
- “List symbols in `src/main/java/example/App.java`.”
- “Search for workspace symbols matching `RequestHandler`, using `src/index.ts` as context.”
- “Show errors and warnings in `src/index.ts`.”

Tool positions are 1-based. Internally they are converted to LSP's 0-based UTF-16 positions.

## Adding a language

Add a `LanguageServerDefinition` to `src/languages.ts` with:

- file extensions and LSP language IDs;
- a server command/argument builder;
- optional language-specific root detection;
- optional initialization, request, and diagnostics timeouts.

The manager, tools, document synchronization, Bazel/Git fallback detection, and formatting are shared by every adapter.
