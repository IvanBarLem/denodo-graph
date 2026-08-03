import assert from 'node:assert';
import { test } from 'node:test';
import { normalizeStatement, reflow, canonicalStatement } from './canonicalize';

test('normalize lower-cases keywords/identifiers and collapses whitespace', () => {
  const got = normalizeStatement('CREATE   OR REPLACE   VIEW  V_A\n\tAS SELECT   1');
  assert.equal(got, 'create or replace view v_a as select 1');
});

test('normalize preserves string literals verbatim (case + spacing)', () => {
  const got = normalizeStatement("SELECT   'Hello   World' AS x");
  assert.equal(got, "select 'Hello   World' as x");
});

test('normalize preserves quoted-identifier case', () => {
  const got = normalizeStatement('CREATE VIEW "MyView" AS SELECT 1');
  assert.equal(got, 'create view "MyView" as select 1');
});

test('normalize strips line and block comments', () => {
  const got = normalizeStatement('create /* block */ view v # trailing\n as select 1');
  assert.equal(got, 'create view v as select 1');
});

test('normalize does not confuse a semicolon inside a string', () => {
  const got = normalizeStatement("USERPASSWORD = 'secret ; and '' quote'");
  assert.equal(got, "userpassword = 'secret ; and '' quote'");
});

test('canonicalStatement is identical for equivalent-but-differently-formatted input', () => {
  const a = 'CREATE VIEW v AS\nSELECT x, y\nFROM t\nWHERE x > 0';
  const b = 'create   view   v   as select x,   y from t   where x > 0';
  assert.equal(canonicalStatement(a), canonicalStatement(b));
});

test('reflow breaks before clause keywords and after top-level commas', () => {
  const out = reflow(normalizeStatement('SELECT a, b, c FROM t WHERE a > 0'));
  const lines = out.split('\n');
  assert.ok(lines.length >= 5, 'expected multi-line reflow, got: ' + JSON.stringify(lines));
  assert.ok(
    lines.some((l) => l.startsWith('from ')),
    'a line should start with from'
  );
  assert.ok(
    lines.some((l) => l.startsWith('where ')),
    'a line should start with where'
  );
});

test('reflow keeps "left join" on a single line (no split before join)', () => {
  const out = reflow(normalizeStatement('FROM a LEFT JOIN b ON a.id = b.id'));
  assert.ok(
    out.split('\n').some((l) => l.startsWith('left join ')),
    'expected a "left join" line, got: ' + JSON.stringify(out)
  );
});

test('reflow does not break inside nested function-call commas', () => {
  const out = reflow(normalizeStatement('SELECT coalesce(a, b, c) AS x FROM t'));
  assert.ok(
    out.split('\n').some((l) => l.includes('coalesce(a, b, c)')),
    'nested args should stay inline, got: ' + JSON.stringify(out)
  );
});
