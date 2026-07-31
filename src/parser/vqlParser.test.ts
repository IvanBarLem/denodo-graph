import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph } from '../graph/graphBuilder';

const src = readFileSync(join(__dirname, '..', '..', 'samples', 'example.vql'), 'utf8');
const g = buildGraph(src, { stripDatabaseQualifier: true });

function definedByKind(kind: string): number {
  let n = 0;
  for (const e of g.elements.values()) if (e.defined && e.kind === kind) n++;
  return n;
}

test('extracts each defined element kind and ignores CREATE TYPE', () => {
  assert.equal(definedByKind('datasource'), 1, 'datasource');
  assert.equal(definedByKind('wrapper'), 1, 'defined wrappers');
  assert.equal(definedByKind('baseView'), 2, 'base views');
  assert.equal(definedByKind('view'), 2, 'derived views');
  assert.equal(definedByKind('interface'), 1, 'interface');
  assert.equal(definedByKind('association'), 1, 'association');
  // CREATE TYPE must not appear as an element.
  assert.ok(!g.elements.has('my_record'), 'CREATE TYPE ignored');
  // byKind (all nodes) includes missing placeholders: orders_w wrapper + bv_regions view.
  assert.equal(g.stats.byKind.wrapper, 2, 'wrapper nodes incl. missing');
  assert.equal(g.stats.byKind.view, 3, 'view nodes incl. missing');
});

test('wrapper -> datasource dependency', () => {
  const w = g.elements.get('customer_w');
  assert.ok(w);
  assert.deepEqual(w!.deps.map((d) => d.ref), ['ds_oracle']);
});

test('wrapper OUTPUTSCHEMA fields are parsed', () => {
  const w = g.elements.get('customer_w')!;
  assert.deepEqual(w.fields.map((f) => f.name), ['id', 'name']);
  assert.equal(w.fields[0].type, 'Integer');
  assert.equal(w.fields[1].type, 'String');
});

test('base view -> wrapper dependency and fields', () => {
  const bv = g.elements.get('bv_customer')!;
  assert.equal(bv.kind, 'baseView');
  assert.deepEqual(bv.deps.map((d) => d.ref), ['customer_w']);
  assert.deepEqual(bv.fields.map((f) => f.name), ['id', 'name', 'country']);
  assert.equal(bv.fields[0].type, 'int');
  assert.equal(bv.fields[1].type, 'text');
});

test('derived view FROM/JOIN references', () => {
  const v = g.elements.get('v_customer_orders')!;
  assert.deepEqual(v.deps.map((d) => d.ref).sort(), ['bv_customer', 'bv_orders']);
  // projection aliases parsed
  assert.deepEqual(v.fields.map((f) => f.name), ['customer_id', 'customer_name', 'order_id', 'amount']);
});

test('missing view is detected (bv_regions, orders_w)', () => {
  const regions = g.elements.get('bv_regions');
  assert.ok(regions, 'bv_regions placeholder exists');
  assert.equal(regions!.defined, false);
  const orders_w = g.elements.get('orders_w');
  assert.ok(orders_w, 'orders_w placeholder exists');
  assert.equal(orders_w!.defined, false);
  assert.ok(g.stats.missing >= 2);
});

test('interface view -> implementation dependency', () => {
  const iv = g.elements.get('iv_customer_summary')!;
  assert.equal(iv.kind, 'interface');
  assert.deepEqual(iv.deps.map((d) => d.ref), ['v_customer_summary']);
  assert.deepEqual(iv.fields.map((f) => f.name), ['customer_id', 'customer_name', 'total']);
});

test('association references both endpoints', () => {
  const a = g.elements.get('assoc_customer_orders')!;
  assert.equal(a.kind, 'association');
  assert.deepEqual(a.deps.map((d) => d.ref).sort(), ['bv_customer', 'bv_orders']);
});

test('dependents (used-by) reverse index', () => {
  const usedBy = g.dependents.get('bv_customer')!.sort();
  assert.deepEqual(usedBy, ['assoc_customer_orders', 'v_customer_orders']);
});

test('captures CREATE TYPE separately and records source spans', () => {
  // CREATE TYPE is not a graph node, but is retained for copy-with-dependencies.
  assert.ok(g.types.has('my_record'), 'my_record captured in types map');
  assert.ok(!g.elements.has('my_record'), 'my_record is not a graph element');

  const bv = g.elements.get('bv_customer')!;
  assert.ok(bv.end > bv.offset, 'element has a source span');
  const text = src.slice(bv.offset, bv.end);
  assert.match(text, /^CREATE OR REPLACE TABLE bv_customer/);
  assert.match(text, /WRAPPER \(JDBC customer_w\)\s*$/);

  const t = g.types.get('my_record')!;
  assert.match(src.slice(t.offset, t.end), /^CREATE OR REPLACE TYPE my_record/);
});

test('captures the database context for importable copies', () => {
  assert.equal(g.database, 'sales');
});

test('semicolons inside string literals do not split statements', () => {
  // The datasource password contains "; ... '' ..." and must stay one element.
  assert.ok(g.elements.get('ds_oracle'));
  assert.equal(g.elements.get('ds_oracle')!.kind, 'datasource');
});
