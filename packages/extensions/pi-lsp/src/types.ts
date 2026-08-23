import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";

export type QueryOperation =
  | "hover"
  | "definition"
  | "declaration"
  | "type_definition"
  | "implementation"
  | "references";

export interface ServerLaunch {
  command: string;
  args: string[];
  cwd: string;
  cleanup?: () => Promise<void>;
}

export interface LanguageServerDefinition {
  id: string;
  displayName: string;
  extensions: Readonly<Record<string, string>>;
  detectLanguageRoot?: (filePath: string, cwd: string) => Promise<string | undefined>;
  requiresBazel?: boolean;
  launch: (root: string) => Promise<ServerLaunch>;
  initializationOptions?: unknown;
  initializationTimeoutMs?: number;
  requestTimeoutMs?: number;
  diagnosticsWaitMs?: number;
}

export interface ResolvedLanguage {
  definition: LanguageServerDefinition;
  languageId: string;
  filePath: string;
  root: string;
}

export type LspManagerStatus =
  | { state: "idle" }
  | { state: "starting"; language: string }
  | { state: "ready"; count: number }
  | { state: "error"; language: string };

export interface SyncedDocument {
  uri: string;
  filePath: string;
  languageId: string;
  text: string;
  version: number;
}

export type NavigationResult = Location | LocationLink | Array<Location | LocationLink> | null;

export type SymbolsResult = DocumentSymbol[] | SymbolInformation[] | WorkspaceSymbol[] | null;

export interface DiagnosticsResult {
  diagnostics: Diagnostic[];
  fresh: boolean;
  source: "pull" | "push" | "cache";
}

export interface QueryResponse {
  operation: QueryOperation;
  value: Hover | NavigationResult;
  filePath: string;
  server: string;
  root: string;
}

export interface SymbolsResponse {
  value: SymbolsResult;
  scope: "document" | "workspace";
  filePath: string;
  server: string;
  root: string;
}

export interface DiagnosticsResponse extends DiagnosticsResult {
  filePath: string;
  server: string;
  root: string;
}
