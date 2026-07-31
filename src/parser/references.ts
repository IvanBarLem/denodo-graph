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

const ALIAS_NOISE = new Set(['AS']);

function lastSegment(name: string, stripQualifier: boolean): string {
  if (!stripQualifier) return name;
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * Parse a full derived-view body (everything after `AS`), returning the set of
 * referenced views and a best-effort list of projected field names.
 */
export function parseSelectBody(body: string, stripQualifier: boolean): SelectInfo {
  const toks = tokenize(body);
  const refs = new Set<string>();
  const fields: { name: string }[] = [];
  let capturedProjection = false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    // Projection: capture field names from the first top-level SELECT ... FROM.
    if (!capturedProjection && t.t === 'id' && t.u === 'SELECT') {
      const proj = collectProjection(toks, i + 1);
      for (const f of proj.fields) fields.push(f);
      capturedProjection = true;
      continue;
    }

    if (t.t === 'id' && (t.u === 'FROM' || t.u === 'JOIN')) {
      i = collectTableRefs(toks, i + 1, t.u === 'FROM', refs, stripQualifier) - 1;
    }
  }

  return { refs: Array.from(refs), fields };
}

/**
 * Collect one (JOIN) or a comma list (FROM) of table references starting at
 * index `start`. Returns the index just past what was consumed.
 */
function collectTableRefs(
  toks: Tok[],
  start: number,
  isFrom: boolean,
  refs: Set<string>,
  stripQualifier: boolean
): number {
  let i = start;
  // eslint-disable-next-line no-constant-condition
  while (i < toks.length) {
    const t = toks[i];
    if (!t) break;

    if (t.t === 'punct' && t.v === '(') {
      // subquery / derived table: skip the balanced parens. Inner FROMs are
      // still discovered because the outer loop keeps scanning tokens after.
      i = skipParens(toks, i);
      // optional alias after subquery
      i = skipAlias(toks, i);
    } else if (t.t === 'id' && !JOIN_WORDS.has(t.u) && !STOP.has(t.u)) {
      refs.add(lastSegment(t.v, stripQualifier));
      i++;
      i = skipAlias(toks, i);
    } else {
      // hit a JOIN / stop keyword / unexpected token -> end of this segment
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

/** Advance past `AS`, an alias identifier, and any `flatten`-style noise. */
function skipAlias(toks: Tok[], i: number): number {
  if (toks[i] && toks[i].t === 'id' && ALIAS_NOISE.has(toks[i].u)) i++;
  // an alias is an identifier that is not a structural keyword
  if (
    toks[i] &&
    toks[i].t === 'id' &&
    !JOIN_WORDS.has(toks[i].u) &&
    !STOP.has(toks[i].u) &&
    toks[i].u !== 'FROM' &&
    toks[i].u !== 'JOIN'
  ) {
    i++;
  }
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
      return lastSegment(item[k + 1].v, true);
    }
  }
  // No alias: if it is a simple `a.b.c` or `*`, use the last identifier / '*'.
  // Only trust "simple" projections (single identifier token, maybe with '*').
  const ids = item.filter((t) => t.t === 'id');
  if (item.length === 1 && item[0].t === 'id') {
    return lastSegment(item[0].v, true);
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
