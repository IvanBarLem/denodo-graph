/**
 * The graph webview controller.
 *
 * Owns a single reusable webview panel and the currently-loaded VqlGraph. It
 * decides between two rendering modes:
 *
 *  - `full`  : the whole graph is streamed to the webview (small/medium scripts)
 *  - `focus` : too many nodes to draw at once -> the webview shows search, and
 *              the host answers with matching nodes and BFS neighbourhoods.
 *
 * Heavy data (fields, per-node dependency lists) is only sent on demand when a
 * node is selected, keeping the initial payload small even for large graphs.
 */

import * as vscode from 'vscode';
import { ElementKind, KIND_LABEL, VqlElement, VqlGraph } from '../parser/model';
import { buildGraph } from '../graph/graphBuilder';
import { buildLineIndex, offsetToLine } from '../parser/scanner';
import { readVqlSource } from '../util/readSource';

interface LiteNode {
  id: string;
  label: string;
  kind: ElementKind;
  defined: boolean;
  folder?: string;
  subtype?: string;
  database?: string;
}
interface LiteEdge {
  source: string;
  target: string;
}

export class GraphPanel {
  private static current: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private graph: VqlGraph | undefined;
  private docUri: vscode.Uri | undefined;
  private ready = false;
  private pending: (() => void) | undefined;
  private diagnostics: vscode.DiagnosticCollection | undefined;

  static show(context: vscode.ExtensionContext, uri: vscode.Uri, diagnostics: vscode.DiagnosticCollection) {
    const column = vscode.ViewColumn.Beside;
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(column);
      void GraphPanel.current.load(uri, diagnostics);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'denodoVqlGraph',
      'Denodo VQL Graph',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    GraphPanel.current = new GraphPanel(context, panel);
    void GraphPanel.current.load(uri, diagnostics);
  }

  /** Read VQL source (disk-first, bypassing the 50 MB editor-sync limit). */
  private readSource(uri: vscode.Uri): Promise<string> {
    return readVqlSource(uri);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
  }

  private async load(uri: vscode.Uri, diagnostics: vscode.DiagnosticCollection) {
    this.docUri = uri;
    this.diagnostics = diagnostics;
    const cfg = vscode.workspace.getConfiguration('denodoVqlGraph');

    this.panel.title = `Graph: ${shortName(uri)}`;

    // Reload the webview HTML every time so the latest media/main.js is used
    // (a retained webview would otherwise keep a stale script). We then wait for
    // the webview's 'ready' message before sending data to avoid a race where
    // messages are posted before the script's listener is attached.
    this.ready = false;
    this.pending = undefined;
    this.panel.webview.html = this.html();

    // Read the source from disk (bypasses the editor's 50 MB sync limit). The
    // await also yields, letting the webview load and paint its initial state
    // before the parse runs on the extension host thread (a single linear pass).
    let text: string;
    try {
      text = await this.readSource(uri);
    } catch (err) {
      this.post({ type: 'error', message: `Could not read ${shortName(uri)}: ${String(err)}` });
      return;
    }

    const graph = buildGraph(text);
    this.graph = graph;

    if (cfg.get<boolean>('reportMissingViews', true)) {
      this.publishDiagnostics(uri, graph, text, diagnostics);
    } else {
      diagnostics.delete(uri);
    }

    const max = cfg.get<number>('maxRenderNodes', 2500);
    const depth = cfg.get<number>('neighbourhoodDepth', 2);
    const mode: 'full' | 'focus' = graph.elements.size <= max ? 'full' : 'focus';

    const send = () => {
      this.post({ type: 'init', mode, stats: graph.stats, neighbourhoodDepth: depth, maxRenderNodes: max });
      if (mode === 'full') {
        const { nodes, edges } = this.fullPayload();
        this.post({ type: 'graph', nodes, edges });
      }
    };

    // If the webview already signalled ready, send now; otherwise queue it.
    if (this.ready) send();
    else this.pending = send;
  }

  private onMessage(msg: any) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'ready':
        // The webview's script has attached its message listener. Flush any
        // payload that was computed before the webview finished loading.
        this.ready = true;
        if (this.pending) {
          const p = this.pending;
          this.pending = undefined;
          p();
        }
        break;
      case 'selectNode':
        this.sendDetails(msg.id);
        break;
      case 'reveal':
        this.reveal(msg.id);
        break;
      case 'selectAndReveal':
        this.sendDetails(msg.id);
        this.reveal(msg.id);
        break;
      case 'search':
        this.post({ type: 'searchResults', query: msg.query, results: this.search(msg.query, 60) });
        break;
      case 'focus':
        this.post({ type: 'subgraph', center: msg.id, ...this.subgraph([msg.id], msg.depth ?? 2, 1500) });
        break;
      case 'expand':
        this.post({ type: 'subgraph', center: msg.id, ...this.subgraph([msg.id], 1, 800), merge: true });
        break;
      case 'isolate':
        this.post({ type: 'subgraph', center: msg.id, isolated: true, ...this.upstreamClosure(msg.id) });
        break;
      case 'copyVql':
        this.copyVql(msg.id, !!msg.withDeps);
        break;
      case 'reload':
        this.reloadCurrent();
        break;
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'denodoVqlGraph');
        break;
    }
  }

  // ---- payload builders -------------------------------------------------

  private lite(el: VqlElement): LiteNode {
    return {
      id: el.id,
      label: el.name,
      kind: el.kind,
      defined: el.defined,
      folder: el.folder,
      subtype: el.subtype,
      database: el.database
    };
  }

  private fullPayload(): { nodes: LiteNode[]; edges: LiteEdge[] } {
    const g = this.graph!;
    const nodes: LiteNode[] = [];
    const edges: LiteEdge[] = [];
    for (const el of g.elements.values()) {
      nodes.push(this.lite(el));
      for (const dep of el.deps) {
        // data-flow direction: dependency (upstream) -> element (downstream)
        edges.push({ source: dep.ref, target: el.id });
      }
    }
    return { nodes, edges };
  }

  private search(query: string, limit: number): LiteNode[] {
    const g = this.graph;
    if (!g || !query) return [];
    const q = query.toLowerCase();
    const out: LiteNode[] = [];
    for (const el of g.elements.values()) {
      if (el.id.toLowerCase().includes(q)) {
        out.push(this.lite(el));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  private subgraph(seeds: string[], depth: number, maxNodes: number): { nodes: LiteNode[]; edges: LiteEdge[] } {
    const g = this.graph!;
    const visited = new Set<string>();
    let frontier = seeds.filter((s) => g.elements.has(s));
    for (const s of frontier) visited.add(s);

    for (let d = 0; d < depth && visited.size < maxNodes; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const el = g.elements.get(id);
        if (!el) continue;
        // upstream (this node's dependencies)
        for (const dep of el.deps) {
          if (!visited.has(dep.ref) && visited.size < maxNodes) {
            visited.add(dep.ref);
            next.push(dep.ref);
          }
        }
        // downstream (things depending on this node)
        for (const dn of g.dependents.get(id) ?? []) {
          if (!visited.has(dn) && visited.size < maxNodes) {
            visited.add(dn);
            next.push(dn);
          }
        }
      }
      frontier = next;
    }

    const nodes: LiteNode[] = [];
    const edges: LiteEdge[] = [];
    for (const id of visited) {
      const el = g.elements.get(id);
      if (!el) continue;
      nodes.push(this.lite(el));
      for (const dep of el.deps) {
        if (visited.has(dep.ref)) edges.push({ source: dep.ref, target: el.id });
      }
    }
    return { nodes, edges };
  }

  /**
   * The isolated lineage of an element: the element plus its entire upstream
   * dependency tree, transitively, down to the data sources. Unlike `subgraph`
   * this follows dependencies only (never dependents) and has no depth limit,
   * so it captures the whole path feeding into the element — which is what makes
   * it useful for analysing a single path in a crowded graph. Capped at
   * `maxNodes` so a pathological lineage can't blow up the render.
   */
  private upstreamClosure(
    id: string,
    maxNodes = 5000
  ): { nodes: LiteNode[]; edges: LiteEdge[]; truncated: boolean } {
    const g = this.graph!;
    if (!g.elements.has(id)) return { nodes: [], edges: [], truncated: false };

    const visited = new Set<string>([id]);
    const stack = [id];
    let truncated = false;
    while (stack.length) {
      const el = g.elements.get(stack.pop()!);
      if (!el) continue;
      for (const dep of el.deps) {
        if (visited.has(dep.ref)) continue;
        if (visited.size >= maxNodes) {
          truncated = true;
          continue;
        }
        visited.add(dep.ref);
        stack.push(dep.ref);
      }
    }

    const nodes: LiteNode[] = [];
    const edges: LiteEdge[] = [];
    for (const nid of visited) {
      const el = g.elements.get(nid);
      if (!el) continue;
      nodes.push(this.lite(el));
      for (const dep of el.deps) {
        if (visited.has(dep.ref)) edges.push({ source: dep.ref, target: el.id });
      }
    }
    return { nodes, edges, truncated };
  }

  private sendDetails(id: string) {
    const g = this.graph;
    if (!g) return;
    const el = g.elements.get(id);
    if (!el) return;
    const resolve = (rid: string) => {
      const r = g.elements.get(rid);
      return { id: rid, kind: r?.kind ?? 'unknown', defined: r?.defined ?? false };
    };
    const detail = {
      id: el.id,
      name: el.name,
      kind: el.kind,
      kindLabel: KIND_LABEL[el.kind],
      subtype: el.subtype,
      database: el.database,
      folder: el.folder,
      defined: el.defined,
      line: el.line,
      fields: el.fields,
      dependsOn: el.deps.map((d) => resolve(d.ref)),
      usedBy: (g.dependents.get(id) ?? []).map(resolve)
    };
    this.post({ type: 'details', detail });
  }

  // ---- editor integration ----------------------------------------------

  private async reveal(id: string) {
    const g = this.graph;
    if (!g || !this.docUri) return;
    const el = g.elements.get(id);
    if (!el || !el.defined) return;
    try {
      const doc = await vscode.workspace.openTextDocument(this.docUri);
      const pos = doc.positionAt(el.offset);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
      });
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch {
      // Files above the editor's 50 MB limit cannot be opened as a text editor,
      // so navigation isn't possible — tell the user where the definition is.
      vscode.window.showInformationMessage(
        `"${el.name}" is at line ${el.line} — the file is too large for VS Code to open in the editor.`
      );
    }
  }

  private async reloadCurrent() {
    if (!this.docUri || !this.diagnostics) return;
    void this.load(this.docUri, this.diagnostics);
  }

  /** Copy the VQL for an element, optionally with its whole upstream lineage. */
  private async copyVql(id: string, withDeps: boolean) {
    const g = this.graph;
    if (!g || !this.docUri) return;
    const el = g.elements.get(id);
    if (!el || !el.defined) {
      vscode.window.showWarningMessage(`Denodo VQL Graph: "${id}" is not defined in this file, nothing to copy.`);
      return;
    }
    let src: string;
    try {
      src = await this.readSource(this.docUri);
    } catch {
      return;
    }

    if (!withDeps) {
      await vscode.env.clipboard.writeText(stmt(src, el));
      vscode.window.showInformationMessage(`Copied VQL for "${el.name}".`);
      return;
    }

    const built = this.buildDepVql(id, src);
    await vscode.env.clipboard.writeText(built.text);
    const bits = [`${built.elementCount} element${built.elementCount === 1 ? '' : 's'}`];
    if (built.folderCount) bits.push(`${built.folderCount} folder${built.folderCount === 1 ? '' : 's'}`);
    if (built.typeCount) bits.push(`${built.typeCount} type${built.typeCount === 1 ? '' : 's'}`);
    if (built.missing.length) bits.push(`${built.missing.length} missing skipped`);
    vscode.window.showInformationMessage(`Copied importable VQL for "${el.name}" + dependencies (${bits.join(', ')}).`);
  }

  /**
   * Build the VQL for an element and its entire upstream path down to the data
   * sources, in valid execution order (dependencies first). Required CREATE TYPE
   * definitions are prepended. Missing (undefined) references are skipped and
   * reported to the caller.
   */
  private buildDepVql(
    id: string,
    src: string
  ): { text: string; elementCount: number; typeCount: number; folderCount: number; missing: string[] } {
    const g = this.graph!;
    const order: VqlElement[] = [];
    const visited = new Set<string>();
    const missing = new Set<string>();

    // Post-order DFS over dependencies => a dependency always precedes its
    // dependents in `order`.
    const dfs = (nid: string) => {
      if (visited.has(nid)) return;
      visited.add(nid);
      const el = g.elements.get(nid);
      if (!el) return;
      for (const dep of el.deps) dfs(dep.ref);
      if (el.defined) order.push(el);
      else missing.add(el.id);
    };
    dfs(id);

    // Dependencies can span several databases (e.g. an association in `sales2`
    // whose endpoints live in `sales`). Emit one `CONNECT DATABASE` block per
    // database — each with its own folders and types — switching context as the
    // dependency order moves between databases, so nothing is recreated in the
    // wrong database.
    const NO_DB = '';
    const foldersFor = new Map<string, string[]>();
    const typesFor = new Map<string, string[]>();
    let folderCount = 0;
    let typeCount = 0;
    let anyNoDb = false;
    for (const el of order) {
      const key = el.database ?? NO_DB;
      if (!el.database) anyNoDb = true;
      if (!typesFor.has(key)) {
        const group = order.filter((e) => (e.database ?? NO_DB) === key);
        const types = this.collectRequiredTypes(group, src);
        const folders = this.collectFolders(group, types, src);
        typesFor.set(key, types);
        foldersFor.set(key, folders);
        typeCount += types.length;
        folderCount += folders.length;
      }
    }

    let header = `# VQL for "${id}" and its upstream dependencies\n`;
    if (anyNoDb) {
      header += `# WARNING: some elements have no CONNECT DATABASE context; set one before importing.\n`;
    }
    if (missing.size) {
      header += `# NOTE: skipped ${missing.size} undefined reference(s): ${Array.from(missing).join(', ')}\n`;
    }

    // Walk the dependency order, opening a new database block on each switch and
    // emitting that database's folders/types the first time it is entered.
    const parts: string[] = [];
    const opened = new Set<string>();
    let contextSet = false;
    let currentDb: string | undefined;
    for (const el of order) {
      const db = el.database;
      const key = db ?? NO_DB;
      if (!contextSet || db !== currentDb) {
        if (db) parts.push(`CONNECT DATABASE ${db};`);
        currentDb = db;
        contextSet = true;
      }
      if (!opened.has(key)) {
        opened.add(key);
        for (const f of foldersFor.get(key) ?? []) parts.push(f);
        for (const t of typesFor.get(key) ?? []) parts.push(t);
      }
      parts.push(stmt(src, el));
    }

    return {
      text: header + '\n' + parts.join('\n\n') + '\n',
      elementCount: order.length,
      typeCount,
      folderCount,
      missing: Array.from(missing)
    };
  }

  /**
   * Collect the CREATE FOLDER statements needed by the included elements/types,
   * expanded to include ancestor folders, ordered parents-first. Uses the
   * source's own CREATE FOLDER statement when present, else synthesizes an
   * idempotent `CREATE OR REPLACE FOLDER '<path>';`.
   */
  private collectFolders(elements: VqlElement[], typeStatements: string[], src: string): string[] {
    const g = this.graph!;
    const wanted = new Set<string>();

    const addPathWithAncestors = (raw: string | undefined) => {
      if (!raw) return;
      let p = raw.trim();
      if (!p) return;
      if (!p.startsWith('/')) p = '/' + p;
      p = p.replace(/\/+$/, '');
      const segs = p.split('/').filter((s) => s.length > 0);
      let cur = '';
      for (const s of segs) {
        cur += '/' + s;
        wanted.add(cur);
      }
    };

    for (const el of elements) addPathWithAncestors(el.folder);
    // Types may declare a FOLDER too; scan their emitted text.
    for (const t of typeStatements) {
      const m = /\bFOLDER\s*=\s*'((?:[^']|'')*)'/i.exec(t);
      if (m) addPathWithAncestors(m[1].replace(/''/g, "'"));
    }

    // Parents before children: sort by depth, then lexicographically.
    const ordered = Array.from(wanted).sort((a, b) => {
      const da = a.split('/').length;
      const db = b.split('/').length;
      return da - db || (a < b ? -1 : 1);
    });

    return ordered.map((path) => {
      const def = g.folders.get(path);
      if (def) return src.slice(def.offset, def.end).trim() + ';';
      return `CREATE OR REPLACE FOLDER '${path.replace(/'/g, "''")}';`;
    });
  }

  /**
   * Find the CREATE TYPE definitions required by the given elements' fields
   * (transitively, since types can reference other types) and return their VQL
   * in dependency order (referenced types first).
   */
  private collectRequiredTypes(elements: VqlElement[], src: string): string[] {
    const g = this.graph!;
    if (g.types.size === 0) return [];

    // Field types are stored lower-cased, so match case-insensitively.
    const byLower = new Map<string, string>();
    for (const name of g.types.keys()) byLower.set(name.toLowerCase(), name);

    const chosen = new Set<string>();
    const orderedNames: string[] = [];

    const add = (canonical: string) => {
      if (chosen.has(canonical)) return;
      chosen.add(canonical);
      const def = g.types.get(canonical)!;
      const body = src.slice(def.offset, def.end);
      // A type may reference other types in its body; include those first.
      for (const [lower, other] of byLower) {
        if (other === canonical) continue;
        if (new RegExp(`\\b${escapeRegExp(lower)}\\b`, 'i').test(body)) add(other);
      }
      orderedNames.push(canonical); // post-order: referenced types precede this one
    };

    for (const el of elements) {
      for (const f of el.fields) {
        if (!f.type) continue;
        const canonical = byLower.get(f.type.toLowerCase());
        if (canonical) add(canonical);
      }
    }

    return orderedNames.map((n) => {
      const def = g.types.get(n)!;
      return src.slice(def.offset, def.end).trim() + ';';
    });
  }

  private publishDiagnostics(uri: vscode.Uri, graph: VqlGraph, text: string, coll: vscode.DiagnosticCollection) {
    const byLine = new Map<number, string[]>();
    for (const el of graph.elements.values()) {
      if (!el.defined) continue;
      const missing = el.deps.filter((d) => {
        const t = graph.elements.get(d.ref);
        return t && !t.defined;
      });
      if (missing.length === 0) continue;
      const key = el.offset;
      const names = missing.map((d) => d.ref);
      byLine.set(key, (byLine.get(key) ?? []).concat(names));
    }

    // Positions are computed from our own line index rather than the TextDocument
    // so this works for files above the 50 MB editor-sync limit (which have no
    // synced document). Cap the count so a pathological file cannot flood the
    // Problems panel with hundreds of thousands of entries.
    const MAX_DIAGS = 2000;
    const lineStarts = buildLineIndex(text);
    const diags: vscode.Diagnostic[] = [];
    for (const [offset, refs] of byLine) {
      if (diags.length >= MAX_DIAGS) break;
      const line = offsetToLine(lineStarts, offset) - 1; // to 0-based
      const startCol = offset - lineStarts[line];
      const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
      const endCol = Math.max(startCol + 1, lineEnd - lineStarts[line]);
      const range = new vscode.Range(line, startCol, line, endCol);
      const unique = Array.from(new Set(refs));
      const d = new vscode.Diagnostic(
        range,
        `Denodo VQL: references undefined element${unique.length > 1 ? 's' : ''}: ${unique.join(', ')}`,
        vscode.DiagnosticSeverity.Warning
      );
      d.source = 'Denodo VQL Graph';
      diags.push(d);
    }
    coll.set(uri, diags);
  }

  // ---- webview plumbing -------------------------------------------------

  private post(msg: any) {
    this.panel.webview.postMessage(msg);
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = getNonce();
    const cssUri = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const jsUri = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const cytoUri = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'cytoscape.min.js'));
    const csp = [
      `default-src 'none'`,
      `img-src ${w.cspSource} data:`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${w.cspSource}`
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${cssUri}" rel="stylesheet" />
  <title>Denodo VQL Graph</title>
</head>
<body>
  <div id="toolbar">
    <div class="tb-group">
      <input id="search" type="search" placeholder="Search elements…" autocomplete="off" />
      <div id="searchResults" class="hidden"></div>
    </div>
    <div class="tb-group">
      <button id="typesBtn" class="dd-btn" aria-haspopup="true" aria-expanded="false" title="Show / hide element types">
        <span id="typesBtnLabel">Types</span><span class="caret">▾</span>
      </button>
      <div id="typesMenu" class="menu hidden"></div>
    </div>
    <div class="tb-group">
      <button id="designBtn" class="dd-btn" aria-haspopup="true" aria-expanded="false" title="Customize appearance (relations, node size, labels, boxes)">
        <span>Design</span><span class="caret">▾</span>
      </button>
      <div id="designMenu" class="menu menu-wide hidden"></div>
    </div>
    <div class="tb-group tb-right">
      <select id="layout" title="Layout">
        <option value="hierarchy">Hierarchy (layers)</option>
        <option value="cose">Force</option>
        <option value="concentric">Concentric</option>
        <option value="grid">Grid</option>
      </select>
      <button id="reload" title="Re-parse the file">⟳ Reload</button>
      <button id="fit" title="Fit to screen">Fit</button>
      <button id="settings" title="Extension settings">⚙</button>
    </div>
  </div>
  <div id="stage">
    <div id="cy"></div>
    <div id="sidebar" class="hidden"></div>
    <div id="banner" class="hidden"></div>
    <div id="hint"></div>
  </div>
  <div id="statusbar"><span id="status">Loading…</span><span id="legend"></span></div>
  <script nonce="${nonce}" src="${cytoUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private dispose() {
    GraphPanel.current = undefined;
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}

/** Slice an element's statement text out of the source and terminate it. */
function stmt(src: string, el: VqlElement): string {
  return src.slice(el.offset, el.end).trim() + ';';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shortName(uri: vscode.Uri): string {
  const p = uri.path;
  return p.substring(p.lastIndexOf('/') + 1);
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
