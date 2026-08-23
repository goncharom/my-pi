import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Hover } from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import {
  formatDiagnostics,
  formatHover,
  formatNavigation,
  formatSymbols,
  type FormattedLspOutput,
} from "./format";
import type { LspManager } from "./manager";
import type {
  NavigationResult,
  QueryOperation,
} from "./types";

const queryParameters = Type.Object({
  operation: StringEnum([
    "hover",
    "definition",
    "declaration",
    "type_definition",
    "implementation",
    "references",
  ] as const, { description: "Semantic operation to perform at the source position." }),
  path: Type.String({ description: "Source file path, absolute or relative to Pi's cwd." }),
  line: Type.Integer({ description: "1-based source line.", minimum: 1 }),
  column: Type.Integer({ description: "1-based UTF-16 source column.", minimum: 1 }),
  includeDeclaration: Type.Optional(Type.Boolean({
    description: "For references only, include the symbol declaration. Defaults to true.",
  })),
});

const symbolsParameters = Type.Object({
  path: Type.String({
    description: "Source file used to select the language server and workspace. With no query, returns this file's outline.",
  }),
  query: Type.Optional(Type.String({
    description: "Workspace symbol search query. Omit to list document symbols for path.",
    minLength: 1,
  })),
});

const diagnosticsParameters = Type.Object({
  path: Type.String({ description: "Source file path, absolute or relative to Pi's cwd." }),
  severity: Type.Optional(StringEnum([
    "error",
    "warning",
    "information",
    "hint",
  ] as const, { description: "Optional exact severity filter." })),
});

const MAX_DETAIL_ITEMS = 200;

export function registerLspTools(pi: ExtensionAPI, getManager: () => LspManager): void {
  pi.registerTool({
    name: "lsp_query",
    label: "LSP Query",
    description: `Inspect or navigate the exact symbol at a source position using hover, definition, declaration, type definition, implementation, or references. Lines and columns are 1-based. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES} bytes.`,
    promptSnippet: "Inspect types and navigate definitions, implementations, or references with LSP",
    parameters: queryParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.operation !== "references" && params.includeDeclaration !== undefined) {
        throw new Error("includeDeclaration is only valid for the references operation.");
      }

      const response = await getManager().query(
        params.operation,
        params.path,
        params.line,
        params.column,
        params.includeDeclaration ?? true,
        signal,
      );
      const formatted = response.operation === "hover"
        ? await formatHover(response.value as Hover | null)
        : await formatNavigation(
          response.value as NavigationResult,
          ctx.cwd,
          `lsp-${operationPrefix(response.operation)}`,
        );

      return {
        content: [{ type: "text", text: formatted.text }],
        details: detailsFor(formatted, {
          operation: response.operation,
          server: response.server,
          root: response.root,
          path: response.filePath,
          line: params.line,
          column: params.column,
        }),
      };
    },
  });

  pi.registerTool({
    name: "lsp_symbols",
    label: "LSP Symbols",
    description: `List symbols declared in a file, or search workspace declarations by name. path always selects the language and workspace; omit query for a document outline. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES} bytes.`,
    promptSnippet: "List document symbols or search workspace declarations with LSP",
    parameters: symbolsParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const response = await getManager().symbols(params.path, params.query, signal);
      const formatted = await formatSymbols(
        response.value,
        URI.file(response.filePath).toString(),
        ctx.cwd,
      );
      return {
        content: [{ type: "text", text: formatted.text }],
        details: detailsFor(formatted, {
          scope: response.scope,
          query: params.query,
          server: response.server,
          root: response.root,
          path: response.filePath,
        }),
      };
    },
  });

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: `Read language-server diagnostics for one file, optionally filtered to one severity. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES} bytes.`,
    promptSnippet: "Read errors, warnings, and other file diagnostics from LSP",
    parameters: diagnosticsParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const response = await getManager().diagnostics(params.path, signal);
      const formatted = await formatDiagnostics(
        response.diagnostics,
        response.filePath,
        ctx.cwd,
        params.severity,
      );
      return {
        content: [{ type: "text", text: formatted.text }],
        details: detailsFor(formatted, {
          severity: params.severity,
          fresh: response.fresh,
          source: response.source,
          server: response.server,
          root: response.root,
          path: response.filePath,
        }),
      };
    },
  });
}

function operationPrefix(operation: QueryOperation): string {
  return operation.replaceAll("_", "-");
}

function detailsFor<T, M extends Record<string, unknown>>(
  formatted: FormattedLspOutput<T>,
  metadata: M,
): M & Record<string, unknown> {
  return {
    ...metadata,
    count: formatted.count,
    items: formatted.items.slice(0, MAX_DETAIL_ITEMS),
    detailsTruncated: formatted.items.length > MAX_DETAIL_ITEMS,
    outputTruncated: formatted.truncation.truncated,
    totalLines: formatted.truncation.totalLines,
    totalBytes: formatted.truncation.totalBytes,
    fullOutputPath: formatted.fullOutputPath,
  };
}
