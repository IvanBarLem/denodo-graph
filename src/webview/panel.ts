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

interface LiteNode {
  id: string;
  label: string;
  kind: ElementKind;
  defined: boolean;
  folder?: string;
  subtype?: string;
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

  static show(context: vscode.ExtensionContext, doc: vscode.TextDocument, diagnostics: vscode.DiagnosticCollection) {
    const column = vscode.ViewColumn.Beside;
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(column);
      GraphPanel.current.load(doc, diagnostics);
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
    GraphPanel.current.load(doc, diagnostics);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel
  ) {
    this.panel = panel;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
  }

  private load(doc: vscode.TextDocument, diagnostics: vscode.DiagnosticCollection) {
    this.docUri = doc.uri;
    const cfg = vscode.workspace.getConfiguration('denodoVqlGraph');
    const text = doc.getText();

    this.panel.title = `Graph: ${shortName(doc.uri)}`;
    this.post({ type: 'status', text: 'Parsing…' });

    // Parse. For huge documents this runs on the extension host thread; it is a
    // single linear pass and typically fast, but we yield the message first so
    // the webview can paint the "Parsing…" state.
    setTimeout(() => {
      const graph = buildGraph(text, {
        stripDatabaseQualifier: cfg.get<boolean>('stripDatabaseQualifier', true)
      });
      this.graph = graph;

      if (cfg.get<boolean>('reportMissingViews', true)) {
        this.publishDiagnostics(doc, graph, diagnostics);
      } else {
        diagnostics.delete(doc.uri);
      }

      const max = cfg.get<number>('maxRenderNodes', 2500);
      const depth = cfg.get<number>('neighbourhoodDepth', 2);
      const mode: 'full' | 'focus' = graph.elements.size <= max ? 'full' : 'focus';

      this.post({
        type: 'init',
        mode,
        stats: graph.stats,
        neighbourhoodDepth: depth,
        maxRenderNodes: max
      });

      if (mode === 'full') {
        const { nodes, edges } = this.fullPayload();
        this.post({ type: 'graph', nodes, edges });
      }
    }, 0);
  }

  private onMessage(msg: any) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'ready':
        // webview finished loading; nothing to do (init sent on load)
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
      subtype: el.subtype
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
      /* document may have been closed */
    }
  }

  private publishDiagnostics(doc: vscode.TextDocument, graph: VqlGraph, coll: vscode.DiagnosticCollection) {
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

    const diags: vscode.Diagnostic[] = [];
    for (const [offset, refs] of byLine) {
      const pos = doc.positionAt(offset);
      const lineRange = doc.lineAt(pos.line).range;
      const unique = Array.from(new Set(refs));
      const d = new vscode.Diagnostic(
        lineRange,
        `Denodo VQL: references undefined element${unique.length > 1 ? 's' : ''}: ${unique.join(', ')}`,
        vscode.DiagnosticSeverity.Warning
      );
      d.source = 'Denodo VQL Graph';
      diags.push(d);
    }
    coll.set(doc.uri, diags);
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
    <div class="tb-group" id="filters"></div>
    <div class="tb-group tb-right">
      <select id="layout" title="Layout">
        <option value="breadthfirst">Hierarchy</option>
        <option value="cose">Force</option>
        <option value="concentric">Concentric</option>
        <option value="grid">Grid</option>
      </select>
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
