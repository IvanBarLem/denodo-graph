import * as vscode from 'vscode';

/** Custom URI scheme for the read-only canonical diff documents. */
export const DIFF_SCHEME = 'denodo-vql-diff';

/**
 * Serves the canonical (sorted + normalized) VQL text for the native diff
 * editor. The documents are virtual and read-only; content is held in memory and
 * keyed by URI. A small LRU cap keeps memory bounded when many diffs are opened
 * in a session.
 */
export class VqlDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly maxDocs = 10;
  private token = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  /**
   * Register a canonical document for one side of a diff and return its URI.
   * The path ends in `.vql` so the diff pane picks up VQL syntax highlighting;
   * `name` becomes the visible label, and a per-invocation token keeps left/right
   * (and successive diffs) distinct.
   */
  add(name: string, side: 'L' | 'R', content: string): vscode.Uri {
    const t = ++this.token;
    // Encode a readable path that ENDS in `.vql` so the diff pane resolves the
    // `vql` language and syntax-highlights; the query disambiguates instances.
    const safe = name.replace(/[^A-Za-z0-9._ -]/g, '_');
    const base = safe.toLowerCase().endsWith('.vql') ? safe : `${safe}.vql`;
    const uri = vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: `/${base}`,
      query: `t=${t}&s=${side}`
    });
    this.docs.set(uri.toString(), content);
    this.evict();
    return uri;
  }

  private evict(): void {
    while (this.docs.size > this.maxDocs) {
      const oldest = this.docs.keys().next().value;
      if (oldest === undefined) break;
      this.docs.delete(oldest);
    }
  }
}
