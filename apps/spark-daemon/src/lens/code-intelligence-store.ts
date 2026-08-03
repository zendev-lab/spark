import type { DatabaseSync } from "node:sqlite";

import type { CodeGraphEdge, CodeSymbol } from "@zendev-lab/spark-lens";

interface MetaRow {
  revision_digest: string;
}

interface SymbolRow {
  workspace_root: string;
  symbol_id: string;
  revision_digest: string;
  path: string;
  name: string;
  kind: CodeSymbol["kind"];
  start_line: number;
  end_line: number;
  source: string;
  confidence: number;
}

interface EdgeRow {
  workspace_root: string;
  edge_id: string;
  revision_digest: string;
  from_path: string;
  to_path: string | null;
  from_symbol: string | null;
  to_symbol: string | null;
  kind: CodeGraphEdge["kind"];
  source: string;
  confidence: number;
}

interface FileRow {
  path: string;
  content_digest: string;
}

export class DaemonLensCodeIntelligenceStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  currentRevision(workspaceRoot: string): string | undefined {
    return (
      this.#db
        .prepare(`SELECT revision_digest FROM lens_code_graph_meta WHERE workspace_root = ?`)
        .get(workspaceRoot) as MetaRow | undefined
    )?.revision_digest;
  }

  fileDigests(workspaceRoot: string): Map<string, string> {
    const rows = this.#db
      .prepare(`SELECT path, content_digest FROM lens_code_files WHERE workspace_root = ?`)
      .all(workspaceRoot) as unknown as FileRow[];
    return new Map(rows.map((row) => [row.path, row.content_digest]));
  }

  replacePaths(input: {
    workspaceRoot: string;
    revisionDigest: string;
    paths: readonly string[];
    fileDigests: ReadonlyMap<string, string>;
    symbols: readonly CodeSymbol[];
    edges: readonly CodeGraphEdge[];
  }): void {
    const previous = this.currentRevision(input.workspaceRoot);
    const updateSymbols = this.#db.prepare(
      `UPDATE lens_code_symbols SET revision_digest = ?
       WHERE workspace_root = ? AND revision_digest = ?`,
    );
    const updateEdges = this.#db.prepare(
      `UPDATE lens_code_edges SET revision_digest = ?
       WHERE workspace_root = ? AND revision_digest = ?`,
    );
    const updateFiles = this.#db.prepare(
      `UPDATE lens_code_files SET revision_digest = ?
       WHERE workspace_root = ? AND revision_digest = ?`,
    );
    const deleteSymbols = this.#db.prepare(
      `DELETE FROM lens_code_symbols WHERE workspace_root = ? AND path = ?`,
    );
    const deleteEdges = this.#db.prepare(
      `DELETE FROM lens_code_edges
       WHERE workspace_root = ? AND (from_path = ? OR to_path = ?)`,
    );
    const deleteFile = this.#db.prepare(
      `DELETE FROM lens_code_files WHERE workspace_root = ? AND path = ?`,
    );
    const insertFile = this.#db.prepare(
      `INSERT INTO lens_code_files (
         workspace_root, path, revision_digest, content_digest
       ) VALUES (?, ?, ?, ?)`,
    );
    const insertSymbol = this.#db.prepare(
      `INSERT INTO lens_code_symbols (
         workspace_root, symbol_id, revision_digest, path, name, kind,
         start_line, end_line, source, confidence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = this.#db.prepare(
      `INSERT INTO lens_code_edges (
         workspace_root, edge_id, revision_digest, from_path, to_path,
         from_symbol, to_symbol, kind, source, confidence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (previous && previous !== input.revisionDigest) {
        updateSymbols.run(input.revisionDigest, input.workspaceRoot, previous);
        updateEdges.run(input.revisionDigest, input.workspaceRoot, previous);
        updateFiles.run(input.revisionDigest, input.workspaceRoot, previous);
      }
      for (const path of new Set(input.paths)) {
        deleteSymbols.run(input.workspaceRoot, path);
        deleteEdges.run(input.workspaceRoot, path, path);
        deleteFile.run(input.workspaceRoot, path);
        const contentDigest = input.fileDigests.get(path);
        if (contentDigest) {
          insertFile.run(input.workspaceRoot, path, input.revisionDigest, contentDigest);
        }
      }
      for (const symbol of input.symbols) {
        insertSymbol.run(
          symbol.workspaceRoot,
          symbol.id,
          symbol.revisionDigest,
          symbol.path,
          symbol.name,
          symbol.kind,
          symbol.startLine,
          symbol.endLine,
          symbol.source,
          symbol.confidence,
        );
      }
      for (const edge of input.edges) {
        insertEdge.run(
          edge.workspaceRoot,
          edge.id,
          edge.revisionDigest,
          edge.fromPath,
          edge.toPath ?? null,
          edge.fromSymbol ?? null,
          edge.toSymbol ?? null,
          edge.kind,
          edge.source,
          edge.confidence,
        );
      }
      this.#db
        .prepare(
          `INSERT INTO lens_code_graph_meta (workspace_root, revision_digest, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(workspace_root) DO UPDATE SET
             revision_digest = excluded.revision_digest,
             updated_at = excluded.updated_at`,
        )
        .run(input.workspaceRoot, input.revisionDigest, new Date().toISOString());
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  searchSymbols(
    workspaceRoot: string,
    revisionDigest: string,
    query: string,
    limit: number,
  ): CodeSymbol[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM lens_code_symbols
         WHERE workspace_root = ? AND revision_digest = ? AND name LIKE ? ESCAPE '\\'
         ORDER BY CASE WHEN lower(name) = lower(?) THEN 0
                       WHEN lower(name) LIKE lower(?) THEN 1 ELSE 2 END,
                  length(name), path, start_line
         LIMIT ?`,
      )
      .all(
        workspaceRoot,
        revisionDigest,
        `%${escapeLike(query)}%`,
        query,
        `${escapeLike(query)}%`,
        limit,
      ) as unknown as SymbolRow[];
    return rows.map(symbolFromRow);
  }

  outline(workspaceRoot: string, revisionDigest: string, path: string): CodeSymbol[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM lens_code_symbols
         WHERE workspace_root = ? AND revision_digest = ? AND path = ?
         ORDER BY start_line, end_line`,
      )
      .all(workspaceRoot, revisionDigest, path) as unknown as SymbolRow[];
    return rows.map(symbolFromRow);
  }

  impact(workspaceRoot: string, revisionDigest: string, path: string): CodeGraphEdge[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM lens_code_edges
         WHERE workspace_root = ? AND revision_digest = ?
           AND (from_path = ? OR to_path = ?)
         ORDER BY kind, from_path, to_path`,
      )
      .all(workspaceRoot, revisionDigest, path, path) as unknown as EdgeRow[];
    return rows.map(edgeFromRow);
  }

  reverseDependencyPaths(
    workspaceRoot: string,
    revisionDigest: string,
    paths: readonly string[],
  ): string[] {
    if (paths.length === 0) return [];
    const pending = [...new Set(paths)];
    const visited = new Set(pending);
    const select = this.#db.prepare(
      `SELECT from_path FROM lens_code_edges
       WHERE workspace_root = ? AND revision_digest = ? AND kind = 'imports' AND to_path = ?`,
    );
    while (pending.length > 0) {
      const target = pending.shift()!;
      const rows = select.all(workspaceRoot, revisionDigest, target) as Array<{
        from_path: string;
      }>;
      for (const row of rows) {
        if (visited.has(row.from_path)) continue;
        visited.add(row.from_path);
        pending.push(row.from_path);
      }
    }
    return [...visited];
  }
}

function symbolFromRow(row: SymbolRow): CodeSymbol {
  return {
    id: row.symbol_id,
    workspaceRoot: row.workspace_root,
    revisionDigest: row.revision_digest,
    path: row.path,
    name: row.name,
    kind: row.kind,
    startLine: row.start_line,
    endLine: row.end_line,
    source: row.source,
    confidence: row.confidence,
    read: {
      path: row.path,
      offset: row.start_line + 1,
      limit: Math.max(1, row.end_line - row.start_line + 1),
    },
  };
}

function edgeFromRow(row: EdgeRow): CodeGraphEdge {
  return {
    id: row.edge_id,
    workspaceRoot: row.workspace_root,
    revisionDigest: row.revision_digest,
    fromPath: row.from_path,
    ...(row.to_path ? { toPath: row.to_path } : {}),
    ...(row.from_symbol ? { fromSymbol: row.from_symbol } : {}),
    ...(row.to_symbol ? { toSymbol: row.to_symbol } : {}),
    kind: row.kind,
    source: row.source,
    confidence: row.confidence,
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
