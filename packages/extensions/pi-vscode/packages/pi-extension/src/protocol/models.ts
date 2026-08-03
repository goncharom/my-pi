export interface SerializedRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ReviewComment {
  id: string;
  kind: "plan" | "code";
  body: string;
  status: "unresolved" | "sent" | "resolved";
  anchor: PlanAnchor | CodeAnchor;
}

export interface PlanAnchor {
  kind: "plan";
  planId: string;
  planVersion: number;
  documentHash: string;
  range: SerializedRange;
  selectedText: string;
  linesBefore: string[];
  linesAfter: string[];
}

export interface CodeAnchor {
  kind: "code";
  documentUri: string;
  repositoryRoot?: string;
  relativePath?: string;
  side: "original" | "modified";
  originalRef?: string;
  modifiedRef?: string;
  documentHash: string;
  range: SerializedRange;
  selectedText: string;
  linesBefore: string[];
  linesAfter: string[];
}
