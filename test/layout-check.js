'use strict';

// Run: node test/layout-check.js            checks the layout and the routes of every schema in
//                                           layout-corpus.js, their time, and fixtures/layout_golden.txt
//      node test/layout-check.js --write    writes that file after a wanted change
//      node test/layout-check.js --fuzz 2500    more random schemas and drags than the usual few
// The boxes are 190 wide and 50 + 30 a row here, whatever the fonts, so that Squill, which
// runs the same layout, gets the same golden file.
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const api = require('./layout-load')();
const corpus = require('./layout-corpus')(api.EXAMPLES), { scrambled, long, moved } = require('./layout-corpus');
const FUZZ = process.argv.includes('--fuzz') ? +process.argv[process.argv.indexOf('--fuzz') + 1] : 120;
const GOLDEN = path.join(__dirname, 'fixtures/layout_golden.txt');
const BOX_W = 190, boxH = t => 50 + 30 * api.shownCols(t).length;
let checks = 0;

function model(src) {
  const m = api.parseText(src);
  m.problems.push(...api.resolve(m.tables));
  assert.equal(m.problems.filter(p => p.level === 'error').length, 0, JSON.stringify(m.problems));
  api.markShown(m.tables);
  return m.tables;
}
const ms = since => Number(process.hrtime.bigint() - since) / 1e6;
function clearSpots() {
  for (const name of Object.keys(api.pos)) delete api.pos[name];
}
// Auto layout, then the routes
function draw(nodes, dims) {
  let started = process.hrtime.bigint();
  api.arrangeAll(nodes, dims);
  const layoutMs = ms(started);
  const boxes = new Map(nodes.map(t => [t, { ...api.pos[t.name], ...dims.get(t) }]));
  started = process.hrtime.bigint();
  const edges = api.diagramEdges(nodes, boxes), { searched } = api.routeEdges(edges, [...boxes.values()]);
  checks++;
  return { nodes, boxes, edges, searched, layoutMs, routeMs: ms(started) };
}
// The routes again, for the tables where they stand now (dragged there by the test); before:
// what the last call for the same tables kept, to go on from
function reroute(r, before = null) {
  const boxes = new Map(r.nodes.map(t => [t, { ...api.pos[t.name], w: r.boxes.get(t).w, h: r.boxes.get(t).h }])), edges = api.diagramEdges(r.nodes, boxes);
  return { nodes: r.nodes, boxes, edges, ...api.routeEdges(edges, [...boxes.values()], null, before) };
}
// ...call after call, as the page does frame after frame, until no arrow waits for its search
function settle(r) {
  let q = reroute(r), calls = 1;
  for (; q.waiting; calls++) q = reroute(r, q.kept);
  return { ...q, calls };
}
function run(src, { aspect = 1.5, notation = 'arrows', keysOnly = false, measured = false } = {}) {
  Object.assign(api.canvas, { width: 1000 * aspect, height: 1000 });
  Object.assign(api.state, { notation, keysOnly });
  clearSpots();
  const nodes = model(src);
  return draw(nodes, new Map(nodes.map(t => [t, measured ? api.measureTable(t) : { w: BOX_W, h: boxH(t) }])));
}

// What a diagram is judged by, from the boxes and the corners of the drawn routes
function metrics({ boxes, edges }) {
  const rects = [...boxes.values()].sort((a, b) => a.x - b.x);
  const m = { tables: rects.length, lines: edges.length, overlaps: 0, hits: 0, crossings: 0, shared: 0, bends: 0, length: 0, longest: 0 };
  rects.forEach((a, i) => {
    for (let k = i + 1; k < rects.length && rects[k].x < a.x + a.w; k++) if (a.y < rects[k].y + rects[k].h && rects[k].y < a.y + a.h) m.overlaps++;
  });
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
  m.width = Math.max(...rects.map(r => r.x + r.w)) - x0;
  m.height = Math.max(...rects.map(r => r.y + r.h)) - y0;
  const stretches = { h: new Map(), v: new Map() };
  for (const e of edges) {
    const p = api.simplify(e.points);
    let len = 0;
    for (let i = 1; i < p.length; i++) {
      const [ax, ay] = p[i - 1], [bx, by] = p[i], level = ay === by, key = (level ? ay : ax) + ' ' + e.to;
      len += Math.abs(bx - ax) + Math.abs(by - ay);
      const s = level ? { at: ay, a: Math.min(ax, bx), b: Math.max(ax, bx), to: e.to } : { at: ax, a: Math.min(ay, by), b: Math.max(ay, by), to: e.to };
      const list = stretches[level ? 'h' : 'v'];
      (list.get(key) ?? list.set(key, []).get(key)).push(s);
    }
    m.bends += p.length - 2;
    m.length += len;
    m.longest = Math.max(m.longest, len);
  }
  // arrows to one row that run along each other are one line there, crossed once
  const joined = lists => [...lists.values()].flatMap(list => {
    const out = [];
    for (const s of list.sort((p, q) => p.a - q.a)) {
      const last = out[out.length - 1];
      if (last && s.a <= last.b) last.b = Math.max(last.b, s.b);
      else out.push(s);
    }
    return out;
  });
  const H = joined(stretches.h), V = joined(stretches.v);
  // lines through tables
  for (const s of H) for (const r of rects) { if (r.x >= s.b) break; if (s.at > r.y && s.at < r.y + r.h && s.a < r.x + r.w) m.hits++; }
  for (const s of V) for (const r of rects) { if (r.x >= s.at) break; if (s.at < r.x + r.w && s.b > r.y && s.a < r.y + r.h) m.hits++; }
  // Crossings: a horizontal and a vertical stretch of different row lines that cut through
  // each other. A sweep over x with the open horizontals' heights in a Fenwick tree.
  const ys = [...new Set(H.map(s => s.at))].sort((a, b) => a - b), rank = new Map(ys.map((y, i) => [y, i + 1]));
  const tree = new Int32Array(ys.length + 1);
  const add = (i, d) => { for (; i < tree.length; i += i & -i) tree[i] += d; };
  const sum = i => { let s = 0; for (; i > 0; i -= i & -i) s += tree[i]; return s; };
  const below = (v, orAt) => { let lo = 0, hi = ys.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ys[mid] < v || (orAt && ys[mid] === v)) lo = mid + 1; else hi = mid; } return lo; };
  // at one x: horizontals end, then verticals count, then horizontals start (only cuts strictly inside count)
  const events = [...H.flatMap(s => [[s.a, 2, s], [s.b, 0, s]]), ...V.map(s => [s.at, 1, s])].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const sameLine = new Map();
  for (const [, kind, s] of events) {
    if (kind === 1) m.crossings += sum(below(s.b, false)) - sum(below(s.a, true));
    else add(rank.get(s.at), kind - 1);
  }
  for (const s of H) (sameLine.get(s.to) ?? sameLine.set(s.to, []).get(s.to)).push(s);
  for (const v of V) for (const h of sameLine.get(v.to) ?? []) if (h.at > v.a && h.at < v.b && v.at > h.a && v.at < h.b) m.crossings--;
  // different row lines lying on each other
  for (const segs of [H, V]) {
    segs.sort((p, q) => p.at - q.at || p.a - q.a);
    segs.forEach((s, i) => {
      for (let k = i + 1; k < segs.length && segs[k].at === s.at && segs[k].a < s.b; k++) if (segs[k].to !== s.to) m.shared += Math.min(s.b, segs[k].b) - segs[k].a;
    });
  }
  return m;
}

// The least distance between two upright stretches of different row lines that run beside
// each other; a track if none are nearer
function trunksApart({ edges }) {
  const upright = edges.flatMap(e => {
    const p = api.simplify(e.points);
    return p.slice(1).flatMap(([x, y], i) => x === p[i][0] ? [{ x, a: Math.min(y, p[i][1]), b: Math.max(y, p[i][1]), to: e.to }] : []);
  }).sort((p, q) => p.x - q.x);
  let least = api.ROUTE.TRACK;
  upright.forEach((s, i) => {
    for (let k = i + 1; k < upright.length && upright[k].x - s.x < least; k++) {
      const o = upright[k];
      if (o.x > s.x && o.to !== s.to && Math.min(s.b, o.b) > Math.max(s.a, o.a)) least = o.x - s.x;
    }
  });
  return least;
}

function validate(r, name) {
  const rects = [...r.boxes.values()], m = metrics(r);
  for (const b of rects) assert([b.x, b.y].every(v => Number.isFinite(v) && v % 10 === 0), `${name}: a table off the grid`);
  assert.equal(m.overlaps, 0, `${name}: overlapping tables`);
  assert.equal(m.hits, 0, `${name}: a line through a table`);
  assert.equal(m.shared, 0, `${name}: lines to different rows on each other`);
  for (const e of r.edges) {
    const first = e.points[0], last = e.points[e.points.length - 1];
    assert(first[1] === e.sy && (first[0] === e.a.x || first[0] === e.a.x + e.a.w), `${name}: ${e.from} leaves the wrong port`);
    assert(last[1] === e.ty && (last[0] === e.b.x || last[0] === e.b.x + e.b.w), `${name}: ${e.from} enters the wrong port`);
    assert(!/NaN|Infinity/.test(e.d), `${name}: invalid SVG for ${e.from}`);
    for (let i = 1; i < e.points.length; i++) assert(e.points[i - 1][0] === e.points[i][0] || e.points[i - 1][1] === e.points[i][1], `${name}: ${e.from} is not orthogonal`);
  }
  return m;
}
const spots = r => {
  const x0 = Math.min(...[...r.boxes.values()].map(b => b.x)), y0 = Math.min(...[...r.boxes.values()].map(b => b.y));
  return [...r.boxes].map(([t, b]) => [t.name, b.x - x0, b.y - y0]).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
};
const backwards = src => src.trim().split(/\n(?=\S)/).reverse().join('\n');
// FNV-1a over "name x y\n" for the tables in name order, from the diagram's top-left
function spotsHash(r) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(spots(r).map(s => s.join(' ') + '\n').join(''))) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// Each table's group of linked tables, by the first table in it; ends: each link's two tables
function linkedGroups(n, ends) {
  const group = Array.from({ length: n }, (_, i) => i), top = v => { while (group[v] !== v) v = group[v]; return v; };
  for (const [p, q] of ends) { const a = top(p), b = top(q); group[Math.max(a, b)] = Math.min(a, b); }
  for (let i = 0; i < n; i++) group[i] = top(i);
  return group;
}
// How near a table comes to the box around a group of linked tables it is not in: the router routes them together
// when that is less than ROUTE.NEAR
function groupsApart({ boxes, edges }) {
  const all = [...boxes.values()], index = new Map(all.map((b, i) => [b, i]));
  const group = linkedGroups(all.length, edges.map(e => [index.get(e.a), index.get(e.b)])), count = new Array(all.length).fill(0);
  for (const g of group) count[g]++;
  let least = Infinity;
  for (let g = 0; g < all.length; g++) {
    if (count[g] < 2) continue;
    const mine = all.filter((_, i) => group[i] === g);
    const x0 = Math.min(...mine.map(b => b.x)), y0 = Math.min(...mine.map(b => b.y)), x1 = Math.max(...mine.map(b => b.x + b.w)), y1 = Math.max(...mine.map(b => b.y + b.h));
    all.forEach((b, i) => { if (group[i] !== g) least = Math.min(least, Math.max(b.x - x1, x0 - (b.x + b.w), b.y - y1, y0 - (b.y + b.h))); });
  }
  return least;
}

// What holds after Auto layout, of any schema: a valid diagram on the grid, drawn without the search, its groups of
// linked tables at least AUTO.GROUP_GAP from every table outside them, the same whatever order the tables are
// declared in, unchanged by a second Auto layout
function sound(text, options, name) {
  const r = run(text, options), m = validate(r, name);
  for (const b of r.boxes.values()) assert(b.x % api.AUTO.SNAP === 0 && b.y % api.AUTO.SNAP === 0, `${name}: a table off the grid after Auto layout`);
  assert.equal(r.searched, 0, `${name}: an arrow needed the search`);
  const apart = groupsApart(r);
  assert(apart >= api.AUTO.GROUP_GAP, `${name}: a table ${apart} from a group of tables it is not in`);
  const again = draw(r.nodes, new Map([...r.boxes].map(([t, b]) => [t, { w: b.w, h: b.h }])));
  assert.deepEqual(spots(again), spots(r), `${name}: a second Auto layout moves tables`);
  assert.deepEqual(spots(run(backwards(text), options)), spots(r), `${name}: the order the tables are declared in changes the layout`);
  return { r, m };
}

// Every schema of the corpus: sound at three canvas shapes, in time, and as the golden file says
const golden = [];
console.log('schema         tables lines crossings bends/line  mean longest       size  layout   route ms');
for (const { name, text, limit, crosses, rows } of corpus) {
  for (const aspect of [0.8, 2.25, 1.5]) {
    const { r, m } = sound(text, { aspect }, name);
    if (!crosses) assert.equal(m.crossings, 0, `${name}: lines cross`);
    if (rows) assert.equal(trunksApart(r), api.ROUTE.TRACK, `${name}: trunks squeezed into a channel`);
    if (aspect !== 1.5) continue;
    let layoutMs = r.layoutMs, routeMs = r.routeMs;
    for (let i = 0; i < 4; i++) {
      const t = run(text);
      layoutMs = Math.min(layoutMs, t.layoutMs);
      routeMs = Math.min(routeMs, t.routeMs);
    }
    console.log(name.padEnd(14), String(m.tables).padStart(6), String(m.lines).padStart(5), String(m.crossings).padStart(9), (m.bends / m.lines).toFixed(2).padStart(10),
      String(Math.round(m.length / m.lines)).padStart(5), String(m.longest).padStart(7), `${m.width}x${m.height}`.padStart(10), layoutMs.toFixed(1).padStart(7), routeMs.toFixed(1).padStart(7));
    assert(layoutMs + routeMs < limit, `${name}: ${(layoutMs + routeMs).toFixed(1)} ms, the limit is ${limit}`);
    golden.push([name, m.tables, m.lines, m.crossings, m.bends, m.length, m.longest, m.width, m.height, spotsHash(r)].join(' '));
  }
}
// And one arranged by hand, so the golden file covers the arrows that are searched for: shop,
// moved as layout-corpus.js says, routed until no arrow waits. That is what a search without
// a limit finds (checked further down), so its line does not depend on how work is counted.
{
  const r = run(corpus.find(s => s.name === 'shop').text);
  for (const [name, x, y] of moved(spots(r))) api.pos[name] = { x, y };
  const q = settle(r), m = validate(q, 'shop_moved');
  assert(q.searched > 10, 'shop_moved: hardly an arrow is searched for');
  golden.push(['shop_moved', m.tables, m.lines, m.crossings, m.bends, m.length, m.longest, m.width, m.height, spotsHash(q)].join(' '));
}
if (process.argv.includes('--write')) fs.writeFileSync(GOLDEN, golden.join('\n') + '\n');
else assert.equal(golden.join('\n') + '\n', fs.readFileSync(GOLDEN, 'utf8'), 'the layout changed: compare with test/fixtures/layout_golden.txt, then --write');

// The real box sizes, every notation (some spread the arrow ends), keys only
for (const notation of ['arrows', 'uml', 'ratio', 'crowsfoot']) {
  for (const keysOnly of [false, true]) {
    for (const name of ['rental', 'shop', 'store']) sound(corpus.find(s => s.name === name).text, { notation, keysOnly, measured: true }, `${name} as ${notation}`);
  }
}
// Arrows that are one foreign key over a key's columns get a line under their table, "fk (A, B) -> T", which the box
// makes room for: here two, to one key
{
  const text = 'City\n  Name\n  Country\n  pk (Name, Country)\nRoute\n  Id\n  FromName -> City.Name\n  ToName -> City.Name\n' +
    '  FromCountry -> City.Country\n  ToCountry -> City.Country\n';
  for (const notation of ['arrows', 'crowsfoot']) sound(text, { notation, measured: true }, `fks over a key as ${notation}`);
  const route = model(text).find(t => t.name === 'Route'), groups = route.fkGroups, size = n => { route.fkGroups = groups.slice(0, n); return api.measureTable(route); };
  const [none, one, two] = [0, 1, 2].map(size);
  assert(groups.length === 2 && one.w > none.w && two.h > one.h && one.h > none.h, 'fks over a key: their lines have no room in the box');
}
// Indexes: a dim idx after the flags of a column with an index of its own, and an index (A, B) line under its table for
// one over several, which the box makes room for; with the Indexes toggle off, neither
{
  const text = 'Owner\n  Id\nVisit\n  Id\n  AVeryLongPetIdentifierColumn index\n  Day\n  Room\n  Code unique\n  OwnerId -> Owner\n  index (Day, Room)\n';
  for (const indexes of [true, false]) {
    api.state.indexes = indexes;
    for (const notation of ['arrows', 'crowsfoot']) sound(text, { notation, measured: true }, `indexes ${indexes ? 'shown' : 'hidden'} as ${notation}`);
  }
  const visit = model(text).find(t => t.name === 'Visit'), size = on => { api.state.indexes = on; return api.measureTable(visit); };
  const [off, on] = [false, true].map(size);
  assert.deepEqual([on.rows[1].flags, on.rows[1].idx, off.rows[1].flags, on.rows[4].flags], ['idx', true, '', 'unique'], 'idx is not where it belongs');
  assert(on.w > off.w && on.h > off.h, 'indexes: idx and the index line have no room in the box');
  assert.equal(api.footLines(visit).filter(f => f.index).map(f => f.label + ' ' + f.text).join(), 'index (Day, Room)');
  api.state.indexes = false;
  assert.equal(api.footLines(visit).filter(f => f.index).length, 0, 'an index line with the toggle off');
  api.state.indexes = true;
}
// A foreign key over several columns is one arrow, routed as one line (its trunk) from between its rows to between
// those they point to; at either end its rows' lines fold into it and split from it, each pair the other's mirror
// image about the trunk, all within a stub of the box; the layout links it once, there
const PAIRED = 'Line\n  OrderNo int\n  LineNo int\n  pk (OrderNo, LineNo)\n\nNote\n  Id\n  OrderNo -> Line.OrderNo\n  LineNo -> Line.LineNo\n';
const same = (p, q) => p[0] === q[0] && p[1] === q[1];
// The tables at these spots, 190 wide, routed
function placed(text, at, notation = 'arrows') {
  api.state.notation = notation;
  const nodes = model(text), boxes = new Map(nodes.map(t => [t, { ...at[t.name], w: BOX_W, h: boxH(t) }])), edges = api.diagramEdges(nodes, boxes);
  const routed = api.routeEdges(edges, [...boxes.values()]);
  api.state.notation = 'arrows';
  return { nodes, boxes, edges, ...routed };
}
{
  for (const notation of ['arrows', 'crowsfoot', 'uml']) sound(PAIRED, { notation, measured: true }, `fk over a key as ${notation}`);
  const nodes = model(PAIRED), { links } = api.layoutInput(nodes, new Map(nodes.map(t => [t, { w: BOX_W, h: boxH(t) }])));
  assert.deepEqual(links.map(l => [l.fy, l.ty]), [[104, 74]], 'fk over a key: not one link between its rows');
  const r = placed(PAIRED, { Note: { x: 0, y: 0 }, Line: { x: 400, y: 0 } }), e = r.edges[0], p = api.simplify(e.points), n = p.length;
  assert(r.edges.length === 1 && e.sy === 104 && e.ty === 74 && e.to === 'Line.(OrderNo, LineNo)', 'fk over a key: not one arrow between its rows');
  assert(same(p[0], [BOX_W, 104]) && same(p[n - 1], [400, 74]) && r.searched === 0, `fk over a key: the trunk runs ${JSON.stringify(p)}`);
  const fold = e.trunk[0], split = e.trunk[e.trunk.length - 1];
  assert(fold[1] === 104 && fold[0] > BOX_W && fold[0] <= BOX_W + api.ROUTE.STUB && fold[0] < p[1][0], `fk over a key: it folds at ${fold}`);
  assert(split[1] === 74 && split[0] < 400 && split[0] >= 400 - api.ROUTE.STUB && split[0] > p[n - 2][0], `fk over a key: it splits at ${split}`);
  assert(e.folds.length === 2 && e.splits.length === 2, 'fk over a key: not a line per row');
  e.folds.forEach((l, i) => assert(same(l[0], [BOX_W, 89 + 30 * i]) && same(l[l.length - 1], fold), `fk over a key: row ${i} folds in by ${JSON.stringify(l)}`));
  e.splits.forEach((l, i) => assert(same(l[0], split) && same(l[l.length - 1], [400, 59 + 30 * i]), `fk over a key: row ${i} splits off by ${JSON.stringify(l)}`));
  const [f0, f1] = e.folds, [s0, s1] = e.splits;
  assert(f0.length === 4 && f0[1][0] === f1[1][0] && 104 - f0[1][1] === f1[1][1] - 104 && s0[2][0] === s1[2][0] && 74 - s0[2][1] === s1[2][1] - 74,
    `fk over a key: not mirrored: ${JSON.stringify([e.folds, e.splits])}`);
  // drawn from where it folds to where it splits, with a circle at each of its rows and an arrowhead at each of the key's
  const svg = api.edgeMarkup(e, true), count = cls => svg.split(`class="${cls}"`).length - 1;
  assert(e.d.startsWith(`M${fold[0]},${fold[1]}`) && e.d.endsWith(`L${split[0]},${split[1]}`), `fk over a key: the trunk is drawn as ${e.d}`);
  assert.deepEqual(['edge', 'edge-hit', 'ahead', 'start'].map(count), [5, 5, 2, 2], 'fk over a key: not a line, a circle and an arrowhead per row');
  // in the crow's foot, the lines run straight past the symbols before they bend, and each row has its symbols
  const crow = placed(PAIRED, { Note: { x: 0, y: 0 }, Line: { x: 400, y: 0 } }, 'crowsfoot').edges[0];
  api.state.notation = 'crowsfoot';
  const crowSvg = api.edgeMarkup(crow, false);
  api.state.notation = 'arrows';
  assert(crow.folds.every(l => l.length === 2 || l[1][0] - BOX_W >= 18) && crow.splits.every(l => l.length === 2 || 400 - l[l.length - 3][0] >= 18), "fk over a key: the crow's foot runs into its bends");
  assert.equal(crowSvg.split('class="sym"').length - 1, 4, "fk over a key: not a crow's foot per row");
  // its labels above its top row and below its bottom one, clear of its lines
  api.state.notation = 'uml';
  const uml = placed(PAIRED, { Note: { x: 0, y: 0 }, Line: { x: 400, y: 0 } }, 'uml');
  api.state.notation = 'uml';
  api.placeLabels(uml.edges);
  api.state.notation = 'arrows';
  uml.edges[0].labels.forEach((l, i) => { const [top, bottom] = i ? [89, 119] : [59, 89]; assert(l.y < top || l.y > bottom, `fk over a key: a label among its rows' lines at ${l.y}`); });
  // two foreign keys to one key share its row line: their lines split into its rows alike
  const two = placed('City\n  Name\n  Country\n  pk (Name, Country)\nRoute\n  Id\n  FromName -> City.Name\n  ToName -> City.Name\n' +
    '  FromCountry -> City.Country\n  ToCountry -> City.Country\n', { Route: { x: 0, y: 0 }, City: { x: 400, y: 0 } });
  assert(two.edges.length === 2 && two.edges[0].to === two.edges[1].to && JSON.stringify(two.edges[0].splits) === JSON.stringify(two.edges[1].splits),
    'two fks to one key: not one row line');
}
// Every arrow takes the colour of the key it points to, as its FK badge has it: one to a primary key that key's, one to
// a unique column that column's, one over several columns that key's (its fk (A, B) -> T line's too); the stretches
// lines share are in theirs, and they point to one row
{
  const nodes = model('T\n  Id\n  Code int unique\n\nU\n  Id\n  TId -> T\n  TCode -> T.Code\n'), [t, u] = nodes;
  const boxes = new Map(nodes.map(o => [o, { x: o === t ? 400 : 0, y: 0, w: BOX_W, h: boxH(o) }])), edges = api.diagramEdges(nodes, boxes);
  api.routeEdges(edges, [...boxes.values()]);
  const [toId, toCode] = ['TId', 'TCode'].map(n => edges.find(e => e.from === 'U.' + n));
  assert(t.hue != null && toId.hue === t.hue && toCode.hue != null && toCode.hue !== t.hue, 'key colours: an arrow not in the colour of the key it points to');
  for (const e of [toId, toCode]) assert.equal(e.hue, u.cols.find(c => 'U.' + c.name === e.from).keyHue, 'key colours: an arrow not in its FK badge\'s colour');
  assert(api.edgeMarkup(toCode, false).startsWith(`<g class="edge-g hued" style="--h:${toCode.hue}"`), 'key colours: an arrow drawn without its colour');
  const paired = model(PAIRED), line = paired.find(o => o.name === 'Line'), note = paired.find(o => o.name === 'Note');
  const e = api.diagramEdges(paired, new Map(paired.map(o => [o, { x: o === line ? 400 : 0, y: 0, w: BOX_W, h: boxH(o) }])))[0];
  assert(line.hue != null && e.hue === line.hue && api.footLines(note).find(f => f.label === 'fk').hue === line.hue, 'key colours: an fk over a key not in the key\'s colour');
  for (const name of ['rental', 'shop', 'store']) {
    const r = run(corpus.find(s => s.name === name).text), shared = api.bundles(r.edges);
    assert(shared.length > 0, `${name}: no lines share a stretch`);
    for (const b of shared) {
      // the lines that run along any of it
      const level = b.y1 === b.y2, on = r.edges.filter(e => api.simplify(e.points).some((q, i, p) => i && (level
        ? q[1] === b.y1 && p[i - 1][1] === b.y1 && Math.min(q[0], p[i - 1][0]) < b.x2 && Math.max(q[0], p[i - 1][0]) > b.x1
        : q[0] === b.x1 && p[i - 1][0] === b.x1 && Math.min(q[1], p[i - 1][1]) < b.y2 && Math.max(q[1], p[i - 1][1]) > b.y1)));
      assert(on.length > 1 && on.every(e => e.hue === b.hue && e.to === on[0].to), `${name}: a shared stretch not in its lines' colour`);
    }
  }
}
// Snap: a dragged table stands on the grid, which is a row's height, so two snapped tables' rows line up and an arrow
// between rows at one height is straight; freed (Option), it goes where the mouse takes it
{
  assert.equal(api.GRID, 30);
  assert.deepEqual(api.dragSpot(13, 47, 100, 50, true), { x: 120, y: 90 }, 'a drag does not snap to the grid');
  assert.deepEqual(api.dragSpot(13, 47, 100, 50, false), { x: 113, y: 97 }, 'a free drag does not go where the mouse takes it');
  assert.deepEqual(api.dragSpot(13, 47, 0, 0, true), { x: 13, y: 47 }, 'a table pressed but not moved leaves its spot');
  const straight = snap => {
    const r = placed('A\n  Id\n  Name vc\n  BId -> B\n\nB\n  Id\n', { A: api.dragSpot(0, 0, 12, 17, snap), B: api.dragSpot(400, 0, 5, 80, snap) });
    return r.edges.length === 1 && api.simplify(r.edges[0].points).length === 2;
  };
  assert(straight(true), 'two snapped tables\' rows do not line up');
  assert(!straight(false), 'dragged freely a few px off, the arrow is straight');
  // With Snap on, a new table beside a laid-out diagram lands on the grid too
  const rental = corpus[0].text;
  run(rental);
  api.state.snap = true;
  const one = model(rental + '\nNote\n  Id\n  ReceiptId -> Receipt');
  api.ensurePositions(one, new Map(one.map(o => [o, { w: BOX_W, h: boxH(o) }])));
  api.state.snap = false;
  assert(api.pos.Note && api.pos.Note.x % api.GRID === 0 && api.pos.Note.y % api.GRID === 0, `a new table with Snap on is off the grid at ${JSON.stringify(api.pos.Note)}`);
}
// Auto layout's spots on the grid (snapLayout), every one on it; each group of linked tables there checked against
// the group as layoutGroup lays it out: left edges in the same order, the same ones equal (columns); of two tables
// over each other the same one on top, and no gap narrower, either way; the lines that were straight still straight
function snappedAsLaidOut(text, name) {
  const nodes = model(text), { boxes, links } = api.layoutInput(nodes, new Map(nodes.map(t => [t, { w: BOX_W, h: boxH(t) }])));
  const snapped = api.layoutBoxes(boxes, links, 150), G = api.AUTO.SNAP, n = boxes.length;
  for (const s of snapped) assert(s.x % G === 0 && s.y % G === 0, `${name}: a table off the grid`);
  // the groups as layoutBoxes takes them apart: their tables in order, numbered in the group, and their links in order
  const group = linkedGroups(n, links.map(l => [l.from, l.to])), local = new Array(n);
  const apart = (a, b, wa, wb) => a <= b ? b - a - wa : a - b - wb;
  for (let g = 0; g < n; g++) {
    if (group[g] !== g) continue;
    const ids = [];
    for (let i = 0; i < n; i++) if (group[i] === g) { local[i] = ids.length; ids.push(i); }
    if (ids.length === 1) continue;
    const sizes = ids.map(i => boxes[i]), groupLinks = links.filter(l => group[l.from] === g).map(l => ({ from: local[l.from], to: local[l.to], fy: l.fy, ty: l.ty }));
    const placed = api.layoutGroup(sizes, groupLinks, 150);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b, p, q] = [{ x: placed.x[i], y: placed.y[i] }, { x: placed.x[j], y: placed.y[j] }, snapped[ids[i]], snapped[ids[j]]];
        assert.equal(Math.sign(b.x - a.x), Math.sign(q.x - p.x), `${name}: two tables no longer in the same order or column`);
        const gapX = apart(a.x, b.x, sizes[i].w, sizes[j].w), gapY = apart(a.y, b.y, sizes[i].h, sizes[j].h);
        if (gapX < 0) assert(Math.sign(b.y - a.y) === Math.sign(q.y - p.y) && apart(p.y, q.y, sizes[i].h, sizes[j].h) >= gapY, `${name}: two tables over each other, closer or turned round`);
        else assert(apart(p.x, q.x, sizes[i].w, sizes[j].w) >= gapX, `${name}: two tables side by side, closer`);
      }
    }
    for (const l of groupLinks) {
      if (placed.y[l.from] + l.fy === placed.y[l.to] + l.ty) assert.equal(snapped[ids[l.from]].y + l.fy, snapped[ids[l.to]].y + l.ty, `${name}: a straight line jogs`);
    }
  }
}
for (const { name, text } of corpus) snappedAsLaidOut(text, name);
for (let seed = 1; seed <= FUZZ / 4; seed++) snappedAsLaidOut(scrambled(seed), `random schema ${seed}`);

// Random schemas, as the boxes of the tests and as the page measures them
for (let seed = 1; seed <= FUZZ; seed++) {
  for (const options of [{}, { measured: true }, { measured: true, notation: 'crowsfoot' }, { measured: true, keysOnly: true, aspect: 0.8 }, { aspect: 2.25, notation: 'uml' }]) {
    sound(scrambled(seed), options, `random schema ${seed} ${JSON.stringify(options)}`);
  }
}
// Random long schemas, whose layers fold into rows
for (let seed = 1; seed <= FUZZ / 4; seed++) {
  for (const options of [{}, { measured: true, aspect: 0.8 }]) sound(long(seed), options, `long schema ${seed} ${JSON.stringify(options)}`);
}
// Data view draws no arrows: the boxes go on shelves
{
  const nodes = model(corpus[0].text);
  clearSpots();
  api.state.dataView = true;
  const r = draw(nodes, new Map(nodes.map(t => [t, { w: 210, h: 175 }])));
  api.state.dataView = false;
  assert.equal(metrics({ boxes: r.boxes, edges: [] }).overlaps, 0, 'data view: overlapping tables');
}
run('');

// The router alone, on boxes no layout made
const box = (x, y, w = 190, h = 110) => ({ x, y, w, h });
function route(boxes, links) {
  const edges = links.map(([from, to, fromRow = 0, toRow = 0]) => ({
    a: boxes[from], b: boxes[to], sy: boxes[from].y + 59 + 30 * fromRow, ty: boxes[to].y + 59 + 30 * toRow, row: boxes[to].y + 59 + 30 * toRow, fromTable: from, from: `${from}.${fromRow}`, to: `${to}.${toRow}`,
  }));
  const r = { boxes: new Map(Object.entries(boxes)), edges, ...api.routeEdges(edges, Object.values(boxes)) };
  validate(r, 'router');
  return r;
}
// a box between two level tables: round it, without the search
{
  const r = route({ A: box(0, 0), B: box(600, 0), wall: box(280, -100, 220, 300) }, [['A', 'B']]);
  assert.equal(r.searched, 0);
}
// Bricks: every box overlaps one of the next row, so they are no columns. The boxes left out
// as obstacles have their arrows searched for, and so has an arrow that would run through
// one; an arrow between two boxes beside each other, rows level, is straight either way.
{
  const r = route({ A: box(0, 0), B: box(300, 0), C: box(600, 0), D: box(150, 200), E: box(450, 200) }, [['A', 'B'], ['B', 'C'], ['D', 'E'], ['A', 'E', 1], ['D', 'A', 1]]);
  assert.equal(r.searched, 3);
  for (const e of r.edges.slice(0, 3)) assert.equal(api.simplify(e.points).length, 2, 'side by side and level, but not straight');
}
// a table dragged onto the channel between two columns: only its own arrow is searched for
{
  const r = route({ A: box(0, 0), B: box(280, 0), dragged: box(140, 160) }, [['A', 'B'], ['dragged', 'B', 1]]);
  assert.equal(r.searched, 1);
  assert.equal(api.simplify(r.edges[0].points).length, 2);
}
// a table dragged a little out of its column: still a column, no search
{
  const r = route({ A: box(0, 0), B: box(280, 0), C: box(340, 160), D: box(620, 0) }, [['A', 'B'], ['A', 'C', 1], ['C', 'D', 1], ['C', 'B', 2]]);
  assert.equal(r.searched, 0);
}
// one table dragged onto another, an arrow's two ends in one place: it still has a path to draw
{
  const boxes = [box(0, 0), box(0, 0)], edges = [{ a: boxes[0], b: boxes[1], sy: 59, ty: 59, row: 59, fromTable: 'A', from: 'A.0', to: 'B.0' }];
  api.routeEdges(edges, boxes);
  assert(api.simplify(edges[0].points).length >= 2 && !/NaN|Infinity|undefined/.test(edges[0].d));
}
// two groups in one channel, and two self-references facing each other: one track each
route({ A: box(0, 0, 190, 140), B: box(280, 300, 190, 140), C: box(0, 190, 190, 140), D: box(280, 490, 190, 140) }, [['A', 'B', 1], ['C', 'D', 1]]);
route({ A: box(0, 0, 230, 140), B: box(320, 30, 190, 140), C: box(-40, 300, 190, 140) }, [['A', 'A', 2], ['B', 'B', 2]]);
// Four rows level two and two, their arrows crossed: whichever trunk stands left, two stubs
// would lie on each other, so one arrow jogs twice. And a loop that ends where a line does.
for (const [boxes, links] of [
  [{ A: box(0, 0, 190, 140), C: box(0, 300, 190, 140), B: box(280, 0, 190, 140), D: box(280, 300, 190, 140) }, [['A', 'B'], ['A', 'D', 2, 1], ['C', 'B', 1, 2]]],
  [{ X: box(-280, 0, 190, 140), A: box(0, 0, 190, 140), B: box(280, 0, 190, 140), Y: box(560, 0, 190, 140) }, [['X', 'A', 1, 1], ['B', 'Y', 1, 1], ['A', 'B', 2], ['B', 'A', 2]]],
  [{ A: box(0, 0, 190, 200), B: box(280, 60, 190, 200) }, [['A', 'B', 3], ['A', 'B', 4, 1], ['B', 'B', 4, 1]]],
]) assert.equal(route(boxes, links).searched, 0);

// Two rows of tables a street apart: the lines that pass a column run in the street, as many as
// there are, and still do when a table of the lower row is dragged up into it
{
  const boxes = Object.fromEntries([0, 1, 2, 3].flatMap(c => [['A' + c, box(280 * c, 0)], ['B' + c, box(280 * c, 210)]]));
  const links = [['A0', 'B2'], ['A0', 'B3', 1], ['B0', 'A2', 0, 1], ['B0', 'A3', 1, 1]];
  const between = r => r.edges.every(e => e.points.every(([, y]) => y >= 0 && y <= 320));
  assert(between(route(boxes, links)), 'rows: a line leaves the street');
  boxes.B1.y -= 40;
  assert(between(route(boxes, links)), 'rows, a table dragged into the street: a line leaves it');
}

// Tables that have a spot keep it: a dragged table stays where it was put, a new table finds
// a spot of its own, many new ones are laid out as a block beside the diagram
{
  const rental = corpus[0].text, r = run(rental), dims = t => ({ w: BOX_W, h: boxH(t) });
  const place = nodes => api.ensurePositions(nodes, new Map(nodes.map(t => [t, dims(t)])));
  api.pos.Price.y += 400;
  const before = structuredClone(api.pos);
  place(r.nodes);
  assert.deepEqual(api.pos, before, 'tables with a spot were moved');
  const one = model(rental + '\nNote\n  Id\n  ReceiptId -> Receipt');
  place(one);
  assert(api.pos.Note.float, 'a new table is not floating');
  for (const name of Object.keys(before)) assert.deepEqual([api.pos[name].x, api.pos[name].y], [before[name].x, before[name].y], `${name} moved for a new table`);
  const many = model(rental + Array.from({ length: api.AUTO.NEW_BATCH + 1 }, (_, i) => `\nNew${i}\n  Id${i ? `\n  PrevId -> New${i - 1}` : ''}`).join(''));
  const right = Math.max(...Object.entries(api.pos).map(([name, p]) => p.x + BOX_W));
  delete api.pos.Note;
  place(many);
  const boxes = new Map(many.map(t => [t, { ...api.pos[t.name], ...dims(t) }]));
  assert.equal(metrics({ boxes, edges: [] }).overlaps, 0, 'a block of new tables overlaps');
  for (const t of many.filter(t => t.name.startsWith('New'))) assert(api.pos[t.name].x >= right + 120 && !api.pos[t.name].float, 'new tables are not a block beside the diagram');
}
// A new table linked to any one table of a diagram, wherever the diagram stands (left of
// and above 0 too): a spot on the grid that is free
for (const name of ['rental', 'shop', 'store', 'four', 'school']) {
  const { text } = corpus.find(s => s.name === name), dims = nodes => new Map(nodes.map(t => [t, { w: BOX_W, h: boxH(t) }]));
  for (const target of model(text).filter(t => t.pkCols.length === 1)) {
    for (const [dx, dy] of [[0, 0], [-300, -400], [-600, 0], [-900, -1200], [-1500, -400]].slice(0, FUZZ > 120 ? 5 : 2)) {
      const r = run(text);
      for (const t of r.nodes) api.pos[t.name] = { x: api.pos[t.name].x + dx, y: api.pos[t.name].y + dy };
      const nodes = model(`${text}\nNote\n  Id\n  A -> ${target.name}`);
      api.ensurePositions(nodes, dims(nodes));
      validate({ boxes: new Map(nodes.map(t => [t, { ...api.pos[t.name], ...dims(nodes).get(t) }])), edges: [] }, `${name}, a new table linked to ${target.name}`);
    }
  }
}
// A new table linked to two tables far apart is placed at once, on a free spot, in line
{
  const { text } = corpus.find(s => s.name === 'random300x3'), dims = nodes => new Map(nodes.map(t => [t, { w: BOX_W, h: boxH(t) }]));
  run(text);
  const nodes = model(text + '\nNote\n  Id\n  A -> T0001\n  B -> T0299'), started = process.hrtime.bigint();
  api.ensurePositions(nodes, dims(nodes));
  assert(ms(started) < 500, `a new table took ${ms(started).toFixed(0)} ms to place`);
  const boxes = new Map(nodes.map(t => [t, { ...api.pos[t.name], ...dims(nodes).get(t) }])), edges = api.diagramEdges(nodes, boxes);
  assert.equal(api.routeEdges(edges, [...boxes.values()]).searched, 0, 'a new table stands out of line');
  validate({ boxes, edges }, 'a new table');
}

// Tables dragged about, never nearer than 40 to each other: every arrow still finds a way that
// touches no table. And tables all nudged a little are still columns: no search.
{
  let seed = 12345;
  const pick = n => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
  for (const name of ['rental', 'shop', 'store', 'heights40']) {
    const { text } = corpus.find(s => s.name === name);
    for (let trial = 0; trial < FUZZ / 2; trial++) {
      const r = run(text, { measured: true }), apart = t => r.nodes.every(o => {
        const a = { ...r.boxes.get(t), ...api.pos[t.name] }, b = { ...r.boxes.get(o), ...api.pos[o.name] };
        return o === t || a.x + a.w + 40 <= b.x || b.x + b.w + 40 <= a.x || a.y + a.h + 20 <= b.y || b.y + b.h + 20 <= a.y;
      });
      for (let moves = 1 + pick(4); moves > 0; moves--) {
        const t = r.nodes[pick(r.nodes.length)], far = trial % 2 ? 150 : 600, was = api.pos[t.name];
        for (let tries = 0; tries < 50; tries++) {
          api.pos[t.name] = { x: was.x + (pick(2 * far / 10 + 1) - far / 10) * 10, y: was.y + (pick(2 * far / 10 + 1) - far / 10) * 10 };
          if (apart(t)) break;
          api.pos[t.name] = was;
        }
      }
      const q = settle(r), m = metrics(q);
      assert.equal(m.overlaps + m.hits, 0, `${name}, drag ${trial}: a line through a table`);
      for (const e of q.edges) assert(!/NaN|Infinity/.test(e.d), `${name}, drag ${trial}: invalid SVG`);
    }
    const r = run(text);
    for (const t of r.nodes) api.pos[t.name] = { x: api.pos[t.name].x + pick(5) * 10 - 20, y: api.pos[t.name].y };
    assert.equal(reroute(r).searched, 0, `${name}: tables nudged sideways are no columns any more`);
  }
}
// Every table moved: more arrows to search for than one call may (its work is counted, not
// timed). The same boxes get the same routes every time, all of them drawable; and call after
// call, each given what the last kept, they become the routes a search without a limit finds.
{
  let seed = 11;
  const pick = n => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
  const points = q => q.edges.map(e => e.points);
  for (const name of ['shop', 'star50', 'islands120', 'star300']) {
    const r = run(corpus.find(s => s.name === name).text), work = api.ROUTE.WORK;
    for (const t of r.nodes) api.pos[t.name] = { x: api.pos[t.name].x + (pick(21) - 10) * 10, y: api.pos[t.name].y + (pick(21) - 10) * 10 };
    const once = reroute(r), settled = settle(r);
    assert(once.searched > 0);
    for (const e of once.edges) assert(!/NaN|Infinity/.test(e.d) && e.points.every((p, i) => !i || p[0] === e.points[i - 1][0] || p[1] === e.points[i - 1][1]), `${name}: a route that cannot be drawn`);
    assert.deepEqual(points(reroute(r)), points(once), `${name}: the same boxes, other routes`);
    api.ROUTE.WORK = Infinity;
    assert.deepEqual(points(settled), points(reroute(r)), `${name}: after ${settled.calls} calls, not the routes of a search without a limit`);
    api.ROUTE.WORK = work;
  }
  // A big one arranged by hand, no table on another: hundreds of arrows to search for, so most
  // wait at first, but no line runs through a table, after the first call or the last
  {
    const r = run(corpus.find(s => s.name === 'random300x3').text);
    for (const [name, x, y] of moved(spots(r))) api.pos[name] = { x, y };
    const once = reroute(r), settled = settle(r);
    assert(once.waiting > 100 && settled.calls > 3);
    for (const q of [once, settled]) assert.equal(metrics(q).overlaps + metrics(q).hits, 0, 'random300x3 moved: a line through a table');
  }
  // the golden file's moved diagram at a tenth of the work: more calls, the same routes
  const r = run(corpus.find(s => s.name === 'shop').text), work = api.ROUTE.WORK;
  for (const [name, x, y] of moved(spots(r))) api.pos[name] = { x, y };
  const whole = points(settle(r));
  api.ROUTE.WORK = work / 10;
  const slow = settle(r);
  api.ROUTE.WORK = work;
  assert(slow.calls > 1);
  assert.deepEqual(points(slow), whole, 'shop_moved: other routes when the work is split over more calls');
}
// While a table is dragged, the arrows of the others keep the routes they were given, even
// with the dragged table on them; when it is dropped they are searched for again
{
  const boxes = { A: box(0, 0), out: box(200, 0), B: box(500, 120), held: box(900, 0, 40, 60) }; // `out` is too close to A for a column of its own
  const arrow = () => [{ a: boxes.out, b: boxes.B, sy: 59, ty: 179, row: 179, fromTable: 'out', from: 'out.0', to: 'B.0' }];
  const first = arrow(), dragged = arrow(), dropped = arrow(), before = api.routeEdges(first, Object.values(boxes));
  assert.equal(before.searched, 1);
  Object.assign(boxes.held, { x: first[0].points[2][0] - 20, y: 90 });
  const during = api.routeEdges(dragged, Object.values(boxes), new Set([boxes.held]), before.kept);
  assert.deepEqual(dragged[0].points, first[0].points, 'an arrow of tables that were not dragged was searched for again');
  api.routeEdges(dropped, Object.values(boxes), null, during.kept);
  validate({ boxes: new Map(Object.entries(boxes)), edges: dropped }, 'after a drop');
}
console.log(`Layout checks passed (${checks} layouts).`);
