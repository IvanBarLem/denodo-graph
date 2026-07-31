import assert from 'node:assert';
import { test } from 'node:test';
import { buildGraph } from '../graph/graphBuilder';

/** Build a graph from an inline VQL fragment and return dep refs of a view. */
function depsOf(vql: string, viewId: string): string[] {
  const g = buildGraph(vql);
  const el = g.elements.get(viewId);
  assert.ok(el, `element ${viewId} not found (have: ${[...g.elements.keys()].join(', ')})`);
  return el!.deps.map((d) => d.ref).sort();
}
function fieldsOf(vql: string, viewId: string): string[] {
  const g = buildGraph(vql);
  return g.elements.get(viewId)!.fields.map((f) => f.name);
}

test('CASE ... WHEN ... THEN ... END does not create bogus references', () => {
  const vql = `
    CREATE OR REPLACE VIEW v AS
    SELECT id,
           CASE WHEN status = 'A' THEN 'active'
                WHEN status = 'C' THEN 'closed'
                ELSE 'other' END AS status_label
    FROM base_v
    WHERE amount > 0;`;
  // Only base_v is a real reference; CASE/WHEN/THEN/ELSE/END/WHERE are not.
  assert.deepEqual(depsOf(vql, 'v'), ['base_v']);
});

test('simple-form CASE with subselect inside is handled', () => {
  const vql = `
    CREATE OR REPLACE VIEW v AS
    SELECT id,
           CASE region
             WHEN 1 THEN (SELECT name FROM region_lookup)
             ELSE 'n/a'
           END AS region_name
    FROM base_v;`;
  // region_lookup (inside the CASE subselect) is a genuine dependency.
  assert.deepEqual(depsOf(vql, 'v'), ['base_v', 'region_lookup']);
});

test('subselect in FROM: inner view is a ref, its alias is not', () => {
  const vql = `
    CREATE OR REPLACE VIEW v AS
    SELECT s.id
    FROM (SELECT id FROM inner_v WHERE id > 0) AS s
    INNER JOIN other_v AS o ON (s.id = o.id);`;
  assert.deepEqual(depsOf(vql, 'v'), ['inner_v', 'other_v']);
});

test('scalar subselect in the projection contributes a dependency', () => {
  const vql = `
    CREATE OR REPLACE VIEW v AS
    SELECT a.id,
           (SELECT max(x) FROM metrics_v WHERE metrics_v.id = a.id) AS max_x
    FROM base_v AS a;`;
  assert.deepEqual(depsOf(vql, 'v'), ['base_v', 'metrics_v']);
});

test('GROUP BY / HAVING columns are not mistaken for tables', () => {
  const vql = `
    CREATE OR REPLACE VIEW v AS
    SELECT dept, count(*) AS n
    FROM emp_v
    GROUP BY dept
    HAVING count(*) > 5
    ORDER BY dept;`;
  assert.deepEqual(depsOf(vql, 'v'), ['emp_v']);
  assert.deepEqual(fieldsOf(vql, 'v'), ['dept', 'n']);
});

test('comma-separated FROM list captures every relation', () => {
  const vql = `CREATE OR REPLACE VIEW v AS SELECT 1 FROM a, b, c WHERE a.x = b.x;`;
  assert.deepEqual(depsOf(vql, 'v'), ['a', 'b', 'c']);
});

test('UNION of two selects references both sides', () => {
  const vql = `
    CREATE OR REPLACE VIEW v AS
    SELECT id FROM left_v
    UNION
    SELECT id FROM right_v;`;
  assert.deepEqual(depsOf(vql, 'v'), ['left_v', 'right_v']);
});

test('cross-database qualified references resolve to the right database', () => {
  const vql = `
    CONNECT DATABASE dwh;
    CREATE OR REPLACE VIEW v_local AS
    SELECT a.id
    FROM bv_a AS a
    INNER JOIN staging.bv_b AS b ON (a.id = b.id);`;
  const g = buildGraph(vql);
  const v = g.elements.get('dwh.v_local')!;
  // unqualified bv_a binds to the current db (dwh); staging.bv_b stays cross-db.
  assert.deepEqual(v.deps.map((d) => d.ref).sort(), ['dwh.bv_a', 'staging.bv_b']);
  // both are missing here, and land in the correct database box
  assert.equal(g.elements.get('dwh.bv_a')!.database, 'dwh');
  assert.equal(g.elements.get('staging.bv_b')!.database, 'staging');
});

test('elements switch database when CONNECT DATABASE changes', () => {
  const vql = `
    CONNECT DATABASE db1;
    CREATE OR REPLACE VIEW v1 AS SELECT 1 FROM t1;
    CONNECT DATABASE db2;
    CREATE OR REPLACE VIEW v2 AS SELECT 1 FROM t2;`;
  const g = buildGraph(vql);
  assert.equal(g.elements.get('db1.v1')!.database, 'db1');
  assert.equal(g.elements.get('db2.v2')!.database, 'db2');
  assert.deepEqual(g.elements.get('db1.v1')!.deps.map((d) => d.ref), ['db1.t1']);
  assert.deepEqual(g.elements.get('db2.v2')!.deps.map((d) => d.ref), ['db2.t2']);
});
