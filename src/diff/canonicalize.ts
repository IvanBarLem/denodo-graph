/**
 * Canonicalization of a single VQL statement for order-independent, format-
 * independent diffing.
 *
 * Two VQL scripts can be semantically equivalent yet differ on disk in
 * (a) statement order and (b) formatting (whitespace, comments, line breaks,
 * keyword casing). `canonicalStatement` neutralises (b) for one statement:
 * equivalent statements — regardless of how they were written — collapse to a
 * byte-identical canonical string, so a text diff shows nothing. Statement
 * *order* (a) is handled one level up in `vqlDiff.ts` by sorting statements.
 *
 * Everything here operates on a single (small) statement string and is a pure
 * function, so it is cheap and trivially unit-testable.
 */

import { stripComments } from '../parser/scanner';

/**
 * Collapse a statement to a canonical single-line form:
 *  - comments removed,
 *  - text outside string literals / quoted identifiers lower-cased (VQL folds
 *    unquoted identifiers and keywords to lower-case, so this is faithful, not
 *    lossy) and its whitespace collapsed to single spaces,
 *  - `'...'` string literals and `"..."` quoted identifiers copied verbatim
 *    (their case and internal spacing are significant).
 */
export function normalizeStatement(rawText: string): string {
  const s = stripComments(rawText);
  const n = s.length;
  let out = '';
  let pendingSpace = false;
  let i = 0;

  const flushSpace = () => {
    if (pendingSpace) {
      if (out.length > 0) out += ' ';
      pendingSpace = false;
    }
  };

  while (i < n) {
    const c = s[i];

    // String literal / quoted identifier: copy verbatim (with doubled-quote escape).
    if (c === "'" || c === '"') {
      flushSpace();
      const q = c;
      out += c;
      i++;
      while (i < n) {
        out += s[i];
        if (s[i] === q) {
          if (s[i + 1] === q) {
            out += s[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      pendingSpace = true;
      i++;
      continue;
    }

    flushSpace();
    out += c.toLowerCase();
    i++;
  }

  return out;
}

// Depth-0 keywords we break a line *before*, so an intra-statement change diffs
// at line granularity instead of highlighting one huge line.
const BREAK_BEFORE = new Set([
  'from',
  'where',
  'group',
  'having',
  'order',
  'union',
  'intersect',
  'minus',
  'except',
  'on',
  'context',
  'set',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross'
]);
const JOIN_MODIFIER = new Set(['inner', 'left', 'right', 'full', 'cross']);

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * Deterministic re-layout of a normalized statement: insert newlines before
 * top-level clause keywords and after top-level list commas. Applied identically
 * to both sides of a diff, so it never introduces a difference on its own; its
 * only job is to localise real differences to individual lines.
 */
export function reflow(normalized: string): string {
  const s = normalized;
  const n = s.length;
  let out = '';
  let depth = 0;
  let prevWord = '';

  const atLineStart = () => out.length === 0 || out[out.length - 1] === '\n';
  const newlineBefore = () => {
    if (atLineStart()) return;
    if (out.endsWith(' ')) out = out.slice(0, -1);
    out += '\n';
  };

  let i = 0;
  while (i < n) {
    const c = s[i];

    // Skip over string literals / quoted identifiers untouched.
    if (c === "'" || c === '"') {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        out += s[i];
        if (s[i] === q) {
          if (s[i + 1] === q) {
            out += s[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      prevWord = '';
      continue;
    }

    if (c === '(') {
      depth++;
      out += c;
      i++;
      prevWord = '';
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth--;
      out += c;
      i++;
      prevWord = '';
      continue;
    }
    if (c === ',') {
      out += ',';
      i++;
      // Break only after top-level (depth 0) commas — i.e. SELECT projection
      // columns — so each projected column diffs on its own line. Commas inside
      // any parentheses (schema field lists, function args, subselects) stay
      // inline, which keeps expression-heavy statements readable.
      if (depth === 0) {
        while (i < n && s[i] === ' ') i++;
        if (!atLineStart()) out += '\n';
      }
      prevWord = '';
      continue;
    }

    // Word token.
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      let w = '';
      while (j < n && isWordChar(s[j])) {
        w += s[j];
        j++;
      }
      const lw = w.toLowerCase();
      let doBreak = depth === 0 && BREAK_BEFORE.has(lw);
      // "left join" etc.: we already broke before the modifier, so don't also
      // break before "join".
      if (lw === 'join' && JOIN_MODIFIER.has(prevWord)) doBreak = false;
      if (doBreak) newlineBefore();
      out += w;
      i = j;
      prevWord = lw;
      continue;
    }

    // Any other character (spaces, operators, dots). Leave `prevWord` intact so
    // the whitespace between "left" and "join" doesn't defeat the join-modifier
    // check above.
    out += c;
    i++;
  }

  // Trim each line and drop blank lines the breaks may have produced.
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/** Full canonical form of one statement: normalized then re-laid-out. */
export function canonicalStatement(rawText: string): string {
  return reflow(normalizeStatement(rawText));
}
