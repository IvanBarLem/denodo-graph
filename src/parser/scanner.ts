/**
 * Low-level, single-pass scanner utilities.
 *
 * The scanner never builds an AST. It only splits a (possibly enormous) VQL
 * script into top-level statements while correctly ignoring `;` that appear
 * inside string literals, quoted identifiers and comments. This is O(n) over
 * the input with no backtracking, which is what makes million-line scripts
 * tractable.
 */

export interface RawStatement {
  /** Raw statement text (includes any leading comments; excludes the ';'). */
  text: string;
  /** 0-based offset of the statement start in the source. */
  start: number;
}

function isWhitespace(code: number): boolean {
  return code === 32 /*space*/ || code === 9 /*tab*/ || code === 10 /*\n*/ || code === 13 /*\r*/;
}

const HASH = 35; // #
const DASH = 45; // -
const SLASH = 47; // /
const STAR = 42; // *
const SQUOTE = 39; // '
const DQUOTE = 34; // "
const SEMI = 59; // ;
const NL = 10; // \n

/**
 * Split a VQL script into top-level statements.
 *
 * Recognized "skip" regions whose contents are ignored for `;` detection:
 *  - `# ...` line comments
 *  - `-- ...` line comments
 *  - `/* ... *\/` block comments
 *  - `'...'` string literals (with `''` escape)
 *  - `"..."` quoted identifiers (with `""` escape)
 */
export function splitStatements(src: string): RawStatement[] {
  const out: RawStatement[] = [];
  const n = src.length;
  let i = 0;
  let stmtStart = 0;
  let hasContent = false;

  while (i < n) {
    const c = src.charCodeAt(i);

    // Line comment: # ...
    if (c === HASH) {
      i++;
      while (i < n && src.charCodeAt(i) !== NL) i++;
      continue;
    }
    // Line comment: -- ...
    if (c === DASH && i + 1 < n && src.charCodeAt(i + 1) === DASH) {
      i += 2;
      while (i < n && src.charCodeAt(i) !== NL) i++;
      continue;
    }
    // Block comment: /* ... */
    if (c === SLASH && i + 1 < n && src.charCodeAt(i + 1) === STAR) {
      i += 2;
      while (i < n && !(src.charCodeAt(i) === STAR && i + 1 < n && src.charCodeAt(i + 1) === SLASH)) {
        i++;
      }
      i += 2;
      continue;
    }
    // Single-quoted string literal (with '' escape)
    if (c === SQUOTE) {
      i++;
      while (i < n) {
        if (src.charCodeAt(i) === SQUOTE) {
          if (i + 1 < n && src.charCodeAt(i + 1) === SQUOTE) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      hasContent = true;
      continue;
    }
    // Double-quoted identifier (with "" escape)
    if (c === DQUOTE) {
      i++;
      while (i < n) {
        if (src.charCodeAt(i) === DQUOTE) {
          if (i + 1 < n && src.charCodeAt(i + 1) === DQUOTE) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      hasContent = true;
      continue;
    }
    // Statement terminator
    if (c === SEMI) {
      if (hasContent) {
        const text = src.slice(stmtStart, i);
        if (text.trim().length > 0) {
          out.push({ text, start: stmtStart });
        }
      }
      i++;
      stmtStart = i;
      hasContent = false;
      continue;
    }

    if (!isWhitespace(c)) hasContent = true;
    i++;
  }

  if (hasContent) {
    const text = src.slice(stmtStart);
    if (text.trim().length > 0) out.push({ text, start: stmtStart });
  }
  return out;
}

/**
 * Build a sorted array of line-start offsets so any character offset can be
 * mapped to a 1-based line number with a binary search. Built once per parse.
 */
export function buildLineIndex(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === NL) starts.push(i + 1);
  }
  return starts;
}

/** Map a 0-based offset to a 1-based line number using the line index. */
export function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Strip comments from a (small) statement string so classification regexes are
 * not confused by commented-out keywords. Preserves string literals verbatim.
 * Only ever called on individual statements, never on the whole document.
 */
export function stripComments(stmt: string): string {
  let out = '';
  const n = stmt.length;
  let i = 0;
  while (i < n) {
    const c = stmt.charCodeAt(i);
    if (c === HASH) {
      while (i < n && stmt.charCodeAt(i) !== NL) i++;
      continue;
    }
    if (c === DASH && i + 1 < n && stmt.charCodeAt(i + 1) === DASH) {
      while (i < n && stmt.charCodeAt(i) !== NL) i++;
      continue;
    }
    if (c === SLASH && i + 1 < n && stmt.charCodeAt(i + 1) === STAR) {
      i += 2;
      while (i < n && !(stmt.charCodeAt(i) === STAR && i + 1 < n && stmt.charCodeAt(i + 1) === SLASH)) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === SQUOTE) {
      const start = i;
      i++;
      while (i < n) {
        if (stmt.charCodeAt(i) === SQUOTE) {
          if (i + 1 < n && stmt.charCodeAt(i + 1) === SQUOTE) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += stmt.slice(start, i);
      continue;
    }
    out += stmt[i];
    i++;
  }
  return out;
}
