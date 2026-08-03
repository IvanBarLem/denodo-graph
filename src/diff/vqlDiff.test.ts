import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph } from '../graph/graphBuilder';
import { canonicalDocument, computeSummary } from './vqlDiff';

const samples = join(__dirname, '..', '..', 'samples');
const read = (f: string) => readFileSync(join(samples, f), 'utf8');

test('reordered + reformatted equivalents produce an identical canonical document', () => {
  const a = read('diff-a.vql');
  const b = read('diff-b.vql');
  const docA = canonicalDocument(buildGraph(a), a);
  const docB = canonicalDocument(buildGraph(b), b);
  assert.equal(docA, docB, 'canonical documents should match for equivalent scripts');
});

test('a script has zero differences against itself', () => {
  const a = read('diff-a.vql');
  const g = buildGraph(a);
  const s = computeSummary(g, g, a, a);
  assert.deepEqual([s.added.length, s.removed.length, s.modified.length], [0, 0, 0]);
  assert.ok(s.unchanged > 0);
});

test('equivalent scripts differ only as unchanged (no add/remove/modify)', () => {
  const a = read('diff-a.vql');
  const b = read('diff-b.vql');
  const s = computeSummary(buildGraph(a), buildGraph(b), a, b);
  assert.deepEqual([s.added, s.removed, s.modified], [[], [], []]);
});

test('adding a whole element shows as added', () => {
  const a = read('diff-a.vql');
  const b =
    a + '\nCREATE OR REPLACE VIEW v_b AS SELECT a.id AS id FROM bv_a AS a WHERE a.id < 100;\n';
  const s = computeSummary(buildGraph(a), buildGraph(b), a, b);
  assert.deepEqual(s.added, ['demo.v_b']);
  assert.deepEqual(s.removed, []);
  assert.deepEqual(s.modified, []);
});

test('removing an element shows as removed (symmetric)', () => {
  const a = read('diff-a.vql');
  const b =
    a + '\nCREATE OR REPLACE VIEW v_b AS SELECT a.id AS id FROM bv_a AS a WHERE a.id < 100;\n';
  const s = computeSummary(buildGraph(b), buildGraph(a), b, a);
  assert.deepEqual(s.removed, ['demo.v_b']);
  assert.deepEqual(s.added, []);
});

test('a real change to a statement shows as modified, others unchanged', () => {
  const a = read('diff-a.vql');
  const b = a.replace('a.id > 0', 'a.id > 42'); // change the WHERE predicate
  assert.notEqual(a, b, 'fixture replacement must actually change something');
  const s = computeSummary(buildGraph(a), buildGraph(b), a, b);
  assert.deepEqual(s.modified, ['demo.v_a']);
  assert.deepEqual(s.added, []);
  assert.deepEqual(s.removed, []);
});

test('database-context matching: qualified name vs CONNECT DATABASE do not spuriously add/remove', () => {
  const q = 'CREATE OR REPLACE VIEW demo.v AS SELECT 1 AS x FROM t;';
  const connected = 'CONNECT DATABASE demo;\nCREATE OR REPLACE VIEW v AS SELECT 1 AS x FROM t;';
  const s = computeSummary(buildGraph(q), buildGraph(connected), q, connected);
  // Same logical element id (demo.v) on both sides => never counted as add/remove.
  assert.deepEqual(s.added, []);
  assert.deepEqual(s.removed, []);
});
