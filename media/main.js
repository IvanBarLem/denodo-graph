/* global cytoscape, acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const KIND_COLOR = {
    datasource: '#4f9dde',
    wrapper: '#17a398',
    baseView: '#6ab04c',
    view: '#e58e26',
    interface: '#9b59b6',
    association: '#c0546b',
    unknown: '#808495'
  };
  const KIND_LABEL = {
    datasource: 'Data source',
    wrapper: 'Wrapper',
    baseView: 'Base view',
    view: 'Derived view',
    interface: 'Interface view',
    association: 'Association',
    unknown: 'Unknown'
  };
  const MISSING_COLOR = '#e74c3c';

  // ---- Icons -------------------------------------------------------------
  // One small SVG glyph per kind, encoded once as a data URI and shared by ALL
  // nodes of that kind via the stylesheet (never stored per-node). This keeps
  // memory flat even with millions of nodes: ~14 image strings total.
  const ICON_PATHS = {
    datasource:
      '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    wrapper: '<path d="M9 4C6.5 4 7.5 10.5 4.5 12c3 1.5 2 8 4.5 8"/><path d="M15 4c2.5 0 1.5 6.5 4.5 8-3 1.5-2 8-4.5 8"/>',
    baseView: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 10h16"/><path d="M12 5v14"/>',
    view: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5"/>',
    interface: '<path d="M12 3l7 4v8l-7 4-7-4V7z"/><circle cx="12" cy="11" r="3"/>',
    association: '<path d="M9.5 14.5a4 4 0 0 1 0-5l1.5-1.5a4 4 0 0 1 5.5 0"/><path d="M14.5 9.5a4 4 0 0 1 0 5L13 16a4 4 0 0 1-5.5 0"/>',
    unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.4c-.9.4-1 .9-1 1.6"/><path d="M12 16.5h.01"/>'
  };
  function svgIcon(inner, stroke) {
    // Explicit width/height so the canvas rasterizes the glyph crisply; slightly
    // thicker strokes keep it legible when nodes are small / zoomed out.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="' +
      stroke +
      '" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
      inner +
      '</svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  const ICON = {};
  const ICON_MISS = {};
  for (const k of Object.keys(ICON_PATHS)) {
    ICON[k] = svgIcon(ICON_PATHS[k], '#ffffff');
    ICON_MISS[k] = svgIcon(ICON_PATHS[k], MISSING_COLOR);
  }

  // User-tunable visual design (the "Design" menu). Persisted via vscode state
  // so choices survive a reload. Kept flat and primitive so it serializes
  // trivially and threads straight into the shared stylesheet.
  const DEFAULT_DESIGN = {
    edgeWidth: 1.5, // relation line thickness
    curve: 'bezier', // 'bezier' | 'straight' | 'taxi' (orthogonal)
    arrows: true, // draw direction arrowheads
    nodeSize: 48, // node width/height in px
    labels: 'auto', // 'auto' (cull when tiny) | 'always' | 'off'
    showBoxes: true // draw the database grouping boxes
  };

  function loadDesign() {
    const saved = (vscode.getState && vscode.getState()) || null;
    const d = saved && saved.design;
    return Object.assign({}, DEFAULT_DESIGN, d && typeof d === 'object' ? d : {});
  }
  function saveDesign() {
    if (!vscode.setState) return;
    const prev = (vscode.getState && vscode.getState()) || {};
    vscode.setState(Object.assign({}, prev, { design: state.design }));
  }

  const state = {
    mode: 'full',
    depth: 2,
    activeKinds: new Set(Object.keys(KIND_COLOR)),
    showMissing: true,
    cy: null,
    selected: null,
    colors: null, // { FG, BG, EDGE } captured at init, for stylesheet rebuilds
    fast: false, // whether the fast (large-graph) stylesheet is currently active
    design: loadDesign()
  };

  // Above this many rendered nodes, switch to a cheaper stylesheet: straight
  // edges instead of beziers and no per-label outline pass. Both are major
  // Cytoscape canvas-render costs at scale.
  const FAST_RENDER_ABOVE = 500;

  const el = {
    cy: document.getElementById('cy'),
    search: document.getElementById('search'),
    searchResults: document.getElementById('searchResults'),
    typesBtn: document.getElementById('typesBtn'),
    typesBtnLabel: document.getElementById('typesBtnLabel'),
    typesMenu: document.getElementById('typesMenu'),
    designBtn: document.getElementById('designBtn'),
    designMenu: document.getElementById('designMenu'),
    layout: document.getElementById('layout'),
    reload: document.getElementById('reload'),
    fit: document.getElementById('fit'),
    settings: document.getElementById('settings'),
    sidebar: document.getElementById('sidebar'),
    banner: document.getElementById('banner'),
    hint: document.getElementById('hint'),
    status: document.getElementById('status'),
    legend: document.getElementById('legend')
  };

  // ---------------- cytoscape ----------------

  // Build the stylesheet. Colours and icons are attached per-kind via selectors
  // (stored once), NOT per node, so node data stays minimal: {id, label, kind}.
  function buildStyle(FG, BG, EDGE, fast, design) {
    const d = design || DEFAULT_DESIGN;
    // In fast mode, labels lose their outline (a second stroke pass per label)
    // and edges are forced straight — both are major canvas costs at scale, so
    // the auto perf mode overrides the user's curve/outline choice.
    const nodeOutline = fast ? 0 : 3;
    const edgeCurve = fast ? 'straight' : d.curve;
    // Label visibility: 'off' draws no label at all; 'always' keeps labels at
    // every zoom; 'auto' culls them once they'd be too small to read (which is
    // what keeps a fitted large graph responsive).
    const nodeLabel = d.labels === 'off' ? '' : 'data(label)';
    const nodeMinZoom = d.labels === 'always' ? 0 : 7;
    const style = [
      {
        selector: 'node',
        style: {
          shape: 'round-rectangle',
          width: d.nodeSize,
          height: d.nodeSize,
          'background-color': KIND_COLOR.unknown,
          'background-fit': 'none',
          'background-width': '66%',
          'background-height': '66%',
          'background-position-x': '50%',
          'background-position-y': '50%',
          'border-width': 2,
          'border-color': BG,
          'border-opacity': 0.35,
          label: nodeLabel,
          color: FG,
          'font-size': 12,
          'font-weight': 'bold',
          'text-valign': 'bottom',
          'text-margin-y': 5,
          'text-wrap': 'ellipsis',
          'text-max-width': 150,
          'text-outline-width': nodeOutline,
          'text-outline-color': BG,
          'min-zoomed-font-size': nodeMinZoom,
          'z-index': 1
        }
      }
    ];
    // Database box (compound parent): a labelled container behind its elements.
    // When hidden it is kept as a layout parent (so elements stay grouped) but
    // rendered invisible — no fill, border, or label.
    const boxes = d.showBoxes;
    style.push({
      selector: 'node.dbbox',
      style: {
        shape: 'round-rectangle',
        'background-color': getCssVar('--vscode-foreground', '#888'),
        'background-opacity': boxes ? 0.05 : 0,
        'background-image': 'none',
        'border-width': boxes ? 1.5 : 0,
        'border-color': getCssVar('--vscode-foreground', '#888'),
        'border-opacity': 0.4,
        'border-style': 'solid',
        label: boxes ? 'data(label)' : '',
        'font-size': 15,
        'font-weight': 'bold',
        color: FG,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': 6,
        'text-outline-width': 3,
        'text-outline-color': BG,
        'min-zoomed-font-size': 6,
        padding: boxes ? 26 : 14,
        'z-index': 0,
        'z-compound-depth': 'bottom',
        'min-width': 40,
        'min-height': 40,
        // Make the box purely decorative: pointer events pass through to the
        // canvas so clicking/dragging over it pans instead of grabbing the box.
        events: 'no'
      }
    });
    for (const k of Object.keys(KIND_COLOR)) {
      style.push({
        selector: 'node[kind="' + k + '"]',
        style: { 'background-color': KIND_COLOR[k], 'background-image': ICON[k] }
      });
    }
    // Missing (undefined) nodes: hollow, dashed red ring, red glyph.
    style.push({
      selector: 'node.missing',
      style: {
        'background-opacity': 0,
        'border-width': 2.5,
        'border-color': MISSING_COLOR,
        'border-opacity': 1,
        'border-style': 'dashed',
        color: MISSING_COLOR
      }
    });
    for (const k of Object.keys(KIND_COLOR)) {
      style.push({ selector: 'node.missing[kind="' + k + '"]', style: { 'background-image': ICON_MISS[k] } });
    }
    // Interaction states (declared last so they win over kind/missing styles).
    style.push({ selector: 'node.dim', style: { opacity: 0.12, 'text-opacity': 0.05 } });
    style.push({
      selector: 'node.selected',
      style: {
        'border-width': 4,
        'border-color': getCssVar('--vscode-focusBorder', '#3794ff'),
        'border-opacity': 1,
        'border-style': 'solid',
        'z-index': 3
      }
    });
    style.push({
      selector: 'node.highlight',
      style: {
        'border-width': 3.5,
        'border-color': '#f1c40f',
        'border-opacity': 1,
        'border-style': 'solid',
        'z-index': 2
      }
    });
    style.push({
      selector: 'edge',
      style: {
        width: d.edgeWidth,
        'line-color': EDGE,
        'target-arrow-color': EDGE,
        'target-arrow-shape': d.arrows ? 'triangle' : 'none',
        'arrow-scale': 0.7,
        'curve-style': edgeCurve,
        // Ignored unless curve-style is 'taxi'; makes orthogonal edges run
        // vertically, matching the bottom-to-top hierarchy layers.
        'taxi-direction': 'vertical',
        'taxi-turn': '50%',
        opacity: 0.55
      }
    });
    style.push({ selector: 'edge.dim', style: { opacity: 0.05 } });
    style.push({
      selector: 'edge.hl',
      style: {
        'line-color': '#f1c40f',
        'target-arrow-color': '#f1c40f',
        opacity: 1,
        width: Math.max(2, d.edgeWidth + 0.75)
      }
    });
    return style;
  }

  function initCy() {
    // Cytoscape renders to a canvas, so it needs concrete color strings, not
    // CSS var() references (which only resolve in the DOM).
    const FG = getCssVar('--vscode-foreground', '#cccccc');
    const BG = getCssVar('--vscode-editor-background', '#1e1e1e');
    const EDGE = getCssVar('--vscode-panel-border', '#666666');
    state.colors = { FG, BG, EDGE };
    state.cy = cytoscape({
      container: el.cy,
      wheelSensitivity: 0.2,
      pixelRatio: 1,
      textureOnViewport: true,
      hideEdgesOnViewport: true,
      motionBlur: false,
      maxZoom: 3,
      minZoom: 0.02,
      style: buildStyle(FG, BG, EDGE, false, state.design)
    });

    // Cytoscape has no native double-tap event, so detect it manually.
    let lastTapId = null;
    let lastTapTime = 0;
    state.cy.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      const now = Date.now();
      if (id === lastTapId && now - lastTapTime < 300) {
        vscode.postMessage({ type: 'reveal', id: id });
        lastTapId = null;
        lastTapTime = 0;
        return;
      }
      lastTapId = id;
      lastTapTime = now;
      selectNode(id);
      vscode.postMessage({ type: 'selectNode', id: id });
    });
    state.cy.on('tap', (evt) => {
      if (evt.target === state.cy) clearSelection();
    });
  }

  function dbBoxId(db) {
    return '__db__' + db;
  }

  function elements(nodes, edges) {
    const out = [];
    // A compound "box" node per database, so elements between CONNECT DATABASE
    // (or reached via a db.qualified name) are visually grouped.
    const dbs = new Set();
    for (const n of nodes) if (n.database) dbs.add(n.database);
    for (const db of dbs) {
      out.push({
        group: 'nodes',
        data: { id: dbBoxId(db), label: db, isDb: true },
        classes: 'dbbox',
        selectable: false,
        grabbable: false
      });
    }
    for (const n of nodes) {
      // Minimal per-node data; colour + icon come from the stylesheet by kind.
      const data = { id: n.id, label: n.label, kind: n.kind };
      if (n.database) {
        data.db = n.database;
        data.parent = dbBoxId(n.database);
      }
      out.push({ group: 'nodes', data: data, classes: n.defined ? '' : 'missing' });
    }
    for (const e of edges) {
      out.push({ group: 'edges', data: { id: e.source + ' ' + e.target, source: e.source, target: e.target } });
    }
    return out;
  }

  // Swap between the normal and fast (large-graph) stylesheets based on how many
  // nodes are on screen. Rebuilding the shared stylesheet is O(1) in element
  // count (styles are stored once, not per node), so this is cheap; we only do
  // it when the mode actually flips to avoid needless re-renders.
  function applyRenderScale() {
    const cy = state.cy;
    const wantFast = cy.nodes().length > FAST_RENDER_ABOVE;
    if (wantFast === state.fast || !state.colors) return;
    const styler = cy.style && cy.style();
    if (!styler || !styler.fromJson) return; // no renderer style (e.g. headless)
    state.fast = wantFast;
    const c = state.colors;
    styler.fromJson(buildStyle(c.FG, c.BG, c.EDGE, wantFast, state.design)).update();
  }

  // Re-apply the current design settings to the live graph. Rebuilding the
  // shared stylesheet is O(1) in element count (styles are stored once, not per
  // node), so this stays cheap even on large graphs. A curve change to/from
  // 'taxi' needs the edges recomputed, which .update() handles.
  function applyDesign() {
    const cy = state.cy;
    if (!cy || !state.colors) return;
    const styler = cy.style && cy.style();
    if (!styler || !styler.fromJson) return;
    const c = state.colors;
    styler.fromJson(buildStyle(c.FG, c.BG, c.EDGE, state.fast, state.design)).update();
  }

  function render(nodes, edges, doLayout) {
    const cy = state.cy;
    cy.startBatch();
    cy.elements().remove();
    // Only add edges whose endpoints exist in the node set.
    const ids = new Set(nodes.map((n) => n.id));
    const safeEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    cy.add(elements(nodes, safeEdges));
    cy.endBatch();
    applyRenderScale();
    applyKindFilter();
    if (doLayout !== false) runLayout();
    updateStatusCounts();
  }

  function mergeSubgraph(nodes, edges) {
    const cy = state.cy;
    cy.startBatch();
    const existing = new Set(cy.nodes().map((n) => n.id()));
    const toAdd = [];
    const ids = new Set(cy.nodes().map((n) => n.id()));
    for (const n of nodes) {
      ids.add(n.id);
    }
    for (const n of nodes) {
      if (!existing.has(n.id)) toAdd.push(n);
    }
    // elements() also emits db-box parents; drop any node already present.
    const addEls = elements(toAdd, []).filter((e) => e.group === 'edges' || cy.getElementById(e.data.id).empty());
    for (const e of edges) {
      if (ids.has(e.source) && ids.has(e.target)) {
        const eid = e.source + ' ' + e.target;
        if (cy.getElementById(eid).empty()) {
          addEls.push({ group: 'edges', data: { id: eid, source: e.source, target: e.target } });
        }
      }
    }
    cy.add(addEls);
    cy.endBatch();
    applyRenderScale();
    applyKindFilter();
    runLayout();
    updateStatusCounts();
  }

  function runLayout() {
    const name = el.layout.value;
    const cy = state.cy;
    if (name === 'hierarchy') {
      runHierarchy();
      return;
    }
    const common = { name, animate: false, fit: true, padding: 40 };
    let opts = common;
    if (name === 'cose') {
      // Force (cose) does O(n²·iterations) repulsion with no spatial index, so a
      // fixed iteration count freezes on large graphs (~12 s at 2.5k nodes).
      // Budget the iterations against node count for a fixed time ceiling
      // (~1.5 s): full quality on small graphs, degrading gracefully on big ones
      // instead of locking up the webview.
      const N = Math.max(1, cy.nodes().length);
      const numIter = Math.max(30, Math.min(1000, Math.round(2.3e8 / (N * N))));
      if (numIter < 300) {
        setStatus(
          'Force layout capped at ' + numIter + ' iterations for ' + N +
            ' nodes to stay responsive — use Hierarchy for a cleaner large-graph layout.'
        );
      }
      opts = Object.assign({}, common, { nodeRepulsion: 6000, idealEdgeLength: 60, numIter });
    } else if (name === 'concentric') {
      opts = Object.assign({}, common, {
        concentric: (n) => n.degree(),
        levelWidth: () => 4
      });
    }
    cy.layout(opts).run();
  }

  // Layered "bottom-to-top" hierarchy. Layers are forced by element kind, then
  // deepened by dependency chains, so:
  //   level 0 (bottom) = data sources
  //   level 1          = wrappers
  //   level 2          = base views
  //   level 3+         = derived / interface / association views (chains stack up)
  const KIND_BASE_LEVEL = {
    datasource: 0,
    wrapper: 1,
    baseView: 2,
    view: 3,
    interface: 3,
    association: 3,
    unknown: 3
  };

  // Level per node (leaves only; db-box parents are excluded and auto-sized).
  function computeLevels(leaves) {
    const cy = state.cy;
    const memo = new Map();
    const visiting = new Set();
    function lvl(id) {
      if (memo.has(id)) return memo.get(id);
      const node = cy.getElementById(id);
      if (node.empty() || node.hasClass('dbbox')) return 0;
      const base = KIND_BASE_LEVEL[node.data('kind')];
      const b = base == null ? 3 : base;
      if (visiting.has(id)) return b; // cycle guard (VQL deps are a DAG, but be safe)
      visiting.add(id);
      let m = b;
      // incomers('node') = this node's dependencies (edges point dep -> node)
      node.incomers('node').forEach((dep) => {
        const dl = 1 + lvl(dep.id());
        if (dl > m) m = dl;
      });
      visiting.delete(id);
      memo.set(id, m);
      return m;
    }
    leaves.forEach((n) => lvl(n.id()));
    return memo;
  }

  const NO_DB = ' none';

  // Layered "bottom-to-top" hierarchy, split into a horizontal band per
  // database so the database boxes sit side by side and never overlap. Levels
  // (y) are shared across bands so data sources line up along the bottom.
  function runHierarchy() {
    const cy = state.cy;
    const leaves = cy.nodes().not('.dbbox');
    const level = computeLevels(leaves);

    let maxLevel = 0;
    leaves.forEach((n) => {
      const l = level.get(n.id()) || 0;
      if (l > maxLevel) maxLevel = l;
    });

    // Group nodes by database, then by level within each database.
    const bands = new Map(); // db -> Map(level -> node[])
    const dbOrder = [];
    leaves.forEach((n) => {
      const db = n.data('db') || NO_DB;
      if (!bands.has(db)) {
        bands.set(db, new Map());
        dbOrder.push(db);
      }
      const lv = level.get(n.id()) || 0;
      const m = bands.get(db);
      if (!m.has(lv)) m.set(lv, []);
      m.get(lv).push(n);
    });
    dbOrder.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const rowH = 150;
    const colW = 185;
    const bandGap = colW * 1.4;
    const positions = {};
    let bandStart = 0;

    for (const db of dbOrder) {
      const m = bands.get(db);
      let widest = 1;
      for (const arr of m.values()) widest = Math.max(widest, arr.length);
      const bandWidth = (widest - 1) * colW;
      const placedX = new Map();
      const levels = Array.from(m.keys()).sort((a, b) => a - b);

      for (const lv of levels) {
        const arr = m.get(lv);
        // Barycenter ordering within the band (based on already-placed lower rows).
        arr.forEach((n) => {
          let sum = 0;
          let cnt = 0;
          n.incomers('node').forEach((p) => {
            if (placedX.has(p.id())) {
              sum += placedX.get(p.id());
              cnt++;
            }
          });
          n.scratch('_bary', cnt ? sum / cnt : null);
        });
        arr.sort((a, b) => {
          const ba = a.scratch('_bary');
          const bb = b.scratch('_bary');
          if (ba == null && bb == null) return a.data('label') < b.data('label') ? -1 : 1;
          if (ba == null) return 1;
          if (bb == null) return -1;
          return ba - bb || (a.data('label') < b.data('label') ? -1 : 1);
        });

        const rowStart = bandStart + (bandWidth - (arr.length - 1) * colW) / 2;
        arr.forEach((n, i) => {
          const x = rowStart + i * colW;
          // level 0 (data sources) gets the largest y => rendered at the bottom.
          positions[n.id()] = { x: x, y: (maxLevel - lv) * rowH };
          placedX.set(n.id(), x);
        });
      }
      bandStart += bandWidth + bandGap;
    }

    cy.layout({
      name: 'preset',
      // db-box parents get no explicit position; cytoscape sizes them to fit.
      positions: (n) => positions[n.id()],
      fit: true,
      padding: 55,
      animate: false
    }).run();
  }

  // ---------------- selection / highlight ----------------

  function selectNode(id) {
    const cy = state.cy;
    state.selected = id;
    cy.batch(() => {
      cy.elements().removeClass('selected highlight hl dim');
      const node = cy.getElementById(id);
      if (node.empty()) return;
      // Highlight the entire lineage path from this node down to the data
      // sources: predecessors() follows incoming edges (dep -> node) transitively.
      const ancestors = node.predecessors(); // nodes + edges along all upstream paths
      const path = ancestors.union(node);
      // Dim everything except the path — but never the database boxes.
      cy.elements().not('.dbbox').addClass('dim');
      path.removeClass('dim');
      path.nodes().addClass('highlight');
      path.edges().addClass('hl');
      node.removeClass('highlight').addClass('selected');
    });
  }

  function clearSelection() {
    state.selected = null;
    state.cy.elements().removeClass('selected highlight hl dim');
    el.sidebar.classList.add('hidden');
  }

  function centerOn(id) {
    const node = state.cy.getElementById(id);
    if (node.empty()) return false;
    state.cy.animate({ center: { eles: node }, zoom: Math.max(state.cy.zoom(), 1) }, { duration: 250 });
    return true;
  }

  // ---------------- filters / legend ----------------

  // A small colored badge with the kind's white icon (mirrors the node look),
  // reused in the type dropdown, the legend and the sidebar header.
  function kindChip(kind, missing) {
    const uri = missing ? ICON_MISS[kind] : ICON[kind];
    const bg = missing ? 'transparent;border:1.5px dashed ' + MISSING_COLOR : KIND_COLOR[kind];
    return (
      '<span class="chip" style="background:' +
      bg +
      '"><img class="ic" src="' +
      uri +
      '" width="13" height="13" alt=""/></span>'
    );
  }

  function buildTypesMenu() {
    const menu = el.typesMenu;
    let html = '<div class="menu-head"><a data-all="1">All</a><span>·</span><a data-all="0">None</a></div>';
    for (const kind of Object.keys(KIND_COLOR)) {
      html +=
        '<label class="menu-item"><input type="checkbox" data-kind="' +
        kind +
        '"' +
        (state.activeKinds.has(kind) ? ' checked' : '') +
        '/>' +
        kindChip(kind, false) +
        '<span class="mi-label">' +
        KIND_LABEL[kind] +
        '</span></label>';
    }
    html += '<div class="menu-sep"></div>';
    html +=
      '<label class="menu-item"><input type="checkbox" id="chkMissing"' +
      (state.showMissing ? ' checked' : '') +
      '/>' +
      kindChip('unknown', true) +
      '<span class="mi-label">Missing (undefined)</span></label>';
    menu.innerHTML = html;

    menu.querySelectorAll('input[data-kind]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.activeKinds.add(cb.dataset.kind);
        else state.activeKinds.delete(cb.dataset.kind);
        applyKindFilter();
        updateTypesBtn();
      });
    });
    const miss = menu.querySelector('#chkMissing');
    miss.addEventListener('change', () => {
      state.showMissing = miss.checked;
      applyKindFilter();
    });
    menu.querySelectorAll('a[data-all]').forEach((a) => {
      a.addEventListener('click', () => {
        const on = a.dataset.all === '1';
        state.activeKinds = new Set(on ? Object.keys(KIND_COLOR) : []);
        menu.querySelectorAll('input[data-kind]').forEach((cb) => (cb.checked = on));
        applyKindFilter();
        updateTypesBtn();
      });
    });
    updateTypesBtn();
  }

  function updateTypesBtn() {
    const total = Object.keys(KIND_COLOR).length;
    const on = state.activeKinds.size;
    el.typesBtnLabel.textContent =
      on === total ? 'Types: all' : on === 0 ? 'Types: none' : 'Types: ' + on + '/' + total;
  }

  // ---------------- design menu ----------------

  // Build the "Design" dropdown: appearance controls that write straight into
  // state.design, re-style the live graph (applyDesign) and persist the choice.
  function buildDesignMenu() {
    const d = state.design;
    const menu = el.designMenu;
    const html =
      '<div class="menu-head"><span>Appearance</span><span>·</span><a data-reset="1">Reset</a></div>' +
      // Relation (edge) width
      row(
        'Relation width',
        '<input type="range" id="dz-edgew" min="0.5" max="6" step="0.5" value="' + d.edgeWidth + '"/>' +
          '<span class="mr-val" id="dz-edgew-v">' + d.edgeWidth + '</span>'
      ) +
      // Relation style (curve)
      row(
        'Relation style',
        '<select id="dz-curve">' +
          opt('bezier', 'Curved', d.curve) +
          opt('straight', 'Straight', d.curve) +
          opt('taxi', 'Orthogonal', d.curve) +
          '</select>'
      ) +
      // Node size
      row(
        'Node size',
        '<input type="range" id="dz-size" min="28" max="80" step="4" value="' + d.nodeSize + '"/>' +
          '<span class="mr-val" id="dz-size-v">' + d.nodeSize + '</span>'
      ) +
      // Labels
      row(
        'Labels',
        '<select id="dz-labels">' +
          opt('auto', 'Auto (hide when tiny)', d.labels) +
          opt('always', 'Always show', d.labels) +
          opt('off', 'Hidden', d.labels) +
          '</select>'
      ) +
      '<div class="menu-sep"></div>' +
      // Arrowheads
      checkRow('dz-arrows', 'Direction arrows', d.arrows) +
      // Database boxes
      checkRow('dz-boxes', 'Database boxes', d.showBoxes);
    menu.innerHTML = html;

    const num = (id) => menu.querySelector('#' + id);
    // Sliders update live as they are dragged.
    num('dz-edgew').addEventListener('input', (e) => {
      state.design.edgeWidth = parseFloat(e.target.value);
      num('dz-edgew-v').textContent = state.design.edgeWidth;
      applyDesign();
      saveDesign();
    });
    num('dz-size').addEventListener('input', (e) => {
      state.design.nodeSize = parseInt(e.target.value, 10);
      num('dz-size-v').textContent = state.design.nodeSize;
      applyDesign();
      saveDesign();
    });
    num('dz-curve').addEventListener('change', (e) => {
      state.design.curve = e.target.value;
      applyDesign();
      saveDesign();
    });
    num('dz-labels').addEventListener('change', (e) => {
      state.design.labels = e.target.value;
      applyDesign();
      saveDesign();
    });
    num('dz-arrows').addEventListener('change', (e) => {
      state.design.arrows = e.target.checked;
      applyDesign();
      saveDesign();
    });
    num('dz-boxes').addEventListener('change', (e) => {
      state.design.showBoxes = e.target.checked;
      applyDesign();
      saveDesign();
    });
    menu.querySelector('a[data-reset]').addEventListener('click', () => {
      state.design = Object.assign({}, DEFAULT_DESIGN);
      applyDesign();
      saveDesign();
      buildDesignMenu(); // rebuild so the controls reflect the defaults
    });

    function row(label, control) {
      return '<div class="menu-row"><span class="mr-label">' + label + '</span>' + control + '</div>';
    }
    function checkRow(id, label, on) {
      return (
        '<label class="menu-item"><input type="checkbox" id="' +
        id +
        '"' +
        (on ? ' checked' : '') +
        '/><span class="mi-label">' +
        label +
        '</span></label>'
      );
    }
    function opt(value, label, current) {
      return '<option value="' + value + '"' + (value === current ? ' selected' : '') + '>' + label + '</option>';
    }
  }

  function applyKindFilter() {
    const cy = state.cy;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (n.hasClass('dbbox')) return; // boxes follow their children automatically
        const kindOn = state.activeKinds.has(n.data('kind'));
        const missingOk = !n.hasClass('missing') || state.showMissing;
        n.style('display', kindOn && missingOk ? 'element' : 'none');
      });
    });
    updateStatusCounts();
  }

  function buildLegend() {
    el.legend.innerHTML = '';
    for (const kind of Object.keys(KIND_COLOR)) {
      const s = document.createElement('span');
      s.className = 'lg';
      s.innerHTML = kindChip(kind, false) + KIND_LABEL[kind];
      el.legend.appendChild(s);
    }
    const miss = document.createElement('span');
    miss.className = 'lg';
    miss.innerHTML = kindChip('unknown', true) + 'Missing';
    el.legend.appendChild(miss);
  }

  // ---------------- sidebar ----------------

  function renderDetails(d) {
    const color = d.defined ? KIND_COLOR[d.kind] || KIND_COLOR.unknown : MISSING_COLOR;
    let html = '<button class="close" title="Close">✕</button>';
    html +=
      '<span class="sb-kind" style="background:' +
      color +
      '">' +
      (d.kindLabel || d.kind) +
      (d.subtype ? ' · ' + escapeHtml(d.subtype) : '') +
      '</span>';
    html += '<div class="sb-name">' + escapeHtml(d.name) + '</div>';
    const meta = [];
    if (d.database) meta.push('🗄 ' + escapeHtml(d.database));
    if (d.folder) meta.push('📁 ' + escapeHtml(d.folder));
    if (d.defined) meta.push('line ' + d.line);
    html += '<div class="sb-meta">' + (meta.join(' &nbsp;·&nbsp; ') || '&nbsp;') + '</div>';

    if (!d.defined) {
      html +=
        '<div class="sb-missing"><b>Missing element.</b> Referenced by ' +
        d.usedBy.length +
        ' element' +
        (d.usedBy.length === 1 ? '' : 's') +
        ' but never defined (CREATE) in this VQL.</div>';
    }

    html += '<div class="sb-actions">';
    if (d.defined) {
      html += '<button data-act="reveal">Open in editor</button>';
      html += '<button data-act="copy" title="Copy this element\'s VQL">Copy VQL</button>';
      html +=
        '<button data-act="copyDeps" title="Copy this element and its whole upstream path (down to data sources, incl. required types)">Copy VQL + deps</button>';
      html +=
        '<button data-act="isolate" title="Show only this element and its upstream dependencies — the full path down to data sources">Isolate path</button>';
    }
    html += '<button data-act="expand">Expand neighbours</button>';
    html += '</div>';

    // Fields
    html += '<div class="sb-section"><h4>Fields (' + d.fields.length + ')</h4>';
    if (d.fields.length) {
      for (const f of d.fields) {
        html +=
          '<div class="field-row"><span class="fn">' +
          escapeHtml(f.name) +
          '</span><span class="ft">' +
          escapeHtml(f.type || '') +
          '</span></div>';
      }
    } else {
      html += '<div class="muted">No field information parsed for this element.</div>';
    }
    html += '</div>';

    // Depends on (references to previous / upstream)
    html += refSection('Depends on ▸ (upstream)', d.dependsOn);
    // Used by (downstream)
    html += refSection('◂ Used by (downstream)', d.usedBy);

    el.sidebar.innerHTML = html;
    el.sidebar.classList.remove('hidden');

    el.sidebar.querySelector('.close').addEventListener('click', () => clearSelection());
    el.sidebar.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'reveal') vscode.postMessage({ type: 'reveal', id: d.id });
        if (act === 'isolate') vscode.postMessage({ type: 'isolate', id: d.id });
        if (act === 'expand') vscode.postMessage({ type: 'expand', id: d.id });
        if (act === 'copy') vscode.postMessage({ type: 'copyVql', id: d.id, withDeps: false });
        if (act === 'copyDeps') vscode.postMessage({ type: 'copyVql', id: d.id, withDeps: true });
      });
    });
    el.sidebar.querySelectorAll('.ref-row').forEach((row) => {
      row.addEventListener('click', () => gotoNode(row.dataset.id));
    });
  }

  function refSection(title, refs) {
    let html = '<div class="sb-section"><h4>' + title + ' (' + refs.length + ')</h4>';
    if (!refs.length) {
      html += '<div class="muted">None.</div></div>';
      return html;
    }
    for (const r of refs) {
      const color = r.defined ? KIND_COLOR[r.kind] || KIND_COLOR.unknown : MISSING_COLOR;
      html +=
        '<div class="ref-row ' +
        (r.defined ? '' : 'missing') +
        '" data-id="' +
        escapeAttr(r.id) +
        '">' +
        '<span class="dot" style="background:' +
        (r.defined ? color : 'transparent') +
        (r.defined ? '' : ';border:2px dashed ' + MISSING_COLOR) +
        '"></span>' +
        '<span class="rname">' +
        escapeHtml(r.id) +
        '</span>' +
        '<span class="badge">' +
        (KIND_LABEL[r.kind] || r.kind) +
        '</span></div>';
    }
    html += '</div>';
    return html;
  }

  // Navigate to a node: center it if present, otherwise (focus mode) load it.
  function gotoNode(id) {
    if (centerOn(id)) {
      selectNode(id);
      vscode.postMessage({ type: 'selectNode', id: id });
    } else {
      vscode.postMessage({ type: 'focus', id: id, depth: state.depth });
      vscode.postMessage({ type: 'selectNode', id: id });
    }
  }

  // ---------------- search ----------------

  let searchTimer = null;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = el.search.value.trim();
    if (!q) {
      el.searchResults.classList.add('hidden');
      return;
    }
    searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', query: q }), 160);
  });
  el.search.addEventListener('blur', () => setTimeout(() => el.searchResults.classList.add('hidden'), 180));
  el.search.addEventListener('focus', () => {
    if (el.searchResults.children.length) el.searchResults.classList.remove('hidden');
  });

  function renderSearchResults(query, results) {
    if (!results.length) {
      el.searchResults.innerHTML = '<div class="result-empty">No elements match “' + escapeHtml(query) + '”.</div>';
      el.searchResults.classList.remove('hidden');
      return;
    }
    let html = '';
    for (const r of results) {
      const color = r.defined ? KIND_COLOR[r.kind] || KIND_COLOR.unknown : MISSING_COLOR;
      html +=
        '<div class="result-item" data-id="' +
        escapeAttr(r.id) +
        '"><span class="dot" style="background:' +
        (r.defined ? color : 'transparent') +
        (r.defined ? '' : ';border:2px dashed ' + MISSING_COLOR) +
        '"></span><span class="name">' +
        escapeHtml(r.label) +
        '</span><span class="badge">' +
        (KIND_LABEL[r.kind] || r.kind) +
        '</span></div>';
    }
    el.searchResults.innerHTML = html;
    el.searchResults.classList.remove('hidden');
    el.searchResults.querySelectorAll('.result-item').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        el.searchResults.classList.add('hidden');
        el.search.value = item.querySelector('.name').textContent;
        gotoNode(item.dataset.id);
      });
    });
  }

  // ---------------- status / banner ----------------

  function updateStatusCounts() {
    const n = state.cy.nodes(':visible').not('.dbbox').length;
    const e = state.cy.edges(':visible').length;
    const dbs = state.cy.nodes('.dbbox').length;
    setStatus('Showing ' + n + ' nodes · ' + e + ' edges' + (dbs ? ' · ' + dbs + ' database' + (dbs === 1 ? '' : 's') : ''));
  }
  function setStatus(text) {
    el.status.textContent = text;
  }

  function showBanner(html) {
    el.banner.innerHTML = html;
    el.banner.classList.remove('hidden');
  }
  function hideBanner() {
    el.banner.classList.add('hidden');
  }

  // Banner shown while a single view's lineage is isolated, with a link back to
  // the full graph (a reload re-parses and restores full/focus mode).
  function showIsolateBanner(centerId, count, truncated) {
    const deps = Math.max(0, count - 1);
    let html =
      '<b>Isolated path:</b> ' +
      escapeHtml(centerId) +
      ' + ' +
      deps +
      ' upstream dependenc' +
      (deps === 1 ? 'y' : 'ies') +
      (truncated ? ' <i>(truncated at limit)</i>' : '') +
      ' &nbsp;·&nbsp; <a id="showAllLink" style="cursor:pointer;text-decoration:underline">Show all</a>';
    showBanner(html);
    const link = document.getElementById('showAllLink');
    if (link) {
      link.addEventListener('click', () => {
        setStatus('Reloading…');
        vscode.postMessage({ type: 'reload' });
      });
    }
  }

  // ---------------- messages ----------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'status':
        setStatus(msg.text);
        break;
      case 'error': {
        const safe = String(msg.message || 'Could not load file.').replace(/[<>&]/g, (c) =>
          c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'
        );
        showBanner('<b>Error:</b> ' + safe);
        setStatus('Error');
        break;
      }
      case 'init':
        state.mode = msg.mode;
        state.depth = msg.neighbourhoodDepth || 2;
        buildTypesMenu();
        buildDesignMenu();
        buildLegend();
        if (msg.mode === 'focus') {
          const s = msg.stats;
          showBanner(
            '<b>Large graph:</b> ' +
              s.total.toLocaleString() +
              ' elements (' +
              s.missing.toLocaleString() +
              ' missing). Rendering everything at once would be slow, so this opened in <b>focus mode</b>.<br/>Search for an element above to explore its neighbourhood.'
          );
          el.hint.textContent = 'Focus mode · search an element, then double-click nodes to reveal in editor';
        } else {
          el.hint.textContent = 'Click a node for details · double-click to jump to its definition';
        }
        setStatus(
          'Parsed ' +
            msg.stats.total.toLocaleString() +
            ' elements · ' +
            msg.stats.missing.toLocaleString() +
            ' missing · ' +
            msg.stats.edges.toLocaleString() +
            ' edges · ' +
            msg.stats.parseMs +
            ' ms'
        );
        break;
      case 'graph':
        hideBanner();
        render(msg.nodes, msg.edges);
        break;
      case 'subgraph':
        if (msg.merge) {
          hideBanner();
          mergeSubgraph(msg.nodes, msg.edges);
        } else if (msg.isolated) {
          render(msg.nodes, msg.edges);
          showIsolateBanner(msg.center, msg.nodes.length, msg.truncated);
        } else {
          hideBanner();
          render(msg.nodes, msg.edges);
        }
        if (msg.center) {
          selectNode(msg.center);
          centerOn(msg.center);
        }
        break;
      case 'searchResults':
        renderSearchResults(msg.query, msg.results);
        break;
      case 'details':
        renderDetails(msg.detail);
        break;
    }
  });

  // ---------------- toolbar wiring ----------------

  el.layout.addEventListener('change', () => runLayout());
  el.fit.addEventListener('click', () => state.cy.fit(undefined, 40));
  el.settings.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  el.reload.addEventListener('click', () => {
    setStatus('Reloading…');
    vscode.postMessage({ type: 'reload' });
  });

  // Dropdown menus (Types, Design): clicking a button toggles its own menu and
  // closes the other; clicking inside a menu keeps it open; clicking anywhere
  // else closes both.
  function closeMenus(except) {
    for (const [btn, menu] of [
      [el.typesBtn, el.typesMenu],
      [el.designBtn, el.designMenu]
    ]) {
      if (menu === except) continue;
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
  }
  function wireDropdown(btn, menu) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('hidden');
      btn.setAttribute('aria-expanded', String(!open));
      if (!open) closeMenus(menu);
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
  }
  wireDropdown(el.typesBtn, el.typesMenu);
  wireDropdown(el.designBtn, el.designMenu);
  document.addEventListener('click', () => closeMenus());

  // ---------------- utils ----------------

  function getCssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return v && v.trim() ? v.trim() : fallback;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // ---------------- boot ----------------
  // Expose --fg for cytoscape label color.
  document.documentElement.style.setProperty('--fg', getCssVar('--vscode-foreground', '#ccc'));
  initCy();
  vscode.postMessage({ type: 'ready' });
})();
