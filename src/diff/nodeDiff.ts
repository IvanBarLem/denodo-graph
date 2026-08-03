/**
 * Node-level VQL diff ("diffnode").
 *
 * Where `vqlDiff.ts` produces two canonical text documents for a line-by-line
 * editor diff, this compares the two parsed graphs **structurally**: it keys
 * elements by their (database-qualified) id and, for elements present in both,
 * compares their fields and dependencies as *sets* and their scalar attributes
 * (kind, subtype, folder). There is no text diffing, so it is O(n) over the
 * elements and very fast — and it reports *what* changed (a field added, a
 * type changed, a dependency removed) rather than which lines moved.
 *
 * A normalized-body comparison (reusing `normalizeStatement`, cheap per small
 * statement — no line-level LCS) is kept only as a fallback so a change to
 * un-modelled logic (a `WHERE`/`JOIN`/`CASE` expression) is still surfaced as
 * "definition changed" instead of being silently reported as unchanged.
 */

import { ElementKind, VqlElement, VqlGraph } from '../parser/model';
import { normalizeStatement } from './canonicalize';

export interface NodeInfo {
  id: string;
  kind: ElementKind;
  database?: string;
}

export interface FieldTypeChange {
  name: string;
  from?: string;
  to?: string;
}

export interface AttrChange {
  from?: string;
  to?: string;
}

export interface NodeChange {
  id: string;
  kind: ElementKind;
  database?: string;
  kindChange?: { from: ElementKind; to: ElementKind };
  subtypeChange?: AttrChange;
  folderChange?: AttrChange;
  fieldsAdded: string[];
  fieldsRemoved: string[];
  fieldsTypeChanged: FieldTypeChange[];
  depsAdded: string[];
  depsRemoved: string[];
  /** The normalized statement text differs (catches un-modelled logic changes). */
  bodyChanged: boolean;
  /** At least one structured (field/dep/attr) delta is present. */
  structural: boolean;
}

export interface NodeDiffResult {
  added: NodeInfo[];
  removed: NodeInfo[];
  modified: NodeChange[];
  unchanged: number;
}

function definedMap(g: VqlGraph): Map<string, VqlElement> {
  const m = new Map<string, VqlElement>();
  for (const el of g.elements.values()) if (el.defined) m.set(el.id, el);
  return m;
}

function info(el: VqlElement): NodeInfo {
  return { id: el.id, kind: el.kind, database: el.database };
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two parsed graphs at the element (node) level. */
export function diffNodes(a: VqlGraph, b: VqlGraph, srcA: string, srcB: string): NodeDiffResult {
  const A = definedMap(a);
  const B = definedMap(b);

  const added: NodeInfo[] = [];
  const removed: NodeInfo[] = [];
  const modified: NodeChange[] = [];
  let unchanged = 0;

  for (const [id, ea] of A) {
    const eb = B.get(id);
    if (!eb) {
      removed.push(info(ea));
      continue;
    }
    const change = compareElement(ea, eb, srcA, srcB);
    if (change) modified.push(change);
    else unchanged++;
  }
  for (const [id, eb] of B) {
    if (!A.has(id)) added.push(info(eb));
  }

  added.sort((x, y) => cmpStr(x.id, y.id));
  removed.sort((x, y) => cmpStr(x.id, y.id));
  modified.sort((x, y) => cmpStr(x.id, y.id));
  return { added, removed, modified, unchanged };
}

function compareElement(ea: VqlElement, eb: VqlElement, srcA: string, srcB: string): NodeChange | null {
  // Fields compared as a name -> type map (order-independent).
  const fa = new Map(ea.fields.map((f) => [f.name, f.type]));
  const fb = new Map(eb.fields.map((f) => [f.name, f.type]));
  const fieldsAdded: string[] = [];
  const fieldsRemoved: string[] = [];
  const fieldsTypeChanged: FieldTypeChange[] = [];
  for (const [name, ta] of fa) {
    if (!fb.has(name)) fieldsRemoved.push(name);
    else {
      const tb = fb.get(name);
      if ((ta ?? '') !== (tb ?? '')) fieldsTypeChanged.push({ name, from: ta, to: tb });
    }
  }
  for (const name of fb.keys()) if (!fa.has(name)) fieldsAdded.push(name);

  // Dependencies compared as a set of refs (order-independent, de-duplicated).
  const da = new Set(ea.deps.map((d) => d.ref));
  const db = new Set(eb.deps.map((d) => d.ref));
  const depsAdded: string[] = [];
  const depsRemoved: string[] = [];
  for (const r of da) if (!db.has(r)) depsRemoved.push(r);
  for (const r of db) if (!da.has(r)) depsAdded.push(r);

  const kindChange = ea.kind !== eb.kind ? { from: ea.kind, to: eb.kind } : undefined;
  const subtypeChange = ea.subtype !== eb.subtype ? { from: ea.subtype, to: eb.subtype } : undefined;
  const folderChange = ea.folder !== eb.folder ? { from: ea.folder, to: eb.folder } : undefined;

  const structural =
    fieldsAdded.length > 0 ||
    fieldsRemoved.length > 0 ||
    fieldsTypeChanged.length > 0 ||
    depsAdded.length > 0 ||
    depsRemoved.length > 0 ||
    !!kindChange ||
    !!subtypeChange ||
    !!folderChange;

  const bodyChanged =
    normalizeStatement(srcA.slice(ea.offset, ea.end)) !== normalizeStatement(srcB.slice(eb.offset, eb.end));

  if (!structural && !bodyChanged) return null;

  fieldsAdded.sort(cmpStr);
  fieldsRemoved.sort(cmpStr);
  fieldsTypeChanged.sort((x, y) => cmpStr(x.name, y.name));
  depsAdded.sort(cmpStr);
  depsRemoved.sort(cmpStr);

  return {
    id: ea.id,
    kind: eb.kind,
    database: eb.database,
    kindChange,
    subtypeChange,
    folderChange,
    fieldsAdded,
    fieldsRemoved,
    fieldsTypeChanged,
    depsAdded,
    depsRemoved,
    bodyChanged,
    structural
  };
}
