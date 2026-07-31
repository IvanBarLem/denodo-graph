import * as vscode from 'vscode';
import { GraphPanel } from './webview/panel';

let diagnostics: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection('denodo-vql-graph');
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.commands.registerCommand('denodoVqlGraph.openGraph', async (resource?: vscode.Uri) => {
      // When invoked from the editor title bar or context menu, VS Code passes
      // the resource URI directly — use it (this also works for files above the
      // 50 MB editor limit, where there is no active text editor to fall back on).
      const uri = resource instanceof vscode.Uri ? resource : await resolveVqlUri();
      if (!uri) {
        vscode.window.showWarningMessage('Denodo VQL Graph: open a .vql file (or a file with VQL) first.');
        return;
      }
      GraphPanel.show(context, uri, diagnostics);
    })
  );

  // Reveal used internally by the webview via messages; also exposed as a no-op
  // safe command entry point.
  context.subscriptions.push(
    vscode.commands.registerCommand('denodoVqlGraph.revealElement', () => {
      /* handled inside the panel via webview messages */
    })
  );
}

export function deactivate() {
  if (diagnostics) diagnostics.dispose();
}

/**
 * Pick the file to graph: the active editor if it looks like VQL, otherwise let
 * the user choose a file. Returns a URI (not a TextDocument) so the panel can
 * read the bytes from disk — files above VS Code's 50 MB editor-sync limit have
 * no usable document but can still be read and graphed.
 */
async function resolveVqlUri(): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && isVqlLike(active)) return active.uri;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Open VQL graph',
    filters: { 'Denodo VQL': ['vql'], 'All files': ['*'] }
  });
  if (!picked || picked.length === 0) return undefined;
  return picked[0];
}

function isVqlLike(doc: vscode.TextDocument): boolean {
  if (doc.languageId === 'vql') return true;
  if (doc.uri.path.toLowerCase().endsWith('.vql')) return true;
  // Heuristic for untitled/unknown docs: contains VQL CREATE statements. For
  // very large files getText() is empty (not synced), so this only fires for
  // small in-memory buffers — the .vql extension check above covers big files.
  const head = doc.getText().slice(0, 4000).toUpperCase();
  return /\bCREATE\s+(OR\s+REPLACE\s+)?(WRAPPER|DATASOURCE|TABLE|VIEW|INTERFACE|ASSOCIATION)\b/.test(head);
}
