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
- **Isolate path** — from a selected element, redraw the graph as *only* that
  element and its whole upstream dependency tree (down to the data sources,
  across databases). Ideal for tracing one lineage out of a crowded graph;
  a **Show all** link restores the full view.
- **Order-independent diff** — compare two VQL scripts ignoring statement order
  *and* formatting, two ways: a **line diff** in VS Code's native side-by-side
  editor (canonicalized text), or a fast **node diff** (`diffnode`) that compares
  the parsed elements and reports a structured per-element report (fields,
  dependencies, type/folder changes). See
  [Diffing two VQL files](#diffing-two-vql-files).
- **Syntax highlighting** — `.vql` files are colorized using Denodo's official
  VQL TextMate grammar (bundled; see [Credits](#credits)).
- **Editor integration** — double-click a node (or *Open in editor*) to reveal
  its definition; missing views surface as warnings.
- **Scales to huge scripts** — a single linear-time parser (~380k lines/s,
  ~15 MB/s in benchmarks). Above `maxRenderNodes` the graph opens in **focus
  mode**: search an element and expand its neighbourhood instead of drawing
  everything at once.
- **Works past the 50 MB editor limit** — VS Code refuses to *sync* files above
  50 MB to extensions, but the graph reads the VQL **directly from disk**, so it
  parses arbitrarily large scripts. (For such files the editor itself can't open
  the text, so *Open in editor* reports the element's line instead of jumping.)
- **Design menu** — customize how the graph looks and have it remembered across
  reloads: relation (edge) **width** and **style** (curved / straight /
  orthogonal), **node size**, **label** visibility (auto-hide when tiny / always
  / off), **direction arrows**, and whether the **database boxes** are drawn.
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

## Diffing two VQL files

There are **two** order-independent diff commands (palette, or select two `.vql`
files in the Explorer and right-click; from the palette with one file open, that
file is the left/base side and you are prompted for the right/changed side):

| Command | Output | Best for |
|---|---|---|
| **Diff Two VQL Files (order-independent)** | native side-by-side **line diff** of the canonicalized text | reading exactly *how* a statement changed (a JOIN, a `WHERE`, an expression) |
| **Diff Two VQL Files by Node (fast)** — `diffnode` | a **Markdown report** of added / removed / modified **elements** | a quick, structured "what changed" — which views/fields/dependencies differ — without scanning text |

### Line diff

Why not just `git diff`? Because two VQL exports of the *same* virtual database
routinely differ in ways that are **not** real changes:

- the `CREATE` statements come out in a **different order**, and
- the same statement is **formatted differently** (whitespace, line breaks,
  comments, keyword casing).

A line-based diff drowns you in that noise. Instead, each file is re-serialised
into a **canonical form** — statements sorted by element identity (database →
kind → name) and every statement normalized (comments stripped, whitespace
collapsed, casing folded outside string literals, deterministically re-laid-out)
— and the two canonical documents are opened in VS Code's built-in diff editor.
Reordering and reformatting therefore produce **zero** diff; only genuine
differences remain, highlighted line-by-line. A summary is shown
(`+added / −removed / ~modified / unchanged`).

Because element identity already carries the `CONNECT DATABASE` context,
`CONNECT DATABASE sales; CREATE VIEW v …` and `CREATE VIEW sales.v …` are matched
as the same element (no spurious add/remove).

**Scope / limitations**

- Only statements the parser models are compared: data sources, wrappers,
  base/derived/interface views, associations, and `CREATE TYPE` / `CREATE FOLDER`.
  Other statements (`SET`, `ALTER`, `GRANT`, stored procedures, web services) are
  omitted from the canonical document.
- Whitespace *runs* are collapsed, but a space that is present on one side and
  absent on the other around an operator (`a>0` vs `a > 0`) is a real text
  difference.
- The order of items **inside** one statement (e.g. `SELECT` column order) is
  meaningful (it is the output schema), so it is preserved — reordering columns
  within a single view still shows as a change.

### Node diff (`diffnode`)

The node diff skips text canonicalization and the line-by-line diff entirely. It
keys the parsed elements by identity and compares them **structurally** — fields
and dependencies as *sets*, plus kind / subtype / folder — so it is O(n) over the
elements and very fast. The result is a Markdown report:

- **Added / Removed** — elements present on only one side.
- **Modified** — per element, exactly what differs: fields added / removed /
  type-changed, dependencies added / removed, and subtype/folder changes. A
  change to logic the model does not capture (a `WHERE`/`JOIN`/`CASE`) is still
  flagged as *"definition changed"* (via a cheap normalized-text check) so
  nothing is silently missed — open the **line diff** to see those in detail.

Use `diffnode` for a fast structural overview ("which views and fields changed?");
use the line diff to read the exact statement-level edits.

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
- **Rendering scales too, not just parsing.** The parser handles ~12k elements
  in well under a second; the cost at scale is the canvas renderer. So above a
  few hundred on-screen nodes the graph automatically switches to a cheaper
  stylesheet — **straight edges** instead of beziers and no per-label outline —
  and labels stop being drawn once they'd be too small to read
  (`min-zoomed-font-size`), which is what keeps a fitted large graph responsive.

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
semicolons, the dependency/reverse indexes against `samples/example.vql`, and the
order-independent diff canonicalizer (`samples/diff-a.vql` / `samples/diff-b.vql`
are equivalent-but-reformatted fixtures).

## Credits

Syntax highlighting is provided by the **Denodo VQL** TextMate grammar
(`syntaxes/vql.tmLanguage.json`) and language configuration from
[`denodo/denodocommunity-resources`](https://github.com/denodo/denodocommunity-resources/tree/master/plugins/denodo-vscode-vql-syntax)
(*Denodo VQL Syntax Highlighting for VS Code*), bundled under its MIT license.
See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for details. The grammar
builds on VS Code's built-in `source.sql` grammar, declared as an extension
dependency (`vscode.sql`).
