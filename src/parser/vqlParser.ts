/**
 * Statement classification + element extraction.
 *
 * Given the raw statements from the scanner, this recognises the handful of
 * VQL `CREATE` statements that produce graph elements and pulls out their name,
 * fields and dependencies. Everything is regex/scan based on a *single*
 * (already small) statement string — never the whole document.
 */

import { Dependency, ElementKind, Field, VqlElement } from './model';
import { parseSelectBody } from './references';

export interface ParseOptions {
  stripDatabaseQualifier: boolean;
}

const RE_DATASOURCE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?DATASOURCE\s+([A-Za-z0-9_]+)\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;
const RE_WRAPPER =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?WRAPPER\s+([A-Za-z0-9_]+)\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;
const RE_TABLE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;
const RE_INTERFACE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?INTERFACE\s+VIEW\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;
const RE_VIEW =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;
const RE_ASSOCIATION =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?ASSOCIATION\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;

const RE_DATASOURCENAME = /\bDATASOURCENAME\s*=\s*("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;
const RE_WRAPPER_REF =
  /\bWRAPPER\s*\(\s*([A-Za-z0-9_]+)\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)\s*\)/i;
const RE_DATASOURCE_REF =
  /\bDATASOURCE\s+([A-Za-z0-9_]+)\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;
const RE_IMPLEMENTATION =
  /\bSET\s+IMPLEMENTATION\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;
const RE_ENDPOINT =
  /\bENDPOINT\s+(?:"(?:[^"]|"")+"|[A-Za-z0-9_./]+)\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/gi;
const RE_FOLDER = /\bFOLDER\s*=\s*'((?:[^']|'')*)'/i;

/** Remove surrounding double quotes and unescape "" -> ". */
function unquote(raw: string): string {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw;
}

function stripQualifier(name: string, opts: ParseOptions): string {
  if (!opts.stripDatabaseQualifier) return name;
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

function folderOf(body: string): string | undefined {
  const m = RE_FOLDER.exec(body);
  return m ? m[1].replace(/''/g, "'") : undefined;
}

/**
 * Find the content of the first balanced (...) group at or after `from`,
 * ignoring parentheses that appear inside quotes/strings. Statements passed
 * here are small, so this scan is cheap.
 */
function firstParenGroup(text: string, from: number): { content: string; end: number } | null {
  let i = text.indexOf('(', from);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < text.length) {
        if (text[i] === q) {
          if (text[i + 1] === q) {
            i++;
          } else {
            break;
          }
        }
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        return { content: text.slice(start + 1, i), end: i + 1 };
      }
    }
  }
  return null;
}

/** Split a field list on top-level commas (respecting nested parens/quotes). */
function splitTopLevel(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === "'" || c === '"') {
      const q = c;
      cur += c;
      i++;
      while (i < content.length) {
        cur += content[i];
        if (content[i] === q) {
          if (content[i + 1] === q) {
            cur += content[i + 1];
            i++;
          } else {
            break;
          }
        }
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Parse a `( name:type ..., name:type ... )` field list. */
function parseFieldList(content: string): Field[] {
  const fields: Field[] = [];
  for (const part of splitTopLevel(content)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // name : type [annotations...]
    const m = /^("(?:[^"]|"")+"|[A-Za-z0-9_$#]+)\s*:\s*([A-Za-z0-9_]+)/.exec(trimmed);
    if (m) {
      fields.push({ name: unquote(m[1]), type: m[2].toLowerCase() });
    } else {
      // fall back to just an identifier
      const m2 = /^("(?:[^"]|"")+"|[A-Za-z0-9_$#]+)/.exec(trimmed);
      if (m2) fields.push({ name: unquote(m2[1]) });
    }
  }
  return fields;
}

/**
 * Parse a wrapper's OUTPUTSCHEMA field list. Wrappers expose the columns they
 * retrieve from the source, in the form:
 *   OUTPUTSCHEMA ( localName = 'SOURCE' :'java.lang.Integer' (OPT) (...), ... )
 */
function parseWrapperFields(body: string): Field[] {
  const m = /\bOUTPUTSCHEMA\b/i.exec(body);
  if (!m) return [];
  const paren = firstParenGroup(body, m.index + m[0].length);
  if (!paren) return [];
  const fields: Field[] = [];
  for (const part of splitTopLevel(paren.content)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const f =
      /^("(?:[^"]|"")+"|[A-Za-z0-9_$#]+)\s*=\s*'(?:[^']|'')*'\s*:\s*'([^']*)'/.exec(trimmed);
    if (f) {
      const jt = f[2];
      const dot = jt.lastIndexOf('.');
      fields.push({ name: unquote(f[1]), type: dot >= 0 ? jt.slice(dot + 1) : jt });
    } else {
      const f2 = /^("(?:[^"]|"")+"|[A-Za-z0-9_$#]+)/.exec(trimmed);
      if (f2) fields.push({ name: unquote(f2[1]) });
    }
  }
  return fields;
}

/**
 * Classify one statement and return the element it defines, or null if it is
 * not a graph-relevant statement (CREATE TYPE, CREATE DATABASE, SET, ALTER,
 * stored procedures, web services, etc.).
 *
 * @param body   comment-stripped statement text (for classification/regex)
 * @param line   1-based line of the statement start
 * @param offset 0-based source offset of the statement start
 */
export function classifyStatement(
  body: string,
  line: number,
  offset: number,
  opts: ParseOptions
): VqlElement | null {
  // Fast reject: must start (after leading ws/comments already stripped) with CREATE.
  // A quick check avoids running six regexes on non-CREATE statements.
  const head = body.slice(0, 64).toUpperCase();
  const ci = head.indexOf('CREATE');
  if (ci < 0) return null;

  let m: RegExpExecArray | null;

  // Order matters: INTERFACE VIEW before VIEW.
  if ((m = RE_INTERFACE.exec(body))) {
    const name = unquote(m[1]);
    const deps: Dependency[] = [];
    const impl = RE_IMPLEMENTATION.exec(body);
    if (impl) deps.push({ ref: stripQualifier(unquote(impl[1]), opts), expect: 'view' });
    const paren = firstParenGroup(body, m.index + m[0].length - m[1].length);
    const fields = paren ? parseFieldList(paren.content) : [];
    return base('interface', name, { deps, fields, folder: folderOf(body), line, offset });
  }

  if ((m = RE_DATASOURCE.exec(body))) {
    const subtype = m[1].toUpperCase();
    const name = unquote(m[2]);
    return base('datasource', name, { subtype, folder: folderOf(body), line, offset });
  }

  if ((m = RE_WRAPPER.exec(body))) {
    const subtype = m[1].toUpperCase();
    const name = unquote(m[2]);
    const deps: Dependency[] = [];
    const ds = RE_DATASOURCENAME.exec(body);
    if (ds) deps.push({ ref: stripQualifier(unquote(ds[1]), opts), expect: 'datasource' });
    const fields = parseWrapperFields(body);
    return base('wrapper', name, { subtype, deps, fields, folder: folderOf(body), line, offset });
  }

  if ((m = RE_TABLE.exec(body))) {
    const name = unquote(m[1]);
    const deps: Dependency[] = [];
    const wref = RE_WRAPPER_REF.exec(body);
    if (wref) deps.push({ ref: stripQualifier(unquote(wref[2]), opts), expect: 'wrapper' });
    const dref = RE_DATASOURCE_REF.exec(body);
    // Fields: first paren group after the table name.
    const nameEnd = m.index + m[0].length;
    const paren = firstParenGroup(body, nameEnd);
    const fields = paren ? parseFieldList(paren.content) : [];
    const subtype = wref ? wref[1].toUpperCase() : dref ? dref[1].toUpperCase() : undefined;
    return base('baseView', name, { subtype, deps, fields, folder: folderOf(body), line, offset });
  }

  if ((m = RE_ASSOCIATION.exec(body))) {
    const name = unquote(m[1]);
    const deps: Dependency[] = [];
    let e: RegExpExecArray | null;
    RE_ENDPOINT.lastIndex = 0;
    const seen = new Set<string>();
    while ((e = RE_ENDPOINT.exec(body))) {
      const v = stripQualifier(unquote(e[1]), opts);
      if (!seen.has(v)) {
        seen.add(v);
        deps.push({ ref: v, expect: 'view' });
      }
    }
    return base('association', name, { deps, folder: folderOf(body), line, offset });
  }

  if ((m = RE_VIEW.exec(body))) {
    const name = unquote(m[1]);
    const info = parseSelectBody(body, opts.stripDatabaseQualifier);
    const deps: Dependency[] = info.refs
      .filter((r) => r && r.toLowerCase() !== name.toLowerCase())
      .map((r) => ({ ref: r, expect: 'view' as ElementKind }));
    const fields: Field[] = info.fields.filter((f) => f.name && f.name !== '*');
    return base('view', name, { deps, fields, folder: folderOf(body), line, offset });
  }

  return null;
}

function base(
  kind: ElementKind,
  name: string,
  extra: Partial<VqlElement> & { line: number; offset: number }
): VqlElement {
  return {
    id: name,
    name,
    kind,
    subtype: extra.subtype,
    folder: extra.folder,
    fields: extra.fields ?? [],
    deps: extra.deps ?? [],
    line: extra.line,
    offset: extra.offset,
    end: extra.end ?? extra.offset,
    defined: true
  };
}

const RE_TYPE = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TYPE\s+("(?:[^"]|"")+"|[A-Za-z0-9_./]+)/i;

/** Match a CREATE TYPE statement, returning the (unquoted) type name or null. */
export function matchTypeName(body: string): string | null {
  const m = RE_TYPE.exec(body);
  return m ? unquote(m[1]) : null;
}

const RE_FOLDER_DEF = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FOLDER\s+'((?:[^']|'')*)'/i;
const RE_CONNECT_DB = /^\s*CONNECT\s+DATABASE\s+("(?:[^"]|"")+"|[A-Za-z0-9_$#./]+)/i;
const RE_CREATE_DB = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?DATABASE\s+("(?:[^"]|"")+"|[A-Za-z0-9_$#./]+)/i;

/** Match a CREATE FOLDER statement, returning the folder path or null. */
export function matchFolderPath(body: string): string | null {
  const m = RE_FOLDER_DEF.exec(body);
  return m ? m[1].replace(/''/g, "'") : null;
}

/** Match CONNECT DATABASE / CREATE DATABASE, returning the database name + which. */
export function matchDatabase(body: string): { name: string; connect: boolean } | null {
  const c = RE_CONNECT_DB.exec(body);
  if (c) return { name: unquote(c[1]), connect: true };
  const cr = RE_CREATE_DB.exec(body);
  if (cr) return { name: unquote(cr[1]), connect: false };
  return null;
}
