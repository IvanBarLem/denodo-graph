/**
 * Extract the view references (dependencies) and projected field names from a
 * derived-view SELECT body.
 *
 * We deliberately use a small tokenizer rather than regex-only scanning so we
 * can handle: JOINs, comma-separated table lists, subqueries `FROM (SELECT ..)`,
 * quoted identifiers, `db.view` qualified names, aliases and `flatten` clauses,
 * without pulling in a full SQL grammar. It stays linear in the body length.
 */

export interface SelectInfo {
  refs: string[];
  fields: { name: string }[];
}

type Tok = { t: 'id' | 'str' | 'punct' | 'op'; v: string; u: string };

function isIdentStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  );
}
function isIdentPart(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57); // 0-9
}

function tokenize(body: string): Tok[] {
  const toks: Tok[] = [];
  const n = body.length;
  let i = 0;
  while (i < n) {
    const code = body.charCodeAt(i);
    // whitespace
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      i++;
      continue;
    }
    // string literal
    if (code === 39 /* ' */) {
      const start = i;
      i++;
      while (i < n) {
        if (body.charCodeAt(i) === 39) {
          if (i + 1 < n && body.charCodeAt(i + 1) === 39) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      toks.push({ t: 'str', v: body.slice(start, i), u: '' });
      continue;
    }
    // quoted identifier -> may be part of a dotted name
    if (code === 34 /* " */ || isIdentStart(code)) {
      const parts: string[] = [];
      // read one or more segments separated by '.'
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (body.charCodeAt(i) === 34) {
          const start = i;
          i++;
          while (i < n) {
            if (body.charCodeAt(i) === 34) {
              if (i + 1 < n && body.charCodeAt(i + 1) === 34) {
                i += 2;
                continue;
              }
              i++;
              break;
            }
            i++;
          }
          parts.push(body.slice(start, i).replace(/^"|"$/g, '').replace(/""/g, '"'));
        } else if (isIdentStart(body.charCodeAt(i))) {
          const start = i;
          while (i < n && isIdentPart(body.charCodeAt(i))) i++;
          parts.push(body.slice(start, i));
        } else {
          break;
        }
        // dotted continuation?
        if (i < n && body.charCodeAt(i) === 46 /* . */) {
          i++;
          continue;
        }
        break;
      }
      const v = parts.join('.');
      toks.push({ t: 'id', v, u: v.toUpperCase() });
      continue;
    }
    // punctuation of interest
    if (code === 40 || code === 41 || code === 44) {
      toks.push({ t: 'punct', v: body[i], u: body[i] });
      i++;
      continue;
    }
    // any other operator char, single token
    toks.push({ t: 'op', v: body[i], u: body[i] });
    i++;
  }
  return toks;
}

// Keywords that terminate a table reference / FROM list.
const STOP = new Set([
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'ON',
  'USING',
  'UNION',
  'INTERSECT',
  'MINUS',
  'EXCEPT',
  'LIMIT',
  'OFFSET',
  'CONTEXT',
  'FETCH',
  'WITH'
]);

const JOIN_WORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER']);

// Words that are never a table/view reference. This keeps expression keywords —
// notably CASE / WHEN / THEN / ELSE / END and the boolean/comparison operators —
// from being mistaken for a relation when they appear right after FROM/JOIN or
// where an alias is expected (e.g. an un-aliased subquery followed by WHERE).
const RESERVED = new Set([
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'AND',
  'OR',
  'NOT',
  'IN',
  'EXISTS',
  'BETWEEN',
  'LIKE',
  'ILIKE',
  'SIMILAR',
  'IS',
  'NULL',
  'TRUE',
  'FALSE',
  'DISTINCT',
  'ALL',
  'ANY',
  'SOME',
  'SELECT',
  'AS',
  'BY',
  'ASC',
  'DESC',
  'FLATTEN'
]);

/** True if an upper-cased token is a structural/expression keyword, not a name. */
function isKeyword(u: string): boolean {
  return JOIN_WORDS.has(u) || STOP.has(u) || RESERVED.has(u) || u === 'FROM' || u === 'JOIN';
}

/** Strip a database qualifier for a *field* name (fields are always unqualified). */
function fieldName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * Parse a full derived-view body (everything after `AS`), returning the set of
 * referenced views (qualified as written, e.g. `db.view` or `view`) and a
 * best-effort list of projected field names. Handles CASE expressions,
 * subselects (in FROM and in the projection) and GROUP BY without tripping up.
 */
export function parseSelectBody(body: string): SelectInfo {
  const toks = tokenize(body);
  const refs = new Set<string>();
  const fields: { name: string }[] = [];

  // Projection field names come from the first SELECT's projection list.
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t === 'id' && toks[i].u === 'SELECT') {
      for (const f of collectProjection(toks, i + 1).fields) fields.push(f);
      break;
    }
  }

  // References: every FROM/JOIN anywhere in the body — including inside
  // subselects (in FROM, in the projection, or inside a CASE) and GROUP BY is
  // naturally excluded because GROUP is a stop keyword.
  scanRefs(toks, 0, toks.length, refs);

  return { refs: Array.from(refs), fields };
}

/** Scan the token range [lo, hi) for FROM/JOIN clauses and collect their refs. */
function scanRefs(toks: Tok[], lo: number, hi: number, refs: Set<string>): void {
  let i = lo;
  while (i < hi) {
    const t = toks[i];
    if (t.t === 'id' && (t.u === 'FROM' || t.u === 'JOIN')) {
      i = collectTableRefs(toks, i + 1, hi, t.u === 'FROM', refs);
      continue;
    }
    i++;
  }
}

/**
 * Collect one (JOIN) or a comma list (FROM) of table references starting at
 * index `start`. Subqueries are recursed into (so their inner FROMs are found)
 * rather than skipped. Returns the index just past what was consumed.
 */
function collectTableRefs(toks: Tok[], start: number, hi: number, isFrom: boolean, refs: Set<string>): number {
  let i = start;
  while (i < hi) {
    const t = toks[i];
    if (!t) break;

    if (t.t === 'punct' && t.v === '(') {
      // Derived table / subselect: recurse so references inside it are captured,
      // then continue after the closing paren and its optional alias.
      const close = skipParens(toks, i); // index just past matching ')'
      scanRefs(toks, i + 1, close - 1, refs);
      i = close;
      i = skipAlias(toks, i);
    } else if (t.t === 'id' && !isKeyword(t.u)) {
      refs.add(t.v); // keep the qualifier as written; resolved against the db later
      i++;
      i = skipAlias(toks, i);
    } else {
      // hit a JOIN / stop / expression keyword / unexpected token -> segment end
      break;
    }

    // comma continues a FROM list; for JOIN we only take one relation
    if (isFrom && toks[i] && toks[i].t === 'punct' && toks[i].v === ',') {
      i++;
      continue;
    }
    break;
  }
  return i;
}

/** Advance past `AS` and an alias identifier (never a keyword). */
function skipAlias(toks: Tok[], i: number): number {
  if (toks[i] && toks[i].t === 'id' && toks[i].u === 'AS') i++;
  if (toks[i] && toks[i].t === 'id' && !isKeyword(toks[i].u)) i++;
  return i;
}

function skipParens(toks: Tok[], openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'punct' && t.v === '(') depth++;
    else if (t.t === 'punct' && t.v === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}

/**
 * Collect projected field names between SELECT and the matching top-level FROM.
 * Best-effort: uses the alias after a top-level `AS`, else the trailing
 * identifier segment. `*` is recorded as-is.
 */
function collectProjection(toks: Tok[], start: number): { fields: { name: string }[] } {
  const fields: { name: string }[] = [];
  let depth = 0;
  let itemTokens: Tok[] = [];

  const flush = () => {
    if (itemTokens.length === 0) return;
    const name = fieldNameFromItem(itemTokens);
    if (name) fields.push({ name });
    itemTokens = [];
  };

  let i = start;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'id' && t.u === 'FROM' && depth === 0) {
      break;
    }
    if (t.t === 'punct' && t.v === '(') depth++;
    else if (t.t === 'punct' && t.v === ')') depth--;

    if (t.t === 'punct' && t.v === ',' && depth === 0) {
      flush();
      continue;
    }
    itemTokens.push(t);
  }
  flush();
  return { fields };
}

function fieldNameFromItem(item: Tok[]): string | null {
  // Look for a top-level `AS <alias>` first.
  let depth = 0;
  for (let k = 0; k < item.length; k++) {
    const t = item[k];
    if (t.t === 'punct' && t.v === '(') depth++;
    else if (t.t === 'punct' && t.v === ')') depth--;
    if (depth === 0 && t.t === 'id' && t.u === 'AS' && item[k + 1] && item[k + 1].t === 'id') {
      return fieldName(item[k + 1].v);
    }
  }
  // No alias: if it is a simple `a.b.c` or `*`, use the last identifier / '*'.
  // Only trust "simple" projections (single identifier token, maybe with '*').
  const ids = item.filter((t) => t.t === 'id');
  if (item.length === 1 && item[0].t === 'id') {
    return fieldName(item[0].v);
  }
  if (item.length === 1 && item[0].t === 'op' && item[0].v === '*') {
    return '*';
  }
  // `t.*` style
  if (ids.length === 1 && item[item.length - 1].v === '*') {
    return '*';
  }
  // Complex expression without alias -> unnamed; skip to avoid noise.
  return null;
}
