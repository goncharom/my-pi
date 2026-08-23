import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  Range,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import type { NavigationResult, SymbolsResult } from "./types";

export interface FormattedLspOutput<T> {
  text: string;
  count: number;
  items: T[];
  truncation: TruncationResult;
  fullOutputPath?: string;
}

export interface NormalizedLocation {
  uri: string;
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  preview?: string;
}

export interface NormalizedSymbol {
  name: string;
  kind: string;
  container?: string;
  detail?: string;
  location?: NormalizedLocation;
}

export interface NormalizedDiagnostic {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
  code?: string;
  related: NormalizedLocation[];
}

export async function formatHover(hover: Hover | null, prefix = "lsp-hover"): Promise<FormattedLspOutput<never>> {
  const output = hover ? hoverContents(hover.contents).trim() : "";
  return finalizeOutput(output || "No hover information.", [], prefix);
}

export async function formatNavigation(
  result: NavigationResult,
  cwd: string,
  prefix: string,
): Promise<FormattedLspOutput<NormalizedLocation>> {
  const values = result === null ? [] : Array.isArray(result) ? result : [result];
  const locations = await normalizeLocations(values, cwd);
  const output = locations.length === 0
    ? "No locations found."
    : locations.map((location) => formatLocation(location)).join("\n");
  return finalizeOutput(output, locations, prefix);
}

export async function formatSymbols(
  result: SymbolsResult,
  documentUri: string,
  cwd: string,
): Promise<FormattedLspOutput<NormalizedSymbol>> {
  const symbols = await normalizeSymbols(result ?? [], documentUri, cwd);
  const output = symbols.length === 0
    ? "No symbols found."
    : symbols.map((symbol) => {
      const location = symbol.location ? formatLocation(symbol.location, false) : "(unresolved)";
      const container = symbol.container ? ` in ${symbol.container}` : "";
      const detail = symbol.detail ? ` — ${singleLine(symbol.detail)}` : "";
      return `${symbol.kind} ${symbol.name}${container} · ${location}${detail}`;
    }).join("\n");
  return finalizeOutput(output, symbols, "lsp-symbols");
}

export async function formatDiagnostics(
  diagnostics: Diagnostic[],
  filePath: string,
  cwd: string,
  severity?: NormalizedDiagnostic["severity"],
): Promise<FormattedLspOutput<NormalizedDiagnostic>> {
  const mainPath = displayPath(filePath, cwd);
  const normalized: NormalizedDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const diagnosticSeverity = severityName(diagnostic.severity);
    if (severity && severity !== diagnosticSeverity) continue;
    const related = await normalizeLocations(
      (diagnostic.relatedInformation ?? []).map((information) => information.location),
      cwd,
    );
    normalized.push({
      path: mainPath,
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      endLine: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
      severity: diagnosticSeverity,
      message: typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value,
      source: diagnostic.source,
      code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
      related,
    });
  }

  const rank = { error: 0, warning: 1, information: 2, hint: 3 } as const;
  normalized.sort((left, right) =>
    rank[left.severity] - rank[right.severity]
    || left.line - right.line
    || left.column - right.column,
  );

  const output = normalized.length === 0
    ? severity ? `No ${severity} diagnostics.` : "No diagnostics."
    : normalized.map((diagnostic) => {
      const source = [diagnostic.source, diagnostic.code].filter(Boolean).join(":");
      const header = `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} [${diagnostic.severity}]${source ? ` (${source})` : ""}`;
      const related = diagnostic.related.length === 0
        ? ""
        : `\n${diagnostic.related.map((location) => `  related: ${formatLocation(location, false)}`).join("\n")}`;
      return `${header} ${singleLine(diagnostic.message)}${related}`;
    }).join("\n");

  return finalizeOutput(output, normalized, "lsp-diagnostics");
}

async function normalizeLocations(
  values: Array<Location | LocationLink>,
  cwd: string,
): Promise<NormalizedLocation[]> {
  const seen = new Set<string>();
  const locations: NormalizedLocation[] = [];
  const sourceCache = new Map<string, string[] | undefined>();

  for (const value of values) {
    const isLink = "targetUri" in value;
    const uri = isLink ? value.targetUri : value.uri;
    const range = isLink ? value.targetSelectionRange ?? value.targetRange : value.range;
    const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const filePath = filePathFromUri(uri);
    const location: NormalizedLocation = {
      uri,
      path: filePath ? displayPath(filePath, cwd) : uri,
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
    };
    if (filePath) {
      const lines = await sourceLines(filePath, sourceCache);
      location.preview = lines?.[range.start.line]?.trim();
    }
    locations.push(location);
  }

  locations.sort((left, right) =>
    left.path.localeCompare(right.path)
    || (left.line ?? 0) - (right.line ?? 0)
    || (left.column ?? 0) - (right.column ?? 0),
  );
  return locations;
}

async function normalizeSymbols(
  values: Array<DocumentSymbol | SymbolInformation | WorkspaceSymbol>,
  documentUri: string,
  cwd: string,
): Promise<NormalizedSymbol[]> {
  const symbols: NormalizedSymbol[] = [];
  const sourceCache = new Map<string, string[] | undefined>();

  const addDocumentSymbol = async (symbol: DocumentSymbol, parent?: string): Promise<void> => {
    const location = await locationFromUriRange(documentUri, symbol.selectionRange, cwd, sourceCache);
    symbols.push({
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      container: parent,
      detail: symbol.detail,
      location,
    });
    for (const child of symbol.children ?? []) await addDocumentSymbol(child, symbol.name);
  };

  for (const value of values) {
    if ("selectionRange" in value) {
      await addDocumentSymbol(value);
      continue;
    }

    const locationValue = value.location;
    const range = "range" in locationValue ? locationValue.range : undefined;
    const location = range
      ? await locationFromUriRange(locationValue.uri, range, cwd, sourceCache)
      : { uri: locationValue.uri, path: displayUri(locationValue.uri, cwd) };
    symbols.push({
      name: value.name,
      kind: symbolKindName(value.kind),
      container: value.containerName,
      location,
    });
  }
  return symbols;
}

async function locationFromUriRange(
  uri: string,
  range: Range,
  cwd: string,
  sourceCache: Map<string, string[] | undefined>,
): Promise<NormalizedLocation> {
  const filePath = filePathFromUri(uri);
  const location: NormalizedLocation = {
    uri,
    path: filePath ? displayPath(filePath, cwd) : uri,
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
  if (filePath) location.preview = (await sourceLines(filePath, sourceCache))?.[range.start.line]?.trim();
  return location;
}

function hoverContents(contents: Hover["contents"]): string {
  if (Array.isArray(contents)) return contents.map(markedString).join("\n\n");
  if (typeof contents === "string") return contents;
  if ("kind" in contents) return (contents as MarkupContent).value;
  return markedString(contents as MarkedString);
}

function markedString(value: MarkedString): string {
  if (typeof value === "string") return value;
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}

function formatLocation(location: NormalizedLocation, includePreview = true): string {
  const position = location.line === undefined
    ? location.path
    : `${location.path}:${location.line}:${location.column ?? 1}`;
  return includePreview && location.preview ? `${position} — ${singleLine(location.preview)}` : position;
}

function displayUri(uri: string, cwd: string): string {
  const filePath = filePathFromUri(uri);
  return filePath ? displayPath(filePath, cwd) : uri;
}

function displayPath(filePath: string, cwd: string): string {
  const candidate = relative(cwd, filePath);
  if (!candidate) return ".";
  if (!candidate.startsWith("..") && !isAbsolute(candidate)) return candidate;
  return filePath;
}

function filePathFromUri(uri: string): string | undefined {
  try {
    const parsed = URI.parse(uri);
    return parsed.scheme === "file" ? parsed.fsPath : undefined;
  } catch {
    return undefined;
  }
}

async function sourceLines(
  filePath: string,
  cache: Map<string, string[] | undefined>,
): Promise<string[] | undefined> {
  if (cache.has(filePath)) return cache.get(filePath);
  try {
    const lines = (await readFile(filePath, "utf8")).split(/\r\n|\n|\r/);
    cache.set(filePath, lines);
    return lines;
  } catch {
    cache.set(filePath, undefined);
    return undefined;
  }
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function severityName(severity: Diagnostic["severity"]): NormalizedDiagnostic["severity"] {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 4: return "hint";
    default: return "information";
  }
}

function symbolKindName(kind: number): string {
  return [
    "Unknown", "File", "Module", "Namespace", "Package", "Class", "Method", "Property",
    "Field", "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String",
    "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct", "Event",
    "Operator", "TypeParameter",
  ][kind] ?? `Symbol(${kind})`;
}

async function finalizeOutput<T>(
  output: string,
  items: T[],
  prefix: string,
): Promise<FormattedLspOutput<T>> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { text: truncation.content, count: items.length, items, truncation };
  }

  const directory = await mkdtemp(join(tmpdir(), `pi-${prefix}-`));
  const fullOutputPath = join(directory, "output.txt");
  await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, output, "utf8"));
  const notice = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines `
    + `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). `
    + `Full output saved to: ${fullOutputPath}]`;
  return {
    text: `${truncation.content}\n\n${notice}`,
    count: items.length,
    items,
    truncation,
    fullOutputPath,
  };
}
