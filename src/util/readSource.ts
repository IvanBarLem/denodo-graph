import * as vscode from 'vscode';
import { promises as fsp } from 'node:fs';

/**
 * Read the VQL source for a URI. Prefers a live editor buffer when it actually
 * has content (so unsaved edits are reflected), but files above VS Code's 50 MB
 * editor-sync limit are never synced to extensions and yield empty text there —
 * so we fall through to reading the bytes straight from disk, which is not
 * subject to that limit. This is what lets the extension work on very large
 * scripts.
 */
export async function readVqlSource(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    const t = open.getText();
    if (t.length > 0) return t;
  }
  if (uri.scheme === 'file') {
    return await fsp.readFile(uri.fsPath, 'utf8');
  }
  // Remote / virtual filesystems: go through the VS Code FS API.
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}
