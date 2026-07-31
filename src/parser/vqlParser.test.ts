import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph } from '../graph/graphBuilder';

const src = readFileSync(join(__dirname, '..', '..', 'samples', 'example.vql'), 'utf8');
const g = buildGraph(src);

// The sample runs under `CONNECT DATABASE sales`, so element ids are qualified.
const q = (name: string) => `sales.${name}`;

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
  // Two associations: sales.assoc_customer_orders and sales2.assoc_customer_orders.
  assert.equal(definedByKind('association'), 2, 'associations');
  assert.ok(!g.elements.has(q('my_record')), 'CREATE TYPE ignored');
  // byKind (all nodes) includes missing placeholders: orders_w wrapper + bv_regions view.
  assert.equal(g.stats.byKind.wrapper, 2, 'wrapper nodes incl. missing');
  assert.equal(g.stats.byKind.view, 3, 'view nodes incl. missing');
});

test('elements are tagged with their database context', () => {
  assert.equal(g.elements.get(q('bv_customer'))!.database, 'sales');
  assert.equal(g.elements.get(q('bv_customer'))!.name, 'bv_customer'); // display name unqualified
});

test('wrapper -> datasource dependency (qualified ids)', () => {
  const w = g.elements.get(q('customer_w'))!;
  assert.deepEqual(w.deps.map((d) => d.ref), [q('ds_oracle')]);
});

test('wrapper OUTPUTSCHEMA fields are parsed', () => {
  const w = g.elements.get(q('customer_w'))!;
  assert.deepEqual(w.fields.map((f) => f.name), ['id', 'name']);
  assert.equal(w.fields[0].type, 'Integer');
  assert.equal(w.fields[1].type, 'String');
});

test('base view -> wrapper dependency and fields', () => {
  const bv = g.elements.get(q('bv_customer'))!;
  assert.equal(bv.kind, 'baseView');
  assert.deepEqual(bv.deps.map((d) => d.ref), [q('customer_w')]);
  assert.deepEqual(bv.fields.map((f) => f.name), ['id', 'name', 'country']);
  assert.equal(bv.fields[0].type, 'int');
});

test('derived view FROM/JOIN references', () => {
  const v = g.elements.get(q('v_customer_orders'))!;
  assert.deepEqual(v.deps.map((d) => d.ref).sort(), [q('bv_customer'), q('bv_orders')]);
  assert.deepEqual(v.fields.map((f) => f.name), ['customer_id', 'customer_name', 'order_id', 'amount']);
});

test('missing view is detected (bv_regions, orders_w)', () => {
  const regions = g.elements.get(q('bv_regions'))!;
  assert.equal(regions.defined, false);
  assert.equal(regions.name, 'bv_regions');
  assert.equal(g.elements.get(q('orders_w'))!.defined, false);
  assert.ok(g.stats.missing >= 2);
});

test('interface view -> implementation dependency', () => {
  const iv = g.elements.get(q('iv_customer_summary'))!;
  assert.equal(iv.kind, 'interface');
  assert.deepEqual(iv.deps.map((d) => d.ref), [q('v_customer_summary')]);
  assert.deepEqual(iv.fields.map((f) => f.name), ['customer_id', 'customer_name', 'total']);
});

test('association references both endpoints', () => {
  const a = g.elements.get(q('assoc_customer_orders'))!;
  assert.deepEqual(a.deps.map((d) => d.ref).sort(), [q('bv_customer'), q('bv_orders')]);
});

test('dependents (used-by) reverse index', () => {
  const usedBy = g.dependents.get(q('bv_customer'))!.sort();
  // sales.bv_customer is used by the sales association + derived view, and also
  // by the cross-database association defined in sales2.
  assert.deepEqual(usedBy, [
    q('assoc_customer_orders'),
    q('v_customer_orders'),
    'sales2.assoc_customer_orders'
  ]);
});

test('captures CREATE TYPE separately and records source spans', () => {
  assert.ok(g.types.has('my_record'), 'my_record captured in types map');
  assert.ok(!g.elements.has(q('my_record')), 'my_record is not a graph element');
  const bv = g.elements.get(q('bv_customer'))!;
  assert.ok(bv.end > bv.offset, 'element has a source span');
  assert.match(src.slice(bv.offset, bv.end), /^CREATE OR REPLACE TABLE bv_customer/);
});

test('captures the database context for importable copies', () => {
  // g.database is the first-seen database; the sample opens with sales2.
  assert.equal(g.database, 'sales2');
});

test('semicolons inside string literals do not split statements', () => {
  assert.ok(g.elements.get(q('ds_oracle')));
  assert.equal(g.elements.get(q('ds_oracle'))!.kind, 'datasource');
});
