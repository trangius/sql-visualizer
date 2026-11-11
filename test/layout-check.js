'use strict';

// Run: node test/layout-check.js
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const api = require('./layout-load')();
const rental = fs.readFileSync(path.join(__dirname, 'fixtures/rental.txt'), 'utf8');
const four = `A
  Id
  CId -> C
  DId -> D
B
  Id
  CId -> C
  DId -> D
C
  Id
D
  Id`;
let checks = 0;
function model(src) {
  const m = api.parseText(src);
  m.problems.push(...api.resolve(m.tables));
  assert.equal(m.problems.filter(p => p.level === 'error').length, 0, JSON.stringify(m.problems));
  api.markShown(m.tables);
  return m.tables;
}
function run(src, { width = 1400, height = 1000, zoom = 1, notation = 'arrows', keysOnly = false } = {}) {
  Object.assign(api.canvas, { width, height }); api.view.s = zoom;
  Object.assign(api.state, { notation, keysOnly });
  for (const name of Object.keys(api.pos)) delete api.pos[name];
  const nodes = model(src), dims = new Map(nodes.map(t => [t, api.measureTable(t)]));
  api.arrangeAll(nodes, dims);
  const boxes = new Map(nodes.map(t => [t, { ...api.pos[t.name], ...dims.get(t) }]));
  const edges = api.diagramEdges(nodes, boxes);
  api.routeEdges(edges, [...boxes.values()]);
  validate(boxes, edges);
  checks++;
  return { nodes, dims, boxes, edges, quality: api.routeQuality(edges, [...boxes.values()]) };
}
function validate(boxes, edges) {
  const rects = [...boxes.values()];
  for (const a of rects) {
    assert([a.x, a.y, a.w, a.h].every(Number.isFinite));
    for (const b of rects) if (a !== b) {
      assert(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'overlapping tables');
    }
  }
  for (const e of edges) {
    assert(e.points.length >= 2);
    assert.deepEqual(e.points[0], [e.x1, e.sy], 'route leaves the wrong port');
    assert.deepEqual(e.points[e.points.length - 1], [e.x2, e.ty], 'route enters the wrong port');
    assert(!/NaN|Infinity/.test(e.d), `invalid SVG: ${e.from}`);
    for (let i = 1; i < e.points.length; i++) {
      const [x, y] = e.points[i - 1], [xx, yy] = e.points[i];
      assert(x === xx || y === yy, 'non-orthogonal route');
      for (const r of rects) {
        const hits = y === yy
          ? y > r.y && y < r.y + r.h && Math.max(x, xx) > r.x && Math.min(x, xx) < r.x + r.w
          : x > r.x && x < r.x + r.w && Math.max(y, yy) > r.y && Math.min(y, yy) < r.y + r.h;
        assert(!hits, `${e.from} passes through a table`);
      }
    }
  }
}
const snapshot = r => Object.fromEntries([...r.boxes].sort(([a], [b]) => a.name.localeCompare(b.name)).map(([t, r]) => [t.name, [r.x, r.y]]));
const permute = src => src.trim().split(/\n(?=\S)/).reverse().join('\n');

// The exact column arrangement that used to strand Price 250 pixels below TitleCopy.
{
  const nodes = model(rental), dims = new Map(nodes.map(t => [t, { w: t.name === 'RentalProduct' ? 210 : 190, h: 50 + 30 * t.cols.length }]));
  const cols = [['ProductToSale', 'Rental'], ['SalesProduct', 'TitleCopy', 'Price'], ['Receipt', 'RentalProduct'], ['Category', 'Customer']]
    .map(c => c.map(n => nodes.find(t => t.name === n)));
  const index = new Map(cols.flatMap((col, i) => col.map(t => [t, i])));
  const p = api.placeColumns(cols, t => index.get(t), dims, api.layoutEdges(nodes));
  const price = p.get(nodes.find(t => t.name === 'Price')), copy = p.get(nodes.find(t => t.name === 'TitleCopy'));
  assert(price.y - copy.y - copy.h <= 60, 'Price drifts away from TitleCopy');
  validate(p, []);
}
for (const src of [four, rental]) {
  for (const viewport of [{}, { width: 900, height: 1300 }, { width: 1800, height: 800, zoom: 1.5 }]) {
    const a = run(src, viewport), b = run(permute(src), viewport);
    assert.equal(a.quality[1], 0, 'avoidable crossing');
    assert.equal(a.quality[2], 0, 'unrelated arrows share a line');
    assert.deepEqual(snapshot(a), snapshot(b), 'table declaration order changes layout');
    if (src === rental) {
      const edge = a.edges.find(e => e.from === 'TitleCopy.PriceId');
      const length = edge.points.slice(1).reduce((sum, q, i) => sum + Math.abs(q[0] - edge.points[i][0]) + Math.abs(q[1] - edge.points[i][1]), 0);
      assert(length <= 400, `Price connection unnecessarily long: ${length}`);
    }
  }
}
// Crossings outrank any improvement in canvas fit or total length.
assert(api.compareLayout([0, 0, 0, 100000], [0, 1, 0, 1]) < 0);
// A crossing near a bend must count even when no decorative jump would fit.
assert.equal(api.routeQuality([
  { to: 'A', points: [[0, 0], [10, 0], [10, 10]] },
  { to: 'B', points: [[8, -5], [8, 5]] }
], [])[1], 1);

// Sparse routing lanes must not let a long step skip over an obstacle.
{
  const a = { x: 0, y: 0, w: 190, h: 110 }, b = { x: 600, y: 0, w: 190, h: 110 };
  const obstacle = { x: 280, y: -100, w: 220, h: 300 };
  const edge = { a, b, sy: 59, ty: 59, from: 'A.BId', to: 'B.Id' };
  api.routeEdges([edge], [a, b, obstacle]);
  validate(new Map([['A', a], ['B', b], ['obstacle', obstacle]]), [edge]);
}

for (const [name, src] of Object.entries(api.EXAMPLES)) {
  const r = run(src);
  console.log(`${name}: ${r.nodes.length} tables, ${r.quality[1]} crossings`);
}
for (const src of [
  'A\n  Id\n  ParentId -> A',
  'A\n  Id\n  BId -> B\nB\n  Id\n  AId -> A',
  'A\n  Id\nB\n  Id\nC\n  Id\n  AId -> A',
  'A\n  Id\n  BId -> B\nB\n  Id\n  CId -> C\nC\n  Id\n  DId -> D\nD\n  Id',
  ''
]) run(src);
for (const notation of ['arrows', 'uml', 'ratio', 'crowsfoot']) {
  const a = run(rental, { notation, keysOnly: true });
  const b = run(permute(rental), { notation, keysOnly: true });
  assert.deepEqual(snapshot(a), snapshot(b), `${notation}: table declaration order changes layout`);
}
// Data view has no arrows and still uses its existing tight packing path.
{
  const nodes = model(rental), dims = new Map(nodes.map(t => [t, { w: 210, h: 175 }]));
  for (const name of Object.keys(api.pos)) delete api.pos[name];
  api.state.dataView = true;
  api.arrangeAll(nodes, dims);
  validate(new Map(nodes.map(t => [t, { ...api.pos[t.name], ...dims.get(t) }])), []);
  api.state.dataView = false;
}
console.log(`Layout checks passed (${checks} layouts).`);
