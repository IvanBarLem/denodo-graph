/**
 * Shared data model for the parsed VQL graph.
 *
 * The model is intentionally flat and primitive-heavy so it can hold millions
 * of elements without excessive per-object overhead, and so it serializes
 * cheaply when only summaries/subgraphs are sent to the webview.
 */

export type ElementKind =
  | 'datasource'
  | 'wrapper'
  | 'baseView'
  | 'view'
  | 'interface'
  | 'association'
  | 'unknown';

export interface Field {
  name: string;
  type?: string;
}

/** A dependency of an element on another (possibly not-yet-defined) element. */
export interface Dependency {
  /** Normalized id of the referenced element. */
  ref: string;
  /** What kind of element we expect `ref` to be, used when it turns out missing. */
  expect: ElementKind;
}

export interface VqlElement {
  /** Normalized identifier used as the graph node id (unquoted name). */
  id: string;
  /** Display name (unquoted). */
  name: string;
  kind: ElementKind;
  /** e.g. JDBC / ODBC / DF / JSON / XML / WS for data sources and wrappers. */
  subtype?: string;
  folder?: string;
  fields: Field[];
  deps: Dependency[];
  /** 1-based line where the element is defined (or first referenced, if missing). */
  line: number;
  /** 0-based character offset of the definition in the source. */
  offset: number;
  /** false = only referenced, never CREATEd => a "missing" element. */
  defined: boolean;
}

export interface GraphStats {
  total: number;
  defined: number;
  missing: number;
  byKind: Record<ElementKind, number>;
  edges: number;
  parseMs: number;
}

export interface VqlGraph {
  /** id -> element */
  elements: Map<string, VqlElement>;
  /** reverse index: id -> ids that depend on it (downstream / "used by"). */
  dependents: Map<string, string[]>;
  stats: GraphStats;
}

export function emptyStats(): GraphStats {
  return {
    total: 0,
    defined: 0,
    missing: 0,
    byKind: {
      datasource: 0,
      wrapper: 0,
      baseView: 0,
      view: 0,
      interface: 0,
      association: 0,
      unknown: 0
    },
    edges: 0,
    parseMs: 0
  };
}

/** Human label for a kind (used in UI). */
export const KIND_LABEL: Record<ElementKind, string> = {
  datasource: 'Data source',
  wrapper: 'Wrapper',
  baseView: 'Base view',
  view: 'Derived view',
  interface: 'Interface view',
  association: 'Association',
  unknown: 'Unknown'
};
