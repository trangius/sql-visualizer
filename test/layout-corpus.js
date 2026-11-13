'use strict';

// The schemas the layout is measured on (Squill's suite has the same ones), as Simple
// syntax: the fixtures and examples, and generated ones. limit: ms for layout and routing;
// crosses: lines may cross in it (in the others none does).
const fs = require('fs'), path = require('path');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name + '.txt'), 'utf8');

// xorshift32: the same numbers in any language
function random(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  return { next, pick: n => Math.floor(next() * n) };
}

// Tables T0000…: row 0 the key, a row per FK in the order they are added, then plain rows
function generate(count, fill) {
  const rows = Array.from({ length: count }, () => ['Id']), name = i => 'T' + String(i).padStart(4, '0');
  fill((from, to) => rows[from].push(`F${rows[from].length} -> ${name(to)}`), (i, n) => { while (n-- > 0) rows[i].push(`C${rows[i].length} int`); });
  return rows.map((r, i) => name(i) + '\n' + r.map(c => '  ' + c).join('\n')).join('\n');
}
const chain = n => generate(n, fk => { for (let i = 1; i < n; i++) fk(i, i - 1); });
const star = n => generate(n + 1, fk => { for (let i = 1; i <= n; i++) fk(i, 0); });
const lookups = n => generate(n + 1, fk => { for (let i = 1; i <= n; i++) fk(0, i); });
const junctions = n => generate(n + 2, fk => { for (let i = 0; i < n; i++) { fk(2 + i, 0); fk(2 + i, 1); } });
const ring = n => generate(n, fk => { for (let i = 0; i < n; i++) fk(i, (i + 1) % n); });
// every table of a level has `children` tables that reference it, breadth first
function tree(depth, children) {
  const pairs = [];
  let level = [0], n = 1;
  for (let d = 0; d < depth; d++) level = level.flatMap(parent => Array.from({ length: children }, () => { pairs.push([n, parent]); return n++; }));
  return generate(n, fk => pairs.forEach(([child, parent]) => fk(child, parent)));
}
// table i references min(fks, i) different earlier tables
function scattered(n, fks, seed) {
  const r = random(seed);
  return generate(n, fk => {
    for (let i = 1; i < n; i++) {
      const seen = new Set();
      for (let k = 0; k < Math.min(fks, i); k++) {
        let to;
        do to = r.pick(i); while (seen.has(to));
        seen.add(to);
        fk(i, to);
      }
    }
  });
}
// groups of 1 to 6 tables, each table referencing an earlier one of its group
function islands(groups, seed) {
  const r = random(seed), pairs = [];
  let n = 0;
  for (let g = 0; g < groups; g++) {
    const size = 1 + r.pick(6), base = n;
    n += size;
    for (let i = 1; i < size; i++) pairs.push([base + i, base + r.pick(i)]);
  }
  return generate(n, fk => pairs.forEach(([from, to]) => fk(from, to)));
}
// a tree with some second references, and tables of very different heights
function heights(n, seed) {
  const r = random(seed);
  return generate(n, (fk, extra) => {
    for (let i = 1; i < n; i++) {
      const first = r.pick(i);
      fk(i, first);
      if (r.next() < 0.4 && i > 2) {
        const second = r.pick(i);
        if (second !== first) fk(i, second);
      }
      extra(i, r.next() < 0.2 ? 25 + r.pick(20) : r.pick(5));
    }
  });
}

// A schema nobody designed, for seed 1, 2, 3…: names of very different widths, self
// references, references to tables declared later and to unique columns, tall tables
function scrambled(seed) {
  const r = random(seed * 2654435761), n = 2 + r.pick(seed % 7 === 0 ? 60 : 18), names = [], tables = [];
  for (let i = 0; i < n; i++) names.push('T' + i + 'x'.repeat(r.pick(4) === 0 ? r.pick(30) : r.pick(4)));
  for (let i = 0; i < n; i++) {
    const rows = ['Id', 'Code unique'], fks = r.pick(4) === 0 ? 0 : 1 + r.pick(seed % 5 === 0 ? 6 : 3);
    for (let k = 0; k < fks; k++) {
      const mode = r.pick(10), to = mode === 0 ? i : mode < 3 ? r.pick(n) : r.pick(Math.max(1, i));
      rows.push(`F${k} ${r.pick(5) === 0 ? 'null ' : ''}-> ${names[to]}${r.pick(6) === 0 ? '.Code' : ''}`);
    }
    for (let k = r.pick(8) === 0 ? 10 + r.pick(40) : r.pick(5); k > 0; k--) rows.push(`C${k} int`);
    tables.push(names[i] + '\n' + rows.map(c => '  ' + c).join('\n'));
  }
  return tables.join('\n');
}
// Names that sort differently by UTF-8 bytes (the order the layout uses) than by UTF-16
// units: ﬁ and Ｗ are in the BMP above the surrogates, 𝔸 and 𠀀 are beyond it
const names = ['𠀀han', 'Ｗide', 'Zeta', '𝔸stral', 'ﬁsh', 'éclair'].map(name => `${name}\n  Id\n  HubId -> Hub`).join('\n') + '\nHub\n  Id';

module.exports = examples => [
  { name: 'rental', text: fixture('rental'), limit: 5 },
  { name: 'four', text: 'A\n  Id\n  CId -> C\n  DId -> D\nB\n  Id\n  CId -> C\n  DId -> D\nC\n  Id\nD\n  Id', limit: 20 },
  { name: 'school', text: examples.school, limit: 20 },
  { name: 'store', text: examples.store, limit: 20 },
  { name: 'shop', text: fixture('shop'), limit: 20, crosses: true },
  { name: 'selfref', text: 'A\n  Id\n  ParentId -> A', limit: 20 },
  { name: 'ownrow', text: 'A\n  Id -> A', limit: 20 }, // a column that references itself: an arrow of no length
  { name: 'mutual', text: 'A\n  Id\n  BId -> B\nB\n  Id\n  AId -> A', limit: 20 },
  { name: 'loose', text: 'A\n  Id\nB\n  Id\nC\n  Id\n  AId -> A', limit: 20 },
  { name: 'names', text: names, limit: 20 },
  { name: 'chain12', text: chain(12), limit: 20 },
  { name: 'tree3x3', text: tree(3, 3), limit: 20 },
  { name: 'tree4x3', text: tree(4, 3), limit: 20 },
  { name: 'star50', text: star(50), limit: 20 },
  { name: 'star300', text: star(300), limit: 100 },
  { name: 'star1500', text: star(1500), limit: 1000 },
  { name: 'lookups12', text: lookups(12), limit: 20 },
  { name: 'junctions2', text: junctions(2), limit: 20 },
  { name: 'junctions3', text: junctions(3), limit: 20, crosses: true },
  { name: 'ring6', text: ring(6), limit: 20 },
  { name: 'random20x2', text: scattered(20, 2, 7), limit: 20, crosses: true },
  { name: 'heights40', text: heights(40, 3), limit: 20, crosses: true },
  { name: 'islands120', text: islands(120, 5), limit: 100 },
  { name: 'random300x3', text: scattered(300, 3, 7), limit: 100, crosses: true },
  { name: 'random150x12', text: scattered(150, 12, 7), limit: 500, crosses: true },
  { name: 'random1500x3', text: scattered(1500, 3, 7), limit: 1000, crosses: true },
];
module.exports.scrambled = scrambled;
// A diagram arranged by hand, whose arrows have to be searched for: the spots Auto layout
// gave ([name, x, y] from the top-left, in name order) three times as far apart, and every
// table then moved by a random -150…150 (in tens) in x, then in y
module.exports.moved = spots => {
  const r = random(9);
  return spots.map(([name, x, y]) => [name, 3 * x + (r.pick(31) - 15) * 10, 3 * y + (r.pick(31) - 15) * 10]);
};
