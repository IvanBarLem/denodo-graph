/**
 * Renders a `NodeDiffResult` as a Markdown report. Kept separate from the diff
 * engine (which is pure and vscode-free) so the engine stays unit-testable.
 */

import { KIND_LABEL } from '../parser/model';
import { NodeChange, NodeDiffResult, NodeInfo } from './nodeDiff';

function kindOf(n: NodeInfo | NodeChange): string {
  return KIND_LABEL[n.kind] ?? n.kind;
}

function nodeLine(n: NodeInfo): string {
  return `- \`${n.id}\` — ${kindOf(n)}`;
}

function attr(label: string, c?: { from?: string; to?: string }): string | null {
  if (!c) return null;
  return `  - ${label}: \`${c.from ?? '∅'}\` → \`${c.to ?? '∅'}\``;
}

function changeBlock(c: NodeChange): string {
  const lines: string[] = [`### \`${c.id}\` — ${kindOf(c)}`];

  const kc = c.kindChange ? attr('kind', { from: c.kindChange.from, to: c.kindChange.to }) : null;
  if (kc) lines.push(kc);
  const sc = attr('subtype', c.subtypeChange);
  if (sc) lines.push(sc);
  const fc = attr('folder', c.folderChange);
  if (fc) lines.push(fc);

  if (c.fieldsAdded.length || c.fieldsRemoved.length || c.fieldsTypeChanged.length) {
    const parts: string[] = [];
    for (const t of c.fieldsTypeChanged) parts.push(`~ \`${t.name}\` (${t.from ?? '∅'} → ${t.to ?? '∅'})`);
    for (const n of c.fieldsAdded) parts.push(`+ \`${n}\``);
    for (const n of c.fieldsRemoved) parts.push(`− \`${n}\``);
    lines.push(`  - Fields: ${parts.join(', ')}`);
  }

  if (c.depsAdded.length || c.depsRemoved.length) {
    const parts: string[] = [];
    for (const r of c.depsAdded) parts.push(`+ \`${r}\``);
    for (const r of c.depsRemoved) parts.push(`− \`${r}\``);
    lines.push(`  - Dependencies: ${parts.join(', ')}`);
  }

  // A body/logic change that the structured model doesn't otherwise explain.
  if (c.bodyChanged && !c.structural) {
    lines.push('  - Definition changed (expression/logic not modelled as fields or dependencies — use the line diff to inspect)');
  } else if (c.bodyChanged) {
    lines.push('  - _(statement text also changed)_');
  }

  return lines.join('\n');
}

export function renderNodeDiffMarkdown(result: NodeDiffResult, nameA: string, nameB: string): string {
  const { added, removed, modified, unchanged } = result;
  const out: string[] = [];

  out.push('# VQL node diff');
  out.push('');
  out.push(`**Base (left):** \`${nameA}\`  ·  **Changed (right):** \`${nameB}\``);
  out.push('');
  out.push('_Compared at the element level — fields and dependencies as sets, plus kind/subtype/folder. Order- and format-independent, and no line-by-line text diff._');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(`| Added | Removed | Modified | Unchanged |`);
  out.push(`|------:|--------:|---------:|----------:|`);
  out.push(`| ${added.length} | ${removed.length} | ${modified.length} | ${unchanged} |`);
  out.push('');

  if (!added.length && !removed.length && !modified.length) {
    out.push('✅ **No node-level differences** — the two scripts define the same elements with the same fields, dependencies and definitions.');
    out.push('');
    return out.join('\n');
  }

  out.push(`## Added (${added.length})`);
  out.push('');
  out.push(added.length ? added.map(nodeLine).join('\n') : '_None._');
  out.push('');

  out.push(`## Removed (${removed.length})`);
  out.push('');
  out.push(removed.length ? removed.map(nodeLine).join('\n') : '_None._');
  out.push('');

  out.push(`## Modified (${modified.length})`);
  out.push('');
  out.push(modified.length ? modified.map(changeBlock).join('\n\n') : '_None._');
  out.push('');

  return out.join('\n');
}
