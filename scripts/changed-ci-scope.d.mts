export interface CiWorkspace {
  name: string;
  path: string;
  dependencies: string[];
}

export interface CiScope {
  files: string[];
  reason: string;
  docsOnly: boolean;
  full: boolean;
  runSource: boolean;
  runMacos: boolean;
  runProcess: boolean;
  runBrowser: boolean;
  changedWorkspaces: string[];
  affectedWorkspaces: string[];
}

export function classifyCiScope(files: string[], workspaces: CiWorkspace[]): CiScope;
export function loadWorkspaceCatalog(root?: string): CiWorkspace[];
