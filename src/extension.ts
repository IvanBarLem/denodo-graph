import * as vscode from 'vscode';
import { GraphPanel } from './webview/panel';
import { buildGraph } from './graph/graphBuilder';
import { readVqlSource } from './util/readSource';
import { VqlDiffContentProvider, DIFF_SCHEME } from './diff/diffContentProvider';
import { canonicalDocument, computeSummary, summaryText } from './diff/vqlDiff';
import { diffNodes } from './diff/nodeDiff';
import { renderNodeDiffMarkdown } from './diff/nodeDiffReport';

let diagnostics: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection('denodo-vql-graph');
  context.subscriptions.push(diagnostics);

  const diffProvider = new VqlDiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider)
  );

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

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'denodoVqlGraph.diffFiles',
      async (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
        const pair = await resolveDiffPair(resource, resources);
        if (!pair) return;
        await runDiff(diffProvider, pair[0], pair[1]);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'denodoVqlGraph.diffNode',
      async (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
        const pair = await resolveDiffPair(resource, resources);
        if (!pair) return;
        await runNodeDiff(pair[0], pair[1]);
      }
    )
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
 * Parse both files, re-serialise each into its canonical (sorted + normalized)
 * form and open VS Code's native diff editor on the two. Because both sides go
 * through the same canonicaliser, reordering and reformatting produce no diff —
 * only genuine differences show.
 */
async function runDiff(provider: VqlDiffContentProvider, left: vscode.Uri, right: vscode.Uri): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Denodo VQL: diffing…' },
      async () => {
        const [srcL, srcR] = await Promise.all([readVqlSource(left), readVqlSource(right)]);
        const gL = buildGraph(srcL);
        const gR = buildGraph(srcR);
        const docL = canonicalDocument(gL, srcL);
        const docR = canonicalDocument(gR, srcR);

        const nameL = shortName(left);
        const nameR = shortName(right);
        const uriL = provider.add(`${nameL} (normalized)`, 'L', docL);
        const uriR = provider.add(`${nameR} (normalized)`, 'R', docR);

        await vscode.commands.executeCommand(
          'vscode.diff',
          uriL,
          uriR,
          `VQL (normalized): ${nameL} ↔ ${nameR}`
        );

        const summary = computeSummary(gL, gR, srcL, srcR);
        vscode.window.showInformationMessage(`Denodo VQL diff — ${summaryText(summary)}.`);
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Denodo VQL diff failed: ${String(err)}`);
  }
}

/**
 * "diffnode": compare two files at the element level and open a Markdown report.
 * No text canonicalization or line diff — it compares the parsed element maps
 * and their field/dependency sets directly, so it is O(n) and fast, and reports
 * *what* changed per element.
 */
async function runNodeDiff(left: vscode.Uri, right: vscode.Uri): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Denodo VQL: node diff…' },
      async () => {
        const [srcL, srcR] = await Promise.all([readVqlSource(left), readVqlSource(right)]);
        const result = diffNodes(buildGraph(srcL), buildGraph(srcR), srcL, srcR);
        const md = renderNodeDiffMarkdown(result, shortName(left), shortName(right));

        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
        await vscode.window.showTextDocument(doc, { preview: false });
        // Rendered preview is nicer than raw Markdown; ignore if unavailable.
        try {
          await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
        } catch {
          /* markdown preview not available — the source doc is already shown */
        }

        vscode.window.showInformationMessage(
          `Denodo VQL node diff — +${result.added.length} added, ` +
            `-${result.removed.length} removed, ~${result.modified.length} modified, ` +
            `${result.unchanged} unchanged.`
        );
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Denodo VQL node diff failed: ${String(err)}`);
  }
}

/**
 * Resolve the two files to diff. Supports:
 *  - Explorer multi-select (two .vql selected) -> use both directly;
 *  - a single clicked / active file as the left side + a picker for the right;
 *  - no context at all -> a picker for each side.
 * Left is the "base/old", right is the "changed/new".
 */
async function resolveDiffPair(
  resource: vscode.Uri | undefined,
  resources: vscode.Uri[] | undefined
): Promise<[vscode.Uri, vscode.Uri] | undefined> {
  if (resources && resources.length >= 2) {
    return [resources[0], resources[1]];
  }

  let left = resource instanceof vscode.Uri ? resource : activeVqlUri();
  if (!left) {
    left = await pickVqlFile('Select the base (left) VQL file');
    if (!left) return undefined;
  }

  const right = await pickVqlFile('Select the changed (right) VQL file to compare against');
  if (!right) return undefined;

  if (left.toString() === right.toString()) {
    vscode.window.showWarningMessage('Denodo VQL diff: both sides are the same file — nothing to compare.');
    return undefined;
  }
  return [left, right];
}

function activeVqlUri(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document;
  return active && isVqlLike(active) ? active.uri : undefined;
}

async function pickVqlFile(openLabel: string): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel,
    title: openLabel,
    filters: { 'Denodo VQL': ['vql'], 'All files': ['*'] }
  });
  return picked && picked.length ? picked[0] : undefined;
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
  return pickVqlFile('Open VQL graph');
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

function shortName(uri: vscode.Uri): string {
  const p = uri.path;
  return p.substring(p.lastIndexOf('/') + 1);
}
