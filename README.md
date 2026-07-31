# Denodo VQL Graph

A Visual Studio Code extension that turns a **Denodo VQL** script into an
interactive **node graph** of its elements and their dependencies — built to
stay responsive on scripts with **millions of lines**.

Each node is a VQL *element* (data source, wrapper, base view, derived view,
interface view or association — **types are ignored**). Edges follow the data
flow (upstream → downstream). Click a node to see its **fields** and its
**references** (what it depends on / what depends on it), and jump straight to
its definition in the editor. Views that are **referenced but never defined**
are highlighted as *missing*.

---

## Features

- **Full element model** parsed directly from VQL:
  | Node | From statement | Edges |
  |---|---|---|
  | Data source | `CREATE DATASOURCE <type> <name>` | — |
  | Wrapper | `CREATE WRAPPER <type> <name> DATASOURCENAME=…` | → data source |
  | Base view | `CREATE TABLE <name> (…) … WRAPPER (<type> <w>)` | → wrapper |
  | Derived view | `CREATE VIEW <name> AS SELECT … FROM … JOIN …` | → each referenced view |
  | Interface view | `CREATE INTERFACE VIEW <name> (…) SET IMPLEMENTATION <v>` | → implementation |
  | Association | `CREATE ASSOCIATION <name> … ENDPOINT … ENDPOINT …` | → both endpoints |
- **Missing-view detection** — anything referenced but never `CREATE`d is drawn
  as a dashed red node and reported in the **Problems** panel.
- **Node inspector** — fields (name + type), upstream dependencies, and
  downstream dependents; click any reference to navigate.
- **Editor integration** — double-click a node (or *Open in editor*) to reveal
  its definition; missing views surface as warnings.
- **Scales to huge scripts** — a single linear-time parser (~380k lines/s,
  ~15 MB/s in benchmarks). Above `maxRenderNodes` the graph opens in **focus
  mode**: search an element and expand its neighbourhood instead of drawing
  everything at once.
- **UI/UX** — theme-aware, VS Code-native styling, type filters, a legend,
  multiple layouts (Hierarchy / Force / Concentric / Grid), search, and a
  details sidebar.

## Running it (from source)

```bash
npm install
npm run compile
```

Then press **F5** in VS Code to launch the *Extension Development Host*. Open a
`.vql` file (there is one in `samples/`) and run **“Denodo VQL: Open Graph”**
from the command palette, the editor title bar, or the right-click menu.

## Settings

| Setting | Default | Description |
|---|---|---|
| `denodoVqlGraph.maxRenderNodes` | `2500` | Above this, open in focus mode instead of drawing the whole graph. |
| `denodoVqlGraph.neighbourhoodDepth` | `2` | Dependency hops expanded around a focused node. |
| `denodoVqlGraph.reportMissingViews` | `true` | Report undefined references in the Problems panel. |

### Databases

Elements are grouped into **database boxes**. Each element belongs to the
database of the active `CONNECT DATABASE` when it was defined; unqualified
references bind to that same database, while `db.view` references bind across
databases. In the hierarchy layout each database gets its own vertical band, so
the boxes sit side by side with their layers aligned.

## Architecture

```
src/
  parser/
    scanner.ts       single-pass statement splitter (comment/string aware) + line index
    references.ts    tokenizer for SELECT bodies: FROM/JOIN refs + projected fields
    vqlParser.ts     classifies a statement -> element (name, fields, deps)
    model.ts         data model (flat, primitive-heavy for scale)
  graph/
    graphBuilder.ts  scan -> classify -> resolve missing -> reverse index -> stats
  webview/
    panel.ts         webview controller; full vs focus mode; details/search/subgraph; reveal
  extension.ts       activation + commands
media/
  main.js / main.css interactive Cytoscape graph + inspector (theme-aware)
  cytoscape.min.js   vendored (CSP-safe, no CDN)
```

### Why it is fast

- The scanner never builds an AST. It walks the source **once**, tracking string
  literals, quoted identifiers and comments only well enough to find real
  statement boundaries (`;`). This is `O(n)` with no backtracking.
- Per-statement regexes run on *individual statements*, never the whole file.
- The heavy payload (fields, dependency lists) is sent to the webview **lazily**
  on node selection; the initial payload is just `{id, label, kind, defined}`.
- Above the node threshold the UI never tries to lay out the whole graph.

### Parser limitations (best-effort areas)

- Derived-view **field names** come from the `SELECT` projection: aliases
  (`… AS x`) and simple columns are captured; complex un-aliased expressions and
  `SELECT *` are not expanded.
- `CASE … WHEN … THEN … END`, subselects (in `FROM`, in the projection, or
  inside a `CASE`) and `GROUP BY` are parsed correctly — expression keywords are
  never mistaken for tables, and references inside subselects are still
  discovered as dependencies.
- Dependencies are resolved by name against each element's database context.

## Tests & benchmark

```bash
npm run build:test
node --test dist-test/parser/vqlParser.test.js
```

The tests cover every element kind, missing-view detection, string-literal
semicolons, and the dependency/reverse indexes against `samples/example.vql`.
