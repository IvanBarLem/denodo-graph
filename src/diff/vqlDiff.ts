/**
 * Order-independent, format-independent VQL diff.
 *
 * `canonicalDocument` re-serialises a parsed graph into a deterministic text:
 * statements sorted by element identity (database → kind → name) and each
 * statement run through `canonicalStatement`. Running two scripts through the
 * same function neutralises both statement order and formatting, so VS Code's
 * native diff editor highlights only genuine differences.
 *
 * `computeSummary` produces the +added / -removed / ~modified / =unchanged
 * counts shown to the user, keyed by the element's already-database-qualified id.
 */

import { ElementKind, TypeDef, VqlElement, VqlGraph } from '../parser/model';
import { canonicalStatement } from './canonicalize';

// Dependency-flow order, so the canonical document reads bottom-up like the
// hierarchy layout (sources first). Purely for readability + stable ordering;
// both sides use the same ranking so alignment is unaffected.
const KIND_RANK: Record<ElementKind, number> = {
  datasource: 0,
  wrapper: 1,
  baseView: 2,
  view: 3,
  interface: 4,
  association: 5,
  unknown: 6
};

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable ordering of elements: by database, then kind, then name, then id. */
function compareElements(a: VqlElement, b: VqlElement): number {
  return (
    cmpStr(a.database ?? '', b.database ?? '') ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    cmpStr(a.name, b.name) ||
    cmpStr(a.id, b.id)
  );
}

function slice(src: string, e: { offset: number; end: number }): string {
  return src.slice(e.offset, e.end);
}

/**
 * Produce the canonical text document for a parsed graph. Only defined elements
 * (and CREATE TYPE / CREATE FOLDER definitions) are emitted — "missing"
 * placeholders are references, not definitions, and would be diff noise.
 */
export function canonicalDocument(graph: VqlGraph, src: string): string {
  const defined = Array.from(graph.elements.values()).filter((e) => e.defined);
  defined.sort(compareElements);

  const lines: string[] = [];
  let currentDb: string | undefined;
  let started = false;

  for (const el of defined) {
    // Emit a CONNECT DATABASE anchor whenever the database context changes. This
    // keeps the document valid VQL and groups elements exactly like the source's
    // logical databases, regardless of how each file wrote them.
    if (el.database && el.database !== currentDb) {
      if (started) lines.push('');
      lines.push(`connect database ${el.database};`);
      lines.push('');
      currentDb = el.database;
    } else if (!el.database && currentDb !== undefined && started) {
      // Should not normally happen (no-db elements sort first), but guard anyway.
      currentDb = undefined;
    }
    lines.push(canonicalStatement(slice(src, el)) + ';');
    lines.push('');
    started = true;
  }

  // Supporting definitions (not graph nodes, but they matter for equivalence).
  appendDefs(lines, graph.types, src, '# ----- types -----');
  appendDefs(lines, graph.folders, src, '# ----- folders -----');

  // Collapse any trailing blank lines to a single newline.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

function appendDefs(lines: string[], defs: Map<string, TypeDef>, src: string, header: string): void {
  if (defs.size === 0) return;
  const sorted = Array.from(defs.values()).sort((a, b) => cmpStr(a.name, b.name));
  lines.push('');
  lines.push(header);
  lines.push('');
  for (const d of sorted) {
    lines.push(canonicalStatement(slice(src, d)) + ';');
    lines.push('');
  }
}

export interface DiffSummary {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: number;
}

/**
 * Element-level summary keyed by (database-qualified) id. Modified vs unchanged
 * is decided on the canonical statement, so reordering/reformatting never counts
 * as a change.
 */
export function computeSummary(a: VqlGraph, b: VqlGraph, srcA: string, srcB: string): DiffSummary {
  const left = canonicalById(a, srcA);
  const right = canonicalById(b, srcB);

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  let unchanged = 0;

  for (const [id, canon] of left) {
    const other = right.get(id);
    if (other === undefined) removed.push(id);
    else if (other === canon) unchanged++;
    else modified.push(id);
  }
  for (const id of right.keys()) {
    if (!left.has(id)) added.push(id);
  }

  added.sort(cmpStr);
  removed.sort(cmpStr);
  modified.sort(cmpStr);
  return { added, removed, modified, unchanged };
}

function canonicalById(graph: VqlGraph, src: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const el of graph.elements.values()) {
    if (el.defined) m.set(el.id, canonicalStatement(slice(src, el)));
  }
  return m;
}

/** One-line human summary for a status/toast message. */
export function summaryText(s: DiffSummary): string {
  return (
    `+${s.added.length} added, ` +
    `-${s.removed.length} removed, ` +
    `~${s.modified.length} modified, ` +
    `${s.unchanged} unchanged (reordered/reformatted)`
  );
}
