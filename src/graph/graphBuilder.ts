/**
 * Orchestrates the full parse: scan -> classify -> resolve dependencies ->
 * synthesize "missing" placeholder nodes -> build the reverse (dependents)
 * index and stats.
 *
 * Everything here is a single linear pass over the statements plus one pass
 * over the resulting elements, so total cost is O(size of script).
 */

import { ElementKind, emptyStats, VqlElement, VqlGraph } from '../parser/model';
import { buildLineIndex, offsetToLine, splitStatements, stripComments } from '../parser/scanner';
import { classifyStatement, ParseOptions } from '../parser/vqlParser';

export interface BuildOptions extends ParseOptions {
  /** Optional progress callback (0..1) for very large inputs. */
  onProgress?: (fraction: number) => void;
}

export function buildGraph(src: string, opts: BuildOptions): VqlGraph {
  const started = Date.now();
  const elements = new Map<string, VqlElement>();
  const lineStarts = buildLineIndex(src);

  const statements = splitStatements(src);
  const total = statements.length || 1;
  const progressEvery = Math.max(1, Math.floor(total / 50));

  for (let s = 0; s < statements.length; s++) {
    const raw = statements[s];
    const body = stripComments(raw.text);

    // Offset of the CREATE keyword for a precise reveal location.
    const createIdx = indexOfCreate(raw.text);
    const defOffset = raw.start + (createIdx >= 0 ? createIdx : 0);
    const line = offsetToLine(lineStarts, defOffset);

    const el = classifyStatement(body, line, defOffset, opts);
    if (el) {
      const existing = elements.get(el.id);
      if (!existing || !existing.defined) {
        // New element, or upgrading a previously-missing placeholder.
        if (existing && !existing.defined) {
          // Preserve nothing from the placeholder; the real definition wins.
        }
        elements.set(el.id, el);
      }
      // If already defined (duplicate CREATE OR REPLACE), keep the first.
    }

    if (opts.onProgress && s % progressEvery === 0) {
      opts.onProgress(s / total);
    }
  }

  // Resolve dependencies: create placeholders for anything referenced but not
  // defined ("missing views").
  for (const el of Array.from(elements.values())) {
    for (const dep of el.deps) {
      if (!elements.has(dep.ref)) {
        elements.set(dep.ref, makeMissing(dep.ref, dep.expect, el.line, el.offset));
      }
    }
  }

  // Build reverse index (dependents / "used by").
  const dependents = new Map<string, string[]>();
  let edges = 0;
  for (const el of elements.values()) {
    for (const dep of el.deps) {
      if (dep.ref === el.id) continue;
      let arr = dependents.get(dep.ref);
      if (!arr) {
        arr = [];
        dependents.set(dep.ref, arr);
      }
      arr.push(el.id);
      edges++;
    }
  }

  const stats = emptyStats();
  stats.total = elements.size;
  stats.edges = edges;
  for (const el of elements.values()) {
    stats.byKind[el.kind]++;
    if (el.defined) stats.defined++;
    else stats.missing++;
  }
  stats.parseMs = Date.now() - started;

  if (opts.onProgress) opts.onProgress(1);
  return { elements, dependents, stats };
}

function makeMissing(id: string, expect: ElementKind, line: number, offset: number): VqlElement {
  return {
    id,
    name: id,
    kind: expect,
    fields: [],
    deps: [],
    line,
    offset,
    defined: false
  };
}

/** Index of the CREATE keyword in a raw statement, skipping leading comments. */
function indexOfCreate(text: string): number {
  const m = /(^|[^A-Za-z0-9_])CREATE\b/i.exec(text);
  if (!m) return -1;
  return m.index + (m[1] ? m[1].length : 0);
}
