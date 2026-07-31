import * as vscode from 'vscode';
import { GraphPanel } from './webview/panel';

let diagnostics: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection('denodo-vql-graph');
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.commands.registerCommand('denodoVqlGraph.openGraph', async () => {
      const doc = await resolveVqlDocument();
      if (!doc) {
        vscode.window.showWarningMessage('Denodo VQL Graph: open a .vql file (or a file with VQL) first.');
        return;
      }
      GraphPanel.show(context, doc, diagnostics);
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
 * Pick the document to graph: the active editor if it looks like VQL, otherwise
 * let the user choose a file.
 */
async function resolveVqlDocument(): Promise<vscode.TextDocument | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && isVqlLike(active)) return active;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Open VQL graph',
    filters: { 'Denodo VQL': ['vql'], 'All files': ['*'] }
  });
  if (!picked || picked.length === 0) return undefined;
  return vscode.workspace.openTextDocument(picked[0]);
}

function isVqlLike(doc: vscode.TextDocument): boolean {
  if (doc.languageId === 'vql') return true;
  if (doc.uri.path.toLowerCase().endsWith('.vql')) return true;
  // Heuristic for untitled/unknown docs: contains VQL CREATE statements.
  const head = doc.getText().slice(0, 4000).toUpperCase();
  return /\bCREATE\s+(OR\s+REPLACE\s+)?(WRAPPER|DATASOURCE|TABLE|VIEW|INTERFACE|ASSOCIATION)\b/.test(head);
}
