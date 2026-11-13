'use strict';

// Run: node test/layout-check.js            checks the layout and the routes of every schema in
//                                           layout-corpus.js, their time, and fixtures/layout_golden.txt
//      node test/layout-check.js --write    writes that file after a wanted change
//      node test/layout-check.js --fuzz 2500    more random schemas and drags than the usual few
// The boxes are 190 wide and 50 + 30 a row here, whatever the fonts, so that Squill, which
// runs the same layout, gets the same golden file.
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const api = require('./layout-load')();
const corpus = require('./layout-corpus')(api.EXAMPLES), { scrambled } = require('./layout-corpus');
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
  const edges = api.diagramEdges(nodes, boxes), searched = api.routeEdges(edges, [...boxes.values()]);
  checks++;
  return { nodes, boxes, edges, searched, layoutMs, routeMs: ms(started) };
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

// What holds after Auto layout, of any schema: a valid diagram, drawn without the search, the
// same whatever order the tables are declared in, unchanged by a second Auto layout
function sound(text, options, name) {
  const r = run(text, options), m = validate(r, name);
  assert.equal(r.searched, 0, `${name}: an arrow needed the search`);
  const again = draw(r.nodes, new Map([...r.boxes].map(([t, b]) => [t, { w: b.w, h: b.h }])));
  assert.deepEqual(spots(again), spots(r), `${name}: a second Auto layout moves tables`);
  assert.deepEqual(spots(run(backwards(text), options)), spots(r), `${name}: the order the tables are declared in changes the layout`);
  return { r, m };
}

// Every schema of the corpus: sound at three canvas shapes, in time, and as the golden file says
const golden = [];
console.log('schema         tables lines crossings bends/line  mean longest       size  layout   route ms');
for (const { name, text, limit, crosses } of corpus) {
  for (const aspect of [0.8, 2.25, 1.5]) {
    const { r, m } = sound(text, { aspect }, name);
    if (!crosses) assert.equal(m.crossings, 0, `${name}: lines cross`);
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
if (process.argv.includes('--write')) fs.writeFileSync(GOLDEN, golden.join('\n') + '\n');
else assert.equal(golden.join('\n') + '\n', fs.readFileSync(GOLDEN, 'utf8'), 'the layout changed: compare with test/fixtures/layout_golden.txt, then --write');

// The real box sizes, every notation (some spread the arrow ends), keys only
for (const notation of ['arrows', 'uml', 'ratio', 'crowsfoot']) {
  for (const keysOnly of [false, true]) {
    for (const name of ['rental', 'shop', 'store']) sound(corpus.find(s => s.name === name).text, { notation, keysOnly, measured: true }, `${name} as ${notation}`);
  }
}
// Random schemas, as the boxes of the tests and as the page measures them
for (let seed = 1; seed <= FUZZ; seed++) {
  for (const options of [{}, { measured: true }, { measured: true, notation: 'crowsfoot' }, { measured: true, keysOnly: true, aspect: 0.8 }, { aspect: 2.25, notation: 'uml' }]) {
    sound(scrambled(seed), options, `random schema ${seed} ${JSON.stringify(options)}`);
  }
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
    a: boxes[from], b: boxes[to], sy: boxes[from].y + 59 + 30 * fromRow, ty: boxes[to].y + 59 + 30 * toRow, row: boxes[to].y + 59 + 30 * toRow, from: `${from}.${fromRow}`, to: `${to}.${toRow}`,
  }));
  const r = { boxes: new Map(Object.entries(boxes)), edges, searched: api.routeEdges(edges, Object.values(boxes)) };
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
  assert.equal(api.routeEdges(edges, [...boxes.values()]), 0, 'a new table stands out of line');
  validate({ boxes, edges }, 'a new table');
}

// Tables dragged about, never nearer than 40 to each other: every arrow still finds a way that
// touches no table. And tables all nudged a little are still columns: no search.
{
  let seed = 12345;
  const pick = n => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
  const rerouted = r => {
    const boxes = new Map(r.nodes.map(t => [t, { ...api.pos[t.name], w: r.boxes.get(t).w, h: r.boxes.get(t).h }])), edges = api.diagramEdges(r.nodes, boxes);
    return { boxes, edges, searched: api.routeEdges(edges, [...boxes.values()]) };
  };
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
      const q = rerouted(r), m = metrics(q);
      assert.equal(m.overlaps + m.hits, 0, `${name}, drag ${trial}: a line through a table`);
      for (const e of q.edges) assert(!/NaN|Infinity/.test(e.d), `${name}, drag ${trial}: invalid SVG`);
    }
    const r = run(text);
    for (const t of r.nodes) api.pos[t.name] = { x: api.pos[t.name].x + pick(5) * 10 - 20, y: api.pos[t.name].y };
    assert.equal(rerouted(r).searched, 0, `${name}: tables nudged sideways are no columns any more`);
  }
}
// Every table moved: more arrows to search for than one call may (its work is counted, not
// timed). The same boxes still get the same routes every time, all of them drawable.
{
  let seed = 11;
  const pick = n => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
  for (const name of ['shop', 'star50', 'islands120', 'star300']) {
    const r = run(corpus.find(s => s.name === name).text), routes = [];
    for (const t of r.nodes) api.pos[t.name] = { x: api.pos[t.name].x + (pick(21) - 10) * 10, y: api.pos[t.name].y + (pick(21) - 10) * 10 };
    for (let again = 0; again < 2; again++) {
      const boxes = new Map(r.nodes.map(t => [t, { ...api.pos[t.name], w: BOX_W, h: boxH(t) }])), edges = api.diagramEdges(r.nodes, boxes);
      assert(api.routeEdges(edges, [...boxes.values()]) > 0);
      for (const e of edges) assert(!/NaN|Infinity/.test(e.d) && e.points.every((p, i) => !i || p[0] === e.points[i - 1][0] || p[1] === e.points[i - 1][1]), `${name}: a route that cannot be drawn`);
      routes.push(edges.map(e => e.points));
    }
    assert.deepEqual(routes[1], routes[0], `${name}: the same boxes, other routes`);
  }
}
// While a table is dragged, the arrows of the others keep the routes they were given, even
// with the dragged table on them; when it is dropped they are searched for again
{
  const boxes = { A: box(0, 0), out: box(200, 0), B: box(500, 120), held: box(900, 0, 40, 60) }; // `out` is too close to A for a column of its own
  const arrow = () => [{ a: boxes.out, b: boxes.B, sy: 59, ty: 179, row: 179, from: 'out.0', to: 'B.0' }];
  const first = arrow(), dragged = arrow(), dropped = arrow();
  assert.equal(api.routeEdges(first, Object.values(boxes)), 1);
  Object.assign(boxes.held, { x: first[0].points[2][0] - 20, y: 90 });
  api.routeEdges(dragged, Object.values(boxes), new Set([boxes.held]));
  assert.deepEqual(dragged[0].points, first[0].points, 'an arrow of tables that were not dragged was searched for again');
  api.routeEdges(dropped, Object.values(boxes));
  validate({ boxes: new Map(Object.entries(boxes)), edges: dropped }, 'after a drop');
}
console.log(`Layout checks passed (${checks} layouts).`);
