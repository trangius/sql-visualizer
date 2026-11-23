'use strict';

// ─── Diagram geometry ────────────────────────────────────────────────────────

// Box anatomy (from the design): 40px header, rows of 30px starting 4px below it
const HEAD_H = 40, ROW_H = 30, ROWS_TOP = 44, PAD_X = 12, BADGE_W = 20, GAP = 8, MIN_W = 190;
// The dot grid, which tables snap to (state.snap) and Auto layout always places on: a row's height, so the rows
// of snapped tables line up and an arrow between rows at one height is straight
const GRID = ROW_H;
const onGrid = v => Math.round(v / GRID) * GRID;
// Where a table taken from (x, y) by (dx, dy) stands: on the nearest grid point while `snap`, else on the
// nearest pixel; where it was while it has not moved
const dragSpot = (x, y, dx, dy, snap) =>
  !dx && !dy ? { x, y } : snap ? { x: onGrid(x + dx), y: onGrid(y + dy) } : { x: Math.round(x + dx), y: Math.round(y + dy) };
const UI_FONT = "'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO_FONT = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const FONTS = {
  head: `600 13.5px ${UI_FONT}`,
  name: `400 13px ${UI_FONT}`,
  pk: `600 13px ${UI_FONT}`,
  key: `600 9.5px ${MONO_FONT}`,
  flags: `400 10.5px ${MONO_FONT}`,
  type: `400 11.5px ${MONO_FONT}`,
};
const measureCtx = document.createElement('canvas').getContext('2d');
const widthCache = new Map();
function textW(s, font) {
  const k = font + '\u0000' + s;
  if (!widthCache.has(k)) { measureCtx.font = font; widthCache.set(k, measureCtx.measureText(s).width); }
  return widthCache.get(k);
}

// How a type is shown in a box: vc spelled out as varchar(n)
function displayType(c) {
  const t = c.type ? normType(c.type) : c.effType;
  const m = t.match(/^vc(?:\((\d+)\))?(?=$|\s)(.*)$/);
  return m ? `varchar(${m[1] || DEFAULT_VC})${m[2]}` : t;
}

// In a key over several columns an FK keeps its FK badge: the key's dot shows it is part of the key. With the
// Indexes toggle on (state.indexes), a dim idx after the other flags: an index over the column alone (idx).
const IDX = 'idx';
function rowInfo(c, t) {
  const idx = state.indexes && c.indexed;
  return {
    key: c.isPk && !(t.pkCols.length > 1 && c.ref) ? 'PK' : c.ref || c.implicit ? 'FK' : '',
    name: c.name,
    bold: c.isPk,
    flags: [c.nullable && 'null', c.unique && 'unique', idx && IDX].filter(Boolean).join(' '),
    idx,
    type: displayType(c),
  };
}

// The rows a box shows: every column, or with "Keys only" just the primary keys, the
// foreign keys and the columns they point to
const shownCols = t => t.shown ?? t.cols;
function markShown(tables) {
  const targeted = new Set(tables.flatMap(t => t.cols.map(c => c.targetCol).filter(Boolean)));
  for (const t of tables) t.shown = state.keysOnly ? t.cols.filter(c => c.isPk || c.ref || c.target || targeted.has(c)) : t.cols;
  keyHues(tables);
}

// The colour of the key col is part of in t: its primary key, else a unique (…) over several columns
const partKeyHue = (t, col) => t.pkCols.includes(col) ? t.hue : t.multiUniques?.find(u => u.cols.includes(col))?.hue ?? null;

// Every key gets a colour of its own, and an FK the colour of the key it points to,
// also when that key is over several columns.
// Hues step by the golden angle, so any number of them stay far apart on the wheel,
// skipping yellow, which at a readable lightness is a muddy olive;
// lightness and chroma come from the theme (--key-l, --key-c) and are even in OKLCH.
// Handed out in table order: t.hue (its primary key), u.hue (its unique (…) keys),
// c.keyHue (the hue an FK's badge gets).
function keyHues(tables) {
  let i = 0;
  const next = () => {
    let h;
    do h = Math.round((40 + i++ * 137.508) % 360); while (h > 70 && h < 115);
    return h;
  };
  const colHue = new Map(); // a column an FK points to that isn't in a key of its table
  for (const t of tables) {
    t.hue = t.pkCols.length ? next() : null;
    for (const u of t.multiUniques ?? []) u.hue = next();
  }
  for (const t of tables) {
    for (const c of t.cols) {
      if (c.target) {
        // the arrows that are one key together (c.fkGroup) all get that key's
        const tc = c.targetCol, g = c.fkGroup, key = g ? keyGroups(g.target).find(k => k.cols === g.targetCols)?.hue : partKeyHue(c.target, tc);
        if (key == null && !colHue.has(tc)) colHue.set(tc, next());
        c.keyHue = key ?? colHue.get(tc);
      } else c.keyHue = c.isPk ? t.hue : null;
    }
  }
}

// Keys over several columns each get a colour: the pk the accent, every unique a hue of its own.
// A dot in that colour marks the key's rows, one dot column per key in the left margin.
const keyGroups = t => [
  ...(t.pkCols.length > 1 ? [{ label: 'pk', cols: t.pkCols, hue: t.hue }] : []),
  ...(t.multiUniques ?? []).map(u => ({ label: 'unique', cols: u.cols, hue: u.hue })),
];
// The symbols sit between the badge and the name, right-aligned against the name:
// a row in several keys gets several, side by side
const DOT_W = 9;
const dotX = j => PAD_X + BADGE_W + GAP - 4 + j * DOT_W; // j: 0 = nearest the badge
// how far the names move right: room for the most symbols one row (or footer line) has
const dotsLead = (t, groups) => groups.length && Math.max(1, ...shownCols(t).map(c => groups.filter(g => g.cols.includes(c)).length)) * DOT_W;
// Each key of a table also gets its own symbol, so they differ without colour too (10, then they repeat)
const KEY_SYMBOLS = [
  'M-3.2,0a3.2,3.2 0 1 0 6.4,0a3.2,3.2 0 1 0 -6.4,0',                // ●
  'M-2.8,-2.8h5.6v5.6h-5.6z',                                         // ■
  'M0,-3.6L3.4,2.6H-3.4z',                                            // ▲
  'M0,-3.8L3.8,0L0,3.8L-3.8,0z',                                      // ◆
  'M-3.4,0a3.4,3.4 0 1 0 6.8,0a3.4,3.4 0 1 0 -6.8,0M-1.8,0a1.8,1.8 0 1 1 3.6,0a1.8,1.8 0 1 1 -3.6,0', // ○
  'M-3,-3h6v6h-6zM-1.5,-1.5v3h3v-3z',                                 // □
  'M0,3.6L3.4,-2.6H-3.4z',                                            // ▼
  'M-1,-3.6h2v2.6h2.6v2h-2.6v2.6h-2v-2.6h-2.6v-2h2.6z',               // ✚
  'M0,-3.8L3.8,0L0,3.8L-3.8,0zM0,-1.9L-1.9,0L0,1.9L1.9,0z',          // ◇
  'M0,-3.8L1.1,-1.3L3.7,-1.2L1.7,0.5L2.3,3.1L0,1.7L-2.3,3.1L-1.7,0.5L-3.7,-1.2L-1.1,-1.3z', // ★
];
const keyDot = (g, k, j, y) =>
  `<path class="kdot" style="--h:${g.hue}" transform="translate(${dotX(j)},${y})" fill-rule="evenodd" d="${KEY_SYMBOLS[k % KEY_SYMBOLS.length]}"/>`;

// Keys, foreign keys and indexes over several columns are listed below the rows: "unique (Name, Credits)",
// "fk (OrderId, VariantId) -> ProductToOrder", "index (Day, Room)" (with the Indexes toggle on)
const FOOT_H = 22;
// { label, text, cols, group, hue, index }: group is the key's dot column, null for a foreign key or an index;
// hue the label's colour: a key's own, a foreign key's that of the key it points to (its FK badges'). A key's line and
// an index's start where the names do, an index's dim, with no dot and no colour.
const footLines = t => [
  ...keyGroups(t).map((g, k) => ({ label: g.label, text: `(${g.cols.map(c => c.name).join(', ')})`, cols: g.cols.map(c => c.name), group: k, hue: g.hue })),
  ...(t.fkGroups ?? []).map(g => ({ label: 'fk', text: `(${g.cols.map(c => c.name).join(', ')}) -> ${g.target.name}`, cols: g.cols.map(c => c.name),
    group: null, hue: g.cols[0].keyHue })),
  ...(state.indexes ? t.multiIndexes ?? [] : []).map(ix => ({ label: 'index', text: `(${ix.cols.map(c => c.name).join(', ')})`, cols: ix.cols.map(c => c.name),
    group: null, hue: null, index: true })),
];
const atNames = f => f.group != null || f.index;
const footLabelW = foot => Math.max(0, ...foot.map(f => textW(f.label + ' ', FONTS.flags)));
const footTop = n => ROWS_TOP + Math.max(1, n) * ROW_H + 6;

// Data view: the box is a real table, column names across and a few sample rows below
// (see sample.js). Instead of arrows, colours link the rows: each row of a referenced
// table has a colour, and a foreign key value gets the colour of the row it points to.
const COLHEAD_H = 26, DATA_H = 26, CELL_GAP = 18, CELL_MAX = 24;
const FONT_DHEAD = `600 11px ${UI_FONT}`;
const dataRowY = k => HEAD_H + 6 + COLHEAD_H + k * DATA_H + DATA_H / 2;
const cellText = v => v == null ? 'NULL' : v.length > CELL_MAX ? v.slice(0, CELL_MAX - 1) + '…' : v;

// Every referenced row in the diagram gets its own hue. Hues step by the golden angle,
// so neighbours (the rows of one table, and the next table's rows) are far apart on the wheel.
const hueCache = new WeakMap();
function rowHues(tables) {
  const data = sampleData(tables);
  if (hueCache.has(data)) return hueCache.get(data);
  const hues = new Map();
  const targeted = new Set(tables.flatMap(t => t.cols.map(c => c.target).filter(Boolean)));
  let i = 0;
  for (const t of tables) {
    if (targeted.has(t)) data.get(t).forEach((_, k) => hues.set(`${t.name}#${k}`, Math.round((20 + i++ * 137.508) % 360)));
  }
  hueCache.set(data, hues);
  return hues;
}

// cell: { text, key, hue }. key names the row a coloured cell belongs to ("Owner#2"),
// so hovering one lights up every cell with the same key.
function measureData(t) {
  const data = sampleData(model.tables), cols = shownCols(t), rows = data.get(t) ?? [];
  const targeted = new Set(model.tables.flatMap(o => o.cols.map(c => c.targetCol).filter(Boolean)));
  const hues = rowHues(model.tables);
  const cells = rows.map((r, k) => cols.map(c => {
    const v = r.values.get(c), cell = { text: cellText(v) };
    if (c.target && v != null) {
      const j = data.get(c.target).findIndex(pointedBy(c, r)); // with all of a group's values
      if (j >= 0) cell.key = `${c.target.name}#${j}`;
    } else if (targeted.has(c)) cell.key = `${t.name}#${k}`;
    if (cell.key) cell.hue = hues.get(cell.key) ?? 0;
    return cell;
  }));
  const cws = cols.map((c, i) => Math.max(textW(c.name, FONT_DHEAD), ...cells.map(row => textW(row[i].text, FONTS.type))));
  const xs = cws.map((_, i) => PAD_X + cws.slice(0, i).reduce((a, b) => a + b + CELL_GAP, 0));
  const w = Math.max(MIN_W, textW(t.name, FONTS.head) + 2 * PAD_X + 12, 2 * PAD_X + cws.reduce((a, b) => a + b, 0) + CELL_GAP * Math.max(0, cols.length - 1));
  return { w: Math.ceil(w / 10) * 10, h: dataRowY(Math.max(1, rows.length)) - DATA_H / 2 + 6, rows: [], data: { cols, cells, xs, cws } };
}

function measureTable(t) {
  if (state.dataView) return measureData(t);
  const rows = shownCols(t).map(c => rowInfo(c, t)), foot = footLines(t), lead = dotsLead(t, keyGroups(t)), labelW = footLabelW(foot);
  const w = Math.max(MIN_W, textW(t.name, FONTS.head) + 2 * PAD_X + 12, ...rows.map(r =>
    PAD_X + lead + BADGE_W + GAP + textW(r.name, r.bold ? FONTS.pk : FONTS.name) + 16 +
    (r.flags ? textW(r.flags, FONTS.flags) + 6 : 0) + textW(r.type, FONTS.type) + PAD_X),
    ...foot.map(f => (atNames(f) ? PAD_X + BADGE_W + GAP + lead : PAD_X) + labelW + textW(f.text, FONTS.type) + PAD_X));
  const h = footTop(rows.length) + (foot.length ? foot.length * FOOT_H + 6 : 0);
  return { w: Math.ceil(w / 10) * 10, h, rows };
}
const rowY = i => ROWS_TOP + i * ROW_H + ROW_H / 2;
// The height in a box an arrow from or to these rows runs at: a row's centre line, or halfway across a foreign
// key's rows; on the line between two rows where that is the centre of a row not among them, whose own line it is
function rowsMiddle(rows) {
  const lo = Math.min(...rows), hi = Math.max(...rows);
  return (rowY(lo) + rowY(hi)) / 2 - ((lo + hi) % 2 === 0 && !rows.includes((lo + hi) / 2) ? ROW_H / 2 : 0);
}
// The rows of a foreign key an arrow leaves and the rows it points to, in t's and the target's shown rows:
// a key over several columns (c.fkGroup) is one arrow, made at its lead column, from all of its rows
function arrowRows(t, c) {
  const { cols, targetCols } = fkCols(c), from = shownCols(t), to = shownCols(c.target);
  return { fromRows: cols.map(k => from.indexOf(k)), toRows: targetCols.map(k => to.indexOf(k)) };
}

// Positions for tables that don't have one yet (see layout.js for how a spot is chosen).
// The newest auto-placed table "floats": until it is dragged or another table is added,
// it moves to a better spot whenever its arrows change (e.g. while its FKs are being typed).
let revealName = null;

// Is a box (at least its middle) inside the visible canvas?
function onScreen(p, d) {
  const r = svg.getBoundingClientRect();
  if (!r.width) return true;
  const x = (p.x + d.w / 2) * view.s + view.tx, y = (p.y + d.h / 2) * view.s + view.ty;
  return x >= 0 && x <= r.width && y >= 0 && y <= r.height;
}

function ensurePositions(tables, dims) {
  const names = new Set(tables.map(t => t.name));
  let changed = false;
  // A table that just appeared may have an old spot from an earlier table with the same
  // name. If that spot is off screen, forget it, so the table is placed where you look.
  // (prevNames is null right after loading or switching tabs: then every spot is kept.)
  if (prevNames) {
    const before = new Set(prevNames);
    for (const t of tables) if (!before.has(t.name) && pos[t.name] && !onScreen(pos[t.name], dims.get(t))) delete pos[t.name];
  }
  if (tables.length && !tables.some(t => pos[t.name])) {
    arrangeAll(tables, dims);
    revealName = tables[0].name; // placed mid-view, but make sure it shows
    changed = true;
  } else {
    // a renamed table keeps the spot of the name it replaced
    tables.forEach((t, i) => {
      const old = prevNames?.[i];
      if (!pos[t.name] && old && !names.has(old) && pos[old]) { pos[t.name] = pos[old]; changed = true; }
    });
    const fresh = tables.filter(t => !pos[t.name]);
    if (fresh.length > AUTO.NEW_BATCH) {
      for (const q of Object.values(pos)) delete q.float; // none of a block floats
      arrangeBeside(fresh, tables.filter(t => pos[t.name]), dims);
      revealName = fresh[0].name;
      changed = true;
    }
    let edges = null;
    for (const t of tables) {
      const p = pos[t.name];
      if (p && !p.float) continue;
      const sig = linkSignature(t, tables);
      if (p?.sig === sig) continue;
      if (!p) for (const q of Object.values(pos)) delete q.float; // only the newest one floats
      const placed = new Map(tables.filter(o => o !== t && pos[o.name]).map(o => [o, { ...pos[o.name], ...dims.get(o) }]));
      const s = bestSpot(t, placed, dims, edges ??= layoutEdges(tables), viewCenter());
      pos[t.name] = { x: s.x, y: s.y, float: true, sig };
      revealName = t.name;
      changed = true;
    }
  }
  prevNames = [...names];
  if (changed) saveDoc();
}

// ─── Routing ────────────────────────────────────────────────────────────────
// Arrows leave the FK row horizontally and enter the Id row horizontally. The tables stand
// in columns with channels between them, so a route is read off the boxes without a search:
// level through the columns where its row is free, one jog in a channel (two when no row is
// free), and the vertical runs of a channel put in an order in which they don't cross.
// Arrows to one row are one row line: they share lanes and vertical runs (drawn thicker)
// and don't count as crossing each other.
// Only an arrow the columns can't serve (a table dragged out of line, or onto a channel) is
// searched for, with A* on a grid around its two tables.
const ROUTE = {
  STUB: 20, TRACK: 16,                 // from a box to the first vertical run; between two runs
  STREET: 80,                          // two rows of tables are at least this far apart
  CH_MIN: 20, CLEAR: 10, LANE_MIN: 8,  // the narrowest channel; a line's distance to a box, and to another row line in a column
  NEAR: 100,                           // how far outside its tables a group's lines go: other tables that near share its columns
  GAP_TRIES: 8, SIDE_DETOUR: 400, BUDGET: 2e6, ORDER_MAX: 48,
  // the search:
  GAP: 30, MARGIN: 10, GRID: 10, BEND: 40, CROSS: 250, SHARE_OTHER: 60, MERGE: 0.5,
  WINDOW: 200, STEPS: 5e4, CELLS: 1e5, WORK: 5e5, // one search's steps and grid; one call's work
};

// Routes every arrow (edge.points, and edge.d with the hops over other lines). An edge is
// { a, b, sy, ty, row, fromTable, from, to }: its two boxes, the heights it leaves and ends
// at, the height of the row it points to (ty moves off it where a notation spreads the
// ends), its table's name and the two rows' names. Arrows alike in everything else go by
// table name, then row. held: the boxes being dragged, if any (see searchRoutes). A foreign
// key over several columns (fromYs, toYs: see diagramEdges) also gets its trunk, and the
// lines that fold into it and split from it (edge.trunk, folds, splits; edge.d is the trunk).
// Returns { searched, waiting, kept }: how many arrows the columns could not serve, how many
// of those still wait for their search, and what to pass as `before` to the next call. One
// call searches for as many as its work allows and gives the rest a detour; called again
// with the same boxes and arrows it goes on with those, until none waits. The routes are
// then the ones a search without a limit would have found at once.
function routeEdges(edges, boxes, held = null, before = null) {
  if (!edges.length) return { searched: 0, waiting: 0, kept: null };
  const searched = routeGroups(edges, boxes).flatMap(g => routeGroup(g.arrows, g.boxes));
  const kept = searchRoutes(searched, edges, boxes, held, before);
  addJumps(edges);
  return { searched: searched.length, waiting: kept.waiting, kept };
}

// R1: tables joined by arrows are routed together, on columns of their own. So are groups
// that come within NEAR of each other, and single tables that near: their lines share
// channels, and must share the tracks in them. Returns [{ arrows, boxes }], boxes sorted by x.
function routeGroups(edges, boxes) {
  const root = new Map(boxes.map(b => [b, b]));
  const find = b => {
    while (root.get(b) !== b) { root.set(b, root.get(root.get(b))); b = root.get(b); }
    return b;
  };
  for (const e of edges) root.set(find(e.a), find(e.b));
  const sorted = [...boxes].sort((p, q) => p.x - q.x || p.y - q.y), widest = boxes.reduce((w, b) => Math.max(w, b.w), 0);
  const firstFrom = x => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].x >= x) hi = mid; else lo = mid + 1; } return lo; };
  let live;
  for (let joined = true; joined;) {
    joined = false;
    live = new Map(edges.map(e => [find(e.a), null])); // the groups with arrows, and how far they reach
    for (const b of boxes) {
      const r = find(b), reach = live.get(r);
      if (reach) { reach.x0 = Math.min(reach.x0, b.x); reach.y0 = Math.min(reach.y0, b.y); reach.x1 = Math.max(reach.x1, b.x + b.w); reach.y1 = Math.max(reach.y1, b.y + b.h); }
      else if (reach === null) live.set(r, { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
    }
    // only the boxes that begin in a group's stretch of x can be near it: they are found in the sorted list
    for (const [r, reach] of live) {
      for (let i = firstFrom(reach.x0 - ROUTE.NEAR - widest + 1); i < sorted.length && sorted[i].x < reach.x1 + ROUTE.NEAR; i++) {
        const b = sorted[i];
        if (b.x + b.w <= reach.x0 - ROUTE.NEAR || b.y >= reach.y1 + ROUTE.NEAR || b.y + b.h <= reach.y0 - ROUTE.NEAR || find(b) === find(r)) continue;
        root.set(find(b), find(r));
        joined = true;
      }
    }
  }
  const groups = new Map([...live.keys()].map(r => [r, { arrows: [], boxes: [] }]));
  for (const b of sorted) groups.get(find(b))?.boxes.push(b);
  for (const e of edges) groups.get(find(e.a)).arrows.push(e);
  return [...groups.values()];
}

// Is v strictly inside one of these spans ([lo, hi], sorted and apart)?
function insideSpans(spans, v) {
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid][1] <= v) lo = mid + 1;
    else if (spans[mid][0] >= v) hi = mid - 1;
    else return true;
  }
  return false;
}

// R2: boxes (sorted by x) in columns. The boxes of a column stand over each other: some x is
// inside them all, so the way out of one never runs into another. Two columns are at least a
// channel apart. A box that fits neither way (dragged half out of its column, or onto a
// channel) is left out as an obstacle: { cols: [{ xl, xr, boxes }], obstacles }.
function boxColumns(sorted) {
  const all = [], cols = [], obstacles = [];
  for (const b of sorted) {
    const col = all[all.length - 1];
    if (col && b.x < col.over) { col.boxes.push(b); col.over = Math.min(col.over, b.x + b.w); }
    else all.push({ over: b.x + b.w, boxes: [b] });
  }
  const right = col => col.boxes.reduce((x, b) => Math.max(x, b.x + b.w), -Infinity);
  for (let col of all) {
    // Too close to the column before: boxes go, each time the one that sticks out most (the
    // gap it opens; none for a column's last box), on a tie one of the smaller column, until
    // the two are apart or one of them is gone
    for (let last; col && (last = cols[cols.length - 1]) && col.boxes[0].x - right(last) < ROUTE.CH_MIN;) {
      const a = last.boxes.reduce((p, q) => q.x + q.w > p.x + p.w ? q : p), rest = { boxes: last.boxes.filter(b => b !== a) };
      const gainA = rest.boxes.length ? right(last) - right(rest) : 0, gainB = col.boxes.length > 1 ? col.boxes[1].x - col.boxes[0].x : 0;
      if (gainA > gainB || (gainA === gainB && last.boxes.length < col.boxes.length)) {
        obstacles.push(a);
        last.boxes = rest.boxes;
        if (!rest.boxes.length) cols.pop();
      } else {
        obstacles.push(col.boxes.shift());
        if (!col.boxes.length) col = null;
      }
    }
    if (col) cols.push(col);
  }
  for (const col of cols) { col.xl = col.boxes[0].x; col.xr = right(col); }
  return { cols, obstacles };
}

// One group's arrows on its columns. Returns the arrows the columns can't serve.
function routeGroup(arrows, members) {
  const { STUB, TRACK } = ROUTE, { cols, obstacles } = boxColumns(members), C = cols.length, colOf = new Map();
  if (!C) return arrows;
  // A column knows where it is blocked: by its boxes, and by an obstacle that reaches into it
  // or into a channel beside it. And which row lines pass it at which height (lanes).
  cols.forEach((col, c) => {
    const from = c ? cols[c - 1].xr : -Infinity, to = c + 1 < C ? cols[c + 1].xl : Infinity;
    col.boxes.forEach(b => colOf.set(b, c));
    col.blocked = [];
    col.lanes = new Map();
    for (const b of [...col.boxes, ...obstacles.filter(o => o.x < to && o.x + o.w > from)].sort((p, q) => p.y - q.y)) {
      const lo = b.y - ROUTE.CLEAR, hi = b.y + b.h + ROUTE.CLEAR, last = col.blocked[col.blocked.length - 1];
      if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
      else col.blocked.push([lo, hi]);
    }
  });
  // Channel j is the strip left of column j; 0 and C are the outsides. What an arrow does in
  // a channel is an entry: kind 0 from the left edge (at height l) to the right edge (at r),
  // kind 1 a loop on the left edge and kind 2 one on the right edge (l to r its span).
  const channels = Array.from({ length: C + 1 }, () => []), mates = channels.map(() => new Map()); // mates: a channel's entries by row line
  const middle = channels.map((_, j) => j === 0 ? cols[0].xl - STUB : j === C ? cols[C - 1].xr + STUB : (cols[j - 1].xr + cols[j].xl) >> 1);
  let budget = ROUTE.BUDGET, scans = ROUTE.BUDGET; // the work left for counting crossings, and for looking through streets
  // The stretches of height in which tables of the group stand, and between them its streets:
  // a STREET's height (less the CLEAR on either side) with no table in it. One table may be
  // in a street, or reach into it from the stretch over or under it, if tables stand side by
  // side there: a table dragged into a street is in the way of its own column only.
  // A stretch is a row if three of its tables stand level, and reaches across the group if it
  // has tables in all its columns but one. With two rows that do, or one and the beginning of
  // another (three columns or more in a run from either end, or one in from it), the tables
  // stand in rows, as Auto layout folds a long chain: such a group has many lines that pass
  // tables on their way, so they are given the free heights of the streets (R4) and the free
  // tracks of a channel (R6) where the order they would have has no room.
  // A stretch: its top and bottom; its columns: how many, the first, the last; its next
  // lowest end, and the top of the table that ends lowest; the last top, and how many at it
  const stood = [], column = new Int32Array(C).fill(-1), street = ROUTE.STREET - 2 * ROUTE.CLEAR;
  const spans = cols.flatMap((col, c) => col.blocked.map(([lo, hi]) => [lo, hi, c])).sort((p, q) => p[0] - q[0]);
  let across = 0, begun = 0;
  spans.forEach(([lo, hi, c], i) => {
    const under = i + 1 < spans.length ? spans[i + 1][0] : Infinity, under2 = i + 2 < spans.length ? spans[i + 2][0] : Infinity;
    let s = stood[stood.length - 1], top = lo;
    if (s && s[1] <= lo && under >= hi && under - s[1] >= street && s[1] - s[5] < street && under2 - under < street) return; // this table is in the street
    if (s && lo - s[1] < street) {
      if (lo - s[5] >= street && s[6] < s[5]) { s[1] = s[5]; s = null; }        // the table that ends lowest reaches into the street
      else if (under - s[1] >= street && hi > under) { top = under; s = null; } // this one reaches up into it
    } else s = null;
    if (!s) stood.push(s = [top, hi, 0, c, c, -Infinity, lo, lo, 0]);
    else if (hi > s[1]) { s[5] = s[1]; s[1] = hi; s[6] = lo; }
    else s[5] = Math.max(s[5], hi);
    if (column[c] !== stood.length) { column[c] = stood.length; s[2]++; s[3] = Math.min(s[3], c); s[4] = Math.max(s[4], c); }
    if (lo !== s[7]) { s[7] = lo; s[8] = 0; }
    if (++s[8] === 3) s[9] = true;
  });
  for (const [, , count, first, last, , , , , level] of stood) {
    if (level && count >= Math.max(3, C - 1)) across++;
    else if (level && count === last - first + 1 && (first <= 1 || last >= C - 2)) begun++;
  }
  const inRows = across > 1 || (across === 1 && begun > 0);

  // R3: a height is free in a column for a row line when no box is there and no other row line runs near it
  const free = (c, y, line) => {
    if (insideSpans(cols[c].blocked, y)) return false;
    for (let q = Math.round(y) - ROUTE.LANE_MIN + 1; q < Math.round(y) + ROUTE.LANE_MIN; q++) {
      const lane = cols[c].lanes.get(q);
      if (lane && lane.line !== line && lane.count) return false;
    }
    return true;
  };
  const cross = (p, q) => {
    if (!p.kind && !q.kind) return (p.l - q.l) * (p.r - q.r) < 0;
    if (p.kind && q.kind) return p.kind === q.kind && ((p.l < q.l && q.l < p.r && p.r < q.r) || (q.l < p.l && p.l < q.r && q.r < p.r));
    const [through, loop] = p.kind ? [q, p] : [p, q], y = loop.kind === 1 ? through.l : through.r;
    return y > loop.l && y < loop.r;
  };
  // How many entries of other row lines these would cross; nothing once the budget is spent.
  // A crossing that its own row line already makes there, with an entry it will run along,
  // is not another one: a bus crosses a line once, however many arrows are on it.
  const crossings = (entries, line) => {
    if (budget <= 0) return 0;
    let x = 0;
    for (const en of entries) {
      const same = mates[en.j].get(line) ?? [];
      budget -= channels[en.j].length;
      for (const s of channels[en.j]) {
        if (s.line === line || !cross(en, s)) continue;
        budget -= same.length;
        if (!same.some(m => m.kind === en.kind && Math.min(m.l, m.r) <= Math.max(en.l, en.r) && Math.min(en.l, en.r) <= Math.max(m.l, m.r) && cross(m, s))) x++;
      }
    }
    return x;
  };
  const put = (list, en, at) => { en[at] = list.length; list.push(en); };
  const pull = (list, en, at) => {
    const last = list.pop();
    if (last !== en) { list[en[at]] = last; last[at] = en[at]; }
  };

  // R4: one way to draw an arrow, out of side sa of its table and into side sb of the other
  // (0 left, 1 right). It passes k columns: the first F have its own row free, the last G
  // the row it points to.
  const plan = (e, line, sa, sb) => {
    const ja = colOf.get(e.a) + sa, jb = colOf.get(e.b) + sb, d = Math.sign(jb - ja), k = Math.abs(jb - ja);
    const colAt = i => d > 0 ? ja + i : ja - 1 - i;
    // what it does in the i-th channel it passes: in at height y, out at height to
    const entry = (i, y, to) => {
      const fromLeft = i ? d > 0 : sa === 1, toRight = i < k ? d > 0 : sb === 0;
      return fromLeft === toRight ? { j: ja + d * i, kind: 0, l: fromLeft ? y : to, r: fromLeft ? to : y }
        : { j: ja + d * i, kind: fromLeft ? 1 : 2, l: Math.min(y, to), r: Math.max(y, to) };
    };
    // turns: [after how many columns, the height from there on]. The last channel always ends
    // at the arrow's own end. x: how many lines it crosses, if that is known already.
    const build = (turns, x) => {
      const p = { sa, sb, jogs: [], entries: [], lanes: [] };
      let y = e.sy, t = 0;
      for (let i = 0; i <= k; i++) {
        const turn = t < turns.length && turns[t][0] === i ? turns[t++][1] : y, to = i === k ? e.ty : turn, en = entry(i, y, to);
        p.entries.push(en);
        if (to !== y) p.jogs.push({ en, y0: y, y1: to });
        if (i < k) p.lanes.push([colAt(i), to]);
        y = to;
      }
      const xa = sa ? e.a.x + e.a.w : e.a.x, xb = sb ? e.b.x + e.b.w : e.b.x;
      p.len = Math.abs(xa - middle[ja]) + Math.abs(middle[ja] - middle[jb]) + Math.abs(middle[jb] - xb) + p.jogs.reduce((s, jog) => s + Math.abs(jog.y0 - jog.y1), 0);
      p.x = x ?? crossings(p.entries, line);
      return p;
    };
    let F = 0, G = 0;
    while (F < k && free(colAt(F), e.sy, line)) F++;
    while (G < k && free(colAt(k - 1 - G), e.row, line)) G++;
    if (!k || (F === k && e.sy === e.row)) return build([]);
    if (F + G >= k) {
      // One jog, where it crosses least; the first on a tie, so it joins its row line early.
      // What it crosses with the jog after i columns: at its own height in the channels
      // before, in the jog, and at the height it points to in the channels after.
      const count = (i, y, to) => crossings([entry(i, y, to)], line), before = [0], after = [0];
      for (let i = 0; i < k - G; i++) before[0] += count(i, e.sy, e.sy);
      for (let i = k - G; i < F; i++) before.push(before[before.length - 1] + count(i, e.sy, e.sy));
      for (let i = k; i > k - G; i--) after.push(after[after.length - 1] + count(i, e.row, i === k ? e.ty : e.row));
      let best = k - G, least = Infinity;
      for (let i = k - G; i <= F; i++) {
        const x = before[i - (k - G)] + count(i, e.sy, i === k ? e.ty : e.row) + after[k - i];
        if (x < least) { best = i; least = x; }
      }
      return build([[best, e.row]], least);
    }
    // Two jogs, with a height between that is free in the columns neither row can pass: a gap
    // between the boxes of the first of them, near the two rows (among rows of tables a
    // street between two rows); else above or below them all.
    // In a gap it keeps another CLEAR from the boxes where there is room, not to run along an edge.
    const clear = y => { for (let i = F; i < k - G; i++) if (!free(colAt(i), y, line)) return false; return true; };
    const far = y => Math.abs(y - e.sy) + Math.abs(y - e.row), want = Math.floor((e.sy + e.row) / 2), spans = cols[colAt(F)].blocked, tries = [];
    const nearest = (a, b) => far(a) - far(b) || Math.abs(a - want) - Math.abs(b - want);
    // the room for a line between two of these stretches: from lo to hi, and the height in it nearest the middle
    const gap = (spans, i) => {
      const room = Math.min(ROUTE.CLEAR, Math.floor((spans[i + 1][0] - spans[i][1]) / 2)), lo = spans[i][1] + room, hi = spans[i + 1][0] - room;
      return hi - lo >= 0 && spans[i + 1][0] - spans[i][1] >= 1 ? [Math.max(lo, Math.min(hi, want)), lo, hi] : null;
    };
    let between;
    if (!inRows) {
      for (let i = 0; i + 1 < spans.length; i++) {
        const g = gap(spans, i);
        if (g) tries.push(g[0], Math.floor((g[1] + g[2]) / 2));
      }
      between = tries.sort(nearest).slice(0, ROUTE.GAP_TRIES).find(clear);
    } else {
      // Among rows of tables: a street, the nearest first, which is the nearer of the next one
      // up and the next one down. In it the heights LANE_MIN apart from its top (so two lines
      // of a street are level or apart), outward from the one nearest the middle, while the
      // work allows
      let begun = 0, above = null, below = null; // begun: the stretches that begin at the middle or over it
      while (begun < stood.length && stood[begun][0] <= want) begun++;
      scan: for (let up = begun - 2, down = Math.max(0, begun - 1); ;) {
        while (!above && up >= 0) above = gap(stood, up--);
        while (!below && down + 1 < stood.length) below = gap(stood, down++);
        if (!above && !below) break;
        const upper = above && (!below || nearest(above[0], below[0]) <= 0), [near, lo, hi] = upper ? above : below;
        if (upper) above = null; else below = null;
        const last = Math.floor((hi - lo) / ROUTE.LANE_MIN), first = Math.round((near - lo) / ROUTE.LANE_MIN);
        for (let i = 0; i <= 2 * last; i++) {
          const at = first + (i % 2 ? (i + 1) >> 1 : -(i >> 1));
          if (at < 0 || at > last) continue;
          if ((scans -= k - G - F) < 0) break scan;
          if (clear(lo + at * ROUTE.LANE_MIN)) { between = lo + at * ROUTE.LANE_MIN; break scan; }
        }
      }
    }
    if (between === undefined) {
      let top = Infinity, bottom = -Infinity;
      for (let i = F; i < k - G; i++) {
        const s = cols[colAt(i)].blocked;
        top = Math.min(top, s[0][0]);
        bottom = Math.max(bottom, s[s.length - 1][1]);
      }
      for (let step = 1; between === undefined; step++) {
        const above = top - ROUTE.CLEAR - step * TRACK, below = bottom + ROUTE.CLEAR + step * TRACK;
        between = (far(above) <= far(below) ? [above, below] : [below, above]).find(clear);
      }
    }
    return build([[F, between], [k - G, e.row]]);
  };

  // R5: the arrows shortest first (self-references last), each drawn the way that crosses least.
  // Not those of an obstacle: they are searched for.
  const inLine = e => colOf.has(e.a) && colOf.has(e.b);
  const span = e => e.a === e.b ? Infinity : Math.abs(e.a.x - e.b.x) + Math.abs(e.sy - e.row);
  const order = arrows.filter(inLine).sort((p, q) => span(p) - span(q) || p.a.x - q.a.x || p.sy - q.sy || p.b.x - q.b.x || p.row - q.row || byBytes(p.fromTable, q.fromTable));
  const lineOf = new Map(), plans = [], sides = new Map(members.map(b => [b, [0, 0]])); // sides: how many lines a box has to tables on its left, on its right
  for (const e of order) if (!lineOf.has(e.to)) lineOf.set(e.to, lineOf.size);
  for (const e of arrows) {
    if (inLine(e) && colOf.get(e.a) === colOf.get(e.b)) continue;
    const right = 2 * e.b.x + e.b.w > 2 * e.a.x + e.a.w ? 1 : 0;
    sides.get(e.a)[right]++;
    sides.get(e.b)[1 - right]++;
  }
  const choose = i => {
    const e = order[i], line = lineOf.get(e.to), ca = colOf.get(e.a), cb = colOf.get(e.b);
    let best;
    if (ca === cb) {
      // A loop on one side of the column (a self-reference too): the side that crosses less,
      // then the one fewer of the two boxes' other lines come from, then the one they are nearer
      const l = plan(e, line, 0, 0), r = plan(e, line, 1, 1), col = cols[ca], busy = side => sides.get(e.a)[side] + (e.a === e.b ? 0 : sides.get(e.b)[side]);
      best = (l.x - r.x || busy(0) - busy(1) || (e.a.x + e.b.x - 2 * col.xl) - (2 * col.xr - e.a.x - e.a.w - e.b.x - e.b.w)) <= 0 ? l : r;
    } else {
      // Out of the side that faces the other table and into the side that faces this one.
      // Round the other table, into its far side, or out of this table's far side, only if
      // that crosses less: out of the far side for one crossing, but for two where the tables
      // stand in rows (there it would leave the street), and for two when it does both (a
      // line that starts and ends the other way is hard to follow); and none of them if it
      // is much longer.
      const toward = cb > ca ? 1 : 0, facing = plan(e, line, toward, 1 - toward);
      best = facing;
      if (budget > 0) for (const [sa, sb, saves] of [[toward, toward, 1], [1 - toward, 1 - toward, inRows ? 2 : 1], [1 - toward, toward, 2]]) {
        if (facing.x < saves) break;
        const round = plan(e, line, sa, sb);
        if (round.x < best.x && round.x <= facing.x - saves && round.len <= facing.len + ROUTE.SIDE_DETOUR) best = round;
      }
    }
    plans[i] = best;
    for (const en of best.entries) {
      en.line = line;
      if (!mates[en.j].has(line)) mates[en.j].set(line, []);
      put(channels[en.j], en, 'at');
      put(mates[en.j].get(line), en, 'mate');
    }
    for (const [c, y] of best.lanes) {
      const lane = cols[c].lanes.get(Math.round(y));
      if (lane?.line === line) lane.count++;
      else cols[c].lanes.set(Math.round(y), { line, count: 1 });
    }
  };
  for (let i = 0; i < order.length; i++) choose(i);
  // once more: each arrow is lifted and chosen again, now that all the others are known
  for (let i = 0; i < order.length && budget > 0; i++) {
    for (const en of plans[i].entries) {
      pull(channels[en.j], en, 'at');
      pull(mates[en.j].get(en.line), en, 'mate');
    }
    for (const [c, y] of plans[i].lanes) {
      const lane = cols[c].lanes.get(Math.round(y));
      if (lane.line === lineOf.get(order[i].to)) lane.count--;
    }
    choose(i);
  }

  // R6: every vertical run (trunk) of a channel gets an x. Overlapping trunks of one row line
  // run as one. Loops on the left edge stand nearest it (short ones first), then lines going
  // up by the height of their left end, lines going down the other way, loops on the right edge.
  channels.forEach((entries, j) => {
    const trunks = [], taken = new Set(); // taken: the heights lines end at on the channel's two edges
    for (const en of entries) { taken.add(en.l); taken.add(en.r); }
    for (const en of entries.filter(en => en.kind || en.l !== en.r).sort((p, q) => p.line - q.line || p.kind - q.kind || Math.min(p.l, p.r) - Math.min(q.l, q.r))) {
      const lo = Math.min(en.l, en.r), hi = Math.max(en.l, en.r), t = trunks[trunks.length - 1];
      if (t && t.line === en.line && t.kind === en.kind && lo <= t.hi) { t.hi = Math.max(t.hi, hi); t.members.push(en); t.left += en.l; }
      else trunks.push({ line: en.line, kind: en.kind, lo, hi, members: [en], left: en.l, right: 0, before: [], after: [], rank: 0 });
    }
    if (!trunks.length) return;
    for (const t of trunks) {
      for (const en of t.members) t.right += en.r;
      t.band = t.kind === 1 ? 0 : t.kind === 2 ? 3 : t.right < t.left ? 1 : 2;
    }
    // by the mean height of the left ends, compared as fractions
    const leftEnd = (p, q) => p.left * q.members.length - q.left * p.members.length;
    trunks.sort((p, q) => p.band - q.band
      || (p.band === 0 ? (p.hi - p.lo) - (q.hi - q.lo) : p.band === 1 ? leftEnd(p, q) : p.band === 2 ? leftEnd(q, p) : (q.hi - q.lo) - (p.hi - p.lo))
      || p.lo - q.lo || p.hi - q.hi || p.line - q.line);
    // Two rows level with each other on the two edges: a trunk that ends on the left edge
    // there must stand left of every other row line's trunk that ends on the right edge
    // there, or their stubs would lie on each other.
    const ends = new Map(); // height → the trunks that end there on the left edge, and on the right edge
    const level = new Set(entries.filter(en => !en.kind && en.l === en.r).map(en => en.line + ' ' + en.l)); // where a row line passes straight through
    for (const t of trunks) {
      t.ends = [[], []]; // the heights its stubs leave at on either edge; not where its row line passes anyway
      const end = (y, edge) => {
        if (!ends.has(y)) ends.set(y, [[], []]);
        if (!ends.get(y)[edge].includes(t)) ends.get(y)[edge].push(t);
        if (!level.has(t.line + ' ' + y) && !t.ends[edge].includes(y)) t.ends[edge].push(y);
      };
      for (const en of t.members) {
        if (en.kind !== 2) end(en.l, 0);
        if (en.kind === 1) end(en.r, 0);
        if (en.kind !== 1) end(en.r, 1);
        if (en.kind === 2) end(en.l, 1);
      }
    }
    for (const [left, right] of ends.values()) for (const t of left) for (const o of right) {
      if (o.line !== t.line && !t.before.includes(o)) { t.before.push(o); o.after.push(t); }
    }
    // Then the order in which the fewest stubs cross a trunk: with t left of o, o's stubs to
    // the left edge cross t, and t's to the right edge cross o. From the order above, a trunk
    // moves to the place that saves most, as long as one does (few trunks only: it is cubic).
    if (trunks.length <= ROUTE.ORDER_MAX) {
      const inside = (ys, t) => ys.reduce((n, y) => n + (y > t.lo && y < t.hi), 0);
      const cost = trunks.map(t => trunks.map(o => o === t || o.line === t.line ? 0 : inside(o.ends[0], t) + inside(t.ends[1], o))); // cost[t][o]: crossings with t left of o
      trunks.forEach((t, i) => t.id = i);
      for (let moved = true, rounds = 0; moved && rounds < trunks.length; rounds++) {
        moved = false;
        for (let i = 0; i < trunks.length; i++) {
          const t = trunks[i];
          let best = 0, to = i, gain = 0;
          for (let p = i - 1; p >= 0 && !t.after.includes(trunks[p]); p--) {
            gain += cost[trunks[p].id][t.id] - cost[t.id][trunks[p].id];
            if (gain > best) { best = gain; to = p; }
          }
          gain = 0;
          for (let p = i + 1; p < trunks.length && !t.before.includes(trunks[p]); p++) {
            gain += cost[t.id][trunks[p].id] - cost[trunks[p].id][t.id];
            if (gain > best) { best = gain; to = p; }
          }
          if (to === i) continue;
          trunks.splice(i, 1);
          trunks.splice(to, 0, t);
          moved = true;
        }
      }
    }
    trunks.forEach((t, at) => t.at = at);
    const ready = new MinHeap(), ordered = [];
    for (const t of trunks) if (!t.after.length) ready.push(t.at, t);
    while (ordered.length < trunks.length) {
      if (!ready.size) {
        // Trunks that each must stand left of the next, round in a circle (an X of four level
        // rows): one of them is cut in two. Its left ends keep the trunk, its right ends get
        // one further right, and a stretch at a free height between joins the two: a second jog.
        let t = trunks.find(t => !t.rank);
        for (const seen = new Set(); !seen.has(t); t = t.after.find(o => !o.rank)) seen.add(t);
        const heights = [...taken].filter(y => y >= t.lo && y <= t.hi).sort((a, b) => a - b);
        let gap = 0;
        for (let i = 1; i < heights.length; i++) if (heights[i] - heights[i - 1] > heights[gap + 1] - heights[gap]) gap = i - 1;
        const mid = Math.floor((heights[gap] + heights[gap + 1]) / 2), far = { ...t, at: trunks.length, second: true, before: [], after: [...t.after, t], rank: 0 };
        for (const o of t.after) o.before.splice(o.before.indexOf(t), 1, ...(mid > heights[gap] ? [far] : []));
        t.after = [];
        ready.push(t.at, t);
        if (mid > heights[gap]) { // (no height free between: it stays one trunk, out of order)
          taken.add(mid);
          for (const en of t.members) en.mid = mid;
          t.lo = Math.min(mid, ...t.members.map(en => en.l));
          t.hi = Math.max(mid, ...t.members.map(en => en.l));
          far.lo = Math.min(mid, ...t.members.map(en => en.r));
          far.hi = Math.max(mid, ...t.members.map(en => en.r));
          t.before.push(far);
          trunks.push(far);
        }
      }
      const t = ready.pop();
      t.rank = -1;
      ordered.push(t);
      for (const o of t.before) if (o.after.every(p => p.rank)) ready.push(o.at, o);
    }
    // a trunk stands one track past the trunks before it that it overlaps (or nearly)
    const heights = [...new Set(trunks.flatMap(t => [t.lo, t.hi]))].sort((a, b) => a - b), ranked = new RangeMax(heights.length);
    const firstOver = v => { let lo = 0, hi = heights.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (heights[mid] > v) hi = mid; else lo = mid + 1; } return lo; };
    const firstFrom = v => { let lo = 0, hi = heights.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (heights[mid] >= v) hi = mid; else lo = mid + 1; } return lo; };
    const xl = j ? cols[j - 1].xr : cols[0].xl - ROUTE.NEAR, xr = j < C ? cols[j].xl : cols[C - 1].xr + ROUTE.NEAR;
    const tracks = Math.floor((xr - xl - 2 * STUB) / TRACK) + 1; // as many fit the channel a track apart
    let ranks = 0;
    for (const t of ordered) {
      t.rank = 1 + ranked.max(firstOver(t.lo - TRACK), firstFrom(t.hi + TRACK) - 1);
      ranked.raise(firstFrom(t.lo), firstFrom(t.hi), t.rank);
      ranks = Math.max(ranks, t.rank);
    }
    // Among rows of tables (see `stood`), a channel with too few tracks for that packs its
    // trunks instead: from the top down, each on the first track free where it runs, right
    // of the trunks it must stand right of
    if (ranks > tracks && inRows) {
      const waits = trunks.map(t => t.after.length);
      ranks = 0;
      for (const t of trunks) { t.rank = 0; if (!t.after.length) ready.push(t.lo * trunks.length + t.at, t); }
      while (ready.size) {
        const t = ready.pop(), taken = new Set();
        for (const o of trunks) if (o.rank && o.hi > t.lo - TRACK && o.lo < t.hi + TRACK) taken.add(o.rank);
        for (t.rank = 1 + t.after.reduce((r, o) => Math.max(r, o.rank), 0); taken.has(t.rank); t.rank++);
        ranks = Math.max(ranks, t.rank);
        for (const o of t.before) if (!--waits[o.at]) ready.push(o.lo * trunks.length + o.at, o);
      }
    }
    // centred in the channel, squeezed if it is narrow; in the two outside channels they hug the column
    const step = ranks > 1 ? Math.min(TRACK, Math.max(2, Math.floor((xr - xl - 2 * STUB) / (ranks - 1)))) : 0;
    const first = j === 0 ? xr - STUB - (ranks - 1) * step : j === C ? xl + STUB : (xl + xr - (ranks - 1) * step) >> 1;
    for (const t of trunks) for (const en of t.members) en[t.second ? 'x2' : 'x'] = first + (t.rank - 1) * step;
  });

  // R7: the points. An arrow that touches a box after all (an obstacle, or a channel too
  // narrow for its trunks) is searched for too.
  const touches = pts => pts.some((q, i) => {
    if (!i) return false;
    const seg = [...pts[i - 1], ...q], lo = Math.min(seg[0], seg[2]), hi = Math.max(seg[0], seg[2]);
    if (obstacles.some(b => segHitsRect(seg, b))) return true;
    for (const col of cols) {
      if (col.xr <= lo) continue;
      if (col.xl >= hi) break;
      if (seg[1] === seg[3] && !insideSpans(col.blocked, seg[1])) continue;
      if (col.boxes.some(b => segHitsRect(seg, b))) return true;
    }
    return false;
  });
  order.forEach((e, i) => {
    const p = plans[i], pts = [[p.sa ? e.a.x + e.a.w : e.a.x, e.sy]];
    for (const { en, y0, y1 } of p.jogs) {
      if (en.x2 === undefined) pts.push([en.x, y0], [en.x, y1]);
      else if (y0 === en.l) pts.push([en.x, y0], [en.x, en.mid], [en.x2, en.mid], [en.x2, y1]);
      else pts.push([en.x2, y0], [en.x2, en.mid], [en.x, en.mid], [en.x, y1]);
    }
    e.points = [...pts, [p.sb ? e.b.x + e.b.w : e.b.x, e.ty]];
  });
  return arrows.filter(e => !inLine(e) || touches(e.points));
}

// side: force a same-side loop ('L' or 'R'); used to try both sides of a self-reference
function chooseSides(e, side = null) {
  const a = e.a, b = e.b;
  let out, inn; // side of a the arrow leaves from, side of b it enters
  if (side) { out = inn = side; }
  else if (a !== b && b.x >= a.x + a.w + ROUTE.GAP) { out = 'R'; inn = 'L'; }
  else if (a !== b && b.x + b.w <= a.x - ROUTE.GAP) { out = 'L'; inn = 'R'; }
  else {
    // boxes overlap horizontally: leave and enter on the same side
    const lx = Math.min(a.x, b.x), rx = Math.max(a.x + a.w, b.x + b.w);
    out = inn = a === b || (a.x - lx) + (b.x - lx) <= (rx - a.x - a.w) + (rx - b.x - b.w) ? 'L' : 'R';
  }
  e.x1 = out === 'R' ? a.x + a.w : a.x;
  e.x2 = inn === 'R' ? b.x + b.w : b.x;
  e.outDir = out === 'R' ? 0 : 1;     // 0 E, 1 W, 2 S, 3 N
  e.inDir = inn === 'L' ? 0 : 1;      // direction of travel when entering b
  e.sx = e.x1 + (out === 'R' ? ROUTE.STUB : -ROUTE.STUB);
  e.tx = e.x2 + (inn === 'L' ? -ROUTE.STUB : ROUTE.STUB);
}

// The search arrays, kept between calls (routing runs on every keystroke and drag frame).
// A cell's cost counts only if it was set in the current search (seen === stamp), so the
// arrays don't have to be cleared before each search.
const routeBuf = { g: new Float64Array(0), prev: new Int32Array(0), seen: new Uint32Array(0), stamp: 0 };

// The arrows the columns can't serve: A* on a grid of the box edges and rows in a window
// around the arrow's two tables. A bend costs, crossing a line already drawn costs more, and
// running along a line to another row is very expensive (it would look like it points
// there); along one to the same row is cheap (they merge, drawn thicker).
// The arrows go shortest first. When the work allowed for one call is done (WORK, counted,
// not timed, so the same boxes always get the same routes), the rest get a plain detour and
// wait: the next call, given what this one returns (the routes by FK row, and for which
// boxes and arrows they are), keeps the routes found and goes on with those that wait, in
// the same order and with the same lines around them as a search without a limit. An arrow
// with no way at all keeps its detour. A search's work is what is in its window (boxes,
// stretches of drawn lines, grid cells) and its steps: as many arrows are searched for in a
// big diagram as in a small one.
// While tables are dragged (held) their arrows go first, and the others keep the routes they
// had as long as their own two tables stand where they stood; when the drag ends, all start over.
function searchRoutes(arrows, edges, boxes, held, before) {
  const kept = { input: '', held: !!held, routes: new Map(), waiting: 0 };
  if (!arrows.length) return kept;
  const place = new Map(boxes.map((b, i) => [b, i])), pending = new Set(arrows), lineOf = new Map(), byX = [...boxes].sort((p, q) => p.x - q.x);
  kept.input = boxes.map(b => [b.x, b.y, b.w, b.h]).join(';') + '|' + edges.map(e => [e.from, e.to, place.get(e.a), place.get(e.b), e.sy, e.ty, e.row]).join(';');
  const going = !held && before && !before.held && before.input === kept.input; // the same boxes and arrows as last time: go on
  // What a search looks through, kept in order so that it finds what is in its window without
  // looking at everything: the boxes by x, the lines already drawn as level stretches by y
  // and upright ones by x, and those this call adds as they come
  const there = { byX, widest: boxes.reduce((w, b) => Math.max(w, b.w), 0), level: [], upright: [], added: [] };
  const draw = (e, lists) => e.points.forEach((q, i) => {
    if (!i) return;
    const [ax, ay] = e.points[i - 1], [bx, by] = q, line = lineOf.get(e.to);
    (lists[ay === by ? 0 : 1]).push(ay === by ? { at: ay, a: Math.min(ax, bx), b: Math.max(ax, bx), line, level: true } : { at: ax, a: Math.min(ay, by), b: Math.max(ay, by), line, level: false });
  });
  let work = ROUTE.WORK;
  for (const e of edges) if (!lineOf.has(e.to)) lineOf.set(e.to, lineOf.size + 1);
  const where = e => [e.a.x, e.a.y, e.a.w, e.a.h, e.b.x, e.b.y, e.b.w, e.b.h, e.sy, e.ty].join();
  const isHeld = e => held?.has(e.a) || held?.has(e.b) ? 1 : 0, todo = [];
  for (const e of arrows) {
    chooseSides(e);
    const was = before?.routes.get(e.from);
    if (!(going ? was?.done : held && !isHeld(e) && was?.where === where(e))) { todo.push(e); continue; }
    e.points = was.points;
    kept.routes.set(e.from, was);
    pending.delete(e);
  }
  for (const e of edges) if (!pending.has(e)) draw(e, [there.level, there.upright]);
  there.level.sort((p, q) => p.at - q.at);
  there.upright.sort((p, q) => p.at - q.at);
  const len = e => e.a === e.b ? Infinity : Math.abs(e.sx - e.tx) + Math.abs(e.sy - e.ty);
  for (const e of todo.sort((p, q) => isHeld(q) - isHeld(p) || len(p) - len(q) || byBytes(p.fromTable, q.fromTable) || p.sy - q.sy)) {
    // a self-reference can loop around either side: both are tried, the cheaper one wins
    const sides = e.a !== e.b ? [e] : ['L', 'R'].map(side => {
      const v = { ...e };
      chooseSides(v, side);
      return v;
    });
    let best = null;
    const grid = work > 0 && searchGrid(e, sides, there, pending, lineOf.get(e.to));
    pending.delete(e);
    work -= grid ? grid.work : 0;
    if (grid?.blocked) for (const v of sides) {
      const r = astar(grid, v);
      work -= r.steps;
      if (r.nodes && !(best && best.cost <= r.cost)) best = { ...r, v };
    }
    if (best) {
      for (const k of ['x1', 'x2', 'outDir', 'inDir', 'sx', 'tx']) e[k] = best.v[k];
      e.points = [[e.x1, e.sy], ...best.nodes.map(n => [grid.xs[n % grid.nx], grid.ys[Math.floor(n / grid.nx)]]), [e.x2, e.ty]];
    } else e.points = detour(e, there);
    draw(e, [there.added, there.added]);
    kept.routes.set(e.from, { where: where(e), points: e.points, done: !!grid }); // done: searched for, whatever came of it
    if (!grid) kept.waiting++;
  }
  return kept;
}

// An arrow without the search: its elbow, stepping aside for every box in its way. A level
// stretch goes over or under the box, an upright one left or right of it, whichever is
// nearer, a stub's length away; the step may meet the next box, so it goes on until the way
// is clear. there: the boxes by x (see searchRoutes).
function detour(e, there) {
  const loop = e.outDir !== e.inDir, X = !loop ? Math.round((e.sx + e.tx) / 2) : e.outDir ? Math.min(e.sx, e.tx) : Math.max(e.sx, e.tx);
  const way = [[e.x1, e.sy], [X, e.sy], [X, e.ty], [e.x2, e.ty]], S = ROUTE.STUB, byX = there.byX, rounded = [new Set(), new Set()];
  for (let i = 1; i < way.length; i++) {
    const [ax, ay] = way[i - 1], [bx, by] = way[i], level = ay === by, hi = Math.max(ax, bx);
    // the first box on this stretch
    let box = null, near = Infinity, lo = 0;
    for (let end = byX.length; lo < end;) { const mid = (lo + end) >> 1; if (byX[mid].x >= Math.min(ax, bx) - there.widest) end = mid; else lo = mid + 1; }
    for (let k = lo; k < byX.length && byX[k].x < hi; k++) {
      const b = byX[k];
      if (!segHitsRect([ax, ay, bx, by], b)) continue;
      const far = level ? Math.abs((bx > ax ? b.x : b.x + b.w) - ax) : Math.abs((by > ay ? b.y : b.y + b.h) - ay);
      if (far < near) { box = b; near = far; }
    }
    // a box is rounded once each way: where that does not get past it, the line stays on it
    if (!box || rounded[level ? 0 : 1].has(box)) continue;
    rounded[level ? 0 : 1].add(box);
    // Round it: out to `side`, along the box, and back; if the stretch ends beside the box, its
    // end moves out instead. Not where it begins or ends at the box itself (a port walled in).
    const [p, q, o] = level ? [ax, bx, ay] : [ay, by, ax], [start, size, cross, girth] = level ? [box.x, box.w, box.y, box.h] : [box.y, box.h, box.x, box.w];
    const side = o - (cross - S) <= cross + girth + S - o ? cross - S : cross + girth + S;
    const from = q > p ? Math.max(p, start - S) : Math.min(p, start + size + S), to = q > p ? Math.min(q, start + size + S) : Math.max(q, start - S);
    const point = (along, across) => level ? [along, across] : [across, along], turns = way[i + 1]?.[level ? 0 : 1] === q; // the next stretch runs the other way
    if ((from === p && i === 1) || (p > start && p < start + size) || (to === q && !turns)) continue;
    if (to === q) way.splice(i, 1, point(from, o), point(from, side), point(q, side));
    else way.splice(i, 0, point(from, o), point(from, side), point(to, side), point(to, o));
    i--;
  }
  return way;
}

// The grid an arrow is searched for on: lines along the edges (and a margin out) of the boxes
// within WINDOW of its two tables and of the tables between them (there must be a way round
// those), its rows, the lines already drawn there, and one between each two of those. Box
// edges are included so no step can jump through a box.
// along[2n] tells what runs from node n to the next one on its right, along[2n + 1] to the one
// below it, at[n] what passes node n: 0 nothing, a row line's number, or -1 several of them.
// The stub ends of the arrows still to be searched for (pending) are theirs alone.
// there: the boxes and the drawn lines, in order (see searchRoutes). work: the boxes and the
// stretches of lines in the window, and its cells; it comes without cells if there would be too many.
function searchGrid(e, sides, there, pending, line) {
  const { MARGIN, GRID, WINDOW } = ROUTE, span = bboxOf([e.a, e.b]);
  const first = (list, at, v) => { let lo = 0, hi = list.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (at(list[mid]) >= v) hi = mid; else lo = mid + 1; } return lo; };
  // the boxes that reach into a stretch of x begin in it or less than the widest box before it
  const boxesIn = (xa, ya, xb, yb) => {
    const found = [];
    for (let i = first(there.byX, b => b.x, xa - there.widest); i < there.byX.length && there.byX[i].x < xb; i++) {
      const b = there.byX[i];
      if (b.x + b.w > xa && b.y < yb && b.y + b.h > ya) found.push(b);
    }
    return found;
  };
  const reach = bboxOf(boxesIn(span.x, span.y, span.x + span.w, span.y + span.h));
  const x0 = reach.x - WINDOW, y0 = reach.y - WINDOW, x1 = reach.x + reach.w + WINDOW, y1 = reach.y + reach.h + WINDOW;
  const near = boxesIn(x0, y0, x1, y1), drawn = [], cut = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const take = s => {
    const [u0, u1, v0, v1] = s.level ? [y0, y1, x0, x1] : [x0, x1, y0, y1];
    if (s.at < u0 || s.at > u1 || s.b < v0 || s.a > v1) return;
    const a = cut(s.a, v0, v1), b = cut(s.b, v0, v1);
    drawn.push(s.level ? { ax: a, ay: s.at, bx: b, by: s.at, line: s.line } : { ax: s.at, ay: a, bx: s.at, by: b, line: s.line });
  };
  for (let i = first(there.level, s => s.at, y0); i < there.level.length && there.level[i].at <= y1; i++) take(there.level[i]);
  for (let i = first(there.upright, s => s.at, x0); i < there.upright.length && there.upright[i].at <= x1; i++) take(there.upright[i]);
  there.added.forEach(take);
  const work = near.length + drawn.length;
  const mine = (x, y) => sides.some(v => (x === v.sx && y === v.sy) || (x === v.tx && y === v.ty)), stubs = [];
  for (const o of pending) {
    for (const [x, y] of [[o.sx, o.sy], [o.tx, o.ty]]) if (!mine(x, y) && x > x0 && x < x1 && y > y0 && y < y1) stubs.push([x, y]);
  }
  const coords = (values, lo, hi) => {
    const sorted = [...new Set([lo, hi, ...values.filter(v => v > lo && v < hi)])].sort((a, b) => a - b), out = [...sorted];
    for (let i = 1; i < sorted.length; i++) {
      const mid = Math.round((sorted[i - 1] + sorted[i]) / (2 * GRID)) * GRID;
      if (mid > sorted[i - 1] && mid < sorted[i]) out.push(mid);
    }
    return out.sort((a, b) => a - b);
  };
  const xs = coords([...near.flatMap(b => [b.x - MARGIN, b.x, b.x + b.w, b.x + b.w + MARGIN]), ...sides.flatMap(v => [v.sx, v.tx]), ...drawn.flatMap(l => [l.ax, l.bx]), ...stubs.map(p => p[0])], x0, x1);
  const ys = coords([...near.flatMap(b => [b.y - MARGIN, b.y, b.y + b.h, b.y + b.h + MARGIN]), e.sy, e.ty, ...drawn.flatMap(l => [l.ay, l.by]), ...stubs.map(p => p[1])], y0, y1);
  const nx = xs.length, ny = ys.length;
  if (nx * ny > ROUTE.CELLS) return { work };
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  const grid = { xs, ys, nx, ny, xi, yi, work: work + nx * ny, line, blocked: new Uint8Array(nx * ny), along: new Int32Array(2 * nx * ny), at: new Int32Array(nx * ny) };
  for (const b of near) {
    for (let i = 0; i < nx; i++) {
      if (xs[i] <= b.x - MARGIN || xs[i] >= b.x + b.w + MARGIN) continue;
      for (let j = 0; j < ny; j++) if (ys[j] > b.y - MARGIN && ys[j] < b.y + b.h + MARGIN) grid.blocked[j * nx + i] = 1;
    }
  }
  for (const [x, y] of stubs) grid.blocked[yi.get(y) * nx + xi.get(x)] = 1;
  const mark = (list, i, line) => list[i] = list[i] === 0 || list[i] === line ? line : -1;
  for (const l of drawn) {
    const level = l.ay === l.by, i1 = xi.get(Math.max(l.ax, l.bx)), j1 = yi.get(Math.max(l.ay, l.by));
    for (let i = xi.get(Math.min(l.ax, l.bx)), j = yi.get(Math.min(l.ay, l.by)); i <= i1 && j <= j1; level ? i++ : j++) {
      mark(grid.at, j * nx + i, l.line);
      if (level ? i < i1 : j < j1) mark(grid.along, 2 * (j * nx + i) + (level ? 0 : 1), l.line);
    }
  }
  return grid;
}

// From the end of arrow e's first stub to the start of its last, in at most STEPS steps:
// { nodes, cost, steps }, without nodes if there is no way
function astar(grid, e) {
  const { xs, ys, nx, ny, blocked, along, at, line } = grid, { BEND, CROSS, SHARE_OTHER, MERGE } = ROUTE;
  const s = grid.yi.get(e.sy) * nx + grid.xi.get(e.sx), t = grid.yi.get(e.ty) * nx + grid.xi.get(e.tx);
  if (blocked[s] || blocked[t]) return { steps: 0 };
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1], REV = [1, 0, 3, 2];
  const size = nx * ny * 4;
  if (routeBuf.g.length < size) Object.assign(routeBuf, { g: new Float64Array(size), prev: new Int32Array(size), seen: new Uint32Array(size), stamp: 0 });
  const { g, prev, seen } = routeBuf;
  if (++routeBuf.stamp === 0xffffffff) { seen.fill(0); routeBuf.stamp = 1; }
  const stamp = routeBuf.stamp;
  const tx = xs[t % nx], ty = ys[Math.floor(t / nx)];
  // Merged lanes cost less per pixel, so scale the heuristic to remain admissible.
  const h = (x, y) => (1 - MERGE) * (Math.abs(x - tx) + Math.abs(y - ty));
  const heap = new MinHeap();
  const relax = (from, to, cost, hh) => {
    if (seen[to] === stamp && cost >= g[to]) return;
    seen[to] = stamp;
    g[to] = cost;
    prev[to] = from;
    heap.push(cost + hh, to);
  };
  relax(-1, s * 4 + e.outDir, 0, h(e.sx, e.sy));
  let steps = 0;
  for (; heap.size && steps < ROUTE.STEPS; steps++) {
    const st = heap.pop();
    const n = st >> 2, d = st & 3, gc = g[st];
    if (n === t && d === e.inDir) {
      const nodes = [];
      for (let c = st; c !== -1; c = prev[c]) if (!nodes.length || nodes[nodes.length - 1] !== c >> 2) nodes.push(c >> 2);
      return { nodes: nodes.reverse(), cost: gc, steps };
    }
    if (n === t) { // turn in place to leave the stub in the entry direction
      relax(st, t * 4 + e.inDir, gc + BEND, 0);
      continue;
    }
    const i = n % nx, j = Math.floor(n / nx);
    for (let nd = 0; nd < 4; nd++) {
      if (nd === REV[d]) continue;
      const ii = i + DX[nd], jj = j + DY[nd];
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const m = jj * nx + ii;
      if (blocked[m]) continue;
      // along its own row line a stretch is cheap and meets nothing; a node another line passes is a crossing
      const run = along[2 * Math.min(n, m) + (nd > 1 ? 1 : 0)], share = run === 0 ? 0 : run === line ? -MERGE : SHARE_OTHER;
      const len = Math.abs(xs[ii] - xs[i]) + Math.abs(ys[jj] - ys[j]);
      relax(st, m * 4 + nd, gc + len * (1 + share) + (nd === d ? 0 : BEND) + (run !== line && at[m] !== 0 && at[m] !== line ? CROSS : 0), h(xs[ii], ys[jj]));
    }
  }
  return { steps };
}

// The corners of a route: no repeated points, none in the middle of a straight run (or at
// the end of one that turns back on itself). Its two ends always, even when they are one
// place (a column that references itself): whoever draws it counts on two points.
function simplify(points) {
  const out = [];
  for (const q of points) {
    const a = out[out.length - 2], b = out[out.length - 1];
    if (a && ((a[0] === b[0] && b[0] === q[0]) || (a[1] === b[1] && b[1] === q[1]))) out.pop();
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  return out.length > 1 ? out : [points[0], points[points.length - 1]];
}

// Where arrows cross, the horizontal line jumps over the vertical one with a small arch.
// Only real crossings count: a line that just ends on another is not one, and neither is
// meeting a line to the same row. Next to a corner, the corner's rounding shrinks to make room.
const JUMP_R = 5;
function addJumps(edges) {
  const simple = edges.map(e => simplify(e.points));
  const verticals = simple.flatMap((p, k) => p.slice(1).flatMap((q, i) =>
    p[i][0] === q[0] ? [{ to: edges[k].to, x: q[0], y0: Math.min(p[i][1], q[1]), y1: Math.max(p[i][1], q[1]) }] : []))
    .sort((u, w) => u.x - w.x);
  const firstOver = x => { let lo = 0, hi = verticals.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (verticals[mid].x > x) hi = mid; else lo = mid + 1; } return lo; };
  edges.forEach((e, k) => {
    const p = simple[k], jumps = [];
    for (let i = 1; i < p.length; i++) {
      const [ax, ay] = p[i - 1], [bx, by] = p[i], xs = [];
      if (ay === by) {
        const hi = Math.max(ax, bx) - JUMP_R - 1;
        for (let v = firstOver(Math.min(ax, bx) + JUMP_R + 1); v < verticals.length && verticals[v].x < hi; v++) {
          const s = verticals[v];
          if (s.to !== e.to && ay > s.y0 + 1 && ay < s.y1 - 1 && !(xs.length && s.x - xs[xs.length - 1] <= 2 * JUMP_R + 2)) xs.push(s.x); // no overlapping jumps
        }
        if (bx < ax) xs.reverse();
      }
      jumps.push(xs);
    }
    if (!e.fromYs) { e.d = pathD(p, jumps); return; }
    // A foreign key over several columns: its trunk from where its rows' lines fold into it to where they split
    const fold = arrowFold(e, false, p), split = arrowFold(e, true, p);
    e.trunk = [fold.meet, ...p.slice(1, -1), split.meet];
    e.folds = fold.lines;
    e.splits = split.lines;
    e.d = pathD(e.trunk, jumps, 9, true);
  });
}

// Where a foreign key over several columns meets its trunk at one end (split: the end at the table it points
// at): that point, and each of its rows' lines as corners in the arrow's direction, from its row at the box's
// edge to that point, or the other way at the split. p: the route's corners. A line runs straight out past the
// circle or the arrowhead (the crow's foot), then bends twice, as round as the rows' spacing lets it (9 at
// most), into the trunk's way, so the lines meet the trunk between the rows from either side, in its
// direction. All of it within a stub's length of the box, where the router keeps other lines' trunks out, and
// within the trunk's first stretch (half, where that is its only one), leaving the trunk room to bend; less
// room makes it smaller (the bends first, in the crow's foot, whose symbols need their room).
const ARROWHEAD = 9, CROW_REACH = 18;
function arrowFold(e, split, p = simplify(e.points)) {
  const n = p.length, end = split ? p[n - 1] : p[0], next = split ? p[n - 2] : p[1], ys = split ? e.toYs : e.fromYs, at = end[1];
  let near = Infinity; // the nearest row off the trunk's height
  for (const y of ys) if (y !== at) near = Math.min(near, Math.abs(y - at));
  const crow = state.notation === 'crowsfoot' && !state.dataView;
  let r = near < Infinity ? Math.min(9, near / 2) : 0, straight = crow ? CROW_REACH : ARROWHEAD;
  let room = next[1] === end[1] ? Math.abs(next[0] - end[0]) : 0;
  room = Math.min(ROUTE.STUB, n === 2 ? room / 2 : Math.max(0, room - 9));
  if (straight + 2 * r > room) {
    if (crow) { straight = Math.min(straight, room); r = (room - straight) / 2; }
    else { const k = room / (straight + 2 * r); straight *= k; r *= k; }
  }
  const u = Math.sign(next[0] - end[0]), bend = end[0] + u * (straight + r), meet = [end[0] + u * (straight + 2 * r), at];
  const lines = ys.map(y => {
    const corners = y === at ? [[end[0], y], meet] : [[end[0], y], [bend, y], [bend, at], meet];
    return split ? corners.reverse() : corners;
  });
  return { meet, lines };
}

// Orthogonal path with rounded corners (radius 9, smaller on short segments: two corners share one, each
// taking at most half, but the first and last whole where wholeEnds, as a line that meets another there),
// and jumps[i] = x positions where segment i (from point i to i+1) hops over another line, those that lie on it
function pathD(p, jumps = [], r = 9, wholeEnds = false) {
  const hop = (i, y, a, b) => {
    const dir = Math.sign(b - a);
    return (jumps[i] ?? []).filter(x => x - JUMP_R > Math.min(a, b) && x + JUMP_R < Math.max(a, b)).map(x =>
      `L${x - JUMP_R * dir},${y}A${JUMP_R},${JUMP_R} 0 0 ${dir > 0 ? 1 : 0} ${x + JUMP_R * dir},${y}`).join('');
  };
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i], [x2, y2] = p[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0), d2 = Math.hypot(x2 - x1, y2 - y1);
    if (!d1 || !d2) { d += `L${x1},${y1}`; continue; }
    // a jump right next to this corner: round the corner less so they don't overlap
    const near = [...(y0 === y1 ? jumps[i - 1] ?? [] : []), ...(y1 === y2 ? jumps[i] ?? [] : [])]
      .map(x => Math.abs(x - x1) - JUMP_R);
    const rr = Math.max(0, Math.min(r, wholeEnds && i === 1 ? d1 : d1 / 2, wholeEnds && i === p.length - 2 ? d2 : d2 / 2, ...near));
    if (y0 === y1) d += hop(i - 1, y0, x0, x1);
    d += `L${x1 + (x0 - x1) / d1 * rr},${y1 + (y0 - y1) / d1 * rr}Q${x1},${y1} ${x1 + (x2 - x1) / d2 * rr},${y1 + (y2 - y1) / d2 * rr}`;
  }
  const n = p.length, [lx, ly] = p[n - 1];
  if (p[n - 2][1] === ly) d += hop(n - 2, ly, p[n - 2][0], lx);
  return d + `L${lx},${ly}`;
}

class MinHeap {
  constructor(compare = (a, b) => a - b) { this.k = []; this.v = []; this.compare = compare; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(k[p], key) <= 0) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && this.compare(k[c + 1], k[c]) < 0) c++;
        if (this.compare(k[c], lk) >= 0) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// Slots that only ever rise: raise() lifts a run of them to at least a value, max() is the
// highest in a run. A segment tree: under[i] is the highest slot below node i, whole[i] what
// all of them were raised to at once.
class RangeMax {
  constructor(slots) {
    this.n = 1;
    while (this.n < slots) this.n *= 2;
    this.under = new Int32Array(2 * this.n);
    this.whole = new Int32Array(2 * this.n);
  }
  raise(lo, hi, v, i = 1, a = 0, b = this.n - 1) {
    if (hi < a || b < lo) return;
    this.under[i] = Math.max(this.under[i], v);
    if (lo <= a && b <= hi) { this.whole[i] = Math.max(this.whole[i], v); return; }
    const mid = (a + b) >> 1;
    this.raise(lo, hi, v, 2 * i, a, mid);
    this.raise(lo, hi, v, 2 * i + 1, mid + 1, b);
  }
  max(lo, hi, i = 1, a = 0, b = this.n - 1) {
    if (hi < a || b < lo) return 0;
    if (lo <= a && b <= hi) return this.under[i];
    const mid = (a + b) >> 1;
    return Math.max(this.whole[i], this.max(lo, hi, 2 * i, a, mid), this.max(lo, hi, 2 * i + 1, mid + 1, b));
  }
}


// ─── Diagram rendering ───────────────────────────────────────────────────────

// Colors come from the page's theme variables (themes.js); an export sets them itself.
const DIAGRAM_CSS = `
.box { fill: var(--box-bg, #fffcf5); filter: var(--box-shadow, none); }
.head { fill: var(--box-head, #fffcf5); }
.sep, .outline { fill: none; stroke: var(--box-border, #d3cab2); stroke-width: 1; }
.tbl:hover .outline { stroke: var(--accent, #3a4658); }
.tbl.sel .outline { stroke: var(--accent, #3a4658); stroke-width: 2; }
.marquee { fill: var(--accent, #3a4658); fill-opacity: .08; stroke: var(--accent, #3a4658); stroke-width: 1; stroke-dasharray: 4 3; }
text { dominant-baseline: central; }
.title { font: ${FONTS.head}; letter-spacing: -.005em; fill: var(--box-head-fg, #1c1812); }
.row .hit { fill: transparent; }
.row:hover .hit { fill: var(--row-hover, #f5efe2); }
.key { font: ${FONTS.key}; letter-spacing: .02em; fill: var(--accent, #3a4658); }
.key.fk { fill: var(--tok-ref, #525e1e); }
.name { font: ${FONTS.name}; fill: var(--fg, #1c1812); }
.row.pk .name { font-weight: 600; }
.kdot { fill: oklch(var(--key-l, .55) var(--key-c, .15) var(--h)); }
.key.hued { fill: oklch(var(--key-l, .55) var(--key-c, .15) var(--h)); }
.keyline .hit { fill: transparent; }
.keyline:hover .hit, .row.kh .hit { fill: var(--row-hover, #f5efe2); }
.flags { font: ${FONTS.flags}; fill: var(--tok-flag, #6e3a2e); }
.flags .idx, .flags.idx { fill: var(--faint, #8a7e60); }
.type { font: ${FONTS.type}; fill: var(--muted, #5e5440); }
.row.bad .name, .row.bad .key { fill: var(--err, #7a2e22); }
.dhead { font: ${FONT_DHEAD}; fill: var(--muted, #5e5440); }
.dhead.pk, .dcell.pk { fill: var(--accent, #3a4658); }
.dhead.fk, .dcell.fk { fill: var(--tok-ref, #525e1e); }
.dcell { font: ${FONTS.type}; fill: var(--fg, #1c1812); }
.dcell.pk { font-weight: 600; }
.dcell.null { fill: var(--muted, #5e5440); font-style: italic; }
.drow .hit { fill: transparent; }
.drow:hover .hit { fill: var(--row-hover, #f5efe2); }
.dmark { stroke: none; }
.dmark.hl { stroke: var(--fg, #1c1812); stroke-width: 1.5; }
.dmark { fill: hsl(var(--h) var(--dv-s, 70%) var(--dv-l, 84%)); }
.dmark ~ .dcell.pk, .dmark ~ .dcell.fk { fill: var(--fg, #1c1812); }
.edge { fill: none; stroke: var(--edge, #5e5440); stroke-width: 1.4; stroke-linejoin: round; }
.bundle { stroke: var(--edge, #5e5440); stroke-linecap: round; pointer-events: none; }
.ahead { fill: var(--edge, #5e5440); }
.start { fill: var(--canvas, #fff); stroke: var(--edge, #5e5440); stroke-width: 1.5; }
.sym { fill: none; stroke: var(--edge, #5e5440); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.sym-o { fill: var(--canvas, #fff); stroke: var(--edge, #5e5440); stroke-width: 1.4; }
.mult { font: 500 11px ${MONO_FONT}; fill: var(--muted, #5e5440); dominant-baseline: auto; }
.edge-g.hued .edge, .edge-g.hued .start, .edge-g.hued .sym, .edge-g.hued .sym-o, .bundle.hued { stroke: oklch(var(--key-l, .55) var(--key-c, .15) var(--h)); }
.edge-g.hued .ahead { fill: oklch(var(--key-l, .55) var(--key-c, .15) var(--h)); }
.edge-g.hl .edge { stroke: var(--accent, #3a4658); stroke-width: 2.4; }
.edge-g.hl .ahead { fill: var(--accent, #3a4658); }
.edge-g.hl .start { stroke: var(--accent, #3a4658); }
.edge-g.hl .sym, .edge-g.hl .sym-o { stroke: var(--accent, #3a4658); stroke-width: 2; }
.edge-g.hl .mult { fill: var(--accent, #3a4658); font-weight: 600; }
.edge-hit { fill: none; stroke: transparent; stroke-width: 9; }
`;

const svg = $('#canvas'), vp = $('#vp');
$('#diagramCss').textContent = DIAGRAM_CSS;

let geometry = { boxes: new Map(), edges: [] };
let routed = null; // what the last routing kept, for the next to go on with (see routeEdges)
let moreRoutes = 0; // the frame asked for while arrows wait for their search

function computeGeometry() {
  const tables = model.tables;
  markShown(tables);
  const dims = new Map(tables.map(t => [t, measureTable(t)]));
  ensurePositions(tables, dims);
  const boxes = new Map(tables.map(t => {
    const d = dims.get(t);
    return [t, { x: pos[t.name].x, y: pos[t.name].y, w: d.w, h: d.h, rows: d.rows, data: d.data }];
  }));
  const edges = state.dataView ? [] : diagramEdges(tables, boxes);
  const held = drag?.kind === 'box' && drag.moved ? new Set(tables.filter(t => drag.start[t.name]).map(t => boxes.get(t))) : null;
  const { waiting, kept } = routeEdges(edges, [...boxes.values()], held, routed);
  routed = kept;
  if ((state.notation === 'uml' || state.notation === 'ratio') && !state.dataView) placeLabels(edges);
  geometry = { boxes, edges, dims, bundles: bundles(edges), waiting: held ? 0 : waiting }; // a drag draws anyway, and searches for all when it ends
}

// Where several arrows run along the same stretch, that stretch is drawn thicker:
// 2 arrows twice the width, 3 or more three times (the bus of a table fifty others
// reference would be a wall), in their colour: they point to one row. Returns [{ x1, y1, x2, y2, n, hue }].
// A stretch stops short of the arrowheads and start circles, so they stay visible. A foreign key over several
// columns is its trunk here.
function bundles(edges) {
  const lines = new Map(); // "h:y" / "v:x" → [{ a, b, k }] intervals along that line
  const route = e => e.trunk ?? e.points;
  const ends = new Set(edges.flatMap(e => [route(e)[0], route(e)[route(e).length - 1]].map(p => p.join(','))));
  edges.forEach((e, k) => {
    const p = simplify(route(e));
    for (let i = 1; i < p.length; i++) {
      const [ax, ay] = p[i - 1], [bx, by] = p[i];
      const [key, a, b] = ay === by ? ['h:' + ay, ax, bx] : ['v:' + ax, ay, by];
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push({ a: Math.min(a, b), b: Math.max(a, b), k });
    }
  });
  const out = [], TRIM = 10;
  for (const [key, ivs] of lines) {
    if (ivs.length < 2) continue;
    const horiz = key[0] === 'h', at = +key.slice(2);
    const cuts = [...new Set(ivs.flatMap(v => [v.a, v.b]))].sort((p, q) => p - q);
    let run = null;
    const flush = () => {
      if (!run || run.n < 2) return;
      const pt = v => (horiz ? [v, at] : [at, v]).join(',');
      const a = run.a + (ends.has(pt(run.a)) ? TRIM : 0), b = run.b - (ends.has(pt(run.b)) ? TRIM : 0);
      if (b > a) out.push(horiz ? { x1: a, y1: at, x2: b, y2: at, n: run.n, hue: run.hue } : { x1: at, y1: a, x2: at, y2: b, n: run.n, hue: run.hue });
    };
    for (let i = 1; i < cuts.length; i++) {
      const a = cuts[i - 1], b = cuts[i], over = ivs.filter(v => v.a <= a && v.b >= b);
      const n = Math.min(3, new Set(over.map(v => v.k)).size), hue = over.length ? edges[over[0].k].hue ?? null : null;
      if (run && run.n === n && run.hue === hue && run.b === a) run.b = b;
      else { flush(); run = { a, b, n, hue }; }
    }
    flush();
  }
  return out;
}

// The arrows between boxes (Map table → box), before routing. Each takes the colour of the key it points to
// (hue, as its FK badge has it). A foreign key over several columns is one arrow, routed as one line (its
// trunk) from between its rows to between those it points to: fromYs and toYs are its rows' heights, where
// its lines fold into the trunk and split from it (arrowFold); it is known by its lead column (from) and by
// the key it points to (to), which arrows to the same key share as a row line.
function diagramEdges(tables, boxes) {
  const edges = [];
  for (const t of tables) {
    shownCols(t).forEach(c => {
      if (!c.target || !leadsFk(c)) return;
      const a = boxes.get(t), b = boxes.get(c.target), g = c.fkGroup, { fromRows, toRows } = arrowRows(t, c), row = b.y + rowsMiddle(toRows);
      // a key over all or some of g's columns makes it 1-1
      const keyIn = cols => cols.length > 0 && cols.every(k => g.cols.includes(k));
      edges.push({
        a, b,
        fromTable: t.name, toTable: c.target.name,
        // what the schema guarantees: a unique FK (or one that is the whole PK) makes it 1-1,
        // a nullable FK means a row may have no parent
        unique: g ? keyIn(t.pkCols) || (t.multiUniques ?? []).some(u => keyIn(u.cols)) || g.cols.some(k => k.unique) : c.unique || solePk(t, c),
        nullable: g ? g.cols.some(k => k.nullable) : c.nullable,
        implicit: c.implicit,
        hue: c.keyHue,
        from: t.name + '.' + c.name,
        to: c.target.name + '.' + (g ? `(${g.targetCols.map(k => k.name).join(', ')})` : c.targetCol.name),
        sy: a.y + rowsMiddle(fromRows),
        ty: row, row,
        ...g && { fromYs: fromRows.map(k => a.y + rowY(k)), toYs: toRows.map(k => b.y + rowY(k)) },
      });
    });
  }
  // In the ER notations each arrow's "one" end has its own symbol, so arrows that point
  // at the same row are spread a little apart instead of meeting in one point (ty moves, row stays)
  if (state.notation !== 'arrows') {
    const byTarget = new Map();
    for (const e of edges) (byTarget.get(e.to) ?? byTarget.set(e.to, []).get(e.to)).push(e);
    for (const group of byTarget.values()) {
      if (group.length < 2) continue;
      const step = Math.min(8, 22 / (group.length - 1));
      group.sort((p, q) => p.sy - q.sy || (p.from < q.from ? -1 : p.from > q.from ? 1 : 0));
      group.forEach((e, i) => {
        const off = (i - (group.length - 1) / 2) * step;
        e.ty += off;
        e.small = true;
      });
    }
  }
  return edges;
}

function dataBoxBody(t, b, interactive) {
  const { cols, cells, xs, cws } = b.data, ch = HEAD_H + 6 + COLHEAD_H / 2;
  const kind = c => c.isPk ? ' pk' : c.target ? ' fk' : '';
  let s = cols.map((c, i) => `<text class="dhead${kind(c)}" x="${xs[i]}" y="${ch}">` +
    (c.target ? `<title>${esc(c.name)} → ${esc(c.target.name)}.${esc(c.targetCol.name)}</title>` : '') + `${esc(c.name)}</text>`).join('');
  s += `<line class="sep" x1="${PAD_X}" y1="${HEAD_H + 6 + COLHEAD_H - .5}" x2="${b.w - PAD_X}" y2="${HEAD_H + 6 + COLHEAD_H - .5}"/>`;
  if (!cells.length) return s + `<text class="dcell null" x="${PAD_X}" y="${dataRowY(0)}">no rows</text>`;
  cells.forEach((row, k) => {
    const y = dataRowY(k);
    s += `<g class="drow">`;
    if (interactive) s += `<rect class="hit" x="1" y="${y - DATA_H / 2}" width="${b.w - 2}" height="${DATA_H}"/>`;
    row.forEach((cell, i) => {
      if (cell.key) s += `<rect class="dmark" style="--h:${cell.hue}" data-k="${esc(cell.key)}" x="${xs[i] - 5}" y="${y - DATA_H / 2 + 3}" width="${cws[i] + 10}" height="${DATA_H - 6}" rx="4"/>`;
      s += `<text class="dcell${kind(cols[i])}${cell.text === 'NULL' ? ' null' : ''}" x="${xs[i]}" y="${y}">${esc(cell.text)}</text>`;
    });
    s += '</g>';
  });
  return s;
}

function boxMarkup(t, b, interactive) {
  const { w, h } = b, r = 9;
  let s = `<g class="tbl${interactive && selected.has(t.name) ? ' sel' : ''}" data-t="${esc(t.name)}" transform="translate(${b.x},${b.y})">`;
  s += `<rect class="box" width="${w}" height="${h}" rx="${r}"/>`;
  s += `<path class="head" d="M0,${r}A${r},${r} 0 0 1 ${r},0H${w - r}A${r},${r} 0 0 1 ${w},${r}V${HEAD_H}H0Z"/>`;
  s += `<line class="sep" x1="0" y1="${HEAD_H + .5}" x2="${w}" y2="${HEAD_H + .5}"/>`;
  s += `<text class="title" x="${PAD_X}" y="${HEAD_H / 2}">${esc(t.name)}</text>`;
  if (b.data) return s + dataBoxBody(t, b, interactive) +
    `<rect class="outline" x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${r - .5}"/></g>`;
  const groups = keyGroups(t), lead = dotsLead(t, groups), slots = lead / DOT_W, nx = PAD_X + BADGE_W + GAP + lead;
  shownCols(t).forEach((c, i) => {
    const row = b.rows[i], y = rowY(i);
    const cls = 'row' + (c.isPk ? ' pk' : '') + (c.ref && !c.target ? ' bad' : '');
    s += `<g class="${cls}" data-key="${esc(t.name + '.' + c.name)}" data-line="${c.line}">`;
    if (c.ref && !c.target) s += `<title>${esc(c.refError)}</title>`;
    if (interactive) s += `<rect class="hit" x="1" y="${y - ROW_H / 2}" width="${w - 2}" height="${ROW_H}"/>`;
    const mine = groups.map((g, k) => [g, k]).filter(([g]) => g.cols.includes(c));
    mine.forEach(([g, k], j) => { s += keyDot(g, k, slots - mine.length + j, y); });
    if (row.key) {
      const hue = row.key === 'PK' ? t.hue : c.keyHue;
      s += `<text class="key${row.key === 'FK' ? ' fk' : ''}${hue == null ? '' : ' hued'}"${hue == null ? '' : ` style="--h:${hue}"`} x="${PAD_X}" y="${y}">${row.key}</text>`;
    }
    s += `<text class="name" x="${nx}" y="${y}">${esc(row.name)}</text>`;
    s += `<text class="type" x="${w - PAD_X}" y="${y}" text-anchor="end">${esc(row.type)}</text>`;
    if (row.flags) {
      const fx = w - PAD_X - textW(row.type, FONTS.type) - 6, rest = row.idx ? row.flags.slice(0, -IDX.length) : row.flags;
      s += `<text class="flags" x="${fx}" y="${y}" text-anchor="end">${rest}${row.idx ? `<tspan class="idx">${IDX}</tspan>` : ''}</text>`;
    }
    s += '</g>';
  });
  const foot = footLines(t), fy = footTop(b.rows.length);
  if (foot.length) s += `<line class="sep" x1="0" y1="${fy + .5}" x2="${w}" y2="${fy + .5}"/>`;
  const labelW = footLabelW(foot);
  foot.forEach((f, k) => {
    const y = fy + 3 + (k + .5) * FOOT_H;
    // hovering the line lights up its rows
    s += `<g class="keyline" data-cols="${esc(f.cols.map(n => t.name + '.' + n).join('\n'))}">`;
    if (interactive) s += `<rect class="hit" x="1" y="${y - FOOT_H / 2}" width="${w - 2}" height="${FOOT_H}"/>`;
    if (f.group != null) s += keyDot(groups[f.group], f.group, slots - 1, y);
    const lx = atNames(f) ? nx : PAD_X;
    s += `<text class="flags${f.index ? ' idx' : ''}"${f.hue != null ? ` style="fill:oklch(var(--key-l, .55) var(--key-c, .15) ${f.hue})"` : ''} x="${lx}" y="${y}">${f.label}</text>` +
      `<text class="type" x="${lx + labelW}" y="${y}">${esc(f.text)}</text></g>`;
  });
  s += `<rect class="outline" x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${r - .5}"/></g>`;
  return s;
}

// An arrow: rounded path, a hollow circle at the FK row, a filled 9×9 arrowhead at the target
// Notations. Every one connects the FK row to the referenced row; they differ only in
// what is drawn at the two ends. The FK end is the "many" side, the referenced end the "one".
const NOTATIONS = {
  arrows: 'Arrows (SQL)',
  crowsfoot: "Crow's foot",
  uml: 'UML',
  ratio: '1 : N',
};
// A small picture of each notation, for its button and menu
const NOTATION_ICONS = {
  arrows: '<path d="M1.5 8h12"/><path d="M10.5 5 13.5 8l-3 3"/>',
  crowsfoot: '<path d="M1.5 8h13M4 5v6M10 8l4.5-4M10 8l4.5 4"/>',
  uml: '<path d="M1.5 11.5h13"/><text x="1.5" y="8.5">1</text><text x="10" y="11" class="big">*</text>',
  ratio: '<text x="8" y="11" text-anchor="middle">1:N</text>',
};
const notationIcon = n => `<svg width="16" height="16" class="ico thin notation-ico" aria-hidden="true">${NOTATION_ICONS[n]}</svg>`;

// Crow's foot symbols at an end: x,y on the box edge, d = direction away from the box,
// h = half height (smaller when several arrows end on the same row)
const crowOne = (x, y, d, h) => `M${x + 6 * d},${y - h}V${y + h}M${x + 10 * d},${y - h}V${y + h}`;       // ||  exactly one
const crowZeroOne = (x, y, d, h) => `M${x + 7 * d},${y - h}V${y + h}`;                                     // o|  (ring added below)
const crowMany = (x, y, d, h) => `M${x},${y - h}L${x + 10 * d},${y}L${x},${y + h}`;                       // <   (ring added below)
const ring = (x, y, d, h) => `<circle class="sym-o" cx="${x + 15 * d}" cy="${y}" r="${h > 4 ? 3.5 : 2.5}"/>`;

// UML / 1 : N labels. Each end's label tries above and below its line (then a bit
// further out) and takes the first spot that touches no line and no other label.
function labelTexts(e) {
  return state.notation === 'uml'
    ? [e.nullable ? '0..1' : '1', e.unique ? '0..1' : '*']      // referenced end, FK end
    : ['1', e.unique ? '1' : 'N'];
}
// A foreign key over several columns has its labels above its top row and below its bottom one, clear of
// its lines folding and splitting there.
function placeLabels(edges) {
  const CHAR_W = 6.8, H = 11;
  const lines = e => [e.points, ...e.folds ?? [], ...e.splits ?? []];
  const segs = edges.flatMap(e => lines(e).flatMap(l => l.slice(1).map((p, i) => [l[i], p])));
  const hitsSeg = r => segs.some(([[x1, y1], [x2, y2]]) =>
    Math.max(x1, x2) >= r.x && Math.min(x1, x2) <= r.x + r.w && Math.max(y1, y2) >= r.y && Math.min(y1, y2) <= r.y + r.h);
  const taken = [];
  const overlaps = r => taken.some(q => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
  for (const e of edges) {
    const pts = e.points, n = pts.length;
    const [target, fk] = labelTexts(e);
    e.labels = [[pts[n - 1], pts[n - 2], target, e.toYs], [pts[0], pts[1], fk, e.fromYs]].map(([[x, y], [nx], text, ys = [y]]) => {
      const d = Math.sign(nx - x) || 1, w = text.length * CHAR_W;
      const spot = (dx, above) => {
        const lx = x + dx * d, ly = above ? Math.min(...ys) - 8 : Math.max(...ys) + 15;
        return { x: lx, y: ly, anchor: d > 0 ? 'start' : 'end', text, box: { x: d > 0 ? lx : lx - w, y: ly - H + 2, w, h: H } };
      };
      const tries = [spot(9, true), spot(9, false), spot(24, true), spot(24, false)];
      const l = tries.find(t => !hitsSeg(t.box) && !overlaps(t.box)) ?? tries.find(t => !overlaps(t.box)) ?? tries[0];
      taken.push(l.box);
      return l;
    });
  }
}

// The marks at an arrow's ends; a foreign key's over several columns at each of its rows' lines
function endMarks(e) {
  const pts = e.points, n = pts.length;
  // [x, y, d]: where a line meets its box, and d the direction away from the box
  const end = ([x, y], [nx], d) => [x, y, Math.sign(nx - x) || d];
  const starts = e.folds ? e.folds.map(l => end(l[0], l[1], 1)) : [end(pts[0], pts[1], 1)];
  const ends = e.splits ? e.splits.map(l => end(l[l.length - 1], l[l.length - 2], -1)) : [end(pts[n - 1], pts[n - 2], -1)];
  const labels = () => e.labels.map(l =>
    `<text class="mult" x="${l.x}" y="${l.y}" text-anchor="${l.anchor}">${l.text}</text>`).join('');
  switch (state.dataView ? 'arrows' : state.notation) {
    case 'crowsfoot': {
      const th = e.small ? 3.5 : 6;
      // referenced end: exactly one, or zero-or-one when the FK may be NULL
      let s = ends.map(([tx, ty, td]) => `<path class="sym" d="${e.nullable ? crowZeroOne(tx, ty, td, th) : crowOne(tx, ty, td, th)}"/>` +
        (e.nullable ? ring(tx, ty, td, th) : '')).join('');
      // FK end: zero-or-many, or zero-or-one when the FK is unique (1-1)
      s += starts.map(([sx, sy, sd]) => `<path class="sym" d="${e.unique ? crowZeroOne(sx, sy, sd, 6) : crowMany(sx, sy, sd, 6)}"/>` + ring(sx, sy, sd, 6)).join('');
      return s;
    }
    case 'uml':
      return labels();
    case 'ratio':
      return labels();
    default: // arrows: a hollow circle at the FK row, an arrowhead at the referenced row
      return ends.map(([tx, ty, td]) => `<path class="ahead" d="M${tx},${ty}L${tx + ARROWHEAD * td},${ty - ARROWHEAD / 2}L${tx + ARROWHEAD * td},${ty + ARROWHEAD / 2}Z"/>`).join('') +
        starts.map(([sx, sy]) => `<circle class="start" cx="${sx}" cy="${sy}" r="3"/>`).join('');
  }
}

// An arrow in the colour of the key it points to; a foreign key's over several columns with its rows' lines,
// which are part of it under the mouse too
function edgeMarkup(e, interactive) {
  const hued = e.hue != null, rows = [...e.folds ?? [], ...e.splits ?? []].map(l => pathD(l, [], 9, true));
  let s = `<g class="edge-g${hued ? ' hued' : ''}"${hued ? ` style="--h:${e.hue}"` : ''} data-from="${esc(e.from)}" data-to="${esc(e.to)}" data-ft="${esc(e.fromTable)}" data-tt="${esc(e.toTable)}">`;
  if (interactive) for (const d of [e.d, ...rows]) s += `<path class="edge-hit" d="${d}"/>`;
  for (const d of [e.d, ...rows]) s += `<path class="edge${e.implicit ? ' implicit' : ''}" d="${d}"/>`;
  return s + endMarks(e) + '</g>';
}

function diagramMarkup(interactive) {
  let s = '';
  for (const [t, b] of geometry.boxes) s += boxMarkup(t, b, interactive);
  for (const e of geometry.edges) s += edgeMarkup(e, interactive);
  for (const l of geometry.bundles ?? []) {
    s += `<line class="bundle${l.hue != null ? ' hued' : ''}"${l.hue != null ? ` style="--h:${l.hue}"` : ''} x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke-width="${1.4 * l.n}"/>`;
  }
  return s;
}

function drawDiagram() {
  computeGeometry();
  // arrows on a detour, waiting for their search: the next frame goes on with them
  if (geometry.waiting && !moreRoutes) moreRoutes = requestAnimationFrame(() => { moreRoutes = 0; drawDiagram(); });
  vp.innerHTML = diagramMarkup(true);
  $('#emptyState').hidden = model.tables.length > 0;
  if (hoverTable) highlightTable(hoverTable);
  showSelectHint();
  if (revealName) { reveal(revealName); revealName = null; }
}

// Hovering a table highlights its arrows (drawn on top); hovering an arrow highlights it
let hoverTable = null;
function setHighlight(edgeEls) {
  vp.querySelectorAll('.edge-g.hl').forEach(el => el.classList.remove('hl'));
  for (const g of edgeEls) {
    g.classList.add('hl');
    g.parentNode.appendChild(g); // bring to front
  }
}
function highlightTable(name) {
  setHighlight([...vp.querySelectorAll('.edge-g')].filter(g => g.dataset.ft === name || g.dataset.tt === name));
}
svg.addEventListener('mouseover', e => {
  if (drag) return;
  const tbl = e.target.closest('.tbl'), edge = e.target.closest('.edge-g');
  hoverTable = tbl ? tbl.dataset.t : null;
  // data view: hovering a row outlines its coloured cells and every cell with the same colour key
  const keys = new Set([...(e.target.closest('.drow')?.querySelectorAll('.dmark') ?? [])].map(m => m.dataset.k));
  vp.querySelectorAll('.dmark').forEach(m => m.classList.toggle('hl', keys.has(m.dataset.k)));
  // a key or index line below the rows lights up the rows it is made of
  const cols = new Set(e.target.closest('.keyline')?.dataset.cols.split('\n'));
  vp.querySelectorAll('.row').forEach(r => r.classList.toggle('kh', cols.has(r.dataset.key)));
  if (edge) setHighlight([edge]);
  else if (tbl) highlightTable(tbl.dataset.t);
  else setHighlight([]);
});
svg.addEventListener('mouseleave', () => { hoverTable = null; setHighlight([]); });

// ─── Pan, zoom, drag ─────────────────────────────────────────────────────────

const view = { tx: 0, ty: 0, s: 1 };
const ZOOM_MIN = 0.25, ZOOM_MAX = 2.5;
const CARD_TOP = 64, CARD_BOTTOM = 56; // room kept for the floating toolbars

function applyView() {
  vp.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.s})`);
  // a dot on every grid point: the tile's dot is in its middle
  svg.style.backgroundSize = `${GRID * view.s}px ${GRID * view.s}px`;
  svg.style.backgroundPosition = `${view.tx - GRID / 2 * view.s}px ${view.ty - GRID / 2 * view.s}px`;
  $('#zoomLabel').textContent = Math.round(view.s * 100) + '%';
  saveState(); // each diagram remembers its pan/zoom (the save is debounced)
}
function toWorld(e) {
  const r = svg.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.tx) / view.s, y: (e.clientY - r.top - view.ty) / view.s };
}
function zoomTo(s, cx, cy) {
  s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
  view.tx = cx - (cx - view.tx) * (s / view.s);
  view.ty = cy - (cy - view.ty) * (s / view.s);
  view.s = s;
  applyView();
}
const zoomAt = (cx, cy, k) => zoomTo(view.s * k, cx, cy);

// The middle of what's on screen, in diagram coordinates (where unconnected new tables go)
function viewCenter() {
  const r = svg.getBoundingClientRect();
  if (!r.width) return null;
  return { x: (r.width / 2 - view.tx) / view.s, y: (r.height / 2 - view.ty) / view.s };
}

// Pan just enough to show a table's box
function reveal(name) {
  const t = model.tables.find(t => t.name === name), b = t && geometry.boxes.get(t);
  const r = svg.getBoundingClientRect();
  if (!b || !r.width) return;
  const m = 30;
  const x0 = b.x * view.s + view.tx, y0 = b.y * view.s + view.ty;
  const x1 = x0 + b.w * view.s, y1 = y0 + b.h * view.s;
  if (x0 < m) view.tx += m - x0; else if (x1 > r.width - m) view.tx -= Math.min(x1 - (r.width - m), x0 - m);
  if (y0 < CARD_TOP) view.ty += CARD_TOP - y0;
  else if (y1 > r.height - CARD_BOTTOM) view.ty -= Math.min(y1 - (r.height - CARD_BOTTOM), y0 - CARD_TOP);
  applyView();
}

function contentBounds(pad) {
  const bs = [...geometry.boxes.values()];
  if (!bs.length) return null;
  const x0 = Math.min(...bs.map(b => b.x)) - pad, y0 = Math.min(...bs.map(b => b.y)) - pad;
  const x1 = Math.max(...bs.map(b => b.x + b.w)) + pad, y1 = Math.max(...bs.map(b => b.y + b.h)) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// Is the whole diagram on screen (clear of the floating toolbars)?
function diagramVisible() {
  const bb = contentBounds(0), r = svg.getBoundingClientRect();
  if (!bb || !r.width) return false;
  const x0 = bb.x * view.s + view.tx, y0 = bb.y * view.s + view.ty;
  return x0 >= 0 && y0 >= CARD_TOP - 20 && x0 + bb.w * view.s <= r.width && y0 + bb.h * view.s <= r.height - CARD_BOTTOM + 20;
}

// The middle of the table nearest the middle of all the tables' area
function contentMiddle() {
  const bs = [...geometry.boxes.values()], mid = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  let area = 0, x = 0, y = 0;
  for (const b of bs) { area += b.w * b.h; x += b.w * b.h * mid(b).x; y += b.w * b.h * mid(b).y; }
  const far = b => (mid(b).x - x / area) ** 2 + (mid(b).y - y / area) ** 2;
  return mid(bs.reduce((p, q) => far(q) < far(p) ? q : p));
}

// keepZoom: stay at the current zoom if the whole diagram fits at it (just centre it)
function fit(maxZoom = 1.25, keepZoom = false) {
  const r = svg.getBoundingClientRect();
  const bb = contentBounds(20);
  if (!r.width) return;
  if (!bb) { view.s = 1; view.tx = 40; view.ty = 80; applyView(); return; }
  const sw = (r.width - 96) / bb.w, sh = (r.height - CARD_TOP - CARD_BOTTOM - 30) / bb.h, s = Math.min(maxZoom, sw, sh);
  view.s = keepZoom && view.s <= s ? view.s : Math.max(ZOOM_MIN, s);
  // Centred; where it is too big even at the least zoom, on a table in the middle of where
  // the tables are: the middle of all it spans may be empty
  const mid = contentMiddle();
  view.tx = r.width / 2 - (sw < ZOOM_MIN ? mid.x : bb.x + bb.w / 2) * view.s;
  view.ty = CARD_TOP + (r.height - CARD_TOP - CARD_BOTTOM) / 2 - (sh < ZOOM_MIN ? mid.y : bb.y + bb.h / 2) * view.s;
  applyView();
}

// Selected tables move together. Shift/⌘-click toggles a table; shift-drag the canvas
// selects every table the box touches; a plain click (or Escape) clears the selection.
let selected = new Set();
function setSelected(names) {
  selected = new Set(names);
  vp.querySelectorAll('.tbl').forEach(g => g.classList.toggle('sel', selected.has(g.dataset.t)));
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && selected.size) setSelected([]); });

// One-time hint about moving and selecting tables, once there's more than one table
function showSelectHint() {
  $('#selectHint').hidden = store.get('selectHintSeen', false) || model.tables.length < 2 || !$('#storageNotice').hidden;
}
$('#selectHintOk').onclick = () => { store.set('selectHintSeen', true); $('#selectHint').hidden = true; };

let drag = null, frame = 0;
// Fingers on the canvas, by pointer id. Two of them pinch: they zoom, and pan by their middle.
const fingers = new Map();
const pinchAt = () => {
  const [a, b] = [...fingers.values()], r = svg.getBoundingClientRect();
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
};
svg.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  closeMenus();
  const g = e.target.closest('.tbl'), multi = e.shiftKey || e.metaKey || e.ctrlKey;
  svg.setPointerCapture(e.pointerId);
  if (e.pointerType === 'touch') {
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size > 2) return;
    if (fingers.size === 2) {
      if (drag?.kind === 'box' && drag.moved) { saveDoc(); histCommit(); svg.classList.remove('dragging'); drawDiagram(); }
      const p = pinchAt();
      drag = { kind: 'pinch', p, s: view.s, w: { x: (p.x - view.tx) / view.s, y: (p.y - view.ty) / view.s } };
      return;
    }
  }
  // while presenting, a finger only looks: on a table too it pans, and doesn't move or pick it
  const look = e.pointerType === 'touch' && presentView;
  if (g && multi && !look) {
    const n = g.dataset.t, s = new Set(selected);
    s.has(n) ? s.delete(n) : s.add(n);
    setSelected(s);
    drag = { kind: 'none' };
  } else if (g && !look) {
    const w = toWorld(e), name = g.dataset.t;
    if (!selected.has(name)) setSelected([]);
    const names = selected.has(name) ? [...selected].filter(n => pos[n]) : [name];
    drag = { kind: 'box', name, w, start: Object.fromEntries(names.map(n => [n, { ...pos[n] }])),
             sx: e.clientX, sy: e.clientY, moved: false, free: e.altKey, line: e.target.closest('[data-line]')?.dataset.line ?? null };
  } else if (multi && !look) {
    const m = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    m.setAttribute('class', 'marquee');
    svg.appendChild(m);
    drag = { kind: 'marquee', w: toWorld(e), el: m, base: new Set(selected) };
  } else {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
    svg.classList.add('panning');
  }
});
svg.addEventListener('pointermove', e => {
  if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag) return;
  if (drag.kind === 'pinch') {
    if (fingers.size !== 2) return;
    const p = pinchAt();
    view.s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, drag.s * p.d / drag.p.d));
    view.tx = p.x - drag.w.x * view.s;
    view.ty = p.y - drag.w.y * view.s;
    applyView();
    return;
  }
  if (drag.kind === 'pan') {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) >= 4) drag.moved = true;
    view.tx = drag.tx + e.clientX - drag.sx;
    view.ty = drag.ty + e.clientY - drag.sy;
    applyView();
    return;
  }
  if (drag.kind === 'marquee') {
    const a = drag.w, b = toWorld(e);
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const at = { x: x0 * view.s + view.tx, y: y0 * view.s + view.ty, width: (x1 - x0) * view.s, height: (y1 - y0) * view.s };
    for (const k in at) drag.el.setAttribute(k, at[k]);
    const hit = [...geometry.boxes].filter(([, r]) => r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0).map(([t]) => t.name);
    setSelected([...drag.base, ...hit]);
    return;
  }
  if (drag.kind !== 'box') return;
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
  if (!drag.moved) { histBegin('move'); svg.classList.add('dragging'); }
  drag.moved = true;
  // With Snap on, the tables stand on the grid; Option (Alt) held at any time during the drag lets them go
  // where the mouse takes them, to the end of it
  if (e.altKey) drag.free = true;
  const w = toWorld(e);
  for (const [n, p] of Object.entries(drag.start)) pos[n] = dragSpot(p.x, p.y, w.x - drag.w.x, w.y - drag.w.y, state.snap && !drag.free);
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawDiagram(); });
});
function endDrag(e) {
  fingers.delete(e.pointerId);
  if (drag?.kind === 'pinch') { if (fingers.size < 2) drag = null; return; } // the finger left behind doesn't pan
  if (!drag) return;
  const dropped = drag.kind === 'box' && drag.moved;
  if (drag.kind === 'box') {
    if (drag.moved) { saveDoc(); histCommit(); }
    else {
      if (drag.line) selectLine(+drag.line);
      else {
        const t = model.tables.find(t => t.name === drag.name);
        if (t) selectLine(t.line);
      }
    }
  } else if (drag.kind === 'marquee') drag.el.remove();
  else if (drag.kind === 'pan' && !drag.moved) setSelected([]);
  svg.classList.remove('panning', 'dragging');
  drag = null;
  if (dropped) drawDiagram(); // while it was dragged, only the dragged tables' arrows were searched for
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);
svg.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = svg.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
  } else {
    view.tx -= e.deltaX;
    view.ty -= e.deltaY;
    applyView();
  }
}, { passive: false });

// Glide the view to { tx, ty, s }
let glide = 0;
function glideTo(to, ms = 240) {
  cancelAnimationFrame(glide);
  const from = { ...view }, t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / ms), e = 1 - (1 - k) ** 3;
    for (const p of ['tx', 'ty', 's']) view[p] = from[p] + (to[p] - from[p]) * e;
    applyView();
    if (k < 1) glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}

// A table in the middle of the screen (at 100% if it was smaller), selected; a column of it lit up for a moment
function focusTable(name, col = null) {
  const t = model.tables.find(t => t.name === name), b = t && geometry.boxes.get(t), r = svg.getBoundingClientRect();
  if (!b || !r.width) return;
  const s = Math.max(view.s, 1);
  glideTo({ s, tx: r.width / 2 - (b.x + b.w / 2) * s, ty: (CARD_TOP + r.height - CARD_BOTTOM) / 2 - (b.y + b.h / 2) * s });
  setSelected([name]);
  const row = col && vp.querySelector(`.tbl[data-t="${CSS.escape(name)}"] .row[data-key="${CSS.escape(name + '.' + col)}"]`);
  if (row) { row.classList.add('kh'); setTimeout(() => row.classList.remove('kh'), 1500); }
}

// ─── Find (the magnifier in the app bar, ⌘F / ⌘K): tables, then columns, whose name has what is typed ──

const finder = $('#finder'), findInput = $('#findInput'), findList = $('#findList'), findBtn = $('#findBtn'), findSlot = finder.parentNode;
let found = [], foundAt = 0;

function openFinder() {
  closeMenus();
  if (presentView) { finder.classList.add('floating'); document.body.appendChild(finder); } // the app bar is hidden
  finder.hidden = false;
  findBtn.setAttribute('aria-expanded', 'true');
  findInput.focus();
  findInput.select();
  renderFinder();
}
// it closes when the box loses the focus
const closeFinder = () => findInput.blur();

function renderFinder() {
  const q = findInput.value.trim().toLowerCase();
  const hit = s => s.toLowerCase().indexOf(q);
  const mark = (s, i) => i < 0 || !q ? esc(s) : esc(s.slice(0, i)) + `<b>${esc(s.slice(i, i + q.length))}</b>` + esc(s.slice(i + q.length));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  // names that start with it first
  const rank = list => list.filter(x => hit(x.name) >= 0).sort((a, b) => (hit(a.name) > 0) - (hit(b.name) > 0) || byName(a, b));
  const tables = rank(model.tables.map(t => ({ name: t.name, t, col: false })));
  const cols = q ? rank(model.tables.flatMap(t => t.cols.map(c => ({ name: c.name, t, col: true })))) : [];
  found = [...tables, ...cols].slice(0, 50);
  foundAt = 0;
  findList.innerHTML = found.map((f, i) =>
    `<button class="find-item${i ? '' : ' on'}" data-i="${i}" role="option" aria-selected="${!i}" tabindex="-1">` +
    `<span>${mark(f.name, hit(f.name))}</span><span class="where">${f.col ? 'in ' + esc(f.t.name) : f.t.cols.length + ' columns'}</span></button>`,
  ).join('') || (model.tables.length ? '<div class="find-empty">No table or column has that in its name</div>' : '');
}

function pickFound(i) {
  const f = found[i];
  if (!f) return;
  findInput.value = '';
  closeFinder();
  focusTable(f.t.name, f.col ? f.name : null);
}

function moveFound(d) {
  if (!found.length) return;
  foundAt = (foundAt + d + found.length) % found.length;
  findList.querySelectorAll('.find-item').forEach((b, i) => {
    b.classList.toggle('on', i === foundAt);
    b.setAttribute('aria-selected', String(i === foundAt));
  });
  findList.children[foundAt].scrollIntoView({ block: 'nearest' });
}

findInput.addEventListener('blur', () => {
  finder.hidden = true;
  findBtn.setAttribute('aria-expanded', 'false');
  if (finder.classList.contains('floating')) { finder.classList.remove('floating'); findSlot.appendChild(finder); }
});
finder.addEventListener('pointerdown', e => { if (e.target !== findInput) e.preventDefault(); }); // the box keeps the focus
findBtn.addEventListener('pointerdown', e => e.preventDefault()); // …so a click on the magnifier while open closes it
findBtn.onclick = () => finder.hidden ? openFinder() : closeFinder();
findInput.addEventListener('input', renderFinder);
findInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveFound(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Enter') { e.preventDefault(); pickFound(foundAt); }
  else if (e.key === 'Escape') { e.stopPropagation(); closeFinder(); } // the selection stays
});
findList.addEventListener('click', e => { const b = e.target.closest('.find-item'); if (b) pickFound(+b.dataset.i); });
// ⌘F and ⌘K go to the box; in the editor ⌘F is still the browser's Find, for the text
document.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || (k !== 'f' && k !== 'k')) return;
  if (!$('#tableDlg').hidden || !$('#confirmDlg').hidden || (k === 'f' && e.target === ta)) return;
  e.preventDefault();
  openFinder();
});

const viewMiddle = () => { const r = svg.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
const zoom100 = () => zoomTo(1, ...viewMiddle());
const fitView = () => fit(presentView ? 2 : undefined);
$('#zoomIn').onclick = () => zoomTo(view.s * 1.2, ...viewMiddle());
$('#zoomOut').onclick = () => zoomTo(view.s / 1.2, ...viewMiddle());
$('#zoomLabel').onclick = zoom100;
$('#fitBtn').onclick = fitView;
const selectAll = () => setSelected(model.tables.map(t => t.name));
// ⌘A selects every table, ⇧1 fits the diagram to the screen, ⇧0 zooms to 100% (unless you are typing)
document.addEventListener('keydown', e => {
  if (!$('#tableDlg').hidden || !$('#confirmDlg').hidden || e.target.closest('input, textarea, [contenteditable]')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
  else if (e.shiftKey && !mod && !e.altKey && (e.code === 'Digit1' || e.code === 'Digit0')) {
    e.preventDefault();
    e.code === 'Digit1' ? fitView() : zoom100();
  }
});
// Rearrange every table (the Auto layout button, loading an example, repairing overlaps)
function autoLayout() {
  histRecord('layout', () => arrangeAll(model.tables, geometry.dims));
  saveDoc();
  drawDiagram();
}
const layoutAndShow = () => { autoLayout(); fit(undefined, true); };
$('#layoutBtn').onclick = layoutAndShow;

// Do any two boxes overlap? (e.g. positions saved while boxes had other sizes)
function boxesOverlap() {
  const bs = [...geometry.boxes.values()];
  return bs.some((p, i) => bs.slice(i + 1).some(q =>
    p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y));
}

// ─── Export ──────────────────────────────────────────────────────────────────

// The fonts, embedded, so an exported SVG/PNG looks the same without Geist installed.
// Only the latin subsets (covers å ä ö). Fetched once; without network the export
// simply falls back to system fonts.
let fontCssPromise = null;
function embeddedFontCss() {
  fontCssPromise ??= (async () => {
    try {
      const css = await (await fetch('https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono:wght@400;600&display=swap')).text();
      const faces = css.split('/*').filter(b => /^\s*latin(-ext)?\s*\*\//.test(b)).map(b => b.slice(b.indexOf('@font-face')));
      const out = await Promise.all(faces.map(async face => {
        const url = face.match(/url\((https:[^)]+)\)/)?.[1];
        if (!url) return '';
        const buf = await (await fetch(url)).arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return face.replace(url, 'data:font/woff2;base64,' + btoa(bin));
      }));
      return out.join('\n');
    } catch {
      return '';
    }
  })();
  return fontCssPromise;
}

// An export looks as the diagram does on screen: the chosen theme, light or dark, on its canvas colour
const exportVars = () => Object.entries(themeVars(themeKey(), isDark())).map(([k, v]) => `--${k}: ${v};`).join(' ');

async function exportMarkup() {
  const bb = contentBounds(30);
  if (!bb) return null;
  const fonts = await embeddedFontCss();
  return {
    bb,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${bb.w}" height="${bb.h}" viewBox="${bb.x} ${bb.y} ${bb.w} ${bb.h}"` +
      `><style>${fonts}svg { ${exportVars()} }${DIAGRAM_CSS}</style>` +
      `<rect x="${bb.x}" y="${bb.y}" width="${bb.w}" height="${bb.h}" style="fill: var(--canvas)"/>${diagramMarkup(false)}</svg>`,
  };
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// files are named after the tab: "School database" → school-database.svg
const exportName = ext => ((activeDoc()?.name ?? 'diagram').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'diagram') + '.' + ext;

async function exportSvg() {
  const m = await exportMarkup();
  if (!m) return toast('Nothing to export yet');
  const name = exportName('svg');
  download(new Blob([m.svg], { type: 'image/svg+xml' }), name);
  toast(`Saved ${name}`);
}
// The diagram as a PNG at 2× (for crisp slides)
async function pngBlob() {
  const m = await exportMarkup();
  if (!m) return null;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(m.svg);
  await img.decode();
  const k = 2, c = document.createElement('canvas');
  c.width = m.bb.w * k;
  c.height = m.bb.h * k;
  const ctx = c.getContext('2d');
  ctx.scale(k, k);
  ctx.drawImage(img, 0, 0);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
async function exportPng() {
  const b = await pngBlob();
  if (!b) return toast('Nothing to export yet');
  const name = exportName('png');
  download(b, name);
  toast(`Saved ${name}`);
}
// Copy the PNG to the clipboard, for pasting into slides. The blob is handed over as a
// promise so Safari still counts it as part of the click.
async function copyImage() {
  if (!model.tables.length) return toast('Nothing to copy yet');
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
    toast('Image copied to clipboard');
  } catch {
    toast('Could not copy. Use Export → PNG image instead.');
  }
}
