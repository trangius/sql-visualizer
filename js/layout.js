'use strict';

// ─── Layout: where the boxes go ──────────────────────────────────────────────
// Placing a single new table (the others stay put) uses a cost function; "Auto layout"
// arranges whole groups in columns instead (below).
// Cost of a spot = estimated length of its arrows
//                + a big penalty for arrows through boxes (or the box covering arrows)
//                + a penalty for crossing other arrows, and for tiny jogs (rows almost level)
//                + a small pull toward the rest of the diagram
//                + growth of the diagram's longer side (relative to the canvas shape), so it
//                  becomes a compact block instead of one long row.

const LAYOUT = { GAP_X: 60, GAP_Y: 40, STEP: 20, THROUGH_BOX: 600, CROSSING: 80, PULL: 0.15, GROW: 0.8, JOG: 60, WORK: 3e6 };

// Width / height of the canvas; the diagram should roughly take that shape
function canvasAspect() {
  const r = svg.getBoundingClientRect();
  return r.width && r.height ? Math.min(2.5, Math.max(0.8, r.width / r.height)) : 1.5;
}

// FK arrows between different tables, with row offsets inside each box
function layoutEdges(tables) {
  const out = [];
  for (const t of tables) {
    shownCols(t).forEach((c, i) => {
      if (!c.target || c.target === t) return;
      out.push({ from: t, to: c.target, fy: rowY(i), ty: rowY(shownCols(c.target).indexOf(c.targetCol)) });
    });
  }
  return out;
}

// The route an arrow will roughly take, using the router's choice of sides: three segments
function estimateRoute(a, fy, b, ty) {
  const e = { a, b, sy: a.y + fy, ty: b.y + ty };
  chooseSides(e);
  // same direction in and out: through the gap between the boxes; otherwise a loop on one side
  const mid = e.outDir === e.inDir ? (e.sx + e.tx) / 2 : e.outDir === 1 ? Math.min(e.sx, e.tx) : Math.max(e.sx, e.tx);
  const segs = [[e.x1, e.sy, mid, e.sy], [mid, e.sy, mid, e.ty], [mid, e.ty, e.x2, e.ty]];
  return { segs, len: Math.abs(e.x1 - mid) + Math.abs(e.sy - e.ty) + Math.abs(mid - e.x2) };
}

function segHitsRect([x1, y1, x2, y2], r) {
  if (y1 === y2) return y1 > r.y && y1 < r.y + r.h && Math.max(x1, x2) > r.x && Math.min(x1, x2) < r.x + r.w;
  return x1 > r.x && x1 < r.x + r.w && Math.max(y1, y2) > r.y && Math.min(y1, y2) < r.y + r.h;
}

function segsCross(s, u) {
  const sh = s[1] === s[3], uh = u[1] === u[3];
  if (sh === uh) { // parallel: only counts when they run along the same line
    if (sh) return s[1] === u[1] && Math.max(s[0], s[2]) > Math.min(u[0], u[2]) && Math.min(s[0], s[2]) < Math.max(u[0], u[2]);
    return s[0] === u[0] && Math.max(s[1], s[3]) > Math.min(u[1], u[3]) && Math.min(s[1], s[3]) < Math.max(u[1], u[3]);
  }
  const [h, v] = sh ? [s, u] : [u, s];
  return h[1] > Math.min(v[1], v[3]) && h[1] < Math.max(v[1], v[3]) && v[0] > Math.min(h[0], h[2]) && v[0] < Math.max(h[0], h[2]);
}

const tooClose = (a, b) =>
  a.x < b.x + b.w + LAYOUT.GAP_X && a.x + a.w + LAYOUT.GAP_X > b.x &&
  a.y < b.y + b.h + LAYOUT.GAP_Y && a.y + a.h + LAYOUT.GAP_Y > b.y;

const centerOf = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const rectsTouch = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function bboxOf(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Best free spot for table t, given the boxes already placed (Map table → rect).
// anchor: where an unconnected table should go (defaults to the middle of what's placed).
// It looks around each table t is linked to (not over the whole stretch between two that
// stand far apart), only at spots in line with the columns, and stops after WORK comparisons.
function bestSpot(t, placed, dims, edges, anchor = null) {
  const { w, h } = dims.get(t);
  const mine = edges.filter(e => (e.from === t && placed.has(e.to)) || (e.to === t && placed.has(e.from)));
  const rects = [...placed.values()];
  if (!rects.length) return { x: snap((anchor?.x ?? 40 + w / 2) - w / 2), y: snap((anchor?.y ?? 40 + h / 2) - h / 2), cost: 0 };
  const otherSegs = edges
    .filter(e => e.from !== t && e.to !== t && placed.has(e.from) && placed.has(e.to))
    .flatMap(e => estimateRoute(placed.get(e.from), e.fy, placed.get(e.to), e.ty).segs);

  const linked = [...new Set(mine.map(e => placed.get(e.from === t ? e.to : e.from)))];
  const all = bboxOf(rects), aspect = canvasAspect();
  const extent = (x0, y0, x1, y1) => Math.max(x1 - x0, (y1 - y0) * aspect);
  const extent0 = extent(all.x, all.y, all.x + all.w, all.y + all.h);
  const pullTo = linked.length ? centerOf(bboxOf(linked)) : anchor ?? centerOf(all);
  const pull = linked.length ? LAYOUT.PULL : 1;
  // In a column the table stands at its left edge; outside the columns, a channel away from
  // them; never half in one, where it would be in the way of the column's arrows
  const { cols } = boxColumns([...rects].sort((p, q) => p.x - q.x || p.y - q.y));
  const inLine = x => {
    const close = cols.filter(c => x < c.xr + ROUTE.CH_MIN && x + w > c.xl - ROUTE.CH_MIN);
    return close.length > 1 ? null : close.length ? close[0].xl : x;
  };

  let best = { cost: Infinity }, work = LAYOUT.WORK;
  // besides the grid, try the heights where an arrow's two rows are exactly level (a straight arrow)
  const levelYs = mine.map(e => e.from === t ? placed.get(e.to).y + e.ty - e.fy : placed.get(e.from).y + e.fy - e.ty);
  for (let grow = 1; grow <= 8 && best.cost === Infinity && work > 0; grow *= 2) {
    const mx = (w + 200) * grow, my = (h + 200) * grow;
    for (const around of linked.length ? linked : [anchor ? { x: anchor.x, y: anchor.y, w: 0, h: 0 } : all]) {
      // only what reaches into the searched area can cost anything
      const reach = LAYOUT.GAP_X, area = { x: around.x - mx - reach, y: around.y - my - reach, w: around.w + 2 * (mx + reach), h: around.h + 2 * (my + reach) };
      const nearRects = rects.filter(r => rectsTouch(r, area));
      const nearSegs = otherSegs.filter(([x1, y1, x2, y2]) =>
        Math.min(x1, x2) < area.x + area.w && Math.max(x1, x2) > area.x && Math.min(y1, y2) < area.y + area.h && Math.max(y1, y2) > area.y);
      const cost = (x, y) => {
        const me = { x, y, w, h };
        for (const r of nearRects) if (tooClose(me, r)) return Infinity;
        let c = 0;
        for (const e of mine) {
          const a = e.from === t ? me : placed.get(e.from), b = e.to === t ? me : placed.get(e.to);
          const route = estimateRoute(a, e.fy, b, e.ty);
          c += route.len;
          const dy = Math.abs(a.y + e.fy - (b.y + e.ty));
          if (dy > 0 && dy < 24) c += LAYOUT.JOG;
          for (const s of route.segs) {
            for (const r of nearRects) if (r !== a && r !== b && segHitsRect(s, r)) c += LAYOUT.THROUGH_BOX;
            for (const u of nearSegs) if (segsCross(s, u)) c += LAYOUT.CROSSING;
          }
        }
        for (const u of nearSegs) if (segHitsRect(u, me)) c += LAYOUT.THROUGH_BOX;
        const m = centerOf(me);
        const grown = extent(Math.min(x, all.x), Math.min(y, all.y), Math.max(x + w, all.x + all.w), Math.max(y + h, all.y + all.h)) - extent0;
        return c + pull * (Math.abs(m.x - pullTo.x) + Math.abs(m.y - pullTo.y)) + LAYOUT.GROW * grown;
      };
      // (a spot outside the area would be judged without the boxes it is close to)
      const x0 = around.x - mx, x1 = around.x + around.w + mx - w, y0 = around.y - my, y1 = around.y + around.h + my - h;
      const xs = new Set(), ys = levelYs.filter(y => y >= y0 && y <= y1);
      for (let x = snap(x0); x <= x1; x += LAYOUT.STEP) {
        const at = inLine(x);
        if (at !== null && at >= x0 && at <= x1) xs.add(at);
      }
      for (let y = snap(y0); y <= y1; y += LAYOUT.STEP) ys.push(y);
      for (const x of xs) {
        for (const y of ys) {
          if ((work -= nearRects.length + (3 * mine.length + 1) * (nearRects.length + nearSegs.length) + 1) < 0) break;
          const c = cost(x, y);
          if (c < best.cost) best = { x, y, cost: c };
        }
      }
    }
  }
  if (best.cost === Infinity) best = { x: snap(all.x + all.w + LAYOUT.GAP_X * 2), y: snap(all.y), cost: 0 }; // nowhere free nearby: to the right of everything
  return best;
}

// ─── Auto layout ────────────────────────────────────────────────────────────
// A layered layout, as dot, dagre and ELK do it. Per group of connected tables: layers from
// the FKs (referenced tables to the right), a lane in every column a line passes, the order
// in each column by sweeping until few lines cross, heights by lining rows up with the rows
// they point to. FK direction is a start, not a rule: a hub's leaf tables wrap into strips
// on both sides of it, and a table whose neighbours share a column may change sides.
// There are no candidate layouts and no routing in here. Every step is integer arithmetic
// and every tie falls back to name order, so the same boxes and links give the same diagram
// on any screen, and in Squill, which runs the same steps (test/fixtures/layout_golden.txt).
const AUTO = {
  COL_GAP: 90, ROW_GAP: 50, GROUP_GAP: 120, GRID: 10,
  LANE_H: 18, LANE_GAP: 10, LANE_SEP: 2,          // a lane (a line passing a column), its gap to a table and to another lane
  LAYER: 2048,                                    // a layer's key is layer · LAYER + strip
  CAP_MIN: 900,                                   // no hub wraps below a screenful
  GAP_MAX: 800,                                   // the hole that lining two rows up may hold open
  ORDER_WORK: 6000, STARTS_MAX: 16, SWEEPS: 12, BIG: 3000,
  MOVE_BUDGET: 2e6,
  NEW_BATCH: 8,                                   // more new tables than this at once are laid out as a block
};
const tableOrder = (a, b) => byBytes(a.name, b.name);
const gridUp = v => Math.ceil(v / AUTO.GRID) * AUTO.GRID;
// Math.sqrt alone can be one off for a big number; other implementations must get the same
function isqrt(v) {
  let r = Math.floor(Math.sqrt(v));
  while (r * r > v) r--;
  while ((r + 1) * (r + 1) <= v) r++;
  return r;
}

function arrangeAll(tables, dims) {
  if (!tables.length) return;
  moveTo(layoutTables(tables, dims), tables.map(t => pos[t.name]).filter(Boolean));
}

// Many new tables at once (a pasted block of them) are laid out together and put right of
// the diagram, instead of each looking for a spot of its own
function arrangeBeside(fresh, placed, dims) {
  const bb = bboxOf(placed.map(t => ({ ...pos[t.name], ...dims.get(t) }))), block = layoutTables(fresh, dims);
  const dx = gridUp(bb.x + bb.w + AUTO.GROUP_GAP), dy = snap(bb.y);
  for (const [t, r] of block) pos[t.name] = { x: r.x + dx, y: r.y + dy };
}

// Map table → rect for these tables, by the links among them (Data view draws no arrows:
// there every table stands alone). Their top-left corner is 0, 0.
function layoutTables(tables, dims) {
  tables = [...tables].sort(tableOrder);
  const index = new Map(tables.map((t, i) => [t, i]));
  const links = state.dataView ? [] : layoutEdges(tables).filter(e => index.has(e.to))
    .map(e => ({ from: index.get(e.from), to: index.get(e.to), fy: e.fy, ty: e.ty }))
    .sort((a, b) => a.from - b.from || a.fy - b.fy || a.to - b.to || a.ty - b.ty);
  const boxes = tables.map(t => dims.get(t)), spots = layoutBoxes(boxes, links, Math.round(100 * canvasAspect()));
  return new Map(tables.map((t, i) => [t, { ...spots[i], w: boxes[i].w, h: boxes[i].h }]));
}

// Keep the diagram where it was on the canvas; a brand new one goes in the middle of the view
function moveTo(placed, old) {
  const bb = bboxOf([...placed.values()]), mid = viewCenter();
  const origin = old.length ? bboxOf(old.map(p => ({ ...p, w: 0, h: 0 })))
    : mid ? { x: mid.x - bb.w / 2, y: mid.y - bb.h / 2 } : { x: 40, y: 40 };
  const dx = snap(origin.x - bb.x), dy = snap(origin.y - bb.y);
  for (const [t, r] of placed) pos[t.name] = { x: r.x + dx, y: r.y + dy };
}

// Top-left corners for boxes [{ w, h }] in name order, joined by links [{ from, to, fy, ty }]
// (indices, and the two rows' heights inside their boxes) sorted by (from, fy, to, ty).
// aspectQ: the shape to fill, width / height in hundredths.
function layoutBoxes(boxes, links, aspectQ) {
  const n = boxes.length, joined = Array.from({ length: n }, () => []);
  for (const l of links) { joined[l.from].push(l.to); joined[l.to].push(l.from); }
  const group = new Int32Array(n).fill(-1), local = new Int32Array(n), groups = [];
  for (let s = 0; s < n; s++) {
    if (group[s] >= 0) continue;
    const ids = [s];
    group[s] = groups.length;
    for (let i = 0; i < ids.length; i++) for (const v of joined[ids[i]]) if (group[v] < 0) { group[v] = groups.length; ids.push(v); }
    ids.sort((a, b) => a - b).forEach((t, i) => local[t] = i);
    groups.push({ ids, links: [] });
  }
  for (const l of links) groups[group[l.from]].links.push({ from: local[l.from], to: local[l.to], fy: l.fy, ty: l.ty });

  // L9: the groups on shelves, tallest first, then the single tables on shelves below
  const blocks = [], singles = [];
  let area = 0;
  for (const g of groups) {
    if (g.ids.length === 1) {
      const b = boxes[g.ids[0]];
      singles.push({ id: g.ids[0], w: b.w, h: b.h });
      area += (b.w + AUTO.COL_GAP) * (b.h + AUTO.ROW_GAP);
    } else {
      const b = layoutGroup(g.ids.map(t => boxes[t]), g.links, aspectQ);
      blocks.push({ ...b, ids: g.ids });
      area += (b.w + AUTO.GROUP_GAP) * (b.h + AUTO.GROUP_GAP);
    }
  }
  let width = isqrt(Math.floor(area * aspectQ / 100)), x = 0, y = 0, tall = 0;
  for (const b of blocks) width = Math.max(width, b.w);
  const spots = new Array(n);
  blocks.sort((a, b) => b.h - a.h || a.ids[0] - b.ids[0]);
  for (const b of blocks) {
    if (x && x + b.w > width) { x = 0; y += gridUp(tall + AUTO.GROUP_GAP); tall = 0; }
    b.ids.forEach((t, i) => spots[t] = { x: x + b.x[i], y: y + b.y[i] });
    x += gridUp(b.w + AUTO.GROUP_GAP);
    tall = Math.max(tall, b.h);
  }
  // The single tables in rows of as many as fit, each under the one above: columns as wide
  // as their widest table, so the router finds columns there too
  singles.sort((a, b) => b.h - a.h || a.id - b.id);
  const widest = singles.reduce((m, s) => Math.max(m, s.w), 0), across = Math.max(1, Math.floor((width + AUTO.COL_GAP) / (widest + AUTO.COL_GAP)));
  const wide = new Array(across).fill(0);
  singles.forEach((s, i) => wide[i % across] = Math.max(wide[i % across], s.w));
  if (blocks.length) y += gridUp(tall + AUTO.GROUP_GAP);
  singles.forEach((s, i) => {
    if (i % across === 0) { y += i ? gridUp(tall + AUTO.ROW_GAP) : 0; x = 0; tall = 0; }
    spots[s.id] = { x, y };
    x += gridUp(wide[i % across] + AUTO.COL_GAP);
    tall = Math.max(tall, s.h);
  });
  return spots;
}

// One group of connected tables: x and y per table from the group's own top-left, and its size
function layoutGroup(boxes, links, aspectQ) {
  const n = boxes.length, near = Array.from({ length: n }, () => new Set());
  for (const l of links) { near[l.from].add(l.to); near[l.to].add(l.from); }
  let area = 0;
  for (const b of boxes) area += (b.w + AUTO.COL_GAP) * (b.h + AUTO.ROW_GAP);
  const cap = Math.max(AUTO.CAP_MIN, isqrt(Math.floor(area * 100 / aspectQ)));
  const key = tableLayers(n, links).map(l => l * AUTO.LAYER);
  wrapHubs(boxes, links, near, key, cap);
  evenSides(boxes, near, key, cap);
  let best = placeLayers(boxes, links, key);
  // L7: once more with the tables that changed sides, kept only if it is better
  if (moveOneSided(boxes, links, near, key, best, cap)) {
    const again = placeLayers(boxes, links, key);
    if (again.crossings < best.crossings || (again.crossings === best.crossings && again.cost < best.cost)) best = again;
  }
  return best;
}

// L1. A table's layer: how far it is, along the FKs, from a table that references nothing
// (layer 0, drawn rightmost). A reference that closes a cycle is turned around for this.
function tableLayers(n, links) {
  const out = Array.from({ length: n }, () => []);
  links.forEach((l, i) => out[l.from].push(i));
  const mark = new Uint8Array(n), next = new Int32Array(n), turned = new Uint8Array(links.length), stack = []; // mark 1: on the walk's stack
  for (let s = 0; s < n; s++) {
    if (mark[s]) continue;
    mark[s] = 1;
    stack.push(s);
    while (stack.length) {
      const t = stack[stack.length - 1];
      if (next[t] === out[t].length) { mark[t] = 2; stack.pop(); continue; }
      const i = out[t][next[t]++], to = links[i].to;
      if (mark[to] === 1) turned[i] = 1;
      else if (!mark[to]) { mark[to] = 1; stack.push(to); }
    }
  }
  const refs = Array.from({ length: n }, () => []), referrers = Array.from({ length: n }, () => []);
  links.forEach((l, i) => {
    const [a, b] = turned[i] ? [l.to, l.from] : [l.from, l.to];
    refs[a].push(b);
    referrers[b].push(a);
  });
  const layer = new Array(n).fill(0), open = refs.map(r => r.length), queue = [];
  for (let t = 0; t < n; t++) if (!open[t]) queue.push(t);
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q];
    for (const r of referrers[t]) {
      layer[r] = Math.max(layer[r], layer[t] + 1);
      if (--open[r] === 0) queue.push(r);
    }
  }
  // a table with more referrers than references moves next to its nearest referrer: shorter lines
  const pulled = [];
  for (let t = 0; t < n; t++) if (new Set(referrers[t]).size > new Set(refs[t]).size) pulled.push(t);
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    pulled.sort((a, b) => layer[a] - layer[b] || a - b);
    for (const t of pulled) {
      let to = Infinity;
      for (const r of referrers[t]) to = Math.min(to, layer[r] - 1);
      if (to > layer[t]) { layer[t] = to; moved = true; }
    }
    if (!moved) break;
  }
  return layer;
}

// L2. A layer taller than cap: a hub's leaf tables (one neighbour) there, when they are more
// than a column by themselves, go into strips next to the hub, on both sides of it. Their
// lines are one bus, so the strips cross nothing. Wrapping smaller groups tangles trees.
function wrapHubs(boxes, links, near, key, cap) {
  const n = boxes.length, tall = v => boxes[v].h + AUTO.ROW_GAP;
  const load = new Map(), rowAtHub = new Int32Array(n);
  for (let v = 0; v < n; v++) load.set(key[v], (load.get(key[v]) ?? 0) + tall(v));
  for (const l of links) {
    if (near[l.from].size === 1) rowAtHub[l.from] = l.ty;
    if (near[l.to].size === 1) rowAtHub[l.to] = l.fy;
  }
  for (const [layer, sum] of [...load].sort((a, b) => a[0] - b[0])) {
    if (sum <= cap) continue;
    const leaves = new Map(); // hub → its leaf tables in this layer
    for (let v = 0; v < n; v++) {
      if (key[v] !== layer || near[v].size !== 1) continue;
      const [hub] = near[v];
      if (near[hub].size === 1) continue; // two tables on their own
      if (!leaves.has(hub)) leaves.set(hub, []);
      leaves.get(hub).push(v);
    }
    for (const [hub, list] of leaves) {
      const total = list.reduce((s, v) => s + tall(v), 0);
      if (total <= cap) continue;
      const strips = Math.ceil(total / cap), side = Math.sign(layer - key[hub]);
      list.sort((a, b) => rowAtHub[a] - rowAtHub[b] || a - b);
      let before = 0;
      for (const v of list) {
        const s = Math.min(strips - 1, Math.floor((2 * before + tall(v)) * strips / (2 * total)));
        key[v] = key[hub] + (s % 2 ? -side : side) * ((s >> 1) + 1);
        before += tall(v);
      }
    }
  }
}

// L2b. A layer that is still taller than cap: a table there whose neighbours all stand in one
// layer changes to that layer's other side, if nothing of theirs is in its way there and
// that side stays the lighter one. So the tables that reference Users, say, stand on both
// sides of it: the diagram gets wider instead of taller, and no line longer.
function evenSides(boxes, near, key, cap) {
  const n = boxes.length, tall = v => boxes[v].h + AUTO.ROW_GAP, load = new Map(), changed = new Uint8Array(n);
  for (let v = 0; v < n; v++) load.set(key[v], (load.get(key[v]) ?? 0) + tall(v));
  for (const layer of [...load.keys()].sort((a, b) => a - b)) {
    if (layer % AUTO.LAYER) continue; // a strip is as full as it should be
    for (let v = 0; v < n && load.get(layer) > cap; v++) {
      const beside = [...near[v]], L = key[beside[0]], other = 2 * L - layer;
      if (key[v] !== layer || L % AUTO.LAYER || beside.some(u => key[u] !== L)) continue;
      // in its way: anything else its neighbours have on that side, but for tables that changed sides before it
      if (beside.some(u => [...near[u]].some(w => !changed[w] && Math.sign(key[w] - L) === Math.sign(other - L)))) continue;
      if ((load.get(other) ?? 0) + tall(v) > load.get(layer) - tall(v)) continue;
      load.set(layer, load.get(layer) - tall(v));
      load.set(other, (load.get(other) ?? 0) + tall(v));
      key[v] = other;
      changed[v] = 1;
    }
  }
}

// L3–L5 and L8 for one choice of layers: columns, lanes, order, heights, x
function placeLayers(boxes, links, key) {
  const g = laneGraph(boxes, links, key), n = g.tables, C = g.keys.length;
  orderColumns(g);
  mergeLanes(g);
  const { tops, cost } = rowHeights(g);
  // L8: a column is as wide as its widest table; a channel widens with the vertical runs it will hold
  const wide = new Array(C).fill(0), left = new Array(C).fill(0);
  for (let v = 0; v < n; v++) wide[g.col[v]] = Math.max(wide[g.col[v]], boxes[v].w);
  for (let c = 1; c < C; c++) {
    left[c] = left[c - 1] + gridUp(wide[c - 1] + Math.max(AUTO.COL_GAP, 2 * ROUTE.STUB + ROUTE.TRACK * (trunkDepth(g.channels[c - 1], tops) + 1)));
  }
  let h = 0;
  for (let v = 0; v < n; v++) h = Math.max(h, tops[v] + boxes[v].h);
  return { g, tops, x: boxes.map((_, v) => left[g.col[v]]), y: boxes.map((_, v) => tops[v]), w: left[C - 1] + wide[C - 1], h, crossings: g.crossings, cost };
}

// The most row lines whose vertical runs overlap in one channel
function trunkDepth(channel, tops) {
  const spans = new Map();
  for (const s of channel) {
    const a = tops[s.l] + s.lo, b = tops[s.r] + s.ro, span = spans.get(s.line);
    if (a === b) continue;
    if (span) { span[0] = Math.min(span[0], a, b); span[1] = Math.max(span[1], a, b); }
    else spans.set(s.line, [Math.min(a, b), Math.max(a, b)]);
  }
  const ends = [...spans.values()].flatMap(([lo, hi]) => [[lo, 1], [hi, -1]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let depth = 0, most = 0;
  for (const [, d] of ends) most = Math.max(most, depth += d);
  return most;
}

// L3. Columns from the layer keys (the highest leftmost), and a lane in every column a link
// passes. Links from the tables of one column to the same row share their lanes: one row line.
// Nodes are the tables, then the lanes as created; a segment joins two nodes of neighbouring
// columns: { l, lo, r, ro, line } = left node and the height inside it, the same on the right.
function laneGraph(boxes, links, key) {
  const keys = [...new Set(key)].sort((a, b) => b - a), colOfKey = new Map(keys.map((k, i) => [k, i])), C = keys.length;
  const g = { keys, tables: boxes.length, col: [], h: [], line: [], channels: keys.slice(1).map(() => []) };
  boxes.forEach((b, v) => { g.col.push(colOfKey.get(key[v])); g.h.push(b.h); g.line.push(-1); });
  const lines = new Map(), chains = new Map(), MID = AUTO.LANE_H / 2;
  const join = (u, uo, v, vo, line) => g.col[u] < g.col[v]
    ? g.channels[g.col[u]].push({ l: u, lo: uo, r: v, ro: vo, line })
    : g.channels[g.col[v]].push({ l: v, lo: vo, r: u, ro: uo, line });
  for (const e of links) {
    const a = g.col[e.from], b = g.col[e.to], d = Math.sign(b - a), row = e.to + ':' + e.ty;
    if (!lines.has(row)) lines.set(row, lines.size);
    const line = lines.get(row);
    if (a + d === b) { join(e.from, e.fy, e.to, e.ty, line); continue; }
    const chain = line * C + a;
    if (!chains.has(chain)) {
      chains.set(chain, g.col.length);
      for (let c = a + d; c !== b; c += d) {
        const lane = g.col.length;
        g.col.push(c); g.h.push(AUTO.LANE_H); g.line.push(line);
        if (c !== a + d) join(lane - 1, MID, lane, MID, line);
      }
      join(g.col.length - 1, MID, e.to, e.ty, line);
    }
    join(e.from, e.fy, chains.get(chain), MID, line);
  }
  joinNodes(g);
  return g;
}

// Which nodes each node is joined to in the column on its left and on its right. part: how
// far down the other node the line ends, 0…4095, so places inside a node compare as integers.
function joinNodes(g) {
  const part = (v, off) => Math.floor(4095 * off / g.h[v]);
  g.left = g.col.map(() => []);
  g.right = g.col.map(() => []);
  for (const channel of g.channels) for (const s of channel) {
    s.lp = part(s.l, s.lo);
    s.rp = part(s.r, s.ro);
    g.right[s.l].push({ node: s.r, at: s.lo, to: s.ro, part: s.rp });
    g.left[s.r].push({ node: s.l, at: s.ro, to: s.lo, part: s.lp });
  }
}

// Pairs i < j with a[i] > a[j] among the first n of a, by merge sort (a is reordered)
function inversions(a, spare, n) {
  let count = 0;
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n - width; lo += 2 * width) {
      const mid = lo + width, hi = Math.min(lo + 2 * width, n);
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) {
        if (a[i] <= a[j]) spare[k++] = a[i++];
        else { spare[k++] = a[j++]; count += mid - i; }
      }
      while (i < mid) spare[k++] = a[i++];
      while (j < hi) spare[k++] = a[j++];
      for (k = lo; k < hi; k++) a[k] = spare[k];
    }
  }
  return count;
}

// L4. The order inside each column: the one with the fewest crossings (then the fewest lanes)
// that a number of starts and sweeps find. Sets g.cols and g.crossings.
function orderColumns(g) {
  const total = g.col.length, n = g.tables, C = g.keys.length;
  const index = new Int32Array(total), slot = new Int32Array(total);
  let cols;
  // adjacent lanes of one row line will merge, so they count as one place (slot) in the column
  const sameLane = (u, v) => u >= n && v >= n && g.line[u] === g.line[v];
  const number = col => {
    let s = -1;
    col.forEach((v, i) => {
      index[v] = i;
      if (!i || !sameLane(col[i - 1], v)) s++;
      slot[v] = s;
    });
  };
  const place = a => slot[a.node] * 4096 + a.part;
  // tables that hang on one lane spread above and below it
  const laneInMiddle = run => {
    const lanes = run.filter(v => v >= n), tables = run.filter(v => v < n), half = tables.length >> 1;
    return lanes.length && tables.length ? [...tables.slice(0, half), ...lanes, ...tables.slice(half)] : run;
  };

  // Start k: a walk from every table in name order, beginning at another table each time and
  // every odd one backwards, so connected tables start out next to each other
  const start = (k, starts) => {
    const back = k % 2 === 1, first = Math.floor((k >> 1) * n / Math.ceil(starts / 2)), seen = new Uint8Array(total);
    cols = Array.from({ length: C }, () => []);
    for (let i = 0; i < n; i++) {
      const at = (first + i) % n, s = back ? n - 1 - at : at;
      if (seen[s]) continue;
      seen[s] = 1;
      const stack = [s];
      while (stack.length) {
        const v = stack.pop();
        cols[g.col[v]].push(v);
        const next = [...g.left[v], ...g.right[v]].map(a => a.node).filter(o => !seen[o]).sort((a, b) => back ? a - b : b - a);
        for (const o of next) if (!seen[o]) { seen[o] = 1; stack.push(o); }
      }
    }
    cols.forEach(number);
  };

  // A column takes the order of where its lines end on one side (side: g.left or g.right).
  // Nodes with nothing on that side stay where they are.
  const sum = new Float64Array(total), count = new Int32Array(total);
  const sweep = (c, side, flip) => {
    const col = cols[c], moving = col.filter(v => side[v].length);
    for (const v of moving) {
      let s = 0;
      for (const a of side[v]) s += place(a);
      sum[v] = s;
      count[v] = side[v].length;
    }
    // means compared as fractions: sum[u] / count[u] against sum[v] / count[v]
    const sorted = [...moving].sort((u, v) => sum[u] * count[v] - sum[v] * count[u] || (flip ? index[v] - index[u] : index[u] - index[v]));
    for (let i = 0, j; i < sorted.length; i = j) {
      for (j = i + 1; j < sorted.length && sum[sorted[i]] * count[sorted[j]] === sum[sorted[j]] * count[sorted[i]]; j++);
      if (j > i + 1) laneInMiddle(sorted.slice(i, j)).forEach((v, k) => sorted[i + k] = v);
    }
    moving.map(v => index[v]).forEach((at, k) => col[at] = sorted[k]);
    number(col);
  };

  // Lines of different rows that cross between two columns; lines to one row meet, they don't cross
  const shared = g.channels.map(channel => {
    const byLine = new Map();
    for (const s of channel) (byLine.get(s.line) ?? byLine.set(s.line, []).get(s.line)).push(s);
    return [...byLine.values()].filter(list => list.length > 1);
  });
  let leftKey = new Float64Array(0), rightKey = leftKey, spare = leftKey, by = new Int32Array(0);
  const crossed = segs => {
    const k = segs.length;
    if (k < 2) return 0;
    if (leftKey.length < k) { leftKey = new Float64Array(2 * k); rightKey = new Float64Array(2 * k); spare = new Float64Array(2 * k); by = new Int32Array(2 * k); }
    for (let i = 0; i < k; i++) { leftKey[i] = slot[segs[i].l] * 4096 + segs[i].lp; spare[i] = slot[segs[i].r] * 4096 + segs[i].rp; by[i] = i; }
    by.subarray(0, k).sort((a, b) => leftKey[a] - leftKey[b] || spare[a] - spare[b]);
    for (let i = 0; i < k; i++) rightKey[i] = spare[by[i]];
    return inversions(rightKey, spare, k);
  };
  const crossings = () => {
    let x = 0;
    g.channels.forEach((channel, c) => {
      x += crossed(channel);
      for (const own of shared[c]) x -= crossed(own);
    });
    return x;
  };
  const laneCount = () => {
    let k = 0;
    for (const col of cols) col.forEach((v, i) => { if (v >= n && !(i && sameLane(col[i - 1], v))) k++; });
    return k;
  };

  // Two neighbours in a column swap when that uncrosses more of their own lines than it crosses
  const swapGain = (u, v) => {
    let gain = 0;
    for (const side of [g.left, g.right]) {
      if (side[u].length * side[v].length > 4096) continue;
      for (const p of side[u]) for (const q of side[v]) gain += Math.sign(place(p) - place(q));
    }
    return gain;
  };
  const transpose = passes => {
    for (let pass = 0; pass < passes; pass++) {
      let better = false;
      for (const col of cols) {
        let swapped = false;
        for (let i = 0; i + 1 < col.length; i++) {
          if (swapGain(col[i], col[i + 1]) > 0) { [col[i], col[i + 1]] = [col[i + 1], col[i]]; swapped = true; }
        }
        if (swapped) { number(col); better = true; }
      }
      if (!better) break;
    }
  };

  let size = total;
  for (const channel of g.channels) size += channel.length;
  const starts = Math.max(2, Math.min(AUTO.STARTS_MAX, Math.floor(AUTO.ORDER_WORK / size)));
  const big = size > AUTO.BIG, sweeps = big ? AUTO.SWEEPS / 2 : AUTO.SWEEPS, passes = big ? 1 : 3;
  let best = null;
  const keep = () => {
    const x = crossings();
    if (best && x > best.x) return false;
    const lanes = laneCount();
    if (best && x === best.x && lanes >= best.lanes) return false;
    best = { x, lanes, cols: cols.map(col => [...col]) };
    return true;
  };
  for (let k = 0; k < starts && !(best && !best.x); k++) {
    start(k, starts);
    transpose(passes);
    keep();
    for (let it = 0, stale = 0; it < sweeps && stale < 4; it++) {
      const flip = it >= sweeps / 2;
      if (it % 2 === 0) for (let c = 1; c < C; c++) sweep(c, g.left, flip);
      else for (let c = C - 2; c >= 0; c--) sweep(c, g.right, flip);
      transpose(passes);
      stale = keep() ? 0 : stale + 1;
    }
  }
  cols = best.cols;
  cols.forEach(number);

  // Fans: neighbours in a column that all hang on one row (or lane) of one side, the tables
  // among them joined to nothing on the other. The lane goes in their middle, so a bus runs
  // through the middle of its tables.
  const hangsOn = (v, side) => {
    const a = side[v];
    if (!a.length) return -1;
    const k = place(a[0]);
    return a.every(e => place(e) === k) ? k : -1;
  };
  for (const col of cols) {
    for (const [side, other] of [[g.left, g.right], [g.right, g.left]]) {
      for (let i = 0, j; i < col.length; i = j) {
        const k = hangsOn(col[i], side);
        for (j = i + 1; k >= 0 && j < col.length && hangsOn(col[j], side) === k; j++);
        const run = col.slice(i, j);
        if (run.every(v => v >= n || !other[v].length)) laneInMiddle(run).forEach((v, q) => col[i + q] = v);
      }
      number(col);
    }
  }
  g.cols = cols;
  g.crossings = crossings();
}

// Lanes of one row line that ended up next to each other become one lane
function mergeLanes(g) {
  const n = g.tables, into = g.col.map((_, v) => v);
  g.cols = g.cols.map(col => {
    const kept = [];
    for (const v of col) {
      const last = kept[kept.length - 1];
      if (kept.length && v >= n && last >= n && g.line[v] === g.line[last]) into[v] = last;
      else kept.push(v);
    }
    return kept;
  });
  g.channels = g.channels.map(channel => {
    const seen = new Set();
    return channel.filter(s => {
      s.l = into[s.l];
      s.r = into[s.r];
      const k = s.l + ':' + s.lo + ':' + s.r + ':' + s.ro;
      return !seen.has(k) && seen.add(k);
    });
  });
  joinNodes(g);
}

// L5. Heights, by Brandes and Köpf's method with rows for ports: a node is lined up with
// one of its middle neighbours in the column before (its row level with the row it is joined
// to), the chains that makes are packed upward, and the best of four runs is kept: columns
// left to right or right to left, packed from the top or from the bottom.
function rowHeights(g) {
  let best = null;
  for (const forward of [true, false]) for (const flip of [false, true]) {
    const tops = alignRows(g, forward, flip);
    // twice the lines' height differences, plus the height of it all
    let cost = 0, lo = Infinity, hi = -Infinity;
    for (const channel of g.channels) for (const s of channel) cost += 2 * Math.abs(tops[s.l] + s.lo - tops[s.r] - s.ro);
    for (let v = 0; v < g.tables; v++) { lo = Math.min(lo, tops[v]); hi = Math.max(hi, tops[v] + g.h[v]); }
    cost += hi - lo;
    if (!best || cost < best.cost) best = { tops: tops.map(v => v - lo), cost };
  }
  return best;
}

function alignRows(g, forward, flip) {
  const total = g.col.length, n = g.tables, h = g.h;
  const cols = (forward ? g.cols : [...g.cols].reverse()).map(col => flip ? [...col].reverse() : col);
  const before = forward ? g.left : g.right, after = forward ? g.right : g.left;
  const index = new Int32Array(total);
  for (const col of cols) col.forEach((v, i) => index[v] = i);
  const at = (v, off) => flip ? gridUp(h[v]) - off : off;
  const gap = (p, q) => p >= n && q >= n ? AUTO.LANE_SEP : p >= n || q >= n ? AUTO.LANE_GAP : AUTO.ROW_GAP;
  const pitch = (p, q) => gridUp(h[p] + gap(p, q)); // from p's top to the top of q right below it

  // A lane stays straight: a table's line that crosses a lane's run from one column to the
  // next is not lined up (Brandes and Köpf's type 1 conflict)
  const crossed = new Set();
  for (let c = 1; c < cols.length; c++) {
    const col = cols[c], last = cols[c - 1].length - 1;
    let k0 = -1, l = 0;
    for (let l1 = 0; l1 < col.length; l1++) {
      const v = col[l1];
      let inner = -1;
      if (v >= n) for (const a of before[v]) if (a.node >= n) inner = index[a.node];
      if (l1 < col.length - 1 && inner < 0) continue;
      const k1 = inner >= 0 ? inner : last + 1;
      for (; l <= l1; l++) {
        const w = col[l];
        for (const a of before[w]) {
          if (!(w >= n && a.node >= n) && (index[a.node] < k0 || index[a.node] > k1)) crossed.add(a.node * total + w);
        }
      }
      k0 = k1;
    }
  }

  // up[v]: the node in the column before that v is level with, delta[v]: v's top below its top.
  // v must be one of u's middle neighbours too (not in Brandes and Köpf): that puts a hub
  // level with the middle of its fan instead of with its first table.
  const byPlace = (a, b) => index[a.node] - index[b.node] || at(a.node, a.to) - at(b.node, b.to);
  const middles = list => {
    const sorted = [...list].sort(byPlace), k = sorted.length - 1;
    return [sorted[k >> 1], sorted[(k + 1) >> 1]];
  };
  const middleOf = after.map(list => list.length ? middles(list).map(a => a.node) : []);
  const up = new Int32Array(total).fill(-1), delta = new Int32Array(total);
  for (let c = 1; c < cols.length; c++) {
    let reach = -1;
    for (const v of cols[c]) {
      if (!before[v].length) continue;
      for (const a of middles(before[v])) {
        const u = a.node;
        if (up[v] >= 0 || !middleOf[u].includes(v) || crossed.has(u * total + v) || reach >= index[u]) continue;
        up[v] = u;
        delta[v] = at(u, a.to) - at(v, a.at);
        reach = index[u];
      }
    }
  }

  const root = new Int32Array(total), shift = new Int32Array(total), top = new Int32Array(total), y = new Int32Array(total), room = new Int32Array(total);
  for (let round = 0; ; round++) {
    // chains, then every chain as high as the nodes above its members allow (longest path)
    for (const col of cols) for (const v of col) {
      if (up[v] >= 0) { root[v] = root[up[v]]; shift[v] = shift[up[v]] + delta[v]; }
      else { root[v] = v; shift[v] = 0; }
    }
    const below = new Array(total), waits = new Int32Array(total), queue = [];
    for (const col of cols) for (let i = 1; i < col.length; i++) {
      const p = col[i - 1], q = col[i];
      (below[root[p]] ??= []).push(root[q], shift[p] + pitch(p, q) - shift[q]);
      waits[root[q]]++;
    }
    top.fill(0);
    for (let v = 0; v < total; v++) if (root[v] === v && !waits[v]) queue.push(v);
    for (let i = 0; i < queue.length; i++) {
      const b = queue[i], list = below[b] ?? [];
      for (let k = 0; k < list.length; k += 2) {
        const r = list[k];
        top[r] = Math.max(top[r], top[b] + list[k + 1]);
        if (--waits[r] === 0) queue.push(r);
      }
    }
    for (let v = 0; v < total; v++) y[v] = top[root[v]] + shift[v];
    if (round === 3) break;
    // A chain that holds one table far below the table above it is cut there: one bent line
    // instead of a hole in the column. A lane's own run is never cut.
    for (const col of cols) col.forEach((v, i) => room[v] = i ? y[v] - y[col[i - 1]] - pitch(col[i - 1], v) : -1);
    let cuts = 0;
    for (let v = 0; v < total; v++) {
      const u = up[v];
      if (u < 0 || room[u] < 0 || room[v] < 0 || (u >= n && v >= n)) continue;
      if ((room[u] > AUTO.GAP_MAX) !== (room[v] > AUTO.GAP_MAX)) { up[v] = -1; cuts++; }
    }
    if (!cuts) break;
  }

  // A chain with room below moves down toward the rows it is joined to, the lowest chains first
  const members = new Map(), under = new Int32Array(total).fill(-1);
  for (let v = 0; v < total; v++) (members.get(root[v]) ?? members.set(root[v], []).get(root[v])).push(v);
  for (const col of cols) for (let i = 0; i + 1 < col.length; i++) under[col[i]] = col[i + 1];
  for (const r of [...members.keys()].sort((a, b) => top[b] - top[a] || a - b)) {
    let slack = Infinity;
    const wants = [];
    for (const v of members.get(r)) {
      if (under[v] >= 0) slack = Math.min(slack, y[under[v]] - y[v] - pitch(v, under[v]));
      for (const side of [g.left, g.right]) for (const a of side[v]) {
        if (root[a.node] !== r) wants.push(y[a.node] + at(a.node, a.to) - y[v] - at(v, a.at));
      }
    }
    if (!wants.length || slack <= 0) continue;
    wants.sort((a, b) => a - b);
    const move = Math.floor(Math.min(wants[(wants.length - 1) >> 1], slack) / AUTO.GRID) * AUTO.GRID;
    if (move > 0) for (const v of members.get(r)) y[v] += move;
  }
  return flip ? y.map((v, i) => -(v + gridUp(h[i]))) : y;
}

// L6. A table whose neighbours all stand in one column may sit better on that column's other
// side (A — [C, D] — B), and a table with one neighbour in a strip of its own right next to
// it. Judged on the first result by the crossings and bends of the table's own lines.
// Changes key for the tables that move and returns how many did.
function moveOneSided(boxes, links, near, key, placed, cap) {
  const n = boxes.length, g = placed.g, y = placed.tops, keys = g.keys;
  const mine = Array.from({ length: n }, () => []), own = Array.from({ length: n }, () => []);
  links.forEach((l, i) => { mine[l.from].push(i); mine[l.to].push(i); });
  // every line between two columns as (height on the left, height on the right), under the key of the column on its left
  const channels = new Map(), nodes = new Map(), load = new Map();
  const channel = k => channels.get(k) ?? channels.set(k, []).get(k);
  g.channels.forEach((segs, c) => {
    for (const s of segs) {
      const line = { a: y[s.l] + s.lo, b: y[s.r] + s.ro, l: s.l, r: s.r, line: s.line, gone: false };
      channel(keys[c]).push(line);
      for (const v of [s.l, s.r]) if (v < n) own[v].push([channel(keys[c]), line]);
    }
  });
  g.cols.forEach((col, c) => nodes.set(keys[c], col.map(v => ({ y0: y[v], y1: y[v] + g.h[v], v }))));
  for (let v = 0; v < n; v++) load.set(key[v], (load.get(key[v]) ?? 0) + boxes[v].h + AUTO.ROW_GAP);
  let budget = AUTO.MOVE_BUDGET, moved = 0;
  // how many lines of a channel a line from height a on its left to b on its right would cross
  const crossing = (list, a, b, skip, line) => {
    budget -= list.length;
    let x = 0;
    for (const s of list) if (!s.gone && s.l !== skip && s.r !== skip && s.line !== line && (s.a - a) * (s.b - b) < 0) x++;
    return x;
  };
  const isFree = (k, y0, y1) => !(nodes.get(k) ?? []).some(it => {
    const gap = it.v >= n ? AUTO.LANE_GAP : AUTO.ROW_GAP;
    return y0 < it.y1 + gap && y1 + gap > it.y0;
  });
  const locked = new Uint8Array(n);
  const order = [...Array(n).keys()].sort((a, b) => near[a].size - near[b].size || a - b);
  for (const v of order) {
    if (budget <= 0) break;
    if (locked[v]) continue;
    const ns = [...near[v]], L = key[ns[0]], h = boxes[v].h;
    if (ns.some(u => key[u] !== L)) continue;
    let nowX = 0, nowBends = 0;
    for (const [list, s] of own[v]) {
      nowX += crossing(list, s.a, s.b, v, s.line);
      if (s.a !== s.b) nowBends += 2;
    }
    if (!nowX && !nowBends) continue;
    const lines = mine[v].map(i => links[i]).map(e => e.from === v ? { my: e.fy, other: y[e.to] + e.ty } : { my: e.ty, other: y[e.from] + e.fy });
    const wants = lines.map(e => e.other - e.my).sort((a, b) => a - b), level = wants[(wants.length - 1) >> 1];
    const bends = lines.reduce((s, e) => s + (level + e.my !== e.other ? 2 : 0), 0);
    const side = Math.sign(key[v] - L), li = keys.indexOf(L), options = []; // side 1: left of its neighbours
    for (const s of [side, -side]) {
      // the layer next to L on that side, a new outermost one if there is none
      const next = s > 0 ? (li > 0 ? keys[li - 1] : L + AUTO.LAYER) : (li < keys.length - 1 ? keys[li + 1] : L - AUTO.LAYER);
      const isNew = !nodes.has(next);
      if (next !== key[v] && (isNew || 4 * (load.get(next) + h + AUTO.ROW_GAP) <= 5 * cap)) {
        const list = channels.get(s > 0 ? next : L) ?? [];
        let x = 0;
        for (const e of lines) x += s > 0 ? crossing(list, level + e.my, e.other, v, -2) : crossing(list, e.other, level + e.my, v, -2);
        // without room at that height it would be pushed aside: it can then only win on crossings
        options.push({ x, bends: isNew || isFree(next, level, level + h) ? bends : Infinity, cols: isNew ? 1 : 0, key: next });
      }
      if (ns.length === 1 && key[v] !== L + s) {
        // a strip of its own: in front of its neighbour's other lines on that side it would bend them
        const hub = ns[0], exists = nodes.has(L + s);
        let blocked = 0;
        for (const i of mine[hub]) {
          const e = links[i], o = e.from === hub ? e.to : e.from, py = y[hub] + (e.from === hub ? e.fy : e.ty);
          if (o !== v && Math.sign(key[o] - L) === s && py > level - AUTO.LANE_GAP && py < level + h + AUTO.LANE_GAP) blocked += 2;
        }
        options.push({ x: 0, bends: !exists || isFree(L + s, level, level + h) ? blocked : Infinity, cols: exists ? 0 : 1, key: L + s });
      }
    }
    let best = { x: nowX, bends: nowBends, cols: 0, key: key[v] };
    for (const o of options) {
      if (o.cols && o.x >= nowX) continue; // a new column only to undo a crossing
      if (o.x < best.x || (o.x === best.x && (o.bends < best.bends || (o.bends === best.bends && o.cols < best.cols)))) best = o;
    }
    if (best.key === key[v]) continue;
    for (const [, s] of own[v]) s.gone = true;
    const from = nodes.get(key[v]);
    from.splice(from.findIndex(it => it.v === v), 1);
    load.set(key[v], load.get(key[v]) - h - AUTO.ROW_GAP);
    key[v] = best.key;
    load.set(key[v], (load.get(key[v]) ?? 0) + h + AUTO.ROW_GAP);
    if (!nodes.has(key[v])) nodes.set(key[v], []);
    nodes.get(key[v]).push({ y0: level, y1: level + h, v });
    // exact only when the new layer is next to L; a strip's lines are short and straight
    for (const e of lines) {
      channel(Math.max(key[v], L)).push(key[v] > L ? { a: level + e.my, b: e.other, l: v, r: -1, line: -3, gone: false } : { a: e.other, b: level + e.my, l: -1, r: v, line: -3, gone: false });
    }
    locked[v] = 1;
    for (const u of ns) locked[u] = 1;
    moved++;
  }
  return moved;
}

// Which tables t is connected to; when this changes, a floating table is placed again
function linkSignature(t, tables) {
  const s = new Set();
  for (const c of t.cols) if (c.target && c.target !== t) s.add('>' + c.target.name + '.' + c.targetCol.name);
  for (const o of tables) for (const c of o.cols) if (c.target === t && o !== t) s.add('<' + o.name + '.' + c.targetCol.name);
  return [...s].sort().join(',');
}
