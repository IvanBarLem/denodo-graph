import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph } from '../graph/graphBuilder';
import { diffNodes } from './nodeDiff';

const samples = join(__dirname, '..', '..', 'samples');
const read = (f: string) => readFileSync(join(samples, f), 'utf8');

function run(a: string, b: string) {
  return diffNodes(buildGraph(a), buildGraph(b), a, b);
}

test('a script has no node-level differences against itself', () => {
  const a = read('diff-a.vql');
  const r = run(a, a);
  assert.deepEqual([r.added.length, r.removed.length, r.modified.length], [0, 0, 0]);
  assert.ok(r.unchanged > 0);
});

test('reordered + reformatted equivalents have no node-level differences', () => {
  const r = run(read('diff-a.vql'), read('diff-b.vql'));
  assert.deepEqual([r.added.length, r.removed.length, r.modified.length], [0, 0, 0]);
});

test('a new element is reported as added', () => {
  const a = read('diff-a.vql');
  const b = a + '\nCREATE OR REPLACE VIEW v_b AS SELECT a.id AS id FROM bv_a AS a;\n';
  const r = run(a, b);
  assert.deepEqual(r.added.map((n) => n.id), ['demo.v_b']);
  assert.equal(r.removed.length, 0);
  assert.equal(r.modified.length, 0);
});

test('a removed element is reported as removed', () => {
  const a = read('diff-a.vql');
  const b = a + '\nCREATE OR REPLACE VIEW v_b AS SELECT a.id AS id FROM bv_a AS a;\n';
  const r = run(b, a);
  assert.deepEqual(r.removed.map((n) => n.id), ['demo.v_b']);
  assert.equal(r.added.length, 0);
});

test('a field type change is reported structurally (not just as text)', () => {
  const a = read('diff-a.vql');
  const b = a.replace('name : text', 'name : varchar');
  const r = run(a, b);
  assert.equal(r.modified.length, 1);
  const c = r.modified[0];
  assert.equal(c.id, 'demo.bv_a');
  assert.deepEqual(c.fieldsTypeChanged, [{ name: 'name', from: 'text', to: 'varchar' }]);
  assert.deepEqual(c.fieldsAdded, []);
  assert.deepEqual(c.fieldsRemoved, []);
  assert.equal(c.structural, true);
});

test('a new dependency is reported as an added dep', () => {
  const a = read('diff-a.vql');
  // Add a JOIN to another base view -> a new dependency for v_a.
  const b = a.replace(
    'FROM bv_a AS a\nWHERE a.id > 0;',
    'FROM bv_a AS a\nINNER JOIN bv_a2 AS a2 ON a.id = a2.id\nWHERE a.id > 0;'
  );
  assert.notEqual(a, b, 'replacement must apply');
  const r = run(a, b);
  const c = r.modified.find((m) => m.id === 'demo.v_a');
  assert.ok(c, 'v_a should be modified');
  assert.ok(c!.depsAdded.includes('demo.bv_a2'), 'expected demo.bv_a2 in depsAdded');
});

test('an un-modelled logic change (WHERE) is caught via bodyChanged with no structural delta', () => {
  const a = read('diff-a.vql');
  const b = a.replace('a.id > 0', 'a.id > 42');
  const r = run(a, b);
  assert.equal(r.modified.length, 1);
  const c = r.modified[0];
  assert.equal(c.id, 'demo.v_a');
  assert.equal(c.structural, false, 'no fields/deps changed');
  assert.equal(c.bodyChanged, true, 'statement text changed');
});
