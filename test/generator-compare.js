'use strict';

// Compares sql_visualizer's SQL generator (genSQL, js/dialects.js) with Squill's, which is jaidb's
// generate_schema_sql, for MariaDB, MySQL, PostgreSQL, SQL Server and SQLite. Every schema the
// tests know (js/examples.js, the CASES of test/sql-check.js, test/fixtures/*.txt) is read here,
// written again in jaidb's Simple text with only what both models have (tables, columns, types,
// primary keys, NULL, one-column UNIQUE, foreign keys and their actions, the numbered Id), and
// given to test/jaidb-sql.jai. sql_visualizer's script is made from the same model without what
// jaidb has not (defaults, indexes, UNIQUE over several columns, the enum CHECK, the DROP preamble
// and the FOREIGN_KEY_CHECKS/PRAGMA lines). The two are compared statement by statement, and the
// differences are printed by category, with the notes each gives on a type written as another (jaidb's unmade).
// Exits 1 when anything differs.
//
// Run: node test/generator-compare.js [-v] [part of a schema's name]
//   -v           every difference, not just the first of each kind
//   JAI          the compiler (default: jai on the PATH)
//   JAI_IMPORTS  the folder that holds jaidb (default: ~/repos)
// The Jai tool is built in a temp folder each run (about a second); nothing is written in the repo.

const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), { spawnSync } = require('child_process');

const args = process.argv.slice(2), verbose = args.includes('-v'), only = args.find(a => a !== '-v');
const ENGINES = { mariadb: 'MARIADB', mysql: 'MYSQL', postgres: 'POSTGRES', mssql: 'MSSQL', sqlite: 'SQLITE' };

// ─── The schemas ─────────────────────────────────────────────────────────────

const ctx = require('./load')();
const run = s => vm.runInContext(s, ctx);
// sql-check.js runs its checks when loaded, so its CASES are read from its text
function sqlCheckCases() {
  const src = fs.readFileSync(path.join(__dirname, 'sql-check.js'), 'utf8');
  const start = src.indexOf('const CASES = {'), end = src.indexOf('\n};\n', start);
  if (start < 0 || end < 0) throw new Error('CASES not found in test/sql-check.js');
  return vm.runInNewContext('(' + src.slice(start + 'const CASES = '.length, end + 2) + ')');
}
const fixtures = Object.fromEntries(fs.readdirSync(path.join(__dirname, 'fixtures')).filter(f => /\.txt$/.test(f) && !/golden/.test(f))
  .map(f => ['fixture ' + f.replace(/\.txt$/, ''), [fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8')]]));
const SCHEMAS = Object.entries({ ...Object.fromEntries(Object.entries(run('EXAMPLES')).map(([k, v]) => [k, [v]])), ...sqlCheckCases(), ...fixtures })
  .filter(([k]) => !only || k.includes(only));

// The model of a schema, resolved; its errors for one database
const parse = run(`(src, from) => {
  const sql = /^\\s*(CREATE|PRAGMA|SET)\\b/i.test(src);
  const r = sql ? parseSQL(src, from) : parseText(src);
  r.problems.push(...resolve(r.tables));
  return r;
}`);
const dialectProblems = run('dialectProblems'), genSQL = run('genSQL'), refText = run('refText'), isIdName = run('isIdName');

// ─── sql_visualizer's model → jaidb's Simple text ────────────────────────────

// The model as jaidb's text, and what of it that text can't say (counted in `skipped`)
function jaidbText(tables, skip) {
  const out = [];
  for (const t of tables) {
    out.push(t.name);
    const composite = t.pkCols.length > 1;
    for (const c of t.cols) {
      const parts = [c.name];
      if (c.type) parts.push(c.type);
      if (c.isPk && !composite) parts.push('pk');
      if (c.nullable) parts.push('null');
      if (c.unique) parts.push('unique');
      if (c.ref && c.target) {
        parts.push('-> ' + refText(c));
        if (c.onDelete) parts.push('on delete ' + c.onDelete);
        if (c.onUpdate) parts.push('on update ' + c.onUpdate);
      }
      if (c.default != null) skip('default');
      if (c.indexed) skip('index on one column');
      if (c.autoInc && !isIdName(c.name)) skip('auto_increment on a column not named Id');
      if (/^(enum|set)\(/.test(c.effType ?? '')) skip('enum/set CHECK (the type itself is kept)');
      out.push('  ' + parts.join(' '));
    }
    if (composite) out.push(`  pk (${t.pkCols.map(c => c.name).join(', ')})`);
    for (const u of t.multiUniques) out.push(`  unique (${u.cols.map(c => c.name).join(', ')})`);
    if (t.multiIndexes.length) skip('index over several columns', t.multiIndexes.length);
    out.push('');
  }
  return out.join('\n');
}

// What jaidb has not, taken out of the model before sql_visualizer writes it
function stripModel(tables) {
  for (const t of tables) {
    t.indexes = []; t.multiIndexes = [];
    for (const c of t.cols) { c.default = null; c.indexed = false; }
  }
}

// ─── The jaidb tool ──────────────────────────────────────────────────────────

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlviz-jaidb-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
function buildTool() {
  fs.copyFileSync(path.join(__dirname, 'jaidb-sql.jai'), path.join(work, 'jaidb-sql.jai')); // its .build goes next to it
  const imports = process.env.JAI_IMPORTS ?? path.join(os.homedir(), 'repos');
  const r = spawnSync(process.env.JAI ?? 'jai', ['jaidb-sql.jai', '-import_dir', imports, '-output_path', work, '-quiet'], { cwd: work, encoding: 'utf8' });
  const exe = path.join(work, 'jaidb-sql');
  if (r.error || r.status || !fs.existsSync(exe)) {
    console.log('Building test/jaidb-sql.jai failed:\n' + (r.error?.message ?? '') + (r.stdout ?? '') + (r.stderr ?? ''));
    process.exit(2);
  }
  return exe;
}
const tool = buildTool();
function jaidb(text) {
  const file = path.join(work, 'schema.txt');
  fs.writeFileSync(file, text);
  const r = spawnSync(tool, [file], { encoding: 'utf8' });
  if (r.status) throw new Error('jaidb-sql failed: ' + r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

// ─── SQL → statements → a comparable model ──────────────────────────────────

const ws = s => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
const statements = sql => sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
  .split(/;[ \t]*(?:\n|$)/).map(ws).filter(Boolean);

// Splits at the commas outside parentheses and quotes
function splitTop(s) {
  const out = []; let depth = 0, q = null, cur = '';
  for (const ch of s) {
    if (q) { if (ch === q) q = null; }
    else if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if (ch === '[') q = ']';
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const NAME = '(?:`[^`]*`|"[^"]*"|\\[[^\\]]*\\]|[\\p{L}_][\\p{L}\\p{N}_$]*)';
const QNAME = `${NAME}(?:\\.${NAME})*`;
const unq = n => n.replace(/^[`"[]|[`"\]]$/g, '');
// "public"."Owner" → { schema: '"public"', name: '"Owner"', bare: 'Owner' }
function qualified(raw) {
  const parts = raw.match(new RegExp(NAME, 'gu'));
  const name = parts.pop();
  return { raw, schema: parts.join('.') || null, name, bare: unq(name) };
}
const cols = list => splitTop(list).map(n => unq(n.trim()));

// A foreign key clause: [CONSTRAINT n] FOREIGN KEY (c) REFERENCES T(c) [ON …] [DEFERRABLE …]
function fkOf(s, where) {
  const m = s.match(new RegExp(`^(?:CONSTRAINT (${NAME}) )?FOREIGN KEY \\((.*?)\\) REFERENCES (${QNAME}) ?\\((.*?)\\)(.*)$`, 'u'));
  if (!m) return null;
  const tail = m[5].trim();
  return { name: m[1] ? unq(m[1]) : null, col: cols(m[2]).join(','), rawCol: m[2], target: qualified(m[3]), targetCol: m[4],
    actions: ws(tail.replace(/DEFERRABLE INITIALLY DEFERRED/, '')), deferrable: /DEFERRABLE/.test(tail), where };
}

const TYPE_END = /\s(?=NOT NULL\b|NULL\b|IDENTITY\b|AUTO_INCREMENT\b|GENERATED\b|PRIMARY KEY\b|UNIQUE\b|CONSTRAINT\b|DEFAULT\b|CHECK\b|REFERENCES\b)/;
// The column definition after its name: type, then what it says, each its own word
function columnOf(item) {
  const m = item.match(new RegExp(`^(${NAME})\\s+(.*)$`, 'u'));
  const rest = m[2].replace(/ CHECK \(.*\)$/, ''); // the enum's CHECK: jaidb has none
  const at = rest.search(TYPE_END), type = at < 0 ? rest : rest.slice(0, at), flags = at < 0 ? '' : rest.slice(at + 1);
  const names = {};
  const plain = flags.replace(new RegExp(`CONSTRAINT (${NAME}) (UNIQUE|PRIMARY KEY)`, 'gu'), (_, n, what) => { names[what] = unq(n); return what; });
  const said = [];
  for (const re of [/NOT NULL/, /(?<!NOT )NULL/, /IDENTITY\(1,1\)/, /AUTO_INCREMENT/, /GENERATED BY DEFAULT AS IDENTITY/, /AUTOINCREMENT/, /PRIMARY KEY/, /UNIQUE/]) {
    const m = plain.match(re);
    if (m) said.push([m.index, m[0]]);
  }
  said.sort((x, y) => x[0] - y[0]);
  return { raw: m[1], bare: unq(m[1]), type: type.trim(), said: said.map(x => x[1]), names };
}

// One script as tables: { order, tables: {bare → table}, extra: [statements not understood] }
function model(sql) {
  const out = { order: [], tables: {}, alters: [], extra: [] };
  for (const s of statements(sql)) {
    let m = s.match(new RegExp(`^CREATE TABLE (${QNAME}) \\((.*)\\)$`, 'u'));
    if (m) {
      const name = qualified(m[1]), t = { name, columns: [], pk: null, fks: {}, uniques: [], other: [] };
      out.order.push(name.bare);
      out.tables[name.bare.toLowerCase()] = t;
      for (const item of splitTop(m[2])) {
        const pk = item.match(new RegExp(`^(?:CONSTRAINT (${NAME}) )?PRIMARY KEY \\((.*)\\)$`, 'u'));
        const fk = fkOf(item, 'in CREATE TABLE');
        if (pk) t.pk = { name: pk[1] ? unq(pk[1]) : null, cols: cols(pk[2]).join(','), where: 'table' };
        else if (fk) t.fks[fk.col.toLowerCase()] = fk;
        else if (/^(CONSTRAINT \S+ )?UNIQUE \(/.test(item)) t.uniques.push(item);
        else if (/^INDEX /.test(item)) continue; // MariaDB's index for a key to a column without one: jaidb has none
        else t.columns.push(columnOf(item));
      }
      const inline = t.columns.find(c => c.said.includes('PRIMARY KEY'));
      if (inline && !t.pk) t.pk = { name: inline.names['PRIMARY KEY'] ?? null, cols: inline.bare, where: 'column' };
      continue;
    }
    m = s.match(new RegExp(`^ALTER TABLE (${QNAME}) ADD (.*)$`, 'u'));
    if (m && fkOf(m[2], 'ALTER TABLE')) { out.alters.push({ table: qualified(m[1]), fk: fkOf(m[2], 'ALTER TABLE') }); continue; }
    // SQL Server's unique index on a column that may be null
    m = s.match(new RegExp(`^CREATE UNIQUE INDEX (${NAME}) ON (${QNAME}) \\((${NAME})\\) WHERE .* IS NOT NULL$`, 'u'));
    if (m) { out.alters.push({ table: qualified(m[2]), filtered: { name: unq(m[1]), col: unq(m[3]) } }); continue; }
    out.extra.push(s);
  }
  for (const a of out.alters) {
    const t = out.tables[a.table.bare.toLowerCase()];
    if (!t) { out.extra.push(a.fk ? 'ALTER TABLE ' + a.table.raw : 'CREATE UNIQUE INDEX'); continue; }
    if (a.fk) t.fks[a.fk.col.toLowerCase()] = a.fk;
    else { const c = t.columns.find(c => c.bare.toLowerCase() === a.filtered.col.toLowerCase()); if (c) c.filtered = a.filtered.name; }
  }
  return out;
}

// What sql_visualizer writes that jaidb has no part in
const PREAMBLE = /^(DROP TABLE|SET FOREIGN_KEY_CHECKS|PRAGMA|IF OBJECT_ID\(.*DROP CONSTRAINT)|^CREATE INDEX /;
const svScript = sql => statements(sql).filter(s => !PREAMBLE.test(s)).map(s => s.replace(/, INDEX \S+ \([^)]*\)/g, '').replace(/ CHECK \(\S+ IN \((?:'(?:[^']|'')*'|[ ,])*\)\)/g, '')).join(';\n') + ';\n';

// ─── The comparison ──────────────────────────────────────────────────────────

// A constraint name with its table and column as {t} and {c}, so names of a kind group together
function pattern(n, t, c) {
  if (n == null) return 'unnamed';
  for (const [end, as] of [[`_${t}_${c}`, '_{t}_{c}'], [`_${t}`, '_{t}']]) if (n.endsWith(end)) return n.slice(0, -end.length) + as;
  return n;
}
function quoteKind(a, b) {
  const q = s => /^[`"[]/.test(s) ? s[0] === '[' ? '[x]' : `${s[0]}x${s[0]}` : 'bare';
  return `sv ${q(a)}, jaidb ${q(b)}`;
}

// The differences between the two scripts: [{ category, kind, detail }]
function compare(sv, jb) {
  const diffs = [], add = (category, kind, detail) => diffs.push({ category, kind, detail });
  const a = model(sv), b = model(jb);
  const svNames = a.order.map(n => n.toLowerCase()), jbNames = b.order.map(n => n.toLowerCase());
  for (const n of svNames) if (!b.tables[n]) add('other', 'table only in sv', n);
  for (const n of jbNames) if (!a.tables[n]) add('other', 'table only in jaidb', n);
  if (svNames.join() !== jbNames.join()) add('ordering', 'tables in another order', `sv ${a.order.join(', ')} | jaidb ${b.order.join(', ')}`);
  const names = (what, x, y) => {
    if (x.schema !== y.schema) add('schema prefix', `${what}: sv ${x.schema ?? 'none'}, jaidb ${y.schema ?? 'none'}`, `${x.raw} vs ${y.raw}`);
    if (x.name !== y.name) {
      if (x.bare === y.bare) add('quoting', `${what}: ${quoteKind(x.name, y.name)}`, `${x.name} vs ${y.name}`);
      else add('other', `${what} spelled otherwise`, `${x.name} vs ${y.name}`);
    }
  };
  for (const key of svNames.filter(n => b.tables[n])) {
    const s = a.tables[key], j = b.tables[key], tn = s.name.bare;
    names('table name', s.name, j.name);
    const sc = s.columns.map(c => c.bare), jc = j.columns.map(c => c.bare);
    if (sc.join() !== jc.join()) {
      const missing = sc.filter(c => !jc.includes(c)), extra = jc.filter(c => !sc.includes(c));
      if (missing.length || extra.length) add('other', 'columns missing in one', `${tn}: only sv ${missing.join(',') || '-'}, only jaidb ${extra.join(',') || '-'}`);
      else add('ordering', 'columns in another order', `${tn}: sv ${sc.join(',')} | jaidb ${jc.join(',')}`);
    }
    for (const c of s.columns) {
      const d = j.columns.find(x => x.bare === c.bare);
      if (!d) continue;
      const where = `${tn}.${c.bare}`;
      if (c.raw !== d.raw) add('quoting', `column name: ${quoteKind(c.raw, d.raw)}`, `${c.raw} vs ${d.raw}`);
      if (c.type.toUpperCase() !== d.type.toUpperCase()) add('types', `${c.type} vs ${d.type}`.replace(/\(\d+(,\d+)?\)/g, m => /,/.test(m) ? '(p,s)' : '(n)').replace(/\(n\) vs (\w+)\(n\)/, '(n) vs $1(n)'), `${where} ${c.type} vs ${d.type}`);
      const said = (x, re) => x.said.filter(w => re.test(w)).join(' ') || '-';
      const numbered = [...c.said, ...d.said].some(w => /IDENTITY|AUTO_?INCREMENT/.test(w)) || /^INTEGER PRIMARY KEY/.test(c.type + ' ' + c.said.join(' '));
      const groups = [['numbering', /IDENTITY|AUTO_?INCREMENT/], [numbered ? 'null on the numbered column' : 'null', /NULL/], ['primary key in the column', /PRIMARY KEY/]];
      for (const [what, re] of groups) {
        const x = said(c, re), y = said(d, re);
        if (x !== y) add(/^numbering|numbered/.test(what) ? 'numbering' : 'other', `${what}: sv ${x}, jaidb ${y}`, where);
      }
      const order = x => x.said.filter(w => d.said.includes(w) && c.said.includes(w)).join(' ');
      if (order(c) !== order(d)) add('ordering', `column clauses: sv ${order(c)}, jaidb ${order(d)}`, where);
      const u = x => x.said.includes('UNIQUE') ? 'UNIQUE' : x.filtered ? 'filtered unique index' : '-';
      if (u(c) !== u(d)) add('other', `unique: sv ${u(c)}, jaidb ${u(d)}`, where);
      const un = x => x.filtered ?? x.names.UNIQUE ?? null, as = x => pattern(un(x), tn, c.bare) + (x.filtered ? ' (an index)' : '');
      if (u(c) !== '-' && u(d) !== '-' && un(c) !== un(d)) add('constraint names', `unique: sv ${as(c)}, jaidb ${as(d)}`, where);
    }
    if (!!s.pk !== !!j.pk) add('other', `primary key only in ${s.pk ? 'sv' : 'jaidb'}`, tn);
    else if (s.pk) {
      if (s.pk.cols !== j.pk.cols) add('other', 'primary key of other columns', `${tn}: ${s.pk.cols} vs ${j.pk.cols}`);
      if (s.pk.where !== j.pk.where) add('other', `primary key: sv in the ${s.pk.where}, jaidb in the ${j.pk.where}`, tn);
      if (s.pk.name !== j.pk.name) add('constraint names', `primary key: sv ${pattern(s.pk.name, tn)}, jaidb ${pattern(j.pk.name, tn)}`, tn);
    }
    for (const col of new Set([...Object.keys(s.fks), ...Object.keys(j.fks)])) {
      const x = s.fks[col], y = j.fks[col], where = `${tn}.${unq((x ?? y).rawCol)}`;
      if (!x || !y) { add('other', `foreign key only in ${x ? 'sv' : 'jaidb'}`, where); continue; }
      if (x.where !== y.where) add('FK placement', `sv ${x.where}, jaidb ${y.where}`, where);
      if (x.deferrable !== y.deferrable) add('FK placement', `DEFERRABLE INITIALLY DEFERRED only in ${x.deferrable ? 'sv' : 'jaidb'}`, where);
      if (x.name !== y.name) add('constraint names', `foreign key (${x.where === y.where ? x.where : 'any'}): sv ${pattern(x.name, tn, unq(x.rawCol))}, jaidb ${pattern(y.name, tn, unq(y.rawCol))}`, where);
      if (x.rawCol !== y.rawCol) add('quoting', `column name: ${quoteKind(x.rawCol, y.rawCol)}`, `${x.rawCol} vs ${y.rawCol}`);
      names('referenced table', x.target, y.target);
      if (x.targetCol !== y.targetCol) {
        if (unq(x.targetCol) === unq(y.targetCol)) add('quoting', `column name: ${quoteKind(x.targetCol, y.targetCol)}`, `${x.targetCol} vs ${y.targetCol}`);
        else add('other', 'referenced column differs', `${where}: ${x.targetCol} vs ${y.targetCol}`);
      }
      if (x.actions !== y.actions) add('other', `actions: sv "${x.actions}", jaidb "${y.actions}"`, where);
    }
    if (s.uniques.join() !== j.uniques.join()) add('other', 'table UNIQUE differs', `${tn}: ${s.uniques.join('; ')} vs ${j.uniques.join('; ')}`);
  }
  for (const x of a.extra.filter(x => !b.extra.includes(x))) add('other', 'statement only in sv', x.slice(0, 120));
  for (const x of b.extra.filter(x => !a.extra.includes(x))) add('other', 'statement only in jaidb', x.slice(0, 120));
  if (!diffs.length && statements(sv).join('\n') !== statements(jb).join('\n')) add('other', 'unclassified', 'the scripts differ in a way not told apart above');
  return diffs;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const skipped = new Map(); // feature → { count, schemas }
const refused = []; // [schema, engine, who, why]
const results = Object.fromEntries(Object.keys(ENGINES).map(d => [d, { compared: 0, matched: [], differ: [] }]));
const all = []; // { schema, engine, category, kind, detail }
const unmadeNotes = [];
for (const [name, [src, expects, from = 'mariadb']] of SCHEMAS) {
  const r = parse(src, from);
  if (r.problems.some(p => p.level === 'error')) {
    refused.push([name, 'all', 'sv', r.problems.find(p => p.level === 'error').msg]);
    continue;
  }
  const skip = (f, n = 1) => { const e = skipped.get(f) ?? { count: 0, schemas: new Set() }; e.count += n; e.schemas.add(name); skipped.set(f, e); };
  const text = jaidbText(r.tables, skip);
  const problemsBy = Object.fromEntries(Object.keys(ENGINES).map(d => [d, dialectProblems(r.tables, d).filter(p => p.level === 'error')]));
  // the notes on types written as others, the engine's name aside (jaidb's MS SQL Server is SQL Server here)
  const typeNotes = (list, engineName) => list.filter(m => / has no .* type: /.test(m)).map(m => m.replace(engineName + ' ', '')).sort();
  const svNotes = Object.fromEntries(Object.keys(ENGINES).map(d => [d, typeNotes(dialectProblems(r.tables, d).map(p => p.msg), run(`DIALECTS.${d}.name`))]));
  stripModel(r.tables);
  const jb = jaidb(text);
  for (const [d, E] of Object.entries(ENGINES)) {
    if (problemsBy[d].length) { refused.push([name, d, 'sv', problemsBy[d][0].msg]); continue; }
    const errors = jb[E].problems.filter(p => !p.warning);
    if (errors.length) { refused.push([name, d, 'jaidb', errors[0].message]); continue; }
    for (const u of jb[E].unmade) unmadeNotes.push(`${name} (${d}): ${u}`);
    const diffs = compare(svScript(genSQL(r.tables, d)), jb[E].sql), jbNotes = typeNotes(jb[E].unmade, jb[E].name);
    for (const m of svNotes[d].filter(m => !jbNotes.includes(m))) diffs.push({ category: 'notes', kind: 'type note only in sv', detail: m });
    for (const m of jbNotes.filter(m => !svNotes[d].includes(m))) diffs.push({ category: 'notes', kind: 'type note only in jaidb', detail: m });
    results[d].compared++;
    (diffs.length ? results[d].differ : results[d].matched).push(name);
    for (const x of diffs) all.push({ schema: name, engine: d, ...x });
  }
}

const say = console.log;
say(`${SCHEMAS.length} schemas (js/examples.js, test/sql-check.js CASES, test/fixtures)\n`);
say('Per engine: schemas that match');
for (const [d, r] of Object.entries(results)) say(`  ${d.padEnd(9)} ${r.matched.length}/${r.compared}` + (r.matched.length ? `  (${r.matched.join(', ')})` : ''));
say('\nNot compared');
const why = new Map(); // schema → [engines, first reason]
for (const [s, d, who, msg] of refused) { const w = why.get(s) ?? [[], `${who} refuses: ${msg}`]; w[0].push(d); why.set(s, w); }
for (const [s, [ds, msg]] of why) say(`  ${s} (${ds.join(', ')}) — ${msg.length > 90 ? msg.slice(0, 90) + '…' : msg}`);
say('\nLeft out of the jaidb text (what its model has not)');
for (const [f, e] of skipped) say(`  ${f}: ${e.count} in ${e.schemas.size} schema${e.schemas.size > 1 ? 's' : ''}`);
if (unmadeNotes.length) { say('\njaidb unmade'); for (const n of unmadeNotes) say('  ' + n); }

const CATEGORIES = ['quoting', 'schema prefix', 'constraint names', 'types', 'FK placement', 'numbering', 'ordering', 'notes', 'other'];
say('\nDifferences by category (count, schema×engine pairs)');
for (const cat of CATEGORIES) {
  const of = all.filter(x => x.category === cat);
  if (!of.length) continue;
  const pairs = new Set(of.map(x => x.schema + '|' + x.engine));
  const engines = [...new Set(of.map(x => x.engine))].join(', ');
  say(`\n${cat}: ${of.length} (${pairs.size} pairs; ${engines})`);
  const kinds = new Map();
  for (const x of of) { const k = kinds.get(x.kind) ?? []; k.push(x); kinds.set(x.kind, k); }
  for (const [kind, xs] of kinds) {
    const es = [...new Set(xs.map(x => x.engine))].join(',');
    say(`  ${String(xs.length).padStart(4)}  [${es}] ${kind}`);
    for (const x of verbose ? xs : xs.slice(0, 1)) say(`          e.g. ${x.schema}: ${x.detail}`);
  }
}
const differ = Object.values(results).some(r => r.differ.length);
say(differ ? '\nThe generators differ.' : '\nThe generators agree on every schema compared.');
process.exitCode = differ ? 1 : 0;
