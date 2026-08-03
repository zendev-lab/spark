export type CodeSymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "method"
  | "variable"
  | "module";

export interface VersionedReadLocator {
  path: string;
  offset: number;
  limit: number;
  artifactRef?: `artifact:${string}`;
}

export interface CodeSymbol {
  id: string;
  workspaceRoot: string;
  revisionDigest: string;
  path: string;
  name: string;
  kind: CodeSymbolKind;
  startLine: number;
  endLine: number;
  source: string;
  confidence: number;
  read: VersionedReadLocator;
}

export interface CodeGraphEdge {
  id: string;
  workspaceRoot: string;
  revisionDigest: string;
  fromPath: string;
  toPath?: string;
  fromSymbol?: string;
  toSymbol?: string;
  kind: "imports" | "calls" | "references" | "implements";
  source: string;
  confidence: number;
}

export interface StructuralMatch {
  path: string;
  startLine: number;
  endLine: number;
  kind: string;
  source: "@ast-grep/napi";
  read: VersionedReadLocator;
}
